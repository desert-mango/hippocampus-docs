#!/usr/bin/env node
// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 21 September 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Serve static pages and every api/ function locally, with deterministic librarian mocks.
/* dev_site — the ONE local server that serves this site exactly the way Vercel
   does: static files from the repo root, plus EVERY api/<name>.js run as a real
   function on the raw request and response at /api/<name> (today
   api/librarian.js and api/auth.js — a new function file is picked up with no
   edit here).

     node tools/dev_site.mjs                        # static + every function present
     node tools/dev_site.mjs --port 8140
     node tools/dev_site.mjs --dotenv path/to/file   # instead of ./.env.local
     node tools/dev_site.mjs --mock-provider=echo   # a fake LLM that echoes candidates
     node tools/dev_site.mjs --mock-provider=adversarial
     node tools/dev_site.mjs --mock-provider=graph  # the walk, keyless and deterministic
     node tools/dev_site.mjs --mock-provider=quota  # every call 429s (the exhausted drill)
     node tools/dev_site.mjs --mock-provider=graph --mock-delay=800

   tools/serve.sh (port 8130, plain python http.server) is untouched and stays
   the documented static preview. This is its function-aware sibling on 8131.

   WHAT THE MOCKS ARE FOR, AND WHAT THEY ARE NOT. `graph` answers both hops of
   the real two-hop contract by TOKEN OVERLAP — it reads the hop-1 catalog and
   the hop-2 repository briefs the handler actually built and picks ids whose
   title, one-liner or id shares a word with the query. That proves the
   PLUMBING end to end with zero quota: ids, server-side resolution, the
   ordering rule, the client merge, the render, the waiting and notice states.
   It proves NOTHING about ranking quality, and no report may present it as
   evidence of any. Every `why` it emits is the literal string `mock provider`,
   so a real answer can never be mistaken for one of its own.

   Two rules keep this honest:

     1. The handler is loaded LAZILY and its absence is not an error. The
        GitHub Pages copy of this site ships with no api/ directory at all, so
        everything here has to work in that checkout too — you get static files
        and a 404 on the function's path, which is what Pages itself does.
     2. Nothing is shimmed. The request and response objects go into the handler
        untouched, so a handler that reaches for a Vercel-injected convenience
        breaks here, loudly, instead of in production.

   ENVIRONMENT. On Vercel the functions read their keys and App credentials
   from the project's environment. Here they come from `.env.local` at the
   repo root when that file exists (`.env*` is gitignored — never commit one):
   plain `KEY=VALUE` lines, `#` comments, optional quotes around the value, an
   optional leading `export`. A variable already set in the shell wins over the
   file. Only a COUNT is ever printed — never a name's value. The CMS sign-in
   (api/auth.js) needs GH_APP_CLIENT_ID and GH_APP_CLIENT_SECRET there, and the
   App's second callback URL is http://localhost:8131/cms/callback.html — so
   open the site as http://localhost:8131, the port this server defaults to.

   No dependencies, node stdlib only. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const DEFAULT_PORT = 8131;
const API_DIR = path.join(ROOT, 'api');
const API_ROUTE_RE = /^\/api\/([a-z0-9][a-z0-9_-]*)$/;   // one plain name, no dots, no slashes
const API_FILE_RE = /^([a-z0-9][a-z0-9_-]*)\.js$/;
const DEFAULT_ENV_FILE = path.join(ROOT, '.env.local');
const MOCK_ROUTE = '/__mock/v1/chat/completions';
const MOCK_MODES = ['echo', 'adversarial', 'graph', 'quota'];
const MAX_HITS = 8;         // the handler's MAX_PICKS; it caps anyway, we stay inside it
const MAX_OPEN = 3;         // the handler's MAX_OPEN_REPOS
const MAX_HOP2_SYMS = 2;    // "at most 2 code-level hits per repository" (the hop-2 prompt)
const MOCK_WHY = 'mock provider';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.stl': 'application/octet-stream',
  '.3mf': 'application/octet-stream',
  '.pdf': 'application/pdf',
};

// ------------------------------------------------------------------- args ---

const USAGE = 'usage: node tools/dev_site.mjs [--port N] [--dotenv PATH] '
  + `[--mock-provider=${MOCK_MODES.join('|')}] [--mock-delay=<ms>]\n`
  + '  --dotenv         KEY=VALUE file loaded at startup (default: .env.local at the repo root,\n'
  + '                   skipped silently when absent). Values are never printed.\n'
  + '  --mock-provider  echo/adversarial re-rank the candidates; graph answers both hops\n'
  + '                   of the walk by token overlap; quota 429s every call.\n'
  + '  --mock-delay     milliseconds the mock waits before answering EACH call (default 0).\n'
  + '                   It only means something with a mock, so it is refused without one.\n';

function parseArgs(argv) {
  const out = { port: DEFAULT_PORT, mock: null, mockDelay: null, envFile: DEFAULT_ENV_FILE };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    let m = arg.match(/^--port(?:=(.*))?$/);
    if (m) {
      const value = m[1] !== undefined ? m[1] : argv[++i];
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`--port needs a port number, got ${JSON.stringify(value)}`);
      }
      out.port = port;
      continue;
    }
    m = arg.match(/^--dotenv(?:=(.*))?$/);
    if (m) {
      const value = m[1] !== undefined ? m[1] : argv[++i];
      // Not "--env-file": node itself claims that flag even after the script
      // name and exits before this file runs.
      if (!value) throw new Error('--dotenv needs a path');
      out.envFile = path.resolve(value);
      continue;
    }
    m = arg.match(/^--mock-provider(?:=(.*))?$/);
    if (m) {
      const value = m[1] !== undefined ? m[1] : argv[++i];
      if (MOCK_MODES.indexOf(value) === -1) {
        throw new Error(`--mock-provider must be one of ${MOCK_MODES.join('|')}, got ${JSON.stringify(value)}`);
      }
      out.mock = value;
      continue;
    }
    m = arg.match(/^--mock-delay(?:=(.*))?$/);
    if (m) {
      const value = m[1] !== undefined ? m[1] : argv[++i];
      const ms = Number(value);
      if (!Number.isFinite(ms) || ms < 0) {
        throw new Error(`--mock-delay must be a non-negative number of milliseconds, got ${JSON.stringify(value)}`);
      }
      out.mockDelay = ms;
      continue;
    }
    throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  // A delay with nothing to delay is a typo, not a slow real provider: this
  // server never sits between the handler and OpenRouter, so the flag can only
  // ever slow the mock down. Refusing it loudly beats pretending it worked.
  if (out.mockDelay !== null && !out.mock) {
    throw new Error('--mock-delay needs --mock-provider: there is nothing to delay without a mock');
  }
  return out;
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`${e.message}\n${USAGE}`);
  process.exit(1);
}
if (args.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
const MOCK_DELAY_MS = args.mockDelay || 0;

// ------------------------------------------------------------ environment ---

/* Loads a KEY=VALUE file into process.env BEFORE any handler is imported.
   Returns null when the file does not exist, else counts only. A line that is
   not KEY=VALUE is skipped and counted, never echoed (it might hold a value). */
