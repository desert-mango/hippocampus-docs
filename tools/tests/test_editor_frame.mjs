// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 26 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test the Editor mode's frame side (js/editor-frame.js): grouping, marks, picks and the no-op on the live site.
/* Unit tests for js/editor-frame.js over a small fake DOM (node has none).

   What they pin: on the live site the file does nothing at all; in a
   preview frame it posts hc-ready, reports link-followed routes, and on the
   parent's hc-editor {on: true} groups the page body's top-level children
   between THIS load's sentinels into .hc-block[data-index] wrappers
   (stopping at app.js/lab.js chrome), paints hc-selected and the overlay's
   hc-prop-* classes, sets the hc-framed body class (css/editor.css hides the
   frame's own chrome with it), and posts hc-block-select / hc-block-insert
   for the pencil, a click and the "+" picker. A real browser checks the
   same grouping over every content page (tools/tests/browser_oracles.mjs).

     node --test tools/tests/test_editor_frame.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { PREFIX, Node, Text, El, el, makeDoc, S, setupPage, fakeHC, fakeWin, kids, blocksOf, summary } from './frame_harness.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const EF = require(path.join(ROOT, 'js', 'editor-frame.js'));
const EP = require(path.join(ROOT, 'js', 'editor-people.js'));   // U0: the people tools moved out of editor-frame.js
const C = require(path.join(ROOT, 'js', 'cms-core.js'));

// ------------------------------------------------------------------ tests --

test('editor-frame: on the live site it does nothing — no listener, no post, no runtime', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'editor-frame.js'), 'utf8');
  const win = fakeWin();
  const posts = [];
  win.HC = { preview: false, blockPrefix: null, post: (t) => { posts.push(t); return false; }, onEditor: () => false };
  const doc = makeDoc();
  const ctx = vm.createContext(Object.assign(win, { document: doc, window: win }));
  win.window = ctx;
  vm.runInContext(src, ctx, { filename: 'editor-frame.js' });
  assert.equal(ctx.HCEditorFrame.runtime, null);
  assert.deepEqual(Object.keys(win.listeners), [], 'no window listener');
  assert.deepEqual(Object.keys(doc.listeners), [], 'no document listener');
  assert.deepEqual(posts, []);
  assert.equal(EF.create(win, doc, null), null);
});

test('editor-frame: in a frame it posts hc-ready, and hc-route when the reader follows a link', () => {
  const { doc } = setupPage();
  const win = fakeWin();
  const HC = fakeHC();
  EF.create(win, doc, HC);
  assert.deepEqual(HC.posts, [{ type: 'hc-ready' }]);
  win.location.hash = '#/setup/lab-gantry/usage';
  win.listeners.hashchange.forEach((fn) => fn({}));
  win.location.hash = '#preview=0123456789abcdef0123&route=%2F';   // js/source.js reloads for this one
  win.listeners.hashchange.forEach((fn) => fn({}));
  win.location.hash = '';
  win.listeners.hashchange.forEach((fn) => fn({}));
  assert.deepEqual(HC.posts.slice(1), [{ type: 'hc-route', route: '/setup/lab-gantry/usage' }, { type: 'hc-route', route: '/' }]);
});

test('editor-frame: grouping wraps exactly the elements between sentinels, and stops at page chrome', () => {
  const { doc, body } = setupPage();
  const HC = fakeHC();
  EF.create(fakeWin(), doc, HC);
  assert.equal(blocksOf(body).length, 0, 'nothing is grouped before the parent turns Editor mode on');
  HC.send({ on: true });
  const blocks = blocksOf(body);
  assert.deepEqual(blocks.map((w) => w.getAttribute('data-index')), ['0', '2', '3', '5']);
  assert.deepEqual(blocks.map(summary), [
    [`hcb-${PREFIX}-0`, 'h1'],
    [`hcb-${PREFIX}-2`, 'p', 'p'],
    [`hcb-${PREFIX}-3`, 'div.adm', 'hcb-ffffffffffffffff-9'],
    [`hcb-${PREFIX}-5`, 'div.code-wrap'],
  ]);
  const top = kids(body).map((c) => c.className.split(' ')[0] || c.tagName.toLowerCase());
  assert.deepEqual(top, ['hc-plus', 'hc-block', 'hc-plus', 'hc-block', 'hc-plus', 'hc-block', 'hc-plus', 'hc-block', 'hc-plus',
    'page-nav', 'hc-authors'], 'a rail before every block and after the last; nav and authors stay outside');
  // idempotent: another apply (a DOM change) changes nothing
  const before = JSON.stringify(kids(body).map((c) => [c.className, kids(c).length]));
  HC.send({ on: true });
  assert.equal(JSON.stringify(kids(body).map((c) => [c.className, kids(c).length])), before);
  // the pure helper agrees on a fresh page
  const fresh = setupPage();
  assert.deepEqual(EF.groupBlocks(fresh.doc, fresh.body, PREFIX).map((w) => summary(w)), blocks.map(summary));
  assert.equal(EF.sentinelIndex(el(doc, 'span', { id: `hcb-${PREFIX}-1` }), PREFIX), null, 'only a div is a mark');
  assert.equal(EF.sentinelIndex(el(doc, 'div', { id: `hcb-${PREFIX}-1x` }), PREFIX), null);
  assert.equal(EF.sentinelIndex(el(doc, 'div', { id: `hcb-${PREFIX}-12` }), PREFIX), 12);
});

test('editor-frame: a content file cannot fake a mark — only this load\'s prefix groups', () => {
  const { doc, body } = setupPage();
  const HC = fakeHC('0000000000000000');                 // the page carries other marks
  EF.create(fakeWin(), doc, HC);
  HC.send({ on: true });
  assert.equal(blocksOf(body).length, 0);
});

test('editor-frame: hc-framed, settings, hc-selected and the overlay classes follow the parent\'s message', () => {
  const { doc, body } = setupPage();
  const HC = fakeHC();
  EF.create(fakeWin(), doc, HC);
  HC.send({ on: false });
  assert.equal(doc.body.classList.contains('hc-framed'), false);
  assert.equal(blocksOf(body).length, 0, 'off draws nothing');
  HC.send({ on: true, selected: 2, overlay: [{ index: 3, mark: 'add' }, { index: 5, mark: 'del' }],
    settings: { suggestions: false, diff: 'side', compact: true, outlines: false } });
  const b = doc.body.classList;
  assert.ok(b.contains('hc-framed') && b.contains('hc-edit-on') && b.contains('hc-compact')
    && b.contains('hc-hide-suggestions') && b.contains('hc-diff-side'));
  assert.equal(b.contains('hc-outlines'), false);
  const [w0, w2, w3, w5] = blocksOf(body);
  assert.ok(w2.classList.contains('hc-selected') && !w0.classList.contains('hc-selected'));
  assert.equal(w2.scrolled, 1, 'the selected block is scrolled into view');
  assert.ok(w3.classList.contains('hc-prop-add') && w5.classList.contains('hc-prop-del'));
  HC.send({ on: true, selected: 0, overlay: [] });
  assert.ok(w0.classList.contains('hc-selected') && !w2.classList.contains('hc-selected'));
  assert.ok(!w3.classList.contains('hc-prop-add'), 'marks the new message does not name are cleared');
  // css/editor.css is loaded once, and it hides the frame's own chrome under hc-framed
  const links = kids(doc.head).filter((c) => c.tagName === 'LINK');
  assert.equal(links.length, 1);
  assert.equal(links[0].href, 'css/editor.css');
  const css = fs.readFileSync(path.join(ROOT, 'css', 'editor.css'), 'utf8');
  for (const sel of ['body.hc-framed .site-header', 'body.hc-framed .sidebar', 'body.hc-framed .site-footer']) {
    assert.ok(css.includes(sel), `${sel} is hidden`);
  }
  assert.match(css, /body\.hc-framed \.skip-link \{ display: none !important; \}/);
});

test('editor-frame (round 2, R1): the proposer\'s colour slot reaches the page as body[data-hc-tint]', () => {
  const { doc } = setupPage();
  const HC = fakeHC();
  EF.create(fakeWin(), doc, HC);
  HC.send({ on: true, tint: 3 });
  assert.equal(doc.body.getAttribute('data-hc-tint'), '3');
  HC.send({ on: true, tint: 0 });
  assert.equal(doc.body.getAttribute('data-hc-tint'), '0');
  HC.send({ on: false });
  assert.equal(doc.body.getAttribute('data-hc-tint'), null, 'off: no tint');
});

test('editor-frame (U5b): the marked blocks\' rectangles go to the parent (numbers only); hot lights one block', () => {
  const { doc, body } = setupPage();
  const HC = fakeHC();
  const win = fakeWin();
  win.innerHeight = 800;
  EF.create(win, doc, HC);
  HC.send({ on: true });
  assert.equal(HC.posts.filter((p) => p.type === 'hc-block-rects').length, 0, 'no marks: nothing to report');
  const [, , w3, w5] = blocksOf(body);
  w3.getBoundingClientRect = () => ({ top: 120.4, height: 60, bottom: 180.4 });
  w5.getBoundingClientRect = () => ({ top: 400, height: 90, bottom: 490 });
  HC.send({ on: true, overlay: [{ index: 3, mark: 'change' }, { index: 5, mark: 'del' }], hot: 5 });
  const rects = HC.posts.filter((p) => p.type === 'hc-block-rects');
  assert.deepEqual(rects[rects.length - 1], { type: 'hc-block-rects', rects: [{ index: 3, top: 120.4, height: 60 }, { index: 5, top: 400, height: 90 }], view: 800 });
  assert.ok(w5.classList.contains('hc-hot') && !w3.classList.contains('hc-hot'));
  // a scroll reports again; the same rectangles twice are not sent twice
  const before = HC.posts.length;
  w3.getBoundingClientRect = () => ({ top: 20, height: 60, bottom: 80 });
  for (const fn of win.listeners.scroll || []) fn({});
  assert.deepEqual(HC.posts.slice(before).map((p) => p.type), ['hc-block-rects']);
  for (const fn of win.listeners.scroll || []) fn({});
  assert.equal(HC.posts.length, before + 1, 'unchanged: not sent again');
  win.innerHeight = 600;                                   // a height-only resize is reported (codex U5b r3)
  for (const fn of win.listeners.resize || []) fn({});
  assert.equal(HC.posts[HC.posts.length - 1].view, 600);
  // the marks go: one empty report clears the rail, then silence
  HC.send({ on: true, overlay: [] });
  const last = HC.posts.filter((p) => p.type === 'hc-block-rects').pop();
  assert.deepEqual(last.rects, []);
  assert.ok(!w5.classList.contains('hc-hot'));
});

test('editor-frame: Enter on a focused block and a click select it (no pencil); a link does not; "+" offers the snippet kinds', () => {
  const { doc, body } = setupPage();
  const HC = fakeHC();
  EF.create(fakeWin(), doc, HC);
  HC.send({ on: true });
  const [, w2, w3] = blocksOf(body);
  assert.equal(blocksOf(body).some((w) => kids(w).some((c) => c.classList.contains('hc-pencil'))), false, 'no pencil button (Kyle, 2026-10-14)');
  assert.equal(w3.getAttribute('tabindex'), '0', 'a block is reachable by keyboard instead');
  w3.dispatch('keydown', w3, { key: 'Tab' });                 // not a pick
  w3.dispatch('keydown', w3, { key: 'Enter' });
  kids(w2)[1].click();                                     // a paragraph
  kids(kids(w2)[1]).find((c) => c.tagName === 'A').click(); // a link inside it: navigation, not a pick
  assert.deepEqual(HC.posts.slice(1), [{ type: 'hc-block-select', index: 3 }, { type: 'hc-block-select', index: 2 }]);
  const rails = kids(body).filter((c) => c.classList.contains('hc-plus'));
  assert.deepEqual(rails.map((r) => r.getAttribute('data-insert')), ['0', '2', '3', '5', '6']);
  kids(rails[2])[0].click();                               // open the picker before block 3
  const picker = kids(rails[2]).find((c) => c.classList.contains('hc-picker'));
  assert.ok(picker && rails[2].classList.contains('is-open'));
  // U4 (D9, D10): five tiles in a row, ONE Note tile (Warning / Attention are picked inside the box)
  const tiles = kids(kids(picker).find((c) => c.classList.contains('hc-pick-row')));
  const kinds = tiles.map((b) => b.getAttribute('data-kind'));
  assert.deepEqual(kinds, ['image', 'note', 'tabs', 'video', 'repo'], 'the five tiles');
  assert.ok(kinds.every((k) => Object.prototype.hasOwnProperty.call(C.SNIPPET_CATALOG, k)), 'each one a snippet kind');
  tiles.find((b) => b.getAttribute('data-kind') === 'note').click();
  assert.deepEqual(HC.posts.at(-1), { type: 'hc-block-insert', index: 3, kind: 'note' });
  assert.equal(kids(rails[2]).some((c) => c.classList.contains('hc-picker')), false, 'the picker closes');
  assert.ok(HC.posts.every((p) => Object.values(p).every((v) => typeof v !== 'string' || !/</.test(v))), 'no HTML in any message');
});

/* The walk's hook (TEST-ONLY): the localhost walk page cannot click inside
   the sandboxed frame, so on localhost / 127.0.0.1, when the frame sits
   under a top window that is not its parent (the walk page above the site),
   a message {type: 'hc-walk-picker', index} from that top window clicks the
   "+" rail before block `index` (the real click path) and answers the top
   window. Anywhere else no listener is added. */
