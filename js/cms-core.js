// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 19 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Pure logic of the CMS signed-in area: roles, routes, sign-in, session, GitHub client, preview host, editor.
/* HCCore — everything in cms/ that is logic rather than DOM, so node can test
   it (tools/tests/test_cms_core.mjs). js/editor.js is the DOM glue around it.

   ONE REPOSITORY. The token a signed-in person holds may reach other
   repositories; this code never lists or writes any of them, and reads
   another repository only through the ONE stated exception below (R2-F1).
   Every GitHub API path of the client goes through assertRepoPath(): it
   passes '/user' and paths under /repos/desert-mango/hippocampus-docs, and
   throws on anything else before fetch is ever called — it still refuses
   every HippoCampusRobotics path (a test proves it).

   THE STATED EXCEPTION (plan D-A, rev 4; cms-v2-plan.md §5). Exactly one
   GET-only reader, createOrgReader, may send the user's token to
   repos/HippoCampusRobotics/<repo>/commits… for <repo> in the committed
   data/graph/github-repos.json (a fixed allowlist of names, built when the
   reader is made), plus this repository's commits?path= and compare. Never
   a list call, never another owner, never another endpoint, never a write;
   anything else is refused locally (403) before fetch; a 403/404 is
   retried once WITHOUT the token; answers are cached 15 minutes. The
   allowlist, the cache and the retry live here and are node-tested
   (tools/tests/test_cms_core.mjs, "org reader").

   WRITES ARE AN ALLOWLIST OF EXACT PATHS. The GitHub client sends GET to
   any path assertRepoPath() passes, and a write verb ONLY to a path shape
   listed in WRITE_METHODS (method + path under this repository, no query).
   U8 (Review) listed its five: approve / request changes, merge, update from
   main, close — all on /pulls/<n>. U7b (Propose) listed its six: blobs,
   trees, commits, a new ref, a fast-forward of a refs/heads/cms/… ref, and
   the PR — all built by proposeRequest(), which never names main; every
   other write throws before fetch is called. The other POSTs in this
   file go to no GitHub path: the sign-in exchange to this site's own
   /api/auth, and (U9, Media) this site's own /api/media and the signed
   direct upload to Cloudinary, which carries no token.
   Seams:
     - U8 fills the preview area with createPreviewHost + refFetcher(token,
       <PR head sha>); U7b uses draftFetcher(files, refFetcher(token, <main
       sha>)) for the in-memory draft.
     - The route table ROUTES names each route's owner; the views live in
       js/editor.js's VIEWS map (the tray's routes).
     - The Review tab's logic (badges, check status, annotations, the action
       requests and what their answers mean, the Undo-on-GitHub URL, the
       changed page -> preview route map) is the "review" section below.

   THE PREVIEW HOST is the parent side of js/source.js's bridge protocol (read
   the comment block there; it is the contract). In short: the frame is
   index.html#preview=<nonce>&route=<route> in a sandbox without
   allow-same-origin; every load gets a FRESH nonce; a request
   {type:'hc-fetch', nonce, id, path} is answered only when event.source is
   that frame's window; a wrong nonce or a path off the allowlist is answered
   {ok:false, status:403}; the answer echoes nonce and id and goes to the
   frame with targetOrigin '*' (its origin is opaque); the token lives in the
   fetcher's closure and never enters a message or the frame's URL.
   isBridgePath / previewFragment / BRIDGE_PATH_RE are copies of js/source.js's
   (that file exports them to node only); the test suite proves the copies
   agree with the originals.

   THE EDITOR'S BLOCK MODEL (U5, plan D-D/D-E/D-F) is the last section:
   splitBlocks over the vendored marked lexer with the anchoring guard, the
   span editor, id-sentinels, the block diff and the overlay on main, the
   (sha, path) fetch cache, the View settings and the org reader.
   tools/tests/test_block_model.mjs pins it; tools/tests/browser_oracles.mjs
   checks the sentinels in a real Chrome over every content page. */
