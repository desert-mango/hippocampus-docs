// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 19 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test per-edit go-live: edit keys, the already-live rule, applying edits to main, and approval records.
/* Unit tests for the go-live half of js/cms-core.js (plan-u5 U5a):

     editKey / proposalEdits   one entry per change, add or delete of a page's
                               block diff, keyed by content (never an index),
                               with its state against the CURRENT main
     overlayOnMain             the already-live rule (main already holds it)
     applyEdits                approved edits onto main's text, bytes outside
                               the touched blocks unchanged
     parseRecords / recordBody the `hc-approved` / `hc-declined` comments
     mayApproveEdit            who may approve one edit (shared with Unit P)

     node --test tools/tests/test_go_live.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const C = require(path.join(ROOT, 'js', 'cms-core.js'));

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const P = 'content/projects/learning-to-swim.md';

const BASE = '# Title\n\nFirst para.\n\nSecond para.\n\nThird para.\n';

// ------------------------------------------------------------- editKey --

test('editKey: sha256 of path NUL base NUL head (plus anchor and ordinal for an add)', async () => {
  assert.equal(await C.editKey(P, 'old', 'new'), sha(`${P}\0old\0new`));
  assert.equal(await C.editKey(P, '', 'added', 'anchor', 0), sha(`${P}\0\0added\0anchor\x000`));
  // a committed vector, so the browser and the engine can never drift (plan-u5 r1 A8)
  assert.equal(await C.editKey('content/x.md', 'Ä b', 'Ä c'),
    '2d098526549ef1b3a8ddc02a88096947270d34624c58725beef8d871e0a91b1b');
  assert.notEqual(await C.editKey(P, 'a', 'b'), await C.editKey('content/about.md', 'a', 'b'),
    'two identical fixes on two pages keep distinct keys');
});

// ------------------------------------------------------ proposalEdits --

test('proposalEdits: a change, an add and a delete, each open on an unchanged main', async () => {
  const head = '# Title\n\nFirst para, fixed.\n\nSecond para.\n\nA new para.\n';
  const e = await C.proposalEdits(P, BASE, head, BASE);
  assert.deepEqual(e.map((x) => [x.kind, x.state]), [['change', 'open'], ['change', 'open']],
    'LCS pairs the delete of Third with the add after Second as one change');
  const head2 = '# Title\n\nFirst para, fixed.\n\nSecond para.\n\nThird para.\n\nA new para.\n';
  const e2 = await C.proposalEdits(P, BASE, head2, BASE);
  assert.deepEqual(e2.map((x) => [x.kind, x.base, x.head, x.state]), [
    ['change', 'First para.', 'First para, fixed.', 'open'],
    ['add', '', 'A new para.', 'open'],
  ]);
  assert.equal(e2[0].key, sha(`${P}\0First para.\0First para, fixed.`));
  assert.equal(e2[1].key, sha(`${P}\0\0A new para.\0Third para.\x000`), 'an add is keyed with its anchor block and ordinal');
  const head3 = '# Title\n\nFirst para.\n\nThird para.\n';
  const e3 = await C.proposalEdits(P, BASE, head3, BASE);
  assert.deepEqual(e3.map((x) => [x.kind, x.base, x.head]), [['delete', 'Second para.', '']]);
});

test('proposalEdits: state live once main holds the head version, in all three shapes', async () => {
  const head = '# Title\n\nFirst para, fixed.\n\nThird para.\n\nA new para.\n';
  // main already has every edit
  const e = await C.proposalEdits(P, BASE, head, head);
  assert.ok(e.length >= 2);
  assert.deepEqual([...new Set(e.map((x) => x.state))], ['live']);
});

test('proposalEdits: main changed the same block differently -> conflict, never guessed', async () => {
  const head = '# Title\n\nFirst para, fixed.\n\nSecond para.\n\nThird para.\n';
  const main = '# Title\n\nFirst para, main\'s own fix.\n\nSecond para.\n\nThird para.\n';
  const e = await C.proposalEdits(P, BASE, head, main);
  assert.deepEqual(e.map((x) => x.state), ['conflict']);
});

test('proposalEdits: two identical adds after the same block keep distinct keys (the ordinal) and go live in order', async () => {
  const head = '# Title\n\nFirst para.\n\nSame.\n\nSame.\n\nSecond para.\n\nThird para.\n';
  const e = await C.proposalEdits(P, BASE, head, BASE);
  assert.deepEqual(e.map((x) => x.state), ['open', 'open']);
  assert.notEqual(e[0].key, e[1].key);
  const r = await C.applyEdits(P, BASE, head, BASE, [e[1].key]);
  assert.equal(r.text, '# Title\n\nFirst para.\n\nSame.\n\nSecond para.\n\nThird para.\n');
  const after = await C.proposalEdits(P, BASE, head, r.text);
  assert.deepEqual(after.map((x) => x.state), ['live', 'open'], 'the first twin is the one main holds');
  const all = await C.applyEdits(P, BASE, head, r.text, [e[0].key, e[1].key]);
  assert.equal(all.text, head);
});

test('applyEdits: adds of one run land in head order whatever order they were approved in', async () => {
  const head = '# Title\n\nFirst para.\n\nA1.\n\nA2.\n\nA3.\n\nSecond para.\n\nThird para.\n';
  const e = await C.proposalEdits(P, BASE, head, BASE);
  assert.deepEqual(e.map((x) => x.kind), ['add', 'add', 'add']);
  const [k1, k2, k3] = e.map((x) => x.key);
  // the 2nd before the 1st, in one call (applied in head order)
  const r1 = await C.applyEdits(P, BASE, head, BASE, [k2, k1]);
  assert.equal(r1.text, '# Title\n\nFirst para.\n\nA1.\n\nA2.\n\nSecond para.\n\nThird para.\n');
  // the 2nd alone, then the 1st in a later run
  const s2 = (await C.applyEdits(P, BASE, head, BASE, [k2])).text;
  const s21 = (await C.applyEdits(P, BASE, head, s2, [k1])).text;
  assert.equal(s21, r1.text);
  // 1st and 3rd, then the 2nd
  const s13 = (await C.applyEdits(P, BASE, head, BASE, [k3, k1])).text;
  assert.equal(s13, '# Title\n\nFirst para.\n\nA1.\n\nA3.\n\nSecond para.\n\nThird para.\n');
  assert.equal((await C.applyEdits(P, BASE, head, s13, [k2])).text, head);
});

test('proposalEdits: a text that does not split gives null (whole-proposal path)', async () => {
  assert.equal(await C.proposalEdits(P, 'x\r\n', 'y\n', 'x\n'), null);
});

// -------------------------------------------- overlayOnMain already-live --

test('overlayOnMain: a change main already holds is drawn as plain main, no conflict', () => {
  const head = '# Title\n\nFirst para, fixed.\n\nSecond para.\n\nThird para.\n';
  const o = C.overlayOnMain(head, BASE, head);
  assert.deepEqual(o.conflicts, []);
  assert.deepEqual([...new Set(o.overlay.map((x) => x.source))], ['main']);
});

test('overlayOnMain: an add main already holds at that anchor is skipped; a delete on both sides draws nothing', () => {
  const headAdd = '# Title\n\nFirst para.\n\nSecond para.\n\nAdded.\n\nThird para.\n';
  const o = C.overlayOnMain(headAdd, BASE, headAdd);
  assert.deepEqual(o.overlay.map((x) => x.source), ['main', 'main', 'main', 'main', 'main']);
  const headDel = '# Title\n\nFirst para.\n\nThird para.\n';
  const o2 = C.overlayOnMain(headDel, BASE, headDel);
  assert.deepEqual(o2.conflicts, []);
  assert.deepEqual(o2.overlay.map((x) => x.source), ['main', 'main', 'main']);
});

// ---------------------------------------------------------- applyEdits --

test('applyEdits: approved edits land on main; every byte outside them is unchanged', async () => {
  const main = '# Title\n\nFirst para.\n\nSecond para.\n\n\nThird para.\n\n<!-- tail -->\n';
  const head = '# Title\n\nFirst para, fixed.\n\nSecond para.\n\nThird para.\n\nA new para.\n';
  const edits = await C.proposalEdits(P, BASE, head, main);
  const keys = edits.map((x) => x.key);
  const r = await C.applyEdits(P, BASE, head, main, keys);
  assert.deepEqual(r.refused, []);
  assert.deepEqual(r.applied.sort(), keys.slice().sort());
  assert.equal(r.text, '# Title\n\nFirst para, fixed.\n\nSecond para.\n\n\nThird para.\n\nA new para.\n\n<!-- tail -->\n');
  // only the first one
  const one = await C.applyEdits(P, BASE, head, main, [keys[0]]);
  assert.equal(one.text, '# Title\n\nFirst para, fixed.\n\nSecond para.\n\n\nThird para.\n\n<!-- tail -->\n');
});

test('applyEdits: a delete takes its blank lines; an add at the top of the page', async () => {
  const head = 'Intro.\n\n# Title\n\nFirst para.\n\nThird para.\n';
  const edits = await C.proposalEdits(P, BASE, head, BASE);
  assert.deepEqual(edits.map((x) => x.kind).sort(), ['add', 'delete']);
  const r = await C.applyEdits(P, BASE, head, BASE, edits.map((x) => x.key));
  assert.equal(r.text, head);
});

test('applyEdits: unknown, live, conflict and ambiguous keys are refused by reason; nothing else moves', async () => {
  const head = '# Title\n\nFirst para, fixed.\n\nSecond para.\n\nThird para.\n';
  const main = '# Title\n\nFirst para, main\'s own fix.\n\nSecond para.\n\nThird para.\n';
  const [e] = await C.proposalEdits(P, BASE, head, main);
  const r = await C.applyEdits(P, BASE, head, main, [e.key, 'f'.repeat(64)]);
  assert.equal(r.text, main);
  assert.deepEqual(r.refused.map((x) => x.reason).sort(), ['conflict', 'stale']);
  const live = await C.applyEdits(P, BASE, head, head, [e.key]);
  assert.deepEqual(live.refused, []);
  assert.deepEqual(live.done, [e.key]);
  assert.equal(live.text, head);
});

// --------------------------------------------------- records + approvers --

const rec = (id, login, body, extra) => ({ id, user: { login }, body, created_at: '2026-10-15T00:00:00Z',
  updated_at: '2026-10-15T00:00:00Z', ...extra });
const K1 = 'a'.repeat(64);
const K2 = 'b'.repeat(64);

test('recordBody: the only text the editor ever writes as a record', () => {
  assert.equal(C.recordBody('approved', [K1, K2]), `hc-approved ${K1} ${K2}`);
  assert.equal(C.recordBody('declined', [K1]), `hc-declined ${K1}`);
  assert.throws(() => C.recordBody('approved', []));
  assert.throws(() => C.recordBody('approved', ['zz']));
  assert.throws(() => C.recordBody('merged', [K1]));
  assert.throws(() => C.recordBody('approved', Array(51).fill(K1)));
});

test('parseRecords: author by API login; edited, self-authored and malformed records ignored', () => {
  const r = C.parseRecords([
    rec(1, 'Reviewer', `hc-approved ${K1}`),
    rec(2, 'author', `hc-approved ${K2}`),                                     // the proposal's author
    rec(3, 'reviewer', `hc-approved ${K2}`, { updated_at: '2026-10-15T00:01:00Z' }), // edited
    rec(4, 'reviewer', `hc-approved ${K2} extra words`),                       // malformed
    rec(5, 'reviewer', `I said hc-approved ${K2}`),                            // not at the start
    rec(6, 'other', `hc-declined ${K2}`),
    rec(7, 'reviewer', `hc-approved ${K1.toUpperCase()}`),
  ], { author: 'Author' });
  assert.deepEqual(r.list.map((x) => [x.id, x.login, x.kind, x.keys]), [[1, 'reviewer', 'approved', [K1]], [6, 'other', 'declined', [K2]]]);
});

/* main's data/graph/edit-access.json (built by tools/build_edit_access.py; C2 shape): who can edit a project. */
const accessDoc = (editors) => ({ note: 'test', projects: {
  'learning-to-swim': { repos: 2, removed: [], editors: editors.map((login) => ({ login, why: 'commits', repos_with_commits: 1 })) },
  other: { repos: 1, editors: [], removed: [] } } });
