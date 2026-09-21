// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 21 September 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test the CMS shell's pure logic: roles, routes, PR lists, sign-in, session, API guard, preview host.
/* Unit tests for js/cms-core.js — everything in the signed-in area that is
   logic rather than DOM: the role badge, the hash routes, the proposal lists,
   the opener side of the sign-in (the `state` check), the session record, the
   one-repository GitHub client, the page-id -> file mapping for the github.com
   pencil link, and the parent side of the preview bridge (js/source.js's
   protocol, whose frame side tools/tests/test_preview_bridge.mjs pins).

   The Review tab (U8) has its own section: badges, the gate's check run ->
   status, annotations -> "file, line, what to fix", the Undo-on-GitHub URL,
   the review actions' exact requests and what their answers mean, and the
   client's write allowlist.

   The last sections run js/cms.js itself in a vm context over a fake DOM, to
   pin what only the page can get wrong: a GitHub answer for a session that
   has since ended or been replaced changes nothing, "Recently merged" pages
   the closed PRs, and the Review tab lists, shows, previews and acts (each
   button sends exactly its one request to a fake GitHub).

   No browser, no network: every window, popup, frame and fetch is a FAKE, and
   every token below is an obvious placeholder.

     node --test tools/tests/test_cms_core.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const C = require(path.join(ROOT, 'js', 'cms-core.js'));
const SRC = require(path.join(ROOT, 'js', 'source.js'));

const ORIGIN = 'https://docs.example.org';
const TOKEN = '<yours>-planted-token';
const SHA = 'a'.repeat(40);
const REPO_API = 'https://api.github.com/repos/desert-mango/hippocampus-docs';

// ------------------------------------------------------------------ fakes --

let seed = 0;
function fakeRandom(arr) {            // deterministic, but different per call
  seed += 1;
  for (let i = 0; i < arr.length; i += 1) arr[i] = (seed * 31 + i * 7) & 0xff;
  return arr;
}

function reply(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

/* A fetch that answers from a routing function and records every call. */
function fakeFetch(route) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    const r = route(String(url), init || {});
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetch, calls };
}

function fakePopup() {
  return { closed: false, location: { href: 'about:blank' }, close() { this.closed = true; } };
}

const tick = () => new Promise((r) => setImmediate(r));

// ------------------------------------------------------------ the module --

test('js/cms-core.js loads under plain node and names the one repository', () => {
  assert.equal(C.REPO_FULL, 'desert-mango/hippocampus-docs');
  assert.equal(C.REPO_API_PATH, '/repos/desert-mango/hippocampus-docs');
  assert.equal(C.API_ROOT, 'https://api.github.com');
  assert.equal(C.GITHUB_WEB, 'https://github.com/desert-mango/hippocampus-docs');
  assert.equal(C.CALLBACK_PATH, '/cms/callback.html');
  assert.equal(C.NO_ACCESS_TEXT, 'you do not have access to this site\'s repository');
  assert.ok(Object.isFrozen(C));
});

// ----------------------------------------------------------------- roles --

test('role badge: admin -> Admin, maintain -> Maintainer, push -> Editor, else Read-only', () => {
  const role = (p) => C.roleFromPermissions(p).label;
  assert.equal(role({ admin: true, maintain: true, push: true, triage: true, pull: true }), 'Admin');
  assert.equal(role({ admin: false, maintain: true, push: true, pull: true }), 'Maintainer');
  assert.equal(role({ admin: false, maintain: false, push: true, pull: true }), 'Editor');
  assert.equal(role({ admin: false, maintain: false, push: false, triage: true, pull: true }), 'Read-only');
  assert.equal(role({ pull: true }), 'Read-only');
  for (const junk of [undefined, null, {}, 'admin', [], 7]) assert.equal(role(junk), 'Read-only');
  // only a real boolean true grants: the string "true" is truthy but is not a grant
  assert.equal(role({ admin: 'true', push: 'yes' }), 'Read-only');
  assert.deepEqual(C.roleFromPermissions({ push: true }), { key: 'push', label: 'Editor', canPush: true });
  assert.equal(C.roleFromPermissions({ pull: true }).canPush, false);
  assert.equal(C.roleFromPermissions({ admin: true }).canPush, true);
});

// ---------------------------------------------------------------- routes --

test('routes: the plan\'s hash routes parse into {name, params}', () => {
  const cases = [
    ['', 'home', {}], ['#', 'home', {}], ['#/', 'home', {}],
    ['#/review', 'review', {}], ['#/review/', 'review', {}],
    ['#/review/1', 'review-pr', { number: 1 }], ['#/review/42', 'review-pr', { number: 42 }],
    ['#/help', 'help', {}],
    ['#/edit/about', 'edit', { pageId: 'about' }],
    ['#/edit/setup/lab-marker/design', 'edit', { pageId: 'setup/lab-marker/design' }],
    ['#/edit/project/uvms', 'edit', { pageId: 'project/uvms' }],
    ['#/edit/data/people', 'edit', { pageId: 'data/people' }],
    ['#/new/project', 'new', { kind: 'project' }], ['#/new/person', 'new', { kind: 'person' }],
    ['#/media', 'media', {}], ['#/private', 'private', {}],
  ];
  for (const [hash, name, params] of cases) {
    const r = C.parseRoute(hash);
    assert.equal(r.name, name, hash);
    assert.deepEqual(r.params, params, hash);
  }
});

test('routes: anything else is not-found, never a guessed page', () => {
  for (const hash of ['#/review/0', '#/review/-1', '#/review/1x', '#/review/1/2', '#/nope',
    '#/edit/', '#/edit', '#/new/', '#/new/Project', '#/help/me', '#review', '#//review',
    '#/edit/../x', '#/edit/a//b', `#/edit/a${'\u0000'}b`, '#/review/99999999999']) {
    assert.equal(C.parseRoute(hash).name, 'not-found', hash);
  }
});

test('routes: a query after the route is ignored, and the table names every owner', () => {
  assert.equal(C.parseRoute('#/review?x=1').name, 'review');
  const names = C.ROUTES.map((r) => r.name);
  assert.deepEqual(names, ['home', 'review', 'review-pr', 'help', 'edit', 'new', 'media', 'private']);
  for (const r of C.ROUTES) assert.match(r.owner, /^U(7a|7b|8|9|10)$/, r.name);
  assert.deepEqual(C.ROUTES.filter((r) => r.placeholder).map((r) => r.name),
    ['edit', 'new', 'media', 'private']);
});

// -------------------------------------------------------------- PR lists --

const pr = (number, login, extra) => Object.assign(
  { number, state: 'open', title: `PR ${number}`, user: { login } }, extra || {});

test('open proposals: all open PRs, mine first, newest first inside each group', () => {
  const input = [pr(3, 'someone'), pr(7, 'Kyle-Nelson-Berkeley'), pr(9, 'someone'),
    pr(2, 'kyle-nelson-berkeley'), pr(5, 'other'), pr(4, 'x', { state: 'closed' }),
    null, 'junk', { number: 'x' }];
  const before = JSON.stringify(input);
  const out = C.orderOpenPulls(input, 'kyle-nelson-berkeley');
  assert.deepEqual(out.map((p) => p.number), [7, 2, 9, 5, 3]);
  assert.equal(JSON.stringify(input), before, 'the input is not mutated');
  assert.deepEqual(C.orderOpenPulls(input, null).map((p) => p.number), [9, 7, 5, 3, 2]);
  assert.deepEqual(C.orderOpenPulls(null, 'x'), []);
});

test('recent merges: merged PRs only, latest merge first, capped', () => {
  const input = [
    pr(1, 'a', { state: 'closed', merged_at: '2026-09-01T10:00:00Z' }),
    pr(2, 'a', { state: 'closed', merged_at: null }),
    pr(3, 'a', { state: 'closed', merged_at: '2026-09-20T10:00:00Z' }),
    pr(4, 'a', { state: 'closed', merged_at: '2026-09-10T10:00:00Z' }),
    pr(5, 'a', { state: 'closed', merged_at: 'not a date' }),
  ];
  assert.deepEqual(C.recentMerges(input, 5).map((p) => p.number), [3, 4, 1]);
  assert.deepEqual(C.recentMerges(input, 2).map((p) => p.number), [3, 4]);
  assert.deepEqual(C.recentMerges(undefined), []);
});

/* "Recently merged" pages through the closed PRs. PR k+1 below was last
   updated k minutes before T0; merged(k) gives its merge time in minutes
   before T0, or null for a PR closed without merging. */
const T0 = Date.parse('2026-09-21T12:00:00Z');
const minutesAgo = (m) => new Date(T0 - m * 60000).toISOString();
function closedRows(from, to, merged) {
  const rows = [];
  for (let k = from; k < to; k += 1) {
    const m = merged ? merged(k) : null;
    rows.push(pr(k + 1, 'a', { state: 'closed', updated_at: minutesAgo(k),
      merged_at: m === null || m === undefined ? null : minutesAgo(m) }));
  }
  return rows;
}
const CLOSED_PATH = '/repos/desert-mango/hippocampus-docs/pulls'
  + '?state=closed&sort=updated&direction=desc&per_page=100';
const pagePaths = (n) => Array.from({ length: n }, (_, i) => `${CLOSED_PATH}&page=${i + 1}`);

/* A fake api(): answers page N of the closed-PR listing from `pages`
   (index 0 is page 1; past the end, an empty page) and records each path. */
function pagedGet(pages) {
  const paths = [];
  const get = async (p) => {
    paths.push(p);
    const m = /[?&]page=(\d+)(?:&|$)/.exec(p);
    return pages[(m ? Number(m[1]) : 1) - 1] || [];
  };
  return { get, paths };
}

test('recently merged: one short page is read once; merged PRs only, newest merge first', async () => {
  const rows = closedRows(0, 12, (k) => (k % 3 === 0 ? k : null));        // merged: PRs 1, 4, 7, 10
  rows.splice(4, 0, null, 'junk', { number: 'x' },
    pr(90, 'a', { state: 'closed', updated_at: minutesAgo(4), merged_at: 'not a date' }));
  const { get, paths } = pagedGet([rows]);
  const out = await C.loadRecentMerges(get, 5);
  assert.deepEqual(paths, pagePaths(1));
  assert.deepEqual(out.map((p) => p.number), [1, 4, 7, 10]);
  const byDefault = pagedGet([rows]);
  assert.deepEqual((await C.loadRecentMerges(byDefault.get)).map((p) => p.number), [1, 4, 7, 10],
    'five by default');
});

test('recently merged: nothing closed (or not a list) is an empty answer after one ask', async () => {
  for (const answer of [[], { message: 'odd' }, null]) {
    const { get, paths } = pagedGet([answer]);
    assert.deepEqual(await C.loadRecentMerges(get, 5), []);
    assert.deepEqual(paths, pagePaths(1));
  }
});

test('recently merged: stops once the 5th-newest merge is at or after the oldest update read', async () => {
  // PRs 1-5 were merged when last updated; everything on page 2 was updated
  // (so merged) earlier still, so page 2 cannot hold a newer merge
  const later = closedRows(100, 200, (k) => k);
  let run = pagedGet([closedRows(0, 100, (k) => (k < 5 ? k : null)), later]);
  assert.deepEqual((await C.loadRecentMerges(run.get, 5)).map((p) => p.number), [1, 2, 3, 4, 5]);
  assert.deepEqual(run.paths, pagePaths(1));
  // a tie is enough: the 5th merge happened exactly at the oldest update read
  run = pagedGet([closedRows(0, 100, (k) => (k < 4 || k === 99 ? k : null)), later]);
  assert.deepEqual((await C.loadRecentMerges(run.get, 5)).map((p) => p.number), [1, 2, 3, 4, 100]);
  assert.deepEqual(run.paths, pagePaths(1));
});

test('recently merged: pages on while a later page could still hold a newer merge', async () => {
  // page 1 holds five merges from long ago (the PRs were commented on since);
  // page 2 a PR merged 150 minutes ago; page 3 (short, the last) one at 220
  const oldMerges = closedRows(0, 100, (k) => (k < 5 ? 1000 + k : null));
  let run = pagedGet([oldMerges, closedRows(100, 200, (k) => (k === 150 ? 150 : null)),
    closedRows(200, 230, (k) => (k === 220 ? 220 : null))]);
  assert.deepEqual((await C.loadRecentMerges(run.get, 5)).map((p) => p.number), [151, 221, 1, 2, 3]);
  assert.deepEqual(run.paths, pagePaths(3));
  // several pages, then the early stop: page 2 settles it, page 3 is never asked
  run = pagedGet([oldMerges, closedRows(100, 200, (k) => (k < 105 ? k : null)),
    closedRows(200, 300, (k) => k)]);
  assert.deepEqual((await C.loadRecentMerges(run.get, 5)).map((p) => p.number), [101, 102, 103, 104, 105]);
  assert.deepEqual(run.paths, pagePaths(2));
});

