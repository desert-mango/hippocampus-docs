// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 23 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Run the Editor mode's parent side in a vm over a fake DOM and the fake GitHub, for the editor tests.
/* The editor harness (editor UI/UX build, unit U0). Extracted from tools/tests/test_editor.mjs so every
   unit's own test file (tools/tests/test_editor_<unit>.mjs) boots the editor the same way. The name does not
   start with test_: the node --test glob never runs it on its own.

   openSite(opts) -> page
     index.html's page in a vm: #content, #hc-frame-host, .header-actions and a body; js/marked.min.js, then
     EXACTLY the scripts js/app.js injects for a session (EDITOR_SCRIPTS, read from app.js's EDITOR_FILES:
     today js/cms-core.js, js/editor-dock.js, js/editor.js), then HCEditor.start({session, status, onSession}).
     The CONTRACT, which is all a test may rely on:
       opts.hash          the initial location.hash (default '#/')
       opts.session       the session handed to start (default C.makeSession(TOKEN, null, 'bob', now);
                          null starts signed out)
       opts.variant       the fake GitHub's role variant (tools/tests/fake_github.js)
       opts.extra         fake_github.js's extra options; opts.onWrite its write spy
       opts.files         { path: text } overrides of the repository files the fake GitHub serves
       opts.hc            { path: json } overrides of HC.fetchJSON / HC.fetchProjects' index
       opts.intercept     (url, init) => Response | null, consulted before the fake GitHub
       opts.storage       the tab's sessionStorage (default a fresh memoryStorage()); opts.localStorage
                          the browser's localStorage (default: one per sessionStorage, localFor(storage))
       opts.phone         matchMedia(...).matches; page.mql.handlers holds the 'change' listeners
       opts.confirm       what window.confirm answers (default true); page.confirms records the questions
       opts.start         more HCEditor.start options, merged last
       page.win / body / header / content / host     the vm window and the fake nodes
       page.calls         every fetch {url, method}; page.github() the api.github.com ones
       page.listeners     window listeners by type; page.docListeners(type) the document's
       page.created, page.replaced, page.opens, page.told, page.sessions, page.hcReads   spies
       page.all(pred) / page.one(pred)   a walk of the body; page.frame(s), switchBtn, textarea, nonce,
                          tray, trayTitle, trayTab, handle, action(name), linkTo(href)   finders
       page.go(hash), page.send(data, extra), page.asks(path), page.pick(i), page.showData(),
                          page.type(el, text), page.review(n), page.tab(id), page.follow(a)   drivers; each
                          resolves after settle()
     settle()   drains microtasks and the 0-ms timers (window.setTimeout runs every timer at once)
     FakeElement, findAll(node, pred), memoryStorage(), localFor(storage), FakeFormData, tick()
   NOT granted: layout (offsetWidth/getBoundingClientRect are absent), CSS, querySelector(All) (answers
   nothing), focus order, real timers' delays, the frame's own scripts (the iframe is a node that records
   posts and srcs), and any network beyond the fake GitHub and the repository's files. Those are browser
   checks (tools/tests/editor_walk.html, tools/tests/browser_oracles.mjs). */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const C = require(path.join(ROOT, 'js', 'cms-core.js'));
const { createFakeGitHub } = require(path.join(ROOT, 'tools', 'tests', 'fake_github.js'));

const FIXTURES = path.join(ROOT, 'tools', 'tests', 'fixtures', 'github-data');
const readRepo = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
export const TOKEN = '<yours>-editor-token';
export const ORIGIN = 'https://docs.example.org';

/* The scripts js/app.js injects for a session, in its order (its EDITOR_FILES list), after js/marked.min.js,
   which index.html loads for everyone. */
