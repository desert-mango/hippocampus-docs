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

// ==== UNIT H ====

// ==== UNIT J ====

test('J12/J6 #/projects: group headings in the fixed order, no repo chips, All is current, no sidebar list', async () => {
  const site = await bootSite({ hash: '#/projects' });
  const html = String(site.content.innerHTML);
  const order = ['>Vehicles<', '>Software<', '>Research<', '>Lab infrastructure<', '>Teaching<', '>Fun<'];
  const at = order.map((h) => html.indexOf(h));
  assert.ok(at.every((i) => i > 0), `every group heading is there: ${at}`);
  assert.deepEqual(at.slice().sort((a, b) => a - b), at, 'in the fixed order');
  assert.doesNotMatch(html, /class="chip"/);
  assert.doesNotMatch(html, /more<\/span>/);
  assert.match(html, /<a [^>]*href="#\/projects"[^>]*aria-current="true"/);
  assert.match(html, /\d+ repositories/);
  assert.match(html, /loading="lazy"/);
  assert.equal(String(site.sidebar.innerHTML), '');
});

test('J12 #/projects?status=legacy lists only legacy badges and marks the Legacy filter', async () => {
  const site = await bootSite({ hash: '#/projects?status=legacy' });
  const html = String(site.content.innerHTML);
  const badges = html.match(/class="badge [a-z]+"/g) || [];
  assert.ok(badges.length >= 1);
  assert.ok(badges.every((b) => b === 'class="badge legacy"'), badges.join(' '));
  assert.match(html, /<a [^>]*href="#\/projects\?status=legacy"[^>]*aria-current="true"/);
  assert.doesNotMatch(html, /<a [^>]*href="#\/projects"[^>]*aria-current="true"/);
});

test('J12 #/projects?status=archive lists only archive badges and the Archive chip is current', async () => {
  const site = await bootSite({ hash: '#/projects?status=archive' });
  const html = String(site.content.innerHTML);
  const badges = html.match(/class="badge [a-z]+"/g) || [];
  assert.ok(badges.length >= 2);
  assert.ok(badges.every((b) => b === 'class="badge archive"'), badges.join(' '));
  assert.match(html, /<a [^>]*href="#\/projects\?status=archive"[^>]*aria-current="true"[^>]*>Archive/);
});

test('J7 #/projects/learning-to-swim: no Repositories heading for a project without repositories', async () => {
  const site = await bootSite({ hash: '#/projects/learning-to-swim' });
  const html = String(site.content.innerHTML);
  assert.match(html, /<h1/);
  assert.doesNotMatch(html, /Repositories/);
});

test('J1/J7/J10/J11 #/projects/hippocampus-vehicle: the wrap, the rights hook first, key facts, counted headings, hero', async () => {
  const site = await bootSite({ hash: '#/projects/hippocampus-vehicle' });
  const html = String(site.content.innerHTML);
  assert.match(html, /class="detail-wrap"/);
  const first = html.indexOf('class="aside-box"');
  assert.ok(first > 0);
  assert.equal(html.indexOf('class="aside-box" data-hc-surface="project-access" data-hc-project="hippocampus-vehicle"'), first,
    'the first aside-box carries the rights hook');
  assert.match(html, /class="key-facts"/);
  assert.match(html, /Repositories \(\d+\)/);
  assert.match(html, /id="project-people"/);
  assert.match(html, /<img [^>]*class="project-hero"[^>]*width="\d+" height="\d+"|<img [^>]*width="\d+" height="\d+"[^>]*class="project-hero"/);
  assert.equal((html.match(/<h1/g) || []).length, 1, 'one h1');
});

test('J10 a project without an image gets no hero', async () => {
  const site = await bootSite({ hash: '#/projects/teaching' });
  const html = String(site.content.innerHTML);
  assert.match(html, /class="key-facts"/);
  assert.doesNotMatch(html, /class="project-hero"/);
});

test('J11 the key-facts row leaves out a zero People count (underwater-localization: no contributors)', async () => {
  const site = await bootSite({ hash: '#/projects/underwater-localization' });
  const html = String(site.content.innerHTML);
  assert.match(html, /class="key-facts"/);
  assert.doesNotMatch(html, /<dt>People<\/dt>/);
  assert.match(html, /class="project-hero"/);
});

// ==== UNIT M ====

// ==== UNIT E ====
