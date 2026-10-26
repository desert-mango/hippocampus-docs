// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 26 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test the U4 typing work inside the preview frame: un-strike, the "+" rail, boxes and the image tile.
/* Made by U0 (editor UI/UX build) so unit U4 adds its tests here, not to a shared test file.

   The typing engine (js/editor-type.js) needs text nodes, ranges, a selection and a tree walker, which the frame
   harness does not grant; a small DOM below gives exactly those (document order, boundary points as the browser
   keeps them, no layout). What it cannot show (real key presses, IME, the caret drawn) stays in
   tools/tests/browser_oracles.mjs.

     node --test tools/tests/test_editor_frame_u4.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const readRepo = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const T = require(path.join(ROOT, 'js', 'editor-type.js'));

// ------------------------------------------------------------- a small DOM with ranges and a selection --

class LNode {
  constructor(doc, type) { this.ownerDocument = doc; this.nodeType = type; this.parentNode = null; this.childNodes = []; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get previousSibling() { const s = this.parentNode ? this.parentNode.childNodes : []; return s[s.indexOf(this) - 1] || null; }
  get nextSibling() { const s = this.parentNode ? this.parentNode.childNodes : []; const i = s.indexOf(this); return i < 0 ? null : s[i + 1] || null; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.ownerDocument.body; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
}
class LText extends LNode {
  constructor(doc, data) { super(doc, 3); this.data = data; }
  get length() { return this.data.length; }
  get nodeName() { return '#text'; }
  get textContent() { return this.data; }
  splitText(i) {
    const rest = new LText(this.ownerDocument, this.data.slice(i));
    this.data = this.data.slice(0, i);
    if (this.parentNode) this.parentNode.insertBefore(rest, this.nextSibling);
    return rest;
  }
  deleteData(i, n) { this.data = this.data.slice(0, i) + this.data.slice(i + n); }
  insertData(i, s) { this.data = this.data.slice(0, i) + s + this.data.slice(i); }
  appendData(s) { this.data += s; }
}
const matches = (el, sel) => sel.split(',').map((s) => s.trim()).some((s) => {
  const a = /^\[([a-z-]+)="([^"]*)"\]$/.exec(s);
  if (a) return el.getAttribute(a[1]) === a[2];
  const t = /^([a-z0-9]+)(?:\[([a-z-]+)\])?$/.exec(s);
  return Boolean(t) && el.tagName === t[1].toUpperCase() && (!t[2] || el.getAttribute(t[2]) !== null);
});
class LEl extends LNode {
  constructor(doc, tag) { super(doc, 1); this.tagName = tag.toUpperCase(); this.attrs = {}; this.listeners = {}; }
  get nodeName() { return this.tagName; }
  get className() { return this.attrs.class || ''; }
  set className(v) { this.attrs.class = String(v); }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(t) { this.childNodes.forEach((c) => { c.parentNode = null; }); this.childNodes = t ? [new LText(this.ownerDocument, String(t))] : []; if (t) this.childNodes[0].parentNode = this; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { return this.insertBefore(c, null); }
  insertBefore(c, ref) {
    if (c.parentNode) c.parentNode.removeChild(c);
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    if (at < 0) this.childNodes.push(c); else this.childNodes.splice(at, 0, c);
    c.parentNode = this;
    return c;
  }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const c of n.childNodes) if (c.nodeType === 1) { if (matches(c, sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  normalize() {
    for (let i = 0; i < this.childNodes.length; i += 1) {
      const c = this.childNodes[i];
      if (c.nodeType === 3) {
        while (this.childNodes[i + 1] && this.childNodes[i + 1].nodeType === 3) { c.data += this.childNodes[i + 1].data; this.removeChild(this.childNodes[i + 1]); }
        if (!c.data) { this.removeChild(c); i -= 1; }
      } else c.normalize();
    }
  }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
  get innerHTML() {
    return this.childNodes.map((c) => (c.nodeType === 3 ? c.data : `<${c.tagName.toLowerCase()}${Object.entries(c.attrs).filter(([k]) => k !== 'class' && k !== 'data-hc-id').map(([k, v]) => ` ${k}="${v}"`).join('')}>${c.innerHTML}</${c.tagName.toLowerCase()}>`)).join('');
  }
}
/* text before a boundary point, counted in document order from the top of its tree */
function topOf(n) { while (n.parentNode) n = n.parentNode; return n; }
function textNodesUnder(n, out) { for (const c of n.childNodes) { if (c.nodeType === 3) out.push(c); else textNodesUnder(c, out); } return out; }
function posOf(node, off) {
  const all = textNodesUnder(topOf(node), []);
  let at = 0;
  if (node.nodeType === 3) { for (const t of all) { if (t === node) return at + off; at += t.length; } return at; }
  const stop = node.childNodes[off] || null;
  for (const t of all) {
    if (stop ? stop === t || stop.contains(t) : !node.contains(t) && posAfter(node, t)) return at;
    at += t.length;
  }
  return at;
}
function posAfter(container, t) {          // is text node t after the whole of container in document order?
  const all = []; const walk = (n) => { all.push(n); n.childNodes.forEach(walk); }; walk(topOf(container));
  return all.indexOf(t) > all.indexOf(container) && !container.contains(t);
}
class LRange {
  constructor() { this.startContainer = null; this.startOffset = 0; this.endContainer = null; this.endOffset = 0; }
  setStart(n, o) { this.startContainer = n; this.startOffset = o; if (!this.endContainer) { this.endContainer = n; this.endOffset = o; } }
  setEnd(n, o) { this.endContainer = n; this.endOffset = o; }
  setStartBefore(n) { this.setStart(n.parentNode, n.parentNode.childNodes.indexOf(n)); }
  collapse(toStart) { if (toStart) { this.endContainer = this.startContainer; this.endOffset = this.startOffset; } else { this.startContainer = this.endContainer; this.startOffset = this.endOffset; } }
  selectNodeContents(n) { this.startContainer = n; this.startOffset = 0; this.endContainer = n; this.endOffset = n.nodeType === 3 ? n.length : n.childNodes.length; }
  get collapsed() { return this.startContainer === this.endContainer && this.startOffset === this.endOffset; }
  toString() {
    const all = textNodesUnder(topOf(this.startContainer), []).map((t) => t.data).join('');
    return all.slice(posOf(this.startContainer, this.startOffset), posOf(this.endContainer, this.endOffset));
  }
}
export function liteDoc() {
  const doc = {};
  let ranges = [];
  doc.createElement = (t) => new LEl(doc, t);
  doc.createTextNode = (s) => new LText(doc, s);
  doc.createRange = () => new LRange();
  doc.body = new LEl(doc, 'body');
  const sel = {
    get rangeCount() { return ranges.length; },
    getRangeAt: (i) => ranges[i],
    addRange: (r) => { ranges = [r]; },
    removeAllRanges: () => { ranges = []; },
    get isCollapsed() { return !ranges.length || ranges[0].collapsed; },
    get focusNode() { return ranges[0] ? ranges[0].endContainer : null; },
    get focusOffset() { return ranges[0] ? ranges[0].endOffset : 0; },
    get anchorNode() { return ranges[0] ? ranges[0].startContainer : null; },
  };
  doc.getSelection = () => sel;
  doc.createTreeWalker = (root) => {
    const list = textNodesUnder(root, []);
    let i = -1;
    return { nextNode: () => { i += 1; return list[i] || null; } };
  };
  return doc;
}
/* a <p> built from parts: a string is text, ['ins'|'del', text] a suggestion mark as the engine draws it */
function para(doc, ...parts) {
  const p = doc.createElement('p');
  for (const x of parts) {
    if (typeof x === 'string') { p.appendChild(doc.createTextNode(x)); continue; }
    const m = doc.createElement(x[0]);
    m.setAttribute('data-hc-sug', x[0]);
    m.setAttribute('data-hc-id', 's900');
    m.className = `hc-sug hc-sug-${x[0]}`;
    m.appendChild(doc.createTextNode(x[1]));
    p.appendChild(m);
  }
  doc.body.appendChild(p);
  return p;
}
function caret(doc, node, off) { const r = doc.createRange(); r.setStart(node, off); r.collapse(true); doc.getSelection().removeAllRanges(); doc.getSelection().addRange(r); }
const caretAbs = (doc, root) => { const r = doc.getSelection().getRangeAt(0); return posOf(r.startContainer, r.startOffset) - posOf(root, 0); };

