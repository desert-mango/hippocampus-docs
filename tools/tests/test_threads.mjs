// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 15 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test conversations on a suggested change: the comment and reply writes, the GraphQL door, thread mapping.
/* Unit tests for the U6 half of js/cms-core.js (plan-final §7 "Threads", plan-u5 U6):

     editLines        an edit's first line in the file GitHub's review comments name (RIGHT: the
                      proposal's head; LEFT: its merge base, for a deleted block)
     threadsByEdit    the proposal's review comments grouped into conversations, each on its edit
     threadRequest / replyRequest   the two REST writes, allowlisted with their body checked
     graphqlRequest   the ONE GraphQL door: three literal operations, variables checked

     node --test tools/tests/test_threads.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const C = require(path.join(ROOT, 'js', 'cms-core.js'));
const R = C.REPO_API_PATH;
const P = 'content/projects/learning-to-swim.md';
const BASE = '# Title\n\nFirst para.\n\nSecond para.\n\nThird para.\n';
const HEAD = '# Title\n\nFirst para, fixed.\n\nSecond para.\n\nA new para\nover two lines.\n\nThird para.\n';
const SHA = 'a'.repeat(40);

test('editLines: a change and an add on the head\'s lines (RIGHT); a delete on the base\'s (LEFT)', async () => {
  const edits = await C.proposalEdits(P, BASE, HEAD, BASE);
  const lines = edits.map((e) => C.editLines(e, BASE, HEAD));
  assert.deepEqual(lines, [{ side: 'RIGHT', line: 3, last: 3 }, { side: 'RIGHT', line: 7, last: 8 }]);
  const del = await C.proposalEdits(P, BASE, '# Title\n\nFirst para.\n\nThird para.\n', BASE);
  assert.deepEqual(C.editLines(del[0], BASE, '# Title\n\nFirst para.\n\nThird para.\n'), { side: 'LEFT', line: 5, last: 5 });
});

const rc = (id, o) => Object.assign({ id, path: P, side: 'RIGHT', line: 3, body: 'x', user: { login: 'a' },
  created_at: `2026-10-15T00:00:0${id}Z`, in_reply_to_id: undefined }, o);

test('threadsByEdit: a conversation sits on the edit whose lines hold its first comment; replies follow; older ones apart', async () => {
  const edits = await C.proposalEdits(P, BASE, HEAD, BASE);
  const comments = [rc(1, { body: 'Why "fixed"?' }), rc(2, { in_reply_to_id: 1, body: 'Typo.' }), rc(3, { line: 8, body: 'Two lines?' }),
    rc(4, { line: null, original_line: 3, body: 'On an older version' }), rc(5, { path: 'content/about.md', line: 3 }),
    rc(6, { side: 'LEFT', line: 3 })];
  const t = C.threadsByEdit(comments, edits, BASE, HEAD, P);
  assert.deepEqual([...t.byKey.keys()], [edits[0].key, edits[1].key]);
  assert.deepEqual(t.byKey.get(edits[0].key)[0].comments.map((c) => c.body), ['Why "fixed"?', 'Typo.']);
  assert.equal(t.byKey.get(edits[0].key)[0].rootId, 1);
  assert.deepEqual(t.byKey.get(edits[1].key)[0].comments.map((c) => c.body), ['Two lines?']);
  assert.deepEqual(t.other.map((x) => x.rootId), [4, 6], 'outdated, or on lines no edit holds: listed apart, never guessed');
});

test('threadRequest / replyRequest: exact bodies, allowlisted only in that shape', async () => {
  const edits = await C.proposalEdits(P, BASE, HEAD, BASE);
  const req = C.threadRequest(7, { headSha: SHA, path: P, edit: edits[1], baseText: BASE, headText: HEAD, text: '  Looks good  ' });
  assert.deepEqual(req, { method: 'POST', path: `${R}/pulls/7/comments`,
    body: { body: 'Looks good', commit_id: SHA, path: P, line: 7, side: 'RIGHT' } });
  assert.equal(C.isAllowedWrite(req.method, req.path, req.body), true);
  const rep = C.replyRequest(7, 123, 'Thanks');
  assert.deepEqual(rep, { method: 'POST', path: `${R}/pulls/7/comments/123/replies`, body: { body: 'Thanks' } });
  assert.equal(C.isAllowedWrite(rep.method, rep.path, rep.body), true);
  for (const bad of [{ ...req.body, extra: 1 }, { ...req.body, path: 'js/app.js' }, { ...req.body, side: 'UP' },
    { ...req.body, line: 0 }, { ...req.body, commit_id: 'main' }, { ...req.body, body: '' }, { ...req.body, body: 'x'.repeat(4001) }]) {
    assert.equal(C.isAllowedWrite('POST', `${R}/pulls/7/comments`, bad), false, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal(C.isAllowedWrite('POST', `${R}/pulls/7/comments/123/replies`, { body: 'x', path: P }), false);
  assert.throws(() => C.replyRequest(7, 0, 'x'));
  assert.throws(() => C.threadRequest(7, { headSha: SHA, path: P, edit: edits[1], baseText: BASE, headText: HEAD, text: ' ' }));
});

test('graphqlRequest: only the three literal operations, this repository written in, variables checked', () => {
  const list = C.graphqlRequest('threads', { n: 7 });
  assert.equal(list.method, 'POST');
  assert.equal(list.path, '/graphql');
  assert.match(list.body.query, /repository\(owner: "desert-mango", name: "hippocampus-docs"\)/);
  assert.deepEqual(list.body.variables, { n: 7 });
  const res = C.graphqlRequest('resolve', { id: 'PRRT_kwDOabc123' });
  assert.match(res.body.query, /^mutation\(\$id: ID!\) \{ resolveReviewThread/);
  assert.match(C.graphqlRequest('unresolve', { id: 'PRRT_kwDOabc123' }).body.query, /unresolveReviewThread/);
  assert.ok(C.isAllowedGraphql(list.body) && C.isAllowedGraphql(res.body));
  for (const [name, vars] of [['threads', { n: 0 }], ['threads', { n: '7' }], ['resolve', { id: 'x' }], ['resolve', { id: 'PRRT_a"}' }],
    ['delete', {}], ['threads', { n: 7, extra: 1 }]]) {
    assert.throws(() => C.graphqlRequest(name, vars), undefined, name);
  }
  assert.equal(C.isAllowedGraphql({ query: list.body.query.replace('desert-mango', 'other'), variables: { n: 7 } }), false);
  assert.equal(C.isAllowedGraphql({ query: list.body.query, variables: { n: 7 }, operationName: 'x' }), false);
});

test('the client sends GraphQL through the door only', async () => {
  const calls = [];
  const client = C.createGitHubClient({ token: 't', fetch: async (url, init) => { calls.push([url, init]); return { ok: true, status: 200, json: async () => ({ data: {} }) }; } });
  const ok = await client.graphql('threads', { n: 7 });
  assert.equal(ok.status, 200);
  assert.equal(calls[0][0], 'https://api.github.com/graphql');
  assert.equal(calls[0][1].method, 'POST');
  await assert.rejects(client.graphql('delete', {}));
  await assert.rejects(client.send('POST', '/graphql', { body: { query: 'x' } }));
  assert.equal(calls.length, 1);
});