const ACCESS_DOC = accessDoc(['kyle-nelson-berkeley']);

test('mayApproveEdit: admin anywhere; maintain or write only as an editor of the project (= CODEOWNERS); never the author', () => {
  const base = { login: 'kyle-nelson-berkeley', access: ACCESS_DOC, author: 'someone' };
  assert.equal(C.mayApproveEdit({ ...base, permission: 'admin', path: 'content/setup/x.md' }), true);
  assert.equal(C.mayApproveEdit({ ...base, permission: 'maintain', path: 'content/about.md' }), false,
    'a Maintainer who is not a code owner cannot approve on GitHub, so not through the App either');
  assert.equal(C.mayApproveEdit({ ...base, permission: 'maintain', path: P }), true);
  assert.equal(C.mayApproveEdit({ ...base, permission: 'write', path: P }), true);
  assert.equal(C.mayApproveEdit({ ...base, permission: 'write', path: 'content/projects/other.md' }), false);
  assert.equal(C.mayApproveEdit({ ...base, permission: 'write', path: 'content/setup/x.md' }), false);
  assert.equal(C.mayApproveEdit({ ...base, permission: 'write', path: P, author: 'Kyle-Nelson-Berkeley' }), false);
  assert.equal(C.mayApproveEdit({ ...base, permission: 'admin', path: P, author: 'kyle-nelson-berkeley' }), false,
    'nobody approves their own proposal edit by edit');
  assert.equal(C.mayApproveEdit({ ...base, permission: 'read', path: P }), false);
  assert.equal(C.mayApproveEdit({ ...base, permission: 'triage', path: P }), false);
  assert.equal(C.mayApproveEdit({ ...base, permission: 'write', path: P, access: null }), false, 'no access file: no');
  assert.equal(C.mayApproveEdit({ ...base, permission: 'write', path: P, access: undefined,
    projects: { projects: [{ id: 'learning-to-swim', add: ['kyle-nelson-berkeley'] }] } }), false,
  'the index\'s add list alone never trusts anyone: only the built access file does');
});

