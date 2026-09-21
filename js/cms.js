// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 21 September 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Draw the CMS signed-in area: sign-in popup, role badge, hash routes and the preview frame.
/* The editor's page (cms/index.html). Logic lives in js/cms-core.js
   (HCCore, node-tested); this file is the DOM around it.

   What it does (units U7a and U8): sign in with GitHub in a popup, show who
   is signed in and their role on desert-mango/hippocampus-docs, list open and
   recently merged proposals, draw the hash routes, and run the Review tab
   (badges, the gate's status and located messages, the preview of the PR
   head's content, approve / request changes / merge / update from main / close, and
   Undo on GitHub for a merged proposal). It talks to this one repository
   only (HCCore's client refuses any other path), and its only writes are the
   review actions HCCore.runReviewAction sends through the client's exact-path
   allowlist. The token lives in sessionStorage and in the client's and the
   preview fetcher's closures; it is never put into the page, the preview
   frame, or a message.

   Seams for the next units (build on these, do not fork them):
     VIEWS              route name -> view function (route, epoch). U8 built
                        'review' and 'review-pr'; U7b replaces 'edit' and 'new'; U9
                        'media'; U10 'private'. Until then the last four draw
                        the one-line github.com placeholder.
     api(path)          a GET through the signed-in client; a 401 ends the
                        session, and an answer for a session that has since
                        ended or been replaced is dropped (sessionGen).
                        Writes go through HCCore (U8: runReviewAction); a
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
