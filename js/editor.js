// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 19 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Draw Editor mode on the site's own page: the switch, the sandboxed page frame, the tray and the block editor.
/* Editor mode (plan D-C, D-D, D-G, D-H, D-N). This file started as a byte
   copy of the old /cms/ editor (retired in U8; /cms/ now redirects) and runs in the
   SITE's page (index.html): js/app.js injects js/cms-core.js, this file and
   css/editor.css only for a signed-in session or the "Sign in to edit"
   click (D-C), then calls HCEditor.start(opts). Guests never load it.
   Logic lives in js/cms-core.js (HCCore, node-tested); this file is the DOM
   around it.

   What it draws:
     - the header switch (Editor on / off), and who is signed in;
     - Editor on: body.hc-editor-on hides #content and #hc-frame-host takes
       the content cell with the real site in a sandboxed frame at the
       current route (js/source.js's bridge, section 9). The site's own router
       keeps painting the sidebar, the nav and the title; a parent navigation
       reloads the frame there, and the frame's own navigation (hc-route)
       moves the parent's hash with no reload. The frame hides its chrome
       (hc-framed, js/editor-frame.js).
     - the page's Markdown reaches the frame with id-sentinels before every
       block (HCCore.withSentinels, prefix = the first 16 characters of THIS
       load's nonce), so the frame groups the blocks and posts
       hc-block-select / hc-block-insert; a picked block is typed in the
       page itself, and every change is HCCore.replaceSpan of its character
       SPAN in the draft (HCCore.spanOf). Files are read at a commit sha
       through HCCore.cachedFetcher, and drafts are served from memory, so a
       reload after an edit makes no network call.
     - the thin editor page (#hc-tray, routed by its own hash trayHash, never
       the site's): only the whole page as Markdown (#/edit/<page>) and the
       raw data files (#/edit, #/edit/data/…), from the account menu. U0b
       (editor UI/UX build, plan D18) removed the proposals list, the review
       page, the Guide, View settings, the image library, the page list, the
       New project / New person forms, both bars above the page and the Send
       box; their addresses redirect to the page (REDIRECTS).
     - proposals in place (U7, plan D-F, D-G): an open proposal that touches
       the page on screen is drawn over main in the frame — the composite of
       HCCore.overlayOnMain (the PR's block diff from its merge base, read
       with compare), marked add / del / change / conflict — with the review
       rail's cards beside it. The frame's indices are then the composite's: a
       main block is edited at its index in main, a proposal's block opens
       its card. My draft of the page is shown instead when I have one; the
       newest of several proposals is drawn. View settings are fixed
       (HCCore.viewSettings is constants).

   It talks to this one repository only (HCCore's client refuses any other
   path), and its only writes are the review actions HCCore.runReviewAction
   sends and the proposal HCCore.runPropose sends. The token lives in page
   memory and in closures (U1: a reload or another tab gets it back from the
   sealed cookie, through js/app.js); it never enters the page's DOM, the frame,
   or a message. Every GitHub-derived string is set as text.

   Seams:
     HCEditor.start(opts)  boot once: opts.fetch replaces window.fetch for
                           every GitHub and /api call (the localhost walk's fake
                           GitHub); opts.session is a session held in memory
                           only, never written under HCCore.SESSION_KEY.
     VIEWS                 thin editor page route name -> view function (route, epoch).
     HCEditor.helpers      REDIRECTS, redirectOf and the helpers kept from the removed screens.
     mountPreview(el, {route, fetcher})   a sandboxed preview under el. */