test('recordRequests: Approve all is chunked into records of at most RECORD_MAX keys, each one allowed write', () => {
  const keys = Array.from({ length: 120 }, (_, i) => sha(String(i)));
  const reqs = C.recordRequests(7, 'approved', keys);
  assert.equal(reqs.length, 3);
  assert.deepEqual(reqs.map((r) => r.body.body.split(' ').length - 1), [50, 50, 20]);
  for (const r of reqs) {
    assert.equal(r.method, 'POST');
    assert.equal(r.path, `${C.REPO_API_PATH}/issues/7/comments`);
    assert.equal(C.isAllowedWrite(r.method, r.path, r.body), true);
  }
  assert.throws(() => C.recordRequests(0, 'approved', keys));
});

test('decisions: the latest trusted record per key wins (approve then decline, and back)', () => {
  const r = C.parseRecords([
    rec(1, 'a', `hc-approved ${K1} ${K2}`, { created_at: '2026-10-15T00:00:01Z', updated_at: '2026-10-15T00:00:01Z' }),
    rec(2, 'b', `hc-declined ${K1}`, { created_at: '2026-10-15T00:00:02Z', updated_at: '2026-10-15T00:00:02Z' }),
    rec(3, 'x', `hc-approved ${K1}`, { created_at: '2026-10-15T00:00:03Z', updated_at: '2026-10-15T00:00:03Z' }), // untrusted
  ], { author: 'author' });
  const d = C.decisions(r.list, (login) => login !== 'x');
  assert.deepEqual(d.get(K1), { kind: 'declined', login: 'b', id: 2 });
  assert.deepEqual(d.get(K2), { kind: 'approved', login: 'a', id: 1 });
  const all = C.decisions(r.list, () => true);
  assert.equal(all.get(K1).kind, 'approved');
});

test('failures: trusted only from github-actions[bot] (type Bot), unedited, exact format; the body is mention-free', () => {
  const S = 'c'.repeat(40);
  const body = C.failureBody(K1, S, 'site rules: @nathalie broke `x`\nline 2');
  assert.equal(body, `hc-go-live-failed ${K1} ${S}: \`site rules: nathalie broke x line 2\``);
  const bot = { login: 'github-actions[bot]', type: 'Bot' };
  const f = C.parseFailures([
    { id: 1, user: bot, body, created_at: 't', updated_at: 't' },
    { id: 2, user: { login: 'github-actions[bot]', type: 'User' }, body: C.failureBody(K2, S, 'x'), created_at: 't', updated_at: 't' },
    { id: 3, user: { login: 'mallory', type: 'User' }, body: C.failureBody(K2, S, 'x'), created_at: 't', updated_at: 't' },
    { id: 4, user: bot, body: C.failureBody(K2, S, 'x'), created_at: 't', updated_at: 'u' },
  ]);
  assert.deepEqual([...f.keys()], [K1]);
  assert.deepEqual(f.get(K1), [{ sha: S, reason: 'site rules: nathalie broke x line 2' }]);
  assert.throws(() => C.failureBody('zz', S, 'x'));
});

// ------------------------------------------------- the engine (tools/go_live.mjs) --

const ENGINE = await import(path.join(ROOT, 'tools', 'go_live.mjs'));
const REPO = 'desert-mango/hippocampus-docs';
const RA = `/repos/${REPO}`;
const ACCESS_TEXT = JSON.stringify(ACCESS_DOC);
const HEAD1 = '1'.repeat(40);
const BASE1 = '0'.repeat(40);
const SETUP = 'content/setup/a.md';

/* A fake GitHub: open PRs with files, comments, commits and texts by sha; collaborators' role_name. */
function fakeWorld(o) {
  const posted = [];
  const patched = [];
  const pulls = o.pulls;
  const roles = Object.assign({ 'kyle-nelson-berkeley': 'write', 'desert-mango-robotics': 'admin', mallory: 'read' }, o.roles || {});
  const api = {
    async get(p) {
      const u = new URL(`https://x${p}`);
      const q = u.pathname.slice(RA.length);
      const page = Number(u.searchParams.get('page') || 1);
      const one = (data) => ({ status: 200, data: page === 1 ? data : [] });
      if (q === '/pulls') return one(pulls.map((x) => x.pull));
      let m;
      if ((m = /^\/pulls\/(\d+)\/files$/.exec(q))) return one(pulls.find((x) => x.pull.number === +m[1]).files);
      if ((m = /^\/pulls\/(\d+)\/commits$/.exec(q))) return one(pulls.find((x) => x.pull.number === +m[1]).commits || []);
      if ((m = /^\/issues\/(\d+)\/comments$/.exec(q))) return one(pulls.find((x) => x.pull.number === +m[1]).comments);
      if ((m = /^\/collaborators\/([^/]+)\/permission$/.exec(q))) {
        const r = roles[decodeURIComponent(m[1])];
        return r ? { status: 200, data: { permission: r === 'maintain' ? 'write' : r, role_name: r } } : { status: 404, data: null };
      }
      if ((m = /^\/compare\/main\.\.\.([0-9a-f]{40})$/.exec(q))) return { status: 200, data: { merge_base_commit: { sha: BASE1 } } };
      throw new Error(`unexpected GET ${p}`);
    },
    async getRaw(p) {
      const u = new URL(`https://x${p}`);
      const file = decodeURIComponent(u.pathname.slice(`${RA}/contents/`.length));
      const t = (o.texts[u.searchParams.get('ref')] || {})[file];
      return t === undefined ? { status: 404, text: '' } : { status: 200, text: t };
    },
    async post(p, body) { posted.push({ p: p.slice(RA.length), body }); return { status: 201, data: {} }; },
    async patch(p, body) { patched.push({ p: p.slice(RA.length), body }); return { status: 200, data: {} }; },
  };
  const files = Object.assign({ [ENGINE.ACCESS_FILE]: ACCESS_TEXT }, o.main);
  const fs = {
    read: async (f) => (f in files ? files[f] : null),
    write: async (f, t) => { files[f] = t; },
  };
  return { api, fs, files, posted, patched };
}