function appScripts() {
  const src = readRepo('js/app.js');
  const list = src.slice(src.indexOf('const EDITOR_FILES = ['), src.indexOf('];', src.indexOf('const EDITOR_FILES = [')));
  return [...list.matchAll(/\['script', \{ src: '([^']+)' \}\]/g)].map((m) => m[1]);
}
export const EDITOR_SCRIPTS = Object.freeze(['js/marked.min.js', ...appScripts()]);

// ----------------------------------------------------------- fake DOM ---

export class FakeElement {
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
  // a string is a text node, as in the DOM (sendAccessProposal says its result with one)
  replaceChildren(...cs) {
    this.ownText = '';
    this.childNodes = cs.map((c) => (typeof c === 'string' ? { textContent: c, nodeType: 3 } : c));
    this.childNodes.forEach((c) => { c.parent = this; });
  }
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

export function findAll(node, pred, out = []) {
  if (node && node.tagName && pred(node)) out.push(node);
  for (const c of (node && node.childNodes) || []) findAll(c, pred, out);
  return out;
}

export function memoryStorage() {
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

export const tick = () => new Promise((r) => setImmediate(r));
export const settle = async () => { for (let i = 0; i < 80; i += 1) { await tick(); await new Promise((r) => setTimeout(r, 1)); } };

// the browser's FormData, as far as the signed Cloudinary upload uses it
export class FakeFormData {
  constructor() { this.entries = []; }
  append(k, v) { this.entries.push([k, v]); }
}

/* index.html's page in a vm: #content, #hc-frame-host, .header-actions and
   a body; js/cms-core.js then js/editor.js; HCEditor.start({fetch, session}). */
export function openSite(opts) {
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
  const docListeners = {};
  const confirms = [];    // window.confirm's questions
  const hcReads = [];     // the site files read through HC.fetchJSON
  const created = [];
  const replaced = [];
  const storage = o.storage || memoryStorage();
  // one browser: pages that share a sessionStorage (a reload of the tab) share its localStorage too
  const local = o.localStorage || localFor(storage);
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
      addEventListener: (type, fn) => { (docListeners[type] = docListeners[type] || []).push(fn); },
    },
    sessionStorage: storage,
    localStorage: local,
    location,
    history: { replaceState: (s, t, url) => { replaced.push(url); location.hash = String(url).replace(/^[^#]*/, ''); } },
    crypto: { getRandomValues: (arr) => { for (let i = 0; i < arr.length; i += 1) arr[i] = Math.floor(Math.random() * 256); return arr; },
      subtle: webcrypto.subtle },
    FormData: FakeFormData,
    open: (...a) => { opens.push(a); return null; },
    confirm: (text) => { confirms.push(String(text)); return o.confirm === undefined ? true : o.confirm; },
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    HC: Object.freeze({ preview: false,
      fetchJSON: async (p) => { hcReads.push(p); return (o.hc && Object.prototype.hasOwnProperty.call(o.hc, p) ? o.hc[p] : JSON.parse(readRepo(p))); },
      // as js/source.js: the project index, then each project's facts file, merged
      fetchProjects: async () => { hcReads.push('data/projects.json');
        const index = o.hc && o.hc['data/projects.json'] ? o.hc['data/projects.json'] : JSON.parse(readRepo('data/projects.json'));
        return C.mergeProjects(index, index.projects.map((e) => { try { return JSON.parse(readRepo(`data/projects/${e.id}.json`)); } catch (x) { return null; } })); } }),
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
  for (const f of EDITOR_SCRIPTS) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), win, { filename: path.basename(f) });
  }
  const session = o.session === undefined ? C.makeSession(TOKEN, null, 'bob', Date.now()) : o.session;
  const started = win.HCEditor.start(Object.assign({ session,
    status: (text, kind) => told.push({ text, kind }), onSession: (on) => sessions.push(on) }, o.start));
  const page = {
    win, body, header, content, host, calls, listeners, location, created, replaced, storage, mql, local,
    login: session && typeof session.login === 'string' ? session.login : null,
    docListeners: (type) => docListeners[type] || [],
    confirms,
    hcReads,
    started, opens, told, sessions,
    all: (pred) => findAll(body, pred),
    one: (pred) => findAll(body, pred)[0],
    frames: () => findAll(host, (e) => e.tagName === 'IFRAME'),
    frame: () => findAll(host, (e) => e.tagName === 'IFRAME').at(-1),
    switchBtn: () => findAll(body, (e) => e.attrs['data-editor-switch'] !== undefined)[0],
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
    // V2 (Kyle, 2026-10-14): a picked block is edited in the page; its Markdown is on the editor page's Data tab.
    // pick = the frame says hc-block-select, then the person opens Proposals -> Data (when it is not open yet)
    async pick(index) {
      await page.send({ type: 'hc-block-select', index });
      await page.showData();
    },
    async showData() {
      if (page.tray().hidden) { page.handle().click(); await settle(); }
      if (page.trayTitle() !== 'Edit as Markdown') { page.tab('changes').click(); await settle(); }
    },
    editorMessages: () => page.frame().posted.filter((x) => x.m.type === 'hc-editor').map((x) => x.m),
    async type(el, text) { el.value = text; el.fire('input'); await settle(); },
    github: () => calls.filter((c) => c.url.indexOf('https://api.github.com/') === 0),
    tray: () => findAll(body, (e) => e.attrs.id === 'hc-tray')[0],
    // round 2 (R3): no tab buttons; a "tab" is HCEditor.openView(id), the view the old tab showed
    async review(n) { win.HCEditor.openView(`#/review/${n}`); await settle(); },
    tab: (id) => ({ click: () => win.HCEditor.openView(id), get textContent() { return page.trayTitle(); },
      getAttribute: (k) => (k === 'aria-selected' ? String(page.trayTab() === id) : null) }),
    trayTitle: () => { const t = findAll(body, (e) => e.classList.contains('hc-tray-title'))[0]; return t ? t.textContent : null; },
    trayTab: () => ({ Proposals: 'proposals', Proposal: 'proposals', 'Edit as Markdown': 'changes', 'View settings': 'view', Guide: 'guide' })[page.trayTitle()],
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

const LOCALS = new WeakMap();
export function localFor(storage) {
  if (!LOCALS.has(storage)) LOCALS.set(storage, memoryStorage());
  return LOCALS.get(storage);
}
