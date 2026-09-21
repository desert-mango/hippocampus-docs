// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 21 September 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test the GitHub sign-in code exchange, its callback page, and dev_site's api routing.
/* Unit tests for api/auth.js — the CMS's GitHub App code-for-token exchange —
   plus the two pieces around it: the popup landing page (cms/callback.html +
   js/cms-callback.js) and tools/dev_site.mjs's "every api/*.js" routing and
   .env.local loading.

   Every GitHub call here is a FAKE fetch. Nothing in this file reaches the
   network, and no real client id, secret, code or token appears in it: the
   values below are obvious placeholders, and the tests assert that the secret
   and the token never leak into a response body or a console line.

     node --test tools/tests/test_auth_handler.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const handler = require(path.join(ROOT, 'api', 'auth.js'));

const HOST = 'docs.example.org';
const ORIGIN = `https://${HOST}`;
const CODE = 'fake-code-5f1e2d';
const TOKEN = 'ghu_fakeTokenValue0000000000';
const SECRET = 'fake-editor-secret-9a8b7c';
const VIEWER_SECRET = 'fake-viewer-secret-1a2b3c';
const ENV = {
  GH_APP_CLIENT_ID: 'Iv1.fakeeditorid',
  GH_APP_CLIENT_SECRET: SECRET,
};

// ---------------------------------------------------------------- fixtures --

function makeReq(method, body, headers, url) {
  const raw = body === undefined ? ''
    : (typeof body === 'string' ? body : JSON.stringify(body));
  const req = Readable.from(raw ? [Buffer.from(raw, 'utf8')] : []);
  req.method = method;
  req.url = url || '/api/auth';
  req.headers = Object.assign(
    { 'content-type': 'application/json', host: HOST, origin: ORIGIN },
    headers || {});
  for (const [k, v] of Object.entries(req.headers)) if (v === undefined) delete req.headers[k];
  return req;   // deliberately no .body / .query / .cookies (raw Node, like the librarian)
}

function makeRes() {
  const out = { code: 0, headers: {}, body: '' };
  out.done = new Promise((resolve) => { out.settle = resolve; });
  out.writeHead = (code, headers) => {
    out.code = code;
    out.headers = Object.assign({}, out.headers, headers || {});
    return out;
  };
  out.end = (chunk) => { if (chunk) out.body += String(chunk); out.settle(out); return out; };
  const bang = (name) => () => { throw new Error(`handler used the Vercel helper res.${name}()`); };
  out.status = bang('status');
  out.json = bang('json');
  out.send = bang('send');
  return out;
}

/* A fake GitHub. Records every call; answers with the given status and body. */
function fakeGitHub(status, payload) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  };
  return { fetch, calls };
}

const GOOD = { access_token: TOKEN, token_type: 'bearer', scope: '', expires_in: 28800,
  refresh_token: 'ghr_fakeRefresh000', refresh_token_expires_in: 15811200 };

/* Runs the handler with console capture, so a test can prove nothing sensitive
   was logged on ANY path. */
async function run(body, opts) {
  const o = opts || {};
  const gh = o.gh || fakeGitHub(200, GOOD);
  const res = makeRes();
  const lines = [];
  const saved = {};
  for (const name of ['log', 'info', 'warn', 'error', 'debug']) {
    saved[name] = console[name];
    console[name] = (...a) => { lines.push(a.map(String).join(' ')); };
  }
  try {
    await handler(makeReq(o.method || 'POST', body, o.headers, o.url), res,
      { env: o.env || ENV, fetch: gh.fetch, timeoutMs: o.timeoutMs });
    await res.done;
  } finally {
    for (const name of Object.keys(saved)) console[name] = saved[name];
  }
  let json = null;
  try { json = JSON.parse(res.body); } catch (e) { json = null; }
  return { res, json, calls: gh.calls, logs: lines.join('\n') };
}

function assertClean(r) {
  for (const needle of [SECRET, VIEWER_SECRET, CODE, TOKEN]) {
    assert.ok(!r.logs.includes(needle), `a log line carried ${needle}`);
  }
  for (const needle of [SECRET, VIEWER_SECRET]) {
    assert.ok(!r.res.body.includes(needle), 'the response body carried a client secret');
  }
}

// ------------------------------------------------------------- happy path --

