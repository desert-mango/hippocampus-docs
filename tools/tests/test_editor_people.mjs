// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 26 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test the Team page's people tools in the preview frame (js/editor-people.js) and how the frame loads them.
/* The people tools' own tests (editor UI/UX build: U0 moved them out of js/editor-frame.js; U5 adds its tests here).

     node --test tools/tests/test_editor_people.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { El, el, makeDoc, setupPage, fakeHC, fakeWin, scriptsIn, runScripts } from './frame_harness.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const EF = require(path.join(ROOT, 'js', 'editor-frame.js'));
const readRepo = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const PEOPLE = { edit: true, marks: [], focus: null };

/* The Team page as js/app.js leaves it, reduced to #people-root (no cards: the lists are browser checks). */
function teamPage() {
  const doc = makeDoc();
  const content = el(doc, 'main', { id: 'content', class: 'content' });
  const root = el(doc, 'div', { id: 'people-root' });
  root.querySelector = () => null;
  root.querySelectorAll = () => [];
  content.appendChild(root);
  doc.body.appendChild(content);
  return { doc, root };
}

test('U0: js/editor-people.js exports peopleMove and create; js/editor-frame.js no longer holds the people tools', () => {
  const EP = require(path.join(ROOT, 'js', 'editor-people.js'));
  assert.ok(Object.isFrozen(EP));
  assert.equal(typeof EP.peopleMove, 'function');
  assert.equal(typeof EP.create, 'function');
  assert.equal(EF.peopleMove, undefined, 'the frame file exports no people rule');
  const frame = readRepo('js/editor-frame.js');
  for (const name of ['function openMenu', 'function wireCard', 'function wireGrid', 'function addCard', 'function paintPeopleMarks', 'function peopleMove']) {
    assert.ok(!frame.includes(name), `${name} left js/editor-frame.js`);
  }
  assert.ok(!/editor-people/.test(readRepo('index.html')), 'index.html never names it: the frame loads it on demand');
});

test('U0: the frame loads js/editor-people.js once, only on the Team page with Editor mode on', () => {
  // another page, Editor on: nothing
  const setup = setupPage();
  const HC1 = fakeHC();
  EF.create(fakeWin(), setup.doc, HC1);
  HC1.send({ on: true, people: PEOPLE });
  assert.deepEqual(scriptsIn(setup.doc), [], 'not on a page without #people-root');
  // the Team page, Editor off: nothing
  const { doc } = teamPage();
  const win = fakeWin();
  const HC = fakeHC();
  EF.create(win, doc, HC);
  HC.send({ on: false, people: PEOPLE });
  HC.send({ on: true });
  assert.deepEqual(scriptsIn(doc), [], 'Editor off, or no people state: nothing loads');
  assert.equal(doc.body.classList.contains('hc-people-edit'), false);
  // Editor on: the people tools, once
  HC.send({ on: true, people: PEOPLE });
  HC.send({ on: true, people: PEOPLE });
  assert.deepEqual(scriptsIn(doc), ['js/editor-people.js']);
  assert.deepEqual(runScripts(win, doc), ['js/editor-people.js']);
  assert.equal(typeof win.HCEditorPeople.create, 'function');
});

test('U0: once loaded, the people tools follow the parent: hc-people-edit on with edit rights, off without', async () => {
  const { doc } = teamPage();
  const win = fakeWin();
  const HC = fakeHC();
  EF.create(win, doc, HC);
  HC.send({ on: true, people: PEOPLE });
  runScripts(win, doc);
  await new Promise((r) => setImmediate(r));
  assert.equal(doc.body.classList.contains('hc-people-edit'), true, 'the state sent before the load is applied');
  HC.send({ on: true, people: Object.assign({}, PEOPLE, { edit: false }) });
  assert.equal(doc.body.classList.contains('hc-people-edit'), false);
  HC.send({ on: true, people: PEOPLE });
  assert.equal(doc.body.classList.contains('hc-people-edit'), true);
  HC.send({ on: false, people: PEOPLE });
  assert.deepEqual(scriptsIn(doc), ['js/editor-people.js'], 'still one load');
});

