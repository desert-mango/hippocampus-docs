/* Unit tests for the librarian routing inside js/search.js.

   Two things are under test here:

     1. the ROUTING contract — when a query is allowed to touch the network at
        all, what each failure mode does, and the session latch that keeps the
        GitHub Pages copy (where api/* does not exist) from re-asking forever;
     2. the LOCAL engine, which is a protected regression surface: the ten
        probes in data/search-probes.json must keep landing at rank 1, and the
        result order must be byte-identical whenever the librarian did not
        answer.

   This file must NEVER import api/librarian.js. The handler's own tests live in
   tools/tests/test_librarian_handler.mjs; everything here has to pass in a
   checkout where the api/ directory does not exist at all.

     node --test tools/tests/test_search_routing.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const SEARCH_JS = path.join(ROOT, 'js', 'search.js');
const HC = require(SEARCH_JS);

const {
  createLibrarian, projectCandidates, assignIds, mergePicks, classifyStatus,
  buildItems, searchItems,
  LIBRARIAN_URL, LIBRARIAN_NOTICE, LIBRARIAN_TIMEOUT_MS, CANDIDATE_LIMIT, PICK_LIMIT,
} = HC;

// ---------------------------------------------------------------- fixtures --

function hit(over) {
  return Object.assign(
    { score: 10, kind: 'page', title: 'Title', where: 'Setup', href: '#/a', snippet: 'snip' },
    over,
  );
}

// A mixed local result list: pages, a class, a function, a CAD part, a fork
// file — the librarian is deliberately NOT kind-filtered, so all of them must
// survive into the candidate payload.
function mixedLocal(n) {
  const kinds = ['page', 'class', 'fn', 'cad', 'file', 'fork'];
  const results = [];
  for (let i = 0; i < n; i += 1) {
    const kind = kinds[i % kinds.length];
    results.push(hit({
      score: 100 - i, kind, title: `hit ${i}`, where: `where ${i}`,
      href: kind === 'page' ? `#/p/${i}` : `https://github.com/o/r/blob/main/f${i}.py`,
      snippet: `snippet ${i}`,
    }));
  }
  return { total: 1000, results };
}

/* A fetch spy. `plan` is a list of either Response-ish objects or Errors to
   throw, consumed in order; the last entry repeats. */
function spyFetch(plan) {
  const calls = [];
  const queue = Array.isArray(plan) ? plan.slice() : [plan];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return next;
  };
  fn.calls = calls;
  return fn;
}

function resp(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body instanceof Error) throw body;
      return body;
    },
  };
}

function abortError() {
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  return e;
}

function bodyOf(call) {
  return JSON.parse(call.init.body);
}

// ------------------------------------------------------------- module shape -

test('js/search.js loads under plain node and exports its pure helpers', () => {
  assert.equal(typeof HC.query, 'function');
  assert.equal(typeof createLibrarian, 'function');
  assert.equal(typeof projectCandidates, 'function');
  assert.equal(typeof mergePicks, 'function');
  assert.equal(typeof classifyStatus, 'function');
  assert.equal(typeof globalThis.window, 'undefined', 'no window under node');
  assert.equal(typeof globalThis.document, 'undefined', 'no document under node');
});

test('the module fetches nothing at import time (loads with no global fetch)', () => {
  const savedFetch = globalThis.fetch;
  const savedDesc = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  delete globalThis.fetch;
  try {
    delete require.cache[require.resolve(SEARCH_JS)];
    const fresh = require(SEARCH_JS);
    assert.equal(typeof fresh.query, 'function');
  } finally {
    if (savedDesc) Object.defineProperty(globalThis, 'fetch', savedDesc);
    else globalThis.fetch = savedFetch;
    delete require.cache[require.resolve(SEARCH_JS)];
    require(SEARCH_JS);
  }
});

test('the client deadline sits above the function maxDuration of 15s', () => {
  assert.equal(LIBRARIAN_TIMEOUT_MS, 18000);
  assert.equal(LIBRARIAN_URL, 'api/librarian');
  assert.ok(!LIBRARIAN_URL.startsWith('/'), 'must be relative: Pages serves from a subpath');
});

// ------------------------------------------------------------ the fast path -