test('happy path: the code is exchanged and only {token, expires_in} comes back', async () => {
  const r = await run({ code: CODE, app: 'editor' });
  assert.equal(r.res.code, 200);
  assert.deepEqual(r.json, { token: TOKEN, expires_in: 28800 });
  assert.equal(r.res.headers['cache-control'], 'no-store');
  assert.match(r.res.headers['content-type'], /^application\/json/);
  assert.ok(!r.res.body.includes('ghr_'), 'the refresh token must never reach the browser');
  assertClean(r);
});

test('the request to GitHub carries id, secret, code, redirect_uri and Accept: json', async () => {
  const r = await run({ code: CODE, app: 'editor' });
  assert.equal(r.calls.length, 1);
  const call = r.calls[0];
  assert.equal(call.url, 'https://github.com/login/oauth/access_token');
  assert.equal(call.init.method, 'POST');
  const headers = Object.fromEntries(
    Object.entries(call.init.headers).map(([k, v]) => [k.toLowerCase(), v]));
  assert.equal(headers.accept, 'application/json');
  const sent = new URLSearchParams(String(call.init.body));
  assert.equal(sent.get('client_id'), ENV.GH_APP_CLIENT_ID);
  assert.equal(sent.get('client_secret'), SECRET);
  assert.equal(sent.get('code'), CODE);
  assert.equal(sent.get('redirect_uri'), `${ORIGIN}/cms/callback.html`);
});

test('redirect_uri follows the verified origin (the localhost dev callback)', async () => {
  const r = await run({ code: CODE, app: 'editor' },
    { headers: { host: 'localhost:8131', origin: 'http://localhost:8131' } });
  assert.equal(r.res.code, 200);
  const sent = new URLSearchParams(String(r.calls[0].init.body));
  assert.equal(sent.get('redirect_uri'), 'http://localhost:8131/cms/callback.html');
});

test('a token without expiry answers expires_in: null rather than inventing one', async () => {
  const r = await run({ code: CODE, app: 'editor' },
    { gh: fakeGitHub(200, { access_token: TOKEN, token_type: 'bearer' }) });
  assert.equal(r.res.code, 200);
  assert.deepEqual(r.json, { token: TOKEN, expires_in: null });
});

// ------------------------------------------------------------------ origin --

test('a wrong Origin is refused with 403 before GitHub is called', async () => {
  const r = await run({ code: CODE, app: 'editor' },
    { headers: { origin: 'https://evil.example.com' } });
  assert.equal(r.res.code, 403);
  assert.equal(r.calls.length, 0);
  assertClean(r);
});

test('a missing Origin is refused with 403 (a browser POST always sends one)', async () => {
  const r = await run({ code: CODE, app: 'editor' }, { headers: { origin: undefined } });
  assert.equal(r.res.code, 403);
  assert.equal(r.calls.length, 0);
});

test('an opaque "null" Origin is refused with 403', async () => {
  const r = await run({ code: CODE, app: 'editor' }, { headers: { origin: 'null' } });
  assert.equal(r.res.code, 403);
});

test('same hostname on another port or scheme is not the own origin', async () => {
  const port = await run({ code: CODE, app: 'editor' },
    { headers: { host: 'localhost:8131', origin: 'http://localhost:9999' } });
  assert.equal(port.res.code, 403);
  const scheme = await run({ code: CODE, app: 'editor' },
    { headers: { origin: `http://${HOST}` } });
  assert.equal(scheme.res.code, 403, 'a non-local host is https only');
  assert.equal(port.calls.length + scheme.calls.length, 0);
});

test('an Origin carrying a path or credentials is refused', async () => {
  for (const origin of [`${ORIGIN}/cms`, `https://user@${HOST}`]) {
    const r = await run({ code: CODE, app: 'editor' }, { headers: { origin } });
    assert.equal(r.res.code, 403, origin);
  }
});

// ------------------------------------------------------------------- input --

