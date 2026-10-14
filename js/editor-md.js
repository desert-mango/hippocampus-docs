// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 14 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Turn one Markdown block into the DOM a person types into, and that DOM back into Markdown, byte-exact.
/* HCEditorMd: the Editor mode converter (editor redesign, plan section 6, unit U1).

   One block of a page (HCCore.splitBlocks) is opened for typing in the page itself. This file owns
   the two directions and the gate between them:

     renderBlock(md)          -> a container element holding the CLEAN render of the block:
                                 marked + js/sanitize.js, and NOT js/app.js's enhance() (no
                                 cross-reference links, heading anchors, copy buttons, tab bars or
                                 table wrappers). The DOM a person types into is always this one.
     serialize(root, md, kind) -> the block's Markdown again, built from the (edited) DOM, in the
                                 ORIGINAL block's style: bullet character, emphasis character,
                                 heading form, fence line, link form, hard-break form and soft line
                                 breaks (hard-wrapped pages keep their wraps). Returns the text with
                                 the original block's trailing newlines, so it drops straight into
                                 HCCore.replaceSpan. Throws an Unsupported error on any node it
                                 cannot write back faithfully.
     editorFor(block)         -> which editor opens the block: 'visual' (type in the page), 'code'
                                 (the code box: fence lines kept, only the inside edited), 'box'
                                 (a note box: its wrapper lines kept, the inside typed), 'image'
                                 (the Media picker) or 'markdown' (the in-place Markdown box with a
                                 live preview). Never 'visual' unless the gate passes.
     gate(md, kind)           -> {ok, reason}: serialize(renderBlock(md)) === md, byte for byte.
                                 A block that does not round-trip opens as the Markdown box, its
                                 bytes untouched. There is no "edit anyway".

   Editor mode's suggestion marks (the Google Docs "Suggesting" look) live only in the typing DOM,
   never in content: they carry data-hc-sug="ins|del|fmt", an attribute js/sanitize.js drops from
   every content file, so content cannot forge one. serialize() keeps inserted text, drops deleted
   text and writes a format mark as the format (fmt + data-hc-fmt="strong|em").

   Runs unchanged in the browser (window.marked, window.HCSanitize, the real DOMParser) and under
   node (require: marked.min.js, sanitize.js; the test installs tools/tests/fixtures/dom_shim.mjs as
   globalThis.DOMParser). It walks nodes through nodeType, localName, childNodes, getAttribute and
   data only, so both DOMs serve.

   Node tests: tools/tests/test_editor_md.mjs (every block of every content page, per-group floors,
   edited blocks with Markdown-special characters, suggestion marks, refusal of an enhanced DOM). */
