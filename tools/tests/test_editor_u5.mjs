// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 26 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test the U5 Team page work on the editor's parent side: in-place edits, the own-card rule, add in place.
/* Made by U0 (editor UI/UX build) so unit U5 adds its tests here, not to a shared test file. U5 (plan D15, D16):
   the pure text edits of data/people.json and data/github-links.json (js/cms-core.js), the own-card draft rule,
   go-live never applying a people change, a rename keeping the GitHub link, and the parent's people ops.

     node --test tools/tests/test_editor_u5.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { openSite, settle, memoryStorage } from './editor_harness.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const C = require(path.join(ROOT, 'js', 'cms-core.js'));
const readRepo = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PEOPLE = `${JSON.stringify({ groups: [
  { id: 'active', title: 'Team', people: [
    { name: 'Ann', title: 'Lead', photo: null, link: 'https://example.org/ann', pinned: true },
    { name: 'Ben', title: 'Student', photo: 'https://res.cloudinary.com/x/ben.jpg', link: null }] },
  { id: 'alumni', title: 'Alumni', people: [
    { name: 'Cid', title: 'Former', photo: null, link: null }] }] }, null, 2)}\n`;
const LINKS = `${JSON.stringify({ note: 'n', links: { EugenSol: 'Eugen Solowjow', timzarhansen: 'Tim Hansen' },
  exclude: ['hippocampusmum'] }, null, 1)}\n`;
const names = (text) => JSON.parse(text).groups.map((g) => g.people.map((p) => p.name));
const person = (text, n) => [].concat(...JSON.parse(text).groups.map((g) => g.people)).find((p) => p.name === n);

// ---------------------------------------------------------------- the pure text edits (cms-core) --

test('peopleFieldText: name, title and photo in place; every other field kept; the file keeps its format', () => {
  const r = C.peopleFieldText(PEOPLE, 'Ben', 'name', '  Ben   Bauer ');
  assert.equal(r.problem, null);
  assert.deepEqual(person(r.text, 'Ben Bauer'), { name: 'Ben Bauer', title: 'Student', photo: 'https://res.cloudinary.com/x/ben.jpg', link: null });
  assert.ok(r.text.endsWith('}\n') && /\n {2}"groups"/.test(r.text), 'two-space indent and the final newline');
  assert.equal(person(C.peopleFieldText(PEOPLE, 'Ann', 'title', 'Head\nof lab').text, 'Ann').title, 'Head of lab', 'one line');
  assert.equal(person(C.peopleFieldText(PEOPLE, 'Ann', 'title', 'Head').text, 'Ann').pinned, true, 'the pin stays');
  assert.equal(person(C.peopleFieldText(PEOPLE, 'Cid', 'photo', 'https://res.cloudinary.com/x/c.jpg').text, 'Cid').photo,
    'https://res.cloudinary.com/x/c.jpg');
  assert.equal(person(C.peopleFieldText(PEOPLE, 'Ben', 'photo', '').text, 'Ben').photo, null);
});

test('peopleFieldText: refused — an empty or taken name, a gone person, a non-https photo, another field', () => {
  assert.match(C.peopleFieldText(PEOPLE, 'Ann', 'name', '  ').problem, /cannot be empty/);
  assert.match(C.peopleFieldText(PEOPLE, 'Ann', 'name', 'Cid').problem, /already on the Team page/);
  assert.equal(C.peopleFieldText(PEOPLE, 'Ann', 'name', 'Ann').problem, null, 'the same name is no change');
  assert.match(C.peopleFieldText(PEOPLE, 'Zed', 'title', 'x').problem, /not on the Team page/);
  assert.match(C.peopleFieldText(PEOPLE, 'Ann', 'photo', 'http://x.org/a.jpg').problem, /https/);
  assert.match(C.peopleFieldText(PEOPLE, 'Ann', 'link', 'https://x').problem, /cannot be changed here/);
  assert.match(C.peopleFieldText(PEOPLE, 'Ann', 'name', 'x'.repeat(121)).problem, /at most 120/);
  assert.match(C.peopleFieldText('{', 'Ann', 'name', 'A').problem, /data\/people\.json/);
});

test('peopleRemoveText: one person off their list (group and index said); a gone person refused', () => {
  const r = C.peopleRemoveText(PEOPLE, 'Ben');
  assert.equal(r.problem, null);
  assert.deepEqual(names(r.text), [['Ann'], ['Cid']]);
  assert.deepEqual([r.group, r.index], ['active', 1]);
  assert.match(C.peopleRemoveText(PEOPLE, 'Zed').problem, /not on the Team page/);
});

test('addPersonText (in place): the typed fields, appended to the list; the link is what was typed', () => {
  const r = C.addPersonText(PEOPLE, { group: 'alumni', name: 'Dot', title: 'Guest', photo: '', link: 'https://dot.example.org' });
  assert.equal(r.problem, null);
  assert.deepEqual(person(r.text, 'Dot'), { name: 'Dot', title: 'Guest', photo: null, link: 'https://dot.example.org' });
  assert.deepEqual(names(r.text), [['Ann', 'Ben'], ['Cid', 'Dot']]);
});

test('githubLinksText: set (a new line sorted in; a case-twin reuses its line), unset (null), take out (undefined)', () => {
  const add = C.githubLinksText(LINKS, 'kyle-nelson-berkeley', 'Kyle N.');
  assert.equal(add.problem, null);
  assert.deepEqual(Object.keys(JSON.parse(add.text).links), ['EugenSol', 'kyle-nelson-berkeley', 'timzarhansen']);
  assert.ok(/\n "links"/.test(add.text) && add.text.endsWith('\n'), 'the file\'s one-space indent kept');
  const twin = JSON.parse(C.githubLinksText(LINKS, 'eugensol', 'Eugen S.').text).links;
  assert.deepEqual(twin, { EugenSol: 'Eugen S.', timzarhansen: 'Tim Hansen' });
  assert.equal(JSON.parse(C.githubLinksText(LINKS, 'EugenSol', null).text).links.EugenSol, null);
  assert.deepEqual(Object.keys(JSON.parse(C.githubLinksText(LINKS, 'EugenSol', undefined).text).links), ['timzarhansen']);
  assert.equal(JSON.parse(C.githubLinksText(LINKS, '@Some-One', 'Some One').text).links['Some-One'], 'Some One', 'a leading @ is dropped');
});

test('githubLinksText: refused — not a login, a service account, a name another login holds, bad JSON', () => {
  assert.match(C.githubLinksText(LINKS, 'not a login', 'X').problem, /not a GitHub account name/);
  assert.match(C.githubLinksText(LINKS, '-dash', 'X').problem, /not a GitHub account name/);
  assert.match(C.githubLinksText(LINKS, 'HippocampusMum', 'X').problem, /service account/);
  assert.match(C.githubLinksText(LINKS, 'someone', 'Tim Hansen').problem, /already linked to the GitHub account timzarhansen/);
  assert.match(C.githubLinksText('{"links": [}', 'someone', 'X').problem, /data\/github-links\.json/);
  assert.match(C.githubLinksText(LINKS, 'someone', 7).problem, /names a person/);
});

// ------------------------------------------------------------- D15: the own-card rule (peopleDraftProblem) --

const draft = (people, links) => ({ files: { 'data/people.json': people, ...(links ? { 'data/github-links.json': links } : {}) },
  originals: { 'data/people.json': PEOPLE, ...(links ? { 'data/github-links.json': LINKS } : {}) } });
const ME = { admin: false, login: 'ben-b', own: 'Ben' };

test('peopleDraftProblem: an admin may send any change; nothing changed is never a problem', () => {
  const r = C.peopleRemoveText(PEOPLE, 'Ann').text;
  assert.equal(C.peopleDraftProblem({ admin: true, login: 'x', own: null }, draft(r)), null);
  assert.equal(C.peopleDraftProblem({ admin: false, login: 'x', own: null }, draft(PEOPLE)), null);
});

test('peopleDraftProblem: a member may change their own name and photo, and their own login\'s links line to the new name', () => {
  const renamed = C.peopleFieldText(PEOPLE, 'Ben', 'name', 'Benjamin').text;
  const photo = C.peopleFieldText(renamed, 'Benjamin', 'photo', 'https://res.cloudinary.com/x/new.jpg').text;
  assert.equal(C.peopleDraftProblem(ME, draft(photo)), null);
  const links = C.githubLinksText(LINKS, 'Ben-B', 'Benjamin').text;
  assert.equal(C.peopleDraftProblem(ME, draft(photo, links)), null, 'the login compared without case');
});

test('peopleDraftProblem: everything else from a member is refused (title, another card, order, pin, remove, add, links, files)', () => {
  const no = (d, why) => assert.equal(C.peopleDraftProblem(ME, d), C.PEOPLE_ADMIN_TEXT, why);
  no(draft(C.peopleFieldText(PEOPLE, 'Ben', 'title', 'Doctor').text), 'their own title');
  no(draft(C.peopleFieldText(PEOPLE, 'Ann', 'name', 'Anna').text), 'another person\'s name');
  no(draft(C.peopleFieldText(PEOPLE, 'Cid', 'photo', 'https://res.cloudinary.com/x/c.jpg').text), 'another person\'s photo');
  no(draft(C.peopleOrderText(PEOPLE, [{ name: 'Ben' }, { name: 'Ann', pinned: true }], [{ name: 'Cid' }]).text), 'an order');
  no(draft(C.peopleOrderText(PEOPLE, [{ name: 'Ann' }, { name: 'Ben' }], [{ name: 'Cid' }]).text), 'a pin taken off');
  no(draft(C.peopleRemoveText(PEOPLE, 'Cid').text), 'a removal');
  no(draft(C.addPersonText(PEOPLE, { group: 'active', name: 'Eve' }).text), 'an addition');
  no(draft(PEOPLE, C.githubLinksText(LINKS, 'ben-b', 'Ann').text), 'their links line naming another card');
  no(draft(PEOPLE, C.githubLinksText(LINKS, 'EugenSol', null).text), 'another login\'s links line');
  no(Object.assign(draft(PEOPLE), { files: { 'data/people.json': PEOPLE, 'data/site.json': '{}' }, originals: { 'data/people.json': PEOPLE, 'data/site.json': '{"a":1}' } }), 'another file');
  assert.equal(C.peopleDraftProblem({ admin: false, login: 'ben-b', own: null },
    draft(C.peopleFieldText(PEOPLE, 'Ben', 'name', 'B').text)), C.PEOPLE_ADMIN_ONLY_TEXT, 'no own card: nothing, and no "your own" sentence');
  assert.equal(C.peopleDraftProblem({ admin: false, login: 'ben-b', own: 'Nobody' },
    draft(C.peopleFieldText(PEOPLE, 'Ben', 'name', 'B').text)), C.PEOPLE_ADMIN_TEXT, 'an own name not on the page');
  assert.equal(C.peopleDraftProblem(ME, draft('{')), C.PEOPLE_ADMIN_TEXT, 'unreadable');
});

/* tools/github_names.py's map rule (the part a rename relies on), mirrored: a login in `links` resolves to its value
   when that value is a roster name and no other map line gives the same name (two would link neither); a login
   mapped to null or to a name not on the roster is unlinked; the map wins over the automatic name match. */