// ---------------------------------------------------------------- U5 (plan D15, D16) ---
/* The Team page with cards, as js/app.js draws it; the harness grants no focus, so these nodes get one (the
   document's activeElement), and drag tests give the grids and cards their boxes. */
El.prototype.focus = function focus() { this.ownerDocument.activeElement = this; };
const EP = require(path.join(ROOT, 'js', 'editor-people.js'));
const cls = (n) => (n.className ? n.className.split(' ') : []);
const all = (n, pred, out = []) => { for (const c of n.childNodes || []) if (c.nodeType === 1) { if (pred(c)) out.push(c); all(c, pred, out); } return out; };
const one = (n, pred) => all(n, pred)[0] || null;
const byCls = (n, c) => all(n, (x) => cls(x).includes(c));
function card(doc, name, o = {}) {
  const attrs = { class: o.link ? 'person-card' : 'person-card is-static', 'data-hc-name': name, 'data-hc-person': name,
    'data-linked': o.linked ? '1' : '0', 'data-active': o.active ? '1' : '0', 'data-pinned': o.pinned ? '1' : '0' };
  if (o.link) attrs.href = o.link; else { attrs.role = 'button'; attrs.tabindex = '0'; }
  return el(doc, o.link ? 'a' : 'div', attrs, el(doc, 'img', { class: 'person-photo', alt: '' }),
    el(doc, 'span', { class: 'person-name' }, name), el(doc, 'span', { class: 'person-title' }, o.title || 'Student'));
}
function roster(spec) {
  const doc = makeDoc();
  const root = el(doc, 'div', { id: 'people-root' });
  for (const [list, people] of Object.entries(spec || { team: [['Ann', { link: 'https://example.org/ann', linked: true, pinned: true }], ['Ben']], alumni: [['Cid']] })) {
    root.appendChild(el(doc, 'div', { class: 'people-group', 'data-hc-list': list }, el(doc, 'h2', null, list),
      el(doc, 'div', { class: 'people-grid' }, ...people.map(([n, o]) => card(doc, n, o)))));
  }
  doc.body.appendChild(el(doc, 'main', { id: 'content' }, root));
  const timers = [];
  const delays = [];
  const win = { setTimeout: (fn, ms) => { timers.push(fn); delays.push(ms); return timers.length; }, clearTimeout: () => {}, innerHeight: 800, scrollBy() {} };
  const HC = fakeHC();
  const tools = EP.create({ win, doc, HC, inView: () => true, classesOf: cls });
  const sync = (m) => tools.sync(Object.assign({ on: true, people: { edit: false, marks: [], focus: null } }, m));
  const cardOf = (n) => one(root, (c) => c.getAttribute('data-hc-name') === n && cls(c).includes('person-card'));
  return { doc, root, HC, tools, sync, timers, delays, cardOf, admin: (extra) => sync(Object.assign({ people: { edit: true, marks: [], focus: null } }, extra)) };
}
const evt = (extra) => Object.assign({ button: 0 }, extra);

