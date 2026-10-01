// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 1 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Prove the site's guest boot loads no editor code and how js/app.js loads it for a session or the sign-in click.
/* Plan D-C: guests load zero editor code and make zero GitHub requests.
   js/app.js injects js/cms-core.js, js/editor.js and css/editor.css ONLY
   when this tab's sessionStorage holds a sign-in, or on the footer's
   "Sign in to edit" click, which opens the GitHub window synchronously
   inside the click, before any await.

   These tests run index.html's scripts, in index.html's order, in a vm
   over a permissive fake DOM (any property this file does not model is
   an inert sink), with the repository's files as the network:

     - a guest boot creates no script or stylesheet element and fetches only
       content/ data/ search/ same-origin paths; the footer offers
       "Sign in to edit";
     - a throwing sessionStorage (a sandboxed frame, a privacy mode) breaks
       neither a preview frame nor a normal page; a preview frame never even
       reads storage and never loads the editor;
     - a session boot injects the stylesheet, then js/cms-core.js, then
       js/editor.js (each after the previous one loaded) and starts it;
     - the click opens the window synchronously in the dispatched click,
       then injects, then hands THAT window to HCEditor.start; a failed
       injection closes it and the footer says so;
     - window.HCApp = frozen {loadEditor}; its fake session is never written;
     - app.js's literals equal HCCore's (SESSION_KEY exported; the popup's
       name and features read from HCCore.createSignIn's own call).

     node --test tools/tests/test_app_guest.mjs
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
const SRC = require(path.join(ROOT, 'js', 'source.js'));

const ORIGIN = 'https://docs.example.org';
const NONCE = 'n0nce-4f9c2a7e1b3d5f60';
const SCRIPTS = ['source.js', 'editor-frame.js', 'sanitize.js', 'marked.min.js', 'search.js',
  'graph.js', 'lab.js', 'app.js'];
const EDITOR_FILES = ['css/editor.css', 'js/cms-core.js', 'js/editor.js'];
const SETUP_ROUTE = '/setup/hippocampus-bringup/fcu-firmware';

// ----------------------------------------------------- permissive DOM ---

/* Anything this file does not model: callable, iterable (empty), a string
   ('') when coerced, never a thenable, and it swallows every write. */
const SINK = new Proxy(function sink() {}, {
  get(t, k) {
    if (k === 'then') return undefined;
    if (k === Symbol.toPrimitive) return () => '';
    if (k === Symbol.iterator) return function* none() {};
    return SINK;
  },
  apply() { return SINK; },
  construct() { return SINK; },
  set() { return true; },
});

function makeNode(tag, doc) {
  const classes = new Set();
  const store = {
    tagName: String(tag).toUpperCase(), nodeType: 1, children: [], attrs: {}, listeners: {},
    dataset: {}, style: {}, hidden: false, textContent: '', innerHTML: '', value: '', parentNode: null,
    classList: {
      add: (...cs) => cs.forEach((c) => classes.add(c)),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      toggle: (c, on) => {
        const want = on === undefined ? !classes.has(c) : Boolean(on);
        if (want) classes.add(c); else classes.delete(c);
        return want;
      },
      contains: (c) => classes.has(c),
    },
  };
  let node = null;
  const adopt = (c) => { if (c && typeof c === 'object') c.parentNode = node; doc.appended.push({ parent: node, child: c }); return c; };
  const methods = {
    appendChild(c) { store.children.push(c); return adopt(c); },
    append(...cs) { cs.forEach((c) => methods.appendChild(c)); },
    prepend(c) { store.children.unshift(c); return adopt(c); },
    insertBefore(c) { store.children.push(c); return adopt(c); },
    after(...cs) { cs.forEach((c) => { doc.after.push({ ref: node, child: c }); adopt(c); }); },
    before() {},
    replaceChildren(...cs) { store.children = cs; },
    remove() { store.removed = true; },
    setAttribute(k, v) { store.attrs[k] = String(v); },
    getAttribute(k) { return k in store.attrs ? store.attrs[k] : null; },
    hasAttribute(k) { return k in store.attrs; },
    removeAttribute(k) { delete store.attrs[k]; },
    addEventListener(type, fn) { (store.listeners[type] = store.listeners[type] || []).push(fn); },
    removeEventListener() {},
    querySelector: (sel) => doc.memo(sel),
    querySelectorAll: () => [],
    closest: () => null,
    contains: () => false,
    matches: () => false,
    // the test's own: fire listeners as the browser would
    fire(type, extra) {
      const e = Object.assign({ type, target: node, defaultPrevented: false }, extra);
      e.preventDefault = () => { e.defaultPrevented = true; };
      e.stopPropagation = () => {};
      for (const fn of (store.listeners[type] || []).slice()) fn(e);
      return e;
    },
  };
  node = new Proxy(store, {
    get(t, k) {
      if (k in store) return store[k];
      if (k in methods) return methods[k];
      if (k === 'then') return undefined;
      if (k === 'className') return [...classes].join(' ');
      return SINK;
    },
    set(t, k, v) {
      if (k === 'className') { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); return true; }
      store[k] = v;
      return true;
    },
  });
  return node;
}

