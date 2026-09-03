/* The librarian: a serverless semantic re-rank of what js/search.js already
   found locally. It never searches — it only reorders a candidate list the
   browser hands it, using a compact catalog of the site read from its own
   deployment bundle.

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
     out  200  {"results":[{"id","why"},...], "provider", "model", "promptChars",
                "temperature"}
          400  malformed request      500  catalog missing from the bundle
          405  wrong method           502  every provider failed

   Keys live in the environment and nowhere else. They are never logged, never
   written to a file, and never put into a prompt. */
'use strict';

const fs = require('fs');
const path = require('path');

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
const ONE_LINER_CHARS = 140;
// ~5s per provider, primary + one fallback, comfortably inside the function's
// maxDuration: 15 (vercel.json) and inside the client's 18s abort deadline.
const PROVIDER_TIMEOUT_MS = 5000;

const PROVIDERS = [
  {
    name: 'groq',
    keyEnv: 'GROQ_API_KEY',
    urlEnv: 'LIBRARIAN_GROQ_URL',
    defaultUrl: 'https://api.groq.com/openai/v1/chat/completions',
    // POLICY, NOT BENCHMARK: a Llama-family model is forbidden here — at any
    // tier, in any role, fallback included. That is a standing rule, so the
    // model id is deliberately NOT environment-overridable: an env var would be
    // a way to put a Llama model back in without anyone reviewing it.
    model: 'openai/gpt-oss-120b',
    modelEnv: null,
  },
  {
    name: 'nvidia',
    keyEnv: 'NVIDIA_API_KEY',
    urlEnv: 'LIBRARIAN_NIM_URL',
    defaultUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
    // Nemotron 3 Super, NVIDIA's hosted NIM id as published on
    // build.nvidia.com/nvidia/nemotron-3-super-120b-a12b. Confirm it against
    // GET https://integrate.api.nvidia.com/v1/models once a key exists — the id
    // was read from NVIDIA's own API example, not from a live models call.
    // Nemotron 3 is a hybrid Mamba-Transformer MoE, not a Llama derivative, so
    // it satisfies the same policy constraint that rules Groq's model choice.
    model: 'nvidia/nemotron-3-super-120b-a12b',
    modelEnv: 'LIBRARIAN_NIM_MODEL',
  },
];
const PROVIDER_NAMES = PROVIDERS.map((p) => p.name);

const SYSTEM_PROMPT = [
  'You are the librarian for a robotics lab\'s documentation site.',
  'You are given a search query, a list of CANDIDATES that a local keyword index',
  'already found, and a compact CATALOG of the site for context.',
  '',
  'Pick the candidates that actually answer the query and order them best first.',
  'Rules:',
  '- choose ONLY from the given candidate ids; never invent an id;',
  '- pick at most ' + MAX_PICKS + ', and fewer when fewer are relevant;',
  '- "why" is one short clause, at most 12 words, saying why it fits;',
  '- reply with STRICT JSON and nothing else, in exactly this shape:',
  '  {"results":[{"id":"<candidate id>","why":"<short reason>"}]}',
].join('\n');

// ------------------------------------------------------- abuse protection --

/* WHAT THIS BUYS, HONESTLY. This endpoint is public and every call it accepts
   spends real provider quota — and a call that forces the fallback spends two.
   The two gates below raise the cost of abusing that. They are NOT
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
const RATE_MAX_PER_KEY = 12;      // one browser, one minute
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
    const chunks = [];
    req.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        const e = new Error(`request body over ${MAX_BODY_BYTES} bytes`);
        e.httpCode = 413;
        reject(e);
        if (typeof req.destroy === 'function') req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/* Strict read of the client payload. Returns {ask} or {error}. */
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
  if (!Array.isArray(doc.candidates) || !doc.candidates.length) {
    return { error: 'candidates must be a non-empty array' };
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
  if (!candidates.length) {
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

// ----------------------------------------------------------------- catalog --

const catalogCache = new Map();

function oneLiner(text) {
  const flat = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (flat.length <= ONE_LINER_CHARS) return flat;
  return `${flat.slice(0, ONE_LINER_CHARS - 1).trimEnd()}…`;
}

function readJsonFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    const err = new Error(`catalog file missing from the bundle: ${file} (${e.code || e.message})`);
    err.httpCode = 500;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    const err = new Error(`catalog file is not valid JSON: ${file} (${e.message})`);
    err.httpCode = 500;
    throw err;
  }
}

/* A COMPACT catalog — titles, kinds and one-liners, never the full summaries.
   Read with readFileSync from this function's own bundle (vercel.json ships
   data/graph/** via includeFiles); the function never fetches its own site. */
function buildCatalog(dir) {
  const cached = catalogCache.get(dir);
  if (cached) return cached;
  const wiki = readJsonFile(path.join(dir, 'wiki.json'));
  const repos = readJsonFile(path.join(dir, 'repos-index.json'));
  const rows = [];
  for (const node of (Array.isArray(wiki.nodes) ? wiki.nodes : [])) {
    if (!node || node.kind === 'repo') continue;   // repos come from repos-index
    rows.push({
      title: String(node.title || ''),
      kind: String(node.kind || ''),
      where: String(node.route || node.where || ''),
      about: oneLiner(node.summary),
    });
  }
  for (const repo of (Array.isArray(repos.repos) ? repos.repos : [])) {
    if (!repo) continue;
    rows.push({
      title: String(repo.name || ''),
      kind: repo.fork ? 'fork' : 'repo',
      where: String(repo.project || ''),
      about: oneLiner(repo.oneliner),
    });
  }
  catalogCache.set(dir, rows);
  return rows;
}

