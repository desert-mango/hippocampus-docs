// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 1 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test that members-only GitHub detail reaches signed-in members only, through the org reader alone.
/* Members-only detail (plan U4, D-A, D-B, D-B2, D-C, D-H). A signed-in member
   (a role with push) sees, under the public GitHub surfaces js/lab.js draws:
   authors and "People committing this year" on the Lab page, a GitHub strip
   on About cards, counts / projects / recent commits / last active in the
   person popover, and per-author counts and date ranges under "who wrote
   this". js/editor.js reads them live through HCCore.createOrgReader (the
   ONE reader allowed to send the token to the org's commits), and nothing
   else. These tests run js/cms-core.js, js/lab.js and js/editor.js in a vm
   over a small fake DOM (it throws on any non-empty innerHTML write) and
   tools/tests/fake_github.js (the same route table the localhost walk uses),
   with the real committed data/graph files:

     - read-only role: no org-reader call, no members node;
     - push role: the reads, and the nodes on all four surfaces;
     - a path the reader does not allow is refused before any fetch;
     - a 403 with the token -> ONE anonymous retry (no Authorization) that
       answers; 403 again -> the status message, nothing more;
     - a hostile commit message or name creates no element;
     - Editor on (body.hc-editor-on): nothing is read or drawn;
     - the MutationObserver on #content decorates a repainted surface;
     - sign-out removes every members node and the reader's cache;
     - storage: only the reader's 15-minute cache, in sessionStorage;
     - paging: page 2 and 3 only while a page is full; three full pages is
       the cap, shown as "at least N"; a page counts at most 100 rows, and a
       commit seen on two pages counts once;
     - a session replaced without sign-out never gets the first person's
       cached answers, even ones still in flight; a login that is not a
       GitHub login is never written as the cache's owner;
     - a guest never loads js/editor.js (index.html), and lab.js never asks GitHub.

   No browser, no network, and every token is an obvious placeholder.

     node --test tools/tests/test_members_gating.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const C = require(path.join(ROOT, 'js', 'cms-core.js'));
const { createFakeGitHub } = require(path.join(ROOT, 'tools', 'tests', 'fake_github.js'));

const FIXTURES = path.join(ROOT, 'tools', 'tests', 'fixtures', 'github-data');
const readRepo = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const readJSON = (p) => JSON.parse(readRepo(p));
const TOKEN = '<yours>-members-token';
const NOW = Date.parse('2026-10-01T12:00:00Z');      // the year view's window: since 2025-10-01
const API = 'https://api.github.com';
const ORG_RE = /^https:\/\/api\.github\.com\/repos\/HippoCampusRobotics\//;
const PAGE_RE = /^https:\/\/api\.github\.com\/repos\/desert-mango\/hippocampus-docs\/(commits\?|compare\/)/;
const UBUNTU = 'setup/raspberry-pi/ubuntu-24-04-server';
const HOSTILE = '<img src=x onerror=alert(1)>';

// ------------------------------------------------------------------ fake DOM
function makeDoc() {
  const created = [];
  const htmlWrites = [];
  const docListeners = {};
  function matchesOne(el, part) {
    const m = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+)*)((?:\[[\w-]+(?:="[^"]*")?\])*)$/.exec(part);
    if (!m) throw new Error(`fake DOM cannot parse selector ${part}`);
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
    if (sel === '*') return true;
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
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  }
  class El {
    constructor(tag, ns) {
      this.localName = String(tag).toLowerCase();
      this.tagName = this.localName.toUpperCase();
      this.namespaceURI = ns || 'http://www.w3.org/1999/xhtml';
      this.nodeType = 1; this.childNodes = []; this.parentNode = null;
      this.attrs = new Map(); this.listeners = {}; this.style = {}; this.dataset = {};
      this.hidden = false; this.disabled = false; this.value = '';
      created.push(this);
    }
    get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
    get firstChild() { return this.childNodes[0] || null; }
    get isConnected() {
      let c = this;
      while (c.parentNode) c = c.parentNode;
      return c === doc.documentElement;
    }
    appendChild(n) {
      if (n.parentNode && n.parentNode.removeChild) n.parentNode.removeChild(n);
      n.parentNode = this; this.childNodes.push(n); return n;
    }
    append(...ns) { ns.forEach((n) => this.appendChild(typeof n === 'string' ? new Text(n) : n)); }
    prepend(n) { return this.insertBefore(typeof n === 'string' ? new Text(n) : n, this.childNodes[0] || null); }
    insertBefore(n, ref) {
      if (!ref) return this.appendChild(n);
      if (n.parentNode && n.parentNode.removeChild) n.parentNode.removeChild(n);
      const i = this.childNodes.indexOf(ref);
      n.parentNode = this; this.childNodes.splice(i, 0, n); return n;
    }
    replaceChildren(...ns) {
      this.childNodes.forEach((c) => { c.parentNode = null; });
      this.childNodes = [];
      ns.forEach((n) => this.appendChild(typeof n === 'string' ? new Text(n) : n));
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
      if (String(v) !== '') throw new Error(`innerHTML write: ${String(v).slice(0, 60)}`);
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
    focus() {}
    scrollIntoView() {}
    get offsetWidth() { return 300; }
    get offsetHeight() { return 160; }
  }
  const doc = {
    created, htmlWrites,
    createElement: (t) => new El(t),
    createElementNS: (ns, t) => new El(t, ns),
    createTextNode: (v) => new Text(v),
    addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
    removeEventListener: () => {},
    getElementById: (id) => doc.documentElement.querySelectorAll('*').find((e) => e.getAttribute('id') === id) || null,
    querySelector: (sel) => doc.documentElement.querySelector(sel),
    querySelectorAll: (sel) => doc.documentElement.querySelectorAll(sel),
  };
  doc.documentElement = new El('html');
  doc.body = new El('body');
  doc.documentElement.appendChild(doc.body);
  return doc;
}

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
    raw: m,
  };
}

const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 120; i += 1) await tick(); };

/* index.html in a vm: header, #content, #hc-frame-host; js/cms-core.js,
   js/lab.js (static on the page), then js/editor.js (injected for a session)
   and HCEditor.start({session}). opts: variant ('push' | 'readonly'), extra
   (the fake's), hc (data file overrides), noSession, start (more start opts). */