const pr = (n, o) => ({
  pull: { number: n, draft: false, state: 'open', user: { login: o.author || 'someone', id: 99 },
    head: { ref: o.ref || `cms/someone/x-${n}`, sha: o.head || HEAD1, repo: { full_name: o.repo || REPO } } },
  files: o.files.map((f) => ({ filename: f, status: 'modified' })),
  commits: o.commits || [{ author: { login: o.author || 'someone' }, committer: { login: 'web-flow' } }],
  comments: o.comments || [],
});

const greenGate = async () => ({ ok: true, finding: '' });

test('engine: an editor\'s record on their project page goes live; the plan names the author; nothing else moves', async () => {
  const head = '# Title\n\nFirst para, fixed.\n\nSecond para.\n\nThird para.\n';
  const [e] = await C.proposalEdits(P, BASE, head, BASE);
  const w = fakeWorld({
    pulls: [pr(7, { files: [P], comments: [rec(1, 'kyle-nelson-berkeley', `hc-approved ${e.key}`)] })],
    texts: { [BASE1]: { [P]: BASE }, [HEAD1]: { [P]: head } }, main: { [P]: BASE },
  });
  const out = await ENGINE.sweep({ api: w.api, repo: REPO, fs: w.fs, gate: greenGate });
  assert.equal(w.files[P], head);
  assert.deepEqual(out.groups.map((g) => [g.pr, g.path, g.applied.length]), [[7, P, 1]]);
  assert.equal(out.groups[0].author.login, 'someone');
  assert.deepEqual(w.posted, [], 'no failure, no comment');
  const plan = ENGINE.commitPlan(out.groups);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].author_email, '99+someone@users.noreply.github.com');
  assert.deepEqual(plan[0].files, [P]);
  assert.match(plan[0].message, /^go-live: content\/projects\/learning-to-swim\.md \(1 change from #7, approved by kyle-nelson-berkeley\)/);
});

test('engine: untrusted records change nothing (not an editor, read role, the author, a committer, a fork, a draft, not cms/)', async () => {
  const head = '# Title\n\nFirst para, fixed.\n\nSecond para.\n\nThird para.\n';
  const kp = (await C.proposalEdits(P, BASE, head, BASE))[0].key;
  const ks = (await C.proposalEdits(SETUP, BASE, head, BASE))[0].key;
  const w = fakeWorld({
    pulls: [
      pr(1, { files: [SETUP], comments: [rec(1, 'kyle-nelson-berkeley', `hc-approved ${ks}`)] }),     // not an editor of setup
      pr(2, { files: [P], comments: [rec(2, 'mallory', `hc-approved ${kp}`)] }),                       // read role
      pr(3, { files: [P], author: 'kyle-nelson-berkeley', comments: [rec(3, 'kyle-nelson-berkeley', `hc-approved ${kp}`)] }),
      pr(4, { files: [P], commits: [{ author: { login: 'someone' } }, { author: { login: 'kyle-nelson-berkeley' } }],
        comments: [rec(4, 'kyle-nelson-berkeley', `hc-approved ${kp}`)] }),                            // pushed into the PR
      pr(5, { files: [P], repo: 'mallory/fork', comments: [rec(5, 'desert-mango-robotics', `hc-approved ${kp}`)] }),
      { ...pr(6, { files: [P], comments: [rec(6, 'desert-mango-robotics', `hc-approved ${kp}`)] }), pull: { ...pr(6, { files: [P] }).pull, draft: true } },
      pr(8, { files: [P], ref: 'feature/x', comments: [rec(8, 'desert-mango-robotics', `hc-approved ${kp}`)] }),
      pr(9, { files: [P, 'data/projects.json'], comments: [rec(9, 'desert-mango-robotics', `hc-approved ${kp}`)] }), // mixed PR
    ],
    texts: { [BASE1]: { [P]: BASE, [SETUP]: BASE }, [HEAD1]: { [P]: head, [SETUP]: head } }, main: { [P]: BASE, [SETUP]: BASE },
  });
  const out = await ENGINE.sweep({ api: w.api, repo: REPO, fs: w.fs, gate: greenGate });
  assert.deepEqual(out.groups, []);
  assert.equal(w.files[P], BASE);
  assert.equal(w.files[SETUP], BASE);
  assert.deepEqual(w.posted, []);
});

test('engine: a red main stops the run before anything is applied or posted', async () => {
  const head = '# Title\n\nFirst para, fixed.\n\nSecond para.\n\nThird para.\n';
  const [e] = await C.proposalEdits(P, BASE, head, BASE);
  const w = fakeWorld({
    pulls: [pr(7, { files: [P], comments: [rec(1, 'desert-mango-robotics', `hc-approved ${e.key}`)] })],
    texts: { [BASE1]: { [P]: BASE }, [HEAD1]: { [P]: head } }, main: { [P]: BASE },
  });
  await assert.rejects(ENGINE.sweep({ api: w.api, repo: REPO, fs: w.fs, gate: async () => ({ ok: false, finding: 'x' }) }), /main is red/);
  assert.equal(w.files[P], BASE);
  assert.deepEqual(w.posted, []);
});