test('recently merged: at most five pages (500 PRs), then the best of what was read', async () => {
  const pages = [0, 1, 2, 3, 4, 5, 6].map((i) =>
    closedRows(i * 100, i * 100 + 100, (k) => (k === 450 || k === 550 ? k : null)));
  const { get, paths } = pagedGet(pages);
  assert.deepEqual((await C.loadRecentMerges(get, 5)).map((p) => p.number), [451]);
  assert.deepEqual(paths, pagePaths(5));
});

test('recently merged: a PR seen on two pages (it moved while paging) counts once', async () => {
  const page1 = closedRows(0, 100, (k) => (k === 99 ? 99 : null));
  const page2 = [page1[99]].concat(closedRows(100, 120, (k) => (k === 110 ? 110 : null)));
  const { get } = pagedGet([page1, page2]);
  assert.deepEqual((await C.loadRecentMerges(get, 5)).map((p) => p.number), [100, 111]);
});

test('recently merged: a failed ask rejects, and no later page is asked', async () => {
  const paths = [];
  const get = async (p) => {
    paths.push(p);
    if (paths.length === 2) throw new Error('GitHub answered HTTP 502');
    return closedRows(0, 100);
  };
  await assert.rejects(C.loadRecentMerges(get, 5), /HTTP 502/);
  assert.deepEqual(paths, pagePaths(2));
});

test('recently merged: through the one-repo client every ask is a GET on this repository', async () => {
  const gh = fakeFetch((url) => reply(200, /[?&]page=1(?:&|$)/.test(url)
    ? closedRows(0, 100) : closedRows(100, 110, (k) => k)));
  const client = C.createGitHubClient({ fetch: gh.fetch, token: TOKEN });
  const out = await C.loadRecentMerges(async (p) => (await client.get(p)).data, 5);
  assert.deepEqual(out.map((p) => p.number), [101, 102, 103, 104, 105]);
  assert.deepEqual(gh.calls.map((c) => c.url), pagePaths(2).map((p) => `https://api.github.com${p}`));
  for (const c of gh.calls) assert.equal(c.init.method, 'GET');
});

// ---------------------------------------------------------- stale answers --

test('generation: next() retires every earlier generation; current() starts none', () => {
  const g = C.createGeneration();
  assert.ok(Object.isFrozen(g));
  const a = g.next();
  assert.equal(g.isCurrent(a), true);
  assert.equal(g.current(), a);
  const b = g.next();
  assert.notEqual(a, b);
  assert.equal(g.isCurrent(a), false, 'an older generation is stale for good');
  assert.equal(g.isCurrent(b), true);
  assert.equal(g.current(), b);
  assert.equal(g.isCurrent(b), true, 'reading the generation retires nothing');
  for (const junk of [undefined, null, String(b), b + 1]) assert.equal(g.isCurrent(junk), false);
  assert.equal(C.createGeneration().isCurrent(b), false, 'each counter is its own');
});

test('generation: an answer that lands after a newer start is told apart and dropped', async () => {
  // the shape js/cms.js uses: take a generation, await, apply only if current
  const gen = C.createGeneration();
  const applied = [];
  const load = async (name, answer) => {
    const mine = gen.next();
    const value = await answer;
    if (gen.isCurrent(mine)) applied.push(`${name}:${value}`);
  };
  let releaseOld;
  const old = load('old', new Promise((r) => { releaseOld = r; }));
  gen.next();                                   // a sign-out in between
  await load('new', Promise.resolve('bob'));
  releaseOld('alice');
  await old;
  assert.deepEqual(applied, ['new:bob']);
});

// --------------------------------------------------------------- sign-in --

test('randomHex: 2 hex characters per byte from getRandomValues', () => {
  const h = C.randomHex(16, fakeRandom);
  assert.match(h, /^[0-9a-f]{32}$/);
  assert.notEqual(C.randomHex(16, fakeRandom), h);
  assert.throws(() => C.randomHex(16, null), /random/);
});

test('authorizeUrl: GitHub\'s authorize page with the fixed callback on this origin', () => {
  const url = new URL(C.authorizeUrl('Iv1.fake id', ORIGIN, 'f'.repeat(32)));
  assert.equal(url.origin + url.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'Iv1.fake id');
  assert.equal(url.searchParams.get('redirect_uri'), `${ORIGIN}/cms/callback.html`);
  assert.equal(url.searchParams.get('state'), 'f'.repeat(32));
});

function signInRig(opts) {
  const o = opts || {};
  const popup = o.popup === undefined ? fakePopup() : o.popup;
  const opened = [];
  const gh = fakeFetch((url, init) => {
    if (url === '/api/auth?app=editor') {
      return o.idReply || reply(200, { client_id: 'Iv1.fakeeditorid' });
    }
    if (url === '/api/auth' && init.method === 'POST') {
      return o.exchangeReply || reply(200, { token: TOKEN, expires_in: 28800 });
    }
    return reply(599, 'unexpected');
  });
  const signIn = C.createSignIn({
    origin: ORIGIN,
    getRandomValues: fakeRandom,
    openWindow: (url, name, features) => { opened.push({ url, name, features, calls: gh.calls.length }); return popup; },
    fetch: gh.fetch,
  });
  return { signIn, popup, opened, calls: gh.calls };
}

test('sign-in start: the popup opens inside the click, then goes to GitHub with a 32-hex state', async () => {
  const rig = signInRig();
  const started = rig.signIn.start();
  assert.equal(rig.opened.length, 1, 'opened synchronously, before any await');
  assert.equal(rig.opened[0].calls, 0, 'opened before the client id is fetched');
  assert.equal(rig.opened[0].name, 'hc-signin');
  const res = await started;
  assert.equal(res.ok, true);
  assert.equal(rig.calls.length, 1);
  assert.equal(rig.calls[0].url, '/api/auth?app=editor');
  const url = new URL(rig.popup.location.href);
  assert.equal(url.origin + url.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'Iv1.fakeeditorid');
  assert.equal(url.searchParams.get('redirect_uri'), `${ORIGIN}/cms/callback.html`);
  assert.match(url.searchParams.get('state'), /^[0-9a-f]{32}$/);
  assert.equal(rig.signIn.pendingState(), url.searchParams.get('state'));
});

test('sign-in start: "not configured" closes the popup and says so, nothing pending', async () => {
  const rig = signInRig({ idReply: reply(400,
    { error: 'sign-in for the editor app is not configured on this host' }) });
  const res = await rig.signIn.start();
  assert.equal(res.ok, false);
  assert.match(res.message, /not configured/);
  assert.equal(rig.popup.closed, true);
  assert.equal(rig.signIn.pendingState(), null);
});

test('sign-in start: no /api/auth at all (a static host) is a clean message', async () => {
  for (const r of [reply(404, '404 /api/auth'), new Error('offline')]) {
    const rig = signInRig({ idReply: r });
    const res = await rig.signIn.start();
    assert.equal(res.ok, false);
    assert.equal(typeof res.message, 'string');
    assert.ok(res.message.length > 10);
    assert.equal(rig.popup.closed, true);
  }
});

test('sign-in start: a blocked popup asks nothing of the server', async () => {
  const rig = signInRig({ popup: null });
  const res = await rig.signIn.start();
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'blocked');
  assert.equal(rig.calls.length, 0);
});

test('opener state check: wrong source, wrong origin, mismatched state -> no call', async () => {
  const rig = signInRig();
  await rig.signIn.start();
  const state = rig.signIn.pendingState();
  const good = { type: 'hc-code', code: 'fake-code', state };
  const bad = [
    { source: fakePopup(), origin: ORIGIN, data: good },                   // wrong source
    { source: null, origin: ORIGIN, data: good },
    { source: rig.popup, origin: 'https://evil.example', data: good },      // wrong origin
    { source: rig.popup, origin: 'null', data: good },
    { source: rig.popup, origin: ORIGIN, data: Object.assign({}, good, { state: 'b'.repeat(32) }) },
    { source: rig.popup, origin: ORIGIN, data: Object.assign({}, good, { state: undefined }) },
    { source: rig.popup, origin: ORIGIN, data: Object.assign({}, good, { type: 'hc-file' }) },
    { source: rig.popup, origin: ORIGIN, data: Object.assign({}, good, { code: 42 }) },
    { source: rig.popup, origin: ORIGIN, data: 'hc-code' },
  ];
  for (const ev of bad) assert.equal(rig.signIn.handleMessage(ev), null);
  await tick();
  assert.equal(rig.calls.length, 1, 'only the client-id lookup; no exchange was attempted');
  assert.equal(rig.signIn.pendingState(), state, 'an ignored message leaves the sign-in pending');

  const done = rig.signIn.handleMessage({ source: rig.popup, origin: ORIGIN, data: good });
  assert.ok(done && typeof done.then === 'function');
  const out = await done;
  assert.deepEqual(out, { token: TOKEN, expiresIn: 28800 });
  assert.equal(rig.calls.length, 2);
  assert.equal(rig.calls[1].url, '/api/auth');
  assert.equal(rig.calls[1].init.method, 'POST');
  assert.deepEqual(JSON.parse(rig.calls[1].init.body), { code: 'fake-code', app: 'editor' });
  // the state is single use: a replay of the same message starts nothing
  assert.equal(rig.signIn.handleMessage({ source: rig.popup, origin: ORIGIN, data: good }), null);
  await tick();
  assert.equal(rig.calls.length, 2);
});

test('opener: the code message still lands inside the grace period after the popup closed', async () => {
  const rig = signInRig();
  await rig.signIn.start();
  rig.popup.closed = true;
  assert.equal(rig.signIn.popupClosed(500), false);
  const done = rig.signIn.handleMessage({ source: rig.popup, origin: ORIGIN,
    data: { type: 'hc-code', code: 'c', state: rig.signIn.pendingState() } });
  assert.deepEqual(await done, { token: TOKEN, expiresIn: 28800 });
  assert.equal(rig.signIn.popupClosed(500 + C.POPUP_CLOSE_GRACE_MS), false, 'nothing left to cancel');
});

test('opener: a message before any sign-in started is ignored', () => {
  const rig = signInRig();
  const ev = { source: rig.popup, origin: ORIGIN, data: { type: 'hc-code', code: 'c', state: 's' } };
  assert.equal(rig.signIn.handleMessage(ev), null);
  assert.equal(rig.calls.length, 0);
});

test('opener: a refused exchange rejects with the server\'s reason, never a token', async () => {
  const rig = signInRig({ exchangeReply: reply(502,
    { error: 'GitHub did not accept the sign-in — please sign in again', reason: 'bad_verification_code' }) });
  await rig.signIn.start();
  const ev = { source: rig.popup, origin: ORIGIN,
    data: { type: 'hc-code', code: 'c', state: rig.signIn.pendingState() } };
  await assert.rejects(rig.signIn.handleMessage(ev), /did not accept the sign-in.*bad_verification_code/);
  const empty = signInRig({ exchangeReply: reply(200, { token: '' }) });
  await empty.signIn.start();
  await assert.rejects(empty.signIn.handleMessage({ source: empty.popup, origin: ORIGIN,
    data: { type: 'hc-code', code: 'c', state: empty.signIn.pendingState() } }), /no token/);
});

test('opener: the popup closed with no message is a cancelled sign-in', async () => {
  const rig = signInRig();
  await rig.signIn.start();
  const state = rig.signIn.pendingState();
  assert.equal(rig.signIn.popupClosed(0), false);
  rig.popup.closed = true;
  // the callback posts, THEN closes: a closed popup gets a grace period in
  // which its message can still land, before it counts as a cancel
  assert.equal(rig.signIn.popupClosed(10_000), false);
  assert.equal(rig.signIn.popupClosed(10_000 + C.POPUP_CLOSE_GRACE_MS - 1), false);
  assert.equal(rig.signIn.pendingState(), state);
  assert.equal(rig.signIn.popupClosed(10_000 + C.POPUP_CLOSE_GRACE_MS), true);
  assert.equal(rig.signIn.pendingState(), null);
  assert.equal(rig.signIn.handleMessage({ source: rig.popup, origin: ORIGIN,
    data: { type: 'hc-code', code: 'c', state } }), null);
  assert.equal(rig.calls.length, 1);
});

// --------------------------------------------------------------- session --