function makeDocument() {
  const doc = { created: [], appended: [], after: [], memos: new Map() };
  doc.memo = (sel) => {
    if (!doc.memos.has(sel)) doc.memos.set(sel, makeNode(/^#?([a-z]+)/i.exec(sel) ? 'div' : 'div', doc));
    return doc.memos.get(sel);
  };
  const head = makeNode('head', doc);
  const body = makeNode('body', doc);
  const html = makeNode('html', doc);
  // index.html's footer link starts hidden
  const edit = doc.memo('#edit-page');
  edit.hidden = true;
  edit.textContent = 'Edit this page';
  const api = {
    head, body, documentElement: html, activeElement: body, title: '',
    querySelector: (sel) => doc.memo(sel),
    getElementById: (id) => doc.memo(`#${id}`),
    querySelectorAll: () => [],
    createElement: (tag) => { const n = makeNode(tag, doc); doc.created.push(n); return n; },
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
    createDocumentFragment: () => makeNode('#fragment', doc),
    addEventListener() {},
    removeEventListener() {},
  };
  doc.api = new Proxy(api, {
    get(t, k) { return k in api ? api[k] : (k === 'then' ? undefined : SINK); },
    set(t, k, v) { api[k] = v; return true; },
  });
  doc.head = head;
  doc.body = body;
  return doc;
}

// ------------------------------------------------------------ the site ---

function memoryStorage(seed) {
  const m = new Map(Object.entries(seed || {}));
  const log = [];
  return {
    getItem: (k) => { log.push(['get', k]); return m.has(k) ? m.get(k) : null; },
    setItem: (k, v) => { log.push(['set', k]); m.set(k, String(v)); },
    removeItem: (k) => { log.push(['remove', k]); m.delete(k); },
    log,
    raw: m,
  };
}

const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 60; i += 1) await tick(); };