test('a single-word query does zero network', async () => {
  const fetchSpy = spyFetch(resp(200, { results: [] }));
  const lib = createLibrarian({ fetch: fetchSpy });
  const local = mixedLocal(5);
  const out = await lib.enrich('ekf', local);
  assert.equal(fetchSpy.calls.length, 0);
  assert.equal(out.librarianCount, 0);
  assert.equal(out.notice, null);
  assert.deepEqual(out.results, local.results);
});

test('leading/trailing space does not make a query multi-word', async () => {
  const fetchSpy = spyFetch(resp(200, { results: [] }));
  const lib = createLibrarian({ fetch: fetchSpy });
  for (const q of ['  ekf  ', '\tuart\n', '', '   ']) {
    const out = await lib.enrich(q, mixedLocal(3));
    assert.equal(out.notice, null);
    assert.equal(out.librarianCount, 0);
  }
  assert.equal(fetchSpy.calls.length, 0);
});

// ------------------------------------------------------------- the POST wire -

test('a multi-word query POSTs exactly once to the relative path', async () => {
  const fetchSpy = spyFetch(resp(200, { results: [] }));
  const lib = createLibrarian({ fetch: fetchSpy });
  const local = mixedLocal(40);
  await lib.enrich('thruster model', local);
  assert.equal(fetchSpy.calls.length, 1);
  const call = fetchSpy.calls[0];
  assert.equal(call.url, 'api/librarian');
  assert.ok(!String(call.url).startsWith('/'), 'never a leading slash');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['content-type'], 'application/json');
  assert.ok(call.init.signal, 'an AbortController signal is attached');

  const sent = bodyOf(call);
  assert.equal(sent.q, 'thruster model');
  assert.equal(sent.candidates.length, CANDIDATE_LIMIT);
  for (const c of sent.candidates) {
    assert.deepEqual(Object.keys(c).sort(), ['id', 'kind', 'snippet', 'title', 'where']);
    assert.equal(typeof c.id, 'string');
    assert.ok(c.id.length);
  }
  const kinds = new Set(sent.candidates.map((c) => c.kind));
  assert.ok(kinds.has('class') || kinds.has('fn'), 'code rows are not filtered out');
  assert.ok(kinds.has('cad'), 'CAD rows are not filtered out');
  const ids = sent.candidates.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'candidate ids are unique');
});

// ----------------------------------------------------- absent: 404/405/501 --

for (const status of [404, 405, 501]) {
  test(`HTTP ${status} means "no function here": local-only, no notice, latched`, async () => {
    const fetchSpy = spyFetch(resp(status, null));
    const lib = createLibrarian({ fetch: fetchSpy });
    const local = mixedLocal(6);

    const first = await lib.enrich('thruster model', local);
    assert.equal(fetchSpy.calls.length, 1);
    assert.equal(first.notice, null, 'the Pages copy must look completely normal');
    assert.equal(first.librarianCount, 0);
    assert.deepEqual(first.results, local.results);

    const second = await lib.enrich('install ros noetic', local);
    assert.equal(fetchSpy.calls.length, 1, 'the session latch stops all further POSTs');
    assert.equal(second.notice, null);
    assert.equal(second.librarianCount, 0);
  });
}

// ------------------------------------------------ present but failing modes --

const failures = {
  'HTTP 500': () => spyFetch(resp(500, null)),
  'a network throw': () => spyFetch(new TypeError('Failed to fetch')),
  'an abort/timeout': () => spyFetch(abortError()),
  'malformed JSON': () => spyFetch(resp(200, new SyntaxError('Unexpected token <'))),
  'schema-invalid JSON': () => spyFetch(resp(200, { results: 'not-an-array' })),
  'a row with no id': () => spyFetch(resp(200, { results: [{ why: 'no id here' }] })),
};

for (const [label, make] of Object.entries(failures)) {
  test(`${label} degrades to local results + the notice, and never latches`, async () => {
    const fetchSpy = make();
    const lib = createLibrarian({ fetch: fetchSpy });
    const local = mixedLocal(6);

    const first = await lib.enrich('thruster model', local);
    assert.equal(first.notice, LIBRARIAN_NOTICE);
    assert.equal(first.librarianCount, 0);
    assert.deepEqual(first.results, local.results, 'local ordering survives untouched');

    const second = await lib.enrich('install ros noetic', local);
    assert.equal(fetchSpy.calls.length, 2, 'a failure is not an absence: keep trying');
    assert.equal(second.notice, LIBRARIAN_NOTICE);
  });
}

