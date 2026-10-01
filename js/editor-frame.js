// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 1 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Draw the Editor mode's block marks inside the sandboxed preview frame and report picks to the parent.
/* HCEditorFrame — the FRAME side of the Editor mode (plan D-D, D-E, D-N).

   index.html loads this file for everyone, but it does nothing unless the
   page is a preview frame (HC.preview, js/source.js): on the live site it
   returns at once, adds no listener and draws nothing. Guests therefore
   run no editor code (D-C); the parent side is js/editor.js, which only a
   signed-in session loads.

   Inside a preview frame it speaks js/source.js's protocol, section 9:
     - at load it posts hc-ready; when the reader follows a link in the
       frame it posts hc-route {route};
     - it listens (HC.onEditor) for the parent's hc-editor message
       {on, settings, selected, overlay}. With on: true it
         * sets body.hc-framed (css/editor.css hides the frame's own header,
           sidebar and footer: the parent's are the ones on screen) and loads
           css/editor.css into the frame;
         * GROUPS the page: the parent served the Markdown with an
           id-sentinel <div id="hcb-<prefix>-<i>"></div> before block i,
           where <prefix> is HC.blockPrefix (this load's nonce, so content
           cannot fake a mark). Every top-level child of the page body from
           sentinel i up to the next sentinel is moved into ONE wrapper
           <div class="hc-block" data-index="i">, sentinel first. The run
           stops early at chrome app.js/lab.js add after the Markdown
           (nav.page-nav, any hc-* element), which stays outside;
         * adds the select affordance (a pencil button per block; a click
           anywhere in a block that is not a link or a control selects it
           too) -> hc-block-select {index}, and a "+" rail before every
           block and after the last -> a picker of the snippet kinds ->
           hc-block-insert {index, kind};
         * applies the classes the message names: hc-selected on the
           selected block (scrolled into view), hc-prop-<mark> from the
           overlay, and the View settings as body classes (hc-outlines,
           hc-compact, hc-hide-suggestions, hc-diff-side);
         * with the diff style "side by side" (U7, plan D-F), puts each
           replaced block (mark del) and its new version (mark change, the
           block right after it) into one two-column <div class="hc-side">;
           with "inline" they stay stacked, old above new.
       No text is ever typed into the frame: editing happens in the parent's
       tray. No message carries HTML.
   The page renders after this file runs (js/app.js is later in the page),
   so a MutationObserver on #content re-applies the marks whenever the page
   body appears or changes; grouping is idempotent.

   tools/tests/test_editor_frame.mjs pins it over a fake DOM;
   tools/tests/browser_oracles.mjs checks the grouping in a real Chrome
   over every content page. */
