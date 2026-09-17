// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 5 September 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Answer documentation queries through a bounded serverless search of the site's graphs.
/* The librarian: a serverless search agent that walks this site's own graphs.

   It no longer re-ranks a list the browser found — it SEARCHES. A free chat
   model reads the site's knowledge graphs out of this function's own deployment
   bundle and answers the query in at most two hops:

     hop 1 — survey  the query, the browser's keyword candidates (which MAY be
                     empty: a query with no keyword hits is exactly the one this
                     exists for) and a compact catalog of every page, every
                     repository and every CAD part, each carrying an id. The
                     model answers {"hits":[{id,why}], "open":[repo,…]}.
     hop 2 — walk    only when the keyword list was short and hop 1 opened a
                     repository: the opened repositories' graph shards, their
                     file lists, the symbols whose names match the query, and
                     the wiki-graph neighbours of the hop-1 hits — all in
                     catalog id space. The model answers the final {"hits":…}.

   Hop 2 is ADDITIVE AND RE-ORDERING, never subtractive: it may insert and
   re-rank, but it cannot erase what the survey found, and an empty answer from
   it is a failed walk rather than a confident "nothing matches".

   Every id the model returns is validated against real data on the way out and
   turned into a row whose id and href are BYTE-IDENTICAL to the row
   js/search.js would have built for the same entry (pages → the hash route,
   repositories → the GitHub URL, CAD and code → the blob URL with its #L
   anchor). Anything that does not resolve is dropped, so a hallucinated id can
   never reach the page.

   RAW NODE, ON PURPOSE. Nothing here touches a Vercel-injected convenience:
   the request body is read off the stream, parsed explicitly, and every answer
   goes out through writeHead/end. That is what lets tools/dev_site.mjs pass a
   plain http server's request and response straight in, so local behaviour is
   identical to deployed behaviour instead of merely similar.

   This file is the Kyle-gated half of the feature. The site works completely
   without it: GitHub Pages answers a POST to a missing path with 405, which the
   client reads as "no function on this host" and silently latches off.

   Contract with the client (js/search.js):
     in   POST {"q": "...", "candidates": [{id,title,kind,where,snippet}, ...]}
               candidates must be an array; it may be EMPTY.
     out  200  {"results":[{"id","why"[,"kind","title","where","href","snippet"]},…],
                "provider","model","promptChars","temperature","calls","hops",
                "ms","partial"[,"salvaged"]}
               `salvaged` appears only when it is true: an answer that was not
               JSON at all had its ids read out of the wreck (see parseModelJson).
          400  malformed request       413  body too large
          403  cross-origin            429  rate limited
          405  wrong method            500  a file missing from the bundle
          502  {"error","providers":[{provider,hop,attempt,reason}],"exhausted"}
               one entry per ATTEMPT: a primary re-asked after a garbled or
               empty answer appears again as attempt 2 on the same hop.
     EVERY answer, the pre-body 405/403/429 included, carries
     `x-librarian-version: 2`. It costs nothing — no body read, no model call —
     and is the zero-quota readiness probe: the old handler answers 405 without
     it, this one with it, so a deploy can be confirmed before a request is
     spent against a stale deployment.

   Keys live in the environment and nowhere else. They are never logged, never
   written to a file, and never put into a prompt. */
'use strict';

const fs = require('fs');
const path = require('path');

const LIBRARIAN_VERSION = '2';

const MAX_BODY_BYTES = 512 * 1024;
const MAX_PICKS = 8;
const MAX_CANDIDATES = 40;        // the client sends 25; this is the hard ceiling

/* Per-field and whole-payload caps on the candidate list. Every one of these
   strings is client-controlled and lands verbatim in the provider prompt, so
   without them one well-formed request could spend the entire 512 KiB body
   budget on prompt tokens. The generous-but-finite numbers below fit the real
   data (the longest genuine title on this site is well under 200 chars) while
   bounding what a hostile caller can make us pay for. */
const MAX_FIELD = { id: 200, title: 200, kind: 40, where: 200, snippet: 240 };
const MAX_CANDIDATE_CHARS = 24 * 1024;   // aggregate across the whole list
const ONE_LINER_CHARS = 100;             // catalog one-liners; 277 rows pay for each char
const WHY_CHARS = 120;

/* Hop-1 size. MEASURED on the real data (2026-09-05): the catalog is 43,056
   chars and the hop-1 user message with the real "install ros" candidate list
   is 44,206. CATALOG_MAX_CHARS is the line the catalog may not cross; when the
   site grows past it the fix is to shorten the one-liners or drop a field,
   NOT to raise this number — every char here is paid on every semantic search,
   and the 8000ms primary deadline was justified against a prompt this size. */
const CATALOG_MAX_CHARS = 45000;
const HOP1_MESSAGE_MAX_CHARS = 48000;

/* Hop-2 size. The largest real shard (hippo_control) plus its file list and the
   symbols matching a query fits these caps with room to spare; the trim ladder
   in buildHop2Messages is what keeps a pathological query inside them. */
const HOP2_MAX_CHARS = 30000;
const HOP2_MAX_FILES = 80;
const HOP2_MAX_MATCHES = 40;
const HOP2_MAX_NEIGHBOURS = 20;
const MAX_OPEN_REPOS = 3;

/* FREE MODELS ONLY — Kyle's decision (2026-09-04): "set and forget", no spend.
   Both entries are `:free` variants on OpenRouter, so nothing is ever billed.
   What free costs, plainly: OpenRouter caps free-model requests per key at
   ~20/min and, for an account that never bought $10 of credit, 50/day. A
   throttled answer is an error here and the client falls back to the local
   index, so the site never breaks — it just answers keyword-only past the cap.

   ONE GATEWAY, TWO MODELS — a real trade, recorded rather than glossed over.
   Groq's signup was inoperable and NVIDIA's own API sits behind a manual
   verification queue, so both entries ride OpenRouter. An OpenRouter outage
   takes both paths with it: the fallback below buys model-level resilience
   (one model timing out, refusing, or answering unparseably), NOT gateway-
   level resilience. The per-provider URL overrides are kept separate so one
   path can still be broken deliberately (the fallback drill) and so either
   entry can be repointed at a direct vendor endpoint the moment one is
   reachable.

   HOW THESE TWO WERE CHOSEN (measured 2026-09-04, 15 real queries each through
   this handler, temperature 0, 5s deadline — see tools/bench_librarian.mjs):
     nemotron-3-super-120b-a12b:free   13/15  median 2955ms  top-1 12/15  (2 timeouts)
     nemotron-3-nano-omni-30b-a3b:free  8/15  median 1790ms  top-1  7/15  (6 empty answers)
     nemotron-3.5-lightning:free        1/15  (14 timeouts)
     nemotron-3-ultra-550b:free         0/15  (15 timeouts)
     gemma-4-26b / gemma-4-31b :free    0/15  ("temporarily rate-limited upstream")
     glm-5.2:free                       1/15  (rate-limited upstream)
     minimax-m2.7:free                  0/15  (refuses reasoning: disabled)
   Super is the only free model that works; nano is a different, faster model
   for the moments Super is slow, which a retry of Super would not cover. Both
   are hybrid Mamba-Transformer MoEs, not Llama derivatives (policy). */
/* `routing` is OpenRouter's `provider` request field — an OpenRouter-only
   extension, sent only when an entry carries it. Repoint an entry at a direct
   vendor endpoint and drop its `routing` in the same edit: OpenAI-compatible
   servers usually ignore unknown fields, but that is a habit, not a contract. */