test('the notice string is exactly the agreed wording', () => {
  assert.equal(LIBRARIAN_NOTICE, 'Answered by the local index — the librarian is unreachable.');
});

// ------------------------------------------------------------- the 200 path --

test('a good answer puts the picks first and keeps the local tail in order', async () => {
  const local = mixedLocal(12);
  const ids = assignIds(local.results);
  const fetchSpy = spyFetch(resp(200, {
    results: [
      { id: ids[7], why: 'closest match' },
      { id: ids[2], why: 'the setup page for it' },
      { id: 'nope:not-a-real-id', why: 'hallucinated' },
      { id: ids[7], why: 'duplicate' },
    ],
  }));
  const lib = createLibrarian({ fetch: fetchSpy });
  const out = await lib.enrich('thruster model', local);

  assert.equal(out.notice, null);
  assert.equal(out.librarianCount, 2, 'unknown ids dropped, duplicates deduped');
  assert.deepEqual(out.results.slice(0, 2), [local.results[7], local.results[2]]);
  const tail = out.results.slice(2);
  const expectedTail = local.results.filter((_, i) => i !== 7 && i !== 2);
  assert.deepEqual(tail, expectedTail, 'the rest keeps its original local order');
  assert.equal(out.results.length, local.results.length, 'nothing is lost or duplicated');
});

test('the librarian is capped at 8 picks', async () => {
  const local = mixedLocal(20);
  const ids = assignIds(local.results);
  const fetchSpy = spyFetch(resp(200, {
    results: ids.slice(0, 15).map((id) => ({ id, why: 'w' })),
  }));
  const lib = createLibrarian({ fetch: fetchSpy });
  const out = await lib.enrich('thruster model control', local);
  assert.equal(out.librarianCount, PICK_LIMIT);
  assert.equal(out.librarianCount, 8);
  assert.deepEqual(out.results.slice(0, 8), local.results.slice(0, 8));
  assert.equal(out.results.length, local.results.length);
});

test('an empty answer is still an answer: no notice, no picks, local order', async () => {
  const local = mixedLocal(6);
  const fetchSpy = spyFetch(resp(200, { results: [] }));
  const lib = createLibrarian({ fetch: fetchSpy });
  const out = await lib.enrich('thruster model', local);
  assert.equal(out.notice, null);
  assert.equal(out.librarianCount, 0);
  assert.deepEqual(out.results, local.results);
});

// -------------------------------------------------------- the exact-title pin -

test('an exact-title hit is pinned to index 0 when the librarian answered', async () => {
  const local = mixedLocal(10);
  local.results[6].title = 'Thruster Model';        // exact match, lowercased
  const ids = assignIds(local.results);
  const fetchSpy = spyFetch(resp(200, {
    results: [{ id: ids[3], why: 'a' }, { id: ids[1], why: 'b' }],
  }));
  const lib = createLibrarian({ fetch: fetchSpy });
  const out = await lib.enrich('  thruster model ', local);

  assert.equal(out.librarianCount, 3, 'the pin joins the picks, so the divider still follows them');
  assert.equal(out.results[0], local.results[6]);
  assert.deepEqual(out.results.slice(1, 3), [local.results[3], local.results[1]]);
  assert.equal(out.results.length, local.results.length);
});

test('a pinned hit already among the picks moves up without changing the count', async () => {
  const local = mixedLocal(10);
  local.results[4].title = 'Thruster Model';
  const ids = assignIds(local.results);
  const fetchSpy = spyFetch(resp(200, {
    results: [{ id: ids[3], why: 'a' }, { id: ids[4], why: 'b' }, { id: ids[1], why: 'c' }],
  }));
  const lib = createLibrarian({ fetch: fetchSpy });
  const out = await lib.enrich('thruster model', local);

  assert.equal(out.librarianCount, 3);
  assert.deepEqual(out.results.slice(0, 3), [local.results[4], local.results[3], local.results[1]]);
});

