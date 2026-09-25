// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 21 September 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test the CMS editor: page tree, raw-JSON registry guards, drafts, snippets, live preview, Propose.
/* Unit tests for the editor half of js/cms-core.js (U7b) and for js/cms.js's
   editor views, run in a vm context over a fake DOM and a fake GitHub.

   Pure logic first: the page tree against today's registries, the page id
   <-> file <-> site route maps, located JSON errors (line and column), the
   locked-id rule, snippets and the internal link picker, the draft store
   (memory + sessionStorage, every access guarded), the new-project and
   new-person drafts, branch-name slugging, the forbidden paths, the tree
   entries, the PR body, and the Propose sequence (Git Data API: blobs -> one
   tree -> one commit -> one ref -> one PR; adding to my own proposal = one
   more commit + a ref move).

   Then js/cms.js itself: the page tree view, the editor (a heading change
   reaches the sandboxed preview through the bridge, with a fresh nonce per
   reload), the raw-JSON editor refusing a trailing comma and an id change,
   the read-only view, the leave-with-a-draft question, and Propose from the
   page to #/review/<n>.

   No browser, no network: every window, frame and fetch is a FAKE, and every
   token below is an obvious placeholder.

     node --test tools/tests/test_cms_editor.mjs
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

const readRepo = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const REGS = {
  setup: JSON.parse(readRepo('data/setup.json')),
  projects: JSON.parse(readRepo('data/projects.json')),
  tools: JSON.parse(readRepo('data/tools.json')),
};
const TOKEN = '<yours>-editor-token';
const REPO_API = 'https://api.github.com/repos/desert-mango/hippocampus-docs';
const MAIN_SHA = '1'.repeat(40);
const MAIN_TREE = '2'.repeat(40);

// ------------------------------------------------------------ page tree --

test('page tree: exactly the registries\' pages — every setup page, project, tool, and About', () => {
  const setupIds = REGS.setup.sections.flatMap((s) => s.pages.map((p) => `setup/${p.id}`));
  const projectIds = REGS.projects.projects.map((p) => `project/${p.id}`);
  const toolIds = REGS.tools.tools.map((t) => `tool/${t.id}`);
  const list = C.pageList(REGS);
  assert.deepEqual(list.map((p) => p.pageId), [...setupIds, ...projectIds, ...toolIds, 'about']);
  // today's counts, as the report states them
  assert.deepEqual([setupIds.length, projectIds.length, toolIds.length], [71, 17, 3]);
  for (const p of list) {
    assert.equal(p.file, C.editPath(p.pageId, REGS), p.pageId);
    assert.equal(C.pageIdForFile(p.file, REGS), p.pageId, `${p.file} maps back`);
    assert.equal(C.routeForPage(p.pageId, REGS), p.route, p.pageId);
    assert.ok(typeof p.title === 'string' && p.title, p.pageId);
  }
  assert.equal(C.routeForPage('setup/bluerov/dvl', REGS), '/setup/bluerov/dvl');
  assert.equal(C.routeForPage('about', REGS), '/about');
  const tree = C.pageTree(REGS);
  assert.deepEqual(tree.map((g) => g.key).filter((k, i, a) => a.indexOf(k) === i),
    ['setup', 'projects', 'tools', 'about', 'registries']);
  assert.equal(tree.filter((g) => g.key === 'setup').length, REGS.setup.sections.length);
  const regs = tree.find((g) => g.key === 'registries').pages;
  assert.deepEqual(regs.map((p) => p.pageId), ['data/people', 'data/projects', 'data/site', 'data/tools']);
  assert.deepEqual(regs.map((p) => p.file), C.RAW_REGISTRIES);
  assert.deepEqual(regs.map((p) => p.route), ['/about', '/projects', '/', '/tools']);
});

test('page tree: a broken or missing registry lists nothing from it, never a guessed page', () => {
  const tree = C.pageList({ setup: { sections: 'x' }, projects: null,
    tools: { tools: [{ id: '../x', file: 'content/tools/x.md' }, { id: 'ok', file: 'js/app.js' }] } });
  assert.deepEqual(tree.map((p) => p.pageId), ['about']);
  assert.equal(C.pageIdForFile('js/app.js', REGS), null);
  assert.equal(C.pageIdForFile('data/people.json', REGS), 'data/people');
  assert.equal(C.pageIdForFile('data/setup.json', REGS), null, 'setup.json is not a raw-JSON editor');
  assert.equal(C.editKind('data/people'), 'registry');
  assert.equal(C.editKind('data/setup'), null);
  assert.equal(C.editKind('about'), 'page');
});

// ---------------------------------------------------------- strict JSON --

test('JSON problems carry line and column, in words, for the two rules that bite', () => {
  assert.equal(C.jsonProblem('{"a": [1, 2]}\n'), null);
  const trailing = C.jsonProblem('{\n  "a": 1,\n  "b": 2,\n}\n');
  assert.deepEqual([trailing.line, trailing.column], [3, 9]);
  assert.match(trailing.message, /trailing comma/);
  const inList = C.jsonProblem('[\n 1,\n 2,\n]');
  assert.deepEqual([inList.line, inList.column], [3, 3]);
  assert.match(inList.message, /trailing comma/);
  const single = C.jsonProblem("{\n  'a': 1\n}");
  assert.deepEqual([single.line, single.column], [2, 3]);
  assert.match(single.message, /double quotes/);
  const singleValue = C.jsonProblem('{"a": \'x\'}');
  assert.deepEqual([singleValue.line, singleValue.column], [1, 7]);
  assert.match(singleValue.message, /double quotes/);
  for (const [bad, line, column] of [['{"a" 1}', 1, 6], ['{"a": 1 "b": 2}', 1, 9], ['', 1, 1],
    ['{"a": tru}', 1, 7], ['{"a": 1}}', 1, 9], ['{"a": "x\ny"}', 1, 9], ['{"a": 01}', 1, 8], ['[1,]', 1, 3]]) {
    const p = C.jsonProblem(bad);
    assert.ok(p, JSON.stringify(bad));
    assert.deepEqual([p.line, p.column], [line, column], JSON.stringify(bad));
  }
  assert.equal(C.jsonProblemText('data/tools.json', trailing),
    `data/tools.json, line 3, column 9: ${trailing.message} (strict JSON — no trailing commas, double quotes)`);
  // every registry on main parses clean through the same helper
  for (const f of C.RAW_REGISTRIES) assert.equal(C.jsonProblem(readRepo(f)), null, f);
});

test('locked ids: a draft that drops or renames an existing id is refused with the rule\'s words', () => {
  assert.equal(C.ID_RULE_TEXT, 'renaming or removing an existing id needs Desert Mango — open an issue');
  const before = readRepo('data/projects.json');
  const ids = C.lockedIds('data/projects.json', JSON.parse(before));
  assert.equal(ids.length, 17);
  assert.equal(C.registryDraftProblem('data/projects.json', before, before), null);
  const renamed = before.replace('"id": "uvms"', '"id": "uvms-2"');
  assert.notEqual(renamed, before);
  const p = C.registryDraftProblem('data/projects.json', before, renamed);
  assert.equal(p.kind, 'id');
  assert.equal(p.message, `data/projects.json: 'uvms' was removed or renamed — ${C.ID_RULE_TEXT}`);
  const doc = JSON.parse(before);
  doc.projects = doc.projects.filter((x) => x.id !== 'uvms');
  assert.match(C.registryDraftProblem('data/projects.json', before, JSON.stringify(doc)).message, /'uvms' was removed/);
  // a new entry with a new id, or a changed name, is fine
  const grown = JSON.parse(before);
  grown.projects.push(Object.assign({}, grown.projects[0], { id: 'brand-new' }));
  grown.projects[0].name = 'Renamed title, same id';
  assert.equal(C.registryDraftProblem('data/projects.json', before, JSON.stringify(grown)), null);
  // a copied entry that keeps an existing id is refused: a new entry needs a new id
  const copied = JSON.parse(before);
  copied.projects.push(Object.assign({}, copied.projects[2]));
  const twice = C.registryDraftProblem('data/projects.json', before, JSON.stringify(copied));
  assert.equal(twice.kind, 'id');
  assert.equal(twice.message, `data/projects.json: the id '${copied.projects[2].id}' is used twice — a new entry needs a new id`);
  const people = JSON.parse(readRepo('data/people.json'));
  people.groups.push({ id: 'new-group', title: 'X', people: [] }, { id: 'new-group', title: 'Y', people: [] });
  assert.match(C.registryDraftProblem('data/people.json', readRepo('data/people.json'), JSON.stringify(people)).message,
    /'new-group' is used twice/);
  // people: group ids are the locked ids; tools: tool ids; site: none
  assert.deepEqual(C.lockedIds('data/people.json', JSON.parse(readRepo('data/people.json'))),
    JSON.parse(readRepo('data/people.json')).groups.map((g) => g.id));
  assert.deepEqual(C.lockedIds('data/tools.json', REGS.tools), REGS.tools.tools.map((t) => t.id));
  assert.deepEqual(C.lockedIds('data/site.json', {}), []);
  // strict JSON comes first, located
  const bad = C.registryDraftProblem('data/tools.json', readRepo('data/tools.json'), '{"tools": [],}');
  assert.equal(bad.kind, 'json');
  assert.match(bad.message, /^data\/tools\.json, line 1, column 13: .*trailing comma/);
});

test('formatLike: today\'s projects and people registries round-trip byte for byte', () => {
  for (const f of ['data/projects.json', 'data/people.json']) {
    const t = readRepo(f);
    assert.equal(C.formatLike(t, JSON.parse(t)), t, f);
  }
});

// ------------------------------------------------------------- snippets --

test('snippets: note, warning and tabs in the site\'s dialect, wrapped around the selection', () => {
  assert.deepEqual(Object.keys(C.SNIPPETS), ['note', 'warning', 'tabs']);
  const note = C.insertSnippet('Intro.\nMore', 7, 11, 'note');
  assert.equal(note.text, 'Intro.\n\n<div class="adm adm-note"><p class="adm-title">Note</p>\n\nMore\n\n</div>\n');
  assert.equal(note.text.slice(note.selStart, note.selEnd), 'More');
  const warn = C.insertSnippet('', 0, 0, 'warning');
  assert.ok(warn.text.startsWith('<div class="adm adm-warning"><p class="adm-title">Warning</p>\n\n'));
  assert.equal(warn.text.slice(warn.selStart, warn.selEnd), C.SNIPPETS.warning.placeholder);
  const tabs = C.insertSnippet('A\n\nB', 2, 2, 'tabs');
  assert.ok(tabs.text.startsWith('A\n\n<div class="tabs">\n\n<div class="tab" data-label="First">\n\n'));
  assert.ok(tabs.text.endsWith('</div>\n\n</div>\n\nB'));
  assert.throws(() => C.insertSnippet('x', 0, 0, 'script'), /no such snippet/);
  const page = C.pageList(REGS).find((p) => p.pageId === 'setup/bluerov/dvl');
  assert.equal(C.linkMarkdown(page, ''), `[${page.title}](#/setup/bluerov/dvl)`);
  assert.equal(C.linkMarkdown(page, 'the [DVL]'), '[the DVL](#/setup/bluerov/dvl)');
});

// --------------------------------------------------------------- drafts --

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    raw: m,
  };
}

const draftOf = (key, file, original, text, base) => ({ key, label: key, route: '/about',
  files: { [file]: text }, originals: { [file]: original }, base: base || { ref: 'main', sha: MAIN_SHA, number: null } });

test('drafts: kept in memory and in sessionStorage, keyed by page; broken storage never throws', () => {
  const s = memoryStorage();
  const a = C.createDraftStore(s);
  a.put(draftOf('about', 'content/about.md', 'Old\n', 'New\n'));
  a.put(draftOf('tool/runpod-mcp', 'content/tools/runpod-mcp.md', 'Same\n', 'Same\n'));
  assert.equal(a.list().length, 2);
  assert.deepEqual(a.dirty().map((d) => d.key), ['about']);
  const b = C.createDraftStore(s);                // a reload of the tab
  assert.equal(b.get('about').files['content/about.md'], 'New\n');
  b.remove('about');
  assert.equal(C.createDraftStore(s).get('about'), null);
  // garbage, or storage that throws, is an empty store that still works in memory
  s.setItem(C.DRAFTS_KEY, '{not json');
  assert.equal(C.createDraftStore(s).list().length, 0);
  s.setItem(C.DRAFTS_KEY, JSON.stringify([{ key: 'x', files: { 'a.md': 1 } }, 'y']));
  assert.equal(C.createDraftStore(s).list().length, 0, 'malformed drafts are dropped');
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('x'); } };
  const c = C.createDraftStore(throwing);
  assert.equal(c.put(draftOf('about', 'content/about.md', 'a', 'b')), false, 'not persisted, but kept');
  assert.equal(c.get('about').files['content/about.md'], 'b');
  assert.equal(C.createDraftStore(null).list().length, 0);
  assert.equal(C.isDirty(draftOf('k', 'content/about.md', null, '')), true, 'a new file is a change');
});

// ------------------------------------------------ js/cms.js in a fake page --

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.ownText = '';
    this.attrs = {};
    this.hidden = false;
    this.disabled = false;
    this.readOnly = false;
    this.className = '';
    this.dataset = {};
    this.listeners = {};
    this.value = '';
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.parent = null;
    if (this.tagName === 'IFRAME') {
      const frame = this;
      this.posted = [];
      this.srcs = [];
      this.contentWindow = { postMessage(m) { frame.posted.push(m); } };
    }
    const classes = new Set();
    this.classList = {
      toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    };
  }
  get textContent() { return this.ownText + this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(t) { this.ownText = String(t); this.childNodes = []; }
  set src(u) { this.srcs.push(u); this.attrs.src = u; }
  get src() { return this.attrs.src; }
  appendChild(c) { this.childNodes.push(c); c.parent = this; return c; }
  replaceChildren(...cs) { this.ownText = ''; this.childNodes = cs; cs.forEach((c) => { c.parent = this; }); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  querySelectorAll() { return []; }
  remove() { if (this.parent) this.parent.childNodes = this.parent.childNodes.filter((c) => c !== this); }
  focus() {}
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
  fire(type) { for (const fn of this.listeners[type] || []) fn({ type, target: this, preventDefault() {} }); }
  click() { if (!this.disabled) this.fire('click'); }
}

function findAll(node, pred, out = []) {
  if (node && node.tagName && pred(node)) out.push(node);
  for (const c of (node && node.childNodes) || []) findAll(c, pred, out);
  return out;
}

function reply(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 60; i += 1) await tick(); };

/* GitHub for the editor: `login` with `perms`; `refs` maps branch -> head
   sha; `commits` maps sha -> tree sha; `contents` maps "<path>@<sha>" ->
   text; `pulls` is the open-PR list; `onWrite(method, url, body)` answers
   every write. */
