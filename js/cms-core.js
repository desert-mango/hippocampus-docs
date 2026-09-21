// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 21 September 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Pure logic of the CMS signed-in area: roles, routes, sign-in, session, GitHub client, preview host.
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
   main, close — all on /pulls/<n>. U7b adds its Git Data API calls there;
   every other write throws before fetch is called. The other POST in this
   file is the sign-in exchange to this site's own /api/auth.
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
    { name: 'edit', re: /^\/edit\/(.+)$/, keys: ['pageId'], owner: 'U7b', placeholder: true },
    { name: 'new', re: /^\/new\/([a-z][a-z-]*)\/?$/, keys: ['kind'], owner: 'U7b', placeholder: true },
    { name: 'media', re: /^\/media\/?$/, keys: [], owner: 'U9', placeholder: true },
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
     query string. <n> is a pull request number. U7b adds its own rows. */
  const PULL_N = '[1-9][0-9]{0,8}';
  const WRITE_METHODS = Object.freeze([
    // U8: approve, or request changes (the review's `event` says which)
    { method: 'POST', path: new RegExp(`^/pulls/${PULL_N}/reviews$`), unit: 'U8' },
    // U8: merge (squash, pinned to the head sha the reviewer saw)
    { method: 'PUT', path: new RegExp(`^/pulls/${PULL_N}/merge$`), unit: 'U8' },
    // U8: update from main
    { method: 'PUT', path: new RegExp(`^/pulls/${PULL_N}/update-branch$`), unit: 'U8' },
    // U8: close ({state: "closed"})
    { method: 'PATCH', path: new RegExp(`^/pulls/${PULL_N}$`), unit: 'U8' },
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

  /* The fetcher for a PR or a branch: GET /contents/<path>?ref=<ref> with
     the raw media type (the file body itself, up to 100 MB). */
  function refFetcher(token, ref, fetchImpl) {
    if (!isRef(ref)) throw new Error('refFetcher: ref must be a sha or a branch name');
    const client = createGitHubClient({
      token,
      fetch: fetchImpl || ((url, init) => fetch(url, init)),
    });
    return async function fetchAtRef(p) {
      if (!isBridgePath(p)) return refused();
      const res = await client.get(
        `${REPO_API_PATH}/contents/${encodePath(p)}?ref=${encodeURIComponent(ref)}`,
        { accept: 'application/vnd.github.raw+json', raw: true });
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
    isBridgePath, previewFragment, refFetcher, draftFetcher, createPreviewHost,
    MACHINERY_TEXT, DERIVED_TEXT, CHECK_TEXT, SELF_APPROVE_TEXT, SELF_REQUEST_TEXT,
    STALE_TEXT, NEEDS_HUMAN_TEXT, UNDO_TEXT, MERGE_CONFIRM_TEXT, mergeNeedsConfirm,
    isMachineryPath, isDerivedPath, pullBadges, loadPullFiles, ageText,
    PREVIEW_CONTENT_ONLY_TEXT, PREVIEW_UNLISTED_TEXT, previewScope,
    gateRunOf, checkStatus, annotationRows, loadAnnotations, annotationText, undoOnGitHubUrl,
    vercelCommentUrl, reviewActionsFor, reviewRequest, actionOutcome, runReviewAction,
    previewPages, loadHeadRegistries,
  });

  if (typeof window !== 'undefined') window.HCCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}());