test('U5 pure: dropIndexAt (rows of cards), dragDecide (3 px; a finger after a long press), moveStatus', () => {
  const r = (left, top) => ({ left, top, right: left + 100, bottom: top + 100 });
  const rects = [r(0, 0), r(110, 0), r(0, 110)];
  assert.equal(EP.dropIndexAt(rects, 20, 50), 0, 'left half of the first card');
  assert.equal(EP.dropIndexAt(rects, 80, 50), 1, 'right half: after it');
  assert.equal(EP.dropIndexAt(rects, 300, 50), 2, 'past the row: before the next row');
  assert.equal(EP.dropIndexAt(rects, 20, 150), 2);
  assert.equal(EP.dropIndexAt(rects, 20, 400), 3, 'below everyone: last');
  assert.equal(EP.dropIndexAt([], 0, 0), 0);
  assert.equal(EP.dragDecide({ dx: 1, dy: 1, ms: 50 }), 'wait', 'a click moves nothing');
  assert.equal(EP.dragDecide({ dx: 3, dy: 0, ms: 5 }), 'lift');
  assert.equal(EP.dragDecide({ dx: 0, dy: 0, ms: 100, touch: true }), 'wait');
  assert.equal(EP.dragDecide({ dx: 2, dy: 2, ms: 400, touch: true }), 'lift', 'held: a drag');
  assert.equal(EP.dragDecide({ dx: 0, dy: 20, ms: 100, touch: true }), 'cancel', 'a finger that travels first is a scroll');
  const lists = { team: [{ name: 'Ann' }, { name: 'Ben' }], alumni: [{ name: 'Cid' }] };
  assert.equal(EP.moveStatus(lists, 'Ben'), 'Ben moved to position 2 of 2 in Current team');
  assert.equal(EP.moveStatus(lists, 'Cid'), 'Cid moved to position 1 of 1 in Alumni');
  assert.equal(EP.moveStatus(lists, 'Nobody'), '');
});

test('U5 D16: an admin gets every card\'s tools — a hidden grip, a named remove control, Move buttons named with the person (ends disabled), a pin glyph; no menu', () => {
  const t = roster();
  t.admin();
  t.admin();
  assert.equal(t.doc.body.classList.contains('hc-people-edit'), true);
  for (const n of ['Ann', 'Ben', 'Cid']) {
    const c = t.cardOf(n);
    const grip = byCls(c, 'hc-pgrip');
    assert.equal(grip.length, 1, `${n}: one grip`);
    assert.equal(grip[0].getAttribute('aria-hidden'), 'true', 'the grip is hidden from screen readers');
    assert.equal(grip[0].tagName, 'SPAN', 'never focusable');
    assert.equal(byCls(c, 'hc-premove')[0].getAttribute('aria-label'), `Remove ${n}`);
  }
  const moves = (n) => byCls(t.cardOf(n), 'hc-pmove').map((b) => [b.getAttribute('aria-label'), b.disabled]);
  assert.deepEqual(moves('Ann'), [['Move Ann up', true], ['Move Ann down', false], ['Move Ann to Alumni', false]]);
  assert.deepEqual(moves('Ben'), [['Move Ben up', false], ['Move Ben down', true], ['Move Ben to Alumni', false]]);
  assert.deepEqual(moves('Cid'), [['Move Cid up', true], ['Move Cid down', true], ['Move Cid to the current team', false]]);
  const pin = byCls(t.cardOf('Ann'), 'hc-ppin');
  assert.equal(pin.length, 1);
  assert.equal(pin[0].getAttribute('title'), 'Pinned: stays on the current team');
  assert.equal(byCls(t.cardOf('Ben'), 'hc-ppin').length, 0, 'no pin, no glyph');
  assert.equal(all(t.root, (x) => x.getAttribute('role') === 'menu').length, 0, 'the card menu is gone');
  assert.ok(!/Unpin|Pin to/.test(t.root.textContent), 'no pin words');
  assert.equal(all(t.root, (x) => x.getAttribute('role') === 'status').length, 1, 'one status region, before any move');
  assert.equal(byCls(t.root, 'hc-padd').length, 2, 'a "+" card at the end of each list');
});

