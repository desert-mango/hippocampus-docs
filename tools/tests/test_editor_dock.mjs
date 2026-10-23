// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 23 October 2026
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
import { openSite, settle, findAll, EDITOR_SCRIPTS } from './editor_harness.mjs';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const readRepo = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const PAGE_ROUTE = '/setup/hippocampus-bringup/fcu-firmware';

test('placeholder: U2 (the dock unit adds its tests to this file)', () => assert.ok(true));

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
