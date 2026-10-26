// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 23 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Draw the Editor mode's dock (the bubble at the bottom right): change count, undo, send, edit gate, fold.
/* HCDock — the Editor mode's bubble (editor UI/UX build: U0 moved it out of js/editor.js; U2 rebuilt it, plan D1,
   D4, D5, D13, D14).

   js/app.js injects this file for a signed-in session only, right before js/editor.js (never index.html: the
   public page and the sandboxed frame never load it). It reads no data file and makes no network request; all
   it knows of the editor comes through the `api` object js/editor.js hands to mount().

   What it draws (D1): one slim pill under the header, top right — [photo] [role chip] [Editor switch] [×] — and
   below it ONLY rows that say something:
     changes row   "2 pages changed" · Undo ↶ Redo ↷ · Send for review (the count opens the list of changed
                   pages: title, "N blocks", Send this page; a title goes to that page)
     review row    "3 to review" (opens the `review` panel slot, which U3 fills; until then "Loading…")
     sent row      "1 sent · waiting" (opens MY sends with their status: waiting, live, declined, seen)
   After a send: "Sent · waiting for review" with Undo for 8 seconds (the clock stops while the tab is hidden).
   The bubble folds to the photo tab when the page scrolls more than 24 px or typing starts, unless the pointer
   is in it or one of its lists is scrolling (D13); a click on the tab opens it again. Under 768 px (body.hc-phone)
   the tab is a round photo button at the bottom right and the bubble opens over the page as a bottom sheet
   (D14): × , a drag down or Escape closes it.

   The interface (window.HCDock, frozen):
     mount(host, api) -> {dock, tag, handle}
         builds the bubble and the photo tab, appends both to host (document.body), reads the folded state from
         this browser (localStorage 'hc-editor-dock'). handle is the review row's button ("N to review"):
         js/editor.js wires it too.
     refresh(view)  draws the bubble for `view` (js/editor.js builds it on every redraw):
           signedIn   a session exists          login      its login (string) or null
           on         Editor mode is on
           editing    Editor on, a page, and I may edit it
           changes    the number of changes on this page (0 when not editing)
           canUndo, canRedo   this page's history has a step back / forward
           access     the project's access answer (HCCore.accessFor's, with status) or null off project pages
           projectId  the project the page belongs to, or null
           page       the page on screen ({pageId, label, ...}) or null
           draftKey   the key of the draft on screen, or null
           chip       the role chip's words ("Admin", "Can approve 2 projects", "Can edit", "Read only") or ''
           pages      the changed pages I may send: [{key, label, blocks, unit, route}] (route null: no link)
           pageCount  how many pages changed (HCCore.pageChangeCount)
           typed      true when this redraw follows typing in the page (the bubble folds)
         then every registered panel (see panel()).
     fold(on)       on !== false: fold the bubble into the photo tab (focus the tab); fold(false): bring it back
                    (focus the switch). Remembered in this browser. On a phone: close / open the sheet.
     unfold()       a folded bubble comes back without taking the focus (a message must be seen)
     panel(name, renderFn)
                    a named slot: renderFn(view) -> a node, an array of nodes, or null, drawn into
                    div.hc-dock-panel[data-dock-panel=<name>] on every refresh; renderFn null removes the slot.
                    The slot named 'review' sits under the review row and shows whatever its renderFn returns
                    (hidden when that is nothing): js/editor.js draws there whose changes are on screen and, while
                    its review list is open, the list. Its default says "Loading…" while the dock's own 'review'
                    list is open (a page without U3's list); every other slot is drawn at the end of the bubble.
     sent(number)   a send just landed (opened, or one more commit on my open send): the sent row counts it as
                    waiting at once (the list read from GitHub replaces it later)
     offerUndo({items, run})
                    after a send: "Sent · waiting for review", one line per send (items: [{number, title, note}]),
                    and Undo for 8 s (UNDO_MS; the clock stops while document.visibilityState is 'hidden').
                    Undo calls run() -> Promise of {text, kind ('error' or not), undone: [numbers]}; its text
                    replaces the box's words
     setCount(n)    the review row's count ("N to review"; 0 hides the row; api.onCount(n) hears it first)
     loadCount()    asks api.openCount() for the count, then setCount; asks api.loadSends() for my sends
     lockParts(a, projectId, name)
                    the edit gate's lines: "You can't edit this project.", why, and Request edit access (once the
                    list is read) with its result line; the facts-file page's note uses them too
     chip()         the role chip node (js/editor.js places it after the name; refresh writes its words)
     scrolled(y)    the page frame scrolled to y (px): the same fold rule as the page's own scroll (D13); the frame
                    has no scroll message yet, so js/editor.js does not call it today
     escape()       closes one layer — an open list, else the phone sheet — and says true; false when nothing was
                    open. The one Escape key handler is js/editor.js's stack (D18), which calls this in order

   The `api` keys (every one is required; functions unless said otherwise):
     h(tag, attrs, ...kids)   js/editor.js's DOM builder (text always as text)
     store()                  this browser's localStorage, or null
     controls                 NODE: the Editor controls (who, the switch), the pill's first part
     switchBtn                NODE: the Editor switch (focused when the bubble comes back)
     closeMenu()              closes the account menu (a folded bubble hides it)
     redraw()                 js/editor.js's refreshDock(): builds the view and calls refresh(view)
     undoRedo(op)             op 'undo' | 'redo': one step of the page's history
     sendAll(key)             Send for review: every changed page I may send (key null), or only the draft `key`
                              (Send this page); one send per kind (HCCore.splitSend); resolves when done
     go(route)                opens the page at `route` (Editor stays on: the marks show)
     loadSends()              Promise of MY sends (HCCore.ownSends' rows, each with `route` or null), or null
     openSend(item)           opens the page a send of mine changed
     openReview()             the review row was clicked: js/editor.js opens or closes its review list and says true
                              (it owns that list, on a phone too); false lets the dock open its own 'review' slot
     reviewOpen()             optional: true while js/editor.js's review list is open (the row's aria-expanded)
     shown(error)             says a failure on the status line
     avatar(login, first)     the face node for a login (committed avatar or the first letter)
     accessAsk(a, projectId, name, result)   the Request edit access control (or null), its result line `result`
     onCount(n)               hears the review count
     openCount()              Promise of the count of open sends I may review, or of null when the answer is stale
*/
(function () {
  'use strict';

  const DOCK_KEY = 'hc-editor-dock';
  const UNDO_MS = 8000;          // D4: Undo stays for 8 seconds
  const UNDO_TICK_MS = 1000;     // the clock counts in steps of a second, only while the tab is seen
  const FOLD_PX = 24;            // D13: the page scrolled more than this -> the bubble folds
  const DRAG_CLOSE_PX = 80;      // D14: a drag down this far closes the sheet
  const STATUS_WORDS = Object.freeze({ waiting: 'Waiting', live: 'Live', declined: 'Declined', seen: 'Seen' });

  let api = null;
  let dock = null;         // the bubble
  let dockTag = null;      // the photo tab that brings a folded bubble back
  let pill = null;
  let chipEl = null;       // the role chip (D1: neutral, names what you can do)
  let changesRow = null;
  let dockCount = null;    // "N pages changed" (opens the list)
  let dockSend = null;     // "Send for review"
  let dockUndo = null;
  let dockRedo = null;
  let changesList = null;
  let dockLock = null;     // the edit gate on a project page
  let reviewRow = null;
  let handle = null;       // the review row's button ("N to review")
  let sentRow = null;
  let sentBtn = null;
  let sentList = null;
  let undoBox = null;
  let grab = null;         // the sheet's drag handle (phones)
  const panels = new Map();   // name -> {render, slot}
  let lastView = null;
  let reviewCount = 0;
  let open = '';           // the one list open under its row: '' | 'changes' | 'review' | 'sent'
  let sends = [];          // my sends, from api.loadSends()
  let justSent = [];       // numbers sent in this page since the last read (shown as waiting)
  let sheetOpen = false;   // phones: the sheet is up
  let lastPhone = null;
  let pointerIn = false;
  let listScrollAt = -Infinity;
  let scrollFrom = 0;
  let sending = false;
  let offer = null;        // the undo offer on screen: {left, timer, run}

  const h = (...a) => api.h(...a);
  const isPhone = () => document.body.classList.contains('hc-phone');
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const scrollY = () => Number(window.scrollY || window.pageYOffset || 0);
  const now = () => Date.now();
  const show = (el, on) => { el.hidden = !on; };

  // the undo / redo arrows (Lucide-style strokes, drawn here: no icon font), 24 px (ED6)
  function histIcon(op) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS ? document.createElementNS(ns, 'svg') : h('span', { class: 'hc-dock-glyph' });
    if (!svg.setAttribute) return svg;
    for (const [k, v] of [['viewBox', '0 0 24 24'], ['width', '24'], ['height', '24'], ['aria-hidden', 'true'], ['focusable', 'false']]) svg.setAttribute(k, v);
    const path = document.createElementNS ? document.createElementNS(ns, 'path') : null;
    if (path) {
      path.setAttribute('d', op === 'undo' ? 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11' : 'm15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13');
      svg.appendChild(path);
    }
    return svg;
  }

  function button(attrs, ...kids) {
    return h('button', Object.assign({ type: 'button' }, attrs), ...kids);
  }

  function mount(host, a) {
    api = a;
    // ---- the pill: [photo] [role chip] [Editor switch] [×] (the controls hold the photo, the name and the switch)
    chipEl = h('span', { class: 'hc-role hc-chip', title: 'What you can do on this site' });
    const x = button({ class: 'hc-dock-x', 'data-action': 'dock-collapse', 'aria-label': 'Fold the editor controls',
      title: 'Fold (the photo brings it back)' }, '×');
    x.addEventListener('click', () => fold(true));
    pill = h('div', { class: 'hc-dock-pill' }, api.controls, x);

    // ---- the changes row: "N pages changed" · ↶ ↷ · Send for review
    dockCount = button({ class: 'hc-dock-count hc-dock-rowbtn', 'data-dock-count': true, 'data-action': 'dock-changes',
      'aria-expanded': 'false' });
    dockCount.addEventListener('click', () => toggle('changes'));
    dockSend = button({ class: 'cms-btn cms-btn-primary hc-dock-send', 'data-action': 'dock-send' }, 'Send for review');
    dockSend.addEventListener('click', () => send(null));
    const mac = /Mac|iPhone|iPad/.test(String((window.navigator && window.navigator.platform) || ''));
    const keyName = mac ? '⌘' : 'Ctrl+';
    dockUndo = button({ class: 'hc-dock-hist', 'data-action': 'undo', 'aria-label': 'Undo', title: `Undo (${keyName}Z)` }, histIcon('undo'));
    dockRedo = button({ class: 'hc-dock-hist', 'data-action': 'redo', 'aria-label': 'Redo', title: `Redo (${mac ? '⇧⌘Z' : 'Ctrl+Y'})` }, histIcon('redo'));
    dockUndo.addEventListener('click', () => api.undoRedo('undo'));
    dockRedo.addEventListener('click', () => api.undoRedo('redo'));
    changesRow = h('div', { class: 'hc-dock-row hc-dock-send-wrap', 'data-dock-row': 'changes' }, dockCount,
      h('span', { class: 'hc-dock-histwrap', role: 'group', 'aria-label': 'Undo and redo' }, dockUndo, dockRedo), dockSend);
    changesList = h('ul', { class: 'hc-dock-list', 'data-dock-list': 'changes', 'aria-label': 'Changed pages' });
    changesList.hidden = true;

    // ---- the edit gate (a project page), then the review row under it (ED39)
    dockLock = h('div', { class: 'hc-dock-lock', role: 'status', 'data-dock-lock': true });
    dockLock.hidden = true;
    handle = button({ class: 'hc-dock-pages hc-dock-rowbtn', 'data-action': 'tray-open', 'aria-expanded': 'false' }, 'to review');
    // ONE owner for the click: js/editor.js's review list when it has one, else the dock's own slot
    handle.addEventListener('click', () => {
      if (api.openReview()) return;
      toggle('review');
    });
    reviewRow = h('div', { class: 'hc-dock-row', 'data-dock-row': 'review' }, handle);
    reviewRow.hidden = true;

    // ---- the sent row: my sends with their status (D5)
    sentBtn = button({ class: 'hc-dock-rowbtn', 'data-action': 'dock-sent', 'aria-expanded': 'false' });
    sentBtn.addEventListener('click', () => toggle('sent'));
    sentRow = h('div', { class: 'hc-dock-row', 'data-dock-row': 'sent' }, sentBtn);
    sentRow.hidden = true;
    sentList = h('ul', { class: 'hc-dock-list', 'data-dock-list': 'sent', 'aria-label': 'Your sends' });
    sentList.hidden = true;

    undoBox = h('div', { class: 'hc-dock-undo', role: 'status', 'data-dock-undo': true });
    undoBox.hidden = true;

    grab = h('div', { class: 'hc-sheet-grab', 'aria-hidden': 'true' });
    reviewUp = false;
    dock = h('div', { class: 'hc-dock', role: 'region', 'aria-label': 'Editor' }, grab, pill, dockLock, changesRow, changesList,
      reviewRow, sentRow, sentList, undoBox);
    dockTag = button({ class: 'hc-dock-tag', 'data-action': 'dock-expand', 'aria-label': 'Show the editor controls',
      title: 'Show the editor controls' });
    dockTag.addEventListener('click', () => fold(false));
    host.appendChild(dock);
    host.appendChild(dockTag);
    // the review list's slot (U3 fills it with panel('review', fn)); until then it says it is loading
    panels.set('review', { render: () => (open === 'review' ? h('p', { class: 'hc-dock-empty', text: 'Loading…' }) : null), slot: null });

    // D13: fold on scroll, unless the pointer is in the bubble or one of its lists is scrolling
    dock.addEventListener('pointerenter', () => { pointerIn = true; });
    dock.addEventListener('pointerleave', () => { pointerIn = false; });
    for (const list of [changesList, sentList]) list.addEventListener('scroll', () => { listScrollAt = now(); }, { passive: true });
    if (typeof window.addEventListener === 'function') window.addEventListener('scroll', onScroll, { passive: true });
    // Escape: js/editor.js's one stack (D18) listens on the document and calls escape() in its order
    sheetDrag();
    let collapsed = false;
    try { const s = api.store(); collapsed = Boolean(s && s.getItem(DOCK_KEY) === 'collapsed'); } catch (e) { collapsed = false; }
    document.body.classList.toggle('hc-dock-collapsed', collapsed);
    scrollFrom = scrollY();
    return { dock, tag: dockTag, handle };
  }

  // ---------------------------------------------------------------- fold / unfold ---
  const tucked = () => document.body.classList.contains('hc-dock-collapsed');
  /* The × and the tab (remembered in this browser); on a phone they close and open the sheet. */
  function fold(on) {
    if (isPhone()) { setSheet(!on); return; }
    document.body.classList.toggle('hc-dock-collapsed', on);
    try { const s = api.store(); if (s) s.setItem(DOCK_KEY, on ? 'collapsed' : 'open'); } catch (e) { /* this page only */ }
    if (!on) { scrollFrom = scrollY(); frameFrom = null; }
    api.redraw();
    const next = on ? dockTag : api.switchBtn;
    if (next && typeof next.focus === 'function') next.focus();
  }
  /* A message must be seen: a folded bubble comes back without taking the focus. */
  function unfoldDock() {
    if (!dock) return;
    if (isPhone()) { if (!sheetOpen) setSheet(true, true); return; }
    if (!tucked()) return;
    document.body.classList.remove('hc-dock-collapsed');
    try { const st = api.store(); if (st) st.setItem(DOCK_KEY, 'open'); } catch (e) { /* this page only */ }
    scrollFrom = scrollY();
    api.redraw();
  }
  /* D13: scrolling or typing folds the open bubble (not remembered: a reload brings it back as it was). */
  function autoFold() {
    if (!dock || dock.hidden || isPhone() || tucked() || pointerIn || now() - listScrollAt < 400) return;
    const inside = typeof document.activeElement !== 'undefined' && document.activeElement && dock.contains
      && dock.contains(document.activeElement);
    document.body.classList.add('hc-dock-collapsed');
    api.redraw();
    if (inside && typeof dockTag.focus === 'function') dockTag.focus();   // the focus never falls into a hidden box
  }
  function onScroll() { scrolledTo(scrollY(), 'page'); }
  /* The same rule for a scroll position from elsewhere (the page frame's own scroll, once the frame reports it:
     HCDock.scrolled(y)); each source keeps its own starting point. */
  let frameFrom = null;     // the frame's own starting point (null: not heard yet)
  function scrolledTo(y, from) {
    const v = Number(y);
    if (!Number.isFinite(v)) return;
    const was = from === 'page' ? scrollFrom : frameFrom;
    const keep = (at) => { if (from === 'page') scrollFrom = at; else frameFrom = at; };
    if (was === null || tucked() || isPhone()) { keep(v); return; }
    if (Math.abs(v - was) > FOLD_PX) { keep(v); autoFold(); }
  }

  // ---------------------------------------------------------------- the phone sheet ---
  function setSheet(on, quiet) {
    sheetOpen = Boolean(on);
    if (!sheetOpen) { open = ''; dock.style.transform = ''; }
    api.redraw();
    if (quiet) return;
    const next = sheetOpen ? api.switchBtn : dockTag;
    if (next && typeof next.focus === 'function') next.focus();
  }
  /* A drag down on the sheet's top closes it (transform only; it springs back when let go early). */
  function sheetDrag() {
    let from = null;
    grab.addEventListener('pointerdown', (e) => {
      if (!isPhone() || !sheetOpen) return;
      from = e.clientY;
      if (grab.setPointerCapture && e.pointerId !== undefined) { try { grab.setPointerCapture(e.pointerId); } catch (x) { /* fine */ } }
      dock.classList.add('is-dragging');
    });
    grab.addEventListener('pointermove', (e) => {
      if (from === null) return;
      const dy = Math.max(0, e.clientY - from);
      dock.style.transform = `translateY(${dy}px)`;
    });
    const end = (e) => {
      if (from === null) return;
      const dy = Math.max(0, (e && Number.isFinite(e.clientY) ? e.clientY : from) - from);
      from = null;
      dock.classList.remove('is-dragging');
      dock.style.transform = '';
      if (dy > DRAG_CLOSE_PX) setSheet(false);
    };
    grab.addEventListener('pointerup', end);
    grab.addEventListener('pointercancel', () => { from = null; dock.classList.remove('is-dragging'); dock.style.transform = ''; });
  }

  /* One layer of Escape: an open list, else the phone sheet. -> true when something closed. */
  function escape() {
    if (!dock || dock.hidden) return false;
    if (open) {
      const was = open;
      open = '';
      api.redraw();
      const back = was === 'changes' ? dockCount : was === 'review' ? handle : sentBtn;
      if (back && typeof back.focus === 'function') back.focus();
      return true;
    }
    if (isPhone() && sheetOpen) { setSheet(false); return true; }
    return false;
  }

  function toggle(name) {
    open = open === name ? '' : name;
    api.redraw();
  }

  // ---------------------------------------------------------------- send and undo ---
  function send(key) {
    if (sending) return;
    sending = true;
    api.redraw();
    Promise.resolve().then(() => api.sendAll(key)).catch(api.shown).then(() => { sending = false; api.redraw(); });
  }

  function sent(number) {
    if (Number.isInteger(number) && justSent.indexOf(number) < 0 && !sends.some((s) => s.number === number)) justSent.push(number);
    if (dock && lastView) refreshDock(lastView);
  }

  function offerUndo(o) {
    if (!dock) return;
    stopOffer();
    unfoldDock();                        // the Undo offer is a message: it must be seen
    const items = (o && Array.isArray(o.items) ? o.items : []).filter((x) => x && Number.isInteger(x.number));
    for (const it of items) {
      const s = sends.find((x) => x.number === it.number);
      if (s && it.title) s.title = String(it.title);
      else if (!s) sends.unshift({ number: it.number, title: String(it.title || ''), status: 'waiting', route: null, local: true });
      justSent = justSent.filter((n) => n !== it.number);
    }
    const undo = button({ class: 'cms-btn hc-dock-undo-btn', 'data-action': 'dock-undo' }, 'Undo');
    const lines = items.map((it) => h('li', null, h('span', { class: 'hc-dock-undo-title', text: String(it.title || '') }),
      it.note ? h('span', { class: 'hc-dock-undo-note', text: String(it.note) }) : null));
    undoBox.replaceChildren(h('div', { class: 'hc-dock-undo-head' }, h('b', { text: 'Sent · waiting for review' }), undo),
      lines.length ? h('ul', { class: 'hc-dock-undo-list' }, ...lines) : null);
    undoBox.hidden = false;
    offer = { left: UNDO_MS, timer: null, run: o && o.run };
    const mine = offer;
    undo.addEventListener('click', () => {
      if (offer !== mine) return;
      clearTimer(mine);
      undo.disabled = true;
      Promise.resolve().then(() => (typeof mine.run === 'function' ? mine.run() : null)).catch((e) => ({
        text: `Something went wrong: ${(e && e.message) || e}`, kind: 'error' })).then((r) => {
        if (offer !== mine) return;
        const out = r || {};
        const undone = Array.isArray(out.undone) ? out.undone : [];
        sends = sends.filter((s) => undone.indexOf(s.number) < 0);
        justSent = justSent.filter((n) => undone.indexOf(n) < 0);
        const p = h('p', { class: 'hc-dock-undo-said', text: String(out.text || '') });
        p.classList.toggle('is-error', out.kind === 'error');
        undoBox.replaceChildren(p);
        undoBox.hidden = !out.text;
        offer = null;
        api.redraw();
      });
    });
    tick(mine);
    if (lastView) refreshDock(lastView);
  }
  /* The undo clock: a step every second, counted only while the tab is seen (document.visibilityState). */
  function tick(mine) {
    mine.timer = window.setTimeout(() => {
      if (offer !== mine) return;
      if (document.visibilityState !== 'hidden') mine.left -= UNDO_TICK_MS;
      if (mine.left > 0) { tick(mine); return; }
      offer = null;
      undoBox.replaceChildren();
      undoBox.hidden = true;
      api.redraw();
    }, UNDO_TICK_MS);
  }
  function clearTimer(mine) {
    if (mine && mine.timer !== null && typeof window.clearTimeout === 'function') window.clearTimeout(mine.timer);
    if (mine) mine.timer = null;
  }
  function stopOffer() {
    if (offer) clearTimer(offer);
    offer = null;
  }

  // ---------------------------------------------------------------- the edit gate ---
  /* "You can't edit this project.", why, and Request edit access (only once the list is read) with its result
     line: the bubble's lines and the facts-file page's note. */
  function lockParts(a, projectId, name) {
    const result = h('p', { class: 'hc-access-result cms-action-result', role: 'status' });
    result.hidden = true;
    const ask = a.status === 'read' ? api.accessAsk(a, projectId, name, result) : null;
    return [h('p', { class: 'hc-dock-lock-head', text: window.HCCore.ACCESS_LOCKED_TEXT }), h('p', { class: 'hc-dock-lock-why', text: a.text }),
      ask, result].filter(Boolean);
  }
  /* Redrawn only when the answer changed, so a request's result stays on screen. ED41: "An admin gave you access
     to this project." is not said here (the Editor-off aside keeps its explanations). */
  let dockLockKey = '';
  function drawDockLock(a, page, projectId) {
    const quiet = Boolean(a && a.can && a.why === 'added');
    const key = a && !quiet ? [page.pageId, a.status, a.can, a.why, a.text].join('\n') : '';
    if (key === dockLockKey) return;
    dockLockKey = key;
    if (!key) { dockLock.replaceChildren(); dockLock.hidden = true; dockLock.classList.remove('is-locked'); return; }
    if (a.can) dockLock.replaceChildren(h('p', { class: 'hc-dock-lock-why', text: a.text }));
    else dockLock.replaceChildren(...lockParts(a, projectId, page.label));
    dockLock.classList.toggle('is-locked', !a.can);
    dockLock.hidden = false;
  }
  /* ED39: on a locked page the review row (and its slot) sits right under the lock, above the changes of other
     pages; everywhere else it comes after the changes. */
  let reviewUp = false;
  function moveAfter(anchor, els) {
    const kids = Array.from(dock.childNodes);
    const put = els.filter(Boolean);
    const rest = kids.slice(kids.indexOf(anchor) + 1).filter((k) => put.indexOf(k) < 0);
    for (const el of put.concat(rest)) dock.appendChild(el);
  }
  function placeReview(up) {
    if (up === reviewUp) return;
    reviewUp = up;
    const p = panels.get('review');
    moveAfter(up ? dockLock : changesList, [reviewRow, p ? p.slot : null]);
  }

  // ---------------------------------------------------------------- drawing ---
  function changesItems(v) {
    return (v.pages || []).map((p) => {
      const title = p.route
        ? button({ class: 'hc-dock-item-title', 'data-action': 'dock-go', 'data-key': p.key, text: p.label })
        : h('span', { class: 'hc-dock-item-title', text: p.label });
      if (p.route) title.addEventListener('click', () => { open = ''; api.go(p.route); if (isPhone()) setSheet(false, true); });
      const n = Number.isInteger(p.blocks) ? p.blocks : 0;
      const one = button({ class: 'cms-btn hc-dock-item-send', 'data-action': 'dock-send-page', 'data-key': p.key }, 'Send this page');
      one.disabled = sending;
      one.addEventListener('click', () => send(p.key));
      return h('li', { class: 'hc-dock-item' }, title,
        h('span', { class: 'hc-dock-item-meta', text: n ? plural(n, p.unit === 'changes' ? 'change' : 'block', p.unit === 'changes' ? 'changes' : 'blocks') : 'notes' }),
        one);
    });
  }
  function sendList() {
    const local = justSent.filter((n) => !sends.some((s) => s.number === n))
      .map((n) => ({ number: n, title: '', status: 'waiting', route: null, local: true }));
    return local.concat(sends);
  }
  function sentSummary(list) {
    const by = {};
    for (const s of list) by[s.status] = (by[s.status] || 0) + 1;
    const kinds = Object.keys(STATUS_WORDS).filter((k) => by[k]);
    const words = kinds.length === 1 ? kinds[0] : kinds.map((k) => `${by[k]} ${k}`).join(', ');
    return `${list.length} sent · ${words}`;
  }
  function sentItems(list) {
    return list.map((s) => {
      const title = button({ class: 'hc-dock-item-title', 'data-action': 'dock-open-send', 'data-number': String(s.number),
        text: s.title || 'Your latest send' });
      title.addEventListener('click', () => { open = ''; api.openSend(s); if (isPhone()) setSheet(false, true); });
      return h('li', { class: `hc-dock-item is-${s.status}` }, title,
        h('span', { class: 'hc-dock-status', 'data-status': s.status, text: STATUS_WORDS[s.status] || s.status }));
    });
  }

  function refreshDock(v) {
    if (!dock) return;
    lastView = v;
    const signedIn = v.signedIn;
    dock.hidden = !signedIn;
    const phone = isPhone();
    if (phone !== lastPhone) {
      if (lastPhone !== null) sheetOpen = false;
      if (!phone && lastPhone) {
        let collapsed = false;
        try { const s = api.store(); collapsed = Boolean(s && s.getItem(DOCK_KEY) === 'collapsed'); } catch (e) { collapsed = false; }
        document.body.classList.toggle('hc-dock-collapsed', collapsed);
      }
      lastPhone = phone;
    }
    if (phone) document.body.classList.toggle('hc-dock-collapsed', !sheetOpen);
    document.body.classList.toggle('hc-sheet-open', phone && sheetOpen && signedIn);
    if (v.typed) autoFold();
    const folded = tucked();
    dockTag.hidden = !signedIn || !folded;                 // only while folded away
    if (folded) { dock.setAttribute('inert', ''); api.closeMenu(); } else dock.removeAttribute('inert');   // nothing hidden is in the tab order
    if (folded && !phone) open = '';
    chipEl.textContent = v.chip || '';
    chipEl.hidden = !v.chip;

    // the changes row: only with changed pages (or a step to undo / redo on this page)
    const n = Number.isInteger(v.pageCount) ? v.pageCount : 0;
    const editing = Boolean(v.editing);
    const withChanges = Boolean(v.on) && n > 0;
    show(changesRow, signedIn && (withChanges || (editing && (v.canUndo || v.canRedo))));
    dockCount.textContent = n ? `${plural(n, 'page', 'pages')} changed` : '';
    dockCount.hidden = !n;
    dockSend.hidden = !withChanges;
    dockSend.disabled = !withChanges || sending;
    dockUndo.hidden = !editing;
    dockRedo.hidden = !editing;
    dockUndo.disabled = !v.canUndo;
    dockRedo.disabled = !v.canRedo;
    if (!n && open === 'changes') open = '';

    drawDockLock(v.access, v.page, v.projectId);
    placeReview(Boolean(v.access && !v.access.can && !dockLock.hidden));

    // the review row (its count from setCount; U3's list in the 'review' slot)
    show(reviewRow, signedIn && Boolean(v.on) && reviewCount > 0);
    handle.hidden = reviewRow.hidden;                       // the one owner of whether the count shows
    if (reviewRow.hidden && open === 'review') open = '';
    const reviewing = open === 'review' || (typeof api.reviewOpen === 'function' && api.reviewOpen() === true);

    // the sent row: my sends
    const mine = signedIn ? sendList() : [];
    show(sentRow, mine.length > 0);
    sentBtn.textContent = mine.length ? sentSummary(mine) : '';
    if (!mine.length && open === 'sent') open = '';

    changesList.hidden = open !== 'changes';
    changesList.replaceChildren(...(open === 'changes' ? changesItems(v) : []));
    sentList.hidden = open !== 'sent';
    sentList.replaceChildren(...(open === 'sent' ? sentItems(mine) : []));
    dockCount.setAttribute('aria-expanded', open === 'changes' ? 'true' : 'false');
    handle.setAttribute('aria-expanded', reviewing ? 'true' : 'false');
    sentBtn.setAttribute('aria-expanded', open === 'sent' ? 'true' : 'false');
    dock.classList.toggle('is-open', Boolean(open) || reviewing);

    // the rail keeps clear of the bubble (css/editor.css reads its size)
    const bs = document.body.style;
    if (bs && typeof bs.setProperty === 'function') {
      bs.setProperty('--hc-dock-w', `${Math.round(dock.offsetWidth || 0)}px`);
      bs.setProperty('--hc-dock-h', `${Math.round(dock.offsetHeight || 0)}px`);
    }
    if (signedIn) {
      const login = String(v.login);
      const kids = [api.avatar(login, login)];
      if (n) kids.push(h('span', { class: 'hc-dock-badge', text: String(n) }));
      dockTag.replaceChildren(...kids);
    }
    drawPanels(v);
  }

  // ---- panel slots: named panels drawn under the pill (the 'review' one under its row) ----
  function panel(name, renderFn) {
    const key = String(name);
    const had = panels.get(key);
    if (typeof renderFn !== 'function') {
      if (had && had.slot) had.slot.remove();
      panels.delete(key);
      return;
    }
    panels.set(key, { render: renderFn, slot: had ? had.slot : null });
  }
  function drawPanels(v) {
    for (const [name, p] of panels) {
      if (!p.slot) {
        p.slot = h('div', { class: 'hc-dock-panel', 'data-dock-panel': name });
        if (name === 'review') {
          // right under the review row: the rows after it are moved below the slot
          dock.appendChild(p.slot);
          moveAfter(reviewRow, [p.slot]);
          p.slot.addEventListener('scroll', () => { listScrollAt = now(); }, { passive: true });
        } else dock.appendChild(p.slot);
      }
      if (name === 'review') {
        const kids = [].concat(p.render(v) || []).filter(Boolean);
        p.slot.hidden = kids.length === 0;
        p.slot.replaceChildren(...kids);
        continue;
      }
      p.slot.replaceChildren(...[].concat(p.render(v) || []).filter(Boolean));
    }
  }

  /* The review row's count: "N to review" (0 hides the row). */
  function setCount(n) {
    api.onCount(n);
    reviewCount = Number.isInteger(n) && n > 0 ? n : 0;
    handle.replaceChildren(h('span', { class: 'n', text: String(reviewCount) }), document.createTextNode(' to review'));
    if (lastView) refreshDock(lastView);
  }

  function loadCount() {
    api.openCount().then((n) => {
      if (n !== null) setCount(n);
    }).catch(() => { /* the row keeps its last count */ });
    Promise.resolve().then(() => api.loadSends()).then((list) => {
      if (!Array.isArray(list)) return;
      const local = sends.filter((s) => s.local && !list.some((x) => x.number === s.number));
      sends = local.concat(list);
      justSent = justSent.filter((n) => !sends.some((s) => s.number === n));
      if (lastView) refreshDock(lastView);
    }).catch(() => { /* the row keeps what it had */ });
  }

  const HCDock = Object.freeze({
    mount,
    refresh: refreshDock,
    fold: (on) => fold(on !== false),
    unfold: unfoldDock,
    panel,
    sent,
    offerUndo,
    setCount,
    loadCount,
    lockParts,
    chip: () => chipEl,
    escape,
    scrolled: (y) => scrolledTo(y, 'frame'),
    UNDO_MS,
  });
  if (typeof window !== 'undefined') window.HCDock = HCDock;
}());
