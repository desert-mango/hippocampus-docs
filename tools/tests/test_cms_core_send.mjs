// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 23 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test the cms-core side of the dock's send flow (U2): what Send for review writes, and nothing more.
/* Made by U0 (editor UI/UX build) so unit U2 adds its tests here, not to a shared test file.

     node --test tools/tests/test_cms_core_send.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const C = require(path.join(ROOT, 'js', 'cms-core.js'));
const R = C.REPO_API_PATH;

const MAIN = '1'.repeat(40);
const MAIN_TREE = '2'.repeat(40);
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const NOW = Date.UTC(2026, 9, 23, 12);
const DAY = 24 * 3600 * 1000;
const base = { ref: 'main', sha: MAIN, number: null };

const draft = (key, label, files, originals, extra) => Object.assign({ key, label, route: `/${key}`, files, originals,
  base }, extra || {});
const pageDraft = (key, label, file, before, after, extra) => draft(key, label, { [file]: after }, { [file]: before }, extra);
const FACTS = '{\n  "name": "Sensor Fusion",\n  "status": "active"\n}\n';
const FACTS_2 = '{\n  "name": "Sensor Fusion",\n  "status": "paused"\n}\n';
const PROJECTS = '{\n  "projects": [\n    {"id": "fusion", "add": [], "remove": []}\n  ]\n}\n';
const PROJECTS_ADD = '{\n  "projects": [\n    {"id": "fusion", "add": ["carol"], "remove": []}\n  ]\n}\n';
const PEOPLE = '{"groups": []}\n';
const PEOPLE_2 = '{"groups": [{"id": "x", "title": "X", "people": []}]}\n';

const eligibleRows = (g) => g.changes.map((c) => ({ filename: c.path, status: c.original === null ? 'added' : 'modified' }));
const cmsPull = { number: 9, state: 'open', head: { ref: 'cms/bob/x-261023', repo: { full_name: C.REPO_FULL } } };

// ------------------------------------------------------------ splitSend --

test('splitSend: a page edit and a facts edit make two groups; the page group stays go-live eligible', () => {
  const page = pageDraft('setup/a', 'Setup A', 'content/setup/a.md', 'old\n', 'new\n');
  const facts = draft('projects/fusion', 'Sensor Fusion', { 'data/projects/fusion.json': FACTS_2 },
    { 'data/projects/fusion.json': FACTS });
  const groups = C.splitSend([page, facts]);
  assert.deepEqual(groups.map((g) => g.kind), ['page', 'facts']);
  const [p, f] = groups;
  assert.deepEqual(p.changes.map((c) => c.path), ['content/setup/a.md']);
  assert.equal(C.proposalEligible(cmsPull, eligibleRows(p)), true, 'every file a modified content/**.md');
  assert.equal(C.proposalEligible(cmsPull, eligibleRows(f)), false, 'facts are reviewed whole');
  assert.equal(p.title, 'Edit Setup A');
  assert.equal(p.commit, 'Edit Setup A\n\nMade in the site editor.');
  assert.equal(f.title, 'Update Sensor Fusion facts');
  assert.equal(p.target, null);
  assert.deepEqual(p.problems, []);
});

test('splitSend: one page group for every page and every notes-only page; one group per facts file, people change, new project, access change', () => {
  const a = pageDraft('setup/a', 'Setup A', 'content/setup/a.md', 'old\n', 'new\n');
  const b = pageDraft('setup/b', 'Setup B', 'content/setup/b.md', 'same\n', 'same\n',
    { notes: [{ key: KEY_A, text: 'Is this still right?' }] });
  const story = draft('projects/fusion', 'Sensor Fusion',
    { 'content/projects/fusion.md': 'Story 2\n', 'data/projects/fusion.json': FACTS_2 },
    { 'content/projects/fusion.md': 'Story\n', 'data/projects/fusion.json': FACTS });
  const people = draft('team', 'Team', { 'data/people.json': PEOPLE_2 }, { 'data/people.json': PEOPLE });
  const fresh = draft('new/projects/sonar', 'New project: Sonar', {
    'data/projects.json': PROJECTS, 'data/projects/sonar.json': '{"name": "Sonar"}\n', 'content/projects/sonar.md': 'S\n',
  }, { 'data/projects.json': '{"projects": []}\n', 'data/projects/sonar.json': null, 'content/projects/sonar.md': null });
  const access = draft('access/fusion', 'Edit access: Sensor Fusion', { 'data/projects.json': PROJECTS_ADD },
    { 'data/projects.json': PROJECTS });
  const untouched = pageDraft('setup/c', 'Setup C', 'content/setup/c.md', 'x\n', 'x\n');
  const groups = C.splitSend([a, b, story, people, fresh, access, untouched, { junk: true }]);
  assert.deepEqual(groups.map((g) => g.kind), ['page', 'facts', 'people', 'project', 'access']);
  const [p, f, t, n, x] = groups;
  assert.deepEqual(p.drafts.map((d) => d.key), ['setup/a', 'setup/b', 'projects/fusion'], 'the story is a page');
  assert.deepEqual(p.changes.map((c) => c.path), ['content/setup/a.md', 'content/projects/fusion.md']);
  assert.deepEqual(p.notes, [{ key: KEY_A, text: 'Is this still right?' }], 'notes are the page kind');
  assert.deepEqual(p.pages.map((q) => q.label), ['Setup A', 'Setup B', 'Sensor Fusion']);
  assert.equal(C.proposalEligible(cmsPull, eligibleRows(p)), true);
  assert.equal(p.title, 'Edit 3 pages: Setup A, Setup B, Sensor Fusion');
  assert.deepEqual(Object.keys(f.drafts[0].files), ['data/projects/fusion.json'], 'the facts half of the same draft');
  assert.equal(f.title, 'Update Sensor Fusion facts');
  assert.equal(t.title, 'Update the team');
  assert.equal(n.title, 'New project: Sonar');
  assert.deepEqual(n.changes.map((c) => c.path).sort(), ['content/projects/sonar.md', 'data/projects.json', 'data/projects/sonar.json']);
  assert.equal(x.title, C.accessProposalTitle({ kind: 'request', login: 'carol', name: 'fusion' }));
  assert.equal(x.title, 'Edit access request: carol for fusion');
  assert.equal(C.splitSend([access], { login: 'dave', names: { fusion: 'Sensor Fusion' } })[0].title,
    'Edit access change: add carol to Sensor Fusion', 'someone else\'s add is a change, by the project\'s name');
  assert.deepEqual(C.splitSend([untouched]), [], 'nothing changed: nothing to send');
  assert.deepEqual(C.splitSend(null), []);
});

test('splitSend: a page draft on my open proposal keeps that target; notes-only groups have no "nothing to propose" problem', () => {
  const own = { ref: 'cms/bob/fix-261020', sha: '3'.repeat(40), number: 7 };
  const g = C.splitSend([pageDraft('setup/a', 'Setup A', 'content/setup/a.md', 'x\n', 'x\n',
    { base: own, notes: [{ key: KEY_B, text: 'note' }, { key: 'short', text: 'bad key' }, { key: KEY_A, text: '  ' }] })]);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].target, { branch: own.ref, number: 7 });
  assert.deepEqual(g[0].changes, []);
  assert.deepEqual(g[0].notes, [{ key: KEY_B, text: 'note' }], 'only a 64-hex key with text');
  assert.deepEqual(g[0].problems, []);
  assert.deepEqual(g[0].pages, [{ label: 'Setup A', file: 'content/setup/a.md' }]);
});

test('splitSend: a page edit and a site.json edit make two groups; the page group stays go-live eligible', () => {
  const page = pageDraft('setup/a', 'Setup A', 'content/setup/a.md', 'old\n', 'new\n');
  const home = draft('home', 'Home', { 'data/site.json': '{"cards": [1]}\n' }, { 'data/site.json': '{"cards": []}\n' });
  const groups = C.splitSend([page, home]);
  assert.deepEqual(groups.map((g) => g.kind), ['page', 'site']);
  const [p, s] = groups;
  assert.deepEqual(p.changes.map((c) => c.path), ['content/setup/a.md']);
  assert.equal(C.proposalEligible(cmsPull, eligibleRows(p)), true, 'the page group holds only modified pages');
  assert.equal(p.eligible, true, 'eligible is given on the group');
  assert.equal(s.eligible, false);
  assert.deepEqual(s.changes.map((c) => c.path), ['data/site.json']);
  assert.equal(C.proposalEligible(cmsPull, eligibleRows(s)), false, 'site data is reviewed whole');
  assert.equal(s.title, 'Update site data');
  assert.equal(s.commit, 'Update site data\n\nMade in the site editor.');
  assert.deepEqual(s.notes, []);
});

test('splitSend: a new page alone makes one site group titled "New page: …"', () => {
  const fresh = draft('new/tools/x', 'New tool: X', { 'content/tools/x.md': 'x\n' }, { 'content/tools/x.md': null });
  const groups = C.splitSend([fresh]);
  assert.deepEqual(groups.map((g) => g.kind), ['site']);
  assert.equal(groups[0].title, 'New page: X');
  assert.deepEqual(groups[0].changes.map((c) => c.path), ['content/tools/x.md']);
  const two = C.splitSend([fresh, draft('new/setup/y', 'Y', { 'content/setup/y.md': 'y\n' }, { 'content/setup/y.md': null })]);
  assert.deepEqual(two.map((g) => g.kind), ['site'], 'one site group per send');
  assert.equal(two[0].title, 'New pages: X, Y');
  const withData = C.splitSend([fresh, draft('tools', 'Tools', { 'data/tools.json': '[1]\n' }, { 'data/tools.json': '[]\n' })]);
  assert.equal(withData[0].title, 'Update site data', 'not only new pages: site data');
});

test('splitSend: every file outside the five kinds goes in ONE site group; order page, site, facts, people, project, access', () => {
  const PROJECTS_INTRO = '{\n  "intro": "New intro",\n  "projects": [\n    {"id": "fusion", "add": [], "remove": []}\n  ]\n}\n';
  const MANIFEST = '{"images": {}}\n';
  const MANIFEST_2 = '{"images": {"a.png": {}}}\n';
  const a = pageDraft('setup/a', 'Setup A', 'content/setup/a.md', 'old\n', 'new\n',
    { files: { 'content/setup/a.md': 'new\n', 'data/cloudinary-manifest.json': MANIFEST_2 },
      originals: { 'content/setup/a.md': 'old\n', 'data/cloudinary-manifest.json': MANIFEST } });
  const intro = draft('projects', 'Projects', { 'data/projects.json': PROJECTS_INTRO }, { 'data/projects.json': PROJECTS });
  const tools = draft('tools', 'Tools', { 'data/tools.json': '[1]\n' }, { 'data/tools.json': '[]\n' });
  const fresh = draft('new/setup/y', 'Y', { 'content/setup/y.md': 'y\n' }, { 'content/setup/y.md': null });
  const facts = draft('projects/fusion', 'Sensor Fusion', { 'data/projects/fusion.json': FACTS_2 },
    { 'data/projects/fusion.json': FACTS });
  const people = draft('team', 'Team', { 'data/people.json': PEOPLE_2 }, { 'data/people.json': PEOPLE });
  const project = draft('new/projects/sonar', 'New project: Sonar', {
    'data/projects.json': PROJECTS, 'data/projects/sonar.json': '{"name": "Sonar"}\n', 'content/projects/sonar.md': 'S\n',
  }, { 'data/projects.json': '{"projects": []}\n', 'data/projects/sonar.json': null, 'content/projects/sonar.md': null });
  const access = draft('access/fusion', 'Edit access: Sensor Fusion', { 'data/projects.json': PROJECTS_ADD },
    { 'data/projects.json': PROJECTS });
  const groups = C.splitSend([access, project, people, facts, fresh, tools, intro, a]);
  assert.deepEqual(groups.map((g) => g.kind), ['page', 'site', 'facts', 'people', 'project', 'access']);
  assert.deepEqual(C.SEND_KINDS, ['page', 'site', 'facts', 'people', 'project', 'access']);
  const [p, s] = groups;
  assert.deepEqual(p.changes.map((c) => c.path), ['content/setup/a.md', 'data/cloudinary-manifest.json'],
    'the image list travels with the page that uses it (the gate\'s 6a rule)');
  assert.equal(C.proposalEligible(cmsPull, eligibleRows(p)), false);
  assert.equal(p.eligible, false);
  assert.deepEqual(s.changes.map((c) => c.path).sort(), ['content/setup/y.md', 'data/projects.json', 'data/tools.json']);
  assert.equal(s.title, 'Update site data');
  assert.equal(s.eligible, false);
});

const MANIFEST = '{"images": {}}\n';
const MANIFEST_2 = '{"images": {"a.png": {}}}\n';

test('splitSend: a page edit and an image-list change make ONE page group, reviewed whole; no site group', () => {
  const same = pageDraft('setup/a', 'Setup A', 'content/setup/a.md', 'old\n', 'new\n',
    { files: { 'content/setup/a.md': 'new\n', 'data/cloudinary-manifest.json': MANIFEST_2 },
      originals: { 'content/setup/a.md': 'old\n', 'data/cloudinary-manifest.json': MANIFEST } });
  const one = C.splitSend([same]);
  assert.deepEqual(one.map((g) => g.kind), ['page']);
  assert.deepEqual(one[0].changes.map((c) => c.path), ['content/setup/a.md', 'data/cloudinary-manifest.json']);
  assert.equal(one[0].eligible, false, 'not go-live eligible: reviewed whole');
  assert.equal(C.proposalEligible(cmsPull, eligibleRows(one[0])), false);
  assert.equal(one[0].title, 'Edit Setup A');
  // the image list in a draft of its own still joins the send's page group
  const page = pageDraft('setup/a', 'Setup A', 'content/setup/a.md', 'old\n', 'new\n');
  const images = draft('images', 'Images', { 'data/cloudinary-manifest.json': MANIFEST_2 },
    { 'data/cloudinary-manifest.json': MANIFEST });
  const two = C.splitSend([images, page]);
  assert.deepEqual(two.map((g) => g.kind), ['page'], 'no site group');
  assert.deepEqual(two[0].changes.map((c) => c.path).sort(), ['content/setup/a.md', 'data/cloudinary-manifest.json']);
  assert.equal(two[0].eligible, false);
  assert.equal(two[0].title, 'Edit Setup A', 'the image list is not counted as a page');
});

test('splitSend: an image-list change alone makes one site group', () => {
  const images = draft('images', 'Images', { 'data/cloudinary-manifest.json': MANIFEST_2 },
    { 'data/cloudinary-manifest.json': MANIFEST });
  const groups = C.splitSend([images]);
  assert.deepEqual(groups.map((g) => g.kind), ['site']);
  assert.deepEqual(groups[0].changes.map((c) => c.path), ['data/cloudinary-manifest.json']);
  assert.equal(groups[0].eligible, false);
  assert.equal(groups[0].title, 'Update site data');
  // a notes-only page is not a page edit: the image list still goes to site
  const noted = pageDraft('setup/a', 'Setup A', 'content/setup/a.md', 'x\n', 'x\n', { notes: [{ key: KEY_A, text: 'see this' }] });
  assert.deepEqual(C.splitSend([noted, images]).map((g) => g.kind), ['page', 'site']);
});

// ------------------------------------------------- titles and the count --

test('proposalTitle: one page, several pages, facts, the team, a new project, access; the commit text', () => {
  const p = (label, key) => pageDraft(key || label, label, `content/${(key || label).toLowerCase()}.md`, 'a', 'b');
  assert.equal(C.proposalTitle('page', [p('Setup A')]), 'Edit Setup A');
  assert.equal(C.proposalTitle('page', [p('A'), p('B')]), 'Edit 2 pages: A, B');
  assert.equal(C.proposalTitle('page', [p('A'), p('B'), p('C'), p('D'), p('E')]), 'Edit 5 pages: A, B, C and 2 more');
  assert.equal(C.proposalTitle('page', [draft('new/tools/x', 'New tool: X', { 'content/tools/x.md': 'x' },
    { 'content/tools/x.md': null })]), 'New tool: X', 'a new page keeps its own label');
  assert.equal(C.proposalTitle('facts', [draft('projects/fusion', 'Fusion page', { 'data/projects/fusion.json': '{oops' },
    { 'data/projects/fusion.json': FACTS })]), 'Update Fusion page facts', 'unreadable facts: the label');
  assert.equal(C.proposalTitle('people', []), 'Update the team');
  assert.equal(C.proposalTitle('project', [draft('new/projects/sonar', 'New project: Sonar',
    { 'data/projects/sonar.json': '{"name": "Sonar Array"}' }, { 'data/projects/sonar.json': null })]), 'New project: Sonar Array');
  assert.throws(() => C.proposalTitle('nope', []), /no such kind/);
  assert.equal(C.proposalCommit('Edit Setup A'), 'Edit Setup A\n\nMade in the site editor.');
  assert.equal(C.proposalBranch('Bob', C.proposalTitle('page', [p('A'), p('B')]), NOW), 'cms/bob/edit-2-pages-a-b-261023',
    'the existing slug rules apply');
});

test('pageChangeCount: one per changed page, a notes-only page counts, an untouched one does not', () => {
  const a = pageDraft('a', 'A', 'content/a.md', 'x', 'y');
  const two = draft('p', 'P', { 'content/projects/p.md': 'y', 'data/projects/p.json': '{}' },
    { 'content/projects/p.md': 'x', 'data/projects/p.json': '{"a":1}' });
  const noted = pageDraft('b', 'B', 'content/b.md', 'x', 'x', { notes: [{ key: KEY_A, text: 'hm' }] });
  const same = pageDraft('c', 'C', 'content/c.md', 'x', 'x');
  assert.equal(C.pageChangeCount([a, two, noted, same]), 3);
  assert.equal(C.pageChangeCount([]), 0);
  assert.equal(C.pageChangeCount(undefined), 0);
});

// --------------------------------------------------------- notesSection --

test('notesSection: serialise appends or replaces one machine section; parse reads it back; the human text is untouched', () => {
  const human = 'Edit Setup A\n\nPages:\n- Setup A (`content/setup/a.md`)\n';
  const notes = [{ key: KEY_A, text: 'Is the --flag still <b>right</b>? -->' }];
  const one = C.notesSection.serialise(human, notes);
  assert.ok(one.startsWith(human), 'the human part first, as it was');
  assert.equal((one.match(/<!-- hc-notes /g) || []).length, 1);
  assert.equal((one.match(/-->/g) || []).length, 1, 'a note\'s own "-->" cannot end the section early');
  assert.ok(!/<b>/.test(one), 'no markup reaches the body');
  assert.deepEqual(C.notesSection.parse(one), notes);
  const two = C.notesSection.serialise(`${one}Thanks!\n`, [{ key: KEY_B, text: 'second' }]);
  assert.equal((two.match(/<!-- hc-notes /g) || []).length, 1, 'replaced, not added');
  assert.ok(two.startsWith(human) && two.endsWith('Thanks!\n'), 'text around the section kept');
  assert.deepEqual(C.notesSection.parse(two), [{ key: KEY_B, text: 'second' }]);
  assert.equal(C.notesSection.serialise(two, []), `${human}\nThanks!\n`, 'no notes: the section goes');
  assert.equal(C.notesSection.serialise(human, []), human);
  assert.equal(C.notesSection.serialise('no newline', [{ key: KEY_A, text: 'x' }]).split('\n')[0], 'no newline');
  const long = C.notesSection.parse(C.notesSection.serialise('', [{ key: KEY_A, text: 'x'.repeat(2500) }]));
  assert.equal(long[0].text.length, 2000, 'text capped at 2000');
  assert.equal(C.NOTE_MAX, 2000);
});

test('notesSection.parse: [] on anything malformed (the body is untrusted text)', () => {
  const sec = (json) => `hi\n<!-- hc-notes ${json} -->\n`;
  for (const body of [null, undefined, 42, '', 'no section', sec('{'), sec('{"key": 1}'), sec('[1]'),
    sec(`[{"key": "${'g'.repeat(64)}", "text": "x"}]`), sec(`[{"key": "${KEY_A}", "text": 3}]`),
    sec(`[{"key": "${KEY_A}", "text": "x", "html": "<i>"}]`), sec(`[{"key": "${KEY_A}", "text": "${'y'.repeat(2001)}"}]`),
    '<!-- hc-notes [] ', sec('[]').replace('-->', '')]) {
    assert.deepEqual(C.notesSection.parse(body), [], JSON.stringify(body));
  }
  assert.deepEqual(C.notesSection.parse(sec(`[{"key": "${KEY_A}", "text": "ok"}]`)), [{ key: KEY_A, text: 'ok' }]);
});

// --------------------------------------------------------- own sends ----

test('sentStatus: open waiting; merged or applied live; closed or every edit declined declined; a notes-only close seen; 14 days', () => {
  const at = (days) => new Date(NOW - days * DAY).toISOString();
  assert.equal(C.sentStatus({ number: 1, state: 'open', created_at: at(40) }, NOW), 'waiting');
  assert.equal(C.sentStatus({ number: 1, state: 'closed', merged_at: at(1), closed_at: at(1) }, NOW), 'live');
  assert.equal(C.sentStatus({ number: 1, state: 'closed', closed_at: at(2), applied: true }, NOW), 'live', 'go-live put it live');
  assert.equal(C.sentStatus({ number: 1, state: 'closed', closed_at: at(2) }, NOW), 'declined');
  assert.equal(C.sentStatus({ number: 1, state: 'closed', closed_at: at(2), notesOnly: true }, NOW), 'seen');
  assert.equal(C.sentStatus({ number: 1, state: 'closed', closed_at: at(2), changed_files: 0 }, NOW), 'seen');
  assert.equal(C.sentStatus({ number: 1, state: 'closed', closed_at: at(15), merged_at: at(15) }, NOW), null, 'older than 14 days');
  assert.equal(C.sentStatus({ number: 1, state: 'closed' }, NOW), null, 'closed with no date: not shown');
  assert.equal(C.sentStatus(null, NOW), null);
});

test('ownSends: only my editor sends, newest first, with their status', () => {
  const at = (days) => new Date(NOW - days * DAY).toISOString();
  const pr = (n, login, ref, extra) => Object.assign({ number: n, title: `T${n}`, user: { login },
    head: { ref, repo: { full_name: C.REPO_FULL } }, base: { ref: 'main' }, html_url: `https://github.com/x/${n}` }, extra);
  const list = [
    pr(1, 'Bob', 'cms/bob/a-261001', { state: 'open', created_at: at(3) }),
    pr(2, 'bob', 'cms/bob/b-261002', { state: 'closed', closed_at: at(1), merged_at: at(1) }),
    pr(3, 'carol', 'cms/carol/c-261003', { state: 'open', created_at: at(0) }),
    pr(4, 'bob', 'feature/x', { state: 'open', created_at: at(0) }),
    pr(5, 'bob', 'cms/bob/old-260901', { state: 'closed', closed_at: at(30) }),
    pr(6, 'bob', 'cms/bob/n-261020', { state: 'closed', closed_at: at(2), notesOnly: true }),
    'junk',
  ];
  assert.deepEqual(C.ownSends('BOB', list, NOW).map((s) => [s.number, s.status]), [[2, 'live'], [6, 'seen'], [1, 'waiting']]);
  assert.deepEqual(Object.keys(C.ownSends('bob', list, NOW)[0]).sort(), ['at', 'branch', 'number', 'status', 'title', 'url']);
  assert.deepEqual(C.ownSends('', list, NOW), []);
});

// ------------------------------------------------------ the undo rows ---

const cmsRef = `${R}/git/refs/heads/cms/bob/fix-typo-261023`;
const SHA40 = 'c'.repeat(40);

test('write rows: the ref move is fast-forward only; rewind is the one force move; drop-ref deletes only a cms/ branch', () => {
  assert.equal(C.isAllowedWrite('PATCH', cmsRef, { sha: SHA40, force: false }), true, 'move');
  assert.equal(C.isAllowedWrite('PATCH', cmsRef, { force: true, sha: SHA40 }), true, 'rewind');
  assert.equal(C.isAllowedWrite('DELETE', cmsRef, undefined), true, 'drop-ref');
  assert.equal(C.WRITE_METHODS.filter((w) => w.method === 'PATCH' && w.path.test('/git/refs/heads/cms/a/b')
    && w.body({ sha: SHA40, force: true })).length, 1, 'force is allowed by exactly one row');
  for (const bad of [{ sha: SHA40, force: 'true' }, { sha: SHA40, force: true, extra: 1 }, { force: true }, {},
    undefined, null, { sha: 'c'.repeat(39), force: true }, { sha: 'd'.repeat(64), force: false }, { sha: SHA40 },
    { sha: SHA40.toUpperCase(), force: false }, [SHA40, true]]) {
    assert.equal(C.isAllowedWrite('PATCH', cmsRef, bad), false, JSON.stringify(bad));
  }
  for (const p of [`${R}/pulls/7`, `${R}/git/refs/heads/main`, `${R}/git/refs/heads/feature/x`, `${R}/git/refs/heads/cms/bob`,
    `${R}/git/refs/tags/cms/bob/x`, `${R}/git/refs/heads/cms`, `${R}/issues/7`, `${cmsRef}?x=1`]) {
    assert.equal(C.isAllowedWrite('DELETE', p, undefined), false, p);
  }
  assert.equal(C.isAllowedWrite('DELETE', cmsRef, {}), false, 'a delete carries no body');
  assert.deepEqual(C.proposeRequest('rewind', { branch: 'cms/bob/x', sha: SHA40 }),
    { method: 'PATCH', path: `${R}/git/refs/heads/cms/bob/x`, body: { sha: SHA40, force: true } });
  assert.deepEqual(C.proposeRequest('drop-ref', { branch: 'cms/bob/x' }),
    { method: 'DELETE', path: `${R}/git/refs/heads/cms/bob/x` });
  assert.deepEqual(C.proposeRequest('close', { number: 7 }), { method: 'PATCH', path: `${R}/pulls/7`, body: { state: 'closed' } });
  for (const branch of ['main', 'cms/bob', 'feature/x']) {
    assert.throws(() => C.proposeRequest('drop-ref', { branch }), /proposal branch/);
    assert.throws(() => C.proposeRequest('rewind', { branch, sha: SHA40 }), /proposal branch/);
  }
});

// ---------------------------------------- a fake GitHub that keeps state --

function fakeGitHub(init) {
  const s = Object.assign({ refs: { main: MAIN }, commits: { [MAIN]: { tree: MAIN_TREE, parents: [] } }, pulls: {} }, init || {});
  let k = 0;
  const fresh = () => (k += 1).toString(16).padStart(40, 'e');
  const calls = [];
  const out = (status, body) => ({ ok: status >= 200 && status < 300, status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)) });
  const fetch = async (url, o) => {
    const rest = String(url).slice('https://api.github.com'.length + R.length);
    const body = o.body ? JSON.parse(o.body) : undefined;
    calls.push({ method: o.method, rest, body });
    if (s.hook) { const x = s.hook(o.method, rest, body, s); if (x) return out(...x); }
    let m;
    if (o.method === 'GET' && (m = rest.match(/^\/git\/ref\/heads\/(.+)$/))) {
      return s.refs[m[1]] ? out(200, { object: { sha: s.refs[m[1]] } }) : out(404, { message: 'Not Found' });
    }
    if (o.method === 'GET' && (m = rest.match(/^\/git\/commits\/([0-9a-f]{40})$/))) {
      const c = s.commits[m[1]];
      return c ? out(200, { sha: m[1], tree: { sha: c.tree }, parents: c.parents.map((p) => ({ sha: p })) }) : out(404, {});
    }
    if (o.method === 'GET' && (m = rest.match(/^\/pulls\/(\d+)$/))) {
      const p = s.pulls[m[1]];
      return p ? out(200, Object.assign({ number: Number(m[1]) }, p)) : out(404, {});
    }
    if (o.method === 'POST' && (rest === '/git/blobs' || rest === '/git/trees')) return out(201, { sha: fresh() });
    if (o.method === 'POST' && rest === '/git/commits') {
      const sha = fresh();
      s.commits[sha] = { tree: body.tree, parents: body.parents };
      return out(201, { sha });
    }
    if (o.method === 'POST' && rest === '/git/refs') {
      const name = body.ref.replace('refs/heads/', '');
      if (s.refs[name]) return out(422, { message: 'Reference already exists' });
      s.refs[name] = body.sha;
      return out(201, { ref: body.ref, object: { sha: body.sha } });
    }
    if ((m = rest.match(/^\/git\/refs\/heads\/(.+)$/))) {
      if (!s.refs[m[1]]) return out(422, { message: 'Reference does not exist' });
      if (o.method === 'DELETE') { delete s.refs[m[1]]; return out(204); }
      const c = s.commits[body.sha];
      if (!body.force && !(c && c.parents.indexOf(s.refs[m[1]]) >= 0)) return out(422, { message: 'Update is not a fast forward' });
      s.refs[m[1]] = body.sha;
      return out(200, { object: { sha: body.sha } });
    }
    if (o.method === 'POST' && rest === '/pulls') {
      s.pulls[42] = { state: 'open', title: body.title, body: body.body, head: { ref: body.head } };
      return out(201, { number: 42 });
    }
    if (o.method === 'PATCH' && (m = rest.match(/^\/pulls\/(\d+)$/))) {
      Object.assign(s.pulls[m[1]], body);
      return out(200, { number: Number(m[1]) });
    }
    return out(500, { message: `unexpected ${o.method} ${rest}` });
  };
  return { s, calls, seq: () => calls.map((c) => `${c.method} ${c.rest}`),
    client: C.createGitHubClient({ fetch, token: 'gho_test' }) };
}

const noteOpts = (o) => Object.assign({ login: 'Bob', now: NOW, origin: 'https://docs.example.org', target: null,
  kind: 'page', drafts: [pageDraft('setup/a', 'Setup A', 'content/setup/a.md', 'x\n', 'x\n')],
  changes: [], pages: [{ label: 'Setup A', file: 'content/setup/a.md' }], notes: [{ key: KEY_A, text: 'Check this' }] }, o || {});

test('runPropose: a notes-only send is one empty commit on the base tree (no blob, no tree), one PR, and the notes in its body', async () => {
  const gh = fakeGitHub();
  const out = await C.runPropose(gh.client, noteOpts());
  const branch = 'cms/bob/edit-setup-a-261023';
  assert.deepEqual(gh.seq(), ['GET /git/ref/heads/main', `GET /git/commits/${MAIN}`, 'POST /git/commits', 'POST /git/refs',
    'POST /pulls', 'PATCH /pulls/42'], 'no blob and no tree request');
  assert.deepEqual(gh.calls[2].body, { message: 'Edit Setup A\n\nMade in the site editor.', tree: MAIN_TREE, parents: [MAIN] });
  assert.equal(gh.s.commits[out.sha].tree, gh.s.commits[MAIN].tree, 'the commit\'s tree equals its base\'s');
  assert.equal(gh.calls[4].body.title, 'Edit Setup A', 'the generated title');
  assert.deepEqual(C.notesSection.parse(gh.calls[4].body.body), [{ key: KEY_A, text: 'Check this' }]);
  assert.deepEqual(C.notesSection.parse(gh.s.pulls[42].body), [{ key: KEY_A, text: 'Check this' }], 'the review link kept them');
  assert.deepEqual(out, { ok: true, number: 42, branch, added: false, message: 'Proposed as #42.',
    created: true, sha: out.sha, parent: MAIN, drafts: noteOpts().drafts });
  assert.equal(gh.s.refs[branch], out.sha);
  const nothing = await C.runPropose(fakeGitHub().client, noteOpts({ notes: [] }));
  assert.equal(nothing.ok, false);
  assert.match(nothing.message, /nothing to propose/);
});

test('runPropose: adding to my open send PATCHes its body\'s notes section (merged by key) and returns the undo info', async () => {
  const OWN = 'cms/bob/fix-261020';
  const TIP = '3'.repeat(40);
  const prev = C.notesSection.serialise('Mine.\n', [{ key: KEY_A, text: 'old' }, { key: KEY_B, text: 'keep' }]);
  const gh = fakeGitHub({ refs: { main: MAIN, [OWN]: TIP }, commits: { [MAIN]: { tree: MAIN_TREE, parents: [] },
    [TIP]: { tree: '4'.repeat(40), parents: [MAIN] } }, pulls: { 7: { state: 'open', body: prev } } });
  const out = await C.runPropose(gh.client, noteOpts({ target: { branch: OWN, number: 7 },
    changes: [{ path: 'content/setup/a.md', text: 'y\n', original: 'x\n', baseSha: TIP }], notes: [{ key: KEY_A, text: 'new' }] }));
  assert.deepEqual(gh.seq(), [`GET /git/ref/heads/${OWN}`, `GET /git/commits/${TIP}`, 'GET /pulls/7', 'POST /git/blobs',
    'POST /git/trees', 'POST /git/commits', `PATCH /git/refs/heads/${OWN}`, 'PATCH /pulls/7']);
  assert.deepEqual(C.notesSection.parse(gh.s.pulls[7].body), [{ key: KEY_A, text: 'new' }, { key: KEY_B, text: 'keep' }]);
  assert.ok(gh.s.pulls[7].body.startsWith('Mine.\n'));
  assert.equal(out.ok, true);
  assert.equal(out.added, true);
  assert.equal(out.created, false);
  assert.equal(out.parent, TIP);
  assert.equal(out.sha, gh.s.refs[OWN]);
  assert.equal(out.prevBody, prev);
  // without notes, the body is neither read nor written
  const plain = fakeGitHub({ refs: { main: MAIN, [OWN]: TIP }, commits: { [TIP]: { tree: '4'.repeat(40), parents: [MAIN] } },
    pulls: { 7: { state: 'open', body: prev } } });
  const o2 = await C.runPropose(plain.client, noteOpts({ target: { branch: OWN, number: 7 }, notes: [],
    changes: [{ path: 'content/setup/a.md', text: 'y\n', original: 'x\n', baseSha: TIP }] }));
  assert.ok(!plain.seq().some((x) => /pulls/.test(x)));
  assert.equal(o2.prevBody, null);
});

test('runPropose: a failed notes write after the commit landed still returns the send and its undo info', async () => {
  const OWN = 'cms/bob/fix-261020';
  const TIP = '3'.repeat(40);
  const repo = (hook) => {
    const gh = fakeGitHub({ refs: { main: MAIN, [OWN]: TIP }, commits: { [MAIN]: { tree: MAIN_TREE, parents: [] },
      [TIP]: { tree: '4'.repeat(40), parents: [MAIN] } }, pulls: { 7: { state: 'open', body: 'Mine.\n' } } });
    gh.s.hook = hook;
    return gh;
  };
  const opts = noteOpts({ target: { branch: OWN, number: 7 } });
  const signed = repo((m, rest) => (m === 'PATCH' && rest === '/pulls/7' ? [401, { message: 'Bad credentials' }] : null));
  const a = await C.runPropose(signed.client, opts);
  assert.equal(a.ok, true, 'the commit landed: never {ok:false}');
  assert.equal(a.warning, 'notes');
  assert.equal(a.signedOut, true);
  assert.equal(a.sha, signed.s.refs[OWN]);
  assert.equal(a.parent, TIP);
  assert.equal(a.prevBody, 'Mine.\n');
  assert.equal(a.created, false);
  const net = repo((m, rest) => { if (m === 'PATCH' && rest === '/pulls/7') throw new Error('network down'); return null; });
  const b = await C.runPropose(net.client, opts);
  assert.equal(b.ok, true);
  assert.equal(b.warning, 'notes');
  assert.equal(b.signedOut, undefined);
  assert.match(b.message, /notes were not saved/);
  assert.equal(b.sha, net.s.refs[OWN]);
});

// ------------------------------------------------------------ runUndo ---

test('runUndo: a new send is closed and its branch deleted; the drafts come back', async () => {
  const gh = fakeGitHub();
  const sent = await C.runPropose(gh.client, noteOpts());
  const before = gh.calls.length;
  const undo = await C.runUndo(gh.client, sent);
  assert.deepEqual(gh.seq().slice(before), ['PATCH /pulls/42', `DELETE /git/refs/heads/${sent.branch}`]);
  assert.deepEqual(gh.calls[before].body, { state: 'closed' });
  assert.equal(gh.s.pulls[42].state, 'closed');
  assert.equal(gh.s.refs[sent.branch], undefined);
  assert.deepEqual(undo, { ok: true, drafts: noteOpts().drafts });
});

function extendedRepo(body) {
  const OWN = 'cms/bob/fix-261020';
  const TIP = '3'.repeat(40);
  return { OWN, TIP, gh: fakeGitHub({ refs: { main: MAIN, [OWN]: TIP }, commits: { [MAIN]: { tree: MAIN_TREE, parents: [] },
    [TIP]: { tree: '4'.repeat(40), parents: [MAIN] } }, pulls: { 7: { state: 'open', body } } }) };
}

test('runUndo: an extended send moves the branch back to the saved sha and puts the earlier body back', async () => {
  const { OWN, TIP, gh } = extendedRepo('Mine.\n');
  const sent = await C.runPropose(gh.client, noteOpts({ target: { branch: OWN, number: 7 } }));
  assert.equal(sent.ok, true);
  assert.notEqual(gh.s.pulls[7].body, 'Mine.\n');
  const before = gh.calls.length;
  const undo = await C.runUndo(gh.client, sent);
  assert.deepEqual(gh.seq().slice(before), [`GET /git/ref/heads/${OWN}`, `GET /git/commits/${sent.sha}`,
    `PATCH /git/refs/heads/${OWN}`, 'PATCH /pulls/7', `GET /git/ref/heads/${OWN}`]);
  assert.deepEqual(gh.calls[before + 2].body, { sha: TIP, force: true });
  assert.equal(gh.s.refs[OWN], TIP, 'the ref is at the parent again');
  assert.equal(gh.s.pulls[7].body, 'Mine.\n', 'the body equals the earlier body');
  assert.equal(gh.s.pulls[7].state, 'open', 'the send itself stays');
  assert.deepEqual(undo, { ok: true, drafts: noteOpts().drafts });
});

test('runUndo: a moved tip refuses and touches nothing; a commit landing during the undo is said, not hidden', async () => {
  const { OWN, gh } = extendedRepo('Mine.\n');
  const sent = await C.runPropose(gh.client, noteOpts({ target: { branch: OWN, number: 7 } }));
  const other = 'f'.repeat(40);
  gh.s.commits[other] = { tree: MAIN_TREE, parents: [sent.sha] };
  gh.s.refs[OWN] = other;                                  // a reviewer pressed Update, or a new commit landed
  const before = gh.calls.length;
  const undo = await C.runUndo(gh.client, sent);
  assert.deepEqual(undo, { ok: false, reason: 'changed', message: C.UNDO_CHANGED_TEXT });
  assert.equal(C.UNDO_CHANGED_TEXT, "Can't undo: the send changed since");
  assert.deepEqual(gh.seq().slice(before), [`GET /git/ref/heads/${OWN}`], 'only a read');
  // the race: after the rewind the ref is somewhere else
  const race = extendedRepo('Mine.\n');
  const sent2 = await C.runPropose(race.gh.client, noteOpts({ target: { branch: race.OWN, number: 7 } }));
  race.gh.s.hook = (m, rest, body, s) => {
    if (m === 'PATCH' && rest.startsWith('/git/refs/')) { s.refs[race.OWN] = other; return [200, { object: { sha: other } }]; }
    return null;
  };
  const u2 = await C.runUndo(race.gh.client, sent2);
  assert.deepEqual(u2, { ok: true, warning: 'dropped', message: C.UNDO_DROPPED_TEXT, drafts: noteOpts().drafts });
  assert.equal(C.UNDO_DROPPED_TEXT, 'Undo may have dropped a change; check the send');
});

test('runUndo: refuses bad undo info before any request; a refused close keeps the branch', async () => {
  const gh = fakeGitHub();
  for (const bad of [null, {}, { created: true, number: 42, branch: 'main' }, { created: false, number: 7, branch: 'cms/b/x',
    sha: SHA40, parent: 'nope' }, { created: true, number: 0, branch: 'cms/b/x' }]) {
    const u = await C.runUndo(gh.client, bad);
    assert.equal(u.ok, false, JSON.stringify(bad));
  }
  assert.equal(gh.calls.length, 0);
  const g2 = fakeGitHub();
  const sent = await C.runPropose(g2.client, noteOpts());
  g2.s.hook = (m, rest) => (m === 'PATCH' && rest === '/pulls/42' ? [403, { message: 'nope' }] : null);
  const u = await C.runUndo(g2.client, sent);
  assert.equal(u.ok, false);
  assert.equal(g2.s.refs[sent.branch], sent.sha, 'not closed: the branch stays');
});

test('runUndo: when the earlier body cannot be put back, the undo still stands and says so', async () => {
  for (const hook of [(m, rest) => (m === 'PATCH' && rest === '/pulls/7' ? [500, { message: 'boom' }] : null),
    (m, rest) => { if (m === 'PATCH' && rest === '/pulls/7') throw new Error('network down'); return null; }]) {
    const { OWN, TIP, gh } = extendedRepo('Mine.\n');
    const sent = await C.runPropose(gh.client, noteOpts({ target: { branch: OWN, number: 7 } }));
    gh.s.hook = hook;
    const undo = await C.runUndo(gh.client, sent);
    assert.deepEqual(undo, { ok: true, warning: 'body', message: C.UNDO_BODY_TEXT, drafts: noteOpts().drafts });
    assert.equal(gh.s.refs[OWN], TIP, 'the branch is back');
  }
  assert.equal(C.UNDO_BODY_TEXT, "Undone, but the send's notes could not be put back; check the send");
});