function fileResponse(p) {
  const clean = String(p).split('?')[0].split('#')[0].replace(/^\//, '');
  let text = null;
  try {
    if (!clean.includes('..')) text = fs.readFileSync(path.join(ROOT, clean), 'utf8');
  } catch (e) { text = null; }
  return {
    ok: text !== null, status: text !== null ? 200 : 404,
    headers: { get: () => null },
    text: async () => text || '',
    json: async () => JSON.parse(text),
  };
}

/* index.html in a vm. opts: hash, framed (a preview frame: the page is
   framed and its hash is a preview fragment), storage ('throws' or a
   memoryStorage), open (window.open's answer). */
function openApp(opts) {
  const o = opts || {};
  const doc = makeDocument();
  const listeners = {};
  const fetches = [];
  const opens = [];
  const clicking = { now: false };
  const storageTouches = { n: 0 };
  const storage = o.storage === 'throws' ? null : (o.storage || memoryStorage());
  const location = {
    origin: ORIGIN, protocol: 'https:', host: 'docs.example.org', hostname: 'docs.example.org',
    pathname: '/', search: '',
    hash: o.framed ? SRC.previewFragment(NONCE, o.route || '/') : (o.hash || '#/'),
    reload() {},
    replace() {},
  };
  const parentPosts = [];
  const sandbox = {
    document: doc.api,
    location,
    history: { replaceState: (s, t, url) => { location.hash = String(url).slice(String(url).indexOf('#')); } },
    navigator: { userAgent: 'node', clipboard: SINK },
    localStorage: memoryStorage(),
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener: () => {},
    fetch: (url, init) => {
      fetches.push({ url: String(url), method: (init && init.method) || 'GET' });
      const own = o.files && Object.prototype.hasOwnProperty.call(o.files, String(url)) ? o.files[String(url)] : null;
      return Promise.resolve(own === null ? fileResponse(url) : {
        ok: true, status: 200, headers: { get: () => null }, text: async () => own, json: async () => JSON.parse(own) });
    },
    open: (url, name, features) => {
      const w = o.open === undefined
        ? { closed: false, closes: 0, location: { href: String(url) }, close() { this.closed = true; this.closes += 1; } }
        : o.open;
      opens.push({ url, name, features, inClick: clicking.now, win: w });
      return w;
    },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: () => {},
    scrollTo: () => {},
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    getComputedStyle: () => SINK,
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, console,
    crypto: { getRandomValues: (a) => a },
    DOMParser: function DOMParser() { return SINK; },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    MutationObserver: function MutationObserver() { return { observe() {}, disconnect() {} }; },
  };
  Object.defineProperty(sandbox, 'sessionStorage', {
    get() {
      storageTouches.n += 1;
      if (!storage) throw new Error('SecurityError: the document is sandboxed and lacks the allow-same-origin flag');
      return storage;
    },
  });
  if (o.links) {
    /* The rendered page as a page of links: the sanitizer sees an empty
       body (its own tests cover it) and returns the Markdown's HTML as is;
       <template> yields one root whose querySelectorAll answers the
       attribute-prefix selectors app.js asks, with CSS's own semantics
       (case-sensitive unless the selector carries the ` i` flag). */
    sandbox.DOMParser = function DOMParser() {
      return { parseFromString: (html) => ({ body: { childNodes: [], innerHTML: String(html) } }) };
    };
    const make = doc.api.createElement;
    doc.api.createElement = (tag) => {
      if (String(tag).toLowerCase() !== 'template') return make(tag);
      const root = makeNode('div', doc);
      const anchors = [];
      root.anchors = anchors;
      root.querySelectorAll = (sel) => String(sel).split(',').map((x) => x.trim()).flatMap((one) => {
        const m = /^a\[href\^="([^"]*)"(\s+i)?\]$/.exec(one);
        if (!m) return [];
        const fold = (v) => (m[2] ? String(v).toLowerCase() : String(v));
        return anchors.filter((a) => fold(a.attrs.href).startsWith(fold(m[1])));
      });
      root.firstElementChild = root;
      root.dataset.hcXref = '1';   // js/graph.js's cross-ref pass skips it (test_graph_ui.mjs covers that pass)
      o.links.push(root);
      return {
        set innerHTML(html) {
          for (const m of String(html).matchAll(/<a href="([^"]*)"/g)) {
            const a = makeNode('a', doc);
            a.setAttribute('href', m[1]);
            anchors.push(a);
          }
        },
        content: root,
      };
    };
  }
  const win = vm.createContext(sandbox);
  win.window = win;
  win.self = win;
  win.top = win;
  win.parent = o.framed ? {
    postMessage(msg) {
      parentPosts.push(msg);
      if (!msg || msg.type !== 'hc-fetch') return;
      // the Editor's parent: answers content/ data/ search/ reads from the tree
      setImmediate(async () => {
        const r = fileResponse(msg.path);
        const text = await r.text();
        const event = { source: win.parent, origin: ORIGIN,
          data: { type: 'hc-file', nonce: msg.nonce, id: msg.id, ok: r.ok, status: r.status, text } };
        for (const fn of (listeners.message || []).slice()) fn(event);
      });
    },
  } : win;
  const errors = [];
  for (const f of SCRIPTS) {
    try {
      vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), win, { filename: f });
    } catch (e) {
      errors.push(`${f}: ${e.message}`);
    }
  }
  const app = {
    win, doc, fetches, opens, listeners, location, storage, storageTouches, errors, parentPosts,
    editLink: () => doc.memo('#edit-page'),
    status: () => {
      const a = doc.after.find((x) => x.ref === doc.memo('#edit-page'));
      return a ? a.child : null;
    },
    injected: () => doc.appended.filter((x) => x.parent === doc.head).map((x) => x.child),
    injectedNames: () => app.injected().map((n) => n.attrs.src || n.attrs.href),
    scriptsOrLinks: () => doc.created.filter((n) => n.tagName === 'SCRIPT' || n.tagName === 'LINK'),
    // the footer link, clicked: the dispatch is synchronous, and `clicking`
    // is true only while the listeners run
    click() {
      clicking.now = true;
      try { return app.editLink().fire('click'); } finally { clicking.now = false; }
    },
    // the injected element at `name` finished loading (or failed)
    async loaded(name, how) {
      const n = app.injected().find((x) => (x.attrs.src || x.attrs.href) === name);
      assert.ok(n, `${name} was injected`);
      if (how !== 'error' && name === 'js/editor.js') {
        win.HCEditor = Object.freeze({
          start: (opts2) => { app.starts.push(opts2); return true; },
        });
      }
      n.fire(how || 'load');
      await settle();
    },
    async loadAll() {
      for (const f of EDITOR_FILES) await app.loaded(f);
    },
    starts: [],
    async go(hash) {
      location.hash = hash;
      for (const fn of (listeners.hashchange || []).slice()) fn({ type: 'hashchange' });
      await settle();
    },
  };
  return app;
}

