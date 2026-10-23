// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 23 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test the U0b removals: each retired editor address redirects to the page it now opens.
/* Unit U0b of the editor UI/UX build (plan D18) removed the old editor screens: the proposals list (#/, #/review),
   the review page (#/review/<n>), the Guide (#/help, #/private), View settings (#/view), the image library (#/media),
   the page list (#/pages), the New project / New person forms (#/new/<kind>), both bars above the page and the Send
   box. Their addresses stay as redirects, one table (HCEditor.helpers.REDIRECTS): each lands on the page on screen,
   with the bubble out (a tucked bubble unfolds) and, for #/review/<n>, that proposal drawn on the page
   (ed.focusPr = n). U3 changes only the targets. A site address's ?editor=… is read the same way and stripped.

   One test per redirect, both ways in: the old address handed to the editor page (HCEditor.openView, which is what a
   link or an old caller does) and, where a site address carried it, the ?editor= parameter. The thin editor page
   that stays (#/edit/<id>: the whole page as Markdown, the raw data files) is NOT redirected.

     node --test tools/tests/test_editor_u0b.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { settle, openSite, memoryStorage, FakeElement } from './editor_harness.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const C = require(path.join(ROOT, 'js', 'cms-core.js'));
const { MAIN_SHA } = require(path.join(ROOT, 'tools', 'tests', 'fake_github.js'));
const readRepo = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const fixture = (name) => fs.readFileSync(path.join(ROOT, 'tools', 'tests', 'fixtures', 'github-data', name), 'utf8');

const PAGE_ROUTE = '/setup/hippocampus-bringup/fcu-firmware';
const UBUNTU_ROUTE = '/setup/raspberry-pi/ubuntu-24-04-server';
const UBUNTU_FILE = 'content/setup/raspberry-pi/ubuntu-24-04-server.md';
const PR1 = JSON.parse(fixture('pull-1.json'));

/* Editor on at `route`, the frame ready; tucked: the bubble starts folded into its tag (this browser remembers it). */
async function on(route, opts) {
  const o = opts || {};
  const storage = memoryStorage();
  const local = memoryStorage();
  if (o.tucked) local.setItem('hc-editor-dock', 'collapsed');
  const page = openSite(Object.assign({ hash: `#${route}`, storage, localStorage: local }, o.site));
  await settle();
  page.switchBtn().click();
  await settle();
  await page.send({ type: 'hc-ready' });
  return page;
}
const H = (page) => page.win.HCEditor.helpers;
const draftsOf = (page) => C.createDraftStore(page.local, C.draftsKey(page.login));
const tucked = (page) => page.body.classList.contains('hc-dock-collapsed');
const trayOpen = (page) => page.body.classList.contains('hc-tray-open');
const lastEditor = (page) => page.frame().posted.filter((x) => x.m.type === 'hc-editor').map((x) => x.m).at(-1);

/* A second open proposal on the Ubuntu page, newer than PR #1 (the same as test_editor.mjs's): #2 is drawn first. */
function secondProposal() {
  const mainText = readRepo(UBUNTU_FILE);
  const head = `b2${'0'.repeat(38)}`;
  const bb = C.splitBlocks(mainText).blocks;
  const h1 = bb.findIndex((b) => b.kind === 'heading');
  const at = bb[h1 + 1].start;
  const text = `${mainText.slice(0, at)}A second proposal adds this paragraph.\n\n${mainText.slice(at)}`;
  const pull = Object.assign({}, PR1, { number: 2, title: 'A second proposal', created_at: '2026-09-30T08:00:00Z',
    user: Object.assign({}, PR1.user, { login: 'second-author' }),
    head: Object.assign({}, PR1.head, { sha: head, ref: 'cms/second-author/x' }) });
  return {
    pulls: [pull],
    files: { 2: [{ filename: UBUNTU_FILE, status: 'modified', additions: 2, deletions: 0, changes: 2, patch: '@@ -1 +1 @@' }] },
    contents: { [head]: { [UBUNTU_FILE]: text } },
    compare: { [head]: MAIN_SHA },
    checks: { [head]: { total_count: 0, check_runs: [] } },
  };
}

/* The redirect's landing: the page on screen (the site's hash unchanged), the editor page closed, the bubble out. */
function landed(page, route, label) {
  assert.equal(page.location.hash, `#${route}`, `${label}: the page on screen stays`);
  assert.equal(trayOpen(page), false, `${label}: no editor page`);
  assert.equal(page.tray().hidden, true, `${label}: the tray is hidden`);
  assert.equal(tucked(page), false, `${label}: the bubble is out`);
  assert.equal(page.body.classList.contains('hc-editor-on'), true, `${label}: Editor mode stays on`);
}

