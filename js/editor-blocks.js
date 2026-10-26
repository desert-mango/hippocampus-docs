// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 26 October 2026
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
     blockBar(doc, o) -> {el, openLink, busy, close, refresh}
         The open block's ONE toolbar (U4, plan D8; it replaced the pop-up over a selection, the note box's
         bar with its × and the code box's language select): B, I, Link, Code, List, Comment, and Type ▾ for a
         note box / Language ▾ for code, each menu with Remove last (D9). */
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

  /* ---- D8 (ED15, ED16, ED17, ED18, ED33, ED34): ONE toolbar per open block, on its top edge ----
     blockBar(doc, o) -> {el, openLink(), busy(), close(), refresh()}
       o.kind      'visual' | 'box' | 'code'
       o.onFormat(what, href, range)  'strong' | 'em' | 'code' | 'link' (Link: the address o.check accepted and the
                   selection saved when Link was pressed)
       o.check(v)  -> the address or null (js/editor-md.js linkHref)
       o.onList()  -> the list state after the click ('ul' | 'ol' | 'none'); o.listState() the state now
       o.onComment()
       o.box       {current() -> key, onType(key, label)}: the Type menu (boxes)
       o.code      {current, onChange(lang)}: the Language menu (code blocks)
       o.onRemove()  the last item of the Type / Language menu
     Order: [Type ▾ | Language ▾] B I Link Code List Comment (Link before Code, ED17). A code block is plain text:
     only Language ▾ and Comment. role="toolbar" with a roving tabindex (W3C ARIA toolbar pattern): ONE Tab stop;
     ArrowLeft / ArrowRight move inside (wrapping), Home / End go to the ends. A button press never takes the text
     selection away (mousedown is cancelled; a keyboard press arrives as a click with detail 0). Link turns the row
     into an address field: Enter or Add applies it, Escape or × goes back with the selection given back. Built with
     createElement, appendChild and textContent only. */
  const LANG_NAMES = Object.freeze({ console: 'Terminal', bash: 'Shell', sh: 'Shell (sh)', python: 'Python', yaml: 'YAML',
    json: 'JSON', xml: 'XML', cpp: 'C++', text: 'Plain text', '': 'No language' });
  const langName = (l) => (Object.prototype.hasOwnProperty.call(LANG_NAMES, l) ? LANG_NAMES[l] : l);
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = Object.freeze({
    link: ['M6.6 9.4l2.8-2.8', 'M7.3 4.6l1.1-1.1a2.6 2.6 0 0 1 3.7 3.7L11 8.3', 'M8.7 11.4l-1.1 1.1a2.6 2.6 0 0 1-3.7-3.7L5 7.7'],
    list: ['M6 4.5h7', 'M6 8h7', 'M6 11.5h7', 'M3 4.5h.01', 'M3 8h.01', 'M3 11.5h.01'],
    comment: ['M3 3.5h10v7H7l-3 2.5v-2.5H3z'],
  });
  function icon(doc, name) {
    if (typeof doc.createElementNS !== 'function') return null;
    const svg = doc.createElementNS(SVG_NS, 'svg');
    for (const [k, v] of [['viewBox', '0 0 16 16'], ['width', '16'], ['height', '16'], ['aria-hidden', 'true'], ['fill', 'none'],
      ['stroke', 'currentColor'], ['stroke-width', '1.6'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']]) svg.setAttribute(k, v);
    for (const d of ICONS[name]) {
      const path = doc.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  }
  const drop = (n) => { if (n && n.parentNode) n.parentNode.removeChild(n); };
  const kidsOf = (n) => Array.from(n.childNodes).filter((c) => c.nodeType === 1);

  function blockBar(doc, o) {
    const bar = make(doc, 'div', 'hc-blockbar');
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', o.kind === 'box' ? 'Edit this note box' : o.kind === 'code' ? 'Edit this code' : 'Edit this part');
    bar.setAttribute('contenteditable', 'false');
    const row = make(doc, 'div', 'hc-fb-row');
    const field = make(doc, 'div', 'hc-fb-linkrow');
    field.hidden = true;
    const hint = make(doc, 'p', 'hc-fb-hint');
    hint.setAttribute('role', 'status');
    hint.hidden = true;
    const items = [];
    let saved = null;
    let menu = null;
    // a press that keeps the text selection: mousedown cancelled, the keyboard's click (detail 0) acts
    const press = (b, act) => {
      b.addEventListener('mousedown', (e) => { if (e && e.preventDefault) e.preventDefault(); act(e); });
      b.addEventListener('click', (e) => { if (e && e.stopPropagation) e.stopPropagation(); if (!e || !e.detail) act(e); });
    };
    const add = (b) => { b.setAttribute('tabindex', items.length ? '-1' : '0'); items.push(b); row.appendChild(b); return b; };
    const say = (text) => { hint.textContent = text; hint.hidden = !text; };
    const hasSelection = () => { const sel = doc.getSelection ? doc.getSelection() : null; return Boolean(sel && sel.rangeCount && !sel.isCollapsed); };

    // ---- the Type ▾ / Language ▾ menu, Remove last (D9: no × on the box) ----
    let menuBtn = null;
    function closeMenu() { drop(menu); menu = null; if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false'); }
    function openMenu(entries, current, onPick) {
      closeMenu();
      menu = make(doc, 'div', 'hc-boxmenu');
      menu.setAttribute('role', 'menu');
      for (const [k, l, dot] of entries) {
        const item = button(doc, `hc-pm-item${current === k ? ' is-current' : ''}`, '');
        item.setAttribute('role', 'menuitemradio');
        item.setAttribute('aria-checked', String(current === k));
        item.setAttribute('data-value', k);
        if (dot) item.appendChild(make(doc, 'span', `hc-box-dot hc-dot-${k}`));
        item.appendChild(make(doc, 'span', '', l));
        // fix pass A5 (WCAG 2.4.3): the picked item goes with the menu; focus goes back to the Type ▾ / Language ▾ button
        item.addEventListener('click', (ev) => {
          if (ev && ev.stopPropagation) ev.stopPropagation();
          closeMenu();
          onPick(k, l);
          if (menuBtn && typeof menuBtn.focus === 'function') menuBtn.focus();
        });
        menu.appendChild(item);
      }
      menu.appendChild(make(doc, 'div', 'hc-pm-sep'));
      const rm = button(doc, 'hc-pm-item hc-pm-remove', o.kind === 'code' ? 'Remove this code' : 'Remove this box');
      rm.setAttribute('role', 'menuitem');
      rm.addEventListener('click', (ev) => { if (ev && ev.stopPropagation) ev.stopPropagation(); closeMenu(); if (typeof o.onRemove === 'function') o.onRemove(); });
      menu.appendChild(rm);
      bar.appendChild(menu);
      menuBtn.setAttribute('aria-expanded', 'true');
      // the menu's own keys (m2): ArrowDown / ArrowUp wrap, Home / End, Escape closes it back to its button
      const own = kidsOf(menu).filter((c) => c.tagName === 'BUTTON');
      let mAt = 0;
      const mFocus = (i) => {
        mAt = (i + own.length) % own.length;
        own.forEach((b, j) => b.setAttribute('tabindex', j === mAt ? '0' : '-1'));
        if (typeof own[mAt].focus === 'function') own[mAt].focus();
      };
      const open = menu;
      menu.addEventListener('keydown', (e) => {
        const key = e && e.key;
        const from = own.indexOf(e && e.target);
        const i = from >= 0 ? from : mAt;
        let to = null;
        if (key === 'ArrowDown') to = i + 1;
        else if (key === 'ArrowUp') to = i - 1;
        else if (key === 'Home') to = 0;
        else if (key === 'End') to = own.length - 1;
        else if (key === 'Escape') {
          if (e.preventDefault) e.preventDefault();
          if (e.stopPropagation) e.stopPropagation();
          if (menu === open) closeMenu();
          if (menuBtn && typeof menuBtn.focus === 'function') menuBtn.focus();
          return;
        }
        if (to === null) return;
        if (e.preventDefault) e.preventDefault();
        mFocus(to);
      });
      mFocus(0);
    }
    if (o.kind === 'box' && o.box) {
      menuBtn = add(button(doc, 'hc-fb hc-box-type', ''));
      const label = () => {
        const k = o.box.current();
        const l = (BOX_TYPES.find(([kk]) => kk === k) || BOX_TYPES[0])[1];
        menuBtn.textContent = '';
        menuBtn.appendChild(make(doc, 'span', `hc-box-dot hc-dot-${k}`));
        menuBtn.appendChild(make(doc, 'span', '', l));
        menuBtn.appendChild(make(doc, 'span', 'hc-chev', '▾'));
        menuBtn.setAttribute('aria-label', `Box type: ${l}`);
      };
      label();
      menuBtn.setAttribute('aria-haspopup', 'menu');
      menuBtn.setAttribute('aria-expanded', 'false');
      menuBtn.addEventListener('click', (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        if (menu) { closeMenu(); return; }
        openMenu(BOX_TYPES.map(([k, l]) => [k, l, true]), o.box.current(), (k, l) => { o.box.onType(k, l); label(); });
      });
    }
    if (o.kind === 'code' && o.code) {
      let cur = typeof o.code.current === 'string' ? o.code.current : '';
      menuBtn = add(button(doc, 'hc-fb hc-code-lang', ''));
      const label = () => {
        menuBtn.textContent = '';
        menuBtn.appendChild(make(doc, 'span', '', langName(cur)));
        menuBtn.appendChild(make(doc, 'span', 'hc-chev', '▾'));
        menuBtn.setAttribute('aria-label', `Code language: ${langName(cur)}`);
      };
      label();
      menuBtn.setAttribute('aria-haspopup', 'menu');
      menuBtn.setAttribute('aria-expanded', 'false');
      menuBtn.addEventListener('click', (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        if (menu) { closeMenu(); return; }
        const langs = LANGUAGES.concat(['']);
        if (langs.indexOf(cur) < 0) langs.unshift(cur);
        openMenu(langs.map((l) => [l, langName(l), false]), cur, (k) => { cur = k; o.code.onChange(k); label(); });
      });
    }

    // ---- B I Link Code List (not in a code block: it is plain text) ----
    let listBtn = null;
    const pressable = [];          // fix pass A7: B and I say whether the selection is already bold / italic
    if (o.kind !== 'code') {
      for (const [what, text, lab] of [['strong', 'B', 'Bold'], ['em', 'I', 'Italic'], ['link', '', 'Link'], ['code', '<>', 'Code']]) {
        const b = add(button(doc, `hc-fb hc-fb-${what}`, text, lab));
        if (what === 'link') { const svg = icon(doc, 'link'); if (svg) b.appendChild(svg); }
        if (what === 'strong' || what === 'em') pressable.push([what, b]);
        press(b, () => {
          if (!hasSelection()) { say('Select some words first.'); return; }
          say('');
          if (what === 'link') openLink(); else o.onFormat(what);
          refresh();
        });
      }
      listBtn = add(button(doc, 'hc-fb hc-fb-list', '', 'List'));
      const svg = icon(doc, 'list');
      if (svg) listBtn.appendChild(svg);
      press(listBtn, () => { say(''); if (typeof o.onList === 'function') o.onList(); refresh(); });
    }
    const comment = add(button(doc, 'hc-fb hc-fb-comment', '', 'Comment: a note for the reviewer, the text stays as it is'));
    { const svg = icon(doc, 'comment'); if (svg) comment.appendChild(svg); }
    comment.appendChild(make(doc, 'span', 'hc-fb-word', 'Comment'));
    press(comment, () => { say(''); if (typeof o.onComment === 'function') o.onComment(); });

    function refresh() {
      for (const [what, b] of pressable) {
        b.setAttribute('aria-pressed', String(Boolean(typeof o.formatState === 'function' && o.formatState(what))));
      }
      if (!listBtn) return;
      const st = typeof o.listState === 'function' ? o.listState() : 'none';
      listBtn.setAttribute('aria-pressed', String(st === 'ul' || st === 'ol'));
      listBtn.setAttribute('data-list', st);
      const lab = st === 'ul' ? 'List: bulleted (click for numbered)' : st === 'ol' ? 'List: numbered (click to undo the list)' : 'List';
      listBtn.setAttribute('aria-label', lab);
      listBtn.title = lab;
    }
    refresh();

    // roving tabindex: one Tab stop, arrows inside
    let at = 0;
    const focusAt = (i) => {
      at = (i + items.length) % items.length;
      items.forEach((b, k) => b.setAttribute('tabindex', k === at ? '0' : '-1'));
      if (typeof items[at].focus === 'function') items[at].focus();
    };
    items.forEach((b, k) => b.addEventListener('focus', () => { at = k; items.forEach((x, j) => x.setAttribute('tabindex', j === k ? '0' : '-1')); }));
    row.addEventListener('keydown', (e) => {
      const key = e && e.key;
      let to = null;
      if (key === 'ArrowRight') to = at + 1;
      else if (key === 'ArrowLeft') to = at - 1;
      else if (key === 'Home') to = 0;
      else if (key === 'End') to = items.length - 1;
      else if (key === 'Escape' && menu) { closeMenu(); if (e.stopPropagation) e.stopPropagation(); focusAt(at); return; }
      if (to === null) return;
      if (e.preventDefault) e.preventDefault();
      focusAt(to);
    });

    // ---- the Link address field ----
    const url = make(doc, 'input', 'hc-fb-url');
    url.type = 'url';                              // the address keyboard on phones; there is no form, so nothing is blocked
    url.setAttribute('inputmode', 'url');
    url.setAttribute('autocomplete', 'off');
    url.setAttribute('aria-label', 'Link address');
    url.placeholder = 'https://… or #/setup/…';
    url.spellcheck = false;
    const addBtn = button(doc, 'hc-fb-add', 'Add', 'Add the link');
    const cancel = button(doc, 'hc-fb-cancel', '×', 'Cancel');
    const err = make(doc, 'p', 'hc-fb-err');
    err.setAttribute('role', 'alert');
    err.hidden = true;
    const inputs = make(doc, 'div', 'hc-fb-inputs');
    inputs.appendChild(url); inputs.appendChild(addBtn); inputs.appendChild(cancel);
    field.appendChild(inputs); field.appendChild(err);
    bar.appendChild(row); bar.appendChild(field); bar.appendChild(hint);
    function openLink() {
      const sel = doc.getSelection ? doc.getSelection() : null;
      saved = sel && sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0).cloneRange() : null;
      if (!saved) { say('Select some words first.'); return false; }
      row.hidden = true;
      field.hidden = false;
      err.hidden = true;
      url.value = '';
      if (typeof url.focus === 'function') url.focus();
      return true;
    }
    function closeField(restore) {
      field.hidden = true;
      row.hidden = false;
      const r = saved;
      saved = null;
      if (restore && r && doc.getSelection) { const sel = doc.getSelection(); sel.removeAllRanges(); sel.addRange(r); }
    }
    function apply() {
      const href = typeof o.check === 'function' ? o.check(url.value) : null;
      if (href === null) {
        err.textContent = 'Use an address that starts with https://, http://, #/ or /, or a page path.';
        err.hidden = false;
        if (typeof url.focus === 'function') url.focus();
        return;
      }
      const r = saved;
      closeField(false);
      if (r) o.onFormat('link', href, r);
    }
    press(addBtn, apply);
    press(cancel, () => closeField(true));
    url.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); apply(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeField(true); }
    });
    return {
      el: bar,
      openLink,
      busy: () => Boolean(saved),
      refresh,
      close() { if (saved) closeField(false); closeMenu(); say(''); },
    };
  }

  /* D9 (ED32): no one-click loss. After Remove, the frame puts this pill beside the removed block for
     REMOVED_PILL_MS: "Removed" and an Undo button (o.onUndo: the parent's undo, where the removal is its own step).
     o.setTimeout is the frame window's timer. */
  /* Fix pass A5 (WCAG 4.1.3, 2.2.1): the pill comes into the page with its words EMPTY and gets "Removed" on the next
     tick, so its role=status is heard; the frame then focuses its Undo. The 8-s clock stops while the focus or the
     pointer is inside the pill and starts again (a full 8 s) when both have left. o.clearTimeout stops a clock. */
  const REMOVED_PILL_MS = 8000;
  function removedPill(doc, o) {
    const pill = make(doc, 'div', 'hc-removed-pill');
    pill.setAttribute('role', 'status');
    pill.setAttribute('contenteditable', 'false');
    const what = make(doc, 'span', 'hc-removed-what');
    pill.appendChild(what);
    const undo = button(doc, 'hc-removed-undo', 'Undo', 'Undo the removal');
    let timer = null;
    let gone = false;
    let focusIn = false;
    let pointerIn = false;
    const hold = () => { if (timer !== null && typeof o.clearTimeout === 'function') o.clearTimeout(timer); timer = null; };
    const start = () => {
      if (gone || focusIn || pointerIn || timer !== null) return;
      timer = o.setTimeout(() => { timer = null; if (focusIn || pointerIn) return; gone = true; drop(pill); }, REMOVED_PILL_MS);
    };
    undo.addEventListener('click', (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      gone = true;
      hold();
      drop(pill);
      o.onUndo();
    });
    pill.appendChild(undo);
    pill.addEventListener('focusin', () => { focusIn = true; hold(); });
    pill.addEventListener('focusout', () => { focusIn = false; start(); });
    pill.addEventListener('pointerenter', () => { pointerIn = true; hold(); });
    pill.addEventListener('pointerleave', () => { pointerIn = false; start(); });
    o.setTimeout(() => { what.textContent = 'Removed'; }, 0);
    start();
    return pill;
  }

  const API = { markdownBox, blockBar, removedPill, REMOVED_PILL_MS, BOX_TYPES, LANGUAGES, LANG_NAMES, langName };
  if (typeof window !== 'undefined') window.HCEditorBlocks = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
}());
