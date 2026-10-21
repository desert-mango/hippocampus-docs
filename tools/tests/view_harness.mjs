// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 21 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Boot the public site's scripts in a vm over a fake DOM for view tests, and parse the theme tokens for contrast tests.
/* The view harness (uiux plan, unit 0). Two exports:

   bootSite(opts) -> Promise<site>
     index.html's scripts, in index.html's order, run in a vm over a permissive
     fake DOM (the one tools/tests/test_app_guest.mjs uses: anything not modelled
     is an inert sink), with the repository's files as the network. The CONTRACT,
     which is all a test may rely on:
       opts.hash      the initial location.hash (default '#/')
       opts.hostname  default 'docs.example.org'
       opts.protocol  default 'https:'
       opts.files     { path: text } overrides for the fake network (null: a 404)
       opts.media     (query) => boolean backs matchMedia(query).matches (default: always false);
                      matchMedia(...).addEventListener('change', fn) records fn in site.mediaListeners
       site.replaced  location.replace(url) is a SPY: it records url here and changes nothing
       site.content.innerHTML, site.sidebar.innerHTML
                      the strings the views stored into #content / #sidebar
       site.document.title (also site.title)
       site.go(hash)  sets the hash, fires hashchange, and resolves only after the
                      microtask/timer drain plus a 50 ms quiet period (never on the
                      first innerHTML change: viewSearch paints "Searching..." first)
     NOT granted: querySelector beyond the memo (every selector answers one inert
     fake node, the same one each time), IntersectionObserver (absent), layout,
     focus, CSS, and any view that clears #content and then appendChilds (setup
     pages, tool pages, the Team page: their site.content.innerHTML stays '' and a
     test must not read it). Those are browser checks.
     Diagnostics only (not contract): site.errors (scripts that threw while
     loading), site.fetches.

   contrastPairs(cssText) -> { dark, light, ratio(fg, bg, base), mix(a, b, pct) }
     dark/light: the :root and [data-theme="light"] token blocks of css/site.css,
     var() and color-mix() resolved (light = :root overlaid with the light block,
     as both match <html>). ratio: the WCAG 2 contrast ratio of two colours; a
     translucent fg is composited over bg, a translucent bg over `base`.
     mix: color-mix(in srgb, a pct%, b), premultiplied alpha, as an rgba() string.
*/
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const SCRIPTS = ['source.js', 'editor-frame.js', 'sanitize.js', 'marked.min.js', 'search.js',
  'graph.js', 'lab.js', 'app.js'];

// ----------------------------------------------------- permissive DOM ---

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
  const adopt = (c) => { if (c && typeof c === 'object') c.parentNode = node; return c; };
  const methods = {
    appendChild(c) { store.children.push(c); return adopt(c); },
    append(...cs) { cs.forEach((c) => methods.appendChild(c)); },
    prepend(c) { store.children.unshift(c); return adopt(c); },
    insertBefore(c) { store.children.push(c); return adopt(c); },
    after(...cs) { cs.forEach(adopt); },
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
  const doc = { memos: new Map() };
  doc.memo = (sel) => {
    if (!doc.memos.has(sel)) doc.memos.set(sel, makeNode('div', doc));
    return doc.memos.get(sel);
  };
  const head = makeNode('head', doc);
  const body = makeNode('body', doc);
  const html = makeNode('html', doc);
  const edit = doc.memo('#edit-page');   // index.html's footer link starts hidden
  edit.hidden = true;
  edit.textContent = 'Edit this page';
  const api = {
    head, body, documentElement: html, activeElement: body, title: '',
    querySelector: (sel) => doc.memo(sel),
    getElementById: (id) => doc.memo(`#${id}`),
    querySelectorAll: () => [],
    createElement: (tag) => makeNode(tag, doc),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
    createDocumentFragment: () => makeNode('#fragment', doc),
    addEventListener() {},
    removeEventListener() {},
  };
  doc.api = new Proxy(api, {
    get(t, k) { return k in api ? api[k] : (k === 'then' ? undefined : SINK); },
    set(t, k, v) { api[k] = v; return true; },
  });
  return doc;
}

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