function mapResolves(links, roster, login) {
  const set = new Set(roster);
  if (!Object.prototype.hasOwnProperty.call(links, login)) return undefined;     // the automatic match decides
  const v = links[login];
  if (typeof v !== 'string' || !set.has(v)) return null;
  return Object.keys(links).filter((k) => links[k] === v).length > 1 ? null : v;
}

test('a member\'s approved rename keeps their GitHub link: the login still resolves to the card (tools/github_names.py\'s map rule)', () => {
  // the real files: kyle-nelson-berkeley is matched to "Kyle Nelson" automatically (people-public.json's roster)
  const people = readRepo('data/people.json');
  const links = readRepo('data/github-links.json');
  const pub = JSON.parse(readRepo('data/graph/people-public.json'));
  assert.equal(pub.people['kyle-nelson-berkeley'].roster, 'Kyle Nelson');
  const rosterAfter = (text) => [].concat(...JSON.parse(text).groups.map((g) => g.people.map((p) => p.name)));
  // before the edit the map has no line: renaming alone would leave the automatic match nothing to match
  assert.equal(mapResolves(JSON.parse(links).links, rosterAfter(people), 'kyle-nelson-berkeley'), undefined);
  const p2 = C.peopleFieldText(people, 'Kyle Nelson', 'name', 'Kyle B. Nelson').text;
  const l2 = C.githubLinksText(links, 'kyle-nelson-berkeley', 'Kyle B. Nelson').text;
  const d = { files: { 'data/people.json': p2, 'data/github-links.json': l2 }, originals: { 'data/people.json': people, 'data/github-links.json': links } };
  assert.equal(C.peopleDraftProblem({ admin: false, login: 'kyle-nelson-berkeley', own: 'Kyle Nelson' }, d), null);
  assert.equal(mapResolves(JSON.parse(l2).links, rosterAfter(p2), 'kyle-nelson-berkeley'), 'Kyle B. Nelson');
  // every other mapped login resolves as before
  for (const [login, v] of Object.entries(JSON.parse(links).links)) {
    assert.equal(mapResolves(JSON.parse(l2).links, rosterAfter(p2), login), mapResolves(JSON.parse(links).links, rosterAfter(people), login), login);
    assert.ok(v === null || typeof v === 'string');
  }
  // the gate's shape rule for the file: exactly note/links/exclude, no login both linked and excluded
  const doc = JSON.parse(l2);
  assert.deepEqual(Object.keys(doc).sort(), ['exclude', 'links', 'note']);
  assert.deepEqual(doc.exclude.filter((x) => Object.prototype.hasOwnProperty.call(doc.links, x)), []);
});