async function boot(opts) {
  const app = openApp(opts);
  await settle();
  return app;
}

const allowedRead = (u) => /^(content|data|search)\/[A-Za-z0-9._/-]+$/.test(u) && !u.includes('..');

// ---------------------------------------------------------- guest boot ---

test('a guest boot creates no script or stylesheet element and fetches only content/ data/ search/', async () => {
  const app = await boot({ hash: `#${SETUP_ROUTE}` });
  assert.deepEqual(app.errors, [], 'every index.html script loads');
  assert.equal(app.scriptsOrLinks().length, 0, 'no script and no stylesheet element is created');
  assert.deepEqual(app.injected(), [], 'nothing is appended to <head>');
  assert.equal(app.win.HCEditor, undefined);
  assert.equal(app.win.HCCore, undefined);
  assert.ok(app.fetches.length >= 5, 'the page was read');
  assert.ok(app.fetches.some((f) => f.url === 'content/setup/hippocampus-bringup/fcu-firmware.md'));
  for (const f of app.fetches) {
    assert.ok(allowedRead(f.url), `a guest fetched only same-origin content/ data/ search/: ${f.url}`);
    assert.equal(f.method, 'GET');
  }
  // the one storage read is the session check; nothing is written
  assert.deepEqual(app.storage.log, [['get', C.SESSION_KEY]]);
});

test('a guest sees "Sign in to edit" in the footer on every route', async () => {
  const app = await boot({ hash: '#/' });
  assert.equal(app.editLink().hidden, false);
  assert.equal(app.editLink().textContent, 'Sign in to edit');
  await app.go('#/projects');
  assert.equal(app.editLink().hidden, false);
  assert.equal(app.editLink().textContent, 'Sign in to edit');
});

// ------------------------------------------------ storage that throws ---

test('a preview frame whose sessionStorage throws still renders, never reads storage, never loads the editor', async () => {
  const app = await boot({ framed: true, route: '/', storage: 'throws' });
  assert.deepEqual(app.errors, []);
  assert.equal(app.win.HC.preview, true);
  assert.equal(app.storageTouches.n, 0, 'a preview frame never touches sessionStorage');
  assert.match(String(app.doc.memo('#content').innerHTML), /class="hero"/, 'the page rendered');
  assert.ok(app.parentPosts.some((m) => m.type === 'hc-fetch' && m.path === 'data/site.json'));
  assert.equal(app.editLink().hidden, true, 'a preview frame shows no footer entry');
  assert.equal(app.scriptsOrLinks().length, 0);
  assert.equal(await app.win.HCApp.loadEditor({}), false, 'the editor is never loaded inside a frame');
  assert.equal(app.scriptsOrLinks().length, 0);
  assert.equal(app.fetches.length, 0, 'a frame reads only through its parent');
});