const tick = () => new Promise((r) => setImmediate(r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// the drain test_app_guest.mjs uses: 60 macrotask turns
const settle = async () => { for (let i = 0; i < 60; i += 1) await tick(); };

const cleanPath = (p) => String(p).split('?')[0].split('#')[0].replace(/^\.?\//, '');

function textResponse(text) {
  return {
    ok: text !== null, status: text !== null ? 200 : 404,
    headers: { get: () => null },
    text: async () => (text === null ? '' : text),
    json: async () => JSON.parse(text),
  };
}

function fileText(p) {
  const clean = cleanPath(p);
  if (!clean || clean.includes('..')) return null;
  try { return fs.readFileSync(path.join(ROOT, clean), 'utf8'); } catch (e) { return null; }
}

export async function bootSite(opts) {
  const o = opts || {};
  const doc = makeDocument();
  const listeners = {};
  const fetches = [];
  const replaced = [];
  const mediaListeners = [];
  const files = o.files || {};
  const media = typeof o.media === 'function' ? o.media : () => false;
  const protocol = o.protocol || 'https:';
  const hostname = o.hostname || 'docs.example.org';
  const location = {
    origin: `${protocol}//${hostname}`, protocol, host: hostname, hostname,
    pathname: '/', search: '', hash: o.hash || '#/',
    get href() { return `${this.origin}/${this.hash}`; },
    reload() {},
    replace(url) { replaced.push(String(url)); },
    assign() {},
  };
  // an override: a string is the file's text, null is a 404; undefined (or no key) reads the repository
  const own = (url) => {
    for (const k of [String(url), cleanPath(url)]) {
      if (Object.prototype.hasOwnProperty.call(files, k) && files[k] !== undefined) {
        return { text: files[k] === null ? null : String(files[k]) };
      }
    }
    return null;
  };
  const sandbox = {
    document: doc.api,
    location,
    history: { replaceState: (s, t, url) => { location.hash = String(url).slice(String(url).indexOf('#')); } },
    navigator: { userAgent: 'node', clipboard: SINK },
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener: () => {},
    fetch: (url, init) => {
      fetches.push({ url: String(url), method: (init && init.method) || 'GET' });
      const hit = own(url);
      return Promise.resolve(textResponse(hit ? hit.text : fileText(url)));
    },
    open: () => null,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: () => {},
    scrollTo: () => {},
    matchMedia: (query) => ({
      media: String(query),
      get matches() { return Boolean(media(String(query))); },
      addEventListener(type, fn) { if (type === 'change') mediaListeners.push(fn); },
      removeEventListener() {},
      addListener(fn) { mediaListeners.push(fn); },
      removeListener() {},
    }),
    getComputedStyle: () => SINK,
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, console,
    crypto: { getRandomValues: (a) => a },
    DOMParser: function DOMParser() { return SINK; },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    MutationObserver: function MutationObserver() { return { observe() {}, disconnect() {} }; },
  };
  const win = vm.createContext(sandbox);
  win.window = win;
  win.self = win;
  win.top = win;
  win.parent = win;
  const errors = [];
  for (const f of SCRIPTS) {
    try {
      vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), win, { filename: f });
    } catch (e) {
      errors.push(`${f}: ${e.message}`);
    }
  }
  const content = doc.memo('#content');
  const sidebar = doc.memo('#sidebar');
  const snapshot = () => [String(content.innerHTML), String(sidebar.innerHTML), String(doc.api.title),
    location.hash, replaced.length].join('\u0000');
  // the drain, then 50 ms in which nothing the contract exposes changed
  const quiet = async () => {
    for (let round = 0; round < 40; round += 1) {
      await settle();
      const before = snapshot();
      await wait(50);
      await settle();
      if (snapshot() === before) return;
    }
  };
  const site = {
    win, document: doc.api, location, content, sidebar, replaced, mediaListeners, errors, fetches,
    get title() { return doc.api.title; },
    async go(hash) {
      const oldURL = location.href;
      location.hash = hash;
      for (const fn of (listeners.hashchange || []).slice()) fn({ type: 'hashchange', oldURL, newURL: location.href });
      await quiet();
    },
  };
  await quiet();
  return site;
}

// ------------------------------------------------------ contrastPairs ---

const NAMED = { transparent: [0, 0, 0, 0], white: [255, 255, 255, 1], black: [0, 0, 0, 1] };

function parseColor(value) {
  const v = String(value).trim().toLowerCase();
  if (v in NAMED) return NAMED[v].slice();
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) throw new Error(`bad hex colour ${value}`);
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  m = /^rgba?\(([^)]*)\)$/.exec(v);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    const ch = (s) => (s.endsWith('%') ? (parseFloat(s) * 255) / 100 : parseFloat(s));
    const a = parts[3] === undefined ? 1 : (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]));
    return [ch(parts[0]), ch(parts[1]), ch(parts[2]), a];
  }
  if (v.startsWith('color-mix(')) return parseColor(evalMix(v));
  throw new Error(`not a colour this parser knows: ${value}`);
}

