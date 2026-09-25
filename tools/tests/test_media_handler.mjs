// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 21 September 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test the Cloudinary gateway: caller check, signing, listing, guarded delete and rename.
/* Unit tests for api/media.js — the CMS's Cloudinary gateway.

   Every outbound call (GitHub, Cloudinary, the site's own manifest) goes to a
   FAKE fetch. Nothing in this file reaches the network, spends anything, or
   holds a real credential: the values below are obvious placeholders. Every
   response body and every console line is checked for the API secret and the
   user token (assertClean, called by run() itself on every request).

     node --test tools/tests/test_media_handler.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const handler = require(path.join(ROOT, 'api', 'media.js'));

const HOST = 'docs.example.org';
const ORIGIN = `https://${HOST}`;
const TOKEN = 'ghu_fakeMediaToken000000000';
const API_SECRET = 'fake-cloud-secret-4d5e6f';
const API_KEY = '000000000000000';
const CLOUD = 'fakecloud';
const ENV = {
  CLOUDINARY_CLOUD_NAME: CLOUD,
  CLOUDINARY_API_KEY: API_KEY,
  CLOUDINARY_API_SECRET: API_SECRET,
};
const NOW_MS = 1790000000000;          // a fixed clock: timestamp 1790000000
const REPO_URL = 'https://api.github.com/repos/desert-mango/hippocampus-docs';
const MANIFEST_URL = `${ORIGIN}/data/cloudinary-manifest.json`;
const MANIFEST = {
  cloud: CLOUD,
  assets: [{
    source: null,
    folder: 'hippocampus-docs/people',
    public_id: 'hippocampus-docs/people/jane-doe',
    url: `https://res.cloudinary.com/${CLOUD}/image/upload/v1/hippocampus-docs/people/jane-doe.jpg`,
    bytes: 1000,
    sha256: '0'.repeat(64),
  }],
};

// ---------------------------------------------------------------- fixtures --

function makeReq(method, body, headers) {
  const raw = body === undefined ? ''
    : (typeof body === 'string' ? body : JSON.stringify(body));
  const req = Readable.from(raw ? [Buffer.from(raw, 'utf8')] : []);
  req.method = method;
  req.url = '/api/media';
  req.headers = Object.assign(
    { 'content-type': 'application/json', host: HOST, origin: ORIGIN,
      authorization: `Bearer ${TOKEN}` },
    headers || {});
  for (const [k, v] of Object.entries(req.headers)) if (v === undefined) delete req.headers[k];
  return req;
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

function reply(status, payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { ok: status >= 200 && status < 300, status, text: async () => text,
    json: async () => JSON.parse(text) };
}

/* One fake network. Each route answers from `o`; every call is recorded. */
function fakeNet(o) {
  const opts = Object.assign({
    github: [200, { full_name: 'desert-mango/hippocampus-docs', permissions: { push: true } }],
    folderMode: 'fixed',
    manifest: [200, MANIFEST],
    list: [200, { resources: [], next_cursor: undefined }],
    destroy: [200, { result: 'ok' }],
    rename: [200, { public_id: 'hippocampus-docs/people/new-name',
      secure_url: `https://res.cloudinary.com/${CLOUD}/image/upload/v2/hippocampus-docs/people/new-name.jpg` }],
  }, o || {});
  const calls = [];
  const fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init: init || {} });
    if (u === REPO_URL) return reply(...opts.github);
    if (u === MANIFEST_URL) return reply(...opts.manifest);
    const base = `https://api.cloudinary.com/v1_1/${CLOUD}`;
    if (u === `${base}/config?settings=true`) {
      return reply(200, { cloud_name: CLOUD, settings: { folder_mode: opts.folderMode } });
    }
    if (u.startsWith(`${base}/resources/image/upload?`)) return reply(...opts.list);
    if (u === `${base}/image/destroy`) return reply(...opts.destroy);
    if (u === `${base}/image/rename`) return reply(...opts.rename);
    throw new Error(`unexpected fetch ${u}`);
  };
  return { fetch, calls };
}

