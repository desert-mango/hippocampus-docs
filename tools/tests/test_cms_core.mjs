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

   The last section runs js/cms.js itself in a vm context over a fake DOM, to
   pin what only the page can get wrong: a GitHub answer for a session that
   has since ended or been replaced changes nothing, and "Recently merged"
   pages the closed PRs.

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

test('GitHub client: only /user and this repository, GET only', () => {
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
  assert.deepEqual(C.createGitHubClient({ fetch: gh.fetch, token: TOKEN }).methods, ['GET']);
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

// -------------------------------------------------- source-level promises --

test('js/cms.js reaches GitHub only through cms-core and writes nothing anywhere', () => {
  const ui = fs.readFileSync(path.join(ROOT, 'js', 'cms.js'), 'utf8');
  assert.ok(!ui.includes('api.github.com'), 'the UI never builds an API URL itself');
  assert.ok(!/\b(POST|PUT|PATCH|DELETE)\b/.test(ui), 'the UI sends no write verb');
  // one wrapper hands window.fetch to the client and the sign-in; no other call
  const WRAPPER = 'const netFetch = (url, init) => window.fetch(url, init);';
  assert.equal(ui.split(WRAPPER).length, 2, 'exactly one fetch wrapper');
  assert.ok(!/\bfetch\s*\(/.test(ui.replace(WRAPPER, '').replace(/HC\.fetch(JSON|Text)\(/g, '')),
    'the UI calls no bare fetch (the client and the sign-in own the network)');
  assert.equal((ui.match(/\bnetFetch\b/g) || []).length, 4,
    'netFetch goes only to the sign-in and the GitHub clients');
  const core = fs.readFileSync(path.join(ROOT, 'js', 'cms-core.js'), 'utf8');
  const verbs = core.match(/method:\s*'[A-Z]+'/g) || [];
  assert.deepEqual([...new Set(verbs)].sort(), ["method: 'GET'", "method: 'POST'"]);
  assert.equal((core.match(/method:\s*'POST'/g) || []).length, 1, 'one POST: the sign-in exchange');
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
  const win = vm.createContext({
    document: {
      getElementById: (id) => els[id] || null,
      createElement: (tag) => new FakeElement(tag),
      createTextNode: (text) => ({ textContent: String(text) }),
      documentElement: new FakeElement('html'),
    },
    sessionStorage: storage,
    localStorage: memoryStorage(),
    location: { origin: ORIGIN, hash: '#/' },
    crypto: { getRandomValues: fakeRandom },
    fetch: (url, init) => {
      calls.push({ url: String(url), init: init || {} });
      return opts.github(String(url), init || {});
    },
    open: () => null,
    addEventListener: () => {},
    setInterval, clearInterval, setTimeout, clearTimeout,
  });
  win.window = win;
  for (const f of ['cms-core.js', 'cms.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), win, { filename: f });
  }
  return {
    els, storage, calls, win, putSession,
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
