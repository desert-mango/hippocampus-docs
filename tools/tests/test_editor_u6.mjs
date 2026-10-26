// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 23 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test the U6 project page work on the editor's parent side: facts in place, the lock line, New project.
/* Made by U0 (editor UI/UX build) so unit U6 adds its tests here, not to a shared test file.

   U6 (plan D17, D11): a project page's facts (title, one-line description, status, repositories) are edited in
   the page; the frame posts hc-facts {field, value} and the parent keeps a facts draft, data/projects/<id>.json
   (strict JSON, HCCore.factsDraftText, checked by HCCore.validFacts against FACTS_RULES, the copy of the gate's
   PROJECT_FACTS_SPEC that tools/tests/test_facts_rules.py holds equal). A locked project says so in the page and
   its "Request edit access" (hc-access-ask) opens the bubble and focuses its own Request edit access (the person's click sends). "+ New project" (hc-new-project) opens a
   small dialog that makes the 3-file draft (HCEditor.helpers.makeProjectDraft). js/app.js: one ACTIVE tag on a
   project page (the facts row's), data-hc-fact marks, the "+ New page" item and the hidden "+ New project" card.

     node --test tools/tests/test_editor_u6.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { settle, openSite, memoryStorage } from './editor_harness.mjs';
import { bootSite } from './view_harness.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const C = require(path.join(ROOT, 'js', 'cms-core.js'));
const readRepo = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const CORE = 'data/projects/core-stack.json';
const CORE_TEXT = readRepo(CORE);

// ------------------------------------------------------- HCCore: the rules ---

test('FACTS_RULES: the gate\'s facts spec, with the statuses a project may have (frozen)', () => {
  assert.deepEqual(C.FACTS_RULES.keys, ['name', 'tagline', 'status', 'file', 'repos']);
  assert.deepEqual(C.FACTS_RULES.statuses, C.PROJECT_STATUSES.slice());
  assert.ok(Object.isFrozen(C.FACTS_RULES) && Object.isFrozen(C.FACTS_RULES.each.repos));
});

test('validFacts: every real facts file passes; each broken rule is named', () => {
  for (const f of fs.readdirSync(path.join(ROOT, 'data', 'projects'))) {
    assert.equal(C.validFacts(JSON.parse(readRepo(`data/projects/${f}`))), null, f);
  }
  const core = JSON.parse(CORE_TEXT);
  const without = (k) => { const o = Object.assign({}, core); delete o[k]; return o; };
  assert.match(C.validFacts(without('tagline')), /tagline/);
  assert.match(C.validFacts(Object.assign({}, core, { status: 'paused' })), /status.*active, maintained, legacy, archive/);
  assert.match(C.validFacts(Object.assign({}, core, { file: 7 })), /file/);
  assert.match(C.validFacts(Object.assign({}, core, { hardware: 'a rig' })), /hardware.*list/);
  assert.match(C.validFacts(Object.assign({}, core, { repos: [{ name: 'x' }] })), /repos.*url/);
  assert.match(C.validFacts(Object.assign({}, core, { links: [{ href: '#/x' }] })), /links.*label/);
  assert.match(C.validFacts(Object.assign({}, core, { add: ['bob'] })), /add/);
  assert.match(C.validFacts([]), /object/);
});

test('factsDraftText: the title, the line and the status change in place; every other byte stays', () => {
  const out = C.factsDraftText(CORE_TEXT, 'name', '  Core stack  ');
  assert.equal(out.problem, null);
  const doc = JSON.parse(out.text);
  assert.equal(doc.name, 'Core stack', 'trimmed');
  assert.deepEqual(Object.keys(doc), Object.keys(JSON.parse(CORE_TEXT)), 'the key order is kept');
  assert.equal(out.text, CORE_TEXT.replace(/"name": "[^"]*"/, '"name": "Core stack"'), 'and the file\'s own format');
  assert.equal(JSON.parse(C.factsDraftText(CORE_TEXT, 'tagline', 'Shared ROS 2 packages.').text).tagline, 'Shared ROS 2 packages.');
  assert.equal(JSON.parse(C.factsDraftText(CORE_TEXT, 'status', 'legacy').text).status, 'legacy');
  assert.equal(C.factsDraftText(CORE_TEXT, 'status', JSON.parse(CORE_TEXT).status).text, CORE_TEXT, 'no change: the same text');
});

test('factsDraftText: refused in words — an empty or two-line title, an unknown status or field, broken JSON', () => {
  assert.match(C.factsDraftText(CORE_TEXT, 'name', '   ').problem, /name/);
  assert.match(C.factsDraftText(CORE_TEXT, 'tagline', 'one\ntwo').problem, /one line/);
  assert.match(C.factsDraftText(CORE_TEXT, 'status', 'paused').problem, /active, maintained, legacy, archive/);
  assert.match(C.factsDraftText(CORE_TEXT, 'file', 'content/x.md').problem, /cannot be changed here/);
  assert.match(C.factsDraftText(CORE_TEXT, 'name', 'x'.repeat(201)).problem, /200/);
  assert.match(C.factsDraftText('{"name": ', 'name', 'x').problem, /line 1/);
  assert.equal(C.factsDraftText('{"name": ', 'name', 'x').text, null);
});

test('factsDraftText: repositories by name — a kept one keeps its fields, a new one gets its org address, order as given', () => {
  const core = JSON.parse(CORE_TEXT);
  const names = core.repos.map((r) => r.name);
  const next = [names[1], names[0], 'new_repo'];
  const doc = JSON.parse(C.factsDraftText(CORE_TEXT, 'repos', next).text);
  assert.deepEqual(doc.repos.map((r) => r.name), next);
  assert.deepEqual(doc.repos[0], core.repos[1], 'a kept repository keeps its role, address and description');
  assert.deepEqual(doc.repos[2], { name: 'new_repo', url: 'https://github.com/HippoCampusRobotics/new_repo' });
  assert.match(C.factsDraftText(CORE_TEXT, 'repos', ['a b']).problem, /not a repository name/);
  assert.match(C.factsDraftText(CORE_TEXT, 'repos', ['a', 'a']).problem, /twice/);
  assert.match(C.factsDraftText(CORE_TEXT, 'repos', 'hippo_core').problem, /list/);
});

// ------------------------------------------------------- the editor (parent) ---

const ACCESS_FILE = 'data/graph/edit-access.json';
const accessText = (editors) => `${JSON.stringify({ note: 'test', projects: {
  'core-stack': { repos: 15, editors: editors.map((login) => ({ login, why: 'commits', repos_with_commits: 2 })), removed: [] } } }, null, 1)}\n`;

async function on(route, opts) {
  const o = opts || {};
  const page = openSite(Object.assign({ hash: `#${route}`, storage: memoryStorage(), localStorage: memoryStorage(),
    files: { [ACCESS_FILE]: accessText(o.editors || ['bob']) } }, o.site));
  await settle();
  page.switchBtn().click();
  await settle();
  await page.send({ type: 'hc-ready' });
  return page;
}
const draftsOf = (page) => C.createDraftStore(page.local, C.draftsKey(page.login));
const lastEditor = (page) => page.frame().posted.filter((x) => x.m.type === 'hc-editor').map((x) => x.m).at(-1);
const srcs = (page) => page.frame().srcs || [];

test('hc-editor.facts: an editor of the project may change its facts; the statuses come from FACTS_RULES', async () => {
  const page = await on('/projects/core-stack');
  const m = lastEditor(page);
  assert.equal(m.locked, false);
  assert.deepEqual(JSON.parse(JSON.stringify(m.facts)), { edit: true, lock: false, create: true, statuses: C.FACTS_RULES.statuses.slice() });
});

test('hc-editor.facts: a project you cannot edit is locked (the lock line), with nothing to change', async () => {
  const page = await on('/projects/core-stack', { editors: [] });
  const m = lastEditor(page);
  assert.equal(m.locked, true);
  assert.equal(m.facts.edit, false);
  assert.equal(m.facts.lock, true);
});

test('hc-editor.facts: not on a project page; "+ New project" for a Write role, never for a read-only one', async () => {
  let page = await on('/projects');
  assert.equal(lastEditor(page).facts.edit, false);
  assert.equal(lastEditor(page).facts.lock, false);
  assert.equal(lastEditor(page).facts.create, true);
  page = await on('/projects', { site: { variant: 'readonly' } });
  assert.equal(lastEditor(page).facts.create, false);
});

test('hc-facts: the title goes into the facts draft (data/projects/<id>.json) and the page is drawn again from it', async () => {
  const page = await on('/projects/core-stack');
  const before = srcs(page).length;
  await page.send({ type: 'hc-facts', field: 'name', value: 'Core stack' });
  const d = draftsOf(page).get('data/projects/core-stack');
  assert.ok(d, 'one facts draft, keyed by its file');
  assert.deepEqual(Object.keys(d.files), [CORE]);
  assert.equal(JSON.parse(d.files[CORE]).name, 'Core stack');
  assert.equal(d.originals[CORE], CORE_TEXT);
  assert.ok(srcs(page).length > before, 'the frame is reloaded');
  const served = await page.asks(CORE);
  assert.equal(JSON.parse(served.text).name, 'Core stack', 'the frame is served the draft');
  // a second field joins the same draft
  await page.send({ type: 'hc-facts', field: 'status', value: 'legacy' });
  const d2 = draftsOf(page).get('data/projects/core-stack');
  assert.equal(JSON.parse(d2.files[CORE]).name, 'Core stack');
  assert.equal(JSON.parse(d2.files[CORE]).status, 'legacy');
});

test('hc-facts: back to what it was, the draft goes; a refused value says why and changes nothing', async () => {
  const page = await on('/projects/core-stack');
  const name = JSON.parse(CORE_TEXT).name;
  await page.send({ type: 'hc-facts', field: 'name', value: 'Core stack' });
  await page.send({ type: 'hc-facts', field: 'name', value: name });
  assert.equal(draftsOf(page).get('data/projects/core-stack'), null);
  await page.send({ type: 'hc-facts', field: 'name', value: '   ' });
  assert.equal(draftsOf(page).get('data/projects/core-stack'), null);
  assert.ok(page.one((e) => e.classList.contains('is-error') && /name/.test(e.textContent)), 'the bubble says why');
});

test('hc-facts: refused on a locked project, and off a project page', async () => {
  let page = await on('/projects/core-stack', { editors: [] });
  await page.send({ type: 'hc-facts', field: 'name', value: 'Core stack' });
  assert.equal(draftsOf(page).get('data/projects/core-stack'), null);
  page = await on('/projects');
  await page.send({ type: 'hc-facts', field: 'name', value: 'Core stack' });
  assert.equal(draftsOf(page).get('data/projects/core-stack'), null);
});

/* Fixes pass B: focus() on the fake elements records document.activeElement (restored after the test). */
function trackFocus(t, page) {
  const proto = Object.getPrototypeOf(page.body);
  const was = proto.focus;
  proto.focus = function focus() { page.win.document.activeElement = this; };
  t.after(() => { proto.focus = was; });
}