test('a method other than GET or POST is 405 with Allow: GET, POST', async () => {
  for (const method of ['PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
    const r = await run(undefined, { method, url: '/api/auth?app=editor' });
    assert.equal(r.res.code, 405, method);
    assert.equal(r.res.headers.allow, 'GET, POST', method);
    assert.equal(r.calls.length, 0);
  }
});

// ------------------------------------------------- GET: the public client id --
// The CMS page needs the App's client id to build GitHub's authorize URL. The id
// is public by design (it rides in that URL); the secret never leaves the function.

test('GET ?app=editor answers {client_id} and nothing else — never the secret', async () => {
  const r = await run(undefined, { method: 'GET', url: '/api/auth?app=editor' });
  assert.equal(r.res.code, 200);
  assert.deepEqual(r.json, { client_id: ENV.GH_APP_CLIENT_ID });
  assert.equal(r.res.headers['cache-control'], 'no-store');
  assert.match(r.res.headers['content-type'], /^application\/json/);
  assert.equal(r.calls.length, 0, 'GitHub is never asked for a public id');
  assertClean(r);
});

test('GET: a same-origin browser fetch carries no Origin; Sec-Fetch-Site: same-origin stands in', async () => {
  const r = await run(undefined, { method: 'GET', url: '/api/auth?app=editor',
    headers: { origin: undefined, 'sec-fetch-site': 'same-origin' } });
  assert.equal(r.res.code, 200);
  assert.deepEqual(r.json, { client_id: ENV.GH_APP_CLIENT_ID });
});

test('GET: the same Origin rule as the POST — foreign, cross-site or bare callers get 403', async () => {
  const cases = [
    { origin: 'https://evil.example.com' },
    { origin: 'null' },
    { origin: `http://${HOST}` },                                   // https only off localhost
    { origin: 'https://evil.example.com', 'sec-fetch-site': 'same-origin' },  // a present Origin rules
    { origin: undefined, 'sec-fetch-site': 'cross-site' },
    { origin: undefined, 'sec-fetch-site': 'same-site' },
    { origin: undefined, 'sec-fetch-site': 'none' },                // typed into the address bar
    { origin: undefined },                                          // curl: no browser headers at all
  ];
  for (const headers of cases) {
    const r = await run(undefined, { method: 'GET', url: '/api/auth?app=editor', headers });
    assert.equal(r.res.code, 403, JSON.stringify(headers));
    assert.ok(!r.res.body.includes(ENV.GH_APP_CLIENT_ID), 'a refused caller learns nothing');
    assertClean(r);
  }
});

test('GET: an unconfigured app is a clean 400 "not configured"; a bad app is 400', async () => {
  for (const env of [{}, { GH_APP_CLIENT_ID: 'Iv1.fakeeditorid' }]) {   // the id alone is not a working sign-in
    const r = await run(undefined, { method: 'GET', url: '/api/auth?app=editor', env });
    assert.equal(r.res.code, 400);
    assert.match(r.json.error, /not configured/);
    assert.equal(r.json.client_id, undefined);
  }
  for (const url of ['/api/auth', '/api/auth?app=', '/api/auth?app=admin', '/api/auth?app=__proto__',
    '/api/auth?app=constructor']) {
    const r = await run(undefined, { method: 'GET', url });
    assert.equal(r.res.code, 400, url);
    assert.match(r.json.error, /app must be/);
  }
  const viewer = await run(undefined, { method: 'GET', url: '/api/auth?app=viewer' });
  assert.equal(viewer.res.code, 400);
  assert.match(viewer.json.error, /not configured/);
  const env = Object.assign({}, ENV,
    { GH_VIEWER_CLIENT_ID: 'Iv1.fakeviewerid', GH_VIEWER_CLIENT_SECRET: VIEWER_SECRET });
  const both = await run(undefined, { method: 'GET', url: '/api/auth?app=viewer', env });
  assert.deepEqual(both.json, { client_id: 'Iv1.fakeviewerid' });
  assertClean(both);
});

test('a missing code is 400 and GitHub is never called', async () => {
  const r = await run({ app: 'editor' });
  assert.equal(r.res.code, 400);
  assert.equal(r.calls.length, 0);
  assert.equal(typeof r.json.error, 'string');
});

test('a code that is not a plain token string is 400', async () => {
  for (const code of ['', 42, ['x'], 'has space', 'a&client_secret=x', 'x'.repeat(300)]) {
    const r = await run({ code, app: 'editor' });
    assert.equal(r.res.code, 400, JSON.stringify(code).slice(0, 40));
    assert.equal(r.calls.length, 0);
  }
});

test('an unknown or missing app is 400', async () => {
  for (const body of [{ code: CODE, app: 'admin' }, { code: CODE }, { code: CODE, app: 7 }]) {
    const r = await run(body);
    assert.equal(r.res.code, 400, JSON.stringify(body));
    assert.equal(r.calls.length, 0);
  }
});

test('a body that is not a JSON object is 400', async () => {
  for (const body of ['not json', '[1,2]', 'null', '"s"']) {
    const r = await run(body);
    assert.equal(r.res.code, 400, body);
  }
});

test('an oversized body is 413 and GitHub is never called', async () => {
  const r = await run(JSON.stringify({ code: CODE, app: 'editor', pad: 'x'.repeat(20000) }));
  assert.equal(r.res.code, 413);
  assert.equal(r.calls.length, 0);
});

// ------------------------------------------------------------ app config ---

test('the viewer app answers a clean 400 "not configured" until its env exists', async () => {
  const r = await run({ code: CODE, app: 'viewer' });
  assert.equal(r.res.code, 400);
  assert.match(r.json.error, /not configured/);
  assert.equal(r.calls.length, 0);
});

test('the viewer app uses its own id and secret once configured', async () => {
  const env = Object.assign({}, ENV,
    { GH_VIEWER_CLIENT_ID: 'Iv1.fakeviewerid', GH_VIEWER_CLIENT_SECRET: VIEWER_SECRET });
  const r = await run({ code: CODE, app: 'viewer' }, { env });
  assert.equal(r.res.code, 200);
  const sent = new URLSearchParams(String(r.calls[0].init.body));
  assert.equal(sent.get('client_id'), 'Iv1.fakeviewerid');
  assert.equal(sent.get('client_secret'), VIEWER_SECRET);
  assertClean(r);
});

test('an unconfigured editor app is a clean 400 and never calls GitHub', async () => {
  const r = await run({ code: CODE, app: 'editor' }, { env: {} });
  assert.equal(r.res.code, 400);
  assert.match(r.json.error, /not configured/);
  assert.equal(r.calls.length, 0);
});

// ----------------------------------------------------------- GitHub fails ---

test('a GitHub 4xx is a 502 with a generic message and no secret', async () => {
  const echoing = { message: `bad credentials for ${SECRET}`, code: CODE };
  const r = await run({ code: CODE, app: 'editor' }, { gh: fakeGitHub(401, echoing) });
  assert.equal(r.res.code, 502);
  assert.equal(typeof r.json.error, 'string');
  assert.ok(!r.res.body.includes('bad credentials'), 'GitHub\'s own text is not relayed');
  assert.ok(!r.res.body.includes(CODE));
  assertClean(r);
});

test('GitHub\'s 200-with-error (an expired code) is a 502 with a safe reason code', async () => {
  const r = await run({ code: CODE, app: 'editor' }, { gh: fakeGitHub(200, {
    error: 'bad_verification_code',
    error_description: `The code passed is incorrect or expired. ${SECRET}`,
    error_uri: 'https://docs.github.com/x',
  }) });
  assert.equal(r.res.code, 502);
  assert.equal(r.json.reason, 'bad_verification_code');
  assert.ok(!r.res.body.includes('incorrect or expired'));
  assertClean(r);
});

test('an unsafe reason string from GitHub is not relayed', async () => {
  const r = await run({ code: CODE, app: 'editor' },
    { gh: fakeGitHub(200, { error: `<b>${SECRET}</b>` }) });
  assert.equal(r.res.code, 502);
  assert.equal(r.json.reason, undefined);
  assertClean(r);
});

test('a GitHub 5xx, a non-JSON answer, and a missing token are all 502', async () => {
  for (const gh of [fakeGitHub(503, 'down'), fakeGitHub(200, '<html>'),
    fakeGitHub(200, { token_type: 'bearer' }), fakeGitHub(200, { access_token: 12 })]) {
    const r = await run({ code: CODE, app: 'editor' }, { gh });
    assert.equal(r.res.code, 502);
    assertClean(r);
  }
});

test('a network failure or timeout is a 502 and nothing sensitive is logged', async () => {
  const throwing = { calls: [], fetch: async () => {
    throw new Error(`connect failed with client_secret=${SECRET}&code=${CODE}`);
  } };
  const r1 = await run({ code: CODE, app: 'editor' }, { gh: throwing });
  assert.equal(r1.res.code, 502);
  assertClean(r1);
  assert.ok(!r1.res.body.includes('connect failed'));

  const hanging = { calls: [], fetch: (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }) };
  const r2 = await run({ code: CODE, app: 'editor' }, { gh: hanging, timeoutMs: 30 });
  assert.equal(r2.res.code, 502);
  assertClean(r2);
});