function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw new Error(`cannot read ${file}: ${e && e.code ? e.code : 'read failed'}`);
  }
  const counts = { loaded: 0, kept: 0, skipped: 0 };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) { counts.skipped += 1; continue; }
    let value = m[2];
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] !== undefined) { counts.kept += 1; continue; }   // the shell wins
    process.env[m[1]] = value;
    counts.loaded += 1;
  }
  return counts;
}

let envCounts = null;
try {
  envCounts = loadEnvFile(args.envFile);
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
}

// -------------------------------------------------------------- json reply ---

function sendJson(res, code, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

// ------------------------------------------------------- the provider mock ---

/* An OpenAI-compatible chat-completions endpoint hosted by this same server.
   It reads the payload the real handler built — the hop-1 catalog, the hop-2
   repository briefs — so the handler runs completely unmodified against it. */
let mockCalls = 0;

/* The last user message is the JSON payload the handler serialised. Hop 1 and
   hop 2 are told apart by their KEYS rather than by the system prompt's
   wording: `catalog` only ever appears in hop 1 and `repos`/`neighbours` only
   in hop 2, so a re-worded prompt cannot silently send both hops down the same
   branch. */
function askPayload(payload) {
  const messages = (payload && Array.isArray(payload.messages)) ? payload.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    try {
      const doc = JSON.parse(m.content);
      if (doc && typeof doc === 'object') return doc;
    } catch (e) { /* not the JSON payload message */ }
  }
  return null;
}

function hopOf(doc) {
  if (!doc) return 0;
  if (Array.isArray(doc.catalog)) return 1;
  if (Array.isArray(doc.repos) || Array.isArray(doc.neighbours)) return 2;
  return 0;
}

/* js/search.js's tokeniser, third copy (the client, the function, here). The
   mock has to split words the way the engine does or "overlap" would mean
   something different on each side of the wire. */