test('hc-access-ask (fix B2): the locked page\'s "Request edit access" opens the bubble and focuses its button; nothing is sent until that click', async (t) => {
  const writes = [];
  const onWrite = (method, url) => { writes.push([method, url]); return { status: 422, body: { message: 'no' } }; };
  const page = await on('/projects/core-stack', { editors: [], site: { onWrite } });
  trackFocus(t, page);
  await page.send({ type: 'hc-access-ask' });
  assert.equal(page.body.classList.contains('hc-dock-collapsed'), false, 'the bubble is out');
  assert.deepEqual(writes, [], 'a frame message sends nothing');
  const ask = page.one((e) => e.attrs['data-action'] === 'access-request');
  assert.ok(ask, 'the bubble shows its Request edit access');
  assert.equal(page.win.document.activeElement, ask, 'and focuses it');
  ask.click();          // the person's own click in the bubble sends
  await settle();
  assert.ok(page.one((e) => e.classList.contains('hc-access-result') && !e.hidden && /Stopped while reading main/.test(e.textContent)),
    'its result is said in the bubble');
});

test('hc-access-ask (fix B2): a read-only member gets the prefilled GitHub issue link focused, not a tab opened for them', async (t) => {
  const page = await on('/projects/core-stack', { editors: [], site: { variant: 'readonly' } });
  trackFocus(t, page);
  await page.send({ type: 'hc-access-ask' });
  assert.equal(page.opens.length, 0, 'no tab opens from a frame message');
  const ask = page.one((e) => e.attrs['data-action'] === 'access-issue');
  assert.match(ask.attrs.href, /\/issues\/new\?title=/);
  assert.equal(page.win.document.activeElement, ask);
});