test('REDIRECTS: one table, every retired address and its target (the page + bubble; U3 changes only the targets)', () => {
  const page = openSite({ hash: `#${PAGE_ROUTE}` });
  const { REDIRECTS, redirectOf } = H(page);
  assert.ok(Object.isFrozen(REDIRECTS));
  assert.deepEqual([...REDIRECTS.map((r) => r.name)], ['review-pr', 'home', 'help', 'view', 'media', 'pages', 'new']);
  for (const r of REDIRECTS) assert.equal(r.to, 'page', r.name);
  const cases = [
    ['#/review/7', 'review-pr', 7], ['#/review/7/', 'review-pr', 7], ['#/', 'home', null], ['#/review', 'home', null],
    ['#/help', 'help', null], ['#/private', 'help', null], ['#/view', 'view', null], ['#/media', 'media', null],
    ['#/pages', 'pages', null], ['#/new/project', 'new', null], ['#/new/person', 'new', null], ['#/media?x=1', 'media', null],
  ];
  for (const [hash, name, focus] of cases) {
    const r = redirectOf(hash);
    assert.ok(r, hash);
    assert.equal(r.name, name, hash);
    assert.equal(r.to, 'page', hash);
    assert.equal(r.focusPr, focus, hash);
  }
  // what stays: the thin editor page (whole-page Markdown, the raw data files), and nothing is guessed
  for (const hash of ['#/edit', '#/edit/data/people', '#/edit/setup/start/index', '#/review/0', '#/review/abc', '#/nope', '#/helpme']) {
    assert.equal(redirectOf(hash), null, hash);
  }
  assert.deepEqual(C.ROUTES.map((r) => r.name), ['edit'], 'HCCore.ROUTES: only the thin editor page');
});

test('redirect #/review/<n>: lands on the page on screen with that proposal drawn (ed.focusPr = n), the bubble out', async () => {
  const page = await on(UBUNTU_ROUTE, { tucked: true, site: { extra: secondProposal() } });
  assert.equal(lastEditor(page).tint, 2, 'before: the newest (#2, second-author) is drawn');
  assert.equal(page.win.HCEditor.openView('#/review/1'), true);
  await settle();
  await page.send({ type: 'hc-ready' });
  landed(page, UBUNTU_ROUTE, '#/review/1');
  assert.equal(H(page).state().focusPr, 1);
  const m = lastEditor(page);
  assert.equal(m.tint, 1, 'PR #1 is drawn now, in its proposer\'s colour');
  assert.ok(m.overlay.length > 0, 'with its marks');
});

test('redirect #/review/<n> from a site address: ?editor=review&pr=<n> (and the old ?editor=proposals&pr=<n>) is stripped, focus set', async () => {
  for (const tab of ['review', 'proposals']) {
    const page = openSite({ hash: `#${UBUNTU_ROUTE}?editor=${tab}&pr=1`, extra: secondProposal() });
    await settle();
    await page.send({ type: 'hc-ready' });
    assert.equal(page.location.hash, `#${UBUNTU_ROUTE}`, `${tab}: the parameter is stripped`);
    assert.ok(page.replaced.some((u) => u === `/#${UBUNTU_ROUTE}`), `${tab}: with history.replaceState`);
    assert.equal(page.body.classList.contains('hc-editor-on'), true, `${tab}: Editor mode on`);
    assert.equal(trayOpen(page), false);
    assert.equal(H(page).state().focusPr, 1, tab);
    assert.equal(lastEditor(page).tint, 1, `${tab}: PR #1 drawn`);
  }
});

for (const hash of ['#/', '#/review']) {
  test(`redirect ${hash} (the proposals list): the page on screen, the bubble out, no proposal picked`, async () => {
    const page = await on(PAGE_ROUTE, { tucked: true });
    assert.equal(page.win.HCEditor.openView(hash), true);
    await settle();
    landed(page, PAGE_ROUTE, hash);
    assert.equal(H(page).state().focusPr, null);
    assert.equal(page.all((e) => e.classList.contains('hc-prow') || e.classList.contains('hc-card')).length, 0, 'no list is drawn');
  });
}