function memoryStorage() {
  const m = new Map();
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

test('session: {token, expiresAt, login} round-trips through sessionStorage', () => {
  const s = memoryStorage();
  const rec = C.makeSession(TOKEN, 28800, 'kyle-nelson-berkeley', 1000);
  assert.deepEqual(rec, { token: TOKEN, expiresAt: 1000 + 28800 * 1000, login: 'kyle-nelson-berkeley' });
  assert.equal(C.writeSession(s, rec), true);
  assert.deepEqual([...s.m.keys()], [C.SESSION_KEY]);
  assert.deepEqual(C.readSession(s, 2000), rec);
  assert.deepEqual(C.makeSession(TOKEN, null, 'x', 5), { token: TOKEN, expiresAt: null, login: 'x' });
  assert.equal(C.readSession(s, rec.expiresAt + 1), null, 'an expired session is gone');
  assert.equal(s.m.size, 0, 'and removed');
});

test('session: malformed, empty or unreadable storage is "signed out", never a throw', () => {
  const s = memoryStorage();
  for (const raw of ['nope', '{}', '{"token":""}', '[1]', 'null', '{"token":"t","login":5}']) {
    s.m.set(C.SESSION_KEY, raw);
    assert.equal(C.readSession(s, 1), null, raw);
  }
  const hostile = { getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceeded'); }, removeItem() { throw new Error('x'); } };
  assert.equal(C.readSession(hostile, 1), null);
  assert.equal(C.writeSession(hostile, C.makeSession('t', 1, 'x', 1)), false);
  assert.doesNotThrow(() => C.clearSession(hostile));
  assert.equal(C.readSession(null, 1), null);
  C.writeSession(s, C.makeSession('t', null, 'x', 1));
  C.clearSession(s);
  assert.equal(s.m.size, 0, 'sign out clears the record');
});

// ------------------------------------------------- the one-repo API client --

test('GitHub client: only /user and this repository', () => {
  for (const ok of ['/user', C.REPO_API_PATH, `${C.REPO_API_PATH}/pulls?state=open`,
    `${C.REPO_API_PATH}/contents/content/about.md?ref=${SHA}`,
    `${C.REPO_API_PATH}/contents/content/about.md?ref=cms%2Fkyle%2Ffix-typo`]) {
    assert.doesNotThrow(() => C.assertRepoPath(ok), ok);
  }
  for (const bad of ['/user/repos', '/user/installations', '/repos/desert-mango/other',
    '/repos/desert-mango/hippocampus-docs-evil', '/repos/desert-mango/hippocampus-docsx/pulls',
    `${C.REPO_API_PATH}/../other`, `${C.REPO_API_PATH}/%2e%2e/other`, `${C.REPO_API_PATH}/%2E./x`,
    `${C.REPO_API_PATH}%2F..%2Fother`, `${C.REPO_API_PATH}/pulls?x=1#frag`, `${C.REPO_API_PATH}/a b`,
    '//evil.example/x', 'https://api.github.com/user', '/orgs/desert-mango/repos', '/search/code',
    `${C.REPO_API_PATH}\\..\\x`, `${C.REPO_API_PATH}#x`, '', null, 42]) {
    assert.throws(() => C.assertRepoPath(bad), /this site's repository/, String(bad));
  }
});

test('GitHub client: get() sends the bearer token and parses JSON; errors are statuses', async () => {
  const gh = fakeFetch((url) => {
    if (url === `${REPO_API}`) return reply(200, { permissions: { push: true } });
    if (url === 'https://api.github.com/user') return reply(401, { message: 'Bad credentials' });
    if (url.endsWith('/pulls/9')) return reply(200, '<html>');
    return new Error('offline');
  });
  const client = C.createGitHubClient({ fetch: gh.fetch, token: TOKEN });
  const repo = await client.get(C.REPO_API_PATH);
  assert.deepEqual(repo, { ok: true, status: 200, data: { permissions: { push: true } } });
  const call = gh.calls[0];
  assert.equal(call.init.method, 'GET');
  assert.equal(call.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(call.init.headers.Accept, 'application/vnd.github+json');
  assert.deepEqual(await client.get('/user'), { ok: false, status: 401, data: { message: 'Bad credentials' } });
  assert.deepEqual(await client.get(`${C.REPO_API_PATH}/pulls/9`), { ok: true, status: 200, data: null });
  assert.deepEqual(await client.get(`${C.REPO_API_PATH}/pulls/1`), { ok: false, status: 0, data: null });
  await assert.rejects(client.get('/repos/someone/else'), /this site's repository/);
  assert.equal(gh.calls.length, 4, 'the refused path never reached fetch');
  // GET, plus the verbs of the write allowlist (each scoped to exact paths)
  assert.deepEqual([...C.createGitHubClient({ fetch: gh.fetch, token: TOKEN }).methods],
    ['GET', 'POST', 'PUT', 'PATCH']);
});

// ------------------------------------------------ page id -> file on GitHub --

const REGS = {
  setup: { sections: [{ title: 'S', pages: [
    { id: 'start/index', title: 'Setup', file: 'content/setup/start/index.md' },
    { id: 'lab-marker/design', title: 'Design', file: 'content/setup/lab-marker/design.md' },
    { id: 'bad', title: 'Bad', file: '../../etc/passwd' }] }] },
  projects: { projects: [{ id: 'uvms', file: 'content/projects/uvms.md' }] },
  tools: { tools: [{ id: 'runpod-mcp', file: 'content/tools/runpod-mcp.md' }] },
};

test('editPath: page ids map to content files through the registries, like js/app.js', () => {
  assert.equal(C.editPath('about', REGS), 'content/about.md');
  assert.equal(C.editPath('setup/lab-marker/design', REGS), 'content/setup/lab-marker/design.md');
  assert.equal(C.editPath('setup/start/index', REGS), 'content/setup/start/index.md');
  assert.equal(C.editPath('project/uvms', REGS), 'content/projects/uvms.md');
  assert.equal(C.editPath('tool/runpod-mcp', REGS), 'content/tools/runpod-mcp.md');
  assert.equal(C.editPath('data/people', REGS), 'data/people.json');
  for (const miss of ['setup/nope', 'project/nope', 'tool/nope', 'setup/bad', 'data/../x',
    'data/Up', 'nope', '', 'about/x']) {
    assert.equal(C.editPath(miss, REGS), null, miss);
  }
  assert.equal(C.editPath('project/uvms', {}), null, 'no registry, no guess');
  assert.equal(C.editPath('setup/start/index', { setup: { sections: 'x' } }), null);
});

test('pencil links go to github.com\'s editor on main for this repository only', () => {
  assert.equal(C.pencilUrl('content/about.md'),
    'https://github.com/desert-mango/hippocampus-docs/edit/main/content/about.md');
  const route = (name, params) => ({ name, params: params || {} });
  assert.equal(C.placeholderLink(route('edit', { pageId: 'project/uvms' }), REGS),
    'https://github.com/desert-mango/hippocampus-docs/edit/main/content/projects/uvms.md');
  assert.equal(C.placeholderLink(route('edit', { pageId: 'project/nope' }), REGS),
    'https://github.com/desert-mango/hippocampus-docs/tree/main/content');
  assert.equal(C.placeholderLink(route('new', { kind: 'project' }), REGS),
    'https://github.com/desert-mango/hippocampus-docs/new/main/content/projects');
  assert.equal(C.placeholderLink(route('new', { kind: 'person' }), REGS),
    'https://github.com/desert-mango/hippocampus-docs/edit/main/data/people.json');
  assert.equal(C.placeholderLink(route('media'), REGS), C.GITHUB_WEB);
  assert.equal(C.placeholderLink(route('private'), REGS), C.GITHUB_WEB);
});

// ------------------------------------------------------- the preview host --

test('the bridge helpers agree with js/source.js (the frame side)', () => {
  assert.equal(C.BRIDGE_PATH_RE.source, SRC.BRIDGE_PATH_RE.source);
  const paths = ['content/about.md', 'data/setup.json', 'search/site.json', 'content/a/b/c.md',
    'content/../js/app.js', 'content/./x.md', 'content//x.md', 'js/app.js', 'api/librarian',
    'data/x.md', 'search/a/b.json', 'content/x.md?y', '/content/x.md', '', null, 7];
  for (const p of paths) assert.equal(C.isBridgePath(p), SRC.isBridgePath(p), String(p));
  for (const route of [undefined, '/', '/about', '/setup/x@h', '/search?q=a b', '//evil', 'x']) {
    assert.equal(C.previewFragment('n'.repeat(32), route), SRC.previewFragment('n'.repeat(32), route));
  }
  assert.throws(() => C.previewFragment('short', '/'), /nonce/);
});

function previewRig(opts) {
  const o = opts || {};
  const posts = [];
  const frameWin = { postMessage: (msg, target) => posts.push({ msg, target }) };
  let src = null;
  let current = frameWin;
  const host = C.createPreviewHost({
    getFrameWindow: () => current,
    setFrameSrc: (url) => { src = url; },
    getRandomValues: fakeRandom,
    base: o.base,
  });
  return {
    host, posts, frameWin,
    src: () => src,
    swapFrame: (w) => { current = w; },
    ask: (data, over) => host.handleMessage(Object.assign({ source: current, origin: 'null',
      data: Object.assign({ type: 'hc-fetch' }, data) }, over)),
  };
}

const files = (map) => (p) => (Object.prototype.hasOwnProperty.call(map, p)
  ? { ok: true, status: 200, text: map[p] } : { ok: false, status: 404, text: '' });

test('preview host: each load sets a fresh-nonce previewFragment URL on the frame', () => {
  const rig = previewRig();
  const n1 = rig.host.load('/about', files({}));
  assert.match(n1, /^[0-9a-f]{32}$/);
  assert.equal(rig.src(), `../index.html#preview=${n1}&route=%2Fabout`);
  const n2 = rig.host.load('/about', files({}));
  assert.notEqual(n2, n1, 'a new load never reuses a nonce');
  assert.equal(rig.host.nonce(), n2);
  const custom = previewRig({ base: '/index.html' });
  const n3 = custom.host.load(undefined, files({}));
  assert.equal(custom.src(), `/index.html#preview=${n3}`);
});

test('preview host: an allowlisted path at the current nonce is answered, nonce and id echoed', async () => {
  const rig = previewRig();
  const nonce = rig.host.load('/about', files({ 'content/about.md': '# About (draft)' }));
  const out = await rig.ask({ nonce, id: 3, path: 'content/about.md' });
  const expected = { type: 'hc-file', nonce, id: 3, ok: true, status: 200, text: '# About (draft)' };
  assert.deepEqual(out, expected);
  assert.deepEqual(rig.posts, [{ msg: expected, target: '*' }]);
  const missing = await rig.ask({ nonce, id: 4, path: 'content/nope.md' });
  assert.deepEqual(missing, { type: 'hc-file', nonce, id: 4, ok: false, status: 404, text: '' });
});

test('preview host: a wrong nonce or a path off the allowlist is 403, and the fetcher is never asked', async () => {
  const asked = [];
  const rig = previewRig();
  const nonce = rig.host.load('/', (p) => { asked.push(p); return { ok: true, status: 200, text: 'x' }; });
  const stale = await rig.ask({ nonce: 'f'.repeat(32), id: 1, path: 'content/about.md' });
  assert.deepEqual(stale, { type: 'hc-file', nonce: 'f'.repeat(32), id: 1, ok: false, status: 403, text: '' });
  for (const p of ['js/app.js', 'content/../js/app.js', 'api/librarian', 'index.html',
    '.env.local', 'content/x.md?ref=other', 42]) {
    const out = await rig.ask({ nonce, id: 2, path: p });
    assert.deepEqual(out, { type: 'hc-file', nonce, id: 2, ok: false, status: 403, text: '' }, String(p));
  }
  assert.deepEqual(asked, []);
});

test('preview host: messages that are not the frame\'s own hc-fetch are ignored, never answered', async () => {
  const rig = previewRig();
  const nonce = rig.host.load('/', files({ 'content/about.md': 'x' }));
  const ok = { nonce, id: 1, path: 'content/about.md' };
  assert.equal(rig.ask(ok, { source: {} }), null, 'another window');
  assert.equal(rig.ask(ok, { source: null }), null);
  assert.equal(rig.ask(Object.assign({}, ok, { type: 'hc-code' })), null);
  assert.equal(rig.ask(Object.assign({}, ok, { id: 0 })), null);
  assert.equal(rig.ask(Object.assign({}, ok, { id: '1' })), null);
  assert.equal(rig.host.handleMessage({ source: rig.frameWin, data: 'hc-fetch' }), null);
  await tick();
  assert.equal(rig.posts.length, 0);
});

test('preview host: fetcher failures become {ok:false, status}, never a crash or a hang', async () => {
  const cases = [
    [() => { throw new Error('boom'); }, 502],
    [() => Promise.reject(new Error('offline')), 502],
    [() => ({ ok: false, status: 404 }), 404],
    [() => ({ ok: false, status: 500, text: 'secret-ish error body' }), 500],
    [() => ({ ok: true, status: 200 }), 502],          // ok without a string body
    [() => ({ ok: true, status: 200, text: 7 }), 502],
    [() => null, 502],
    [() => ({ ok: false, status: 'x' }), 502],
    [() => ({ ok: false, status: 200 }), 502],         // not ok, yet a 2xx status
  ];
  for (const [fetcher, status] of cases) {
    const rig = previewRig();
    const nonce = rig.host.load('/', fetcher);
    const out = await rig.ask({ nonce, id: 1, path: 'content/about.md' });
    assert.deepEqual(out, { type: 'hc-file', nonce, id: 1, ok: false, status, text: '' }, fetcher.toString());
  }
});

test('preview host: an answer that lands after a re-load is dropped, not posted', async () => {
  let release;
  const slow = () => new Promise((r) => { release = r; });
  const rig = previewRig();
  const n1 = rig.host.load('/', slow);
  const pending = rig.ask({ nonce: n1, id: 1, path: 'content/about.md' });
  await tick();                       // the fetcher is now working on the old load
  assert.equal(typeof release, 'function');
  rig.host.load('/about', files({}));
  release({ ok: true, status: 200, text: 'old draft' });
  assert.equal(await pending, null);
  assert.equal(rig.posts.length, 0);
  rig.host.dispose();
  assert.equal(rig.ask({ nonce: rig.host.nonce(), id: 1, path: 'content/about.md' }), null);
});

test('refFetcher: the Contents API at the previewed sha, raw, with the token only in the header', async () => {
  const gh = fakeFetch((url) => {
    if (url.includes('/contents/content/about.md')) return reply(200, '# About');
    if (url.includes('/contents/content/nope.md')) return reply(404, '{"message":"Not Found"}');
    return new Error('offline');
  });
  const fetcher = C.refFetcher(TOKEN, SHA, gh.fetch);
  assert.deepEqual(await fetcher('content/about.md'), { ok: true, status: 200, text: '# About' });
  assert.equal(gh.calls[0].url, `${REPO_API}/contents/content/about.md?ref=${SHA}`);
  assert.equal(gh.calls[0].init.method, 'GET');
  assert.equal(gh.calls[0].init.headers.Accept, 'application/vnd.github.raw+json');
  assert.equal(gh.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(await fetcher('content/nope.md'), { ok: false, status: 404, text: '' });
  assert.deepEqual(await fetcher('data/setup.json'), { ok: false, status: 502, text: '' });
  assert.deepEqual(await fetcher('js/app.js'), { ok: false, status: 403, text: '' });
  assert.equal(gh.calls.length, 3, 'a refused path never reaches GitHub');
  for (const bad of ['', 'main..x', 'a b', '../main', null, 'x'.repeat(300)]) {
    assert.throws(() => C.refFetcher(TOKEN, bad, gh.fetch), /ref/, String(bad));
  }
  // a branch name rides URI-encoded in the query; its encoded slashes are fine there
  const branch = C.refFetcher(TOKEN, 'cms/kyle/fix-typo', gh.fetch);
  assert.deepEqual(await branch('content/about.md'), { ok: true, status: 200, text: '# About' });
  assert.equal(gh.calls[3].url, `${REPO_API}/contents/content/about.md?ref=cms%2Fkyle%2Ffix-typo`);
});

test('the token never reaches the frame: answers carry only the file text', async () => {
  const gh = fakeFetch(() => reply(200, '# About'));
  const rig = previewRig();
  const nonce = rig.host.load('/about', C.refFetcher(TOKEN, SHA, gh.fetch));
  await rig.ask({ nonce, id: 1, path: 'content/about.md' });
  await rig.ask({ nonce, id: 2, path: 'js/app.js' });
  assert.equal(rig.posts.length, 2);
  for (const p of rig.posts) {
    const s = JSON.stringify(p.msg);
    assert.ok(!s.includes(TOKEN), s);
    assert.ok(!/authorization|bearer/i.test(s), s);
    assert.deepEqual(Object.keys(p.msg).sort(), ['id', 'nonce', 'ok', 'status', 'text', 'type']);
  }
  assert.ok(!rig.src().includes(TOKEN), 'nor its URL');
});

test('draftFetcher: draft files first, a null draft entry is deleted, the rest falls back', async () => {
  const fallback = (p) => ({ ok: true, status: 200, text: `main:${p}` });
  const draft = C.draftFetcher({ 'content/about.md': '# New', 'content/old.md': null }, fallback);
  assert.deepEqual(await draft('content/about.md'), { ok: true, status: 200, text: '# New' });
  assert.deepEqual(await draft('content/old.md'), { ok: false, status: 404, text: '' });
  assert.deepEqual(await draft('data/setup.json'), { ok: true, status: 200, text: 'main:data/setup.json' });
  const alone = C.draftFetcher(new Map([['content/a.md', 'A']]));
  assert.deepEqual(await alone('content/a.md'), { ok: true, status: 200, text: 'A' });
  assert.deepEqual(await alone('content/b.md'), { ok: false, status: 404, text: '' });
});

// ---------------------------------------------------- the Review tab (U8) --

/* Shapes cut down from the real API, read-only, 2026-09-21: PR #1's head
   825bab4 (its `check` run is green) and GET /pulls/1/files. */
const HEAD_1 = '825bab4fa43bfb10964621d1e4d8476b5971dc78';
const RUN_URL = 'https://github.com/desert-mango/hippocampus-docs/actions/runs/35633224472/job/106444242358';
const ACTIONS_APP = { id: 15368, slug: 'github-actions', name: 'GitHub Actions' };
function gateRun(extra) {
  return Object.assign({
    id: 106444242358, name: 'check', head_sha: HEAD_1, status: 'completed', conclusion: 'success',
    html_url: RUN_URL, details_url: RUN_URL,
    started_at: '2026-09-21T17:37:49Z', completed_at: '2026-09-21T17:37:56Z',
    output: { title: null, summary: null, text: null, annotations_count: 0,
      annotations_url: `${REPO_API}/check-runs/106444242358/annotations` },
    app: ACTIONS_APP,
  }, extra || {});
}
const runs = (...rs) => ({ total_count: rs.length, check_runs: rs });
const fileRow = (filename, extra) => Object.assign({ sha: 'b'.repeat(40), filename, status: 'modified',
  additions: 1, deletions: 1, changes: 2, patch: '@@ -1 +1 @@\n-old\n+new' }, extra || {});
const PR1_FILES = ['concepts/colcon', 'concepts/pre-built-packages', 'getting-started/px4-setup',
  'getting-started/ros-installation', 'lab-cameras/event-cameras', 'raspberry-pi/ethernet',
  'raspberry-pi/uart-configuration', 'raspberry-pi/ubuntu-24-04-server', 'raspberry-pi/usb-configuration']
  .map((id) => fileRow(`content/setup/${id}.md`))
  .concat([fileRow('search/manifest.json'), fileRow('search/site.json')]);
const REAL_SETUP = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'setup.json'), 'utf8'));

test('badges: "machinery" for the site\'s code and gate, "derived files" for search/ and data/graph/', () => {
  const b = (...names) => C.pullBadges(names.map((n) => fileRow(n))).map((x) => x.key);
  for (const p of ['js/app.js', 'css/site.css', 'tools/check.py', 'api/auth.js', 'cms/index.html',
    '.github/workflows/check.yml', 'index.html', 'vercel.json']) {
    assert.deepEqual(b('content/about.md', p), ['machinery'], p);
  }
  assert.deepEqual(b('search/site.json'), ['derived']);
  assert.deepEqual(b('data/graph/wiki.json'), ['derived']);
  assert.deepEqual(b('js/app.js', 'search/site.json'), ['machinery', 'derived']);
  for (const p of ['content/about.md', 'data/tools.json', 'data/people.json', 'content/index.html',
    'jsx/app.js', 'tools.md', 'data/graphs.json', 'searches/x.json', 'docs/index.html', 'assets/vercel.json']) {
    assert.deepEqual(b(p), [], p);
  }
  // a rename counts on its old name too: moving the gate out of tools/ is machinery
  assert.deepEqual(C.pullBadges([fileRow('content/x.md', { status: 'renamed', previous_filename: 'tools/check.py' })])
    .map((x) => x.key), ['machinery']);
  assert.deepEqual(C.pullBadges(PR1_FILES).map((x) => x.key), ['derived']);
  const [m] = C.pullBadges([fileRow('js/cms.js')]);
  assert.deepEqual(m, { key: 'machinery', label: 'machinery', text: 'needs a code review by Desert Mango' });
  for (const junk of [null, 'js/app.js', [null, 42, { filename: 7 }], {}]) assert.deepEqual(C.pullBadges(junk), []);
});

test('preview scope: "content only" when a change is outside what the frame reads from the PR head', () => {
  // the frame runs the site's CURRENT code; only content/, data/ and search/ come from the head (D3)
  const s = (...names) => C.previewScope(names.map((n) => fileRow(n)));
  const full = { contentOnly: false, heading: 'Preview', text: null };
  assert.deepEqual(s('content/about.md', 'data/tools.json', 'search/site.json', 'data/graph/wiki.json'), full);
  assert.deepEqual(C.previewScope(PR1_FILES), full);
  assert.deepEqual(C.previewScope([]), full);
  for (const p of ['js/app.js', 'css/site.css', 'index.html', 'cms/index.html', 'vercel.json', 'api/auth.js',
    'tools/check.py', '.github/workflows/check.yml', 'assets/hippo.svg']) {
    assert.deepEqual(s('content/about.md', p),
      { contentOnly: true, heading: 'Preview (content only)', text: C.PREVIEW_CONTENT_ONLY_TEXT }, p);
  }
  // a removed or renamed-away code file changes the site too
  assert.equal(C.previewScope([fileRow('js/old.js', { status: 'removed' })]).contentOnly, true);
  assert.equal(C.previewScope([fileRow('content/x.md', { status: 'renamed', previous_filename: 'css/x.css' })])
    .contentOnly, true);
  // GitHub would not list the files: nobody knows what the frame misses, so say so
  for (const unknown of [null, undefined, 'js/app.js', {}]) {
    assert.deepEqual(C.previewScope(unknown),
      { contentOnly: true, heading: 'Preview (content only)', text: C.PREVIEW_UNLISTED_TEXT }, String(unknown));
  }
  assert.equal(C.PREVIEW_CONTENT_ONLY_TEXT, 'Content only: this preview shows the proposal\'s pages and data '
    + 'on the site\'s current code. Its changes to code, styles or files are not shown here; read them under '
    + '"Files changed".');
  assert.equal(C.PREVIEW_UNLISTED_TEXT, 'Content only: this preview shows the proposal\'s pages and data '
    + 'on the site\'s current code. GitHub did not list the changed files, so a change to code, styles or files '
    + 'would not show here.');
});

test('changed files: paged 100 at a time until a short page, GET only, this repository only', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => fileRow(`content/setup/p${i}.md`));
  const gh = fakeFetch((url) => (/&page=1$/.test(url) ? reply(200, page1)
    : reply(200, [fileRow('js/app.js'), 'junk'])));
  const client = C.createGitHubClient({ fetch: gh.fetch, token: TOKEN });
  const get = async (p) => (await client.get(p)).data;
  const files = await C.loadPullFiles(get, 7);
  assert.equal(files.length, 101, 'the junk row is dropped');
  assert.deepEqual(gh.calls.map((c) => [c.init.method, c.url]), [1, 2].map((k) =>
    ['GET', `${REPO_API}/pulls/7/files?per_page=100&page=${k}`]));
  await assert.rejects(C.loadPullFiles(get, 0), /PR number/);
  await assert.rejects(C.loadPullFiles(async () => { throw new Error('HTTP 502'); }, 7), /HTTP 502/);
});

test('age: minutes, hours, then days since the proposal was opened', () => {
  const now = Date.parse('2026-09-21T12:00:00Z');
  const ago = (ms) => C.ageText(new Date(now - ms).toISOString(), now);
  assert.equal(ago(20e3), 'just now');
  assert.equal(ago(60e3), '1 minute ago');
  assert.equal(ago(59 * 60e3), '59 minutes ago');
  assert.equal(ago(3600e3), '1 hour ago');
  assert.equal(ago(47 * 3600e3), '47 hours ago');
  assert.equal(ago(5 * 86400e3), '5 days ago');
  assert.equal(C.ageText('2026-09-16T10:44:36Z', now), '5 days ago');
  assert.equal(C.ageText('not a date', now), '');
  assert.equal(C.ageText(null, now), '');
});

test('check status: the gate\'s run (named "check", by GitHub Actions) -> pass / fail / still checking', () => {
  const pass = C.checkStatus(runs(gateRun()));
  assert.deepEqual(pass, { state: 'pass', text: 'site rules pass', conclusion: 'success',
    runId: 106444242358, runUrl: RUN_URL });
  for (const conclusion of ['failure', 'cancelled', 'timed_out']) {
    const s = C.checkStatus(runs(gateRun({ conclusion })));
    assert.equal(s.state, 'fail', conclusion);
    assert.equal(s.text, 'site rules fail', conclusion);
  }
  // only success is green: a completed run that ended any other way is red, and says how
  const odd = C.checkStatus(runs(gateRun({ conclusion: 'action_required' })));
  assert.equal(odd.state, 'fail');
  assert.match(odd.text, /^site rules fail \(the check ended "action_required"\)$/);
  for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
    const s = C.checkStatus(runs(gateRun({ status, conclusion: null })));
    assert.deepEqual([s.state, s.text], ['checking', 'still checking'], status);
  }
  for (const none of [runs(), {}, null, 'x', { check_runs: 'x' }]) {
    assert.equal(C.checkStatus(none).state, 'checking', JSON.stringify(none));
  }
});

