// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 23 September 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test the home hero's pure helpers — example queries, hit paths, status line, home route.
/* Unit tests for the home-hero helpers inside js/search.js. The homepage is direction A:
   the search field IS the front door, so the hero renders real HCSearch rows and the header
   search box collapses on the home route. Everything testable about that is pure and lives
   here: no DOM, no dependencies, and loading js/search.js under plain node is itself the
   smoke test that its browser wiring stays guarded.

   The shipped example queries are also probed against the REAL index on disk (search/), so a
   chip that has stopped returning hits fails here instead of on the front page.

     node --test tools/tests/test_home_hero.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const HC = require(path.join(ROOT, 'js', 'search.js'));

const {
  exampleQueries, hitPath, heroHits, heroStatus, isHomeHash,
  buildItems, searchItems,
} = HC;

// ------------------------------------------------------------ exampleQueries

test('exampleQueries returns label/q pairs in registry order', () => {
  const site = {
    example_queries: [
      { label: 'the gantry', q: 'gantry' },
      { label: 'event camera', q: 'event camera' },
    ],
  };
  assert.deepEqual(exampleQueries(site), [
    { label: 'the gantry', q: 'gantry' },
    { label: 'event camera', q: 'event camera' },
  ]);
});

test('exampleQueries trims, falls back to q for a missing label, and drops junk', () => {
  const site = {
    example_queries: [
      { label: '  spaced  ', q: '  uart  ' },
      { q: 'mixer' },                  // no label: the query is its own label
      { label: 'no query' },           // unusable
      { label: '', q: '' },            // unusable
      'gantry',                        // a bare string is not a chip
      null,
    ],
  };
  assert.deepEqual(exampleQueries(site), [
    { label: 'spaced', q: 'uart' },
    { label: 'mixer', q: 'mixer' },
  ]);
});

test('exampleQueries survives a missing or wrong-typed list', () => {
  // A string in a list's place iterates as characters; the helper must not.
  assert.deepEqual(exampleQueries({ example_queries: 'gantry' }), []);
  assert.deepEqual(exampleQueries({}), []);
  assert.deepEqual(exampleQueries(null), []);
  assert.deepEqual(exampleQueries(undefined), []);
});

// -------------------------------------------------------------------- hitPath

test('hitPath shows a site hit as its own hash route', () => {
  assert.equal(
    hitPath({ href: '#/setup/raspberry-pi/uart-configuration', where: 'Setup · Raspberry Pi setup',
      snippet: 'By default UART0 is used as a login terminal.' }),
    '#/setup/raspberry-pi/uart-configuration',
  );
});

test('hitPath shows a code hit as repo/path:line, not its GitHub URL', () => {
  assert.equal(
    hitPath({
      href: 'https://github.com/HippoCampusRobotics/hippo_control/blob/main/src/mixer/actuator_mixer_node.hpp#L28',
      where: 'hippo_control',
      snippet: 'src/mixer/actuator_mixer_node.hpp:L28',
    }),
    'hippo_control/src/mixer/actuator_mixer_node.hpp:L28',
  );
});

test('hitPath does not repeat a where that already leads the snippet', () => {
  assert.equal(
    hitPath({ href: 'https://github.com/HippoCampusRobotics/SiK/blob/hippolink-multi/Dockerfile',
      where: 'SiK', snippet: 'SiK/Dockerfile' }),
    'SiK/Dockerfile',
  );
  assert.equal(
    hitPath({ href: 'https://example.org/x', where: 'solo.txt', snippet: 'solo.txt' }),
    'solo.txt',
  );
});

test('hitPath leaves a prose where out of the path', () => {
  // A CAD row's `where` is a human label ("CAD (.ipt)"), never a path segment.
  assert.equal(
    hitPath({ href: 'https://github.com/FinnBreu/hippocampus-cad/blob/main/motor/propeller_52mm.ipt',
      where: 'CAD (.ipt)', snippet: 'motor/propeller_52mm.ipt' }),
    'motor/propeller_52mm.ipt',
  );
});

test('hitPath falls back to the href when the snippet is prose or missing', () => {
  assert.equal(
    hitPath({ href: 'https://github.com/HippoCampusRobotics/hippo_control',
      where: 'hippo_control', snippet: 'Controllers for the HippoCampus vehicles' }),
    'https://github.com/HippoCampusRobotics/hippo_control',
  );
  assert.equal(hitPath({ href: 'https://example.org/y', where: 'x' }), 'https://example.org/y');
  assert.equal(hitPath({}), '');
  assert.equal(hitPath(null), '');
});

// ------------------------------------------------------------------- heroHits

test('heroHits takes the leading rows in the order the search produced them', () => {
  const res = {
    results: [
      { href: '#/a' }, { href: '#/b' }, { href: '#/c' }, { href: '#/d' },
    ],
  };
  assert.deepEqual(heroHits(res, 2), [{ href: '#/a' }, { href: '#/b' }]);
  assert.equal(heroHits(res, 10).length, 4);
});

test('heroHits drops rows with no destination and survives a bad shape', () => {
  assert.deepEqual(heroHits({ results: [null, { href: '' }, { href: '#/ok' }] }, 6), [{ href: '#/ok' }]);
  assert.deepEqual(heroHits({ results: 'nope' }, 6), []);
  assert.deepEqual(heroHits({}, 6), []);
  assert.deepEqual(heroHits(null, 6), []);
  assert.deepEqual(heroHits({ results: [{ href: '#/a' }] }, 0), []);
  assert.deepEqual(heroHits({ results: [{ href: '#/a' }] }, -3), []);
});

// ----------------------------------------------------------------- heroStatus

test('heroStatus counts what is shown against the whole index', () => {
  const res = { results: new Array(40).fill({ href: '#/x' }), total: 5638 };
  assert.equal(heroStatus(res, 6, false), '6 of 5,638 indexed entries');
  assert.equal(heroStatus({ results: [{ href: '#/x' }], total: 1 }, 1, false),
    '1 of 1 indexed entries');
});

test('heroStatus says the librarian is still working instead of "no results"', () => {
  assert.equal(heroStatus({ results: [], total: 5638 }, 0, true),
    'no keyword match — asking the librarian…');
  assert.equal(heroStatus({ results: [], total: 5638 }, 0, false), 'no keyword match');
});

test('heroStatus survives a missing total', () => {
  assert.equal(heroStatus({ results: [{ href: '#/x' }] }, 1, false), '1 of 0 indexed entries');
  assert.equal(heroStatus(null, 0, false), 'no keyword match');
});

// ----------------------------------------------------------------- isHomeHash

test('isHomeHash is true for every spelling of the home route', () => {
  assert.equal(isHomeHash('#/'), true);
  assert.equal(isHomeHash('#'), true);
  assert.equal(isHomeHash(''), true);
  assert.equal(isHomeHash(null), true);
  assert.equal(isHomeHash(undefined), true);
  assert.equal(isHomeHash('#//'), true);
});

test('isHomeHash is false for every other route', () => {
  assert.equal(isHomeHash('#/setup'), false);
  assert.equal(isHomeHash('#/setup/raspberry-pi/uart-configuration'), false);
  assert.equal(isHomeHash('#/projects/underwater-localization'), false);
  assert.equal(isHomeHash('#/search?q=gantry'), false);
  assert.equal(isHomeHash('#/about@people'), false);
});

test('isHomeHash splits a hash exactly the way the router does', () => {
  // route(): hash.slice(1).split('@')[0], then .split('?')[0], then /-segments.
  assert.equal(isHomeHash('#/?q=ignored'), true);
  assert.equal(isHomeHash('#/@top'), true);
  assert.equal(isHomeHash('#/search?q=a@b'), false);
});

// ------------------------------------- the shipped chips against the real index

test('every shipped example query returns local hits from the real index', () => {
  const site = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'site.json'), 'utf8'));
  const chips = exampleQueries(site);
  assert.ok(chips.length >= 5, `expected a real chip row, got ${chips.length}`);

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'search', 'manifest.json'), 'utf8'));
  const shards = manifest.shards.map(
    (s) => JSON.parse(fs.readFileSync(path.join(ROOT, s.file), 'utf8')),
  );
  const items = buildItems(shards);

  for (const chip of chips) {
    const res = searchItems(items, chip.q);
    assert.ok(res.results.length > 0,
      `chip ${JSON.stringify(chip.label)} searches ${JSON.stringify(chip.q)} and the local ` +
      'index returns nothing — replace the query, do not ship a dead chip');
    // Whatever the leader is, the hero must be able to render a path for it.
    assert.notEqual(hitPath(res.results[0]), '');
  }
});