for (const [hash, gone] of [['#/help', 'hc-guide'], ['#/private', 'hc-guide'], ['#/view', 'hc-settings'], ['#/media', 'cms-media-grid'],
  ['#/pages', 'hc-changes'], ['#/new/project', 'cms-form'], ['#/new/person', 'cms-form']]) {
  test(`redirect ${hash}: the page on screen, the bubble out; the old screen (.${gone}) is never drawn`, async () => {
    const page = await on(PAGE_ROUTE, { tucked: true });
    assert.equal(page.win.HCEditor.openView(hash), true);
    await settle();
    landed(page, PAGE_ROUTE, hash);
    assert.equal(page.all((e) => e.classList.contains(gone)).length, 0, `no .${gone}`);
    assert.equal(page.github().filter((c) => /\/api\/media/.test(c.url)).length, 0, 'nothing asked of the image gateway');
  });
}

test('redirect from a link inside the editor page: an old "#/…" link lands on the page too', async () => {
  const page = await on(PAGE_ROUTE, { tucked: true });
  assert.equal(page.win.HCEditor.openView('#/edit'), true, 'the Data files page');
  await settle();
  assert.equal(trayOpen(page), true);
  const link = new FakeElement('a');
  link.attrs.href = '#/help';
  page.tray().appendChild(link);
  await page.follow(link);
  landed(page, PAGE_ROUTE, 'a #/help link');
});

for (const tab of ['guide', 'view', 'media', 'changes', 'proposals']) {
  test(`redirect ?editor=${tab} on a site address: stripped (other parameters kept), Editor on, the page on screen`, async () => {
    const page = openSite({ hash: `#${PAGE_ROUTE}?x=1&editor=${tab}&new=project` });
    await settle();
    await page.send({ type: 'hc-ready' });
    assert.equal(page.location.hash, `#${PAGE_ROUTE}?x=1`, 'only the editor\'s parameters go');
    assert.equal(page.body.classList.contains('hc-editor-on'), true);
    assert.equal(trayOpen(page), false, 'no editor page');
    assert.equal(H(page).state().focusPr, null);
  });
}

test('?editor=…&data=<registry> still opens that raw data file on the thin editor page (it stays); a bad name opens nothing', async () => {
  const page = openSite({ hash: `#${PAGE_ROUTE}?editor=changes&data=people` });
  await settle();
  assert.ok(!/editor=/.test(page.location.hash), `stripped (${page.location.hash})`);
  assert.equal(trayOpen(page), true);
  assert.equal(page.trayTitle(), 'Data files');
  assert.ok(page.all((e) => e.tagName === 'TEXTAREA' && e.attrs['data-editor'] !== undefined).length === 1, 'data/people.json raw');
  assert.equal(H(page).state().trayHash, '#/edit/data/people');
  const bad = openSite({ hash: `#${PAGE_ROUTE}?editor=changes&data=..%2Fsecret` });
  await settle();
  assert.equal(trayOpen(bad), false);
});

