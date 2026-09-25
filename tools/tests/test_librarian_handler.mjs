// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 5 September 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test serverless librarian request handling, provider calls, and safe failure responses.
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

function modelReply(content) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }),
    text: async () => content,
  };
}

/* A hop answer in the shape the walk asks for: {"hits":[{id,why}], "open":[…]}.
   `hits` entries may be bare id strings; `open` is left out when unset. */
function hopDoc(spec) {
  const hits = (spec.hits || []).map((h) => (typeof h === 'string' ? { id: h, why: 'because' } : h));
  const doc = { hits };
  if (spec.open !== undefined) doc.open = spec.open;
  return JSON.stringify(doc);
}

/* An OpenAI-compatible chat-completions stub. `answers` is consumed in order,
   the LAST entry repeating for every further call. Each entry is one of:
     [id, id, …]           a 200 answering {hits: those ids, open: []}
     {hits, open}          a 200 answering exactly that hop document
     {status, text}        an upstream HTTP failure
     "raw text"            a 200 carrying that content verbatim
     an Error              thrown, as a network error is
     (n, url, init) => …   called with the 1-based call number (may throw)   */
function providerStub(answers) {
  const calls = [];
  const queue = answers.slice();
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof next === 'function') return next(calls.length, url, init);
    if (next instanceof Error) throw next;
    if (Array.isArray(next)) return modelReply(hopDoc({ hits: next, open: [] }));
    if (typeof next === 'string') return modelReply(next);
    if (next && typeof next === 'object' && next.status === undefined) return modelReply(hopDoc(next));
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

test('every pre-body rejection tells the client to close the connection', async () => {
  // 405 / 403 / 429 all answer before the body is read; a client that kept
  // the socket open could otherwise leave an unread body pinning it.
  const r405 = await call('GET', undefined, { env: KEYS });
  assert.equal(r405.code, 405);
  assert.equal(r405.headers.connection, 'close');
  const r403 = await call('POST', ASK, { env: KEYS }, false,
    { headers: { origin: 'https://evil.example', host: 'docs.example.org' } });
  assert.equal(r403.code, 403);
  assert.equal(r403.headers.connection, 'close');
  const limiter = { check: () => ({ ok: false, retryAfter: 7 }) };
  const r429 = await call('POST', ASK, { env: KEYS, limiter });
  assert.equal(r429.code, 429);
  assert.equal(r429.headers.connection, 'close');
});

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