const PROVIDERS = [
  {
    name: 'nemotron',
    keyEnv: 'OPENROUTER_API_KEY',
    urlEnv: 'LIBRARIAN_NEMOTRON_URL',
    defaultUrl: 'https://openrouter.ai/api/v1/chat/completions',
    // POLICY, NOT BENCHMARK: a Llama-family model is forbidden here — at any
    // tier, in any role, fallback included. providerConfig() refuses an
    // override that names one.
    model: 'nvidia/nemotron-3-super-120b-a12b:free',
    modelEnv: 'LIBRARIAN_NEMOTRON_MODEL',
    // The free variant has exactly one upstream (NVIDIA). Pinned anyway so a
    // future second upstream cannot silently change the measured behaviour.
    routing: { order: ['Nvidia'], allow_fallbacks: true },
    // Thinking on, the paid id thought past a 5s deadline on 15 of 15 real
    // queries. Off, it answers in ~3s.
    reasoning: { enabled: false },
    // Its two failures in 15 were timeouts at 5000ms with the slowest success
    // at 4718ms — the deadline was clipping real answers. 8s keeps those and
    // still leaves room for the fallback below. It is a CEILING now: the real
    // deadline of a call is min(this, what is left of the search budget).
    timeoutMs: 8000,
  },
  {
    name: 'nano',
    keyEnv: 'OPENROUTER_API_KEY',
    urlEnv: 'LIBRARIAN_NANO_URL',
    defaultUrl: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    modelEnv: 'LIBRARIAN_NANO_MODEL',
    routing: { order: ['Nvidia'], allow_fallbacks: true },
    reasoning: { enabled: false },
    timeoutMs: 5000,
  },
];

/* ONE budget for the whole search, not a sum of per-call deadlines. Each call
   is clamped to min(its own ceiling, what is left), so the worst case is
   arithmetic rather than luck: a hop that times out on super (8000) and then on
   nano (5000) spends exactly SEARCH_BUDGET_MS and still leaves TIMEOUT_SLACK_MS
   for reading the body, the catalog and writing the answer inside the
   function's maxDuration. A test pins every one of those relations.

   MAX_MODEL_CALLS is set by the 50-requests-a-day free cap, not by the clock:
   three 3s hops would fit the budget, but a third hop plus a per-hop fallback
   needs four calls, and depth is not worth trading resilience for. */
const SEARCH_BUDGET_MS = 13000;
const TIMEOUT_SLACK_MS = 2000;
const FUNCTION_MAX_DURATION_MS = 15000;   // mirrors vercel.json maxDuration: 15
const MAX_MODEL_CALLS = 3;
const MIN_HOP_MS = 2500;    // never start a hop that cannot plausibly finish
const WALK_THRESHOLD = 3;   // 3+ keyword hits is already a strong answer

const PROVIDER_NAMES = PROVIDERS.map((p) => p.name);

/* MEASURED 2026-09-05 against the free serving, and this prompt is the answer
   to what was measured. On its one valid reply to "ESC I2C firmware" the model
   returned a SINGLE hit — the repository, with no setup page beside it — and
   put a PROJECT name in `open`, which validateOpen drops, so the walk never
   ran. On "motor mount CAD" it ranked the assembly and the neighbouring
   gondola parts around the part actually named in the query. Hence the three
   rules below: pair the page that documents a thing with the repository that
   implements it, rank the named component above what merely contains it, and
   say in words that `open` takes repository names. A test pins the literals. */
const HOP1_SYSTEM = [
  'You are the librarian of a robotics lab\'s documentation site.',
  'Answer the search query by walking the site\'s knowledge graph. This is hop 1 of 2.',
  'You get the QUERY, CANDIDATES a keyword index already found (may be empty; each one',
  'matches every query word), and the CATALOG: every page (id page:…), every repository',
  '(id repo:…, with its project, fork flag and main code symbols) and every CAD',
  'part (id cad:…).',
  '',
  'Reply with STRICT JSON and nothing else, in exactly this shape:',
  '  {"hits":[{"id":"<id>","why":"<at most 12 words>"}],"open":["<repo name>"]}',
  '- hits: the entries that answer the query, best first, at most ' + MAX_PICKS + ',',
  '  using ONLY ids listed above; when candidates exist, keep the best of them first.',
  '- For a query about a device, firmware, driver or procedure, list the setup page that',
  '  documents it AND the repository that implements it, then related parts, forks last;',
  '  a single hit is almost always incomplete on this site — aim for 3 to ' + MAX_PICKS + '.',
  '- When the query names a specific component (mount, bracket, housing, adapter…),',
  '  the part whose own name or path contains those words is the top hit;',
  '  assemblies and neighbouring parts that merely contain or sit near it come after.',
  '- Prefer the lab\'s own repositories over forks unless the query is about the upstream',
  '  firmware itself.',
  '- open: only when walk is true — at most ' + MAX_OPEN_REPOS + ' repositories worth',
  '  inspecting for code-level hits (classes, functions, files) when the query is about',
  '  code, firmware, drivers or a symbol; otherwise []. open lists REPOSITORY NAMES',
  '  exactly as they appear after `repo:` in the catalog, never a project or page name.',
].join('\n');

const HOP2_SYSTEM = [
  'You are the librarian of a robotics lab\'s documentation site. This is hop 2 of 2.',
  'You get the QUERY, the HITS from hop 1, the OPENED repositories (description,',
  'language, main symbols with their file paths, communities, files, and the symbols',
  'whose names match the query) and the graph NEIGHBOURS of the hop-1 hits (linked pages',
  'and repositories, each with why they are linked).',
  '',
  'Reply with STRICT JSON and nothing else, in exactly this shape:',
  '  {"hits":[{"id":"<id>","why":"<at most 12 words>"}]}',
  '- the final ranking, best first, at most ' + MAX_PICKS + '.',
  '- Allowed ids: any hop-1 hit id, any neighbour id, sym:<repo>:<path>:<symbol> for a',
  '  listed symbol, file:<repo>:<path> for a listed file.',
  '- Keep pages and repositories that answer the query directly ahead of symbols inside',
  '  them; add at most 2 code-level hits per repository, and only when they answer more',
  '  precisely than the repository itself.',
].join('\n');

// ------------------------------------------------------- abuse protection --

/* WHAT THIS BUYS, HONESTLY. This endpoint is public and every call it accepts
   spends real provider quota — and one request now costs up to three upstream
   calls. The two gates below raise the cost of abusing that. They are NOT
   authentication:

     - the Origin gate stops a browser on another site from spending the quota,
       because a JSON POST is preflighted and no permissive CORS header is ever
       sent back. A `curl` with a forged Origin (or none) still gets through.
     - the rate limit is per serverless INSTANCE and lives in that instance's
       memory. Instances are not shared and are recycled, so this throttles a
       sustained attacker per instance rather than globally; a distributed
       caller with many source addresses is not stopped by it at all.

   Anything stronger needs a shared store or a real credential, which this
   zero-dependency, zero-state design deliberately does not have. */

const RATE_WINDOW_MS = 60000;
// 6, down from 12: one request is now up to THREE upstream calls, so the old
// per-minute budget was really 36 calls against a 20/min free cap.
const RATE_MAX_PER_KEY = 6;       // one browser, one minute
const RATE_MAX_GLOBAL = 120;      // this instance, one minute, everyone together
const RATE_MAX_KEYS = 1000;       // hard ceiling on the tracking map

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

function bareHost(value) {
  return String(value == null ? '' : value)
    .trim().replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
}

/* An absent Origin is fine (curl, server-to-server, a same-origin non-CORS
   request). A present one must be this deployment's own host, or a localhost
   dev origin so tools/dev_site.mjs works against a real handler. */