function walkWin(hostname, framed) {
  const win = fakeWin();
  win.location.hostname = hostname;
  win.parent = { name: 'the site' };
  const answers = [];
  win.top = framed ? { name: 'the walk', postMessage: (m, o) => answers.push([m, o]) } : win.parent;
  return { win, answers };
}

test('editor-frame: on localhost under the walk, the top window\'s hc-walk-picker opens the real picker', () => {
  const { doc, body } = setupPage();
  const { win, answers } = walkWin('127.0.0.1', true);
  const HC = fakeHC();
  EF.create(win, doc, HC);
  HC.send({ on: true });
  assert.equal((win.listeners.message || []).length, 1, 'one listener, for the walk');
  const say = (source, data) => win.listeners.message.forEach((fn) => fn({ source, origin: 'http://127.0.0.1:8130', data }));
  say(win.parent, { type: 'hc-walk-picker', index: 3 });          // the parent is the Editor, not the walk
  say(win.top, { type: 'hc-other', index: 3 });
  say(win.top, { type: 'hc-walk-picker', index: '3' });
  const rails = kids(body).filter((c) => c.classList.contains('hc-plus'));
  assert.equal(rails.some((r) => r.classList.contains('is-open')), false, 'nothing else opens it');
  assert.deepEqual(answers, []);
  say(win.top, { type: 'hc-walk-picker', index: 3 });
  const rail = rails.find((r) => r.getAttribute('data-insert') === '3');
  const picker = kids(rail).find((c) => c.classList.contains('hc-picker'));
  assert.ok(picker && rail.classList.contains('is-open'), 'the rail before block 3 is open');
  assert.equal(rail.scrolled, 1, 'and scrolled into view');
  const kinds = EF.INSERT_KINDS.map((k) => k.kind);
  assert.deepEqual(answers, [[{ type: 'hc-walk-picker-open', index: 3, open: true, kinds }, 'http://127.0.0.1:8130']]);
  say(win.top, { type: 'hc-walk-picker', index: 3 });             // asked again: stays open, says so again
  assert.ok(rail.classList.contains('is-open'));
  assert.equal(answers.length, 2);
  assert.equal(answers[1][0].open, true);
  say(win.top, { type: 'hc-walk-picker', index: 4 });             // no rail there (a blank-line block)
  assert.deepEqual(answers[2][0], { type: 'hc-walk-picker-open', index: 4, open: false, kinds: [] });
  assert.equal(HC.posts.filter((p) => p.type !== 'hc-ready').length, 0, 'the parent is told nothing');
});