function openSite(opts) {
  const o = opts || {};
  const doc = makeDoc();
  const header = doc.createElement('div');
  header.className = 'header-actions';
  const content = doc.createElement('main');
  content.setAttribute('id', 'content');
  const host = doc.createElement('div');
  host.setAttribute('id', 'hc-frame-host');
  host.hidden = true;
  doc.body.append(header, content, host);
  const fake = createFakeGitHub({
    readFixture: async (name) => { try { return fs.readFileSync(path.join(FIXTURES, name), 'utf8'); } catch (e) { return null; } },
    readFile: async (p) => { try { return readRepo(p); } catch (e) { return null; } },
    variant: o.variant,
    extra: o.extra,
  });
  const calls = [];
  const dataReads = [];
  const listeners = {};
  const observers = [];
  const storage = memoryStorage();
  const local = memoryStorage();
  class FakeObserver {
    constructor(cb) { this.cb = cb; this.target = null; this.options = null; observers.push(this); }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.target = null; }
    fire() { if (this.target) this.cb([{ type: 'childList' }], this); }
  }
  const win = vm.createContext({
    document: doc,
    sessionStorage: storage,
    localStorage: local,
    location: { origin: 'https://docs.example.org', pathname: '/', search: '', hash: o.hash || '#/' },
    history: { replaceState: () => {} },
    crypto: { getRandomValues: (arr) => arr.fill(7) },
    open: () => null,
    confirm: () => true,
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    HC: Object.freeze({ preview: false,
      fetchJSON: async (p) => {
        dataReads.push(p);
        if (o.hc && Object.prototype.hasOwnProperty.call(o.hc, p)) return JSON.parse(JSON.stringify(o.hc[p]));
        return JSON.parse(readRepo(p));
      } }),
    URLSearchParams,
    MutationObserver: FakeObserver,
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref(); return t; }, clearInterval, clearTimeout,
    setTimeout: (fn) => setTimeout(fn, 0),
    console,
  });
  win.window = win;
  win.__clock = { now: NOW };
  vm.runInContext('Date.now = () => __clock.now;', win);
  win.fetch = (url, init) => {
    const headers = (init && init.headers) || {};
    calls.push({ url: String(url), method: (init && init.method) || 'GET', auth: Object.prototype.hasOwnProperty.call(headers, 'Authorization') });
    return fake.fetch(url, init);
  };
  for (const f of ['cms-core.js', 'lab.js', 'editor.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), win, { filename: f });
  }
  const session = o.noSession ? null : C.makeSession(TOKEN, null, 'kyle-nelson-berkeley', NOW);
  const started = win.HCEditor.start(Object.assign({ session }, o.start));
  const site = {
    win, doc, content, calls, dataReads, storage, local, observers, started, listeners,
    later(ms) { win.__clock.now += ms; },
    orgCalls: () => calls.filter((c) => ORG_RE.test(c.url) || PAGE_RE.test(c.url)),
    members: () => doc.documentElement.querySelectorAll('[data-hc-members]'),
    // the Lab page, as app.js routes it: #content holds what renderLab draws
    async lab() {
      content.replaceChildren();
      await win.HCLab.renderLab(content, () => true);
      await settle();
      return content.querySelector('[data-hc-surface="lab"]');
    },
    // a page body with its "who wrote this" footer (app.js: renderAuthors(body, key))
    async page(key) {
      content.replaceChildren();
      const body = doc.createElement('div');
      body.className = 'page-body';
      content.appendChild(body);
      await win.HCLab.renderAuthors(body, key);
      await settle();
      return body.querySelector('[data-hc-surface="authors"]');
    },
    // the About page's People roster, as app.js's personCardHTML draws it
    async about() {
      content.replaceChildren();
      const body = doc.createElement('div');
      body.className = 'page-body';
      const roster = (o.hc && o.hc['data/people.json']) || readJSON('data/people.json');
      roster.groups.forEach((g) => (g.people || []).forEach((p) => {
        const card = doc.createElement(p.link ? 'a' : 'div');
        card.className = 'person-card';
        const media = doc.createElement('div');
        media.className = 'person-initials hc-pp-trigger';
        media.setAttribute('data-hc-person', p.name);
        const nm = doc.createElement('span');
        nm.className = 'person-name';
        nm.textContent = p.name;
        card.append(media, nm);
        body.appendChild(card);
      }));
      content.appendChild(body);
      await win.HCLab.wirePeople(body);
      await settle();
      return body;
    },
    async popover(login) {
      await win.HCLab.openPerson(null, { login });
      await settle();
      return doc.body.querySelector('.hc-person-pop');
    },
    card: (name) => content.querySelectorAll('.person-card').find((c) => c.querySelector('.person-name').textContent === name),
  };
  return site;
}

