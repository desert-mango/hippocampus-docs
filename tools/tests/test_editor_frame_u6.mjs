// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 23 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test the U6 project page work inside the preview frame: the facts fields drawn in the page.
/* Made by U0 (editor UI/UX build) so unit U6 adds its tests here, not to a shared test file.

   U6 (plan D17, D11): js/editor-frame.js's facts section. On a project page (js/app.js marks the facts with
   data-hc-fact) with hc-editor.facts.edit, a click edits a fact in place and posts hc-facts {field, value};
   with facts.lock the page carries the lock line under the title and a click shows the same line as a notice;
   with facts.create the Projects page's "+ New project" card shows and posts hc-new-project.

     node --test tools/tests/test_editor_frame_u6.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { el, makeDoc, fakeHC, fakeWin, kids } from './frame_harness.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const EF = require(path.join(ROOT, 'js', 'editor-frame.js'));

const STATUSES = ['active', 'maintained', 'legacy', 'archive'];
const FACTS = (o) => ({ facts: Object.assign({ edit: true, lock: false, create: true, statuses: STATUSES }, o) });

/* A project page as js/app.js draws it (the parts U6 reads). */
function projectPage() {
  const doc = makeDoc();
  const content = el(doc, 'main', { id: 'content', class: 'content' });
  doc.body.appendChild(content);
  const h1 = el(doc, 'h1', { 'data-hc-fact': 'name' }, 'Core stack');
  const lead = el(doc, 'p', { class: 'lead', 'data-hc-fact': 'tagline' }, 'The shared packages.');
  const status = el(doc, 'dd', { 'data-hc-fact': 'status', 'data-hc-value': 'active' }, el(doc, 'span', { class: 'badge active' }, 'active'));
  const repos = el(doc, 'div', { 'data-hc-fact': 'repos', 'data-hc-value': 'hippo_core hippo_msgs' }, el(doc, 'h3', null, 'Repositories (2)'));
  const story = el(doc, 'p', null, 'The story.');
  const page = el(doc, 'div', { class: 'project-page' }, el(doc, 'a', { class: 'back-link', href: '#/projects' }, 'All'),
    h1, lead, el(doc, 'dl', { class: 'key-facts' }, el(doc, 'div', null, el(doc, 'dt', null, 'Status'), status)),
    el(doc, 'aside', null, repos), story);
  content.appendChild(page);
  return { doc, content, h1, lead, status, repos, story, page };
}
function boot(m, made) {
  const p = made || projectPage();
  const HC = fakeHC();
  const win = fakeWin();
  EF.create(win, p.doc, HC);
  HC.send(Object.assign(FACTS(), m || {}));
  return Object.assign(p, { HC, win, facts: () => HC.posts.filter((x) => x.type === 'hc-facts') });
}
const walkAll = (n, pred, out = []) => { for (const c of kids(n)) { if (pred(c)) out.push(c); walkAll(c, pred, out); } return out; };
const byClass = (n, cls) => walkAll(n, (c) => c.classList.contains(cls));
const key = (node, k) => node.dispatch('keydown', node, { key: k });

test('facts.edit: each fact is marked as one to change (class, focus, a tip); not without edit', () => {
  const p = boot();
  for (const n of [p.h1, p.lead, p.status, p.repos]) {
    assert.ok(n.classList.contains('hc-fact'));
    assert.equal(n.getAttribute('tabindex'), '0');
    assert.match(n.getAttribute('title'), /^Click to change /);
  }
  p.HC.send(FACTS({ edit: false }));
  assert.equal(p.h1.classList.contains('hc-fact'), false);
  assert.equal(p.h1.getAttribute('tabindex'), null);
});

test('the title: a click makes it one-line text; Enter keeps it and posts hc-facts {name}; Escape puts it back', () => {
  const p = boot();
  p.h1.click();
  assert.equal(p.h1.getAttribute('contenteditable'), 'true');
  p.h1.textContent = '  Core   stack 2 ';
  key(p.h1, 'Enter');
  assert.equal(p.h1.getAttribute('contenteditable'), null);
  assert.deepEqual(p.facts(), [{ type: 'hc-facts', field: 'name', value: 'Core stack 2' }]);
  p.lead.click();
  p.lead.textContent = 'Something else';
  key(p.lead, 'Escape');
  assert.equal(p.lead.textContent, 'The shared packages.');
  assert.equal(p.facts().length, 1, 'nothing posted');
  // unchanged: nothing posted
  p.lead.click();
  key(p.lead, 'Enter');
  assert.equal(p.facts().length, 1);
  // leaving the field keeps it
  p.lead.click();
  p.lead.textContent = 'A new line.';
  p.lead.dispatch('blur', p.lead);
  assert.deepEqual(p.facts().at(-1), { type: 'hc-facts', field: 'tagline', value: 'A new line.' });
});

