// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 29 September 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Render the guest GitHub surfaces: Lab page, repo cards, person popover, who wrote this.
/* HippoCampus Robotics docs — the public GitHub layer.

   Four surfaces, all drawn from COMMITTED same-origin JSON (tools/build_github_data.py
   writes them under data/graph/ when the site's derived data is rebuilt):

     1. the Lab page (#/lab): totals, a 53-week heatmap, recent commits (no authors),
        the most active repositories, releases and the people on GitHub (names only);
     2. repo cards that replace the plain repository rows in a project's aside;
     3. a person popover on People cards, contributor names, "who wrote this" names
        and Lab-page rows (one at a time, Esc closes);
     4. the "who wrote this" footer under a page: names and committed avatars only.

   Rules this file keeps (plan D-B, D-B2, D-C, D-J, D-L, D-M):
   - A guest's browser makes NO request to GitHub: every read goes through HC.fetchJSON
     to data/graph/*.json or data/people.json, and avatars are the committed 64-px
     copies under data/graph/avatars/ — never avatars.githubusercontent.com.
   - Every GitHub-derived string (display names, commit messages, descriptions) is
     set with textContent. This file never writes innerHTML, not even for the SVG.
   - Nothing members-only is drawn: no per-person counts or dates, no "last active".
   - Roster linkage is by login through people-public.json (login -> roster name),
     the same rule js/graph.js uses for Primary contributors.
   - A missing file degrades: the Lab page says "GitHub data not built yet"; the
     footer and the repo cards simply stay as they were. Stale keys are ignored.

   The pure helpers at the top are exported for tools/tests/test_lab_ui.mjs;
   createLab() takes its document, window and fetch so the renderers run on a fake DOM. */