test('the kept thin editor page: #/edit (Data files) lists the raw registries and each project\'s facts file; #/edit/<id> is not redirected', async () => {
  const page = await on(PAGE_ROUTE);
  assert.equal(page.win.HCEditor.openView('#/edit'), true);
  await settle();
  assert.equal(trayOpen(page), true);
  assert.equal(page.trayTitle(), 'Data files');
  for (const f of C.RAW_REGISTRIES) assert.ok(page.linkTo(`#/edit/${f.slice(0, -5)}`), f);
  assert.ok(page.all((e) => e.tagName === 'A' && /^#\/edit\/data\/projects\//.test(e.attrs.href || '')).length > 0, 'facts files');
  await page.follow(page.linkTo('#/edit/data/people'));
  assert.equal(trayOpen(page), true, 'a raw data file opens there');
  assert.ok(page.all((e) => e.tagName === 'TEXTAREA' && e.attrs['data-editor'] !== undefined).length === 1, 'its raw-JSON editor');
});

test('the account menu holds "Data files" (the thin editor page) and "Edit whole page as Markdown"; no link to a removed screen', async () => {
  const page = await on(PAGE_ROUTE);
  const items = page.all((e) => e.attrs.role === 'menuitem');
  const words = items.map((e) => e.textContent);
  assert.deepEqual(words, ['Edit whole page as Markdown', 'Data files', 'Sign out']);
  page.action('menu-data').click();
  await settle();
  assert.equal(page.trayTitle(), 'Data files');
  page.action('tray-close').click();
  await settle();
  page.action('menu-whole').click();
  await settle();
  assert.equal(H(page).state().trayHash, '#/edit/setup/hippocampus-bringup/fcu-firmware');
  assert.equal(page.trayTitle(), 'Edit as Markdown');
  const ta = page.all((e) => e.tagName === 'TEXTAREA' && e.attrs['data-editor'] !== undefined)[0];
  assert.equal(ta.value, readRepo('content/setup/hippocampus-bringup/fcu-firmware.md'), 'the whole page, as Markdown');
  for (const href of ['#/', '#/review', '#/help', '#/view', '#/media', '#/pages', '#/new/project', '#/new/person']) {
    assert.equal(page.all((e) => e.tagName === 'A' && e.attrs.href === href).length, 0, `no link to ${href}`);
  }
});

test('no bar above the page and no Send box: neither is ever built', async () => {
  const page = await on(UBUNTU_ROUTE, { site: { extra: secondProposal() } });
  for (const cls of ['hc-pagebar', 'hc-showing', 'hc-sendbox', 'hc-tray-crumb']) {
    assert.equal(page.created.filter((e) => e.classList.contains(cls)).length, 0, cls);
  }
});

test('kept helpers: mediaAssets, newProjectForm, makeProjectDraft, personFields', async () => {
  const page = openSite({ hash: `#${PAGE_ROUTE}` });
  const { mediaAssets, newProjectForm, personFields, makeProjectDraft } = H(page);
  const all = [{ public_id: 'hippocampus-docs/setup/a', url: 'https://res.cloudinary.com/x/a.png' },
    { public_id: 'hippocampus-docs/setup/b', url: 'https://res.cloudinary.com/x/b.png' }, { public_id: 'c' }];
  const live = [{ public_id: 'hippocampus-docs/setup/a' }];
  assert.deepEqual(JSON.parse(JSON.stringify(mediaAssets(all, live))), [
    { url: 'https://res.cloudinary.com/x/a.png', public_id: 'hippocampus-docs/setup/a', onSite: true, label: 'hippocampus-docs/setup/a' },
    { url: 'https://res.cloudinary.com/x/b.png', public_id: 'hippocampus-docs/setup/b', onSite: false,
      label: 'hippocampus-docs/setup/b (new: not on the live site yet)' }]);
  const f = newProjectForm();
  assert.deepEqual([...f.fields], ['id', 'name', 'status', 'tagline', 'repos', 'story']);
  assert.deepEqual([...f.statuses], [...C.PROJECT_STATUSES]);
  assert.equal(f.defaults.status, 'active');
  assert.equal(f.defaults.story, '## What it is\n\n');
  const people = readRepo('data/people.json');
  const pf = personFields(people);
  assert.deepEqual([...pf.fields], ['group', 'name', 'title', 'photo', 'link']);
  assert.deepEqual(JSON.parse(JSON.stringify(pf.groups)), JSON.parse(JSON.stringify(C.personGroups(people))));
  assert.equal(pf.defaultGroup, C.personGroups(people)[0].id);
  assert.equal(typeof makeProjectDraft, 'function');
});

test('makeProjectDraft: the form at a base -> one draft of three files (index entry, facts file, story); a taken id is refused', async () => {
  const page = await on(PAGE_ROUTE);
  const { makeProjectDraft, newProjectForm } = H(page);
  const form = Object.assign({}, newProjectForm().defaults, { id: 'walk-new-project', name: 'Walk project',
    tagline: 'A line.', repos: '', story: '## What it is\n\nA test.\n' });
  const out = await makeProjectDraft(form, { ref: 'main', number: null });
  assert.equal(out.problem, undefined, String(out.problem));
  assert.equal(out.d.key, 'new/project');
  assert.deepEqual(Object.keys(out.d.files).sort(), ['content/projects/walk-new-project.md', 'data/projects.json',
    'data/projects/walk-new-project.json']);
  assert.match(out.d.files['content/projects/walk-new-project.md'], /A test\./);
  const id = JSON.parse(readRepo('data/projects.json')).projects[0].id;
  const taken = await makeProjectDraft(Object.assign({}, form, { id }), { ref: 'main', number: null });
  assert.ok(typeof taken.problem === 'string' && taken.problem.length > 0, 'a taken id');
  assert.equal(page.github().filter((c) => c.method !== 'GET').length, 0, 'nothing written');
});

test('View settings are fixed (HCCore.viewSettings is constants): the frame is told them, nothing is read or written in this browser', async () => {
  assert.deepEqual({ ...C.viewSettings }, { suggestions: true, diff: 'inline', compact: false, outlines: true });
  assert.ok(Object.isFrozen(C.viewSettings));
  const local = memoryStorage();
  local.setItem('hc-editor-view', JSON.stringify({ suggestions: false, diff: 'side', compact: true, outlines: false }));
  const page = openSite({ hash: `#${PAGE_ROUTE}`, localStorage: local });
  await settle();
  page.switchBtn().click();
  await settle();
  await page.send({ type: 'hc-ready' });
  assert.deepEqual({ ...lastEditor(page).settings }, { suggestions: true, diff: 'inline', compact: false, outlines: true },
    'a stored hc-editor-view is ignored');
});

test('Send for review in the bubble sends at once (no Send box), and no review page opens; HCDock.sent is the hook U2 fills', async () => {
  const writes = [];
  let k = 0;
  const API = 'https://api.github.com/repos/desert-mango/hippocampus-docs';
  const onWrite = (method, url, body) => {
    writes.push({ method, url: url.slice(API.length), body });
    const rest = url.slice(API.length);
    if (method === 'POST' && ['/git/blobs', '/git/trees', '/git/commits'].indexOf(rest) >= 0) {
      k += 1;
      return { status: 201, body: { sha: k.toString(16).padStart(40, 'a') } };
    }
    if (method === 'POST' && rest === '/git/refs') return { status: 201, body: { ref: body.ref, object: { sha: body.sha } } };
    if (method === 'POST' && rest === '/pulls') return { status: 201, body: { number: 42 } };
    if (method === 'PATCH' && /^\/pulls\/[0-9]+$/.test(rest)) return { status: 200, body: { number: 42 } };
    return { status: 500, body: { message: `unexpected ${method} ${rest}` } };
  };
  const sentCalls = [];
  // wrap the dock's sent hook before js/editor.js captures window.HCDock
  const afterScript = (file, win) => {
    if (!/editor-dock\.js$/.test(file)) return;
    const real = win.HCDock;
    assert.equal(typeof real.sent, 'function', 'the hook U2 fills');
    win.HCDock = Object.freeze(Object.assign({}, real, { sent: (...a) => { sentCalls.push(a); return real.sent(...a); } }));
  };
  const page = await on(PAGE_ROUTE, { site: { onWrite, afterScript, extra: { trees: { [MAIN_SHA]: '7'.repeat(40) } } } });
  const text = readRepo('content/setup/hippocampus-bringup/fcu-firmware.md');
  const p = C.splitBlocks(text).blocks.findIndex((b) => b.kind === 'paragraph');
  await page.send({ type: 'hc-block-select', index: p });
  await page.send({ type: 'hc-block-state', index: p, editor: 'visual' });
  await page.send({ type: 'hc-block-md', index: p, md: 'U0b typed this paragraph.\n' });
  page.action('dock-send').click();
  await settle();
  assert.deepEqual(writes.map((w) => `${w.method} ${w.url}`), ['POST /git/blobs', 'POST /git/trees', 'POST /git/commits',
    'POST /git/refs', 'POST /pulls', 'PATCH /pulls/42']);
  assert.equal(writes[4].body.title, 'Edit FCU Firmware', 'titled "Edit <page>" until U2\'s generated title');
  assert.equal(trayOpen(page), false, 'no review page');
  assert.equal(page.created.filter((e) => e.classList.contains('hc-sendbox')).length, 0, 'no Send box');
  assert.equal(draftsOf(page).dirty().length, 0, 'the sent draft is gone');
  assert.deepEqual(sentCalls, [[42]], 'HCDock.sent heard the new proposal\'s number, once');
});

test('makeProjectDraft on my open proposal: the draft builds on its branch head (one more commit when sent)', async () => {
  const OWN = 'cms/bob/fix-typo-260920';
  const HEAD_B = '3'.repeat(40);
  const pull = { number: 7, title: 'Fix typo', state: 'open', user: { login: 'bob' }, created_at: '2026-09-20T10:00:00Z',
    head: { ref: OWN, sha: HEAD_B, repo: { full_name: 'desert-mango/hippocampus-docs' } }, base: { ref: 'main' } };
  const page = await on(PAGE_ROUTE, { site: { extra: { pulls: [pull], files: { 7: [] },
    contents: { [HEAD_B]: { 'data/projects.json': readRepo('data/projects.json') } } } } });
  const { makeProjectDraft, newProjectForm } = H(page);
  const form = Object.assign({}, newProjectForm().defaults, { id: 'sonar-rig', name: 'Sonar rig', tagline: 'A tank rig.' });
  const out = await makeProjectDraft(form, { ref: OWN, number: 7 });
  assert.equal(out.problem, undefined, String(out.problem));
  assert.deepEqual({ ...out.d.base }, { ref: OWN, sha: HEAD_B, number: 7 });
  assert.equal(JSON.parse(out.d.files['data/projects/sonar-rig.json']).name, 'Sonar rig');
});