function editorGithub(o) {
  return (url, init) => {
    const method = init.method || 'GET';
    if (method !== 'GET') return o.onWrite(method, url, JSON.parse(init.body));
    if (url === 'https://api.github.com/user') return reply(200, { login: o.login });
    if (url === REPO_API) return reply(200, { permissions: o.perms });
    const rest = url.slice(REPO_API.length);
    if (rest.startsWith('/pulls?state=open')) return reply(200, o.pulls || []);
    let m = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
    if (m) return o.refs[m[1]] ? reply(200, { ref: `refs/heads/${m[1]}`, object: { sha: o.refs[m[1]], type: 'commit' } })
      : reply(404, { message: 'Not Found' });
    m = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest);
    if (m && o.commits[m[1]]) return reply(200, { sha: m[1], tree: { sha: o.commits[m[1]] } });
    m = /^\/contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(rest);
    if (m && o.contents[`${decodeURIComponent(m[1])}@${m[2]}`] !== undefined) {
      return reply(200, o.contents[`${decodeURIComponent(m[1])}@${m[2]}`]);
    }
    return reply(404, { message: 'Not Found' });
  };
}

/* Runs js/cms-core.js and js/cms.js in a fresh vm context standing in for
   cms/index.html, with HC.fetchJSON reading this repository's registries. */
