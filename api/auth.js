// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 26 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Exchange a GitHub App sign-in code for a user access token without exposing the secret.
/* The CMS sign-in exchange. GitHub's web flow hands the browser a short-lived
   `code`; turning it into a user access token needs the App's client SECRET,
   and a secret cannot live in a browser. So this one small function holds it.

   Flow (the opener side lives in js/editor.js, Editor mode on the site's pages):
     1. js/editor.js opens GitHub's authorize page in a popup, with a random
        `state` it keeps in memory.
     2. GitHub sends the popup to /cms/callback.html?code=…&state=… .
        js/cms-callback.js posts {type:"hc-code", code, state} to the opener
        and closes. The popup never calls this function and never sees a token.
     3. The opener checks `state` (the CSRF guard), then POSTs {code, app} here.
     4. This function swaps the code for a token at GitHub and answers
        {token, expires_in}. The token goes to the opener's page memory only.
     5. (U1, D20) The same answer sets two cookies: the sealed session hc_s
        (httpOnly) and the marker hc_in=1. A reload or another tab resumes
        with GET ?session=1; sign-out is DELETE. See "the session cookie".

   Contract:
     in   POST {"code": "<from GitHub>", "app": "editor" | "viewer"}
          `Origin` must be this deployment's own origin (https, or http on a
          localhost dev server such as tools/dev_site.mjs on 8131).
     out  200  {"token": "...", "expires_in": <seconds> | null}
          400  malformed request, unknown app, or the app is not configured here
          403  missing or foreign Origin          405  not GET, POST or DELETE
          413  body too large
          502  GitHub refused or failed: {"error": "...", ["reason": "<code>"]}
               `reason` is GitHub's short error code (e.g. bad_verification_code)
               and only when it is plain lowercase_with_underscores.

     in   GET ?app=editor | ?app=viewer      (the CMS page, on "Sign in")
     out  200  {"client_id": "..."} — the App's PUBLIC id, which the page needs
               to build GitHub's authorize URL (it rides in that URL anyway)
          400  unknown app, or the app is not configured here (id AND secret)
          403  not a same-origin request (sameOriginRead below)

     in   GET ?session=1 [&app=viewer]   with X-HC-Session: 1 (the resume)
     out  200  {"token": "...", "expires_at": <epoch ms>} from the hc_s cookie
          401  no cookie, or it is expired, tampered or not this site's:
               both cookies are cleared
          403  not same-origin, or no X-HC-Session: 1

     in   DELETE (sign-out)   Origin must be this site's own
     out  200  {"signed_out": true}; both cookies cleared; the token revoked
               at GitHub (failing soft)
          403  missing or foreign Origin (nothing is cleared)

     in   DELETE with X-HC-If-Token: <sha256 hex of a token GitHub refused>
          (the editor's 401 path: "forget the cookie only if it is still
          that token")
     out  200  {"signed_out": true}; both cookies cleared, NO revoke (GitHub
               already refused the token) — when the cookie holds that
               token, or holds no live seal at all
          200  {"signed_out": false}; nothing touched — the cookie holds
               another token (a newer sign-in, from another tab)

   Every answer is cache-control: no-store. OPTIONS gets a 405 and no CORS
   grant, so no other site can send the custom header or a DELETE.

   The viewer App arrives with U10: until GH_VIEWER_CLIENT_ID and
   GH_VIEWER_CLIENT_SECRET exist, `app: "viewer"` gets a clean 400.

   What never leaves this function: the client secret (it goes to GitHub and
   nowhere else — no response body, no log line), and the refresh token (v1 has
   no refresh; the user signs in again after 8 hours). What is never logged:
   the code, the token, GitHub's answer. Nothing is logged at all except a
   status number when GitHub fails, and one line naming HC_SESSION_KEY when
   it is set but too short to use (never its value).

   RAW NODE, like api/librarian.js: the body is read off the stream, every
   answer goes out through writeHead/end, and no Vercel helper is touched, so
   tools/dev_site.mjs can pass a plain http request straight in. */
