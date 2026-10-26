// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 19 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test the Editor mode's parent side (js/editor.js) in a vm over a fake DOM and the fake GitHub.
/* js/editor.js runs in the site's own page once a session exists (plan D-C,
   D-D). These tests run it in a vm context standing in for index.html, with
   js/marked.min.js and js/cms-core.js loaded first (as index.html has them) and tools/tests/fake_github.js (the ONE route
   table the localhost walk uses too) as the network:

     - a session boot mounts the Editor switch and nothing else;
     - Editor on mounts the sandboxed frame at the current route, and the
       page's Markdown reaches it with this load's id-sentinels;
     - hc-ready is answered with hc-editor; hc-block-select puts that block's
       text in the tray; an edit replaces the SPAN, updates the draft and
       reloads the frame with a NEW nonce and `selected`, with zero network
       calls; an unclosed fence never touches the text outside the span;
     - hc-block-insert adds a snippet block and selects it;
     - hc-route syncs the hash with no reload; a parent navigation reloads;
     - a forged message (wrong source or nonce) is ignored;
     - ?editor=<tab> bootstraps Editor mode and is stripped; Editor off;
     - the tray: five tabs, the handle while closed, Proposals cards that
       expand in place and "Show on page", Changes (snippets, drafts with
       Propose… / Discard, registries, New forms), Media, View settings
       (localStorage), Guide, ?editor=…&pr= / data= / new=, and body.hc-phone;
     - /cms/ parity on content pages: "Start from: your proposal #n" -> "Add
       to proposal #n" (one commit on my branch, no new PR), and the
       github.com pencil link (Read-only's "View only … github.com" line);
     - /cms/ retired (U8): every row of the deleted test_cms_editor.mjs, and
       the js/cms.js rows of test_cms_core.mjs and test_cms_media.mjs, BY
       NAME — the cms-core-only rows verbatim in one block, the js/cms.js
       rows as "js/editor.js …" against Editor mode (the Review card, the
       session races, Media, Image / Photo from Media, New project / person,
       Propose); docs/cms-v2-plan.md's parity table names them all
       (tools/tests/test_parity_table.mjs).

   No browser, no network, and every token is an obvious placeholder.

     node --test tools/tests/test_editor.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto, createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const C = require(path.join(ROOT, 'js', 'cms-core.js'));
const { createFakeGitHub, MAIN_SHA } = require(path.join(ROOT, 'tools', 'tests', 'fake_github.js'));

const FIXTURES = path.join(ROOT, 'tools', 'tests', 'fixtures', 'github-data');
const readRepo = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const PAGE_ROUTE = '/setup/hippocampus-bringup/fcu-firmware';
const PAGE_FILE = 'content/setup/hippocampus-bringup/fcu-firmware.md';
const PAGE_TEXT = readRepo(PAGE_FILE);
const OTHER_ROUTE = '/setup/lab-gantry/usage';

import { FakeElement, findAll, memoryStorage, localFor, FakeFormData, tick, settle, openSite, TOKEN, ORIGIN } from './editor_harness.mjs';
/* U4b: the signed-in login's drafts, as the editor keeps them (localStorage, one store per login). */
const draftsOf = (page) => C.createDraftStore(page.local, C.draftsKey(page.login));

async function editorOn(opts) {
  const page = openSite(Object.assign({ hash: `#${PAGE_ROUTE}` }, opts));
  await settle();
  page.switchBtn().click();
  await settle();
  return page;
}

const blocksOf = (t) => C.splitBlocks(t).blocks;
const firstParagraph = (t) => blocksOf(t).findIndex((b) => b.kind === 'paragraph');

// ---------------------------------------------------------------- boot ---

test('a session boot mounts the Editor switch, off; no frame; GitHub asked only who and what role', async () => {
  const page = openSite({ hash: `#${PAGE_ROUTE}` });
  await settle();
  const sw = page.switchBtn();
  assert.ok(sw, 'the switch is in the header');
  assert.equal(sw.getAttribute('role'), 'switch');
  assert.equal(sw.getAttribute('aria-checked'), 'false');
  assert.equal(page.body.classList.contains('hc-editor-on'), false);
  assert.equal(page.frames().length, 0);
  assert.equal(page.host.hidden, true);
  assert.deepEqual(page.github().map((c) => c.url).sort(),
    ['https://api.github.com/repos/desert-mango/hippocampus-docs', 'https://api.github.com/user']);
});

test('no session: HCEditor.start mounts nothing and asks GitHub nothing', async () => {
  const page = openSite({ session: null });
  await settle();
  assert.equal(page.switchBtn(), undefined);
  assert.deepEqual(page.github(), []);
});

// ------------------------------------------------------------ Editor on ---

test('Editor on: the sandboxed frame at the current route; the page is served with THIS load\'s sentinels', async () => {
  const page = await editorOn();
  assert.equal(page.switchBtn().getAttribute('aria-checked'), 'true');
  assert.ok(page.body.classList.contains('hc-editor-on'));
  assert.equal(page.host.hidden, false);
  const frame = page.frame();
  assert.equal(frame.attrs.sandbox, 'allow-scripts allow-popups');
  assert.equal(frame.attrs.referrerpolicy, 'no-referrer');
  assert.match(frame.srcs[0], new RegExp(`^index\\.html#preview=[0-9a-f]{32}&route=${encodeURIComponent(PAGE_ROUTE)}$`));
  const nonce = page.nonce();
  const served = await page.asks(PAGE_FILE);
  assert.equal(served.ok, true);
  assert.equal(served.text, C.withSentinels(PAGE_TEXT, nonce.slice(0, 16)));
  assert.match(served.text, new RegExp(`<div id="hcb-${nonce.slice(0, 16)}-0"></div>`));
  const other = await page.asks('data/projects.json');
  assert.equal(other.text, readRepo('data/projects.json'), 'other files come plain, from main');
  const kept = JSON.parse(page.storage.getItem('hc-editor'));
  assert.equal(kept.on, true);
  for (const x of frame.posted) assert.ok(!JSON.stringify(x.m).includes(TOKEN), 'no token reaches the frame');
});

test('hc-ready is answered with hc-editor {nonce, on, settings, selected: null, overlay: []}', async () => {
  const page = await editorOn();
  await page.send({ type: 'hc-ready' });
  const [m] = page.editorMessages();
  assert.ok(m);
  assert.equal(m.nonce, page.nonce());
  assert.equal(m.on, true);
  assert.deepEqual({ ...m.settings }, { ...C.viewSettings });
  assert.equal(m.selected, null);
  assert.deepEqual([...m.overlay], []);
  assert.equal(page.frame().posted.find((x) => x.m.type === 'hc-editor').target, '*');
});

// ------------------------------------------------------ select and edit ---

