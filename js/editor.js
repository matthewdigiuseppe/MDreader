/*
 * BlockEditor - Typora-style "what you see is what you mean" editing.
 *
 * The document is a list of blocks (paragraphs, headings, lists, tables,
 * code, math...). Every block is shown rendered, except the one you are
 * editing, which turns into its raw markdown in a borderless textarea styled
 * to look like the rendered block. Leaving the block renders it again.
 */
(function (root) {
  'use strict';

  const MD = root.MD;
  let nextId = 1;

  function kindOf(src) {
    const first = src.split('\n')[0];
    let m = first.match(/^ {0,3}(#{1,6})(\s|$)/);
    if (m) return 'h' + m[1].length;
    if (/^ {0,3}(`{3,}|~{3,})/.test(first)) return 'code';
    if (/^ {0,3}\$\$/.test(first)) return 'math';
    if (/^---$/.test(first) && src.includes('\n')) return 'meta';
    if (/^ {0,3}>/.test(first)) return 'quote';
    if (/^\s*([-+*]|\d{1,9}[.)])(\s|$)/.test(first) && !MD.RE.hr.test(first)) return 'list';
    if (first.includes('|') && /\n\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*(\n|$)/.test(src)) return 'table';
    if (MD.RE.hr.test(first) && !src.includes('\n')) return 'hr';
    return 'p';
  }

  function insertText(ta, text) {
    ta.focus();
    // execCommand keeps the textarea's native undo stack intact.
    if (!document.execCommand('insertText', false, text)) {
      ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
    }
  }

  function lineBounds(val, pos) {
    const start = val.lastIndexOf('\n', pos - 1) + 1;
    let end = val.indexOf('\n', pos);
    if (end < 0) end = val.length;
    return { start, end, text: val.slice(start, end) };
  }

  /**
   * Map a caret position in rendered text to a position in the markdown
   * source by walking both strings and skipping markup characters.
   */
  function mapRenderedToSource(renderedPrefix, src) {
    let j = 0;
    // Skip structural prefixes (heading hashes, list markers) up front.
    const lead = src.match(/^ {0,3}(#{1,6} +|> ?|(?:[-+*]|\d+[.)]) +(\[[ xX]\] +)?)/);
    if (lead) j = lead[0].length;
    for (const ch of renderedPrefix) {
      if (/\s/.test(ch)) {
        while (j < src.length && !/\s/.test(src[j])) {
          j++;
          if (j > src.length) break;
        }
        if (j < src.length) j++;
        continue;
      }
      const k = src.indexOf(ch, j);
      if (k < 0 || k - j > 120) break;
      j = k + 1;
    }
    return Math.min(j, src.length);
  }

  class BlockEditor {
    constructor(el, opts) {
      this.el = el;
      this.opts = opts || {};
      this.blocks = [];
      this.active = null; // { id, ta, initial }
      this.history = [];
      this.future = [];
      this.ctx = MD.buildContext([]);
      this.ctxKey = '';
      this.bind();
    }

    // ------------------------------------------------------------ public

    setMarkdown(md, keepHistory) {
      this.active = null;
      this.blocks = MD.splitBlocks(md).map((src) => ({ id: nextId++, src }));
      if (!this.blocks.length) this.blocks.push({ id: nextId++, src: '' });
      if (!keepHistory) {
        this.history = [];
        this.future = [];
      }
      this.lastSnapshot = this.getMarkdown();
      this.renderAll();
    }

    getMarkdown() {
      const parts = this.blocks.map((b) => b.src.replace(/\s+$/, '')).filter((s, k, a) => s || a.length === 1);
      const md = parts.join('\n\n');
      return md ? md + '\n' : '';
    }

    focusBlock(id, caret) {
      this.edit(id, caret === undefined ? 'end' : caret);
    }

    blockElement(id) {
      return this.el.querySelector('.block[data-id="' + id + '"]');
    }

    undo() {
      this.commit();
      if (!this.history.length) return;
      this.future.push(this.getMarkdown());
      const md = this.history.pop();
      this.restore(md);
    }

    redo() {
      this.commit();
      if (!this.future.length) return;
      this.history.push(this.getMarkdown());
      this.restore(this.future.pop());
    }

    /** Apply a transformation to the block being edited (toolbar actions). */
    transformActive(fn) {
      if (!this.active) return false;
      const ta = this.active.ta;
      fn(ta);
      return true;
    }

    // ---------------------------------------------------------- rendering

    renderAll() {
      this.ctx = MD.buildContext(this.blocks.map((b) => b.src));
      this.ctxKey = JSON.stringify([this.ctx.links, this.ctx.footnotes, this.ctx.footnoteOrder]);
      const frag = document.createDocumentFragment();
      this.ctx.slugs = {};
      this.bulk = true;
      this.blocks.forEach((b, k) => frag.appendChild(this.renderBlockEl(b, k)));
      this.bulk = false;
      this.el.innerHTML = '';
      this.el.appendChild(frag);
      this.afterRender();
    }

    renderBlockEl(b, k) {
      const div = document.createElement('div');
      div.className = 'block kind-' + kindOf(b.src);
      div.dataset.id = b.id;
      this.fillBlock(div, b, k);
      return div;
    }

    fillBlock(div, b, k) {
      div.classList.remove('editing');
      div.className = 'block kind-' + kindOf(b.src);
      if (!b.src.trim()) {
        div.classList.add('empty');
        div.innerHTML = '<p><br></p>';
      } else {
        if (!this.bulk) {
          // keep heading ids unique: replay the slugs of earlier headings
          this.ctx.slugs = {};
          for (let p = 0; p < k; p++) {
          const h = this.blocks[p].src.match(MD.RE.heading);
            if (h && !this.blocks[p].src.includes('\n')) MD.slugify(h[2] || '', this.ctx);
          }
        }
        div.innerHTML = MD.renderBlock(b.src, this.ctx, { first: k === 0 });
      }
      if (this.opts.enhance) this.opts.enhance(div);
    }

    rerender(id) {
      const k = this.blocks.findIndex((b) => b.id === id);
      const el = this.blockElement(id);
      if (k < 0 || !el) return;
      this.fillBlock(el, this.blocks[k], k);
    }

    afterRender() {
      if (this.opts.onChange) this.opts.onChange();
    }

    // ------------------------------------------------------------ editing

    edit(id, caret) {
      if (this.active && this.active.id === id) {
        this.setCaret(this.active.ta, caret);
        return;
      }
      this.commit();
      const b = this.blocks.find((x) => x.id === id);
      const el = this.blockElement(id);
      if (!b || !el) return;

      const ta = document.createElement('textarea');
      ta.className = 'block-src';
      ta.value = b.src;
      ta.spellcheck = true;
      ta.rows = 1;
      ta.setAttribute('aria-label', 'Markdown source of block');
      el.className = 'block editing kind-' + kindOf(b.src);
      el.innerHTML = '';
      el.appendChild(ta);

      const preview = document.createElement('div');
      preview.className = 'block-preview';
      el.appendChild(preview);

      this.active = { id, ta, preview, initial: b.src, snapshot: this.getMarkdown() };
      this.autosize(ta);
      this.updatePreview();
      ta.focus({ preventScroll: true });
      this.setCaret(ta, caret);

      ta.addEventListener('input', () => {
        b.src = ta.value;
        el.className = 'block editing kind-' + kindOf(b.src);
        this.autosize(ta);
        this.updatePreview();
        if (this.opts.onInput) this.opts.onInput();
      });
      ta.addEventListener('keydown', (e) => this.onKey(e, b, ta));
      ta.addEventListener('blur', () => {
        setTimeout(() => {
          if (!document.hasFocus()) return; // window switch: keep editing
          if (this.active && this.active.ta === ta && document.activeElement !== ta) this.commit();
        }, 0);
      });
      if (this.opts.onFocusBlock) this.opts.onFocusBlock(el);
    }

    updatePreview() {
      const a = this.active;
      if (!a) return;
      const kind = kindOf(a.ta.value);
      if (kind === 'math' || kind === 'table') {
        a.preview.innerHTML = MD.renderBlock(a.ta.value, this.ctx);
        a.preview.hidden = false;
        if (this.opts.enhance) this.opts.enhance(a.preview);
      } else {
        a.preview.hidden = true;
        a.preview.innerHTML = '';
      }
    }

    autosize(ta) {
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
    }

    setCaret(ta, caret) {
      let pos;
      if (caret === 'start') pos = 0;
      else if (caret === 'end' || caret === undefined) pos = ta.value.length;
      else pos = Math.max(0, Math.min(caret, ta.value.length));
      ta.setSelectionRange(pos, pos);
    }

    /** Leave the active block: re-split, re-render and record history. */
    commit() {
      const a = this.active;
      if (!a) return;
      this.active = null;
      const k = this.blocks.findIndex((b) => b.id === a.id);
      if (k < 0) return;
      const src = a.ta.value.replace(/\s+$/, '');
      const parts = MD.splitBlocks(src);
      const el = this.blockElement(a.id);

      if (!parts.length) {
        if (this.blocks.length > 1) {
          this.blocks.splice(k, 1);
          if (el) el.remove();
        } else {
          this.blocks[k].src = '';
          if (el) this.fillBlock(el, this.blocks[k], k);
        }
      } else {
        this.blocks[k].src = parts[0];
        const extra = parts.slice(1).map((s) => ({ id: nextId++, src: s }));
        this.blocks.splice(k + 1, 0, ...extra);
        let anchor = el;
        extra.forEach((b, n) => {
          const nel = this.renderBlockEl(b, k + 1 + n);
          anchor.after(nel);
          anchor = nel;
        });
        if (el) this.fillBlock(el, this.blocks[k], k);
      }

      const newCtx = MD.buildContext(this.blocks.map((b) => b.src));
      const key = JSON.stringify([newCtx.links, newCtx.footnotes, newCtx.footnoteOrder]);
      if (key !== this.ctxKey) this.renderAll();
      else this.afterRender();
      this.record(a.snapshot);
    }

    record(before) {
      const now = this.getMarkdown();
      if (before !== undefined && before !== now) {
        this.history.push(before);
        if (this.history.length > 200) this.history.shift();
        this.future = [];
      }
      this.lastSnapshot = now;
    }

    restore(md) {
      const y = this.el.parentElement ? this.el.parentElement.scrollTop : 0;
      this.setMarkdown(md, true);
      if (this.el.parentElement) this.el.parentElement.scrollTop = y;
    }

    insertBlockAfter(k, src) {
      const b = { id: nextId++, src: src || '' };
      this.blocks.splice(k + 1, 0, b);
      const prevEl = this.blockElement(this.blocks[k].id);
      const el = this.renderBlockEl(b, k + 1);
      if (prevEl) prevEl.after(el);
      else this.el.appendChild(el);
      return b;
    }

    removeBlock(k) {
      const b = this.blocks[k];
      this.blocks.splice(k, 1);
      const el = this.blockElement(b.id);
      if (el) el.remove();
    }

    // Splits the active block: text before the caret stays, the rest moves
    // into a new block that receives focus.
    splitActive(b, ta, before, after) {
      const k = this.blocks.findIndex((x) => x.id === b.id);
      const snapshot = this.active.snapshot;
      ta.value = before;
      b.src = before;
      const nb = this.insertBlockAfter(k, after);
      this.active.snapshot = snapshot;
      this.edit(nb.id, 'start');
    }

    // ----------------------------------------------------------- keyboard

    onKey(e, b, ta) {
      const val = ta.value;
      const pos = ta.selectionStart;
      const end = ta.selectionEnd;
      const mod = e.ctrlKey || e.metaKey;
      const kind = kindOf(val);
      const k = this.blocks.findIndex((x) => x.id === b.id);

      if (e.isComposing) return;

      // ---- formatting shortcuts
      if (mod && !e.altKey) {
        const key = e.key.toLowerCase();
        const wraps = { b: '**', i: '*', e: '`', u: '<u>' };
        if (wraps[key] && !e.shiftKey) {
          e.preventDefault();
          this.wrapSelection(ta, wraps[key], key === 'u' ? '</u>' : wraps[key]);
          return;
        }
        if (key === 'k' && !e.shiftKey) {
          e.preventDefault();
          const sel = val.slice(pos, end) || 'link text';
          insertText(ta, '[' + sel + '](url)');
          const urlStart = pos + sel.length + 3;
          ta.setSelectionRange(urlStart, urlStart + 3);
          return;
        }
        if (/^[0-6]$/.test(e.key)) {
          e.preventDefault();
          this.setHeading(ta, +e.key);
          return;
        }
        if (key === 'z' && !e.shiftKey && ta.value === this.active.initial) {
          e.preventDefault();
          this.undo();
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          this.exitTo(k, 'after');
          return;
        }
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        this.commit();
        ta.blur();
        return;
      }

      // ---- Enter
      if (e.key === 'Enter' && !mod && !e.altKey) {
        if (e.shiftKey) return; // soft line break
        const line = lineBounds(val, pos);

        if (kind === 'code' || kind === 'math') {
          const opener = val.match(/^(\s*)(`{3,}|~{3,}|\$\$)[^\n]*$/);
          if (opener && pos === val.length) {
            // Auto-close a freshly typed fence: ```python⏎
            e.preventDefault();
            const close = opener[2];
            insertText(ta, '\n\n' + close);
            ta.setSelectionRange(pos + 1, pos + 1);
            this.autosize(ta);
            return;
          }
          const closed = val.split('\n').length > 1 && /^(\s*)(`{3,}|~{3,}|\$\$)\s*$/.test(val.split('\n').pop());
          if (closed && pos === val.length) {
            e.preventDefault();
            this.exitTo(k, 'after');
          }
          return; // newline inside code / math
        }

        if (kind === 'list' || kind === 'quote' || kind === 'table') {
          const lm = line.text.match(/^(\s*(?:>\s*)*)((?:[-+*]|(\d+)([.)]))\s+)?(\[[ xX]\]\s+)?(.*)$/);
          const isList = lm && lm[2];
          const content = lm ? lm[6] : line.text;
          if (!content.trim() && pos === line.end) {
            // empty item: end the list / quote / table here
            e.preventDefault();
            const before = val.slice(0, line.start).replace(/\n$/, '');
            const after = val.slice(line.end).replace(/^\n/, '');
            if (!before.trim()) {
              ta.value = after;
              b.src = after;
              this.setCaret(ta, 0);
              this.autosize(ta);
              return;
            }
            this.splitActive(b, ta, before, after);
            return;
          }
          if (kind === 'table') return;
          e.preventDefault();
          let marker = lm[1];
          if (isList) {
            marker += lm[3] ? parseInt(lm[3], 10) + 1 + lm[4] + ' ' : lm[2].trim() + ' ';
            if (lm[5]) marker += '[ ] ';
          }
          insertText(ta, '\n' + marker);
          this.autosize(ta);
          return;
        }

        // paragraph / heading: Enter starts a new block
        e.preventDefault();
        const before = val.slice(0, pos).replace(/\s+$/, '');
        let after = val.slice(end).replace(/^\s+/, '');
        this.splitActive(b, ta, before, after);
        return;
      }

      // ---- Backspace at the very start merges with the previous block
      if (e.key === 'Backspace' && pos === 0 && end === 0 && !mod) {
        if (k <= 0) return;
        const prev = this.blocks[k - 1];
        const pk = kindOf(prev.src);
        e.preventDefault();
        if (pk === 'hr') {
          this.removeBlock(k - 1);
          return;
        }
        if (!val.trim()) {
          this.removeBlock(k);
          this.active = null;
          this.edit(prev.id, 'end');
          return;
        }
        if (['code', 'math', 'table', 'meta'].includes(pk) || ['code', 'math', 'table'].includes(kind)) {
          this.edit(prev.id, 'end');
          return;
        }
        const caret = prev.src.length;
        const snapshot = this.active.snapshot;
        prev.src = prev.src + val.replace(/^ {0,3}#{1,6}\s+/, '');
        this.removeBlock(k);
        this.active = null;
        this.edit(prev.id, caret);
        if (this.active) this.active.snapshot = snapshot;
        return;
      }

      // ---- Arrow navigation between blocks
      if (!e.shiftKey && !mod && !e.altKey && pos === end) {
        if (e.key === 'ArrowLeft' && pos === 0 && k > 0) {
          e.preventDefault();
          this.edit(this.blocks[k - 1].id, 'end');
          return;
        }
        if (e.key === 'ArrowRight' && pos === val.length && k + 1 < this.blocks.length) {
          e.preventDefault();
          this.edit(this.blocks[k + 1].id, 'start');
          return;
        }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          // Let the browser move the caret first; if it could not move
          // (first / last visual line), hop to the neighbouring block.
          const up = e.key === 'ArrowUp';
          setTimeout(() => {
            if (!this.active || this.active.ta !== ta) return;
            if (ta.selectionStart !== pos || ta.selectionEnd !== pos) return;
            if (up && k > 0) this.edit(this.blocks[k - 1].id, 'end');
            else if (!up) this.exitTo(k, 'down');
          }, 0);
          return;
        }
      }

      // ---- Tab
      if (e.key === 'Tab') {
        if (kind === 'table') {
          e.preventDefault();
          const next = e.shiftKey ? val.lastIndexOf('|', pos - 2) : val.indexOf('|', pos);
          if (next >= 0) {
            const p = e.shiftKey ? val.lastIndexOf('|', next - 1) + 2 : next + 2;
            ta.setSelectionRange(Math.min(p, val.length), Math.min(p, val.length));
          }
          return;
        }
        if (kind === 'list' || kind === 'quote') {
          e.preventDefault();
          const line = lineBounds(val, pos);
          ta.setSelectionRange(line.start, line.start);
          if (e.shiftKey) {
            const n = (line.text.match(/^ {1,4}/) || [''])[0].length;
            if (n) {
              ta.setSelectionRange(line.start, line.start + Math.min(n, 2));
              insertText(ta, '');
              ta.setSelectionRange(pos - Math.min(n, 2), pos - Math.min(n, 2));
            } else ta.setSelectionRange(pos, pos);
          } else {
            insertText(ta, '  ');
            ta.setSelectionRange(pos + 2, pos + 2);
          }
          return;
        }
        if (kind === 'code') {
          e.preventDefault();
          insertText(ta, '    ');
          return;
        }
      }
    }

    /** Move out of block k, creating an empty paragraph when at the end. */
    exitTo(k, how) {
      if (k + 1 < this.blocks.length) {
        this.edit(this.blocks[k + 1].id, 'start');
        return;
      }
      const cur = this.blocks[k];
      if (!cur.src.trim() && how !== 'after') return;
      const nb = this.insertBlockAfter(k, '');
      this.edit(nb.id, 'start');
    }

    wrapSelection(ta, left, right) {
      const s = ta.selectionStart;
      const e = ta.selectionEnd;
      const sel = ta.value.slice(s, e);
      if (sel.startsWith(left) && sel.endsWith(right) && sel.length >= left.length + right.length) {
        insertText(ta, sel.slice(left.length, sel.length - right.length));
        ta.setSelectionRange(s, e - left.length - right.length);
        return;
      }
      if (ta.value.slice(s - left.length, s) === left && ta.value.slice(e, e + right.length) === right) {
        ta.setSelectionRange(s - left.length, e + right.length);
        insertText(ta, sel);
        ta.setSelectionRange(s - left.length, e - left.length);
        return;
      }
      insertText(ta, left + sel + right);
      ta.setSelectionRange(s + left.length, e + left.length);
    }

    setHeading(ta, level) {
      const pos = ta.selectionStart;
      const old = ta.value.match(/^ {0,3}#{1,6}\s+/);
      const oldLen = old ? old[0].length : 0;
      const prefix = level ? '#'.repeat(level) + ' ' : '';
      ta.setSelectionRange(0, oldLen);
      insertText(ta, prefix);
      const p = Math.max(prefix.length, pos - oldLen + prefix.length);
      ta.setSelectionRange(p, p);
    }

    // -------------------------------------------------------------- mouse

    bind() {
      // When another block is being edited, take over on mousedown so the
      // layout shift from re-rendering it does not swallow the click.
      this.el.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        const blockEl = e.target.closest('.block');
        if (!this.active || !blockEl || blockEl.classList.contains('editing')) return;
        if (this.isInteractive(e)) return;
        e.preventDefault();
        this.activateFromPoint(blockEl, e);
      });

      this.el.addEventListener('click', (e) => {
        const a = e.target.closest('a');
        if (a && !e.target.closest('.editing')) {
          const href = a.getAttribute('href') || '';
          if (href.startsWith('#')) {
            e.preventDefault();
            const t = this.el.querySelector(href.replace(/([:.])/g, '\\$1'));
            if (t) t.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
          }
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            if (this.opts.openLink) this.opts.openLink(href);
            else window.open(href, '_blank', 'noopener');
            return;
          }
          e.preventDefault();
        }
        if (e.target.classList.contains('task-box')) {
          this.toggleTask(e.target);
          return;
        }
        const blockEl = e.target.closest('.block');
        if (!blockEl || blockEl.classList.contains('editing')) return;
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && this.el.contains(sel.anchorNode)) return; // user is selecting text
        this.activateFromPoint(blockEl, e);
      });
    }

    isInteractive(e) {
      return (
        e.target.classList.contains('task-box') ||
        (e.target.closest('a') && (e.ctrlKey || e.metaKey || (e.target.closest('a').getAttribute('href') || '').startsWith('#')))
      );
    }

    activateFromPoint(blockEl, e) {
      const id = +blockEl.dataset.id;
      const b = this.blocks.find((x) => x.id === id);
      if (!b) return;
      let caret = 'end';
      const kind = kindOf(b.src);
      if (!['code', 'math', 'table', 'hr', 'meta'].includes(kind)) {
        let range = null;
        if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(e.clientX, e.clientY);
        else if (document.caretPositionFromPoint) {
          const p = document.caretPositionFromPoint(e.clientX, e.clientY);
          if (p) {
            range = document.createRange();
            range.setStart(p.offsetNode, p.offset);
          }
        }
        if (range && blockEl.contains(range.startContainer)) {
          const pre = document.createRange();
          pre.selectNodeContents(blockEl);
          pre.setEnd(range.startContainer, range.startOffset);
          caret = mapRenderedToSource(pre.toString(), b.src);
        }
      }
      this.edit(id, caret);
    }

    toggleTask(box) {
      const blockEl = box.closest('.block');
      const id = +blockEl.dataset.id;
      const b = this.blocks.find((x) => x.id === id);
      const boxes = Array.from(blockEl.querySelectorAll('.task-box'));
      const n = boxes.indexOf(box);
      let count = -1;
      const before = this.getMarkdown();
      b.src = b.src.replace(/^((?:\s*>)*\s*(?:[-+*]|\d+[.)])\s+)\[([ xX])\]/gm, (all, pre, mark) => {
        count++;
        if (count !== n) return all;
        return pre + (mark === ' ' ? '[x]' : '[ ]');
      });
      this.rerender(id);
      this.record(before);
      this.afterRender();
    }
  }

  BlockEditor.kindOf = kindOf;
  BlockEditor.mapRenderedToSource = mapRenderedToSource;
  root.BlockEditor = BlockEditor;
})(window);
