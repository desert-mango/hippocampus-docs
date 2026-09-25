// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 21 September 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Cloudinary gateway for the CMS: sign uploads, list, and guarded delete/rename under hippocampus-docs/.
/* The CMS's one door to Cloudinary. The Cloudinary API secret cannot live in a
   browser, so this function holds it and does four narrow things with it, all
   inside the `hippocampus-docs/` folder:

     sign    {subfolder, filename}  → signed upload parameters. The browser then
             posts the file straight to api.cloudinary.com; this function never
             sees file bytes. Every value that decides WHERE the file lands
             (folder / asset_folder, public_id, overwrite=false) is chosen here
             and signed, and Cloudinary rejects a post whose signed values were
             changed [S54].
     list    {cursor?}              → the assets under hippocampus-docs/ (Admin API).
     destroy {public_id}            → delete one asset, and
     rename  {from, to}             → rename one, each only when every id is under
             hippocampus-docs/ AND absent from the LIVE data/cloudinary-manifest.json
             of this very deployment (the gate keeps "in the manifest" equal to
             "used by the site", so an absent id is safe to touch).

   Contract:
     in   POST /api/media   Authorization: Bearer <GitHub user token>
          JSON body {action, …} ≤ 64 KB; Origin must be this deployment's own.
     out  200  the action's answer (below)
          400  malformed body/arguments, unknown action, or Cloudinary is not
               configured on this host
          401  no usable bearer, or GitHub rejected it   403  foreign Origin, no
               push access to desert-mango/hippocampus-docs, or an id outside
               hippocampus-docs/          404  destroy: Cloudinary has no such id
          405  not POST (Allow: POST)     409  the id is still referenced by the site
          413  body too large             429  over 60 calls a minute for this token
          502  GitHub, Cloudinary or the live manifest failed (nothing echoed)

     sign    → {cloud_name, api_key, timestamp, signature, params}; `params` is
               exactly the set of signed pairs (timestamp included) — post them
               with `file`, `api_key` and `signature`, unchanged.
     list    → {assets:[{public_id, url, bytes, width, height, format, created_at}],
                next_cursor}   (next_cursor null on the last page)
     destroy → {result: "ok", public_id}
     rename  → {public_id, url}

   Who may call: the bearer is the signed-in editor's GitHub token. It is sent
   once to GitHub's repository lookup; the caller must have push access. The
   verdict is cached 5 minutes under sha256(token) — never the token itself.

   PER-INSTANCE STATE: the caller cache, the rate limiter and the folder-mode
   cache live in this function instance's memory. Serverless platforms run
   several instances and recycle them, so each instance counts on its own: the
   60-a-minute limit is per instance (an upper bound per instance, not a global
   quota), and a cold instance re-asks GitHub and Cloudinary once.

   Secrets: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET come
   from the environment only. The secret goes into signatures and Basic-auth
   headers to api.cloudinary.com and nowhere else — no response body, no log
   line. The API key is returned with signed parameters; it is public by
   Cloudinary's design for signed uploads [S55]. Nothing is logged but status
   numbers.

   RAW NODE like api/auth.js: the body is read off the stream and every answer
   goes out through writeHead/end, so tools/dev_site.mjs can pass a plain http
   request straight in. Every outbound call goes through deps.fetch (tests
   inject a fake; nothing in the tests reaches the network). */
'use strict';

const crypto = require('crypto');
const { ownOrigin } = require('./auth.js');   // the same own-Origin rule as the sign-in

const REPO_API = 'https://api.github.com/repos/desert-mango/hippocampus-docs';
const CLOUDINARY_API = 'https://api.cloudinary.com/v1_1';
const MANIFEST_PATH = '/data/cloudinary-manifest.json';
const ROOT_PREFIX = 'hippocampus-docs/';
const SUBFOLDERS = new Set(['setup', 'people', 'projects', 'tools', 'brand']);
const ACTIONS = new Set(['sign', 'list', 'destroy', 'rename']);