test('every answer is no-store JSON', async () => {
  for (const r of [await run({ app: 'editor' }), await run({ code: CODE, app: 'editor' },
    { headers: { origin: 'https://evil.example.com' } })]) {
    assert.equal(r.res.headers['cache-control'], 'no-store');
    assert.match(r.res.headers['content-type'], /^application\/json/);
  }
});

test('the handler source never logs the code, the token or the secret', () => {
  const src = fs.readFileSync(path.join(ROOT, 'api', 'auth.js'), 'utf8');
  // Every log call takes ONE literal: a plain string, or a template whose only
  // interpolation is GitHub's HTTP status number. Nothing else can be printed.
  const calls = src.match(/console\.\w+\([^;]*\);/g) || [];
  assert.ok(calls.length > 0);
  for (const c of calls) {
    const arg = c.replace(/^console\.\w+\(/, '').replace(/\);$/, '');
    const literal = /^'[^'\\]*'$/.test(arg);
    const template = /^`[^`]*`$/.test(arg)
      && (arg.match(/\$\{[^}]*\}/g) || []).every((x) => /^\$\{Number\(reply\.status\) \|\| 0\}$/.test(x));
    assert.ok(literal || template, `a log call prints something other than a literal: ${c}`);
  }
});

// ------------------------------------------------------- the callback page --

test('callback.html loads js/cms-callback.js and carries no inline script or handler', () => {
  const html = fs.readFileSync(path.join(ROOT, 'cms', 'callback.html'), 'utf8');
  assert.match(html, /<script src="\.\.\/js\/cms-callback\.js"><\/script>/);
  const scripts = html.match(/<script\b[^>]*>/g) || [];
  assert.equal(scripts.length, 1, 'exactly one script tag');
  assert.ok(!/<script\b[^>]*>\s*\S/.test(html.replace(/<script src="[^"]+"><\/script>/, '')),
    'no inline script body');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline event handler attributes');
  assert.match(html, /Signing you in/);
  assert.match(html, /close this window/);
});

function runCallback(search, opener) {
  const posted = [];
  let closed = false;
  const replaced = [];
  const el = { textContent: '' };
  const win = {
    location: { search, origin: 'https://docs.example.org', pathname: '/cms/callback.html' },
    opener: opener === undefined ? { closed: false, postMessage: (m, o) => posted.push([m, o]) }
      : opener,
    close: () => { closed = true; },
    history: { replaceState: (a, b, url) => replaced.push(url) },
    localStorage: new Proxy({}, { get() { throw new Error('touched localStorage'); } }),
    sessionStorage: new Proxy({}, { get() { throw new Error('touched sessionStorage'); } }),
    fetch: () => { throw new Error('the callback page must never call the function'); },
    XMLHttpRequest: function XHR() { throw new Error('no XHR from the callback'); },
  };
  const doc = { getElementById: (id) => (id === 'status' ? el : null) };
  const src = fs.readFileSync(path.join(ROOT, 'js', 'cms-callback.js'), 'utf8');
  const ctx = Object.assign({}, win, { window: win, document: doc, URLSearchParams });
  vm.runInNewContext(src, ctx);
  return { posted, closed, replaced, status: el.textContent };
}

test('callback: posts {type:"hc-code", code, state} to its own origin, then closes', () => {
  const r = runCallback('?code=abc123&state=s-XYZ');
  assert.equal(r.posted.length, 1);
  // (JSON round trip: the message was built in the vm's realm, not this one)
  assert.deepEqual(JSON.parse(JSON.stringify(r.posted[0][0])),
    { type: 'hc-code', code: 'abc123', state: 's-XYZ' });
  assert.equal(r.posted[0][1], 'https://docs.example.org');
  assert.equal(r.closed, true);
  assert.deepEqual(r.replaced, ['/cms/callback.html'], 'the code is scrubbed from the address bar');
});

test('callback: without a code (sign-in cancelled) nothing is posted and the page says so', () => {
  const r = runCallback('?error=access_denied&state=s-XYZ');
  assert.equal(r.posted.length, 0);
  assert.equal(r.closed, false);
  assert.match(r.status, /close this window/);
});

test('callback: with no opener nothing is posted and the page stays readable', () => {
  const r = runCallback('?code=abc123&state=s', null);
  assert.equal(r.posted.length, 0);
  assert.equal(r.closed, false);
  assert.match(r.status, /close this window/);
});

// ------------------------------------------------------ dev_site routing ----

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startDevSite(extraArgs) {
  const port = await freePort();
  // The child must not inherit a developer's real App credentials.
  const env = Object.assign({}, process.env);
  for (const k of ['GH_APP_CLIENT_ID', 'GH_APP_CLIENT_SECRET',
    'GH_VIEWER_CLIENT_ID', 'GH_VIEWER_CLIENT_SECRET']) delete env[k];
  const child = spawn(process.execPath,
    [path.join(ROOT, 'tools', 'dev_site.mjs'), '--port', String(port)].concat(extraArgs || []),
    { stdio: ['ignore', 'pipe', 'pipe'], env });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`dev_site did not start:\n${out}`)), 10000);
    child.stdout.on('data', () => {
      if (out.includes(`http://127.0.0.1:${port}/`)) { clearTimeout(t); resolve(); }
    });
    child.once('exit', (c) => { clearTimeout(t); reject(new Error(`dev_site exited ${c}:\n${out}`)); });
  });
  return { port, child, output: () => out };
}