test('a normal page whose sessionStorage throws boots as a guest', async () => {
  const app = await boot({ hash: '#/', storage: 'throws' });
  assert.deepEqual(app.errors, []);
  assert.equal(app.storageTouches.n, 1, 'the one guarded read');
  assert.match(String(app.doc.memo('#content').innerHTML), /class="hero"/);
  assert.equal(app.editLink().textContent, 'Sign in to edit');
  assert.equal(app.scriptsOrLinks().length, 0);
});

// ------------------------------------------------------- session boot ---

test('a session boot injects css/editor.css, then js/cms-core.js, then js/editor.js, each after the last loaded', async () => {
  const storage = memoryStorage({ [C.SESSION_KEY]: JSON.stringify(C.makeSession('<yours>', null, 'bob', Date.now())) });
  const app = await boot({ hash: `#${SETUP_ROUTE}`, storage });
  assert.deepEqual(app.injectedNames(), ['css/editor.css']);
  const css = app.injected()[0];
  assert.equal(css.tagName, 'LINK');
  assert.equal(css.attrs.rel, 'stylesheet');
  await app.loaded('css/editor.css');
  assert.deepEqual(app.injectedNames(), ['css/editor.css', 'js/cms-core.js']);
  assert.equal(app.injected()[1].tagName, 'SCRIPT');
  await app.loaded('js/cms-core.js');
  assert.deepEqual(app.injectedNames(), EDITOR_FILES);
  assert.equal(app.starts.length, 0, 'not started before js/editor.js loaded');
  await app.loaded('js/editor.js');
  assert.equal(app.starts.length, 1);
  assert.equal(app.starts[0].popup, undefined, 'a session boot opens no window');
  assert.equal(typeof app.starts[0].status, 'function');
  assert.equal(typeof app.starts[0].onSession, 'function');
  assert.equal(app.opens.length, 0);
  assert.ok(!app.storage.log.some((x) => x[0] !== 'get'), 'app.js writes nothing to storage');
});

test('signed in: the footer entry is "Edit this page" -> the page with ?editor=changes (D-I); hidden off page routes', async () => {
  const storage = memoryStorage({ [C.SESSION_KEY]: JSON.stringify(C.makeSession('<yours>', null, 'bob', Date.now())) });
  const app = await boot({ hash: `#${SETUP_ROUTE}`, storage });
  await app.loadAll();
  app.starts[0].onSession(true);
  assert.equal(app.editLink().textContent, 'Edit this page');
  assert.equal(app.editLink().hidden, false);
  assert.equal(app.editLink().attrs.href, `#${SETUP_ROUTE}?editor=changes`);
  const e = app.click();
  assert.equal(e.defaultPrevented, false, 'a plain link: js/editor.js reads the parameter');
  assert.equal(app.opens.length, 0);
  await app.go('#/about');
  assert.equal(app.editLink().attrs.href, '#/about?editor=changes');
  await app.go('#/projects');
  assert.equal(app.editLink().hidden, true);
  app.starts[0].onSession(false);
  assert.equal(app.editLink().hidden, false);
  assert.equal(app.editLink().textContent, 'Sign in to edit');
});

// --------------------------------------------------- the sign-in click ---

