// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 1 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test the Editor mode's parent side (js/editor.js) in a vm over a fake DOM and the fake GitHub.
/* js/editor.js runs in the site's own page once a session exists (plan D-C,
   D-D). These tests run it in a vm context standing in for index.html, with
   js/marked.min.js and js/cms-core.js loaded first (as index.html has them) and tools/tests/fake_github.js (the ONE route
   table the localhost walk uses too) as the network:

     - a session boot mounts the Editor switch and nothing else;
     - Editor on mounts the sandboxed frame at the current route, and the
       page's Markdown reaches it with this load's id-sentinels;
     - hc-ready is answered with hc-editor; hc-block-select puts that block's
       text in the tray; an edit replaces the SPAN, updates the draft and
       reloads the frame with a NEW nonce and `selected`, with zero network
       calls; an unclosed fence never touches the text outside the span;
     - hc-block-insert adds a snippet block and selects it;
     - hc-route syncs the hash with no reload; a parent navigation reloads;
     - a forged message (wrong source or nonce) is ignored;
     - ?editor=<tab> bootstraps Editor mode and is stripped; Editor off;
     - the tray: five tabs, the handle while closed, Proposals cards that
       expand in place and "Show on page", Changes (snippets, drafts with
       Propose… / Discard, registries, New forms), Media, View settings
       (localStorage), Guide, ?editor=…&pr= / data= / new=, and body.hc-phone.

   No browser, no network, and every token is an obvious placeholder.

     node --test tools/tests/test_editor.mjs
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
const { createFakeGitHub, MAIN_SHA } = require(path.join(ROOT, 'tools', 'tests', 'fake_github.js'));

const FIXTURES = path.join(ROOT, 'tools', 'tests', 'fixtures', 'github-data');
const readRepo = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const TOKEN = '<yours>-editor-token';
const ORIGIN = 'https://docs.example.org';
const PAGE_ROUTE = '/setup/hippocampus-bringup/fcu-firmware';
const PAGE_FILE = 'content/setup/hippocampus-bringup/fcu-firmware.md';
const PAGE_TEXT = readRepo(PAGE_FILE);
const OTHER_ROUTE = '/setup/lab-gantry/usage';

// ----------------------------------------------------------- fake DOM ---

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.ownText = '';
    this.attrs = {};
    this.hidden = false;
    this.disabled = false;
    this.readOnly = false;
    this.dataset = {};
    this.listeners = {};
    this.value = '';
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.parent = null;
    this.style = {};
    const classes = new Set();
    this.classSet = classes;
    this.classList = {
      add: (...cs) => cs.forEach((c) => classes.add(c)),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      toggle: (c, on) => {
        const want = on === undefined ? !classes.has(c) : Boolean(on);
        if (want) classes.add(c); else classes.delete(c);
        return want;
      },
      contains: (c) => classes.has(c),
    };
    if (this.tagName === 'IFRAME') {
      const frame = this;
      this.posted = [];
      this.srcs = [];
      this.contentWindow = { postMessage(m, target) { frame.posted.push({ m, target }); } };
    }
  }
  get className() { return [...this.classSet].join(' '); }
  set className(v) { this.classSet.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classSet.add(c)); }
  get textContent() { return this.ownText + this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(t) { this.ownText = String(t); this.childNodes = []; }
  set src(u) { this.srcs.push(u); this.attrs.src = u; }
  get src() { return this.attrs.src; }
  appendChild(c) { if (c.parent) c.remove(); this.childNodes.push(c); c.parent = this; return c; }
  prepend(c) { if (c.parent) c.remove(); this.childNodes.unshift(c); c.parent = this; return c; }
  replaceChildren(...cs) { this.ownText = ''; this.childNodes = cs; cs.forEach((c) => { c.parent = this; }); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  querySelectorAll() { return []; }
  remove() { if (this.parent) this.parent.childNodes = this.parent.childNodes.filter((c) => c !== this); this.parent = null; }
  focus() {}
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
  fire(type) { for (const fn of this.listeners[type] || []) fn({ type, target: this, preventDefault() {} }); }
  click() { if (!this.disabled) this.fire('click'); }
  // the one selector js/editor.js asks for: a tray link, a[href^="#/"]
  closest(sel) {
    if (sel !== 'a[href^="#/"]') throw new Error(`fake closest: ${sel}`);
    for (let n = this; n; n = n.parent) if (n.tagName === 'A' && String(n.attrs.href || '').indexOf('#/') === 0) return n;
    return null;
  }
}

function findAll(node, pred, out = []) {
  if (node && node.tagName && pred(node)) out.push(node);
  for (const c of (node && node.childNodes) || []) findAll(c, pred, out);
  return out;
}

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    raw: m,
  };
}

const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 80; i += 1) await tick(); };

/* index.html's page in a vm: #content, #hc-frame-host, .header-actions and
   a body; js/cms-core.js then js/editor.js; HCEditor.start({fetch, session}). */
