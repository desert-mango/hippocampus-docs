// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 23 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test tools/dev_site.mjs, the function-aware local server: its flags and the handlers it runs.
/* Made by U0 (editor UI/UX build) so unit U1 adds its tests here, not to a shared test file.
   U1 (D20) gave dev_site two flags, tested here in pairs:
     --host H              the bind address; the default stays loopback (127.0.0.1)
     --handler-deps FILE   a module whose default export is handed to api/auth.js as `deps`
                           (tools/tests/dev_auth_fake.mjs: a fake GitHub exchange); no flag, no deps

     node --test tools/tests/test_dev_site.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const NO_ENV = path.join(os.tmpdir(), 'no-such-env-file-hc-dev-site');
const FAKE = path.join(ROOT, 'tools', 'tests', 'dev_auth_fake.mjs');

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

/* A non-loopback IPv4 address of this machine (the container's eth0), or null. */
function outsideAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

function reachable(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 2000);
  });
}

async function startDevSite(extraArgs) {
  const port = await freePort();
  // the child must not inherit a developer's real App credentials
  const env = Object.assign({}, process.env);
  for (const k of ['GH_APP_CLIENT_ID', 'GH_APP_CLIENT_SECRET', 'GH_VIEWER_CLIENT_ID', 'GH_VIEWER_CLIENT_SECRET',
    'HC_SESSION_KEY']) delete env[k];
  const child = spawn(process.execPath,
    [path.join(ROOT, 'tools', 'dev_site.mjs'), '--port', String(port), '--dotenv', NO_ENV].concat(extraArgs || []),
    { stdio: ['ignore', 'pipe', 'pipe'], env });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  await new Promise((resolve, reject) => {
    // both failure paths stop the child, so a run that never starts cannot hang the suite
    const t = setTimeout(() => { child.kill(); reject(new Error(`dev_site did not start:\n${out}`)); }, 10000);
    child.stdout.on('data', () => { if (/listening on /.test(out)) { clearTimeout(t); resolve(); } });
    child.once('exit', (c) => { clearTimeout(t); reject(new Error(`dev_site exited ${c}:\n${out}`)); });
    child.once('error', (e) => { clearTimeout(t); child.kill(); reject(new Error(`dev_site failed: ${e.message}\n${out}`)); });
  });
  return { port, child, output: () => out };
}

function exitOf(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'dev_site.mjs'), '--dotenv', NO_ENV].concat(args),
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.once('exit', (code) => resolve({ code, out }));
  });
}

const signIn = (port) => fetch(`http://localhost:${port}/api/auth`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: `http://localhost:${port}` },
  body: JSON.stringify({ app: 'editor', code: 'dev-code' }),
});
const cookiesOf = (r) => (typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : []);

test('--host: with no flag dev_site binds 127.0.0.1 only (loopback); --host 0.0.0.0 binds every interface', async () => {
  const outside = outsideAddress();
  const plain = await startDevSite([]);
  try {
    assert.match(plain.output(), new RegExp(`listening on 127\\.0\\.0\\.1:${plain.port}\\b`));
    assert.equal(await reachable('127.0.0.1', plain.port), true);
    if (outside) assert.equal(await reachable(outside, plain.port), false, `not reachable on ${outside}`);
  } finally {
    plain.child.kill();
  }
  const wide = await startDevSite(['--host', '0.0.0.0']);
  try {
    assert.match(wide.output(), new RegExp(`listening on 0\\.0\\.0\\.0:${wide.port}\\b`));
    assert.equal(await reachable('127.0.0.1', wide.port), true);
    if (outside) assert.equal(await reachable(outside, wide.port), true, `reachable on ${outside}`);
  } finally {
    wide.child.kill();
  }
});

