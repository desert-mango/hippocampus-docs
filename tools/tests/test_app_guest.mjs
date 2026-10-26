// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 26 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Prove the site's guest boot loads no editor code and how js/app.js loads it for a session or the sign-in click.
/* Plan D-C: guests load zero editor code and make zero GitHub requests.
   js/app.js injects js/cms-core.js, js/editor.js and css/editor.css ONLY
   when this tab's sessionStorage holds a sign-in, or on the header's
   "Sign in" button's click (uiux P4: it replaced the footer entry and the
   floating bubble), which opens the GitHub window synchronously inside the
   click, before any await.

   These tests run index.html's scripts, in index.html's order, in a vm
   over a permissive fake DOM (any property this file does not model is
   an inert sink), with the repository's files as the network:

     - a guest boot creates no script or stylesheet element and fetches only
       content/ data/ search/ same-origin paths; the header offers
       "Sign in" and the footer offers nothing;
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
       name and features read from HCCore.createSignIn's own call);
     - window.HCShell's pure helpers: the sidebar model (P5, P6) and the
       sign-in button's recede rule (F3).

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
const EDITOR_FILES = ['css/editor.css', 'js/cms-core.js', 'js/editor-dock.js', 'js/editor.js'];
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
  // index.html's footer link and header sign-in button start hidden
  const edit = doc.memo('#edit-page');
  edit.hidden = true;
  edit.textContent = 'Edit this page';
  doc.memo('#signin-btn').hidden = true;
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
    cookie: '',
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
// microtasks AND zero-delay timers: the sign-in line writes its words a frame later (fix B11), rAF = setTimeout 0 here
const settle = async () => { for (let i = 0; i < 60; i += 1) { await tick(); await new Promise((r) => setTimeout(r, 1)); } };

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
  if (o.cookie !== undefined) doc.api.cookie = o.cookie;   // U1: the hc_in marker (document.cookie)
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
    assigned: [],
    assign(u) { location.assigned.push(String(u)); },   // U1: the same-tab sign-in goes to GitHub
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
      fetches.push({ url: String(url), method: (init && init.method) || 'GET', init });
      if (String(url) === '/api/auth?app=editor' && o.clientId) {
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => null },
          json: async () => ({ client_id: o.clientId }) });
      }
      if (String(url) === '/api/auth?session=1') {
        // U1: the resume, as api/auth.js answers it (o.resume: the 200 body; absent: 401, no cookie)
        const ok = Boolean(o.resume);
        return Promise.resolve({ ok, status: ok ? 200 : 401, headers: { get: () => null },
          json: async () => (ok ? o.resume : { error: 'not signed in' }) });
      }
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
    signIn: () => doc.memo('#signin-btn'),
    status: () => {
      const a = doc.after.find((x) => x.ref === doc.memo('#edit-page'));
      return a ? a.child : null;
    },
    // U1 (ED1): the sign-in's own line, beside the button that was clicked
    signInStatus: () => {
      const a = doc.after.find((x) => x.ref === doc.memo('#signin-btn'));
      return a ? a.child : null;
    },
    injected: () => doc.appended.filter((x) => x.parent === doc.head).map((x) => x.child),
    injectedNames: () => app.injected().map((n) => n.attrs.src || n.attrs.href),
    scriptsOrLinks: () => doc.created.filter((n) => n.tagName === 'SCRIPT' || n.tagName === 'LINK'),
    // the header's sign-in button (P4), clicked: the dispatch is synchronous,
    // and `clicking` is true only while the listeners run
    click() {
      clicking.now = true;
      try { return app.signIn().fire('click'); } finally { clicking.now = false; }
    },
    // the footer link (signed in: "Edit this page"), clicked the same way
    clickLink() {
      clicking.now = true;
      try { return app.editLink().fire('click'); } finally { clicking.now = false; }
    },
    // the injected element at `name` finished loading (or failed)
    async loaded(name, how) {
      const n = app.injected().find((x) => (x.attrs.src || x.attrs.href) === name);
      assert.ok(n, `${name} was injected`);
      if (how !== 'error' && name === 'js/editor.js') {
        win.HCEditor = Object.freeze({
          start: (opts2) => { app.starts.push(opts2); return o.startAnswer === undefined ? true : o.startAnswer; },
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

// U1: a signed-in browser as the page sees it: the hc_in marker, and the resume's 200 body
const SIGNED_IN = Object.freeze({ cookie: 'theme=dark; hc_in=1', resume: { token: '<yours>', expires_at: Date.now() + 3600 * 1000 } });

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
  // U1: no storage is read at all (the hc_in marker cookie decides), and no marker means no resume call
  assert.deepEqual(app.storage.log, []);
  assert.ok(!app.fetches.some((f) => f.url.startsWith('/api/')), 'a guest never calls /api/auth');
});

test('P4: a guest sees the header sign-in button and no footer entry, on every route', async () => {
  const app = await boot({ hash: '#/' });
  assert.equal(app.signIn().hidden, false, 'the header button shows');
  assert.equal(app.editLink().hidden, true, 'the footer has no sign-in entry (H2: one entry)');
  await app.go('#/projects');
  assert.equal(app.signIn().hidden, false);
  assert.equal(app.editLink().hidden, true);
  await app.go(`#${SETUP_ROUTE}`);
  assert.equal(app.signIn().hidden, false);
  assert.equal(app.editLink().hidden, true);
  // the guest code no longer keeps the old bubble's tuck setting
  assert.ok(!app.win.localStorage.log.some((x) => x[1] === 'hc-editor-dock'), 'hc-editor-dock is never read or written');
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
  assert.equal(app.signIn().hidden, true, 'a preview frame shows no sign-in button (P4)');
  assert.equal(app.scriptsOrLinks().length, 0);
  assert.equal(await app.win.HCApp.loadEditor({}), false, 'the editor is never loaded inside a frame');
  assert.equal(app.scriptsOrLinks().length, 0);
  assert.equal(app.fetches.length, 0, 'a frame reads only through its parent');
});

test('a normal page whose sessionStorage throws boots as a guest', async () => {
  const app = await boot({ hash: '#/', storage: 'throws' });
  assert.deepEqual(app.errors, []);
  assert.equal(app.storageTouches.n, 0, 'U1: no storage read (the marker cookie decides)');
  assert.match(String(app.doc.memo('#content').innerHTML), /class="hero"/);
  assert.equal(app.signIn().hidden, false, 'P4: the header sign-in button shows');
  assert.equal(app.scriptsOrLinks().length, 0);
});

// ------------------------------------------------------- session boot ---

test('a session boot injects css/editor.css, then js/cms-core.js, then js/editor-dock.js, then js/editor.js, each after the last loaded', async () => {
  const app = await boot({ hash: `#${SETUP_ROUTE}`, ...SIGNED_IN });
  assert.equal(app.fetches.filter((f) => f.url === '/api/auth?session=1').length, 1, 'U1: the marker resumes once');
  assert.deepEqual(app.injectedNames(), ['css/editor.css']);
  const css = app.injected()[0];
  assert.equal(css.tagName, 'LINK');
  assert.equal(css.attrs.rel, 'stylesheet');
  await app.loaded('css/editor.css');
  assert.deepEqual(app.injectedNames(), ['css/editor.css', 'js/cms-core.js']);
  assert.equal(app.injected()[1].tagName, 'SCRIPT');
  await app.loaded('js/cms-core.js');
  assert.deepEqual(app.injectedNames(), ['css/editor.css', 'js/cms-core.js', 'js/editor-dock.js']);
  await app.loaded('js/editor-dock.js');
  assert.deepEqual(app.injectedNames(), EDITOR_FILES);
  assert.equal(app.starts.length, 0, 'not started before js/editor.js loaded');
  await app.loaded('js/editor.js');
  assert.equal(app.starts.length, 1);
  assert.equal(app.starts[0].popup, undefined, 'a session boot opens no window');
  assert.equal(app.starts[0].resumed.token, '<yours>', 'U1: the resumed token is handed to the editor');
  assert.equal(typeof app.starts[0].status, 'function');
  assert.equal(typeof app.starts[0].onSession, 'function');
  assert.equal(app.opens.length, 0);
  assert.ok(!app.storage.log.some((x) => x[0] !== 'get'), 'app.js writes nothing to storage');
});

test('signed in: the footer entry is "Edit this page" -> the page with ?editor=changes (D-I); hidden off page routes', async () => {
  const app = await boot({ hash: `#${SETUP_ROUTE}`, ...SIGNED_IN });
  await app.loadAll();
  app.starts[0].onSession(true);
  assert.equal(app.editLink().textContent, 'Edit this page');
  assert.equal(app.editLink().hidden, false);
  assert.equal(app.editLink().attrs.href, `#${SETUP_ROUTE}?editor=changes`);
  assert.equal(app.signIn().hidden, true, 'P4: signed in, no sign-in button');
  const e = app.clickLink();
  assert.equal(e.defaultPrevented, false, 'a plain link: js/editor.js reads the parameter');
  assert.equal(app.opens.length, 0);
  // (round 2, R5: #/about now redirects to #/team, which this fake DOM cannot draw; the Team page is tested in a
  // real Chrome in browser_oracles.mjs)
  await app.go('#/projects');
  assert.equal(app.editLink().hidden, true);
  app.starts[0].onSession(false);
  assert.equal(app.editLink().hidden, true, 'P4: signed out, the footer offers nothing');
  assert.equal(app.signIn().hidden, false, 'P4: signed out, the header button is back');
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

test('app.js\'s literals equal HCCore\'s: the popup\'s name and features (U1: SESSION_KEY is no longer read)', async () => {
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
  assert.ok(!/SESSION_KEY|hc-cms-session/.test(fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8')),
    'U1: app.js never reads the old sessionStorage key');
});

test('a failed injection closes the pre-opened window and the line beside the button says so; a second click tries again', async () => {
  const app = await boot({ hash: '#/' });
  app.click();
  await settle();
  await app.loaded('css/editor.css');
  await app.loaded('js/cms-core.js', 'error');
  const w = app.opens[0].win;
  assert.equal(w.closes, 1, 'the pre-opened window is closed');
  assert.equal(app.starts.length, 0);
  const status = app.signInStatus();
  assert.ok(status, 'U1 (ED1): a status line sits beside the sign-in button that was clicked');
  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(status.getAttribute('aria-live'), 'polite');
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

test('a blocked window: the line beside the button says so and nothing is injected (U1: then the same-tab sign-in)', async () => {
  const app = await boot({ hash: '#/', open: null });
  app.click();
  assert.ok(app.signInStatus(), 'the line is at once where the click was (fix B11: empty, its words a frame later)');
  await new Promise((r) => setTimeout(r, 5));
  assert.match(app.signInStatus().textContent, /blocked|server functions/, 'said where the click was (this host then says it has no sign-in)');
  await settle();
  assert.equal(app.opens.length, 1);
  assert.deepEqual(app.injected(), []);
});

test('HCEditor.start\'s status callback writes the line beside the button as text', async () => {
  const app = await boot({ hash: '#/' });
  app.click();
  await settle();
  await app.loadAll();
  app.starts[0].status('<img src=x onerror=alert(1)> said no', 'error');
  const status = app.signInStatus();     // U1 (ED1): the clicked button's line
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
  assert.equal(app.injected().length, EDITOR_FILES.length);
});

test('U1: window.HCApp.loadEditor also passes a resumed {token, expiresIn} (the walk\'s ?auth=cookie mode)', async () => {
  const app = await boot({ hash: '#/' });
  const fake = () => Promise.resolve(null);
  const resumed = { token: '<yours>-resumed', expiresIn: 600 };
  const done = app.win.HCApp.loadEditor({ fetch: fake, resumed });
  await settle();
  await app.loadAll();
  assert.equal(await done, true);
  assert.equal(app.starts[0].fetch, fake);
  assert.equal(app.starts[0].resumed, resumed);
  assert.equal(app.starts[0].session, undefined);
  assert.ok(!app.storage.log.some((x) => x[0] === 'set'), 'nothing is written');
});

/* Fix round 2 (the walk's ?auth=cookie reload / second tab): the site's own boot already resumed and started the
   editor from the cookie; the seam must say so (true) and never start it a second time. */
