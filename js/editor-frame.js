// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 15 October 2026
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
         * on the Team page (#people-root) with hc-editor.people, loads
           js/editor-people.js (HCEditorPeople: the card menu, moves, drag, the
           "+" cards and the people marks) once, on demand;
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

  // U4 (D9, D10, ED26, ED27): five tiles, a small icon and one word each; ONE Note tile (its kind is picked inside
  // the box, Type ▾); the icons are inline SVG paths on a 16-px grid
  const INSERT_KINDS = Object.freeze([
    Object.freeze({ kind: 'image', label: 'Image', icon: ['M2.5 3.5h11v9h-11z', 'M2.5 10.5l3-3 3 3 2-2 3 3', 'M10.5 6h.01'] }),
    Object.freeze({ kind: 'note', label: 'Note', icon: ['M3 2.5h7l3 3v8H3z', 'M5.5 7h5', 'M5.5 9.5h5'] }),
    Object.freeze({ kind: 'tabs', label: 'Tabs', icon: ['M2.5 5.5h11v7h-11z', 'M2.5 5.5v-2h4v2', 'M6.5 5.5v-2h4v2'] }),
    Object.freeze({ kind: 'video', label: 'Video', icon: ['M2.5 3.5h11v9h-11z', 'M7 6l3 2-3 2z'] }),
    Object.freeze({ kind: 'repo', label: 'Repo', icon: ['M4 2.5h8v11H4z', 'M6 5h4', 'M6 7.5h4', 'M6 10h2'] }),
  ]);
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MARK_CLASS = Object.freeze({ add: 'hc-prop-add', del: 'hc-prop-del', change: 'hc-prop-change',
    conflict: 'hc-prop-conflict' });
  const SETTING_CLASS = Object.freeze({ outlines: 'hc-outlines', compact: 'hc-compact' });
  const CSS_HREF = 'css/editor.css';
  const TYPING_SCRIPTS = Object.freeze(['js/editor-md.js', 'js/editor-type.js', 'js/editor-blocks.js']);
  const PEOPLE_SCRIPT = 'js/editor-people.js';   // the Team page's people tools, loaded on demand
  const MAX_BLOCK_MD = 200000;  // js/source.js MAX_BLOCK_MD: a longer hc-block-md is refused by the bridge
  const OPEN_EDITORS = Object.freeze(['visual', 'code', 'box']);
  const PHONE_BAR_QUERY = '(max-width: 767px)';   // D8: the toolbar sits above the keyboard
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

    /* An inline SVG icon from 16-px-grid paths (aria-hidden), or null where the document makes no SVG. */
    function pathIcon(paths, size) {
      if (typeof doc.createElementNS !== 'function') return null;
      const svg = doc.createElementNS(SVG_NS, 'svg');
      for (const [k, v] of [['viewBox', '0 0 16 16'], ['width', String(size)], ['height', String(size)], ['aria-hidden', 'true'],
        ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '1.4'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']]) svg.setAttribute(k, v);
      for (const d of paths) { const p = doc.createElementNS(SVG_NS, 'path'); p.setAttribute('d', d); svg.appendChild(p); }
      return svg;
    }

    /* D11 (ED51): the Image tile's two ways, under the tiles: Upload (the parent's file chooser, as before) and
       "Pick one the site has" (a grid of the site's images, asked of the parent: hc-media-list -> hc-editor.media). */
    function imageChoices(picker, index, tile) {
      let row = null;
      for (const c of Array.from(picker.childNodes)) if (classesOf(c).indexOf('hc-pick-image') >= 0) row = c;
      if (row) { picker.removeChild(row); tile.setAttribute('aria-expanded', 'false'); return; }
      row = doc.createElement('div');
      row.className = 'hc-pick-image';
      const up = button('hc-pick-way', 'Upload an image from this computer', 'Upload');
      up.addEventListener('click', (ev) => {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        closePicker();
        HC.post('hc-block-insert', { index, kind: 'image' });
      });
      const pick = button('hc-pick-way', 'Pick one of the images the site has', 'Pick one the site has');
      const grid = doc.createElement('div');
      grid.className = 'hc-pick-grid';
      grid.setAttribute('role', 'list');
      grid.hidden = true;
      pick.addEventListener('click', (ev) => {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        grid.hidden = false;
        if (state && Array.isArray(state.media)) drawMedia(grid, index, state.media);
        else { grid.textContent = 'Loading the site\'s images…'; HC.post('hc-media-list', {}); }
      });
      row.appendChild(up);
      row.appendChild(pick);
      row.appendChild(grid);
      picker.appendChild(row);
      tile.setAttribute('aria-expanded', 'true');
      if (openPicker) openPicker.grid = grid;
    }
    function drawMedia(grid, index, media) {
      while (grid.firstChild) grid.removeChild(grid.firstChild);
      grid.setAttribute('data-ready', 'true');
      if (!media.length) { grid.textContent = 'The site has no images yet: use Upload.'; return; }
      for (const a of media) {
        const b = button('hc-pick-img', `Use ${a.label}`, '');
        b.setAttribute('role', 'listitem');
        b.setAttribute('title', a.label);
        const img = doc.createElement('img');
        img.setAttribute('src', a.url);
        img.setAttribute('alt', '');
        img.setAttribute('loading', 'lazy');
        b.appendChild(img);
        b.addEventListener('click', (ev) => {
          if (ev && ev.stopPropagation) ev.stopPropagation();
          closePicker();
          HC.post('hc-image-use', { index, url: a.url });
        });
        grid.appendChild(b);
      }
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
        picker.setAttribute('aria-label', 'Add here');
        const tiles = doc.createElement('div');
        tiles.className = 'hc-pick-row';
        picker.appendChild(tiles);
        for (const k of INSERT_KINDS) {
          const b = button('hc-pick', `Add ${k.label === 'Repo' ? 'a repository card' : k.label === 'Image' ? 'an image' : `a ${k.label.toLowerCase()}`}`, '');
          b.setAttribute('data-kind', k.kind);
          b.setAttribute('role', 'menuitem');
          const ic = pathIcon(k.icon, 20);
          if (ic) b.appendChild(ic);
          const name = doc.createElement('span');
          name.textContent = k.label;
          b.appendChild(name);
          b.addEventListener('click', (ev) => {
            if (ev && ev.stopPropagation) ev.stopPropagation();
            if (k.kind === 'image') { imageChoices(picker, index, b); return; }   // D11: Upload, or one the site has
            closePicker();
            HC.post('hc-block-insert', { index, kind: k.kind });
          });
          tiles.appendChild(b);
        }
        r.appendChild(picker);
        r.classList.add('is-open');           // D10 (ED28): the room opens on this click only, never on hover
        openPicker = { rail: r, picker, index };
      });
      r.appendChild(plus);
      return r;
    }

    // the edit gate (2026-10-21): a project page this person may not edit picks, adds and moves nothing
    const locked = () => Boolean(state && state.locked);
    function select(index) {
      closePicker();
      if (locked()) return;
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
        if (openNow || locked()) { if (e && e.preventDefault) e.preventDefault(); return; }
        dragFrom = i;
        if (e && e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', ''); } catch (x) { /* ok */ } }
      });
      w.addEventListener('dragend', endDrag);
      w.addEventListener('keydown', (e) => {
        if (!e || e.target !== w || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || openNow || locked()) return;
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
      for (const i of Array.isArray(s.anchors) ? s.anchors : []) marked.add(i);      // U3: a note card's block
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
      b.classList.toggle('hc-edit-locked', s.on && s.locked === true);   // the edit gate: nothing to add or pick here
      // round 2 (R1): the drawn proposal's proposer colour (css/editor.css body[data-hc-tint])
      if (s.on) b.setAttribute('data-hc-tint', String(Number.isInteger(s.tint) ? s.tint : 0));
      else b.removeAttribute('data-hc-tint');
    }

    function addCss() {
      if (cssAdded || !doc.head) return;
      cssAdded = true;
      const link = doc.createElement('link');
      link.rel = 'stylesheet';
      link.href = CSS_HREF;
      link.onload = link.onerror = () => { cssIn = true; paintSignal(); };
      doc.head.appendChild(link);
    }

    /* U7 (plan D12): the first paint. The parent keeps its own page on screen until this load has drawn
       the page in Editor mode, then swaps them (js/editor.js frameReady). So, ONCE per load, a second
       hc-ready: Editor mode applied (body.hc-framed), css/editor.css in (loaded or failed) and #content
       holding the page (an element other than the noscript note), two animation frames later (on screen). */
    let cssIn = false;
    let painted = false;
    function paintSignal() {
      const s = state;
      if (painted || !cssIn || !s || !s.on) return;
      const content = doc.getElementById('content');
      const drawn = content && Array.from(content.childNodes || []).some((n) => n.nodeType === ELEMENT && n.tagName !== 'NOSCRIPT');
      if (!drawn) return;
      painted = true;
      const next = typeof win.requestAnimationFrame === 'function' ? (fn) => win.requestAnimationFrame(fn)
        : (fn) => win.setTimeout(fn, 16);
      next(() => next(() => HC.post('hc-ready')));
    }

    let scrolledTo = null;
    function apply() {
      const s = state;
      if (!s) return;
      setBodyClasses(s);
      factsFor(win, doc, HC).sync(s);   // U6 (plan D17): a project page's facts, lock line and "+ New project"
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
      syncNotes(s);                     // U4 (D8): my notes beside their blocks
      restoreMarks(s);                  // U4 (D6): the marks kept before a reload
      if (openPicker && openPicker.grid && !openPicker.grid.hidden && Array.isArray(s.media)
        && openPicker.grid.getAttribute('data-ready') !== 'true') drawMedia(openPicker.grid, openPicker.index, s.media);
      queueRects();
      syncPeople(s);
      paintSignal();
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
      if (!targetsOf(root, editor).length) { report(o.index, 'markdown', 'nothing in this part can be typed into'); return; }
      const now = { index: o.index, w, root, md: o.md, kind: o.kind === 'wrapper' ? 'wrapper' : o.kind, editor, handles: [], sent: o.md, typing: [] };
      openNow = now;
      root.setAttribute('data-hc-md-sent', o.md);
      const targets = attachTargets(now);
      w.classList.add('hc-open');
      const B = win.HCEditorBlocks;
      const T = win.HCEditorType;
      // D8 (ED15): ONE toolbar on the block's top edge, inside its frame (js/editor-blocks.js blockBar)
      const hostOf = () => {
        const sel = doc.getSelection ? doc.getSelection() : null;
        const ts = now.targets || [];
        return (sel && sel.rangeCount && ts.find((t) => t.contains(sel.anchorNode))) || ts[0] || null;
      };
      const opts = {
        kind: editor,
        check: (v) => (typeof M.linkHref === 'function' ? M.linkHref(v) : null),
        onFormat: (what, href, range) => formatIn(now, what, href, range),
        onComment: () => noteCard(now.index, true),
        onRemove: () => removeBlock(now),
        onList: () => { const host = hostOf(); if (!host) return; noteBefore(now, true); T.list(host); schedule(now); },
        listState: () => T.listState(hostOf()),
      };
      if (editor === 'box') {
        const adm = root.querySelector('.adm');
        const current = () => (B.BOX_TYPES.find(([k]) => adm.classList.contains(`adm-${k}`)) || B.BOX_TYPES[0])[0];
        opts.box = {
          current,
          onType: (k, l) => {
            noteBefore(now, true);
            const title = adm.querySelector('.adm-title');
            // the first type, for the marks kept across a reload (js/editor-md.js serialize {original: true})
            if (adm.getAttribute('data-hc-was') === null) {
              adm.setAttribute('data-hc-was', current());
              adm.setAttribute('data-hc-was-title', title ? title.textContent : '');
            }
            for (const [kk] of B.BOX_TYPES) adm.classList.remove(`adm-${kk}`);
            adm.classList.add(`adm-${k}`);
            if (title) title.textContent = l;
            schedule(now);
          },
        };
      }
      if (editor === 'code') {
        const pre = root.querySelector('pre');
        const cur = (/(?:^|\s)language-(\S+)/.exec(targets[0].className || '') || [])[1] || '';
        opts.code = { current: cur, onChange: (l) => { noteBefore(now, true); pre.setAttribute('data-hc-lang', l); schedule(now); } };
      }
      const bar = B.blockBar(doc, opts);
      w.insertBefore(bar.el, root);               // beside the typed DOM, never inside what is serialized
      now.bar = bar;
      now.handles.push({ detach() { bar.close(); if (bar.el.parentNode) bar.el.parentNode.removeChild(bar.el); } });
      // phone (ED65): the toolbar is fixed just above the on-screen keyboard (visualViewport), never over the text
      const vv = win.visualViewport;
      if (vv && typeof win.matchMedia === 'function' && win.matchMedia(PHONE_BAR_QUERY).matches && bar.el.style) {
        const place = () => { bar.el.style.bottom = `${Math.max(0, Math.round((win.innerHeight || 0) - vv.height - (vv.offsetTop || 0)))}px`; };
        bar.el.classList.add('is-phone');
        place();
        vv.addEventListener('resize', place);
        vv.addEventListener('scroll', place);
        now.handles.push({ detach() { vv.removeEventListener('resize', place); vv.removeEventListener('scroll', place); } });
      }
      // the toolbar opened room above the text: a click's caret lands where it was aimed
      if (lastClick && typeof bar.el.getBoundingClientRect === 'function') {
        const h = bar.el.getBoundingClientRect().height || 0;
        lastClick = { x: lastClick.x, y: lastClick.y + h };
      }
      if (editor !== 'code') now.targets = targets;
      placeCaret(targets);
      report(o.index, editor, '');
    }

    /* The typed parts of an open block, and the typing engine on each (also after an undo restored the block). */
    function targetsOf(root, editor) {
      return editor === 'code' ? Array.from(root.querySelectorAll('pre > code')).slice(0, 1)
        : editor === 'box' ? Array.from(root.querySelectorAll('.adm > *')).filter((n) => classesOf(n).indexOf('adm-title') < 0)
          : Array.from(root.children);
    }
    function attachTargets(now) {
      const plain = now.editor === 'code';
      for (const h of now.typing) h.detach();
      now.typing = [];
      const targets = targetsOf(now.root, now.editor);
      for (const t of targets) {
        t.setAttribute('contenteditable', plain ? 'plaintext-only' : 'true');
        t.setAttribute('spellcheck', plain ? 'false' : 'true');
        // round 2 (R2b): a restore point before every edit; the Edit menu's Undo/Redo go to the parent's history
        now.typing.push(win.HCEditorType.attach(t, { plain, onChange: () => schedule(now), onBefore: () => noteBefore(now),
          onHistory: (op) => HC.post('hc-key', { op }) }));
        if (plain) {
          const onInput = () => schedule(now);
          const onBeforePlain = (ev) => { if (!/^history/.test(String(ev && ev.inputType))) noteBefore(now); };
          t.addEventListener('beforeinput', onBeforePlain);
          t.addEventListener('input', onInput);
          now.typing.push({ detach() { t.removeEventListener('input', onInput); t.removeEventListener('beforeinput', onBeforePlain); } });
        }
      }
      if (now.editor !== 'code') now.targets = targets;
      return targets;
    }

    /* ---- Undo / Redo restore points (round 2, R2b) ----
       Before an edit to an open block, the frame keeps what the block shows (its edit root's HTML, with the
       suggestion marks, and the Markdown last sent) as a restore point, and tells the parent its id
       (hc-history). One restore point per burst: typing in the same block within BURST_MS is one step; a
       format, a note-box type or a code language is always its own. The parent keeps the one ordered history
       (js/editor.js) and, to undo a typing step, sends hc-editor.cmd {restore}: the block shows the restore point
       again (the engine re-attached when it is open), and what it showed before is kept as `save` for Redo. The
       restore points live for one frame load. */
    const BURST_MS = 1000;
    const SNAP_MAX = 1000;             // the parent keeps at most 200 steps each way; a missing point redraws (below)
    const snaps = new Map();
    let snapSeq = 0;
    let burst = null;
    let lastCmd = 0;
    const loadTag = Math.random().toString(36).slice(2, 7).replace(/[^a-z0-9]/g, 'x');
    function keepSnap(id, index, root) {
      snaps.set(id, { index, html: root.innerHTML, md: root.getAttribute('data-hc-md-sent') });
      if (snaps.size > SNAP_MAX) snaps.delete(snaps.keys().next().value);
    }
    function noteBefore(now, own) {
      if (!now || !now.root || openNow !== now) return;
      const t = Date.now();
      if (!own && burst && burst.index === now.index && t - burst.at < BURST_MS) { burst.at = t; return; }
      snapSeq += 1;
      const id = `f${loadTag}-${snapSeq}`;
      keepSnap(id, now.index, now.root);
      burst = own ? null : { index: now.index, at: t };
      HC.post('hc-history', { index: now.index, snap: id });
    }
    function restoreSnap(c) {
      const w = wrapperFor(c.index);
      const root = w ? Array.from(w.childNodes).find((n) => n.nodeType === ELEMENT && classesOf(n).indexOf('hc-edit-root') >= 0) : null;
      const back = snaps.get(c.snap);
      if (!root || !back || back.index !== c.index) { HC.post('hc-key', { op: 'redraw' }); return; }   // the parent draws the page again
      keepSnap(c.save, c.index, root);
      burst = null;
      root.innerHTML = back.html;
      if (typeof back.md === 'string') root.setAttribute('data-hc-md-sent', back.md);
      postMarks(c.index, root);                   // U4 (D6): the kept marks follow the undo
      const now = openNow && openNow.index === c.index ? openNow : null;
      if (now) {
        now.root = root;
        if (typeof back.md === 'string') now.sent = back.md;      // the parent already holds this text: nothing to send
        const targets = attachTargets(now);
        placeCaret(targets);
      } else {
        for (const t of Array.from(root.querySelectorAll('[contenteditable]'))) t.removeAttribute('contenteditable');
      }
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
      // D9 (ED32): no one-click loss — the removal is an undo step (js/editor.js), and says so for 8 seconds
      const pill = win.HCEditorBlocks.removedPill(doc, { onUndo: () => HC.post('hc-key', { op: 'undo' }),
        setTimeout: (fn, ms) => win.setTimeout(fn, ms) });
      now.w.appendChild(pill);
    }

    /* B / I / Code / Link from the open block's toolbar (D8) and the keys (Cmd/Ctrl+E, +K), as suggestions. */
    function formatIn(now, what, href, range) {
      const sel = doc.getSelection ? doc.getSelection() : null;
      if (!now || openNow !== now || !now.targets || !sel) return;
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
      noteBefore(now, true);
      win.HCEditorType.format(host, what, href);
      schedule(now);
      if (now.bar) now.bar.refresh();
    }
    // the List button follows the caret (bulleted / numbered / none)
    if (doc.addEventListener) doc.addEventListener('selectionchange', () => { if (openNow && openNow.bar) openNow.bar.refresh(); });

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
      postMarks(now.index, now.root);
    }

    /* ---- U4 (D6, ED30): the marks survive a reload ----
       After every edit the block's marked HTML goes to the parent (hc-marks; '' when no mark is left), which keeps
       it beside the draft. After a load the parent sends, for every block the draft changed, that HTML with the
       draft's and the base's text (hc-editor.marks); js/editor-md.js restoreBlock checks it both ways (else paints a
       word diff) and the block shows it as its edit root, so typing goes on from the marks. Once per block per load. */
    const MAX_MARKS_HTML = 200000;
    function postMarks(index, root) {
      if (!root || typeof root.innerHTML !== 'string') return;
      const marked = typeof root.querySelector === 'function' ? root.querySelector('[data-hc-sug], [data-hc-list], [data-hc-was]') : null;
      const html = marked ? root.innerHTML : '';
      if (html.length <= MAX_MARKS_HTML) HC.post('hc-marks', { index, html });
    }
    const restored = new Set();
    function restoreMarks(s) {
      const list = s && Array.isArray(s.marks) ? s.marks.filter((m) => !restored.has(`${m.index}|${m.md}`)) : [];
      if (!list.length) return;
      for (const m of list) restored.add(`${m.index}|${m.md}`);
      loadScripts().then((ok) => {
        const M = win.HCEditorMd;
        const S = win.HCSanitize;
        if (!ok || !M || typeof M.restoreBlock !== 'function') return;
        for (const m of list) {
          if (openNow && openNow.index === m.index) continue;          // the open block's DOM is the truth
          const w = wrapperFor(m.index);
          if (!w || Array.from(w.childNodes).some((c) => c.nodeType === ELEMENT && classesOf(c).indexOf('hc-edit-root') >= 0)) continue;
          let out = null;
          try {
            const html = m.html && S && typeof S.clean === 'function' ? S.clean(m.html, { marks: true }) : '';
            out = M.restoreBlock({ html, md: m.md, orig: m.orig, kind: m.kind });
          } catch (e) { out = null; }
          if (!out) continue;
          const fresh = doc.createElement('div');
          fresh.className = 'hc-edit-root';
          fresh.setAttribute('data-hc-md-sent', m.md);
          fresh.setAttribute('data-hc-restored', out.how);
          while (out.root.firstChild) fresh.appendChild(out.root.firstChild);
          for (const c of Array.from(w.childNodes)) {
            if (sentinelIndex(c, prefix) !== null || classesOf(c).indexOf('hc-note-card') >= 0) continue;
            w.removeChild(c);
          }
          w.appendChild(fresh);
        }
        queueRects();
      });
    }

    /* ---- U4 (D8, ED18): Comment — a note for the reviewer beside the block; the text stays as it is ----
       The card ("Your note") sits in the margin while editing; every change goes to the parent (hc-note), which keeps
       it in the draft (notes: [{key, text}]) and sends my notes back (hc-editor.notes) after a load. */
    const NOTE_MAX = 2000;
    const noteCards = new Map();       // block index -> {card, area, local}
    function dropNote(index) {
      const c = noteCards.get(index);
      if (c && c.card.parentNode) c.card.parentNode.removeChild(c.card);
      noteCards.delete(index);
    }
    function noteCard(index, focus) {
      const w = wrapperFor(index);
      if (!w) return null;
      let c = noteCards.get(index);
      if (!c || c.card.parentNode !== w) {
        if (c) dropNote(index);
        const card = doc.createElement('aside');
        card.className = 'hc-note-card';
        card.setAttribute('contenteditable', 'false');
        card.setAttribute('aria-label', 'Your note');
        const head = doc.createElement('p');
        head.className = 'hc-note-head';
        head.textContent = 'Your note';
        const area = doc.createElement('textarea');
        area.className = 'hc-note-text';
        area.setAttribute('aria-label', 'Your note for the reviewer');
        area.setAttribute('maxlength', String(NOTE_MAX));
        area.setAttribute('rows', '3');
        area.setAttribute('placeholder', 'A note for the reviewer. The text stays as it is.');
        const rm = button('hc-note-remove', 'Remove your note', 'Remove');
        const hold = (e) => { if (e && e.stopPropagation) e.stopPropagation(); };   // a click here never picks the block
        card.addEventListener('click', hold);
        card.addEventListener('mousedown', hold);
        card.addEventListener('keydown', hold);
        area.addEventListener('input', () => {
          const cc = noteCards.get(index);
          if (cc) cc.local = true;
          HC.post('hc-note', { index, text: String(area.value || '').slice(0, NOTE_MAX) });
        });
        area.addEventListener('blur', () => { if (!String(area.value || '').trim()) { dropNote(index); HC.post('hc-note', { index, text: '' }); } });
        rm.addEventListener('click', (e) => { hold(e); dropNote(index); HC.post('hc-note', { index, text: '' }); });
        card.appendChild(head);
        card.appendChild(area);
        card.appendChild(rm);
        w.appendChild(card);
        c = { card, area, local: true };
        noteCards.set(index, c);
      }
      if (focus && typeof c.area.focus === 'function') c.area.focus({ preventScroll: true });
      return c;
    }
    function syncNotes(s) {
      const want = new Map((s && Array.isArray(s.notes) ? s.notes : []).map((n) => [n.index, n.text]));
      for (const [i, c] of Array.from(noteCards)) {
        if (!want.has(i) && !c.local) dropNote(i);
      }
      for (const [i, text] of want) {
        const c = noteCard(i, false);
        if (!c) continue;
        c.local = false;
        if (doc.activeElement !== c.area) c.area.value = text;
      }
    }

    /* Typing stops; the DOM (and its suggestion marks) stays on the page as it is. */
    function closeBlock(tellParent) {
      const now = openNow;
      if (!now) return;
      flush(now);                                 // anything not yet sent (a composition that just ended)
      openNow = null;
      for (const hd of now.handles) hd.detach();
      for (const hd of now.typing || []) hd.detach();
      if (now.root) for (const t of Array.from(now.root.querySelectorAll('[contenteditable]'))) t.removeAttribute('contenteditable');
      now.w.classList.remove('hc-open', 'hc-open-md');
      if (tellParent) report(now.index, 'closed', '');
    }

    // ------------------------------------------- the Team page's people tools (round 2, R5) ---
    /* js/editor-people.js (HCEditorPeople) holds them; it is loaded once, on demand, when the Team page
       (#people-root) is shown with Editor mode on (hc-editor.people), never elsewhere. Until it has loaded there
       is nothing to undo: no card is wired, no "+" card or mark is drawn. */
    let people = null;
    let peopleP = null;
    const peopleRoot = () => doc.getElementById ? doc.getElementById('people-root') : null;
    function loadPeople() {
      if (peopleP) return peopleP;
      peopleP = new Promise((resolve) => {
        if (win.HCEditorPeople) { resolve(true); return; }
        const el = doc.createElement('script');
        el.src = PEOPLE_SCRIPT;
        el.addEventListener('load', () => resolve(Boolean(win.HCEditorPeople)));
        el.addEventListener('error', () => resolve(false));
        (doc.head || doc.body).appendChild(el);
      });
      return peopleP;
    }
    function syncPeople(s) {
      if (people) { people.sync(s); return; }
      if (!(peopleRoot() && s.on && s.people)) return;
      loadPeople().then((ok) => {
        if (!ok || people) return;
        people = win.HCEditorPeople.create({ win, doc, HC, inView, classesOf });
        if (state) people.sync(state);
      });
    }

    HC.onEditor((s) => {
      // the site's theme (the sandboxed frame cannot read it): the one attribute js/app.js's toggle sets
      const root = doc.documentElement;
      if (root && s.theme === 'light') root.setAttribute('data-theme', 'light');
      else if (root && s.theme === 'dark') root.removeAttribute('data-theme');
      if (!state || state.selected !== s.selected) scrolledTo = null;
      state = s;
      apply();
      if (s.cmd && s.cmd.n !== lastCmd) { lastCmd = s.cmd.n; restoreSnap(s.cmd); }
      if (s.focus && s.focus.n !== lastFocus) { lastFocus = s.focus.n; focusBlock(s.focus.index); }
    });

    /* U3 (ED9, ED47): a proposal opened from its review row: its first change is scrolled into view, once
       per n (the reader may then scroll away). */
    let lastFocus = null;
    function focusBlock(index) {
      const root = doc.getElementById('content') || doc.body;
      for (const body of pageBodies(root, prefix)) {
        for (const w of blocksIn(body)) {
          if (indexOfBlock(w) !== index || typeof w.scrollIntoView !== 'function') continue;
          try { w.scrollIntoView({ block: 'center' }); } catch (e) { /* a courtesy */ }
          return;
        }
      }
    }

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
        if (!sel || sel.isCollapsed || !sel.rangeCount || !openNow.targets.some((t) => t.contains(sel.anchorNode)) || !openNow.bar) return;
        e.preventDefault();
        if (k === 'e') formatIn(openNow, 'code');
        else openNow.bar.openLink();
      });
      // round 2 (R2b): Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z (or Ctrl+Y) go to the parent's one history; a text field
      // (the Markdown box, the link address) keeps its own
      doc.addEventListener('keydown', (e) => {
        if (!e || !state || !state.on || !(e.metaKey || e.ctrlKey) || e.altKey) return;
        const k = String(e.key || '').toLowerCase();
        const op = k === 'z' ? (e.shiftKey ? 'redo' : 'undo') : (k === 'y' && e.ctrlKey && !e.metaKey ? 'redo' : null);
        if (!op) return;
        const t = e.target;
        if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
        e.preventDefault();
        HC.post('hc-key', { op });
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
           samples, log, loadedAt, nonce16, now, rects}: this document's scrollY
           since it loaded, as 16 ms samples [msSinceLoad, scrollY] (sample 0
           taken here, at create) and as an ordered event log {seq, why,
           scrollY, scrollHeight, innerHeight} written on create, on every
           change inside #content and on every scroll event (timers do not
           fire under headless Chrome's virtual time while fetches are
           pending; the log still keeps the order). Both stop growing at
           WALK_CAP entries; `now` is scrollY at the moment of the answer;
           `rects` {content, heading} is where #content (with its computed
           padding, `pad`) and its first h1 are drawn in this document (the
           walk's on-geometry step).
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
          // U7's on-geometry step: where this document's content column and its first heading are drawn
          const box = (n) => {
            if (!n || typeof n.getBoundingClientRect !== 'function') return null;
            const r = n.getBoundingClientRect();
            return { left: r.left, top: r.top, width: r.width, height: r.height };
          };
          const col = doc.getElementById('content');
          const rects = { content: box(col), heading: box(col && col.querySelector ? col.querySelector('h1') : null) };
          if (rects.content && typeof win.getComputedStyle === 'function') {
            const cs = win.getComputedStyle(col);
            rects.content.pad = { left: parseFloat(cs.paddingLeft) || 0, right: parseFloat(cs.paddingRight) || 0,
              top: parseFloat(cs.paddingTop) || 0 };
          }
          e.source.postMessage({ type: 'hc-walk-scroll-samples', samples: samples.map((x) => x.slice()),
            log: log.map((x) => Object.assign({}, x)), loadedAt, nonce16: prefix, now: scrollYNow(), rects }, e.origin);
          return;
        }
        if (d.type === 'hc-walk-u4') { walkU4(d, e); return; }        // U4's steps (below)
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
        const row = open ? Array.from(openPicker.picker.childNodes).find((n) => classesOf(n).indexOf('hc-pick-row') >= 0) : null;
        const kinds = row ? Array.from(row.childNodes).map((b) => b.getAttribute('data-kind')) : [];
        e.source.postMessage({ type: 'hc-walk-picker-open', index: d.index, open, kinds }, e.origin);
      });
    }

    /* TEST-ONLY (U4's walk steps, under the same localhost-and-walk condition as above): {type: 'hc-walk-u4', op}
       answers {type: 'hc-walk-u4-state', op, open, bar, items, menu, notes, restored, sug}. op 'type' types a sentence
       at the end of the open block (the typing engine's own insert), 'menu' clicks the toolbar's first item (Type ▾ /
       Language ▾), 'comment' clicks Comment and writes a note; 'state' only answers. */
    function walkU4(d, e) {
      const now = openNow;
      const bar = now && now.bar ? now.bar.el : null;
      const row = bar ? Array.from(bar.childNodes).find((n) => classesOf(n).indexOf('hc-fb-row') >= 0) : null;
      const items = row ? Array.from(row.childNodes) : [];
      if (d.op === 'type' && now && now.targets && now.targets.length) {
        const t = now.targets[now.targets.length - 1];
        const sel = doc.getSelection();
        const r = doc.createRange();
        r.selectNodeContents(t);
        r.collapse(false);
        sel.removeAllRanges();
        sel.addRange(r);
        noteBefore(now);
        win.HCEditorType.insert(t, ' The walk typed this sentence.');
        schedule(now);
      } else if (d.op === 'menu' && items[0]) items[0].click();
      else if (d.op === 'comment' && now) {
        const c = noteCard(now.index, true);
        if (c) { c.area.value = 'A note from the walk: please check this step.'; c.area.dispatchEvent(new win.Event('input')); }
      }
      if (bar && typeof bar.scrollIntoView === 'function') { try { bar.scrollIntoView({ block: 'center' }); } catch (err) { /* a courtesy */ } }
      const menu = bar ? Array.from(bar.childNodes).find((n) => classesOf(n).indexOf('hc-boxmenu') >= 0) : null;
      const root = doc.getElementById('content') || doc.body;
      e.source.postMessage({ type: 'hc-walk-u4-state', op: d.op, open: now ? { index: now.index, editor: now.editor } : null,
        bar: Boolean(bar && bar.parentNode), items: items.map((b) => b.getAttribute('aria-label') || b.textContent),
        menu: menu ? Array.from(menu.childNodes).filter((n) => n.tagName === 'BUTTON').map((n) => n.textContent) : [],
        notes: noteCards.size, restored: Array.from(root.querySelectorAll('[data-hc-restored]')).map((n) => n.getAttribute('data-hc-restored')),
        sug: root.querySelectorAll('[data-hc-sug]').length }, e.origin);
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

  // ===================================================================== facts (U6, plan D17 and D11) ===
  /* A project page in Editor mode. js/app.js marks the title, the one-line description, the status and the
     repositories with data-hc-fact (name | tagline | status | repos; status and repos carry data-hc-value).
     hc-editor.facts says what this person may do here:
       edit    a click on a fact edits it in place: the title and the line become one-line text (Enter or
               leaving keeps it, Escape puts it back), the status a small menu of facts.statuses, the
               repositories a list to remove from and add to by name (Done keeps it). A change posts
               hc-facts {field, value}; the parent writes the facts draft and draws the page again.
       lock    a quiet line under the title, "Only this project's editors can change it · Request edit
               access" (the button posts hc-access-ask), the not-allowed cursor (css/editor.css), and the
               same line as a short notice on a click in the page.
       create  the Projects page's "+ New project" card is shown; a click posts hc-new-project.
     One instance per document (factsFor); sync(state) runs on every apply and changes the page only where
     it differs, so the MutationObserver that calls apply settles. */
  const FACTS_TOOLS = typeof WeakMap === 'function' ? new WeakMap() : null;
  function factsFor(win, doc, HC) {
    let f = FACTS_TOOLS && FACTS_TOOLS.get(doc);
    if (!f) {
      f = factsTools(win, doc, HC);
      if (FACTS_TOOLS) FACTS_TOOLS.set(doc, f);
    }
    return f;
  }
  const FACT_FIELDS = Object.freeze(['name', 'tagline', 'status', 'repos']);
  const FACT_LABELS = Object.freeze({ name: 'the title', tagline: 'the one-line description', status: 'the status',
    repos: 'the repositories' });
  const LOCK_TEXT = 'Only this project\'s editors can change it';
  const ACCESS_LABEL = 'Request edit access';
  const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
  const TOAST_MS = 3200;

  function factsTools(win, doc, HC) {
    let st = null;
    let open = null;               // {field, node, close(keep)}
    let toast = null;
    let toastTimer = null;
    let docWired = false;
    const wired = typeof WeakSet === 'function' ? new WeakSet() : new Set();
    const textWired = typeof WeakSet === 'function' ? new WeakSet() : new Set();
    const isEl = (n) => n && n.nodeType === ELEMENT;
    const walk = (root, pred, out) => {
      for (const c of Array.from((root && root.childNodes) || [])) {
        if (!isEl(c)) continue;
        if (pred(c)) out.push(c);
        walk(c, pred, out);
      }
      return out;
    };
    const content = () => (doc.getElementById ? doc.getElementById('content') : null);
    const facts = () => {
      const out = {};
      for (const n of walk(content(), (c) => FACT_FIELDS.indexOf(c.getAttribute('data-hc-fact')) >= 0, [])) {
        const f = n.getAttribute('data-hc-fact');
        if (!out[f]) out[f] = n;
      }
      return out;
    };
    const el = (tag, cls, text) => {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (text) e.textContent = text;
      return e;
    };
    const btn = (cls, text, label) => {
      const b = el('button', cls, text);
      b.type = 'button';
      b.setAttribute('type', 'button');
      if (label) b.setAttribute('aria-label', label);
      return b;
    };
    const stop = (e) => { if (e && e.stopPropagation) e.stopPropagation(); if (e && e.preventDefault) e.preventDefault(); };
    const detach = (n) => { if (n && n.parentNode) n.parentNode.removeChild(n); };
    const may = () => Boolean(st && st.on && st.facts && st.facts.edit);
    const locked = () => Boolean(st && st.on && st.facts && st.facts.lock);
    const valueOf = (n) => String(n.getAttribute('data-hc-value') || '');
    const post = (field, value) => HC.post('hc-facts', { field, value });

    // ---- the title and the one-line description: one line of text in place
    function openText(field, node) {
      const was = node.textContent;
      node.setAttribute('contenteditable', 'true');
      node.setAttribute('spellcheck', 'true');
      node.classList.add('hc-fact-editing');
      const close = (keep) => {
        if (!open || open.node !== node) return;
        open = null;
        node.removeAttribute('contenteditable');
        node.removeAttribute('spellcheck');
        node.classList.remove('hc-fact-editing');
        const now = String(node.textContent || '').replace(/\s+/g, ' ').trim();
        if (!keep || now === was.trim()) { node.textContent = was; return; }
        post(field, now);
      };
      open = { field, node, close };
      if (!textWired.has(node)) {
        textWired.add(node);
        node.addEventListener('keydown', (e) => {
          if (!open || open.node !== node) return;
          if (e.key === 'Enter') { stop(e); open.close(true); } else if (e.key === 'Escape') { stop(e); open.close(false); }
        });
        node.addEventListener('blur', () => { if (open && open.node === node) open.close(true); });
      }
      if (typeof node.focus === 'function') node.focus();
      const sel = doc.getSelection ? doc.getSelection() : null;
      if (sel && doc.createRange) {
        const r = doc.createRange();
        r.selectNodeContents(node);
        sel.removeAllRanges();
        sel.addRange(r);
      }
    }

    // ---- the status: a small menu of the allowed values
    function openStatus(node) {
      const now = valueOf(node);
      const menu = el('div', 'hc-fact-menu');
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', 'Status');
      const close = () => { if (open && open.node === node) open = null; detach(menu); node.classList.remove('hc-fact-editing'); };
      for (const s of (st.facts.statuses || [])) {
        const b = btn('hc-fact-opt', s);
        b.setAttribute('role', 'menuitemradio');
        b.setAttribute('aria-checked', s === now ? 'true' : 'false');
        b.setAttribute('data-status', s);
        b.addEventListener('click', (e) => { stop(e); close(); if (s !== now) post('status', s); });
        menu.appendChild(b);
      }
      menu.addEventListener('click', stop);
      menu.addEventListener('keydown', (e) => { if (e && e.key === 'Escape') { stop(e); close(); } });
      node.classList.add('hc-fact-editing');
      node.appendChild(menu);
      open = { field: 'status', node, close };
      const first = menu.childNodes[0];
      if (first && typeof first.focus === 'function') first.focus();
    }

    // ---- the repositories: remove by name, add by name, Done
    function openRepos(node) {
      const was = valueOf(node).split(/\s+/).filter(Boolean);
      let names = was.slice();
      const panel = el('div', 'hc-fact-repos');
      panel.setAttribute('role', 'group');
      panel.setAttribute('aria-label', 'Repositories');
      const list = el('ul', 'hc-fact-repo-list');
      const input = el('input', 'hc-fact-repo-input');
      input.setAttribute('type', 'text');
      input.setAttribute('placeholder', 'Repository name');
      input.setAttribute('aria-label', 'Add a repository by name');
      input.setAttribute('autocomplete', 'off');
      const add = btn('hc-fact-btn', 'Add');
      const problem = el('p', 'hc-fact-problem');
      problem.hidden = true;
      const done = btn('hc-fact-btn hc-fact-done', 'Done');
      const cancel = btn('hc-fact-btn', 'Cancel');
      const draw = () => {
        while (list.childNodes.length) list.removeChild(list.childNodes[0]);
        for (const n of names) {
          const li = el('li', 'hc-fact-repo');
          li.setAttribute('data-repo', n);
          li.appendChild(el('span', 'hc-fact-repo-name', n));
          const x = btn('hc-fact-x', '×', `Remove ${n}`);
          x.addEventListener('click', (e) => { stop(e); names = names.filter((m) => m !== n); draw(); });
          li.appendChild(x);
          list.appendChild(li);
        }
      };
      const say = (t) => { problem.textContent = t || ''; problem.hidden = !t; };
      const addNow = () => {
        const n = String(input.value || '').trim();
        if (!n) return;
        if (!REPO_NAME.test(n)) { say(`"${n.slice(0, 60)}" is not a repository name (letters, digits, . _ -)`); return; }
        if (names.indexOf(n) >= 0) { say(`${n} is already listed`); return; }
        names.push(n);
        input.value = '';
        say('');
        draw();
      };
      const close = (keep) => {
        if (open && open.node === node) open = null;
        detach(panel);
        node.classList.remove('hc-fact-editing');
        if (keep && names.join(' ') !== was.join(' ')) post('repos', names.slice());
      };
      add.addEventListener('click', (e) => { stop(e); addNow(); });
      input.addEventListener('keydown', (e) => { if (e && e.key === 'Enter') { stop(e); addNow(); } });
      done.addEventListener('click', (e) => { stop(e); close(true); });
      cancel.addEventListener('click', (e) => { stop(e); close(false); });
      panel.addEventListener('click', (e) => { if (e && e.stopPropagation) e.stopPropagation(); });
      panel.addEventListener('keydown', (e) => { if (e && e.key === 'Escape') { stop(e); close(false); } });
      const row = el('div', 'hc-fact-repo-add');
      row.appendChild(input);
      row.appendChild(add);
      const actions = el('div', 'hc-fact-actions');
      actions.appendChild(cancel);
      actions.appendChild(done);
      [list, row, problem, actions].forEach((n) => panel.appendChild(n));
      draw();
      node.classList.add('hc-fact-editing');
      node.appendChild(panel);
      open = { field: 'repos', node, close };
      if (typeof input.focus === 'function') input.focus();
    }

    function openFact(field, node) {
      if (!may() || (open && open.node === node)) return;
      if (open) open.close(open.field === 'name' || open.field === 'tagline');   // typed text is kept; a menu or list is not
      if (field === 'name' || field === 'tagline') openText(field, node);
      else if (field === 'status') openStatus(node);
      else if (field === 'repos') openRepos(node);
    }

    function wire(field, node) {
      if (wired.has(node)) return;
      wired.add(node);
      node.addEventListener('click', (e) => {
        if (!may()) return;
        // inside the open field (its text, its menu, its panel) the click is the field's own
        if (open && open.node === node) return;
        stop(e);
        openFact(field, node);
      });
      node.addEventListener('keydown', (e) => {
        if (!may() || (open && open.node === node) || !e || (e.key !== 'Enter' && e.key !== ' ')) return;
        stop(e);
        openFact(field, node);
      });
    }

    // ---- the lock line and its notice
    function lockLine() {
      const p = el('p', 'hc-lock-line');
      p.setAttribute('data-hc-lock', '');
      p.appendChild(el('span', 'hc-lock-text', `${LOCK_TEXT} · `));
      const ask = btn('hc-lock-ask', ACCESS_LABEL);
      ask.setAttribute('data-action', 'access-ask');
      ask.addEventListener('click', (e) => { stop(e); HC.post('hc-access-ask'); });
      p.appendChild(ask);
      return p;
    }
    function showToast() {
      if (!doc.body) return;
      if (!toast) {
        toast = el('div', 'hc-lock-toast', `${LOCK_TEXT}.`);
        toast.setAttribute('role', 'status');
        doc.body.appendChild(toast);
      }
      toast.hidden = false;
      if (toastTimer !== null && typeof win.clearTimeout === 'function') win.clearTimeout(toastTimer);
      toastTimer = win.setTimeout(() => { toastTimer = null; if (toast) toast.hidden = true; }, TOAST_MS);
    }
    const inside = (n, pred) => { for (let x = n; x && x !== doc.body; x = x.parentNode) if (isEl(x) && pred(x)) return true; return false; };
    function onDocClick(e) {
      const t = e && e.target;
      if (open && !(t && inside(t, (x) => x === open.node))) open.close(true);
      if (!locked() || !t) return;
      if (inside(t, (x) => x.tagName === 'A' || x.tagName === 'BUTTON' || classesOf(x).indexOf('hc-lock-line') >= 0)) return;
      if (inside(t, (x) => classesOf(x).indexOf('project-page') >= 0)) showToast();
    }

    function sync(s) {
      st = s;
      if (!docWired && doc.addEventListener) { docWired = true; doc.addEventListener('click', onDocClick); }
      const f = facts();
      const can = may();
      if (!can && open) open.close(false);
      for (const field of FACT_FIELDS) {
        const node = f[field];
        if (!node) continue;
        if (can) {
          wire(field, node);
          if (!node.classList.contains('hc-fact')) node.classList.add('hc-fact');
          if (node.getAttribute('tabindex') !== '0') node.setAttribute('tabindex', '0');
          const tip = `Click to change ${FACT_LABELS[field]}`;
          if (node.getAttribute('title') !== tip) node.setAttribute('title', tip);
        } else if (node.classList.contains('hc-fact')) {
          node.classList.remove('hc-fact');
          node.removeAttribute('tabindex');
          node.removeAttribute('title');
        }
      }
      if (!walkWired && (Object.keys(f).length || walk(content(), (c) => c.getAttribute('data-hc-new-project') !== null, []).length)) wireWalk();
      // the lock line, right under the title
      const title = f.name;
      const had = walk(content(), (c) => classesOf(c).indexOf('hc-lock-line') >= 0, []);
      if (locked() && title && title.parentNode) {
        if (!had.length) title.parentNode.insertBefore(lockLine(), title.nextSibling);
      } else had.forEach(detach);
      if (!locked() && toast) toast.hidden = true;
      // "+ New project" on the Projects page
      const card = walk(content(), (c) => c.getAttribute('data-hc-new-project') !== null, [])[0];
      if (card) {
        const show = Boolean(s.on && s.facts && s.facts.create);
        const row = card.parentNode;
        if (row && show && row.getAttribute('hidden') !== null) { row.removeAttribute('hidden'); row.hidden = false; }
        if (row && !show && row.getAttribute('hidden') === null) { row.setAttribute('hidden', ''); row.hidden = true; }
        if (!wired.has(card)) {
          wired.add(card);
          card.addEventListener('click', (e) => { if (st && st.on && st.facts && st.facts.create) { stop(e); HC.post('hc-new-project'); } });
        }
      }
    }

    /* TEST-ONLY, for the localhost walk (tools/tests/editor_walk.html, the U6 steps), on the same terms as the
       picker hook above (localhost / 127.0.0.1, a top window that is not the parent): {type: 'hc-walk-facts',
       click} clicks that fact (name | tagline | status | repos) or the "+ New project" card (new-project) the
       real way and answers {type: 'hc-walk-facts-state', fields (the facts that can be changed), editing (the
       open one), lock (the lock line's text), cursor (the title's computed cursor), card (the card shown)}.
       The listener is added on the first sync that finds a fact or the card (a project page, the Projects
       page), so other pages keep the picker's one listener. Anywhere else no listener exists. */
    let walkWired = false;
    function wireWalk() {
      if (walkWired) return;
      walkWired = true;
      const host = String((win.location && win.location.hostname) || '');
      if (!((host === 'localhost' || host === '127.0.0.1') && win.top && win.parent && win.top !== win.parent)) return;
      win.addEventListener('message', (e) => {
        const d = e && e.data;
        if (!e || e.source !== win.top || !d || typeof d !== 'object' || d.type !== 'hc-walk-facts') return;
        const f = facts();
        const node = FACT_FIELDS.indexOf(d.click) >= 0 ? f[d.click] : null;
        if (node && !(open && open.node === node)) node.click();
        if (node && typeof node.scrollIntoView === 'function') { try { node.scrollIntoView({ block: 'center' }); } catch (x) { /* a courtesy */ } }
        const line = walk(content(), (c) => classesOf(c).indexOf('hc-lock-line') >= 0, [])[0];
        const card = walk(content(), (c) => c.getAttribute('data-hc-new-project') !== null, [])[0];
        if (d.click === 'new-project' && card) card.click();
        e.source.postMessage({ type: 'hc-walk-facts-state', fields: FACT_FIELDS.filter((x) => f[x] && f[x].classList.contains('hc-fact')),
          editing: open ? open.field : null, lock: line ? line.textContent : null,
          cursor: f.name && typeof win.getComputedStyle === 'function' ? String(win.getComputedStyle(f.name).cursor || '') : null,
          card: Boolean(card && card.parentNode && card.parentNode.getAttribute('hidden') === null) }, e.origin);
      });
    }

    return Object.freeze({ sync, open: () => (open ? open.field : null) });
  }
}());