function originAllowed(req) {
  const headers = (req && req.headers) || {};
  const origin = headers.origin;
  if (!origin) return true;
  if (origin === 'null') return false;              // opaque origin
  let hostname;
  try { hostname = new URL(String(origin)).hostname; } catch (e) { return false; }
  hostname = bareHost(hostname);
  if (!hostname) return false;
  if (LOCAL_HOSTNAMES.has(hostname)) return true;
  const own = bareHost(headers.host);
  return Boolean(own) && hostname === own;
}

/* The client key is the FIRST entry of x-forwarded-for — the address the edge
   saw — falling back to the socket address. Later entries are hops and are
   attacker-appendable, so trusting them would hand out a fresh budget per
   forged hop. */
function clientKey(req) {
  const headers = (req && req.headers) || {};
  let fwd = headers['x-forwarded-for'];
  if (Array.isArray(fwd)) fwd = fwd[0];
  if (typeof fwd === 'string' && fwd.trim()) {
    return { key: fwd.split(',')[0].trim().toLowerCase(), proxied: true };
  }
  const socket = (req && req.socket && req.socket.remoteAddress) || null;
  return { key: socket ? String(socket).toLowerCase() : null, proxied: false };
}

/* A DIRECT loopback connection — no x-forwarded-for at all — is the developer
   on their own machine (tools/dev_site.mjs, tools/bench_librarian.mjs). It is
   exempt from the per-key budget but NOT from the per-instance ceiling. On a
   real deployment every request arrives through the platform proxy with
   x-forwarded-for set, so this branch would already be unreachable there — but
   "would be" is not a security control, so isHosted() below makes it provably
   dead on any serverless host regardless of how the request is presented. */
function isHosted() {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

function isLoopback(key) {
  if (!key) return false;
  const bare = key.replace(/^::ffff:/, '');
  return bare === '127.0.0.1' || bare === '::1' || bare.startsWith('127.');
}

function createLimiter(opts) {
  const cfg = opts || {};
  const windowMs = cfg.windowMs || RATE_WINDOW_MS;
  const perKey = cfg.perKey || RATE_MAX_PER_KEY;
  const ceiling = cfg.global || RATE_MAX_GLOBAL;
  const maxKeys = cfg.maxKeys || RATE_MAX_KEYS;
  const seen = new Map();       // key -> ascending timestamps inside the window
  let all = [];                 // every timestamp, for the per-instance ceiling
  let lastSweep = 0;

  function live(stamps, now) {
    let i = 0;
    while (i < stamps.length && now - stamps[i] >= windowMs) i += 1;
    return i ? stamps.slice(i) : stamps;
  }
  function retryAfter(stamps, now) {
    return Math.max(1, Math.ceil((stamps[0] + windowMs - now) / 1000));
  }
  function sweep(now) {
    for (const [k, stamps] of seen) {
      const kept = live(stamps, now);
      if (!kept.length) seen.delete(k);
      else if (kept !== stamps) seen.set(k, kept);
    }
    // A flood of distinct keys must not grow the map without bound: drop the
    // oldest-inserted entries until the hard cap is respected.
    while (seen.size > maxKeys) seen.delete(seen.keys().next().value);
  }

  function check(key, now, exempt) {
    all = live(all, now);
    // Expired entries are evicted on a timer as well as on pressure, so a burst
    // of one-shot keys does not sit in memory until the next burst arrives.
    if (seen.size && (now - lastSweep >= windowMs || seen.size > maxKeys / 2)) {
      sweep(now);
      lastSweep = now;
    }
    if (all.length >= ceiling) return { ok: false, retryAfter: retryAfter(all, now) };
    const tracked = Boolean(key) && !exempt;
    let stamps = null;
    if (tracked) {
      stamps = live(seen.get(key) || [], now);
      if (stamps.length >= perKey) {
        seen.set(key, stamps);
        return { ok: false, retryAfter: retryAfter(stamps, now) };
      }
    }
    all.push(now);
    if (tracked) {
      stamps.push(now);
      seen.set(key, stamps);
      if (seen.size > maxKeys) sweep(now);       // never past the hard cap
    }
    return { ok: true };
  }

  return {
    check,
    size: () => seen.size,
    reset: () => { seen.clear(); all = []; lastSweep = 0; },
  };
}

const defaultLimiter = createLimiter();

// ---------------------------------------------------------------- responses --

function send(res, code, payload, extraHeaders) {
  const headers = Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    // On EVERY answer, including the ones that read no body and call no model.
    'x-librarian-version': LIBRARIAN_VERSION,
  }, extraHeaders || {});
  const text = JSON.stringify(payload);
  headers['content-length'] = Buffer.byteLength(text);
  res.writeHead(code, headers);
  res.end(text);
}

// ------------------------------------------------------------------- input --

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (tooBig) return;                   // draining: keep the socket alive, keep nothing
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        // Never destroy the request here: tearing down the socket before the
        // 413 is written turns the intended JSON error into a connection reset.
        // The listener stays attached so the rest of the body drains, and the
        // 413 carries `connection: close` so the client does not reuse the socket.
        tooBig = true;
        chunks.length = 0;
        const e = new Error(`request body over ${MAX_BODY_BYTES} bytes`);
        e.httpCode = 413;
        reject(e);
        return;
      }
      chunks.push(buf);
    });
    req.on('error', reject);
    req.on('end', () => { if (!tooBig) resolve(Buffer.concat(chunks).toString('utf8')); });
  });
}

/* Strict read of the client payload. Returns {ask} or {error}.

   `candidates` must be an ARRAY but may be EMPTY: a multi-word query with zero
   keyword hits is precisely the query the walk was built for, and rejecting it
   would leave the old "No results" page in place. The post-loop guard below
   still fires — a NON-empty array that yields no usable row is a genuinely
   malformed payload, not a search with nothing to go on. */
function parseAsk(raw) {
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    return { error: `body is not valid JSON: ${e.message}` };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { error: 'body must be a JSON object' };
  }
  if (typeof doc.q !== 'string' || !doc.q.trim()) {
    return { error: 'q must be a non-empty string' };
  }
  if (!Array.isArray(doc.candidates)) {
    return { error: 'candidates must be an array' };
  }
  const candidates = [];
  const seen = new Set();
  let budget = MAX_CANDIDATE_CHARS;
  const field = (value, name) =>
    String(value == null ? '' : value).slice(0, MAX_FIELD[name]);
  for (const c of doc.candidates.slice(0, MAX_CANDIDATES)) {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !c.id) {
      return { error: 'every candidate needs a string id' };
    }
    // The id is truncated like every other field, and dedupe runs on the
    // truncated value so two ids differing only past the cap cannot both pass.
    const id = field(c.id, 'id');
    if (seen.has(id)) continue;
    seen.add(id);
    const row = {
      id: id,
      title: field(c.title, 'title'),
      kind: field(c.kind, 'kind'),
      where: field(c.where, 'where'),
      snippet: field(c.snippet, 'snippet'),
    };
    const cost = row.id.length + row.title.length + row.kind.length
      + row.where.length + row.snippet.length;
    if (cost > budget) break;        // aggregate cap: keep the best-ranked prefix
    budget -= cost;
    candidates.push(row);
  }
  if (doc.candidates.length && !candidates.length) {
    return { error: 'candidates must contain at least one usable row' };
  }
  let pinned = null;
  if (doc.provider !== undefined) {
    if (typeof doc.provider !== 'string' || PROVIDER_NAMES.indexOf(doc.provider) === -1) {
      return { error: `provider must be one of ${PROVIDER_NAMES.join(', ')}` };
    }
    pinned = doc.provider;   // benchmarking hook: pin one provider, no fallback
  }
  return { ask: { q: doc.q.trim().slice(0, 300), candidates, pinned } };
}

