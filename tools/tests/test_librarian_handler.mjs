/* Unit tests for api/librarian.js — the serverless half of the librarian.

   BATCH BOUNDARY: this is the ONLY test file allowed to import api/. Everything
   in tools/tests/test_search_routing.mjs must keep passing in a checkout where
   the api/ directory does not exist, because the GitHub Pages copy of this site
   ships without it.

   The handler is raw Node: it reads the request body off the stream, parses it
   itself, and answers with writeHead/end. It must never touch a Vercel-injected
   helper (req.body, req.query, req.cookies, res.status, res.json, res.send) —
   the last test here proves that by handing it a request stub that has none of
   them and a response stub whose helpers throw on contact.

     node --test tools/tests/test_librarian_handler.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const handler = require(path.join(ROOT, 'api', 'librarian.js'));
const DATA = path.join(ROOT, 'data', 'graph');

// ---------------------------------------------------------------- fixtures --

function makeReq(method, body, wire) {
  const raw = body === undefined ? ''
    : (typeof body === 'string' ? body : JSON.stringify(body));
  const req = Readable.from(raw ? [Buffer.from(raw, 'utf8')] : []);
  req.method = method;
  req.url = '/api/librarian';
  req.headers = Object.assign(
    { 'content-type': 'application/json', host: 'docs.example.org' },
    (wire && wire.headers) || {});
  if (wire && wire.socket) req.socket = wire.socket;
  return req;   // deliberately no .body / .query / .cookies
}

function makeRes(poison) {
  const out = { code: 0, headers: {}, body: '' };
  out.done = new Promise((resolve) => { out.settle = resolve; });
  out.writeHead = (code, headers) => {
    out.code = code;
    out.headers = Object.assign({}, out.headers, headers || {});
    return out;
  };
  out.setHeader = (k, v) => { out.headers[k] = v; };
  out.end = (chunk) => { if (chunk) out.body += String(chunk); out.settle(out); return out; };
  if (poison) {
    const bang = (name) => () => { throw new Error(`handler used the Vercel helper res.${name}()`); };
    out.status = bang('status');
    out.json = bang('json');
    out.send = bang('send');
  }
  return out;
}

async function call(method, body, deps, poison, wire) {
  // Every call gets its own rate limiter unless the test supplies one, so the
  // shared per-instance limiter cannot make these tests depend on each other.
  const d = Object.assign({}, deps);
  if (!('limiter' in d)) d.limiter = handler.createLimiter();
  const req = makeReq(method, body, wire);
  const res = makeRes(poison);
  await handler(req, res, d);
  await res.done;
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch (e) { /* some bodies are plain text */ }
  return { code: res.code, headers: res.headers, text: res.body, json: parsed };
}

function candidates(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      id: `page:#/p/${i}`, title: `Candidate ${i}`, kind: i % 3 === 0 ? 'page' : 'class',
      where: `where ${i}`, snippet: `snippet ${i}`,
    });
  }
  return out;
}

const ASK = { q: 'thruster model', candidates: candidates(12) };

/* An OpenAI-compatible chat-completions stub. `answers` is consumed in order;
   each entry is either an array of ids (a 200) or {status, text} (a failure). */
function providerStub(answers) {
  const calls = [];
  const queue = answers.slice();
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    if (Array.isArray(next)) {
      const content = JSON.stringify({ results: next.map((id) => ({ id, why: 'because' })) });
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }),
        text: async () => content,
      };
    }
    if (typeof next === 'string') {   // a 200 carrying raw (possibly bad) content
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: next } }] }),
        text: async () => next,
      };
    }
    return {
      ok: false,
      status: next.status,
      json: async () => { throw new SyntaxError('not json'); },
      text: async () => next.text || 'upstream said no',
    };
  };
  fn.calls = calls;
  return fn;
}

/* Both provider entries read the SAME variable now — they are two models behind
   one gateway, not two vendors. The name says "KEYS" in the plural only because
   it is the whole key environment a call needs. */
const KEYS = { OPENROUTER_API_KEY: 'openrouter-test-key' };

// ------------------------------------------------------------ method + body --

