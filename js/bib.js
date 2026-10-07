/*
 * MDreader bibliography support.
 *
 * Parses BibTeX / BibLaTeX (as exported by Zotero, Better BibTeX, JabRef,
 * Google Scholar...) and formats pandoc citations in author-date style:
 *
 *   [@fearon1995]                 -> (Fearon 1995)
 *   [see @doe2001, p. 4; @roe02]  -> (see Doe 2001, p. 4; Roe 2002)
 *   [-@fearon1995]                -> (1995)
 *   @fearon1995 argues            -> Fearon (1995) argues
 *
 * Keys missing from the bibliography are reported so that citations an AI
 * invented stand out.
 *
 * Classic script (no modules) so it runs from file:// and in Node tests.
 */
(function (root) {
  'use strict';

  // ------------------------------------------------------------- parsing

  const ACCENTS = {
    '`': { a: 'à', e: 'è', i: 'ì', o: 'ò', u: 'ù', A: 'À', E: 'È', I: 'Ì', O: 'Ò', U: 'Ù' },
    "'": { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', y: 'ý', c: 'ć', n: 'ń', s: 'ś', z: 'ź', A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú', C: 'Ć', S: 'Ś', Z: 'Ź' },
    '^': { a: 'â', e: 'ê', i: 'î', o: 'ô', u: 'û', A: 'Â', E: 'Ê', I: 'Î', O: 'Ô', U: 'Û' },
    '"': { a: 'ä', e: 'ë', i: 'ï', o: 'ö', u: 'ü', y: 'ÿ', A: 'Ä', E: 'Ë', I: 'Ï', O: 'Ö', U: 'Ü' },
    '~': { a: 'ã', n: 'ñ', o: 'õ', A: 'Ã', N: 'Ñ', O: 'Õ' },
    c: { c: 'ç', C: 'Ç', s: 'ş', S: 'Ş' },
    v: { c: 'č', s: 'š', z: 'ž', r: 'ř', e: 'ě', C: 'Č', S: 'Š', Z: 'Ž', R: 'Ř' },
    u: { a: 'ă', g: 'ğ', A: 'Ă', G: 'Ğ' },
    '=': { a: 'ā', e: 'ē', o: 'ō', u: 'ū' },
    '.': { z: 'ż', Z: 'Ż', I: 'İ' },
    H: { o: 'ő', u: 'ű', O: 'Ő', U: 'Ű' },
    k: { a: 'ą', e: 'ę', A: 'Ą', E: 'Ę' },
  };
  const SYMBOLS = { ss: 'ß', o: 'ø', O: 'Ø', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', aa: 'å', AA: 'Å', l: 'ł', L: 'Ł', i: 'ı', dh: 'ð', th: 'þ' };

  /** Turn common LaTeX markup in a field into plain Unicode text. */
  function cleanLatex(s) {
    let t = String(s);
    // accents: \"{o}  \"o  {\"o}  \'{\i}
    t = t.replace(/\\([`'^"~=.]|[cvuHk](?=[\s{]))\s*\{?\\?([a-zA-Z])\}?/g, (all, acc, ch) => (ACCENTS[acc] && ACCENTS[acc][ch]) || ch);
    t = t.replace(/\\(ss|ae|AE|oe|OE|aa|AA|o|O|l|L|i|dh|th)(?![a-zA-Z])\s?/g, (all, sym) => SYMBOLS[sym] || all);
    t = t.replace(/\\(textit|emph|textbf|textsc|textup|textrm|mkbibquote|enquote|url|texttt)\s*\{([^{}]*)\}/g, '$2');
    t = t.replace(/\\([&%$#_{}])/g, '$1');
    t = t.replace(/\\textendash\b\s?|---?/g, (m) => (m === '---' ? '—' : '–'));
    t = t.replace(/\\textemdash\b\s?/g, '—');
    t = t.replace(/``|''/g, '"');
    t = t.replace(/~/g, ' ');
    t = t.replace(/\\[a-zA-Z]+\s*/g, ''); // any other command
    t = t.replace(/[{}]/g, '');
    return t.replace(/\s+/g, ' ').trim();
  }

  /**
   * Parse a .bib file. Returns { entries: { key: entry }, keys: [...], errors: [...] }
   * where entry = { key, type, fields: { lowercased name: cleaned value } }.
   */
  function parse(text) {
    const src = String(text || '');
    const strings = { jan: 'January', feb: 'February', mar: 'March', apr: 'April', may: 'May', jun: 'June', jul: 'July', aug: 'August', sep: 'September', oct: 'October', nov: 'November', dec: 'December' };
    const entries = {};
    const keys = [];
    const errors = [];
    let i = 0;

    const skipWs = () => {
      while (i < src.length) {
        if (/\s/.test(src[i])) i++;
        else if (src[i] === '%') while (i < src.length && src[i] !== '\n') i++;
        else break;
      }
    };
    const readBraced = () => {
      // assumes src[i] === '{'; returns inner text
      let depth = 0;
      const start = i + 1;
      for (; i < src.length; i++) {
        if (src[i] === '\\') {
          i++;
          continue;
        }
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
          depth--;
          if (depth === 0) {
            i++;
            return src.slice(start, i - 1);
          }
        }
      }
      throw new Error('unbalanced braces');
    };
    const readQuoted = () => {
      let depth = 0;
      const start = ++i;
      for (; i < src.length; i++) {
        const c = src[i];
        if (c === '\\') {
          i++;
          continue;
        }
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === '"' && depth === 0) {
          i++;
          return src.slice(start, i - 1);
        }
      }
      throw new Error('unterminated string');
    };
    const readValue = () => {
      // value = part (# part)*
      let out = '';
      for (;;) {
        skipWs();
        const c = src[i];
        if (c === '{') out += readBraced();
        else if (c === '"') out += readQuoted();
        else {
          const m = /^[^\s,#})]+/.exec(src.slice(i, i + 200));
          if (!m) break;
          i += m[0].length;
          const word = m[0];
          out += /^\d+$/.test(word) ? word : strings[word.toLowerCase()] !== undefined ? strings[word.toLowerCase()] : word;
        }
        skipWs();
        if (src[i] === '#') {
          i++;
          continue;
        }
        break;
      }
      return out;
    };

    while (i < src.length) {
      const at = src.indexOf('@', i);
      if (at < 0) break;
      i = at + 1;
      const tm = /^([a-zA-Z]+)\s*([{(])/.exec(src.slice(i, i + 64));
      if (!tm) continue;
      const type = tm[1].toLowerCase();
      i += tm[0].length;
      const close = tm[2] === '{' ? '}' : ')';
      try {
        if (type === 'comment' || type === 'preamble') {
          i -= 1;
          if (src[i] === '{') readBraced();
          continue;
        }
        if (type === 'string') {
          skipWs();
          const nm = /^[^\s=]+/.exec(src.slice(i));
          i += nm[0].length;
          skipWs();
          i++; // =
          strings[nm[0].toLowerCase()] = readValue();
          skipWs();
          if (src[i] === close) i++;
          continue;
        }
        skipWs();
        const km = /^[^\s,]+/.exec(src.slice(i));
        if (!km) throw new Error('missing key');
        const key = km[0];
        i += key.length;
        const fields = {};
        for (;;) {
          skipWs();
          if (src[i] === ',') i++;
          skipWs();
          if (src[i] === close || i >= src.length) {
            i++;
            break;
          }
          const fm = /^[^\s=,{}()]+/.exec(src.slice(i));
          if (!fm) throw new Error('bad field in ' + key);
          i += fm[0].length;
          skipWs();
          if (src[i] !== '=') throw new Error('expected = after ' + fm[0] + ' in ' + key);
          i++;
          fields[fm[0].toLowerCase()] = readValue();
        }
        if (!entries[key]) keys.push(key);
        entries[key] = { key, type, fields };
      } catch (e) {
        errors.push(e.message);
      }
    }

    // clean after parsing so @string values are substituted first
    keys.forEach((k) => {
      const f = entries[k].fields;
      Object.keys(f).forEach((name) => {
        if (name === 'url' || name === 'doi' || name === 'file') f[name] = f[name].replace(/[{}]/g, '').trim();
        else f[name] = cleanLatex(f[name]);
      });
    });
    return { entries, keys, errors };
  }

  // -------------------------------------------------------------- names

  /** Split an author/editor field into [{ last, first }]. */
  function parseNames(field) {
    if (!field) return [];
    return field
      .split(/\s+and\s+/i)
      .map((n) => n.trim())
      .filter(Boolean)
      .map((n) => {
        if (/^others$/i.test(n)) return { last: 'others', first: '', others: true };
        if (n.includes(',')) {
          const parts = n.split(',').map((p) => p.trim());
          // "von Last, Jr, First" or "Last, First"
          return { last: parts[0], first: parts.length > 2 ? parts[2] : parts[1] || '' };
        }
        const words = n.split(/\s+/);
        if (words.length === 1) return { last: words[0], first: '' };
        // keep lowercase particles with the last name: "Ludwig van Beethoven"
        let k = words.length - 1;
        while (k > 0 && /^[a-z]/.test(words[k - 1])) k--;
        return { last: words.slice(k).join(' '), first: words.slice(0, k).join(' ') };
      });
  }

  function namesOf(entry) {
    const f = entry.fields;
    return parseNames(f.author || f.editor || '');
  }

  /** "Fearon", "Fearon and Laitin", "Fearon et al." */
  function shortAuthor(entry) {
    const names = namesOf(entry);
    if (!names.length) {
      const t = entry.fields.title || entry.key;
      return t.length > 40 ? t.slice(0, 37) + '…' : t;
    }
    if (names.length === 1) return names[0].last;
    if (names.length === 2 && !names[1].others) return names[0].last + ' and ' + names[1].last;
    return names[0].last + ' et al.';
  }

  function yearOf(entry) {
    const f = entry.fields;
    const y = f.year || (f.date || '').slice(0, 4) || 'n.d.';
    return y;
  }

  // -------------------------------------------------------------- library

  /**
   * Build a library object: parse result plus derived author-date labels,
   * with 2001a / 2001b suffixes where authors and years collide.
   */
  function library(parsed, source) {
    const lib = { entries: parsed.entries, keys: parsed.keys, errors: parsed.errors, source: source || '', labels: {} };
    const groups = {};
    parsed.keys.forEach((k) => {
      const e = parsed.entries[k];
      const id = shortAuthor(e) + '|' + yearOf(e);
      (groups[id] = groups[id] || []).push(e);
    });
    Object.keys(groups).forEach((id) => {
      const g = groups[id].slice().sort((a, b) => (a.fields.title || '').localeCompare(b.fields.title || ''));
      g.forEach((e, n) => {
        lib.labels[e.key] = { author: shortAuthor(e), year: yearOf(e) + (g.length > 1 && /^\d{4}$/.test(yearOf(e)) ? String.fromCharCode(97 + n) : '') };
      });
    });
    return lib;
  }

  function merge(libs) {
    const parsed = { entries: {}, keys: [], errors: [] };
    libs.forEach((l) => {
      if (!l) return;
      l.keys.forEach((k) => {
        if (!parsed.entries[k]) parsed.keys.push(k);
        parsed.entries[k] = l.entries[k];
      });
      parsed.errors = parsed.errors.concat(l.errors || []);
    });
    return library(parsed, libs.filter(Boolean).map((l) => l.source).join(', '));
  }

  // ---------------------------------------------------------- formatting

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /**
   * Parse the inside of a bracketed citation into items:
   * "see @doe99, pp. 33-35; also -@smith04" ->
   * [{prefix:'see', key:'doe99', suffix:'pp. 33-35', suppress:false}, ...]
   */
  function parseCitation(body) {
    return String(body)
      .split(';')
      .map((part) => {
        const m = part.match(/^(.*?)(-?)@([\w][\w:.#$%&+?<>~\/-]*?)([.:]*)(?=$|[\s,;])(.*)$/s);
        if (!m) return null;
        return {
          prefix: m[1].trim(),
          suppress: m[2] === '-',
          key: m[3],
          suffix: m[5].replace(/^\s*,\s*/, '').trim(),
        };
      })
      .filter(Boolean);
  }

  function formatReference(entry) {
    const f = entry.fields;
    const names = namesOf(entry);
    const authorList = names.length
      ? names
          .map((n, k) => (n.others ? 'et al.' : k === 0 ? n.last + (n.first ? ', ' + n.first : '') : (n.first ? n.first + ' ' : '') + n.last))
          .reduce((acc, n, k, arr) => acc + (k === 0 ? '' : k === arr.length - 1 ? (arr.length > 2 ? ', and ' : ' and ') : ', ') + n, '')
      : '';
    const editors = !f.author && f.editor ? ' (ed' + (names.length > 1 ? 's' : '') + '.)' : '';
    const title = f.title || '';
    const container = f.journal || f.journaltitle || f.booktitle || '';
    const bookish = /book|thesis|report|manual|misc/.test(entry.type) && !container;
    let html = '';
    const who = authorList + editors;
    if (who) html += esc(who) + (who.endsWith('.') ? ' ' : '. ');
    html += esc(yearOf(entry)) + '. ';
    html += bookish ? '<em>' + esc(title) + '</em>. ' : '“' + esc(title) + '.” ';
    if (container) {
      html += (entry.type === 'incollection' || entry.type === 'inproceedings' ? 'In ' : '') + '<em>' + esc(container) + '</em>';
      if (f.volume) html += ' ' + esc(f.volume);
      if (f.number || f.issue) html += ' (' + esc(f.number || f.issue) + ')';
      if (f.pages) html += (f.volume ? ': ' : ', ') + esc(f.pages.replace(/-+/g, '–'));
      html += '. ';
    }
    if (bookish || entry.type === 'incollection') {
      const pub = [f.address || f.location, f.publisher || f.institution || f.school].filter(Boolean).join(': ');
      if (pub) html += esc(pub) + '. ';
    }
    if (f.doi) {
      const doi = f.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, '');
      html += '<a href="https://doi.org/' + esc(doi) + '">doi:' + esc(doi) + '</a>';
    } else if (f.url) {
      html += '<a href="' + esc(f.url) + '">' + esc(f.url) + '</a>';
    }
    return html.trim();
  }

  /** Sort keys the way a reference list is ordered. */
  function sortKeys(keys, lib) {
    return keys.slice().sort((a, b) => {
      const ea = lib.entries[a];
      const eb = lib.entries[b];
      const na = (namesOf(ea)[0] || { last: ea.fields.title || a }).last.toLowerCase();
      const nb = (namesOf(eb)[0] || { last: eb.fields.title || b }).last.toLowerCase();
      return na.localeCompare(nb) || lib.labels[a].year.localeCompare(lib.labels[b].year);
    });
  }

  const Bib = {
    parse,
    parseNames,
    cleanLatex,
    library,
    merge,
    shortAuthor,
    yearOf,
    parseCitation,
    formatReference,
    sortKeys,
    fromText: (text, source) => library(parse(text), source),
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Bib;
  else root.Bib = Bib;
})(typeof window !== 'undefined' ? window : this);
