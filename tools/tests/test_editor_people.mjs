// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 23 October 2026
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
import { el, makeDoc, setupPage, fakeHC, fakeWin, scriptsIn, runScripts } from './frame_harness.mjs';

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

test('placeholder: U5 (the team unit adds its tests to this file)', () => assert.ok(true));

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
