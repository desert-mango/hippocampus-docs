// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 26 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test the Editor mode's dock (js/editor-dock.js, window.HCDock): its interface and how it is loaded.
/* The dock's own tests (editor UI/UX build: U0 moved the dock out of js/editor.js; U2 adds its tests here).

     node --test tools/tests/test_editor_dock.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { openSite, settle, findAll, EDITOR_SCRIPTS, FakeElement, memoryStorage, localFor } from './editor_harness.mjs';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const readRepo = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const PAGE_ROUTE = '/setup/hippocampus-bringup/fcu-firmware';
const require = createRequire(import.meta.url);
const C = require(path.join(ROOT, 'js', 'cms-core.js'));
const { MAIN_SHA } = require(path.join(ROOT, 'tools', 'tests', 'fake_github.js'));

test('U0: js/app.js injects js/editor-dock.js right before js/editor.js; index.html never loads it', () => {
  assert.deepEqual(EDITOR_SCRIPTS, ['js/marked.min.js', 'js/cms-core.js', 'js/editor-dock.js', 'js/editor.js']);
  assert.ok(!/editor-dock/.test(readRepo('index.html')), 'the public page and the sandboxed frame never load the dock');
});

test('U0: window.HCDock is a frozen object with the dock interface, and the file reads no data file', () => {
  const win = {};
  win.window = win;
  vm.runInNewContext(readRepo('js/editor-dock.js'), win, { filename: 'editor-dock.js' });
  const D = win.HCDock;
  assert.ok(D && Object.isFrozen(D));
  for (const k of ['mount', 'refresh', 'fold', 'unfold', 'panel', 'setCount', 'loadCount', 'lockParts']) {
    assert.equal(typeof D[k], 'function', k);
  }
  assert.ok(!/data\/[a-z_-]+\.json|fetch\s*\(/.test(readRepo('js/editor-dock.js')), 'no registry read, no network');
});

test('U0: the editor mounts the dock through HCDock: bubble, tag, fold / unfold, and a panel slot under the pill', async () => {
  const page = openSite({ hash: `#${PAGE_ROUTE}` });
  await settle();
  const D = page.win.HCDock;
  const dock = page.one((e) => e.classList.contains('hc-dock'));
  assert.ok(dock, 'the bubble');
  assert.ok(page.one((e) => e.classList.contains('hc-dock-tag')), 'the tag');
  assert.ok(findAll(dock, (e) => e.attrs['data-action'] === 'dock-send').length === 1, 'Send for review');
  D.fold();
  assert.equal(page.body.classList.contains('hc-dock-collapsed'), true);
  assert.equal(page.local.getItem('hc-editor-dock'), 'collapsed');
  D.unfold();
  assert.equal(page.body.classList.contains('hc-dock-collapsed'), false);
  assert.equal(page.local.getItem('hc-editor-dock'), 'open');
  const seen = [];
  D.panel('probe', (v) => { seen.push(v); return page.win.document.createElement('p'); });
  page.switchBtn().click();
  await settle();
  const slot = findAll(dock, (e) => e.attrs['data-dock-panel'] === 'probe')[0];
  assert.ok(slot && slot.classList.contains('hc-dock-panel'), 'the panel slot in the bubble');
  assert.equal(slot.childNodes.length, 1);
  const v = seen.at(-1);
  assert.equal(v.signedIn, true);
  assert.equal(v.login, 'bob');
  assert.equal(typeof v.editing, 'boolean');
  assert.equal(v.changes, 0);
  D.panel('probe', null);
  assert.equal(findAll(dock, (e) => e.attrs['data-dock-panel'] === 'probe').length, 0, 'removed');
});

// ================================================================ U2 (plan D1, D4, D5, D13, D14) ===

const PAGE_ID = 'setup/hippocampus-bringup/fcu-firmware';
const PAGE_FILE = 'content/setup/hippocampus-bringup/fcu-firmware.md';
const PAGE_TEXT = readRepo(PAGE_FILE);
const UBUNTU_ID = 'setup/raspberry-pi/ubuntu-24-04-server';
const UBUNTU_FILE = 'content/setup/raspberry-pi/ubuntu-24-04-server.md';
const GATE_ROUTE = '/projects/core-stack';
const ACCESS_FILE = 'data/graph/edit-access.json';
const FACTS_FILE = 'data/projects/core-stack.json';
const REPO_API = 'https://api.github.com/repos/desert-mango/hippocampus-docs';
const TREE_M = '7'.repeat(40);
const PR1 = JSON.parse(readRepo('tools/tests/fixtures/github-data/pull-1.json'));
const firstParagraph = (t) => C.splitBlocks(t).blocks.findIndex((b) => b.kind === 'paragraph');
const draftsOf = (page) => C.createDraftStore(page.local, C.draftsKey(page.login));
const tucked = (page) => page.body.classList.contains('hc-dock-collapsed');
const row = (page, name) => page.one((e) => e.attrs['data-dock-row'] === name);
const chipOf = (page) => page.one((e) => e.classList.contains('hc-chip'));
const dockOf = (page) => page.one((e) => e.classList.contains('hc-dock'));
const accessText = (editors, why) => {
  const row = (login, k) => (why === 'added' ? { login, why, repos_with_commits: 0 } : { login, why: 'commits', repos_with_commits: k });
  return `${JSON.stringify({ note: 'test', projects: {
    'learning-to-swim': { repos: 2, editors: editors.map((login) => row(login, 1)), removed: [] },
    'core-stack': { repos: 15, editors: editors.map((login) => row(login, 2)), removed: [] } } }, null, 1)}\n`;
};
const draft = (key, label, file, text, original) => ({ key, label, files: { [file]: text },
  originals: { [file]: original }, base: { ref: 'main', sha: MAIN_SHA, number: null } });

async function editorOn(opts) {
  const page = openSite(Object.assign({ hash: `#${PAGE_ROUTE}` }, opts));
  await settle();
  page.switchBtn().click();
  await settle();
  await page.send({ type: 'hc-ready' });
  return page;
}
/* Type in the page's first paragraph (the frame: select, then type). */
async function typePage(page, md) {
  const i = firstParagraph(PAGE_TEXT);
  await page.pick(i);
  await page.typeIn(i, md || 'A changed paragraph.\n\n');
}
/* The undo clock waits while the tab is hidden; a test that hides it shows it again when it ends (pass or fail). */
function hide(t, page) {
  page.win.document.visibilityState = 'hidden';
  t.after(() => { page.win.document.visibilityState = 'visible'; });
}
/* GitHub's answers to a send and its undo; each new send gets its own number (from 42). */
function sendWrites() {
  const writes = [];
  let k = 0;
  let pr = 41;
  const next = () => (k += 1).toString(16).padStart(40, 'a');
  const onWrite = (method, url, body) => {
    writes.push({ method, url, body });
    const rest = url.slice(REPO_API.length);
    if (method === 'POST' && ['/git/blobs', '/git/trees', '/git/commits'].indexOf(rest) >= 0) return { status: 201, body: { sha: next() } };
    if (method === 'POST' && rest === '/git/refs') return { status: 201, body: { ref: body.ref, object: { sha: body.sha } } };
    if (method === 'PATCH' && rest.startsWith('/git/refs/heads/cms/')) return { status: 200, body: { object: { sha: body.sha } } };
    if (method === 'POST' && rest === '/pulls') { pr += 1; return { status: 201, body: { number: pr } }; }
    if (method === 'PATCH' && /^\/pulls\/[0-9]+$/.test(rest)) return { status: 200, body: { number: Number(rest.slice(7)), state: body.state || 'open' } };
    if (method === 'DELETE' && rest.startsWith('/git/refs/heads/cms/')) return { status: 204, body: null };
    return { status: 500, body: { message: `unexpected ${method} ${rest}` } };
  };
  return { writes, onWrite, rest: (w) => `${w.method} ${w.url.slice(REPO_API.length)}` };
}