test('engine: a group that turns the gate red is dropped with a mention-free failure record; the others still go', async () => {
  const P2 = 'content/projects/learning-to-swim-b.md';
  const headA = '# Title\n\nFirst para, fixed.\n\nSecond para.\n\nThird para.\n';
  const headB = '# Title\n\nFirst para, broken @nathalie.\n\nSecond para.\n\nThird para.\n';
  const kA = (await C.proposalEdits(P, BASE, headA, BASE))[0].key;
  const kB = (await C.proposalEdits(P2, BASE, headB, BASE))[0].key;
  const w = fakeWorld({
    pulls: [pr(7, { files: [P], comments: [rec(1, 'desert-mango-robotics', `hc-approved ${kA}`)] }),
      pr(8, { files: [P2], head: '2'.repeat(40), comments: [rec(2, 'desert-mango-robotics', `hc-approved ${kB}`)] })],
    texts: { [BASE1]: { [P]: BASE, [P2]: BASE }, [HEAD1]: { [P]: headA }, ['2'.repeat(40)]: { [P2]: headB } },
    main: { [P]: BASE, [P2]: BASE },
  });
  const gate = async () => (String(w.files[P2]).includes('broken') ? { ok: false, finding: 'content: @x broken `link`' } : { ok: true, finding: '' });
  const out = await ENGINE.sweep({ api: w.api, repo: REPO, fs: w.fs, gate });
  assert.deepEqual(out.groups.map((g) => g.pr), [7]);
  assert.equal(w.files[P], headA);
  assert.equal(w.files[P2], BASE, 'the red group is put back');
  assert.deepEqual(w.posted, [{ p: '/issues/8/comments', body: { body: C.failureBody(kB, '2'.repeat(40), 'site rules: content: x broken link') } }]);
  // the next sweep (same head) neither retries nor posts again
  w.pulls = null;
  const again = fakeWorld({
    pulls: [pr(8, { files: [P2], head: '2'.repeat(40), comments: [rec(2, 'desert-mango-robotics', `hc-approved ${kB}`),
      { id: 3, user: { login: 'github-actions[bot]', type: 'Bot' }, body: w.posted[0].body.body, created_at: 't', updated_at: 't' }] })],
    texts: { [BASE1]: { [P2]: BASE }, ['2'.repeat(40)]: { [P2]: headB } }, main: { [P2]: BASE },
  });
  let gates = 0;
  const out2 = await ENGINE.sweep({ api: again.api, repo: REPO, fs: again.fs, gate: async () => { gates += 1; return { ok: true, finding: '' }; } });
  assert.deepEqual(out2.groups, []);
  assert.deepEqual(again.posted, []);
  assert.equal(gates, 0, 'nothing to apply: not even the main gate runs (no idle work)');
});

test('engine: a declined record wins over an earlier approval; dry-run writes and posts nothing', async () => {
  const head = '# Title\n\nFirst para, fixed.\n\nSecond para.\n\nThird para.\n';
  const [e] = await C.proposalEdits(P, BASE, head, BASE);
  const w = fakeWorld({
    pulls: [pr(7, { files: [P], comments: [
      rec(1, 'desert-mango-robotics', `hc-approved ${e.key}`, { created_at: '2026-10-15T00:00:01Z', updated_at: '2026-10-15T00:00:01Z' }),
      rec(2, 'desert-mango-robotics', `hc-declined ${e.key}`, { created_at: '2026-10-15T00:00:02Z', updated_at: '2026-10-15T00:00:02Z' })] })],
    texts: { [BASE1]: { [P]: BASE }, [HEAD1]: { [P]: head } }, main: { [P]: BASE },
  });
  assert.deepEqual((await ENGINE.sweep({ api: w.api, repo: REPO, fs: w.fs, gate: greenGate })).groups, []);
  const w2 = fakeWorld({
    pulls: [pr(7, { files: [P], comments: [rec(1, 'desert-mango-robotics', `hc-approved ${e.key}`)] })],
    texts: { [BASE1]: { [P]: BASE }, [HEAD1]: { [P]: head } }, main: { [P]: BASE },
  });
  const dry = await ENGINE.sweep({ api: w2.api, repo: REPO, fs: w2.fs, gate: greenGate, dryRun: true });
  assert.equal(dry.groups.length, 1);
  assert.equal(w2.files[P], BASE);
  assert.deepEqual(w2.posted, []);
});

test('closeDone: closes a PR whose every edit is live or declined and that has a trusted record; never otherwise', async () => {
  const head = '# Title\n\nFirst para, fixed.\n\nSecond para.\n\nThird para, too.\n';
  const [e1, e2] = await C.proposalEdits(P, BASE, head, BASE);
  const mainNow = '# Title\n\nFirst para, fixed.\n\nSecond para.\n\nThird para.\n';   // e1 live, e2 open
  const mk = (comments) => fakeWorld({ pulls: [pr(7, { files: [P], comments })],
    texts: { [BASE1]: { [P]: BASE }, [HEAD1]: { [P]: head } }, main: { [P]: mainNow } });
  const open = mk([rec(1, 'desert-mango-robotics', `hc-approved ${e1.key}`)]);
  assert.deepEqual(await ENGINE.closeDone({ api: open.api, repo: REPO, fs: open.fs }), []);
  const done = mk([rec(1, 'desert-mango-robotics', `hc-approved ${e1.key}`), rec(2, 'desert-mango-robotics', `hc-declined ${e2.key}`)]);
  assert.deepEqual(await ENGINE.closeDone({ api: done.api, repo: REPO, fs: done.fs }), [7]);
  assert.deepEqual(done.patched, [{ p: '/pulls/7', body: { state: 'closed' } }]);
  assert.equal(done.posted[0].body.body, 'Everything here is live (or declined).');
  const untrusted = mk([rec(1, 'mallory', `hc-declined ${e2.key}`)]);
  assert.deepEqual(await ENGINE.closeDone({ api: untrusted.api, repo: REPO, fs: untrusted.fs }), []);
});

/* Edit access (2026-10-19): go-live reads main's data/graph/edit-access.json AFTER its first gate, because
   that gate's derive run rebuilds it from main's own inputs. A copy from before the gate is never used. */
test('engine: access is read after the first gate (fresh), never before it', async () => {
  const head = '# Title\n\nFirst para, fixed.\n\nSecond para.\n\nThird para.\n';
  const [e] = await C.proposalEdits(P, BASE, head, BASE);
  const world = (before) => fakeWorld({
    pulls: [pr(7, { files: [P], comments: [rec(1, 'kyle-nelson-berkeley', `hc-approved ${e.key}`)] })],
    texts: { [BASE1]: { [P]: BASE }, [HEAD1]: { [P]: head } }, main: { [P]: BASE, [ENGINE.ACCESS_FILE]: before } });
  // stale main lists nobody; the gate's derive writes the fresh file that lists the reviewer: it goes live
  const w = world(JSON.stringify(accessDoc([])));
  let gates = 0;
  const fresh = async () => { gates += 1; if (gates === 1) w.files[ENGINE.ACCESS_FILE] = ACCESS_TEXT; return { ok: true, finding: '' }; };
  const out = await ENGINE.sweep({ api: w.api, repo: REPO, fs: w.fs, gate: fresh });
  assert.deepEqual(out.groups.map((g) => g.pr), [7]);
  assert.equal(w.files[P], head);
  // and the other way round: stale main lists the reviewer, the fresh file does not: nothing goes live
  const w2 = world(ACCESS_TEXT);
  let g2 = 0;
  const gone = async () => { g2 += 1; if (g2 === 1) w2.files[ENGINE.ACCESS_FILE] = JSON.stringify(accessDoc([])); return { ok: true, finding: '' }; };
  const out2 = await ENGINE.sweep({ api: w2.api, repo: REPO, fs: w2.fs, gate: gone });
  assert.deepEqual(out2.groups, []);
  assert.equal(w2.files[P], BASE);
  assert.equal(g2, 1, 'the gate ran once (on untouched main), then nothing to apply');
  // no access file at all: only an admin's record is trusted
  const w3 = world(undefined);
  delete w3.files[ENGINE.ACCESS_FILE];
  assert.deepEqual((await ENGINE.sweep({ api: w3.api, repo: REPO, fs: w3.fs, gate: greenGate })).groups, []);
  const w4 = fakeWorld({
    pulls: [pr(7, { files: [P], comments: [rec(1, 'desert-mango-robotics', `hc-approved ${e.key}`)] })],
    texts: { [BASE1]: { [P]: BASE }, [HEAD1]: { [P]: head } }, main: { [P]: BASE } });
  delete w4.files[ENGINE.ACCESS_FILE];
  assert.deepEqual((await ENGINE.sweep({ api: w4.api, repo: REPO, fs: w4.fs, gate: greenGate })).groups.map((g) => g.pr), [7]);
});