// ------------------------------------------------------------------------------------ D7: typing --

test('D7 Backspace at the right end of a struck run gives back its last letter, letter by letter (ED19)', () => {
  const doc = liteDoc();
  const p = para(doc, 'ab', ['del', 'cd'], 'ef');
  caret(doc, p.childNodes[2], 0);                         // ab~~cd~~|ef
  T.erase(p, false);
  assert.equal(p.innerHTML, 'ab<del data-hc-sug="del">c</del>def', 'd is no longer struck');
  assert.equal(caretAbs(doc, p), 3, 'the caret sits right after the struck c, before the d it gave back');
  T.erase(p, false);
  assert.equal(p.innerHTML, 'abcdef', 'the whole run given back; the empty mark goes');
  assert.equal(caretAbs(doc, p), 2);
  T.erase(p, false);                                       // nothing struck before the caret now: Backspace strikes again
  assert.equal(p.innerHTML, 'a<del data-hc-sug="del">b</del>cdef');
  assert.equal(caretAbs(doc, p), 1, 'striking leaves the caret before the struck letter');
});

test('D7 Delete at the left end of a struck run gives back its first letter (the mirror of Backspace)', () => {
  const doc = liteDoc();
  const p = para(doc, 'ab', ['del', 'cd'], 'ef');
  caret(doc, p.childNodes[0], 2);                         // ab|~~cd~~ef
  T.erase(p, true);
  assert.equal(p.innerHTML, 'abc<del data-hc-sug="del">d</del>ef');
  assert.equal(caretAbs(doc, p), 3, 'the caret moves past the letter it gave back');
  T.erase(p, true);
  assert.equal(p.innerHTML, 'abcdef');
});

test('D7 your own inserted text still simply disappears; striking original text is unchanged', () => {
  const doc = liteDoc();
  const p = para(doc, 'ab', ['ins', 'xy']);
  caret(doc, p.childNodes[1].firstChild, 2);
  T.erase(p, false);
  assert.equal(p.innerHTML, 'ab<ins data-hc-sug="ins">x</ins>', 'own text removed outright, never struck');
  T.erase(p, false);
  assert.equal(p.innerHTML, 'ab', 'the empty insertion goes');
  T.erase(p, false);
  assert.equal(p.innerHTML, 'a<del data-hc-sug="del">b</del>', 'original text is struck, kept');
  // a struck run right after the caret, with Backspace: the letter BEFORE the caret is struck (no un-strike)
  const q = para(doc, 'xy', ['del', 'z']);
  caret(doc, q.childNodes[0], 2);
  T.erase(q, false);
  assert.equal(q.innerHTML, 'x<del data-hc-sug="del">yz</del>');
});

