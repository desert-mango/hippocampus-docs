// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 26 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: A fake DOM for the Editor mode's frame side (js/editor-frame.js) and a loader for its lazy scripts, for tests.
/* The frame harness (editor UI/UX build, unit U0). Extracted from tools/tests/test_editor_frame.mjs so every
   unit's frame tests (tools/tests/test_editor_frame_<unit>.mjs, test_editor_people.mjs) build the frame's page
   the same way. The name does not start with test_: the node --test glob never runs it on its own.

   The CONTRACT, which is all a test may rely on:
     PREFIX                 this load's block prefix (fakeHC's blockPrefix)
     makeDoc()              a document: createElement, head, body, addEventListener (doc.listeners by type),
                            getElementById (a walk of the body)
     el(doc, tag, attrs, ...kids)   an element; attrs.id / attrs.class set id / className, others setAttribute;
                            a string kid is a Text node
     El                     childNodes, parentNode, previousSibling / nextSibling, classList (add, remove, contains,
                            toggle), className, textContent, set/get/removeAttribute, appendChild, insertBefore,
                            removeChild, addEventListener (el.listeners), dispatch(type, target, extra) (bubbles to
                            the root; the event has stopPropagation / preventDefault), click(), scrollIntoView()
                            (counts el.scrolled)
     S(doc, i, prefix)      the sentinel div of block i
     setupPage()            {doc, content, body}: a setup page as js/app.js leaves it (blocks 0, 2, 3, 5 with
                            sentinels; another load's mark; the page nav and lab.js's authors section)
     fakeHC(prefix)         HC as js/source.js gives it in a preview: preview, blockPrefix, posts (every HC.post
                            {type, ...data}), send(m) (the parent's hc-editor, defaults on / overlay [] / the
                            View settings)
     fakeWin()              {listeners, location, setTimeout (runs at once), addEventListener}
     kids(n), blocksOf(body), summary(w)   element children, block wrappers, a wrapper's shape
     scriptsIn(doc)         the src of every <script> the frame appended to doc.head, in order
     runScripts(win, doc)   loads every such script not loaded yet: runs the repository file in a vm whose window
                            is win and document is doc (so window.HCEditorPeople etc. land on win), then fires the
                            element's 'load' listeners; returns the srcs it ran
   NOT granted: querySelector / querySelectorAll / closest / children / focus on El (a test that needs them adds
   them to its own nodes), layout (getBoundingClientRect is absent), CSS, MutationObserver, real timers. Those are
   browser checks (tools/tests/browser_oracles.mjs). */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
export const PREFIX = 'a1b2c3d4e5f60718';

// ------------------------------------------------------------ a fake DOM --

