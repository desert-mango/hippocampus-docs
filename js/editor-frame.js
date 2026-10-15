// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 14 October 2026
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
         * adds the select affordance (a click anywhere in a block that is
           not a link or a control, or Enter/Space on the focused block —
           each block is tabindex 0) -> hc-block-select {index}, and a "+" rail before every
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
         * opens ONE block for typing in the page (editor redesign U2): the
           message's `open` {index, md, kind} names the block and its Markdown.
           The frame loads js/editor-md.js and js/editor-type.js (once, on
           demand: never for a guest, never outside a preview), swaps that
           block's DOM for a CLEAN render of the Markdown (no cross-reference
           links, anchors or copy buttons) when HCEditorMd's gate passes, and
           makes it editable. Every keystroke is a suggestion (HCEditorType:
           inserted text marked, deleted text struck, kept). After every
           edit it posts hc-block-md {index, md}: the block's
           Markdown, never HTML. It reports hc-block-state {index, editor,
           reason}: 'visual' | 'code' | 'box' when typing in the page,
           'markdown' when the block must be edited as Markdown (the parent's
           box), 'closed' after Escape. The page is never reloaded while a
           block is typed in, and a block already in view is never scrolled.
       No message carries HTML.
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
  const TYPING_SCRIPTS = Object.freeze(['js/editor-md.js', 'js/editor-type.js', 'js/editor-blocks.js']);
  const MAX_BLOCK_MD = 200000;  // js/source.js MAX_BLOCK_MD: a longer hc-block-md is refused by the bridge
  const OPEN_EDITORS = Object.freeze(['visual', 'code', 'box']);
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

  /* An image block: the wrapper holds one paragraph whose only content is one <img> (a linked image is not:
     its click is the link's). V2 (Kyle, 2026-10-14): a click asks the parent to replace it, and it can be
     dragged (or moved with Alt+arrow keys) to another place in the page. */
  function isImageBlock(w, prefix) {
    const els = Array.from(w.childNodes).filter((c) => c.nodeType === ELEMENT && sentinelIndex(c, prefix) === null
      && classesOf(c).indexOf('hc-edit-root') < 0);
    if (els.length !== 1 || String(els[0].tagName).toUpperCase() !== 'P') return false;
    const inner = Array.from(els[0].childNodes);
    const imgs = inner.filter((c) => c.nodeType === ELEMENT);
    return imgs.length === 1 && String(imgs[0].tagName).toUpperCase() === 'IMG'
      && inner.every((c) => c.nodeType === ELEMENT || (c.nodeType === 3 && !/\S/.test(c.data || '')));
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
    let openNow = null;        // {index, w, root, md, kind, editor, handles, sent}
    let scriptsP = null;
    let wanted = null;         // the block an open is waiting for (the scripts still loading); Escape cancels it
    let lastClick = null;      // where the last click into a block landed: the caret goes there on open

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
      if (openNow && openNow.index !== index) flush(openNow);   // the last keystrokes (a finished composition too) first
      HC.post('hc-block-select', { index });
    }

    /* An image block moves: drag it (a line shows where it lands), or Alt+ArrowUp / Alt+ArrowDown while it has
       keyboard focus. The frame only says {index, to}; the parent moves it in the draft and reloads. */
    let dragFrom = null;
    let dropLine = null;
    const dndBodies = new WeakSet();
    const blocksIn = (body) => Array.from(body.childNodes).filter((c) => c.nodeType === ELEMENT && classesOf(c).indexOf('hc-block') >= 0);
    function moveTo(i, to) { if (to !== i && to !== i + 1) HC.post('hc-block-move', { index: i, to }); }
    function dropAt(body, e) {
      let t = e && e.target;
      while (t && t !== body && !(t.nodeType === ELEMENT && classesOf(t).indexOf('hc-block') >= 0)) t = t.parentNode;
      if (!t || t === body) return null;
      const k = indexOfBlock(t);
      if (k === null) return null;
      const r = typeof t.getBoundingClientRect === 'function' ? t.getBoundingClientRect() : null;
      const after = Boolean(r && typeof e.clientY === 'number' && e.clientY > r.top + r.height / 2);
      if (!after) return { to: k, y: r ? r.top : null };
      const list = blocksIn(body);
      const next = list[list.indexOf(t) + 1];
      return { to: next ? indexOfBlock(next) : k + 1, y: r ? r.bottom : null };
    }
    function showDrop(y, body) {
      if (!dropLine) {
        dropLine = doc.createElement('div');
        dropLine.className = 'hc-drop-line';
        dropLine.setAttribute('aria-hidden', 'true');
        if (doc.body) doc.body.appendChild(dropLine);
      }
      dropLine.hidden = y === null;
      if (y === null) return;
      dropLine.style.top = `${Math.round(y + (win.scrollY || 0)) - 1}px`;
      const r = body && typeof body.getBoundingClientRect === 'function' ? body.getBoundingClientRect() : null;
      if (r) { dropLine.style.left = `${Math.round(r.left + (win.scrollX || 0))}px`; dropLine.style.width = `${Math.round(r.width)}px`; }
    }
    function endDrag() { dragFrom = null; if (dropLine) dropLine.hidden = true; }
    function wireImage(body, w, i) {
      w.setAttribute('draggable', 'true');
      w.setAttribute('data-hc-image', '1');
      w.addEventListener('dragstart', (e) => {
        if (openNow) { if (e && e.preventDefault) e.preventDefault(); return; }
        dragFrom = i;
        if (e && e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', ''); } catch (x) { /* ok */ } }
      });
      w.addEventListener('dragend', endDrag);
      w.addEventListener('keydown', (e) => {
        if (!e || e.target !== w || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || openNow) return;
        const list = blocksIn(body);
        const k = list.indexOf(w);
        if (e.preventDefault) e.preventDefault();
        if (e.key === 'ArrowUp' && k > 0) moveTo(i, indexOfBlock(list[k - 1]));
        else if (e.key === 'ArrowDown' && k >= 0 && k < list.length - 1) {
          const after = list[k + 2];
          moveTo(i, after ? indexOfBlock(after) : indexOfBlock(list[k + 1]) + 1);
        }
      });
      if (!dndBodies.has(body)) {                 // once per page body; no attribute: grouping never changes the page's own DOM
        dndBodies.add(body);
        body.addEventListener('dragover', (e) => {
          if (dragFrom === null) return;
          const at = dropAt(body, e);
          if (!at) return;
          if (e.preventDefault) e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
          showDrop(at.y, body);
        });
        body.addEventListener('drop', (e) => {
          if (dragFrom === null) return;
          if (e.preventDefault) e.preventDefault();
          const at = dropAt(body, e);
          const from = dragFrom;
          endDrag();
          if (at) moveTo(from, at.to);
        });
      }
    }

    /* Click/Enter-to-select and the "+" rails, once per block. */
    function decorate(body, blocks) {
      blocks.forEach((w) => {
        const i = indexOfBlock(w);
        if (i === null || w.getAttribute('data-hc-wired') === '1') return;
        w.setAttribute('data-hc-wired', '1');
        // no pencil (Kyle, 2026-10-14): the block itself is the target — a click, or Enter / Space while
        // it has keyboard focus; css/editor.css draws the same left line for hover, focus and open
        w.setAttribute('tabindex', '0');
        if (isImageBlock(w, prefix)) wireImage(body, w, i);
        w.addEventListener('keydown', (e) => {
          if (!e || e.target !== w || (e.key !== 'Enter' && e.key !== ' ')) return;
          if (openNow && openNow.index === i) return;
          if (typeof e.preventDefault === 'function') e.preventDefault();
          lastClick = null;
          select(i);
        });
        w.addEventListener('click', (e) => {
          if (openNow && openNow.index === i) return;          // typing here already: the click moves the caret
          for (let t = e && e.target; t && t !== w; t = t.parentNode) {
            const tag = String(t.tagName || '').toUpperCase();
            if (['A', 'BUTTON', 'SUMMARY', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL'].indexOf(tag) >= 0) return;
          }
          lastClick = e && typeof e.clientX === 'number' ? { x: e.clientX, y: e.clientY } : null;
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
        if (openNow && (openNow.index === d || openNow.index === c)) continue;   // the block being typed in stays put
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
        w.classList.toggle('hc-hot', i !== null && s.hot === i);      // U5b: its review card is hovered or active
      });
      return chosen;
    }

    /* U5b: where the MARKED blocks are, for the parent's review rail (numbers only; js/source.js rounds
       and checks them). Sent after each apply, scroll and resize, once per animation frame, and only when
       something moved; when the marks go, one empty report clears the rail. */
    let lastRects = '[[],0]';
    let rectsQueued = false;
    function reportRects() {
      const s = state;
      if (!s || !s.on) return;
      const marked = new Set((Array.isArray(s.overlay) ? s.overlay : []).map((o) => o && o.index));
      const rects = [];
      if (marked.size) {
        const root = doc.getElementById('content') || doc.body;
        for (const body of pageBodies(root, prefix)) {
          for (const w of blocksIn(body)) {
            const i = indexOfBlock(w);
            if (i === null || !marked.has(i) || typeof w.getBoundingClientRect !== 'function') continue;
            const r = w.getBoundingClientRect();
            rects.push({ index: i, top: r.top, height: r.height });
          }
        }
      }
      const view = Number(win.innerHeight) || 0;
      const key = JSON.stringify([rects, rects.length ? view : 0]);      // a height-only resize is news too
      if (key === lastRects) return;
      lastRects = key;
      HC.post('hc-block-rects', { rects, view });
    }
    function queueRects() {
      if (rectsQueued) return;
      rectsQueued = true;
      const next = typeof win.requestAnimationFrame === 'function' ? (fn) => win.requestAnimationFrame(fn)
        : (fn) => win.setTimeout(fn, 16);
      next(() => { rectsQueued = false; reportRects(); });
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
          if (!inView(chosen)) {
            try { chosen.scrollIntoView({ block: 'center' }); } catch (e) { /* a courtesy */ }
          }
        }
      }
      syncOpen(s);
      queueRects();
    }

    /* A block (partly) on screen is never scrolled: the reader clicked it where it is. */
    function inView(el) {
      if (typeof el.getBoundingClientRect !== 'function') return false;
      const r = el.getBoundingClientRect();
      const h = Number(win.innerHeight) || 0;
      return h > 0 && r.bottom > 0 && r.top < h;
    }

    // ------------------------------------------------- typing in the page (U2) ---

    function loadScripts() {
      if (scriptsP) return scriptsP;
      scriptsP = new Promise((resolve) => {
        if (win.HCEditorMd && win.HCEditorType && win.HCEditorBlocks) { resolve(true); return; }
        let left = TYPING_SCRIPTS.length;
        let ok = true;
        for (const src of TYPING_SCRIPTS) {
          const el = doc.createElement('script');
          el.src = src;
          el.addEventListener('load', () => { left -= 1; if (!left) resolve(ok && Boolean(win.HCEditorMd && win.HCEditorType && win.HCEditorBlocks)); });
          el.addEventListener('error', () => { ok = false; left -= 1; if (!left) resolve(false); });
          (doc.head || doc.body).appendChild(el);
        }
      });
      return scriptsP;
    }

    function wrapperFor(index) {
      const root = doc.getElementById('content') || doc.body;
      for (const body of pageBodies(root, prefix)) {
        const w = blocksIn(body).find((x) => indexOfBlock(x) === index);
        if (w) return w;
      }
      return null;
    }

    function syncOpen(s) {
      const want = s && s.on ? s.open : null;
      if (!want) { if (openNow) closeBlock(false); return; }
      if (openNow && openNow.index === want.index) return;   // the frame's DOM is the truth while typing
      openBlock(want);
    }

    function report(index, editor, reason) {
      HC.post('hc-block-state', { index, editor, reason: reason ? String(reason).slice(0, 300) : '' });
    }

    async function openBlock(o) {
      closeBlock(false);
      const pending = o;
      wanted = o.index;
      const ok = await loadScripts();
      if (wanted !== pending.index) return;                       // Escape while loading, or another pick
      wanted = null;
      if (!state || !state.open || state.open.index !== pending.index || (openNow && openNow.index === pending.index)) return;
      if (state.open.md !== pending.md || state.open.kind !== pending.kind) return;   // the draft moved on meanwhile
      if (!ok) { report(o.index, 'markdown', 'the in-page editor could not load'); return; }
      const M = win.HCEditorMd;
      const w = wrapperFor(o.index);
      if (!w) return;
      // U3: what cannot be typed in the page (a table, tabs, raw HTML, a block the gate refuses, an image
      // line) or what the person chose to edit as Markdown opens as the in-place Markdown box
      let editor = o.as === 'markdown' ? 'mdbox' : M.editorFor({ kind: o.kind, text: o.md });
      if (OPEN_EDITORS.indexOf(editor) < 0) editor = 'mdbox';
      if (editor === 'mdbox') { openMarkdownBox(o, w); return; }
      let root = null;
      for (const c of Array.from(w.childNodes)) if (c.nodeType === ELEMENT && classesOf(c).indexOf('hc-edit-root') >= 0) root = c;
      if (!root || root.getAttribute('data-hc-md-sent') !== o.md) {
        // a clean render of THIS Markdown replaces the page's enhanced one (the wrapper keeps its sentinel)
        const fresh = doc.createElement('div');
        fresh.className = 'hc-edit-root';
        const body = M.renderBlock(o.md);
        while (body.firstChild) fresh.appendChild(body.firstChild);      // appending adopts the node into this page
        for (const c of Array.from(w.childNodes)) {
          if (sentinelIndex(c, prefix) !== null) continue;
          w.removeChild(c);
        }
        w.appendChild(fresh);
        root = fresh;
      }
      const plain = editor === 'code';
      const targets = editor === 'code' ? Array.from(root.querySelectorAll('pre > code')).slice(0, 1)
        : editor === 'box' ? Array.from(root.querySelectorAll('.adm > *')).filter((n) => classesOf(n).indexOf('adm-title') < 0)
          : Array.from(root.children);
      if (!targets.length) { report(o.index, 'markdown', 'nothing in this part can be typed into'); return; }
      const now = { index: o.index, w, root, md: o.md, kind: o.kind === 'wrapper' ? 'wrapper' : o.kind, editor, handles: [], sent: o.md };
      openNow = now;
      root.setAttribute('data-hc-md-sent', o.md);
      for (const t of targets) {
        t.setAttribute('contenteditable', plain ? 'plaintext-only' : 'true');
        t.setAttribute('spellcheck', plain ? 'false' : 'true');
        now.handles.push(win.HCEditorType.attach(t, { plain, onChange: () => schedule(now) }));
        if (plain) {
          const onInput = () => schedule(now);
          t.addEventListener('input', onInput);
          now.handles.push({ detach() { t.removeEventListener('input', onInput); } });
        }
      }
      w.classList.add('hc-open');
      const B = win.HCEditorBlocks;
      if (editor === 'box') {
        const adm = root.querySelector('.adm');
        const bar = B.boxBar(doc, adm, {
          onType: (k, l) => {
            for (const [kk] of B.BOX_TYPES) adm.classList.remove(`adm-${kk}`);
            adm.classList.add(`adm-${k}`);
            const title = adm.querySelector('.adm-title');
            if (title) title.textContent = l;
            schedule(now);
          },
          onRemove: () => removeBlock(now),
        });
        w.insertBefore(bar, root);                // beside the typed DOM, never inside what is serialized
        now.handles.push({ detach() { bar.remove(); } });
      }
      if (editor === 'code') {
        const pre = root.querySelector('pre');
        const cur = (/(?:^|\s)language-(\S+)/.exec(targets[0].className || '') || [])[1] || '';
        const bar = B.codeBar(doc, pre, { current: cur, onChange: (l) => { pre.setAttribute('data-hc-lang', l); schedule(now); } });
        w.insertBefore(bar, root);                // beside the typed DOM, never inside what is serialized
        now.handles.push({ detach() { bar.remove(); } });
      }
      if (editor !== 'code') now.targets = targets;
      placeCaret(targets);
      report(o.index, editor, '');
    }

    /* The in-place Markdown box (U3): the block's own DOM is set aside, the box takes its place; every
       keystroke posts the box's text (Markdown, exactly as typed); Done shows the result rendered. */
    function openMarkdownBox(o, w) {
      const M = win.HCEditorMd;
      const kept = Array.from(w.childNodes).filter((c) => sentinelIndex(c, prefix) === null);
      kept.forEach((c) => { if (c.nodeType === ELEMENT) c.style.display = 'none'; });
      const label = o.kind === 'table' ? 'Table' : (/class="tabs"/.test(o.md) ? 'Tabs'
        : (o.kind === 'html' || o.kind === 'wrapper' ? 'HTML' : 'Markdown'));
      const now = { index: o.index, w, root: null, md: o.md, kind: o.kind, editor: 'mdbox', handles: [], sent: o.md, box: null };
      const box = win.HCEditorBlocks.markdownBox(doc, { md: o.md, label, render: (md) => M.renderBlock(md),
        onInput: () => schedule(now), onDone: () => { if (openNow === now) closeBlock(true); } });
      now.box = box;
      w.appendChild(box.el);
      now.handles.push({ detach() {
        box.el.remove();
        if (now.sent === now.md) { kept.forEach((c) => { if (c.nodeType === ELEMENT) c.style.display = ''; }); return; }
        // the block now shows what the new Markdown renders to (a clean render; the page's own on the next load)
        kept.forEach((c) => { if (c.parentNode === w) w.removeChild(c); });
        const fresh = doc.createElement('div');
        fresh.className = 'hc-edit-root';
        const body = M.renderBlock(now.sent);
        while (body.firstChild) fresh.appendChild(body.firstChild);
        fresh.setAttribute('data-hc-md-sent', now.sent);
        w.appendChild(fresh);
      } });
      openNow = now;
      w.classList.add('hc-open', 'hc-open-md');
      if (box.el.offsetWidth && box.el.offsetWidth < 640) box.setView('text');
      box.focus();
      lastClick = null;
      report(o.index, 'mdbox', '');
    }

    /* A note box's Remove: the block's Markdown becomes empty in the draft; it stays on the page, struck,
       until the next load. */
    function removeBlock(now) {
      if (openNow !== now) return;
      now.removed = true;
      now.sent = '';
      HC.post('hc-block-md', { index: now.index, md: '' });
      closeBlock(true);
      now.w.classList.add('hc-removed');
    }

    /* The formatting bar over a selection inside the open block (U3): Bold, Italic, inline code, Link, as suggestions. */
    let fbar = null;
    function formatBar() {
      if (fbar || !win.HCEditorBlocks || !doc.body) return fbar;
      fbar = win.HCEditorBlocks.formatBar(doc, {
        // a link address: js/editor-md.js's rule (https://, http://, #/, /, a page path), the one the serializer re-checks
        check: (v) => (win.HCEditorMd && typeof win.HCEditorMd.linkHref === 'function' ? win.HCEditorMd.linkHref(v) : null),
        onFormat: (what, href, range) => {
          const now = openNow;
          const sel = doc.getSelection();
          if (!now || !now.targets || !sel) return;
          if (range) {                                   // Link: the selection saved before the address field took the focus
            const owner = now.targets.find((t) => t.contains(range.commonAncestorContainer));
            if (!owner) return;
            owner.focus({ preventScroll: true });
            sel.removeAllRanges();
            sel.addRange(range);
          }
          if (!sel.rangeCount) return;
          const host = now.targets.find((t) => t.contains(sel.anchorNode));
          if (!host) return;
          win.HCEditorType.format(host, what, href);
          schedule(now);
          fbar.hide();
        },
      });
      doc.body.appendChild(fbar.el);
      return fbar;
    }
    if (doc.addEventListener) {
      doc.addEventListener('selectionchange', () => {
        const now = openNow;
        const sel = doc.getSelection ? doc.getSelection() : null;
        const fb = now && now.targets ? formatBar() : fbar;
        if (!fb || (fb.busy && fb.busy())) return;     // the Link address field has the focus
        if (!now || !now.targets || !sel || sel.isCollapsed || !sel.rangeCount || !now.targets.some((t) => t.contains(sel.anchorNode))) { fb.hide(); return; }
        const r = sel.getRangeAt(0).getBoundingClientRect();
        if (r && (r.width || r.height)) fb.showAt(r); else fb.hide();
      });
    }

    function placeCaret(targets) {
      const first = targets[0];
      let placed = false;
      if (lastClick && typeof doc.caretRangeFromPoint === 'function') {
        const r = doc.caretRangeFromPoint(lastClick.x, lastClick.y);
        if (r && targets.some((t) => t.contains(r.startContainer))) {
          const host = targets.find((t) => t.contains(r.startContainer));
          host.focus({ preventScroll: true });
          const sel = doc.getSelection(); sel.removeAllRanges(); sel.addRange(r);
          placed = true;
        }
      }
      if (!placed && first && typeof first.focus === 'function') {
        first.focus({ preventScroll: true });
        const r = doc.createRange(); r.selectNodeContents(first); r.collapse(false);
        const sel = doc.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      }
      lastClick = null;
    }

    /* Every edit reaches the parent at once: postMessage keeps the order, so the last keystroke always
       arrives before a later pick, "Edit as Markdown" or the Editor switch. Nothing waits on a timer. */
    function schedule(now) {
      if (openNow !== now) return;
      flush(now);
    }

    /* The block's Markdown, from the edited DOM, to the parent (only when it changed). */
    function flush(now) {
      if (now.removed) return;
      let md;
      try {
        md = now.editor === 'mdbox' ? now.box.value() : win.HCEditorMd.serialize(now.root, now.md, now.kind);
      } catch (e) {
        report(now.index, 'markdown', (e && e.message) || 'this part can no longer be typed into');
        if (openNow === now) closeBlock(false);
        return;
      }
      if (md === now.sent) return;
      if (md.length > MAX_BLOCK_MD) {           // the bridge would refuse it: say so, the Markdown box takes over
        report(now.index, 'markdown', 'this part is now longer than 200,000 characters: edit it as Markdown');
        if (openNow === now) closeBlock(false);
        return;
      }
      now.sent = md;
      if (now.root) now.root.setAttribute('data-hc-md-sent', md);
      HC.post('hc-block-md', { index: now.index, md });
    }

    /* Typing stops; the DOM (and its suggestion marks) stays on the page as it is. */
    function closeBlock(tellParent) {
      const now = openNow;
      if (!now) return;
      flush(now);                                 // anything not yet sent (a composition that just ended)
      openNow = null;
      for (const hd of now.handles) hd.detach();
      if (now.root) for (const t of Array.from(now.root.querySelectorAll('[contenteditable]'))) t.removeAttribute('contenteditable');
      if (fbar) fbar.close();
      now.w.classList.remove('hc-open', 'hc-open-md');
      if (tellParent) report(now.index, 'closed', '');
    }

    HC.onEditor((s) => {
      // the site's theme (the sandboxed frame cannot read it): the one attribute js/app.js's toggle sets
      const root = doc.documentElement;
      if (root && s.theme === 'light') root.setAttribute('data-theme', 'light');
      else if (root && s.theme === 'dark') root.removeAttribute('data-theme');
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

    win.addEventListener('scroll', queueRects);
    win.addEventListener('resize', queueRects);
    win.addEventListener('hashchange', () => {
      const h = String(win.location.hash || '');
      if (h.indexOf('#preview=') === 0) return;      // js/source.js turns that into a reload
      HC.post('hc-route', { route: h.replace(/^#/, '') || '/' });
    });
    if (doc.addEventListener) {
      doc.addEventListener('click', () => closePicker());
      // the format bar from the keyboard (Kyle's 2026-10-14 bar): Cmd/Ctrl+K a link, Cmd/Ctrl+E inline code
      doc.addEventListener('keydown', (e) => {
        if (!e || !(e.metaKey || e.ctrlKey) || e.altKey || !openNow || !openNow.targets) return;
        const k = String(e.key || '').toLowerCase();
        if (k !== 'k' && k !== 'e') return;
        const sel = doc.getSelection ? doc.getSelection() : null;
        if (!sel || sel.isCollapsed || !sel.rangeCount || !openNow.targets.some((t) => t.contains(sel.anchorNode))) return;
        const fb = formatBar();
        if (!fb) return;
        e.preventDefault();
        if (k === 'e') {
          const host = openNow.targets.find((t) => t.contains(sel.anchorNode));
          win.HCEditorType.format(host, 'code');
          schedule(openNow);
          fb.hide();
        } else fb.openLink(sel.getRangeAt(0).getBoundingClientRect());
      });
      doc.addEventListener('keydown', (e) => {
        if (!e || e.key !== 'Escape') return;
        if (openNow) closeBlock(true);
        else if (wanted !== null) { const i = wanted; wanted = null; report(i, 'closed', ''); }
      });
    }

    /* TEST-ONLY, for the localhost walk (tools/tests/editor_walk.html): the
       walk cannot click inside this sandboxed frame, and the picker is the
       frame's own (no message opens it). So on localhost / 127.0.0.1 only,
       and only when a top window that is NOT the parent sits above the site
       (the walk page; in the real Editor top is the parent), ONE message
       listener answers that top window:
         - {type: 'hc-walk-picker', index} clicks the "+" rail before block
           `index` — the real click path — scrolls it into view and answers
           {type: 'hc-walk-picker-open', index, open, kinds};
         - {type: 'hc-walk-scroll'} answers {type: 'hc-walk-scroll-samples',
           samples, log, loadedAt, nonce16, now}: this document's scrollY
           since it loaded, as 16 ms samples [msSinceLoad, scrollY] (sample 0
           taken here, at create) and as an ordered event log {seq, why,
           scrollY, scrollHeight, innerHeight} written on create, on every
           change inside #content and on every scroll event (timers do not
           fire under headless Chrome's virtual time while fetches are
           pending; the log still keeps the order). Both stop growing at
           WALK_CAP entries; `now` is scrollY at the moment of the answer.
           It measures the page jumping while a block is edited.
       The parent is told nothing; anywhere else no listener, timer or
       observer exists. */
    const host = String((win.location && win.location.hostname) || '');
    if ((host === 'localhost' || host === '127.0.0.1') && win.top && win.parent && win.top !== win.parent) {
      const WALK_CAP = 2000;
      const scrollYNow = () => Number(win.scrollY) || 0;
      const scroller = () => doc.scrollingElement || doc.documentElement || doc.body || {};
      const loadedAt = Date.now();
      const samples = [[0, scrollYNow()]];
      const log = [];
      const note = (why) => {
        if (log.length >= WALK_CAP) return;
        log.push({ seq: log.length, why, scrollY: scrollYNow(), scrollHeight: Number(scroller().scrollHeight) || 0,
          innerHeight: Number(win.innerHeight) || 0 });
      };
      note('create');
      if (typeof win.setInterval === 'function') {
        let timer = null;
        timer = win.setInterval(() => {
          if (timer === null) return;
          samples.push([Date.now() - loadedAt, scrollYNow()]);
          if (samples.length >= WALK_CAP) {
            if (typeof win.clearInterval === 'function') win.clearInterval(timer);
            timer = null;
          }
        }, 16);
      }
      if (content && typeof win.MutationObserver === 'function') {
        new win.MutationObserver(() => note('mutation')).observe(content, { childList: true, subtree: true });
      }
      win.addEventListener('scroll', () => note('scroll'));
      win.addEventListener('message', (e) => {
        const d = e && e.data;
        if (!e || e.source !== win.top || !d || typeof d !== 'object') return;
        if (d.type === 'hc-walk-scroll') {
          e.source.postMessage({ type: 'hc-walk-scroll-samples', samples: samples.map((x) => x.slice()),
            log: log.map((x) => Object.assign({}, x)), loadedAt, nonce16: prefix, now: scrollYNow() }, e.origin);
          return;
        }
        if (d.type !== 'hc-walk-picker' || !Number.isInteger(d.index)) return;
        const root = doc.getElementById('content') || doc.body;
        let r = null;
        for (const body of pageBodies(root, prefix)) {
          r = r || Array.from(body.childNodes).find((n) => n.nodeType === ELEMENT && classesOf(n).indexOf('hc-plus') >= 0
            && n.getAttribute('data-insert') === String(d.index)) || null;
        }
        if (r && !(openPicker && openPicker.rail === r)) {
          const plus = Array.from(r.childNodes).find((n) => n.nodeType === ELEMENT && classesOf(n).indexOf('hc-plus-btn') >= 0);
          if (plus) plus.click();
        }
        const open = Boolean(r && openPicker && openPicker.rail === r);
        if (open && typeof r.scrollIntoView === 'function') {
          try { r.scrollIntoView({ block: 'center' }); } catch (err) { /* a courtesy */ }
        }
        const kinds = open ? Array.from(openPicker.picker.childNodes).map((b) => b.getAttribute('data-kind')) : [];
        e.source.postMessage({ type: 'hc-walk-picker-open', index: d.index, open, kinds }, e.origin);
      });
    }

    HC.post('hc-ready');
    return Object.freeze({ apply, state: () => state, open: () => (openNow ? { index: openNow.index, editor: openNow.editor } : null) });
  }

  const api = { INSERT_KINDS, MARK_CLASS, sentinelIndex, isChrome, findSentinels, pageBodies, groupBlocks, sidePairs,
    blocksIn, create };
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    api.runtime = create(window, document, window.HC);
    window.HCEditorFrame = Object.freeze(api);
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}());
