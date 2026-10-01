// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 2 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test the Editor mode's frame side (js/editor-frame.js): grouping, marks, picks and the no-op on the live site.
/* Unit tests for js/editor-frame.js over a small fake DOM (node has none).

   What they pin: on the live site the file does nothing at all; in a
   preview frame it posts hc-ready, reports link-followed routes, and on the
   parent's hc-editor {on: true} groups the page body's top-level children
   between THIS load's sentinels into .hc-block[data-index] wrappers
   (stopping at app.js/lab.js chrome), paints hc-selected and the overlay's
   hc-prop-* classes, sets the hc-framed body class (css/editor.css hides the
   frame's own chrome with it), and posts hc-block-select / hc-block-insert
   for the pencil, a click and the "+" picker. A real browser checks the
   same grouping over every content page (tools/tests/browser_oracles.mjs).

     node --test tools/tests/test_editor_frame.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const EF = require(path.join(ROOT, 'js', 'editor-frame.js'));
const C = require(path.join(ROOT, 'js', 'cms-core.js'));
const PREFIX = 'a1b2c3d4e5f60718';

// ------------------------------------------------------------ a fake DOM --

class Node {
  constructor(doc, type) { this.ownerDocument = doc; this.nodeType = type; this.parentNode = null; this.childNodes = []; }
  get previousSibling() { const s = this.parentNode ? this.parentNode.childNodes : []; return s[s.indexOf(this) - 1] || null; }
  get nextSibling() { const s = this.parentNode ? this.parentNode.childNodes : []; const i = s.indexOf(this); return i < 0 ? null : s[i + 1] || null; }
}
class Text extends Node {
  constructor(doc, data) { super(doc, 3); this.data = data; }
  get textContent() { return this.data; }
}
class El extends Node {
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
  dispatch(t, target) {
    // bubbles from target up to this element's document root
    for (let n = target || this; n; n = n.parentNode) {
      for (const fn of (n.listeners && n.listeners[t]) || []) fn({ type: t, target: target || this, stopPropagation() { this.stopped = true; } });
    }
  }
  click() { this.dispatch('click', this); }
  scrollIntoView() { this.scrolled += 1; }
}

function el(doc, tag, attrs, ...kids) {
  const e = new El(doc, tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (k === 'id') e.id = v; else if (k === 'class') e.className = v; else e.setAttribute(k, v); }
  kids.forEach((k) => e.appendChild(typeof k === 'string' ? new Text(doc, k) : k));
  return e;
}

function makeDoc() {
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

const S = (doc, i, prefix) => el(doc, 'div', { id: `hcb-${prefix || PREFIX}-${i}` });

/* A setup page as app.js leaves it: the Markdown's top-level elements with
   sentinels (blocks 1 and 4 are blank-line blocks: no sentinel), then the
   prev/next nav and lab.js's "who wrote this". */
function setupPage() {
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

function fakeHC(prefix) {
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

function fakeWin() {
  const listeners = {};
  return { listeners, location: { hash: '#/setup/x' }, setTimeout: (fn) => fn(),
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); } };
}

const kids = (n) => n.childNodes.filter((c) => c.nodeType === 1);
const blocksOf = (body) => kids(body).filter((c) => c.classList.contains('hc-block'));
const summary = (w) => kids(w).filter((c) => !c.classList.contains('hc-pencil')).map((c) => c.id || c.tagName.toLowerCase() + (c.className ? `.${c.className.split(' ')[0]}` : ''));

// ------------------------------------------------------------------ tests --

test('editor-frame: on the live site it does nothing — no listener, no post, no runtime', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'editor-frame.js'), 'utf8');
  const win = fakeWin();
  const posts = [];
  win.HC = { preview: false, blockPrefix: null, post: (t) => { posts.push(t); return false; }, onEditor: () => false };
  const doc = makeDoc();
  const ctx = vm.createContext(Object.assign(win, { document: doc, window: win }));
  win.window = ctx;
  vm.runInContext(src, ctx, { filename: 'editor-frame.js' });
  assert.equal(ctx.HCEditorFrame.runtime, null);
  assert.deepEqual(Object.keys(win.listeners), [], 'no window listener');
  assert.deepEqual(Object.keys(doc.listeners), [], 'no document listener');
  assert.deepEqual(posts, []);
  assert.equal(EF.create(win, doc, null), null);
});

test('editor-frame: in a frame it posts hc-ready, and hc-route when the reader follows a link', () => {
  const { doc } = setupPage();
  const win = fakeWin();
  const HC = fakeHC();
  EF.create(win, doc, HC);
  assert.deepEqual(HC.posts, [{ type: 'hc-ready' }]);
  win.location.hash = '#/setup/lab-gantry/usage';
  win.listeners.hashchange.forEach((fn) => fn({}));
  win.location.hash = '#preview=0123456789abcdef0123&route=%2F';   // js/source.js reloads for this one
  win.listeners.hashchange.forEach((fn) => fn({}));
  win.location.hash = '';
  win.listeners.hashchange.forEach((fn) => fn({}));
  assert.deepEqual(HC.posts.slice(1), [{ type: 'hc-route', route: '/setup/lab-gantry/usage' }, { type: 'hc-route', route: '/' }]);
});