(function () {
  'use strict';

  const HAS_DOM = typeof window !== 'undefined' && typeof document !== 'undefined';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SRC = {
    activity: 'data/graph/org-activity.json',
    repos: 'data/graph/github-repos.json',
    authors: 'data/graph/page-authors.json',
    people: 'data/graph/people-public.json',
    roster: 'data/people.json',
  };
  const SOURCES = Object.freeze(Object.keys(SRC).map((k) => SRC[k]));
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
  const NOT_BUILT = 'GitHub data not built yet. This part fills in once the site’s derived data is rebuilt.';
  const NOT_LOADED = 'GitHub data could not be loaded. Reload the page to try again.';

  // ==================================================================
  //  pure helpers (unit-tested under node; no DOM, no globals)
  // ==================================================================

  function str(v) { return typeof v === 'string' ? v : ''; }
  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }
  function has(obj, key) { return !!obj && Object.prototype.hasOwnProperty.call(obj, key); }

  function safeHttpUrl(value) {
    const url = str(value).trim();
    return /^https?:\/\//i.test(url) ? url : null;
  }

  // read_at is written at day precision; anything else is shown as nothing.
  function readAtDay(value) {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(str(value));
    return m ? m[1] : '';
  }

  // Only the committed 64-px copies are ever loaded (D-J).
  function avatarPath(value) {
    const v = str(value);
    return /^data\/graph\/avatars\/[A-Za-z0-9][A-Za-z0-9-]*\.(png|jpg)$/.test(v) ? v : null;
  }

  function githubProfileUrl(url, login) {
    const u = str(url).trim();
    if (/^https:\/\/github\.com\/[A-Za-z0-9-]+\/?$/.test(u)) return u;
    return LOGIN_RE.test(str(login)) ? 'https://github.com/' + login : null;
  }

  function githubRepoUrl(url) {
    const u = str(url).trim();
    return /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(u) ? u : null;
  }

  function initials(name) {
    const letters = str(name).trim().split(/\s+/).slice(0, 2)
      .map((word) => Array.from(word)[0] || '').join('');
    return letters.toUpperCase() || '?';
  }

  // Five levels against the busiest day, the way the mockup drew them.
  function heatLevel(n, max) {
    const v = Number(n);
    if (!(v > 0)) return 0;
    if (!(Number(max) > 0)) return 4;
    const r = v / max;
    if (r >= 0.75) return 4;
    if (r >= 0.5) return 3;
    if (r >= 0.25) return 2;
    return 1;
  }

  // weeks: [{week: 'YYYY-MM-DD' (a Monday), days: [7 counts, null for days not yet lived]}]
  // -> {columns, max, cells: [{col, row, n, level, date}], months: [{col, label}]}
  function weekLayout(weeks) {
    const cols = (Array.isArray(weeks) ? weeks : [])
      .filter((w) => w && typeof w === 'object' && Array.isArray(w.days));
    let max = 0;
    cols.forEach((w) => w.days.slice(0, 7).forEach((d) => {
      if (num(d) !== null && d > max) max = d;
    }));
    const cells = [];
    const months = [];
    let lastMonth = '';
    let lastCol = -9;
    cols.forEach((w, col) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(w.week));
      const monday = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
      if (m) {
        const label = MONTHS[Number(m[2]) - 1] || '';
        if (label && label !== lastMonth && col - lastCol >= 3) {
          months.push({ col: col, label: label });
          lastMonth = label;
          lastCol = col;
        }
      }
      w.days.slice(0, 7).forEach((d, row) => {
        if (num(d) === null || d < 0) return;
        const date = monday === null ? '' : new Date(monday + row * 864e5).toISOString().slice(0, 10);
        cells.push({ col: col, row: row, n: d, level: heatLevel(d, max), date: date });
      });
    });
    return { columns: cols.length, max: max, cells: cells, months: months };
  }

  // Repository metadata only (github-repos.json is public by construction).
  function repoCardFacts(r) {
    if (!r || typeof r !== 'object') return [];
    const facts = [];
    facts.push({ key: 'language', text: str(r.language).trim() || '—' });
    facts.push({ key: 'stars', text: '★ ' + (num(r.stars) || 0) });
    const issues = num(r.open_issues) || 0;
    facts.push({ key: 'issues', text: issues + ' issue' + (issues === 1 ? '' : 's') });
    const pushed = readAtDay(r.pushed_at);
    if (pushed) facts.push({ key: 'pushed', text: 'pushed ' + pushed });
    if (r.fork === true) facts.push({ key: 'fork', text: 'fork' });
    if (r.archived === true) facts.push({ key: 'archived', text: 'archived' });
    return facts;
  }

  function entriesOf(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') return Object.keys(value).map((k) => value[k]);
    return [];
  }

  // people-public.json + data/people.json -> the lookups every surface shares.
  function buildPeopleIndex(peoplePublic, roster) {
    const byLogin = new Map();
    entriesOf(peoplePublic && peoplePublic.people).forEach((e) => {
      if (!e || typeof e !== 'object') return;
      const login = str(e.login).trim();
      if (login && !byLogin.has(login)) byLogin.set(login, e);
    });
    const rosterByName = new Map();
    const groups = (roster && Array.isArray(roster.groups)) ? roster.groups : [];
    groups.forEach((g) => {
      const list = (g && Array.isArray(g.people)) ? g.people : [];
      list.forEach((p) => {
        const name = str(p && p.name).trim();
        if (name && !rosterByName.has(name)) rosterByName.set(name, p);
      });
    });
    // roster name -> login, only when exactly one login claims it (the builder already
    // refuses ambiguity; this is the renderer not trusting that).
    const loginByRoster = new Map();
    const twice = new Set();
    byLogin.forEach((e, login) => {
      const name = str(e.roster).trim();
      if (!name || !rosterByName.has(name)) return;
      if (loginByRoster.has(name)) twice.add(name); else loginByRoster.set(name, login);
    });
    twice.forEach((name) => loginByRoster.delete(name));
    return { byLogin: byLogin, rosterByName: rosterByName, loginByRoster: loginByRoster };
  }

  // q: {login} | {roster} | {login: null, name}. The roster card's own fields win;
  // everyone else is a "GitHub contributor". The big image is never the GitHub avatar.
  function personModel(idx, q) {
    const query = q || {};
    const login = str(query.login).trim() || null;
    let entry = login ? (idx.byLogin.get(login) || null) : null;
    let rosterName = null;
    if (entry) {
      const r = str(entry.roster).trim();
      if (r && idx.rosterByName.has(r)) rosterName = r;
    } else if (!login) {
      const r = str(query.roster).trim();
      if (r && idx.rosterByName.has(r)) {
        rosterName = r;
        const l = idx.loginByRoster.get(r);
        entry = l ? (idx.byLogin.get(l) || null) : null;
      }
    }
    const person = rosterName ? idx.rosterByName.get(rosterName) : null;
    const name = person ? str(person.name).trim()
      : (str(entry && entry.name).trim() || str(query.name).trim() || str(query.roster).trim() || login || '');
    let github = null;
    if (entry) {
      github = {
        login: str(entry.login).trim(),
        avatar: avatarPath(entry.avatar),
        url: githubProfileUrl(entry.html_url, str(entry.login).trim()),
      };
    } else if (login && LOGIN_RE.test(login)) {
      github = { login: login, avatar: null, url: githubProfileUrl(null, login) };
    }
    return {
      name: name,
      title: person ? str(person.title).trim() : 'GitHub contributor',
      photo: person ? safeHttpUrl(person.photo) : null,
      initials: initials(name),
      link: person ? safeHttpUrl(person.link) : null,
      roster: rosterName,
      github: github,
    };
  }

  const STATE_LABEL = { open: 'open proposal', merged: 'merged', closed: 'closed' };

  function personToken(idx, login, name) {
    const l = str(login).trim() || null;
    const model = personModel(idx, { login: l, name: name });
    return model.name ? { person: { login: l, name: model.name, avatar: model.github && model.github.avatar } } : null;
  }

  function joinNames(tokens) {
    const out = [];
    tokens.forEach((t, i) => {
      if (i > 0) out.push(i === tokens.length - 1 ? ' and ' : ', ');
      out.push(t);
    });
    return out;
  }

  // A page entry -> lines of tokens (a string, or {person}). Names only: an author's
  // count or dates are never read, even if a file carried them.
  function authorParts(entry, idx) {
    if (!entry || typeof entry !== 'object') return [];
    const lines = [];
    const orig = entry.original;
    if (orig && typeof orig === 'object') {
      if (orig.history_read !== true) {
        lines.push(['Original authors: history not read yet.']);
      } else {
        const people = (Array.isArray(orig.authors) ? orig.authors : [])
          .map((a) => (a && typeof a === 'object') ? personToken(idx, a.login, a.name) : null)
          .filter(Boolean);
        if (!people.length) {
          lines.push(['Original authors: none recorded.']);
        } else {
          const repo = str(orig.repo).trim();
          lines.push(['Written by '].concat(joinNames(people), repo ? [' in ', repo, '.'] : ['.']));
        }
      }
    }
    const conv = entry.converted;
    if (conv && typeof conv === 'object' && (conv.by || conv.date)) {
      const line = ['Converted to this site'];
      const day = readAtDay(conv.date);
      if (day) line.push(' on ' + day);
      const by = conv.by ? personToken(idx, conv.by, null) : null;
      if (by) line.push(' by ', by);
      const tool = str(conv.tool).trim();
      if (tool) line.push(' (' + tool + ')');
      line.push('.');
      lines.push(line);
    }
    (Array.isArray(entry.edited_here) ? entry.edited_here : []).forEach((e) => {
      if (!e || typeof e !== 'object' || !Number.isInteger(e.pr) || e.pr <= 0) return;
      const line = ['PR #' + e.pr];
      const by = e.by ? personToken(idx, e.by, null) : null;
      if (by) line.push(' by ', by);
      const state = STATE_LABEL[str(e.state)];
      line.push(state ? ': ' + state + '.' : '.');
      lines.push(line);
    });
    return lines;
  }

  function tokenText(t) { return typeof t === 'string' ? t : t.person.name; }
  function authorLines(entry, idx) {
    return authorParts(entry, idx).map((line) => line.map(tokenText).join(''));
  }
  function authorLine(entry, idx) { return authorLines(entry, idx).join(' '); }

  function repoIndex(file) {
    const map = new Map();
    const repos = file && file.repos;
    if (Array.isArray(repos)) {
      repos.forEach((r) => { if (r && str(r.name)) map.set(r.name, r); });
    } else if (repos && typeof repos === 'object') {
      Object.keys(repos).forEach((k) => {
        const r = repos[k];
        if (r && typeof r === 'object') map.set(str(r.name) || k, r);
      });
    }
    map.forEach((r, k) => { if (r.private !== false) map.delete(k); });   // public entries only
    return map;
  }

  // ==================================================================
  //  renderers: createLab({doc, win, fetchJSON})
  // ==================================================================

  function createLab(env) {
    const doc = env && env.doc;
    const win = (env && env.win) || {};
    const fetchJSON = env && env.fetchJSON;
    const loads = {};
    let lastOp = Promise.resolve();
    let pop = null;
    let popAnchor = null;
    let seq = 0;

    // Every file loads at most once; a failure is remembered with its status.
    function need(keys) {
      return Promise.all(keys.map((k) => {
        if (!loads[k]) {
          loads[k] = (typeof fetchJSON === 'function' ? Promise.resolve().then(() => fetchJSON(SRC[k]))
            : Promise.reject(new Error('no fetch')))
            .then((value) => ({ ok: value != null, status: 200, value: value }),
              (err) => ({ ok: false, status: (err && err.status) || 0, value: null }));
        }
        return loads[k];
      })).then((parts) => {
        const out = {};
        keys.forEach((k, i) => { out[k] = parts[i]; });
        return out;
      });
    }
    function indexOf(d) {
      return buildPeopleIndex(d.people && d.people.value, d.roster && d.roster.value);
    }

    function h(tag, cls, text) {
      const el = doc.createElement(tag);
      if (cls) el.setAttribute('class', cls);
      if (text != null && text !== '') el.textContent = String(text);
      return el;
    }
    function svg(tag, attrs, text) {
      const el = doc.createElementNS(SVG_NS, tag);
      Object.keys(attrs || {}).forEach((k) => el.setAttribute(k, String(attrs[k])));
      if (text != null) el.textContent = String(text);
      return el;
    }
    function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
    function connected(el) { return !!el && (!('isConnected' in el) || el.isConnected); }
    function link(href, cls, text) {
      const a = h('a', cls, text);
      a.setAttribute('href', href);
      if (/^https?:/i.test(href)) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener');
      }
      return a;
    }
    function avatarImg(src, cls) {
      const img = h('img', 'hc-avatar' + (cls ? ' ' + cls : ''));
      img.setAttribute('src', src);
      img.setAttribute('alt', '');
      img.setAttribute('loading', 'lazy');
      return img;
    }
    function personButton(token) {
      const p = token.person;
      if (!p.login) return h('span', 'hc-person-name', p.name);
      const b = h('button', 'hc-person-link', p.name);
      b.setAttribute('type', 'button');
      b.setAttribute('data-hc-login', p.login);
      return b;
    }
    function failNote(status) { return h('p', 'hc-empty', status === 404 ? NOT_BUILT : NOT_LOADED); }

    // ---------- popover ----------

    function closePerson() {
      if (pop && pop.parentNode) pop.parentNode.removeChild(pop);
      pop = null;
      popAnchor = null;
    }

    function position() {
      if (!pop || !popAnchor || typeof popAnchor.getBoundingClientRect !== 'function') return;
      const r = popAnchor.getBoundingClientRect();
      const w = pop.offsetWidth || 300;
      const ht = pop.offsetHeight || 180;
      const vw = win.innerWidth || 0;
      const vh = win.innerHeight || 0;
      const pad = 8;
      let left = r.left;
      if (left + w + pad > vw) left = vw - w - pad;
      if (left < pad) left = pad;
      let top = r.bottom + 6;
      if (top + ht + pad > vh) {
        const above = r.top - ht - 6;
        top = (above >= pad) ? above : Math.max(pad, vh - ht - pad);
      }
      pop.style.left = Math.round(left) + 'px';
      pop.style.top = Math.round(top) + 'px';
    }

    function buildPopover(model) {
      const box = h('div', 'hc-popover hc-person-pop');
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-label', model.name);
      const head = h('div', 'hc-pp-head');
      let media;
      if (model.photo) {
        media = h('img', 'hc-pp-media');
        media.setAttribute('src', model.photo);
        media.setAttribute('alt', '');
      } else {
        media = h('div', 'hc-pp-media hc-pp-initials', model.initials);
        media.setAttribute('aria-hidden', 'true');
      }
      const who = h('div', 'hc-pp-who');
      who.appendChild(h('p', 'hc-pop-title', model.name));
      if (model.title) who.appendChild(h('p', 'hc-pp-title', model.title));
      head.appendChild(media);
      head.appendChild(who);
      box.appendChild(head);
      if (model.link) {
        const row = h('p', 'hc-pp-links');
        row.appendChild(link(model.link, 'hc-pop-open', 'Personal page →'));
        box.appendChild(row);
      }
      if (model.github) {
        const gh = h('div', 'hc-pp-gh');
        if (model.github.avatar) gh.appendChild(avatarImg(model.github.avatar, 'lg'));
        const label = '@' + model.github.login + ' on GitHub';
        gh.appendChild(model.github.url ? link(model.github.url, 'hc-pp-gh-link', label) : h('span', '', label));
        box.appendChild(gh);
      }
      return box;
    }

    function openPerson(anchor, q) {
      if (!doc) return Promise.resolve();
      const mine = (seq += 1);
      closePerson();
      try { if (win.HCGraph && typeof win.HCGraph.closePopover === 'function') win.HCGraph.closePopover(); } catch (e) { /* ignore */ }
      lastOp = need(['people', 'roster']).then((d) => {
        if (mine !== seq) return;
        const model = personModel(indexOf(d), q);
        if (!model.name) return;
        if (q && q.roster && !model.link && !model.github) return;   // nothing to show
        closePerson();
        pop = buildPopover(model);
        popAnchor = anchor || null;
        doc.body.appendChild(pop);
        position();
      }).catch(() => { closePerson(); });
      return lastOp;
    }

    // One delegated handler per root: a People card's photo/initials (data-hc-person)
    // or any GitHub-derived name (data-hc-login). preventDefault keeps a linked card
    // from also navigating (D-M).
    function onTrigger(e) {
      const t = e && e.target && typeof e.target.closest === 'function'
        ? e.target.closest('[data-hc-person], [data-hc-login]') : null;
      if (!t) return;
      if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      const login = t.getAttribute('data-hc-login');
      openPerson(t, login ? { login: login } : { roster: t.getAttribute('data-hc-person') });
    }
    function wire(root) {
      if (!root || root.getAttribute('data-hc-wired') === '1') return;
      root.setAttribute('data-hc-wired', '1');
      root.addEventListener('click', onTrigger);
      root.addEventListener('keydown', onTrigger);
    }

    // The About page: app.js marks every card's photo/initials; a card with nothing to
    // show (no link, no GitHub match, or a name people.json no longer has) loses the mark.
    function wirePeople(root) {
      if (!doc || !root) return Promise.resolve();
      wire(root);
      return need(['people', 'roster']).then((d) => {
        const idx = indexOf(d);
        root.querySelectorAll('[data-hc-person]').forEach((el) => {
          const name = el.getAttribute('data-hc-person');
          const model = idx.rosterByName.has(name) ? personModel(idx, { roster: name }) : null;
          if (model && (model.link || model.github)) return;
          ['data-hc-person', 'role', 'tabindex', 'aria-label'].forEach((a) => el.removeAttribute(a));
          el.classList.remove('hc-pp-trigger');
        });
      });
    }

    // ---------- who wrote this ----------

    function renderAuthors(body, pageId) {
      if (!doc || !body || typeof pageId !== 'string') return Promise.resolve();
      return need(['authors', 'people', 'roster']).then((d) => {
        if (!d.authors.ok) return;
        const pages = d.authors.value && d.authors.value.pages;
        const entry = has(pages, pageId) ? pages[pageId] : null;
        if (!entry || typeof entry !== 'object') return;
        if (!connected(body) || body.querySelector('.hc-authors')) return;
        const lines = authorParts(entry, indexOf(d));
        if (!lines.length) return;
        const box = h('section', 'hc-authors');
        box.setAttribute('aria-label', 'Who wrote this');
        box.appendChild(h('h4', '', 'Who wrote this'));
        lines.forEach((line, i) => {
          const row = h('p', 'hc-authors-line');
          const people = line.filter((t) => typeof t !== 'string');
          const faces = (i === 0 ? people : people.slice(0, 1))
            .map((t) => t.person.avatar).filter(Boolean);
          if (faces.length) {
            const stack = h('span', 'hc-stack');
            faces.forEach((src) => stack.appendChild(avatarImg(src, 'xs')));
            row.appendChild(stack);
          }
          line.forEach((t) => {
            row.appendChild(typeof t === 'string' ? doc.createTextNode(t) : personButton(t));
          });
          box.appendChild(row);
        });
        box.appendChild(h('p', 'hc-authors-note',
          'From git history: the old docs repository (following the 2025-03-10 folder move) and '
          + 'this one. Names as GitHub publishes them; updated when the site’s derived data is rebuilt.'));
        wire(box);
        body.appendChild(box);
      });
    }

    // ---------- repo cards ----------

    function repoCard(name, role, fallbackHref, r) {
      const href = (r && githubRepoUrl(r.html_url)) || safeHttpUrl(fallbackHref);
      const card = href ? link(href, 'hc-repo') : h('div', 'hc-repo');
      const nm = h('span', 'nm');
      const dot = h('span', 'hc-lang');
      if (r && str(r.language)) dot.setAttribute('data-lang', str(r.language));
      nm.appendChild(dot);
      nm.appendChild(h('span', 'hc-repo-name', name));
      if (!r) nm.appendChild(h('span', 'ext', 'not in the org snapshot'));
      card.appendChild(nm);
      if (role) card.appendChild(h('span', 'role', role));
      if (r && str(r.description).trim()) card.appendChild(h('p', 'desc', str(r.description).trim()));
      if (r) {
        const facts = h('span', 'facts');
        repoCardFacts(r).forEach((f) => facts.appendChild(h('span', 'f-' + f.key, f.text)));
        card.appendChild(facts);
      }
      return card;
    }

    function renderRepoCards(asideBox) {
      if (!doc || !asideBox) return Promise.resolve();
      return need(['repos']).then((d) => {
        if (!d.repos.ok || !connected(asideBox)) return;
        const snap = repoIndex(d.repos.value);
        asideBox.querySelectorAll('.repo-row').forEach((li) => {
          const chip = li.querySelector('.chip');
          const roleEl = li.querySelector('.role');
          const name = chip ? chip.textContent.trim() : '';
          if (!name) return;
          const item = h('li', 'hc-repo-item');
          item.appendChild(repoCard(name, roleEl ? roleEl.textContent.trim() : '',
            chip.getAttribute('href'), snap.get(name) || null));
          li.replaceWith(item);
        });
      });
    }

    // ---------- the Lab page ----------

    function heatmap(weeks) {
      const lay = weekLayout(weeks);
      const cell = 12;
      const gap = 3;
      const left = 28;
      const top = 18;
      const W = left + Math.max(lay.columns, 1) * (cell + gap);
      const H = top + 7 * (cell + gap);
      const box = h('section', 'hc-heat');
      const hd = h('div', 'hd');
      hd.appendChild(h('h3', '', 'Commits per day, last 53 weeks'));
      hd.appendChild(h('span', 'hc-muted', 'public repositories, forks excluded'));
      box.appendChild(hd);
      const wrap = h('div', 'hc-heat-scroll');
      const root = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img',
        'aria-label': 'Commits per day over the last 53 weeks' });
      lay.months.forEach((m) => {
        root.appendChild(svg('text', { x: left + m.col * (cell + gap), y: 11, class: 'hc-heat-label' }, m.label));
      });
      [['Mon', 0], ['Wed', 2], ['Fri', 4]].forEach((d) => {
        root.appendChild(svg('text', { x: 0, y: top + d[1] * (cell + gap) + 10, class: 'hc-heat-label' }, d[0]));
      });
      lay.cells.forEach((c) => {
        const rect = svg('rect', { x: left + c.col * (cell + gap), y: top + c.row * (cell + gap),
          width: cell, height: cell, rx: 2, class: 'hc-l' + c.level });
        rect.appendChild(svg('title', {}, (c.date ? c.date + ': ' : '') + c.n + ' commit' + (c.n === 1 ? '' : 's')));
        root.appendChild(rect);
      });
      wrap.appendChild(root);
      box.appendChild(wrap);
      const legend = h('div', 'legend');
      legend.appendChild(doc.createTextNode('less '));
      [0, 1, 2, 3, 4].forEach((l) => legend.appendChild(h('i', 'hc-l' + l)));
      legend.appendChild(doc.createTextNode(' more'));
      box.appendChild(legend);
      return box;
    }

    function column(title) {
      const col = h('section', 'hc-col');
      col.appendChild(h('h3', '', title));
      return col;
    }

    function recentCommits(list) {
      const col = column('Recent commits');
      const rows = (Array.isArray(list) ? list : []).filter((c) => c && typeof c === 'object').slice(0, 10);
      if (!rows.length) col.appendChild(h('p', 'hc-empty', 'No commits in the last 365 days.'));
      rows.forEach((c) => {
        const row = h('div', 'hc-commit');
        row.appendChild(h('div', 'm', str(c.msg)));
        const s = h('div', 's');
        if (str(c.repo)) s.appendChild(h('span', 'repo', str(c.repo)));
        const day = readAtDay(c.date);
        if (day) s.appendChild(h('span', '', day));
        if (/^[0-9a-f]{7,40}$/.test(str(c.sha))) s.appendChild(h('span', 'hc-mono', c.sha.slice(0, 7)));
        row.appendChild(s);
        col.appendChild(row);
      });
      return col;
    }

    function activeRepos(list, releases) {
      const col = column('Most active repositories');
      const rows = (Array.isArray(list) ? list : []).filter((r) => r && str(r.name));
      const max = Math.max(1, ...rows.map((r) => num(r.commits) || 0));
      if (!rows.length) col.appendChild(h('p', 'hc-empty', 'No commits in the last 365 days.'));
      rows.forEach((r) => {
        const n = num(r.commits) || 0;
        const bar = h('div', 'hc-bar');
        bar.appendChild(h('span', 'name', r.name));
        bar.appendChild(h('span', 'n', n + ' commit' + (n === 1 ? '' : 's') + ' · ' + (str(r.language) || '—')));
        const track = h('span', 'track');
        const fill = h('i');
        fill.style.width = Math.round((n / max) * 100) + '%';
        track.appendChild(fill);
        bar.appendChild(track);
        col.appendChild(bar);
      });
      col.appendChild(h('h3', 'hc-sub', 'Releases'));
      const rel = (Array.isArray(releases) ? releases : []).filter((r) => r && typeof r === 'object').slice(0, 8);
      if (!rel.length) col.appendChild(h('p', 'hc-empty', 'No GitHub releases in the public repositories.'));
      rel.forEach((r) => {
        const label = [str(r.repo), str(r.tag) || str(r.tag_name) || str(r.name)].filter(Boolean).join(' ');
        const day = readAtDay(r.published_at || r.date);
        const row = h('div', 'hc-rel');
        const url = str(r.html_url).trim();
        row.appendChild(/^https:\/\/github\.com\//.test(url) ? link(url, 'hc-mono', label) : h('span', 'hc-mono', label));
        if (day) row.appendChild(h('span', 'hc-muted', ' · ' + day));
        col.appendChild(row);
      });
      return col;
    }

    function peopleColumn(d) {
      const col = column('People on GitHub');
      if (!d.people.ok) { col.appendChild(failNote(d.people.status)); return col; }
      const idx = indexOf(d);
      const models = [];
      idx.byLogin.forEach((e, login) => {
        const m = personModel(idx, { login: login });
        if (m.name) models.push(m);
      });
      models.sort((a, b) => a.name.localeCompare(b.name));
      models.forEach((m) => {
        const row = h('button', 'hc-person-row');
        row.setAttribute('type', 'button');
        row.setAttribute('data-hc-login', m.github.login);
        if (m.github.avatar) row.appendChild(avatarImg(m.github.avatar, 'md'));
        else row.appendChild(h('span', 'hc-avatar md hc-avatar-empty', m.initials));
        const txt = h('span', 'who');
        txt.appendChild(h('span', 'nm', m.name));
        txt.appendChild(h('span', 'sub', '@' + m.github.login));
        row.appendChild(txt);
        col.appendChild(row);
      });
      col.appendChild(h('p', 'hc-muted hc-col-note', 'Everyone who has committed to a non-fork org repository or '
        + 'to a page of this site, by the name GitHub publishes. No e-mail, location or company is read or stored.'));
      return col;
    }

    function renderLab(container, isCurrent) {
      if (!doc || !container) return Promise.resolve();
      return need(['activity', 'people', 'roster']).then((d) => {
        if (typeof isCurrent === 'function' && !isCurrent()) return;
        clear(container);
        const root = h('div', 'page-body hc-lab');
        root.appendChild(h('p', 'kicker', 'HippoCampusRobotics on GitHub'));
        root.appendChild(h('h1', '', 'Lab activity'));
        const act = d.activity.ok && d.activity.value && typeof d.activity.value === 'object'
          ? d.activity.value : null;
        if (!act) {
          root.appendChild(failNote(d.activity.status));
          container.appendChild(root);
          return;
        }
        const t = (act.totals && typeof act.totals === 'object') ? act.totals : {};
        const repos = num(t.public_repos);
        root.appendChild(h('p', 'lead', 'What the lab’s ' + (repos === null ? '' : repos + ' ')
          + 'public repositories did in the last 365 days, from public GitHub data read when the site rebuilds.'));
        root.appendChild(h('p', 'hc-asof', 'GitHub data as of ' + (readAtDay(act.read_at) || 'an unknown date')));
        const tiles = h('div', 'hc-tiles');
        [['commits_365d', 'commits, last 365 days'], ['authors_365d', 'authors, last 365 days'],
          ['repos_touched_365d', 'repositories touched'], ['public_repos', 'public repositories'],
          ['stars', 'stars, all repositories'], ['open_issues', 'open issues'], ['releases', 'releases']]
          .forEach((pair) => {
            const n = num(t[pair[0]]);
            if (n === null) return;
            const tile = h('div', 'hc-tile');
            tile.appendChild(h('div', 'n', String(n)));
            tile.appendChild(h('div', 'l', pair[1]));
            tiles.appendChild(tile);
          });
        root.appendChild(tiles);
        const weeks = Array.isArray(act.weeks) ? act.weeks
          : (act.heatmap && Array.isArray(act.heatmap.weeks)) ? act.heatmap.weeks
            : (Array.isArray(act.heatmap) ? act.heatmap : []);
        root.appendChild(heatmap(weeks));
        const cols = h('div', 'hc-cols');
        cols.appendChild(recentCommits(act.recent_commits));
        cols.appendChild(activeRepos(act.most_active_repos, act.releases));
        cols.appendChild(peopleColumn(d));
        root.appendChild(cols);
        root.appendChild(h('p', 'provenance hc-prov', 'Source: public GitHub REST API reads made by '
          + 'tools/build_github_data.py when the site rebuilds, committed under data/graph/. '
          + 'Your browser makes no request to GitHub.'));
        wire(root);
        container.appendChild(root);
      });
    }

    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener('keydown', (e) => {
        if (pop && (e.key === 'Escape' || e.key === 'Esc' || e.keyCode === 27)) {
          const back = popAnchor;
          closePerson();
          try { if (back && typeof back.focus === 'function') back.focus(); } catch (err) { /* ignore */ }
        }
      });
      doc.addEventListener('click', (e) => {
        const t = e && e.target;
        if (t && typeof t.closest === 'function' && t.closest('.hc-person-pop')) return;
        closePerson();
      });
    }
    if (typeof win.addEventListener === 'function') {
      win.addEventListener('hashchange', closePerson);
      win.addEventListener('resize', position);
      win.addEventListener('scroll', position, true);
    }

    // Page-local extras never take a page down: a failure is logged and dropped. The
    // Lab page itself rejects, so the router shows its error panel.
    function quiet(fn) {
      return function () {
        return fn.apply(null, arguments).catch((err) => {
          try { console.info('HCLab: skipped — ' + ((err && err.message) || err)); } catch (e) { /* ignore */ }
        });
      };
    }

    return {
      renderLab: renderLab,
      renderAuthors: quiet(renderAuthors),
      renderRepoCards: quiet(renderRepoCards),
      wirePeople: quiet(wirePeople),
      openPerson: openPerson,
      closePerson: closePerson,
      whenReady: () => lastOp,
    };
  }

  const runtime = createLab(HAS_DOM ? {
    doc: document,
    win: window,
    fetchJSON: (path) => (window.HC ? window.HC.fetchJSON(path) : Promise.reject(new Error('HC missing'))),
  } : {});

  const API = Object.freeze(Object.assign({
    // pure helpers (exported for tools/tests/test_lab_ui.mjs)
    SOURCES: SOURCES,
    heatLevel: heatLevel,
    weekLayout: weekLayout,
    repoCardFacts: repoCardFacts,
    buildPeopleIndex: buildPeopleIndex,
    personModel: personModel,
    authorLines: authorLines,
    authorLine: authorLine,
    avatarPath: avatarPath,
    githubProfileUrl: githubProfileUrl,
    readAtDay: readAtDay,
    createLab: createLab,
  }, runtime));

  if (typeof window !== 'undefined') window.HCLab = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
}());
