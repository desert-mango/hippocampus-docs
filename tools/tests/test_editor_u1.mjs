// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 23 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test the U1 sign-in work in the editor: staying signed in, the same-tab fallback, sign-out keeping edits.
/* Made by U0 (editor UI/UX build) so unit U1 adds its tests here, not to a shared test file.
   U1 (ED1, ED2, ED29, ED63), in pairs where the plan asks for them:
     - D19 (ED1): cms/callback.html with no opener (the same-tab sign-in js/app.js starts when the pop-up is
       blocked) checks the saved state, POSTs the code to /api/auth itself and returns to the saved page;
     - D21 (ED63): sign-out only signs out: the login's unsent edits stay in this browser and come back at the
       next sign-in; no question first, and no "Leave site?" prompt (drafts are saved as they are typed);
     - D20: a resumed sign-in (js/app.js's cookie resume) boots the editor with the token in page memory only;
       a resumed token GitHub refuses clears the cookie; sign-out clears the cookie and tells every tab;
       a 'signed-out' message from another tab signs this one out without a second call.

     node --test tools/tests/test_editor_u1.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { openSite, settle, findAll, memoryStorage, TOKEN, ORIGIN } from './editor_harness.mjs';

const require = createRequire(import.meta.url);

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null },
  json: async () => body, text: async () => JSON.stringify(body) });

/* One browser's BroadcastChannel: every channel of a name hears the others, never itself. */
function channelBus() {
  const open = [];
  const posted = [];
  class FakeChannel {
    constructor(name) { this.name = name; this.fns = []; open.push(this); }
    addEventListener(type, fn) { if (type === 'message') this.fns.push(fn); }
    postMessage(data) {
      posted.push({ name: this.name, data });
      for (const ch of open) if (ch !== this && ch.name === this.name) ch.fns.forEach((f) => f({ data }));
    }
    close() { open.splice(open.indexOf(this), 1); }
  }
  return { FakeChannel, posted, open };
}

/* /api/auth as api/auth.js answers it; every call recorded. */
function authApi(log) {
  return (url, init) => {
    if (url.indexOf('/api/auth') !== 0) return null;
    const entry = { url, method: init.method || 'GET' };
    const ifToken = init.headers && init.headers['X-HC-If-Token'];
    if (ifToken !== undefined) entry.ifToken = ifToken;
    log.push(entry);
    if ((init.method || 'GET') === 'DELETE') return reply(200, { signed_out: true });
    return null;
  };
}

function site(opts) {
  const o = opts || {};
  const bus = o.bus || channelBus();
  const log = o.log || [];
  const page = openSite(Object.assign({
    afterScript: (file, win) => { if (file === 'js/marked.min.js') win.BroadcastChannel = bus.FakeChannel; },
    intercept: (url, init) => (o.intercept && o.intercept(url, init)) || authApi(log)(url, init),
  }, o.site));
  return { page, bus, log };
}

const controlsOf = (page) => findAll(page.body, (c) => c.classList.contains('hc-editor-controls'))[0];
const RESUMED = Object.freeze({ token: TOKEN, expiresIn: 3600 });
const allValues = (st) => [...st.raw.values()].join('\n');

// ------------------------------------------------------- D20: the resume ---

test('D20: a resumed sign-in asks GitHub who this is, keeps the token in page memory only, and leaves Editor off', async () => {
  const storage = memoryStorage();
  const { page, log } = site({ site: { session: null, storage, start: { resumed: RESUMED } } });
  assert.equal(page.started, true, 'a resumed token boots the editor');
  await settle();
  assert.ok(page.calls.some((c) => c.url === 'https://api.github.com/user'), 'who is this');
  assert.equal(controlsOf(page).hidden, false, 'signed in: the controls show');
  assert.equal(page.sessions.at(-1), true, 'app.js hears the sign-in');
  assert.equal(page.switchBtn().getAttribute('aria-checked'), 'false', 'a reload does not force Editor mode on');
  const s = page.win.HCCore.readSession(storage, Date.now());
  assert.equal(s.token, TOKEN);
  assert.ok(s.expiresAt > Date.now(), 'the expiry rides along');
  assert.ok(!allValues(storage).includes(TOKEN), 'the token is in no sessionStorage value');
  assert.ok(!allValues(page.local).includes(TOKEN), 'nor in localStorage');
  assert.deepEqual(log, [], 'the resume itself is app.js\'s; the editor calls /api/auth for nothing');
});

