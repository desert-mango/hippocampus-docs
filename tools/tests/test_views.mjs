// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 21 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: View tests for the public site's string-written views over the vm harness, one marked section per uiux unit.
/* View tests (uiux plan, unit 0 scaffold). Each unit of the uiux build edits
   ONLY its own marked section below; the harness contract is the header of
   tools/tests/view_harness.mjs (what a test may rely on, and nothing else).

     node --test tools/tests/test_views.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootSite, contrastPairs } from './view_harness.mjs';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const SITE_CSS = fs.readFileSync(path.join(ROOT, 'css', 'site.css'), 'utf8');

// ==== SMOKE (unit 0) ====

test('boot renders the home hero: site.content.innerHTML contains hero-search-form', async () => {
  const site = await bootSite({ hash: '#/' });
  assert.deepEqual(site.errors, [], 'every index.html script loads');
  assert.match(String(site.content.innerHTML), /hero-search-form/);
});

test('contrastPairs: dark --body on --bg is 10.09:1 (hand-computed from #b9b9b9 on #0a0a0a)', () => {
  const cp = contrastPairs(SITE_CSS);
  assert.equal(cp.dark['--body'], '#b9b9b9');
  assert.equal(cp.dark['--bg'], '#0a0a0a');
  assert.equal(cp.ratio(cp.dark['--body'], cp.dark['--bg']).toFixed(2), '10.09');
});

test('contrastPairs: light --body on the error panel, color-mix(in srgb, --danger 7%, --bg), is 8.98:1', () => {
  const cp = contrastPairs(SITE_CSS);
  // #c62828 7% into #fafafa: (246.36, 235.3, 235.3) by hand
  const panel = cp.mix(cp.light['--danger'], cp.light['--bg'], 7);
  assert.equal(panel, 'rgba(246.36, 235.3, 235.3, 1)');
  assert.equal(cp.ratio(cp.light['--body'], panel).toFixed(2), '8.98');
  // the light block overlays :root; a token it does not set is inherited, a var() resolved
  assert.equal(cp.light['--active'], cp.dark['--active']);
  assert.equal(cp.dark['--note-warn'], cp.dark['--warn']);
});

// ==== UNIT S ====

// ==== UNIT SHELL ====

// ==== UNIT SETUP ====
/* Setup pages clear #content and append (plan ground rule 9), so there is no
   view test here: the pure helpers js/app.js exports as window.HCSetup are
   tested on the booted site's window, and the page structure is browser-checked. */

let setupHelpersP = null;
const setupHelpers = () => {
  setupHelpersP = setupHelpersP || bootSite({ hash: '#/' }).then((site) => site.win.HCSetup);
  return setupHelpersP;
};

test('P1 tocModel: three h2/h3 headings give three entries, h3 kept as level 3, h4 and id-less headings left out', async () => {
  const S = await setupHelpers();
  assert.ok(S && Object.isFrozen(S), 'window.HCSetup is exported frozen');
  const toc = S.tocModel([
    { tag: 'H2', id: 'install', text: ' Install ' },
    { tag: 'h3', id: 'on-ubuntu', text: 'On Ubuntu' },
    { tag: 'h4', id: 'deep', text: 'Too deep' },
    { tag: 'h2', id: '', text: 'No id' },
    { tag: 'h2', id: 'flash', text: 'Flash' },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(toc)), [
    { id: 'install', text: 'Install', level: 2 },
    { id: 'on-ubuntu', text: 'On Ubuntu', level: 3 },
    { id: 'flash', text: 'Flash', level: 2 },
  ]);
});

test('P1 tocModel: fewer than three h2/h3 headings give no table of contents', async () => {
  const S = await setupHelpers();
  assert.deepEqual(JSON.parse(JSON.stringify(S.tocModel([
    { tag: 'h2', id: 'a', text: 'A' }, { tag: 'h3', id: 'b', text: 'B' }, { tag: 'h4', id: 'c', text: 'C' },
  ]))), []);
  assert.deepEqual(JSON.parse(JSON.stringify(S.tocModel([]))), []);
  assert.deepEqual(JSON.parse(JSON.stringify(S.tocModel(null))), []);
});

test('P10 pageDate: a YYYY-MM-DD last_commit is shown; a missing doc, page or date, or a malformed one, is null', async () => {
  const S = await setupHelpers();
  const doc = { pages: {
    'setup/a': { last_commit: '2026-10-19' },
    'setup/b': { last_commit: null },
    'setup/c': { last_commit: '2026-10-19T08:00:00Z' },
    'setup/d': { last_commit: 20261019 },
    'setup/e': {},
    'setup/f': { last_commit: '<b>2026-10-19</b>' },
  } };
  assert.equal(S.pageDate(doc, 'setup/a'), '2026-10-19');
  for (const k of ['setup/b', 'setup/c', 'setup/d', 'setup/e', 'setup/f', 'setup/none', 'toString', '__proto__']) {
    assert.equal(S.pageDate(doc, k), null, k);
  }
  assert.equal(S.pageDate(null, 'setup/a'), null);
  assert.equal(S.pageDate({}, 'setup/a'), null);
  assert.equal(S.pageDate({ pages: 'x' }, 'setup/a'), null);
});