test('hc-access-ask: ignored on a page you can edit', async () => {
  const writes = [];
  const page = await on('/projects/core-stack', { site: { onWrite: (method, url) => { writes.push([method, url]); return { status: 422, body: {} }; } } });
  await page.send({ type: 'hc-access-ask' });
  assert.deepEqual(writes, []);
});

test('hc-new-project: the New project dialog opens (id, name, one-line description, status) and makes the 3-file draft', async () => {
  const page = await on('/projects');
  await page.send({ type: 'hc-new-project' });
  const dlg = page.one((e) => e.getAttribute && e.getAttribute('data-new-project') !== null && !e.hidden);
  assert.ok(dlg, 'the dialog');
  const field = (n) => page.one((e) => e.getAttribute && e.getAttribute('name') === n && e.tagName !== 'LABEL');
  for (const n of ['id', 'name', 'tagline', 'status']) assert.ok(field(n), n);
  assert.deepEqual(field('status').childNodes.map((o) => o.attrs.value), [...C.FACTS_RULES.statuses]);
  page.type(field('id'), 'sonar-rig');
  page.type(field('name'), 'Sonar rig');
  page.type(field('tagline'), 'A tank rig for sonar tests.');
  page.action('new-project-make').click();
  await settle();
  const d = draftsOf(page).get('new/project');
  assert.ok(d, 'the new project\'s draft');
  assert.deepEqual(Object.keys(d.files).sort(), ['content/projects/sonar-rig.md', 'data/projects.json', 'data/projects/sonar-rig.json']);
  assert.equal(JSON.parse(d.files['data/projects/sonar-rig.json']).status, 'active');
  assert.ok(!page.one((e) => e.getAttribute && e.getAttribute('data-new-project') !== null && !e.hidden), 'the dialog closed');
});