// ------------------------------------------------------------- go-live never applies a people change --

test('go-live: a people change is never applied per edit, whatever the approver\'s role (refused by the content/*.md filter before any record or role is read)', async () => {
  const ENGINE = await import(path.join(ROOT, 'tools', 'go_live.mjs'));
  const REPO = 'desert-mango/hippocampus-docs';
  const RA = `/repos/${REPO}`;
  const HEAD = '1'.repeat(40);
  const BASE = '0'.repeat(40);
  const head = C.peopleFieldText(PEOPLE, 'Ben', 'name', 'Benjamin').text;
  const key = crypto.createHash('sha256').update(`data/people.json\0${PEOPLE}\0${head}`, 'utf8').digest('hex');
  const access = { note: 't', projects: { x: { repos: 1, removed: [], editors: [{ login: 'kyle-nelson-berkeley', why: 'commits', repos_with_commits: 1 }] } } };
  const files = { [ENGINE.ACCESS_FILE]: JSON.stringify(access), 'data/people.json': PEOPLE };
  const posted = [];
  const asked = [];
  const pull = { number: 5, draft: false, state: 'open', user: { login: 'ben-b', id: 9 },
    head: { ref: 'cms/ben-b/edit-team-261023', sha: HEAD, repo: { full_name: REPO } } };
  const record = { id: 1, user: { login: 'kyle-nelson-berkeley' }, body: `hc-approved ${key}`,
    created_at: '2026-10-23T00:00:00Z', updated_at: '2026-10-23T00:00:00Z' };
  const api = {
    async get(p) {
      const u = new URL(`https://x${p}`);
      const q = u.pathname.slice(RA.length);
      asked.push(q);
      const one = (data) => ({ status: 200, data: Number(u.searchParams.get('page') || 1) === 1 ? data : [] });
      if (q === '/pulls') return one([pull]);
      if (/\/files$/.test(q)) return one([{ filename: 'data/people.json', status: 'modified' }]);
      if (/\/commits$/.test(q)) return one([{ author: { login: 'ben-b' }, committer: { login: 'web-flow' } }]);
      if (/\/comments$/.test(q)) return one([record]);
      if (/\/permission$/.test(q)) return { status: 200, data: { permission: 'write', role_name: 'write' } };
      if (/^\/compare\//.test(q)) return { status: 200, data: { merge_base_commit: { sha: BASE } } };
      throw new Error(`unexpected GET ${p}`);
    },
    async getRaw(p) {
      const u = new URL(`https://x${p}`);
      const t = { [BASE]: { 'data/people.json': PEOPLE }, [HEAD]: { 'data/people.json': head } }[u.searchParams.get('ref')] || {};
      const f = decodeURIComponent(u.pathname.slice(`${RA}/contents/`.length));
      return f in t ? { status: 200, text: t[f] } : { status: 404, text: '' };
    },
    async post(p, body) { posted.push({ p, body }); return { status: 201, data: {} }; },
    async patch() { return { status: 200, data: {} }; },
  };
  const out = await ENGINE.sweep({ api, repo: REPO, fs: { read: async (f) => (f in files ? files[f] : null), write: async (f, t) => { files[f] = t; } },
    gate: async () => ({ ok: true, finding: '' }) });
  assert.deepEqual(out.groups, [], 'no group: go-live applies content/*.md page edits only');
  assert.equal(files['data/people.json'], PEOPLE, 'main\'s roster is unchanged');
  assert.deepEqual(posted, []);
  assert.deepEqual(asked.filter((q) => /\/(comments|permission)$/.test(q)), [], 'no record and no role was read');
});

// ------------------------------------------------------------- the parent's people ops (js/editor.js) --
/* The Team page in the editor harness: the role from the fake GitHub (variant), people-public.json through
   HC.fetchJSON (opts.hc), the frame's hc-people messages through page.send, my drafts in localStorage. */
const PUB = { generated: 't', read_at: '2026-10-20T00:00:00Z', org: 'o', note: 'n', people: {
  'Ben-B': { login: 'Ben-B', name: 'Ben B', avatar: null, html_url: 'https://github.com/Ben-B', roster: 'Ben', last_active: null },
  carl: { login: 'carl', name: 'Ann', avatar: null, html_url: 'https://github.com/carl', roster: 'Ann', last_active: null },
  'Dee-D': { login: 'Dee-D', name: 'Dee D', avatar: null, html_url: 'https://github.com/Dee-D', roster: null, last_active: null } } };
async function team(variant, login, before) {
  const storage = memoryStorage();
  const local = memoryStorage();
  if (before) before(C.createDraftStore(local, C.draftsKey(login || 'bob')));
  const page = openSite({ hash: '#/team', variant, storage, localStorage: local,
    files: { 'data/people.json': PEOPLE, 'data/github-links.json': LINKS }, hc: { 'data/graph/people-public.json': PUB },
    session: C.makeSession('<yours>-u5', null, login || 'bob', Date.now()) });
  await settle();
  page.switchBtn().click();
  await settle();
  await page.send({ type: 'hc-ready' });
  return page;
}
const lastPeople = (page) => page.editorMessages().at(-1).people;
// what the frame posts, then the reloaded page's hc-ready (the parent draws the page again after every op)
async function op(page, m) { await page.send(Object.assign({ type: 'hc-people' }, m)); await page.send({ type: 'hc-ready' }); }
const teamDraft = (page) => C.createDraftStore(page.local, C.draftsKey(page.login)).get('data/people');
const noticeText = (page) => { const n = page.one((e) => e.classList.contains('hc-notice')); return n ? n.textContent : ''; };

test('D15: an admin gets every card\'s tools; a member only their own card (own); someone without a card nothing', async () => {
  const admin = await team('admin', 'nat');
  assert.deepEqual([lastPeople(admin).edit, lastPeople(admin).own], [true, null]);
  const member = await team(undefined, 'ben-b');
  assert.deepEqual([lastPeople(member).edit, lastPeople(member).own], [false, 'Ben'], 'the login compared without case');
  const other = await team(undefined, 'zed');
  assert.deepEqual([other.editorMessages().at(-1).people.edit, lastPeople(other).own], [false, null]);
  const maint = await team('maintain', 'zed');
  assert.equal(lastPeople(maint).edit, false, 'a Maintainer is not an admin: the Team page reads as normal');
});

test('D15: a member renames their own card — the draft carries the links line too; any other people edit is refused', async () => {
  const page = await team(undefined, 'ben-b');
  await op(page, { op: 'field', name: 'Ann', field: 'name', value: 'Anna' });
  assert.equal(teamDraft(page), null, 'another card: nothing written');
  assert.match(noticeText(page), /Only an admin can change the Team page/);
  await op(page, { op: 'field', name: 'Ben', field: 'title', value: 'Doctor' });
  assert.equal(teamDraft(page), null, 'their own title: nothing written');
  await op(page, { op: 'remove', name: 'Ben' });
  await op(page, { op: 'order', team: [{ name: 'Ben' }, { name: 'Ann', pinned: true }], alumni: [{ name: 'Cid' }] });
  assert.equal(teamDraft(page), null, 'a removal or an order: nothing written');
  await op(page, { op: 'field', name: 'Ben', field: 'name', value: 'Benjamin' });
  const d = teamDraft(page);
  assert.deepEqual(names(d.files['data/people.json']), [['Ann', 'Benjamin'], ['Cid']]);
  assert.equal(JSON.parse(d.files['data/github-links.json']).links['ben-b'], 'Benjamin', 'their login keeps them linked');
  assert.equal(C.peopleDraftProblem({ admin: false, login: 'ben-b', own: 'Ben' }, d), null);
  assert.equal(lastPeople(page).own, 'Benjamin', 'the card is still theirs under its new name');
  await op(page, { op: 'field', name: 'Benjamin', field: 'name', value: 'Ben' });
  assert.equal(JSON.parse(teamDraft(page).files['data/github-links.json']).links['ben-b'], 'Ben');
});

test('D16: an admin renames a linked person (their login\'s line follows), edits a title, adds in place with a GitHub account', async () => {
  const page = await team('admin', 'nat');
  await op(page, { op: 'field', name: 'Ann', field: 'name', value: 'Anna' });
  let d = teamDraft(page);
  assert.equal(JSON.parse(d.files['data/github-links.json']).links.carl, 'Anna', 'carl was matched to Ann automatically');
  assert.equal(lastPeople(page).focus, 'Anna', 'the page comes back to the card');
  await op(page, { op: 'field', name: 'Cid', field: 'title', value: 'Former student' });
  d = teamDraft(page);
  assert.equal(person(d.files['data/people.json'], 'Cid').title, 'Former student');
  assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(d.files['data/github-links.json']).links, 'cid'), false, 'no login: no line');
  await op(page, { op: 'add-in-place', group: 'alumni', login: 'dot-d', name: 'Dot', title: 'Guest', link: 'https://dot.example.org', photo: false });
  d = teamDraft(page);
  assert.deepEqual(person(d.files['data/people.json'], 'Dot'), { name: 'Dot', title: 'Guest', photo: null, link: 'https://dot.example.org' });
  assert.equal(JSON.parse(d.files['data/github-links.json']).links['dot-d'], 'Dot');
  await op(page, { op: 'add-in-place', group: 'team', login: 'timzarhansen', name: 'Eve', title: '', link: '', photo: false });
  assert.equal(person(teamDraft(page).files['data/people.json'], 'Eve'), undefined, 'a login already linked to someone else: nothing added');
  assert.match(lastPeople(page).alert, /already linked|Tim Hansen|timzarhansen/i);
  await op(page, { op: 'add-in-place', group: 'team', login: '', name: '', title: '', link: '', photo: false });
  assert.match(lastPeople(page).alert, /needs a name/);
});