test('the click opens the window synchronously inside the dispatched click, then injects, then hands it over', async () => {
  const app = await boot({ hash: '#/' });
  const e = app.click();
  assert.equal(e.defaultPrevented, true);
  assert.equal(app.opens.length, 1);
  const [o] = app.opens;
  assert.equal(o.inClick, true, 'window.open ran inside the click, before any await');
  assert.equal(o.url, 'about:blank');
  assert.equal(app.injected().length, 0, 'the window opens before anything is injected');
  await settle();
  assert.equal(app.injected().length, 1, 'then the injection starts');
  await app.loadAll();
  assert.equal(app.starts.length, 1);
  assert.equal(app.starts[0].popup, o.win, 'HCEditor.start adopts the pre-opened window');
  assert.equal(app.starts[0].session, undefined);
  assert.equal(o.win.closes, 0);
});

test('app.js\'s literals equal HCCore\'s: SESSION_KEY, and the popup\'s name and features', async () => {
  const app = await boot({ hash: '#/' });
  app.click();
  const seen = [];
  const signIn = C.createSignIn({
    origin: ORIGIN,
    getRandomValues: (a) => a,
    openWindow: (url, name, features) => { seen.push({ url, name, features }); return null; },
    fetch: async () => { throw new Error('never asked'); },
  });
  const res = await signIn.start();
  assert.equal(res.reason, 'blocked');
  assert.equal(seen.length, 1);
  assert.equal(app.opens[0].url, seen[0].url);
  assert.equal(app.opens[0].name, seen[0].name);
  assert.equal(app.opens[0].features, seen[0].features);
  assert.deepEqual(app.storage.log[0], ['get', C.SESSION_KEY]);
});

test('a failed injection closes the pre-opened window and the footer says so; a second click tries again', async () => {
  const app = await boot({ hash: '#/' });
  app.click();
  await settle();
  await app.loaded('css/editor.css');
  await app.loaded('js/cms-core.js', 'error');
  const w = app.opens[0].win;
  assert.equal(w.closes, 1, 'the pre-opened window is closed');
  assert.equal(app.starts.length, 0);
  const status = app.status();
  assert.ok(status, 'a status line sits beside the footer link');
  assert.equal(status.getAttribute('role'), 'status');
  assert.match(status.textContent, /could not be loaded/);
  assert.equal(status.hidden, false);
  // again: a new window, and the failed file is injected again
  app.click();
  assert.equal(app.opens.length, 2);
  assert.equal(app.opens[1].inClick, true);
  await settle();
  const names = app.injectedNames();
  assert.equal(names.filter((n) => n === 'js/cms-core.js').length, 2);
  assert.equal(names.filter((n) => n === 'css/editor.css').length, 1, 'a loaded file is not injected twice');
});

test('a blocked window: the footer says so and nothing is injected', async () => {
  const app = await boot({ hash: '#/', open: null });
  app.click();
  await settle();
  assert.equal(app.opens.length, 1);
  assert.deepEqual(app.injected(), []);
  assert.match(app.status().textContent, /blocked/);
});

test('HCEditor.start\'s status callback writes the footer line as text', async () => {
  const app = await boot({ hash: '#/' });
  app.click();
  await settle();
  await app.loadAll();
  app.starts[0].status('<img src=x onerror=alert(1)> said no', 'error');
  const status = app.status();
  assert.equal(status.textContent, '<img src=x onerror=alert(1)> said no');
  assert.equal(status.innerHTML, '', 'never markup');
  assert.equal(status.hidden, false);
  app.starts[0].status('');
  assert.equal(status.hidden, true);
});

// ------------------------------------------------------------ the seam ---

test('window.HCApp is frozen {loadEditor}; loadEditor passes fetch and session, and never writes the session', async () => {
  const app = await boot({ hash: '#/' });
  const { HCApp } = app.win;
  assert.ok(Object.isFrozen(HCApp));
  assert.deepEqual(Object.keys(HCApp), ['loadEditor']);
  const fake = () => Promise.resolve(null);
  const session = { token: '<yours>-walk', login: 'walker', expiresAt: null };
  const done = HCApp.loadEditor({ fetch: fake, session, popup: { close() {} } });
  await settle();
  await app.loadAll();
  assert.equal(await done, true);
  assert.equal(app.starts.length, 1);
  assert.equal(app.starts[0].fetch, fake);
  assert.equal(app.starts[0].session, session);
  assert.equal(app.starts[0].popup, undefined, 'the seam never hands over a window');
  assert.equal(app.opens.length, 0);
  assert.ok(!app.storage.log.some((x) => x[0] === 'set'), 'nothing is written under SESSION_KEY');
  // a second call does not inject again
  await HCApp.loadEditor({ fetch: fake, session });
  assert.equal(app.injected().length, 3);
});

