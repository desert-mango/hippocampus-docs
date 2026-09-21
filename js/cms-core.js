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

   READ-ONLY IN THIS UNIT (U7a). The GitHub client sends GET only (its
   `methods` list). The one POST in this file is the sign-in exchange to this
   site's own /api/auth. Seams for the next units:
     - U8 (Review) and U7b (Edit) add their write verbs to WRITE_METHODS in
       createGitHubClient and call client.send(); the path guard stays.
     - U8 fills the preview area with createPreviewHost + refFetcher(token,
       <PR head sha>); U7b uses draftFetcher(files, refFetcher(token, <main
       sha>)) for the in-memory draft.
     - The route table ROUTES names each route's owner; the views live in
       js/cms.js's VIEWS map.

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
  // U8 and U7b add their verbs here ('POST', 'PUT'); nothing in U7a writes.
  const WRITE_METHODS = Object.freeze([]);

  function createGitHubClient(deps) {
    const d = deps || {};
    const methods = Object.freeze(READ_METHODS.concat(WRITE_METHODS));

    async function send(method, p, opts) {
      if (methods.indexOf(method) < 0) throw new Error(`the CMS does not send ${method}`);
      assertRepoPath(p);
      const o = opts || {};
      const init = {
        method,
        headers: {
          Accept: o.accept || 'application/vnd.github+json',
          Authorization: `Bearer ${d.token}`,
        },
        cache: 'no-store',
      };
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

  const api = Object.freeze({
    REPO_OWNER, REPO_NAME, REPO_FULL, API_ROOT, REPO_API_PATH, GITHUB_WEB,
    CALLBACK_PATH, SESSION_KEY, NO_ACCESS_TEXT, PLACEHOLDER_TEXT, PROTOCOLS_URL,
    POPUP_CLOSE_GRACE_MS,
    ROUTES, BRIDGE_PATH_RE,
    roleFromPermissions, parseRoute, orderOpenPulls, recentMerges, loadRecentMerges,
    createGeneration, randomHex, authorizeUrl, createSignIn,
    makeSession, readSession, writeSession, clearSession,
    assertRepoPath, createGitHubClient,
    editPath, pencilUrl, placeholderLink,
    isBridgePath, previewFragment, refFetcher, draftFetcher, createPreviewHost,
  });

  if (typeof window !== 'undefined') window.HCCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}());