test('the pin is a NO-OP when the librarian did not answer', async () => {
  const local = mixedLocal(10);
  local.results[6].title = 'Thruster Model';
  const before = local.results.slice();

  // absent host
  const absent = createLibrarian({ fetch: spyFetch(resp(404, null)) });
  const a = await absent.enrich('thruster model', local);
  assert.equal(a.librarianCount, 0);
  assert.deepEqual(a.results, before, 'byte-identical local ordering');

  // present but failing host
  const broken = createLibrarian({ fetch: spyFetch(resp(500, null)) });
  const b = await broken.enrich('thruster model', local);
  assert.equal(b.librarianCount, 0);
  assert.deepEqual(b.results, before, 'byte-identical local ordering');

  // answered with nothing
  const empty = createLibrarian({ fetch: spyFetch(resp(200, { results: [] })) });
  const c = await empty.enrich('thruster model', local);
  assert.equal(c.librarianCount, 0);
  assert.deepEqual(c.results, before, 'byte-identical local ordering');
});

// ------------------------------------------------------------ pure helpers --

test('classifyStatus splits absent from failed from ok', () => {
  assert.equal(classifyStatus(404), 'absent');
  assert.equal(classifyStatus(405), 'absent');
  assert.equal(classifyStatus(501), 'absent');
  assert.equal(classifyStatus(200), 'ok');
  assert.equal(classifyStatus(204), 'ok');
  assert.equal(classifyStatus(400), 'failed');
  assert.equal(classifyStatus(429), 'failed');
  assert.equal(classifyStatus(500), 'failed');
  assert.equal(classifyStatus(502), 'failed');
  assert.equal(classifyStatus(undefined), 'failed');
});

test('assignIds is deterministic and collision-free', () => {
  const rows = [
    hit({ kind: 'page', href: '#/setup/x' }),
    hit({ kind: 'page', href: '#/setup/x' }),      // same route twice
    hit({ kind: 'fn', href: 'https://github.com/o/r/blob/main/a.py#L4' }),
  ];
  const ids = assignIds(rows);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual(ids, assignIds(rows), 'same input, same ids');
  assert.equal(ids[0], 'page:#/setup/x');
  assert.equal(ids[2], 'fn:https://github.com/o/r/blob/main/a.py#L4');
});

test('projectCandidates caps at 25 and strips scoring internals', () => {
  const local = mixedLocal(60);
  const cands = projectCandidates(local.results);
  assert.equal(cands.length, 25);
  assert.equal(cands[0].title, local.results[0].title);
  for (const c of cands) assert.equal(c.score, undefined);
});

test('mergePicks ignores non-string ids without throwing', () => {
  const local = mixedLocal(5);
  const ids = assignIds(local.results);
  const out = mergePicks(local.results, [null, 42, {}, ids[3]], 'two words');
  assert.equal(out.librarianCount, 1);
  assert.equal(out.results[0], local.results[3]);
});

// ----------------------------------------- the local engine (regression lock) -

function realItems() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'search', 'manifest.json'), 'utf8'));
  const shards = manifest.shards.map((s) =>
    JSON.parse(fs.readFileSync(path.join(ROOT, s.file), 'utf8')));
  return buildItems(shards);
}

/* A probe names the FILE it expects; the engine's winning row may be the symbol
   inside that file, whose deep link is the same URL plus a #L<line> anchor. The
   probe is satisfied either way, so the comparison drops the line anchor. */
const fileOf = (href) => String(href).replace(/#L\d+$/, '');

test('the ten search probes still land at rank 1 in the local engine', () => {
  const items = realItems();
  assert.ok(items.length > 1000, 'the real index loaded');
  const probes = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'data', 'search-probes.json'), 'utf8')).probes;
  assert.equal(probes.length, 10);
  const misses = [];
  for (const p of probes) {
    const { results } = searchItems(items, p.q);
    const rank = results.findIndex((r) => fileOf(r.href) === fileOf(p.expect)) + 1;
    if (rank !== 1) misses.push(`${p.q}: expected rank 1, got ${rank || 'not in results'}`);
  }
  assert.deepEqual(misses, [], 'the 10/10-at-rank-1 record is a protected surface');
});