/* The committed data files, with the few entries these tests count on pinned,
   so a later regeneration of data/graph/ (derive.yml) cannot move them: the
   old docs repository inside the year window, and four logins' names and
   roster names (the U0 fixtures' authors). */
function pinnedData() {
  const repos = readJSON('data/graph/github-repos.json');
  repos.repos.docs = Object.assign({}, repos.repos.docs, { name: 'docs', fork: false, private: false,
    archived: false, pushed_at: '2026-09-17', commits_365d: 8 });
  const pub = readJSON('data/graph/people-public.json');
  [['NBauschmann', 'Nathalie Bauschmann'], ['FinnBreu', 'Finn Breuer'], ['VincentTUHH', 'Vincent Lenz'],
    ['lennartalff', 'Thies Lennart Alff']].forEach(([login, name]) => {
    pub.people[login] = { login, name, avatar: `data/graph/avatars/${login}.jpg`, html_url: `https://github.com/${login}`, roster: name };
  });
  const roster = readJSON('data/people.json');
  const names = new Set(roster.groups.flatMap((g) => (g.people || []).map((x) => x.name)));
  ['Nathalie Bauschmann', 'Thies Lennart Alff'].forEach((name) => {
    if (!names.has(name)) roster.groups[0].people.push({ name, title: 'Pinned for this test', photo: null, link: null });
  });
  return { 'data/graph/github-repos.json': repos, 'data/graph/people-public.json': pub, 'data/people.json': roster };
}

async function member(opts) {
  const o = Object.assign({}, opts);
  o.hc = Object.assign(pinnedData(), o.hc);
  const site = openSite(o);
  await settle();
  return site;
}

// the elements a hostile string could have become, and every attribute's value
function assertNoHostileElement(doc) {
  assert.deepEqual(doc.htmlWrites.filter((h) => h !== ''), [], 'no markup is ever written');
  for (const el of doc.created) {
    assert.ok(!/[<>=\s]/.test(el.localName), `no element named from a string (${el.localName})`);
    for (const [k, v] of el.attrs) {
      assert.ok(!/^on/i.test(k), `no event-handler attribute (${k})`);
      assert.ok(!/^\s*javascript:/i.test(v), `no javascript: URL in ${k}`);
      assert.ok(!/avatars\.githubusercontent\.com/.test(v), 'never a live GitHub avatar');
    }
    // GitHub faces are the committed copies; the popover's big image is the roster photo (lab.js)
    if (el.localName === 'img' && !el.classList.contains('hc-pp-media')) {
      assert.match(el.getAttribute('src'), /^data\/graph\/avatars\/[A-Za-z0-9-]+\.(png|jpg)$/);
    }
  }
}

// ------------------------------------------------------------------ gating
test('read-only role: no org-reader call and no members node on any surface', async () => {
  const site = await member({ variant: 'readonly' });
  assert.ok(await site.lab(), 'the public Lab page is drawn');
  assert.equal(site.members().length, 0);
  assert.ok(await site.page(UBUNTU), 'the public footer is drawn');
  assert.equal(site.members().length, 0);
  assert.ok(await site.about());
  assert.ok(await site.popover('NBauschmann'), 'the public popover is drawn');
  assert.deepEqual(site.orgCalls(), [], 'the org reader is never asked');
  assert.equal(site.members().length, 0);
  assert.ok(site.calls.some((c) => c.url === `${API}/repos/desert-mango/hippocampus-docs`), 'the role was read');
});

test('no session at all: HCEditor.start mounts nothing and decorates nothing', async () => {
  const site = await member({ noSession: true });
  assert.equal(site.started, false);
  await site.lab();
  await site.popover('NBauschmann');
  assert.equal(site.calls.length, 0, 'no GitHub request at all');
  assert.equal(site.members().length, 0);
  assert.equal(site.observers.length, 0, 'not even an observer');
});

test('push role: the Lab page gains authors on recent commits and "People committing this year"', async () => {
  const site = await member();
  const lab = await site.lab();
  const year = site.orgCalls();
  assert.ok(year.length > 0 && year.length <= 12, `at most 12 year reads (${year.length})`);
  year.forEach((c) => {
    assert.match(c.url, /^https:\/\/api\.github\.com\/repos\/HippoCampusRobotics\/[A-Za-z0-9._-]+\/commits\?since=2025-10-01T00%3A00%3A00Z&per_page=100$/);
    assert.equal(c.auth, true, 'the member\'s token');
    assert.equal(c.method, 'GET');
  });
  const repos = pinnedData()['data/graph/github-repos.json'].repos;
  year.forEach((c) => {
    const name = /HippoCampusRobotics\/([^/]+)\/commits/.exec(c.url)[1];
    assert.equal(repos[name].fork, false, `${name} is not a fork`);
    assert.ok(repos[name].pushed_at >= '2025-10-01', `${name} was pushed inside the window`);
  });
  assert.ok(year.some((c) => /\/docs\/commits/.test(c.url)));
  const people = lab.querySelector('.hc-m-people');
  assert.ok(people && people.hasAttribute('data-hc-members'));
  assert.equal(people.parentNode, lab.querySelector('[data-hc-slot="lab-people"]'), 'inside the people column');
  assert.match(people.textContent, /People committing this year/);
  const rows = people.querySelectorAll('.hc-m-row')
    .map((r) => ['.nm', '.sub', '.cnt', '.last'].map((c) => r.querySelector(c).textContent));
  assert.deepEqual(rows, [
    ['Nathalie Bauschmann', '@NBauschmann', '5 commits', 'last active 2026-08-27'],
    ['Finn Breuer', '@FinnBreu', '2 commits', 'last active 2026-09-11'],
    ['Vincent Lenz', '@VincentTUHH', '1 commit', 'last active 2026-02-13'],
  ]);
  assert.equal(people.querySelector('.hc-m-row').getAttribute('data-hc-login'), 'NBauschmann', 'a row opens the popover');
  // the recent-commit rows the public file lists gain their author, when the live read has the sha
  const act = readJSON('data/graph/org-activity.json');
  const docsRow = (act.recent_commits || []).find((c) => c.repo === 'docs' && c.sha === '1063769');
  if (docsRow) {
    const row = lab.querySelector('[data-hc-sha="1063769"]');
    assert.equal(row.querySelector('.hc-m-author').textContent, 'Finn Breuer');
  }
  lab.querySelectorAll('.hc-m-author').forEach((a) => assert.ok(a.hasAttribute('data-hc-members')));
  assertNoHostileElement(site.doc);
});