// ------------------------------------------------------------------- text --

function flatten(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}
function clip(text, max) {
  const flat = flatten(text);
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}
function oneLiner(text) {
  return clip(text, ONE_LINER_CHARS);
}

/* The client's tokeniser, re-implemented so the symbols hop 2 sees are the ones
   the browser would have matched: camelCase split, lowercased, non-alphanumeric
   as the separator. js/search.js is the original; the pair is small enough that
   copying beats shipping the whole engine into the function. */
function tokens(value) {
  return String(value == null ? '' : value)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// ------------------------------------------------------------------- data --

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data', 'graph');
const DEFAULT_SITE_DIR = path.join(__dirname, '..');

const fileCache = new Map();      // absolute path -> parsed JSON
const missingFiles = new Set();   // absolute path -> known absent (optional reads)

/* A file the function CANNOT work without: a missing or corrupt one is a 500
   that names it, so a mis-bundled deploy (vercel.json includeFiles) fails
   loudly on the first request rather than answering something plausible. */
function readJsonFile(file) {
  const hit = fileCache.get(file);
  if (hit !== undefined) return hit;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    const err = new Error(`catalog file missing from the bundle: ${file} (${e.code || e.message})`);
    err.httpCode = 500;
    throw err;
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    const err = new Error(`catalog file is not valid JSON: ${file} (${e.message})`);
    err.httpCode = 500;
    throw err;
  }
  fileCache.set(file, doc);
  return doc;
}

/* A per-repository shard, read on demand. Absent is a normal answer here: not
   every repository has a graph shard or a code shard, and a model that opens
   one that does not exist gets that name dropped rather than a 500. */
function optionalJsonFile(file) {
  const hit = fileCache.get(file);
  if (hit !== undefined) return hit;
  if (missingFiles.has(file)) return null;
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    missingFiles.add(file);
    return null;
  }
  fileCache.set(file, doc);
  return doc;
}

/* A repository name reaches the filesystem only from the model (an `open` list
   or a sym:/file: id), so it is checked twice: this shape test, and membership
   of the real repository index in every caller. `.github` is a real repository,
   hence the leading dot; `..` and any separator are not. */
const REPO_NAME = /^\.?[A-Za-z0-9][A-Za-z0-9._-]*$/;
function safeRepoName(name) {
  const s = String(name == null ? '' : name);
  return REPO_NAME.test(s) && !s.includes('..') ? s : null;
}

const indexCache = new Map();

/* A COMPACT catalog — ids, titles, kinds and one-liners, never full summaries —
   plus the lookup tables resolution and the neighbour walk need. Read with
   readFileSync from this function's own bundle (vercel.json ships
   {data/graph,search}/** via includeFiles); the function never fetches its own
   site over HTTP. Built once per process per directory pair. */