test('searchItems still returns the shape the librarian layer wraps', () => {
  const items = realItems();
  const out = searchItems(items, 'thruster model');
  assert.equal(out.total, items.length);
  assert.ok(out.results.length > 0);
  assert.ok(out.results.length <= 40);
  for (const r of out.results.slice(0, 3)) {
    for (const k of ['score', 'kind', 'title', 'where', 'href', 'snippet']) {
      assert.ok(k in r, `result carries ${k}`);
    }
  }
});

// ------------------------------------------- the pin at the pick cap (F3) --

test('at the cap the pin displaces the last pick instead of making a 9th', async () => {
  const local = mixedLocal(20);
  local.results[15].title = 'Thruster Model';   // exact title, NOT among the picks
  const ids = assignIds(local.results);
  const fetchSpy = spyFetch(resp(200, {
    results: ids.slice(0, 8).map((id) => ({ id, why: 'w' })),   // a full 8 picks
  }));
  const lib = createLibrarian({ fetch: fetchSpy });
  const out = await lib.enrich('thruster model', local);

  assert.equal(out.librarianCount, PICK_LIMIT, 'never more than 8 rows above the divider');
  assert.equal(out.results[0], local.results[15], 'the pinned hit leads');
  assert.deepEqual(out.results.slice(1, 8), local.results.slice(0, 7),
    'the seven higher-ranked picks keep their slots');

  const tail = out.results.slice(8);
  assert.ok(tail.includes(local.results[7]), 'the displaced pick fell back, it did not vanish');
  const expectedTail = local.results.filter((_, i) => i > 6 && i !== 15);
  assert.deepEqual(tail, expectedTail, 'the tail is still in original local order');
  assert.equal(out.results.length, local.results.length, 'nothing lost, nothing duplicated');
});

test('below the cap the pin still adds a slot rather than displacing', async () => {
  const local = mixedLocal(20);
  local.results[15].title = 'Thruster Model';
  const ids = assignIds(local.results);
  const fetchSpy = spyFetch(resp(200, {
    results: ids.slice(0, 7).map((id) => ({ id, why: 'w' })),
  }));
  const lib = createLibrarian({ fetch: fetchSpy });
  const out = await lib.enrich('thruster model', local);
  assert.equal(out.librarianCount, 8);
  assert.equal(out.results[0], local.results[15]);
  assert.deepEqual(out.results.slice(1, 8), local.results.slice(0, 7));
});

// ------------------------------------ progressive rendering: onLocal (F2) --

/* A tiny fake index so query() can be driven end to end under node. The real
   shards are exercised by the probe test above; these four rows exist only to
   give the routing something to rank. */
const FAKE_SITE_SHARD = {
  kind: 'site',
  entries: [
    { t: 'Thruster Model', w: 'Setup', r: '#/setup/thruster-model', h: [], x: 'the thruster model page' },
    { t: 'Thruster Wiring', w: 'Setup', r: '#/setup/thruster-wiring', h: [], x: 'wiring a thruster, model numbers' },
    { t: 'Motor Model', w: 'Setup', r: '#/setup/motor-model', h: [], x: 'thruster adjacent model notes' },
    { t: 'Ekf', w: 'Setup', r: '#/setup/ekf', h: [], x: 'state estimation' },
  ],
};

function freshModule() {
  delete require.cache[require.resolve(SEARCH_JS)];
  const mod = require(SEARCH_JS);
  delete require.cache[require.resolve(SEARCH_JS)];   // leave the shared instance alone
  return mod;
}

/* Installs a global fetch that serves the fake index off memory and hands the
   librarian POST whatever `answer` is (a value, a promise, or an Error). */
function installFetch(answer) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url === 'search/manifest.json') {
      return { ok: true, status: 200, json: async () => ({ shards: [{ file: 'search/site.json' }] }) };
    }
    if (url === 'search/site.json') {
      return { ok: true, status: 200, json: async () => FAKE_SITE_SHARD };
    }
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return {
    calls,
    posts: () => calls.filter((c) => c.url === LIBRARIAN_URL),
    restore() {
      if (saved) Object.defineProperty(globalThis, 'fetch', saved);
      else delete globalThis.fetch;
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 15));

function localBaseline(q) {
  const mod = freshModule();
  return mod.searchItems(mod.buildItems([FAKE_SITE_SHARD]), q);
}