test('push role: About cards gain the GitHub strip (projects, contributions, last commit)', async () => {
  const site = await member();
  await site.about();
  const card = site.card('Nathalie Bauschmann');
  const strip = card.querySelector('.hc-gh-strip');
  assert.ok(strip && strip.hasAttribute('data-hc-members'));
  const contrib = readJSON('data/graph/contributors.json').projects;
  const mine = Object.keys(contrib).map((k) => (contrib[k].contributors || []).find((x) => x.login === 'NBauschmann')).filter(Boolean);
  const total = mine.reduce((n, x) => n + x.contributions, 0);
  assert.match(strip.textContent, /@NBauschmann/);
  assert.match(strip.textContent, new RegExp(`${mine.length} projects`));
  assert.match(strip.textContent, new RegExp(`${total} contributions`));
  assert.match(strip.textContent, /last commit 2026-08-27/);
  const alff = site.card('Thies Lennart Alff');
  assert.match(alff.querySelector('.hc-gh-strip').textContent, /no commits in the last year/);
  // a roster card with no GitHub login gets nothing
  const people = pinnedData()['data/graph/people-public.json'].people;
  const rostered = new Set(Object.keys(people).map((k) => people[k].roster).filter(Boolean));
  const plain = site.content.querySelectorAll('.person-card')
    .find((c) => !rostered.has(c.querySelector('.person-name').textContent));
  if (plain) assert.equal(plain.querySelector('.hc-gh-strip'), null);
  assertNoHostileElement(site.doc);
});

test('push role: the popover gains counts, projects, five recent commits and last active', async () => {
  const site = await member();
  const pop = await site.popover('NBauschmann');
  const box = pop.querySelector('.hc-pp-members');
  assert.ok(box && box.hasAttribute('data-hc-members'));
  assert.match(box.textContent, /5 commits this year · last active 2026-08-27/);
  const projects = readJSON('data/projects.json').projects;
  const contrib = readJSON('data/graph/contributors.json').projects;
  const ids = Object.keys(contrib).filter((k) => (contrib[k].contributors || []).some((x) => x.login === 'NBauschmann'));
  const links = box.querySelectorAll('a').map((a) => a.getAttribute('href'));
  ids.filter((id) => projects.some((p) => p.id === id)).forEach((id) => assert.ok(links.includes(`#/projects/${id}`), id));
  const recent = box.querySelectorAll('.hc-m-commit');
  assert.equal(recent.length, 5);
  assert.match(recent[0].textContent, /Add instruction for enabling motors/);
  assert.match(recent[0].textContent, /docs · 2026-08-27 · 0eba667/);
  // a contributor with no commit this year
  const pop2 = await site.popover('lennartalff');
  assert.match(pop2.querySelector('.hc-pp-members').textContent, /No commits in the last year/);
  assertNoHostileElement(site.doc);
});

test('push role: who wrote this gains per-author counts and date ranges, across the folder move', async () => {
  const site = await member();
  const box = await site.page(UBUNTU);
  const m = box.querySelector('.hc-m-authors');
  assert.ok(m && m.hasAttribute('data-hc-members'));
  const urls = site.orgCalls().map((c) => c.url);
  const q = (p, until) => `${API}/repos/HippoCampusRobotics/docs/commits?path=${encodeURIComponent(p)}${until ? '&until=2025-03-11T00%3A00%3A00Z' : ''}&per_page=100`;
  assert.deepEqual(urls.slice().sort(), [
    q('contents/raspberry_pi_setup/ubuntu_24.04_server_64bit.rst'),
    q('raspberry_pi_setup/ubuntu_24.04_server_64bit.rst', true),
    q('raspberry_pi_4b_setup/ubuntu_24.04_server_64bit.rst', true),
    `${API}/repos/desert-mango/hippocampus-docs/commits?path=${encodeURIComponent('content/setup/raspberry-pi/ubuntu-24-04-server.md')}&per_page=100`,
  ].sort());
  const lines = m.querySelectorAll('.hc-m-line').map((l) => l.textContent);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], 'Original, in HippoCampusRobotics/docs: Nathalie Bauschmann — 2 commits, 2025-03-10; '
    + 'Thies Lennart Alff — 2 commits, 2024-08-02 to 2024-08-05.');
  assert.equal(lines[1], 'On this site: no commits found.');
  // the box sits above the public footnote
  const kids = box.children;
  assert.ok(kids.indexOf(m) < kids.indexOf(box.querySelector('.hc-authors-note')));
});

