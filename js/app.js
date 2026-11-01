/* MDreader application shell: files, outline, modes, themes, export. */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const MD = window.MD;

  // Desktop (Tauri) build: native dialogs, file access and menus.
  const TAURI = window.__TAURI__ || null;
  const isMac = /Mac/.test(navigator.platform || navigator.userAgent);
  if (TAURI) document.documentElement.classList.add('desktop');
  if (TAURI && isMac) document.documentElement.classList.add('desktop-mac');
  const invoke = TAURI ? TAURI.core.invoke : null;

  const CDN = {
    katexJs: 'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.js',
    katexCss: 'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.css',
    hljs: 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js',
  };
  // The desktop build bundles these libraries (see scripts/build-web.js).
  const LOCAL = {
    katexJs: 'vendor/katex/katex.min.js',
    katexCss: 'vendor/katex/katex.min.css',
    hljs: 'vendor/highlight.min.js',
  };

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('mdreader.' + key);
        return v === null ? fallback : JSON.parse(v);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem('mdreader.' + key, JSON.stringify(value));
      } catch (e) {
        /* storage unavailable: ignore */
      }
    },
  };

  const state = {
    name: 'Untitled.md',
    handle: null, // FileSystemFileHandle when available
    path: null, // absolute path in the desktop build
    dirStack: null, // [rootDirHandle, ..., parentDirOfFile] for resolving images
    rootDir: null,
    dirty: false,
    savedText: '',
    sourceMode: false,
  };

  // ------------------------------------------------------- external libs

  const scripts = {};
  function loadScript(url) {
    if (!scripts[url]) {
      scripts[url] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        s.async = true;
        s.onload = resolve;
        s.onerror = () => {
          s.remove();
          reject(new Error('Could not load ' + url));
        };
        document.head.appendChild(s);
      });
    }
    return scripts[url];
  }
  function loadCss(url) {
    if (document.querySelector('link[href="' + url + '"]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = url;
    document.head.appendChild(l);
  }

  // Resolves with the URL that loaded: bundled copy first in the desktop app.
  function loadLib(key) {
    const cdn = () => loadScript(CDN[key]).then(() => 'cdn');
    if (!TAURI) return cdn();
    return loadScript(LOCAL[key]).then(() => 'local', cdn);
  }
  function ensureKatex() {
    if (window.katex) return Promise.resolve(window.katex);
    return loadLib('katexJs').then((from) => {
      loadCss(from === 'local' ? LOCAL.katexCss : CDN.katexCss);
      return window.katex;
    });
  }
  function ensureHljs() {
    if (window.hljs) return Promise.resolve(window.hljs);
    return loadLib('hljs').then(() => window.hljs);
  }

  // Typeset math, highlight code and resolve local images inside an element.
  function enhance(el) {
    const maths = el.querySelectorAll('.math-inline, .math-block');
    if (maths.length) {
      ensureKatex()
        .then((katex) => {
          maths.forEach((m) => {
            try {
              katex.render(m.dataset.tex, m, {
                displayMode: m.classList.contains('math-block'),
                throwOnError: false,
                strict: 'ignore',
              });
              m.classList.remove('unrendered');
            } catch (e) {
              m.classList.add('unrendered');
            }
          });
        })
        .catch(() => maths.forEach((m) => m.classList.add('unrendered')));
    }
    const codes = el.querySelectorAll('pre code[class*="language-"]');
    if (codes.length) {
      ensureHljs()
        .then((hljs) =>
          codes.forEach((c) => {
            const lang = (c.className.match(/language-(\S+)/) || [])[1];
            if (lang && hljs.getLanguage(lang)) hljs.highlightElement(c);
          })
        )
        .catch(() => {});
    }
    el.querySelectorAll('img').forEach(resolveImage);
  }

  const assetCache = new Map();
  function joinPath(base, rel) {
    const out = [];
    (base + '/' + rel).split('/').forEach((p, k) => {
      if (p === '..') out.pop();
      else if (p !== '.' && (p !== '' || k === 0)) out.push(p);
    });
    return out.join('/');
  }

  async function resolveImage(img) {
    const src = img.getAttribute('src') || '';
    if (TAURI) {
      if (/^[a-z]+:/i.test(src) || src.startsWith('#')) return;
      if (!src.startsWith('/') && !state.path) return;
      const file = src.startsWith('/') ? decodeURIComponent(src) : joinPath(dirname(state.path), decodeURIComponent(src.split(/[?#]/)[0]));
      if (assetCache.has(file)) {
        img.src = assetCache.get(file);
        return;
      }
      try {
        const url = await invoke('read_data_url', { path: file });
        assetCache.set(file, url);
        img.src = url;
      } catch (e) {
        img.title = 'Image not found: ' + file;
      }
      return;
    }
    if (!state.dirStack || /^([a-z]+:|\/|#)/i.test(src)) return;
    if (assetCache.has(src)) {
      img.src = assetCache.get(src);
      return;
    }
    try {
      const stack = state.dirStack.slice();
      const parts = decodeURIComponent(src.split(/[?#]/)[0]).split('/');
      const fileName = parts.pop();
      for (const p of parts) {
        if (p === '' || p === '.') continue;
        if (p === '..') {
          if (stack.length > 1) stack.pop();
          continue;
        }
        stack.push(await stack[stack.length - 1].getDirectoryHandle(p));
      }
      const fh = await stack[stack.length - 1].getFileHandle(fileName);
      const url = URL.createObjectURL(await fh.getFile());
      assetCache.set(src, url);
      img.src = url;
    } catch (e) {
      img.title = 'Image not found: ' + src;
    }
  }

  // ----------------------------------------------------------- editor

  const docEl = $('#doc');
  const sourceEl = $('#source');
  const scroller = $('#scroller');

  const editor = new window.BlockEditor(docEl, {
    enhance: (el) => {
      enhance(el);
      if (el.dataset && changedBlocks.has(+el.dataset.id)) el.classList.add('changed');
    },
    onChange: () => {
      updateDirty();
      scheduleOutline();
      scheduleDraft();
      scheduleBibCheck();
    },
    onInput: () => {
      updateDirty();
      scheduleDraft();
      typewriterScroll();
    },
    onFocusBlock: () => {
      document.body.classList.remove('editing-none');
      typewriterScroll();
    },
    openLink: (href) => {
      if (TAURI && /^(https?|mailto):/i.test(href)) TAURI.opener.openUrl(href);
      else window.open(href, '_blank', 'noopener');
    },
  });

  docEl.addEventListener('focusout', () => {
    setTimeout(() => {
      if (!editor.active) document.body.classList.add('editing-none');
    }, 0);
  });

  function currentText() {
    return state.sourceMode ? sourceEl.value : editor.getMarkdown();
  }

  function basename(p) {
    return String(p).split(/[\\/]/).pop();
  }
  function dirname(p) {
    return String(p).replace(/[\\/][^\\/]*$/, '');
  }

  function setTitle() {
    $('#doc-name').textContent = state.name;
    $('#doc-name').title = state.path || '';
    const t = state.name.replace(/\.(md|markdown|txt)$/i, '') + ' — MDreader';
    document.title = t;
    if (TAURI) TAURI.window.getCurrentWindow().setTitle(state.name).catch(() => {});
  }

  function loadText(text, name, handle, dirStack, filePath) {
    if (state.sourceMode) toggleSource(false);
    state.name = name || 'Untitled.md';
    state.handle = handle || null;
    state.dirStack = dirStack || null;
    state.path = filePath || null;
    assetCache.forEach((url) => url.startsWith('blob:') && URL.revokeObjectURL(url));
    assetCache.clear();
    editor.setMarkdown(text);
    state.savedText = editor.getMarkdown();
    updateDirty();
    scroller.scrollTop = 0;
    setTitle();
    store.set('draft', { name: state.name, text: state.savedText, saved: true, path: state.path });
    highlightCurrentFile();
    buildOutline();
    updateStats();
    changedBlocks.clear();
    updateChangedBadge();
    hideBanner();
    resetWatch();
    refreshBibliography();
  }

  function updateDirty() {
    state.dirty = currentText() !== state.savedText;
    $('#dirty').hidden = !state.dirty;
  }

  let draftTimer = null;
  function scheduleDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      store.set('draft', { name: state.name, text: currentText(), saved: !state.dirty, path: state.path });
      updateStats();
    }, 400);
  }

  // ------------------------------------------------------------ files

  const hasFS = 'showOpenFilePicker' in window;
  const MD_TYPES = [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.mkd', '.txt'] } }];

  async function confirmDiscard() {
    if (!state.dirty) return true;
    const msg = 'You have unsaved changes in "' + state.name + '". Discard them?';
    if (TAURI) return TAURI.dialog.ask(msg, { title: 'Unsaved changes', kind: 'warning', okLabel: 'Discard', cancelLabel: 'Cancel' });
    return window.confirm(msg);
  }

  const MD_EXTS = ['md', 'markdown', 'mdown', 'mkd', 'txt'];

  async function openPath(p) {
    try {
      const text = await invoke('read_text', { path: p });
      loadText(text, basename(p), null, null, p);
      state.currentPath = p;
      highlightCurrentFile();
      flash('Opened ' + basename(p));
    } catch (e) {
      flash('Could not open ' + basename(p) + ': ' + e);
    }
  }

  async function cmdNew() {
    if (!(await confirmDiscard())) return;
    loadText('', 'Untitled.md');
    editor.focusBlock(editor.blocks[0].id);
  }

  async function cmdOpen() {
    if (!(await confirmDiscard())) return;
    if (TAURI) {
      const p = await TAURI.dialog.open({ multiple: false, directory: false, filters: [{ name: 'Markdown', extensions: MD_EXTS }] });
      if (p) await openPath(p);
      return;
    }
    if (hasFS) {
      try {
        const [h] = await window.showOpenFilePicker({ types: MD_TYPES });
        const f = await h.getFile();
        loadText(await f.text(), f.name, h);
        flash('Opened ' + f.name);
      } catch (e) {
        if (e.name !== 'AbortError') flash('Could not open file: ' + e.message);
      }
    } else {
      $('#file-input').click();
    }
  }

  $('#file-input').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) {
      loadText(await f.text(), f.name);
      flash('Opened ' + f.name);
    }
    e.target.value = '';
  });

  // Saving changes the file's timestamp; pause the watcher so our own write
  // is not mistaken for an outside change.
  async function cmdSave() {
    watch.saving++;
    try {
      await doSave();
    } finally {
      watch.saving--;
      resetWatch();
    }
  }

  async function cmdSaveAs() {
    watch.saving++;
    try {
      await doSaveAs();
    } finally {
      watch.saving--;
      resetWatch();
      refreshBibliography();
    }
  }

  async function doSave() {
    if (state.sourceMode) syncFromSource();
    editor.commit();
    const text = currentText();
    if (TAURI && state.path) {
      try {
        await invoke('write_text', { path: state.path, contents: text });
        markSaved(text);
        flash('Saved ' + state.name);
      } catch (e) {
        flash('Save failed: ' + e);
      }
      return;
    }
    if (state.handle && state.handle.createWritable) {
      try {
        const w = await state.handle.createWritable();
        await w.write(text);
        await w.close();
        markSaved(text);
        flash('Saved ' + state.name);
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
        flash('Save failed: ' + e.message);
        return;
      }
    }
    return doSaveAs();
  }

  async function doSaveAs() {
    if (state.sourceMode) syncFromSource();
    editor.commit();
    const text = currentText();
    if (TAURI) {
      const p = await saveDialog(state.path || state.name, 'Markdown', MD_EXTS);
      if (!p) return;
      try {
        await invoke('write_text', { path: p, contents: text });
        state.path = p;
        state.handle = null;
        state.name = basename(p);
        setTitle();
        markSaved(text);
        flash('Saved ' + state.name);
      } catch (e) {
        flash('Save failed: ' + e);
      }
      return;
    }
    if ('showSaveFilePicker' in window) {
      try {
        const h = await window.showSaveFilePicker({ suggestedName: state.name, types: MD_TYPES });
        const w = await h.createWritable();
        await w.write(text);
        await w.close();
        state.handle = h;
        state.name = h.name;
        setTitle();
        markSaved(text);
        flash('Saved ' + state.name);
      } catch (e) {
        if (e.name !== 'AbortError') flash('Save failed: ' + e.message);
      }
      return;
    }
    await download(state.name, text, 'text/markdown');
    markSaved(text);
    flash('Downloaded ' + state.name);
  }

  function markSaved(text) {
    state.savedText = text;
    hideBanner();
    updateDirty();
    store.set('draft', { name: state.name, text, saved: true, path: state.path });
  }

  function saveDialog(defaultPath, label, exts) {
    return TAURI.dialog.save({ defaultPath, filters: [{ name: label, extensions: exts }] });
  }

  async function download(name, content, type) {
    if (TAURI) {
      const ext = name.split('.').pop();
      const base = state.path ? dirname(state.path) + '/' + name : name;
      const p = await saveDialog(base, ext.toUpperCase(), [ext]);
      if (!p) return false;
      await invoke('write_text', { path: p, contents: content });
      return true;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: type + ';charset=utf-8' }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  async function cmdOpenFolder() {
    if (TAURI) {
      const dir = await TAURI.dialog.open({ directory: true, multiple: false });
      if (!dir) return;
      showTab('files');
      const toNode = (e) =>
        e.children
          ? { name: e.name, isDir: true, children: e.children.map(toNode) }
          : { name: e.name, key: e.path, open: () => openPath(e.path) };
      const entries = await invoke('list_markdown', { dir });
      renderTree({ name: basename(dir), children: entries.map(toNode) });
      return;
    }
    if (!('showDirectoryPicker' in window)) {
      $('#folder-hint').textContent = 'Opening folders needs Chrome, Edge or another Chromium-based browser. You can still open single files.';
      showTab('files');
      return;
    }
    try {
      const dir = await window.showDirectoryPicker();
      state.rootDir = dir;
      showTab('files');
      $('#file-tree').innerHTML = '<li class="dir"><span>Loading…</span></li>';
      const tree = await readTree(dir, 0);
      tree.name = dir.name;
      renderTree(tree);
    } catch (e) {
      if (e.name !== 'AbortError') flash('Could not open folder: ' + e.message);
    }
  }

  // Web build: walk a FileSystemDirectoryHandle into a tree of
  // { name, isDir, children } / { name, key, open } nodes.
  async function readTree(dir, depth, stack) {
    stack = stack || [dir];
    const node = { name: dir.name, isDir: true, children: [] };
    if (depth > 4) return node;
    for await (const [name, h] of dir.entries()) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      if (h.kind === 'directory') {
        const child = await readTree(h, depth + 1, stack.concat(h));
        if (child.children.length) node.children.push(child);
      } else if (/\.(md|markdown|mdown|mkd|txt)$/i.test(name)) {
        const key = stack.map((d) => d.name).concat(name).join('/');
        node.children.push({
          name,
          key,
          open: async () => {
            const f = await h.getFile();
            loadText(await f.text(), f.name, h, stack);
            state.currentPath = key;
            highlightCurrentFile();
          },
        });
      }
    }
    node.children.sort((a, b) => !!b.isDir - !!a.isDir || a.name.localeCompare(b.name, undefined, { numeric: true }));
    return node;
  }

  function renderTree(root) {
    const ul = $('#file-tree');
    ul.innerHTML = '';
    $('#files .empty-note').hidden = true;
    const build = (node, parentUl) => {
      node.children.forEach((c) => {
        const li = document.createElement('li');
        const span = document.createElement('span');
        span.textContent = c.name;
        li.appendChild(span);
        parentUl.appendChild(li);
        if (c.isDir) {
          li.className = 'dir';
          const sub = document.createElement('ul');
          li.appendChild(sub);
          span.addEventListener('click', () => (sub.hidden = !sub.hidden));
          build(c, sub);
        } else {
          li.className = 'file';
          li.dataset.path = c.key;
          span.title = c.key;
          span.addEventListener('click', async () => {
            if (!(await confirmDiscard())) return;
            await c.open();
            if (window.matchMedia('(max-width: 760px)').matches) document.body.classList.remove('sidebar-open');
          });
        }
      });
    };
    const head = document.createElement('li');
    head.className = 'dir';
    head.innerHTML = '<span></span>';
    head.firstChild.textContent = root.name;
    ul.appendChild(head);
    build(root, ul);
    if (!root.children.length) {
      const li = document.createElement('li');
      li.innerHTML = '<span>No markdown files here.</span>';
      ul.appendChild(li);
    }
  }

  function highlightCurrentFile() {
    const open = state.path || (state.dirStack ? state.currentPath : null);
    $$('#file-tree li.file').forEach((li) => li.classList.toggle('current', !!open && li.dataset.path === open));
  }

  // PWA file handling: opening .md files from the OS into the installed app.
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      if (!params.files || !params.files.length) return;
      const h = params.files[0];
      const f = await h.getFile();
      loadText(await f.text(), f.name, h);
    });
  }

  // Drag and drop
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
    dragDepth++;
    $('#drop-overlay').hidden = false;
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('#drop-overlay').hidden = true;
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('#drop-overlay').hidden = true;
    const item = e.dataTransfer.items && e.dataTransfer.items[0];
    let handle = null;
    if (item && item.getAsFileSystemHandle) {
      try {
        handle = await item.getAsFileSystemHandle();
      } catch (err) {
        handle = null;
      }
    }
    const f = e.dataTransfer.files[0];
    if (!f) return;
    if (!/\.(md|markdown|mdown|mkd|txt)$/i.test(f.name) && !/^text\//.test(f.type)) {
      flash('Not a markdown file: ' + f.name);
      return;
    }
    if (!(await confirmDiscard())) return;
    loadText(await f.text(), f.name, handle && handle.kind === 'file' ? handle : null);
    flash('Opened ' + f.name);
  });

  if (TAURI) {
    const listen = TAURI.event.listen;
    listen('tauri://drag-enter', () => ($('#drop-overlay').hidden = false));
    listen('tauri://drag-leave', () => ($('#drop-overlay').hidden = true));
    listen('tauri://drag-drop', async (e) => {
      $('#drop-overlay').hidden = true;
      const p = ((e.payload && e.payload.paths) || []).find((x) => /\.(md|markdown|mdown|mkd|txt)$/i.test(x));
      if (!p) return flash('Not a markdown file');
      if (await confirmDiscard()) openPath(p);
    });
    listen('menu', (e) => runCommand(e.payload, 'menu'));
    const takeOpened = async () => {
      const files = await invoke('take_opened_files');
      if (files.length && (await confirmDiscard())) openPath(files[files.length - 1]);
    };
    listen('files-opened', takeOpened);
    setTimeout(takeOpened, 0);
    TAURI.window.getCurrentWindow().onCloseRequested(async (e) => {
      if (state.dirty && !(await confirmDiscard())) e.preventDefault();
    });
  }

  window.addEventListener('beforeunload', (e) => {
    if (state.dirty && !TAURI) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ---------------------------------------------------------- outline

  let outlineTimer = null;
  function scheduleOutline() {
    clearTimeout(outlineTimer);
    outlineTimer = setTimeout(buildOutline, 150);
  }

  function buildOutline() {
    const nav = $('#outline');
    nav.innerHTML = '';
    const heads = [];
    editor.blocks.forEach((b) => {
      const h = MD.headingOf(b.src);
      if (h && h.text.trim()) heads.push({ id: b.id, level: h.level, text: h.text });
    });
    if (!heads.length) {
      nav.innerHTML = '<div class="empty-note">Headings will appear here.</div>';
      return;
    }
    const min = Math.min.apply(null, heads.map((h) => h.level));
    heads.forEach((h) => {
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = h.text;
      a.className = 'l' + (h.level - min + 1);
      a.dataset.id = h.id;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        if (state.sourceMode) toggleSource(false);
        const el = editor.blockElement(h.id);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (window.matchMedia('(max-width: 760px)').matches) document.body.classList.remove('sidebar-open');
      });
      nav.appendChild(a);
    });
    markActiveHeading();
  }

  function markActiveHeading() {
    const links = $$('#outline a');
    if (!links.length) return;
    const top = scroller.getBoundingClientRect().top + 90;
    let current = links[0];
    for (const a of links) {
      const el = editor.blockElement(a.dataset.id);
      if (el && el.getBoundingClientRect().top <= top) current = a;
    }
    links.forEach((a) => a.classList.toggle('active', a === current));
  }
  let scrollRaf = 0;
  scroller.addEventListener('scroll', () => {
    cancelAnimationFrame(scrollRaf);
    scrollRaf = requestAnimationFrame(markActiveHeading);
  });

  // ------------------------------------------------------ live reload

  // Watch the open file and reload it when another program (an AI agent,
  // an R script, git) changes it, keeping your place in the document.
  const watch = { on: store.get('watch', true), sig: null, busy: false, saving: 0, pending: null };
  const changedBlocks = new Set();

  function canWatch() {
    return !!((TAURI && state.path) || (state.handle && state.handle.getFile));
  }

  async function fileSignature() {
    if (TAURI && state.path) {
      const st = await invoke('file_stat', { path: state.path });
      return st.modified + ':' + st.size;
    }
    const f = await state.handle.getFile();
    return f.lastModified + ':' + f.size;
  }

  async function readOpenFile() {
    if (TAURI && state.path) return invoke('read_text', { path: state.path });
    return (await state.handle.getFile()).text();
  }

  function resetWatch() {
    watch.sig = null;
    updateWatchBadge();
    if (!canWatch()) return;
    fileSignature()
      .then((sig) => (watch.sig = sig))
      .catch(() => {});
  }

  // Normalise text the way the editor writes it, so a file that is merely
  // re-saved by another program does not count as changed.
  function normalize(text) {
    const md = MD.splitBlocks(text)
      .map((b) => b.replace(/\s+$/, ''))
      .filter(Boolean)
      .join('\n\n');
    return md ? md + '\n' : '';
  }

  async function pollFile() {
    if (!watch.on || watch.busy || watch.saving || !canWatch()) return;
    watch.busy = true;
    try {
      const sig = await fileSignature();
      if (watch.sig === null) watch.sig = sig;
      else if (sig !== watch.sig) {
        watch.sig = sig;
        onExternalChange(await readOpenFile());
      }
    } catch (e) {
      /* file moved or deleted, or permission lost: try again later */
    } finally {
      watch.busy = false;
    }
  }

  function onExternalChange(text) {
    if (normalize(text) === state.savedText) return; // nothing new (e.g. our own save)
    if (state.dirty) {
      watch.pending = text;
      showBanner('“' + state.name + '” was changed by another program.');
      return;
    }
    applyDiskVersion(text);
  }

  function applyDiskVersion(text) {
    hideBanner();
    if (editor.active) editor.commit();
    const changed = editor.reload(text);
    if (state.sourceMode) {
      sourceEl.value = editor.getMarkdown();
      autosizeSource();
    }
    state.savedText = editor.getMarkdown();
    updateDirty();
    changedBlocks.clear();
    changed.forEach((id) => changedBlocks.add(id));
    changed.forEach((id) => {
      const el = editor.blockElement(id);
      if (el) el.classList.add('changed', 'just-changed');
    });
    setTimeout(() => $$('.block.just-changed').forEach((el) => el.classList.remove('just-changed')), 2500);
    updateChangedBadge();
    store.set('draft', { name: state.name, text: state.savedText, saved: true, path: state.path });
    buildOutline();
    updateStats();
    flash('Reloaded ' + state.name + (changed.length ? ' · ' + changed.length + ' changed block' + (changed.length > 1 ? 's' : '') : ''));
  }

  function showBanner(msg) {
    $('#banner-msg').textContent = msg;
    $('#banner').hidden = false;
  }
  function hideBanner() {
    watch.pending = null;
    $('#banner').hidden = true;
  }
  $('#banner-reload').addEventListener('click', () => {
    if (watch.pending !== null) applyDiskVersion(watch.pending);
  });
  $('#banner-keep').addEventListener('click', () => {
    hideBanner();
    flash('Keeping your version. Saving will overwrite the file on disk.');
  });

  function updateWatchBadge() {
    const b = $('#st-watch');
    b.hidden = !canWatch();
    b.classList.toggle('off', !watch.on);
    b.textContent = watch.on ? 'Live' : 'Live off';
    b.title = watch.on
      ? 'Reloading automatically when the file changes on disk. Click to turn off.'
      : 'Not watching the file for outside changes. Click to turn on.';
  }

  function toggleWatch() {
    watch.on = !watch.on;
    store.set('watch', watch.on);
    updateWatchBadge();
    flash(watch.on ? 'Reloading when the file changes on disk' : 'No longer watching the file for changes');
    if (watch.on) resetWatch();
  }
  $('#st-watch').addEventListener('click', toggleWatch);

  // Changed-block markers: click the badge to step through them.
  function updateChangedBadge() {
    const b = $('#st-changed');
    // drop ids of blocks that no longer exist
    changedBlocks.forEach((id) => {
      if (!editor.blocks.some((x) => x.id === id)) changedBlocks.delete(id);
    });
    b.hidden = !changedBlocks.size;
    b.textContent = changedBlocks.size + ' changed';
  }
  let changedCursor = -1;
  $('#st-changed').addEventListener('click', (e) => {
    if (e.target.closest('.clear')) return;
    const ids = editor.blocks.filter((x) => changedBlocks.has(x.id)).map((x) => x.id);
    if (!ids.length) return;
    changedCursor = (changedCursor + 1) % ids.length;
    const el = editor.blockElement(ids[changedCursor]);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('just-changed');
      setTimeout(() => el.classList.remove('just-changed'), 1500);
    }
  });
  $('#st-changed-clear').addEventListener('click', () => {
    changedBlocks.clear();
    $$('.block.changed').forEach((el) => el.classList.remove('changed'));
    updateChangedBadge();
  });

  setInterval(pollFile, 1000);
  window.addEventListener('focus', pollFile);

  // ----------------------------------------------------- bibliography

  // Where references come from, in order of preference:
  //   1. `bibliography:` in the document's YAML front matter (pandoc style)
  //   2. a .bib file loaded with File → Load bibliography
  //   3. any .bib file next to the document
  const bib = {
    lib: null,
    sources: [], // [{ label, read(), sig() }]
    sigs: [],
    key: '',
    manual: null, // { label, read, sig } chosen by the user this session
  };

  async function handleFromStack(stack, rel) {
    const st = stack.slice();
    const parts = rel.split('/');
    const name = parts.pop();
    for (const p of parts) {
      if (!p || p === '.') continue;
      if (p === '..') {
        if (st.length > 1) st.pop();
        continue;
      }
      st.push(await st[st.length - 1].getDirectoryHandle(p));
    }
    return st[st.length - 1].getFileHandle(name);
  }

  function pathSource(p) {
    return {
      label: basename(p),
      path: p,
      read: () => invoke('read_text', { path: p }),
      sig: () => invoke('file_stat', { path: p }).then((st) => st.modified + ':' + st.size),
    };
  }
  function handleSource(h) {
    return {
      label: h.name,
      read: () => h.getFile().then((f) => f.text()),
      sig: () => h.getFile().then((f) => f.lastModified + ':' + f.size),
    };
  }

  async function findBibSources() {
    const declared = MD.frontMatterBibliography(currentText());
    const out = [];
    for (const rel of declared) {
      try {
        if (TAURI) {
          if (rel.startsWith('/')) out.push(pathSource(rel));
          else if (state.path) out.push(pathSource(joinPath(dirname(state.path), rel)));
        } else if (state.dirStack) {
          out.push(handleSource(await handleFromStack(state.dirStack, rel)));
        }
      } catch (e) {
        flash('Bibliography not found: ' + rel);
      }
    }
    if (out.length) return out;
    if (bib.manual) return [bib.manual];
    if (TAURI) {
      const remembered = store.get('bibPath', null);
      if (remembered) return [pathSource(remembered)];
      if (state.path) return (await invoke('list_files', { dir: dirname(state.path), ext: 'bib' })).map(pathSource);
    } else {
      const saved = store.get('bibText', null);
      if (saved && saved.text) return [{ label: saved.label, read: async () => saved.text, sig: async () => 'stored' }];
      if (state.dirStack) {
        const dir = state.dirStack[state.dirStack.length - 1];
        const found = [];
        for await (const [name, h] of dir.entries()) {
          if (h.kind === 'file' && /\.bib$/i.test(name)) found.push(handleSource(h));
        }
        return found;
      }
    }
    return [];
  }

  let bibSeq = 0;
  async function refreshBibliography() {
    const seq = ++bibSeq;
    let sources = [];
    try {
      sources = await findBibSources();
    } catch (e) {
      sources = [];
    }
    if (seq !== bibSeq) return;
    if (!sources.length) {
      bib.sources = [];
      bib.sigs = [];
      setLibrary(null);
      return;
    }
    try {
      const sigs = await Promise.all(sources.map((src) => src.sig().catch(() => '')));
      const texts = await Promise.all(sources.map((src) => src.read()));
      if (seq !== bibSeq) return;
      bib.sources = sources;
      bib.sigs = sigs;
      const lib = window.Bib.merge(texts.map((t, k) => window.Bib.fromText(t, sources[k].label)));
      setLibrary(lib);
    } catch (e) {
      flash('Could not read bibliography: ' + (e.message || e));
      setLibrary(null);
    }
  }

  function setLibrary(lib) {
    const before = bib.lib ? bib.lib.keys.length + bib.lib.source : '';
    bib.lib = lib;
    editor.setBibliography(lib);
    if (lib && before !== lib.keys.length + lib.source) {
      flash('Bibliography: ' + lib.source + ' · ' + lib.keys.length + ' entries' + (lib.errors.length ? ' · ' + lib.errors.length + ' unreadable' : ''));
    }
    scheduleBibCheck();
  }

  // Reload the .bib when it changes (Zotero / Better BibTeX auto-export).
  async function pollBib() {
    if (!bib.sources.length || watch.busy) return;
    try {
      const sigs = await Promise.all(bib.sources.map((src) => src.sig().catch(() => '')));
      if (sigs.join('|') !== bib.sigs.join('|')) refreshBibliography();
    } catch (e) {
      /* ignore */
    }
  }
  setInterval(pollBib, 2000);

  // Re-resolve sources when the front matter's bibliography line changes.
  let lastDeclared = '';
  let bibTimer = null;
  function scheduleBibCheck() {
    clearTimeout(bibTimer);
    bibTimer = setTimeout(() => {
      const declared = MD.frontMatterBibliography(currentText()).join('|');
      if (declared !== lastDeclared) {
        lastDeclared = declared;
        refreshBibliography();
        return;
      }
      updateCitationStatus();
      buildReferences();
    }, 250);
  }

  async function cmdLoadBib() {
    try {
      if (TAURI) {
        const p = await TAURI.dialog.open({ multiple: false, filters: [{ name: 'BibTeX', extensions: ['bib', 'bibtex'] }] });
        if (!p) return;
        store.set('bibPath', p);
        bib.manual = pathSource(p);
      } else if (hasFS) {
        const [h] = await window.showOpenFilePicker({ types: [{ description: 'BibTeX', accept: { 'text/plain': ['.bib', '.bibtex'] } }] });
        bib.manual = handleSource(h);
        rememberBibText(h.name, await (await h.getFile()).text());
      } else {
        const text = await pickTextFile('.bib,.bibtex');
        if (!text) return;
        bib.manual = { label: text.name, read: async () => text.text, sig: async () => 'picked' };
        rememberBibText(text.name, text.text);
      }
      lastDeclared = MD.frontMatterBibliography(currentText()).join('|');
      if (lastDeclared) flash('This document names its own bibliography in its front matter; using that one.');
      refreshBibliography();
    } catch (e) {
      if (e.name !== 'AbortError') flash('Could not load bibliography: ' + (e.message || e));
    }
  }

  function rememberBibText(label, text) {
    if (text.length > 3e6) return; // too big for browser storage; reload it next time
    store.set('bibText', { label, text });
  }

  function pickTextFile(accept) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.onchange = async () => {
        const f = input.files[0];
        resolve(f ? { name: f.name, text: await f.text() } : null);
      };
      input.click();
    });
  }

  // ---- status: missing citations
  let missingCursor = -1;
  function updateCitationStatus() {
    const b = $('#st-bib');
    if (!bib.lib) {
      b.hidden = true;
      return;
    }
    const missing = new Set();
    $$('#doc .cite.missing').forEach((c) => (c.dataset.missing || '').split(',').forEach((k) => k && missing.add(k)));
    b.hidden = false;
    b.classList.toggle('warn', missing.size > 0);
    b.textContent = missing.size
      ? missing.size + ' unknown citation' + (missing.size > 1 ? 's' : '')
      : bib.lib.source + ' · ' + bib.lib.keys.length;
    b.title = missing.size
      ? 'Not in ' + bib.lib.source + ': ' + Array.from(missing).join(', ') + '. These may not exist. Click to step through them.'
      : 'Bibliography: ' + bib.lib.source + ' (' + bib.lib.keys.length + ' entries). Click to load a different one.';
  }
  $('#st-bib').addEventListener('click', () => {
    const items = $$('#doc .cite.missing');
    if (!items.length) {
      cmdLoadBib();
      return;
    }
    missingCursor = (missingCursor + 1) % items.length;
    const el = items[missingCursor];
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('pulse');
    setTimeout(() => el.classList.remove('pulse'), 1200);
  });

  // ---- references list at the end of the document
  function citedKeys(nodes) {
    const keys = [];
    nodes.forEach((c) =>
      (c.dataset.keys || '').split(',').forEach((k) => {
        if (k && bib.lib && bib.lib.entries[k] && !keys.includes(k)) keys.push(k);
      })
    );
    return keys;
  }

  function referencesHtml(nodes) {
    if (!bib.lib) return '';
    const keys = window.Bib.sortKeys(citedKeys(nodes), bib.lib);
    if (!keys.length) return '';
    return (
      '<section class="refs" id="refs"><h2>References</h2><ol>' +
      keys.map((k) => '<li id="ref-' + MD.escapeHtml(k) + '">' + window.Bib.formatReference(bib.lib.entries[k]) + '</li>').join('') +
      '</ol></section>'
    );
  }

  function buildReferences() {
    const el = $('#refs-live');
    el.innerHTML = referencesHtml($$('#doc .cite'));
    el.hidden = !el.innerHTML || state.sourceMode;
  }

  // ---- hover card with the full reference
  const pop = $('#cite-pop');
  let popTimer = null;
  function showPop(target) {
    clearTimeout(popTimer);
    const keys = (target.dataset.keys || '').split(',').filter(Boolean);
    if (!keys.length || !bib.lib) return;
    pop.innerHTML = keys
      .map((k) =>
        bib.lib.entries[k]
          ? '<div class="pop-ref">' + window.Bib.formatReference(bib.lib.entries[k]) + '</div>'
          : '<div class="pop-ref missing"><strong>@' + MD.escapeHtml(k) + '</strong> is not in ' + MD.escapeHtml(bib.lib.source) +
            '. Check that this source exists before relying on it.</div>'
      )
      .join('');
    pop.hidden = false;
    const r = target.getBoundingClientRect();
    const w = Math.min(420, window.innerWidth - 24);
    pop.style.width = w + 'px';
    pop.style.left = Math.max(12, Math.min(r.left, window.innerWidth - w - 12)) + 'px';
    const below = r.bottom + 8;
    pop.style.top = (below + pop.offsetHeight > window.innerHeight - 12 ? r.top - pop.offsetHeight - 8 : below) + 'px';
  }
  function hidePopSoon() {
    clearTimeout(popTimer);
    popTimer = setTimeout(() => (pop.hidden = true), 250);
  }
  document.addEventListener('mouseover', (e) => {
    const c = e.target.closest && e.target.closest('.cite.resolved, #doc .cite');
    if (c && bib.lib) showPop(c);
    else if (e.target.closest && e.target.closest('#cite-pop')) clearTimeout(popTimer);
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target.closest && (e.target.closest('.cite') || e.target.closest('#cite-pop'))) hidePopSoon();
  });
  pop.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    editor.opts.openLink(a.getAttribute('href'));
  });

  // ------------------------------------------------------------ stats

  function updateStats() {
    const text = MD.plainText(currentText());
    const words = (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
    const minutes = Math.max(1, Math.round(words / 230));
    $('#st-words').textContent = words.toLocaleString() + ' words · ' + minutes + ' min read';
  }

  let flashTimer = null;
  function flash(msg) {
    $('#st-msg').textContent = msg;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => ($('#st-msg').textContent = ''), 3500);
  }

  // ------------------------------------------------------------ modes

  function syncFromSource() {
    editor.setMarkdown(sourceEl.value, true);
  }

  function autosizeSource() {
    sourceEl.style.height = 'auto';
    sourceEl.style.height = sourceEl.scrollHeight + 'px';
  }

  function toggleSource(force) {
    const on = force === undefined ? !state.sourceMode : force;
    if (on === state.sourceMode) return;
    const frac = scroller.scrollTop / Math.max(1, scroller.scrollHeight - scroller.clientHeight);
    if (on) {
      editor.commit();
      sourceEl.value = editor.getMarkdown();
      docEl.hidden = true;
      sourceEl.hidden = false;
      $('#refs-live').hidden = true;
      state.sourceMode = true;
      autosizeSource();
      sourceEl.focus({ preventScroll: true });
    } else {
      const before = editor.getMarkdown();
      state.sourceMode = false;
      if (sourceEl.value !== before) {
        editor.history.push(before);
        editor.setMarkdown(sourceEl.value, true);
      }
      sourceEl.hidden = true;
      docEl.hidden = false;
      buildOutline();
    }
    setPressed('#btn-source', on);
    scroller.scrollTop = frac * (scroller.scrollHeight - scroller.clientHeight);
    updateDirty();
  }

  sourceEl.addEventListener('input', () => {
    autosizeSource();
    updateDirty();
    scheduleDraft();
  });
  sourceEl.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      document.execCommand('insertText', false, '    ');
    }
  });

  function setPressed(sel, on) {
    $(sel).setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function toggleBodyMode(cls, btn, key) {
    const on = document.body.classList.toggle(cls);
    setPressed(btn, on);
    store.set(key, on);
    return on;
  }

  function toggleFocus() {
    toggleBodyMode('focus-mode', '#btn-focus', 'focus');
  }
  function toggleTypewriter() {
    toggleBodyMode('typewriter', '#btn-typewriter', 'typewriter');
    typewriterScroll();
  }
  function toggleLock() {
    editor.readOnly = toggleBodyMode('locked', '#btn-lock', 'locked');
    if (editor.readOnly) editor.commit();
    flash(editor.readOnly ? 'Reading lock on: clicks will not start editing' : 'Editing enabled');
  }

  function typewriterScroll() {
    if (!document.body.classList.contains('typewriter') || !editor.active) return;
    const ta = editor.active.ta;
    const lines = ta.value.slice(0, ta.selectionStart).split('\n').length;
    const total = ta.value.split('\n').length;
    const r = ta.getBoundingClientRect();
    const caretY = r.top + (r.height * (lines - 0.5)) / total;
    const sr = scroller.getBoundingClientRect();
    const target = sr.top + sr.height * 0.45;
    scroller.scrollTop += caretY - target;
  }

  function toggleSidebar() {
    if (window.matchMedia('(max-width: 760px)').matches) {
      document.body.classList.toggle('sidebar-open');
      return;
    }
    const hidden = document.body.classList.toggle('no-sidebar');
    store.set('sidebar', !hidden);
  }

  function showTab(name) {
    $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === name ? 'true' : 'false'));
    $('#outline').hidden = name !== 'outline';
    $('#files').hidden = name !== 'files';
    if (document.body.classList.contains('no-sidebar')) toggleSidebar();
  }

  // ------------------------------------------------------- appearance

  const prefs = {
    theme: store.get('theme', 'auto'),
    font: store.get('font', 'serif'),
    size: store.get('size', 18),
    width: store.get('width', 42),
  };

  function applyPrefs() {
    const rootEl = document.documentElement;
    rootEl.dataset.theme = prefs.theme;
    rootEl.dataset.font = prefs.font;
    rootEl.style.setProperty('--text-size', prefs.size + 'px');
    rootEl.style.setProperty('--measure', prefs.width + 'rem');
    $$('[data-theme-choice]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.themeChoice === prefs.theme ? 'true' : 'false'));
    $$('[data-font-choice]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.fontChoice === prefs.font ? 'true' : 'false'));
    $('#rng-size').value = prefs.size;
    $('#rng-width').value = prefs.width;
    $('#out-size').textContent = prefs.size + 'px';
    $('#out-width').textContent = prefs.width + 'em';
    const bg = getComputedStyle(document.body).backgroundColor;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && bg) meta.setAttribute('content', bg);
    if (editor.active) editor.autosize(editor.active.ta);
    if (state.sourceMode) autosizeSource();
  }

  function setPref(key, value) {
    prefs[key] = value;
    store.set(key, value);
    applyPrefs();
  }

  $$('[data-theme-choice]').forEach((b) => b.addEventListener('click', () => setPref('theme', b.dataset.themeChoice)));
  $$('[data-font-choice]').forEach((b) => b.addEventListener('click', () => setPref('font', b.dataset.fontChoice)));
  $('#rng-size').addEventListener('input', (e) => setPref('size', +e.target.value));
  $('#rng-width').addEventListener('input', (e) => setPref('width', +e.target.value));

  // ------------------------------------------------------------ export

  const EXPORT_CSS = `
body{margin:0;background:#fbfaf7;color:#23211e;font:18px/1.68 Charter,"Iowan Old Style",Palatino,Georgia,serif;font-variant-numeric:oldstyle-nums}
main{max-width:42rem;margin:0 auto;padding:56px 24px 96px}
main>*+*{margin-top:.95em}
h1,h2,h3,h4,h5,h6{line-height:1.25;font-weight:650;margin:1.5em 0 0;font-variant-numeric:lining-nums}
h1{font-size:2em}h2{font-size:1.5em;border-bottom:1px solid #e3dfd6;padding-bottom:.15em}h3{font-size:1.25em}
p{margin:0}a{color:#2f5d8a}code{font:.84em ui-monospace,Menlo,Consolas,monospace;background:#f3f1ec;padding:.12em .35em;border-radius:4px}
pre{background:#f3f1ec;padding:14px 16px;border-radius:8px;overflow-x:auto;line-height:1.5;position:relative}pre code{background:none;padding:0}
.code-lang{position:absolute;top:6px;right:10px;font:11px system-ui,sans-serif;color:#8a857c}
blockquote{margin:0;padding-left:1.1em;border-left:3px solid #e3dfd6;color:#4b4741}
.callout{padding:.7em 1em;border-radius:8px;border-left:3px solid #2f5d8a;background:rgba(47,93,138,.08)}
.callout-title{font:650 .8em system-ui,sans-serif;text-transform:uppercase;letter-spacing:.05em;color:#2f5d8a}
table{border-collapse:collapse;margin:0 auto;font-size:.88em;font-variant-numeric:lining-nums tabular-nums;border-top:1.5px solid #4b4741;border-bottom:1.5px solid #4b4741}
th,td{padding:.35em .9em;text-align:left}thead th{border-bottom:1px solid #8a857c}
ul,ol{padding-left:1.6em;margin:0}li.task{list-style:none;margin-left:-1.4em}
img{max-width:100%}hr{border:0;height:1px;background:#e3dfd6}mark{background:#fbeaa0}
.math-block{text-align:center;overflow-x:auto}.cite{color:#6b4a8a}
.fn-ref{font-size:.72em;line-height:0}.fn-ref a{text-decoration:none}
.footnote-def{display:flex;gap:.6em;font-size:.86em;color:#4b4741}.fn-label{color:#2f5d8a;min-width:1.2em}
.link-def{display:none}
.refs h2{font-size:1.5em}.refs ol{list-style:none;padding:0}.refs li{padding-left:1.6em;text-indent:-1.6em;margin:.35em 0;font-size:.92em}
.front-matter{font:.78em system-ui,sans-serif;background:#f3f1ec;border-radius:8px;padding:8px 12px}
.front-matter table{border:0;margin:0}.front-matter th{color:#8a857c;font-weight:500}
@media print{body{background:#fff}main{padding:0}}`;

  async function cmdExportHtml() {
    editor.commit();
    const md = currentText();
    const wrap = document.createElement('main');
    wrap.innerHTML = MD.renderDocument(md, { bib: bib.lib });
    wrap.insertAdjacentHTML('beforeend', referencesHtml(Array.from(wrap.querySelectorAll('.cite'))));
    let katexLink = '';
    if (wrap.querySelector('.math-inline, .math-block')) {
      try {
        const katex = await ensureKatex();
        wrap.querySelectorAll('.math-inline, .math-block').forEach((m) =>
          katex.render(m.dataset.tex, m, { displayMode: m.classList.contains('math-block'), throwOnError: false })
        );
        katexLink = '<link rel="stylesheet" href="' + CDN.katexCss + '">'; // exported files always use the CDN
      } catch (e) {
        /* leave TeX source visible */
      }
    }
    const title = MD.escapeHtml(state.name.replace(/\.(md|markdown|txt)$/i, ''));
    const html =
      '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>' + title + '</title>' + katexLink + '<style>' + EXPORT_CSS + '</style></head><body>' +
      wrap.outerHTML + '</body></html>\n';
    if (await download(state.name.replace(/\.(md|markdown|mdown|mkd|txt)$/i, '') + '.html', html, 'text/html')) flash('Exported HTML');
  }

  function cmdPrint() {
    editor.commit();
    if (state.sourceMode) toggleSource(false);
    if (TAURI) invoke('print_page').catch((e) => flash('Print failed: ' + e));
    else window.print();
  }

  async function cmdQuit() {
    if (await confirmDiscard()) invoke('quit_app');
  }

  // ------------------------------------------------------- copy support

  // Copying across several rendered blocks puts their markdown on the
  // clipboard (plus the rendered HTML for rich-text targets).
  docEl.addEventListener('copy', (e) => {
    if (e.target.tagName === 'TEXTAREA') return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const ids = editor.blocks.filter((b) => {
      const el = editor.blockElement(b.id);
      return el && range.intersectsNode(el);
    });
    if (ids.length < 2) return;
    const md = ids.map((b) => b.src).join('\n\n');
    const div = document.createElement('div');
    div.appendChild(range.cloneContents());
    e.clipboardData.setData('text/plain', md);
    e.clipboardData.setData('text/html', div.innerHTML);
    e.preventDefault();
  });

  // ------------------------------------------------------ commands & keys

  const commands = {
    new: cmdNew,
    open: cmdOpen,
    openFolder: cmdOpenFolder,
    save: cmdSave,
    saveAs: cmdSaveAs,
    exportHtml: cmdExportHtml,
    print: cmdPrint,
    quit: cmdQuit,
    sidebar: () => toggleSidebar(),
    source: () => toggleSource(),
    focus: () => toggleFocus(),
    typewriter: () => toggleTypewriter(),
    lock: () => toggleLock(),
    loadBib: () => cmdLoadBib(),
    watch: () => toggleWatch(),
  };

  // In the desktop app one shortcut can arrive twice: as a key event in the
  // page and again from the native menu. Drop the echo from the other source.
  const lastRun = {};
  function runCommand(name, via) {
    if (!commands[name]) return;
    const now = Date.now();
    const prev = lastRun[name];
    if (TAURI && prev && prev.via !== via && now - prev.at < 300) return;
    lastRun[name] = { via, at: now };
    commands[name]();
  }

  document.addEventListener('click', (e) => {
    const cmdBtn = e.target.closest('[data-cmd]');
    if (cmdBtn) {
      closeMenus();
      runCommand(cmdBtn.dataset.cmd, 'click');
      return;
    }
    if (!e.target.closest('.menu-wrap')) closeMenus();
  });

  function closeMenus(except) {
    $$('.menu').forEach((m) => {
      if (m !== except) m.hidden = true;
    });
  }
  function toggleMenu(btnSel, menuSel) {
    $(btnSel).addEventListener('click', () => {
      const m = $(menuSel);
      closeMenus(m);
      m.hidden = !m.hidden;
    });
  }
  toggleMenu('#btn-file', '#menu-file');
  toggleMenu('#btn-appearance', '#menu-appearance');

  $('#btn-sidebar').addEventListener('click', toggleSidebar);
  $('#btn-source').addEventListener('click', () => toggleSource());
  $('#btn-focus').addEventListener('click', toggleFocus);
  $('#btn-typewriter').addEventListener('click', toggleTypewriter);
  $('#btn-lock').addEventListener('click', toggleLock);
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // Clicking the empty space below the last block continues the document.
  $('#tail').addEventListener('mousedown', (e) => {
    if (state.sourceMode || editor.readOnly) return;
    e.preventDefault();
    const last = editor.blocks[editor.blocks.length - 1];
    if (last.src.trim()) editor.exitTo(editor.blocks.length - 1, 'after');
    else editor.focusBlock(last.id, 'end');
  });

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const inBlock = e.target.classList && e.target.classList.contains('block-src');
    const inSource = e.target === sourceEl;

    if (e.key === 'Escape') closeMenus();
    if (mod && key === 's') {
      e.preventDefault();
      runCommand(e.shiftKey ? 'saveAs' : 'save', 'key');
    } else if (mod && key === 'o') {
      e.preventDefault();
      runCommand(e.shiftKey ? 'openFolder' : 'open', 'key');
    } else if (mod && key === 'n' && !e.shiftKey) {
      e.preventDefault();
      runCommand('new', 'key');
    } else if (mod && key === 'p') {
      e.preventDefault();
      runCommand('print', 'key');
    } else if (mod && key === 'q' && TAURI) {
      e.preventDefault();
      runCommand('quit', 'key');
    } else if (mod && (e.key === '/' || e.code === 'Slash')) {
      e.preventDefault();
      runCommand('source', 'key');
    } else if (mod && e.key === '\\') {
      e.preventDefault();
      runCommand('sidebar', 'key');
    } else if (mod && e.shiftKey && key === 'l') {
      e.preventDefault();
      runCommand('lock', 'key');
    } else if (mod && e.shiftKey && key === 'b') {
      e.preventDefault();
      runCommand('loadBib', 'key');
    } else if (e.key === 'F8') {
      e.preventDefault();
      runCommand('focus', 'key');
    } else if (e.key === 'F9') {
      e.preventDefault();
      runCommand('typewriter', 'key');
    } else if (mod && key === 'z' && !inBlock && !inSource && !/INPUT|TEXTAREA/.test(e.target.tagName)) {
      e.preventDefault();
      e.shiftKey ? editor.redo() : editor.undo();
    } else if (mod && key === 'y' && !inBlock && !inSource) {
      e.preventDefault();
      editor.redo();
    }
  });

  // Editor read-only guard (reading lock)
  const origActivate = editor.activateFromPoint.bind(editor);
  editor.activateFromPoint = function (blockEl, e) {
    if (this.readOnly) return;
    origActivate(blockEl, e);
  };

  // --------------------------------------------------------------- boot

  applyPrefs();
  if (store.get('sidebar', true) === false) document.body.classList.add('no-sidebar');
  if (store.get('focus', false)) toggleFocus();
  if (store.get('typewriter', false)) toggleTypewriter();
  if (store.get('locked', false)) {
    document.body.classList.add('locked');
    editor.readOnly = true;
    setPressed('#btn-lock', true);
  }
  document.body.classList.add('editing-none');

  if (isMac) {
    $$('kbd').forEach((k) => (k.textContent = k.textContent.replace(/Ctrl\+/g, '⌘').replace(/Shift\+/g, '⇧')));
  }
  if (TAURI) {
    $('#topbar').setAttribute('data-tauri-drag-region', '');
    $('.bar-title').setAttribute('data-tauri-drag-region', '');
  }

  const draft = store.get('draft', null);
  if (TAURI && draft && draft.path && draft.saved) {
    // the file may have changed while the app was closed: read it fresh
    loadText(draft.text || '', draft.name, null, null, draft.path);
    openPath(draft.path);
  } else if (draft && typeof draft.text === 'string' && draft.text.trim()) {
    loadText(draft.text, draft.name, null, null, TAURI ? draft.path : null);
    if (!draft.saved) {
      state.savedText = '';
      updateDirty();
      flash('Restored your unsaved draft');
    }
  } else {
    loadText(window.WELCOME_DOC, 'Welcome.md');
  }

  if (!hasFS) $('#folder-hint').textContent = 'Folder browsing needs a Chromium-based browser (Chrome, Edge, Arc, Brave).';

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  window.mdreader = { editor, state, loadText };
})();