test('U5 D16: click a name or a title to type — Enter keeps it (posted), Escape puts it back; the photo asks for a file; a card is not followed', () => {
  const t = roster();
  t.admin();
  const ann = t.cardOf('Ann');
  const name = byCls(ann, 'person-name')[0];
  const ev = ann.dispatch('click', name);
  assert.equal(name.getAttribute('contenteditable'), 'true');
  assert.equal(name.getAttribute('aria-label'), 'Name of Ann');
  assert.equal(t.doc.activeElement, name);
  name.textContent = '  Ann  Lee ';
  ann.dispatch('keydown', name, { key: 'Enter' });
  assert.equal(name.getAttribute('contenteditable'), null);
  assert.deepEqual(t.HC.posts.at(-1), { type: 'hc-people', op: 'field', name: 'Ann', field: 'name', value: 'Ann Lee' });
  const title = byCls(ann, 'person-title')[0];
  ann.dispatch('click', title);
  title.textContent = 'Changed';
  ann.dispatch('keydown', title, { key: 'Escape' });
  assert.equal(title.textContent, 'Student', 'Escape: as it was');
  assert.equal(t.HC.posts.length, 1, 'nothing posted');
  ann.dispatch('click', title);
  title.textContent = 'Lead';
  ann.dispatch('focusout', title);
  assert.deepEqual(t.HC.posts.at(-1), { type: 'hc-people', op: 'field', name: 'Ann', field: 'title', value: 'Lead' }, 'leaving the field keeps it');
  ann.dispatch('click', name);
  name.textContent = '   ';
  ann.dispatch('keydown', name, { key: 'Enter' });
  assert.equal(t.HC.posts.length, 2, 'an empty name is never sent');
  ann.dispatch('click', byCls(ann, 'person-photo')[0]);
  assert.deepEqual(t.HC.posts.at(-1), { type: 'hc-people', op: 'field', name: 'Ann', field: 'photo' });
  // the click on the card itself (a link) is the editor's
  let followed = true;
  ann.listeners.click[0]({ target: ann, preventDefault() { followed = false; }, stopPropagation() {} });
  assert.equal(followed, false);
  assert.ok(ev === undefined);
});

test('U5 D16: a Move button posts the order and its act; after the reload focus is back on it (the other one at an end) and the move is said once', () => {
  const t = roster();
  t.admin();
  const down = byCls(t.cardOf('Ann'), 'hc-pmove').find((b) => b.getAttribute('data-pact') === 'down');
  down.click();
  const m = t.HC.posts.at(-1);
  assert.deepEqual([m.op, m.act, m.focus, m.team.map((x) => x.name)], ['order', 'down', 'Ann', ['Ben', 'Ann']]);
  // the parent reloads the page from my draft; here: a new page in the new order
  const r = roster({ team: [['Ben'], ['Ann', { linked: true, pinned: true }]], alumni: [['Cid']] });
  r.admin({ people: { edit: true, marks: [], focus: 'Ann' }, peopleAct: 'down' });
  const again = byCls(r.cardOf('Ann'), 'hc-pmove');
  assert.equal(again.find((b) => b.getAttribute('data-pact') === 'down').disabled, true, 'last now');
  assert.equal(r.doc.activeElement, again.find((b) => b.getAttribute('data-pact') === 'up'), 'focus handed to the other button');
  const live = byCls(r.root, 'hc-plive')[0];
  // F2: the region is new in this reloaded page, so it starts empty and the line comes a moment later (read out)
  assert.equal(live.textContent, '', 'empty when the status region is created');
  assert.equal(r.delays.length, 1);
  assert.ok(r.delays[0] >= 100 && r.delays[0] <= 150, `written ${r.delays[0]} ms later`);
  r.timers.at(-1)();
  assert.equal(live.textContent, 'Ann moved to position 2 of 2 in Current team');
  r.admin({ people: { edit: true, marks: [], focus: 'Ann' }, peopleAct: 'down' });
  assert.equal(byCls(r.root, 'hc-plive').length, 1);
  // the same button when it is still enabled
  const s = roster({ team: [['Ann'], ['Ben'], ['Eve']], alumni: [] });
  s.admin({ people: { edit: true, marks: [], focus: 'Ben' }, peopleAct: 'down' });
  assert.equal(s.doc.activeElement.getAttribute('data-pact'), 'down');
  // a disabled button does nothing; Move to Alumni moves across
  byCls(t.cardOf('Ann'), 'hc-pmove')[0].click();
  assert.equal(t.HC.posts.length, 1, 'Move up at the top: nothing');
  byCls(t.cardOf('Ben'), 'hc-pmove')[2].click();
  assert.deepEqual(t.HC.posts.at(-1).alumni.map((x) => x.name), ['Ben', 'Cid']);
});

