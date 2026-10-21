// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 21 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test the projects list and project page helpers (groups, status filter, key facts, start-here links) and the facts files' group/image keys.
/* Unit tests for the pure helpers js/app.js exports on window.HCProjects (uiux plan,
   unit J: J12 groups and the status filter, J11 key facts and start-here links),
   plus the data rule behind them: every data/projects/<id>.json names a known
   group, and an optional image is a Cloudinary manifest URL.

     node --test tools/tests/test_projects_ui.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootSite } from './view_harness.mjs';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const GROUP_IDS = ['vehicles', 'software', 'research', 'lab', 'teaching', 'fun'];

// The helpers run in the harness's vm realm: their arrays are not this realm's
// Array, so every result is compared as plain JSON data.
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
let helpers = null;
async function HCP() {
  if (!helpers) {
    const site = await bootSite({ hash: '#/' });
    const h = site.win.HCProjects;
    helpers = Object.fromEntries(Object.keys(h).map((k) => [k, (...a) => plain(h[k](...a))]));
  }
  return helpers;
}

const P = (id, group, status) => ({ id, name: id, group, status: status || 'active', repos: [] });

// ------------------------------------------------------------- groupProjects
test('J12 groupProjects: the fixed group order, unknown or missing group goes to "Other" last', async () => {
  const { groupProjects } = await HCP();
  const list = [P('a', 'fun'), P('b', 'software'), P('c', 'nonsense'), P('d', 'vehicles'),
    P('e'), P('f', 'research'), P('g', 'teaching'), P('h', 'lab'), P('i', 'software')];
  const groups = groupProjects(list, null);
  assert.deepEqual(groups.map((g) => g.id), ['vehicles', 'software', 'research', 'lab', 'teaching', 'fun', 'other']);
  assert.deepEqual(groups.map((g) => g.title),
    ['Vehicles', 'Software', 'Research', 'Lab infrastructure', 'Teaching', 'Fun', 'Other']);
  assert.deepEqual(groups[1].projects.map((p) => p.id), ['b', 'i'], 'registry order kept inside a group');
  assert.deepEqual(groups[6].projects.map((p) => p.id), ['c', 'e']);
});

test('J12 groupProjects: a status filter keeps only that status and drops empty groups', async () => {
  const { groupProjects } = await HCP();
  const list = [P('a', 'fun', 'legacy'), P('b', 'software', 'active'), P('c', 'software', 'legacy')];
  const groups = groupProjects(list, 'legacy');
  assert.deepEqual(groups.map((g) => g.id), ['software', 'fun']);
  assert.deepEqual(groups[0].projects.map((p) => p.id), ['c']);
  assert.deepEqual(groupProjects(list, 'maintained'), []);
  assert.deepEqual(groupProjects(null, null), []);
});

// -------------------------------------------------------------- statusFilter
test('J12 statusFilter reads ?status= from the hash and accepts the four fixed statuses (archive included)', async () => {
  const { statusFilter } = await HCP();
  assert.equal(statusFilter('#/projects'), null);
  assert.equal(statusFilter('#/projects?status=active'), 'active');
  assert.equal(statusFilter('#/projects?status=maintained'), 'maintained');
  assert.equal(statusFilter('#/projects?editor=changes&status=legacy'), 'legacy');
  assert.equal(statusFilter('#/projects?status=legacy@anchor'), 'legacy');
  assert.equal(statusFilter('#/projects?status=bogus'), null);
  assert.equal(statusFilter('#/projects?status=archive'), 'archive', 'J12: archive has a chip too');
  assert.equal(statusFilter(''), null);
  assert.equal(statusFilter(undefined), null);
});

test('J12 statusList: every status in the data, fixed order then alphabetical, with counts', async () => {
  const { statusList, statusFilter } = await HCP();
  const list = [P('a', 'fun', 'archive'), P('b', 'fun', 'zeta'), P('c', 'fun', 'active'), P('d', 'fun', 'beta'),
    P('e', 'fun', 'legacy'), P('f', 'fun', 'active'), P('g', 'fun', 'maintained')];
  assert.deepEqual(statusList(list), [
    { status: 'active', count: 2 }, { status: 'maintained', count: 1 }, { status: 'legacy', count: 1 },
    { status: 'archive', count: 1 }, { status: 'beta', count: 1 }, { status: 'zeta', count: 1 }]);
  assert.deepEqual(statusList([P('x', 'fun', 'legacy')]), [{ status: 'legacy', count: 1 }], 'absent statuses get no chip');
  assert.deepEqual(statusList(null), []);
  assert.equal(statusFilter('#/projects?status=zeta', ['active', 'zeta']), 'zeta', 'a data status is accepted when listed');
  assert.equal(statusFilter('#/projects?status=zeta'), null, 'not in the fixed four and not listed');
});

test('J12 the real registry: the chips cover all 17 projects (archive included)', async () => {
  const { statusList } = await HCP();
  const dir = path.join(ROOT, 'data', 'projects');
  const projects = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  const chips = statusList(projects);
  assert.equal(chips.reduce((n, c) => n + c.count, 0), projects.length);
  assert.deepEqual(chips.map((c) => c.status).slice(0, 4), ['active', 'maintained', 'legacy', 'archive']);
});

// ------------------------------------------------------------------ keyFacts
test('J11 keyFacts: people counts the truncated rest, repositories from the facts file', async () => {
  const { keyFacts } = await HCP();
  const p = { status: 'active', repos: [{ name: 'a' }, { name: 'b' }, { name: 'ext', external: true }] };
  const entry = { contributors: [{ login: 'x' }, { login: 'y' }], truncated: 3 };
  const f = keyFacts(p, entry, null);
  assert.equal(f.status, 'active');
  assert.equal(f.people, 5);
  assert.equal(f.repos, 3);
  assert.equal(f.lastActivity, null, 'no repos doc, no date');
  assert.equal(keyFacts(p, { contributors: [{ login: 'x' }] }, null).people, 1);
  assert.equal(keyFacts(p, { contributors: [{ login: 'x' }], truncated: 'nope' }, null).people, 1);
  assert.equal(keyFacts(p, null, null).people, null, 'unknown, not zero, without the contributors file');
});

test('J11 keyFacts: lastActivity is the newest pushed_at among the project\'s repositories', async () => {
  const { keyFacts } = await HCP();
  const p = { status: 'maintained', repos: [{ name: 'a' }, { name: 'b' }, { name: 'gone' }] };
  const doc = { repos: {
    a: { name: 'a', pushed_at: '2024-08-06' },
    b: { name: 'b', pushed_at: '2025-01-30' },
    other: { name: 'other', pushed_at: '2026-10-01' },
  } };
  assert.equal(keyFacts(p, null, doc).lastActivity, '2025-01-30');
  assert.equal(keyFacts({ status: 'active', repos: [] }, null, doc).lastActivity, null);
  assert.equal(keyFacts({ status: 'active' }, null, doc).repos, 0, 'a facts file without repos reads as 0');
  assert.equal(keyFacts(p, null, { repos: 'nope' }).lastActivity, null);
});

// ----------------------------------------------------------------- startHere
test('J11 startHere: at most three setup links become cards; the rest stay in See also', async () => {
  const { startHere } = await HCP();
  const links = [
    { href: '#/setup/a', label: 'A' }, { href: 'https://x.org', label: 'X' },
    { href: '#/setup/b', label: 'B' }, { href: '#/setup/c', label: 'C' },
    { href: '#/setup/d', label: 'D' }, { href: '#/projects/p', label: 'P' },
  ];
  const r = startHere(links);
  assert.deepEqual(r.start.map((l) => l.label), ['A', 'B', 'C']);
  assert.deepEqual(r.rest.map((l) => l.label), ['X', 'D', 'P']);
  assert.deepEqual(startHere(undefined), { start: [], rest: [] });
  assert.deepEqual(startHere([{ href: '#/projects/x', label: 'x' }]).start, []);
});

// ----------------------------------------------------------- the facts files
test('J12 every facts file names a known group; an image is a Cloudinary manifest URL', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'cloudinary-manifest.json'), 'utf8'));
  const urls = new Set(JSON.stringify(manifest).match(/https:\/\/res\.cloudinary\.com\/[^"]+/g));
  const dir = path.join(ROOT, 'data', 'projects');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 17);
  let images = 0;
  for (const f of files) {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.ok(GROUP_IDS.includes(doc.group), `${f}: group ${doc.group}`);
    if ('image' in doc) {
      images += 1;
      assert.ok(urls.has(doc.image), `${f}: image is a manifest URL`);
    }
  }
  assert.ok(images >= 5, 'the five projects with a picture carry it');
});