/* The dock alone (js/editor-dock.js in a bare context): a hand-made api, a clock we move by hand, a view we set. */
function bareDock(opts) {
  const o = opts || {};
  const queue = [];
  const body = new FakeElement('body');
  const doc = { body, visibilityState: 'visible', createElement: (t) => new FakeElement(t),
    createTextNode: (t) => ({ textContent: String(t), nodeType: 3 }) };
  const winListeners = {};
  const clock = o.clock;
  const win = { document: doc, navigator: { platform: 'Linux' }, scrollY: 0, HCCore: C,
    setTimeout: (fn) => { queue.push({ fn, live: true }); return queue.length; },
    clearTimeout: (id) => { if (queue[id - 1]) queue[id - 1].live = false; },
    addEventListener: (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); } };
  win.window = win;
  if (clock) win.Date = class extends Date { static now() { return clock.t; } };   // a clock we move by hand
  vm.runInNewContext(readRepo('js/editor-dock.js'), win, { filename: 'editor-dock.js' });
  const D = win.HCDock;
  function h(tag, attrs, ...kids) {
    const el = new FakeElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v; else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids) if (c !== null && c !== undefined && c !== false) el.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c);
    return el;
  }
  const sw = h('button', { 'data-editor-switch': true }, 'Editor');
  const store = memoryStorage();
  const seen = { undo: [], sendAll: [], go: [], openSend: [], review: 0 };
  let view = Object.assign({ signedIn: true, login: 'bob', on: true, editing: true, changes: 0, canUndo: false, canRedo: false,
    access: null, projectId: null, page: { pageId: PAGE_ID, label: 'FCU firmware' }, draftKey: null, chip: 'Can edit',
    pages: [], pageCount: 0, typed: false }, o.view);
  const api = {
    h, store: () => store, controls: h('div', { class: 'hc-editor-controls' }, sw), switchBtn: sw, closeMenu() {},
    redraw: () => D.refresh(view), undoRedo: (op) => seen.undo.push(op),
    sendAll: async (key) => { seen.sendAll.push(key); if (o.sendAll) await o.sendAll(key); },
    go: (r) => seen.go.push(r), loadSends: async () => (o.sends === undefined ? null : o.sends),
    openSend: (s) => seen.openSend.push(s.number), openReview: () => { seen.review += 1; return Boolean(o.openReview); },
    shown() {}, avatar: (l) => h('span', { class: 'hc-avatar', text: l.slice(0, 1) }),
    accessAsk: () => h('button', { 'data-action': 'access-request' }, C.ACCESS_REQUEST_LABEL), onCount() {},
    openCount: async () => (o.count === undefined ? 0 : o.count),
  };
  if (o.phone) body.classList.add('hc-phone');
  D.mount(body, api);
  D.refresh(view);
  return {
    D, body, doc, win, seen, queue,
    set(v) { view = Object.assign({}, view, v); D.refresh(view); },
    view: () => view,
    one: (pred) => findAll(body, pred)[0],
    action: (name) => findAll(body, (e) => e.attrs['data-action'] === name)[0],
    row: (name) => findAll(body, (e) => e.attrs['data-dock-row'] === name)[0],
    list: (name) => findAll(body, (e) => e.attrs['data-dock-list'] === name)[0],
    // one step of the clock: every timer due now runs (the dock's undo clock counts in steps of a second)
    step() { const due = queue.filter((t) => t.live); for (const t of due) { t.live = false; t.fn(); } return due.length; },
    scroll(y) { win.scrollY = y; for (const fn of winListeners.scroll || []) fn({ type: 'scroll' }); },
  };
}

// ---------------------------------------------------------------- D1: the pill, the chip, rows only when they say something

test('U2 D1: the role chip names what you can do, from the real rule (Admin, Can approve, Can approve N projects, Can edit, Read only)', async () => {
  assert.equal(chipOf(await editorOn({ variant: 'admin' })).textContent, 'Admin');
  assert.equal(chipOf(await editorOn({ variant: 'maintain' })).textContent, 'Can approve');
  assert.equal(chipOf(await editorOn()).textContent, 'Can edit', 'a Writer on no project\'s list edits');
  const ro = await editorOn({ variant: 'readonly' });
  assert.equal(chipOf(ro).textContent, 'Read only');
  // a Writer listed on two projects (main's edit-access.json, read by the project page's gate): approves them
  const listed = await editorOn({ hash: `#${GATE_ROUTE}`, files: { [ACCESS_FILE]: accessText(['bob']) } });
  assert.equal(chipOf(listed).textContent, 'Can approve 2 projects');
  const one = await editorOn({ hash: `#${GATE_ROUTE}`, files: { [ACCESS_FILE]: `${JSON.stringify({ projects: {
    'core-stack': { repos: 15, editors: [{ login: 'bob', why: 'commits', repos_with_commits: 2 }], removed: [] } } })}\n` } });
  assert.equal(chipOf(one).textContent, 'Can approve 1 project');
  // neutral: never the orange role colours (ED62)
  for (const p of [listed, ro]) assert.ok(!/cms-role-/.test(chipOf(p).className), chipOf(p).className);
});

test('U2 D1: the chip is muted ink on a tone step, >= 4.5:1 in both themes, never orange', () => {
  const site = readRepo('css/site.css');
  const css = readRepo('css/editor.css');
  const rule = /\.hc-chip \{([^}]*)\}/.exec(css)[1];
  assert.match(rule, /background: var\(--surface-2\)/);
  assert.match(rule, /color: var\(--body-soft\)/);
  assert.ok(!/warn|orange|#ED914C|--hc-p2/i.test(rule), 'no orange');
  const block = (sel) => { const i = site.indexOf(sel); return site.slice(i, site.indexOf('}', i)); };
  const token = (b, k) => new RegExp(`--${k}:\\s*(#[0-9a-fA-F]{6})`).exec(b)[1];
  const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const [theme, b] of [['dark', block(':root')], ['light', block('[data-theme="light"]')]]) {
    const r = ratio(token(b, 'body-soft'), token(b, 'surface-2'));
    assert.ok(r >= 4.5, `${theme}: chip ${r.toFixed(2)}:1`);
  }
});

test('U2 D1: at rest the bubble is the pill alone: photo, chip, switch, × on one row; no "No changes yet"', async () => {
  const page = await editorOn();
  const dock = dockOf(page);
  const pill = findAll(dock, (e) => e.classList.contains('hc-dock-pill'))[0];
  assert.ok(pill, 'the pill');
  const inPill = (pred) => findAll(pill, pred).length === 1;
  assert.ok(inPill((e) => e.classList.contains('hc-chip')), 'the chip in the pill');
  assert.ok(inPill((e) => e.attrs['data-editor-switch'] !== undefined), 'the switch in the pill');
  assert.ok(inPill((e) => e.attrs['data-action'] === 'dock-collapse'), 'the × in the pill');
  for (const name of ['changes', 'review', 'sent']) assert.equal(row(page, name).hidden, true, `no ${name} row`);
  assert.ok(!/No changes yet/.test(dock.textContent));
  // a change: the changes row, per page, with the 24 px arrows and Send for review
  await typePage(page);
  assert.equal(row(page, 'changes').hidden, false);
  assert.equal(page.action('dock-changes').textContent, '1 page changed');
  assert.equal(page.action('dock-send').hidden, false);
  for (const op of ['undo', 'redo']) {
    const b = page.action(op);
    assert.equal(b.hidden, false, op);
    const svg = b.childNodes[0];
    assert.ok(svg && (svg.attrs.width === '24' || svg.classList.contains('hc-dock-glyph')), `${op}: a 24 px glyph`);
  }
  assert.equal(page.action('redo').disabled, true, 'nothing to redo: dimmed, not hidden');
  const css = readRepo('css/editor.css');
  const dim = /\.hc-dock-hist:disabled \{[^}]*opacity: ([0-9.]+)/.exec(css);
  assert.ok(dim && Number(dim[1]) >= 0.45, 'dimmed at opacity >= .45');
});

