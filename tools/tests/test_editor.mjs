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
    extra: o.extra,
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

test('Proposals: "Show on page" shows the proposal\'s head in the frame, read-only, its changes marked; Back returns', async () => {
  const page = await editorOn({ hash: `#${UBUNTU_ROUTE}` });
  page.handle().click();
  await settle();
  await page.follow(page.linkTo('#/review/1'));
  const srcs = page.frame().srcs.length;
  page.action('show-on-page').click();
  await settle();
  assert.equal(page.frame().srcs.length, srcs + 1, 'the frame reloaded');
  // U7 (D-G 3): the base is the PR's head, overlay on — its own changes marked against its merge base
  const head = C.overlayOnMain(fixtureText('page-ubuntu-24-04-server.at-merge-base.md'),
    fixtureText('page-ubuntu-24-04-server.at-merge-base.md'), fixtureText('page-ubuntu-24-04-server.at-d0bdc64.md'));
  const served = await page.asks(UBUNTU_FILE);
  assert.equal(served.text, C.withSentinels(head.text, page.nonce().slice(0, 16), head.overlay), 'the PR head\'s text, marked');
  const other = await page.asks('data/projects.json');
  assert.equal(other.text, readRepo('data/projects.json'), 'a file the proposal does not change comes from main');
  assert.match(page.tray().textContent, /Showing proposal #1/);
  await page.send({ type: 'hc-block-select', index: 0 });
  assert.equal(page.textarea(), undefined, 'no editing while a proposal is shown');
  assert.equal(C.createDraftStore(page.storage).list().length, 0);
  page.action('show-off').click();
  await settle();
  const back = await page.asks(UBUNTU_FILE);
  const over = C.overlayOnMain(readRepo(UBUNTU_FILE), fixtureText('page-ubuntu-24-04-server.at-merge-base.md'),
    fixtureText('page-ubuntu-24-04-server.at-d0bdc64.md'));
  assert.equal(back.text, C.withSentinels(over.text, page.nonce().slice(0, 16), over.overlay), 'main, PR #1 drawn over it');
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

// ------------------------------------------------- proposals in place (U7) ---
/* Plan D-F, D-G: an open proposal that touches the page on screen is drawn
   over main in the frame (the composite of HCCore.overlayOnMain, marked with
   this load's sentinels), with a page bar above the frame. PR #1 is used
   READ-ONLY: its files, compare and check-runs answers are U0 fixtures, and
   main has moved since its merge base (MAIN_SHA is a different commit). */

const F = require(path.join(ROOT, 'js', 'editor-frame.js'));
const UB_BASE = fixtureText('page-ubuntu-24-04-server.at-merge-base.md');
const UB_HEAD = fixtureText('page-ubuntu-24-04-server.at-d0bdc64.md');
const PR1 = JSON.parse(fixtureText('pull-1.json'));
const PR1_HEAD = PR1.head.sha;
const PR1_LOGIN = PR1.user.login;
const STATUS_WORD = { pass: 'check green', fail: 'check red', checking: 'check pending', unknown: 'check unknown' };

/* main, moved since PR #1's merge base: one paragraph the PR leaves alone
   is reworded (no mark: it is simply main's text). */
function movedMain() {
  const bb = blocksOf(UB_BASE);
  const same = C.blockDiff(UB_BASE, UB_HEAD).find((d) => d.status === 'same' && bb[d.a].kind === 'paragraph');
  const b = bb[same.a];
  const words = 'Main reworded this paragraph after the proposal was opened.';
  return { text: UB_BASE.slice(0, b.start) + words + b.text.match(/\n*$/)[0] + UB_BASE.slice(b.end), words };
}

/* main, moved so that it ALSO changed a code block PR #1 changes: a conflict. */
function conflictingMain() {
  const bb = blocksOf(UB_BASE);
  const ch = C.blockDiff(UB_BASE, UB_HEAD).find((d) => d.status === 'change' && bb[d.a].kind === 'code');
  const b = bb[ch.a];
  assert.ok(b.text.startsWith('```'), 'a fenced code block');
  const changed = b.text.replace('\n```', '\n# main moved this line\n```');
  return { text: UB_BASE.slice(0, b.start) + changed + UB_BASE.slice(b.end), changed };
}

const pageBar = (page) => page.one((e) => e.classList.contains('hc-pagebar'));
const marksOf = (m) => [...m.overlay].map((x) => ({ index: x.index, mark: x.mark }));

async function ubuntuOn(opts) {
  const page = await editorOn(Object.assign({ hash: `#${UBUNTU_ROUTE}` }, opts));
  await page.send({ type: 'hc-ready' });
  return page;
}

/* A second open proposal on the Ubuntu page, newer than PR #1, built on
   main (its merge base is MAIN_SHA): it adds one paragraph after the h1. */
function secondProposal(mainText) {
  const head = `b2${'0'.repeat(38)}`;
  const bb = blocksOf(mainText);
  const h1 = bb.findIndex((b) => b.kind === 'heading');
  const at = bb[h1 + 1].start;
  const text = `${mainText.slice(0, at)}A second proposal adds this paragraph.\n\n${mainText.slice(at)}`;
  const pull = Object.assign({}, PR1, { number: 2, title: 'A second proposal', created_at: '2026-09-30T08:00:00Z',
    user: Object.assign({}, PR1.user, { login: 'second-author' }),
    head: Object.assign({}, PR1.head, { sha: head, ref: 'cms/second-author/x' }) });
  return {
    text, head,
    extra: {
      pulls: [pull],
      files: { 2: [{ filename: UBUNTU_FILE, status: 'modified', additions: 2, deletions: 0, changes: 2, patch: '@@ -1 +1 @@' }] },
      contents: { [head]: { [UBUNTU_FILE]: text } },
      compare: { [head]: MAIN_SHA },
      checks: { [head]: { total_count: 0, check_runs: [] } },
    },
  };
}

test('fake GitHub: maintain/admin variants and `extra` proposals answer like GitHub', async () => {
  const read = { readFixture: async (n) => { try { return fs.readFileSync(path.join(FIXTURES, n), 'utf8'); } catch (e) { return null; } },
    readFile: async (p) => fs.readFileSync(path.join(ROOT, p), 'utf8') };
  const repo = async (variant) => (await (await createFakeGitHub(Object.assign({ variant }, read))
    .fetch('https://api.github.com/repos/desert-mango/hippocampus-docs')).json()).permissions;
  assert.equal(C.roleFromPermissions(await repo('readonly')).key, 'read');
  assert.equal(C.roleFromPermissions(await repo('push')).key, 'push');
  assert.equal(C.roleFromPermissions(await repo('maintain')).key, 'maintain');
  assert.equal(C.roleFromPermissions(await repo('admin')).key, 'admin');
  const two = secondProposal(readRepo(UBUNTU_FILE));
  const fake = createFakeGitHub(Object.assign({ extra: two.extra }, read));
  const get = async (p) => { const r = await fake.fetch(`https://api.github.com/repos/desert-mango/hippocampus-docs${p}`); return { status: r.status, body: r.ok ? await r.json() : null }; };
  assert.deepEqual((await get('/pulls?state=open&per_page=100')).body.map((p) => p.number).sort(), [1, 2]);
  assert.equal((await get('/pulls/2')).body.head.sha, two.head);
  assert.equal((await get('/pulls/2/files?per_page=100&page=1')).body[0].filename, UBUNTU_FILE);
  assert.equal((await get(`/compare/${MAIN_SHA}...${two.head}`)).body.merge_base_commit.sha, MAIN_SHA);
  assert.equal((await get(`/commits/${two.head}/check-runs?check_name=check&per_page=100`)).body.total_count, 0);
  const at = await fake.fetch(`https://api.github.com/repos/desert-mango/hippocampus-docs/contents/${UBUNTU_FILE}?ref=${two.head}`);
  assert.equal(await at.text(), two.text);
  assert.equal((await get('/pulls/3')).status, 404);
});

test('overlay: PR #1 at d0bdc64 drawn over a MOVED main — the composite with this load\'s sentinels, and its marks', async () => {
  const main = movedMain();
  const page = await ubuntuOn({ files: { [UBUNTU_FILE]: main.text } });
  const ov = C.overlayOnMain(main.text, UB_BASE, UB_HEAD);
  assert.ok(ov && ov.conflicts.length === 0);
  const served = await page.asks(UBUNTU_FILE);
  assert.equal(served.text, C.withSentinels(ov.text, page.nonce().slice(0, 16), ov.overlay));
  assert.ok(served.text.includes(main.words), 'main\'s own (moved) wording is on the page');
  // the merge base came from compare, and the texts were read at the three shas
  const urls = page.github().map((c) => c.url);
  assert.ok(urls.some((u) => u.includes(`/compare/${MAIN_SHA}...${PR1_HEAD}`)), 'merge base via compare');
  for (const sha of [MAIN_SHA, PR1_HEAD, PR1.base.sha]) {
    assert.ok(urls.some((u) => u.includes(`contents/${UBUNTU_FILE}?ref=${sha}`)), `read at ${sha.slice(0, 7)}`);
  }
  const marks = marksOf(page.editorMessages().at(-1));
  const markAt = new Map(marks.map((x) => [x.index, x.mark]));
  assert.equal(marks.length, ov.overlay.filter((e) => e.source !== 'main').length, 'one mark per proposal block');
  ov.overlay.forEach((e, i) => {
    if (e.source === 'main') assert.equal(markAt.has(i), false, `main block ${i} is unmarked`);
    if (e.source === 'pr-del') assert.equal(markAt.get(i), 'del');
    if (e.source === 'pr-add') assert.ok(['add', 'change'].includes(markAt.get(i)));
    if (markAt.get(i) === 'change') assert.equal(markAt.get(i - 1), 'del', 'a changed block follows its old version');
  });
  const attention = ov.overlay.findIndex((e) => e.text.startsWith('<div class="adm adm-attention">'));
  assert.equal(markAt.get(attention), 'add', 'the inserted Attention block is an addition');
  const chrony = ov.overlay.findIndex((e) => e.source === 'pr-add' && /- chrony/.test(e.text) && e.text.startsWith('```'));
  assert.equal(markAt.get(chrony), 'change', 'the changed cloud-init block is the new version…');
  assert.equal(markAt.get(chrony - 1), 'del', '…right after the old one');
  assert.ok(ov.overlay.some((e, i) => e.source === 'main' && e.text.includes(main.words) && !markAt.has(i)));
  // the page bar
  const bar = pageBar(page);
  assert.ok(bar && !bar.hidden, 'the page bar is shown');
  const status = C.checkStatus(JSON.parse(fixtureText('check-runs-d0bdc64.json'))).state;
  assert.match(bar.textContent, new RegExp(`${PR1_LOGIN} proposes changes to this page`));
  assert.match(bar.textContent, /PR #1/);
  assert.match(bar.textContent, new RegExp(STATUS_WORD[status]));
  assert.ok(findAll(bar, (e) => e.attrs['data-action'] === 'review-in-tray').length, 'Review in tray');
});

test('overlay: "Review in tray" opens PR #1\'s card in the tray; the inline/side setting reaches the frame', async () => {
  const local = memoryStorage();
  const page = await ubuntuOn({ localStorage: local });
  findAll(pageBar(page), (e) => e.attrs['data-action'] === 'review-in-tray')[0].click();
  await settle();
  assert.equal(page.tray().hidden, false);
  assert.equal(selectedTab(page), 'proposals');
  assert.ok(page.one((e) => e.attrs['data-pr'] === '1').classList.contains('is-open'));
  assert.equal(page.editorMessages().at(-1).settings.diff, 'inline');
  await openTab(page, 'view');
  page.one((e) => e.attrs['data-setting'] === 'diff' && e.attrs['data-value'] === 'side').click();
  await settle();
  const m = page.editorMessages().at(-1);
  assert.equal(m.settings.diff, 'side');
  assert.ok(F.sidePairs(m.overlay).length > 0, 'the frame can pair old and new blocks side by side');
});

test('frame: sidePairs pairs a deleted block with the changed block right after it, nothing else', () => {
  assert.deepEqual(F.sidePairs([{ index: 3, mark: 'change' }, { index: 2, mark: 'del' }, { index: 5, mark: 'add' },
    { index: 7, mark: 'del' }, { index: 9, mark: 'change' }, { index: 11, mark: 'conflict' }]), [[2, 3]]);
  assert.deepEqual(F.sidePairs([]), []);
  assert.deepEqual(F.sidePairs(null), []);
});

test('overlay: a block main ALSO changed since the merge base shows main\'s version with the "main changed this" mark', async () => {
  const main = conflictingMain();
  const page = await ubuntuOn({ files: { [UBUNTU_FILE]: main.text } });
  const ov = C.overlayOnMain(main.text, UB_BASE, UB_HEAD);
  assert.equal(ov.conflicts.length, 1);
  const k = ov.overlay.findIndex((e) => e.source === 'conflict');
  assert.ok(ov.overlay[k].text.includes('# main moved this line'), 'main\'s version, never a guess');
  const marks = marksOf(page.editorMessages().at(-1));
  assert.deepEqual(marks.filter((x) => x.mark === 'conflict'), [{ index: k, mark: 'conflict' }]);
  const bar = pageBar(page);
  assert.match(bar.textContent, /main changed this since the proposal — Update from main/);
  // Update from main: the one write, pinned to the head sha shown (Write role may)
  const update = findAll(bar, (e) => e.attrs['data-action'] === 'pagebar-update')[0];
  assert.ok(update, 'Update from main, for a role that may');
  const writes = [];
  page.win.fetch = ((orig) => (url, init) => {
    if (init && init.method && init.method !== 'GET') {
      writes.push({ url: String(url), method: init.method, body: JSON.parse(init.body) });
      return Promise.resolve(answer(202, { message: 'Updating pull request branch.' }));
    }
    return orig(url, init);
  })(page.win.fetch);
  update.click();
  await settle();
  assert.deepEqual(writes.map((w) => [w.method, w.url.replace('https://api.github.com', '')]),
    [['PUT', '/repos/desert-mango/hippocampus-docs/pulls/1/update-branch']]);
  assert.equal(writes[0].body.expected_head_sha, PR1_HEAD);
  // a read-only role gets the mark and the words, never the button
  const ro = await ubuntuOn({ files: { [UBUNTU_FILE]: main.text }, variant: 'readonly' });
  assert.match(pageBar(ro).textContent, /main changed this since the proposal/);
  assert.equal(findAll(pageBar(ro), (e) => e.attrs['data-action'] === 'pagebar-update').length, 0);
});

/* PR #2 on the Ubuntu page, newest, built on an OLD base where main has
   since changed a block it changes too (a conflict). Update from main moves
   its head (the fake's `updates`) to a merge of main: built on main, it only
   adds a paragraph. */
function updatableProposal(mainText) {
  const oldHead = `a1${'0'.repeat(38)}`;
  const newHead = `a2${'0'.repeat(38)}`;
  const oldBase = `ba5e${'0'.repeat(36)}`;
  const merged = secondProposal(mainText);
  const pull = Object.assign({}, merged.extra.pulls[0], { head: Object.assign({}, merged.extra.pulls[0].head, { sha: oldHead }) });
  return {
    oldHead, newHead, newText: merged.text,
    extra: {
      pulls: [pull],
      files: merged.extra.files,
      contents: { [oldBase]: { [UBUNTU_FILE]: UB_BASE }, [oldHead]: { [UBUNTU_FILE]: UB_HEAD },
        [newHead]: { [UBUNTU_FILE]: merged.text } },
      compare: { [oldHead]: oldBase, [newHead]: MAIN_SHA },
      checks: { [oldHead]: { total_count: 0, check_runs: [] }, [newHead]: { total_count: 0, check_runs: [] } },
      updates: { 2: newHead },
    },
  };
}

test('overlay: Update from main re-reads the proposal and redraws the bar and the frame on its new head', async () => {
  const main = conflictingMain();
  const up = updatableProposal(main.text);
  const page = await ubuntuOn({ files: { [UBUNTU_FILE]: main.text }, extra: up.extra });
  let bar = pageBar(page);
  assert.match(bar.textContent, /second-author proposes changes to this page/);
  assert.match(bar.textContent, /main changed this since the proposal/);
  assert.ok(marksOf(page.editorMessages().at(-1)).some((x) => x.mark === 'conflict'), 'the old head conflicts');
  const before = page.nonce();
  const srcs = page.frame().srcs.length;
  // GitHub refuses first: the old view stays, with the notice
  const real = page.win.fetch;
  let refuse = true;
  page.win.fetch = (url, init) => {
    if (refuse && init && init.method === 'PUT') {
      refuse = false;
      return Promise.resolve(answer(422, { message: 'merge conflict between base and head' }));
    }
    return real(url, init);
  };
  findAll(bar, (e) => e.attrs['data-action'] === 'pagebar-update')[0].click();
  await settle();
  bar = pageBar(page);
  assert.equal(page.frame().srcs.length, srcs, 'an error reloads nothing');
  assert.equal(page.nonce(), before);
  assert.match(bar.textContent, /main changed this since the proposal/, 'the old view stays');
  const err = findAll(bar, (e) => e.classList.contains('hc-pagebar-result'))[0];
  assert.ok(err && !err.hidden && err.classList.contains('is-error'), 'the error is shown');
  // then it takes it: the head moves, and the page follows
  findAll(bar, (e) => e.attrs['data-action'] === 'pagebar-update')[0].click();
  await settle();
  const puts = page.calls.filter((c) => c.method === 'PUT').map((c) => c.url.replace('https://api.github.com', ''));
  assert.equal(refuse, false, 'the first click was refused');
  assert.deepEqual(puts, ['/repos/desert-mango/hippocampus-docs/pulls/2/update-branch'], 'the second reached GitHub');
  assert.notEqual(page.nonce(), before, 'the frame reloaded with a fresh nonce');
  await page.send({ type: 'hc-ready' });
  const ov = C.overlayOnMain(main.text, main.text, up.newText);
  assert.equal(ov.conflicts.length, 0);
  const marks = marksOf(page.editorMessages().at(-1));
  assert.deepEqual(marks, [{ index: ov.overlay.findIndex((e) => e.source === 'pr-add'), mark: 'add' }],
    'the new head\'s marks: one added paragraph, no conflict');
  const served = await page.asks(UBUNTU_FILE);
  assert.equal(served.text, C.withSentinels(ov.text, page.nonce().slice(0, 16), ov.overlay));
  bar = pageBar(page);
  assert.match(bar.textContent, /second-author proposes changes to this page/);
  assert.doesNotMatch(bar.textContent, /main changed this since the proposal/, 'no obsolete conflict line');
  assert.match(bar.textContent, /Updated from main/, 'the outcome is said on the bar');
  assert.ok(page.github().some((c) => c.url.endsWith(`/compare/${MAIN_SHA}...${up.newHead}`)), 'the new merge base was read');
  // an unrelated edit after the refresh reloads with zero network
  const k = ov.overlay.findIndex((e) => e.source === 'main' && blocksOf(main.text)[e.mainIndex].kind === 'paragraph');
  await page.send({ type: 'hc-block-select', index: k });
  const net = page.github().length;
  await page.type(page.textarea(), 'An unrelated edit.\n\n');
  await page.send({ type: 'hc-ready' });
  assert.equal(page.github().length, net, 'no network call for the edit or its reload');
});

/* GitHub as it really is: it answers 202 to update-branch at once and moves
   the head "a moment later" — here, when the editor's first poll wait (a
   timer of a second or more) has passed. hold() keeps that moment from
   coming until release(), so the reader can move on meanwhile. */
function slowUpdate(page) {
  const real = page.win.fetch;
  const puts = [];
  let deferred = null;
  let gate = null;
  let open = null;
  page.win.fetch = (url, init) => {
    if (init && init.method === 'PUT' && /\/update-branch$/.test(String(url))) {
      puts.push({ url: String(url).replace('https://api.github.com', ''), body: JSON.parse(init.body) });
      deferred = [url, init];
      return Promise.resolve(answer(202, { message: 'Updating pull request branch.' }));
    }
    return real(url, init);
  };
  page.win.setTimeout = (fn, ms) => setTimeout(async () => {
    if (ms >= 1000 && deferred) {
      if (gate) await gate;
      const d = deferred;
      deferred = null;
      await real(...d);          // the fake moves the head now
    }
    fn();
  }, 0);
  return {
    puts,
    hold() { gate = new Promise((r) => { open = r; }); },
    release() { open(); gate = null; },
  };
}

/* Page B (the gantry usage page), touched by the same proposal: at its OLD
   head it changes a paragraph main has reworded since the old merge base (a
   conflict); at its NEW head (built on main) it only adds a paragraph. */
const GANTRY_FILE = 'content/setup/lab-gantry/usage.md';
function gantryTexts() {
  const mainText = readRepo(GANTRY_FILE);
  const bb = blocksOf(mainText);
  const para = bb.findIndex((b, i) => i > 3 && b.kind === 'paragraph');
  const b = bb[para];
  const tail = b.text.match(/\n*$/)[0];
  const swap = (words) => mainText.slice(0, b.start) + words + tail + mainText.slice(b.end);
  const at = bb[bb.findIndex((x) => x.kind === 'paragraph')].start;
  return {
    mainText,
    base: swap('The old merge base said this.'),
    oldHead: swap('The old head changed what the merge base said.'),
    newHead: `${mainText.slice(0, at)}The new head adds this paragraph.\n\n${mainText.slice(at)}`,
  };
}

function updatableOnTwoPages(mainText) {
  const up = updatableProposal(mainText);
  const g = gantryTexts();
  const [oldBase] = Object.keys(up.extra.contents).filter((sha) => sha.startsWith('ba5e'));
  const extra = Object.assign({}, up.extra, {
    files: { 2: [...up.extra.files[2], { filename: GANTRY_FILE, status: 'modified', additions: 2, deletions: 0,
      changes: 2, patch: '@@ -1 +1 @@' }] },
    contents: {
      [oldBase]: Object.assign({}, up.extra.contents[oldBase], { [GANTRY_FILE]: g.base }),
      [up.oldHead]: Object.assign({}, up.extra.contents[up.oldHead], { [GANTRY_FILE]: g.oldHead }),
      [up.newHead]: Object.assign({}, up.extra.contents[up.newHead], { [GANTRY_FILE]: g.newHead }),
    },
  });
  return Object.assign({}, up, { extra, gantry: g });
}

test('overlay: Update from main redraws the page the reader moved to while the proposal was read again', async () => {
  const main = conflictingMain();
  const up = updatableOnTwoPages(main.text);
  const page = await ubuntuOn({ files: { [UBUNTU_FILE]: main.text }, extra: up.extra });
  assert.match(pageBar(page).textContent, /main changed this since the proposal/);
  const slow = slowUpdate(page);
  slow.hold();
  findAll(pageBar(page), (e) => e.attrs['data-action'] === 'pagebar-update')[0].click();
  await settle();
  assert.deepEqual(slow.puts.map((w) => w.url), ['/repos/desert-mango/hippocampus-docs/pulls/2/update-branch']);
  // while GitHub has not moved the branch yet, the reader opens page B (also in the proposal)
  await page.go(`#${OTHER_ROUTE}`);
  await page.send({ type: 'hc-ready' });
  assert.ok(marksOf(page.editorMessages().at(-1)).some((x) => x.mark === 'conflict'), 'page B at the old head conflicts');
  assert.match(pageBar(page).textContent, /main changed this since the proposal/);
  const onB = page.nonce();
  // then the head moves, the poll sees it, and page B — the page on screen — follows
  slow.release();
  await settle();
  assert.notEqual(page.nonce(), onB, 'page B reloaded with a fresh nonce on the new head');
  assert.match(page.frame().srcs.at(-1), new RegExp(`&route=${encodeURIComponent(OTHER_ROUTE)}$`), 'still page B');
  await page.send({ type: 'hc-ready' });
  const g = up.gantry;
  const ov = C.overlayOnMain(g.mainText, g.mainText, g.newHead);
  assert.equal(ov.conflicts.length, 0);
  assert.deepEqual(marksOf(page.editorMessages().at(-1)),
    [{ index: ov.overlay.findIndex((e) => e.source === 'pr-add'), mark: 'add' }], 'the new head\'s marks on page B');
  assert.equal((await page.asks(GANTRY_FILE)).text, C.withSentinels(ov.text, page.nonce().slice(0, 16), ov.overlay));
  const bar = pageBar(page);
  assert.doesNotMatch(bar.textContent, /main changed this since the proposal/, 'no obsolete conflict line on page B');
  assert.match(bar.textContent, /Updated from main/);
});

test('tray: the card\'s Update from main waits for the head to move, then redraws the page on it', async () => {
  const main = conflictingMain();
  const up = updatableProposal(main.text);
  const page = await ubuntuOn({ files: { [UBUNTU_FILE]: main.text }, extra: up.extra });
  findAll(pageBar(page), (e) => e.attrs['data-action'] === 'review-in-tray' && e.attrs['data-proposal'] === '2')[0].click();
  await settle();
  const card = page.one((e) => e.attrs['data-pr'] === '2');
  assert.ok(card && card.classList.contains('is-open'), 'PR #2\'s card is open');
  const slow = slowUpdate(page);
  const before = page.nonce();
  findAll(card, (e) => e.tagName === 'BUTTON' && e.attrs['data-action'] === 'update')[0].click();
  await settle();
  assert.deepEqual(slow.puts.map((w) => [w.url, w.body.expected_head_sha]),
    [['/repos/desert-mango/hippocampus-docs/pulls/2/update-branch', up.oldHead]]);
  assert.notEqual(page.nonce(), before, 'the frame reloaded');
  await page.send({ type: 'hc-ready' });
  const ov = C.overlayOnMain(main.text, main.text, up.newText);
  assert.deepEqual(marksOf(page.editorMessages().at(-1)),
    [{ index: ov.overlay.findIndex((e) => e.source === 'pr-add'), mark: 'add' }],
    'the frame shows the new head\'s marks, not the old head\'s conflict');
  assert.equal((await page.asks(UBUNTU_FILE)).text, C.withSentinels(ov.text, page.nonce().slice(0, 16), ov.overlay));
  assert.doesNotMatch(pageBar(page).textContent, /main changed this since the proposal/, 'no obsolete conflict line');
  assert.ok(page.github().some((c) => c.url.endsWith(`/compare/${MAIN_SHA}...${up.newHead}`)), 'the new merge base was read');
});

test('tray: the card\'s Update from main stays pending until the head moved, then the card is drawn on the new head', async () => {
  const main = conflictingMain();
  const up = updatableProposal(main.text);
  const page = await ubuntuOn({ files: { [UBUNTU_FILE]: main.text }, extra: up.extra });
  findAll(pageBar(page), (e) => e.attrs['data-action'] === 'review-in-tray' && e.attrs['data-proposal'] === '2')[0].click();
  await settle();
  const cardOf = () => page.one((e) => e.attrs['data-pr'] === '2');
  const updateButton = () => findAll(cardOf(), (e) => e.tagName === 'BUTTON' && e.attrs['data-action'] === 'update')[0];
  const slow = slowUpdate(page);
  slow.hold();                         // GitHub has not moved the branch yet
  updateButton().click();
  await settle();
  // a second click while the first is pending sends nothing
  updateButton().click();
  await settle();
  assert.deepEqual(slow.puts.map((w) => [w.url, w.body.expected_head_sha]),
    [['/repos/desert-mango/hippocampus-docs/pulls/2/update-branch', up.oldHead]],
    'one update request while the first is pending');
  assert.ok(updateButton().disabled, 'the card\'s Update from main is disabled while pending');
  const pending = findAll(cardOf(), (e) => e.classList.contains('cms-action-result'))[0];
  assert.ok(pending && !pending.hidden && /Updating…/.test(pending.textContent), 'the card says it is updating');
  // the head moves: the card is drawn again from the proposal as it is now
  slow.release();
  await settle();
  const btn = updateButton();
  assert.ok(btn && !btn.disabled, 'the redrawn card\'s Update from main is enabled again');
  assert.match(cardOf().textContent, /Updated from main/, 'the outcome is said on the card');
  btn.click();
  await settle();
  assert.deepEqual(slow.puts.map((w) => w.body.expected_head_sha), [up.oldHead, up.newHead],
    'the redrawn card acts on the new head, not the old one');
});

test('overlay: clicking the block right after a PR-inserted block edits the right main block (composite -> mainIndex)', async () => {
  const main = movedMain();
  const page = await ubuntuOn({ files: { [UBUNTU_FILE]: main.text } });
  const ov = C.overlayOnMain(main.text, UB_BASE, UB_HEAD);
  const k = ov.overlay.findIndex((e, i) => i > 0 && e.source === 'main' && ov.overlay[i - 1].source === 'pr-add');
  assert.ok(k > 0, 'PR #1 inserts a block before a main block');
  const mi = ov.overlay[k].mainIndex;
  assert.notEqual(mi, k, 'composite and main indices differ here');
  const srcs = page.frame().srcs.length;
  await page.send({ type: 'hc-block-select', index: k });
  const ta = page.textarea();
  assert.ok(ta, 'the block editor is open');
  assert.equal(ta.value, blocksOf(main.text)[mi].text, 'main\'s block at mainIndex, not the composite\'s k-th');
  // the frame goes to the draft view (D-G 1): main with plain sentinels, that block selected
  assert.equal(page.frame().srcs.length, srcs + 1, 'the frame reloaded to the draft view');
  await page.send({ type: 'hc-ready' });
  const m = page.editorMessages().at(-1);
  assert.equal(m.selected, mi);
  assert.deepEqual([...m.overlay], []);
  assert.equal((await page.asks(UBUNTU_FILE)).text, C.withSentinels(main.text, page.nonce().slice(0, 16)));
  // an edit changes main's block only
  await page.type(page.textarea(), 'Edited from the overlay.\n');
  const b = blocksOf(main.text)[mi];
  const d = C.createDraftStore(page.storage).get('setup/raspberry-pi/ubuntu-24-04-server').files[UBUNTU_FILE];
  assert.equal(d, main.text.slice(0, b.start) + 'Edited from the overlay.\n' + main.text.slice(b.end));
  // with a draft, the page bar says the proposal also touches this page, with "Show on page"
  await settle();
  const bar = pageBar(page);
  assert.match(bar.textContent, /1 open proposal also touches this page/);
  assert.ok(findAll(bar, (e) => e.attrs['data-action'] === 'pagebar-show' && e.attrs['data-proposal'] === '1').length);
});

test('overlay: "+" after a PR-inserted block inserts after the nearest preceding main block', async () => {
  const main = movedMain();
  const page = await ubuntuOn({ files: { [UBUNTU_FILE]: main.text } });
  const ov = C.overlayOnMain(main.text, UB_BASE, UB_HEAD);
  const k = ov.overlay.findIndex((e, i) => i > 0 && e.source === 'pr-add' && ov.overlay[i - 1].source === 'main');
  let j = k;
  while (ov.overlay[j].source !== 'main') j -= 1;
  // the rail BEFORE composite block k+1 (right after the PR-inserted block k)
  await page.send({ type: 'hc-block-insert', index: k + 1, kind: 'note' });
  const want = C.insertAt(main.text, ov.overlay[j].mainIndex + 1, 'note');
  const d = C.createDraftStore(page.storage).get('setup/raspberry-pi/ubuntu-24-04-server').files[UBUNTU_FILE];
  assert.equal(d, want.text);
});

test('overlay: clicking a PR-only block opens that proposal\'s card and starts no draft', async () => {
  const page = await ubuntuOn();
  const ov = C.overlayOnMain(readRepo(UBUNTU_FILE), UB_BASE, UB_HEAD);
  for (const source of ['pr-add', 'pr-del']) {
    const k = ov.overlay.findIndex((e) => e.source === source);
    const srcs = page.frame().srcs.length;
    await page.send({ type: 'hc-block-select', index: k });
    assert.equal(page.tray().hidden, false, source);
    assert.equal(selectedTab(page), 'proposals');
    assert.ok(page.one((e) => e.attrs['data-pr'] === '1').classList.contains('is-open'), 'PR #1\'s card, open');
    assert.equal(page.textarea(), undefined, 'no block editor');
    assert.equal(C.createDraftStore(page.storage).list().length, 0, 'no draft');
    assert.equal(page.frame().srcs.length, srcs, 'the frame stays on the overlay');
  }
});

test('roles (D8) exactly as reviewActionsFor: read-only no buttons, Write no Merge, Maintainer and Admin all', async () => {
  const actionsIn = async (variant) => {
    const page = await ubuntuOn({ variant });
    findAll(pageBar(page), (e) => e.attrs['data-action'] === 'review-in-tray')[0].click();
    await settle();
    const card = page.one((e) => e.attrs['data-pr'] === '1');
    return ['approve', 'request-changes', 'merge', 'update', 'close']
      .filter((a) => findAll(card, (e) => e.tagName === 'BUTTON' && e.attrs['data-action'] === a).length);
  };
  assert.deepEqual(await actionsIn('readonly'), []);
  assert.deepEqual(await actionsIn('push'), ['approve', 'request-changes', 'update', 'close']);
  assert.deepEqual(await actionsIn('maintain'), ['approve', 'request-changes', 'merge', 'update', 'close']);
  assert.deepEqual(await actionsIn('admin'), ['approve', 'request-changes', 'merge', 'update', 'close']);
});

test('two proposals on one page: the newest is overlaid; the bar lists the other with its own "Show on page"', async () => {
  const mainText = readRepo(UBUNTU_FILE);
  const two = secondProposal(mainText);
  const page = await ubuntuOn({ extra: two.extra });
  const ov2 = C.overlayOnMain(mainText, mainText, two.text);
  assert.equal((await page.asks(UBUNTU_FILE)).text, C.withSentinels(ov2.text, page.nonce().slice(0, 16), ov2.overlay));
  assert.deepEqual(marksOf(page.editorMessages().at(-1)).map((x) => x.mark), ['add']);
  const bar = pageBar(page);
  assert.match(bar.textContent, /second-author proposes changes to this page/);
  assert.match(bar.textContent, /PR #2/);
  assert.match(bar.textContent, /check pending/);
  const other = findAll(bar, (e) => e.attrs['data-action'] === 'pagebar-show' && e.attrs['data-proposal'] === '1')[0];
  assert.ok(other, 'PR #1 is listed with "Show on page"');
  assert.match(bar.textContent, new RegExp(`#1 by ${PR1_LOGIN}`));
  other.click();
  await settle();
  await page.send({ type: 'hc-ready' });
  // "Show on page" (D-G 3): the base is PR #1's head, overlay on, read-only
  const ov1 = C.overlayOnMain(UB_BASE, UB_BASE, UB_HEAD);
  assert.equal((await page.asks(UBUNTU_FILE)).text, C.withSentinels(ov1.text, page.nonce().slice(0, 16), ov1.overlay));
  assert.match(pageBar(page).textContent, /Showing proposal #1/);
  assert.ok(page.editorMessages().at(-1).overlay.length > 0, 'overlay on');
  const mainBlock = ov1.overlay.findIndex((e) => e.source === 'main' && e.text.trim());
  await page.send({ type: 'hc-block-select', index: mainBlock });
  assert.equal(page.textarea(), undefined, 'read-only: no editing');
  assert.equal(C.createDraftStore(page.storage).list().length, 0);
  page.action('show-off').click();
  await settle();
  assert.equal((await page.asks(UBUNTU_FILE)).text, C.withSentinels(ov2.text, page.nonce().slice(0, 16), ov2.overlay),
    'back to the newest proposal over main');
});

test('"Show others\' suggestions" off: main alone, no marks; the bar still says a proposal touches this page', async () => {
  const local = memoryStorage();
  C.viewSettings.save(local, Object.assign({}, C.viewSettings.DEFAULTS, { suggestions: false }));
  const page = await ubuntuOn({ localStorage: local });
  assert.equal((await page.asks(UBUNTU_FILE)).text, C.withSentinels(readRepo(UBUNTU_FILE), page.nonce().slice(0, 16)));
  assert.deepEqual([...page.editorMessages().at(-1).overlay], []);
  assert.match(pageBar(page).textContent, /1 open proposal touches this page/);
  // turned on in the View tab: the frame reloads with the overlay
  await openTab(page, 'view');
  page.one((e) => e.attrs['data-setting'] === 'suggestions').click();
  await settle();
  await page.send({ type: 'hc-ready' });
  assert.ok(page.editorMessages().at(-1).overlay.length > 0);
});

test('a proposal whose texts do not split is not drawn: the bar says to open it in the tray', async () => {
  const crlf = readRepo(UBUNTU_FILE).replace(/\n/g, '\r\n');
  const page = await ubuntuOn({ files: { [UBUNTU_FILE]: crlf } });
  assert.equal((await page.asks(UBUNTU_FILE)).text, crlf);
  assert.deepEqual([...page.editorMessages().at(-1).overlay], []);
  assert.match(pageBar(page).textContent, /this proposal can't be shown in place — open it in the tray/);
  assert.ok(findAll(pageBar(page), (e) => e.attrs['data-action'] === 'review-in-tray').length);
});

test('a page no proposal touches has no page bar and no marks', async () => {
  const page = await editorOn();
  await page.send({ type: 'hc-ready' });
  assert.ok(!pageBar(page) || pageBar(page).hidden);
  assert.deepEqual([...page.editorMessages().at(-1).overlay], []);
});

/* The frame side of "side by side" over a small DOM (js/editor-frame.js
   create(), the same code the real frame runs). */
class MiniNode {
  constructor(doc, type) { this.ownerDocument = doc; this.nodeType = type; this.parentNode = null; this.childNodes = []; }
  get previousSibling() { const s = this.parentNode ? this.parentNode.childNodes : []; return s[s.indexOf(this) - 1] || null; }
  get nextSibling() { const s = this.parentNode ? this.parentNode.childNodes : []; const i = s.indexOf(this); return i < 0 ? null : s[i + 1] || null; }
  get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map((c) => c.textContent).join(''); }
}
class MiniEl extends MiniNode {
  constructor(doc, tag) {
    super(doc, 1);
    this.tagName = tag.toUpperCase();
    this.attrs = {};
    this.id = '';
    this.cls = new Set();
    const self = this;
    this.classList = { add: (c) => self.cls.add(c), remove: (c) => self.cls.delete(c), contains: (c) => self.cls.has(c),
      toggle: (c, on) => { const want = on === undefined ? !self.cls.has(c) : Boolean(on); if (want) self.cls.add(c); else self.cls.delete(c); return want; } };
  }
  get className() { return [...this.cls].join(' '); }
  set className(v) { this.cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  set textContent(t) { this.childNodes = []; if (t) { const n = new MiniNode(this.ownerDocument, 3); n.data = String(t); this.appendChild(n); } }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  detach(c) { if (c.parentNode) { const s = c.parentNode.childNodes; s.splice(s.indexOf(c), 1); } }
  appendChild(c) { this.detach(c); this.childNodes.push(c); c.parentNode = this; return c; }
  insertBefore(c, ref) {
    if (!ref) return this.appendChild(c);
    this.detach(c);
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, c);
    c.parentNode = this;
    return c;
  }
  removeChild(c) { this.detach(c); c.parentNode = null; return c; }
  addEventListener() {}
  scrollIntoView() {}
}

function sidePage(prefix) {
  const doc = { addEventListener() {} };
  doc.createElement = (t) => new MiniEl(doc, t);
  doc.head = new MiniEl(doc, 'head');
  doc.body = new MiniEl(doc, 'body');
  const content = new MiniEl(doc, 'main');
  content.id = 'content';
  doc.getElementById = (id) => (id === 'content' ? content : null);
  const body = new MiniEl(doc, 'div');
  body.className = 'page-body';
  for (let i = 0; i < 4; i += 1) {
    const s = new MiniEl(doc, 'div');
    s.id = `hcb-${prefix}-${i}`;
    body.appendChild(s);
    body.appendChild(new MiniEl(doc, i === 0 ? 'h1' : 'p'));
  }
  content.appendChild(body);
  doc.body.appendChild(content);
  let listener = null;
  const HC = { preview: true, blockPrefix: prefix, post: () => true, onEditor: (fn) => { listener = fn; return true; } };
  const win = { addEventListener() {}, setTimeout, location: { hash: '' } };
  F.create(win, doc, HC);
  const send = (diff) => listener({ on: true, selected: 2, overlay: [{ index: 1, mark: 'del' }, { index: 2, mark: 'change' }],
    settings: { suggestions: true, diff, compact: false, outlines: true } });
  return { body, send };
}

test('frame: "side by side" puts the old block and its new version in one hc-side pair; "inline" unwraps it', () => {
  const { body, send } = sidePage('0123456789abcdef');
  const cls = (n) => (n.nodeType === 1 ? n.className : '');
  const sides = () => body.childNodes.filter((n) => cls(n).split(' ').includes('hc-side'));
  const order = () => F.blocksIn(body).map((w) => w.getAttribute('data-index'));
  send('side');
  send('side');                          // idempotent
  assert.equal(sides().length, 1);
  const pair = sides()[0];
  assert.deepEqual(pair.childNodes.map((w) => w.getAttribute('data-index')), ['1', '2']);
  assert.ok(pair.childNodes[0].classList.contains('hc-prop-del') && pair.childNodes[1].classList.contains('hc-prop-change'));
  assert.ok(pair.childNodes[1].classList.contains('hc-selected'), 'a block inside a pair is still marked');
  assert.equal(pair.childNodes.filter((n) => cls(n).includes('hc-plus')).length, 0, 'no rail between old and new');
  assert.deepEqual(order(), ['0', '1', '2', '3']);
  send('inline');
  assert.equal(sides().length, 0);
  assert.deepEqual(order(), ['0', '1', '2', '3']);
  assert.ok(body.childNodes.includes(F.blocksIn(body)[1]), 'back as a direct child of the page body');
  send('side');
  assert.equal(sides().length, 1, 'and paired again');
});

test('a link inside the frame: to a page a proposal touches reloads with the overlay; away from it clears the marks', async () => {
  const page = await editorOn();
  await page.send({ type: 'hc-ready' });
  let srcs = page.frame().srcs.length;
  await page.send({ type: 'hc-route', route: UBUNTU_ROUTE });
  assert.equal(page.frame().srcs.length, srcs + 1, 'reloaded: the proposal is drawn on the new page');
  await page.send({ type: 'hc-ready' });
  const ov = C.overlayOnMain(readRepo(UBUNTU_FILE), UB_BASE, UB_HEAD);
  assert.equal((await page.asks(UBUNTU_FILE)).text, C.withSentinels(ov.text, page.nonce().slice(0, 16), ov.overlay));
  assert.ok(page.editorMessages().at(-1).overlay.length > 0);
  srcs = page.frame().srcs.length;
  const told = page.editorMessages().length;
  await page.send({ type: 'hc-route', route: PAGE_ROUTE });
  assert.equal(page.frame().srcs.length, srcs, 'no reload for a page nothing is proposed on');
  assert.ok(page.editorMessages().length > told, 'the frame is told at once…');
  assert.deepEqual([...page.editorMessages().at(-1).overlay], [], '…that the old marks are gone');
  assert.ok(!pageBar(page) || pageBar(page).hidden);
});

test('overlay: "Edit whole page as Markdown" edits main and shows it (the draft view), not the composite', async () => {
  const page = await ubuntuOn();
  await openTab(page, 'changes');
  const srcs = page.frame().srcs.length;
  page.action('edit-whole-page').click();
  await settle();
  assert.equal(page.textarea().value, readRepo(UBUNTU_FILE), 'main\'s whole text');
  assert.equal(page.frame().srcs.length, srcs + 1);
  await page.send({ type: 'hc-ready' });
  assert.deepEqual([...page.editorMessages().at(-1).overlay], []);
  assert.equal((await page.asks(UBUNTU_FILE)).text, C.withSentinels(readRepo(UBUNTU_FILE), page.nonce().slice(0, 16)));
});
