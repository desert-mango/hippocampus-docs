// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 22 September 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Draw the CMS signed-in area: sign-in popup, role badge, hash routes, the preview frame and the editor.
/* The editor's page (cms/index.html). Logic lives in js/cms-core.js
   (HCCore, node-tested); this file is the DOM around it.

   What it does (units U7a, U8, U7b and U9): sign in with GitHub in a popup, show who
   is signed in and their role on desert-mango/hippocampus-docs, list open and
   recently merged proposals, draw the hash routes, and run the Review tab
   (badges, the gate's status and located messages, the preview of the PR
   head's content, approve / request changes / merge / update from main / close, and
   Undo on GitHub for a merged proposal), and the editor (U7b: the page tree,
   drafts, snippets, the live preview of a draft, raw-JSON registry editors,
   New project / New person, and Propose), and Media (U9: the site's images
   on Cloudinary through this site's /api/media). It talks to this one repository
   only (HCCore's client refuses any other path), and its only writes are the
   review actions HCCore.runReviewAction sends — and, from U7b's second
   half, the proposal HCCore.runPropose sends — through the client's
   exact-path allowlist. The token lives in sessionStorage and in the client's and the
   preview fetcher's closures; it is never put into the page, the preview
   frame, or a message.

   Seams for the next units (build on these, do not fork them):
     VIEWS              route name -> view function (route, epoch). U8 built
                        'review' and 'review-pr'; U7b 'pages', 'edit' and 'new';
                        U9 'media'; U10 'private'. Until then 'private' draws
                        the one-line github.com placeholder.
     mediaPanel(opts)   U9's image chooser (upload, or pick a site image),
                        opened by the editor's "Image from Media" and New
                        person's "Photo from Media". A new image is one entry
                        of the data/cloudinary-manifest.json draft
                        (HCCore.MANIFEST_KEY) on the page's base, so Propose
                        sends the page and the image list together.
     api(path)          a GET through the signed-in client; a 401 ends the
                        session, and an answer for a session that has since
                        ended or been replaced is dropped (sessionGen).
                        Writes go through HCCore (U8: runReviewAction, U7b:
                        runPropose); a
                        new write path is a row in HCCore's WRITE_METHODS.
     mountPreview(el, {route, fetcher})
                        puts the real site in a sandboxed frame under el and
                        answers its file requests through `fetcher` (HCCore
                        .refFetcher(token, sha) for a PR, .draftFetcher(files,
                        fallback) for a draft). Returns {load(route, fetcher),
                        destroy(), frame}. Every load gets a fresh nonce.
     #cms-preview-area  the preview area on #/review/<n> (U8 fills it).
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
      h('li', null, link('#/pages', 'Edit a page here'), ' — a draft, a live preview, then Propose'),
      h('li', null, 'Or edit any page on github.com: ',
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
          // its Review page offers Undo on GitHub
          link(`#/review/${p.number}`, String(p.title || '(no title)'), 'cms-title'),
          h('span', { class: 'cms-meta', text: `by ${loginOf(p)}, merged ${day(p.merged_at)}` }),
          link(prLink(p.number), 'on GitHub', 'cms-gh'))))
        : h('p', { class: 'cms-muted', text: 'Nothing merged recently.' }),
      h('h2', { text: 'How to' }),
      h('ul', null, ...helpLinks),
    ]);
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

  function reviewRow(p, files, login) {
    const mine = login && loginOf(p).toLowerCase() === login.toLowerCase();
    const age = C.ageText(p.created_at, Date.now());
    return h('li', null,
      h('span', { class: 'cms-num', text: `#${p.number}` }),
      link(`#/review/${p.number}`, String(p.title || '(no title)'), 'cms-title'),
      mine ? h('span', { class: 'cms-mine', text: 'yours' }) : null,
      h('span', { class: 'cms-meta', text: `by ${loginOf(p)}${age ? `, opened ${age}` : ''}` }),
      h('span', { class: 'cms-meta', text: files ? filesWord(files.length) : 'files unknown' }),
      ...(files ? C.pullBadges(files) : []).map(badge),
      link(prLink(p.number), 'on GitHub', 'cms-gh'));
  }

  async function viewReview(r, epoch) {
    paint(epoch, [h('h1', { text: 'Review' }), h('p', { class: 'cms-muted', text: 'Loading proposals…' })]);
    const login = state.session && state.session.login;
    const open = C.orderOpenPulls(await openPulls(), login);
    // the badges need each proposal's file list, so it is read here, eagerly
    const files = await Promise.all(open.map((p) => filesOrNull(p.number)));
    paint(epoch, [
      h('h1', { text: 'Review' }),
      h('p', { class: 'cms-muted', text: 'Open proposals, yours first. Pick one to see it, preview it and review it.' }),
      open.length
        ? h('ul', { class: 'cms-list' }, ...open.map((p, i) => reviewRow(p, files[i], login)))
        : h('p', { class: 'cms-muted', text: 'No open proposals.' }),
    ]);
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
     on it. An answer for a session that has since ended changes nothing. */
  async function act(action, ctx, ui) {
    if (acting || !state.client) return;
    acting = true;
    ui.buttons.forEach((b) => { b.disabled = true; });
    const gen = sessionGen.current();
    let out;
    try {
      out = await C.runReviewAction(state.client, action, ctx);
    } catch (e) {
      out = { ok: false, status: 0, message: `Something went wrong: ${(e && e.message) || e}`, sent: false };
    } finally {
      acting = false;
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
    if (ui.epoch !== routeEpoch) { say(out.message, out.ok ? null : 'error'); return; }
    flash = { number: ctx.number, text: out.message, ok: out.ok };
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
    return h('ul', { class: 'cms-files' }, ...files.map((f) => {
      const moved = typeof f.previous_filename === 'string' ? ` from ${f.previous_filename}` : '';
      const counts = Number.isInteger(f.additions) && Number.isInteger(f.deletions) ? `, +${f.additions} −${f.deletions}` : '';
      return h('li', null,
        h('div', { class: 'cms-file-head' }, h('code', { text: f.filename }),
          h('span', { class: 'cms-meta', text: `${String(f.status || 'changed')}${moved}${counts}` })),
        typeof f.patch === 'string' && f.patch
          ? h('pre', { class: 'cms-diff' }, ...f.patch.split('\n').map((line) =>
            h('span', { class: diffClass(line), text: `${line}\n` })))
          : h('p', { class: 'cms-muted', text: 'No text diff (a binary file, or too large to show here).' }));
    }));
  }

  /* The preview: the PR head's content on the site's current code (D3), on
     the first changed page, plus a button per changed page to open it there
     (the frame's own links navigate too). A proposal that also changes code
     says so first (HCCore.previewScope). */
  function fillPreview(area, pages, fetcher, scope) {
    if (scope.text) area.appendChild(h('p', { class: 'cms-preview-scope', text: scope.text }));
    const buttons = pages.map((pg) => h('button', { type: 'button', class: 'cms-btn', 'data-route': pg.route,
      title: pg.file }, pg.label));
    area.appendChild(h('div', { class: 'cms-preview-pages' },
      h('span', { class: 'cms-muted', text: pages.length ? 'Changed pages:' : 'No changed page to open; this is the home page.' }),
      ...buttons));
    const pv = mountPreview(area, { route: pages.length ? pages[0].route : '/', fetcher });
    buttons.forEach((b, i) => b.addEventListener('click', () => pv.load(pages[i].route)));
  }

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
    const note = takeFlash(n);
    const title = h('h1', { text: String(p.title || `Proposal #${n}`) });
    const back = h('p', null, link('#/review', '← All proposals'));
    if (p.merged === true || typeof p.merged_at === 'string') {
      paint(epoch, [title, note, prFacts(p, n, null), mergedPanel(p, n), back]);
      return;
    }
    if (p.state !== 'open') {
      paint(epoch, [title, note, prFacts(p, n, null),
        h('p', { text: 'This proposal was closed without merging.' }), back]);
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
    // the PR head's files, for the preview; the token stays in this closure
    const fetcher = sha ? C.refFetcher(state.session.token, sha, netFetch) : null;
    const pages = files && fetcher ? C.previewPages(files, await C.loadHeadRegistries(fetcher, files)) : [];
    const vercel = comments && comments.ok ? C.vercelCommentUrl(comments.data) : null;
    const scope = C.previewScope(files);
    const heading = fetcher ? scope.heading : 'Preview';
    const area = h('section', { id: 'cms-preview-area', class: 'cms-preview-area', 'data-seam': 'U8',
      'aria-label': heading });
    const painted = paint(epoch, [
      title, note, prFacts(p, n, files), badgeNotes(files),
      ...statusBlock(status, notes),
      vercel ? h('p', null, link(vercel, 'Vercel\'s preview comment'), ' (a deploy preview, when Vercel made one)') : null,
      actionsBlock(p, n, sha, epoch, status),
      h('h2', { text: heading }), area,
      h('h2', { text: 'Files changed' }), filesBlock(files),
      back,
    ]);
    if (!painted) return;
    if (fetcher) fillPreview(area, pages, fetcher, scope);
    else area.appendChild(h('p', { class: 'cms-muted', text: 'No preview: GitHub did not say which commit this proposal is at.' }));
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
      h('p', null, 'Edit a page here: pick it from ', link('#/pages', 'the page list'), ', change it, '
        + 'watch the preview, then Propose. Your changes stay a draft in this browser tab until you propose them. '
        + 'Every page can also be edited on github.com: ',
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
  let restoringTo = null;        // the hash a cancelled leave puts back
  let previewTimer = null;
  const PREVIEW_DELAY_MS = 600;
  const MAIN_BASE = Object.freeze({ ref: 'main', number: null });
  const chosenBase = new Map();  // page key -> {number}: my proposal picked as the base, not yet changed
  let proposing = false;         // one proposal at a time

  const canEdit = () => Boolean(state.role && state.role.canPush === true);

  /* Leaving an edit page whose draft is not proposed: ask; on "cancel" put
     the page's hash back (route() skips the hashchange that causes). */
  function leaveOk() {
    const d = drafts.get(editing.key);
    if (!d || !C.isDirty(d) || window.confirm(C.LEAVE_TEXT)) return true;
    restoringTo = editing.hash;
    window.location.hash = editing.hash;
    return false;
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

  /* What the preview frame reads: this draft's files, over the other
     not-yet-proposed drafts on the same base, over the base commit. */
  function fetcherFor(d) {
    const files = {};
    for (const o of drafts.dirty()) if (o.key !== d.key && sameBase(o, d)) Object.assign(files, o.files);
    Object.assign(files, d.files);
    return C.draftFetcher(files, C.refFetcher(state.session.token, d.base.sha, netFetch));
  }

  async function viewPages(r, epoch) {
    const tree = C.pageTree(await registries());
    const pending = canEdit() ? drafts.dirty() : [];
    const pageLinks = (pages) => h('ul', { class: 'cms-tree' },
      ...pages.map((pg) => h('li', null, link(`#/edit/${pg.pageId}`, pg.title),
        pg.title === pg.file ? null : h('span', { class: 'cms-meta', text: pg.file }))));
    paint(epoch, [
      h('h1', { text: 'Edit a page' }),
      h('p', { class: 'cms-muted', text: canEdit()
        ? 'Pick a page. Your changes stay a draft in this browser tab until you propose them.'
        : 'You can open every page and its preview. Changing them needs write access to this site\'s repository.' }),
      canEdit() ? h('p', { class: 'cms-new-links' }, link('#/new/project', 'New project'), ' · ',
        link('#/new/person', 'New person')) : null,
      pending.length ? h('section', { class: 'cms-panel' }, h('h2', { text: 'Your drafts, not proposed yet' }),
        h('ul', null, ...pending.map((d) => h('li', null,
          link(d.key === C.MANIFEST_KEY ? '#/media' : (d.key.indexOf('new/') === 0 ? `#/${d.key}` : `#/edit/${d.key}`),
            d.label, 'cms-draft-link'),
          d.base.number ? h('span', { class: 'cms-meta', text: ` for proposal #${d.base.number}` }) : null)))) : null,
      ...[].concat(...tree.map((g) => [h('h2', { text: g.title }), pageLinks(g.pages)])),
    ]);
  }

  function cannotEdit(epoch, pageId) {
    paint(epoch, [h('h1', { text: 'Not editable here' }),
      h('p', null, `The editor has no page "${pageId}". `, link('#/pages', 'Pick one from the page list'),
        ', or ', link(`${C.GITHUB_WEB}/tree/main`, 'edit the repository on github.com'), '.')]);
  }

  async function viewEdit(r, epoch) {
    const pageId = r.params.pageId;
    const kind = C.editKind(pageId);
    const regs = await registries();
    const file = kind ? C.editPath(pageId, regs) : null;
    const route = kind ? C.routeForPage(pageId, regs) : null;
    if (!file || !route) { cannotEdit(epoch, pageId); return; }
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
    editing = { key: pageId, hash: window.location.hash };
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
    const area = h('section', { id: 'cms-preview-area', class: 'cms-preview-area', 'aria-label': 'Preview' });
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

    let pv = null;
    function schedulePreview() {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => {
        if (epoch !== routeEpoch || !pv || bad) return;   // a broken registry is not previewed
        pv.load(d.route, fetcherFor(d));
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
      h('h1', { text: d.key.indexOf('new/') === 0 ? d.label : `Edit: ${d.label}` }),
      isNew ? h('p', { class: 'cms-meta' }, h('code', { text: file }), ' · a new file')
        : h('p', { class: 'cms-meta' }, h('code', { text: file }), ' · ', link(`../#${d.route}`, 'open on the site'),
          ' · ', link(C.pencilUrl(file), 'edit on github.com instead')),
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
      h('h2', { text: 'Preview' }), area,
    ];
    // the frame is mounted once the nodes are on the page (paint)
    Promise.resolve().then(() => {
      if (epoch !== routeEpoch) return;
      pv = mountPreview(area, { route: d.route, fetcher: fetcherFor(d) });
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
    const buttons = Object.keys(C.SNIPPETS).map((k) => btn(k, C.SNIPPETS[k].label));
    buttons.forEach((b) => b.addEventListener('click', () => {
      const out = C.insertSnippet(ta.value, ta.selectionStart, ta.selectionEnd, b.getAttribute('data-snippet'));
      replaceText(out.text, out.selStart, out.selEnd);
    }));
    const pages = C.pageList(state.regs);
    const picker = h('select', { class: 'cms-link-picker', 'data-link-picker': '', 'aria-label': 'Page to link to' },
      ...pages.map((pg) => h('option', { value: pg.pageId }, pg.title)));
    if (pages.length) picker.value = pages[0].pageId;
    const linkBtn = btn('link', 'Insert link');
    linkBtn.addEventListener('click', () => {
      const pg = pages.find((x) => x.pageId === picker.value);
      if (!pg) return;
      const a = ta.selectionStart;
      const b = ta.selectionEnd;
      const md = C.linkMarkdown(pg, ta.value.slice(a, b));
      replaceText(ta.value.slice(0, a) + md + ta.value.slice(b), a + md.length, a + md.length);
    });
    const slot = h('div', { class: 'cms-media-slot' });
    const media = mediaToggle('Image from Media', slot, () => mediaPanel({ mode: 'insert', baseOf: () => d.base,
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
    for (const o of ui.group()) { drafts.remove(o.key); chosenBase.delete(o.key); }
    editing = null;
    if (out.signedOut) {
      // the proposal is open; only the sign-in ended (after the PR opened)
      window.location.hash = `#/review/${out.number}`;
      endSession(`${out.message} Your sign-in has ended. Please sign in again.`);
      return;
    }
    if (ui.epoch !== routeEpoch) { say(out.message); return; }
    flash = { number: out.number, text: out.message, ok: true };
    window.location.hash = `#/review/${out.number}`;
  }

  // #/new/project and #/new/person.
  async function viewNew(r, epoch) {
    if (r.params.kind !== 'project' && r.params.kind !== 'person') { viewNotFound(r, epoch); return; }
    const what = r.params.kind;
    if (!canEdit()) {
      paint(epoch, [h('h1', { text: `New ${what}` }), h('p', { class: 'cms-muted' },
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
      if (!paint(epoch, [h('p', { class: 'cms-muted', text: `This draft adds ${md} and one entry to `
        + 'data/projects.json. To change the entry, discard it and fill the form again.' })]
        .concat(editorPage(d, md, 'page', true, epoch, own)))) return;
      editing = { key: d.key, hash: window.location.hash };
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
      window.location.hash = `#/edit/${d.key}`;
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
    return C.manifestAssets(await HC.fetchJSON('../data/cloudinary-manifest.json'));
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

  // #/private until U10 ships.
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
    pages: viewPages,
    edit: viewEdit,
    new: viewNew,
    media: viewMedia,
    private: viewPlaceholder,
    'not-found': viewNotFound,
  };
  const NEEDS_SIGN_IN = new Set(['home', 'review', 'review-pr', 'pages', 'edit', 'new', 'media']);

  // --------------------------------------------------------------- router ---

  async function route() {
    if (restoringTo !== null) {
      // the hashchange of a cancelled leave: the editor is still on screen
      const back = restoringTo === window.location.hash;
      restoringTo = null;
      if (back) return;
    }
    if (editing && window.location.hash !== editing.hash && !leaveOk()) return;
    editing = null;
    clearTimeout(previewTimer);
    routeEpoch += 1;
    const epoch = routeEpoch;
    clearPreviews();
    const r = C.parseRoute(window.location.hash);
    for (const a of nav.querySelectorAll('a[data-nav]')) {
      const on = a.dataset.nav === r.name || (a.dataset.nav === 'review' && r.name === 'review-pr')
        || (a.dataset.nav === 'pages' && (r.name === 'edit' || r.name === 'new'));
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
    nav.appendChild(h('a', { href: '#/pages', 'data-nav': 'pages' }, 'Edit'));
    nav.appendChild(h('a', { href: '#/media', 'data-nav': 'media' }, 'Media'));
    signInBtn.addEventListener('click', onSignInClick);
    signOutBtn.addEventListener('click', onSignOutClick);
    window.addEventListener('message', onMessage);
    window.addEventListener('hashchange', route);
    window.addEventListener('beforeunload', (e) => {
      if (!drafts.dirty().length) return;
      e.preventDefault();
      e.returnValue = '';            // the browser asks before the tab's drafts go
    });
    refresh();
  }

  window.HCCms = Object.freeze({ mountPreview, refresh });
  boot();
}());