test('an oversized body gets a real 413 on a live socket, not a connection reset', async () => {
  // A 600 KiB body arrives in 60 chunks. The handler must answer 413 while the
  // request is still readable: destroying the socket first would leave the client
  // with a reset and no JSON error. The response must also tell the client to
  // drop the connection, since the unread remainder cannot be reused.
  const chunk = Buffer.alloc(10 * 1024, 'x');
  const req = Readable.from(Array.from({ length: 60 }, () => chunk));
  req.method = 'POST';
  req.url = '/api/librarian';
  req.headers = { 'content-type': 'application/json', host: 'docs.example.org' };
  // Node auto-destroys a Readable once it has ended; that is bookkeeping, not a
  // teardown. Only a destroy while the body is still unread counts as the bug.
  let destroyedMidStream = false;
  const realDestroy = req.destroy.bind(req);
  req.destroy = (...a) => { if (!req.readableEnded) destroyedMidStream = true; return realDestroy(...a); };
  const res = makeRes(true);
  await handler(req, res, { env: {}, dataDir: DATA, fetch: async () => { throw new Error('no provider call expected'); } });
  await res.done;
  assert.equal(res.code, 413);
  assert.equal(destroyedMidStream, false, 'socket was destroyed while the body was still unread');
  assert.match(JSON.parse(res.body).error, /over \d+ bytes/);
  assert.equal(res.headers.connection, 'close');
  // the drain finished on its own
  await new Promise((r) => (req.readableEnded ? r() : req.once('end', r)));
  assert.equal(req.readableEnded, true);
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
  /* This test used to carry the invariant "only candidate ids, never an
     invented one". The walk answers with ids the client never sent — catalog
     ids, and code-level sym:/file: ids — so that invariant is REPLACED here by
     a strictly stronger one: every returned id must RESOLVE against real site
     data (a candidate id, a catalog id, or a validated sym:/file: id), and
     everything that does not resolve is dropped. Strictly stronger because the
     old rule allowed any candidate id through unchecked and said nothing at all
     about the rest; this one checks every id against what actually ships. The
     hallucinated-id assertion survives inside it, on three shapes not one. */
  const known = ASK.candidates.map((c) => c.id);
  const fetchStub = providerStub([{
    open: [],
    hits: [
      known[5], 'hallucinated:id', known[1], 'page:#/no/such/route', known[5],
      known[0], 'sym:esc:no/such/file.h:Nope', known[2], known[3], 'repo:esc',
      known[4], known[6], known[7], known[8], known[9], known[10],
    ],
  }]);
  const r = await call('POST', ASK, { env: KEYS, fetch: fetchStub });
  assert.equal(r.code, 200);
  assert.equal(r.json.provider, 'nemotron', 'nemotron super is the primary');
  assert.ok(Array.isArray(r.json.results));
  assert.equal(r.json.results.length, 8, 'capped at 8');
  assert.equal(r.json.results[0].id, known[5]);
  assert.equal(r.json.results[1].id, known[1], 'the unknown id was dropped');
  const ids = r.json.results.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, 'deduped');
  for (const bad of ['hallucinated:id', 'page:#/no/such/route', 'sym:esc:no/such/file.h:Nope']) {
    assert.ok(!ids.includes(bad), `${bad} does not resolve, so it must not be returned`);
  }
  for (const row of r.json.results) {
    assert.equal(typeof row.why, 'string');
    const resolved = known.includes(row.id)
      || (typeof row.href === 'string' && /^(#\/|https:\/\/github\.com\/)/.test(row.href));
    assert.ok(resolved, `${row.id} resolves against real site data`);
  }
  // the one catalog id in the answer resolved to a real repository row
  const repo = r.json.results.find((x) => x.kind === 'repo');
  assert.equal(repo.href, 'https://github.com/HippoCampusRobotics/esc');
});

test('the outgoing provider request is temperature 0 and carries the candidates', async () => {
  const fetchStub = providerStub([[ASK.candidates[0].id]]);
  const r = await call('POST', ASK, { env: KEYS, fetch: fetchStub });
  assert.equal(r.code, 200);
  const sent = fetchStub.calls[0];
  assert.equal(sent.body.temperature, 0);
  assert.equal(sent.body.model, 'nvidia/nemotron-3-super-120b-a12b:free');
  assert.ok(sent.body.model.endsWith(':free'), 'free models only — Kyle, 2026-09-04');
  assert.deepEqual(sent.body.provider, { order: ['Nvidia'], allow_fallbacks: true },
    'the upstream is pinned to the one that was measured');
  assert.deepEqual(sent.body.reasoning, { enabled: false }, 'a re-rank is not a reasoning task');
  assert.equal(sent.body.max_tokens, 2000, '900 truncated answers with long code ids');
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
  const wrapped = `<think>weighing the options</think>\n\`\`\`json\n{"hits":[{"id":"${id}","why":"w"}]}\n\`\`\``;
  const r = await call('POST', ASK, { env: KEYS, fetch: providerStub([wrapped]) });
  assert.equal(r.code, 200);
  assert.deepEqual(r.json.results.map((x) => x.id), [id]);
});

test('an answer that stops one closer short is repaired, not rejected', async () => {
  // Real nano output, 2026-09-04: valid JSON minus the final `}`; finish "stop".
  // parseModelJson returns the whole hop DOCUMENT now (the walk needs `open`
  // as well as `hits`), so the rows are read off `.hits`.
  const id = ASK.candidates[1].id;
  const short = `\n{"hits":[{"id":${JSON.stringify(id)},"why":"Directly defines it."}]`;
  assert.deepEqual(handler.parseModelJson(short).hits.map((r) => r.id), [id]);
  // Two closers missing, and a bracket inside a string must not confuse it.
  const shorter = `{"hits":[{"id":${JSON.stringify(id)},"why":"see [1] and {x}"}`;
  assert.deepEqual(handler.parseModelJson(shorter).hits.map((r) => r.id), [id]);
  // Not merely unfinished: a mismatched closer, or cut off inside a string.
  assert.equal(handler.parseModelJson('{"hits":[}'), null);
  assert.equal(handler.parseModelJson('{"hits":[{"id":"abc'), null);
  assert.equal(handler.parseModelJson('{"hits":[{"id":1}]}garbage'), null);
  // A document with no hits array at all is not an answer.
  assert.equal(handler.parseModelJson('{"open":["esc"]}'), null);
  // End to end: the primary answers short, the request still succeeds on it.
  const fetchStub = providerStub([short]);
  const r = await call('POST', ASK, { env: KEYS, fetch: fetchStub });
  assert.equal(r.code, 200);
  assert.equal(r.json.provider, 'nemotron');
  assert.equal(fetchStub.calls.length, 1, 'no fallback was needed');
  assert.deepEqual(r.json.results.map((x) => x.id), [id]);
});

test('a provider that answers 200 with unusable content twice falls through', async () => {
  /* STRICTLY STRONGER than the version this replaces. That one stubbed ONE
     unusable answer and asserted only that the OTHER entry answered on call 2.
     A parse or empty failure now buys the primary one retry of itself first
     (measured 2026-09-05: the same request garbles once and answers cleanly the
     next time, which switching to the weaker fallback does not fix), so this
     pins the WHOLE ladder — primary, primary retry, then the fallback — and
     still asserts the fall-through it always asserted. */
  const id = ASK.candidates[2].id;
  const fetchStub = providerStub(['I cannot help with that.', 'still not JSON', [id]]);
  const r = await call('POST', ASK, { env: KEYS, fetch: fetchStub });
  assert.equal(r.code, 200);
  assert.equal(r.json.provider, 'nano');
  assert.equal(fetchStub.calls.length, 3);
  assert.equal(fetchStub.calls[0].body.model, fetchStub.calls[1].body.model,
    'call 2 is the SAME entry retried, not the fallback');
  assert.notEqual(fetchStub.calls[2].body.model, fetchStub.calls[0].body.model,
    'call 3 is the fallback, and it is the last one');
});

// ------------------------------------------------------------ the fallback --

test('a failing primary falls back to the other provider', async () => {
  const id = ASK.candidates[4].id;
  const fetchStub = providerStub([{ status: 503, text: 'nvidia is down' }, [id]]);
  const r = await call('POST', ASK, { env: KEYS, fetch: fetchStub });
  assert.equal(r.code, 200);
  assert.equal(r.json.provider, 'nano');
  assert.deepEqual(r.json.results.map((x) => x.id), [id]);
  assert.equal(fetchStub.calls.length, 2, 'exactly one retry, on the OTHER provider');
  assert.equal(fetchStub.calls[0].url, fetchStub.calls[1].url,
    'same gateway by construction — see the PROVIDERS note in api/librarian.js');
  assert.notEqual(fetchStub.calls[0].body.model, fetchStub.calls[1].body.model,
    'the retry used the OTHER entry: same endpoint, different model');
  assert.equal(fetchStub.calls[1].body.model, 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free');
  assert.ok(fetchStub.calls[1].body.model.endsWith(':free'), 'the fallback is free too');
  assert.deepEqual(fetchStub.calls[1].body.provider.order, ['Nvidia'],
    'the fallback entry carries its own upstream pin');
  assert.deepEqual(fetchStub.calls[1].body.reasoning, { enabled: false },
    'nemotron thinks past the deadline unless told not to');
});

test('both providers failing is a 502 that says why', async () => {
  const fetchStub = providerStub([{ status: 500, text: 'boom' }]);
  const r = await call('POST', ASK, { env: KEYS, fetch: fetchStub });
  assert.equal(r.code, 502);
  assert.equal(fetchStub.calls.length, 2);
  assert.ok(Array.isArray(r.json.providers));
  assert.deepEqual(r.json.providers.map((p) => p.provider), ['nemotron', 'nano']);
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
  assert.deepEqual(r.json.providers.map((p) => p.provider), ['nemotron', 'nano']);
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
    LIBRARIAN_NEMOTRON_MODEL: 'nvidia/some-other-model:free',
  });
  const r = await call('POST', Object.assign({ provider: 'nemotron' }, ASK), { env, fetch: fetchStub });
  assert.equal(r.code, 200);
  assert.equal(fetchStub.calls[0].url, 'http://127.0.0.1:9/mock/v1/chat/completions');
  assert.equal(fetchStub.calls[0].body.model, 'nvidia/some-other-model:free');
});

test('a Llama-family model override is refused, not forwarded', async () => {
  // POLICY: no Llama model in any role. The env override is the only path by
  // which a different id can reach OpenRouter, so it must be the checked path.
  const fetchStub = providerStub([[ASK.candidates[0].id]]);
  const env = Object.assign({}, KEYS, { LIBRARIAN_NEMOTRON_MODEL: 'meta-llama/llama-4-maverick' });
  const r = await call('POST', Object.assign({ provider: 'nemotron' }, ASK), { env, fetch: fetchStub });
  assert.equal(r.code, 502);
  assert.equal(fetchStub.calls.length, 0, 'the forbidden model must never be sent upstream');
  assert.match(r.json.providers[0].reason, /Llama-family model, which policy forbids/);
  // unpinned, the refused primary is skipped and the fallback answers
  const stub2 = providerStub([[ASK.candidates[0].id]]);
  const r2 = await call('POST', ASK, { env, fetch: stub2 });
  assert.equal(r2.code, 200);
  assert.equal(r2.json.provider, 'nano');
  assert.equal(stub2.calls.length, 1, 'the forbidden primary was never called');
});

test('a paid model override is refused, so a stale env var cannot start billing', async () => {
  // Free-only is a billing guarantee, and the override is the only path around
  // the built-in ids. A paid id (no :free suffix) on either entry is skipped.
  const fetchStub = providerStub([[ASK.candidates[0].id]]);
  const env = Object.assign({}, KEYS, {
    LIBRARIAN_NEMOTRON_MODEL: 'nvidia/nemotron-3-super-120b-a12b',
    LIBRARIAN_NANO_MODEL: 'openai/gpt-oss-120b',
  });
  const r = await call('POST', ASK, { env, fetch: fetchStub });
  assert.equal(r.code, 502);
  assert.equal(fetchStub.calls.length, 0, 'no paid model is ever sent upstream');
  assert.deepEqual(r.json.providers.map((p) => p.provider), ['nemotron', 'nano']);
  for (const p of r.json.providers) assert.match(p.reason, /paid model; only :free variants/);
});