test('U5 D16: remove posts the person; a refused change is shown with role="alert" until the next good one', () => {
  const t = roster();
  t.admin();
  byCls(t.cardOf('Cid'), 'hc-premove')[0].click();
  assert.deepEqual(t.HC.posts.at(-1), { type: 'hc-people', op: 'remove', name: 'Cid' });
  t.admin({ peopleAlert: 'GitHub did not answer: nothing was changed.' });
  const alert = all(t.root, (x) => x.getAttribute('role') === 'alert')[0];
  assert.equal(alert.hidden, false);
  assert.equal(alert.textContent, 'GitHub did not answer: nothing was changed.');
  t.admin();
  assert.equal(alert.hidden, true);
});

test('U5 D16 (ED57): "+" turns into an empty card in place — GitHub account, Name, Title, Link, photo, Add; a name is needed; Escape puts "+" back', () => {
  const t = roster();
  t.admin();
  const plus = byCls(t.root, 'hc-padd').find((x) => x.getAttribute('data-hc-padd') === 'alumni');
  plus.click();
  const fresh = byCls(t.root, 'hc-pnew');
  assert.equal(fresh.length, 1);
  const labels = byCls(fresh[0], 'hc-pnew-label').map((x) => x.textContent);
  assert.deepEqual(labels, ['GitHub account', 'Name', 'Title', 'Link']);
  const input = (k) => one(fresh[0], (x) => x.getAttribute('data-hc-pfield') === k);
  assert.equal(t.doc.activeElement, input('login'), 'the first field has focus');
  assert.ok(/profile image/.test(fresh[0].textContent));
  byCls(fresh[0], 'hc-pnew-add')[0].click();
  assert.equal(t.HC.posts.length, 0);
  assert.equal(byCls(fresh[0], 'hc-pnew-problem')[0].textContent, 'A name is needed.');
  input('login').value = '@dana-x';
  input('name').value = ' Dana ';
  input('title').value = 'Student';
  input('link').value = 'https://example.org/dana';
  input('photo').checked = true;
  fresh[0].dispatch('keydown', input('title'), { key: 'Enter' });
  assert.deepEqual(t.HC.posts.at(-1), { type: 'hc-people', op: 'add-in-place', group: 'alumni', login: '@dana-x', name: 'Dana',
    title: 'Student', link: 'https://example.org/dana', photo: true });
  fresh[0].dispatch('keydown', input('name'), { key: 'Escape' });
  assert.equal(byCls(t.root, 'hc-pnew').length, 0);
  assert.equal(byCls(t.root, 'hc-padd').length, 2, '"+" is back');
  t.admin();
  assert.equal(byCls(t.root, 'hc-padd').length, 2, 'still two');
});