function siteIndex(dataDir, siteDir) {
  // \u0000 as an escape, never as a raw byte: a literal NUL in this file makes
  // grep call the whole source binary and answer nothing, which silently
  // empties every audit of it. The separator itself is unchanged.
  const key = `${dataDir}\u0000${siteDir}`;
  const cached = indexCache.get(key);
  if (cached) return cached;

  const wiki = readJsonFile(path.join(dataDir, 'wiki.json'));
  const repos = readJsonFile(path.join(dataDir, 'repos-index.json'));
  const cad = readJsonFile(path.join(siteDir, 'search', 'cad.json'));

  const rows = [];
  const byNode = new Map();        // wiki node id -> catalog id
  const nodeById = new Map();      // wiki node id -> node
  const pageByRoute = new Map();   // "#/route" -> node
  const projectTitle = new Map();  // project slug -> its page title
  const repoNode = new Map();      // repo name -> wiki node (carries the url)

  for (const node of (Array.isArray(wiki.nodes) ? wiki.nodes : [])) {
    if (!node || !node.id) continue;
    nodeById.set(node.id, node);
    if (node.kind === 'repo') {
      // The node id is canonical (`repo:<name>`); the title is only a fallback.
      const id = String(node.id);
      const name = id.startsWith('repo:') ? id.slice(5) : String(node.title || '');
      if (name) repoNode.set(name, node);
      continue;                                   // repos come from repos-index
    }
    const route = String(node.route || '');
    if (!route) continue;
    if (node.kind === 'project') {
      projectTitle.set(String(node.id).replace(/^projects\//, ''), String(node.title || ''));
    }
    pageByRoute.set(route, node);
    const id = `page:${route}`;
    byNode.set(node.id, id);
    // No `where` on page rows: the route inside the id already says where the
    // page lives, and 93 rows of it is ~4 KB of prompt for nothing.
    rows.push({
      id,
      title: String(node.title || ''),
      kind: String(node.kind || ''),
      about: oneLiner(node.summary),
    });
  }

  const repoByName = new Map();
  for (const repo of (Array.isArray(repos.repos) ? repos.repos : [])) {
    if (!repo || !repo.name) continue;
    const name = String(repo.name);
    repoByName.set(name, repo);
    const row = {
      id: `repo:${name}`,
      title: name,
      kind: repo.fork ? 'fork' : 'repo',
      where: String(repo.project || ''),
      about: oneLiner(repo.oneliner),
    };
    // Forks carry no god nodes (we index their file lists only, by policy).
    if (!repo.fork) {
      const sym = (Array.isArray(repo.god_nodes) ? repo.god_nodes : []).slice(0, 6).map(String);
      if (sym.length) row.sym = sym;
    }
    byNode.set(`repo:${name}`, row.id);
    rows.push(row);
  }

  for (const part of (Array.isArray(cad.parts) ? cad.parts : [])) {
    if (!Array.isArray(part) || !part[1]) continue;
    rows.push({ id: `cad:${String(part[1])}`, title: String(part[0] || ''), kind: 'cad' });
  }

  // The union of in- and out-edges per node. MEASURED: 114 of 187 nodes have
  // only in-edges, and the afro-esc page — the headline query's answer — has
  // none going out, so a directed walk would hand hop 2 an empty neighbourhood.
  const edgesByNode = new Map();
  const push = (from, other, edge) => {
    if (!edgesByNode.has(from)) edgesByNode.set(from, []);
    edgesByNode.get(from).push({ other, type: String(edge.type || ''), why: String(edge.why || '') });
  };
  for (const edge of (Array.isArray(wiki.edges) ? wiki.edges : [])) {
    if (!edge || !edge.s || !edge.t) continue;
    push(edge.s, edge.t, edge);
    push(edge.t, edge.s, edge);
  }

  const nodeByCatalogId = new Map();
  for (const [nodeId, catalogId] of byNode) nodeByCatalogId.set(catalogId, nodeId);

  // Carried ON the rows array so buildCatalog() keeps returning exactly the
  // list the prompt serialises (JSON.stringify ignores array properties).
  rows.byNode = byNode;

  const index = {
    rows, byNode, nodeById, nodeByCatalogId, pageByRoute,
    repoByName, repoNode, projectTitle, edgesByNode, cad,
  };
  indexCache.set(key, index);
  return index;
}

function buildCatalog(dataDir, siteDir) {
  return siteIndex(dataDir || DEFAULT_DATA_DIR, siteDir || DEFAULT_SITE_DIR).rows;
}

/* Everything the walk reads, bound to one request: the directories, the request
   candidate ids (whose rows belong to the client, not to us), and lazy readers
   for the per-repository shards. */
function createContext(opts) {
  const cfg = opts || {};
  const dataDir = cfg.dataDir || DEFAULT_DATA_DIR;
  const siteDir = cfg.siteDir || DEFAULT_SITE_DIR;
  const candidateIds = cfg.candidateIds instanceof Set
    ? cfg.candidateIds
    : new Set(Array.isArray(cfg.candidateIds) ? cfg.candidateIds : []);
  return {
    dataDir,
    siteDir,
    candidateIds,
    index: () => siteIndex(dataDir, siteDir),
    catalog: () => siteIndex(dataDir, siteDir).rows,
    repoShard: (name) => {
      const safe = safeRepoName(name);
      return safe ? optionalJsonFile(path.join(dataDir, `repo-${safe}.json`)) : null;
    },
    codeShard: (name) => {
      const safe = safeRepoName(name);
      return safe ? optionalJsonFile(path.join(siteDir, 'search', `code-${safe}.json`)) : null;
    },
  };
}

// ------------------------------------------------------------- resolution --

/* js/search.js's own URL builder, re-implemented here. The byte-equality tests
   pin the pair: a row this function returns must be indistinguishable from the
   row the browser would have built for the same entry, or the client's merge
   would show the same thing twice. */
function ghUrl(repo, branch, filePath, line) {
  const encoded = String(filePath).split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${repo}/blob/${branch}/${encoded}` + (line ? `#L${line}` : '');
}

function symbolRow(shard, entry) {
  const [label, filePath, line, kind] = entry;
  const short = String(shard.repo).split('/')[1];
  const href = ghUrl(shard.repo, shard.branch, filePath, kind === 'file' ? 0 : line);
  return {
    id: `${kind}:${href}`,
    kind: String(kind),
    title: String(label),
    where: short,
    href,
    snippet: String(filePath) + (line && kind !== 'file' ? `:L${line}` : ''),
  };
}

/* One model-authored id -> the row the client's index would hold, or null.
   Nothing here trusts the id: every part of it is looked up in real data. */
function resolveId(id, ctx) {
  if (typeof id !== 'string' || !id) return null;
  // An id the request already carried belongs to the client's own row; sending
  // our copy of it back would only risk drifting from what it is showing.
  if (ctx.candidateIds.has(id)) return { id };

  const index = ctx.index();

  if (id.startsWith('page:')) {
    const route = id.slice(5);
    const node = index.pageByRoute.get(route);
    if (!node) return null;
    return {
      id: `page:${route}`,
      kind: 'page',
      title: String(node.title || ''),
      where: String(node.where || ''),
      href: route,
      snippet: oneLiner(node.summary),
    };
  }

  if (id.startsWith('repo:')) {
    const name = id.slice(5);
    const meta = index.repoByName.get(name);
    const node = index.repoNode.get(name);
    if (!meta || !node || !node.url) return null;
    const project = index.projectTitle.get(String(meta.project || '')) || 'repository';
    return {
      id: `repo:${node.url}`,
      kind: 'repo',
      title: name,
      where: `HippoCampusRobotics · ${project}`,
      href: String(node.url),
      snippet: oneLiner(meta.oneliner),
    };
  }

  if (id.startsWith('cad:')) {
    const wanted = id.slice(4);
    const cad = index.cad;
    const part = (Array.isArray(cad.parts) ? cad.parts : []).find((p) => String(p[1]) === wanted);
    if (!part) return null;
    const href = ghUrl(cad.repo, cad.branch, String(part[1]));
    return {
      id: `cad:${href}`,
      kind: 'cad',
      title: String(part[0]),
      where: `CAD (.${String(part[2])})`,
      href,
      snippet: String(part[1]),
    };
  }

  // sym:<repo>:<path>:<label> — the label may itself contain colons (C++ scope
  // resolution), the path may not; a path with a colon in it is not indexed.
  const sym = /^sym:([^:]+):([^:]+):(.+)$/.exec(id);
  const file = /^file:([^:]+):(.+)$/.exec(id);
  if (sym || file) {
    const repoName = sym ? sym[1] : file[1];
    const wantedPath = sym ? sym[2] : file[2];
    const wantedLabel = sym ? sym[3] : null;
    if (!ctx.index().repoByName.has(repoName)) return null;
    const shard = ctx.codeShard(repoName);
    if (!shard || !Array.isArray(shard.symbols)) return null;
    const onPath = shard.symbols.filter((s) => String(s[1]) === wantedPath);
    if (!onPath.length) return null;               // the path is not indexed at all
    const exact = wantedLabel ? onPath.find((s) => String(s[0]) === wantedLabel) : null;
    // A label the model invented falls back to the FILE entry for that path:
    // the file genuinely exists and is the honest, less precise answer.
    const entry = exact || onPath.find((s) => String(s[3]) === 'file');
    if (!entry) return null;
    return symbolRow(shard, entry);
  }

  return null;
}

/* Model hits -> client rows: unresolvable ids dropped, deduped on the RESOLVED
   id, capped at MAX_PICKS, each carrying its (clipped) reason. */
function resolveHits(hits, ctx) {
  const out = [];
  const seen = new Set();
  for (const hit of (Array.isArray(hits) ? hits : [])) {
    if (!hit || typeof hit !== 'object') continue;
    const row = resolveId(hit.id, ctx);
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    row.why = clip(hit.why, WHY_CHARS);
    out.push(row);
    if (out.length >= MAX_PICKS) break;
  }
  return out;
}

/* The same filter, but keeping the id space the MODEL speaks — hop 2 needs the
   hop-1 hits as catalog ids to walk their neighbours, and a repository's
   catalog id (repo:esc) is not its resolved id (repo:<github url>). */
function validateHits(hits, ctx) {
  const out = [];
  const seen = new Set();
  for (const hit of (Array.isArray(hits) ? hits : [])) {
    if (!hit || typeof hit !== 'object') continue;
    const id = typeof hit.id === 'string' ? hit.id : '';
    if (!id || seen.has(id)) continue;
    if (!resolveId(id, ctx)) continue;
    seen.add(id);
    out.push({ id, why: clip(hit.why, WHY_CHARS) });
    if (out.length >= MAX_PICKS) break;
  }
  return out;
}

/* Names must be real, non-fork organisation repositories with a graph shard on
   disk. Unknown names and forks are dropped rather than argued with, the
   model's order is kept, and at most MAX_OPEN_REPOS survive. */
function validateOpen(list, ctx) {
  const out = [];
  const seen = new Set();
  for (const raw of (Array.isArray(list) ? list : [])) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    const meta = ctx.index().repoByName.get(name);
    if (!meta || meta.fork) continue;
    if (!ctx.repoShard(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= MAX_OPEN_REPOS) break;
  }
  return out;
}

/* The server half of the ordering contract: when the request carried keyword
   candidates and the model kept at least one, every graph row listed ABOVE the
   first kept candidate moves to directly after it. A keyword hit the model
   chose to keep always leads the rows it found by walking. */
function orderPicks(rows, candidateIds) {
  const known = candidateIds instanceof Set ? candidateIds : new Set(candidateIds || []);
  if (!known.size) return rows;
  const first = rows.findIndex((r) => known.has(r.id));
  if (first <= 0) return rows;
  return [rows[first]].concat(rows.slice(0, first), rows.slice(first + 1));
}

// ------------------------------------------------------------------ prompt --

function buildHop1Messages(ask, catalog, walk) {
  const user = JSON.stringify({
    query: ask.q,
    walk,
    candidates: ask.candidates,
    catalog,
  });
  return [
    { role: 'system', content: HOP1_SYSTEM },
    { role: 'user', content: user },
  ];
}

function matchesQuery(label, terms) {
  if (!terms.length) return false;
  const parts = tokens(label);
  const low = String(label).toLowerCase();
  return terms.some((t) => low === t || parts.some((k) => k === t || k.startsWith(t)));
}

/* What one opened repository looks like to hop 2: its graph shard as built
   (description, language, god nodes, communities), its file list, and the
   symbols whose names share a query token. */
function repoBrief(name, terms, ctx) {
  const shard = ctx.repoShard(name) || {};
  const code = ctx.codeShard(name);
  const symbols = code && Array.isArray(code.symbols) ? code.symbols : [];
  const files = [];
  const matches = [];
  for (const entry of symbols) {
    const kind = String(entry[3] || '');
    if (kind === 'file') {
      if (files.length < HOP2_MAX_FILES) files.push(String(entry[1]));
      continue;
    }
    if (matches.length < HOP2_MAX_MATCHES && matchesQuery(entry[0], terms)) {
      matches.push([String(entry[0]), String(entry[1]), kind]);
    }
  }
  return {
    name,
    description: String(shard.description || ''),
    language: String(shard.language || ''),
    symbols: (Array.isArray(shard.god_nodes) ? shard.god_nodes : [])
      .map((g) => ({ name: String(g.name || ''), kind: String(g.kind || ''), path: String(g.path || '') })),
    communities: (Array.isArray(shard.communities) ? shard.communities : [])
      .map((c) => ({ label: String(c.label || ''), top: Array.isArray(c.top) ? c.top : [] })),
    files,
    matches,
  };
}

/* The wiki-graph neighbours of the hop-1 hits, in CATALOG id space, over the
   union of in- and out-edges. Nodes with no catalog id are skipped, and an id
   hop 1 already returned is not offered back as a neighbour. */
function neighboursFor(hits, ctx) {
  const index = ctx.index();
  const out = [];
  const seen = new Set(hits.map((h) => h.id));
  for (const hit of hits) {
    const nodeId = index.nodeByCatalogId.get(hit.id);
    if (!nodeId) continue;
    for (const edge of (index.edgesByNode.get(nodeId) || [])) {
      const catalogId = index.byNode.get(edge.other);
      if (!catalogId || seen.has(catalogId)) continue;
      seen.add(catalogId);
      const node = index.nodeById.get(edge.other);
      out.push({
        id: catalogId,
        title: node ? String(node.title || '') : '',
        type: edge.type,
        why: clip(edge.why, 80),
      });
      if (out.length >= HOP2_MAX_NEIGHBOURS) return out;
    }
  }
  return out;
}

/* Hop 2's payload, trimmed to fit HOP2_MAX_CHARS. The ladder gives up the
   cheapest evidence first — the query-matching symbols, then the file list,
   then the communities — because the shard's own god nodes and the neighbours
   are what make the walk a walk. */
const HOP2_TRIM = [
  { matches: HOP2_MAX_MATCHES, files: HOP2_MAX_FILES, communities: Infinity },
  { matches: 20, files: HOP2_MAX_FILES, communities: Infinity },
  { matches: 0, files: HOP2_MAX_FILES, communities: Infinity },
  { matches: 0, files: 40, communities: Infinity },
  { matches: 0, files: 0, communities: Infinity },
  { matches: 0, files: 0, communities: 3 },
  { matches: 0, files: 0, communities: 0 },
];

function buildHop2Messages(ask, hits, open, ctx) {
  const terms = tokens(ask.q).slice(0, 8);
  const briefs = open.map((name) => repoBrief(name, terms, ctx));
  const neighbours = neighboursFor(hits, ctx);
  const shape = (caps, repos) => JSON.stringify({
    query: ask.q,
    hits,
    repos: repos.map((r) => ({
      name: r.name,
      description: r.description,
      language: r.language,
      symbols: r.symbols,
      communities: r.communities.slice(0, caps.communities),
      files: r.files.slice(0, caps.files),
      matches: r.matches.slice(0, caps.matches),
    })),
    neighbours,
  });

  let repos = briefs;
  let user = null;
  for (const caps of HOP2_TRIM) {
    user = shape(caps, repos);
    if (user.length <= HOP2_MAX_CHARS) break;
  }
  // Last resort — a repository at a time, from the end of the model's order.
  while (user.length > HOP2_MAX_CHARS && repos.length > 1) {
    repos = repos.slice(0, -1);
    user = shape(HOP2_TRIM[HOP2_TRIM.length - 1], repos);
  }
  return [
    { role: 'system', content: HOP2_SYSTEM },
    { role: 'user', content: user },
  ];
}

/* LAST RESORT, below the closer repair: pull the ids out of an answer that is
   not JSON at all.

   MEASURED 2026-09-05 — the SAME hop-1 request sent three times on the free
   serving answered once with
     {"hits":[{"id":"repo:esc],"open":["esc"]}
   (finish_reason "stop": a broken string that swallows the `why` and closes
   nothing), once with an empty body, and once validly. The wreck still carries
   the model's own ids in the model's own order, and every id is resolved
   against real site data downstream, so reading them widens what is READ, never
   what is TRUSTED. Throwing it away instead spends the fallback call — and, on
   that measured day, ended in a 502 for a formatting accident.

   An id capture that runs to the END of the text is deliberately NOT taken: an
   answer cut off mid-string (`{"hits":[{"id":"abc`) is a truncation for
   closeOpenBrackets to judge, not a garble, and half an id is not an id. */
const SALVAGE_ID = /"id"\s*:\s*"([^"\]}]+)/g;
const SALVAGE_WHY = /"why"\s*:\s*"([^"]*)"/;
const SALVAGE_OPEN = /"open"\s*:\s*\[([^\]]*)\]/;
const SALVAGE_QUOTED = /"([^"]*)"/g;