function assertClean(r) {
  for (const needle of [API_SECRET, TOKEN]) {
    assert.ok(!r.res.body.includes(needle), 'a response body carried a secret or the token');
    assert.ok(!r.logs.includes(needle), 'a log line carried a secret or the token');
    assert.ok(!JSON.stringify(r.res.headers).includes(needle), 'a header carried a secret');
  }
}

async function run(body, o) {
  const opts = o || {};
  const net = opts.net || fakeNet(opts.netOpts);
  const res = makeRes();
  const lines = [];
  const saved = {};
  for (const name of ['log', 'info', 'warn', 'error', 'debug']) {
    saved[name] = console[name];
    console[name] = (...a) => { lines.push(a.map(String).join(' ')); };
  }
  try {
    await handler(makeReq(opts.method || 'POST', body, opts.headers), res, {
      env: opts.env || ENV,
      fetch: net.fetch,
      now: opts.now || (() => NOW_MS),
      state: opts.state || handler.createState(),
    });
    await res.done;
  } finally {
    for (const name of Object.keys(saved)) console[name] = saved[name];
  }
  let json = null;
  try { json = JSON.parse(res.body); } catch (e) { json = null; }
  const r = { res, json, calls: net.calls, logs: lines.join('\n') };
  assertClean(r);
  return r;
}

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const sha1 = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex');
const cloudCalls = (r) => r.calls.filter((c) => c.url.startsWith('https://api.cloudinary.com/'));

// ------------------------------------------------------------ signatures ---

test('signature: the string-to-sign matches Cloudinary\'s own published example', () => {
  // The doc's example [S54]: secret "abcd", SHA-1 → bfd09f95…; the same string with SHA-256
  // is what this gateway signs with. Both expectations are computed here from the spec text.
  const params = { timestamp: '1315060510', public_id: 'sample_image',
    eager: 'w_400,h_300,c_pad|w_260,h_200,c_crop' };
  const spec = 'eager=w_400,h_300,c_pad|w_260,h_200,c_crop&public_id=sample_image&timestamp=1315060510';
  assert.equal(sha1(`${spec}abcd`), 'bfd09f95f331f558cbd1320e67aa8d488770583e');
  assert.equal(handler.stringToSign(params), spec);
  assert.equal(handler.signatureFor(params, 'abcd'), sha256(`${spec}abcd`));
});

test('sign, fixed folder mode: folder + public_id + overwrite=false + timestamp, hand-computed signature', async () => {
  const r = await run({ action: 'sign', subfolder: 'people', filename: 'Jane Doe.JPG' });
  assert.equal(r.res.code, 200, r.res.body);
  const expectedParams = {
    folder: 'hippocampus-docs/people',
    overwrite: 'false',
    public_id: 'jane-doe',
    timestamp: '1790000000',
  };
  assert.deepEqual(r.json.params, expectedParams);
  assert.equal(r.json.timestamp, 1790000000);
  assert.equal(r.json.cloud_name, CLOUD);
  assert.equal(r.json.api_key, API_KEY);
  const hand = 'folder=hippocampus-docs/people&overwrite=false&public_id=jane-doe&timestamp=1790000000';
  assert.equal(r.json.signature, sha256(hand + API_SECRET));
  assert.deepEqual(Object.keys(r.json).sort(),
    ['api_key', 'cloud_name', 'params', 'signature', 'timestamp']);
});

test('sign, dynamic folder mode: asset_folder + full-path public_id', async () => {
  const r = await run({ action: 'sign', subfolder: 'setup', filename: 'Wiring diagram v2.png' },
    { netOpts: { folderMode: 'dynamic' } });
  assert.equal(r.res.code, 200, r.res.body);
  assert.deepEqual(r.json.params, {
    asset_folder: 'hippocampus-docs/setup',
    overwrite: 'false',
    public_id: 'hippocampus-docs/setup/wiring-diagram-v2',
    timestamp: '1790000000',
  });
  const hand = 'asset_folder=hippocampus-docs/setup&overwrite=false'
    + '&public_id=hippocampus-docs/setup/wiring-diagram-v2&timestamp=1790000000';
  assert.equal(r.json.signature, sha256(hand + API_SECRET));
  assert.ok(!('folder' in r.json.params));
});

