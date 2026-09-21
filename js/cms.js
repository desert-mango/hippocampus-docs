// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 21 September 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Draw the CMS signed-in area: sign-in popup, role badge, hash routes and the preview frame.
/* The editor's page (cms/index.html). Logic lives in js/cms-core.js
   (HCCore, node-tested); this file is the DOM around it.

   What it does today (unit U7a): sign in with GitHub in a popup, show who is
   signed in and their role on desert-mango/hippocampus-docs, list open and
   recently merged proposals, and draw the hash routes. It only READS from
   GitHub, and only this one repository (HCCore's client refuses any other
   path). The token lives in sessionStorage and in the client's closure; it is
   never put into the page, the preview frame, or a message.

   Seams for the next units (build on these, do not fork them):
     VIEWS              route name -> view function (route, epoch). U8 replaces
                        'review' and 'review-pr'; U7b 'edit' and 'new'; U9
                        'media'; U10 'private'. Until then the last four draw
                        the one-line github.com placeholder.
     api(path)          a GET through the signed-in client; a 401 ends the
                        session, and an answer for a session that has since
                        ended or been replaced is dropped (sessionGen).
                        U8/U7b add their write calls through
                        HCCore.createGitHubClient's send() (see cms-core.js).
     mountPreview(el, {route, fetcher})
                        puts the real site in a sandboxed frame under el and
                        answers its file requests through `fetcher` (HCCore
                        .refFetcher(token, sha) for a PR, .draftFetcher(files,
                        fallback) for a draft). Returns {load(route, fetcher),
                        destroy(), frame}. Every load gets a fresh nonce.
     #cms-preview-area  the empty area on #/review/<n> that U8 fills.
     window.HCCms       {mountPreview, refresh} — mountPreview is also how the
                        preview host is driven by hand from DevTools. */