function tokensOf(value) {
  return String(value == null ? '' : value)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/* How many DISTINCT query terms a piece of text covers, by whole token or by
   token prefix — the same "is this word in there" test the engine uses. */
function covers(text, terms) {
  if (!terms.length) return 0;
  const words = tokensOf(text);
  if (!words.length) return 0;
  let n = 0;
  for (const t of terms) {
    if (words.some((w) => w === t || w.startsWith(t))) n += 1;
  }
  return n;
}

/* HOP 1. Score every catalog row by how much of the query its title, its
   one-liner and its own id cover, keep the rows that cover anything at all,
   best first (ties keep catalog order — Array#sort is stable, so the answer is
   the same on every run), and open the non-fork repositories among them.

   `open` is sent whenever repositories are hit, INCLUDING when walk is false:
   the handler is the thing that decides, and letting it drop the list exercises
   that guard instead of hiding it. */
function hop1Answer(doc) {
  const terms = tokensOf(doc.query).slice(0, 8);
  const rows = Array.isArray(doc.catalog) ? doc.catalog : [];
  const scored = [];
  rows.forEach((row) => {
    if (!row || typeof row.id !== 'string') return;
    const score = covers(`${row.title || ''} ${row.about || ''} ${row.id}`, terms);
    if (score > 0) scored.push({ row, score });
  });
  scored.sort((a, b) => b.score - a.score);
  const hits = scored.slice(0, MAX_HITS).map((s) => ({ id: s.row.id, why: MOCK_WHY }));
  const open = [];
  for (const s of scored.slice(0, MAX_HITS)) {
    if (open.length >= MAX_OPEN) break;
    // `repo` is the catalog's non-fork kind; forks are kind `fork` and the
    // handler refuses to open them anyway.
    if (s.row.kind === 'repo' && s.row.id.startsWith('repo:')) open.push(s.row.id.slice(5));
  }
  return { hits, open };
}

/* HOP 2. Keep everything hop 1 found (the walk is additive, never subtractive)
   and add at most two code-level ids for symbols whose LABEL shares a query
   term — `matches` first, because the handler already filtered those by the
   query, then the shard's god nodes. */
function hop2Answer(doc) {
  const terms = tokensOf(doc.query).slice(0, 8);
  const repos = Array.isArray(doc.repos) ? doc.repos : [];
  const syms = [];
  const seen = new Set();
  const add = (repo, label, filePath) => {
    if (syms.length >= MAX_HOP2_SYMS) return;
    if (!repo || !label || !filePath) return;
    if (!covers(label, terms)) return;
    const id = `sym:${repo}:${filePath}:${label}`;
    if (seen.has(id)) return;
    seen.add(id);
    syms.push({ id, why: MOCK_WHY });
  };
  for (const repo of repos) {
    if (!repo || typeof repo.name !== 'string') continue;
    for (const m of (Array.isArray(repo.matches) ? repo.matches : [])) {
      if (Array.isArray(m)) add(repo.name, String(m[0] || ''), String(m[1] || ''));
    }
  }
  for (const repo of repos) {
    if (!repo || typeof repo.name !== 'string') continue;
    for (const g of (Array.isArray(repo.symbols) ? repo.symbols : [])) {
      if (g && g.kind !== 'file') add(repo.name, String(g.name || ''), String(g.path || ''));
    }
  }
  const kept = (Array.isArray(doc.hits) ? doc.hits : [])
    .filter((h) => h && typeof h.id === 'string')
    .slice(0, MAX_HITS - syms.length)
    .map((h) => ({ id: h.id, why: MOCK_WHY }));
  // Pages and repositories that answer directly stay ahead of the symbols
  // inside them, exactly as the hop-2 prompt asks a real model to rank them.
  return { hits: kept.concat(syms) };
}

function mockCompletion(answer) {
  const content = JSON.stringify(answer);
  return {
    // Counter, not a clock: two identical runs produce two identical bodies.
    id: `mock-${mockCalls}`,
    object: 'chat.completion',
    model: 'mock/dev-site',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function serveMock(req, res, mode) {
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }); return; }
  mockCalls += 1;
  // Read the body FIRST — the socket has to be drained whatever we answer — and
  // only then spend the artificial latency, so --mock-delay measures the
  // handler's own deadline arithmetic rather than the time it took to upload.
  let payload = null;
  try { payload = JSON.parse(await readBody(req)); } catch (e) { payload = null; }
  if (MOCK_DELAY_MS) await sleep(MOCK_DELAY_MS);

  // The exhausted drill. Both provider URLs point here, so both entries fail
  // the same way and the handler's 502 carries exhausted: true — which is the
  // only thing that makes the client show the quota notice rather than the
  // "unreachable" one.
  if (mode === 'quota') {
    sendJson(res, 429, { error: {
      message: `mock ${mode}: free daily allowance spent (call #${mockCalls})`,
      type: 'rate_limit_exceeded', code: 429,
    } });
    return;
  }
  // Deliberate fallback drill: every third call collapses, so the handler's
  // primary/fallback path and the client's notice both get exercised for real.
  if (mode === 'adversarial' && mockCalls % 3 === 0) {
    sendJson(res, 503, { error: { message: `mock ${mode}: scheduled failure #${mockCalls}` } });
    return;
  }

  if (mode === 'graph') {
    const doc = askPayload(payload);
    const hop = hopOf(doc);
    if (hop === 1) { sendJson(res, 200, mockCompletion(hop1Answer(doc))); return; }
    if (hop === 2) { sendJson(res, 200, mockCompletion(hop2Answer(doc))); return; }
    // Neither shape: say so instead of answering something plausible.
    sendJson(res, 400, { error: { message: 'mock graph: the payload is neither hop 1 nor hop 2' } });
    return;
  }

  const doc = askPayload(payload);
  const ids = (doc && Array.isArray(doc.candidates) ? doc.candidates : [])
    .map((c) => c && c.id).filter((id) => typeof id === 'string');
  const hits = (list) => ({ hits: list.slice(0, MAX_HITS).map((id) => ({ id, why: MOCK_WHY })), open: [] });
  if (mode === 'adversarial') {
    // reversed, and led by an id that was never on the candidate list — the
    // client and the handler must both drop it without flinching.
    sendJson(res, 200, mockCompletion(hits(['mock:not-a-real-candidate'].concat(ids.slice().reverse()))));
    return;
  }
  sendJson(res, 200, mockCompletion(hits(ids)));   // echo: in the order received
}

