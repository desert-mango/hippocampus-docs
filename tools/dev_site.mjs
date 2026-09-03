#!/usr/bin/env node
/* dev_site — the ONE local server that serves this site exactly the way Vercel
   does: static files from the repo root, plus api/librarian.js run as a real
   function on the raw request and response.

     node tools/dev_site.mjs                        # static + the function if present
     node tools/dev_site.mjs --port 8140
     node tools/dev_site.mjs --mock-provider=echo   # a fake LLM that echoes candidates
     node tools/dev_site.mjs --mock-provider=adversarial

   tools/serve.sh (port 8130, plain python http.server) is untouched and stays
   the documented static preview. This is its function-aware sibling on 8131.

   Two rules keep this honest:

     1. The handler is loaded LAZILY and its absence is not an error. The
        GitHub Pages copy of this site ships with no api/ directory at all, so
        everything here has to work in that checkout too — you get static files
        and a 404 on the function's path, which is what Pages itself does.
     2. Nothing is shimmed. The request and response objects go into the handler
        untouched, so a handler that reaches for a Vercel-injected convenience
        breaks here, loudly, instead of in production.

   No dependencies, node stdlib only. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const DEFAULT_PORT = 8131;
const LIBRARIAN_ROUTE = '/api/librarian';
const MOCK_ROUTE = '/__mock/v1/chat/completions';
const MOCK_MODES = ['echo', 'adversarial'];

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

function parseArgs(argv) {
  const out = { port: DEFAULT_PORT, mock: null };
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
    m = arg.match(/^--mock-provider(?:=(.*))?$/);
    if (m) {
      const value = m[1] !== undefined ? m[1] : argv[++i];
      if (MOCK_MODES.indexOf(value) === -1) {
        throw new Error(`--mock-provider must be one of ${MOCK_MODES.join('|')}, got ${JSON.stringify(value)}`);
      }
      out.mock = value;
      continue;
    }
    throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(
    'usage: node tools/dev_site.mjs [--port N] [--mock-provider=echo|adversarial]\n');
  process.exit(0);
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
   It reads the candidate ids straight out of the prompt the real handler built,
   so the handler runs completely unmodified against it. */
let mockCalls = 0;

function candidateIdsFromRequest(payload) {
  const messages = (payload && Array.isArray(payload.messages)) ? payload.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    try {
      const doc = JSON.parse(m.content);
      if (doc && Array.isArray(doc.candidates)) {
        return doc.candidates.map((c) => c && c.id).filter((id) => typeof id === 'string');
      }
    } catch (e) { /* not the JSON payload message */ }
  }
  return [];
}

function mockCompletion(ids) {
  const content = JSON.stringify({
    results: ids.slice(0, 8).map((id) => ({ id, why: 'mock provider' })),
  });
  return {
    id: `mock-${Date.now()}`,
    object: 'chat.completion',
    model: 'mock/dev-site',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

async function serveMock(req, res, mode) {
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }); return; }
  mockCalls += 1;
  // Deliberate fallback drill: every third call collapses, so the handler's
  // primary/fallback path and the client's notice both get exercised for real.
  if (mode === 'adversarial' && mockCalls % 3 === 0) {
    sendJson(res, 503, { error: { message: `mock ${mode}: scheduled failure #${mockCalls}` } });
    return;
  }
  let payload = null;
  try { payload = JSON.parse(await readBody(req)); } catch (e) { payload = null; }
  const ids = candidateIdsFromRequest(payload);
  if (mode === 'adversarial') {
    // reversed, and led by an id that was never on the candidate list — the
    // client and the handler must both drop it without flinching.
    sendJson(res, 200, mockCompletion(['mock:not-a-real-candidate'].concat(ids.slice().reverse())));
    return;
  }
  sendJson(res, 200, mockCompletion(ids));   // echo: in the order received
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
   server that does not exist yet would be a race worth avoiding. */
if (args.mock) {
  process.env.LIBRARIAN_GROQ_URL = `http://127.0.0.1:${args.port}${MOCK_ROUTE}`;
  process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'dev-site-mock-not-a-real-key';
}

let librarian = null;
let handlerError = null;
try {
  const target = path.join(ROOT, 'api', 'librarian.js');
  const mod = await import(pathToFileURL(target).href);
  librarian = (mod && mod.default) || mod;
  if (typeof librarian !== 'function') {
    handlerError = 'api/librarian.js does not export a function';
    librarian = null;
  }
} catch (e) {
  librarian = null;
  handlerError = e && e.code === 'ERR_MODULE_NOT_FOUND' ? null : String((e && e.message) || e);
}

// ------------------------------------------------------------- the server ----

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];

  if (urlPath === LIBRARIAN_ROUTE) {
    if (!librarian) {
      // Exactly what GitHub Pages does with a missing path — and exactly what
      // the client latches on.
      sendJson(res, 404, { error: 'no librarian handler in this checkout' });
      return;
    }
    // RAW pass-through. No shim, no body parsing, no helpers bolted on.
    Promise.resolve()
      .then(() => librarian(req, res))
      .catch((e) => {
        process.stderr.write(`librarian handler threw: ${(e && e.stack) || e}\n`);
        if (!res.headersSent) sendJson(res, 500, { error: 'handler threw', detail: String((e && e.message) || e) });
        else res.end();
      });
    return;
  }

  if (args.mock && urlPath === MOCK_ROUTE) {
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
  if (librarian) process.stdout.write(`  librarian handler loaded -> ${LIBRARIAN_ROUTE}\n`);
  else process.stdout.write('  librarian handler absent — static only\n');
  if (handlerError) process.stdout.write(`  (import failed: ${handlerError})\n`);
  if (args.mock) {
    process.stdout.write(`  mock provider: ${args.mock} (groq base URL points at ${MOCK_ROUTE})\n`);
  } else {
    process.stdout.write('  mock provider: off (set --mock-provider=echo|adversarial)\n');
  }
});