test('--host and --handler-deps refuse an empty value or a module without an object default export', async () => {
  for (const args of [['--host'], ['--host', ''], ['--host=a b'], ['--handler-deps'], ['--handler-deps', '']]) {
    const r = await exitOf(args);
    assert.equal(r.code, 1, JSON.stringify(args));
    assert.match(r.out, /usage:/);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-deps-'));
  const bad = path.join(dir, 'bad.mjs');
  fs.writeFileSync(bad, 'export default 5;\n');
  try {
    const r = await exitOf(['--handler-deps', bad, '--port', String(await freePort())]);
    assert.equal(r.code, 1);
    assert.match(r.out, /handler-deps/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no --handler-deps: api/auth.js gets no deps (the shell environment rules: not configured)', async () => {
  const site = await startDevSite([]);
  try {
    const r = await signIn(site.port);
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /not configured/);
    assert.deepEqual(cookiesOf(r), []);
    assert.doesNotMatch(site.output(), /handler deps/);
  } finally {
    site.child.kill();
  }
});

test('--handler-deps tools/tests/dev_auth_fake.mjs: the fake exchange signs in, the cookie resumes, DELETE signs out', async () => {
  const site = await startDevSite(['--handler-deps', FAKE]);
  try {
    assert.match(site.output(), /handler deps: tools\/tests\/dev_auth_fake\.mjs -> \/api\/auth only/);
    const id = await fetch(`http://localhost:${site.port}/api/auth?app=editor`, { headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(id.status, 200);
    assert.match((await id.json()).client_id, /^dev-fake-/);
    const r = await signIn(site.port);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.match(body.token, /^dev-fake-token-/);
    const set = cookiesOf(r);
    const seal = set.find((c) => c.startsWith('hc_s='));
    assert.ok(seal && /HttpOnly/.test(seal) && !/Secure/.test(seal), 'the sealed cookie (no Secure on http localhost)');
    assert.ok(set.some((c) => c.startsWith('hc_in=1;')));
    const cookie = `hc_in=1; ${seal.split(';')[0]}`;
    const back = await fetch(`http://localhost:${site.port}/api/auth?session=1`,
      { headers: { cookie, 'sec-fetch-site': 'same-origin', 'x-hc-session': '1' } });
    assert.equal(back.status, 200);
    assert.equal((await back.json()).token, body.token, 'the reload gets the same token back');
    assert.equal(back.headers.get('cache-control'), 'no-store');
    const out = await fetch(`http://localhost:${site.port}/api/auth`,
      { method: 'DELETE', headers: { cookie, origin: `http://localhost:${site.port}` } });
    assert.equal(out.status, 200);
    assert.ok(cookiesOf(out).every((c) => /Max-Age=0/.test(c)) && cookiesOf(out).length === 2);
    assert.ok(!site.output().includes(body.token), 'the token is never printed');
  } finally {
    site.child.kill();
  }
});

test('signed-out curl checks: resume without a cookie is 401, with a foreign Origin 403, both no-store', async () => {
  const site = await startDevSite(['--handler-deps', FAKE]);
  try {
    const none = await fetch(`http://localhost:${site.port}/api/auth?session=1`,
      { headers: { 'sec-fetch-site': 'same-origin', 'x-hc-session': '1' } });
    assert.equal(none.status, 401);
    assert.equal(none.headers.get('cache-control'), 'no-store');
    const foreign = await fetch(`http://localhost:${site.port}/api/auth?session=1`,
      { headers: { origin: 'https://evil.example.com', 'x-hc-session': '1' } });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.headers.get('cache-control'), 'no-store');
  } finally {
    site.child.kill();
  }
});

/* Security review (U1 fix round 3, finding 4): bound beyond loopback, dev_site does not load the
   default .env.local (real App secrets) unless --dotenv names a file. The run uses a copy of
   dev_site.mjs in a temporary root, so the default .env.local there is a throwaway file. */
async function startCopy(extraArgs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-dev-site-env-'));
  fs.mkdirSync(path.join(root, 'tools'));
  fs.mkdirSync(path.join(root, 'api'));
  fs.copyFileSync(path.join(ROOT, 'tools', 'dev_site.mjs'), path.join(root, 'tools', 'dev_site.mjs'));
  fs.writeFileSync(path.join(root, '.env.local'), 'HC_DEV_PROBE=placeholder-value\n');
  const port = await freePort();
  const env = Object.assign({}, process.env);
  delete env.HC_DEV_PROBE;
  const child = spawn(process.execPath, [path.join(root, 'tools', 'dev_site.mjs'), '--port', String(port)]
    .concat(extraArgs.map((a) => a.replace('<root>', root))), { stdio: ['ignore', 'pipe', 'pipe'], env });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => { child.kill(); reject(new Error(`dev_site did not start:\n${out}`)); }, 10000);
      child.stdout.on('data', () => { if (/listening on /.test(out)) { clearTimeout(t); resolve(); } });
      child.once('exit', (c) => { clearTimeout(t); reject(new Error(`dev_site exited ${c}:\n${out}`)); });
    });
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
  return out;
}

test('--host beyond loopback: the default .env.local is not loaded (one line says so); --dotenv loads it on purpose', async () => {
  const wide = await startCopy(['--host', '0.0.0.0']);
  assert.match(wide, /\.env\.local not loaded: --host 0\.0\.0\.0 is not loopback/);
  assert.equal((wide.match(/not loaded/g) || []).length, 1, 'one line');
  assert.doesNotMatch(wide, /variables from/);
  const named = await startCopy(['--host', '0.0.0.0', '--dotenv', '<root>/.env.local']);
  assert.match(named, /env: 1 variables from /, 'an explicit --dotenv is loaded');
  assert.ok(!named.includes('placeholder-value') && !wide.includes('placeholder-value'), 'values never printed');
});

test('--host on loopback (default or 127.0.0.1): the default .env.local is loaded as before', async () => {
  for (const extra of [[], ['--host', '127.0.0.1']]) {
    const out = await startCopy(extra);
    assert.match(out, /env: 1 variables from \.env\.local/, JSON.stringify(extra));
    assert.doesNotMatch(out, /not loaded/);
  }
});