test('reload cost (D-D): a counting fetch across two edits reads each path once', async () => {
  // U0b: the two edits are two inserted blocks (each reloads the frame; the tray's textarea is gone)
  const page = await editorOn();
  const i = firstParagraph(PAGE_TEXT);
  await page.asks(PAGE_FILE);
  await page.asks('data/projects.json');
  await page.send({ type: 'hc-block-insert', index: i, kind: 'note' });
  await page.asks(PAGE_FILE);
  await page.asks('data/projects.json');
  await page.send({ type: 'hc-block-insert', index: i, kind: 'warning' });
  await page.asks(PAGE_FILE);
  await page.asks('data/projects.json');
  const reads = page.github().filter((c) => /\/contents\//.test(c.url)).map((c) => c.url);
  // U2 fix round 1: a Writer's chip reads main's edit-access.json in Editor mode on every page, once
  assert.equal(reads.filter((u) => u.includes('/contents/data/graph/edit-access.json?')).length, 1, reads.join('\n'));
  assert.equal(reads.length, 3, reads.join('\n'));
  assert.equal(new Set(reads).size, 3);
  // main resolved once for the page's reads, and once by the edit-access read (accessRegistry pins main's head itself)
  assert.equal(page.github().filter((c) => /git\/ref\/heads\/main/.test(c.url)).length, 2, 'main resolved once per reader');
  assert.ok(reads.every((u) => u.includes(`ref=${MAIN_SHA}`)), 'read at the sha, never the branch name');
});

test('typing an unclosed fence never touches the text outside the span', async () => {
  const page = await editorOn();
  const i = firstParagraph(PAGE_TEXT);
  const b = blocksOf(PAGE_TEXT)[i];
  await page.pick(i);
  // U0b: typed in the page (hc-block-md), the one editor left
  await page.send({ type: 'hc-block-state', index: i, editor: 'visual', reason: '' });
  for (const typed of ['```', '```bash\n', '```bash\necho', '```bash\necho one\n<div class="adm adm-note">\n']) {
    await page.send({ type: 'hc-block-md', index: i, md: typed });
    const d = draftsOf(page).get('setup/hippocampus-bringup/fcu-firmware').files[PAGE_FILE];
    assert.equal(d.slice(0, b.start), PAGE_TEXT.slice(0, b.start), 'before the span: byte-identical');
    assert.equal(d.slice(b.start + typed.length), PAGE_TEXT.slice(b.end), 'after the span: byte-identical');
  }
});

// ------------------------------------------- typing in the page (editor redesign U2) ---

test('U2: a picked block goes to the frame as `open` {index, md, kind}: its Markdown from my draft, never HTML', async () => {
  const page = await editorOn();
  await page.send({ type: 'hc-ready' });
  const i = firstParagraph(PAGE_TEXT);
  await page.pick(i);
  const m = page.editorMessages().at(-1);
  assert.deepEqual({ ...m.open }, { index: i, md: blocksOf(PAGE_TEXT)[i].text, kind: 'paragraph', as: null });
});

test('U2: hc-block-md writes the block into the draft by its span: NO frame reload, same nonce, zero network', async () => {
  const page = await editorOn();
  await page.asks(PAGE_FILE);
  await page.send({ type: 'hc-ready' });
  const i = firstParagraph(PAGE_TEXT);
  const b = blocksOf(PAGE_TEXT)[i];
  await page.pick(i);
  await page.send({ type: 'hc-block-state', index: i, editor: 'visual', reason: '' });
  const srcs = page.frame().srcs.length;
  const nonce = page.nonce();
  const net = page.github().length;
  for (const typed of ['A changed paragraph.\n\n', 'A changed paragraph, typed on.\n\n']) {
    await page.send({ type: 'hc-block-md', index: i, md: typed });
    const d = draftsOf(page).get('setup/hippocampus-bringup/fcu-firmware').files[PAGE_FILE];
    assert.equal(d, PAGE_TEXT.slice(0, b.start) + typed + PAGE_TEXT.slice(b.end), 'the span replaced, nothing else');
  }
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(page.frame().srcs.length, srcs, 'the frame was never reloaded (the page cannot jump)');
  assert.equal(page.nonce(), nonce);
  assert.equal(page.github().length, net, 'no network call');
  assert.equal(page.editorMessages().at(-1).open.index, i, 'the block stays the open one');
});

test('U2: hc-block-md is dropped unless it names the open, in-page block in author mode', async () => {
  const page = await editorOn();
  const i = firstParagraph(PAGE_TEXT);
  const store = () => draftsOf(page).get('setup/hippocampus-bringup/fcu-firmware');
  await page.pick(i);
  await page.send({ type: 'hc-block-md', index: i, md: 'Before the frame said it is typing.\n\n' });
  assert.equal(store(), null, 'not open in the page yet: dropped');
  await page.send({ type: 'hc-block-state', index: i, editor: 'visual', reason: '' });
  await page.send({ type: 'hc-block-md', index: i + 1, md: 'Another block.\n\n' });
  await page.send({ type: 'hc-block-md', index: i, md: 'Forged.\n\n' }, { source: {} });
  await page.send({ type: 'hc-block-md', index: i, md: 'Another load.\n\n', nonce: 'another-nonce-123456' });
  await page.send({ type: 'hc-block-md', index: i, md: 'x'.repeat(200001) });
  assert.equal(store(), null, 'another block, another window, another load, over the cap: all dropped');
  await page.send({ type: 'hc-block-md', index: i, md: 'Accepted.\n\n' });
  assert.match(store().files[PAGE_FILE], /Accepted\./);
});

test('U2/U3: the frame cannot open the editor -> the whole page opens as Markdown on the thin editor page (U0b)', async () => {
  const page = await editorOn();
  await page.send({ type: 'hc-ready' });
  const i = firstParagraph(PAGE_TEXT);
  await page.pick(i);
  await page.send({ type: 'hc-block-state', index: i, editor: 'markdown', reason: 'the in-page editor could not load' });
  assert.equal(page.tray().hidden, false, 'the thin editor page');
  assert.equal(page.trayTitle(), 'Edit as Markdown');
  assert.equal(page.editorTextarea().value, PAGE_TEXT, 'the whole page');
});

test('U3: a note box Remove (an empty hc-block-md) takes the block out of the draft by its span', async () => {
  const page = await editorOn();
  await page.send({ type: 'hc-ready' });
  const i = firstParagraph(PAGE_TEXT);
  const b = blocksOf(PAGE_TEXT)[i];
  await page.pick(i);
  await page.send({ type: 'hc-block-state', index: i, editor: 'box', reason: '' });
  await page.send({ type: 'hc-block-md', index: i, md: '' });
  const d = draftsOf(page).get('setup/hippocampus-bringup/fcu-firmware').files[PAGE_FILE];
  assert.equal(d, PAGE_TEXT.slice(0, b.start) + PAGE_TEXT.slice(b.end));
});

test('U2: Escape in the frame (hc-block-state closed) deselects the block', async () => {
  const page = await editorOn();
  await page.send({ type: 'hc-ready' });
  const i = firstParagraph(PAGE_TEXT);
  await page.pick(i);
  await page.send({ type: 'hc-block-state', index: i, editor: 'visual', reason: '' });
  await page.send({ type: 'hc-block-state', index: i, editor: 'closed', reason: '' });
  const m = page.editorMessages().at(-1);
  assert.equal(m.selected, null);
  assert.equal(m.open, null);
});

// ------------------------------------------------ the dock (editor redesign U4a, D1 change 3) ---

test('U4a: the Editor switch and the avatar sit in the dock (top right since V1), never in the header', async () => {
  const page = openSite({ hash: `#${PAGE_ROUTE}` });
  await new Promise((r) => setImmediate(r));
  const dock = page.one((e) => e.classList.contains('hc-dock'));
  assert.ok(dock, 'the dock');
  assert.ok(findAll(dock, (e) => e.attrs['data-editor-switch'] !== undefined)[0], 'the switch is in it');
  assert.ok(findAll(dock, (e) => e.attrs['data-action'] === 'avatar')[0], 'and the avatar');
  assert.equal(findAll(page.header, (e) => e.classList.contains('hc-editor-controls')).length, 0, 'nothing in the header');
  assert.equal(page.one((e) => e.classList.contains('hc-dock-tag')).hidden, true, 'the tag is not in the tab order while the dock shows');
});

test('R2a (round 2): the bubble is balanced: photo, name with role and the Proposals link, then the switch; count and Send below', async () => {
  const page = await editorOn();
  await new Promise((r) => setImmediate(r));
  const dock = page.one((e) => e.classList.contains('hc-dock'));
  const order = findAll(dock, (e) => e.attrs['data-action'] === 'avatar' || e.attrs['data-editor-switch'] !== undefined
    || e.classList.contains('hc-login') || e.classList.contains('hc-role') || e.classList.contains('hc-dock-pages')
    || e.attrs['data-action'] === 'dock-collapse' || e.attrs['data-dock-count'] !== undefined || e.attrs['data-action'] === 'dock-send')
    .map((e) => e.attrs['data-action'] || (e.attrs['data-editor-switch'] !== undefined ? 'switch' : null)
      || (e.attrs['data-dock-count'] !== undefined ? 'count' : null) || e.className.split(' ')[0]);
  // U2 (plan D1): the pill is photo, role chip, switch, ×; the rows come below it, the review row ("N to review") last
  assert.deepEqual(order, ['avatar', 'hc-login', 'hc-role', 'switch', 'dock-collapse', 'dock-changes', 'dock-send', 'tray-open']);
  const id = page.one((e) => e.classList.contains('hc-id'));
  assert.ok(id, 'name and role chip sit together');
  const link = page.handle();
  assert.equal(findAll(id, (x) => x === link).length, 0, 'the review count is no longer under the name');
  // a Writer who approves no project has nothing to review: the row is not shown (test_editor_dock.mjs: the count)
  assert.equal(link.textContent, '0 to review');
  assert.equal(link.parent.hidden, true);
});

test('U4a: the dock counts this page\'s changes; Send for review is off until there is one (U0b: no Send box)', async () => {
  const page = await editorOn();
  await page.send({ type: 'hc-ready' });
  const count = () => page.one((e) => e.attrs['data-dock-count'] !== undefined).textContent;
  const send = () => page.action('dock-send');
  const i = firstParagraph(PAGE_TEXT);
  await page.pick(i);
  // U2 (ED7, ED45): nothing changed -> no count words and no Send for review; then the count is per page
  assert.equal(count(), '');
  assert.equal(send().disabled, true, 'nothing to send yet');
  assert.equal(send().hidden, true, 'and not shown');
  await page.send({ type: 'hc-block-state', index: i, editor: 'visual', reason: '' });
  await page.send({ type: 'hc-block-md', index: i, md: 'A changed paragraph.\n\n' });
  assert.equal(count(), '1 page changed');
  assert.equal(send().disabled, false);
  // the click sends at once (tools/tests/test_editor_u0b.mjs follows it to GitHub): no box opens
  assert.equal(page.created.filter((e) => e.classList.contains('hc-sendbox')).length, 0, 'no Send box');
});

test('U4a: x tucks the dock into a tag on the right edge, remembered in this browser; the tag brings it back', async () => {
  const local = memoryStorage();
  const page = openSite({ hash: `#${PAGE_ROUTE}`, localStorage: local });
  await new Promise((r) => setImmediate(r));
  page.action('dock-collapse').click();
  assert.ok(page.body.classList.contains('hc-dock-collapsed'));
  assert.equal(page.one((e) => e.classList.contains('hc-dock-tag')).hidden, false, 'the tag shows while tucked away');
  assert.equal(page.one((e) => e.classList.contains('hc-dock')).getAttribute('inert'), '', 'the tucked dock is inert (out of the tab order)');
  assert.equal(local.getItem('hc-editor-dock'), 'collapsed');
  const again = openSite({ hash: `#${PAGE_ROUTE}`, localStorage: local });
  await new Promise((r) => setImmediate(r));
  assert.ok(again.body.classList.contains('hc-dock-collapsed'), 'still tucked away after a reload');
  again.action('dock-expand').click();
  assert.equal(again.body.classList.contains('hc-dock-collapsed'), false);
  assert.equal(local.getItem('hc-editor-dock'), 'open');
});

test('hc-block-insert puts the snippet at that boundary, as its own block, and selects it', async () => {
  const page = await editorOn();
  const i = firstParagraph(PAGE_TEXT);
  await page.send({ type: 'hc-block-insert', index: i, kind: 'note' });
  assert.equal(page.tray().hidden, true, 'V2: the new block opens in the page, nothing else opens');
  const d = draftsOf(page).get('setup/hippocampus-bringup/fcu-firmware').files[PAGE_FILE];
  const want = C.insertAt(PAGE_TEXT, i, 'note');
  assert.equal(d, want.text);
  await page.send({ type: 'hc-ready' });
  const m = page.editorMessages().at(-1);
  const sel = m.selected;
  assert.equal(blocksOf(want.text)[sel].start, want.span.start, 'the new block is the selected one');
  assert.equal(m.open.md, want.text.slice(want.span.start, want.span.end), 'and opens in the page with its Markdown');
  // an unknown kind or an index past the end changes nothing
  await page.send({ type: 'hc-block-insert', index: i, kind: 'script' });
  await page.send({ type: 'hc-block-insert', index: 99999, kind: 'note' });
  assert.equal(draftsOf(page).get('setup/hippocampus-bringup/fcu-firmware').files[PAGE_FILE], want.text);
});

test('a page the block model refuses (CRLF) opens whole as Markdown on the thin editor page, with the reason (U0b)', async () => {
  const crlf = PAGE_TEXT.replace(/\n/g, '\r\n');
  const page = await editorOn({ files: { [PAGE_FILE]: crlf } });
  const served = await page.asks(PAGE_FILE);
  assert.equal(served.text, crlf, 'no sentinels on a page the split refuses');
  await page.pick(0);
  const notice = page.one((e) => e.classList.contains('hc-notice'));
  assert.match(notice.textContent, new RegExp(C.splitBlocks(crlf).reason.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(page.tray().hidden, false);
  assert.equal(page.trayTitle(), 'Edit as Markdown');
  assert.equal(page.editorTextarea().value, crlf);
});

test('read-only role: a picked block is shown read-only, and "+" inserts nothing', async () => {
  const page = await editorOn({ variant: 'readonly' });
  const i = firstParagraph(PAGE_TEXT);
  await page.send({ type: 'hc-ready' });
  await page.pick(i);
  assert.equal(page.editorMessages().at(-1).open, null, 'nothing opens for typing');
  await page.typeIn(i, 'Typed by a reader.\n\n');
  await page.send({ type: 'hc-block-insert', index: i, kind: 'note' });
  assert.equal(draftsOf(page).list().length, 0);
});

// ------------------------------------------------------- routes, forgery ---

test('hc-route syncs the hash without a reload; a parent navigation reloads the frame there', async () => {
  const page = await editorOn();
  const srcs = page.frame().srcs.length;
  await page.send({ type: 'hc-route', route: OTHER_ROUTE });
  assert.equal(page.location.hash, `#${OTHER_ROUTE}`);
  for (const fn of page.listeners.hashchange || []) fn();
  await settle();
  assert.equal(page.frame().srcs.length, srcs, 'no reload for the frame\'s own navigation');
  // the frame now shows the other page: its file gets the sentinels
  const served = await page.asks('content/setup/lab-gantry/usage.md');
  assert.equal(served.text, C.withSentinels(readRepo('content/setup/lab-gantry/usage.md'), page.nonce().slice(0, 16)));
  await page.go('#/about');
  assert.equal(page.frame().srcs.length, srcs + 1);
  assert.match(page.frame().srcs.at(-1), /&route=%2Fabout$/);
});

test('a forged message — another window, or another nonce — is ignored', async () => {
  const page = await editorOn();
  const i = firstParagraph(PAGE_TEXT);
  await page.send({ type: 'hc-route', route: '/about' }, { source: { postMessage() {} } });
  await page.send({ type: 'hc-route', route: '/about', nonce: 'f'.repeat(32) });
  assert.equal(page.location.hash, `#${PAGE_ROUTE}`);
  await page.send({ type: 'hc-block-select', index: i, nonce: 'f'.repeat(32) });
  await page.send({ type: 'hc-block-insert', index: i, kind: 'note' }, { source: { postMessage() {} } });
  assert.equal(draftsOf(page).list().length, 0);
  await page.send({ type: 'hc-ready', nonce: 'f'.repeat(32) });
  assert.equal(page.editorMessages().length, 0);
  await page.send({ type: 'hc-ready' });
  assert.equal(page.editorMessages().at(-1).selected, null, 'the forged pick selected nothing');
});

test('the frame hears hc-editor only after the CURRENT load\'s hc-ready; never before, never after a reload alone', async () => {
  const page = await editorOn();
  const i = firstParagraph(PAGE_TEXT);
  await page.pick(i);
  assert.equal(page.editorMessages().length, 0, 'no hc-editor before this load said hc-ready');
  await page.send({ type: 'hc-ready' });
  assert.equal(page.editorMessages().length, 1, 'hc-ready is answered once');
  assert.equal(page.editorMessages()[0].selected, i, 'with the state held back meanwhile');
  // an edit reloads the frame: the new load is not ready until it says so (U0b: an inserted block)
  const old = page.nonce();
  await page.send({ type: 'hc-block-insert', index: i, kind: 'note' });
  assert.notEqual(page.nonce(), old, 'the frame reloaded');
  const before = page.frame().posted.filter((x) => x.m.type === 'hc-editor').length;
  await page.pick(i);
  await page.send({ type: 'hc-ready', nonce: old });
  assert.equal(page.frame().posted.filter((x) => x.m.type === 'hc-editor').length, before,
    'nothing reaches the reloaded frame on the old load\'s ready or before its own');
  await page.send({ type: 'hc-ready' });
  const after = page.frame().posted.filter((x) => x.m.type === 'hc-editor');
  assert.equal(after.length, before + 1);
  assert.equal(after.at(-1).m.nonce, page.nonce(), 'the post carries the new load\'s nonce');
});

// ------------------------------------------------------- state and off ---

test('?editor=<tab> turns Editor mode on and is stripped from the address', async () => {
  const page = openSite({ hash: '#/about?editor=changes' });
  await settle();
  assert.ok(page.body.classList.contains('hc-editor-on'));
  assert.equal(page.location.hash, '#/about');
  assert.deepEqual(page.replaced, ['/#/about']);
  assert.match(page.frame().srcs[0], /&route=%2Fabout$/);
  // round 2 (R3): "Edit this page" is Editor mode on the page itself; no editor page opens
  assert.deepEqual(JSON.parse(page.storage.getItem('hc-editor')), { on: true, tray: false, hash: '#/' });
});

test('Editor on survives a reload of the tab (sessionStorage hc-editor); Editor off takes the frame away', async () => {
  const storage = memoryStorage();
  storage.setItem('hc-editor', JSON.stringify({ on: true, tab: 'changes' }));
  const page = openSite({ hash: `#${PAGE_ROUTE}`, storage });
  await settle();
  assert.ok(page.body.classList.contains('hc-editor-on'));
  assert.equal(page.frames().length, 1);
  page.switchBtn().click();
  await settle();
  assert.equal(page.body.classList.contains('hc-editor-on'), false);
  assert.equal(page.host.hidden, true);
  assert.equal(page.frames().length, 0);
  assert.equal(JSON.parse(storage.getItem('hc-editor')).on, false);
  await page.go('#/about');
  assert.equal(page.frames().length, 0, 'no frame while Editor is off');
});

// ------------------------------------------------------------- the tray ---
/* Milestone 3: the tray is today's /cms/ views in a side panel (a bottom
   sheet on phones) with five tabs, and a handle while it is closed. */

const UBUNTU_ROUTE = '/setup/raspberry-pi/ubuntu-24-04-server';
const UBUNTU_FILE = 'content/setup/raspberry-pi/ubuntu-24-04-server.md';
const fixtureText = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
test('the thin editor page (U0b): the account menu\'s Data files opens it; Back to the page and Escape close it; kept for the tab', async () => {
  const page = await editorOn();
  await page.dataFiles();
  assert.equal(page.tray().hidden, false);
  assert.ok(page.body.classList.contains('hc-tray-open'));
  assert.equal(page.trayTitle(), 'Data files');
  assert.equal(JSON.parse(page.storage.getItem('hc-editor')).tray, true);
  assert.equal(JSON.parse(page.storage.getItem('hc-editor')).hash, '#/edit');
  assert.equal(page.action('tray-close').textContent, 'Back to the page');
  page.action('tray-close').click();
  await settle();
  assert.equal(page.tray().hidden, true);
  assert.equal(page.body.classList.contains('hc-tray-open'), false);
  assert.equal(page.handle().hidden, false, 'the button stays in the bubble');
  assert.equal(JSON.parse(page.storage.getItem('hc-editor')).tray, false);
  await page.dataFiles();
  assert.equal(page.tray().hidden, false);
  for (const fn of page.docListeners('keydown')) fn({ key: 'Escape', defaultPrevented: false });
  await settle();
  assert.equal(page.tray().hidden, true, 'Escape goes back to the page');
  // Editor off hides both
  page.switchBtn().click();
  await settle();
  assert.equal(page.handle().hidden, true);
  assert.equal(page.tray().hidden, true);
});

test('editor page (V2): picking a block opens nothing (it is typed in the page)', async () => {
  const page = await editorOn();
  await page.send({ type: 'hc-ready' });
  await page.send({ type: 'hc-block-select', index: firstParagraph(PAGE_TEXT) });
  assert.equal(page.tray().hidden, true, 'no panel slides in');
  assert.equal(page.editorMessages().at(-1).open.index, firstParagraph(PAGE_TEXT), 'the frame is told to open it');
});

test('the thin editor page\'s snippet bar (the catalog; no image chooser since U0b) inserts at the cursor of the whole page', async () => {
  const page = await editorOn();
  await page.wholePage();
  const kinds = page.all((e) => e.attrs['data-snippet'] !== undefined).map((e) => e.attrs['data-snippet']);
  assert.deepEqual(kinds, Object.keys(C.SNIPPET_CATALOG).filter((k) => !C.SNIPPET_CATALOG[k].media));
  assert.equal(page.one((e) => e.attrs['data-action'] === 'media-open'), undefined, 'no "Image from Media" (U0b)');
  const ta = page.editorTextarea();
  ta.selectionStart = 0;
  ta.selectionEnd = 0;
  page.one((e) => e.attrs['data-snippet'] === 'note').click();
  await settle();
  const want = C.insertSnippet(PAGE_TEXT, 0, 0, 'note');
  assert.equal(ta.value, want.text);
  assert.equal(draftsOf(page).get('setup/hippocampus-bringup/fcu-firmware').files[PAGE_FILE], want.text);
});

test('the thin editor page: Discard changes drops the page\'s draft and reloads the frame (U0b: the draft list went with the Changes tab)', async () => {
  const page = await editorOn();
  const i = firstParagraph(PAGE_TEXT);
  await page.pick(i);
  await page.typeIn(i, 'Changed.\n\n');
  assert.ok(draftsOf(page).get('setup/hippocampus-bringup/fcu-firmware'), 'the draft is kept');
  await page.wholePage();
  assert.match(page.editorTextarea().value, /^Changed\.$/m, 'the whole page shows the same draft');
  assert.equal(page.action('propose').disabled, false, 'Send for review is on');
  const srcs = page.frame().srcs.length;
  page.action('discard').click();
  await settle();
  assert.equal(draftsOf(page).list().length, 0);
  assert.equal(page.frame().srcs.length, srcs + 1);
  const served = await page.asks(PAGE_FILE);
  assert.equal(served.text, C.withSentinels(PAGE_TEXT, page.nonce().slice(0, 16)));
});

test('Data files: the four registries as raw JSON (locked-ids line)', async () => {
  const page = await editorOn();
  await page.dataFiles();
  for (const f of C.RAW_REGISTRIES) assert.ok(page.linkTo(`#/edit/${f.slice(0, -5)}`), f);
  await page.follow(page.linkTo('#/edit/data/people'));
  assert.equal(page.trayTitle(), 'Data files');
  assert.ok(page.one((e) => e.attrs['data-locked'] !== undefined), 'the locked-ids line');
  assert.equal(page.editorTextarea().value, readRepo('data/people.json'));
  await page.follow(page.linkTo('#/edit'));      // "← Data files"
  assert.ok(page.linkTo('#/edit/data/people'), 'back on the list');
});

// --------------------------------------- /cms/ parity on content pages ---
/* The two /cms/ actions a content page needed in Editor mode too: "Start
   from: your proposal #n" (one more commit on my own proposal's branch) and
   the github.com pencil link (Read-only's one way to propose). */

const PAGE_ID = 'setup/hippocampus-bringup/fcu-firmware';
const REPO_API = 'https://api.github.com/repos/desert-mango/hippocampus-docs';
const OWN = 'cms/bob/fix-typo-260920';
const HEAD_B = '3'.repeat(40);
const TREE_B = '4'.repeat(40);

/* Every write answered the way GitHub does (fresh shas), and recorded. */
function recordWrites() {
  const writes = [];
  let k = 0;
  const next = () => (k += 1).toString(16).padStart(40, 'a');
  const onWrite = (method, url, body) => {
    writes.push({ method, url, body });
    const rest = url.slice(REPO_API.length);
    if (method === 'POST' && ['/git/blobs', '/git/trees', '/git/commits'].indexOf(rest) >= 0) return { status: 201, body: { sha: next() } };
    if (method === 'POST' && rest === '/git/refs') return { status: 201, body: { ref: body.ref, object: { sha: body.sha } } };
    if (method === 'PATCH' && rest.startsWith('/git/refs/heads/')) return { status: 200, body: { object: { sha: body.sha } } };
    if (method === 'POST' && rest === '/pulls') return { status: 201, body: { number: 42 } };
    if (method === 'PATCH' && /^\/pulls\/[0-9]+$/.test(rest)) return { status: 200, body: { number: Number(rest.slice(7)) } };
    return { status: 500, body: { message: `unexpected ${method} ${rest}` } };
  };
  return { writes, onWrite };
}

test('js/editor.js Propose: starting from my own proposal adds one commit and moves its branch — no new PR', async () => {
  const onBranch = `${PAGE_TEXT}More.\n`;
  const extra = {
    pulls: [{ number: 7, title: 'Fix typo', state: 'open', user: { login: 'bob' }, created_at: '2026-09-20T10:00:00Z',
      head: { ref: OWN, sha: HEAD_B, repo: { full_name: 'desert-mango/hippocampus-docs' } }, base: { ref: 'main' } }],
    files: { 7: [{ filename: PAGE_FILE, status: 'modified' }] },
    contents: { [HEAD_B]: { [PAGE_FILE]: onBranch } },
    compare: { [HEAD_B]: MAIN_SHA },
    trees: { [HEAD_B]: TREE_B },
  };
  const { writes, onWrite } = recordWrites();
  // textEncoder: the page then draws my proposal #7, whose review rail hashes its keys; without one it says so on
  // the outcome line and overwrites it
  const page = await editorOn({ extra, onWrite, textEncoder: true });
  await page.wholePage();          // U0b: "Start from" is on the thin editor page (the Changes tab is gone)
  assert.ok(page.linkTo(C.pencilUrl(PAGE_FILE)), 'the pencil link, for Write too');
  const pick = page.one((e) => e.tagName === 'SELECT' && e.attrs['data-base'] !== undefined);
  assert.ok(pick, 'a base picker when I have an open proposal');
  pick.value = '7';
  pick.fire('change');
  await settle();
  assert.equal(page.editorTextarea().value, onBranch, 'the text at my proposal\'s head');
  await page.type(page.editorTextarea(), `${onBranch}Even more.\n`);
  const d = draftsOf(page).get(PAGE_ID);
  assert.deepEqual({ ...d.base }, { ref: OWN, sha: HEAD_B, number: 7 }, 'the draft keeps its base');
  assert.equal((await page.asks(PAGE_FILE)).text, C.withSentinels(`${onBranch}Even more.\n`, page.nonce().slice(0, 16)),
    'the page shows the draft on my proposal\'s head');
  page.action('propose').click();
  await settle();
  const repoWrites = writes.filter((c) => c.url.startsWith(REPO_API));
  assert.deepEqual(repoWrites.map((c) => `${c.method} ${c.url.slice(REPO_API.length)}`),
    ['POST /git/blobs', 'POST /git/trees', 'POST /git/commits', `PATCH /git/refs/heads/${OWN}`]);
  assert.equal(repoWrites[0].body.content, `${onBranch}Even more.\n`);
  assert.equal(repoWrites[1].body.base_tree, TREE_B);
  assert.equal(repoWrites[2].body.parents[0], HEAD_B, 'one commit on my proposal\'s head');
  const notice = page.one((e) => e.classList.contains('hc-notice'));
  assert.ok(notice, 'an outcome line');
  assert.match(notice.textContent, /Added to your proposal #7/, 'the user is told where the edit went');
  assert.equal(draftsOf(page).get(PAGE_ID), null, 'the draft went into the proposal');
});

test('Start from my proposal: a link inside the frame to another page reloads it there at main; back again, the draft is on my proposal', async () => {
  const onBranch = `${PAGE_TEXT}More.\n`;
  const extra = {
    pulls: [{ number: 7, title: 'Fix typo', state: 'open', user: { login: 'bob' }, created_at: '2026-09-20T10:00:00Z',
      head: { ref: OWN, sha: HEAD_B, repo: { full_name: 'desert-mango/hippocampus-docs' } }, base: { ref: 'main' } }],
    files: { 7: [] },
    contents: { [HEAD_B]: { [PAGE_FILE]: onBranch } },
  };
  const page = await editorOn({ extra });
  await page.wholePage();
  const pick = page.one((e) => e.tagName === 'SELECT' && e.attrs['data-base'] !== undefined);
  pick.value = '7';
  pick.fire('change');
  await settle();
  assert.match(page.tray().textContent, /Building on your proposal #7\./);
  await page.type(page.editorTextarea(), `${onBranch}Even more.\n`);
  page.action('tray-close').click();
  await settle();
  const srcs = page.frame().srcs.length;
  await page.send({ type: 'hc-route', route: OTHER_ROUTE });
  for (const fn of page.listeners.hashchange || []) fn();
  await settle();
  assert.equal(page.frame().srcs.length, srcs + 1, 'the frame read that page at my proposal\'s head: reloaded at main');
  const other = 'content/setup/lab-gantry/usage.md';
  assert.equal((await page.asks(other)).text, C.withSentinels(readRepo(other), page.nonce().slice(0, 16)));
  await page.go(`#${PAGE_ROUTE}`);
  assert.equal((await page.asks(PAGE_FILE)).text, C.withSentinels(`${onBranch}Even more.\n`, page.nonce().slice(0, 16)),
    'my draft, on my proposal\'s head');
});

test('js/editor.js editor: Read-only sees the page and its preview, view-only, with the pencil link', async () => {
  const page = await editorOn({ variant: 'readonly' });
  await page.wholePage();          // U0b: the page as Markdown on the thin editor page
  const pencil = () => page.all((e) => e.tagName === 'A' && e.attrs.href === C.pencilUrl(PAGE_FILE));
  const viewOnly = page.one((e) => e.tagName === 'P' && /^View only: /.test(e.textContent));
  assert.ok(viewOnly, 'the view-only line');
  assert.match(viewOnly.textContent, /You can still propose a change on github\.com/);
  const a = findAll(viewOnly, (e) => e.tagName === 'A')[0];
  assert.equal(a.attrs.href, C.pencilUrl(PAGE_FILE), 'it carries the pencil link');
  assert.equal(a.attrs.target, '_blank');
  assert.equal(a.attrs.rel, 'noopener noreferrer');
  const ta = page.editorTextarea();
  assert.equal(ta.readOnly, true);
  assert.equal(page.action('propose'), undefined);
  assert.equal(page.one((e) => e.attrs['data-snippet'] === 'note'), undefined);
  assert.equal(page.one((e) => e.attrs['data-base'] !== undefined), undefined, 'no base picker');
  assert.ok(pencil().length, 'the pencil link');
  assert.equal(page.frames().length, 1);
  assert.equal((await page.asks(PAGE_FILE)).text, C.withSentinels(PAGE_TEXT, page.nonce().slice(0, 16)),
    'the page still shows main');
});

/* My open proposal #7 (bob's), its head HEAD_B holding `onBranch` for the
   page; `files` is what it changes. */
function ownSeven(onBranch, files) {
  return {
    pulls: [{ number: 7, title: 'Fix typo', state: 'open', user: { login: 'bob' }, created_at: '2026-09-20T10:00:00Z',
      head: { ref: OWN, sha: HEAD_B, repo: { full_name: 'desert-mango/hippocampus-docs' } }, base: { ref: 'main' } }],
    files: { 7: files },
    contents: { [HEAD_B]: { [PAGE_FILE]: onBranch } },
    compare: { [HEAD_B]: MAIN_SHA },
    trees: { [HEAD_B]: TREE_B },
  };
}

test('a stored draft naming a proposal that is not my own open one is shown on main, and that branch is never read', async () => {
  const ALICE = 'cms/alice/her-change-260921';
  const HEAD_A = '5'.repeat(40);
  const extra = {
    pulls: [{ number: 9, title: 'Hers', state: 'open', user: { login: 'alice' }, created_at: '2026-09-21T10:00:00Z',
      head: { ref: ALICE, sha: HEAD_A, repo: { full_name: 'desert-mango/hippocampus-docs' } }, base: { ref: 'main' } }],
    files: { 9: [] },
    contents: { [HEAD_A]: { [PAGE_FILE]: 'Her text.\n' } },
  };
  const storage = memoryStorage();
  C.createDraftStore(storage).put({ key: PAGE_ID, label: 'FCU firmware', route: PAGE_ROUTE,
    files: { [PAGE_FILE]: 'Tampered.\n' }, originals: { [PAGE_FILE]: 'Her text.\n' },
    base: { ref: ALICE, sha: HEAD_A, number: 9 } });
  const page = await editorOn({ extra, storage });
  assert.equal((await page.asks(PAGE_FILE)).text, C.withSentinels(PAGE_TEXT, page.nonce().slice(0, 16)),
    'the page on main');
  assert.deepEqual(page.calls.filter((c) => c.url.indexOf(HEAD_A) >= 0 || c.url.indexOf(ALICE) >= 0), [],
    'zero reads of that branch');
});

test('a link inside the frame to a page whose stored draft says #7 on another branch reloads it there: main, and the notice', async () => {
  const onBranch = `${PAGE_TEXT}More.\n`;
  const OTHER_ID = 'setup/lab-gantry/usage';
  const OTHER_FILE = 'content/setup/lab-gantry/usage.md';
  const STRAY = 'cms/mallory/same-number-260922';
  const HEAD_S = '6'.repeat(40);
  const MOTOR_ID = 'setup/hippocampus-bringup/motor-configuration';
  const MOTOR_FILE = `content/${MOTOR_ID}.md`;
  const storage = memoryStorage();
  const store = C.createDraftStore(storage);
  store.put({ key: OTHER_ID, label: 'Usage', route: OTHER_ROUTE,
    files: { [OTHER_FILE]: 'Stray.\n' }, originals: { [OTHER_FILE]: readRepo(OTHER_FILE) },
    base: { ref: STRAY, sha: HEAD_S, number: 7 } });
  store.put({ key: MOTOR_ID, label: 'Motor configuration', route: `/${MOTOR_ID}`,
    files: { [MOTOR_FILE]: 'Mine on seven.\n' }, originals: { [MOTOR_FILE]: readRepo(MOTOR_FILE) },
    base: { ref: OWN, sha: HEAD_B, number: 7 } });
  // U0b: this page's draft is on my own #7 from the start (the Changes tab's in-page "Start from" is gone)
  store.put({ key: PAGE_ID, label: 'FCU firmware', route: PAGE_ROUTE,
    files: { [PAGE_FILE]: `${onBranch}Mine.\n` }, originals: { [PAGE_FILE]: onBranch },
    base: { ref: OWN, sha: HEAD_B, number: 7 } });
  const page = await editorOn({ extra: ownSeven(onBranch, []), storage });
  assert.equal((await page.asks(PAGE_FILE)).text, C.withSentinels(`${onBranch}Mine.\n`, page.nonce().slice(0, 16)),
    'on my own #7');
  const srcs = page.frame().srcs.length;
  // first to a page whose draft is on my own #7 (number and branch): the frame already reads there
  await page.send({ type: 'hc-route', route: `/${MOTOR_ID}` });
  for (const fn of page.listeners.hashchange || []) fn();
  await settle();
  assert.equal(page.frame().srcs.length, srcs, 'the same proposal: no reload');
  await page.send({ type: 'hc-route', route: OTHER_ROUTE });
  for (const fn of page.listeners.hashchange || []) fn();
  await settle();
  assert.equal(page.frame().srcs.length, srcs + 1, 'same number, another branch: the frame reloads there');
  assert.equal((await page.asks(OTHER_FILE)).text, C.withSentinels(readRepo(OTHER_FILE), page.nonce().slice(0, 16)),
    'the page on main, not at my proposal\'s head');
  assert.deepEqual(page.calls.filter((c) => c.url.indexOf(HEAD_S) >= 0 || c.url.indexOf(STRAY) >= 0), [],
    'zero reads of that branch');
});

test('fake GitHub: /api/media list answers from the manifest; its other actions take no writes', async () => {
  const manifest = JSON.parse(readRepo('data/cloudinary-manifest.json'));
  const fake = createFakeGitHub({ readFixture: async () => null, readFile: async (p) => readRepo(p) });
  const list = await fake.fetch('/api/media', { method: 'POST', body: JSON.stringify({ action: 'list' }) });
  assert.equal(list.status, 200);
  const data = await list.json();
  assert.equal(data.next_cursor, null);
  const assets = Object.values(manifest.assets);
  assert.equal(data.assets.length, Math.min(assets.length, 24));
  assert.deepEqual(Object.keys(data.assets[0]).sort(), ['bytes', 'created_at', 'format', 'height', 'public_id', 'url', 'width']);
  assert.equal(data.assets[0].public_id, assets[0].public_id);
  assert.equal(data.assets[0].url, assets[0].url);
  for (const action of ['sign', 'destroy', 'rename']) {
    const r = await fake.fetch('/api/media', { method: 'POST', body: JSON.stringify({ action }) });
    assert.equal(r.status, 405, action);
  }
  assert.equal(fake.calls.filter((c) => c.url === '/api/media').length, 4);
});

test('phone: body.hc-phone follows the (max-width: 767px) query', async () => {
  const page = await editorOn({ phone: true });
  assert.equal(page.mql.media, '(max-width: 767px)');
  assert.ok(page.body.classList.contains('hc-phone'));
  page.mql.matches = false;
  page.mql.handlers.forEach((fn) => fn({ matches: false }));
  assert.equal(page.body.classList.contains('hc-phone'), false);
});

// ------------------------------------------------------------ sign-in ---
/* The footer's "Sign in to edit" (js/app.js, D-C) opens the GitHub window in
   the click, injects this file, and calls HCEditor.start({popup}) with no
   session: the editor's sign-in adopts THAT window. */

const answer = (status, body) => ({ ok: status >= 200 && status < 300, status,
  headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body });

function popupWindow() {
  return { closed: false, closes: 0, location: { href: 'about:blank' },
    close() { this.closed = true; this.closes += 1; } };
}

// /api/auth as the Vercel function answers it: the App's client id, then a token for the code
function authServer(log) {
  return (url, init) => {
    if (url.indexOf('/api/auth') !== 0) return null;
    log.push({ url, method: init.method || 'GET', body: init.body });
    if ((init.method || 'GET') === 'GET') return answer(200, { client_id: 'Iv1.placeholder' });
    return answer(200, { token: TOKEN, expires_in: 28800 });
  };
}

// U4a: the controls live in the dock (bottom right), no longer in the header
const controlsOf = (page) => findAll(page.body, (c) => c.classList.contains('hc-editor-controls'))[0];
const stateOf = (popup) => new URL(popup.location.href).searchParams.get('state');

test('sign-in click path: start({popup}) with no session adopts that window, mounts nothing visible, opens none', async () => {
  const popup = popupWindow();
  const page = openSite({ session: null, hash: `#${PAGE_ROUTE}`, start: { popup } });
  await settle();
  assert.equal(page.started, true);
  assert.deepEqual(page.opens, [], 'window.open is never called: the click already opened the window');
  const auth = page.calls.filter((c) => c.url.indexOf('/api/auth') === 0);
  assert.deepEqual(auth.map((c) => c.method), ['GET'], 'the sign-in asked this site for the App\'s client id');
  // the fake has no server functions: the adopted window closes and the footer says why
  assert.equal(popup.closes, 1);
  assert.match(page.told.at(-1).text, /server functions/);
  assert.equal(page.told.at(-1).kind, 'error');
  const controls = controlsOf(page);
  assert.equal(controls.hidden, true, 'no switch before a sign-in');
  assert.deepEqual(page.github(), [], 'no GitHub API call without a token');
});

test('sign-in completes: the adopted window goes to GitHub; its hc-code ends in a stored session, the switch, Editor on', async () => {
  const popup = popupWindow();
  const log = [];
  const page = openSite({ session: null, hash: `#${PAGE_ROUTE}`, start: { popup }, intercept: authServer(log) });
  await settle();
  assert.match(popup.location.href, /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
  assert.equal(new URL(popup.location.href).searchParams.get('redirect_uri'), `${ORIGIN}/cms/callback.html`);
  assert.match(page.told.at(-1).text, /Finish signing in/);
  const state = stateOf(popup);
  const deliver = async (source, origin, data) => {
    for (const fn of page.listeners.message || []) fn({ source, origin, data });
    await settle();
  };
  // forged: another window, another origin, a wrong state — each ignored
  await deliver({}, ORIGIN, { type: 'hc-code', code: 'c0de', state });
  await deliver(popup, 'https://evil.example', { type: 'hc-code', code: 'c0de', state });
  await deliver(popup, ORIGIN, { type: 'hc-code', code: 'c0de', state: `${state}x` });
  assert.equal(log.filter((x) => x.method === 'POST').length, 0);
  assert.equal(page.storage.getItem(C.SESSION_KEY), null);
  await deliver(popup, ORIGIN, { type: 'hc-code', code: 'c0de', state });
  assert.equal(log.filter((x) => x.method === 'POST').length, 1);
  const stored = page.win.HCCore.readSession(page.storage, Date.now());
  assert.ok(stored, 'the session is in page memory (U1)');
  assert.equal(stored.token, TOKEN);
  assert.equal(page.storage.getItem(C.SESSION_KEY), null, 'and never in sessionStorage (U1: the cookie keeps it)');
  assert.equal(controlsOf(page).hidden, false);
  assert.equal(page.switchBtn().getAttribute('aria-checked'), 'true', 'Editor mode comes on after a sign-in');
  assert.ok(page.body.classList.contains('hc-editor-on'));
  assert.equal(page.sessions.at(-1), true, 'app.js hears the sign-in (its footer link turns into "Edit this page")');
  assert.equal(page.told.at(-1).text, '', 'the footer line is cleared');
});

test('a second sign-in click while signed out adopts the NEW window', async () => {
  const first = popupWindow();
  const log = [];
  const page = openSite({ session: null, start: { popup: first }, intercept: authServer(log) });
  await settle();
  const second = popupWindow();
  assert.equal(page.win.HCEditor.start({ popup: second }), true);
  await settle();
  assert.match(second.location.href, /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
  assert.deepEqual(page.opens, []);
  assert.equal(log.filter((x) => x.method === 'GET').length, 2);
});

test('the avatar menu signs out: the session is cleared, Editor off, the controls hide, app.js hears it', async () => {
  const page = await editorOn();
  assert.equal(page.sessions.at(-1), true);
  const avatar = page.one((e) => e.attrs['data-action'] === 'avatar');
  assert.ok(avatar, 'the avatar button is in the header');
  const menu = page.one((e) => e.attrs.role === 'menu');
  assert.equal(menu.hidden, true);
  avatar.click();
  assert.equal(menu.hidden, false);
  assert.equal(avatar.getAttribute('aria-expanded'), 'true');
  page.one((e) => e.attrs['data-action'] === 'sign-out').click();
  await settle();
  assert.equal(page.storage.getItem(C.SESSION_KEY), null);
  assert.equal(page.body.classList.contains('hc-editor-on'), false);
  assert.equal(controlsOf(page).hidden, true);
  assert.equal(page.sessions.at(-1), false);
  assert.match(page.told.at(-1).text, /Signed out/);
});

test('sign-out drops the session\'s file cache and main\'s sha: a pick in flight reads nothing with the old token', async () => {
  const page = await editorOn();
  await page.send({ type: 'hc-ready' });
  const i = firstParagraph(PAGE_TEXT);
  // the frame's pick arrives, and the person signs out before it is served
  for (const fn of page.listeners.message || []) {
    fn({ source: page.frame().contentWindow, origin: 'null', data: { type: 'hc-block-select', index: i, nonce: page.nonce() } });
  }
  const net = page.github().length;
  page.one((e) => e.attrs['data-action'] === 'sign-out').click();
  await settle();
  assert.equal(page.storage.getItem(C.SESSION_KEY), null);
  assert.deepEqual(page.github().slice(net), [], 'no GitHub read after the sign-out (the old token\'s cache is gone)');
  assert.equal(draftsOf(page).list().length, 0, 'the pick is dropped');
  const notice = page.one((e) => e.classList.contains('hc-notice'));
  assert.ok(!notice || !/Something went wrong/.test(notice.textContent), 'quietly');
  // a later sign-in builds a fresh cache: Editor mode works again
  const again = await editorOn({ storage: page.storage });
  assert.ok(again.frame(), 'a new session mounts the frame');
});

test('header: the avatar is the committed copy (data/graph/avatars/), first name and role as text', async () => {
  const people = JSON.parse(readRepo('data/graph/people-public.json')).people;
  const login = Object.keys(people).find((k) => people[k] && typeof people[k].avatar === 'string');
  assert.ok(login, 'people-public.json has an avatar');
  const page = openSite({ session: C.makeSession(TOKEN, null, login, Date.now()) });
  await settle();
  const img = page.one((e) => e.tagName === 'IMG' && e.classList.contains('hc-avatar-img'));
  assert.ok(img, 'the committed avatar');
  assert.equal(img.attrs.src, people[login].avatar);
  assert.match(img.attrs.src, /^data\/graph\/avatars\//);
  assert.equal(img.attrs.alt, '');
  const who = page.one((e) => e.classList.contains('hc-login'));
  assert.equal(who.textContent, 'Kyle', 'the first name of the GitHub account (the fixture\'s /user)');
  assert.ok(page.one((e) => e.classList.contains('hc-role')), 'the role badge');
});

test('header: no committed copy, a live or odd avatar path, or a hostile name -> initials, and text only', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const cases = [
    {},
    { bob: { avatar: 'https://avatars.githubusercontent.com/u/1?s=64&v=4' } },
    { bob: { avatar: 'data/graph/avatars/../../js/app.js' } },
    { bob: { avatar: 'javascript:alert(1)' } },
    { bob: { avatar: ['data/graph/avatars/bob.png'] } },
    { bob: 'data/graph/avatars/bob.png' },
  ];
  for (const peopleMap of cases) {
    const page = openSite({
      hc: { 'data/graph/people-public.json': { people: peopleMap } },
      intercept: (url) => (url === 'https://api.github.com/user' ? answer(200, { login: 'bob', name: hostile }) : null),
    });
    await settle();
    assert.equal(page.all((e) => e.tagName === 'IMG').length, 0, `no image for ${JSON.stringify(peopleMap)}`);
    const initials = page.one((e) => e.classList.contains('hc-initials'));
    assert.ok(initials);
    assert.equal(initials.textContent, '<');
    assert.equal(page.one((e) => e.classList.contains('hc-login')).textContent, '<img');
  }
  // people-public.json missing or not an object: initials, never a crash
  for (const doc of [null, 'x', { people: null }, { people: [] }]) {
    const page = openSite({ hc: { 'data/graph/people-public.json': doc } });
    await settle();
    assert.equal(page.all((e) => e.tagName === 'IMG').length, 0);
    assert.equal(page.one((e) => e.classList.contains('hc-initials')).textContent, 'K');
  }
});

// ------------------------------------------------- proposals in place (U7) ---
/* Plan D-F, D-G: an open proposal that touches the page on screen is drawn
   over main in the frame (the composite of HCCore.overlayOnMain, marked with
   this load's sentinels), with a page bar above the frame. PR #1 is used
   READ-ONLY: its files, compare and check-runs answers are U0 fixtures, and
   main has moved since its merge base (MAIN_SHA is a different commit). */

const F = require(path.join(ROOT, 'js', 'editor-frame.js'));
const UB_BASE = fixtureText('page-ubuntu-24-04-server.at-merge-base.md');
const UB_HEAD = fixtureText('page-ubuntu-24-04-server.at-d0bdc64.md');
const PR1 = JSON.parse(fixtureText('pull-1.json'));
const PR1_HEAD = PR1.head.sha;

/* main, moved since PR #1's merge base: one paragraph the PR leaves alone
   is reworded (no mark: it is simply main's text). */
function movedMain() {
  const bb = blocksOf(UB_BASE);
  const same = C.blockDiff(UB_BASE, UB_HEAD).find((d) => d.status === 'same' && bb[d.a].kind === 'paragraph');
  const b = bb[same.a];
  const words = 'Main reworded this paragraph after the proposal was opened.';
  return { text: UB_BASE.slice(0, b.start) + words + b.text.match(/\n*$/)[0] + UB_BASE.slice(b.end), words };
}

/* main, moved so that it ALSO changed a code block PR #1 changes: a conflict. */
function conflictingMain() {
  const bb = blocksOf(UB_BASE);
  const ch = C.blockDiff(UB_BASE, UB_HEAD).find((d) => d.status === 'change' && bb[d.a].kind === 'code');
  const b = bb[ch.a];
  assert.ok(b.text.startsWith('```'), 'a fenced code block');
  const changed = b.text.replace('\n```', '\n# main moved this line\n```');
  return { text: UB_BASE.slice(0, b.start) + changed + UB_BASE.slice(b.end), changed };
}

const pageBar = (page) => page.one((e) => e.classList.contains('hc-pagebar'));
const marksOf = (m) => [...m.overlay].map((x) => ({ index: x.index, mark: x.mark }));

async function ubuntuOn(opts) {
  const page = await editorOn(Object.assign({ hash: `#${UBUNTU_ROUTE}` }, opts));
  await page.send({ type: 'hc-ready' });
  return page;
}

/* A second open proposal on the Ubuntu page, newer than PR #1, built on
   main (its merge base is MAIN_SHA): it adds one paragraph after the h1. */
function secondProposal(mainText) {
  const head = `b2${'0'.repeat(38)}`;
  const bb = blocksOf(mainText);
  const h1 = bb.findIndex((b) => b.kind === 'heading');
  const at = bb[h1 + 1].start;
  const text = `${mainText.slice(0, at)}A second proposal adds this paragraph.\n\n${mainText.slice(at)}`;
  const pull = Object.assign({}, PR1, { number: 2, title: 'A second proposal', created_at: '2026-09-30T08:00:00Z',
    user: Object.assign({}, PR1.user, { login: 'second-author' }),
    head: Object.assign({}, PR1.head, { sha: head, ref: 'cms/second-author/x' }) });
  return {
    text, head,
    extra: {
      pulls: [pull],
      files: { 2: [{ filename: UBUNTU_FILE, status: 'modified', additions: 2, deletions: 0, changes: 2, patch: '@@ -1 +1 @@' }] },
      contents: { [head]: { [UBUNTU_FILE]: text } },
      compare: { [head]: MAIN_SHA },
      checks: { [head]: { total_count: 0, check_runs: [] } },
    },
  };
}

test('fake GitHub: maintain/admin variants and `extra` proposals answer like GitHub', async () => {
  const read = { readFixture: async (n) => { try { return fs.readFileSync(path.join(FIXTURES, n), 'utf8'); } catch (e) { return null; } },
    readFile: async (p) => fs.readFileSync(path.join(ROOT, p), 'utf8') };
  const repo = async (variant) => (await (await createFakeGitHub(Object.assign({ variant }, read))
    .fetch('https://api.github.com/repos/desert-mango/hippocampus-docs')).json()).permissions;
  assert.equal(C.roleFromPermissions(await repo('readonly')).key, 'read');
  assert.equal(C.roleFromPermissions(await repo('push')).key, 'push');
  assert.equal(C.roleFromPermissions(await repo('maintain')).key, 'maintain');
  assert.equal(C.roleFromPermissions(await repo('admin')).key, 'admin');
  const two = secondProposal(readRepo(UBUNTU_FILE));
  const fake = createFakeGitHub(Object.assign({ extra: two.extra }, read));
  const get = async (p) => { const r = await fake.fetch(`https://api.github.com/repos/desert-mango/hippocampus-docs${p}`); return { status: r.status, body: r.ok ? await r.json() : null }; };
  assert.deepEqual((await get('/pulls?state=open&per_page=100')).body.map((p) => p.number).sort(), [1, 2]);
  assert.equal((await get('/pulls/2')).body.head.sha, two.head);
  assert.equal((await get('/pulls/2/files?per_page=100&page=1')).body[0].filename, UBUNTU_FILE);
  assert.equal((await get(`/compare/${MAIN_SHA}...${two.head}`)).body.merge_base_commit.sha, MAIN_SHA);
  assert.equal((await get(`/commits/${two.head}/check-runs?check_name=check&per_page=100`)).body.total_count, 0);
  const at = await fake.fetch(`https://api.github.com/repos/desert-mango/hippocampus-docs/contents/${UBUNTU_FILE}?ref=${two.head}`);
  assert.equal(await at.text(), two.text);
  assert.equal((await get('/pulls/3')).status, 404);
});

test('overlay: PR #1 at d0bdc64 drawn over a MOVED main — the composite with this load\'s sentinels, and its marks', async () => {
  const main = movedMain();
  const page = await ubuntuOn({ files: { [UBUNTU_FILE]: main.text } });
  const ov = C.overlayOnMain(main.text, UB_BASE, UB_HEAD);
  assert.ok(ov && ov.conflicts.length === 0);
  const served = await page.asks(UBUNTU_FILE);
  assert.equal(served.text, C.withSentinels(ov.text, page.nonce().slice(0, 16), ov.overlay));
  assert.ok(served.text.includes(main.words), 'main\'s own (moved) wording is on the page');
  // the merge base came from compare, and the texts were read at the three shas
  const urls = page.github().map((c) => c.url);
  assert.ok(urls.some((u) => u.includes(`/compare/${MAIN_SHA}...${PR1_HEAD}`)), 'merge base via compare');
  for (const sha of [MAIN_SHA, PR1_HEAD, PR1.base.sha]) {
    assert.ok(urls.some((u) => u.includes(`contents/${UBUNTU_FILE}?ref=${sha}`)), `read at ${sha.slice(0, 7)}`);
  }
  const marks = marksOf(page.editorMessages().at(-1));
  const markAt = new Map(marks.map((x) => [x.index, x.mark]));
  assert.equal(marks.length, ov.overlay.filter((e) => e.source !== 'main').length, 'one mark per proposal block');
  ov.overlay.forEach((e, i) => {
    if (e.source === 'main') assert.equal(markAt.has(i), false, `main block ${i} is unmarked`);
    if (e.source === 'pr-del') assert.equal(markAt.get(i), 'del');
    if (e.source === 'pr-add') assert.ok(['add', 'change'].includes(markAt.get(i)));
    if (markAt.get(i) === 'change') assert.equal(markAt.get(i - 1), 'del', 'a changed block follows its old version');
  });
  const attention = ov.overlay.findIndex((e) => e.text.startsWith('<div class="adm adm-attention">'));
  assert.equal(markAt.get(attention), 'add', 'the inserted Attention block is an addition');
  const chrony = ov.overlay.findIndex((e) => e.source === 'pr-add' && /- chrony/.test(e.text) && e.text.startsWith('```'));
  assert.equal(markAt.get(chrony), 'change', 'the changed cloud-init block is the new version…');
  assert.equal(markAt.get(chrony - 1), 'del', '…right after the old one');
  assert.ok(ov.overlay.some((e, i) => e.source === 'main' && e.text.includes(main.words) && !markAt.has(i)));
  // U0b (plan D18): no bar above the page; the proposer's colour still reaches the frame
  assert.equal(pageBar(page), undefined, 'no page bar');
  assert.equal(typeof page.editorMessages().at(-1).tint, 'number');
});

test('frame: sidePairs pairs a deleted block with the changed block right after it, nothing else', () => {
  assert.deepEqual(F.sidePairs([{ index: 3, mark: 'change' }, { index: 2, mark: 'del' }, { index: 5, mark: 'add' },
    { index: 7, mark: 'del' }, { index: 9, mark: 'change' }, { index: 11, mark: 'conflict' }]), [[2, 3]]);
  assert.deepEqual(F.sidePairs([]), []);
  assert.deepEqual(F.sidePairs(null), []);
});

test('overlay: a block main ALSO changed since the merge base shows main\'s version with the "main changed this" mark', async () => {
  const main = conflictingMain();
  const page = await ubuntuOn({ files: { [UBUNTU_FILE]: main.text } });
  const ov = C.overlayOnMain(main.text, UB_BASE, UB_HEAD);
  assert.equal(ov.conflicts.length, 1);
  const k = ov.overlay.findIndex((e) => e.source === 'conflict');
  assert.ok(ov.overlay[k].text.includes('# main moved this line'), 'main\'s version, never a guess');
  const marks = marksOf(page.editorMessages().at(-1));
  assert.deepEqual(marks.filter((x) => x.mark === 'conflict'), [{ index: k, mark: 'conflict' }]);
  // a read-only role gets the same mark (U0b: the bar's words and its Update from main button went with the bar)
  const ro = await ubuntuOn({ files: { [UBUNTU_FILE]: main.text }, variant: 'readonly' });
  assert.deepEqual(marksOf(ro.editorMessages().at(-1)).filter((x) => x.mark === 'conflict'), [{ index: k, mark: 'conflict' }]);
});


test('overlay: clicking the block right after a PR-inserted block edits the right main block (composite -> mainIndex)', async () => {
  const main = movedMain();
  const page = await ubuntuOn({ files: { [UBUNTU_FILE]: main.text } });
  const ov = C.overlayOnMain(main.text, UB_BASE, UB_HEAD);
  const k = ov.overlay.findIndex((e, i) => i > 0 && e.source === 'main' && ov.overlay[i - 1].source === 'pr-add');
  assert.ok(k > 0, 'PR #1 inserts a block before a main block');
  const mi = ov.overlay[k].mainIndex;
  assert.notEqual(mi, k, 'composite and main indices differ here');
  const srcs = page.frame().srcs.length;
  await page.pick(k);
  // the frame goes to the draft view (D-G 1): main with plain sentinels, that block selected and opened in the page
  assert.equal(page.frame().srcs.length, srcs + 1, 'the frame reloaded to the draft view');
  await page.send({ type: 'hc-ready' });
  const m = page.editorMessages().at(-1);
  assert.equal(m.selected, mi);
  assert.equal(m.open.md, blocksOf(main.text)[mi].text, 'main\'s block at mainIndex, not the composite\'s k-th');
  assert.deepEqual([...m.overlay], []);
  assert.equal((await page.asks(UBUNTU_FILE)).text, C.withSentinels(main.text, page.nonce().slice(0, 16)));
  // an edit changes main's block only (typed in the page; U0b: the tray's textarea is gone, and so is the bar)
  await page.typeIn(mi, 'Edited from the overlay.\n');
  const b = blocksOf(main.text)[mi];
  const d = draftsOf(page).get('setup/raspberry-pi/ubuntu-24-04-server').files[UBUNTU_FILE];
  assert.equal(d, main.text.slice(0, b.start) + 'Edited from the overlay.\n' + main.text.slice(b.end));
});

test('overlay: "+" after a PR-inserted block inserts after the nearest preceding main block', async () => {
  const main = movedMain();
  const page = await ubuntuOn({ files: { [UBUNTU_FILE]: main.text } });
  const ov = C.overlayOnMain(main.text, UB_BASE, UB_HEAD);
  const k = ov.overlay.findIndex((e, i) => i > 0 && e.source === 'pr-add' && ov.overlay[i - 1].source === 'main');
  let j = k;
  while (ov.overlay[j].source !== 'main') j -= 1;
  // the rail BEFORE composite block k+1 (right after the PR-inserted block k)
  await page.send({ type: 'hc-block-insert', index: k + 1, kind: 'note' });
  const want = C.insertAt(main.text, ov.overlay[j].mainIndex + 1, 'note');
  const d = draftsOf(page).get('setup/raspberry-pi/ubuntu-24-04-server').files[UBUNTU_FILE];
  assert.equal(d, want.text);
});

test('overlay: clicking a PR-only block opens that proposal\'s card and starts no draft', async () => {
  const page = await ubuntuOn();
  const ov = C.overlayOnMain(readRepo(UBUNTU_FILE), UB_BASE, UB_HEAD);
  for (const source of ['pr-add', 'pr-del']) {
    const k = ov.overlay.findIndex((e) => e.source === source);
    const srcs = page.frame().srcs.length;
    await page.send({ type: 'hc-block-select', index: k });
    // U0b: its card is the #/review/1 redirect — the page stays, PR #1 kept drawn (U3 opens its row in the bubble)
    assert.equal(page.tray().hidden, true, source);
    assert.equal(page.win.HCEditor.helpers.state().focusPr, 1, 'PR #1 is the proposal on the page');
    assert.equal(draftsOf(page).list().length, 0, 'no draft');
    assert.equal(page.frame().srcs.length, srcs, 'the frame stays on the overlay');
  }
});

test('two proposals on one page: the newest is overlaid; the other is drawn when named (#/review/<n>, U0b)', async () => {
  const mainText = readRepo(UBUNTU_FILE);
  const two = secondProposal(mainText);
  const page = await ubuntuOn({ extra: two.extra });
  const ov2 = C.overlayOnMain(mainText, mainText, two.text);
  assert.equal((await page.asks(UBUNTU_FILE)).text, C.withSentinels(ov2.text, page.nonce().slice(0, 16), ov2.overlay));
  assert.deepEqual(marksOf(page.editorMessages().at(-1)).map((x) => x.mark), ['add']);
  assert.equal(page.editorMessages().at(-1).tint, 2, 'in #2\'s proposer\'s colour');
  // U0b: no bar lists the other; #/review/1 (its redirect) draws PR #1 on the page instead
  page.win.HCEditor.openView('#/review/1');
  await settle();
  await page.send({ type: 'hc-ready' });
  const ov1 = C.overlayOnMain(mainText, UB_BASE, UB_HEAD);
  assert.equal((await page.asks(UBUNTU_FILE)).text, C.withSentinels(ov1.text, page.nonce().slice(0, 16), ov1.overlay));
  assert.ok(page.editorMessages().at(-1).overlay.length > 0, 'overlay on');
});

test('a proposal whose texts do not split is not drawn, and the page is main\'s', async () => {
  const crlf = readRepo(UBUNTU_FILE).replace(/\n/g, '\r\n');
  const page = await ubuntuOn({ files: { [UBUNTU_FILE]: crlf } });
  assert.equal((await page.asks(UBUNTU_FILE)).text, crlf);
  assert.deepEqual([...page.editorMessages().at(-1).overlay], []);
  assert.equal(pageBar(page), undefined, 'U0b: no bar says so (U3 tells it in the bubble)');
});

test('a page no proposal touches has no page bar and no marks', async () => {
  const page = await editorOn();
  await page.send({ type: 'hc-ready' });
  assert.ok(!pageBar(page) || pageBar(page).hidden);
  assert.deepEqual([...page.editorMessages().at(-1).overlay], []);
});

/* The frame side of "side by side" over a small DOM (js/editor-frame.js
   create(), the same code the real frame runs). */
class MiniNode {
  constructor(doc, type) { this.ownerDocument = doc; this.nodeType = type; this.parentNode = null; this.childNodes = []; }
  get previousSibling() { const s = this.parentNode ? this.parentNode.childNodes : []; return s[s.indexOf(this) - 1] || null; }
  get nextSibling() { const s = this.parentNode ? this.parentNode.childNodes : []; const i = s.indexOf(this); return i < 0 ? null : s[i + 1] || null; }
  get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map((c) => c.textContent).join(''); }
}
class MiniEl extends MiniNode {
  constructor(doc, tag) {
    super(doc, 1);
    this.tagName = tag.toUpperCase();
    this.attrs = {};
    this.id = '';
    this.cls = new Set();
    const self = this;
    this.classList = { add: (c) => self.cls.add(c), remove: (c) => self.cls.delete(c), contains: (c) => self.cls.has(c),
      toggle: (c, on) => { const want = on === undefined ? !self.cls.has(c) : Boolean(on); if (want) self.cls.add(c); else self.cls.delete(c); return want; } };
  }
  get className() { return [...this.cls].join(' '); }
  set className(v) { this.cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  set textContent(t) { this.childNodes = []; if (t) { const n = new MiniNode(this.ownerDocument, 3); n.data = String(t); this.appendChild(n); } }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  detach(c) { if (c.parentNode) { const s = c.parentNode.childNodes; s.splice(s.indexOf(c), 1); } }
  appendChild(c) { this.detach(c); this.childNodes.push(c); c.parentNode = this; return c; }
  insertBefore(c, ref) {
    if (!ref) return this.appendChild(c);
    this.detach(c);
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, c);
    c.parentNode = this;
    return c;
  }
  removeChild(c) { this.detach(c); c.parentNode = null; return c; }
  addEventListener() {}
  scrollIntoView() {}
}

function sidePage(prefix) {
  const doc = { addEventListener() {} };
  doc.createElement = (t) => new MiniEl(doc, t);
  doc.head = new MiniEl(doc, 'head');
  doc.body = new MiniEl(doc, 'body');
  const content = new MiniEl(doc, 'main');
  content.id = 'content';
  doc.getElementById = (id) => (id === 'content' ? content : null);
  const body = new MiniEl(doc, 'div');
  body.className = 'page-body';
  for (let i = 0; i < 4; i += 1) {
    const s = new MiniEl(doc, 'div');
    s.id = `hcb-${prefix}-${i}`;
    body.appendChild(s);
    body.appendChild(new MiniEl(doc, i === 0 ? 'h1' : 'p'));
  }
  content.appendChild(body);
  doc.body.appendChild(content);
  let listener = null;
  const HC = { preview: true, blockPrefix: prefix, post: () => true, onEditor: (fn) => { listener = fn; return true; } };
  const win = { addEventListener() {}, setTimeout, location: { hash: '' } };
  F.create(win, doc, HC);
  const send = (diff) => listener({ on: true, selected: 2, overlay: [{ index: 1, mark: 'del' }, { index: 2, mark: 'change' }],
    settings: { suggestions: true, diff, compact: false, outlines: true } });
  return { body, send };
}

test('frame: "side by side" puts the old block and its new version in one hc-side pair; "inline" unwraps it', () => {
  const { body, send } = sidePage('0123456789abcdef');
  const cls = (n) => (n.nodeType === 1 ? n.className : '');
  const sides = () => body.childNodes.filter((n) => cls(n).split(' ').includes('hc-side'));
  const order = () => F.blocksIn(body).map((w) => w.getAttribute('data-index'));
  send('side');
  send('side');                          // idempotent
  assert.equal(sides().length, 1);
  const pair = sides()[0];
  assert.deepEqual(pair.childNodes.map((w) => w.getAttribute('data-index')), ['1', '2']);
  assert.ok(pair.childNodes[0].classList.contains('hc-prop-del') && pair.childNodes[1].classList.contains('hc-prop-change'));
  assert.ok(pair.childNodes[1].classList.contains('hc-selected'), 'a block inside a pair is still marked');
  assert.equal(pair.childNodes.filter((n) => cls(n).includes('hc-plus')).length, 0, 'no rail between old and new');
  assert.deepEqual(order(), ['0', '1', '2', '3']);
  send('inline');
  assert.equal(sides().length, 0);
  assert.deepEqual(order(), ['0', '1', '2', '3']);
  assert.ok(body.childNodes.includes(F.blocksIn(body)[1]), 'back as a direct child of the page body');
  send('side');
  assert.equal(sides().length, 1, 'and paired again');
});

test('a link inside the frame: to a page a proposal touches reloads with the overlay; away from it clears the marks', async () => {
  const page = await editorOn();
  await page.send({ type: 'hc-ready' });
  let srcs = page.frame().srcs.length;
  await page.send({ type: 'hc-route', route: UBUNTU_ROUTE });
  assert.equal(page.frame().srcs.length, srcs + 1, 'reloaded: the proposal is drawn on the new page');
  await page.send({ type: 'hc-ready' });
  const ov = C.overlayOnMain(readRepo(UBUNTU_FILE), UB_BASE, UB_HEAD);
  assert.equal((await page.asks(UBUNTU_FILE)).text, C.withSentinels(ov.text, page.nonce().slice(0, 16), ov.overlay));
  assert.ok(page.editorMessages().at(-1).overlay.length > 0);
  srcs = page.frame().srcs.length;
  const told = page.editorMessages().length;
  await page.send({ type: 'hc-route', route: PAGE_ROUTE });
  assert.equal(page.frame().srcs.length, srcs, 'no reload for a page nothing is proposed on');
  assert.ok(page.editorMessages().length > told, 'the frame is told at once…');
  assert.deepEqual([...page.editorMessages().at(-1).overlay], [], '…that the old marks are gone');
  assert.ok(!pageBar(page) || pageBar(page).hidden);
});

test('overlay: "Edit whole page as Markdown" edits main and shows it (the draft view), not the composite', async () => {
  const page = await ubuntuOn();
  const srcs = page.frame().srcs.length;
  await page.wholePage();          // U0b: from the account menu, onto the thin editor page
  assert.equal(page.editorTextarea().value, readRepo(UBUNTU_FILE), 'main\'s whole text');
  assert.equal(page.frame().srcs.length, srcs + 1);
  await page.send({ type: 'hc-ready' });
  assert.deepEqual([...page.editorMessages().at(-1).overlay], []);
  assert.equal((await page.asks(UBUNTU_FILE)).text, C.withSentinels(readRepo(UBUNTU_FILE), page.nonce().slice(0, 16)));
});

// ===================================================== /cms/ retired (U8) ===
/* tools/tests/test_cms_editor.mjs is gone with js/cms.js (U8). Its rows live
   here BY NAME. The ones that test js/cms-core.js alone (the page tree, strict
   JSON, locked ids, snippets, drafts, branch names, forbidden paths, the PR
   body, the new-project and new-person drafts, and the Propose sequence) are
   moved verbatim inside this block, with their own constants (their MAIN_SHA
   is '1' x 40, not the fake GitHub's). The rows that ran js/cms.js are
   re-homed after it, named "js/editor.js …", and run against Editor mode. */
{
const readRepo = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const REGS = {
  setup: JSON.parse(readRepo('data/setup.json')),
  // the project index merged with each project's facts file, as HC.fetchProjects reads it (2026-10-14)
  projects: (() => { const index = JSON.parse(readRepo('data/projects.json'));
    return C.mergeProjects(index, index.projects.map((e) => JSON.parse(readRepo(`data/projects/${e.id}.json`)))); })(),
  tools: JSON.parse(readRepo('data/tools.json')),
};
const TOKEN = '<yours>-editor-token';
const REPO_API = 'https://api.github.com/repos/desert-mango/hippocampus-docs';
const MAIN_SHA = '1'.repeat(40);
const MAIN_TREE = '2'.repeat(40);

// ------------------------------------------------------------ page tree --

test('page tree: exactly the registries\' pages — every setup page, project, tool, and About', () => {
  const setupIds = REGS.setup.sections.flatMap((s) => s.pages.map((p) => `setup/${p.id}`));
  const projectIds = REGS.projects.projects.map((p) => `project/${p.id}`);
  const toolIds = REGS.tools.tools.map((t) => `tool/${t.id}`);
  const list = C.pageList(REGS);
  assert.deepEqual(list.map((p) => p.pageId), [...setupIds, ...projectIds, ...toolIds, 'about']);
  // the counts come from the content tree, never a constant: one Markdown file per registry page
  const mdUnder = (dir) => fs.readdirSync(path.join(ROOT, dir), { recursive: true })
    .filter((f) => String(f).endsWith('.md')).length;
  assert.deepEqual([setupIds.length, projectIds.length, toolIds.length],
    [mdUnder('content/setup'), mdUnder('content/projects'), mdUnder('content/tools')]);
  for (const n of [setupIds.length, projectIds.length, toolIds.length]) assert.ok(n > 0);
  for (const p of list) {
    assert.equal(p.file, C.editPath(p.pageId, REGS), p.pageId);
    assert.equal(C.pageIdForFile(p.file, REGS), p.pageId, `${p.file} maps back`);
    assert.equal(C.routeForPage(p.pageId, REGS), p.route, p.pageId);
    assert.ok(typeof p.title === 'string' && p.title, p.pageId);
  }
  assert.equal(C.routeForPage('setup/bluerov/dvl', REGS), '/setup/bluerov/dvl');
  assert.equal(C.routeForPage('about', REGS), '/team', 'round 2 (R5): About became the Team page');
  const tree = C.pageTree(REGS);
  assert.deepEqual(tree.map((g) => g.key).filter((k, i, a) => a.indexOf(k) === i),
    ['setup', 'projects', 'tools', 'about', 'registries']);
  assert.equal(tree.filter((g) => g.key === 'setup').length, REGS.setup.sections.length);
  const regs = tree.find((g) => g.key === 'registries').pages;
  assert.deepEqual(regs.map((p) => p.pageId), ['data/people', 'data/projects', 'data/site', 'data/tools']);
  assert.deepEqual(regs.map((p) => p.file), C.RAW_REGISTRIES);
  assert.deepEqual(regs.map((p) => p.route), ['/team', '/projects', '/', '/tools']);
});

test('page tree: a broken or missing registry lists nothing from it, never a guessed page', () => {
  const tree = C.pageList({ setup: { sections: 'x' }, projects: null,
    tools: { tools: [{ id: '../x', file: 'content/tools/x.md' }, { id: 'ok', file: 'js/app.js' }] } });
  assert.deepEqual(tree.map((p) => p.pageId), ['about']);
  assert.equal(C.pageIdForFile('js/app.js', REGS), null);
  assert.equal(C.pageIdForFile('data/people.json', REGS), 'data/people');
  assert.equal(C.pageIdForFile('data/setup.json', REGS), null, 'setup.json is not a raw-JSON editor');
  assert.equal(C.editKind('data/people'), 'registry');
  assert.equal(C.editKind('data/setup'), null);
  assert.equal(C.editKind('about'), 'page');
});

// ---------------------------------------------------------- strict JSON --

test('JSON problems carry line and column, in words, for the two rules that bite', () => {
  assert.equal(C.jsonProblem('{"a": [1, 2]}\n'), null);
  const trailing = C.jsonProblem('{\n  "a": 1,\n  "b": 2,\n}\n');
  assert.deepEqual([trailing.line, trailing.column], [3, 9]);
  assert.match(trailing.message, /trailing comma/);
  const inList = C.jsonProblem('[\n 1,\n 2,\n]');
  assert.deepEqual([inList.line, inList.column], [3, 3]);
  assert.match(inList.message, /trailing comma/);
  const single = C.jsonProblem("{\n  'a': 1\n}");
  assert.deepEqual([single.line, single.column], [2, 3]);
  assert.match(single.message, /double quotes/);
  const singleValue = C.jsonProblem('{"a": \'x\'}');
  assert.deepEqual([singleValue.line, singleValue.column], [1, 7]);
  assert.match(singleValue.message, /double quotes/);
  for (const [bad, line, column] of [['{"a" 1}', 1, 6], ['{"a": 1 "b": 2}', 1, 9], ['', 1, 1],
    ['{"a": tru}', 1, 7], ['{"a": 1}}', 1, 9], ['{"a": "x\ny"}', 1, 9], ['{"a": 01}', 1, 8], ['[1,]', 1, 3]]) {
    const p = C.jsonProblem(bad);
    assert.ok(p, JSON.stringify(bad));
    assert.deepEqual([p.line, p.column], [line, column], JSON.stringify(bad));
  }
  assert.equal(C.jsonProblemText('data/tools.json', trailing),
    `data/tools.json, line 3, column 9: ${trailing.message} (strict JSON — no trailing commas, double quotes)`);
  // every registry on main parses clean through the same helper
  for (const f of C.RAW_REGISTRIES) assert.equal(C.jsonProblem(readRepo(f)), null, f);
});

test('locked ids: a draft that drops or renames an existing id is refused with the rule\'s words', () => {
  assert.equal(C.ID_RULE_TEXT, 'renaming or removing an existing id needs Desert Mango — open an issue');
  const before = readRepo('data/projects.json');
  const ids = C.lockedIds('data/projects.json', JSON.parse(before));
  assert.ok(ids.length > 0);
  assert.equal(ids.length, JSON.parse(before).projects.length);
  assert.equal(C.registryDraftProblem('data/projects.json', before, before), null);
  const renamed = before.replace('"id": "uvms"', '"id": "uvms-2"');
  assert.notEqual(renamed, before);
  const p = C.registryDraftProblem('data/projects.json', before, renamed);
  assert.equal(p.kind, 'id');
  assert.equal(p.message, `data/projects.json: 'uvms' was removed or renamed — ${C.ID_RULE_TEXT}`);
  const doc = JSON.parse(before);
  doc.projects = doc.projects.filter((x) => x.id !== 'uvms');
  assert.match(C.registryDraftProblem('data/projects.json', before, JSON.stringify(doc)).message, /'uvms' was removed/);
  // a new entry with a new id, or a changed name, is fine
  const grown = JSON.parse(before);
  grown.projects.push(Object.assign({}, grown.projects[0], { id: 'brand-new' }));
  grown.projects[0].name = 'Renamed title, same id';
  assert.equal(C.registryDraftProblem('data/projects.json', before, JSON.stringify(grown)), null);
  // a copied entry that keeps an existing id is refused: a new entry needs a new id
  const copied = JSON.parse(before);
  copied.projects.push(Object.assign({}, copied.projects[2]));
  const twice = C.registryDraftProblem('data/projects.json', before, JSON.stringify(copied));
  assert.equal(twice.kind, 'id');
  assert.equal(twice.message, `data/projects.json: the id '${copied.projects[2].id}' is used twice — a new entry needs a new id`);
  const people = JSON.parse(readRepo('data/people.json'));
  people.groups.push({ id: 'new-group', title: 'X', people: [] }, { id: 'new-group', title: 'Y', people: [] });
  assert.match(C.registryDraftProblem('data/people.json', readRepo('data/people.json'), JSON.stringify(people)).message,
    /'new-group' is used twice/);
  // people: group ids are the locked ids; tools: tool ids; site: none
  assert.deepEqual(C.lockedIds('data/people.json', JSON.parse(readRepo('data/people.json'))),
    JSON.parse(readRepo('data/people.json')).groups.map((g) => g.id));
  assert.deepEqual(C.lockedIds('data/tools.json', REGS.tools), REGS.tools.tools.map((t) => t.id));
  assert.deepEqual(C.lockedIds('data/site.json', {}), []);
  // strict JSON comes first, located
  const bad = C.registryDraftProblem('data/tools.json', readRepo('data/tools.json'), '{"tools": [],}');
  assert.equal(bad.kind, 'json');
  assert.match(bad.message, /^data\/tools\.json, line 1, column 13: .*trailing comma/);
});

test('formatLike: today\'s projects and people registries round-trip byte for byte', () => {
  for (const f of ['data/projects.json', 'data/people.json']) {
    const t = readRepo(f);
    assert.equal(C.formatLike(t, JSON.parse(t)), t, f);
  }
});

// ------------------------------------------------------------- snippets --

test('snippets: note, warning and tabs in the site\'s dialect, wrapped around the selection', () => {
  assert.deepEqual(Object.keys(C.SNIPPETS), ['note', 'warning', 'tabs']);
  const note = C.insertSnippet('Intro.\nMore', 7, 11, 'note');
  assert.equal(note.text, 'Intro.\n\n<div class="adm adm-note"><p class="adm-title">Note</p>\n\nMore\n\n</div>\n');
  assert.equal(note.text.slice(note.selStart, note.selEnd), 'More');
  const warn = C.insertSnippet('', 0, 0, 'warning');
  assert.ok(warn.text.startsWith('<div class="adm adm-warning"><p class="adm-title">Warning</p>\n\n'));
  assert.equal(warn.text.slice(warn.selStart, warn.selEnd), C.SNIPPETS.warning.placeholder);
  const tabs = C.insertSnippet('A\n\nB', 2, 2, 'tabs');
  assert.ok(tabs.text.startsWith('A\n\n<div class="tabs">\n\n<div class="tab" data-label="First">\n\n'));
  assert.ok(tabs.text.endsWith('</div>\n\n</div>\n\nB'));
  assert.throws(() => C.insertSnippet('x', 0, 0, 'script'), /no such snippet/);
  const page = C.pageList(REGS).find((p) => p.pageId === 'setup/bluerov/dvl');
  assert.equal(C.linkMarkdown(page, ''), `[${page.title}](#/setup/bluerov/dvl)`);
  assert.equal(C.linkMarkdown(page, 'the [DVL]'), '[the DVL](#/setup/bluerov/dvl)');
});

// --------------------------------------------------------------- drafts --

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
    raw: m,
  };
}

const draftOf = (key, file, original, text, base) => ({ key, label: key, route: '/about',
  files: { [file]: text }, originals: { [file]: original }, base: base || { ref: 'main', sha: MAIN_SHA, number: null } });

/* U4b (plan-final §7 Drafts): drafts live in localStorage (they survive a closed tab), one store per login
   (two people on one browser never see each other's), each draft holding its base sha; two tabs writing the
   same store merge by page instead of overwriting each other's whole list. */
test('U4b drafts: per-login store in localStorage; two tabs keep each other\'s pages; clear() empties only that login', () => {
  const local = memoryStorage();
  assert.equal(C.draftsKey('Kyle-Nelson-Berkeley'), 'hc-cms-drafts:kyle-nelson-berkeley');
  assert.equal(C.draftsKey('not a login'), null, 'no store for a malformed login');
  const tab1 = C.createDraftStore(local, C.draftsKey('bob'));
  const tab2 = C.createDraftStore(local, C.draftsKey('bob'));        // a second tab, opened before tab1 wrote
  tab1.put(draftOf('about', 'content/about.md', 'Old\n', 'New\n'));
  tab2.put(draftOf('tool/runpod-mcp', 'content/tools/runpod-mcp.md', 'a\n', 'b\n'));
  // (one storage entry per page: two tabs that never read each other's writes still keep both pages)
  assert.ok(local.getItem(`${C.draftsKey('bob')}/about`), 'one entry per page');
  const both = C.createDraftStore(local, C.draftsKey('bob')).list().map((d) => d.key).sort();
  assert.deepEqual(both, ['about', 'tool/runpod-mcp'], 'the second tab kept the first tab\'s page');
  assert.equal(C.createDraftStore(local, C.draftsKey('alice')).list().length, 0, 'another login sees none');
  assert.equal(tab1.sync().map((d) => d.key).sort().join(','), 'about,tool/runpod-mcp', 'sync() reads the other tab\'s writes');
  assert.equal(tab1.get('about').base.sha, MAIN_SHA, 'the base sha is kept with the draft');
  C.createDraftStore(local, C.draftsKey('alice')).put(draftOf('about', 'content/about.md', 'x', 'y'));
  tab1.clear();
  assert.equal(C.createDraftStore(local, C.draftsKey('bob')).list().length, 0, 'clear() empties bob\'s store');
  assert.equal(C.createDraftStore(local, C.draftsKey('alice')).list().length, 1, 'and only bob\'s');
});

test('drafts: kept in memory and in sessionStorage, keyed by page; broken storage never throws', () => {
  const s = memoryStorage();
  const a = C.createDraftStore(s);
  a.put(draftOf('about', 'content/about.md', 'Old\n', 'New\n'));
  a.put(draftOf('tool/runpod-mcp', 'content/tools/runpod-mcp.md', 'Same\n', 'Same\n'));
  assert.equal(a.list().length, 2);
  assert.deepEqual(a.dirty().map((d) => d.key), ['about']);
  const b = C.createDraftStore(s);                // a reload of the tab
  assert.equal(b.get('about').files['content/about.md'], 'New\n');
  b.remove('about');
  assert.equal(C.createDraftStore(s).get('about'), null);
  // garbage, or storage that throws, is an empty store that still works in memory
  s.setItem(C.DRAFTS_KEY, '{not json');
  assert.equal(C.createDraftStore(s).list().length, 0);
  s.setItem(C.DRAFTS_KEY, JSON.stringify([{ key: 'x', files: { 'a.md': 1 } }, 'y']));
  assert.equal(C.createDraftStore(s).list().length, 0, 'malformed drafts are dropped');
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('x'); } };
  const c = C.createDraftStore(throwing);
  assert.equal(c.put(draftOf('about', 'content/about.md', 'a', 'b')), false, 'not persisted, but kept');
  assert.equal(c.get('about').files['content/about.md'], 'b');
  assert.equal(C.createDraftStore(null).list().length, 0);
  assert.equal(C.isDirty(draftOf('k', 'content/about.md', null, '')), true, 'a new file is a change');
});

function reply(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

/* GitHub for the editor: `login` with `perms`; `refs` maps branch -> head
   sha; `commits` maps sha -> tree sha; `contents` maps "<path>@<sha>" ->
   text; `pulls` is the open-PR list; `onWrite(method, url, body)` answers
   every write. */
function editorGithub(o) {
  return (url, init) => {
    const method = init.method || 'GET';
    if (method !== 'GET') return o.onWrite(method, url, JSON.parse(init.body));
    if (url === 'https://api.github.com/user') return reply(200, { login: o.login });
    if (url === REPO_API) return reply(200, { permissions: o.perms });
    const rest = url.slice(REPO_API.length);
    if (rest.startsWith('/pulls?state=open')) return reply(200, o.pulls || []);
    let m = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
    if (m) return o.refs[m[1]] ? reply(200, { ref: `refs/heads/${m[1]}`, object: { sha: o.refs[m[1]], type: 'commit' } })
      : reply(404, { message: 'Not Found' });
    m = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest);
    if (m && o.commits[m[1]]) return reply(200, { sha: m[1], tree: { sha: o.commits[m[1]] } });
    m = /^\/contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(rest);
    if (m && o.contents[`${decodeURIComponent(m[1])}@${m[2]}`] !== undefined) {
      return reply(200, o.contents[`${decodeURIComponent(m[1])}@${m[2]}`]);
    }
    return reply(404, { message: 'Not Found' });
  };
}

const SETUP_PAGE = REGS.setup.sections[0].pages[0];
const SETUP_FILE = SETUP_PAGE.file;
const SETUP_TEXT = readRepo(SETUP_FILE);

function baseGithub(extra) {
  return Object.assign({
    login: 'bob', perms: { push: true },
    refs: { main: MAIN_SHA }, commits: { [MAIN_SHA]: MAIN_TREE },
    contents: {
      [`${SETUP_FILE}@${MAIN_SHA}`]: SETUP_TEXT,
      [`data/projects.json@${MAIN_SHA}`]: readRepo('data/projects.json'),
      [`data/people.json@${MAIN_SHA}`]: readRepo('data/people.json'),
    },
    onWrite: () => reply(500, { message: 'no writes expected' }),
  }, extra || {});
}

// ------------------------------------------------ Propose: pure helpers --

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);       // 21 September 2026, UTC

test('branch names: cms/<login>/<slug>-<yymmdd>, slugged to lowercase letters, digits and dashes', () => {
  assert.equal(C.slugify('Fix the DVL heading!'), 'fix-the-dvl-heading');
  assert.equal(C.slugify('  Größe & Maße — ÄÖÜ café  '), 'grosse-masse-aou-cafe', 'ß -> ss, accents stripped');
  assert.equal(C.slugify('???'), '');
  assert.equal(C.slugify('a'.repeat(30) + ' ' + 'b'.repeat(30)).length <= 40, true);
  assert.ok(!/-$/.test(C.slugify('word '.repeat(20))), 'never ends in a dash after the cut');
  assert.equal(C.proposalBranch('Bob-Lab', 'Fix the DVL heading', NOW), 'cms/bob-lab/fix-the-dvl-heading-260921');
  assert.equal(C.proposalBranch('bob', '', NOW), 'cms/bob/edit-260921', 'an empty summary still names a branch');
  assert.equal(C.proposalBranch('bob', 'x', Date.UTC(2027, 0, 2, 23, 59)), 'cms/bob/x-270102', 'the date is UTC');
  assert.throws(() => C.proposalBranch('', 'x', NOW), /login/);
  for (const b of ['cms/bob/fix-260921', 'cms/bob/fix-260921-2', 'cms/Bob.x/a_b']) assert.equal(C.isProposalBranch(b), true, b);
  for (const b of ['main', 'refs/heads/cms/bob/x', 'cms/bob', 'cms//x', 'cms/bob/../main', 'feature/x', 'cms/bob/x/',
    'cms/bob/x.lock', 'cms/bob/.x', '', null]) assert.equal(C.isProposalBranch(b), false, String(b));
});

test('forbidden paths: the editor writes only content/*.md and data/*.json, never the machinery or derived files', () => {
  for (const ok of ['content/about.md', 'content/setup/bluerov/dvl.md', 'data/people.json', 'data/projects.json']) {
    assert.equal(C.proposalPathProblem(ok), null, ok);
  }
  for (const bad of ['search/site.json', 'data/graph/nodes.json', 'js/app.js', 'css/site.css', 'tools/check.py',
    'api/auth.js', '.github/workflows/check.yml', 'cms/index.html', 'index.html', 'vercel.json', 'README.md',
    'assets/hippo.svg', '/content/about.md', 'content/../js/app.js', 'content/./about.md', 'content\\about.md',
    'content//about.md', 'content/about.txt', 'data/x.md', '', null]) {
    assert.ok(C.proposalPathProblem(bad), String(bad));
  }
  assert.match(C.proposalPathProblem('js/app.js'), /never/);
  const sha = (c) => c.repeat(40);
  assert.deepEqual(C.treeEntries({ 'data/people.json': sha('b'), 'content/about.md': sha('a') }), [
    { path: 'content/about.md', mode: '100644', type: 'blob', sha: sha('a') },
    { path: 'data/people.json', mode: '100644', type: 'blob', sha: sha('b') },
  ], 'one entry per changed path, sorted');
  assert.throws(() => C.treeEntries({ 'js/app.js': sha('a') }), /never/);
  assert.throws(() => C.treeEntries({ 'content/about.md': 'nope' }), /blob/);
  assert.throws(() => C.treeEntries({}), /nothing/);
});

test('PR body: summary, the pages, "Made in the site editor.", and the review link once it is known', () => {
  const pages = [{ label: 'DVL', file: 'content/setup/bluerov/dvl.md' }, { label: 'About', file: 'content/about.md' }];
  const body = C.prBody({ summary: 'Fix the DVL heading', pages });
  assert.equal(body, 'Fix the DVL heading\n\nPages:\n- DVL (`content/setup/bluerov/dvl.md`)\n- About (`content/about.md`)\n\n'
    + 'Made in the site editor.\n');
  const linked = C.prBody({ summary: 'Fix', pages, reviewUrl: 'https://docs.example.org/cms/#/review/42' });
  assert.ok(linked.endsWith('Made in the site editor.\nReview it in the editor: https://docs.example.org/cms/#/review/42\n'));
  assert.equal(C.reviewUrl('https://docs.example.org', 42), 'https://docs.example.org/cms/#/review/42');
});

test('new project: exactly two files — the registry entry with the six keys, and content/projects/<id>.md', () => {
  const text = readRepo('data/projects.json');
  const form = { id: 'sonar-rig', name: 'Sonar rig', status: 'active', tagline: 'A tank rig for sonar tests.',
    repos: 'sonar_rig\n\n  sonar-rig-cad  \n', story: '## What it is\n\nA rig.' };
  const out = C.newProjectDraft(form, text);
  assert.equal(out.problem, null);
  assert.equal(out.id, 'sonar-rig');
  // three files since 2026-10-14 (the name keeps "two": the index entry and the page, plus the facts file)
  assert.deepEqual(Object.keys(out.files).sort(), ['content/projects/sonar-rig.md', 'data/projects.json', 'data/projects/sonar-rig.json']);
  assert.equal(out.files['content/projects/sonar-rig.md'], '## What it is\n\nA rig.\n');
  const doc = JSON.parse(out.files['data/projects.json']);
  assert.deepEqual(doc.projects.at(-1), { id: 'sonar-rig', add: [], remove: [] }, 'the index keeps only id, add and remove');
  const entry = Object.assign({ id: 'sonar-rig', add: [], remove: [] }, JSON.parse(out.files['data/projects/sonar-rig.json']));
  assert.deepEqual(Object.keys(entry), ['id', 'add', 'remove', 'name', 'status', 'tagline', 'file', 'repos']);
  // (the six keys of the name, plus add and remove since 2026-10-19: a new project starts with no one added;
  // commits give access once the daily refresh reads them)
  assert.deepEqual([entry.add, entry.remove], [[], []], 'a new project starts with empty add and remove lists');
  assert.ok(!('owners' in doc.projects.at(-1)), 'the old owners key is gone');
  assert.deepEqual(entry.repos, [
    { name: 'sonar_rig', url: 'https://github.com/HippoCampusRobotics/sonar_rig' },
    { name: 'sonar-rig-cad', url: 'https://github.com/HippoCampusRobotics/sonar-rig-cad' }]);
  assert.equal(entry.file, 'content/projects/sonar-rig.md');
  // the only change to the index is the added entry
  const before = JSON.parse(text);
  before.projects.push({ id: 'sonar-rig', add: [], remove: [] });
  assert.equal(out.files['data/projects.json'], C.formatLike(text, before));
  assert.equal(C.registryDraftProblem('data/projects.json', text, out.files['data/projects.json']), null);
  const listed = REGS.projects.projects[0].repos.find((r) => !r.external).name;
  const bad = (patch, re) => {
    const o = C.newProjectDraft(Object.assign({}, form, patch), text, REGS.projects);
    assert.match(String(o.problem), re, JSON.stringify(patch));
    assert.equal(o.files, null);
  };
  bad({ id: 'Sonar Rig' }, /id/);
  bad({ id: REGS.projects.projects[0].id }, /already/);
  bad({ name: '  ' }, /name/);
  bad({ status: 'shiny' }, /status/);
  bad({ tagline: '' }, /tagline/);
  bad({ repos: listed }, new RegExp(`${listed}.*already`));
  bad({ repos: 'a b' }, /repo/);
  bad({ repos: 'x\nx' }, /twice/);
  assert.match(C.newProjectDraft(form, '{"projects": [1,]}').problem, /line 1, column/);
  assert.match(C.newProjectDraft(form, '{"projects": 5}').problem, /projects/);
  assert.equal(C.PROJECT_STATUSES.join(','), 'active,maintained,legacy,archive');
});

test('new person: exactly name/title/photo/link in the chosen group; photo and link optional', () => {
  const text = readRepo('data/people.json');
  const out = C.addPersonText(text, { group: 'alumni', name: ' Ada Example ', title: 'Student', photo: '', link: '' });
  assert.equal(out.problem, null);
  const doc = JSON.parse(out.text);
  const before = JSON.parse(text);
  const alumni = doc.groups.find((g) => g.id === 'alumni');
  assert.deepEqual(alumni.people.at(-1), { name: 'Ada Example', title: 'Student', photo: null, link: null });
  assert.equal(alumni.people.length, before.groups.find((g) => g.id === 'alumni').people.length + 1);
  before.groups.find((g) => g.id === 'alumni').people.push(alumni.people.at(-1));
  assert.equal(out.text, C.formatLike(text, before), 'the added person is the whole diff');
  const linked = C.addPersonText(text, { group: 'active', name: 'B', title: '', photo: 'https://res.cloudinary.com/x/y.jpg',
    link: 'http://example.org' });
  assert.deepEqual(JSON.parse(linked.text).groups[0].people.at(-1),
    { name: 'B', title: '', photo: 'https://res.cloudinary.com/x/y.jpg', link: 'http://example.org' });
  const bad = (patch, re) => assert.match(String(C.addPersonText(text, Object.assign(
    { group: 'active', name: 'C', title: 'T', photo: '', link: '' }, patch)).problem), re, JSON.stringify(patch));
  bad({ group: 'nobody' }, /group/);
  bad({ name: '' }, /name/);
  bad({ photo: 'http://insecure.example/x.jpg' }, /photo.*https/);
  bad({ link: 'javascript:alert(1)' }, /link.*http/);
  bad({ name: before.groups[0].people[0].name }, /already/);
  assert.match(C.addPersonText('{"groups": [}', { group: 'a', name: 'x' }).problem, /line 1, column/);
  assert.deepEqual(C.personGroups(text).map((g) => g.id), ['active', 'alumni']);
  assert.deepEqual(C.personGroups('nope'), []);
});

test('my open proposals: open, mine, on a cms/<login>/ branch of this repository, based on main', () => {
  const pr = (n, o) => Object.assign({ number: n, title: `P${n}`, state: 'open', user: { login: 'Bob' },
    head: { ref: `cms/bob/p${n}-260920`, repo: { full_name: 'desert-mango/hippocampus-docs' } }, base: { ref: 'main' } }, o);
  const pulls = [pr(1), pr(2, { user: { login: 'eve' } }), pr(3, { head: { ref: 'feature/x', repo: { full_name: 'desert-mango/hippocampus-docs' } } }),
    pr(4, { head: { ref: 'cms/bob/p4', repo: { full_name: 'eve/hippocampus-docs' } } }), pr(5, { base: { ref: 'dev' } }),
    pr(6, { state: 'closed' }), pr(7, { head: { ref: 'cms/eve/p7', repo: { full_name: 'desert-mango/hippocampus-docs' } } }),
    pr(8), 'junk', null];
  assert.deepEqual(C.ownProposals(pulls, 'bob'), [
    { number: 1, title: 'P1', branch: 'cms/bob/p1-260920' }, { number: 8, title: 'P8', branch: 'cms/bob/p8-260920' }]);
  assert.deepEqual(C.ownProposals(null, 'bob'), []);
});

test('collectProposal: every changed file of the drafts that go in; two drafts on one path, a bad registry or a forbidden path refuse', () => {
  const base = { ref: 'main', sha: MAIN_SHA, number: null };
  const a = draftOf('about', 'content/about.md', 'Old\n', 'New\n', base);
  const b = { key: 'new/project', label: 'New project: X', route: '/projects/x', base,
    files: { 'data/projects.json': '{"projects": []}\n', 'content/projects/x.md': 'X\n' },
    originals: { 'data/projects.json': '{"projects": []}\n', 'content/projects/x.md': null } };
  const out = C.collectProposal([a, b]);
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.changes.map((c) => c.path), ['content/about.md', 'content/projects/x.md'],
    'an unchanged file of a draft does not go in');
  assert.deepEqual(out.changes[0], { path: 'content/about.md', text: 'New\n', original: 'Old\n', baseSha: MAIN_SHA });
  assert.deepEqual(out.pages, [{ label: 'about', file: 'content/about.md' }, { label: 'New project: X', file: 'content/projects/x.md' }]);
  const twice = C.collectProposal([a, draftOf('other', 'content/about.md', 'Old\n', 'Other\n', base)]);
  assert.match(twice.problems[0], /content\/about\.md.*two drafts/);
  const broken = C.collectProposal([draftOf('data/tools', 'data/tools.json', '{"tools": []}', '{"tools": [],}', base)]);
  assert.match(broken.problems[0], /trailing comma/);
  const machinery = C.collectProposal([draftOf('x', 'js/app.js', 'a', 'b', base)]);
  assert.match(machinery.problems[0], /never/);
  assert.match(C.collectProposal([]).problems[0], /nothing/i);
});

// ---------------------------------------------- Propose: the Git Data API --

const HEAD_B = '3'.repeat(40);
const TREE_B = '4'.repeat(40);
const OWN = 'cms/bob/fix-typo-260920';

/* Answers every write the way GitHub does, with fresh shas; `extra` can
   answer first (method, rest, body) -> reply | undefined. */
function writeAnswers(extra) {
  let k = 0;
  const next = () => (k += 1).toString(16).padStart(40, 'a');
  return (method, url, body) => {
    const rest = url.slice(REPO_API.length);
    const x = extra && extra(method, rest, body);
    if (x) return x;
    if (method === 'POST' && ['/git/blobs', '/git/trees', '/git/commits'].indexOf(rest) >= 0) return reply(201, { sha: next() });
    if (method === 'POST' && rest === '/git/refs') return reply(201, { ref: body.ref, object: { sha: body.sha } });
    if (method === 'PATCH' && rest.startsWith('/git/refs/heads/')) return reply(200, { object: { sha: body.sha } });
    if (method === 'POST' && rest === '/pulls') return reply(201, { number: 42 });
    if (method === 'PATCH' && /^\/pulls\/[0-9]+$/.test(rest)) return reply(200, { number: Number(rest.slice(7)) });
    return reply(500, { message: `unexpected ${method} ${rest}` });
  };
}

function recorded(github) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ method: init.method, rest: url.slice(REPO_API.length), body: init.body ? JSON.parse(init.body) : undefined });
    return github(url, init);
  };
  return { calls, client: C.createGitHubClient({ fetch, token: TOKEN }), seq: () => calls.map((c) => `${c.method} ${c.rest}`) };
}