test('only POST is answered', async () => {
  for (const method of ['GET', 'PUT', 'DELETE', 'HEAD']) {
    const r = await call(method, undefined, { env: KEYS });
    assert.equal(r.code, 405, `${method} must be 405`);
    assert.match(String(r.headers.allow || r.headers.Allow || ''), /POST/);
  }
});

test('OPTIONS is not secretly special-cased into a 2xx', async () => {
  const r = await call('OPTIONS', undefined, { env: KEYS });
  assert.equal(r.code, 405);
});

test('a malformed body is a 4xx, not a crash', async () => {
  const r = await call('POST', 'this is not json{', { env: KEYS });
  assert.ok(r.code >= 400 && r.code < 500, `expected 4xx, got ${r.code}`);
  assert.ok(r.json && r.json.error, 'the error is reported as JSON');
});

test('a body with no candidates array is a 4xx', async () => {
  for (const body of [{}, { q: 'two words' }, { q: 'x', candidates: 'nope' },
                      { candidates: [] }, { q: 42, candidates: [] }]) {
    const r = await call('POST', body, { env: KEYS });
    assert.ok(r.code >= 400 && r.code < 500,
      `expected 4xx for ${JSON.stringify(body)}, got ${r.code}`);
  }
});

test('an unknown provider hint is refused rather than silently ignored', async () => {
  const r = await call('POST', Object.assign({ provider: 'openai' }, ASK), { env: KEYS });
  assert.ok(r.code >= 400 && r.code < 500);
});

// ----------------------------------------------------------------- catalog --

