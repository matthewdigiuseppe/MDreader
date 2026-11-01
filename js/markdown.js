/*
 * MDreader markdown engine.
 *
 * Two jobs:
 *   1. splitBlocks(src)  - cut a document into top-level blocks, keeping the
 *      raw markdown of each block so it can be edited in place.
 *   2. renderBlock(src, ctx) - turn one block of markdown into HTML.
 *
 * Supports CommonMark-ish syntax plus the extensions academics and AI tools
 * tend to produce: GFM tables, task lists, strikethrough, footnotes, $math$,
 * ==highlight==, pandoc citations [@key], sub/superscript, YAML front matter
 * and GitHub-style callouts (> [!NOTE]).
 *
 * Written as a classic script (no modules) so index.html works from file://.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- helpers

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function safeUrl(url) {
    const u = String(url).trim();
    if (/^(javascript|vbscript|data:(?!image\/))/i.test(u)) return '#';
    return u;
  }

  function slugify(text, ctx) {
    let base = String(text)
      .toLowerCase()
      .replace(/<[^>]+>/g, '')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-') || 'section';
    if (!ctx || !ctx.slugs) return base;
    let slug = base;
    let n = 1;
    while (ctx.slugs[slug]) slug = base + '-' + n++;
    ctx.slugs[slug] = true;
    return slug;
  }

  const RE = {
    blank: /^\s*$/,
    fence: /^( {0,3})(`{3,}|~{3,})(.*)$/,
    mathOpen: /^ {0,3}\$\$/,
    heading: /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/,
    hr: /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/,
    quote: /^ {0,3}>/,
    list: /^( *)([-+*]|\d{1,9}[.)])([ \t]+|$)(.*)$/,
    tableDelim: /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/,
    footnoteDef: /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)$/,
    linkDef: /^ {0,3}\[([^\]^][^\]]*)\]:[ \t]*<?(\S+?)>?(?:[ \t]+["'(](.*)["')])?[ \t]*$/,
  };

  function isListLine(line) {
    const m = line.match(RE.list);
    // "-" alone, "- text", "1. text". Exclude "---" (hr) and "**bold**".
    return !!m && !RE.hr.test(line);
  }

  function startsBlock(line, next) {
    return (
      RE.fence.test(line) ||
      RE.mathOpen.test(line) ||
      RE.heading.test(line) ||
      RE.hr.test(line) ||
      RE.quote.test(line) ||
      RE.footnoteDef.test(line) ||
      (isListLine(line) && /^\s*([-+*]|1[.)])[ \t]+\S/.test(line)) ||
      (next !== undefined && line.includes('|') && RE.tableDelim.test(next) && next.includes('-'))
    );
  }

  // ------------------------------------------------------ block splitting

  /**
   * Split a document into raw top-level blocks. Joining the result with
   * "\n\n" gives back an equivalent document.
   */
  function splitBlocks(src) {
    src = String(src || '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
    const lines = src.split('\n');
    const blocks = [];
    let i = 0;

    // YAML front matter
    if (lines[0] === '---') {
      let j = 1;
      while (j < lines.length && !/^(---|\.\.\.)\s*$/.test(lines[j])) j++;
      if (j < lines.length) {
        blocks.push(lines.slice(0, j + 1).join('\n'));
        i = j + 1;
      }
    }

    let cur = [];
    const flush = () => {
      if (cur.length) blocks.push(cur.join('\n'));
      cur = [];
    };

    while (i < lines.length) {
      const line = lines[i];
      const inList = cur.length && isListLine(cur[0]);

      // Fenced code: everything up to the closing fence is one block.
      const fence = !inList || !/^\s{2,}/.test(line) ? line.match(RE.fence) : null;
      if (fence && !(fence[2][0] === '`' && fence[3].includes('`'))) {
        flush();
        const marker = fence[2];
        const close = new RegExp('^ {0,3}' + (marker[0] === '`' ? '`' : '~') + '{' + marker.length + ',}\\s*$');
        const buf = [line];
        i++;
        while (i < lines.length) {
          buf.push(lines[i]);
          i++;
          if (close.test(buf[buf.length - 1])) break;
        }
        blocks.push(buf.join('\n'));
        continue;
      }

      // Display math: $$ ... $$
      if (RE.mathOpen.test(line) && !inList) {
        flush();
        const buf = [line];
        i++;
        const t = line.trim();
        const single = t.length > 4 && t.endsWith('$$');
        if (!single) {
          while (i < lines.length) {
            buf.push(lines[i]);
            i++;
            if (/\$\$\s*$/.test(buf[buf.length - 1])) break;
          }
        }
        blocks.push(buf.join('\n'));
        continue;
      }

      if (RE.blank.test(line)) {
        flush();
        i++;
        continue;
      }

      // Headings and rules are always blocks of their own.
      if (RE.heading.test(line) || (RE.hr.test(line) && !inList)) {
        flush();
        blocks.push(line);
        i++;
        continue;
      }

      cur.push(line);
      i++;
    }
    flush();
    return blocks;
  }

  // ---------------------------------------------------- document context

  /** Collect link reference and footnote definitions from the whole doc. */
  function buildContext(blocks, extra) {
    const ctx = Object.assign({ links: {}, footnotes: {}, footnoteOrder: [], slugs: {}, bib: null }, extra || {});
    blocks.forEach((b) => {
      b.split('\n').forEach((line) => {
        let m = line.match(RE.footnoteDef);
        if (m) {
          ctx.footnotes[m[1]] = m[2];
          return;
        }
        m = line.match(RE.linkDef);
        if (m) ctx.links[m[1].toLowerCase()] = { url: m[2], title: m[3] || '' };
      });
      const refs = b.match(/\[\^([^\]\s]+)\](?!:)/g) || [];
      refs.forEach((r) => {
        const id = r.slice(2, -1);
        if (!ctx.footnoteOrder.includes(id)) ctx.footnoteOrder.push(id);
      });
    });
    return ctx;
  }

  // ------------------------------------------------------- block rendering

  function renderBlock(src, ctx, opts) {
    ctx = ctx || buildContext([src]);
    opts = opts || {};
    src = String(src).replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
    if (opts.first && /^---\n[\s\S]*\n(---|\.\.\.)\s*$/.test(src)) {
      return renderFrontMatter(src, ctx);
    }
    return parseBlocks(src.split('\n'), ctx, false);
  }

  function renderFrontMatter(src, ctx) {
    const body = src.split('\n').slice(1, -1);
    const rows = [];
    let simple = true;
    body.forEach((line) => {
      const m = line.match(/^([\w][\w -]*):\s*(.*)$/);
      if (m) rows.push([m[1], m[2].replace(/^["']|["']$/g, '')]);
      else if (line.trim() && rows.length) rows[rows.length - 1][1] += ' ' + line.trim();
      else if (line.trim()) simple = false;
    });
    if (!simple || !rows.length) {
      return '<pre class="front-matter"><code>' + escapeHtml(body.join('\n')) + '</code></pre>';
    }
    return (
      '<div class="front-matter"><table>' +
      rows
        .map((r) => '<tr><th>' + escapeHtml(r[0]) + '</th><td>' + inline(r[1], ctx) + '</td></tr>')
        .join('') +
      '</table></div>'
    );
  }

  function parseBlocks(lines, ctx, tight) {
    let out = '';
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      let m;

      if (RE.blank.test(line)) {
        i++;
        continue;
      }

      // fenced code
      m = line.match(RE.fence);
      if (m && !(m[2][0] === '`' && m[3].includes('`'))) {
        const indent = m[1].length;
        const marker = m[2];
        const lang = (m[3] || '').trim().split(/\s+/)[0].replace(/^\{\.?|\}$/g, '');
        const close = new RegExp('^ {0,3}' + (marker[0] === '`' ? '`' : '~') + '{' + marker.length + ',}\\s*$');
        const buf = [];
        i++;
        while (i < lines.length && !close.test(lines[i])) {
          buf.push(indent ? lines[i].replace(new RegExp('^ {0,' + indent + '}'), '') : lines[i]);
          i++;
        }
        i++;
        out += renderCode(buf.join('\n'), lang);
        continue;
      }

      // display math
      if (RE.mathOpen.test(line)) {
        const buf = [];
        let first = line.replace(/^ {0,3}\$\$/, '');
        const t = line.trim();
        if (t.length > 4 && t.endsWith('$$')) {
          buf.push(first.replace(/\$\$\s*$/, ''));
          i++;
        } else {
          if (first.trim()) buf.push(first);
          i++;
          while (i < lines.length) {
            const l = lines[i];
            i++;
            if (/\$\$\s*$/.test(l)) {
              const rest = l.replace(/\$\$\s*$/, '');
              if (rest.trim()) buf.push(rest);
              break;
            }
            buf.push(l);
          }
        }
        const tex = buf.join('\n').trim();
        out += '<div class="math-block" data-tex="' + escapeHtml(tex) + '">' + escapeHtml(tex) + '</div>';
        continue;
      }

      // heading
      m = line.match(RE.heading);
      if (m) {
        const level = m[1].length;
        const text = m[2] || '';
        out += '<h' + level + ' id="' + escapeHtml(slugify(text, ctx)) + '">' + inline(text, ctx) + '</h' + level + '>';
        i++;
        continue;
      }

      // horizontal rule
      if (RE.hr.test(line)) {
        out += '<hr>';
        i++;
        continue;
      }

      // blockquote / callout
      if (RE.quote.test(line)) {
        const buf = [];
        while (i < lines.length && !RE.blank.test(lines[i])) {
          if (RE.quote.test(lines[i])) buf.push(lines[i].replace(/^ {0,3}> ?/, ''));
          else if (buf.length && !startsBlock(lines[i])) buf.push(lines[i]); // lazy continuation
          else break;
          i++;
        }
        const call = buf[0] && buf[0].match(/^\[!(\w+)\][+-]?\s*(.*)$/);
        if (call) {
          const kind = call[1].toLowerCase();
          const title = call[2] || kind.charAt(0).toUpperCase() + kind.slice(1);
          out +=
            '<div class="callout callout-' + escapeHtml(kind) + '"><div class="callout-title">' +
            inline(title, ctx) + '</div>' + parseBlocks(buf.slice(1), ctx, false) + '</div>';
        } else {
          out += '<blockquote>' + parseBlocks(buf, ctx, false) + '</blockquote>';
        }
        continue;
      }

      // list
      if (isListLine(line)) {
        const res = parseList(lines, i, ctx);
        out += res.html;
        i = res.next;
        continue;
      }

      // table
      if (line.includes('|') && i + 1 < lines.length && RE.tableDelim.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        const res = parseTable(lines, i, ctx);
        out += res.html;
        i = res.next;
        continue;
      }

      // footnote definition
      m = line.match(RE.footnoteDef);
      if (m) {
        const id = m[1];
        const buf = [m[2]];
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i])) {
          buf.push(lines[i].trim());
          i++;
        }
        const num = ctx.footnoteOrder.indexOf(id) + 1 || id;
        out +=
          '<div class="footnote-def" id="fn-' + escapeHtml(id) + '"><span class="fn-label">' + escapeHtml(String(num)) +
          '</span><div class="fn-body">' + inline(buf.join('\n'), ctx) + '</div></div>';
        continue;
      }

      // link reference definition (shown faintly, like Typora)
      m = line.match(RE.linkDef);
      if (m) {
        out +=
          '<div class="link-def"><span>[' + escapeHtml(m[1]) + ']:</span> <a href="' +
          escapeHtml(safeUrl(m[2])) + '">' + escapeHtml(m[2]) + '</a></div>';
        i++;
        continue;
      }

      // paragraph
      const buf = [line];
      i++;
      while (i < lines.length && !RE.blank.test(lines[i]) && !startsBlock(lines[i], lines[i + 1])) {
        buf.push(lines[i]);
        i++;
      }
      const html = inline(buf.join('\n'), ctx);
      out += tight ? html : '<p>' + html + '</p>';
    }
    return out;
  }

  function renderCode(code, lang) {
    const cls = lang ? ' class="language-' + escapeHtml(lang) + '"' : '';
    const label = lang ? '<span class="code-lang">' + escapeHtml(lang) + '</span>' : '';
    return '<pre class="code-block" data-lang="' + escapeHtml(lang || '') + '">' + label + '<code' + cls + '>' + escapeHtml(code) + '</code></pre>';
  }

  function parseList(lines, i, ctx) {
    const first = lines[i].match(RE.list);
    const base = first[1].length;
    const ordered = /\d/.test(first[2]);
    const start = ordered ? parseInt(first[2], 10) : 1;
    const items = [];
    let item = null;
    let loose = false;

    while (i < lines.length) {
      const l = lines[i];
      const m = isListLine(l) ? l.match(RE.list) : null;
      if (m && m[1].length <= base + 1) {
        if (/\d/.test(m[2]) !== ordered) break;
        const pad = m[3].length > 4 ? 1 : m[3].length || 1;
        item = { lines: [m[4]], indent: m[1].length + m[2].length + pad };
        items.push(item);
        i++;
        continue;
      }
      if (RE.blank.test(l)) {
        const next = lines[i + 1];
        if (next !== undefined && (/^\s{2,}\S/.test(next) || (isListLine(next) && next.match(RE.list)[1].length <= base + 1))) {
          loose = true;
          item.lines.push('');
          i++;
          continue;
        }
        break;
      }
      const ind = l.match(/^ */)[0].length;
      if (ind > base) {
        item.lines.push(l.slice(Math.min(ind, item.indent)));
        i++;
        continue;
      }
      if (!startsBlock(l)) {
        item.lines.push(l); // lazy continuation
        i++;
        continue;
      }
      break;
    }

    const tag = ordered ? 'ol' : 'ul';
    let html = '<' + tag + (ordered && start !== 1 ? ' start="' + start + '"' : '') + '>';
    items.forEach((it) => {
      let ls = it.lines;
      let task = null;
      const tm = ls[0].match(/^\[([ xX])\](?:\s+|$)(.*)$/);
      if (tm) {
        task = tm[1] !== ' ';
        ls = [tm[2]].concat(ls.slice(1));
      }
      const itemLoose = loose && ls.some((x) => x === '');
      const body = parseBlocks(ls, ctx, !itemLoose);
      if (task === null) {
        html += '<li>' + body + '</li>';
      } else {
        html +=
          '<li class="task' + (task ? ' done' : '') + '"><input type="checkbox" class="task-box"' +
          (task ? ' checked' : '') + '> ' + body + '</li>';
      }
    });
    html += '</' + tag + '>';
    return { html: html, next: i };
  }

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const cells = [];
    let cur = '';
    let inCode = false;
    for (let k = 0; k < s.length; k++) {
      const c = s[k];
      if (c === '\\' && s[k + 1] === '|') {
        cur += '|';
        k++;
        continue;
      }
      if (c === '`') inCode = !inCode;
      if (c === '|' && !inCode) {
        cells.push(cur.trim());
        cur = '';
        continue;
      }
      cur += c;
    }
    cells.push(cur.trim());
    return cells;
  }

  function parseTable(lines, i, ctx) {
    const head = splitRow(lines[i]);
    const aligns = splitRow(lines[i + 1]).map((c) => {
      const l = c.startsWith(':');
      const r = c.endsWith(':');
      return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
    });
    i += 2;
    const rows = [];
    while (i < lines.length && lines[i].includes('|') && !RE.blank.test(lines[i])) {
      rows.push(splitRow(lines[i]));
      i++;
    }
    const cell = (tag, txt, k) =>
      '<' + tag + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : '') + '>' + inline(txt || '', ctx) + '</' + tag + '>';
    let html = '<div class="table-wrap"><table><thead><tr>' + head.map((h, k) => cell('th', h, k)).join('') + '</tr></thead>';
    if (rows.length) {
      html += '<tbody>' + rows.map((r) => '<tr>' + head.map((_, k) => cell('td', r[k], k)).join('') + '</tr>').join('') + '</tbody>';
    }
    html += '</table></div>';
    return { html: html, next: i };
  }

  // -------------------------------------------------------- inline parsing

  const ALLOWED_TAGS = 'br|sub|sup|mark|u|kbd|small|ins|del|s|b|i|em|strong|cite|q|abbr|span';
  const ATOM = new RegExp(
    [
      '\\\\\\n', // backslash hard break
      '\\\\([!-\\/:-@\\[-`{-~])', // backslash escape
      '(`+)([^`]|[\\s\\S]*?[^`])\\2(?!`)', // code span
      '\\$(?![\\s$])((?:\\\\.|[^$\\n\\\\])+?)(?<!\\s)\\$(?!\\d)', // inline math
      '<((?:https?:\\/\\/|mailto:)[^\\s>]+)>', // autolink
      '<(\\/?)(' + ALLOWED_TAGS + ')\\b[^>]*?(\\/?)>', // allowed inline html
      '<!--[\\s\\S]*?-->', // html comment
    ].join('|'),
    'g'
  );

  function inline(src, ctx) {
    ctx = ctx || { links: {}, footnotes: {}, footnoteOrder: [] };
    const stash = [];
    const put = (html) => '\u0000' + (stash.push(html) - 1) + '\u0000';

    let s = String(src).replace(ATOM, (all, esc, ticks, code, math, auto, slash, tag, selfClose) => {
      if (all === '\\\n') return put('<br>');
      if (esc !== undefined) return put(escapeHtml(esc));
      if (ticks !== undefined) {
        let c = code.replace(/\n/g, ' ');
        if (/^ .*[^ ].* $/.test(c)) c = c.slice(1, -1);
        return put('<code>' + escapeHtml(c) + '</code>');
      }
      if (math !== undefined) {
        return put('<span class="math-inline" data-tex="' + escapeHtml(math) + '">' + escapeHtml(math) + '</span>');
      }
      if (auto !== undefined) {
        const u = safeUrl(auto);
        return put('<a href="' + escapeHtml(u) + '">' + escapeHtml(auto.replace(/^mailto:/, '')) + '</a>');
      }
      if (tag !== undefined) return put('<' + slash + tag.toLowerCase() + (selfClose ? ' /' : '') + '>');
      return put(''); // comment
    });

    s = escapeHtml(s);

    // images
    s = s.replace(/!\[([^\]]*)\]\(\s*(?:&lt;)?([^\s)]*?)(?:&gt;)?(?:\s+&quot;([^"]*?)&quot;)?\s*\)/g, (_, alt, url, title) =>
      put(
        '<img src="' + safeUrl(url) + '" alt="' + alt + '"' + (title ? ' title="' + title + '"' : '') + ' loading="lazy">'
      )
    );

    // inline links
    s = s.replace(/\[((?:[^\[\]]|\[[^\[\]]*\])+)\]\(\s*(?:&lt;)?([^\s)]*?)(?:&gt;)?(?:\s+&quot;([^"]*?)&quot;)?\s*\)/g, (_, label, url, title) =>
      put(
        '<a href="' + safeUrl(url) + '"' + (title ? ' title="' + title + '"' : '') + '>' + emphasis(label) + '</a>'
      )
    );

    // footnote references
    s = s.replace(/\[\^([^\]\s]+)\]/g, (all, id) => {
      const num = ctx.footnoteOrder.indexOf(id) + 1 || id;
      const def = ctx.footnotes[id];
      return put(
        '<sup class="fn-ref"><a href="#fn-' + escapeHtml(id) + '"' + (def ? ' title="' + escapeHtml(def) + '"' : '') + '>' +
          escapeHtml(String(num)) + '</a></sup>'
      );
    });

    // pandoc citations: [@key], [see @key, p. 4; @other]
    s = s.replace(/\[((?:[^\[\]]*?[\s;])?-?@\w[^\[\]]*)\]/g, (all, body) => put(renderCitation(body, ctx)));

    // in-text citations: @key says...  (only with a bibliography loaded)
    if (ctx.bib) {
      s = s.replace(/(^|[\s(])(-?)@([A-Za-z][\w:.#$%&+?~\/-]*\w)/g, (all, pre, minus, key) => {
        const html = renderInTextCitation(key, minus === '-', ctx);
        return html ? pre + put(html) : all;
      });
    }

    // reference links: [text][id], [text][], [text]
    s = s.replace(/\[((?:[^\[\]]|\[[^\[\]]*\])+)\](?:\[([^\]]*)\])?/g, (all, label, ref) => {
      const key = (ref || label).toLowerCase();
      const def = ctx.links[key];
      if (!def) return all;
      return put(
        '<a href="' + escapeHtml(safeUrl(def.url)) + '"' + (def.title ? ' title="' + escapeHtml(def.title) + '"' : '') + '>' +
          emphasis(label) + '</a>'
      );
    });

    // bare urls
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<\u0000]*[^\s<\u0000.,;:!?)\]'"])/g, (_, pre, url) =>
      pre + put('<a href="' + url + '">' + url + '</a>')
    );

    s = emphasis(s);

    // hard line breaks
    s = s.replace(/ {2,}\n/g, '<br>\n');

    // restore stashed html (may be nested)
    let guard = 0;
    while (/\u0000\d+\u0000/.test(s) && guard++ < 10) {
      s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => stash[+n]);
    }
    return s;
  }

  const Bib = root.Bib || (typeof require === 'function' ? require('./bib.js') : null);
  // Typical generated citation keys: smith2020, smithJones2020a, smith_2020_title
  const CITEKEY_LIKE = /^[A-Za-z][A-Za-z_-]*_?\d{4}[a-z]?(?:[_:-]\w+)?$/;

  function citeKeysOf(body) {
    return (body.match(/(?<![\w])@\w[\w:.#$%&+?~\/-]*/g) || []).map((k) => k.slice(1).replace(/[.:]+$/, ''));
  }

  function citeSpan(cls, keys, missing, inner) {
    return (
      '<span class="' + cls + (missing.length ? ' missing' : '') + '" data-keys="' + escapeHtml(keys.join(',')) + '"' +
      (missing.length ? ' data-missing="' + escapeHtml(missing.join(',')) + '"' : '') + '>' + inner + '</span>'
    );
  }

  /** [see @doe99, p. 4; @roe02] -> (see Doe 1999, p. 4; Roe 2002) when a bibliography is loaded. */
  function renderCitation(body, ctx) {
    const lib = ctx.bib;
    const items = Bib ? Bib.parseCitation(body) : [];
    if (!lib || !items.length) {
      return citeSpan('cite', citeKeysOf(body), [], '[' + emphasis(body) + ']');
    }
    const missing = [];
    const parts = items.map((it) => {
      const lab = lib.labels[it.key];
      let ref;
      if (!lab) {
        missing.push(it.key);
        ref = '<span class="cite-key">@' + it.key + '</span>';
      } else {
        ref = escapeHtml(it.suppress ? lab.year : lab.author + ' ' + lab.year);
      }
      return (it.prefix ? emphasis(it.prefix) + ' ' : '') + ref + (it.suffix ? ', ' + emphasis(it.suffix) : '');
    });
    return citeSpan('cite resolved', items.map((it) => it.key), missing, '(' + parts.join('; ') + ')');
  }

  /** @doe99 says -> Doe (1999) says. Unknown keys are flagged only if they look like citation keys. */
  function renderInTextCitation(key, suppress, ctx) {
    const lib = ctx.bib;
    const clean = key.replace(/[.:]+$/, '');
    const lab = lib.labels[clean];
    if (!lab) {
      if (!CITEKEY_LIKE.test(clean)) return null;
      return citeSpan('cite resolved in-text', [clean], [clean], '<span class="cite-key">@' + escapeHtml(clean) + '</span>');
    }
    const text = suppress ? lab.year : lab.author + ' (' + lab.year + ')';
    return citeSpan('cite resolved in-text', [clean], [], escapeHtml(text));
  }

  function emphasis(s) {
    return s
      .replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
      .replace(/(^|[^\w*])\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/(^|[^\w*])\*(?=[^\s*])([^*])\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/(^|[^\w])_(?=[^\s_])([\s\S]*?[^\s_]|[^\s_])_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
      .replace(/==(?=\S)([\s\S]*?\S)==/g, '<mark>$1</mark>')
      .replace(/(^|[^~])~(?=[^\s~])([^\s~]+)~(?!~)/g, '$1<sub>$2</sub>')
      .replace(/\^(?=[^\s^])([^\s^]+)\^/g, '<sup>$1</sup>');
  }

  // ------------------------------------------------------------- utilities

  /** Plain text of a block's markdown, for word counts and outlines. */
  function plainText(src) {
    return String(src)
      .replace(/^```[\s\S]*?^```/gm, ' ')
      .replace(/\$\$[\s\S]*?\$\$/g, ' ')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^ {0,3}(#{1,6}|>|[-+*]|\d+[.)])\s+/gm, '')
      .replace(/[*_~=`|#>]/g, ' ');
  }

  function headingOf(src) {
    const m = String(src).match(RE.heading);
    if (!m || src.includes('\n')) return null;
    const tmp = document.createElement('div');
    tmp.innerHTML = inline(m[2] || '', null);
    return { level: m[1].length, text: tmp.textContent };
  }

  /** Render a whole document to HTML (used for export). */
  function renderDocument(src, extra) {
    const blocks = splitBlocks(src);
    const ctx = buildContext(blocks, extra);
    return blocks.map((b, k) => renderBlock(b, ctx, { first: k === 0 })).join('\n');
  }

  /** Values of `bibliography:` in YAML front matter (string or list). */
  function frontMatterBibliography(src) {
    const m = String(src).match(/^---\n([\s\S]*?)\n(?:---|\.\.\.)\s*(\n|$)/);
    if (!m) return [];
    const lines = m[1].split('\n');
    const out = [];
    for (let k = 0; k < lines.length; k++) {
      const b = lines[k].match(/^bibliography:\s*(.*)$/);
      if (!b) continue;
      const v = b[1].trim();
      if (v.startsWith('[')) v.slice(1, -1).split(',').forEach((x) => out.push(x));
      else if (v) out.push(v);
      else while (k + 1 < lines.length && /^\s*-\s+/.test(lines[k + 1])) out.push(lines[++k].replace(/^\s*-\s+/, ''));
    }
    return out.map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }

  const MD = {
    splitBlocks,
    buildContext,
    renderBlock,
    renderDocument,
    frontMatterBibliography,
    inline,
    escapeHtml,
    plainText,
    headingOf,
    slugify,
    RE,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MD;
  else root.MD = MD;
})(typeof window !== 'undefined' ? window : this);
