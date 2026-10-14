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
         The formatting bar over a selection: Bold, Italic (suggestions, js/editor-type.js). */
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

  function formatBar(doc, o) {
    const bar = make(doc, 'div', 'hc-formatbar');
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Format');
    bar.hidden = true;
    for (const [what, text, lab] of [['strong', 'B', 'Bold'], ['em', 'I', 'Italic']]) {
      const b = button(doc, `hc-fb hc-fb-${what}`, text, lab);
      b.addEventListener('mousedown', (e) => { e.preventDefault(); o.onFormat(what); });
      bar.appendChild(b);
    }
    const win = doc.defaultView;
    return {
      el: bar,
      showAt(r) {
        bar.hidden = false;
        const w = bar.offsetWidth || 80;
        bar.style.left = `${Math.max(8, Math.min((win.innerWidth || 800) - w - 8, r.left + r.width / 2 - w / 2)) + (win.scrollX || 0)}px`;
        bar.style.top = `${r.top + (win.scrollY || 0) - (bar.offsetHeight || 36) - 8}px`;
      },
      hide() { bar.hidden = true; },
    };
  }

  const API = { markdownBox, boxBar, codeBar, formatBar, BOX_TYPES, LANGUAGES };
  if (typeof window !== 'undefined') window.HCEditorBlocks = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
}());