/* Fix round 2 (the walk's ?auth=cookie step "on"): the switch is drawn before GitHub has said who this is;
   it must be off (disabled) until access is confirmed, or a click does nothing and the switch looks broken. */
test('D20: while a resume waits for GitHub\'s /user, the Editor switch is disabled; it enables once access is confirmed', async () => {
  let release = null;
  let heldInit = null;
  const held = new Promise((r) => { release = r; });
  const { page } = site({ site: { session: null, start: { resumed: RESUMED } },
    intercept: (url, init) => {
      if (url !== 'https://api.github.com/user' || !release) return null;
      heldInit = init;
      return held;
    } });
  assert.equal(page.started, true);
  assert.equal(page.switchBtn().disabled, true, 'no access yet: the switch cannot be clicked');
  page.switchBtn().click();
  await settle();
  assert.equal(page.switchBtn().getAttribute('aria-checked'), 'false');
  const r = release;
  release = null;              // the held call answers; every later /user goes to the fake GitHub
  r(page.win.fetch('https://api.github.com/user', heldInit));
  await settle();
  assert.equal(page.switchBtn().disabled, false, 'access confirmed: the switch works');
  page.switchBtn().click();
  await settle();
  assert.equal(page.switchBtn().getAttribute('aria-checked'), 'true');
});

test('D20: a resumed sign-in restores the tab\'s Editor setting (it was on: it comes back on)', async () => {
  const storage = memoryStorage();
  storage.setItem('hc-editor', JSON.stringify({ on: true, tray: false }));
  const { page } = site({ site: { session: null, storage, start: { resumed: RESUMED } } });
  await settle();
  assert.equal(page.switchBtn().getAttribute('aria-checked'), 'true');
});

test('D20: with nothing to resume and no click, the editor does not start', () => {
  const { page } = site({ site: { session: null, start: { resumed: { token: '' } } } });
  assert.equal(page.started, false);
});

test('D20: a resumed token GitHub refuses (401) clears the cookie, and the page is a guest\'s again', async () => {
  const { page, log } = site({ site: { session: null, start: { resumed: RESUMED } },
    intercept: (url) => (url === 'https://api.github.com/user' ? reply(401, { message: 'Bad credentials' }) : null) });
  await settle();
  assert.deepEqual(log.map((x) => `${x.method} ${x.url}`), ['DELETE /api/auth'], 'the dead cookie goes');
  assert.equal(page.sessions.at(-1), false, 'app.js shows "Sign in" again');
  assert.equal(controlsOf(page).hidden, true);
  assert.match(page.told.at(-1).text, /sign-in has ended/);
  assert.equal(page.win.HCCore.readSession(page.storage, Date.now()), null);
});

test('D20: GitHub unreachable on a resume keeps the cookie (a reload tries again)', async () => {
  const { page, log } = site({ site: { session: null, start: { resumed: RESUMED } },
    intercept: (url) => (url === 'https://api.github.com/user' ? reply(503, {}) : null) });
  await settle();
  assert.deepEqual(log, [], 'no sign-out for a GitHub hiccup');
  assert.equal(page.sessions.at(-1), false);
  assert.match(page.told.at(-1).text, /Reload/);
});

/* A pop-up sign-in (not a resume) whose fresh token GitHub then refuses: the POST
   already set the session cookie, so a 401 clears it too — a reload must not resume
   a dead token. GitHub unreachable keeps it, as on a resume. */