test('sign: the folder mode is read once per instance, with Basic auth, then cached', async () => {
  const state = handler.createState();
  const net = fakeNet();
  await run({ action: 'sign', subfolder: 'tools', filename: 'a' }, { state, net });
  await run({ action: 'sign', subfolder: 'brand', filename: 'b' }, { state, net });
  const cfg = net.calls.filter((c) => c.url.includes('/config?settings=true'));
  assert.equal(cfg.length, 1);
  const auth = cfg[0].init.headers.authorization;
  assert.equal(auth, `Basic ${Buffer.from(`${API_KEY}:${API_SECRET}`).toString('base64')}`);
});

for (const bad of ['../portfolio', 'portfolio', 'hippocampus-docs-evil', 'people/', '', 'constructor', 'toString', 42, null]) {
  test(`sign: subfolder ${JSON.stringify(bad)} → 400`, async () => {
    const r = await run({ action: 'sign', subfolder: bad, filename: 'x' });
    assert.equal(r.res.code, 400);
    assert.equal(cloudCalls(r).length, 0);
  });
}

test('sign: filename slug is [a-z0-9-]{1,80}; nothing usable → 400', async () => {
  const long = await run({ action: 'sign', subfolder: 'projects', filename: `${'Ab'.repeat(60)}.jpeg` });
  assert.equal(long.res.code, 200);
  assert.match(long.json.params.public_id, /^[a-z0-9-]{1,80}$/);
  assert.equal(long.json.params.public_id.length, 80);
  const odd = await run({ action: 'sign', subfolder: 'projects', filename: '../../Ünïcode Größe__x.tar.gz' });
  assert.equal(odd.res.code, 200);
  assert.match(odd.json.params.public_id, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  for (const fn of ['...', '.jpg', '', '  ', 7, undefined]) {
    const r = await run({ action: 'sign', subfolder: 'projects', filename: fn });
    assert.equal(r.res.code, 400, `filename ${JSON.stringify(fn)}`);
  }
});

// ---------------------------------------------------------------- caller ---

test('caller: the bearer goes to the repo lookup; push:false → 403', async () => {
  const r = await run({ action: 'list' },
    { netOpts: { github: [200, { permissions: { push: false, pull: true } }] } });
  assert.equal(r.res.code, 403);
  const gh = r.calls.find((c) => c.url === REPO_URL);
  assert.equal(gh.init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(cloudCalls(r).length, 0);
});

test('caller: push must be exactly true (a truthy string is not enough)', async () => {
  const r = await run({ action: 'list' },
    { netOpts: { github: [200, { permissions: { push: 'true' } }] } });
  assert.equal(r.res.code, 403);
});

test('caller: GitHub 404 (no access to the private repo) → 403', async () => {
  const r = await run({ action: 'list' }, { netOpts: { github: [404, { message: 'Not Found' }] } });
  assert.equal(r.res.code, 403);
});

test('caller: bad bearer (GitHub 401) → 401', async () => {
  const r = await run({ action: 'list' },
    { headers: { authorization: 'Bearer bad' }, netOpts: { github: [401, { message: 'Bad credentials' }] } });
  assert.equal(r.res.code, 401);
  assert.equal(cloudCalls(r).length, 0);
});

for (const [name, value] of [['absent', undefined], ['empty', ''], ['not bearer', `token ${TOKEN}`],
  ['bearer only', 'Bearer '], ['junk token', 'Bearer a b'], ['newline', 'Bearer x\ny']]) {
  test(`caller: authorization ${name} → 401 without any outbound call`, async () => {
    const r = await run({ action: 'list' }, { headers: { authorization: value } });
    assert.equal(r.res.code, 401);
    assert.equal(r.calls.length, 0);
    assert.match(String(r.res.headers['www-authenticate'] || ''), /^Bearer/);
  });
}

test('caller: GitHub down → 502, nothing cached', async () => {
  const state = handler.createState();
  const r = await run({ action: 'list' }, { state, netOpts: { github: [503, 'oops'] } });
  assert.equal(r.res.code, 502);
  const again = await run({ action: 'list' }, { state });
  assert.equal(again.res.code, 200);
});

test('caller: a verdict is cached 5 minutes by token hash, then re-checked', async () => {
  const state = handler.createState();
  const net = fakeNet();
  let now = NOW_MS;
  const clock = () => now;
  await run({ action: 'list' }, { state, net, now: clock });
  now += 4 * 60 * 1000;
  await run({ action: 'list' }, { state, net, now: clock });
  assert.equal(net.calls.filter((c) => c.url === REPO_URL).length, 1);
  now += 2 * 60 * 1000;
  await run({ action: 'list' }, { state, net, now: clock });
  assert.equal(net.calls.filter((c) => c.url === REPO_URL).length, 2);
  // The cache holds a hash, never the token itself.
  assert.ok(!JSON.stringify([...state.callers.keys()]).includes(TOKEN));
});

test('rate limit: 60 calls per minute per token, then 429 with Retry-After; a minute later it recovers', async () => {
  const state = handler.createState();
  const net = fakeNet();
  let now = NOW_MS;
  const clock = () => now;
  for (let i = 0; i < 60; i += 1) {
    const r = await run({ action: 'list' }, { state, net, now: clock });
    assert.equal(r.res.code, 200, `call ${i + 1}`);
  }
  const over = await run({ action: 'list' }, { state, net, now: clock });
  assert.equal(over.res.code, 429);
  assert.ok(Number(over.res.headers['retry-after']) >= 1);
  const other = await run({ action: 'list' },
    { state, net, now: clock, headers: { authorization: 'Bearer ghu_someoneElse000' } });
  assert.equal(other.res.code, 200, 'another token has its own budget');
  now += 61 * 1000;
  const later = await run({ action: 'list' }, { state, net, now: clock });
  assert.equal(later.res.code, 200);
});

// ------------------------------------------------------------ the envelope --

test('only POST: GET → 405 with Allow: POST', async () => {
  const r = await run(undefined, { method: 'GET' });
  assert.equal(r.res.code, 405);
  assert.equal(r.res.headers.allow, 'POST');
});

test('origin: missing or foreign Origin → 403 before any outbound call', async () => {
  for (const origin of [undefined, 'https://evil.example', 'http://docs.example.org', 'null']) {
    const r = await run({ action: 'list' }, { headers: { origin } });
    assert.equal(r.res.code, 403, String(origin));
    assert.equal(r.calls.length, 0);
  }
});

test('body: over 64 KB → 413; exactly at the cap is read', async () => {
  const big = JSON.stringify({ action: 'list', pad: 'x'.repeat(64 * 1024) });
  const r = await run(big);
  assert.equal(r.res.code, 413);
  assert.equal(r.calls.length, 0);
  const base = JSON.stringify({ action: 'list', pad: '' });
  const exact = JSON.stringify({ action: 'list', pad: 'x'.repeat(64 * 1024 - base.length) });
  assert.equal(Buffer.byteLength(exact), 64 * 1024);
  const ok = await run(exact);
  assert.equal(ok.res.code, 200);
});

test('body: not JSON, not an object, unknown action → 400', async () => {
  for (const body of ['{', '[]', '"x"', JSON.stringify({ action: 'upload' }),
    JSON.stringify({ action: '__proto__' }), JSON.stringify({})]) {
    const r = await run(body);
    assert.equal(r.res.code, 400, body);
    assert.equal(r.calls.length, 0);
  }
});

test('config: any Cloudinary variable missing → 400 "not configured", nothing called', async () => {
  for (const drop of Object.keys(ENV)) {
    const env = Object.assign({}, ENV);
    delete env[drop];
    const r = await run({ action: 'list' }, { env });
    assert.equal(r.res.code, 400);
    assert.match(r.json.error, /not configured/);
    assert.equal(r.calls.length, 0);
  }
});

// ------------------------------------------------------------------ list ---

test('list: Admin API with prefix + max_results=500 + Basic auth; mapped fields only', async () => {
  const resources = [{
    public_id: 'hippocampus-docs/setup/a', secure_url: 'https://res.cloudinary.com/x/a.jpg',
    url: 'http://res.cloudinary.com/x/a.jpg', bytes: 10, width: 4, height: 3, format: 'jpg',
    created_at: '2026-09-21T00:00:00Z', asset_id: 'zzz', etag: 'e', access_mode: 'public',
  }];
  const r = await run({ action: 'list', cursor: 'abc123' },
    { netOpts: { list: [200, { resources, next_cursor: 'next456' }] } });
  assert.equal(r.res.code, 200, r.res.body);
  assert.deepEqual(r.json, {
    assets: [{ public_id: 'hippocampus-docs/setup/a', url: 'https://res.cloudinary.com/x/a.jpg',
      bytes: 10, width: 4, height: 3, format: 'jpg', created_at: '2026-09-21T00:00:00Z' }],
    next_cursor: 'next456',
  });
  const call = cloudCalls(r)[0];
  const u = new URL(call.url);
  assert.equal(u.pathname, `/v1_1/${CLOUD}/resources/image/upload`);
  assert.equal(u.searchParams.get('prefix'), 'hippocampus-docs/');
  assert.equal(u.searchParams.get('max_results'), '500');
  assert.equal(u.searchParams.get('next_cursor'), 'abc123');
  assert.match(call.init.headers.authorization, /^Basic /);
});

test('list: last page → next_cursor null; a malformed cursor → 400', async () => {
  const r = await run({ action: 'list' });
  assert.deepEqual(r.json, { assets: [], next_cursor: null });
  const bad = await run({ action: 'list', cursor: { $gt: '' } });
  assert.equal(bad.res.code, 400);
  const bad2 = await run({ action: 'list', cursor: 'a&b=c' });
  assert.equal(bad2.res.code, 400);
});

test('list: Cloudinary failure → 502 without echoing its answer', async () => {
  const r = await run({ action: 'list' },
    { netOpts: { list: [401, { error: { message: `Invalid api_key ${API_KEY}` } }] } });
  assert.equal(r.res.code, 502);
  assert.ok(!r.res.body.includes('Invalid api_key'));
});

// --------------------------------------------------------------- destroy ---

test('destroy: an id outside hippocampus-docs/ → 403, nothing called at Cloudinary', async () => {
  for (const id of ['portfolio/x', 'hippocampus-docs-evil/x', 'x/hippocampus-docs/y', '/hippocampus-docs/x']) {
    const r = await run({ action: 'destroy', public_id: id });
    assert.equal(r.res.code, 403, id);
    assert.equal(cloudCalls(r).length, 0);
  }
});

test('destroy: a malformed id under the prefix → 400', async () => {
  for (const id of ['hippocampus-docs/', 'hippocampus-docs/../x', 'hippocampus-docs/a//b',
    'hippocampus-docs/a b', 42]) {
    const r = await run({ action: 'destroy', public_id: id });
    assert.equal(r.res.code, 400, String(id));
    assert.equal(cloudCalls(r).length, 0);
  }
});

test('destroy: a manifest-referenced id → 409 "still referenced by the site"', async () => {
  const r = await run({ action: 'destroy', public_id: 'hippocampus-docs/people/jane-doe' });
  assert.equal(r.res.code, 409);
  assert.match(r.json.error, /still referenced by the site/);
  assert.ok(r.calls.some((c) => c.url === MANIFEST_URL), 'the live manifest was read from the own host');
  assert.equal(cloudCalls(r).length, 0);
});

test('destroy: manifest unreadable → 502 (fail closed)', async () => {
  for (const manifest of [[404, 'nope'], [200, 'not json'], [200, { assets: 'x' }]]) {
    const r = await run({ action: 'destroy', public_id: 'hippocampus-docs/people/old' },
      { netOpts: { manifest } });
    assert.equal(r.res.code, 502);
    assert.equal(cloudCalls(r).length, 0);
  }
});

test('destroy: an unreferenced id → signed Upload API destroy with invalidate=true', async () => {
  const r = await run({ action: 'destroy', public_id: 'hippocampus-docs/people/old-photo' });
  assert.equal(r.res.code, 200, r.res.body);
  assert.deepEqual(r.json, { result: 'ok', public_id: 'hippocampus-docs/people/old-photo' });
  const call = cloudCalls(r)[0];
  assert.equal(call.url, `https://api.cloudinary.com/v1_1/${CLOUD}/image/destroy`);
  assert.equal(call.init.method, 'POST');
  const form = new URLSearchParams(call.init.body);
  const hand = 'invalidate=true&public_id=hippocampus-docs/people/old-photo&timestamp=1790000000';
  assert.equal(form.get('signature'), sha256(hand + API_SECRET));
  // Every body field except api_key (and file) must be signed [S54], so the form carries
  // exactly the signed fields plus api_key and signature — nothing unsigned rides along.
  assert.deepEqual([...form.keys()].sort(),
    ['api_key', 'invalidate', 'public_id', 'signature', 'timestamp']);
  assert.equal(form.get('api_key'), API_KEY);
  assert.equal(form.get('invalidate'), 'true');
  assert.ok(!call.init.body.includes(API_SECRET), 'the secret itself never travels');
});

test('destroy: Cloudinary "not found" → 404', async () => {
  const r = await run({ action: 'destroy', public_id: 'hippocampus-docs/people/gone' },
    { netOpts: { destroy: [200, { result: 'not found' }] } });
  assert.equal(r.res.code, 404);
});

// ---------------------------------------------------------------- rename ---

test('rename: both ids guarded (prefix 403, referenced 409)', async () => {
  const a = await run({ action: 'rename', from: 'portfolio/x', to: 'hippocampus-docs/people/y' });
  assert.equal(a.res.code, 403);
  const b = await run({ action: 'rename', from: 'hippocampus-docs/people/y', to: 'portfolio/x' });
  assert.equal(b.res.code, 403);
  const c = await run({ action: 'rename', from: 'hippocampus-docs/people/jane-doe', to: 'hippocampus-docs/people/z' });
  assert.equal(c.res.code, 409);
  assert.match(c.json.error, /still referenced by the site/);
  const d = await run({ action: 'rename', from: 'hippocampus-docs/people/z', to: 'hippocampus-docs/people/jane-doe' });
  assert.equal(d.res.code, 409);
  for (const r of [a, b, c, d]) assert.equal(cloudCalls(r).length, 0);
});

test('rename: signed Upload API rename with invalidate=true', async () => {
  const r = await run({ action: 'rename', from: 'hippocampus-docs/people/old', to: 'hippocampus-docs/people/new-name' });
  assert.equal(r.res.code, 200, r.res.body);
  assert.equal(r.json.public_id, 'hippocampus-docs/people/new-name');
  const call = cloudCalls(r)[0];
  assert.equal(call.url, `https://api.cloudinary.com/v1_1/${CLOUD}/image/rename`);
  const form = new URLSearchParams(call.init.body);
  const hand = 'from_public_id=hippocampus-docs/people/old&invalidate=true'
    + '&timestamp=1790000000&to_public_id=hippocampus-docs/people/new-name';
  assert.equal(form.get('signature'), sha256(hand + API_SECRET));
  assert.equal(form.get('api_key'), API_KEY);
});

test('rename: same id twice → 400', async () => {
  const r = await run({ action: 'rename', from: 'hippocampus-docs/people/a', to: 'hippocampus-docs/people/a' });
  assert.equal(r.res.code, 400);
});
