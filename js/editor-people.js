// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 26 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: The Team page's people tools inside the Editor's preview frame: card menu, moves, drag, "+" cards, marks.
/* HCEditorPeople — the Team page's people tools inside the preview frame. U0 moved them out of
   js/editor-frame.js; U5 (editor UI/UX build, plan D15, D16) rebuilt them: the card menu is gone. js/editor-frame.js
   loads this file lazily, once, and only inside a preview frame when the Team page (#people-root) is shown with
   Editor mode on (hc-editor.people present); never on the live site, never for a guest, never on another page.

   The interface (window.HCEditorPeople, frozen; module.exports for node tests):
     peopleMove(lists, action)   the move rules (pure), shared by the Move buttons, Alt+arrows and drag
     dropIndexAt(rects, x, y)    where a drop at (x, y) lands among the other cards' rects (pure)
     dragDecide({dx, dy, ms, touch})   'wait' | 'lift' | 'cancel': when a press on the grip becomes a drag (pure)
     moveStatus(lists, name)     the status line after a move: "<name> moved to position 2 of 6 in Alumni" (pure)
     create(ctx) -> {sync(s), close()}
         ctx = {win, doc, HC, inView(el), classesOf(node)} from the frame's runtime. sync(s) is the frame's
         syncPeople: it runs on every hc-editor message and page change once loaded; close() ends an edit or drag.
   It posts only hc-people {op: 'order', team, alumni, focus, act}, {op: 'field', name, field, value?},
   {op: 'remove', name} and {op: 'add-in-place', group, login, name, title, link, photo} (js/source.js section 9
   and its U5 block). The parent decides what is allowed (D15); this file only draws what it is told:
   s.people.edit (an admin: every card's tools) or s.peopleOwn (anyone else: their own card's name and photo). */