test('D7 an emoji struck as one character is given back as one character', () => {
  const doc = liteDoc();
  const p = para(doc, 'a', ['del', '🥳'], 'b');
  caret(doc, p.childNodes[2], 0);
  T.erase(p, false);
  assert.equal(p.innerHTML, 'a🥳b', 'both halves given back together');
});

test('D7 css: the hover line never overrides the solid line of the selected or open block (ED14)', () => {
  const css = readRepo('css/editor.css');
  const typing = css.slice(css.indexOf('/* ==== typing (U4) ==== */'), css.indexOf('/* ==== boxes/picker (U4) ==== */'))
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const hover = [...typing.matchAll(/([^{}]*\.hc-block[^{}]*:hover::after[^{}]*)\{([^}]*)\}/g)];
  assert.ok(hover.length >= 1, 'a hover rule exists');
  for (const [, sel, body] of hover) {
    assert.match(body, /--hc-line-faint/, 'the hover rule draws the faint line');
    for (const part of sel.split(/,(?![^(]*\))/)) {        // top-level commas only (not inside :not(...))
      for (const st of ['.hc-selected', '.hc-open', '.hc-hot', ':focus-visible']) {
        assert.ok(part.includes(`:not(`) && part.slice(part.indexOf(':not(')).includes(st), `hover selector "${part.trim()}" leaves out ${st}`);
      }
    }
  }
});

// ------------------------------------------------------------ the serializer's two modes (D6, D8) --

import { ShimDOMParser, ShimElement, ShimText, HTML_NS } from './fixtures/dom_shim.mjs';
globalThis.DOMParser = ShimDOMParser;
const M = require(path.join(ROOT, 'js', 'editor-md.js'));
const sh = (name, attrs, ...kids) => { const e = new ShimElement(name, HTML_NS); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v); for (const k of kids) e.appendChild(typeof k === 'string' ? new ShimText(k) : k); return e; };
const sug = (kind, ...kids) => sh(kind, { 'data-hc-sug': kind, 'data-hc-id': 's1', class: `hc-sug hc-sug-${kind}` }, ...kids);
const fmt = (f, ...kids) => sh(f === 'strong' ? 'b' : 'i', { 'data-hc-sug': 'fmt', 'data-hc-fmt': f, 'data-hc-id': 's2', class: 'hc-sug hc-sug-fmt' }, ...kids);
function shRoot(md, ...parts) {
  const root = M.renderBlock(md);
  const p = root.childNodes.find((c) => c.nodeType === 1);
  p.childNodes = [];
  for (const x of parts) p.appendChild(typeof x === 'string' ? new ShimText(x) : x);
  return { root, p };
}

test('D6 serialize {original: true}: deletions kept, insertions and formats dropped = the block before the marks', () => {
  const md = 'The motor needs to be fixed now.\n\n';
  const { root } = shRoot(md, 'The ', fmt('strong', 'motor'), ' needs ', sug('del', 'to be fixed'), sug('ins', 'a new cable'), ' now.');
  assert.equal(M.serialize(root, md, 'paragraph'), 'The **motor** needs a new cable now.\n\n', 'the normal mode: what the draft holds');
  assert.equal(M.serialize(root, md, 'paragraph', { original: true }), md, 'the original mode: exactly the base text');
  // a struck line break comes back in the original mode
  const md2 = 'One\\\ntwo.\n\n';
  const r2 = shRoot(md2, 'One', sug('del', sh('br')), 'two.');
  assert.equal(M.serialize(r2.root, md2, 'paragraph', { original: true }), md2);
  assert.equal(M.serialize(r2.root, md2, 'paragraph'), 'Onetwo.\n\n');
});

test('D6 serialize {original: true} of a note box writes its first type and title back', () => {
  const md = '<div class="adm adm-note"><p class="adm-title">Note</p>\n\nSwitch it on.\n\n</div>\n\n';
  const root = M.renderBlock(md);
  const box = root.childNodes.find((c) => c.nodeType === 1);
  box.setAttribute('class', 'adm adm-warning');
  box.setAttribute('data-hc-was', 'note');
  box.setAttribute('data-hc-was-title', 'Note');
  box.childNodes.find((c) => c.nodeType === 1 && c.getAttribute('class') === 'adm-title').childNodes = [new ShimText('Warning')];
  assert.match(M.serialize(root, md, 'wrapper'), /^<div class="adm adm-warning"><p class="adm-title">Warning<\/p>/);
  assert.equal(M.serialize(root, md, 'wrapper', { original: true }), md);
});