test('F1: an admin renames a person matched by a mixed-case login: the links line keeps GitHub\'s case, so the login still resolves', async () => {
  const page = await team('admin', 'nat');
  await op(page, { op: 'field', name: 'Ben', field: 'name', value: 'Benjamin' });
  const links = JSON.parse(teamDraft(page).files['data/github-links.json']).links;
  assert.equal(links['Ben-B'], 'Benjamin', 'the key is the login in its original case');
  assert.equal(Object.prototype.hasOwnProperty.call(links, 'ben-b'), false, 'no lower-cased twin');
  const roster = [].concat(...names(teamDraft(page).files['data/people.json']));
  assert.equal(mapResolves(links, roster, 'Ben-B'), 'Benjamin', 'tools/github_names.py looks the map up by the exact login');
  // a known login typed in another case into "Add a person" is written in its canonical case
  await op(page, { op: 'add-in-place', group: 'alumni', login: 'dee-d', name: 'Dee', title: '', link: '', photo: false });
  const l2 = JSON.parse(teamDraft(page).files['data/github-links.json']).links;
  assert.equal(l2['Dee-D'], 'Dee');
  assert.equal(Object.prototype.hasOwnProperty.call(l2, 'dee-d'), false);
});

test('D16: Remove shows "Removed · Undo"; Undo puts the person back (the undo stack); a refused order raises the alert', async () => {
  const page = await team('admin', 'nat');
  await op(page, { op: 'remove', name: 'Ben' });
  assert.deepEqual(names(teamDraft(page).files['data/people.json']), [['Ann'], ['Cid']]);
  assert.equal(lastPeople(page).focus, 'Ann', 'F8: focus goes to the card before (Ben was last in the list)');
  // the bubble said "Removed Ben · Undo" (the harness runs the 8-s timer at once, so the line is gone again)
  const undo = page.created.find((e) => e.attrs['data-action'] === 'people-undo');
  assert.equal(undo.textContent, 'Undo');
  undo.click();
  await settle();
  await page.send({ type: 'hc-ready' });
  assert.deepEqual(names(teamDraft(page) ? teamDraft(page).files['data/people.json'] : PEOPLE), [['Ann', 'Ben'], ['Cid']]);
  await op(page, { op: 'order', team: [{ name: 'Ann' }], alumni: [{ name: 'Cid' }], act: 'down' });
  assert.match(lastPeople(page).alert, /Ben/, 'nobody is dropped by an order: the alert names them');
  await op(page, { op: 'order', team: [{ name: 'Ben' }, { name: 'Ann', pinned: true }], alumni: [{ name: 'Cid' }], focus: 'Ben', act: 'up' });
  assert.deepEqual([lastPeople(page).alert, lastPeople(page).act, lastPeople(page).focus], [null, 'up', 'Ben']);
});