test('editor-frame: grouping wraps exactly the elements between sentinels, and stops at page chrome', () => {
  const { doc, body } = setupPage();
  const HC = fakeHC();
  EF.create(fakeWin(), doc, HC);
  assert.equal(blocksOf(body).length, 0, 'nothing is grouped before the parent turns Editor mode on');
  HC.send({ on: true });
  const blocks = blocksOf(body);
  assert.deepEqual(blocks.map((w) => w.getAttribute('data-index')), ['0', '2', '3', '5']);
  assert.deepEqual(blocks.map(summary), [
    [`hcb-${PREFIX}-0`, 'h1'],
    [`hcb-${PREFIX}-2`, 'p', 'p'],
    [`hcb-${PREFIX}-3`, 'div.adm', 'hcb-ffffffffffffffff-9'],
    [`hcb-${PREFIX}-5`, 'div.code-wrap'],
  ]);
  const top = kids(body).map((c) => c.className.split(' ')[0] || c.tagName.toLowerCase());
  assert.deepEqual(top, ['hc-plus', 'hc-block', 'hc-plus', 'hc-block', 'hc-plus', 'hc-block', 'hc-plus', 'hc-block', 'hc-plus',
    'page-nav', 'hc-authors'], 'a rail before every block and after the last; nav and authors stay outside');
  // idempotent: another apply (a DOM change) changes nothing
  const before = JSON.stringify(kids(body).map((c) => [c.className, kids(c).length]));
  HC.send({ on: true });
  assert.equal(JSON.stringify(kids(body).map((c) => [c.className, kids(c).length])), before);
  // the pure helper agrees on a fresh page
  const fresh = setupPage();
  assert.deepEqual(EF.groupBlocks(fresh.doc, fresh.body, PREFIX).map((w) => summary(w)), blocks.map(summary));
  assert.equal(EF.sentinelIndex(el(doc, 'span', { id: `hcb-${PREFIX}-1` }), PREFIX), null, 'only a div is a mark');
  assert.equal(EF.sentinelIndex(el(doc, 'div', { id: `hcb-${PREFIX}-1x` }), PREFIX), null);
  assert.equal(EF.sentinelIndex(el(doc, 'div', { id: `hcb-${PREFIX}-12` }), PREFIX), 12);
});

test('editor-frame: a content file cannot fake a mark — only this load\'s prefix groups', () => {
  const { doc, body } = setupPage();
  const HC = fakeHC('0000000000000000');                 // the page carries other marks
  EF.create(fakeWin(), doc, HC);
  HC.send({ on: true });
  assert.equal(blocksOf(body).length, 0);
});

test('editor-frame: hc-framed, settings, hc-selected and the overlay classes follow the parent\'s message', () => {
  const { doc, body } = setupPage();
  const HC = fakeHC();
  EF.create(fakeWin(), doc, HC);
  HC.send({ on: false });
  assert.equal(doc.body.classList.contains('hc-framed'), false);
  assert.equal(blocksOf(body).length, 0, 'off draws nothing');
  HC.send({ on: true, selected: 2, overlay: [{ index: 3, mark: 'add' }, { index: 5, mark: 'del' }],
    settings: { suggestions: false, diff: 'side', compact: true, outlines: false } });
  const b = doc.body.classList;
  assert.ok(b.contains('hc-framed') && b.contains('hc-edit-on') && b.contains('hc-compact')
    && b.contains('hc-hide-suggestions') && b.contains('hc-diff-side'));
  assert.equal(b.contains('hc-outlines'), false);
  const [w0, w2, w3, w5] = blocksOf(body);
  assert.ok(w2.classList.contains('hc-selected') && !w0.classList.contains('hc-selected'));
  assert.equal(w2.scrolled, 1, 'the selected block is scrolled into view');
  assert.ok(w3.classList.contains('hc-prop-add') && w5.classList.contains('hc-prop-del'));
  HC.send({ on: true, selected: 0, overlay: [] });
  assert.ok(w0.classList.contains('hc-selected') && !w2.classList.contains('hc-selected'));
  assert.ok(!w3.classList.contains('hc-prop-add'), 'marks the new message does not name are cleared');
  // css/editor.css is loaded once, and it hides the frame's own chrome under hc-framed
  const links = kids(doc.head).filter((c) => c.tagName === 'LINK');
  assert.equal(links.length, 1);
  assert.equal(links[0].href, 'css/editor.css');
  const css = fs.readFileSync(path.join(ROOT, 'css', 'editor.css'), 'utf8');
  for (const sel of ['body.hc-framed .site-header', 'body.hc-framed .sidebar', 'body.hc-framed .site-footer']) {
    assert.ok(css.includes(sel), `${sel} is hidden`);
  }
  assert.match(css, /body\.hc-framed \.skip-link \{ display: none !important; \}/);
});