test('D8 the List mark: a paragraph is written as a bulleted list, one item per line break, then numbered', () => {
  const md = 'Power on\\\nHome the axes\\\nStart the GUI\n\n';
  const root = M.renderBlock(md);
  const p = root.childNodes.find((c) => c.nodeType === 1);
  assert.equal(M.serialize(root, md, 'paragraph'), md, 'unmarked: byte-exact');
  p.setAttribute('data-hc-list', 'ul');
  assert.equal(M.serialize(root, md, 'paragraph'), '- Power on\n- Home the axes\n- Start the GUI\n\n');
  p.setAttribute('data-hc-list', 'ol');
  assert.equal(M.serialize(root, md, 'paragraph'), '1. Power on\n2. Home the axes\n3. Start the GUI\n\n');
  assert.equal(M.serialize(root, md, 'paragraph', { original: true }), md, 'the original mode ignores the list mark');
  // a list turned into the other kind
  const lmd = '- a\n- b\n\n';
  const lr = M.renderBlock(lmd);
  const ul = lr.childNodes.find((c) => c.nodeType === 1);
  ul.setAttribute('data-hc-list', 'ol');
  assert.equal(M.serialize(lr, lmd, 'list'), '1. a\n2. b\n\n');
  ul.setAttribute('data-hc-list', 'ul');
  assert.equal(M.serialize(lr, lmd, 'list'), lmd, 'its own kind again: byte-exact');
});

test('D8 HCEditorType.list cycles a paragraph none -> bulleted -> numbered -> none; a list toggles to the other kind', () => {
  const doc = liteDoc();
  const p = para(doc, 'x');
  assert.equal(T.listState(p), 'none');
  assert.equal(T.list(p), 'ul');
  assert.equal(p.getAttribute('data-hc-list'), 'ul');
  assert.match(p.className, /hc-sug-list/);
  assert.equal(T.list(p), 'ol');
  assert.equal(T.list(p), 'none');
  assert.equal(p.getAttribute('data-hc-list'), null);
  assert.equal(p.getAttribute('class'), null, 'no class left behind');
  const ul = doc.createElement('ul');
  assert.equal(T.listState(ul), 'ul');
  assert.equal(T.list(ul), 'ol');
  assert.equal(T.list(ul), 'ul');
  assert.equal(ul.getAttribute('data-hc-list'), null);
  const h = doc.createElement('h2');
  assert.equal(T.list(h), 'none', 'a heading is never a list');
});

// ----------------------------------------------------------------- the block toolbar (D8, D9) --

const B = require(path.join(ROOT, 'js', 'editor-blocks.js'));
const S = require(path.join(ROOT, 'js', 'sanitize.js'));
const barDoc = () => {
  const doc = liteDoc();
  doc.getSelection = () => ({ rangeCount: 0, isCollapsed: true });
  return doc;
};
const rowOf = (bar) => bar.el.childNodes.find((c) => c.getAttribute('class') === 'hc-fb-row' || c.className === 'hc-fb-row');
const labels = (bar) => rowOf(bar).childNodes.map((b) => b.getAttribute('aria-label') || b.textContent);
const fire = (n, type, extra) => { for (const fn of n.listeners[type] || []) fn(Object.assign({ type, target: n, preventDefault() {}, stopPropagation() {} }, extra)); };

test('D8 the open block toolbar: B, I, Link, Code, List, Comment in that order (Link before Code), role toolbar', () => {
  const bar = B.blockBar(barDoc(), { kind: 'visual', onFormat() {}, onList() {}, listState: () => 'none', onComment() {} });
  assert.equal(bar.el.getAttribute('role'), 'toolbar');
  assert.equal(bar.el.getAttribute('contenteditable'), 'false', 'never part of the typed text');
  assert.deepEqual(labels(bar).map((l) => l.split(':')[0]), ['Bold', 'Italic', 'Link', 'Code', 'List', 'Comment']);
  assert.equal(B.formatBar, undefined, 'the pop-up over a selection is gone');
  assert.equal(B.boxBar, undefined, 'the note box bar with its × is gone');
});

test('D8 roving tabindex: one Tab stop; ArrowRight / ArrowLeft wrap, Home / End go to the ends', () => {
  const bar = B.blockBar(barDoc(), { kind: 'visual', onFormat() {}, onList() {}, listState: () => 'none', onComment() {} });
  const row = rowOf(bar);
  const items = row.childNodes;
  const stops = () => items.filter((b) => b.getAttribute('tabindex') === '0').length;
  assert.equal(stops(), 1);
  assert.equal(items[0].getAttribute('tabindex'), '0');
  fire(row, 'keydown', { key: 'ArrowLeft' });
  assert.equal(items.at(-1).getAttribute('tabindex'), '0', 'wraps to the last');
  fire(row, 'keydown', { key: 'Home' });
  assert.equal(items[0].getAttribute('tabindex'), '0');
  fire(row, 'keydown', { key: 'ArrowRight' });
  assert.equal(items[1].getAttribute('tabindex'), '0');
  fire(row, 'keydown', { key: 'End' });
  assert.equal(items.at(-1).getAttribute('tabindex'), '0');
  assert.equal(stops(), 1);
});

test('D8 B with nothing selected says so in words; Comment and List call back; List shows its state', () => {
  const calls = [];
  let st = 'none';
  const bar = B.blockBar(barDoc(), { kind: 'visual', onFormat: (w) => calls.push(w), onList: () => { st = st === 'none' ? 'ul' : 'ol'; calls.push('list'); },
    listState: () => st, onComment: () => calls.push('comment') });
  const [bold, , , , list, comment] = rowOf(bar).childNodes;
  fire(bold, 'mousedown');
  assert.deepEqual(calls, [], 'no selection: nothing formatted');
  const hint = bar.el.childNodes.find((c) => (c.getAttribute('class') || c.className) === 'hc-fb-hint');
  assert.equal(hint.textContent, 'Select some words first.');
  fire(list, 'mousedown');
  assert.equal(list.getAttribute('aria-pressed'), 'true');
  assert.match(list.getAttribute('aria-label'), /bulleted/);
  fire(list, 'mousedown');
  assert.match(list.getAttribute('aria-label'), /numbered/);
  fire(comment, 'mousedown');
  assert.deepEqual(calls, ['list', 'list', 'comment']);
});