test('the status: a small menu of the allowed values, the current one checked; a pick posts hc-facts {status}', () => {
  const p = boot();
  p.status.click();
  const [menu] = byClass(p.status, 'hc-fact-menu');
  assert.ok(menu);
  const opts = kids(menu);
  assert.deepEqual(opts.map((b) => b.getAttribute('data-status')), STATUSES);
  assert.equal(opts[0].getAttribute('aria-checked'), 'true');
  opts[2].click();
  assert.deepEqual(p.facts(), [{ type: 'hc-facts', field: 'status', value: 'legacy' }]);
  assert.equal(byClass(p.status, 'hc-fact-menu').length, 0, 'the menu closed');
  p.status.click();
  kids(byClass(p.status, 'hc-fact-menu')[0])[0].click();
  assert.equal(p.facts().length, 1, 'the same status: nothing posted');
});

test('the repositories: remove one, add one by name (a bad name is said), Done posts hc-facts {repos} in order', () => {
  const p = boot();
  p.repos.click();
  const [panel] = byClass(p.repos, 'hc-fact-repos');
  assert.ok(panel);
  const rows = () => byClass(panel, 'hc-fact-repo').map((li) => li.getAttribute('data-repo'));
  assert.deepEqual(rows(), ['hippo_core', 'hippo_msgs']);
  byClass(panel, 'hc-fact-repo').find((li) => li.getAttribute('data-repo') === 'hippo_core').childNodes[1].click();
  assert.deepEqual(rows(), ['hippo_msgs']);
  const [input] = byClass(panel, 'hc-fact-repo-input');
  input.value = 'not a name';
  key(input, 'Enter');
  const [problem] = byClass(panel, 'hc-fact-problem');
  assert.equal(problem.hidden, false);
  assert.match(problem.textContent, /not a repository name/);
  input.value = 'sonar_driver';
  key(input, 'Enter');
  assert.deepEqual(rows(), ['hippo_msgs', 'sonar_driver']);
  assert.equal(p.facts().length, 0, 'nothing posted before Done');
  byClass(panel, 'hc-fact-done')[0].click();
  assert.deepEqual(p.facts(), [{ type: 'hc-facts', field: 'repos', value: ['hippo_msgs', 'sonar_driver'] }]);
  assert.equal(byClass(p.repos, 'hc-fact-repos').length, 0);
});

test('without facts.edit a click on a fact does nothing', () => {
  const p = boot(FACTS({ edit: false }));
  p.h1.click();
  p.status.click();
  assert.equal(p.h1.getAttribute('contenteditable'), null);
  assert.equal(byClass(p.status, 'hc-fact-menu').length, 0);
  assert.equal(p.facts().length, 0);
});

test('facts.lock: the lock line under the title; its button posts hc-access-ask; gone when the lock lifts', () => {
  const p = boot(FACTS({ edit: false, lock: true }));
  const line = p.h1.nextSibling;
  assert.ok(line && line.classList.contains('hc-lock-line'), 'right under the title');
  assert.equal(line.textContent, 'Only this project\'s editors can change it · Request edit access');
  const ask = kids(line).find((c) => c.getAttribute('data-action') === 'access-ask');
  ask.click();
  assert.deepEqual(p.HC.posts.filter((x) => x.type === 'hc-access-ask'), [{ type: 'hc-access-ask' }]);
  p.HC.send(FACTS({ edit: false, lock: true }));
  assert.equal(byClass(p.content, 'hc-lock-line').length, 1, 'drawn once');
  p.HC.send(FACTS({ edit: true, lock: false }));
  assert.equal(byClass(p.content, 'hc-lock-line').length, 0);
});

test('facts.lock: a click in the page shows the same line as a short notice (not on a link)', () => {
  const p = boot(FACTS({ edit: false, lock: true }));
  const clicks = p.doc.listeners.click || [];
  const fire = (target) => clicks.forEach((fn) => fn({ type: 'click', target }));
  fire(kids(p.page)[0]);                                    // the back link
  assert.equal(byClass(p.doc.body, 'hc-lock-toast').length, 0);
  let shown = null;
  p.win.setTimeout = () => 1;                               // the notice stays while it is looked at
  fire(p.story);
  [shown] = byClass(p.doc.body, 'hc-lock-toast');
  assert.ok(shown);
  assert.equal(shown.hidden, false);
  assert.equal(shown.textContent, 'Only this project\'s editors can change it.');
  assert.equal(shown.getAttribute('role'), 'status');
});

test('facts.create: the Projects page\'s "+ New project" card shows and posts hc-new-project; hidden without it', () => {
  const doc = makeDoc();
  const content = el(doc, 'main', { id: 'content' });
  doc.body.appendChild(content);
  const card = el(doc, 'button', { type: 'button', class: 'card project-card project-new', 'data-hc-new-project': '' }, 'New project');
  const row = el(doc, 'div', { class: 'project-grid project-new-row', hidden: '' }, card);
  content.appendChild(el(doc, 'div', { class: 'page-body projects-page' }, row));
  const p = boot(FACTS({ edit: false }), { doc, content });
  assert.equal(row.getAttribute('hidden'), null, 'shown');
  card.click();
  assert.deepEqual(p.HC.posts.filter((x) => x.type === 'hc-new-project'), [{ type: 'hc-new-project' }]);
  p.HC.send(FACTS({ create: false }));
  assert.equal(row.getAttribute('hidden'), '', 'hidden again');
  card.click();
  assert.equal(p.HC.posts.filter((x) => x.type === 'hc-new-project').length, 1);
});