test('check status: other runs never stand in for the gate; the newest gate run wins; URLs are guarded', () => {
  const vercel = gateRun({ id: 9e11, name: 'Vercel', app: { slug: 'vercel' } });
  const impostor = gateRun({ id: 9e11 + 1, conclusion: 'success', app: { slug: 'some-app' } });
  const advisory = gateRun({ id: 9e11 + 2, name: 'search-shard-advisory' });
  assert.equal(C.checkStatus(runs(vercel, impostor, advisory)).state, 'checking');
  assert.equal(C.checkStatus(runs(gateRun({ conclusion: 'failure' }), impostor)).state, 'fail');
  const older = gateRun({ id: 5, conclusion: 'failure' });
  const newer = gateRun({ id: 6, status: 'in_progress', conclusion: null });
  assert.equal(C.checkStatus(runs(newer, older)).state, 'checking');
  assert.equal(C.checkStatus(runs(older, newer)).runId, 6);
  const foreign = C.checkStatus(runs(gateRun({ html_url: 'javascript:alert(1)', details_url: 'https://evil.example/x' })));
  assert.equal(foreign.runUrl, null);
  const detailsOnly = C.checkStatus(runs(gateRun({ html_url: null })));
  assert.equal(detailsOnly.runUrl, RUN_URL);
});

