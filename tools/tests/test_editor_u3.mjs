// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 23 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test the U3 review work in the editor: the review panel, margin cards, redirects and the Escape order.
/* Made by U0 (editor UI/UX build) so unit U3 adds its tests here, not to a shared test file.

     node --test tools/tests/test_editor_u3.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const C = require(path.join(ROOT, 'js', 'cms-core.js'));

// ------------------------------------------------- who sees a proposal (D2) ---
const ACCESS = { projects: {
  'core-stack': { repos: 2, editors: [{ login: 'Wendy', why: 'commits', repos_with_commits: 1 }, { login: 'max', why: 'added', repos_with_commits: 0 }], removed: [] },
  'learning-to-swim': { repos: 1, editors: [{ login: 'wendy', why: 'commits', repos_with_commits: 1 }], removed: [{ login: 'max', had_commits: false }] },
} };
const pull = (n, author, o) => Object.assign({ number: n, state: 'open', user: { login: author }, body: '' }, o || {});
const rows = (...names) => names.map((filename) => ({ filename, status: 'modified' }));
const ADMIN = { login: 'ada', role: 'admin' };
const MAINTAIN_ED = { login: 'max', role: 'maintain' };       // an editor of core-stack only (removed from learning-to-swim)
const MAINTAIN_NONE = { login: 'mo', role: 'maintain' };      // an editor of no project
const WRITE_ED = { login: 'wendy', role: 'push' };            // an editor of both projects
const WRITE_OTHER = { login: 'otto', role: 'push' };
const READ = { login: 'rita', role: 'read' };
const ALL = [ADMIN, MAINTAIN_ED, MAINTAIN_NONE, WRITE_ED, WRITE_OTHER, READ];
const sees = (entry) => ALL.filter((v) => C.visibleProposals(v, [entry], ACCESS).length === 1).map((v) => v.login);

test('visibleProposals (D2 table): page edits inside one project\'s files — Admin, and Maintain/Write editors of that project', () => {
  assert.deepEqual(sees({ pull: pull(1, 'bob'), files: rows('content/projects/core-stack.md') }), ['ada', 'max', 'wendy']);
  assert.deepEqual(sees({ pull: pull(2, 'bob'), files: rows('data/projects/core-stack.json', 'content/projects/core-stack.md') }), ['ada', 'max', 'wendy']);
  assert.deepEqual(sees({ pull: pull(3, 'bob'), files: rows('content/projects/learning-to-swim.md') }), ['ada', 'wendy'], 'removed wins over added');
  assert.deepEqual(sees({ pull: pull(4, 'bob'), files: rows('content/projects/core-stack.md', 'content/projects/learning-to-swim.md') }), ['ada', 'wendy'],
    'every file must be a project the viewer edits');
});

test('visibleProposals (D2 table): setup, tool, Team, people, access, new project, shared files — Admin only', () => {
  for (const files of [rows('content/setup/hippocampus-bringup/fcu-firmware.md'), rows('content/tools/librarian.md'), rows('content/about.md'),
    rows('data/people.json'), rows('data/projects.json'), [{ filename: 'data/projects/new-thing.json', status: 'added' }],
    rows('content/projects/core-stack.md', 'data/cloudinary-manifest.json'), rows('data/site.json')]) {
    assert.deepEqual(sees({ pull: pull(5, 'bob'), files }), ['ada'], files.map((f) => f.filename).join());
  }
});

test('visibleProposals: never the author\'s own; unread files only for Admin; closed ones never; a renamed-away file counts', () => {
  assert.deepEqual(sees({ pull: pull(6, 'Wendy'), files: rows('content/projects/core-stack.md') }), ['ada', 'max'], 'Wendy\'s own (any case)');
  assert.deepEqual(sees({ pull: pull(7, 'ada'), files: null }), [], 'the admin\'s own; files unread: nobody else');
  assert.deepEqual(sees({ pull: pull(8, 'bob'), files: null }), ['ada']);
  assert.deepEqual(sees({ pull: pull(9, 'bob', { state: 'closed' }), files: rows('content/projects/core-stack.md') }), []);
  assert.deepEqual(sees({ pull: pull(10, 'bob'), files: [{ filename: 'content/projects/core-stack.md', previous_filename: 'content/setup/x.md', status: 'renamed' }] }), ['ada']);
  assert.deepEqual(C.visibleProposals(ADMIN, [null, { pull: null }, 'x'], ACCESS), []);
});

test('visibleProposals: a notes-only send is seen by the pages its body names, the same rows', () => {
  const body = (file) => C.prBody({ summary: 'Note on a page', pages: [{ label: 'Core stack', file }] });
  assert.deepEqual(sees({ pull: pull(11, 'bob', { body: body('content/projects/core-stack.md') }), files: [] }), ['ada', 'max', 'wendy']);
  assert.deepEqual(sees({ pull: pull(12, 'bob', { body: body('content/setup/a/b.md'), changed_files: 0 }), files: [] }), ['ada']);
  assert.deepEqual(sees({ pull: pull(13, 'bob', { body: 'no pages named' }), files: [] }), ['ada']);
  assert.deepEqual(C.bodyPages('Pages:\n- A (`content/a.md`)\n- B (`content/../x.md`)\n- C (`js/app.js`)\n- A again (`content/a.md`)\n'), ['content/a.md']);
});

test('mayReviewPage: the per-page form the marks and the count use', () => {
  const page = 'content/projects/core-stack.md';
  assert.deepEqual(ALL.filter((v) => C.mayReviewPage(v, page, ACCESS)).map((v) => v.login), ['ada', 'max', 'wendy']);
  assert.deepEqual(ALL.filter((v) => C.mayReviewPage(v, { file: 'content/setup/a/b.md' }, ACCESS)).map((v) => v.login), ['ada']);
  assert.equal(C.mayReviewPage({ login: 'max', role: { key: 'maintain' } }, page, ACCESS), true, 'the role object works too');
  assert.equal(C.mayReviewPage(MAINTAIN_ED, page, null), false, 'the access list unread: fails closed');
  assert.equal(C.mayReviewPage({ role: 'admin' }, page, ACCESS), false, 'no login');
});

test('proposalKind and its words', () => {
  const k = (files, o) => C.proposalKind(pull(1, 'bob', o), files);
  assert.equal(k(rows('content/setup/a/b.md', 'content/projects/x.md')), 'page');
  assert.equal(k(rows('content/setup/a/b.md', 'data/cloudinary-manifest.json')), 'page');
  assert.equal(k([]), 'notes');
  assert.equal(k(rows('content/a.md'), { changed_files: 0 }), 'notes');
  assert.equal(k(rows('data/projects/x.json', 'data/projects/y.json')), 'facts');
  assert.equal(k([{ filename: 'data/projects/x.json', status: 'added' }, ...rows('data/projects.json', 'content/projects/x.md')]), 'project');
  assert.equal(k(rows('data/people.json')), 'people');
  assert.equal(k(rows('data/projects.json')), 'access');
  assert.equal(k(rows('data/site.json')), 'site');
  assert.equal(k(rows('data/cloudinary-manifest.json')), 'site');
  assert.equal(k(null), 'site');
  assert.deepEqual(Object.keys(C.REVIEW_KIND_WORDS).sort(), ['access', 'facts', 'notes', 'people', 'project', 'site']);
  assert.equal(C.REVIEW_KIND_WORDS.access, 'access request');
});

test('reviewUrl (D18): the site address with the review list open on the proposal; prBody says "on the site"', () => {
  assert.equal(C.reviewUrl('https://docs.example.org', 42), 'https://docs.example.org/#/?editor=review&pr=42');
  assert.equal(C.reviewUrl('https://docs.example.org', 7, '/setup/a/b'), 'https://docs.example.org/#/setup/a/b?editor=review&pr=7');
  for (const bad of ['//evil.example', 'setup', '/a b', '/x?y=1', null]) {
    assert.equal(C.reviewUrl('https://d.org', 3, bad), 'https://d.org/#/?editor=review&pr=3', String(bad));
  }
  const body = C.prBody({ summary: 'Fix', pages: [], reviewUrl: C.reviewUrl('https://d.org', 3) });
  assert.match(body, /\nReview it on the site: https:\/\/d\.org\/#\/\?editor=review&pr=3\n$/);
  assert.doesNotMatch(body, /editor:|cms\//);
});

test('noteKey: sha256(path NUL block NUL block) of the block without its trailing space', async () => {
  const k = await C.noteKey('content/a.md', 'Some words.\n\n', webcrypto.subtle);
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.equal(k, await C.noteKey('content/a.md', 'Some words.', webcrypto.subtle));
  assert.notEqual(k, await C.noteKey('content/b.md', 'Some words.', webcrypto.subtle));
  const digest = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('content/a.md\0Some words.\0Some words.'))).toString('hex');
  assert.equal(k, digest);
});

// ------------------------------------------------- the editor side (js/editor.js) ---
import fs from 'node:fs';
import { settle, openSite, memoryStorage, findAll } from './editor_harness.mjs';

const { MAIN_SHA } = require(path.join(ROOT, 'tools', 'tests', 'fake_github.js'));
const readRepo = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const PR1 = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'tests', 'fixtures', 'github-data', 'pull-1.json'), 'utf8'));
const UBUNTU_ROUTE = '/setup/raspberry-pi/ubuntu-24-04-server';
const UBUNTU_FILE = 'content/setup/raspberry-pi/ubuntu-24-04-server.md';
const OTHER_ROUTE = '/setup/hippocampus-bringup/fcu-firmware';
const PR1_AUTHOR = PR1.user.login;

/* Editor on at `route`, the frame ready. */
async function on(route, site) {
  const storage = memoryStorage();
  const page = openSite(Object.assign({ hash: `#${route}`, storage, localStorage: memoryStorage(), textEncoder: true }, site || {}));
  await settle();
  page.switchBtn().click();
  await settle();
  await page.send({ type: 'hc-ready' });
  return page;
}
const H = (page) => page.win.HCEditor.helpers;
const panelOf = (page) => page.one((e) => e.attrs && e.attrs['data-dock-panel'] === 'review');
const reviewRows = (page) => page.all((e) => e.classList.contains('hc-review-row'));
const lastEditor = (page) => page.frame().posted.filter((x) => x.m.type === 'hc-editor').map((x) => x.m).at(-1);
const textOf = (n) => (n ? n.textContent : '');