async function popupSignIn(userStatus) {
  const popup = { closed: false, location: { href: 'about:blank' }, close() { this.closed = true; } };
  const auth = (url, init) => {
    if (url.indexOf('/api/auth') !== 0) return null;
    const method = init.method || 'GET';
    if (method === 'GET') return reply(200, { client_id: 'Iv1.placeholder' });
    if (method === 'POST') return reply(200, { token: TOKEN, expires_in: 28800 });
    return null;                 // DELETE: authApi records it
  };
  const { page, log } = site({ site: { session: null, start: { popup } },
    intercept: (url, init) => auth(url, init)
      || (url === 'https://api.github.com/user' ? reply(userStatus, { message: 'no' }) : null) });
  await settle();
  const state = new URL(popup.location.href).searchParams.get('state');
  for (const fn of page.listeners.message || []) fn({ source: popup, origin: ORIGIN, data: { type: 'hc-code', code: 'c0de', state } });
  await settle();
  return { page, log };
}

test('D20: a pop-up sign-in whose token GitHub refuses (401) clears the cookie the sign-in just set', async () => {
  const { page, log } = await popupSignIn(401);
  assert.deepEqual(log.map((x) => `${x.method} ${x.url}`), ['DELETE /api/auth'], 'the dead cookie goes');
  assert.equal(page.win.HCCore.readSession(page.storage, Date.now()), null, 'nobody is signed in');
  assert.match(page.told.at(-1).text, /did not say who you are/);
});

test('D20: a pop-up sign-in with GitHub unreachable (503) keeps the cookie (a reload tries again)', async () => {
  const { page, log } = await popupSignIn(503);
  assert.deepEqual(log, [], 'no sign-out for a GitHub hiccup');
  assert.match(page.told.at(-1).text, /did not say who you are/);
});

// ------------------------------------------- D20: sign-out, in every tab ---

test('D20: sign-out clears the cookie at the server and tells every other tab; a tab without a session stays quiet', async () => {
  const bus = channelBus();
  const log = [];
  const a = site({ bus, log, site: { session: null, start: { resumed: RESUMED } } }).page;
  const b = site({ bus, log, site: { session: null, start: { resumed: RESUMED } } }).page;
  await settle();
  b.switchBtn().click();
  await settle();
  assert.equal(b.switchBtn().getAttribute('aria-checked'), 'true', 'tab B has Editor on');
  a.action('sign-out').click();
  await settle();
  assert.deepEqual(log.map((x) => `${x.method} ${x.url}`), ['DELETE /api/auth'], 'one sign-out call, from tab A');
  assert.deepEqual(JSON.parse(JSON.stringify(bus.posted.map((p) => [p.name, p.data]))), [['hc-session', { type: 'signed-out' }]]);
  assert.equal(a.sessions.at(-1), false);
  assert.match(a.told.at(-1).text, /^Signed out\.$/);
  // tab B heard it: Editor off, signed out, no second call
  assert.equal(b.sessions.at(-1), false, 'tab B is signed out too');
  assert.equal(controlsOf(b).hidden, true);
  assert.equal(b.body.classList.contains('hc-editor-on'), false, 'Editor mode is off in tab B');
  assert.equal(b.win.HCCore.readSession(b.storage, Date.now()), null, 'tab B dropped its token');
  assert.match(b.told.at(-1).text, /another tab/);
  assert.equal(bus.posted.length, 1, 'tab B does not echo it');
});

test('D20: a signed-out message reaching a tab that is already signed out changes nothing', async () => {
  const bus = channelBus();
  const quiet = site({ bus, site: { session: null, start: { popup: { closed: false, location: { href: '' }, close() {} } } } }).page;
  await settle();
  const told = quiet.told.length;
  new bus.FakeChannel('hc-session').postMessage({ type: 'signed-out' });
  await settle();
  assert.equal(quiet.told.length, told, 'nothing said');
});

// ---------------- security review (U1 fix round 3): a 401 never signs out a newer sign-in ---

