// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 26 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test the /cms/ redirect map: every old editor route lands on the site in Editor mode.
/* Unit tests for js/cms-redirect.js (plan D-I): legacyRoute(cmsHash) maps
   every hash route of the retired /cms/ page to the site page it now lives
   on, with the Editor-mode parameter (D-H) that opens the right tray tab.
   The file must not need js/cms-core.js, and it redirects only on the
   /cms/ page itself (never on /cms/callback.html, never on the site).

   U0b (editor UI/UX build, plan D18) removed the editor's own screens, so the
   targets moved: ?editor=review (the proposals) and ?editor=on (anything else)
   both land on the page with the bubble out (js/editor.js's REDIRECTS;
   tools/tests/test_editor_u0b.mjs proves the landing). Changed here, test by
   test (the deleted-test ledger of this file):
     'the D-I map, route by route'                 -> 'the D-I map, route by route (U0b targets)':
        every target re-pointed (proposals -> review, changes/media/guide -> on;
        &new= dropped, &data= kept); the routes are the same 22.
     'anything else lands on Proposals, …'          -> 'anything else lands on the review redirect, …':
        the fallback is /#/?editor=review.
     'it redirects on /cms/ only, …'                -> unchanged but its two expected URLs re-pointed.

     node --test tools/tests/test_cms_redirect.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const FILE = path.join(ROOT, 'js', 'cms-redirect.js');
const R = require(FILE);

test('the D-I map, route by route (U0b targets)', () => {
  const cases = [
    ['', '/#/?editor=review'],
    ['#', '/#/?editor=review'],
    ['#/', '/#/?editor=review'],
    ['#/review', '/#/?editor=review'],
    ['#/review/', '/#/?editor=review'],
    ['#/review/12', '/#/?editor=review&pr=12'],
    ['#/review/7/', '/#/?editor=review&pr=7'],
    ['#/edit/setup/raspberry-pi/ubuntu-24-04-server', '/#/setup/raspberry-pi/ubuntu-24-04-server?editor=on'],
    ['#/edit/setup/start/index', '/#/setup/start/index?editor=on'],
    ['#/edit/project/uvms', '/#/projects/uvms?editor=on'],
    ['#/edit/tool/onshape-mcp', '/#/tools/onshape-mcp?editor=on'],
    ['#/edit/about', '/#/about?editor=on'],
    ['#/edit/data/people', '/#/about?editor=on&data=people'],
    ['#/edit/data/cloudinary-manifest', '/#/about?editor=on&data=cloudinary-manifest'],
    ['#/new/project', '/#/projects?editor=new-project'],
    ['#/new/person', '/#/about?editor=on'],
    ['#/media', '/#/?editor=on'],
    ['#/help', '/#/?editor=on'],
    ['#/private', '/#/?editor=on'],
    ['#/pages', '/#/setup?editor=on'],
    ['/review/3', '/#/?editor=review&pr=3'],
    ['#/media?from=old', '/#/?editor=on'],
  ];
  for (const [from, to] of cases) assert.equal(R.legacyRoute(from), to, from);
});

test('anything else lands on the review redirect, and the answer is always a same-site /#/ route', () => {
  const junk = [
    '#/nope', '#/review/0', '#/review/abc', '#/review/1234567890', '#/edit/', '#/edit/Setup/X',
    '#/edit/setup/../../x', '#/edit/project/a/b', '#/edit/data/../secret', '#/edit/data/', '#/new/robot',
    '#//evil.example/x', '#/edit/https://evil.example', 'javascript:alert(1)', '#/edit/about\n/x',
    null, undefined, 42, {},
  ];
  for (const h of junk) {
    const out = R.legacyRoute(h);
    assert.equal(out, '/#/?editor=review', String(h));
  }
  const all = ['#/edit/setup/a-b/c_d', '#/review/99', '#/new/person'].map(R.legacyRoute);
  for (const out of all) assert.match(out, /^\/#\/[^/]/);
});

test('it redirects on /cms/ only, with location.replace, and never loads cms-core', () => {
  const src = fs.readFileSync(FILE, 'utf8');
  assert.ok(!/cms-core|HCCore/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')),
    'no cms-core in the code');
  const run = (pathname, hash) => {
    const calls = [];
    const win = { location: { pathname, hash, replace: (u) => calls.push(u) } };
    vm.runInNewContext(src, { window: win, location: win.location });
    return { calls, api: win.HCRedirect };
  };
  assert.deepEqual(run('/cms/', '#/review/5').calls, ['/#/?editor=review&pr=5']);
  assert.deepEqual(run('/cms/index.html', '#/media').calls, ['/#/?editor=on']);
  assert.deepEqual(run('/cms/callback.html', '?code=x').calls, [], 'the App callback page stays');
  assert.deepEqual(run('/', '#/about').calls, [], 'the site itself never redirects');
  assert.equal(typeof run('/', '').api.legacyRoute, 'function');
});