test('engine: an approval followed by a decline from someone who may not approve still goes live (candidates are a superset)', async () => {
  const head = '# Title\n\nFirst para, fixed.\n\nSecond para.\n\nThird para.\n';
  const [e] = await C.proposalEdits(P, BASE, head, BASE);
  const w = fakeWorld({
    pulls: [pr(7, { files: [P], comments: [
      rec(1, 'desert-mango-robotics', `hc-approved ${e.key}`, { created_at: '2026-10-15T00:00:01Z', updated_at: '2026-10-15T00:00:01Z' }),
      rec(2, 'writer-two', `hc-declined ${e.key}`, { created_at: '2026-10-15T00:00:02Z', updated_at: '2026-10-15T00:00:02Z' })] })],
    texts: { [BASE1]: { [P]: BASE }, [HEAD1]: { [P]: head } }, main: { [P]: BASE }, roles: { 'writer-two': 'write' } });
  assert.deepEqual((await ENGINE.sweep({ api: w.api, repo: REPO, fs: w.fs, gate: greenGate })).groups.map((g) => g.pr), [7],
    'writer-two is not an editor of the project, so its decline does not count');
});

test('engine: approvals all declined later by an admin run no gate; a newer approval after the decline still does', async () => {
  const head = '# Title\n\nFirst para, fixed.\n\nSecond para.\n\nThird para.\n';
  const [e] = await C.proposalEdits(P, BASE, head, BASE);
  const t = (s) => ({ created_at: `2026-10-15T00:00:0${s}Z`, updated_at: `2026-10-15T00:00:0${s}Z` });
  const world = (comments) => fakeWorld({ pulls: [pr(7, { files: [P], comments })],
    texts: { [BASE1]: { [P]: BASE }, [HEAD1]: { [P]: head } }, main: { [P]: BASE }, roles: { 'writer-two': 'write' } });
  const counting = () => { const g = async () => { g.n += 1; return { ok: true, finding: '' }; }; g.n = 0; return g; };
  // an editor's and a writer's approvals, then an admin's decline: nothing can go live, so no gate at all
  let w = world([rec(1, 'kyle-nelson-berkeley', `hc-approved ${e.key}`, t(1)), rec(2, 'writer-two', `hc-approved ${e.key}`, t(2)),
    rec(3, 'desert-mango-robotics', `hc-declined ${e.key}`, t(3))]);
  let gate = counting();
  assert.deepEqual((await ENGINE.sweep({ api: w.api, repo: REPO, fs: w.fs, gate })).groups, []);
  assert.equal(gate.n, 0, 'declined by an admin after every approval: no gate');
  // a writer's decline is not enough to skip (it may not count): the gate runs, the editor's approval goes live
  w = world([rec(1, 'kyle-nelson-berkeley', `hc-approved ${e.key}`, t(1)), rec(2, 'writer-two', `hc-declined ${e.key}`, t(2))]);
  gate = counting();
  assert.deepEqual((await ENGINE.sweep({ api: w.api, repo: REPO, fs: w.fs, gate })).groups.map((g) => g.pr), [7]);
  assert.ok(gate.n >= 1);
  // an approval newer than the admin's decline: the gate runs and it goes live
  w = world([rec(1, 'desert-mango-robotics', `hc-declined ${e.key}`, t(1)), rec(2, 'kyle-nelson-berkeley', `hc-approved ${e.key}`, t(2))]);
  gate = counting();
  assert.deepEqual((await ENGINE.sweep({ api: w.api, repo: REPO, fs: w.fs, gate })).groups.map((g) => g.pr), [7]);
});

test('closeDone: reads main\'s edit-access.json for trust', async () => {
  const head = '# Title\n\nFirst para, fixed.\n\nSecond para.\n\nThird para.\n';
  const [e] = await C.proposalEdits(P, BASE, head, BASE);
  const mk = (access) => {
    const w = fakeWorld({ pulls: [pr(7, { files: [P], comments: [rec(1, 'kyle-nelson-berkeley', `hc-declined ${e.key}`)] })],
      texts: { [BASE1]: { [P]: BASE }, [HEAD1]: { [P]: head } }, main: { [P]: BASE } });
    w.files[ENGINE.ACCESS_FILE] = access;
    return w;
  };
  const yes = mk(ACCESS_TEXT);
  assert.deepEqual(await ENGINE.closeDone({ api: yes.api, repo: REPO, fs: yes.fs }), [7], 'an editor declined the one edit');
  const no = mk(JSON.stringify(accessDoc([])));
  assert.deepEqual(await ENGINE.closeDone({ api: no.api, repo: REPO, fs: no.fs }), [], 'not an editor: the record is not trusted');
});

test('strayPaths: the plan\'s pages and the derived outputs (search/, data/graph/, .github/CODEOWNERS); nothing else', () => {
  const plan = [{ files: [P] }];
  assert.deepEqual(ENGINE.strayPaths([P, 'search/site.json', 'data/graph/edit-access.json', '.github/CODEOWNERS'], plan), []);
  assert.deepEqual(ENGINE.strayPaths(['.github/workflows/check.yml', '.github/CODEOWNERS.bak', '.github/codeowners',
    'CODEOWNERS', 'docs/CODEOWNERS', 'data/projects.json', 'content/about.md'], plan),
  ['.github/workflows/check.yml', '.github/CODEOWNERS.bak', '.github/codeowners', 'CODEOWNERS', 'docs/CODEOWNERS',
    'data/projects.json', 'content/about.md']);
});