test('U5 D15 (ED56): anyone else reads the page as it is, except their own card (data-hc-own): its name and photo, never the title', () => {
  const t = roster();
  t.sync({ peopleOwn: 'Ben' });
  assert.equal(t.doc.body.classList.contains('hc-people-edit'), false, 'reading mode');
  assert.equal(t.cardOf('Ben').getAttribute('data-hc-own'), '1');
  assert.equal(all(t.root, (x) => x.getAttribute('data-hc-own') !== null).length, 1, 'one own card');
  for (const c of ['hc-pgrip', 'hc-pmove', 'hc-premove', 'hc-padd', 'hc-ppin']) assert.equal(byCls(t.root, c).length, 0, `no ${c}`);
  const ben = t.cardOf('Ben');
  const title = byCls(ben, 'person-title')[0];
  ben.dispatch('click', title);
  assert.equal(title.getAttribute('contenteditable'), null, 'not the title');
  const name = byCls(ben, 'person-name')[0];
  ben.dispatch('click', name);
  name.textContent = 'Benjamin';
  ben.dispatch('keydown', name, { key: 'Enter' });
  assert.deepEqual(t.HC.posts.at(-1), { type: 'hc-people', op: 'field', name: 'Ben', field: 'name', value: 'Benjamin' });
  ben.dispatch('click', byCls(ben, 'person-photo')[0]);
  assert.equal(t.HC.posts.at(-1).field, 'photo');
  const ann = t.cardOf('Ann');
  ann.dispatch('click', byCls(ann, 'person-name')[0]);
  assert.equal(byCls(ann, 'person-name')[0].getAttribute('contenteditable'), null, 'another card: nothing');
  assert.equal(t.HC.posts.length, 2);
  // no rights at all: the page as it is, the tools taken off
  t.admin();
  t.sync({});
  assert.equal(all(t.root, (x) => x.getAttribute('data-hc-ptools') !== null || x.getAttribute('data-hc-own') !== null).length, 0);
  assert.equal(byCls(t.root, 'hc-pmove').length + byCls(t.root, 'hc-padd').length, 0);
});

test('U5 D16: drag from the grip — lifted after 3 px, dropped among the other list\'s cards; Escape or a drop outside saves nothing; a finger waits for a long press', () => {
  const t = roster();
  const box = (n, left, top, w = 100, hgt = 100) => { n.getBoundingClientRect = () => ({ left, top, right: left + w, bottom: top + hgt, width: w, height: hgt }); };
  const grids = byCls(t.root, 'people-grid');
  box(grids[0], 0, 0, 400, 100);
  box(grids[1], 0, 200, 400, 100);
  box(t.cardOf('Ann'), 0, 0); box(t.cardOf('Ben'), 110, 0); box(t.cardOf('Cid'), 0, 200);
  for (const c of [t.cardOf('Ann'), t.cardOf('Ben'), t.cardOf('Cid')]) c.cloneNode = () => { const k = el(t.doc, 'div'); k.style = {}; return k; };
  t.admin();
  const fire = (type, e) => t.doc.listeners[type].forEach((fn) => fn(Object.assign({ preventDefault() {} }, e)));
  const grip = byCls(t.cardOf('Ben'), 'hc-pgrip')[0];
  grip.setPointerCapture = () => {};
  // F3: a long press on the grip (inside a link) raises no platform menu or callout
  let blocked = false;
  for (const fn of (grip.listeners && grip.listeners.contextmenu) || []) fn({ type: 'contextmenu', target: grip, preventDefault() { blocked = true; } });
  assert.equal(blocked, true, 'contextmenu is refused on the grip');
  assert.match(readRepo('css/editor.css'), /\.hc-pgrip \{[^}]*-webkit-touch-callout: none/);
  grip.dispatch('pointerdown', grip, evt({ pointerId: 1, clientX: 150, clientY: 50, pointerType: 'mouse' }));
  fire('pointermove', { pointerId: 1, clientX: 151, clientY: 51 });
  assert.equal(t.cardOf('Ben').classList.contains('is-dragging'), false, 'not lifted by 1 px');
  fire('pointermove', { pointerId: 1, clientX: 20, clientY: 250 });
  assert.equal(t.cardOf('Ben').classList.contains('is-dragging'), true, 'lifted');
  assert.equal(t.cardOf('Cid').classList.contains('hc-pdrop-before'), true, 'the drop line before Cid');
  fire('pointermove', { pointerId: 2, clientX: 900, clientY: 900 });               // a second finger: ignored
  fire('pointerup', { pointerId: 1, clientX: 20, clientY: 250 });
  const m = t.HC.posts.at(-1);
  assert.deepEqual([m.op, m.act, m.team.map((x) => x.name), m.alumni.map((x) => x.name)], ['order', 'drop', ['Ann'], ['Ben', 'Cid']]);
  assert.equal(t.cardOf('Ben').classList.contains('is-dragging'), false);
  // Escape mid-drag, and a drop outside both lists: nothing
  grip.dispatch('pointerdown', grip, evt({ pointerId: 3, clientX: 150, clientY: 50, pointerType: 'mouse' }));
  fire('pointermove', { pointerId: 3, clientX: 20, clientY: 250 });
  fire('keydown', { key: 'Escape' });
  fire('pointerup', { pointerId: 3, clientX: 20, clientY: 250 });
  grip.dispatch('pointerdown', grip, evt({ pointerId: 4, clientX: 150, clientY: 50, pointerType: 'mouse' }));
  fire('pointermove', { pointerId: 4, clientX: 900, clientY: 900 });
  fire('pointerup', { pointerId: 4, clientX: 900, clientY: 900 });
  // a drop where it was: nothing
  grip.dispatch('pointerdown', grip, evt({ pointerId: 5, clientX: 150, clientY: 50, pointerType: 'mouse' }));
  fire('pointermove', { pointerId: 5, clientX: 190, clientY: 50 });
  fire('pointerup', { pointerId: 5, clientX: 190, clientY: 50 });
  assert.equal(t.HC.posts.length, 1, 'only the first drop was sent');
  // a finger: travelling first is a scroll; held, it lifts
  grip.dispatch('pointerdown', grip, evt({ pointerId: 6, clientX: 150, clientY: 50, pointerType: 'touch' }));
  fire('pointermove', { pointerId: 6, clientX: 150, clientY: 90 });
  t.timers.at(-1)();
  assert.equal(t.cardOf('Ben').classList.contains('is-dragging'), false, 'a scroll, not a drag');
  grip.dispatch('pointerdown', grip, evt({ pointerId: 7, clientX: 150, clientY: 50, pointerType: 'touch' }));
  t.timers.at(-1)();
  assert.equal(t.cardOf('Ben').classList.contains('is-dragging'), true, 'the long press lifts it');
  fire('pointercancel', { pointerId: 7 });
  assert.equal(t.cardOf('Ben').classList.contains('is-dragging'), false);
});