test('annotations: "file, line, what to fix", and an annotation without a line still shows', () => {
  const rows = C.annotationRows([
    { path: 'data/tools.json', start_line: 12, end_line: 12, start_column: null, end_column: null,
      annotation_level: 'failure', title: null, message: 'Expecting property name enclosed in double quotes', raw_details: null },
    { path: 'content/setup/start/index.md', start_line: null, annotation_level: 'failure', message: 'no heading' },
    { path: '.github', start_line: 0, annotation_level: 'failure', message: '', title: 'Process completed with exit code 1.' },
    null, 'junk',
  ]);
  assert.deepEqual(rows, [
    { file: 'data/tools.json', line: 12, message: 'Expecting property name enclosed in double quotes' },
    { file: 'content/setup/start/index.md', line: null, message: 'no heading' },
    { file: '.github', line: null, message: 'Process completed with exit code 1.' },
  ]);
  assert.deepEqual(rows.map(C.annotationText), [
    'data/tools.json, line 12: Expecting property name enclosed in double quotes',
    'content/setup/start/index.md: no heading',
    '.github: Process completed with exit code 1.',
  ]);
  assert.deepEqual(C.annotationRows({ message: 'not a list' }), []);
});

test('annotations: every page is read (100 to a page) until a short one, GET only', async () => {
  const note = (i) => ({ path: `content/p${i}.md`, start_line: i + 1, annotation_level: 'failure', message: `m${i}` });
  const pages = [Array.from({ length: 100 }, (_, i) => note(i)), Array.from({ length: 100 }, (_, i) => note(100 + i)),
    [note(200), 'junk']];
  const gh = fakeFetch((url) => reply(200, pages[Number(/&page=(\d+)$/.exec(url)[1]) - 1] || []));
  const client = C.createGitHubClient({ fetch: gh.fetch, token: TOKEN });
  const get = async (p) => (await client.get(p)).data;
  const rows = await C.loadAnnotations(get, 222);
  assert.equal(rows.length, 201);
  assert.deepEqual(rows[200], { file: 'content/p200.md', line: 201, message: 'm200' });
  assert.deepEqual(gh.calls.map((c) => [c.init.method, c.url]), [1, 2, 3].map((k) =>
    ['GET', `${REPO_API}/check-runs/222/annotations?per_page=100&page=${k}`]));
  await assert.rejects(C.loadAnnotations(get, 'x'), /check run id/);
  await assert.rejects(C.loadAnnotations(async () => { throw new Error('HTTP 403'); }, 222), /HTTP 403/);
});

test('Undo on GitHub: the merged PR\'s own page, where GitHub\'s Revert button is', () => {
  assert.equal(C.undoOnGitHubUrl(1), 'https://github.com/desert-mango/hippocampus-docs/pull/1');
  assert.equal(C.undoOnGitHubUrl(4321), 'https://github.com/desert-mango/hippocampus-docs/pull/4321');
  assert.equal(C.UNDO_TEXT, 'Undo on GitHub');
  for (const bad of [0, -1, 1.5, '1', NaN, null, 1e10]) {
    assert.throws(() => C.undoOnGitHubUrl(bad), /PR number/, String(bad));
  }
});

test('Vercel\'s preview comment: a link to the bot\'s comment on this repository, or none', () => {
  const bot = { user: { login: 'vercel[bot]' },
    html_url: 'https://github.com/desert-mango/hippocampus-docs/pull/1#issuecomment-5696197254' };
  assert.equal(C.vercelCommentUrl([{ user: { login: 'kyle' }, html_url: bot.html_url.replace('5696', '1111') }, bot]),
    bot.html_url);
  assert.equal(C.vercelCommentUrl([{ user: { login: 'vercel' }, html_url: bot.html_url }]), null, 'a person named vercel');
  assert.equal(C.vercelCommentUrl([{ user: { login: 'vercel[bot]' }, html_url: 'https://evil.example/x' }]), null);
  assert.equal(C.vercelCommentUrl([]), null);
  assert.equal(C.vercelCommentUrl(null), null);
});

test('actions by role: Read-only none, Editor no Merge, Maintainer and Admin all; merged -> Undo only', () => {
  const open = { state: 'open', merged: false, merged_at: null };
  const role = (perms) => C.roleFromPermissions(perms);
  assert.deepEqual(C.reviewActionsFor(role({ pull: true }), open), []);
  assert.deepEqual(C.reviewActionsFor(null, open), []);
  assert.deepEqual(C.reviewActionsFor(role({ push: true }), open), ['approve', 'request-changes', 'update', 'close']);
  const all = ['approve', 'request-changes', 'merge', 'update', 'close'];
  assert.deepEqual(C.reviewActionsFor(role({ maintain: true, push: true }), open), all);
  assert.deepEqual(C.reviewActionsFor(role({ admin: true }), open), all);
  const merged = { state: 'closed', merged: true, merged_at: '2026-09-20T10:00:00Z' };
  assert.deepEqual(C.reviewActionsFor(role({ admin: true }), merged), ['undo']);
  assert.deepEqual(C.reviewActionsFor(role({ pull: true }), merged), []);
  assert.deepEqual(C.reviewActionsFor(role({ admin: true }), { state: 'closed', merged: false, merged_at: null }), []);
});

test('action requests: one exact write each, pinned to the head sha that was shown', () => {
  const ctx = { number: 7, sha: HEAD_1, comment: '  Please fix the heading.  ', checkState: 'pass' };
  const P = '/repos/desert-mango/hippocampus-docs/pulls/7';
  assert.deepEqual(C.reviewRequest('approve', ctx),
    { method: 'POST', path: `${P}/reviews`, body: { event: 'APPROVE', commit_id: HEAD_1 } });
  assert.deepEqual(C.reviewRequest('request-changes', ctx), { method: 'POST', path: `${P}/reviews`,
    body: { event: 'REQUEST_CHANGES', body: 'Please fix the heading.', commit_id: HEAD_1 } });
  assert.deepEqual(C.reviewRequest('merge', ctx),
    { method: 'PUT', path: `${P}/merge`, body: { merge_method: 'squash', sha: HEAD_1 } });
  assert.deepEqual(C.reviewRequest('update', ctx),
    { method: 'PUT', path: `${P}/update-branch`, body: { expected_head_sha: HEAD_1 } });
  assert.deepEqual(C.reviewRequest('close', ctx), { method: 'PATCH', path: P, body: { state: 'closed' } });
  assert.throws(() => C.reviewRequest('request-changes', Object.assign({}, ctx, { comment: '   ' })), /what should change/);
  for (const a of ['approve', 'merge', 'update']) {
    assert.throws(() => C.reviewRequest(a, { number: 7, sha: 'main', checkState: 'pass' }), /head commit/, a);
  }
  assert.throws(() => C.reviewRequest('merge', { number: 0, sha: HEAD_1, checkState: 'pass' }), /number/);
  // not green: a merge needs one explicit confirmation (never a lock: confirmed, it goes)
  for (const checkState of ['fail', 'checking', 'unknown', undefined]) {
    assert.equal(C.mergeNeedsConfirm(checkState), true, String(checkState));
    assert.throws(() => C.reviewRequest('merge', { number: 7, sha: HEAD_1, checkState }), /needs your confirmation/,
      String(checkState));
    assert.deepEqual(C.reviewRequest('merge', { number: 7, sha: HEAD_1, checkState, confirmed: true }),
      { method: 'PUT', path: '/repos/desert-mango/hippocampus-docs/pulls/7/merge',
        body: { merge_method: 'squash', sha: HEAD_1 } }, String(checkState));
  }
  assert.equal(C.mergeNeedsConfirm('pass'), false);
  assert.equal(C.MERGE_CONFIRM_TEXT, 'Site rules do not pass on this commit (or are still checking). '
    + 'A merge deploys nothing until main is green. Merge anyway?');
  assert.equal(C.reviewRequest('approve', { number: 7, sha: HEAD_1, checkState: 'fail' }).method, 'POST',
    'reviewing a red proposal is fine; only merging waits');
  assert.throws(() => C.reviewRequest('delete', ctx), /no such action/);
});

