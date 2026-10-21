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

// ==== UNIT M ====
/* viewTeam clears #content and appends (ground rule 9, R2-1), so the Team page is tested as the string
   builder it writes, window.HCTeam.teamSkeleton, read off the booted window (site.win), and the file. */
async function team() {
  const site = await bootSite({ hash: '#/' });
  assert.ok(site.win.HCTeam && Object.isFrozen(site.win.HCTeam), 'window.HCTeam is exported and frozen');
  return site.win.HCTeam;
}
const P = (name, extra) => Object.assign({ name, title: 'Student', photo: null, link: null }, extra);

test('M1/M6/M7/M15: teamSkeleton: h1 Team, Current team, Alumni, then Lab activity with "GitHub data as of"', async () => {
  const T = await team();
  const html = T.teamSkeleton([['team', 'Current team', [{ person: P('Ada', { link: 'https://example.org/ada' }) }]],
    ['alumni', 'Alumni', [{ person: P('Bo') }]]], '2026-10-21');
  assert.equal((html.match(/<h1[ >]/g) || []).length, 1, 'one h1');
  assert.match(html, /<h1[^>]*>Team<\/h1>/);
  const at = (re) => html.search(re);
  assert.ok(at(/>Current team</) > 0 && at(/>Current team</) < at(/>Alumni</) && at(/>Alumni</) < at(/>Lab activity</),
    'people first, then the activity');
  assert.match(html, /<h2[^>]*>Current team<\/h2>/);
  assert.match(html, /<h2[^>]*>Alumni<\/h2>/);
  assert.match(html, /<h2[^>]*>Lab activity<\/h2>\s*<span class="hc-asof-inline">· GitHub data as of 2026-10-21<\/span>/);
  assert.ok(!/hc-authors|>People<|compact|What the lab|Source: public GitHub/.test(html));
  assert.match(html, /id="people-root"/);
  assert.match(html, /class="team-lab-body"/);
  // no date: no span; no roster: no people mount
  const bare = T.teamSkeleton(null, null);
  assert.ok(!/GitHub data as of|people-root/.test(bare));
  assert.match(bare, />Lab activity</);
  // a hostile name is escaped
  assert.ok(!T.teamSkeleton([['team', 'Current team', [{ person: P('<img src=x onerror=alert(1)>') }]]], '2026-10-21').includes('<img src=x'));
});

test('M5: personCardHTML: a linked card stays an <a> with data-hc-person; a link-less card is a focusable role="button" div', async () => {
  const T = await team();
  const linked = T.personCardHTML({ person: P('Ada Lovelace', { link: 'https://example.org/ada' }), linked: true, active: true, pinned: false });
  assert.match(linked, /^<a class="person-card" href="https:\/\/example\.org\/ada" target="_blank" rel="noopener"/);
  assert.match(linked, /data-hc-person="Ada Lovelace"/);
  assert.match(linked, /data-hc-name="Ada Lovelace" data-link="1" data-linked="1" data-active="1" data-pinned="0"/);
  assert.match(linked, /aria-haspopup="dialog"/);
  assert.ok(!/role="button"|tabindex/.test(linked));
  const plain = T.personCardHTML({ person: P('Bo') });
  assert.match(plain, /^<div class="person-card is-static"/);
  assert.match(plain, /role="button"/);
  assert.match(plain, /tabindex="0"/);
  assert.match(plain, /data-hc-person="Bo"/);
  assert.match(plain, /data-hc-name="Bo" data-link="0"/);
  assert.equal(T.personCardHTML({ person: P('') }), '');
});

test('M1: content/about.md is only the people mount, and no "Who can edit"', () => {
  const md = fs.readFileSync(path.join(ROOT, 'content', 'about.md'), 'utf8');
  assert.equal(md.trim(), '<div id="people-root"></div>');
  assert.ok(!/Who can edit/.test(md));
});

// ==== UNIT E ====