test('D15: the send is refused for a member\'s draft that changes more than their own name and photo', async () => {
  const bad = C.peopleFieldText(PEOPLE, 'Ann', 'title', 'x').text;
  const page = await team(undefined, 'ben-b', (store) => store.put({ key: 'data/people', label: 'Team', route: '/team',
    files: { 'data/people.json': bad }, originals: { 'data/people.json': PEOPLE }, base: { ref: 'main', sha: 'a'.repeat(40), number: null } }));
  assert.equal(lastPeople(page).own, null, 'no tools: the draft already breaks the rule');
  await op(page, { op: 'field', name: 'Ben', field: 'name', value: 'Benjamin' });
  assert.equal(names(teamDraft(page).files['data/people.json'])[0][1], 'Ben', 'the edit gate closes once the draft breaks the rule');
});

test('D15: undo of a rename takes its links line back; redo puts it on the new name again', async () => {
  const page = await team('admin', 'nat');
  await op(page, { op: 'field', name: 'Ann', field: 'name', value: 'Anna' });
  assert.equal(JSON.parse(teamDraft(page).files['data/github-links.json']).links.carl, 'Anna');
  await page.send({ type: 'hc-key', op: 'undo' });
  await page.send({ type: 'hc-ready' });
  const d = teamDraft(page);
  assert.deepEqual(names(d.files['data/people.json']), [['Ann', 'Ben'], ['Cid']]);
  assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(d.files['data/github-links.json']).links, 'carl'), false,
    'carl is matched to Ann automatically again');
  await page.send({ type: 'hc-key', op: 'redo' });
  await page.send({ type: 'hc-ready' });
  assert.equal(JSON.parse(teamDraft(page).files['data/github-links.json']).links.carl, 'Anna');
});