test('write allowlist: the client sends a write verb only to the exact paths listed', async () => {
  const gh = fakeFetch(() => reply(200, {}));
  const client = C.createGitHubClient({ fetch: gh.fetch, token: TOKEN });
  assert.deepEqual([...client.methods], ['GET', 'POST', 'PUT', 'PATCH']);
  assert.ok(C.WRITE_METHODS.every((w) => w.unit && w.path instanceof RegExp));
  const R = C.REPO_API_PATH;
  for (const [m, p] of [['POST', `${R}/pulls/7/reviews`], ['PUT', `${R}/pulls/7/merge`],
    ['PUT', `${R}/pulls/123456789/update-branch`], ['PATCH', `${R}/pulls/7`]]) {
    assert.equal(C.isAllowedWrite(m, p), true, `${m} ${p}`);
    await client.send(m, p, { body: { x: 1 } });
  }
  const refused = [
    ['POST', `${R}/pulls`], ['POST', `${R}/pulls/7/merge`], ['PUT', `${R}/pulls/7/reviews`],
    ['PATCH', `${R}/pulls/7/merge`], ['PUT', `${R}/pulls/07/merge`], ['PUT', `${R}/pulls/7/merge/`],
    ['PUT', `${R}/pulls/7/merge?x=1`], ['PATCH', `${R}/pulls/0`], ['PATCH', `${R}`],
    ['PUT', `${R}/contents/content/about.md`], ['POST', `${R}/git/refs`], ['POST', `${R}/issues/7/comments`],
    ['PATCH', `${R}/issues/7`], ['POST', `${R}/merges`], ['PUT', `${R}/pulls/1234567890/merge`],
    ['POST', '/user'], ['PUT', '/repos/desert-mango/other/pulls/7/merge'],
    ['PUT', `${R}/pulls/7/../../other/pulls/7/merge`], ['POST', `${R}/pulls/7/reviews#x`],
  ];
  for (const [m, p] of refused) {
    assert.equal(C.isAllowedWrite(m, p), false, `${m} ${p}`);
    await assert.rejects(client.send(m, p, { body: {} }), /does not send|this site's repository/, `${m} ${p}`);
  }
  for (const m of ['DELETE', 'get', 'OPTIONS']) {
    await assert.rejects(client.send(m, `${R}/pulls/7`), /does not send/, m);
  }
  await assert.rejects(client.get(`${R}/pulls/7`, { body: {} }), /no body/);
  assert.equal(gh.calls.length, 4, 'only the four allowed writes reached fetch');
  const merge = gh.calls[1];
  assert.equal(merge.init.method, 'PUT');
  assert.equal(merge.init.headers['Content-Type'], 'application/json');
  assert.equal(merge.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(merge.init.body, '{"x":1}');
});

test('action outcomes: self-approval 422, merge 409, update conflict 422 in the tab\'s words', () => {
  const res = (status, data) => ({ ok: status >= 200 && status < 300, status, data });
  const self = res(422, { message: 'Unprocessable Entity',
    errors: ['Review Can not approve your own pull request'], status: '422' });
  assert.equal(C.actionOutcome('approve', self, {}).message, 'GitHub does not let you approve your own proposal.');
  assert.equal(C.actionOutcome('approve', res(422, { message: 'Unprocessable Entity' }), { isAuthor: true }).message,
    'GitHub does not let you approve your own proposal.');
  assert.equal(C.actionOutcome('request-changes', res(422, { message: 'Unprocessable Entity',
    errors: ['Review Can not request changes on your own pull request'] }), {}).message,
  'GitHub does not let you request changes on your own proposal.');
  assert.equal(C.actionOutcome('merge', res(409, { message: 'Head branch was modified. Review and try the merge again.' }))
    .message, 'Not merged: it changed since you looked, reload.');
  assert.equal(C.actionOutcome('update', res(422, { message: 'merge conflict between base and head' })).message,
    'This branch needs a human — ask Desert Mango.');
  assert.equal(C.actionOutcome('update', res(422, { message: 'expected head sha didn’t match current head ref.' }))
    .message, 'Not updated: it changed since you looked, reload.');
  assert.match(C.actionOutcome('merge', res(405, { message: 'Pull Request is not mergeable' })).message,
    /^GitHub cannot merge this proposal: Pull Request is not mergeable$/);
  assert.match(C.actionOutcome('close', res(403, { message: 'Resource not accessible by integration' })).message,
    /^GitHub says you may not do this: Resource not accessible by integration$/);
  assert.match(C.actionOutcome('approve', res(422, { message: 'Pull request is closed' }), {}).message,
    /^GitHub refused \(HTTP 422\): Pull request is closed$/);
  assert.equal(C.actionOutcome('merge', res(200, { merged: true })).ok, true);
  assert.equal(C.actionOutcome('merge', res(200, { merged: true })).message, 'Merged.');
  assert.equal(C.actionOutcome('update', res(202, { message: 'Updating pull request branch.' })).ok, true);
  assert.match(C.actionOutcome('merge', { ok: false, status: 0, data: null }).message, /could not be reached/);
  // GitHub's words arrive as text, one line, bounded
  const long = C.actionOutcome('close', res(500, { message: `a\nb${'x'.repeat(900)}` })).message;
  assert.ok(!long.includes('\n') && long.length < 340);
});

test('runReviewAction: an unbuildable request sends nothing; a sent one reports GitHub\'s answer', async () => {
  const gh = fakeFetch((url, init) => (init.method === 'PUT' ? reply(409, { message: 'Head branch was modified.' })
    : reply(200, { id: 1 })));
  const client = C.createGitHubClient({ fetch: gh.fetch, token: TOKEN });
  const empty = await C.runReviewAction(client, 'request-changes', { number: 7, sha: HEAD_1, comment: '' });
  assert.deepEqual([empty.ok, empty.sent], [false, false]);
  assert.match(empty.message, /^Nothing was sent: write what should change/);
  assert.equal(gh.calls.length, 0);
  const red = await C.runReviewAction(client, 'merge', { number: 7, sha: HEAD_1, checkState: 'fail' });
  assert.deepEqual([red.ok, red.sent], [false, false]);
  assert.match(red.message, /^Nothing was sent: a merge while site rules do not pass needs your confirmation/);
  assert.equal(gh.calls.length, 0);
  const merged = await C.runReviewAction(client, 'merge', { number: 7, sha: HEAD_1, checkState: 'fail', confirmed: true });
  assert.deepEqual([merged.ok, merged.status, merged.sent], [false, 409, true]);
  assert.equal(merged.message, 'Not merged: it changed since you looked, reload.');
  const approved = await C.runReviewAction(client, 'approve', { number: 7, sha: HEAD_1 });
  assert.deepEqual([approved.ok, approved.message], [true, 'Approved.']);
  assert.deepEqual(gh.calls.map((c) => [c.init.method, c.url, JSON.parse(c.init.body)]), [
    ['PUT', `${REPO_API}/pulls/7/merge`, { merge_method: 'squash', sha: HEAD_1 }],
    ['POST', `${REPO_API}/pulls/7/reviews`, { event: 'APPROVE', commit_id: HEAD_1 }],
  ]);
});

test('preview pages: changed files -> the site routes that show them, via the PR head\'s registries', () => {
  const regs = { setup: REAL_SETUP,
    projects: { projects: [{ id: 'uvms', name: 'UVMS', file: 'content/projects/uvms.md' }] },
    tools: { tools: [{ id: 'runpod-mcp', name: 'runpod-mcp', file: 'content/tools/runpod-mcp.md' }] } };
  const pr1 = C.previewPages(PR1_FILES, regs);
  assert.equal(pr1.length, 9, 'nine changed setup pages; search/ shows no page');
  assert.deepEqual(pr1[0], { route: '/setup/concepts/colcon', label: 'Colcon', file: 'content/setup/concepts/colcon.md' });
  const mixed = C.previewPages([fileRow('js/app.js'), fileRow('content/projects/uvms.md'),
    fileRow('content/tools/gone.md', { status: 'removed' }), fileRow('content/tools/runpod-mcp.md'),
    fileRow('data/people.json'), fileRow('content/about.md'), fileRow('data/site.json'),
    fileRow('content/setup/not-in-registry.md')], regs);
  assert.deepEqual(mixed.map((x) => x.route), ['/projects/uvms', '/tools/runpod-mcp', '/about', '/']);
  // a PR's registries are not checked yet: every shape is guarded
  for (const bad of [null, {}, { setup: 'x', projects: { projects: 'abc' }, tools: { tools: [null, 7] } },
    { setup: { sections: [{ pages: [{ id: '../x', file: 'content/setup/concepts/colcon.md' }] }] } },
    { projects: { projects: [{ id: 'a/b', file: 'content/projects/uvms.md' }] } }]) {
    assert.deepEqual(C.previewPages([fileRow('content/setup/concepts/colcon.md'),
      fileRow('content/projects/uvms.md')], bad), [], JSON.stringify(bad));
  }
  assert.deepEqual(C.previewPages('junk', regs), []);
});

test('head registries: only those a changed content file needs, read through the fetcher; broken is null', async () => {
  const asked = [];
  const fetcher = async (p) => {
    asked.push(p);
    if (p === 'data/setup.json') return { ok: true, status: 200, text: JSON.stringify(REAL_SETUP) };
    if (p === 'data/projects.json') return { ok: true, status: 200, text: '{"projects": [,]}' };
    return { ok: false, status: 404, text: '' };
  };
  const regs = await C.loadHeadRegistries(fetcher, PR1_FILES);
  assert.deepEqual(asked, ['data/setup.json']);
  assert.equal(regs.setup.sections.length, REAL_SETUP.sections.length);
  const more = await C.loadHeadRegistries(fetcher, [fileRow('content/projects/x.md'), fileRow('content/tools/y.md')]);
  assert.deepEqual(more, { setup: null, projects: null, tools: null });
  assert.deepEqual(await C.loadHeadRegistries(async () => { throw new Error('x'); }, PR1_FILES),
    { setup: null, projects: null, tools: null });
});

// -------------------------------------------------- source-level promises --

test('js/cms.js reaches GitHub only through cms-core; every write is an allowlisted review action', () => {
  const ui = fs.readFileSync(path.join(ROOT, 'js', 'cms.js'), 'utf8');
  assert.ok(!ui.includes('api.github.com'), 'the UI never builds an API URL itself');
  assert.ok(!/\b(POST|PUT|PATCH|DELETE)\b/.test(ui),
    'the UI names no write verb: writes are HCCore.runReviewAction, through the allowlist');
  assert.ok(!/\.send\s*\(/.test(ui), 'the UI never calls client.send() itself');
  // one wrapper hands window.fetch to the client and the sign-in; no other call
  const WRAPPER = 'const netFetch = (url, init) => window.fetch(url, init);';
  assert.equal(ui.split(WRAPPER).length, 2, 'exactly one fetch wrapper');
  assert.ok(!/\bfetch\s*\(/.test(ui.replace(WRAPPER, '').replace(/HC\.fetch(JSON|Text)\(/g, '')),
    'the UI calls no bare fetch (the client and the sign-in own the network)');
  assert.equal((ui.match(/\bnetFetch\b/g) || []).length, 5,
    'netFetch goes only to the sign-in, the GitHub clients and the PR-head preview fetcher');
  const core = fs.readFileSync(path.join(ROOT, 'js', 'cms-core.js'), 'utf8');
  const verbs = core.match(/method:\s*'[A-Z]+'/g) || [];
  assert.deepEqual([...new Set(verbs)].sort(),
    ["method: 'GET'", "method: 'PATCH'", "method: 'POST'", "method: 'PUT'"]);
  assert.ok(!/\bDELETE\b/.test(core), 'nothing in the CMS deletes');
  // the write verbs appear only in the allowlist and the review requests it admits
  const allow = core.slice(core.indexOf('const WRITE_METHODS'), core.indexOf('function isAllowedWrite'));
  const review = core.slice(core.indexOf('function reviewRequest'), core.indexOf('const DONE_TEXT'));
  const rest = core.replace(allow, '').replace(review, '');
  assert.deepEqual((rest.match(/method:\s*'(POST|PUT|PATCH)'/g) || []), ["method: 'POST'"],
    'outside them, one POST: the sign-in exchange to /api/auth');
  for (const src of [ui, core]) {
    // (a repository name may hold dots, but never ends in one: that is a full stop)
    const repos = src.match(/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]*[A-Za-z0-9_-]/g) || [];
    for (const r of repos) assert.equal(r, 'repos/desert-mango/hippocampus-docs', r);
  }
});

test('cms/index.html: local scripts in order, noindex, and a way back to the site', () => {
  const html = fs.readFileSync(path.join(ROOT, 'cms', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(scripts, ['../js/source.js', '../js/cms-core.js', '../js/cms.js']);
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /<a [^>]*href="\.\.\/"/);
  assert.match(html, /href="\.\.\/css\/cms\.css"/);
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
});

// ------------------------------------------------- js/cms.js in a fake page --

/* Just enough DOM to run js/cms.js under node: an element holds children,
   text, attributes, `hidden` and click listeners. */
class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.ownText = '';
    this.attrs = {};
    this.hidden = false;
    this.className = '';
    this.dataset = {};
    this.listeners = {};
    const classes = new Set();
    this.classList = {
      toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    };
  }
  get textContent() { return this.ownText + this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(t) { this.ownText = String(t); this.childNodes = []; }
  appendChild(c) { this.childNodes.push(c); return c; }
  replaceChildren(...cs) { this.ownText = ''; this.childNodes = cs; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  querySelectorAll() { return []; }
  remove() {}
  click() { for (const fn of this.listeners.click || []) fn({ type: 'click' }); }
}

const TOKEN_A = '<yours>-token-a';
const TOKEN_B = '<yours>-token-b';
const bearer = (init) => String((init.headers && init.headers.Authorization) || '').replace(/^Bearer /, '');
const settle = async () => { for (let i = 0; i < 40; i += 1) await tick(); };
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/* GitHub as one signed-in person sees it: /user, this repository (`repo` is
   its reply), no open PRs, and `closedPages` for the closed-PR listing. */
function githubFor(login, repo, closedPages) {
  return (url) => {
    if (url === 'https://api.github.com/user') return reply(200, { login });
    if (url === REPO_API) return repo;
    if (url.startsWith(`${REPO_API}/pulls?state=open`)) return reply(200, []);
    if (url.startsWith(`${REPO_API}/pulls?state=closed`)) {
      const m = /[?&]page=(\d+)(?:&|$)/.exec(url);
      return reply(200, (closedPages || [])[(m ? Number(m[1]) : 1) - 1] || []);
    }
    return reply(404, { message: 'Not Found' });
  };
}
const asBob = () => githubFor('bob', reply(200, { permissions: { push: true } }));

/* Runs js/cms-core.js and js/cms.js in a fresh vm context standing in for
   cms/index.html; `github(url, init)` answers every fetch. */
function openCms(opts) {
  const ids = ['cms-main', 'cms-notice', 'cms-sign-in', 'cms-sign-out', 'cms-who', 'cms-nav'];
  const els = Object.fromEntries(ids.map((id) => [id, new FakeElement('div')]));
  const storage = memoryStorage();
  const putSession = (token, login) =>
    C.writeSession(storage, C.makeSession(token, null, login, Date.now()));
  if (opts.session) putSession(opts.session.token, opts.session.login);
  const calls = [];
  const listeners = {};
  const win = vm.createContext({
    document: {
      getElementById: (id) => els[id] || null,
      createElement: (tag) => new FakeElement(tag),
      createTextNode: (text) => ({ textContent: String(text) }),
      documentElement: new FakeElement('html'),
    },
    sessionStorage: storage,
    localStorage: memoryStorage(),
    location: { origin: ORIGIN, hash: opts.hash || '#/' },
    crypto: { getRandomValues: fakeRandom },
    fetch: (url, init) => {
      calls.push({ url: String(url), init: init || {} });
      return opts.github(String(url), init || {});
    },
    open: () => null,
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    setInterval, clearInterval, setTimeout, clearTimeout,
  });
  win.window = win;
  for (const f of ['cms-core.js', 'cms.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), win, { filename: f });
  }
  return {
    els, storage, calls, win, putSession, listeners,
    main: () => els['cms-main'].textContent,
    who: () => els['cms-who'].textContent,
    notice: () => els['cms-notice'].textContent,
    signedInAs: () => (C.readSession(storage, Date.now()) || {}).login,
  };
}

/* Sign out, then sign in as bob (the session a finished sign-in writes). */
async function signOutThenInAsBob(page) {
  page.els['cms-sign-out'].click();
  await settle();
  page.putSession(TOKEN_B, 'bob');
  page.win.HCCms.refresh();
  await settle();
  assert.match(page.who(), /bob/);
  assert.match(page.who(), /Editor/);
}

test('js/cms.js: a refresh that lands after sign-out and a new sign-in changes nothing', async () => {
  const held = deferred();                       // alice's answers, held back
  const alice = githubFor('alice', reply(200, { permissions: { admin: true, push: true } }));
  const bob = asBob();
  const page = openCms({ session: { token: TOKEN_A, login: 'alice' },
    github: (url, init) => (bearer(init) === TOKEN_A ? held.promise.then(() => alice(url)) : bob(url)) });
  await settle();
  assert.match(page.main(), /Checking your access/);
  await signOutThenInAsBob(page);
  held.resolve();
  await settle();
  assert.match(page.who(), /bob/);
  assert.match(page.who(), /Editor/);
  assert.doesNotMatch(page.who(), /Admin|alice/, 'the old answer wrote nothing');
  assert.equal(page.signedInAs(), 'bob');
});

test('js/cms.js: a "no access" answer that lands after sign-out leaves the signed-out page alone', async () => {
  const held = deferred();
  const alice = githubFor('alice', reply(404, { message: 'Not Found' }));
  const page = openCms({ session: { token: TOKEN_A, login: 'alice' },
    github: (url) => held.promise.then(() => alice(url)) });
  await settle();
  page.els['cms-sign-out'].click();
  await settle();
  held.resolve();
  await settle();
  assert.doesNotMatch(page.main(), /do not have access/);
  assert.match(page.main(), /Sign in with your GitHub account/);
  assert.equal(page.els['cms-nav'].hidden, false);
  assert.equal(page.els['cms-sign-in'].hidden, false);
});

test('js/cms.js: an old session\'s 401 does not end the session that replaced it', async () => {
  const held = deferred();
  const bob = asBob();
  const page = openCms({ session: { token: TOKEN_A, login: 'alice' },
    github: (url, init) => (bearer(init) === TOKEN_A
      ? held.promise.then(() => reply(401, { message: 'Bad credentials' })) : bob(url)) });
  await settle();
  await signOutThenInAsBob(page);
  held.resolve();
  await settle();
  assert.equal(page.signedInAs(), 'bob');
  assert.match(page.who(), /bob/);
  assert.doesNotMatch(page.notice(), /sign-in has ended/);
});

test('js/cms.js: a 401 for a list the old session asked for does not end the new session', async () => {
  const held = deferred();
  const alice = githubFor('alice', reply(200, { permissions: { push: true } }));
  const bob = asBob();
  const page = openCms({ session: { token: TOKEN_A, login: 'alice' },
    github: (url, init) => {
      if (bearer(init) !== TOKEN_A) return bob(url);
      if (url.includes('/pulls?')) return held.promise.then(() => reply(401, { message: 'Bad credentials' }));
      return alice(url);
    } });
  await settle();
  assert.match(page.who(), /alice/, 'signed in; the home page waits on its lists');
  await signOutThenInAsBob(page);
  held.resolve();
  await settle();
  assert.equal(page.signedInAs(), 'bob');
  assert.match(page.who(), /bob/);
  assert.doesNotMatch(page.notice(), /sign-in has ended/);
});

test('js/cms.js: "Recently merged" finds a merge on the second page of closed PRs', async () => {
  const closedPages = [closedRows(0, 100), closedRows(100, 120, (k) => (k === 110 ? 110 : null))];
  closedPages[1][10].title = 'Fix the wiring diagram';
  const page = openCms({ session: { token: TOKEN_B, login: 'bob' },
    github: githubFor('bob', reply(200, { permissions: { push: true } }), closedPages) });
  await settle();
  assert.match(page.main(), /Recently merged/);
  assert.match(page.main(), /#111Fix the wiring diagram/);
  assert.doesNotMatch(page.main(), /Nothing merged recently/);
  assert.deepEqual(page.calls.filter((c) => c.url.includes('state=closed')).map((c) => c.url),
    pagePaths(2).map((p) => `https://api.github.com${p}`));
});

// ------------------------------------------ js/cms.js: the Review tab (U8) --

/* Every element under `node` (itself included) that passes `pred`. */
function findAll(node, pred, out = []) {
  if (node && node.tagName && pred(node)) out.push(node);
  for (const c of (node && node.childNodes) || []) findAll(c, pred, out);
  return out;
}
const actionButtons = (page) => findAll(page.els['cms-main'], (e) => e.attrs['data-action'] !== undefined);
const actionButton = (page, key) => actionButtons(page).find((e) => e.attrs['data-action'] === key);
const writes = (page) => page.calls.filter((c) => (c.init.method || 'GET') !== 'GET');
const HOURS = 3600e3;

/* GitHub for the Review tab: `login` signed in with `perms` on this
   repository; `pulls` maps number -> {pull, files, runs, annotations,
   comments}; `contents` maps "<path>@<sha>" -> text; `onWrite(method, url,
   body)` answers every write (a 200 by default). */
function reviewGithub(o) {
  return (url, init) => {
    const method = init.method || 'GET';
    if (method !== 'GET') return o.onWrite ? o.onWrite(method, url, JSON.parse(init.body)) : reply(200, {});
    if (url === 'https://api.github.com/user') return reply(200, { login: o.login });
    if (url === REPO_API) return reply(200, { permissions: o.perms });
    const rest = url.slice(REPO_API.length);
    if (rest.startsWith('/pulls?state=open')) return reply(200, Object.values(o.pulls).map((x) => x.pull));
    if (rest.startsWith('/pulls?state=closed')) return reply(200, o.closed || []);
    let m = /^\/pulls\/(\d+)(\/files\?.*)?$/.exec(rest);
    if (m && o.pulls[m[1]]) return reply(200, m[2] ? o.pulls[m[1]].files : o.pulls[m[1]].pull);
    m = /^\/commits\/([0-9a-f]{40})\/check-runs\?/.exec(rest);
    if (m) {
      const hit = Object.values(o.pulls).find((x) => x.pull.head.sha === m[1]);
      return reply(200, (hit && hit.runs) || runs());
    }
    m = /^\/check-runs\/(\d+)\/annotations\?/.exec(rest);
    if (m) {
      const hit = Object.values(o.pulls).find((x) => x.runs && x.runs.check_runs.some((r) => String(r.id) === m[1]));
      return reply(200, (hit && hit.annotations) || []);
    }
    m = /^\/issues\/(\d+)\/comments\?/.exec(rest);
    if (m) return reply(200, (o.pulls[m[1]] && o.pulls[m[1]].comments) || []);
    m = /^\/contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(rest);
    if (m && o.contents && o.contents[`${m[1]}@${m[2]}`] !== undefined) return reply(200, o.contents[`${m[1]}@${m[2]}`]);
    return reply(404, { message: 'Not Found' });
  };
}

function openPull(number, login, sha, extra) {
  return Object.assign({ number, state: 'open', merged: false, merged_at: null, title: `Proposal ${number}`,
    user: { login }, created_at: new Date(Date.now() - 3 * 24 * HOURS).toISOString(),
    head: { sha, ref: `cms/${login}/fix-${number}` }, base: { ref: 'main' }, html_url: C.undoOnGitHubUrl(number) },
  extra || {});
}

test('js/cms.js Review list: mine first, author, age, files count, both badges; a title stays text', async () => {
  const pulls = {
    5: { pull: openPull(5, 'alice', 'c'.repeat(40), { title: '<script>alert(1)</script> fix the nav' }),
      files: [fileRow('js/app.js')] },
    6: { pull: openPull(6, 'bob', 'd'.repeat(40)), files: [fileRow('content/about.md'), fileRow('search/site.json')] },
  };
  const page = openCms({ session: { token: TOKEN_B, login: 'bob' }, hash: '#/review',
    github: reviewGithub({ login: 'bob', perms: { push: true }, pulls }) });
  await settle();
  const text = page.main();
  assert.ok(text.indexOf('#6') < text.indexOf('#5'), 'my proposal first');
  assert.match(text, /#6Proposal 6yoursby bob, opened 3 days ago2 filesderived files/);
  assert.match(text, /#5<script>alert\(1\)<\/script> fix the navby alice, opened 3 days ago1 filemachinery/);
  const badges = findAll(page.els['cms-main'], (e) => /cms-badge-/.test(e.className));
  assert.deepEqual(badges.map((e) => [e.textContent, e.attrs.title]), [
    ['derived files', C.DERIVED_TEXT], ['machinery', 'needs a code review by Desert Mango']]);
  assert.equal(findAll(page.els['cms-main'], (e) => e.tagName === 'SCRIPT').length, 0, 'the title is text');
  assert.deepEqual(writes(page), []);
  assert.ok(page.calls.some((c) => c.url === `${REPO_API}/pulls/5/files?per_page=100&page=1`));
});

function greenPr1(extra) {
  return { pull: openPull(1, 'kyle-nelson-berkeley', HEAD_1), files: PR1_FILES, runs: runs(gateRun()),
    comments: [{ user: { login: 'vercel[bot]' }, html_url: `${C.undoOnGitHubUrl(1)}#issuecomment-5696197254` }],
    ...extra };
}
const PR1_CONTENTS = { [`data/setup.json@${HEAD_1}`]: JSON.stringify(REAL_SETUP),
  [`content/setup/concepts/colcon.md@${HEAD_1}`]: '# Colcon\n\nThe fixed text.' };

test('js/cms.js Review PR: green ✓, the diff as text, Vercel\'s comment, and the preview at the PR head', async () => {
  const page = openCms({ session: { token: TOKEN_A, login: 'desert-mango-robotics' }, hash: '#/review/1',
    github: reviewGithub({ login: 'desert-mango-robotics', perms: { admin: true, push: true },
      pulls: { 1: greenPr1() }, contents: PR1_CONTENTS }) });
  await settle();
  const text = page.main();
  assert.match(text, /✓site rules pass/);
  assert.match(text, /content\/setup\/concepts\/colcon\.md/);
  assert.match(text, /-old\n\+new/, 'the patch is shown as text');
  assert.match(text, /derived files/);
  assert.deepEqual(findAll(page.els['cms-main'], (e) => e.tagName === 'H2').map((e) => e.textContent)
    .filter((t) => /^Preview/.test(t)), ['Preview'], 'a content-only proposal: the preview shows every change');
  assert.doesNotMatch(text, /content only/i);
  const vercel = findAll(page.els['cms-main'], (e) => e.tagName === 'A' && /issuecomment/.test(e.attrs.href || ''));
  assert.equal(vercel.length, 1);
  assert.deepEqual(actionButtons(page).map((b) => b.attrs['data-action']),
    ['approve', 'request-changes', 'merge', 'update', 'close']);
  assert.equal(actionButton(page, 'merge').attrs.disabled, undefined, 'green: Merge is live');
  assert.doesNotMatch(page.main(), /Merge anyway/, 'green asks no confirmation');
  // the preview: the first changed page, at the PR head, in a sandboxed frame
  const [frame] = findAll(page.els['cms-main'], (e) => e.tagName === 'IFRAME');
  assert.equal(frame.attrs.sandbox, 'allow-scripts allow-popups');
  const m = /^\.\.\/index\.html#preview=([0-9a-f]{32})&route=(.+)$/.exec(frame.src);
  assert.ok(m, frame.src);
  assert.equal(decodeURIComponent(m[2]), '/setup/concepts/colcon');
  const posted = [];
  frame.contentWindow = { postMessage: (msg) => posted.push(msg) };
  for (const fn of page.listeners.message) {
    fn({ source: frame.contentWindow, origin: 'null',
      data: { type: 'hc-fetch', nonce: m[1], id: 1, path: 'content/setup/concepts/colcon.md' } });
  }
  await settle();
  assert.equal(posted.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(posted[0])), { type: 'hc-file', nonce: m[1], id: 1, ok: true, status: 200,
    text: '# Colcon\n\nThe fixed text.' });
  assert.ok(!JSON.stringify(posted).includes(TOKEN_A), 'the token never reaches the frame');
  assert.ok(page.calls.some((c) => c.url === `${REPO_API}/contents/content/setup/concepts/colcon.md?ref=${HEAD_1}`));
  // navigable: another changed page re-loads the frame there with a fresh nonce
  const pick = findAll(page.els['cms-main'], (e) => e.attrs['data-route'] === '/setup/raspberry-pi/ethernet')[0];
  pick.click();
  const m2 = /#preview=([0-9a-f]{32})&route=(.+)$/.exec(frame.src);
  assert.notEqual(m2[1], m[1]);
  assert.equal(decodeURIComponent(m2[2]), '/setup/raspberry-pi/ethernet');
  assert.deepEqual(writes(page), [], 'looking writes nothing');
});

test('js/cms.js Review PR: a proposal that changes the site\'s code labels its preview "content only"', async () => {
  const files = PR1_FILES.concat([fileRow('js/app.js')]);
  const page = openCms({ session: { token: TOKEN_A, login: 'desert-mango-robotics' }, hash: '#/review/1',
    github: reviewGithub({ login: 'desert-mango-robotics', perms: { admin: true, push: true },
      pulls: { 1: greenPr1({ files }) }, contents: PR1_CONTENTS }) });
  await settle();
  const heads = findAll(page.els['cms-main'], (e) => e.tagName === 'H2').map((e) => e.textContent);
  assert.ok(heads.includes('Preview (content only)'), heads.join(' | '));
  assert.ok(!heads.includes('Preview'));
  const [area] = findAll(page.els['cms-main'], (e) => e.attrs.id === 'cms-preview-area');
  assert.ok(area.textContent.startsWith(C.PREVIEW_CONTENT_ONLY_TEXT), 'the note leads the preview area');
  // still a preview of the head's content, in the same sandboxed frame: no proposal code runs
  const [frame] = findAll(area, (e) => e.tagName === 'IFRAME');
  assert.match(frame.src, /^\.\.\/index\.html#preview=[0-9a-f]{32}&route=/);
  assert.deepEqual(writes(page), []);
});

test('js/cms.js Review PR: red ✗ with each annotation as "file, line, what to fix" and a link to the run', async () => {
  const red = greenPr1({ runs: runs(gateRun({ conclusion: 'failure' })), annotations: [
    { path: 'data/tools.json', start_line: 12, annotation_level: 'failure', message: 'trailing comma' },
    { path: 'content/about.md', start_line: null, annotation_level: 'failure', message: 'no title line' }] });
  const page = openCms({ session: { token: TOKEN_A, login: 'nathalie' }, hash: '#/review/1',
    github: reviewGithub({ login: 'nathalie', perms: { maintain: true, push: true }, pulls: { 1: red },
      contents: PR1_CONTENTS }) });
  await settle();
  const text = page.main();
  assert.match(text, /✗site rules fail/);
  assert.match(text, /data\/tools\.json, line 12: trailing comma/);
  assert.match(text, /content\/about\.md: no title line/);
  assert.ok(page.calls.some((c) => c.url === `${REPO_API}/check-runs/106444242358/annotations?per_page=100&page=1`));
  assert.equal(findAll(page.els['cms-main'], (e) => e.tagName === 'A' && e.attrs.href === RUN_URL).length, 1);
  await confirmThenMerge(page, HEAD_1);
});

/* Red or still checking: Merge is live; the first click sends nothing and
   asks once; "Merge anyway" sends exactly the one PUT, pinned to the sha. */
async function confirmThenMerge(page, sha) {
  const merge = actionButton(page, 'merge');
  assert.equal(merge.attrs.disabled, undefined, 'Merge is never disabled');
  assert.doesNotMatch(page.main(), /Merge anyway/);
  merge.click();
  await settle();
  assert.deepEqual(writes(page), [], 'the first click sends nothing');
  assert.match(page.main(), new RegExp(C.MERGE_CONFIRM_TEXT.replace(/[.()?]/g, '\\$&')));
  const anyway = actionButton(page, 'merge-anyway');
  assert.equal(anyway.textContent, 'Merge anyway');
  anyway.click();
  await settle();
  assert.deepEqual(writes(page).map((c) => [c.init.method, c.url, JSON.parse(c.init.body)]),
    [['PUT', `${REPO_API}/pulls/1/merge`, { merge_method: 'squash', sha }]]);
}

test('js/cms.js Review PR: no finished run yet is "still checking", and asks for no annotations', async () => {
  const waiting = greenPr1({ runs: runs(gateRun({ status: 'in_progress', conclusion: null })) });
  const page = openCms({ session: { token: TOKEN_A, login: 'nathalie' }, hash: '#/review/1',
    github: reviewGithub({ login: 'nathalie', perms: { push: true }, pulls: { 1: waiting }, contents: PR1_CONTENTS }) });
  await settle();
  assert.match(page.main(), /still checking/);
  const boss = openCms({ session: { token: TOKEN_A, login: 'nathalie' }, hash: '#/review/1',
    github: reviewGithub({ login: 'nathalie', perms: { maintain: true, push: true }, pulls: { 1: waiting },
      contents: PR1_CONTENTS }) });
  await settle();
  await confirmThenMerge(boss, HEAD_1);
  assert.ok(!page.calls.some((c) => c.url.includes('/annotations')));
  assert.deepEqual(actionButtons(page).map((b) => b.attrs['data-action']),
    ['approve', 'request-changes', 'update', 'close'], 'an Editor gets no Merge button');
});

test('js/cms.js Review PR: Merge sends exactly one PUT pinned to the shown sha; a 409 says reload', async () => {
  const pr = greenPr1();
  const seen = [];
  const page = openCms({ session: { token: TOKEN_A, login: 'desert-mango-robotics' }, hash: '#/review/1',
    github: reviewGithub({ login: 'desert-mango-robotics', perms: { admin: true, push: true }, pulls: { 1: pr },
      contents: PR1_CONTENTS,
      onWrite: (method, url, body) => { seen.push({ method, url, body }); return reply(409, { message: 'Head branch was modified.' }); } }) });
  await settle();
  const before = page.calls.filter((c) => c.url === `${REPO_API}/pulls/1`).length;
  actionButton(page, 'merge').click();                    // green: one click, one PUT
  await settle();
  assert.deepEqual(seen, [{ method: 'PUT', url: `${REPO_API}/pulls/1/merge`, body: { merge_method: 'squash', sha: HEAD_1 } }]);
  assert.equal(actionButton(page, 'merge-anyway'), undefined, 'no confirmation step on green');
  assert.equal(writes(page).length, 1);
  assert.equal(bearer(writes(page)[0].init), TOKEN_A);
  assert.match(page.main(), /Not merged: it changed since you looked, reload\./);
  assert.equal(page.calls.filter((c) => c.url === `${REPO_API}/pulls/1`).length, before + 1, 'the view was refreshed');
});

test('js/cms.js Review PR: approving your own proposal shows GitHub\'s refusal in the tab\'s words', async () => {
  const page = openCms({ session: { token: TOKEN_A, login: 'kyle-nelson-berkeley' }, hash: '#/review/1',
    github: reviewGithub({ login: 'kyle-nelson-berkeley', perms: { admin: true, push: true }, pulls: { 1: greenPr1() },
      contents: PR1_CONTENTS,
      onWrite: () => reply(422, { message: 'Unprocessable Entity', errors: ['Review Can not approve your own pull request'] }) }) });
  await settle();
  actionButton(page, 'approve').click();
  await settle();
  assert.deepEqual(writes(page).map((c) => [c.init.method, c.url, JSON.parse(c.init.body)]),
    [['POST', `${REPO_API}/pulls/1/reviews`, { event: 'APPROVE', commit_id: HEAD_1 }]]);
  assert.match(page.main(), /GitHub does not let you approve your own proposal\./);
});

test('js/cms.js Review PR: request changes needs a comment; close and update send their one write', async () => {
  const seen = [];
  const page = openCms({ session: { token: TOKEN_A, login: 'nathalie' }, hash: '#/review/1',
    github: reviewGithub({ login: 'nathalie', perms: { maintain: true, push: true }, pulls: { 1: greenPr1() },
      contents: PR1_CONTENTS,
      onWrite: (method, url, body) => { seen.push([method, url.slice(REPO_API.length), body]); return reply(200, {}); } }) });
  await settle();
  actionButton(page, 'request-changes').click();
  await settle();
  assert.deepEqual(seen, [], 'no comment, nothing sent');
  assert.match(page.main(), /write what should change/);
  const [box] = findAll(page.els['cms-main'], (e) => e.tagName === 'TEXTAREA');
  box.value = 'Please keep the old heading.';
  actionButton(page, 'request-changes').click();
  await settle();
  assert.match(page.main(), /Changes requested\./);
  actionButton(page, 'update').click();
  await settle();
  actionButton(page, 'close').click();
  await settle();
  assert.deepEqual(seen, [
    ['POST', '/pulls/1/reviews', { event: 'REQUEST_CHANGES', body: 'Please keep the old heading.', commit_id: HEAD_1 }],
    ['PUT', '/pulls/1/update-branch', { expected_head_sha: HEAD_1 }],
    ['PATCH', '/pulls/1', { state: 'closed' }],
  ]);
});

test('js/cms.js Review PR: Read-only sees the proposal and its preview, and no button at all', async () => {
  const page = openCms({ session: { token: TOKEN_A, login: 'visitor' }, hash: '#/review/1',
    github: reviewGithub({ login: 'visitor', perms: { pull: true }, pulls: { 1: greenPr1() }, contents: PR1_CONTENTS }) });
  await settle();
  assert.match(page.main(), /site rules pass/);
  assert.deepEqual(actionButtons(page), []);
  assert.equal(findAll(page.els['cms-main'], (e) => e.tagName === 'IFRAME').length, 1);
  assert.deepEqual(writes(page), []);
});

test('js/cms.js Review PR: a merged proposal offers one button, Undo on GitHub, and nothing else', async () => {
  const merged = { pull: openPull(3, 'alice', 'e'.repeat(40),
    { state: 'closed', merged: true, merged_at: '2026-09-20T10:00:00Z' }), files: [fileRow('content/about.md')] };
  const page = openCms({ session: { token: TOKEN_A, login: 'nathalie' }, hash: '#/review/3',
    github: reviewGithub({ login: 'nathalie', perms: { maintain: true, push: true }, pulls: { 3: merged } }) });
  await settle();
  const undo = actionButtons(page);
  assert.deepEqual(undo.map((b) => [b.tagName, b.attrs['data-action'], b.textContent, b.attrs.href]),
    [['A', 'undo', 'Undo on GitHub', 'https://github.com/desert-mango/hippocampus-docs/pull/3']]);
  assert.equal(undo[0].attrs.rel, 'noopener noreferrer');
  assert.match(page.main(), /Revert/);
  assert.ok(!page.calls.some((c) => c.url.includes('/check-runs')));
  assert.deepEqual(writes(page), []);
});

test('js/cms.js home: each recently merged proposal links to its Review page (where Undo is)', async () => {
  const closed = [openPull(3, 'alice', 'e'.repeat(40), { state: 'closed', merged: true,
    merged_at: '2026-09-20T10:00:00Z', updated_at: '2026-09-20T10:00:00Z', title: 'Fix the nav' })];
  const page = openCms({ session: { token: TOKEN_A, login: 'nathalie' },
    github: reviewGithub({ login: 'nathalie', perms: { push: true }, pulls: {}, closed }) });
  await settle();
  assert.match(page.main(), /Recently merged#3Fix the nav/);
  const links = findAll(page.els['cms-main'], (e) => e.tagName === 'A' && e.attrs.href === '#/review/3');
  assert.equal(links.length, 1);
});