test('U2 D1: rows show only with something to say — review count, my sends — and × folds to the photo tab', async () => {
  const dock = bareDock({ count: 3, sends: [{ number: 9, title: 'Edit FCU firmware', status: 'waiting', route: PAGE_ROUTE }] });
  assert.equal(dock.row('review').hidden, true);
  assert.equal(dock.row('sent').hidden, true);
  dock.D.loadCount();
  await settle();
  assert.equal(dock.row('review').hidden, false);
  assert.equal(dock.action('tray-open').textContent, '3 to review');
  assert.equal(dock.row('sent').hidden, false);
  assert.equal(dock.action('dock-sent').textContent, '1 sent · waiting');
  dock.D.setCount(0);
  assert.equal(dock.row('review').hidden, true, 'nothing to review: no row');
  // the review row opens the 'review' slot (U3 fills it): "Loading…" until then
  dock.D.setCount(2);
  dock.action('tray-open').click();
  const slot = dock.one((e) => e.attrs['data-dock-panel'] === 'review');
  assert.ok(slot && !slot.hidden);
  assert.equal(slot.textContent, 'Loading…');
  dock.D.panel('review', () => dock.D.chip());
  dock.set({});
  assert.equal(slot.childNodes.length, 1, 'U3 registers its list in the same slot');
  dock.action('dock-collapse').click();
  assert.equal(dock.body.classList.contains('hc-dock-collapsed'), true);
  const tag = dock.one((e) => e.classList.contains('hc-dock-tag'));
  assert.equal(tag.hidden, false, 'the photo tab');
  tag.click();
  assert.equal(dock.body.classList.contains('hc-dock-collapsed'), false);
});

// ---------------------------------------------------------------- D4: the changes list, Send for review, Undo

test('U2 D4: the count opens the list of changed pages (title, N blocks, Send this page); a title goes to the page', async () => {
  const storage = memoryStorage();
  const local = localFor(storage);
  const store = C.createDraftStore(local, C.draftsKey('bob'));
  const ubuntu = readRepo(UBUNTU_FILE);
  store.put(draft(UBUNTU_ID, 'Ubuntu 24.04 Server', UBUNTU_FILE, `${ubuntu}\nOne more paragraph.\n`, ubuntu));
  const page = await editorOn({ storage });
  await typePage(page);
  page.one((e) => e.classList.contains('hc-dock-tag')).click();     // typing folded the bubble (D13); open it again
  assert.equal(page.action('dock-changes').textContent, '2 pages changed', 'per page (ED45)');
  page.action('dock-changes').click();
  await settle();
  const list = page.one((e) => e.attrs['data-dock-list'] === 'changes');
  assert.equal(list.hidden, false);
  const items = findAll(list, (e) => e.classList.contains('hc-dock-item'));
  assert.equal(items.length, 2);
  const ub = items.find((li) => /Ubuntu/.test(li.textContent));
  assert.match(ub.textContent, /1 block/);
  assert.equal(findAll(ub, (e) => e.attrs['data-action'] === 'dock-send-page')[0].textContent, 'Send this page');
  findAll(ub, (e) => e.attrs['data-action'] === 'dock-go')[0].click();
  await settle();
  assert.equal(page.location.hash, `#${C.routeForPage(UBUNTU_ID, { setup: JSON.parse(readRepo('data/setup.json')) })}`);
  assert.equal(page.body.classList.contains('hc-editor-on'), true, 'Editor stays on (the marks show)');
});