'use strict';

const crypto = require('node:crypto');

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

const SESSION_COOKIE = 'hc_s';
const MARKER_COOKIE = 'hc_in';
const SESSION_PATH = '/api/auth';
const SESSION_MAX_S = 8 * 60 * 60;          // GitHub's user token life; v1 keeps no refresh token
const SEAL_INFO = 'hc-session-v1';
const SEAL_PREFIX = 'v1.';
const MAX_SEAL_CHARS = 3000;                // a cookie stays well under the browser's 4 KB
const REVOKE_URL = (id) => `https://api.github.com/applications/${encodeURIComponent(id)}/token`;

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

// ---------------------------------------------------- the session cookie ---

/* U1 (D20): stay signed in across tabs and reloads.

   THREAT MODEL (for the security review). The token used to sit in the tab's
   sessionStorage; now it sits in page memory, and a sealed copy sits in an
   httpOnly cookie that only this function can open:
     - hc_s = AES-256-GCM(token, expiry), key = HKDF-SHA256(HC_SESSION_KEY, or
       else the editor App's client secret; info "hc-session-v1"), additional
       data = "hc-session-v1|<app>" so an editor seal never opens as another
       app. HttpOnly; SameSite=Strict; Path=/api/auth; Max-Age = the token's
       life, 8 h at most; Secure on https.
     - hc_in=1 is a marker with no secret (Path=/, readable by js/app.js), so
       anonymous visitors never call this function.
     - The resume GET needs Sec-Fetch-Site: same-origin (or this site's exact
       Origin; "null" — the sandboxed frame — is refused) AND the custom
       header X-HC-Session: 1, which forces a CORS preflight for any other
       origin; OPTIONS gets no grant. SameSite=Strict keeps the cookie off
       every cross-site request anyway.
   Accepted residual risk: XSS on ANY page or tab of this origin can obtain
   the token through the resume for the cookie's lifetime (8 h at most), even
   with no editor tab open. That is more reach than the old per-tab
   sessionStorage (which only the one editor tab held), minus the token
   resting in storage. Cross-origin pages, the sandboxed preview frame
   (Origin: null) and the network cannot obtain it. The stricter
   alternative, a server-side GitHub proxy so the token never reaches the
   page, is out of scope for this build (every GitHub call in js/cms-core.js
   would move server-side). Limit: a sign-in lasts as long as GitHub's token
   (8 h); there is no refresh. Sign-out (DELETE) clears both cookies and
   revokes the token at GitHub; the 401 path's DELETE (X-HC-If-Token) clears
   only the token it names and revokes nothing, so one tab's dead token never
   signs out a newer sign-in. */

// HC_SESSION_KEY shorter than this is a mistake (a placeholder, a typo): it is
// ignored and the key comes from the client secret instead
const MIN_SESSION_KEY_CHARS = 32;

function sessionKey(env) {
  const e = env || {};
  let ikm = e.GH_APP_CLIENT_SECRET;
  if (typeof e.HC_SESSION_KEY === 'string' && e.HC_SESSION_KEY) {
    if (e.HC_SESSION_KEY.length >= MIN_SESSION_KEY_CHARS) ikm = e.HC_SESSION_KEY;
    else console.error(`auth: HC_SESSION_KEY is under ${MIN_SESSION_KEY_CHARS} characters, so it is ignored; the session key comes from the client secret`);
  }
  if (typeof ikm !== 'string' || !ikm) return null;
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(ikm, 'utf8'), Buffer.alloc(0),
    Buffer.from(SEAL_INFO, 'utf8'), 32));
}

function sealAad(app) { return Buffer.from(`${SEAL_INFO}|${app}`, 'utf8'); }

/* -> "v1.<base64url(iv 12 | ciphertext | tag 16)>" */
function seal(key, app, token, expAt) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(sealAad(app));
  const body = Buffer.concat([c.update(JSON.stringify({ t: token, e: expAt }), 'utf8'), c.final()]);
  return SEAL_PREFIX + Buffer.concat([iv, body, c.getAuthTag()]).toString('base64url');
}