// ------------------------------------------------------------------ the reader's wiring
test('the reader refuses a repository outside the committed list: no fetch, a plain line', async () => {
  const authors = readJSON('data/graph/page-authors.json');
  authors.pages[UBUNTU].original.repo = 'HippoCampusRobotics/not-in-the-list';
  const site = await member({ hc: { 'data/graph/page-authors.json': authors } });
  const box = await site.page(UBUNTU);
  assert.ok(site.orgCalls().every((c) => !/not-in-the-list/.test(c.url)), 'never fetched');
  assert.match(box.querySelector('.hc-m-authors').textContent,
    /Not read: HippoCampusRobotics\/not-in-the-list is not in the committed repository list/);
  // another owner is never even asked for
  authors.pages[UBUNTU].original.repo = 'someone-else/docs';
  const other = await member({ hc: { 'data/graph/page-authors.json': authors } });
  const box2 = await other.page(UBUNTU);
  assert.ok(other.calls.every((c) => !/someone-else/.test(c.url)));
  assert.equal(other.orgCalls().filter((c) => ORG_RE.test(c.url)).length, 0);
  assert.ok(box2.querySelector('.hc-m-authors'));
});

test('a 403 with the token: ONE anonymous retry (no Authorization) answers, and is drawn', async () => {
  const site = await member({ extra: { orgDeny: 'token' } });
  const box = await site.page(UBUNTU);
  const calls = site.orgCalls();
  const byUrl = new Map();
  calls.forEach((c) => byUrl.set(c.url, (byUrl.get(c.url) || []).concat(c.auth)));
  assert.equal(byUrl.size, 4);
  byUrl.forEach((auths, url) => assert.deepEqual(auths, [true, false], url));
  assert.match(box.querySelector('.hc-m-authors').textContent, /Nathalie Bauschmann — 2 commits/);
});

