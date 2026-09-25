// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 21 September 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Exchange a GitHub App sign-in code for a user access token without exposing the secret.
/* The CMS sign-in exchange. GitHub's web flow hands the browser a short-lived
   `code`; turning it into a user access token needs the App's client SECRET,
   and a secret cannot live in a browser. So this one small function holds it.

   Flow (the opener side lives in js/cms.js):
     1. js/cms.js opens GitHub's authorize page in a popup, with a random
        `state` it keeps in memory.
     2. GitHub sends the popup to /cms/callback.html?code=…&state=… .
        js/cms-callback.js posts {type:"hc-code", code, state} to the opener
        and closes. The popup never calls this function and never sees a token.
     3. The opener checks `state` (the CSRF guard), then POSTs {code, app} here.
     4. This function swaps the code for a token at GitHub and answers
        {token, expires_in}. The token goes to the opener's sessionStorage only.

   Contract:
     in   POST {"code": "<from GitHub>", "app": "editor" | "viewer"}
          `Origin` must be this deployment's own origin (https, or http on a
          localhost dev server such as tools/dev_site.mjs on 8131).
     out  200  {"token": "...", "expires_in": <seconds> | null}
          400  malformed request, unknown app, or the app is not configured here
          403  missing or foreign Origin          405  neither GET nor POST
          413  body too large
          502  GitHub refused or failed: {"error": "...", ["reason": "<code>"]}
               `reason` is GitHub's short error code (e.g. bad_verification_code)
               and only when it is plain lowercase_with_underscores.

     in   GET ?app=editor | ?app=viewer      (the CMS page, on "Sign in")
     out  200  {"client_id": "..."} — the App's PUBLIC id, which the page needs
               to build GitHub's authorize URL (it rides in that URL anyway)
          400  unknown app, or the app is not configured here (id AND secret)
          403  not a same-origin request (sameOriginRead below)

   The viewer App arrives with U10: until GH_VIEWER_CLIENT_ID and
   GH_VIEWER_CLIENT_SECRET exist, `app: "viewer"` gets a clean 400.

   What never leaves this function: the client secret (it goes to GitHub and
   nowhere else — no response body, no log line), and the refresh token (v1 has
   no refresh; the user signs in again after 8 hours). What is never logged:
   the code, the token, GitHub's answer. Nothing is logged at all except a
   status number when GitHub fails.

   RAW NODE, like api/librarian.js: the body is read off the stream, every
   answer goes out through writeHead/end, and no Vercel helper is touched, so
   tools/dev_site.mjs can pass a plain http request straight in. */
'use strict';

const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const CALLBACK_PATH = '/cms/callback.html';
const MAX_BODY_BYTES = 8 * 1024;
const GITHUB_TIMEOUT_MS = 8000;
// GitHub codes are 20 hex characters today; this allows for growth while
// keeping anything that could smuggle a form field or a newline out.
const CODE_RE = /^[A-Za-z0-9_-]{1,256}$/;
const REASON_RE = /^[a-z_]{1,64}$/;

const APPS = {
  editor: { idEnv: 'GH_APP_CLIENT_ID', secretEnv: 'GH_APP_CLIENT_SECRET' },
  viewer: { idEnv: 'GH_VIEWER_CLIENT_ID', secretEnv: 'GH_VIEWER_CLIENT_SECRET' },
};

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

// ---------------------------------------------------------------- origin ---

/* Returns the verified own origin (e.g. "https://hippocampus-docs.vercel.app")
   or null. Stricter than the librarian's gate on purpose: the librarian allows
   an absent Origin and any localhost; this function mints credentials, so the
   Origin must be present and must be exactly the host the request came to. A
   browser always sends Origin on a POST from fetch, and a JSON POST from
   another site is preflighted and gets no CORS grant from here anyway. */
function ownOrigin(req) {
  const headers = (req && req.headers) || {};
  const origin = headers.origin;
  const host = String(headers.host || '').trim().toLowerCase();
  if (typeof origin !== 'string' || !origin || origin === 'null' || !host) return null;
  let url;
  try { url = new URL(origin); } catch (e) { return null; }
  if (url.origin !== origin) return null;          // no path, no credentials, no oddities
  if (url.host !== host) return null;              // hostname AND port
  const local = LOCAL_HOSTNAMES.has(url.hostname);
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && local) return url.origin;
  return null;
}

/* The GET's version of the same rule. A browser sends NO Origin header on a
   same-origin GET, so there the Fetch Metadata header every current browser
   sends — Sec-Fetch-Site: same-origin — stands in for it. A present Origin
   still has to pass ownOrigin() exactly; a caller with neither header (a
   script, curl) is refused. What this guards is a public id, so the rule is
   about keeping the function this site's own, not about a secret. */
function sameOriginRead(req) {
  const headers = (req && req.headers) || {};
  if (headers.origin !== undefined) return ownOrigin(req) !== null;
  const site = String(headers['sec-fetch-site'] || '').trim().toLowerCase();
  return site === 'same-origin' && Boolean(String(headers.host || '').trim());
}