// ------------------------------------------------------------------ prompt --

function buildMessages(ask, catalog) {
  const user = JSON.stringify({
    query: ask.q,
    candidates: ask.candidates,
    catalog,
  });
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/* Models wrap JSON in fences and reasoning models prepend a think block; strip
   both, then parse strictly. Anything that still will not parse counts as a
   provider failure, so the other provider gets its turn. */
function parseModelJson(content) {
  let text = String(content == null ? '' : content).trim();
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  if (!text) return null;
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return null;
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.results)) return null;
  return doc.results;
}

/* Keep only rows whose id was actually offered, dedupe, cap at MAX_PICKS. */
function validatePicks(rows, candidates) {
  const known = new Set(candidates.map((c) => c.id));
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = row.id;
    if (typeof id !== 'string' || !known.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, why: oneLiner(row.why).slice(0, 120) });
    if (out.length >= MAX_PICKS) break;
  }
  return out;
}

// --------------------------------------------------------------- providers --

function providerConfig(provider, env) {
  return {
    name: provider.name,
    key: env[provider.keyEnv],
    keyEnv: provider.keyEnv,
    url: env[provider.urlEnv] || provider.defaultUrl,
    model: (provider.modelEnv && env[provider.modelEnv]) || provider.model,
  };
}

async function askProvider(cfg, messages, doFetch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const response = await doFetch(cfg.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.key}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        max_tokens: 900,
        stream: false,
        messages,
      }),
      signal: ctrl.signal,
    });
    if (!response || !response.ok) {
      let detail = '';
      try { detail = String(await response.text()).slice(0, 200); } catch (e) { /* body gone */ }
      throw new Error(`HTTP ${response ? response.status : '?'}${detail ? `: ${detail}` : ''}`);
    }
    const doc = await response.json();
    const choice = doc && Array.isArray(doc.choices) ? doc.choices[0] : null;
    const content = choice && choice.message ? choice.message.content : null;
    const rows = parseModelJson(content);
    if (!rows) throw new Error('answer was not the requested strict JSON');
    return rows;
  } finally {
    clearTimeout(timer);
  }
}

// ----------------------------------------------------------------- handler --

async function handle(req, res, deps) {
  const env = deps.env || process.env;     // keys come from the environment only
  const doFetch = deps.fetch || ((url, init) => fetch(url, init));
  const dataDir = deps.dataDir || path.join(__dirname, '..', 'data', 'graph');

  if (req.method !== 'POST') {
    send(res, 405, { error: 'method not allowed — POST a JSON body' }, { allow: 'POST' });
    return;
  }

  // Both gates run before the body is even read, so a refused request costs
  // nothing but a socket — and never a provider call.
  if (!originAllowed(req)) {
    send(res, 403, { error: 'cross-origin requests are not accepted' });
    return;
  }
  const who = clientKey(req);
  const verdict = (deps.limiter || defaultLimiter)
    .check(who.key, Date.now(), !isHosted() && !who.proxied && isLoopback(who.key));
  if (!verdict.ok) {
    send(res, 429, { error: 'too many requests — the librarian is rate limited' },
      { 'retry-after': String(verdict.retryAfter) });
    return;
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    send(res, e.httpCode || 400, { error: e.message || 'could not read the request body' });
    return;
  }

  const parsed = parseAsk(raw);
  if (parsed.error) {
    send(res, 400, { error: parsed.error });
    return;
  }
  const ask = parsed.ask;

  let catalog;
  try {
    catalog = buildCatalog(dataDir);
  } catch (e) {
    send(res, e.httpCode || 500, { error: e.message });
    return;
  }

  const messages = buildMessages(ask, catalog);
  const promptChars = messages.reduce((n, m) => n + m.content.length, 0);

  const order = ask.pinned
    ? PROVIDERS.filter((p) => p.name === ask.pinned)
    : PROVIDERS;                            // primary first, then one fallback
  const failures = [];
  for (const provider of order) {
    const cfg = providerConfig(provider, env);
    if (!cfg.key) {
      failures.push({ provider: cfg.name, reason: `no key: ${cfg.keyEnv} is not set` });
      continue;
    }
    try {
      const rows = await askProvider(cfg, messages, doFetch);
      send(res, 200, {
        results: validatePicks(rows, ask.candidates),
        provider: cfg.name,
        model: cfg.model,
        promptChars,
        // echoed so tools/bench_librarian.mjs can MEASURE it over HTTP rather
        // than take the handler's word for it; it is not settable by a client.
        temperature: 0,
      });
      return;
    } catch (e) {
      // The reason is the upstream's own words; a key never appears in it
      // because the key only ever travels in an Authorization header.
      const reason = e && e.name === 'AbortError'
        ? `timed out after ${PROVIDER_TIMEOUT_MS}ms`
        : String((e && e.message) || e).slice(0, 200);
      failures.push({ provider: cfg.name, reason });
    }
  }

  send(res, 502, {
    error: 'every librarian provider failed — the client falls back to the local index',
    providers: failures,
  });
}

module.exports = (req, res, deps) => handle(req, res, deps || {});
// exported for tools/tests/test_librarian_handler.mjs only
module.exports.buildCatalog = buildCatalog;
module.exports.createLimiter = createLimiter;
module.exports.defaultLimiter = defaultLimiter;
module.exports.originAllowed = originAllowed;
module.exports.clientKey = clientKey;
module.exports.parseModelJson = parseModelJson;
module.exports.validatePicks = validatePicks;
module.exports.PROVIDERS = PROVIDERS;