/* The scroll half of the walk hook: a fake window with a scrollY, an
   interval recorder and a MutationObserver recorder, so the test drives
   time, scrolling and page changes by hand. */
function scrollRig(win) {
  const timers = [];
  const cleared = [];
  const observers = [];
  win.scrollY = 0;
  win.innerHeight = 900;
  win.setInterval = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  win.clearInterval = (id) => { cleared.push(id); };
  win.MutationObserver = class { constructor(cb) { this.cb = cb; observers.push(this); } observe(t, o) { this.target = t; this.opts = o; } };
  return { timers, cleared, observers };
}

test('editor-frame: under the walk, hc-walk-scroll answers this document\'s scroll samples and event log', () => {
  const { doc, content } = setupPage();
  doc.scrollingElement = { scrollHeight: 3000 };
  const { win, answers } = walkWin('127.0.0.1', true);
  const rig = scrollRig(win);
  win.scrollY = 7;                                                 // whatever it is at create is sample 0's value
  const HC = fakeHC();
  EF.create(win, doc, HC);
  assert.equal(rig.timers.length, 1, 'one sampling timer');
  assert.equal(rig.timers[0].ms, 16);
  assert.equal(rig.observers.length, 2, 'the marks observer plus the walk\'s own');
  assert.equal(rig.observers[1].target, content);
  assert.equal((win.listeners.message || []).length, 1, 'still one message listener');
  assert.equal((win.listeners.scroll || []).length, 2, 'the review rail\'s (U5b) and the walk\'s');
  win.scrollY = 0;
  rig.observers[1].cb([]);                                         // the page body changes
  rig.timers[0].fn();
  win.scrollY = 640;
  win.listeners.scroll.forEach((fn) => fn({}));                    // then the window scrolls
  rig.timers[0].fn();
  const say = (source, data) => win.listeners.message.forEach((fn) => fn({ source, origin: 'http://127.0.0.1:8130', data }));
  say(win.parent, { type: 'hc-walk-scroll' });                     // the parent is the Editor, not the walk
  say(win.top, { type: 'hc-walk-scrolls' });
  say(win.top, 'hc-walk-scroll');
  assert.deepEqual(answers, [], 'only the walk\'s own message is answered');
  say(win.top, { type: 'hc-walk-scroll' });
  assert.equal(answers.length, 1);
  const [m, origin] = answers[0];
  assert.equal(origin, 'http://127.0.0.1:8130');
  assert.equal(m.type, 'hc-walk-scroll-samples');
  assert.equal(m.nonce16, PREFIX, 'the answer names this load');
  assert.equal(typeof m.loadedAt, 'number');
  assert.equal(m.now, 640);
  assert.deepEqual(m.samples[0], [0, 7], 'sample 0 is taken at create');
  assert.deepEqual(m.samples.map((x) => x[1]), [7, 0, 640], 'later samples follow scrollY');
  assert.ok(m.samples.every(([t]) => typeof t === 'number' && t >= 0));
  assert.deepEqual(m.log, [
    { seq: 0, why: 'create', scrollY: 7, scrollHeight: 3000, innerHeight: 900 },
    { seq: 1, why: 'mutation', scrollY: 0, scrollHeight: 3000, innerHeight: 900 },
    { seq: 2, why: 'scroll', scrollY: 640, scrollHeight: 3000, innerHeight: 900 }], 'create → change → scroll, in order');
  m.samples.push('x');                                             // the answer is a copy
  say(win.top, { type: 'hc-walk-scroll' });
  assert.equal(answers[1][0].samples.length, 3);
  assert.equal(HC.posts.filter((p) => p.type !== 'hc-ready').length, 0, 'the parent is told nothing');
});