test('onLocal fires with the untouched local ranking before the POST resolves', async () => {
  let release;
  const pending = new Promise((r) => { release = r; });
  const net = installFetch(pending);
  try {
    const mod = freshModule();
    const baseline = localBaseline('thruster model');
    const ids = mod.assignIds(baseline.results);

    const seen = [];
    const p = mod.query('thruster model', { onLocal: (s) => seen.push(s) });
    await settle();

    assert.equal(seen.length, 1, 'onLocal fired while the POST was still in flight');
    assert.equal(seen[0].librarianCount, 0);
    assert.equal(seen[0].notice, null);
    assert.equal(seen[0].total, baseline.total);
    assert.deepEqual(seen[0].results, baseline.results, 'byte-identical local ordering, no pin');
    assert.equal(net.posts().length, 1, 'the POST really was outstanding');

    release({ ok: true, status: 200, json: async () => ({ results: [{ id: ids[1], why: 'w' }] }) });
    const final = await p;
    // "thruster model" is the exact title of a local hit, so the pin fires the
    // moment the librarian answers: one pick plus the pin ahead of it. That is
    // precisely the reordering the onLocal paint above must NOT have shown.
    assert.equal(final.librarianCount, 2);
    assert.equal(String(final.results[0].title).toLowerCase(), 'thruster model');
    assert.equal(final.results[1].href, baseline.results[1].href, 'the pick was promoted');
    assert.equal(seen.length, 1, 'onLocal is never called twice');
  } finally {
    net.restore();
  }
});

test('query() with no options behaves exactly as before (single resolve)', async () => {
  const net = installFetch({ ok: true, status: 200, json: async () => ({ results: [] }) });
  try {
    const mod = freshModule();
    const out = await mod.query('thruster model');
    assert.deepEqual(Object.keys(out).sort(), ['librarianCount', 'notice', 'results', 'total']);
    assert.equal(out.librarianCount, 0);
    assert.equal(out.notice, null);
    assert.equal(net.posts().length, 1);
  } finally {
    net.restore();
  }
});

test('a single-word query fires onLocal, resolves the same shape, and posts nothing', async () => {
  const net = installFetch({ ok: true, status: 200, json: async () => ({ results: [] }) });
  try {
    const mod = freshModule();
    const seen = [];
    const out = await mod.query('ekf', { onLocal: (s) => seen.push(s) });
    assert.equal(seen.length, 1);
    assert.equal(net.posts().length, 0, 'zero network for a single word, still');
    assert.deepEqual(Object.keys(out).sort(), Object.keys(seen[0]).sort());
    assert.equal(out.results, seen[0].results, 'the same rows, not a rebuilt list');
    assert.equal(out.librarianCount, 0);
    assert.equal(out.notice, null);
  } finally {
    net.restore();
  }
});

test('onLocal still fires when the query matches nothing', async () => {
  const net = installFetch({ ok: true, status: 200, json: async () => ({ results: [] }) });
  try {
    const mod = freshModule();
    const seen = [];
    const out = await mod.query('zzz nothing matches this', { onLocal: (s) => seen.push(s) });
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].results, []);
    assert.deepEqual(out.results, []);
    assert.equal(net.posts().length, 0, 'nothing to re-rank, nothing to ask about');
  } finally {
    net.restore();
  }
});

test('a throwing onLocal cannot break the search', async () => {
  const net = installFetch({ ok: true, status: 200, json: async () => ({ results: [] }) });
  try {
    const mod = freshModule();
    const out = await mod.query('thruster model', { onLocal: () => { throw new Error('paint blew up'); } });
    assert.ok(Array.isArray(out.results));
  } finally {
    net.restore();
  }
});

test('the failure notice reaches the final resolve, not the onLocal paint', async () => {
  const net = installFetch({ ok: false, status: 500, json: async () => ({}) });
  try {
    const mod = freshModule();
    const seen = [];
    const out = await mod.query('thruster model', { onLocal: (s) => seen.push(s) });
    assert.equal(seen[0].notice, null, 'the first paint never shows an error');
    assert.equal(out.notice, LIBRARIAN_NOTICE);
    assert.deepEqual(out.results, seen[0].results, 'and the rows are unchanged');
  } finally {
    net.restore();
  }
});