/* ---- fix pass ---- */
test('fix A3 (WCAG 2.1.1): Enter or Space on a card types its name; "Edit title" and "Replace photo" beside the Move buttons, named with the person', () => {
  const t = roster();
  t.admin();
  const ann = t.cardOf('Ann');
  const name = byCls(ann, 'person-name')[0];
  const ev = { key: 'Enter', prevented: false };
  ann.dispatch('keydown', ann, { key: 'Enter' });
  assert.equal(name.getAttribute('contenteditable'), 'true', 'Enter on the card: the name is typed');
  assert.equal(t.doc.activeElement, name);
  name.textContent = 'Ann Lee';
  ann.dispatch('keydown', name, { key: 'Enter' });
  assert.deepEqual(t.HC.posts.at(-1), { type: 'hc-people', op: 'field', name: 'Ann', field: 'name', value: 'Ann Lee' });
  assert.equal(t.doc.activeElement, ann, 'focus back on the card');
  const ben = t.cardOf('Ben');
  ben.dispatch('keydown', ben, { key: ' ' });
  assert.equal(byCls(ben, 'person-name')[0].getAttribute('contenteditable'), 'true', 'Space too');
  ben.dispatch('keydown', byCls(ben, 'person-name')[0], { key: 'Escape' });
  assert.equal(byCls(ben, 'person-name')[0].getAttribute('contenteditable'), null, 'Escape cancels');
  const fields = byCls(ann, 'hc-pfields');
  assert.equal(fields.length, 1, 'one group of field buttons');
  assert.ok(cls(fields[0]).includes('hc-ptool'), 'a tool: taken off with the others');
  const btns = byCls(ann, 'hc-pfield');
  assert.deepEqual(btns.map((b) => [b.tagName, b.getAttribute('aria-label'), b.textContent]),
    [['BUTTON', 'Edit the title of Ann', 'Edit title'], ['BUTTON', 'Replace the photo of Ann', 'Replace photo']]);
  btns[0].click();
  const title = byCls(ann, 'person-title')[0];
  assert.equal(title.getAttribute('contenteditable'), 'true', 'Edit title: the title is typed');
  title.textContent = 'Lead';
  ann.dispatch('keydown', title, { key: 'Enter' });
  assert.deepEqual(t.HC.posts.at(-1), { type: 'hc-people', op: 'field', name: 'Ann', field: 'title', value: 'Lead' });
  btns[1].click();
  assert.deepEqual(t.HC.posts.at(-1), { type: 'hc-people', op: 'field', name: 'Ann', field: 'photo' });
  void ev;
  // my own card (not an admin): Enter types the name; only "Replace photo" (never the title)
  const o = roster();
  o.sync({ peopleOwn: 'Ben' });
  const obe = o.cardOf('Ben');
  assert.deepEqual(byCls(obe, 'hc-pfield').map((b) => b.getAttribute('aria-label')), ['Replace the photo of Ben']);
  obe.dispatch('keydown', obe, { key: 'Enter' });
  assert.equal(byCls(obe, 'person-name')[0].getAttribute('contenteditable'), 'true');
  const oann = o.cardOf('Ann');
  oann.dispatch('keydown', oann, { key: 'Enter' });
  assert.equal(byCls(oann, 'person-name')[0].getAttribute('contenteditable'), null, 'another card: nothing');
  assert.equal(byCls(oann, 'hc-pfield').length, 0);
  const css = fs.readFileSync(path.join(ROOT, 'css', 'editor.css'), 'utf8');
  assert.match(css, /:is\(:focus-visible, :has\(:focus-visible\)\) :is\(\.hc-pmoves, \.hc-pfields\), :is\(\.hc-pmoves, \.hc-pfields\):focus-within \{\s*position: static;/,
    'shown with the Move buttons, on keyboard focus or focus inside the group');
  const hidden = /\.hc-pmoves, \.hc-pfields \{([^}]*)\}/.exec(css);
  assert.ok(hidden && !/display:\s*none/.test(hidden[1]) && /clip-path: inset\(50%\)/.test(hidden[1]),
    'hidden by a clip, never display: none (a display: none button cannot take the focus handed back after a move)');
});

