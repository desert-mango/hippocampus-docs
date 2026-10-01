// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 1 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Draw Editor mode on the site's own page: the switch, the sandboxed page frame, the tray and the block editor.
/* Editor mode (plan D-C, D-D, D-G, D-H, D-N). This file started as a byte
   copy of js/cms.js (which keeps serving /cms/ until U8) and runs in the
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
       hc-block-select / hc-block-insert. The tray's Changes tab edits the
       picked block: its character SPAN in the draft (HCCore.spanOf), every
       change is HCCore.replaceSpan, and the frame reloads with a fresh nonce
       and `selected`. Files are read at a commit sha through
       HCCore.cachedFetcher, and drafts are served from memory, so a reload
       after an edit makes no network call.
     - the tray: today's /cms/ views in a fixed right panel (a bottom sheet
       on phones, body.hc-phone), five tabs, routed by a tray-local hash
       (trayHash), never the site's; a handle ("Editor · N proposals") while
       it is closed. Proposals = home + review list + review page, one card
       per proposal that expands in place ("Show on page" shows its head in
       the frame, read-only, its changes marked).
     - proposals in place (U7, plan D-F, D-G): an open proposal that touches
       the page on screen is drawn over main in the frame — the composite of
       HCCore.overlayOnMain (the PR's block diff from its merge base, read
       with compare), marked add / del / change / conflict — with a page bar
       above the frame ("X proposes changes to this page · PR #n · check …
       · Review in tray"). The frame's indices are then the composite's: a
       main block is edited at its index in main, a proposal's block opens
       that proposal's card. My draft of the page is shown instead when I
       have one; the newest of several proposals is drawn, the others are
       listed with their own "Show on page". Changes = the picked block (snippets over
       HCCore.SNIPPET_CATALOG, "Image from Media"), my drafts with Propose… /
       Discard, "Edit whole page as Markdown", the four registries as raw
       JSON, New project / New person. Media = the Media view. View = my
       settings (HCCore.viewSettings, localStorage). Guide = Help with the
       Editor-mode steps.

   It talks to this one repository only (HCCore's client refuses any other
   path), and its only writes are the review actions HCCore.runReviewAction
   sends and the proposal HCCore.runPropose sends. The token lives in
   sessionStorage and in closures; it never enters the page's DOM, the frame,
   or a message. Every GitHub-derived string is set as text.

   Seams:
     HCEditor.start(opts)  boot once: opts.fetch replaces window.fetch for
                           every GitHub and /api call (the localhost walk's fake
                           GitHub); opts.session is a session held in memory
                           only, never written under HCCore.SESSION_KEY.
     VIEWS                 tray route name -> view function (route, epoch).
     mountPreview(el, {route, fetcher})   a sandboxed preview under el. */