/* A pull by `author` (number n) changing `files` (each modified), with a head of its own and no check runs. */
function extraPull(n, author, files, o) {
  const head = `c${n}${'0'.repeat(39 - String(n).length)}`;
  const pullN = Object.assign({}, PR1, { number: n, title: `Proposal ${n}`, created_at: '2026-09-30T08:00:00Z',
    updated_at: '2026-09-30T08:00:00Z', changed_files: files.length, body: '',
    user: Object.assign({}, PR1.user, { login: author }), head: Object.assign({}, PR1.head, { sha: head, ref: `cms/${author}/p${n}` }) }, o || {});
  return {
    pulls: [pullN],
    files: { [n]: files.map((filename) => ({ filename, status: 'modified', additions: 1, deletions: 1, changes: 2, patch: '@@ -1 +1 @@' })) },
    contents: { [head]: {} },
    compare: { [head]: MAIN_SHA },
    checks: { [head]: { total_count: 0, check_runs: [] } },
  };
}

test('U3 review list (D2, ED8, ED11): an Admin\'s bubble lists the open proposal; the row names who, what, when and the dot', async () => {
  const page = await on(OTHER_ROUTE, { variant: 'admin' });
  assert.equal(page.handle().hidden, false, 'the count shows for someone with something to review');
  page.handle().click();
  await settle();
  const panel = panelOf(page);
  assert.ok(panel, 'the review panel slot (HCDock.panel)');
  assert.match(textOf(page.handle()), /1 to review/, 'fix B6: the row button is the list\'s one header');
  const rowsNow = reviewRows(page);
  assert.equal(rowsNow.length, 1);
  const row = rowsNow[0];
  assert.match(textOf(row), new RegExp(PR1_AUTHOR));
  assert.match(textOf(row), /9 pages/, 'PR #1 changes nine pages');
  assert.ok(page.all((e) => e.classList.contains('hc-review-dot')).length === 1, 'a status dot');
  assert.ok(row.childNodes.some((c) => c.classList && c.classList.contains('hc-review-acts')), 'its actions');
  // PR #1 is not a site-editor proposal (its branch is not cms/…): go-live cannot apply it per edit, so it is
  // approved or declined whole
  assert.ok(findAll(row, (e) => e.attrs && e.attrs['data-action'] === 'review-decline').length === 1, 'reviewed whole');
  assert.doesNotMatch(textOf(panel), /read-only|PR\b|merge|branch|commit/i, 'plain words (D22)');
  assert.equal(H(page).state().reviewOpen, true);
  page.handle().click();
  await settle();
  assert.equal(H(page).state().reviewOpen, false, 'the count closes the list again');
});