// ------------------------------------------------------------ static files ---

function resolveStatic(urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch (e) {
    return null;
  }
  const full = path.resolve(ROOT, `.${rel.startsWith('/') ? rel : `/${rel}`}`);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;   // no traversal
  let stat;
  try { stat = fs.statSync(full); } catch (e) { return null; }
  if (stat.isDirectory()) {
    const index = path.join(full, 'index.html');
    return fs.existsSync(index) ? index : null;
  }
  return full;
}

function serveStatic(req, res, urlPath) {
  const file = resolveStatic(urlPath);
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`404 ${urlPath}\n`);
    return;
  }
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

// ------------------------------------------------------- the lazy handler ----

/* The mock has to be wired up BEFORE the handler is imported: the handler reads
   its base URL from the environment at request time, but pointing it at a
   server that does not exist yet would be a race worth avoiding.

   BOTH entries are redirected, not just the primary. The handler tries every
   provider in turn on a failing hop, so leaving the nano URL pointing at the
   real gateway meant a keyless drill failed there with "no key is not set" —
   which is NOT an upstream 429, so the 502's `exhausted` came back false and
   the quota drill silently proved the wrong notice. With both mocked, a quota
   run produces exactly two hop-1 failures, both HTTP 429, and exhausted: true. */
if (args.mock) {
  const mockUrl = `http://127.0.0.1:${args.port}${MOCK_ROUTE}`;
  process.env.LIBRARIAN_NEMOTRON_URL = mockUrl;
  process.env.LIBRARIAN_NANO_URL = mockUrl;
  process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'dev-site-mock-not-a-real-key';
}

/* Every api/<name>.js becomes /api/<name>, imported once at startup. A missing
   api/ directory is not an error (the GitHub Pages checkout has none); a file
   that fails to import is reported at startup and its route answers 404,
   exactly like a checkout without it. */
const handlers = new Map();        // name -> function
const handlerErrors = [];          // "api/x.js: message"
let apiFiles = [];
try {
  apiFiles = fs.readdirSync(API_DIR).filter((f) => API_FILE_RE.test(f)).sort();
} catch (e) {
  apiFiles = [];
}
for (const file of apiFiles) {
  const name = file.match(API_FILE_RE)[1];
  try {
    const mod = await import(pathToFileURL(path.join(API_DIR, file)).href);
    const fn = (mod && mod.default) || mod;
    if (typeof fn === 'function') handlers.set(name, fn);
    else handlerErrors.push(`api/${file} does not export a function`);
  } catch (e) {
    handlerErrors.push(`api/${file}: ${String((e && e.message) || e)}`);
  }
}