test('hc-new-project: a refused id is said in the dialog; nothing is kept. A read-only role gets no dialog', async () => {
  let page = await on('/projects');
  await page.send({ type: 'hc-new-project' });
  page.type(page.one((e) => e.getAttribute && e.getAttribute('name') === 'id' && e.tagName !== 'LABEL'), 'Bad Id');
  page.action('new-project-make').click();
  await settle();
  assert.equal(draftsOf(page).get('new/project'), null);
  assert.ok(page.one((e) => e.classList.contains('hc-np-problem') && /lowercase/.test(e.textContent) && !e.hidden));
  page = await on('/projects', { site: { variant: 'readonly' } });
  await page.send({ type: 'hc-new-project' });
  assert.ok(!page.one((e) => e.getAttribute && e.getAttribute('data-new-project') !== null && !e.hidden));
});

// ------------------------------------------------------- js/app.js (public markup) ---

test('ED42: a project page shows ONE status tag — the facts row\'s; the lead holds only the line', async () => {
  const site = await bootSite({ hash: '#/projects/hippocampus-vehicle' });
  const html = String(site.content.innerHTML);
  assert.equal((html.match(/class="badge active"/g) || []).length, 1);
  assert.match(html, /<p class="lead" data-hc-fact="tagline">[^<]*<\/p>/);
  assert.ok(html.indexOf('class="badge active"') > html.indexOf('class="key-facts"'), 'the one in the details row');
});

test('ED37: the title, the line, the status and the repositories carry data-hc-fact (the frame finds them)', async () => {
  const site = await bootSite({ hash: '#/projects/core-stack' });
  const html = String(site.content.innerHTML);
  const core = JSON.parse(CORE_TEXT);
  assert.match(html, /<h1 [^>]*data-hc-fact="name"[^>]*>/);
  assert.match(html, new RegExp(`data-hc-fact="status" data-hc-value="${core.status}"`));
  assert.match(html, new RegExp(`data-hc-fact="repos" data-hc-value="${core.repos.map((r) => r.name).join(' ')}"`));
});