test('the primary base URL is environment-overridable (this is what dev_site mocks)', async () => {
  const fetchStub = providerStub([[ASK.candidates[0].id]]);
  const env = Object.assign({}, KEYS,
    { LIBRARIAN_NEMOTRON_URL: 'http://127.0.0.1:8131/__mock/v1/chat/completions' });
  const r = await call('POST', ASK, { env, fetch: fetchStub });
  assert.equal(r.code, 200);
  assert.equal(fetchStub.calls[0].url, 'http://127.0.0.1:8131/__mock/v1/chat/completions');
});

// ------------------------------------------------------- free-only policy --

test('every provider is a free variant and the deadlines fit the function', () => {
  // Kyle, 2026-09-04: free models only, set and forget. The budget is now one
  // SEARCH budget rather than a sum of two calls: every call is clamped to what
  // is left of SEARCH_BUDGET_MS, and that budget plus slack sits under
  // maxDuration: 15. The double-timeout path (super 8000 then nano 5000) has to
  // fit inside the budget by CONSTANTS alone, with no appeal to runtime luck.
  const providers = handler.PROVIDERS;
  assert.equal(providers.length, 2);
  for (const p of providers) {
    assert.ok(p.model.endsWith(':free'), `${p.name} must be a free model, got ${p.model}`);
    assert.ok(!/llama/i.test(p.model), `${p.name} must not be a Llama-family model`);
    assert.ok(Number.isInteger(p.timeoutMs) && p.timeoutMs > 0, `${p.name} needs a deadline`);
    assert.ok(p.timeoutMs <= handler.SEARCH_BUDGET_MS,
      `${p.name}'s ceiling ${p.timeoutMs}ms must fit the search budget`);
  }
  assert.ok(handler.SEARCH_BUDGET_MS + handler.TIMEOUT_SLACK_MS <= handler.FUNCTION_MAX_DURATION_MS,
    'the search budget plus slack must sit under the function ceiling');
  const ceilings = providers.reduce((n, p) => n + p.timeoutMs, 0);
  assert.ok(ceilings <= handler.SEARCH_BUDGET_MS,
    `a hop that times out on both entries costs ${ceilings}ms — over the budget`);
  assert.equal(handler.MAX_MODEL_CALLS, 3, 'at most three model calls per search');
  assert.ok(handler.MIN_HOP_MS > 0 && handler.MIN_HOP_MS < handler.SEARCH_BUDGET_MS);
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const fn = vercel.functions && vercel.functions['api/librarian.js'];
  assert.ok(fn, 'vercel.json declares api/librarian.js');
  assert.equal(fn.maxDuration * 1000, handler.FUNCTION_MAX_DURATION_MS,
    'the constant mirrors vercel.json; change both or neither');
  assert.equal(fn.includeFiles, '{data/graph,search}/**',
    'the walk reads the graph AND the search index out of its own bundle');
});

test('each provider is aborted at its own deadline, and the message says which', async () => {
  // A stub that never resolves until aborted; the primary (8000ms) must be
  // cut at 8000, the fallback (5000ms) at 5000, and the reasons must name it.
  const timers = [];
  const hanging = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
    });
  });
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...a) => { timers.push(ms); return realSetTimeout(fn, 0, ...a); };
  try {
    const r = await call('POST', ASK, { env: KEYS, fetch: hanging });
    assert.equal(r.code, 502);
    assert.deepEqual(r.json.providers.map((p) => p.reason),
      ['timed out after 8000ms', 'timed out after 5000ms']);
    assert.ok(timers.includes(8000) && timers.includes(5000), 'both deadlines were armed');
  } finally {
    global.setTimeout = realSetTimeout;
  }
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

test('the source itself references no Vercel-injected helper, and carries no NUL byte', () => {
  const handlerPath = path.join(ROOT, 'api', 'librarian.js');
  const src = fs.readFileSync(handlerPath, 'utf8');
  const banned = /req\.(body|query|cookies)|res\.(status|json|send)\(/g;
  assert.deepEqual(src.match(banned), null, 'raw node only — no Vercel helpers');
  /* STRICTLY STRONGER than the Vercel-helper check alone: the file must also be
     text a text tool can read. A raw 0x00 in the source (it lived in the
     siteIndex cache key) makes grep call the whole file binary and answer
     nothing — `grep -c OPENROUTER_API_KEY api/librarian.js` printed a blank
     line instead of 2 — so every audit of this file silently returned empty.
     Read as latin1, so one byte is one char and a NUL cannot hide. */
  const bytes = fs.readFileSync(handlerPath, 'latin1');
  assert.equal(bytes.indexOf('\x00'), -1,
    'a raw NUL byte makes grep treat the handler as binary — write \\u0000 instead');
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

// ==========================================================================
//  the walk: two hops over the site's own graphs (plan §3, A.8)
// ==========================================================================

/* These tests read the REAL data — data/graph/** and search/** — because the
   whole point of server-side resolution is that an id the model returns is
   checked against what actually ships. js/search.js is imported to build the
   very rows the browser would build, so href byte-equality is asserted against
   the client's own code rather than against a copy of its rules. */
const search = require(path.join(ROOT, 'js', 'search.js'));
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

const ESC_REPO = 'repo:esc';
const ESC_URL = 'https://github.com/HippoCampusRobotics/esc';
const AFRO_PAGE = 'page:#/setup/hippocampus-bringup/afro-esc';
const AFRO_SYM = 'sym:esc:include/afro_esc.h:AfroESC';

function ctxFor(candidateIds) {
  return handler.createContext({ dataDir: DATA, siteDir: ROOT, candidateIds: candidateIds || [] });
}
function shardItems(file) {
  return search.buildItems([readJson(path.join(ROOT, file))]);
}
let ALL_ITEMS = null;
function siteItems() {
  if (!ALL_ITEMS) {
    const manifest = readJson(path.join(ROOT, 'search', 'manifest.json'));
    ALL_ITEMS = search.buildItems(manifest.shards.map((s) => readJson(path.join(ROOT, s.file))));
  }
  return ALL_ITEMS;
}
function userMessage(sent) {
  return sent.body.messages.find((m) => m.role === 'user').content;
}
function hanging(url, init) {
  return new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
    });
  });
}

test('the two-hop walk resolves a sym row byte-identically to the client AfroESC row', async () => {
  const fetchStub = providerStub([
    { hits: [ESC_REPO, AFRO_PAGE], open: ['esc'] },
    { hits: [ESC_REPO, AFRO_PAGE, AFRO_SYM, 'repo:tgy'] },
  ]);
  const r = await call('POST', { q: 'ESC I2C firmware', candidates: [] },
    { env: KEYS, fetch: fetchStub });
  assert.equal(r.code, 200);
  assert.equal(fetchStub.calls.length, 2);
  assert.equal(r.json.calls, 2);
  assert.equal(r.json.hops, 2);
  assert.equal(r.json.partial, false);
  assert.equal(r.json.results.length, 4);
  assert.equal(typeof r.json.ms, 'number');

  const client = shardItems('search/code-esc.json').find((i) => i.title === 'AfroESC');
  const sym = r.json.results.find((x) => x.title === 'AfroESC');
  assert.ok(sym, 'the sym id resolved');
  assert.equal(sym.href, client.href, 'byte-equal href with what js/search.js builds');
  assert.equal(sym.id, `${client.kind}:${client.href}`, 'byte-equal id, the <kind>:<href> scheme');
  assert.equal(sym.where, client.where);
  assert.equal(sym.snippet, client.snippet);
  assert.equal(r.json.results[0].href, ESC_URL, 'the repository row leads');
  assert.equal(r.json.results[1].href, '#/setup/hippocampus-bringup/afro-esc');
});