test('commitAll: a stale main (edit-access.json and CODEOWNERS behind their inputs): the derive commit carries both', async () => {
  const calls = [];
  const written = {};
  const status = [` M ${P}`, ' M data/graph/edit-access.json', ' M .github/CODEOWNERS', '?? search/shard-1.json'].join('\n') + '\n';
  const io = {
    git: (args) => { calls.push(args); return args[0] === 'status' ? status : ''; },
    ok: (args) => { calls.push(['ok', ...args]); return false; },                       // something is staged
    write: async (p, t) => { written[p] = t; },
  };
  const plan = [{ author_name: 'someone', author_email: '99+someone@users.noreply.github.com', files: [P], texts: { [P]: 'new\n' }, message: 'go-live: x' }];
  assert.equal(await ENGINE.commitAll(plan, io), 1);
  assert.deepEqual(written, { [P]: 'new\n' });
  assert.deepEqual(calls.slice(1), [
    ['add', '--', P],
    ['commit', '-q', '--author', 'someone <99+someone@users.noreply.github.com>', '-m', 'go-live: x'],
    ['add', '-A', '--', 'search', 'data/graph', '.github/CODEOWNERS'],
    ['ok', 'diff', '--cached', '--quiet'],
    ['commit', '-q', '-m', 'derive: regenerate derived data after go-live'],
  ]);
  // anything outside the plan stops the commit before any write
  const bad = { git: (args) => (args[0] === 'status' ? ' M .github/workflows/go-live.yml\n' : ''), ok: () => true, write: async () => { throw new Error('no'); } };
  await assert.rejects(ENGINE.commitAll(plan, bad), /outside the plan: \.github\/workflows\/go-live\.yml/);
});

test('keys do not move when main moves: edit 1 goes live, edit 2 keeps its key (base = the merge base)', async () => {
  const head = '# Title\n\nFirst para, fixed.\n\nSecond para.\n\nThird para.\n\nA1.\n\nA2.\n';
  const before = await C.proposalEdits(P, BASE, head, BASE);
  const r = await C.applyEdits(P, BASE, head, BASE, [before[1].key]);
  const after = await C.proposalEdits(P, BASE, head, r.text);
  assert.deepEqual(after.map((e) => e.key), before.map((e) => e.key));
  assert.deepEqual(after.map((e) => e.state), ['open', 'live', 'open']);
});

test('engine: two proposals on one page make two commits, each with the page as its group left it', async () => {
  const headA = '# Title\n\nFirst para, fixed.\n\nSecond para.\n\nThird para.\n';
  const headB = '# Title\n\nFirst para.\n\nSecond para.\n\nThird para, too.\n';
  const kA = (await C.proposalEdits(P, BASE, headA, BASE))[0].key;
  const kB = (await C.proposalEdits(P, BASE, headB, BASE))[0].key;
  const H2 = '2'.repeat(40);
  const w = fakeWorld({
    pulls: [pr(7, { files: [P], comments: [rec(1, 'desert-mango-robotics', `hc-approved ${kA}`)] }),
      pr(8, { files: [P], head: H2, author: 'other', comments: [rec(2, 'desert-mango-robotics', `hc-approved ${kB}`)] })],
    texts: { [BASE1]: { [P]: BASE }, [HEAD1]: { [P]: headA }, [H2]: { [P]: headB } }, main: { [P]: BASE },
  });
  const out = await ENGINE.sweep({ api: w.api, repo: REPO, fs: w.fs, gate: greenGate });
  const both = '# Title\n\nFirst para, fixed.\n\nSecond para.\n\nThird para, too.\n';
  assert.equal(w.files[P], both);
  const plan = ENGINE.commitPlan(out.groups);
  assert.deepEqual(plan.map((c) => [c.author_name, c.texts[P]]), [['someone', headA], ['other', both]]);
});

// ------------------------------------------------ U5b: the review rail's data (pure) --

test('proposalEligible: per-edit review only for a cms/ proposal of this repository, not a draft, page edits only', () => {
  const pull = { draft: false, state: 'open', head: { ref: 'cms/a/x', repo: { full_name: REPO } } };
  const rows = [{ filename: P, status: 'modified' }];
  assert.equal(C.proposalEligible(pull, rows), true);
  assert.equal(C.proposalEligible({ ...pull, draft: true }, rows), false);
  assert.equal(C.proposalEligible({ ...pull, head: { ...pull.head, ref: 'feature/x' } }, rows), false);
  assert.equal(C.proposalEligible({ ...pull, head: { ...pull.head, repo: { full_name: 'm/fork' } } }, rows), false);
  assert.equal(C.proposalEligible(pull, [...rows, { filename: 'data/projects.json', status: 'modified' }]), false);
  assert.equal(C.proposalEligible(pull, [{ filename: 'content/setup/new.md', status: 'added' }]), false);
  assert.equal(C.proposalEligible(pull, null), false);
});

test('proposalEdits: each edit names its head block (adds and changes) for the page anchors', async () => {
  const head = '# Title\n\nFirst para, fixed.\n\nSecond para.\n\nThird para.\n\nA new para.\n';
  const e = await C.proposalEdits(P, BASE, head, BASE);
  const H = C.splitBlocks(head).blocks;
  for (const x of e) assert.equal(H[x.headIndex].text.trim(), x.head);
});

