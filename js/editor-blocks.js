// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 14 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Draw the in-page block editors: the Markdown box with live preview, the note-box bar, code language, format bar.
/* HCEditorBlocks: the editor redesign's block editors (U3, Kyle's D1 change 6), drawn INSIDE the
   sandboxed page frame by js/editor-frame.js, next to the text a person types into. They build DOM
   with createElement and textContent only; the one HTML they show is the Markdown preview, rendered
   by js/editor-md.js (marked + js/sanitize.js, exactly as the page itself), in the frame.

     markdownBox(doc, {md, label, render, onInput, onDone}) -> {el, focus, value}
         The in-place Markdown box (tables, tabs, raw HTML, or any block a person chose to edit as
         Markdown): built from the site's own parts (the tab-bar look, the site's code style with line
         numbers, the preview in the page's own styles under a small "Preview" label), with
         "Side by side" / "Markdown" / "Preview" views (narrow: one at a time) and Done.
     boxBar(doc, adm, {onType, onRemove}) -> el
         A small bar on a note box's top edge while it is typed in: the box type (Note, Tip,
         Important, Warning, Danger) and Remove. The box keeps the live site's exact padding.
     codeBar(doc, pre, {languages, current, onChange}) -> el
         The code box's language picker (the fence's info string).
     formatBar(doc, {onFormat}) -> {el, showAt(rect), hide()}
         The formatting bar over a selection: Bold, Italic, inline code, Link (suggestions, js/editor-type.js). */