const MAX_BODY_BYTES = 64 * 1024;
const TIMEOUT_MS = 8000;
const CALLER_TTL_MS = 5 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 60;
const MAX_TRACKED = 5000;              // bound on each per-instance map

const TOKEN_RE = /^[A-Za-z0-9_.-]{1,255}$/;
const CLOUD_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CURSOR_RE = /^[A-Za-z0-9_=+/-]{1,512}$/;
// An id under the prefix: path segments of word characters, dots and dashes,
// none empty and none starting with a dot (so no ".." and no "//").
const ID_RE = /^hippocampus-docs(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)+$/;
const MAX_ID_LEN = 255;

// ----------------------------------------------------------------- state ---

function createState() {
  return {
    callers: new Map(),     // sha256(token) → {push: boolean, at: ms}
    hits: new Map(),        // sha256(token) → [ms, …] within the last minute
    folderMode: new Map(),  // cloud name → "fixed" | "dynamic"
  };
}
const INSTANCE_STATE = createState();

function trim(map) {
  while (map.size > MAX_TRACKED) map.delete(map.keys().next().value);
}

// ------------------------------------------------------------- responses ---

function send(res, code, payload, extraHeaders) {
  const headers = Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }, extraHeaders || {});
  const text = JSON.stringify(payload);
  headers['content-length'] = Buffer.byteLength(text);
  res.writeHead(code, headers);
  res.end(text);
}

class HttpError extends Error {
  constructor(code, message, headers) {
    super(message);
    this.httpCode = code;
    this.headers = headers;
  }
}

// ------------------------------------------------------------------ input ---

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (tooBig) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        chunks.length = 0;
        reject(new HttpError(413, 'request body too large', { connection: 'close' }));
        return;
      }
      chunks.push(buf);
    });
    req.on('error', () => reject(new HttpError(400, 'could not read the request body')));
    req.on('end', () => { if (!tooBig) resolve(Buffer.concat(chunks).toString('utf8')); });
  });
}

function parseAsk(raw) {
  let doc;
  try { doc = JSON.parse(raw); } catch (e) { throw new HttpError(400, 'the body must be JSON'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new HttpError(400, 'the body must be a JSON object {action, …}');
  }
  if (typeof doc.action !== 'string' || !ACTIONS.has(doc.action)) {
    throw new HttpError(400, 'action must be "sign", "list", "destroy" or "rename"');
  }
  return doc;
}

function bearer(req) {
  const value = (req.headers || {}).authorization;
  if (typeof value !== 'string') return null;
  const m = /^Bearer ([^\s]+)$/.exec(value);
  return m && TOKEN_RE.test(m[1]) ? m[1] : null;
}

function config(env) {
  const cfg = {
    cloud: env.CLOUDINARY_CLOUD_NAME,
    key: env.CLOUDINARY_API_KEY,
    secret: env.CLOUDINARY_API_SECRET,
  };
  if (!cfg.cloud || !cfg.key || !cfg.secret || !CLOUD_RE.test(cfg.cloud)) return null;
  return cfg;
}

/* "Jane Doe.JPG" → "jane-doe". Drops any path and the extension, folds accents,
   keeps [a-z0-9-], at most 80 characters, no leading/trailing/double dash. */
function slugify(filename) {
  if (typeof filename !== 'string' || filename.length > 1024) return null;
  let base = filename.split(/[\\/]/).pop();
  base = base.replace(/\.[A-Za-z0-9]{1,10}$/, '');
  const slug = base.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 80).replace(/-+$/, '');
  return slug ? slug : null;
}

/* Every id this function touches: a string, under the prefix (else 403), and
   well formed (else 400). */