function appFromQuery(url) {
  let app;
  try {
    app = new URL(String(url || '/'), 'http://query.invalid').searchParams.get('app');
  } catch (e) {
    return null;
  }
  return typeof app === 'string' && Object.prototype.hasOwnProperty.call(APPS, app) ? app : null;
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

// ------------------------------------------------------------------ input ---

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (tooBig) return;                  // drain, keep nothing
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        chunks.length = 0;
        const e = new Error('request body too large');
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

function parseAsk(raw) {
  let doc;
  try { doc = JSON.parse(raw); } catch (e) { return { error: 'the body must be JSON' }; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { error: 'the body must be a JSON object {code, app}' };
  }
  if (typeof doc.app !== 'string' || !Object.prototype.hasOwnProperty.call(APPS, doc.app)) {
    return { error: 'app must be "editor" or "viewer"' };
  }
  return { app: doc.app, code: doc.code };
}

// ------------------------------------------------------------- exchange ----

const FAILED = 'GitHub did not accept the sign-in — please sign in again';

async function exchange(doFetch, cfg, code, redirectUri, timeoutMs) {
  const form = new URLSearchParams({
    client_id: cfg.id,
    client_secret: cfg.secret,
    code,
    redirect_uri: redirectUri,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reply;
  let text;
  try {
    reply = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'hippocampus-docs-cms',
      },
      body: form.toString(),
      signal: controller.signal,
    });
    text = await reply.text();
  } catch (e) {
    // The error text of a failed fetch can echo the request; never log it.
    console.error('auth: the GitHub token request did not complete');
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
  if (!reply.ok) {
    console.error(`auth: GitHub answered HTTP ${Number(reply.status) || 0}`);
    return { ok: false };
  }
  let doc;
  try { doc = JSON.parse(text); } catch (e) { doc = null; }
  if (!doc || typeof doc !== 'object') {
    console.error('auth: GitHub answered something that was not JSON');
    return { ok: false };
  }
  if (doc.error !== undefined) {
    const reason = typeof doc.error === 'string' && REASON_RE.test(doc.error) ? doc.error : null;
    return { ok: false, reason };
  }
  if (typeof doc.access_token !== 'string' || !doc.access_token) {
    console.error('auth: GitHub answered without a token');
    return { ok: false };
  }
  const expires = Number(doc.expires_in);
  return {
    ok: true,
    token: doc.access_token,
    expiresIn: Number.isFinite(expires) && expires > 0 ? expires : null,
  };
}

// --------------------------------------------------------------- handler ---

/* GET ?app=<name>: the App's client id, or "not configured". The id is only
   offered when the secret exists too — an id without a secret would send the
   person to GitHub for a sign-in the exchange can never finish. */
function handleClientId(req, res, env, CLOSE) {
  if (!sameOriginRead(req)) {
    send(res, 403, { error: 'sign-in is accepted only from this site' }, CLOSE);
    return;
  }
  const app = appFromQuery(req.url);
  if (!app) {
    send(res, 400, { error: 'app must be "editor" or "viewer"' });
    return;
  }
  const spec = APPS[app];
  if (!env[spec.idEnv] || !env[spec.secretEnv]) {
    send(res, 400, { error: `sign-in for the ${app} app is not configured on this host` });
    return;
  }
  send(res, 200, { client_id: env[spec.idEnv] });
}

async function handle(req, res, deps) {
  const env = deps.env || process.env;       // credentials come from the environment only
  const doFetch = deps.fetch || ((url, init) => fetch(url, init));
  const timeoutMs = deps.timeoutMs || GITHUB_TIMEOUT_MS;
  const CLOSE = { connection: 'close' };     // the body of a refused request is never read

  if (req.method === 'GET') {
    handleClientId(req, res, env, CLOSE);
    return;
  }
  if (req.method !== 'POST') {
    send(res, 405, { error: 'method not allowed — GET ?app=editor or POST {code, app}' },
      Object.assign({ allow: 'GET, POST' }, CLOSE));
    return;
  }
  const origin = ownOrigin(req);
  if (!origin) {
    send(res, 403, { error: 'sign-in is accepted only from this site' }, CLOSE);
    return;
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    send(res, e.httpCode === 413 ? 413 : 400,
      { error: e.httpCode === 413 ? 'request body too large' : 'could not read the request body' },
      e.httpCode === 413 ? CLOSE : undefined);
    return;
  }

  const ask = parseAsk(raw);
  if (ask.error) {
    send(res, 400, { error: ask.error });
    return;
  }
  // Configuration first: "is this app available here at all" is the answer
  // a caller needs before anything about its code.
  const spec = APPS[ask.app];
  const cfg = { id: env[spec.idEnv], secret: env[spec.secretEnv] };
  if (!cfg.id || !cfg.secret) {
    send(res, 400, { error: `sign-in for the ${ask.app} app is not configured on this host` });
    return;
  }
  if (typeof ask.code !== 'string' || !CODE_RE.test(ask.code)) {
    send(res, 400, { error: 'code is missing or malformed' });
    return;
  }

  const out = await exchange(doFetch, cfg, ask.code, origin + CALLBACK_PATH, timeoutMs);
  if (!out.ok) {
    const body = { error: FAILED };
    if (out.reason) body.reason = out.reason;
    send(res, 502, body);
    return;
  }
  send(res, 200, { token: out.token, expires_in: out.expiresIn });
}

module.exports = (req, res, deps) => handle(req, res, deps || {});
module.exports.ownOrigin = ownOrigin;
module.exports.sameOriginRead = sameOriginRead;
module.exports.APPS = APPS;
module.exports.CALLBACK_PATH = CALLBACK_PATH;