test('ED51: the Projects page ends with a hidden "+ New project" card (the frame shows it in Editor mode)', async () => {
  const site = await bootSite({ hash: '#/projects' });
  const html = String(site.content.innerHTML);
  const m = /<div class="project-grid project-new-row" hidden><button type="button" class="card project-card project-new" data-hc-new-project>[\s\S]*?<\/button>/.exec(html);
  assert.ok(m, 'the card, hidden');
  assert.match(m[0], /New project/);
  assert.ok(!/<(h[1-6]|p)[\s>]/.test(m[0]), 'fix B11: no heading or paragraph inside the button (spans styled the same)');
  assert.ok(html.indexOf('data-hc-new-project') > html.lastIndexOf('href="#/projects/'), 'after the last project');
});

test('ED51: every side-menu group ends with "+ New page": a prefilled issue in a new tab (shown in Editor mode only)', async () => {
  const site = await bootSite({ hash: '#/setup/getting-started/px4-setup' });
  const html = String(site.sidebar.innerHTML);
  const groups = html.match(/<details class="sb-group[^>]*>[\s\S]*?<\/details>/g) || [];
  assert.ok(groups.length >= 10);
  for (const g of groups) {
    const title = /<summary>([^<]*)<\/summary>/.exec(g)[1];
    // fix B11 (WCAG 3.2.5 advisory): the link says it opens GitHub in a new tab, for screen readers
    const a = /<a class="sb-new-page" href="([^"]+)" target="_blank" rel="noopener noreferrer">\+ New page<span class="visually-hidden"> \(opens GitHub in a new tab\)<\/span><\/a><\/details>$/.exec(g);
    assert.ok(a, `the last item of ${title}`);
    const u = new URL(a[1].replace(/&amp;/g, '&'));
    assert.equal(u.origin + u.pathname, 'https://github.com/desert-mango/hippocampus-docs/issues/new');
    assert.ok(u.searchParams.get('title').startsWith(`New setup page in ${title.replace(/&amp;/g, '&')}: `));
    assert.match(u.searchParams.get('body'), /tools\/rst_convert\.py/);
  }
  const css = readRepo('css/site.css');
  assert.match(css, /\.sb-new-page \{ display: none; \}/);
  assert.match(css, /body\.hc-editor-on \.sb-new-page \{ display: block; \}/);
});

test('fix B11 (WCAG 2.4.3): the New project dialog keeps Tab inside, makes the page inert, and gives the focus back on close', async (t) => {
  const page = await on('/projects');
  trackFocus(t, page);
  const before = page.body.childNodes.slice();
  await page.send({ type: 'hc-new-project' });
  const dlg = page.one((e) => e.getAttribute && e.getAttribute('data-new-project') !== null && !e.hidden);
  const field = (n) => page.one((e) => e.getAttribute && e.getAttribute('name') === n && e.tagName !== 'LABEL');
  assert.equal(page.win.document.activeElement, field('id'), 'the first field has the focus');
  for (const el of before) assert.equal(el.getAttribute('inert'), '', 'the page behind is inert');
  const key = (k, shift) => { const ev = { key: k, shiftKey: Boolean(shift), prevented: false, preventDefault() { ev.prevented = true; } };
    for (const fn of dlg.listeners.keydown || []) fn(ev); return ev; };
  page.action('new-project-make').focus();
  assert.equal(key('Tab').prevented, true);
  assert.equal(page.win.document.activeElement, field('id'), 'Tab from the last control wraps to the first');
  key('Tab', true);
  assert.equal(page.win.document.activeElement, page.action('new-project-make'), 'Shift+Tab from the first wraps to the last');
  field('name').focus();
  assert.equal(key('Tab').prevented, false, 'inside, Tab moves as usual');
  page.action('new-project-cancel').click();
  for (const el of before) assert.equal(el.getAttribute('inert'), null, 'the page is back');
  assert.equal(page.win.document.activeElement, page.frame(), 'the focus goes back to the page, where "+ New project" is');
});