function checkId(id, name) {
  if (typeof id !== 'string' || !id) throw new HttpError(400, `${name} must be a public id`);
  if (!id.startsWith(ROOT_PREFIX)) {
    throw new HttpError(403, `${name} is outside hippocampus-docs/ — only the site's own images can be changed here`);
  }
  if (id.length > MAX_ID_LEN || !ID_RE.test(id)) {
    throw new HttpError(400, `${name} is not a well-formed public id`);
  }
  return id;
}

// ------------------------------------------------------------- signature ---

/* Cloudinary's string to sign [S54]: every signed field as name=value, sorted
   by name, joined with "&". The secret is appended with no separator and the
   whole is hashed (SHA-256 here; Cloudinary accepts SHA-1 or SHA-256). */
function stringToSign(params) {
  return Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
}

function signatureFor(params, secret) {
  return crypto.createHash('sha256').update(stringToSign(params) + secret, 'utf8').digest('hex');
}

const hashToken = (token) => crypto.createHash('sha256').update(token, 'utf8').digest('hex');

// --------------------------------------------------------------- outbound ---

async function call(doFetch, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const reply = await doFetch(url, Object.assign({}, init, { signal: controller.signal }));
    const text = await reply.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    return { status: Number(reply.status) || 0, ok: Boolean(reply.ok), json };
  } catch (e) {
    return { status: 0, ok: false, json: null };   // the error text may echo the request; drop it
  } finally {
    clearTimeout(timer);
  }
}

function basicAuth(cfg) {
  return `Basic ${Buffer.from(`${cfg.key}:${cfg.secret}`).toString('base64')}`;
}

// ------------------------------------------------------------ the caller ---

function rateLimit(state, key, now) {
  const recent = (state.hits.get(key) || []).filter((t) => t > now - RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) {
    state.hits.set(key, recent);
    const wait = Math.max(1, Math.ceil((recent[0] + RATE_WINDOW_MS - now) / 1000));
    throw new HttpError(429, 'too many requests — wait a minute', { 'retry-after': String(wait) });
  }
  recent.push(now);
  state.hits.delete(key);        // re-insert so the map's order stays "least recently used first"
  state.hits.set(key, recent);
  trim(state.hits);
}

async function checkCaller(ctx, token, key) {
  const cached = ctx.state.callers.get(key);
  let push;
  if (cached && ctx.now() - cached.at < CALLER_TTL_MS) {
    push = cached.push;
  } else {
    const r = await call(ctx.fetch, REPO_API, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'hippocampus-docs-cms',
        'x-github-api-version': '2022-11-28',
      },
    }, ctx.timeoutMs);
    if (r.status === 401) {
      throw new HttpError(401, 'GitHub did not accept this sign-in — please sign in again',
        { 'www-authenticate': 'Bearer' });
    }
    if (r.status === 403 || r.status === 404) {
      throw new HttpError(403, 'this account cannot write to desert-mango/hippocampus-docs');
    }
    if (r.status !== 200 || !r.json) {
      console.error(`media: the GitHub repository lookup answered HTTP ${r.status}`);
      throw new HttpError(502, 'GitHub could not confirm who you are — try again');
    }
    push = Boolean(r.json.permissions) && r.json.permissions.push === true;
    ctx.state.callers.delete(key);
    ctx.state.callers.set(key, { push, at: ctx.now() });
    trim(ctx.state.callers);
  }
  if (!push) throw new HttpError(403, 'this account cannot write to desert-mango/hippocampus-docs');
}

// --------------------------------------------------------------- actions ---

async function folderMode(ctx) {
  const known = ctx.state.folderMode.get(ctx.cfg.cloud);
  if (known) return known;
  const r = await call(ctx.fetch, `${CLOUDINARY_API}/${ctx.cfg.cloud}/config?settings=true`,
    { method: 'GET', headers: { authorization: basicAuth(ctx.cfg), accept: 'application/json' } },
    ctx.timeoutMs);
  const mode = r.ok && r.json && r.json.settings && r.json.settings.folder_mode;
  if (mode !== 'fixed' && mode !== 'dynamic') {
    console.error(`media: the Cloudinary config lookup answered HTTP ${r.status}`);
    throw new HttpError(502, 'Cloudinary did not report its folder mode — try again');
  }
  ctx.state.folderMode.set(ctx.cfg.cloud, mode);
  return mode;
}

