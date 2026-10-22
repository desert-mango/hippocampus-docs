// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 1 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test the guest GitHub surfaces in js/lab.js: helpers, fetch set, escaping and privacy.
/* Unit tests for js/lab.js (the Lab page, repo cards, the person popover and "who wrote
   this"). The pure helpers load through require, like test_graph_ui.mjs. The renderers run
   against a small fake DOM defined below: it never parses HTML, and it THROWS on any
   non-empty innerHTML write, so a hostile GitHub string can only ever reach the page as
   text. Fixtures are written inline; the real files come from tools/build_github_data.py.

     node --test tools/tests/test_lab_ui.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const LAB = require(new URL('../../js/lab.js', import.meta.url).pathname);
const GRAPH = require(new URL('../../js/graph.js', import.meta.url).pathname);

const {
  heatLevel, weekLayout, repoCardFacts, authorLine, authorLines, buildPeopleIndex, personModel,
  avatarPath, githubProfileUrl, readAtDay, createLab, SOURCES,
  cardClickOpensDialog, dialogMode, rankPeople, loginProjects, repoProjectMap, repoPages, lastCommitDay,
  heatSummary, authorPeople,
} = LAB;

// ------------------------------------------------------------------ fake DOM
const SVG_NS = 'http://www.w3.org/2000/svg';
function makeDoc() {
  const created = [];
  const htmlWrites = [];
  const docListeners = {};
  function matchesOne(el, part) {
    const m = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+)*)((?:\[[\w-]+(?:="[^"]*")?\])*)$/.exec(part);
    if (!m) throw new Error('fake DOM cannot parse selector ' + part);
    if (m[1] && el.localName !== m[1].toLowerCase()) return false;
    const classes = m[2] ? m[2].split('.').filter(Boolean) : [];
    if (!classes.every((c) => el.classList.contains(c))) return false;
    const attrs = m[3] ? m[3].match(/\[[^\]]+\]/g) : [];
    return attrs.every((a) => {
      const am = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(a);
      if (!el.hasAttribute(am[1])) return false;
      return am[2] === undefined || el.getAttribute(am[1]) === am[2];
    });
  }
  function matches(el, sel) {
    return sel.split(',').map((s) => s.trim()).some((one) => {
      const parts = one.split(/\s+/);
      if (!matchesOne(el, parts[parts.length - 1])) return false;
      let i = parts.length - 2;
      let cur = el.parentNode;
      while (i >= 0 && cur && cur.nodeType === 1) {
        if (matchesOne(cur, parts[i])) i -= 1;
        cur = cur.parentNode;
      }
      return i < 0;
    });
  }
  class Text {
    constructor(v) { this.nodeType = 3; this.data = String(v); this.parentNode = null; }
    get textContent() { return this.data; }
    get nodeValue() { return this.data; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  }
  class Frag {
    constructor() { this.nodeType = 11; this.childNodes = []; }
    appendChild(n) { this.childNodes.push(n); n.parentNode = this; return n; }
  }
  class El {
    constructor(tag, ns) {
      this.localName = String(tag).toLowerCase();
      this.tagName = this.localName.toUpperCase();
      this.namespaceURI = ns || 'http://www.w3.org/1999/xhtml';
      this.nodeType = 1; this.childNodes = []; this.parentNode = null;
      this.attrs = new Map(); this.listeners = {}; this.style = {};
      created.push(this);
    }
    get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
    get firstChild() { return this.childNodes[0] || null; }
    get ownerDocument() { return doc; }
    get isConnected() {
      let c = this;
      while (c.parentNode) c = c.parentNode;
      return c === doc.documentElement;
    }
    appendChild(n) {
      if (n.nodeType === 11) { n.childNodes.slice().forEach((c) => this.appendChild(c)); n.childNodes = []; return n; }
      if (n.parentNode && n.parentNode.removeChild) n.parentNode.removeChild(n);
      n.parentNode = this; this.childNodes.push(n); return n;
    }
    append(...ns) { ns.forEach((n) => this.appendChild(typeof n === 'string' ? new Text(n) : n)); }
    insertBefore(n, ref) {
      if (!ref) return this.appendChild(n);
      if (n.parentNode && n.parentNode.removeChild) n.parentNode.removeChild(n);
      const i = this.childNodes.indexOf(ref);
      n.parentNode = this; this.childNodes.splice(i, 0, n); return n;
    }
    removeChild(n) {
      const i = this.childNodes.indexOf(n);
      if (i >= 0) this.childNodes.splice(i, 1);
      n.parentNode = null; return n;
    }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    replaceWith(n) { const p = this.parentNode; if (!p) return; p.insertBefore(n, this); p.removeChild(this); }
    setAttribute(k, v) { this.attrs.set(String(k), String(v)); }
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
    hasAttribute(k) { return this.attrs.has(k); }
    removeAttribute(k) { this.attrs.delete(k); }
    get className() { return this.getAttribute('class') || ''; }
    set className(v) { this.setAttribute('class', v); }
    get id() { return this.getAttribute('id') || ''; }
    set id(v) { this.setAttribute('id', v); }
    get classList() {
      const self = this;
      const list = () => self.className.split(/\s+/).filter(Boolean);
      return {
        contains: (c) => list().includes(c),
        add: (...cs) => { self.className = Array.from(new Set(list().concat(cs))).join(' '); },
        remove: (...cs) => { self.className = list().filter((x) => !cs.includes(x)).join(' '); },
        toggle: (c, force) => {
          const on = force === undefined ? !list().includes(c) : !!force;
          if (on) self.classList.add(c); else self.classList.remove(c);
          return on;
        },
      };
    }
    get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
    set textContent(v) {
      this.childNodes.forEach((c) => { c.parentNode = null; });
      this.childNodes = [];
      if (v !== '' && v != null) this.appendChild(new Text(v));
    }
    set innerHTML(v) {
      htmlWrites.push(String(v));
      if (String(v) !== '') throw new Error('innerHTML write: ' + String(v).slice(0, 60));
      this.textContent = '';
    }
    get innerHTML() { return ''; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
    matches(sel) { return matches(this, sel); }
    closest(sel) {
      let c = this;
      while (c && c.nodeType === 1) { if (matches(c, sel)) return c; c = c.parentNode; }
      return null;
    }
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => n.children.forEach((c) => { if (matches(c, sel)) out.push(c); walk(c); });
      walk(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    getBoundingClientRect() { return { left: 10, top: 10, right: 40, bottom: 40, width: 30, height: 30 }; }
    focus() { doc.activeElement = this; }
    scrollIntoView(opts) { doc.scrolls.push({ el: this, opts }); }
    get offsetWidth() { return 300; }
    get offsetHeight() { return 160; }
  }
  const doc = {
    created, htmlWrites, scrolls: [],
    createElement: (t) => new El(t),
    createElementNS: (ns, t) => new El(t, ns),
    createTextNode: (v) => new Text(v),
    createDocumentFragment: () => new Frag(),
    addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
    removeEventListener: () => {},
    activeElement: null,
  };
  doc.documentElement = new El('html');
  doc.body = new El('body');
  doc.documentElement.appendChild(doc.body);
  doc.dispatch = (target, type, init) => {
    const ev = Object.assign({
      type, target, defaultPrevented: false, _stop: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this._stop = true; },
    }, init || {});
    let c = target;
    while (c && !ev._stop) {
      ((c.listeners && c.listeners[type]) || []).slice().forEach((fn) => fn(ev));
      c = c.parentNode;
    }
    if (!ev._stop) (docListeners[type] || []).slice().forEach((fn) => fn(ev));
    return ev;
  };
  return doc;
}

const WIN = { innerWidth: 1200, innerHeight: 800, addEventListener() {}, location: { hash: '#/lab' } };

function fakeFetch(files) {
  const calls = [];
  const fetchJSON = (path) => {
    calls.push(path);
    if (Object.prototype.hasOwnProperty.call(files, path)) {
      return Promise.resolve(JSON.parse(JSON.stringify(files[path])));
    }
    const err = new Error(path + ': HTTP 404');
    err.status = 404;
    return Promise.reject(err);
  };
  return { fetchJSON, calls };
}

// ------------------------------------------------------------------ fixtures
const HOSTILE = '<img src=x onerror=alert(1)>';

function weeks53() {
  const out = [];
  const start = Date.UTC(2025, 8, 29);      // a Monday
  for (let w = 0; w < 53; w += 1) {
    const d = new Date(start + w * 7 * 864e5).toISOString().slice(0, 10);
    const days = [0, 0, 0, 0, 0, 0, 0];
    if (w === 10) days[2] = 4;
    if (w === 20) days[0] = 1;
    if (w === 52) { days[5] = null; days[6] = null; }
    out.push({ week: d, days });
  }
  return out;
}

const PEOPLE = {
  groups: [
    { id: 'active', title: 'Team', people: [
      { name: 'Nathalie Bauschmann', title: 'Research Associate', photo: null, link: 'https://www.tuhh.de/mum/team/wimi/nathalie-bauschmann' },
      { name: 'Kyle Nelson', title: 'Visiting Researcher', photo: null, link: null },
      { name: 'Ada Nomatch', title: 'Student', photo: null, link: null },
      { name: 'Lina Linked', title: 'Student', photo: null, link: 'https://example.org/lina' },
    ] },
    { id: 'alumni', title: 'Alumni', people: [
      { name: 'Daniel-André Dücker', title: 'Senior Scientist (TUM)', photo: 'https://res.cloudinary.com/x/image/upload/v1/people/dd.jpg', link: 'https://www.tuhh.de/mum/team/wimi/daniel-duecker' },
      { name: 'René Hochdahl', title: 'Master Student', photo: null, link: 'https://example.org/rene' },
    ] },
  ],
};

const PEOPLE_PUBLIC = {
  read_at: '2026-09-28',
  people: {
    NBauschmann: { login: 'NBauschmann', name: 'Nathalie Bauschmann', avatar: 'data/graph/avatars/NBauschmann.png', html_url: 'https://github.com/NBauschmann', roster: 'Nathalie Bauschmann' },
    DanielDuecker: { login: 'DanielDuecker', name: 'Daniel Duecker', avatar: 'data/graph/avatars/DanielDuecker.jpg', html_url: 'https://github.com/DanielDuecker', roster: 'Daniel-André Dücker' },
    RHochdahl: { login: 'RHochdahl', name: 'RHochdahl', avatar: null, html_url: 'https://github.com/RHochdahl', roster: 'René Hochdahl' },
    'kyle-nelson-berkeley': { login: 'kyle-nelson-berkeley', name: 'Kyle Nelson', avatar: 'data/graph/avatars/kyle-nelson-berkeley.png', html_url: 'https://github.com/kyle-nelson-berkeley', roster: 'Kyle Nelson' },
    ghosty: { login: 'ghosty', name: HOSTILE, avatar: 'https://avatars.githubusercontent.com/u/1?v=4', html_url: 'javascript:alert(1)', roster: null },
    renamed: { login: 'renamed', name: 'Old Name', avatar: null, html_url: 'https://github.com/renamed', roster: 'Someone Not On The Roster' },
  },
};

const ORG = {
  read_at: '2026-09-28',
  totals: { public_repos: 94, commits_365d: 79, authors_365d: 5, repos_touched_365d: 12, stars: 30, forks: 11, open_issues: 4, releases: 1 },
  weeks: weeks53(),
  most_active_repos: [{ name: 'fav_docs', commits: 28, language: 'Python' }, { name: 'docs', commits: 8, language: null }],
  recent_commits: [
    { repo: 'docs', sha: 'a6e80a4', date: '2026-09-17T10:00:00Z', msg: HOSTILE, author: 'ghosty' },
    { repo: 'fav_docs', sha: 'e736e06', date: '2026-09-16T10:00:00Z', msg: 'add cad files', author: 'NBauschmann' },
    { repo: 'docs', sha: 'b1c2d3e', date: '2026-09-15T10:00:00Z', msg: 'no author', author: null },
  ],
  releases: [{ repo: 'hippo_control', tag: 'v1.0.0', published_at: '2026-05-01T00:00:00Z', html_url: 'https://github.com/HippoCampusRobotics/hippo_control/releases/tag/v1.0.0' }],
};

const REPOS = {
  read_at: '2026-09-28',
  repos: {
    visual_localization: { name: 'visual_localization', description: 'camera + AprilTag localization', language: 'Python', stars: 0, forks: 0, open_issues: 0, pushed_at: '2026-05-13', archived: false, fork: false, private: false, html_url: 'https://github.com/HippoCampusRobotics/visual_localization' },
    apriltag_ros: { name: 'apriltag_ros', description: HOSTILE, language: null, stars: 2, forks: 1, open_issues: 3, pushed_at: '2024-01-08', archived: true, fork: true, private: false, html_url: 'https://github.com/HippoCampusRobotics/apriltag_ros' },
    dropped_from_project: { name: 'dropped_from_project', description: 'stale', language: 'C', stars: 0, forks: 0, open_issues: 0, pushed_at: '2020-01-01', archived: false, fork: false, private: false, html_url: 'https://github.com/HippoCampusRobotics/dropped_from_project' },
  },
};

const PAGE_AUTHORS = {
  read_at: '2026-09-28',
  pages: {
    'setup/getting-started/ros-installation': {
      original: {
        repo: 'HippoCampusRobotics/docs', path: 'contents/getting_started/ros_installation.rst',
        authors: [
          { login: 'lennartalff', name: 'Thies Lennart Alff', commits: 99, first: '2019-03-04' },
          { login: 'NBauschmann', name: 'Nathalie Bauschmann' },
          { login: null, name: HOSTILE },
        ],
        history_read: true, blob: null,
      },
      converted: { date: '2026-08-28', by: 'kyle-nelson-berkeley', tool: 'tools/rst_convert.py', commit: 'b40ade4' },
      edited_here: [{ pr: 1, by: 'kyle-nelson-berkeley', state: 'open' }],
    },
    'setup/removed/page': {
      original: { repo: 'HippoCampusRobotics/docs', path: 'x.rst', authors: [], history_read: false, blob: null },
      converted: null, edited_here: [],
    },
  },
};

// contributors.json (public per-project commit counts): M5's projects, M13's order
const CONTRIB = {
  projects: {
    'core-stack': { contributors: [{ login: 'NBauschmann', name: 'N', contributions: 30 }, { login: 'DanielDuecker', name: 'D', contributions: 3 }] },
    'docs-and-site': { contributors: [{ login: 'kyle-nelson-berkeley', name: 'K', contributions: 50 }, { login: 'NBauschmann', name: 'N', contributions: 2 }] },
    'gone-project': { contributors: [{ login: 'RHochdahl', name: 'R', contributions: 1 }] },
  },
};
// the merged project registry (HC.fetchProjects)
const PROJECTS = { projects: [
  { id: 'core-stack', name: 'Core stack', repos: [{ name: 'fav_docs', role: 'x' }, { name: 'hippo_control' }] },
  { id: 'docs-and-site', name: 'Docs and site', repos: [{ name: 'docs' }] },
] };
// wiki.json: the setup pages next to a repository
const WIKI = {
  nodes: [{ id: 'repo:docs', kind: 'repo', title: 'docs' }, { id: 'projects/docs-and-site', kind: 'project', title: 'Docs' }]
    .concat([1, 2, 3, 4, 5, 6].map((i) => ({ id: `setup/g/p${i}`, kind: 'setup', title: `Page ${i}`, route: `#/setup/g/p${i}` }))),
  edges: [{ s: 'projects/docs-and-site', t: 'repo:docs', type: 'member' }]
    .concat([1, 2, 3, 4, 5, 6].map((i) => ({ s: `setup/g/p${i}`, t: 'repo:docs', type: 'mentions' })))
    .concat([{ s: 'setup/g/p1', t: 'repo:docs', type: 'mentions' }]),
};

const ALL_FILES = {
  'data/graph/org-activity.json': ORG,
  'data/graph/github-repos.json': REPOS,
  'data/graph/page-authors.json': PAGE_AUTHORS,
  'data/graph/people-public.json': PEOPLE_PUBLIC,
  'data/people.json': PEOPLE,
  'data/graph/contributors.json': CONTRIB,
  'data/graph/wiki.json': WIKI,
};

function setup(files, win) {
  const doc = makeDoc();
  const f = fakeFetch(files || ALL_FILES);
  const lab = createLab({ doc, win: win || WIN, fetchJSON: f.fetchJSON,
    fetchProjects: () => Promise.resolve(JSON.parse(JSON.stringify(PROJECTS))) });
  return { doc, lab, calls: f.calls };
}

function assertNoHostileElement(doc) {
  assert.deepEqual(doc.htmlWrites.filter((h) => h !== ''), [], 'lab.js never writes markup');
  for (const el of doc.created) {
    for (const [k, v] of el.attrs) {
      assert.ok(!/^on/i.test(k), `no event-handler attribute (${k})`);
      assert.ok(!/^\s*javascript:/i.test(v), `no javascript: URL in ${k}`);
      assert.ok(!/avatars\.githubusercontent\.com/.test(v), 'never a live GitHub avatar');
    }
    if (el.localName === 'img') assert.notEqual(el.getAttribute('src'), 'x');
  }
}

const MEMBERS_ONLY = [/last active/i, /people committing this year/i, /\d+\s+commits?\s+by/i,
  /contributions/i, /2019/, /\b99\b/];

// ------------------------------------------------------------------ pure helpers
test('heatLevel maps a count to five levels against the max', () => {
  assert.equal(heatLevel(0, 8), 0);
  assert.equal(heatLevel(null, 8), 0);
  assert.equal(heatLevel(1, 8), 1);
  assert.equal(heatLevel(2, 8), 2);
  assert.equal(heatLevel(4, 8), 3);
  assert.equal(heatLevel(6, 8), 4);
  assert.equal(heatLevel(8, 8), 4);
  assert.equal(heatLevel(3, 0), 4, 'a max of zero never divides by zero');
});

test('weekLayout places 53 Monday-start weeks, skips future days, and labels months', () => {
  const lay = weekLayout(weeks53());
  assert.equal(lay.columns, 53);
  assert.equal(lay.max, 4);
  assert.equal(lay.cells.length, 53 * 7 - 2, 'null days are not drawn');
  const hot = lay.cells.find((c) => c.n === 4);
  assert.deepEqual([hot.col, hot.row, hot.level], [10, 2, 4]);
  assert.equal(lay.cells.find((c) => c.n === 1).level, 2, '1 of a max of 4 is the 25% step');
  assert.ok(lay.months.length >= 11 && lay.months.length <= 13);
  assert.equal(lay.months[0].label, 'Sep');
  lay.months.forEach((m, i) => { if (i) assert.ok(m.col - lay.months[i - 1].col >= 3); });
  assert.equal(weekLayout(null).cells.length, 0);
  assert.equal(weekLayout([{ week: 'nope', days: 'x' }, null]).cells.length, 0);
});

test('repoCardFacts lists public repository metadata only', () => {
  const facts = repoCardFacts(REPOS.repos.apriltag_ros);
  assert.deepEqual(facts.map((f) => f.key), ['language', 'stars', 'issues', 'pushed', 'fork', 'archived']);
  assert.equal(facts.find((f) => f.key === 'language').text, '—');
  assert.equal(facts.find((f) => f.key === 'stars').text, '★ 2');
  assert.equal(facts.find((f) => f.key === 'issues').text, '3 issues');
  assert.equal(facts.find((f) => f.key === 'pushed').text, 'pushed 2024-01-08');
  const plain = repoCardFacts(REPOS.repos.visual_localization);
  assert.equal(plain.find((f) => f.key === 'issues').text, '0 issues');
  assert.ok(!plain.some((f) => f.key === 'fork' || f.key === 'archived'));
  assert.deepEqual(repoCardFacts(null), []);
  assert.equal(repoCardFacts({ open_issues: 1 }).find((f) => f.key === 'issues').text, '1 issue');
});

test('avatarPath accepts only committed avatar paths; githubProfileUrl only github.com', () => {
  assert.equal(avatarPath('data/graph/avatars/NBauschmann.png'), 'data/graph/avatars/NBauschmann.png');
  assert.equal(avatarPath('data/graph/avatars/x-y.jpg'), 'data/graph/avatars/x-y.jpg');
  assert.equal(avatarPath('https://avatars.githubusercontent.com/u/1?v=4'), null);
  assert.equal(avatarPath('data/graph/avatars/../../secret.png'), null);
  assert.equal(avatarPath('data/graph/avatars/a.svg'), null);
  assert.equal(avatarPath(null), null);
  assert.equal(githubProfileUrl('https://github.com/NBauschmann', 'NBauschmann'), 'https://github.com/NBauschmann');
  assert.equal(githubProfileUrl('javascript:alert(1)', 'ghosty'), 'https://github.com/ghosty');
  assert.equal(githubProfileUrl('https://evil.example/x', 'a b'), null);
  assert.equal(readAtDay('2026-09-28'), '2026-09-28');
  assert.equal(readAtDay('2026-09-28T11:00:00Z'), '2026-09-28');
  assert.equal(readAtDay('yesterday'), '');
});

test('authorLine: names only, in order, no counts or dates; unlinked authors keep their git name', () => {
  const idx = buildPeopleIndex(PEOPLE_PUBLIC, PEOPLE);
  const text = authorLine(PAGE_AUTHORS.pages['setup/getting-started/ros-installation'], idx);
  assert.equal(text,
    'Written by Thies Lennart Alff, Nathalie Bauschmann and ' + HOSTILE + ' in HippoCampusRobotics/docs. '
    + 'Converted to this site on 2026-08-28 by Kyle Nelson (tools/rst_convert.py). '
    + 'PR #1 by Kyle Nelson: open proposal.');
  assert.equal(authorLine(PAGE_AUTHORS.pages['setup/removed/page'], idx),
    'Original authors: history not read yet.');
  assert.equal(authorLine(null, idx), '');
  assert.equal(authorLine({ original: { repo: 'r', authors: [{ login: 'NBauschmann', name: 'N' }], history_read: true } }, idx),
    'Written by Nathalie Bauschmann in r.');
});

test('personModel: roster card fields win; a map-linked login shows the roster card and its link', () => {
  const idx = buildPeopleIndex(PEOPLE_PUBLIC, PEOPLE);
  const rene = personModel(idx, { login: 'RHochdahl' });
  assert.equal(rene.name, 'René Hochdahl');
  assert.equal(rene.title, 'Master Student');
  assert.equal(rene.link, 'https://example.org/rene');
  assert.deepEqual(rene.github, { login: 'RHochdahl', avatar: null, url: 'https://github.com/RHochdahl' });
  const byRoster = personModel(idx, { roster: 'Daniel-André Dücker' });
  assert.equal(byRoster.github.login, 'DanielDuecker');
  assert.equal(byRoster.photo, 'https://res.cloudinary.com/x/image/upload/v1/people/dd.jpg');
  const noMatch = personModel(idx, { roster: 'Ada Nomatch' });
  assert.equal(noMatch.github, null, 'roster people without a match get no GitHub line');
  assert.equal(noMatch.link, null);
  const stranger = personModel(idx, { login: 'ghosty' });
  assert.equal(stranger.title, 'GitHub contributor');
  assert.equal(stranger.link, null);
  assert.equal(stranger.github.avatar, null, 'a remote avatar is never used');
  const stale = personModel(idx, { login: 'renamed' });
  assert.equal(stale.title, 'GitHub contributor', 'a roster name not in people.json is ignored');
  assert.equal(stale.name, 'Old Name');
  const gitOnly = personModel(idx, { login: null, name: 'Plain Git Name' });
  assert.equal(gitOnly.name, 'Plain Git Name');
  assert.equal(gitOnly.github, null);
  assert.equal(personModel(buildPeopleIndex(null, null), { login: 'x' }).name, 'x');
});

test('buildPeopleIndex accepts people as an object keyed by login or as a list', () => {
  const list = { people: Object.values(PEOPLE_PUBLIC.people) };
  const a = personModel(buildPeopleIndex(list, PEOPLE), { login: 'DanielDuecker' });
  const b = personModel(buildPeopleIndex(PEOPLE_PUBLIC, PEOPLE), { login: 'DanielDuecker' });
  assert.deepEqual(a, b);
});

test('Primary contributors and the popover show the same card link (DanielDuecker, map-linked RHochdahl)', () => {
  const idx = buildPeopleIndex(PEOPLE_PUBLIC, PEOPLE);
  const entry = { contributors: [
    { login: 'DanielDuecker', name: 'Daniel Duecker', contributions: 1 },
    { login: 'RHochdahl', name: 'RHochdahl', contributions: 3 },
  ] };
  const rows = GRAPH.contributorRows(entry, PEOPLE, PEOPLE_PUBLIC);
  assert.equal(rows[0].linkUrl, 'https://www.tuhh.de/mum/team/wimi/daniel-duecker');
  assert.equal(rows[0].linkUrl, personModel(idx, { login: 'DanielDuecker' }).link);
  assert.equal(rows[1].linkUrl, 'https://example.org/rene');
  assert.equal(rows[1].linkUrl, personModel(idx, { login: 'RHochdahl' }).link);
});

// ------------------------------------------------------------------ renderers (fake DOM)
test('the Lab page fetches only data/graph/* and data/people.json, and prints "GitHub data as of"', async () => {
  const { doc, lab, calls } = setup();
  const root = doc.createElement('main');
  doc.body.appendChild(root);
  await lab.renderLab(root, () => true);
  assert.ok(calls.length > 0);
  calls.forEach((p) => assert.match(p, /^data\/graph\/[a-z-]+\.json$|^data\/people\.json$/));
  assert.deepEqual(SOURCES.slice().sort(), Object.keys(ALL_FILES).sort());
  const text = root.textContent;
  assert.match(text, /GitHub data as of 2026-09-28/);
  assert.match(text, /Lab activity/);
  assert.match(text, /79/);
  assert.ok(root.querySelector('svg'), 'the heatmap is drawn');
  // (M10: plus the one keyboard focus ring)
  assert.equal(root.querySelectorAll('rect').filter((r) => !r.classList.contains('hc-focus')).length, 53 * 7 - 2);
  assert.ok(!/Source: public GitHub|What the lab/.test(text), 'M7/M14: no lead, no provenance');
  assert.ok(text.includes(HOSTILE), 'a hostile commit message is shown as text');
  assertNoHostileElement(doc);
});

test('a guest render contains no members-only strings', async () => {
  const { doc, lab } = setup();
  const root = doc.createElement('main');
  doc.body.appendChild(root);
  await lab.renderLab(root, () => true);
  const page = doc.createElement('div');
  doc.body.appendChild(page);
  await lab.renderAuthors(page, 'setup/getting-started/ros-installation');
  const aside = asideWithRows(doc, [['visual_localization', 'camera'], ['apriltag_ros', 'fork']]);
  await lab.renderRepoCards(aside, {});
  const text = root.textContent + ' ' + page.textContent + ' ' + aside.textContent;
  MEMBERS_ONLY.forEach((re) => assert.ok(!re.test(text), `guest text must not match ${re}`));
  root.querySelectorAll('.hc-person-row').forEach((row) => {
    assert.ok(!/\d/.test(row.textContent.split(HOSTILE).join('').replace(/@\S+/, '')), 'people rows carry no numbers');
  });
  assertNoHostileElement(doc);
});

function asideWithRows(doc, rows) {
  const aside = doc.createElement('div');
  aside.className = 'aside-box';
  const ul = doc.createElement('ul');
  rows.forEach(([name, role]) => {
    const li = doc.createElement('li');
    li.className = 'repo-row';
    const a = doc.createElement('a');
    a.className = 'chip';
    a.setAttribute('href', 'https://github.com/HippoCampusRobotics/' + name);
    a.textContent = name;
    const r = doc.createElement('span');
    r.className = 'role';
    r.textContent = role;
    li.append(a, r);
    ul.appendChild(li);
  });
  aside.appendChild(ul);
  doc.body.appendChild(aside);
  return aside;
}

test('J5: repo cards are quiet: name and one-line purpose; the facts only in the title; hostile text stays text', async () => {
  const { doc, lab } = setup();
  const aside = asideWithRows(doc, [['visual_localization', 'camera + AprilTag'], ['apriltag_ros', 'upstream fork'], ['not_in_snapshot', 'external']]);
  await lab.renderRepoCards(aside, {});
  assert.equal(aside.querySelectorAll('.repo-row').length, 0);
  const cards = aside.querySelectorAll('.hc-repo');
  assert.equal(cards.length, 3);
  assert.equal(cards[0].getAttribute('href'), 'https://github.com/HippoCampusRobotics/visual_localization');
  assert.equal(cards[0].getAttribute('rel'), 'noopener');
  assert.equal(cards[0].querySelector('.hc-repo-purpose').textContent, 'camera + AprilTag', 'the role is the purpose');
  assert.equal(cards[0].querySelector('.hc-lang').getAttribute('data-lang'), 'Python');
  cards.forEach((c) => assert.equal(c.querySelector('.facts'), null, 'no facts line'));
  assert.equal(cards[0].getAttribute('title'), 'Python · ★ 0 · 0 issues · pushed 2026-05-13');
  assert.match(cards[1].getAttribute('title'), /fork · archived$/);
  assert.ok(!/★|issues|pushed/.test(aside.textContent), 'the facts are not drawn');
  assert.equal(cards[2].querySelector('.ext'), null);
  assert.ok(!aside.textContent.includes('not in the org snapshot'), 'an external repository is simply linked');
  assert.equal(cards[2].hasAttribute('title'), false);
  assert.ok(!aside.textContent.includes('dropped_from_project'), 'a snapshot repo outside the project is ignored');
  // no role: the description is the purpose, as text
  const bare = asideWithRows(doc, [['apriltag_ros', '']]);
  await lab.renderRepoCards(bare, {});
  assert.equal(bare.querySelector('.hc-repo-purpose').textContent, HOSTILE);
  assertNoHostileElement(doc);
});

test('J9/P10: who wrote this is one quiet line: original authors and merged PR authors, no PR lines, no note', async () => {
  const { doc, lab } = setup();
  const body = doc.createElement('div');
  doc.body.appendChild(body);
  await lab.renderAuthors(body, 'setup/getting-started/ros-installation');
  const box = body.querySelector('.hc-authors');
  assert.ok(box);
  assert.equal(box.querySelectorAll('.hc-authors-line').length, 1);
  assert.equal(box.querySelector('.hc-authors-note'), null);
  assert.equal(box.querySelector('h4'), null);
  assert.equal(box.textContent, 'Written by Thies Lennart Alff, Nathalie Bauschmann and ' + HOSTILE + '.');
  assert.ok(!/PR #|open proposal|Converted|From git history/.test(box.textContent));
  const imgs = box.querySelectorAll('img');
  assert.ok(imgs.length >= 1);
  imgs.forEach((img) => assert.match(img.getAttribute('src'), /^data\/graph\/avatars\//));
  assert.ok(box.querySelectorAll('[data-hc-login]').length >= 2, 'names open the person dialog');
  assert.equal(box.getAttribute('aria-label'), 'Who wrote this');
  // a page with no entry renders nothing; an entry with no author read renders nothing
  const other = doc.createElement('div');
  doc.body.appendChild(other);
  await lab.renderAuthors(other, 'setup/not/in/page-authors');
  await lab.renderAuthors(other, 'setup/removed/page');
  assert.equal(other.children.length, 0);
  assertNoHostileElement(doc);
});

test('J9: authorPeople keeps merged PR authors once and drops open/closed proposals and the conversion', () => {
  const idx = buildPeopleIndex(PEOPLE_PUBLIC, PEOPLE);
  const entry = { original: { history_read: true, authors: [{ login: 'NBauschmann', name: 'x' }, { login: null, name: 'git name' }] },
    converted: { by: 'kyle-nelson-berkeley' },
    edited_here: [{ pr: 1, by: 'RHochdahl', state: 'merged' }, { pr: 2, by: 'DanielDuecker', state: 'open' },
      { pr: 3, by: 'NBauschmann', state: 'merged' }, { pr: 4, by: 'ghosty', state: 'closed' }] };
  assert.deepEqual(authorPeople(entry, idx).map((t) => t.person.name), ['Nathalie Bauschmann', 'git name', 'René Hochdahl']);
  assert.deepEqual(authorPeople({ original: { history_read: false, authors: [{ login: 'NBauschmann' }] } }, idx), []);
  assert.deepEqual(authorPeople(null, idx), []);
});

test('M5/M17: the person dialog: photo, name, title, Projects, GitHub, Personal page; one at a time; Esc closes', async () => {
  const { doc, lab } = setup();
  const card = doc.createElement('a');
  card.className = 'person-card';
  card.setAttribute('href', 'https://www.tuhh.de/mum/team/wimi/daniel-duecker');
  card.setAttribute('data-hc-person', 'Daniel-André Dücker');
  const media = doc.createElement('img');
  media.className = 'person-photo';
  card.appendChild(media);
  const grid = doc.createElement('div');
  grid.appendChild(card);
  doc.body.appendChild(grid);
  await lab.wirePeople(grid);
  const ev = doc.dispatch(media, 'click', { button: 0 });
  assert.equal(ev.defaultPrevented, true, 'a plain click opens the profile and does not navigate');
  await lab.whenReady();
  let pops = doc.body.querySelectorAll('.hc-person-pop');
  assert.equal(pops.length, 1);
  const pop = pops[0];
  assert.equal(pop.parentNode, doc.body, 'on document.body (ground rule 10)');
  assert.equal(pop.getAttribute('role'), 'dialog');
  assert.equal(pop.getAttribute('aria-modal'), 'true');
  assert.equal(pop.getAttribute('aria-label'), 'Daniel-André Dücker');
  assert.equal(pop.getAttribute('data-hc-surface'), 'popover');
  assert.equal(pop.getAttribute('data-hc-login'), 'DanielDuecker');
  assert.match(pop.textContent, /Senior Scientist \(TUM\)/);
  assert.match(pop.textContent, /Personal page/);
  assert.match(pop.textContent, /@DanielDuecker on GitHub/);
  const projects = pop.querySelector('.hc-pp-projects');
  assert.ok(projects, 'the projects the login has commits in');
  assert.deepEqual(projects.querySelectorAll('a').map((a) => [a.getAttribute('href'), a.textContent]), [['#/projects/core-stack', 'Core stack']]);
  const links = pop.querySelectorAll('a').map((a) => a.getAttribute('href'));
  assert.ok(links.includes('https://www.tuhh.de/mum/team/wimi/daniel-duecker'));
  assert.ok(links.includes('https://github.com/DanielDuecker'));
  const big = pop.querySelector('.hc-pp-media');
  assert.equal(big.getAttribute('src'), 'https://res.cloudinary.com/x/image/upload/v1/people/dd.jpg', 'the big image is the roster photo');
  assert.equal(pop.querySelector('.hc-pp-gh img').getAttribute('src'), 'data/graph/avatars/DanielDuecker.jpg');
  assert.equal(pop.children[0].getAttribute('aria-label'), 'Close', 'the close button is first in the tab order');
  assert.equal(doc.body.querySelectorAll('.hc-dialog-backdrop').length, 1);
  // a second trigger replaces the first dialog
  await lab.openPerson(media, { login: 'RHochdahl' });
  pops = doc.body.querySelectorAll('.hc-person-pop');
  assert.equal(pops.length, 1);
  assert.equal(doc.body.querySelectorAll('.hc-dialog-backdrop').length, 1);
  assert.match(pops[0].textContent, /René Hochdahl/);
  assert.equal(pops[0].querySelector('.hc-pp-media').localName, 'div', 'no photo: initials');
  assert.equal(pops[0].querySelector('.hc-pp-projects'), null, 'no project in the registry: no Projects line');
  doc.dispatch(doc.body, 'keydown', { key: 'Escape' });
  assert.equal(doc.body.querySelectorAll('.hc-person-pop').length, 0);
  assert.equal(doc.body.querySelectorAll('.hc-dialog-backdrop').length, 0);
  assert.equal(doc.activeElement, media, 'focus goes back to the trigger');
  // roster person without a match: the card's link, no GitHub line
  await lab.openPerson(media, { roster: 'Lina Linked' });
  const lone = doc.body.querySelector('.hc-person-pop');
  assert.match(lone.textContent, /Personal page/);
  assert.equal(lone.querySelector('.hc-pp-gh'), null);
  assert.ok(!/on GitHub/.test(lone.textContent));
  lab.closePerson();
  // M5: a roster person with neither a link nor a match still gets a profile (name and title)
  await lab.openPerson(media, { roster: 'Ada Nomatch' });
  const ada = doc.body.querySelector('.hc-person-pop');
  assert.ok(ada);
  assert.match(ada.textContent, /Ada Nomatch/);
  assert.match(ada.textContent, /Student/);
  // a hostile display name stays text
  await lab.openPerson(media, { login: 'ghosty' });
  assert.ok(doc.body.querySelector('.hc-person-pop').textContent.includes(HOSTILE));
  assert.ok(doc.body.querySelector('.hc-person-pop').textContent.includes('GitHub contributor'));
  assertNoHostileElement(doc);
});

test('M17: the dialog traps Tab and Shift-Tab, a backdrop click closes it, focus returns to the trigger', async () => {
  const { doc, lab } = setup();
  const trigger = doc.createElement('button');
  doc.body.appendChild(trigger);
  await lab.openPerson(trigger, { login: 'DanielDuecker' });
  const box = doc.body.querySelector('[role="dialog"]');
  assert.equal(doc.activeElement, box, 'the dialog takes focus');
  const stops = box.querySelectorAll('a, button');
  assert.ok(stops.length >= 3);
  const tab = (shiftKey) => doc.dispatch(doc.activeElement, 'keydown', { key: 'Tab', shiftKey });
  const ev = tab(false);
  assert.equal(ev.defaultPrevented, true);
  assert.equal(doc.activeElement, stops[0], 'Tab from the dialog: the close button');
  for (let i = 1; i < stops.length; i += 1) tab(false);
  assert.equal(doc.activeElement, stops[stops.length - 1]);
  tab(false);
  assert.equal(doc.activeElement, stops[0], 'Tab wraps to the first');
  tab(true);
  assert.equal(doc.activeElement, stops[stops.length - 1], 'Shift-Tab wraps to the last');
  doc.dispatch(doc.body.querySelector('.hc-dialog-backdrop'), 'click');
  assert.equal(doc.body.querySelector('[role="dialog"]'), null);
  assert.equal(doc.activeElement, trigger);
  // the close button closes too
  await lab.openPerson(trigger, { login: 'DanielDuecker' });
  doc.dispatch(doc.body.querySelector('.hc-dialog-close'), 'click');
  assert.equal(doc.body.querySelector('[role="dialog"]'), null);
});

test('M17: dialogMode is a popover from 768 px and a bottom sheet below; a phone gets is-sheet', async () => {
  assert.equal(dialogMode(1280), 'pop');
  assert.equal(dialogMode(768), 'pop');
  assert.equal(dialogMode(767), 'sheet');
  assert.equal(dialogMode(375), 'sheet');
  assert.equal(dialogMode(undefined), 'pop');
  const { doc, lab } = setup(null, Object.assign({}, WIN, { innerWidth: 375, innerHeight: 812 }));
  await lab.openPerson(null, { login: 'NBauschmann' });
  const box = doc.body.querySelector('.hc-dialog');
  assert.ok(box.classList.contains('is-sheet'));
  assert.ok(doc.body.querySelector('.hc-dialog-backdrop').classList.contains('is-sheet'));
  assert.equal(box.style.left, undefined, 'a sheet is placed by its CSS');
});

test('M5: cardClickOpensDialog: a plain primary click or Enter/Space; never a modifier, a handled event or Editor mode', () => {
  const body = (...c) => ({ contains: (x) => c.includes(x) });
  const click = (extra) => Object.assign({ type: 'click', button: 0, defaultPrevented: false }, extra);
  assert.equal(cardClickOpensDialog(click(), body()), true);
  assert.equal(cardClickOpensDialog(click({ ctrlKey: true }), body()), false);
  assert.equal(cardClickOpensDialog(click({ metaKey: true }), body()), false);
  assert.equal(cardClickOpensDialog(click({ shiftKey: true }), body()), false);
  assert.equal(cardClickOpensDialog(click({ altKey: true }), body()), false);
  assert.equal(cardClickOpensDialog(click({ button: 1 }), body()), false, 'a middle click');
  assert.equal(cardClickOpensDialog(click({ defaultPrevented: true }), body()), false);
  assert.equal(cardClickOpensDialog(click(), body('hc-editor-on')), false);
  assert.equal(cardClickOpensDialog(click(), body('hc-people-edit')), false);
  // R2-5: the keyboard path of a link-less card (role="button")
  assert.equal(cardClickOpensDialog({ type: 'keydown', key: 'Enter' }, body()), true);
  assert.equal(cardClickOpensDialog({ type: 'keydown', key: ' ' }, body()), true);
  assert.equal(cardClickOpensDialog({ type: 'keydown', key: 'a' }, body()), false);
  assert.equal(cardClickOpensDialog({ type: 'keydown', key: 'Tab' }, body()), false);
  assert.equal(cardClickOpensDialog({ type: 'keydown', key: 'Enter' }, body('hc-editor-on')), false);
  assert.equal(cardClickOpensDialog(null, body()), false);
});

test('M5: a person card: plain click opens; a modifier click navigates; Editor mode untouched; Enter on a link-less card opens', async () => {
  const { doc, lab } = setup();
  const grid = doc.createElement('div');
  const mk = (name, linked) => {
    const card = doc.createElement(linked ? 'a' : 'div');
    card.className = linked ? 'person-card' : 'person-card is-static';
    if (linked) card.setAttribute('href', 'https://example.org/' + encodeURIComponent(name));
    else { card.setAttribute('role', 'button'); card.setAttribute('tabindex', '0'); }
    card.setAttribute('data-hc-person', name);
    const nm = doc.createElement('span');
    nm.className = 'person-name';
    nm.textContent = name;
    card.appendChild(nm);
    grid.appendChild(card);
    return card;
  };
  const lina = mk('Lina Linked', true);
  const ada = mk('Ada Nomatch', false);
  doc.body.appendChild(grid);
  await lab.wirePeople(grid);
  assert.equal(ada.getAttribute('data-hc-person'), 'Ada Nomatch', 'wirePeople strips no trigger any more');
  let ev = doc.dispatch(lina.children[0], 'click', { button: 0, metaKey: true });
  assert.equal(ev.defaultPrevented, false, 'cmd-click: the browser opens the personal page in a new tab');
  await lab.whenReady();
  assert.equal(doc.body.querySelector('[role="dialog"]'), null);
  ev = doc.dispatch(lina, 'keydown', { key: 'Enter' });
  assert.equal(ev.defaultPrevented, false, 'Enter on a link card is left to the browser, whose click follows');
  doc.body.className = 'hc-editor-on';
  ev = doc.dispatch(lina, 'click', { button: 0 });
  assert.equal(ev.defaultPrevented, false, 'Editor mode: the card is the Editor\'s');
  doc.body.className = '';
  ev = doc.dispatch(ada, 'keydown', { key: 'Enter' });
  assert.equal(ev.defaultPrevented, true);
  await lab.whenReady();
  assert.match(doc.body.querySelector('[role="dialog"]').textContent, /Ada Nomatch/);
  doc.dispatch(doc.body, 'keydown', { key: 'Escape' });
  assert.equal(doc.activeElement, ada, 'focus returns to the card');
  ev = doc.dispatch(ada, 'keydown', { key: 'x' });
  assert.equal(ev.defaultPrevented, false);
  // something else handled the click first (js/editor-frame.js wireCard): nothing here
  ev = doc.dispatch(lina, 'click', { button: 0, defaultPrevented: true });
  await lab.whenReady();
  assert.equal(doc.body.querySelector('[role="dialog"]'), null);
});

// ---- unit M: the Lab activity section (M2, M4, M8–M13) and the pure helpers ----
test('M4/M8/M9: exactly three tiles; open issues link to GitHub\'s issue search; no lead, no provenance (M7/M14)', async () => {
  const { doc, lab } = setup();
  const root = doc.createElement('main');
  doc.body.appendChild(root);
  await lab.renderLab(root, () => true, { embedded: true });
  const tiles = root.querySelector('.hc-tiles').children;
  assert.equal(tiles.length, 3);
  assert.deepEqual(tiles.map((t) => t.querySelector('.n').textContent), ['79', '94', '4']);
  assert.equal(tiles[2].localName, 'a');
  assert.equal(tiles[2].getAttribute('href'), 'https://github.com/search?q=org%3AHippoCampusRobotics+is%3Aissue+is%3Aopen&type=issues');
  assert.equal(tiles[2].getAttribute('target'), '_blank');
  assert.equal(tiles[2].getAttribute('rel'), 'noopener');
  const text = root.textContent;
  assert.ok(!/Source: public GitHub|What the lab|authors, last 365|repositories touched|stars|releases,/.test(text));
  assert.equal(root.querySelector('h1'), null, 'embedded: the Team page draws the heading (M6)');
  assert.equal(root.querySelector('h2'), null);
  assert.ok(!/GitHub data as of/.test(text), 'embedded: the as-of line sits by the Team page\'s heading (M7)');
  assert.ok(!/Everyone who has committed/.test(text), 'M13: the sentence is gone');
});

test('M10: the heatmap SVG is the one tab stop; no <title>; Arrow keys show a site tooltip on document.body; Esc hides it', async () => {
  const { doc, lab } = setup();
  const root = doc.createElement('main');
  doc.body.appendChild(root);
  await lab.renderLab(root, () => true, { embedded: true });
  const heat = root.querySelector('.hc-heat');
  const focusable = heat.querySelectorAll('a, button, [tabindex]');
  assert.equal(focusable.length, 1);
  assert.equal(focusable[0].localName, 'svg');
  assert.equal(focusable[0].getAttribute('tabindex'), '0');
  assert.equal(focusable[0].getAttribute('role'), 'img');
  assert.equal(focusable[0].getAttribute('aria-label'), 'Commits per day, last 53 weeks: 5 commits, busiest day 2025-12-10 with 4');
  assert.equal(heat.querySelectorAll('title').length, 0);
  assert.match(heat.querySelector('.hc-sr-only').textContent, /^Commits per day, last 53 weeks: 5 commits/);
  const svgEl = focusable[0];
  svgEl.focus();
  doc.dispatch(svgEl, 'keydown', { key: 'ArrowLeft' });
  let tip = doc.body.querySelector('.hc-tip');
  assert.ok(tip && tip.parentNode === doc.body, 'the tooltip lives on document.body');
  assert.equal(tip.getAttribute('role'), 'tooltip');
  assert.ok(tip.classList.contains('is-on'));
  assert.match(tip.textContent, /^\d{4}-\d{2}-\d{2} · \d+ commits?$/);
  const ring = svgEl.querySelector('.hc-focus');
  assert.ok(ring.classList.contains('is-on'));
  const ev = doc.dispatch(svgEl, 'keydown', { key: 'Escape' });
  assert.equal(tip.classList.contains('is-on'), false);
  assert.equal(ev._stop, true, 'Esc on the heatmap only hides the tooltip');
  // hover: pointerover a cell shows the same tooltip
  const rect = svgEl.querySelectorAll('rect').find((r) => r.getAttribute('class') === 'hc-l4');
  doc.dispatch(rect, 'pointerover');
  tip = doc.body.querySelector('.hc-tip');
  assert.ok(tip.classList.contains('is-on'));
  assert.match(tip.textContent, / · 4 commits$/);
  doc.dispatch(rect, 'pointerout');
  assert.equal(tip.classList.contains('is-on'), false);
});

test('WCAG-5 heatmap focus: focus with no cursor puts it on the newest day with its tooltip; ArrowLeft moves it and scrolls it into view', async () => {
  const { doc, lab } = setup();
  const root = doc.createElement('main');
  doc.body.appendChild(root);
  await lab.renderLab(root, () => true, { embedded: true });
  const svgEl = root.querySelector('.hc-heat svg');
  const ring = svgEl.querySelector('.hc-focus');
  const cells = svgEl.querySelectorAll('rect').filter((r) => !r.classList.contains('hc-focus'));
  const newest = cells[cells.length - 1];
  svgEl.focus();
  doc.dispatch(svgEl, 'focus');
  assert.ok(ring.classList.contains('is-on'), 'the cursor shows on focus');
  assert.equal(Number(ring.getAttribute('x')), Number(newest.getAttribute('x')) - 1, 'on the newest cell');
  assert.equal(Number(ring.getAttribute('y')), Number(newest.getAttribute('y')) - 1);
  const tip = doc.body.querySelector('.hc-tip');
  assert.ok(tip && tip.classList.contains('is-on'), 'its tooltip shows');
  const x0 = ring.getAttribute('x');
  doc.scrolls.length = 0;
  doc.dispatch(svgEl, 'keydown', { key: 'ArrowLeft' });
  assert.notEqual(ring.getAttribute('x'), x0, 'ArrowLeft moves the cursor a week back');
  const last = doc.scrolls[doc.scrolls.length - 1];
  assert.ok(last, 'scrollIntoView was called after the move');
  assert.equal(last.el.localName, 'rect');
  assert.equal(Number(last.el.getAttribute('x')), Number(ring.getAttribute('x')) + 1, 'on the cursor cell');
  assert.deepEqual({ ...last.opts }, { block: 'nearest', inline: 'nearest' });
  // a second focus keeps the cursor where it is
  doc.dispatch(svgEl, 'blur');
  doc.dispatch(svgEl, 'focus');
  assert.equal(Number(ring.getAttribute('x')), Number(last.el.getAttribute('x')) - 1);
});

test('review S-3: a focus that follows a pointerdown does not move the cursor or scroll; a plain (keyboard) focus does', async () => {
  const { doc, lab } = setup();
  const root = doc.createElement('main');
  doc.body.appendChild(root);
  await lab.renderLab(root, () => true, { embedded: true });
  const svgEl = root.querySelector('.hc-heat svg');
  const ring = svgEl.querySelector('.hc-focus');
  const cells = svgEl.querySelectorAll('rect').filter((r) => !r.classList.contains('hc-focus'));
  doc.scrolls.length = 0;
  doc.dispatch(cells[3], 'pointerdown');
  svgEl.focus();
  doc.dispatch(svgEl, 'focus');
  assert.equal(doc.scrolls.length, 0, 'a tap or click never yanks the scroller');
  assert.equal(ring.classList.contains('is-on'), false, 'no automatic cursor for a pointer focus');
  doc.dispatch(svgEl, 'blur');
  doc.dispatch(svgEl, 'focus');                      // the next focus, from the keyboard
  assert.equal(doc.scrolls.length, 1, 'a keyboard focus scrolls the cursor cell into view');
  assert.ok(ring.classList.contains('is-on'));
});

test('M11: recent commits: ten rows at most, each a button naming its author, opening a commit dialog with the project', async () => {
  const many = Object.assign({}, ORG, { recent_commits: Array.from({ length: 12 }, (_, i) => ({ repo: 'docs', sha: 'abcdef' + (i % 10), date: '2026-09-01', msg: 'm' + i, author: 'NBauschmann' })) });
  const big = setup(Object.assign({}, ALL_FILES, { 'data/graph/org-activity.json': many }));
  const r0 = big.doc.createElement('main');
  big.doc.body.appendChild(r0);
  await big.lab.renderLab(r0, () => true, { embedded: true });
  assert.equal(r0.querySelectorAll('.hc-commit').length, 10);

  const { doc, lab } = setup();
  const root = doc.createElement('main');
  doc.body.appendChild(root);
  await lab.renderLab(root, () => true, { embedded: true });
  const rows = root.querySelectorAll('.hc-commit');
  assert.equal(rows.length, 3);
  rows.forEach((r) => assert.equal(r.localName, 'button'));
  assert.equal(rows[1].querySelector('.hc-commit-who .nm').textContent, 'Nathalie Bauschmann');
  assert.equal(rows[1].querySelector('.hc-commit-who img').getAttribute('src'), 'data/graph/avatars/NBauschmann.png');
  assert.ok(rows[0].querySelector('.hc-commit-who').textContent.includes(HOSTILE), 'a hostile author name stays text');
  assert.equal(rows[2].querySelector('.hc-commit-who'), null, 'no login: no author');
  assert.equal(rows[1].getAttribute('data-hc-repo'), 'fav_docs');
  assert.equal(rows[1].getAttribute('data-hc-sha'), 'e736e06');
  assert.ok(rows[1].querySelector('.s'), 'the members-only author slot (.s) stays');
  doc.dispatch(rows[1].querySelector('.m'), 'click', { button: 0 });
  await lab.whenReady();
  const box = doc.body.querySelector('.hc-commit-pop');
  assert.equal(box.getAttribute('role'), 'dialog');
  assert.equal(box.getAttribute('aria-label'), 'Commit e736e06');
  assert.match(box.textContent, /add cad files/);
  assert.match(box.textContent, /Nathalie Bauschmann/);
  assert.match(box.textContent, /Core stack/, 'the project of fav_docs');
  const hrefs = box.querySelectorAll('a').map((a) => a.getAttribute('href'));
  assert.ok(hrefs.includes('https://github.com/HippoCampusRobotics/fav_docs'));
  assert.ok(hrefs.includes('#/projects/core-stack'));
  assert.ok(hrefs.includes('https://github.com/NBauschmann'));
  doc.dispatch(doc.body, 'keydown', { key: 'Escape' });
  assert.equal(doc.activeElement, rows[1]);
  // the hostile message opens as text; a repository in no project says so
  doc.dispatch(rows[0], 'click', { button: 0 });
  await lab.whenReady();
  const hostile = doc.body.querySelector('.hc-commit-pop');
  assert.ok(hostile.textContent.includes(HOSTILE));
  assert.match(hostile.textContent, /Docs and site/);
  assertNoHostileElement(doc);
});

test('M2/M12: repository bars are buttons with no language label; one opens a dialog with its project and setup pages', async () => {
  const { doc, lab } = setup();
  const root = doc.createElement('main');
  doc.body.appendChild(root);
  await lab.renderLab(root, () => true, { embedded: true });
  const bars = root.querySelectorAll('.hc-bar');
  assert.equal(bars.length, 2);
  assert.equal(bars[0].localName, 'button');
  assert.equal(bars[0].querySelector('.n').textContent, '28 commits');
  assert.equal(bars[1].querySelector('.n').textContent, '8 commits');
  assert.ok(!/Python|—/.test(bars.map((b) => b.textContent).join(' ')), 'no language label');
  assert.equal(bars[0].querySelector('.name').getAttribute('title'), 'fav_docs');
  doc.dispatch(bars[1], 'click', { button: 0 });
  await lab.whenReady();
  const box = doc.body.querySelector('.hc-repo-pop');
  assert.equal(box.getAttribute('role'), 'dialog');
  assert.match(box.textContent, /Docs and site/);
  const pages = box.querySelectorAll('.hc-rd-pages a');
  assert.equal(pages.length, 5, 'at most five setup pages');
  assert.deepEqual(pages.map((a) => a.getAttribute('href')), ['#/setup/g/p1', '#/setup/g/p2', '#/setup/g/p3', '#/setup/g/p4', '#/setup/g/p5']);
  assertNoHostileElement(doc);
});

test('M13: People on GitHub: ranked by public commits, ten shown, the rest in a "Show all" details', async () => {
  const people = { people: Object.assign({}, PEOPLE_PUBLIC.people) };
  for (let i = 0; i < 9; i += 1) {
    people.people['user' + i] = { login: 'user' + i, name: 'User ' + i, avatar: null, html_url: 'https://github.com/user' + i, roster: null };
  }
  const { doc, lab } = setup(Object.assign({}, ALL_FILES, { 'data/graph/people-public.json': people }));
  const root = doc.createElement('main');
  doc.body.appendChild(root);
  await lab.renderLab(root, () => true, { embedded: true });
  const col = root.querySelector('[data-hc-slot="lab-people"]');
  const shown = col.children.filter((c) => c.localName === 'button');
  assert.equal(shown.length, 10);
  assert.deepEqual(shown.slice(0, 4).map((b) => b.getAttribute('data-hc-login')),
    ['kyle-nelson-berkeley', 'NBauschmann', 'DanielDuecker', 'RHochdahl']);
  const more = col.querySelector('details');
  assert.ok(more);
  assert.equal(more.querySelector('summary').textContent, 'Show all 15');
  assert.equal(more.querySelectorAll('.hc-person-row').length, 5);
  assert.ok(!/\d+ commits?/.test(col.textContent), 'the counts order the list; they are never drawn');
  assertNoHostileElement(doc);
});

test('M13/M11/M12/P10: rankPeople, loginProjects, repoProjectMap, repoPages, lastCommitDay, heatSummary', () => {
  const m = (login, name) => ({ name, github: { login } });
  const ranked = rankPeople([m('zed', 'Zed'), m('NBauschmann', 'Nathalie'), m('anon', 'Anna'), m('kyle-nelson-berkeley', 'Kyle'), m('RHochdahl', 'René')], CONTRIB);
  assert.deepEqual(ranked.map((x) => x.name), ['Kyle', 'Nathalie', 'René', 'Anna', 'Zed']);
  assert.deepEqual(rankPeople(null, CONTRIB), []);
  assert.deepEqual(rankPeople([m('b', 'B'), m('a', 'A')], null).map((x) => x.name), ['A', 'B']);
  assert.deepEqual(loginProjects(CONTRIB, 'NBauschmann'), ['core-stack', 'docs-and-site']);
  assert.deepEqual(loginProjects(CONTRIB, 'nobody'), []);
  assert.deepEqual(loginProjects(null, 'NBauschmann'), []);
  const map = repoProjectMap(PROJECTS);
  assert.deepEqual(map.get('fav_docs'), { id: 'core-stack', name: 'Core stack' });
  assert.deepEqual(map.get('docs'), { id: 'docs-and-site', name: 'Docs and site' });
  assert.equal(map.get('nope'), undefined);
  assert.equal(repoProjectMap(PROJECTS.projects).get('hippo_control').name, 'Core stack', 'a list works too');
  assert.equal(repoProjectMap(null).size, 0);
  assert.deepEqual(repoPages(WIKI, 'docs').map((p) => p.title), ['Page 1', 'Page 2', 'Page 3', 'Page 4', 'Page 5']);
  assert.deepEqual(repoPages(WIKI, 'fav_docs'), []);
  assert.deepEqual(repoPages(null, 'docs'), []);
  assert.equal(lastCommitDay({ last_commit: '2026-10-21' }), '2026-10-21');
  assert.equal(lastCommitDay({ last_commit: null }), null);
  assert.equal(lastCommitDay({ last_commit: '2026-10-21T10:00:00Z' }), null);
  assert.equal(lastCommitDay(null), null);
  assert.equal(heatSummary(weekLayout([])), 'Commits per day, last 53 weeks: 0 commits');
});

test('404 on the GitHub files: the Lab page says "GitHub data not built yet"; footers and cards stay quiet', async () => {
  const { doc, lab, calls } = setup({ 'data/people.json': PEOPLE });
  const root = doc.createElement('main');
  doc.body.appendChild(root);
  await lab.renderLab(root, () => true);
  assert.match(root.textContent, /GitHub data not built yet/);
  const body = doc.createElement('div');
  doc.body.appendChild(body);
  await lab.renderAuthors(body, 'setup/getting-started/ros-installation');
  assert.equal(body.children.length, 0);
  const aside = asideWithRows(doc, [['visual_localization', 'camera']]);
  await lab.renderRepoCards(aside, {});
  assert.equal(aside.querySelectorAll('.repo-row').length, 1, 'rows are left as they were');
  calls.forEach((p) => assert.match(p, /^data\/graph\/[a-z-]+\.json$|^data\/people\.json$/));
});

test('a stale navigation never paints: renderLab respects isCurrent', async () => {
  const { doc, lab } = setup();
  const root = doc.createElement('main');
  doc.body.appendChild(root);
  await lab.renderLab(root, () => false);
  assert.equal(root.children.length, 0);
});

test('HCLab is frozen and loads under plain node without a DOM', () => {
  assert.ok(Object.isFrozen(LAB));
  assert.equal(typeof LAB.renderLab, 'function');
});

// ------------------------------------------------------------------ the decoration hook (U4)
// js/editor.js (a signed-in member's page only) adds members-only detail under each public
// surface. Its seam: every surface carries data-hc-surface (+ the context a decorator needs),
// and onRender(fn) hears each surface once it is in the page. lab.js itself draws nothing more.
test('decoration hook: each surface is marked and announced once it is in the page', async () => {
  const { doc, lab } = setup();
  const heard = [];
  const off = lab.onRender((surface, el) => heard.push({ surface, el, connected: el.isConnected }));
  assert.equal(typeof off, 'function');
  const root = doc.createElement('main');
  doc.body.appendChild(root);
  await lab.renderLab(root, () => true);
  const labRoot = root.querySelector('[data-hc-surface="lab"]');
  assert.ok(labRoot, 'the Lab page root is marked');
  const rows = labRoot.querySelectorAll('.hc-commit');
  assert.equal(rows.length, 3);
  assert.equal(rows[0].getAttribute('data-hc-repo'), 'docs');
  assert.equal(rows[0].getAttribute('data-hc-sha'), 'a6e80a4');
  assert.ok(labRoot.querySelector('[data-hc-slot="lab-people"]'), 'the people column is a slot');
  const body = doc.createElement('div');
  doc.body.appendChild(body);
  await lab.renderAuthors(body, 'setup/getting-started/ros-installation');
  const box = body.querySelector('.hc-authors');
  assert.equal(box.getAttribute('data-hc-surface'), 'authors');
  assert.equal(box.getAttribute('data-hc-page'), 'setup/getting-started/ros-installation');
  const grid = doc.createElement('div');
  doc.body.appendChild(grid);
  await lab.wirePeople(grid);
  assert.equal(grid.getAttribute('data-hc-surface'), 'people');
  await lab.openPerson(null, { login: 'NBauschmann' });
  const pop = doc.body.querySelector('.hc-person-pop');
  assert.equal(pop.getAttribute('data-hc-surface'), 'popover');
  assert.equal(pop.getAttribute('data-hc-login'), 'NBauschmann');
  assert.deepEqual(heard.map((x) => [x.surface, x.el, x.connected]),
    [['lab', labRoot, true], ['authors', box, true], ['people', grid, true], ['popover', pop, true]]);
  // a roster-only popover (no GitHub match) carries no login
  await lab.openPerson(null, { roster: 'Lina Linked' });
  assert.equal(doc.body.querySelector('.hc-person-pop').hasAttribute('data-hc-login'), false);
  off();
  const n = heard.length;
  await lab.openPerson(null, { login: 'RHochdahl' });
  assert.equal(heard.length, n, 'unsubscribed: not heard');
});

test('decoration hook: a throwing listener never breaks a render; a stale sha is not marked', async () => {
  const files = Object.assign({}, ALL_FILES, { 'data/graph/org-activity.json': Object.assign({}, ORG, {
    recent_commits: [{ repo: 'docs', sha: 'not-a-sha', date: '2026-09-17T10:00:00Z', msg: 'x' },
      { repo: HOSTILE, sha: 'a6e80a4', date: '2026-09-17T10:00:00Z', msg: 'y' }] }) });
  const { doc, lab } = setup(files);
  lab.onRender(() => { throw new Error('a broken decorator'); });
  const root = doc.createElement('main');
  doc.body.appendChild(root);
  await lab.renderLab(root, () => true);
  assert.match(root.textContent, /Lab activity/);
  const rows = root.querySelectorAll('.hc-commit');
  assert.equal(rows[0].hasAttribute('data-hc-sha'), false, 'no sha mark for a bad sha');
  assert.equal(rows[1].hasAttribute('data-hc-repo'), false, 'no repo mark for a bad repository name');
  assert.ok(typeof LAB.onRender === 'function', 'the runtime exports onRender');
  assertNoHostileElement(doc);
});

test('M15: js/app.js asks "who wrote this" with the keys data/graph/page-authors.json uses, never for the Team page', () => {
  const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
  const app = read('js/app.js');
  const keys = [...app.matchAll(/HCLab\.renderAuthors\((.*?),\s*(`[^`]*`|'[^']*')\)/g)].map((m) => m[2].slice(1, -1));
  assert.equal(keys.length, 3, keys.join(' | '));
  // the literal part of each key: a page id follows a prefix's slash (M15: the Team page no longer asks)
  const prefixes = keys.map((k) => k.replace(/\$\{[^}]+\}$/, '')).sort();
  assert.deepEqual(prefixes, ['projects/', 'setup/', 'tools/']);
  const pages = Object.keys(JSON.parse(read('data/graph/page-authors.json')).pages);
  prefixes.forEach((p) => assert.ok(pages.some((k) => (p.endsWith('/') ? k.startsWith(p) : k === p)),
    `page-authors.json has ${p} keys`));
});

// ---- round 2, R4: who is on the current team (Kyle 2026-10-15, item 9) ----
test('splitTeam: GitHub work in the last 30 days or an admin pin keeps a linked person on the team; unlinked stay put', () => {
  const p = (name, extra) => Object.assign({ name, title: '', photo: null, link: null }, extra);
  const roster = { groups: [
    { id: 'active', title: 'Team', people: [p('Day29'), p('Day30'), p('Day31'), p('NeverWorked'), p('PinnedQuiet', { pinned: true }),
      p('UnlinkedNow')] },
    { id: 'alumni', title: 'Alumni', people: [p('Returned'), p('OldTimer'), p('UnlinkedPast')] },
  ] };
  const person = (login, name, day) => ({ login, name, avatar: null, html_url: `https://github.com/${login}`, roster: name, last_active: day });
  const pub = { people: {
    d29: person('d29', 'Day29', '2026-09-16'), d30: person('d30', 'Day30', '2026-09-15'), d31: person('d31', 'Day31', '2026-09-14'),
    nw: person('nw', 'NeverWorked', null), pq: person('pq', 'PinnedQuiet', null),
    ret: person('ret', 'Returned', '2026-10-10'), old: person('old', 'OldTimer', '2025-01-01'),
    stranger: person('stranger', null, null),
  } };
  const s = LAB.splitTeam(roster, pub, '2026-10-15');
  const names = (list) => list.map((x) => x.person.name);
  assert.deepEqual(names(s.team), ['Day29', 'Day30', 'PinnedQuiet', 'UnlinkedNow', 'Returned']);
  assert.deepEqual(names(s.alumni), ['Day31', 'NeverWorked', 'OldTimer', 'UnlinkedPast']);
  const by = (n) => [...s.team, ...s.alumni].find((x) => x.person.name === n);
  assert.deepEqual([by('Day30').linked, by('Day30').active, by('Day30').pinned], [true, true, false]);
  assert.deepEqual([by('PinnedQuiet').active, by('PinnedQuiet').pinned], [false, true]);
  assert.equal(by('UnlinkedNow').linked, false);
  assert.equal(by('UnlinkedNow').from, 'active');
  assert.equal(by('Returned').from, 'alumni');
  // a two-login person: the newest day wins
  pub.people.d31b = person('d31b', 'Day31', '2026-10-01');
  assert.ok(names(LAB.splitTeam(roster, pub, '2026-10-15').team).includes('Day31'));
  // no GitHub layer: everyone stays where an admin put them
  const none = LAB.splitTeam(roster, null, '2026-10-15');
  assert.deepEqual(names(none.team), roster.groups[0].people.map((x) => x.name));
  assert.deepEqual(names(none.alumni), roster.groups[1].people.map((x) => x.name));
  // a string "true" is not a pin
  const r2 = { groups: [{ id: 'active', people: [p('NeverWorked', { pinned: 'true' })] }] };
  assert.deepEqual(names(LAB.splitTeam(r2, pub, '2026-10-15').alumni), ['NeverWorked']);
});

// Kyle 2026-10-16 ("you can put me in alumni"): a pin in the alumni group pins a person to the ALUMNI
test('splitTeam: pinned: true in the alumni group keeps a person in the alumni whatever their GitHub work', () => {
  const p = (name, extra) => Object.assign({ name, title: '', photo: null, link: null }, extra);
  const roster = { groups: [
    { id: 'active', title: 'Team', people: [p('TeamPinnedBusy', { pinned: true }), p('Busy')] },
    { id: 'alumni', title: 'Alumni', people: [p('AwayBusy', { pinned: true }), p('Returned'), p('AwayQuiet', { pinned: true }),
      p('UnlinkedPinned', { pinned: true }), p('StringPin', { pinned: 'true' })] },
  ] };
  const person = (login, name, day) => ({ login, name, avatar: null, html_url: `https://github.com/${login}`, roster: name, last_active: day });
  const pub = { people: {
    tpb: person('tpb', 'TeamPinnedBusy', '2026-10-14'), b: person('b', 'Busy', '2026-10-14'),
    ab: person('ab', 'AwayBusy', '2026-10-15'), ret: person('ret', 'Returned', '2026-10-10'),
    aq: person('aq', 'AwayQuiet', null), sp: person('sp', 'StringPin', '2026-10-12'),
  } };
  const s = LAB.splitTeam(roster, pub, '2026-10-15');
  const names = (list) => list.map((x) => x.person.name);
  // an alumni pin beats recent work; an unpinned alumnus who works again comes back; a string is not a pin
  assert.deepEqual(names(s.team), ['TeamPinnedBusy', 'Busy', 'Returned', 'StringPin']);
  assert.deepEqual(names(s.alumni), ['AwayBusy', 'AwayQuiet', 'UnlinkedPinned']);
  const by = (n) => [...s.team, ...s.alumni].find((x) => x.person.name === n);
  assert.deepEqual([by('AwayBusy').linked, by('AwayBusy').active, by('AwayBusy').pinned, by('AwayBusy').from],
    [true, true, true, 'alumni']);
  assert.deepEqual([by('TeamPinnedBusy').pinned, by('TeamPinnedBusy').from], [true, 'active']);
  // the committed roster: Kyle Nelson is pinned first in the alumni, title, highlight, photo and link kept
  const read = (f) => fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
  const real = JSON.parse(read('data/people.json'));
  const alumni = real.groups.find((g) => g.id === 'alumni').people;
  assert.equal(alumni[0].name, 'Kyle Nelson');
  assert.deepEqual([alumni[0].title, alumni[0].highlight, alumni[0].pinned], ['Site creator', true, true]);
  assert.ok(/kyle-nelson\.jpg$/.test(alumni[0].photo) && alumni[0].link === 'https://kyle-nelson-berkeley.vercel.app');
  assert.ok(!real.groups.find((g) => g.id === 'active').people.some((x) => x.name === 'Kyle Nelson'));
  const live = LAB.splitTeam(real, JSON.parse(read('data/graph/people-public.json')), '2026-10-16');
  assert.equal(live.alumni[0].person.name, 'Kyle Nelson', 'pinned to the alumni even though he worked on GitHub today');
});