test('editor-frame: the walk\'s scroll samples and log stop growing at the cap', () => {
  const { doc } = setupPage();
  const { win, answers } = walkWin('localhost', true);
  const rig = scrollRig(win);
  EF.create(win, doc, fakeHC());
  for (let i = 0; i < 2500; i += 1) { win.scrollY = i; rig.timers[0].fn(); win.listeners.scroll.forEach((fn) => fn({})); }
  assert.deepEqual(rig.cleared, [1], 'the timer is stopped once, at the cap');
  win.listeners.message.forEach((fn) => fn({ source: win.top, origin: 'http://localhost:8130', data: { type: 'hc-walk-scroll' } }));
  const m = answers[0][0];
  assert.equal(m.samples.length, 2000);
  assert.equal(m.log.length, 2000);
  assert.equal(m.now, 2499, 'now still tells the truth past the cap');
});

test('editor-frame: the walk hook is absent off localhost and in the real Editor (top is the parent)', () => {
  for (const [host, framed] of [['hippocampus-docs.vercel.app', true], ['localhost', false], ['127.0.0.1', false]]) {
    const { doc } = setupPage();
    const { win } = walkWin(host, framed);
    const rig = scrollRig(win);
    EF.create(win, doc, fakeHC());
    assert.equal(win.listeners.message, undefined, `${host} framed=${framed}: no message listener`);
    assert.equal((win.listeners.scroll || []).length, 1, `${host} framed=${framed}: no walk scroll listener (only the review rail's, U5b)`);
    assert.equal(rig.timers.length, 0, `${host} framed=${framed}: no timer`);
    assert.equal(rig.observers.length, 1, `${host} framed=${framed}: only the marks observer`);
  }
});

// ------------------------------------------- typing in the page (editor redesign U2) --
test('editor-frame (U2): a selected block already on screen is never scrolled; one out of view still is', () => {
  const { doc, body } = setupPage();
  const HC = fakeHC();
  const win = Object.assign(fakeWin(), { innerHeight: 900 });
  EF.create(win, doc, HC);
  HC.send({ on: true, selected: null });
  const [, w2, w3] = blocksOf(body);
  w2.getBoundingClientRect = () => ({ top: 300, bottom: 360 });          // on screen: the reader clicked it there
  w3.getBoundingClientRect = () => ({ top: 2400, bottom: 2460 });        // far below
  HC.send({ on: true, selected: 2 });
  assert.equal(w2.scrolled, 0, 'no jump for a block in view');
  HC.send({ on: true, selected: 3 });
  assert.equal(w3.scrolled, 1, 'a block out of view is brought into view');
});

test('editor-frame (U2): the typing scripts load only when the parent opens a block, once, never while off', () => {
  const { doc } = setupPage();
  const HC = fakeHC();
  EF.create(fakeWin(), doc, HC);
  const scripts = () => kids(doc.head).filter((c) => c.tagName === 'SCRIPT').map((c) => c.src);
  HC.send({ on: false, open: { index: 2, md: 'Intro link\n\n', kind: 'paragraph' } });
  assert.deepEqual(scripts(), [], 'Editor off: nothing loads');
  HC.send({ on: true, selected: 2 });
  assert.deepEqual(scripts(), [], 'a selection alone loads nothing');
  HC.send({ on: true, selected: 2, open: { index: 2, md: 'Intro link\n\n', kind: 'paragraph' } });
  HC.send({ on: true, selected: 2, open: { index: 2, md: 'Intro link\n\n', kind: 'paragraph' } });
  assert.deepEqual(scripts(), ['js/editor-md.js', 'js/editor-type.js', 'js/editor-blocks.js'], 'the converter, the typing engine and the block editors, once');
});

test('editor-frame (U2): Escape while the typing scripts are still loading cancels the open and tells the parent', () => {
  const { doc } = setupPage();
  const HC = fakeHC();
  EF.create(fakeWin(), doc, HC);
  HC.send({ on: true, selected: 2, open: { index: 2, md: 'Intro link\n\n', kind: 'paragraph' } });
  for (const fn of doc.listeners.keydown || []) fn({ key: 'Escape' });
  assert.deepEqual(HC.posts.filter((p) => p.type === 'hc-block-state').map((p) => [p.index, p.editor]), [[2, 'closed']]);
});

