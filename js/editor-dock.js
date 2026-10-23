// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 23 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Draw the Editor mode's dock (the bubble at the bottom right): change count, undo, send, edit gate, fold.
/* HCDock — the Editor mode's dock, moved out of js/editor.js (editor UI/UX build, unit U0; no behaviour change).

   js/app.js injects this file for a signed-in session only, right before js/editor.js (never index.html: the
   public page and the sandboxed frame never load it). It reads no data file and makes no network request; all
   it knows of the editor comes through the `api` object js/editor.js hands to mount().

   The interface (window.HCDock, frozen):
     mount(host, api) -> {dock, tag, handle}
         builds the bubble (the controls api.controls, ×, the change count, Undo / Redo, Send for review, the
         edit-gate lines) and the tag that brings a tucked bubble back, appends both to host (document.body),
         and reads the tucked state from this browser (localStorage 'hc-editor-dock'). handle is the
         "Proposals" link, which js/editor.js places under the name and wires.
     refresh(view)
         draws the dock for `view` (js/editor.js builds it on every redraw):
           signedIn   a session exists          login      its login (string) or null
           editing    Editor on, a page, and I may edit it
           changes    the number of changes on this page (0 when not editing)
           canUndo, canRedo   this page's history has a step back / forward
           access     the project's access answer (HCCore.accessFor's, with status) or null off project pages
           projectId  the project the page belongs to, or null
           page       the page on screen ({pageId, label, ...}) or null
           draftKey   the key of the draft on screen, or null
         then every registered panel (see panel()).
     fold(on)       on !== false: tuck the bubble into the tag (focus the tag); fold(false): bring it back (focus
                    the switch). Remembered in this browser.
     unfold()       a tucked bubble comes back without taking the focus (a message must be seen)
     panel(name, renderFn)
                    a named slot under the pill: renderFn(view) -> a node, an array of nodes, or null, drawn into
                    div.hc-dock-panel[data-dock-panel=<name>] on every refresh; renderFn null removes the slot.
                    No panel is registered today (later units add theirs).
     setCount(n)    the open proposals' count on the "Proposals" link (api.onCount(n) hears it first)
     loadCount()    asks api.openCount() for the count, then setCount; a failure keeps the link's word
     lockParts(a, projectId, name)
                    the edit gate's lines: "You can't edit this project.", why, and Request edit access (once the
                    list is read) with its result line; the facts-file page's note uses them too

   The `api` keys (every one is required; functions unless said otherwise):
     h(tag, attrs, ...kids)   js/editor.js's DOM builder (text always as text)
     store()                  this browser's localStorage, or null
     controls                 NODE: the Editor controls (who, the switch), the bubble's first child
     switchBtn                NODE: the Editor switch (focused when the bubble comes back)
     closeMenu()              closes the account menu (a tucked bubble hides it)
     redraw()                 js/editor.js's refreshDock(): builds the view and calls refresh(view)
     undoRedo(op)             op 'undo' | 'redo': one step of the page's history
     draft()                  the draft on screen, or null
     canSend(d)               may draft d be sent from this page now (edit rights and at least one change)
     myProposals()            Promise of my open proposals (for "Add to proposal #n")
     propose(d, slot, own)    draws the propose form for d into slot
     shown(error)             says a failure on the status line
     avatar(login, first)     the face node for a login (committed avatar or the first letter)
     accessAsk(a, projectId, name, result)   the Request edit access control (or null), its result line `result`
     onCount(n)               hears the open proposals' count
     openCount()              Promise of the open proposals' count, or of null when the answer is stale
*/
(function () {
  'use strict';

  const DOCK_KEY = 'hc-editor-dock';
  let api = null;
  let dock = null;         // the bottom-right dock (editor redesign U4a, Kyle's D1 change 3)
  let dockTag = null;      // the small tag on the right edge that brings a collapsed dock back
  let dockCount = null;    // "N changes" in the dock
  let dockSend = null;     // "Send for review" in the dock
  let dockUndo = null;     // round 2 (R2b): Undo / Redo in the dock
  let dockRedo = null;
  let dockLock = null;     // the edit gate (2026-10-21): on a project page, what you can do there, in one or two lines
  let sendBox = null;      // the box above the dock that Send opens (the propose form)
  let sendKey = null;      // the draft that box was opened for
  let handle = null;       // the tray's handle while it is closed
  const panels = new Map();   // name -> {render, slot}

  const h = (...a) => api.h(...a);

  // the undo / redo arrows (Lucide-style strokes, drawn here: no icon font)
  function histIcon(op) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS ? document.createElementNS(ns, 'svg') : h('span');
    if (!svg.setAttribute) return svg;
    for (const [k, v] of [['viewBox', '0 0 24 24'], ['width', '16'], ['height', '16'], ['aria-hidden', 'true'], ['focusable', 'false']]) svg.setAttribute(k, v);
    const path = document.createElementNS ? document.createElementNS(ns, 'path') : null;
    if (path) {
      path.setAttribute('d', op === 'undo' ? 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11' : 'm15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13');
      svg.appendChild(path);
    }
    return svg;
  }

  /* The dock (editor redesign U4a, Kyle's D1 change 3): the Editor switch and the avatar leave the
     header and sit in a bubble at the bottom right with the page's change count and "Send for
     review"; its x tucks it into a small tag on the right edge (remembered in this browser). */
  function mount(host, a) {
    api = a;
    dockCount = h('span', { class: 'hc-dock-count', 'data-dock-count': true });
    dockSend = h('button', { type: 'button', class: 'cms-btn cms-btn-primary hc-dock-send', 'data-action': 'dock-send' }, 'Send for review');
    dockSend.addEventListener('click', () => { openSendBox().catch(api.shown); });
    const x = h('button', { type: 'button', class: 'hc-dock-x', 'data-action': 'dock-collapse', 'aria-label': 'Hide the editor controls',
      title: 'Hide (the tag on the right edge brings it back)' }, '×');
    x.addEventListener('click', () => collapseDock(true));
    // round 2 (R2b): Undo and Redo sit between the count and Send for review
    const mac = /Mac|iPhone|iPad/.test(String((window.navigator && window.navigator.platform) || ''));
    const keyName = mac ? '⌘' : 'Ctrl+';
    dockUndo = h('button', { type: 'button', class: 'hc-dock-hist', 'data-action': 'undo', 'aria-label': 'Undo', title: `Undo (${keyName}Z)` }, histIcon('undo'));
    dockRedo = h('button', { type: 'button', class: 'hc-dock-hist', 'data-action': 'redo', 'aria-label': 'Redo', title: `Redo (${mac ? '⇧⌘Z' : 'Ctrl+Y'})` }, histIcon('redo'));
    dockUndo.addEventListener('click', () => api.undoRedo('undo'));
    dockRedo.addEventListener('click', () => api.undoRedo('redo'));
    const sendWrap = h('span', { class: 'hc-dock-send-wrap' }, dockCount,
      h('span', { class: 'hc-dock-histwrap', role: 'group', 'aria-label': 'Undo and redo' }, dockUndo, dockRedo), dockSend);
    // the proposals list opens from here: a small text link with the open count, under the name (round 2, R2a)
    handle = h('button', { type: 'button', class: 'hc-dock-pages hc-dock-link', 'data-action': 'tray-open', 'aria-expanded': 'false',
      title: 'Open proposals' }, 'Proposals');
    handle.hidden = true;
    dockLock = h('div', { class: 'hc-dock-lock', role: 'status', 'data-dock-lock': true });
    dockLock.hidden = true;
    dock = h('div', { class: 'hc-dock', role: 'region', 'aria-label': 'Editor' }, api.controls, x, sendWrap, dockLock);
    dockTag = h('button', { type: 'button', class: 'hc-dock-tag', 'data-action': 'dock-expand', 'aria-label': 'Show the editor controls',
      title: 'Show the editor controls' });
    dockTag.addEventListener('click', () => collapseDock(false));
    host.appendChild(dock);
    host.appendChild(dockTag);
    if (typeof window.addEventListener === 'function') window.addEventListener('resize', placeSendBox);   // the bubble rewraps
    let collapsed = false;
    try { const s = api.store(); collapsed = Boolean(s && s.getItem(DOCK_KEY) === 'collapsed'); } catch (e) { collapsed = false; }
    document.body.classList.toggle('hc-dock-collapsed', collapsed);
    return { dock, tag: dockTag, handle };
  }
  function collapseDock(on) {
    document.body.classList.toggle('hc-dock-collapsed', on);
    try { const s = api.store(); if (s) s.setItem(DOCK_KEY, on ? 'collapsed' : 'open'); } catch (e) { /* this page only */ }
    if (on) closeSendBox();
    api.redraw();
    const next = on ? dockTag : api.switchBtn;
    if (next && typeof next.focus === 'function') next.focus();
  }
  /* The status line lives in the bubble: a message (or the image picker's button) must be seen, so a tucked
     bubble unfolds for it, without taking the focus. */
  function unfoldDock() {
    if (!dock || !document.body.classList.contains('hc-dock-collapsed')) return;
    document.body.classList.remove('hc-dock-collapsed');
    try { const st = api.store(); if (st) st.setItem(DOCK_KEY, 'open'); } catch (e) { /* this page only */ }
    api.redraw();
  }
  /* The edit gate in the dock, on a project page: "You can't edit this project." with why and Request edit access
     (accessAsk, the project box's own), or one short line saying why you can. Redrawn only when the answer
     changed, so a request's result stays on screen. */
  /* "You can't edit this project.", why, and Request edit access (only once the list is read) with its result
     line: the dock's lines and the facts-file page's note. */
  function lockParts(a, projectId, name) {
    const result = h('p', { class: 'hc-access-result cms-action-result', role: 'status' });
    result.hidden = true;
    const ask = a.status === 'read' ? api.accessAsk(a, projectId, name, result) : null;
    return [h('p', { class: 'hc-dock-lock-head', text: window.HCCore.ACCESS_LOCKED_TEXT }), h('p', { class: 'hc-dock-lock-why', text: a.text }),
      ask, result].filter(Boolean);
  }
  let dockLockKey = '';
  function drawDockLock(a, page, projectId) {
    const key = a ? [page.pageId, a.status, a.can, a.why, a.text].join('\n') : '';
    if (key === dockLockKey) return;
    dockLockKey = key;
    if (!a) { dockLock.replaceChildren(); dockLock.hidden = true; return; }
    if (a.can) dockLock.replaceChildren(h('p', { class: 'hc-dock-lock-why', text: a.text }));
    else dockLock.replaceChildren(...lockParts(a, projectId, page.label));
    dockLock.classList.toggle('is-locked', !a.can);
    dockLock.hidden = false;
  }
  function closeSendBox() { if (sendBox) { sendBox.remove(); sendBox = null; sendKey = null; } }
  function refreshDock(v) {
    if (!dock) return;
    const signedIn = v.signedIn;
    dock.hidden = !signedIn;
    const tucked = document.body.classList.contains('hc-dock-collapsed');
    dockTag.hidden = !signedIn || !tucked;                // only while tucked away
    if (tucked) { dock.setAttribute('inert', ''); api.closeMenu(); } else dock.removeAttribute('inert');   // nothing hidden is in the tab order
    const editing = v.editing;
    const n = v.changes;
    dockCount.textContent = !editing ? '' : (n === 0 ? 'No changes yet' : `${n} ${n === 1 ? 'change' : 'changes'}`);
    dockSend.hidden = !editing;
    dockSend.disabled = n === 0;
    dockUndo.hidden = !editing;
    dockRedo.hidden = !editing;
    dockUndo.disabled = !v.canUndo;
    dockRedo.disabled = !v.canRedo;
    drawDockLock(v.access, v.page, v.projectId);
    // the page bar keeps its buttons clear of the bubble above it (css/editor.css reads the width)
    const bs = document.body.style;
    if (bs && typeof bs.setProperty === 'function') {
      bs.setProperty('--hc-dock-w', `${Math.round(dock.offsetWidth || 0)}px`);
      bs.setProperty('--hc-dock-h', `${Math.round(dock.offsetHeight || 0)}px`);
    }
    // Editor off, signed out, nothing left to send, or another page's draft on screen: the box goes
    if (!signedIn || !editing || n === 0 || (sendBox && (!v.draftKey || v.draftKey !== sendKey))) closeSendBox();
    else placeSendBox();
    if (signedIn) {
      const login = String(v.login);
      const kids = [api.avatar(login, login)];
      if (n) kids.push(h('span', { class: 'hc-dock-badge', text: String(n) }));
      dockTag.replaceChildren(...kids);
    }
    drawPanels(v);
  }
  /* The send box sits below the bubble, whatever its height (two rows; wrapped on a narrow screen); measured again
     whenever the bubble is redrawn and on the next frame, so a bubble that grew after the box opened is never covered. */
  function placeSendBox() {
    if (!sendBox || !dock || typeof dock.getBoundingClientRect !== 'function') return;
    const put = () => {
      const below = sendBox && dock.getBoundingClientRect();
      if (below && below.bottom > 0) sendBox.style.top = `${Math.round(below.bottom + 8)}px`;
    };
    put();
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(put);
  }
  /* Send for review: the page's draft goes through the same propose form the tray uses, in a box
     below the dock. */
  async function openSendBox() {
    if (sendBox) { closeSendBox(); return; }
    const d = api.draft();
    if (!d || !api.canSend(d)) return;
    const slot = h('div', { class: 'hc-propose-slot' });
    const close = h('button', { type: 'button', class: 'hc-dock-x', 'data-action': 'send-close', 'aria-label': 'Close' }, '×');
    close.addEventListener('click', closeSendBox);
    sendBox = h('div', { class: 'hc-sendbox', role: 'dialog', 'aria-label': 'Send for review' },
      h('div', { class: 'hc-sendbox-head' }, h('strong', { text: 'Send for review' }), close), slot);
    sendKey = d.key;
    document.body.appendChild(sendBox);
    placeSendBox();
    const own = await api.myProposals();
    const now = api.draft();
    if (!sendBox || sendKey !== d.key || !now || now.key !== d.key) return;   // closed or moved on meanwhile
    api.propose(d, slot, own);
  }

  // ---- panel slots: later units register named panels drawn under the pill ----
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
        dock.appendChild(p.slot);
      }
      p.slot.replaceChildren(...[].concat(p.render(v) || []).filter(Boolean));
    }
  }

  /* The open proposals' count: on the Proposals tab and the handle. */
  function setCount(n) {
    api.onCount(n);
    handle.replaceChildren(document.createTextNode('Proposals'),
      h('span', { class: 'n', 'aria-label': `${n} open`, text: n > 0 ? String(n) : '' }));
  }

  function loadCount() {
    api.openCount().then((n) => {
      if (n !== null) setCount(n);
    }).catch(() => { /* the button keeps saying "Proposals" */ });
  }

  const HCDock = Object.freeze({
    mount,
    refresh: refreshDock,
    fold: (on) => collapseDock(on !== false),
    unfold: unfoldDock,
    panel,
    setCount,
    loadCount,
    lockParts,
  });
  if (typeof window !== 'undefined') window.HCDock = HCDock;
}());