export class Node {
  constructor(doc, type) { this.ownerDocument = doc; this.nodeType = type; this.parentNode = null; this.childNodes = []; }
  get previousSibling() { const s = this.parentNode ? this.parentNode.childNodes : []; return s[s.indexOf(this) - 1] || null; }
  get nextSibling() { const s = this.parentNode ? this.parentNode.childNodes : []; const i = s.indexOf(this); return i < 0 ? null : s[i + 1] || null; }
}
export class Text extends Node {
  constructor(doc, data) { super(doc, 3); this.data = data; }
  get textContent() { return this.data; }
}
export class El extends Node {
  constructor(doc, tag) {
    super(doc, 1);
    this.tagName = tag.toUpperCase();
    this.attrs = {};
    this.listeners = {};
    this.id = '';
    this._cls = new Set();
    const self = this;
    this.classList = {
      add: (c) => self._cls.add(c), remove: (c) => self._cls.delete(c), contains: (c) => self._cls.has(c),
      toggle: (c, on) => { const want = on === undefined ? !self._cls.has(c) : Boolean(on); if (want) self._cls.add(c); else self._cls.delete(c); return want; },
    };
    this.scrolled = 0;
  }
  get className() { return [...this._cls].join(' '); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(t) { this.childNodes.forEach((c) => { c.parentNode = null; }); this.childNodes = t ? [new Text(this.ownerDocument, String(t))] : []; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  _detach(c) { if (c.parentNode) { const s = c.parentNode.childNodes; s.splice(s.indexOf(c), 1); } }
  appendChild(c) { this._detach(c); this.childNodes.push(c); c.parentNode = this; return c; }
  insertBefore(c, ref) {
    if (ref === null || ref === undefined) return this.appendChild(c);
    this._detach(c);
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, c);
    c.parentNode = this;
    return c;
  }
  removeChild(c) { this._detach(c); c.parentNode = null; return c; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  dispatch(t, target, extra) {
    // bubbles from target up to this element's document root
    for (let n = target || this; n; n = n.parentNode) {
      for (const fn of (n.listeners && n.listeners[t]) || []) fn({ type: t, target: target || this, ...(extra || {}), stopPropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; } });
    }
  }
  click() { this.dispatch('click', this); }
  scrollIntoView() { this.scrolled += 1; }
}

export function el(doc, tag, attrs, ...kids) {
  const e = new El(doc, tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (k === 'id') e.id = v; else if (k === 'class') e.className = v; else e.setAttribute(k, v); }
  kids.forEach((k) => e.appendChild(typeof k === 'string' ? new Text(doc, k) : k));
  return e;
}

export function makeDoc() {
  const doc = { listeners: {} };
  doc.createElement = (t) => new El(doc, t);
  doc.head = new El(doc, 'head');
  doc.body = new El(doc, 'body');
  doc.addEventListener = (t, fn) => { (doc.listeners[t] = doc.listeners[t] || []).push(fn); };
  doc.getElementById = (id) => {
    const walk = (n) => { if (n.id === id) return n; for (const c of n.childNodes || []) { if (c.nodeType === 1) { const r = walk(c); if (r) return r; } } return null; };
    return walk(doc.body);
  };
  return doc;
}

export const S = (doc, i, prefix) => el(doc, 'div', { id: `hcb-${prefix || PREFIX}-${i}` });

/* A setup page as app.js leaves it: the Markdown's top-level elements with
   sentinels (blocks 1 and 4 are blank-line blocks: no sentinel), then the
   prev/next nav and lab.js's "who wrote this". */
export function setupPage() {
  const doc = makeDoc();
  const content = el(doc, 'main', { id: 'content', class: 'content' });
  doc.body.appendChild(el(doc, 'header', { class: 'site-header' }));
  doc.body.appendChild(content);
  const body = el(doc, 'div', { class: 'page-body' },
    '\n', S(doc, 0), '\n', el(doc, 'h1', null, 'Title'), '\n',
    S(doc, 2), el(doc, 'p', null, 'Intro ', el(doc, 'a', { href: '#/about' }, 'link')), el(doc, 'p', null, 'dangling'),
    S(doc, 3), el(doc, 'div', { class: 'adm adm-note' }, el(doc, 'p', null, 'note')),
    el(doc, 'div', { id: 'hcb-ffffffffffffffff-9' }),            // another load's mark: plain content
    S(doc, 5), el(doc, 'div', { class: 'code-wrap' }, el(doc, 'pre', null, 'code')),
    el(doc, 'nav', { class: 'page-nav' }, el(doc, 'a', { href: '#/x' }, 'next')),
    el(doc, 'section', { class: 'hc-authors' }, 'who wrote this'));
  content.appendChild(body);
  return { doc, content, body };
}

export function fakeHC(prefix) {
  const posts = [];
  let listener = null;
  return {
    preview: true, blockPrefix: prefix || PREFIX, posts,
    post: (type, data) => { posts.push(Object.assign({ type }, data || {})); return true; },
    onEditor: (fn) => { listener = fn; return true; },
    send: (m) => listener(Object.assign({ on: true, selected: null, overlay: [],
      settings: { suggestions: true, diff: 'inline', compact: false, outlines: true } }, m)),
  };
}

export function fakeWin() {
  const listeners = {};
  return { listeners, location: { hash: '#/setup/x' }, setTimeout: (fn) => fn(),
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); } };
}

export const kids = (n) => n.childNodes.filter((c) => c.nodeType === 1);
export const blocksOf = (body) => kids(body).filter((c) => c.classList.contains('hc-block'));
export const summary = (w) => kids(w).filter((c) => !c.classList.contains('hc-pencil')).map((c) => c.id || c.tagName.toLowerCase() + (c.className ? `.${c.className.split(' ')[0]}` : ''));


export const scriptsIn = (doc) => kids(doc.head).filter((c) => c.tagName === 'SCRIPT').map((c) => c.src);

const RAN = new WeakSet();
export function runScripts(win, doc) {
  const ran = [];
  for (const s of kids(doc.head).filter((c) => c.tagName === 'SCRIPT')) {
    if (RAN.has(s)) continue;
    RAN.add(s);
    const code = fs.readFileSync(path.join(ROOT, s.src), 'utf8');
    vm.runInNewContext(code, { window: win, document: doc, console }, { filename: s.src });
    ran.push(s.src);
    for (const fn of s.listeners.load || []) fn({ type: 'load', target: s });
  }
  return ran;
}
