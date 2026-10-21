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

test('contrastPairs: light --body on the error panel, color-mix(in srgb, --danger 7%, --bg), is 8.62:1 (E2: light --bg #f5f5f7)', () => {
  const cp = contrastPairs(SITE_CSS);
  // #c62828 7% into #f5f5f7: (241.71, 230.65, 232.51) by hand
  const panel = cp.mix(cp.light['--danger'], cp.light['--bg'], 7);
  assert.equal(panel, 'rgba(241.71, 230.65, 232.51, 1)');
  assert.equal(cp.ratio(cp.light['--body'], panel).toFixed(2), '8.62');
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
/* E1 (not-found view, errorPanel advice only on local hosts), the J8 redirect, E2 (light-theme
   depth: the token step, the card shadow, and every contrast pair parsed out of css/site.css). */

test('E1: an unknown route shows the not-found view, titled "Page not found", with no dev advice on a public host', async () => {
  const site = await bootSite({ hash: '#/' });
  await site.go('#/nonexistent-page');
  const html = String(site.content.innerHTML);
  assert.match(html, /Page not found/);
  assert.match(html, /<code>\/nonexistent-page<\/code>/, 'the requested path, in <code>');
  assert.match(html, /role="search"/, 'a search form');
  for (const href of ['#/setup', '#/projects', '#/team']) assert.ok(html.includes(`href="${href}"`), href);
  assert.doesNotMatch(html, /error-panel/, 'no red box');
  assert.doesNotMatch(html, /serve\.sh/);
  assert.ok(String(site.title).startsWith('Page not found'), String(site.title));
});

test('E1: a missing setup page, project or tool is the same not-found view', async () => {
  const site = await bootSite({ hash: '#/' });
  for (const hash of ['#/setup/does-not-exist', '#/projects/no-such-project', '#/tools/no-such-tool']) {
    await site.go(hash);
    assert.match(String(site.content.innerHTML), /Page not found/, hash);
    assert.ok(String(site.title).startsWith('Page not found'), `${hash}: ${site.title}`);
  }
});

test('E1: the requested path is escaped in the not-found view', async () => {
  const site = await bootSite({ hash: '#/' });
  await site.go('#/<img src=x onerror=alert(1)>');
  const html = String(site.content.innerHTML);
  assert.match(html, /Page not found/);
  assert.doesNotMatch(html, /<img src=x/);
});

test('E1: a real fetch failure on localhost keeps the red box and the serve.sh advice', async () => {
  const site = await bootSite({ hash: '#/', hostname: 'localhost', protocol: 'http:', files: { 'data/site.json': '{broken' } });
  const html = String(site.content.innerHTML);
  assert.match(html, /error-panel/);
  assert.match(html, /serve\.sh/);
});

test('E1: a real fetch failure on the public site has no dev advice, only reload and the three links', async () => {
  const site = await bootSite({ hash: '#/', files: { 'data/site.json': '{broken' } });
  const html = String(site.content.innerHTML);
  assert.match(html, /error-panel/);
  assert.doesNotMatch(html, /serve\.sh|file:\/\//);
  assert.match(html, /could not be loaded/);
  for (const href of ['#/setup', '#/projects', '#/team']) assert.ok(html.includes(`href="${href}"`), href);
});

test('J8: the old run-guide route redirects to the guide heading on the Learning to Swim page', async () => {
  const site = await bootSite({ hash: '#/' });
  await site.go('#/projects/learning-to-swim-run-guide');
  assert.equal(site.replaced[0], '#/projects/learning-to-swim@simulation-run-guide');
});

test('J8: the old run-guide redirect keeps a ?query (an old ?editor= link), before the guide anchor (codex r1)', async () => {
  const site = await bootSite({ hash: '#/' });
  await site.go('#/projects/learning-to-swim-run-guide?editor=changes');
  assert.equal(site.replaced[0], '#/projects/learning-to-swim?editor=changes@simulation-run-guide');
});

test('E1: HCRoute.notFoundAdvice is true only for file:, localhost and 127.0.0.1', async () => {
  const site = await bootSite({ hash: '#/' });
  const R = site.win.HCRoute;
  assert.ok(Object.isFrozen(R));
  assert.equal(R.notFoundAdvice({ protocol: 'file:', hostname: '' }), true);
  assert.equal(R.notFoundAdvice({ protocol: 'http:', hostname: 'localhost' }), true);
  assert.equal(R.notFoundAdvice({ protocol: 'http:', hostname: '127.0.0.1' }), true);
  assert.equal(R.notFoundAdvice({ protocol: 'https:', hostname: 'hippocampus-docs.vercel.app' }), false);
  assert.equal(R.notFoundAdvice({ protocol: 'https:', hostname: 'localhost.example.org' }), false);
  assert.equal(R.notFoundAdvice(null), false);
});

test('E1: HCRoute.isNotFound knows the router\'s not-found errors and nothing else', async () => {
  const site = await bootSite({ hash: '#/' });
  const R = site.win.HCRoute;
  const nf = Object.assign(new Error('x'), { notFound: true });
  assert.equal(R.isNotFound(nf), true);
  for (const m of ['No setup page “x”', 'No project “x”', 'No tool “x”', 'Unknown page: /x']) assert.equal(R.isNotFound(new Error(m)), true, m);
  for (const m of ['data/site.json: HTTP 404', 'data/people.json is malformed', 'see No project']) assert.equal(R.isNotFound(new Error(m)), false, m);
  assert.equal(R.isNotFound(null), false);
});

test('J8: HCRoute.redirectFor maps only the frozen old ids', async () => {
  const site = await bootSite({ hash: '#/' });
  const R = site.win.HCRoute;
  assert.equal(R.redirectFor('/projects/learning-to-swim-run-guide'), '#/projects/learning-to-swim@simulation-run-guide');
  assert.equal(R.redirectFor('/projects/learning-to-swim'), null);
  assert.equal(R.redirectFor('/toString'), null, 'no prototype keys');
  assert.equal(R.redirectFor(undefined), null);
  assert.ok(Object.isFrozen(R.REDIRECTS));
});

test('E2: light mode has a real step between page and card, and a card shadow; dark has none', () => {
  const cp = contrastPairs(SITE_CSS);
  assert.notEqual(cp.light['--bg'], cp.light['--surface']);
  assert.ok(cp.ratio(cp.light['--surface'], cp.light['--bg']) >= 1.05, 'surface vs page step');
  assert.ok(cp.ratio(cp.light['--surface'], cp.light['--bg-soft']) > cp.ratio(cp.light['--surface'], cp.light['--bg']));
  assert.equal(cp.dark['--card-shadow'], 'none');
  assert.notEqual(cp.light['--card-shadow'], 'none');
  assert.match(cp.light['--card-shadow'], /rgba\(0, ?0, ?0/);
  const block = SITE_CSS.slice(SITE_CSS.indexOf('/* ==== UNIT E')).replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    sels: m[1].split(',').map((x) => x.trim().replace(/\s+/g, ' ')), body: m[2] }));
  for (const sel of ['.card', '.quiet', '.person-card', '.hc-tile', '.hc-col', '.hc-heat', '.askbox form']) {
    const want = `[data-theme="light"] ${sel}`;
    assert.ok(rules.some((r) => r.sels.includes(want) && /box-shadow:\s*var\(--card-shadow\)/.test(r.body)),
      `${want} gets box-shadow: var(--card-shadow) in the UNIT E block`);
  }
});

test('E2: text contrast pairs, parsed from css/site.css (WCAG 1.4.3)', () => {
  const cp = contrastPairs(SITE_CSS);
  const L = cp.light;
  const D = cp.dark;
  const at = (t, fg, bg, min) => {
    const r = cp.ratio(t[fg] || fg, t[bg] || bg);
    assert.ok(r >= min, `${fg} on ${bg}: ${r.toFixed(2)} < ${min}`);
  };
  for (const t of [L, D]) {
    at(t, '--body', '--surface', 7);
    at(t, '--body', '--bg', 7);
    at(t, '--heading', '--surface', 7);
    at(t, '--body-soft', '--surface', 4.5);
    at(t, '--body-soft', '--bg', 4.5);
  }
  // --muted is darkened in light mode (E2); the dark theme's --muted is not E2's to change
  for (const bg of ['--surface', '--bg', '--surface-2', '--bg-soft']) at(L, '--muted', bg, 4.5);
  // the G2 note boxes, the tint the way unit SETUP's step 6 defines it:
  // color-mix(in srgb, var(--note-warn) 14%, var(--surface)). Body ink on it in both themes, and the dark
  // title (--note-warn). The LIGHT title ink is SETUP's rule and SETUP's test: the plan's
  // color-mix(--note-warn 70%, #000) measures 4.22:1 here, under 4.5 (unit E report, section 7).
  for (const [name, t] of [['light', L], ['dark', D]]) {
    const tint = cp.mix(t['--note-warn'], t['--surface'], 14);
    const body = cp.ratio(t['--body'], tint);
    assert.ok(body >= 4.5, `${name} body on the note tint: ${body.toFixed(2)}`);
  }
  const darkTint = cp.mix(D['--note-warn'], D['--surface'], 14);
  const darkTitle = cp.ratio(D['--note-warn'], darkTint);
  assert.ok(darkTitle >= 4.5, `dark title on the note tint: ${darkTitle.toFixed(2)}`);
});