function openEditor(opts) {
  const ids = ['cms-main', 'cms-notice', 'cms-sign-in', 'cms-sign-out', 'cms-who', 'cms-nav'];
  const els = Object.fromEntries(ids.map((id) => [id, new FakeElement('div')]));
  const storage = opts.storage || memoryStorage();
  C.writeSession(storage, C.makeSession(TOKEN, null, opts.login || 'bob', Date.now()));
  const calls = [];
  const listeners = {};
  const confirms = [];
  const created = [];
  const location = { origin: 'https://docs.example.org', hash: opts.hash || '#/' };
  const win = vm.createContext({
    document: {
      getElementById: (id) => els[id] || null,
      createElement: (tag) => { const e = new FakeElement(tag); created.push(e); return e; },
      createTextNode: (text) => ({ textContent: String(text) }),
      documentElement: new FakeElement('html'),
    },
    sessionStorage: storage,
    localStorage: memoryStorage(),
    location,
    crypto: { getRandomValues: (arr) => { for (let i = 0; i < arr.length; i += 1) arr[i] = Math.floor(Math.random() * 256); return arr; } },
    fetch: (url, init) => {
      calls.push({ url: String(url), init: init || {}, method: (init && init.method) || 'GET',
        body: init && init.body ? JSON.parse(init.body) : undefined });
      return Promise.resolve(opts.github(String(url), init || {}));
    },
    open: () => null,
    confirm: (text) => { confirms.push(text); return opts.confirm !== undefined ? opts.confirm : true; },
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    HC: { fetchJSON: async (p) => JSON.parse(readRepo(p.replace(/^\.\.\//, ''))) },
    setInterval, clearInterval, clearTimeout,
    // the preview's debounce runs at once here
    setTimeout: (fn) => setTimeout(fn, 0),
  });
  win.window = win;
  for (const f of ['cms-core.js', 'cms.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), win, { filename: f });
  }
  const main = els['cms-main'];
  const page = {
    els, calls, win, storage, confirms, listeners, location, created,
    main: () => main.textContent,
    all: (pred) => findAll(main, pred),
    one: (pred) => findAll(main, pred)[0],
    byData: (k, v) => findAll(main, (e) => e.attrs[`data-${k}`] === v)[0],
    textarea: () => findAll(main, (e) => e.tagName === 'TEXTAREA' && e.attrs['data-editor'] !== undefined)[0],
    frames: () => created.filter((e) => e.tagName === 'IFRAME'),
    writes: () => calls.filter((c) => c.method !== 'GET'),
    async go(hash) {
      location.hash = hash;
      for (const fn of listeners.hashchange || []) fn();
      await settle();
    },
    async type(el, text) {
      el.value = text;
      el.fire('input');
      await settle();
    },
  };
  return page;
}

const SETUP_PAGE = REGS.setup.sections[0].pages[0];
const SETUP_FILE = SETUP_PAGE.file;
const SETUP_TEXT = readRepo(SETUP_FILE);

function baseGithub(extra) {
  return Object.assign({
    login: 'bob', perms: { push: true },
    refs: { main: MAIN_SHA }, commits: { [MAIN_SHA]: MAIN_TREE },
    contents: {
      [`${SETUP_FILE}@${MAIN_SHA}`]: SETUP_TEXT,
      [`data/projects.json@${MAIN_SHA}`]: readRepo('data/projects.json'),
      [`data/people.json@${MAIN_SHA}`]: readRepo('data/people.json'),
    },
    onWrite: () => reply(500, { message: 'no writes expected' }),
  }, extra || {});
}

/* Ask the frame's current load for `p` as the site would, and return the
   answer the page posted back. */
async function frameAsks(page, p) {
  const frame = page.frames().at(-1);
  const nonce = /#preview=([A-Za-z0-9_-]+)/.exec(frame.srcs.at(-1))[1];
  const id = frame.posted.length + 1;
  for (const fn of page.listeners.message || []) {
    fn({ source: frame.contentWindow, origin: 'null', data: { type: 'hc-fetch', nonce, id, path: p } });
  }
  await settle();
  return frame.posted.find((m) => m.id === id);
}

test('js/cms.js page tree (#/pages): one edit link per page and registry, plus New project / New person', async () => {
  const page = openEditor({ hash: '#/pages', github: editorGithub(baseGithub()) });
  await settle();
  const links = page.all((e) => e.tagName === 'A' && /^#\/edit\//.test(e.attrs.href || ''));
  const want = [...C.pageList(REGS), ...C.pageTree(REGS).find((g) => g.key === 'registries').pages];
  assert.deepEqual(links.map((a) => a.attrs.href), want.map((p) => `#/edit/${p.pageId}`));
  assert.ok(page.one((e) => e.attrs.href === '#/new/project'));
  assert.ok(page.one((e) => e.attrs.href === '#/new/person'));
});

test('js/cms.js editor: a heading change reaches the preview frame through the draft, fresh nonce per reload', async () => {
  const page = openEditor({ hash: `#/edit/setup/${SETUP_PAGE.id}`, github: editorGithub(baseGithub()) });
  await settle();
  const ta = page.textarea();
  assert.equal(ta.value, SETUP_TEXT, 'the file at main\'s head');
  assert.equal(ta.readOnly, false);
  const frame = page.frames().at(-1);
  assert.match(frame.srcs[0], new RegExp(`^\\.\\./index\\.html#preview=[0-9a-f]{32}&route=${encodeURIComponent(`/setup/${SETUP_PAGE.id}`)}$`));
  assert.equal(frame.attrs.sandbox, 'allow-scripts allow-popups');
  const before = await frameAsks(page, SETUP_FILE);
  assert.equal(before.text, SETUP_TEXT);
  const edited = SETUP_TEXT.replace(/^(#+ .*)$/m, '$1 (edited)');
  assert.notEqual(edited, SETUP_TEXT);
  await page.type(ta, edited);
  assert.equal(frame.srcs.length, 2, 'the frame reloaded once for the change');
  assert.notEqual(frame.srcs[1], frame.srcs[0], 'with a fresh nonce');
  const after = await frameAsks(page, SETUP_FILE);
  assert.equal(after.text, edited, 'the frame is served the draft');
  const other = await frameAsks(page, 'data/projects.json');
  assert.equal(other.text, readRepo('data/projects.json'), 'everything else comes from main\'s head');
  // the draft is in sessionStorage, keyed by the page
  const kept = C.createDraftStore(page.storage).get(`setup/${SETUP_PAGE.id}`);
  assert.equal(kept.files[SETUP_FILE], edited);
  assert.equal(kept.base.sha, MAIN_SHA);
  assert.deepEqual(page.writes(), [], 'editing writes nothing to GitHub');
  // no token in anything the frame received or in its URL
  for (const m of frame.posted) assert.ok(!JSON.stringify(m).includes(TOKEN));
  for (const u of frame.srcs) assert.ok(!u.includes(TOKEN));
});

test('js/cms.js editor: snippet buttons and the internal link picker insert into the draft', async () => {
  const page = openEditor({ hash: `#/edit/setup/${SETUP_PAGE.id}`, github: editorGithub(baseGithub()) });
  await settle();
  const ta = page.textarea();
  ta.selectionStart = ta.selectionEnd = 0;
  page.byData('snippet', 'note').click();
  await settle();
  assert.ok(ta.value.startsWith('<div class="adm adm-note"><p class="adm-title">Note</p>'));
  const picker = page.one((e) => e.tagName === 'SELECT' && e.attrs['data-link-picker'] !== undefined);
  picker.value = 'setup/bluerov/dvl';
  ta.selectionStart = ta.selectionEnd = 0;
  page.byData('snippet', 'link').click();
  await settle();
  assert.ok(ta.value.startsWith('[DVL](#/setup/bluerov/dvl)') || /^\[[^\]]+\]\(#\/setup\/bluerov\/dvl\)/.test(ta.value));
  const media = page.byData('action', 'media-open');
  assert.ok(media && !media.disabled, 'Image from Media is live (U9; tools/tests/test_cms_media.mjs covers it)');
  assert.ok(C.createDraftStore(page.storage).get(`setup/${SETUP_PAGE.id}`).files[SETUP_FILE].includes('adm-note'));
});

test('js/cms.js raw-JSON editor: a trailing comma is refused with line and column; an id change with the rule', async () => {
  const page = openEditor({ hash: '#/edit/data/projects', github: editorGithub(baseGithub()) });
  await settle();
  const ta = page.textarea();
  const original = readRepo('data/projects.json');
  assert.equal(ta.value, original);
  assert.match(page.main(), /Locked ids/);
  assert.match(page.main(), /hippocampus-vehicle/);
  const frame = page.frames().at(-1);
  const loads = frame.srcs.length;
  await page.type(ta, original.replace('"repo_count": 94\n', '"repo_count": 94,\n'));
  const problem = page.one((e) => e.attrs['data-problem'] !== undefined);
  assert.match(problem.textContent, /^data\/projects\.json, line \d+, column \d+: .*trailing comma/);
  assert.equal(problem.hidden, false);
  assert.equal(frame.srcs.length, loads, 'a broken registry is not previewed');
  assert.equal(page.byData('action', 'propose').disabled, true);
  await page.type(ta, original.replace('"id": "uvms"', '"id": "uvms-renamed"'));
  assert.match(problem.textContent, /'uvms' was removed or renamed — renaming or removing an existing id needs Desert Mango — open an issue/);
  assert.equal(page.byData('action', 'propose').disabled, true);
  await page.type(ta, original.replace('"repo_count": 94', '"repo_count": 95'));
  assert.equal(problem.hidden, true);
  assert.equal(page.byData('action', 'propose').disabled, false);
  assert.equal(frame.srcs.length, loads + 1, 'a valid draft is previewed');
});

test('js/cms.js editor: Read-only sees the page and its preview, view-only, with the pencil link', async () => {
  const page = openEditor({ hash: `#/edit/setup/${SETUP_PAGE.id}`,
    github: editorGithub(baseGithub({ perms: { pull: true } })) });
  await settle();
  const ta = page.textarea();
  assert.equal(ta.readOnly, true);
  assert.equal(page.byData('action', 'propose'), undefined);
  assert.equal(page.byData('snippet', 'note'), undefined);
  assert.ok(page.one((e) => e.attrs.href === C.pencilUrl(SETUP_FILE)), 'the pencil link');
  assert.equal(page.frames().length, 1, 'the preview still shows main');
});

test('js/cms.js editor: leaving a page with a draft that is not proposed asks first', async () => {
  const page = openEditor({ hash: '#/edit/about', confirm: false,
    github: editorGithub(baseGithub({ contents: { [`content/about.md@${MAIN_SHA}`]: 'About.\n' } })) });
  await settle();
  await page.go('#/review');                          // no change yet: no question
  assert.equal(page.confirms.length, 0);
  await page.go('#/edit/about');
  await page.type(page.textarea(), 'About, changed.\n');
  await page.go('#/review');
  assert.equal(page.confirms.length, 1);
  assert.match(page.confirms[0], /not proposed/);
  assert.equal(page.location.hash, '#/edit/about', 'cancel stays on the page');
  const unload = { preventDefault() { this.prevented = true; }, returnValue: undefined };
  for (const fn of page.listeners.beforeunload || []) fn(unload);
  assert.equal(unload.prevented, true, 'closing the tab with a draft asks too');
});

// ------------------------------------------------ Propose: pure helpers --

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);       // 21 September 2026, UTC

test('branch names: cms/<login>/<slug>-<yymmdd>, slugged to lowercase letters, digits and dashes', () => {
  assert.equal(C.slugify('Fix the DVL heading!'), 'fix-the-dvl-heading');
  assert.equal(C.slugify('  Größe & Maße — ÄÖÜ café  '), 'grosse-masse-aou-cafe', 'ß -> ss, accents stripped');
  assert.equal(C.slugify('???'), '');
  assert.equal(C.slugify('a'.repeat(30) + ' ' + 'b'.repeat(30)).length <= 40, true);
  assert.ok(!/-$/.test(C.slugify('word '.repeat(20))), 'never ends in a dash after the cut');
  assert.equal(C.proposalBranch('Bob-Lab', 'Fix the DVL heading', NOW), 'cms/bob-lab/fix-the-dvl-heading-260921');
  assert.equal(C.proposalBranch('bob', '', NOW), 'cms/bob/edit-260921', 'an empty summary still names a branch');
  assert.equal(C.proposalBranch('bob', 'x', Date.UTC(2027, 0, 2, 23, 59)), 'cms/bob/x-270102', 'the date is UTC');
  assert.throws(() => C.proposalBranch('', 'x', NOW), /login/);
  for (const b of ['cms/bob/fix-260921', 'cms/bob/fix-260921-2', 'cms/Bob.x/a_b']) assert.equal(C.isProposalBranch(b), true, b);
  for (const b of ['main', 'refs/heads/cms/bob/x', 'cms/bob', 'cms//x', 'cms/bob/../main', 'feature/x', 'cms/bob/x/',
    'cms/bob/x.lock', 'cms/bob/.x', '', null]) assert.equal(C.isProposalBranch(b), false, String(b));
});

test('forbidden paths: the editor writes only content/*.md and data/*.json, never the machinery or derived files', () => {
  for (const ok of ['content/about.md', 'content/setup/bluerov/dvl.md', 'data/people.json', 'data/projects.json']) {
    assert.equal(C.proposalPathProblem(ok), null, ok);
  }
  for (const bad of ['search/site.json', 'data/graph/nodes.json', 'js/app.js', 'css/site.css', 'tools/check.py',
    'api/auth.js', '.github/workflows/check.yml', 'cms/index.html', 'index.html', 'vercel.json', 'README.md',
    'assets/hippo.svg', '/content/about.md', 'content/../js/app.js', 'content/./about.md', 'content\\about.md',
    'content//about.md', 'content/about.txt', 'data/x.md', '', null]) {
    assert.ok(C.proposalPathProblem(bad), String(bad));
  }
  assert.match(C.proposalPathProblem('js/app.js'), /never/);
  const sha = (c) => c.repeat(40);
  assert.deepEqual(C.treeEntries({ 'data/people.json': sha('b'), 'content/about.md': sha('a') }), [
    { path: 'content/about.md', mode: '100644', type: 'blob', sha: sha('a') },
    { path: 'data/people.json', mode: '100644', type: 'blob', sha: sha('b') },
  ], 'one entry per changed path, sorted');
  assert.throws(() => C.treeEntries({ 'js/app.js': sha('a') }), /never/);
  assert.throws(() => C.treeEntries({ 'content/about.md': 'nope' }), /blob/);
  assert.throws(() => C.treeEntries({}), /nothing/);
});

test('PR body: summary, the pages, "Made in the site editor.", and the review link once it is known', () => {
  const pages = [{ label: 'DVL', file: 'content/setup/bluerov/dvl.md' }, { label: 'About', file: 'content/about.md' }];
  const body = C.prBody({ summary: 'Fix the DVL heading', pages });
  assert.equal(body, 'Fix the DVL heading\n\nPages:\n- DVL (`content/setup/bluerov/dvl.md`)\n- About (`content/about.md`)\n\n'
    + 'Made in the site editor.\n');
  const linked = C.prBody({ summary: 'Fix', pages, reviewUrl: 'https://docs.example.org/cms/#/review/42' });
  assert.ok(linked.endsWith('Made in the site editor.\nReview it in the editor: https://docs.example.org/cms/#/review/42\n'));
  assert.equal(C.reviewUrl('https://docs.example.org', 42), 'https://docs.example.org/cms/#/review/42');
});

test('new project: exactly two files — the registry entry with the six keys, and content/projects/<id>.md', () => {
  const text = readRepo('data/projects.json');
  const form = { id: 'sonar-rig', name: 'Sonar rig', status: 'active', tagline: 'A tank rig for sonar tests.',
    repos: 'sonar_rig\n\n  sonar-rig-cad  \n', story: '## What it is\n\nA rig.' };
  const out = C.newProjectDraft(form, text);
  assert.equal(out.problem, null);
  assert.equal(out.id, 'sonar-rig');
  assert.deepEqual(Object.keys(out.files).sort(), ['content/projects/sonar-rig.md', 'data/projects.json']);
  assert.equal(out.files['content/projects/sonar-rig.md'], '## What it is\n\nA rig.\n');
  const doc = JSON.parse(out.files['data/projects.json']);
  const entry = doc.projects.at(-1);
  assert.deepEqual(Object.keys(entry), ['id', 'name', 'status', 'tagline', 'file', 'repos']);
  assert.deepEqual(entry.repos, [
    { name: 'sonar_rig', url: 'https://github.com/HippoCampusRobotics/sonar_rig' },
    { name: 'sonar-rig-cad', url: 'https://github.com/HippoCampusRobotics/sonar-rig-cad' }]);
  assert.equal(entry.file, 'content/projects/sonar-rig.md');
  // the only change to the registry is the added entry
  const before = JSON.parse(text);
  before.projects.push(entry);
  assert.equal(out.files['data/projects.json'], C.formatLike(text, before));
  assert.equal(C.registryDraftProblem('data/projects.json', text, out.files['data/projects.json']), null);
  const listed = REGS.projects.projects[0].repos.find((r) => !r.external).name;
  const bad = (patch, re) => {
    const o = C.newProjectDraft(Object.assign({}, form, patch), text);
    assert.match(String(o.problem), re, JSON.stringify(patch));
    assert.equal(o.files, null);
  };
  bad({ id: 'Sonar Rig' }, /id/);
  bad({ id: REGS.projects.projects[0].id }, /already/);
  bad({ name: '  ' }, /name/);
  bad({ status: 'shiny' }, /status/);
  bad({ tagline: '' }, /tagline/);
  bad({ repos: listed }, new RegExp(`${listed}.*already`));
  bad({ repos: 'a b' }, /repo/);
  bad({ repos: 'x\nx' }, /twice/);
  assert.match(C.newProjectDraft(form, '{"projects": [1,]}').problem, /line 1, column/);
  assert.match(C.newProjectDraft(form, '{"projects": 5}').problem, /projects/);
  assert.equal(C.PROJECT_STATUSES.join(','), 'active,maintained,legacy,archive');
});

test('new person: exactly name/title/photo/link in the chosen group; photo and link optional', () => {
  const text = readRepo('data/people.json');
  const out = C.addPersonText(text, { group: 'alumni', name: ' Ada Example ', title: 'Student', photo: '', link: '' });
  assert.equal(out.problem, null);
  const doc = JSON.parse(out.text);
  const before = JSON.parse(text);
  const alumni = doc.groups.find((g) => g.id === 'alumni');
  assert.deepEqual(alumni.people.at(-1), { name: 'Ada Example', title: 'Student', photo: null, link: null });
  assert.equal(alumni.people.length, before.groups.find((g) => g.id === 'alumni').people.length + 1);
  before.groups.find((g) => g.id === 'alumni').people.push(alumni.people.at(-1));
  assert.equal(out.text, C.formatLike(text, before), 'the added person is the whole diff');
  const linked = C.addPersonText(text, { group: 'active', name: 'B', title: '', photo: 'https://res.cloudinary.com/x/y.jpg',
    link: 'http://example.org' });
  assert.deepEqual(JSON.parse(linked.text).groups[0].people.at(-1),
    { name: 'B', title: '', photo: 'https://res.cloudinary.com/x/y.jpg', link: 'http://example.org' });
  const bad = (patch, re) => assert.match(String(C.addPersonText(text, Object.assign(
    { group: 'active', name: 'C', title: 'T', photo: '', link: '' }, patch)).problem), re, JSON.stringify(patch));
  bad({ group: 'nobody' }, /group/);
  bad({ name: '' }, /name/);
  bad({ photo: 'http://insecure.example/x.jpg' }, /photo.*https/);
  bad({ link: 'javascript:alert(1)' }, /link.*http/);
  bad({ name: before.groups[0].people[0].name }, /already/);
  assert.match(C.addPersonText('{"groups": [}', { group: 'a', name: 'x' }).problem, /line 1, column/);
  assert.deepEqual(C.personGroups(text).map((g) => g.id), ['active', 'alumni']);
  assert.deepEqual(C.personGroups('nope'), []);
});

test('my open proposals: open, mine, on a cms/<login>/ branch of this repository, based on main', () => {
  const pr = (n, o) => Object.assign({ number: n, title: `P${n}`, state: 'open', user: { login: 'Bob' },
    head: { ref: `cms/bob/p${n}-260920`, repo: { full_name: 'desert-mango/hippocampus-docs' } }, base: { ref: 'main' } }, o);
  const pulls = [pr(1), pr(2, { user: { login: 'eve' } }), pr(3, { head: { ref: 'feature/x', repo: { full_name: 'desert-mango/hippocampus-docs' } } }),
    pr(4, { head: { ref: 'cms/bob/p4', repo: { full_name: 'eve/hippocampus-docs' } } }), pr(5, { base: { ref: 'dev' } }),
    pr(6, { state: 'closed' }), pr(7, { head: { ref: 'cms/eve/p7', repo: { full_name: 'desert-mango/hippocampus-docs' } } }),
    pr(8), 'junk', null];
  assert.deepEqual(C.ownProposals(pulls, 'bob'), [
    { number: 1, title: 'P1', branch: 'cms/bob/p1-260920' }, { number: 8, title: 'P8', branch: 'cms/bob/p8-260920' }]);
  assert.deepEqual(C.ownProposals(null, 'bob'), []);
});

test('collectProposal: every changed file of the drafts that go in; two drafts on one path, a bad registry or a forbidden path refuse', () => {
  const base = { ref: 'main', sha: MAIN_SHA, number: null };
  const a = draftOf('about', 'content/about.md', 'Old\n', 'New\n', base);
  const b = { key: 'new/project', label: 'New project: X', route: '/projects/x', base,
    files: { 'data/projects.json': '{"projects": []}\n', 'content/projects/x.md': 'X\n' },
    originals: { 'data/projects.json': '{"projects": []}\n', 'content/projects/x.md': null } };
  const out = C.collectProposal([a, b]);
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.changes.map((c) => c.path), ['content/about.md', 'content/projects/x.md'],
    'an unchanged file of a draft does not go in');
  assert.deepEqual(out.changes[0], { path: 'content/about.md', text: 'New\n', original: 'Old\n', baseSha: MAIN_SHA });
  assert.deepEqual(out.pages, [{ label: 'about', file: 'content/about.md' }, { label: 'New project: X', file: 'content/projects/x.md' }]);
  const twice = C.collectProposal([a, draftOf('other', 'content/about.md', 'Old\n', 'Other\n', base)]);
  assert.match(twice.problems[0], /content\/about\.md.*two drafts/);
  const broken = C.collectProposal([draftOf('data/tools', 'data/tools.json', '{"tools": []}', '{"tools": [],}', base)]);
  assert.match(broken.problems[0], /trailing comma/);
  const machinery = C.collectProposal([draftOf('x', 'js/app.js', 'a', 'b', base)]);
  assert.match(machinery.problems[0], /never/);
  assert.match(C.collectProposal([]).problems[0], /nothing/i);
});

// ---------------------------------------------- Propose: the Git Data API --

const HEAD_B = '3'.repeat(40);
const TREE_B = '4'.repeat(40);
const OWN = 'cms/bob/fix-typo-260920';

/* Answers every write the way GitHub does, with fresh shas; `extra` can
   answer first (method, rest, body) -> reply | undefined. */
function writeAnswers(extra) {
  let k = 0;
  const next = () => (k += 1).toString(16).padStart(40, 'a');
  return (method, url, body) => {
    const rest = url.slice(REPO_API.length);
    const x = extra && extra(method, rest, body);
    if (x) return x;
    if (method === 'POST' && ['/git/blobs', '/git/trees', '/git/commits'].indexOf(rest) >= 0) return reply(201, { sha: next() });
    if (method === 'POST' && rest === '/git/refs') return reply(201, { ref: body.ref, object: { sha: body.sha } });
    if (method === 'PATCH' && rest.startsWith('/git/refs/heads/')) return reply(200, { object: { sha: body.sha } });
    if (method === 'POST' && rest === '/pulls') return reply(201, { number: 42 });
    if (method === 'PATCH' && /^\/pulls\/[0-9]+$/.test(rest)) return reply(200, { number: Number(rest.slice(7)) });
    return reply(500, { message: `unexpected ${method} ${rest}` });
  };
}

function recorded(github) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ method: init.method, rest: url.slice(REPO_API.length), body: init.body ? JSON.parse(init.body) : undefined });
    return github(url, init);
  };
  return { calls, client: C.createGitHubClient({ fetch, token: TOKEN }), seq: () => calls.map((c) => `${c.method} ${c.rest}`) };
}

const ownGithub = (extra) => baseGithub(Object.assign({
  refs: { main: MAIN_SHA, [OWN]: HEAD_B }, commits: { [MAIN_SHA]: MAIN_TREE, [HEAD_B]: TREE_B },
}, extra || {}));

const proposeOpts = (o) => Object.assign({ login: 'Bob', summary: 'Fix the DVL heading', now: NOW,
  origin: 'https://docs.example.org', target: null,
  changes: [{ path: SETUP_FILE, text: 'edited\n', original: SETUP_TEXT, baseSha: MAIN_SHA },
    { path: 'content/about.md', text: 'About.\n', original: null, baseSha: MAIN_SHA }],
  pages: [{ label: 'Page', file: SETUP_FILE }] }, o || {});

test('Propose: blobs -> one tree on main\'s tree -> one commit -> one ref -> one PR, in order, then the review link', async () => {
  const gh = recorded(editorGithub(baseGithub({ onWrite: writeAnswers() })));
  const out = await C.runPropose(gh.client, proposeOpts());
  const branch = 'cms/bob/fix-the-dvl-heading-260921';
  assert.deepEqual(out, { ok: true, number: 42, branch, added: false, message: 'Proposed as #42.' });
  const paths = ['content/about.md', SETUP_FILE].sort();
  assert.deepEqual(gh.seq(), ['GET /git/ref/heads/main', `GET /git/commits/${MAIN_SHA}`,
    'POST /git/blobs', 'POST /git/blobs', 'POST /git/trees', 'POST /git/commits', 'POST /git/refs',
    'POST /pulls', 'PATCH /pulls/42']);
  const [, , b1, b2, tree, commit, ref, pull, patch] = gh.calls;
  const text = { [SETUP_FILE]: 'edited\n', 'content/about.md': 'About.\n' };
  assert.deepEqual([b1.body, b2.body], paths.map((p) => ({ content: text[p], encoding: 'utf-8' })), 'blobs in path order');
  const blob = (i) => (i + 1).toString(16).padStart(40, 'a');
  assert.deepEqual(tree.body, { base_tree: MAIN_TREE,
    tree: paths.map((p, i) => ({ path: p, mode: '100644', type: 'blob', sha: blob(i) })) });
  assert.deepEqual(commit.body, { message: 'Fix the DVL heading\n\nMade in the site editor.', tree: blob(2), parents: [MAIN_SHA] });
  assert.deepEqual(ref.body, { ref: `refs/heads/${branch}`, sha: blob(3) });
  assert.deepEqual(Object.keys(pull.body), ['title', 'head', 'base', 'body']);
  assert.equal(pull.body.title, 'Fix the DVL heading');
  assert.equal(pull.body.head, branch);
  assert.equal(pull.body.base, 'main');
  assert.equal(pull.body.body, C.prBody({ summary: 'Fix the DVL heading', pages: proposeOpts().pages }));
  assert.deepEqual(patch.body, { body: C.prBody({ summary: 'Fix the DVL heading', pages: proposeOpts().pages,
    reviewUrl: 'https://docs.example.org/cms/#/review/42' }) });
  // a failed review-link edit leaves the proposal standing
  const gh2 = recorded(editorGithub(baseGithub({ onWrite: writeAnswers((m, r) => (m === 'PATCH' ? reply(500, {}) : undefined)) })));
  assert.equal((await C.runPropose(gh2.client, proposeOpts())).ok, true);
});

test('Propose: adding to my own open proposal is one more commit on its branch and a ref move — no new PR', async () => {
  const gh = recorded(editorGithub(ownGithub({ onWrite: writeAnswers() })));
  const out = await C.runPropose(gh.client, proposeOpts({ target: { branch: OWN, number: 7 },
    changes: [{ path: SETUP_FILE, text: 'again\n', original: 'x\n', baseSha: HEAD_B }] }));
  assert.deepEqual(out, { ok: true, number: 7, branch: OWN, added: true, message: 'Added to your proposal #7.' });
  assert.deepEqual(gh.seq(), [`GET /git/ref/heads/${OWN}`, `GET /git/commits/${HEAD_B}`, 'POST /git/blobs',
    'POST /git/trees', 'POST /git/commits', `PATCH /git/refs/heads/${OWN}`]);
  assert.equal(gh.calls[3].body.base_tree, TREE_B, 'on the branch head\'s tree');
  assert.deepEqual(gh.calls[4].body.parents, [HEAD_B]);
  assert.deepEqual(gh.calls[5].body, { sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3', force: false });
  // someone else moved the branch: GitHub refuses the fast-forward
  const moved = recorded(editorGithub(ownGithub({ onWrite: writeAnswers((m) => (m === 'PATCH'
    ? reply(422, { message: 'Update is not a fast forward' }) : undefined)) })));
  const refusedMove = await C.runPropose(moved.client, proposeOpts({ target: { branch: OWN, number: 7 },
    changes: [{ path: SETUP_FILE, text: 'again\n', original: 'x\n', baseSha: HEAD_B }] }));
  assert.equal(refusedMove.ok, false);
  assert.match(refusedMove.message, /fast forward/);
});

test('Propose: a taken branch name retries -2 … -5; a file changed on GitHub since it was opened is refused before any write', async () => {
  let taken = 0;
  const gh = recorded(editorGithub(baseGithub({ onWrite: writeAnswers((m, r) => {
    if (m === 'POST' && r === '/git/refs' && taken < 2) { taken += 1; return reply(422, { message: 'Reference already exists' }); }
    return undefined;
  }) })));
  const out = await C.runPropose(gh.client, proposeOpts());
  assert.equal(out.branch, 'cms/bob/fix-the-dvl-heading-260921-3');
  const tried = 'refs/heads/cms/bob/fix-the-dvl-heading-260921';
  assert.deepEqual(gh.calls.filter((c) => c.rest === '/git/refs').map((c) => c.body.ref),
    [tried, `${tried}-2`, `${tried}-3`]);
  assert.equal(gh.calls.find((c) => c.rest === '/pulls').body.head, out.branch);
  const always = recorded(editorGithub(baseGithub({ onWrite: writeAnswers((m, r) => (m === 'POST' && r === '/git/refs'
    ? reply(422, { message: 'Reference already exists' }) : undefined)) })));
  const gaveUp = await C.runPropose(always.client, proposeOpts());
  assert.equal(gaveUp.ok, false);
  assert.equal(always.calls.filter((c) => c.rest === '/git/refs').length, 5);
  assert.ok(!always.calls.some((c) => c.rest === '/pulls'));
  // stale: opened at an older main; the file differs at main's head now
  const OLD = '9'.repeat(40);
  const stale = recorded(editorGithub(baseGithub({ onWrite: writeAnswers() })));
  const s = await C.runPropose(stale.client, proposeOpts({ changes: [{ path: SETUP_FILE, text: 'e\n', original: 'older\n', baseSha: OLD }] }));
  assert.equal(s.ok, false);
  assert.match(s.message, new RegExp(`${SETUP_FILE.replace(/[.]/g, '\\.')} changed on GitHub since you opened it`));
  assert.deepEqual(stale.seq().filter((x) => !x.startsWith('GET')), [], 'nothing written');
  // same text at the new head: it goes ahead; a "new" file that now exists does not
  const fine = recorded(editorGithub(baseGithub({ onWrite: writeAnswers() })));
  assert.equal((await C.runPropose(fine.client, proposeOpts({ changes: [{ path: SETUP_FILE, text: 'e\n', original: SETUP_TEXT, baseSha: OLD }] }))).ok, true);
  assert.ok(fine.seq().includes(`GET /contents/${SETUP_FILE}?ref=${MAIN_SHA}`));
  const exists = recorded(editorGithub(baseGithub({ onWrite: writeAnswers() })));
  assert.equal((await C.runPropose(exists.client, proposeOpts({ changes: [{ path: SETUP_FILE, text: 'e\n', original: null, baseSha: OLD }] }))).ok, false);
});

test('Propose: a 401 anywhere stops at once and says so; a refused path or branch sends nothing', async () => {
  const gh = recorded(editorGithub(baseGithub({ onWrite: writeAnswers((m, r) => (r === '/git/trees' ? reply(401, {}) : undefined)) })));
  const out = await C.runPropose(gh.client, proposeOpts());
  assert.equal(out.ok, false);
  assert.equal(out.status, 401);
  assert.equal(gh.seq().at(-1), 'POST /git/trees');
  // a 401 on the review-link edit: the proposal is open (never propose it twice), and the session ends
  const late = recorded(editorGithub(baseGithub({ onWrite: writeAnswers((m) => (m === 'PATCH' ? reply(401, {}) : undefined)) })));
  const opened = await C.runPropose(late.client, proposeOpts());
  assert.deepEqual([opened.ok, opened.number, opened.signedOut], [true, 42, true]);
  const none = recorded(editorGithub(baseGithub({ onWrite: writeAnswers() })));
  const bad = await C.runPropose(none.client, proposeOpts({ changes: [{ path: 'js/app.js', text: 'x', original: 'y', baseSha: MAIN_SHA }] }));
  assert.equal(bad.ok, false);
  assert.match(bad.message, /never/);
  const notMine = await C.runPropose(none.client, proposeOpts({ target: { branch: 'main', number: 7 } }));
  assert.equal(notMine.ok, false);
  assert.deepEqual(none.calls, [], 'nothing was sent');
  // the one builder refuses any ref that is not a proposal branch
  for (const branch of ['main', 'refs/heads/main', 'cms/../main', 'feature/x']) {
    assert.throws(() => C.proposeRequest('ref', { branch, sha: MAIN_SHA }), /proposal branch/, branch);
    assert.throws(() => C.proposeRequest('move', { branch, sha: MAIN_SHA }), /proposal branch/, branch);
    assert.throws(() => C.proposeRequest('pull', { branch, title: 't', body: 'b' }), /proposal branch/, branch);
  }
  assert.throws(() => C.proposeRequest('delete', {}), /no such step/);
});

// ------------------------------------------- Propose from js/cms.js pages --

const sendProposal = async (page, summary) => {
  page.byData('action', 'propose').click();
  await settle();
  const box = page.one((e) => e.attrs['data-field'] === 'summary');
  if (summary !== undefined) box.value = summary;
  const go = page.byData('action', 'send-proposal');
  go.click();
  await settle();
  return { box, go };
};

test('js/cms.js Propose from a setup page: exactly blobs -> tree -> commit -> ref -> PR, then #/review/<n>', async () => {
  const page = openEditor({ hash: `#/edit/setup/${SETUP_PAGE.id}`, github: editorGithub(baseGithub({ onWrite: writeAnswers() })) });
  await settle();
  const edited = SETUP_TEXT.replace(/^(#+ .*)$/m, '$1 (edited)');
  await page.type(page.textarea(), edited);
  page.byData('action', 'propose').click();
  await settle();
  const box = page.one((e) => e.attrs['data-field'] === 'summary');
  assert.equal(box.value, `Edit ${SETUP_PAGE.title}`);
  assert.equal(page.byData('action', 'send-proposal').textContent, 'Propose');
  box.value = 'Fix the heading';
  page.byData('action', 'send-proposal').click();
  await settle();
  const writes = page.writes();
  assert.deepEqual(writes.map((c) => `${c.method} ${c.url.slice(REPO_API.length)}`), ['POST /git/blobs', 'POST /git/trees',
    'POST /git/commits', 'POST /git/refs', 'POST /pulls', 'PATCH /pulls/42']);
  assert.deepEqual(writes[0].body, { content: edited, encoding: 'utf-8' });
  assert.deepEqual(writes[1].body.tree.map((e) => e.path), [SETUP_FILE], 'only that file');
  assert.match(writes[3].body.ref, /^refs\/heads\/cms\/bob\/fix-the-heading-[0-9]{6}$/);
  assert.match(writes[5].body.body, /https:\/\/docs\.example\.org\/cms\/#\/review\/42/);
  assert.equal(page.location.hash, '#/review/42');
  assert.equal(C.createDraftStore(page.storage).get(`setup/${SETUP_PAGE.id}`), null, 'the draft went into the proposal');
  assert.equal(page.confirms.length, 0, 'no leave question after proposing');
});

test('js/cms.js Propose: starting from my own proposal adds one commit and moves its branch — no new PR', async () => {
  const pulls = [{ number: 7, title: 'Fix typo', state: 'open', user: { login: 'bob' },
    head: { ref: OWN, sha: HEAD_B, repo: { full_name: 'desert-mango/hippocampus-docs' } }, base: { ref: 'main' } }];
  const onBranch = `${SETUP_TEXT}More.\n`;
  const page = openEditor({ hash: `#/edit/setup/${SETUP_PAGE.id}`, github: editorGithub(ownGithub({ pulls,
    contents: { [`${SETUP_FILE}@${MAIN_SHA}`]: SETUP_TEXT, [`${SETUP_FILE}@${HEAD_B}`]: onBranch }, onWrite: writeAnswers() })) });
  await settle();
  const pick = page.one((e) => e.tagName === 'SELECT' && e.attrs['data-base'] !== undefined);
  assert.ok(pick, 'a base picker when I have an open proposal');
  pick.value = '7';
  pick.fire('change');
  await settle();
  assert.equal(page.textarea().value, onBranch, 'the text at my proposal\'s head');
  await page.type(page.textarea(), `${onBranch}Even more.\n`);
  page.byData('action', 'propose').click();
  await settle();
  assert.equal(page.byData('action', 'send-proposal').textContent, 'Add to proposal #7');
  page.byData('action', 'send-proposal').click();
  await settle();
  assert.deepEqual(page.writes().map((c) => `${c.method} ${c.url.slice(REPO_API.length)}`),
    ['POST /git/blobs', 'POST /git/trees', 'POST /git/commits', `PATCH /git/refs/heads/${OWN}`]);
  assert.equal(page.writes()[1].body.base_tree, TREE_B);
  assert.equal(page.location.hash, '#/review/7');
});

test('js/cms.js New project: a form -> one draft of two files -> Propose sends one tree with both paths', async () => {
  const page = openEditor({ hash: '#/new/project', github: editorGithub(baseGithub({ onWrite: writeAnswers() })) });
  await settle();
  const field = (k) => page.one((e) => e.attrs['data-field'] === k);
  assert.equal(field('story').value, '## What it is\n\n');
  field('id').value = 'Bad Id';
  page.byData('action', 'make-draft').click();
  await settle();
  assert.match(page.one((e) => e.attrs['data-problem'] !== undefined).textContent, /id/);
  Object.assign(field('id'), { value: 'sonar-rig' });
  field('name').value = 'Sonar rig';
  field('status').value = 'active';
  field('tagline').value = 'A tank rig.';
  field('repos').value = 'sonar_rig';
  field('story').value = '## What it is\n\nA rig.\n';
  page.byData('action', 'make-draft').click();
  await settle();
  const d = C.createDraftStore(page.storage).get('new/project');
  assert.deepEqual(Object.keys(d.files).sort(), ['content/projects/sonar-rig.md', 'data/projects.json']);
  assert.equal(d.route, '/projects/sonar-rig');
  assert.equal(page.textarea().value, '## What it is\n\nA rig.\n', 'the story opens in the editor');
  const frame = page.frames().at(-1);
  assert.match(frame.srcs.at(-1), /route=%2Fprojects%2Fsonar-rig$/, 'previewed at the new page');
  await sendProposal(page, 'Add the sonar rig');
  const writes = page.writes();
  assert.deepEqual(writes.map((c) => `${c.method} ${c.url.slice(REPO_API.length)}`), ['POST /git/blobs', 'POST /git/blobs',
    'POST /git/trees', 'POST /git/commits', 'POST /git/refs', 'POST /pulls', 'PATCH /pulls/42']);
  assert.deepEqual(writes[2].body.tree.map((e) => e.path), ['content/projects/sonar-rig.md', 'data/projects.json']);
  assert.equal(page.location.hash, '#/review/42');
});

test('js/cms.js New person: the form adds one person to the people draft and opens it', async () => {
  const page = openEditor({ hash: '#/new/person', github: editorGithub(baseGithub()) });
  await settle();
  const field = (k) => page.one((e) => e.attrs['data-field'] === k);
  assert.deepEqual(field('group').childNodes.map((o) => o.attrs.value), ['active', 'alumni']);
  // a photo must be in the site's image list (check.py 6c): it is picked from Media (U9), never typed
  assert.equal(field('photo'), undefined);
  const seam = page.byData('action', 'media-open');
  assert.ok(seam && !seam.disabled, 'Photo from Media is live (U9; tools/tests/test_cms_media.mjs covers it)');
  field('group').value = 'alumni';
  field('name').value = 'Ada Example';
  field('title').value = 'Student';
  page.byData('action', 'add-person').click();
  await settle();
  assert.equal(page.location.hash, '#/edit/data/people');
  const d = C.createDraftStore(page.storage).get('data/people');
  assert.deepEqual(JSON.parse(d.files['data/people.json']).groups[1].people.at(-1),
    { name: 'Ada Example', title: 'Student', photo: null, link: null });
  assert.deepEqual(page.writes(), []);
});

test('js/cms.js New project can start from my open proposal: one more commit on its branch', async () => {
  const pulls = [{ number: 7, title: 'Fix typo', state: 'open', user: { login: 'bob' },
    head: { ref: OWN, sha: HEAD_B, repo: { full_name: 'desert-mango/hippocampus-docs' } }, base: { ref: 'main' } }];
  const page = openEditor({ hash: '#/new/project', github: editorGithub(ownGithub({ pulls, onWrite: writeAnswers(),
    contents: { [`data/projects.json@${MAIN_SHA}`]: readRepo('data/projects.json'),
      [`data/projects.json@${HEAD_B}`]: readRepo('data/projects.json') } })) });
  await settle();
  const field = (k) => page.one((e) => e.attrs['data-field'] === k);
  assert.deepEqual(field('base').childNodes.map((o) => o.attrs.value), ['', '7']);
  field('base').value = '7';
  Object.assign(field('id'), { value: 'sonar-rig' });
  field('name').value = 'Sonar rig';
  field('tagline').value = 'A tank rig.';
  page.byData('action', 'make-draft').click();
  await settle();
  const d = C.createDraftStore(page.storage).get('new/project');
  assert.deepEqual(d.base, { ref: OWN, sha: HEAD_B, number: 7 });
  page.byData('action', 'propose').click();
  await settle();
  assert.equal(page.byData('action', 'send-proposal').textContent, 'Add to proposal #7');
  page.byData('action', 'send-proposal').click();
  await settle();
  assert.deepEqual(page.writes().map((c) => `${c.method} ${c.url.slice(REPO_API.length)}`), ['POST /git/blobs',
    'POST /git/blobs', 'POST /git/trees', 'POST /git/commits', `PATCH /git/refs/heads/${OWN}`]);
  assert.equal(page.writes()[2].body.base_tree, TREE_B);
  assert.equal(page.location.hash, '#/review/7');
});

test('js/cms.js New person can start from my open proposal: the person joins its branch, one more commit', async () => {
  const pulls = [{ number: 7, title: 'Fix typo', state: 'open', user: { login: 'bob' },
    head: { ref: OWN, sha: HEAD_B, repo: { full_name: 'desert-mango/hippocampus-docs' } }, base: { ref: 'main' } }];
  const onMain = readRepo('data/people.json');
  const reg = JSON.parse(onMain);
  reg.groups[0].people.push({ name: 'Already Proposed', title: 'Student', photo: null, link: null });
  const onBranch = C.formatLike(onMain, reg);
  const page = openEditor({ hash: '#/new/person', github: editorGithub(ownGithub({ pulls, onWrite: writeAnswers(),
    contents: { [`data/people.json@${MAIN_SHA}`]: onMain, [`data/people.json@${HEAD_B}`]: onBranch } })) });
  await settle();
  const field = (k) => page.one((e) => e.attrs['data-field'] === k);
  assert.deepEqual(field('base').childNodes.map((o) => o.attrs.value), ['', '7']);
  assert.equal(field('base').value, '', 'the live site unless I pick my proposal');
  field('base').value = '7';
  field('group').value = 'alumni';
  field('name').value = 'Ada Example';
  page.byData('action', 'add-person').click();
  await settle();
  assert.equal(page.location.hash, '#/edit/data/people');
  const d = C.createDraftStore(page.storage).get('data/people');
  assert.deepEqual(d.base, { ref: OWN, sha: HEAD_B, number: 7 });
  const people = JSON.parse(d.files['data/people.json']).groups;
  assert.equal(people[0].people.at(-1).name, 'Already Proposed', 'built on the proposal\'s people, not main\'s');
  assert.equal(people[1].people.at(-1).name, 'Ada Example');
  await page.go('#/edit/data/people');   // the browser's hashchange
  assert.equal(page.textarea().value, d.files['data/people.json'], 'the editor opens the draft on my proposal');
  page.byData('action', 'propose').click();
  await settle();
  assert.equal(page.byData('action', 'send-proposal').textContent, 'Add to proposal #7');
  page.byData('action', 'send-proposal').click();
  await settle();
  assert.deepEqual(page.writes().map((c) => `${c.method} ${c.url.slice(REPO_API.length)}`),
    ['POST /git/blobs', 'POST /git/trees', 'POST /git/commits', `PATCH /git/refs/heads/${OWN}`]);
  assert.equal(page.writes()[1].body.base_tree, TREE_B);
});

test('js/cms.js New person: with a people draft already open, the person joins that draft on its base', async () => {
  const pulls = [{ number: 7, title: 'Fix typo', state: 'open', user: { login: 'bob' },
    head: { ref: OWN, sha: HEAD_B, repo: { full_name: 'desert-mango/hippocampus-docs' } }, base: { ref: 'main' } }];
  const people = readRepo('data/people.json');
  const page = openEditor({ hash: '#/new/person', github: editorGithub(ownGithub({ pulls,
    contents: { [`data/people.json@${MAIN_SHA}`]: people, [`data/people.json@${HEAD_B}`]: people } })) });
  await settle();
  const field = (k) => page.one((e) => e.attrs['data-field'] === k);
  field('base').value = '7';
  field('group').value = 'alumni';
  field('name').value = 'First Person';
  page.byData('action', 'add-person').click();
  await settle();
  await page.go('#/new/person');
  assert.equal(field('base'), undefined, 'no second base choice: the open draft decides');
  assert.match(page.main(), /proposal #7/);
  field('group').value = 'alumni';
  field('name').value = 'Second Person';
  page.byData('action', 'add-person').click();
  await settle();
  const d = C.createDraftStore(page.storage).get('data/people');
  assert.equal(d.base.number, 7);
  assert.deepEqual(JSON.parse(d.files['data/people.json']).groups[1].people.slice(-2).map((p) => p.name),
    ['First Person', 'Second Person']);
});

test('js/cms.js Propose: a 401 after the PR opened keeps it proposed (drafts gone) and ends the session', async () => {
  const page = openEditor({ hash: `#/edit/setup/${SETUP_PAGE.id}`, github: editorGithub(baseGithub({
    onWrite: writeAnswers((m) => (m === 'PATCH' ? reply(401, {}) : undefined)) })) });
  await settle();
  await page.type(page.textarea(), `${SETUP_TEXT}More.\n`);
  await sendProposal(page, 'Add a line');
  assert.equal(page.location.hash, '#/review/42');
  assert.equal(C.createDraftStore(page.storage).get(`setup/${SETUP_PAGE.id}`), null, 'never proposed twice');
  assert.equal(C.readSession(page.storage, Date.now()), null, 'the session ended');
  assert.match(page.els['cms-notice'].textContent, /Proposed as #42\. Your sign-in has ended/);
});