test('hop 1 answering open: [] costs exactly one call and reports hops 1', async () => {
  const fetchStub = providerStub([{ hits: [ESC_REPO], open: [] }]);
  const r = await call('POST', { q: 'esc i2c driver', candidates: [] },
    { env: KEYS, fetch: fetchStub });
  assert.equal(r.code, 200);
  assert.equal(fetchStub.calls.length, 1, 'nothing to open means nothing to walk');
  assert.equal(r.json.calls, 1);
  assert.equal(r.json.hops, 1);
  assert.equal(r.json.partial, false);
  assert.equal(r.json.results.length, 1);
});

test('a hop 2 that fails 503 then 503 still answers 200 with partial: true after 3 calls', async () => {
  const fetchStub = providerStub([
    { hits: [ESC_REPO, AFRO_PAGE], open: ['esc'] },
    { status: 503, text: 'nvidia is down' },
  ]);
  const r = await call('POST', { q: 'ESC I2C firmware', candidates: [] },
    { env: KEYS, fetch: fetchStub });
  assert.equal(r.code, 200);
  assert.equal(r.json.calls, 3, 'hop 1 once, hop 2 on both entries');
  assert.equal(fetchStub.calls.length, 3);
  assert.equal(r.json.hops, 2);
  assert.equal(r.json.partial, true, 'the survey answered, the walk did not');
  assert.deepEqual(r.json.results.map((x) => x.href), [ESC_URL, '#/setup/hippocampus-bringup/afro-esc']);
});

test('nano takes hop 1 and super takes hop 2 in three calls — the stub throws on call 4', async () => {
  let extra = false;
  const fetchStub = providerStub([
    { status: 503, text: 'super is down' },
    { hits: [ESC_REPO, AFRO_PAGE], open: ['esc'] },
    { hits: [AFRO_SYM, ESC_REPO] },
    (n) => { extra = true; throw new Error(`there must never be a call ${n}`); },
  ]);
  const r = await call('POST', { q: 'ESC I2C firmware', candidates: [] },
    { env: KEYS, fetch: fetchStub });
  assert.equal(r.code, 200);
  assert.equal(extra, false, 'a fourth model call was made');
  assert.equal(fetchStub.calls.length, 3);
  assert.equal(r.json.calls, 3);
  assert.equal(r.json.hops, 2);
  assert.equal(r.json.partial, false);
  assert.equal(r.json.provider, 'nemotron', 'provider names whoever answered the LAST hop');
});

test('the 3-call cap skips the hop-2 fallback rather than spending a fourth call', async () => {
  let extra = false;
  const fetchStub = providerStub([
    { status: 503, text: 'super is down' },              // hop 1, call 1
    { hits: [ESC_REPO, AFRO_PAGE], open: ['esc'] },      // hop 1, call 2 (nano)
    { status: 503, text: 'super is down again' },        // hop 2, call 3
    (n) => { extra = true; throw new Error(`MAX_MODEL_CALLS is 3, not ${n}`); },
  ]);
  const r = await call('POST', { q: 'ESC I2C firmware', candidates: [] },
    { env: KEYS, fetch: fetchStub });
  assert.equal(r.code, 200);
  assert.equal(extra, false, 'the hop-2 fallback must be skipped, not spent');
  assert.equal(r.json.calls, 3);
  assert.equal(r.json.hops, 2, 'hop 2 was attempted, and failed');
  assert.equal(r.json.partial, true);
  assert.equal(r.json.provider, 'nano', 'the last hop that answered was hop 1, on nano');
  assert.equal(r.json.results.length, 2);
});

/* THE LADDER, after the 2026-09-05 measurement: primary → (primary retry, only
   after a parse or empty failure) → fallback, never more than MAX_MODEL_CALLS
   calls in a search. A garbled or empty answer is the one failure the SAME
   model fixes on a re-ask; a timeout, an HTTP error and a quota refusal are
   not, and go straight to the other entry. */

test('a parse failure retries the SAME primary once, before the fallback', async () => {
  let extra = false;
  const fetchStub = providerStub([
    'I cannot help with that.',                       // hop 1, call 1
    { hits: [ESC_REPO, AFRO_PAGE], open: [] },        // hop 1, call 2 — the RETRY
    (n) => { extra = true; throw new Error(`there must never be a call ${n}`); },
  ]);
  const r = await call('POST', { q: 'ESC I2C firmware', candidates: [] },
    { env: KEYS, fetch: fetchStub });
  assert.equal(r.code, 200);
  assert.equal(extra, false);
  assert.equal(r.json.calls, 2);
  assert.equal(r.json.provider, 'nemotron', 'the retry is the same entry, not the weaker fallback');
  assert.equal(fetchStub.calls[0].body.model, fetchStub.calls[1].body.model);
  assert.equal(r.json.hops, 1);
  assert.equal(r.json.results.length, 2);
});

test('two parse failures spend the retry and then the fallback — three calls, never four', async () => {
  let extra = false;
  const fetchStub = providerStub([
    'I cannot help with that.',                       // hop 1, call 1
    'still not JSON',                                 // hop 1, call 2 — the RETRY
    { hits: [ESC_REPO, AFRO_PAGE], open: ['esc'] },   // hop 1, call 3 — the fallback
    (n) => { extra = true; throw new Error(`MAX_MODEL_CALLS is 3, not ${n}`); },
  ]);
  const r = await call('POST', { q: 'ESC I2C firmware', candidates: [] },
    { env: KEYS, fetch: fetchStub });
  assert.equal(r.code, 200);
  assert.equal(extra, false, 'the retry never buys a fourth call');
  assert.equal(r.json.calls, 3);
  assert.equal(r.json.provider, 'nano');
  assert.equal(r.json.hops, 1, 'the 3-call cap left nothing for the walk');
  assert.equal(r.json.partial, true, 'a non-empty open that was never walked is partial');
  assert.equal(fetchStub.calls[0].body.model, fetchStub.calls[1].body.model, 'call 2 was the retry');
  assert.notEqual(fetchStub.calls[2].body.model, fetchStub.calls[0].body.model, 'call 3 was the fallback');
});

test('a primary TIMEOUT is not retried — it goes straight to the other entry', async () => {
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, 0, ...a);
  let n = 0;
  try {
    const doFetch = async (url, init) => {
      n += 1;
      if (n === 1) return hanging(url, init);
      return modelReply(hopDoc({ hits: [ESC_REPO], open: [] }));
    };
    const r = await call('POST', { q: 'ESC I2C firmware', candidates: [] },
      { env: KEYS, fetch: doFetch });
    assert.equal(r.code, 200);
    assert.equal(n, 2, 'a slow model does not get a second deadline of its own');
    assert.equal(r.json.calls, 2);
    assert.equal(r.json.provider, 'nano');
  } finally {
    global.setTimeout = realSetTimeout;
  }
});

