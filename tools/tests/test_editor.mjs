// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 2 October 2026
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
       (localStorage), Guide, ?editor=…&pr= / data= / new=, and body.hc-phone;
     - /cms/ parity on content pages: "Start from: your proposal #n" -> "Add
       to proposal #n" (one commit on my branch, no new PR), and the
       github.com pencil link (Read-only's "View only … github.com" line);
     - /cms/ retired (U8): every row of the deleted test_cms_editor.mjs, and
       the js/cms.js rows of test_cms_core.mjs and test_cms_media.mjs, BY
       NAME — the cms-core-only rows verbatim in one block, the js/cms.js
       rows as "js/editor.js …" against Editor mode (the Review card, the
       session races, Media, Image / Photo from Media, New project / person,
       Propose); docs/cms-v2-plan.md's parity table names them all
       (tools/tests/test_parity_table.mjs).

   No browser, no network, and every token is an obvious placeholder.

     node --test tools/tests/test_editor.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto, createHash } from 'node:crypto';
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

// the browser's FormData, as far as the signed Cloudinary upload uses it
class FakeFormData {
  constructor() { this.entries = []; }
  append(k, v) { this.entries.push([k, v]); }
}

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
    onWrite: o.onWrite,
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
    crypto: { getRandomValues: (arr) => { for (let i = 0; i < arr.length; i += 1) arr[i] = Math.floor(Math.random() * 256); return arr; },
      subtle: webcrypto.subtle },
    FormData: FakeFormData,
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

// --------------------------------------- /cms/ parity on content pages ---
/* The two /cms/ actions a content page needed in Editor mode too: "Start
   from: your proposal #n" (one more commit on my own proposal's branch) and
   the github.com pencil link (Read-only's one way to propose). */

const PAGE_ID = 'setup/hippocampus-bringup/fcu-firmware';
const REPO_API = 'https://api.github.com/repos/desert-mango/hippocampus-docs';
const OWN = 'cms/bob/fix-typo-260920';
const HEAD_B = '3'.repeat(40);
const TREE_B = '4'.repeat(40);

/* Every write answered the way GitHub does (fresh shas), and recorded. */
function recordWrites() {
  const writes = [];
  let k = 0;
  const next = () => (k += 1).toString(16).padStart(40, 'a');
  const onWrite = (method, url, body) => {
    writes.push({ method, url, body });
    const rest = url.slice(REPO_API.length);
    if (method === 'POST' && ['/git/blobs', '/git/trees', '/git/commits'].indexOf(rest) >= 0) return { status: 201, body: { sha: next() } };
    if (method === 'POST' && rest === '/git/refs') return { status: 201, body: { ref: body.ref, object: { sha: body.sha } } };
    if (method === 'PATCH' && rest.startsWith('/git/refs/heads/')) return { status: 200, body: { object: { sha: body.sha } } };
    if (method === 'POST' && rest === '/pulls') return { status: 201, body: { number: 42 } };
    if (method === 'PATCH' && /^\/pulls\/[0-9]+$/.test(rest)) return { status: 200, body: { number: Number(rest.slice(7)) } };
    return { status: 500, body: { message: `unexpected ${method} ${rest}` } };
  };
  return { writes, onWrite };
}