const fmt = (c) => `rgba(${c.slice(0, 3).map((x) => Math.round(x * 1000) / 1000).join(', ')}, ${Math.round(c[3] * 10000) / 10000})`;

// color-mix(in srgb, A p%, B q%): premultiplied-alpha interpolation in (gamma-encoded) sRGB
function mixColors(a, pa, b, pb) {
  let p1 = pa;
  let p2 = pb;
  if (p1 === null && p2 === null) { p1 = 50; p2 = 50; } else if (p1 === null) p1 = 100 - p2; else if (p2 === null) p2 = 100 - p1;
  const sum = p1 + p2;
  if (sum <= 0) throw new Error('color-mix percentages sum to zero');
  const w1 = p1 / sum;
  const w2 = p2 / sum;
  const ca = parseColor(a);
  const cb = parseColor(b);
  let alpha = ca[3] * w1 + cb[3] * w2;
  const out = [0, 0, 0];
  if (alpha > 0) for (let i = 0; i < 3; i += 1) out[i] = (ca[i] * ca[3] * w1 + cb[i] * cb[3] * w2) / alpha;
  if (sum < 100) alpha *= sum / 100;
  return fmt([...out, alpha]);
}

function splitTop(s) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch;
  }
  parts.push(cur.trim());
  return parts;
}

function evalMix(expr) {
  const inner = expr.trim().replace(/^color-mix\(/i, '').replace(/\)$/, '');
  const [space, x, y] = splitTop(inner);
  if (!/^in\s+srgb$/i.test(space)) throw new Error(`only color-mix(in srgb, ...) is implemented: ${expr}`);
  const arg = (s) => {
    let m = /^(.*\S)\s+([\d.]+)%$/.exec(s);
    if (m) return [m[1], parseFloat(m[2])];
    m = /^([\d.]+)%\s+(.*)$/.exec(s);
    if (m) return [m[2], parseFloat(m[1])];
    return [s, null];
  };
  const [ca, pa] = arg(x);
  const [cb, pb] = arg(y);
  return mixColors(ca, pa, cb, pb);
}

function tokenBlock(cssText, selectorRe) {
  const m = selectorRe.exec(cssText);
  if (!m) throw new Error(`token block not found: ${selectorRe}`);
  const body = m[1].replace(/\/\*[\s\S]*?\*\//g, '');
  const out = {};
  for (const d of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  return out;
}

function resolveTokens(raw) {
  const out = {};
  const resolve = (name, seen) => {
    if (name in out) return out[name];
    if (!(name in raw)) throw new Error(`unknown token ${name}`);
    if (seen.has(name)) throw new Error(`token cycle at ${name}`);
    seen.add(name);
    let v = raw[name];
    for (let i = 0; i < 20 && /var\(--[\w-]+\)/.test(v); i += 1) {
      v = v.replace(/var\((--[\w-]+)\)/g, (s, n) => resolve(n, seen));
    }
    if (/^color-mix\(/i.test(v)) v = evalMix(v);
    out[name] = v;
    return v;
  };
  for (const k of Object.keys(raw)) resolve(k, new Set());
  return out;
}

function luminance(c) {
  const lin = (x) => {
    const s = x / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

function over(top, under) {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1);
}

export function contrastPairs(cssText) {
  const css = String(cssText);
  const rootRaw = tokenBlock(css, /^:root\s*\{([\s\S]*?)^\}/m);
  const lightRaw = tokenBlock(css, /^\[data-theme="light"\]\s*\{([\s\S]*?)^\}/m);
  const dark = resolveTokens(rootRaw);
  const light = resolveTokens({ ...rootRaw, ...lightRaw });
  function ratio(fg, bg, base) {
    let b = parseColor(bg);
    if (b[3] < 1) {
      if (base === undefined) throw new Error(`a translucent background (${bg}) needs a base colour`);
      b = over(b, parseColor(base));
    }
    let f = parseColor(fg);
    if (f[3] < 1) f = over(f, b);
    const l1 = luminance(f);
    const l2 = luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  const mix = (a, b, pct) => mixColors(a, pct, b, null);
  return { dark, light, ratio, mix };
}
