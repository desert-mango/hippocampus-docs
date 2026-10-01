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
    get offsetWidth() { return 300; }
    get offsetHeight() { return 160; }
  }
  const doc = {
    created, htmlWrites,
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
    { repo: 'docs', sha: 'a6e80a4', date: '2026-09-17T10:00:00Z', msg: HOSTILE },
    { repo: 'fav_docs', sha: 'e736e06', date: '2026-09-16T10:00:00Z', msg: 'add cad files' },
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

const ALL_FILES = {
  'data/graph/org-activity.json': ORG,
  'data/graph/github-repos.json': REPOS,
  'data/graph/page-authors.json': PAGE_AUTHORS,
  'data/graph/people-public.json': PEOPLE_PUBLIC,
  'data/people.json': PEOPLE,
};

function setup(files) {
  const doc = makeDoc();
  const f = fakeFetch(files || ALL_FILES);
  const lab = createLab({ doc, win: WIN, fetchJSON: f.fetchJSON });
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
  assert.equal(root.querySelectorAll('rect').length, 53 * 7 - 2);
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

test('repo cards replace the plain rows; unknown repos keep a plain card; hostile descriptions stay text', async () => {
  const { doc, lab } = setup();
  const aside = asideWithRows(doc, [['visual_localization', 'camera + AprilTag'], ['apriltag_ros', 'upstream fork'], ['not_in_snapshot', 'external']]);
  await lab.renderRepoCards(aside, {});
  assert.equal(aside.querySelectorAll('.repo-row').length, 0);
  const cards = aside.querySelectorAll('.hc-repo');
  assert.equal(cards.length, 3);
  assert.equal(cards[0].getAttribute('href'), 'https://github.com/HippoCampusRobotics/visual_localization');
  assert.equal(cards[0].getAttribute('rel'), 'noopener');
  assert.match(cards[0].textContent, /camera \+ AprilTag localization/);
  assert.ok(cards[1].textContent.includes(HOSTILE));
  assert.match(cards[1].textContent, /fork/);
  assert.match(cards[2].textContent, /not_in_snapshot/);
  assert.ok(!aside.textContent.includes('dropped_from_project'), 'a snapshot repo outside the project is ignored');
  assertNoHostileElement(doc);
});

test('who wrote this: names with committed avatars, stale page keys ignored, hostile names stay text', async () => {
  const { doc, lab } = setup();
  const body = doc.createElement('div');
  doc.body.appendChild(body);
  await lab.renderAuthors(body, 'setup/getting-started/ros-installation');
  const box = body.querySelector('.hc-authors');
  assert.ok(box);
  const idx = buildPeopleIndex(PEOPLE_PUBLIC, PEOPLE);
  const lines = authorLines(PAGE_AUTHORS.pages['setup/getting-started/ros-installation'], idx);
  assert.equal(lines.length, 3);
  lines.forEach((line) => assert.ok(box.textContent.includes(line), line));
  const imgs = box.querySelectorAll('img');
  assert.ok(imgs.length >= 2);
  imgs.forEach((img) => assert.match(img.getAttribute('src'), /^data\/graph\/avatars\//));
  assert.ok(box.querySelectorAll('[data-hc-login]').length >= 2, 'names carry the popover trigger');
  // a page with no entry renders nothing; an entry for a removed page is simply never asked for
  const other = doc.createElement('div');
  doc.body.appendChild(other);
  await lab.renderAuthors(other, 'setup/not/in/page-authors');
  assert.equal(other.children.length, 0);
  assertNoHostileElement(doc);
});

test('the popover: roster photo/initials, Personal page link, @login line; Esc closes; one at a time', async () => {
  const { doc, lab } = setup();
  const card = doc.createElement('a');
  card.className = 'person-card';
  card.setAttribute('href', 'https://www.tuhh.de/mum/team/wimi/daniel-duecker');
  const media = doc.createElement('img');
  media.className = 'person-photo';
  media.setAttribute('data-hc-person', 'Daniel-André Dücker');
  card.appendChild(media);
  const grid = doc.createElement('div');
  grid.appendChild(card);
  doc.body.appendChild(grid);
  await lab.wirePeople(grid);
  const ev = doc.dispatch(media, 'click');
  assert.equal(ev.defaultPrevented, true, 'a linked card does not also navigate');
  await lab.whenReady();
  let pops = doc.body.querySelectorAll('.hc-person-pop');
  assert.equal(pops.length, 1);
  const pop = pops[0];
  assert.match(pop.textContent, /Daniel-André Dücker/);
  assert.match(pop.textContent, /Senior Scientist \(TUM\)/);
  assert.match(pop.textContent, /Personal page/);
  assert.match(pop.textContent, /@DanielDuecker on GitHub/);
  const links = pop.querySelectorAll('a').map((a) => a.getAttribute('href'));
  assert.ok(links.includes('https://www.tuhh.de/mum/team/wimi/daniel-duecker'));
  assert.ok(links.includes('https://github.com/DanielDuecker'));
  const big = pop.querySelector('.hc-pp-media');
  assert.equal(big.getAttribute('src'), 'https://res.cloudinary.com/x/image/upload/v1/people/dd.jpg', 'the big image is the roster photo');
  assert.equal(pop.querySelector('.hc-pp-gh img').getAttribute('src'), 'data/graph/avatars/DanielDuecker.jpg');
  // a second trigger replaces the first popover
  await lab.openPerson(media, { login: 'RHochdahl' });
  pops = doc.body.querySelectorAll('.hc-person-pop');
  assert.equal(pops.length, 1);
  assert.match(pops[0].textContent, /René Hochdahl/);
  assert.equal(pops[0].querySelector('.hc-pp-media').localName, 'div', 'no photo: initials');
  doc.dispatch(doc.body, 'keydown', { key: 'Escape' });
  assert.equal(doc.body.querySelectorAll('.hc-person-pop').length, 0);
  // roster person without a match: the card's link, no GitHub line
  await lab.openPerson(media, { roster: 'Lina Linked' });
  const lone = doc.body.querySelector('.hc-person-pop');
  assert.ok(lone);
  assert.match(lone.textContent, /Personal page/);
  assert.equal(lone.querySelector('.hc-pp-gh'), null);
  assert.ok(!/on GitHub/.test(lone.textContent));
  lab.closePerson();
  // a roster person with neither a link nor a match has nothing to show
  await lab.openPerson(media, { roster: 'Ada Nomatch' });
  assert.equal(doc.body.querySelector('.hc-person-pop'), null);
  // a hostile display name stays text
  await lab.openPerson(media, { login: 'ghosty' });
  assert.ok(doc.body.querySelector('.hc-person-pop').textContent.includes(HOSTILE));
  assert.ok(doc.body.querySelector('.hc-person-pop').textContent.includes('GitHub contributor'));
  assertNoHostileElement(doc);
});

test('wirePeople drops the trigger from a link-less card with no GitHub match', async () => {
  const { doc, lab } = setup();
  const grid = doc.createElement('div');
  const mk = (name, linked) => {
    const card = doc.createElement(linked ? 'a' : 'div');
    card.className = linked ? 'person-card' : 'person-card is-static';
    const m = doc.createElement('div');
    m.className = 'person-initials';
    m.setAttribute('data-hc-person', name);
    m.setAttribute('role', 'button');
    m.setAttribute('tabindex', '0');
    card.appendChild(m);
    grid.appendChild(card);
    return m;
  };
  const ada = mk('Ada Nomatch', false);
  const kyle = mk('Kyle Nelson', false);
  const ghost = mk('Not In People Json', false);
  doc.body.appendChild(grid);
  await lab.wirePeople(grid);
  assert.equal(ada.hasAttribute('data-hc-person'), false);
  assert.equal(ada.hasAttribute('role'), false);
  assert.equal(ada.hasAttribute('tabindex'), false);
  assert.equal(kyle.hasAttribute('data-hc-person'), true, 'a GitHub match keeps the trigger');
  assert.equal(ghost.hasAttribute('data-hc-person'), false, 'a stale roster name is ignored without error');
  const ev = doc.dispatch(ada, 'click');
  assert.equal(ev.defaultPrevented, false);
  assert.equal(doc.body.querySelectorAll('.hc-person-pop').length, 0);
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
  assert.equal(rows.length, 2);
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

test('js/app.js asks "who wrote this" with the keys data/graph/page-authors.json uses', () => {
  const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
  const app = read('js/app.js');
  const keys = [...app.matchAll(/HCLab\.renderAuthors\((.*?),\s*(`[^`]*`|'[^']*')\)/g)].map((m) => m[2].slice(1, -1));
  assert.equal(keys.length, 4, keys.join(' | '));
  // the literal part of each key: a page id follows a prefix's slash
  const prefixes = keys.map((k) => k.replace(/\$\{[^}]+\}$/, '')).sort();
  assert.deepEqual(prefixes, ['about', 'projects/', 'setup/', 'tools/']);
  const pages = Object.keys(JSON.parse(read('data/graph/page-authors.json')).pages);
  prefixes.forEach((p) => assert.ok(pages.some((k) => (p.endsWith('/') ? k.startsWith(p) : k === p)),
    `page-authors.json has ${p} keys`));
});
