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