test('an HTTP 429 goes straight to the fallback, and all-429 still reports exhausted', async () => {
  const one429 = providerStub([{ status: 429, text: 'rate limit exceeded' }, { hits: [ESC_REPO], open: [] }]);
  const r = await call('POST', { q: 'ESC I2C firmware', candidates: [] },
    { env: KEYS, fetch: one429 });
  assert.equal(r.code, 200);
  assert.equal(one429.calls.length, 2, 'a quota refusal is not a garble — no retry of the same entry');
  assert.equal(r.json.provider, 'nano');

  const all429 = providerStub([{ status: 429, text: 'rate limit exceeded' }]);
  const r2 = await call('POST', { q: 'ESC I2C firmware', candidates: [] },
    { env: KEYS, fetch: all429 });
  assert.equal(r2.code, 502);
  assert.equal(all429.calls.length, 2, 'still exactly one attempt per entry');
  assert.equal(r2.json.exhausted, true);
  assert.deepEqual(r2.json.providers.map((p) => p.attempt), [1, 1]);
});

test('every 502 provider entry names its attempt, and the retry is attempt 2', async () => {
  const fetchStub = providerStub(['not JSON at all']);
  const r = await call('POST', { q: 'ESC I2C firmware', candidates: [] },
    { env: KEYS, fetch: fetchStub });
  assert.equal(r.code, 502);
  assert.equal(fetchStub.calls.length, 3, 'primary, primary retry, fallback — and then the cap');
  assert.deepEqual(r.json.providers.map((p) => [p.provider, p.hop, p.attempt]),
    [['nemotron', 1, 1], ['nemotron', 1, 2], ['nano', 1, 1]]);
  assert.equal(r.json.exhausted, false, 'a garble is not a quota problem');
});

test('hop 2 gets the same single retry of its primary', async () => {
  const fetchStub = providerStub([
    { hits: [ESC_REPO, AFRO_PAGE], open: ['esc'] },   // hop 1, call 1
    'the walk answered prose',                        // hop 2, call 2
    { hits: [AFRO_SYM] },                             // hop 2, call 3 — the RETRY
  ]);
  const r = await call('POST', { q: 'ESC I2C firmware', candidates: [] },
    { env: KEYS, fetch: fetchStub });
  assert.equal(r.code, 200);
  assert.equal(r.json.calls, 3);
  assert.equal(r.json.hops, 2);
  assert.equal(r.json.partial, false, 'the retried walk answered');
  assert.equal(r.json.provider, 'nemotron');
  assert.equal(fetchStub.calls[1].body.model, fetchStub.calls[2].body.model,
    'the hop-2 retry is the same entry too');
  assert.equal(r.json.results[0].title, 'AfroESC');
});

test('the hop-1 prompt pulls the documenting page and the implementing repo together', async () => {
  /* The 2026-09-05 measurement: on a valid answer the model returned ONE hit
     (the repository, no setup page) and put a PROJECT name in `open`, which
     validateOpen drops, so the walk never ran. These literals are the fix, and
     they are pinned here because a prompt edit that quietly drops one of them
     is invisible to every other test in this file. */
  const fetchStub = providerStub([{ hits: [ESC_REPO], open: [] }]);
  const r = await call('POST', { q: 'ESC I2C firmware', candidates: [] },
    { env: KEYS, fetch: fetchStub });
  assert.equal(r.code, 200);
  const system = fetchStub.calls[0].body.messages.find((m) => m.role === 'system').content;
  for (const literal of ['documents it', 'implements it', 'single hit',
                         'REPOSITORY NAMES', 'specific component']) {
    assert.ok(system.includes(literal), `the hop-1 prompt must say "${literal}"`);
  }
  // the constraints the shape depends on are still stated
  assert.match(system, /at most 12 words/);
  assert.match(system, /at most 8/, 'the MAX_PICKS cap');
  assert.match(system, /at most 3 repositories/, 'the MAX_OPEN_REPOS cap');
  assert.match(system, /only when walk is true/);
  assert.match(system, /STRICT JSON/);
  assert.ok(system.length <= 1600,
    `the hop-1 system prompt is ${system.length} chars — every char is paid on every search`);
});

test('all-429 failures report exhausted; a 429/503 mix does not', async () => {
  const all429 = providerStub([{ status: 429, text: 'rate limit exceeded' }]);
  const r = await call('POST', { q: 'ESC I2C firmware', candidates: [] },
    { env: KEYS, fetch: all429 });
  assert.equal(r.code, 502);
  assert.equal(r.json.exhausted, true, 'every failure was an upstream 429');
  assert.deepEqual(r.json.providers.map((p) => p.hop), [1, 1]);
  const mixed = providerStub([{ status: 429, text: 'rate limit exceeded' }, { status: 503, text: 'down' }]);
  const r2 = await call('POST', { q: 'ESC I2C firmware', candidates: [] },
    { env: KEYS, fetch: mixed });
  assert.equal(r2.code, 502);
  assert.equal(r2.json.exhausted, false, 'one non-quota failure and it is not a quota problem');
});