test('403 again without the token: the status message, and no third request', async () => {
  const site = await member({ extra: { orgDeny: 'all' } });
  const box = await site.page(UBUNTU);
  const calls = site.orgCalls();
  assert.equal(calls.length, 8, 'four reads, each tried twice');
  const m = box.querySelector('.hc-m-authors');
  assert.match(m.textContent, /GitHub answered 403 for HippoCampusRobotics\/docs — tell Desert Mango/);
  assert.match(m.textContent, /GitHub answered 403 for desert-mango\/hippocampus-docs — tell Desert Mango/);
  assert.equal(m.querySelectorAll('.hc-m-line').length, 0, 'no counts were made up');
  // the popover's year view: every repository failed, summed up in one line per status
  const pop = await site.popover('NBauschmann');
  const errs = pop.querySelectorAll('.hc-m-error').map((e) => e.textContent);
  const yearReads = new Set(site.orgCalls().filter((c) => /commits\?since=/.test(c.url)).map((c) => c.url)).size;
  assert.equal(errs.length, 1);
  const m2 = /^GitHub answered 403 for HippoCampusRobotics\/[A-Za-z0-9._-]+ and (\d+) more repositories — tell Desert Mango$/.exec(errs[0]);
  assert.ok(m2, errs[0]);
  assert.equal(Number(m2[1]), yearReads - 1);
  assert.match(pop.querySelector('.hc-pp-members').textContent, /This year's commits could not be read\./);
});

test('hostile commit messages and author names create no element', async () => {
  const commit = (sha, login, name, msg, date) => ({ sha, commit: { author: { name, date }, message: msg },
    author: login ? { login, avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' } : null });
  const site = await member({ extra: { orgCommits: {
    docs: [commit('a'.repeat(40), 'NBauschmann', 'Nathalie Bauschmann', `${HOSTILE}\n\nmore <b>markup</b>`, '2026-09-20T10:00:00Z'),
      commit('b'.repeat(40), null, HOSTILE, '<script>alert(1)</script>', '2026-09-19T10:00:00Z'),
      commit('c'.repeat(40), 'javascript:alert(1)', 'x', 'y', '2026-09-18T10:00:00Z')],
    'docs/contents/raspberry_pi_setup/ubuntu_24.04_server_64bit.rst': [commit('d'.repeat(40), null, HOSTILE, 'z', '2025-01-01T10:00:00Z')],
  } } });
  const lab = await site.lab();
  const pop = await site.popover('NBauschmann');
  const box = await site.page(UBUNTU);
  assert.ok(pop.querySelector('.hc-pp-members').textContent.includes(HOSTILE), 'the message is text');
  assert.ok(!pop.querySelector('.hc-pp-members').textContent.includes('more <b>'), 'the first line only');
  assert.ok(lab.querySelector('.hc-m-people').textContent.includes(HOSTILE), 'an unlinked name is text');
  assert.ok(box.querySelector('.hc-m-authors').textContent.includes(HOSTILE));
  assert.ok(!lab.querySelector('.hc-m-people').textContent.includes('@javascript'), 'a bad login is not a login');
  assertNoHostileElement(site.doc);
});

// ------------------------------------------------------------------ when, and when not
test('Editor on (body.hc-editor-on): nothing is read or drawn; Editor off decorates again', async () => {
  const site = await member();
  site.doc.body.classList.add('hc-editor-on');
  await site.lab();
  await site.popover('NBauschmann');
  assert.deepEqual(site.orgCalls(), []);
  assert.equal(site.members().length, 0);
  site.doc.body.classList.remove('hc-editor-on');
  site.observers.forEach((ob) => ob.fire());
  await settle();
  assert.ok(site.content.querySelector('.hc-m-people'), 'the next paint decorates');
});

test('the MutationObserver on #content decorates a surface the hook never announced', async () => {
  const site = await member();
  const ob = site.observers.find((x) => x.target === site.content);
  assert.ok(ob, 'observes #content');
  assert.equal(ob.options.childList, true);
  assert.equal(ob.options.subtree, true);
  // a second lab.js instance: its renders are not announced to js/editor.js
  const other = site.win.HCLab.createLab({ doc: site.doc, win: site.win, fetchJSON: site.win.HC.fetchJSON });
  site.content.replaceChildren();
  await other.renderLab(site.content, () => true);
  await settle();
  assert.equal(site.content.querySelector('.hc-m-people'), null, 'not yet: nothing heard');
  ob.fire();
  await settle();
  assert.ok(site.content.querySelector('.hc-m-people'));
  // a surface is decorated once, however often the observer fires
  ob.fire();
  ob.fire();
  await settle();
  assert.equal(site.content.querySelectorAll('.hc-m-people').length, 1);
});

test('sign-out removes every members node and the reader\'s cache', async () => {
  const site = await member();
  await site.lab();
  assert.ok(site.members().length > 0);
  assert.ok([...site.storage.raw.keys()].some((k) => k.startsWith('hc-org-cache:')));
  const signOut = site.doc.documentElement.querySelectorAll('[data-action="sign-out"]')[0];
  for (const fn of signOut.listeners.click || []) fn({ type: 'click', target: signOut, preventDefault() {} });
  await settle();
  assert.equal(site.members().length, 0);
  assert.equal(site.doc.documentElement.querySelectorAll('[data-hc-members-done]').length, 0);
  assert.ok(![...site.storage.raw.keys()].some((k) => k.startsWith('hc-org-cache:')));
  const before = site.calls.length;
  await site.lab();
  assert.equal(site.calls.length, before, 'signed out: no read');
  assert.equal(site.members().length, 0);
});

test('storage: only the reader\'s 15-minute cache, in sessionStorage; a repaint reads nothing again', async () => {
  const site = await member();
  await site.lab();
  await site.page(UBUNTU);
  const n = site.orgCalls().length;
  await site.lab();
  await site.page(UBUNTU);
  await site.popover('NBauschmann');
  assert.equal(site.orgCalls().length, n, 'cached for the session');
  const keys = [...site.storage.raw.keys()];
  keys.forEach((k) => assert.ok(k.startsWith('hc-org-cache:') || k === 'hc-editor', k));
  assert.equal(site.local.raw.size, 0, 'nothing in localStorage');
});

test('a guest never loads js/editor.js, and js/lab.js never asks GitHub', () => {
  const html = readRepo('index.html');
  assert.ok(!/src="js\/editor\.js"/.test(html), 'index.html does not load the editor');
  assert.ok(!/src="js\/cms-core\.js"/.test(html), 'index.html does not load the org reader');
  assert.ok(/src="js\/lab\.js"/.test(html), 'the public renderers are static');
  assert.ok(!/api\.github\.com/.test(readRepo('js/lab.js')));
  assert.ok(!/createOrgReader|data-hc-members/.test(readRepo('js/lab.js')), 'members-only code lives in js/editor.js');
});

test('the year view is read again once the reader\'s 15 minutes are over, not before', async () => {
  const site = await member();
  await site.lab();
  const n = site.orgCalls().length;
  site.later(14 * 60 * 1000);
  await site.lab();
  assert.equal(site.orgCalls().length, n, 'within 15 minutes: the same answers');
  site.later(2 * 60 * 1000);
  await site.lab();
  assert.equal(site.orgCalls().length, 2 * n, 'after 15 minutes: read again');
});

// ------------------------------------------------------------------ paging (fix1)
/* GitHub answers at most 100 commits a page. The reads follow page=2 and
   page=3 while a page is full, and stop at a short page; three full pages
   (300 commits) is the cap, and a count that reached it shows as
   "at least N" (there may be no 301st commit, so never "N+"). */
function commits(n, login, name, startDay, tag) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const t = Date.parse(`${startDay}T12:00:00Z`) - i * 3600 * 1000;
    out.push({ sha: `${tag}${String(i).padStart(6, '0')}${'e'.repeat(33)}`,
      commit: { author: { name, date: new Date(t).toISOString() }, message: `change ${i}` }, author: { login } });
  }
  return out;
}
const docsYear = (urls) => urls.filter((u) => /\/HippoCampusRobotics\/docs\/commits\?since=/.test(u));
const OLD_UBUNTU = 'docs/contents/raspberry_pi_setup/ubuntu_24.04_server_64bit.rst';
const HERE_UBUNTU = 'content/setup/raspberry-pi/ubuntu-24-04-server.md';

test('paging: the year view reads page 2 after a full page 1, stops at a short page, and sums both', async () => {
  const page1 = commits(60, 'NBauschmann', 'Nathalie Bauschmann', '2026-09-20', 'a')
    .concat(commits(40, 'FinnBreu', 'Finn Breuer', '2026-09-10', 'b'));
  const page2 = commits(7, 'NBauschmann', 'Nathalie Bauschmann', '2026-08-01', 'c');
  const site = await member({ extra: { orgCommits: { docs: { pages: [page1, page2] } } } });
  const lab = await site.lab();
  const urls = docsYear(site.orgCalls().map((c) => c.url));
  assert.deepEqual(urls, [
    `${API}/repos/HippoCampusRobotics/docs/commits?since=2025-10-01T00%3A00%3A00Z&per_page=100`,
    `${API}/repos/HippoCampusRobotics/docs/commits?since=2025-10-01T00%3A00%3A00Z&per_page=100&page=2`,
  ], 'page 2 after a full page 1, and never page 3 after a short page 2');
  const rows = lab.querySelectorAll('.hc-m-row')
    .map((r) => ['.nm', '.cnt', '.last'].map((c) => r.querySelector(c).textContent));
  assert.deepEqual(rows.slice(0, 2), [
    ['Nathalie Bauschmann', '67 commits', 'last active 2026-09-20'],
    ['Finn Breuer', '40 commits', 'last active 2026-09-10'],
  ]);
  assert.ok(!/\+/.test(lab.querySelector('.hc-m-people').textContent), 'nothing is capped');
});

test('paging: three full pages is the cap — "at least 300", no fourth page, and the page says so', async () => {
  const pages = [0, 1, 2, 3].map((p) => commits(100, 'NBauschmann', 'Nathalie Bauschmann', `2026-0${9 - p}-25`, String(p)));
  const site = await member({ extra: { orgCommits: { docs: { pages } } } });
  const lab = await site.lab();
  const urls = docsYear(site.orgCalls().map((c) => c.url));
  assert.equal(urls.length, 3, urls.join('\n'));
  assert.ok(urls[2].endsWith('&page=3'));
  assert.ok(!urls.some((u) => /page=4/.test(u)), 'never a fourth page');
  const row = lab.querySelector('.hc-m-row');
  assert.equal(row.querySelector('.cnt').textContent, 'at least 300 commits');
  assert.equal(row.querySelector('.last').textContent, 'last active 2026-09-25');
  assert.match(lab.querySelector('.hc-m-people').textContent,
    /Only the newest 300 commits were read for HippoCampusRobotics\/docs/);
  const pop = await site.popover('NBauschmann');
  assert.match(pop.querySelector('.hc-pp-members').textContent, /^at least 300 commits this year · last active 2026-09-25/);
  assert.match(pop.querySelector('.hc-pp-members').textContent, /Only the newest 300 commits were read/);
});

test('paging: who wrote this follows pages per read, and caps a read at 300 with "at least N"', async () => {
  const site = await member({ extra: {
    orgCommits: { [OLD_UBUNTU]: { pages: [commits(100, 'FinnBreu', 'Finn Breuer', '2025-02-20', 'a'),
      commits(3, 'FinnBreu', 'Finn Breuer', '2024-12-01', 'b')] } },
    repoCommits: { [HERE_UBUNTU]: { pages: [0, 1, 2].map((p) => commits(100, 'VincentTUHH', 'Vincent Lenz', `2026-0${9 - p}-25`, String(p))) } },
  } });
  const box = await site.page(UBUNTU);
  const urls = site.orgCalls().map((c) => c.url);
  const old = urls.filter((u) => u.includes(encodeURIComponent('contents/raspberry_pi_setup/ubuntu_24.04_server_64bit.rst')));
  assert.equal(old.length, 2, old.join('\n'));
  assert.ok(old[1].endsWith('&per_page=100&page=2'));
  const here = urls.filter((u) => u.includes(encodeURIComponent(HERE_UBUNTU)));
  assert.equal(here.length, 3, 'three pages, then the cap');
  assert.ok(here[2].endsWith('&per_page=100&page=3'));
  const lines = box.querySelectorAll('.hc-m-line').map((l) => l.textContent);
  assert.match(lines[0], /Finn Breuer — 103 commits, 2024-12-01 to 2025-02-20/);
  assert.ok(!/\+/.test(lines[0]), 'not capped');
  assert.match(lines[1], /^On this site: Vincent Lenz — at least 300 commits, /);
  assert.match(box.querySelector('.hc-m-authors').textContent,
    /Only the newest 300 commits of a file's history were read: a count that says "at least" may be higher\./);
});

// fix2: the capped wording, the per-page size, and a commit seen on two pages
test('paging: a history of exactly 300 commits says "at least 300", never "300+", on every surface', async () => {
  const pages = [0, 1, 2].map((p) => commits(100, 'NBauschmann', 'Nathalie Bauschmann', `2026-0${9 - p}-25`, String(p)));
  const site = await member({ extra: {
    orgCommits: { docs: { pages } },
    repoCommits: { [HERE_UBUNTU]: { pages: [0, 1, 2].map((p) => commits(100, 'VincentTUHH', 'Vincent Lenz', `2026-0${9 - p}-25`, String(p))) } },
  } });
  const lab = await site.lab();
  assert.equal(docsYear(site.orgCalls().map((c) => c.url)).length, 3, 'three pages, no fourth');
  const people = lab.querySelector('.hc-m-people').textContent;
  assert.equal(lab.querySelector('.hc-m-row').querySelector('.cnt').textContent, 'at least 300 commits');
  assert.match(people, /a count that says "at least" may be higher/);
  const pop = (await site.popover('NBauschmann')).querySelector('.hc-pp-members').textContent;
  assert.match(pop, /^at least 300 commits this year/);
  const box = (await site.page(UBUNTU)).querySelector('.hc-m-authors').textContent;
  assert.match(box, /Vincent Lenz — at least 300 commits, /);
  [people, pop, box].forEach((t) => assert.ok(!/\d\+/.test(t) && !/marked \+/.test(t), `no "N+" wording: ${t}`));
});

test('paging: a page that sends more than 100 rows counts only its first 100', async () => {
  const pages = [0, 1, 2, 3].map((p) => commits(1000, 'NBauschmann', 'Nathalie Bauschmann', `2026-0${9 - p}-25`, String(p)));
  const site = await member({ extra: { orgCommits: { docs: { pages } } } });
  const lab = await site.lab();
  assert.equal(docsYear(site.orgCalls().map((c) => c.url)).length, 3, 'still at most three pages');
  assert.equal(lab.querySelector('.hc-m-row').querySelector('.cnt').textContent, 'at least 300 commits');
});

test('paging: a commit that slid across a page edge (seen on two pages) counts once', async () => {
  // page 1 (say from the 15-minute cache) ends with a90..a99; fresh page 2 starts with them again
  const page1 = commits(100, 'NBauschmann', 'Nathalie Bauschmann', '2026-09-25', 'a');
  const page2 = page1.slice(90).concat(commits(90, 'NBauschmann', 'Nathalie Bauschmann', '2026-08-25', 'b'));
  const page3 = commits(5, 'NBauschmann', 'Nathalie Bauschmann', '2026-07-25', 'c').concat(page2.slice(0, 2));
  const site = await member({ extra: { orgCommits: { docs: { pages: [page1, page2, page3] } } } });
  const lab = await site.lab();
  assert.equal(docsYear(site.orgCalls().map((c) => c.url)).length, 3, 'a full page 2 still reads page 3');
  const row = lab.querySelector('.hc-m-row');
  assert.equal(row.querySelector('.cnt').textContent, '195 commits', '100 + 90 + 5: each sha once');
  assert.ok(!/at least/.test(lab.querySelector('.hc-m-people').textContent), 'a short page 3: not capped');
});

// ------------------------------------------------------------------ a replaced session (fix1, A1)
test('a session replaced without sign-out: the next read asks GitHub, never the first person\'s cache', async () => {
  const site = await member();
  await site.lab();
  const first = site.orgCalls().length;
  assert.ok(first > 0);
  // the same person again (a reload, a refresh): the cache answers
  await site.win.HCEditor.refresh();
  await settle();
  await site.lab();
  assert.equal(site.orgCalls().length, first, 'the same login keeps its cache');
  // someone else signs in over the live session
  C.writeSession(site.storage, C.makeSession('<yours>-second-token', null, 'someone-else', NOW));
  await site.win.HCEditor.refresh();
  await settle();
  await site.lab();
  const after = site.orgCalls().slice(first);
  assert.equal(after.length, first, 'every year read went to the network again');
  assert.ok(site.calls.some((c) => c.auth && ORG_RE.test(c.url)), 'with a token');
  assert.ok(site.content.querySelector('.hc-m-people'));
});

test('a session replaced while the first person\'s reads are in flight: their answers are not kept', async () => {
  const site = await member();
  const held = [];
  const real = site.win.fetch;
  site.win.fetch = (url, init) => (ORG_RE.test(String(url))
    ? new Promise((resolve) => held.push(() => resolve(real(url, init)))) : real(url, init));
  await site.lab();
  const firsts = held.splice(0);
  assert.ok(firsts.length > 0, 'the first person\'s year reads are waiting');
  C.writeSession(site.storage, C.makeSession('<yours>-second-token', null, 'someone-else', NOW));
  await site.win.HCEditor.refresh();
  await settle();
  firsts.forEach((go) => go());          // the first person's answers land now (the second's still wait)
  await settle();
  const answers = [...site.storage.raw.keys()].filter((k) => k.startsWith('hc-org-cache:https:'));
  assert.deepEqual(answers, [], 'nothing the first session read is kept for the second');
  site.win.fetch = real;
  held.splice(0).forEach((go) => go());
  await settle();
  assert.ok([...site.storage.raw.keys()].some((k) => k.startsWith('hc-org-cache:https:')),
    'the second person\'s own answers are kept');
  assert.ok(site.content.querySelector('.hc-m-people'), 'and drawn');
});

test('a session login that is not a GitHub login: no cache marker, and the cache is dropped', async () => {
  const site = await member();
  await site.lab();
  assert.equal(site.storage.raw.get('hc-org-cache:login'), 'kyle-nelson-berkeley', 'a real login is the marker');
  assert.ok([...site.storage.raw.keys()].some((k) => k.startsWith('hc-org-cache:https:')));
  for (const bad of ['not a login', '-leading-dash', 'x'.repeat(40), 'a/b', 'hc-org-cache:https://x']) {
    C.writeSession(site.storage, C.makeSession('<yours>-second-token', null, bad, NOW));
    const before = site.orgCalls().length;
    await site.win.HCEditor.refresh();
    await settle();
    assert.ok(!site.storage.raw.has('hc-org-cache:login'), `no marker for ${JSON.stringify(bad)}`);
    await site.lab();
    assert.ok(site.orgCalls().length > before, `no cached answer is served (${JSON.stringify(bad)})`);
    assert.ok(site.content.querySelector('.hc-m-people'), 'and the read is drawn');
  }
});