function post(port, route, body, origin) {
  return fetch(`http://localhost:${port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: origin || `http://localhost:${port}` },
    body: JSON.stringify(body),
  });
}

test('dev_site routes every api/*.js: auth and librarian both answer, unknown is 404', async () => {
  const site = await startDevSite(['--dotenv', path.join(os.tmpdir(), 'no-such-env-file-hc')]);
  try {
    const auth = await post(site.port, '/api/auth', { app: 'viewer', code: 'x' });
    assert.equal(auth.status, 400);
    assert.match((await auth.json()).error, /not configured/);

    // the CMS page's client-id lookup keeps its query string through the router
    const id = await fetch(`http://localhost:${site.port}/api/auth?app=editor`,
      { headers: { origin: `http://localhost:${site.port}` } });
    assert.equal(id.status, 400);
    assert.match((await id.json()).error, /not configured/);

    const wrong = await post(site.port, '/api/auth', { app: 'editor', code: 'x' },
      'https://evil.example.com');
    assert.equal(wrong.status, 403);

    const lib = await fetch(`http://localhost:${site.port}/api/librarian`);
    assert.equal(lib.status, 405);
    assert.equal(lib.headers.get('x-librarian-version'), '2');

    const none = await fetch(`http://localhost:${site.port}/api/nope`);
    assert.equal(none.status, 404);
    const traversal = await fetch(`http://localhost:${site.port}/api/..%2Fapi%2Fauth`);
    assert.equal(traversal.status, 404);
    assert.match(site.output(), /api\/auth/);
  } finally {
    site.child.kill();
  }
});

test('dev_site loads .env.local-style KEY=VALUE files and never prints a value', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-env-'));
  const file = path.join(dir, '.env.local');
  fs.writeFileSync(file, [
    '# a comment',
    '',
    'GH_VIEWER_CLIENT_ID=Iv1.fakeviewerid',
    `GH_VIEWER_CLIENT_SECRET="${VIEWER_SECRET}"`,
    'not a valid line',
  ].join('\n'));
  const site = await startDevSite(['--dotenv', file]);
  try {
    // Configured now, so the viewer branch gets past "not configured" and
    // stops at the code check instead — without any call to GitHub.
    const r = await post(site.port, '/api/auth', { app: 'viewer' });
    assert.equal(r.status, 400);
    assert.doesNotMatch((await r.json()).error, /not configured/);
    assert.ok(!site.output().includes(VIEWER_SECRET), 'dev_site printed a secret');
    assert.ok(!site.output().includes('Iv1.fakeviewerid'), 'dev_site printed a value');
    assert.match(site.output(), /2 variables from/);
  } finally {
    site.child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