test('P9 pageNavModel: the first page has no previous, the last no next, a middle page both', async () => {
  const S = await setupHelpers();
  const flat = [{ id: 'g/a', title: 'A' }, { id: 'g/b', title: 'B' }, { id: 'g/c', title: 'C' }];
  const plain = (v) => JSON.parse(JSON.stringify(v));
  assert.deepEqual(plain(S.pageNavModel(flat, 0)),
    { prev: null, next: { id: 'g/b', title: 'B', href: '#/setup/g/b' } });
  assert.deepEqual(plain(S.pageNavModel(flat, 1)),
    { prev: { id: 'g/a', title: 'A', href: '#/setup/g/a' }, next: { id: 'g/c', title: 'C', href: '#/setup/g/c' } });
  assert.deepEqual(plain(S.pageNavModel(flat, 2)),
    { prev: { id: 'g/b', title: 'B', href: '#/setup/g/b' }, next: null });
  assert.deepEqual(plain(S.pageNavModel([], 0)), { prev: null, next: null });
});

test('P2 copyText: a long one-line command stays one line; "$ " prompts are stripped; trailing space trimmed', async () => {
  const S = await setupHelpers();
  const long = `$ sudo apt install ${'ros-jazzy-some-very-long-package-name '.repeat(8).trim()}`;
  const out = S.copyText(`${long}\n`);
  assert.equal(out.split('\n').length, 1);
  assert.equal(out, long.slice(2));
  assert.equal(S.copyText('$ cd ws\n$ colcon build\n'), 'cd ws\ncolcon build');
  assert.equal(S.copyText('echo $ HOME\n  x  \n'), 'echo $ HOME\n  x');
});

test('P8 the setup start page no longer points readers at the internal docs/setup-parity.md', () => {
  const md = fs.readFileSync(path.join(ROOT, 'content', 'setup', 'start', 'index.md'), 'utf8');
  assert.doesNotMatch(md, /setup-parity/);
  assert.match(md, /^This section gets you from a blank machine to a running robot or simulation\./m);
});

test('G2 note boxes: body text and title on the warn tint are >= 4.5:1 in both themes (rules read from css/site.css)', () => {
  const cp = contrastPairs(SITE_CSS);
  const pct = (re, what) => {
    const m = re.exec(SITE_CSS);
    assert.ok(m, `css/site.css has ${what}`);
    return { pct: parseFloat(m[1]), other: m[2] && m[2].trim() };
  };
  // the fill: color-mix(in srgb, var(--note-warn) N%, var(--surface)) on .adm-warning/.adm-attention/.adm-caution
  const fill = pct(/\.adm-warning,\s*\.adm-attention,\s*\.adm-caution\s*\{[^}]*background:\s*color-mix\(in srgb,\s*var\(--note-warn\)\s*([\d.]+)%,\s*var\(--surface\)\)/,
    'the tinted note-box fill');
  // the light title ink: color-mix(in srgb, var(--note-warn) M%, <dark>)
  const ink = pct(/\[data-theme="light"\]\s*\.adm-warning \.adm-title[^{]*\{[^}]*color:\s*color-mix\(in srgb,\s*var\(--note-warn\)\s*([\d.]+)%,\s*([^)]+)\)/,
    'the light-mode note title ink');
  const pairs = [];
  for (const theme of ['dark', 'light']) {
    const t = cp[theme];
    const tint = cp.mix(t['--note-warn'], t['--surface'], fill.pct);
    const title = theme === 'light' ? cp.mix(t['--note-warn'], ink.other, ink.pct) : t['--note-warn'];
    pairs.push([`${theme} body/tint`, cp.ratio(t['--body'], tint)]);
    pairs.push([`${theme} title/tint`, cp.ratio(title, tint)]);
  }
  for (const [name, r] of pairs) assert.ok(r >= 4.5, `${name} is ${r.toFixed(2)}:1, under 4.5:1`);
  // the tint is a real fill, not the plain box: it differs from --surface in both themes
  for (const theme of ['dark', 'light']) {
    assert.notEqual(cp.mix(cp[theme]['--note-warn'], cp[theme]['--surface'], fill.pct), cp.mix(cp[theme]['--surface'], cp[theme]['--surface'], 50));
  }
});

// ==== UNIT H ====

// ==== UNIT J ====

// ==== UNIT M ====

// ==== UNIT E ====