test('U1: HCApp.loadEditor after the boot resumed from the cookie waits for that start: true, and one start only', async () => {
  const app = await boot({ hash: '#/', ...SIGNED_IN });
  const fake = () => Promise.resolve(null);
  const done = app.win.HCApp.loadEditor({ fetch: fake, resumed: { token: '<yours>-again', expiresIn: 600 } });
  await app.loadAll();
  assert.equal(await done, true, 'the editor the boot started');
  assert.equal(app.starts.length, 1, 'never started twice');
  assert.equal(app.starts[0].resumed.token, '<yours>', 'the boot\'s own resume');
});

test('U1: HCApp.loadEditor after a boot resume the server turned down starts the editor itself', async () => {
  const app = await boot({ hash: '#/', cookie: 'hc_in=1' });
  const fake = () => Promise.resolve(null);
  const resumed = { token: '<yours>-walk', expiresIn: 600 };
  const done = app.win.HCApp.loadEditor({ fetch: fake, resumed });
  await settle();
  await app.loadAll();
  assert.equal(await done, true);
  assert.equal(app.starts.length, 1);
  assert.equal(app.starts[0].resumed, resumed);
});

// ------------------------------------------------ the ?editor= bootstrap ---

test('a guest on a ?editor= link (the /cms/ redirect, D-I) loads nothing and is asked to sign in', async () => {
  const app = await boot({ hash: '#/?editor=proposals&pr=1' });
  assert.deepEqual(app.errors, []);
  assert.equal(app.scriptsOrLinks().length, 0, 'no editor code without a sign-in');
  assert.match(String(app.doc.memo('#content').innerHTML), /class="hero"/, 'the page under the parameter rendered');
  assert.equal(app.signIn().hidden, false, 'P4: the header button is the way in');
  assert.match(app.status().textContent, /Sign in/);
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
  const app = await boot({ hash: '#/?editor=media', ...SIGNED_IN });
  await app.loadAll();
  assert.equal(app.starts.length, 1);
  assert.equal(app.location.hash, '#/?editor=media', 'app.js leaves the parameter to js/editor.js');
  const s = app.status();
  assert.ok(!s || s.hidden, 'no sign-in prompt for a session');
});

