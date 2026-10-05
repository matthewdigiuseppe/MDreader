/* MDreader application shell: files, outline, modes, themes, export. */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const MD = window.MD;

  const CDN = {
    katexJs: 'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.js',
    katexCss: 'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.css',
    hljs: 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js',
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
        s.onerror = () => reject(new Error('Could not load ' + url));
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

  function ensureKatex() {
    if (window.katex) return Promise.resolve(window.katex);
    loadCss(CDN.katexCss);
    return loadScript(CDN.katexJs).then(() => window.katex);
  }
  function ensureHljs() {
    if (window.hljs) return Promise.resolve(window.hljs);
    return loadScript(CDN.hljs).then(() => window.hljs);
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
  async function resolveImage(img) {
    const src = img.getAttribute('src') || '';
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
    enhance,
    onChange: () => {
      updateDirty();
      scheduleOutline();
      scheduleDraft();
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
    openLink: (href) => window.open(href, '_blank', 'noopener'),
  });

  docEl.addEventListener('focusout', () => {
    setTimeout(() => {
      if (!editor.active) document.body.classList.add('editing-none');
    }, 0);
  });

  function currentText() {
    return state.sourceMode ? sourceEl.value : editor.getMarkdown();
  }

  function loadText(text, name, handle, dirStack) {
    if (state.sourceMode) toggleSource(false);
    state.name = name || 'Untitled.md';
    state.handle = handle || null;
    state.dirStack = dirStack || null;
    assetCache.forEach((url) => URL.revokeObjectURL(url));
    assetCache.clear();
    editor.setMarkdown(text);
    state.savedText = editor.getMarkdown();
    updateDirty();
    scroller.scrollTop = 0;
    $('#doc-name').textContent = state.name;
    document.title = state.name.replace(/\.(md|markdown|txt)$/i, '') + ' — MDreader';
    store.set('draft', { name: state.name, text: state.savedText, saved: true });
    highlightCurrentFile();
    buildOutline();
    updateStats();
  }

  function updateDirty() {
    state.dirty = currentText() !== state.savedText;
    $('#dirty').hidden = !state.dirty;
  }

  let draftTimer = null;
  function scheduleDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      store.set('draft', { name: state.name, text: currentText(), saved: !state.dirty });
      updateStats();
    }, 400);
  }

  // ------------------------------------------------------------ files

  const hasFS = 'showOpenFilePicker' in window;
  const MD_TYPES = [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.mkd', '.txt'] } }];

  function confirmDiscard() {
    return !state.dirty || window.confirm('You have unsaved changes in "' + state.name + '". Discard them?');
  }

  async function cmdNew() {
    if (!confirmDiscard()) return;
    loadText('', 'Untitled.md');
    editor.focusBlock(editor.blocks[0].id);
  }

  async function cmdOpen() {
    if (!confirmDiscard()) return;
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

  async function cmdSave() {
    if (state.sourceMode) syncFromSource();
    editor.commit();
    const text = currentText();
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
    return cmdSaveAs();
  }

  async function cmdSaveAs() {
    if (state.sourceMode) syncFromSource();
    editor.commit();
    const text = currentText();
    if ('showSaveFilePicker' in window) {
      try {
        const h = await window.showSaveFilePicker({ suggestedName: state.name, types: MD_TYPES });
        const w = await h.createWritable();
        await w.write(text);
        await w.close();
        state.handle = h;
        state.name = h.name;
        $('#doc-name').textContent = state.name;
        markSaved(text);
        flash('Saved ' + state.name);
      } catch (e) {
        if (e.name !== 'AbortError') flash('Save failed: ' + e.message);
      }
      return;
    }
    download(state.name, text, 'text/markdown');
    markSaved(text);
    flash('Downloaded ' + state.name);
  }

  function markSaved(text) {
    state.savedText = text;
    updateDirty();
    store.set('draft', { name: state.name, text, saved: true });
  }

  function download(name, content, type) {
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
      renderTree(tree);
    } catch (e) {
      if (e.name !== 'AbortError') flash('Could not open folder: ' + e.message);
    }
  }

  async function readTree(dir, depth) {
    const node = { name: dir.name, dir, children: [] };
    if (depth > 4) return node;
    for await (const [name, h] of dir.entries()) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      if (h.kind === 'directory') {
        const child = await readTree(h, depth + 1);
        if (child.children.length) node.children.push(child);
      } else if (/\.(md|markdown|mdown|mkd|txt)$/i.test(name)) {
        node.children.push({ name, file: h });
      }
    }
    node.children.sort((a, b) => (!!b.dir - !!a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    return node;
  }

  function renderTree(root) {
    const ul = $('#file-tree');
    ul.innerHTML = '';
    $('#files .empty-note').hidden = true;
    const build = (node, parentUl, stack) => {
      node.children.forEach((c) => {
        const li = document.createElement('li');
        const span = document.createElement('span');
        span.textContent = c.name;
        li.appendChild(span);
        parentUl.appendChild(li);
        if (c.dir) {
          li.className = 'dir';
          const sub = document.createElement('ul');
          li.appendChild(sub);
          span.addEventListener('click', () => (sub.hidden = !sub.hidden));
          build(c, sub, stack.concat(c.dir));
        } else {
          li.className = 'file';
          li.dataset.path = stack.map((d) => d.name).concat(c.name).join('/');
          span.title = li.dataset.path;
          span.addEventListener('click', async () => {
            if (!confirmDiscard()) return;
            const f = await c.file.getFile();
            loadText(await f.text(), f.name, c.file, stack);
            state.currentPath = li.dataset.path;
            highlightCurrentFile();
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
    build(root, ul, [root.dir]);
    if (!root.children.length) {
      const li = document.createElement('li');
      li.innerHTML = '<span>No markdown files here.</span>';
      ul.appendChild(li);
    }
  }

  function highlightCurrentFile() {
    $$('#file-tree li.file').forEach((li) => li.classList.toggle('current', li.dataset.path === state.currentPath && !!state.dirStack));
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
    if (!confirmDiscard()) return;
    loadText(await f.text(), f.name, handle && handle.kind === 'file' ? handle : null);
    flash('Opened ' + f.name);
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) {
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
.front-matter{font:.78em system-ui,sans-serif;background:#f3f1ec;border-radius:8px;padding:8px 12px}
.front-matter table{border:0;margin:0}.front-matter th{color:#8a857c;font-weight:500}
@media print{body{background:#fff}main{padding:0}}`;

  async function cmdExportHtml() {
    editor.commit();
    const md = currentText();
    const wrap = document.createElement('main');
    wrap.innerHTML = MD.renderDocument(md);
    let katexLink = '';
    if (wrap.querySelector('.math-inline, .math-block')) {
      try {
        const katex = await ensureKatex();
        wrap.querySelectorAll('.math-inline, .math-block').forEach((m) =>
          katex.render(m.dataset.tex, m, { displayMode: m.classList.contains('math-block'), throwOnError: false })
        );
        katexLink = '<link rel="stylesheet" href="' + CDN.katexCss + '">';
      } catch (e) {
        /* leave TeX source visible */
      }
    }
    const title = MD.escapeHtml(state.name.replace(/\.(md|markdown|txt)$/i, ''));
    const html =
      '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>' + title + '</title>' + katexLink + '<style>' + EXPORT_CSS + '</style></head><body>' +
      wrap.outerHTML + '</body></html>\n';
    download(state.name.replace(/\.(md|markdown|mdown|mkd|txt)$/i, '') + '.html', html, 'text/html');
    flash('Exported HTML');
  }

  function cmdPrint() {
    editor.commit();
    if (state.sourceMode) toggleSource(false);
    window.print();
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
  };

  document.addEventListener('click', (e) => {
    const cmdBtn = e.target.closest('[data-cmd]');
    if (cmdBtn) {
      closeMenus();
      commands[cmdBtn.dataset.cmd]();
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
      e.shiftKey ? cmdSaveAs() : cmdSave();
    } else if (mod && key === 'o') {
      e.preventDefault();
      cmdOpen();
    } else if (mod && key === 'n' && !e.shiftKey) {
      e.preventDefault();
      cmdNew();
    } else if (mod && key === 'p') {
      e.preventDefault();
      cmdPrint();
    } else if (mod && (e.key === '/' || e.code === 'Slash')) {
      e.preventDefault();
      toggleSource();
    } else if (mod && e.key === '\\') {
      e.preventDefault();
      toggleSidebar();
    } else if (e.key === 'F8') {
      e.preventDefault();
      toggleFocus();
    } else if (e.key === 'F9') {
      e.preventDefault();
      toggleTypewriter();
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

  const draft = store.get('draft', null);
  if (draft && typeof draft.text === 'string' && draft.text.trim()) {
    loadText(draft.text, draft.name);
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