async function actSign(ctx, ask) {
  const sub = ask.subfolder;
  if (typeof sub !== 'string' || !SUBFOLDERS.has(sub)) {
    throw new HttpError(400, 'subfolder must be one of setup, people, projects, tools, brand');
  }
  const slug = slugify(ask.filename);
  if (!slug) throw new HttpError(400, 'filename must contain letters or digits');
  const mode = await folderMode(ctx);
  const folder = ROOT_PREFIX + sub;
  const timestamp = Math.floor(ctx.now() / 1000);
  const params = mode === 'dynamic'
    ? { asset_folder: folder, overwrite: 'false', public_id: `${folder}/${slug}`, timestamp: String(timestamp) }
    : { folder, overwrite: 'false', public_id: slug, timestamp: String(timestamp) };
  return {
    cloud_name: ctx.cfg.cloud,
    api_key: ctx.cfg.key,
    timestamp,
    signature: signatureFor(params, ctx.cfg.secret),
    params,
  };
}

async function actList(ctx, ask) {
  const cursor = ask.cursor;
  if (cursor !== undefined && cursor !== null && (typeof cursor !== 'string' || !CURSOR_RE.test(cursor))) {
    throw new HttpError(400, 'cursor must be the next_cursor of an earlier answer');
  }
  const q = new URLSearchParams({ prefix: ROOT_PREFIX, max_results: '500' });
  if (cursor) q.set('next_cursor', cursor);
  const r = await call(ctx.fetch, `${CLOUDINARY_API}/${ctx.cfg.cloud}/resources/image/upload?${q}`,
    { method: 'GET', headers: { authorization: basicAuth(ctx.cfg), accept: 'application/json' } },
    ctx.timeoutMs);
  if (!r.ok || !r.json || !Array.isArray(r.json.resources)) {
    console.error(`media: the Cloudinary list answered HTTP ${r.status}`);
    throw new HttpError(502, 'Cloudinary could not list the images — try again');
  }
  const assets = r.json.resources
    .filter((x) => x && typeof x.public_id === 'string' && x.public_id.startsWith(ROOT_PREFIX))
    .map((x) => ({
      public_id: x.public_id,
      url: typeof x.secure_url === 'string' ? x.secure_url : null,
      bytes: x.bytes,
      width: x.width,
      height: x.height,
      format: x.format,
      created_at: x.created_at,
    }));
  const next = typeof r.json.next_cursor === 'string' && r.json.next_cursor ? r.json.next_cursor : null;
  return { assets, next_cursor: next };
}

/* The live manifest of THIS deployment, read over HTTP from the request's own
   (verified) origin — what the site serves right now, not a copy bundled with
   the function. Unreadable or malformed → refuse (fail closed). */
async function referencedIds(ctx) {
  const r = await call(ctx.fetch, ctx.origin + MANIFEST_PATH,
    { method: 'GET', headers: { accept: 'application/json', 'cache-control': 'no-cache' } },
    ctx.timeoutMs);
  const assets = r.ok && r.json && r.json.assets;
  if (!Array.isArray(assets) || !assets.every((a) => a && typeof a.public_id === 'string')) {
    console.error(`media: the live manifest could not be read (HTTP ${r.status})`);
    throw new HttpError(502, 'could not read the site\'s image manifest — nothing was changed');
  }
  return new Set(assets.map((a) => a.public_id));
}

async function guard(ctx, ids) {
  const referenced = await referencedIds(ctx);
  for (const id of ids) {
    if (referenced.has(id)) {
      throw new HttpError(409, `${id} is still referenced by the site — remove it from the pages and the manifest first`);
    }
  }
}

