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

const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

test('P5: a setup page\'s sidebar holds exactly one open group, the active page\'s', async () => {
  const site = await bootSite({ hash: '#/setup/getting-started/px4-setup' });
  const html = String(site.sidebar.innerHTML);
  assert.equal((html.match(/<details class="sb-group" open>/g) || []).length, 1);
  assert.ok((html.match(/<details class="sb-group">/g) || []).length >= 10, 'the other groups are closed');
  const open = html.slice(html.indexOf('<details class="sb-group" open>'));
  assert.match(open.slice(0, open.indexOf('</details>')), /<summary>Getting started<\/summary>/);
  assert.match(html, /href="#\/setup\/getting-started\/px4-setup" class="active" aria-current="page"/);
});

test('P6: duplicate setup titles carry a muted group suffix in the sidebar', async () => {
  const site = await bootSite({ hash: '#/setup/getting-started/px4-setup' });
  const html = String(site.sidebar.innerHTML);
  assert.match(html, /Pre-built Packages<span class="sb-suffix"> · Getting started<\/span>/);
  assert.match(html, /Quality-of-Life Features<span class="sb-suffix"> · Raspberry Pi setup<\/span>/);
  assert.doesNotMatch(html, /PX4 Setup<span class="sb-suffix">/i, 'a unique title has no suffix');
});

test('H2: the footer says "HippoCampus Robotics lab documentation", no "staging"', () => {
  const footer = INDEX_HTML.slice(INDEX_HTML.indexOf('<footer'), INDEX_HTML.indexOf('</footer>'));
  assert.match(footer, /HippoCampus Robotics lab documentation/);
  assert.doesNotMatch(footer, /staging/i);
  assert.doesNotMatch(footer, /HippoCampusRobotics lab/);
});

test('P4: #signin-btn is the last element inside .header-actions, a labelled button that starts hidden', () => {
  const start = INDEX_HTML.indexOf('<div class="header-actions">');
  assert.ok(start > 0);
  const actions = INDEX_HTML.slice(start, INDEX_HTML.indexOf('</header>'));
  const tags = [...actions.matchAll(/<(button|a|form)\b[^>]*>/g)].map((m) => m[0]);
  const last = tags[tags.length - 1];
  assert.match(last, /^<button id="signin-btn" class="hc-signin" type="button" hidden aria-label="Sign in to edit">$/);
  assert.match(actions, /<span class="hc-signin-label">Sign in<\/span>/);
});

test('F4/F1: the header search toggle and the drawer toggle are labelled buttons wired by aria-controls', () => {
  assert.match(INDEX_HTML, /<button id="search-toggle" class="search-toggle" type="button" aria-label="Search" aria-expanded="false" aria-controls="search-form">/);
  assert.ok(INDEX_HTML.indexOf('id="search-toggle"') < INDEX_HTML.indexOf('id="search-form"'), 'the toggle comes before the form');
  assert.match(INDEX_HTML, /<button id="sidebar-toggle" class="sidebar-toggle" type="button" aria-controls="sidebar" aria-expanded="false" hidden>/);
  assert.ok(INDEX_HTML.indexOf('id="sidebar-toggle"') < INDEX_HTML.indexOf('id="sidebar"'), 'the drawer toggle comes before the sidebar');
});

// ==== UNIT SETUP ====

// ==== UNIT H ====

// ==== UNIT J ====

// ==== UNIT M ====

// ==== UNIT E ====