test('reviewCards: one card per edit at its overlay entry; states from records, failures and main', async () => {
  const head = '# Title\n\nFirst para, fixed.\n\nSecond para.\n\nThird para.\n\nA new para.\n';
  const edits = await C.proposalEdits(P, BASE, head, BASE);
  const ov = C.overlayOnMain(BASE, BASE, head);
  const [kc, ka] = edits.map((x) => x.key);
  const S = HEAD1;
  const comments = [rec(1, 'desert-mango-robotics', `hc-approved ${kc}`),
    { id: 2, user: { login: 'github-actions[bot]', type: 'Bot' }, body: C.failureBody(ka, S, 'site rules: x'), created_at: 't', updated_at: 't' }];
  const cards = C.reviewCards({ edits, overlay: ov.overlay, comments, author: 'someone', headSha: S,
    trusted: () => true, may: () => true, eligible: true, pending: new Set() });
  assert.deepEqual(cards.map((c) => [c.kind, c.state, c.canAct]), [['change', 'going', false], ['add', 'failed', true]]);
  assert.equal(ov.overlay[cards[0].anchor].source, 'pr-del', 'a change is anchored at its old block');
  assert.equal(ov.overlay[cards[1].anchor].source, 'pr-add');
  assert.equal(cards[1].reason, 'site rules: x');
  assert.equal(cards[0].by, 'desert-mango-robotics');
  // an untrusted approval leaves the card waiting; a page reader (may: false) gets no buttons
  const c2 = C.reviewCards({ edits, overlay: ov.overlay, comments: [rec(1, 'mallory', `hc-approved ${kc}`)], author: 'someone',
    headSha: S, trusted: (l) => l !== 'mallory', may: () => false, eligible: true, pending: new Set() });
  assert.deepEqual(c2.map((c) => [c.state, c.canAct]), [['waiting', false], ['waiting', false]]);
  // not eligible: every card says so and offers nothing
  const c3 = C.reviewCards({ edits, overlay: ov.overlay, comments: [], author: 'someone', headSha: S,
    trusted: () => true, may: () => true, eligible: false, pending: new Set() });
  assert.deepEqual([...new Set(c3.map((c) => `${c.state}:${c.canAct}`))], ['whole:false']);
  // a key the browser just recorded is "going" before GitHub lists the comment
  const c4 = C.reviewCards({ edits, overlay: ov.overlay, comments: [], author: 'someone', headSha: S,
    trusted: () => true, may: () => true, eligible: true, pending: new Map([[ka, 'approved']]) });
  assert.equal(c4[1].state, 'going');
  // live and declined
  const live = await C.proposalEdits(P, BASE, head, head);
  const c5 = C.reviewCards({ edits: live, overlay: C.overlayOnMain(head, BASE, head).overlay, comments: [], author: 'someone',
    headSha: S, trusted: () => true, may: () => true, eligible: true, pending: new Set() });
  assert.deepEqual(c5.map((c) => [c.state, c.anchor]), [['live', null], ['live', null]]);
  const c6 = C.reviewCards({ edits, overlay: ov.overlay, comments: [rec(3, 'desert-mango-robotics', `hc-declined ${kc}`)],
    author: 'someone', headSha: S, trusted: () => true, may: () => true, eligible: true, pending: new Set() });
  assert.deepEqual([c6[0].state, c6[0].acts], ['declined', ['approve']], 'a Reject can be undone by approving');
  // this tab's own reversal shows before GitHub lists it (codex U5b r2)
  const c7 = C.reviewCards({ edits, overlay: ov.overlay, comments: [rec(3, 'desert-mango-robotics', `hc-declined ${kc}`)],
    author: 'someone', headSha: S, trusted: () => true, may: () => true, eligible: true, pending: new Map([[kc, 'approved']]) });
  assert.equal(c7[0].state, 'going');
  const c8 = C.reviewCards({ edits, overlay: ov.overlay, comments: [rec(3, 'desert-mango-robotics', `hc-approved ${kc}`)],
    author: 'someone', headSha: S, trusted: () => true, may: () => true, eligible: true, pending: new Map([[kc, 'declined']]) });
  assert.equal(c8[0].state, 'declined');
});

test('cardText: the change in words, clipped, plain text', () => {
  const t = C.cardText('change', 'Old words.', 'New words.');
  assert.deepEqual(t, { verb: 'Replace', from: 'Old words.', to: 'New words.' });
  assert.deepEqual(C.cardText('add', '', '## A **bold** title'), { verb: 'Add', from: '', to: 'A bold title' });
  assert.deepEqual(C.cardText('delete', 'Gone.', ''), { verb: 'Delete', from: 'Gone.', to: '' });
  assert.ok(C.cardText('add', '', 'x'.repeat(500)).to.length <= 161);
  // code and snake_case survive; real tags and a note box's title read as words
  assert.equal(C.cardText('change', 'x', 'Files in `gantry/config/motor_<axis_name>.yaml` and my_var.').to,
    'Files in gantry/config/motor_<axis_name>.yaml and my_var.');
  assert.equal(C.cardText('add', '', '<div class="adm adm-note"><p class="adm-title">Note</p>\n\nKeep *this* _short_.\n\n</div>').to,
    'Note: Keep this short.');
});

test('railLayout: cards keep their order, never overlap, the active card sits on its line and the others step aside', () => {
  const cards = [{ key: 'a', want: 100, height: 80 }, { key: 'b', want: 120, height: 80 }, { key: 'c', want: 400, height: 60 }];
  const t = C.railLayout(cards, null, 8);
  assert.deepEqual(t, { a: 100, b: 188, c: 400 });
  const act = C.railLayout(cards, 'b', 8);
  assert.equal(act.b, 120, 'the active card on its own line');
  assert.ok(act.a + 80 + 8 <= act.b, 'the one above stepped up');
  assert.equal(act.c, 400);
  const tight = C.railLayout([{ key: 'a', want: 0, height: 50 }, { key: 'b', want: 10, height: 50 }, { key: 'c', want: 20, height: 50 }], 'c', 8);
  assert.ok(tight.a + 58 <= tight.b && tight.b + 58 <= tight.c && tight.c === 20);
});

test('reviewActionsFor: Merge is gone once a proposal has an edit-by-edit record (declined edits must not come back)', () => {
  const role = { key: 'admin', canPush: true };
  const pull = { state: 'open', user: { login: 'someone' } };
  assert.ok(C.reviewActionsFor(role, pull, {}).includes('merge'));
  assert.ok(!C.reviewActionsFor(role, pull, { hasRecords: true }).includes('merge'));
});

test('runRecord: sends each chunk through the one-repo client and says what came of it', async () => {
  const sent = [];
  const client = { send: async (m, p, o) => { sent.push([m, p, o.body.body.split(' ').length - 1]); return { ok: true, status: 201, data: {} }; } };
  const keys = Array.from({ length: 60 }, (_, i) => sha(`k${i}`));
  const out = await C.runRecord(client, 7, 'approved', keys);
  assert.deepEqual(out, { ok: true, status: 201, message: 'Approved. Going live in about a minute.', sent: true, done: keys });
  // the second chunk fails: the first 50 are recorded, and the answer says so (codex U5b r1)
  let calls = 0;
  const half = await C.runRecord({ send: async () => { calls += 1; if (calls > 1) throw new Error('offline'); return { ok: true, status: 201, data: {} }; } }, 7, 'approved', keys);
  assert.equal(half.ok, false);
  assert.deepEqual(half.done, keys.slice(0, 50));
  assert.match(half.message, /50 of 60 were recorded before that/);
  assert.deepEqual(sent.map((x) => x[2]), [50, 10]);
  const no = await C.runRecord({ send: async () => ({ ok: false, status: 403, data: { message: 'Resource not accessible' } }) }, 7, 'declined', [K1]);
  assert.equal(no.ok, false);
  assert.match(no.message, /GitHub says you may not do this: Resource not accessible/);
  const bad = await C.runRecord(client, 7, 'approved', []);
  assert.deepEqual([bad.ok, bad.sent], [false, false]);
});
