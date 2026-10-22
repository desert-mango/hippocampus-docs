// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 5 September 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test librarian routing and preserve the local search ranking contract.
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
  buildItems, searchItems, pickRows, strongLead,
  LIBRARIAN_URL, LIBRARIAN_NOTICE, LIBRARIAN_QUOTA_NOTICE, LIBRARIAN_TIMEOUT_MS,
  CANDIDATE_LIMIT, PICK_LIMIT,
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

/* A picked local row renders as a shallow COPY carrying the librarian's `why`
   line — the local list's own objects are never mutated, which is what lets
   onLocal's paint and the final paint share the same array safely. */
const withWhy = (row, why) => Object.assign({}, row, { why });

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

test('S2: the notice string is exactly the agreed, calmer wording', () => {
  assert.equal(LIBRARIAN_NOTICE, 'Keyword results shown; the librarian did not answer this time.');
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
  assert.deepEqual(out.results.slice(0, 2),
    [withWhy(local.results[7], 'closest match'), withWhy(local.results[2], 'the setup page for it')]);
  assert.equal(local.results[7].why, undefined, 'the local row itself was not touched');
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
  assert.deepEqual(out.results.slice(0, 8), local.results.slice(0, 8).map((r) => withWhy(r, 'w')));
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
  assert.equal(out.results[0], local.results[6], 'the pin brought no why of its own');
  assert.deepEqual(out.results.slice(1, 3),
    [withWhy(local.results[3], 'a'), withWhy(local.results[1], 'b')]);
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
  assert.deepEqual(out.results.slice(0, 3),
    [withWhy(local.results[4], 'b'), withWhy(local.results[3], 'a'), withWhy(local.results[1], 'c')]);
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

function readProbes() {
  return JSON.parse(
    fs.readFileSync(path.join(ROOT, 'data', 'search-probes.json'), 'utf8')).probes;
}

test('the ten search probes still land at rank 1 in the local engine', () => {
  const items = realItems();
  assert.ok(items.length > 1000, 'the real index loaded');
  /* The probe file carries two KINDS of probe now. This test owns the keyword
     half and nothing else: the semantic probes are excluded by construction,
     because the reason they exist is that the local engine finds nothing for
     them (the test below pins exactly that). Filtering here is not a relaxation
     — the count assertion still demands all ten keyword probes. */
  const probes = readProbes().filter((p) => p.kind !== 'semantic');
  assert.equal(probes.length, 10);
  const misses = [];
  for (const p of probes) {
    const { results } = searchItems(items, p.q);
    const rank = results.findIndex((r) => fileOf(r.href) === fileOf(p.expect)) + 1;
    if (rank !== 1) misses.push(`${p.q}: expected rank 1, got ${rank || 'not in results'}`);
  }
  assert.deepEqual(misses, [], 'the 10/10-at-rank-1 record is a protected surface');
});

/* The semantic probes are the client-side half of the done bar: strings a
   browser must show for a query the keyword engine cannot answer at all. This
   test spends zero quota and imports nothing from api/ — it only asks whether
   the strings are (a) real and (b) genuinely unreachable locally. The server's
   own suite proves the same strings RESOLVE through the function. */
test('S1: no local row matches EVERY word of a semantic probe, and the probes name real targets', () => {
  const items = realItems();
  const semantic = readProbes().filter((p) => p.kind === 'semantic');
  assert.equal(semantic.length, 2, 'both of Kyle 2026-09-04 probes are on disk');

  const site = JSON.parse(fs.readFileSync(path.join(ROOT, 'search', 'site.json'), 'utf8'));
  const routes = new Set(site.entries.map((e) => String(e.r)));
  const cadShard = JSON.parse(fs.readFileSync(path.join(ROOT, 'search', 'cad.json'), 'utf8'));
  const localHrefs = new Set(buildItems([cadShard]).map((it) => it.href));
  const wiki = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'graph', 'wiki.json'), 'utf8'));
  const repoUrls = new Set(wiki.nodes
    .filter((n) => String(n.id || '').startsWith('repo:') && n.url)
    .map((n) => String(n.url)));

  const known = (href) => {
    if (href.startsWith('#/')) return routes.has(href.split('@')[0]);
    return localHrefs.has(href) || repoUrls.has(href);
  };

  for (const probe of semantic) {
    assert.equal(typeof probe.q, 'string');
    assert.ok(Number.isInteger(probe.top) && probe.top > 0, `${probe.q}: top is a positive int`);
    assert.ok(Array.isArray(probe.expect) && probe.expect.length, `${probe.q}: expect is non-empty`);
    assert.ok(Array.isArray(probe.fair || []), `${probe.q}: fair is a list`);

    // S1 (2026-10-21): the engine now also lists PARTIAL matches, ranked below
    // every all-words match. A semantic probe is still one no row answers in
    // full — and that is what the librarian is told (its candidates are the
    // all-words rows only), so the graph walk still runs for it.
    const { results } = searchItems(items, probe.q);
    assert.deepEqual(results.filter((r) => r.full), [],
      `${probe.q}: a semantic probe is one no keyword row matches in full`);
    assert.ok(results.every((r) => r.full === false), `${probe.q}: every local row is marked partial`);

    for (const href of [].concat(probe.expect, probe.fair || [])) {
      assert.ok(/^#\//.test(href) || /^https:\/\/github\.com\//.test(href),
        `${probe.q}: ${href} is a route or a github.com URL`);
      assert.ok(known(href), `${probe.q}: ${href} must exist in the real site data`);
    }
  }
});