test('U3 (ED11): a Write member who edits no project and a read-only role see no count, no list and no marks', async () => {
  for (const variant of ['push', 'readonly']) {
    const page = await on(UBUNTU_ROUTE, { variant });
    assert.equal(page.handle().hidden, true, `${variant}: no count`);
    assert.equal(reviewRows(page).length, 0, `${variant}: no rows`);
    assert.deepEqual([...lastEditor(page).overlay], [], `${variant}: no marks of PR #1 on its page`);
  }
});

test('U3 row click (ED9, ED47): its first page opens, the bubble stays out with the row marked, focusPr set; leaving ends it (ED53)', async () => {
  const mainText = readRepo(UBUNTU_FILE);
  const extra = extraPull(3, 'wendy', [UBUNTU_FILE]);
  const head = extra.pulls[0].head.sha;
  const at = C.splitBlocks(mainText).blocks.find((b) => b.kind === 'heading').end;
  extra.contents[head][UBUNTU_FILE] = `${mainText.slice(0, at)}\nA paragraph wendy adds.\n${mainText.slice(at)}`;
  const page = await on(OTHER_ROUTE, { variant: 'admin', extra });
  page.handle().click();
  await settle();
  assert.equal(reviewRows(page).length, 2, 'two rows: #3 and #1');
  assert.ok(findAll(reviewRows(page).find((r) => r.attrs['data-pr'] === '3'), (e) => e.attrs && e.attrs['data-action'] === 'review-approve-all').length === 1,
    'a site-editor page proposal: Approve all in its row');
  page.one((e) => e.attrs && e.attrs['data-action'] === 'review-row' && e.attrs['data-pr'] === '3').click();
  await settle();
  assert.equal(H(page).state().focusPr, 3);
  assert.equal(page.location.hash, `#${UBUNTU_ROUTE}`, 'its first changed page');
  for (const fn of page.listeners.hashchange || []) fn();   // the browser's hashchange (the harness does not fire it)
  await settle();
  await page.send({ type: 'hc-ready' });
  assert.equal(H(page).state().focusPr, 3, 'kept across its own navigation');
  assert.equal(H(page).state().reviewOpen, true, 'the bubble stays open');
  const marked = reviewRows(page).filter((r) => r.classList.contains('is-viewing'));
  assert.equal(marked.length, 1, 'the row is marked');
  assert.ok(lastEditor(page).overlay.length > 0, 'its marks on the page');
  // the head names whose changes these are, with Back
  assert.match(textOf(panelOf(page)), /Viewing wendy's changes/);
  // the first change is scrolled into view once its cards are read (hc-editor focus)
  const f = page.frame().posted.map((x) => x.m).filter((m) => m.type === 'hc-editor' && m.focus).at(-1);
  assert.ok(f && Number.isInteger(f.focus.index) && f.focus.n >= 1, 'the frame is asked to scroll to the first change');
  // leaving the page ends the viewing (ED53)
  await page.go(`#${OTHER_ROUTE}`);
  assert.equal(H(page).state().focusPr, null);
  assert.doesNotMatch(textOf(panelOf(page)), /Viewing/);
});

test('U3 (ED46, ED48): Back puts the proposal away on this page: my own page again, until the route changes', async () => {
  const page = await on(UBUNTU_ROUTE, { variant: 'admin' });
  assert.ok(lastEditor(page).overlay.length > 0, 'PR #1 drawn on its page for an Admin');
  const head = page.one((e) => e.attrs && e.attrs['data-review-head'] === 'viewing');
  assert.ok(head, 'the bubble names the proposal on screen');
  assert.match(textOf(head), new RegExp(`Viewing ${PR1_AUTHOR}'s changes`));
  page.one((e) => e.attrs && e.attrs['data-action'] === 'review-back').click();
  await settle();
  await page.send({ type: 'hc-ready' });
  assert.deepEqual([...lastEditor(page).overlay], [], 'no marks after Back');
  assert.equal(page.one((e) => e.attrs && e.attrs['data-review-head'] === 'viewing'), undefined, 'the head is gone');
  assert.equal(H(page).state().plain, 'setup/raspberry-pi/ubuntu-24-04-server');
});

test('U3 Approve / Decline (D3): a proposal reviewed whole names red site rules before a second click, then approves it', async () => {
  const writes = [];
  const extra = extraPull(5, 'wendy', ['data/projects/core-stack.json']);
  const onWrite = (method, url, body) => {
    writes.push({ method, url, body });
    return /\/merge$/.test(url) ? { status: 200, body: { merged: true, sha: 'f'.repeat(40) } } : { status: 200, body: {} };
  };
  const page = await on(OTHER_ROUTE, { variant: 'admin', extra, onWrite });
  page.handle().click();
  await settle();
  const row = reviewRows(page).find((r) => r.attrs['data-pr'] === '5');
  assert.ok(row, 'the facts proposal has a row');
  assert.match(textOf(row), /project facts/, 'its kind in words');
  const act = (name) => {
    const r = reviewRows(page).find((x) => x.attrs['data-pr'] === '5');
    return findAll(r, (e) => e.attrs && e.attrs['data-action'] === name)[0];
  };
  assert.ok(act('review-decline'), 'Decline');
  act('review-approve').click();
  await settle();
  assert.equal(writes.length, 0, 'the first click only explains');
  const why = page.one((e) => e.classList.contains('hc-review-why'));
  assert.ok(why && /site rules/i.test(textOf(why)), 'the reasons, in plain words');
  assert.match(textOf(act('review-approve')), /Approve anyway/);
  act('review-approve').click();
  await settle();
  assert.deepEqual(writes.map((w) => [w.method, w.url.replace(/^.*\/repos\/[^/]+\/[^/]+/, '')]), [['PUT', '/pulls/5/merge']],
    'then it is approved whole (an Admin: no review needed first)');
  assert.match(textOf(page.one((e) => e.classList.contains('hc-notice'))), /Approved/);
});

test('U3 note cards (D3, ED18): a note in the proposal body sits beside its block, as plain text', async () => {
  const mainText = readRepo(UBUNTU_FILE);
  const blocks = C.splitBlocks(mainText).blocks;
  const target = blocks.find((b) => b.kind === 'paragraph' || (b.kind !== 'space' && b.kind !== 'heading'));
  const key = await C.noteKey(UBUNTU_FILE, target.text, webcrypto.subtle);
  const body = C.notesSection.serialise(`Notes\n\nPages:\n- Ubuntu (\`${UBUNTU_FILE}\`)\n`, [{ key, text: 'Check <b>this</b> line.' }]);
  const extra = extraPull(6, 'wendy', [], { changed_files: 0, body });
  extra.files = { 6: [] };
  const page = await on(UBUNTU_ROUTE, { variant: 'admin', extra });
  page.handle().click();
  await settle();
  const row = reviewRows(page).find((r) => r.attrs['data-pr'] === '6');
  assert.ok(row, 'the notes-only send has a row');
  assert.ok(page.all((e) => e.attrs && e.attrs['data-action'] === 'review-done').length === 1, 'with Done');
  page.one((e) => e.attrs && e.attrs['data-action'] === 'review-row' && e.attrs['data-pr'] === '6').click();
  await settle();
  await page.send({ type: 'hc-ready' });
  const note = page.one((e) => e.classList.contains('hc-rnote'));
  assert.ok(note, 'a note card');
  assert.match(textOf(note), /wendy's note/);
  const p = page.one((e) => e.classList.contains('hc-rnote-text'));
  assert.equal(p.textContent, 'Check <b>this</b> line.', 'the text as text, never HTML');
  assert.equal(p.childNodes.length, 0);
  const m = lastEditor(page);
  assert.ok(m.anchors.includes(blocks.indexOf(target)), 'the frame is told which block it sits beside');
});

test('U3 one Escape stack (D18, ED52): menu, then the open block, then the bubble\'s list, then the editor page', async () => {
  const page = await on(UBUNTU_ROUTE, { variant: 'admin' });
  await page.dataFiles();                                   // the editor page
  page.handle().click();                                    // the review list over it
  await settle();
  page.action('avatar').click();                            // the account menu over everything
  await settle();
  const order = [];
  for (let i = 0; i < 5; i += 1) order.push(H(page).escapeTop());
  assert.deepEqual(order, ['menu', 'panel', 'page', null, null]);
  // a block open in the page comes before the panel
  page.handle().click();
  await settle();
  await page.pick(0);
  assert.deepEqual([H(page).escapeTop(), H(page).escapeTop()], ['block', 'panel']);
  // the keydown answers through the same stack
  page.handle().click();
  await settle();
  for (const fn of page.docListeners('keydown')) fn({ key: 'Escape', defaultPrevented: false, preventDefault() {} });
  assert.equal(H(page).state().reviewOpen, false);
});

test('U3 margin cards: markers when the gutter is narrower than a card (U7\'s ask), below the block on phones', () => {
  const page = openSite({});
  const mode = page.win.HCEditor.helpers.railModeFor;
  assert.equal(mode(1440, 16, false), 'markers', '10vw = 144 px < 296 px');
  assert.equal(mode(3000, 16, false), 'cards', '300 px gutter holds a card');
  assert.equal(mode(2400, 16, false), 'cards', '(2400 - 1760) / 2 = 320 px');
  assert.equal(mode(2300, 16, false), 'markers');
  assert.equal(mode(3000, 16, true), 'below');
});

test('U3 redirects (D18): #/review/<n> opens the list on that proposal; #/review opens the list', async () => {
  const page = await on(OTHER_ROUTE, { variant: 'admin' });
  assert.equal(page.win.HCEditor.openView('#/review'), true);
  await settle();
  assert.equal(H(page).state().reviewOpen, true);
  H(page).escapeTop();
  assert.equal(page.win.HCEditor.openView('#/review/1'), true);
  await settle();
  assert.equal(H(page).state().reviewOpen, true);
  assert.equal(H(page).state().focusPr, 1);
});

// ------------------------------------------------- the frame side (js/editor-frame.js, js/source.js) ---
import { setupPage, fakeHC, fakeWin, blocksOf } from './frame_harness.mjs';

const EF = require(path.join(ROOT, 'js', 'editor-frame.js'));
const SRC = require(path.join(ROOT, 'js', 'source.js'));

test('U3 hc-editor focus / anchors (js/source.js U3 block): checked numbers only', () => {
  const base = { type: 'hc-editor', on: true };
  assert.deepEqual(SRC.editorMessage({ ...base, focus: { n: 2, index: 5, html: '<b>' } }).focus, { n: 2, index: 5 });
  for (const bad of [null, 5, { n: 0, index: 1 }, { n: 1, index: -1 }, { n: 1.5, index: 1 }, { n: 1, index: '1' }]) {
    assert.equal(SRC.editorMessage({ ...base, focus: bad }).focus, null, JSON.stringify(bad));
  }
  assert.deepEqual(SRC.editorMessage({ ...base, anchors: [3, -1, 'x', 4, 4.5, 9] }).anchors, [3, 4, 9]);
  assert.deepEqual(SRC.editorMessage({ ...base, anchors: 'nope' }).anchors, []);
  assert.equal(SRC.editorMessage({ ...base, anchors: Array.from({ length: 900 }, (_, i) => i) }).anchors.length, 500);
});

test('U3 frame: a focus scrolls its block into view once per n; a note\'s block is reported like a marked one', () => {
  const { doc, body } = setupPage();
  const HC = fakeHC();
  const win = fakeWin();
  win.innerHeight = 800;
  EF.create(win, doc, HC);
  HC.send({ on: true });
  const [, , w3, w5] = blocksOf(body);
  w3.getBoundingClientRect = () => ({ top: 120, height: 60, bottom: 180 });
  w5.getBoundingClientRect = () => ({ top: 400, height: 90, bottom: 490 });
  HC.send({ on: true, overlay: [{ index: 3, mark: 'change' }], focus: { n: 1, index: 3 } });
  assert.equal(w3.scrolled, 1, 'the first change is scrolled into view');
  HC.send({ on: true, overlay: [{ index: 3, mark: 'change' }], focus: { n: 1, index: 3 } });
  assert.equal(w3.scrolled, 1, 'once per n: the reader may scroll away');
  HC.send({ on: true, overlay: [], anchors: [5], focus: { n: 2, index: 5 } });
  assert.equal(w5.scrolled, 1);
  const last = HC.posts.filter((p) => p.type === 'hc-block-rects').pop();
  assert.deepEqual(last.rects, [{ index: 5, top: 400, height: 90 }], 'the note\'s block, for its card');
});

test('U3 the PR body\'s link (reviewUrl, /cms/#/review/<n> via cms-redirect.js): /#/?editor=review&pr=<n> lands on its first page, the list open', async () => {
  const extra = extraPull(3, 'wendy', [UBUNTU_FILE]);
  const page = openSite({ hash: '#/?editor=review&pr=3', storage: memoryStorage(), localStorage: memoryStorage(), textEncoder: true, variant: 'admin', extra });
  await settle();
  for (const fn of page.listeners.hashchange || []) fn();
  await settle();
  assert.equal(page.location.hash, `#${UBUNTU_ROUTE}`);
  assert.equal(H(page).state().reviewOpen, true);
  assert.equal(H(page).state().focusPr, 3);
});

test('U3 phone: the review list is the bottom sheet (.hc-rsheet); cards open under their block (no cards sheet)', async () => {
  const page = await on(UBUNTU_ROUTE, { variant: 'admin', phone: true });
  assert.ok(page.body.classList.contains('hc-phone'));
  page.handle().click();
  await settle();
  const list = page.one((e) => e.attrs && e.attrs['data-review'] !== undefined);
  assert.ok(list.classList.contains('hc-rsheet') && list.attrs.role === 'dialog');
  assert.equal(H(page).railModeFor(375, 16, true), 'below');
  assert.equal(page.all((e) => e.attrs && e.attrs['data-action'] === 'rail-sheet-close').length, 0);
  assert.equal(H(page).escapeTop(), 'panel');
  assert.equal(page.one((e) => e.attrs && e.attrs['data-review'] !== undefined), undefined, 'Escape closed it');
});

/* ---- Fix round 1 ---- */

/* Proposal #3 by wendy: one paragraph added to the Ubuntu page (a site-editor page proposal). */
function wendyAdds() {
  const mainText = readRepo(UBUNTU_FILE);
  const extra = extraPull(3, 'wendy', [UBUNTU_FILE]);
  const head = extra.pulls[0].head.sha;
  const at = C.splitBlocks(mainText).blocks.find((b) => b.kind === 'heading').end;
  extra.contents[head][UBUNTU_FILE] = `${mainText.slice(0, at)}\nA paragraph wendy adds.\n${mainText.slice(at)}`;
  return extra;
}
const fireHash = async (page) => { for (const fn of page.listeners.hashchange || []) fn(); await settle(); };
const rowAct = (page, n, name) => findAll(reviewRows(page).find((x) => x.attrs['data-pr'] === String(n)),
  (e) => e.attrs && e.attrs['data-action'] === name)[0];
// GitHub's GraphQL reads (POST) are not writes
const writeLog = (writes) => writes.filter((w) => !/\/graphql$/.test(w.url)).map((w) => [w.method, w.url.replace(/^.*\/repos\/[^/]+\/[^/]+/, '')]);

test('U3 (ED53): a heading or Contents link on the same page keeps the proposal on screen; leaving the page ends it', async () => {
  const page = await on(OTHER_ROUTE, { variant: 'admin', extra: wendyAdds() });
  page.handle().click();
  await settle();
  page.one((e) => e.attrs && e.attrs['data-action'] === 'review-row' && e.attrs['data-pr'] === '3').click();
  await settle();
  await fireHash(page);
  await page.send({ type: 'hc-ready' });
  assert.equal(H(page).state().focusPr, 3, 'viewing #3 on its page');
  // the frame's own heading link (js/app.js: #/<route>@<heading id>), as frameRouted hands it on
  await page.send({ type: 'hc-route', route: `${UBUNTU_ROUTE}@some-heading` });
  await page.go(`#${UBUNTU_ROUTE}@some-heading`);
  assert.equal(H(page).state().focusPr, 3, 'still viewing #3 after an anchor on the same page');
  assert.equal(reviewRows(page).filter((r) => r.classList.contains('is-viewing')).length, 1, 'its row stays marked');
  assert.match(textOf(panelOf(page)), /Viewing wendy's changes/);
  await page.go(`#${OTHER_ROUTE}`);
  assert.equal(H(page).state().focusPr, null, 'another page ends it');
});

test('U3 (ED46, ED53): Back stays put across an anchor on the same page, and ends on another page', async () => {
  const page = await on(UBUNTU_ROUTE, { variant: 'admin' });
  page.one((e) => e.attrs && e.attrs['data-action'] === 'review-back').click();
  await settle();
  const plain = H(page).state().plain;
  assert.ok(plain, 'Back set');
  await page.go(`#${UBUNTU_ROUTE}@some-heading`);
  assert.equal(H(page).state().plain, plain, 'kept across a same-page anchor');
  await page.go(`#${OTHER_ROUTE}`);
  assert.equal(H(page).state().plain, null, 'cleared on another page');
});

test('U3 Decline (D3): an Admin\'s Decline closes the proposal (one write) and the row goes', async () => {
  const writes = [];
  const onWrite = (method, url, body) => { writes.push({ method, url, body }); return { status: 200, body: { state: 'closed' } }; };
  const page = await on(OTHER_ROUTE, { variant: 'admin', extra: extraPull(5, 'wendy', ['data/projects/core-stack.json']), onWrite });
  page.handle().click();
  await settle();
  rowAct(page, 5, 'review-decline').click();       // fix B8: the first click asks ("Yes, decline")
  await settle();
  rowAct(page, 5, 'review-decline').click();
  await settle();
  assert.deepEqual(writeLog(writes), [['PATCH', '/pulls/5']]);
  assert.deepEqual(writes[0].body && JSON.parse(typeof writes[0].body === 'string' ? writes[0].body : JSON.stringify(writes[0].body)), { state: 'closed' });
});

test('U3 Done (D3): a notes-only send\'s Done closes it (one write)', async () => {
  const writes = [];
  const onWrite = (method, url, body) => { writes.push({ method, url, body }); return { status: 200, body: { state: 'closed' } }; };
  const body = C.notesSection.serialise(`Notes\n\nPages:\n- Ubuntu (\`${UBUNTU_FILE}\`)\n`, []);
  const extra = extraPull(6, 'wendy', [], { changed_files: 0, body });
  extra.files = { 6: [] };
  const page = await on(UBUNTU_ROUTE, { variant: 'admin', extra, onWrite });
  page.handle().click();
  await settle();
  rowAct(page, 6, 'review-done').click();
  await settle();
  assert.deepEqual(writeLog(writes), [['PATCH', '/pulls/6']]);
});

/* main's data/graph/edit-access.json naming `editors` as editors of core-stack. */
const ACCESS_FILE = 'data/graph/edit-access.json';
const accessFor = (editors) => `${JSON.stringify({ note: 'test', projects: {
  'core-stack': { repos: 15, editors: editors.map((login) => ({ login, why: 'commits', repos_with_commits: 2 })), removed: [] } } }, null, 1)}\n`;
const CORE_ROUTE = '/projects/core-stack';
const CORE_FILE = 'content/projects/core-stack.md';
/* Proposal #7 by wendy: a paragraph added to the core-stack page; `ref` its branch (cms/… unless given). */
function coreEdit(ref) {
  const mainText = readRepo(CORE_FILE);
  const extra = extraPull(7, 'wendy', [CORE_FILE]);
  const head = extra.pulls[0].head.sha;
  if (ref) extra.pulls[0].head = Object.assign({}, extra.pulls[0].head, { ref });
  const at = C.splitBlocks(mainText).blocks.find((b) => b.kind === 'heading').end;
  extra.contents[head][CORE_FILE] = `${mainText.slice(0, at)}\nA paragraph wendy adds.\n${mainText.slice(at)}`;
  return extra;
}

test('U3 (D2, ED11): a project editor who is not an Admin sees the count, the row and the marks; off the list, nothing', async () => {
  const page = await on(CORE_ROUTE, { variant: 'push', extra: coreEdit(), files: { [ACCESS_FILE]: accessFor(['bob']) } });
  assert.equal(page.handle().hidden, false, 'the count shows');
  assert.ok(lastEditor(page).overlay.length > 0, 'the proposal\'s marks on its page');
  page.handle().click();
  await settle();
  assert.deepEqual(reviewRows(page).map((r) => r.attrs['data-pr']), ['7'], 'only the project proposal (PR #1 is setup pages: Admin only)');
  const off = await on(CORE_ROUTE, { variant: 'push', extra: coreEdit(), files: { [ACCESS_FILE]: accessFor(['someone-else']) } });
  assert.equal(off.handle().hidden, true, 'not an editor of core-stack: no count');
  assert.deepEqual([...lastEditor(off).overlay], [], 'and no marks');
});

test('U3 Approve (D3): a project editor who is not an Admin approves first, then it goes live', async () => {
  const writes = [];
  const onWrite = (method, url, body) => {
    writes.push({ method, url, body });
    return /\/merge$/.test(url) ? { status: 200, body: { merged: true, sha: 'f'.repeat(40) } } : { status: 200, body: { id: 1, state: 'APPROVED' } };
  };
  const page = await on(OTHER_ROUTE, { variant: 'maintain', extra: coreEdit('feature/core-words'), onWrite,
    files: { [ACCESS_FILE]: accessFor(['bob']) } });
  page.handle().click();
  await settle();
  assert.ok(rowAct(page, 7, 'review-approve'), 'reviewed whole (not a site-editor branch)');
  rowAct(page, 7, 'review-approve').click();       // its rules are not green yet: the first click explains
  await settle();
  assert.equal(writes.length, 0);
  rowAct(page, 7, 'review-approve').click();
  await settle();
  assert.deepEqual(writeLog(writes), [['POST', '/pulls/7/reviews'], ['PUT', '/pulls/7/merge']], 'the approval, then the merge');
});

test('U3 helpers.openReview: opens the review list (U2b\'s "N to review" row calls it)', async () => {
  const page = await on(OTHER_ROUTE, { variant: 'admin' });
  assert.equal(H(page).state().reviewOpen, false);
  H(page).openReview();
  await settle();
  assert.equal(H(page).state().reviewOpen, true);
  assert.ok(panelOf(page), 'the review panel is drawn');
  assert.equal(reviewRows(page).length, 1);
});

// ================================================================ fixes pass B (integrated review) ===

/* focus() on the fake elements records document.activeElement (restored after the test). */
function trackFocus(t, page) {
  const proto = Object.getPrototypeOf(page.body);
  const was = proto.focus;
  proto.focus = function focus() { page.win.document.activeElement = this; };
  t.after(() => { proto.focus = was; });
}
const focused = (page) => page.win.document.activeElement;

test('fix B3 (WCAG 2.4.3): a redraw of the review list keeps the focus on the same row', async (t) => {
  const page = await on(OTHER_ROUTE, { variant: 'admin', extra: wendyAdds() });
  trackFocus(t, page);
  page.handle().click();
  await settle();
  const before = page.one((e) => e.attrs && e.attrs['data-action'] === 'review-row' && e.attrs['data-pr'] === '3');
  before.focus();
  H(page).escapeTop.call(null);           // nothing open in the page: Escape closes the list ...
  page.handle().click();                  // ... and the row button opens it again
  await settle();
  assert.equal(focused(page), page.handle(), 'a closed list hands the focus to its row button');
  const again = page.one((e) => e.attrs && e.attrs['data-action'] === 'review-row' && e.attrs['data-pr'] === '3');
  again.focus();
  await page.send({ type: 'hc-ready' });  // any redraw of the bubble rebuilds the list
  const now = focused(page);
  assert.ok(now && now.attrs['data-action'] === 'review-row' && now.attrs['data-pr'] === '3', 'the same row has the focus');
  assert.ok(page.all((e) => e === now).length === 1, 'and it is on the page');
});

test('fix B3: "Approve anyway" keeps the focus across its arming click', async (t) => {
  const page = await on(OTHER_ROUTE, { variant: 'admin', extra: extraPull(5, 'wendy', ['data/projects/core-stack.json']) });
  trackFocus(t, page);
  page.handle().click();
  await settle();
  const first = rowAct(page, 5, 'review-approve');
  first.focus();
  first.click();
  await settle();
  const now = focused(page);
  assert.match(textOf(now), /Approve anyway/, 'the focus is on the armed button');
  assert.equal(now, rowAct(page, 5, 'review-approve'));
});

test('fix B8 (Nielsen #7): Decline asks once ("Decline wendy\'s send?" → "Yes, decline"); only the second click writes', async (t) => {
  const writes = [];
  const onWrite = (method, url, body) => { writes.push({ method, url, body }); return { status: 200, body: { state: 'closed' } }; };
  const page = await on(OTHER_ROUTE, { variant: 'admin', extra: extraPull(5, 'wendy', ['data/projects/core-stack.json']), onWrite });
  trackFocus(t, page);
  page.handle().click();
  await settle();
  rowAct(page, 5, 'review-decline').focus();
  rowAct(page, 5, 'review-decline').click();
  await settle();
  assert.deepEqual(writeLog(writes), [], 'the first click only asks');
  const ask = page.one((e) => e.classList.contains('hc-review-why'));
  assert.equal(textOf(ask), 'Decline wendy\'s send?');
  assert.equal(ask.attrs.role, 'alert');
  assert.equal(textOf(rowAct(page, 5, 'review-decline')), 'Yes, decline');
  assert.equal(focused(page), rowAct(page, 5, 'review-decline'), 'the focus stays on it');
  rowAct(page, 5, 'review-decline').click();
  await settle();
  assert.deepEqual(writeLog(writes), [['PATCH', '/pulls/5']]);
});

test('fix B8: Approve all asks once ("Approve all N changes?" → "Yes, approve all"); only the second click writes', async () => {
  const writes = [];
  const onWrite = (method, url, body) => { writes.push({ method, url, body }); return { status: 201, body: { id: 1 } }; };
  const page = await on(OTHER_ROUTE, { variant: 'admin', extra: wendyAdds(), onWrite });
  page.handle().click();
  await settle();
  rowAct(page, 3, 'review-approve-all').click();
  await settle();
  assert.deepEqual(writeLog(writes), [], 'the first click only asks');
  assert.match(textOf(page.one((e) => e.classList.contains('hc-review-why'))), /^Approve all 1 change\?$/);
  assert.equal(textOf(rowAct(page, 3, 'review-approve-all')), 'Yes, approve all');
  rowAct(page, 3, 'review-approve-all').click();
  await settle();
  assert.ok(writeLog(writes).length >= 1, `the second click writes the approval: ${JSON.stringify(writeLog(writes))}`);
});

test('fix B8 (WCAG 4.1.3): one live line per review list, its text swapped, not a new node per redraw', async () => {
  const page = await on(OTHER_ROUTE, { variant: 'admin', extra: extraPull(5, 'wendy', ['data/projects/core-stack.json']) });
  page.handle().click();
  await settle();
  rowAct(page, 5, 'review-approve').click();
  await settle();
  const a = page.one((e) => e.classList.contains('hc-review-why'));
  await page.send({ type: 'hc-ready' });
  const b = page.one((e) => e.classList.contains('hc-review-why'));
  assert.equal(a, b, 'the same node');
  rowAct(page, 5, 'review-decline').click();
  await settle();
  assert.equal(page.one((e) => e.classList.contains('hc-review-why')), a, 'another question, the same node');
  assert.equal(textOf(a), 'Decline wendy\'s send?');
});

test('fix B6 (Nielsen #3): the open review panel has ONE "N to review" header — the row button', async () => {
  const page = await on(OTHER_ROUTE, { variant: 'admin', extra: wendyAdds() });
  page.handle().click();
  await settle();
  assert.match(textOf(page.handle()), /^2 to review$/);
  assert.ok(!/to review/.test(textOf(panelOf(page))), `no second header in the panel: ${textOf(panelOf(page))}`);
  assert.ok(page.one((e) => e.attrs && e.attrs['data-action'] === 'review-close'), 'the list still closes');
});

test('fix B12 (WCAG 1.4.1): the status dot carries a glyph beside its colour', async () => {
  const page = await on(OTHER_ROUTE, { variant: 'admin' });
  page.handle().click();
  await settle();
  const dot = page.one((e) => e.classList.contains('hc-review-dot'));
  assert.ok(['✓', '✕', '…', '?'].indexOf(textOf(dot)) >= 0, textOf(dot));
  assert.ok(dot.attrs['aria-label'], 'and its words');
});

test('fix B9b (D22): a block the page changed since the send says so in plain words, as plain text', () => {
  const css = readRepo('css/editor.css');
  assert.ok(!/Update from main|main changed this/.test(css));
  assert.match(css, /\.hc-prop-conflict::before \{ content: "The page changed since this was sent\.";/);
});

test('fix B13 (D13, ED35): the frame\'s hc-scroll folds the open bubble past 24 px; hc-key escape closes the top layer', async () => {
  const page = await on(OTHER_ROUTE, { variant: 'admin' });
  const tucked = () => page.body.classList.contains('hc-dock-collapsed');
  assert.equal(tucked(), false);
  await page.send({ type: 'hc-scroll', y: 0 });
  await page.send({ type: 'hc-scroll', y: 10 });
  assert.equal(tucked(), false, '10 px: stays');
  await page.send({ type: 'hc-scroll', y: 'x' });
  await page.send({ type: 'hc-scroll', y: 80 });
  assert.equal(tucked(), true, 'past 24 px: folded');
  page.one((e) => e.classList.contains('hc-dock-tag')).click();
  await settle();
  page.handle().click();
  await settle();
  assert.equal(H(page).state().reviewOpen, true);
  await page.send({ type: 'hc-key', op: 'escape' });
  assert.equal(H(page).state().reviewOpen, false, 'Escape in the page closed the list');
});

test('fix B5 (Nielsen #2): a card whose block sits under the open bubble is drawn just below the bubble, not hidden', async () => {
  const page = await on(OTHER_ROUTE, { variant: 'admin' });
  const place = H(page).railPlace;
  assert.equal(typeof place, 'function');
  const bubbleBottom = 300;
  assert.equal(place({ top: 120, height: 40 }, bubbleBottom, 800, false), 300, 'under the bubble: just below it');
  assert.equal(place({ top: 120, height: 40 }, bubbleBottom, 800, true), 300, 'in below mode too');
  assert.equal(place({ top: 420, height: 40 }, bubbleBottom, 800, false), 420, 'below the bubble: on its line');
  assert.equal(place({ top: 420, height: 40 }, -Infinity, 800, true), 464, 'below mode: under its block');
  assert.equal(place({ top: -80, height: 40 }, bubbleBottom, 800, false), null, 'scrolled away above');
  assert.equal(place({ top: 900, height: 40 }, bubbleBottom, 800, false), null, 'not reached yet');
});

test('fix B12 (WCAG 2.1.1): Enter or Space on a focused note card opens it, as a click does', async () => {
  const mainText = readRepo(UBUNTU_FILE);
  const blocks = C.splitBlocks(mainText).blocks;
  const target = blocks.find((b) => b.kind === 'paragraph' || (b.kind !== 'space' && b.kind !== 'heading'));
  const key = await C.noteKey(UBUNTU_FILE, target.text, webcrypto.subtle);
  const body = C.notesSection.serialise(`Notes\n\nPages:\n- Ubuntu (\`${UBUNTU_FILE}\`)\n`, [{ key, text: 'Check this line.' }]);
  const extra = extraPull(6, 'wendy', [], { changed_files: 0, body });
  extra.files = { 6: [] };
  const page = await on(UBUNTU_ROUTE, { variant: 'admin', extra });
  page.handle().click();
  await settle();
  page.one((e) => e.attrs && e.attrs['data-action'] === 'review-row' && e.attrs['data-pr'] === '6').click();
  await settle();
  await page.send({ type: 'hc-ready' });
  const note = page.one((e) => e.classList.contains('hc-rnote'));
  const mark = page.one((e) => e.classList.contains('hc-rmark'));
  if (lastEditor(page).hot !== null) { mark.click(); await settle(); }    // the first note opens by itself: close it
  assert.equal(lastEditor(page).hot, null, 'nothing lit yet');
  for (const fn of note.listeners.keydown || []) fn({ type: 'keydown', key: 'Enter', target: note, preventDefault() {} });
  await settle();
  assert.equal(lastEditor(page).hot, blocks.indexOf(target), 'Enter opened the note (its block is lit)');
});

test('fix B12 (WCAG 8): the 400 ms guard on a fresh card stops a stray pointer click, never a keyboard press', () => {
  // the node harness draws no Approve card (no layout); the rule is read from the source: a keyboard press is a
  // click with detail 0, and the guard applies only to a pointer's click
  const src = readRepo('js/editor.js');
  const card = src.slice(src.indexOf('function cardNode(c)'), src.indexOf('function noteNode(x)'));
  assert.match(card, /if \(e\.detail !== 0 && Date\.now\(\) < Number\(card\.dataset\.armedAt \|\| 0\)\) return;/);
});