test('HCEditor.start that throws: the window closes, the line beside the button says so, no unhandled rejection', async () => {
  const app = await boot({ hash: '#/' });
  app.click();
  await settle();
  await app.loaded('css/editor.css');
  await app.loaded('js/cms-core.js');
  await app.loaded('js/editor-dock.js');
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
  assert.match(app.signInStatus().textContent, /could not be loaded/);
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

// ------------------------------------- the header's sign-in button (uiux P4/F3: the bubble is gone) --
test('P4: no guest bubble exists; the header button\'s click is the sign-in (window opened inside the click)', async () => {
  const app = await boot({ hash: '#/' });
  const old = app.doc.created.filter((n) => /hc-guest/.test(n.className));
  assert.deepEqual(old, [], 'no hc-guest-* element is created');
  assert.equal(app.signIn().hidden, false);
  const e = app.click();
  assert.equal(e.defaultPrevented, true);
  assert.equal(app.opens.length, 1, 'the sign-in window opens');
  assert.equal(app.opens[0].url, 'about:blank');
  assert.equal(app.opens[0].inClick, true);
  assert.equal(app.scriptsOrLinks().length, 0, 'still nothing loaded before the click handled it');
});

test('P4: a session boot never shows the sign-in button (the Editor\'s own dock comes)', async () => {
  const app = await boot({ hash: '#/', ...SIGNED_IN });
  assert.equal(app.signIn().hidden, true, 'no sign-in button with a stored session');
  assert.deepEqual(app.doc.created.filter((n) => /hc-guest/.test(n.className)), []);
});

test('P4: a stored session the editor turns down (expired) leaves a guest, and the sign-in button shows', async () => {
  const app = await boot({ hash: '#/', ...SIGNED_IN, startAnswer: false });
  assert.equal(app.signIn().hidden, true, 'a stored session: the button waits');
  await app.loadAll();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(app.signIn().hidden, false, 'the editor turned the session down: "Sign in" shows');
});

// ------------------------------------------------ U1 (D19, ED1): the blocked pop-up --
test('ED1: a blocked pop-up signs in in this tab: the state and the route kept in sessionStorage, then GitHub', async () => {
  const app = await boot({ hash: `#${SETUP_ROUTE}`, open: null, clientId: 'Iv1.placeholder' });
  app.click();
  const line = app.signInStatus();
  assert.ok(line, 'the message is beside the button');
  assert.equal(line.getAttribute('aria-live'), 'polite');
  // fix B11 (WCAG 4.1.3): the live line goes in empty; its words come on the next frame (heard as a change)
  assert.equal(line.textContent, '', 'empty when it goes in');
  await new Promise((r) => setTimeout(r, 5));
  assert.match(line.textContent, /blocked/);
  assert.match(line.textContent, /this tab/);
  assert.equal(line.hidden, false);
  await settle();
  assert.ok(app.fetches.some((f) => f.url === '/api/auth?app=editor'), 'the App\'s public id');
  assert.equal(app.location.assigned.length, 1, 'the tab goes to GitHub');
  const saved = JSON.parse(app.storage.raw.get('hc-signin-same-tab'));
  assert.equal(saved.route, `#${SETUP_ROUTE}`, 'the page to come back to');
  assert.match(saved.state, /^[0-9a-f]{32}$/);
  assert.equal(app.location.assigned[0], C.authorizeUrl('Iv1.placeholder', ORIGIN, saved.state),
    'the same authorize address HCCore builds (redirect_uri = this origin + /cms/callback.html)');
  assert.deepEqual(app.injected(), [], 'no editor code in this tab before the sign-in');
});

test('ED1: a blocked pop-up on a host without the server functions says so beside the button and stays', async () => {
  const app = await boot({ hash: '#/', open: null });
  app.click();
  await settle();
  assert.deepEqual(app.location.assigned, [], 'no navigation');
  assert.ok(!app.storage.raw.has('hc-signin-same-tab'), 'nothing kept');
  assert.match(app.signInStatus().textContent, /server functions|not available/);
});

test('ED1: a blocked pop-up where storage throws cannot keep the state, so it says so and does not navigate', async () => {
  const app = await boot({ hash: '#/', open: null, clientId: 'Iv1.placeholder', storage: 'throws' });
  app.click();
  await settle();
  await new Promise((r) => setTimeout(r, 5));      // fix B11: a new line's words come on the next frame
  assert.deepEqual(app.location.assigned, []);
  assert.match(app.signInStatus().textContent, /Allow pop-ups/);
});

test('ED1: the pop-up path hands the clicked button\'s line to the editor; the footer stays quiet', async () => {
  const app = await boot({ hash: '#/' });
  app.click();
  await settle();
  await app.loadAll();
  app.starts[0].status('Finish signing in in the GitHub window…');
  assert.equal(app.signInStatus().textContent, 'Finish signing in in the GitHub window…');
  assert.ok(!app.status() || app.status().hidden, 'not the footer');
});

// ------------------------------------------- U1 (D20): the marker cookie and the resume --
test('U1: on / the hc_in=1 marker triggers the resume (same-origin, X-HC-Session: 1); without it nothing is called', async () => {
  const app = await boot({ hash: '#/', ...SIGNED_IN });
  const calls = app.fetches.filter((f) => f.url.startsWith('/api/'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/auth?session=1');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.equal(calls[0].init.headers['X-HC-Session'], '1');
  for (const cookie of ['', 'theme=dark', 'xhc_in=1', 'hc_in=0', 'hc_in=1x']) {
    const guest = await boot({ hash: '#/', cookie, resume: SIGNED_IN.resume });
    assert.ok(!guest.fetches.some((f) => f.url.startsWith('/api/')), `no resume call for ${JSON.stringify(cookie)}`);
    assert.equal(guest.scriptsOrLinks().length, 0);
    assert.equal(guest.signIn().hidden, false);
  }
});

test('U1: a marker the server turns down (401) loads no editor code and shows "Sign in"', async () => {
  const app = await boot({ hash: '#/', cookie: 'hc_in=1' });
  assert.equal(app.fetches.filter((f) => f.url === '/api/auth?session=1').length, 1);
  assert.equal(app.scriptsOrLinks().length, 0, 'nothing injected');
  assert.equal(app.signIn().hidden, false, 'a guest again');
  const expired = await boot({ hash: '#/', cookie: 'hc_in=1', resume: { token: '<yours>', expires_at: Date.now() - 1 } });
  assert.equal(expired.scriptsOrLinks().length, 0, 'an answer already past its expiry is not used');
});

test('U1: a preview frame never reads the marker or calls the resume', async () => {
  const app = await boot({ framed: true, route: '/', storage: 'throws', ...SIGNED_IN });
  assert.equal(app.fetches.length, 0);
  assert.equal(app.scriptsOrLinks().length, 0);
});

// ---------------------------------------------- window.HCShell: pure helpers --
const SETUP_FIXTURE = { sections: [
  { id: 'a', title: 'Getting started', pages: [{ id: 'a/one', title: 'One' }, { id: 'a/pkg', title: 'Pre-built Packages' }] },
  { id: 'b', title: 'Raspberry Pi setup', pages: [{ id: 'b/qol', title: 'Quality-of-Life Features' }, { id: 'b/pkg', title: 'Pre-built Packages' }] },
  { id: 'c', title: 'Guides', pages: [{ id: 'c/qol', title: 'Quality-of-Life Features' }, { id: 'c/two', title: 'Two' }] },
] };

test('HCShell is a frozen object of pure helpers', async () => {
  const app = await boot({ hash: '#/' });
  const S = app.win.HCShell;
  assert.ok(S && Object.isFrozen(S));
  for (const k of ['sidebarModel', 'dupTitleSet', 'recedeState']) assert.equal(typeof S[k], 'function', k);
});

test('P6: dupTitleSet holds exactly the titles that appear in more than one group', async () => {
  const { HCShell } = (await boot({ hash: '#/' })).win;
  assert.deepEqual([...HCShell.dupTitleSet(SETUP_FIXTURE)].sort(), ['Pre-built Packages', 'Quality-of-Life Features']);
  assert.equal(HCShell.dupTitleSet({ sections: [] }).size, 0);
  assert.equal(HCShell.dupTitleSet(null).size, 0, 'a missing registry is no duplicates, not a crash');
  // the same title twice inside ONE group is not ambiguous across groups
  assert.equal(HCShell.dupTitleSet({ sections: [{ title: 'G', pages: [{ id: 'x', title: 'T' }, { id: 'y', title: 'T' }] }] }).size, 0);
});

test('P5/P6: sidebarModel opens only the active page\'s group and suffixes only duplicate titles', async () => {
  const { HCShell } = (await boot({ hash: '#/' })).win;
  const m = HCShell.sidebarModel(SETUP_FIXTURE, 'b/pkg');
  assert.deepEqual(m.map((g) => g.title), ['Getting started', 'Raspberry Pi setup', 'Guides']);
  assert.deepEqual(m.map((g) => g.open), [false, true, false], 'exactly one open group: the active page\'s');
  assert.deepEqual(m[1].pages.map((p) => p.active), [false, true]);
  const labels = m.flatMap((g) => g.pages.map((p) => p.label));
  assert.deepEqual(labels, ['One', 'Pre-built Packages · Getting started', 'Quality-of-Life Features · Raspberry Pi setup',
    'Pre-built Packages · Raspberry Pi setup', 'Quality-of-Life Features · Guides', 'Two']);
  assert.equal(m[0].pages[0].suffix, null, 'a unique title has no suffix');
  assert.equal(m[0].pages[1].suffix, 'Getting started');
  assert.deepEqual(HCShell.sidebarModel(SETUP_FIXTURE, null).map((g) => g.open), [false, false, false]);
  assert.deepEqual(HCShell.sidebarModel(SETUP_FIXTURE, 'no/such').map((g) => g.open), [false, false, false]);
});

test('P5/P6: on the real registry, one group is open and the duplicate titles carry their group', async () => {
  const { HCShell } = (await boot({ hash: '#/' })).win;
  const setup = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'setup.json'), 'utf8'));
  const m = HCShell.sidebarModel(setup, 'getting-started/px4-setup');
  assert.equal(m.filter((g) => g.open).length, 1);
  assert.equal(m.find((g) => g.open).title, 'Getting started');
  const dups = HCShell.dupTitleSet(setup);
  for (const t of ['Pre-built Packages', 'Quality-of-Life Features']) assert.ok(dups.has(t), t);
  for (const g of m) {
    for (const p of g.pages) {
      const title = setup.sections.find((s) => s.title === g.title).pages.find((x) => x.id === p.id).title;
      assert.equal(p.label, dups.has(title) ? `${title} · ${g.title}` : title);
    }
  }
});

test('F3: recedeState hides after a down move past 80 px, shows after a 24 px up move or at the top', async () => {
  const { HCShell } = (await boot({ hash: '#/' })).win;
  const R = HCShell.recedeState;
  const shown = { hidden: false };
  const hidden = { hidden: true };
  assert.equal(R(shown, { y: 400, dy: 400 }).hidden, true, 'a jump down past 80');
  assert.equal(R(shown, { y: 81, dy: 1 }).hidden, true);
  assert.equal(R(shown, { y: 80, dy: 10 }).hidden, false, 'not past 80 yet');
  assert.equal(R(hidden, { y: 300, dy: -23 }).hidden, true, 'a small move up keeps it away');
  assert.equal(R(hidden, { y: 300, dy: -24 }).hidden, false, '24 px up brings it back');
  assert.equal(R(hidden, { y: 0, dy: -5 }).hidden, false, 'the top always shows it');
  assert.equal(R(hidden, { y: 0, dy: 0 }).hidden, false);
  assert.equal(R(hidden, { y: 500, dy: 0 }).hidden, true, 'no move: no change');
  assert.equal(R(shown, { y: 500, dy: 0 }).hidden, false);
  assert.equal(R(null, { y: 0, dy: 0 }).hidden, false, 'no previous state: shown');
});

test('F3: signing out while scrolled down shows the sign-in button at once (no stale recede state)', async () => {
  const app = await boot({ hash: '#/' });
  const scroll = (y) => { app.win.scrollY = y; for (const fn of (app.listeners.scroll || []).slice()) fn({ type: 'scroll' }); };
  scroll(400);
  assert.equal(app.doc.body.classList.contains('hc-signin-hidden'), true, 'scrolled down: the button receded');
  app.click();
  await settle();
  await app.loadAll();
  app.starts[0].onSession(true);
  scroll(600);
  app.starts[0].onSession(false);
  assert.equal(app.signIn().hidden, false);
  assert.equal(app.doc.body.classList.contains('hc-signin-hidden'), false, 'the shown button is not slid away');
});