test('a missing catalog file is a 500 that names the file', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-nocatalog-'));
  try {
    const r = await call('POST', ASK, { env: KEYS, dataDir: empty });
    assert.equal(r.code, 500);
    assert.match(r.text, /wiki\.json/, 'the response names the missing file');
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('a catalog with wiki.json but no repos-index.json names the missing half', async () => {
  const half = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-halfcatalog-'));
  try {
    fs.copyFileSync(path.join(DATA, 'wiki.json'), path.join(half, 'wiki.json'));
    const r = await call('POST', ASK, { env: KEYS, dataDir: half });
    assert.equal(r.code, 500);
    assert.match(r.text, /repos-index\.json/);
  } finally {
    fs.rmSync(half, { recursive: true, force: true });
  }
});

test('the real repo catalog builds and stays compact', () => {
  const catalog = handler.buildCatalog(DATA);
  assert.ok(Array.isArray(catalog), 'the catalog is a list of rows');
  assert.ok(catalog.length > 50, `expected a real catalog, got ${catalog.length} rows`);
  const text = JSON.stringify(catalog);
  assert.ok(text.length < 60000, `catalog is ${text.length} chars — that is not compact`);
  for (const row of catalog) {
    assert.equal(typeof row.title, 'string');
    assert.equal(typeof row.kind, 'string');
    assert.ok(String(row.about || '').length <= 160, 'one-liners, never full summaries');
  }
});

// -------------------------------------------------------------- the 200 path -

test('a good provider answer is validated, filtered and capped at 8', async () => {
  const known = ASK.candidates.map((c) => c.id);
  const fetchStub = providerStub([[
    known[5], 'hallucinated:id', known[1], known[5], known[0], known[2], known[3],
    known[4], known[6], known[7], known[8], known[9], known[10],
  ]]);
  const r = await call('POST', ASK, { env: KEYS, fetch: fetchStub });
  assert.equal(r.code, 200);
  assert.equal(r.json.provider, 'gptoss', 'gptoss is the primary');
  assert.ok(Array.isArray(r.json.results));
  assert.equal(r.json.results.length, 8, 'capped at 8');
  assert.equal(r.json.results[0].id, known[5]);
  assert.equal(r.json.results[1].id, known[1], 'the unknown id was dropped');
  const ids = r.json.results.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, 'deduped');
  for (const id of ids) assert.ok(known.includes(id), `${id} came from the candidate list`);
  for (const row of r.json.results) assert.equal(typeof row.why, 'string');
});

test('the outgoing provider request is temperature 0 and carries the candidates', async () => {
  const fetchStub = providerStub([[ASK.candidates[0].id]]);
  const r = await call('POST', ASK, { env: KEYS, fetch: fetchStub });
  assert.equal(r.code, 200);
  const sent = fetchStub.calls[0];
  assert.equal(sent.body.temperature, 0);
  assert.equal(sent.body.model, 'openai/gpt-oss-120b');
  assert.ok(!/llama/i.test(sent.body.model), 'a Llama-family model is forbidden by policy');
  assert.equal(sent.init.method, 'POST');
  assert.match(sent.init.headers.authorization, /^Bearer /);
  const prompt = sent.body.messages.map((m) => m.content).join('\n');
  assert.match(prompt, /Candidate 0/, 'the candidates reach the model');
  assert.ok(!prompt.includes('openrouter-test-key'), 'no key ever enters the prompt');
  assert.equal(typeof r.json.promptChars, 'number');
  assert.ok(r.json.promptChars > 0);
  assert.equal(r.json.temperature, 0, 'the answer reports the temperature it was produced at');
});

test('fenced or reasoning-wrapped JSON is still parsed', async () => {
  const id = ASK.candidates[3].id;
  const wrapped = `<think>weighing the options</think>\n\`\`\`json\n{"results":[{"id":"${id}","why":"w"}]}\n\`\`\``;
  const r = await call('POST', ASK, { env: KEYS, fetch: providerStub([wrapped]) });
  assert.equal(r.code, 200);
  assert.deepEqual(r.json.results.map((x) => x.id), [id]);
});

test('a provider that answers 200 with unusable content falls through', async () => {
  const id = ASK.candidates[2].id;
  const fetchStub = providerStub(['I cannot help with that.', [id]]);
  const r = await call('POST', ASK, { env: KEYS, fetch: fetchStub });
  assert.equal(r.code, 200);
  assert.equal(r.json.provider, 'nemotron');
  assert.equal(fetchStub.calls.length, 2);
});

// ------------------------------------------------------------ the fallback --

test('a failing primary falls back to the other provider', async () => {
  const id = ASK.candidates[4].id;
  const fetchStub = providerStub([{ status: 503, text: 'groq is down' }, [id]]);
  const r = await call('POST', ASK, { env: KEYS, fetch: fetchStub });
  assert.equal(r.code, 200);
  assert.equal(r.json.provider, 'nemotron');
  assert.deepEqual(r.json.results.map((x) => x.id), [id]);
  assert.equal(fetchStub.calls.length, 2, 'exactly one retry, on the OTHER provider');
  assert.equal(fetchStub.calls[0].url, fetchStub.calls[1].url,
    'same gateway by construction — see the PROVIDERS note in api/librarian.js');
  assert.notEqual(fetchStub.calls[0].body.model, fetchStub.calls[1].body.model,
    'the retry used the OTHER entry: same endpoint, different model');
  assert.equal(fetchStub.calls[1].body.model, 'nvidia/nemotron-3-super-120b-a12b');
});

test('both providers failing is a 502 that says why', async () => {
  const fetchStub = providerStub([{ status: 500, text: 'boom' }]);
  const r = await call('POST', ASK, { env: KEYS, fetch: fetchStub });
  assert.equal(r.code, 502);
  assert.equal(fetchStub.calls.length, 2);
  assert.ok(Array.isArray(r.json.providers));
  assert.deepEqual(r.json.providers.map((p) => p.provider), ['gptoss', 'nemotron']);
  for (const p of r.json.providers) assert.ok(p.reason, 'each failure carries a reason');
});

test('a thrown network error is a failure, not a crash', async () => {
  const fetchStub = providerStub([new TypeError('fetch failed')]);
  const r = await call('POST', ASK, { env: KEYS, fetch: fetchStub });
  assert.equal(r.code, 502);
});

test('no keys at all is a 502 naming the missing environment variables', async () => {
  const fetchStub = providerStub([[ASK.candidates[0].id]]);
  const r = await call('POST', ASK, { env: {}, fetch: fetchStub });
  assert.equal(r.code, 502);
  assert.equal(fetchStub.calls.length, 0, 'never call a provider without its key');
  assert.match(r.text, /OPENROUTER_API_KEY/);
});

/* This replaces an older test that gave ONE vendor a key and expected the other
   entry to be skipped. That state is unreachable now: both entries read
   OPENROUTER_API_KEY, so a missing key skips BOTH and no provider is ever
   called. The coupling is asserted directly rather than left implicit — it is
   the cost recorded in the PROVIDERS note, and splitting back into two vendors
   should have to change this line on purpose. */
test('both entries share one key, so a missing key skips every provider', async () => {
  const providers = handler.PROVIDERS;
  assert.equal(providers.length, 2);
  assert.equal(providers[0].keyEnv, 'OPENROUTER_API_KEY');
  assert.equal(providers[1].keyEnv, 'OPENROUTER_API_KEY');

  const fetchStub = providerStub([[ASK.candidates[1].id]]);
  const r = await call('POST', ASK, { env: {}, fetch: fetchStub });
  assert.equal(r.code, 502);
  assert.equal(fetchStub.calls.length, 0, 'no key means no provider call at all');
  assert.deepEqual(r.json.providers.map((p) => p.provider), ['gptoss', 'nemotron']);
  for (const p of r.json.providers) assert.match(p.reason, /OPENROUTER_API_KEY/);
});

test('a provider hint pins the request to that provider with no fallback', async () => {
  const fetchStub = providerStub([{ status: 500, text: 'boom' }]);
  const r = await call('POST', Object.assign({ provider: 'nemotron' }, ASK),
    { env: KEYS, fetch: fetchStub });
  assert.equal(r.code, 502);
  assert.equal(fetchStub.calls.length, 1, 'pinned: no fallback to the other provider');
  assert.deepEqual(r.json.providers.map((p) => p.provider), ['nemotron']);
});

test('the base URLs and the nemotron model id are environment-overridable', async () => {
  const fetchStub = providerStub([[ASK.candidates[0].id]]);
  const env = Object.assign({}, KEYS, {
    LIBRARIAN_NEMOTRON_URL: 'http://127.0.0.1:9/mock/v1/chat/completions',
    LIBRARIAN_NEMOTRON_MODEL: 'nvidia/some-other-model',
  });
  const r = await call('POST', Object.assign({ provider: 'nemotron' }, ASK), { env, fetch: fetchStub });
  assert.equal(r.code, 200);
  assert.equal(fetchStub.calls[0].url, 'http://127.0.0.1:9/mock/v1/chat/completions');
  assert.equal(fetchStub.calls[0].body.model, 'nvidia/some-other-model');
});

test('the gptoss base URL is environment-overridable (this is what dev_site mocks)', async () => {
  const fetchStub = providerStub([[ASK.candidates[0].id]]);
  const env = Object.assign({}, KEYS,
    { LIBRARIAN_GPTOSS_URL: 'http://127.0.0.1:8131/__mock/v1/chat/completions' });
  const r = await call('POST', ASK, { env, fetch: fetchStub });
  assert.equal(r.code, 200);
  assert.equal(fetchStub.calls[0].url, 'http://127.0.0.1:8131/__mock/v1/chat/completions');
});

// ------------------------------------------------------- no Vercel helpers --

test('the handler works on a bare stream/response pair with no Vercel helpers', async () => {
  const req = makeReq('POST', ASK);
  assert.equal(req.body, undefined, 'the stub has no req.body');
  assert.equal(req.query, undefined, 'the stub has no req.query');
  assert.equal(req.cookies, undefined, 'the stub has no req.cookies');

  const fetchStub = providerStub([[ASK.candidates[0].id]]);
  const r = await call('POST', ASK, { env: KEYS, fetch: fetchStub }, /* poison */ true);
  assert.equal(r.code, 200, 'a poisoned res.status/json/send was never touched');
  assert.match(String(r.headers['content-type'] || ''), /application\/json/);
});

test('the source itself references no Vercel-injected helper', () => {
  const src = fs.readFileSync(path.join(ROOT, 'api', 'librarian.js'), 'utf8');
  const banned = /req\.(body|query|cookies)|res\.(status|json|send)\(/g;
  assert.deepEqual(src.match(banned), null, 'raw node only — no Vercel helpers');
});

// ------------------------------------------------- abuse protection (F1) --

test('a cross-origin request is refused before any provider is called', async () => {
  const fetchStub = providerStub([[ASK.candidates[0].id]]);
  const r = await call('POST', ASK, { env: KEYS, fetch: fetchStub }, false,
    { headers: { origin: 'https://evil.example.com', host: 'docs.example.org' } });
  assert.equal(r.code, 403);
  assert.equal(fetchStub.calls.length, 0, 'no provider call, so no quota spent');
  for (const name of Object.keys(r.headers)) {
    assert.ok(!/^access-control-/i.test(name), `no permissive CORS header (${name})`);
  }
});

test('an opaque or unparseable Origin is refused too', async () => {
  for (const origin of ['null', 'not a url', '://nope']) {
    const fetchStub = providerStub([[ASK.candidates[0].id]]);
    const r = await call('POST', ASK, { env: KEYS, fetch: fetchStub }, false,
      { headers: { origin, host: 'docs.example.org' } });
    assert.equal(r.code, 403, `origin ${JSON.stringify(origin)} must be refused`);
    assert.equal(fetchStub.calls.length, 0);
  }
});

test('a same-origin request is allowed', async () => {
  const fetchStub = providerStub([[ASK.candidates[0].id]]);
  const r = await call('POST', ASK, { env: KEYS, fetch: fetchStub }, false,
    { headers: { origin: 'https://docs.example.org', host: 'docs.example.org' } });
  assert.equal(r.code, 200);
  assert.equal(fetchStub.calls.length, 1);
});

test('an origin on a different port of the same host is allowed', async () => {
  const fetchStub = providerStub([[ASK.candidates[0].id]]);
  const r = await call('POST', ASK, { env: KEYS, fetch: fetchStub }, false,
    { headers: { origin: 'https://docs.example.org:8443', host: 'docs.example.org:443' } });
  assert.equal(r.code, 200);
});

test('a localhost origin is allowed, so tools/dev_site.mjs keeps working', async () => {
  for (const origin of ['http://localhost:8131', 'http://127.0.0.1:8131', 'http://[::1]:8131']) {
    const fetchStub = providerStub([[ASK.candidates[0].id]]);
    const r = await call('POST', ASK, { env: KEYS, fetch: fetchStub }, false,
      { headers: { origin, host: 'docs.example.org' } });
    assert.equal(r.code, 200, `${origin} must be allowed`);
  }
});

test('a request with no Origin at all is allowed', async () => {
  const fetchStub = providerStub([[ASK.candidates[0].id]]);
  const r = await call('POST', ASK, { env: KEYS, fetch: fetchStub });
  assert.equal(r.code, 200);
});

test('the per-key limit answers 429 with retry-after and spends no quota', async () => {
  const limiter = handler.createLimiter({ perKey: 3, global: 1000 });
  const fetchStub = providerStub([[ASK.candidates[0].id]]);
  const wire = { headers: { 'x-forwarded-for': '203.0.113.7, 70.41.3.18' } };
  const deps = { env: KEYS, fetch: fetchStub, limiter };

  for (let i = 0; i < 3; i += 1) {
    const ok = await call('POST', ASK, deps, false, wire);
    assert.equal(ok.code, 200, `request ${i + 1} should still be allowed`);
  }
  const blocked = await call('POST', ASK, deps, false, wire);
  assert.equal(blocked.code, 429);
  assert.ok(Number(blocked.headers['retry-after']) >= 1, 'retry-after is a positive number of seconds');
  assert.equal(fetchStub.calls.length, 3, 'the refused request never reached a provider');

  // a different client is unaffected: the window is per key, not global here
  const other = await call('POST', ASK, deps, false,
    { headers: { 'x-forwarded-for': '198.51.100.4' } });
  assert.equal(other.code, 200);
});

test('the per-instance ceiling applies even when the client key is unknown', async () => {
  const limiter = handler.createLimiter({ perKey: 1000, global: 2 });
  const fetchStub = providerStub([[ASK.candidates[0].id]]);
  const deps = { env: KEYS, fetch: fetchStub, limiter };
  assert.equal((await call('POST', ASK, deps)).code, 200);
  assert.equal((await call('POST', ASK, deps)).code, 200);
  const blocked = await call('POST', ASK, deps);
  assert.equal(blocked.code, 429);
  assert.equal(fetchStub.calls.length, 2);
});

test('only the FIRST x-forwarded-for entry is trusted as the key', async () => {
  const limiter = handler.createLimiter({ perKey: 1, global: 1000 });
  const deps = { env: KEYS, fetch: providerStub([[ASK.candidates[0].id]]), limiter };
  const first = await call('POST', ASK, deps, false,
    { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } });
  assert.equal(first.code, 200);
  // same real client, a different appended hop — must still be the same key
  const again = await call('POST', ASK, deps, false,
    { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.2' } });
  assert.equal(again.code, 429, 'appending a hop must not buy a fresh budget');
});

test('a direct loopback connection is exempt from the per-key limit', async () => {
  const limiter = handler.createLimiter({ perKey: 2, global: 1000 });
  const deps = { env: KEYS, fetch: providerStub([[ASK.candidates[0].id]]), limiter };
  const wire = { socket: { remoteAddress: '127.0.0.1' } };   // no x-forwarded-for
  for (let i = 0; i < 6; i += 1) {
    const r = await call('POST', ASK, deps, false, wire);
    assert.equal(r.code, 200, `loopback request ${i + 1} must not be throttled`);
  }
  assert.equal(limiter.size(), 0, 'an exempt client is never even recorded');
});

/* Every candidate string is client-controlled and goes verbatim into the
   provider prompt, so a public caller must not be able to buy prompt tokens
   with a well-formed request. Per-field caps plus one aggregate ceiling. */
/* The prompt is JSON nested inside the provider request's JSON, so read it back
   by parsing rather than by substring — escaped quotes make substring checks
   quietly wrong. Returns the {query, candidates, catalog} object as sent. */
function sentPrompt(init) {
  const wire = JSON.parse(init.body);
  const user = wire.messages.find((m) => m.role === 'user');
  return JSON.parse(user.content);
}

test('oversized candidate fields are truncated before they reach a provider', async () => {
  let sent = null;
  const stub = providerStub([['x']]);
  const deps = { env: KEYS, fetch: (url, init) => { sent = init; return stub(url, init); } };
  const huge = 'A'.repeat(50000);
  const r = await call('POST', {
    q: 'thruster model',
    candidates: [{ id: huge, title: huge, kind: huge, where: huge, snippet: huge }],
  }, deps, false);
  assert.equal(r.code, 200);
  const row = sentPrompt(sent).candidates[0];
  assert.ok(row.id.length <= 200, `id capped, got ${row.id.length}`);
  assert.ok(row.title.length <= 200, `title capped, got ${row.title.length}`);
  assert.ok(row.kind.length <= 40, `kind capped, got ${row.kind.length}`);
  assert.ok(row.where.length <= 200, `where capped, got ${row.where.length}`);
  assert.ok(row.snippet.length <= 240, `snippet capped, got ${row.snippet.length}`);
  assert.ok(String(sent.body).length < 60000,
    `250 KB of posted fields must not become a 250 KB prompt, got ${String(sent.body).length}`);
});

test('the aggregate candidate budget keeps the best-ranked prefix', async () => {
  let sent = null;
  const stub = providerStub([['c0']]);
  const deps = { env: KEYS, fetch: (url, init) => { sent = init; return stub(url, init); } };
  const rows = [];
  for (let i = 0; i < 40; i += 1) {
    rows.push({
      id: `c${i}`, title: 'T'.repeat(200), kind: 'page',
      where: 'W'.repeat(200), snippet: 'S'.repeat(240),
    });
  }
  const r = await call('POST', { q: 'thruster model', candidates: rows }, deps, false);
  assert.equal(r.code, 200);
  const kept = sentPrompt(sent).candidates;
  assert.equal(kept[0].id, 'c0', 'the top-ranked candidate is always kept');
  assert.ok(kept.length < 40, `the aggregate cap dropped the tail, kept ${kept.length}`);
  const chars = kept.reduce((n, c) =>
    n + c.id.length + c.title.length + c.kind.length + c.where.length + c.snippet.length, 0);
  assert.ok(chars <= 24 * 1024, `aggregate candidate chars ${chars} within budget`);
  // the prefix is contiguous from the top — no gaps
  kept.forEach((c, i) => assert.equal(c.id, `c${i}`));
});

/* The loopback exemption is a developer convenience (the bench fires 30 POSTs
   from 127.0.0.1). On a serverless host it must be provably dead, not merely
   unreachable-in-practice: VERCEL / AWS_LAMBDA_FUNCTION_NAME kill it outright,
   so even a request presented as a direct loopback connection is throttled. */
test('the loopback exemption is switched off on a serverless host', async () => {
  const limiter = handler.createLimiter({ perKey: 2, global: 1000 });
  const deps = { env: KEYS, fetch: providerStub([[ASK.candidates[0].id]]), limiter };
  const wire = { socket: { remoteAddress: '127.0.0.1' } };   // no x-forwarded-for
  const saved = process.env.VERCEL;
  process.env.VERCEL = '1';
  try {
    assert.equal((await call('POST', ASK, deps, false, wire)).code, 200);
    assert.equal((await call('POST', ASK, deps, false, wire)).code, 200);
    assert.equal((await call('POST', ASK, deps, false, wire)).code, 429,
      'on a hosted runtime the per-key budget applies to loopback too');
    assert.ok(limiter.size() > 0, 'a hosted loopback client IS recorded');
  } finally {
    if (saved === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = saved;
  }
});

test('a proxied request from a loopback-looking address is NOT exempt', async () => {
  const limiter = handler.createLimiter({ perKey: 1, global: 1000 });
  const deps = { env: KEYS, fetch: providerStub([[ASK.candidates[0].id]]), limiter };
  const wire = { headers: { 'x-forwarded-for': '127.0.0.1' } };
  assert.equal((await call('POST', ASK, deps, false, wire)).code, 200);
  assert.equal((await call('POST', ASK, deps, false, wire)).code, 429);
});

test('the limiter map is hard-capped and cannot grow without bound', async () => {
  const limiter = handler.createLimiter({ perKey: 5, global: 1000000, maxKeys: 40 });
  const deps = { env: KEYS, fetch: providerStub([[ASK.candidates[0].id]]), limiter };
  for (let i = 0; i < 400; i += 1) {
    await call('POST', ASK, deps, false, { headers: { 'x-forwarded-for': `198.51.100.${i}` } });
  }
  assert.ok(limiter.size() <= 40, `expected <= 40 tracked keys, got ${limiter.size()}`);
});

test('expired windows are evicted rather than accumulating', () => {
  const limiter = handler.createLimiter({ perKey: 2, global: 1000, windowMs: 1000 });
  const t0 = 1000000;
  for (let i = 0; i < 50; i += 1) limiter.check(`k${i}`, t0, false);
  assert.equal(limiter.size(), 50);
  // one request a full window later sweeps everything that has aged out
  limiter.check('later', t0 + 5000, false);
  assert.equal(limiter.size(), 1, 'only the live window survives');
});

test('the shared per-instance limiter is what a real deployment uses', async () => {
  handler.defaultLimiter.reset();
  const fetchStub = providerStub([[ASK.candidates[0].id]]);
  const wire = { headers: { 'x-forwarded-for': '203.0.113.55' } };
  let refusedAt = 0;
  for (let i = 1; i <= 20; i += 1) {
    const r = await call('POST', ASK, { env: KEYS, fetch: fetchStub, limiter: handler.defaultLimiter },
      false, wire);
    if (r.code === 429) { refusedAt = i; break; }
  }
  assert.ok(refusedAt > 0 && refusedAt <= 13,
    `the default limiter must throttle a burst (refused at ${refusedAt || 'never'})`);
  handler.defaultLimiter.reset();
});