const ownGithub = (extra) => baseGithub(Object.assign({
  refs: { main: MAIN_SHA, [OWN]: HEAD_B }, commits: { [MAIN_SHA]: MAIN_TREE, [HEAD_B]: TREE_B },
}, extra || {}));

const proposeOpts = (o) => Object.assign({ login: 'Bob', summary: 'Fix the DVL heading', now: NOW,
  origin: 'https://docs.example.org', target: null,
  changes: [{ path: SETUP_FILE, text: 'edited\n', original: SETUP_TEXT, baseSha: MAIN_SHA },
    { path: 'content/about.md', text: 'About.\n', original: null, baseSha: MAIN_SHA }],
  pages: [{ label: 'Page', file: SETUP_FILE }] }, o || {});

test('Propose: blobs -> one tree on main\'s tree -> one commit -> one ref -> one PR, in order, then the review link', async () => {
  const gh = recorded(editorGithub(baseGithub({ onWrite: writeAnswers() })));
  const out = await C.runPropose(gh.client, proposeOpts());
  const branch = 'cms/bob/fix-the-dvl-heading-260921';
  // U2a: plus the undo info (created, the new tip and its parent)
  assert.deepEqual(out, { ok: true, number: 42, branch, added: false, message: 'Proposed as #42.',
    created: true, sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa4', parent: MAIN_SHA });
  const paths = ['content/about.md', SETUP_FILE].sort();
  assert.deepEqual(gh.seq(), ['GET /git/ref/heads/main', `GET /git/commits/${MAIN_SHA}`,
    'POST /git/blobs', 'POST /git/blobs', 'POST /git/trees', 'POST /git/commits', 'POST /git/refs',
    'POST /pulls', 'PATCH /pulls/42']);
  const [, , b1, b2, tree, commit, ref, pull, patch] = gh.calls;
  const text = { [SETUP_FILE]: 'edited\n', 'content/about.md': 'About.\n' };
  assert.deepEqual([b1.body, b2.body], paths.map((p) => ({ content: text[p], encoding: 'utf-8' })), 'blobs in path order');
  const blob = (i) => (i + 1).toString(16).padStart(40, 'a');
  assert.deepEqual(tree.body, { base_tree: MAIN_TREE,
    tree: paths.map((p, i) => ({ path: p, mode: '100644', type: 'blob', sha: blob(i) })) });
  assert.deepEqual(commit.body, { message: 'Fix the DVL heading\n\nMade in the site editor.', tree: blob(2), parents: [MAIN_SHA] });
  assert.deepEqual(ref.body, { ref: `refs/heads/${branch}`, sha: blob(3) });
  assert.deepEqual(Object.keys(pull.body), ['title', 'head', 'base', 'body']);
  assert.equal(pull.body.title, 'Fix the DVL heading');
  assert.equal(pull.body.head, branch);
  assert.equal(pull.body.base, 'main');
  assert.equal(pull.body.body, C.prBody({ summary: 'Fix the DVL heading', pages: proposeOpts().pages }));
  assert.deepEqual(patch.body, { body: C.prBody({ summary: 'Fix the DVL heading', pages: proposeOpts().pages,
    reviewUrl: 'https://docs.example.org/cms/#/review/42' }) });
  // a failed review-link edit leaves the proposal standing
  const gh2 = recorded(editorGithub(baseGithub({ onWrite: writeAnswers((m, r) => (m === 'PATCH' ? reply(500, {}) : undefined)) })));
  assert.equal((await C.runPropose(gh2.client, proposeOpts())).ok, true);
});

test('Propose: adding to my own open proposal is one more commit on its branch and a ref move — no new PR', async () => {
  const gh = recorded(editorGithub(ownGithub({ onWrite: writeAnswers() })));
  const out = await C.runPropose(gh.client, proposeOpts({ target: { branch: OWN, number: 7 },
    changes: [{ path: SETUP_FILE, text: 'again\n', original: 'x\n', baseSha: HEAD_B }] }));
  // U2a: plus the undo info (not created; the new tip, its parent; no notes, so no earlier body read)
  assert.deepEqual(out, { ok: true, number: 7, branch: OWN, added: true, message: 'Added to your proposal #7.',
    created: false, sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3', parent: HEAD_B, prevBody: null });
  assert.deepEqual(gh.seq(), [`GET /git/ref/heads/${OWN}`, `GET /git/commits/${HEAD_B}`, 'POST /git/blobs',
    'POST /git/trees', 'POST /git/commits', `PATCH /git/refs/heads/${OWN}`]);
  assert.equal(gh.calls[3].body.base_tree, TREE_B, 'on the branch head\'s tree');
  assert.deepEqual(gh.calls[4].body.parents, [HEAD_B]);
  assert.deepEqual(gh.calls[5].body, { sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3', force: false });
  // someone else moved the branch: GitHub refuses the fast-forward
  const moved = recorded(editorGithub(ownGithub({ onWrite: writeAnswers((m) => (m === 'PATCH'
    ? reply(422, { message: 'Update is not a fast forward' }) : undefined)) })));
  const refusedMove = await C.runPropose(moved.client, proposeOpts({ target: { branch: OWN, number: 7 },
    changes: [{ path: SETUP_FILE, text: 'again\n', original: 'x\n', baseSha: HEAD_B }] }));
  assert.equal(refusedMove.ok, false);
  assert.match(refusedMove.message, /fast forward/);
});

test('Propose: a taken branch name retries -2 … -5; a file changed on GitHub since it was opened is refused before any write', async () => {
  let taken = 0;
  const gh = recorded(editorGithub(baseGithub({ onWrite: writeAnswers((m, r) => {
    if (m === 'POST' && r === '/git/refs' && taken < 2) { taken += 1; return reply(422, { message: 'Reference already exists' }); }
    return undefined;
  }) })));
  const out = await C.runPropose(gh.client, proposeOpts());
  assert.equal(out.branch, 'cms/bob/fix-the-dvl-heading-260921-3');
  const tried = 'refs/heads/cms/bob/fix-the-dvl-heading-260921';
  assert.deepEqual(gh.calls.filter((c) => c.rest === '/git/refs').map((c) => c.body.ref),
    [tried, `${tried}-2`, `${tried}-3`]);
  assert.equal(gh.calls.find((c) => c.rest === '/pulls').body.head, out.branch);
  const always = recorded(editorGithub(baseGithub({ onWrite: writeAnswers((m, r) => (m === 'POST' && r === '/git/refs'
    ? reply(422, { message: 'Reference already exists' }) : undefined)) })));
  const gaveUp = await C.runPropose(always.client, proposeOpts());
  assert.equal(gaveUp.ok, false);
  assert.equal(always.calls.filter((c) => c.rest === '/git/refs').length, 5);
  assert.ok(!always.calls.some((c) => c.rest === '/pulls'));
  // stale: opened at an older main; the file differs at main's head now
  const OLD = '9'.repeat(40);
  const stale = recorded(editorGithub(baseGithub({ onWrite: writeAnswers() })));
  const s = await C.runPropose(stale.client, proposeOpts({ changes: [{ path: SETUP_FILE, text: 'e\n', original: 'older\n', baseSha: OLD }] }));
  assert.equal(s.ok, false);
  assert.match(s.message, new RegExp(`${SETUP_FILE.replace(/[.]/g, '\\.')} changed on GitHub since you opened it`));
  assert.deepEqual(stale.seq().filter((x) => !x.startsWith('GET')), [], 'nothing written');
  // same text at the new head: it goes ahead; a "new" file that now exists does not
  const fine = recorded(editorGithub(baseGithub({ onWrite: writeAnswers() })));
  assert.equal((await C.runPropose(fine.client, proposeOpts({ changes: [{ path: SETUP_FILE, text: 'e\n', original: SETUP_TEXT, baseSha: OLD }] }))).ok, true);
  assert.ok(fine.seq().includes(`GET /contents/${SETUP_FILE}?ref=${MAIN_SHA}`));
  const exists = recorded(editorGithub(baseGithub({ onWrite: writeAnswers() })));
  assert.equal((await C.runPropose(exists.client, proposeOpts({ changes: [{ path: SETUP_FILE, text: 'e\n', original: null, baseSha: OLD }] }))).ok, false);
});

test('Propose: a 401 anywhere stops at once and says so; a refused path or branch sends nothing', async () => {
  const gh = recorded(editorGithub(baseGithub({ onWrite: writeAnswers((m, r) => (r === '/git/trees' ? reply(401, {}) : undefined)) })));
  const out = await C.runPropose(gh.client, proposeOpts());
  assert.equal(out.ok, false);
  assert.equal(out.status, 401);
  assert.equal(gh.seq().at(-1), 'POST /git/trees');
  // a 401 on the review-link edit: the proposal is open (never propose it twice), and the session ends
  const late = recorded(editorGithub(baseGithub({ onWrite: writeAnswers((m) => (m === 'PATCH' ? reply(401, {}) : undefined)) })));
  const opened = await C.runPropose(late.client, proposeOpts());
  assert.deepEqual([opened.ok, opened.number, opened.signedOut], [true, 42, true]);
  const none = recorded(editorGithub(baseGithub({ onWrite: writeAnswers() })));
  const bad = await C.runPropose(none.client, proposeOpts({ changes: [{ path: 'js/app.js', text: 'x', original: 'y', baseSha: MAIN_SHA }] }));
  assert.equal(bad.ok, false);
  assert.match(bad.message, /never/);
  const notMine = await C.runPropose(none.client, proposeOpts({ target: { branch: 'main', number: 7 } }));
  assert.equal(notMine.ok, false);
  assert.deepEqual(none.calls, [], 'nothing was sent');
  // the one builder refuses any ref that is not a proposal branch
  for (const branch of ['main', 'refs/heads/main', 'cms/../main', 'feature/x']) {
    assert.throws(() => C.proposeRequest('ref', { branch, sha: MAIN_SHA }), /proposal branch/, branch);
    assert.throws(() => C.proposeRequest('move', { branch, sha: MAIN_SHA }), /proposal branch/, branch);
    assert.throws(() => C.proposeRequest('pull', { branch, title: 't', body: 'b' }), /proposal branch/, branch);
  }
  assert.throws(() => C.proposeRequest('delete', {}), /no such step/);
});
}

// ------------------------------------- /cms/ rows, re-homed: the editor ---
/* The js/cms.js rows of the deleted test_cms_editor.mjs, run against Editor
   mode: #/pages is the Changes home plus the site itself, #/edit/<page> is
   the page on screen with its block (or whole-page) editor, the registries
   and New project / New person are tray routes, and Propose goes from the
   draft list. */

const TREE_M = '7'.repeat(40);          // main's tree, for git/commits/<main sha>
const REGS_NOW = {
  setup: JSON.parse(readRepo('data/setup.json')),
  // the project index merged with each project's facts file, as HC.fetchProjects reads it (2026-10-14)
  projects: (() => { const index = JSON.parse(readRepo('data/projects.json'));
    return C.mergeProjects(index, index.projects.map((e) => JSON.parse(readRepo(`data/projects/${e.id}.json`)))); })(),
  tools: JSON.parse(readRepo('data/tools.json')),
};
const PAGE_LABEL = C.pageList(REGS_NOW).find((p) => p.pageId === PAGE_ID).title;
const rawEditor = (page) => page.one((e) => e.tagName === 'TEXTAREA' && e.attrs['data-editor'] !== undefined);
const writeSeq = (writes) => writes.map((c) => `${c.method} ${c.url.slice(REPO_API.length)}`);

test('Data files and Edit whole page (U0b): every registry and facts file is listed, and every page opens as Markdown', async () => {
  const page = await editorOn({ variant: 'maintain' });     // a Maintainer edits every project (the edit gate)
  await page.dataFiles();
  // the registries, then each project's own facts file (2026-10-14), in the index's order
  const links = page.all((e) => e.tagName === 'A' && /^#\/edit\//.test(e.attrs.href || '')).map((a) => a.attrs.href);
  assert.deepEqual(links, [...C.RAW_REGISTRIES.map((f) => `#/edit/${f.slice(0, -5)}`),
    ...REGS_NOW.projects.projects.map((p) => `#/edit/data/projects/${p.id}`)]);
  page.action('tray-close').click();
  await settle();
  // every page of the registries' page tree is the site's own page: on screen, "Edit whole page" opens its file
  for (const p of C.pageList(REGS_NOW)) {
    await page.go(`#${p.route}`);
    await page.wholePage();
    // round 2 (R5): the Team page (content/about.md's route) is edited as its data, data/people.json
    const file = p.pageId === 'about' ? 'data/people.json' : p.file;
    const head = page.one((e) => e.tagName === 'CODE' && e.textContent === file);
    assert.ok(head, `${p.pageId}: the thin editor page names ${file}`);
    assert.ok(page.linkTo(C.pencilUrl(file)), `${p.pageId}: and its github.com pencil link`);
    page.action('tray-close').click();
    await settle();
  }
});

test('js/editor.js editor: a heading change reaches the preview frame through the draft, fresh nonce per reload', async () => {
  const page = await editorOn();
  await page.wholePage();          // U0b: the thin editor page, from the account menu
  const ta = page.editorTextarea();
  assert.equal(ta.value, PAGE_TEXT, 'the file at main\'s head');
  assert.equal(ta.readOnly, false);
  const frame = page.frame();
  assert.match(frame.srcs[0], new RegExp(`^index\\.html#preview=[0-9a-f]{32}&route=${encodeURIComponent(PAGE_ROUTE)}$`));
  assert.equal(frame.attrs.sandbox, 'allow-scripts allow-popups');
  assert.equal((await page.asks(PAGE_FILE)).text, C.withSentinels(PAGE_TEXT, page.nonce().slice(0, 16)));
  const edited = PAGE_TEXT.replace(/^(#+ .*)$/m, '$1 (edited)');
  assert.notEqual(edited, PAGE_TEXT);
  const loads = frame.srcs.length;
  await page.type(ta, edited);
  assert.equal(frame.srcs.length, loads + 1, 'the frame reloaded once for the change');
  assert.notEqual(frame.srcs.at(-1), frame.srcs.at(-2), 'with a fresh nonce');
  assert.equal((await page.asks(PAGE_FILE)).text, C.withSentinels(edited, page.nonce().slice(0, 16)),
    'the frame is served the draft');
  assert.equal((await page.asks('data/projects.json')).text, readRepo('data/projects.json'),
    'everything else comes from main\'s head');
  // the draft is in sessionStorage, keyed by the page
  const kept = draftsOf(page).get(PAGE_ID);
  assert.equal(kept.files[PAGE_FILE], edited);
  assert.equal(kept.base.sha, MAIN_SHA);
  assert.deepEqual(page.calls.filter((c) => c.method !== 'GET'), [], 'editing writes nothing to GitHub');
  // no token in anything the frame received or in its URL
  for (const x of frame.posted) assert.ok(!JSON.stringify(x.m).includes(TOKEN));
  for (const u of frame.srcs) assert.ok(!u.includes(TOKEN));
});

test('js/editor.js editor: snippet buttons and the internal link picker insert into the draft', async () => {
  const page = await editorOn();
  await page.wholePage();          // U0b: the snippet bar is the thin editor page's
  const ta = page.editorTextarea();
  ta.selectionStart = ta.selectionEnd = 0;
  page.one((e) => e.attrs['data-snippet'] === 'note').click();
  await settle();
  assert.ok(ta.value.startsWith('<div class="adm adm-note"><p class="adm-title">Note</p>'));
  const picker = page.one((e) => e.tagName === 'SELECT' && e.attrs['data-link-picker'] !== undefined);
  picker.value = 'setup/bluerov/dvl';
  ta.selectionStart = ta.selectionEnd = 0;
  page.action('insert-link').click();
  await settle();
  assert.match(ta.value, /^\[[^\]]+\]\(#\/setup\/bluerov\/dvl\)/);
  assert.equal(page.action('media-open'), undefined, 'no "Image from Media" since U0b ("+" Image in the page)');
  const d = draftsOf(page).get(PAGE_ID).files[PAGE_FILE];
  assert.ok(d.includes('adm-note') && d.includes('(#/setup/bluerov/dvl)'));
});

test('js/editor.js raw-JSON editor: a trailing comma is refused with line and column; an id change with the rule', async () => {
  const page = await editorOn();
  await page.dataFiles();
  await page.follow(page.linkTo('#/edit/data/projects'));
  const ta = rawEditor(page);
  const original = readRepo('data/projects.json');
  assert.equal(ta.value, original);
  assert.match(page.tray().textContent, /Locked ids/);
  assert.match(page.tray().textContent, /hippocampus-vehicle/);
  const frame = page.frame();
  const loads = frame.srcs.length;
  await page.type(ta, original.replace('"repo_count": 94\n', '"repo_count": 94,\n'));
  const problem = page.one((e) => e.attrs['data-problem'] !== undefined);
  assert.match(problem.textContent, /^data\/projects\.json, line \d+, column \d+: .*trailing comma/);
  assert.equal(problem.hidden, false);
  assert.equal(frame.srcs.length, loads, 'a broken registry is not previewed');
  assert.equal(page.action('propose').disabled, true);
  await page.type(ta, original.replace('"id": "uvms"', '"id": "uvms-renamed"'));
  assert.match(problem.textContent, /'uvms' was removed or renamed — renaming or removing an existing id needs Desert Mango — open an issue/);
  assert.equal(page.action('propose').disabled, true);
  await page.type(ta, original.replace('"repo_count": 94', '"repo_count": 95'));
  assert.equal(problem.hidden, true);
  assert.equal(page.action('propose').disabled, false);
  assert.equal(frame.srcs.length, loads + 1, 'a valid draft is previewed');
  assert.match((await page.asks('data/projects.json')).text, /"repo_count": 95/, 'the frame reads the draft');
});

test('js/editor.js editor: leaving a page with a draft that is not proposed asks first', async () => {
  const page = await editorOn();
  const asked = [];
  page.win.confirm = (text) => { asked.push(text); return false; };
  // a page's block draft stays when the reader moves on (the draft store, keyed by page): nothing is lost
  await page.pick(firstParagraph(PAGE_TEXT));
  await page.typeIn(firstParagraph(PAGE_TEXT), 'Changed.\n\n');
  await page.go(`#${OTHER_ROUTE}`);
  assert.deepEqual(asked, [], 'nothing to ask: the draft is kept');
  assert.ok(C.isDirty(draftsOf(page).get(PAGE_ID)), 'the draft stays');
  // the raw-JSON editor asks before its draft leaves the screen
  await page.dataFiles();
  await page.follow(page.linkTo('#/edit/data/site'));
  await page.follow(page.linkTo('#/edit'));          // "← Data files", no change yet: no question
  assert.deepEqual(asked, []);
  await page.follow(page.linkTo('#/edit/data/site'));
  await page.type(rawEditor(page), `${readRepo('data/site.json')}\n`);
  await page.follow(page.linkTo('#/edit'));
  assert.equal(asked.length, 1);
  assert.equal(asked[0], C.LEAVE_TEXT);
  assert.match(asked[0], /not proposed/);
  assert.ok(rawEditor(page), 'cancel stays on the page');
  // U1 (D21, ED63): closing the tab asks nothing — the page drafts are saved as they are typed
  assert.deepEqual(page.listeners.beforeunload || [], [], 'no beforeunload prompt');
  assert.ok(C.isDirty(draftsOf(page).get(PAGE_ID)), 'and the page draft is kept for the next visit');
});

test('js/editor.js Propose from a setup page: exactly blobs -> tree -> commit -> ref -> PR, then #/review/<n>', async () => {
  const { writes, onWrite } = recordWrites();
  const page = await editorOn({ onWrite, extra: { trees: { [MAIN_SHA]: TREE_M } } });
  const asked = [];
  page.win.confirm = (text) => { asked.push(text); return true; };
  await page.wholePage();          // U0b: the thin editor page; its Send for review sends at once
  const edited = PAGE_TEXT.replace(/^(#+ .*)$/m, '$1 (edited)');
  await page.type(page.editorTextarea(), edited);
  assert.equal(page.action('propose').textContent, 'Send for review');
  page.action('propose').click();
  await settle();
  assert.deepEqual(writeSeq(writes), ['POST /git/blobs', 'POST /git/trees', 'POST /git/commits', 'POST /git/refs',
    'POST /pulls', 'PATCH /pulls/42']);
  assert.deepEqual(writes[0].body, { content: edited, encoding: 'utf-8' });
  assert.deepEqual(writes[1].body.tree.map((e) => e.path), [PAGE_FILE], 'only that file');
  assert.equal(writes[1].body.base_tree, TREE_M, 'on main\'s tree');
  assert.equal(writes[4].body.title, `Edit ${PAGE_LABEL}`, 'titled "Edit <page>" (U2 generates the title)');
  assert.match(writes[3].body.ref, /^refs\/heads\/cms\/bob\/edit-[a-z0-9-]+-[0-9]{6}$/);
  assert.match(writes[5].body.body, /https:\/\/docs\.example\.org\/cms\/#\/review\/42/, 'the PR links its review (the redirect lands it)');
  assert.match(page.one((e) => e.classList.contains('hc-notice')).textContent, /#42/, 'said in the bubble; no review page opens');
  assert.equal(draftsOf(page).get(PAGE_ID), null, 'the draft went into the proposal');
  assert.deepEqual(asked, [], 'no leave question after proposing');
});

test('js/editor.js Propose: a 401 after the PR opened keeps it proposed (drafts gone) and ends the session', async () => {
  const rec = recordWrites();
  const onWrite = (method, url, body) => (method === 'PATCH' && /\/pulls\/42$/.test(url)
    ? (rec.writes.push({ method, url, body }), { status: 401, body: {} }) : rec.onWrite(method, url, body));
  const page = await editorOn({ onWrite, extra: { trees: { [MAIN_SHA]: TREE_M } } });
  await page.wholePage();
  await page.type(page.editorTextarea(), `${PAGE_TEXT}More.\n`);
  page.action('propose').click();
  await settle();
  // U1: the ended session also clears its cookie at this site (DELETE /api/auth), which is not a GitHub write
  const github = rec.writes.filter((w) => w.url.startsWith(REPO_API));
  assert.deepEqual(writeSeq(github).slice(-2), ['POST /pulls', 'PATCH /pulls/42'], 'the PR opened');
  assert.deepEqual(rec.writes.filter((w) => !w.url.startsWith(REPO_API)).map((w) => `${w.method} ${w.url}`),
    ['DELETE /api/auth'], 'the session cookie is cleared');
  assert.equal(draftsOf(page).get(PAGE_ID), null, 'never proposed twice');
  assert.equal(controlsOf(page).hidden, true, 'the session ended');
  assert.equal(page.sessions.at(-1), false, 'app.js hears it');
  assert.equal(page.body.classList.contains('hc-editor-on'), false);
  assert.match(page.told.at(-1).text, /Proposed as #42\. Your sign-in has ended/);
});

test('drafts: a /cms/ draft in sessionStorage is the Editor\'s draft of its page — the same key, nothing lost in the move', async () => {
  // a draft /cms/ kept (HCCore.createDraftStore over sessionStorage, key HCCore.DRAFTS_KEY) before the move
  const storage = memoryStorage();
  const changed = `${PAGE_TEXT}Kept across the move.\n`;
  C.createDraftStore(storage).put({ key: PAGE_ID, label: PAGE_LABEL, route: PAGE_ROUTE,
    files: { [PAGE_FILE]: changed }, originals: { [PAGE_FILE]: PAGE_TEXT }, base: { ref: 'main', sha: MAIN_SHA, number: null } });
  assert.ok(storage.getItem(C.DRAFTS_KEY), 'the one key both editors use');
  const page = await editorOn({ storage });
  assert.equal((await page.asks(PAGE_FILE)).text, C.withSentinels(changed, page.nonce().slice(0, 16)),
    'the page shows the draft');
  await page.wholePage();
  assert.equal(page.editorTextarea().value, changed, 'and edited from where it was left');
});

// ------------------------------------ /cms/ rows, re-homed: source rules ---
/* The js/cms.js rows of test_cms_core.mjs: the source-level promise (it
   holds for js/editor.js now) and the shell (cms/index.html is the redirect
   page), then the session races and the Review rows against the tray. */

test('js/editor.js reaches GitHub only through cms-core; every write is an allowlisted review or Propose request', () => {
  const ui = readRepo('js/editor.js');
  assert.ok(!ui.includes('api.github.com'), 'the UI never builds an API URL itself');
  assert.ok(!/\b(POST|PUT|PATCH|DELETE)\b/.test(ui),
    'the UI names no write verb: writes are HCCore.runReviewAction / runPropose, through the allowlist');
  assert.ok(!/\.send\s*\(/.test(ui), 'the UI never calls client.send() itself');
  // one wrapper hands the network to the client, the sign-in and the readers; no other call
  const WRAPPER = 'const netFetch = (url, init) => (fetchImpl ? fetchImpl(url, init) : window.fetch(url, init));';
  assert.equal(ui.split(WRAPPER).length, 2, 'exactly one fetch wrapper');
  assert.ok(!/\bfetch\s*\(/.test(ui.replace(WRAPPER, '').replace(/HC\.fetch(JSON|Text)\(/g, '')),
    'the UI calls no bare fetch (the client and the sign-in own the network)');
  assert.equal((ui.match(/\bnetFetch\b/g) || []).length, 9,
    'netFetch goes only to the sign-in, the two GitHub clients, the file cache\'s ref fetcher, '
    + 'the /api/media client, the signed direct upload to Cloudinary, the org reader '
    + 'and (U1) the sign-out\'s cookie clear, HCCore.forgetSession');
  const core = readRepo('js/cms-core.js');
  const verbs = core.match(/method:\s*'[A-Z]+'/g) || [];
  assert.deepEqual([...new Set(verbs)].sort(),
    ["method: 'DELETE'", "method: 'GET'", "method: 'PATCH'", "method: 'POST'", "method: 'PUT'"]);
  // U1: the sign-out DELETE goes to this site's /api/auth (clears the session cookie)
  const forget = core.slice(core.indexOf('function forgetSession'), core.indexOf('const SESSION_CHANNEL'));
  assert.ok(forget && /doFetch\(AUTH_FUNCTION, \{ method: 'DELETE'/.test(forget), 'the sign-out DELETE goes to /api/auth');
  // U2a: at GitHub the one delete is undo's drop-ref of a cms/ branch: the allowlist row and the Propose request only
  assert.deepEqual(core.replace(forget, '').match(/method:\s*'DELETE'/g), ["method: 'DELETE'", "method: 'DELETE'"]);
  // the write verbs appear only in the allowlist and the review / Propose requests it admits
  const allow = core.slice(core.indexOf('const WRITE_METHODS'), core.indexOf('function isAllowedWrite'));
  const review = core.slice(core.indexOf('function reviewRequest'), core.indexOf('const DONE_TEXT'));
  const propose = core.slice(core.indexOf('function proposeRequest'), core.indexOf('function proposeFailure'));
  assert.ok(allow && review && propose);
  // the media section POSTs twice and never to GitHub — to this site's
  // /api/media (the gateway client) and to the signed upload URL (Cloudinary)
  const media = core.slice(core.indexOf('const MEDIA_FUNCTION'), core.indexOf('function imageMarkdown'));
  assert.ok(media);
  assert.deepEqual(media.match(/method:\s*'(POST|PUT|PATCH)'/g), ["method: 'POST'", "method: 'POST'"]);
  assert.deepEqual(media.match(/\bfetch\((\w|\.)+,/g), ['fetch(MEDIA_FUNCTION,', 'fetch(plan.url,']);
  // (integration: the sign-out's own /api/auth DELETE, asserted above, is left out of the rest too)
  const rest = core.replace(forget, '').replace(allow, '').replace(review, '').replace(propose, '').replace(media, '');
  assert.ok(!/\bDELETE\b/.test(rest), 'outside the allowlist, the Propose requests and the sign-out, nothing deletes');
  assert.deepEqual((rest.match(/method:\s*'(POST|PUT|PATCH)'/g) || []), ["method: 'POST'"],
    'outside them, one POST: the sign-in exchange to /api/auth');
  for (const src of [ui, core]) {
    // (a repository name may hold dots, but never ends in one: that is a full stop)
    const repos = src.match(/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]*[A-Za-z0-9_-]/g) || [];
    for (const r of repos) assert.equal(r, 'repos/desert-mango/hippocampus-docs', r);
  }
});

test('cms/index.html: the redirect page loads only js/cms-redirect.js — no cms.js, no cms-core.js, no cms.css — noindex, and a way back to the site', () => {
  const html = readRepo('cms/index.html');
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(scripts, ['../js/cms-redirect.js']);
  assert.equal((html.match(/<script\b/gi) || []).length, 1, 'one script element, and it has a src: no inline script');
  assert.deepEqual(html.match(/<link\b[^>]*>/gi), null, 'no stylesheet at all (css/cms.css is retired)');
  assert.ok(!/cms\.js|cms-core|cms\.css/.test(html), 'neither the retired editor nor HCCore is named');
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /<a [^>]*href="\.\.\/"/);
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  for (const gone of ['js/cms.js', 'css/cms.css', 'tools/tests/test_cms_editor.mjs']) {
    assert.equal(fs.existsSync(path.join(ROOT, gone)), false, `${gone} is retired`);
  }
  // the App's callback page stays where it is (D-I): it is not the redirect page
  assert.ok(fs.existsSync(path.join(ROOT, 'cms', 'callback.html')));
});

// ----------------------------- /cms/ rows, re-homed: the session races ---

const TOKEN_A = '<yours>-token-a';
const TOKEN_B = '<yours>-token-b';
const bearer = (init) => String((init.headers && (init.headers.Authorization || init.headers.authorization)) || '')
  .replace(/^Bearer /, '');
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
const whoOf = (page) => (page.one((e) => e.classList.contains('hc-who')) || { textContent: '' }).textContent;

/* GitHub as one signed-in person sees it: /user, this repository (`repo` is
   its answer), no open PRs; anything else of GitHub's 404. */
function githubFor(login, repo) {
  return (url) => {
    if (url === 'https://api.github.com/user') return answer(200, { login });
    if (url === REPO_API) return repo;
    if (url.startsWith(`${REPO_API}/pulls?`)) return answer(200, []);
    return answer(404, { message: 'Not Found' });
  };
}
const asBob = () => githubFor('bob', answer(200, { permissions: { push: true } }));
const isGitHub = (url) => url.indexOf('https://api.github.com/') === 0;

/* alice's session (U1: held in page memory, as a reload gets it back from the cookie); `route` answers
   every GitHub call by token. */
function raceSite(route, editorState) {
  const storage = memoryStorage();
  if (editorState) storage.setItem('hc-editor', JSON.stringify(editorState));
  const page = openSite({ session: C.makeSession(TOKEN_A, null, 'alice', Date.now()), storage, hash: `#${PAGE_ROUTE}`,
    intercept: (url, init) => (isGitHub(url) ? route(url, init) : null) });
  return page;
}

/* Sign out (the avatar menu), then sign in as bob (the session a finished sign-in writes). */
async function signOutThenInAsBob(page) {
  page.action('sign-out').click();
  await settle();
  page.win.HCCore.writeSession(page.storage, C.makeSession(TOKEN_B, null, 'bob', Date.now()));
  page.win.HCEditor.refresh();
  await settle();
  assert.match(whoOf(page), /bob/);
  assert.match(whoOf(page), /Can edit/);   // U2 (ED5): the role chip names what you can do (was the role label "Editor")
}

test('js/editor.js: a refresh that lands after sign-out and a new sign-in changes nothing', async () => {
  const held = deferred();                       // alice's answers, held back
  const alice = githubFor('alice', answer(200, { permissions: { admin: true, push: true } }));
  const bob = asBob();
  const page = raceSite((url, init) => (bearer(init) === TOKEN_A ? held.promise.then(() => alice(url)) : bob(url)));
  await settle();
  assert.equal(page.switchBtn().disabled, true, 'checking your access: the switch waits');
  await signOutThenInAsBob(page);
  held.resolve();
  await settle();
  assert.match(whoOf(page), /bob/);
  assert.match(whoOf(page), /Can edit/);   // U2 (ED5): the role chip names what you can do (was the role label "Editor")
  assert.doesNotMatch(whoOf(page), /Admin|alice/, 'the old answer wrote nothing');
  assert.equal(page.win.HCCore.readSession(page.storage, Date.now()).login, 'bob');
});

test('js/editor.js: a "no access" answer that lands after sign-out leaves the signed-out page alone', async () => {
  const held = deferred();
  const alice = githubFor('alice', answer(404, { message: 'Not Found' }));
  const page = raceSite((url) => held.promise.then(() => alice(url)));
  await settle();
  page.action('sign-out').click();
  await settle();
  held.resolve();
  await settle();
  assert.equal(controlsOf(page).hidden, true, 'signed out: no switch, no avatar');
  assert.equal(page.sessions.at(-1), false, 'app.js shows "Sign in to edit" again');
  assert.doesNotMatch(page.tray().textContent, /do not have access/);
  assert.ok(!page.told.some((t) => /do not have access/.test(t.text)));
  assert.equal(page.told.at(-1).text, 'Signed out.');
});

test('js/editor.js: an old session\'s 401 does not end the session that replaced it', async () => {
  const held = deferred();
  const bob = asBob();
  const page = raceSite((url, init) => (bearer(init) === TOKEN_A
    ? held.promise.then(() => answer(401, { message: 'Bad credentials' })) : bob(url)));
  await settle();
  await signOutThenInAsBob(page);
  held.resolve();
  await settle();
  assert.equal(page.win.HCCore.readSession(page.storage, Date.now()).login, 'bob');
  assert.match(whoOf(page), /bob/);
  assert.ok(!page.told.some((t) => /sign-in has ended/.test(t.text)));
});

test('js/editor.js: a 401 for a list the old session asked for does not end the new session', async () => {
  const held = deferred();
  const alice = githubFor('alice', answer(200, { permissions: { push: true } }));
  const bob = asBob();
  // Editor on with the Proposals tab open (the reload of a tab that had it): the lists are asked at once
  const page = raceSite((url, init) => {
    if (bearer(init) !== TOKEN_A) return bob(url);
    if (url.includes('/pulls?')) return held.promise.then(() => answer(401, { message: 'Bad credentials' }));
    return alice(url);
  }, { on: true, tab: 'proposals', tray: true });
  await settle();
  assert.match(whoOf(page), /alice/, 'signed in; the Proposals tab waits on its lists');
  assert.ok(page.calls.some((c) => c.url.includes('/pulls?')), 'the old session asked for a list');
  await signOutThenInAsBob(page);
  held.resolve();
  await settle();
  assert.equal(page.win.HCCore.readSession(page.storage, Date.now()).login, 'bob');
  assert.match(whoOf(page), /bob/);
  assert.ok(!page.told.some((t) => /sign-in has ended/.test(t.text)));
});

// --------------------------------- /cms/ rows, re-homed: shared fakes ---
/* (U0b removed the Review card and the proposals list these rows ran against: /cms/'s #/, #/review and
   #/review/<n> redirect to the page now, tools/tests/test_editor_u0b.mjs. The fakes below serve the rows left.) */


const runs = (...rs) => ({ total_count: rs.length, check_runs: rs });

// an answer whose body is raw text when given a string (the Contents API's raw media type)
const wire = (status, body) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null },
    text: async () => text, json: async () => JSON.parse(text) };
};


const logged = (o) => {
  const log = [];
  return { log, onWrite: (method, url, body) => { log.push({ method, url, body }); return o ? o(method, url, body) : wire(200, {}); } };
};

// ----------------------------------------- /cms/ rows, re-homed: Media ---
/* The js/cms.js rows of test_cms_media.mjs went with the Media tab, "Image from Media" and New person's "Photo
   from Media" (U0b). The fakes stay for the in-page image rows (V2 images): a fake /api/media and a fake
   Cloudinary. */

const MANIFEST_TEXT = readRepo('data/cloudinary-manifest.json');
const LIVE = JSON.parse(MANIFEST_TEXT);
const CLOUD = LIVE.cloud;
const TS = '1790000000';
const SIG = 'a'.repeat(64);
const API_KEY = '123456789012345';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const fakeFile = (bytes, o) => Object.assign({ name: 'Hippo Mark.png', type: 'image/png', size: bytes.length,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }, o || {});
function signed(mode, sub, slug) {
  const s = sub || 'setup';
  const folder = `hippocampus-docs/${s}`;
  const params = mode === 'dynamic'
    ? { asset_folder: folder, overwrite: 'false', public_id: `${folder}/${slug || 'hippo-mark'}`, timestamp: TS }
    : { folder, overwrite: 'false', public_id: slug || 'hippo-mark', timestamp: TS };
  return { cloud_name: CLOUD, api_key: API_KEY, timestamp: Number(TS), signature: SIG, params };
}
const uploaded = (id, bytes) => ({ public_id: id, version: 1790000001, format: 'png', bytes: bytes || 2048,
  secure_url: `https://res.cloudinary.com/${CLOUD}/image/upload/v1790000001/${id}.png` });

/* This site's /api/media and Cloudinary's upload endpoint; every request is
   logged with the side it went to. GitHub is the fake (main, its files). */
function mediaWorld(o) {
  const x = o || {};
  const log = [];
  const intercept = (url, init) => {
    if (url === '/api/media') {
      const body = JSON.parse(init.body);
      log.push({ side: 'media', url, init, body });
      if (x.media && x.media[body.action]) return x.media[body.action](body);
      if (body.action === 'sign') return wire(200, signed(x.mode || 'fixed', body.subfolder));
      if (body.action === 'list') {
        const pages = x.pages || { first: { assets: [], next_cursor: null } };
        return wire(200, pages[body.cursor || 'first']);
      }
      if (body.action === 'destroy') return wire(200, { result: 'ok', public_id: body.public_id });
      return wire(400, { error: 'unexpected' });
    }
    if (url.startsWith('https://api.cloudinary.com/')) {
      log.push({ side: 'cloudinary', url, init, body: init.body });
      const folder = init.body.entries.find((e) => e[0] === 'folder')[1].split('/').pop();
      return wire(200, uploaded(`hippocampus-docs/${folder}/hippo-mark`, 2048));
    }
    return null;
  };
  return { intercept, media: () => log.filter((c) => c.side === 'media'), cloud: () => log.filter((c) => c.side === 'cloudinary') };
}
const draftOfKey = (page, key) => draftsOf(page).get(key);

/* V2 (Kyle, 2026-10-14): images are edited IN the page. "+" Image, or a click on an image, asks for a file
   (the browser's dialog); the file goes through the Media gateway (one manifest entry in the image-list draft)
   and the block's address is replaced in my draft by its span. A drag (hc-block-move) moves an image block,
   and only an image block, in my draft. */
async function imageWorld() {
  const w = mediaWorld();
  const page = await editorOn({ intercept: w.intercept });
  await page.send({ type: 'hc-ready' });
  let asked = 0;
  const input = () => page.one((e) => e.classList.contains('hc-image-input'));
  return { w, page, input, asked: () => asked, watch() { input().click = () => { asked += 1; }; } };
}

test('V2 images: "+" Image asks for a file at once; the upload replaces the address (alt from the file name); nothing opens', async () => {
  const { w, page, input, asked, watch } = await imageWorld();
  const i = firstParagraph(PAGE_TEXT);
  await page.send({ type: 'hc-block-insert', index: i, kind: 'image' });
  assert.ok(input(), 'the file input exists once asked');
  watch();
  await page.send({ type: 'hc-block-insert', index: i, kind: 'image' });   // a second image: asked again
  assert.equal(asked(), 1, 'the browser\'s file dialog was opened from the click');
  const before = draftOfKey(page, PAGE_ID).files[PAGE_FILE];
  const k = blocksOf(before).findIndex((b) => b.kind === 'image');
  assert.match(blocksOf(before)[k].text, /^!\[Describe the image\]\(\)/);
  assert.equal(page.editorMessages().at(-1).open, null, 'an image is not opened for typing');
  input().files = [fakeFile(PNG)];
  input().fire('change');
  await settle();
  assert.deepEqual(w.media().map((c) => c.body.action), ['sign'], 'signed once, then uploaded to Cloudinary');
  assert.equal(w.cloud().length, 1);
  const url = `https://res.cloudinary.com/${CLOUD}/image/upload/v1790000001/hippocampus-docs/setup/hippo-mark.png`;
  const after = draftOfKey(page, PAGE_ID).files[PAGE_FILE];
  const j = blocksOf(after).findIndex((b) => b.kind === 'image' && b.text.includes(url));
  assert.ok(j >= 0, 'the image block points at the new file');
  assert.match(blocksOf(after)[j].text, /^!\[Hippo Mark\]\(/, 'the placeholder alt gave way to the file name');
  assert.equal(after.length - before.length, url.length + 'Hippo Mark'.length - 'Describe the image'.length, 'nothing else changed');
  assert.equal(JSON.parse(draftOfKey(page, C.MANIFEST_KEY).files[C.MANIFEST_FILE]).assets.at(-1).url, url, 'one manifest entry');
  assert.match(page.one((e) => e.classList.contains('hc-notice')).textContent, /Image replaced/);
});

test('V2 images: a click on an image asks for a file again; an unchanged file name keeps a real alt; a bad file is refused in words', async () => {
  const { w, page, input, asked, watch } = await imageWorld();
  const i = firstParagraph(PAGE_TEXT);
  await page.send({ type: 'hc-block-insert', index: i, kind: 'image' });
  watch();
  const k = blocksOf(draftOfKey(page, PAGE_ID).files[PAGE_FILE]).findIndex((b) => b.kind === 'image');
  await page.send({ type: 'hc-block-select', index: k });
  assert.equal(asked(), 1);
  input().files = [fakeFile(PNG, { size: C.MEDIA_MAX_BYTES + 1 })];
  input().fire('change');
  await settle();
  assert.match(page.one((e) => e.classList.contains('hc-notice')).textContent, /Keep images under 5 MB/);
  assert.equal(w.media().length, 0, 'no gateway call for a file that is too big');
});

test('V2 images: hc-block-move moves an image block in my draft and reloads; a text block or a forged message moves nothing', async () => {
  const { page } = await imageWorld();
  const i = firstParagraph(PAGE_TEXT);
  await page.send({ type: 'hc-block-insert', index: i, kind: 'image' });
  const text = draftOfKey(page, PAGE_ID).files[PAGE_FILE];
  const k = blocksOf(text).findIndex((b) => b.kind === 'image');
  const srcs = page.frame().srcs.length;
  await page.send({ type: 'hc-block-move', index: k, to: 0 });
  assert.equal(draftOfKey(page, PAGE_ID).files[PAGE_FILE], C.moveBlock(text, k, 0));
  assert.ok(page.frame().srcs.length > srcs, 'the frame reloads to show it');
  const moved = draftOfKey(page, PAGE_ID).files[PAGE_FILE];
  const p = blocksOf(moved).findIndex((b) => b.kind === 'paragraph');
  await page.send({ type: 'hc-block-move', index: p, to: 0 });
  assert.equal(draftOfKey(page, PAGE_ID).files[PAGE_FILE], moved, 'a paragraph is not moved by drag');
  await page.send({ type: 'hc-block-move', index: 0, to: 5 }, { source: { postMessage() {} } });
  assert.equal(draftOfKey(page, PAGE_ID).files[PAGE_FILE], moved, 'another window cannot move anything');
});

test('V2 images: an upload that finishes after the page changed replaces THE image that asked, or nothing (no stray manifest entry)', async () => {
  const { page, input, watch } = await imageWorld();
  const i = firstParagraph(PAGE_TEXT);
  await page.send({ type: 'hc-block-insert', index: i, kind: 'image' });
  watch();
  const text = draftOfKey(page, PAGE_ID).files[PAGE_FILE];
  const k = blocksOf(text).findIndex((b) => b.kind === 'image');
  // the image moves to the top while... (the move lands before the file is chosen; the index it asked with is stale)
  await page.send({ type: 'hc-block-select', index: k });
  await page.send({ type: 'hc-block-move', index: k, to: 0 });
  input().files = [fakeFile(PNG)];
  input().fire('change');
  await settle();
  const after = draftOfKey(page, PAGE_ID).files[PAGE_FILE];
  const url = `https://res.cloudinary.com/${CLOUD}/image/upload/v1790000001/hippocampus-docs/setup/hippo-mark.png`;
  assert.ok(blocksOf(after)[0].text.startsWith(`![Hippo Mark](${url})`), 'the moved image got the file');
  assert.equal(blocksOf(after).filter((b) => b.text.includes(url)).length, 1, 'and only it');
});

test('V2 images: a reference-style image (![alt][ref]) is replaced too, as an inline image; the definition stays', async () => {
  const text = `${PAGE_TEXT.trimEnd()}\n\n![wiring diagram][fig]\n\n[fig]: https://res.cloudinary.com/x/old.png\n`;
  const w = mediaWorld();
  const page = await editorOn({ intercept: w.intercept, files: { [PAGE_FILE]: text } });
  await page.send({ type: 'hc-ready' });
  const k = blocksOf(text).findIndex((b) => b.kind === 'image');
  let asked = 0;
  await page.send({ type: 'hc-block-select', index: 0 });             // a text block first
  assert.equal(page.one((e) => e.classList.contains('hc-image-input')), undefined, 'nothing asked for a text block');
  await page.send({ type: 'hc-block-select', index: k });
  const input = page.one((e) => e.classList.contains('hc-image-input'));
  assert.ok(input, 'the image asked for a file');
  input.click = () => { asked += 1; };
  assert.equal(page.editorMessages().at(-1).open, null, 'not opened for typing');
  input.files = [fakeFile(PNG)];
  input.fire('change');
  await settle();
  const url = `https://res.cloudinary.com/${CLOUD}/image/upload/v1790000001/hippocampus-docs/setup/hippo-mark.png`;
  const after = draftOfKey(page, PAGE_ID).files[PAGE_FILE];
  assert.ok(after.includes(`![wiring diagram](${url})\n\n[fig]: https://res.cloudinary.com/x/old.png\n`));
  assert.equal(asked, 0);
});

test('V2: a message (or the image picker\'s button) unfolds a tucked bubble, without taking the focus', async () => {
  const { page } = await imageWorld();
  page.action('dock-collapse').click();
  await settle();
  assert.ok(page.body.classList.contains('hc-dock-collapsed'));
  page.win.navigator = { userActivation: { isActive: false } };     // the click's activation is gone
  const i = firstParagraph(PAGE_TEXT);
  await page.send({ type: 'hc-block-insert', index: i, kind: 'image' });
  assert.equal(page.body.classList.contains('hc-dock-collapsed'), false, 'the bubble unfolded');
  assert.ok(page.action('image-pick'), 'with "Pick the new image" in it');
  assert.equal(page.one((e) => e.classList.contains('hc-dock')).attrs.inert, undefined, 'and it is not inert');
});

/* Edit access (Kyle, 2026-10-19): a Write member who is an editor of a project (main's
   data/graph/edit-access.json, built by tools/build_edit_access.py from commits plus the admins' add and remove
   lists) sees Approve and Merge on someone else's proposal that only touches that project; not on their own;
   not when it also touches another file; not when an admin removed them. */
const ACCESS_FILE = 'data/graph/edit-access.json';
const accessText = (editors, removed) => `${JSON.stringify({ note: 'test', projects: {
  'learning-to-swim': { repos: 2, editors: editors.map((login) => ({ login, why: 'commits', repos_with_commits: 1 })),
    removed: (removed || []).map((login) => ({ login, had_commits: true })) },
  'core-stack': { repos: 15, editors: editors.map((login) => ({ login, why: 'commits', repos_with_commits: 2 })),
    removed: (removed || []).map((login) => ({ login, had_commits: true })) } } }, null, 1)}\n`;

test('edit access: a granting copy of edit-access.json served by the site (the deployment) is ignored: only main\'s, through GitHub', async () => {
  // U0b: seen through the edit gate on the project page (the review card that showed Approve is gone)
  const granting = JSON.parse(accessText(['bob']));                       // what a branch's preview deployment might serve
  const page = await editorOn({ hash: '#/projects/core-stack', hc: { [ACCESS_FILE]: granting }, files: { [ACCESS_FILE]: accessText([]) } });
  assert.ok(!page.hcReads.includes(ACCESS_FILE), 'the site\'s own copy is never even read');
  assert.ok(page.calls.some((c) => /\/contents\/data\/graph\/edit-access\.json\?ref=[0-9a-f]{40}/.test(c.url)), 'main\'s file, through GitHub');
  const lock = page.one((e) => e.classList.contains('hc-dock-lock') && !e.hidden);
  assert.match(lock.textContent, /You can't edit this project\./, 'main lists no editor: the page stays locked');
  assert.match(lock.textContent, /You have no commits in this project's repos yet\./);
});

test('edit access: read again from the site after a minute, so a changed list shows without a reload', async () => {
  // U0b: the edit gate reads it (the review card that read it for Approve is gone)
  const page = await editorOn({ hash: '#/projects/core-stack', files: { [ACCESS_FILE]: accessText(['bob']) } });
  const reads = () => page.calls.filter((c) => /\/contents\/data\/graph\/edit-access\.json\?ref=/.test(c.url)
    || /\/git\/ref\/heads\/main$/.test(c.url)).length;
  assert.ok(page.calls.some((c) => /\/contents\/data\/graph\/edit-access\.json\?ref=[0-9a-f]{40}/.test(c.url)), 'main\'s file, through GitHub');
  const redraw = async () => { await page.go(`#${OTHER_ROUTE}`); await page.go('#/projects/core-stack'); };
  const first = reads();
  await redraw();
  assert.equal(reads(), first, 'kept for a minute');
  const D = vm.runInContext('Date', page.win);                    // the editor's own clock
  const realNow = D.now;
  try {
    D.now = () => realNow.call(D) + 61 * 1000;
    await redraw();
  } finally { D.now = realNow; }
  assert.ok(reads() > first, 'read again after the minute');
});

test('edit access: the bubble on a project page says what you can do there, in one line (U0b: the Changes tab\'s line is gone)', async () => {
  const line = (page) => { const l = page.one((e) => e.classList.contains('hc-dock-lock') && !e.hidden); return l ? l.textContent : null; };
  let page = await editorOn({ hash: '#/projects/core-stack', files: { [ACCESS_FILE]: accessText(['bob']) } });
  assert.equal(line(page), 'You can edit this project: you have commits in 2 of its 15 repos.');
  page = await editorOn({ hash: '#/projects/core-stack', files: { [ACCESS_FILE]: accessText([]) } });
  assert.match(line(page), /You have no commits in this project's repos yet\./);
  page = await editorOn({ hash: '#/projects/core-stack', files: { [ACCESS_FILE]: accessText([], ['bob']) } });
  assert.match(line(page), /An admin removed your access to this project\./);
  page = await editorOn({ hash: '#/projects/core-stack', variant: 'maintain', files: { [ACCESS_FILE]: accessText([]) } });
  assert.equal(line(page), 'You can edit every project (Maintainer).');
  // not a project page: no line
  page = await editorOn({ files: { [ACCESS_FILE]: accessText(['bob']) } });
  assert.equal(line(page), null);
});

test('Data files (2026-10-14): each project\'s facts file is listed and opens as raw JSON; the index stays in the registries list', async () => {
  const page = await editorOn();
  await page.dataFiles();
  const link = page.linkTo('#/edit/data/projects/learning-to-swim');
  assert.ok(link, 'the facts file of Learning to Swim is listed');
  assert.match(link.textContent, /data\/projects\/learning-to-swim\.json/);
  assert.ok(page.linkTo('#/edit/data/projects'), 'the index (ids, add and remove) is still a registry');
  await page.follow(link);
  const ta = rawEditor(page);
  assert.ok(ta, 'it opens in the raw JSON editor');
  assert.equal(JSON.parse(ta.value).file, 'content/projects/learning-to-swim.md');
});

test('New project (2026-10-14): a repository another project already holds in its facts file is refused before any draft', async () => {
  // U0b: the form is gone; its draft rule is HCEditor.helpers.makeProjectDraft (U6's dialog builds on it)
  const page = await editorOn();
  const taken = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/projects/acoustics.json'), 'utf8')).repos.find((r) => !r.external).name;
  const H = page.win.HCEditor.helpers;
  const out = await H.makeProjectDraft(Object.assign({}, H.newProjectForm().defaults,
    { id: 'sonar-rig', name: 'Sonar rig', status: 'active', tagline: 'A tank rig.', repos: taken }), { ref: 'main', number: null });
  assert.match(out.problem, new RegExp(`${taken}.*already listed in project 'acoustics'`));
  assert.equal(out.d, undefined);
  assert.equal(draftsOf(page).get('new/project'), null);
});


/* U4b (plan-final §7 Drafts): a draft survives a closed tab (localStorage), belongs to its login, is deleted at
   Sign out (asked first), and a second tab changing the same page is said out loud. */
async function typedDraft(page) {
  const i = firstParagraph(PAGE_TEXT);
  await page.pick(i);
  await page.typeIn(i, `${blocksOf(PAGE_TEXT)[i].text.trimEnd()} One more line.\n\n`);   // U0b: typed in the page
  return i;
}

test('U4b: a draft survives a closed tab, and only for its own login', async () => {
  const a = await editorOn();
  await typedDraft(a);
  assert.ok(draftsOf(a).get(PAGE_ID), 'kept in localStorage');
  assert.equal(a.storage.getItem(C.DRAFTS_KEY), null, 'not in the tab\'s sessionStorage');
  // the tab is closed; a new one opens (a fresh sessionStorage, the same browser's localStorage)
  const b = await editorOn({ localStorage: a.local });
  assert.match(b.one((e) => e.attrs['data-dock-count'] !== undefined).textContent, /1 page changed/, 'the draft is back');   // U2 (ED45): per page
  // another person on the same browser sees none of it
  const c = await editorOn({ localStorage: a.local, session: C.makeSession(TOKEN, null, 'alice', Date.now()) });
  assert.equal(draftsOf(c).list().length, 0);
  assert.equal(c.one((e) => e.attrs['data-dock-count'] !== undefined).textContent, '');   // U2 (ED7): no "No changes yet"
});

test('U4b, U1 (ED63): Sign out keeps the login\'s drafts and asks nothing; they are back at the next sign-in', async () => {
  // U1 (D21, ED63) reversed U4b's "Sign out asks, then deletes the login's drafts"
  let page = await editorOn({ confirm: false });
  await typedDraft(page);
  page.action('sign-out').click();
  await settle();
  assert.deepEqual(page.confirms, [], 'no question');
  assert.equal(page.sessions.at(-1), false, 'signed out');
  assert.ok(draftsOf(page).get(PAGE_ID), 'kept in this browser');
  page = await editorOn({ localStorage: page.local });
  assert.equal(C.createDraftStore(page.local, C.draftsKey('bob')).list().length, 1, 'back at the next sign-in');
});

test('U4b: an older tab\'s sessionStorage drafts move into the login\'s store once', async () => {
  const storage = memoryStorage();
  C.createDraftStore(storage).put({ key: PAGE_ID, label: 'FCU firmware', route: PAGE_ROUTE,
    files: { [PAGE_FILE]: `${PAGE_TEXT}\nMoved.\n` }, originals: { [PAGE_FILE]: PAGE_TEXT },
    base: { ref: 'main', sha: MAIN_SHA, number: null } });
  const page = await editorOn({ storage });
  assert.equal(draftsOf(page).get(PAGE_ID).files[PAGE_FILE], `${PAGE_TEXT}\nMoved.\n`);
  assert.equal(storage.getItem(C.DRAFTS_KEY), null, 'gone from the session');
});

test('U4b: another tab changing the same page is said in the bubble; another page is merged quietly', async () => {
  const page = await editorOn();
  await typedDraft(page);
  const notice = () => page.one((e) => e.classList.contains('hc-notice'));
  const other = C.createDraftStore(page.local, C.draftsKey('bob'));
  other.put({ key: 'about', label: 'About', route: '/about', files: { 'content/about.md': 'New\n' },
    originals: { 'content/about.md': 'Old\n' }, base: { ref: 'main', sha: MAIN_SHA, number: null } });
  for (const fn of page.listeners.storage || []) fn({ key: `${C.draftsKey('bob')}/x` });
  await settle();
  assert.ok(notice().hidden || !/another tab/.test(notice().textContent), 'another page: quiet');
  assert.ok(draftsOf(page).get('about'), 'and kept');
  const theirs = other.get(PAGE_ID);
  theirs.files[PAGE_FILE] += 'Typed in the other tab.\n';
  other.put(theirs);
  for (const fn of page.listeners.storage || []) fn({ key: `${C.draftsKey('bob')}/x` });
  await settle();
  assert.match(notice().textContent, /also being changed in another tab/);
});

test('U4b: a sign-out in another tab deletes this tab\'s copy too: the draft is not written back', async () => {
  const page = await editorOn();
  await typedDraft(page);
  assert.ok(draftsOf(page).get(PAGE_ID));
  C.createDraftStore(page.local, C.draftsKey('bob')).clear();                 // the other tab signed out
  for (const fn of page.listeners.storage || []) fn({ key: `${C.draftsKey('bob')}/${encodeURIComponent(PAGE_ID)}`, newValue: null });
  await settle();
  assert.match(page.one((e) => e.classList.contains('hc-notice')).textContent, /removed in another tab/);
  assert.equal(draftsOf(page).list().length, 0, 'nothing written back');
  assert.equal(page.one((e) => e.attrs['data-dock-count'] !== undefined).textContent, '');   // U2 (ED7): no "No changes yet"
});

test('U4b: older tab drafts are never handed to another person, and are kept when localStorage refuses them', async () => {
  const legacy = () => {
    const storage = memoryStorage();
    C.createDraftStore(storage).put({ key: PAGE_ID, label: 'FCU firmware', route: PAGE_ROUTE,
      files: { [PAGE_FILE]: `${PAGE_TEXT}\nOld tab.\n` }, originals: { [PAGE_FILE]: PAGE_TEXT },
      base: { ref: 'main', sha: MAIN_SHA, number: null } });
    return storage;
  };
  // localStorage that refuses every write (private mode, quota): the old copy stays where it was
  const full = Object.assign(memoryStorage(), { setItem() { throw new Error('quota'); } });
  let storage = legacy();
  await editorOn({ storage, localStorage: full });
  assert.ok(storage.getItem(C.DRAFTS_KEY), 'kept in the session: nothing was written');
  // the restored session's own drafts move (the case the earlier test covers); a session that is not the
  // tab's restored one gets none: simulated with the store bound for a login the tab did not restore
  storage = legacy();
  const page = await editorOn({ storage });
  const local = page.local;
  assert.ok(C.createDraftStore(local, C.draftsKey('bob')).get(PAGE_ID), 'bob restored this tab: his');
  assert.equal(C.createDraftStore(local, C.draftsKey('alice')).list().length, 0, 'never alice\'s');
});

// ---- the edit palette (Kyle 2026-10-21, after round 2's all-magenta): the Editor chrome is the site's blue, and
// the change colour (yellow in dark, orange in light) marks changed text only. Contrast holds wherever Kyle did not
// choose exact colours over it: his light-theme blue #2391FF and orange #FF7F50 are pinned instead ----
test('edit palette: blue chrome, the change colour only on change marks, Kyle\'s exact colours, contrast elsewhere', () => {
  const site = fs.readFileSync(path.join(ROOT, 'css', 'site.css'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'css', 'editor.css'), 'utf8');
  const block = (src, sel, marker) => {
    const re = new RegExp(`${sel.replace(/[[\]"().]/g, '\\$&')}\\s*\\{([^}]*${marker}[^}]*)\\}`);
    const m = re.exec(src);
    assert.ok(m, `${sel} block with ${marker}`);
    const vars = {};
    for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) vars[k] = v;
    return vars;
  };
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const lum = (hex) => {
    const [r, g, b] = rgb(hex).map((c) => c / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  // the chrome and its text are the site's own blue, in both themes (no darker text shade: Kyle's exact colours)
  assert.match(css, /:root\s*\{[^}]*--hc-edit:\s*var\(--accent\);[^}]*--hc-edit-ink:\s*var\(--accent\);/, '--hc-edit is the site blue');
  assert.doesNotMatch(css, /--hc-edit-ink:\s*color-mix/, 'no darker blue for text');
  // Kyle's exact values (2026-10-21)
  assert.equal(block(site, '[data-theme="light"]', '--bg:').accent.toUpperCase(), '#2391FF', 'light: the site blue');
  assert.equal(block(site, ':root', '--bg:').accent.toLowerCase(), '#38bdf8', 'dark: the site blue is unchanged');
  assert.equal(block(css, ':root', '--hc-mark:')['hc-mark'].toUpperCase(), '#FFD166', 'dark: the change colour is yellow');
  assert.equal(block(css, '[data-theme="light"]', '--hc-mark:')['hc-mark'].toUpperCase(), '#FF7F50', 'light: the change colour is orange');
  assert.equal(block(site, ':root', '--bg:').active.toUpperCase(), '#06D6A0', 'the "active" badge green');
  assert.match(site, /\.badge\.active\s*\{\s*color:\s*var\(--active\);/, 'the "active" badge uses it');
  assert.match(site, /\[data-theme="light"\]\s*\{[^}]*--note-warn:\s*#FF7F50;/, 'light: the warning note boxes are Kyle\'s orange');
  assert.match(site, /:root\s*\{[^}]*--note-warn:\s*var\(--warn\);/, 'dark: the note boxes keep the warning amber');
  assert.match(site, /\.adm-warning \.adm-title, \.adm-attention \.adm-title, \.adm-caution \.adm-title \{ color: var\(--note-warn\); \}/, 'the note titles use it');
  assert.match(css, /--hc-hl-on:\s*var\(--hc-edit-on\)/, 'text on my highlight is the button text');
  // ED61 (Kyle's exact choice, pinned like #2391FF): in Editor mode the text on every blue-filled button is white,
  // about 2.2:1 in dark and 3.3:1 in light; no contrast ratio is claimed for it
  assert.match(css, /body\.hc-editor-on, body\.hc-edit-on \{ --hc-edit-on: #fff; \}/, 'Editor mode: white button text');
  for (let n = 1; n <= 5; n++) assert.match(css, new RegExp(`body\\[data-hc-tint="${n}"\\]\\s*\\{[^}]*--hc-hl-on:\\s*var\\(--bg\\)`), `slot ${n}: text on its highlight`);
  assert.match(css, /\.person-card\[data-hc-badge\]::after\s*\{[^}]*color:\s*var\(--hc-hl-on\)/, 'the card badge text');
  for (const [sel, theme] of [[':root', 'dark'], ['[data-theme="light"]', 'light']]) {
    const bg = block(site, sel, '--bg:');
    const ed = block(css, sel, '--hc-mark:');
    const backs = ['bg', 'bg-soft', 'surface', 'surface-2'].map((k) => bg[k]);
    assert.equal(backs.filter(Boolean).length, 4, `${theme}: four backgrounds read`);
    const accent = bg.accent;
    assert.ok(accent, `${theme}: the site's --accent is a hex colour`);
    const ink = accent;
    // dark: the blue passes as text; light: Kyle's exact #2391FF (pinned above) is near 3:1, his call
    if (theme === 'dark') for (const b of backs) assert.ok(ratio(ink, b) >= 4.5, `${theme}: blue text ${ink} on ${b} is ${ratio(ink, b).toFixed(2)}`);
    // #0a0a0a stays the :root value, and text on my highlight (--hc-hl-on, resolved at :root) keeps it: 4.5:1 there
    assert.ok(ratio(ed['hc-edit-on'], ink) >= 4.5, `${theme}: text on my blue highlight`);
    // a highlight badge's text: --hc-edit-on on the viewer's blue, --bg on each proposer colour
    for (const k of ['hc-p1', 'hc-p2', 'hc-p3', 'hc-p4', 'hc-p5']) assert.ok(ratio(bg.bg, ed[k]) >= 4.5, `${theme}: badge text on --${k}`);
    // the change colour passes as text in dark; light's orange is Kyle's exact #FF7F50 (pinned above)
    for (const k of theme === 'dark' ? ['hc-mark', 'hc-p1', 'hc-p2', 'hc-p3', 'hc-p4', 'hc-p5'] : ['hc-p1', 'hc-p2', 'hc-p3', 'hc-p4', 'hc-p5']) {
      assert.ok(ed[k], `${theme}: --${k} is a hex colour`);
      for (const b of backs) assert.ok(ratio(ed[k], b) >= 4.5, `${theme}: --${k} ${ed[k]} on ${b} is ${ratio(ed[k], b).toFixed(2)}`);
    }
  }
  // the change colour is ONLY the change marks: every rule that paints with --hc-mark is one of them, and --hc-tint
  // (the change colour for the viewer's own) only borders a change's card beside the page
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]]);
  const using = (v) => rules.filter(([, body]) => body.includes(`var(${v})`)).map(([sel]) => sel);
  assert.deepEqual(using('--hc-mark'), [':root', '.hc-sug-ins', '.hc-sug-del', '.hc-sug-fmt', '.hc-block.hc-removed', 'a.hc-sug-fmt'],
    'the change colour paints only the change marks');
  assert.deepEqual(using('--hc-tint'), ['.hc-rcard.is-hot', '.hc-rcard.is-active'], 'the change card border');
  assert.equal((css.replace(/\/\*[\s\S]*?\*\//g, '').match(/#FFD166|#FF7F50/gi) || []).length, 2, 'the change colour hex lives only in its token');
  assert.equal((css + site).match(/#E565A1|#C9257F/gi), null, 'no magenta left');
  // the site blue enters only through the edit tokens (--hc-edit, --hc-edit-ink), and text takes --hc-edit-ink
  assert.equal((css.match(/var\(--accent\)|var\(--accent-soft\)/g) || []).length, 2, 'the blue only through the edit tokens');
  assert.equal(rules.filter(([, body]) => /(^|[;{\s])color:\s*var\(--hc-edit\)/.test(body)).length, 0, 'blue text is --hc-edit-ink');
});

// ---- round 2, R3: the editor page is one plain list of proposals (Kyle 2026-10-15, item 4) ----
test('R3: "Edit this page" (?editor=changes) turns Editor mode on in place; no editor page opens', async () => {
  const page = openSite({ hash: `#${PAGE_ROUTE}?editor=changes` });
  await settle();
  await settle();
  assert.equal(page.body.classList.contains('hc-editor-on'), true);
  assert.equal(page.tray().hidden, true);
});

// ---- round 2, R5: the Team page in Editor mode (Kyle 2026-10-15, items 5 and 10) ----
test('R5: on the Team page the card tools are on, no blocks; an order from the frame becomes my people draft; "+" follows the New person redirect (U0b)', async () => {
  const page = await editorOn({ hash: '#/team' });
  await page.send({ type: 'hc-ready' });
  const m = page.editorMessages().at(-1);
  assert.equal(m.people.edit, true, 'the card tools');
  assert.equal(m.people.marks.length, 0);
  const text = readRepo('data/people.json');
  assert.equal((await page.asks('data/people.json')).text, text, 'the data file as it is: no block sentinels (item 5: no block bar)');
  const roster = JSON.parse(text);
  const team = roster.groups[0].people.map((p) => ({ name: p.name, pinned: p.pinned === true })).reverse();
  const alumni = roster.groups[1].people.map((p) => ({ name: p.name, pinned: false }));
  alumni.push(team.pop());                                        // the last of the reversed team moves to the alumni
  await page.send({ type: 'hc-people', op: 'order', team, alumni });
  await settle();
  const now = JSON.parse((await page.asks('data/people.json')).text);
  assert.deepEqual(now.groups[0].people.map((p) => p.name), team.map((x) => x.name), 'served from my draft');
  assert.equal(now.groups[1].people.at(-1).name, alumni.at(-1).name);
  await page.send({ type: 'hc-ready' });
  assert.ok(page.editorMessages().at(-1).people.marks.some((x) => x.mark === 'move'), 'my changes are marked');
  assert.match(page.one((e) => e.attrs['data-dock-count'] !== undefined).textContent, /^\d+ pages? changed$/);   // U2 (ED45): per page
  // an order that drops someone is refused, said, and changes nothing
  await page.send({ type: 'hc-people', op: 'order', team: team.slice(1), alumni });
  await settle();
  assert.match(page.one((e) => e.classList.contains('hc-notice')).textContent, /would be dropped/);
  // "+" on the alumni list: the New person form is gone (U0b), so it follows #/new/person's redirect — the page
  // stays, nothing is added (U5 adds the person in place)
  const before = draftsOf(page).get('data/people').files['data/people.json'];
  await page.send({ type: 'hc-people', op: 'add', group: 'alumni' });
  await settle();
  assert.equal(page.tray().hidden, true);
  assert.equal(draftsOf(page).get('data/people').files['data/people.json'], before);
});

// ---- round 2, R2b: Undo / Redo (Kyle 2026-10-15, item 1) ----
async function typedPage() {
  const page = await editorOn();
  await page.asks(PAGE_FILE);
  await page.send({ type: 'hc-ready' });
  const i = firstParagraph(PAGE_TEXT);
  await page.pick(i);
  await page.send({ type: 'hc-block-state', index: i, editor: 'visual', reason: '' });
  return { page, i, b: blocksOf(PAGE_TEXT)[i] };
}
const KEY_FCU = 'setup/hippocampus-bringup/fcu-firmware';
const fileNow = (page) => { const d = draftsOf(page).get(KEY_FCU); return d ? d.files[PAGE_FILE] : PAGE_TEXT; };
const undoBtn = (page) => page.action('undo');
const redoBtn = (page) => page.action('redo');

test('R2b: a typing step is undone in place — the frame restores its restore point, no reload — and redone', async () => {
  const { page, i, b } = await typedPage();
  assert.ok(undoBtn(page) && redoBtn(page), 'Undo and Redo in the bubble');
  assert.equal(undoBtn(page).disabled, true, 'nothing to undo yet');
  const srcs = page.frame().srcs.length;
  await page.send({ type: 'hc-history', index: i, snap: 'fabc-1' });
  const one = 'First words.\n\n';
  await page.send({ type: 'hc-block-md', index: i, md: one });
  await page.send({ type: 'hc-block-md', index: i, md: 'First words, more.\n\n' });   // the same burst: no new restore point
  await page.send({ type: 'hc-history', index: i, snap: 'fabc-2' });
  const two = 'First words, more. Second burst.\n\n';
  await page.send({ type: 'hc-block-md', index: i, md: two });
  assert.equal(undoBtn(page).disabled, false);
  undoBtn(page).click();
  await settle();
  let m = page.editorMessages().at(-1);
  assert.deepEqual({ ...m.cmd }, { n: 1, op: 'restore', index: i, snap: 'fabc-2', save: m.cmd.save });
  assert.equal(fileNow(page), PAGE_TEXT.slice(0, b.start) + 'First words, more.\n\n' + PAGE_TEXT.slice(b.end), 'back one burst');
  undoBtn(page).click();
  await settle();
  m = page.editorMessages().at(-1);
  assert.equal(m.cmd.snap, 'fabc-1');
  assert.equal(fileNow(page), PAGE_TEXT, 'back to the page as it was');
  assert.equal(undoBtn(page).disabled, true);
  assert.equal(page.frame().srcs.length, srcs, 'typing is undone in place: no reload');
  // Redo walks forward again, restoring what each Undo kept
  redoBtn(page).click();
  await settle();
  const r = page.editorMessages().at(-1).cmd;
  assert.equal(r.op, 'restore');
  assert.match(r.snap, /^u\d+$/);
  assert.equal(fileNow(page), PAGE_TEXT.slice(0, b.start) + 'First words, more.\n\n' + PAGE_TEXT.slice(b.end));
  // a new edit after an undo clears Redo
  await page.send({ type: 'hc-history', index: i, snap: 'fabc-3' });
  await page.send({ type: 'hc-block-md', index: i, md: 'Another way.\n\n' });
  assert.equal(redoBtn(page).disabled, true);
  // the keys pressed in the frame do the same as the buttons
  await page.send({ type: 'hc-key', op: 'undo' });
  await settle();
  assert.equal(page.editorMessages().at(-1).cmd.snap, 'fabc-3');
  // typing after an undo keeps writing into the right span
  await page.send({ type: 'hc-history', index: i, snap: 'fabc-4' });
  await page.send({ type: 'hc-block-md', index: i, md: 'Typed after undo.\n\n' });
  assert.equal(fileNow(page), PAGE_TEXT.slice(0, b.start) + 'Typed after undo.\n\n' + PAGE_TEXT.slice(b.end));
});

test('R2b: a step that reloaded the page (an inserted block) is undone with a reload; Discard clears the history', async () => {
  const page = await editorOn();
  await page.asks(PAGE_FILE);
  await page.send({ type: 'hc-ready' });
  const srcs = page.frame().srcs.length;
  await page.send({ type: 'hc-block-insert', index: 1, kind: 'note' });
  await settle();
  assert.notEqual(fileNow(page), PAGE_TEXT, 'a note was inserted');
  assert.ok(page.frame().srcs.length > srcs);
  const before = page.frame().srcs.length;
  undoBtn(page).click();
  await settle();
  assert.equal(fileNow(page), PAGE_TEXT, 'undone');
  assert.ok(page.frame().srcs.length > before, 'the page was drawn again');
  redoBtn(page).click();
  await settle();
  assert.notEqual(fileNow(page), PAGE_TEXT, 'redone');
  assert.equal(undoBtn(page).disabled, false);
  // a restore point the frame no longer has: it asks for a redraw, and the page is drawn from the text (codex r1)
  const n = page.frame().srcs.length;
  await page.send({ type: 'hc-key', op: 'redraw' });
  await settle();
  assert.ok(page.frame().srcs.length > n);
});

/* The edit gate (Kyle, 2026-10-21: "I can edit the main robot project"). Editing a project page follows main's
   data/graph/edit-access.json (HCCore.accessFor): an Editor (Write) edits a project only when the list names
   them; Admin and Maintainer edit every project; until the list is read, and after a failed read, an Editor
   edits no project. Other pages are as before. */
const GATE_ROUTE = '/projects/core-stack';
const GATE_PAGE = 'project/core-stack';
const GATE_FILE = 'content/projects/core-stack.md';
const GATE_TEXT = readRepo(GATE_FILE);
const gateOn = (opts) => editorOn(Object.assign({ hash: `#${GATE_ROUTE}` }, opts));
const dockLock = (page) => page.one((e) => e.classList.contains('hc-dock-lock') && !e.hidden);
const lastLocked = (page) => page.editorMessages().at(-1).locked;
/* An access-file read through GitHub that waits until released (or answers `status`). */
function heldAccess(status) {
  let release;
  const held = new Promise((r) => { release = r; });
  const intercept = (url) => (/\/contents\/data\/graph\/edit-access\.json\?ref=/.test(url)
    ? (status ? wire(status, { message: 'Server Error' }) : held) : null);
  return { intercept, release: (text) => release(wire(200, text)) };
}
async function cannotTouch(page, why) {
  await page.send({ type: 'hc-ready' });
  assert.equal(lastLocked(page), true, `${why}: the frame is told the page is locked`);
  const i = firstParagraph(GATE_TEXT);
  await page.send({ type: 'hc-block-select', index: i });
  await page.send({ type: 'hc-block-insert', index: 1, kind: 'note' });
  assert.equal(page.editorMessages().at(-1).selected, null, `${why}: no block is selected`);
  assert.equal(draftsOf(page).get(GATE_PAGE), null, `${why}: no draft was made`);
  assert.equal(page.action('dock-send').hidden, true, `${why}: no Send for review`);
  assert.equal(page.editorMessages().at(-1).open, null, `${why}: nothing opens for typing`);
  await page.wholePage();
  assert.equal(page.tray().hidden, true, `${why}: no whole-page Markdown`);
}

test('edit gate: an Editor without access to a project cannot select, insert, edit the whole page or send; the dock says so', async () => {
  const page = await gateOn({ files: { [ACCESS_FILE]: accessText(['someone-else']) } });
  await cannotTouch(page, 'not on the list');
  const lock = dockLock(page);
  assert.ok(lock, 'the dock has the can\'t-edit line');
  assert.match(lock.textContent, /You can't edit this project\./);
  assert.match(lock.textContent, /You have no commits in this project's repos yet\./);
  const ask = findAll(lock, (e) => e.attrs['data-action'] === 'access-request')[0];
  assert.ok(ask, 'with Request edit access');
  assert.equal(ask.textContent, C.ACCESS_REQUEST_LABEL);
  // removed by an admin: the same
  const gone = await gateOn({ files: { [ACCESS_FILE]: accessText(['bob'], ['bob']) } });
  await cannotTouch(gone, 'removed');
  assert.match(dockLock(gone).textContent, /An admin removed your access to this project\./);
});

test('edit gate: Request edit access in the dock sends the one access proposal (the project box\'s own path)', async () => {
  const { writes, onWrite } = recordWrites();
  const page = await gateOn({ onWrite, extra: { trees: { [MAIN_SHA]: TREE_M } }, files: { [ACCESS_FILE]: accessText([]) } });
  const ask = findAll(dockLock(page), (e) => e.attrs['data-action'] === 'access-request')[0];
  ask.click();
  await settle();
  const tree = writes.find((w) => /\/git\/trees$/.test(w.url));
  assert.ok(tree, 'one proposal was sent');
  assert.deepEqual(tree.body.tree.map((e) => e.path), ['data/projects.json']);
  assert.match(dockLock(page).textContent, /#42/, 'the result is said in the dock');
});

test('edit gate: a read-only member on a project page gets the GitHub issue link, not a proposal', async () => {
  const page = await gateOn({ variant: 'readonly', files: { [ACCESS_FILE]: accessText([]) } });
  await page.send({ type: 'hc-ready' });
  assert.equal(lastLocked(page), true);
  const ask = findAll(dockLock(page), (e) => e.attrs['data-action'] === 'access-issue')[0];
  assert.ok(ask, 'the issue link');
  assert.match(ask.attrs.href, /\/issues\/new\?title=/);
});

test('edit gate: an Editor with access edits the project page; the dock says why', async () => {
  const page = await gateOn({ files: { [ACCESS_FILE]: accessText(['bob']) } });
  await page.send({ type: 'hc-ready' });
  assert.equal(lastLocked(page), false);
  const i = firstParagraph(GATE_TEXT);
  await page.pick(i);
  assert.equal(page.editorMessages().at(-1).open.index, i, 'it opens for typing in the page');
  assert.equal(page.editorMessages().at(-1).selected, i);
  // U2 (ED7, D1): nothing changed yet -> no changes row, no "No changes yet", no Send for review
  assert.equal(page.one((e) => e.attrs['data-dock-count'] !== undefined).textContent, '');
  assert.equal(page.action('dock-send').hidden, true);
  const lock = dockLock(page);
  assert.ok(lock, 'one short line');
  assert.equal(lock.textContent, 'You can edit this project: you have commits in 2 of its 15 repos.');
  assert.equal(findAll(lock, (e) => e.attrs['data-action'] === 'access-request').length, 0, 'nothing to request');
  await page.typeIn(i, 'A changed paragraph.\n\n');
  assert.ok(draftsOf(page).get(GATE_PAGE), 'the draft is kept');
  assert.equal(page.action('dock-send').hidden, false, 'U2: Send for review shows with a change');
  assert.equal(page.action('dock-send').disabled, false, 'and can be sent');
});

test('edit gate: Admin and Maintainer edit every project, with or without the access file', async () => {
  for (const variant of ['admin', 'maintain']) {
    for (const files of [{ [ACCESS_FILE]: accessText([]) }, { [ACCESS_FILE]: null }]) {
      const page = await gateOn({ variant, files });
      await page.send({ type: 'hc-ready' });
      assert.equal(lastLocked(page), false, variant);
      await page.pick(firstParagraph(GATE_TEXT));
      assert.ok(page.editorMessages().at(-1).open, `${variant}: the block opens for typing`);
      assert.match(dockLock(page).textContent, /You can edit every project/);
    }
  }
});

test('edit gate: until the access file is read an Editor cannot edit a project; when it arrives, the page opens', async () => {
  const held = heldAccess();
  const page = await gateOn({ intercept: held.intercept });
  await cannotTouch(page, 'not read yet');
  assert.match(dockLock(page).textContent, /You can't edit this project\./);
  assert.match(dockLock(page).textContent, new RegExp(C.ACCESS_READING_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  held.release(accessText(['bob']));
  await settle();
  assert.equal(lastLocked(page), false, 'the frame is told again');
  await page.pick(firstParagraph(GATE_TEXT));
  assert.ok(page.editorMessages().at(-1).open, 'now the block opens for typing');
  // U2 (D1): Send for review shows once there is a change to send (it was shown, disabled, before)
  await page.typeIn(firstParagraph(GATE_TEXT), 'A changed paragraph.\n\n');
  assert.equal(page.action('dock-send').hidden, false);
});

test('edit gate: a failed read keeps an Editor out of every project and says why', async () => {
  const page = await gateOn({ intercept: heldAccess(500).intercept });
  await cannotTouch(page, 'failed read');
  assert.match(dockLock(page).textContent, /You can't edit this project\./);
  assert.ok(dockLock(page).textContent.includes(C.ACCESS_UNREAD_TEXT), 'says the list could not be read');
  assert.equal(findAll(dockLock(page), (e) => /^access-/.test(e.attrs['data-action'] || '')).length, 0, 'no request on a guess');
});

test('edit gate: a page that is not a project is edited as before, whatever the access file says', async () => {
  const page = await editorOn({ files: { [ACCESS_FILE]: accessText([]) } });
  await page.send({ type: 'hc-ready' });
  assert.equal(lastLocked(page), false);
  await page.pick(firstParagraph(PAGE_TEXT));
  assert.ok(page.editorMessages().at(-1).open, 'it opens for typing');
  assert.equal(dockLock(page), undefined, 'no access line in the dock');
  const failed = await editorOn({ intercept: heldAccess(500).intercept });
  await failed.send({ type: 'hc-ready' });
  await failed.pick(firstParagraph(PAGE_TEXT));
  assert.ok(failed.editorMessages().at(-1).open, 'a failed access read does not touch other pages');
});

test('edit gate: a project\'s facts file opened in the editor is view only without access; editable with it', async () => {
  const raw = async (files) => {
    const page = await gateOn({ files });
    page.win.HCEditor.openView('#/edit/data/projects/core-stack');
    await settle();
    return page;
  };
  let page = await raw({ [ACCESS_FILE]: accessText([]) });
  assert.ok(rawEditor(page), page.tray().textContent);
  assert.equal(rawEditor(page).readOnly, true, 'view only');
  assert.equal(page.action('propose'), undefined, 'no Propose');
  assert.match(page.tray().textContent, /You can't edit this project\./);
  assert.ok(findAll(page.tray(), (e) => e.attrs['data-action'] === 'access-request')[0], 'Request edit access there too');
  page = await raw({ [ACCESS_FILE]: accessText(['bob']) });
  assert.equal(rawEditor(page).readOnly, false, 'editable');
  assert.ok(page.action('propose'));
});

test('edit gate: a draft of a locked project kept from before stays kept, but cannot be sent (U0b: the draft list is gone)', async () => {
  const storage = memoryStorage();
  const local = localFor(storage);
  const store = C.createDraftStore(local, C.draftsKey('bob'));
  store.put({ key: GATE_PAGE, label: 'Core stack', route: GATE_ROUTE, files: { [GATE_FILE]: `${GATE_TEXT}\nMore.\n` },
    originals: { [GATE_FILE]: GATE_TEXT }, base: { ref: 'main', sha: MAIN_SHA, number: null } });
  const page = await gateOn({ storage, files: { [ACCESS_FILE]: accessText([]) } });
  assert.ok(C.createDraftStore(local, C.draftsKey('bob')).get(GATE_PAGE), 'the draft is kept');
  assert.equal(page.action('dock-send').hidden, true, 'no Send for review');
  await page.wholePage();
  assert.equal(page.tray().hidden, true, 'and no whole-page editor to send it from');
});