test('U2 D4: Send for review sends one per kind with generated titles, then "Sent · waiting for review" with Undo; Undo puts the drafts back', async (t) => {
  const { writes, onWrite, rest } = sendWrites();
  const storage = memoryStorage();
  const local = localFor(storage);
  const store = C.createDraftStore(local, C.draftsKey('bob'));
  const facts = readRepo(FACTS_FILE);
  const factsD = draft('data/projects/core-stack', FACTS_FILE, FACTS_FILE,
    facts.replace('"tagline": "The shared', '"tagline": "The common'), facts);
  store.put(factsD);
  const page = await editorOn({ storage, variant: 'maintain', onWrite, extra: { trees: { [MAIN_SHA]: TREE_M } } });
  hide(t, page);          // the undo clock waits while we look
  await typePage(page);
  const pageD = draftsOf(page).get(PAGE_ID);
  const names = { 'core-stack': JSON.parse(facts).name };
  const groups = C.splitSend([pageD, factsD], { login: 'bob', names });
  assert.deepEqual(groups.map((g) => g.kind), ['page', 'facts']);
  page.action('dock-send').click();
  await settle();
  const prs = writes.filter((w) => rest(w) === 'POST /pulls');
  assert.equal(prs.length, 2, 'one send per kind');
  assert.deepEqual(prs.map((w) => w.body.title), groups.map((g) => g.title));
  assert.equal(prs[0].body.title, `Edit ${pageD.label}`, 'the title is generated: no box');
  assert.equal(draftsOf(page).list().length, 0, 'everything sent');
  const undoBox = page.one((e) => e.attrs['data-dock-undo'] !== undefined);
  assert.equal(undoBox.hidden, false);
  assert.match(undoBox.textContent, /^Sent · waiting for review/);
  assert.match(undoBox.textContent, /goes live on approval/, 'the page send');
  assert.match(undoBox.textContent, /reviewed as a whole/, 'the facts send');
  assert.equal(row(page, 'sent').hidden, false);
  assert.equal(page.action('dock-sent').textContent, '2 sent · waiting');
  assert.equal(row(page, 'changes').hidden, true, 'nothing left to send');
  // Undo: each send closed and its branch dropped, newest first; the drafts come back
  const before = writes.length;
  page.action('dock-undo').click();
  await settle();
  const undo = writes.slice(before).map(rest);
  assert.deepEqual(undo.filter((x) => /^PATCH \/pulls/.test(x)), ['PATCH /pulls/43', 'PATCH /pulls/42']);
  assert.equal(undo.filter((x) => /^DELETE \/git\/refs\/heads\/cms\/bob\//.test(x)).length, 2);
  assert.ok(draftsOf(page).get(PAGE_ID), 'the page draft is back');
  assert.ok(draftsOf(page).get('data/projects/core-stack'), 'the facts draft is back');
  assert.match(undoBox.textContent, /Undone/);
  assert.equal(row(page, 'sent').hidden, true, 'the undone sends left the sent row');
  assert.equal(page.action('dock-changes').textContent, '2 pages changed');
});

test('U2 D4: Send this page sends only that page', async (t) => {
  const { writes, onWrite, rest } = sendWrites();
  const storage = memoryStorage();
  const local = localFor(storage);
  const ubuntu = readRepo(UBUNTU_FILE);
  C.createDraftStore(local, C.draftsKey('bob')).put(draft(UBUNTU_ID, 'Ubuntu 24.04 Server', UBUNTU_FILE, `${ubuntu}\nMore.\n`, ubuntu));
  const page = await editorOn({ storage, onWrite, extra: { trees: { [MAIN_SHA]: TREE_M } } });
  hide(t, page);
  await typePage(page);
  page.one((e) => e.classList.contains('hc-dock-tag')).click();
  page.action('dock-changes').click();
  await settle();
  const list = page.one((e) => e.attrs['data-dock-list'] === 'changes');
  const ub = findAll(list, (e) => e.classList.contains('hc-dock-item')).find((li) => /Ubuntu/.test(li.textContent));
  findAll(ub, (e) => e.attrs['data-action'] === 'dock-send-page')[0].click();
  await settle();
  const trees = writes.filter((w) => rest(w) === 'POST /git/trees');
  assert.equal(trees.length, 1);
  assert.deepEqual(trees[0].body.tree.map((e) => e.path), [UBUNTU_FILE], 'only that page');
  assert.equal(writes.find((w) => rest(w) === 'POST /pulls').body.title, 'Edit Ubuntu 24.04 Server');
  assert.ok(draftsOf(page).get(PAGE_ID), 'the other page stays');
  assert.equal(draftsOf(page).get(UBUNTU_ID), null);
});

test('U2 D4: the Undo clock: 8 s, counted only while the tab is seen; then the box goes', async () => {
  const dock = bareDock();
  const runs = [];
  dock.D.offerUndo({ items: [{ number: 42, title: 'Edit FCU firmware', note: 'goes live on approval' }],
    run: async () => { runs.push(1); return { text: 'Undone: your changes are back.', undone: [42] }; } });
  const box = dock.one((e) => e.attrs['data-dock-undo'] !== undefined);
  assert.equal(box.hidden, false);
  assert.match(box.textContent, /Sent · waiting for review/);
  assert.equal(dock.action('dock-sent').textContent, '1 sent · waiting');
  for (let i = 0; i < 5; i += 1) dock.step();                  // 5 s seen
  dock.doc.visibilityState = 'hidden';
  for (let i = 0; i < 30; i += 1) dock.step();                 // 30 s hidden: not counted
  assert.equal(box.hidden, false, 'still there after the tab was hidden');
  dock.doc.visibilityState = 'visible';
  dock.step(); dock.step();                                    // 7 s seen
  assert.equal(box.hidden, false);
  dock.step();                                                 // 8 s
  assert.equal(box.hidden, true, 'gone after 8 seen seconds');
  assert.equal(dock.step(), 0, 'no clock left running');
  assert.equal(runs.length, 0);
  // a new offer, undone: run() is called once, its words replace the box's, the send leaves the sent row
  dock.D.offerUndo({ items: [{ number: 43, title: 'Edit X' }], run: async () => { runs.push(1); return { text: 'Undone: your changes are back.', undone: [43] }; } });
  dock.action('dock-undo').click();
  await settle();
  assert.equal(runs.length, 1);
  assert.equal(box.textContent, 'Undone: your changes are back.');
  assert.ok(!/43|Edit X/.test(dock.action('dock-sent').textContent), 'the undone send is gone');
  assert.equal(dock.step(), 0, 'the clock stopped');
});

test('U2 D4: an undo that cannot go through says why (UNDO_CHANGED_TEXT, UNDO_DROPPED_TEXT) through the dock', async () => {
  const dock = bareDock();
  dock.D.offerUndo({ items: [{ number: 7, title: 'Edit X' }], run: async () => ({ text: C.UNDO_CHANGED_TEXT, kind: 'error', undone: [] }) });
  dock.action('dock-undo').click();
  await settle();
  const said = dock.one((e) => e.classList.contains('hc-dock-undo-said'));
  assert.equal(said.textContent, C.UNDO_CHANGED_TEXT);
  assert.ok(said.classList.contains('is-error'));
  assert.equal(dock.action('dock-sent').textContent, '1 sent · waiting', 'the send stays: it was not undone');
  assert.ok(typeof C.UNDO_DROPPED_TEXT === 'string' && C.UNDO_DROPPED_TEXT.length > 0);
});

test('U2 D4: the editor\'s undo maps runUndo\'s answers to the dock\'s words', () => {
  const src = readRepo('js/editor.js');
  const fn = src.slice(src.indexOf('async function undoSends('), src.indexOf('function putBack('));
  assert.match(fn, /C\.runUndo\(state\.client, r\.out\)/);
  assert.match(fn, /u\.reason === 'changed' \? C\.UNDO_CHANGED_TEXT/);
  assert.match(fn, /u\.warning === 'dropped'\) \{ said\.push\(C\.UNDO_DROPPED_TEXT\)/);
  assert.ok(!/function sendDraft|function sendProposal/.test(src), 'U0b\'s stopgap is gone');
});

test('U2 D4: a send that builds on my open send says "Added to your send" (one more commit, no new send)', async (t) => {
  const OWN = 'cms/bob/fix-typo-260920';
  const HEAD_B = '3'.repeat(40);
  const TREE_B = '4'.repeat(40);
  const onBranch = `${PAGE_TEXT}More.\n`;
  const { writes, onWrite, rest } = sendWrites();
  const extra = {
    pulls: [{ number: 7, title: 'Fix typo', state: 'open', user: { login: 'bob' }, created_at: '2026-09-20T10:00:00Z',
      head: { ref: OWN, sha: HEAD_B, repo: { full_name: 'desert-mango/hippocampus-docs' } }, base: { ref: 'main' } }],
    files: { 7: [{ filename: PAGE_FILE, status: 'modified' }] },
    contents: { [HEAD_B]: { [PAGE_FILE]: onBranch } },
    compare: { [HEAD_B]: MAIN_SHA },
    trees: { [HEAD_B]: TREE_B },
  };
  const storage = memoryStorage();
  C.createDraftStore(localFor(storage), C.draftsKey('bob')).put({ key: PAGE_ID, label: 'FCU firmware',
    files: { [PAGE_FILE]: `${onBranch}Even more.\n` }, originals: { [PAGE_FILE]: onBranch }, base: { ref: OWN, sha: HEAD_B, number: 7 } });
  const page = await editorOn({ storage, extra, onWrite, textEncoder: true });
  hide(t, page);
  page.action('dock-send').click();
  await settle();
  assert.equal(writes.filter((w) => rest(w) === 'POST /pulls').length, 0, 'no new send');
  assert.ok(writes.some((w) => rest(w) === `PATCH /git/refs/heads/${OWN}`), 'one more commit on my send');
  const box = page.one((e) => e.attrs['data-dock-undo'] !== undefined);
  const notice = page.one((e) => e.classList.contains('hc-notice'));
  assert.match(box.textContent, /Added to your send/, notice ? notice.textContent : 'no notice');
  assert.match(box.textContent, /goes live on approval/);
});

// ---------------------------------------------------------------- D5: my own sends

test('U2 D5: the sent row lists MY sends with their status (nobody else\'s); a click opens the page it changed', async () => {
  const mine = (n, state, extra) => Object.assign({}, PR1, { number: n, title: `Edit page ${n}`, state, merged_at: null,
    created_at: '2026-10-22T10:00:00Z', updated_at: '2026-10-22T10:00:00Z', closed_at: state === 'closed' ? '2026-10-22T11:00:00Z' : null,
    user: Object.assign({}, PR1.user, { login: 'bob' }), head: Object.assign({}, PR1.head, { ref: `cms/bob/edit-${n}-261022` }) }, extra);
  const extra = {
    pulls: [mine(5, 'open'), mine(6, 'closed', { merged_at: '2026-10-22T11:00:00Z' }),
      Object.assign(mine(8, 'open'), { user: Object.assign({}, PR1.user, { login: 'alice' }), head: Object.assign({}, PR1.head, { ref: 'cms/alice/x-261022' }) })],
    files: { 5: [{ filename: PAGE_FILE, status: 'modified' }] },
  };
  const page = await editorOn({ extra });
  await settle();
  assert.equal(row(page, 'sent').hidden, false);
  const btn = page.action('dock-sent');
  assert.match(btn.textContent, /^2 sent · /);
  btn.click();
  await settle();
  const list = page.one((e) => e.attrs['data-dock-list'] === 'sent');
  const items = findAll(list, (e) => e.classList.contains('hc-dock-item'));
  assert.deepEqual(items.map((li) => findAll(li, (e) => e.classList.contains('hc-dock-status'))[0].textContent).sort(), ['Live', 'Waiting']);
  assert.ok(!/alice|page 8/.test(list.textContent), 'nobody else\'s');
  const five = items.find((li) => /page 5/.test(li.textContent));
  page.location.hash = '#/';
  findAll(five, (e) => e.attrs['data-action'] === 'dock-open-send')[0].click();
  await settle();
  assert.equal(page.location.hash, `#${PAGE_ROUTE}`, 'the page that send changed');
});

// ---------------------------------------------------------------- D13: fold on scroll and typing

test('U2 D13: the open bubble folds on a scroll of more than 24 px, not while the pointer is in it; a click brings it back', () => {
  const dock = bareDock();
  const dockEl = dock.one((e) => e.classList.contains('hc-dock'));
  dock.scroll(20);
  assert.equal(dock.body.classList.contains('hc-dock-collapsed'), false, '20 px: stays');
  dockEl.fire('pointerenter');
  dock.scroll(200);
  assert.equal(dock.body.classList.contains('hc-dock-collapsed'), false, 'the pointer is in the bubble');
  dockEl.fire('pointerleave');
  dock.scroll(240);
  assert.equal(dock.body.classList.contains('hc-dock-collapsed'), true, 'folded');
  assert.equal(dock.D.fold && typeof dock.D.fold, 'function');
  dock.one((e) => e.classList.contains('hc-dock-tag')).click();
  assert.equal(dock.body.classList.contains('hc-dock-collapsed'), false, 'the tab opens it again');
  // the frame's scroll (U7/U4 wire it): the same rule through HCDock.scrolled(y)
  dock.D.scrolled(0);
  dock.D.scrolled(10);
  assert.equal(dock.body.classList.contains('hc-dock-collapsed'), false);
  dock.D.scrolled(60);
  assert.equal(dock.body.classList.contains('hc-dock-collapsed'), true);
  // the motion: transform + opacity, 180 ms ease-out, none under reduced motion
  const css = readRepo('css/editor.css');
  assert.match(css, /\.hc-dock \{[^}]*transition: transform \.18s ease-out, opacity \.18s ease-out/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{[^}]*\.hc-dock[^{]*\{ transition: none/);
});

test('U2 D13: typing in the page folds the open bubble', async () => {
  const page = await editorOn();
  assert.equal(tucked(page), false);
  await typePage(page);
  assert.equal(tucked(page), true, 'folded while typing');
  page.one((e) => e.classList.contains('hc-dock-tag')).click();
  await settle();
  assert.equal(tucked(page), false);
});

// ---------------------------------------------------------------- D14: the phone

test('U2 D14: on a phone a round photo button opens the bubble as a bottom sheet; drag down or Escape closes it', () => {
  const dock = bareDock({ phone: true });
  const tag = dock.one((e) => e.classList.contains('hc-dock-tag'));
  assert.equal(dock.body.classList.contains('hc-dock-collapsed'), true, 'closed: nothing covers the page');
  assert.equal(tag.hidden, false, 'the photo button');
  tag.click();
  assert.equal(dock.body.classList.contains('hc-sheet-open'), true, 'the sheet');
  assert.equal(dock.D.escape(), true, 'Escape closes it');
  assert.equal(dock.body.classList.contains('hc-sheet-open'), false);
  assert.equal(dock.D.escape(), false, 'nothing left to close');
  tag.click();
  const grab = dock.one((e) => e.classList.contains('hc-sheet-grab'));
  grab.listeners.pointerdown[0]({ clientY: 100 });
  grab.listeners.pointermove[0]({ clientY: 150 });
  grab.listeners.pointerup[0]({ clientY: 150 });
  assert.equal(dock.body.classList.contains('hc-sheet-open'), true, 'a short drag springs back');
  grab.listeners.pointerdown[0]({ clientY: 100 });
  grab.listeners.pointerup[0]({ clientY: 260 });
  assert.equal(dock.body.classList.contains('hc-sheet-open'), false, 'a drag down closes it');
  const css = readRepo('css/editor.css');
  const phone = css.slice(css.indexOf('/* ==== phone (U2) ==== */'), css.indexOf('/* ==== override: U2 ==== */'));
  assert.match(phone, /safe-area-inset-bottom/);
  assert.match(phone, /overscroll-behavior: contain/);
  assert.match(phone, /min-height: 44px/);
  assert.match(phone, /\.hc-dock-tag \{[^}]*width: 48px; height: 48px/);
});

test('U2 D14: the sheet\'s "N to review" row hands the click to the editor\'s review list, which sits in the sheet', async () => {
  const dock = bareDock({ phone: true, count: 2, openReview: true });
  dock.D.loadCount();
  await settle();
  dock.one((e) => e.classList.contains('hc-dock-tag')).click();
  assert.equal(dock.row('review').hidden, false);
  dock.action('tray-open').click();
  assert.equal(dock.seen.review, 1, 'the review list asked for');
  // U3 (plan D2, D14): the list is the bubble's own content, so the sheet stays open around it
  assert.equal(dock.body.classList.contains('hc-sheet-open'), true, 'the bubble sheet stays');
});

test('U2: HCDock.escape() closes one layer — an open list — and says false when nothing is open', () => {
  const dock = bareDock({ view: { pages: [{ key: PAGE_ID, label: 'FCU firmware', blocks: 1, unit: 'blocks', route: PAGE_ROUTE }], pageCount: 1 } });
  assert.equal(dock.D.escape(), false);
  dock.action('dock-changes').click();
  assert.equal(dock.list('changes').hidden, false);
  assert.equal(dock.D.escape(), true);
  assert.equal(dock.list('changes').hidden, true);
  assert.equal(dock.D.escape(), false);
});

// ---------------------------------------------------------------- ED39, ED41: the locked page

test('U2 ED39/ED41: on a locked project page the review row sits under the lock text and Request edit access; no "admin gave you access" line', async () => {
  const page = await editorOn({ hash: `#${GATE_ROUTE}`, files: { [ACCESS_FILE]: accessText([]) } });
  const dock = dockOf(page);
  const lock = findAll(dock, (e) => e.attrs['data-dock-lock'] !== undefined)[0];
  assert.equal(lock.hidden, false);
  assert.match(lock.textContent, /You can't edit this project\./);
  assert.match(lock.textContent, /Only this project's editors can change it\./);
  assert.equal(findAll(lock, (e) => e.attrs['data-action'] === 'access-request').length, 0, 'fix B9d: the page\'s lock line holds the one Request');
  const kids = dock.childNodes;
  assert.ok(kids.indexOf(lock) < kids.indexOf(row(page, 'review')), 'the review row comes after the lock');
  const added = await editorOn({ hash: `#${GATE_ROUTE}`, files: { [ACCESS_FILE]: accessText(['bob'], 'added') } });
  assert.ok(!/An admin gave you access/.test(dockOf(added).textContent), 'ED41: the line is gone from the bubble');
  const quiet = findAll(dockOf(added), (e) => e.attrs['data-dock-lock'] !== undefined)[0];
  assert.equal(quiet.hidden, true, quiet.textContent);
});

// ================================================================ U2 fix round 1 (review of 50a6647) ===

const MANIFEST_TEXT = readRepo(C.MANIFEST_FILE);
const manifestPlus = () => {
  const m = JSON.parse(MANIFEST_TEXT);
  m.assets.push(Object.assign({}, m.assets[0], { source: null, public_id: 'hippocampus-docs/setup/fix-round-1',
    url: m.assets[0].url.replace('IMG_2502', 'fix-round-1') }));
  return `${JSON.stringify(m, null, 2)}\n`;
};

test('U2 fix 1: Send this page also takes the image list on the same base (the page and its new image go together)', async (t) => {
  const { writes, onWrite, rest } = sendWrites();
  const storage = memoryStorage();
  const store = C.createDraftStore(localFor(storage), C.draftsKey('bob'));
  const ubuntu = readRepo(UBUNTU_FILE);
  store.put(draft(UBUNTU_ID, 'Ubuntu 24.04 Server', UBUNTU_FILE, `${ubuntu}\nMore.\n`, ubuntu));
  store.put(draft(C.MANIFEST_KEY, 'Images', C.MANIFEST_FILE, manifestPlus(), MANIFEST_TEXT));
  const page = await editorOn({ storage, onWrite, extra: { trees: { [MAIN_SHA]: TREE_M } } });
  hide(t, page);
  await typePage(page);
  page.one((e) => e.classList.contains('hc-dock-tag')).click();
  page.action('dock-changes').click();
  await settle();
  const list = page.one((e) => e.attrs['data-dock-list'] === 'changes');
  const ub = findAll(list, (e) => e.classList.contains('hc-dock-item')).find((li) => /Ubuntu/.test(li.textContent));
  findAll(ub, (e) => e.attrs['data-action'] === 'dock-send-page')[0].click();
  await settle();
  const trees = writes.filter((w) => rest(w) === 'POST /git/trees');
  assert.equal(trees.length, 1, 'one send');
  assert.deepEqual(trees[0].body.tree.map((e) => e.path).sort(), [C.MANIFEST_FILE, UBUNTU_FILE].sort(), 'the page and the image list');
  assert.equal(writes.filter((w) => rest(w) === 'POST /pulls').length, 1);
  assert.equal(draftsOf(page).get(C.MANIFEST_KEY), null, 'no image list left behind');
  assert.equal(draftsOf(page).get(UBUNTU_ID), null);
  assert.ok(draftsOf(page).get(PAGE_ID), 'the other page stays');
});

test('U2 fix 2: a listed Writer\'s chip and review count come from the edit-access list on any page, not only a project page', async () => {
  const HEAD_A = '5'.repeat(40);
  const extra = {
    pulls: [{ number: 8, title: 'Core stack words', state: 'open', user: { login: 'alice' }, created_at: '2026-10-20T10:00:00Z',
      updated_at: '2026-10-20T10:00:00Z', head: { ref: 'cms/alice/core-stack-261020', sha: HEAD_A,
        repo: { full_name: 'desert-mango/hippocampus-docs' } }, base: { ref: 'main' } }],
    files: { 8: [{ filename: 'content/projects/core-stack.md', status: 'modified' }] },
  };
  const page = await editorOn({ files: { [ACCESS_FILE]: accessText(['bob']) }, extra });   // a setup page
  await settle();
  assert.equal(chipOf(page).textContent, 'Can approve 2 projects', 'the chip from the list, on a setup page');
  assert.equal(row(page, 'review').hidden, false, 'the review row');
  assert.equal(page.action('tray-open').textContent, '1 to review');
});

test('U2 fix 3 (ED61): Editor mode\'s button text is white, Kyle\'s exact choice; the line-26 comment says so', () => {
  const css = readRepo('css/editor.css');
  const u2 = css.slice(css.indexOf('/* ==== override: U2 ==== */'), css.indexOf('/* ==== override: U3 ==== */'));
  assert.match(u2, /body\.hc-editor-on, body\.hc-edit-on \{ --hc-edit-on: #fff; \}/, 'white on the blue fill in Editor mode');
  const head = css.slice(0, css.indexOf(':root { --hc-mark:'));
  assert.ok(!/dark text in both themes: it reaches 4\.5:1/.test(head), 'the old claim is gone');
  assert.match(head, /white in Editor mode/i);
});

test('U2 fix 4: on a phone the titles in the changes and sent lists are 44 px targets', () => {
  const css = readRepo('css/editor.css');
  const phone = css.slice(css.indexOf('/* ==== phone (U2) ==== */'), css.indexOf('/* ==== override: U2 ==== */'));
  assert.match(phone, /body\.hc-phone \.hc-dock-item-title[^{]*\{ min-height: 44px; \}/);
});

test('U2 fix 5: an Undo offer unfolds a folded bubble (a message must be seen)', () => {
  const dock = bareDock();
  dock.D.fold();
  assert.equal(dock.body.classList.contains('hc-dock-collapsed'), true);
  dock.D.offerUndo({ items: [{ number: 42, title: 'Edit FCU firmware', note: 'goes live on approval' }], run: async () => ({ text: '' }) });
  assert.equal(dock.body.classList.contains('hc-dock-collapsed'), false, 'unfolded');
  assert.ok(dock.action('dock-undo'), 'Undo is there to see');
});

test('U2 fix 6 (ED39): on a locked project page the review row sits right under the lock, even with changes on other pages', async () => {
  const storage = memoryStorage();
  const ubuntu = readRepo(UBUNTU_FILE);
  C.createDraftStore(localFor(storage), C.draftsKey('bob')).put(draft(UBUNTU_ID, 'Ubuntu 24.04 Server', UBUNTU_FILE, `${ubuntu}\nMore.\n`, ubuntu));
  // bob approves learning-to-swim (alice's send there is his to review) but may not edit core-stack
  const only = `${JSON.stringify({ projects: {
    'learning-to-swim': { repos: 2, editors: [{ login: 'bob', why: 'commits', repos_with_commits: 1 }], removed: [] },
    'core-stack': { repos: 15, editors: [], removed: [] } } })}\n`;
  const extra = { pulls: [Object.assign({}, PR1, { number: 9, user: { login: 'alice' }, head: Object.assign({}, PR1.head,
    { ref: 'cms/alice/swim-261020', sha: '6'.repeat(40) }) })], files: { 9: [{ filename: 'content/projects/learning-to-swim.md' }] } };
  const page = await editorOn({ storage, hash: `#${GATE_ROUTE}`, files: { [ACCESS_FILE]: only }, extra });
  await settle();
  const dock = dockOf(page);
  const lock = findAll(dock, (e) => e.attrs['data-dock-lock'] !== undefined)[0];
  assert.equal(lock.hidden, false, 'locked');
  assert.equal(row(page, 'changes').hidden, false, 'the other page\'s change');
  assert.equal(row(page, 'review').hidden, false, 'something to review');
  const k = dock.childNodes;
  assert.equal(k.indexOf(row(page, 'review')), k.indexOf(lock) + 1, 'the review row right after the lock');
  assert.ok(k.indexOf(row(page, 'changes')) > k.indexOf(row(page, 'review')), 'the changes row below it');
  // off the locked page the bubble keeps its order: changes, then review
  await page.go(`#${PAGE_ROUTE}`);
  await settle();
  const after = dock.childNodes;
  assert.ok(after.indexOf(row(page, 'changes')) < after.indexOf(row(page, 'review')), 'changes, then review');
});

test('U2 fix 7a (D13): while a list in the bubble is scrolling, a page scroll does not fold it (400 ms)', () => {
  const clock = { t: 1000000 };
  const dock = bareDock({ clock, view: { pages: [{ key: PAGE_ID, label: 'FCU firmware', blocks: 1, unit: 'blocks', route: PAGE_ROUTE }], pageCount: 1 } });
  dock.action('dock-changes').click();
  dock.list('changes').fire('scroll');
  clock.t += 100;
  dock.scroll(300);
  assert.equal(dock.body.classList.contains('hc-dock-collapsed'), false, 'the list is scrolling');
  clock.t += 400;
  dock.scroll(600);
  assert.equal(dock.body.classList.contains('hc-dock-collapsed'), true, 'later, the page scroll folds it');
});

test('U2 fix 8: when the sign-in ends partway through a send, no Undo is offered and the line says what was sent', async () => {
  const { writes, onWrite: base, rest } = sendWrites();
  let pulls = 0;
  const onWrite = (method, url, body) => {
    const r = url.slice(REPO_API.length);
    if (method === 'POST' && r === '/pulls') pulls += 1;
    if (pulls >= 1 && method === 'POST' && r === '/git/blobs') return { status: 401, body: { message: 'Bad credentials' } };
    return base(method, url, body);
  };
  const storage = memoryStorage();
  const facts = readRepo(FACTS_FILE);
  C.createDraftStore(localFor(storage), C.draftsKey('bob')).put(draft('data/projects/core-stack', FACTS_FILE, FACTS_FILE,
    facts.replace('"tagline": "The shared', '"tagline": "The common'), facts));
  const page = await editorOn({ storage, variant: 'maintain', onWrite, extra: { trees: { [MAIN_SHA]: TREE_M } } });
  await typePage(page);
  page.action('dock-send').click();
  await settle();
  assert.equal(writes.filter((w) => rest(w) === 'POST /pulls').length, 1, 'the page went; the facts did not');
  const box = page.one((e) => e.attrs['data-dock-undo'] !== undefined);
  assert.ok(!box || !findAll(box, (e) => e.attrs['data-action'] === 'dock-undo').length, `no Undo once the sign-in ended: ${box && box.textContent}`);
  const said = page.told.at(-1).text;
  assert.match(said, /sign-in has ended/, said);
  assert.match(said, /Already sent for review: Edit FCU Firmware \(#42\)/, 'what was sent');
});

test('U2 fix 9 (U4 asked): a draft that holds only notes is a change (isDirty, drafts.dirty()), so it can be sent', () => {
  const store = C.createDraftStore(memoryStorage());
  const d = draft(PAGE_ID, 'FCU firmware', PAGE_FILE, PAGE_TEXT, PAGE_TEXT);
  assert.equal(C.isDirty(d), false, 'no change, no notes');
  d.notes = [{ key: 'p1', text: 'Is this still right?' }];
  assert.equal(C.isDirty(d), true, 'notes only');
  store.put(d);
  assert.deepEqual(store.dirty().map((x) => x.key), [PAGE_ID]);
  assert.equal(C.isDirty(Object.assign({}, d, { notes: [] })), false, 'an empty notes list is no change');
});

// ================================================================ fixes pass B (integrated review) ===

test('fix B1 (security 1): a sign-out ends the Undo offer; the old Undo button writes nothing', async (t) => {
  const { writes, onWrite, rest } = sendWrites();
  const page = await editorOn({ onWrite, extra: { trees: { [MAIN_SHA]: TREE_M } } });
  hide(t, page);
  await typePage(page);
  page.action('dock-send').click();
  await settle();
  const undo = page.action('dock-undo');
  assert.ok(undo, 'the offer is out');
  page.one((e) => e.attrs['data-action'] === 'sign-out').click();
  await settle();
  const box = page.one((e) => e.attrs['data-dock-undo'] !== undefined);
  assert.equal(box.hidden, true, 'the offer is gone with the sign-in');
  assert.equal(findAll(box, (e) => e.attrs['data-action'] === 'dock-undo').length, 0);
  const before = writes.length;
  undo.click();
  await settle();
  assert.deepEqual(writes.slice(before).map(rest), [], 'no write after the sign-out');
});

test('fix B1: HCDock.stopOffer() takes the Undo offer away and stops its clock', () => {
  const dock = bareDock();
  dock.D.offerUndo({ items: [{ number: 42, title: 'Edit X' }], run: async () => ({ text: 'Undone.', undone: [42] }) });
  const box = dock.one((e) => e.attrs['data-dock-undo'] !== undefined);
  assert.equal(box.hidden, false);
  assert.equal(typeof dock.D.stopOffer, 'function');
  dock.D.stopOffer();
  assert.equal(box.hidden, true);
  assert.equal(dock.step(), 0, 'no clock left running');
});

test('fix B1: undoSends returns before any write when the sign-in changed', () => {
  const src = readRepo('js/editor.js');
  const body = src.slice(src.indexOf('async function undoSends'), src.indexOf('function putBack'));
  assert.ok(body.indexOf('if (!sessionGen.isCurrent(gen)) return') < body.indexOf('C.runUndo('), 'the check comes before the first write');
});

/* focus() on the fake elements records document.activeElement (restored after the test). */
function trackFocus(t, doc) {
  const proto = FakeElement.prototype;
  const was = proto.focus;
  proto.focus = function focus() { doc.activeElement = this; };
  t.after(() => { proto.focus = was; });
}
const TWO_PAGES = { pages: [{ key: PAGE_ID, label: 'FCU Firmware', blocks: 1, unit: 'blocks', route: PAGE_ROUTE },
  { key: UBUNTU_ID, label: 'Ubuntu 24.04 Server', blocks: 2, unit: 'blocks', route: '/setup/raspberry-pi/ubuntu-24-04-server' }], pageCount: 2 };

test('fix B3 (WCAG 2.4.3): a redraw of the changes list keeps the focus on the same control', (t) => {
  const dock = bareDock({ view: TWO_PAGES });
  trackFocus(t, dock.doc);
  dock.action('dock-changes').click();
  const sendUb = () => findAll(dock.list('changes'), (e) => e.attrs['data-action'] === 'dock-send-page' && e.attrs['data-key'] === UBUNTU_ID)[0];
  const old = sendUb();
  old.focus();
  dock.set({});                       // a redraw: the list is built anew
  assert.notEqual(sendUb(), old, 'a new node');
  assert.equal(dock.doc.activeElement, sendUb(), 'the focus is on the same page\'s Send this page');
  // the page left the list: the focus goes to the row button that opened it
  dock.set({ pages: TWO_PAGES.pages.slice(0, 1), pageCount: 1 });
  assert.equal(dock.doc.activeElement, dock.action('dock-changes'));
});

test('fix B3: a redraw of the review slot keeps the focus on the same row, else on "N to review"', (t) => {
  const dock = bareDock();
  trackFocus(t, dock.doc);
  let rowsShown = [7, 8];
  dock.D.panel('review', () => rowsShown.map((n) => {
    const b = new FakeElement('button');
    b.setAttribute('data-action', 'review-row');
    b.setAttribute('data-pr', String(n));
    return b;
  }));
  dock.D.setCount(2);
  const rowOf = (n) => findAll(dock.body, (e) => e.attrs['data-action'] === 'review-row' && e.attrs['data-pr'] === String(n))[0];
  rowOf(8).focus();
  const before = rowOf(8);
  dock.set({});
  assert.notEqual(rowOf(8), before);
  assert.equal(dock.doc.activeElement, rowOf(8));
  rowsShown = [7];
  dock.set({});
  assert.equal(dock.doc.activeElement, dock.action('tray-open'), 'its row went: the row button');
});

test('fix B4 (WCAG 2.2.1): the Undo offer takes the focus; its 8 s clock waits while the focus or the pointer is in the bubble', (t) => {
  const dock = bareDock();
  trackFocus(t, dock.doc);
  dock.D.offerUndo({ items: [{ number: 42, title: 'Edit FCU Firmware' }], run: async () => ({ text: 'Undone.', undone: [42] }) });
  const box = dock.one((e) => e.attrs['data-dock-undo'] !== undefined);
  assert.equal(dock.doc.activeElement, dock.action('dock-undo'), 'the focus is on Undo');
  for (let i = 0; i < 30; i += 1) dock.step();               // 30 s with the focus on it: not counted
  assert.equal(box.hidden, false, 'still offered');
  dock.doc.activeElement = dock.body;                        // the focus leaves the bubble
  const bubble = dock.one((e) => e.classList.contains('hc-dock'));
  bubble.fire('pointerenter');
  for (let i = 0; i < 30; i += 1) dock.step();               // 30 s with the pointer in it: not counted
  assert.equal(box.hidden, false, 'still offered');
  bubble.fire('pointerleave');
  for (let i = 0; i < 7; i += 1) dock.step();
  assert.equal(box.hidden, false, '7 counted seconds');
  dock.step();
  assert.equal(box.hidden, true, 'gone after 8 counted seconds');
});

test('fix B4 (WCAG 4.1.2): the folded photo tab says what its badge counts', () => {
  const dock = bareDock({ view: TWO_PAGES });
  dock.D.fold(true);
  const tag = dock.one((e) => e.classList.contains('hc-dock-tag'));
  assert.equal(tag.attrs['aria-label'], 'Show the editor controls, 2 pages changed');
  dock.D.setCount(3);
  assert.equal(tag.attrs['aria-label'], 'Show the editor controls, 2 pages changed, 3 to review');
  dock.set({ pages: [], pageCount: 0 });
  assert.equal(tag.attrs['aria-label'], 'Show the editor controls, 3 to review');
  assert.equal(dock.one((e) => e.classList.contains('hc-dock-badge')).textContent, '3', 'the badge shows why');
});

test('fix B7 (Nielsen #6): a change this browser refuses to keep is said once in the bubble, and only then does leaving ask', async () => {
  const local = memoryStorage();
  const setItem = local.setItem;
  let refuse = true;
  local.setItem = (k, v) => { if (refuse && /^hc-cms-drafts/.test(k)) throw new Error('QuotaExceededError'); return setItem(k, v); };
  const page = await editorOn({ localStorage: local });
  assert.deepEqual(page.listeners.beforeunload || [], [], 'no leave question while nothing is lost');
  await typePage(page);
  const line = page.one((e) => e.classList.contains('hc-dock-unsaved'));
  assert.ok(line && !line.hidden, 'the bubble says it');
  assert.equal(line.textContent, 'Your change could not be saved in this browser. It stays on this page until you reload.');
  assert.equal(line.attrs.role, 'alert');
  const ask = page.listeners.beforeunload || [];
  assert.equal(ask.length, 1, 'leaving asks now');
  const ev = { preventDefault() { ev.prevented = true; }, returnValue: undefined };
  ask[0](ev);
  assert.equal(ev.prevented, true, 'the browser\'s leave question');
  await typePage(page, 'Typed again.\n\n');
  assert.equal(page.all((e) => e.classList.contains('hc-dock-unsaved')).length, 1, 'said once: one line');
  // the browser keeps it again: the line goes and leaving asks nothing
  refuse = false;
  await typePage(page, 'And kept.\n\n');
  assert.equal(page.one((e) => e.classList.contains('hc-dock-unsaved')).hidden, true);
  const ev2 = { preventDefault() { ev2.prevented = true; } };
  ask[0](ev2);
  assert.equal(ev2.prevented, undefined, 'nothing is lost: no question');
});

test('fix B7: the bubble stays out on the typing that first could not be kept (the line must be seen)', async () => {
  const local = memoryStorage();
  const setItem = local.setItem;
  local.setItem = (k, v) => { if (/^hc-cms-drafts/.test(k)) throw new Error('QuotaExceededError'); return setItem(k, v); };
  const page = await editorOn({ localStorage: local });
  await typePage(page);
  assert.equal(tucked(page), false, 'not folded by that typing');
});

test('fix B9a (Nielsen #8): a page changed since you started says so in plain words, with its title, and the changes row offers Discard', async () => {
  const { writes, onWrite, rest } = sendWrites();
  const storage = memoryStorage();
  const ubuntu = readRepo(UBUNTU_FILE);
  const old = draft(UBUNTU_ID, 'Ubuntu 24.04 Server', UBUNTU_FILE, `${ubuntu}\nMore.\n`, 'an older text\n');
  old.base = { ref: 'main', sha: '9'.repeat(40), number: null };
  C.createDraftStore(localFor(storage), C.draftsKey('bob')).put(old);
  const page = await editorOn({ storage, onWrite, extra: { trees: { [MAIN_SHA]: TREE_M } } });
  page.action('dock-send').click();
  await settle();
  assert.equal(writes.filter((w) => rest(w) === 'POST /pulls').length, 0, 'nothing sent');
  const said = page.one((e) => e.classList.contains('hc-notice')).textContent;
  assert.match(said, /Ubuntu 24\.04 Server\. Someone changed this page since you started\. Your words are kept on this page: open it to put them back, or discard them\./);
  assert.ok(!/content\/setup|GitHub since you opened|proposed/.test(said), `no file path, no old words: ${said}`);
  page.action('dock-changes').click();
  await settle();
  const discard = findAll(page.one((e) => e.attrs['data-dock-list'] === 'changes'), (e) => e.attrs['data-action'] === 'dock-discard')[0];
  assert.ok(discard, 'Discard on the page\'s row');
  assert.equal(discard.attrs['data-key'], UBUNTU_ID);
  discard.click();
  await settle();
  assert.equal(page.confirms.at(-1), C.DISCARD_TEXT, 'asked first');
  assert.equal(draftsOf(page).get(UBUNTU_ID), null, 'discarded');
});

test('fix B9e (Nielsen #17): the changes list names a page by its own title from the site\'s data', async () => {
  const storage = memoryStorage();
  const ubuntu = readRepo(UBUNTU_FILE);
  C.createDraftStore(localFor(storage), C.draftsKey('bob')).put(draft(UBUNTU_ID, 'ubuntu 24.04 server', UBUNTU_FILE, `${ubuntu}\nMore.\n`, ubuntu));
  const page = await editorOn({ storage });
  page.action('dock-changes').click();
  await settle();
  const list = page.one((e) => e.attrs['data-dock-list'] === 'changes');
  assert.ok(findAll(list, (e) => e.classList.contains('hc-dock-item-title') && e.textContent === 'Ubuntu 24.04 Server 64bit').length === 1, list.textContent);
});

test('fix B9e: no empty "Your changes" head row in the bubble while I edit', async () => {
  const page = await editorOn();
  await typePage(page);
  assert.equal(page.one((e) => e.attrs && e.attrs['data-review-head'] === 'mine'), undefined);
  assert.ok(!/Your changes/.test(dockOf(page).textContent), dockOf(page).textContent);
});

test('fix B10 (Nielsen #13): a first-time editor sees one quiet tip under the pill until the first edit; × hides it for good', async () => {
  const tipOf = (page) => page.one((e) => e.attrs['data-dock-hint'] !== undefined);
  const page = await editorOn();
  assert.equal(tipOf(page).hidden, false, 'shown');
  assert.equal(tipOf(page).textContent.replace('×', ''), 'Click any paragraph to change it. Your edits stay here until you send them.');
  await typePage(page);
  assert.equal(tipOf(page).hidden, true, 'the first edit ends it');
  assert.equal(page.local.getItem('hc-editor-hinted:bob'), '1');
  // another browser of the same person: × hides it, and it stays hidden
  const other = await editorOn();
  assert.equal(tipOf(other).hidden, false);
  other.action('dock-hint-close').click();
  await settle();
  assert.equal(tipOf(other).hidden, true);
  assert.equal(other.local.getItem('hc-editor-hinted:bob'), '1', 'remembered in this browser');
  await other.go('#/setup/raspberry-pi/ubuntu-24-04-server');
  assert.equal(tipOf(other).hidden, true, 'and not shown on the next page');
});

test('fix B10: no tip for a reader who cannot edit the page', () => {
  const dock = bareDock({ view: { editing: false } });
  assert.equal(dock.one((e) => e.attrs['data-dock-hint'] !== undefined).hidden, true);
  dock.set({ editing: true });
  assert.equal(dock.one((e) => e.attrs['data-dock-hint'] !== undefined).hidden, false);
});