(function () {
  'use strict';

  const C = window.HCCore;
  const D = window.HCDock;   // the dock (js/editor-dock.js, loaded just before this file)
  let main = null;         // the tray's view panel (the old #cms-main)
  let notice = null;       // the tray's notice line
  let tray = null;         // aside#hc-tray
  let trayBody = null;     // the tray's scrolling body
  let controls = null;     // the Editor controls (switch, avatar, role), in the dock
  let dock = null;         // the bottom-right dock (js/editor-dock.js draws it; editor redesign U4a)
  let switchBtn = null;
  let who = null;
  let frameHost = null;    // #hc-frame-host (index.html)
  let trayTitle = null;    // the editor page's heading (round 2, R3: the tabs are gone)
  let menuWhole = null;    // the account menu's "Edit whole page as Markdown" (U0b)
  let menuData = null;     // the account menu's "Data files" (U0b)
  let handle = null;       // the tray's handle while it is closed (the dock's "Proposals" link)
  let trayHash = '#/';     // the tray's own route (HCCore.parseRoute), never the site's hash
  let avatarBtn = null;    // the header's avatar (its menu holds Sign out)
  let menu = null;         // the avatar's menu
  let menuWho = null;      // "Signed in as <login>", in the menu
  let tellFn = null;       // js/app.js's footer line (HCEditor.start's opts.status)
  let sessionFn = null;    // js/app.js hears signed in / out (opts.onSession)
  let lastSigned = null;   // what sessionFn last heard
  let adopted = null;      // the window the sign-in click opened, until the sign-in takes it
  let avatars = null;      // login -> committed avatar path (data/graph/people-public.json)

  const state = {
    session: null,      // {token, expiresAt, login}
    client: null,       // HCCore GitHub client bound to the token
    user: null,         // GET /user
    role: null,         // HCCore.roleFromPermissions(...)
    access: 'none-yet', // 'none-yet' | 'checking' | 'ok' | 'no-access' | 'error'
    accessError: '',
    memoryOnly: null,   // the session, when sessionStorage refused to hold it (or the walk's)
    regs: null,         // {setup, projects, tools} for the page ids
    previews: new Set(),
  };
  let routeEpoch = 0;
  let pollTimer = null;
  // bumped by every refresh, sign-in and sign-out: a GitHub answer that
  // arrives for an older generation is dropped, never applied
  const sessionGen = C.createGeneration();
  const STALE = 'stale answer';

  /* The site's theme now: the sandboxed page frame cannot read it, so it is told (the frame fragment, and
     hc-editor when the toggle changes it). */
  const siteTheme = () => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');

  function store() {
    try { return window.sessionStorage; } catch (e) { return null; }
  }
  function localStore() {
    try { return window.localStorage; } catch (e) { return null; }
  }
  const randomValues = (arr) => window.crypto.getRandomValues(arr);
  // HCEditor.start({fetch}) may replace it (the walk's fake GitHub); else
  // window.fetch, looked up at call time
  let fetchImpl = null;
  const netFetch = (url, init) => (fetchImpl ? fetchImpl(url, init) : window.fetch(url, init));
  // ------------------------------------------------------------ helpers ---

  /* Build DOM from data: text always goes in as text, never as HTML (PR
     titles and logins are other people's words). */
  function h(tag, attrs) {
    const el = document.createElement(tag);
    const a = attrs || {};
    for (const k of Object.keys(a)) {
      if (a[k] === null || a[k] === undefined || a[k] === false) continue;
      if (k === 'class') el.className = a[k];
      else if (k === 'text') el.textContent = a[k];
      else el.setAttribute(k, a[k] === true ? '' : String(a[k]));
    }
    for (let i = 2; i < arguments.length; i += 1) {
      const c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }
  // a link out of the site opens beside it: the editor page (and its drafts) stays
  const link = (href, text, cls) => {
    const out = /^https?:/.test(String(href));
    return h('a', { href, class: cls, target: out ? '_blank' : null, rel: out ? 'noopener noreferrer' : null }, text);
  };

  function paint(epoch, nodes) {
    if (epoch !== routeEpoch) return false;
    main.replaceChildren(...[].concat(nodes).filter(Boolean));
    return true;
  }

  function say(text, kind) {
    notice.textContent = text || '';
    notice.hidden = !text;
    notice.classList.toggle('is-error', kind === 'error');
    if (text) unfoldDock();
  }
  /* The status line lives in the bubble: a message must be seen, so a tucked bubble unfolds (js/editor-dock.js). */
  function unfoldDock() { D.unfold(); }

  /* Sign-in news: the footer line beside "Sign in to edit" (js/app.js),
     because the tray is not on screen while nobody is signed in. */
  function tell(text, kind) {
    if (tellFn) tellFn(text || '', kind);
    else say(text, kind);
  }

  function prLink(n) { return `${C.GITHUB_WEB}/pull/${n}`; }
  function day(iso) {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '';
  }
  function loginOf(p) { return String((p && p.user && p.user.login) || 'unknown'); }

  // ---------------------------------------------------------- the client ---

  const webSubtle = () => { try { return (window.crypto && window.crypto.subtle) || null; } catch (e) { return null; } };

  /* U1: the session cookie and its marker go at the server (HCCore.forgetSession, to /api/auth).
     forgetCookie() is the explicit Sign out: the cookie goes and the token is revoked.
     forgetCookie(deadToken) is GitHub's 401: the delete call with X-HC-If-Token (the dead token's
     sha256), so the server clears the cookie only while it still holds that token (another
     tab may have signed in since) and revokes nothing; -> a Promise of the hash, or null
     when nothing was sent. Without crypto.subtle no hash can be made, and a delete call without
     the header would be a full sign-out of whatever the cookie holds — so on the 401 path
     NOTHING is sent: only the page's memory session drops (a dead cookie then fails its
     own next resume). */
  function forgetCookie(deadToken) {
    const signOut = deadToken === undefined;
    return (signOut ? Promise.resolve(null) : C.tokenHash(deadToken, webSubtle())).then((hash) => {
      if (!signOut && !hash) return null;
      C.forgetSession(netFetch, signOut ? undefined : { ifTokenHash: hash });
      return hash;
    });
  }

  /* GitHub refused this token (401): the cookie goes only if it still holds it, and the
     other tabs hear its fingerprint (the first 16 hex of the hash): only a tab holding
     the same token drops it. */
  function tokenRefused(token) {
    if (typeof token !== 'string' || !token) return;
    const ch = channel;
    forgetCookie(token).then((hash) => { if (hash && ch) ch.signedOut(hash.slice(0, 16)); });
  }

  /* opts.elsewhere: another tab signed out (its 'signed-out' message): this tab
     only drops its copy. opts.signOut: the person's own Sign out: the server
     cookie goes (HCCore.forgetSession, which also revokes the token) and every
     other tab hears it. Otherwise GitHub refused the token (401): tokenRefused. */
  function endSession(message, opts) {
    const elsewhere = Boolean(opts && opts.elsewhere);
    const signOut = Boolean(opts && opts.signOut);
    const held = state.session || state.memoryOnly;
    const dead = held && typeof held.token === 'string' ? held.token : null;
    sessionGen.next();
    if (ed.on) setEditor(false);
    C.clearSession(store());
    if (signOut) {
      forgetCookie();
      if (channel) channel.signedOut();
    } else if (!elsewhere) {
      tokenRefused(dead);
    }
    membersClear();
    Object.assign(state, { session: null, client: null, user: null, role: null,
      access: 'none-yet', accessError: '', memoryOnly: null });
    // the file cache reads with this session's token: it goes with it (a
    // sign-in's refresh() builds the next one; sessionCache() refuses meanwhile)
    ed.cache = null;
    ed.mainSha = null;
    forgetProposals();
    renderChrome();
    if (message) tell(message, 'error');
    route();
  }

  /* A GET through the signed-in client, as {ok, status, data}. The answer
     belongs to the session that asked: when that session has since ended or
     been replaced, it is dropped (thrown as STALE, which route() swallows),
     so an old 401 never ends a newer session. A 401 for the current session
     (an expired or revoked token) ends it. */
  async function apiResponse(p, opts) {
    if (!state.client) throw new Error('not signed in');
    const gen = sessionGen.current();
    const res = await state.client.get(p, opts);
    if (!sessionGen.isCurrent(gen)) throw new Error(STALE);
    if (res.status === 401) {
      endSession('Your sign-in has ended. Please sign in again.');
      throw new Error('signed out');
    }
    return res;
  }

  /* The same, resolved to the parsed JSON; any other failure throws. */
  async function api(p) {
    const res = await apiResponse(p);
    if (!res.ok) {
      throw new Error(res.status ? `GitHub answered HTTP ${res.status}` : 'GitHub could not be reached');
    }
    return res.data;
  }

  // ------------------------------------------------------------ sign-in ---

  const signIn = C.createSignIn({
    origin: window.location.origin,
    getRandomValues: randomValues,
    // the window js/app.js opened inside the click, when there is one: a
    // window opened after an await is blocked
    openWindow: (url, name, features) => {
      const w = adopted;
      adopted = null;
      return w || window.open(url, name, features);
    },
    fetch: netFetch,
  });

  function watchPopup() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (signIn.pendingState() === null) { clearInterval(pollTimer); return; }
      if (signIn.popupClosed(Date.now())) {
        clearInterval(pollTimer);
        tell('Sign-in was cancelled: the GitHub window closed before it finished.', 'error');
      }
    }, 400);
  }

  /* The sign-in. From the footer's click, `popup` is the window js/app.js
     opened inside it (adopted by openWindow above); start() asks this
     site's /api/auth for the App's client id and sends that window to
     GitHub, and its hc-code message comes back through onMessage. */
  function onSignInClick(popup) {
    adopted = popup || null;
    tell('');
    signIn.start().then((res) => {
      if (!res.ok) { tell(res.message, 'error'); return; }
      tell('Finish signing in in the GitHub window…');
      watchPopup();
    });
  }

  /* exchange: a Promise of {token, expiresIn} — the sign-in's code exchange,
     or (opts.resumed) the token js/app.js got back from the session cookie on
     a reload or in another tab. A resumed sign-in does not force Editor mode
     on (start() restores what the tab had); one GitHub no longer accepts (401)
     clears the cookie, and the page is a guest's again. */
  async function completeSignIn(exchange, opts) {
    const resumed = Boolean(opts && opts.resumed);
    // the newest thing to happen to the session: a later sign-in or a
    // sign-out while this one waits makes it stale, and it then writes nothing
    const gen = sessionGen.next();
    let out;
    try {
      out = await exchange;
    } catch (e) {
      if (sessionGen.isCurrent(gen)) tell(`Sign-in failed: ${e.message}.`, 'error');
      return;
    }
    if (!sessionGen.isCurrent(gen)) return;
    const client = C.createGitHubClient({ fetch: netFetch, token: out.token });
    const me = await client.get('/user');
    if (!sessionGen.isCurrent(gen)) return;
    if (!me.ok || !me.data || typeof me.data.login !== 'string') {
      if (resumed) {
        if (me.status === 401) tokenRefused(out.token);
        await refresh();          // nobody: the guest's sign-in button comes back
        tell(me.status === 401 ? 'Your sign-in has ended. Please sign in again.'
          : 'GitHub did not say who you are. Reload the page to try again.', 'error');
        return;
      }
      // the code exchange already set the session cookie: a token GitHub refuses must not resume on a reload
      if (me.status === 401) tokenRefused(out.token);
      tell('Signed in, but GitHub did not say who you are. Please sign in again.', 'error');
      return;
    }
    const record = C.makeSession(out.token, out.expiresIn, me.data.login, Date.now());
    state.memoryOnly = C.writeSession(store(), record) ? null : record;
    tell('');
    await refresh();
    // the person asked to edit: Editor mode comes on once GitHub confirmed access
    if (!resumed && state.session && state.access === 'ok' && !ed.on) setEditor(true);
  }

  /* U1 (D21, ED63): sign-out only signs out. The login's unsent edits stay in
     this browser (localStorage, keyed by login) and come back at the next
     sign-in; nobody else's sign-in sees them. No question first. */
  function onSignOutClick() {
    signIn.cancel();
    endSession(null, { signOut: true });   // the cookie too, and every other tab (U1)
    tell('Signed out.');
  }

  // ---------------------------------------------------- who is signed in ---

  /* The org reader's answers (HCCore.createOrgReader, sessionStorage keys
     'hc-org-cache:<url>') belong to the login that read them. Sign-out drops
     them (HCCore.clearSession); a sign-in that REPLACES a live session, with
     no sign-out between, drops them here: the first person's answers are
     never served to the second. ORG_CACHE_LOGIN records whose they are (it
     shares the prefix, so clearSession drops it too); the same login again
     (a reload, a refresh) keeps them. */
  const ORG_CACHE_PREFIX = 'hc-org-cache:';
  const ORG_CACHE_LOGIN = `${ORG_CACHE_PREFIX}login`;
  function orgCacheFor(login) {
    const st = store();
    try {
      // only a GitHub login is ever written as the owner; anything else owns
      // nothing: the cache is dropped and no marker is written
      const ok = typeof login === 'string' && GH_LOGIN_RE.test(login);
      if (!st || (ok && st.getItem(ORG_CACHE_LOGIN) === login)) return;
      const keys = [];
      for (let i = 0; i < st.length; i += 1) {
        const k = st.key(i);
        if (typeof k === 'string' && k.startsWith(ORG_CACHE_PREFIX)) keys.push(k);
      }
      keys.forEach((k) => st.removeItem(k));
      if (ok) st.setItem(ORG_CACHE_LOGIN, login);
    } catch (e) { /* no storage: the reader keeps nothing either */ }
  }

  /* Reads the session, then asks GitHub who this is and what they may do on
     THIS repository: GET /user and GET /repos/desert-mango/hippocampus-docs.
     A 404 from the repository means no access, and the page then says so
     and nothing else (D8). Each call is a new generation: when a newer
     refresh, a sign-in or a sign-out happened while GitHub answered, the
     answer is old and changes nothing. */
  async function refresh() {
    const gen = sessionGen.next();
    membersClear();
    clearPreviews();
    const s = C.readSession(store(), Date.now()) || state.memoryOnly;
    if (s) orgCacheFor(s.login);
    if (!s) {
      Object.assign(state, { session: null, client: null, user: null, role: null,
        access: 'none-yet', accessError: '' });
      renderChrome();
      route();
      return;
    }
    const client = C.createGitHubClient({ fetch: netFetch, token: s.token });
    Object.assign(state, { session: s, client, user: null, role: null,
      access: 'checking', accessError: '' });
    // files at a commit sha, read once per session (D-D); main is resolved again
    const refs = new Map();
    const refFor = (sha) => {
      if (!refs.has(sha)) refs.set(sha, C.refFetcher(s.token, sha, netFetch));
      return refs.get(sha);
    };
    ed.cache = C.cachedFetcher((sha, p) => refFor(sha)(p));
    ed.mainSha = null;
    forgetProposals();
    renderChrome();
    route();
    const [me, repo] = await Promise.all([client.get('/user'), client.get(C.REPO_API_PATH)]);
    if (!sessionGen.isCurrent(gen)) return;
    if (me.status === 401 || repo.status === 401) {
      endSession('Your sign-in has ended. Please sign in again.');
      return;
    }
    state.user = me.ok ? me.data : null;
    if (repo.status === 404) {
      state.access = 'no-access';
    } else if (repo.ok && repo.data) {
      state.access = 'ok';
      state.role = C.roleFromPermissions(repo.data.permissions);
    } else {
      state.access = 'error';
      state.accessError = repo.status ? `GitHub answered HTTP ${repo.status}` : 'GitHub could not be reached';
    }
    renderChrome();
    route();
    membersSweep();
  }

  /* The header's Editor controls: the switch, then who is signed in — the
     avatar (its menu holds Sign out), the first name, the role. The switch
     works once GitHub has confirmed access. js/app.js hears every change
     between signed in and signed out (its footer link follows). */
  /* ---- Undo / Redo (round 2, R2b; Kyle 2026-10-15) ----
     ONE ordered history per page draft, kept here. Every change to the draft of the page on screen passes
     histNote (drafts.put) and pushes the text it replaces — except typing, which pushes once per burst: the
     frame marks a burst's start with a restore point of the block (hc-history {index, snap}). Undo puts the
     text back; when the step is typing in THIS frame load, the frame is told to show its restore point again
     (hc-editor.cmd {restore}: the suggestion marks come back too, no reload), else the frame is drawn again.
     Redo walks forward the same way; any new change clears it. The history ends with the draft (sent,
     discarded), on another page, and when Editor mode goes off. */
  const HIST_MAX = 200;
  const HIST_BURST_MS = 1500;
  const hist = { key: null, file: null, last: null, undo: [], redo: [], pending: null, typed: null, applying: false, seq: 0, typing: false };
  function histReset(page) {
    const d = page && ed.draft && ed.draft.key === page.pageId ? ed.draft : null;
    Object.assign(hist, { key: page ? page.pageId : null, file: page ? page.file : null,
      last: d && typeof d.files[page.file] === 'string' ? d.files[page.file] : null, undo: [], redo: [], pending: null, typed: null });
  }
  function histNote(d) {
    if (!d || !hist.key || d.key !== hist.key || !d.files || typeof d.files[hist.file] !== 'string') return;
    const text = d.files[hist.file];
    const prev = hist.last !== null ? hist.last : (d.originals && typeof d.originals[hist.file] === 'string' ? d.originals[hist.file] : null);
    hist.last = text;
    if (hist.applying || prev === null || text === prev) return;
    const t = Date.now();
    if (hist.typing) {
      const same = hist.typed && hist.typed.index === ed.selected && t - hist.typed.at < HIST_BURST_MS;
      hist.typed = { index: ed.selected, at: t };
      if (!hist.pending && same) return;                  // the same burst: one step
    } else hist.typed = null;
    const snap = hist.typing && hist.pending ? hist.pending : null;
    hist.undo.push({ text: prev, snap: snap ? snap.snap : null, index: snap ? snap.index : null, load: ed.loads,
      span: hist.typing && hist.spanBefore ? hist.spanBefore : null });
    if (hist.undo.length > HIST_MAX) hist.undo.shift();
    hist.redo = [];
    hist.pending = null;
  }
  function histRemoved(key) {
    if (hist.applying || !hist.key || key !== hist.key) return;
    if (hist.typing) { const d = ed.draft; if (d && d.key === key) histNote(d); return; }   // typed back to the original
    Object.assign(hist, { last: null, undo: [], redo: [], pending: null, typed: null });
  }
  function histText(page, text, span) {
    const d = ed.draft && ed.draft.key === page.pageId ? ed.draft : drafts.get(page.pageId);
    if (!d) return false;
    hist.applying = true;
    try {
      d.files[page.file] = typeof text === 'string' ? text : d.originals[page.file];
      if (C.isDirty(d)) drafts.put(d); else drafts.remove(d.key);
    } finally { hist.applying = false; }
    ed.draft = d;
    hist.last = d.files[page.file];
    if (ed.sel && ed.sel.key === d.key && !ed.sel.whole && Number.isInteger(ed.selected)) {
      // the open block's span as it was at that step (its blank lines included), else found again
      const sp = span && span.end <= d.files[page.file].length ? span : C.spanOf(d.files[page.file], ed.selected);
      if (sp) ed.sel.span = { start: sp.start, end: sp.end };
    }
    return true;
  }
  function undoRedo(op) {
    const page = ed.page;
    if (!ed.on || !page || hist.key !== page.pageId || !canEditPage(page) || ed.show) return;
    const from = op === 'undo' ? hist.undo : hist.redo;
    const to = op === 'undo' ? hist.redo : hist.undo;
    const e = from.pop();
    if (!e) return;
    const inPlace = Boolean(e.snap) && e.load === ed.loads && Number.isInteger(e.index);
    hist.seq += 1;
    const save = inPlace ? `u${hist.seq}` : null;
    const spanNow = ed.sel && !ed.sel.whole && ed.selected === e.index ? { start: ed.sel.span.start, end: ed.sel.span.end } : null;
    to.push({ text: hist.last, snap: save, index: e.index, load: ed.loads, span: spanNow });
    Object.assign(hist, { pending: null, typed: null });
    if (!histText(page, e.text, ed.selected === e.index ? e.span : null)) return;
    say('');
    if (inPlace) {
      ed.cmdN = (ed.cmdN || 0) + 1;
      ed.cmdOut = { n: ed.cmdN, op: 'restore', index: e.index, snap: e.snap, save };
      postEditor();
    } else frameTo(ed.route, true);
    refreshDock();
  }
  /* "N changes" on this page: the blocks my draft changed, added or removed against what it started from. */
  function pageChanges() {
    const d = ed.draft;
    const page = ed.page;
    if (!d || !page || !d.files || typeof d.files[page.file] !== 'string' || !d.originals) return 0;
    if (page.data) return C.peopleChangeCount(d.originals[page.file], d.files[page.file]);   // the Team page: people changed
    const diff = C.blockDiff(d.originals[page.file], d.files[page.file]);
    if (!diff) return d.files[page.file] !== d.originals[page.file] ? 1 : 0;   // a page the block model refuses (CRLF): changed or not
    return diff.filter((e) => e.status !== 'same').length;
  }
  const accessLockNote = (a, projectId, name) => h('section', { class: 'hc-access hc-access-locked', 'data-access-locked': true,
    'aria-label': 'Edit access' }, ...D.lockParts(a, projectId, name));
  /* The dock is js/editor-dock.js (HCDock); this is what it shows, built from the editor's state on every redraw.
     U2 (plan D1, D4): the role chip, and the changed pages I may send (one row each in the changes list). */
  function dockView(opts) {
    const signedIn = Boolean(state.session);
    const editing = ed.on && Boolean(ed.page) && canEditPage(ed.page);
    const ours = editing && hist.key === ed.page.pageId;
    const projectId = signedIn && ed.on && state.access === 'ok' ? projectIdOf(ed.page) : null;
    const mine = signedIn && ed.on ? sendable() : [];
    return {
      signedIn,
      login: signedIn ? String(state.session.login) : null,
      on: Boolean(ed.on),
      editing,
      changes: editing ? pageChanges() : 0,
      canUndo: Boolean(ours && hist.undo.length),
      canRedo: Boolean(ours && hist.redo.length),
      access: projectId ? projectAccess(projectId) : null,
      projectId,
      page: ed.page,
      draftKey: ed.draft ? ed.draft.key : null,
      chip: signedIn ? roleChip() : '',
      pages: mine.map(changedPage),
      pageCount: C.pageChangeCount(mine),
      typed: Boolean(opts && opts.typed),
    };
  }
  function refreshDock(opts) {
    if (!dock) return;
    D.refresh(dockView(opts));
  }
  /* The drafts Send for review takes: changed (HCCore.isDirty: a file or notes) and mine to change (the edit gate). */
  function sendable() {
    return drafts.list().filter((d) => C.isDirty(d) && canEditKey(d.key));
  }
  /* One row of the changes list: the page, how many blocks changed (data files: how many changes), where it is. */
  function changedPage(d) {
    let blocks = 0;
    let unit = 'blocks';
    for (const f of Object.keys(d.files)) {
      if (d.files[f] === d.originals[f]) continue;
      if (f === PEOPLE_FILE) { blocks += C.peopleChangeCount(d.originals[f], d.files[f]); unit = 'changes'; continue; }
      const diff = /\.md$/.test(f) && typeof d.originals[f] === 'string' && typeof d.files[f] === 'string'
        ? C.blockDiff(d.originals[f], d.files[f]) : null;
      if (diff) blocks += diff.filter((e) => e.status !== 'same').length;
      else { blocks += 1; if (!/\.md$/.test(f)) unit = 'changes'; }
    }
    const route = state.regs || d.key === PEOPLE_PAGE ? (d.key === PEOPLE_PAGE ? '/team' : C.routeForPage(d.key, state.regs)) : null;
    return { key: d.key, label: String(d.label || d.key), blocks, unit, route: route || null };
  }
  /* The role chip (plan D1, ED5, ED62): what you can do, from the real rule. Admin; a Maintainer approves every
     project; a Writer approves the projects main's edit-access.json lists them on (HCCore.accessFor), else edits;
     a reader reads. */
  function roleChip() {
    const r = state.role;
    if (!r || state.access !== 'ok') return '';
    if (r.key === 'admin') return 'Admin';
    if (r.key === 'maintain') return 'Can approve';
    if (r.key !== 'push') return 'Read only';
    const n = approvable().length;
    return n ? `Can approve ${n} ${n === 1 ? 'project' : 'projects'}` : 'Can edit';
  }
  /* The projects whose sends I may approve, as a Writer: the edit gate's read of main's edit-access.json. A
     Writer's chip and review count need it on every page, so in Editor mode asking starts the background read
     (accessGateNow); when it lands, accessChanged draws the chip again and reloads the count. */
  const accessDocNow = () => {
    const g = ed.on && state.session && state.role && state.role.key === 'push' ? accessGateNow() : accessGate;
    return g.gen === sessionGen.current() && g.status === 'read' ? g.doc : null;
  };
  function approvable() {
    const doc = accessDocNow();
    const ids = doc && isPlain(doc.projects) ? Object.keys(doc.projects) : [];
    const login = sessionLogin();
    return ids.filter((id) => C.accessFor(doc, id, login, state.role).can);
  }
  /* The project names, for the titles of access sends. */
  function projectNames() {
    const out = {};
    const p = state.regs ? state.regs.projects : null;
    const list = Array.isArray(p) ? p : (p && Array.isArray(p.projects) ? p.projects : []);
    for (const x of list) if (x && typeof x.id === 'string' && typeof x.name === 'string') out[x.id] = x.name;
    return out;
  }
  /* D5: my sends, open or closed in the last 14 days, with their status. A closed one that was not merged is read
     once more: no changed file (a notes-only send) -> "seen"; an approval record on it (go-live put its edits
     live, then closed it) -> "live". -> [{number, title, branch, status, at, url, route}] or null */
  const SENDS_PATH = () => `${C.REPO_API_PATH}/pulls?state=all&sort=updated&direction=desc&per_page=100`;
  const sendMarks = new Map();          // number -> {applied, notesOnly}: a closed send does not change
  const sendPulls = new Map();          // number -> the pull (for openSend)
  async function loadSends() {
    if (!state.session || !state.client) return null;
    const gen = sessionGen.current();
    const res = await apiResponse(SENDS_PATH());
    if (!res.ok || !Array.isArray(res.data) || !sessionGen.isCurrent(gen)) return null;
    const login = sessionLogin();
    const pulls = res.data.filter((p) => p && typeof p === 'object');
    const closedMine = C.ownSends(login, pulls, Date.now()).filter((x) => x.status === 'declined').slice(0, 10);
    for (const x of closedMine) {
      if (sendMarks.has(x.number)) continue;
      const one = await apiResponse(`${C.REPO_API_PATH}/pulls/${x.number}`);
      const notes = await apiResponse(`${C.REPO_API_PATH}/issues/${x.number}/comments?per_page=100`);
      const applied = notes.ok && Array.isArray(notes.data)
        && notes.data.some((c) => c && typeof c.body === 'string' && /^hc-approved /.test(c.body));
      sendMarks.set(x.number, { applied, notesOnly: one.ok && one.data && one.data.changed_files === 0 });
    }
    if (!sessionGen.isCurrent(gen)) return null;
    const marked = pulls.map((p) => (sendMarks.has(p.number) ? Object.assign({}, p, sendMarks.get(p.number)) : p));
    for (const p of marked) sendPulls.set(p.number, p);
    return C.ownSends(login, marked, Date.now());
  }
  /* Open the page a send changed: its first changed file, or (a notes-only send) the page its text names. */
  async function openSend(item) {
    const n = item && Number.isInteger(item.number) ? item.number : null;
    if (n === null) return;
    const files = await filesOrNull(n).catch(() => null);
    let file = Array.isArray(files) && files.length && files[0] && typeof files[0].filename === 'string' ? files[0].filename : null;
    if (!file) {
      const pull = sendPulls.get(n);
      const m = pull && typeof pull.body === 'string' ? /\(`([A-Za-z0-9._/-]+)`\)/.exec(pull.body) : null;
      file = m ? m[1] : null;
    }
    const regs = state.regs || null;
    const pageId = file === PEOPLE_FILE ? PEOPLE_PAGE : (file && regs ? C.pageIdForFile(file, regs) : null);
    const to = pageId === PEOPLE_PAGE ? '/team' : (pageId ? C.routeForPage(pageId, regs) : null);
    if (typeof to === 'string' && to) window.location.hash = `#${to}`;
    else say('That send changed no page on this site.');
  }
  /* The review count until U3's list: the open sends of others I may approve (Admin and Maintainer: every one;
     a Writer: those wholly inside projects that list them, HCCore.ownsAll). */
  async function reviewable(pulls) {
    const r = state.role;
    if (!r || r.canPush !== true) return 0;
    const login = sessionLogin().toLowerCase();
    const others = C.orderOpenPulls(pulls, null).filter((p) => !(p.user && String(p.user.login).toLowerCase() === login));
    if (r.key === 'admin' || r.key === 'maintain') return others.length;
    const doc = accessDocNow();
    if (!doc || !approvable().length) return 0;
    let n = 0;
    for (const p of others) {
      const files = await filesOrNull(p.number);
      if (Array.isArray(files) && C.ownsAll({ login, files: files.map((f) => f && f.filename), access: doc })) n += 1;
    }
    return n;
  }

  /* U2 (plan D4, ED43, ED44): Send for review — one click, no box. The drafts I may send (only the draft `key`
     for Send this page) are split by kind (HCCore.splitSend: page edits together, go-live eligible; each facts
     file, the team, a new project, an access change on its own); each group is one send with its generated
     title, "Added to your send" when it builds on my open send. Then the bubble says "Sent · waiting for
     review" with Undo for 8 seconds (HCDock.offerUndo). ui: {go, result} (the thin editor page's button and
     its result line) or null (the bubble: the outcome is said on its status line). */
  const stillOpen = (target, own) => !target || own.some((p) => p.number === target.number && p.branch === target.branch);
  const closedText = (target) => `Your send #${target.number} is no longer open: discard these changes and start `
    + 'from the live site.';
  /* Send this page takes the image list too when it is on the same base: splitSend puts it in that page's send,
     so a new image goes with the page that shows it (the gate's 6a rule turns a page with an unlisted image red). */
  const sameSend = (a, b) => a.base.ref === b.base.ref && a.base.number === b.base.number;
  const withPage = (d, page) => Boolean(page) && d.key === C.MANIFEST_KEY && page.key !== C.MANIFEST_KEY && sameSend(d, page)
    && Object.keys(page.files).some((f) => /^content\/.+\.md$/.test(f) && page.files[f] !== page.originals[f]);
  async function sendAll(key, ui) {
    if (proposing || !state.client || !state.session) return;
    const list = sendable().filter((d, i, all) => !key || d.key === key || withPage(d, all.find((x) => x.key === key)));
    const show = (text, kind) => {
      if (!ui || !ui.result) { say(text, kind); return; }
      ui.result.textContent = text;
      ui.result.hidden = false;
      ui.result.classList.toggle('is-error', kind === 'error');
    };
    if (!list.length) { show('Nothing was sent: no page has changes.', 'error'); return; }
    const gen = sessionGen.current();
    proposing = true;
    if (ui && ui.go) ui.go.disabled = true;
    const login = String(state.session.login);
    const results = [];
    const failed = [];
    let signedOut = null;
    try {
      const own = await myProposals();
      const groups = C.splitSend(list, { login, names: projectNames() });
      for (const g of groups) {
        const problems = g.problems.concat(stillOpen(g.target, own) ? [] : [closedText(g.target)]);
        if (problems.length) { failed.push(`${g.title}: ${problems.join(' ')}`); continue; }
        let out;
        try {
          out = await C.runPropose(state.client, {
            login, now: Date.now(), origin: window.location.origin, summary: g.title, kind: g.kind, drafts: g.drafts,
            target: g.target, changes: g.changes, pages: g.pages, notes: g.notes,
          });
        } catch (e) {
          out = { ok: false, status: 0, message: `Something went wrong: ${(e && e.message) || e}` };
        }
        if (!sessionGen.isCurrent(gen)) return;
        if (out.status === 401) { signedOut = out.message; break; }
        if (!out.ok) { failed.push(`${g.title}: ${out.message}`); continue; }
        results.push({ g, out });
        if (out.signedOut) { signedOut = `${out.message} Your sign-in has ended. Please sign in again.`; break; }
      }
    } finally {
      proposing = false;
      if (ui && ui.go) ui.go.disabled = false;
    }
    if (!sessionGen.isCurrent(gen)) return;
    // what was sent leaves the drafts (a part that was not sent stays)
    takeSent(list, results.map((r) => r.g));
    if (ed.draft && !drafts.get(ed.draft.key)) { clearSelection(); frameTo(ed.route, false); }
    for (const r of results) D.sent(r.out.number);
    if (signedOut) {
      // the sign-in ended partway: Undo needs it, so none is offered; the line says what went
      const went = results.map((r) => `${r.g.title} (#${r.out.number})`).join(', ');
      endSession(went ? `${signedOut} Already sent for review: ${went}.` : signedOut);
      return;
    }
    if (results.length) {
      D.offerUndo({
        items: results.map((r) => ({ number: r.out.number, title: r.g.title,
          note: [r.g.eligible ? 'goes live on approval' : 'reviewed as a whole', r.out.added ? 'Added to your send' : '']
            .filter(Boolean).join(' · ') })),
        run: () => undoSends(results, gen),
      });
    }
    if (failed.length) show(`${results.length ? 'Not everything was sent' : 'Nothing was sent'}: ${failed.join(' ')}`, 'error');
    else say(results.map((r) => r.out.message).join(' '));     // the outcome line (the thin page's slot says errors)
    refreshDock();
    D.loadCount();
    if (ed.trayOpen) route();           // the thin editor page shows the file as it is now
  }
  /* The sent parts leave their drafts: a draft whose every change went is removed; one with a part left keeps
     only that part (the sent files go back to where they started). */
  function takeSent(list, groups) {
    for (const d of list) {
      const parts = [].concat(...groups.map((g) => g.drafts.filter((x) => x.key === d.key)));
      if (!parts.length) continue;
      const files = new Set([].concat(...parts.map((x) => Object.keys(x.files))));
      const notesGone = parts.some((x) => Array.isArray(x.notes));
      const rest = Object.keys(d.files).filter((f) => !files.has(f) && d.files[f] !== d.originals[f]);
      const notesLeft = !notesGone && Array.isArray(d.notes) && d.notes.length > 0;
      if (!rest.length && !notesLeft) { drafts.remove(d.key); chosenBase.delete(d.key); continue; }
      const next = Object.assign({}, d, { files: Object.assign({}, d.files) });
      for (const f of files) next.files[f] = d.originals[f];
      if (notesGone) delete next.notes;
      drafts.put(next);
    }
    editing = null;
  }
  /* Undo the sends of one click (HCCore.runUndo each, newest first) and put their drafts back. */
  async function undoSends(results, gen) {
    const back = [];
    const undone = [];
    const said = [];
    let kind = '';
    for (const r of results.slice().reverse()) {
      const u = await C.runUndo(state.client, r.out);
      if (!sessionGen.isCurrent(gen)) return { text: '' };
      if (!u.ok) { said.push(u.reason === 'changed' ? C.UNDO_CHANGED_TEXT : u.message); kind = 'error'; continue; }
      undone.push(r.out.number);
      back.push(...(Array.isArray(u.drafts) ? u.drafts : []));
      if (u.warning === 'dropped') { said.push(C.UNDO_DROPPED_TEXT); kind = 'error'; } else if (u.message) said.push(u.message);
    }
    putBack(back);
    if (ed.draft || back.some((d) => ed.page && d.key === ed.page.pageId)) frameTo(ed.route, false);
    refreshDock();
    D.loadCount();
    return { text: said.length ? said.join(' ') : 'Undone: your changes are back.', kind, undone };
  }
  /* The undone parts go back into their drafts (a part joins a draft of the same page made since). */
  function putBack(parts) {
    for (const p of parts) {
      if (!p || typeof p.key !== 'string' || !p.files) continue;
      const have = drafts.get(p.key);
      if (!have) { drafts.put(Object.assign({}, p)); continue; }
      const next = Object.assign({}, have, { files: Object.assign({}, have.files), originals: Object.assign({}, have.originals) });
      for (const f of Object.keys(p.files)) {
        if (next.files[f] !== undefined && next.files[f] !== next.originals[f]) continue;   // changed again since: keep that
        next.files[f] = p.files[f];
        next.originals[f] = p.originals[f];
      }
      if (Array.isArray(p.notes) && p.notes.length) next.notes = C.mergeNotes(p.notes, Array.isArray(have.notes) ? have.notes : []);
      drafts.put(next);
    }
  }
  /* What js/editor-dock.js may reach of the editor (its header documents every key). */
  function dockApi() {
    return {
      h,
      store: localStore,
      controls,
      switchBtn,
      closeMenu: () => closeMenu(),
      redraw: () => refreshDock(),
      undoRedo: (op) => undoRedo(op),
      sendAll: (key) => sendAll(key, null),
      go: (route) => { window.location.hash = `#${route}`; },
      loadSends: () => loadSends(),
      openSend: (item) => openSend(item).catch(shown),
      openReview: () => {
        if (!rail.cards.some((c) => c.anchor !== null)) return false;
        openSheet(null);
        return true;
      },
      shown: (e) => shown(e),
      avatar: (login, first) => avatarFace(login, first),
      accessAsk: (a, projectId, name, result) => accessAsk(a, { projectId, name, login: sessionLogin() }, accessUi(result)),
      onCount: (n) => { ed.count = n; },
      openCount: () => {
        const gen = sessionGen.current();
        return openPulls().then((pulls) => reviewable(pulls)).then((n) => (sessionGen.isCurrent(gen) ? n : null));
      },
    };
  }

  function renderChrome() {
    refreshDock();
    if (!controls) return;
    const signedIn = Boolean(state.session);
    controls.hidden = !signedIn;
    switchBtn.disabled = state.access !== 'ok';
    switchBtn.setAttribute('aria-checked', ed.on ? 'true' : 'false');
    switchBtn.classList.toggle('is-on', ed.on);
    if (lastSigned !== signedIn) {
      lastSigned = signedIn;
      if (sessionFn) sessionFn(signedIn);
    }
    who.replaceChildren();
    if (!signedIn) { closeMenu(); return; }
    const login = String(state.session.login);
    const name = state.user && typeof state.user.name === 'string' ? state.user.name.trim() : '';
    const first = name ? name.split(/\s+/)[0] : login;
    avatarBtn.replaceChildren(avatarFace(login, first));
    menuWho.textContent = `Signed in as ${login}`;
    menuWhole.hidden = !ed.on;
    menuData.hidden = !ed.on;
    who.appendChild(avatarBtn);
    // U2 (plan D1): the photo, then the role chip (js/editor-dock.js writes its words); the name stays for screen
    // readers; the review count moved to its own row under the pill
    const line = h('span', { class: 'hc-id-line' }, h('span', { class: 'hc-login', title: login, text: first }));
    if (state.role && state.access === 'ok') line.appendChild(D.chip());
    who.appendChild(h('span', { class: 'hc-id' }, line));
    who.appendChild(menu);
  }

  /* The avatar (plan D-J): the committed 64-px copy under data/graph/avatars/
     that data/graph/people-public.json names for this login, else the first
     name's initial. Never a live avatars.githubusercontent.com load. */
  const AVATAR_RE = /^data\/graph\/avatars\/[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:png|jpe?g)$/;
  function avatarMap(doc) {
    const out = Object.create(null);
    const people = doc && typeof doc === 'object' ? doc.people : null;
    if (!people || typeof people !== 'object' || Array.isArray(people)) return out;
    for (const login of Object.keys(people)) {
      const p = people[login];
      const src = p && typeof p === 'object' ? p.avatar : null;
      if (typeof src === 'string' && AVATAR_RE.test(src) && src.indexOf('..') < 0) out[login] = src;
    }
    return out;
  }
  function loadAvatars() {
    Promise.resolve().then(() => HC.fetchJSON('data/graph/people-public.json')).catch(() => null)
      .then((doc) => { avatars = avatarMap(doc); renderChrome(); });
  }
  function avatarFace(login, first) {
    const src = avatars ? avatars[login] : undefined;
    if (src) return h('img', { class: 'hc-avatar-img', src, alt: '', width: 24, height: 24 });
    return h('span', { class: 'hc-initials', 'aria-hidden': 'true', text: (Array.from(first)[0] || '?').toUpperCase() });
  }

  function openMenu() {
    if (!menu) return;
    menu.hidden = false;
    avatarBtn.setAttribute('aria-expanded', 'true');
  }
  function closeMenu() {
    if (!menu) return;
    menu.hidden = true;
    avatarBtn.setAttribute('aria-expanded', 'false');
  }

  // --------------------------------------------------------------- views ---

  function signInPanel() {
    return [
      h('h1', { text: 'Editor' }),
      h('div', { class: 'cms-panel' },
        h('p', { text: 'Sign in with your GitHub account to see and review proposed changes to this site.' }),
        h('p', { class: 'cms-muted' }, 'Want to fix something right now? Every page can be edited on github.com: ',
          link(`${C.GITHUB_WEB}/tree/main/content`, 'open its file and click the pencil'), '.')),
    ];
  }

  function openPulls() {
    return api(`${C.REPO_API_PATH}/pulls?state=open&per_page=100`);
  }

  // ---------------------------------------------------------- proposals ---
  /* U0b (editor UI/UX build, plan D18): the proposals list (#/, #/review), the review page (#/review/<n>) and
     both bars above the page are gone; their addresses redirect to the page (REDIRECTS, below). What stays is
     the data the page view and the review rail read: the open proposals with their files, and the shared trust
     and decision rules in js/cms-core.js (parseRecords, decisions, mayApproveEdit, proposalEligible,
     reviewActionsFor, runReviewAction, classifyAccessProposal, ownProposals), which U3's review list in the
     bubble builds on. */

  /* Every changed file of PR n, or null when GitHub would not list them
     (the page still shows the rest; a stale or signed-out answer is passed on). */
  async function filesOrNull(n) {
    try {
      return await C.loadPullFiles(api, n);
    } catch (e) {
      if (e && (e.message === STALE || e.message === 'signed out')) throw e;
      return null;
    }
  }





















  /* data/setup.json, data/projects.json and data/tools.json, read the way
     js/app.js reads them (HC.fetchJSON), for the page-id -> file mapping. */
  async function registries() {
    if (state.regs) return state.regs;
    const get = (p) => HC.fetchJSON(p).catch(() => null);
    const [setup, projects, tools] = await Promise.all([
      get('data/setup.json'), typeof HC.fetchProjects === 'function' ? HC.fetchProjects().catch(() => null) : get('data/projects.json'),
      get('data/tools.json')]);
    state.regs = { setup, projects, tools };
    return state.regs;
  }

  /* Who can edit which project (edit access, Kyle, 2026-10-19): MAIN's data/graph/edit-access.json, read
     through GitHub. tools/build_edit_access.py builds it from commits plus the admins' add and remove lists;
     this file only reads it (HCCore.accessFor). Read again when it is needed more than a minute after the
     last read, so a change shows here without a reload. A read that fails gives null: no editor's Approve
     until one succeeds. -> the document or null. */
  const ACCESS_FILE = 'data/graph/edit-access.json';
  const ACCESS_TTL_MS = 60 * 1000;
  let accessRead = { at: 0, doc: null, gen: -1 };
  async function accessRegistry() {
    const gen = sessionGen.current();
    if (accessRead.doc && accessRead.gen === gen && Date.now() - accessRead.at < ACCESS_TTL_MS) return accessRead.doc;
    // main's own file through GitHub (pinned to main's head now), never the copy the hosting deployment serves:
    // a preview deployment of a branch must not be able to name new editors
    let doc = null;
    try {
      const sha = await C.resolveRef(state.client, 'main');
      const answer = await sessionCache().get(sha, ACCESS_FILE);
      doc = answer && answer.ok ? JSON.parse(answer.text) : null;
    } catch (e) { doc = null; }
    if (!isPlain(doc)) doc = null;
    accessRead = { at: doc ? Date.now() : 0, doc, gen };      // a failed read fails closed: no editor rights until it reads
    return doc;
  }
  const sessionLogin = () => (state.session && typeof state.session.login === 'string' ? state.session.login : '');
  const projectIdOf = (page) => {
    const m = page ? /^project\/([a-z0-9][a-z0-9-]{0,80})$/.exec(String(page.pageId)) : null;
    return m ? m[1] : null;
  };

  /* The edit gate (Kyle, 2026-10-21: an Editor could change every project). Editing a project in Editor mode
     follows the same list as Approve: an Admin or Maintainer edits every project; an Editor (Write) edits a
     project only when HCCore.accessFor says so over MAIN's file (accessRegistry); this file never works the
     rule out. The list is read in the background: until it is read, and after a failed read, an Editor edits
     no project (fails closed) and the read is tried again a minute later. When an answer changes what you may
     do, the dock, the frame and the editor page are drawn again (accessChanged). Every other page keeps the
     role rule (canEdit): any Editor may propose there. */
  let accessGate = { gen: -1, status: 'unread', doc: null, at: 0, sig: '', pending: null };
  function accessGateNow() {
    const gen = sessionGen.current();
    if (accessGate.gen !== gen) accessGate = { gen, status: 'unread', doc: null, at: 0, sig: '', pending: null };
    const g = accessGate;
    const due = g.status === 'unread' || Date.now() - g.at >= ACCESS_TTL_MS;
    if (due && !g.pending && state.client && state.access === 'ok') {
      g.pending = accessRegistry().catch(() => null).then((doc) => {
        if (accessGate !== g) return;
        Object.assign(g, { pending: null, doc, status: doc ? 'read' : 'failed', at: Date.now() });
        const sig = `${g.status}\n${doc ? JSON.stringify(doc) : ''}`;
        if (sig !== g.sig) { g.sig = sig; accessChanged(); }
      });
    }
    return g;
  }
  /* Wait for a read under way (the raw facts-file page decides once, when it is drawn). */
  async function accessSettled() {
    const g = accessGateNow();
    if (g.pending) await g.pending;
  }
  /* What you may do on project `projectId` now -> HCCore.accessFor's answer plus status 'read' | 'unread' | 'failed'
     (not read yet, or the read failed: can is false, and text says which). */
  function projectAccess(projectId) {
    const login = sessionLogin();
    const wide = C.accessFor(null, projectId, login, state.role);
    if (wide.can) return Object.assign({ status: 'read' }, wide);          // Admin or Maintainer: no list needed
    const g = accessGateNow();
    if (g.status !== 'read') {
      return Object.assign({}, wide, { can: false, why: g.status, status: g.status,
        text: g.status === 'failed' ? C.ACCESS_UNREAD_TEXT : C.ACCESS_READING_TEXT });
    }
    return Object.assign({ status: 'read' }, C.accessFor(g.doc, projectId, login, state.role));
  }
  // a draft or page key that belongs to one project: its page (project/<id>) or its facts file (data/projects/<id>)
  const PROJECT_KEY_RE = /^(?:project|data\/projects)\/([a-z0-9][a-z0-9-]{0,80})$/;
  const projectOfKey = (key) => { const m = PROJECT_KEY_RE.exec(String(key || '')); return m ? m[1] : null; };
  /* May I change what `key` names (a page id or a draft key)? The role rule, and on a project its access list. */
  function canEditKey(key) {
    if (!canEdit()) return false;
    const id = projectOfKey(key);
    return !id || projectAccess(id).can;
  }
  const canEditPage = (page) => canEditKey(page && page.pageId);
  // a project page you may not edit (any role): nothing on it is selected, inserted, opened or sent
  const pageLocked = (page) => Boolean(projectIdOf(page)) && !canEditPage(page);
  /* The access answer changed: draw again what depends on it. */
  function accessChanged() {
    if (ed.on && pageLocked(ed.page) && (ed.sel || ed.selected !== null)) clearSelection();
    refreshDock();
    if (dock && state.session) D.loadCount();        // a Writer's review count follows the list
    if (ed.on) postEditor();
  }

  // ------------------------------------------------------------ the editor ---
  /* U7b, trimmed by U0b (plan D18): the thin editor page stays for two things only. #/edit/<page> is the
     whole page as Markdown ("Edit whole page as Markdown" in the account menu, and a page or block the page
     itself cannot edit), and #/edit/data/<registry> or #/edit/data/projects/<id> a raw data file; #/edit alone
     lists those data files (the account menu's "Data files"). The editor: the file's text at the head of main
     (or of my own open proposal), snippet buttons, and the live preview — the page frame, served the draft
     from memory, reloaded with a fresh nonce a moment after each change. A draft lives in memory and in this browser's
     localStorage (U4b: it survives a closed tab), one store per login
     (HCCore.draftsKey), keyed by page, with its base sha; leaving a page whose
     draft is not proposed asks first; Sign out deletes the login's drafts
     (asked first when some are not proposed). Read-only people get the same
     page, view-only, with the github.com pencil link. */

  let draftBound = { key: null, store: C.createDraftStore(null) };
  let legacyOwner = null;       // the login whose session this tab restored at load (start): owner of older tab drafts
  /* The signed-in login's store, bound (again) whenever the login changes. A tab's older sessionStorage
     drafts (before U4b) move into it once. */
  function draftStore() {
    const login = state.session && typeof state.session.login === 'string' ? state.session.login : null;
    const key = login ? C.draftsKey(login) : null;
    if (draftBound.key !== key) {
      const st = key ? C.createDraftStore(localStore(), key) : C.createDraftStore(null);
      // a tab's older sessionStorage drafts (before U4b) carry no login: they move in only for the person whose
      // session this tab restored at load (theirs, then); after a different sign-in they are dropped, never
      // handed to the next person. The old copy goes only once every draft was written.
      if (key) {
        const old = C.createDraftStore(store());
        if (old.list().length) {
          const own = legacyOwner && legacyOwner.toLowerCase() === login.toLowerCase();
          const moved = own ? old.list().every((d) => Boolean(st.get(d.key)) || st.put(d)) : true;
          if (moved) { try { const ss = store(); if (ss) ss.removeItem(C.DRAFTS_KEY); } catch (e) { /* kept where it was */ } }
        }
      }
      draftBound = { key, store: st };
    }
    return draftBound.store;
  }
  const drafts = Object.freeze({
    get: (k) => draftStore().get(k),
    // round 2 (R2b): every change to the page's draft passes the undo history (histNote); a draft removed for any
    // other reason (sent for review, discarded) ends its history
    put: (d) => { histNote(d); return draftStore().put(d); },
    remove: (k) => { histRemoved(k); return draftStore().remove(k); },
    list: () => draftStore().list(), dirty: () => draftStore().dirty(), sync: (keep) => draftStore().sync(keep),
    clear: () => draftStore().clear(),
  });
  let editing = null;            // {key, hash}: the edit page on screen, for the leave question
  let previewTimer = null;
  const PREVIEW_DELAY_MS = 600;
  const MAIN_BASE = Object.freeze({ ref: 'main', number: null });
  const chosenBase = new Map();  // page key -> {number}: my proposal picked as the base, not yet changed
  let proposing = false;         // one proposal at a time

  const canEdit = () => Boolean(state.role && state.role.canPush === true);

  /* Leaving an edit page whose draft is not proposed: ask; on "cancel" the
     tray stays on it (route() puts trayHash back). */
  function leaveOk() {
    const d = drafts.get(editing.key);
    return !d || !C.isDirty(d) || window.confirm(C.LEAVE_TEXT);
  }

  /* The commit a branch of this repository points at. */
  async function headOf(ref) {
    const data = await api(`${C.REPO_API_PATH}/git/ref/heads/${ref}`);
    const sha = data && data.object && data.object.sha;
    if (!/^[0-9a-f]{40}$/.test(String(sha))) throw new Error(`GitHub did not say where ${ref} is`);
    return sha;
  }

  /* A new draft: each file's text at the head of `target.ref` (null = the
     file does not exist there yet). */
  async function loadDraft(key, meta, files, target) {
    const sha = await headOf(target.ref);
    const originals = {};
    for (const p of files) {
      const res = await apiResponse(C.contentsPath(p, sha), { accept: C.RAW_MEDIA, raw: true });
      if (res.status === 404) originals[p] = null;
      else if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} for ${p}`);
      else originals[p] = res.data;
    }
    const current = {};
    for (const p of files) current[p] = originals[p] === null ? '' : originals[p];
    return { key, label: meta.label, route: meta.route, files: current, originals,
      base: { ref: target.ref, sha, number: target.number } };
  }

  const sameBase = (a, b) => a.base.ref === b.base.ref;

  const DATA_HASH = '#/edit';
  const backToData = () => h('p', { class: 'hc-back' }, link(DATA_HASH, '← Data files'));

  function cannotEdit(epoch, pageId) {
    paint(epoch, [backToData(), h('h1', { text: 'Not editable here' }),
      h('p', null, `The editor has no page "${pageId}". `, link(DATA_HASH, 'Back to the data files'),
        ', or ', link(`${C.GITHUB_WEB}/tree/main`, 'edit the repository on github.com'), '.')]);
  }

  /* #/edit: the raw data files (the account menu's "Data files", U0b): the registries, then each project's
     own facts file (2026-10-14: its editors, data/graph/edit-access.json, edit and approve these; the index
     stays admin-owned). The list the old Changes tab held. */
  async function viewDataFiles(r, epoch) {
    const regs = await registries();
    const projectFacts = (regs && regs.projects && Array.isArray(regs.projects.projects) ? regs.projects.projects : [])
      .filter((x) => x && typeof x.id === 'string' && C.PROJECT_ID_RE.test(x.id))
      .map((x) => ({ id: x.id, name: typeof x.name === 'string' && x.name.trim() ? x.name.trim() : x.id }));
    paint(epoch, [
      h('h2', { text: 'Registries (raw JSON)' }),
      h('ul', { class: 'hc-links' }, ...C.RAW_REGISTRIES.map((f) => h('li', null, link(`${DATA_HASH}/${f.slice(0, -5)}`, f)))),
      projectFacts.length ? h('h2', { text: 'Project facts (each project\'s own file)' }) : null,
      projectFacts.length ? h('ul', { class: 'hc-links' }, ...projectFacts.map((x) => h('li', null,
        link(`${DATA_HASH}/data/projects/${x.id}`, `${x.name} — ${C.projectFactsFile(x.id)}`)))) : null,
      h('p', null, link(`${C.GITHUB_WEB}/tree/main/data`, 'Data files on GitHub')),
    ]);
  }

  async function viewEdit(r, epoch) {
    const pageId = r.params.pageId;
    if (pageId === undefined) { await viewDataFiles(r, epoch); return; }
    const kind = C.editKind(pageId);
    const regs = await registries();
    const file = kind ? C.editPath(pageId, regs) : null;
    const route = kind ? C.routeForPage(pageId, regs) : null;
    if (!file || !route) { cannotEdit(epoch, pageId); return; }
    const meta = { label: kind === 'registry' ? file
      : (C.pageList(regs).find((pg) => pg.pageId === pageId) || {}).title || pageId, route };
    paint(epoch, [h('h1', { text: `Edit: ${meta.label}` }), h('p', { class: 'cms-muted', text: 'Loading the page…' })]);
    // the edit gate: a project's facts file follows that project's access list (read first, fails closed)
    const projectId = projectOfKey(pageId);
    if (projectId && canEdit()) await accessSettled();
    const editable = canEditKey(pageId);
    // the whole page as Markdown edits the SAME draft the page on screen edits in place (its undo history too)
    const onScreen = kind === 'page' && ed.draft && ed.draft.key === pageId ? ed.draft : null;
    let d = editable ? onScreen || drafts.get(pageId) : null;
    // an unchanged draft is not kept: the page opens at the base's newest head
    if (d && !C.isDirty(d) && d !== onScreen) { drafts.remove(pageId); d = null; }
    const own = editable ? await myProposals() : [];
    if (!d) d = await loadDraft(pageId, meta, [file], baseFor(pageId, own));
    if (d.originals[file] === null) throw new Error(`${file} is not on ${d.base.ref}`);
    if (kind === 'page' && editable && ed.page && ed.page.pageId === pageId) ed.draft = d;
    const nodes = editorPage(d, file, kind, editable, epoch, own);
    if (projectId && canEdit() && !editable) {
      const name = (C.pageList(regs).find((pg) => pg.pageId === `project/${projectId}`) || {}).title || projectId;
      nodes.splice(nodes.findIndex((n) => n && n.tagName === 'H1') + 1, 0, accessLockNote(projectAccess(projectId), projectId, name));
    }
    if (!paint(epoch, nodes)) return;
    editing = { key: pageId, hash: trayHash };
  }

  /* My open proposals I may add to (HCCore.ownProposals); [] when GitHub
     does not answer — then every change starts a new proposal. */
  async function myProposals() {
    const res = await apiResponse(`${C.REPO_API_PATH}/pulls?state=open&per_page=100`);
    return res.ok ? C.ownProposals(res.data, state.session.login) : [];
  }

  /* The base a page without a draft opens at: my proposal when I picked
     one that is still open, else main. */
  function baseFor(key, own) {
    const pick = chosenBase.get(key);
    const hit = pick && own.find((p) => p.number === pick.number);
    return hit ? { ref: hit.branch, number: hit.number } : MAIN_BASE;
  }

  /* The editor's DOM for draft d; wires input, snippets, validation, the
     base picker, Propose and the preview. Returns the nodes for paint(). */
  function editorPage(d, file, kind, editable, epoch, own) {
    const ta = h('textarea', { class: 'cms-editor-text', 'data-editor': '', rows: 24, spellcheck: 'true',
      'aria-label': `Text of ${file}` });
    ta.value = d.files[file];
    ta.readOnly = !editable;
    const problem = h('p', { class: 'cms-problem', 'data-problem': '', role: 'alert', hidden: true });
    const stateLine = h('p', { class: 'cms-draft-state cms-muted', role: 'status' });
    const proposeBtn = editable ? h('button', { type: 'button', class: 'cms-btn cms-btn-primary', 'data-action': 'propose' },
      'Send for review') : null;
    const discardBtn = editable ? h('button', { type: 'button', class: 'cms-btn', 'data-action': 'discard' },
      'Discard changes') : null;
    let bad = null;

    function check() {
      bad = kind === 'registry' ? C.registryDraftProblem(file, d.originals[file], ta.value) : null;
      problem.textContent = bad ? bad.message : '';
      problem.hidden = !bad;
      const dirty = C.isDirty(d);
      stateLine.textContent = !editable ? 'View only.'
        : (dirty ? 'Changed — kept as a draft in this browser, not proposed yet.' : 'No changes yet.');
      if (proposeBtn) proposeBtn.disabled = Boolean(bad) || !dirty;
    }

    // the page frame is the preview: it serves my changed drafts on main from memory
    function schedulePreview() {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => {
        if (epoch !== routeEpoch || bad) return;   // a broken registry is not previewed
        frameTo(ed.route, true);
      }, PREVIEW_DELAY_MS);
    }

    function changed() {
      d.files[file] = ta.value;
      if (C.isDirty(d)) drafts.put(d); else drafts.remove(d.key);
      check();
      schedulePreview();
    }
    ta.addEventListener('input', changed);

    function replaceText(next, selStart, selEnd) {
      ta.value = next;
      ta.focus();
      ta.setSelectionRange(selStart, selEnd);
      changed();
    }

    const tools = editable && kind === 'page' ? snippetBar(ta, replaceText) : null;
    if (discardBtn) {
      discardBtn.addEventListener('click', () => {
        if (C.isDirty(d) && !window.confirm(C.DISCARD_TEXT)) return;
        drafts.remove(d.key);
        editing = null;
        if (ed.draft === d) { clearSelection(); frameTo(ed.route, false); }   // the page on screen drops it too
        route();
      });
    }
    const slot = h('p', { class: 'cms-action-result', role: 'status', hidden: true });
    if (proposeBtn) proposeBtn.addEventListener('click', () => { sendAll(null, { go: proposeBtn, result: slot }).catch(shown); });
    check();
    const isNew = d.originals[file] === null;

    const ids = kind === 'registry' ? C.lockedIds(file, safeParse(d.originals[file])) : [];
    const nodes = [
      kind === 'registry' ? backToData() : null,
      h('h1', { text: d.key.indexOf('new/') === 0 ? d.label : `Edit: ${d.label}` }),
      isNew ? h('p', { class: 'cms-meta' }, h('code', { text: file }), ' · a new file')
        : h('p', { class: 'cms-meta' }, h('code', { text: file }), ' · ', link(C.pencilUrl(file), 'edit on github.com instead')),
      editable && own.length && d.key.indexOf('new/') !== 0 ? basePicker(d, own) : null,
      d.base.number ? h('p', { class: 'cms-muted', text: `Building on your proposal #${d.base.number}.` }) : null,
      !editable && !canEdit() ? h('p', { class: 'cms-muted' }, 'View only: changing pages needs write access to this site\'s '
        + 'repository. You can still ', link(C.pencilUrl(file), 'propose a change on github.com'), '.') : null,
      kind === 'registry' ? h('p', { class: 'cms-locked', 'data-locked': '' }, ids.length
        ? `Locked ids (${ids.length}): ${ids.join(', ')} — ${C.ID_RULE_TEXT}.`
        : 'This registry has no ids.') : null,
      tools, ta, problem, stateLine,
      editable ? h('div', { class: 'cms-action-row' }, proposeBtn, discardBtn) : null,
      slot,
      h('p', { class: 'cms-muted', text: 'The page shows your draft a moment after each change.' }),
    ];
    // the page on screen becomes the draft's page (the frame follows the site's hash)
    Promise.resolve().then(() => {
      if (epoch === routeEpoch && d.route && ROUTE_RE.test(d.route) && currentRoute() !== d.route) {
        window.location.hash = `#${d.route}`;
      }
    });
    return nodes;
  }

  function safeParse(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  /* Note box, warning, tabs and an internal link picked from the page tree, at the cursor of the text. (U0b: the
     "Image from Media" chooser went with the image library; an image is added with "+" Image in the page.) */
  function snippetBar(ta, replaceText) {
    const btn = (kind, label) => h('button', { type: 'button', class: 'cms-btn', 'data-snippet': kind }, label);
    const kinds = Object.keys(C.SNIPPET_CATALOG).filter((k) => !C.SNIPPET_CATALOG[k].media);
    const buttons = kinds.map((k) => btn(k, C.SNIPPET_CATALOG[k].label));
    buttons.forEach((b) => b.addEventListener('click', () => {
      const out = C.insertSnippet(ta.value, ta.selectionStart, ta.selectionEnd, b.getAttribute('data-snippet'));
      replaceText(out.text, out.selStart, out.selEnd);
    }));
    const pages = C.pageList(state.regs);
    const picker = h('select', { class: 'cms-link-picker', 'data-link-picker': '', 'aria-label': 'Page to link to' },
      ...pages.map((pg) => h('option', { value: pg.pageId }, pg.title)));
    if (pages.length) picker.value = pages[0].pageId;
    const linkBtn = h('button', { type: 'button', class: 'cms-btn', 'data-action': 'insert-link' }, 'Insert link');
    linkBtn.addEventListener('click', () => {
      const pg = pages.find((x) => x.pageId === picker.value);
      if (!pg) return;
      const a = ta.selectionStart;
      const b = ta.selectionEnd;
      const md = C.linkMarkdown(pg, ta.value.slice(a, b));
      replaceText(ta.value.slice(0, a) + md + ta.value.slice(b), a + md.length, a + md.length);
    });
    return h('div', null, h('div', { class: 'cms-snippets', role: 'toolbar', 'aria-label': 'Insert' },
      ...buttons, picker, linkBtn));
  }

  /* "Start from": the live site (a new proposal) or one of my open
     proposals (one more commit on its branch). Switching reloads the page's
     text from that head; changes not proposed are thrown away first, after
     asking. */
  function basePicker(d, own) {
    const sel = h('select', { class: 'cms-base-picker', 'data-base': '', 'aria-label': 'Start from' },
      h('option', { value: '' }, 'the live site (a new proposal)'),
      ...own.map((p) => h('option', { value: String(p.number) }, `your proposal #${p.number}: ${p.title}`)));
    const current = d.base.number ? String(d.base.number) : '';
    sel.value = current;
    sel.addEventListener('change', () => {
      if (C.isDirty(d) && !window.confirm(C.DISCARD_TEXT)) { sel.value = current; return; }
      const hit = own.find((p) => String(p.number) === sel.value);
      drafts.remove(d.key);
      if (hit) chosenBase.set(d.key, { number: hit.number }); else chosenBase.delete(d.key);
      if (ed.draft && ed.draft.key === d.key) clearSelection();   // the page on screen lets go of the old base too
      editing = null;
      route();
    });
    return h('p', { class: 'cms-base' }, h('label', null, 'Start from: ', sel));
  }

  /* (U2: the one-click send is sendAll, beside the dock's view above; sendDraft and sendProposal are gone.) */



  /* ---- kept for the units that rebuild the New project and New person flows in place (U0b) ----
     The #/new/project and #/new/person forms are gone; what they knew stays here as named helpers
     (HCEditor.helpers): U6's "+ New project" dialog and U5's "+ New person" build on them. */

  /* The New project form: its fields in order (the keys HCCore.newProjectDraft reads), the statuses a project may
     have, and the values a blank form starts with. Pure. */
  function newProjectForm() {
    return Object.freeze({
      fields: Object.freeze(['id', 'name', 'status', 'tagline', 'repos', 'story']),
      statuses: Object.freeze(C.PROJECT_STATUSES.slice()),
      defaults: Object.freeze({ id: '', name: '', status: 'active', tagline: '', repos: '', story: '## What it is\n\n' }),
    });
  }

  /* The New person form over data/people.json's text: the lists a person may join (HCCore.personGroups), the
     fields in order (the photo must be an image of the site's list, check.py 6c: picked, never typed; photo and
     link are optional) and the list a blank form starts in. Pure. */
  function personFields(peopleText) {
    const groups = C.personGroups(peopleText);
    return Object.freeze({
      groups,
      fields: Object.freeze(['group', 'name', 'title', 'photo', 'link']),
      defaultGroup: groups.length ? groups[0].id : null,
    });
  }

  /* The projects (index + each facts file) at a commit: the draft's base, so a repository a project on my
     proposal already holds is refused here, not only by the gate. null when the index does not parse. */
  async function projectsAt(sha, indexText) {
    let index;
    try { index = JSON.parse(indexText); } catch (e) { return null; }
    if (!index || !Array.isArray(index.projects)) return null;
    const facts = await Promise.all(index.projects.map(async (e) => {
      if (!e || typeof e.id !== 'string' || !C.PROJECT_ID_RE.test(e.id)) return null;
      try {
        const res = await apiResponse(C.contentsPath(C.projectFactsFile(e.id), sha), { accept: C.RAW_MEDIA, raw: true });
        return res.ok ? JSON.parse(res.data) : null;
      } catch (x) { return null; }
    }));
    return C.mergeProjects(index, facts);
  }

  /* A new project's draft from the form's values (newProjectForm's fields) on `base` ({ref, number}: main, or my
     open proposal's branch): one draft, key new/project, of three files — data/projects.json with the new entry,
     the facts file data/projects/<id>.json and content/projects/<id>.md (HCCore.newProjectDraft). A repository
     another project already holds at that base, a bad field or an id whose files exist is refused in words.
     Nothing is stored or sent. -> {d} | {problem} */
  async function makeProjectDraft(form, base) {
    const id = String((form && form.id) || '').trim();
    const target = base && base.number ? { ref: base.ref, number: base.number } : MAIN_BASE;
    const files = ['data/projects.json'].concat(C.PROJECT_ID_RE.test(id) ? [C.projectFactsFile(id), `content/projects/${id}.md`] : []);
    const d = await loadDraft('new/project', { label: `New project: ${String((form && form.name) || '').trim() || id}`,
      route: `/projects/${id}` }, files, target);
    const out = C.newProjectDraft(form, d.originals['data/projects.json'], await projectsAt(d.base.sha, d.originals['data/projects.json']));
    if (out.problem) return { problem: out.problem };
    for (const f2 of [`content/projects/${out.id}.md`, C.projectFactsFile(out.id)]) {
      if (d.originals[f2] !== null) return { problem: `${f2} already exists on the site — pick another id` };
    }
    d.files = out.files;
    return { d };
  }

  // ------------------------------------------------------------- media ---
  /* U9; the image library (#/media) and its chooser went in U0b (plan D18: an image is replaced or added in the
     page). What stays: the upload path for an image in the page. The token goes to this site's /api/media only
     (HCCore.createMediaClient); an upload goes straight to Cloudinary with the signed parameters
     (HCCore.runUpload). A new image is one entry of the data/cloudinary-manifest.json draft, on the same base as
     the page that uses it, so one send carries both. */

  const MANIFEST_META = Object.freeze({ label: C.MANIFEST_LABEL, route: '/' });
  const whereOf = (base) => (base.number ? `your proposal #${base.number}` : 'the live site');

  /* The live site's image list, as the site serves it (the gateway's guard reads the same). */
  async function liveAssets() {
    return C.manifestAssets(await HC.fetchJSON('data/cloudinary-manifest.json'));
  }

  const openManifestDraft = () => {
    const d = drafts.get(C.MANIFEST_KEY);
    return d && C.isDirty(d) ? d : null;
  };

  /* The image-list draft on `base`: the changed one when it is on the same
     base, else a fresh one at that base's head. -> {d} | {problem} */
  async function manifestDraftOn(base) {
    const open = openManifestDraft();
    if (open) {
      if (open.base.ref === base.ref) return { d: open };
      return { problem: `Your image-list draft builds on ${whereOf(open.base)}, and this page on ${whereOf(base)}. `
        + 'Send or discard one of them first (the account menu\'s Data files opens the image-list draft, which can be discarded there).' };
    }
    return { d: await loadDraft(C.MANIFEST_KEY, MANIFEST_META, [C.MANIFEST_FILE], { ref: base.ref, number: base.number }) };
  }


  const mediaClient = () => C.createMediaClient({ fetch: netFetch, token: state.session.token });
  // the one signed upload path (the Media panel and an image replaced in the page): sign, Cloudinary, manifest entry
  const uploadImage = (file, subfolder, live, draftText) => C.runUpload({ media: mediaClient(), fetch: netFetch,
    FormData: window.FormData, subtle: window.crypto.subtle }, { file, subfolder, live, draftText });

  /* A gateway answer for this session: dropped when the session changed
     meanwhile; a 401 ends the session. */
  function checked(gen, out) {
    if (!sessionGen.isCurrent(gen)) throw new Error(STALE);
    if (out.status === 401) {
      endSession('Your sign-in has ended. Please sign in again.');
      throw new Error('signed out');
    }
    return out;
  }
  const quiet = (e) => Boolean(e) && (e.message === 'signed out' || e.message === STALE);



  /* The images a picker offers, from the base's list (`all`: the manifest at the base's head, or my image-list draft on it) and the live site's (`live`): every one with
     a url, in order, each with its public id, whether the live site has it, and its label ("<id> (new: not on the
     live site yet)" when only my draft or my proposal has it). The pure list the old image chooser drew (U0b):
     U4's "Pick one the site has" builds on it. */
  function mediaAssets(all, live) {
    const onSite = new Set((Array.isArray(live) ? live : []).map((a) => a && a.public_id));
    return (Array.isArray(all) ? all : []).filter((a) => a && typeof a.url === 'string').map((a) => {
      const site = onSite.has(a.public_id);
      return Object.freeze({ url: a.url, public_id: a.public_id, onSite: site,
        label: site ? String(a.public_id) : `${a.public_id} (new: not on the live site yet)` });
    });
  }

  function viewNotFound(r, epoch) {
    paint(epoch, [h('h1', { text: 'Not found' }),
      h('p', null, 'The editor has no page here. ', link(DATA_HASH, 'Go to the data files'), '.')]);
  }

  /* View settings are fixed (U0b, plan D18: the View tab and its localStorage key hc-editor-view are gone):
     HCCore.viewSettings is the constants {suggestions: true, diff: 'inline', compact: false, outlines: true}. U3
     decides whose suggestions are drawn (only approvers see others'); until then they are drawn as before. */
  const currentView = () => C.viewSettings;

  const VIEWS = {
    edit: viewEdit,
    'not-found': viewNotFound,
  };
  const NEEDS_SIGN_IN = new Set(['edit']);

  // ---------------------------------------------------- the tray's router ---
  /* The thin editor page routes on trayHash — its own "#/…" in HCCore.parseRoute's grammar, never the site's
     hash, which is the page on screen. A link on it whose href starts "#/" moves it (onTrayClick). It draws only
     while Editor mode is on and the page is open, so nothing is read from GitHub for a page nobody sees.

     REDIRECTS (U0b, plan D18): the addresses of the removed screens. Each lands on the page on screen with the
     bubble out; #/review/<n> also keeps that proposal drawn on the page (ed.focusPr = n). They are "open the page
     + bubble" for now: U3 changes only the targets (the bubble's review list, the proposal's first page). A
     site address's ?editor=… is read the same way (takeEditorParam, onHashChange, start). */
  const REDIRECTS = Object.freeze([
    { name: 'review-pr', re: /^\/review\/([1-9][0-9]{0,8})\/?$/, to: 'page', focus: true },   // the review page
    { name: 'home', re: /^\/?(?:review\/?)?$/, to: 'page' },                            // #/, #/review: the proposals list
    { name: 'help', re: /^\/(?:help|private)\/?$/, to: 'page' },                         // the Guide
    { name: 'view', re: /^\/view\/?$/, to: 'page' },                                     // View settings
    { name: 'media', re: /^\/media\/?$/, to: 'page' },                                   // the image library
    { name: 'pages', re: /^\/pages\/?$/, to: 'page' },                                   // the page list (the old Changes tab)
    { name: 'new', re: /^\/new\/[a-z][a-z-]*\/?$/, to: 'page' },                          // New project / New person
  ].map((r) => Object.freeze(r)));

  /* The redirect an editor address names -> {name, to, focusPr} | null (an address that is not retired). */
  function redirectOf(hash) {
    let x = typeof hash === 'string' ? hash : '';
    if (x.charAt(0) === '#') x = x.slice(1);
    x = x.split('?')[0];
    for (const r of REDIRECTS) {
      const m = r.re.exec(x);
      if (m) return Object.freeze({ name: r.name, to: r.to, focusPr: r.focus ? Number(m[1]) : null });
    }
    return null;
  }

  /* Follow a redirect: the editor page steps aside, the bubble comes out, and a proposal named by number is drawn
     on the page on screen (the frame is drawn again when that changes what it shows). */
  function followRedirect(r) {
    ed.trayOpen = false;
    applyTray();
    D.unfold();
    if (r.focusPr !== null && r.focusPr !== ed.focusPr) {
      ed.focusPr = r.focusPr;
      // already the proposal drawn on the page: nothing to draw again
      const drawn = Boolean(ed.pv && ed.pv.pr && ed.pv.pr.number === r.focusPr);
      if (ed.on && !drawn) {
        ed.show = null;
        clearSelection();
        frameTo(currentRoute(), false);
        return;
      }
    }
    refreshDock();
  }

  function trayGo(hash) {
    const r = redirectOf(hash);
    if (r) { followRedirect(r); return; }
    trayHash = hash;
    saveEditorState();
    drawTitle();
    route();
  }

  async function route() {
    if (!tray || !ed.on || !ed.trayOpen) return;
    if (editing && trayHash !== editing.hash && !leaveOk()) {
      // "stay": the edit page stays on screen
      trayHash = editing.hash;
      drawTitle();
      return;
    }
    editing = null;
    clearTimeout(previewTimer);
    routeEpoch += 1;
    const epoch = routeEpoch;
    clearPreviews();
    const r = C.parseRoute(trayHash);
    if (state.access === 'no-access') {
      paint(epoch, h('p', { class: 'cms-no-access', text: C.NO_ACCESS_TEXT }));
      return;
    }
    if (NEEDS_SIGN_IN.has(r.name)) {
      if (!state.session) { paint(epoch, signInPanel()); return; }
      if (state.access === 'checking') {
        paint(epoch, h('p', { class: 'cms-muted', text: 'Checking your access…' }));
        return;
      }
      if (state.access === 'error') {
        paint(epoch, [h('h1', { text: 'Editor' }), h('div', { class: 'error-panel' },
          h('p', { text: `Could not check your access: ${state.accessError}.` }),
          h('p', { text: 'Reload the page to try again.' }))]);
        return;
      }
    }
    try {
      await VIEWS[r.name](r, epoch);
    } catch (e) {
      if (e && (e.message === 'signed out' || e.message === STALE)) return;
      paint(epoch, h('div', { class: 'error-panel' },
        h('p', { text: `Something went wrong: ${(e && e.message) || e}` })));
    }
  }

  function onTrayClick(e) {
    const t = e && e.target;
    const a = t && typeof t.closest === 'function' ? t.closest('a[href^="#/"]') : null;
    if (!a) return;
    e.preventDefault();
    trayGo(a.getAttribute('href'));
  }
  // ----------------------------------------------------- the preview host ---

  /* The parent side of the preview bridge (js/source.js's protocol; the logic
     is HCCore.createPreviewHost). Puts the real site in a sandboxed frame —
     scripts and popups allowed, NOT same-origin, so it can reach nothing of
     this page — and answers its file requests through `fetcher`. */
  function mountPreview(container, opts) {
    const o = opts || {};
    if (typeof o.fetcher !== 'function') throw new Error('mountPreview: a fetcher is required');
    const frame = h('iframe', {
      class: 'cms-preview-frame',
      title: 'Preview of the site',
      sandbox: 'allow-scripts allow-popups',
      referrerpolicy: 'no-referrer',
    });
    container.appendChild(frame);
    const host = C.createPreviewHost({
      getFrameWindow: () => frame.contentWindow,
      setFrameSrc: (url) => { frame.src = url; },
      getRandomValues: randomValues,
      getTheme: siteTheme,
      base: 'index.html',
    });
    const entry = { host, frame };
    state.previews.add(entry);
    host.load(o.route, o.fetcher);
    return Object.freeze({
      frame,
      load: (route2, fetcher) => host.load(route2, fetcher || o.fetcher),
      destroy() { host.dispose(); state.previews.delete(entry); frame.remove(); },
    });
  }

  function clearPreviews() {
    for (const entry of state.previews) { entry.host.dispose(); entry.frame.remove(); }
    state.previews.clear();
  }

  // --------------------------------------------------------- Editor mode ---
  /* Plan D-D, D-G, D-H. Editor on: the site's content cell becomes the
     sandboxed frame at the current route (#hc-frame-host), the tray opens,
     and the frame shows (1) my draft of this page when I have one, else (2)
     main (U7 overlays the open proposals). The frame is told what to draw
     with hc-editor after its hc-ready; it posts back hc-route,
     hc-block-select and hc-block-insert. A message is acted on only when its
     source is THIS frame's window and its nonce is the current load's. */

  const EDITOR_KEY = 'hc-editor';
  // the editor page (U0b: only the thin one, #/edit…, is left; the Proposals, View, Guide and Media screens are gone)
  const PHONE_QUERY = '(max-width: 767px)';
  const EDITOR_PARAMS = Object.freeze(['editor', 'pr', 'data', 'new']);
  const ROUTE_RE = /^\/(?!\/)[^\x00-\x1f\x7f]{0,500}$/;
  const MAX_INDEX = 100000;
  const MAX_BLOCK_MD = 200000;          // js/source.js MAX_BLOCK_MD: the longest block the frame may send back
  const OPEN_KINDS = Object.freeze(['paragraph', 'heading', 'list', 'code', 'wrapper', 'image', 'table', 'html']);
  const ed = {
    on: false,
    trayOpen: false,      // the thin editor page is open over the frame
    count: null,          // open proposals, once read
    show: null,           // {number, sha, changed: Map file -> 'changed'|'removed'}: "Show on page"
    frame: null,          // the iframe in #hc-frame-host
    host: null,           // HCCore.createPreviewHost for it
    prefix: null,         // this load's sentinel prefix: the first 16 characters of its nonce
    loads: 0,             // bumped per frame load; an older load's await is dropped
    ready: false,         // the current load said hc-ready: only then is hc-editor posted to it
    route: '/',           // the route the frame shows
    page: null,           // {pageId, file, label, route} of that route, or null
    fromFrame: null,      // the route of an hc-route whose hashchange is the frame's own
    draft: null,          // the draft of ed.page (in the draft store once it changed)
    sel: null,            // {key, file, span, whole}: the text the tray's textarea edits
    selected: null,       // the block index the frame shows selected
    inPage: null,         // {index, editor}: the frame said that block is typed in the page (U2), else null
    asMarkdown: null,     // the block index the person chose to edit in the in-place Markdown box (U3)
    inPageReason: '',     // why the frame said the selected block must be edited as Markdown
    wholeReason: null,    // why block editing is off for this page, or null
    mainSha: null,        // Promise of main's head sha, once per refresh
    cache: null,          // HCCore.cachedFetcher over this session's token
    pv: null,             // what this load shows (pageView): mode, the proposal, its overlay and marks
    baseNote: null,       // {key, number}: that page's stored draft names a proposal not my own open one
    props: null,          // Promise of the open proposals with their files, once per refresh
    bases: new Map(),     // 'main...head' -> Promise of the merge base sha
    checks: new Map(),    // head sha -> Promise of HCCore.checkStatus
    focusPr: null,        // round 2 (R3): the proposal opened from the list, drawn on its page instead of the newest
  };
  let frameTimer = null;
  let liveTimer = null;     // U7: the frame takes the page's place after LIVE_FALLBACK_MS even without its paint signal

  function readEditorState() {
    const s = store();
    try {
      const v = s ? JSON.parse(s.getItem(EDITOR_KEY)) : null;
      if (!v || typeof v !== 'object') return null;
      const hash = typeof v.hash === 'string' && C.parseRoute(v.hash).name === 'edit' ? v.hash : null;
      return { on: v.on === true, tray: v.tray === true && hash !== null, hash };
    } catch (e) {
      return null;
    }
  }

  function saveEditorState() {
    const s = store();
    try {
      if (s) s.setItem(EDITOR_KEY, JSON.stringify({ on: ed.on, tray: ed.trayOpen, hash: trayHash }));
    } catch (e) { /* kept in memory for this page */ }
  }

  function currentRoute() {
    const r = String(window.location.hash || '').replace(/^#/, '');
    return ROUTE_RE.test(r) ? r : '/';
  }

  /* js/app.js's page ids (its editPageId): setup/<id>, project/<id>,
     tool/<id>, about. */
  function pageIdForRoute(route) {
    const seg = String(route).split('@')[0].split('?')[0].split('/').filter(Boolean);
    if (seg[0] === 'setup') return seg.length === 1 ? 'setup/start/index' : `setup/${seg.slice(1).join('/')}`;
    if (seg[0] === 'projects' && seg.length === 2) return `project/${seg[1]}`;
    if (seg[0] === 'tools' && seg.length === 2) return `tool/${seg[1]}`;
    // round 2 (R5): the Team page is edited as data — data/people.json, in place (drag, card menu, "+")
    if ((seg[0] === 'team' || seg[0] === 'about') && seg.length === 1) return PEOPLE_PAGE;
    return null;
  }
  const PEOPLE_PAGE = 'data/people';
  const PEOPLE_FILE = 'data/people.json';

  function pageForRoute(route) {
    const pageId = pageIdForRoute(route);
    if (pageId === PEOPLE_PAGE) return { pageId, file: PEOPLE_FILE, label: 'Team', route: '/team', data: true };
    const file = pageId && state.regs ? C.editPath(pageId, state.regs) : null;
    if (!file) return null;
    const hit = C.pageList(state.regs).find((p) => p.pageId === pageId);
    return { pageId, file, label: hit ? hit.title : pageId,
      route: C.routeForPage(pageId, state.regs) || String(route).split('@')[0] };
  }
  const samePage = (a, b) => Boolean(a && b && a.pageId === b.pageId);

  /* #/<route>?editor=<anything>[&pr=<n>|&data=<x>|&new=<kind>] (D-H, D-I): read, then stripped from the address
     with history.replaceState (no hashchange). U0b: every one is a redirect to the page on screen (Editor mode on,
     the bubble out); pr=<n> keeps that proposal drawn (as #/review/<n>), and data=<registry> still opens that raw
     data file on the thin editor page, which stays. -> {pr, data} | null */
  function takeEditorParam() {
    const hash = String(window.location.hash || '');
    const q = hash.indexOf('?');
    if (q < 0) return null;
    const pairs = hash.slice(q + 1).split('&').filter(Boolean);
    const keyOf = (p) => p.split('=')[0];
    const get = (k) => {
      const hit = pairs.find((p) => keyOf(p) === k);
      if (hit === undefined) return null;
      try { return decodeURIComponent(hit.slice(k.length + 1)); } catch (e) { return ''; }
    };
    const tab = get('editor');
    if (tab === null) return null;
    const rest = pairs.filter((p) => EDITOR_PARAMS.indexOf(keyOf(p)) < 0);
    const next = hash.slice(0, q) + (rest.length ? `?${rest.join('&')}` : '');
    try {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${next}`);
    } catch (e) { /* the parameter stays in the address; it is harmless */ }
    const pr = get('pr');
    const data = get('data');
    return { pr: /^[1-9][0-9]{0,8}$/.test(String(pr)) ? Number(pr) : null,
      data: data !== null && C.RAW_REGISTRIES.indexOf(`data/${data}.json`) >= 0 ? data : null };
  }

  /* A site address's ?editor=… (takeEditorParam's answer): its redirect (the page + the bubble, and the proposal
     named by pr=), or the raw data file named by data=. */
  function applyParam(param) {
    if (param.data) {
      trayHash = `${DATA_HASH}/data/${param.data}`;
      ed.trayOpen = true;
      return;
    }
    ed.trayOpen = false;
    if (param.pr !== null) { ed.focusPr = param.pr; ed.show = null; }
  }

  function setEditor(on) {
    if (on && (state.access !== 'ok' || !frameHost)) {
      if (!frameHost) say('This page has no place for the Editor frame.', 'error');
      return;
    }
    ed.on = on;
    if (!on) { ed.show = null; ed.focusPr = null; histReset(null); }
    document.body.classList.toggle('hc-editor-on', on);
    // the title: "HippoCampus Editor" while Editor mode is on (css/site.css slides the word); the reader hears the visible word
    const [robotics, editorWord] = [document.querySelector('.brand-robotics'), document.querySelector('.brand-editor')];
    if (robotics && editorWord) {
      if (on) { robotics.setAttribute('aria-hidden', 'true'); editorWord.removeAttribute('aria-hidden'); }
      else { editorWord.setAttribute('aria-hidden', 'true'); robotics.removeAttribute('aria-hidden'); }
    }
    // U7 (plan D12): the frame host is laid out at once but unseen (css/editor.css: in #content's grid column,
    // out of the flow, transparent, behind) so the frame boots and paints at its final size; #content stays
    // on screen until its first paint (frameReady). Until then the unseen host is inert (review round 2, minor
    // C): no Tab stop and nothing in the accessibility tree; frameLive lifts it. Off, the host is hidden.
    document.body.classList.remove('hc-frame-live');
    if (frameHost) { frameHost.hidden = !on; frameHost.inert = on; }
    clearTimeout(liveTimer);
    if (on) {
      const since = Date.now();
      liveTimer = setTimeout(() => { if (Date.now() - since >= LIVE_FALLBACK_MS) frameLive(); }, LIVE_FALLBACK_MS);
    }
    applyTray();
    renderChrome();
    if (!on) {
      clearTimeout(frameTimer);
      dropFrame();
      clearSelection();
      clearPreviews();
      membersSoon();             // the page under the frame: members-only detail again
      return;
    }
    if (ed.trayOpen) trayGo(trayHash);
    D.loadCount();
    frameTo(currentRoute(), false);
  }

  /* The editor page's open/closed state (the old tray's; it is a full page over the frame now). */
  function applyTray() {
    if (!tray) return;
    const open = ed.on && ed.trayOpen;
    tray.hidden = !open;
    handle.hidden = !ed.on;                                    // the bubble's "Proposals" count (U3 opens its list)
    document.body.classList.toggle('hc-tray-open', open);
    saveEditorState();
  }

  function closeTray() {
    ed.trayOpen = false;
    applyTray();
  }

  /* The thin editor page's heading: "Data files" on its list and on a raw data file, "Edit as Markdown" on a page. */
  function drawTitle() {
    if (!trayTitle) return;
    const r = C.parseRoute(trayHash);
    const kind = r.name === 'edit' && r.params.pageId !== undefined ? C.editKind(r.params.pageId) : null;
    trayTitle.textContent = kind === 'page' ? 'Edit as Markdown' : 'Data files';
  }




  /* "Show on page" (D-G 3): the frame shows proposal n's head — the files
     it changes at its head, every other file at main's — read-only, no
     sentinels. route: where to show it (null: the page on screen). */
  function showProposal(n, sha, files, route2) {
    const changed = new Map();
    for (const f of files) {
      if (!f || typeof f.filename !== 'string') continue;
      changed.set(f.filename, f.status === 'removed' ? 'removed' : 'changed');
      if (typeof f.previous_filename === 'string') changed.set(f.previous_filename, 'removed');
    }
    ed.show = { number: n, sha, changed };
    clearSelection();
    ed.trayOpen = false;                         // the editor page steps aside: the proposal is shown ON the page
    applyTray();
    if (route2 && ROUTE_RE.test(route2) && route2 !== currentRoute()) {
      window.location.hash = `#${route2}`;       // onHashChange loads the frame there
      return;
    }
    frameTo(currentRoute(), false);
  }

  /* Kept for U3, which re-skins the viewing of a proposal ("Viewing <name>'s changes" · Back): U0b removed the
     two bars that called these (plan D18). */
  function showOff() {
    ed.show = null;
    say('');
    frameTo(currentRoute(), false);
  }


  /* While a proposal is shown, nothing on the page is edited. */
  function showing() {
    if (!ed.show) return false;
    say(`You are looking at proposal #${ed.show.number}: nothing on the page is edited meanwhile.`);
    return true;
  }


  /* U7: the width a scroll container's classic scrollbar takes here (0 with overlay scrollbars, or no layout) */
  function scrollbarWidth() {
    try {
      const p = document.createElement('div');
      p.style.cssText = 'position:absolute;top:-200px;left:0;width:100px;height:100px;overflow:scroll;visibility:hidden';
      document.body.appendChild(p);
      const w = p.offsetWidth - p.clientWidth;
      p.remove();
      return Number.isFinite(w) && w > 0 && w < 40 ? w : 0;
    } catch (e) {
      return 0;
    }
  }

  function mountFrame() {
    const frame = h('iframe', { class: 'hc-frame', title: 'This page, in Editor mode',
      sandbox: 'allow-scripts allow-popups', referrerpolicy: 'no-referrer' });
    rail.el = h('aside', { class: 'hc-rail', 'aria-label': 'Suggested changes on this page' });
    rail.el.hidden = true;
    // U7 (plan D12): the host takes #content's slot and the frame is exactly that wide (css/editor.css frame
    // layout); the review rail lies over the right gutter beside it. --hc-sb: the window's classic scrollbar
    // width (0 for overlay scrollbars), so the frame's own scrollbar sits in the page's right padding
    frameHost.replaceChildren(h('div', { class: 'hc-frame-row' }, frame), rail.el);
    if (frameHost.style && typeof frameHost.style.setProperty === 'function') {
      frameHost.style.setProperty('--hc-sb', `${scrollbarWidth()}px`);
    }
    ed.frame = frame;
    ed.host = C.createPreviewHost({
      getFrameWindow: () => frame.contentWindow,
      setFrameSrc: (url) => { frame.src = url; },
      getRandomValues: randomValues,
      getTheme: siteTheme,
      base: 'index.html',
    });
  }

  function dropFrame() {
    railReset();
    if (rail.el) rail.el.remove();
    rail.el = null;
    if (ed.host) ed.host.dispose();
    if (ed.frame) ed.frame.remove();
    ed.frame = null;
    ed.host = null;
    ed.prefix = null;
    ed.ready = false;
    ed.pv = null;
  }

  /* main's head, resolved once per refresh (D-D: files at a sha never
     change, so the cache below may keep them). */
  function mainSha() {
    if (!state.client) return Promise.reject(new Error('signed out'));
    if (!ed.mainSha) {
      const p = C.resolveRef(state.client, 'main');
      ed.mainSha = p;
      p.catch(() => { if (ed.mainSha === p) ed.mainSha = null; });
    }
    return ed.mainSha;
  }

  /* The session's file cache; after a sign-out there is none, and a read
     still in flight ends quietly ('signed out') instead of using the old token. */
  function sessionCache() {
    if (!ed.cache) throw new Error('signed out');
    return ed.cache;
  }

  function clearSelection() {
    ed.sel = null;
    ed.selected = null;
    ed.inPage = null;
    ed.asMarkdown = null;
    ed.inPageReason = '';
    ed.wholeReason = null;
    ed.draft = null;
  }

  /* My changed draft of this page: on the live site, or on a proposal (a
     well-formed number). A draft on a proposal is used only through
     checkedDraft (frameTo), which asks whether that proposal is my own and
     open; Propose checks it again. */
  function storedDraft(page) {
    const d = page ? drafts.get(page.pageId) : null;
    return d && C.isDirty(d) && (d.base.number === null || PR_NO.test(String(d.base.number)))
      && Object.prototype.hasOwnProperty.call(d.files, page.file) ? d : null;
  }
  const PR_NO = /^[1-9][0-9]{0,8}$/;
  const baseNo = (d) => (d ? d.base.number : null);

  /* storedDraft, its base checked against my own open proposals (number and
     branch) before the frame reads anything at its head. Not one of them:
     the page shows the live site and the Changes tab says why. */
  async function checkedDraft(page) {
    const d = storedDraft(page);
    if (!d || d.base.number === null) return d;
    const own = await ownOpen();
    if (own.some((p) => p.number === d.base.number && p.branch === d.base.ref)) return d;
    ed.baseNote = { key: page.pageId, number: d.base.number };
    return null;
  }

  /* Load the frame at `route` with a fresh nonce. keep: the tray keeps the
     picked block when the page stays the same (the reload after an edit). */
  async function frameTo(route, keep) {
    if (!ed.on) return;
    ed.loads += 1;
    const mine = ed.loads;
    const gen = sessionGen.current();
    let sha;
    try {
      [sha] = await Promise.all([mainSha(), registries()]);
    } catch (e) {
      if (mine === ed.loads && sessionGen.isCurrent(gen)) {
        say(`This page could not be opened in Editor mode: ${(e && e.message) || e}.`, 'error');
      }
      return;
    }
    if (mine !== ed.loads || !sessionGen.isCurrent(gen) || !ed.on) return;
    if (!ed.frame) mountFrame();
    const page = pageForRoute(route);
    const moved = !keep || !samePage(page, ed.page);
    if (moved) {
      clearSelection();
      ed.peopleFocus = null;              // R5: "come back to this person" holds for the Team page's own reloads only
    }
    ed.route = route;
    ed.page = page;
    if (!ed.draft) {
      const stored = storedDraft(page);
      ed.draft = stored && stored.base.number === null ? stored : null;
      if (stored && !ed.draft) {
        // a draft on a proposal: mine and open? (until then the frame reads nothing at its head)
        const d = await checkedDraft(page);
        if (mine !== ed.loads || !sessionGen.isCurrent(gen) || !ed.on) return;
        if (!ed.draft && samePage(page, ed.page)) ed.draft = d;
      }
    }
    // R2b: the undo history belongs to this page's draft; another page starts its own
    if (!page || hist.key !== page.pageId) histReset(page);
    else if (ed.draft && ed.draft.key === page.pageId) hist.last = ed.draft.files[page.file];
    // U7 (plan D12): the frame loads AT ONCE, at main's sha with my draft; what the open proposals add (a
    // proposal drawn over the page, its marks, the review cards) arrives when they are read, by a later
    // postEditor. Only the page file itself waits for them when a proposal may be drawn over it (no draft of
    // mine, or a proposal opened or shown): it is then drawn once, with them, and never reloaded for them.
    // The reads are memoized, so a reload after an edit asks nothing.
    ed.pv = blankView(page);
    railReset();
    ed.prefix = null;
    ed.inPage = null;     // the new document reopens the block itself and says so
    ed.ready = false;     // a new document: it hears nothing until its own hc-ready
    ed.readies = 0;
    let viewIn = null;
    ed.pvWait = !ed.draft || ed.focusPr !== null || ed.show ? new Promise((r) => { viewIn = r; }) : null;
    const waited = ed.pvWait;
    const nonce = ed.host.load(route, frameFetcher);
    // frameFetcher reads it at call time: the frame asks only after it loaded
    ed.prefix = nonce.slice(0, 16);
    refreshDock();
    let pv;
    try {
      pv = await pageView(page, sha);
    } catch (e) {
      pv = quiet(e) ? null : blankView(page);
    }
    const current = mine === ed.loads && sessionGen.isCurrent(gen) && ed.on && ed.host;
    if (current && pv) {
      ed.pv = pv;
      loadRail(pv, page, sha, mine).catch(shown);
    }
    if (ed.pvWait === waited) ed.pvWait = null;
    if (viewIn) viewIn();
    if (current && pv) { postEditor(); refreshDock(); }
  }

  /* What the frame reads: the drafts on the same commit from memory (this
     page's first), everything else at that commit through the session's
     cache — and the page on screen with this load's sentinels. */
  async function frameFetcher(p) {
    // U7: the page file waits for this load's view of the open proposals (frameTo); every other file is at once
    if (ed.pvWait && ed.page && p === ed.page.file) {
      const load = ed.loads;
      await ed.pvWait;
      if (load !== ed.loads) return { ok: false, status: 503, text: '' };    // that document is gone
    }
    const prefix = ed.prefix;
    const page = ed.page;
    const show = ed.show;
    const pv = ed.pv;
    // round 2 (R5): a people proposal drawn on the Team page: its head's data/people.json (marked by hc-editor.people)
    if (pv && page && page.data && p === page.file && typeof pv.peopleHead === 'string') {
      return { ok: true, status: 200, text: pv.peopleHead };
    }
    // a proposal drawn on this page: the composite, its blocks marked with this load's sentinels
    if (pv && pv.ov && page && pv.file === page.file && p === page.file && prefix) {
      return { ok: true, status: 200, text: C.withSentinels(pv.ov.text, prefix, pv.ov.overlay) };
    }
    if (show) {
      const st = show.changed.get(p);
      if (st === 'removed') return { ok: false, status: 404, text: '' };
      const at = st ? show.sha : await mainSha();
      return sessionCache().at(at)(p);
    }
    const sha = ed.draft ? ed.draft.base.sha : await mainSha();
    const answer = await C.draftFetcher(draftFiles(sha), sessionCache().at(sha))(p);
    if (!answer.ok || !page || page.data || p !== page.file || !prefix) return answer;   // data: no blocks
    const marked = C.withSentinels(answer.text, prefix);
    return marked === null ? answer : { ok: true, status: answer.status, text: marked };
  }

  function draftFiles(sha) {
    const files = {};
    for (const d of drafts.dirty()) {
      if (d.base.sha === sha) Object.assign(files, d.files);   // one sha, one tree: main's or my proposal's head
    }
    if (ed.draft && ed.draft.base.sha === sha) Object.assign(files, ed.draft.files);
    return files;
  }

  // ------------------------------------------------ proposals in place ---
  /* Plan D-F, D-G (U7). What a load shows, decided before it starts:
       show     "Show on page": that proposal's head, read-only, its own
                changes marked (the composite of its merge base and head);
       draft    my draft of this page (the bar says when a proposal also
                touches it);
       overlay  main, with the NEWEST open proposal that touches the page
                drawn over it (View: "Show others' suggestions" on);
       hidden   the same proposals exist, but the setting is off;
       main     nothing proposed here.
     The open proposals and their files are read once per refresh; a merge
     base (compare main...head) and a gate status once per head sha; the
     texts through the session's sha cache. So a reload after an edit asks
     GitHub nothing. */

  function forgetProposals() {
    ed.props = null;
    ed.bases = new Map();
    ed.checks = new Map();
  }

  // a promise kept under key until it fails (a failure is asked again next time)
  function memo(map, key, make) {
    if (!map.has(key)) {
      const p = Promise.resolve().then(make);
      map.set(key, p);
      p.catch(() => { if (map.get(key) === p) map.delete(key); });
    }
    return map.get(key);
  }

  /* The open proposals, each with its changed files (null when GitHub
     would not list them). */
  function openProposals() {
    if (!ed.props) {
      const p = (async () => {
        const open = C.orderOpenPulls(await openPulls(), null);
        const files = await Promise.all(open.map((x) => filesOrNull(x.number)));
        return open.map((pull, i) => ({ pull, files: files[i] }));
      })();
      ed.props = p;
      p.catch(() => { if (ed.props === p) ed.props = null; });
    }
    return ed.props;
  }

  const FULL_SHA = /^[0-9a-f]{40}$/;
  const headShaOf = (pull) => (pull && pull.head && FULL_SHA.test(String(pull.head.sha)) ? pull.head.sha : null);
  const newestFirst = (a, b) => ((Date.parse(b.pull.created_at) || 0) - (Date.parse(a.pull.created_at) || 0))
    || (b.pull.number - a.pull.number);
  const fileRow = (files, file) => (files || []).find((f) => f && f.filename === file)
    || (files || []).find((f) => f && f.previous_filename === file) || null;

  const mergeBaseOf = (main, head) => memo(ed.bases, `${main}...${head}`, async () => {
    const res = await apiResponse(C.comparePath(main, head));
    const base = res.ok && res.data && res.data.merge_base_commit ? res.data.merge_base_commit.sha : null;
    if (typeof base !== 'string' || !FULL_SHA.test(base)) {
      throw new Error(`GitHub answered HTTP ${res.status} for the proposal's merge base`);
    }
    return base;
  });

  const checkOf = (head) => memo(ed.checks, head, async () => {
    const res = await apiResponse(`${C.REPO_API_PATH}/commits/${head}/check-runs?check_name=check&per_page=100`);
    return res.ok ? C.checkStatus(res.data) : { state: 'unknown' };
  });

  /* A file's text at a sha; a file that is not there is '' when missing is
     allowed (added at the head, removed by it). */
  async function textAt(sha, file, missingOk) {
    const a = await sessionCache().get(sha, file);
    if (a.ok) return a.text;
    if (a.status === 404 && missingOk) return '';
    throw new Error(`GitHub answered HTTP ${a.status} for ${file}`);
  }

  /* HCCore.overlayOnMain for proposal t on `file`. over: 'main' (the
     overlay, drawn over main) or 'head' (Show on page: the head's text
     with the proposal's own changes marked). -> {text, overlay, conflicts} | null */
  async function proposalOverlay(t, file, main, over) {
    const head = headShaOf(t.pull);
    const row = fileRow(t.files, file);
    if (!head || !row) return null;
    const away = row.filename !== file;      // renamed away from this page: gone at the head
    const basePath = !away && typeof row.previous_filename === 'string' ? row.previous_filename : file;
    const base = await mergeBaseOf(main, head);
    const [baseText, headText] = await Promise.all([
      row.status === 'added' && !away ? '' : textAt(base, basePath, true),
      away || row.status === 'removed' ? '' : textAt(head, file, true)]);
    if (over === 'head') return C.overlayOnMain(baseText, baseText, headText);
    return C.overlayOnMain(await textAt(main, file, false), baseText, headText);
  }

  /* The frame's marks for the composite (js/source.js OVERLAY_MARKS): a
     block the proposal removes or replaces -> del; its replacement, right
     after it -> change; a new block -> add; a block main changed too ->
     conflict. Main's own blocks carry no mark. */
  function overlayMarks(entries) {
    const out = [];
    entries.forEach((e, i) => {
      const prev = entries[i - 1];
      let mark = null;
      if (e.source === 'pr-del') mark = 'del';
      else if (e.source === 'conflict') mark = 'conflict';
      else if (e.source === 'pr-add') {
        const replaces = Boolean(prev) && prev.source === 'pr-del' && e.pr.base !== null
          && prev.pr.base === e.pr.base && prev.pr.head === e.pr.head;
        mark = replaces ? 'change' : 'add';
      }
      if (mark) out.push({ index: i, mark });
    });
    return out;
  }

  const blankView = (page) => ({ mode: ed.show ? 'show' : 'main', file: page ? page.file : null, pr: null, files: null,
    ov: null, tint: 0, marks: [], touching: [], others: [], check: null, failed: false, people: [], peopleHead: null });

  async function pageView(page, main) {
    const pv = blankView(page);
    if (!page) return pv;
    let all;
    try {
      all = await openProposals();
    } catch (e) {
      if (quiet(e)) throw e;
      return pv;                         // no proposals to draw: the page works without them
    }
    pv.touching = all.filter((t) => fileRow(t.files, page.file)).sort(newestFirst);
    if (page.data) return peopleView(pv, page, main);
    let t = null;
    const focus = ed.focusPr !== null ? pv.touching.find((x) => x.pull.number === ed.focusPr) || null : null;
    if (ed.show) {
      t = pv.touching.find((x) => x.pull.number === ed.show.number) || null;
    } else if (focus) {
      // round 2 (R3): opened from the proposals list: that proposal, over main, with its review cards
      pv.mode = 'overlay';
      t = focus;
      pv.others = pv.touching.filter((x) => x !== focus);
    } else if (ed.draft) {
      pv.mode = 'draft';
    } else if (pv.touching.length) {
      pv.mode = currentView().suggestions ? 'overlay' : 'hidden';
      if (pv.mode === 'overlay') {
        t = pv.touching[0];
        pv.others = pv.touching.slice(1);
      }
    }
    if (!t) return pv;
    pv.pr = t.pull;
    pv.files = t.files;
    // round 2 (R1): the proposer's own colour; the viewer's own proposal is blue like their draft
    pv.tint = C.slotOf(C.proposerSlots(all.map((x) => x.pull), state.session && state.session.login), loginOf(t.pull));
    const head = headShaOf(t.pull);
    const [ov, check] = await Promise.all([
      proposalOverlay(t, page.file, main, pv.mode === 'show' ? 'head' : 'main')
        .catch((e) => { if (quiet(e)) throw e; return null; }),
      head ? checkOf(head).catch((e) => { if (quiet(e)) throw e; return { state: 'unknown' }; }) : { state: 'unknown' }]);
    pv.ov = ov;
    pv.failed = !ov;
    pv.marks = ov ? overlayMarks(ov.overlay) : [];
    pv.check = check;
    return pv;
  }

  /* Round 2 (R5): the Team page (data/people.json). My draft: its marks against what it started from, the
     card tools on. Else the proposal opened from the list (or the newest touching it, with "Show others'
     suggestions" on): its head's file, marked against its merge base, in its proposer's colour; tools off. */
  async function peopleView(pv, page, main) {
    pv.people = [];
    const focus = ed.focusPr !== null ? pv.touching.find((x) => x.pull.number === ed.focusPr) || null : null;
    const d = ed.draft && ed.draft.key === page.pageId ? ed.draft : null;
    if (!focus && d) {
      pv.mode = 'draft';
      pv.people = C.peopleMarks(d.originals[page.file], d.files[page.file]);
      return pv;
    }
    const t = focus || (pv.touching.length && currentView().suggestions ? pv.touching[0] : null);
    if (!t) { if (pv.touching.length) pv.mode = 'hidden'; return pv; }
    pv.mode = 'overlay';
    pv.pr = t.pull;
    pv.files = t.files;
    pv.others = pv.touching.filter((x) => x !== t);
    pv.tint = C.slotOf(C.proposerSlots(pv.touching.map((x) => x.pull), state.session && state.session.login), loginOf(t.pull));
    const head = headShaOf(t.pull);
    try {
      const base = head ? await mergeBaseOf(main, head) : null;
      const [was, now, check] = await Promise.all([textAt(base || main, page.file, true), head ? textAt(head, page.file, true) : null,
        head ? checkOf(head).catch(() => ({ state: 'unknown' })) : { state: 'unknown' }]);
      pv.check = check;
      if (typeof now === 'string') { pv.peopleHead = now; pv.people = C.peopleMarks(was, now); } else pv.failed = true;
    } catch (e) {
      if (quiet(e)) throw e;
      pv.failed = true;
    }
    return pv;
  }

  /* The reader followed a link inside the frame to another page: a page with a proposal to draw is loaded
     again with it. */
  async function viewAfterRoute(page) {
    const mine = ed.loads;
    ed.pv = blankView(page);
    postEditor();                        // the frame repaints from its last message: the old marks go now
    let pv;
    try {
      pv = await pageView(page, await mainSha());
    } catch (e) {
      return;
    }
    if (mine !== ed.loads || ed.page !== page || !ed.on) return;
    if (pv.ov) { frameTo(ed.route, false); return; }
    ed.pv = pv;
  }

  /* A pick in the frame. Over a drawn proposal the index is the
     composite's (D-F): a main block is edited at ITS index in main (the
     frame then shows the draft), a proposal's block opens that proposal's
     card and starts nothing. */
  async function pick(k) {
    const pv = ed.pv;
    if (!pv || !pv.ov) return selectBlock(k);
    const e = pv.ov.overlay[k];
    if (!e) return undefined;
    if (e.source !== 'main' && railActivateAt(k)) return undefined;     // U5b: its card in the rail
    if (e.source !== 'main') { openCard(pv.pr.number); return undefined; }
    return selectBlock(e.mainIndex, true);
  }

  /* "+" over a drawn proposal: after the nearest preceding block of main
     (a conflict block is main's text too). */
  async function pickInsert(k, kind) {
    const pv = ed.pv;
    if (!pv || !pv.ov) return insertBlock(k, kind);
    const list = pv.ov.overlay;
    let j = Math.min(k, list.length) - 1;
    while (j >= 0 && list[j].mainIndex === null) j -= 1;
    return insertBlock(j >= 0 ? list[j].mainIndex + 1 : 0, kind);
  }

  /* A proposal's block with no card of its own: its review, which is the #/review/<n> redirect now (U0b: the
     page + the bubble, that proposal kept drawn; U3 opens its row in the bubble). */
  function openCard(n) {
    trayGo(`#/review/${n}`);
  }





  const plural = (n, one, many) => (n === 1 ? one : many);





  // ------------------------------------------------- the review rail (U5b) ---
  /* plan-u5 U5b. When a proposal is drawn over the page, the PARENT shows one card per edit beside the
     frame: who proposed it, the change in words, and (for someone who may approve that page) Approve and
     Reject. The cards come from HCCore.reviewCards over HCCore.proposalEdits, the go-live engine's own
     functions; the frame only reports where the marked blocks are (hc-block-rects, numbers) and lights the
     one whose card is hovered or active (hot). Every write is HCCore.runRecord: one approval record on the
     proposal, which .github/workflows/go-live.yml turns into a change on main.
       wide (>= RAIL_WIDE px)   cards in a column beside the frame, each on its block's line
       narrow                   an avatar marker per change; a click opens its card beside the marker
       phone (PHONE_QUERY)      "Review N changes" in the page bar opens them as a bottom sheet
     Card safety (plan §7): a card's buttons ignore activation for CLICK_GUARD_MS after it appears or
     moves, so a frame that moves a block under the pointer cannot turn a click into an approval. */
  const RAIL_WIDE = 1100;
  const CLICK_GUARD_MS = 400;
  const POLL_MS = 15000;
  const POLL_LIMIT_MS = 5 * 60 * 1000;
  const GO_LIVE_RUNS = `${C.GITHUB_WEB}/actions/workflows/go-live.yml`;
  const ROLE_NAME = { admin: 'admin', maintain: 'maintain', push: 'write' };
  const rail = { el: null, data: null, cards: [], rects: new Map(), view: 0, active: null, hover: null,
    pending: new Map(), pollUntil: 0, timer: null, nodes: new Map(), sheet: null, pop: null, stale: false, busy: false };
  const collabRoles = new Map();           // login -> role_name, for this session

  function railReset() {
    if (rail.timer) clearTimeout(rail.timer);
    Object.assign(rail, { data: null, cards: [], rects: new Map(), view: 0, active: null, hover: null, pending: new Map(),
      pollUntil: 0, timer: null, nodes: new Map(), stale: false, busy: false });
    closeSheet();
    if (rail.el) { rail.el.replaceChildren(); rail.el.hidden = true; }
    document.body.classList.remove('hc-has-rail');
  }

  async function roleNameOf(login) {
    const key = String(login).toLowerCase();
    if (!collabRoles.has(key)) {
      const p = apiResponse(`${C.REPO_API_PATH}/collaborators/${encodeURIComponent(key)}/permission`)
        .then((res) => (res.ok && res.data && typeof res.data.role_name === 'string' ? res.data.role_name : 'none'));
      collabRoles.set(key, p);
      p.catch(() => collabRoles.delete(key));
    }
    return collabRoles.get(key);
  }

  /* Everything the cards need, read once per load (texts through the session's sha cache). */
  async function loadRail(pv, page, main, mine) {
    if (!pv || pv.mode !== 'overlay' || !pv.ov || !pv.pr || !page || !rail.el) return;
    const pull = pv.pr;
    const n = pull.number;
    const head = headShaOf(pull);
    if (!head) return;
    const base = await mergeBaseOf(main, head);
    const [baseText, headText, mainText, list, commits, access] = await Promise.all([
      textAt(base, page.file, true), textAt(head, page.file, true), textAt(main, page.file, false),
      allComments(n).catch((e) => { if (quiet(e)) throw e; return []; }),
      committersOf(n).catch((e) => { if (quiet(e)) throw e; return null; }),
      accessRegistry()]);
    const edits = await C.proposalEdits(page.file, baseText, headText, mainText);
    if (mine !== ed.loads || ed.pv !== pv || !edits) return;
    const talk = await loadTalk(n).catch((e) => { if (quiet(e)) throw e; return { comments: [], resolved: new Map(), ok: false }; });
    if (mine !== ed.loads || ed.pv !== pv) return;
    const author = loginOf(pull).toLowerCase();
    // committers unknown: nobody's record is trusted and nobody gets Approve (the engine would refuse them)
    const committers = commits || { has: () => true };
    const roles = new Map();
    for (const r of C.parseRecords(list, { author }).list) {
      if (!roles.has(r.login)) roles.set(r.login, await roleNameOf(r.login).catch(() => 'none'));
    }
    const me = String((state.session && state.session.login) || '').toLowerCase();
    const myRole = ROLE_NAME[state.role && state.role.key] || 'read';
    const rule = (login, permission) => !committers.has(login)
      && C.mayApproveEdit({ login, permission, path: page.file, access, author });
    rail.data = { n, pull, file: page.file, head, base, baseText, headText, edits, comments: list, author, talk,
      eligible: C.proposalEligible(pull, pv.files), trusted: (login) => rule(login, roles.get(login)),
      may: () => Boolean(me) && rule(me, myRole), main };
    renderRail();
  }

  /* Every issue comment of proposal n (the approval records may be past the first page), up to the go-live
     engine's own 30 pages. -> array; .partial = true when a later page could not be read or there may be
     more (callers treat that as unknown, never as "no records"). */
  const COMMENT_PAGES = 30;
  async function allComments(n) {
    const out = [];
    out.partial = false;
    for (let page = 1; page <= COMMENT_PAGES; page += 1) {
      const res = await apiResponse(`${C.REPO_API_PATH}/issues/${n}/comments?per_page=100&page=${page}`);
      if (!res.ok || !Array.isArray(res.data)) {
        if (page === 1) throw new Error(`GitHub answered HTTP ${res.status}`);
        out.partial = true;
        break;
      }
      out.push(...res.data);
      if (res.data.length < 100) break;
      if (page === COMMENT_PAGES) out.partial = true;
    }
    return out;
  }

  /* Everyone who authored or committed a commit of proposal n (every page, as the go-live engine reads
     them; GitHub lists at most 250). A reader that fails counts as unknown: the caller trusts no record. */
  async function committersOf(n) {
    const out = new Set();
    for (let page = 1; page <= 3; page += 1) {
      const res = await apiResponse(`${C.REPO_API_PATH}/pulls/${n}/commits?per_page=100&page=${page}`);
      if (!res.ok || !Array.isArray(res.data)) return null;
      for (const c of res.data) {
        for (const who of [c && c.author, c && c.committer]) {
          const l = who && typeof who.login === 'string' ? who.login.toLowerCase() : '';
          if (l && l !== 'web-flow') out.add(l);
        }
      }
      if (res.data.length < 100) break;
    }
    return out;
  }


  // ---- U6: conversations on a change (review comments on the proposal; resolve through the GraphQL door)
  const TALK_PAGES = 30;
  async function loadTalk(n) {
    const comments = [];
    let partial = false;                               // more than we read, or a page that failed: the card says so
    for (let page = 1; page <= TALK_PAGES; page += 1) {
      const res = await apiResponse(`${C.REPO_API_PATH}/pulls/${n}/comments?per_page=100&page=${page}`);
      if (!res.ok || !Array.isArray(res.data)) { partial = true; break; }
      comments.push(...res.data);
      if (res.data.length < 100) break;
      if (page === TALK_PAGES) partial = true;
    }
    const resolved = new Map();                        // root comment id -> {threadId, isResolved}
    let after = null;
    for (let i = 0; i < TALK_PAGES && state.client && typeof state.client.graphql === 'function'; i += 1) {
      const g = await state.client.graphql('threads', after ? { n, after } : { n });
      const rt = g && g.ok && g.data && g.data.data && g.data.data.repository && g.data.data.repository.pullRequest
        ? g.data.data.repository.pullRequest.reviewThreads : null;
      if (!rt) break;
      for (const t of Array.isArray(rt.nodes) ? rt.nodes : []) {
        const first = t && t.comments && t.comments.nodes && t.comments.nodes[0];
        if (first && Number.isInteger(first.databaseId) && typeof t.id === 'string') resolved.set(first.databaseId, { threadId: t.id, isResolved: t.isResolved === true });
      }
      if (!rt.pageInfo || rt.pageInfo.hasNextPage !== true || typeof rt.pageInfo.endCursor !== 'string') break;
      after = rt.pageInfo.endCursor;
    }
    return { comments, resolved, ok: true, partial };
  }
  function talkOf(key) {
    const d = rail.data;
    if (!d || !d.talk) return [];
    if (!d.threads) d.threads = C.threadsByEdit(d.talk.comments, d.edits, d.baseText, d.headText, d.file);
    return d.threads.byKey.get(key) || [];
  }
  const canTalk = () => Boolean(state.role && state.role.canPush === true);

  async function talkWrite(build, key) {
    const d = rail.data;
    if (!d || rail.busy) return;
    let req;
    try { req = build(); } catch (e) { say(`Nothing was sent: ${e.message}.`, 'error'); return; }
    rail.busy = true;
    let res;
    try { res = await C.runThreadWrite(state.client, req); } finally { rail.busy = false; }
    if (!res.ok) { say(res.message, 'error'); return; }
    d.talk = await loadTalk(d.n).catch(() => d.talk);
    d.threads = null;
    rail.active = key;
    renderRail();
  }
  async function resolveThread(t, key, on) {
    const d = rail.data;
    const info = d && d.talk ? d.talk.resolved.get(t.rootId) : null;
    if (!info || rail.busy) return;
    rail.busy = true;
    let res;
    try { res = await C.runResolve(state.client, info.threadId, on); } finally { rail.busy = false; }
    if (!res.ok) { say(res.message, 'error'); return; }
    d.talk = await loadTalk(d.n).catch(() => d.talk);
    d.threads = null;
    rail.active = key;
    renderRail();
  }

  /* The conversation part of a card: inactive, "N replies"; active, every message, a reply box, Resolve. */
  function talkNode(c) {
    const threads = talkOf(c.key);
    const d = rail.data;
    const count = threads.reduce((k, t) => k + t.comments.length, 0);
    if (rail.active !== c.key) {
      return count ? h('p', { class: 'hc-rcard-replies', text: `${count} ${plural(count, 'comment', 'comments')}` }) : null;
    }
    const box = h('div', { class: 'hc-talk' });
    if (d.talk.partial) {
      box.appendChild(h('p', { class: 'hc-rcard-state' }, 'Not every comment could be read here — ', link(prLink(d.n), 'see the proposal on GitHub'), '.'));
    }
    for (const t of threads) {
      const info = d.talk.resolved.get(t.rootId);
      const done = Boolean(info && info.isResolved);
      const thread = h('div', { class: `hc-talk-thread${done ? ' is-resolved' : ''}` });
      for (const m of t.comments) {
        const who = m.user && typeof m.user.login === 'string' ? m.user.login : 'someone';
        thread.appendChild(h('div', { class: 'hc-talk-msg' },
          h('div', { class: 'hc-talk-head' }, avatarFace(who, who), h('b', { text: who }), h('span', { class: 'hc-rcard-when', text: cardWhen(m.created_at) })),
          h('p', { class: 'hc-talk-text', text: String(m.body || '') })));
      }
      if (canTalk()) {
        const reply = h('textarea', { class: 'hc-talk-input', rows: '2', maxlength: '4000', 'aria-label': 'Reply', placeholder: 'Reply…' });
        const send = h('button', { type: 'button', class: 'cms-btn', 'data-action': 'talk-reply', disabled: rail.busy === true }, 'Reply');
        send.addEventListener('click', (e) => { e.stopPropagation(); talkWrite(() => C.replyRequest(d.n, t.rootId, reply.value), c.key); });
        const row = h('div', { class: 'hc-talk-row' }, send);
        if (info) {
          const rb = h('button', { type: 'button', class: 'cms-btn', 'data-action': done ? 'talk-reopen' : 'talk-resolve', disabled: rail.busy === true }, done ? 'Reopen' : 'Resolve');
          rb.addEventListener('click', (e) => { e.stopPropagation(); resolveThread(t, c.key, !done); });
          row.appendChild(rb);
        }
        thread.append(reply, row);
      }
      box.appendChild(thread);
    }
    if (canTalk() && c.anchor !== null) {
      const input = h('textarea', { class: 'hc-talk-input', rows: '2', maxlength: '4000', 'aria-label': 'Comment on this change',
        placeholder: threads.length ? 'Start another conversation…' : 'Comment on this change…' });
      const send = h('button', { type: 'button', class: 'cms-btn', 'data-action': 'talk-new', disabled: rail.busy === true }, 'Comment');
      const edit = d.edits.find((e) => e.key === c.key);
      send.addEventListener('click', (e) => { e.stopPropagation(); talkWrite(() => C.threadRequest(d.n, { headSha: d.head, path: d.file, edit,
        baseText: d.baseText, headText: d.headText, text: input.value }), c.key); });
      box.append(input, h('div', { class: 'hc-talk-row' }, send));
    }
    for (const el of box.querySelectorAll('textarea')) {
      el.addEventListener('click', (e) => e.stopPropagation());
      el.addEventListener('keydown', (e) => e.stopPropagation());
    }
    return box;
  }

  function railCards() {
    const d = rail.data;
    if (!d) return [];
    return C.reviewCards({ edits: d.edits, overlay: ed.pv && ed.pv.ov ? ed.pv.ov.overlay : [], comments: d.comments,
      author: d.author, headSha: d.head, trusted: d.trusted, may: d.may, eligible: d.eligible, pending: rail.pending });
  }


  const ICON = {
    approve: 'M4 10.5l4 4 8-9',
    decline: 'M5 5l10 10M15 5L5 15',
  };
  function icon(kind) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', ICON[kind]);
    svg.appendChild(path);
    return svg;
  }

  // "Oct 14, 4:12 PM" in the reader's own locale and time zone (the card says when, not a raw date)
  function cardWhen(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    try {
      return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch (e) { return day(iso); }
  }

  function stateLine(c) {
    const by = c.by ? ` by ${c.by}` : '';
    if (c.state === 'going') {
      if (rail.stale) {
        return h('p', { class: 'hc-rcard-state is-going', role: 'status' },
          `Approved${by}. Still waiting to go live — `, link(GO_LIVE_RUNS, 'see the site robot’s runs'), '.');
      }
      return h('p', { class: 'hc-rcard-state is-going', role: 'status' }, h('span', { class: 'hc-spin', 'aria-hidden': 'true' }),
        `Approved${by}. Going live… (about a minute)`);
    }
    const words = {
      declined: `Declined${by}.`,
      failed: `Not live: ${c.reason || 'the site check failed'}.`,
      conflict: 'This part changed on the site since it was proposed. Use Review to ask for changes.',
      ambiguous: 'Two identical changes here: review the whole proposal.',
      whole: 'This proposal is reviewed as a whole (Review).',
    }[c.state];
    if (words) return h('p', { class: `hc-rcard-state is-${c.state}`, role: 'status', text: words });
    if (!c.canAct) return h('p', { class: 'hc-rcard-state', text: 'Waiting for review.' });
    return null;
  }

  function cardNode(c) {
    const d = rail.data;
    const login = loginOf(d.pull);
    const when = cardWhen(d.pull.updated_at || d.pull.created_at);
    const acts = h('div', { class: 'hc-rcard-acts' });
    for (const a of c.acts) {
      const b = h('button', { type: 'button', class: `hc-rcard-btn is-${a}`, 'data-act': a, disabled: rail.busy === true,
        'aria-label': a === 'approve' ? 'Approve this change' : 'Reject this change',
        title: a === 'approve' ? 'Approve (goes live)' : 'Reject' }, icon(a));
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (Date.now() < Number(card.dataset.armedAt || 0)) return;     // card safety: it just appeared or moved
        decide(a === 'approve' ? 'approved' : 'declined', [c.key]);
      });
      acts.appendChild(b);
    }
    const body = h('p', { class: 'hc-rcard-body' }, h('b', { text: `${c.verb}: ` }));
    if (c.from) body.appendChild(h('span', { class: 'hc-rcard-from', text: `“${c.from}”` }));
    if (c.from && c.to) body.appendChild(h('b', { text: ' with ' }));
    if (c.to) body.appendChild(h('span', { class: 'hc-rcard-to', text: `“${c.to}”` }));
    const card = h('article', { class: `hc-rcard is-${c.state}`, 'data-key': c.key, tabindex: '0',
      'aria-label': `${c.verb} suggested by ${login}` },
    h('div', { class: 'hc-rcard-head' }, avatarFace(login, login),
      h('div', { class: 'hc-rcard-id' }, h('span', { class: 'hc-rcard-who', text: login }),
        h('span', { class: 'hc-rcard-when', text: when })), acts),
    body, stateLine(c), talkNode(c));
    card.dataset.armedAt = String(Date.now() + CLICK_GUARD_MS);
    card.addEventListener('mouseenter', () => { rail.hover = c.key; postEditor(); });
    card.addEventListener('mouseleave', () => { if (rail.hover === c.key) { rail.hover = null; postEditor(); } });
    card.addEventListener('focus', () => { rail.hover = c.key; postEditor(); });
    card.addEventListener('blur', () => { if (rail.hover === c.key) { rail.hover = null; postEditor(); } });
    card.addEventListener('click', () => railActivate(c.key));
    card.addEventListener('keydown', (e) => {
      if (e.target !== card || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      railActivate(c.key);
    });
    return card;
  }

  function renderRail() {
    if (!rail.el) return;
    rail.cards = railCards();
    const drawn = rail.cards.filter((c) => c.anchor !== null);
    const on = drawn.length > 0;
    rail.el.hidden = !on;
    document.body.classList.toggle('hc-has-rail', on);
    rail.nodes = new Map();
    rail.el.replaceChildren(...drawn.map((c) => {
      const node = cardNode(c);
      rail.nodes.set(c.key, node);
      const marker = h('button', { type: 'button', class: 'hc-rmark', 'data-key': c.key,
        'aria-label': `${c.verb} suggested by ${loginOf(rail.data.pull)}: open its card` }, avatarFace(loginOf(rail.data.pull), loginOf(rail.data.pull)));
      marker.addEventListener('click', () => railActivate(rail.active === c.key ? null : c.key));
      return h('div', { class: 'hc-rslot', 'data-key': c.key }, marker, node);
    }));
    if (rail.sheet) openSheet();
    layoutRail();
    postEditor();
  }

  function railRects(rects, view) {
    rail.rects = new Map(rects.filter((r) => r && Number.isInteger(r.index)).map((r) => [r.index, r]));
    rail.view = Number(view) || 0;
    layoutRail();
  }

  /* Each card on its block's line (railLayout: no overlap; the active one exactly on its line). */
  function layoutRail() {
    if (!rail.el || rail.el.hidden) return;
    const narrow = window.innerWidth < RAIL_WIDE;
    rail.el.classList.toggle('is-markers', narrow);
    const drawn = rail.cards.filter((c) => c.anchor !== null && rail.rects.has(c.anchor));
    // the bubble sits top right, under the header: cards start below it where it covers the rail
    let minTop = -Infinity;
    if (dock && !document.body.classList.contains('hc-dock-collapsed') && typeof dock.getBoundingClientRect === 'function') {
      const b = dock.getBoundingClientRect();
      const r = rail.el.getBoundingClientRect();
      if (b.left < r.right && b.right > r.left && b.bottom > r.top) minTop = b.bottom - r.top + 8;
    }
    // a card whose block is scrolled out of sight (or hidden under the bubble) is not drawn
    const view = rail.view || window.innerHeight;
    const seen = drawn.filter((c) => { const r = rail.rects.get(c.anchor); return r.top + r.height > Math.max(0, minTop) && r.top < view; });
    for (const c of seen) { const node = rail.nodes.get(c.key); if (node && node.parentNode) node.parentNode.hidden = false; }
    const want = seen.map((c) => {
      const node = rail.nodes.get(c.key);
      const slot = node ? node.parentNode : null;
      const hgt = narrow ? 40 : (node ? node.offsetHeight || 96 : 96);     // measured shown (a hidden slot is 0 high)
      return { key: c.key, want: Math.max(rail.rects.get(c.anchor).top, minTop), height: hgt, slot };
    });
    const tops = C.railLayout(want, narrow ? null : rail.active, 8);
    for (const w of want) {
      if (!w.slot) continue;
      const before = Number(w.slot.dataset.top);
      const top = Math.round(tops[w.key]);
      if (!Number.isFinite(before) || Math.abs(before - top) > 4) {
        const node = rail.nodes.get(w.key);
        if (node) node.dataset.armedAt = String(Date.now() + CLICK_GUARD_MS);     // it moved: re-arm the guard
      }
      w.slot.dataset.top = String(top);
      w.slot.style.transform = `translateY(${top}px)`;
      w.slot.hidden = false;
    }
    for (const [key, node] of rail.nodes) {
      const slot = node.parentNode;
      if (slot && !want.some((w) => w.key === key)) slot.hidden = true;             // its block is not drawn (yet)
      if (slot) {
        slot.classList.toggle('is-active', rail.active === key);
        const mark = slot.querySelector('.hc-rmark');
        if (mark) mark.setAttribute('aria-expanded', narrow && rail.active === key ? 'true' : 'false');
        node.classList.toggle('is-active', rail.active === key);
        node.classList.toggle('is-hot', rail.hover === key);
      }
    }
  }

  function railHot() {
    const key = rail.hover || rail.active;
    const c = key ? rail.cards.find((x) => x.key === key) : null;
    return c && c.anchor !== null ? c.anchor : null;
  }

  function railActivate(key) {
    if (rail.active === key) return;
    rail.active = key;
    renderRail();                                        // the active card opens its conversation (U6)
    const node = key ? rail.nodes.get(key) : null;
    if (node) node.dataset.armedAt = String(Date.now() + CLICK_GUARD_MS);
    layoutRail();
  }

  /* A click on a marked block in the frame: its card (a change is two entries, old then new). */
  function railActivateAt(k) {
    if (!rail.cards.length) return false;
    const c = rail.cards.find((x) => x.anchor === k || (x.kind === 'change' && x.anchor === k - 1));
    if (!c) return false;
    if (document.body.classList.contains('hc-phone')) openSheet(c.key);
    else railActivate(c.key);
    return true;
  }

  function openSheet(focusKey) {
    closeSheet();
    const drawn = rail.cards.filter((c) => c.anchor !== null);
    if (!drawn.length) return;
    const close = h('button', { type: 'button', class: 'cms-btn', 'data-action': 'rail-sheet-close' }, 'Close');
    close.addEventListener('click', closeSheet);
    const sheet = h('section', { class: 'hc-rsheet', role: 'dialog', 'aria-label': 'Suggested changes' },
      h('div', { class: 'hc-rsheet-head' }, h('b', { text: `${drawn.length} suggested ${plural(drawn.length, 'change', 'changes')}` }), close),
      ...drawn.map((c) => { const n = cardNode(c); if (c.key === focusKey) n.classList.add('is-active'); return n; }));
    sheet.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
    document.body.appendChild(sheet);
    rail.sheet = sheet;
    close.focus();
  }
  function closeSheet() {
    if (rail.sheet) rail.sheet.remove();
    rail.sheet = null;
  }

  /* Approve or Reject: the record goes to the proposal; approved keys are then watched on main. */
  async function decide(kind, keys) {
    const d = rail.data;
    if (!d || !keys.length || !state.client || rail.busy) return;    // one decision at a time: no duplicate records
    rail.busy = true;
    renderRail();                                                     // its buttons are disabled meanwhile
    let out;
    try {
      out = await C.runRecord(state.client, d.n, kind, keys);
    } finally {
      rail.busy = false;
    }
    say(out.message, out.ok ? null : 'error');
    const done = Array.isArray(out.done) ? out.done : [];     // a partial write still counts for what it recorded
    if (!done.length) { renderRail(); return; }
    for (const k of done) rail.pending.set(k, kind);
    renderRail();
    if (kind === 'approved') watchMain();
  }

  /* After an approval: read main again every POLL_MS (one ref read; the page text only when main moved)
     until every approved key is live (the page then reloads to show main as it is), or POLL_LIMIT_MS
     passed (the cards then say where to look). */
  function watchMain() {
    if (!rail.pollUntil) rail.pollUntil = Date.now() + POLL_LIMIT_MS;
    if (rail.timer) return;
    const mine = ed.loads;
    const tick = async () => {
      rail.timer = null;
      const d = rail.data;
      if (!d || mine !== ed.loads || !ed.on) return;
      let sha;
      try { sha = await C.resolveRef(state.client, 'main'); } catch (e) { sha = null; }
      if (sha && sha !== d.main) {
        const [text, comments] = await Promise.all([textAt(sha, d.file, false).catch(() => null),
          allComments(d.n).catch(() => null)]);
        if (mine !== ed.loads || rail.data !== d) return;
        if (comments) d.comments = comments;
        const edits = text === null ? null : await C.proposalEdits(d.file, d.baseText, d.headText, text);
        const waiting = [...rail.pending].filter(([, k]) => k === 'approved').map(([key]) => key);
        if (edits && waiting.every((k) => { const e = edits.find((x) => x.key === k); return !e || e.state === 'live'; })) {
          say('Approved and live.');
          ed.mainSha = null;
          forgetProposals();
          frameTo(ed.route, true);                           // main as it is now, the rest still drawn over it
          return;
        }
      } else {
        const comments = await allComments(d.n).catch(() => null);
        if (comments && rail.data === d) d.comments = comments;
      }
      if (rail.data !== d) return;
      if (Date.now() > rail.pollUntil) { rail.stale = true; renderRail(); return; }
      renderRail();
      rail.timer = setTimeout(tick, POLL_MS);
    };
    rail.timer = setTimeout(tick, POLL_MS);
  }

  /* U7 (plan D12): a load says hc-ready twice. The first is the handshake (its script runs: it may hear
     hc-editor now); the second is its first paint (Editor mode applied, its style sheet in, the page drawn,
     js/editor-frame.js paintSignal). Only then does the frame take #content's place (body.hc-frame-live), so
     switching Editor on never blanks the page. Once on screen the frame stays there for the session's later
     loads; Editor off undoes it (setEditor). A frame that never paints gives way after LIVE_FALLBACK_MS. */
  const LIVE_FALLBACK_MS = 8000;
  function frameReady() {
    ed.readies = (ed.readies || 0) + 1;
    if (ed.readies === 1) { ed.ready = true; postEditor(); return; }
    frameLive();
  }
  function frameLive() {
    if (!ed.on || !ed.frame) return;
    document.body.classList.add('hc-frame-live');
    if (frameHost) frameHost.inert = false;
  }

  /* hc-editor goes to the frame only once THIS load said hc-ready: before
     that the window may still hold another document. A post held back is
     not queued: the hc-ready answer carries the state as it is then. */
  function postEditor() {
    const w = ed.frame && ed.frame.contentWindow;
    const nonce = ed.host && ed.host.nonce();
    if (!w || !nonce || !ed.ready) return;
    const tint = ed.pv && ed.pv.pr && Number.isInteger(ed.pv.tint) ? ed.pv.tint : 0;
    if (document.body) document.body.setAttribute('data-hc-tint', String(tint));   // the bar and the review cards
    // round 2 (R5): the Team page's card tools (my own edits only, never over a drawn proposal) and its marks
    const onTeam = Boolean(ed.page && ed.page.data);
    const people = { edit: onTeam && canEditPage(ed.page) && !ed.show && !(ed.pv && ed.pv.pr), marks: onTeam && ed.pv ? ed.pv.people || [] : [],
      focus: onTeam ? ed.peopleFocus || null : null };
    // the edit gate: a project page you may not edit shows no "+" and no pick affordance (the parent refuses them too)
    const locked = pageLocked(ed.page);
    w.postMessage({ type: 'hc-editor', nonce, on: true, settings: currentView(), theme: siteTheme(),
      selected: ed.selected, overlay: ed.pv ? ed.pv.marks : [], open: openBlockMessage(), hot: railHot(), tint, people, locked,
      cmd: ed.cmdOut || null }, '*');
    ed.cmdOut = null;                     // a restore is sent once (the frame acts once per n)
  }

  /* The block the frame may open for typing in the page (U2): the selected block of MY draft, its
     Markdown taken from the draft's span (the frame renders it itself). Never while a proposal is
     shown, never for a read-only role, never for the whole-page Markdown, and not when the person
     chose the Markdown box for it. */
  function openBlockMessage() {
    const sel = ed.sel;
    const d = ed.draft;
    if (!sel || sel.whole || ed.selected === null || !d || d.key !== sel.key || !canEditKey(d.key) || showing()) return null;
    if (ed.pv && ed.pv.ov) return null;                    // a proposal is drawn over the page
    const md = d.files[sel.file].slice(sel.span.start, sel.span.end);
    if (md.length > MAX_BLOCK_MD) return null;
    const split = C.splitBlocks(md);
    const b = split.ok ? split.blocks.find((x) => x.kind !== 'space') : null;
    if (!b || OPEN_KINDS.indexOf(b.kind) < 0) return null;
    if (imageParts(md)) return null;         // V2: a click on an image replaces it; nothing opens
    return { index: ed.selected, md, kind: b.kind, as: ed.asMarkdown === ed.selected ? 'markdown' : null };
  }

  /* hc-block-md: the open block's new Markdown, written into the draft by its SPAN (the text outside
     it stays byte-identical) and kept; the frame is NOT reloaded (the jump is gone). Accepted only
     for the one block the parent marked open, typed in the page, in author mode. */
  function blockTyped(index, md) {
    const sel = ed.sel;
    const d = ed.draft;
    if (!ed.inPage || ed.inPage.index !== index || ed.selected !== index || !sel || sel.whole || !d || d.key !== sel.key
      || !canEditKey(d.key) || showing() || typeof md !== 'string' || md.length > MAX_BLOCK_MD) return;
    hist.spanBefore = { start: sel.span.start, end: sel.span.end };   // R2b: the span an undo of this step comes back to
    const out = C.replaceSpan(d.files[sel.file], sel.span, md);
    d.files[sel.file] = out.text;
    sel.span = out.span;
    // typing: one undo step per burst (histNote); a note box's Remove (md '') is a step of its own
    hist.typing = md !== '';
    try { if (C.isDirty(d)) drafts.put(d); else drafts.remove(d.key); } finally { hist.typing = false; }
    refreshDock({ typed: true });          // U2 (plan D13): typing folds the bubble
  }


  /* hc-block-state: the frame typed in the page, or needs the Markdown box, or closed the block. */
  function blockState(index, editor, reason) {
    if (index !== ed.selected) return;
    if (editor === 'visual' || editor === 'code' || editor === 'box' || editor === 'mdbox') ed.inPage = { index, editor };
    else {
      ed.inPage = null;
      if (editor === 'markdown') ed.inPageReason = reason || '';
      if (editor === 'closed') { ed.selected = null; ed.sel = null; postEditor(); }
    }
    // the frame cannot open this block in the page: the whole page as Markdown on the thin editor page (U0b: the
    // block textarea of the old Changes tab is gone)
    if (editor === 'markdown') editWholePage().catch(shown);
  }

  /* A message from the frame. -> true when it was the frame's (acted on or
     ignored), false when it came from anywhere else. */
  function frameMessage(event) {
    const frame = ed.frame;
    if (!frame || !ed.host || !event || event.source !== frame.contentWindow) return false;
    const m = event.data;
    if (!m || typeof m !== 'object') return true;
    if (m.type === 'hc-fetch') { ed.host.handleMessage(event); return true; }
    if (typeof m.nonce !== 'string' || m.nonce !== ed.host.nonce()) return true;   // another load's, or forged
    const index = Number.isInteger(m.index) && m.index >= 0 && m.index <= MAX_INDEX ? m.index : null;
    if (m.type === 'hc-ready') frameReady();
    else if (m.type === 'hc-route' && typeof m.route === 'string' && ROUTE_RE.test(m.route)) frameRouted(m.route);
    else if (m.type === 'hc-block-select' && index !== null) pick(index).catch(shown);
    else if (m.type === 'hc-block-insert' && index !== null && typeof m.kind === 'string') pickInsert(index, m.kind).catch(shown);
    else if (m.type === 'hc-block-md' && index !== null) blockTyped(index, m.md);
    else if (m.type === 'hc-block-move' && index !== null && Number.isInteger(m.to) && m.to >= 0 && m.to <= MAX_INDEX) moveImage(index, m.to).catch(shown);
    else if (m.type === 'hc-block-state' && index !== null && typeof m.editor === 'string') blockState(index, m.editor, typeof m.reason === 'string' ? m.reason.slice(0, 300) : '');
    else if (m.type === 'hc-block-rects' && Array.isArray(m.rects)) railRects(m.rects, m.view);
    else if (m.type === 'hc-people' && (m.op === 'order' || m.op === 'add')) peopleEdit(m).catch(shown);
    else if (m.type === 'hc-history' && index !== null && typeof m.snap === 'string') {
      if (ed.page && hist.key === ed.page.pageId) hist.pending = { index, snap: m.snap };   // the next typed change's restore point
    } else if (m.type === 'hc-key' && (m.op === 'undo' || m.op === 'redo')) undoRedo(m.op);
    else if (m.type === 'hc-key' && m.op === 'redraw' && ed.on) frameTo(ed.route, true);   // the text is right; the page is drawn from it
    return true;
  }
  const shown = (e) => { if (!quiet(e)) say(`Something went wrong: ${(e && e.message) || e}`, 'error'); };

  /* The reader followed a link inside the frame: the parent's hash follows
     (js/app.js repaints the sidebar, the nav and the title), and the frame is
     NOT reloaded — onHashChange knows this change is the frame's. */
  function frameRouted(route) {
    const page = pageForRoute(route);
    const moved = !samePage(page, ed.page);
    // the frame read the new page at the old draft's base: another base (my proposal's head, or main) reloads it
    let reload = false;
    if (moved) {
      const was = ed.draft;
      clearSelection();
      const next = storedDraft(page);
      // a draft on another proposal is checked first (frameTo, on the reload); the same proposal already was
      const same = Boolean(next && was) && next.base.number === was.base.number && next.base.ref === was.base.ref;
      ed.draft = next && (next.base.number === null || same) ? next : null;
      // main to main, or the same proposal (number and branch): the frame already reads there
      reload = !same && (baseNo(was) !== null || baseNo(next) !== null);
    }
    ed.route = route;
    ed.page = page;
    if (moved && !reload) viewAfterRoute(page);
    refreshDock();                          // the dock counts the page now on screen
    if (currentRoute() === route) {
      if (reload) frameTo(route, true);
      return;
    }
    if (!reload) ed.fromFrame = route;     // a reload: onHashChange loads the frame there
    window.location.hash = `#${route}`;
  }

  function onHashChange() {
    const param = takeEditorParam();
    if (param) {
      applyParam(param);
      saveEditorState();
      D.unfold();                         // the redirect's bubble
      if (!ed.on) { setEditor(true); return; }
      applyTray();
      if (ed.trayOpen) trayGo(trayHash);
    }
    const r = currentRoute();
    const ours = ed.fromFrame !== null && r === ed.fromFrame;
    ed.fromFrame = null;
    if (ours || !ed.on) return;
    frameTo(r, false);
  }

  /* The draft of `page`: the one in memory, else a fresh one from main's
     head (read through the cache: the frame has usually read it already).
     at {ref, sha, number}: a fresh one from my proposal's head instead. */
  async function pageDraft(page, at) {
    if (!at && ed.draft && ed.draft.key === page.pageId) return ed.draft;
    const base = at || { ref: 'main', sha: await mainSha(), number: null };
    const answer = await sessionCache().get(base.sha, page.file);
    if (!answer.ok) throw new Error(`GitHub answered HTTP ${answer.status} for ${page.file}`);
    return { key: page.pageId, label: page.label, route: page.route, files: { [page.file]: answer.text },
      originals: { [page.file]: answer.text }, base: { ref: base.ref, sha: base.sha, number: base.number } };
  }

  /* My open proposals I may add this page to (HCCore.ownProposals over the
     open proposals the page view reads once per refresh); [] when GitHub
     does not answer. */
  async function ownOpen() {
    try {
      const all = await openProposals();
      return state.session ? C.ownProposals(all.map((t) => t.pull), state.session.login) : [];
    } catch (e) {
      return [];
    }
  }




  /* The index of the block a position starts, in the split of `text`
     (display only: the edit itself is the span). */
  // ---------------------------------------------- images in the page (V2) ---
  /* Kyle, 2026-10-14: an image is edited in the page. A click on it (or "+" Image) asks for a new file: it is
     uploaded through the Media gateway (C.runUpload, the image-list draft gains its entry, as Media did) and
     the block's address is replaced in MY draft by its span; nothing else changes. An image can also be
     dragged (or Alt+arrow) to another place: hc-block-move, an image block of my draft only. The file
     dialog is the browser's own, opened inside the click's activation; when the browser says the click is
     no longer active, the bubble offers a button to pick the file instead. */
  const imageParts = (md) => C.imageParts(md);
  let imageInput = null;
  let imageWant = null;        // {key, file, index}: the image block a chosen file replaces
  function imageInputEl() {
    if (imageInput) return imageInput;
    imageInput = h('input', { type: 'file', class: 'hc-image-input', accept: C.MEDIA_TYPES.join(','), 'aria-label': 'The new image',
      tabindex: '-1' });
    imageInput.hidden = true;
    imageInput.addEventListener('change', () => { imageChosen().catch(shown); });
    document.body.appendChild(imageInput);
    return imageInput;
  }
  const subfolderOf = (file) => (/^content\/projects\//.test(file) ? 'projects' : /^content\/tools\//.test(file) ? 'tools' : 'setup');
  function askImage(index) {
    const page = ed.page;
    const d = ed.draft;
    if (!page || !d || d.key !== page.pageId || !canEditPage(page) || showing() || (ed.pv && ed.pv.ov)) return;
    const span0 = C.spanOf(d.files[page.file], index);
    imageWant = { key: d.key, file: page.file, index, md: span0 ? d.files[page.file].slice(span0.start, span0.end) : null };
    const input = imageInputEl();
    input.value = '';
    const ua = typeof navigator !== 'undefined' ? navigator.userActivation : null;
    if (ua && ua.isActive === false) {
      const pickBtn = h('button', { type: 'button', class: 'cms-btn', 'data-action': 'image-pick' }, 'Pick the new image');
      pickBtn.addEventListener('click', () => { say(''); input.click(); });
      notice.replaceChildren(document.createTextNode('Replace this image: '), pickBtn);
      notice.hidden = false;
      notice.classList.remove('is-error');
      unfoldDock();
      return;
    }
    input.click();
  }
  async function imageChosen() {
    const f = imageInput && imageInput.files && imageInput.files[0];
    const want = imageWant;
    if (!f || !want) return;
    imageWant = null;
    const d = ed.draft;
    if (!d || d.key !== want.key || typeof d.files[want.file] !== 'string') { say('The page changed meanwhile: click the image again.', 'error'); return; }
    const bad = C.mediaFileProblem(f);
    if (bad) { say(bad, 'error'); return; }
    say('Uploading the new image…');
    const md = await manifestDraftOn(d.base);
    if (md.problem) { say(md.problem, 'error'); return; }
    const live = await liveAssets();
    const gen = sessionGen.current();
    const out = checked(gen, await uploadImage(f, subfolderOf(want.file), live, md.d.files[C.MANIFEST_FILE]));
    if (out.kind === 'problem') { say(out.message, 'error'); return; }
    // the page may have changed while the file uploaded: find THE image that asked (its exact Markdown), at its
    // index or, moved, wherever it is now (once); otherwise nothing is written, the image list included
    if (!ed.draft || ed.draft !== d || typeof d.files[want.file] !== 'string') { say('The page changed meanwhile: click the image again.', 'error'); return; }
    const text = d.files[want.file];
    const split = C.splitBlocks(text);
    const at = (k) => (split.ok && split.blocks[k] ? text.slice(split.blocks[k].start, split.blocks[k].end) : null);
    let k = at(want.index) === want.md ? want.index : -1;
    if (k < 0 && split.ok) {
      const hits = split.blocks.map((b, j) => j).filter((j) => at(j) === want.md);
      if (hits.length === 1) k = hits[0];
    }
    const span = k >= 0 ? C.spanOf(text, k) : null;
    const m = span ? imageParts(text.slice(span.start, span.end)) : null;
    if (!m) { say('That image changed while the file uploaded: nothing was changed. Click it again.', 'error'); return; }
    if (out.kind !== 'duplicate') { md.d.files[C.MANIFEST_FILE] = out.text; drafts.put(md.d); }
    // the "+" Image placeholder gives way to the file's name as the description (editable on the Data tab)
    const alt = m.alt === C.SNIPPET_CATALOG.image.placeholder
      ? String(f.name || 'image').replace(/\.[A-Za-z0-9]+$/, '').replace(/[[\]\\]/g, ' ').trim().slice(0, 120) || 'image' : m.alt;
    const r = C.replaceSpan(text, span, C.imageWith(Object.assign({}, m, { alt }), out.entry.url));
    d.files[want.file] = r.text;
    drafts.put(d);
    if (ed.sel && ed.sel.key === d.key && ed.selected === k) ed.sel.span = r.span;
    refreshDock();
    say(out.kind === 'duplicate' ? 'That image is already on the site: the page uses it now. Nothing was uploaded.'
      : 'Image replaced. The new file goes into your proposal with this page.');
    frameTo(ed.route, true);
  }
  /* Round 2 (R5): the Team page's tools. order: the lists as the frame shows them after a drag, a card-menu move
     or a pin — written into my draft of data/people.json (HCCore.peopleOrderText refuses any add or drop);
     add: "+" for that list (U0b: a redirect until U5 adds the person in place). */
  async function peopleEdit(m) {
    const page = ed.page;
    if (!page || !page.data || !canEditPage(page) || showing() || (ed.pv && ed.pv.pr)) return;
    if (m.op === 'add') {
      // the New person form is gone (U0b): "+" follows its redirect (the page + the bubble); U5 adds the person in place
      ed.addGroup = m.group === 'team' ? 'active' : 'alumni';
      trayGo('#/new/person');
      return;
    }
    const d = await pageDraft(page);
    if (ed.page !== page || ed.show) return;
    const out = C.peopleOrderText(d.files[page.file], m.team, m.alumni);
    if (out.problem) { say(out.problem, 'error'); frameTo(ed.route, true); return; }
    if (out.text === d.files[page.file]) return;
    ed.draft = d;
    d.files[page.file] = out.text;
    drafts.put(d);
    ed.peopleFocus = typeof m.focus === 'string' ? m.focus : null;   // the reloaded page comes back to them
    say('');
    refreshDock();
    frameTo(ed.route, true);
  }

  async function moveImage(from, to) {
    const page = ed.page;
    if (!page || !canEditPage(page) || showing() || (ed.pv && ed.pv.ov)) return;
    const d = await pageDraft(page);
    if (ed.page !== page || ed.show) return;
    const text = d.files[page.file];
    const split = C.splitBlocks(text);
    const b = split.ok ? split.blocks[from] : null;
    if (!b || b.kind !== 'image') return;                  // only an image block moves this way
    const next = C.moveBlock(text, from, to);
    if (next === null || next === text) return;
    ed.draft = d;
    d.files[page.file] = next;
    drafts.put(d);
    Object.assign(ed, { selected: null, sel: null, inPage: null });
    refreshDock();
    frameTo(ed.route, true);
  }

  function blockIndexAt(text, pos) {
    const s = C.splitBlocks(text);
    if (!s.ok) return null;
    const i = s.blocks.findIndex((b) => b.kind !== 'space' && b.end > pos);
    return i < 0 ? null : i;
  }

  /* reload: the frame shows something else (a proposal's overlay): go to
     the draft view with this block selected, instead of telling the old view. */
  async function selectBlock(index, reload) {
    const page = ed.page;
    if (!page || showing() || pageLocked(page)) return;          // the edit gate: nothing is picked on a locked project
    const d = await pageDraft(page);
    if (ed.page !== page || ed.show) return;
    ed.draft = d;
    const text = d.files[page.file];
    const split = C.splitBlocks(text);
    if (!split.ok) {
      // the block model refuses this page: it is edited whole, as Markdown, on the thin editor page
      Object.assign(ed, { wholeReason: split.reason, sel: null, selected: null });
      say(`Block editing is off for this page: ${split.reason}. It opens as Markdown.`);
      await editWholePage();
      return;
    }
    const span = C.spanOf(text, index);
    if (!span) return;
    if (ed.selected !== index) Object.assign(ed, { inPage: null, asMarkdown: null, inPageReason: '' });
    Object.assign(ed, { wholeReason: null, selected: index,
      sel: { key: d.key, file: page.file, span, whole: false } });
    if (reload) frameTo(ed.route, true);
    else postEditor();
    if (canEditPage(page) && imageParts(text.slice(span.start, span.end))) askImage(index);
  }

  async function insertBlock(index, kind) {
    const page = ed.page;
    if (!page || !canEditPage(page) || !Object.prototype.hasOwnProperty.call(C.SNIPPET_CATALOG, kind) || showing()) return;
    const d = await pageDraft(page);
    if (ed.page !== page || ed.show) return;
    const out = C.insertAt(d.files[page.file], index, kind);
    if (!out) return;
    ed.draft = d;
    d.files[page.file] = out.text;
    drafts.put(d);
    Object.assign(ed, { wholeReason: null, selected: blockIndexAt(out.text, out.span.start),
      sel: { key: d.key, file: page.file, span: out.span, whole: false } });
    frameTo(ed.route, true);
    if (kind === 'image' && ed.selected !== null) askImage(ed.selected);     // "+" Image: pick the file now
  }

  /* "Edit whole page as Markdown" (the account menu, U0b; and a page the block model refuses, or a block the
     frame cannot open): the thin editor page at #/edit/<page>, on the page's own draft. */
  async function editWholePage() {
    const page = ed.page;
    if (!ed.on || !page || showing() || pageLocked(page)) return;
    const d = await pageDraft(page);
    if (ed.page !== page || ed.show) return;
    ed.draft = d;
    Object.assign(ed, { selected: null,
      sel: { key: d.key, file: page.file, span: { start: 0, end: d.files[page.file].length }, whole: true } });
    if (ed.pv && ed.pv.ov) frameTo(ed.route, true);    // a proposal was drawn: show the page I edit
    else postEditor();
    ed.trayOpen = true;
    applyTray();
    trayGo(`${DATA_HASH}/${page.pageId}`);
  }





  // ----------------------------------------------------------------- boot ---

  function onMessage(event) {
    const exchange = signIn.handleMessage(event);
    if (exchange) { completeSignIn(exchange); return; }
    if (frameMessage(event)) return;
    for (const entry of state.previews) entry.host.handleMessage(event);
  }

  function mountChrome() {
    frameHost = document.getElementById('hc-frame-host');
    switchBtn = h('button', { type: 'button', class: 'hc-switch', role: 'switch', 'aria-checked': 'false',
      'data-editor-switch': true, title: 'Editor mode: edit this page where it stands' },
    h('span', { class: 'hc-switch-track', 'aria-hidden': 'true' }), h('span', { class: 'hc-switch-label', text: 'Editor' }));
    // U1: off until renderChrome hears GitHub confirmed access (a resume asks /user first; a click before does nothing)
    switchBtn.disabled = state.access !== 'ok';
    switchBtn.addEventListener('click', () => setEditor(!ed.on));
    who = h('span', { class: 'hc-who' });
    avatarBtn = h('button', { type: 'button', class: 'hc-avatar', 'data-action': 'avatar',
      'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'Your account', title: 'Your account' });
    avatarBtn.addEventListener('click', () => { if (menu.hidden) openMenu(); else closeMenu(); });
    const signOut = h('button', { type: 'button', role: 'menuitem', class: 'hc-menu-item', 'data-action': 'sign-out' },
      'Sign out');
    signOut.addEventListener('click', () => { closeMenu(); onSignOutClick(); });
    // U0b (plan D18): the thin editor page's two ways in, while Editor mode is on — the page on screen as Markdown,
    // and the raw data files (U4 may move "Edit whole page" to the page's own toolbar)
    menuWhole = h('button', { type: 'button', role: 'menuitem', class: 'hc-menu-item', 'data-action': 'menu-whole' },
      'Edit whole page as Markdown');
    menuWhole.addEventListener('click', () => { closeMenu(); editWholePage().catch(shown); });
    menuData = h('button', { type: 'button', role: 'menuitem', class: 'hc-menu-item', 'data-action': 'menu-data' }, 'Data files');
    menuData.addEventListener('click', () => {
      closeMenu();
      if (!ed.on) return;
      ed.trayOpen = true;
      applyTray();
      trayGo(DATA_HASH);
    });
    menuWho = h('p', { class: 'hc-menu-who' });
    menu = h('div', { class: 'hc-menu', role: 'menu', 'aria-label': 'Your account' }, menuWho, menuWhole, menuData, signOut);
    menu.hidden = true;
    const escape = (e) => { if (e && e.key === 'Escape') closeMenu(); };
    avatarBtn.addEventListener('keydown', escape);
    menu.addEventListener('keydown', escape);
    // round 2 (R2a, Kyle 2026-10-15): who comes first (photo, name with role, the Proposals link under it), then the switch
    controls = h('span', { class: 'hc-editor-controls' }, who, switchBtn);
    ({ dock, handle } = D.mount(document.body, dockApi()));
    notice = h('p', { class: 'hc-notice', role: 'status' });
    notice.hidden = true;
    // the thin editor page (U0b): its title says which view this is
    trayTitle = h('h2', { class: 'hc-tray-title', text: 'Data files' });
    const close = h('button', { type: 'button', class: 'hc-tray-close', 'data-action': 'tray-close',
      title: 'Back to the page (Escape)' }, 'Back to the page');
    close.addEventListener('click', closeTray);
    main = h('div', { class: 'hc-tray-view' });
    trayBody = h('div', { class: 'hc-tray-body', role: 'tabpanel' }, main);
    trayBody.addEventListener('click', onTrayClick);
    tray = h('section', { id: 'hc-tray', class: 'hc-tray', 'aria-label': 'Editor: the page as Markdown, and the data files' },
      h('div', { class: 'hc-tray-head' }, close, h('div', { class: 'hc-tray-heading' }, trayTitle)),
      trayBody);
    // the editor's one status line lives in the bubble, which is on screen over the page and the editor page alike
    dock.appendChild(notice);
    // Escape leaves the editor page, wherever the focus is (the bubble's button included); a field or menu that
    // uses Escape itself (the account menu, a Markdown box) keeps it
    if (typeof document.addEventListener === 'function') document.addEventListener('keydown', (e) => {
      if (!e || e.key !== 'Escape' || e.defaultPrevented || !ed.on || !ed.trayOpen || (menu && !menu.hidden)) return;
      closeTray();
      if (handle && typeof handle.focus === 'function') handle.focus();
    });
    tray.hidden = true;
    // the bubble's "Proposals" count: the proposals list is gone (U0b), so it follows that list's redirect (the
    // page + the bubble); U3 opens the bubble's review list from it
    handle.addEventListener('click', () => trayGo('#/'));
    document.body.appendChild(tray);
    // U4b: another tab wrote this login's drafts (one storage entry per page): read them again. When it changed
    // THIS page, say so; when it REMOVED this page's draft (proposed or discarded there; U1: sign-out keeps it), this tab
    // drops it too and shows the page as it is, so a deleted draft is never written back.
    window.addEventListener('storage', (e) => {
      const base = draftBound.key;
      if (!e || !base || (e.key !== null && (typeof e.key !== 'string' || e.key.indexOf(`${base}/`) !== 0))) return;
      const open = ed.draft && ed.draft.key ? ed.draft.key : null;
      const mineText = open ? JSON.stringify(ed.draft.files) : null;
      const theirs = open ? C.createDraftStore(localStore(), base).get(open) : null;
      drafts.sync(open && theirs ? [open] : []);
      if (open && !theirs && (e.key === null || e.key === draftStore().entryKey(open))) {
        Object.assign(ed, { draft: null, sel: null, selected: null, inPage: null });
        say('This page\'s unsent changes were removed in another tab (sent for review or discarded there).', 'error');
        if (ed.on) frameTo(ed.route, true);
      } else if (open && theirs && JSON.stringify(theirs.files) !== mineText) {
        say('This page is also being changed in another tab. Each tab keeps its own changes; the tab that saves last wins.', 'error');
      }
      refreshDock();
    });
    // the theme toggle: the open page frame follows at once
    if (typeof window.MutationObserver === 'function') {
      new window.MutationObserver(() => { if (ed.on) postEditor(); })
        .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
    // phones: the tray is a bottom sheet (css/editor.css); the class says so to scripts and tests
    if (typeof window.addEventListener === 'function') window.addEventListener('resize', () => layoutRail());
    const mq = typeof window.matchMedia === 'function' ? window.matchMedia(PHONE_QUERY) : null;
    if (mq) {
      const apply = () => {
        document.body.classList.toggle('hc-phone', Boolean(mq.matches));
        if (rail.data) { closeSheet(); layoutRail(); }
      };
      apply();
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', apply);
    }
  }

  // ------------------------------------------- members-only detail (U4) ---

  /* Plan D-A, D-B, D-B2, D-H. A member (HCCore.membersOnly: Admin,
     Maintainer or Editor, i.e. a role with push) sees, with Editor mode OFF,
     what is never committed under the public surfaces js/lab.js draws:
       the Lab page        the author of each recent commit, and "People
                           committing this year" (count, last active);
       About cards         a GitHub strip: @login, projects and contributions
                           (data/graph/contributors.json), last commit;
       the person popover  commits this year, last active, projects, the
                           five most recent commits;
       who wrote this      per-author counts and date ranges, from the old
                           docs repository's history (across its 2025-03-10
                           folder move) and this repository's.
     lab.js marks each surface (data-hc-surface) and announces it (HCLab.
     onRender); a MutationObserver on #content catches every other repaint.
     A surface is decorated once (data-hc-members-done); every node added
     here carries data-hc-members, and sign-out removes them all. Nothing is
     drawn for a read-only role or under body.hc-editor-on (the frame holds
     no token, and #content is hidden then).

     Every GitHub read goes through readOrg(path), a thin wrapper over
     HCCore.createOrgReader: the paths come from HCCore's builders
     (orgCommitsPath, pageCommitsPath) only; the reader's allowlist is the
     public repositories data/graph/github-repos.json names; it sends the
     member's token, retries ONCE without it on a 403 or 404, and keeps a
     good answer 15 minutes in sessionStorage (dropped at sign-out, and
     when another login signs in over the session). A commits read follows
     pages while they come back full, up to 300 commits; a count that
     reached that shows as "at least N" and the box says so. A
     failure shows its HTTP status ("GitHub answered 403 for
     HippoCampusRobotics/docs — tell Desert Mango"). Every live string is
     set as text; a commit message is its first line, at most 100
     characters, and an e-mail-shaped part of a message or a name is never
     shown. No live avatar is ever loaded: faces are the committed copies. */
  const GH_REPOS_FILE = 'data/graph/github-repos.json';
  const PEOPLE_PUBLIC_FILE = 'data/graph/people-public.json';
  const CONTRIBUTORS_FILE = 'data/graph/contributors.json';
  const PAGE_AUTHORS_FILE = 'data/graph/page-authors.json';
  const MEMBERS_YEAR_REPOS = 12;      // at most this many commits?since= reads for the year view
  const MEMBERS_RECENT = 5;           // recent commits in the popover
  const MEMBERS_MAX_FAILURES = 3;     // more distinct failures than this are summed up per status
  const MEMBERS_PER_PAGE = 100;
  // a read follows page=2, page=3 while a page is full, and stops there: at
  // most 300 commits per repository (year view) or per file history read; a
  // count that reached the cap shows as "at least N" (12 repositories x 3 pages per 15 minutes)
  const MEMBERS_MAX_PAGES = 3;
  const MEMBERS_CAP = MEMBERS_PER_PAGE * MEMBERS_MAX_PAGES;
  const MEMBERS_YEAR_MS = 15 * 60 * 1000;   // the reader's cache life: the year view is read again after it
  // the old docs repository moved every page under contents/ on 2025-03-10 and had
  // renamed raspberry_pi_4b_setup/ the same day (tools/build_github_data.py, OLD_DOCS_*)
  const OLD_DOCS = Object.freeze({ repo: `${C.ORG_OWNER}/docs`, moved: 'contents/', until: '2025-03-11T00:00:00Z',
    renames: Object.freeze({ 'raspberry_pi_setup/': Object.freeze(['raspberry_pi_4b_setup/']) }) });
  const GH_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
  const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/;
  const PROJECT_ID_SAFE_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
  const EMAIL_SHAPED_RE = /[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+/g;
  const MEMBERS_NOTE = 'Members only: read live from GitHub with your sign-in, kept 15 minutes in this tab, never stored.';
  const mem = {
    gen: -1,              // the session generation the reader and the year view belong to
    reader: null,         // Promise<HCCore org reader>
    year: null,           // Promise<the year view>
    yearAt: 0,            // when it was read
    files: new Map(),     // public data file -> Promise<parsed | null>
    nodes: new Set(),     // every node drawn here (data-hc-members), removed at sign-out
    done: new Set(),      // every surface marked data-hc-members-done
    observer: null,
    timer: null,
  };

  const isPlain = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  const textOf = (v) => (typeof v === 'string' ? v : '');
  const countOf = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  // a count from a read that hit the page cap is a floor: there may be no next commit, so never "N+"
  const commitsWord = (n, capped) => (capped ? `at least ${n} commit${n === 1 ? '' : 's'}`
    : `${n} commit${n === 1 ? '' : 's'}`);
  const ownKey = (o, k) => isPlain(o) && Object.prototype.hasOwnProperty.call(o, k);
  const unmailed = (s) => textOf(s).replace(EMAIL_SHAPED_RE, '[e-mail]');

  function dataFile(p) {
    // the project registry is read merged (the index + each project's facts file, 2026-10-14): names live in the facts
    const read = p === 'data/projects.json' && typeof HC.fetchProjects === 'function' ? () => HC.fetchProjects() : () => HC.fetchJSON(p);
    if (!mem.files.has(p)) mem.files.set(p, Promise.resolve().then(read).catch(() => null));
    return mem.files.get(p);
  }

  function membersOn() {
    return Boolean(state.session) && state.access === 'ok' && C.membersOnly(state.role)
      && !ed.on && !document.body.classList.contains('hc-editor-on');
  }

  // github-repos.json's public entries (an object keyed by name, or a list); every key guarded
  function publicRepos(doc) {
    const repos = isPlain(doc) ? doc.repos : null;
    const list = Array.isArray(repos) ? repos : (isPlain(repos) ? Object.keys(repos).map((k) => repos[k]) : []);
    return list.filter((r) => isPlain(r) && typeof r.name === 'string' && r.private === false);
  }

  // the reader and the year view belong to one session generation
  function memberGen() {
    const gen = sessionGen.current();
    if (mem.gen !== gen) Object.assign(mem, { gen, reader: null, year: null });
    return gen;
  }

  /* The reader's sessionStorage, for one session generation: an answer that
     lands after a refresh, a sign-in over this session or a sign-out is not
     kept (it was read with the old token, for the old person). */
  function orgStore(gen) {
    const st = store();
    if (!st) return null;
    return {
      getItem: (k) => st.getItem(k),
      setItem: (k, v) => { if (sessionGen.isCurrent(gen) && state.session) st.setItem(k, v); },
      removeItem: (k) => st.removeItem(k),
    };
  }

  function orgReader() {
    const gen = memberGen();
    if (!mem.reader) {
      const token = state.session.token;
      mem.reader = dataFile(GH_REPOS_FILE).then((doc) =>
        C.createOrgReader(token, netFetch, orgStore(gen), publicRepos(doc).map((r) => r.name)));
    }
    return mem.reader;
  }

  /* THE one way this file reads GitHub outside this repository's client
     (D-A): HCCore.createOrgReader's get. -> {ok, status, data, refused?};
     an answer for an ended or replaced session is dropped (STALE). */
  async function readOrg(apiPath) {
    if (!state.session) throw new Error('signed out');
    const gen = memberGen();
    const reader = await orgReader();
    const r = await reader.get(apiPath);
    if (!sessionGen.isCurrent(gen) || !state.session) throw new Error(STALE);
    return r;
  }

  // a path from a builder (a bad name or path throws there: refused, never fetched)
  async function readOrgAs(build, label) {
    let p = null;
    try { p = build(); } catch (e) { return { ok: false, status: 403, data: null, refused: true, label }; }
    return Object.assign({}, await readOrg(p), { label });
  }

  /* One commits read, page by page: build(page) -> a builder path (page 1
     without page=, the cache key it always had). The next page is read only
     while a page comes back full, and never past MEMBERS_MAX_PAGES; a failure
     on any page is the read's answer (never counts from half a history).
     A page counts at most MEMBERS_PER_PAGE rows (more cannot inflate a
     count), and a commit seen on an earlier page is not kept again (page 1
     may come from the 15-minute cache while page 2 is fresh, so rows slide
     across a page edge). -> readOrgAs's answer, data: every page's rows,
     each sha once, capped: the last page read was still full. */
  async function readPagesAs(build, label) {
    const data = [];
    const seen = new Set();
    for (let page = 1; page <= MEMBERS_MAX_PAGES; page += 1) {
      const r = await readOrgAs(() => build(page > 1 ? page : undefined), label);
      if (!r.ok) return r;
      const list = (Array.isArray(r.data) ? r.data : []).slice(0, MEMBERS_PER_PAGE);
      list.forEach((c) => {
        const sha = isPlain(c) && typeof c.sha === 'string' ? c.sha : null;
        if (sha !== null && seen.has(sha)) return;
        if (sha !== null) seen.add(sha);
        data.push(c);
      });
      if (list.length < MEMBERS_PER_PAGE) return Object.assign({}, r, { data, capped: false });
    }
    return { ok: true, status: 200, data, capped: true, label };
  }

  function cappedLine(text) {
    return h('p', { class: 'hc-m-note hc-m-capped', text });
  }
  const yearCappedText = (labels) => `Only the newest ${MEMBERS_CAP} commits were read for ${labels.join(', ')}: `
    + 'a count that says "at least" may be higher, and older commits there are not counted.';

  function failureLines(list) {
    const seen = new Map();
    list.forEach((f) => {
      const key = `${f.refused ? 'refused' : f.status} ${f.label}`;
      if (!seen.has(key)) seen.set(key, f);
    });
    const text = (f, more) => {
      const what = more ? `${f.label} and ${more} more ${more === 1 ? 'repository' : 'repositories'}` : f.label;
      if (f.refused) return `Not read: ${what} ${more ? 'are' : 'is'} not in the committed repository list (${GH_REPOS_FILE}).`;
      return f.status ? `GitHub answered ${f.status} for ${what} — tell Desert Mango`
        : `GitHub could not be reached for ${what} — tell Desert Mango`;
    };
    const all = [...seen.values()];
    let lines;
    if (all.length <= MEMBERS_MAX_FAILURES) {
      lines = all.map((f) => text(f, 0));
    } else {
      const byStatus = new Map();
      all.forEach((f) => {
        const k = f.refused ? 'refused' : String(f.status);
        byStatus.set(k, (byStatus.get(k) || []).concat(f));
      });
      lines = [...byStatus.values()].map((fs) => text(fs[0], fs.length - 1));
    }
    return lines.map((t) => h('p', { class: 'hc-m-error', text: t }));
  }

  // one commit of GitHub's commits list, reduced to what is shown; null when malformed
  function commitRow(c, repo) {
    if (!isPlain(c) || typeof c.sha !== 'string' || !COMMIT_SHA_RE.test(c.sha) || !isPlain(c.commit)) return null;
    const a = isPlain(c.commit.author) ? c.commit.author : {};
    const t = Date.parse(textOf(a.date));
    if (!Number.isFinite(t)) return null;
    const login = isPlain(c.author) && typeof c.author.login === 'string' && GH_LOGIN_RE.test(c.author.login)
      ? c.author.login : null;
    return {
      repo,
      sha: c.sha.slice(0, 7),
      date: new Date(t).toISOString(),
      login,
      name: unmailed(textOf(a.name).trim()).slice(0, 100),
      msg: unmailed(textOf(c.commit.message).split('\n')[0].trim()).slice(0, 100),
    };
  }

  // people-public.json: login -> the display name GitHub publishes
  function displayNames(doc) {
    const out = Object.create(null);
    const people = isPlain(doc) && isPlain(doc.people) ? doc.people : {};
    Object.keys(people).forEach((k) => {
      const p = people[k];
      if (isPlain(p) && typeof p.login === 'string' && GH_LOGIN_RE.test(p.login) && typeof p.name === 'string' && p.name.trim()) {
        out[p.login] = p.name.trim().slice(0, 100);
      }
    });
    return out;
  }
  const authorName = (r, names) => (r.login && names[r.login]) || r.name || r.login || 'unknown';

  // rows -> one entry per author (login, else git name), most commits first
  function tally(rows, names) {
    const out = new Map();
    const seen = new Set();
    rows.forEach((r) => {
      const id = `${r.repo}/${r.sha}`;
      if (seen.has(id)) return;
      seen.add(id);
      const key = r.login ? `@${r.login}` : `=${r.name}`;
      let p = out.get(key);
      if (!p) {
        p = { login: r.login, name: authorName(r, names), count: 0, first: r.date, last: r.date, recent: [], capped: false };
        out.set(key, p);
      }
      p.count += 1;
      if (r.capped) p.capped = true;     // a row from a read that hit the page cap
      if (r.date < p.first) p.first = r.date;
      if (r.date > p.last) p.last = r.date;
      p.recent.push(r);
    });
    const list = [...out.values()];
    list.forEach((p) => {
      p.recent.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      p.recent = p.recent.slice(0, MEMBERS_RECENT);
    });
    return list.sort((a, b) => (b.count - a.count) || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0)
      || a.name.localeCompare(b.name));
  }

  // GitHub's since= for the last 365 days, at day precision (one cache key per day)
  const windowStart = (now) => `${new Date(now - 365 * 864e5).toISOString().slice(0, 10)}T00:00:00Z`;

  // the non-fork public repositories pushed inside the window, busiest first, at most 12
  function yearRepos(doc, since) {
    const dayFrom = since.slice(0, 10);
    return publicRepos(doc)
      .filter((r) => r.fork !== true && textOf(r.pushed_at).slice(0, 10) >= dayFrom)
      .sort((a, b) => (countOf(b.commits_365d) - countOf(a.commits_365d))
        || textOf(b.pushed_at).localeCompare(textOf(a.pushed_at)) || a.name.localeCompare(b.name))
      .slice(0, MEMBERS_YEAR_REPOS)
      .map((r) => r.name);
  }

  /* The year view, once per session (each read cached 15 minutes by the reader):
     {people: [tally], byLogin, bySha: 'repo/sha7' -> row, names, faces, failures,
     capped: ['owner/repo' whose newest 300 commits were all read, and more exist]};
     read again once the reader's 15 minutes are over. */
  function yearView() {
    memberGen();
    const now = Date.now();
    if (!mem.year || !(now - mem.yearAt >= 0 && now - mem.yearAt < MEMBERS_YEAR_MS)) {
      mem.yearAt = now;
      mem.year = (async () => {
        const since = windowStart(now);
        const [repos, pub] = await Promise.all([dataFile(GH_REPOS_FILE), dataFile(PEOPLE_PUBLIC_FILE)]);
        const reads = await Promise.all(yearRepos(repos, since).map((name) =>
          readPagesAs((page) => C.orgCommitsPath(name, { since, per_page: MEMBERS_PER_PAGE, page }), `${C.ORG_OWNER}/${name}`)
            .then((r) => ({ name, r }))));
        const names = displayNames(pub);
        const rows = [];
        const failures = [];
        const capped = [];
        reads.forEach(({ name, r }) => {
          if (!r.ok) { failures.push(r); return; }
          if (r.capped) capped.push(`${C.ORG_OWNER}/${name}`);
          (Array.isArray(r.data) ? r.data : []).forEach((c) => {
            const row = commitRow(c, name);
            if (row && row.date >= since) rows.push(Object.assign(row, { capped: r.capped }));
          });
        });
        const people = tally(rows, names);
        return {
          people,
          byLogin: new Map(people.filter((p) => p.login).map((p) => [p.login, p])),
          bySha: new Map(rows.map((r) => [`${r.repo}/${r.sha}`, r])),
          names,
          faces: avatarMap(pub),
          failures,
          capped,
        };
      })();
    }
    return mem.year;
  }

  // contributors.json (public): the projects a login contributed to, and the sum
  function contributionsOf(doc, login) {
    const projects = isPlain(doc) && isPlain(doc.projects) ? doc.projects : {};
    const ids = [];
    let total = 0;
    Object.keys(projects).forEach((id) => {
      const list = isPlain(projects[id]) && Array.isArray(projects[id].contributors) ? projects[id].contributors : [];
      const me = list.find((x) => isPlain(x) && x.login === login);
      if (!me) return;
      ids.push(id);
      total += countOf(me.contributions);
    });
    return { ids, total };
  }

  // data/projects.json: id -> name
  function projectNames(doc) {
    const out = new Map();
    (isPlain(doc) && Array.isArray(doc.projects) ? doc.projects : []).forEach((p) => {
      if (isPlain(p) && typeof p.id === 'string' && PROJECT_ID_SAFE_RE.test(p.id)) {
        out.set(p.id, typeof p.name === 'string' && p.name.trim() ? p.name.trim() : p.id);
      }
    });
    return out;
  }

  function face(login, name, faces) {
    const src = login ? faces[login] : undefined;
    if (src) return h('img', { class: 'hc-avatar md', src, alt: '', loading: 'lazy' });
    return h('span', { class: 'hc-avatar md hc-avatar-empty', 'aria-hidden': 'true',
      text: (Array.from(name.trim())[0] || '?').toUpperCase() });
  }

  /* Draw only while it is still this session, still a member, Editor still off
     and the surface still in the page; Editor on meanwhile: try again later. */
  function drawIf(el, gen, draw) {
    if (!sessionGen.isCurrent(gen) || !state.session) return;
    if (!membersOn()) { el.removeAttribute('data-hc-members-done'); mem.done.delete(el); return; }
    if ('isConnected' in el && !el.isConnected) return;
    draw();
  }

  // ---- the Lab page: authors on recent commits, "People committing this year"
  async function decorateLab(root, gen) {
    const v = await yearView();
    drawIf(root, gen, () => {
      root.querySelectorAll('[data-hc-sha]').forEach((row) => {
        const hit = v.bySha.get(`${row.getAttribute('data-hc-repo')}/${row.getAttribute('data-hc-sha')}`);
        if (!hit) return;
        (row.querySelector('.s') || row).appendChild(kept(h('span', { class: 'hc-m-author', 'data-hc-members': true,
          text: authorName(hit, v.names) })));
      });
      const slot = root.querySelector('[data-hc-slot="lab-people"]');
      if (!slot) return;
      const rows = v.people.map((p) => h(p.login ? 'button' : 'div',
        { class: 'hc-m-row', type: p.login ? 'button' : null, 'data-hc-login': p.login },
        face(p.login, p.name, v.faces),
        h('span', { class: 'who' }, h('span', { class: 'nm', text: p.name }),
          p.login ? h('span', { class: 'sub', text: `@${p.login}` }) : null),
        h('span', { class: 'cnt', text: commitsWord(p.count, p.capped) }),
        h('span', { class: 'last', text: `last active ${day(p.last)}` })));
      slot.insertBefore(kept(h('section', { class: 'hc-m-people', 'data-hc-members': true },
        h('h3', { text: 'People committing this year' }),
        ...rows,
        rows.length || v.failures.length ? null : h('p', { class: 'hc-empty', text: 'No commits read for the last 365 days.' }),
        v.capped.length ? cappedLine(yearCappedText(v.capped)) : null,
        ...failureLines(v.failures),
        h('p', { class: 'hc-m-note', text: MEMBERS_NOTE }))), slot.firstChild);
    });
  }

  // ---- About: the GitHub strip on every roster card with a login
  async function decoratePeople(root, gen) {
    const lab = window.HCLab;
    if (!lab || typeof lab.buildPeopleIndex !== 'function') return;
    const [v, pub, roster, contrib] = await Promise.all([yearView(), dataFile(PEOPLE_PUBLIC_FILE),
      dataFile('data/people.json'), dataFile(CONTRIBUTORS_FILE)]);
    const idx = lab.buildPeopleIndex(pub, roster);
    drawIf(root, gen, () => {
      let any = false;
      root.querySelectorAll('.person-card').forEach((card) => {
        const nameEl = card.querySelector('.person-name');
        const name = nameEl ? nameEl.textContent.trim() : '';
        const login = name && idx && idx.loginByRoster ? idx.loginByRoster.get(name) : null;
        if (!login || !GH_LOGIN_RE.test(login) || card.querySelector('.hc-gh-strip')) return;
        const c = contributionsOf(contrib, login);
        const p = v.byLogin.get(login);
        let last = 'no commits in the last year';
        if (p) last = `last commit ${day(p.last)}`;
        else if (v.failures.length) last = 'last commit not read';
        card.appendChild(kept(h('span', { class: 'hc-gh-strip', 'data-hc-members': true },
          h('span', { class: 'l', text: `@${login}` }),
          h('span', { class: 'f', text: `${c.ids.length} project${c.ids.length === 1 ? '' : 's'} · `
            + `${c.total} contribution${c.total === 1 ? '' : 's'}` }),
          h('span', { class: p ? 'last' : 'last stale', text: last }))));
        any = true;
      });
      if (any && v.failures.length) {
        root.appendChild(kept(h('div', { class: 'hc-m-failures', 'data-hc-members': true }, ...failureLines(v.failures))));
      }
    });
  }

  // ---- the popover: this year, projects, recent commits
  async function decoratePopover(box, gen) {
    const login = box.getAttribute('data-hc-login');
    if (!login || !GH_LOGIN_RE.test(login)) return;
    const [v, contrib, projects] = await Promise.all([yearView(), dataFile(CONTRIBUTORS_FILE), dataFile('data/projects.json')]);
    drawIf(box, gen, () => {
      const p = v.byLogin.get(login);
      const c = contributionsOf(contrib, login);
      const known = projectNames(projects);
      let facts = 'No commits in the last year.';
      if (p) facts = `${commitsWord(p.count, p.capped)} this year · last active ${day(p.last)}`;
      else if (v.failures.length) facts = 'This year\'s commits could not be read.';
      const links = [];
      c.ids.filter((id) => known.has(id)).forEach((id, i) => {
        if (i) links.push(', ');
        links.push(h('a', { href: `#/projects/${id}`, text: known.get(id) }));
      });
      box.appendChild(kept(h('div', { class: 'hc-pp-members', 'data-hc-members': true },
        h('p', { class: 'hc-m-facts', text: facts }),
        links.length ? h('p', { class: 'hc-m-projects' }, 'Projects: ', ...links) : null,
        p && p.recent.length ? h('ul', { class: 'hc-m-commits', 'aria-label': 'Recent commits' },
          ...p.recent.map((r) => h('li', { class: 'hc-m-commit' }, h('span', { class: 'm', text: r.msg }),
            h('span', { class: 's', text: `${r.repo} · ${day(r.date)} · ${r.sha}` })))) : null,
        v.capped.length ? cappedLine(yearCappedText(v.capped)) : null,
        ...failureLines(v.failures),
        h('p', { class: 'hc-m-note', text: 'Members only.' }))));
    });
  }

  // ---- who wrote this: per-author counts and date ranges
  function contentFileOf(pageId) {
    if (pageId === 'about') return 'content/about.md';
    const m = /^(setup|projects|tools)\/([A-Za-z0-9_/-]+)$/.exec(pageId);
    return m ? `content/${m[1]}/${m[2]}.md` : null;
  }

  // the reads behind one "who wrote this" box: [{label, where, repo, reads: [build(page)], skip?}]
  function authorReads(pageId, entry) {
    const out = [];
    const orig = isPlain(entry) && isPlain(entry.original) ? entry.original : null;
    const repo = orig ? textOf(orig.repo) : '';
    const file = orig ? textOf(orig.path) : '';
    const here = contentFileOf(pageId);
    const org = new RegExp(`^${C.ORG_OWNER}/([A-Za-z0-9._-]+)$`).exec(repo);
    if (org && file) {
      const name = org[1];
      const reads = [(page) => C.orgCommitsPath(name, { path: file, per_page: MEMBERS_PER_PAGE, page })];
      if (repo === OLD_DOCS.repo && file.indexOf(OLD_DOCS.moved) === 0) {
        const pre = file.slice(OLD_DOCS.moved.length);
        const older = [pre];
        Object.keys(OLD_DOCS.renames).forEach((prefix) => {
          if (pre.indexOf(prefix) === 0) OLD_DOCS.renames[prefix].forEach((o) => older.push(o + pre.slice(prefix.length)));
        });
        older.forEach((p) => reads.push((page) => C.orgCommitsPath(name,
          { path: p, until: OLD_DOCS.until, per_page: MEMBERS_PER_PAGE, page })));
      }
      out.push({ label: `Original, in ${repo}`, where: repo, repo: name, reads });
    } else if (repo === C.REPO_FULL && file && file !== here) {
      out.push({ label: 'Original, on this site', where: C.REPO_FULL, repo: C.REPO_NAME,
        reads: [(page) => C.pageCommitsPath(file, { per_page: MEMBERS_PER_PAGE, page })] });
    } else if (repo && repo !== C.REPO_FULL) {
      out.push({ label: `Original, in ${repo.slice(0, 100)}`, skip: `Not read: ${repo.slice(0, 100)} is not a ${C.ORG_OWNER} repository.` });
    }
    if (here) {
      out.push({ label: 'On this site', where: C.REPO_FULL, repo: C.REPO_NAME,
        reads: [(page) => C.pageCommitsPath(here, { per_page: MEMBERS_PER_PAGE, page })] });
    }
    return out;
  }

  async function decorateAuthors(box, gen) {
    const pageId = box.getAttribute('data-hc-page') || '';
    const [doc, pub] = await Promise.all([dataFile(PAGE_AUTHORS_FILE), dataFile(PEOPLE_PUBLIC_FILE)]);
    const pages = isPlain(doc) && isPlain(doc.pages) ? doc.pages : null;
    const entry = ownKey(pages, pageId) && isPlain(pages[pageId]) ? pages[pageId] : null;
    const groups = authorReads(pageId, entry);
    const results = await Promise.all(groups.map(async (g) => ({
      g, rs: g.skip ? [] : await Promise.all(g.reads.map((build) => readPagesAs(build, g.where))) })));
    const names = displayNames(pub);
    drawIf(box, gen, () => {
      const lines = [];
      const notes = [];
      const failures = [];
      let anyCapped = false;
      results.forEach(({ g, rs }) => {
        if (g.skip) { notes.push(h('p', { class: 'hc-m-error', text: g.skip })); return; }
        const bad = rs.filter((r) => !r.ok);
        if (bad.length) { failures.push(...bad); return; }     // never counts from half a history
        const rows = [];
        rs.forEach((r) => (Array.isArray(r.data) ? r.data : []).forEach((c) => {
          const row = commitRow(c, g.repo);
          if (row) rows.push(Object.assign(row, { capped: r.capped }));
        }));
        if (rs.some((r) => r.capped)) anyCapped = true;
        const people = tally(rows, names).map((p) => {
          const range = day(p.first) === day(p.last) ? day(p.first) : `${day(p.first)} to ${day(p.last)}`;
          return `${p.name} — ${commitsWord(p.count, p.capped)}, ${range}`;
        });
        lines.push(h('p', { class: 'hc-m-line', text: `${g.label}: ${people.length ? people.join('; ') : 'no commits found'}.` }));
      });
      if (!lines.length && !notes.length && !failures.length) return;
      const node = kept(h('div', { class: 'hc-m-authors', 'data-hc-members': true },
        h('p', { class: 'hc-m-label', text: 'Members only — commits per author, read live from git history' }),
        ...lines,
        anyCapped ? cappedLine(`Only the newest ${MEMBERS_CAP} commits of a file's history were read: `
          + 'a count that says "at least" may be higher.') : null,
        ...notes, ...failureLines(failures)));
      const note = box.querySelector('.hc-authors-note');
      if (note) box.insertBefore(node, note); else box.appendChild(node);
    });
  }

  // ---- a project page: edit access at the top of the aside box (edit access, Kyle, 2026-10-19)
  /* Shown to ANY signed-in session with Editor off (read-only too: accessOn), not only to members. What
     you can do on this project is HCCore.accessFor over MAIN's data/graph/edit-access.json (accessRegistry);
     nothing here works the rule out. "Request edit access" is one proposal changing only data/projects.json
     (a Write role), or a prefilled GitHub issue (read-only). An admin also gets Remove per person and Add
     person, each one proposal. Every string from the file is set as text. */
  function accessOn() {
    return Boolean(state.session) && state.access === 'ok' && !ed.on && !document.body.classList.contains('hc-editor-on');
  }
  function drawIfAccess(el, gen, draw) {
    if (!sessionGen.isCurrent(gen) || !state.session) return;
    if (!accessOn()) { el.removeAttribute('data-hc-members-done'); mem.done.delete(el); return; }
    if ('isConnected' in el && !el.isConnected) return;
    draw();
  }

  async function projectNameOf(id) {
    const doc = await dataFile('data/projects.json');
    const p = isPlain(doc) && Array.isArray(doc.projects) ? doc.projects.find((x) => isPlain(x) && x.id === id) : null;
    return p && typeof p.name === 'string' && p.name.trim() ? p.name.trim() : id;
  }

  const ACCESS_ALREADY_TEXT = 'This change is already open as a proposal.';
  const ACCESS_BUSY_TEXT = 'Another proposal is being sent — wait a moment.';
  /* One access proposal: main's data/projects.json at main's sha now, the one change, one new branch. */
  async function sendAccessProposal(o, ui) {
    const show = (text, ok) => {
      ui.result.replaceChildren(...[].concat(text));
      ui.result.hidden = false;
      ui.result.classList.toggle('is-error', !ok);
    };
    const key = `${o.op}:${String(o.login).toLowerCase()}`;
    if (!state.client) return;
    // each change once from this box (it is open now), and one proposal at a time: say so, send nothing
    if (ui.sent.has(key)) { show(ACCESS_ALREADY_TEXT, true); return; }
    if (proposing) { show(ACCESS_BUSY_TEXT, true); return; }
    proposing = true;
    ui.buttons.forEach((b) => { b.disabled = true; });
    const gen = sessionGen.current();
    let out;
    try {
      const sha = await C.resolveRef(state.client, 'main');
      const answer = await sessionCache().get(sha, 'data/projects.json');
      if (!answer || !answer.ok) throw new Error('data/projects.json could not be read from main');
      const draft = C.accessRequestDraft(answer.text, o.projectId, o.login, o.op);
      out = draft.problem ? { ok: false, status: 0, message: `Nothing was sent: ${draft.problem}.` }
        : await C.runPropose(state.client, {
          login: sessionLogin(), summary: C.accessProposalTitle(o), now: Date.now(), origin: window.location.origin, target: null,
          changes: [{ path: 'data/projects.json', text: draft.text, original: answer.text, baseSha: sha }],
          pages: [{ label: `Edit access: ${o.name}`, file: 'data/projects.json' }],
        });
    } catch (e) {
      if (quiet(e)) { proposing = false; return; }
      out = { ok: false, status: 0, message: `Nothing was sent: ${(e && e.message) || e}.` };
    } finally {
      proposing = false;
    }
    if (!sessionGen.isCurrent(gen)) return;
    if (out.status === 401) { endSession(out.message); return; }
    const free = (b) => !ui.sent.has(ui.keys.get(b));
    if (!out.ok) { ui.buttons.forEach((b) => { b.disabled = !free(b); }); show(out.message, false); return; }
    ui.sent.add(key);
    ui.buttons.forEach((b) => { b.disabled = !free(b); });
    forgetProposals();
    show([`${out.message} `, link(`${C.GITHUB_WEB}/pull/${out.number}`, `Open #${out.number} on GitHub`)], true);
  }

  /* "Request edit access" to one project, or null when there is nothing to ask (a can, or no login): one
     proposal for a Write role, else a prefilled GitHub issue. The one implementation, for the project box and
     the Editor dock. o: {projectId, name, login}; ui: sendAccessProposal's {result, buttons, sent, keys}. */
  function accessAsk(a, o, ui) {
    if (!a || a.can || !GH_LOGIN_RE.test(o.login)) return null;
    const canPush = Boolean(state.role) && state.role.canPush === true;
    if (canPush && a.why !== 'no-write') {
      const ask = h('button', { type: 'button', class: 'cms-btn cms-btn-primary', 'data-action': 'access-request' }, C.ACCESS_REQUEST_LABEL);
      ask.addEventListener('click', () => sendAccessProposal({ projectId: o.projectId, name: o.name, kind: 'request', op: 'add', login: o.login }, ui));
      ui.buttons.push(ask);
      ui.keys.set(ask, `add:${o.login.toLowerCase()}`);
      return ask;
    }
    const ask = link(C.accessIssueUrl({ login: o.login, projectId: o.projectId, name: o.name }), C.ACCESS_REQUEST_LABEL, 'cms-btn');
    ask.setAttribute('data-action', 'access-issue');
    return ask;
  }
  const accessUi = (result) => ({ result, buttons: [], sent: new Set(), keys: new Map() });   // keys: a button -> the one change it sends

  async function decorateProjectAccess(box, gen) {
    const id = box.getAttribute('data-hc-project') || '';
    if (!PROJECT_ID_SAFE_RE.test(id)) return;
    const [doc, name] = await Promise.all([accessRegistry(), projectNameOf(id)]);
    drawIfAccess(box, gen, () => {
      if (box.querySelector('.hc-access')) return;
      const login = sessionLogin();
      const a = C.accessFor(doc, id, login, state.role);
      const unread = !doc && a.why !== 'site-wide';
      const result = h('p', { class: 'hc-access-result cms-action-result', role: 'status' });
      result.hidden = true;
      const ui = accessUi(result);
      const buttons = ui.buttons;
      const say = (text) => { result.textContent = text; result.hidden = false; result.classList.toggle('is-error', true); };
      const propose = (o) => sendAccessProposal(Object.assign({ projectId: id, name }, o), ui);
      const ask = unread ? null : accessAsk(a, { projectId: id, name, login }, ui);
      const admin = Boolean(state.role) && state.role.key === 'admin' && state.role.canPush === true;
      const rows = C.accessEditors(doc, id).map((e) => {
        let remove = null;
        if (admin) {
          remove = h('button', { type: 'button', class: 'cms-btn hc-access-remove', 'data-action': 'access-remove',
            'aria-label': `Remove ${e.login} from ${name}` }, 'Remove');
          remove.addEventListener('click', () => propose({ kind: 'change', op: 'remove', login: e.login }));
          buttons.push(remove);
          ui.keys.set(remove, `remove:${e.login.toLowerCase()}`);
        }
        return h('li', { class: 'hc-access-row' }, h('span', { class: 'hc-access-login', text: e.login }),
          h('span', { class: 'hc-access-chip', text: e.chip }), remove);
      });
      let addForm = null;
      if (admin) {
        const input = h('input', { type: 'text', 'data-field': 'access-login', class: 'hc-access-input', autocomplete: 'off',
          spellcheck: 'false', placeholder: 'GitHub login', 'aria-label': `GitHub login to add to ${name}` });
        const add = h('button', { type: 'button', class: 'cms-btn', 'data-action': 'access-add' }, 'Add person');
        add.addEventListener('click', () => {
          const who = String(input.value || '').trim();
          if (!GH_LOGIN_RE.test(who)) { say(`'${who.slice(0, 60)}' is not a GitHub login.`); return; }
          propose({ kind: 'change', op: 'add', login: who });
        });
        buttons.push(add);
        addForm = h('div', { class: 'hc-access-add' }, input, add);
      }
      box.insertBefore(kept(h('section', { class: 'hc-access', 'data-hc-access': true, 'aria-label': 'Edit access' },
        h('p', { class: 'hc-access-text', text: unread ? C.ACCESS_UNREAD_TEXT : a.text }),
        ask,
        unread ? null : h('div', { class: 'hc-access-who' },
          h('p', { class: 'hc-access-who-label', text: C.ACCESS_SECTION_LABEL }),
          rows.length ? h('ul', { class: 'hc-access-list' }, ...rows) : null,
          h('p', { class: 'hc-access-sitewide', text: C.ACCESS_SITE_WIDE_TEXT }),
          addForm),
        result)), box.firstChild);
    });
  }

  const MEMBER_SURFACES = Object.freeze({ lab: decorateLab, people: decoratePeople, popover: decoratePopover,
    authors: decorateAuthors });
  // drawn for every signed-in session (read-only too), not only members
  const SESSION_SURFACES = Object.freeze({ 'project-access': decorateProjectAccess });

  /* Decorate every marked surface not yet done: the members-only ones only when membersOn(), the
     session ones (SESSION_SURFACES) when accessOn(). A page-local extra: it never breaks the Editor. */
  function membersSweep() {
    clearTimeout(mem.timer);
    mem.timer = null;
    if (!accessOn()) return;
    const members = membersOn();
    let found = [];
    try { found = Array.from(document.querySelectorAll('[data-hc-surface]')); } catch (e) { found = []; }
    found.forEach((el) => {
      const kind = el.getAttribute('data-hc-surface');
      const decorate = ownKey(SESSION_SURFACES, kind) ? SESSION_SURFACES[kind] : (members && ownKey(MEMBER_SURFACES, kind) ? MEMBER_SURFACES[kind] : null);
      if (typeof decorate !== 'function' || el.hasAttribute('data-hc-members-done')) return;
      el.setAttribute('data-hc-members-done', '');
      mem.done.add(el);
      const gen = sessionGen.current();
      Promise.resolve().then(() => decorate(el, gen)).catch((e) => {
        if (quiet(e)) return;
        try { console.info(`Members-only detail skipped — ${(e && e.message) || e}`); } catch (err) { /* ignore */ }
      });
    });
  }
  function membersSoon() {
    clearTimeout(mem.timer);
    mem.timer = setTimeout(membersSweep, 40);
  }

  /* Sign-out, or another session: every members node goes (the reader's
     cache went with HCCore.clearSession). */
  function membersClear() {
    clearTimeout(mem.timer);
    mem.timer = null;
    Object.assign(mem, { gen: -1, reader: null, year: null });
    mem.nodes.forEach((n) => n.remove());
    mem.done.forEach((el) => el.removeAttribute('data-hc-members-done'));
    mem.nodes.clear();
    mem.done.clear();
  }

  // a members node: marked, and kept to be removed at sign-out
  function kept(node) {
    mem.nodes.add(node);
    return node;
  }

  // lab.js announces its surfaces; the observer sees every other repaint of #content
  function membersMount() {
    if (window.HCLab && typeof window.HCLab.onRender === 'function') window.HCLab.onRender(() => membersSoon());
    const content = document.getElementById('content');
    if (content && typeof window.MutationObserver === 'function') {
      mem.observer = new window.MutationObserver(() => membersSoon());
      mem.observer.observe(content, { childList: true, subtree: true });
    }
  }

  let started = false;
  let channel = null;      // U1: BroadcastChannel('hc-session'), HCCore.sessionChannel

  /* Boot once, for a session (sessionStorage's, or opts.session held in
     memory only), or for the sign-in click: opts.popup is the window
     js/app.js opened inside it, and the sign-in adopts it. opts.status /
     opts.onSession are js/app.js's footer line and its signed-in hook.
     A later call with a popup (the click again, still signed out) signs in
     with that window. -> true when it booted or signs in. */
  function start(opts) {
    const o = opts || {};
    if (typeof o.status === 'function') tellFn = o.status;
    if (typeof o.onSession === 'function') sessionFn = o.onSession;
    const popup = o.popup && typeof o.popup === 'object' ? o.popup : null;
    const closePopup = () => { try { popup.close(); } catch (e) { /* already gone */ } };
    if (started) {
      if (!popup) return false;
      if (state.session) closePopup();
      else onSignInClick(popup);
      return true;
    }
    const given = o.session && typeof o.session === 'object' && typeof o.session.token === 'string'
      && typeof o.session.login === 'string' ? o.session : null;
    const stored = C.readSession(store(), Date.now());
    // U1: js/app.js's resume from the session cookie, {token, expiresIn}
    const resumed = !given && o.resumed && typeof o.resumed === 'object' && typeof o.resumed.token === 'string'
      && o.resumed.token ? { token: o.resumed.token,
        expiresIn: Number.isFinite(o.resumed.expiresIn) ? o.resumed.expiresIn : null } : null;
    if (!given && !stored && !popup && !resumed) return false;
    const restored = given || stored;
    legacyOwner = restored && typeof restored.login === 'string' ? restored.login : null;
    started = true;
    if (typeof o.fetch === 'function') fetchImpl = o.fetch;
    if (given) state.memoryOnly = given;
    mountChrome();
    membersMount();
    loadAvatars();
    window.addEventListener('message', onMessage);
    window.addEventListener('hashchange', onHashChange);
    // U1: a sign-out in another tab signs this one out too. A message with an fp (another
    // tab's token was refused by GitHub) counts only when this tab holds that same token:
    // a tab with a newer sign-in keeps it.
    channel = C.sessionChannel(window, (fp) => {
      const held = state.session || state.memoryOnly;
      if (!held) return;
      if (fp === null) {
        signIn.cancel();
        endSession(null, { elsewhere: true });
        tell('Signed out in another tab.');
        return;
      }
      C.tokenHash(held.token, webSubtle()).then((hash) => {
        const now = state.session || state.memoryOnly;
        if (!hash || hash.slice(0, 16) !== fp || !now || now.token !== held.token) return;
        signIn.cancel();
        endSession('Your sign-in has ended. Please sign in again.', { elsewhere: true });
      });
    });
    // U1 (D21): no beforeunload prompt — drafts are saved as they are typed, so leaving loses nothing
    const param = takeEditorParam();
    const saved = readEditorState();
    if (param) { applyParam(param); D.unfold(); }
    else if (saved) { ed.trayOpen = saved.tray; if (saved.hash) trayHash = saved.hash; }
    if (!given && !stored && resumed) {
      // a reload or another tab: who this is, then the tab's own Editor setting
      const wantOn = Boolean(param) || Boolean(saved && saved.on);
      if (popup) closePopup();
      completeSignIn(Promise.resolve(resumed), { resumed: true })
        .then(() => { if (wantOn && state.session && state.access === 'ok' && !ed.on) setEditor(true); });
      return true;
    }
    if (!given && !stored) {
      refresh();                 // nobody yet: the controls stay hidden
      onSignInClick(popup);      // completeSignIn turns Editor mode on
      return true;
    }
    if (popup) closePopup();     // already signed in: the window is not needed
    const wantOn = Boolean(param) || Boolean(saved && saved.on);
    refresh().then(() => { if (wantOn && state.access === 'ok' && !ed.on) setEditor(true); });
    return true;
  }

  /* openView(where): the node tests' way in (and an old caller's). `where` is an editor address ('#/edit/…', or a
     retired one, which redirects: '#/review/3') or an old tab name (proposals, changes, view, guide, media).
     -> true when Editor mode is on and it was followed */
  const OLD_TABS = Object.freeze({ proposals: '#/', changes: DATA_HASH, view: '#/view', guide: '#/help', media: '#/media' });
  function openView(where) {
    const w = String(where);
    const hash = /^#\//.test(w) ? w : (Object.prototype.hasOwnProperty.call(OLD_TABS, w) ? OLD_TABS[w] : null);
    if (!ed.on || !hash) return false;
    ed.trayOpen = true;
    applyTray();
    trayGo(hash);
    return true;
  }

  /* What later units reuse, and the tests read (U0b): the redirect table, the helpers kept from the removed
     screens, and the editor's view of the page (the proposal kept drawn, the thin editor page's address). */
  const helpers = Object.freeze({
    REDIRECTS,
    redirectOf,
    mediaAssets,
    newProjectForm,
    makeProjectDraft,
    personFields,
    state: () => Object.freeze({ focusPr: ed.focusPr, trayOpen: ed.trayOpen, trayHash }),
  });
  window.HCEditor = Object.freeze({ start, mountPreview, refresh, openView, helpers });
}());
