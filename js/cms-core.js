// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 22 September 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Pure logic of the CMS signed-in area: roles, routes, sign-in, session, GitHub client, preview host, editor.
/* HCCore — everything in cms/ that is logic rather than DOM, so node can test
   it (tools/tests/test_cms_core.mjs). js/cms.js is the DOM glue around it.

   ONE REPOSITORY. The token a signed-in person holds may reach other
   repositories; this code never reads, lists or writes any of them (R2-F1).
   Every GitHub API path goes through assertRepoPath(): it passes '/user' and
   paths under /repos/desert-mango/hippocampus-docs, and throws on anything
   else before fetch is ever called.

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
       js/cms.js's VIEWS map.
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
   agree with the originals. */
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
     get(path) resolves to the parsed JSON of a GET — js/cms.js's api(), or a
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
     without starting one; isCurrent(g) is true only for the newest. js/cms.js
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

  function clearSession(storage) {
    try { if (storage) storage.removeItem(SESSION_KEY); } catch (e) { /* nothing to clear */ }
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
  ].map((w) => Object.freeze(w)));

  /* True only for a write WRITE_METHODS lists: the method, and a path under
     this repository whose rest matches the row exactly (assertRepoPath has
     already refused dot segments, encodings and other repositories). */
  function isAllowedWrite(method, p) {
    if (typeof p !== 'string' || p.indexOf('?') >= 0) return false;
    if (p.indexOf(`${REPO_API_PATH}/`) !== 0) return false;
    const rest = p.slice(REPO_API_PATH.length);
    return WRITE_METHODS.some((w) => w.method === method && w.path.test(rest));
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
      if (isWrite && !isAllowedWrite(method, p)) {
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

    return Object.freeze({
      methods,
      send,
      get: (p, opts) => send('GET', p, opts),
    });
  }

  // --------------------------------------- page id -> file (pencil link) ---

  const listOf = (v) => (Array.isArray(v) ? v : []);
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
      file = findFile(r.projects && r.projects.projects, pageId.slice(8));
    } else if (pageId.indexOf('tool/') === 0) {
      file = findFile(r.tools && r.tools.tools, pageId.slice(5));
    } else if (/^data\/[a-z0-9][a-z0-9-]*$/.test(pageId)) {
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

  function previewFragment(nonce, route) {
    if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) {
      throw new Error('previewFragment: the nonce must be 16-128 characters of [A-Za-z0-9_-]');
    }
    const r = safeRoute(route === undefined ? '/' : route);
    return `#preview=${nonce}${r === '/' ? '' : `&route=${encodeURIComponent(r)}`}`;
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
      d.setFrameSrc(base + previewFragment(nonce, route));
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
     the parsed JSON of a GET (js/cms.js's api()); a rejection is passed on. */
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

  /* Which buttons a role gets (D8). Read-only: none. Write ("Editor"):
     review, update and close, but the Merge button is hidden. Maintain and
     Admin: all. A merged PR offers only Undo on GitHub (Revert needs write,
     [S89]); a closed one nothing. */
  function reviewActionsFor(role, pull) {
    const r = role || {};
    const p = pull || {};
    if (r.canPush !== true) return [];
    if (p.merged === true || typeof p.merged_at === 'string') return ['undo'];
    if (p.state !== 'open') return [];
    const out = ['approve', 'request-changes', 'update', 'close'];
    if (r.key === 'maintain' || r.key === 'admin') out.splice(2, 0, 'merge');
    return out;
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
    'data/people.json': { route: '/about', label: 'About' },
  });
  const textOr = (v, fallback) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);

  function pageForFile(file, regs) {
    const r = regs || {};
    if (file === 'content/about.md') return { route: '/about', label: 'About' };
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
    if (file.indexOf('content/projects/') === 0) return inList(r.projects && r.projects.projects, '/projects');
    if (file.indexOf('content/tools/') === 0) return inList(r.tools && r.tools.tools, '/tools');
    return null;
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

  /* The registries previewPages needs for these files, read at the PR head
     through `fetcher` (refFetcher(token, sha)): only the ones a changed
     content file needs; a missing or broken one is null. */
  const REGISTRY_FOR = Object.freeze([
    ['content/setup/', 'setup', 'data/setup.json'],
    ['content/projects/', 'projects', 'data/projects.json'],
    ['content/tools/', 'tools', 'data/tools.json'],
  ]);

  async function loadHeadRegistries(fetcher, files) {
    const names = listOf(files).filter(isFileRow).map((f) => f.filename);
    const regs = { setup: null, projects: null, tools: null };
    await Promise.all(REGISTRY_FOR.map(async ([prefix, key, file]) => {
      if (!names.some((p) => p.indexOf(prefix) === 0)) return;
      try {
        const res = await fetcher(file);
        if (res && res.ok === true && typeof res.text === 'string') regs[key] = JSON.parse(res.text);
      } catch (e) { /* a registry that cannot be read maps no page */ }
    }));
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
  const isRawRegistry = (f) => RAW_REGISTRIES.indexOf(f) >= 0;

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
    out.push({ key: 'projects', title: 'Projects', pages: listed(r.projects && r.projects.projects, 'project', '/projects') });
    out.push({ key: 'tools', title: 'Agent tools', pages: listed(r.tools && r.tools.tools, 'tool', '/tools') });
    out.push({ key: 'about', title: 'About', pages: [pageRow('about', 'About', 'content/about.md', '/about')] });
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
    if (editKind(pageId) === 'registry') return DATA_ROUTES[`${pageId}.json`].route;
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

  /* The block snippet `kind` at [start, end) of text, on its own lines; the
     selection (or the placeholder) goes inside and comes back selected.
     -> {text, selStart, selEnd} */
  function insertSnippet(text, start, end, kind) {
    if (!Object.prototype.hasOwnProperty.call(SNIPPETS, kind)) throw new Error(`no such snippet: ${String(kind).slice(0, 20)}`);
    const sn = SNIPPETS[kind];
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

  function createDraftStore(storage) {
    const map = new Map();
    try {
      const raw = storage ? storage.getItem(DRAFTS_KEY) : null;
      const list = raw ? JSON.parse(raw) : [];
      for (const d of Array.isArray(list) ? list : []) if (validDraft(d)) map.set(d.key, d);
    } catch (e) { /* unreadable: start empty */ }
    function persist() {
      try {
        if (!storage) return false;
        storage.setItem(DRAFTS_KEY, JSON.stringify([...map.values()]));
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
        return persist();
      },
      remove(key) { map.delete(key); return persist(); },
      list: () => [...map.values()],
      dirty: () => [...map.values()].filter(isDirty),
    });
  }

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
     -> {problem, id, files}: files = exactly data/projects.json (the entry
     appended, keys id,name,status,tagline,file,repos) and the story at
     content/projects/<id>.md. A repository already in a project (or in the
     exclusions) is refused: check.py wants each org repo in exactly one. */
  function newProjectDraft(form, projectsText) {
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
    for (const p of projects) {
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
    reg.doc.projects.push({ id, name, status, tagline, file,
      repos: names.map((n) => ({ name: n, url: `${ORG_WEB}/${n}` })) });
    const story = String(typeof f.story === 'string' ? f.story : '').replace(/\s+$/, '');
    return { problem: null, id, files: { 'data/projects.json': formatLike(projectsText, reg.doc), [file]: `${story}\n` } };
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

  const api = Object.freeze({
    REPO_OWNER, REPO_NAME, REPO_FULL, API_ROOT, REPO_API_PATH, GITHUB_WEB,
    CALLBACK_PATH, SESSION_KEY, NO_ACCESS_TEXT, PLACEHOLDER_TEXT, PROTOCOLS_URL,
    POPUP_CLOSE_GRACE_MS,
    ROUTES, BRIDGE_PATH_RE,
    roleFromPermissions, parseRoute, orderOpenPulls, recentMerges, loadRecentMerges,
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
    vercelCommentUrl, reviewActionsFor, reviewRequest, actionOutcome, runReviewAction,
    previewPages, loadHeadRegistries,
    ID_RULE_TEXT, STRICT_JSON_TEXT, LEAVE_TEXT, DISCARD_TEXT, RAW_REGISTRIES, DRAFTS_KEY, SNIPPETS,
    editKind, pageTree, pageList, pageIdForFile, routeForPage,
    jsonProblem, jsonProblemText, lockedIds, registryDraftProblem, formatLike,
    insertSnippet, linkMarkdown, createDraftStore, isDirty,
    PROJECT_STATUSES, PROJECT_ID_RE, newProjectDraft, personGroups, addPersonText,
    STALE_DRAFT_TEXT, slugify, proposalBranch, isProposalBranch, proposalPathProblem, treeEntries, reviewUrl, prBody,
    ownProposals, collectProposal, proposeRequest, runPropose,
    MEDIA_FUNCTION, MEDIA_ROOT, MEDIA_SUBFOLDERS, MANIFEST_FILE, MANIFEST_KEY, MANIFEST_LABEL, MEDIA_MAX_BYTES,
    MEDIA_TYPES, SIZE_HINT_TEXT, REMOVE_FIRST_TEXT, IN_USE_TEXT, IN_DRAFT_TEXT, THUMB_TRANSFORM, MEDIA_SLUG_RE,
    thumbUrl, parseManifest, manifestAssets, findBySha, mediaChangeProblem, mediaFileProblem, mediaFailure,
    createMediaClient, uploadPlan, manifestEntry, addManifestEntry, runUpload, imageMarkdown, insertText,
  });

  if (typeof window !== 'undefined') window.HCCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}());