(function () {
  'use strict';

  const BOX_TYPES = Object.freeze([['note', 'Note'], ['tip', 'Tip'], ['important', 'Important'], ['warning', 'Warning'],
    ['danger', 'Danger']]);
  const LANGUAGES = Object.freeze(['console', 'bash', 'sh', 'python', 'yaml', 'json', 'xml', 'cpp', 'text']);

  function make(doc, tag, cls, text) {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function button(doc, cls, text, label) {
    const b = make(doc, 'button', cls, text);
    b.type = 'button';
    if (label) { b.setAttribute('aria-label', label); b.title = label; }
    return b;
  }

  function markdownBox(doc, o) {
    const box = make(doc, 'div', 'hc-mdbox');
    box.setAttribute('data-view', 'split');
    const head = make(doc, 'div', 'hc-md-head');
    const title = make(doc, 'span', 'hc-md-title', o.label || 'Markdown');
    const hint = make(doc, 'span', 'hc-md-hint', 'edited as Markdown');
    const views = make(doc, 'div', 'hc-md-views');
    views.setAttribute('role', 'tablist');
    views.setAttribute('aria-label', 'Show');
    const view = (k, text) => {
      const b = button(doc, '', text);
      b.setAttribute('role', 'tab');
      b.setAttribute('data-view', k);
      b.setAttribute('aria-selected', String(k === 'split'));
      b.addEventListener('click', () => setView(k));
      views.appendChild(b);
      return b;
    };
    view('split', 'Side by side'); view('text', 'Markdown'); view('preview', 'Preview');
    const done = button(doc, 'hc-md-done', 'Done');
    done.addEventListener('click', () => { if (typeof o.onDone === 'function') o.onDone(); });
    head.append(title, hint, views, done);
    const cols = make(doc, 'div', 'hc-md-cols');
    const srcWrap = make(doc, 'div', 'hc-md-srcwrap');
    const nums = make(doc, 'div', 'hc-md-nums');
    nums.setAttribute('aria-hidden', 'true');
    const ta = make(doc, 'textarea', 'hc-md-src');
    ta.setAttribute('spellcheck', 'false');
    ta.setAttribute('wrap', 'off');
    ta.setAttribute('aria-label', `${o.label || 'This part'}, as Markdown`);
    ta.value = String(o.md || '').replace(/\n+$/, '');
    srcWrap.append(nums, ta);
    const prevWrap = make(doc, 'div', 'hc-md-prevwrap');
    const prev = make(doc, 'div', 'hc-md-prev page-body');
    prevWrap.append(make(doc, 'div', 'hc-md-label', 'Preview'), prev);
    cols.append(srcWrap, prevWrap);
    const foot = make(doc, 'div', 'hc-md-foot', o.label === 'Table'
      ? 'One row per line. Cells are split by |. The second line sets the columns.'
      : 'Changes here are kept as Markdown, exactly as typed.');
    box.append(head, cols, foot);
    const trailing = (/\n*$/.exec(String(o.md || '')) || [''])[0] || '\n\n';
    const value = () => ta.value + trailing;
    const draw = () => {
      prev.textContent = '';
      try {
        const body = o.render(ta.value);
        while (body.firstChild) prev.appendChild(body.firstChild);
      } catch (e) { prev.textContent = 'The preview could not be drawn.'; }
      nums.textContent = ta.value.split('\n').map((_, i) => i + 1).join('\n');
      ta.style.height = 'auto';
      ta.style.height = `${Math.max(140, Math.min(460, ta.scrollHeight + 2))}px`;
    };
    ta.addEventListener('input', () => { draw(); if (typeof o.onInput === 'function') o.onInput(value()); });
    ta.addEventListener('scroll', () => { nums.scrollTop = ta.scrollTop; });
    function setView(k) {
      box.setAttribute('data-view', k);
      for (const b of Array.from(views.children)) b.setAttribute('aria-selected', String(b.getAttribute('data-view') === k));
    }
    draw();
    return { el: box, value, setView, focus: () => ta.focus({ preventScroll: true }) };
  }

  function boxBar(doc, adm, o) {
    const bar = make(doc, 'div', 'hc-boxbar');
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Note box');
    bar.setAttribute('contenteditable', 'false');
    const current = () => (BOX_TYPES.find(([k]) => adm.classList.contains(`adm-${k}`)) || BOX_TYPES[0]);
    const typeBtn = button(doc, 'hc-box-type', '');
    typeBtn.setAttribute('aria-haspopup', 'menu');
    typeBtn.setAttribute('aria-expanded', 'false');
    const label = () => { const [k, l] = current(); typeBtn.textContent = ''; const dot = make(doc, 'span', `hc-box-dot hc-dot-${k}`); typeBtn.append(dot, make(doc, 'span', '', l), make(doc, 'span', 'hc-chev', '▾')); typeBtn.setAttribute('aria-label', `Box type: ${l}`); };
    label();
    let menu = null;
    const close = () => { if (menu) { menu.remove(); menu = null; } typeBtn.setAttribute('aria-expanded', 'false'); };
    typeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (menu) { close(); return; }
      menu = make(doc, 'div', 'hc-boxmenu');
      menu.setAttribute('role', 'menu');
      for (const [k, l] of BOX_TYPES) {
        const item = button(doc, `hc-pm-item${current()[0] === k ? ' is-current' : ''}`, '');
        item.setAttribute('role', 'menuitemradio');
        item.setAttribute('aria-checked', String(current()[0] === k));
        item.append(make(doc, 'span', `hc-box-dot hc-dot-${k}`), make(doc, 'span', '', l));
        item.addEventListener('click', (ev) => { ev.stopPropagation(); close(); o.onType(k, l); label(); });
        menu.appendChild(item);
      }
      bar.appendChild(menu);
      typeBtn.setAttribute('aria-expanded', 'true');
    });
    const remove = button(doc, 'hc-box-remove', '✕', 'Remove this box');
    remove.addEventListener('click', (e) => { e.stopPropagation(); close(); o.onRemove(); });
    bar.append(typeBtn, remove);
    return bar;
  }

  function codeBar(doc, pre, o) {
    const bar = make(doc, 'div', 'hc-codebar');
    bar.setAttribute('contenteditable', 'false');
    const lab = make(doc, 'label', '', 'Language');
    const sel = make(doc, 'select', '');
    sel.setAttribute('aria-label', 'Code language');
    const langs = (o.languages || LANGUAGES).slice();
    if (o.current && langs.indexOf(o.current) < 0) langs.unshift(o.current);
    if (!o.current) langs.unshift('');
    for (const l of langs) { const op = make(doc, 'option', '', l || '(none)'); op.value = l; if (l === (o.current || '')) op.selected = true; sel.appendChild(op); }
    sel.addEventListener('change', () => o.onChange(sel.value));
    bar.append(lab, sel);
    return bar;
  }

  /* The formatting bar over a selection: Bold, Italic, inline code, Link (Kyle, 2026-10-14). Link turns the
     bar into an address field (the sandboxed frame has no prompt()): Enter or Add applies it to the selection
     saved when Link was pressed, Escape or x goes back; o.check(address) -> the address or null (refused,
     said in words under the field). o.onFormat(what, href, range). Keyboard: every button works from the
     keyboard (Enter/Space), and the frame maps Cmd/Ctrl+K to openLink and Cmd/Ctrl+E to inline code.
     busy() is true while the field is open,
     so the frame does not hide the bar when the focus leaves the text for the field. */
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function linkIcon(doc) {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    for (const [k, v] of [['viewBox', '0 0 16 16'], ['width', '16'], ['height', '16'], ['aria-hidden', 'true'], ['fill', 'none'],
      ['stroke', 'currentColor'], ['stroke-width', '1.6'], ['stroke-linecap', 'round']]) svg.setAttribute(k, v);
    for (const d of ['M6.6 9.4l2.8-2.8', 'M7.3 4.6l1.1-1.1a2.6 2.6 0 0 1 3.7 3.7L11 8.3', 'M8.7 11.4l-1.1 1.1a2.6 2.6 0 0 1-3.7-3.7L5 7.7']) {
      const path = doc.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  }
  function formatBar(doc, o) {
    const bar = make(doc, 'div', 'hc-formatbar');
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Format');
    bar.hidden = true;
    const row = make(doc, 'div', 'hc-fb-row');
    const field = make(doc, 'div', 'hc-fb-linkrow');
    field.hidden = true;
    let saved = null;
    const win = doc.defaultView;
    for (const [what, text, lab] of [['strong', 'B', 'Bold'], ['em', 'I', 'Italic'], ['code', '<>', 'Inline code'], ['link', '', 'Link']]) {
      const b = button(doc, `hc-fb hc-fb-${what}`, text, lab);
      if (what === 'link') b.appendChild(linkIcon(doc));
      const act = () => { if (what === 'link') openLink(); else o.onFormat(what); };
      // mousedown keeps the text selection; a keyboard press on a focused button arrives as a click with detail 0
      b.addEventListener('mousedown', (e) => { e.preventDefault(); act(); });
      b.addEventListener('click', (e) => { if (e.detail === 0) act(); });
      row.appendChild(b);
    }
    const url = make(doc, 'input', 'hc-fb-url');
    url.type = 'url';                              // the address keyboard on phones; there is no form, so nothing is blocked
    url.setAttribute('inputmode', 'url');
    url.setAttribute('autocomplete', 'off');
    url.setAttribute('aria-label', 'Link address');
    url.placeholder = 'https://… or #/setup/…';
    url.spellcheck = false;
    const add = button(doc, 'hc-fb-add', 'Add', 'Add the link');
    const cancel = button(doc, 'hc-fb-cancel', '×', 'Cancel');
    const err = make(doc, 'p', 'hc-fb-err');
    err.setAttribute('role', 'alert');
    err.hidden = true;
    const inputs = make(doc, 'div', 'hc-fb-inputs');
    inputs.append(url, add, cancel);
    field.append(inputs, err);
    bar.append(row, field);
    function openLink() {
      const sel = doc.getSelection();
      saved = sel && sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0).cloneRange() : null;
      if (saved) openField();
      return Boolean(saved);
    }
    function openField() {
      row.hidden = true;
      field.hidden = false;
      err.hidden = true;
      url.value = '';
      url.focus();
    }
    // a selection given back by Escape/x must not bring the bar straight back: it stays closed until the
    // person selects something else
    let dismissed = null;
    const sameRange = (a, b) => Boolean(a && b) && a.startContainer === b.startContainer && a.startOffset === b.startOffset
      && a.endContainer === b.endContainer && a.endOffset === b.endOffset;
    function closeField(restore) {
      field.hidden = true;
      row.hidden = false;
      const r = saved;
      saved = null;
      bar.hidden = true;
      dismissed = restore && r ? r : null;
      if (restore && r) { const sel = doc.getSelection(); sel.removeAllRanges(); sel.addRange(r); }
    }
    function apply() {
      const href = typeof o.check === 'function' ? o.check(url.value) : null;
      if (href === null) {
        err.textContent = 'Use an address that starts with https://, http://, #/ or /, or a page path.';
        err.hidden = false;
        url.focus();
        return;
      }
      const r = saved;
      closeField(false);
      if (r) o.onFormat('link', href, r);
    }
    add.addEventListener('mousedown', (e) => { e.preventDefault(); apply(); });
    add.addEventListener('click', (e) => { if (e.detail === 0) apply(); });
    cancel.addEventListener('mousedown', (e) => { e.preventDefault(); closeField(true); });
    cancel.addEventListener('click', (e) => { if (e.detail === 0) closeField(true); });
    url.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); apply(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeField(true); }
    });
    function place(r) {
      const w = bar.offsetWidth || 80;
      bar.style.left = `${Math.max(8, Math.min((win.innerWidth || 800) - w - 8, r.left + r.width / 2 - w / 2)) + (win.scrollX || 0)}px`;
      bar.style.top = `${r.top + (win.scrollY || 0) - (bar.offsetHeight || 36) - 8}px`;
    }
    return {
      el: bar,
      showAt(r) {
        if (saved) return;                       // the address field is open: it stays where it is
        if (dismissed) {
          const sel = doc.getSelection();
          if (sel && sel.rangeCount && sameRange(sel.getRangeAt(0), dismissed)) return;
          dismissed = null;
        }
        bar.hidden = false;
        place(r);
      },
      hide() { if (saved) return; bar.hidden = true; },
      busy() { return Boolean(saved); },
      // Cmd/Ctrl+K in the open block: the address field for the selection, the bar over it (r: its rectangle)
      openLink(r) { bar.hidden = false; if (r) place(r); if (!openLink()) bar.hidden = true; },
      close() { if (saved) closeField(false); dismissed = null; bar.hidden = true; },
    };
  }

  const API = { markdownBox, boxBar, codeBar, formatBar, BOX_TYPES, LANGUAGES };
  if (typeof window !== 'undefined') window.HCEditorBlocks = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
}());