function openSite(opts) {
  const o = opts || {};
  const body = new FakeElement('body');
  const head = new FakeElement('head');
  const header = new FakeElement('div');
  header.className = 'header-actions';
  const content = new FakeElement('main');
  content.attrs.id = 'content';
  const host = new FakeElement('div');
  host.attrs.id = 'hc-frame-host';
  host.hidden = true;
  body.appendChild(header);
  body.appendChild(content);
  body.appendChild(host);
  const ids = { content, 'hc-frame-host': host };
  const fake = createFakeGitHub({
    readFixture: async (name) => { try { return fs.readFileSync(path.join(FIXTURES, name), 'utf8'); } catch (e) { return null; } },
    readFile: async (p) => {
      if (o.files && Object.prototype.hasOwnProperty.call(o.files, p)) return o.files[p];
      try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (e) { return null; }
    },
    variant: o.variant,
  });
  const calls = [];
  const opens = [];
  const told = [];        // the footer line (app.js's status callback)
  const sessions = [];    // app.js's onSession callback
  const listeners = {};
  const created = [];
  const replaced = [];
  const storage = o.storage || memoryStorage();
  const location = { origin: ORIGIN, pathname: '/', search: '', hash: o.hash || '#/' };
  const mql = { matches: Boolean(o.phone), media: '', handlers: [],
    addEventListener(type, fn) { if (type === 'change') mql.handlers.push(fn); } };
  const win = vm.createContext({
    document: {
      body, head,
      getElementById: (id) => ids[id] || null,
      querySelector: (sel) => (sel === '.header-actions' ? header : null),
      createElement: (tag) => { const e = new FakeElement(tag); created.push(e); return e; },
      createTextNode: (text) => ({ textContent: String(text), nodeType: 3 }),
      documentElement: new FakeElement('html'),
    },
    sessionStorage: storage,
    localStorage: o.localStorage || memoryStorage(),
    location,
    history: { replaceState: (s, t, url) => { replaced.push(url); location.hash = String(url).replace(/^[^#]*/, ''); } },
    crypto: { getRandomValues: (arr) => { for (let i = 0; i < arr.length; i += 1) arr[i] = Math.floor(Math.random() * 256); return arr; } },
    open: (...a) => { opens.push(a); return null; },
    confirm: () => true,
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    HC: Object.freeze({ preview: false,
      fetchJSON: async (p) => (o.hc && Object.prototype.hasOwnProperty.call(o.hc, p) ? o.hc[p] : JSON.parse(readRepo(p))) }),
    URLSearchParams,
    // the sign-in's popup watch must not keep node alive after a test
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref(); return t; }, clearInterval, clearTimeout,
    setTimeout: (fn) => setTimeout(fn, 0),
    matchMedia: (q) => { mql.media = q; return mql; },
  });
  win.window = win;
  win.fetch = (url, init) => {
    calls.push({ url: String(url), method: (init && init.method) || 'GET' });
    const mine = o.intercept ? o.intercept(String(url), init || {}) : null;
    return mine ? Promise.resolve(mine) : fake.fetch(url, init);
  };
  for (const f of ['marked.min.js', 'cms-core.js', 'editor.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), win, { filename: f });
  }
  const session = o.session === undefined ? C.makeSession(TOKEN, null, 'bob', Date.now()) : o.session;
  const started = win.HCEditor.start(Object.assign({ session,
    status: (text, kind) => told.push({ text, kind }), onSession: (on) => sessions.push(on) }, o.start));
  const page = {
    win, body, header, content, host, calls, listeners, location, created, replaced, storage, mql,
    started, opens, told, sessions,
    all: (pred) => findAll(body, pred),
    one: (pred) => findAll(body, pred)[0],
    frames: () => findAll(host, (e) => e.tagName === 'IFRAME'),
    frame: () => findAll(host, (e) => e.tagName === 'IFRAME').at(-1),
    switchBtn: () => findAll(header, (e) => e.attrs['data-editor-switch'] !== undefined)[0],
    textarea: () => findAll(body, (e) => e.tagName === 'TEXTAREA' && e.attrs['data-block-editor'] !== undefined)[0],
    nonce: () => /#preview=([A-Za-z0-9_-]+)/.exec(page.frame().srcs.at(-1))[1],
    async go(hash) {
      location.hash = hash;
      for (const fn of listeners.hashchange || []) fn();
      await settle();
    },
    // the frame posts a message (source = its window, the current nonce unless given)
    async send(data, extra) {
      const e = Object.assign({ source: page.frame().contentWindow, origin: 'null',
        data: Object.assign({ nonce: page.nonce() }, data) }, extra || {});
      for (const fn of listeners.message || []) fn(e);
      await settle();
    },
    async asks(p) {
      const frame = page.frame();
      const id = 1000 + frame.posted.length;
      await page.send({ type: 'hc-fetch', id, path: p });
      const hit = frame.posted.find((x) => x.m.type === 'hc-file' && x.m.id === id);
      return hit && hit.m;
    },
    editorMessages: () => page.frame().posted.filter((x) => x.m.type === 'hc-editor').map((x) => x.m),
    async type(el, text) { el.value = text; el.fire('input'); await settle(); },
    github: () => calls.filter((c) => c.url.indexOf('https://api.github.com/') === 0),
    tray: () => findAll(body, (e) => e.attrs.id === 'hc-tray')[0],
    tab: (id) => findAll(body, (e) => e.attrs.role === 'tab' && e.attrs['data-tab'] === id)[0],
    handle: () => findAll(body, (e) => e.attrs['data-action'] === 'tray-open')[0],
    action: (name) => findAll(body, (e) => e.attrs['data-action'] === name)[0],
    // a click on a tray link: the tray body's listener sees it (event delegation)
    async follow(a) {
      const tb = findAll(body, (e) => e.classList.contains('hc-tray-body'))[0];
      for (const fn of tb.listeners.click || []) fn({ type: 'click', target: a, preventDefault() {} });
      await settle();
    },
    linkTo: (href) => findAll(body, (e) => e.tagName === 'A' && e.attrs.href === href)[0],
  };
  return page;
}

async function editorOn(opts) {
  const page = openSite(Object.assign({ hash: `#${PAGE_ROUTE}` }, opts));
  await settle();
  page.switchBtn().click();
  await settle();
  return page;
}

const blocksOf = (t) => C.splitBlocks(t).blocks;
const firstParagraph = (t) => blocksOf(t).findIndex((b) => b.kind === 'paragraph');

// ---------------------------------------------------------------- boot ---

test('a session boot mounts the Editor switch, off; no frame; GitHub asked only who and what role', async () => {
  const page = openSite({ hash: `#${PAGE_ROUTE}` });
  await settle();
  const sw = page.switchBtn();
  assert.ok(sw, 'the switch is in the header');
  assert.equal(sw.getAttribute('role'), 'switch');
  assert.equal(sw.getAttribute('aria-checked'), 'false');
  assert.equal(page.body.classList.contains('hc-editor-on'), false);
  assert.equal(page.frames().length, 0);
  assert.equal(page.host.hidden, true);
  assert.deepEqual(page.github().map((c) => c.url).sort(),
    ['https://api.github.com/repos/desert-mango/hippocampus-docs', 'https://api.github.com/user']);
});

test('no session: HCEditor.start mounts nothing and asks GitHub nothing', async () => {
  const page = openSite({ session: null });
  await settle();
  assert.equal(page.switchBtn(), undefined);
  assert.deepEqual(page.github(), []);
});

// ------------------------------------------------------------ Editor on ---

test('Editor on: the sandboxed frame at the current route; the page is served with THIS load\'s sentinels', async () => {
  const page = await editorOn();
  assert.equal(page.switchBtn().getAttribute('aria-checked'), 'true');
  assert.ok(page.body.classList.contains('hc-editor-on'));
  assert.equal(page.host.hidden, false);
  const frame = page.frame();
  assert.equal(frame.attrs.sandbox, 'allow-scripts allow-popups');
  assert.equal(frame.attrs.referrerpolicy, 'no-referrer');
  assert.match(frame.srcs[0], new RegExp(`^index\\.html#preview=[0-9a-f]{32}&route=${encodeURIComponent(PAGE_ROUTE)}$`));
  const nonce = page.nonce();
  const served = await page.asks(PAGE_FILE);
  assert.equal(served.ok, true);
  assert.equal(served.text, C.withSentinels(PAGE_TEXT, nonce.slice(0, 16)));
  assert.match(served.text, new RegExp(`<div id="hcb-${nonce.slice(0, 16)}-0"></div>`));
  const other = await page.asks('data/projects.json');
  assert.equal(other.text, readRepo('data/projects.json'), 'other files come plain, from main');
  const kept = JSON.parse(page.storage.getItem('hc-editor'));
  assert.equal(kept.on, true);
  for (const x of frame.posted) assert.ok(!JSON.stringify(x.m).includes(TOKEN), 'no token reaches the frame');
});

test('hc-ready is answered with hc-editor {nonce, on, settings, selected: null, overlay: []}', async () => {
  const page = await editorOn();
  await page.send({ type: 'hc-ready' });
  const [m] = page.editorMessages();
  assert.ok(m);
  assert.equal(m.nonce, page.nonce());
  assert.equal(m.on, true);
  assert.deepEqual({ ...m.settings }, { ...C.viewSettings.DEFAULTS });
  assert.equal(m.selected, null);
  assert.deepEqual([...m.overlay], []);
  assert.equal(page.frame().posted.find((x) => x.m.type === 'hc-editor').target, '*');
});

// ------------------------------------------------------ select and edit ---

test('hc-block-select: the tray shows that block\'s Markdown; the frame is told which block', async () => {
  const page = await editorOn();
  await page.send({ type: 'hc-ready' });
  const i = firstParagraph(PAGE_TEXT);
  await page.send({ type: 'hc-block-select', index: i });
  const ta = page.textarea();
  assert.ok(ta, 'the block editor is open');
  assert.equal(ta.value, blocksOf(PAGE_TEXT)[i].text);
  assert.equal(page.editorMessages().at(-1).selected, i);
});

test('an edit replaces the span, updates the draft, reloads with a NEW nonce and `selected`; zero network', async () => {
  const page = await editorOn();
  await page.asks(PAGE_FILE);
  const i = firstParagraph(PAGE_TEXT);
  const b = blocksOf(PAGE_TEXT)[i];
  await page.send({ type: 'hc-block-select', index: i });
  const netBefore = page.github().length;
  const first = page.nonce();
  const srcs = page.frame().srcs.length;
  await page.type(page.textarea(), 'A changed paragraph.\n\n');
  const want = PAGE_TEXT.slice(0, b.start) + 'A changed paragraph.\n\n' + PAGE_TEXT.slice(b.end);
  const d = C.createDraftStore(page.storage).get('setup/hippocampus-bringup/fcu-firmware');
  assert.equal(d.files[PAGE_FILE], want, 'the draft holds the text with the span replaced');
  assert.equal(page.frame().srcs.length, srcs + 1, 'the frame reloaded once');
  assert.notEqual(page.nonce(), first, 'with a fresh nonce');
  await page.send({ type: 'hc-ready' });
  assert.equal(page.editorMessages().at(-1).selected, i, 'and is told the block to show');
  const served = await page.asks(PAGE_FILE);
  assert.equal(served.text, C.withSentinels(want, page.nonce().slice(0, 16)));
  assert.equal(page.github().length, netBefore, 'no network call for the edit or the reload');
});

test('reload cost (D-D): a counting fetch across two edits reads each path once', async () => {
  const page = await editorOn();
  const i = firstParagraph(PAGE_TEXT);
  await page.asks(PAGE_FILE);
  await page.asks('data/projects.json');
  await page.send({ type: 'hc-block-select', index: i });
  await page.type(page.textarea(), 'One.\n\n');
  await page.asks(PAGE_FILE);
  await page.asks('data/projects.json');
  await page.type(page.textarea(), 'Two.\n\n');
  await page.asks(PAGE_FILE);
  await page.asks('data/projects.json');
  const reads = page.github().filter((c) => /\/contents\//.test(c.url)).map((c) => c.url);
  assert.equal(reads.length, 2, reads.join('\n'));
  assert.equal(new Set(reads).size, 2);
  assert.equal(page.github().filter((c) => /git\/ref\/heads\/main/.test(c.url)).length, 1, 'main resolved once');
  assert.ok(reads.every((u) => u.includes(`ref=${MAIN_SHA}`)), 'read at the sha, never the branch name');
});

test('typing an unclosed fence never touches the text outside the span', async () => {
  const page = await editorOn();
  const i = firstParagraph(PAGE_TEXT);
  const b = blocksOf(PAGE_TEXT)[i];
  await page.send({ type: 'hc-block-select', index: i });
  const ta = page.textarea();
  for (const typed of ['```', '```bash\n', '```bash\necho', '```bash\necho one\n<div class="adm adm-note">\n']) {
    await page.type(ta, typed);
    const d = C.createDraftStore(page.storage).get('setup/hippocampus-bringup/fcu-firmware').files[PAGE_FILE];
    assert.equal(d.slice(0, b.start), PAGE_TEXT.slice(0, b.start), 'before the span: byte-identical');
    assert.equal(d.slice(b.start + typed.length), PAGE_TEXT.slice(b.end), 'after the span: byte-identical');
  }
});

test('hc-block-insert puts the snippet at that boundary, as its own block, and selects it', async () => {
  const page = await editorOn();
  const i = firstParagraph(PAGE_TEXT);
  await page.send({ type: 'hc-block-insert', index: i, kind: 'note' });
  const d = C.createDraftStore(page.storage).get('setup/hippocampus-bringup/fcu-firmware').files[PAGE_FILE];
  const want = C.insertAt(PAGE_TEXT, i, 'note');
  assert.equal(d, want.text);
  const ta = page.textarea();
  assert.equal(ta.value, want.text.slice(want.span.start, want.span.end));
  assert.equal(ta.value.slice(ta.selectionStart, ta.selectionEnd), C.SNIPPET_CATALOG.note.placeholder);
  await page.send({ type: 'hc-ready' });
  const sel = page.editorMessages().at(-1).selected;
  assert.equal(blocksOf(want.text)[sel].start, want.span.start, 'the new block is the selected one');
  // an unknown kind or an index past the end changes nothing
  await page.send({ type: 'hc-block-insert', index: i, kind: 'script' });
  await page.send({ type: 'hc-block-insert', index: 99999, kind: 'note' });
  assert.equal(C.createDraftStore(page.storage).get('setup/hippocampus-bringup/fcu-firmware').files[PAGE_FILE], want.text);
});

test('a page the block model refuses (CRLF) offers only "Edit whole page as Markdown", with the reason', async () => {
  const crlf = PAGE_TEXT.replace(/\n/g, '\r\n');
  const page = await editorOn({ files: { [PAGE_FILE]: crlf } });
  const served = await page.asks(PAGE_FILE);
  assert.equal(served.text, crlf, 'no sentinels on a page the split refuses');
  await page.send({ type: 'hc-block-select', index: 0 });
  const tray = page.one((e) => e.attrs.id === 'hc-tray');
  assert.match(tray.textContent, /Edit whole page as Markdown/);
  assert.match(tray.textContent, new RegExp(C.splitBlocks(crlf).reason.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const whole = page.one((e) => e.attrs['data-action'] === 'edit-whole-page');
  whole.click();
  await settle();
  assert.equal(page.textarea().value, crlf);
});

test('read-only role: a picked block is shown read-only, and "+" inserts nothing', async () => {
  const page = await editorOn({ variant: 'readonly' });
  const i = firstParagraph(PAGE_TEXT);
  await page.send({ type: 'hc-block-select', index: i });
  assert.equal(page.textarea().readOnly, true);
  await page.send({ type: 'hc-block-insert', index: i, kind: 'note' });
  assert.equal(C.createDraftStore(page.storage).list().length, 0);
});

// ------------------------------------------------------- routes, forgery ---

test('hc-route syncs the hash without a reload; a parent navigation reloads the frame there', async () => {
  const page = await editorOn();
  const srcs = page.frame().srcs.length;
  await page.send({ type: 'hc-route', route: OTHER_ROUTE });
  assert.equal(page.location.hash, `#${OTHER_ROUTE}`);
  for (const fn of page.listeners.hashchange || []) fn();
  await settle();
  assert.equal(page.frame().srcs.length, srcs, 'no reload for the frame\'s own navigation');
  // the frame now shows the other page: its file gets the sentinels
  const served = await page.asks('content/setup/lab-gantry/usage.md');
  assert.equal(served.text, C.withSentinels(readRepo('content/setup/lab-gantry/usage.md'), page.nonce().slice(0, 16)));
  await page.go('#/about');
  assert.equal(page.frame().srcs.length, srcs + 1);
  assert.match(page.frame().srcs.at(-1), /&route=%2Fabout$/);
});

test('a forged message — another window, or another nonce — is ignored', async () => {
  const page = await editorOn();
  const i = firstParagraph(PAGE_TEXT);
  await page.send({ type: 'hc-route', route: '/about' }, { source: { postMessage() {} } });
  await page.send({ type: 'hc-route', route: '/about', nonce: 'f'.repeat(32) });
  assert.equal(page.location.hash, `#${PAGE_ROUTE}`);
  await page.send({ type: 'hc-block-select', index: i, nonce: 'f'.repeat(32) });
  await page.send({ type: 'hc-block-insert', index: i, kind: 'note' }, { source: { postMessage() {} } });
  assert.equal(page.textarea(), undefined);
  assert.equal(C.createDraftStore(page.storage).list().length, 0);
  await page.send({ type: 'hc-ready', nonce: 'f'.repeat(32) });
  assert.equal(page.editorMessages().length, 0);
});

test('the frame hears hc-editor only after the CURRENT load\'s hc-ready; never before, never after a reload alone', async () => {
  const page = await editorOn();
  const i = firstParagraph(PAGE_TEXT);
  await page.send({ type: 'hc-block-select', index: i });
  assert.ok(page.textarea(), 'the tray still opens the block');
  assert.equal(page.editorMessages().length, 0, 'no hc-editor before this load said hc-ready');
  await page.send({ type: 'hc-ready' });
  assert.equal(page.editorMessages().length, 1, 'hc-ready is answered once');
  assert.equal(page.editorMessages()[0].selected, i, 'with the state held back meanwhile');
  // an edit reloads the frame: the new load is not ready until it says so
  const old = page.nonce();
  await page.type(page.textarea(), 'A changed paragraph.\n\n');
  assert.notEqual(page.nonce(), old, 'the frame reloaded');
  const before = page.frame().posted.filter((x) => x.m.type === 'hc-editor').length;
  await page.send({ type: 'hc-block-select', index: i });
  await page.send({ type: 'hc-ready', nonce: old });
  assert.equal(page.frame().posted.filter((x) => x.m.type === 'hc-editor').length, before,
    'nothing reaches the reloaded frame on the old load\'s ready or before its own');
  await page.send({ type: 'hc-ready' });
  const after = page.frame().posted.filter((x) => x.m.type === 'hc-editor');
  assert.equal(after.length, before + 1);
  assert.equal(after.at(-1).m.nonce, page.nonce(), 'the post carries the new load\'s nonce');
});

// ------------------------------------------------------- state and off ---

test('?editor=<tab> turns Editor mode on and is stripped from the address', async () => {
  const page = openSite({ hash: '#/about?editor=changes' });
  await settle();
  assert.ok(page.body.classList.contains('hc-editor-on'));
  assert.equal(page.location.hash, '#/about');
  assert.deepEqual(page.replaced, ['/#/about']);
  assert.match(page.frame().srcs[0], /&route=%2Fabout$/);
  assert.deepEqual(JSON.parse(page.storage.getItem('hc-editor')), { on: true, tab: 'changes', tray: true });
});

test('Editor on survives a reload of the tab (sessionStorage hc-editor); Editor off takes the frame away', async () => {
  const storage = memoryStorage();
  storage.setItem('hc-editor', JSON.stringify({ on: true, tab: 'changes' }));
  const page = openSite({ hash: `#${PAGE_ROUTE}`, storage });
  await settle();
  assert.ok(page.body.classList.contains('hc-editor-on'));
  assert.equal(page.frames().length, 1);
  page.switchBtn().click();
  await settle();
  assert.equal(page.body.classList.contains('hc-editor-on'), false);
  assert.equal(page.host.hidden, true);
  assert.equal(page.frames().length, 0);
  assert.equal(JSON.parse(storage.getItem('hc-editor')).on, false);
  await page.go('#/about');
  assert.equal(page.frames().length, 0, 'no frame while Editor is off');
});

// ------------------------------------------------------------- the tray ---
/* Milestone 3: the tray is today's /cms/ views in a side panel (a bottom
   sheet on phones) with five tabs, and a handle while it is closed. */

const UBUNTU_ROUTE = '/setup/raspberry-pi/ubuntu-24-04-server';
const UBUNTU_FILE = 'content/setup/raspberry-pi/ubuntu-24-04-server.md';
const fixtureText = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const TAB_IDS = ['proposals', 'changes', 'media', 'view', 'guide'];
const TAB_LABELS = ['Proposals', 'Changes', 'Media', 'View', 'Guide'];
const selectedTab = (page) => TAB_IDS.find((id) => page.tab(id).getAttribute('aria-selected') === 'true');

async function openTab(page, id) {
  if (page.tray().hidden) { page.handle().click(); await settle(); }   // the tabs live in the open tray
  page.tab(id).click();
  await settle();
}

test('tray: five tabs in order; closed by default with the handle "Editor · 1 proposal"', async () => {
  const page = await editorOn();
  const tray = page.tray();
  assert.ok(tray, 'the tray is mounted');
  const tabs = page.all((e) => e.attrs.role === 'tab');
  assert.deepEqual(tabs.map((t) => t.attrs['data-tab']), TAB_IDS);
  tabs.forEach((t, i) => assert.ok(t.textContent.indexOf(TAB_LABELS[i]) === 0, t.textContent));
  assert.equal(tray.hidden, true, 'closed until asked');
  assert.equal(page.body.classList.contains('hc-tray-open'), false);
  const handle = page.handle();
  assert.ok(handle && handle.hidden === false, 'the handle shows while the tray is closed');
  assert.equal(handle.textContent, 'Editor · 1 proposal');
  assert.equal(page.tab('proposals').textContent, 'Proposals1', 'the Proposals tab carries the count');
});

test('tray: the handle opens it (Proposals first), × closes it; open/closed is kept for the tab', async () => {
  const page = await editorOn();
  page.handle().click();
  await settle();
  assert.equal(page.tray().hidden, false);
  assert.ok(page.body.classList.contains('hc-tray-open'));
  assert.equal(page.handle().hidden, true);
  assert.equal(selectedTab(page), 'proposals');
  assert.equal(JSON.parse(page.storage.getItem('hc-editor')).tray, true);
  page.action('tray-close').click();
  await settle();
  assert.equal(page.tray().hidden, true);
  assert.equal(page.body.classList.contains('hc-tray-open'), false);
  assert.equal(page.handle().hidden, false);
  assert.equal(JSON.parse(page.storage.getItem('hc-editor')).tray, false);
  // Editor off hides both
  page.switchBtn().click();
  await settle();
  assert.equal(page.handle().hidden, true);
  assert.equal(page.tray().hidden, true);
});

test('tray: picking a block opens the tray on Changes', async () => {
  const page = await editorOn();
  await page.send({ type: 'hc-block-select', index: firstParagraph(PAGE_TEXT) });
  assert.equal(page.tray().hidden, false);
  assert.equal(selectedTab(page), 'changes');
  assert.ok(page.textarea());
});

test('Proposals: a card per open proposal, "touches this page"; the card expands in place', async () => {
  const page = await editorOn({ hash: `#${UBUNTU_ROUTE}` });
  page.handle().click();
  await settle();
  const card = page.one((e) => e.attrs['data-pr'] === '1');
  assert.ok(card, 'PR #1 has a card');
  assert.match(card.textContent, /#1/);
  assert.match(card.textContent, /touches this page/);
  assert.equal(card.classList.contains('is-open'), false);
  await page.follow(page.linkTo('#/review/1'));
  const open = page.one((e) => e.attrs['data-pr'] === '1');
  assert.ok(open.classList.contains('is-open'), 'expanded in place');
  assert.equal(selectedTab(page), 'proposals');
  const here = findAll(open, (e) => e.tagName === 'LI' && e.classList.contains('is-here'));
  assert.equal(here.length, 1);
  assert.match(here[0].textContent, /ubuntu-24-04-server\.md/);
  assert.match(here[0].textContent, /← this page/);
  const status = findAll(open, (e) => e.classList.contains('cms-check'))[0];
  assert.ok(status, 'the gate status is shown');
  for (const a of ['approve', 'request-changes', 'show-on-page']) {
    assert.ok(findAll(open, (e) => e.attrs['data-action'] === a).length, `has ${a}`);
  }
  // the old full-width preview frame is not drawn in the tray: "Show on page" replaces it
  assert.equal(page.all((e) => e.tagName === 'IFRAME' && e.classList.contains('cms-preview-frame')).length, 0);
  // a second click on the open card's title folds it
  await page.follow(findAll(open, (e) => e.tagName === 'A' && e.classList.contains('cms-title'))[0]);
  assert.equal(page.one((e) => e.attrs['data-pr'] === '1').classList.contains('is-open'), false);
});

test('Proposals: "Show on page" shows the proposal\'s head in the frame, read-only; Back returns to main', async () => {
  const page = await editorOn({ hash: `#${UBUNTU_ROUTE}` });
  page.handle().click();
  await settle();
  await page.follow(page.linkTo('#/review/1'));
  const srcs = page.frame().srcs.length;
  page.action('show-on-page').click();
  await settle();
  assert.equal(page.frame().srcs.length, srcs + 1, 'the frame reloaded');
  const served = await page.asks(UBUNTU_FILE);
  assert.equal(served.text, fixtureText('page-ubuntu-24-04-server.at-d0bdc64.md'), 'the PR head\'s text, no sentinels');
  const other = await page.asks('data/projects.json');
  assert.equal(other.text, readRepo('data/projects.json'), 'a file the proposal does not change comes from main');
  assert.match(page.tray().textContent, /Showing proposal #1/);
  await page.send({ type: 'hc-block-select', index: 0 });
  assert.equal(page.textarea(), undefined, 'no editing while a proposal is shown');
  assert.equal(C.createDraftStore(page.storage).list().length, 0);
  page.action('show-off').click();
  await settle();
  const back = await page.asks(UBUNTU_FILE);
  assert.equal(back.text, C.withSentinels(readRepo(UBUNTU_FILE), page.nonce().slice(0, 16)));
  assert.doesNotMatch(page.tray().textContent, /Showing proposal #1/);
});

test('Changes: the snippet bar (the catalog, image through Media) edits inside the span only', async () => {
  const page = await editorOn();
  const i = firstParagraph(PAGE_TEXT);
  const b = blocksOf(PAGE_TEXT)[i];
  await page.send({ type: 'hc-block-select', index: i });
  const kinds = page.all((e) => e.attrs['data-snippet'] !== undefined).map((e) => e.attrs['data-snippet']);
  assert.deepEqual(kinds, Object.keys(C.SNIPPET_CATALOG).filter((k) => !C.SNIPPET_CATALOG[k].media));
  assert.ok(page.one((e) => e.attrs['data-action'] === 'media-open' && /Image from Media/.test(e.textContent)));
  page.one((e) => e.attrs['data-snippet'] === 'note').click();
  await settle();
  const want = C.insertSnippet(b.text, 0, 0, 'note');
  assert.equal(page.textarea().value, want.text);
  const d = C.createDraftStore(page.storage).get('setup/hippocampus-bringup/fcu-firmware').files[PAGE_FILE];
  assert.equal(d, PAGE_TEXT.slice(0, b.start) + want.text + PAGE_TEXT.slice(b.end));
});

test('Changes: the draft list with Propose… and Discard; Discard drops the draft and reloads the frame', async () => {
  const page = await editorOn();
  const i = firstParagraph(PAGE_TEXT);
  await page.send({ type: 'hc-block-select', index: i });
  assert.equal(page.all((e) => e.attrs['data-draft'] !== undefined).length, 0, 'no draft yet');
  await page.type(page.textarea(), 'Changed.\n\n');
  const row = page.one((e) => e.attrs['data-draft'] === 'setup/hippocampus-bringup/fcu-firmware');
  assert.ok(row, 'the draft is listed');
  findAll(row, (e) => e.attrs['data-action'] === 'propose-draft')[0].click();
  await settle();
  const send = page.action('send-proposal');
  assert.ok(send, 'the Propose panel opened');
  assert.equal(send.disabled, false);
  const srcs = page.frame().srcs.length;
  findAll(page.one((e) => e.attrs['data-draft'] === 'setup/hippocampus-bringup/fcu-firmware'),
    (e) => e.attrs['data-action'] === 'discard-draft')[0].click();
  await settle();
  assert.equal(C.createDraftStore(page.storage).list().length, 0);
  assert.equal(page.textarea(), undefined, 'the selection went with the draft');
  assert.equal(page.frame().srcs.length, srcs + 1);
  const served = await page.asks(PAGE_FILE);
  assert.equal(served.text, C.withSentinels(PAGE_TEXT, page.nonce().slice(0, 16)));
});

test('Changes: the four registries as raw JSON (locked-ids line) and the New project / New person forms', async () => {
  const page = await editorOn();
  await openTab(page, 'changes');
  for (const f of C.RAW_REGISTRIES) assert.ok(page.linkTo(`#/edit/${f.slice(0, -5)}`), f);
  await page.follow(page.linkTo('#/edit/data/people'));
  assert.equal(selectedTab(page), 'changes');
  assert.ok(page.one((e) => e.attrs['data-locked'] !== undefined), 'the locked-ids line');
  const ta = page.one((e) => e.tagName === 'TEXTAREA' && e.attrs['data-editor'] !== undefined);
  assert.equal(ta.value, readRepo('data/people.json'));
  await page.follow(page.linkTo('#/pages'));      // "← Changes"
  await page.follow(page.linkTo('#/new/project'));
  assert.ok(page.action('make-draft'), 'the New project form');
  await page.follow(page.linkTo('#/pages'));
  await page.follow(page.linkTo('#/new/person'));
  assert.ok(page.action('add-person'), 'the New person form');
});

test('Media: the Media view in its tab', async () => {
  const page = await editorOn();
  await openTab(page, 'media');
  assert.equal(selectedTab(page), 'media');
  assert.ok(page.one((e) => e.tagName === 'H1' && e.textContent === 'Media'));
  // the fake's /api/media list answers from data/cloudinary-manifest.json (the walk's tray-media shot)
  await settle();
  const manifest = JSON.parse(readRepo('data/cloudinary-manifest.json'));
  const first = Object.values(manifest.assets)[0];
  assert.ok(page.calls.some((c) => c.url === '/api/media' && c.method === 'POST'), 'the list went to /api/media');
  assert.ok(page.one((e) => e.tagName === 'CODE' && e.textContent === first.public_id)
    || page.all((e) => (e.attrs.src || '') === first.url).length > 0, 'a manifest image is listed');
});

test('fake GitHub: /api/media list answers from the manifest; its other actions take no writes', async () => {
  const manifest = JSON.parse(readRepo('data/cloudinary-manifest.json'));
  const fake = createFakeGitHub({ readFixture: async () => null, readFile: async (p) => readRepo(p) });
  const list = await fake.fetch('/api/media', { method: 'POST', body: JSON.stringify({ action: 'list' }) });
  assert.equal(list.status, 200);
  const data = await list.json();
  assert.equal(data.next_cursor, null);
  const assets = Object.values(manifest.assets);
  assert.equal(data.assets.length, Math.min(assets.length, 24));
  assert.deepEqual(Object.keys(data.assets[0]).sort(), ['bytes', 'created_at', 'format', 'height', 'public_id', 'url', 'width']);
  assert.equal(data.assets[0].public_id, assets[0].public_id);
  assert.equal(data.assets[0].url, assets[0].url);
  for (const action of ['sign', 'destroy', 'rename']) {
    const r = await fake.fetch('/api/media', { method: 'POST', body: JSON.stringify({ action }) });
    assert.equal(r.status, 405, action);
  }
  assert.equal(fake.calls.filter((c) => c.url === '/api/media').length, 4);
});

test('View: the settings form saves to localStorage (hc-editor-view) and tells the frame', async () => {
  const local = memoryStorage();
  const page = await editorOn({ localStorage: local });
  await page.send({ type: 'hc-ready' });
  await openTab(page, 'view');
  const sw = (k) => page.one((e) => e.attrs['data-setting'] === k && e.attrs.role === 'switch');
  for (const k of ['suggestions', 'compact', 'outlines']) assert.ok(sw(k), k);
  assert.equal(sw('compact').getAttribute('aria-checked'), 'false');
  sw('compact').click();
  await settle();
  assert.equal(JSON.parse(local.getItem(C.viewSettings.KEY)).compact, true);
  assert.equal(page.editorMessages().at(-1).settings.compact, true, 'the frame is told');
  assert.equal(sw('compact').getAttribute('aria-checked'), 'true');
  page.one((e) => e.attrs['data-setting'] === 'diff' && e.attrs['data-value'] === 'side').click();
  await settle();
  assert.equal(JSON.parse(local.getItem(C.viewSettings.KEY)).diff, 'side');
  assert.equal(page.editorMessages().at(-1).settings.diff, 'side');
  assert.equal(page.storage.getItem(C.viewSettings.KEY), null, 'never in sessionStorage');
});

test('Guide: the new steps, the private line, per-line code diffs out of v1; its links move between tabs', async () => {
  const page = await editorOn();
  await openTab(page, 'guide');
  const text = page.tray().textContent;
  assert.match(text, /Per-line diff inside code blocks is out of v1/);
  assert.match(text, /[Pp]rivate/);
  assert.match(text, /\+/);
  await page.follow(page.linkTo('#/pages'));
  assert.equal(selectedTab(page), 'changes');
});

test('?editor=proposals&pr=1 opens the tray on that card; ?editor=changes&data= / &new= open those forms', async () => {
  let page = openSite({ hash: `#${UBUNTU_ROUTE}?editor=proposals&pr=1` });
  await settle();
  assert.equal(page.tray().hidden, false);
  assert.equal(selectedTab(page), 'proposals');
  assert.ok(page.one((e) => e.attrs['data-pr'] === '1').classList.contains('is-open'));
  assert.equal(page.location.hash, `#${UBUNTU_ROUTE}`);
  page = openSite({ hash: '#/about?editor=changes&data=people' });
  await settle();
  assert.ok(page.one((e) => e.attrs['data-locked'] !== undefined));
  page = openSite({ hash: '#/about?editor=changes&new=person' });
  await settle();
  assert.ok(page.action('add-person'));
});

test('phone: body.hc-phone follows the (max-width: 767px) query', async () => {
  const page = await editorOn({ phone: true });
  assert.equal(page.mql.media, '(max-width: 767px)');
  assert.ok(page.body.classList.contains('hc-phone'));
  page.mql.matches = false;
  page.mql.handlers.forEach((fn) => fn({ matches: false }));
  assert.equal(page.body.classList.contains('hc-phone'), false);
});

// ------------------------------------------------------------ sign-in ---
/* The footer's "Sign in to edit" (js/app.js, D-C) opens the GitHub window in
   the click, injects this file, and calls HCEditor.start({popup}) with no
   session: the editor's sign-in adopts THAT window. */

const answer = (status, body) => ({ ok: status >= 200 && status < 300, status,
  headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body });

function popupWindow() {
  return { closed: false, closes: 0, location: { href: 'about:blank' },
    close() { this.closed = true; this.closes += 1; } };
}

// /api/auth as the Vercel function answers it: the App's client id, then a token for the code
function authServer(log) {
  return (url, init) => {
    if (url.indexOf('/api/auth') !== 0) return null;
    log.push({ url, method: init.method || 'GET', body: init.body });
    if ((init.method || 'GET') === 'GET') return answer(200, { client_id: 'Iv1.placeholder' });
    return answer(200, { token: TOKEN, expires_in: 28800 });
  };
}

const controlsOf = (page) => page.header.childNodes.find((c) => c.classList.contains('hc-editor-controls'));
const stateOf = (popup) => new URL(popup.location.href).searchParams.get('state');

test('sign-in click path: start({popup}) with no session adopts that window, mounts nothing visible, opens none', async () => {
  const popup = popupWindow();
  const page = openSite({ session: null, hash: `#${PAGE_ROUTE}`, start: { popup } });
  await settle();
  assert.equal(page.started, true);
  assert.deepEqual(page.opens, [], 'window.open is never called: the click already opened the window');
  const auth = page.calls.filter((c) => c.url.indexOf('/api/auth') === 0);
  assert.deepEqual(auth.map((c) => c.method), ['GET'], 'the sign-in asked this site for the App\'s client id');
  // the fake has no server functions: the adopted window closes and the footer says why
  assert.equal(popup.closes, 1);
  assert.match(page.told.at(-1).text, /server functions/);
  assert.equal(page.told.at(-1).kind, 'error');
  const controls = controlsOf(page);
  assert.equal(controls.hidden, true, 'no switch before a sign-in');
  assert.deepEqual(page.github(), [], 'no GitHub API call without a token');
});

test('sign-in completes: the adopted window goes to GitHub; its hc-code ends in a stored session, the switch, Editor on', async () => {
  const popup = popupWindow();
  const log = [];
  const page = openSite({ session: null, hash: `#${PAGE_ROUTE}`, start: { popup }, intercept: authServer(log) });
  await settle();
  assert.match(popup.location.href, /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
  assert.equal(new URL(popup.location.href).searchParams.get('redirect_uri'), `${ORIGIN}/cms/callback.html`);
  assert.match(page.told.at(-1).text, /Finish signing in/);
  const state = stateOf(popup);
  const deliver = async (source, origin, data) => {
    for (const fn of page.listeners.message || []) fn({ source, origin, data });
    await settle();
  };
  // forged: another window, another origin, a wrong state — each ignored
  await deliver({}, ORIGIN, { type: 'hc-code', code: 'c0de', state });
  await deliver(popup, 'https://evil.example', { type: 'hc-code', code: 'c0de', state });
  await deliver(popup, ORIGIN, { type: 'hc-code', code: 'c0de', state: `${state}x` });
  assert.equal(log.filter((x) => x.method === 'POST').length, 0);
  assert.equal(page.storage.getItem(C.SESSION_KEY), null);
  await deliver(popup, ORIGIN, { type: 'hc-code', code: 'c0de', state });
  assert.equal(log.filter((x) => x.method === 'POST').length, 1);
  const stored = C.readSession(page.storage, Date.now());
  assert.ok(stored, 'the session is in sessionStorage');
  assert.equal(stored.token, TOKEN);
  assert.equal(controlsOf(page).hidden, false);
  assert.equal(page.switchBtn().getAttribute('aria-checked'), 'true', 'Editor mode comes on after a sign-in');
  assert.ok(page.body.classList.contains('hc-editor-on'));
  assert.equal(page.sessions.at(-1), true, 'app.js hears the sign-in (its footer link turns into "Edit this page")');
  assert.equal(page.told.at(-1).text, '', 'the footer line is cleared');
});

test('a second sign-in click while signed out adopts the NEW window', async () => {
  const first = popupWindow();
  const log = [];
  const page = openSite({ session: null, start: { popup: first }, intercept: authServer(log) });
  await settle();
  const second = popupWindow();
  assert.equal(page.win.HCEditor.start({ popup: second }), true);
  await settle();
  assert.match(second.location.href, /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
  assert.deepEqual(page.opens, []);
  assert.equal(log.filter((x) => x.method === 'GET').length, 2);
});

test('the avatar menu signs out: the session is cleared, Editor off, the controls hide, app.js hears it', async () => {
  const page = await editorOn();
  assert.equal(page.sessions.at(-1), true);
  const avatar = page.one((e) => e.attrs['data-action'] === 'avatar');
  assert.ok(avatar, 'the avatar button is in the header');
  const menu = page.one((e) => e.attrs.role === 'menu');
  assert.equal(menu.hidden, true);
  avatar.click();
  assert.equal(menu.hidden, false);
  assert.equal(avatar.getAttribute('aria-expanded'), 'true');
  page.one((e) => e.attrs['data-action'] === 'sign-out').click();
  await settle();
  assert.equal(page.storage.getItem(C.SESSION_KEY), null);
  assert.equal(page.body.classList.contains('hc-editor-on'), false);
  assert.equal(controlsOf(page).hidden, true);
  assert.equal(page.sessions.at(-1), false);
  assert.match(page.told.at(-1).text, /Signed out/);
});

test('sign-out drops the session\'s file cache and main\'s sha: a pick in flight reads nothing with the old token', async () => {
  const page = await editorOn();
  await page.send({ type: 'hc-ready' });
  const i = firstParagraph(PAGE_TEXT);
  // the frame's pick arrives, and the person signs out before it is served
  for (const fn of page.listeners.message || []) {
    fn({ source: page.frame().contentWindow, origin: 'null', data: { type: 'hc-block-select', index: i, nonce: page.nonce() } });
  }
  const net = page.github().length;
  page.one((e) => e.attrs['data-action'] === 'sign-out').click();
  await settle();
  assert.equal(page.storage.getItem(C.SESSION_KEY), null);
  assert.deepEqual(page.github().slice(net), [], 'no GitHub read after the sign-out (the old token\'s cache is gone)');
  assert.equal(page.textarea(), undefined, 'the pick is dropped');
  const notice = page.one((e) => e.classList.contains('hc-notice'));
  assert.ok(!notice || !/Something went wrong/.test(notice.textContent), 'quietly');
  // a later sign-in builds a fresh cache: Editor mode works again
  const again = await editorOn({ storage: page.storage });
  assert.ok(again.frame(), 'a new session mounts the frame');
});

test('header: the avatar is the committed copy (data/graph/avatars/), first name and role as text', async () => {
  const people = JSON.parse(readRepo('data/graph/people-public.json')).people;
  const login = Object.keys(people).find((k) => people[k] && typeof people[k].avatar === 'string');
  assert.ok(login, 'people-public.json has an avatar');
  const page = openSite({ session: C.makeSession(TOKEN, null, login, Date.now()) });
  await settle();
  const img = page.one((e) => e.tagName === 'IMG' && e.classList.contains('hc-avatar-img'));
  assert.ok(img, 'the committed avatar');
  assert.equal(img.attrs.src, people[login].avatar);
  assert.match(img.attrs.src, /^data\/graph\/avatars\//);
  assert.equal(img.attrs.alt, '');
  const who = page.one((e) => e.classList.contains('hc-login'));
  assert.equal(who.textContent, 'Kyle', 'the first name of the GitHub account (the fixture\'s /user)');
  assert.ok(page.one((e) => e.classList.contains('hc-role')), 'the role badge');
});

test('header: no committed copy, a live or odd avatar path, or a hostile name -> initials, and text only', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const cases = [
    {},
    { bob: { avatar: 'https://avatars.githubusercontent.com/u/1?s=64&v=4' } },
    { bob: { avatar: 'data/graph/avatars/../../js/app.js' } },
    { bob: { avatar: 'javascript:alert(1)' } },
    { bob: { avatar: ['data/graph/avatars/bob.png'] } },
    { bob: 'data/graph/avatars/bob.png' },
  ];
  for (const peopleMap of cases) {
    const page = openSite({
      hc: { 'data/graph/people-public.json': { people: peopleMap } },
      intercept: (url) => (url === 'https://api.github.com/user' ? answer(200, { login: 'bob', name: hostile }) : null),
    });
    await settle();
    assert.equal(page.all((e) => e.tagName === 'IMG').length, 0, `no image for ${JSON.stringify(peopleMap)}`);
    const initials = page.one((e) => e.classList.contains('hc-initials'));
    assert.ok(initials);
    assert.equal(initials.textContent, '<');
    assert.equal(page.one((e) => e.classList.contains('hc-login')).textContent, '<img');
  }
  // people-public.json missing or not an object: initials, never a crash
  for (const doc of [null, 'x', { people: null }, { people: [] }]) {
    const page = openSite({ hc: { 'data/graph/people-public.json': doc } });
    await settle();
    assert.equal(page.all((e) => e.tagName === 'IMG').length, 0);
    assert.equal(page.one((e) => e.classList.contains('hc-initials')).textContent, 'K');
  }
});