function salvageModelJson(text) {
  const marks = [];
  let m;
  SALVAGE_ID.lastIndex = 0;
  while ((m = SALVAGE_ID.exec(text)) !== null) {
    if (SALVAGE_ID.lastIndex >= text.length) break;   // unfinished, not garbled
    marks.push({ id: m[1], at: m.index, after: SALVAGE_ID.lastIndex });
  }
  if (!marks.length) return null;
  const hits = marks.map((mark, i) => {
    // the reason belongs to THIS id: look only as far as the next one
    const until = i + 1 < marks.length ? marks[i + 1].at : text.length;
    const why = SALVAGE_WHY.exec(text.slice(mark.after, until));
    return { id: mark.id, why: why ? why[1] : '' };
  });
  const open = [];
  const list = SALVAGE_OPEN.exec(text);
  if (list) {
    let q;
    SALVAGE_QUOTED.lastIndex = 0;
    while ((q = SALVAGE_QUOTED.exec(list[1])) !== null) open.push(q[1]);
  }
  return { hits, open, salvaged: true };
}

/* Models wrap JSON in fences and reasoning models prepend a think block; strip
   both, then parse strictly. Anything that still will not parse is handed to
   the closer repair and then to the salvage above; only when BOTH give up is it
   a provider failure, so the other provider gets its turn. Returns the whole
   hop document ({hits, open?}), because the walk needs `open` as well as
   `hits`. An EMPTY answer has nothing to read and stays a failure. */