(function () {
  'use strict';

  const C = window.HCCore;
  const $ = (id) => document.getElementById(id);
  const main = $('cms-main');
  const notice = $('cms-notice');
  const signInBtn = $('cms-sign-in');
  const signOutBtn = $('cms-sign-out');
  const who = $('cms-who');
  const nav = $('cms-nav');

  const state = {
    session: null,      // {token, expiresAt, login}
    client: null,       // HCCore GitHub client bound to the token
    user: null,         // GET /user
    role: null,         // HCCore.roleFromPermissions(...)
    access: 'none-yet', // 'none-yet' | 'checking' | 'ok' | 'no-access' | 'error'
    accessError: '',
    memoryOnly: null,   // the session, when sessionStorage refused to hold it
    regs: null,         // {setup, projects, tools} for the pencil links
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
  const randomValues = (arr) => window.crypto.getRandomValues(arr);
  // looked up at call time, so a stand-in for window.fetch set from DevTools
  // or a test harness reaches the client; the client and the sign-in are
  // its only callers
  const netFetch = (url, init) => window.fetch(url, init);

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
  const link = (href, text, cls) => h('a', { href, class: cls }, text);

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

  function prLink(n) { return `${C.GITHUB_WEB}/pull/${n}`; }
  function day(iso) {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '';
  }
  function loginOf(p) { return String((p && p.user && p.user.login) || 'unknown'); }

  // ---------------------------------------------------------- the client ---

  function endSession(message) {
    sessionGen.next();
    C.clearSession(store());
    Object.assign(state, { session: null, client: null, user: null, role: null,
      access: 'none-yet', accessError: '', memoryOnly: null });
    renderChrome();
    if (message) say(message, 'error');
    route();
  }

  /* A GET through the signed-in client, as {ok, status, data}. The answer
     belongs to the session that asked: when that session has since ended or
     been replaced, it is dropped (thrown as STALE, which route() swallows),
     so an old 401 never ends a newer session. A 401 for the current session
     (an expired or revoked token) ends it. */
  async function apiResponse(p) {
    if (!state.client) throw new Error('not signed in');
    const gen = sessionGen.current();
    const res = await state.client.get(p);
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
    openWindow: (url, name, features) => window.open(url, name, features),
    fetch: netFetch,
  });

  function watchPopup() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (signIn.pendingState() === null) { clearInterval(pollTimer); return; }
      if (signIn.popupClosed(Date.now())) {
        clearInterval(pollTimer);
        say('Sign-in was cancelled: the GitHub window closed before it finished.', 'error');
      }
    }, 400);
  }

  function onSignInClick() {
    say('');
    // start() opens the popup synchronously, inside this click
    signIn.start().then((res) => {
      if (!res.ok) { say(res.message, 'error'); return; }
      say('Finish signing in in the GitHub window…');
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
      if (sessionGen.isCurrent(gen)) say(`Sign-in failed: ${e.message}.`, 'error');
      return;
    }
    if (!sessionGen.isCurrent(gen)) return;
    const client = C.createGitHubClient({ fetch: netFetch, token: out.token });
    const me = await client.get('/user');
    if (!sessionGen.isCurrent(gen)) return;
    if (!me.ok || !me.data || typeof me.data.login !== 'string') {
      say('Signed in, but GitHub did not say who you are. Please sign in again.', 'error');
      return;
    }
    const record = C.makeSession(out.token, out.expiresIn, me.data.login, Date.now());
    state.memoryOnly = C.writeSession(store(), record) ? null : record;
    say(state.memoryOnly ? 'Signed in. This browser would not keep the sign-in, so it ends when you leave this page.' : '');
    await refresh();
  }

  function onSignOutClick() {
    signIn.cancel();
    endSession(null);
    say('Signed out.');
  }

  // ---------------------------------------------------- who is signed in ---

  /* Reads the session, then asks GitHub who this is and what they may do on
     THIS repository: GET /user and GET /repos/desert-mango/hippocampus-docs.
     A 404 from the repository means no access, and the page then says so
     and nothing else (D8). Each call is a new generation: when a newer
     refresh, a sign-in or a sign-out happened while GitHub answered, the
     answer is old and changes nothing. */
  async function refresh() {
    const gen = sessionGen.next();
    clearPreviews();
    const s = C.readSession(store(), Date.now()) || state.memoryOnly;
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
  }

  function renderChrome() {
    const signedIn = Boolean(state.session);
    signInBtn.hidden = signedIn;
    signOutBtn.hidden = !signedIn;
    nav.hidden = state.access === 'no-access';
    who.hidden = !signedIn;
    who.replaceChildren();
    if (!signedIn) return;
    const avatar = state.user && typeof state.user.avatar_url === 'string'
      && state.user.avatar_url.indexOf('https://avatars.githubusercontent.com/') === 0
      ? state.user.avatar_url : null;
    if (avatar) who.appendChild(h('img', { class: 'cms-avatar', src: avatar, alt: '', width: 24, height: 24 }));
    who.appendChild(h('span', { class: 'cms-login', text: state.session.login }));
    if (state.role && state.access === 'ok') {
      who.appendChild(h('span', { class: `cms-role cms-role-${state.role.key}`,
        title: 'Your role on this site\'s repository', text: state.role.label }));
    }
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

  function pullRow(p, login) {
    const mine = login && loginOf(p).toLowerCase() === login.toLowerCase();
    return h('li', null,
      h('span', { class: 'cms-num', text: `#${p.number}` }),
      link(`#/review/${p.number}`, String(p.title || '(no title)'), 'cms-title'),
      mine ? h('span', { class: 'cms-mine', text: 'yours' }) : null,
      h('span', { class: 'cms-meta', text: `by ${loginOf(p)}` }),
      link(prLink(p.number), 'on GitHub', 'cms-gh'));
  }

  function pullList(pulls, login, empty) {
    if (!pulls.length) return h('p', { class: 'cms-muted', text: empty });
    return h('ul', { class: 'cms-list' }, ...pulls.map((p) => pullRow(p, login)));
  }

  function openPulls() {
    return api(`${C.REPO_API_PATH}/pulls?state=open&per_page=100`);
  }

  async function viewHome(r, epoch) {
    paint(epoch, [h('h1', { text: 'Editor' }), h('p', { class: 'cms-muted', text: 'Loading proposals…' })]);
    // "Recently merged" pages the closed PRs until nothing unread can be newer
    const [open, merged] = await Promise.all([openPulls(), C.loadRecentMerges(api, 5)]);
    const login = state.session && state.session.login;
    const helpLinks = [
      h('li', null, link(C.PROTOCOLS_URL, 'Maintainer protocols'), ' — who reviews and merges, and how'),
      h('li', null, 'Edit any page on github.com: ',
        link(`${C.GITHUB_WEB}/tree/main/content`, 'open its file'), ' and click the pencil'),
    ];
    if (state.role && state.role.key === 'admin') {
      helpLinks.push(h('li', null, link(`${C.GITHUB_WEB}/settings/access`, 'Manage people'),
        ' — who can edit (GitHub settings)'));
    }
    paint(epoch, [
      h('h1', { text: 'Editor' }),
      h('h2', { text: 'Open proposals' }),
      pullList(C.orderOpenPulls(open, login), login, 'No open proposals.'),
      h('h2', { text: 'Recently merged' }),
      merged.length
        ? h('ul', { class: 'cms-list' }, ...merged.map((p) => h('li', null,
          h('span', { class: 'cms-num', text: `#${p.number}` }),
          h('span', { class: 'cms-title', text: String(p.title || '(no title)') }),
          h('span', { class: 'cms-meta', text: `by ${loginOf(p)}, merged ${day(p.merged_at)}` }),
          link(prLink(p.number), 'on GitHub', 'cms-gh'))))
        : h('p', { class: 'cms-muted', text: 'Nothing merged recently.' }),
      h('h2', { text: 'How to' }),
      h('ul', null, ...helpLinks),
    ]);
  }

  // U8 replaces this view with the Review tab.
  async function viewReview(r, epoch) {
    paint(epoch, [h('h1', { text: 'Review' }), h('p', { class: 'cms-muted', text: 'Loading proposals…' })]);
    const login = state.session && state.session.login;
    const open = await openPulls();
    paint(epoch, [
      h('h1', { text: 'Review' }),
      h('p', { class: 'cms-muted', text: 'Open proposals, yours first. Pick one to see it.' }),
      pullList(C.orderOpenPulls(open, login), login, 'No open proposals.'),
    ]);
  }

  // U8 replaces this view; #cms-preview-area is where its preview goes.
  async function viewReviewPr(r, epoch) {
    const n = r.params.number;
    paint(epoch, [h('h1', { text: `Proposal #${n}` }), h('p', { class: 'cms-muted', text: 'Loading…' })]);
    const res = await apiResponse(`${C.REPO_API_PATH}/pulls/${n}`);
    if (res.status === 404) {
      paint(epoch, [h('h1', { text: `Proposal #${n}` }),
        h('p', { text: `There is no proposal #${n} in this site's repository.` }), link('#/review', 'All proposals')]);
      return;
    }
    if (!res.ok || !res.data) throw new Error(res.status ? `GitHub answered HTTP ${res.status}` : 'GitHub could not be reached');
    const p = res.data;
    const status = p.merged_at ? `merged ${day(p.merged_at)}` : String(p.state || 'unknown');
    paint(epoch, [
      h('h1', { text: String(p.title || `Proposal #${n}`) }),
      h('dl', { class: 'cms-facts' },
        h('dt', { text: 'Proposal' }), h('dd', null, link(prLink(n), `#${n} on GitHub`)),
        h('dt', { text: 'State' }), h('dd', { text: status }),
        h('dt', { text: 'Author' }), h('dd', { text: loginOf(p) }),
        h('dt', { text: 'Files changed' }),
        h('dd', { text: Number.isInteger(p.changed_files) ? String(p.changed_files) : '?' })),
      h('section', { id: 'cms-preview-area', class: 'cms-preview-area', 'data-seam': 'U8',
        'aria-label': 'Preview' },
      h('p', { class: 'cms-muted', text: 'The rendered preview of this proposal will appear here.' })),
      h('p', null, link('#/review', '← All proposals')),
    ]);
  }

  function viewHelp(r, epoch) {
    paint(epoch, [
      h('h1', { text: 'Help' }),
      h('p', { text: 'This is the editor for the HippoCampus Robotics docs site. Sign in with GitHub; '
        + 'what you can do depends on your role on the site\'s repository:' }),
      h('dl', { class: 'cms-facts' },
        h('dt', { text: 'Admin' }), h('dd', { text: 'everything, and managing who can edit' }),
        h('dt', { text: 'Maintainer' }), h('dd', { text: 'reviews and merges proposals' }),
        h('dt', { text: 'Editor' }), h('dd', { text: 'edits pages and proposes changes' }),
        h('dt', { text: 'Read-only' }), h('dd', { text: 'reads proposals and previews' })),
      h('p', null, 'How proposals are reviewed and merged: ', link(C.PROTOCOLS_URL, 'the maintainer protocols'), '.'),
      h('p', null, 'Editing in this page arrives soon. Until then, every page can be edited on github.com: ',
        link(`${C.GITHUB_WEB}/tree/main/content`, 'open its file and click the pencil'), '.'),
      h('p', null, link('../', 'Back to the site')),
    ]);
  }

  /* data/setup.json, data/projects.json and data/tools.json, read the way
     js/app.js reads them (HC.fetchJSON), for the page-id -> file mapping. */
  async function registries() {
    if (state.regs) return state.regs;
    const get = (p) => HC.fetchJSON(p).catch(() => null);
    const [setup, projects, tools] = await Promise.all([
      get('../data/setup.json'), get('../data/projects.json'), get('../data/tools.json')]);
    state.regs = { setup, projects, tools };
    return state.regs;
  }

  // #/edit/…, #/new/…, #/media, #/private until U7b, U9 and U10 ship.
  async function viewPlaceholder(r, epoch) {
    const regs = r.name === 'edit' ? await registries() : {};
    const words = C.PLACEHOLDER_TEXT.split(': ');
    paint(epoch, h('p', { class: 'cms-placeholder' }, `${words[0]}: `,
      link(C.placeholderLink(r, regs), words.slice(1).join(': '))));
  }

  function viewNotFound(r, epoch) {
    paint(epoch, [h('h1', { text: 'Not found' }),
      h('p', null, 'The editor has no page here. ', link('#/', 'Go to the editor\'s home'), '.')]);
  }

  const VIEWS = {
    home: viewHome,
    review: viewReview,
    'review-pr': viewReviewPr,
    help: viewHelp,
    edit: viewPlaceholder,
    new: viewPlaceholder,
    media: viewPlaceholder,
    private: viewPlaceholder,
    'not-found': viewNotFound,
  };
  const NEEDS_SIGN_IN = new Set(['home', 'review', 'review-pr']);

  // --------------------------------------------------------------- router ---

  async function route() {
    routeEpoch += 1;
    const epoch = routeEpoch;
    clearPreviews();
    const r = C.parseRoute(window.location.hash);
    for (const a of nav.querySelectorAll('a[data-nav]')) {
      const on = a.dataset.nav === r.name || (a.dataset.nav === 'review' && r.name === 'review-pr');
      a.classList.toggle('active', on);
    }
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
      base: '../index.html',
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

  // ----------------------------------------------------------------- boot ---

  function onMessage(event) {
    const exchange = signIn.handleMessage(event);
    if (exchange) { completeSignIn(exchange); return; }
    for (const entry of state.previews) entry.host.handleMessage(event);
  }

  function boot() {
    try {
      if (window.localStorage.getItem('hc-theme') === 'light') {
        document.documentElement.dataset.theme = 'light';
      }
    } catch (e) { /* the site's theme choice is a courtesy */ }
    signInBtn.addEventListener('click', onSignInClick);
    signOutBtn.addEventListener('click', onSignOutClick);
    window.addEventListener('message', onMessage);
    window.addEventListener('hashchange', route);
    refresh();
  }

  window.HCCms = Object.freeze({ mountPreview, refresh });
  boot();
}());