// ------------------------------------------------ the ?editor= bootstrap ---

test('a guest on a ?editor= link (the /cms/ redirect, D-I) loads nothing and is asked to sign in', async () => {
  const app = await boot({ hash: '#/?editor=proposals&pr=1' });
  assert.deepEqual(app.errors, []);
  assert.equal(app.scriptsOrLinks().length, 0, 'no editor code without a sign-in');
  assert.match(String(app.doc.memo('#content').innerHTML), /class="hero"/, 'the page under the parameter rendered');
  assert.equal(app.editLink().textContent, 'Sign in to edit');
  assert.match(app.status().textContent, /Sign in to edit/);
  assert.equal(app.status().hidden, false);
  assert.equal(app.location.hash, '#/?editor=proposals&pr=1', 'the parameter stays for the editor to read after the sign-in');
  // a later navigation without the parameter clears the line
  await app.go('#/projects');
  assert.equal(app.status().hidden, true);
  await app.go(`#${SETUP_ROUTE}?editor=changes`);
  assert.equal(app.status().hidden, false);
  assert.equal(app.scriptsOrLinks().length, 0);
});

test('a session boot on a ?editor= link loads the editor, which reads the parameter itself', async () => {
  const storage = memoryStorage({ [C.SESSION_KEY]: JSON.stringify(C.makeSession('<yours>', null, 'bob', Date.now())) });
  const app = await boot({ hash: '#/?editor=media', storage });
  await app.loadAll();
  assert.equal(app.starts.length, 1);
  assert.equal(app.location.hash, '#/?editor=media', 'app.js leaves the parameter to js/editor.js');
  const s = app.status();
  assert.ok(!s || s.hidden, 'no sign-in prompt for a session');
});

test('HCEditor.start that throws: the window closes, the footer says so, no unhandled rejection', async () => {
  const app = await boot({ hash: '#/' });
  app.click();
  await settle();
  await app.loaded('css/editor.css');
  await app.loaded('js/cms-core.js');
  const n = app.injected().find((x) => x.attrs.src === 'js/editor.js');
  app.win.HCEditor = Object.freeze({ start: () => { throw new Error('boom'); } });
  const rejections = [];
  const onRej = (r) => rejections.push(r);
  process.on('unhandledRejection', onRej);
  try {
    n.fire('load');
    await settle();
  } finally {
    process.off('unhandledRejection', onRej);
  }
  assert.deepEqual(rejections, []);
  assert.equal(app.opens[0].win.closes, 1);
  assert.match(app.status().textContent, /could not be loaded/);
});

// ------------------------------------------------------ outside links ---

test('an outside link opens in a new tab whatever its scheme\'s case (never inside the Editor\'s frame)', async () => {
  const roots = [];
  const md = '# Links\n\n[lower](https://lower.example/a) [upper](HTTPS://upper.example/b) '
    + '[mixed](Http://mixed.example/c) [inside](#/about)\n';
  const app = await boot({ hash: `#${SETUP_ROUTE}`, links: roots,
    files: { 'content/setup/hippocampus-bringup/fcu-firmware.md': md } });
  assert.deepEqual(app.errors, []);
  const anchors = roots.flatMap((r) => r.anchors);
  const by = (href) => anchors.find((a) => a.attrs.href === href);
  for (const href of ['https://lower.example/a', 'HTTPS://upper.example/b', 'Http://mixed.example/c']) {
    const a = by(href);
    assert.ok(a, `the page rendered ${href}`);
    assert.equal(a.target, '_blank', `${href} opens in a new tab`);
    assert.equal(a.rel, 'noopener', `${href} gets rel=noopener`);
  }
  const inside = by('#/about');
  assert.ok(inside);
  assert.ok(inside.target !== '_blank', 'a site link stays in the page');
});