/* Kyle's live feedback (2026-10-14), items 1, 2 and 4: ONE look for a block in Editor mode — a faint accent
   line in the left margin on hover and focus, the same line solid when open or selected; no pencil, no box,
   no ring, so nothing jumps between two styles. And themed scrollbars on the site and in the frame. */
test('the block look is one left line (no pencil, no box ring), and scrollbars follow the theme', () => {
  const css = fs.readFileSync(path.join(ROOT, 'css', 'editor.css'), 'utf8');
  const site = fs.readFileSync(path.join(ROOT, 'css', 'site.css'), 'utf8');
  assert.equal(/hc-pencil/.test(css), false, 'no pencil styles left');
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map((r) => r.split('{'));
  const blockRules = rules.filter(([sel]) => sel && /\.hc-block\b/.test(sel) && !/hc-prop-|hc-removed/.test(sel));
  for (const [sel, body] of blockRules) {
    assert.equal(/box-shadow|outline\s*:(?!\s*none)/.test(body || ''), false, `no ring on a block: ${sel.trim()}`);
  }
  const line = (re) => blockRules.find(([sel]) => re.test(sel) && /::after/.test(sel));
  assert.ok(line(/:hover/), 'hover draws the left line');
  assert.ok(line(/:focus-visible/), 'keyboard focus draws the same line');
  assert.ok(line(/hc-open|hc-selected/), 'open/selected draws the same line');
  for (const st of ['focus-visible', 'hc-selected', 'hc-open']) {
    assert.ok(blockRules.some(([sel]) => sel.includes('.hc-side > .hc-block') && sel.includes(st) && /::after/.test(sel)), `side by side too: ${st}`);
  }
  assert.match(css, /--hc-line-faint/, 'the faint line has one token');
  for (const [name, text] of [['site.css', site], ['editor.css', css]]) {
    assert.match(text, /scrollbar-color/, `${name}: themed scrollbars (Firefox, Chrome 121+)`);
    assert.match(text, /::-webkit-scrollbar-thumb/, `${name}: themed scrollbars (Safari)`);
  }
  assert.match(site, /color-scheme:\s*dark/, 'dark is declared, so form controls and scrollbars are dark');
  assert.match(site, /\[data-theme="light"\][^{]*\{[^}]*color-scheme:\s*light/, 'light is declared too');
});

/* V2 (Kyle, 2026-10-14): an image block is draggable to another place in the page, and Alt+arrow moves it
   by keyboard; the frame says only {index, to}. Other blocks are not draggable. */
test('an image block: draggable, dropped before or after a block, Alt+ArrowUp/Down; text blocks are not draggable', () => {
  const doc = makeDoc();
  const content = el(doc, 'main', { id: 'content', class: 'content' });
  doc.body.appendChild(content);
  const img = el(doc, 'img', { src: 'https://res.cloudinary.com/x/a.png', alt: 'a' });
  const body = el(doc, 'div', { class: 'page-body' },
    S(doc, 0), el(doc, 'h1', null, 'Title'),
    S(doc, 2), el(doc, 'p', null, img),
    S(doc, 4), el(doc, 'p', null, 'After the image.'),
    S(doc, 6), el(doc, 'p', null, 'Last.'));
  content.appendChild(body);
  const HC = fakeHC();
  EF.create(fakeWin(), doc, HC);
  HC.send({ on: true });
  const [w0, w2, w4, w6] = blocksOf(body);
  assert.equal(w2.getAttribute('draggable'), 'true');
  assert.ok(!w4.getAttribute('draggable'), 'a text block is not draggable');
  const moves = () => HC.posts.filter((p) => p.type === 'hc-block-move');
  w2.dispatch('keydown', w2, { key: 'ArrowDown', altKey: true });
  w2.dispatch('keydown', w2, { key: 'ArrowUp', altKey: true });
  w2.dispatch('keydown', w2, { key: 'ArrowDown' });                       // no Alt: nothing
  w4.dispatch('keydown', w4, { key: 'ArrowDown', altKey: true });        // not an image: nothing
  assert.deepEqual(moves(), [{ type: 'hc-block-move', index: 2, to: 6 }, { type: 'hc-block-move', index: 2, to: 0 }]);
  // drag the image onto the last block (no layout under node: "before" it)
  w2.dispatch('dragstart', w2, { dataTransfer: { setData() {} } });
  body.dispatch('dragover', w6, { clientY: 1 });
  body.dispatch('drop', w6, { clientY: 1 });
  assert.deepEqual(moves().at(-1), { type: 'hc-block-move', index: 2, to: 6 });
  // a drop on its own place says nothing; a drop with no drag says nothing
  w2.dispatch('dragstart', w2, { dataTransfer: { setData() {} } });
  body.dispatch('drop', w2, {});
  body.dispatch('drop', w0, {});
  assert.equal(moves().length, 3);
  assert.ok(HC.posts.every((p) => Object.values(p).every((v) => typeof v !== 'string' || !/</.test(v))), 'no HTML in any message');
});

// ---- round 2, R5: the Team page's move rules (the card menu, Alt+arrows and drag share them) ----
test('peopleMove: up/down, to the other list (pin or unpin as needed), pin, drop; an active person sent to the alumni is pinned there', () => {
  const P = (name, linked, active, pinned) => ({ name, linked, active, pinned });
  const lists = () => ({ team: [P('Ann', true, true, false), P('Ben', true, false, true), P('Uli', false, false, false)],
    alumni: [P('Cid', true, false, false), P('Dot', false, false, false)] });
  const names = (o) => ({ team: o.team.map((x) => `${x.name}${x.pinned ? '*' : ''}`), alumni: o.alumni.map((x) => `${x.name}${x.pinned ? '*' : ''}`) });
  assert.deepEqual(names(EP.peopleMove(lists(), { op: 'down', name: 'Ann' })), { team: ['Ben*', 'Ann', 'Uli'], alumni: ['Cid', 'Dot'] });
  assert.deepEqual(names(EP.peopleMove(lists(), { op: 'up', name: 'Dot' })), { team: ['Ann', 'Ben*', 'Uli'], alumni: ['Dot', 'Cid'] });
  assert.equal(EP.peopleMove(lists(), { op: 'up', name: 'Ann' }), null, 'already first: nothing to do');
  // to the team: a linked, quiet person is pinned (or GitHub would send them back); an unlinked one just moves
  assert.deepEqual(names(EP.peopleMove(lists(), { op: 'other', name: 'Cid' })).team, ['Ann', 'Ben*', 'Uli', 'Cid*']);
  assert.deepEqual(names(EP.peopleMove(lists(), { op: 'other', name: 'Dot' })).team, ['Ann', 'Ben*', 'Uli', 'Dot']);
  // to the alumni: a quiet person's team pin comes off (the rule keeps them there); an ACTIVE person is pinned to
  // the alumni (Kyle 2026-10-16), first there, never refused
  assert.deepEqual(names(EP.peopleMove(lists(), { op: 'other', name: 'Ben' })).alumni, ['Ben', 'Cid', 'Dot']);
  const away = EP.peopleMove(lists(), { op: 'other', name: 'Ann' });
  assert.equal(away.refused, undefined, 'never refused');
  assert.deepEqual(names(away), { team: ['Ben*', 'Uli'], alumni: ['Ann*', 'Cid', 'Dot'] });
  // back to the team: the alumni pin comes off (active, the rule keeps them there)
  assert.deepEqual(names(EP.peopleMove(away, { op: 'other', name: 'Ann' })).team, ['Ben*', 'Uli', 'Ann']);
  // Unpin in the alumni releases them (the 30-day rule then shows them on the team); Pin again pins
  assert.deepEqual(names(EP.peopleMove(away, { op: 'pin', name: 'Ann' })).alumni, ['Ann', 'Cid', 'Dot']);
  // a person pinned to the alumni but quiet, moved to the team: pinned to the team
  const quietAway = { team: [], alumni: [P('Eve', true, false, true)] };
  assert.deepEqual(names(EP.peopleMove(quietAway, { op: 'other', name: 'Eve' })), { team: ['Eve*'], alumni: [] });
  // pin / unpin (linked only)
  assert.deepEqual(names(EP.peopleMove(lists(), { op: 'pin', name: 'Cid' })).alumni, ['Cid*', 'Dot']);
  assert.deepEqual(names(EP.peopleMove(lists(), { op: 'pin', name: 'Ben' })).team, ['Ann', 'Ben', 'Uli']);
  assert.equal(EP.peopleMove(lists(), { op: 'pin', name: 'Uli' }), null, 'no pin without a GitHub link');
  // a drop: into a list at an index, the same rules
  assert.deepEqual(names(EP.peopleMove(lists(), { op: 'drop', name: 'Uli', list: 'team', index: 0 })).team, ['Uli', 'Ann', 'Ben*']);
  assert.deepEqual(names(EP.peopleMove(lists(), { op: 'drop', name: 'Cid', list: 'team', index: 1 })).team, ['Ann', 'Cid*', 'Ben*', 'Uli']);
  assert.deepEqual(names(EP.peopleMove(lists(), { op: 'drop', name: 'Ann', list: 'alumni', index: 1 })).alumni, ['Cid', 'Ann*', 'Dot']);
  assert.equal(EP.peopleMove(lists(), { op: 'up', name: 'Nobody' }), null);
});

test('editor-frame (the edit gate): a locked project page picks nothing; body.hc-edit-locked hides the "+" rails', () => {
  const { doc, body } = setupPage();
  const HC = fakeHC();
  EF.create(fakeWin(), doc, HC);
  HC.send({ on: true, locked: true });
  assert.ok(doc.body.classList.contains('hc-edit-locked'));
  const [, w2, w3] = blocksOf(body);
  w3.dispatch('keydown', w3, { key: 'Enter' });
  kids(w2)[1].click();
  assert.equal(HC.posts.filter((p) => p.type === 'hc-block-select').length, 0, 'no pick is sent');
  const css = fs.readFileSync(path.join(ROOT, 'css', 'editor.css'), 'utf8');
  assert.match(css, /body\.hc-edit-on\.hc-edit-locked \.hc-plus \{ display: none; \}/);
  HC.send({ on: true, locked: false });
  assert.equal(doc.body.classList.contains('hc-edit-locked'), false);
  kids(w2)[1].click();
  assert.deepEqual(HC.posts.filter((p) => p.type === 'hc-block-select'), [{ type: 'hc-block-select', index: 2 }], 'unlocked: picks again');
});

/* ---- fix pass ---- */
/* A2 (Nielsen #5, ED30): the marks kept before a reload come back in the walk's real order of events. Fakes stand
   in for the typing scripts (already on the window, so loadScripts resolves at once). The causes found in headless
   Chrome: (1) the parent re-opens the selected block in the same hc-editor that carries the marks, and the open ran
   first (a clean render; the restore then skipped the open block); (2) the first hc-editor can come before the page
   body is drawn: the restore found no wrapper and still counted the marks as used, so it never tried again. */
function typingFakes(win, doc) {
  if (!Object.getOwnPropertyDescriptor(El.prototype, 'children')) {
    Object.defineProperty(El.prototype, 'children', { get() { return this.childNodes.filter((c) => c.nodeType === 1); } });
    Object.defineProperty(El.prototype, 'firstChild', { get() { return this.childNodes[0] || null; } });
  }
  win.HCEditorMd = {
    editorFor: () => 'visual',
    renderBlock: (md) => el(doc, 'div', null, el(doc, 'p', null, md.trim())),
    restoreBlock: (o) => ({ how: 'marks', root: el(doc, 'div', null, el(doc, 'p', null, 'Intro link', el(doc, 'ins', { 'data-hc-sug': 'ins' }, ' typed'))) }),
  };
  win.HCEditorType = { attach: () => ({ detach() {} }), list() {}, listState: () => 'none' };
  win.HCEditorBlocks = { blockBar: () => ({ el: el(doc, 'div', { class: 'hc-blockbar' }), close() {} }) };
  win.HCSanitize = { clean: (h) => h };
}
const MARKS = [{ index: 2, md: 'Intro typed\n\n', orig: 'Intro link\n\n', html: '<p>Intro link<ins data-hc-sug="ins"> typed</ins></p>', kind: 'paragraph' }];
const tick = () => new Promise((r) => setImmediate(r));
const editRoot = (w) => kids(w).find((c) => c.classList.contains('hc-edit-root')) || null;

test('fix A2: marks sent with the re-opened block are restored INTO the open block (the restore runs first)', async () => {
  const { doc, body } = setupPage();
  const HC = fakeHC();
  const win = fakeWin();
  typingFakes(win, doc);
  EF.create(win, doc, HC);
  HC.send({ on: true, selected: 2, open: { index: 2, md: 'Intro typed\n\n', kind: 'paragraph' }, marks: MARKS });
  for (let i = 0; i < 4; i += 1) await tick();
  const w2 = blocksOf(body)[1];
  const root = editRoot(w2);
  assert.ok(root, 'the block has an edit root');
  assert.equal(root.getAttribute('data-hc-restored'), 'marks', 'the restored marks, not a clean render');
  assert.ok(w2.classList.contains('hc-open'), 'and the block is open on them: ' + JSON.stringify(HC.posts.filter((p) => p.type === 'hc-block-state')));
});

test('fix A2: marks that come before the page body is drawn are restored once the body appears', async () => {
  const { doc, content, body } = setupPage();
  content.removeChild(body);                       // js/app.js has not drawn the page yet
  const HC = fakeHC();
  const win = fakeWin();
  typingFakes(win, doc);
  EF.create(win, doc, HC);
  const msg = { on: true, selected: null, marks: MARKS };
  HC.send(msg);
  for (let i = 0; i < 3; i += 1) await tick();
  content.appendChild(body);                      // the page body appears (the MutationObserver re-applies)
  HC.send(msg);
  for (let i = 0; i < 3; i += 1) await tick();
  const root = editRoot(blocksOf(body)[1]);
  assert.ok(root && root.getAttribute('data-hc-restored') === 'marks', 'restored on the apply that found the block');
});

/* A1 (Nielsen #4): framed, the frame is only #content's slot (~700 px in a 1280-px window): the phone toolbar is
   decided by the WINDOW's width the parent posts (hc-editor.width), never by the frame's own media query. */
test('fix A1: phone mode comes from the window width the parent posts, not from the frame\'s own width', () => {
  const frameIsNarrow = { matchMedia: () => ({ matches: true }) };      // a 700-px frame: (max-width: 767px) matches
  assert.equal(EF.phoneWindow(frameIsNarrow, 1280), false, 'a 1280-px window is no phone, however narrow the frame');
  assert.equal(EF.phoneWindow(frameIsNarrow, 900), false);
  assert.equal(EF.phoneWindow({ matchMedia: () => ({ matches: false }) }, 390), true, 'a 390-px window is a phone');
  assert.equal(EF.phoneWindow({ matchMedia: () => ({ matches: false }) }, 767), true, 'the site\'s phone line (767)');
  assert.equal(EF.phoneWindow(frameIsNarrow, null), true, 'no width from the parent: the frame\'s own query answers');
  assert.equal(EF.phoneWindow({}, undefined), false);
  const src = fs.readFileSync(path.join(ROOT, 'js', 'editor-frame.js'), 'utf8');
  assert.match(src, /phoneWindow\(win, state && state\.width\)/, 'the toolbar placement asks phoneWindow with the posted width');
  assert.equal((src.match(/matchMedia\(/g) || []).length, 1, 'phoneWindow is the frame\'s one matchMedia');
  for (const f of ['editor-blocks.js', 'editor-people.js', 'editor-type.js']) {
    const t = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
    assert.equal(/matchMedia|innerWidth|\b76[78]\b/.test(t), false, `${f} makes no width decision of its own`);
  }
});

test('fix A1: css: the frame\'s typing, boxes, people and project sections carry no phone media query', () => {
  const css = fs.readFileSync(path.join(ROOT, 'css', 'editor.css'), 'utf8');
  const section = (name) => { const a = css.indexOf(`/* ==== ${name} ==== */`); const b = css.indexOf('/* ==== ', a + 10); return css.slice(a, b); };
  for (const name of ['typing (U4)', 'boxes/picker (U4)', 'people (U5)', 'project (U6)']) {
    const body = section(name);
    assert.ok(body.length > 100, `section ${name} found`);
    // the phone line (640/767/768 px) is the WINDOW's; a room check on the frame's own width (the note card's 1180) may stay
    assert.equal(/@media[^{]*(max|min)-width:\s*(6[0-9]{2}|7[0-9]{2})px/.test(body), false, `${name}: no phone media query (the frame is not the window)`);
  }
  const box = section('boxes/picker (U4)');
  assert.match(box, /\.hc-blockbar\.is-phone\s*\{[^}]*position:\s*fixed/, 'the phone toolbar is fixed, keyed on .is-phone');
  assert.match(box, /\.hc-blockbar\.is-phone \.hc-fb\s*\{[^}]*min-height:\s*44px/, 'its 44-px buttons, keyed on .is-phone');
  assert.match(box, /\.hc-block\.hc-open:has\(> \.hc-blockbar\.is-phone\)\s*\{\s*padding-top:\s*0/, 'no empty band above the text on a phone');
  assert.match(box, /\.hc-fb\.hc-box-type, \.hc-fb\.hc-code-lang \{[^}]*width: auto/, 'Type ▾ / Language ▾ are not squeezed into a 32-px square');
});

test('integration F5: css: no phone media query (6xx/7xx px) styles the frame\'s page; its phone padding keys on html[data-hc-win="narrow"]', () => {
  // the rail/margin (U3) section mixes parent rules (the rail, a real window query) with frame rules, so it is not
  // in the section list above; this checks every phone-width @media block in the file for the frame's selectors
  const css = fs.readFileSync(path.join(ROOT, 'css', 'editor.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /@media[^{]*(?:max|min)-width:\s*(?:6[0-9]{2}|7[0-9]{2})px[^{]*\{/g;
  let m;
  while ((m = re.exec(css))) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < css.length && depth; i += 1) { if (css[i] === '{') depth += 1; else if (css[i] === '}') depth -= 1; }
    const body = css.slice(m.index, i);
    assert.equal(/body\.hc-framed|\.hc-block\.hc-prop-/.test(body), false, `a frame rule under ${m[0].trim()}: ${body.slice(0, 120)}`);
  }
  const N = 'html[data-hc-win="narrow"]';
  assert.ok(css.includes(`${N} body.hc-framed .content { padding: 1rem .9rem 2.5rem; }`), 'the frame\'s phone padding');
  assert.ok(css.includes(`${N} .hc-block.hc-prop-add, ${N} .hc-block.hc-prop-change, ${N} .hc-block.hc-prop-del {`), 'the marked blocks\' phone inset');
});

/* A7 (WCAG 4.1.2, 2.4.6) and A8 (U2b/U3, ED35) */
test('fix A7: each "+" says where it adds; the picker is a plain group, takes the focus, Escape closes it to its "+"', () => {
  const { doc, body } = setupPage();
  const HC = fakeHC();
  EF.create(fakeWin(), doc, HC);
  HC.send({ on: true });
  const rails = kids(body).filter((c) => c.classList.contains('hc-plus'));
  const names = rails.map((r) => kids(r)[0].getAttribute('aria-label'));
  assert.equal(names[0], 'Add a block before the first block');
  assert.equal(names[1], 'Add a block after “Title”');
  assert.equal(names[2], 'Add a block after “Intro link dangling”');
  assert.ok(names.every((n) => n !== 'Add a block here'), 'no "+" is named the same as every other');
  const focused = [];
  const had = Object.getOwnPropertyDescriptor(El.prototype, 'focus');
  El.prototype.focus = function focus() { focused.push(this); };
  try {
    const plus = kids(rails[1])[0];
    plus.click();
    const picker = kids(rails[1]).find((c) => c.classList.contains('hc-picker'));
    assert.equal(picker.getAttribute('role'), 'group');
    const tiles = kids(kids(picker).find((c) => c.classList.contains('hc-pick-row')));
    assert.ok(tiles.every((t) => t.tagName === 'BUTTON' && t.getAttribute('role') === null), 'plain buttons, no menuitem');
    assert.equal(focused.at(-1), tiles[0], 'the focus moves into it');
    let stopped = false;
    for (const fn of picker.listeners.keydown || []) fn({ key: 'Escape', preventDefault() {}, stopPropagation() { stopped = true; } });
    assert.equal(kids(rails[1]).some((c) => c.classList.contains('hc-picker')), false, 'Escape closes it');
    assert.equal(focused.at(-1), plus, 'back to its "+"');
    assert.equal(stopped, true);
    assert.equal(HC.posts.some((p) => p.type === 'hc-key'), false, 'an Escape the picker used is not passed on');
  } finally {
    if (had) Object.defineProperty(El.prototype, 'focus', had); else delete El.prototype.focus;
  }
});

test('fix A8: an Escape the frame used for nothing goes to the parent as hc-key escape; one it used does not', () => {
  const { doc, body } = setupPage();
  const HC = fakeHC();
  EF.create(fakeWin(), doc, HC);
  const esc = (extra) => { for (const fn of doc.listeners.keydown || []) fn(Object.assign({ key: 'Escape', defaultPrevented: false }, extra)); };
  HC.send({ on: false });
  esc();
  assert.equal(HC.posts.filter((p) => p.type === 'hc-key').length, 0, 'Editor off: nothing');
  HC.send({ on: true });
  esc();
  assert.deepEqual(HC.posts.filter((p) => p.type === 'hc-key'), [{ type: 'hc-key', op: 'escape' }]);
  esc({ defaultPrevented: true });
  assert.equal(HC.posts.filter((p) => p.type === 'hc-key').length, 1, 'handled elsewhere (a drag, a field): not passed on');
  kids(kids(body).find((c) => c.classList.contains('hc-plus')))[0].click();     // a "+" picker open
  esc();
  assert.equal(HC.posts.filter((p) => p.type === 'hc-key').length, 1, 'it closes the picker instead');
  esc();
  assert.equal(HC.posts.filter((p) => p.type === 'hc-key').length, 2, 'then the next one goes up');
  HC.send({ on: true, selected: 2, open: { index: 2, md: 'Intro link\n\n', kind: 'paragraph' } });   // scripts loading
  esc();
  assert.equal(HC.posts.filter((p) => p.type === 'hc-key').length, 2, 'it cancels the open instead');
});

test('fix A8: hc-scroll {y} at most once per 150 ms (the last position always goes), only while Editor mode is on', () => {
  const { doc } = setupPage();
  const HC = fakeHC();
  const timers = [];
  const win = Object.assign(fakeWin(), { scrollY: 0, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; } });
  EF.create(win, doc, HC);
  const scroll = (y) => { win.scrollY = y; for (const fn of win.listeners.scroll || []) fn({}); };
  scroll(40);
  assert.equal(HC.posts.filter((p) => p.type === 'hc-scroll').length, 0, 'Editor off: nothing');
  HC.send({ on: true });
  scroll(100.4);
  scroll(180);
  scroll(260);
  const ys = () => HC.posts.filter((p) => p.type === 'hc-scroll').map((p) => p.y);
  assert.deepEqual(ys(), [100], 'the first at once, the rest held');
  const t = timers.filter((x) => x.ms === 150);
  assert.equal(t.length, 1, 'one 150-ms window');
  t[0].fn();
  assert.deepEqual(ys(), [100, 260], 'the last position when the window ends');
  win.scrollY = -5;
  timers.filter((x) => x.ms === 150).at(-1).fn();
  assert.deepEqual(ys(), [100, 260], 'no scroll in the window: nothing more');
  scroll(-5);
  assert.deepEqual(ys(), [100, 260, 0], 'never below 0');
});