// ---- js/app.js people cards: data-hc-login where the GitHub layer knows the person's one login ----
test('U5: a people card carries data-hc-login when one public login maps to that roster name (read-only attribute)', async () => {
  const { bootSite } = await import('./view_harness.mjs');
  const site = await bootSite({ hash: '#/' });
  const T = site.win.HCTeam;
  const pub = { people: { 'ada-l': { roster: 'Ada' }, twin1: { roster: 'Bo' }, twin2: { roster: 'Bo' }, x: { roster: null } } };
  const lists = T.teamLists({ groups: [{ id: 'active', title: 'Team', people: [{ name: 'Ada' }, { name: 'Bo' }, { name: 'Cy' }] },
    { id: 'alumni', title: 'Alumni', people: [] }] }, pub);
  const html = lists.map(([, , l]) => l.map(T.personCardHTML).join('')).join('');
  assert.match(html, /data-hc-name="Ada"[^>]* data-hc-login="ada-l"/);
  assert.ok(!/data-hc-name="Bo"[^>]*data-hc-login/.test(html), 'two logins: neither');
  assert.ok(!/data-hc-name="Cy"[^>]*data-hc-login/.test(html), 'no login: none');
  // a hostile login never reaches the markup
  assert.ok(!T.personCardHTML({ person: { name: 'Z' }, login: '"><img src=x>' }).includes('<img src=x'));
  assert.ok(!/data-hc-login/.test(T.personCardHTML({ person: { name: 'Z' }, login: 'not a login' })));
});