async function signedPost(ctx, op, fields) {
  const params = Object.assign({}, fields, { timestamp: String(Math.floor(ctx.now() / 1000)) });
  const form = new URLSearchParams(params);
  form.set('api_key', ctx.cfg.key);
  form.set('signature', signatureFor(params, ctx.cfg.secret));
  return call(ctx.fetch, `${CLOUDINARY_API}/${ctx.cfg.cloud}/image/${op}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  }, ctx.timeoutMs);
}

async function actDestroy(ctx, ask) {
  const id = checkId(ask.public_id, 'public_id');
  await guard(ctx, [id]);
  const r = await signedPost(ctx, 'destroy', { invalidate: 'true', public_id: id });
  const result = r.ok && r.json ? r.json.result : null;
  if (result === 'ok') return { result: 'ok', public_id: id };
  if (result === 'not found') throw new HttpError(404, `${id} does not exist on Cloudinary`);
  console.error(`media: the Cloudinary destroy answered HTTP ${r.status}`);
  throw new HttpError(502, 'Cloudinary did not delete the image — try again');
}

async function actRename(ctx, ask) {
  const from = checkId(ask.from, 'from');
  const to = checkId(ask.to, 'to');
  if (from === to) throw new HttpError(400, 'from and to are the same id');
  await guard(ctx, [from, to]);
  const r = await signedPost(ctx, 'rename',
    { from_public_id: from, invalidate: 'true', to_public_id: to });
  if (!r.ok || !r.json || typeof r.json.public_id !== 'string') {
    console.error(`media: the Cloudinary rename answered HTTP ${r.status}`);
    throw new HttpError(502, 'Cloudinary did not rename the image (does the new id already exist?)');
  }
  return { public_id: r.json.public_id,
    url: typeof r.json.secure_url === 'string' ? r.json.secure_url : null };
}

const RUN = { sign: actSign, list: actList, destroy: actDestroy, rename: actRename };

// --------------------------------------------------------------- handler ---

async function handle(req, res, deps) {
  const CLOSE = { connection: 'close' };
  if (req.method !== 'POST') {
    send(res, 405, { error: 'method not allowed — POST {action, …}' },
      Object.assign({ allow: 'POST' }, CLOSE));
    return;
  }
  const origin = ownOrigin(req);
  if (!origin) {
    send(res, 403, { error: 'the media gateway answers only this site' }, CLOSE);
    return;
  }
  try {
    const ask = parseAsk(await readBody(req));
    const cfg = config(deps.env || process.env);        // credentials from the environment only
    if (!cfg) throw new HttpError(400, 'Cloudinary is not configured on this host');
    const token = bearer(req);
    if (!token) {
      throw new HttpError(401, 'sign in first (Authorization: Bearer <token>)',
        { 'www-authenticate': 'Bearer' });
    }
    const ctx = {
      cfg,
      origin,
      fetch: deps.fetch || ((url, init) => fetch(url, init)),
      now: deps.now || Date.now,
      state: deps.state || INSTANCE_STATE,
      timeoutMs: deps.timeoutMs || TIMEOUT_MS,
    };
    const key = hashToken(token);
    rateLimit(ctx.state, key, ctx.now());
    await checkCaller(ctx, token, key);
    send(res, 200, await RUN[ask.action](ctx, ask));
  } catch (e) {
    if (e instanceof HttpError) {
      send(res, e.httpCode, { error: e.message }, e.headers);
      return;
    }
    console.error('media: unexpected failure');      // no message: it could carry a value
    send(res, 500, { error: 'the media gateway failed' });
  }
}

module.exports = (req, res, deps) => handle(req, res, deps || {});
module.exports.createState = createState;
module.exports.stringToSign = stringToSign;
module.exports.signatureFor = signatureFor;
module.exports.slugify = slugify;
module.exports.SUBFOLDERS = SUBFOLDERS;