(function () {
  'use strict';

  const C = window.HCCore;
  let main = null;         // the tray's view panel (the old #cms-main)
  let notice = null;       // the tray's notice line
  let tray = null;         // aside#hc-tray
  let trayBody = null;     // the tray's scrolling body
  let controls = null;     // the header's Editor controls
  let switchBtn = null;
  let who = null;
  let frameHost = null;    // #hc-frame-host (index.html)
  let tabButtons = [];     // the tray's five tabs
  let countEl = null;      // the open proposals' count on the Proposals tab
  let handle = null;       // the tray's handle while it is closed
  let showBar = null;      // "Showing proposal #n on the page", while it is
  let pageBar = null;      // the bar above the frame: who proposes changes to this page (U7)
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
  }

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

  function endSession(message) {
    sessionGen.next();
    if (ed.on) setEditor(false);
    C.clearSession(store());
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

  async function completeSignIn(exchange) {
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
      tell('Signed in, but GitHub did not say who you are. Please sign in again.', 'error');
      return;
    }
    const record = C.makeSession(out.token, out.expiresIn, me.data.login, Date.now());
    state.memoryOnly = C.writeSession(store(), record) ? null : record;
    tell(state.memoryOnly ? 'Signed in. This browser would not keep the sign-in, so it ends when you leave this page.' : '');
    await refresh();
    // the person asked to edit: Editor mode comes on once GitHub confirmed access
    if (state.session && state.access === 'ok' && !ed.on) setEditor(true);
  }

  function onSignOutClick() {
    signIn.cancel();
    endSession(null);
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
  function renderChrome() {
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
    who.appendChild(avatarBtn);
    who.appendChild(h('span', { class: 'hc-login', title: login, text: first }));
    if (state.role && state.access === 'ok') {
      who.appendChild(h('span', { class: `hc-role cms-role cms-role-${state.role.key}`,
        title: 'Your role on this site\'s repository', text: state.role.label }));
    }
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

  // ------------------------------------------------------ the Review tab ---
  /* U8. #/review lists the open proposals with their badges; #/review/<n>
     shows one: the gate's status (and, when red, its located messages), the
     buttons the role allows, the rendered preview of the PR head's content
     (labelled "content only" when the proposal also changes code), and the
     files with their text diffs. A merged proposal offers Undo on GitHub.
     Every write is HCCore.runReviewAction: the client's allowlist admits only
     the review paths, and the answer comes back in the tab's words. */

  let flash = null;             // {number, text, ok}: an action's outcome, shown once after the refresh
  let acting = false;           // one action at a time

  const filesWord = (k) => `${k} file${k === 1 ? '' : 's'}`;
  const badge = (b) => h('span', { class: `cms-badge cms-badge-${b.key}`, title: b.text }, b.label);

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

  // ---------------------------------------------------- the Proposals tab ---
  /* Today's home, review list and review page in one tab (plan D-N): a card
     per open proposal (yours first) with its badges and "touches this page";
     the card of #/review/<n> expands in place with the gate's status and its
     located messages, the files ("← this page"), the review actions the role
     allows and "Show on page". A proposal opened by number that is not open
     (merged, closed, or none) gets its own card above the lists; a merged one
     offers Undo on GitHub. */

  const isMerged = (p) => p.merged === true || typeof p.merged_at === 'string';
  const pageFile = () => (ed.page ? ed.page.file : null);
  const touches = (files) => Boolean(files && pageFile() && files.some((f) => f && f.filename === pageFile()));
  let marks = [];               // [{files, pill} | {file, li}]: what "this page" marks, redrawn when the page moves

  /* The "touches this page" pills and "← this page" lines follow the page on
     screen without a new read. */
  function markPage() {
    for (const m of marks) {
      if (m.pill) m.pill.hidden = !touches(m.files);
      else m.li.classList.toggle('is-here', m.file === pageFile());
    }
  }

  function prCard(p, files, login, open) {
    const n = p.number;
    const mine = login && loginOf(p).toLowerCase() === login.toLowerCase();
    const age = C.ageText(p.created_at, Date.now());
    const pill = h('span', { class: 'hc-pill', text: 'touches this page' });
    pill.hidden = !touches(files);
    marks.push({ files, pill });
    const detail = h('div', { class: 'hc-card-detail' });
    const card = h('article', { class: open ? 'hc-card is-open' : 'hc-card', 'data-pr': String(n) },
      h('div', { class: 'hc-card-row' },
        h('span', { class: 'cms-num', text: `#${n}` }),
        // the open card's title folds it again
        link(open ? '#/' : `#/review/${n}`, String(p.title || '(no title)'), 'cms-title'),
        mine ? h('span', { class: 'cms-mine', text: 'yours' }) : null, pill),
      h('div', { class: 'hc-card-row cms-meta' },
        h('span', { text: `by ${loginOf(p)}${age ? `, opened ${age}` : ''}` }),
        h('span', { text: files ? filesWord(files.length) : 'files unknown' }),
        ...(files ? C.pullBadges(files) : []).map(badge),
        link(prLink(n), 'on GitHub', 'cms-gh')),
      detail);
    return { card, detail };
  }

  async function viewProposals(r, epoch) {
    const want = r.name === 'review-pr' ? r.params.number : null;
    paint(epoch, [h('h2', { text: 'Open proposals' }), h('p', { class: 'cms-muted', text: 'Loading proposals…' })]);
    const login = state.session && state.session.login;
    // "Recently merged" pages the closed PRs until nothing unread can be newer
    const [pulls, merged] = await Promise.all([openPulls(), C.loadRecentMerges(api, 5)]);
    const open = C.orderOpenPulls(pulls, login);
    setCount(open.length);
    // the badges and "touches this page" need each proposal's file list: read eagerly
    const files = await Promise.all(open.map((p) => filesOrNull(p.number)));
    if (epoch !== routeEpoch) return;
    marks = [];
    const cards = open.map((p, i) => prCard(p, files[i], login, p.number === want));
    const at = open.findIndex((p) => p.number === want);
    const lone = want !== null && at < 0 ? h('article', { class: 'hc-card is-open', 'data-pr': String(want) }) : null;
    if (!paint(epoch, [
      lone,
      h('h2', { text: 'Open proposals' }),
      cards.length ? h('div', { class: 'hc-cards' }, ...cards.map((c) => c.card))
        : h('p', { class: 'cms-muted', text: 'No open proposals.' }),
      h('h2', { text: 'Recently merged' }),
      merged.length
        ? h('ul', { class: 'cms-list' }, ...merged.map((p) => h('li', null,
          h('span', { class: 'cms-num', text: `#${p.number}` }),
          // its card offers Undo on GitHub
          link(`#/review/${p.number}`, String(p.title || '(no title)'), 'cms-title'),
          h('span', { class: 'cms-meta', text: `by ${loginOf(p)}, merged ${day(p.merged_at)}` }))))
        : h('p', { class: 'cms-muted', text: 'Nothing merged recently.' }),
    ])) return;
    if (want !== null) await prDetail(want, epoch, at >= 0 ? cards[at].detail : lone, at < 0);
  }

  function takeFlash(n) {
    const f = flash;
    flash = null;
    if (!f || f.number !== n) return null;
    return h('p', { class: `cms-action-result ${f.ok ? 'is-ok' : 'is-error'}`, role: 'status', text: f.text });
  }

  function prFacts(p, n, files) {
    const merged = p.merged === true || typeof p.merged_at === 'string';
    const age = C.ageText(p.created_at, Date.now());
    let count = '?';
    if (files) count = String(files.length);
    else if (Number.isInteger(p.changed_files)) count = String(p.changed_files);
    return h('dl', { class: 'cms-facts' },
      h('dt', { text: 'Proposal' }), h('dd', null, link(prLink(n), `#${n} on GitHub`)),
      h('dt', { text: 'State' }), h('dd', { text: merged ? `merged ${day(p.merged_at)}` : String(p.state || 'unknown') }),
      h('dt', { text: 'Author' }), h('dd', { text: loginOf(p) }),
      age ? h('dt', { text: 'Opened' }) : null, age ? h('dd', { text: age }) : null,
      h('dt', { text: 'Files changed' }), h('dd', { text: count }));
  }

  function badgeNotes(files) {
    if (!files) {
      return h('p', { class: 'cms-muted', text: 'GitHub did not list the changed files, so the badges are unknown. '
        + 'Look at the files on GitHub before you merge.' });
    }
    const badges = C.pullBadges(files);
    if (!badges.length) return null;
    return h('ul', { class: 'cms-badge-notes' }, ...badges.map((b) => h('li', null, badge(b), ` ${b.text}`)));
  }

  const MARK = { pass: '✓', fail: '✗', checking: '…', unknown: '?' };

  function statusBlock(status, notes) {
    const out = [h('p', { class: `cms-check cms-check-${status.state}`, role: 'status' },
      h('span', { class: 'cms-check-mark', 'aria-hidden': 'true', text: MARK[status.state] || '?' }),
      h('span', { text: status.text }),
      status.runUrl ? h('span', { class: 'cms-meta' }, ' · ', link(status.runUrl, 'the full report')) : null)];
    if (status.state !== 'fail') return out;
    if (notes === null) {
      out.push(h('p', { class: 'cms-muted', text: 'The located messages could not be read; the full report has them.' }));
    } else if (!notes.length) {
      out.push(h('p', { class: 'cms-muted', text: 'The check left no located messages; the full report has the text.' }));
    } else {
      out.push(h('p', { text: 'What to fix (file, line, message):' }),
        h('ul', { class: 'cms-annotations' }, ...notes.map((row) => h('li', { text: C.annotationText(row) }))));
    }
    return out;
  }

  const ACTION_LABEL = { approve: 'Approve', 'request-changes': 'Request changes', merge: 'Merge',
    update: 'Update from main', close: 'Close' };

  function actionsBlock(p, n, sha, epoch, status) {
    const keys = C.reviewActionsFor(state.role, p);
    if (!keys.length) {
      return h('p', { class: 'cms-muted', text: 'You can read this proposal. Reviewing it needs write access to this site\'s repository.' });
    }
    const login = (state.session && state.session.login) || '';
    const isAuthor = loginOf(p).toLowerCase() === login.toLowerCase();
    const box = keys.indexOf('request-changes') >= 0
      ? h('textarea', { class: 'cms-comment', rows: 3, 'aria-label': 'What should change',
        placeholder: 'What should change? (needed to request changes)' })
      : null;
    const result = h('p', { class: 'cms-action-result', role: 'status', hidden: true });
    // Merge while the gate is not green: the first click asks once, "Merge anyway" merges
    const confirm = h('p', { class: 'cms-merge-confirm', role: 'alert', hidden: true });
    const buttons = keys.map((k) => h('button', { type: 'button', 'data-action': k,
      class: k === 'merge' ? 'cms-btn cms-btn-primary' : 'cms-btn' }, ACTION_LABEL[k]));
    const ctx = (extra) => Object.assign({ number: n, sha, comment: box ? box.value : '', isAuthor,
      checkState: status.state }, extra);
    const ui = { epoch, buttons, result };
    buttons.forEach((b, i) => b.addEventListener('click', () => {
      if (keys[i] === 'merge' && C.mergeNeedsConfirm(status.state)) {
        askToMerge(confirm, () => act('merge', ctx({ confirmed: true }), ui), ui);
        return;
      }
      act(keys[i], ctx(), ui);
    }));
    return h('section', { class: 'cms-actions', 'aria-label': 'Review actions' },
      h('h2', { text: 'Your review' }), box, h('div', { class: 'cms-action-row' }, ...buttons),
      confirm, result);
  }

  /* The one confirmation before a merge on a gate that is not green. Its
     button joins the action buttons, so it is disabled while one runs. */
  function askToMerge(confirm, onYes, ui) {
    if (confirm.dataset.asked === 'yes') return;           // asked once already
    confirm.dataset.asked = 'yes';
    const yes = h('button', { type: 'button', class: 'cms-btn cms-btn-primary', 'data-action': 'merge-anyway' },
      'Merge anyway');
    yes.addEventListener('click', onYes);
    confirm.replaceChildren(document.createTextNode(`${C.MERGE_CONFIRM_TEXT} `), yes);
    confirm.hidden = false;
    ui.buttons.push(yes);
  }

  /* One review action. Nothing sent (no comment, no sha) -> say why here and
     keep what was typed. Sent -> refresh the proposal and show the outcome
     on it. An answer for a session that has since ended changes nothing.
     Update from main that GitHub took stays pending (`acting`, the buttons
     disabled, "updating…" on the card) until the head moved, the wait timed
     out or the read failed (followUpdate): only then is the card drawn
     again, from the proposal as it is now — so no second update goes out
     with the same expected head, and a Merge from the redrawn card pins the
     new head, not the old one. */
  async function act(action, ctx, ui) {
    if (acting || !state.client) return;
    acting = true;
    ui.buttons.forEach((b) => { b.disabled = true; });
    const gen = sessionGen.current();
    let out;
    let moved = null;
    try {
      try {
        out = await C.runReviewAction(state.client, action, ctx);
      } catch (e) {
        out = { ok: false, status: 0, message: `Something went wrong: ${(e && e.message) || e}`, sent: false };
      }
      if (!sessionGen.isCurrent(gen)) return;
      if (out.status === 401) { endSession('Your sign-in has ended. Please sign in again.'); return; }
      if (!out.sent) {
        ui.buttons.forEach((b) => { b.disabled = false; });
        ui.result.textContent = out.message;
        ui.result.hidden = false;
        ui.result.classList.toggle('is-error', true);
        return;
      }
      forgetProposals();               // the proposal moved on: the page bar and overlay read it again
      // Update from main: GitHub moves the branch a moment later, so the card
      // and the page follow once the head moved; every other action at once
      if (action === 'update' && out.ok && ed.on) {
        ui.result.textContent = `${out.message} Updating…`;
        ui.result.hidden = false;
        ui.result.classList.toggle('is-error', false);
        moved = await followUpdate(ctx.number, ctx.sha, gen);
        if (!sessionGen.isCurrent(gen)) return;
      } else if (ed.on) {
        frameTo(ed.route, true);
      }
    } finally {
      acting = false;
    }
    const text = moved ? `Updated from main: the card shows proposal #${ctx.number} as it is now.` : out.message;
    if (ui.epoch !== routeEpoch) { say(text, out.ok ? null : 'error'); return; }
    flash = { number: ctx.number, text, ok: out.ok };
    route();
  }

  function mergedPanel(p, n) {
    const keys = C.reviewActionsFor(state.role, p);
    return h('section', { class: 'cms-panel cms-undo' },
      h('p', { text: `This proposal was merged ${day(p.merged_at)}.` }),
      keys.indexOf('undo') >= 0
        ? h('p', null, h('a', { class: 'cms-btn cms-btn-primary', 'data-action': 'undo', href: C.undoOnGitHubUrl(n),
          target: '_blank', rel: 'noopener noreferrer' }, C.UNDO_TEXT))
        : null,
      h('p', { class: 'cms-muted', text: 'To undo it: GitHub opens this proposal, and its Revert button makes a new '
        + 'proposal that undoes the merge. That proposal then comes back here to be reviewed and merged.' }));
  }

  const diffClass = (line) => {
    if (line.indexOf('@@') === 0) return 'cms-diff-hunk';
    if (line.charAt(0) === '+') return 'cms-diff-add';
    if (line.charAt(0) === '-') return 'cms-diff-del';
    return null;
  };

  function filesBlock(files) {
    if (!files) return h('p', { class: 'cms-muted', text: 'GitHub did not list the changed files.' });
    if (!files.length) return h('p', { class: 'cms-muted', text: 'No files changed.' });
    return h('ul', { class: 'cms-files hc-files' }, ...files.map((f) => {
      const moved = typeof f.previous_filename === 'string' ? ` from ${f.previous_filename}` : '';
      const counts = Number.isInteger(f.additions) && Number.isInteger(f.deletions) ? `, +${f.additions} −${f.deletions}` : '';
      const li = h('li', { class: f.filename === pageFile() ? 'is-here' : null },
        h('div', { class: 'cms-file-head' }, h('code', { text: f.filename }),
          h('span', { class: 'hc-here', text: '← this page' }),
          h('span', { class: 'cms-meta', text: `${String(f.status || 'changed')}${moved}${counts}` })),
        typeof f.patch === 'string' && f.patch
          ? h('details', null, h('summary', { text: 'The text diff' }), h('pre', { class: 'cms-diff' },
            ...f.patch.split('\n').map((line) => h('span', { class: diffClass(line), text: `${line}\n` }))))
          : h('p', { class: 'cms-muted', text: 'No text diff (a binary file, or too large to show here).' }));
      marks.push({ file: f.filename, li });
      return li;
    }));
  }

  /* The registries at the proposal's head where it changes them (a new
     page), else the live site's: the page ids of its changed files. */
  async function headRegistries(sha, files) {
    const regs = await registries();
    const head = await C.loadHeadRegistries(sessionCache().at(sha), files);
    return { setup: head.setup || regs.setup, projects: head.projects || regs.projects, tools: head.tools || regs.tools };
  }

  /* "Show on page" (plan D-G 3): the frame shows the proposal's head,
     read-only — on this page when the proposal changes it, else on its first
     changed page; one button per other changed page. */
  function showOnPage(n, sha, files, pages, scope) {
    if (!sha || !files) {
      return h('p', { class: 'cms-muted', text: 'No "Show on page": GitHub did not say which commit or files this proposal has.' });
    }
    const here = pages.find((pg) => pg.file === pageFile());
    const order = here ? [here].concat(pages.filter((pg) => pg !== here)) : pages;
    const main = h('button', { type: 'button', class: 'cms-btn cms-btn-primary', 'data-action': 'show-on-page',
      title: order.length ? order[0].file : 'this page' }, 'Show on page');
    main.addEventListener('click', () => showProposal(n, sha, files, order.length ? order[0].route : null));
    const others = order.slice(1).map((pg) => {
      const b = h('button', { type: 'button', class: 'cms-btn', 'data-route': pg.route, title: pg.file }, pg.label);
      b.addEventListener('click', () => showProposal(n, sha, files, pg.route));
      return b;
    });
    return h('div', { class: 'hc-show' },
      scope.text ? h('p', { class: 'cms-preview-scope', text: scope.text }) : null,
      h('div', { class: 'cms-action-row' }, main, ...others));
  }

  /* One proposal's detail, drawn into its card (`slot`). standalone: the
     card has no title row (a proposal that is not open), so it gets one. */
  async function prDetail(n, epoch, slot, standalone) {
    const put = (nodes) => {
      if (epoch !== routeEpoch) return false;
      slot.replaceChildren(...[].concat(nodes).filter(Boolean));
      return true;
    };
    put(h('p', { class: 'cms-muted', text: 'Loading…' }));
    const res = await apiResponse(`${C.REPO_API_PATH}/pulls/${n}`);
    if (res.status === 404) {
      put(h('p', { text: `There is no proposal #${n} in this site's repository.` }));
      return;
    }
    if (!res.ok || !res.data) throw new Error(res.status ? `GitHub answered HTTP ${res.status}` : 'GitHub could not be reached');
    const p = res.data;
    const note = takeFlash(n);
    const title = standalone ? h('h3', { class: 'hc-card-title', text: `#${n} ${String(p.title || '')}` }) : null;
    if (isMerged(p)) {
      put([title, note, prFacts(p, n, null), mergedPanel(p, n)]);
      return;
    }
    if (p.state !== 'open') {
      put([title, note, prFacts(p, n, null), h('p', { text: 'This proposal was closed without merging.' })]);
      return;
    }
    const sha = p.head && /^[0-9a-f]{40}$/.test(String(p.head.sha)) ? p.head.sha : null;
    const [files, checks, comments] = await Promise.all([
      filesOrNull(n),
      sha ? apiResponse(`${C.REPO_API_PATH}/commits/${sha}/check-runs?check_name=check&per_page=100`) : null,
      apiResponse(`${C.REPO_API_PATH}/issues/${n}/comments?per_page=100`),
    ]);
    let status = { state: 'unknown', text: `${C.CHECK_TEXT.unknown} (the head commit is unknown)`, runUrl: null };
    if (checks && checks.ok) status = C.checkStatus(checks.data);
    else if (checks) status = { state: 'unknown', runUrl: null,
      text: `${C.CHECK_TEXT.unknown} (${checks.status ? `GitHub answered HTTP ${checks.status}` : 'GitHub could not be reached'})` };
    let notes = [];
    if (status.state === 'fail' && status.runId) {
      try {
        notes = await C.loadAnnotations(api, status.runId);   // every page of them
      } catch (e) {
        if (e && (e.message === STALE || e.message === 'signed out')) throw e;
        notes = null;
      }
    }
    const pages = sha && files ? C.previewPages(files, await headRegistries(sha, files)) : [];
    const vercel = comments && comments.ok ? C.vercelCommentUrl(comments.data) : null;
    put([
      title, note, prFacts(p, n, files), badgeNotes(files),
      ...statusBlock(status, notes),
      vercel ? h('p', null, link(vercel, 'Vercel\'s preview comment'), ' (a deploy preview, when Vercel made one)') : null,
      showOnPage(n, sha, files, pages, C.previewScope(files)),
      actionsBlock(p, n, sha, epoch, status),
      h('h3', { class: 'hc-card-title', text: 'Files changed' }), filesBlock(files),
    ]);
    markPage();
  }

  /* The Guide tab: today's Help with Editor mode's steps (#/private of
     /cms/ is one line here). */
  function viewHelp(r, epoch) {
    const step = (b, ...rest) => h('li', null, h('b', { text: b }), ...rest);
    paint(epoch, [
      h('h2', { text: 'How editing works here' }),
      h('ol', { class: 'hc-guide' },
        step('Editor on', ' (the switch in the header) shows this page in a frame you can edit. Your changes stay '
          + 'a draft in this browser tab until you propose them.'),
        step('Click a block', ' (or its pencil) to change its Markdown in the ', link('#/pages', 'Changes tab'),
          '. The snippet buttons and "Image from Media" add a note, a warning, tabs, an image…'),
        step('Press + between two blocks', ' to add a new block there.'),
        step('Propose…', ' turns your drafts into a proposal: a pull request on GitHub, checked by the site\'s gate.'),
        step('Nothing is live', ' until someone with write access merges it, in the ', link('#/', 'Proposals tab'),
          '. "Show on page" shows a proposal on its page; a merge can be undone on GitHub.'),
        step('Open proposals are drawn on the page', ' (View: "Show others\u2019 suggestions"): green is added or '
          + 'new, red is removed or old, a dashed mark means main changed that block since the proposal (Update '
          + 'from main). Click a marked block to open its proposal; the bar above the page links to it.'),
        step('View', ' holds your own settings for the page. They stay in this browser.')),
      h('p', { class: 'cms-muted', text: 'Per-line diff inside code blocks is out of v1: a changed code block is shown '
        + 'whole, the old one and then the new one.' }),
      h('p', { class: 'cms-muted', text: 'Private (members-only) pages are not in the editor yet.' }),
      h('h2', { text: 'Roles' }),
      h('dl', { class: 'cms-facts' },
        h('dt', { text: 'Admin' }), h('dd', { text: 'everything, and managing who can edit' }),
        h('dt', { text: 'Maintainer' }), h('dd', { text: 'reviews and merges proposals' }),
        h('dt', { text: 'Editor' }), h('dd', { text: 'edits pages and proposes changes' }),
        h('dt', { text: 'Read-only' }), h('dd', { text: 'reads proposals and previews' })),
      h('p', null, 'How proposals are reviewed and merged: ', link(C.PROTOCOLS_URL, 'the maintainer protocols'), '.'),
      h('p', null, 'Every page can also be edited on github.com: ',
        link(`${C.GITHUB_WEB}/tree/main/content`, 'open its file and click the pencil'), '.'),
      state.role && state.role.key === 'admin'
        ? h('p', null, link(`${C.GITHUB_WEB}/settings/access`, 'Manage people'), ' — who can edit (GitHub settings).')
        : null,
    ]);
  }

  /* data/setup.json, data/projects.json and data/tools.json, read the way
     js/app.js reads them (HC.fetchJSON), for the page-id -> file mapping. */
  async function registries() {
    if (state.regs) return state.regs;
    const get = (p) => HC.fetchJSON(p).catch(() => null);
    const [setup, projects, tools] = await Promise.all([
      get('data/setup.json'), get('data/projects.json'), get('data/tools.json')]);
    state.regs = { setup, projects, tools };
    return state.regs;
  }

  // ------------------------------------------------------------ the editor ---
  /* U7b. #/pages is the page tree (the registries' pages, as js/app.js
     routes them, plus the four raw-JSON registries). #/edit/<page> is the
     editor: the file's text at the head of main (or of my own open
     proposal), snippet buttons, and the live preview — the sandboxed site
     served the draft through the bridge, reloaded with a fresh nonce a moment
     after each change. A draft lives in memory and in this tab's
     sessionStorage, keyed by page (HCCore.createDraftStore); leaving a page
     whose draft is not proposed asks first. Read-only people get the same
     page, view-only, with the github.com pencil link. */

  const drafts = C.createDraftStore(store());
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

  const backToChanges = () => h('p', { class: 'hc-back' }, link('#/pages', '← Changes'));

  /* The Changes tab's home: the picked block's editor, my drafts (Propose…
     / Discard), the four registries as raw JSON, New project / New person. */
  function viewChanges(r, epoch) {
    const panel = changesPanel();
    draftList = h('section', { class: 'hc-drafts', 'aria-label': 'Your drafts' });
    drawDraftList(true);
    if (!paint(epoch, [
      panel.node,
      draftList,
      h('h2', { text: 'Registries (raw JSON)' }),
      h('ul', { class: 'hc-links' }, ...C.RAW_REGISTRIES.map((f) => h('li', null, link(`#/edit/${f.slice(0, -5)}`, f)))),
      canEdit() ? h('h2', { text: 'New' }) : null,
      canEdit() ? h('p', { class: 'cms-new-links' }, link('#/new/project', 'New project'), ' · ',
        link('#/new/person', 'New person')) : null,
    ])) return;
    const sel = ed.pendingSelect;
    ed.pendingSelect = null;
    if (sel && panel.ta) {
      panel.ta.focus();
      panel.ta.setSelectionRange(sel.start, sel.end);
    }
  }

  let draftList = null;          // the Changes tab's draft list, while drawn
  let draftKeys = null;

  /* My changed drafts; redrawn only when the set of them changed (a
     keystroke does not rebuild an open Propose panel). */
  function drawDraftList(force) {
    if (!draftList) return;
    const list = canEdit() ? drafts.dirty() : [];
    const keys = list.map((d) => d.key).join('\n');
    if (!force && keys === draftKeys) return;
    draftKeys = keys;
    draftList.replaceChildren(...(list.length ? [h('h2', { text: 'Your drafts, not proposed yet' }),
      h('ul', { class: 'hc-draft-list' }, ...list.map(draftRow))] : []));
  }

  function draftRow(d) {
    const slot = h('div', { class: 'hc-propose-slot' });
    const problem = problemLine();
    const propose = h('button', { type: 'button', class: 'cms-btn cms-btn-primary', 'data-action': 'propose-draft' }, 'Propose…');
    const discard = h('button', { type: 'button', class: 'cms-btn', 'data-action': 'discard-draft' }, 'Discard');
    propose.addEventListener('click', async () => {
      propose.disabled = true;
      try {
        openPropose(d, routeEpoch, slot, await myProposals());
      } catch (e) {
        if (!quiet(e)) showProblem(problem, `Something went wrong: ${(e && e.message) || e}`);
      } finally {
        propose.disabled = false;
      }
    });
    discard.addEventListener('click', () => discardDraft(d));
    return h('li', { 'data-draft': d.key },
      h('span', { class: 'hc-draft-label', text: d.label }),
      ...Object.keys(d.files).map((f) => h('code', { text: f })),
      d.base.number ? h('span', { class: 'cms-meta', text: `for your proposal #${d.base.number}` }) : null,
      h('div', { class: 'cms-action-row' }, propose, discard), problem, slot);
  }

  function discardDraft(d) {
    if (!window.confirm(C.DISCARD_TEXT)) return;
    drafts.remove(d.key);
    chosenBase.delete(d.key);
    if (ed.draft && ed.draft.key === d.key) clearSelection();
    route();
    frameTo(ed.route, false);
  }

  function cannotEdit(epoch, pageId) {
    paint(epoch, [backToChanges(), h('h1', { text: 'Not editable here' }),
      h('p', null, `The editor has no page "${pageId}". `, link('#/pages', 'Back to Changes'),
        ', or ', link(`${C.GITHUB_WEB}/tree/main`, 'edit the repository on github.com'), '.')]);
  }

  async function viewEdit(r, epoch) {
    const pageId = r.params.pageId;
    const kind = C.editKind(pageId);
    const regs = await registries();
    const file = kind ? C.editPath(pageId, regs) : null;
    const route = kind ? C.routeForPage(pageId, regs) : null;
    if (!file || !route) { cannotEdit(epoch, pageId); return; }
    if (kind === 'page') {
      // a content page is edited where it stands: go there, the Changes tab edits its blocks
      if (currentRoute() !== route) window.location.hash = `#${route}`;
      trayGo('#/pages');
      return;
    }
    const meta = { label: kind === 'registry' ? file
      : (C.pageList(regs).find((pg) => pg.pageId === pageId) || {}).title || pageId, route };
    paint(epoch, [h('h1', { text: `Edit: ${meta.label}` }), h('p', { class: 'cms-muted', text: 'Loading the page…' })]);
    const editable = canEdit();
    let d = editable ? drafts.get(pageId) : null;
    // an unchanged draft is not kept: the page opens at the base's newest head
    if (d && !C.isDirty(d)) { drafts.remove(pageId); d = null; }
    const own = editable ? await myProposals() : [];
    if (!d) d = await loadDraft(pageId, meta, [file], baseFor(pageId, own));
    if (d.originals[file] === null) throw new Error(`${file} is not on ${d.base.ref}`);
    if (!paint(epoch, editorPage(d, file, kind, editable, epoch, own))) return;
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
      'Propose…') : null;
    const discardBtn = editable ? h('button', { type: 'button', class: 'cms-btn', 'data-action': 'discard' },
      'Discard changes') : null;
    let bad = null;

    function check() {
      bad = kind === 'registry' ? C.registryDraftProblem(file, d.originals[file], ta.value) : null;
      problem.textContent = bad ? bad.message : '';
      problem.hidden = !bad;
      const dirty = C.isDirty(d);
      stateLine.textContent = !editable ? 'View only.'
        : (dirty ? 'Changed — kept as a draft in this tab, not proposed yet.' : 'No changes yet.');
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

    const tools = editable && kind === 'page' ? snippetBar(ta, replaceText, d) : null;
    if (discardBtn) {
      discardBtn.addEventListener('click', () => {
        if (C.isDirty(d) && !window.confirm(C.DISCARD_TEXT)) return;
        drafts.remove(d.key);
        editing = null;
        route();
      });
    }
    const slot = h('div', { id: 'cms-propose-slot' });
    if (proposeBtn) proposeBtn.addEventListener('click', () => openPropose(d, epoch, slot, own));
    check();
    const isNew = d.originals[file] === null;

    const ids = kind === 'registry' ? C.lockedIds(file, safeParse(d.originals[file])) : [];
    const nodes = [
      backToChanges(),
      h('h1', { text: d.key.indexOf('new/') === 0 ? d.label : `Edit: ${d.label}` }),
      isNew ? h('p', { class: 'cms-meta' }, h('code', { text: file }), ' · a new file')
        : h('p', { class: 'cms-meta' }, h('code', { text: file }), ' · ', link(C.pencilUrl(file), 'edit on github.com instead')),
      editable && own.length && d.key.indexOf('new/') !== 0 ? basePicker(d, own) : null,
      d.base.number ? h('p', { class: 'cms-muted', text: `Building on your proposal #${d.base.number}.` }) : null,
      !editable ? h('p', { class: 'cms-muted' }, 'View only: changing pages needs write access to this site\'s '
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

  /* Note box, warning, tabs, an internal link picked from the page tree,
     and "Image from Media" (U9): the chooser opens under the toolbar and
     "Insert into page" writes ![alt](url) at the cursor of draft d's text. */
  function snippetBar(ta, replaceText, d) {
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
    const slot = h('div', { class: 'cms-media-slot' });
    const media = mediaToggle('Image from Media', slot, () => mediaPanel({ mode: 'insert', baseOf: () => (d ? d.base : MAIN_BASE),
      onInsert(md) {
        const out = C.insertText(ta.value, ta.selectionStart, ta.selectionEnd, md);
        replaceText(out.text, out.selStart, out.selEnd);
      } }));
    return h('div', null, h('div', { class: 'cms-snippets', role: 'toolbar', 'aria-label': 'Insert' },
      ...buttons, picker, linkBtn, media), slot);
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
      editing = null;
      route();
    });
    return h('p', { class: 'cms-base' }, h('label', null, 'Start from: ', sel));
  }

  /* The Propose panel under the editor: a summary (the PR title), the
     drafts that go in (every changed draft on the same base), what refuses
     them, and one button — "Propose" (a new branch and PR) or "Add to
     proposal #n" (one more commit on my proposal's branch). */
  function openPropose(d, epoch, slot, own) {
    const group = () => drafts.dirty().filter((o) => sameBase(o, d));
    const plan = C.collectProposal(group());
    const problems = plan.problems.concat(stillOpen(d, own) ? [] : [closedText(d)]);
    const box = h('input', { type: 'text', 'data-field': 'summary', maxlength: 120,
      'aria-label': 'What this proposal does' });
    box.value = d.key.indexOf('new/') === 0 ? d.label : `Edit ${d.label}`;
    const go = h('button', { type: 'button', class: 'cms-btn cms-btn-primary', 'data-action': 'send-proposal' },
      d.base.number ? `Add to proposal #${d.base.number}` : 'Propose');
    go.disabled = problems.length > 0;
    const result = h('p', { class: 'cms-action-result', role: 'status', hidden: true });
    go.addEventListener('click', () => sendProposal(d, { box, go, result, group, own, epoch }));
    const n = plan.changes.length;
    slot.replaceChildren(h('section', { class: 'cms-propose cms-panel', 'aria-label': 'Propose' },
      h('h2', { text: d.base.number ? `Add to your proposal #${d.base.number}` : 'Propose these changes' }),
      h('label', null, 'What does this change do? (the proposal\'s title on GitHub)', box),
      h('p', { text: `What goes in (${n} file${n === 1 ? '' : 's'}):` }),
      h('ul', null, ...plan.pages.map((pg) => h('li', null, `${pg.label} — `, h('code', { text: pg.file })))),
      problems.length ? h('ul', { class: 'cms-problem', role: 'alert' }, ...problems.map((t) => h('li', { text: t }))) : null,
      h('p', { class: 'cms-muted', text: d.base.number
        ? 'This adds one commit to your proposal. Its reviewers see the change there.'
        : 'This makes one commit on a new branch and opens a proposal on GitHub. Someone with write access reviews it and merges it.' }),
      h('div', { class: 'cms-action-row' }, go), result));
  }

  const stillOpen = (d, own) => !d.base.number || own.some((p) => p.number === d.base.number);
  const closedText = (d) => `Your proposal #${d.base.number} is no longer open: discard these changes and start `
    + 'from the live site.';

  async function sendProposal(d, ui) {
    if (proposing || !state.client) return;
    const plan = C.collectProposal(ui.group());       // the text as it is now
    const problems = plan.problems.concat(stillOpen(d, ui.own) ? [] : [closedText(d)]);
    const show = (text) => {
      ui.result.textContent = text;
      ui.result.hidden = false;
      ui.result.classList.toggle('is-error', true);
    };
    if (problems.length) { show(`Nothing was sent: ${problems.join(' ')}`); return; }
    proposing = true;
    ui.go.disabled = true;
    const gen = sessionGen.current();
    let out;
    try {
      out = await C.runPropose(state.client, {
        login: state.session.login, summary: ui.box.value, now: Date.now(), origin: window.location.origin,
        target: d.base.number ? { branch: d.base.ref, number: d.base.number } : null,
        changes: plan.changes, pages: plan.pages,
      });
    } catch (e) {
      out = { ok: false, status: 0, message: `Something went wrong: ${(e && e.message) || e}` };
    } finally {
      proposing = false;
    }
    if (!sessionGen.isCurrent(gen)) return;
    if (out.status === 401) { endSession(out.message); return; }
    if (!out.ok) { ui.go.disabled = false; show(out.message); return; }
    const sent = ui.group().map((o) => o.key);
    for (const o of ui.group()) { drafts.remove(o.key); chosenBase.delete(o.key); }
    editing = null;
    if (ed.draft && sent.indexOf(ed.draft.key) >= 0) {
      clearSelection();
      frameTo(ed.route, false);
    }
    if (out.signedOut) {
      // the proposal is open; only the sign-in ended (after the PR opened)
      trayGo(`#/review/${out.number}`);
      endSession(`${out.message} Your sign-in has ended. Please sign in again.`);
      return;
    }
    if (ui.epoch !== routeEpoch) { say(out.message); return; }
    flash = { number: out.number, text: out.message, ok: true };
    trayGo(`#/review/${out.number}`);
  }

  // #/new/project and #/new/person.
  async function viewNew(r, epoch) {
    if (r.params.kind !== 'project' && r.params.kind !== 'person') { viewNotFound(r, epoch); return; }
    const what = r.params.kind;
    if (!canEdit()) {
      paint(epoch, [backToChanges(), h('h1', { text: `New ${what}` }), h('p', { class: 'cms-muted' },
        `View only: adding a ${what} needs write access to this site's repository. You can still `,
        link(C.pencilUrl(what === 'project' ? 'data/projects.json' : 'data/people.json'),
          'propose a change on github.com'), '.')]);
      return;
    }
    const regs = await registries();
    if (what === 'project') await newProjectPage(epoch); else await newPersonPage(epoch, regs);
  }

  const field = (tag, k, attrs) => h(tag, Object.assign({ 'data-field': k }, tag === 'input' ? { type: 'text' } : {}, attrs));
  const labelled = (text, el, hint) => h('label', null, text, el, hint ? h('span', { class: 'cms-hint', text: hint }) : null);
  const problemLine = () => h('p', { class: 'cms-problem', 'data-problem': '', role: 'alert', hidden: true });
  const showProblem = (el, text) => { el.textContent = text || ''; el.hidden = !text; };

  /* A new project: the form, then (once it makes a draft) the story in the
     editor with its preview and Propose. One draft, two files. */
  async function newProjectPage(epoch) {
    const d = drafts.get('new/project');
    if (d && C.isDirty(d)) {
      const md = Object.keys(d.files).find((p) => p !== 'data/projects.json');
      const own = d.base.number ? await myProposals() : [];   // is my proposal still open?
      if (!paint(epoch, [backToChanges(), h('p', { class: 'cms-muted', text: `This draft adds ${md} and one entry to `
        + 'data/projects.json. To change the entry, discard it and fill the form again.' })]
        .concat(editorPage(d, md, 'page', true, epoch, own)))) return;
      editing = { key: d.key, hash: trayHash };
      return;
    }
    const own = await myProposals();
    const f = {
      base: field('select', 'base', { 'aria-label': 'Start from' }),
      id: field('input', 'id', { autocomplete: 'off' }), name: field('input', 'name'),
      status: field('select', 'status', null, null),
      tagline: field('input', 'tagline'), repos: field('textarea', 'repos', { rows: 3 }),
      story: field('textarea', 'story', { rows: 10 }),
    };
    f.base.appendChild(h('option', { value: '' }, 'the live site (a new proposal)'));
    for (const p of own) f.base.appendChild(h('option', { value: String(p.number) }, `your proposal #${p.number}: ${p.title}`));
    f.base.value = '';
    for (const s of C.PROJECT_STATUSES) f.status.appendChild(h('option', { value: s }, s));
    f.status.value = 'active';
    f.story.value = '## What it is\n\n';
    const problem = problemLine();
    const make = h('button', { type: 'button', class: 'cms-btn cms-btn-primary', 'data-action': 'make-draft' },
      'Make the draft');
    make.addEventListener('click', () => makeProjectDraft(f, own, problem, make, epoch));
    paint(epoch, [
      backToChanges(),
      h('h1', { text: 'New project' }),
      h('p', { class: 'cms-muted', text: 'A project is one entry in data/projects.json and one page of Markdown. '
        + 'The draft stays in this browser tab until you propose it.' }),
      h('div', { class: 'cms-form' },
        own.length ? labelled('Start from', f.base, 'Your open proposal gets one more commit; the live site starts a new proposal.') : null,
        labelled('Id', f.id, 'The page address, /projects/<id>: lowercase letters, digits and dashes. It cannot be changed later.'),
        labelled('Name', f.name), labelled('Status', f.status),
        labelled('Tagline', f.tagline, 'One line under the name.'),
        labelled('Repositories', f.repos, 'One name per line, as on github.com/HippoCampusRobotics. Each repository belongs to one project.'),
        labelled('Story (Markdown)', f.story), problem, h('div', { class: 'cms-action-row' }, make)),
    ]);
  }

  async function makeProjectDraft(f, own, problem, make, epoch) {
    const form = {};
    for (const k of Object.keys(f)) form[k] = f[k].value;
    const hit = own.find((p) => String(p.number) === form.base);
    const id = String(form.id).trim();
    make.disabled = true;
    try {
      const files = ['data/projects.json'].concat(C.PROJECT_ID_RE.test(id) ? [`content/projects/${id}.md`] : []);
      const d = await loadDraft('new/project', { label: `New project: ${String(form.name).trim() || id}`,
        route: `/projects/${id}` }, files, hit ? { ref: hit.branch, number: hit.number } : MAIN_BASE);
      const out = C.newProjectDraft(form, d.originals['data/projects.json']);
      const md = `content/projects/${out.id}.md`;
      if (out.problem) { showProblem(problem, out.problem); return; }
      if (d.originals[md] !== null) { showProblem(problem, `${md} already exists on the site — pick another id`); return; }
      if (epoch !== routeEpoch) return;
      d.files = out.files;
      drafts.put(d);
      route();
    } catch (e) {
      if (e && (e.message === 'signed out' || e.message === STALE)) return;
      showProblem(problem, `Something went wrong: ${(e && e.message) || e}`);
    } finally {
      make.disabled = false;
    }
  }

  /* A new person: one entry added to the data/people.json draft. With no
     changed people draft, "Start from" picks the live site (a new proposal)
     or one of my open proposals (one more commit on its branch), like New
     project; a changed draft already open decides the base itself. */
  async function newPersonPage(epoch, regs) {
    const FILE = 'data/people.json';
    const key = 'data/people';
    const meta = { label: FILE, route: C.routeForPage(key, regs) };
    let d = drafts.get(key);
    const open = Boolean(d && C.isDirty(d));
    const own = open ? [] : await myProposals();
    if (!open) d = await loadDraft(key, meta, [FILE], baseFor(key, own));
    const groups = C.personGroups(d.files[FILE]);
    const f = { group: field('select', 'group') };
    for (const g of groups) f.group.appendChild(h('option', { value: g.id }, g.title));
    if (groups.length) f.group.value = groups[0].id;
    for (const k of ['name', 'title', 'link']) f[k] = field('input', k);
    if (!open && own.length) {
      f.base = field('select', 'base', { 'aria-label': 'Start from' });
      f.base.appendChild(h('option', { value: '' }, 'the live site (a new proposal)'));
      for (const p of own) f.base.appendChild(h('option', { value: String(p.number) }, `your proposal #${p.number}: ${p.title}`));
      f.base.value = d.base.number ? String(d.base.number) : '';
    }
    // a photo must be in the site's image list (check.py 6c): it is picked from Media, never typed
    f.photo = { value: null };
    const photoLine = h('span', { class: 'cms-hint', 'data-photo': '', text: 'No photo: the card shows none.' });
    const mediaSlot = h('div', { class: 'cms-media-slot' });
    const personBase = () => {
      if (!f.base) return d.base;
      const hit = own.find((p) => String(p.number) === f.base.value);
      return hit ? { ref: hit.branch, number: hit.number } : MAIN_BASE;
    };
    const media = mediaToggle('Photo from Media', mediaSlot, (close) => mediaPanel({ mode: 'photo', folder: 'people',
      baseOf: personBase,
      onUse(entry) {
        f.photo.value = entry.url;
        photoLine.textContent = `Photo: ${entry.public_id}`;
        close();
      } }));
    const problem = problemLine();
    const add = h('button', { type: 'button', class: 'cms-btn cms-btn-primary', 'data-action': 'add-person' },
      'Add to the people draft');
    add.addEventListener('click', () => addPerson(f, d, own, meta, problem, add, epoch));
    const where = open ? (d.base.number ? `your people draft for proposal #${d.base.number}`
      : 'your people draft (a new proposal)') : 'the data/people.json draft';
    paint(epoch, [
      backToChanges(),
      h('h1', { text: 'New person' }),
      h('p', { class: 'cms-muted', text: `A person is one card on the About page. This adds them to ${where}; `
        + 'you see it, and propose it, on the next page.' }),
      h('div', { class: 'cms-form' },
        f.base ? labelled('Start from', f.base, 'Your open proposal gets one more commit; the live site starts a new proposal.') : null,
        labelled('Group', f.group), labelled('Name', f.name), labelled('Title', f.title, 'For example "Research Associate". May be empty.'),
        h('div', { class: 'cms-photo' }, h('span', { class: 'cms-label', text: 'Photo (optional)' }), media, photoLine),
        mediaSlot,
        labelled('Link (optional)', f.link, 'Their page, http:// or https://.'),
        problem, h('div', { class: 'cms-action-row' }, add)),
    ]);
  }

  /* Adds the form's person to draft d — first reloading data/people.json
     at my proposal's head when "Start from" picked a different base. */
  async function addPerson(f, d, own, meta, problem, add, epoch) {
    const FILE = 'data/people.json';
    add.disabled = true;
    try {
      if (f.base && f.base.value !== (d.base.number ? String(d.base.number) : '')) {
        const hit = own.find((p) => String(p.number) === f.base.value);
        d = await loadDraft(d.key, meta, [FILE], hit ? { ref: hit.branch, number: hit.number } : MAIN_BASE);
        if (epoch !== routeEpoch) return;
      }
      const photoProblem = f.photo.value ? await photoBaseProblem(f.photo.value, d.base) : null;
      if (photoProblem) { showProblem(problem, photoProblem); return; }
      const out = C.addPersonText(d.files[FILE], { group: f.group.value, name: f.name.value, title: f.title.value,
        photo: f.photo.value, link: f.link.value });
      if (out.problem) { showProblem(problem, out.problem); return; }
      d.files[FILE] = out.text;
      drafts.put(d);
      if (d.base.number) chosenBase.set(d.key, { number: d.base.number }); else chosenBase.delete(d.key);
      trayGo(`#/edit/${d.key}`);
    } catch (e) {
      if (e && (e.message === 'signed out' || e.message === STALE)) return;
      showProblem(problem, `Something went wrong: ${(e && e.message) || e}`);
    } finally {
      add.disabled = false;
    }
  }

  // ------------------------------------------------------------- media ---
  /* U9. #/media lists the site's images on Cloudinary (thumbnails, a next
     page), uploads, and renames or deletes an image only when the live site
     does not use it. The token goes to this site's /api/media only
     (HCCore.createMediaClient); an upload goes straight to Cloudinary with
     the signed parameters (HCCore.runUpload). A new image is one entry of
     the data/cloudinary-manifest.json draft, on the same base as the page
     that uses it, so Propose sends both in one proposal. */

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
  const draftAssets = () => {
    const d = openManifestDraft();
    return d ? C.manifestAssets(C.parseManifest(d.files[C.MANIFEST_FILE])) : [];
  };

  /* The image-list draft on `base`: the changed one when it is on the same
     base, else a fresh one at that base's head. -> {d} | {problem} */
  async function manifestDraftOn(base) {
    const open = openManifestDraft();
    if (open) {
      if (open.base.ref === base.ref) return { d: open };
      return { problem: `Your image-list draft builds on ${whereOf(open.base)}, and this page on ${whereOf(base)}. `
        + 'Propose or discard one of them first (the Media tab can discard the image-list draft).' };
    }
    return { d: await loadDraft(C.MANIFEST_KEY, MANIFEST_META, [C.MANIFEST_FILE], { ref: base.ref, number: base.number }) };
  }

  /* The images a page on `base` may use: my changed image-list draft when
     it is on that base; else the manifest at the base's head — the live
     site's for main, the branch's for my open proposal (it may hold images
     proposed there earlier). */
  async function baseAssets(base) {
    const open = openManifestDraft();
    if (open && open.base.ref === base.ref) return draftAssets();
    if (!base.number) return liveAssets();
    const res = await apiResponse(C.contentsPath(C.MANIFEST_FILE, await headOf(base.ref)), { accept: C.RAW_MEDIA, raw: true });
    if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} for ${C.MANIFEST_FILE}`);
    return C.manifestAssets(C.parseManifest(res.data));
  }

  const mediaClient = () => C.createMediaClient({ fetch: netFetch, token: state.session.token });

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
  async function mediaCall(action, ...args) {
    const gen = sessionGen.current();
    return checked(gen, await mediaClient()[action](...args));
  }
  const quiet = (e) => Boolean(e) && (e.message === 'signed out' || e.message === STALE);

  /* A person's photo must be an image of the people draft's base (the live
     site, my open proposal, or my changed image-list draft on that base). */
  async function photoBaseProblem(url, base) {
    if ((await baseAssets(base)).some((a) => a.url === url)) return null;
    const md = openManifestDraft();
    return md && md.base.ref !== base.ref && draftAssets().some((a) => a.url === url)
      ? `The photo is in your image-list draft for ${whereOf(md.base)}: start from the same place, or pick another photo.`
      : 'The photo is not an image of the site or of your image-list draft any more: pick it again.';
  }

  /* A button that opens make(close) into slot, and closes it again. */
  function mediaToggle(label, slot, make) {
    const btn = h('button', { type: 'button', class: 'cms-btn', 'data-action': 'media-open', 'aria-expanded': 'false' }, label);
    let panel = null;
    const close = () => {
      if (panel) panel.remove();
      panel = null;
      btn.setAttribute('aria-expanded', 'false');
    };
    btn.addEventListener('click', () => {
      if (panel) { close(); return; }
      panel = make(close);
      slot.appendChild(panel);
      btn.setAttribute('aria-expanded', 'true');
    });
    return btn;
  }

  /* The image chooser. opts: {mode: 'insert' (alt text + "Insert into
     page" -> onInsert(markdown)) | 'photo' ("Use as photo" -> onUse(entry))
     | 'library' (upload only), baseOf() -> the base a new image's manifest
     entry goes on, folder (the preselected one), onUploaded()}. */
  function mediaPanel(opts) {
    const status = h('p', { class: 'cms-media-status', role: 'status', hidden: true });
    const problem = problemLine();
    const tell = (text) => { status.textContent = text || ''; status.hidden = !text; };
    const folder = field('select', 'media-folder', { 'aria-label': 'Folder' });
    for (const s of C.MEDIA_SUBFOLDERS) folder.appendChild(h('option', { value: s }, s));
    folder.value = opts.folder || 'setup';
    const file = h('input', { type: 'file', 'data-field': 'media-file', accept: C.MEDIA_TYPES.join(','), 'aria-label': 'Image file' });
    const up = h('button', { type: 'button', class: 'cms-btn cms-btn-primary', 'data-action': 'media-upload' }, 'Upload');
    const pick = field('select', 'media-pick', { 'aria-label': 'An image the site has' });
    const chosenBox = h('div', { class: 'cms-media-chosen', hidden: true });
    let chosen = null;
    let known = [];

    function choose(entry) {
      chosen = entry;
      const thumb = C.thumbUrl(entry.url);
      chosenBox.replaceChildren(thumb ? h('img', { class: 'cms-media-thumb', src: thumb, alt: '' }) : null,
        h('code', { text: entry.url }));
      chosenBox.hidden = false;
      showProblem(problem, '');
    }

    async function fillPick() {
      const [all, live] = await Promise.all([baseAssets(opts.baseOf()), liveAssets()]);
      const onSite = new Set(live.map((a) => a.public_id));
      known = all.filter((a) => typeof a.url === 'string');
      pick.replaceChildren(h('option', { value: '' }, 'pick an image the site has…'),
        ...known.map((a) => h('option', { value: a.url }, onSite.has(a.public_id) ? a.public_id
          : `${a.public_id} (new: not on the live site yet)`)));
      pick.value = chosen ? chosen.url : '';
    }
    pick.addEventListener('change', () => {
      const hit = known.find((a) => a.url === pick.value);
      if (hit) { choose(hit); tell(''); }
    });

    up.addEventListener('click', async () => {
      showProblem(problem, '');
      tell('');
      const f = file.files && file.files[0];
      const bad = C.mediaFileProblem(f);
      if (bad) { showProblem(problem, bad); return; }
      up.disabled = true;
      tell('Uploading…');
      try {
        const md = await manifestDraftOn(opts.baseOf());
        if (md.problem) { tell(''); showProblem(problem, md.problem); return; }
        const live = await liveAssets();
        const gen = sessionGen.current();
        const out = checked(gen, await C.runUpload({ media: mediaClient(), fetch: netFetch, FormData: window.FormData,
          subtle: window.crypto.subtle }, { file: f, subfolder: folder.value, live, draftText: md.d.files[C.MANIFEST_FILE] }));
        if (out.kind === 'problem') { tell(''); showProblem(problem, out.message); return; }
        if (out.kind === 'duplicate') {
          choose(out.entry);
          tell(`This image is already ${out.where === 'site' ? 'on the site' : 'in your image-list draft'}: `
            + `${out.entry.url}. Use that one; nothing was uploaded.`);
        } else {
          md.d.files[C.MANIFEST_FILE] = out.text;
          drafts.put(md.d);
          choose(out.entry);
          tell(`Uploaded: ${out.entry.url}. It is in your image-list draft (${C.MANIFEST_FILE}), which goes into `
            + 'the same proposal as the page that uses it.' + (opts.mode === 'library'
            ? ' To show it on a page, open the page under Edit and press "Image from Media".' : ''));
        }
        await fillPick();
        if (opts.onUploaded) opts.onUploaded();
      } catch (e) {
        if (quiet(e)) return;
        tell('');
        showProblem(problem, `Something went wrong: ${(e && e.message) || e}`);
      } finally {
        up.disabled = false;
      }
    });

    let useRow = null;
    if (opts.mode === 'insert') {
      const alt = field('input', 'media-alt', { autocomplete: 'off' });
      const go = h('button', { type: 'button', class: 'cms-btn cms-btn-primary', 'data-action': 'media-insert' }, 'Insert into page');
      go.addEventListener('click', () => {
        const out = C.imageMarkdown(alt.value, chosen && chosen.url);
        if (out.problem) { showProblem(problem, out.problem); return; }
        showProblem(problem, '');
        opts.onInsert(out.text);
      });
      useRow = h('div', { class: 'cms-form' }, labelled('Describe the image (alt text)', alt,
        'What it shows, for people who cannot see it. Required.'), h('div', { class: 'cms-action-row' }, go));
    } else if (opts.mode === 'photo') {
      const go = h('button', { type: 'button', class: 'cms-btn cms-btn-primary', 'data-action': 'media-use' }, 'Use as photo');
      go.addEventListener('click', () => {
        if (!chosen) { showProblem(problem, 'Pick an image first.'); return; }
        opts.onUse(chosen);
      });
      useRow = h('div', { class: 'cms-action-row' }, go);
    }

    fillPick().catch((e) => { if (!quiet(e)) showProblem(problem, `The site's image list could not be read: ${(e && e.message) || e}`); });
    return h('section', { class: 'cms-media-panel cms-panel', 'aria-label': 'Media' },
      h('p', { class: 'cms-media-row' }, h('label', null, 'Upload to ', folder), ' ', file, ' ', up),
      h('p', { class: 'cms-hint', text: C.SIZE_HINT_TEXT }),
      opts.mode === 'library' ? null : h('p', { class: 'cms-media-row' }, h('label', null, 'Or use one the site has: ', pick)),
      chosenBox, status, problem, useRow);
  }

  function sizeText(b) {
    if (!Number.isInteger(b) || b <= 0) return '';
    return b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
  }

  /* One image of the list: thumbnail, name, size, whether the site uses
     it, and Rename / Delete (only for an image the live site does not use:
     otherwise the line says to remove it from the page first). */
  function assetTile(asset, live) {
    let a = asset;
    const tile = h('figure', { class: 'cms-media-tile' });
    const line = h('p', { class: 'cms-problem', role: 'alert', hidden: true });
    const renameBox = h('div', { class: 'cms-media-rename' });
    const refusal = () => C.mediaChangeProblem(a.public_id, live, draftAssets());

    async function remove() {
      const why = refusal();
      if (why) { showProblem(line, why); return; }
      if (!window.confirm(`Delete ${a.public_id} from Cloudinary? This cannot be undone.`)) return;
      try {
        const out = await mediaCall('destroy', a.public_id);
        if (!out.ok) { showProblem(line, out.message); return; }
        tile.remove();
      } catch (e) {
        if (!quiet(e)) showProblem(line, `Something went wrong: ${(e && e.message) || e}`);
      }
    }

    function openRename() {
      const why = refusal();
      if (why) { showProblem(line, why); return; }
      const box = field('input', 'media-new-name', { autocomplete: 'off', 'aria-label': 'New name' });
      box.value = a.public_id.split('/').pop();
      const save = h('button', { type: 'button', class: 'cms-btn', 'data-action': 'media-rename-save' }, 'Save the name');
      save.addEventListener('click', async () => {
        const slug = String(box.value).trim();
        if (!C.MEDIA_SLUG_RE.test(slug)) { showProblem(line, 'A name is lowercase letters, digits and dashes (at most 80).'); return; }
        const to = `${a.public_id.slice(0, a.public_id.lastIndexOf('/'))}/${slug}`;
        if (to === a.public_id) { showProblem(line, 'That is its name already.'); return; }
        save.disabled = true;
        try {
          const out = await mediaCall('rename', a.public_id, to);
          if (!out.ok) { showProblem(line, out.message); return; }
          a = Object.assign({}, a, { public_id: typeof out.data.public_id === 'string' ? out.data.public_id : to,
            url: typeof out.data.url === 'string' ? out.data.url : a.url });
          showProblem(line, '');
          renameBox.replaceChildren();
          draw();
        } catch (e) {
          if (!quiet(e)) showProblem(line, `Something went wrong: ${(e && e.message) || e}`);
        } finally {
          save.disabled = false;
        }
      });
      showProblem(line, '');
      renameBox.replaceChildren(h('label', null, 'New name: ', box), save);
    }

    function draw() {
      const inUse = live.some((x) => x.public_id === a.public_id);
      const inDraft = !inUse && draftAssets().some((x) => x.public_id === a.public_id);
      const thumb = C.thumbUrl(a.url);
      const ren = h('button', { type: 'button', class: 'cms-btn', 'data-action': 'media-rename' }, 'Rename');
      const del = h('button', { type: 'button', class: 'cms-btn', 'data-action': 'media-delete' }, 'Delete');
      ren.addEventListener('click', openRename);
      del.addEventListener('click', remove);
      const dims = Number.isInteger(a.width) && Number.isInteger(a.height) ? ` · ${a.width}×${a.height}` : '';
      tile.setAttribute('data-asset', a.public_id);
      tile.replaceChildren(
        thumb ? h('img', { class: 'cms-media-thumb', src: thumb, alt: '', loading: 'lazy' })
          : h('div', { class: 'cms-media-thumb cms-muted', text: 'no preview' }),
        h('figcaption', null, h('code', { text: a.public_id }), h('span', { class: 'cms-meta',
          text: `${sizeText(a.bytes)}${dims} · ${inUse ? 'on the site' : (inDraft ? 'in your image-list draft' : 'not used by the site')}` })),
        h('div', { class: 'cms-action-row' }, ren, del), renameBox, line);
    }
    draw();
    return tile;
  }

  async function viewMedia(r, epoch) {
    if (!canEdit()) {
      paint(epoch, [h('h1', { text: 'Media' }), h('p', { class: 'cms-muted', text: 'View only: managing the site\'s '
        + 'images needs write access to this site\'s repository.' })]);
      return;
    }
    const live = await liveAssets();
    const grid = h('div', { class: 'cms-media-grid' });
    const more = h('div', { class: 'cms-action-row' });
    const listNote = h('p', { class: 'cms-muted', text: 'Loading the images…' });
    const draftBox = h('div');

    function renderDraft() {
      const d = openManifestDraft();
      if (!d) { draftBox.replaceChildren(); return; }
      const before = new Set(C.manifestAssets(C.parseManifest(d.originals[C.MANIFEST_FILE])).map((a) => a.public_id));
      const added = draftAssets().filter((a) => !before.has(a.public_id));
      const discard = h('button', { type: 'button', class: 'cms-btn', 'data-action': 'media-discard' }, 'Discard the image-list draft');
      discard.addEventListener('click', () => {
        if (!window.confirm('Throw away your image-list draft? The images stay on Cloudinary, unused; you can delete them here.')) return;
        drafts.remove(C.MANIFEST_KEY);
        renderDraft();
      });
      draftBox.replaceChildren(h('section', { class: 'cms-panel', 'data-manifest-draft': '' },
        h('h2', { text: 'Your image-list draft, not proposed yet' }),
        d.base.number ? h('p', { class: 'cms-muted', text: `Building on your proposal #${d.base.number}.` }) : null,
        h('ul', null, ...added.map((a) => h('li', null, h('code', { text: a.public_id })))),
        h('p', { class: 'cms-muted', text: 'Use each new image on a page in the same proposal: the site\'s rules refuse '
          + 'an image nothing uses. Open the page under Edit, press "Image from Media" and pick it.' }),
        h('div', { class: 'cms-action-row' }, discard)));
    }

    async function loadPage(cursor) {
      const out = await mediaCall('list', cursor);
      if (epoch !== routeEpoch) return;
      if (!out.ok) { showProblem(listNote, out.message); return; }
      const assets = Array.isArray(out.data.assets) ? out.data.assets : [];
      for (const a of assets) {
        if (a && typeof a === 'object' && typeof a.public_id === 'string') grid.appendChild(assetTile(a, live));
      }
      listNote.textContent = grid.childNodes.length ? '' : 'No images on Cloudinary yet.';
      listNote.hidden = !listNote.textContent;
      more.replaceChildren();
      const next = out.data.next_cursor;
      if (typeof next === 'string' && next) {
        const btn = h('button', { type: 'button', class: 'cms-btn', 'data-action': 'media-more' }, 'More images');
        btn.addEventListener('click', () => {
          btn.disabled = true;
          loadPage(next).catch((e) => { if (!quiet(e)) { btn.disabled = false; showProblem(listNote, `Something went wrong: ${(e && e.message) || e}`); } });
        });
        more.appendChild(btn);
      }
    }

    if (!paint(epoch, [
      h('h1', { text: 'Media' }),
      h('p', { class: 'cms-muted', text: 'The site\'s images, stored on Cloudinary. A new image goes into your image-list '
        + 'draft and is proposed together with the page that uses it.' }),
      draftBox,
      h('h2', { text: 'Upload' }),
      mediaPanel({ mode: 'library', baseOf: () => (openManifestDraft() || { base: MAIN_BASE }).base, onUploaded: renderDraft }),
      h('h2', { text: 'On Cloudinary' }),
      listNote, grid, more,
    ])) return;
    renderDraft();
    await loadPage(null);
  }

  function viewNotFound(r, epoch) {
    paint(epoch, [h('h1', { text: 'Not found' }),
      h('p', null, 'The editor has no page here. ', link('#/', 'Go to the Proposals tab'), '.')]);
  }

  /* The View tab: my own settings for the frame (plan D-H: localStorage
     hc-editor-view only, never the repository). A change is saved and the
     frame is told at once. */
  function currentView() {
    return ed.view || C.viewSettings.load(localStore());
  }

  function setView(key, value) {
    const next = Object.assign({}, currentView(), { [key]: value });
    const ls = localStore();
    if (ls) C.viewSettings.save(ls, next);
    ed.view = C.viewSettings.load({ getItem: () => JSON.stringify(next) });   // cleaned, kept for this page
    postEditor();
    // "Show others' suggestions" changes what the page file IS (the composite or main): reload
    if (key === 'suggestions' && ed.on) frameTo(ed.route, false);
    route();
  }

  function viewSettingsPanel() {
    const v = currentView();
    const row = (label, hint, control) => h('div', { class: 'hc-setting' },
      h('span', null, label, h('small', { text: hint })), control);
    const toggle = (key, label, hint) => {
      const on = v[key] === true;
      const b = h('button', { type: 'button', role: 'switch', class: on ? 'hc-toggle is-on' : 'hc-toggle',
        'data-setting': key, 'aria-checked': on ? 'true' : 'false', 'aria-label': label });
      b.addEventListener('click', () => setView(key, !on));
      return row(label, hint, b);
    };
    const seg = h('span', { class: 'hc-seg', role: 'group', 'aria-label': 'Diff style' },
      ...C.viewSettings.DIFFS.map((d) => {
        const b = h('button', { type: 'button', 'data-setting': 'diff', 'data-value': d,
          'aria-pressed': v.diff === d ? 'true' : 'false' }, d === 'side' ? 'Side by side' : 'Inline');
        b.addEventListener('click', () => setView('diff', d));
        return b;
      }));
    return [
      h('h2', { text: 'Your view' }),
      h('div', { class: 'hc-settings' },
        toggle('suggestions', 'Show others\u2019 suggestions', 'Open proposals drawn on the page'),
        row('Diff style', 'How a changed block is shown', seg),
        toggle('compact', 'Compact mode', 'Tighter text and code'),
        toggle('outlines', 'Outline editable blocks', 'Show the frame on hover')),
      h('p', { class: 'hc-foot', text: 'These settings are yours only. They live in this browser (localStorage) '
        + 'and never touch the repository or what visitors see.' }),
    ];
  }

  const VIEWS = {
    home: viewProposals,
    review: viewProposals,
    'review-pr': viewProposals,
    help: viewHelp,
    private: viewHelp,
    pages: viewChanges,
    edit: viewEdit,
    new: viewNew,
    media: viewMedia,
    'not-found': viewNotFound,
  };
  const NEEDS_SIGN_IN = new Set(['home', 'review', 'review-pr', 'pages', 'edit', 'new', 'media']);

  // ---------------------------------------------------- the tray's router ---
  /* The tray's views route on trayHash — the tray's own "#/…" in
     HCCore.parseRoute's grammar, as /cms/ had them — never on the site's
     hash, which is the page on screen. A tray link whose href starts "#/"
     moves the tray (onTrayClick), and the tab follows the view: home,
     review, review-pr -> Proposals; pages (the Changes home), edit, new ->
     Changes; media -> Media; help, private -> Guide; '#/view' -> View. Each
     tab keeps its last hash. The router draws only while Editor mode is on
     and the tray is open, so nothing is read from GitHub for a tray nobody
     sees. */

  const VIEW_HASH = '#/view';
  const TAB_OF_VIEW = Object.freeze({ home: 'proposals', review: 'proposals', 'review-pr': 'proposals',
    'not-found': 'proposals', pages: 'changes', edit: 'changes', new: 'changes', media: 'media',
    help: 'guide', private: 'guide' });
  const tabOfHash = (hash) => (hash === VIEW_HASH ? 'view' : TAB_OF_VIEW[C.parseRoute(hash).name] || 'proposals');

  function trayGo(hash) {
    trayHash = hash;
    const tab = tabOfHash(hash);
    ed.tabHash[tab] = hash;
    if (tab !== ed.tab) {
      ed.tab = tab;
      saveEditorState();
    }
    drawTabs();
    route();
  }

  async function route() {
    if (!tray || !ed.on || !ed.trayOpen) return;
    if (editing && trayHash !== editing.hash && !leaveOk()) {
      // "stay": the edit page stays on screen, and its tab with it
      trayHash = editing.hash;
      ed.tab = tabOfHash(trayHash);
      ed.tabHash[ed.tab] = trayHash;
      saveEditorState();
      drawTabs();
      return;
    }
    editing = null;
    clearTimeout(previewTimer);
    routeEpoch += 1;
    const epoch = routeEpoch;
    clearPreviews();
    draftList = null;
    if (trayHash === VIEW_HASH) {
      paint(epoch, viewSettingsPanel());
      return;
    }
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
  const TABS = Object.freeze(['proposals', 'changes', 'media', 'view', 'guide']);
  const TAB_LABEL = Object.freeze({ proposals: 'Proposals', changes: 'Changes', media: 'Media', view: 'View',
    guide: 'Guide' });
  const TAB_HASH = Object.freeze({ proposals: '#/', changes: '#/pages', media: '#/media', view: VIEW_HASH,
    guide: '#/help' });
  const PHONE_QUERY = '(max-width: 767px)';
  const EDITOR_PARAMS = Object.freeze(['editor', 'pr', 'data', 'new']);
  const ROUTE_RE = /^\/(?!\/)[^\x00-\x1f\x7f]{0,500}$/;
  const MAX_INDEX = 100000;
  const FRAME_DELAY_MS = 600;
  const ed = {
    on: false,
    tab: 'proposals',     // the tray's tab
    trayOpen: false,      // the tray is open (else the handle shows)
    tabHash: Object.assign({}, TAB_HASH),   // each tab's last tray hash
    count: null,          // open proposals, once read
    show: null,           // {number, sha, changed: Map file -> 'changed'|'removed'}: "Show on page"
    view: null,           // the View settings, once changed on this page
    pendingSelect: null,  // the text range the Changes tab selects once drawn
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
    wholeReason: null,    // why block editing is off for this page, or null
    mainSha: null,        // Promise of main's head sha, once per refresh
    cache: null,          // HCCore.cachedFetcher over this session's token
    pv: null,             // what this load shows (pageView): mode, the proposal, its overlay and marks
    barNote: null,        // {number, head, text}: Update from main's outcome, said on the bar at that head
    props: null,          // Promise of the open proposals with their files, once per refresh
    bases: new Map(),     // 'main...head' -> Promise of the merge base sha
    checks: new Map(),    // head sha -> Promise of HCCore.checkStatus
  };
  let frameTimer = null;

  function readEditorState() {
    const s = store();
    try {
      const v = s ? JSON.parse(s.getItem(EDITOR_KEY)) : null;
      if (!v || typeof v !== 'object') return null;
      return { on: v.on === true, tab: TABS.indexOf(v.tab) >= 0 ? v.tab : 'proposals', tray: v.tray === true };
    } catch (e) {
      return null;
    }
  }

  function saveEditorState() {
    const s = store();
    try {
      if (s) s.setItem(EDITOR_KEY, JSON.stringify({ on: ed.on, tab: ed.tab, tray: ed.trayOpen }));
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
    if (seg[0] === 'about' && seg.length === 1) return 'about';
    return null;
  }

  function pageForRoute(route) {
    const pageId = pageIdForRoute(route);
    const file = pageId && state.regs ? C.editPath(pageId, state.regs) : null;
    if (!file) return null;
    const hit = C.pageList(state.regs).find((p) => p.pageId === pageId);
    return { pageId, file, label: hit ? hit.title : pageId,
      route: C.routeForPage(pageId, state.regs) || String(route).split('@')[0] };
  }
  const samePage = (a, b) => Boolean(a && b && a.pageId === b.pageId);

  /* #/<route>?editor=<tab>[&pr=<n>] (D-H, and D-I's data= / new=): read,
     then stripped from the address with history.replaceState (no
     hashchange). -> {tab, pr, data, new} | null */
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
    return { tab: TABS.indexOf(tab) >= 0 ? tab : 'proposals',
      pr: /^[1-9][0-9]{0,8}$/.test(String(pr)) ? Number(pr) : null, data: get('data'), new: get('new') };
  }

  function setEditor(on) {
    if (on && (state.access !== 'ok' || !frameHost)) {
      if (!frameHost) say('This page has no place for the Editor frame.', 'error');
      return;
    }
    ed.on = on;
    if (!on) ed.show = null;
    document.body.classList.toggle('hc-editor-on', on);
    if (frameHost) frameHost.hidden = !on;
    applyTray();
    drawShowBar();
    renderChrome();
    if (!on) {
      clearTimeout(frameTimer);
      dropFrame();
      clearSelection();
      clearPreviews();
      membersSoon();             // the page under the frame: members-only detail again
      return;
    }
    if (ed.trayOpen) renderTray();
    if (!(ed.trayOpen && ed.tab === 'proposals')) loadCount();   // the Proposals tab reads it itself
    frameTo(currentRoute(), false);
  }

  /* The tray's open/closed state: the tray, or the handle, and the layout's room. */
  function applyTray() {
    if (!tray) return;
    const open = ed.on && ed.trayOpen;
    tray.hidden = !open;
    handle.hidden = !(ed.on && !ed.trayOpen);
    document.body.classList.toggle('hc-tray-open', open);
    saveEditorState();
  }

  function openTray() {
    ed.trayOpen = true;
    applyTray();
    renderTray();
  }

  function closeTray() {
    ed.trayOpen = false;
    applyTray();
  }

  function drawTabs() {
    for (const b of tabButtons) {
      const on = b.getAttribute('data-tab') === ed.tab;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.classList.toggle('is-on', on);
    }
  }

  /* The open proposals' count: on the Proposals tab and the handle. */
  function setCount(n) {
    ed.count = n;
    countEl.textContent = n > 0 ? String(n) : '';
    handle.replaceChildren(document.createTextNode('Editor · '),
      h('span', { class: 'n', text: `${n} proposal${n === 1 ? '' : 's'}` }));
  }

  function loadCount() {
    const gen = sessionGen.current();
    openPulls().then((pulls) => {
      if (sessionGen.isCurrent(gen)) setCount(C.orderOpenPulls(pulls, null).length);
    }).catch(() => { /* the handle keeps saying "Editor" */ });
  }

  /* The Changes tab's home, open (a block was picked or inserted). */
  function showChanges(select) {
    ed.pendingSelect = select || null;
    ed.trayOpen = true;
    applyTray();
    trayGo(TAB_HASH.changes);
  }

  /* Redraw the Changes home when it is on screen (the page moved). */
  function refreshChanges() {
    if (ed.on && ed.trayOpen && ed.tab === 'changes' && C.parseRoute(trayHash).name === 'pages') route();
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
    drawShowBar();
    if (route2 && ROUTE_RE.test(route2) && route2 !== currentRoute()) {
      window.location.hash = `#${route2}`;       // onHashChange loads the frame there
      return;
    }
    frameTo(currentRoute(), false);
  }

  function showOff() {
    ed.show = null;
    say('');
    drawShowBar();
    frameTo(currentRoute(), false);
  }

  function drawShowBar() {
    if (!showBar) return;
    if (!ed.show) { showBar.replaceChildren(); showBar.hidden = true; return; }
    const back = h('button', { type: 'button', class: 'cms-btn', 'data-action': 'show-off' }, 'Back to your view');
    back.addEventListener('click', showOff);
    showBar.replaceChildren(h('span', { text: `Showing proposal #${ed.show.number} on the page (read-only).` }), back);
    showBar.hidden = false;
  }

  /* While a proposal is shown, nothing on the page is edited. */
  function showing() {
    if (!ed.show) return false;
    say(`You are looking at proposal #${ed.show.number}. Press "Back to your view" to edit.`);
    return true;
  }

  /* ?editor=<tab>[&pr=<n>|&data=<x>|&new=<kind>] (D-H, D-I): the tray opens
     on that tab, at that proposal's card or that form. */
  function applyParam(param) {
    ed.tab = param.tab;
    ed.trayOpen = true;
    let hash = TAB_HASH[param.tab];
    if (param.tab === 'proposals' && param.pr) hash = `#/review/${param.pr}`;
    else if (param.tab === 'changes' && C.RAW_REGISTRIES.indexOf(`data/${param.data}.json`) >= 0) hash = `#/edit/data/${param.data}`;
    else if (param.tab === 'changes' && (param.new === 'project' || param.new === 'person')) hash = `#/new/${param.new}`;
    ed.tabHash[param.tab] = hash;
  }

  function mountFrame() {
    const frame = h('iframe', { class: 'hc-frame', title: 'This page, in Editor mode',
      sandbox: 'allow-scripts allow-popups', referrerpolicy: 'no-referrer' });
    pageBar = h('div', { class: 'hc-pagebar', role: 'status', 'aria-label': 'Proposals on this page' });
    pageBar.hidden = true;
    frameHost.replaceChildren(pageBar, frame);
    ed.frame = frame;
    ed.host = C.createPreviewHost({
      getFrameWindow: () => frame.contentWindow,
      setFrameSrc: (url) => { frame.src = url; },
      getRandomValues: randomValues,
      base: 'index.html',
    });
  }

  function dropFrame() {
    if (ed.host) ed.host.dispose();
    if (ed.frame) ed.frame.remove();
    if (pageBar) pageBar.remove();
    pageBar = null;
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
    ed.wholeReason = null;
    ed.draft = null;
  }

  /* My changed draft of this page, when it builds on the live site. */
  function storedDraft(page) {
    const d = page ? drafts.get(page.pageId) : null;
    return d && C.isDirty(d) && d.base.number === null
      && Object.prototype.hasOwnProperty.call(d.files, page.file) ? d : null;
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
      ed.barNote = null;
    }
    ed.route = route;
    ed.page = page;
    if (!ed.draft) ed.draft = storedDraft(page);
    // what this load shows (D-G): the reads are memoized, so a reload after an edit asks nothing
    let pv;
    try {
      pv = await pageView(page, sha);
    } catch (e) {
      if (quiet(e)) return;
      pv = blankView(page);
    }
    if (mine !== ed.loads || !sessionGen.isCurrent(gen) || !ed.on || !ed.host) return;
    ed.pv = pv;
    drawPageBar();
    ed.prefix = null;
    ed.ready = false;     // a new document: it hears nothing until its own hc-ready
    const nonce = ed.host.load(route, frameFetcher);
    // frameFetcher reads it at call time: the frame asks only after it loaded
    ed.prefix = nonce.slice(0, 16);
    if (moved) {
      markPage();
      refreshChanges();
    }
  }

  /* What the frame reads: the drafts on the same commit from memory (this
     page's first), everything else at that commit through the session's
     cache — and the page on screen with this load's sentinels. */
  async function frameFetcher(p) {
    const prefix = ed.prefix;
    const page = ed.page;
    const show = ed.show;
    const pv = ed.pv;
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
    if (!answer.ok || !page || p !== page.file || !prefix) return answer;
    const marked = C.withSentinels(answer.text, prefix);
    return marked === null ? answer : { ok: true, status: answer.status, text: marked };
  }

  function draftFiles(sha) {
    const files = {};
    for (const d of drafts.dirty()) {
      if (d.base.sha === sha && d.base.number === null) Object.assign(files, d.files);
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
    ov: null, marks: [], touching: [], others: [], check: null, failed: false });

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
    let t = null;
    if (ed.show) {
      t = pv.touching.find((x) => x.pull.number === ed.show.number) || null;
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

  /* The reader followed a link inside the frame to another page: its bar
     follows; a page with a proposal to draw is loaded again with it. */
  async function viewAfterRoute(page) {
    const mine = ed.loads;
    ed.pv = blankView(page);
    drawPageBar();
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
    drawPageBar();
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

  /* The proposal's card, open, in the tray's Proposals tab. */
  function openCard(n) {
    ed.trayOpen = true;
    applyTray();
    trayGo(`#/review/${n}`);
  }

  /* The bar's Update from main (the one write here; D8 roles, exactly as
     the card's button). GitHub takes it (202) and moves the branch a moment
     later: the proposal is read again, a few times a moment apart, until its
     head moved; then the page view, the bar and the frame are drawn again
     from it by frameTo, the same path as a route load (its reads are
     memoized again, so a later edit's reload still asks nothing). The page
     redrawn is the one on screen THEN (the reader may have moved on while
     the proposal was read again; it may touch that page too). An error
     keeps the view on screen, with GitHub's answer beside the button. The
     tray card's own Update from main follows the same way (act). */
  const UPDATE_POLLS = 6;
  const UPDATE_POLL_MS = 1500;

  async function updateFromMain(pull, btn, line) {
    if (acting || !state.client) return;
    acting = true;
    btn.disabled = true;
    const gen = sessionGen.current();
    const old = headShaOf(pull);
    let out;
    try {
      out = await C.runReviewAction(state.client, 'update', { number: pull.number, sha: old });
    } catch (e) {
      out = { ok: false, status: 0, message: `Something went wrong: ${(e && e.message) || e}`, sent: false };
    } finally {
      acting = false;
    }
    if (!sessionGen.isCurrent(gen)) return;
    if (out.status === 401) { endSession('Your sign-in has ended. Please sign in again.'); return; }
    line.textContent = out.message;
    line.hidden = false;
    line.classList.toggle('is-error', !out.ok);
    if (!out.ok) { btn.disabled = false; return; }
    const now = await followUpdate(pull.number, old, gen);
    if (!now && sessionGen.isCurrent(gen) && ed.on) btn.disabled = false;   // "Reload in a moment" stays said
  }

  /* After GitHub took an Update from main on PR n (head `old`): wait for
     the head to move, forget the proposal reads (moved or not), and draw
     the page on screen NOW again from them — whichever page that is, so a
     page the reader moved to while waiting does not keep the old head's
     marks. -> the moved pull, or null (not in time, signed out, Editor off:
     then nothing is redrawn). */
  async function followUpdate(n, old, gen) {
    const now = await headMoved(n, old, gen);
    if (!sessionGen.isCurrent(gen) || !ed.on) return null;
    forgetProposals();                   // the next load reads the proposal again, moved or not
    if (!now) return null;
    ed.barNote = { number: n, head: headShaOf(now),
      text: `Updated from main: the page shows proposal #${n} as it is now.` };
    frameTo(ed.route, true);
    return now;
  }

  /* PR n read again until its head is no longer `old` (or it closed):
     -> that pull; null when it did not move in time or could not be read. */
  async function headMoved(n, old, gen) {
    for (let i = 0; i < UPDATE_POLLS; i += 1) {
      await new Promise((r) => { setTimeout(r, UPDATE_POLL_MS); });
      if (!sessionGen.isCurrent(gen) || !ed.on) return null;
      let res;
      try {
        res = await apiResponse(`${C.REPO_API_PATH}/pulls/${n}`);
      } catch (e) {
        return null;
      }
      if (!res.ok || !res.data) return null;
      if (res.data.state !== 'open' || headShaOf(res.data) !== old) return res.data;
    }
    return null;
  }

  const CHECK_WORD = Object.freeze({ pass: 'check green', fail: 'check red', checking: 'check pending',
    unknown: 'check unknown' });
  const plural = (n, one, many) => (n === 1 ? one : many);

  function pageBarButton(action, n, text, onClick, primary) {
    const b = h('button', { type: 'button', class: primary ? 'cms-btn cms-btn-primary' : 'cms-btn',
      'data-action': action, 'data-proposal': n === null ? null : String(n) }, text);
    b.addEventListener('click', onClick);
    return b;
  }

  // "Show on page" for proposal t (its head and files are known), else nothing
  function showButton(t, text) {
    const sha = headShaOf(t.pull);
    if (!sha || !t.files) return null;
    return pageBarButton('pagebar-show', t.pull.number, text, () => showProposal(t.pull.number, sha, t.files, null));
  }

  function touchingLine(pv, words) {
    const n = pv.touching.length;
    return h('p', { class: 'hc-pagebar-line' }, h('span', { text: words(n) }),
      ...pv.touching.map((t) => showButton(t, `Show #${t.pull.number} on page`)));
  }

  /* The page bar above the frame (D-G): who proposes changes to this page,
     the gate, and the way to the card; the others; my draft's note. All
     GitHub words go in as text. */
  function drawPageBar() {
    if (!pageBar) return;
    const pv = ed.pv;
    const rows = [];
    const back = () => pageBarButton('show-off', null, 'Back to your view', showOff);
    if (pv && pv.pr) {
      const n = pv.pr.number;
      const state2 = pv.check && CHECK_WORD[pv.check.state] ? pv.check.state : 'unknown';
      rows.push(h('p', { class: 'hc-pagebar-line' },
        h('b', { text: pv.mode === 'show' ? `Showing proposal #${n} by ${loginOf(pv.pr)} on the page (read-only)`
          : `${loginOf(pv.pr)} proposes changes to this page` }),
        h('span', { class: 'hc-pagebar-sep', 'aria-hidden': 'true', text: '·' }), link(prLink(n), `PR #${n}`),
        h('span', { class: 'hc-pagebar-sep', 'aria-hidden': 'true', text: '·' }),
        h('span', { class: `hc-pagebar-check is-${state2}`, text: CHECK_WORD[state2] }),
        pageBarButton('review-in-tray', n, 'Review in tray', () => openCard(n), true),
        pv.mode === 'show' ? back() : null));
      const note = ed.barNote;
      if (note && note.number === n && note.head === headShaOf(pv.pr)) {
        rows.push(h('p', { class: 'hc-pagebar-line' },
          h('span', { class: 'hc-pagebar-result', role: 'status', text: note.text })));
      }
      if (pv.failed) {
        rows.push(h('p', { class: 'hc-pagebar-line is-warn',
          text: `PR #${n}: this proposal can't be shown in place — open it in the tray.` }));
      }
      const conflicts = pv.ov ? pv.ov.conflicts.length : 0;
      if (conflicts) {
        const result = h('span', { class: 'hc-pagebar-result', role: 'status' });
        result.hidden = true;
        const may = pv.mode === 'overlay' && C.reviewActionsFor(state.role, pv.pr).indexOf('update') >= 0;
        let btn = null;
        if (may) {
          btn = pageBarButton('pagebar-update', n, 'Update from main', () => { updateFromMain(pv.pr, btn, result); });
        }
        rows.push(h('p', { class: 'hc-pagebar-line is-warn' },
          h('span', { text: `${conflicts} ${plural(conflicts, 'block', 'blocks')} marked: main changed this since the `
            + 'proposal — Update from main to bring it up to date.' }), btn, result));
      }
      if (pv.others.length) {
        rows.push(h('p', { class: 'hc-pagebar-line' }, h('span', { text: 'Also proposing changes here:' }),
          ...pv.others.map((t) => h('span', { class: 'hc-pagebar-other' },
            h('span', { text: `#${t.pull.number} by ${loginOf(t.pull)}` }), showButton(t, 'Show on page')))));
      }
    } else if (pv && pv.mode === 'show' && ed.show) {
      rows.push(h('p', { class: 'hc-pagebar-line' },
        h('b', { text: `Showing proposal #${ed.show.number} on the page (read-only)` }), back()));
    } else if (pv && pv.mode === 'draft' && pv.touching.length) {
      rows.push(touchingLine(pv, (k) => `${k} open ${plural(k, 'proposal also touches', 'proposals also touch')} this page`));
    } else if (pv && pv.mode === 'hidden') {
      rows.push(touchingLine(pv, (k) => `${k} open ${plural(k, 'proposal touches', 'proposals touch')} this page `
        + '("Show others’ suggestions" is off in View)'));
    }
    pageBar.replaceChildren(...rows);
    pageBar.hidden = !rows.length;
  }

  /* hc-editor goes to the frame only once THIS load said hc-ready: before
     that the window may still hold another document. A post held back is
     not queued: the hc-ready answer carries the state as it is then. */
  function postEditor() {
    const w = ed.frame && ed.frame.contentWindow;
    const nonce = ed.host && ed.host.nonce();
    if (!w || !nonce || !ed.ready) return;
    w.postMessage({ type: 'hc-editor', nonce, on: true, settings: currentView(),
      selected: ed.selected, overlay: ed.pv ? ed.pv.marks : [] }, '*');
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
    if (m.type === 'hc-ready') { ed.ready = true; postEditor(); }
    else if (m.type === 'hc-route' && typeof m.route === 'string' && ROUTE_RE.test(m.route)) frameRouted(m.route);
    else if (m.type === 'hc-block-select' && index !== null) pick(index).catch(shown);
    else if (m.type === 'hc-block-insert' && index !== null && typeof m.kind === 'string') pickInsert(index, m.kind).catch(shown);
    return true;
  }
  const shown = (e) => { if (!quiet(e)) say(`Something went wrong: ${(e && e.message) || e}`, 'error'); };

  /* The reader followed a link inside the frame: the parent's hash follows
     (js/app.js repaints the sidebar, the nav and the title), and the frame is
     NOT reloaded — onHashChange knows this change is the frame's. */
  function frameRouted(route) {
    const page = pageForRoute(route);
    if (!samePage(page, ed.page)) {
      clearSelection();
      ed.draft = storedDraft(page);
    }
    const moved = !samePage(page, ed.page);
    ed.route = route;
    ed.page = page;
    if (moved) {
      markPage();
      refreshChanges();
      viewAfterRoute(page);
    }
    if (currentRoute() === route) return;
    ed.fromFrame = route;
    window.location.hash = `#${route}`;
  }

  function onHashChange() {
    const param = takeEditorParam();
    if (param) {
      applyParam(param);
      saveEditorState();
      if (!ed.on) { setEditor(true); return; }
      applyTray();
      renderTray();
    }
    const r = currentRoute();
    const ours = ed.fromFrame !== null && r === ed.fromFrame;
    ed.fromFrame = null;
    if (ours || !ed.on) return;
    frameTo(r, false);
  }

  /* The draft of `page`: the one in memory, else a fresh one from main's
     head (read through the cache: the frame has usually read it already). */
  async function pageDraft(page) {
    if (ed.draft && ed.draft.key === page.pageId) return ed.draft;
    const sha = await mainSha();
    const answer = await sessionCache().get(sha, page.file);
    if (!answer.ok) throw new Error(`GitHub answered HTTP ${answer.status} for ${page.file}`);
    return { key: page.pageId, label: page.label, route: page.route, files: { [page.file]: answer.text },
      originals: { [page.file]: answer.text }, base: { ref: 'main', sha, number: null } };
  }

  /* The index of the block a position starts, in the split of `text`
     (display only: the edit itself is the span). */
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
    if (!page || showing()) return;
    const d = await pageDraft(page);
    if (ed.page !== page || ed.show) return;
    ed.draft = d;
    const text = d.files[page.file];
    const split = C.splitBlocks(text);
    if (!split.ok) {
      Object.assign(ed, { wholeReason: split.reason, sel: null, selected: null });
      showChanges(null);
      return;
    }
    const span = C.spanOf(text, index);
    if (!span) return;
    Object.assign(ed, { wholeReason: null, selected: index,
      sel: { key: d.key, file: page.file, span, whole: false } });
    showChanges(null);
    if (reload) frameTo(ed.route, true);
    else postEditor();
  }

  async function insertBlock(index, kind) {
    const page = ed.page;
    if (!page || !canEdit() || !Object.prototype.hasOwnProperty.call(C.SNIPPET_CATALOG, kind) || showing()) return;
    const d = await pageDraft(page);
    if (ed.page !== page || ed.show) return;
    const out = C.insertAt(d.files[page.file], index, kind);
    if (!out) return;
    ed.draft = d;
    d.files[page.file] = out.text;
    drafts.put(d);
    Object.assign(ed, { wholeReason: null, selected: blockIndexAt(out.text, out.span.start),
      sel: { key: d.key, file: page.file, span: out.span, whole: false } });
    showChanges({ start: out.select.start - out.span.start, end: out.select.end - out.span.start });
    frameTo(ed.route, true);
  }

  async function editWholePage() {
    const page = ed.page;
    if (!page || showing()) return;
    const d = await pageDraft(page);
    if (ed.page !== page || ed.show) return;
    ed.draft = d;
    Object.assign(ed, { selected: null,
      sel: { key: d.key, file: page.file, span: { start: 0, end: d.files[page.file].length }, whole: true } });
    showChanges(null);
    if (ed.pv && ed.pv.ov) frameTo(ed.route, true);    // a proposal was drawn: show the page I edit
    else postEditor();
  }

  const draftStateText = (d) => (C.isDirty(d) ? 'Changed — kept as a draft in this tab, not proposed yet.'
    : 'No changes yet.');

  /* One keystroke in the tray's textarea: the span is replaced (never the
     text around it), the draft kept, and the frame reloaded a moment later. */
  function blockChanged(ta, line) {
    const d = ed.draft;
    const sel = ed.sel;
    if (!d || !sel || !canEdit() || d.key !== sel.key) return;
    const out = C.replaceSpan(d.files[sel.file], sel.span, ta.value);
    d.files[sel.file] = out.text;
    sel.span = out.span;
    if (C.isDirty(d)) drafts.put(d); else drafts.remove(d.key);
    if (sel.whole) sel.span = { start: 0, end: out.text.length };
    ed.selected = sel.whole ? null : blockIndexAt(out.text, out.span.start);
    line.textContent = draftStateText(d);
    drawDraftList(false);
    clearTimeout(frameTimer);
    frameTimer = setTimeout(() => frameTo(ed.route, true), FRAME_DELAY_MS);
  }

  /* The Changes tab: the picked block (or the whole page) as Markdown. */
  function changesPanel() {
    const page = ed.page;
    const out = [h('h2', { class: 'hc-tray-title', text: 'Changes' })];
    const box = (ta) => ({ node: h('section', { class: 'hc-changes', 'aria-label': 'Changes' }, ...out), ta });
    if (!page) {
      out.push(h('p', { class: 'cms-muted', text: 'The editor opens setup, project, tool and About pages. '
        + 'Go to one of them to edit it.' }));
      return box(null);
    }
    out.push(h('p', { class: 'cms-meta' }, h('code', { text: page.file })));
    if (ed.wholeReason) {
      out.push(h('p', { class: 'hc-reason', role: 'status', text: `Block editing is off for this page: ${ed.wholeReason}.` }));
    }
    const whole = h('button', { type: 'button', class: 'cms-btn', 'data-action': 'edit-whole-page' },
      'Edit whole page as Markdown');
    whole.addEventListener('click', () => { editWholePage().catch(shown); });
    const sel = ed.sel && ed.draft && ed.sel.key === ed.draft.key ? ed.sel : null;
    if (!sel) {
      if (!ed.wholeReason) {
        out.push(h('p', { class: 'cms-muted', text: 'Click a block on the page (the pencil) to edit it, '
          + 'or "+" between two blocks to add one.' }));
      }
      out.push(h('div', { class: 'cms-action-row' }, whole));
      return box(null);
    }
    const ta = h('textarea', { class: 'cms-editor-text hc-block-text', 'data-block-editor': true, rows: 12,
      spellcheck: 'true', 'aria-label': sel.whole ? `Text of ${sel.file}` : 'This block, as Markdown' });
    ta.value = ed.draft.files[sel.file].slice(sel.span.start, sel.span.end);
    ta.readOnly = !canEdit();
    const line = h('p', { class: 'cms-draft-state cms-muted', role: 'status', text: canEdit()
      ? draftStateText(ed.draft) : 'View only: changing pages needs write access to this site\'s repository.' });
    ta.addEventListener('input', () => blockChanged(ta, line));
    // a snippet, a link or an image goes in at the cursor, inside the span
    const replaceText = (next, selStart, selEnd) => {
      ta.value = next;
      ta.focus();
      ta.setSelectionRange(selStart, selEnd);
      blockChanged(ta, line);
    };
    out.push(h('p', { class: 'hc-block-label', text: sel.whole ? 'The whole page, as Markdown' : 'This block, as Markdown' }),
      canEdit() ? snippetBar(ta, replaceText, ed.draft) : null,
      ta, line, sel.whole ? null : h('div', { class: 'cms-action-row' }, whole));
    return box(ta);
  }

  /* The tray at its tab's last hash. */
  function renderTray() {
    if (!tray) return;
    trayGo(ed.tabHash[ed.tab] || TAB_HASH[ed.tab] || '#/');
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
    switchBtn.addEventListener('click', () => setEditor(!ed.on));
    who = h('span', { class: 'hc-who' });
    avatarBtn = h('button', { type: 'button', class: 'hc-avatar', 'data-action': 'avatar',
      'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'Your account', title: 'Your account' });
    avatarBtn.addEventListener('click', () => { if (menu.hidden) openMenu(); else closeMenu(); });
    const signOut = h('button', { type: 'button', role: 'menuitem', class: 'hc-menu-item', 'data-action': 'sign-out' },
      'Sign out');
    signOut.addEventListener('click', () => { closeMenu(); onSignOutClick(); });
    menuWho = h('p', { class: 'hc-menu-who' });
    menu = h('div', { class: 'hc-menu', role: 'menu', 'aria-label': 'Your account' }, menuWho, signOut);
    menu.hidden = true;
    const escape = (e) => { if (e && e.key === 'Escape') closeMenu(); };
    avatarBtn.addEventListener('keydown', escape);
    menu.addEventListener('keydown', escape);
    controls = h('span', { class: 'hc-editor-controls' }, switchBtn, who);
    const actions = document.querySelector('.header-actions');
    if (actions) actions.prepend(controls);
    notice = h('p', { class: 'hc-notice', role: 'status' });
    notice.hidden = true;
    countEl = h('span', { class: 'n' });
    tabButtons = TABS.map((id) => {
      const b = h('button', { type: 'button', role: 'tab', class: 'hc-tab', 'data-tab': id, 'aria-selected': 'false' },
        TAB_LABEL[id], id === 'proposals' ? countEl : null);
      b.addEventListener('click', () => { ed.tab = id; saveEditorState(); renderTray(); });
      return b;
    });
    const close = h('button', { type: 'button', class: 'hc-tray-close', 'data-action': 'tray-close',
      title: 'Hide the tray', 'aria-label': 'Hide the tray' }, '×');
    close.addEventListener('click', closeTray);
    showBar = h('div', { class: 'hc-showing', role: 'status' });
    showBar.hidden = true;
    main = h('div', { class: 'hc-tray-view' });
    trayBody = h('div', { class: 'hc-tray-body', role: 'tabpanel' }, main);
    trayBody.addEventListener('click', onTrayClick);
    tray = h('aside', { id: 'hc-tray', class: 'hc-tray', 'aria-label': 'Editor' },
      h('div', { class: 'hc-tray-tabs', role: 'tablist', 'aria-label': 'Editor' }, ...tabButtons, close),
      showBar, notice, trayBody);
    tray.hidden = true;
    handle = h('button', { type: 'button', class: 'hc-handle', 'data-action': 'tray-open', title: 'Open the Editor tray' },
      'Editor');
    handle.hidden = true;
    handle.addEventListener('click', openTray);
    document.body.appendChild(tray);
    document.body.appendChild(handle);
    // phones: the tray is a bottom sheet (css/editor.css); the class says so to scripts and tests
    const mq = typeof window.matchMedia === 'function' ? window.matchMedia(PHONE_QUERY) : null;
    if (mq) {
      const apply = () => document.body.classList.toggle('hc-phone', Boolean(mq.matches));
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
    if (!mem.files.has(p)) mem.files.set(p, Promise.resolve().then(() => HC.fetchJSON(p)).catch(() => null));
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

  const MEMBER_SURFACES = Object.freeze({ lab: decorateLab, people: decoratePeople, popover: decoratePopover,
    authors: decorateAuthors });

  /* Decorate every marked surface not yet done; a no-op unless membersOn().
     Members-only detail is a page-local extra: it never breaks the Editor. */
  function membersSweep() {
    clearTimeout(mem.timer);
    mem.timer = null;
    if (!membersOn()) return;
    let found = [];
    try { found = Array.from(document.querySelectorAll('[data-hc-surface]')); } catch (e) { found = []; }
    found.forEach((el) => {
      const decorate = MEMBER_SURFACES[el.getAttribute('data-hc-surface')];
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
    if (!given && !stored && !popup) return false;
    started = true;
    if (typeof o.fetch === 'function') fetchImpl = o.fetch;
    if (given) state.memoryOnly = given;
    mountChrome();
    membersMount();
    loadAvatars();
    window.addEventListener('message', onMessage);
    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('beforeunload', (e) => {
      if (!drafts.dirty().length) return;
      e.preventDefault();
      e.returnValue = '';            // the browser asks before the tab's drafts go
    });
    const param = takeEditorParam();
    const saved = readEditorState();
    if (param) applyParam(param);
    else if (saved) { ed.tab = saved.tab; ed.trayOpen = saved.tray; }
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

  window.HCEditor = Object.freeze({ start, mountPreview, refresh });
}());