(function () {
  'use strict';

  const REPO_OWNER = 'desert-mango';
  const REPO_NAME = 'hippocampus-docs';
  const REPO_FULL = `${REPO_OWNER}/${REPO_NAME}`;
  const API_ROOT = 'https://api.github.com';
  const REPO_API_PATH = `/repos/${REPO_FULL}`;
  const GITHUB_WEB = `https://github.com/${REPO_FULL}`;
  const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
  const AUTH_FUNCTION = '/api/auth';
  const CALLBACK_PATH = '/cms/callback.html';
  const SESSION_KEY = 'hc-cms-session';
  const POPUP_NAME = 'hc-signin';
  const POPUP_FEATURES = 'popup=yes,width=620,height=720';
  const POPUP_CLOSE_GRACE_MS = 1500;
  const NO_ACCESS_TEXT = 'you do not have access to this site\'s repository';
  const PLACEHOLDER_TEXT = 'not here yet: edit this page on github.com';
  const PROTOCOLS_URL = `${GITHUB_WEB}/blob/main/docs/maintainer-protocols.md`;

  // ------------------------------------------------------------- roles ---

  /* D8. `permissions` from GET /repos/desert-mango/hippocampus-docs. Only a
     real boolean true grants anything: the string "true" is truthy, and a
     badge that says Editor must mean GitHub said push: true. */
  function roleFromPermissions(perms) {
    const p = (perms && typeof perms === 'object' && !Array.isArray(perms)) ? perms : {};
    if (p.admin === true) return { key: 'admin', label: 'Admin', canPush: true };
    if (p.maintain === true) return { key: 'maintain', label: 'Maintainer', canPush: true };
    if (p.push === true) return { key: 'push', label: 'Editor', canPush: true };
    return { key: 'read', label: 'Read-only', canPush: false };
  }

  // ------------------------------------------------------------ routes ---

  /* The hash routes of cms/index.html. `owner` is the unit that builds the
     real view; `placeholder` routes render one line until that unit ships. */
  const PAGE_ID_RE = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/;
  const ROUTES = Object.freeze([
    { name: 'home', re: /^\/?$/, keys: [], owner: 'U7a' },
    { name: 'review', re: /^\/review\/?$/, keys: [], owner: 'U8' },
    { name: 'review-pr', re: /^\/review\/([1-9][0-9]{0,8})\/?$/, keys: ['number'], owner: 'U8' },
    { name: 'help', re: /^\/help\/?$/, keys: [], owner: 'U7a' },
    { name: 'pages', re: /^\/pages\/?$/, keys: [], owner: 'U7b' },
    { name: 'edit', re: /^\/edit\/(.+)$/, keys: ['pageId'], owner: 'U7b' },
    { name: 'new', re: /^\/new\/([a-z][a-z-]*)\/?$/, keys: ['kind'], owner: 'U7b' },
    { name: 'media', re: /^\/media\/?$/, keys: [], owner: 'U9' },
    { name: 'private', re: /^\/private\/?$/, keys: [], owner: 'U10', placeholder: true },
  ].map((r) => Object.freeze(r)));

  function parseRoute(hash) {
    let h = typeof hash === 'string' ? hash : '';
    if (h.charAt(0) === '#') h = h.slice(1);
    h = h.split('?')[0];
    if (h === '') h = '/';
    if (h.charAt(0) === '/') {
      for (const r of ROUTES) {
        const m = r.re.exec(h);
        if (!m) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = m[i + 1]; });
        if ('number' in params) params.number = Number(params.number);
        if ('pageId' in params && !PAGE_ID_RE.test(params.pageId)) break;
        return { name: r.name, params };
      }
    }
    return { name: 'not-found', params: { path: h } };
  }

  // ---------------------------------------------------------- PR lists ---

  const isPull = (p) => Boolean(p) && typeof p === 'object' && Number.isInteger(p.number);
  const loginOf = (p) => String((p.user && p.user.login) || '').toLowerCase();

  /* The home page's "open proposals": every open PR, the signed-in person's
     own first, newest (highest number) first inside each group. */
  function orderOpenPulls(pulls, login) {
    const me = typeof login === 'string' ? login.toLowerCase() : null;
    const open = (Array.isArray(pulls) ? pulls : [])
      .filter((p) => isPull(p) && (p.state === undefined || p.state === 'open'));
    const mine = (p) => (me && loginOf(p) === me ? 0 : 1);
    return open.slice().sort((a, b) => (mine(a) - mine(b)) || (b.number - a.number));
  }

  /* Round 2 (Kyle, 2026-10-15): each proposer's own colour. The viewer is slot 0 (the site's blue, with
     magenta for changed words: css/editor.css --hc-hl and --hc-mark); every other proposer gets 1..PROPOSER_SLOTS in the order of their OLDEST open
     proposal (lowest number), so the proposals list and the page agree; more than PROPOSER_SLOTS others wrap.
     `extra` (merged-only proposers, for the list) come after the open ones. -> {login (lower case): slot} */
  const PROPOSER_SLOTS = 5;
  function proposerSlots(pulls, viewer, extra) {
    const me = typeof viewer === 'string' ? viewer.toLowerCase() : null;
    const out = {};
    if (me) out[me] = 0;
    const order = (list) => (Array.isArray(list) ? list : []).filter(isPull).slice().sort((a, b) => a.number - b.number);
    let next = 0;
    for (const p of [...order(pulls), ...order(extra)]) {
      const who = loginOf(p);
      if (!who || who in out) continue;
      out[who] = (next % PROPOSER_SLOTS) + 1;
      next += 1;
    }
    return out;
  }
  const slotOf = (slots, login) => {
    const k = typeof login === 'string' ? login.toLowerCase() : '';
    return slots && Object.prototype.hasOwnProperty.call(slots, k) ? slots[k] : 0;
  };

  function recentMerges(pulls, limit) {
    const n = Number.isInteger(limit) && limit > 0 ? limit : 5;
    return (Array.isArray(pulls) ? pulls : [])
      .filter((p) => isPull(p) && typeof p.merged_at === 'string'
        && Number.isFinite(Date.parse(p.merged_at)))
      .sort((a, b) => Date.parse(b.merged_at) - Date.parse(a.merged_at))
      .slice(0, n);
  }

  const CLOSED_PAGE_SIZE = 100;
  const CLOSED_PAGE_CAP = 5;

  /* The home page's "recently merged": the `limit` newest merges (5 by
     default). GitHub cannot list PRs by merge time, so this reads the closed
     PRs newest-UPDATED first, 100 to a page. A PR's updated_at is never
     earlier than its merged_at (the merge updates it), so no PR on a later
     page was merged after the oldest updated_at already read: once the
     limit-th newest merge seen is at or after that time, nothing unread can
     beat it and paging stops. Paging also stops at a short (last) page and
     after CLOSED_PAGE_CAP pages; the answer is then the best of what was
     read. A PR seen twice (it moved between pages while paging) counts once.
     get(path) resolves to the parsed JSON of a GET — js/editor.js's api(), or a
     fake in the tests; a rejection is passed on and ends the paging. */
  async function loadRecentMerges(get, limit) {
    const n = Number.isInteger(limit) && limit > 0 ? limit : 5;
    const seen = new Map();                 // PR number -> latest sighting
    let oldestUpdate = Infinity;
    for (let page = 1; page <= CLOSED_PAGE_CAP; page += 1) {
      const rows = await get(`${REPO_API_PATH}/pulls?state=closed&sort=updated&direction=desc`
        + `&per_page=${CLOSED_PAGE_SIZE}&page=${page}`);
      const list = Array.isArray(rows) ? rows : [];
      for (const p of list) {
        if (!isPull(p)) continue;
        seen.set(p.number, p);
        const t = Date.parse(p.updated_at);
        if (Number.isFinite(t) && t < oldestUpdate) oldestUpdate = t;
      }
      if (list.length < CLOSED_PAGE_SIZE) break;
      const top = recentMerges([...seen.values()], n);
      if (top.length === n && Date.parse(top[n - 1].merged_at) >= oldestUpdate) break;
    }
    return recentMerges([...seen.values()], n);
  }

  // ------------------------------------------------------ stale answers ---

  /* A generation counter for work that outlives its moment. next() starts a
     new generation and so retires every earlier one; current() reads it
     without starting one; isCurrent(g) is true only for the newest. js/editor.js
     starts one on every refresh, sign-in and sign-out, and drops a GitHub
     answer whose generation is no longer current: an older refresh landing
     after a sign-out or a new sign-in must not write its user, role or
     access (or its 401) over the page's new state. */
  function createGeneration() {
    let gen = 0;
    return Object.freeze({
      next() { gen += 1; return gen; },
      current: () => gen,
      isCurrent: (g) => g === gen,
    });
  }

  // ----------------------------------------------------------- sign-in ---

  function randomHex(bytes, getRandomValues) {
    if (typeof getRandomValues !== 'function') throw new Error('randomHex: no random source');
    const arr = getRandomValues(new Uint8Array(bytes));
    return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /* redirect_uri must be exactly what api/auth.js sends GitHub in the
     exchange: this origin + /cms/callback.html. */
  function authorizeUrl(clientId, origin, state) {
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: origin + CALLBACK_PATH,
      state,
    });
    return `${AUTHORIZE_URL}?${q.toString()}`;
  }

  async function readJson(res) {
    try { return JSON.parse(await res.text()); } catch (e) { return null; }
  }

  /* The opener side of the sign-in (R1-F12). deps:
       origin           this page's location.origin
       getRandomValues  crypto.getRandomValues (bound)
       openWindow       window.open (bound)
       fetch            window.fetch (bound)
     start() must be called INSIDE the click handler: it opens the popup
     synchronously (a popup opened after an await is blocked by browsers),
     then asks /api/auth for the App's client id and sends the popup to
     GitHub. handleMessage(event) returns null for anything it ignores —
     another window, another origin, another state — and a Promise of
     {token, expiresIn} for the one message that matches; the state is then
     spent. popupClosed(now) is polled by the page: a popup that closed with
     no message is a cancelled sign-in. */
  function createSignIn(deps) {
    const d = deps || {};
    let pending = null;          // {state, popup}

    async function start() {
      pending = null;
      const popup = d.openWindow('about:blank', POPUP_NAME, POPUP_FEATURES);
      if (!popup) {
        return { ok: false, reason: 'blocked',
          message: 'The sign-in window was blocked. Allow pop-ups for this site and try again.' };
      }
      const fail = (message) => {
        try { popup.close(); } catch (e) { /* already gone */ }
        return { ok: false, reason: 'unavailable', message };
      };
      let res;
      try {
        res = await d.fetch(`${AUTH_FUNCTION}?app=editor`,
          { method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store' });
      } catch (e) {
        return fail('Sign-in could not reach this site\'s server. Check the connection and try again.');
      }
      const body = await readJson(res);
      if (!res.ok || !body || typeof body.client_id !== 'string' || !body.client_id) {
        if (body && typeof body.error === 'string') return fail(`Sign-in is not available here: ${body.error}.`);
        return fail('Sign-in needs this site\'s server functions, which this host does not run. '
          + 'Open the editor on the Vercel site.');
      }
      const state = randomHex(16, d.getRandomValues);
      pending = { state, popup };
      try {
        popup.location.href = authorizeUrl(body.client_id, d.origin, state);
      } catch (e) {
        pending = null;
        return fail('The sign-in window could not be opened. Try again.');
      }
      return { ok: true };
    }

    async function exchange(code) {
      const res = await d.fetch(AUTH_FUNCTION, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ code, app: 'editor' }),
        cache: 'no-store',
      });
      const body = await readJson(res);
      if (!res.ok) {
        const why = body && typeof body.error === 'string' ? body.error
          : `this site's sign-in answered HTTP ${res.status} — please sign in again`;
        const reason = body && typeof body.reason === 'string' ? ` (${body.reason})` : '';
        throw new Error(`${why}${reason}`);
      }
      if (!body || typeof body.token !== 'string' || !body.token) {
        throw new Error('the sign-in answer had no token — please sign in again');
      }
      const exp = Number(body.expires_in);
      return { token: body.token, expiresIn: Number.isFinite(exp) && exp > 0 ? exp : null };
    }

    function handleMessage(event) {
      if (!pending || !event) return null;
      if (event.source !== pending.popup) return null;
      if (event.origin !== d.origin) return null;
      const m = event.data;
      if (!m || typeof m !== 'object' || m.type !== 'hc-code') return null;
      if (typeof m.code !== 'string' || !m.code || typeof m.state !== 'string') return null;
      if (m.state !== pending.state) return null;
      pending = null;              // single use
      return exchange(m.code);
    }

    /* Polled with the clock (Date.now()). The callback page posts its
       message and THEN closes, so the popup can read as closed before the
       message is delivered: only a popup that has stayed closed for
       POPUP_CLOSE_GRACE_MS with nothing arriving is a cancel. */
    function popupClosed(now) {
      if (!pending) return false;
      let closed;
      try { closed = Boolean(pending.popup.closed); } catch (e) { closed = true; }
      if (!closed) return false;
      if (pending.closedAt === undefined) pending.closedAt = now;
      if (now - pending.closedAt < POPUP_CLOSE_GRACE_MS) return false;
      pending = null;
      return true;
    }

    return Object.freeze({
      start,
      handleMessage,
      popupClosed,
      cancel() { pending = null; },
      pendingState: () => (pending ? pending.state : null),
    });
  }

  // ----------------------------------------------------------- session ---

  /* {token, expiresAt, login} in sessionStorage: gone when the tab closes.
     Every access is guarded — storage can throw (privacy modes, quotas). */
  function makeSession(token, expiresIn, login, now) {
    return {
      token,
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : null,
      login,
    };
  }

  /* Sign-out also drops every org-reader answer (ORG_CACHE_PREFIX keys):
     a signed-out tab never serves an answer fetched with the token. */
  function clearSession(storage) {
    try { if (storage) storage.removeItem(SESSION_KEY); } catch (e) { /* nothing to clear */ }
    try {
      const keys = [];
      for (let i = 0; storage && i < storage.length; i += 1) {
        const k = storage.key(i);
        if (typeof k === 'string' && k.startsWith(ORG_CACHE_PREFIX)) keys.push(k);
      }
      keys.forEach((k) => storage.removeItem(k));
    } catch (e) { /* nothing to clear */ }
  }

  function readSession(storage, now) {
    let raw = null;
    try { raw = storage ? storage.getItem(SESSION_KEY) : null; } catch (e) { return null; }
    if (!raw) return null;
    let s;
    try { s = JSON.parse(raw); } catch (e) { clearSession(storage); return null; }
    const valid = s && typeof s === 'object' && !Array.isArray(s)
      && typeof s.token === 'string' && s.token
      && typeof s.login === 'string' && s.login
      && (s.expiresAt === null || Number.isFinite(s.expiresAt));
    if (!valid || (s.expiresAt !== null && s.expiresAt <= now)) {
      clearSession(storage);
      return null;
    }
    return { token: s.token, expiresAt: s.expiresAt, login: s.login };
  }

  function writeSession(storage, record) {
    try {
      storage.setItem(SESSION_KEY, JSON.stringify(record));
      return true;
    } catch (e) {
      return false;
    }
  }

  // ------------------------------------------------ the one-repo client ---

  /* Throws unless `path` is '/user' or a path under this repository. Dot
     segments — spelled or percent-encoded, which the URL parser also treats
     as dot segments — could climb out of the repository, so they are refused
     outright, as are backslashes, fragments and anything absolute. */
  function assertRepoPath(p) {
    const refuse = () => {
      throw new Error(`not this site's repository: ${String(p).slice(0, 80)}`);
    };
    if (typeof p !== 'string' || p.charAt(0) !== '/' || p.charAt(1) === '/') refuse();
    if (/[\\#\s\x00-\x1f\x7f]/.test(p)) refuse();
    const pathPart = p.split('?')[0];
    // encoded dots, slashes and backslashes only matter in the PATH; the
    // query legitimately carries them (ref=cms%2Fkyle%2Ffix-typo)
    if (/%2e|%2f|%5c/i.test(pathPart)) refuse();
    if (pathPart.split('/').some((seg) => seg === '.' || seg === '..')) refuse();
    if (pathPart === '/user') return p;
    if (pathPart === REPO_API_PATH || pathPart.indexOf(`${REPO_API_PATH}/`) === 0) return p;
    return refuse();
  }

  const READ_METHODS = Object.freeze(['GET']);

  /* Every write the CMS may send: a verb and the exact shape of the path it
     may go to, relative to /repos/desert-mango/hippocampus-docs, with no
     query string. <n> is a pull request number. */
  const PULL_N = '[1-9][0-9]{0,8}';
  const RECORD_BODY_RE = /^hc-(approved|declined)((?: [0-9a-f]{64}){1,50})$/;   // = RECORD_RE (U5)
  const COMMENT_MAX = 4000;
  // U6: a person's comment text: 1..COMMENT_MAX characters, and never a record or a go-live note (those are machine text)
  const commentText = (t) => typeof t === 'string' && t.trim().length > 0 && t.length <= COMMENT_MAX
    && !/^hc-(approved|declined|go-live-failed)\b/.test(t.trim());
  const WRITE_METHODS = Object.freeze([
    // U8: approve, or request changes (the review's `event` says which)
    { method: 'POST', path: new RegExp(`^/pulls/${PULL_N}/reviews$`), unit: 'U8' },
    // U8: merge (squash, pinned to the head sha the reviewer saw)
    { method: 'PUT', path: new RegExp(`^/pulls/${PULL_N}/merge$`), unit: 'U8' },
    // U8: update from main
    { method: 'PUT', path: new RegExp(`^/pulls/${PULL_N}/update-branch$`), unit: 'U8' },
    // U8: close ({state: "closed"}); U7b: the review link in a new PR's body
    { method: 'PATCH', path: new RegExp(`^/pulls/${PULL_N}$`), unit: 'U8' },
    // U7b Propose (Git Data API): one blob per changed file, one tree, one commit
    { method: 'POST', path: /^\/git\/blobs$/, unit: 'U7b' },
    { method: 'POST', path: /^\/git\/trees$/, unit: 'U7b' },
    { method: 'POST', path: /^\/git\/commits$/, unit: 'U7b' },
    // U7b: a new proposal branch (proposeRequest names only refs/heads/cms/…)
    { method: 'POST', path: /^\/git\/refs$/, unit: 'U7b' },
    // U7b: move MY proposal's branch to the added commit (fast-forward only)
    { method: 'PATCH', path: /^\/git\/refs\/heads\/cms\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/, unit: 'U7b' },
    // U7b: open the proposal
    { method: 'POST', path: /^\/pulls$/, unit: 'U7b' },
    // U6: a conversation on one suggested change (a review comment on a page line of the proposal's head or base)
    { method: 'POST', path: new RegExp(`^/pulls/${PULL_N}/comments$`), unit: 'U6', body: (b) => isObj(b)
      && Object.keys(b).sort().join() === 'body,commit_id,line,path,side' && commentText(b.body)
      && FULL_SHA_RE.test(String(b.commit_id)) && GO_LIVE_PAGE_RE.test(String(b.path))
      && Number.isInteger(b.line) && b.line >= 1 && (b.side === 'LEFT' || b.side === 'RIGHT') },
    // U6: a reply in that conversation
    { method: 'POST', path: new RegExp(`^/pulls/${PULL_N}/comments/[1-9][0-9]{0,14}/replies$`), unit: 'U6',
      body: (b) => isObj(b) && Object.keys(b).length === 1 && commentText(b.body) },
    // U5: an approval record on a proposal: the body must be exactly ONE record (recordBody's text)
    { method: 'POST', path: new RegExp(`^/issues/${PULL_N}/comments$`), unit: 'U5',
      body: (b) => isObj(b) && Object.keys(b).length === 1 && typeof b.body === 'string' && RECORD_BODY_RE.test(b.body) },
  ].map((w) => Object.freeze(w)));

  /* True only for a write WRITE_METHODS lists: the method, and a path under
     this repository whose rest matches the row exactly (assertRepoPath has
     already refused dot segments, encodings and other repositories). */
  function isAllowedWrite(method, p, body) {
    if (typeof p !== 'string' || p.indexOf('?') >= 0) return false;
    if (p.indexOf(`${REPO_API_PATH}/`) !== 0) return false;
    const rest = p.slice(REPO_API_PATH.length);
    return WRITE_METHODS.some((w) => w.method === method && w.path.test(rest) && (!w.body || w.body(body)));
  }

  function createGitHubClient(deps) {
    const d = deps || {};
    const writeVerbs = WRITE_METHODS.map((w) => w.method)
      .filter((m, i, all) => all.indexOf(m) === i);
    const methods = Object.freeze(READ_METHODS.concat(writeVerbs));

    /* opts: accept (media type), raw (resolve the body as text), body (a
       value sent as JSON; writes only). */
    async function send(method, p, opts) {
      if (methods.indexOf(method) < 0) throw new Error(`the CMS does not send ${method}`);
      assertRepoPath(p);
      const isWrite = READ_METHODS.indexOf(method) < 0;
      if (isWrite && !isAllowedWrite(method, p, (opts || {}).body)) {
        throw new Error(`the CMS does not send ${method} to ${String(p).slice(0, 80)}`);
      }
      const o = opts || {};
      const init = {
        method,
        headers: {
          Accept: o.accept || 'application/vnd.github+json',
          Authorization: `Bearer ${d.token}`,
        },
        cache: 'no-store',
      };
      if (o.body !== undefined) {
        if (!isWrite) throw new Error(`the CMS sends no body with ${method}`);
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(o.body);
      }
      let res;
      try {
        res = await d.fetch(API_ROOT + p, init);
      } catch (e) {
        return { ok: false, status: 0, data: null };
      }
      if (o.raw) {
        let text = '';
        try { text = await res.text(); } catch (e) { return { ok: false, status: 502, data: null }; }
        return { ok: res.ok, status: res.status, data: text };
      }
      return { ok: res.ok, status: res.status, data: await readJson(res) };
    }

    /* U6: the ONE GraphQL door (graphqlRequest builds it; isAllowedGraphql checks it again here). */
    async function graphql(name, vars) {
      const req = graphqlRequest(name, vars);
      if (!isAllowedGraphql(req.body)) throw new Error('the CMS does not send that GraphQL');
      let res;
      try {
        res = await d.fetch(API_ROOT + req.path, { method: req.method, cache: 'no-store',
          headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${d.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(req.body) });
      } catch (e) {
        return { ok: false, status: 0, data: null };
      }
      return { ok: res.ok, status: res.status, data: await readJson(res) };
    }

    return Object.freeze({
      methods,
      send,
      graphql,
      get: (p, opts) => send('GET', p, opts),
    });
  }

  // --------------------------------------- page id -> file (pencil link) ---

  const listOf = (v) => (Array.isArray(v) ? v : []);
  /* The projects of a registry set: the merged list (HC.fetchProjects), or a bare index read at some commit
     (a proposal's head): an entry with no `file` is its page, content/projects/<id>.md (tools/check.py holds
     every project's file to exactly that), and its label falls back to the id. */
  const projectRows = (r) => listOf(r && r.projects && r.projects.projects).map((x) => (x && typeof x === 'object'
    && typeof x.id === 'string' && typeof x.file !== 'string' ? Object.assign({}, x, { file: `content/projects/${x.id}.md` }) : x));

  const findFile = (list, id) => {
    const hit = listOf(list).find((x) => x && typeof x === 'object' && x.id === id);
    return hit && typeof hit.file === 'string' ? hit.file : null;
  };

  /* The page ids of js/app.js's "Edit this page" link (setup/<id>,
     project/<id>, tool/<id>, about) plus data/<registry>, mapped to the file
     that holds the page — through data/setup.json, data/projects.json and
     data/tools.json, the way js/app.js finds them. regs = {setup, projects,
     tools}, each the parsed registry (or absent). Anything unknown, or a
     registry entry that does not name a content/*.md file, is null. */
  function editPath(pageId, regs) {
    const r = regs || {};
    if (typeof pageId !== 'string') return null;
    let file = null;
    if (pageId === 'about') file = 'content/about.md';
    else if (pageId.indexOf('setup/') === 0) {
      const id = pageId.slice(6);
      const sections = r.setup && r.setup.sections;
      for (const s of listOf(sections)) {
        file = findFile(s && s.pages, id);
        if (file) break;
      }
    } else if (pageId.indexOf('project/') === 0) {
      file = findFile(projectRows(r), pageId.slice(8));
    } else if (pageId.indexOf('tool/') === 0) {
      file = findFile(r.tools && r.tools.tools, pageId.slice(5));
    } else if (/^data\/[a-z0-9][a-z0-9-]*$/.test(pageId) || /^data\/projects\/[a-z0-9][a-z0-9-]{0,80}$/.test(pageId)) {
      return `${pageId}.json`;
    }
    return file && /^content\//.test(file) && isBridgePath(file) ? file : null;
  }

  const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

  function pencilUrl(p) {
    return `${GITHUB_WEB}/edit/main/${encodePath(p)}`;
  }

  /* Where the one-line placeholder of a not-yet-built route points. */
  function placeholderLink(route, regs) {
    const params = (route && route.params) || {};
    if (route && route.name === 'edit') {
      const file = editPath(params.pageId, regs);
      return file ? pencilUrl(file) : `${GITHUB_WEB}/tree/main/content`;
    }
    if (route && route.name === 'new') {
      if (params.kind === 'project') return `${GITHUB_WEB}/new/main/content/projects`;
      if (params.kind === 'person') return pencilUrl('data/people.json');
    }
    return GITHUB_WEB;
  }

  // ------------------------------------------------- the preview bridge ---

  // Copies of js/source.js's (see the header comment); the tests pin them.
  const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;
  const BRIDGE_PATH_RE = /^(content\/[A-Za-z0-9_./-]+\.md|data\/[A-Za-z0-9_./-]+\.json|search\/[A-Za-z0-9_.-]+\.json)$/;
  const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

  function isBridgePath(p) {
    if (typeof p !== 'string' || !BRIDGE_PATH_RE.test(p)) return false;
    return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
  }

  function safeRoute(route) {
    return (typeof route === 'string' && /^\/(?!\/)/.test(route) && !CONTROL_CHARS.test(route))
      ? route : '/';
  }

  function previewFragment(nonce, route, theme) {
    if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) {
      throw new Error('previewFragment: the nonce must be 16-128 characters of [A-Za-z0-9_-]');
    }
    const r = safeRoute(route === undefined ? '/' : route);
    return `#preview=${nonce}${r === '/' ? '' : `&route=${encodeURIComponent(r)}`}${theme === 'light' ? '&theme=light' : ''}`;
  }

  const refused = () => ({ ok: false, status: 403, text: '' });

  /* Whatever a fetcher returns becomes exactly {ok, status, text}: ok only
     with a 2xx status and a string body; every other shape is an error with
     a real status (502 when there is none), and an error never carries text
     (an API error body is not the frame's business). */
  function normalizeAnswer(res) {
    if (!res || typeof res !== 'object') return { ok: false, status: 502, text: '' };
    const status = Number.isInteger(res.status) && res.status >= 100 && res.status <= 599
      ? res.status : 502;
    const twoXX = status >= 200 && status < 300;
    if (res.ok === true && twoXX && typeof res.text === 'string') {
      return { ok: true, status, text: res.text };
    }
    return { ok: false, status: twoXX ? 502 : status, text: '' };
  }

  /* A sha (40 or 64 hex) or a branch name: no dot-dot, no spaces, no
     leading '/', '-' or '.', at most 250 characters. */
  function isRef(ref) {
    return typeof ref === 'string' && ref.length > 0 && ref.length <= 250
      && /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(ref) && ref.indexOf('..') < 0
      && !/\/$|\.lock$|\/\./.test(ref);
  }

  /* GET /contents/<path>?ref=<ref> with the raw media type answers the file
     body itself (up to 100 MB). */
  const RAW_MEDIA = 'application/vnd.github.raw+json';
  const contentsPath = (p, ref) => `${REPO_API_PATH}/contents/${encodePath(p)}?ref=${encodeURIComponent(ref)}`;

  /* The fetcher for a PR or a branch, through contentsPath. */
  function refFetcher(token, ref, fetchImpl) {
    if (!isRef(ref)) throw new Error('refFetcher: ref must be a sha or a branch name');
    const client = createGitHubClient({
      token,
      fetch: fetchImpl || ((url, init) => fetch(url, init)),
    });
    return async function fetchAtRef(p) {
      if (!isBridgePath(p)) return refused();
      const res = await client.get(contentsPath(p, ref), { accept: RAW_MEDIA, raw: true });
      if (!res.ok) return { ok: false, status: res.status || 502, text: '' };
      return { ok: true, status: res.status, text: res.data };
    };
  }

  /* The fetcher for an in-memory draft (U7b): files maps path -> text, or
     null for a file the draft deletes; everything else asks the fallback. */
  function draftFetcher(files, fallback) {
    const has = (p) => (files instanceof Map ? files.has(p)
      : Boolean(files) && Object.prototype.hasOwnProperty.call(files, p));
    const get = (p) => (files instanceof Map ? files.get(p) : files[p]);
    return async function fetchDraft(p) {
      if (has(p)) {
        const v = get(p);
        if (v === null) return { ok: false, status: 404, text: '' };
        return typeof v === 'string' ? { ok: true, status: 200, text: v }
          : { ok: false, status: 502, text: '' };
      }
      return fallback ? fallback(p) : { ok: false, status: 404, text: '' };
    };
  }

  /* The parent side of the bridge. deps:
       getFrameWindow()   the iframe's contentWindow (read at every message)
       setFrameSrc(url)   sets iframe.src
       getRandomValues    crypto.getRandomValues (bound)
       base               the site page relative to the CMS page ('../index.html')
       getTheme()         optional: 'light' | 'dark', the site's theme now (the frame cannot read it)
     load(route, fetcher) starts a new load with a fresh nonce and returns it.
     handleMessage(event) returns null for a message it ignores, else a
     Promise of the answer it posted (null when the answer was dropped
     because the frame re-loaded while the fetcher worked). */
  function createPreviewHost(deps) {
    const d = deps || {};
    const base = d.base || '../index.html';
    let current = null;          // {nonce, fetcher}

    function load(route, fetcher) {
      const nonce = randomHex(16, d.getRandomValues);
      current = { nonce, fetcher };
      d.setFrameSrc(base + previewFragment(nonce, route, typeof d.getTheme === 'function' ? d.getTheme() : null));
      return nonce;
    }

    function handleMessage(event) {
      const frame = typeof d.getFrameWindow === 'function' ? d.getFrameWindow() : null;
      if (!current || !event || !frame || event.source !== frame) return null;
      const m = event.data;
      if (!m || typeof m !== 'object' || m.type !== 'hc-fetch') return null;
      if (!Number.isInteger(m.id) || m.id < 1) return null;
      const nonce = typeof m.nonce === 'string' ? m.nonce : null;
      const load = current;

      const post = (answer) => {
        const msg = { type: 'hc-file', nonce, id: m.id,
          ok: answer.ok, status: answer.status, text: answer.text };
        frame.postMessage(msg, '*');
        return msg;
      };

      if (nonce !== load.nonce || !isBridgePath(m.path)) return Promise.resolve(post(refused()));
      return Promise.resolve()
        .then(() => load.fetcher(m.path))
        .then(normalizeAnswer, () => ({ ok: false, status: 502, text: '' }))
        .then((answer) => {
          // a re-load (or a new frame) since the ask: the old nonce is dead
          if (current !== load || d.getFrameWindow() !== frame) return null;
          return post(answer);
        });
    }

    return Object.freeze({
      load,
      handleMessage,
      nonce: () => (current ? current.nonce : null),
      dispose() { current = null; },
    });
  }

  // ------------------------------------------------------ review (U8) ---

  /* The words the Review tab shows. docs/maintainer-protocols.md quotes the
     same strings; keep them verbatim (a reconcile greps for drift). */
  const MACHINERY_TEXT = 'needs a code review by Desert Mango';
  const DERIVED_TEXT = 'carries search/ or data/graph/ files, which the site regenerates after a merge';
  const CHECK_TEXT = Object.freeze({
    pass: 'site rules pass',
    fail: 'site rules fail',
    checking: 'still checking',
    unknown: 'could not read the site rules check',
  });
  const SELF_APPROVE_TEXT = 'GitHub does not let you approve your own proposal';
  const SELF_REQUEST_TEXT = 'GitHub does not let you request changes on your own proposal';
  const STALE_TEXT = 'changed since you looked, reload';
  const NEEDS_HUMAN_TEXT = 'needs a human — ask Desert Mango';
  const UNDO_TEXT = 'Undo on GitHub';
  const MERGE_CONFIRM_TEXT = 'Site rules do not pass on this commit (or are still checking). '
    + 'A merge deploys nothing until main is green. Merge anyway?';

  /* The badges. "machinery": the site's code and the gate that judges it
     (plan §5: a PR may redefine its own gate, so it needs a code review);
     "derived files": what derive.yml regenerates. A rename counts on both
     its old and its new name. */
  const MACHINERY_DIRS = Object.freeze(['js/', 'css/', 'tools/', 'api/', 'cms/', '.github/']);
  const MACHINERY_FILES = Object.freeze(['index.html', 'vercel.json']);
  const DERIVED_DIRS = Object.freeze(['search/', 'data/graph/']);
  const startsWithAny = (p, dirs) => dirs.some((d) => p.indexOf(d) === 0);
  const isMachineryPath = (p) => typeof p === 'string'
    && (startsWithAny(p, MACHINERY_DIRS) || MACHINERY_FILES.indexOf(p) >= 0);
  const isDerivedPath = (p) => typeof p === 'string' && startsWithAny(p, DERIVED_DIRS);

  const isFileRow = (f) => Boolean(f) && typeof f === 'object' && typeof f.filename === 'string';
  const namesOf = (f) => [f.filename].concat(typeof f.previous_filename === 'string' ? [f.previous_filename] : []);

  /* files = GET /pulls/{n}/files rows. -> [{key, label, text}] */
  function pullBadges(files) {
    const rows = listOf(files).filter(isFileRow);
    const names = [].concat(...rows.map(namesOf));
    const out = [];
    if (names.some(isMachineryPath)) out.push({ key: 'machinery', label: 'machinery', text: MACHINERY_TEXT });
    if (names.some(isDerivedPath)) out.push({ key: 'derived', label: 'derived files', text: DERIVED_TEXT });
    return out;
  }

  /* The preview's scope. The sandboxed frame runs the site's CURRENT code;
     only content/, data/ and search/ reads come from the PR head through the
     bridge (plan D3: a preview never runs proposal code). So a proposal that
     also changes code, styles or other served files is previewed "content
     only", and the page says so. Files GitHub would not list: the same
     label, since nobody can say what the frame misses. -> {contentOnly,
     heading, text}. */
  const PREVIEW_CONTENT_ONLY_TEXT = 'Content only: this preview shows the proposal\'s pages and data '
    + 'on the site\'s current code. Its changes to code, styles or files are not shown here; read them under '
    + '"Files changed".';
  const PREVIEW_UNLISTED_TEXT = 'Content only: this preview shows the proposal\'s pages and data '
    + 'on the site\'s current code. GitHub did not list the changed files, so a change to code, styles or files '
    + 'would not show here.';
  const isUnpreviewedPath = (p) => isMachineryPath(p) || (typeof p === 'string' && p.indexOf('assets/') === 0);

  function previewScope(files) {
    const partial = (text) => ({ contentOnly: true, heading: 'Preview (content only)', text });
    if (!Array.isArray(files)) return partial(PREVIEW_UNLISTED_TEXT);
    const names = [].concat(...files.filter(isFileRow).map(namesOf));
    return names.some(isUnpreviewedPath) ? partial(PREVIEW_CONTENT_ONLY_TEXT)
      : { contentOnly: false, heading: 'Preview', text: null };
  }

  const FILES_PAGE_SIZE = 100;
  const FILES_PAGE_CAP = 30;                // GitHub lists at most 3000 files

  /* Every changed file of PR n, paged 100 at a time. get(path) resolves to
     the parsed JSON of a GET (js/editor.js's api()); a rejection is passed on. */
  async function loadPullFiles(get, n) {
    if (!Number.isInteger(n) || n < 1) throw new Error('loadPullFiles: n must be a PR number');
    const out = [];
    for (let page = 1; page <= FILES_PAGE_CAP; page += 1) {
      const rows = await get(`${REPO_API_PATH}/pulls/${n}/files?per_page=${FILES_PAGE_SIZE}&page=${page}`);
      const list = Array.isArray(rows) ? rows : [];
      out.push(...list.filter(isFileRow));
      if (list.length < FILES_PAGE_SIZE) break;
    }
    return out;
  }

  /* "opened 3 days ago" for a PR's created_at. */
  function ageText(iso, now) {
    const t = Date.parse(iso);
    if (typeof iso !== 'string' || !Number.isFinite(t) || !Number.isFinite(now)) return '';
    const mins = Math.max(0, Math.floor((now - t) / 60000));
    const say = (k, unit) => `${k} ${unit}${k === 1 ? '' : 's'} ago`;
    if (mins < 1) return 'just now';
    if (mins < 60) return say(mins, 'minute');
    const hours = Math.floor(mins / 60);
    if (hours < 48) return say(hours, 'hour');
    return say(Math.floor(hours / 24), 'day');
  }

  /* A github.com page of THIS repository, or null: check runs and comments
     carry URLs that end up in an href. */
  const ownWebUrl = (u) => (typeof u === 'string' && u.indexOf(`${GITHUB_WEB}/`) === 0
    && !/[\s"'<>\\]/.test(u) ? u : null);

  /* The gate's run in GET /commits/{sha}/check-runs: the job `check` of
     .github/workflows/check.yml, i.e. a run named "check" made by GitHub
     Actions (another App's run of the same name is not the gate). When the
     sha carries several, the newest (highest id) wins. */
  function gateRunOf(payload) {
    const runs = listOf(payload && payload.check_runs).filter((r) => r && typeof r === 'object'
      && r.name === 'check' && Number.isInteger(r.id)
      && r.app && typeof r.app === 'object' && r.app.slug === 'github-actions');
    return runs.sort((a, b) => b.id - a.id)[0] || null;
  }

  const RED_CONCLUSIONS = ['failure', 'cancelled', 'timed_out'];

  /* -> {state, text, conclusion, runId, runUrl}. state: 'pass' (completed,
     success), 'fail' (completed with any other conclusion — failure,
     cancelled, timed_out and also the rarer neutral/skipped/stale/
     action_required: only success is green), 'checking' (queued, in
     progress, or no run yet). */
  function checkStatus(payload) {
    const run = gateRunOf(payload);
    if (!run) return { state: 'checking', text: CHECK_TEXT.checking, conclusion: null, runId: null, runUrl: null };
    const runUrl = ownWebUrl(run.html_url) || ownWebUrl(run.details_url);
    const base = { conclusion: typeof run.conclusion === 'string' ? run.conclusion : null, runId: run.id, runUrl };
    if (run.status !== 'completed') return Object.assign({ state: 'checking', text: CHECK_TEXT.checking }, base);
    if (run.conclusion === 'success') return Object.assign({ state: 'pass', text: CHECK_TEXT.pass }, base);
    const why = RED_CONCLUSIONS.indexOf(run.conclusion) >= 0 || !base.conclusion ? ''
      : ` (the check ended "${base.conclusion.replace(/[^a-z_]/g, '')}")`;
    return Object.assign({ state: 'fail', text: CHECK_TEXT.fail + why }, base);
  }

  /* GET /check-runs/{id}/annotations -> [{file, line, message}]: the `✗`
     lines check.yml re-emits. line is null when the annotation has none. */
  function annotationRows(list) {
    return listOf(list).filter((a) => a && typeof a === 'object').map((a) => {
      const message = [a.message, a.title].find((v) => typeof v === 'string' && v.trim()) || '';
      return {
        file: typeof a.path === 'string' && a.path ? a.path : '(no file)',
        line: Number.isInteger(a.start_line) && a.start_line > 0 ? a.start_line : null,
        message: message.trim(),
      };
    });
  }

  const NOTES_PAGE_SIZE = 100;
  const NOTES_PAGE_CAP = 10;

  /* Every annotation of check run `id`, paged 100 at a time until a short
     page (at most NOTES_PAGE_CAP pages), as annotationRows. get(path)
     resolves to the parsed JSON of a GET; a rejection is passed on. */
  async function loadAnnotations(get, id) {
    if (!Number.isInteger(id) || id < 1) throw new Error('loadAnnotations: a check run id is needed');
    const out = [];
    for (let page = 1; page <= NOTES_PAGE_CAP; page += 1) {
      const rows = await get(`${REPO_API_PATH}/check-runs/${id}/annotations?per_page=${NOTES_PAGE_SIZE}&page=${page}`);
      const list = Array.isArray(rows) ? rows : [];
      out.push(...annotationRows(list));
      if (list.length < NOTES_PAGE_SIZE) break;
    }
    return out;
  }

  /* "file, line, what to fix" as one line of text. */
  function annotationText(row) {
    const r = row || {};
    return r.line ? `${r.file}, line ${r.line}: ${r.message}` : `${r.file}: ${r.message}`;
  }

  /* Rollback (D8): GitHub's own Revert button on the merged PR's page. */
  function undoOnGitHubUrl(n) {
    if (!Number.isInteger(n) || n < 1 || n > 999999999) throw new Error('undoOnGitHubUrl: n must be a PR number');
    return `${GITHUB_WEB}/pull/${n}`;
  }

  /* The Vercel bot's preview comment on the PR, as a link to the comment
     itself (never a URL lifted out of its body). */
  function vercelCommentUrl(comments) {
    const c = listOf(comments).find((x) => x && typeof x === 'object'
      && x.user && x.user.login === 'vercel[bot]' && ownWebUrl(x.html_url));
    return c ? c.html_url : null;
  }

  /* Edit access (Kyle, 2026-10-19). Who can edit which project is decided ONCE, in Python:
     tools/build_edit_access.py writes data/graph/edit-access.json from each person's commits in the
     project's repos plus the admins' add and remove lists in data/projects.json (remove wins). This code
     only READS that file, never works the rule out again. The caller passes MAIN's file (a proposal's copy
     must never grant). Shape: {note, projects: {<id>: {repos, editors: [{login, why, repos_with_commits}],
     removed: [{login, had_commits}]}}}. Logins compare lowercased. Anything odd grants nothing. */
  const ACCESS_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
  const ACCESS_SITE_WIDE_TEXT = 'Admins and Maintainers can edit every project.';
  const ACCESS_REQUEST_LABEL = 'Request edit access';
  const ACCESS_SECTION_LABEL = 'Who can edit';
  const ACCESS_UNREAD_TEXT = 'Could not read who can edit this project right now: try again in a minute.';
  // Editor mode on a project page (the edit gate, 2026-10-21): editing follows the same list
  const ACCESS_LOCKED_TEXT = 'You can\'t edit this project.';
  const ACCESS_READING_TEXT = 'Checking who can edit this project…';
  const ACCESS_TEXTS = Object.freeze({
    added: 'An admin gave you access to this project.',
    removed: 'An admin removed your access to this project.',
    none: 'You have no commits in this project\'s repos yet.',
    'no-write': 'You have commits here, but your GitHub account can\'t approve on this site yet: ask an admin to add you as a Write collaborator.',
    'no-data': 'This project\'s access list is not built yet: only admins can approve here.',
  });
  const isAccessCount = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  const reposWord = (n) => (n === 1 ? 'repo' : 'repos');
  /* One project's entry of the access file, or null (missing, odd, or a name like __proto__). */
  function accessProject(doc, projectId) {
    if (!isObj(doc) || !isObj(doc.projects) || typeof projectId !== 'string') return null;
    if (!Object.prototype.hasOwnProperty.call(doc.projects, projectId)) return null;
    const p = doc.projects[projectId];
    return isObj(p) ? p : null;
  }
  /* The well-formed editor rows of a project entry: a login, why 'commits' (with k >= 1 of n repos) or
     'added' (k = 0). A row that breaks the shape names no one. */
  function accessEditorRows(p) {
    const n = p && isAccessCount(p.repos) ? p.repos : null;
    return listOf(p && p.editors).filter((e) => isObj(e) && typeof e.login === 'string' && ACCESS_LOGIN_RE.test(e.login)
      && isAccessCount(e.repos_with_commits) && ((e.why === 'commits' && e.repos_with_commits >= 1 && n !== null && e.repos_with_commits <= n)
        || (e.why === 'added' && e.repos_with_commits === 0)));
  }
  function accessRemovedRows(p) {
    return listOf(p && p.removed).filter((e) => isObj(e) && typeof e.login === 'string' && ACCESS_LOGIN_RE.test(e.login)
      && typeof e.had_commits === 'boolean');
  }
  /* The editor's role object (roleFromPermissions) -> 'site-wide' | 'write' | 'read'. Anything else is read-only. */
  function accessRoleKind(role) {
    const r = isObj(role) ? role : {};
    if (r.canPush !== true) return 'read';
    if (r.key === 'admin' || r.key === 'maintain') return 'site-wide';
    return r.key === 'push' ? 'write' : 'read';
  }
  /* What one person can do on one project -> {can, why, text, editor, removed, hadCommits, reposWithCommits,
     repos}. why: 'site-wide' (Admin or Maintain: every project), 'commits' / 'added' (an editor with a Write
     role), 'no-write' (an editor whose GitHub role cannot approve), 'removed', 'none', or 'no-data' (the
     project is not in the file yet: admins only, fails closed). */
  function accessFor(doc, projectId, login, role) {
    const kind = accessRoleKind(role);
    const p = accessProject(doc, projectId);
    const repos = p && isAccessCount(p.repos) ? p.repos : null;
    const out = (can, why, text, extra) => Object.assign({ can, why, text, editor: null, removed: false, hadCommits: false,
      reposWithCommits: 0, repos }, extra || {});
    if (kind === 'site-wide') {
      return out(true, 'site-wide', `You can edit every project (${role.key === 'admin' ? 'Admin' : 'Maintainer'}).`);
    }
    if (!p) return out(false, 'no-data', ACCESS_TEXTS['no-data']);
    const me = typeof login === 'string' && login ? login.toLowerCase() : '';
    if (!me) return out(false, 'none', ACCESS_TEXTS.none);
    const gone = accessRemovedRows(p).find((e) => e.login.toLowerCase() === me);
    if (gone) return out(false, 'removed', ACCESS_TEXTS.removed, { removed: true, hadCommits: gone.had_commits });
    const ed = accessEditorRows(p).find((e) => e.login.toLowerCase() === me);
    if (!ed) return out(false, 'none', ACCESS_TEXTS.none);
    const extra = { editor: { login: ed.login, why: ed.why, reposWithCommits: ed.repos_with_commits },
      hadCommits: ed.why === 'commits', reposWithCommits: ed.repos_with_commits };
    if (kind !== 'write') return out(false, 'no-write', ACCESS_TEXTS['no-write'], extra);
    if (ed.why === 'added') return out(true, 'added', ACCESS_TEXTS.added, extra);
    return out(true, 'commits',
      `You can edit this project: you have commits in ${ed.repos_with_commits} of its ${repos} ${reposWord(repos)}.`, extra);
  }
  const canEditProject = (doc, projectId, login, role) => accessFor(doc, projectId, login, role).can;
  /* The "Who can edit" rows of one project, in the file's order: {login, why, chip}. The chip says why
     the site lists them; it does not claim GitHub enforces each one. */
  function accessEditors(doc, projectId) {
    const p = accessProject(doc, projectId);
    if (!p) return [];
    return accessEditorRows(p).map((e) => ({ login: e.login, why: e.why,
      chip: e.why === 'added' ? 'added by an admin' : `commits in ${e.repos_with_commits} of ${p.repos} ${reposWord(p.repos)}` }));
  }

  /* Who may approve: ownsAll is true when every changed file is a file of a project that lists the login
     as an editor in MAIN's edit-access.json (the caller passes it as `access`): its page
     content/projects/<id>.md, or its facts file data/projects/<id>.json. Anything else (setup, tools, About,
     Lab, a shared registry, the image list, data/projects.json itself) is never a project editor's. */
  const PROJECT_FILE_RE = /^(?:content\/projects\/([a-z0-9][a-z0-9-]{0,80})\.md|data\/projects\/([a-z0-9][a-z0-9-]{0,80})\.json)$/;
  function ownsAll(o) {
    const c = o || {};
    const login = typeof c.login === 'string' ? c.login.toLowerCase() : '';
    const files = Array.isArray(c.files) ? c.files : null;
    if (!login || !files || !files.length) return false;
    return files.every((f) => {
      const m = typeof f === 'string' ? PROJECT_FILE_RE.exec(f) : null;
      const id = m ? (m[1] || m[2]) : null;
      const p = id ? accessProject(c.access, id) : null;
      return Boolean(p) && !accessRemovedRows(p).some((e) => e.login.toLowerCase() === login)
        && accessEditorRows(p).some((e) => e.login.toLowerCase() === login);
    });
  }

  /* Which buttons a role gets (D8; edit access 2026-10-19). Read-only: none. Write ("Editor"): request
     changes, update and close; Approve and Merge only when ctx shows the proposal is wholly inside projects
     that list the member as an editor (ownsAll), and never Approve on their own proposal. Maintain and Admin:
     all. A merged PR offers only Undo on GitHub (Revert needs write, [S89]); a closed one nothing. ctx:
     {login, files (changed file names, or null while unread), access (main's data/graph/edit-access.json)}. */
  function reviewActionsFor(role, pull, ctx) {
    const r = role || {};
    const p = pull || {};
    if (r.canPush !== true) return [];
    if (p.merged === true || typeof p.merged_at === 'string') return ['undo'];
    if (p.state !== 'open') return [];
    const c = ctx || {};
    // plan-u5: once a proposal has an edit-by-edit record, Merge would bring declined edits back: no Merge here
    const noMerge = (list) => (c.hasRecords === true ? list.filter((k) => k !== 'merge') : list);
    if (r.key === 'maintain' || r.key === 'admin') return noMerge(['approve', 'request-changes', 'merge', 'update', 'close']);
    const owns = ownsAll(c);
    const author = p.user && typeof p.user.login === 'string' ? p.user.login.toLowerCase() : '';
    const own = !author || author === String(c.login || '').toLowerCase();
    const out = ['request-changes', 'update', 'close'];
    if (owns) out.splice(1, 0, 'merge');
    if (owns && !own) out.unshift('approve');
    return noMerge(out);
  }

  const isSha = (s) => typeof s === 'string' && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(s);

  /* Merge on anything but a green gate asks once (MERGE_CONFIRM_TEXT), then
     goes. Never a lock — Kyle's rule is no merge-blocking anything (plan D8)
     — and a red main deploys nothing anyway: the host re-runs check.py
     before every deploy (U1). */
  const mergeNeedsConfirm = (checkState) => checkState !== 'pass';

  /* The one write for each action. ctx: {number, sha (the head sha the
     reviewer saw), comment (request changes), checkState (checkStatus's
     state for that sha), confirmed (the person said "Merge anyway")}.
     Throws, in words a person can act on, when ctx cannot make a request.
     The merge is pinned to the sha shown, so a newer head answers 409. */
  function reviewRequest(action, ctx) {
    const c = ctx || {};
    const n = c.number;
    if (!Number.isInteger(n) || n < 1 || n > 999999999) throw new Error('no proposal number');
    const pull = `${REPO_API_PATH}/pulls/${n}`;
    const needSha = () => {
      if (!isSha(c.sha)) throw new Error('the proposal\'s head commit is unknown — reload');
      return c.sha;
    };
    switch (action) {
      case 'approve':
        return { method: 'POST', path: `${pull}/reviews`, body: { event: 'APPROVE', commit_id: needSha() } };
      case 'request-changes': {
        const text = typeof c.comment === 'string' ? c.comment.trim() : '';
        if (!text) throw new Error('write what should change before you request changes');
        return { method: 'POST', path: `${pull}/reviews`,
          body: { event: 'REQUEST_CHANGES', body: text, commit_id: needSha() } };
      }
      case 'merge':
        if (mergeNeedsConfirm(c.checkState) && c.confirmed !== true) {
          throw new Error('a merge while site rules do not pass needs your confirmation');
        }
        return { method: 'PUT', path: `${pull}/merge`, body: { merge_method: 'squash', sha: needSha() } };
      case 'update':
        return { method: 'PUT', path: `${pull}/update-branch`, body: { expected_head_sha: needSha() } };
      case 'close':
        return { method: 'PATCH', path: pull, body: { state: 'closed' } };
      default:
        throw new Error(`no such action: ${String(action).slice(0, 40)}`);
    }
  }

  /* U5: the approval-record writes for keys on proposal n, chunked to RECORD_MAX keys per record. */
  function recordRequests(n, kind, keys) {
    if (!Number.isInteger(n) || n < 1 || n > 999999999) throw new Error('no proposal number');
    const k = listOf(keys);
    const out = [];
    for (let i = 0; i < k.length; i += RECORD_MAX) {
      out.push({ method: 'POST', path: `${REPO_API_PATH}/issues/${n}/comments`, body: { body: recordBody(kind, k.slice(i, i + RECORD_MAX)) } });
    }
    if (!out.length) throw new Error('no edits to record');
    return out;
  }

  /* U6: the ONE GraphQL door (plan-final §7): exactly three operations, this repository written into their
     text, their variables checked; isAllowedGraphql compares a body with them string for string. */
  const GRAPHQL_OPS = Object.freeze({
    threads: `query($n: Int!, $after: String) { repository(owner: "${REPO_OWNER}", name: "${REPO_NAME}") { pullRequest(number: $n) { reviewThreads(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id isResolved comments(first: 1) { nodes { databaseId } } } } } } }`,
    resolve: 'mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }',
    unresolve: 'mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }',
  });
  const THREAD_ID_RE = /^PRRT_[A-Za-z0-9_-]{4,80}$/;
  function graphqlVarsOk(name, v) {
    if (!isObj(v)) return false;
    const keys = Object.keys(v);
    if (name === 'threads') {
      return keys.every((k) => k === 'n' || k === 'after') && Number.isInteger(v.n) && v.n >= 1 && v.n <= 999999999
        && (v.after === undefined || v.after === null || (typeof v.after === 'string' && /^[A-Za-z0-9+/=_-]{1,200}$/.test(v.after)));
    }
    return keys.length === 1 && typeof v.id === 'string' && THREAD_ID_RE.test(v.id);
  }
  function graphqlRequest(name, vars) {
    if (!Object.prototype.hasOwnProperty.call(GRAPHQL_OPS, name)) throw new Error('no such GraphQL operation');
    if (!graphqlVarsOk(name, vars)) throw new Error('GraphQL variables of the wrong shape');
    return { method: 'POST', path: '/graphql', body: { query: GRAPHQL_OPS[name], variables: Object.assign({}, vars) } };
  }
  function isAllowedGraphql(body) {
    if (!isObj(body) || Object.keys(body).sort().join() !== 'query,variables') return false;
    const name = Object.keys(GRAPHQL_OPS).find((k) => GRAPHQL_OPS[k] === body.query);
    return Boolean(name) && graphqlVarsOk(name, body.variables);
  }

  /* U6: start a conversation on one edit (a review comment on its first line: the head's for a change or an add,
     the merge base's for a delete), or reply in one. o: {headSha, path, edit, baseText, headText, text}. */
  function threadRequest(n, o) {
    if (!Number.isInteger(n) || n < 1 || n > 999999999) throw new Error('no proposal number');
    const c = o || {};
    const text = typeof c.text === 'string' ? c.text.trim() : '';
    if (!commentText(text)) throw new Error('write a comment first');
    if (!FULL_SHA_RE.test(String(c.headSha)) || !GO_LIVE_PAGE_RE.test(String(c.path))) throw new Error('this change cannot take a comment');
    const at = editLines(c.edit, c.baseText, c.headText);
    if (!at) throw new Error('this change cannot take a comment');
    return { method: 'POST', path: `${REPO_API_PATH}/pulls/${n}/comments`,
      body: { body: text, commit_id: c.headSha, path: c.path, line: at.line, side: at.side } };
  }
  function replyRequest(n, rootId, text) {
    if (!Number.isInteger(n) || n < 1 || n > 999999999) throw new Error('no proposal number');
    if (!Number.isInteger(rootId) || rootId < 1) throw new Error('no conversation to reply to');
    const t = typeof text === 'string' ? text.trim() : '';
    if (!commentText(t)) throw new Error('write a reply first');
    return { method: 'POST', path: `${REPO_API_PATH}/pulls/${n}/comments/${rootId}/replies`, body: { body: t } };
  }

  /* U6: send one conversation write (threadRequest / replyRequest's answer) through the one-repo client.
     -> {ok, status, message}. Nothing that is not one of those two shapes is sent. */
  async function runThreadWrite(client, req) {
    const r = req || {};
    if (r.method !== 'POST' || !/\/pulls\/[0-9]+\/comments(\/[0-9]+\/replies)?$/.test(String(r.path))) {
      return { ok: false, status: 0, message: 'Nothing was sent: not a comment.' };
    }
    let res;
    try { res = await client.send(r.method, r.path, { body: r.body }); } catch (e) {
      return { ok: false, status: 0, message: `Nothing was sent: ${e.message}.` };
    }
    if (res && res.ok) return { ok: true, status: res.status, message: 'Comment sent.' };
    const words = githubWords(res && res.data);
    return { ok: false, status: (res && res.status) || 0, message: `GitHub refused the comment (HTTP ${(res && res.status) || 0})${words ? `: ${words}` : ''}.` };
  }
  /* U6: resolve (on) or reopen a conversation through the GraphQL door. -> {ok, status, message} */
  async function runResolve(client, threadId, on) {
    let res;
    try { res = await client.graphql(on ? 'resolve' : 'unresolve', { id: threadId }); } catch (e) {
      return { ok: false, status: 0, message: `Nothing was sent: ${e.message}.` };
    }
    const errs = res && res.data && Array.isArray(res.data.errors) ? res.data.errors : [];
    if (res && res.ok && !errs.length) return { ok: true, status: res.status, message: on ? 'Resolved.' : 'Reopened.' };
    return { ok: false, status: (res && res.status) || 0, message: `GitHub refused (HTTP ${(res && res.status) || 0}).` };
  }

  /* U5b: write the approval (or decline) records for keys on proposal n, chunk by chunk; stops at the
     first refusal. -> {ok, status, message, sent}. */
  async function runRecord(client, n, kind, keys) {
    let reqs;
    try {
      reqs = recordRequests(n, kind, keys);
    } catch (e) {
      return { ok: false, status: 0, message: `Nothing was sent: ${e.message}.`, sent: false };
    }
    let res = null;
    const done = [];                                       // keys whose record GitHub took (a chunk at a time)
    for (const r of reqs) {
      try {
        res = await client.send(r.method, r.path, { body: r.body });
      } catch (e) {
        if (!done.length) return { ok: false, status: 0, message: `Nothing was sent: ${e.message}.`, sent: false, done };
        res = { ok: false, status: 0, data: null };
      }
      if (!res || res.ok !== true) break;
      done.push(...r.body.body.split(' ').slice(1));
    }
    if (res && res.ok === true) {
      return { ok: true, status: res.status, message: kind === 'approved' ? 'Approved. Going live in about a minute.' : 'Declined.', sent: true, done };
    }
    const status = res && Number.isInteger(res.status) ? res.status : 0;
    const words = githubWords(res && res.data);
    const said = words ? `: ${words}` : '';
    const part = done.length ? ` ${done.length} of ${listOf(keys).length} were recorded before that.` : '';
    if (status === 401) return { ok: false, status, message: `Your sign-in has ended. Please sign in again.${part}`, sent: true, done };
    if (status === 403) return { ok: false, status, message: `GitHub says you may not do this${said}.${part}`, sent: true, done };
    if (status === 0) return { ok: false, status, message: `GitHub could not be reached. Reload to see whether it happened.${part}`, sent: true, done };
    return { ok: false, status, message: `GitHub refused (HTTP ${status})${said}.${part}`, sent: true, done };
  }

  const DONE_TEXT = Object.freeze({
    approve: 'Approved.',
    'request-changes': 'Changes requested.',
    merge: 'Merged.',
    update: 'Updating from main: GitHub is bringing this branch up to date. Reload in a moment to see it.',
    close: 'Closed.',
  });

  /* GitHub's own words from an error body (message + errors[]), as plain
     text, short. */
  function githubWords(data) {
    const d = data && typeof data === 'object' ? data : {};
    const parts = [];
    if (typeof d.message === 'string') parts.push(d.message);
    for (const e of listOf(d.errors)) {
      if (typeof e === 'string') parts.push(e);
      else if (e && typeof e.message === 'string') parts.push(e.message);
    }
    return parts.join(' — ').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 300);
  }

  /* What an action's answer means, in the tab's words. res = the client's
     {ok, status, data}; ctx.isAuthor = the signed-in person opened the PR. */
  function actionOutcome(action, res, ctx) {
    const r = res || {};
    const c = ctx || {};
    const status = Number.isInteger(r.status) ? r.status : 0;
    const words = githubWords(r.data);
    const said = words ? `: ${words}` : '';
    const out = (ok, message) => ({ ok, status, message });
    if (r.ok === true) return out(true, DONE_TEXT[action] || 'Done.');
    if (status === 0) return out(false, 'GitHub could not be reached. Reload to see whether it happened.');
    if (status === 401) return out(false, 'Your sign-in has ended. Please sign in again.');
    if (status === 422 && (action === 'approve' || action === 'request-changes')
      && (c.isAuthor === true || /own pull request/i.test(words))) {
      return out(false, `${action === 'approve' ? SELF_APPROVE_TEXT : SELF_REQUEST_TEXT}.`);
    }
    if (action === 'merge' && status === 409) return out(false, `Not merged: it ${STALE_TEXT}.`);
    // main's ruleset (2026-10-14): a code owner's approval and the check come first; say which is missing
    if (action === 'merge' && status === 405 && /code owner|approving review|review is required|review required/i.test(words)) {
      return out(false, 'Not merged yet: it is waiting for a code owner\'s approval (a site admin, or an owner of this project).');
    }
    if (action === 'merge' && status === 405 && /status check|required check/i.test(words)) {
      return out(false, 'Not merged yet: the site check must pass first.');
    }
    if (action === 'merge' && status === 405) return out(false, `GitHub cannot merge this proposal${said}`);
    if (action === 'update' && status === 422) {
      if (/expected[_ ]head[_ ]sha|head sha/i.test(words)) return out(false, `Not updated: it ${STALE_TEXT}.`);
      return out(false, `This branch ${NEEDS_HUMAN_TEXT}.`);
    }
    if (status === 403) return out(false, `GitHub says you may not do this${said}`);
    return out(false, `GitHub refused (HTTP ${status})${said}`);
  }

  /* Sends one review action through the one-repo client and says what came
     of it: {ok, status, message}. A request that cannot be built (no sha, no
     comment) sends nothing and says why. */
  async function runReviewAction(client, action, ctx) {
    let req;
    try {
      req = reviewRequest(action, ctx);
    } catch (e) {
      return { ok: false, status: 0, message: `Nothing was sent: ${e.message}.`, sent: false };
    }
    let res;
    try {
      res = await client.send(req.method, req.path, { body: req.body });
    } catch (e) {
      return { ok: false, status: 0, message: `Nothing was sent: ${e.message}.`, sent: false };
    }
    return Object.assign(actionOutcome(action, res, ctx), { sent: true });
  }

  /* Changed files -> the site routes that show them, for the preview: the
     inverse of editPath, through the PR head's registries (regs = {setup,
     projects, tools}, each the parsed JSON or null — a PR's registry is not
     yet checked, so every read is guarded). Removed files show nothing.
     -> [{route, label, file}] in the PR's file order, one per route. */
  const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
  const DATA_ROUTES = Object.freeze({
    'data/site.json': { route: '/', label: 'Home' },
    'data/setup.json': { route: '/setup', label: 'Setup' },
    'data/projects.json': { route: '/projects', label: 'Projects' },
    'data/tools.json': { route: '/tools', label: 'Tools' },
    'data/people.json': { route: '/team', label: 'Team' },        // round 2 (R5): the Team page
  });
  const textOr = (v, fallback) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);

  function pageForFile(file, regs) {
    const r = regs || {};
    if (file === 'content/about.md') return { route: '/team', label: 'Team' };
    if (Object.prototype.hasOwnProperty.call(DATA_ROUTES, file)) return DATA_ROUTES[file];
    const byFile = (list) => listOf(list).find((x) => x && typeof x === 'object' && x.file === file);
    if (file.indexOf('content/setup/') === 0) {
      for (const s of listOf(r.setup && r.setup.sections)) {
        const pg = byFile(s && s.pages);
        if (pg && typeof pg.id === 'string' && PAGE_ID_RE.test(pg.id)) {
          return { route: `/setup/${pg.id}`, label: textOr(pg.title, `/setup/${pg.id}`) };
        }
      }
      return null;
    }
    const inList = (list, prefix) => {
      const x = byFile(list);
      return x && typeof x.id === 'string' && SLUG_RE.test(x.id)
        ? { route: `${prefix}/${x.id}`, label: textOr(x.name, `${prefix}/${x.id}`) } : null;
    };
    if (file.indexOf('content/projects/') === 0) return inList(projectRows(r), '/projects');
    if (file.indexOf('content/tools/') === 0) return inList(r.tools && r.tools.tools, '/tools');
    const facts = PROJECT_FACTS_FILE_RE.exec(file);           // a project's facts file: its project page
    const x = facts ? projectRows(r).find((p) => p && p.id === facts[1]) : null;
    return x ? { route: `/projects/${x.id}`, label: textOr(x.name, `/projects/${x.id}`) } : null;
  }

  function previewPages(files, regs) {
    const out = [];
    for (const f of listOf(files).filter(isFileRow)) {
      if (f.status === 'removed') continue;
      const pg = pageForFile(f.filename, regs);
      if (pg && !out.some((x) => x.route === pg.route)) out.push({ route: pg.route, label: pg.label, file: f.filename });
    }
    return out;
  }

  /* Round 2 (R3, Kyle 2026-10-15): the proposals list's rows — who, which pages, when, status — open proposals
     newest first, then the recently merged. filesOf(number) -> the PR's file rows, or null when GitHub would not
     list them. pages = previewPages (routes the site shows them on); other = changed files with no page (code).
     slot = the proposer's colour (proposerSlots; merged-only proposers after the open ones). */
  function proposalRows(open, merged, filesOf, regs, viewer) {
    const opens = listOf(open).filter(isPull).slice().sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0)
      || (b.number - a.number));
    const merges = listOf(merged).filter(isPull);
    const slots = proposerSlots(opens, viewer, merges);
    const row = (p, st) => {
      const files = typeof filesOf === 'function' ? filesOf(p.number) : null;
      const known = Array.isArray(files);
      const pages = known ? previewPages(files, regs) : [];
      const other = known ? files.filter((f) => isFileRow(f) && f.status !== 'removed' && !pages.some((x) => x.file === f.filename)
        && !pageForFile(f.filename, regs)).length : 0;
      const login = String((p.user && p.user.login) || 'unknown');
      return { number: p.number, title: textOr(p.title, '(no title)'), who: login, slot: slotOf(slots, login), state: st,
        when: st === 'merged' ? p.merged_at : p.created_at, pages, other, filesKnown: known,
        head: p.head && typeof p.head.sha === 'string' ? p.head.sha : null };
    };
    return [...opens.map((p) => row(p, 'open')), ...merges.map((p) => row(p, 'merged'))];
  }

  /* The registries previewPages needs for these files, read at the PR head
     through `fetcher` (refFetcher(token, sha)): only the ones a changed
     content file needs; a missing or broken one is null. */
  const REGISTRY_FOR = Object.freeze([
    ['content/setup/', 'setup', 'data/setup.json'],
    ['content/projects/', 'projects', 'data/projects.json'],
    ['data/projects/', 'projects', 'data/projects.json'],
    ['content/tools/', 'tools', 'data/tools.json'],
  ]);

  async function loadHeadRegistries(fetcher, files) {
    const names = listOf(files).filter(isFileRow).map((f) => f.filename);
    const regs = { setup: null, projects: null, tools: null };
    const wanted = new Map();
    for (const [prefix, key, file] of REGISTRY_FOR) if (names.some((p) => p.indexOf(prefix) === 0)) wanted.set(key, file);
    await Promise.all([...wanted].map(async ([key, file]) => {
      try {
        const res = await fetcher(file);
        if (res && res.ok === true && typeof res.text === 'string') regs[key] = JSON.parse(res.text);
      } catch (e) { /* a registry that cannot be read maps no page */ }
    }));
    // the changed projects' own facts at the head, for their names (the index holds only ids and the add/remove lists)
    const ids = new Set(names.map((n) => (/^content\/projects\/([a-z0-9][a-z0-9-]*)\.md$/.exec(n) || PROJECT_FACTS_FILE_RE.exec(n) || [])[1])
      .filter(Boolean));
    if (regs.projects && Array.isArray(regs.projects.projects) && ids.size) {
      const facts = {};
      await Promise.all([...ids].map(async (id) => {
        try {
          const res = await fetcher(projectFactsFile(id));
          if (res && res.ok === true && typeof res.text === 'string') facts[id] = JSON.parse(res.text);
        } catch (e) { /* the id is its label */ }
      }));
      regs.projects = mergeProjects(regs.projects, regs.projects.projects.map((x) => (x && facts[x.id]) || null));
    }
    return regs;
  }

  // ------------------------------------------------------- editor (U7b) ---

  /* The words the editor shows. docs/maintainer-protocols.md quotes them;
     keep them verbatim. ID_RULE_TEXT carries the gate's own clause
     (tools/check.py's overlay rule: "renaming or removing an existing id
     needs Desert Mango"). */
  const ID_RULE_TEXT = 'renaming or removing an existing id needs Desert Mango — open an issue';
  const STRICT_JSON_TEXT = 'strict JSON — no trailing commas, double quotes';
  const LEAVE_TEXT = 'This page has changes that are not proposed yet. They stay as a draft in this tab '
    + 'until you close it. Leave the page?';
  const DISCARD_TEXT = 'Throw away your changes to this page?';

  /* The registries the editor offers as raw JSON (form editors come after
     the handoff). data/setup.json is not one: tools/rst_convert.py owns it. */
  const RAW_REGISTRIES = Object.freeze(['data/people.json', 'data/projects.json', 'data/site.json',
    'data/tools.json']);
  /* A project's facts file (2026-10-14): data/projects/<id>.json, owner-approved; edited as raw JSON too. */
  const PROJECT_FACTS_FILE_RE = /^data\/projects\/([a-z0-9][a-z0-9-]{0,80})\.json$/;
  const projectFactsFile = (id) => `data/projects/${id}.json`;
  const isRawRegistry = (f) => RAW_REGISTRIES.indexOf(f) >= 0 || PROJECT_FACTS_FILE_RE.test(String(f));
  /* The index merged with each project's facts (factsList[i] for index entry i; js/source.js's
     HC.fetchProjects does the same): an entry keeps the index's id, add and remove, then the facts (a facts
     file can never set those, nor the old `owners`). */
  const PROJECT_INDEX_KEYS = Object.freeze(['id', 'add', 'remove']);
  function mergeProjects(index, factsList) {
    if (!index || typeof index !== 'object' || !Array.isArray(index.projects)) return index;
    const facts = listOf(factsList);
    return Object.assign({}, index, { projects: index.projects.map((e, i) => {
      if (!e || typeof e !== 'object') return e;
      const f = facts[i] && typeof facts[i] === 'object' && !Array.isArray(facts[i]) ? facts[i] : {};
      const out = {};
      for (const k of PROJECT_INDEX_KEYS) if (k in e) out[k] = e[k];
      for (const k of Object.keys(f)) if (PROJECT_INDEX_KEYS.indexOf(k) < 0 && k !== 'owners') out[k] = f[k];
      return Object.assign(out, e);
    }) });
  }

  /* 'page' for a content page, 'registry' for a raw-JSON registry, null for
     anything the editor does not open. */
  function editKind(pageId) {
    if (typeof pageId !== 'string') return null;
    if (/^data\//.test(pageId)) return isRawRegistry(`${pageId}.json`) ? 'registry' : null;
    return /^(about|setup\/.+|project\/.+|tool\/.+)$/.test(pageId) ? 'page' : null;
  }

  const pageRow = (pageId, title, file, route) => Object.freeze({ pageId, title, file, route });

  /* The editor's page tree, from the registries the way js/app.js builds
     its routes: one group per setup section, then projects, tools, About,
     and the raw-JSON registries. An entry whose id or file does not map
     (editPath) is left out, never guessed. -> [{key, title, pages}] */
  function pageTree(regs) {
    const r = regs || {};
    const out = [];
    for (const s of listOf(r.setup && r.setup.sections)) {
      const pages = listOf(s && s.pages).filter((p) => p && typeof p.id === 'string'
        && PAGE_ID_RE.test(p.id) && editPath(`setup/${p.id}`, r) === p.file)
        .map((p) => pageRow(`setup/${p.id}`, textOr(p.title, p.id), p.file, `/setup/${p.id}`));
      out.push({ key: 'setup', title: `Setup — ${textOr(s && s.title, 'section')}`, pages });
    }
    const listed = (list, prefix, route) => listOf(list).filter((x) => x && typeof x.id === 'string'
      && SLUG_RE.test(x.id) && editPath(`${prefix}/${x.id}`, r) === x.file)
      .map((x) => pageRow(`${prefix}/${x.id}`, textOr(x.name, x.id), x.file, `${route}/${x.id}`));
    out.push({ key: 'projects', title: 'Projects', pages: listed(projectRows(r), 'project', '/projects') });
    out.push({ key: 'tools', title: 'Agent tools', pages: listed(r.tools && r.tools.tools, 'tool', '/tools') });
    out.push({ key: 'about', title: 'Team', pages: [pageRow('about', 'Team', 'content/about.md', '/team')] });
    out.push({ key: 'registries', title: 'Registries (raw JSON)', pages: RAW_REGISTRIES.map((f) => pageRow(
      f.slice(0, -5), f, f, DATA_ROUTES[f].route)) });
    return out;
  }

  /* Every content page of the tree, flat (the link picker's list). */
  function pageList(regs) {
    return [].concat(...pageTree(regs).filter((g) => g.key !== 'registries').map((g) => g.pages));
  }

  /* file -> page id (editPath's inverse), and page id -> the site route the
     preview opens. null when the registries do not name it. */
  function pageIdForFile(file, regs) {
    if (isRawRegistry(file)) return file.slice(0, -5);
    const hit = pageList(regs).find((p) => p.file === file);
    return hit ? hit.pageId : null;
  }

  function routeForPage(pageId, regs) {
    if (editKind(pageId) === 'registry') {
      const facts = PROJECT_FACTS_FILE_RE.exec(`${pageId}.json`);     // a project's facts: its project page
      return facts ? `/projects/${facts[1]}` : DATA_ROUTES[`${pageId}.json`].route;
    }
    const hit = pageList(regs).find((p) => p.pageId === pageId);
    return hit ? hit.route : null;
  }

  /* ---- strict JSON, located. JSON.parse decides; when it refuses, this
     scanner finds WHERE, in the same words in every browser (Safari's
     message carries no position at all). -> null | {line, column, message} */
  function lineCol(text, pos) {
    const before = text.slice(0, pos);
    const line = before.split('\n').length;
    return { line, column: pos - before.lastIndexOf('\n') };
  }

  function scanJson(s) {
    let i = 0;
    const fail = (pos, message) => { throw Object.assign(new Error(message), { pos }); };
    const what = (c) => (c === undefined ? 'the end of the text' : `'${c}'`);
    const ws = () => { while (i < s.length && ' \t\n\r'.indexOf(s[i]) >= 0) i += 1; };
    function str() {
      i += 1;
      for (;;) {
        const c = s[i];
        if (c === undefined) fail(i, 'the text ends inside a string (a missing closing ")');
        if (c === '"') { i += 1; return; }
        if (c === '\n') fail(i, 'a line break inside a string (a missing closing ")');
        if (c < ' ') fail(i, 'a control character inside a string');
        if (c === '\\') {
          const e = s[i + 1];
          if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) { i += 6; continue; }
          if ('"\\/bfnrt'.indexOf(e) < 0 || e === undefined) fail(i, 'a backslash that starts no known escape');
          i += 2;
          continue;
        }
        i += 1;
      }
    }
    function value() {
      ws();
      const c = s[i];
      if (c === '{') return obj();
      if (c === '[') return arr();
      if (c === '"') return str();
      if (c === '\'') fail(i, 'a single quote — JSON strings need double quotes');
      const num = /-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;
      num.lastIndex = i;
      if (num.exec(s)) { i = num.lastIndex; return undefined; }
      for (const w of ['true', 'false', 'null']) {
        if (s.startsWith(w, i)) { i += w.length; return undefined; }
      }
      return fail(i, c === undefined ? 'the text ends where a value should be'
        : `${what(c)} where a value should be`);
    }
    function items(close, one) {
      i += 1;
      ws();
      if (s[i] === close) { i += 1; return; }
      for (;;) {
        one();
        ws();
        if (s[i] === ',') {
          const comma = i;
          i += 1;
          ws();
          if (s[i] === close) fail(comma, `a trailing comma before '${close}' — JSON allows none`);
          continue;
        }
        if (s[i] === close) { i += 1; return; }
        fail(i, `expected ',' or '${close}', found ${what(s[i])}`);
      }
    }
    function obj() {
      items('}', () => {
        ws();
        if (s[i] === '\'') fail(i, 'a single quote — names need double quotes');
        if (s[i] !== '"') fail(i, `expected a name in double quotes, found ${what(s[i])}`);
        str();
        ws();
        if (s[i] !== ':') fail(i, `expected ':' after the name, found ${what(s[i])}`);
        i += 1;
        value();
      });
    }
    function arr() { items(']', value); }
    try {
      value();
      ws();
      if (i < s.length) fail(i, `${what(s[i])} after the end of the JSON value`);
      return null;
    } catch (e) {
      return Number.isInteger(e.pos) ? Object.assign(lineCol(s, e.pos), { message: e.message }) : null;
    }
  }

  function jsonProblem(text) {
    if (typeof text !== 'string') return { line: 1, column: 1, message: 'there is no text' };
    try { JSON.parse(text); return null; } catch (e) { /* located below */ }
    return scanJson(text) || { line: 1, column: 1, message: 'this is not valid JSON' };
  }

  function jsonProblemText(file, p) {
    return `${file}, line ${p.line}, column ${p.column}: ${p.message} (${STRICT_JSON_TEXT})`;
  }

  /* The ids a registry's pages and links hang on (R1-F4): read-only in the
     editor. site.json has none. */
  const ID_LISTS = Object.freeze({
    'data/projects.json': 'projects', 'data/tools.json': 'tools', 'data/people.json': 'groups',
  });

  function lockedIds(file, doc) {
    const key = ID_LISTS[file];
    if (!key || !doc || typeof doc !== 'object') return [];
    return listOf(doc[key]).filter((x) => x && typeof x === 'object' && typeof x.id === 'string')
      .map((x) => x.id);
  }

  /* A raw-JSON draft's first problem, or null: strict JSON (located), then
     the locked ids — an id of the original that the draft no longer has
     was removed or renamed — then an id used twice (a copied entry keeps
     its old id; a new entry needs a new one).
     -> {kind: 'json'|'id', message, line?, column?} */
  function registryDraftProblem(file, originalText, draftText) {
    const p = jsonProblem(draftText);
    if (p) return Object.assign({ kind: 'json' }, p, { message: jsonProblemText(file, p) });
    let before;
    try { before = JSON.parse(originalText); } catch (e) { return null; }
    const now = lockedIds(file, JSON.parse(draftText));
    const gone = lockedIds(file, before).find((id) => now.indexOf(id) < 0);
    if (gone !== undefined) return { kind: 'id', message: `${file}: '${gone}' was removed or renamed — ${ID_RULE_TEXT}` };
    const twice = now.find((id, i) => now.indexOf(id) !== i);
    return twice === undefined ? null
      : { kind: 'id', message: `${file}: the id '${twice}' is used twice — a new entry needs a new id` };
  }

  /* Re-serialise a registry the way its file is written (the indent of its
     first indented line, a final newline when it had one), so a form's
     added entry is the whole diff. */
  function formatLike(originalText, value) {
    const t = typeof originalText === 'string' ? originalText : '';
    const m = /\n( +)\S/.exec(t);
    return JSON.stringify(value, null, m ? m[1].length : 2) + (/\n$/.test(t) || !t ? '\n' : '');
  }

  /* ---- snippets, in the site's Markdown dialect (content/*.md). */
  const SNIPPETS = Object.freeze({
    note: Object.freeze({ label: 'Note box',
      before: '<div class="adm adm-note"><p class="adm-title">Note</p>\n\n',
      placeholder: 'Your note.', after: '\n\n</div>\n' }),
    warning: Object.freeze({ label: 'Warning',
      before: '<div class="adm adm-warning"><p class="adm-title">Warning</p>\n\n',
      placeholder: 'What to watch out for.', after: '\n\n</div>\n' }),
    tabs: Object.freeze({ label: 'Tabs',
      before: '<div class="tabs">\n\n<div class="tab" data-label="First">\n\n',
      placeholder: 'What the first tab says.',
      after: '\n\n</div>\n\n<div class="tab" data-label="Second">\n\nWhat the second tab says.\n\n</div>\n\n</div>\n' }),
  });

  /* U5: the block picker's catalog = SNIPPETS plus four. It is a separate
     table because the old /cms/ editor drew one button per SNIPPETS key and
     its test file pinned those three keys; both are retired (U8), and the
     two tables may now fold together. The site serves images only from
     its Cloudinary manifest, so the image snippet has no address: `media`
     tells the picker to take one from the Media tab (imageMarkdown); the
     bare snippet renders its alt text and passes the gate. The sanitizer
     drops <video> and <iframe>, so a video is a link. */
  const SNIPPET_CATALOG = Object.freeze({
    note: SNIPPETS.note,
    warning: SNIPPETS.warning,
    tabs: SNIPPETS.tabs,
    image: Object.freeze({ label: 'Image', media: true,
      before: '![', placeholder: 'Describe the image', after: ']()\n' }),
    attention: Object.freeze({ label: 'Attention',
      before: '<div class="adm adm-attention"><p class="adm-title">Attention</p>\n\n',
      placeholder: 'What the reader must not miss.', after: '\n\n</div>\n' }),
    video: Object.freeze({ label: 'Video (a link)',
      before: '[Watch the video: ', placeholder: 'what it shows',
      after: '](https://www.youtube.com/watch?v=VIDEO-ID)\n' }),
    repo: Object.freeze({ label: 'Repository card',
      before: '<div class="adm adm-seealso"><p class="adm-title">Repository</p>\n\n',
      placeholder: '[HippoCampusRobotics/repo-name](https://github.com/HippoCampusRobotics/repo-name): what it holds.',
      after: '\n\n</div>\n' }),
  });

  /* The block snippet `kind` at [start, end) of text, on its own lines; the
     selection (or the placeholder) goes inside and comes back selected.
     -> {text, selStart, selEnd} */
  function insertSnippet(text, start, end, kind) {
    if (!Object.prototype.hasOwnProperty.call(SNIPPET_CATALOG, kind)) throw new Error(`no such snippet: ${String(kind).slice(0, 20)}`);
    const sn = SNIPPET_CATALOG[kind];
    const t = String(text || '');
    const a = Math.max(0, Math.min(start, t.length));
    const b = Math.max(a, Math.min(end, t.length));
    const head = t.slice(0, a);
    let lead = '';
    if (head && !/\n\n$/.test(head)) lead = /\n$/.test(head) ? '\n' : '\n\n';
    const inner = b > a ? t.slice(a, b) : sn.placeholder;
    const tail = t.slice(b);
    const trail = tail && !/^\n/.test(tail) ? '\n' : '';
    const selStart = head.length + lead.length + sn.before.length;
    return { text: head + lead + sn.before + inner + sn.after + trail + tail,
      selStart, selEnd: selStart + inner.length };
  }

  /* An internal link to a page of the tree: [label](#<route>). */
  function linkMarkdown(page, selected) {
    const label = textOr(typeof selected === 'string' ? selected.replace(/[[\]]/g, '') : '',
      String(page.title).replace(/[[\]]/g, ''));
    return `[${label}](#${page.route})`;
  }

  /* ---- drafts: in memory and in sessionStorage (this tab only), keyed by
     page. A draft = {key, label, route, files: {path: text},
     originals: {path: text | null (a new file)}, base: {ref, sha, number}}:
     the text each file had at `base` (main's head, or my proposal's branch
     head) when it was opened. Every storage access is guarded. */
  const DRAFTS_KEY = 'hc-cms-drafts';
  const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

  function validDraft(d) {
    if (!isObj(d) || typeof d.key !== 'string' || !d.key || !isObj(d.files) || !isObj(d.originals)) return false;
    const paths = Object.keys(d.files);
    if (!paths.length || paths.some((p) => typeof d.files[p] !== 'string'
      || !Object.prototype.hasOwnProperty.call(d.originals, p)
      || (d.originals[p] !== null && typeof d.originals[p] !== 'string'))) return false;
    const b = d.base;
    return isObj(b) && isRef(b.ref) && isSha(b.sha) && (b.number === null || Number.isInteger(b.number));
  }

  const isDirty = (d) => Object.keys(d.files).some((p) => d.files[p] !== d.originals[p]);

  /* The draft store. Without a name: the one list under DRAFTS_KEY (a tab's sessionStorage before U4b). With a
     name (draftsKey(login): one store per login in localStorage, U4b): ONE storage entry per page,
     `<name>/<page key>`, so two tabs saving different pages never write the same entry; each draft keeps its
     base sha. sync(keep) reads the other tabs' writes (this tab's own objects kept for `keep`, unless another
     tab removed them); clear() drops every entry of the store (sign-out). */
  function createDraftStore(storage, name) {
    const scoped = typeof name === 'string' && name.length > 0;
    const KEY = scoped ? name : DRAFTS_KEY;
    const entryKey = (k) => `${KEY}/${encodeURIComponent(k)}`;
    function entries() {
      const out = [];
      for (let i = 0; storage && i < storage.length; i += 1) {
        const k = storage.key(i);
        if (typeof k === 'string' && k.indexOf(`${KEY}/`) === 0) out.push(k);
      }
      return out;
    }
    function read() {
      const out = new Map();
      try {
        if (!storage) return out;
        if (!scoped) {
          const raw = storage.getItem(KEY);
          const list = raw ? JSON.parse(raw) : [];
          for (const d of Array.isArray(list) ? list : []) if (validDraft(d)) out.set(d.key, d);
          return out;
        }
        for (const k of entries()) {
          try {
            const d = JSON.parse(storage.getItem(k));
            if (validDraft(d) && entryKey(d.key) === k) out.set(d.key, d);
          } catch (e) { /* one broken entry is skipped */ }
        }
      } catch (e) { /* unreadable: start empty */ }
      return out;
    }
    let map = read();
    function write(d) {
      try {
        if (!storage) return false;
        if (scoped) storage.setItem(entryKey(d.key), JSON.stringify(d));
        else storage.setItem(KEY, JSON.stringify([...map.values()]));
        return true;
      } catch (e) {
        return false;
      }
    }
    function drop(key) {
      try {
        if (!storage) return false;
        if (scoped) storage.removeItem(entryKey(key));
        else storage.setItem(KEY, JSON.stringify([...map.values()]));
        return true;
      } catch (e) {
        return false;
      }
    }
    return Object.freeze({
      get: (key) => map.get(key) || null,
      put(d) {
        if (!validDraft(d)) throw new Error('not a draft');
        map.set(d.key, d);
        return write(d);
      },
      remove(key) { map.delete(key); return drop(key); },
      list: () => [...map.values()],
      dirty: () => [...map.values()].filter(isDirty),
      sync(keep) {
        const now = read();
        for (const k of Array.isArray(keep) ? keep : []) if (now.has(k) && map.has(k)) now.set(k, map.get(k));
        map = now;
        return [...map.values()];
      },
      clear() {
        map = new Map();
        try {
          if (!storage) return;
          if (scoped) entries().forEach((k) => storage.removeItem(k));
          else storage.removeItem(KEY);
        } catch (e) { /* nothing to clear */ }
      },
      key: KEY,
      entryKey,
    });
  }
  const GH_LOGIN_KEY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
  /* One draft store per login (U4b): never another person's drafts on a shared browser. */
  const draftsKey = (login) => (typeof login === 'string' && GH_LOGIN_KEY_RE.test(login) ? `${DRAFTS_KEY}:${login.toLowerCase()}` : null);

  /* ---- new project, new person: a form -> the registry text of a draft. */
  const PROJECT_STATUSES = Object.freeze(['active', 'maintained', 'legacy', 'archive']);
  const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
  const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
  const ORG_WEB = 'https://github.com/HippoCampusRobotics';
  const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');

  /* A registry's text parsed, with `key` a list — or the located problem. */
  function parsedRegistry(file, text, key) {
    const p = jsonProblem(text);
    if (p) return { problem: jsonProblemText(file, p) };
    const doc = JSON.parse(text);
    if (!isObj(doc) || !Array.isArray(doc[key])) return { problem: `${file}: '${key}' must be a list — fix the registry first` };
    return { doc };
  }

  /* form = {id, name, status, tagline, repos (one name per line), story}.
     -> {problem, id, files}: files = exactly data/projects.json (the index entry {id, add: [], remove: []}
     appended: a new project needs an admin's approval; its editors then come from commits and the admin's
     add/remove lists), data/projects/<id>.json (its facts:
     name, status, tagline, file, repos; 2026-10-14) and the story at content/projects/<id>.md. A repository
     already in a project (merged: the projects with their facts, HC.fetchProjects; else the index's own
     entries) or in the exclusions is refused: check.py wants each org repo in exactly one. */
  function newProjectDraft(form, projectsText, merged) {
    const f = form || {};
    const fail = (problem) => ({ problem, id: null, files: null });
    const id = trimmed(f.id);
    if (!PROJECT_ID_RE.test(id)) {
      return fail(`the id '${id.slice(0, 60)}' must be lowercase letters, digits and dashes (it is the page's address, /projects/<id>)`);
    }
    const name = trimmed(f.name);
    if (!name) return fail('the project needs a name');
    const status = trimmed(f.status);
    if (PROJECT_STATUSES.indexOf(status) < 0) return fail(`the status must be one of ${PROJECT_STATUSES.join(', ')}`);
    const tagline = trimmed(f.tagline);
    if (!tagline) return fail('the project needs a tagline (the one line under its name)');
    const names = String(typeof f.repos === 'string' ? f.repos : '').split('\n').map((s) => s.trim()).filter(Boolean);
    const odd = names.find((n) => !REPO_NAME_RE.test(n));
    if (odd !== undefined) return fail(`'${odd.slice(0, 60)}' is not a repository name (one per line, as on github.com/HippoCampusRobotics)`);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup !== undefined) return fail(`the repository '${dup}' is listed twice`);
    const reg = parsedRegistry('data/projects.json', projectsText, 'projects');
    if (reg.problem) return fail(reg.problem);
    const projects = reg.doc.projects.filter(isObj);
    if (projects.some((p) => p.id === id)) return fail(`a project with the id '${id}' already exists — pick another id`);
    const owner = new Map();
    const withRepos = merged && Array.isArray(merged.projects) ? merged.projects.filter(isObj) : projects;
    for (const p of withRepos) {
      for (const r of listOf(p.repos)) {
        if (isObj(r) && typeof r.name === 'string' && r.external !== true) owner.set(r.name, `project '${p.id}'`);
      }
    }
    for (const x of listOf(reg.doc.exclusions)) {
      if (isObj(x) && typeof x.name === 'string') owner.set(x.name, 'the exclusions list');
    }
    const taken = names.find((n) => owner.has(n));
    if (taken !== undefined) {
      return fail(`the repository '${taken}' is already listed in ${owner.get(taken)} — each repository belongs to exactly one project`);
    }
    const file = `content/projects/${id}.md`;
    // add/remove (Kyle, 2026-10-19): a new project starts with no one added or removed; commits in its
    // repos give edit access after the daily refresh, and an admin can add or remove people
    reg.doc.projects.push({ id, add: [], remove: [] });
    const facts = { name, status, tagline, file, repos: names.map((n) => ({ name: n, url: `${ORG_WEB}/${n}` })) };
    const story = String(typeof f.story === 'string' ? f.story : '').replace(/\s+$/, '');
    return { problem: null, id, files: { 'data/projects.json': formatLike(projectsText, reg.doc),
      [projectFactsFile(id)]: formatLike(projectsText, facts), [file]: `${story}\n` } };
  }

  /* Access proposals (Kyle, 2026-10-19): asking for edit access, or an admin adding or removing a person,
     is ONE commit that changes only data/projects.json: the login goes into that project's `add` list (and
     out of `remove`), or into `remove` (and out of `add`). Logins compare lowercased; the file keeps its
     own format (formatLike). -> {problem, text}. */
  function accessRequestDraft(projectsText, projectId, login, op) {
    const fail = (problem) => ({ problem, text: null });
    if (op !== 'add' && op !== 'remove') return fail('the change must be add or remove');
    const who = trimmed(login);
    if (!ACCESS_LOGIN_RE.test(who)) return fail(`'${who.slice(0, 60)}' is not a GitHub login (letters, digits and dashes, not starting with a dash)`);
    const reg = parsedRegistry('data/projects.json', projectsText, 'projects');
    if (reg.problem) return fail(reg.problem);
    const entry = reg.doc.projects.find((p) => isObj(p) && p.id === projectId);
    if (!entry) return fail(`there is no project '${String(projectId).slice(0, 80)}' in data/projects.json`);
    for (const k of ['add', 'remove']) {
      if (k in entry && !Array.isArray(entry[k])) return fail(`data/projects.json: '${k}' of '${projectId}' must be a list — fix the registry first`);
    }
    if (!('add' in entry)) entry.add = [];
    if (!('remove' in entry)) entry.remove = [];
    const me = who.toLowerCase();
    const same = (w) => typeof w === 'string' && w.toLowerCase() === me;
    const into = op, outOf = op === 'add' ? 'remove' : 'add';
    if (entry[into].some(same)) return fail(`${who} is already on the ${into} list of '${projectId}'`);
    entry[into] = entry[into].concat([who]);
    entry[outOf] = entry[outOf].filter((w) => !same(w));
    return { problem: null, text: formatLike(projectsText, reg.doc) };
  }

  /* Is an open proposal an access proposal? Judged from the change itself, never from its title: its
     files are exactly one modified data/projects.json, and between the base text and the head text only
     the add and remove lists of existing projects differ (same projects, same order, every other key the
     same). -> null, or {kind, changes: [{login, op, project}]}. op 'add': the login went into `add` or
     out of `remove`; op 'remove': into `remove` or out of `add`. kind 'request' when it is one add of the
     proposal's own author (or, with no author given, one add); else 'change'. */
  function classifyAccessProposal(files, baseText, headText, author) {
    const rows = Array.isArray(files) ? files : null;
    if (!rows || rows.length !== 1) return null;
    const r = rows[0];
    const name = typeof r === 'string' ? r : (isObj(r) ? r.filename : null);
    const status = typeof r === 'string' ? 'modified' : (isObj(r) ? r.status : null);
    if (name !== 'data/projects.json' || status !== 'modified') return null;
    const parse = (t) => { if (typeof t !== 'string') return null; try { return JSON.parse(t); } catch (e) { return null; } };
    const base = parse(baseText), head = parse(headText);
    if (!isObj(base) || !isObj(head) || !Array.isArray(base.projects) || !Array.isArray(head.projects)) return null;
    const rest = (o, drop) => JSON.stringify(Object.keys(o).sort().filter((k) => drop.indexOf(k) < 0).map((k) => [k, o[k]]));
    if (rest(base, ['projects']) !== rest(head, ['projects'])) return null;
    if (base.projects.length !== head.projects.length) return null;
    const logins = (v) => {
      if (v === undefined) return [];
      if (!Array.isArray(v) || !v.every((w) => typeof w === 'string' && ACCESS_LOGIN_RE.test(w))) return null;
      return v;
    };
    const changes = [];
    for (let i = 0; i < base.projects.length; i += 1) {
      const b = base.projects[i], h = head.projects[i];
      if (!isObj(b) || !isObj(h) || typeof b.id !== 'string' || b.id !== h.id) return null;
      if (rest(b, ['add', 'remove']) !== rest(h, ['add', 'remove'])) return null;
      const lists = [logins(b.add), logins(b.remove), logins(h.add), logins(h.remove)];
      if (lists.some((l) => l === null)) return null;
      const [bAdd, bRem, hAdd, hRem] = lists.map((l) => new Set(l.map((w) => w.toLowerCase())));
      const spelled = new Map();
      for (const l of [lists[2], lists[3], lists[0], lists[1]]) for (const w of l) if (!spelled.has(w.toLowerCase())) spelled.set(w.toLowerCase(), w);
      for (const [low, w] of [...spelled.entries()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))) {
        let op = null;
        if (hRem.has(low) && !bRem.has(low)) op = 'remove';
        else if (hAdd.has(low) && !bAdd.has(low)) op = 'add';
        else if (bRem.has(low) && !hRem.has(low)) op = 'add';
        else if (bAdd.has(low) && !hAdd.has(low)) op = 'remove';
        if (op) changes.push({ login: w, op, project: b.id });
      }
    }
    if (!changes.length) return null;
    const one = changes.length === 1 && changes[0].op === 'add';
    const by = typeof author === 'string' && author ? author.toLowerCase() : null;
    const request = one && (by === null || changes[0].login.toLowerCase() === by);
    return { kind: request ? 'request' : 'change', changes };
  }

  /* The title of an access proposal (it is also the pull request's title). */
  function accessProposalTitle(o) {
    const c = o || {};
    if (c.kind === 'request') return `Edit access request: ${c.login} for ${c.name}`;
    return c.op === 'remove' ? `Edit access change: remove ${c.login} from ${c.name}` : `Edit access change: add ${c.login} to ${c.name}`;
  }
  const accessKindLabel = (kind) => (kind === 'request' ? 'Access request' : 'Access change');
  const accessChangeLine = (c) => `${c.login}: ${c.op} on ${c.project}`;

  /* A read-only member cannot open a branch, so "Request edit access" is a prefilled new issue on
     github.com instead: the same title, and a body in plain words. */
  function accessIssueUrl(o) {
    const c = o || {};
    const title = accessProposalTitle({ kind: 'request', login: c.login, name: c.name });
    const body = [
      `Please give ${c.login} edit access to the project "${c.name}" (${c.projectId}).`,
      '',
      `An admin can do this on the site: open the project page, then "${ACCESS_SECTION_LABEL}" > Add person. That opens one`,
      `proposal that adds ${c.login} to the project's \`add\` list in data/projects.json.`,
      '',
      'Why I would like access: <say what you want to change>',
    ].join('\n');
    return `${GITHUB_WEB}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  }

  /* The groups of a people.json text -> [{id, title}] ([] when unreadable). */
  function personGroups(text) {
    let doc;
    try { doc = JSON.parse(text); } catch (e) { return []; }
    return listOf(isObj(doc) ? doc.groups : null).filter((g) => isObj(g) && typeof g.id === 'string')
      .map((g) => ({ id: g.id, title: textOr(g.title, g.id) }));
  }

  /* person = {group, name, title, photo, link} -> {problem, text}: one
     person, exactly name/title/photo/link (check.py 6c), appended to the
     group; an empty photo or link is null. */
  function addPersonText(peopleText, person) {
    const f = person || {};
    const fail = (problem) => ({ problem, text: null });
    const reg = parsedRegistry('data/people.json', peopleText, 'groups');
    if (reg.problem) return fail(reg.problem);
    const group = reg.doc.groups.find((g) => isObj(g) && g.id === f.group && Array.isArray(g.people));
    if (!group) return fail(`pick a group: ${personGroups(peopleText).map((g) => g.id).join(', ') || 'the registry has none'}`);
    const name = trimmed(f.name);
    if (!name) return fail('the person needs a name');
    const photo = trimmed(f.photo) || null;
    if (photo && !/^https:\/\/\S+$/.test(photo)) {
      return fail('the photo must be an https:// address from the site\'s image list (data/cloudinary-manifest.json), or empty');
    }
    const link = trimmed(f.link) || null;
    if (link && !/^https?:\/\/\S+$/.test(link)) return fail('the link must start with http:// or https://, or be empty');
    if (group.people.some((p) => isObj(p) && p.name === name)) return fail(`'${name}' is already in ${textOr(group.title, group.id)}`);
    group.people.push({ name, title: trimmed(f.title), photo, link });
    return { problem: null, text: formatLike(peopleText, reg.doc) };
  }
  /* Round 2 (R5, Kyle 2026-10-15): the Team page's lists, edited in place (drag, the card menu, pins).
     team / alumni = the lists as shown, [{name, pinned}], in order. They become group 'active' and group
     'alumni' of data/people.json, every person keeping all their other fields; pinned true sets the pin, anything
     else removes it. Nobody may be added or dropped this way (the "+" card is the New person form).
     -> {problem: null, text} | {problem} */
  function peopleOrderText(peopleText, team, alumni) {
    const fail = (problem) => ({ problem });
    const reg = parsedRegistry('data/people.json', peopleText, 'groups');
    if (reg.problem) return fail(reg.problem);
    const groups = reg.doc.groups;
    const act = groups.find((g) => isObj(g) && g.id === 'active' && Array.isArray(g.people));
    const alu = groups.find((g) => isObj(g) && g.id === 'alumni' && Array.isArray(g.people));
    if (!act || !alu || groups.length !== 2) return fail("data/people.json must have exactly the groups 'active' and 'alumni' to be reordered here — edit it on GitHub");
    const all = new Map();
    for (const g of [act, alu]) for (const p of g.people) if (isObj(p) && typeof p.name === 'string') all.set(p.name, p);
    const shown = [...listOf(team), ...listOf(alumni)].map((x) => (isObj(x) && typeof x.name === 'string' ? x.name : ''));
    const seen = new Set();
    for (const n of shown) {
      if (seen.has(n)) return fail(`'${n}' is listed twice`);
      if (!all.has(n)) return fail(`'${n}' is not in data/people.json`);
      seen.add(n);
    }
    const missing = [...all.keys()].filter((n) => !seen.has(n));
    if (missing.length) return fail(`${missing.map((n) => `'${n}'`).join(', ')} would be dropped — nobody is removed by reordering`);
    const place = (list) => listOf(list).map((x) => {
      const p = all.get(x.name);
      if (x.pinned === true) p.pinned = true; else delete p.pinned;
      return p;
    });
    act.people = place(team);
    alu.people = place(alumni);
    return { problem: null, text: formatLike(peopleText, reg.doc) };
  }

  /* What a people.json change does, person by person (the marks on the Team page for my draft and for an
     opened people proposal): add, del (with the old group and title, so the page can show a ghost), move (the
     group changed, or the person left the order the others keep: the longest kept order stays unmarked), pin,
     unpin, edit (title, photo, link or highlight). -> [{name, mark, group?, title?}] ([] for unreadable text) */
  function peopleFlat(text) {
    try {
      const doc = JSON.parse(text);
      const out = new Map();
      listOf(doc && doc.groups).forEach((g) => listOf(isObj(g) ? g.people : null).forEach((p, i) => {
        if (isObj(p) && typeof p.name === 'string' && !out.has(p.name)) out.set(p.name, { group: String(g.id || ''), index: i, p });
      }));
      return out;
    } catch (e) { return null; }
  }
  function keptOrder(seq) {                  // indices of the longest increasing run of base positions
    const n = seq.length;
    const len = new Array(n).fill(1);
    const prev = new Array(n).fill(-1);
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < i; j += 1) if (seq[j] < seq[i] && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
    }
    let best = -1;
    for (let i = 0; i < n; i += 1) if (best < 0 || len[i] > len[best]) best = i;
    const keep = new Set();
    for (let i = best; i >= 0; i = prev[i]) keep.add(i);
    return keep;
  }
  function peopleMarks(baseText, headText) {
    const base = peopleFlat(baseText);
    const head = peopleFlat(headText);
    if (!base || !head) return [];
    const out = [];
    const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
    for (const [name, b] of base) if (!head.has(name)) out.push({ name, mark: 'del', group: b.group, title: textOr(b.p.title, '') });
    const groups = [...new Set([...head.values()].map((x) => x.group))];
    for (const g of groups) {
      const stay = [...head].filter(([n, x]) => x.group === g && base.has(n) && base.get(n).group === g).sort((a, c) => a[1].index - c[1].index);
      const keep = keptOrder(stay.map(([n]) => base.get(n).index));
      stay.forEach(([n], i) => { if (!keep.has(i)) out.push({ name: n, mark: 'move' }); });
    }
    for (const [name, x] of head) {
      const b = base.get(name);
      if (!b) { out.push({ name, mark: 'add' }); continue; }
      if (b.group !== x.group) out.push({ name, mark: 'move' });
      if (b.p.pinned !== true && x.p.pinned === true) out.push({ name, mark: 'pin' });
      if (b.p.pinned === true && x.p.pinned !== true) out.push({ name, mark: 'unpin' });
      if (['title', 'photo', 'link', 'highlight'].some((k) => !same(b.p[k], x.p[k]))) out.push({ name, mark: 'edit' });
    }
    return out;
  }
  const peopleChangeCount = (baseText, headText) => new Set(peopleMarks(baseText, headText).map((m) => m.name)).size;


  /* ---- Propose (R1-F14): one commit per proposal, through the Git Data
     API — blobs -> one tree on the base's tree -> one commit -> a new
     branch cms/<login>/<slug>-<yymmdd> and a PR, or (adding to my own open
     proposal) a fast-forward of its branch. Never main, never the machinery
     or the files the site regenerates. */
  const STALE_DRAFT_TEXT = 'changed on GitHub since you opened it. Your draft is kept: copy your text somewhere, '
    + 'press "Discard changes", open the page again and put your change back in';
  const REF_TRIES = 5;
  const PROPOSAL_BRANCH_RE = /^cms\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/;
  const isProposalBranch = (b) => isRef(b) && PROPOSAL_BRANCH_RE.test(b);
  const PROPOSE_PATH_RE = /^(content\/[A-Za-z0-9_./-]+\.md|data\/[A-Za-z0-9_./-]+\.json)$/;

  /* Lowercase letters, digits and single dashes, at most `max` (40) long;
     ß -> ss, accents stripped. '' when nothing is left. */
  function slugify(text, max) {
    const n = Number.isInteger(max) && max > 0 ? max : 40;
    return String(typeof text === 'string' ? text : '').toLowerCase().replace(/ß/g, 'ss').normalize('NFKD')
      .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '')
      .slice(0, n).replace(/-+$/, '');
  }

  /* cms/<login>/<slug of the summary>-<yymmdd, UTC>. */
  function proposalBranch(login, summary, now) {
    const who = String(typeof login === 'string' ? login : '').toLowerCase().replace(/[^a-z0-9-]/g, '')
      .replace(/^-+|-+$/g, '');
    if (!who) throw new Error('no GitHub login to name the branch after');
    const t = new Date(Number.isFinite(now) ? now : Date.now());
    return `cms/${who}/${slugify(summary) || 'edit'}-${t.toISOString().slice(2, 10).replace(/-/g, '')}`;
  }

  /* null, or why the editor will not write `p`: only content/…/*.md and
     data/*.json, never the machinery or the derived files. */
  function proposalPathProblem(p) {
    if (typeof p !== 'string' || !p) return 'a change without a file path';
    const shown = p.replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 120);
    if (isMachineryPath(p) || isDerivedPath(p)) {
      return `${shown}: the site editor never writes js/, css/, tools/, api/, cms/, .github/, search/, data/graph/, `
        + 'index.html or vercel.json';
    }
    if (p.indexOf('\\') >= 0 || p.split('/').some((s) => s === '' || s === '.' || s === '..') || !PROPOSE_PATH_RE.test(p)) {
      return `${shown}: the site editor writes only content/…/*.md and data/*.json files`;
    }
    return null;
  }

  /* {path: blob sha} -> the one tree's entries, sorted by path. Throws on a
     path the editor never writes or a missing sha. */
  function treeEntries(blobs) {
    const paths = Object.keys(isObj(blobs) ? blobs : {}).sort();
    if (!paths.length) throw new Error('nothing to propose');
    return paths.map((p) => {
      const why = proposalPathProblem(p);
      if (why) throw new Error(why);
      if (!isSha(blobs[p])) throw new Error(`${p}: GitHub gave no blob sha`);
      return { path: p, mode: '100644', type: 'blob', sha: blobs[p] };
    });
  }

  const reviewUrl = (origin, n) => `${origin}/cms/#/review/${n}`;

  /* The PR body: the summary, the pages, where it was made, and (once the
     number is known) the link to it in the editor's Review tab. */
  function prBody(o) {
    const x = o || {};
    const lines = [trimmed(x.summary), '', 'Pages:'];
    for (const p of listOf(x.pages)) if (isObj(p)) lines.push(`- ${p.label} (\`${p.file}\`)`);
    lines.push('', 'Made in the site editor.');
    if (typeof x.reviewUrl === 'string' && x.reviewUrl) lines.push(`Review it in the editor: ${x.reviewUrl}`);
    return `${lines.join('\n')}\n`;
  }

  /* My open proposals I can add to: open, opened by me, on a cms/<login>/
     branch of THIS repository, based on main. -> [{number, title, branch}] */
  function ownProposals(pulls, login) {
    const me = typeof login === 'string' ? login.toLowerCase() : '';
    if (!me) return [];
    return listOf(pulls).filter((p) => isPull(p) && p.state === 'open' && loginOf(p) === me
      && isObj(p.head) && isProposalBranch(p.head.ref) && p.head.ref.indexOf(`cms/${me}/`) === 0
      && isObj(p.head.repo) && p.head.repo.full_name === REPO_FULL && isObj(p.base) && p.base.ref === 'main')
      .map((p) => ({ number: p.number, title: String(p.title || ''), branch: p.head.ref }));
  }

  /* The dirty drafts that go into one proposal -> {changes: [{path, text,
     original, baseSha}], pages: [{label, file}], problems: [text]}. Refused:
     one path changed in two drafts, a registry draft with a problem, a path
     the editor never writes. */
  function collectProposal(list) {
    const changes = [];
    const pages = [];
    const problems = [];
    const owner = new Map();
    for (const d of listOf(list)) {
      if (!validDraft(d)) continue;
      for (const p of Object.keys(d.files).sort()) {
        const text = d.files[p];
        const original = d.originals[p];
        if (text === original) continue;
        if (owner.has(p)) {
          problems.push(`${p} is changed in two drafts (${owner.get(p)} and ${d.label}): propose one first, or discard one`);
          continue;
        }
        owner.set(p, d.label);
        const why = proposalPathProblem(p);
        const bad = !why && isRawRegistry(p) ? registryDraftProblem(p, original, text) : null;
        if (why || bad) { problems.push(why || bad.message); continue; }
        changes.push({ path: p, text, original, baseSha: d.base.sha });
        pages.push({ label: d.label, file: p });
      }
    }
    if (!changes.length && !problems.length) problems.push('Nothing to propose: no page has changes');
    return { changes, pages, problems };
  }

  /* The one builder for every write Propose sends (the allowlist admits
     them; this refuses any ref that is not a proposal branch — never main). */
  function proposeRequest(step, ctx) {
    const c = ctx || {};
    const R = REPO_API_PATH;
    const branch = () => {
      if (!isProposalBranch(c.branch)) throw new Error(`not a proposal branch: ${String(c.branch).slice(0, 80)}`);
      return c.branch;
    };
    const sha = (s, what) => {
      if (!isSha(s)) throw new Error(`GitHub gave no ${what} sha`);
      return s;
    };
    switch (step) {
      case 'blob':
        if (typeof c.content !== 'string') throw new Error('a blob needs text');
        return { method: 'POST', path: `${R}/git/blobs`, body: { content: c.content, encoding: 'utf-8' } };
      case 'tree':
        return { method: 'POST', path: `${R}/git/trees`, body: { base_tree: sha(c.baseTree, 'base tree'), tree: treeEntries(c.blobs) } };
      case 'commit':
        return { method: 'POST', path: `${R}/git/commits`,
          body: { message: String(c.message), tree: sha(c.tree, 'tree'), parents: [sha(c.parent, 'parent commit')] } };
      case 'ref':
        return { method: 'POST', path: `${R}/git/refs`, body: { ref: `refs/heads/${branch()}`, sha: sha(c.sha, 'commit') } };
      case 'move':
        return { method: 'PATCH', path: `${R}/git/refs/heads/${branch()}`, body: { sha: sha(c.sha, 'commit'), force: false } };
      case 'pull':
        return { method: 'POST', path: `${R}/pulls`, body: { title: String(c.title), head: branch(), base: 'main', body: String(c.body) } };
      case 'pull-body':
        if (!Number.isInteger(c.number) || c.number < 1) throw new Error('no proposal number');
        return { method: 'PATCH', path: `${R}/pulls/${c.number}`, body: { body: String(c.body) } };
      default:
        throw new Error(`no such step: ${String(step).slice(0, 40)}`);
    }
  }

  /* A step's failure in words. */
  function proposeFailure(what, res) {
    const words = githubWords(res.data);
    const said = words ? ` (GitHub: ${words})` : '';
    if (!res.status) return `Stopped while ${what}: GitHub could not be reached${said}.`;
    return `Stopped while ${what}: GitHub answered HTTP ${res.status}${said}.`;
  }

  /* Sends one proposal. opts: {login, summary, now, origin (for the review
     link), target: null (a new proposal from main) | {branch, number} (my
     open proposal), changes (collectProposal's), pages}.
     -> {ok: true, number, branch, added, message, signedOut?} | {ok: false, status, message}
     (signedOut: the PR opened, then GitHub answered 401 to the review-link edit).
     Before any write, each file opened at an older base commit is read at
     the base's head now and refused when it differs from the text the draft
     started from. A 401 stops at once (status 401: the page ends the session). */
  async function runPropose(client, opts) {
    const o = opts || {};
    const fail = (status, message) => ({ ok: false, status, message });
    const changes = listOf(o.changes);
    if (!changes.length) return fail(0, 'Nothing was sent: nothing to propose.');
    for (const ch of changes) {
      const why = proposalPathProblem(ch && ch.path);
      if (why) return fail(0, `Nothing was sent: ${why}.`);
      if (typeof ch.text !== 'string') return fail(0, `Nothing was sent: ${ch.path} has no text.`);
    }
    const own = o.target || null;
    if (own && (!isProposalBranch(own.branch) || !Number.isInteger(own.number))) {
      return fail(0, `Nothing was sent: not a proposal branch: ${String(own.branch).slice(0, 80)}.`);
    }
    const summary = textOr(o.summary, 'Edit pages').slice(0, 120);
    let branch = null;
    if (!own) {
      try { branch = proposalBranch(o.login, summary, o.now); } catch (e) { return fail(0, `Nothing was sent: ${e.message}.`); }
    }
    const stop = (status, message) => { throw Object.assign(new Error(message), { proposeStop: fail(status, message) }); };
    async function send(method, p, options) {
      let res;
      try {
        res = method === 'GET' ? await client.get(p, options) : await client.send(method, p, options);
      } catch (e) {
        return stop(0, `Stopped: ${e.message}.`);
      }
      if (res.status === 401) stop(401, 'Your sign-in has ended. Please sign in again.');
      return res;
    }
    const write = (req) => send(req.method, req.path, { body: req.body });
    const need = (res, what) => (res.ok ? res.data : stop(res.status, proposeFailure(what, res)));
    const R = REPO_API_PATH;
    try {
      const baseRef = own ? own.branch : 'main';
      const ref = need(await send('GET', `${R}/git/ref/heads/${baseRef}`), `reading ${baseRef}`);
      const head = ref && ref.object && ref.object.sha;
      if (!isSha(head)) stop(502, `Stopped: GitHub did not say where ${baseRef} is.`);
      const commit = need(await send('GET', `${R}/git/commits/${head}`), `reading ${baseRef}'s commit`);
      const baseTree = commit && commit.tree && commit.tree.sha;
      for (const ch of changes) {
        if (ch.baseSha === head) continue;
        const res = await send('GET', contentsPath(ch.path, head), { accept: RAW_MEDIA, raw: true });
        const now = res.status === 404 ? null : need(res, `reading ${ch.path}`);
        if (now !== ch.original) stop(409, `Not proposed: ${ch.path} ${STALE_DRAFT_TEXT}.`);
      }
      const blobs = {};
      for (const ch of changes.slice().sort((a, b) => (a.path < b.path ? -1 : 1))) {
        const b = need(await write(proposeRequest('blob', { content: ch.text })), `saving ${ch.path}`);
        blobs[ch.path] = b && b.sha;
      }
      const tree = need(await write(proposeRequest('tree', { baseTree, blobs })), 'making the tree');
      const made = need(await write(proposeRequest('commit', { message: `${summary}\n\nMade in the site editor.`,
        tree: tree && tree.sha, parent: head })), 'making the commit');
      const sha = made && made.sha;
      if (own) {
        need(await write(proposeRequest('move', { branch: own.branch, sha })), `adding to your proposal #${own.number}`);
        return { ok: true, number: own.number, branch: own.branch, added: true, message: `Added to your proposal #${own.number}.` };
      }
      let name = null;
      for (let i = 1; i <= REF_TRIES && !name; i += 1) {
        const tryName = i === 1 ? branch : `${branch}-${i}`;
        const res = await write(proposeRequest('ref', { branch: tryName, sha }));
        if (res.ok) name = tryName;
        else if (!(res.status === 422 && /already exists/i.test(githubWords(res.data)))) need(res, 'making the branch');
      }
      if (!name) stop(422, `Not proposed: the branch names ${branch} to -${REF_TRIES} are all taken. Change the summary and try again.`);
      const pages = listOf(o.pages);
      const pull = need(await write(proposeRequest('pull', { branch: name, title: summary, body: prBody({ summary, pages }) })),
        `opening the proposal (the branch ${name} is on GitHub)`);
      const n = pull && pull.number;
      if (!Number.isInteger(n)) stop(502, `Stopped: GitHub opened the proposal for ${name} but gave no number.`);
      const done = { ok: true, number: n, branch: name, added: false, message: `Proposed as #${n}.` };
      if (typeof o.origin === 'string' && o.origin) {
        try {
          await write(proposeRequest('pull-body', { number: n, body: prBody({ summary, pages, reviewUrl: reviewUrl(o.origin, n) }) }));
        } catch (e) {
          // the proposal stands without the link; a 401 still ends the session
          if (e && e.proposeStop && e.proposeStop.status === 401) done.signedOut = true;
        }
      }
      return done;
    } catch (e) {
      if (e && e.proposeStop) return e.proposeStop;
      return fail(0, `Stopped: ${(e && e.message) || e}.`);
    }
  }

  /* ---- Media (U9): the site's images on Cloudinary, through this site's
     own /api/media (api/media.js). The token goes ONLY to that same-origin
     function, as the caller's identity proof. The upload goes straight from
     the browser to Cloudinary carrying exactly what the function signed
     (its `params`, plus api_key, signature and the file) — never the token.
     Every call takes an injected fetch, so the tests use fakes.
     A new image becomes one entry of the data/cloudinary-manifest.json
     draft, {source: null, folder, public_id, url, bytes, sha256} (check.py
     6a), and is proposed together with the page that uses it: 6a refuses
     an entry nothing references and a reference with no entry. */
  const MEDIA_FUNCTION = '/api/media';
  const MEDIA_ROOT = 'hippocampus-docs/';
  const MEDIA_SUBFOLDERS = Object.freeze(['setup', 'people', 'projects', 'tools', 'brand']);
  const MANIFEST_FILE = 'data/cloudinary-manifest.json';
  const MANIFEST_KEY = 'data/cloudinary-manifest';
  const MANIFEST_LABEL = 'Site image list';
  const MEDIA_MAX_BYTES = 5 * 1024 * 1024;
  const MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  const SIZE_HINT_TEXT = 'Images only (PNG, JPEG, GIF or WebP). Keep images under 5 MB.';
  const REMOVE_FIRST_TEXT = 'remove it from the page first, merge, then delete';
  const IN_USE_TEXT = `The site uses this image: ${REMOVE_FIRST_TEXT}.`;
  const IN_DRAFT_TEXT = 'This image is in your image-list draft: propose it with the page that uses it, '
    + 'or discard that draft first.';
  const THUMB_TRANSFORM = 'c_limit,w_240';
  const CLOUD_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const MEDIA_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
  const SIGNED_KEYS = Object.freeze(['asset_folder', 'folder', 'overwrite', 'public_id', 'timestamp']);
  const DELIVERY_URL_RE = /^https:\/\/res\.cloudinary\.com\/[A-Za-z0-9_-]+\/image\/upload\/[^\s()<>"'\\]+$/;

  /* A delivery URL with the thumbnail transformation inserted after
     /image/upload/ (check.py matches on the public_id, so it still
     resolves); null for anything that is not a Cloudinary image URL. */
  function thumbUrl(url) {
    if (typeof url !== 'string' || !DELIVERY_URL_RE.test(url)) return null;
    const at = url.indexOf('/image/upload/') + '/image/upload/'.length;
    return `${url.slice(0, at)}${THUMB_TRANSFORM}/${url.slice(at)}`;
  }

  /* The manifest's text -> its object, or null when it is not one. */
  function parseManifest(text) {
    try {
      const doc = JSON.parse(text);
      return isObj(doc) && Array.isArray(doc.assets) ? doc : null;
    } catch (e) { return null; }
  }

  /* The entries of a manifest object (or null), each with a string public_id. */
  const manifestAssets = (doc) => listOf(isObj(doc) ? doc.assets : null)
    .filter((a) => isObj(a) && typeof a.public_id === 'string');

  const findBySha = (assets, sha) => listOf(assets).find((a) => isObj(a) && a.sha256 === sha) || null;

  /* Why an asset may not be renamed or deleted, or null when it may: only
     ids under hippocampus-docs/ that the live site does not use (the
     gateway enforces the same; this says it before any call), and not an
     image of my own unproposed image-list draft. */
  function mediaChangeProblem(publicId, liveAssets, draftAssets) {
    if (typeof publicId !== 'string' || publicId.indexOf(MEDIA_ROOT) !== 0) {
      return `This image is outside the site's folder (${MEDIA_ROOT}); the editor does not change it.`;
    }
    if (listOf(liveAssets).some((a) => isObj(a) && a.public_id === publicId)) return IN_USE_TEXT;
    if (listOf(draftAssets).some((a) => isObj(a) && a.public_id === publicId)) return IN_DRAFT_TEXT;
    return null;
  }

  /* A file chosen for upload: an image type, not empty, under 5 MB. */
  function mediaFileProblem(file) {
    if (!file || typeof file.size !== 'number' || typeof file.arrayBuffer !== 'function') return 'Choose an image file first.';
    const name = String(file.name || 'the file');
    if (MEDIA_TYPES.indexOf(file.type) < 0) return `${name} is not a PNG, JPEG, GIF or WebP image.`;
    if (file.size <= 0) return `${name} is empty.`;
    if (file.size > MEDIA_MAX_BYTES) {
      return `${name} is ${(file.size / 1048576).toFixed(1)} MB. Keep images under 5 MB: make it smaller and choose it again.`;
    }
    return null;
  }

  const hexOf = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

  /* The words for a gateway answer that is not a success. */
  function mediaFailure(status, data) {
    const said = isObj(data) && typeof data.error === 'string' ? data.error.slice(0, 200) : '';
    if (status === 409) return IN_USE_TEXT;
    if (status === 401) return 'Your sign-in has ended. Please sign in again.';
    if (status === 429) return 'Too many image requests: wait a minute and try again.';
    if (status === 400 && /not configured/.test(said)) {
      return 'Media is not set up on this site yet (its Cloudinary keys are missing). Ask Desert Mango.';
    }
    if (!status) return 'The media service could not be reached.';
    return `The media service answered HTTP ${status}${said ? ` (${said})` : ''}.`;
  }

  /* The client of /api/media: POST {action, …} with the bearer, same
     origin only. Each call -> {ok, status, data, message}. */
  function createMediaClient(deps) {
    const d = deps || {};
    if (typeof d.fetch !== 'function') throw new Error('media client: fetch is required');
    if (typeof d.token !== 'string' || !d.token) throw new Error('media client: a token is required');
    async function call(body) {
      let res;
      try {
        res = await d.fetch(MEDIA_FUNCTION, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (e) {
        return { ok: false, status: 0, data: null, message: mediaFailure(0, null) };
      }
      const data = await readJson(res);
      const ok = Boolean(res.ok) && isObj(data);
      return { ok, status: Number(res.status) || 0, data: ok ? data : null,
        message: ok ? '' : mediaFailure(Number(res.status) || 0, data) };
    }
    return Object.freeze({
      sign: (subfolder, filename) => call({ action: 'sign', subfolder, filename }),
      list: (cursor) => call(cursor ? { action: 'list', cursor } : { action: 'list' }),
      destroy: (publicId) => call({ action: 'destroy', public_id: publicId }),
      rename: (from, to) => call({ action: 'rename', from, to }),
    });
  }

  /* The gateway's `sign` answer -> the upload: {url, fields: [[name,
     value]], cloud, folder, expectedId} or {problem}. `fields` is exactly
     the signed params (timestamp included), then api_key and signature;
     the file is appended by the caller. The answer is checked before any
     byte leaves: the folder it signed is the one picked, overwrite=false,
     no unknown parameter. */
  function uploadPlan(signed, subfolder) {
    const fail = (problem) => ({ problem });
    if (!isObj(signed) || !isObj(signed.params)) return fail('The media service sent no upload parameters.');
    const p = signed.params;
    const cloud = signed.cloud_name;
    if (typeof cloud !== 'string' || !CLOUD_NAME_RE.test(cloud)) return fail('The media service sent no Cloudinary account name.');
    const key = typeof signed.api_key === 'number' ? String(signed.api_key) : signed.api_key;
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(key)) return fail('The media service sent no API key.');
    if (typeof signed.signature !== 'string' || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(signed.signature)) {
      return fail('The media service sent no signature.');
    }
    const names = Object.keys(p);
    if (names.some((k) => SIGNED_KEYS.indexOf(k) < 0 || typeof p[k] !== 'string')) {
      return fail('The media service signed parameters the editor does not know; nothing was uploaded.');
    }
    const folder = `${MEDIA_ROOT}${subfolder}`;
    let expectedId = null;
    if (p.folder === folder && !('asset_folder' in p) && MEDIA_SLUG_RE.test(String(p.public_id))) {
      expectedId = `${folder}/${p.public_id}`;                                   // fixed folder mode
    } else if (p.asset_folder === folder && !('folder' in p)
      && new RegExp(`^${folder}/[a-z0-9-]{1,80}$`).test(String(p.public_id))) {
      expectedId = p.public_id;                                                  // dynamic folder mode
    }
    if (MEDIA_SUBFOLDERS.indexOf(subfolder) < 0 || !expectedId) {
      return fail(`The media service signed another place than ${folder}; nothing was uploaded.`);
    }
    if (p.overwrite !== 'false') return fail('The upload must never replace an existing image; nothing was uploaded.');
    const ts = 'timestamp' in p ? p.timestamp : String(signed.timestamp);
    if (!/^[0-9]{1,12}$/.test(ts) || (signed.timestamp !== undefined && String(signed.timestamp) !== ts)) {
      return fail('The media service sent a bad timestamp.');
    }
    const fields = names.sort().map((k) => [k, p[k]]);
    if (!('timestamp' in p)) fields.push(['timestamp', ts]);
    fields.push(['api_key', key], ['signature', signed.signature]);
    return { problem: null, url: `https://api.cloudinary.com/v1_1/${cloud}/image/upload`, fields, cloud, folder, expectedId };
  }

  /* Cloudinary's upload answer -> the manifest entry, keys in the
     manifest's own order: {source: null, folder, public_id, url, bytes,
     sha256}. The image must have landed where it was signed to, as a new
     image (overwrite=false answers an existing one with existing: true). */
  function manifestEntry(res, plan, sha) {
    const fail = (problem) => ({ problem, entry: null });
    if (!isObj(res)) return fail('Cloudinary sent no answer.');
    if (res.existing === true) {
      return fail(`An image named ${plan.expectedId.split('/').pop()} is already in ${plan.folder}. Rename your file and choose it again.`);
    }
    if (res.public_id !== plan.expectedId) return fail('Cloudinary stored the image under another name than was signed.');
    const url = res.secure_url;
    if (typeof url !== 'string' || !DELIVERY_URL_RE.test(url)
      || url.indexOf(`https://res.cloudinary.com/${plan.cloud}/image/upload/`) !== 0) {
      return fail('Cloudinary sent no usable https address for the image.');
    }
    if (!Number.isInteger(res.bytes) || res.bytes <= 0) return fail('Cloudinary did not say how big the image is.');
    if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) return fail('The image has no sha256.');
    return { problem: null,
      entry: { source: null, folder: plan.folder, public_id: plan.expectedId, url, bytes: res.bytes, sha256: sha } };
  }

  /* One entry appended to the manifest text, written the way the file is. */
  function addManifestEntry(text, entry) {
    const doc = parseManifest(text);
    if (!doc) return { problem: `${MANIFEST_FILE} could not be read.`, text: null };
    for (const k of ['public_id', 'url', 'sha256']) {
      if (doc.assets.some((a) => isObj(a) && a[k] === entry[k])) {
        return { problem: `${MANIFEST_FILE} already has an image with this ${k}.`, text: null };
      }
    }
    doc.assets.push(entry);
    return { problem: null, text: formatLike(text, doc) };
  }

  /* Upload one image. deps: {media (createMediaClient), fetch (Cloudinary's
     side), FormData, subtle (crypto.subtle)}; o: {file, subfolder, live
     (the live manifest's assets), draftText (the manifest draft's text)}.
     -> {kind: 'problem', message, status?} | {kind: 'duplicate', entry,
     where: 'site'|'draft'} (nothing uploaded) | {kind: 'uploaded', entry,
     text (the manifest draft with the entry)}. Order: file check -> sha256
     -> duplicate check -> sign -> the plan check -> the direct upload. */
  async function runUpload(deps, o) {
    const problem = (message, status) => ({ kind: 'problem', message, status: status || 0 });
    if (MEDIA_SUBFOLDERS.indexOf(o.subfolder) < 0) return problem(`Pick a folder: ${MEDIA_SUBFOLDERS.join(', ')}.`);
    const bad = mediaFileProblem(o.file);
    if (bad) return problem(bad);
    const draft = parseManifest(o.draftText);
    if (!draft) return problem(`${MANIFEST_FILE} could not be read.`);
    const sha = hexOf(await deps.subtle.digest('SHA-256', await o.file.arrayBuffer()));
    const onSite = findBySha(o.live, sha);
    if (onSite) return { kind: 'duplicate', entry: onSite, where: 'site' };
    const inDraft = findBySha(manifestAssets(draft), sha);
    if (inDraft) return { kind: 'duplicate', entry: inDraft, where: 'draft' };
    const signed = await deps.media.sign(o.subfolder, String(o.file.name || 'image'));
    if (!signed.ok) return problem(signed.message, signed.status);
    const plan = uploadPlan(signed.data, o.subfolder);
    if (plan.problem) return problem(plan.problem);
    if (typeof draft.cloud === 'string' && draft.cloud !== plan.cloud) {
      return problem(`The media service signs for Cloudinary account '${plan.cloud}', but the site's images are on '${draft.cloud}'.`);
    }
    const form = new deps.FormData();
    for (const [k, v] of plan.fields) form.append(k, v);
    form.append('file', o.file);
    let res;
    try {
      res = await deps.fetch(plan.url, { method: 'POST', body: form });
    } catch (e) {
      return problem('Cloudinary could not be reached; nothing was uploaded.');
    }
    const data = await readJson(res);
    if (!res.ok) {
      const said = isObj(data) && isObj(data.error) && typeof data.error.message === 'string'
        ? ` (${data.error.message.slice(0, 200)})` : '';
      return problem(`Cloudinary refused the upload: HTTP ${res.status}${said}.`);
    }
    const made = manifestEntry(data, plan, sha);
    if (made.problem) return problem(made.problem);
    const added = addManifestEntry(o.draftText, made.entry);
    if (added.problem) return problem(added.problem);
    return { kind: 'uploaded', entry: made.entry, text: added.text };
  }

  /* `![alt](url)` for a site image. The alt text is asked for and never
     empty; brackets and line breaks are taken out of it. */
  function imageMarkdown(alt, url) {
    const text = typeof alt === 'string' ? alt.replace(/[[\]\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
    if (typeof url !== 'string' || !DELIVERY_URL_RE.test(url)) return { problem: 'Pick an image first.', text: null };
    if (!text) return { problem: 'Describe the image first: its alt text says what it shows.', text: null };
    return { problem: null, text: `![${text}](${url})` };
  }

  /* `insert` put in place of the selection [start, end); the cursor ends after it. */
  function insertText(text, start, end, insert) {
    const t = String(text || '');
    const a = Math.max(0, Math.min(Number(start) || 0, t.length));
    const b = Math.max(a, Math.min(Number(end) || 0, t.length));
    const at = a + insert.length;
    return { text: t.slice(0, a) + insert + t.slice(b), selStart: at, selEnd: at };
  }

  // --------------------------------------------- the block model (U5) ---

  /* Plan D-E. A page's blocks are the TOP-LEVEL tokens of the vendored
     marked lexer (js/marked.min.js, the same parser that renders the page),
     re-anchored to real offsets in the ORIGINAL text. marked normalizes
     before it lexes (CR LF -> LF, leading tabs -> spaces) and drops reference
     definitions ([x]: url), so its `raw` pieces do not always add up to the
     file. THE ANCHORING RULE IS THE GUARD: each token's raw must be found
     exactly at the running cursor, or right after a gap made only of
     reference-definition lines and blank lines (the gap then belongs to the
     block before it). Anything else — a normalized CR or tab line, a raw
     that is nowhere, a gap with other content — turns block editing OFF for
     that text: splitBlocks answers {ok: false, reason} and the editor offers
     only "Edit whole page as Markdown". So every block it does answer is
     {start, end, text: original.slice(start, end), kind, type}, and the
     blocks join back to the text byte for byte.

     Wrappers. Token runs merge while an HTML <div>, <details> or <figure>
     is still open at the top level (tags counted the way the browser's tree
     builder sees them: in HTML blocks and in inline HTML of paragraphs and
     headings, never inside code; a close tag pops back to its opener; a list,
     quote or table closes what opened inside it). So an adm box, a tabs
     group, an img-grid or a <details> is ONE block with everything inside
     it, and an unclosed one takes the rest of the page — a sentinel is
     never put where the browser would nest it. (This covers the plan's
     "column-0 open tag" rule and the indented and inline spellings too.)

     Kinds: heading, paragraph, list, code, table, html (one balanced HTML
     block), wrapper (a merged run), image (a paragraph that is only an
     image), space (blank lines). Other token types (hr, blockquote) are
     'paragraph'; `type` keeps marked's own name. */
  const BLOCK_KINDS = Object.freeze(['heading', 'paragraph', 'list', 'code', 'table', 'html', 'wrapper', 'image', 'space']);
  const WRAPPER_TAG_RE = /<(\/?)(div|details|figure)(?=[\s/>])[^>]*>/gi;
  const DEF_LINE_RE = /^ {0,3}\[(?:[^\]\\\n]|\\.)+\]:[ \t]*(?:<[^>\n]*>|\S+)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*$/;
  const SENTINEL_PREFIX_RE = /^[A-Za-z0-9_-]{8,64}$/;
  const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

  /* marked: the page's global in a browser (index.html and the editor load
     js/marked.min.js), the vendored file itself in node. */
  let lexerFn = null;
  function defaultLexer() {
    if (lexerFn) return lexerFn;
    let m = null;
    if (typeof marked !== 'undefined' && marked && typeof marked.lexer === 'function') m = marked;  // eslint-disable-line no-undef
    else if (typeof require === 'function' && typeof __dirname === 'string') {
      try { m = require(`${__dirname}/marked.min.js`).marked; } catch (e) { m = null; }  // eslint-disable-line no-undef
    }
    if (!m) return null;
    lexerFn = (src) => m.lexer(src);
    return lexerFn;
  }

  /* [from, to) of text holds only blank lines and reference definitions
     (a definition only where a line starts). */
  function isDefGap(text, from, to) {
    if (from === to) return true;
    const lines = text.slice(from, to).split('\n');
    const lineStart = from === 0 || text.charAt(from - 1) === '\n';
    const last = lines.length - 1;
    return lines.every((ln, i) => /^[ \t]*$/.test(ln)
      || (i !== last && (i > 0 || lineStart) && DEF_LINE_RE.test(ln)));
  }

  function guardReason(text, at) {
    if (/\r/.test(text)) return 'this page has Windows line endings (CR LF); block editing needs plain LF line endings';
    if (/^ *\t/m.test(text)) return 'a line of this page starts with a tab; block editing needs spaces';
    const line = text.slice(0, at).split('\n').length;
    return `the Markdown parser reads this page differently from its text near line ${line}`;
  }

  /* Find raw at the cursor, or after a gap of blank and definition lines. */
  function anchor(text, raw, cursor) {
    if (text.startsWith(raw, cursor)) return cursor;
    for (let at = text.indexOf(raw, cursor), n = 0; at >= 0 && n < 1000; at = text.indexOf(raw, at + 1), n += 1) {
      if (isDefGap(text, cursor, at)) return at;
    }
    return -1;
  }

  const CLOSES_ITSELF = Object.freeze(['list', 'blockquote', 'table']);

  /* The wrapper tags a token opens and closes, applied to `stack` (the open
     wrapper names, outermost first). */
  function scanWrapperTags(tok, stack) {
    if (!tok || typeof tok !== 'object' || tok.type === 'code' || tok.type === 'codespan') return stack;
    if (CLOSES_ITSELF.indexOf(tok.type) >= 0) return stack;
    if (tok.type === 'html') {
      const s = stack.slice();
      for (const m of String(tok.raw || '').matchAll(WRAPPER_TAG_RE)) {
        const name = m[2].toLowerCase();
        if (!m[1]) s.push(name);
        else if (s.lastIndexOf(name) >= 0) s.length = s.lastIndexOf(name);
      }
      return s;
    }
    let s = stack;
    for (const child of listOf(tok.tokens)) s = scanWrapperTags(child, s);
    return s;
  }

  function isImageOnly(tok) {
    const parts = listOf(tok.tokens).filter((t) => t && !(t.type === 'text' && !String(t.raw || '').trim()) && t.type !== 'br');
    if (parts.length !== 1) return false;
    const p = parts[0];
    if (p.type === 'image') return true;
    return p.type === 'link' && listOf(p.tokens).length === 1 && p.tokens[0].type === 'image';
  }

  /* One image block's Markdown -> {alt, title, tail} | null, for replacing its file (V2, Kyle 2026-10-14):
     alt is the source text between ![ and ] (kept byte for byte), title the parsed title (any delimiter
     CommonMark allows: "…", '…', (…)) or '', tail the trailing whitespace. A plain image only (not a
     linked one); a reference-style image (![alt][ref], its definition elsewhere) counts, title ''. The
     caller writes it back as an inline image: ![alt](new-address "title"). */
  const IMAGE_ALT_RE = /^!\[((?:\\.|[^\]\\])*)\]/;
  const IMAGE_REF_RE = /^!\[((?:\\.|[^\]\\])*)\]\[[^\]]*\]\s*$/;
  function imageParts(md) {
    if (typeof md !== 'string' || md.length > 4000) return null;
    const alt = IMAGE_ALT_RE.exec(md);
    if (!alt) return null;
    const tail = /\s*$/.exec(md)[0];
    if (IMAGE_REF_RE.test(md)) return { alt: alt[1], title: '', tail };
    const lex = defaultLexer();
    if (!lex) return null;
    let toks;
    try { toks = lex(md); } catch (e) { return null; }
    const real = listOf(toks).filter((t) => t && t.type !== 'space');
    if (real.length !== 1 || real[0].type !== 'paragraph' || !isImageOnly(real[0])) return null;
    const img = listOf(real[0].tokens).find((t) => t && t.type === 'image');
    if (!img) return null;                                    // a linked image: its click is the link's
    // marked hands the title HTML-escaped: back to its characters (imageWith escapes for Markdown)
    const title = typeof img.title === 'string' ? img.title.replace(/&(quot|#39|lt|gt|amp);/g,
      (x, k) => ({ quot: '"', '#39': "'", lt: '<', gt: '>', amp: '&' })[k]) : '';
    return { alt: alt[1], title, tail };
  }
  /* The image Markdown for parts with a new address. */
  const imageWith = (parts, url) => `![${parts.alt}](${/[\s()<>]/.test(url) ? `<${url}>` : url}${parts.title
    ? ` "${parts.title.replace(/["\\]/g, '\\$&')}"` : ''})${parts.tail}`;

  function kindOf(tok) {
    const t = tok.type;
    if (t === 'paragraph') return isImageOnly(tok) ? 'image' : 'paragraph';
    return ['heading', 'list', 'code', 'table', 'html', 'space'].indexOf(t) >= 0 ? t : 'paragraph';
  }

  /* -> {ok: true, reason: null, blocks} | {ok: false, reason, blocks: []}.
     opts.lexer replaces marked (tests only). */
  function splitBlocks(text, opts) {
    const off = (reason) => ({ ok: false, reason, blocks: [] });
    if (typeof text !== 'string') return off('there is no page text to split');
    if (text === '') return { ok: true, reason: null, blocks: [] };
    if (/\r/.test(text)) return off(guardReason(text, 0));
    const lexer = opts && typeof opts.lexer === 'function' ? opts.lexer : defaultLexer();
    if (!lexer) return off('the Markdown parser is not loaded');
    let tokens;
    try { tokens = lexer(text); } catch (e) { return off('the Markdown parser could not read this page'); }
    if (!Array.isArray(tokens)) return off('the Markdown parser could not read this page');
    const pieces = [];
    let cursor = 0;
    for (const tok of tokens) {
      const raw = tok && typeof tok.raw === 'string' ? tok.raw : '';
      if (!raw) continue;
      const at = anchor(text, raw, cursor);
      if (at < 0) return off(guardReason(text, cursor));
      if (at > cursor && pieces.length) pieces[pieces.length - 1].end = at;
      pieces.push({ start: pieces.length ? at : 0, end: at + raw.length, tok });
      cursor = at + raw.length;
    }
    if (cursor < text.length) {
      if (!isDefGap(text, cursor, text.length)) return off(guardReason(text, cursor));
      if (pieces.length) pieces[pieces.length - 1].end = text.length;
      else pieces.push({ start: 0, end: text.length, tok: { type: 'space' } });
    }
    const blocks = [];
    let stack = [];
    let run = null;
    for (const p of pieces) {
      stack = scanWrapperTags(p.tok, stack);
      if (run) {
        run.end = p.end;
        if (!stack.length) { blocks.push(run); run = null; }
      } else if (stack.length) {
        run = { start: p.start, end: p.end, kind: 'wrapper', type: 'wrapper' };
      } else {
        blocks.push({ start: p.start, end: p.end, kind: kindOf(p.tok), type: String(p.tok.type) });
      }
    }
    if (run) blocks.push(run);
    return { ok: true, reason: null,
      blocks: blocks.map((b) => ({ start: b.start, end: b.end, text: text.slice(b.start, b.end), kind: b.kind, type: b.type })) };
  }

  // ----------------------------------------------------- the span editor ---

  /* Plan D-D: an edit is pinned to a character SPAN, not a block index. The
     parent records spanOf(draft, index) when a block is selected; every
     change is replaceSpan(draft, span, newText), whose answer carries the
     moved span; the block list is re-split for display only. So typing an
     unclosed fence or an opening <div class="adm…"> never swallows the rest
     of the page: the text outside the span stays byte-identical. */
  function spanOf(text, index) {
    const s = splitBlocks(text);
    if (!s.ok || !Number.isInteger(index) || index < 0 || index >= s.blocks.length) return null;
    return { start: s.blocks[index].start, end: s.blocks[index].end };
  }

  function replaceSpan(text, span, insert) {
    const t = text;
    const ok = typeof t === 'string' && typeof insert === 'string' && span && typeof span === 'object'
      && Number.isInteger(span.start) && Number.isInteger(span.end)
      && span.start >= 0 && span.start <= span.end && span.end <= t.length;
    if (!ok) throw new Error('replaceSpan: a span {start, end} inside the text and a string are needed');
    return { text: t.slice(0, span.start) + insert + t.slice(span.end),
      span: { start: span.start, end: span.start + insert.length } };
  }

  const trailingNewlines = (s) => s.length - s.replace(/\n+$/, '').length;
  const leadingNewlines = (s) => s.length - s.replace(/^\n+/, '').length;

  /* head + tail with a blank line between them when both have text, so two
     blocks never glue into one (a paragraph, then a paragraph). Adds only
     newlines. */
  function joinParts(head, tail) {
    if (!head || !tail) return head + tail;
    const have = trailingNewlines(head) + leadingNewlines(tail);
    return have >= 2 ? head + tail : head + '\n'.repeat(2 - have) + tail;
  }

  /* A snippet kind (a SNIPPETS key) or Markdown text -> {body, select}. */
  function snippetBody(snippet) {
    if (typeof snippet !== 'string') throw new Error('insertAt: a snippet kind or Markdown text is needed');
    if (Object.prototype.hasOwnProperty.call(SNIPPET_CATALOG, snippet)) {
      const sn = SNIPPET_CATALOG[snippet];
      const body = (sn.before + sn.placeholder + sn.after).replace(/\s+$/, '');
      return { body, select: { from: sn.before.length, to: sn.before.length + sn.placeholder.length } };
    }
    const body = snippet.replace(/\s+$/, '');
    return { body, select: { from: 0, to: body.length } };
  }

  /* The snippet (or Markdown) as its own block at the boundary BEFORE block
     `index` (index === blocks.length: the end). -> {text, span (the new
     block), select (the placeholder, to select in the textarea)} | null. */
  function insertAt(text, index, snippet) {
    const { body, select } = snippetBody(snippet);
    const s = splitBlocks(text);
    if (!s.ok || !Number.isInteger(index) || index < 0 || index > s.blocks.length) return null;
    const at = index < s.blocks.length ? s.blocks[index].start : text.length;
    const head = text.slice(0, at);
    const tail = text.slice(at);
    const lead = !head ? '' : '\n'.repeat(Math.max(0, 2 - trailingNewlines(head)));
    const trail = !tail || /^\n/.test(tail) ? '\n' : '\n\n';
    const start = at + lead.length;
    return { text: head + lead + body + trail + tail,
      span: { start, end: start + body.length + 1 },
      select: { start: start + select.from, end: start + select.to } };
  }

  /* Units: a non-space block and the blank lines after it (a page that
     starts with blank lines has them as a unit of their own).
     -> [{from, to (block indices, inclusive), start, end}] */
  function unitsOf(blocks) {
    const units = [];
    blocks.forEach((b, i) => {
      const u = units[units.length - 1];
      if (b.kind === 'space' && u) { u.to = i; u.end = b.end; } else units.push({ from: i, to: i, start: b.start, end: b.end });
    });
    return units;
  }

  function unitAt(units, index) {
    return units.findIndex((u) => index >= u.from && index <= u.to);
  }

  /* Rebuild from units in a new order: pairs that were neighbours keep
     their bytes; a new joint gets a blank line. */
  function joinUnits(text, units, order) {
    let out = '';
    order.forEach((k, n) => {
      const piece = text.slice(units[k].start, units[k].end);
      out = n > 0 && order[n - 1] === k - 1 ? out + piece : joinParts(out, piece);
    });
    return out;
  }

  /* Block `from` (with its blank lines) moved to before block `to`
     (to === blocks.length: the end). -> text | null. */
  function moveBlock(text, from, to) {
    const s = splitBlocks(text);
    const n = s.blocks.length;
    if (!s.ok || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= n || to < 0 || to > n) return null;
    const units = unitsOf(s.blocks);
    const u = unitAt(units, from);
    let v = to === n ? units.length : unitAt(units, to);
    if (to < n && units[v].from !== to) v += 1;          // inside a unit's blank lines: after it
    if (v === u || v === u + 1) return text;
    const order = units.map((x, k) => k).filter((k) => k !== u);
    order.splice(v > u ? v - 1 : v, 0, u);
    return joinUnits(text, units, order);
  }

  /* Block `index` removed (a non-space block takes its blank lines with
     it). -> text | null. */
  function deleteBlock(text, index) {
    const s = splitBlocks(text);
    if (!s.ok || !Number.isInteger(index) || index < 0 || index >= s.blocks.length) return null;
    const b = s.blocks[index];
    let end = b.end;
    if (b.kind !== 'space') {
      for (let j = index + 1; j < s.blocks.length && s.blocks[j].kind === 'space'; j += 1) end = s.blocks[j].end;
    }
    return joinParts(text.slice(0, b.start), text.slice(end));
  }

  /* D-E marks. The page's Markdown with an id-sentinel before every
     non-space block i:  \n\n<div id="hcb-<prefix>-<i>"></div>\n\n
     (the sanitizer keeps div + id; an hc-* CLASS would be dropped, and the
     per-load prefix is what content cannot guess). `spans` (optional) are
     the blocks to mark, e.g. overlayOnMain's entries: sentinel i goes before
     spans[i]. -> text | null (the page does not split: no block editing). */
  const sentinelId = (prefix, i) => `hcb-${prefix}-${i}`;
  const sentinel = (prefix, i) => `\n\n<div id="${sentinelId(prefix, i)}"></div>\n\n`;

  function withSentinels(text, prefix, spans) {
    if (typeof prefix !== 'string' || !SENTINEL_PREFIX_RE.test(prefix)) {
      throw new Error('withSentinels: the prefix must be 8-64 characters of [A-Za-z0-9_-]');
    }
    let marks;
    if (spans === undefined) {
      const s = splitBlocks(text);
      if (!s.ok) return null;
      marks = s.blocks.map((b, i) => ({ at: b.start, i, space: b.kind === 'space' })).filter((m) => !m.space);
    } else {
      let last = 0;
      marks = listOf(spans).map((sp, i) => {
        const good = sp && Number.isInteger(sp.start) && Number.isInteger(sp.end)
          && sp.start >= last && sp.start <= sp.end && sp.end <= text.length;
        if (!good) throw new Error('withSentinels: spans must be ordered, non-overlapping and inside the text');
        last = sp.end;
        return { at: sp.start, i };
      });
    }
    let out = '';
    let pos = 0;
    for (const m of marks) {
      out += text.slice(pos, m.at) + sentinel(prefix, m.i);
      pos = m.at;
    }
    return out + text.slice(pos);
  }

  // ------------------------------------------------- diff + overlay (D-F) ---

  const blockCore = (b) => b.text.replace(/\s+$/, '');

  /* LCS over the non-space blocks' text (trailing blank lines ignored). A
     run of deletions and additions between two equal blocks pairs up, in
     order, as 'change'; the rest stay 'del' / 'add'. a and b are block
     indices into the split of each text (null on the side that has none). */
  function diffSplits(sa, sb) {
    const A = sa.blocks.map((b, i) => ({ i, key: blockCore(b), space: b.kind === 'space' })).filter((x) => !x.space);
    const B = sb.blocks.map((b, i) => ({ i, key: blockCore(b), space: b.kind === 'space' })).filter((x) => !x.space);
    const n = A.length;
    const m = B.length;
    const w = m + 1;
    const dp = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i * w + j] = A[i].key === B[j].key ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    const out = [];
    let dels = [];
    let adds = [];
    const flush = () => {
      const k = Math.min(dels.length, adds.length);
      for (let x = 0; x < k; x += 1) out.push({ status: 'change', a: dels[x], b: adds[x] });
      dels.slice(k).forEach((a) => out.push({ status: 'del', a, b: null }));
      adds.slice(k).forEach((b) => out.push({ status: 'add', a: null, b }));
      dels = [];
      adds = [];
    };
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && A[i].key === B[j].key) {
        flush();
        out.push({ status: 'same', a: A[i].i, b: B[j].i });
        i += 1;
        j += 1;
      } else if (j >= m || (i < n && dp[(i + 1) * w + j] >= dp[i * w + j + 1])) {
        dels.push(A[i].i);
        i += 1;
      } else {
        adds.push(B[j].i);
        j += 1;
      }
    }
    flush();
    return out;
  }

  /* -> [{status: 'same'|'add'|'del'|'change', a, b}] | null (a text that
     does not split). */
  function blockDiff(a, b) {
    const sa = splitBlocks(a);
    const sb = splitBlocks(b);
    return sa.ok && sb.ok ? diffSplits(sa, sb) : null;
  }

  /* The PR's block diff (merge base -> head) drawn over the CURRENT main.
     -> {text, overlay, conflicts} | null (a text that does not split: no
     overlay is drawn). overlay has one entry per composite block, in order:
       {source: 'main'|'pr-add'|'pr-del'|'conflict', mainIndex, pr, text, start, end}
     mainIndex is the block index in main's split (null for 'pr-add'); pr is
     null for a plain main block, else {base, head} (block indices in the
     merge base's and the head's splits, null where there is none). A block
     the PR deleted or replaced is kept, as 'pr-del', BEFORE its replacement.
     A block that main changed (or deleted) since the merge base AND the PR
     changed (or deleted) is never guessed: it is main's version, as
     'conflict' (nothing drawn when main deleted it), and listed in
     conflicts as {mainIndex, base, head}. The composite text is the
     entries' text (trailing blank lines trimmed) joined by blank lines;
     start/end locate each entry in it (withSentinels(text, prefix, overlay)
     marks exactly these blocks). */
  function overlayOnMain(mainText, baseText, headText) {
    const M = splitBlocks(mainText);
    const Bs = splitBlocks(baseText);
    const H = splitBlocks(headText);
    if (!M.ok || !Bs.ok || !H.ok) return null;
    const prOf = new Map();
    const prAdds = new Map();
    let anchorAt = -1;
    for (const d of diffSplits(Bs, H)) {
      if (d.a !== null) { prOf.set(d.a, d); anchorAt = d.a; }
      if (d.status === 'add') {
        if (!prAdds.has(anchorAt)) prAdds.set(anchorAt, []);
        prAdds.get(anchorAt).push(d.b);
      }
    }
    // Already live (plan-u5): the blocks main itself added after each base block, so a
    // PR add that main already holds at that anchor is drawn as main's, never twice.
    const mainSplit = diffSplits(Bs, M);
    const mainAdds = new Map();
    anchorAt = -1;
    for (const d of mainSplit) {
      if (d.a !== null) anchorAt = d.a;
      if (d.status === 'add') {
        if (!mainAdds.has(anchorAt)) mainAdds.set(anchorAt, []);
        mainAdds.get(anchorAt).push(blockCore(M.blocks[d.b]));
      }
    }
    const entries = [];
    const conflicts = [];
    const main = (mi) => entries.push({ source: 'main', mainIndex: mi, pr: null, text: blockCore(M.blocks[mi]) });
    const addsAfter = (baseIndex) => {
      const held = listOf(mainAdds.get(baseIndex)).slice();
      listOf(prAdds.get(baseIndex)).forEach((h) => {
        const at = held.indexOf(blockCore(H.blocks[h]));
        if (at >= 0) { held.splice(at, 1); return; }
        entries.push({ source: 'pr-add', mainIndex: null, pr: { base: baseIndex < 0 ? null : baseIndex, head: h },
          text: blockCore(H.blocks[h]) });
      });
    };
    addsAfter(-1);
    for (const d of mainSplit) {
      if (d.status === 'add') { main(d.b); continue; }
      const p = prOf.get(d.a) || { status: 'same', b: null };
      const prHead = p.status === 'change' ? p.b : null;
      if (d.status === 'same') {
        if (p.status === 'same') main(d.b);
        else {
          entries.push({ source: 'pr-del', mainIndex: d.b, pr: { base: d.a, head: prHead }, text: blockCore(M.blocks[d.b]) });
          if (prHead !== null) {
            entries.push({ source: 'pr-add', mainIndex: null, pr: { base: d.a, head: prHead }, text: blockCore(H.blocks[prHead]) });
          }
        }
      } else if (p.status === 'same') {
        if (d.status === 'change') main(d.b);
      } else if (d.status === 'change' && prHead !== null && blockCore(M.blocks[d.b]) === blockCore(H.blocks[prHead])) {
        main(d.b);                                         // already live: main holds the PR's version
      } else if (d.status === 'del' && p.status === 'del') {
        // already live: deleted on both sides, nothing to draw, no conflict
      } else {
        const mi = d.status === 'change' ? d.b : null;
        conflicts.push({ mainIndex: mi, base: d.a, head: prHead });
        if (mi !== null) entries.push({ source: 'conflict', mainIndex: mi, pr: { base: d.a, head: prHead }, text: blockCore(M.blocks[mi]) });
      }
      addsAfter(d.a);
    }
    let text = '';
    const overlay = entries.map((e) => {
      if (text) text += '\n\n';
      const start = text.length;
      text += e.text;
      return Object.freeze({ ...e, pr: e.pr ? Object.freeze(e.pr) : null, start, end: text.length });
    });
    if (text) text += '\n';
    return { text, overlay, conflicts };
  }

  // ---------------------------------------------- per-edit go-live (U5) ---

  /* plan-u5: an EDIT is one entry of a page's block diff from the proposal's merge base to its head: a
     'change' (one base block replaced), an 'add' (a new block after `anchor`, the base block before it;
     -1 = the top) or a 'delete'. Its key is content, never an index:
       sha256(path NUL baseBlock NUL headBlock)                       change, delete (head '')
       sha256(path NUL '' NUL headBlock NUL anchorBlock NUL ordinal)  add (anchorBlock '' at the top;
                                                                      ordinal = its place among the head's
                                                                      adds after that anchor)
     so two identical fixes on two pages stay apart, twins in one run stay apart, and a key names the same
     edit after main moves. Texts are the raw UTF-8 file bytes (splitBlocks refuses \r). */
  const HEX64_RE = /^[0-9a-f]{64}$/;
  const RECORD_MAX = 50;
  async function sha256Hex(s, subtle) {
    const sub = subtle || (typeof crypto !== 'undefined' && crypto && crypto.subtle);  // eslint-disable-line no-undef
    if (!sub) throw new Error('sha256: no WebCrypto here');
    const buf = await sub.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  function editKey(path, base, head, anchor, ordinal, subtle) {
    const parts = [path, base, head];
    if (typeof anchor === 'string') parts.push(anchor, String(ordinal));
    return sha256Hex(parts.join('\0'), subtle);
  }

  /* -> [{key, kind, base, head, baseIndex, anchor, ordinal, state, mainAfter}] in HEAD order | null (a
     text that does not split: the whole-proposal path). state against the CURRENT main: 'open'
     (approvable), 'live' (main already holds it: the overlay's already-live rule), 'conflict' (main
     changed or deleted that block since the merge base), 'anchor-gone' (an add whose anchor block main
     deleted), 'ambiguous' (two edits share a key: never approvable one by one). For an open add,
     mainAfter is the main block it goes after (the latest EARLIER add of its run that is live, else its
     anchor; -1 = the top of the page). */
  async function proposalEdits(path, baseText, headText, mainText, subtle) {
    const Bs = splitBlocks(baseText);
    const H = splitBlocks(headText);
    const M = splitBlocks(mainText);
    if (!Bs.ok || !H.ok || !M.ok) return null;
    const toMain = new Map();                              // base index -> its diff entry vs main
    const mainAdds = new Map();                            // base index -> [{mi, text}] main added after it
    let at = -1;
    for (const d of diffSplits(Bs, M)) {
      if (d.a !== null) { toMain.set(d.a, d); at = d.a; }
      if (d.status === 'add') {
        if (!mainAdds.has(at)) mainAdds.set(at, []);
        mainAdds.get(at).push({ mi: d.b, text: blockCore(M.blocks[d.b]) });
      }
    }
    const anchorMain = (a) => {
      if (a < 0) return -1;
      const m = toMain.get(a);
      return m && m.b !== null ? m.b : null;
    };
    const raw = [];
    const runs = new Map();                                // anchor -> {ordinal, poolAt, lastLive}
    at = -1;
    for (const d of diffSplits(Bs, H)) {
      if (d.status === 'same') { at = d.a; continue; }
      if (d.status === 'add') {
        const head = blockCore(H.blocks[d.b]);
        if (!runs.has(at)) runs.set(at, { ordinal: 0, poolAt: 0, lastLive: null });
        const run = runs.get(at);
        const pool = listOf(mainAdds.get(at));
        let k = run.poolAt;
        while (k < pool.length && pool[k].text !== head) k += 1;
        let state = 'open';
        let mainAfter = null;
        if (k < pool.length) {
          state = 'live';
          run.poolAt = k + 1;
          run.lastLive = pool[k].mi;
        } else {
          const am = anchorMain(at);
          if (am === null) state = 'anchor-gone';
          else mainAfter = run.lastLive !== null ? run.lastLive : am;
        }
        raw.push({ kind: 'add', base: '', head, baseIndex: null, headIndex: d.b, anchor: at,
          anchorText: at < 0 ? '' : blockCore(Bs.blocks[at]), ordinal: run.ordinal, state, mainAfter });
        run.ordinal += 1;
        continue;
      }
      at = d.a;
      const base = blockCore(Bs.blocks[d.a]);
      const head = d.status === 'change' ? blockCore(H.blocks[d.b]) : '';
      const m = toMain.get(d.a);
      let state;
      if (m.status === 'same') state = 'open';
      else if (m.status === 'del') state = d.status === 'del' ? 'live' : 'conflict';
      else state = d.status === 'change' && blockCore(M.blocks[m.b]) === head ? 'live' : 'conflict';
      raw.push({ kind: d.status === 'del' ? 'delete' : 'change', base, head, baseIndex: d.a,
        headIndex: d.status === 'change' ? d.b : null, anchor: null,
        ordinal: null, state, mainAfter: state === 'open' ? m.b : null });
    }
    const out = [];
    for (const e of raw) {
      const key = await (e.kind === 'add' ? editKey(path, '', e.head, e.anchorText, e.ordinal, subtle)
        : editKey(path, e.base, e.head, undefined, undefined, subtle));
      out.push({ key, kind: e.kind, base: e.base, head: e.head, baseIndex: e.baseIndex, headIndex: e.headIndex, anchor: e.anchor,
        ordinal: e.ordinal, state: e.state, mainAfter: e.mainAfter });
    }
    const count = new Map();
    out.forEach((e) => count.set(e.key, (count.get(e.key) || 0) + 1));
    return out.map((e) => Object.freeze(count.get(e.key) > 1 ? { ...e, state: 'ambiguous' } : e));
  }

  /* The first non-space block index after main block `mi` (where an add goes), or the end. */
  function afterBlock(blocks, mi) {
    let j = mi + 1;
    while (j < blocks.length && blocks[j].kind === 'space') j += 1;
    return j;
  }

  /* Apply one OPEN edit (its mainAfter is against mainText). -> text | null. */
  function applyOne(mainText, e) {
    const M = splitBlocks(mainText);
    if (!M.ok || !Number.isInteger(e.mainAfter)) return null;
    if (e.kind === 'add') {
      const r = insertAt(mainText, e.mainAfter < 0 ? 0 : afterBlock(M.blocks, e.mainAfter), e.head);
      return r ? r.text : null;
    }
    if (e.kind === 'delete') return deleteBlock(mainText, e.mainAfter);
    const b = M.blocks[e.mainAfter];
    return replaceSpan(mainText, { start: b.start, end: b.start + blockCore(b).length }, e.head).text;
  }

  /* Approved keys onto main's text, in HEAD order (never key order); after each, the edits are derived
     again against the new main (keys are content, so each still names its edit). -> {text, applied,
     done, refused: [{key, reason}]}: done = already live; reason 'stale' (no such edit in the head's
     CURRENT diff: never redirected to newer content), 'conflict', 'anchor-gone', 'ambiguous', or
     'unsplittable'. Text outside the touched blocks keeps its bytes. */
  async function applyEdits(path, baseText, headText, mainText, keys, subtle) {
    const want = [...new Set(listOf(keys).filter((k) => typeof k === 'string'))];
    const first = await proposalEdits(path, baseText, headText, mainText, subtle);
    if (!first) return { text: mainText, applied: [], done: [], refused: want.map((key) => ({ key, reason: 'unsplittable' })) };
    const order = first.map((e) => e.key);
    const refused = want.filter((k) => order.indexOf(k) < 0).map((key) => ({ key, reason: 'stale' }));
    const queue = want.filter((k) => order.indexOf(k) >= 0).sort((x, y) => order.indexOf(x) - order.indexOf(y));
    let text = mainText;
    const applied = [];
    const done = [];
    for (const key of queue) {
      const edits = await proposalEdits(path, baseText, headText, text, subtle);
      const e = edits ? edits.find((x) => x.key === key) : null;
      if (!e) { refused.push({ key, reason: edits ? 'stale' : 'unsplittable' }); continue; }
      if (e.state === 'live') { done.push(key); continue; }
      if (e.state !== 'open') { refused.push({ key, reason: e.state }); continue; }
      const next = applyOne(text, e);
      if (typeof next !== 'string') { refused.push({ key, reason: 'conflict' }); continue; }
      text = next;
      applied.push(key);
    }
    return { text, applied, done, refused };
  }

  /* The approval records (plan-final §7, kept): issue comments on the proposal PR whose WHOLE body is
     `hc-approved <key> [<key> …]` or `hc-declined <key> [...]`, at most RECORD_MAX keys, lowercase hex.
     Who made a record is the comment's API user.login, never its text. Ignored: an edited comment, one by
     the proposal's author, anything malformed. -> {list: [{id, login (lowercase), kind, keys, at}]} in
     comment order; `decisions` then applies the caller's trust rule. */
  const RECORD_RE = /^hc-(approved|declined)((?: [0-9a-f]{64}){1,50})$/;
  function recordBody(kind, keys) {
    const k = listOf(keys);
    if (kind !== 'approved' && kind !== 'declined') throw new Error('recordBody: approved or declined');
    if (!k.length || k.length > RECORD_MAX || !k.every((x) => typeof x === 'string' && HEX64_RE.test(x))) {
      throw new Error(`recordBody: 1 to ${RECORD_MAX} edit keys`);
    }
    return `hc-${kind} ${k.join(' ')}`;
  }
  function parseRecords(comments, ctx) {
    const author = String((ctx && ctx.author) || '').toLowerCase();
    const list = [];
    for (const c of listOf(comments)) {
      if (!isObj(c) || !isObj(c.user) || typeof c.user.login !== 'string' || typeof c.body !== 'string') continue;
      if (typeof c.created_at !== 'string' || c.updated_at !== c.created_at) continue;
      const login = c.user.login.toLowerCase();
      if (!login || login === author) continue;
      const m = RECORD_RE.exec(c.body);
      if (!m) continue;
      list.push({ id: c.id, login, kind: m[1], keys: [...new Set(m[2].trim().split(' '))], at: c.created_at });
    }
    return { list };
  }
  /* key -> {kind, login, id}: the LATEST record per key among those whose login `trusted(login)` accepts
     (by created_at, then comment id). */
  function decisions(list, trusted) {
    const ok = typeof trusted === 'function' ? trusted : () => false;
    const sorted = listOf(list).filter((r) => ok(r.login))
      .sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : (x.id || 0) - (y.id || 0)));
    const out = new Map();
    for (const r of sorted) for (const k of r.keys) out.set(k, { kind: r.kind, login: r.login, id: r.id });
    return out;
  }

  /* A go-live failure, written by the go-live workflow (github-actions[bot]) for one key at one head sha:
     `hc-go-live-failed <key> <head sha>: `<reason>``. The reason is plain words: no @ (no one is
     mentioned), no backticks, no control characters, at most 200 characters. parseFailures trusts only
     that bot (type Bot), unedited. -> Map key -> [{sha, reason}]. */
  const FAILURE_RE = /^hc-go-live-failed ([0-9a-f]{64}) ([0-9a-f]{40}): `([^`@\x00-\x1f]{0,200})`$/;
  function failureBody(key, sha, reason) {
    if (typeof key !== 'string' || !HEX64_RE.test(key) || typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error('failureBody: an edit key and a head sha');
    }
    const words = String(reason || '').replace(/[@`]/g, '').replace(/[\x00-\x1f\x7f]+/g, ' ')
      .replace(/\s+/g, ' ').trim().slice(0, 200);
    return `hc-go-live-failed ${key} ${sha}: \`${words}\``;
  }
  function parseFailures(comments) {
    const out = new Map();
    for (const c of listOf(comments)) {
      if (!isObj(c) || !isObj(c.user) || c.user.login !== 'github-actions[bot]' || c.user.type !== 'Bot') continue;
      if (typeof c.body !== 'string' || c.updated_at !== c.created_at) continue;
      const m = FAILURE_RE.exec(c.body);
      if (!m) continue;
      if (!out.has(m[1])) out.set(m[1], []);
      out.get(m[1]).push({ sha: m[2], reason: m[3] });
    }
    return out;
  }

  /* Who may approve ONE edit of `path` (plan-u5 r1): what GitHub's ruleset would let them approve. A
     repository admin anywhere (the admin role bypasses the ruleset); a maintainer or write member only on
     a page of a project that lists them as an editor (MAIN's data/graph/edit-access.json, passed as
     `access`; the same list renders its CODEOWNERS line); nobody on their own proposal. permission: the collaborator API's role_name ('admin' | 'maintain' | 'write' |
     'triage' | 'read'; its `permission` field reports Maintain as write). */
  function mayApproveEdit(o) {
    const c = o || {};
    const login = typeof c.login === 'string' ? c.login.toLowerCase() : '';
    const author = typeof c.author === 'string' ? c.author.toLowerCase() : '';
    if (!login || !author || login === author) return false;
    if (c.permission === 'admin') return true;
    if (c.permission !== 'maintain' && c.permission !== 'write') return false;
    return ownsAll({ login, files: [c.path], access: c.access });
  }
  /* plan-u5 B3: edit-by-edit review only for a proposal the editor made (head ref cms/… in THIS
     repository), open, not a draft, whose every changed file is an existing page (content/**.md,
     modified). Anything else is reviewed as a whole on GitHub. rows: the PR's file list. */
  const GO_LIVE_PAGE_RE = /^content\/[a-z0-9/_-]+\.md$/;
  function proposalEligible(pull, rows) {
    const p = pull || {};
    const h = isObj(p.head) ? p.head : {};
    if (p.draft === true || (p.state && p.state !== 'open')) return false;
    if (typeof h.ref !== 'string' || h.ref.indexOf('cms/') !== 0) return false;
    if (!isObj(h.repo) || h.repo.full_name !== `${REPO_OWNER}/${REPO_NAME}`) return false;
    const r = listOf(rows);
    return Array.isArray(rows) && r.length > 0
      && r.every((f) => isObj(f) && f.status === 'modified' && GO_LIVE_PAGE_RE.test(String(f.filename)));
  }

  /* One edit's change in words for its card: {verb, from, to}, Markdown marks dropped, one line, at
     most CARD_CLIP characters per side. Plain text: the caller sets it with textContent. */
  const CARD_CLIP = 160;
  const HTML_TAG_RE = /<\/?(?:a|b|br|code|details|div|em|figcaption|figure|h[1-6]|hr|i|img|kbd|li|ol|p|pre|span|strong|sub|summary|sup|table|tbody|td|th|thead|tr|u|ul)(?:\s[^<>]{0,300})?\/?>/gi;
  function plainLine(md) {
    const t = String(md || '')
      .replace(/<p class="adm-title">([^<]{0,60})<\/p>/g, '$1: ')          // a note box's title: "Note: …"
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(HTML_TAG_RE, ' ')                                          // real HTML tags only: <axis_name> stays
      .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
      .replace(/(\*\*|~~|`)/g, '')
      .replace(/(^|[^\w])[*_]([^\s*_][^*_]*?)[*_](?=[^\w]|$)/g, '$1$2')       // *x* and _x_, never snake_case
      .replace(/\s+/g, ' ').replace(/\s+:/g, ':').trim();
    return t.length > CARD_CLIP ? `${t.slice(0, CARD_CLIP - 1).trimEnd()}…` : t;
  }
  function cardText(kind, base, head) {
    const verb = kind === 'add' ? 'Add' : kind === 'delete' ? 'Delete' : 'Replace';
    return { verb, from: kind === 'add' ? '' : plainLine(base), to: kind === 'delete' ? '' : plainLine(head) };
  }

  /* The review rail's cards (plan-u5 U5b), built from the ENGINE's own edits (proposalEdits), so the page
     and go-live.yml cannot disagree. o: {edits, overlay (overlayOnMain's entries), comments (the PR's),
     author, headSha, trusted(login) (the engine's rule for a record's author on this page), may() (the
     signed-in person may approve this page), eligible (proposalEligible), pending (keys this tab has just
     recorded: Map key -> 'approved'|'declined', or a Set of approved keys)}.
     -> [{key, kind, verb, from, to, anchor (overlay index | null when not drawn), state, by, reason, acts}]
     state: waiting | going (approved, on its way) | live | declined | failed (site rules) | conflict |
     ambiguous | whole (review this proposal as a whole). acts: what the person may click. */
  function reviewCards(o) {
    const c = o || {};
    const list = listOf(c.overlay);
    const records = parseRecords(c.comments, { author: c.author }).list;
    const d = decisions(records, typeof c.trusted === 'function' ? c.trusted : () => false);
    const failures = parseFailures(c.comments);
    const pend = (k) => (c.pending instanceof Map ? c.pending.get(k) : (c.pending && c.pending.has && c.pending.has(k) ? 'approved' : null));
    const mayAct = c.eligible === true && typeof c.may === 'function' && c.may() === true;
    return listOf(c.edits).map((e) => {
      let anchor = null;
      if (e.state !== 'live') {
        const at = list.findIndex((x) => (e.kind === 'add'
          ? x.source === 'pr-add' && x.pr && x.pr.head === e.headIndex
          : (x.source === 'pr-del' || x.source === 'conflict') && x.pr && x.pr.base === e.baseIndex));
        anchor = at >= 0 ? at : null;
      }
      const dec = d.get(e.key) || null;
      const fail = listOf(failures.get(e.key)).find((f) => f.sha === c.headSha) || null;
      const p = pend(e.key);
      let state = 'waiting';
      let by = null;
      let reason = null;
      if (e.state === 'live') state = 'live';
      else if (c.eligible !== true) state = 'whole';
      else if (e.state === 'conflict' || e.state === 'anchor-gone') state = 'conflict';
      else if (e.state === 'ambiguous') state = 'ambiguous';
      // this tab's own fresh record wins over what GitHub listed before it (a reversal shows at once)
      else if (p === 'declined') state = 'declined';
      else if (p === 'approved' && !fail) state = 'going';
      else if (dec && dec.kind === 'declined') { state = 'declined'; by = dec.login; }
      else if (fail) { state = 'failed'; reason = fail.reason; }
      else if (dec) { state = 'going'; by = dec.login; }
      // a Reject is undone by approving it after all (the latest trusted record wins)
      const acts = !mayAct ? [] : state === 'waiting' ? ['approve', 'decline'] : state === 'failed' ? ['decline']
        : state === 'declined' ? ['approve'] : [];
      const t = cardText(e.kind, e.base, e.head);
      return Object.freeze({ key: e.key, kind: e.kind, verb: t.verb, from: t.from, to: t.to, anchor, state, by, reason,
        acts: Object.freeze(acts), canAct: acts.length > 0 });
    });
  }

  /* U6: the lines of one edit in the file GitHub's review comments name: {side, line, last} (1-based,
     inclusive) — RIGHT, the proposal's head, for a change or an add; LEFT, its merge base, for a delete. */
  function editLines(e, baseText, headText) {
    if (!isObj(e)) return null;
    const right = e.kind !== 'delete';
    const text = right ? headText : baseText;
    const at = right ? e.headIndex : e.baseIndex;
    const sp = splitBlocks(text);
    if (!sp.ok || !Number.isInteger(at) || !sp.blocks[at]) return null;
    const b = sp.blocks[at];
    const line = text.slice(0, b.start).split('\n').length;
    return { side: right ? 'RIGHT' : 'LEFT', line, last: line + blockCore(b).split('\n').length - 1 };
  }

  /* U6: the proposal's review comments on `path` as conversations: a root comment and its replies (by
     in_reply_to_id), placed on the edit whose lines hold the root's current line on its side. A root GitHub
     marks outdated (line null) or on lines no edit holds goes to `other` (shown apart, never guessed onto a
     card). -> {byKey: Map key -> [{rootId, comments}], other: [{rootId, comments}]} */
  function threadsByEdit(comments, edits, baseText, headText, path) {
    const list = listOf(comments).filter((c) => isObj(c) && Number.isInteger(c.id) && c.path === path);
    const roots = list.filter((c) => !Number.isInteger(c.in_reply_to_id));
    const spans = listOf(edits).map((e) => ({ key: e.key, at: editLines(e, baseText, headText) })).filter((x) => x.at);
    const byKey = new Map();
    const other = [];
    for (const r of roots) {
      const thread = { rootId: r.id, comments: [r, ...list.filter((c) => c.in_reply_to_id === r.id)]
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id) };
      const hit = Number.isInteger(r.line) ? spans.find((x) => x.at.side === (r.side || 'RIGHT') && r.line >= x.at.line && r.line <= x.at.last) : null;
      if (!hit) { other.push(thread); continue; }
      if (!byKey.has(hit.key)) byKey.set(hit.key, []);
      byKey.get(hit.key).push(thread);
    }
    return { byKey, other };
  }

  /* Card tops for the rail: cards = [{key, want (the block's top), height}] in page order. They keep
     their order and never overlap (gap between); with an active card, it sits exactly on its block's
     line, the cards above step up and the cards below step down. -> {key: top}. */
  function railLayout(cards, activeKey, gap) {
    const g = Number.isFinite(gap) ? gap : 8;
    const list = listOf(cards);
    const out = {};
    let at = list.findIndex((x) => x.key === activeKey);
    if (at < 0) at = 0;
    const top = list.map((x) => x.want);
    if (activeKey !== null && activeKey !== undefined && list[at] && list[at].key === activeKey) {
      for (let i = at - 1; i >= 0; i -= 1) top[i] = Math.min(list[i].want, top[i + 1] - g - list[i].height);
    } else at = 0;
    for (let i = at + 1; i < list.length; i += 1) top[i] = Math.max(list[i].want, top[i - 1] + list[i - 1].height + g);
    list.forEach((x, i) => { out[x.key] = top[i]; });
    return out;
  }


  // ------------------------------------------ cached fetcher + resolveRef ---

  /* Plan D-D, reload cost: files at a commit sha never change, so a read is
     memoized by (sha, path) for the life of the editor. fetchAt(sha, path)
     answers {ok, status, text} (e.g. (sha, p) => refFetcher(token, sha)(p));
     at(sha) is a path fetcher for draftFetcher's fallback or the preview
     host. A branch name is refused (it moves); a failed read is forgotten,
     so the next load asks again; concurrent reads share one request. */
  function cachedFetcher(fetchAt) {
    if (typeof fetchAt !== 'function') throw new Error('cachedFetcher: a fetch function (sha, path) is needed');
    const memo = new Map();
    const needSha = (sha) => {
      if (typeof sha !== 'string' || !FULL_SHA_RE.test(sha)) {
        throw new Error('cachedFetcher: a full commit sha is needed (a branch name moves)');
      }
    };
    function get(sha, p) {
      needSha(sha);
      const key = `${sha}:${p}`;
      if (memo.has(key)) return memo.get(key);
      const answer = Promise.resolve()
        .then(() => fetchAt(sha, p))
        .then(normalizeAnswer, () => ({ ok: false, status: 502, text: '' }));
      memo.set(key, answer);
      answer.then((a) => { if (!a.ok && memo.get(key) === answer) memo.delete(key); });
      return answer;
    }
    return Object.freeze({
      get,
      at(sha) { needSha(sha); return (p) => get(sha, p); },
      size: () => memo.size,
      clear() { memo.clear(); },
    });
  }

  /* A ref -> its commit sha: a full sha is itself (no call); a branch is
     one GET of git/ref/heads/<branch> through `client` (createGitHubClient).
     Rejects with an Error whose .status is GitHub's answer. */
  async function resolveRef(client, ref) {
    if (typeof ref === 'string' && FULL_SHA_RE.test(ref)) return ref;
    if (!isRef(ref)) throw new Error('resolveRef: a branch name or a full commit sha is needed');
    const res = await client.get(`${REPO_API_PATH}/git/ref/heads/${encodePath(ref)}`);
    const obj = res && res.ok && isObj(res.data) && isObj(res.data.object) ? res.data.object : null;
    if (!obj || typeof obj.sha !== 'string' || !FULL_SHA_RE.test(obj.sha)) {
      const err = new Error(`could not read where ${ref} points: HTTP ${(res && res.status) || 0}`);
      err.status = (res && res.status) || 502;
      throw err;
    }
    return obj.sha;
  }

  // ------------------------------------------- view settings + members ---

  /* Plan D-H: the View tab's settings live in localStorage only. A stored
     value of the wrong type falls back to its default, one by one. */
  const VIEW_DEFAULTS = Object.freeze({ suggestions: true, diff: 'inline', compact: false, outlines: true });
  const VIEW_DIFFS = Object.freeze(['inline', 'side']);

  function cleanView(v) {
    const o = isObj(v) ? v : {};
    const bool = (k) => (typeof o[k] === 'boolean' ? o[k] : VIEW_DEFAULTS[k]);
    return { suggestions: bool('suggestions'), diff: VIEW_DIFFS.indexOf(o.diff) >= 0 ? o.diff : VIEW_DEFAULTS.diff,
      compact: bool('compact'), outlines: bool('outlines') };
  }

  const viewSettings = Object.freeze({
    KEY: 'hc-editor-view',
    DEFAULTS: VIEW_DEFAULTS,
    DIFFS: VIEW_DIFFS,
    load(storage) {
      try {
        const raw = storage.getItem('hc-editor-view');
        return cleanView(raw ? JSON.parse(raw) : null);
      } catch (e) {
        return cleanView(null);
      }
    },
    save(storage, settings) {
      try {
        storage.setItem('hc-editor-view', JSON.stringify(cleanView(settings)));
        return true;
      } catch (e) {
        return false;
      }
    },
  });

  /* Members-only detail (plan D-A, D-C) is for Admin, Maintainer and Editor:
     a role from roleFromPermissions whose push is a real true. */
  const MEMBER_ROLE_KEYS = Object.freeze(['admin', 'maintain', 'push']);
  function membersOnly(role) {
    return isObj(role) && role.canPush === true && MEMBER_ROLE_KEYS.indexOf(role.key) >= 0;
  }

  // ------------------------------------------------- the org reader (D-A) ---

  /* THE ONE STATED EXCEPTION to the ONE-REPOSITORY rule (see the header).
     createOrgReader is GET-only and sends the user's token to exactly:
       /repos/HippoCampusRobotics/<repo>/commits[?since|until|per_page|page|path]
           for <repo> in repoNames (data/graph/github-repos.json), fixed at creation;
       /repos/desert-mango/hippocampus-docs/commits?path=…[&per_page|page|since|until]
       /repos/desert-mango/hippocampus-docs/compare/<ref>...<ref>
     Nothing else: no list call, no other owner, no other endpoint, no write
     (it has no method parameter at all). The path part carries no encoding,
     no empty, '.' or '..' segment; every query parameter is named in the
     endpoint's table, given once, spelled in the ONE canonical encoding
     (encodeURIComponent of its value) and checked by value, so nothing can
     ride inside path= or since=. Anything else is refused locally with a
     403-shaped answer and fetch is never called. A 403 or 404 on a read WITH
     the token is retried ONCE without it (the editor App may not be
     installed on the org; public data reads anonymously). A good answer is
     kept 15 minutes in `storage` (sessionStorage), keyed by URL, and dropped
     at sign-out (clearSession). No fetch follows a redirect. */
  const ORG_OWNER = 'HippoCampusRobotics';
  const ORG_CACHE_PREFIX = 'hc-org-cache:';
  const ORG_CACHE_MS = 15 * 60 * 1000;
  const ISO_TIME_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)?$/;
  const isRepoName = (n) => typeof n === 'string' && REPO_NAME_RE.test(n) && n !== '.' && n !== '..';
  const isFilePath = (p) => typeof p === 'string' && p.length <= 400
    && /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test(p) && p.split('/').every((s) => s !== '.' && s !== '..');
  const isCount = (max) => (v) => /^[1-9][0-9]{0,3}$/.test(v) && Number(v) <= max;
  const isTime = (v) => ISO_TIME_RE.test(v) && Number.isFinite(Date.parse(v));
  const ORG_COMMITS_PARAMS = Object.freeze({ since: isTime, until: isTime, per_page: isCount(100), page: isCount(1000), path: isFilePath });
  const QUERY_ORDER = Object.freeze(['path', 'since', 'until', 'per_page', 'page']);

  function queryOk(query, table, required) {
    if (query === null) return required.length === 0;
    const seen = new Set();
    for (const part of query.split('&')) {
      const eq = part.indexOf('=');
      if (eq <= 0) return false;
      const k = part.slice(0, eq);
      const raw = part.slice(eq + 1);
      if (!Object.prototype.hasOwnProperty.call(table, k) || seen.has(k)) return false;
      seen.add(k);
      let v;
      try { v = decodeURIComponent(raw); } catch (e) { return false; }
      if (encodeURIComponent(v) !== raw || !table[k](v)) return false;
    }
    return required.every((k) => seen.has(k));
  }

  const isCompareSpec = (spec) => {
    const refs = spec.split('...');
    return refs.length === 2 && refs.every(isRef);
  };

  function repoAllowlist(repoNames) {
    return new Set(listOf(repoNames).filter(isRepoName));
  }

  /* true only for a path createOrgReader may GET (repoNames: the allowlist). */
  function orgReadAllowed(apiPath, repoNames) {
    if (typeof apiPath !== 'string' || apiPath.length > 2000 || /[\\#\s\x00-\x1f\x7f%]/.test(apiPath.split('?')[0])) return false;
    if (/[\\#\s\x00-\x1f\x7f]/.test(apiPath)) return false;
    const q = apiPath.indexOf('?');
    const p = q < 0 ? apiPath : apiPath.slice(0, q);
    const query = q < 0 ? null : apiPath.slice(q + 1);
    const segs = p.split('/');
    if (segs[0] !== '' || segs[1] !== 'repos') return false;
    if (segs.slice(1).some((s) => s === '' || s === '.' || s === '..')) return false;
    const names = repoNames instanceof Set ? repoNames : repoAllowlist(repoNames);
    if (segs.length === 5 && segs[2] === ORG_OWNER && names.has(segs[3]) && segs[4] === 'commits') {
      return queryOk(query, ORG_COMMITS_PARAMS, []);
    }
    if (segs[2] !== REPO_OWNER || segs[3] !== REPO_NAME) return false;
    if (segs.length === 5 && segs[4] === 'commits') return queryOk(query, ORG_COMMITS_PARAMS, ['path']);
    if (segs.length >= 6 && segs[4] === 'compare' && query === null) return isCompareSpec(segs.slice(5).join('/'));
    return false;
  }

  function buildQuery(q) {
    const o = isObj(q) ? q : {};
    const parts = [];
    for (const k of QUERY_ORDER) {
      if (o[k] === undefined || o[k] === null) continue;
      const v = String(o[k]);
      if (!ORG_COMMITS_PARAMS[k](v)) throw new Error(`org reader: a bad ${k}`);
      parts.push(`${k}=${encodeURIComponent(v)}`);
    }
    Object.keys(o).forEach((k) => { if (QUERY_ORDER.indexOf(k) < 0) throw new Error(`org reader: no parameter ${k.slice(0, 20)}`); });
    return parts.length ? `?${parts.join('&')}` : '';
  }

  /* The builders: the only spellings the reader is meant to be given. */
  function orgCommitsPath(repo, q) {
    if (!isRepoName(repo)) throw new Error('org reader: a bad repository name');
    return `/repos/${ORG_OWNER}/${repo}/commits${buildQuery(q)}`;
  }

  function pageCommitsPath(file, q) {
    if (!isFilePath(file)) throw new Error('org reader: a bad file path');
    return `${REPO_API_PATH}/commits${buildQuery({ ...(isObj(q) ? q : {}), path: file })}`;
  }

  function comparePath(base, head) {
    if (!isRef(base) || !isRef(head)) throw new Error('org reader: a bad ref');
    return `${REPO_API_PATH}/compare/${base}...${head}`;
  }

  function createOrgReader(token, fetchImpl, storage, repoNames, opts) {
    const names = repoAllowlist(repoNames);
    const now = opts && typeof opts.now === 'function' ? opts.now : () => Date.now();
    const auth = typeof token === 'string' && token ? token : null;

    function cached(url) {
      try {
        const raw = storage ? storage.getItem(ORG_CACHE_PREFIX + url) : null;
        if (!raw) return null;
        const c = JSON.parse(raw);
        const t = now();
        if (isObj(c) && Number.isFinite(c.t) && c.t <= t && t - c.t < ORG_CACHE_MS && Number.isInteger(c.status)) {
          return { status: c.status, data: c.data, anonymous: c.anonymous === true };
        }
        storage.removeItem(ORG_CACHE_PREFIX + url);
      } catch (e) { /* no cache */ }
      return null;
    }

    function keep(url, r, anonymous) {
      try {
        storage.setItem(ORG_CACHE_PREFIX + url, JSON.stringify({ t: now(), status: r.status, data: r.data, anonymous }));
      } catch (e) { /* full */ }
    }

    async function once(url, withToken) {
      const headers = { Accept: 'application/vnd.github+json' };
      if (withToken) headers.Authorization = `Bearer ${auth}`;
      let res;
      try {
        // redirect: 'error' — a moved repository's 301 (to /repositories/<id>/…)
        // must never carry the token to a URL the allowlist did not check.
        res = await fetchImpl(url, { method: 'GET', headers, cache: 'no-store', credentials: 'omit', redirect: 'error' });
      } catch (e) {
        return { ok: false, status: 0, data: null };
      }
      const status = res && Number.isInteger(res.status) ? res.status : 0;
      return { ok: Boolean(res && res.ok) && status >= 200 && status < 300, status, data: await readJson(res) };
    }

    async function get(apiPath) {
      if (!orgReadAllowed(apiPath, names)) return { ok: false, status: 403, data: null, refused: true };
      const url = API_ROOT + apiPath;
      const hit = cached(url);
      if (hit) {
        const ok = hit.status >= 200 && hit.status < 300;
        return { ok, status: hit.status, data: ok ? hit.data : null, cached: true, anonymous: hit.anonymous };
      }
      let r = await once(url, Boolean(auth));
      let anonymous = !auth;
      if (auth && (r.status === 403 || r.status === 404)) {
        r = await once(url, false);
        anonymous = true;
      }
      if (r.ok) keep(url, r, anonymous);
      return { ok: r.ok, status: r.status, data: r.ok ? r.data : null, cached: false, anonymous };
    }

    return Object.freeze({
      get,
      allowed: (p) => orgReadAllowed(p, names),
      repoNames: Object.freeze([...names]),
    });
  }

  const api = Object.freeze({
    REPO_OWNER, REPO_NAME, REPO_FULL, API_ROOT, REPO_API_PATH, GITHUB_WEB,
    CALLBACK_PATH, SESSION_KEY, NO_ACCESS_TEXT, PLACEHOLDER_TEXT, PROTOCOLS_URL,
    POPUP_CLOSE_GRACE_MS,
    ROUTES, BRIDGE_PATH_RE,
    roleFromPermissions, parseRoute, orderOpenPulls, recentMerges, loadRecentMerges, proposerSlots, slotOf, PROPOSER_SLOTS, proposalRows,
    createGeneration, randomHex, authorizeUrl, createSignIn,
    makeSession, readSession, writeSession, clearSession,
    assertRepoPath, createGitHubClient, READ_METHODS, WRITE_METHODS, isAllowedWrite,
    editPath, pencilUrl, placeholderLink,
    isBridgePath, previewFragment, refFetcher, draftFetcher, createPreviewHost, RAW_MEDIA, contentsPath,
    MACHINERY_TEXT, DERIVED_TEXT, CHECK_TEXT, SELF_APPROVE_TEXT, SELF_REQUEST_TEXT,
    STALE_TEXT, NEEDS_HUMAN_TEXT, UNDO_TEXT, MERGE_CONFIRM_TEXT, mergeNeedsConfirm,
    isMachineryPath, isDerivedPath, pullBadges, loadPullFiles, ageText,
    PREVIEW_CONTENT_ONLY_TEXT, PREVIEW_UNLISTED_TEXT, previewScope,
    gateRunOf, checkStatus, annotationRows, loadAnnotations, annotationText, undoOnGitHubUrl,
    vercelCommentUrl, ownsAll, reviewActionsFor,
    ACCESS_SITE_WIDE_TEXT, ACCESS_REQUEST_LABEL, ACCESS_SECTION_LABEL, ACCESS_UNREAD_TEXT, ACCESS_LOCKED_TEXT, ACCESS_READING_TEXT, ACCESS_TEXTS, accessFor, canEditProject, accessEditors,
    accessRequestDraft, classifyAccessProposal, accessProposalTitle, accessKindLabel, accessChangeLine, accessIssueUrl, reviewRequest, actionOutcome, runReviewAction,
    previewPages, loadHeadRegistries,
    ID_RULE_TEXT, STRICT_JSON_TEXT, LEAVE_TEXT, DISCARD_TEXT, RAW_REGISTRIES, DRAFTS_KEY, draftsKey, SNIPPETS, SNIPPET_CATALOG,
    editKind, pageTree, pageList, pageIdForFile, routeForPage,
    jsonProblem, jsonProblemText, lockedIds, registryDraftProblem, formatLike,
    insertSnippet, linkMarkdown, createDraftStore, isDirty,
    PROJECT_STATUSES, PROJECT_ID_RE, newProjectDraft, personGroups, addPersonText, peopleOrderText, peopleMarks, peopleChangeCount,
    STALE_DRAFT_TEXT, slugify, proposalBranch, isProposalBranch, proposalPathProblem, treeEntries, reviewUrl, prBody,
    ownProposals, collectProposal, proposeRequest, runPropose,
    MEDIA_FUNCTION, MEDIA_ROOT, MEDIA_SUBFOLDERS, MANIFEST_FILE, MANIFEST_KEY, MANIFEST_LABEL, MEDIA_MAX_BYTES,
    MEDIA_TYPES, SIZE_HINT_TEXT, REMOVE_FIRST_TEXT, IN_USE_TEXT, IN_DRAFT_TEXT, THUMB_TRANSFORM, MEDIA_SLUG_RE,
    thumbUrl, parseManifest, manifestAssets, findBySha, mediaChangeProblem, mediaFileProblem, mediaFailure,
    createMediaClient, uploadPlan, manifestEntry, addManifestEntry, runUpload, imageMarkdown, insertText,
    PROJECT_FACTS_FILE_RE, projectFactsFile, mergeProjects,
    BLOCK_KINDS, imageParts, imageWith, splitBlocks, spanOf, replaceSpan, insertAt, moveBlock, deleteBlock, sentinelId, withSentinels,
    blockDiff, overlayOnMain, editKey, proposalEdits, applyEdits, recordBody, recordRequests, runRecord, parseRecords, decisions,
    failureBody, parseFailures, mayApproveEdit, proposalEligible, cardText, reviewCards, railLayout, RECORD_MAX,
    editLines, threadsByEdit, threadRequest, replyRequest, graphqlRequest, isAllowedGraphql, runThreadWrite, runResolve, cachedFetcher, resolveRef, viewSettings, membersOnly,
    ORG_OWNER, orgReadAllowed, orgCommitsPath, pageCommitsPath, comparePath, createOrgReader,
  });

  if (typeof window !== 'undefined') window.HCCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}());