(function () {
  'use strict';

  const isNode = typeof module !== 'undefined' && module.exports;
  const markedLib = () => (typeof window !== 'undefined' && window.marked) || (isNode ? require('./marked.min.js').marked : null);
  const sanitizer = () => (typeof window !== 'undefined' && window.HCSanitize) || (isNode ? require('./sanitize.js') : null);

  class Unsupported extends Error {
    constructor(why) { super(why); this.name = 'Unsupported'; }
  }
  const no = (why) => { throw new Unsupported(why); };

  // ------------------------------------------------------------- render ---

  /* -> the <body> of an inert document holding the clean render. In the browser the frame moves its
     children into the page (append adopts them). */
  function renderBlock(md) {
    const html = sanitizer().clean(markedLib().parse(String(md)));
    return new DOMParser().parseFromString(html, 'text/html').body;
  }

  // -------------------------------------------------------------- style ---

  const lex = (md) => { try { return markedLib().lexer(String(md)); } catch (e) { return []; } };
  const blockTokens = (md) => lex(md).filter((t) => t.type !== 'space');

  /* The style choices the ORIGINAL block made, read from its tokens. Defaults are the site's house
     style (what content/ mostly uses) for a block typed from nothing. */
  function styleOf(md) {
    const s = { em: '*', strong: '**', del: '~~', br: '\\\n', links: new Map(), images: new Map(), codeSpans: [] };
    const walk = (toks) => {
      for (const t of toks || []) {
        if (!t || typeof t !== 'object') continue;
        if (t.type === 'em' && t.raw) s.em = t.raw[0];
        if (t.type === 'strong' && t.raw) s.strong = t.raw.slice(0, 2);
        if (t.type === 'del' && t.raw) s.del = t.raw.startsWith('~~') ? '~~' : '~';
        if (t.type === 'br' && t.raw) s.br = t.raw;
        if (t.type === 'link' && t.raw) s.links.set(t.href, t.raw);
        if (t.type === 'image' && t.raw) s.images.set(t.href, t.raw);
        if (t.type === 'codespan' && t.raw) s.codeSpans.push(t.raw);
        walk(t.tokens);
        if (t.items) for (const it of t.items) walk(it.tokens);
      }
    };
    walk(lex(md));
    return s;
  }

  // ----------------------------------------------------------- escaping ---

  const LINE_START_RE = /^(#{1,6}(?=\s|$)|>|[-+*](?=\s)|\d{1,9}[.)](?=\s)|=+\s*$|-+\s*$)/;

  /* Escapes a plain text run so marked reads it back as the same text. Minimal on purpose (the gate
     measures fidelity, and an unneeded escape costs a visual block), then CHECKED: the run is parsed
     back with marked's inline parser, and when that would make any markup of it (a ~pair~, a stray
     *emphasis*, a <tag>), every special character is escaped instead; a run that still does not
     read back as itself is refused. Typed text can never silently become formatting. */
  function escapeText(text, atLineStart) {
    const minimal = escapeMinimal(text, atLineStart);
    if (readsBackAs(minimal, text)) return minimal;
    const all = escapeAll(text, atLineStart);
    if (readsBackAs(all, text)) return all;
    return no('text the Markdown parser would read differently');
  }
  const decodeHtml = (h) => h.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  function readsBackAs(md, text) {
    if (!text) return true;
    let html;
    try { html = markedLib().parseInline(md); } catch (e) { return false; }
    // a typed bare URL becomes a link exactly as every bare URL in content/ does (GFM autolink), its
    // text unchanged: the one markup the read-back allows (pinned in test_editor_md.mjs)
    html = html.replace(/<a href="([^"<>]*)">([^<]*)<\/a>/g, (m, href, label) => (decodeHtml(href) === decodeHtml(label) || decodeHtml(href) === `mailto:${decodeHtml(label)}` ? label : m));
    if (/<[a-z/!]/i.test(html)) return false;
    return decodeHtml(html) === text;
  }
  function escapeAll(text, atLineStart) {
    const out = text.replace(/[\\`*_[\]<>&~|!#]/g, '\\$&');
    const fix = (line) => line.replace(/^(\d{1,9})([.)])(?=\s)/, '$1\\$2').replace(/^([-+=])/, '\\$1');
    return out.split('\n').map((l, k) => (k === 0 && !atLineStart ? l : fix(l))).join('\n');
  }
  function escapeMinimal(text, atLineStart) {
    let out = '';
    const n = text.length;
    for (let i = 0; i < n; i++) {
      const c = text[i];
      const prev = i > 0 ? text[i - 1] : '';
      const next = i + 1 < n ? text[i + 1] : '';
      if (c === '\\') { out += /[!-/:-@[-`{-~]/.test(next) || next === '' ? '\\\\' : '\\'; continue; }
      if (c === '`') { out += '\\`'; continue; }
      if (c === '*' || c === '_') {
        let j = i; while (j < n && text[j] === c) j += 1;            // the whole delimiter run
        const before = i > 0 ? text[i - 1] : ' ', after = j < n ? text[j] : ' ';
        const sp = (x) => /\s/.test(x);
        const alnum = (x) => /[A-Za-z0-9]/.test(x);
        // a run with space (or the edge) on both sides is literal; '_' inside a word is literal
        const literal = (sp(before) && sp(after)) || (c === '_' && alnum(before) && alnum(after))
          || (c === '_' && alnum(before) && sp(after) && !/(^|[^A-Za-z0-9\\])_/.test(text.slice(0, i)));
        out += literal ? text.slice(i, j) : text.slice(i, j).replace(/[*_]/g, '\\$&');
        i = j - 1; continue;
      }
      if (c === '[') { out += /\]\s*[([:]/.test(text.slice(i + 1)) || /^\^/.test(next) ? '\\[' : '['; continue; }
      if (c === '<') { out += /[A-Za-z/!?]/.test(next) ? '\\<' : '<'; continue; }
      if (c === '&') { out += /^&(#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/.test(text.slice(i)) ? '\\&' : '&'; continue; }
      if (c === '~') { out += next === '~' || prev === '~' ? '\\~' : '~'; continue; }
      if (c === '|') { out += '|'; continue; }
      out += c;
    }
    // line-start constructs, on the first line (when the run starts a line) and after every newline
    const fix = (line) => {
      if (!LINE_START_RE.test(line)) return line;
      const ord = /^(\d{1,9})([.)])/.exec(line);              // 1. -> 1\.  (the delimiter is what makes a list)
      return ord ? `${ord[1]}\\${line.slice(ord[1].length)}` : `\\${line}`;
    };
    const lines = out.split('\n');
    return lines.map((l, k) => (k === 0 && !atLineStart ? l : fix(l))).join('\n');
  }

  // ------------------------------------------------------------- inline ---

  const tag = (n) => (n && n.nodeType === 1 ? String(n.localName || n.nodeName || '').toLowerCase() : '');
  const attr = (n, a) => (n.getAttribute ? n.getAttribute(a) : null);
  const kids = (n) => Array.from(n.childNodes || []);
  const textOf = (n) => (n.nodeType === 3 ? n.data : kids(n).map(textOf).join(''));
  const ENHANCED = /(^|\s)(xref|heading-anchor|copy-btn|code-wrap|table-wrap|tabbar|hc-[a-z-]+)(\s|$)/;

  function refuseEnhanced(n) {
    const cls = attr(n, 'class') || '';
    if (ENHANCED.test(cls)) no(`an element the page drew after the Markdown (${cls.trim()})`);
    if (tag(n) === 'button' || tag(n) === 'input') no(`a <${tag(n)}> the page drew`);
  }

  function codeSpan(text) {
    const runs = text.match(/`+/g) || [];
    const fence = '`'.repeat(Math.max(0, ...runs.map((r) => r.length)) + 1);
    const pad = /^`|`$/.test(text) || (/^ /.test(text) && /\S/.test(text) && / $/.test(text)) ? ' ' : '';
    return `${fence}${pad}${text}${pad}${fence}`;
  }

  /* -> Markdown for the inline children of n. ctx.lineStart says whether the next character starts
     a line (line-start escaping). */
  function inline(n, st, ctx) {
    let out = '';
    for (const c of kids(n)) {
      if (c.nodeType === 8) continue;
      if (c.nodeType === 3) {
        const t = c.data.replace(/ /g, ' ');
        out += escapeText(t, ctx.lineStart);
        if (t) ctx.lineStart = t.endsWith('\n');
        continue;
      }
      if (c.nodeType !== 1) continue;
      const name = tag(c);
      const sug = attr(c, 'data-hc-sug');                           // the typing engine's own marks (hc-sug class)
      if (!sug) refuseEnhanced(c);
      if (sug === 'del') continue;                                  // a suggested deletion: gone
      if (sug === 'ins') { out += inline(c, st, ctx); continue; }   // a suggested insertion: its text
      if (sug === 'fmt') {
        const f = attr(c, 'data-hc-fmt') === 'em' ? st.em : st.strong;
        const body = inline(c, st, ctx);
        out += body.trim() ? `${f}${body}${f}` : body;
        continue;
      }
      if (sug) no(`an unknown suggestion mark (${sug})`);
      ctx.lineStart = false;
      if (name === 'em' || name === 'i') out += `${st.em}${inline(c, st, ctx)}${st.em}`;
      else if (name === 'strong' || name === 'b') out += `${st.strong}${inline(c, st, ctx)}${st.strong}`;
      else if (name === 'del' || name === 's') out += `${st.del}${inline(c, st, ctx)}${st.del}`;
      else if (name === 'code') out += codeSpan(textOf(c));
      else if (name === 'br') { out += st.br.endsWith('\n') ? st.br : `${st.br}\n`; ctx.lineStart = true; }
      else if (name === 'a') out += link(c, st, ctx);
      else if (name === 'img') out += image(c, st);
      else if (name === 'span' && !attr(c, 'class') && !attr(c, 'id') && !attr(c, 'title')) out += inline(c, st, ctx);
      else no(`inline <${name}> (written as HTML in the Markdown)`);
    }
    return out;
  }

  const titlePart = (t) => (t ? ` "${t.replace(/"/g, '\\"')}"` : '');
  function link(a, st, ctx) {
    const href = attr(a, 'href');
    if (href === null) no('a link with no address');
    const raw = st.links.get(href);
    const text = textOf(a);
    const simple = kids(a).every((k) => k.nodeType === 3);
    if (raw && simple) {
      if (raw === `<${href}>` && text === href) return raw;                     // <https://…>
      if (raw === href && text === href) return raw;                             // a bare URL
      if (/^\[[^\]]*\]\[[^\]]*\]$|^\[[^\]]*\]$/.test(raw)) no('a reference-style link');
    }
    if (!raw && simple && text === href && /^https?:\/\//.test(href)) return href; // typed URL
    const label = inline(a, st, ctx);
    return `[${label}](${/[\s()<>]/.test(href) ? `<${href}>` : href}${titlePart(attr(a, 'title'))})`;
  }
  function image(img, st) {
    const src = attr(img, 'src');
    if (src === null) no('an image with no address');
    const raw = st.images.get(src);
    const alt = attr(img, 'alt') || '';
    if (attr(img, 'width') || attr(img, 'height') || attr(img, 'loading')) no('an image written as HTML');
    const made = `![${alt.replace(/([[\]\\])/g, '\\$1')}](${src}${titlePart(attr(img, 'title'))})`;
    return raw && raw.startsWith('![') && !raw.includes('][') ? (raw === made ? raw : made) : made;
  }

  // -------------------------------------------------------------- blocks ---

  const isBlank = (n) => n.nodeType === 8 || (n.nodeType === 3 && !/\S/.test(n.data.replace(/ /g, ' x')));
  const elems = (n) => kids(n).filter((k) => !isBlank(k));

  /* One top-level DOM element + the original token it came from -> Markdown (no trailing newline). */
  function block(el, tok, st) {
    if (el.nodeType === 3) no('loose text between blocks');
    refuseEnhanced(el);
    const name = tag(el);
    const raw = tok && tok.raw ? tok.raw.replace(/\n+$/, '') : '';
    if (name === 'p') return inline(el, st, { lineStart: true });
    if (/^h[1-6]$/.test(name)) {
      const depth = Number(name[1]);
      const body = inline(el, st, { lineStart: false });
      if (/\n/.test(body)) no('a heading on two lines');
      if (tok && tok.type === 'heading' && !/^#/.test(raw)) {                    // setext: Title\n=====
        const under = raw.split('\n').pop();
        if (depth > 2) no('a setext heading deeper than 2');
        const ch = depth === 1 ? '=' : '-';
        return `${body}\n${under && under[0] === ch ? under : ch.repeat(Math.max(3, body.length))}`;
      }
      const close = tok && tok.type === 'heading' ? (/(\s+#+)\s*$/.exec(raw) || [])[1] || '' : '';
      return `${'#'.repeat(depth)} ${body}${close}`;
    }
    if (name === 'pre') return codeBlock(el, tok);
    if (name === 'ul' || name === 'ol') return list(el, tok, st, '');
    if (name === 'blockquote') {
      const inner = elems(el).map((c, i) => block(c, tok && tok.tokens ? tok.tokens.filter((t) => t.type !== 'space')[i] : null, st)).join('\n\n');
      return inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
    }
    if (name === 'hr') return tok && tok.type === 'hr' ? raw : '---';
    no(`a <${name}> block`);
    return '';
  }

  function codeBlock(pre, tok) {
    const code = elems(pre);
    if (code.length !== 1 || tag(code[0]) !== 'code') no('a <pre> without one <code> inside');
    let text = textOf(code[0]).replace(/ /g, ' ');
    if (text.endsWith('\n')) text = text.slice(0, -1);
    const raw = tok && tok.type === 'code' ? tok.raw.replace(/\n+$/, '') : '';
    const lines = raw.split('\n');
    if (raw && /^ {0,3}(`{3,}|~{3,})/.test(lines[0])) {
      const open = lines[0];
      const fence = /^ {0,3}(`{3,}|~{3,})/.exec(open)[1];
      const last = lines[lines.length - 1];
      const close = lines.length > 1 && new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(last) ? last : '';
      if (!close) no('a code block whose fence never closes');
      if (text.split('\n').some((l) => new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(l))) no('code that contains its own fence line');
      const ind = (/^ */.exec(open) || [''])[0];
      const body = text.split('\n').map((l) => (l ? ind + l : l)).join('\n');
      return text === '' && lines.length === 2 ? `${open}\n${close}` : `${open}\n${body}\n${close}`;
    }
    if (raw && /^( {4}|\t)/.test(lines[0])) return text.split('\n').map((l) => (l ? `    ${l}` : l)).join('\n');
    const cls = (attr(code[0], 'class') || '').replace(/^language-/, '');
    const fence = '```';
    return `${fence}${cls}\n${text}\n${fence}`;
  }

  /* A list: marker style from the original list token; nested lists indent by the item's content
     width; tight items join with one newline, loose with a blank line. */
  function list(el, tok, st, indent) {
    const ordered = tag(el) === 'ol';
    const toks = tok && tok.type === 'list' ? tok.items : [];
    const rawFirst = toks[0] ? toks[0].raw : '';
    const bullet = ordered ? null : ((/^\s*([-*+])\s/.exec(rawFirst) || [])[1] || '-');
    const startN = ordered ? (Number(attr(el, 'start')) || 1) : 0;
    const delim = ordered ? ((/^\s*\d+([.)])/.exec(rawFirst) || [])[1] || '.') : '';
    const sameNumber = ordered && toks.length > 1 && toks.every((t) => (/^\s*(\d+)/.exec(t.raw) || [])[1] === (/^\s*(\d+)/.exec(rawFirst) || [])[1]);
    const loose = tok && tok.type === 'list' ? !!tok.loose : false;
    const items = elems(el);
    const out = [];
    items.forEach((li, i) => {
      if (tag(li) !== 'li') no('a list with something other than items');
      const itok = toks[i] || null;
      const marker = ordered ? `${sameNumber ? startN : startN + i}${delim}` : bullet;
      const rawItem = itok ? itok.raw : '';
      const gap = (/^\s*(?:[-*+]|\d+[.)])( +)/.exec(rawItem) || [])[1] || ' ';
      const head = `${marker}${gap.length > 4 ? ' ' : gap}`;
      const pad = ' '.repeat(head.length);
      // continuation indent: what the original item used on its second line, else the content width
      const cont = (/\n( +)\S/.exec(rawItem.replace(/\n+$/, '')) || [])[1];
      const contPad = cont !== undefined && cont.length >= head.length ? ' '.repeat(cont.length) : pad;
      const subToks = itok && itok.tokens ? itok.tokens.filter((t) => t.type !== 'space') : [];
      const parts = [];
      let inlineRun = null;
      let si = 0;
      const flush = () => { if (inlineRun !== null) { parts.push({ text: inlineRun, kind: 'inline', lead: '' }); inlineRun = null; } };
      for (const c of kids(li)) {
        if (c.nodeType === 8) continue;
        const name = tag(c);
        if (c.nodeType === 3 || !['p', 'ul', 'ol', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'div', 'table'].includes(name)) {
          const holder = { childNodes: [c] };
          const piece = inline(holder, st, { lineStart: inlineRun === null });
          if (inlineRun === null && !piece.trim()) continue;
          inlineRun = (inlineRun || '') + piece;
          continue;
        }
        flush();
        while (subToks[si] && subToks[si].type === 'text' && name !== 'p') si += 1;
        const sub = subToks[si] || null; si += 1;
        const lead = sub && sub.raw ? (/^ */.exec(sub.raw) || [''])[0] : '';
        if (name === 'ul' || name === 'ol') parts.push({ text: list(c, sub && sub.type === 'list' ? sub : null, st, ''), kind: 'list', lead });
        else {
          const text = block(c, sub, st);
          const own = (/^ */.exec(text) || [''])[0].length;          // spaces the text kept itself
          parts.push({ text, kind: name === 'pre' ? 'code' : (name === 'p' ? 'p' : 'other'), lead: name === 'pre' ? '' : lead.slice(Math.min(lead.length, own)) });
        }
      }
      flush();
      if (!parts.length) parts.push({ text: '', kind: 'inline', lead: '' });
      // gaps between the item's parts as the original item had them (a tight item: 1 newline)
      const partGaps = itok && subToks.length === parts.length ? gapsBetween(itok.text || '', subToks.map((t) => t.raw)) : null;
      // line 0 of the item follows the marker; a later part starts at the item's content column plus
      // its own original lead; paragraph lines continue at the original continuation indent; code and
      // nested-list lines sit at the content column (their own indents are inside their text)
      const indented = parts.map((p, k) => p.text.replace(/\n+$/, '').split('\n').map((l, j) => {
        if (k === 0 && j === 0) return l;
        if (!l) return l;
        if (j === 0) return pad + p.lead + l;
        return (p.kind === 'inline' || p.kind === 'p' ? contPad : pad + p.lead) + l;
      }).join('\n'));
      const body = joinWith(indented, partGaps, loose ? 2 : 1);
      out.push(`${indent}${head}${body}`);
    });
    const itemGaps = toks.length === out.length && tok ? gapsBetween(tok.raw, toks.map((t) => t.raw)) : null;
    return joinWith(out, itemGaps, loose ? 2 : 1);
  }

  // ----------------------------------------------------- whole-block API ---

  const trailing = (md) => (/\n*$/.exec(md) || [''])[0];

  /* Wrapper (note box) parts: opening HTML line(s), inner Markdown, closing line. Only the site's
     own note-box shape qualifies; anything else is a Markdown-box block. */
  const ADM_OPEN_RE = /^<div class="adm adm-([a-z]+)"><p class="adm-title">([^<\n]*)<\/p>[ \t]*$/;
  function admParts(md) {
    const body = md.replace(/\n+$/, '');
    const nl = body.indexOf('\n');
    if (nl < 0) return null;
    const open = body.slice(0, nl);
    if (!ADM_OPEN_RE.test(open)) return null;
    const close = /\n(<\/div>[ \t]*)$/.exec(body);
    if (!close) return null;
    const middle = body.slice(nl, body.length - close[1].length);
    const lead = (/^\n*/.exec(middle) || [''])[0];
    const tail = (/\n*$/.exec(middle) || [''])[0];
    const inner = middle.slice(lead.length, middle.length - tail.length);
    if (/<\/?div\b/i.test(inner)) return null;                                    // nested wrappers
    return { open, lead, inner, tail, close: close[1] };
  }

  /* The newline runs BETWEEN consecutive raws inside src (each raw found from where the previous one
     ended, compared without its own trailing newlines): gaps[k] separates raw k and raw k+1. */
  function gapsBetween(src, raws) {
    const gaps = [];
    let cursor = 0, prevEnd = -1;
    for (const r of raws) {
      const core = String(r).replace(/\n+$/, '');
      let at = core ? src.indexOf(core, cursor) : -1;
      let span = core.length;
      if (at < 0 && core) {                       // the same lines with other leading spaces (a dedented item)
        const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(core.split('\n').map((l) => `[ \\t]*${esc(l.trim())}`).join('\\n'), 'g');
        re.lastIndex = cursor;
        const m = re.exec(src);
        if (m) { at = m.index; span = m[0].length; }
      }
      if (at < 0) return null;
      if (prevEnd >= 0) gaps.push(src.slice(prevEnd, at).replace(/[^\n]/g, '').length);
      prevEnd = at + span; cursor = prevEnd;
    }
    return gaps;
  }
  const joinWith = (parts, gaps, dflt) => parts.reduce((acc, p, i) => (i === 0 ? p
    : acc + '\n'.repeat(gaps && gaps.length === parts.length - 1 ? Math.max(1, gaps[i - 1]) : dflt) + p), '');

  /* -> Markdown for a run of top-level DOM elements, styled after `md`'s tokens, the original
     gaps between blocks kept where the counts line up. */
  function blocksOf(nodes, md) {
    const st = styleOf(md);
    const toks = blockTokens(md);
    const same = toks.length === nodes.length;
    const parts = nodes.map((el, i) => block(el, same ? toks[i] : (toks[i] && tag(el) === tagFor(toks[i]) ? toks[i] : null), st));
    return joinWith(parts, same ? gapsBetween(md, toks.map((t) => t.raw)) : null, 2);
  }
  const tagFor = (t) => ({ paragraph: 'p', heading: `h${t.depth}`, list: t.ordered ? 'ol' : 'ul', code: 'pre', blockquote: 'blockquote', hr: 'hr' }[t.type] || '');

  /* serialize(root, md, kind) -> Markdown for the block, with md's trailing newlines. kind is
     HCCore.splitBlocks' kind ('wrapper' for a note box). */
  function serialize(root, md, kind) {
    const orig = String(md || '');
    const end = trailing(orig) || (orig ? '' : '\n\n');
    const nodes = elems(root);
    if (kind === 'wrapper') {
      const parts = admParts(orig);
      if (!parts) no('a wrapper that is not a site note box');
      if (nodes.length !== 1 || tag(nodes[0]) !== 'div') no('a note box that is not one <div>');
      const box = nodes[0];
      const cls = attr(box, 'class') || '';
      const type = (/(?:^|\s)adm-([a-z]+)(?:\s|$)/.exec(cls) || [])[1];
      if (!type) no('a note box without its type');
      const inside = elems(box);
      const title = inside[0];
      if (!title || tag(title) !== 'p' || attr(title, 'class') !== 'adm-title') no('a note box without its title line');
      const open = parts.open.replace(ADM_OPEN_RE, (m, t, ti) => `<div class="adm adm-${type}"><p class="adm-title">${escHtml(textOf(title))}</p>`);
      const innerMd = blocksOf(inside.slice(1), parts.inner);
      return `${open}\n${parts.lead.slice(1) || '\n'}${innerMd}${parts.tail || '\n\n'}${parts.close}${end}`;
    }
    if (kind === 'code' && (nodes.length !== 1 || tag(nodes[0]) !== 'pre')) no('a code block that is not one <pre>');
    return blocksOf(nodes, orig) + end;
  }
  const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /* -> {ok, reason}: the block round-trips byte for byte through its editor. */
  function gate(md, kind) {
    try {
      const out = serialize(renderBlock(md), md, kind);
      if (out === md) return { ok: true, reason: null };
      let i = 0; while (i < out.length && out[i] === md[i]) i += 1;
      return { ok: false, reason: `would rewrite this part from character ${i}` };
    } catch (e) {
      if (e instanceof Unsupported) return { ok: false, reason: e.message };
      return { ok: false, reason: `could not read this part (${e.message})` };
    }
  }

  /* block = {kind, text} as HCCore.splitBlocks returns -> 'visual'|'code'|'box'|'image'|'markdown'|null */
  function editorFor(b) {
    if (!b || b.kind === 'space') return null;
    if (b.kind === 'table' || b.kind === 'html') return 'markdown';
    if (b.kind === 'wrapper') return admParts(b.text) && gate(b.text, 'wrapper').ok ? 'box' : 'markdown';
    if (b.kind === 'code') return gate(b.text, 'code').ok ? 'code' : 'markdown';
    if (b.kind === 'image') return gate(b.text, 'image').ok ? 'image' : 'markdown';
    return gate(b.text, b.kind).ok ? 'visual' : 'markdown';
  }

  const API = { renderBlock, serialize, gate, editorFor, styleOf, escapeText, Unsupported };
  if (isNode) module.exports = API;
  if (typeof window !== 'undefined') window.HCEditorMd = API;
}());