function parseModelJson(content) {
  let text = String(content == null ? '' : content).trim();
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  if (!text) return null;
  let doc;
  let repaired = false;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    // Nemotron nano (measured 2026-09-04) ends its answer one closer short —
    // `{"hits":[{...}]` with finish_reason "stop" — on a third of queries.
    // Append the closers the text is missing and try once more. Only missing
    // closers are repaired; anything else that will not parse falls to the
    // salvage, which recovers ids or gives the other entry its turn.
    const patched = closeOpenBrackets(text);
    if (patched === null) return salvageModelJson(text);
    try {
      doc = JSON.parse(patched);
      repaired = true;
    } catch (e2) {
      return salvageModelJson(text);
    }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.hits)) return null;
  /* A repair may only RESCUE a document, never invent one: it has to leave at
     least one COMPLETE row behind. Truncated at `{"hits":[` the repair closes
     into a well-formed EMPTY answer, and at `{"hits":[{` into one idless row —
     both of which read as a confident "nothing matches", suppress the fallback
     and spend the search on a truncation. An un-repaired `{"hits":[]}` is still
     a valid (empty) answer; only the repaired path is held to this. */
  if (repaired && !doc.hits.some((h) => h && typeof h.id === 'string' && h.id)) return null;
  return doc;
}

/* Walk the text tracking JSON string state and the stack of open `{`/`[`.
   Returns the text with the unclosed ones closed in order, or null when the
   text is not merely unfinished (mismatched closer, or ends inside a string). */
function closeOpenBrackets(text) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return null;
    }
  }
  if (inString || !stack.length) return null;
  return text + stack.reverse().join('');
}

// --------------------------------------------------------------- providers --

// POLICY: no Llama-family model in any role, and FREE variants only (Kyle,
// 2026-09-04: no spend, ever). The built-in ids satisfy both; an environment
// override is the only way a different id can reach a provider, so it is
// checked here and a violating id disables that provider outright — a stale
// override left over from an earlier paid setup cannot quietly start billing.
const FORBIDDEN_MODEL = /llama/i;
const FREE_SUFFIX = ':free';

function providerConfig(provider, env) {
  const override = provider.modelEnv ? env[provider.modelEnv] : undefined;
  const cfg = {
    name: provider.name,
    key: env[provider.keyEnv],
    keyEnv: provider.keyEnv,
    url: env[provider.urlEnv] || provider.defaultUrl,
    model: override || provider.model,
    routing: provider.routing || null,
    reasoning: provider.reasoning || null,
    timeoutMs: provider.timeoutMs,
    refused: null,
  };
  if (override && FORBIDDEN_MODEL.test(override)) {
    cfg.refused = `${provider.modelEnv} names a Llama-family model, which policy forbids`;
  } else if (override && !override.endsWith(FREE_SUFFIX)) {
    cfg.refused = `${provider.modelEnv} names a paid model; only ${FREE_SUFFIX} variants are allowed`;
  }
  return cfg;
}

/* `deadlineMs` is what the SEARCH has left; the entry's own timeoutMs stays the
   ceiling. The tighter of the two wins, so a hop late in the budget is cut
   before the function itself is. */