test('an open list naming the fork tgy, an unknown repo or five repos is filtered and capped', async () => {
  const fetchStub = providerStub([
    {
      hits: [ESC_REPO, 'hallucinated:id', 'page:#/no/such/page'],
      open: ['tgy', 'definitely_not_a_repo', 'esc', 'hippo_control', 'uvms', 'control', 'camera'],
    },
    { hits: [ESC_REPO, 'also:hallucinated'] },
  ]);
  const r = await call('POST', { q: 'ESC I2C firmware', candidates: [] },
    { env: KEYS, fetch: fetchStub });
  assert.equal(r.code, 200);
  const hop2 = JSON.parse(userMessage(fetchStub.calls[1]));
  assert.deepEqual(hop2.repos.map((x) => x.name), ['esc', 'hippo_control', 'uvms'],
    'forks and unknown names dropped, the model order kept, capped at 3');
  assert.equal(r.json.results.length, 1, 'the hallucinated ids never became rows');
  assert.equal(r.json.results[0].href, ESC_URL);
  for (const row of r.json.results) {
    assert.ok(/^(#\/|https:\/\/github\.com\/)/.test(row.href), 'every row has a resolvable href');
  }
});

test('the hop-2 user message stays under 30000 chars with three real repos opened', async () => {
  const fetchStub = providerStub([
    { hits: [ESC_REPO, AFRO_PAGE], open: ['hippo_control', 'esc', 'uvms'] },
    { hits: [ESC_REPO] },
  ]);
  const r = await call('POST', { q: 'ESC I2C firmware control', candidates: [] },
    { env: KEYS, fetch: fetchStub });
  assert.equal(r.code, 200);
  const message = userMessage(fetchStub.calls[1]);
  assert.ok(message.length <= 30000, `hop-2 user message is ${message.length} chars`);
  const doc = JSON.parse(message);
  assert.equal(doc.repos.length, 3);
  for (const repo of doc.repos) {
    assert.ok(repo.files.length <= 80, `${repo.name}: file list capped`);
    assert.ok(repo.matches.length <= 40, `${repo.name}: query-matching symbols capped`);
  }
  assert.ok(doc.neighbours.length <= 20);
});

test('resolution units: mount_2835 byte-equality, the sym file fallback, and dropped ids', () => {
  const ctx = ctxFor(['page:#/mine']);
  const cadRow = handler.resolveHits([{ id: 'cad:motor/propdrive_2835/mount_2835.ipt', why: 'a motor mount' }], ctx)[0];
  const clientCad = shardItems('search/cad.json').find((i) => i.title === 'mount_2835');
  assert.equal(cadRow.href, clientCad.href);
  assert.equal(cadRow.id, `cad:${clientCad.href}`);
  assert.equal(cadRow.title, clientCad.title);
  assert.equal(cadRow.where, clientCad.where);
  assert.equal(cadRow.snippet, clientCad.snippet);

  // an unknown label on a known path falls back to that path's file entry
  const fallback = handler.resolveHits([{ id: 'sym:esc:include/afro_esc.h:NoSuchSymbol', why: 'w' }], ctx)[0];
  const clientFile = shardItems('search/code-esc.json')
    .find((i) => i.kind === 'file' && i.path === 'include/afro_esc.h');
  assert.equal(fallback.href, clientFile.href, 'file fallback keeps the client href');
  assert.equal(fallback.title, clientFile.title);
  assert.equal(fallback.kind, 'file');

  // an unknown path is dropped outright; so is an unknown route
  assert.deepEqual(handler.resolveHits([{ id: 'sym:esc:no/such/file.h:X', why: 'w' }], ctx), []);
  assert.deepEqual(handler.resolveHits([{ id: 'file:esc:no/such/file.h', why: 'w' }], ctx), []);
  assert.deepEqual(handler.resolveHits([{ id: 'page:#/no/such/route', why: 'w' }], ctx), []);
  assert.deepEqual(handler.resolveHits([{ id: 'repo:no_such_repo', why: 'w' }], ctx), []);
  // a path outside the shards cannot be walked into by an id
  assert.deepEqual(handler.resolveHits([{ id: 'sym:../../etc:passwd:x', why: 'w' }], ctx), []);

  // an id the client already owns comes back as {id, why} and nothing else
  const mine = handler.resolveHits([{ id: 'page:#/mine', why: 'the client owns this row' }], ctx);
  assert.deepEqual(Object.keys(mine[0]).sort(), ['id', 'why']);
  assert.equal(mine[0].why, 'the client owns this row');
});

test('walk: true rides on candidates: [], and walk: false ignores an open list', async () => {
  const empty = providerStub([{ hits: [ESC_REPO], open: [] }]);
  const r = await call('POST', { q: 'ESC I2C firmware', candidates: [] }, { env: KEYS, fetch: empty });
  assert.equal(r.code, 200, 'an empty candidate list is a real search, not a malformed request');
  assert.equal(JSON.parse(userMessage(empty.calls[0])).walk, true);

  const three = providerStub([{ hits: [candidates(3)[0].id], open: ['esc'] }]);
  const r2 = await call('POST', { q: 'thruster model', candidates: candidates(3) },
    { env: KEYS, fetch: three });
  assert.equal(r2.code, 200);
  assert.equal(JSON.parse(userMessage(three.calls[0])).walk, false,
    'three keyword hits is a strong keyword answer — one call, as before');
  assert.equal(three.calls.length, 1, 'the open list is ignored when walk was false');
  assert.equal(r2.json.hops, 1);
  assert.equal(r2.json.partial, false);

  // the 4xx cases are unchanged: a missing or non-array candidates is still 400
  for (const body of [{ q: 'two words' }, { q: 'two words', candidates: 'nope' }, { q: '  ', candidates: [] }]) {
    const bad = await call('POST', body, { env: KEYS });
    assert.equal(bad.code, 400, `${JSON.stringify(body)} is still a 400`);
  }
});

test('orderPicks moves graph rows behind the first candidate the model kept', async () => {
  const five = candidates(5);
  const fetchStub = providerStub([{ hits: [ESC_REPO, five[2].id, AFRO_PAGE, five[0].id], open: [] }]);
  const r = await call('POST', { q: 'thruster model', candidates: five }, { env: KEYS, fetch: fetchStub });
  assert.equal(r.code, 200);
  assert.deepEqual(r.json.results.map((x) => x.id),
    [five[2].id, `repo:${ESC_URL}`, AFRO_PAGE, five[0].id],
    'a kept keyword hit always leads the graph rows');

  // with no kept candidate the model's own order is untouched
  const none = providerStub([{ hits: [ESC_REPO, AFRO_PAGE], open: [] }]);
  const r2 = await call('POST', { q: 'thruster model', candidates: five }, { env: KEYS, fetch: none });
  assert.deepEqual(r2.json.results.map((x) => x.href),
    [ESC_URL, '#/setup/hippocampus-bringup/afro-esc']);
});

test('hop 2 inherits what the clock left — armed at 6100ms — and MIN_HOP_MS skips it', async () => {
  // (a) hop 1 answers at t = 6900, so hop 2 gets 13000 - 6900 = 6100ms, not the
  // 8000ms ceiling, and the abort there is reported as `timed out after 6100ms`.
  let t = 0;
  const now = () => t;
  const timers = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...a) => { timers.push(ms); return realSetTimeout(fn, 0, ...a); };
  let out = null;
  try {
    let n = 0;
    const doFetch = async (url, init) => {
      n += 1;
      if (n === 1) { t = 6900; return modelReply(hopDoc({ hits: [ESC_REPO, AFRO_PAGE], open: ['esc'] })); }
      return hanging(url, init);
    };
    const cfgs = handler.PROVIDERS.map((p) => handler.providerConfig(p, KEYS));
    out = await handler.runSearch({ q: 'ESC I2C firmware', candidates: [], pinned: null },
      ctxFor([]), cfgs, doFetch, now);
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.equal(out.ok, true);
  assert.equal(out.hops, 2);
  assert.equal(out.partial, true);
  assert.ok(timers.includes(6100), `hop 2 was armed at 6100ms; saw ${timers.join(', ')}`);
  assert.equal(out.failures[0].hop, 2);
  assert.equal(out.failures[0].reason, 'timed out after 6100ms');
  assert.equal(out.failures[1].reason, 'timed out after 5000ms', 'the fallback keeps its own ceiling');
  assert.ok(out.ms <= handler.SEARCH_BUDGET_MS, 'the simulated wall stayed inside the budget');

  // (b) MIN_HOP_MS: hop 1 answers at t = 11000, leaving 2000ms — less than the
  // 2500ms a hop is allowed to start on, so hop 2 is skipped rather than begun.
  let t2 = 0;
  let n2 = 0;
  const doFetch2 = async () => {
    n2 += 1;
    t2 = 11000;
    return modelReply(hopDoc({ hits: [ESC_REPO, AFRO_PAGE], open: ['esc'] }));
  };
  const cfgs2 = handler.PROVIDERS.map((p) => handler.providerConfig(p, KEYS));
  const out2 = await handler.runSearch({ q: 'ESC I2C firmware', candidates: [], pinned: null },
    ctxFor([]), cfgs2, doFetch2, () => t2);
  assert.equal(out2.ok, true);
  assert.equal(n2, 1, 'a hop is never started with less than MIN_HOP_MS left');
  assert.equal(out2.calls, 1);
  assert.equal(out2.hops, 1);
  assert.equal(out2.partial, true, 'budget starvation is visible, not silent');
  assert.ok(out2.ms <= handler.SEARCH_BUDGET_MS);
  assert.equal(handler.MIN_HOP_MS, 2500);
});

test('neighbours reach hop 2 in catalog id space over in- AND out-edges', async () => {
  // The afro-esc page has ZERO out-edges: its only graph link is the IN-edge
  // from the hardware hub. A directed walk would hand hop 2 an empty
  // neighbourhood for exactly the headline query, so the union is walked.
  const fetchStub = providerStub([
    { hits: [AFRO_PAGE, ESC_REPO], open: ['esc'] },
    { hits: [ESC_REPO] },
  ]);
  const r = await call('POST', { q: 'ESC I2C firmware', candidates: [] },
    { env: KEYS, fetch: fetchStub });
  assert.equal(r.code, 200);
  const hop2 = JSON.parse(userMessage(fetchStub.calls[1]));
  const ids = hop2.neighbours.map((x) => x.id);
  assert.ok(ids.includes('page:#/setup/hardware/hippocampus'),
    `the IN-edge neighbour is missing from ${JSON.stringify(ids)}`);
  for (const n of hop2.neighbours) {
    assert.ok(/^(page|repo|cad):/.test(n.id), `${n.id} is a catalog id`);
    assert.equal(typeof n.title, 'string');
    assert.equal(typeof n.why, 'string');
  }
});

test('CATALOG_MAX_CHARS bounds the catalog and the real "install ros" hop-1 message fits 48000', async () => {
  assert.equal(handler.CATALOG_MAX_CHARS, 45000);
  const catalog = handler.buildCatalog(DATA);
  const chars = JSON.stringify(catalog).length;
  assert.ok(chars <= handler.CATALOG_MAX_CHARS,
    `catalog is ${chars} chars, over CATALOG_MAX_CHARS ${handler.CATALOG_MAX_CHARS}`);

  // the real client candidate list, built by the client's own engine
  const local = search.searchItems(siteItems(), 'install ros');
  const cands = search.projectCandidates(local.results);
  assert.ok(cands.length > 0, 'the probe still has local hits');
  const fetchStub = providerStub([{ hits: [cands[0].id], open: [] }]);
  const r = await call('POST', { q: 'install ros', candidates: cands }, { env: KEYS, fetch: fetchStub });
  assert.equal(r.code, 200);
  const message = userMessage(fetchStub.calls[0]);
  assert.equal(handler.HOP1_MESSAGE_MAX_CHARS, 48000);
  assert.ok(message.length <= 48000, `hop-1 user message is ${message.length} chars`);
  assert.ok(r.json.promptChars >= message.length, 'promptChars sums what was actually sent');

  // hops reports 1 when a non-empty open was skipped by the clock
  let t = 0;
  const skipped = providerStub([(n) => {
    t = 11000;
    return modelReply(hopDoc({ hits: [ESC_REPO, AFRO_PAGE], open: ['esc'] }));
  }]);
  const r2 = await call('POST', { q: 'ESC I2C firmware', candidates: [] },
    { env: KEYS, fetch: skipped, now: () => t });
  assert.equal(r2.code, 200);
  assert.equal(r2.json.hops, 1, 'a hop that never started was never attempted');
  assert.equal(r2.json.calls, 1);
  assert.equal(r2.json.partial, true);
});

test('hop 2 cannot erase hop 1: hits: [] keeps both headline rows, a sym-only answer leads', async () => {
  const emptyWalk = providerStub([
    { hits: [ESC_REPO, AFRO_PAGE], open: ['esc'] },
    { hits: [] },
  ]);
  const r = await call('POST', { q: 'ESC I2C firmware', candidates: [] },
    { env: KEYS, fetch: emptyWalk });
  assert.equal(r.code, 200);
  assert.equal(r.json.calls, 2, 'an empty walk is a hop-level failure, not a provider failure');
  assert.equal(r.json.hops, 2);
  assert.equal(r.json.partial, true);
  assert.deepEqual(r.json.results.map((x) => x.href),
    [ESC_URL, '#/setup/hippocampus-bringup/afro-esc']);

  const symOnly = providerStub([
    { hits: [ESC_REPO, AFRO_PAGE], open: ['esc'] },
    { hits: [AFRO_SYM] },
  ]);
  const r2 = await call('POST', { q: 'ESC I2C firmware', candidates: [] },
    { env: KEYS, fetch: symOnly });
  assert.equal(r2.code, 200);
  assert.equal(r2.json.partial, false);
  assert.equal(r2.json.results.length, 3, 'additive and re-ordering, never subtractive');
  assert.equal(r2.json.results[0].title, 'AfroESC', 'the walk leads');
  assert.deepEqual(r2.json.results.slice(1).map((x) => x.href),
    [ESC_URL, '#/setup/hippocampus-bringup/afro-esc']);
});

test('probe-string: every probe string resolves to a byte-equal href', () => {
  /* The done bar is stated as literal strings a browser must show. Each one is
     derived back to the catalog id the model would answer with, and the row the
     function builds for that id must carry EXACTLY that href — no trailing
     slash, no re-encoding, no anchor. */
  const ctx = ctxFor([]);
  const CASES = [
    ['repo:esc', 'https://github.com/HippoCampusRobotics/esc'],
    ['page:#/setup/hippocampus-bringup/afro-esc', '#/setup/hippocampus-bringup/afro-esc'],
    ['repo:tgy', 'https://github.com/HippoCampusRobotics/tgy'],
    ['cad:motor/propdrive_2835/mount_2835.ipt',
      'https://github.com/FinnBreu/hippocampus-cad/blob/main/motor/propdrive_2835/mount_2835.ipt'],
    ['page:#/setup/hippocampus-bringup/motor-configuration', '#/setup/hippocampus-bringup/motor-configuration'],
  ];
  for (const [id, href] of CASES) {
    const rows = handler.resolveHits([{ id, why: 'probe' }], ctx);
    assert.equal(rows.length, 1, `${id} must resolve against real data`);
    assert.equal(rows[0].href, href, `${id} must resolve byte-equal`);
  }

  // Forward-compatible: the same check over every semantic probe on disk, so
  // the two Kyle added cannot ship pointing at something that will not resolve.
  const probes = readJson(path.join(ROOT, 'data', 'search-probes.json')).probes || [];
  const semantic = probes.filter((p) => p && p.kind === 'semantic');
  for (const probe of semantic) {
    const strings = [].concat(probe.expect || [], probe.fair || []);
    assert.ok(strings.length, `${probe.q} needs at least one expected string`);
    for (const href of strings) {
      const id = catalogIdForHref(href);
      const rows = handler.resolveHits([{ id, why: 'probe' }], ctx);
      assert.equal(rows.length, 1, `${probe.q}: ${href} → ${id} must resolve`);
      assert.equal(rows[0].href, href, `${probe.q}: ${id} must resolve byte-equal to ${href}`);
    }
  }
});

/* `#/…` is a page route; a bare github.com/<org>/<repo> is a repository; a blob
   URL under the CAD repository is a CAD part path. */
function catalogIdForHref(href) {
  if (href.startsWith('#/')) return `page:${href}`;
  const blob = /^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/main\/(.+)$/.exec(href);
  if (blob) return `cad:${blob[1].split('/').map(decodeURIComponent).join('/')}`;
  const repo = /^https:\/\/github\.com\/[^/]+\/([^/]+)$/.exec(href);
  if (repo) return `repo:${repo[1]}`;
  assert.fail(`no catalog id shape for ${href}`);
  return null;
}

test('a repaired document whose hits array is empty is a parse failure, not an empty answer', () => {
  /* Found by codex on the base commit: the closer repair turned a truncated
     `{"hits":[` into an ACCEPTED empty array. That reads as a confident
     "nothing matches", suppresses the fallback and spends the answer on a
     truncation. A repair may now only rescue a document that already carries
     at least one complete row. */
  assert.equal(handler.parseModelJson('{"hits":['), null);
  assert.equal(handler.parseModelJson('{"hits":[{'), null);
  assert.deepEqual(handler.parseModelJson('{"hits":[{"id":"repo:esc","why":"x"}').hits.map((h) => h.id),
    ['repo:esc'], 'a repair that rescues a real row is still a repair');
  // an un-repaired, genuinely well-formed empty answer is still a valid answer
  assert.deepEqual(handler.parseModelJson('{"hits":[]}').hits, []);

  /* End to end, and STRICTLY STRONGER than the version this replaces: that one
     stubbed ONE truncation and asserted the fallback answered on call 2. The
     primary now gets one retry of itself after a parse failure, so the same
     claim — a truncated empty answer never wins — has to survive the retry as
     well. Two truncations, then the fallback: the truncation loses twice. */
  const fetchStub = providerStub(['{"hits":[', '{"hits":[', { hits: [ESC_REPO], open: [] }]);
  return call('POST', { q: 'ESC I2C firmware', candidates: [] }, { env: KEYS, fetch: fetchStub })
    .then((r) => {
      assert.equal(r.code, 200);
      assert.equal(r.json.provider, 'nano', 'the truncated empty answer did not win');
      assert.equal(fetchStub.calls.length, 3, 'primary, primary retry, then the fallback');
    });
});

test('the measured garbled hop-1 answer is salvaged into its ids, not thrown away', () => {
  /* MEASURED 2026-09-05, the SAME hop-1 request sent three times on the free
     serving: nemotron super answered this once (finish_reason "stop") — a
     broken string that swallows the `why` and closes nothing — answered with an
     EMPTY body once, and answered valid JSON once. The wreck still carries the
     model's own ids in its own order, and every one of them is resolved against
     real data downstream, so reading them widens what is READ, never what is
     trusted. Before this, that answer cost the fallback call and then a 502. */
  const garbled = '{"hits":[{"id":"repo:esc],"open":["esc"]}';
  const doc = handler.parseModelJson(garbled);
  assert.deepEqual(doc.hits, [{ id: 'repo:esc', why: '' }]);
  assert.deepEqual(doc.open, ['esc']);
  assert.equal(doc.salvaged, true, 'a salvaged document says so');

  // a `why` that survived the garble is kept with its own id
  const partial = '{"hits":[{"id":"repo:esc","why":"ESC I2C driver"},{"id":"page:#/setup/x],"open":[]}';
  const doc2 = handler.parseModelJson(partial);
  assert.deepEqual(doc2.hits, [
    { id: 'repo:esc', why: 'ESC I2C driver' },
    { id: 'page:#/setup/x', why: '' },
  ]);
  assert.deepEqual(doc2.open, []);

  // An EMPTY answer stays a provider failure: there is nothing to salvage, and
  // silence must not be read as a confident "nothing matches".
  assert.equal(handler.parseModelJson(''), null);
  assert.equal(handler.parseModelJson('   '), null);
  assert.equal(handler.parseModelJson(null), null);
  assert.equal(handler.parseModelJson('I cannot help with that.'), null);
  // An id running to the very end of the text is an answer still being written,
  // which is closeOpenBrackets' business, not a garble — it is NOT salvaged.
  assert.equal(handler.parseModelJson('{"hits":[{"id":"abc'), null);
});

test('a salvaged hop 1 answers the search instead of spending the fallback call', async () => {
  const fetchStub = providerStub([
    '{"hits":[{"id":"repo:esc],"open":["esc"]}',
    { hits: [ESC_REPO, AFRO_PAGE, AFRO_SYM] },
  ]);
  const r = await call('POST', { q: 'ESC I2C firmware', candidates: [] },
    { env: KEYS, fetch: fetchStub });
  assert.equal(r.code, 200);
  assert.equal(r.json.calls, 2, 'hop 1 salvaged on call 1; call 2 is the walk, not a retry');
  assert.equal(r.json.hops, 2);
  assert.equal(r.json.partial, false);
  assert.equal(r.json.salvaged, true, 'the 200 records that an answer was salvaged');
  assert.equal(r.json.provider, 'nemotron');
  // the salvaged `open: ["esc"]` really opened the repository
  assert.deepEqual(JSON.parse(userMessage(fetchStub.calls[1])).repos.map((x) => x.name), ['esc']);
  assert.deepEqual(r.json.results.map((x) => x.href).slice(0, 2),
    [ESC_URL, '#/setup/hippocampus-bringup/afro-esc']);
});

test('every response carries x-librarian-version: 2 — the zero-quota readiness probe', async () => {
  const r405 = await call('GET', undefined, { env: KEYS });
  assert.equal(r405.code, 405);
  assert.equal(r405.headers['x-librarian-version'], '2',
    'the pre-body 405 is what tells a deploy check which handler is live');
  const ok = await call('POST', ASK, { env: KEYS, fetch: providerStub([[ASK.candidates[0].id]]) });
  assert.equal(ok.code, 200);
  assert.equal(ok.headers['x-librarian-version'], '2');
  const r403 = await call('POST', ASK, { env: KEYS }, false,
    { headers: { origin: 'https://evil.example', host: 'docs.example.org' } });
  assert.equal(r403.headers['x-librarian-version'], '2');
});

test('every row the walk can emit satisfies the client href allowlist', () => {
  /* The client (js/search.js, plan §4) renders a returned row it does not
     already hold only when the row carries a string kind and title and an href
     matching `#/…` or `https://github.com/…`; anything else is a schema failure
     that throws the whole answer away. That contract is pinned HERE, on the
     producing side, across every id shape the resolver can emit — a page, a
     repository, a fork, a CAD part, a class and a file — because a row that
     fails it does not degrade, it discards the search. A candidate id is the
     one shape with no href: the client owns that row already. */
  const ctx = ctxFor(['page:#/mine']);
  const shapes = [
    AFRO_PAGE,
    ESC_REPO,
    'repo:tgy',
    'cad:motor/propdrive_2835/mount_2835.ipt',
    AFRO_SYM,
    'file:esc:include/afro_esc.h',
  ];
  const rows = handler.resolveHits(shapes.map((id) => ({ id, why: 'w' })), ctx);
  assert.equal(rows.length, shapes.length, 'every shape resolves on real data');
  for (const row of rows) {
    assert.equal(typeof row.id, 'string');
    assert.ok(row.id, 'a row always has a non-empty id');
    assert.equal(typeof row.kind, 'string');
    assert.equal(typeof row.title, 'string');
    assert.equal(typeof row.where, 'string');
    assert.equal(typeof row.snippet, 'string');
    assert.equal(typeof row.why, 'string');
    assert.ok(row.why.length <= 120, 'why is clipped');
    assert.ok(/^(#\/|https:\/\/github\.com\/)/.test(row.href),
      `${row.id}: href ${row.href} is not on the client allowlist`);
    assert.equal(row.id, `${row.kind}:${row.href}`, 'the id is the client <kind>:<href> scheme');
  }
  const mine = handler.resolveHits([{ id: 'page:#/mine', why: 'w' }], ctx);
  assert.equal(mine[0].href, undefined, 'a candidate row carries no href — the client owns it');
});