const sha256hex = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
const OTHER = 'ghu_aNewerSignInToken000000000';
const tokenOf = (init) => String((init.headers && (init.headers.Authorization || init.headers.authorization)) || '')
  .replace(/^Bearer /, '');

test('D20 fix: a 401 sends DELETE with X-HC-If-Token = sha256 of the dead token and broadcasts only its fingerprint', async () => {
  const { page, log, bus } = site({ site: { session: null, start: { resumed: RESUMED } },
    intercept: (url) => (url === 'https://api.github.com/user' ? reply(401, { message: 'Bad credentials' }) : null) });
  await settle();
  assert.deepEqual(log, [{ url: '/api/auth', method: 'DELETE', ifToken: sha256hex(TOKEN) }], 'a guarded DELETE, header only');
  assert.deepEqual(JSON.parse(JSON.stringify(bus.posted.map((p) => p.data))),
    [{ type: 'signed-out', fp: sha256hex(TOKEN).slice(0, 16) }], 'no token: its fingerprint');
  assert.equal(page.win.HCCore.readSession(page.storage, Date.now()), null);
});

test('D20 fix: explicit Sign out stays a plain DELETE (no X-HC-If-Token) and a broadcast without fp', async () => {
  const { page, log, bus } = site({ site: { session: null, start: { resumed: RESUMED } } });
  await settle();
  page.action('sign-out').click();
  await settle();
  assert.deepEqual(log, [{ url: '/api/auth', method: 'DELETE' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(bus.posted.map((p) => p.data))), [{ type: 'signed-out' }]);
});

test('D20 fix: an fp broadcast drops the session only in tabs holding that token; a tab with another token keeps it', async () => {
  const bus = channelBus();
  const log = [];
  let refused = false;
  const github = (url, init) => (url === 'https://api.github.com/user' && refused && tokenOf(init) === TOKEN
    ? reply(401, { message: 'Bad credentials' }) : null);
  const newer = site({ bus, log, intercept: github,
    site: { session: null, start: { resumed: { token: OTHER, expiresIn: 3600 } } } }).page;
  const same = site({ bus, log, intercept: github, site: { session: null, start: { resumed: RESUMED } } }).page;
  await settle();
  assert.equal(newer.sessions.at(-1), true, 'the newer sign-in is in');
  assert.equal(same.sessions.at(-1), true);
  refused = true;
  site({ bus, log, intercept: github, site: { session: null, start: { resumed: RESUMED } } });
  await settle();
  assert.deepEqual(log.map((x) => x.ifToken), [sha256hex(TOKEN)], 'one guarded DELETE, from the refused tab only');
  assert.equal(newer.sessions.at(-1), true, 'another token: the broadcast is ignored');
  assert.equal(controlsOf(newer).hidden, false, 'still signed in');
  assert.equal(same.sessions.at(-1), false, 'the same token: dropped');
  assert.equal(controlsOf(same).hidden, true);
  assert.match(same.told.at(-1).text, /sign-in has ended/);
});

test('D20 fix: without crypto.subtle the 401 path sends no DELETE and no broadcast; it only drops the memory session', async () => {
  const bus = channelBus();
  const { page, log } = site({ bus, site: { session: null, start: { resumed: RESUMED },
    afterScript: (file, win) => { if (file === 'js/marked.min.js') { win.BroadcastChannel = bus.FakeChannel; win.crypto.subtle = undefined; } } },
    intercept: (url) => (url === 'https://api.github.com/user' ? reply(401, { message: 'Bad credentials' }) : null) });
  await settle();
  assert.deepEqual(log, [], 'a plain DELETE would sign out a newer sign-in: none is sent');
  assert.deepEqual(bus.posted, []);
  assert.equal(page.sessions.at(-1), false);
  assert.match(page.told.at(-1).text, /sign-in has ended/);
});

// ------------------------------------------ D19 (ED1): the same-tab callback ---

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const CALLBACK_SRC = fs.readFileSync(path.join(ROOT, 'js', 'cms-callback.js'), 'utf8');

/* cms/callback.html's script in a vm, as GitHub lands the tab on it. opts: search, opener (default none),
   saved (the sessionStorage entry js/app.js wrote, or undefined), answer (the POST's status, default 200). */
async function landCallback(opts) {
  const o = opts || {};
  const store = new Map();
  if (o.saved !== undefined) store.set('hc-signin-same-tab', typeof o.saved === 'string' ? o.saved : JSON.stringify(o.saved));
  const posts = [];
  const went = [];
  const el = { textContent: '' };
  const win = {
    location: { search: o.search, origin: 'https://docs.example.org', pathname: '/cms/callback.html',
      replace: (u) => went.push(String(u)) },
    opener: o.opener || null,
    close: () => {},
    history: { replaceState: () => {} },
    sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k) },
    fetch: async (url, init) => {
      posts.push({ url: String(url), init });
      const status = o.answer === undefined ? 200 : o.answer;
      return { ok: status >= 200 && status < 300, status, json: async () => ({ token: 'never read' }) };
    },
    Date,
    JSON,
  };
  const ctx = Object.assign({}, win, { window: win, document: { getElementById: (id) => (id === 'status' ? el : null) },
    URLSearchParams });
  vm.runInNewContext(CALLBACK_SRC, ctx);
  await settle();
  return { posts, went, store, status: () => el.textContent };
}