test('D9 a note box: Type ▾ first; its menu lists the five kinds and Remove last; no × anywhere', () => {
  const picked = [];
  let removed = 0;
  const bar = B.blockBar(barDoc(), { kind: 'box', box: { current: () => 'note', onType: (k) => picked.push(k) }, onRemove: () => { removed += 1; },
    onFormat() {}, onList() {}, listState: () => 'none', onComment() {} });
  const items = rowOf(bar).childNodes;
  assert.equal(items[0].getAttribute('aria-label'), 'Box type: Note');
  assert.equal(items.length, 7, 'Type ▾, B, I, Link, Code, List, Comment');
  assert.ok(items.every((b) => b.textContent !== '✕' && b.textContent !== '×'));
  fire(items[0], 'click');
  const menu = bar.el.childNodes.find((c) => (c.getAttribute('class') || c.className) === 'hc-boxmenu');
  assert.ok(menu, 'the menu opens on a click');
  const entries = menu.childNodes.filter((c) => c.tagName === 'BUTTON');
  assert.deepEqual(entries.map((e) => e.textContent), ['Note', 'Tip', 'Important', 'Warning', 'Danger', 'Remove this box']);
  fire(entries[3], 'click');
  assert.deepEqual(picked, ['warning']);
  fire(items[0], 'click');
  const again = bar.el.childNodes.find((c) => (c.getAttribute('class') || c.className) === 'hc-boxmenu').childNodes.filter((c) => c.tagName === 'BUTTON');
  fire(again.at(-1), 'click');
  assert.equal(removed, 1, 'Remove is the last item');
});

test('D9 (ED32) Remove: the "Removed · Undo" pill, Undo asks the parent to undo, the 8 s timer clears it', () => {
  const timers = [];
  let undone = 0;
  const host = liteDoc().createElement('div');
  const pill = B.removedPill(barDoc(), { onUndo: () => { undone += 1; }, setTimeout: (fn, ms) => timers.push({ fn, ms }) });
  host.appendChild(pill);
  assert.equal(pill.getAttribute('class') || pill.className, 'hc-removed-pill');
  assert.equal(pill.getAttribute('role'), 'status', 'a screen reader hears it');
  assert.equal(pill.getAttribute('contenteditable'), 'false');
  const [what, undo] = pill.childNodes.filter((c) => c.nodeType === 1);
  // fix pass A5: the words come on the next tick (a 0-ms timer), so the status region is heard
  assert.equal(what.textContent, '', 'inserted empty');
  timers.find((t) => t.ms === 0).fn();
  assert.equal(what.textContent, 'Removed');
  assert.equal(undo.tagName, 'BUTTON');
  assert.equal(undo.textContent, 'Undo');
  assert.equal(undo.getAttribute('aria-label'), 'Undo the removal');
  assert.deepEqual(timers.map((t) => t.ms).sort((a, b) => a - b), [0, 8000], 'one 8-second timer (and the words\' tick)');
  fire(undo, 'click');
  assert.equal(undone, 1, 'Undo asks for the undo');
  assert.equal(pill.parentNode, null, 'and the pill goes');
  timers.find((t) => t.ms === 8000).fn();                  // the timer after an Undo: nothing to clear, no error
  // a second removal nobody undoes: the timer clears its pill
  timers.length = 0;
  const pill2 = B.removedPill(barDoc(), { onUndo() {}, setTimeout: (fn, ms) => timers.push({ fn, ms }) });
  host.appendChild(pill2);
  timers.find((t) => t.ms === 8000).fn();
  assert.equal(pill2.parentNode, null, 'gone after 8 s');
  assert.equal(undone, 1);
});