(function () {
  'use strict';

  /* Round 2 (R5, Kyle 2026-10-15): the Team page's move rules, shared by the Move buttons, Alt+arrows and drag.
     lists = {team, alumni}: [{name, linked, active, pinned}] as shown. action = {op: 'up'|'down'|'other'|'pin',
     name} or {op: 'drop', name, list, index}. A pin holds a linked person in the list they are in (js/lab.js
     splitTeam). Moved to the team: a linked person who did no GitHub work lately is pinned there (else the 30-day
     rule sends them back); moved to the alumni: a linked person ACTIVE on GitHub is pinned there (Kyle 2026-10-16,
     else the rule brings them back); any other move takes the pin off. 'pin' toggles the pin where they are;
     an unpinned person is then placed by the rule. Pins exist only for linked people.
     -> {team, alumni} (new arrays) | null (nothing to do) */
  function peopleMove(lists, action) {
    const a = action || {};
    const copy = (l) => (Array.isArray(l) ? l.map((x) => Object.assign({}, x)) : []);
    const out = { team: copy(lists && lists.team), alumni: copy(lists && lists.alumni) };
    const from = out.team.some((x) => x.name === a.name) ? 'team' : (out.alumni.some((x) => x.name === a.name) ? 'alumni' : null);
    if (!from) return null;
    const list = out[from];
    const i = list.findIndex((x) => x.name === a.name);
    const who = list[i];
    if (a.op === 'up' || a.op === 'down') {
      const j = a.op === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= list.length) return null;
      [list[i], list[j]] = [list[j], list[i]];
      return out;
    }
    if (a.op === 'pin') {
      if (!who.linked) return null;
      who.pinned = !who.pinned;
      return out;
    }
    const to = a.op === 'other' ? (from === 'team' ? 'alumni' : 'team') : (a.op === 'drop' && (a.list === 'team' || a.list === 'alumni') ? a.list : null);
    if (!to) return null;
    if (to !== from) who.pinned = who.linked === true && (to === 'team' ? !who.active : who.active === true);
    list.splice(i, 1);
    // a drop lands where it was dropped; "Move to Alumni" puts them first there (the newest alumni lead), "Move to
    // the team" last on the team
    const at = a.op === 'drop' && Number.isInteger(a.index) ? Math.max(0, Math.min(a.index, out[to].length))
      : (to === 'alumni' ? 0 : out[to].length);
    out[to].splice(at, 0, who);
    return out;
  }

  /* U5 (plan D16, reorderable-list-ux): where a drop at (x, y) lands. rects = the other cards of the list, in
     order, as {left, top, right, bottom}; the cards flow in rows, so a point above a card, or in its row left of
     its middle, lands before it. -> 0..rects.length */
  function dropIndexAt(rects, x, y) {
    const list = Array.isArray(rects) ? rects : [];
    for (let i = 0; i < list.length; i += 1) {
      const r = list[i];
      if (y < r.top) return i;
      if (y <= r.bottom && x < (r.left + r.right) / 2) return i;
    }
    return list.length;
  }
  /* When a press on the grip becomes a drag: a mouse or pen after it travels LIFT_PX (a click moves nothing); a
     finger only after it is held LONG_PRESS_MS without travelling TOUCH_SLOP_PX (else it was a scroll or a slip).
     -> 'wait' | 'lift' | 'cancel' */
  const LIFT_PX = 3;
  const LONG_PRESS_MS = 400;
  const STATUS_DELAY_MS = 120;   // a move line waits this long after its status region is created (then read out)
  const TOUCH_SLOP_PX = 8;
  function dragDecide(p) {
    const q = p || {};
    const dist = Math.hypot(Number(q.dx) || 0, Number(q.dy) || 0);
    if (q.touch) {
      if (dist > TOUCH_SLOP_PX) return 'cancel';
      return (Number(q.ms) || 0) >= LONG_PRESS_MS ? 'lift' : 'wait';
    }
    return dist >= LIFT_PX ? 'lift' : 'wait';
  }
  /* The one status line after a move (reorderable-list-ux: the item and its new position). lists = {team,
     alumni}: [{name}] as shown now. -> string ('' when the person is not shown) */
  const LIST_NAME = Object.freeze({ team: 'Current team', alumni: 'Alumni' });
  function moveStatus(lists, name) {
    for (const list of ['team', 'alumni']) {
      const l = lists && Array.isArray(lists[list]) ? lists[list] : [];
      const i = l.findIndex((x) => x && x.name === name);
      if (i >= 0) return `${name} moved to position ${i + 1} of ${l.length} in ${LIST_NAME[list]}`;
    }
    return '';
  }

  function create(ctx) {
    const { win, doc, HC, inView, classesOf } = ctx;
    /* On the Team page (#people-root, js/app.js) in Editor mode (plan D15, D16):
       - an admin (hc-editor.people.edit): every card is edited in place — click the name or the title to type
         (Enter or leaving the field keeps it, Escape puts it back), click the photo to replace it; a six-dot grip
         (hidden from screen readers) drags the card within or between the lists, a finger after a long press; a
         focused card shows Move up / Move down / Move to Alumni|Current team (WCAG 2.5.7: the path without a
         drag); a small remove control; a pin glyph with a title on a pinned card; a dashed "+" card at the end of
         each list that turns into an empty card in place (GitHub account, Name, Title, Link, photo, Add).
       - anyone else (hc-editor.peopleOwn): the page reads as it does outside Editor mode, except their own card
         (data-hc-own): its name and photo, the same way. Never the title (D15).
       Every change is posted; the parent writes my draft and reloads the page, then says which card (focus) and
       which Move button (peopleAct) to come back to, and a refused change (peopleAlert, shown with role="alert").
       The marks of a draft or a proposal (hc-editor.people.marks) outline the changed cards in the proposer's
       colour with a word (New, Moved, Pinned, Unpinned, Changed); a removed person is a faded, struck ghost at the
       end of their old list. */
    const BADGE = Object.freeze({ add: 'New', move: 'Moved', pin: 'Pinned', unpin: 'Unpinned', edit: 'Changed', del: 'Removed' });
    const GRIP_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false">'
      + '<circle cx="6" cy="4" r="1.25"/><circle cx="10" cy="4" r="1.25"/><circle cx="6" cy="8" r="1.25"/>'
      + '<circle cx="10" cy="8" r="1.25"/><circle cx="6" cy="12" r="1.25"/><circle cx="10" cy="12" r="1.25"/></svg>';
    const PIN_SVG = '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true" focusable="false">'
      + '<path d="M10.5 1.5l4 4-1.6.6-2.6 2.6.4 3.1-1.2 1.2-2.8-2.8L3 14l-1-1 3.8-3.7L3 6.5l1.2-1.2 3.1.4 2.6-2.6z"/></svg>';
    let peopleKey = null;
    let focusedOnce = null;
    const FOCUS_MS = 2500;
    let mode = null;            // 'admin' | 'own' | null: what the parent allows on this page now
    let ownName = null;         // the own card's name (mode 'own')
    let editing = null;         // {el, field, name, was}: a name or title being typed
    let drag = null;            // {name, card, grip, id, x0, y0, t0, touch, lifted, preview, dx, dy, target, timer}
    let said = null;            // the last status line said, so a reload does not say it twice
    let statusTimer = null;     // the move line waiting to be written (STATUS_DELAY_MS)
    const peopleRoot = () => doc.getElementById ? doc.getElementById('people-root') : null;
    const has = (n, c) => Boolean(n && n.nodeType === 1 && classesOf(n).indexOf(c) >= 0);
    const elKids = (n) => (n && n.childNodes ? Array.from(n.childNodes).filter((c) => c.nodeType === 1) : []);
    function walk(n, fn) { for (const c of elKids(n)) { fn(c); walk(c, fn); } }
    function findAll(n, pred) { const out = []; walk(n, (c) => { if (pred(c)) out.push(c); }); return out; }
    const find = (n, pred) => findAll(n, pred)[0] || null;
    function up(n, pred) { let x = n; while (x && x.nodeType === 1) { if (pred(x)) return x; x = x.parentNode; } return null; }
    const isCard = (c) => has(c, 'person-card') && !has(c, 'hc-pghost') && !has(c, 'hc-padd') && !has(c, 'hc-pnew') && Boolean(c.getAttribute('data-hc-name'));
    // the people's own cards: never the "+" card, the new card or a removed person's ghost
    const cardsIn = (grid) => elKids(grid).filter(isCard);
    const allCards = () => { const r = peopleRoot(); return r ? findAll(r, isCard) : []; };
    const cardOf = (name) => allCards().find((c) => c.getAttribute('data-hc-name') === name) || null;
    function gridOf(list) {
      const root = peopleRoot();
      const g = root ? find(root, (c) => has(c, 'people-group') && c.getAttribute('data-hc-list') === list) : null;
      return g ? find(g, (c) => has(c, 'people-grid')) : null;
    }
    const listOf = (card) => { const g = up(card, (x) => x.getAttribute && x.getAttribute('data-hc-list')); return g ? g.getAttribute('data-hc-list') : null; };
    function shownLists() {
      const read = (list) => { const g = gridOf(list); return g ? cardsIn(g).map((c) => ({ name: c.getAttribute('data-hc-name'),
        linked: c.getAttribute('data-linked') === '1', active: c.getAttribute('data-active') === '1', pinned: c.getAttribute('data-pinned') === '1' })) : []; };
      return { team: read('team'), alumni: read('alumni') };
    }
    const strip = (l) => l.map((x) => ({ name: x.name, pinned: x.pinned === true }));
    function movePerson(action, act) {
      const before = shownLists();
      const out = peopleMove(before, action);
      if (!out) return;
      if (JSON.stringify(strip(out.team)) === JSON.stringify(strip(before.team))
        && JSON.stringify(strip(out.alumni)) === JSON.stringify(strip(before.alumni))) return;   // dropped where it was
      HC.post('hc-people', { op: 'order', team: strip(out.team), alumni: strip(out.alumni), focus: action.name, act: act || null });
    }
    function make(tag, cls, attrs, text) {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      for (const k of Object.keys(attrs || {})) e.setAttribute(k, attrs[k]);
      if (text !== undefined) e.textContent = text;
      return e;
    }
    const svg = (e, markup) => { e.innerHTML = markup; return e; };   // a fixed, local drawing, never page data
    const swap = (was, now) => { const p = was.parentNode; if (p) { p.insertBefore(now, was); p.removeChild(was); } };
    const focusEl = (e) => { if (e && typeof e.focus === 'function') e.focus({ preventScroll: true }); };

    // ---- typing in place: the name, the title ----
    function startEdit(span, card, field) {
      if (editing && editing.el === span) return;
      endEdit(true);
      const name = card.getAttribute('data-hc-name');
      editing = { el: span, field, name, was: span.textContent };
      span.setAttribute('contenteditable', 'true');
      span.setAttribute('role', 'textbox');
      span.setAttribute('aria-label', field === 'name' ? `Name of ${name}` : `Title of ${name}`);
      span.setAttribute('spellcheck', 'false');
      span.classList.add('is-typing');
      focusEl(span);
      try {
        const range = doc.createRange();
        range.selectNodeContents(span);
        const sel = win.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (e) { /* the caret lands where the browser puts it */ }
    }
    // keep: post the typed text when it changed; else put the text back as it was
    function endEdit(keep) {
      const e = editing;
      if (!e) return;
      editing = null;
      const value = String(e.el.textContent || '').replace(/\s+/g, ' ').trim();
      e.el.removeAttribute('contenteditable');
      e.el.removeAttribute('role');
      e.el.removeAttribute('aria-label');
      e.el.removeAttribute('spellcheck');
      e.el.classList.remove('is-typing');
      if (!keep || value === e.was.trim() || (e.field === 'name' && !value)) { e.el.textContent = e.was; return; }
      e.el.textContent = value;
      HC.post('hc-people', { op: 'field', name: e.name, field: e.field, value });
    }
    const may = (card, field) => (mode === 'admin' ? true
      : mode === 'own' && card.getAttribute('data-hc-name') === ownName && (field === 'name' || field === 'photo'));

    // ---- the tools on one card ----
    function moveButtons(card, list) {
      const name = card.getAttribute('data-hc-name');
      const box = make('div', 'hc-ptool hc-pmoves', { role: 'group', 'aria-label': `Move ${name}` });
      const btn = (act, label, text) => {
        const b = make('button', 'hc-pmove', { type: 'button', 'data-pact': act, 'aria-label': label }, text);
        b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (!b.disabled) movePerson({ op: act, name }, act); });
        box.appendChild(b);
        return b;
      };
      btn('up', `Move ${name} up`, 'Move up');
      btn('down', `Move ${name} down`, 'Move down');
      btn('other', list === 'team' ? `Move ${name} to Alumni` : `Move ${name} to the current team`,
        list === 'team' ? 'Move to Alumni' : 'Move to Current team');
      return box;
    }
    /* fix pass A3 (WCAG 2.1.1): the title and the photo without a mouse — two small buttons shown with the Move
       buttons (on keyboard focus); the name is Enter or Space on the card itself */
    function fieldButtons(card) {
      const name = card.getAttribute('data-hc-name');
      const box = make('div', 'hc-ptool hc-pfields', { role: 'group', 'aria-label': `Change ${name}` });
      const btn = (field, label, text) => {
        const b = make('button', 'hc-pfield', { type: 'button', 'data-pfield': field, 'aria-label': label }, text);
        b.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (field === 'photo') { endEdit(true); HC.post('hc-people', { op: 'field', name, field: 'photo' }); return; }
          const span = spanOf(card, field);
          if (span) startEdit(span, card, field);
        });
        box.appendChild(b);
      };
      if (may(card, 'title') && spanOf(card, 'title')) btn('title', `Edit the title of ${name}`, 'Edit title');
      if (may(card, 'photo')) btn('photo', `Replace the photo of ${name}`, 'Replace photo');
      return elKids(box).length ? box : null;
    }
    function spanOf(card, field) {
      return find(card, (c) => (field === 'name' ? has(c, 'person-name')
        : field === 'title' ? has(c, 'person-title') && !has(c, 'person-subtitle') : false));
    }
    function setEnds(card) {
      const grid = card.parentNode;
      const cards = cardsIn(grid);
      const i = cards.indexOf(card);
      const box = find(card, (c) => has(c, 'hc-pmoves'));
      if (!box) return;
      for (const b of elKids(box)) {
        const act = b.getAttribute('data-pact');
        b.disabled = (act === 'up' && i <= 0) || (act === 'down' && i >= cards.length - 1);
        if (b.disabled) b.setAttribute('disabled', ''); else b.removeAttribute('disabled');
      }
    }
    function wireCard(card, list) {
      const name = card.getAttribute('data-hc-name');
      if (card.getAttribute('data-hc-ptools') === mode) return;
      unwireCard(card);
      card.setAttribute('data-hc-ptools', mode);
      if (mode === 'own') card.setAttribute('data-hc-own', '1');
      if (card.getAttribute('tabindex') === null && card.tagName !== 'A') card.setAttribute('tabindex', '0');
      if (mode === 'admin') {
        const grip = make('span', 'hc-ptool hc-pgrip', { 'aria-hidden': 'true', title: `Drag to move ${name}` });
        svg(grip, GRIP_SVG);
        grip.addEventListener('pointerdown', (e) => pressGrip(e, card, grip));
        grip.addEventListener('contextmenu', (e) => e.preventDefault());   // a long press inside a link: no menu
        card.insertBefore(grip, card.childNodes[0] || null);
        const rm = make('button', 'hc-ptool hc-premove', { type: 'button', 'aria-label': `Remove ${name}`, title: `Remove ${name}` }, '×');
        rm.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); HC.post('hc-people', { op: 'remove', name }); });
        card.appendChild(rm);
        if (card.getAttribute('data-pinned') === '1' && card.getAttribute('data-linked') === '1') {
          const where = list === 'team' ? 'Pinned: stays on the current team' : 'Pinned: stays with the alumni';
          card.appendChild(svg(make('span', 'hc-ptool hc-ppin', { role: 'img', 'aria-label': where, title: where }), PIN_SVG));
        }
        card.appendChild(moveButtons(card, list));
        setEnds(card);
      }
      const fields = mode === 'admin' || card.getAttribute('data-hc-name') === ownName ? fieldButtons(card) : null;
      if (fields) card.appendChild(fields);
      if (card.getAttribute('data-hc-pwired') === '1') return;
      card.setAttribute('data-hc-pwired', '1');           // the listeners stay; each one asks the mode it runs in
      card.addEventListener('click', (e) => {
        if (!mode || (mode === 'own' && card.getAttribute('data-hc-name') !== ownName)) return;
        const t = e.target;
        e.preventDefault();                       // in Editor mode a card is edited, not followed (the grip too)
        if (up(t, (x) => has(x, 'hc-ptool'))) return;
        e.stopPropagation();
        if (editing && up(t, (x) => x === editing.el)) return;
        const span = up(t, (x) => has(x, 'person-name') || has(x, 'person-title') || has(x, 'person-photo') || has(x, 'person-initials'));
        const field = !span ? null : has(span, 'person-name') ? 'name' : has(span, 'person-title') && !has(span, 'person-subtitle') ? 'title' : has(span, 'person-subtitle') ? null : 'photo';
        if (!field || !may(card, field)) return;
        if (field === 'photo') { endEdit(true); HC.post('hc-people', { op: 'field', name: card.getAttribute('data-hc-name'), field: 'photo' }); return; }
        startEdit(span, card, field);
      });
      card.addEventListener('keydown', (e) => {
        if (!mode) return;
        if (editing && up(e.target, (x) => x === editing.el)) {
          if (e.key === 'Enter') { e.preventDefault(); endEdit(true); focusEl(card); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endEdit(false); focusEl(card); }
          return;
        }
        if (e.target !== card) return;
        // fix pass A3: Enter or Space on a card I may change starts typing its name (the link is never followed here)
        if ((e.key === 'Enter' || e.key === ' ') && !e.altKey && may(card, 'name')) {
          e.preventDefault();
          const span = spanOf(card, 'name');
          if (span) startEdit(span, card, 'name');
          return;
        }
        if (mode !== 'admin') return;
        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); movePerson({ op: e.key === 'ArrowUp' ? 'up' : 'down', name: card.getAttribute('data-hc-name') }); }
        else if (e.key === 'Enter' || e.key === ' ') e.preventDefault();      // never follow the link from the editor
      });
      card.addEventListener('focusout', (e) => {
        if (editing && e.target === editing.el) endEdit(true);
      });
    }
    function unwireCard(card) {
      for (const t of findAll(card, (c) => has(c, 'hc-ptool'))) t.parentNode.removeChild(t);
      card.removeAttribute('data-hc-ptools');
      card.removeAttribute('data-hc-own');
    }

    // ---- drag from the grip (reorderable-list-ux drag mechanics) ----
    function pressGrip(e, card, grip) {
      if (mode !== 'admin' || drag || (e.button !== undefined && e.button > 0) || e.isPrimary === false) return;
      e.preventDefault();
      endEdit(true);
      drag = { name: card.getAttribute('data-hc-name'), card, grip, id: e.pointerId, x0: e.clientX, y0: e.clientY,
        t0: Date.now(), touch: e.pointerType === 'touch', lifted: false, preview: null, target: null, timer: null };
      if (drag.touch) {
        const mine = drag;
        drag.timer = win.setTimeout(() => { if (drag === mine && !mine.lifted && dragDecide({ dx: 0, dy: 0, ms: LONG_PRESS_MS, touch: true }) === 'lift') lift(); }, LONG_PRESS_MS);
      }
    }
    function lift() {
      const d = drag;
      d.lifted = true;
      d.card.classList.add('is-dragging');
      if (doc.body) doc.body.classList.add('hc-pdragging');
      try { d.grip.setPointerCapture(d.id); } catch (err) { /* the document's listeners still track it */ }
      try {
        const r = d.card.getBoundingClientRect();
        const p = d.card.cloneNode(true);
        p.className = `${d.card.className} hc-ppreview`;
        p.removeAttribute('href');
        p.setAttribute('aria-hidden', 'true');
        p.style.width = `${r.width}px`;
        p.style.left = `${r.left}px`;
        p.style.top = `${r.top}px`;
        doc.body.appendChild(p);
        d.preview = p;
        d.offX = d.x0 - r.left;
        d.offY = d.y0 - r.top;
      } catch (err) { d.preview = null; }
    }
    function clearDrop() {
      for (const c of findAll(peopleRoot() || doc.body, (x) => has(x, 'hc-pdrop-before') || has(x, 'is-drop'))) {
        c.classList.remove('hc-pdrop-before');
        c.classList.remove('is-drop');
      }
    }
    // where the pointer would drop: the list whose box holds it, and the place among its other cards
    function targetAt(x, y) {
      for (const list of ['team', 'alumni']) {
        const grid = gridOf(list);
        if (!grid || typeof grid.getBoundingClientRect !== 'function') continue;
        const g = grid.getBoundingClientRect();
        if (x < g.left - 24 || x > g.right + 24 || y < g.top - 24 || y > g.bottom + 24) continue;
        const others = cardsIn(grid).filter((c) => c !== drag.card);
        const index = dropIndexAt(others.map((c) => c.getBoundingClientRect()), x, y);
        return { list, index, before: others[index] || null, grid };
      }
      return null;
    }
    function dragMove(e) {
      const d = drag;
      if (!d || e.pointerId !== d.id) return;
      if (!d.lifted) {
        const step = dragDecide({ dx: e.clientX - d.x0, dy: e.clientY - d.y0, ms: Date.now() - d.t0, touch: d.touch });
        if (step === 'cancel') { endDrag(); return; }
        if (step !== 'lift') return;
        lift();
      }
      e.preventDefault();
      if (d.preview) { d.preview.style.left = `${e.clientX - d.offX}px`; d.preview.style.top = `${e.clientY - d.offY}px`; }
      clearDrop();
      d.target = targetAt(e.clientX, e.clientY);
      if (d.target) (d.target.before || d.target.grid).classList.add(d.target.before ? 'hc-pdrop-before' : 'is-drop');
      if (win.innerHeight && typeof win.scrollBy === 'function') {      // near the frame's edge: the page scrolls
        if (e.clientY < 48) win.scrollBy(0, -12); else if (e.clientY > win.innerHeight - 48) win.scrollBy(0, 12);
      }
    }
    function endDrag() {
      const d = drag;
      drag = null;
      if (!d) return null;
      if (d.timer) win.clearTimeout && win.clearTimeout(d.timer);
      d.card.classList.remove('is-dragging');
      if (doc.body) doc.body.classList.remove('hc-pdragging');
      if (d.preview && d.preview.parentNode) d.preview.parentNode.removeChild(d.preview);
      clearDrop();
      return d;
    }
    function dragUp(e) {
      if (!drag || e.pointerId !== drag.id) return;
      const lifted = drag.lifted;
      const name = drag.name;
      const t = lifted ? targetAt(e.clientX, e.clientY) : null;
      endDrag();
      if (t) movePerson({ op: 'drop', name, list: t.list, index: t.index }, 'drop');   // outside both lists: nothing
    }
    if (doc.addEventListener) {
      doc.addEventListener('pointermove', dragMove);
      doc.addEventListener('pointerup', dragUp);
      doc.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.id) endDrag(); });
      doc.addEventListener('keydown', (e) => { if (drag && e.key === 'Escape') { e.preventDefault(); endDrag(); } });
    }

    // ---- "+": a new, empty card in place ----
    function addCard(grid, list) {
      if (elKids(grid).some((c) => has(c, 'hc-pnew'))) return;
      let plus = elKids(grid).find((c) => has(c, 'hc-padd'));
      if (!plus) {
        plus = make('button', 'person-card hc-padd', { type: 'button', 'data-hc-padd': list,
          'aria-label': list === 'team' ? 'Add a person to the current team' : 'Add a person to the alumni' });
        plus.appendChild(make('span', 'hc-padd-plus', { 'aria-hidden': 'true' }, '+'));
        plus.appendChild(make('span', 'person-name', {}, 'Add a person'));
        plus.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openNew(grid, list, plus); });
      }
      if (plus !== grid.childNodes[grid.childNodes.length - 1]) grid.appendChild(plus);
    }
    function openNew(grid, list, plus) {
      const card = make('div', 'person-card hc-pnew', { role: 'group', 'data-hc-pnew': list,
        'aria-label': list === 'team' ? 'New person on the current team' : 'New person in the alumni' });
      const field = (key, label, hint) => {
        const id = `hc-pnew-${list}-${key}`;
        const wrap = make('label', 'hc-pnew-field', { for: id });
        wrap.appendChild(make('span', 'hc-pnew-label', {}, label));
        const input = make('input', 'hc-pnew-input', { id, type: 'text', 'data-hc-pfield': key, autocomplete: 'off', spellcheck: 'false' });
        if (hint) input.setAttribute('placeholder', hint);
        wrap.appendChild(input);
        card.appendChild(wrap);
        return input;
      };
      const login = field('login', 'GitHub account', 'optional');
      const name = field('name', 'Name');
      const title = field('title', 'Title');
      const link = field('link', 'Link', 'https://… (optional)');
      const photoWrap = make('label', 'hc-pnew-check', {});
      const photo = make('input', '', { type: 'checkbox', 'data-hc-pfield': 'photo' });
      photoWrap.appendChild(photo);
      photoWrap.appendChild(make('span', '', {}, 'Choose a profile image after adding'));
      card.appendChild(photoWrap);
      const problem = make('p', 'hc-pnew-problem', { id: `hc-pnew-${list}-problem`, 'aria-live': 'polite' });
      card.appendChild(problem);
      // fix pass A3 (WCAG 3.3.1): the error line belongs to the field it names; a field made valid says so
      const flag = (input, why) => {
        for (const i of [login, name]) { i.removeAttribute('aria-invalid'); i.removeAttribute('aria-describedby'); }
        problem.textContent = why;
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', problem.getAttribute('id'));
        focusEl(input);
      };
      const recheck = () => {
        if (name.getAttribute('aria-invalid') === 'true' && val(name)) { name.removeAttribute('aria-invalid'); name.removeAttribute('aria-describedby'); problem.textContent = ''; }
        if (login.getAttribute('aria-invalid') === 'true' && (!val(login) || /^@?[A-Za-z0-9-]{1,39}$/.test(val(login)))) {
          login.removeAttribute('aria-invalid'); login.removeAttribute('aria-describedby'); problem.textContent = '';
        }
      };
      name.addEventListener('input', recheck);
      login.addEventListener('input', recheck);
      const row = make('div', 'hc-pnew-actions', {});
      const add = make('button', 'cms-btn hc-pnew-add', { type: 'button' }, 'Add');
      const cancel = make('button', 'cms-btn hc-pnew-cancel', { type: 'button' }, 'Cancel');
      row.appendChild(add);
      row.appendChild(cancel);
      card.appendChild(row);
      const val = (i) => String(i.value || '').trim();
      const close = () => { swap(card, plus); focusEl(plus); };
      const submit = () => {
        if (!val(name)) { flag(name, 'A name is needed.'); return; }
        if (val(login) && !/^@?[A-Za-z0-9-]{1,39}$/.test(val(login))) { flag(login, 'A GitHub account is letters, digits and dashes.'); return; }
        HC.post('hc-people', { op: 'add-in-place', group: list, login: val(login), name: val(name), title: val(title), link: val(link), photo: photo.checked === true });
      };
      add.addEventListener('click', (e) => { e.preventDefault(); submit(); });
      cancel.addEventListener('click', (e) => { e.preventDefault(); close(); });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
        else if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') { e.preventDefault(); submit(); }
      });
      swap(plus, card);
      focusEl(login);
    }

    // ---- the one status line and the alert ----
    function regions(root) {
      let live = find(root, (c) => has(c, 'hc-plive'));
      if (!live) { live = make('div', 'hc-plive', { role: 'status', 'aria-live': 'polite' }); root.insertBefore(live, root.childNodes[0] || null); }
      let alert = find(root, (c) => has(c, 'hc-palert'));
      if (!alert) { alert = make('div', 'hc-palert', { role: 'alert' }); alert.hidden = true; root.insertBefore(alert, live.nextSibling); }
      return { live, alert };
    }

    function paintPeopleMarks(marks) {
      const root = peopleRoot();
      for (const c of allCards()) {
        c.removeAttribute('data-hc-badge');
        for (const k of Object.keys(BADGE)) c.classList.remove(`hc-pmark-${k}`);
      }
      for (const g of findAll(root, (c) => has(c, 'hc-pghost'))) g.parentNode.removeChild(g);
      const byName = new Map();
      for (const m of marks) { if (!byName.has(m.name)) byName.set(m.name, []); byName.get(m.name).push(m); }
      for (const [name, ms] of byName) {
        const del = ms.find((m) => m.mark === 'del');
        if (del) {
          const grid = gridOf(del.group === 'active' || del.group === 'team' ? 'team' : 'alumni');
          if (!grid) continue;
          const ghost = make('div', 'person-card is-static hc-pghost hc-pmark-del', { 'data-hc-badge': BADGE.del });
          ghost.appendChild(make('span', 'person-name', {}, name));
          if (del.title) ghost.appendChild(make('span', 'person-title', {}, del.title));
          const plus = elKids(grid).find((c) => has(c, 'hc-padd') || has(c, 'hc-pnew'));
          grid.insertBefore(ghost, plus || null);
          continue;
        }
        const card = cardOf(name);
        if (!card) continue;
        for (const m of ms) card.classList.add(`hc-pmark-${m.mark}`);
        card.setAttribute('data-hc-badge', ms.map((m) => BADGE[m.mark]).join(' · '));
      }
    }
    function syncPeople(s) {
      const root = peopleRoot();
      const b = doc.body;
      const on = Boolean(root && s.on && s.people);
      const next = on && s.people.edit ? 'admin' : (on && typeof s.peopleOwn === 'string' && s.peopleOwn ? 'own' : null);
      if (b) b.classList.toggle('hc-people-edit', next === 'admin');   // anyone else reads the page as it is (ED56)
      if (!root) { endEdit(false); endDrag(); mode = null; return; }
      if (next !== mode || (next === 'own' && s.peopleOwn !== ownName)) { endEdit(false); endDrag(); }
      mode = next;
      ownName = next === 'own' ? s.peopleOwn : null;
      for (const list of ['team', 'alumni']) {
        const grid = gridOf(list);
        if (!grid) continue;
        for (const card of cardsIn(grid)) {
          if (mode === 'admin' || (mode === 'own' && card.getAttribute('data-hc-name') === ownName)) wireCard(card, list);
          else unwireCard(card);
        }
        if (mode === 'admin') addCard(grid, list);
        else for (const x of elKids(grid).filter((c) => has(c, 'hc-padd') || has(c, 'hc-pnew'))) grid.removeChild(x);
      }
      const { live, alert } = regions(root);
      const problem = on && typeof s.peopleAlert === 'string' && s.peopleAlert ? s.peopleAlert : '';
      if (alert.textContent !== problem) alert.textContent = problem;
      alert.hidden = !problem;
      // after a reload, back to the person just moved, renamed or added: focused once (on the Move button pressed,
      // or the other one when it is now disabled), said once, and kept in view while the page settles (the lab
      // activity above renders later and pushes the people down), never after FOCUS_MS
      const focus = on ? s.people.focus : null;
      const card = focus ? cardOf(focus) : null;
      if (card && (!focusedOnce || focusedOnce.name !== focus)) {
        focusedOnce = { name: focus, until: Date.now() + FOCUS_MS };
        const act = on && typeof s.peopleAct === 'string' ? s.peopleAct : null;
        const box = act && act !== 'drop' ? find(card, (c) => has(c, 'hc-pmoves')) : null;
        const pressed = box ? elKids(box).find((x) => x.getAttribute('data-pact') === act) : null;
        const other = box ? elKids(box).find((x) => x.getAttribute('data-pact') === (act === 'up' ? 'down' : 'up')) : null;
        focusEl(pressed && !pressed.disabled ? pressed : (other && !other.disabled ? other : card));
        if (act) {
          const line = moveStatus(shownLists(), focus);
          // the region is new in this reloaded page: a line arriving with it is often not read out, so it is
          // written a moment later, once the region is in the tree (STATUS_DELAY_MS)
          if (line && line !== said) {
            said = line;
            if (statusTimer) win.clearTimeout(statusTimer);
            statusTimer = win.setTimeout(() => { statusTimer = null; if (live.parentNode) live.textContent = line; }, STATUS_DELAY_MS);
          }
        }
      }
      if (card && focusedOnce && focusedOnce.name === focus && Date.now() < focusedOnce.until && !inView(card)) {
        try { card.scrollIntoView({ block: 'center' }); } catch (e) { /* a courtesy */ }
      }
      const key = JSON.stringify(on ? s.people.marks : []);
      if (key !== peopleKey) { peopleKey = key; paintPeopleMarks(on ? s.people.marks : []); }
    }

    /* TEST-ONLY, for the localhost walk (tools/tests/editor_walk.html, its U5 steps), gated exactly as
       js/editor-frame.js's walk hooks: on localhost / 127.0.0.1 only, and only when a top window that is NOT the
       parent sits above the site (the walk page). The walk cannot click inside this sandboxed frame, so ONE
       listener takes {type: 'hc-walk-people', act} from that top window — act 'name' clicks the first card's
       name (the real click path: typing in place), 'moves' focuses the first card's Move down button (the Move
       buttons on keyboard focus), 'add' clicks the alumni "+" (the empty card in place), 'state' nothing — and
       answers {type: 'hc-walk-people-state', act, mode, own, grips, typing, moves, fresh}. Anywhere else no
       listener exists; the parent is told nothing. */
    const host = String((win.location && win.location.hostname) || '');
    if ((host === 'localhost' || host === '127.0.0.1') && win.top && win.parent && win.top !== win.parent && win.addEventListener) {
      win.addEventListener('message', (e) => {
        const d = e && e.data;
        if (!e || e.source !== win.top || !d || typeof d !== 'object' || d.type !== 'hc-walk-people') return;
        const first = allCards()[0] || null;
        if (d.act === 'name' && first && mode === 'admin') { const n = find(first, (c) => has(c, 'person-name')); if (n) n.click(); }
        if (d.act === 'moves' && first && mode === 'admin') {
          const b = find(first, (c) => c.getAttribute('data-pact') === 'down');
          focusEl(b && !b.disabled ? b : find(first, (c) => c.getAttribute('data-pact') === 'other'));
          try { first.scrollIntoView({ block: 'center' }); } catch (err) { /* a courtesy */ }
        }
        if (d.act === 'add' && mode === 'admin') {
          const plus = find(peopleRoot() || doc.body, (c) => has(c, 'hc-padd') && c.getAttribute('data-hc-padd') === 'alumni');
          if (plus) { plus.click(); try { (find(peopleRoot(), (c) => has(c, 'hc-pnew')) || plus).scrollIntoView({ block: 'center' }); } catch (err) { /* a courtesy */ } }
        }
        const shown = (x) => Boolean(x && win.getComputedStyle && win.getComputedStyle(x).display !== 'none');
        const ownCard = allCards().find((c) => c.getAttribute('data-hc-own') === '1') || null;
        e.source.postMessage({ type: 'hc-walk-people-state', act: d.act, mode, own: ownCard ? ownCard.getAttribute('data-hc-name') : null,
          owns: allCards().filter((c) => c.getAttribute('data-hc-own') === '1').length,
          grips: findAll(peopleRoot() || doc.body, (c) => has(c, 'hc-pgrip')).length,
          typing: Boolean(editing && doc.activeElement === editing.el),
          moves: shown(first && find(first, (c) => has(c, 'hc-pmoves'))),
          fresh: Boolean(find(peopleRoot() || doc.body, (c) => has(c, 'hc-pnew'))) }, e.origin);
      });
    }

    return Object.freeze({ sync: syncPeople, close() { endEdit(false); endDrag(); } });
  }

  const api = Object.freeze({ peopleMove, dropIndexAt, dragDecide, moveStatus, create });
  if (typeof window !== 'undefined') window.HCEditorPeople = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}());