const SAVED = (extra) => Object.assign({ state: 's'.repeat(32), route: '#/setup/lab-gantry/usage', at: Date.now() }, extra);

test('D19: no opener + the saved state matches: the code is POSTed to /api/auth, the state is spent, and the tab returns to the saved page', async () => {
  const r = await landCallback({ search: `?code=abc123&state=${'s'.repeat(32)}`, saved: SAVED() });
  assert.equal(r.posts.length, 1);
  assert.equal(r.posts[0].url, '/api/auth');
  assert.equal(r.posts[0].init.method, 'POST');
  assert.equal(r.posts[0].init.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(r.posts[0].init.body), { code: 'abc123', app: 'editor' });
  assert.ok(!r.store.has('hc-signin-same-tab'), 'the state is single use');
  assert.deepEqual(r.went, ['https://docs.example.org/#/setup/lab-gantry/usage'], 'back to where the click was');
});

test('D19: a state that does not match, a stale one, or none saved: nothing is POSTed and nobody is signed in', async () => {
  for (const saved of [SAVED({ state: 'x'.repeat(32) }), SAVED({ at: Date.now() - 11 * 60 * 1000 }), undefined, 'not json',
    SAVED({ state: '' })]) {
    const r = await landCallback({ search: `?code=abc123&state=${'s'.repeat(32)}`, saved });
    assert.equal(r.posts.length, 0, JSON.stringify(saved));
    assert.deepEqual(r.went, []);
    assert.ok(r.status().length > 0, 'the page says what happened');
    assert.ok(!r.store.has('hc-signin-same-tab'), 'a bad state is dropped too');
  }
});

test('D19: a saved route that is not a site page returns to the home page, never elsewhere', async () => {
  for (const route of ['https://evil.example/', '//evil.example', 'javascript:alert(1)', '#/a b', 5]) {
    const r = await landCallback({ search: `?code=abc123&state=${'s'.repeat(32)}`, saved: SAVED({ route }) });
    assert.deepEqual(r.went, ['https://docs.example.org/#/'], JSON.stringify(route));
  }
});

test('D19: GitHub cancelled (no code) in the same tab: back to the saved page, nothing POSTed; a refused exchange stays and says so', async () => {
  const cancel = await landCallback({ search: `?error=access_denied&state=${'s'.repeat(32)}`, saved: SAVED() });
  assert.equal(cancel.posts.length, 0);
  assert.deepEqual(cancel.went, ['https://docs.example.org/#/setup/lab-gantry/usage']);
  const refused = await landCallback({ search: `?code=abc123&state=${'s'.repeat(32)}`, saved: SAVED(), answer: 502 });
  assert.equal(refused.posts.length, 1);
  assert.deepEqual(refused.went, []);
  assert.match(refused.status(), /sign in again/i);
});