(function () {
  'use strict';

  const INSERT_KINDS = Object.freeze([
    Object.freeze({ kind: 'image', label: 'Image', hint: 'from Media' }),
    Object.freeze({ kind: 'note', label: 'Note', hint: 'callout' }),
    Object.freeze({ kind: 'warning', label: 'Warning', hint: 'callout' }),
    Object.freeze({ kind: 'attention', label: 'Attention', hint: 'callout' }),
    Object.freeze({ kind: 'tabs', label: 'Tabs', hint: 'per platform' }),
    Object.freeze({ kind: 'video', label: 'Video', hint: 'a link' }),
    Object.freeze({ kind: 'repo', label: 'Repo card', hint: 'org repository' }),
  ]);
  const MARK_CLASS = Object.freeze({ add: 'hc-prop-add', del: 'hc-prop-del', change: 'hc-prop-change',
    conflict: 'hc-prop-conflict' });
  const SETTING_CLASS = Object.freeze({ outlines: 'hc-outlines', compact: 'hc-compact' });
  const CSS_HREF = 'css/editor.css';
  const ELEMENT = 1;

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /* The block index a node marks, or null: a <div> whose id is exactly
     hcb-<prefix>-<i> for THIS load's prefix. */
  function sentinelIndex(node, prefix) {
    if (!node || node.nodeType !== ELEMENT || String(node.tagName).toUpperCase() !== 'DIV' || !prefix) return null;
    const m = new RegExp(`^hcb-${escapeRe(prefix)}-([0-9]{1,6})$`).exec(String(node.id || ''));
    return m ? Number(m[1]) : null;
  }

  function classesOf(node) {
    return String((node && node.className) || '').split(/\s+/).filter(Boolean);
  }

  /* Chrome that app.js or lab.js appends to a page body after the Markdown:
     the prev/next nav and anything with an hc-* class (content can carry
     neither: the sanitizer allows no hc-* class). A block never swallows it. */
  function isChrome(node) {
    if (!node || node.nodeType !== ELEMENT) return false;
    const cls = classesOf(node);
    return cls.indexOf('page-nav') >= 0 || cls.some((c) => c.indexOf('hc-') === 0 && c !== 'hc-block');
  }

  function isBlock(node) {
    return Boolean(node) && node.nodeType === ELEMENT && classesOf(node).indexOf('hc-block') >= 0;
  }

  /* Every element under root whose id is a sentinel of this prefix. */
  function findSentinels(root, prefix, out) {
    const acc = out || [];
    for (const c of Array.from((root && root.childNodes) || [])) {
      if (c.nodeType !== ELEMENT) continue;
      if (sentinelIndex(c, prefix) !== null) acc.push(c);
      else findSentinels(c, prefix, acc);
    }
    return acc;
  }

  /* The page bodies to group: the parents of this load's sentinels. */
  function pageBodies(root, prefix) {
    const bodies = [];
    for (const s of findSentinels(root, prefix)) {
      let p = isBlock(s.parentNode) ? s.parentNode.parentNode : s.parentNode;
      if (isSide(p)) p = p.parentNode;
      if (p && bodies.indexOf(p) < 0) bodies.push(p);
    }
    return bodies;
  }

  /* Moves the top-level children of body between sentinels into
     .hc-block[data-index] wrappers (sentinel first). Idempotent: an already
     grouped sentinel is left where it is. -> the wrappers, in order. */
  function groupBlocks(doc, body, prefix) {
    let current = null;
    for (const node of Array.from(body.childNodes)) {
      if (isBlock(node)) { current = null; continue; }
      const i = sentinelIndex(node, prefix);
      if (i !== null) {
        const w = doc.createElement('div');
        w.className = 'hc-block';
        w.setAttribute('data-index', String(i));
        body.insertBefore(w, node);
        w.appendChild(node);
        current = w;
      } else if (isChrome(node)) {
        current = null;
      } else if (current) {
        current.appendChild(node);
      }
    }
    return Array.from(body.childNodes).filter(isBlock);
  }

  const isSide = (node) => Boolean(node) && node.nodeType === ELEMENT && classesOf(node).indexOf('hc-side') >= 0;

  /* The overlay's [old, new] pairs for "side by side": a block marked del
     and the block right after it marked change (its new version, plan
     D-F). -> [[delIndex, changeIndex]] */
  function sidePairs(overlay) {
    const list = (Array.isArray(overlay) ? overlay : []).filter((o) => o && Number.isInteger(o.index))
      .slice().sort((a, b) => a.index - b.index);
    const out = [];
    list.forEach((o, i) => {
      const next = list[i + 1];
      if (o.mark === 'del' && next && next.mark === 'change' && next.index === o.index + 1) out.push([o.index, next.index]);
    });
    return out;
  }

  /* Every block wrapper of a page body, also those inside an hc-side pair. */
  function blocksIn(body) {
    const out = [];
    for (const node of Array.from(body.childNodes)) {
      if (isBlock(node)) out.push(node);
      else if (isSide(node)) Array.from(node.childNodes).filter(isBlock).forEach((w) => out.push(w));
    }
    return out;
  }

  function indexOfBlock(w) {
    const n = Number(w.getAttribute('data-index'));
    return Number.isInteger(n) && n >= 0 ? n : null;
  }

  function create(win, doc, HC) {
    if (!HC || HC.preview !== true || !doc) return null;
    const prefix = HC.blockPrefix;
    let state = null;
    let cssAdded = false;
    let openPicker = null;

    function button(cls, label, text) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.setAttribute('aria-label', label);
      b.textContent = text;
      return b;
    }

    function closePicker() {
      if (!openPicker) return;
      const { rail, picker } = openPicker;
      openPicker = null;
      if (picker.parentNode) picker.parentNode.removeChild(picker);
      rail.classList.remove('is-open');
    }

    function rail(index) {
      const r = doc.createElement('div');
      r.className = 'hc-plus';
      r.setAttribute('data-insert', String(index));
      const plus = button('hc-plus-btn', 'Add a block here', '+');
      plus.addEventListener('click', (e) => {
        if (e && e.stopPropagation) e.stopPropagation();
        const wasMine = openPicker && openPicker.rail === r;
        closePicker();
        if (wasMine) return;
        const picker = doc.createElement('div');
        picker.className = 'hc-picker';
        picker.setAttribute('role', 'menu');
        for (const k of INSERT_KINDS) {
          const b = button('hc-pick', `Add ${k.label}`, '');
          b.setAttribute('data-kind', k.kind);
          b.setAttribute('role', 'menuitem');
          const name = doc.createElement('span');
          name.textContent = k.label;
          const hint = doc.createElement('small');
          hint.textContent = k.hint;
          b.appendChild(name);
          b.appendChild(hint);
          b.addEventListener('click', (ev) => {
            if (ev && ev.stopPropagation) ev.stopPropagation();
            closePicker();
            HC.post('hc-block-insert', { index, kind: k.kind });
          });
          picker.appendChild(b);
        }
        r.appendChild(picker);
        r.classList.add('is-open');
        openPicker = { rail: r, picker };
      });
      r.appendChild(plus);
      return r;
    }

    function select(index) {
      closePicker();
      HC.post('hc-block-select', { index });
    }

    /* Pencil, click-to-select and the "+" rails, once per block. */
    function decorate(body, blocks) {
      blocks.forEach((w) => {
        const i = indexOfBlock(w);
        if (i === null || w.getAttribute('data-hc-wired') === '1') return;
        w.setAttribute('data-hc-wired', '1');
        const pencil = button('hc-pencil', 'Edit this block', '✎');
        pencil.addEventListener('click', (e) => {
          if (e && e.stopPropagation) e.stopPropagation();
          select(i);
        });
        w.appendChild(pencil);
        w.addEventListener('click', (e) => {
          for (let t = e && e.target; t && t !== w; t = t.parentNode) {
            const tag = String(t.tagName || '').toUpperCase();
            if (['A', 'BUTTON', 'SUMMARY', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL'].indexOf(tag) >= 0) return;
          }
          select(i);
        });
        const prev = w.previousSibling;
        const hasRail = prev && prev.nodeType === ELEMENT && classesOf(prev).indexOf('hc-plus') >= 0;
        if (!hasRail) body.insertBefore(rail(i), w);
      });
      const last = blocks[blocks.length - 1];
      if (last && !(last.nextSibling && classesOf(last.nextSibling).indexOf('hc-plus') >= 0)) {
        const end = rail(indexOfBlock(last) + 1);
        body.insertBefore(end, last.nextSibling || null);
      }
    }

    /* "Side by side": pairs into div.hc-side (the "+" rail between the two
       goes: nothing is inserted between an old block and its new version);
       "inline": any pair is unwrapped again, old above new. */
    function arrangeSides(body, blocks, s) {
      const side = s.settings.diff === 'side';
      for (const node of Array.from(body.childNodes)) {
        if (!isSide(node)) continue;
        if (side) continue;
        for (const c of Array.from(node.childNodes)) body.insertBefore(c, node);
        body.removeChild(node);
      }
      if (!side) return;
      const byIndex = new Map(blocks.map((w) => [indexOfBlock(w), w]));
      for (const [d, c] of sidePairs(s.overlay)) {
        const old = byIndex.get(d);
        const neu = byIndex.get(c);
        if (!old || !neu || old.parentNode !== body || neu.parentNode !== body) continue;
        const pair = doc.createElement('div');
        pair.className = 'hc-side';
        body.insertBefore(pair, old);
        for (let n = old.nextSibling; n && n !== neu;) {
          const next = n.nextSibling;
          if (n.nodeType === ELEMENT && classesOf(n).indexOf('hc-plus') >= 0) body.removeChild(n);
          n = next;
        }
        pair.appendChild(old);
        pair.appendChild(neu);
      }
    }

    function paintMarks(blocks, s) {
      const marks = new Map(s.overlay.map((o) => [o.index, o.mark]));
      let chosen = null;
      blocks.forEach((w) => {
        const i = indexOfBlock(w);
        const sel = i !== null && i === s.selected;
        w.classList.toggle('hc-selected', sel);
        if (sel) chosen = w;
        for (const mark of Object.keys(MARK_CLASS)) w.classList.toggle(MARK_CLASS[mark], marks.get(i) === mark);
      });
      return chosen;
    }

    function setBodyClasses(s) {
      const b = doc.body;
      if (!b) return;
      b.classList.toggle('hc-framed', s.on);
      b.classList.toggle('hc-edit-on', s.on);
      b.classList.toggle(SETTING_CLASS.outlines, s.on && s.settings.outlines);
      b.classList.toggle(SETTING_CLASS.compact, s.on && s.settings.compact);
      b.classList.toggle('hc-hide-suggestions', s.on && !s.settings.suggestions);
      b.classList.toggle('hc-diff-side', s.on && s.settings.diff === 'side');
    }

    function addCss() {
      if (cssAdded || !doc.head) return;
      cssAdded = true;
      const link = doc.createElement('link');
      link.rel = 'stylesheet';
      link.href = CSS_HREF;
      doc.head.appendChild(link);
    }

    let scrolledTo = null;
    function apply() {
      const s = state;
      if (!s) return;
      setBodyClasses(s);
      if (!s.on) return;
      addCss();
      const root = doc.getElementById('content') || doc.body;
      for (const body of pageBodies(root, prefix)) {
        decorate(body, groupBlocks(doc, body, prefix));
        const blocks = blocksIn(body);
        const chosen = paintMarks(blocks, s);
        arrangeSides(body, blocks, s);
        if (chosen && scrolledTo !== chosen && typeof chosen.scrollIntoView === 'function') {
          scrolledTo = chosen;
          try { chosen.scrollIntoView({ block: 'center' }); } catch (e) { /* a courtesy */ }
        }
      }
    }

    HC.onEditor((s) => {
      if (!state || state.selected !== s.selected) scrolledTo = null;
      state = s;
      apply();
    });

    let pending = false;
    const content = doc.getElementById('content');
    if (content && typeof win.MutationObserver === 'function') {
      new win.MutationObserver(() => {
        if (pending) return;
        pending = true;
        win.setTimeout(() => { pending = false; apply(); }, 0);
      }).observe(content, { childList: true, subtree: true });
    }

    win.addEventListener('hashchange', () => {
      const h = String(win.location.hash || '');
      if (h.indexOf('#preview=') === 0) return;      // js/source.js turns that into a reload
      HC.post('hc-route', { route: h.replace(/^#/, '') || '/' });
    });
    if (doc.addEventListener) doc.addEventListener('click', () => closePicker());

    HC.post('hc-ready');
    return Object.freeze({ apply, state: () => state });
  }

  const api = { INSERT_KINDS, MARK_CLASS, sentinelIndex, isChrome, findSentinels, pageBodies, groupBlocks, sidePairs,
    blocksIn, create };
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    api.runtime = create(window, document, window.HC);
    window.HCEditorFrame = Object.freeze(api);
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}());