test('js/editor.js Propose: starting from my own proposal adds one commit and moves its branch — no new PR', async () => {
  const onBranch = `${PAGE_TEXT}More.\n`;
  const extra = {
    pulls: [{ number: 7, title: 'Fix typo', state: 'open', user: { login: 'bob' }, created_at: '2026-09-20T10:00:00Z',
      head: { ref: OWN, sha: HEAD_B, repo: { full_name: 'desert-mango/hippocampus-docs' } }, base: { ref: 'main' } }],
    files: { 7: [{ filename: PAGE_FILE, status: 'modified' }] },
    contents: { [HEAD_B]: { [PAGE_FILE]: onBranch } },
    compare: { [HEAD_B]: MAIN_SHA },
    trees: { [HEAD_B]: TREE_B },
  };
  const { writes, onWrite } = recordWrites();
  const page = await editorOn({ extra, onWrite });
  await openTab(page, 'changes');
  assert.ok(page.linkTo(C.pencilUrl(PAGE_FILE)), 'the pencil link, for Write too');
  const pick = page.one((e) => e.tagName === 'SELECT' && e.attrs['data-base'] !== undefined);
  assert.ok(pick, 'a base picker when I have an open proposal');
  pick.value = '7';
  pick.fire('change');
  await settle();
  assert.equal((await page.asks(PAGE_FILE)).text, C.withSentinels(onBranch, page.nonce().slice(0, 16)),
    'the page shows my proposal\'s head');
  page.action('edit-whole-page').click();
  await settle();
  assert.equal(page.textarea().value, onBranch, 'the text at my proposal\'s head');
  await page.type(page.textarea(), `${onBranch}Even more.\n`);
  const d = C.createDraftStore(page.storage).get(PAGE_ID);
  assert.deepEqual({ ...d.base }, { ref: OWN, sha: HEAD_B, number: 7 }, 'the draft keeps its base');
  findAll(page.one((e) => e.attrs['data-draft'] === PAGE_ID), (e) => e.attrs['data-action'] === 'propose-draft')[0].click();
  await settle();
  assert.equal(page.action('send-proposal').textContent, 'Add to proposal #7');
  page.action('send-proposal').click();
  await settle();
  assert.deepEqual(writes.map((c) => `${c.method} ${c.url.slice(REPO_API.length)}`),
    ['POST /git/blobs', 'POST /git/trees', 'POST /git/commits', `PATCH /git/refs/heads/${OWN}`]);
  assert.equal(writes[0].body.content, `${onBranch}Even more.\n`);
  assert.equal(writes[1].body.base_tree, TREE_B);
  assert.equal(writes[2].body.parents[0], HEAD_B, 'one commit on my proposal\'s head');
  assert.match(page.tray().textContent, /Added to your proposal #7/);
  assert.equal(C.createDraftStore(page.storage).get(PAGE_ID), null, 'the draft went into the proposal');
});

test('Start from my proposal: a link inside the frame to another page reloads it there at main; back again, the draft is on my proposal', async () => {
  const onBranch = `${PAGE_TEXT}More.\n`;
  const extra = {
    pulls: [{ number: 7, title: 'Fix typo', state: 'open', user: { login: 'bob' }, created_at: '2026-09-20T10:00:00Z',
      head: { ref: OWN, sha: HEAD_B, repo: { full_name: 'desert-mango/hippocampus-docs' } }, base: { ref: 'main' } }],
    files: { 7: [] },
    contents: { [HEAD_B]: { [PAGE_FILE]: onBranch } },
  };
  const page = await editorOn({ extra });
  await openTab(page, 'changes');
  const pick = page.one((e) => e.tagName === 'SELECT' && e.attrs['data-base'] !== undefined);
  pick.value = '7';
  pick.fire('change');
  await settle();
  assert.match(page.tray().textContent, /Building on your proposal #7\./);
  page.action('edit-whole-page').click();
  await settle();
  await page.type(page.textarea(), `${onBranch}Even more.\n`);
  const srcs = page.frame().srcs.length;
  await page.send({ type: 'hc-route', route: OTHER_ROUTE });
  for (const fn of page.listeners.hashchange || []) fn();
  await settle();
  assert.equal(page.frame().srcs.length, srcs + 1, 'the frame read that page at my proposal\'s head: reloaded at main');
  const other = 'content/setup/lab-gantry/usage.md';
  assert.equal((await page.asks(other)).text, C.withSentinels(readRepo(other), page.nonce().slice(0, 16)));
  await page.go(`#${PAGE_ROUTE}`);
  assert.equal((await page.asks(PAGE_FILE)).text, C.withSentinels(`${onBranch}Even more.\n`, page.nonce().slice(0, 16)),
    'my draft, on my proposal\'s head');
});

test('js/editor.js editor: Read-only sees the page and its preview, view-only, with the pencil link', async () => {
  const page = await editorOn({ variant: 'readonly' });
  await openTab(page, 'changes');
  const pencil = () => page.all((e) => e.tagName === 'A' && e.attrs.href === C.pencilUrl(PAGE_FILE));
  const viewOnly = page.one((e) => e.tagName === 'P' && /^View only: /.test(e.textContent));
  assert.ok(viewOnly, 'the view-only line, before any block is picked');
  assert.match(viewOnly.textContent, /You can still propose a change on github\.com/);
  const a = findAll(viewOnly, (e) => e.tagName === 'A')[0];
  assert.equal(a.attrs.href, C.pencilUrl(PAGE_FILE), 'it carries the pencil link');
  assert.equal(a.attrs.target, '_blank');
  assert.equal(a.attrs.rel, 'noopener noreferrer');
  await page.send({ type: 'hc-block-select', index: firstParagraph(PAGE_TEXT) });
  const ta = page.textarea();
  assert.equal(ta.readOnly, true);
  assert.equal(page.action('propose-draft'), undefined);
  assert.equal(page.one((e) => e.attrs['data-snippet'] === 'note'), undefined);
  assert.equal(page.one((e) => e.attrs['data-base'] !== undefined), undefined, 'no base picker');
  assert.ok(pencil().length, 'the pencil link');
  assert.equal(page.frames().length, 1);
  assert.equal((await page.asks(PAGE_FILE)).text, C.withSentinels(PAGE_TEXT, page.nonce().slice(0, 16)),
    'the page still shows main');
});

/* My open proposal #7 (bob's), its head HEAD_B holding `onBranch` for the
   page; `files` is what it changes. */
function ownSeven(onBranch, files) {
  return {
    pulls: [{ number: 7, title: 'Fix typo', state: 'open', user: { login: 'bob' }, created_at: '2026-09-20T10:00:00Z',
      head: { ref: OWN, sha: HEAD_B, repo: { full_name: 'desert-mango/hippocampus-docs' } }, base: { ref: 'main' } }],
    files: { 7: files },
    contents: { [HEAD_B]: { [PAGE_FILE]: onBranch } },
    compare: { [HEAD_B]: MAIN_SHA },
    trees: { [HEAD_B]: TREE_B },
  };
}
const basePick = (page) => page.one((e) => e.tagName === 'SELECT' && e.attrs['data-base'] !== undefined);

test('Start from while "Show on page" is on: the shown proposal goes, the draft on the picked base is on the page and editable', async () => {
  const onBranch = `${PAGE_TEXT}More.\n`;
  const page = await editorOn({ extra: ownSeven(onBranch, [{ filename: PAGE_FILE, status: 'modified' }]) });
  await openTab(page, 'proposals');
  await page.follow(page.linkTo('#/review/7'));
  page.action('show-on-page').click();
  await settle();
  assert.match(page.tray().textContent, /Showing proposal #7/);
  await openTab(page, 'changes');
  const pick = basePick(page);
  pick.value = '7';
  pick.fire('change');
  await settle();
  assert.equal(page.action('show-off'), undefined, 'no "Back to your view": show mode is over');
  assert.doesNotMatch(page.tray().textContent, /Showing proposal #7/, 'no show bar');
  assert.equal((await page.asks(PAGE_FILE)).text, C.withSentinels(onBranch, page.nonce().slice(0, 16)),
    'the frame serves the draft on the picked base');
  await page.send({ type: 'hc-block-select', index: firstParagraph(onBranch) });
  assert.ok(page.textarea(), 'a block of the page can be edited');
  await page.type(page.textarea(), 'Changed.\n\n');
  const d = C.createDraftStore(page.storage).get(PAGE_ID);
  assert.ok(d && C.isDirty(d), 'the edit is kept');
  assert.deepEqual({ ...d.base }, { ref: OWN, sha: HEAD_B, number: 7 });
});

test('Start from: an edit made while the picked base is still being read is never thrown away without asking', async () => {
  const onBranch = `${PAGE_TEXT}More.\n`;
  const page = await editorOn({ extra: ownSeven(onBranch, []) });
  await openTab(page, 'changes');
  const real = page.win.fetch;
  let open = null;
  const gate = new Promise((r) => { open = r; });
  page.win.fetch = (url, init) => (String(url).endsWith(`/git/ref/heads/${OWN}`)
    ? gate.then(() => real(url, init)) : real(url, init));
  const asked = [];
  page.win.confirm = (text) => { asked.push(text); return false; };
  const pick = basePick(page);
  pick.value = '7';
  pick.fire('change');
  await settle();
  // GitHub has not said where my proposal's branch is yet: the member edits meanwhile
  await page.send({ type: 'hc-block-select', index: firstParagraph(PAGE_TEXT) });
  await page.type(page.textarea(), 'Changed during the wait.\n\n');
  open();
  await settle();
  assert.deepEqual(asked, [C.DISCARD_TEXT], 'asked before the edit could go');
  const d = C.createDraftStore(page.storage).get(PAGE_ID);
  assert.ok(d && C.isDirty(d), 'the edit is kept');
  assert.equal(d.base.number, null, 'still on the live site');
  assert.match(d.files[PAGE_FILE], /Changed during the wait\./);
  assert.doesNotMatch(page.tray().textContent, /Building on your proposal #7/);
  assert.match((await page.asks(PAGE_FILE)).text, /Changed during the wait\./);
});

test('a stored draft naming a proposal that is not my own open one is shown on main, and that branch is never read', async () => {
  const ALICE = 'cms/alice/her-change-260921';
  const HEAD_A = '5'.repeat(40);
  const extra = {
    pulls: [{ number: 9, title: 'Hers', state: 'open', user: { login: 'alice' }, created_at: '2026-09-21T10:00:00Z',
      head: { ref: ALICE, sha: HEAD_A, repo: { full_name: 'desert-mango/hippocampus-docs' } }, base: { ref: 'main' } }],
    files: { 9: [] },
    contents: { [HEAD_A]: { [PAGE_FILE]: 'Her text.\n' } },
  };
  const storage = memoryStorage();
  C.createDraftStore(storage).put({ key: PAGE_ID, label: 'FCU firmware', route: PAGE_ROUTE,
    files: { [PAGE_FILE]: 'Tampered.\n' }, originals: { [PAGE_FILE]: 'Her text.\n' },
    base: { ref: ALICE, sha: HEAD_A, number: 9 } });
  const page = await editorOn({ extra, storage });
  await openTab(page, 'changes');
  assert.equal((await page.asks(PAGE_FILE)).text, C.withSentinels(PAGE_TEXT, page.nonce().slice(0, 16)),
    'the page on main');
  assert.doesNotMatch(page.tray().textContent, /Building on/);
  assert.match(page.tray().textContent, /proposal #9, which is not one of your open proposals/);
  assert.deepEqual(page.calls.filter((c) => c.url.indexOf(HEAD_A) >= 0 || c.url.indexOf(ALICE) >= 0), [],
    'zero reads of that branch');
});

test('a link inside the frame to a page whose stored draft says #7 on another branch reloads it there: main, and the notice', async () => {
  const onBranch = `${PAGE_TEXT}More.\n`;
  const OTHER_ID = 'setup/lab-gantry/usage';
  const OTHER_FILE = 'content/setup/lab-gantry/usage.md';
  const STRAY = 'cms/mallory/same-number-260922';
  const HEAD_S = '6'.repeat(40);
  const MOTOR_ID = 'setup/hippocampus-bringup/motor-configuration';
  const MOTOR_FILE = `content/${MOTOR_ID}.md`;
  const storage = memoryStorage();
  const store = C.createDraftStore(storage);
  store.put({ key: OTHER_ID, label: 'Usage', route: OTHER_ROUTE,
    files: { [OTHER_FILE]: 'Stray.\n' }, originals: { [OTHER_FILE]: readRepo(OTHER_FILE) },
    base: { ref: STRAY, sha: HEAD_S, number: 7 } });
  store.put({ key: MOTOR_ID, label: 'Motor configuration', route: `/${MOTOR_ID}`,
    files: { [MOTOR_FILE]: 'Mine on seven.\n' }, originals: { [MOTOR_FILE]: readRepo(MOTOR_FILE) },
    base: { ref: OWN, sha: HEAD_B, number: 7 } });
  const page = await editorOn({ extra: ownSeven(onBranch, []), storage });
  await openTab(page, 'changes');
  const pick = basePick(page);
  pick.value = '7';
  pick.fire('change');
  await settle();
  assert.match(page.tray().textContent, /Building on your proposal #7\./);
  const srcs = page.frame().srcs.length;
  // first to a page whose draft is on my own #7 (number and branch): the frame already reads there
  await page.send({ type: 'hc-route', route: `/${MOTOR_ID}` });
  for (const fn of page.listeners.hashchange || []) fn();
  await settle();
  assert.equal(page.frame().srcs.length, srcs, 'the same proposal: no reload');
  assert.match(page.tray().textContent, /Building on your proposal #7\./);
  await page.send({ type: 'hc-route', route: OTHER_ROUTE });
  for (const fn of page.listeners.hashchange || []) fn();
  await settle();
  assert.equal(page.frame().srcs.length, srcs + 1, 'same number, another branch: the frame reloads there');
  assert.equal((await page.asks(OTHER_FILE)).text, C.withSentinels(readRepo(OTHER_FILE), page.nonce().slice(0, 16)),
    'the page on main, not at my proposal\'s head');
  assert.doesNotMatch(page.tray().textContent, /Building on/);
  assert.match(page.tray().textContent, /proposal #7, which is not one of your open proposals/);
  assert.deepEqual(page.calls.filter((c) => c.url.indexOf(HEAD_S) >= 0 || c.url.indexOf(STRAY) >= 0), [],
    'zero reads of that branch');
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

// ===================================================== /cms/ retired (U8) ===
/* tools/tests/test_cms_editor.mjs is gone with js/cms.js (U8). Its rows live
   here BY NAME. The ones that test js/cms-core.js alone (the page tree, strict
   JSON, locked ids, snippets, drafts, branch names, forbidden paths, the PR
   body, the new-project and new-person drafts, and the Propose sequence) are
   moved verbatim inside this block, with their own constants (their MAIN_SHA
   is '1' x 40, not the fake GitHub's). The rows that ran js/cms.js are
   re-homed after it, named "js/editor.js …", and run against Editor mode. */
{
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

function reply(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

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
}

// ------------------------------------- /cms/ rows, re-homed: the editor ---
/* The js/cms.js rows of the deleted test_cms_editor.mjs, run against Editor
   mode: #/pages is the Changes home plus the site itself, #/edit/<page> is
   the page on screen with its block (or whole-page) editor, the registries
   and New project / New person are tray routes, and Propose goes from the
   draft list. */

const TREE_M = '7'.repeat(40);          // main's tree, for git/commits/<main sha>
const REGS_NOW = {
  setup: JSON.parse(readRepo('data/setup.json')),
  projects: JSON.parse(readRepo('data/projects.json')),
  tools: JSON.parse(readRepo('data/tools.json')),
};
const PAGE_LABEL = C.pageList(REGS_NOW).find((p) => p.pageId === PAGE_ID).title;
const fieldOf = (page, k) => page.one((e) => e.attrs['data-field'] === k);
const rawEditor = (page) => page.one((e) => e.tagName === 'TEXTAREA' && e.attrs['data-editor'] !== undefined);
const shownProblem = (page) => page.all((e) => e.attrs['data-problem'] !== undefined).find((e) => !e.hidden);
const writeSeq = (writes) => writes.map((c) => `${c.method} ${c.url.slice(REPO_API.length)}`);
const cardOpen = (page, n) => Boolean(page.one((e) => e.attrs['data-pr'] === String(n) && e.classList.contains('is-open')));
const firedHash = async (page) => {
  for (const fn of page.listeners.hashchange || []) fn();
  await settle();
};
async function proposeFrom(page, key, summary) {
  findAll(page.one((e) => e.attrs['data-draft'] === key), (e) => e.attrs['data-action'] === 'propose-draft')[0].click();
  await settle();
  const box = fieldOf(page, 'summary');
  if (summary !== undefined) box.value = summary;
  return box;
}
async function sendIt(page) {
  page.action('send-proposal').click();
  await settle();
}
function ownPull(branch) {
  return { number: 7, title: 'Fix typo', state: 'open', user: { login: 'bob' }, created_at: '2026-09-20T10:00:00Z',
    head: { ref: branch || OWN, sha: HEAD_B, repo: { full_name: 'desert-mango/hippocampus-docs' } }, base: { ref: 'main' } };
}

test('js/editor.js page tree (#/pages): one edit link per page and registry, plus New project / New person', async () => {
  const page = await editorOn();
  await openTab(page, 'changes');
  // the registries and the New forms: tray links, as on /cms/
  const links = page.all((e) => e.tagName === 'A' && /^#\/(edit|new)\//.test(e.attrs.href || '')).map((a) => a.attrs.href);
  assert.deepEqual(links, [...C.RAW_REGISTRIES.map((f) => `#/edit/${f.slice(0, -5)}`), '#/new/project', '#/new/person']);
  // every page of the registries' page tree is the site's own page: on screen, it is the Changes tab's page
  for (const p of C.pageList(REGS_NOW)) {
    await page.go(`#${p.route}`);
    const head = page.one((e) => e.tagName === 'CODE' && e.textContent === p.file);
    assert.ok(head, `${p.pageId}: the Changes tab names ${p.file}`);
    assert.ok(page.linkTo(C.pencilUrl(p.file)), `${p.pageId}: and its github.com pencil link`);
  }
});

test('js/editor.js editor: a heading change reaches the preview frame through the draft, fresh nonce per reload', async () => {
  const page = await editorOn();
  await openTab(page, 'changes');
  page.action('edit-whole-page').click();
  await settle();
  const ta = page.textarea();
  assert.equal(ta.value, PAGE_TEXT, 'the file at main\'s head');
  assert.equal(ta.readOnly, false);
  const frame = page.frame();
  assert.match(frame.srcs[0], new RegExp(`^index\\.html#preview=[0-9a-f]{32}&route=${encodeURIComponent(PAGE_ROUTE)}$`));
  assert.equal(frame.attrs.sandbox, 'allow-scripts allow-popups');
  assert.equal((await page.asks(PAGE_FILE)).text, C.withSentinels(PAGE_TEXT, page.nonce().slice(0, 16)));
  const edited = PAGE_TEXT.replace(/^(#+ .*)$/m, '$1 (edited)');
  assert.notEqual(edited, PAGE_TEXT);
  const loads = frame.srcs.length;
  await page.type(ta, edited);
  assert.equal(frame.srcs.length, loads + 1, 'the frame reloaded once for the change');
  assert.notEqual(frame.srcs.at(-1), frame.srcs.at(-2), 'with a fresh nonce');
  assert.equal((await page.asks(PAGE_FILE)).text, C.withSentinels(edited, page.nonce().slice(0, 16)),
    'the frame is served the draft');
  assert.equal((await page.asks('data/projects.json')).text, readRepo('data/projects.json'),
    'everything else comes from main\'s head');
  // the draft is in sessionStorage, keyed by the page
  const kept = C.createDraftStore(page.storage).get(PAGE_ID);
  assert.equal(kept.files[PAGE_FILE], edited);
  assert.equal(kept.base.sha, MAIN_SHA);
  assert.deepEqual(page.calls.filter((c) => c.method !== 'GET'), [], 'editing writes nothing to GitHub');
  // no token in anything the frame received or in its URL
  for (const x of frame.posted) assert.ok(!JSON.stringify(x.m).includes(TOKEN));
  for (const u of frame.srcs) assert.ok(!u.includes(TOKEN));
});

test('js/editor.js editor: snippet buttons and the internal link picker insert into the draft', async () => {
  const page = await editorOn();
  await page.send({ type: 'hc-block-select', index: firstParagraph(PAGE_TEXT) });
  const ta = page.textarea();
  ta.selectionStart = ta.selectionEnd = 0;
  page.one((e) => e.attrs['data-snippet'] === 'note').click();
  await settle();
  assert.ok(page.textarea().value.startsWith('<div class="adm adm-note"><p class="adm-title">Note</p>'));
  const picker = page.one((e) => e.tagName === 'SELECT' && e.attrs['data-link-picker'] !== undefined);
  picker.value = 'setup/bluerov/dvl';
  page.textarea().selectionStart = page.textarea().selectionEnd = 0;
  page.action('insert-link').click();
  await settle();
  assert.match(page.textarea().value, /^\[[^\]]+\]\(#\/setup\/bluerov\/dvl\)/);
  const media = page.action('media-open');
  assert.ok(media && !media.disabled, 'Image from Media is live (its rows are the "Image from Media" ones below)');
  const d = C.createDraftStore(page.storage).get(PAGE_ID).files[PAGE_FILE];
  assert.ok(d.includes('adm-note') && d.includes('(#/setup/bluerov/dvl)'));
});

test('js/editor.js raw-JSON editor: a trailing comma is refused with line and column; an id change with the rule', async () => {
  const page = await editorOn();
  await openTab(page, 'changes');
  await page.follow(page.linkTo('#/edit/data/projects'));
  const ta = rawEditor(page);
  const original = readRepo('data/projects.json');
  assert.equal(ta.value, original);
  assert.match(page.tray().textContent, /Locked ids/);
  assert.match(page.tray().textContent, /hippocampus-vehicle/);
  const frame = page.frame();
  const loads = frame.srcs.length;
  await page.type(ta, original.replace('"repo_count": 94\n', '"repo_count": 94,\n'));
  const problem = page.one((e) => e.attrs['data-problem'] !== undefined);
  assert.match(problem.textContent, /^data\/projects\.json, line \d+, column \d+: .*trailing comma/);
  assert.equal(problem.hidden, false);
  assert.equal(frame.srcs.length, loads, 'a broken registry is not previewed');
  assert.equal(page.action('propose').disabled, true);
  await page.type(ta, original.replace('"id": "uvms"', '"id": "uvms-renamed"'));
  assert.match(problem.textContent, /'uvms' was removed or renamed — renaming or removing an existing id needs Desert Mango — open an issue/);
  assert.equal(page.action('propose').disabled, true);
  await page.type(ta, original.replace('"repo_count": 94', '"repo_count": 95'));
  assert.equal(problem.hidden, true);
  assert.equal(page.action('propose').disabled, false);
  assert.equal(frame.srcs.length, loads + 1, 'a valid draft is previewed');
  assert.match((await page.asks('data/projects.json')).text, /"repo_count": 95/, 'the frame reads the draft');
});

test('js/editor.js editor: leaving a page with a draft that is not proposed asks first', async () => {
  const page = await editorOn();
  const asked = [];
  page.win.confirm = (text) => { asked.push(text); return false; };
  // a page's block draft stays when the reader moves on (the draft store, keyed by page): nothing is lost
  await page.send({ type: 'hc-block-select', index: firstParagraph(PAGE_TEXT) });
  await page.type(page.textarea(), 'Changed.\n\n');
  await page.go(`#${OTHER_ROUTE}`);
  assert.deepEqual(asked, [], 'nothing to ask: the draft is kept');
  assert.ok(C.isDirty(C.createDraftStore(page.storage).get(PAGE_ID)), 'the draft stays');
  // the raw-JSON editor asks before its draft leaves the screen
  await openTab(page, 'changes');
  await page.follow(page.linkTo('#/edit/data/site'));
  await page.follow(page.linkTo('#/pages'));          // no change yet: no question
  assert.deepEqual(asked, []);
  await page.follow(page.linkTo('#/edit/data/site'));
  await page.type(rawEditor(page), `${readRepo('data/site.json')}\n`);
  await page.follow(page.linkTo('#/pages'));
  assert.equal(asked.length, 1);
  assert.equal(asked[0], C.LEAVE_TEXT);
  assert.match(asked[0], /not proposed/);
  assert.ok(rawEditor(page), 'cancel stays on the page');
  const unload = { preventDefault() { this.prevented = true; }, returnValue: undefined };
  for (const fn of page.listeners.beforeunload || []) fn(unload);
  assert.equal(unload.prevented, true, 'closing the tab with a draft asks too');
});

test('js/editor.js Propose from a setup page: exactly blobs -> tree -> commit -> ref -> PR, then #/review/<n>', async () => {
  const { writes, onWrite } = recordWrites();
  const page = await editorOn({ onWrite, extra: { trees: { [MAIN_SHA]: TREE_M } } });
  const asked = [];
  page.win.confirm = (text) => { asked.push(text); return true; };
  await openTab(page, 'changes');
  page.action('edit-whole-page').click();
  await settle();
  const edited = PAGE_TEXT.replace(/^(#+ .*)$/m, '$1 (edited)');
  await page.type(page.textarea(), edited);
  const box = await proposeFrom(page, PAGE_ID);
  assert.equal(box.value, `Edit ${PAGE_LABEL}`);
  assert.equal(page.action('send-proposal').textContent, 'Propose');
  box.value = 'Fix the heading';
  await sendIt(page);
  assert.deepEqual(writeSeq(writes), ['POST /git/blobs', 'POST /git/trees', 'POST /git/commits', 'POST /git/refs',
    'POST /pulls', 'PATCH /pulls/42']);
  assert.deepEqual(writes[0].body, { content: edited, encoding: 'utf-8' });
  assert.deepEqual(writes[1].body.tree.map((e) => e.path), [PAGE_FILE], 'only that file');
  assert.equal(writes[1].body.base_tree, TREE_M, 'on main\'s tree');
  assert.match(writes[3].body.ref, /^refs\/heads\/cms\/bob\/fix-the-heading-[0-9]{6}$/);
  assert.match(writes[5].body.body, /https:\/\/docs\.example\.org\/cms\/#\/review\/42/);
  assert.ok(cardOpen(page, 42), 'the tray shows proposal #42 (the old #/review/42)');
  assert.equal(C.createDraftStore(page.storage).get(PAGE_ID), null, 'the draft went into the proposal');
  assert.deepEqual(asked, [], 'no leave question after proposing');
});

test('js/editor.js New project: a form -> one draft of two files -> Propose sends one tree with both paths', async () => {
  const { writes, onWrite } = recordWrites();
  const page = await editorOn({ onWrite, extra: { trees: { [MAIN_SHA]: TREE_M } } });
  await openTab(page, 'changes');
  await page.follow(page.linkTo('#/new/project'));
  const field = (k) => fieldOf(page, k);
  assert.equal(field('story').value, '## What it is\n\n');
  field('id').value = 'Bad Id';
  page.action('make-draft').click();
  await settle();
  assert.match(shownProblem(page).textContent, /id/);
  field('id').value = 'sonar-rig';
  field('name').value = 'Sonar rig';
  field('status').value = 'active';
  field('tagline').value = 'A tank rig.';
  field('repos').value = 'sonar_rig';
  field('story').value = '## What it is\n\nA rig.\n';
  page.action('make-draft').click();
  await settle();
  const d = C.createDraftStore(page.storage).get('new/project');
  assert.deepEqual(Object.keys(d.files).sort(), ['content/projects/sonar-rig.md', 'data/projects.json']);
  assert.equal(d.route, '/projects/sonar-rig');
  assert.equal(rawEditor(page).value, '## What it is\n\nA rig.\n', 'the story opens in the editor');
  // the page on screen becomes the new page: the frame shows it from the draft
  assert.equal(page.location.hash, '#/projects/sonar-rig');
  await firedHash(page);
  assert.match(page.frame().srcs.at(-1), /route=%2Fprojects%2Fsonar-rig$/, 'previewed at the new page');
  assert.equal((await page.asks('content/projects/sonar-rig.md')).text, '## What it is\n\nA rig.\n');
  page.action('propose').click();
  await settle();
  fieldOf(page, 'summary').value = 'Add the sonar rig';
  await sendIt(page);
  assert.deepEqual(writeSeq(writes), ['POST /git/blobs', 'POST /git/blobs', 'POST /git/trees', 'POST /git/commits',
    'POST /git/refs', 'POST /pulls', 'PATCH /pulls/42']);
  assert.deepEqual(writes[2].body.tree.map((e) => e.path), ['content/projects/sonar-rig.md', 'data/projects.json']);
  assert.ok(cardOpen(page, 42));
});

test('js/editor.js New person: the form adds one person to the people draft and opens it', async () => {
  const page = await editorOn();
  await openTab(page, 'changes');
  await page.follow(page.linkTo('#/new/person'));
  const field = (k) => fieldOf(page, k);
  assert.deepEqual(field('group').childNodes.map((o) => o.attrs.value), ['active', 'alumni']);
  // a photo must be in the site's image list (check.py 6c): it is picked from Media, never typed
  assert.equal(field('photo'), undefined);
  const seam = page.action('media-open');
  assert.ok(seam && !seam.disabled && /Photo from Media/.test(seam.textContent), 'Photo from Media is live');
  field('group').value = 'alumni';
  field('name').value = 'Ada Example';
  field('title').value = 'Student';
  page.action('add-person').click();
  await settle();
  const d = C.createDraftStore(page.storage).get('data/people');
  assert.deepEqual(JSON.parse(d.files['data/people.json']).groups[1].people.at(-1),
    { name: 'Ada Example', title: 'Student', photo: null, link: null });
  assert.equal(rawEditor(page).value, d.files['data/people.json'], 'the people draft opens (the old #/edit/data/people)');
  assert.ok(page.one((e) => e.attrs['data-locked'] !== undefined));
  assert.deepEqual(page.calls.filter((c) => c.method !== 'GET'), []);
});

test('js/editor.js New project can start from my open proposal: one more commit on its branch', async () => {
  const { writes, onWrite } = recordWrites();
  const page = await editorOn({ onWrite, extra: { pulls: [ownPull()], files: { 7: [] },
    contents: { [HEAD_B]: { 'data/projects.json': readRepo('data/projects.json') } },
    trees: { [MAIN_SHA]: TREE_M, [HEAD_B]: TREE_B } } });
  await openTab(page, 'changes');
  await page.follow(page.linkTo('#/new/project'));
  const field = (k) => fieldOf(page, k);
  assert.deepEqual(field('base').childNodes.map((o) => o.attrs.value), ['', '7']);
  field('base').value = '7';
  field('id').value = 'sonar-rig';
  field('name').value = 'Sonar rig';
  field('tagline').value = 'A tank rig.';
  page.action('make-draft').click();
  await settle();
  const d = C.createDraftStore(page.storage).get('new/project');
  assert.deepEqual({ ...d.base }, { ref: OWN, sha: HEAD_B, number: 7 });
  page.action('propose').click();
  await settle();
  assert.equal(page.action('send-proposal').textContent, 'Add to proposal #7');
  await sendIt(page);
  assert.deepEqual(writeSeq(writes), ['POST /git/blobs', 'POST /git/blobs', 'POST /git/trees', 'POST /git/commits',
    `PATCH /git/refs/heads/${OWN}`]);
  assert.equal(writes[2].body.base_tree, TREE_B);
  assert.ok(cardOpen(page, 7), 'the tray shows proposal #7');
});

test('js/editor.js New person can start from my open proposal: the person joins its branch, one more commit', async () => {
  const onMain = readRepo('data/people.json');
  const reg = JSON.parse(onMain);
  reg.groups[0].people.push({ name: 'Already Proposed', title: 'Student', photo: null, link: null });
  const onBranch = C.formatLike(onMain, reg);
  const { writes, onWrite } = recordWrites();
  const page = await editorOn({ onWrite, extra: { pulls: [ownPull()], files: { 7: [] },
    contents: { [HEAD_B]: { 'data/people.json': onBranch } }, trees: { [MAIN_SHA]: TREE_M, [HEAD_B]: TREE_B } } });
  await openTab(page, 'changes');
  await page.follow(page.linkTo('#/new/person'));
  const field = (k) => fieldOf(page, k);
  assert.deepEqual(field('base').childNodes.map((o) => o.attrs.value), ['', '7']);
  assert.equal(field('base').value, '', 'the live site unless I pick my proposal');
  field('base').value = '7';
  field('group').value = 'alumni';
  field('name').value = 'Ada Example';
  page.action('add-person').click();
  await settle();
  const d = C.createDraftStore(page.storage).get('data/people');
  assert.deepEqual({ ...d.base }, { ref: OWN, sha: HEAD_B, number: 7 });
  const people = JSON.parse(d.files['data/people.json']).groups;
  assert.equal(people[0].people.at(-1).name, 'Already Proposed', 'built on the proposal\'s people, not main\'s');
  assert.equal(people[1].people.at(-1).name, 'Ada Example');
  assert.equal(rawEditor(page).value, d.files['data/people.json'], 'the editor opens the draft on my proposal');
  page.action('propose').click();
  await settle();
  assert.equal(page.action('send-proposal').textContent, 'Add to proposal #7');
  await sendIt(page);
  assert.deepEqual(writeSeq(writes), ['POST /git/blobs', 'POST /git/trees', 'POST /git/commits',
    `PATCH /git/refs/heads/${OWN}`]);
  assert.equal(writes[1].body.base_tree, TREE_B);
});

test('js/editor.js New person: with a people draft already open, the person joins that draft on its base', async () => {
  const people = readRepo('data/people.json');
  const page = await editorOn({ extra: { pulls: [ownPull()], files: { 7: [] },
    contents: { [HEAD_B]: { 'data/people.json': people } }, trees: { [MAIN_SHA]: TREE_M, [HEAD_B]: TREE_B } } });
  await openTab(page, 'changes');
  await page.follow(page.linkTo('#/new/person'));
  const field = (k) => fieldOf(page, k);
  field('base').value = '7';
  field('group').value = 'alumni';
  field('name').value = 'First Person';
  page.action('add-person').click();
  await settle();
  await page.follow(page.linkTo('#/pages'));            // leaving the people draft: "leave?" -> yes (it stays)
  await page.follow(page.linkTo('#/new/person'));
  assert.equal(field('base'), undefined, 'no second base choice: the open draft decides');
  assert.match(page.tray().textContent, /proposal #7/);
  field('group').value = 'alumni';
  field('name').value = 'Second Person';
  page.action('add-person').click();
  await settle();
  const d = C.createDraftStore(page.storage).get('data/people');
  assert.equal(d.base.number, 7);
  assert.deepEqual(JSON.parse(d.files['data/people.json']).groups[1].people.slice(-2).map((p) => p.name),
    ['First Person', 'Second Person']);
});

test('js/editor.js Propose: a 401 after the PR opened keeps it proposed (drafts gone) and ends the session', async () => {
  const rec = recordWrites();
  const onWrite = (method, url, body) => (method === 'PATCH' && /\/pulls\/42$/.test(url)
    ? (rec.writes.push({ method, url, body }), { status: 401, body: {} }) : rec.onWrite(method, url, body));
  const page = await editorOn({ onWrite, extra: { trees: { [MAIN_SHA]: TREE_M } } });
  await openTab(page, 'changes');
  page.action('edit-whole-page').click();
  await settle();
  await page.type(page.textarea(), `${PAGE_TEXT}More.\n`);
  await proposeFrom(page, PAGE_ID, 'Add a line');
  await sendIt(page);
  assert.deepEqual(writeSeq(rec.writes).slice(-2), ['POST /pulls', 'PATCH /pulls/42'], 'the PR opened');
  assert.equal(C.createDraftStore(page.storage).get(PAGE_ID), null, 'never proposed twice');
  assert.equal(controlsOf(page).hidden, true, 'the session ended');
  assert.equal(page.sessions.at(-1), false, 'app.js hears it');
  assert.equal(page.body.classList.contains('hc-editor-on'), false);
  assert.match(page.told.at(-1).text, /Proposed as #42\. Your sign-in has ended/);
});

test('drafts: a /cms/ draft in sessionStorage is the Editor\'s draft of its page — the same key, nothing lost in the move', async () => {
  // a draft /cms/ kept (HCCore.createDraftStore over sessionStorage, key HCCore.DRAFTS_KEY) before the move
  const storage = memoryStorage();
  const changed = `${PAGE_TEXT}Kept across the move.\n`;
  C.createDraftStore(storage).put({ key: PAGE_ID, label: PAGE_LABEL, route: PAGE_ROUTE,
    files: { [PAGE_FILE]: changed }, originals: { [PAGE_FILE]: PAGE_TEXT }, base: { ref: 'main', sha: MAIN_SHA, number: null } });
  assert.ok(storage.getItem(C.DRAFTS_KEY), 'the one key both editors use');
  const page = await editorOn({ storage });
  assert.equal((await page.asks(PAGE_FILE)).text, C.withSentinels(changed, page.nonce().slice(0, 16)),
    'the page shows the draft');
  await openTab(page, 'changes');
  assert.ok(page.one((e) => e.attrs['data-draft'] === PAGE_ID), 'listed with Propose… and Discard');
  page.action('edit-whole-page').click();
  await settle();
  assert.equal(page.textarea().value, changed, 'and edited from where it was left');
});

// ------------------------------------ /cms/ rows, re-homed: source rules ---
/* The js/cms.js rows of test_cms_core.mjs: the source-level promise (it
   holds for js/editor.js now) and the shell (cms/index.html is the redirect
   page), then the session races and the Review rows against the tray. */

test('js/editor.js reaches GitHub only through cms-core; every write is an allowlisted review or Propose request', () => {
  const ui = readRepo('js/editor.js');
  assert.ok(!ui.includes('api.github.com'), 'the UI never builds an API URL itself');
  assert.ok(!/\b(POST|PUT|PATCH|DELETE)\b/.test(ui),
    'the UI names no write verb: writes are HCCore.runReviewAction / runPropose, through the allowlist');
  assert.ok(!/\.send\s*\(/.test(ui), 'the UI never calls client.send() itself');
  // one wrapper hands the network to the client, the sign-in and the readers; no other call
  const WRAPPER = 'const netFetch = (url, init) => (fetchImpl ? fetchImpl(url, init) : window.fetch(url, init));';
  assert.equal(ui.split(WRAPPER).length, 2, 'exactly one fetch wrapper');
  assert.ok(!/\bfetch\s*\(/.test(ui.replace(WRAPPER, '').replace(/HC\.fetch(JSON|Text)\(/g, '')),
    'the UI calls no bare fetch (the client and the sign-in own the network)');
  assert.equal((ui.match(/\bnetFetch\b/g) || []).length, 8,
    'netFetch goes only to the sign-in, the two GitHub clients, the file cache\'s ref fetcher, '
    + 'the /api/media client, the signed direct upload to Cloudinary and the org reader');
  const core = readRepo('js/cms-core.js');
  const verbs = core.match(/method:\s*'[A-Z]+'/g) || [];
  assert.deepEqual([...new Set(verbs)].sort(),
    ["method: 'GET'", "method: 'PATCH'", "method: 'POST'", "method: 'PUT'"]);
  assert.ok(!/\bDELETE\b/.test(core), 'nothing in the CMS deletes');
  // the write verbs appear only in the allowlist and the review / Propose requests it admits
  const allow = core.slice(core.indexOf('const WRITE_METHODS'), core.indexOf('function isAllowedWrite'));
  const review = core.slice(core.indexOf('function reviewRequest'), core.indexOf('const DONE_TEXT'));
  const propose = core.slice(core.indexOf('function proposeRequest'), core.indexOf('function proposeFailure'));
  assert.ok(allow && review && propose);
  // the media section POSTs twice and never to GitHub — to this site's
  // /api/media (the gateway client) and to the signed upload URL (Cloudinary)
  const media = core.slice(core.indexOf('const MEDIA_FUNCTION'), core.indexOf('function imageMarkdown'));
  assert.ok(media);
  assert.deepEqual(media.match(/method:\s*'(POST|PUT|PATCH)'/g), ["method: 'POST'", "method: 'POST'"]);
  assert.deepEqual(media.match(/\bfetch\((\w|\.)+,/g), ['fetch(MEDIA_FUNCTION,', 'fetch(plan.url,']);
  const rest = core.replace(allow, '').replace(review, '').replace(propose, '').replace(media, '');
  assert.deepEqual((rest.match(/method:\s*'(POST|PUT|PATCH)'/g) || []), ["method: 'POST'"],
    'outside them, one POST: the sign-in exchange to /api/auth');
  for (const src of [ui, core]) {
    // (a repository name may hold dots, but never ends in one: that is a full stop)
    const repos = src.match(/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]*[A-Za-z0-9_-]/g) || [];
    for (const r of repos) assert.equal(r, 'repos/desert-mango/hippocampus-docs', r);
  }
});

test('cms/index.html: the redirect page loads only js/cms-redirect.js — no cms.js, no cms-core.js, no cms.css — noindex, and a way back to the site', () => {
  const html = readRepo('cms/index.html');
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(scripts, ['../js/cms-redirect.js']);
  assert.equal((html.match(/<script\b/gi) || []).length, 1, 'one script element, and it has a src: no inline script');
  assert.deepEqual(html.match(/<link\b[^>]*>/gi), null, 'no stylesheet at all (css/cms.css is retired)');
  assert.ok(!/cms\.js|cms-core|cms\.css/.test(html), 'neither the retired editor nor HCCore is named');
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /<a [^>]*href="\.\.\/"/);
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handlers');
  for (const gone of ['js/cms.js', 'css/cms.css', 'tools/tests/test_cms_editor.mjs']) {
    assert.equal(fs.existsSync(path.join(ROOT, gone)), false, `${gone} is retired`);
  }
  // the App's callback page stays where it is (D-I): it is not the redirect page
  assert.ok(fs.existsSync(path.join(ROOT, 'cms', 'callback.html')));
});

// ----------------------------- /cms/ rows, re-homed: the session races ---

const TOKEN_A = '<yours>-token-a';
const TOKEN_B = '<yours>-token-b';
const bearer = (init) => String((init.headers && (init.headers.Authorization || init.headers.authorization)) || '')
  .replace(/^Bearer /, '');
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
const whoOf = (page) => (page.one((e) => e.classList.contains('hc-who')) || { textContent: '' }).textContent;

/* GitHub as one signed-in person sees it: /user, this repository (`repo` is
   its answer), no open PRs; anything else of GitHub's 404. */
function githubFor(login, repo) {
  return (url) => {
    if (url === 'https://api.github.com/user') return answer(200, { login });
    if (url === REPO_API) return repo;
    if (url.startsWith(`${REPO_API}/pulls?`)) return answer(200, []);
    return answer(404, { message: 'Not Found' });
  };
}
const asBob = () => githubFor('bob', answer(200, { permissions: { push: true } }));
const isGitHub = (url) => url.indexOf('https://api.github.com/') === 0;

/* alice's session in sessionStorage (as a reload finds it); `route` answers
   every GitHub call by token. */
function raceSite(route, editorState) {
  const storage = memoryStorage();
  C.writeSession(storage, C.makeSession(TOKEN_A, null, 'alice', Date.now()));
  if (editorState) storage.setItem('hc-editor', JSON.stringify(editorState));
  const page = openSite({ session: null, storage, hash: `#${PAGE_ROUTE}`,
    intercept: (url, init) => (isGitHub(url) ? route(url, init) : null) });
  return page;
}

/* Sign out (the avatar menu), then sign in as bob (the session a finished sign-in writes). */
async function signOutThenInAsBob(page) {
  page.action('sign-out').click();
  await settle();
  C.writeSession(page.storage, C.makeSession(TOKEN_B, null, 'bob', Date.now()));
  page.win.HCEditor.refresh();
  await settle();
  assert.match(whoOf(page), /bob/);
  assert.match(whoOf(page), /Editor/);
}

test('js/editor.js: a refresh that lands after sign-out and a new sign-in changes nothing', async () => {
  const held = deferred();                       // alice's answers, held back
  const alice = githubFor('alice', answer(200, { permissions: { admin: true, push: true } }));
  const bob = asBob();
  const page = raceSite((url, init) => (bearer(init) === TOKEN_A ? held.promise.then(() => alice(url)) : bob(url)));
  await settle();
  assert.equal(page.switchBtn().disabled, true, 'checking your access: the switch waits');
  await signOutThenInAsBob(page);
  held.resolve();
  await settle();
  assert.match(whoOf(page), /bob/);
  assert.match(whoOf(page), /Editor/);
  assert.doesNotMatch(whoOf(page), /Admin|alice/, 'the old answer wrote nothing');
  assert.equal(C.readSession(page.storage, Date.now()).login, 'bob');
});

test('js/editor.js: a "no access" answer that lands after sign-out leaves the signed-out page alone', async () => {
  const held = deferred();
  const alice = githubFor('alice', answer(404, { message: 'Not Found' }));
  const page = raceSite((url) => held.promise.then(() => alice(url)));
  await settle();
  page.action('sign-out').click();
  await settle();
  held.resolve();
  await settle();
  assert.equal(controlsOf(page).hidden, true, 'signed out: no switch, no avatar');
  assert.equal(page.sessions.at(-1), false, 'app.js shows "Sign in to edit" again');
  assert.doesNotMatch(page.tray().textContent, /do not have access/);
  assert.ok(!page.told.some((t) => /do not have access/.test(t.text)));
  assert.equal(page.told.at(-1).text, 'Signed out.');
});

test('js/editor.js: an old session\'s 401 does not end the session that replaced it', async () => {
  const held = deferred();
  const bob = asBob();
  const page = raceSite((url, init) => (bearer(init) === TOKEN_A
    ? held.promise.then(() => answer(401, { message: 'Bad credentials' })) : bob(url)));
  await settle();
  await signOutThenInAsBob(page);
  held.resolve();
  await settle();
  assert.equal(C.readSession(page.storage, Date.now()).login, 'bob');
  assert.match(whoOf(page), /bob/);
  assert.ok(!page.told.some((t) => /sign-in has ended/.test(t.text)));
});

test('js/editor.js: a 401 for a list the old session asked for does not end the new session', async () => {
  const held = deferred();
  const alice = githubFor('alice', answer(200, { permissions: { push: true } }));
  const bob = asBob();
  // Editor on with the Proposals tab open (the reload of a tab that had it): the lists are asked at once
  const page = raceSite((url, init) => {
    if (bearer(init) !== TOKEN_A) return bob(url);
    if (url.includes('/pulls?')) return held.promise.then(() => answer(401, { message: 'Bad credentials' }));
    return alice(url);
  }, { on: true, tab: 'proposals', tray: true });
  await settle();
  assert.match(whoOf(page), /alice/, 'signed in; the Proposals tab waits on its lists');
  assert.ok(page.calls.some((c) => c.url.includes('/pulls?')), 'the old session asked for a list');
  await signOutThenInAsBob(page);
  held.resolve();
  await settle();
  assert.equal(C.readSession(page.storage, Date.now()).login, 'bob');
  assert.match(whoOf(page), /bob/);
  assert.ok(!page.told.some((t) => /sign-in has ended/.test(t.text)));
});

// --------------------------------- /cms/ rows, re-homed: the Review card ---
/* /cms/'s #/, #/review and #/review/<n> are the Proposals tab: a card per
   open proposal, expanded in place, and "Show on page" for the preview. */

const T0 = Date.parse('2026-09-21T12:00:00Z');
const minutesAgo = (m) => new Date(T0 - m * 60000).toISOString();
const prRow = (number, login, extra) => Object.assign(
  { number, state: 'open', title: `PR ${number}`, user: { login } }, extra || {});
function closedRows(from, to, merged) {
  const rows = [];
  for (let k = from; k < to; k += 1) {
    const m = merged ? merged(k) : null;
    rows.push(prRow(k + 1, 'a', { state: 'closed', updated_at: minutesAgo(k),
      merged_at: m === null || m === undefined ? null : minutesAgo(m) }));
  }
  return rows;
}
const CLOSED_PATH = '/repos/desert-mango/hippocampus-docs/pulls'
  + '?state=closed&sort=updated&direction=desc&per_page=100';
const pagePaths = (n) => Array.from({ length: n }, (_, i) => `${CLOSED_PATH}&page=${i + 1}`);

/* PR #1's head 825bab4 (its `check` run green) and GET /pulls/1/files, cut
   down from the real API (read-only, 2026-09-21), as test_cms_core.mjs has them. */
const HEAD_1 = '825bab4fa43bfb10964621d1e4d8476b5971dc78';
const RUN_URL = 'https://github.com/desert-mango/hippocampus-docs/actions/runs/35633224472/job/106444242358';
const ACTIONS_APP = { id: 15368, slug: 'github-actions', name: 'GitHub Actions' };
function gateRun(extra) {
  return Object.assign({
    id: 106444242358, name: 'check', head_sha: HEAD_1, status: 'completed', conclusion: 'success',
    html_url: RUN_URL, details_url: RUN_URL,
    started_at: '2026-09-21T17:37:49Z', completed_at: '2026-09-21T17:37:56Z',
    output: { title: null, summary: null, text: null, annotations_count: 0,
      annotations_url: `${REPO_API}/check-runs/106444242358/annotations` },
    app: ACTIONS_APP,
  }, extra || {});
}
const runs = (...rs) => ({ total_count: rs.length, check_runs: rs });
const fileRow = (filename, extra) => Object.assign({ sha: 'b'.repeat(40), filename, status: 'modified',
  additions: 1, deletions: 1, changes: 2, patch: '@@ -1 +1 @@\n-old\n+new' }, extra || {});
const PR1_FILES = ['concepts/colcon', 'concepts/pre-built-packages', 'getting-started/px4-setup',
  'getting-started/ros-installation', 'lab-cameras/event-cameras', 'raspberry-pi/ethernet',
  'raspberry-pi/uart-configuration', 'raspberry-pi/ubuntu-24-04-server', 'raspberry-pi/usb-configuration']
  .map((id) => fileRow(`content/setup/${id}.md`))
  .concat([fileRow('search/manifest.json'), fileRow('search/site.json')]);
const HOURS = 3600e3;

// an answer whose body is raw text when given a string (the Contents API's raw media type)
const wire = (status, body) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null },
    text: async () => text, json: async () => JSON.parse(text) };
};

/* GitHub for the Review card: `login` signed in with `perms`; `pulls` maps
   number -> {pull, files, runs, annotations, comments}; `contents` maps
   "<path>@<sha>" -> text; `onWrite(method, url, body)` answers every write
   (a 200 by default). Anything else (main's head, its files) goes to the
   fake GitHub. */
function reviewGithub(o) {
  return (url, init) => {
    if (!isGitHub(url)) return null;
    const method = init.method || 'GET';
    if (method !== 'GET') return o.onWrite ? o.onWrite(method, url, JSON.parse(init.body)) : wire(200, {});
    if (url === 'https://api.github.com/user') return wire(200, { login: o.login });
    if (url === REPO_API) return wire(200, { permissions: o.perms });
    const rest = url.slice(REPO_API.length);
    if (rest.startsWith('/pulls?state=open')) return wire(200, Object.values(o.pulls).map((x) => x.pull));
    if (rest.startsWith('/pulls?state=closed')) {
      if (o.closedPages) {
        const m = /[?&]page=(\d+)(?:&|$)/.exec(rest);
        return wire(200, o.closedPages[(m ? Number(m[1]) : 1) - 1] || []);
      }
      return wire(200, o.closed || []);
    }
    let m = /^\/pulls\/(\d+)(\/files\?.*)?$/.exec(rest);
    if (m && o.pulls[m[1]]) return wire(200, m[2] ? o.pulls[m[1]].files : o.pulls[m[1]].pull);
    m = /^\/commits\/([0-9a-f]{40})\/check-runs\?/.exec(rest);
    if (m) {
      const hit = Object.values(o.pulls).find((x) => x.pull.head.sha === m[1]);
      return wire(200, (hit && hit.runs) || runs());
    }
    m = /^\/check-runs\/(\d+)\/annotations\?/.exec(rest);
    if (m) {
      const hit = Object.values(o.pulls).find((x) => x.runs && x.runs.check_runs.some((r) => String(r.id) === m[1]));
      return wire(200, (hit && hit.annotations) || []);
    }
    m = /^\/issues\/(\d+)\/comments\?/.exec(rest);
    if (m) return wire(200, (o.pulls[m[1]] && o.pulls[m[1]].comments) || []);
    m = /^\/contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(rest);
    if (m && o.contents && o.contents[`${m[1]}@${m[2]}`] !== undefined) return wire(200, o.contents[`${m[1]}@${m[2]}`]);
    return null;
  };
}

function openPull(number, login, sha, extra) {
  return Object.assign({ number, state: 'open', merged: false, merged_at: null, title: `Proposal ${number}`,
    user: { login }, created_at: new Date(Date.now() - 3 * 24 * HOURS).toISOString(),
    head: { sha, ref: `cms/${login}/fix-${number}` }, base: { ref: 'main' }, html_url: C.undoOnGitHubUrl(number) },
  extra || {});
}
function greenPr1(extra) {
  return { pull: openPull(1, 'kyle-nelson-berkeley', HEAD_1), files: PR1_FILES, runs: runs(gateRun()),
    comments: [{ user: { login: 'vercel[bot]' }, html_url: `${C.undoOnGitHubUrl(1)}#issuecomment-5696197254` }],
    ...extra };
}
const PR1_CONTENTS = { [`data/setup.json@${HEAD_1}`]: JSON.stringify(REGS_NOW.setup),
  [`content/setup/concepts/colcon.md@${HEAD_1}`]: '# Colcon\n\nThe fixed text.' };

/* The site on #/ with ?editor=proposals[&pr=n] (the redirect's landing for
   /cms/#/review[/n]): Editor on, the tray open on that card. */
async function reviewSite(login, o, n) {
  const page = openSite({ hash: n ? `#/?editor=proposals&pr=${n}` : '#/?editor=proposals',
    session: C.makeSession(TOKEN_A, null, login, Date.now()), intercept: reviewGithub(Object.assign({ login }, o)) });
  await settle();
  return page;
}
const reviewBox = (page) => page.one((e) => e.tagName === 'SECTION' && e.attrs['aria-label'] === 'Review actions');
const actionButtons = (page) => (reviewBox(page) ? findAll(reviewBox(page), (e) => e.attrs['data-action'] !== undefined) : []);
const actionButton = (page, key) => actionButtons(page).find((e) => e.attrs['data-action'] === key);
const ghWrites = (page) => page.github().filter((c) => c.method !== 'GET');
const trayText = (page) => page.tray().textContent;

test('js/editor.js: "Recently merged" finds a merge on the second page of closed PRs', async () => {
  const closedPages = [closedRows(0, 100), closedRows(100, 120, (k) => (k === 110 ? 110 : null))];
  closedPages[1][10].title = 'Fix the wiring diagram';
  const page = await reviewSite('bob', { perms: { push: true }, pulls: {}, closedPages });
  assert.match(trayText(page), /Recently merged/);
  assert.match(trayText(page), /#111Fix the wiring diagram/);
  assert.doesNotMatch(trayText(page), /Nothing merged recently/);
  assert.deepEqual(page.calls.filter((c) => c.url.includes('state=closed')).map((c) => c.url),
    pagePaths(2).map((p) => `https://api.github.com${p}`));
});

test('js/editor.js Review list: mine first, author, age, files count, both badges; a title stays text', async () => {
  const pulls = {
    5: { pull: openPull(5, 'alice', 'c'.repeat(40), { title: '<script>alert(1)</script> fix the nav' }),
      files: [fileRow('js/app.js')] },
    6: { pull: openPull(6, 'bob', 'd'.repeat(40)), files: [fileRow('content/about.md'), fileRow('search/site.json')] },
  };
  const page = await reviewSite('bob', { perms: { push: true }, pulls });
  const card = (n) => page.one((e) => e.attrs['data-pr'] === String(n));
  const text = trayText(page);
  assert.ok(text.indexOf('#6') < text.indexOf('#5'), 'my proposal first');
  assert.match(card(6).textContent, /^#6Proposal 6yours(touches this page)?by bob, opened 3 days ago2 filesderived files/);
  assert.match(card(5).textContent, /^#5<script>alert\(1\)<\/script> fix the nav(touches this page)?by alice, opened 3 days ago1 filemachinery/);
  const badges = page.all((e) => /cms-badge-/.test(e.className));
  assert.deepEqual(badges.map((e) => [e.textContent, e.attrs.title]), [
    ['derived files', C.DERIVED_TEXT], ['machinery', 'needs a code review by Desert Mango']]);
  assert.equal(page.all((e) => e.tagName === 'SCRIPT').length, 0, 'the title is text');
  assert.deepEqual(ghWrites(page), []);
  assert.ok(page.calls.some((c) => c.url === `${REPO_API}/pulls/5/files?per_page=100&page=1`));
});

test('js/editor.js Review PR: green ✓, the diff as text, Vercel\'s comment, and the preview at the PR head', async () => {
  const page = await reviewSite('desert-mango-robotics', { perms: { admin: true, push: true },
    pulls: { 1: greenPr1() }, contents: PR1_CONTENTS }, 1);
  const text = trayText(page);
  assert.match(text, /✓site rules pass/);
  assert.match(text, /content\/setup\/concepts\/colcon\.md/);
  assert.match(text, /-old\n\+new/, 'the patch is shown as text');
  assert.match(text, /derived files/);
  assert.equal(page.one((e) => e.classList.contains('cms-preview-scope')), undefined,
    'a content-only proposal: "Show on page" shows every change, no "content only" note');
  const vercel = page.all((e) => e.tagName === 'A' && /issuecomment/.test(e.attrs.href || ''));
  assert.equal(vercel.length, 1);
  assert.deepEqual(actionButtons(page).map((b) => b.attrs['data-action']),
    ['approve', 'request-changes', 'merge', 'update', 'close']);
  assert.equal(actionButton(page, 'merge').disabled, false, 'green: Merge is live');
  assert.doesNotMatch(text, /Merge anyway/, 'green asks no confirmation');
  // the preview: "Show on page" puts the first changed page, at the PR head, in the sandboxed frame
  page.action('show-on-page').click();
  await settle();
  assert.equal(page.location.hash, '#/setup/concepts/colcon');
  await firedHash(page);
  const frame = page.frame();
  assert.equal(frame.attrs.sandbox, 'allow-scripts allow-popups');
  const m = /^index\.html#preview=([0-9a-f]{32})&route=(.+)$/.exec(frame.srcs.at(-1));
  assert.ok(m, frame.srcs.at(-1));
  assert.equal(decodeURIComponent(m[2]), '/setup/concepts/colcon');
  const hit = await page.asks('content/setup/concepts/colcon.md');
  assert.deepEqual([hit.type, hit.nonce, hit.ok, hit.status, hit.text],
    ['hc-file', m[1], true, 200, '# Colcon\n\nThe fixed text.']);
  assert.ok(!JSON.stringify(frame.posted).includes(TOKEN_A), 'the token never reaches the frame');
  assert.ok(page.calls.some((c) => c.url === `${REPO_API}/contents/content/setup/concepts/colcon.md?ref=${HEAD_1}`));
  // navigable: another changed page re-loads the frame there with a fresh nonce
  page.one((e) => e.attrs['data-route'] === '/setup/raspberry-pi/ethernet').click();
  await settle();
  await firedHash(page);
  const m2 = /#preview=([0-9a-f]{32})&route=(.+)$/.exec(page.frame().srcs.at(-1));
  assert.notEqual(m2[1], m[1]);
  assert.equal(decodeURIComponent(m2[2]), '/setup/raspberry-pi/ethernet');
  assert.deepEqual(ghWrites(page), [], 'looking writes nothing');
});

test('js/editor.js Review PR: a proposal that changes the site\'s code labels its preview "content only"', async () => {
  const files = PR1_FILES.concat([fileRow('js/app.js')]);
  const page = await reviewSite('desert-mango-robotics', { perms: { admin: true, push: true },
    pulls: { 1: greenPr1({ files }) }, contents: PR1_CONTENTS }, 1);
  const scope = page.one((e) => e.classList.contains('cms-preview-scope'));
  assert.ok(scope, 'the note');
  assert.equal(scope.textContent, C.PREVIEW_CONTENT_ONLY_TEXT);
  // still a preview of the head's content, in the same sandboxed frame: no proposal code runs
  const show = findAll(scope.parent, (e) => e.attrs['data-action'] === 'show-on-page');
  assert.equal(show.length, 1, 'the note leads "Show on page"');
  show[0].click();
  await settle();
  await firedHash(page);
  assert.match(page.frame().srcs.at(-1), /^index\.html#preview=[0-9a-f]{32}&route=/);
  assert.equal(page.frame().attrs.sandbox, 'allow-scripts allow-popups');
  assert.deepEqual(ghWrites(page), []);
});

/* Red or still checking: Merge is live; the first click sends nothing and
   asks once; "Merge anyway" sends exactly the one PUT, pinned to the sha. */
async function confirmThenMerge(page, sha) {
  const merge = actionButton(page, 'merge');
  assert.equal(merge.disabled, false, 'Merge is never disabled');
  assert.doesNotMatch(trayText(page), /Merge anyway/);
  merge.click();
  await settle();
  assert.deepEqual(ghWrites(page), [], 'the first click sends nothing');
  assert.match(trayText(page), new RegExp(C.MERGE_CONFIRM_TEXT.replace(/[.()?]/g, '\\$&')));
  const anyway = actionButton(page, 'merge-anyway');
  assert.equal(anyway.textContent, 'Merge anyway');
  anyway.click();
  await settle();
  assert.deepEqual(page.writeLog.map((c) => [c.method, c.url, c.body]),
    [['PUT', `${REPO_API}/pulls/1/merge`, { merge_method: 'squash', sha }]]);
}
const logged = (o) => {
  const log = [];
  return { log, onWrite: (method, url, body) => { log.push({ method, url, body }); return o ? o(method, url, body) : wire(200, {}); } };
};

test('js/editor.js Review PR: red ✗ with each annotation as "file, line, what to fix" and a link to the run', async () => {
  const red = greenPr1({ runs: runs(gateRun({ conclusion: 'failure' })), annotations: [
    { path: 'data/tools.json', start_line: 12, annotation_level: 'failure', message: 'trailing comma' },
    { path: 'content/about.md', start_line: null, annotation_level: 'failure', message: 'no title line' }] });
  const w = logged();
  const page = await reviewSite('nathalie', { perms: { maintain: true, push: true }, pulls: { 1: red },
    contents: PR1_CONTENTS, onWrite: w.onWrite }, 1);
  page.writeLog = w.log;
  const text = trayText(page);
  assert.match(text, /✗site rules fail/);
  assert.match(text, /data\/tools\.json, line 12: trailing comma/);
  assert.match(text, /content\/about\.md: no title line/);
  assert.ok(page.calls.some((c) => c.url === `${REPO_API}/check-runs/106444242358/annotations?per_page=100&page=1`));
  assert.equal(page.all((e) => e.tagName === 'A' && e.attrs.href === RUN_URL).length, 1);
  await confirmThenMerge(page, HEAD_1);
});

test('js/editor.js Review PR: no finished run yet is "still checking", and asks for no annotations', async () => {
  const waiting = () => greenPr1({ runs: runs(gateRun({ status: 'in_progress', conclusion: null })) });
  const page = await reviewSite('nathalie', { perms: { push: true }, pulls: { 1: waiting() }, contents: PR1_CONTENTS }, 1);
  assert.match(trayText(page), /still checking/);
  const w = logged();
  const boss = await reviewSite('nathalie', { perms: { maintain: true, push: true }, pulls: { 1: waiting() },
    contents: PR1_CONTENTS, onWrite: w.onWrite }, 1);
  boss.writeLog = w.log;
  await confirmThenMerge(boss, HEAD_1);
  assert.ok(!page.calls.some((c) => c.url.includes('/annotations')));
  assert.deepEqual(actionButtons(page).map((b) => b.attrs['data-action']),
    ['approve', 'request-changes', 'update', 'close'], 'an Editor gets no Merge button');
});

test('js/editor.js Review PR: Merge sends exactly one PUT pinned to the shown sha; a 409 says reload', async () => {
  const w = logged(() => wire(409, { message: 'Head branch was modified.' }));
  const github = reviewGithub({ login: 'desert-mango-robotics', perms: { admin: true, push: true }, pulls: { 1: greenPr1() },
    contents: PR1_CONTENTS, onWrite: w.onWrite });
  const writeInits = [];                                   // the init of each write, for its Authorization header
  const page = openSite({ hash: '#/?editor=proposals&pr=1',
    session: C.makeSession(TOKEN_A, null, 'desert-mango-robotics', Date.now()),
    intercept: (url, init) => { if ((init.method || 'GET') !== 'GET') writeInits.push(init); return github(url, init); } });
  await settle();
  const before = page.calls.filter((c) => c.url === `${REPO_API}/pulls/1`).length;
  actionButton(page, 'merge').click();                    // green: one click, one PUT
  await settle();
  assert.deepEqual(w.log, [{ method: 'PUT', url: `${REPO_API}/pulls/1/merge`, body: { merge_method: 'squash', sha: HEAD_1 } }]);
  assert.equal(actionButton(page, 'merge-anyway'), undefined, 'no confirmation step on green');
  assert.equal(ghWrites(page).length, 1);
  assert.equal(bearer(writeInits[0]), TOKEN_A, 'the merge carries the signed-in token');
  assert.match(trayText(page), /Not merged: it changed since you looked, reload\./);
  assert.equal(page.calls.filter((c) => c.url === `${REPO_API}/pulls/1`).length, before + 1, 'the card was read again');
});

test('js/editor.js Review PR: approving your own proposal shows GitHub\'s refusal in the tab\'s words', async () => {
  const w = logged(() => wire(422, { message: 'Unprocessable Entity', errors: ['Review Can not approve your own pull request'] }));
  const page = await reviewSite('kyle-nelson-berkeley', { perms: { admin: true, push: true }, pulls: { 1: greenPr1() },
    contents: PR1_CONTENTS, onWrite: w.onWrite }, 1);
  actionButton(page, 'approve').click();
  await settle();
  assert.deepEqual(w.log.map((c) => [c.method, c.url, c.body]),
    [['POST', `${REPO_API}/pulls/1/reviews`, { event: 'APPROVE', commit_id: HEAD_1 }]]);
  assert.match(trayText(page), /GitHub does not let you approve your own proposal\./);
});

test('js/editor.js Review PR: request changes needs a comment; close and update send their one write', async () => {
  const seen = [];
  const page = await reviewSite('nathalie', { perms: { maintain: true, push: true }, pulls: { 1: greenPr1() },
    contents: PR1_CONTENTS,
    onWrite: (method, url, body) => { seen.push([method, url.slice(REPO_API.length), body]); return wire(200, {}); } }, 1);
  actionButton(page, 'request-changes').click();
  await settle();
  assert.deepEqual(seen, [], 'no comment, nothing sent');
  assert.match(trayText(page), /write what should change/);
  const box = findAll(reviewBox(page), (e) => e.tagName === 'TEXTAREA')[0];
  box.value = 'Please keep the old heading.';
  actionButton(page, 'request-changes').click();
  await settle();
  assert.match(trayText(page), /Changes requested\./);
  actionButton(page, 'update').click();
  await settle();
  // Update from main stays pending while the card waits for the head to move (here it never does)
  for (let i = 0; i < 30 && /Updating…/.test(trayText(page)); i += 1) await settle();
  assert.doesNotMatch(trayText(page), /Updating…/, 'the wait is over: the card is drawn again');
  actionButton(page, 'close').click();
  await settle();
  assert.deepEqual(seen, [
    ['POST', '/pulls/1/reviews', { event: 'REQUEST_CHANGES', body: 'Please keep the old heading.', commit_id: HEAD_1 }],
    ['PUT', '/pulls/1/update-branch', { expected_head_sha: HEAD_1 }],
    ['PATCH', '/pulls/1', { state: 'closed' }],
  ]);
});

test('js/editor.js Review PR: Read-only sees the proposal and its preview, and no button at all', async () => {
  const page = await reviewSite('visitor', { perms: { pull: true }, pulls: { 1: greenPr1() }, contents: PR1_CONTENTS }, 1);
  assert.match(trayText(page), /site rules pass/);
  assert.deepEqual(actionButtons(page), [], 'no review button');
  assert.match(trayText(page), /You can read this proposal\. Reviewing it needs write access/);
  assert.ok(page.action('show-on-page'), 'its preview: "Show on page"');
  assert.equal(page.frames().length, 1, 'the page frame');
  assert.deepEqual(ghWrites(page), []);
});

test('js/editor.js Review PR: a merged proposal offers one button, Undo on GitHub, and nothing else', async () => {
  const merged = { pull: openPull(3, 'alice', 'e'.repeat(40),
    { state: 'closed', merged: true, merged_at: '2026-09-20T10:00:00Z' }), files: [fileRow('content/about.md')] };
  const page = await reviewSite('nathalie', { perms: { maintain: true, push: true }, pulls: { 3: merged } }, 3);
  const card = page.one((e) => e.attrs['data-pr'] === '3');
  const undo = findAll(card, (e) => e.attrs['data-action'] !== undefined);
  assert.deepEqual(undo.map((b) => [b.tagName, b.attrs['data-action'], b.textContent, b.attrs.href]),
    [['A', 'undo', 'Undo on GitHub', 'https://github.com/desert-mango/hippocampus-docs/pull/3']]);
  assert.equal(undo[0].attrs.rel, 'noopener noreferrer');
  assert.match(card.textContent, /Revert/);
  assert.ok(!page.calls.some((c) => c.url.includes('/check-runs') && c.url.includes('e'.repeat(40))));
  assert.deepEqual(ghWrites(page), []);
});

test('js/editor.js home: each recently merged proposal links to its Review page (where Undo is)', async () => {
  const closed = [openPull(3, 'alice', 'e'.repeat(40), { state: 'closed', merged: true,
    merged_at: '2026-09-20T10:00:00Z', updated_at: '2026-09-20T10:00:00Z', title: 'Fix the nav' })];
  const page = await reviewSite('nathalie', { perms: { push: true }, pulls: {}, closed });
  assert.match(trayText(page), /Recently merged#3Fix the nav/);
  const links = page.all((e) => e.tagName === 'A' && e.attrs.href === '#/review/3');
  assert.equal(links.length, 1);
  await page.follow(links[0]);
  assert.ok(cardOpen(page, 3), 'its card opens in place');
});

// ----------------------------------------- /cms/ rows, re-homed: Media ---
/* The js/cms.js rows of test_cms_media.mjs: the Media tab, "Image from
   Media" in the Changes tab's block editor, and New person's "Photo from
   Media", over a fake /api/media and a fake Cloudinary. */

const MANIFEST_TEXT = readRepo('data/cloudinary-manifest.json');
const LIVE = JSON.parse(MANIFEST_TEXT);
const CLOUD = LIVE.cloud;
const USED = LIVE.assets[0];
const FREE_ID = 'hippocampus-docs/setup/old-sketch';
const FREE_URL = `https://res.cloudinary.com/${CLOUD}/image/upload/v1790000000/${FREE_ID}.png`;
const TS = '1790000000';
const SIG = 'a'.repeat(64);
const API_KEY = '123456789012345';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const shaOf = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fakeFile = (bytes, o) => Object.assign({ name: 'Hippo Mark.png', type: 'image/png', size: bytes.length,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }, o || {});
function signed(mode, sub, slug) {
  const s = sub || 'setup';
  const folder = `hippocampus-docs/${s}`;
  const params = mode === 'dynamic'
    ? { asset_folder: folder, overwrite: 'false', public_id: `${folder}/${slug || 'hippo-mark'}`, timestamp: TS }
    : { folder, overwrite: 'false', public_id: slug || 'hippo-mark', timestamp: TS };
  return { cloud_name: CLOUD, api_key: API_KEY, timestamp: Number(TS), signature: SIG, params };
}
const uploaded = (id, bytes) => ({ public_id: id, version: 1790000001, format: 'png', bytes: bytes || 2048,
  secure_url: `https://res.cloudinary.com/${CLOUD}/image/upload/v1790000001/${id}.png` });

/* This site's /api/media and Cloudinary's upload endpoint; every request is
   logged with the side it went to. GitHub is the fake (main, its files). */
function mediaWorld(o) {
  const x = o || {};
  const log = [];
  const intercept = (url, init) => {
    if (url === '/api/media') {
      const body = JSON.parse(init.body);
      log.push({ side: 'media', url, init, body });
      if (x.media && x.media[body.action]) return x.media[body.action](body);
      if (body.action === 'sign') return wire(200, signed(x.mode || 'fixed', body.subfolder));
      if (body.action === 'list') {
        const pages = x.pages || { first: { assets: [], next_cursor: null } };
        return wire(200, pages[body.cursor || 'first']);
      }
      if (body.action === 'destroy') return wire(200, { result: 'ok', public_id: body.public_id });
      return wire(400, { error: 'unexpected' });
    }
    if (url.startsWith('https://api.cloudinary.com/')) {
      log.push({ side: 'cloudinary', url, init, body: init.body });
      const folder = init.body.entries.find((e) => e[0] === 'folder')[1].split('/').pop();
      return wire(200, uploaded(`hippocampus-docs/${folder}/hippo-mark`, 2048));
    }
    return null;
  };
  return { intercept, media: () => log.filter((c) => c.side === 'media'), cloud: () => log.filter((c) => c.side === 'cloudinary') };
}
const uploadFile = async (page, file, folder) => {
  fieldOf(page, 'media-folder').value = folder || 'setup';
  fieldOf(page, 'media-file').files = [file];
  page.action('media-upload').click();
  await settle();
};
const draftOfKey = (page, key) => C.createDraftStore(page.storage).get(key);
/* Editor on, the first paragraph picked, its "Image from Media" open. */
async function mediaInBlock(opts) {
  const page = await editorOn(opts);
  const i = firstParagraph(PAGE_TEXT);
  await page.send({ type: 'hc-block-select', index: i });
  page.action('media-open').click();
  await settle();
  return { page, b: blocksOf(PAGE_TEXT)[i] };
}

test('js/editor.js #/media: the images with c_limit,w_240 thumbnails, "on the site" marks, and a next page on next_cursor', async () => {
  const pages = {
    first: { assets: [{ public_id: USED.public_id, url: USED.url, bytes: USED.bytes, width: 800, height: 600, format: 'jpg' },
      { public_id: FREE_ID, url: FREE_URL, bytes: 1200, width: 300, height: 200, format: 'png' }], next_cursor: 'c2' },
    c2: { assets: [{ public_id: 'hippocampus-docs/brand/spare', url: `https://res.cloudinary.com/${CLOUD}/image/upload/v1/hippocampus-docs/brand/spare.png`,
      bytes: 10, width: 1, height: 1, format: 'png' }], next_cursor: null },
  };
  const w = mediaWorld({ pages });
  const page = await editorOn({ intercept: w.intercept });
  assert.ok(page.tab('media'), 'the tray has a Media tab');
  await openTab(page, 'media');
  const tiles = () => page.all((e) => e.attrs['data-asset'] !== undefined);
  assert.deepEqual(tiles().map((t) => t.attrs['data-asset']), [USED.public_id, FREE_ID]);
  const thumbs = page.all((e) => e.tagName === 'IMG' && /c_limit,w_240/.test(e.attrs.src || ''));
  assert.deepEqual(thumbs.map((i) => i.attrs.src), [C.thumbUrl(USED.url), C.thumbUrl(FREE_URL)]);
  assert.match(tiles()[0].textContent, /on the site/);
  assert.match(tiles()[1].textContent, /not used by the site/);
  // the folder picker is the fixed list
  assert.deepEqual(fieldOf(page, 'media-folder').childNodes.map((o) => o.attrs.value), C.MEDIA_SUBFOLDERS);
  page.action('media-more').click();
  await settle();
  assert.deepEqual(w.media().map((c) => c.body), [{ action: 'list' }, { action: 'list', cursor: 'c2' }]);
  assert.equal(tiles().length, 3);
  assert.equal(page.action('media-more'), undefined, 'no more pages');
  for (const c of w.media()) assert.equal(c.init.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(page.github().filter((c) => c.method !== 'GET'), []);
});

test('js/editor.js #/media: delete of an image the site uses says the verbatim line and calls nothing; a free one asks, then deletes', async () => {
  const pages = { first: { assets: [{ public_id: USED.public_id, url: USED.url, bytes: 1 },
    { public_id: FREE_ID, url: FREE_URL, bytes: 1 }], next_cursor: null } };
  const w = mediaWorld({ pages });
  const page = await editorOn({ intercept: w.intercept });
  const asked = [];
  page.win.confirm = (text) => { asked.push(text); return true; };
  await openTab(page, 'media');
  const tile = (id) => page.one((e) => e.attrs['data-asset'] === id);
  const inTile = (id, action) => findAll(tile(id), (e) => e.attrs['data-action'] === action)[0];
  inTile(USED.public_id, 'media-delete').click();
  await settle();
  assert.ok(tile(USED.public_id).textContent.includes('remove it from the page first, merge, then delete'));
  inTile(USED.public_id, 'media-rename').click();
  await settle();
  assert.equal(fieldOf(page, 'media-new-name'), undefined, 'no rename form for an image in use');
  assert.deepEqual(w.media().map((c) => c.body.action), ['list'], 'no destroy or rename was sent');
  assert.deepEqual(asked, []);
  inTile(FREE_ID, 'media-delete').click();
  await settle();
  assert.equal(asked.length, 1);
  assert.match(asked[0], /old-sketch/);
  assert.deepEqual(w.media().at(-1).body, { action: 'destroy', public_id: FREE_ID });
  assert.equal(tile(FREE_ID), undefined, 'the deleted image leaves the list');
});

test('js/editor.js #/media: a 409 from the gateway (the site started using it) shows the same line; rename sends {from, to}', async () => {
  const pages = { first: { assets: [{ public_id: FREE_ID, url: FREE_URL, bytes: 1 }], next_cursor: null } };
  const w = mediaWorld({ pages, media: {
    destroy: () => wire(409, { error: `${FREE_ID} is still referenced by the site` }),
    rename: (b) => wire(200, { public_id: b.to, url: FREE_URL.replace('old-sketch', 'new-sketch') }),
  } });
  const page = await editorOn({ intercept: w.intercept });
  await openTab(page, 'media');
  const tile = () => page.one((e) => e.attrs['data-asset'] !== undefined);
  const inTile = (action) => findAll(tile(), (e) => e.attrs['data-action'] === action)[0];
  inTile('media-delete').click();
  await settle();
  assert.ok(tile().textContent.includes(C.IN_USE_TEXT));
  inTile('media-rename').click();
  await settle();
  fieldOf(page, 'media-new-name').value = 'New Sketch!';
  page.action('media-rename-save').click();
  await settle();
  assert.match(tile().textContent, /lowercase letters, digits and dashes/);
  fieldOf(page, 'media-new-name').value = 'new-sketch';
  page.action('media-rename-save').click();
  await settle();
  assert.deepEqual(w.media().at(-1).body, { action: 'rename', from: FREE_ID, to: 'hippocampus-docs/setup/new-sketch' });
  assert.equal(tile().attrs['data-asset'], 'hippocampus-docs/setup/new-sketch');
});

test('js/editor.js editor: Image from Media uploads (sign -> Cloudinary), adds ONE manifest entry, inserts ![alt](url), proposes both files', async () => {
  const w = mediaWorld();
  const { writes, onWrite } = recordWrites();
  const { page, b } = await mediaInBlock({ intercept: w.intercept, onWrite, extra: { trees: { [MAIN_SHA]: TREE_M } } });
  assert.match(page.tray().textContent, /Keep images under 5 MB/);
  await uploadFile(page, fakeFile(PNG));
  assert.deepEqual(w.media().map((c) => c.body), [{ action: 'sign', subfolder: 'setup', filename: 'Hippo Mark.png' }]);
  assert.equal(w.cloud().length, 1);
  const post = w.cloud()[0];
  assert.equal(post.url, `https://api.cloudinary.com/v1_1/${CLOUD}/image/upload`);
  assert.deepEqual(post.body.entries.map((e) => e[0]), ['folder', 'overwrite', 'public_id', 'timestamp', 'api_key', 'signature', 'file']);
  assert.equal(post.init.headers, undefined, 'no Authorization, no headers at all');
  assert.ok(!JSON.stringify(post.body.entries.slice(0, -1)).includes(TOKEN));
  // the manifest draft gained exactly one entry
  const md = draftOfKey(page, C.MANIFEST_KEY);
  const assets = JSON.parse(md.files[C.MANIFEST_FILE]).assets;
  assert.equal(assets.length, LIVE.assets.length + 1);
  const url = `https://res.cloudinary.com/${CLOUD}/image/upload/v1790000001/hippocampus-docs/setup/hippo-mark.png`;
  assert.deepEqual(assets.at(-1), { source: null, folder: 'hippocampus-docs/setup', public_id: 'hippocampus-docs/setup/hippo-mark',
    url, bytes: 2048, sha256: shaOf(PNG) });
  assert.equal(md.base.ref, 'main');
  // the alt text is asked for: empty inserts nothing
  const ta = page.textarea();
  ta.selectionStart = ta.selectionEnd = 0;
  page.action('media-insert').click();
  await settle();
  assert.equal(page.textarea().value, b.text);
  assert.match(page.tray().textContent, /Describe the image first/);
  fieldOf(page, 'media-alt').value = 'The hippo mark';
  page.action('media-insert').click();
  await settle();
  assert.equal(page.textarea().value, `![The hippo mark](${url})${b.text}`);
  assert.equal(draftOfKey(page, PAGE_ID).files[PAGE_FILE],
    `${PAGE_TEXT.slice(0, b.start)}![The hippo mark](${url})${PAGE_TEXT.slice(b.start)}`, 'inside the block\'s span');
  // Propose lists the page and the image list together, and sends both in one tree
  await proposeFrom(page, PAGE_ID);
  assert.match(page.tray().textContent, /What goes in \(2 files\):/);
  assert.ok(page.tray().textContent.includes(C.MANIFEST_FILE) && page.tray().textContent.includes(PAGE_FILE));
  await sendIt(page);
  const tree = writes.find((c) => c.url.endsWith('/git/trees'));
  assert.deepEqual(tree.body.tree.map((e) => e.path), [C.MANIFEST_FILE, PAGE_FILE].sort());
  assert.ok(cardOpen(page, 42));
  assert.equal(draftOfKey(page, C.MANIFEST_KEY), null, 'the image list went into the proposal');
});

test('js/editor.js editor: a duplicate (same sha256 as a site image) offers the site\'s URL and uploads nothing', async () => {
  const live = JSON.parse(MANIFEST_TEXT);
  live.assets[2].sha256 = shaOf(PNG);
  const w = mediaWorld();
  const { page, b } = await mediaInBlock({ intercept: w.intercept, hc: { 'data/cloudinary-manifest.json': live } });
  await uploadFile(page, fakeFile(PNG));
  assert.deepEqual(w.media(), [], 'not signed');
  assert.deepEqual(w.cloud(), [], 'not uploaded');
  assert.ok(page.tray().textContent.includes(live.assets[2].url), 'the existing URL is offered');
  assert.match(page.tray().textContent, /already on the site/);
  assert.equal(draftOfKey(page, C.MANIFEST_KEY), null, 'the image list is unchanged');
  const ta = page.textarea();
  ta.selectionStart = ta.selectionEnd = 0;
  fieldOf(page, 'media-alt').value = 'A photo';
  page.action('media-insert').click();
  await settle();
  assert.equal(page.textarea().value, `![A photo](${live.assets[2].url})${b.text}`);
});

test('js/editor.js editor: an image the site has can be picked without uploading; a file over 5 MB is refused before any call', async () => {
  const w = mediaWorld();
  const { page } = await mediaInBlock({ intercept: w.intercept });
  await uploadFile(page, fakeFile(PNG, { size: C.MEDIA_MAX_BYTES + 1 }));
  assert.match(page.tray().textContent, /Keep images under 5 MB: make it smaller/);
  assert.deepEqual([w.media().length, w.cloud().length], [0, 0]);
  const pick = fieldOf(page, 'media-pick');
  pick.value = USED.url;
  pick.fire('change');
  await settle();
  fieldOf(page, 'media-alt').value = 'IMU';
  const ta = page.textarea();
  ta.selectionStart = ta.selectionEnd = 0;
  page.action('media-insert').click();
  await settle();
  assert.ok(page.textarea().value.startsWith(`![IMU](${USED.url})`));
});

test('js/editor.js New person: Photo from Media sets the photo to a site image', async () => {
  const w = mediaWorld();
  const page = await editorOn({ intercept: w.intercept });
  await openTab(page, 'changes');
  await page.follow(page.linkTo('#/new/person'));
  page.action('media-open').click();
  await settle();
  const pick = fieldOf(page, 'media-pick');
  pick.value = USED.url;
  pick.fire('change');
  await settle();
  page.action('media-use').click();
  await settle();
  fieldOf(page, 'group').value = 'alumni';
  fieldOf(page, 'name').value = 'Ada Example';
  page.action('add-person').click();
  await settle();
  assert.ok(rawEditor(page), 'the people draft opens (the old #/edit/data/people)');
  const d = draftOfKey(page, 'data/people');
  assert.equal(JSON.parse(d.files['data/people.json']).groups[1].people.at(-1).photo, USED.url);
  assert.deepEqual(page.github().filter((c) => c.method !== 'GET'), []);
});

test('js/editor.js #/media: read-only people see why they cannot manage images, and no gateway call is made', async () => {
  const w = mediaWorld();
  const page = await editorOn({ intercept: w.intercept, variant: 'readonly' });
  await openTab(page, 'media');
  assert.match(page.tray().textContent, /View only: managing the site's images needs write access/);
  assert.deepEqual(w.media(), []);
});

test('js/editor.js New person on my open proposal: an image already proposed on that branch can be picked as the photo', async () => {
  const onBranch = JSON.parse(MANIFEST_TEXT);
  const proposed = { source: null, folder: 'hippocampus-docs/people', public_id: 'hippocampus-docs/people/ada',
    url: `https://res.cloudinary.com/${CLOUD}/image/upload/v1790000002/hippocampus-docs/people/ada.png`, bytes: 99, sha256: 'b'.repeat(64) };
  onBranch.assets.push(proposed);
  const w = mediaWorld();
  const page = await editorOn({ intercept: w.intercept, extra: { pulls: [ownPull()], files: { 7: [] },
    contents: { [HEAD_B]: { 'data/cloudinary-manifest.json': `${JSON.stringify(onBranch, null, 2)}\n`,
      'data/people.json': readRepo('data/people.json') } }, trees: { [MAIN_SHA]: TREE_M, [HEAD_B]: TREE_B } } });
  await openTab(page, 'changes');
  await page.follow(page.linkTo('#/new/person'));
  fieldOf(page, 'base').value = '7';
  page.action('media-open').click();
  await settle();
  const pick = fieldOf(page, 'media-pick');
  assert.ok(pick.childNodes.some((o) => o.attrs.value === proposed.url), 'the proposal\'s own image is offered');
  pick.value = proposed.url;
  pick.fire('change');
  await settle();
  page.action('media-use').click();
  await settle();
  fieldOf(page, 'group').value = 'alumni';
  fieldOf(page, 'name').value = 'Ada Example';
  page.action('add-person').click();
  await settle();
  assert.ok(rawEditor(page), page.tray().textContent);
  const d = draftOfKey(page, 'data/people');
  assert.equal(d.base.number, 7);
  assert.equal(JSON.parse(d.files['data/people.json']).groups[1].people.at(-1).photo, proposed.url);
  assert.deepEqual(page.github().filter((c) => c.method !== 'GET'), []);
});