test('D19: with an opener (the pop-up) the callback still only posts the code to it and never touches storage or the server', async () => {
  const posted = [];
  const opener = { closed: false, postMessage: (m, origin) => posted.push([m, origin]) };
  const r = await landCallback({ search: `?code=abc123&state=${'s'.repeat(32)}`, saved: SAVED(), opener });
  assert.equal(posted.length, 1);
  assert.equal(r.posts.length, 0);
  assert.ok(r.store.has('hc-signin-same-tab'), 'the pop-up path leaves the same-tab entry alone');
});

// --------------------------------------------- D21 (ED63): sign-out keeps edits ---

const ROOT_DIR = path.resolve(new URL('../..', import.meta.url).pathname);
const C = require(path.join(ROOT_DIR, 'js', 'cms-core.js'));
const PAGE_ROUTE = '/setup/hippocampus-bringup/fcu-firmware';
const PAGE_ID = 'setup/hippocampus-bringup/fcu-firmware';
const PAGE_TEXT = fs.readFileSync(path.join(ROOT_DIR, 'content/setup/hippocampus-bringup/fcu-firmware.md'), 'utf8');
const draftsOf = (page, login) => C.createDraftStore(page.local, C.draftsKey(login || 'bob'));
const countText = (page) => page.one((e) => e.attrs['data-dock-count'] !== undefined).textContent;

async function editingWithDraft(opts) {
  const { page, log, bus } = site(Object.assign({}, opts, { site: Object.assign({ hash: `#${PAGE_ROUTE}` }, opts && opts.site) }));
  await settle();
  page.switchBtn().click();
  await settle();
  const blocks = C.splitBlocks(PAGE_TEXT).blocks;
  const i = blocks.findIndex((b) => b.kind === 'paragraph');
  await page.pick(i);
  await page.typeIn(i, `${blocks[i].text.trimEnd()} One more line.\n\n`);
  assert.ok(draftsOf(page).get(PAGE_ID), 'a draft is kept');
  return { page, log, bus };
}

test('D21 (ED63): sign-out keeps the unsent edits and asks nothing; the next sign-in brings them back', async () => {
  const { page } = await editingWithDraft();
  page.action('sign-out').click();
  await settle();
  assert.deepEqual(page.confirms, [], 'no "deletes N changes" question');
  assert.equal(page.sessions.at(-1), false, 'signed out');
  assert.ok(draftsOf(page).get(PAGE_ID), 'the draft stays in this browser');
  // the same person signs in again (a new tab on the same browser)
  const again = site({ site: { hash: `#${PAGE_ROUTE}`, localStorage: page.local } }).page;
  await settle();
  again.switchBtn().click();
  await settle();
  assert.match(countText(again), /1 change/, 'the unsent edit is back');
  // someone else on this browser sees none of it
  const other = site({ site: { hash: `#${PAGE_ROUTE}`, localStorage: page.local,
    session: C.makeSession(TOKEN, null, 'alice', Date.now()) } }).page;
  await settle();
  assert.equal(draftsOf(other, 'alice').list().length, 0);
});

test('D21 (ED63): no beforeunload prompt is installed, and drafts survive endSession (GitHub ends the sign-in)', async () => {
  let dead = false;
  const { page } = await editingWithDraft({
    intercept: (url) => (dead && url.indexOf('https://api.github.com/') === 0 ? reply(401, { message: 'Bad credentials' }) : null) });
  assert.deepEqual(page.listeners.beforeunload || [], [], 'no beforeunload handler at all');
  dead = true;
  await page.win.HCEditor.refresh();
  await settle();
  assert.ok(page.told.some((t) => /sign-in has ended/.test(t.text)), 'the session ended');
  assert.equal(page.sessions.at(-1), false);
  assert.ok(draftsOf(page).get(PAGE_ID), 'the draft survived the ended session');
  assert.deepEqual(page.listeners.beforeunload || [], []);
});
