// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 15 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Render the guest GitHub surfaces: Lab page, repo cards, person popover, who wrote this.
/* HippoCampus Robotics docs — the public GitHub layer.

   Four surfaces, all drawn from COMMITTED same-origin JSON (tools/build_github_data.py
   writes them under data/graph/ when the site's derived data is rebuilt):

     1. the Team page's Lab activity: three totals, a 53-week heatmap (one tab stop, a
        site tooltip), the ten newest commits with their authors, the most active
        repositories, releases and the people on GitHub (names only, the ten most
        active first);
     2. quiet repo cards that replace the plain repository rows in a project's aside;
     3. ONE dialog (uiux 2026-10, M17): a person's profile (People cards, contributor
        names, "who wrote this" names, Lab rows), a commit, a repository — an anchored
        popover on a wide screen, a bottom sheet on a phone; one at a time, focus
        trapped, Esc closes;
     4. the "who wrote this" line under a page: names and committed avatars only.

   Rules this file keeps (plan D-B, D-B2, D-C, D-J, D-L, D-M):
   - A guest's browser makes NO request to GitHub: every read goes through HC.fetchJSON
     to data/graph/*.json or data/people.json, and avatars are the committed 64-px
     copies under data/graph/avatars/ — never avatars.githubusercontent.com.
   - Every GitHub-derived string (display names, commit messages, descriptions) is
     set with textContent. This file never writes innerHTML, not even for the SVG.
   - Nothing members-only is drawn: no per-person counts or dates, no "last active". (Round 2, R4: the
     public layer now carries last_active for roster-linked logins; splitTeam reads it ONLY to sort the Team
     page into the current team and alumni — it is never drawn.)
   - Roster linkage is by login through people-public.json (login -> roster name),
     the same rule js/graph.js uses for Primary contributors.
   - A missing file degrades: the Lab page says "GitHub data not built yet"; the
     footer and the repo cards simply stay as they were. Stale keys are ignored.

   The decoration seam (U4, plan D-A): js/editor.js — loaded only for a signed-in session,
   never for a guest — adds members-only detail under these surfaces. lab.js draws none of it;
   it only marks each surface and announces it:
     data-hc-surface="lab"      the Lab page root; its recent-commit rows carry
                                data-hc-repo / data-hc-sha (7 hex), its people column
                                data-hc-slot="lab-people";
     data-hc-surface="authors"  a "who wrote this" box, with data-hc-page=<page key>;
     data-hc-surface="people"   the About page root wirePeople() wired;
     data-hc-surface="popover"  an open person dialog, with data-hc-login when it has a
                                GitHub login.
   onRender(fn) -> unsubscribe: fn(surface, element) runs once the element is in the page.
   A throwing listener is ignored; a guest page has no listener at all.

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
    contrib: 'data/graph/contributors.json',   // M5 projects in the profile, M13 the people column's order
    wiki: 'data/graph/wiki.json',              // M12 the setup pages that mention a repository
  };
  const SOURCES = Object.freeze(Object.keys(SRC).map((k) => SRC[k]));
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
  const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
  const SHA_RE = /^[0-9a-f]{7,40}$/;
  const NOT_BUILT = 'GitHub data not built yet. This part fills in once the site’s derived data is rebuilt.';
  const NOT_LOADED = 'GitHub data could not be loaded. Reload the page to try again.';
  const ORG_URL = 'https://github.com/HippoCampusRobotics';
  // M9: the org's open issues on GitHub (works signed out; a signed-in lab member also sees private repositories')
  const OPEN_ISSUES_URL = 'https://github.com/search?q=org%3AHippoCampusRobotics+is%3Aissue+is%3Aopen&type=issues';
  const PEOPLE_SHOWN = 10;               // M13: the most active contributors shown before "Show all"
  const SHEET_BELOW = 768;               // M17: under this width the dialog is a bottom sheet

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
      subtitle: person ? (str(person.subtitle).trim() || null) : null,
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

  /* Round 2 (R4, Kyle 2026-10-15): who is on the current team. A roster person linked to a GitHub login
     (people-public.json `roster` == name) is current when one of their logins did a commit, PR or review in the
     lab's repositories in the last ACTIVE_DAYS days (`last_active`, a day, compared with today); else an alumnus.
     An admin's `pinned: true` (only the boolean true) holds a linked person in the group they are in: in the
     'active' group, always current; in the alumni group (Kyle 2026-10-16), always an alumnus, whatever their
     GitHub work. A person with no linked login stays in the group an admin put them in. Order: the team = the 'active' group's current people, then the promoted; the alumni = the demoted,
     then the rest. No GitHub layer: everyone stays where they are.
     -> {team: [entry], alumni: [entry]}, entry = {person, from: group id, linked, active, pinned, last} */
  const ACTIVE_DAYS = 30;
  function dayNumber(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(v));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : null;
  }
  function splitTeam(roster, peoplePublic, today) {
    const latest = new Map();          // roster name -> newest day number, or null when linked without one
    const people = peoplePublic && typeof peoplePublic === 'object' ? peoplePublic.people : null;
    if (people && typeof people === 'object') {
      for (const login of Object.keys(people)) {
        const p = people[login];
        const name = p && typeof p.roster === 'string' ? p.roster : null;
        if (!name) continue;
        const d = dayNumber(p.last_active);
        const was = latest.has(name) ? latest.get(name) : null;
        latest.set(name, d !== null && (was === null || d > was) ? d : was);
      }
    }
    const now = dayNumber(today);
    const groups = roster && Array.isArray(roster.groups) ? roster.groups : [];
    const team = [], alumni = [], promoted = [], demoted = [];
    for (const g of groups) {
      const fromTeam = g && g.id === 'active';
      for (const person of (g && Array.isArray(g.people) ? g.people : [])) {
        if (!person || typeof person.name !== 'string' || !person.name.trim()) continue;
        const linked = latest.has(person.name);
        const last = linked ? latest.get(person.name) : null;
        const active = linked && last !== null && now !== null && now - last <= ACTIVE_DAYS;
        const pinned = person.pinned === true;
        const entry = { person, from: fromTeam ? 'active' : String((g && g.id) || ''), linked, active, pinned, last };
        const current = linked ? (pinned ? fromTeam : active) : fromTeam;
        if (fromTeam) (current ? team : demoted).push(entry);
        else (current ? promoted : alumni).push(entry);
      }
    }
    return { team: team.concat(promoted), alumni: demoted.concat(alumni) };
  }

  /* ---- the uiux build (unit M, October 2026) ---- */

  // M5 (R1-4, R2-5): does this event on a person card open the profile dialog? A plain primary click (no
  // modifier: cmd/ctrl/shift/alt-click still opens the personal page in a new tab), or Enter/Space on a
  // link-less card (role="button"); never once something else handled it, and never in Editor mode.
  function cardClickOpensDialog(e, bodyClassList) {
    if (!e || e.defaultPrevented) return false;
    const cl = bodyClassList;
    if (cl && typeof cl.contains === 'function' && (cl.contains('hc-editor-on') || cl.contains('hc-people-edit'))) return false;
    if (e.type === 'click') {
      return (e.button === 0 || e.button === undefined) && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
    }
    if (e.type === 'keydown') return e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar';
    return false;
  }

  // M17: an anchored popover on a wide screen, a bottom sheet on a phone
  function dialogMode(innerWidth) {
    const w = Number(innerWidth);
    return (isFinite(w) && w > 0 && w < SHEET_BELOW) ? 'sheet' : 'pop';
  }

  // login -> summed public commit counts over every project (contributors.json)
  function commitTotals(contributorsDoc) {
    const totals = new Map();
    const projects = contributorsDoc && typeof contributorsDoc === 'object' ? contributorsDoc.projects : null;
    if (!projects || typeof projects !== 'object') return totals;
    Object.keys(projects).forEach((id) => {
      const list = projects[id] && Array.isArray(projects[id].contributors) ? projects[id].contributors : [];
      list.forEach((c) => {
        const login = str(c && c.login).trim();
        const n = num(c && c.contributions);
        if (login && n !== null && n > 0) totals.set(login, (totals.get(login) || 0) + n);
      });
    });
    return totals;
  }

  // M13: models (personModel with a github login) by summed commits, most first; ties and logins missing
  // from contributors.json (they sort last) by name.
  function rankPeople(models, contributorsDoc) {
    const totals = commitTotals(contributorsDoc);
    const score = (m) => {
      const login = m && m.github ? m.github.login : '';
      return totals.has(login) ? totals.get(login) : -1;
    };
    return (Array.isArray(models) ? models : []).slice().sort((a, b) => (score(b) - score(a))
      || str(a && a.name).localeCompare(str(b && b.name)));
  }

  // M5: the project ids a login has public commits in (contributors.json), in the file's order
  function loginProjects(contributorsDoc, login) {
    const projects = contributorsDoc && typeof contributorsDoc === 'object' ? contributorsDoc.projects : null;
    const want = str(login).trim();
    if (!want || !projects || typeof projects !== 'object') return [];
    return Object.keys(projects).filter((id) => {
      const list = projects[id] && Array.isArray(projects[id].contributors) ? projects[id].contributors : [];
      return list.some((c) => c && str(c.login).trim() === want);
    });
  }

  function projectRows(projects) {
    const rows = Array.isArray(projects) ? projects
      : (projects && Array.isArray(projects.projects) ? projects.projects : []);
    return rows.filter((p) => p && typeof p === 'object' && str(p.id));
  }

  // id -> name, for the project links of every dialog
  function projectNames(projects) {
    const map = new Map();
    projectRows(projects).forEach((p) => map.set(p.id, str(p.name).trim() || p.id));
    return map;
  }

  // M11/M12: repository name -> {id, name} of the project that lists it (the coverage rule puts every org
  // repository in exactly one project; the first one wins if a registry ever breaks that)
  function repoProjectMap(projects) {
    const map = new Map();
    projectRows(projects).forEach((p) => {
      (Array.isArray(p.repos) ? p.repos : []).forEach((r) => {
        const name = typeof r === 'string' ? r : str(r && r.name);
        if (name && !map.has(name)) map.set(name, { id: p.id, name: str(p.name).trim() || p.id });
      });
    });
    return map;
  }

  // M12: the setup pages next to repo:<name> in data/graph/wiki.json, at most five, each {id, title, route}
  function repoPages(wiki, repo) {
    const nodes = wiki && Array.isArray(wiki.nodes) ? wiki.nodes : [];
    const edges = wiki && Array.isArray(wiki.edges) ? wiki.edges : [];
    const key = 'repo:' + str(repo);
    const byId = new Map();
    nodes.forEach((n) => { if (n && typeof n === 'object' && str(n.id)) byId.set(n.id, n); });
    const out = [];
    const seen = new Set();
    edges.forEach((e) => {
      if (!e || typeof e !== 'object' || out.length >= 5) return;
      const other = e.t === key ? e.s : (e.s === key ? e.t : null);
      const n = other ? byId.get(other) : null;
      if (!n || n.kind !== 'setup' || seen.has(n.id)) return;
      seen.add(n.id);
      const route = /^#\/setup\/[A-Za-z0-9_/-]+$/.test(str(n.route)) ? n.route : '#/' + n.id;
      out.push({ id: n.id, title: str(n.title).trim() || n.id, route: route });
    });
    return out;
  }

  // P10: a page entry's last_commit day (page-authors.json), or null — read with a guard
  function lastCommitDay(entry) {
    const v = entry && typeof entry === 'object' ? entry.last_commit : null;
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  }

  // M10: the heatmap's spoken summary
  function heatSummary(lay) {
    let total = 0;
    let best = null;
    (lay && Array.isArray(lay.cells) ? lay.cells : []).forEach((c) => {
      total += c.n;
      if (c.n > 0 && (!best || c.n > best.n)) best = c;
    });
    return 'Commits per day, last 53 weeks: ' + total + ' commit' + (total === 1 ? '' : 's')
      + (best ? ', busiest day ' + best.date + ' with ' + best.n : '');
  }
  function cellText(c) {
    return (c.date ? c.date + ' · ' : '') + c.n + ' commit' + (c.n === 1 ? '' : 's');
  }

  // J9/P10: the one quiet "Written by" line: the original authors, then whoever had a pull request MERGED
  // here, each once (a login, else the git name). Open or closed proposals and the conversion are not authors.
  function authorPeople(entry, idx) {
    if (!entry || typeof entry !== 'object') return [];
    const out = [];
    const seen = new Set();
    const add = (login, name) => {
      const t = personToken(idx, login, name);
      if (!t) return;
      const k = t.person.login ? 'l:' + t.person.login : 'n:' + t.person.name.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      out.push(t);
    };
    const orig = entry.original;
    if (orig && typeof orig === 'object' && orig.history_read === true && Array.isArray(orig.authors)) {
      orig.authors.forEach((a) => { if (a && typeof a === 'object') add(a.login, a.name); });
    }
    (Array.isArray(entry.edited_here) ? entry.edited_here : []).forEach((e) => {
      if (e && typeof e === 'object' && e.state === 'merged' && str(e.by)) add(e.by, null);
    });
    return out;
  }

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
    const fetchProjects = env && env.fetchProjects;   // the merged project registry (HC.fetchProjects)
    const loads = {};
    let lastOp = Promise.resolve();
    let seq = 0;
    const listeners = [];

    // the decoration seam: tell each listener a surface is in the page
    function onRender(fn) {
      if (typeof fn !== 'function') return () => {};
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    }
    function announce(surface, el) {
      listeners.slice().forEach((fn) => {
        try { fn(surface, el); } catch (e) { /* a decorator never breaks a render */ }
      });
    }

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
    // (a child that is not el's own stops it: a stand-in node never loops forever)
    function clear(el) { while (el.firstChild && el.firstChild.parentNode === el) el.removeChild(el.firstChild); }
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

    // ---------- the one dialog (M17) ----------
    /* Every overlay of the GitHub layer — a person's profile (M5), a commit (M11), a repository (M12) — is
       this one component: role="dialog", aria-modal, a label, a close button first in the tab order, Tab
       and Shift-Tab wrap inside it, Esc and a click on the backdrop close it, and focus goes back to what
       opened it. Wide screens get a popover anchored to the trigger; a phone (dialogMode) a bottom sheet.
       The dialog and its backdrop are children of document.body, never of #content (plan ground rule 10:
       .content is a CSS container, which would capture a fixed layer). One at a time. */
    let dlg = null;              // {box, backdrop, anchor, mode}
    const payloads = new WeakMap();   // a commit row / repository bar -> what its dialog shows

    function inside(el, root) {
      for (let c = el; c; c = c.parentNode) if (c === root) return true;
      return false;
    }
    function focusables(root) {
      return Array.prototype.slice.call(root.querySelectorAll('a[href], button, [tabindex="0"]'))
        .filter((el) => !el.hasAttribute('disabled') && !el.hasAttribute('hidden'));
    }
    function nextFrame(fn) {
      if (typeof win.requestAnimationFrame === 'function') {
        win.requestAnimationFrame(() => win.requestAnimationFrame(fn));
      } else {
        fn();
      }
    }

    function closeDialog(restore) {
      if (!dlg) return;
      const d = dlg;
      dlg = null;
      [d.box, d.backdrop].forEach((el) => { if (el && el.parentNode) el.parentNode.removeChild(el); });
      if (restore && d.anchor && typeof d.anchor.focus === 'function' && connected(d.anchor)) {
        try { d.anchor.focus(); } catch (e) { /* ignore */ }
      }
    }

    // the popover's place: below the trigger (above when there is no room), inside the viewport, growing
    // out of the trigger (transform-origin). A sheet is placed by its CSS.
    function placeDialog() {
      if (!dlg || dlg.mode !== 'pop') return;
      const box = dlg.box;
      const w = box.offsetWidth || 320;
      const ht = box.offsetHeight || 200;
      const vw = win.innerWidth || 0;
      const vh = win.innerHeight || 0;
      const pad = 8;
      const a = dlg.anchor && typeof dlg.anchor.getBoundingClientRect === 'function'
        ? dlg.anchor.getBoundingClientRect() : null;
      let left;
      let top;
      let below = true;
      if (a) {
        left = Math.min(a.left, vw - w - pad);
        top = a.bottom + 6;
        if (top + ht + pad > vh) {
          const above = a.top - ht - 6;
          below = false;
          top = above >= pad ? above : Math.max(pad, vh - ht - pad);
        }
      } else {
        left = (vw - w) / 2;
        top = Math.max(pad, (vh - ht) / 3);
      }
      left = Math.max(pad, left);
      box.style.left = Math.round(left) + 'px';
      box.style.top = Math.round(top) + 'px';
      const ox = a ? Math.round(Math.min(Math.max(a.left + a.width / 2 - left, 0), w)) : Math.round(w / 2);
      box.style.transformOrigin = ox + 'px ' + (below ? '0' : Math.round(ht) + 'px');
    }

    function openDialog(o) {
      closeDialog(false);
      try { if (win.HCGraph && typeof win.HCGraph.closePopover === 'function') win.HCGraph.closePopover(); } catch (e) { /* ignore */ }
      const mode = dialogMode(win.innerWidth);
      const backdrop = h('div', 'hc-dialog-backdrop is-' + mode);
      backdrop.setAttribute('aria-hidden', 'true');
      backdrop.addEventListener('click', () => closeDialog(true));
      const box = h('div', 'hc-popover hc-dialog is-' + mode + ' is-entering' + (o.cls ? ' ' + o.cls : ''));
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-label', o.label || 'Details');
      box.setAttribute('tabindex', '-1');
      const x = h('button', 'hc-dialog-close', '×');
      x.setAttribute('type', 'button');
      x.setAttribute('aria-label', 'Close');
      x.addEventListener('click', () => closeDialog(true));
      box.appendChild(x);
      o.build(box);
      doc.body.appendChild(backdrop);
      doc.body.appendChild(box);
      dlg = { box: box, backdrop: backdrop, anchor: o.anchor || null, mode: mode };
      placeDialog();
      try { box.focus(); } catch (e) { /* ignore */ }
      nextFrame(() => box.classList.remove('is-entering'));
      return box;
    }

    // Tab and Shift-Tab wrap inside the open dialog; Esc closes it and focus goes back to the trigger
    function onDialogKey(e) {
      if (!dlg) return;
      if (e.key === 'Escape' || e.key === 'Esc' || e.keyCode === 27) {
        closeDialog(true);
        return;
      }
      if (e.key !== 'Tab') return;
      const list = focusables(dlg.box);
      e.preventDefault();
      if (!list.length) return;
      const at = list.indexOf(doc.activeElement);
      let next;
      if (at < 0) next = e.shiftKey ? list[list.length - 1] : list[0];
      else next = list[(at + (e.shiftKey ? -1 : 1) + list.length) % list.length];
      try { next.focus(); } catch (err) { /* ignore */ }
    }

    let projectsLoad = null;
    function projectsDoc() {
      if (!projectsLoad) {
        projectsLoad = typeof fetchProjects === 'function'
          ? Promise.resolve().then(() => fetchProjects()).catch(() => null) : Promise.resolve(null);
      }
      return projectsLoad;
    }
    function photoUrl(url) {
      const team = win.HCTeam;
      return team && typeof team.cloudinaryTx === 'function' ? team.cloudinaryTx(url, 'w_320,f_auto,q_auto') : url;
    }
    function projectLink(p) { return link('#/projects/' + p.id, 'hc-pp-project', p.name); }
    function factRow(dl, label, value) {
      if (value == null || value === '') return;
      dl.appendChild(h('dt', '', label));
      const dd = h('dd');
      if (typeof value === 'string') dd.textContent = value; else dd.appendChild(value);
      dl.appendChild(dd);
    }

    // ---------- the person dialog (M5) ----------

    function personBody(box, model, projects) {
      const head = h('div', 'hc-pp-head');
      let media;
      if (model.photo) {
        media = h('img', 'hc-pp-media');
        media.setAttribute('src', photoUrl(model.photo));
        media.setAttribute('alt', '');
        media.setAttribute('width', '96');
        media.setAttribute('height', '96');
      } else {
        media = h('div', 'hc-pp-media hc-pp-initials', model.initials);
        media.setAttribute('aria-hidden', 'true');
      }
      const who = h('div', 'hc-pp-who');
      who.appendChild(h('p', 'hc-pop-title', model.name));
      if (model.title) who.appendChild(h('p', 'hc-pp-title', model.title));
      if (model.subtitle) who.appendChild(h('p', 'hc-pp-title hc-pp-sub', model.subtitle));
      head.appendChild(media);
      head.appendChild(who);
      box.appendChild(head);
      if (projects.length) {
        const row = h('div', 'hc-pp-projects');
        row.appendChild(h('p', 'hc-pop-kind', 'Projects'));
        const list = h('p', 'hc-pp-plist');
        joinNames(projects).forEach((t) => list.appendChild(typeof t === 'string' ? doc.createTextNode(t) : projectLink(t)));
        row.appendChild(list);
        box.appendChild(row);
      }
      if (model.github) {
        const gh = h('div', 'hc-pp-gh');
        if (model.github.avatar) gh.appendChild(avatarImg(model.github.avatar, 'lg'));
        const label = '@' + model.github.login + ' on GitHub';
        gh.appendChild(model.github.url ? link(model.github.url, 'hc-pp-gh-link', label) : h('span', '', label));
        box.appendChild(gh);
      }
      if (model.link) {
        const row = h('p', 'hc-pp-links');
        row.appendChild(link(model.link, 'hc-pop-open', 'Personal page →'));
        box.appendChild(row);
      }
    }

    function openPerson(anchor, q) {
      if (!doc) return Promise.resolve();
      const mine = (seq += 1);
      closeDialog(false);
      try { if (win.HCGraph && typeof win.HCGraph.closePopover === 'function') win.HCGraph.closePopover(); } catch (e) { /* ignore */ }
      lastOp = Promise.all([need(['people', 'roster', 'contrib']), projectsDoc()]).then((r) => {
        const d = r[0];
        if (mine !== seq) return;
        const model = personModel(indexOf(d), q);
        if (!model.name) return;
        const names = projectNames(r[1]);
        const projects = (model.github ? loginProjects(d.contrib.value, model.github.login) : [])
          .filter((id) => names.has(id)).map((id) => ({ id: id, name: names.get(id) }));
        const box = openDialog({ anchor: anchor, label: model.name, cls: 'hc-person-pop',
          build: (b) => personBody(b, model, projects) });
        box.setAttribute('data-hc-surface', 'popover');
        if (model.github && LOGIN_RE.test(model.github.login)) box.setAttribute('data-hc-login', model.github.login);
        announce('popover', box);
      }).catch(() => { closeDialog(false); });
      return lastOp;
    }

    // ---------- the commit dialog (M11) and the repository dialog (M12) ----------

    function projectValue(p) { return p ? projectLink(p) : 'Not in a project'; }

    function openCommit(anchor, c) {
      const mine = (seq += 1);
      closeDialog(false);
      lastOp = Promise.all([need(['people', 'roster']), projectsDoc()]).then((r) => {
        if (mine !== seq) return;
        const idx = indexOf(r[0]);
        const repo = REPO_RE.test(str(c.repo)) ? c.repo : '';
        const sha = SHA_RE.test(str(c.sha)) ? c.sha.slice(0, 7) : '';
        openDialog({ anchor: anchor, label: 'Commit' + (sha ? ' ' + sha : ''), cls: 'hc-commit-pop', build: (b) => {
          b.appendChild(h('p', 'hc-pop-kind', 'Commit'));
          b.appendChild(h('p', 'hc-pop-title hc-cd-msg', str(c.msg)));
          const dl = h('dl', 'hc-facts');
          const login = str(c.author).trim();
          if (login && LOGIN_RE.test(login)) {
            const m = personModel(idx, { login: login });
            const who = h('span', 'hc-cd-who');
            if (m.github && m.github.avatar) who.appendChild(avatarImg(m.github.avatar, 'xs'));
            who.appendChild(h('span', 'hc-person-name', m.name));
            if (m.github && m.github.url) {
              who.appendChild(doc.createTextNode(' '));
              who.appendChild(link(m.github.url, 'hc-mono', '@' + login));
            }
            factRow(dl, 'Author', who);
          }
          if (repo) factRow(dl, 'Repository', link(ORG_URL + '/' + repo, 'hc-mono', repo));
          factRow(dl, 'Project', projectValue(repoProjectMap(r[1]).get(repo)));
          factRow(dl, 'Date', readAtDay(c.date));
          if (repo && sha) factRow(dl, 'Commit', link(ORG_URL + '/' + repo + '/commit/' + sha, 'hc-mono', sha));
          b.appendChild(dl);
        } });
      }).catch(() => { closeDialog(false); });
      return lastOp;
    }

    function openRepo(anchor, bar) {
      const mine = (seq += 1);
      closeDialog(false);
      const name = str(bar.name);
      lastOp = Promise.all([need(['repos', 'wiki']), projectsDoc()]).then((r) => {
        if (mine !== seq) return;
        const card = r[0].repos.ok ? (repoIndex(r[0].repos.value).get(name) || null) : null;
        openDialog({ anchor: anchor, label: 'Repository ' + name, cls: 'hc-repo-pop', build: (b) => {
          b.appendChild(h('p', 'hc-pop-kind', 'Repository'));
          const title = h('p', 'hc-pop-title');
          const href = (card && githubRepoUrl(card.html_url)) || (REPO_RE.test(name) ? ORG_URL + '/' + name : null);
          title.appendChild(href ? link(href, 'hc-mono', name) : h('span', 'hc-mono', name));
          b.appendChild(title);
          const desc = card ? str(card.description).trim() : '';
          if (desc) b.appendChild(h('p', 'hc-pop-summary', desc));
          const dl = h('dl', 'hc-facts');
          factRow(dl, 'Project', projectValue(repoProjectMap(r[1]).get(name)));
          const n = num(bar.commits);
          if (n !== null) factRow(dl, 'Last 365 days', n + ' commit' + (n === 1 ? '' : 's'));
          b.appendChild(dl);
          const pages = r[0].wiki.ok ? repoPages(r[0].wiki.value, name) : [];
          if (pages.length) {
            b.appendChild(h('p', 'hc-pop-kind hc-rd-kind', 'Setup pages that mention it'));
            const ul = h('ul', 'hc-rd-pages');
            pages.forEach((p) => {
              const li = h('li');
              li.appendChild(link(p.route, '', p.title));
              ul.appendChild(li);
            });
            b.appendChild(ul);
          }
        } });
      }).catch(() => { closeDialog(false); });
      return lastOp;
    }

    // One delegated handler per root. A People card (data-hc-person) opens the profile on a plain click,
    // or on Enter/Space when it is a link-less card (cardClickOpensDialog); a modifier click on a linked card
    // is left to the browser (a new tab). Any GitHub-derived name (data-hc-login) opens that person; a
    // commit row or a repository bar (data-hc-open) its own dialog. Nothing happens in Editor mode or when
    // something else already handled the event (js/editor-frame.js wireCard preventDefaults).
    function onTrigger(e) {
      if (!e || e.defaultPrevented) return;
      const cl = doc.body && doc.body.classList;
      if (cl && (cl.contains('hc-editor-on') || cl.contains('hc-people-edit'))) return;
      const t = e.target && typeof e.target.closest === 'function'
        ? e.target.closest('[data-hc-person], [data-hc-login], [data-hc-open]') : null;
      if (!t) return;
      if (t.hasAttribute('data-hc-person')) {
        if (e.type === 'keydown' && t.localName === 'a') return;     // Enter on a link: the browser's click follows
        if (!cardClickOpensDialog(e, cl)) return;
        e.preventDefault();
        openPerson(t, { roster: t.getAttribute('data-hc-person') });
        return;
      }
      if (e.type !== 'click') return;                                // a button turns Enter/Space into a click
      e.preventDefault();
      const payload = payloads.get(t);
      if (payload && payload.kind === 'commit') openCommit(t, payload.value);
      else if (payload && payload.kind === 'repo') openRepo(t, payload.value);
      else if (t.getAttribute('data-hc-login')) openPerson(t, { login: t.getAttribute('data-hc-login') });
    }
    function wire(root) {
      if (!root || root.getAttribute('data-hc-wired') === '1') return;
      root.setAttribute('data-hc-wired', '1');
      root.addEventListener('click', onTrigger);
      root.addEventListener('keydown', onTrigger);
    }

    // The Team page's people: every card (js/app.js personCardHTML marks it data-hc-person) opens a profile.
    function wirePeople(root) {
      if (!doc || !root) return Promise.resolve();
      wire(root);
      return need(['people', 'roster']).then(() => {
        root.setAttribute('data-hc-surface', 'people');
        if (connected(root)) announce('people', root);
      });
    }

    // ---------- who wrote this (J9, P10: one quiet line) ----------

    function renderAuthors(body, pageId) {
      if (!doc || !body || typeof pageId !== 'string') return Promise.resolve();
      return need(['authors', 'people', 'roster']).then((d) => {
        if (!d.authors.ok) return;
        const pages = d.authors.value && d.authors.value.pages;
        const entry = has(pages, pageId) ? pages[pageId] : null;
        if (!entry || typeof entry !== 'object') return;
        if (!connected(body) || body.querySelector('.hc-authors')) return;
        const people = authorPeople(entry, indexOf(d));
        if (!people.length) return;
        const box = h('section', 'hc-authors');
        box.setAttribute('aria-label', 'Who wrote this');
        box.setAttribute('data-hc-surface', 'authors');
        box.setAttribute('data-hc-page', pageId);
        const row = h('p', 'hc-authors-line');
        const faces = people.map((t) => t.person.avatar).filter(Boolean).slice(0, 3);
        if (faces.length) {
          const stack = h('span', 'hc-stack');
          stack.setAttribute('aria-hidden', 'true');
          faces.forEach((src) => stack.appendChild(avatarImg(src, 'xs')));
          row.appendChild(stack);
        }
        ['Written by '].concat(joinNames(people), ['.']).forEach((t) => {
          row.appendChild(typeof t === 'string' ? doc.createTextNode(t) : personButton(t));
        });
        box.appendChild(row);
        wire(box);
        body.appendChild(box);
        announce('authors', box);
      });
    }

    // ---------- repo cards (J5: name, one-line purpose; the facts in the title) ----------

    function repoCard(name, role, fallbackHref, r) {
      const href = (r && githubRepoUrl(r.html_url)) || safeHttpUrl(fallbackHref);
      const card = href ? link(href, 'hc-repo') : h('div', 'hc-repo');
      const nm = h('span', 'nm');
      const dot = h('span', 'hc-lang');
      dot.setAttribute('aria-hidden', 'true');
      if (r && str(r.language)) dot.setAttribute('data-lang', str(r.language));
      nm.appendChild(dot);
      nm.appendChild(h('span', 'hc-repo-name', name));
      card.appendChild(nm);
      const purpose = str(role).trim() || (r ? str(r.description).trim() : '');
      if (purpose) card.appendChild(h('span', 'hc-repo-purpose', purpose));
      if (r) card.setAttribute('title', repoCardFacts(r).map((f) => f.text).join(' · '));
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

    // ---------- the Lab activity section ----------

    // M10: one site-styled tooltip for the heatmap, on document.body (ground rule 10)
    let tip = null;
    function showTip(target, text) {
      if (!doc.body) return;
      if (!tip) {
        tip = h('div', 'hc-tip');
        tip.setAttribute('role', 'tooltip');
        tip.setAttribute('id', 'hc-heat-tip');
      }
      if (tip.parentNode !== doc.body) doc.body.appendChild(tip);
      tip.textContent = text;
      tip.classList.add('is-on');
      const r = typeof target.getBoundingClientRect === 'function' ? target.getBoundingClientRect() : null;
      if (!r) return;
      const w = tip.offsetWidth || 120;
      const ht = tip.offsetHeight || 24;
      const vw = win.innerWidth || 0;
      const left = Math.max(4, Math.min(r.left + r.width / 2 - w / 2, vw - w - 4));
      let top = r.top - ht - 6;
      if (top < 4) top = r.bottom + 6;
      tip.style.left = Math.round(left) + 'px';
      tip.style.top = Math.round(top) + 'px';
    }
    function hideTip() { if (tip) tip.classList.remove('is-on'); }

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
      const summary = heatSummary(lay);
      const wrap = h('div', 'hc-heat-scroll');
      // M10 (R1-11): the SVG is the ONE tab stop; Arrow keys move a focus ring over the days
      const root = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': summary,
        tabindex: 0, class: 'hc-heat-svg' });
      lay.months.forEach((m) => {
        root.appendChild(svg('text', { x: left + m.col * (cell + gap), y: 11, class: 'hc-heat-label' }, m.label));
      });
      [['Mon', 0], ['Wed', 2], ['Fri', 4]].forEach((d) => {
        root.appendChild(svg('text', { x: 0, y: top + d[1] * (cell + gap) + 10, class: 'hc-heat-label' }, d[0]));
      });
      const rects = [];
      const at = new Map();
      lay.cells.forEach((c, i) => {
        const rect = svg('rect', { x: left + c.col * (cell + gap), y: top + c.row * (cell + gap),
          width: cell, height: cell, rx: 2, class: 'hc-l' + c.level, 'data-i': i });
        rects.push(rect);
        at.set(c.col * 7 + c.row, i);
        root.appendChild(rect);
      });
      const ring = svg('rect', { class: 'hc-focus', width: cell + 2, height: cell + 2, rx: 3, x: -99, y: -99,
        'aria-hidden': 'true' });
      root.appendChild(ring);
      const live = h('p', 'hc-sr-only');
      live.setAttribute('aria-live', 'polite');
      let current = -1;
      const cellOf = (t) => {
        const i = t && typeof t.getAttribute === 'function' ? Number(t.getAttribute('data-i')) : NaN;
        return Number.isInteger(i) && i >= 0 && i < rects.length ? i : -1;
      };
      const focusCell = (i) => {
        current = i;
        const c = lay.cells[i];
        ring.setAttribute('x', String(left + c.col * (cell + gap) - 1));
        ring.setAttribute('y', String(top + c.row * (cell + gap) - 1));
        ring.classList.add('is-on');
        // WCAG-5: a narrow scroller follows the cursor (at 375 px the newest weeks start off-screen)
        if (typeof rects[i].scrollIntoView === 'function') rects[i].scrollIntoView({ block: 'nearest', inline: 'nearest' });
        showTip(rects[i], cellText(c));
        live.textContent = cellText(c);
      };
      root.addEventListener('pointerover', (e) => {
        const i = cellOf(e.target);
        if (i >= 0) showTip(rects[i], cellText(lay.cells[i]));
      });
      root.addEventListener('pointerout', (e) => { if (cellOf(e.target) >= 0) hideTip(); });
      root.addEventListener('keydown', (e) => {
        if (!rects.length) return;
        if (e.key === 'Escape' || e.key === 'Esc') {
          if (tip && tip.classList.contains('is-on')) { hideTip(); e.stopPropagation(); }
          return;
        }
        const move = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[e.key];
        let next = -1;
        if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = rects.length - 1;
        else if (move) {
          if (current < 0) next = rects.length - 1;
          else {
            const c = lay.cells[current];
            const k = (c.col + move[0]) * 7 + (c.row + move[1]);
            next = (c.row + move[1] >= 0 && c.row + move[1] < 7 && at.has(k)) ? at.get(k) : current;
          }
        } else return;
        e.preventDefault();
        focusCell(next);
      });
      // WCAG-5: keyboard focus arriving shows the cursor at once (the newest day, or where it was left).
      // Review S-3: a tap or click also focuses the svg (tabindex 0); that focus must not move the cursor to
      // the newest day nor scroll the strip from under the finger, so a pointerdown marks the next focus.
      let pointerFocus = false;
      root.addEventListener('pointerdown', () => { pointerFocus = true; });
      root.addEventListener('focus', () => {
        if (pointerFocus) { pointerFocus = false; return; }
        if (rects.length) focusCell(current >= 0 ? current : rects.length - 1);
      });
      root.addEventListener('blur', () => { pointerFocus = false; ring.classList.remove('is-on'); hideTip(); });
      wrap.appendChild(root);
      box.appendChild(wrap);
      const sr = h('p', 'hc-sr-only', summary + '.');
      box.appendChild(sr);
      box.appendChild(live);
      const legend = h('div', 'legend');
      legend.setAttribute('aria-hidden', 'true');
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

    // M11: the ten newest commits; each row names its author and opens the commit dialog
    function recentCommits(list, idx) {
      const col = column('Recent commits');
      const rows = (Array.isArray(list) ? list : []).filter((c) => c && typeof c === 'object').slice(0, 10);
      if (!rows.length) col.appendChild(h('p', 'hc-empty', 'No commits in the last 365 days.'));
      rows.forEach((c) => {
        const row = h('button', 'hc-commit');
        row.setAttribute('type', 'button');
        row.setAttribute('data-hc-open', 'commit');
        row.setAttribute('aria-haspopup', 'dialog');
        if (REPO_RE.test(str(c.repo)) && SHA_RE.test(str(c.sha))) {
          row.setAttribute('data-hc-repo', c.repo);
          row.setAttribute('data-hc-sha', c.sha.slice(0, 7));
        }
        payloads.set(row, { kind: 'commit', value: c });
        const main = h('span', 'hc-commit-main');
        main.appendChild(h('span', 'm', str(c.msg)));
        const s = h('span', 's');
        if (str(c.repo)) s.appendChild(h('span', 'repo', str(c.repo)));
        const day = readAtDay(c.date);
        if (day) s.appendChild(h('span', '', day));
        main.appendChild(s);
        row.appendChild(main);
        const login = str(c.author).trim();
        if (login && LOGIN_RE.test(login)) {
          const m = personModel(idx, { login: login });
          const who = h('span', 'hc-commit-who');
          if (m.github && m.github.avatar) who.appendChild(avatarImg(m.github.avatar, 'xs'));
          else {
            const ini = h('span', 'hc-avatar xs hc-avatar-empty', m.initials);
            ini.setAttribute('aria-hidden', 'true');
            who.appendChild(ini);
          }
          who.appendChild(h('span', 'nm', m.name));
          row.appendChild(who);
        }
        col.appendChild(row);
      });
      return col;
    }

    // M2/M12: a repository name never breaks (CSS); each bar opens the repository dialog; no language label
    function activeRepos(list, releases) {
      const col = column('Most active repositories');
      const rows = (Array.isArray(list) ? list : []).filter((r) => r && str(r.name));
      const max = Math.max(1, ...rows.map((r) => num(r.commits) || 0));
      if (!rows.length) col.appendChild(h('p', 'hc-empty', 'No commits in the last 365 days.'));
      rows.forEach((r) => {
        const n = num(r.commits) || 0;
        const bar = h('button', 'hc-bar');
        bar.setAttribute('type', 'button');
        bar.setAttribute('data-hc-open', 'repo');
        bar.setAttribute('aria-haspopup', 'dialog');
        payloads.set(bar, { kind: 'repo', value: r });
        const nm = h('span', 'name', r.name);
        nm.setAttribute('title', r.name);
        bar.appendChild(nm);
        bar.appendChild(h('span', 'n', n + ' commit' + (n === 1 ? '' : 's')));
        const track = h('span', 'track');
        track.setAttribute('aria-hidden', 'true');
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

    function personRow(m) {
      const row = h('button', 'hc-person-row');
      row.setAttribute('type', 'button');
      row.setAttribute('data-hc-login', m.github.login);
      row.setAttribute('aria-haspopup', 'dialog');
      if (m.github.avatar) row.appendChild(avatarImg(m.github.avatar, 'md'));
      else row.appendChild(h('span', 'hc-avatar md hc-avatar-empty', m.initials));
      const txt = h('span', 'who');
      txt.appendChild(h('span', 'nm', m.name));
      txt.appendChild(h('span', 'sub', '@' + m.github.login));
      row.appendChild(txt);
      return row;
    }

    // M13: the ten most active contributors (public commit counts, never drawn); the rest folded away
    function peopleColumn(d) {
      const col = column('People on GitHub');
      col.setAttribute('data-hc-slot', 'lab-people');
      if (!d.people.ok) { col.appendChild(failNote(d.people.status)); return col; }
      const idx = indexOf(d);
      const models = [];
      idx.byLogin.forEach((e, login) => {
        const m = personModel(idx, { login: login });
        if (m.name && m.github) models.push(m);
      });
      const ranked = rankPeople(models, d.contrib && d.contrib.value);
      ranked.slice(0, PEOPLE_SHOWN).forEach((m) => col.appendChild(personRow(m)));
      if (ranked.length > PEOPLE_SHOWN) {
        const more = h('details', 'hc-more');
        more.appendChild(h('summary', '', 'Show all ' + ranked.length));
        ranked.slice(PEOPLE_SHOWN).forEach((m) => more.appendChild(personRow(m)));
        col.appendChild(more);
      }
      return col;
    }

    /* opts.embedded (round 2, R5): a section of the Team page, whose heading and "GitHub data as of" line
       js/app.js draws (M6/M7); the plain form keeps its own h1 and as-of line. */
    function renderLab(container, isCurrent, opts) {
      if (!doc || !container) return Promise.resolve();
      const embedded = Boolean(opts && opts.embedded);
      return need(['activity', 'people', 'roster', 'contrib']).then((d) => {
        if (typeof isCurrent === 'function' && !isCurrent()) return;
        clear(container);
        const root = h('div', embedded ? 'hc-lab is-embedded' : 'page-body hc-lab');
        root.setAttribute('data-hc-surface', 'lab');
        const act = d.activity.ok && d.activity.value && typeof d.activity.value === 'object'
          ? d.activity.value : null;
        if (!embedded) {
          root.appendChild(h('h1', '', 'Lab activity'));
          if (act) root.appendChild(h('p', 'hc-asof', 'GitHub data as of ' + (readAtDay(act.read_at) || 'an unknown date')));
        }
        if (!act) {
          root.appendChild(failNote(d.activity.status));
          container.appendChild(root);
          return;
        }
        const t = (act.totals && typeof act.totals === 'object') ? act.totals : {};
        // M4/M8/M9: three tiles; the open issues open GitHub's issue search for the org
        const tiles = h('div', 'hc-tiles');
        [['commits_365d', 'commits, last 365 days', null], ['public_repos', 'public repositories', null],
          ['open_issues', 'open issues', OPEN_ISSUES_URL]].forEach((x) => {
          const n = num(t[x[0]]);
          if (n === null) return;
          const tile = x[2] ? link(x[2], 'hc-tile is-link') : h('div', 'hc-tile');
          if (x[2]) tile.setAttribute('aria-label', n + ' ' + x[1] + ' on GitHub (opens in a new tab)');
          tile.appendChild(h('span', 'n', String(n)));
          tile.appendChild(h('span', 'l', x[1] + (x[2] ? ' ↗' : '')));
          tiles.appendChild(tile);
        });
        root.appendChild(tiles);
        const weeks = Array.isArray(act.weeks) ? act.weeks
          : (act.heatmap && Array.isArray(act.heatmap.weeks)) ? act.heatmap.weeks
            : (Array.isArray(act.heatmap) ? act.heatmap : []);
        root.appendChild(heatmap(weeks));
        const cols = h('div', 'hc-cols');
        cols.appendChild(recentCommits(act.recent_commits, indexOf(d)));
        cols.appendChild(activeRepos(act.most_active_repos, act.releases));
        cols.appendChild(peopleColumn(d));
        root.appendChild(cols);
        wire(root);
        container.appendChild(root);
        announce('lab', root);
      });
    }

    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener('keydown', onDialogKey);
    }
    if (typeof win.addEventListener === 'function') {
      win.addEventListener('hashchange', () => { closeDialog(false); hideTip(); });
      win.addEventListener('resize', () => {
        if (dlg && dialogMode(win.innerWidth) !== dlg.mode) closeDialog(false); else placeDialog();
      });
      win.addEventListener('scroll', placeDialog, true);
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
      closePerson: () => closeDialog(false),
      whenReady: () => lastOp,
      onRender: onRender,
    };
  }

  const runtime = createLab(HAS_DOM ? {
    doc: document,
    win: window,
    fetchJSON: (path) => (window.HC ? window.HC.fetchJSON(path) : Promise.reject(new Error('HC missing'))),
    fetchProjects: () => (window.HC && typeof window.HC.fetchProjects === 'function'
      ? window.HC.fetchProjects() : Promise.reject(new Error('HC missing'))),
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
    splitTeam: splitTeam,
    ACTIVE_DAYS: ACTIVE_DAYS,
    cardClickOpensDialog: cardClickOpensDialog,
    dialogMode: dialogMode,
    rankPeople: rankPeople,
    loginProjects: loginProjects,
    repoProjectMap: repoProjectMap,
    repoPages: repoPages,
    lastCommitDay: lastCommitDay,
    heatSummary: heatSummary,
    authorPeople: authorPeople,
    createLab: createLab,
  }, runtime));

  if (typeof window !== 'undefined') window.HCLab = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
}());