test('searchItems still returns the shape the librarian layer wraps (S3: 40 rows plus up to 20 pages)', () => {
  const items = realItems();
  const out = searchItems(items, 'thruster model');
  assert.equal(out.total, items.length);
  assert.ok(out.results.length > 0);
  assert.ok(out.results.length <= 60);
  assert.ok(out.results.slice(40).every((r) => r.kind === 'page'), 'only pages ride past the 40th row');
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
  assert.deepEqual(out.results.slice(1, 8), local.results.slice(0, 7).map((r) => withWhy(r, 'w')),
    'the seven higher-ranked picks keep their slots');

  const tail = out.results.slice(8);
  assert.ok(tail.includes(local.results[7]),
    'the displaced pick fell back as its own local row, it did not vanish');
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
  assert.deepEqual(out.results.slice(1, 8), local.results.slice(0, 7).map((r) => withWhy(r, 'w')));
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
  /* A zero-hit multi-word query is no longer the end of the search — it is
     exactly the case the librarian exists for. The first paint is still the
     empty local answer; the POST goes out with an empty candidate list; the
     final answer is made of rows the local index never had. */
  const net = installFetch({ ok: true, status: 200, json: async () => ({ results: [
    { id: 'page:#/setup/graph-only', kind: 'page', title: 'Graph Only', where: 'Setup',
      href: '#/setup/graph-only', snippet: 'reached by walking the graph', why: 'semantic hit' },
  ] }) });
  try {
    const mod = freshModule();
    const seen = [];
    const out = await mod.query('zzz nothing matches this', { onLocal: (s) => seen.push(s) });
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].results, [], 'the first paint is the empty local answer');
    assert.equal(net.posts().length, 1, 'one POST, even with nothing to re-rank');
    const sent = JSON.parse(net.posts()[0].init.body);
    assert.equal(sent.q, 'zzz nothing matches this');
    assert.deepEqual(sent.candidates, [], 'the body carries candidates: [] rather than skipping the ask');
    assert.equal(out.results.length, 1, 'the answer is the server rows');
    assert.equal(out.results[0].href, '#/setup/graph-only');
    assert.equal(out.results[0].why, 'semantic hit');
    assert.equal(out.librarianCount, 1);
    assert.equal(out.notice, null);
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

// =====================================================================
//  the graph walk: server-built rows, the schema gate, the quota notice
// =====================================================================

test('server row leads local tail', async () => {
  /* The librarian may now answer with rows the local index never had. One of
     them, listed first, renders ahead of everything local — and the candidate
     it kept still carries its own local row, not a rebuilt copy. */
  const local = mixedLocal(6);
  const ids = assignIds(local.results);
  const fetchSpy = spyFetch(resp(200, {
    results: [
      { id: 'page:#/setup/graph-only', kind: 'page', title: 'Graph Only', where: 'Setup',
        href: '#/setup/graph-only', snippet: 'reached by walking the graph', why: 'the walk found it' },
      { id: ids[4], why: 'a keyword hit worth keeping' },
    ],
  }));
  const lib = createLibrarian({ fetch: fetchSpy });
  const out = await lib.enrich('esc firmware', local);

  assert.equal(out.notice, null);
  assert.equal(out.librarianCount, 2, 'a server row counts as a pick, like a local one');
  assert.equal(out.results[0].href, '#/setup/graph-only');
  assert.equal(out.results[0].title, 'Graph Only');
  assert.equal(out.results[0].kind, 'page');
  assert.equal(out.results[0].score, 0, 'a server row carries no local score');
  assert.equal(out.results[0].why, 'the walk found it');
  assert.equal(out.results[1].href, local.results[4].href, 'the kept candidate is the local row');
  assert.equal(out.results[1].why, 'a keyword hit worth keeping');
  assert.equal(local.results[4].why, undefined, 'the local list itself is never mutated');

  const tail = out.results.slice(2);
  assert.deepEqual(tail, local.results.filter((_, i) => i !== 4), 'the tail keeps local order');
  assert.equal(out.results.length, local.results.length + 1);
});

test('a javascript: or http://evil href fails the whole answer, local order untouched', async () => {
  for (const href of ['javascript:alert(1)', 'http://evil.example/steal']) {
    const local = mixedLocal(5);
    const before = local.results.slice();
    const fetchSpy = spyFetch(resp(200, {
      results: [{ id: 'page:#/x', kind: 'page', title: 'Bad', where: '', href, snippet: '', why: 'w' }],
    }));
    const lib = createLibrarian({ fetch: fetchSpy });
    const out = await lib.enrich('two words', local);
    assert.equal(out.notice, LIBRARIAN_NOTICE, `${href} is a schema failure, not a row to skip`);
    assert.equal(out.librarianCount, 0);
    assert.deepEqual(out.results, before, 'local ordering survives untouched');
  }
});

test('an exhausted 502 shows the quota notice, not the unreachable one', async () => {
  const local = mixedLocal(5);
  const spent = createLibrarian({
    fetch: spyFetch(resp(502, {
      error: 'no provider answered',
      providers: [{ provider: 'flint', hop: 1, reason: 'HTTP 429: rate limited' }],
      exhausted: true,
    })),
  });
  const out = await spent.enrich('thruster model', local);
  assert.equal(out.notice, LIBRARIAN_QUOTA_NOTICE);
  assert.equal(LIBRARIAN_QUOTA_NOTICE,
    'The librarian is out of free requests for today — answered by the local index.');
  assert.equal(out.librarianCount, 0);
  assert.deepEqual(out.results, local.results);

  const broken = createLibrarian({ fetch: spyFetch(resp(502, { error: 'x', exhausted: false })) });
  assert.equal((await broken.enrich('thruster model', local)).notice, LIBRARIAN_NOTICE,
    'only an exhausted quota gets the quota wording');
});

test('a multi-word query with zero local hits asks anyway; HTTP 405 latches it off', async () => {
  const net = installFetch({ ok: false, status: 405, json: async () => null });
  try {
    const mod = freshModule();
    const out = await mod.query('zzz nothing matches this');
    assert.deepEqual(out.results, []);
    assert.equal(out.notice, null, 'the Pages copy shows no error for a query it cannot answer');
    assert.equal(out.librarianCount, 0);
    assert.equal(net.posts().length, 1);
    assert.equal(mod.librarianLatched(), true, 'no function on this host: latched for the session');

    await mod.query('another missing query');
    assert.equal(net.posts().length, 1, 'the latch stops every further POST');
  } finally {
    net.restore();
  }
});

// -------------------------------------------------- the per-session cache --

test('cache: same query twice -> one POST', async () => {
  const local = mixedLocal(8);
  const ids = assignIds(local.results);
  const fetchSpy = spyFetch(resp(200, { results: [{ id: ids[5], why: 'w' }] }));
  const lib = createLibrarian({ fetch: fetchSpy });

  const first = await lib.enrich('thruster model', local);
  const second = await lib.enrich('  Thruster Model  ', local);
  assert.equal(fetchSpy.calls.length, 1, 'the key is the trimmed, lower-cased query');
  assert.equal(second.librarianCount, first.librarianCount);
  assert.deepEqual(second.results, first.results, 'the cached answer re-merges identically');
});

test('cache: failure not cached', async () => {
  const fetchSpy = spyFetch(resp(500, null));
  const lib = createLibrarian({ fetch: fetchSpy });
  const local = mixedLocal(4);
  const first = await lib.enrich('thruster model', local);
  const second = await lib.enrich('thruster model', local);
  assert.equal(fetchSpy.calls.length, 2, 'a blip is retried next time, never remembered');
  assert.equal(first.notice, LIBRARIAN_NOTICE);
  assert.equal(second.notice, LIBRARIAN_NOTICE);
});

test('the answer cache is capped at 50 and evicts the oldest query first', async () => {
  const local = mixedLocal(3);
  const ids = assignIds(local.results);
  const fetchSpy = spyFetch(resp(200, { results: [{ id: ids[0], why: 'w' }] }));
  const lib = createLibrarian({ fetch: fetchSpy });
  for (let i = 0; i < 51; i += 1) await lib.enrich(`query number ${i}`, local);
  assert.equal(fetchSpy.calls.length, 51);
  await lib.enrich('query number 50', local);
  assert.equal(fetchSpy.calls.length, 51, 'the newest query is still remembered');
  await lib.enrich('query number 0', local);
  assert.equal(fetchSpy.calls.length, 52, 'the oldest fell out at the cap');
});

// ------------------------------------------------------ the row schema gate -

test('pickRows keeps id-only rows and fills the optional fields', () => {
  const rows = pickRows({
    results: [
      { id: 'page:#/a', why: 'because' },
      { id: 'repo:https://github.com/o/r', kind: 'repo', title: 'r', href: 'https://github.com/o/r' },
    ],
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { id: 'page:#/a', why: 'because' });
  assert.deepEqual(rows[1], {
    id: 'repo:https://github.com/o/r', why: '', href: 'https://github.com/o/r',
    kind: 'repo', title: 'r', where: '', snippet: '',
  });
  assert.deepEqual(HC.pickIds({ results: [{ id: 'a' }, { id: 'b' }] }), ['a', 'b'],
    'pickIds is the same read, ids only');
});

test('pickRows rejects a renderable row missing kind, title or a safe href', () => {
  const base = { id: 'x', kind: 'page', title: 'T', href: '#/a' };
  assert.equal(pickRows({ results: [base] }).length, 1);
  const bad = [
    { href: 'javascript:alert(1)' }, { href: 'http://evil.example' }, { href: '/absolute' },
    { href: 'https://github.com.evil.example/x' }, { href: '' }, { href: null },
    { kind: undefined }, { kind: '' }, { title: '' }, { title: 42 },
  ];
  for (const over of bad) {
    assert.equal(pickRows({ results: [Object.assign({}, base, over)] }), null, JSON.stringify(over));
  }
  assert.equal(pickRows({ results: [{ why: 'no id' }] }), null);
  assert.equal(pickRows({ results: 'nope' }), null);
  assert.equal(pickRows(null), null);
  assert.equal(pickRows([]), null);
});

test('a picked id matches a local page hit that carries an @heading anchor', async () => {
  const local = {
    total: 10,
    results: [
      hit({ title: 'Other', href: '#/setup/other' }),
      hit({ title: 'PX4 Setup', href: '#/setup/getting-started/px4-setup@mavlink-router-qgroundcontrol' }),
    ],
  };
  const fetchSpy = spyFetch(resp(200, {
    results: [{ id: 'page:#/setup/getting-started/px4-setup', why: 'the page itself' }],
  }));
  const lib = createLibrarian({ fetch: fetchSpy });
  const out = await lib.enrich('mavlink qgroundcontrol', local);
  assert.equal(out.librarianCount, 1, 'the anchor did not hide the local row');
  assert.equal(out.results[0].href, local.results[1].href, 'the LOCAL row wins, anchor and all');
  assert.equal(out.results[0].why, 'the page itself');
  assert.equal(out.results.length, 2, 'no duplicate row was invented');
});

test('the module exports pickRows, strongLead, librarianLatched and the quota notice', () => {
  assert.equal(typeof pickRows, 'function');
  assert.equal(typeof strongLead, 'function');
  assert.equal(typeof HC.librarianLatched, 'function');
  assert.equal(HC.librarianLatched(), false, 'a fresh session is not latched');
  assert.equal(typeof LIBRARIAN_QUOTA_NOTICE, 'string');
});

// =====================================================================
//  the STRONG-LEAD PIN, measured on the real index
// =====================================================================

const PROBE_EXPECT = new Map(readProbes()
  .filter((p) => p.kind !== 'semantic')
  .map((p) => [p.q, p.expect]));

test('the strong-lead pin renders the probe leader first for the three multi-word probes', async () => {
  /* The three multi-word probes' rendered rank 1 is DETERMINISTIC, not a model
     outcome: each has a local leader whose title token-covers the query, so a
     librarian answer that promotes other rows and never mentions the leader
     still renders the leader first. ("pressure sensor" has only two local hits,
     so "two other rows" is one row there — slice(1, 3) takes what exists.) */
  const items = realItems();
  for (const q of ['thruster model', 'pressure sensor', 'install ros']) {
    const local = searchItems(items, q);
    assert.ok(strongLead(local.results, q), `${q}: the local leader token-covers the query`);
    const others = assignIds(local.results).slice(1, 3)
      .map((id) => ({ id, why: 'the librarian preferred this' }));
    assert.ok(others.length, `${q}: there is another row to promote`);

    const lib = createLibrarian({ fetch: spyFetch(resp(200, { results: others })) });
    const out = await lib.enrich(q, local);
    assert.equal(fileOf(out.results[0].href), fileOf(PROBE_EXPECT.get(q)),
      `${q}: the probe's link renders at rank 1`);
    assert.equal(out.librarianCount, others.length + 1, 'the pin joins the picks');
  }
});

test('the pin does not fire for "path planning" or "acoustic modem": both stay re-rankable', async () => {
  const items = realItems();
  for (const q of ['path planning', 'acoustic modem']) {
    const local = searchItems(items, q);
    assert.equal(strongLead(local.results, q), false, `${q}: the leader does not token-cover it`);
    const picked = assignIds(local.results)[1];
    const lib = createLibrarian({ fetch: spyFetch(resp(200, { results: [{ id: picked, why: 'w' }] })) });
    const out = await lib.enrich(q, local);
    assert.equal(out.results[0].href, local.results[1].href,
      `${q}: the librarian really does take position 1`);
    assert.equal(out.librarianCount, 1);
  }
});

test('pin: the recorded trade — "mavlink router" pins add_mavlink_routerd', async () => {
  /* THE RECORDED TRADE, written down as a test so it cannot be forgotten. The
     strong-lead pin is deliberately wide: "router" is a token PREFIX of
     "routerd", so the launch helper add_mavlink_routerd token-covers the query
     and takes rank 1 over the PX4 Setup page at local rank 2 — even when the
     librarian says the page is the better answer. This is the ACCEPTED COST of
     a deterministic rank 1 for the keyword probes, not a desired outcome; drop
     the pin and those three probes' rank 1 becomes a model outcome instead. */
  const items = realItems();
  const local = searchItems(items, 'mavlink router');
  assert.equal(local.results[0].title, 'add_mavlink_routerd', 'measured leader on the real index');
  assert.equal(local.results[1].title, 'PX4 Setup', 'the better answer sits at local rank 2');

  const ids = assignIds(local.results);
  const lib = createLibrarian({ fetch: spyFetch(resp(200, {
    results: [{ id: ids[1], why: 'the setup page actually explains mavlink-router' }],
  })) });
  const out = await lib.enrich('mavlink router', local);
  assert.equal(out.results[0].title, 'add_mavlink_routerd', 'the pin wins — the recorded trade');
  assert.equal(out.results[1].title, 'PX4 Setup');
  assert.equal(out.librarianCount, 2);
});

test('no-candidate-kept: the pin still leads when only graph rows come back', async () => {
  /* The live shape of "pressure sensor": a short local list makes the server
     walk the graph, and hop 2 can answer entirely in ids the local index never
     had. Every pick counts, so the pin still fires and the divider still falls
     after the picks. */
  const items = realItems();
  const serverRows = [
    { id: 'repo:https://github.com/HippoCampusRobotics/esc', kind: 'repo', title: 'esc',
      where: 'HippoCampusRobotics · core stack', href: 'https://github.com/HippoCampusRobotics/esc',
      snippet: 'ESC firmware', why: 'walked from the graph' },
    { id: 'page:#/setup/hippocampus-bringup/afro-esc', kind: 'page', title: 'Afro ESC',
      where: 'Setup · Bringup', href: '#/setup/hippocampus-bringup/afro-esc',
      snippet: 'flashing the ESCs', why: 'a graph neighbour' },
  ];
  for (const q of ['pressure sensor', 'install ros']) {
    const local = searchItems(items, q);
    const ids = new Set(assignIds(local.results));
    for (const row of serverRows) assert.ok(!ids.has(row.id), `${q}: ${row.id} is not a local id`);

    const lib = createLibrarian({ fetch: spyFetch(resp(200, { results: serverRows })) });
    const out = await lib.enrich(q, local);
    assert.equal(fileOf(out.results[0].href), fileOf(PROBE_EXPECT.get(q)),
      `${q}: the probe's link still renders at rank 1`);
    assert.equal(out.librarianCount, serverRows.length + 1,
      `${q}: every pick counts — server rows plus the pin`);
    assert.equal(out.results.length, local.results.length + serverRows.length);
  }
});

test('pin: exact title beats strong lead', async () => {
  const local = mixedLocal(6);
  local.results[0].title = 'Thruster Models';   // token-prefix cover: a strong leader
  local.results[4].title = 'Thruster Model';    // the exact title
  assert.equal(strongLead(local.results, 'thruster model'), true, 'the leader would qualify');
  const ids = assignIds(local.results);
  const lib = createLibrarian({ fetch: spyFetch(resp(200, { results: [{ id: ids[2], why: 'w' }] })) });
  const out = await lib.enrich('thruster model', local);
  assert.equal(out.results[0], local.results[4], 'the exact title still wins the top slot');
  assert.equal(out.librarianCount, 2);
});

test('pin: no answer no pin', async () => {
  const local = mixedLocal(6);
  local.results[0].title = 'Thruster Model';   // both pins would fire on an answer
  const before = local.results.slice();
  const stubs = {
    'a failing host': resp(500, null),
    'an absent host': resp(404, null),
    'an empty answer': resp(200, { results: [] }),
  };
  for (const [label, stub] of Object.entries(stubs)) {
    const lib = createLibrarian({ fetch: spyFetch(stub) });
    const out = await lib.enrich('thruster model', local);
    assert.equal(out.librarianCount, 0, label);
    assert.deepEqual(out.results, before, `${label}: byte-identical local ordering`);
  }
});

// =====================================================================
//  js/app.js, read as source (it is a browser file: no DOM under node)
// =====================================================================

const APP_JS = path.join(ROOT, 'js', 'app.js');

test('js/app.js escapes the librarian why line like every other field', () => {
  /* `why` is MODEL-authored text about a user-controlled, URL-shareable query,
     so it is the least trusted string on the page. Same shape of check as the
     handler suite's "no Vercel helper" test: read the source, not the DOM. */
  const src = fs.readFileSync(APP_JS, 'utf8');
  assert.ok(src.includes('esc(r.why)'), 'the why line goes through esc()');
  assert.ok(!/\$\{\s*r\.why\s*\}/.test(src), 'and is never interpolated raw');
});

test('js/app.js paints the waiting line (S5 wording) and always yields to the final paint', () => {
  const src = fs.readFileSync(APP_JS, 'utf8');
  assert.ok(src.includes("repo: 'repository'"), 'a repository row needs a label of its own');
  assert.ok(src.includes('The librarian is still looking…'), 'the waiting line');
  assert.ok(src.includes('HCSearch.librarianLatched()'),
    'never shown on a host where the librarian is latched off');
  assert.ok(/painted\.waiting/.test(src),
    'the repaint-skip guard is bypassed after a waiting paint, on every host');
});

// =====================================================================
//  S1 (uiux grill 2026-10): stopwords out, partial matches in, ranked below
// =====================================================================

const { queryTerms } = HC;

/* A tiny site shard: enough rows to pin the ranking rule by construction. */
function siteShard(entries) {
  return { kind: 'site', entries: entries.map((e) => Object.assign(
    { t: 'T', r: '#/x', w: 'Setup', h: [], x: '' }, e)) };
}

test('S1: queryTerms drops stopwords, keeps order, caps at 8, falls back when nothing is left', () => {
  assert.deepEqual(queryTerms('how do I flash PX4'), ['flash', 'px4']);
  assert.deepEqual(queryTerms('What is the UART configuration?'), ['uart', 'configuration']);
  assert.deepEqual(queryTerms('how to'), ['how', 'to'], 'a stopword-only query keeps all its words');
  assert.deepEqual(queryTerms('a b c d e f g h i j k'), ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'j']);
  assert.deepEqual(queryTerms(''), []);
  assert.deepEqual(queryTerms(null), []);
});

test('S1: "how do I flash PX4" returns at least one page whose title or route contains px4', () => {
  const items = realItems();
  const { results } = searchItems(items, 'how do I flash PX4');
  assert.ok(results.length >= 1, 'the placeholder example returns rows');
  const pages = results.filter((r) => r.kind === 'page'
    && (/px4/i.test(r.title) || /px4/i.test(r.href)));
  assert.ok(pages.length >= 1, 'a PX4 page is among them');
});

test('S1: the "flash PX4" chip returns rows', () => {
  const { results } = searchItems(realItems(), 'flash PX4');
  assert.ok(results.length >= 1);
});

test('S1: "PX4" alone still puts the PX4 Setup page first among pages', () => {
  const { results } = searchItems(realItems(), 'PX4');
  const firstPage = results.find((r) => r.kind === 'page');
  assert.equal(firstPage && firstPage.title, 'PX4 Setup');
});

test('S1: every item matching ALL terms ranks above any item matching fewer', () => {
  const items = buildItems([siteShard([
    { t: 'Flash the ESC', r: '#/a', x: 'flash it' },               // 1 of 2, strong title hit
    { t: 'Flash Flash Flash', r: '#/b', x: 'flash flash' },         // 1 of 2, many hits
    { t: 'Notes', r: '#/c', x: 'flash the px4 board' },            // 2 of 2, weak body hits
    { t: 'PX4', r: '#/d', x: 'autopilot' },                         // 1 of 2, exact title
  ])]);
  const { results } = searchItems(items, 'flash px4');
  assert.equal(results[0].href, '#/c', 'the only all-terms row leads, however weak');
  assert.equal(results[0].full, true);
  assert.deepEqual(results.slice(1).map((r) => r.full), [false, false, false]);
  assert.equal(results.length, 4, 'every partial row is listed');
  for (let i = 1; i < results.length; i += 1) {
    assert.ok(results[0].score > results[i].score, 'the rank key puts matched terms first');
  }
});

test('S1: a partial match needs a hit on a term of 3+ characters', () => {
  const items = buildItems([siteShard([
    { t: 'Op notes', r: '#/a', x: 'op' },        // matches only "op" (2 chars)
    { t: 'Docking', r: '#/b', x: 'docking' },     // matches only "docking"
  ])]);
  const { results } = searchItems(items, 'op docking');
  assert.deepEqual(results.map((r) => r.href), ['#/b'], 'a two-letter hit alone is noise');
});

test('S1: a stopword-only query still searches', () => {
  const items = buildItems([siteShard([{ t: 'How to', r: '#/howto', x: 'how to read this' }])]);
  const { results } = searchItems(items, 'how to');
  assert.deepEqual(results.map((r) => r.href), ['#/howto']);
});

test('S1: stopwords no longer block a match: "how do I install ros" finds the ROS installation page', () => {
  const { results } = searchItems(realItems(), 'how do I install ros');
  assert.equal(fileOf(results[0].href), fileOf(PROBE_EXPECT.get('install ros')));
});

test('S1: the librarian is shown only the all-terms rows as candidates', async () => {
  const items = buildItems([siteShard([
    { t: 'Notes', r: '#/c', x: 'flash the px4 board' },
    { t: 'Flash the ESC', r: '#/a', x: 'flash it' },
  ])]);
  const local = searchItems(items, 'flash px4');
  assert.equal(local.results.length, 2);
  const fetchSpy = spyFetch(resp(200, { results: [] }));
  await createLibrarian({ fetch: fetchSpy }).enrich('flash px4', local);
  assert.deepEqual(bodyOf(fetchSpy.calls[0]).candidates.map((c) => c.id), ['page:#/c']);

  const real = realItems();
  for (const q of ['ESC I2C firmware', 'motor mount CAD']) {
    const spy = spyFetch(resp(200, { results: [] }));
    await createLibrarian({ fetch: spy }).enrich(q, searchItems(real, q));
    assert.deepEqual(bodyOf(spy.calls[0]).candidates, [],
      `${q}: still an empty candidate list, so the server still walks the graph`);
  }
});

// =====================================================================
//  S3–S6 (uiux grill 2026-10): the results page's pure helpers
// =====================================================================

const { plainSnippet, groupResults, searchTab, searchTabHref, noResultsModel,
  highlightParts, lastAnswer } = HC;

test('S4: plainSnippet strips Markdown and HTML and never leaves **', () => {
  assert.equal(plainSnippet('This is **not** a *drill* and `code` too'),
    'This is not a drill and code too');
  assert.equal(plainSnippet('## Heading\nSee [the guide](#/setup/x) and ![alt](a.png) here'),
    'Heading See the guide and here');
  assert.equal(plainSnippet('<div class="adm adm-note">Note: <b>bold</b></div>  spaced\n\nout'),
    'Note: bold spaced out');
  assert.equal(plainSnippet('include/hippo/vec3.h:L74'), 'include/hippo/vec3.h:L74', 'a path is untouched');
  assert.equal(plainSnippet('snake_case_name stays'), 'snake_case_name stays');
  assert.equal(plainSnippet(null), '');
  assert.equal(plainSnippet(42), '42');
});

test('S4: plainSnippet cuts at 200 characters on a word boundary with …', () => {
  const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
  const out = plainSnippet(long);
  assert.ok(out.length <= 201, `at most 200 chars plus the ellipsis, got ${out.length}`);
  assert.ok(out.endsWith('…'));
  assert.ok(long.startsWith(out.slice(0, -1)), 'a prefix of the text');
  assert.ok(/word\d+…$/.test(out), 'cut between words, never inside one');
  const unbroken = 'x'.repeat(300);
  assert.equal(plainSnippet(unbroken), `${'x'.repeat(200)}…`, 'no space at all: a hard cut');
  assert.equal(plainSnippet('short'), 'short');
});

test('S3: groupResults splits pages, code and CAD, keeping order', () => {
  const rows = ['page', 'class', 'cad', 'fn', 'page', 'file', 'fork', 'repo', 'odd']
    .map((kind, i) => hit({ kind, title: `t${i}` }));
  const g = groupResults(rows);
  assert.deepEqual(g.page.map((r) => r.title), ['t0', 't4']);
  assert.deepEqual(g.code.map((r) => r.title), ['t1', 't3', 't5', 't7']);
  assert.deepEqual(g.cad.map((r) => r.title), ['t2', 't6']);
  assert.deepEqual(groupResults(null), { page: [], code: [], cad: [] });
});

test('S3: searchTab reads kind= from the hash, defaulting to Pages when any page matched', () => {
  const some = { page: [hit()], code: [], cad: [] };
  const none = { page: [], code: [hit({ kind: 'fn' })], cad: [] };
  assert.equal(searchTab('#/search?q=px4&kind=code'), 'code');
  assert.equal(searchTab('#/search?kind=cad&q=px4'), 'cad');
  assert.equal(searchTab('#/search?q=px4&kind=page', none), 'page', 'an explicit tab wins');
  assert.equal(searchTab('#/search?q=px4&kind=all', some), 'all');
  assert.equal(searchTab('#/search?q=px4', some), 'page');
  assert.equal(searchTab('#/search?q=px4', none), 'all');
  assert.equal(searchTab('#/search?q=px4&kind=bogus', some), 'page', 'junk is the default');
  assert.equal(searchTab('#/search?q=px4'), 'all', 'no groups: All');
  assert.equal(searchTab(null), 'all');
});

test('S3: searchTabHref builds a real link that keeps the query', () => {
  assert.equal(searchTabHref('how do I flash PX4', 'code'),
    '#/search?q=how%20do%20I%20flash%20PX4&kind=code');
  assert.equal(searchTab(searchTabHref('a&b', 'cad')), 'cad');
  assert.equal(new URLSearchParams(searchTabHref('a&b=c', 'page').split('?')[1]).get('q'), 'a&b=c');
});

test('S5: noResultsModel offers up to four chips, the three nearest pages, and the waiting flag', () => {
  const site = { example_queries: [
    { label: 'flash PX4', q: 'px4' }, { label: 'mixer', q: 'mixer' }, { label: 'uart', q: 'uart' },
    { label: 'sim', q: 'simulation' }, { label: 'fifth', q: 'fifth' },
  ] };
  const res = { results: [
    hit({ kind: 'fn', title: 'f' }), hit({ kind: 'page', title: 'p1', href: '#/p1' }),
    hit({ kind: 'page', title: 'p2', href: '#/p2' }), hit({ kind: 'cad', title: 'c' }),
    hit({ kind: 'page', title: 'p3', href: '#/p3' }), hit({ kind: 'page', title: 'p4', href: '#/p4' }),
  ] };
  const m = noResultsModel(res, site, true);
  assert.deepEqual(m.chips.map((c) => c.label), ['flash PX4', 'mixer', 'uart', 'sim']);
  assert.equal(m.chips[0].href, '#/search?q=px4');
  assert.deepEqual(m.nearest.map((r) => r.title), ['p1', 'p2', 'p3']);
  assert.equal(m.waiting, true);
  const empty = noResultsModel({ results: [] }, null, false);
  assert.deepEqual(empty, { chips: [], nearest: [], waiting: false });
  assert.deepEqual(noResultsModel(null, site, 0).nearest, []);
});

test('S6: highlightParts marks every query term, case-insensitively, in order', () => {
  assert.deepEqual(highlightParts('Flash the PX4 firmware', ['flash', 'px4']), [
    { text: 'Flash', hit: true }, { text: ' the ', hit: false },
    { text: 'PX4', hit: true }, { text: ' firmware', hit: false },
  ]);
  assert.deepEqual(highlightParts('no match here', ['zz']), [{ text: 'no match here', hit: false }]);
  assert.deepEqual(highlightParts('', ['a']), []);
  assert.deepEqual(highlightParts('px4px4', ['px4']), [{ text: 'px4px4', hit: true }], 'adjacent hits merge');
  // the longer term wins where two overlap; a one-letter term marks nothing
  assert.deepEqual(highlightParts('setup set', ['set', 'setup', 'p']), [
    { text: 'setup', hit: true }, { text: ' ', hit: false }, { text: 'set', hit: true },
  ]);
  // regex characters in a term are literal
  assert.deepEqual(highlightParts('a.b axb', ['a.b']), [
    { text: 'a.b', hit: true }, { text: ' axb', hit: false },
  ]);
  // the parts always join back to the input
  const text = '<script>PX4</script> & "flash"';
  assert.equal(highlightParts(text, ['px4', 'flash']).map((p) => p.text).join(''), text);
});

test('S3: lastAnswer remembers only the latest finished query, by its trimmed lower-cased text', async () => {
  assert.equal(typeof lastAnswer, 'function');
  assert.equal(lastAnswer('never asked'), null);
});

test('S6: js/app.js escapes every highlighted segment and never raw snippet text', () => {
  const src = fs.readFileSync(APP_JS, 'utf8');
  assert.ok(src.includes('HCSearch.highlightParts('), 'rows are highlighted through the pure helper');
  assert.ok(/<mark class="hl">\$\{esc\(p\.text\)\}<\/mark>/.test(src), 'a marked segment is escaped');
  assert.ok(src.includes('HCSearch.plainSnippet(r.snippet)'), 'S4: snippets are plain text');
});

test('S3: pages below the 40-row cut still reach the Pages tab, in rank order', () => {
  const rows = [];
  for (let i = 0; i < 50; i += 1) rows.push({ t: `Ros symbol ${i}`, r: `#/c${i}`, x: 'ros' });
  const items = buildItems([siteShard(rows)]).map((it) => Object.assign(it, { kind: 'class' }));
  const pages = buildItems([siteShard([
    { t: 'Notes A', r: '#/pa', x: 'mentions ros once' },
    { t: 'Notes B', r: '#/pb', x: 'ros again' },
  ])]);
  const { results } = searchItems(items.concat(pages), 'ros');
  assert.equal(results.length, 42);
  assert.deepEqual(results.slice(40).map((r) => r.href), ['#/pa', '#/pb']);
  for (let i = 1; i < results.length; i += 1) assert.ok(results[i - 1].score >= results[i].score);
});

// ------------------------------------------------- review S-1: in-flight dedupe --

test('review S-1: two concurrent enrich calls for one query make exactly one request', async () => {
  const local = mixedLocal(8);
  const ids = assignIds(local.results);
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetchCounting = async () => {
    calls += 1;
    await gate;
    return resp(200, { results: [{ id: ids[3], why: 'w' }] });
  };
  const lib = createLibrarian({ fetch: fetchCounting });
  const a = lib.enrich('thruster model', local);
  const b = lib.enrich('  Thruster Model ', local);     // the same trimmed lower-cased key
  await new Promise((r) => setTimeout(r, 0));
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(calls, 1, 'the second call awaits the first request');
  assert.equal(ra.librarianCount, 1);
  assert.equal(rb.librarianCount, 1);
  assert.deepEqual(rb.results.map((r) => r.title), ra.results.map((r) => r.title));
});

test('review S-1: a failed in-flight request is not remembered: the next call asks again', async () => {
  let calls = 0;
  const lib = createLibrarian({ fetch: async () => { calls += 1; throw new Error('blip'); } });
  const local = mixedLocal(4);
  const [x, y] = await Promise.all([lib.enrich('thruster model', local), lib.enrich('thruster model', local)]);
  assert.equal(calls, 1);
  assert.equal(x.notice, LIBRARIAN_NOTICE);
  assert.equal(y.notice, LIBRARIAN_NOTICE);
  await lib.enrich('thruster model', local);
  assert.equal(calls, 2, 'the entry was dropped in finally');
});