test('editor-frame: pencil and click select a block; a link does not; "+" offers the snippet kinds', () => {
  const { doc, body } = setupPage();
  const HC = fakeHC();
  EF.create(fakeWin(), doc, HC);
  HC.send({ on: true });
  const [, w2, w3] = blocksOf(body);
  kids(w3).find((c) => c.classList.contains('hc-pencil')).click();
  kids(w2)[1].click();                                     // a paragraph
  kids(kids(w2)[1]).find((c) => c.tagName === 'A').click(); // a link inside it: navigation, not a pick
  assert.deepEqual(HC.posts.slice(1), [{ type: 'hc-block-select', index: 3 }, { type: 'hc-block-select', index: 2 }]);
  const rails = kids(body).filter((c) => c.classList.contains('hc-plus'));
  assert.deepEqual(rails.map((r) => r.getAttribute('data-insert')), ['0', '2', '3', '5', '6']);
  kids(rails[2])[0].click();                               // open the picker before block 3
  const picker = kids(rails[2]).find((c) => c.classList.contains('hc-picker'));
  assert.ok(picker && rails[2].classList.contains('is-open'));
  const kinds = kids(picker).map((b) => b.getAttribute('data-kind'));
  assert.deepEqual([...kinds].sort(), Object.keys(C.SNIPPET_CATALOG).sort(), 'the seven snippet kinds');
  kids(picker).find((b) => b.getAttribute('data-kind') === 'warning').click();
  assert.deepEqual(HC.posts.at(-1), { type: 'hc-block-insert', index: 3, kind: 'warning' });
  assert.equal(kids(rails[2]).some((c) => c.classList.contains('hc-picker')), false, 'the picker closes');
  assert.ok(HC.posts.every((p) => Object.values(p).every((v) => typeof v !== 'string' || !/</.test(v))), 'no HTML in any message');
});

/* The walk's hook (TEST-ONLY): the localhost walk page cannot click inside
   the sandboxed frame, so on localhost / 127.0.0.1, when the frame sits
   under a top window that is not its parent (the walk page above the site),
   a message {type: 'hc-walk-picker', index} from that top window clicks the
   "+" rail before block `index` (the real click path) and answers the top
   window. Anywhere else no listener is added. */
function walkWin(hostname, framed) {
  const win = fakeWin();
  win.location.hostname = hostname;
  win.parent = { name: 'the site' };
  const answers = [];
  win.top = framed ? { name: 'the walk', postMessage: (m, o) => answers.push([m, o]) } : win.parent;
  return { win, answers };
}

test('editor-frame: on localhost under the walk, the top window\'s hc-walk-picker opens the real picker', () => {
  const { doc, body } = setupPage();
  const { win, answers } = walkWin('127.0.0.1', true);
  const HC = fakeHC();
  EF.create(win, doc, HC);
  HC.send({ on: true });
  assert.equal((win.listeners.message || []).length, 1, 'one listener, for the walk');
  const say = (source, data) => win.listeners.message.forEach((fn) => fn({ source, origin: 'http://127.0.0.1:8130', data }));
  say(win.parent, { type: 'hc-walk-picker', index: 3 });          // the parent is the Editor, not the walk
  say(win.top, { type: 'hc-other', index: 3 });
  say(win.top, { type: 'hc-walk-picker', index: '3' });
  const rails = kids(body).filter((c) => c.classList.contains('hc-plus'));
  assert.equal(rails.some((r) => r.classList.contains('is-open')), false, 'nothing else opens it');
  assert.deepEqual(answers, []);
  say(win.top, { type: 'hc-walk-picker', index: 3 });
  const rail = rails.find((r) => r.getAttribute('data-insert') === '3');
  const picker = kids(rail).find((c) => c.classList.contains('hc-picker'));
  assert.ok(picker && rail.classList.contains('is-open'), 'the rail before block 3 is open');
  assert.equal(rail.scrolled, 1, 'and scrolled into view');
  const kinds = EF.INSERT_KINDS.map((k) => k.kind);
  assert.deepEqual(answers, [[{ type: 'hc-walk-picker-open', index: 3, open: true, kinds }, 'http://127.0.0.1:8130']]);
  say(win.top, { type: 'hc-walk-picker', index: 3 });             // asked again: stays open, says so again
  assert.ok(rail.classList.contains('is-open'));
  assert.equal(answers.length, 2);
  assert.equal(answers[1][0].open, true);
  say(win.top, { type: 'hc-walk-picker', index: 4 });             // no rail there (a blank-line block)
  assert.deepEqual(answers[2][0], { type: 'hc-walk-picker-open', index: 4, open: false, kinds: [] });
  assert.equal(HC.posts.filter((p) => p.type !== 'hc-ready').length, 0, 'the parent is told nothing');
});

test('editor-frame: the walk hook is absent off localhost and in the real Editor (top is the parent)', () => {
  for (const [host, framed] of [['hippocampus-docs.vercel.app', true], ['localhost', false], ['127.0.0.1', false]]) {
    const { doc } = setupPage();
    const { win } = walkWin(host, framed);
    EF.create(win, doc, fakeHC());
    assert.equal(win.listeners.message, undefined, `${host} framed=${framed}: no message listener`);
  }
});