/* -> {token, expAt} or null (malformed, tampered, another key or app). Expiry
   is the caller's check. */
function unseal(key, app, text) {
  if (!key || typeof text !== 'string' || text.length > MAX_SEAL_CHARS || !text.startsWith(SEAL_PREFIX)) return null;
  const raw = text.slice(SEAL_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const buf = Buffer.from(raw, 'base64url');
  if (buf.length < 12 + 16 + 1) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    d.setAAD(sealAad(app));
    d.setAuthTag(buf.subarray(buf.length - 16));
    const plain = Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString('utf8');
    const doc = JSON.parse(plain);
    if (!doc || typeof doc.t !== 'string' || !doc.t || !Number.isFinite(doc.e)) return null;
    return { token: doc.t, expAt: doc.e };
  } catch (e) {
    return null;
  }
}

function readCookie(req, name) {
  const raw = String(((req && req.headers) || {}).cookie || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function hostnameOf(host) {
  try { return new URL(`http://${String(host || '').trim()}`).hostname.toLowerCase(); } catch (e) { return ''; }
}

/* Secure follows the verified origin when the request carries one (https ->
   Secure; the http localhost dev server -> not). A same-origin GET carries
   no Origin: then the Host decides — Secure unless it is a localhost name. */
function secureFor(req) {
  const headers = (req && req.headers) || {};
  if (headers.origin !== undefined) {
    const own = ownOrigin(req);
    return own === null ? true : own.startsWith('https:');
  }
  return !LOCAL_HOSTNAMES.has(hostnameOf(headers.host));
}

function sessionCookies(value, maxAge, secure) {
  const tail = `; SameSite=Strict${secure ? '; Secure' : ''}`;
  return [
    `${SESSION_COOKIE}=${value}; Path=${SESSION_PATH}; Max-Age=${maxAge}; HttpOnly${tail}`,
    `${MARKER_COOKIE}=1; Path=/; Max-Age=${maxAge}${tail}`,
  ];
}

function clearCookies(secure) {
  const tail = `; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Strict${secure ? '; Secure' : ''}`;
  return [
    `${SESSION_COOKIE}=; Path=${SESSION_PATH}; HttpOnly${tail}`,
    `${MARKER_COOKIE}=; Path=/${tail}`,
  ];
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

function isResume(url) {
  try {
    return new URL(String(url || '/'), 'http://query.invalid').searchParams.get('session') === '1';
  } catch (e) {
    return false;
  }
}

/* GET ?session=1: the sealed cookie, opened, back to page memory. */
function handleResume(req, res, env, now, CLOSE) {
  const headers = (req && req.headers) || {};
  if (!sameOriginRead(req) || headers['x-hc-session'] !== '1') {
    send(res, 403, { error: 'the session is answered only to this site' }, CLOSE);
    return;
  }
  const app = appFromQuery(req.url) || 'editor';
  const out = unseal(sessionKey(env), app, readCookie(req, SESSION_COOKIE));
  if (!out || out.expAt <= now) {
    send(res, 401, { error: 'not signed in' }, { 'set-cookie': clearCookies(secureFor(req)) });
    return;
  }
  send(res, 200, { token: out.token, expires_at: out.expAt });
}

/* Revokes a user token at GitHub. Fails soft: sign-out never waits on it
   beyond the timeout, and never says why it failed. */
async function revoke(doFetch, cfg, token, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const reply = await doFetch(REVOKE_URL(cfg.id), {
      method: 'DELETE',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Basic ${Buffer.from(`${cfg.id}:${cfg.secret}`, 'utf8').toString('base64')}`,
        'content-type': 'application/json',
        'user-agent': 'hippocampus-docs-cms',
      },
      body: JSON.stringify({ access_token: token }),
      signal: controller.signal,
    });
    if (!reply.ok && reply.status !== 404) console.error('auth: GitHub did not revoke the token at sign-out');
  } catch (e) {
    console.error('auth: the token revoke at sign-out did not complete');
  } finally {
    clearTimeout(timer);
  }
}

const HASH_HEX_RE = /^[0-9a-f]{64}$/;

/* X-HC-If-Token against the sealed token: true only for the same token. A
   malformed header never matches. */
function sameTokenHash(header, token) {
  if (typeof header !== 'string' || !HASH_HEX_RE.test(header)) return false;
  const want = Buffer.from(header, 'hex');
  const have = crypto.createHash('sha256').update(token, 'utf8').digest();
  return crypto.timingSafeEqual(want, have);
}

/* DELETE: sign-out. Both cookies go; the sealed token is revoked at GitHub.
   With X-HC-If-Token (the 401 path): only when the cookie still holds that
   token, and with no revoke. */
async function handleSignOut(req, res, env, doFetch, now, timeoutMs, CLOSE) {
  const origin = ownOrigin(req);
  if (!origin) {
    send(res, 403, { error: 'sign-out is accepted only from this site' }, CLOSE);
    return;
  }
  const app = appFromQuery(req.url) || 'editor';
  const out = unseal(sessionKey(env), app, readCookie(req, SESSION_COOKIE));
  const ifToken = req.headers['x-hc-if-token'];
  if (ifToken !== undefined) {
    if (out && !sameTokenHash(ifToken, out.token)) {
      send(res, 200, { signed_out: false }, CLOSE);   // a newer sign-in: leave it alone
      return;
    }
    send(res, 200, { signed_out: true }, Object.assign({ 'set-cookie': clearCookies(origin.startsWith('https:')) }, CLOSE));
    return;
  }
  const spec = APPS[app];
  const cfg = { id: env[spec.idEnv], secret: env[spec.secretEnv] };
  if (out && cfg.id && cfg.secret) await revoke(doFetch, cfg, out.token, timeoutMs);
  send(res, 200, { signed_out: true }, Object.assign({ 'set-cookie': clearCookies(origin.startsWith('https:')) }, CLOSE));
}

async function handle(req, res, deps) {
  const env = deps.env || process.env;       // credentials come from the environment only
  const doFetch = deps.fetch || ((url, init) => fetch(url, init));
  const timeoutMs = deps.timeoutMs || GITHUB_TIMEOUT_MS;
  const now = typeof deps.now === 'function' ? deps.now() : Date.now();
  const CLOSE = { connection: 'close' };     // the body of a refused request is never read

  if (req.method === 'GET') {
    if (isResume(req.url)) handleResume(req, res, env, now, CLOSE);
    else handleClientId(req, res, env, CLOSE);
    return;
  }
  if (req.method === 'DELETE') {
    await handleSignOut(req, res, env, doFetch, now, timeoutMs, CLOSE);
    return;
  }
  if (req.method !== 'POST') {
    send(res, 405, { error: 'method not allowed — GET ?app=editor, GET ?session=1, POST {code, app} or DELETE' },
      Object.assign({ allow: 'GET, POST, DELETE' }, CLOSE));
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
  // the session cookie (D20): sealed with this site's key; no key, no cookie
  // (the sign-in then lasts for this page only, as before)
  const key = sessionKey(env);
  let cookies;
  if (key) {
    const maxAge = Math.max(1, Math.floor(Math.min(out.expiresIn || SESSION_MAX_S, SESSION_MAX_S)));
    cookies = { 'set-cookie': sessionCookies(seal(key, ask.app, out.token, now + maxAge * 1000), maxAge,
      origin.startsWith('https:')) };
  }
  send(res, 200, { token: out.token, expires_in: out.expiresIn }, cookies);
}

module.exports = (req, res, deps) => handle(req, res, deps || {});
module.exports.ownOrigin = ownOrigin;
module.exports.sameOriginRead = sameOriginRead;
module.exports.APPS = APPS;
module.exports.CALLBACK_PATH = CALLBACK_PATH;
module.exports.sessionKey = sessionKey;
module.exports.seal = seal;
module.exports.unseal = unseal;
module.exports.SESSION_MAX_S = SESSION_MAX_S;