// ------------------------------------------------------------- the server ----

/* Access logging for the two API routes ONLY — never for static files, which
   a single page load would drown this in. It exists so "how many searches did
   that run make, and how many upstream calls did each one cost" is a fact in
   the log rather than a number the bench reports about itself. */
const apiRequests = new Map();     // name -> POST count

function logWhenDone(res, line) {
  res.on('finish', () => process.stdout.write(`  ${line()} ${res.statusCode}\n`));
}

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];

  const api = urlPath.startsWith('/api/') ? urlPath.match(API_ROUTE_RE) : null;
  if (urlPath.startsWith('/api/')) {
    const name = api ? api[1] : null;
    const route = name ? `/api/${name}` : urlPath;
    // Only a POST is real work, so only a POST takes a number: the librarian's
    // readiness GET reads no body, calls no model and must not inflate the
    // count a bench run is measured by.
    let n = null;
    if (name && req.method === 'POST') {
      n = (apiRequests.get(name) || 0) + 1;
      apiRequests.set(name, n);
    }
    const started = Date.now();
    logWhenDone(res, () => `${req.method} ${route}`
      + `${n === null ? '' : ` #${n}`} ${Date.now() - started}ms →`);
    const fn = name ? handlers.get(name) : null;
    if (!fn) {
      // Exactly what GitHub Pages does with a missing path — and exactly what
      // the search client latches on.
      sendJson(res, 404, { error: `no handler for ${route} in this checkout` });
      return;
    }
    // RAW pass-through. No shim, no body parsing, no helpers bolted on.
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((e) => {
        // The error's name and its stack FRAMES, never its message: a sign-in
        // handler's error text could carry what it was handling.
        const frames = String((e && e.stack) || '').split('\n').slice(1).join('\n');
        process.stderr.write(`api/${name}.js handler threw${e && e.name ? ` (${e.name})` : ''}\n${frames}\n`);
        if (!res.headersSent) sendJson(res, 500, { error: 'handler threw' });
        else res.end();
      });
    return;
  }

  if (args.mock && urlPath === MOCK_ROUTE) {
    const n = mockCalls + 1;
    logWhenDone(res, () => `    mock ${args.mock} call #${n} →`);
    serveMock(req, res, args.mock).catch((e) => {
      if (!res.headersSent) sendJson(res, 500, { error: String((e && e.message) || e) });
    });
    return;
  }

  serveStatic(req, res, urlPath);
});

server.listen(args.port, '127.0.0.1', () => {
  process.stdout.write(`dev_site serving ${ROOT}\n`);
  process.stdout.write(`  http://127.0.0.1:${args.port}/\n`);
  if (handlers.size) {
    process.stdout.write(`  api handlers loaded -> ${[...handlers.keys()].map((n) => `/api/${n}`).join(', ')}\n`);
  } else {
    process.stdout.write('  no api handlers — static only\n');
  }
  for (const err of handlerErrors) process.stdout.write(`  (import failed: ${err})\n`);
  if (envCounts) {
    const rel = path.relative(ROOT, args.envFile) || args.envFile;
    process.stdout.write(`  env: ${envCounts.loaded} variables from ${rel}`
      + `${envCounts.kept ? `, ${envCounts.kept} already set in the shell (kept)` : ''}`
      + `${envCounts.skipped ? `, ${envCounts.skipped} line(s) skipped (not KEY=VALUE)` : ''}`
      + ' — values never printed\n');
  } else {
    process.stdout.write(`  env: no ${path.relative(ROOT, args.envFile) || args.envFile} (functions see the shell environment only)\n`);
  }
  if (args.mock) {
    process.stdout.write(
      `  mock provider: ${args.mock} (BOTH provider base URLs point at ${MOCK_ROUTE})\n`);
    process.stdout.write(MOCK_DELAY_MS
      ? `  mock delay:    ${MOCK_DELAY_MS}ms before every mock answer\n`
      : '  mock delay:    none\n');
    if (args.mock === 'graph') {
      process.stdout.write(
        '  the graph mock proves PLUMBING only — its ranking is token overlap, not meaning\n');
    }
  } else {
    // The real-key gate greps for this exact phrase to prove no mock was in
    // the loop, so the words "mock provider: off" stay where they are.
    process.stdout.write(
      `  mock provider: off (set --mock-provider=${MOCK_MODES.join('|')})\n`);
  }
});