test('fix A3 (WCAG 3.3.1): the "+" card\'s error line is tied to its field; aria-invalid goes once the field is valid', () => {
  const t = roster();
  t.admin();
  byCls(t.root, 'hc-padd').find((x) => x.getAttribute('data-hc-padd') === 'team').click();
  const fresh = byCls(t.root, 'hc-pnew')[0];
  const input = (k) => one(fresh, (x) => x.getAttribute('data-hc-pfield') === k);
  const problem = byCls(fresh, 'hc-pnew-problem')[0];
  byCls(fresh, 'hc-pnew-add')[0].click();
  assert.equal(input('name').getAttribute('aria-invalid'), 'true');
  assert.equal(input('name').getAttribute('aria-describedby'), problem.getAttribute('id'));
  assert.ok(problem.getAttribute('id'), 'the error line has an id');
  input('name').value = 'Dana';
  fresh.dispatch('input', input('name'));
  assert.equal(input('name').getAttribute('aria-invalid'), null, 'valid again: no longer invalid');
  assert.equal(input('name').getAttribute('aria-describedby'), null);
  assert.equal(problem.textContent, '');
  input('login').value = 'bad login!';
  byCls(fresh, 'hc-pnew-add')[0].click();
  assert.equal(input('login').getAttribute('aria-describedby'), problem.getAttribute('id'));
  assert.equal(input('name').getAttribute('aria-invalid'), null, 'one field named at a time');
  input('login').value = 'dana';
  fresh.dispatch('input', input('login'));
  assert.equal(input('login').getAttribute('aria-invalid'), null);
});