async function askProvider(cfg, messages, doFetch, deadlineMs) {
  const ms = typeof deadlineMs === 'number' && deadlineMs > 0
    ? Math.min(deadlineMs, cfg.timeoutMs)
    : cfg.timeoutMs;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const response = await doFetch(cfg.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.key}`,
      },
      body: JSON.stringify(Object.assign({
        model: cfg.model,
        temperature: 0,
        // Counts reasoning tokens too. 900 truncated pretty-printed answers
        // whose ids are long code URLs; 2000 leaves room for 8 such rows
        // plus a short think, and a fast upstream emits it in well under 2s.
        max_tokens: 2000,
        stream: false,
        messages,
      }, cfg.routing ? { provider: cfg.routing } : {},
         cfg.reasoning ? { reasoning: cfg.reasoning } : {})),
      signal: ctrl.signal,
    });
    if (!response || !response.ok) {
      let detail = '';
      try { detail = String(await response.text()).slice(0, 200); } catch (e) { /* body gone */ }
      const status = response ? response.status : 0;
      const err = new Error(`HTTP ${response ? status : '?'}${detail ? `: ${detail}` : ''}`);
      // Carried so `exhausted` is decided on the upstream's own status rather
      // than by reading our own error strings back.
      err.status = status;
      throw err;
    }
    const doc = await response.json();
    const choice = doc && Array.isArray(doc.choices) ? doc.choices[0] : null;
    const content = choice && choice.message ? choice.message.content : null;
    const parsed = parseModelJson(content);
    if (!parsed) {
      const finish = choice && choice.finish_reason ? choice.finish_reason : '?';
      // Quote the head of what came back: without it a parse failure is
      // indistinguishable from an empty answer, a refusal, or a wrapper the
      // parser does not know. It is the model's reply to the caller's own
      // query, capped, so nothing sensitive is being surfaced.
      const head = JSON.stringify(String(content == null ? '' : content).slice(0, 120));
      const err = new Error(`answer was not the requested strict JSON (finish: ${finish}, head: ${head})`);
      // The ONE failure a re-ask of the same model fixes — measured: the same
      // request garbles or comes back empty once and answers cleanly the next
      // time. askHop reads this flag to decide whether a retry is worth a call.
      err.parseFailure = true;
      throw err;
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- the walk --

/* One search: hop 1 always, hop 2 when the keyword list was short, hop 1 opened
   a repository, a call is left and the clock allows it. Returns either
   {ok: true, …the 200 body…} or {ok: false, providers, exhausted} for the 502.
   `failures` comes back on the success shape too — not part of the HTTP
   contract, but what the clock tests read to see which deadline was armed. */
async function runSearch(ask, ctx, cfgs, doFetch, now) {
  const clock = typeof now === 'function' ? now : Date.now;
  const t0 = clock();
  const remaining = () => SEARCH_BUDGET_MS - (clock() - t0);
  const failures = [];
  const quota = [];
  let calls = 0;
  let promptChars = 0;

  /* One hop, up to three attempts and never more than the search has calls for:
       primary → (primary again, ONLY after a parse or empty failure) → nano.
     The retry is the 2026-09-05 measurement made into a rule. The same request,
     sent three times, garbled once and came back empty once — the free serving
     is non-deterministic, and a re-ask of the SAME model is the cheapest fix
     for that. Everything else is not: a timeout means the model is slow (a
     second deadline of its own would only spend the budget), an HTTP error
     means the upstream is unhappy, and a 429 means the quota is gone — all
     three go straight to the other entry, which is a different model.
     Each attempt is its own entry in `failures`, numbered, so a 502 shows the
     ladder that was actually walked rather than a collapsed one-per-entry. */
  async function askHop(hop, messages) {
    const chars = messages.reduce((n, m) => n + m.content.length, 0);
    const queue = cfgs.map((cfg) => ({ cfg, attempt: 1 }));
    let retried = false;                        // at most one re-ask per hop
    while (queue.length) {
      const { cfg, attempt } = queue.shift();
      if (calls >= MAX_MODEL_CALLS) break;
      const left = remaining();
      if (left < MIN_HOP_MS) break;
      if (!cfg.key) {
        failures.push({ provider: cfg.name, hop, attempt, reason: `no key: ${cfg.keyEnv} is not set` });
        quota.push(false);
        continue;
      }
      if (cfg.refused) {
        failures.push({ provider: cfg.name, hop, attempt, reason: cfg.refused });
        quota.push(false);
        continue;
      }
      const deadlineMs = Math.min(cfg.timeoutMs, left);
      calls += 1;
      promptChars += chars;
      try {
        return { doc: await askProvider(cfg, messages, doFetch, deadlineMs), cfg };
      } catch (e) {
        // The reason is the upstream's own words; a key never appears in it
        // because the key only ever travels in an Authorization header.
        const reason = e && e.name === 'AbortError'
          ? `timed out after ${deadlineMs}ms`
          : String((e && e.message) || e).slice(0, 200);
        failures.push({ provider: cfg.name, hop, attempt, reason });
        quota.push(Boolean(e) && e.status === 429);
        if (!retried && cfg === cfgs[0] && e && e.parseFailure) {
          retried = true;
          queue.unshift({ cfg, attempt: attempt + 1 });   // ahead of the fallback
        }
      }
    }
    return null;
  }

  const walk = ask.candidates.length < WALK_THRESHOLD;
  const hop1 = await askHop(1, buildHop1Messages(ask, ctx.catalog(), walk));
  if (!hop1) {
    return {
      ok: false,
      providers: failures,
      // True only when EVERY failure was an upstream 429 — the client shows a
      // quota notice for that and a plain unreachable notice for anything else.
      exhausted: quota.length > 0 && quota.every(Boolean),
    };
  }

  let answered = hop1.cfg;
  // Reported on the 200 so the bench can count how often the salvage carried a
  // search that would otherwise have cost a second call or a 502.
  let salvaged = Boolean(hop1.doc.salvaged);
  const hits1 = validateHits(hop1.doc.hits, ctx);
  const open = walk ? validateOpen(hop1.doc.open, ctx) : [];
  let hops = 1;
  let hop2ok = false;
  let final = hits1;

  if (open.length && calls < MAX_MODEL_CALLS && remaining() >= MIN_HOP_MS) {
    hops = 2;                                   // ATTEMPTED, not necessarily won
    const hop2 = await askHop(2, buildHop2Messages(ask, hits1, open, ctx));
    if (hop2) {
      const hits2 = validateHits(hop2.doc.hits, ctx);
      // Hop 2 is additive and re-ordering, never subtractive: an empty answer
      // is a FAILED walk (nano answers empty on ~6 queries in 15), not a
      // finding that the survey was wrong.
      if (hits2.length) {
        hop2ok = true;
        answered = hop2.cfg;
        if (hop2.doc.salvaged) salvaged = true;
        const seen = new Set();
        final = [];
        for (const hit of hits2.concat(hits1)) {
          if (seen.has(hit.id)) continue;
          seen.add(hit.id);
          final.push(hit);
        }
      }
    }
  }

  return {
    ok: true,
    results: orderPicks(resolveHits(final, ctx), ctx.candidateIds),
    provider: answered.name,
    model: answered.model,
    promptChars,
    calls,
    hops,
    partial: Boolean(open.length) && !hop2ok,
    salvaged,
    ms: Math.max(0, clock() - t0),
    failures,
  };
}

// ----------------------------------------------------------------- handler --

async function handle(req, res, deps) {
  const env = deps.env || process.env;     // keys come from the environment only
  const doFetch = deps.fetch || ((url, init) => fetch(url, init));
  const dataDir = deps.dataDir || DEFAULT_DATA_DIR;
  const siteDir = deps.siteDir || DEFAULT_SITE_DIR;
  // The budget's clock only. The rate limiter keeps wall time on purpose: a
  // test that drives the budget must not also move the abuse window.
  const now = deps.now || Date.now;

  // Every rejection below happens before the body is read. The body is left
  // unread on purpose (reading it is what the gates are saving), so each of
  // these answers carries `connection: close`: the client may not reuse a
  // socket whose request was never consumed.
  const CLOSE = { connection: 'close' };

  if (req.method !== 'POST') {
    send(res, 405, { error: 'method not allowed — POST a JSON body' },
      Object.assign({ allow: 'POST' }, CLOSE));
    return;
  }

  // Both gates run before the body is even read, so a refused request costs
  // nothing but a socket — and never a provider call.
  if (!originAllowed(req)) {
    send(res, 403, { error: 'cross-origin requests are not accepted' }, CLOSE);
    return;
  }
  const who = clientKey(req);
  const verdict = (deps.limiter || defaultLimiter)
    .check(who.key, Date.now(), !isHosted() && !who.proxied && isLoopback(who.key));
  if (!verdict.ok) {
    send(res, 429, { error: 'too many requests — the librarian is rate limited' },
      Object.assign({ 'retry-after': String(verdict.retryAfter) }, CLOSE));
    return;
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    send(res, e.httpCode || 400, { error: e.message || 'could not read the request body' },
      e.httpCode === 413 ? { connection: 'close' } : undefined);
    return;
  }

  const parsed = parseAsk(raw);
  if (parsed.error) {
    send(res, 400, { error: parsed.error });
    return;
  }
  const ask = parsed.ask;

  const ctx = createContext({
    dataDir,
    siteDir,
    candidateIds: ask.candidates.map((c) => c.id),
  });
  try {
    ctx.catalog();                       // fail loudly, and early, on a bad bundle
  } catch (e) {
    send(res, e.httpCode || 500, { error: e.message });
    return;
  }

  const order = ask.pinned
    ? PROVIDERS.filter((p) => p.name === ask.pinned)
    : PROVIDERS;                          // primary first, then one fallback
  const cfgs = order.map((p) => providerConfig(p, env));

  let outcome;
  try {
    outcome = await runSearch(ask, ctx, cfgs, doFetch, now);
  } catch (e) {
    send(res, e.httpCode || 500, { error: String((e && e.message) || e) });
    return;
  }

  if (!outcome.ok) {
    send(res, 502, {
      error: 'every librarian provider failed — the client falls back to the local index',
      providers: outcome.providers,
      exhausted: outcome.exhausted,
    });
    return;
  }

  const body = {
    results: outcome.results,
    provider: outcome.provider,
    model: outcome.model,
    promptChars: outcome.promptChars,
    // echoed so tools/bench_librarian.mjs can MEASURE it over HTTP rather
    // than take the handler's word for it; it is not settable by a client.
    temperature: 0,
    calls: outcome.calls,
    hops: outcome.hops,
    ms: outcome.ms,
    partial: outcome.partial,
  };
  // Optional, and present only when true: the ordinary answer shape is unchanged.
  if (outcome.salvaged) body.salvaged = true;
  send(res, 200, body);
}

module.exports = (req, res, deps) => handle(req, res, deps || {});
// exported for tools/tests/test_librarian_handler.mjs only
module.exports.buildCatalog = buildCatalog;
module.exports.createContext = createContext;
module.exports.resolveHits = resolveHits;
module.exports.validateHits = validateHits;
module.exports.validateOpen = validateOpen;
module.exports.orderPicks = orderPicks;
module.exports.runSearch = runSearch;
module.exports.providerConfig = providerConfig;
module.exports.createLimiter = createLimiter;
module.exports.defaultLimiter = defaultLimiter;
module.exports.originAllowed = originAllowed;
module.exports.clientKey = clientKey;
module.exports.parseModelJson = parseModelJson;
module.exports.ghUrl = ghUrl;
module.exports.PROVIDERS = PROVIDERS;
module.exports.LIBRARIAN_VERSION = LIBRARIAN_VERSION;
module.exports.FUNCTION_MAX_DURATION_MS = FUNCTION_MAX_DURATION_MS;
module.exports.TIMEOUT_SLACK_MS = TIMEOUT_SLACK_MS;
module.exports.SEARCH_BUDGET_MS = SEARCH_BUDGET_MS;
module.exports.MAX_MODEL_CALLS = MAX_MODEL_CALLS;
module.exports.MIN_HOP_MS = MIN_HOP_MS;
module.exports.WALK_THRESHOLD = WALK_THRESHOLD;
module.exports.MAX_PICKS = MAX_PICKS;
module.exports.MAX_OPEN_REPOS = MAX_OPEN_REPOS;
module.exports.CATALOG_MAX_CHARS = CATALOG_MAX_CHARS;
module.exports.HOP1_MESSAGE_MAX_CHARS = HOP1_MESSAGE_MAX_CHARS;
module.exports.HOP2_MAX_CHARS = HOP2_MAX_CHARS;
