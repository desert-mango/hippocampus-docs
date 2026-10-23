// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 23 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: The Team page's people tools inside the Editor's preview frame: card menu, moves, drag, "+" cards, marks.
/* HCEditorPeople — the Team page's people tools, moved out of js/editor-frame.js (editor UI/UX build, unit U0;
   no behaviour change). js/editor-frame.js loads this file lazily, once, and only inside a preview frame when
   the Team page (#people-root) is shown with Editor mode on (hc-editor.people present); never on the live site,
   never for a guest, never on another page.

   The interface (window.HCEditorPeople, frozen; module.exports for node tests):
     peopleMove(lists, action)   the move rules (pure), shared by the card menu, Alt+arrows and drag
     create(ctx) -> {sync(s), close()}
         ctx = {win, doc, HC, inView(el), classesOf(node)} from the frame's runtime. sync(s) is the frame's
         syncPeople: it runs on every hc-editor message and page change once loaded; close() closes the card menu.
   It posts only hc-people {op: 'order', team, alumni, focus} and {op: 'add', group} (js/source.js section 9). */
(function () {
  'use strict';

  /* Round 2 (R5, Kyle 2026-10-15): the Team page's move rules, shared by the card menu, Alt+arrows and drag.
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

  function create(ctx) {
    const { win, doc, HC, inView, classesOf } = ctx;
    // ------------------------------------------- the Team page's people tools (round 2, R5) ---
    /* On the Team page (#people-root, js/app.js) in Editor mode, with my own edits allowed (hc-editor.people.edit):
       a light card-level affordance (no block line: item 5), a dashed "+" card at the end of each list, a card menu
       (Move up, Move down, Move to Alumni / the team, Pin / Unpin, Open their page) on click or Enter, Alt+Up/Down
       on a focused card, and drag and drop. Every move goes through peopleMove and is posted as hc-people {order}:
       the parent writes my draft and reloads. The marks of a draft or a proposal (hc-editor.people.marks) outline
       the changed cards in the proposer's colour with a word (New, Moved, Pinned, Unpinned, Changed); a removed
       person is a faded, struck ghost at the end of their old list. */
    const BADGE = Object.freeze({ add: 'New', move: 'Moved', pin: 'Pinned', unpin: 'Unpinned', edit: 'Changed', del: 'Removed' });
    let peopleKey = null;
    let focusedOnce = null;
    const FOCUS_MS = 2500;
    let pmenu = null;
    let dragName = null;
    const peopleRoot = () => doc.getElementById ? doc.getElementById('people-root') : null;
    // the people's own cards: never the "+" card or a removed person's ghost (a list with either would be refused)
    const cardsIn = (grid) => Array.from(grid.children).filter((c) => classesOf(c).indexOf('person-card') >= 0
      && classesOf(c).indexOf('hc-pghost') < 0 && classesOf(c).indexOf('hc-padd') < 0 && c.getAttribute('data-hc-name'));
    function gridOf(list) {
      const root = peopleRoot();
      const g = root ? root.querySelector(`.people-group[data-hc-list="${list}"] .people-grid`) : null;
      return g || null;
    }
    function shownLists() {
      const read = (list) => { const g = gridOf(list); return g ? cardsIn(g).map((c) => ({ name: c.getAttribute('data-hc-name'),
        linked: c.getAttribute('data-linked') === '1', active: c.getAttribute('data-active') === '1', pinned: c.getAttribute('data-pinned') === '1' })) : []; };
      return { team: read('team'), alumni: read('alumni') };
    }
    function movePerson(action) {
      const out = peopleMove(shownLists(), action);
      closeMenu();
      if (!out) return;
      const strip = (l) => l.map((x) => ({ name: x.name, pinned: x.pinned === true }));
      HC.post('hc-people', { op: 'order', team: strip(out.team), alumni: strip(out.alumni), focus: action.name });
    }
    function closeMenu() { if (pmenu) { pmenu.remove(); pmenu = null; } }
    function openMenu(card) {
      closeMenu();
      const name = card.getAttribute('data-hc-name');
      const list = card.closest('[data-hc-list]').getAttribute('data-hc-list');
      const linked = card.getAttribute('data-linked') === '1';
      const pinned = card.getAttribute('data-pinned') === '1';
      const menu = doc.createElement('div');
      menu.className = 'hc-pmenu';
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', `${name}: move or pin`);
      const item = (label, fn, act) => {
        const b = doc.createElement('button');
        b.type = 'button';
        b.className = 'hc-pmenu-item';
        b.setAttribute('role', 'menuitem');
        b.setAttribute('data-pact', act);
        b.textContent = label;
        b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
        menu.appendChild(b);
        return b;
      };
      item('Move up', () => movePerson({ op: 'up', name }), 'up');
      item('Move down', () => movePerson({ op: 'down', name }), 'down');
      item(list === 'team' ? 'Move to Alumni' : 'Move to the current team', () => movePerson({ op: 'other', name }), 'other');
      const where = list === 'team' ? 'the team' : 'the alumni';     // a pin holds them in the list they are in
      if (linked) item(pinned ? `Unpin from ${where}` : `Pin to ${where}`, () => movePerson({ op: 'pin', name }), 'pin');
      const href = card.getAttribute('href');
      if (href) item('Open their page', () => { closeMenu(); win.open(href, '_blank', 'noopener'); }, 'open');
      menu.addEventListener('keydown', (e) => {
        const items = Array.from(menu.children);
        const at = items.indexOf(doc.activeElement);
        if (e.key === 'Escape') { e.preventDefault(); closeMenu(); card.focus(); }
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
        }
      });
      doc.body.appendChild(menu);
      // beside the card, and always whole on screen (clamped to the frame's viewport)
      const r = card.getBoundingClientRect();
      // over the lower part of the card that was clicked (so it is on screen wherever the page is scrolled)
      menu.style.top = `${Math.round(r.top + Math.min(r.height * 0.45, 120) + win.scrollY)}px`;
      menu.style.left = `${Math.round(Math.max(8, Math.min(r.right - 4, (win.innerWidth || 1200) - 228)) + win.scrollX)}px`;
      pmenu = menu;
      menu.firstChild.focus();
    }
    function dropIndex(grid, x, y) {
      const cards = cardsIn(grid).filter((c) => c.getAttribute('data-hc-name') !== dragName);
      for (let i = 0; i < cards.length; i += 1) {
        const r = cards[i].getBoundingClientRect();
        if (y < r.top) return i;
        if (y <= r.bottom && x < r.left + r.width / 2) return i;
      }
      return cards.length;
    }
    function wireCard(card) {
      if (card.getAttribute('data-hc-ptools') === '1') return;
      card.setAttribute('data-hc-ptools', '1');
      if (!card.hasAttribute('tabindex') && card.tagName !== 'A') card.setAttribute('tabindex', '0');
      card.setAttribute('draggable', 'true');
      card.setAttribute('aria-haspopup', 'menu');
      card.addEventListener('click', (e) => {
        if (!doc.body.classList.contains('hc-people-edit')) return;
        e.preventDefault();                       // in Editor mode a card opens its menu, not the person's page
        e.stopPropagation();
        openMenu(card);
      });
      card.addEventListener('keydown', (e) => {
        if (!doc.body.classList.contains('hc-people-edit')) return;
        const name = card.getAttribute('data-hc-name');
        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); movePerson({ op: e.key === 'ArrowUp' ? 'up' : 'down', name }); }
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMenu(card); }
      });
      card.addEventListener('dragstart', (e) => {
        if (!doc.body.classList.contains('hc-people-edit')) return;
        dragName = card.getAttribute('data-hc-name');
        card.classList.add('is-dragging');
        try { e.dataTransfer.setData('text/plain', dragName); e.dataTransfer.effectAllowed = 'move'; } catch (err) { /* the name is kept here too */ }
      });
      card.addEventListener('dragend', () => { card.classList.remove('is-dragging'); dragName = null; });
    }
    function wireGrid(grid, list) {
      if (grid.getAttribute('data-hc-ptools') === '1') return;
      grid.setAttribute('data-hc-ptools', '1');
      grid.addEventListener('dragover', (e) => { if (dragName) { e.preventDefault(); grid.classList.add('is-drop'); } });
      grid.addEventListener('dragleave', () => grid.classList.remove('is-drop'));
      grid.addEventListener('drop', (e) => {
        grid.classList.remove('is-drop');
        if (!dragName) return;
        e.preventDefault();
        const name = dragName;
        const index = dropIndex(grid, e.clientX, e.clientY);
        dragName = null;
        movePerson({ op: 'drop', name, list, index });
      });
    }
    function addCard(grid, list) {
      let plus = Array.from(grid.children).find((c) => classesOf(c).indexOf('hc-padd') >= 0);
      if (!plus) {
        plus = doc.createElement('button');
        plus.type = 'button';
        plus.className = 'person-card hc-padd';
        plus.setAttribute('data-hc-padd', list);
        plus.setAttribute('aria-label', list === 'team' ? 'Add a person to the current team' : 'Add a person to the alumni');
        const mark = doc.createElement('span'); mark.className = 'hc-padd-plus'; mark.setAttribute('aria-hidden', 'true'); mark.textContent = '+';
        const label = doc.createElement('span'); label.className = 'person-name'; label.textContent = 'Add a person';
        plus.appendChild(mark); plus.appendChild(label);
        plus.addEventListener('click', (e) => { e.preventDefault(); HC.post('hc-people', { op: 'add', group: list }); });
      }
      if (plus !== grid.lastChild) grid.appendChild(plus);
    }
    function paintPeopleMarks(marks) {
      const root = peopleRoot();
      for (const c of Array.from(root.querySelectorAll('.person-card[data-hc-name]'))) {
        c.removeAttribute('data-hc-badge');
        for (const k of Object.keys(BADGE)) c.classList.remove(`hc-pmark-${k}`);
      }
      for (const g of Array.from(root.querySelectorAll('.hc-pghost'))) g.remove();
      const byName = new Map();
      for (const m of marks) { if (!byName.has(m.name)) byName.set(m.name, []); byName.get(m.name).push(m); }
      for (const [name, ms] of byName) {
        const del = ms.find((m) => m.mark === 'del');
        if (del) {
          const grid = gridOf(del.group === 'active' || del.group === 'team' ? 'team' : 'alumni');
          if (!grid) continue;
          const ghost = doc.createElement('div');
          ghost.className = 'person-card is-static hc-pghost hc-pmark-del';
          ghost.setAttribute('data-hc-badge', BADGE.del);
          const n = doc.createElement('span'); n.className = 'person-name'; n.textContent = name;
          ghost.appendChild(n);
          if (del.title) { const t = doc.createElement('span'); t.className = 'person-title'; t.textContent = del.title; ghost.appendChild(t); }
          grid.appendChild(ghost);
          continue;
        }
        const card = Array.from(root.querySelectorAll('.person-card[data-hc-name]')).find((c) => c.getAttribute('data-hc-name') === name);
        if (!card) continue;
        for (const m of ms) card.classList.add(`hc-pmark-${m.mark}`);
        card.setAttribute('data-hc-badge', ms.map((m) => BADGE[m.mark]).join(' · '));
      }
    }
    function syncPeople(s) {
      const root = peopleRoot();
      const b = doc.body;
      const edit = Boolean(root && s.on && s.people && s.people.edit);
      if (b) b.classList.toggle('hc-people-edit', edit);
      if (!root) { closeMenu(); return; }
      if (edit) {
        for (const list of ['team', 'alumni']) {
          const grid = gridOf(list);
          if (!grid) continue;
          wireGrid(grid, list);
          cardsIn(grid).forEach(wireCard);
          addCard(grid, list);
        }
      } else {
        closeMenu();
        for (const plus of Array.from(root.querySelectorAll('.hc-padd'))) plus.remove();
      }
      // after a reload, back to the person just moved or added: focused once, and kept in view while the page
      // settles (the lab activity above renders later and pushes the people down), never after FOCUS_MS
      const focus = s.on && s.people ? s.people.focus : null;
      const card = focus ? Array.from(root.querySelectorAll('.person-card[data-hc-name]')).find((c) => c.getAttribute('data-hc-name') === focus) : null;
      if (card && (!focusedOnce || focusedOnce.name !== focus)) {
        focusedOnce = { name: focus, until: Date.now() + FOCUS_MS };
        if (typeof card.focus === 'function') card.focus({ preventScroll: true });
      }
      if (card && focusedOnce && focusedOnce.name === focus && Date.now() < focusedOnce.until && !inView(card)) {
        try { card.scrollIntoView({ block: 'center' }); } catch (e) { /* a courtesy */ }
      }
      const key = JSON.stringify(s.on && s.people ? s.people.marks : []);
      if (key !== peopleKey) { peopleKey = key; paintPeopleMarks(s.on && s.people ? s.people.marks : []); }
    }
    if (doc.addEventListener) {
      doc.addEventListener('click', (e) => { if (pmenu && !(e.target && e.target.closest && e.target.closest('.hc-pmenu'))) closeMenu(); });
    }

    return Object.freeze({ sync: syncPeople, close: closeMenu });
  }

  const api = Object.freeze({ peopleMove, create });
  if (typeof window !== 'undefined') window.HCEditorPeople = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}());