test('D9 the frame\'s Remove posts the removal, then shows the pill whose Undo posts hc-key undo', () => {
  const src = readRepo('js/editor-frame.js');
  const body = src.slice(src.indexOf('function removeBlock(now)'), src.indexOf('function formatIn('));
  assert.ok(body.indexOf("HC.post('hc-block-md', { index: now.index, md: '' })") >= 0, 'the removal is an md \'\' edit');
  assert.match(body, /removedPill\(doc, \{[^}]*onUndo: \(\) => HC\.post\('hc-key', \{ op: 'undo' \}\)/, 'Undo = the parent\'s undo');
  assert.ok(body.indexOf('now.w.appendChild(pill)') >= 0, 'beside the removed block');
});

test('D8 (m2) the Type ▾ menu keys: ArrowDown / ArrowUp wrap, Home / End, Escape closes it back to its button', () => {
  const bar = B.blockBar(barDoc(), { kind: 'box', box: { current: () => 'note', onType() {} }, onRemove() {},
    onFormat() {}, onList() {}, listState: () => 'none', onComment() {} });
  const typeBtn = rowOf(bar).childNodes[0];
  fire(typeBtn, 'click');
  const menuOf = () => bar.el.childNodes.find((c) => (c.getAttribute('class') || c.className) === 'hc-boxmenu');
  const menu = menuOf();
  const entries = menu.childNodes.filter((c) => c.tagName === 'BUTTON');
  const current = () => entries.findIndex((b) => b.getAttribute('tabindex') === '0');
  assert.equal(current(), 0, 'the first item is the one in focus');
  assert.equal(entries.filter((b) => b.getAttribute('tabindex') === '0').length, 1);
  fire(menu, 'keydown', { key: 'ArrowDown' });
  assert.equal(current(), 1);
  fire(menu, 'keydown', { key: 'End' });
  assert.equal(current(), entries.length - 1, 'End: Remove, the last');
  fire(menu, 'keydown', { key: 'ArrowDown' });
  assert.equal(current(), 0, 'wraps to the first');
  fire(menu, 'keydown', { key: 'ArrowUp' });
  assert.equal(current(), entries.length - 1, 'wraps to the last');
  fire(menu, 'keydown', { key: 'Home' });
  assert.equal(current(), 0);
  let stopped = false;
  fire(menu, 'keydown', { key: 'Escape', stopPropagation() { stopped = true; } });
  assert.equal(menuOf(), undefined, 'Escape closes the menu');
  assert.equal(typeBtn.getAttribute('aria-expanded'), 'false');
  assert.equal(stopped, true, 'and goes no further (the block stays open)');
});

test('D8 (ED33) a code block: Language ▾ in plain words, then Comment; Remove last', () => {
  const langs = [];
  const bar = B.blockBar(barDoc(), { kind: 'code', code: { current: 'console', onChange: (l) => langs.push(l) }, onRemove() {}, onComment() {} });
  const items = rowOf(bar).childNodes;
  assert.equal(items.length, 2, 'Language ▾ and Comment: code is plain text');
  assert.equal(items[0].getAttribute('aria-label'), 'Code language: Terminal');
  fire(items[0], 'click');
  const entries = bar.el.childNodes.find((c) => (c.getAttribute('class') || c.className) === 'hc-boxmenu').childNodes.filter((c) => c.tagName === 'BUTTON');
  const words = entries.map((e) => e.textContent);
  for (const w of ['Shell', 'Python', 'C++', 'YAML', 'JSON', 'Plain text']) assert.ok(words.indexOf(w) >= 0 || !B.LANGUAGES.length, `${w} offered`);
  assert.equal(words.at(-1), 'Remove this code');
  assert.ok(words.every((w) => !/^(bash|cpp|yaml|console)$/.test(w)), 'no file-extension names');
});

// ------------------------------------------------------- marks restored after a reload (D6) --

const shDoc = { createElement: (t) => new ShimElement(t, HTML_NS), createTextNode: (t) => new ShimText(t) };

test('D6 restoreBlock: the kept marks come back when both checks hold', () => {
  const orig = 'The motor needs to be fixed now.\n\n';
  const { root } = shRoot(orig, 'The motor needs ', sug('del', 'to be fixed'), sug('ins', 'a new cable'), ' now.');
  const md = M.serialize(root, orig, 'paragraph');
  const html = S.clean(root.innerHTML, { marks: true });
  const out = M.restoreBlock({ html, md, orig, kind: 'paragraph' }, { doc: shDoc });
  assert.equal(out.how, 'marks');
  assert.match(out.root.innerHTML, /data-hc-sug="del"[^>]*>to be fixed</);
  assert.match(out.root.innerHTML, /data-hc-sug="ins"[^>]*>a new cable</);
});

test('D6 restoreBlock: the base text changed on main -> the marks are refused, a word diff is painted instead', () => {
  const orig = 'The motor needs to be fixed now.\n\n';
  const { root } = shRoot(orig, 'The motor needs ', sug('del', 'to be fixed'), sug('ins', 'a new cable'), ' now.');
  const md = M.serialize(root, orig, 'paragraph');
  const html = S.clean(root.innerHTML, { marks: true });
  const moved = 'The pump needs to be fixed now.\n\n';                   // main changed the block since
  const out = M.restoreBlock({ html, md, orig: moved, kind: 'paragraph' }, { doc: shDoc });
  assert.equal(out.how, 'diff');
  const h = out.root.innerHTML;
  assert.match(h, /<del[^>]*data-hc-sug="del"[^>]*>pump</, 'the old word struck');
  assert.match(h, /<ins[^>]*data-hc-sug="ins"[^>]*>motor</, 'the new word marked');
  assert.equal(M.serialize(out.root, md, 'paragraph'), md, 'it still writes the draft\'s text');
  // and the draft text no longer matching the marks: refused too
  const out2 = M.restoreBlock({ html, md: 'Something else.\n\n', orig, kind: 'paragraph' }, { doc: shDoc });
  assert.equal(out2.how, 'diff');
});

test('D6 restoreBlock: no kept marks -> the diff; an added block is all new', () => {
  const out = M.restoreBlock({ html: '', md: 'A new line.\n\n', orig: '', kind: 'paragraph' }, { doc: shDoc });
  assert.equal(out.how, 'diff');
  assert.equal((out.root.innerHTML.match(/data-hc-sug="ins"/g) || []).length, 3, 'each new word marked');
  assert.equal(M.serialize(out.root, 'A new line.\n\n', 'paragraph'), 'A new line.\n\n');
});

test('D6 sanitize marks mode keeps the typing marks; the default policy still drops them', () => {
  const raw = '<p>a <ins data-hc-sug="ins" data-hc-id="s1" class="hc-sug hc-sug-ins" onclick="x()">b</ins>'
    + '<del data-hc-sug="del" data-hc-id="s2" class="hc-sug hc-sug-del evil">c</del><b data-hc-sug="fmt" data-hc-fmt="link" data-hc-href="https://x.org">d</b></p>'
    + '<p data-hc-list="ul" data-hc-sug="nope" data-hc-id="bad id!">e</p><script>alert(1)</script>';
  const kept = S.clean(raw, { marks: true });
  assert.match(kept, /<ins data-hc-sug="ins" data-hc-id="s1" class="hc-sug hc-sug-ins">b<\/ins>/);
  assert.match(kept, /<del data-hc-sug="del" data-hc-id="s2" class="hc-sug hc-sug-del">c<\/del>/);
  assert.match(kept, /data-hc-fmt="link" data-hc-href="https:\/\/x.org"/);
  assert.match(kept, /<p data-hc-list="ul">e<\/p>/, 'a bad value is dropped by shape');
  assert.doesNotMatch(kept, /onclick|script|evil/);
  const site = S.clean(raw);
  assert.doesNotMatch(site, /data-hc|hc-sug|<ins/, 'the live site never keeps them');
});

// ------------------------------------------- the "+" picker, the Image tile and note cards in the frame --

import { setupPage, fakeHC, fakeWin, kids, blocksOf } from './frame_harness.mjs';
const EF = require(path.join(ROOT, 'js', 'editor-frame.js'));
const hasCls = (n, c) => n.nodeType === 1 && n.classList.contains(c);
const IMG = 'https://res.cloudinary.com/demo/image/upload/v1/hippocampus-docs/a.png';

test('D10 (ED27, ED28) the "+": five tiles, an icon-free fallback word each, the room opens on the click only', () => {
  const { doc, body } = setupPage();
  const HC = fakeHC();
  EF.create(fakeWin(), doc, HC);
  HC.send({ on: true });
  const rail = kids(body).filter((c) => hasCls(c, 'hc-plus'))[1];
  assert.equal(rail.classList.contains('is-open'), false, 'hovering opens nothing (no hover handler moves the page)');
  assert.equal(Object.keys(rail.listeners).filter((t) => /mouse|pointer/.test(t)).length, 0);
  kids(rail)[0].click();
  assert.equal(rail.classList.contains('is-open'), true);
  const picker = kids(rail).find((c) => hasCls(c, 'hc-picker'));
  const tiles = kids(kids(picker).find((c) => hasCls(c, 'hc-pick-row')));
  assert.deepEqual(tiles.map((t) => t.textContent), ['Image', 'Note', 'Tabs', 'Video', 'Repo'], 'one word each, no sub-words');
});

test('D11 the Image tile: Upload asks the parent as before; "Pick one the site has" asks for the list, draws it, uses one', () => {
  const { doc, body } = setupPage();
  const HC = fakeHC();
  EF.create(fakeWin(), doc, HC);
  HC.send({ on: true });
  const rail = kids(body).filter((c) => hasCls(c, 'hc-plus'))[2];
  const at = Number(rail.getAttribute('data-insert'));
  kids(rail)[0].click();
  const picker = kids(rail).find((c) => hasCls(c, 'hc-picker'));
  const image = kids(kids(picker).find((c) => hasCls(c, 'hc-pick-row')))[0];
  image.click();
  const ways = kids(picker).find((c) => hasCls(c, 'hc-pick-image'));
  assert.ok(ways, 'the two ways open under the tiles');
  const [upload, pick, grid] = kids(ways);
  assert.deepEqual([upload.textContent, pick.textContent], ['Upload', 'Pick one the site has']);
  pick.click();
  assert.deepEqual(HC.posts.at(-1), { type: 'hc-media-list' });
  HC.send({ on: true, media: [{ url: IMG, label: 'hippocampus-docs/a' }] });
  const cells = kids(grid);
  assert.equal(cells.length, 1);
  // fix pass A4 (WCAG 4.1.2): the list item wraps the button (it used to BE the button, role=listitem)
  assert.equal(cells[0].getAttribute('role'), 'listitem');
  const cellBtn = kids(cells[0])[0];
  assert.equal(cellBtn.tagName, 'BUTTON');
  assert.equal(cellBtn.getAttribute('role'), null, 'the button keeps the button role');
  assert.equal(cellBtn.getAttribute('aria-label'), 'Use hippocampus-docs/a');
  assert.equal(kids(cellBtn)[0].getAttribute('src'), IMG);
  cellBtn.click();
  assert.deepEqual(HC.posts.at(-1), { type: 'hc-image-use', index: at, url: IMG });
  // Upload: the parent's file chooser, as the old Image tile did
  kids(rail)[0].click();
  const picker2 = kids(rail).find((c) => hasCls(c, 'hc-picker'));
  kids(kids(picker2).find((c) => hasCls(c, 'hc-pick-row')))[0].click();
  kids(kids(picker2).find((c) => hasCls(c, 'hc-pick-image')))[0].click();
  assert.deepEqual(HC.posts.at(-1), { type: 'hc-block-insert', index: at, kind: 'image' });
});

test('D8 (ED18) note cards: "Your note" beside its block from hc-editor.notes; typing and Remove tell the parent', () => {
  const { doc, body } = setupPage();
  const HC = fakeHC();
  EF.create(fakeWin(), doc, HC);
  HC.send({ on: true, notes: [{ index: 3, text: 'Check the pins.' }] });
  const w3 = blocksOf(body).find((w) => kids(w).some((c) => hasCls(c, 'hc-note-card')));
  assert.ok(w3, 'a card beside the block');
  const card = kids(w3).find((c) => hasCls(c, 'hc-note-card'));
  const [head, area, remove] = kids(card);
  assert.equal(head.textContent, 'Your note');
  assert.equal(area.value, 'Check the pins.');
  area.value = 'Check the pins and the cable.';
  for (const fn of area.listeners.input || []) fn({ type: 'input' });
  assert.deepEqual(HC.posts.at(-1), { type: 'hc-note', index: 3, text: 'Check the pins and the cable.' });
  remove.click();
  assert.deepEqual(HC.posts.at(-1), { type: 'hc-note', index: 3, text: '' });
  assert.equal(kids(w3).some((c) => hasCls(c, 'hc-note-card')), false, 'gone');
  HC.send({ on: true, notes: [] });
  assert.equal(blocksOf(body).some((w) => kids(w).some((c) => hasCls(c, 'hc-note-card'))), false);
});

/* ---- fix pass ---- */
test('fix A5 (WCAG 2.4.3): a pick in the Type ▾ / Language ▾ menu gives the focus back to its button', () => {
  const focused = [];
  const had = Object.getOwnPropertyDescriptor(LEl.prototype, 'focus');
  LEl.prototype.focus = function focus() { focused.push(this); };
  try {
    const picked = [];
    const bar = B.blockBar(barDoc(), { kind: 'box', box: { current: () => 'note', onType: (k) => picked.push(k) }, onRemove() {},
      onFormat() {}, onList() {}, listState: () => 'none', onComment() {} });
    const typeBtn = rowOf(bar).childNodes[0];
    fire(typeBtn, 'click');
    const menu = bar.el.childNodes.find((c) => (c.getAttribute('class') || c.className) === 'hc-boxmenu');
    fire(menu.childNodes.filter((c) => c.tagName === 'BUTTON')[1], 'click');
    assert.deepEqual(picked, ['tip']);
    assert.equal(focused.at(-1), typeBtn, 'focus is back on Type ▾');
    const langs = [];
    const code = B.blockBar(barDoc(), { kind: 'code', code: { current: 'console', onChange: (l) => langs.push(l) }, onRemove() {}, onComment() {} });
    const langBtn = rowOf(code).childNodes[0];
    fire(langBtn, 'click');
    const m2 = code.el.childNodes.find((c) => (c.getAttribute('class') || c.className) === 'hc-boxmenu');
    fire(m2.childNodes.filter((c) => c.tagName === 'BUTTON')[0], 'click');
    assert.equal(langs.length, 1);
    assert.equal(focused.at(-1), langBtn, 'focus is back on Language ▾');
  } finally {
    if (had) Object.defineProperty(LEl.prototype, 'focus', had); else delete LEl.prototype.focus;
  }
});

test('fix A5 (WCAG 2.2.1): the Removed pill\'s clock stops while the focus or the pointer is in it; the frame focuses Undo', () => {
  const timers = new Map();
  let n = 0;
  const o = { onUndo() {}, setTimeout: (fn, ms) => { n += 1; timers.set(n, { fn, ms }); return n; }, clearTimeout: (id) => timers.delete(id) };
  const host = liteDoc().createElement('div');
  const pill = B.removedPill(barDoc(), o);
  host.appendChild(pill);
  const clocks = () => [...timers.values()].filter((t) => t.ms === 8000);
  assert.equal(clocks().length, 1);
  fire(pill, 'focusin');
  assert.equal(clocks().length, 0, 'focus inside: the clock stops');
  fire(pill, 'pointerenter');
  fire(pill, 'focusout');
  assert.equal(clocks().length, 0, 'the pointer is still inside');
  fire(pill, 'pointerleave');
  assert.equal(clocks().length, 1, 'both gone: a full 8 s again');
  clocks()[0].fn();
  assert.equal(pill.parentNode, null, 'then it goes');
  const src = readRepo('js/editor-frame.js');
  const body = src.slice(src.indexOf('function removeBlock(now)'), src.indexOf('function formatAt('));
  assert.match(body, /now\.w\.appendChild\(pill\);[\s\S]*hc-removed-undo[\s\S]*undo\.focus\(/, 'after Remove the focus goes to Undo');
  assert.match(body, /clearTimeout: \(t\) => win\.clearTimeout/, 'the frame hands the pill its clearTimeout');
});

test('fix A7 (WCAG 4.1.2): B and I carry aria-pressed from the selection; List keeps its own', () => {
  let bold = false;
  const bar = B.blockBar(barDoc(), { kind: 'visual', onFormat() {}, onList() {}, listState: () => 'none', onComment() {},
    formatState: (w) => (w === 'strong' ? bold : false) });
  const [b, i] = rowOf(bar).childNodes;
  assert.equal(b.getAttribute('aria-pressed'), 'false');
  assert.equal(i.getAttribute('aria-pressed'), 'false');
  bold = true;
  bar.refresh();
  assert.equal(b.getAttribute('aria-pressed'), 'true', 'inside bold text: B is pressed');
  assert.equal(i.getAttribute('aria-pressed'), 'false');
  const src = readRepo('js/editor-frame.js');
  assert.match(src, /formatState: \(what\) => formatAt\(now, what\)/, 'the frame says what the selection is in');
  assert.match(src, /selectionchange', \(\) => \{ if \(openNow && openNow\.bar\) openNow\.bar\.refresh\(\)/, 'and refreshes on every selection change');
});
