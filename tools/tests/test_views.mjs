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

const H_PHONE = (q) => q === '(max-width: 639px)';
const H_SITE = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'site.json'), 'utf8'));
const hSiteWith = (patch) => ({ 'data/site.json': JSON.stringify({ ...H_SITE, ...patch }) });
const hCount = (html, needle) => html.split(needle).length - 1;

test('H F4: the hero placeholder is the long example on a wide screen', async () => {
  const site = await bootSite({ hash: '#/' });
  const html = String(site.content.innerHTML);
  assert.match(html, /placeholder="e\.g\. how do I flash PX4 on the HippoCampus\?"/);
  assert.doesNotMatch(html, /placeholder="Search the docs…"/);
});

test('H F4: the hero placeholder is "Search the docs…" when (max-width: 639px) matches', async () => {
  const site = await bootSite({ hash: '#/', media: H_PHONE });
  const html = String(site.content.innerHTML);
  assert.match(html, /placeholder="Search the docs…"/);
  assert.doesNotMatch(html, /how do I flash PX4/);
  assert.ok(site.mediaListeners.length >= 1, 'wireHero listens for the width change');
});

test('H H5: the hero image is a 21:9 Cloudinary rendition 1200x514, with alt, not lazy', async () => {
  const site = await bootSite({ hash: '#/' });
  const html = String(site.content.innerHTML);
  const img = /<img class="hero-img"[^>]*>/.exec(html);
  assert.ok(img, 'img.hero-img is rendered');
  const tag = img[0];
  assert.match(tag, /src="https:\/\/res\.cloudinary\.com\/dr76gues0\/image\/upload\/w_1200,c_fill,ar_21:9,g_auto,f_auto,q_auto\/v1790120325\/hippocampus-docs\/projects\/ul_hero_vehicle_in_pool\.jpg"/);
  assert.match(tag, /width="1200"/);
  assert.match(tag, /height="514"/);
  assert.match(tag, /alt="The HippoCampus micro AUV, an orange four-thruster underwater robot, in the lab&#39;s water tank"|alt="The HippoCampus micro AUV, an orange four-thruster underwater robot, in the lab's water tank"/);
  assert.doesNotMatch(tag, /loading="lazy"/);
  // phones get the 16:9 rendition
  assert.match(html, /<source media="\(max-width: 639px\)" srcset="https:\/\/res\.cloudinary\.com\/dr76gues0\/image\/upload\/w_750,c_fill,ar_16:9,g_auto,f_auto,q_auto\/v1790120325\/[^"]+" width="750" height="422">/);
  // the image sits between the lead and the ask box
  assert.ok(html.indexOf('class="lead"') < html.indexOf('hero-img'));
  assert.ok(html.indexOf('hero-img') < html.indexOf('class="askbox'));
});

test('H H5: no hero image when site.json has no usable hero (guarded read)', async () => {
  for (const hero of [undefined, null, 'x', { alt: 'no image' }, { image: 'http://insecure/x.jpg', alt: 'a' }, { image: 42 }]) {
    const site = await bootSite({ hash: '#/', files: hSiteWith({ hero }) });
    assert.deepEqual(site.errors, []);
    const html = String(site.content.innerHTML);
    assert.match(html, /hero-search-form/, `home still renders for hero=${JSON.stringify(hero)}`);
    assert.doesNotMatch(html, /hero-img/, `no image for hero=${JSON.stringify(hero)}`);
  }
});

test('H H3/F5: exactly four example chips', async () => {
  const site = await bootSite({ hash: '#/' });
  const html = String(site.content.innerHTML);
  assert.equal(hCount(html, 'class="ask-chip"'), 4);
  for (const label of ['flash PX4', 'thruster mixer', 'run the simulation', 'acoustic localization']) {
    assert.ok(html.includes(`>${label}</button>`), label);
  }
});

test('H H4: the shorter lead, no counts; the tools card no longer says "3 MCP servers"', async () => {
  const site = await bootSite({ hash: '#/' });
  const html = String(site.content.innerHTML);
  assert.match(html, /<p class="lead">Setup guides, projects, code and CAD for the lab&#39;s underwater robots\. Type a few words, or a symbol name\.<\/p>|<p class="lead">Setup guides, projects, code and CAD for the lab's underwater robots\. Type a few words, or a symbol name\.<\/p>/);
  assert.doesNotMatch(html, /3 MCP servers/);
  assert.match(html, /MCP servers: GPU compute and CAD access\./);
  assert.equal(hCount(html, 'class="quiet"'), 4);
});

test('H H4: the card counts match the registries (setup pages, projects)', async () => {
  const setup = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'setup.json'), 'utf8'));
  const projects = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'projects.json'), 'utf8'));
  const pages = setup.sections.reduce((n, s) => n + s.pages.length, 0);
  const cards = Object.fromEntries(H_SITE.home_cards.map((c) => [c.href, c.text]));
  assert.match(cards['#/setup'], new RegExp(`^${pages} pages`));
  assert.match(cards['#/projects'], new RegExp(`^${projects.projects.length} projects`));
});

// ==== UNIT J ====

// ==== UNIT M ====

// ==== UNIT E ====