test('Editor off: no fact is marked, no lock line, the card stays hidden', () => {
  const p = boot({ on: false, facts: { edit: true, lock: true, create: true, statuses: STATUSES } });
  assert.equal(p.h1.classList.contains('hc-fact'), false);
  assert.equal(byClass(p.content, 'hc-lock-line').length, 0);
  p.h1.click();
  assert.equal(p.facts().length, 0);
});

/* The walk's facts hook (TEST-ONLY, like the picker's): on localhost under a top window that is not the parent,
   {type: 'hc-walk-facts', click} from that top window clicks the fact and answers its state. The listener is
   added only on a page that has a fact or the "+ New project" card, so other pages keep the picker's one. */
function walkBoot(made, hostname = '127.0.0.1') {
  const p = made || projectPage();
  const HC = fakeHC();
  const win = fakeWin();
  win.location.hostname = hostname;
  win.parent = { name: 'the site' };
  const answers = [];
  win.top = { name: 'the walk', postMessage: (m, o) => answers.push([m, o]) };
  EF.create(win, p.doc, HC);
  HC.send(Object.assign({ on: true }, FACTS()));
  const say = (source, data) => (win.listeners.message || []).forEach((fn) => fn({ source, origin: 'http://127.0.0.1:8130', data }));
  return Object.assign(p, { HC, win, answers, say });
}

test('walk hook: hc-walk-facts from the top window clicks the fact and answers its state; nothing from anyone else', () => {
  const p = walkBoot();
  const before = (p.win.listeners.message || []).length;
  assert.ok(before >= 1, 'a listener on a project page');
  p.say(p.win.parent, { type: 'hc-walk-facts', click: 'name' });
  assert.deepEqual(p.answers, [], 'the parent is not the walk');
  p.say(p.win.top, { type: 'hc-walk-facts', click: 'name' });
  const facts = p.answers.map(([m]) => m).filter((m) => m.type === 'hc-walk-facts-state');
  assert.equal(facts.length, 1);
  assert.equal(facts[0].editing, 'name');
  assert.deepEqual(facts[0].fields, ['name', 'tagline', 'status', 'repos']);
  assert.equal(facts[0].lock, null);
  assert.equal(p.h1.getAttribute('contenteditable'), 'true', 'the real click opened it');
  p.HC.send(Object.assign({ on: true }, FACTS()));
  assert.equal((p.win.listeners.message || []).length, before, 'added once');
});

test('walk hook: no facts listener on a page without facts, nor off localhost', () => {
  const doc = makeDoc();
  doc.body.appendChild(el(doc, 'main', { id: 'content' }, el(doc, 'p', null, 'A setup page.')));
  const plain = walkBoot({ doc });
  const n = (plain.win.listeners.message || []).length;
  plain.say(plain.win.top, { type: 'hc-walk-facts', click: 'name' });
  assert.equal(plain.answers.filter(([m]) => m.type === 'hc-walk-facts-state').length, 0, 'no facts answer');
  const away = walkBoot(null, 'hippocampus-docs.vercel.app');
  away.say(away.win.top, { type: 'hc-walk-facts', click: 'name' });
  assert.equal(away.answers.length, 0);
  assert.ok(n <= 1);
});

test('walk hook: a locked page answers the lock line', () => {
  const p = walkBoot();
  p.HC.send(Object.assign({ on: true }, FACTS({ edit: false, lock: true })));
  p.say(p.win.top, { type: 'hc-walk-facts' });
  const m = p.answers.map(([x]) => x).filter((x) => x.type === 'hc-walk-facts-state').at(-1);
  assert.match(m.lock, /^Only this project's editors can change it · Request edit access$/);
  assert.deepEqual(m.fields, []);
});

test('walk hook: click "new-project" clicks the Projects page card (it posts hc-new-project)', () => {
  const doc = makeDoc();
  const content = el(doc, 'main', { id: 'content' });
  doc.body.appendChild(content);
  const card = el(doc, 'button', { 'data-hc-new-project': '' }, 'New project');
  content.appendChild(el(doc, 'div', { class: 'project-new-row', hidden: '' }, card));
  const p = walkBoot({ doc });
  p.say(p.win.top, { type: 'hc-walk-facts', click: 'new-project' });
  assert.equal(p.HC.posts.filter((x) => x.type === 'hc-new-project').length, 1);
  const m = p.answers.map(([x]) => x).filter((x) => x.type === 'hc-walk-facts-state').at(-1);
  assert.equal(m.card, true);
});
