// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 14 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Make typing in an open block a Google Docs-style suggestion: inserted text marked, deleted text struck, kept.
/* HCEditorType: the Editor mode's typing engine (editor redesign U2, Kyle's D1 change 5).

   Runs inside the sandboxed page frame only (js/editor-frame.js loads it with js/editor-md.js when
   Editor mode is on). attach(root, {onChange}) turns every edit inside `root` (a contenteditable
   element) into a suggestion, as Google Docs' Suggesting mode does (suggesting-mode-notes.md):

     typing          -> <ins data-hc-sug="ins">: shown in the accent colour, underlined. Typing inside
                        or right after your own inserted text extends it (one suggestion).
     Backspace/Del   -> original text is NOT removed: it is wrapped in <del data-hc-sug="del">, struck
                        through; the caret skips over text that is already struck. Deleting your own
                        inserted text removes it outright.
     select + type   -> the selection is struck and the new text follows it: ONE suggestion (Replace).
     Bold / Italic / inline code / Link
                     -> <b|i|code|a data-hc-sug="fmt" data-hc-fmt="strong|em|code|link"> (a link also
                        data-hc-href): a format suggestion.
     Shift+Enter     -> a line break, inserted as a suggestion.
   Every mark carries data-hc-id (s1, s2, ...): the pieces of one suggestion share it.
   js/editor-md.js serialize() writes the result as Markdown: inserted kept, deleted dropped, format
   applied. js/sanitize.js drops data-hc-* from content, so a page can never carry a mark.

   A composition (dead keys, IMEs) is left to the browser while it runs, then turned into the same
   kind of suggestion. Not handled here (the browser's default is refused, so the DOM never leaves
   the model): Enter (a new block is the "+" line, U3), undo/redo, drag and drop. Paste is inserted as
   plain text. */
(function () {
  'use strict';

  const SUG = 'data-hc-sug';
  const ID = 'data-hc-id';
  let seq = 0;
  const newId = () => `s${++seq}`;

  const isEl = (n) => Boolean(n) && n.nodeType === 1;
  const sugOf = (n) => (isEl(n) ? n.getAttribute(SUG) : null);
  const isIns = (n) => sugOf(n) === 'ins';
  const isDel = (n) => sugOf(n) === 'del';
  const idOf = (n) => (isEl(n) ? n.getAttribute(ID) : null);
  const up = (node, test, root) => { for (let n = node && node.nodeType === 1 ? node : node && node.parentNode; n && n !== root; n = n.parentNode) if (test(n)) return n; return null; };

  function mark(doc, kind, id) {
    const el = doc.createElement(kind === 'ins' ? 'ins' : 'del');
    el.setAttribute(SUG, kind);
    el.setAttribute(ID, id);
    el.className = `hc-sug hc-sug-${kind}`;
    return el;
  }

  function textNodes(root) {
    const out = [];
    const w = root.ownerDocument.createTreeWalker(root, 4 /* SHOW_TEXT */);
    let at = 0;
    for (let t = w.nextNode(); t; t = w.nextNode()) { out.push({ t, at }); at += t.length; }
    return out;
  }
  function absOf(root, node, off) { const r = root.ownerDocument.createRange(); r.setStart(root, 0); r.setEnd(node, off); return r.toString().length; }
  function charAt(root, k) { for (const { t, at } of textNodes(root)) if (k >= at && k < at + t.length) return { node: t, i: k - at }; return null; }

  /* the caret at absolute offset k, never inside struck text */
  function caretAt(root, k) {
    const doc = root.ownerDocument;
    let best = null;
    for (const { t, at } of textNodes(root).filter(({ t }) => !up(t, isDel, root))) {
      if (k >= at && k <= at + t.length) { best = { t, i: k - at }; if (k < at + t.length) break; }
    }
    const r = doc.createRange();
    if (best) r.setStart(best.t, best.i);
    else {
      // only struck text at k (the start of a line struck from its first letter): the caret goes right before it
      const c = charAt(root, k);
      const del = c ? up(c.node, isDel, root) : null;
      if (del) r.setStartBefore(del); else { r.selectNodeContents(root); r.collapse(false); }
    }
    r.collapse(true);
    const s = doc.getSelection(); s.removeAllRanges(); s.addRange(r);
  }
  function caret(root) {
    const s = root.ownerDocument.getSelection();
    if (!s.rangeCount) return null;
    let node = s.focusNode, off = s.focusOffset;
    if (isEl(node) && node.childNodes[off] && node.childNodes[off].nodeType === 3) { node = node.childNodes[off]; off = 0; }
    return { node, off };
  }
  function sibs(node, off) {
    if (node.nodeType === 3) return { prev: off === 0 ? node.previousSibling : null, next: off === node.length ? node.nextSibling : null };
    return { prev: node.childNodes[off - 1] || null, next: node.childNodes[off] || null };
  }

  /* neighbouring marks of the same kind become one; empty marks go */
  function tidy(root) {
    root.normalize();
    for (const el of Array.from(root.querySelectorAll(`[${SUG}="ins"], [${SUG}="del"]`))) {
      if (!el.isConnected) continue;
      if (!el.textContent && !el.querySelector('br')) { el.remove(); continue; }
      let n = el.nextSibling;
      while (n && isEl(n) && n.tagName === el.tagName && sugOf(n) === sugOf(el)) {
        while (n.firstChild) el.appendChild(n.firstChild);
        const gone = n; n = n.nextSibling; gone.remove();
      }
    }
    root.normalize();
  }

  function deleteCharAt(root, k) {
    const c = charAt(root, k);
    if (!c) return null;
    const ins = up(c.node, isIns, root);
    if (ins) { c.node.deleteData(c.i, 1); if (!ins.textContent && !ins.querySelector('br')) ins.remove(); return 'removed'; }
    let ch = c.node;
    if (c.i > 0) ch = ch.splitText(c.i);
    if (ch.length > 1) ch.splitText(1);
    const prev = ch.previousSibling, next = ch.nextSibling;
    if (isDel(next)) next.insertBefore(ch, next.firstChild);
    else if (isDel(prev)) prev.appendChild(ch);
    else {
      const id = (isIns(next) && idOf(next)) || (isIns(prev) && idOf(prev)) || newId();
      const d = mark(root.ownerDocument, 'del', id);
      ch.parentNode.insertBefore(d, ch);
      d.appendChild(ch);
    }
    return 'struck';
  }
  /* the line breaks inside the selection: an inserted one goes, an original one is struck */
  function breaksInSelection(root) {
    const s = root.ownerDocument.getSelection();
    if (!s.rangeCount || s.isCollapsed) return;
    const r = s.getRangeAt(0);
    for (const br of Array.from(root.querySelectorAll('br'))) {
      if (!r.intersectsNode(br) || up(br, isDel, root)) continue;
      const ins = up(br, isIns, root);
      if (ins) { br.remove(); continue; }
      const d = mark(root.ownerDocument, 'del', newId()); br.parentNode.insertBefore(d, br); d.appendChild(br);
    }
  }
  function selAbs(root) {
    const r = root.ownerDocument.getSelection().getRangeAt(0);
    return [absOf(root, r.startContainer, r.startOffset), absOf(root, r.endContainer, r.endOffset)];
  }
  function deleteRange(root, a, b) {
    for (let j = b - 1; j >= a; j--) { const c = charAt(root, j); if (c && !up(c.node, isDel, root)) deleteCharAt(root, j); }
    tidy(root);
  }
  function erase(root, forward) {
    const s = root.ownerDocument.getSelection();
    if (!s.rangeCount) return;
    if (!s.isCollapsed) { const [a, b] = selAbs(root); breaksInSelection(root); deleteRange(root, a, b); caretAt(root, a); return; }
    const c0 = caret(root);
    // a line break right before (or after) the caret: an inserted one goes outright, an original one is struck
    const near = sibs(c0.node, c0.off);
    let br = forward ? near.next : near.prev;
    if (isIns(br) && (forward ? br.firstChild : br.lastChild) && String((forward ? br.firstChild : br.lastChild).nodeName).toUpperCase() === 'BR') br = forward ? br.firstChild : br.lastChild;
    if (br && br.nodeType === 1 && String(br.nodeName).toUpperCase() === 'BR') {
      const parent = br.parentNode;
      const here = root.ownerDocument.createRange();       // a live range: it stays where the break was
      here.setStartBefore(br);
      here.collapse(true);
      if (isIns(parent) || up(br, isIns, root)) { br.remove(); if (isIns(parent) && !parent.textContent && !parent.querySelector('br')) parent.remove(); }
      else if (!up(br, isDel, root)) { const d = mark(root.ownerDocument, 'del', newId()); parent.insertBefore(d, br); d.appendChild(br); }
      tidy(root);
      const sel = root.ownerDocument.getSelection(); sel.removeAllRanges(); sel.addRange(here);
      return;
    }
    const k = absOf(root, c0.node, c0.off);
    const total = root.textContent.length;
    let j = forward ? k : k - 1;
    while (j >= 0 && j < total) { const c = charAt(root, j); if (c && up(c.node, isDel, root)) j += forward ? 1 : -1; else break; }
    if (j < 0 || j >= total) return;
    // a character outside the BMP (an emoji) is two UTF-16 units: both go, never half of one
    const unit = (x) => { const c = charAt(root, x); return c ? c.node.data.charCodeAt(c.i) : 0; };
    const high = (u) => u >= 0xd800 && u <= 0xdbff, low = (u) => u >= 0xdc00 && u <= 0xdfff;
    let from = j, to = j;
    if (!forward && low(unit(j)) && j > 0 && high(unit(j - 1))) from = j - 1;
    if (forward && high(unit(j)) && j + 1 < total && low(unit(j + 1))) to = j + 1;
    let res = null;
    for (let x = to; x >= from; x--) res = deleteCharAt(root, x) || res;
    tidy(root);
    caretAt(root, res === 'struck' && forward ? to + 1 : from);
  }

  /* `what` (a string, or a node such as <br>) at the caret, as a suggestion */
  function insert(root, what) {
    const doc = root.ownerDocument;
    const s = doc.getSelection();
    if (!s.rangeCount) return;
    if (!s.isCollapsed) { const [a, b] = selAbs(root); breaksInSelection(root); deleteRange(root, a, b); caretAt(root, a); }
    let { node, off } = caret(root);
    const inDel = up(node, isDel, root);
    if (inDel) { node = inDel.parentNode; off = Array.prototype.indexOf.call(node.childNodes, inDel) + 1; }
    const own = up(node, isIns, root);
    const isText = typeof what === 'string';
    if (isText && !what) return;
    let placed = null;   // [node, offset] to put the caret at
    const putInto = (ins, atStart) => {
      if (isText) {
        let t = atStart ? ins.firstChild : ins.lastChild;
        if (!t || t.nodeType !== 3) { t = doc.createTextNode(''); if (atStart) ins.insertBefore(t, ins.firstChild); else ins.appendChild(t); }
        const at = atStart ? 0 : t.length;
        t.insertData(at, what);
        placed = [t, at + what.length];
      } else {
        if (atStart) ins.insertBefore(what, ins.firstChild); else ins.appendChild(what);
        placed = [ins, Array.prototype.indexOf.call(ins.childNodes, what) + 1];
      }
    };
    const makeIns = (id, place) => { const ins = mark(doc, 'ins', id); place(ins); putInto(ins, false); };
    if (own && node.nodeType === 3 && isText) { node.insertData(off, what); placed = [node, off + what.length]; }
    else if (own && isText && node.nodeType === 1) {
      // the caret sits on an element inside my own insertion (after a removed line break): type into its text, never a nested mark
      const before = node.childNodes[off - 1];
      if (before && before.nodeType === 3) { const at = before.length; before.appendData(what); placed = [before, at + what.length]; }
      else { const t = doc.createTextNode(what); node.insertBefore(t, node.childNodes[off] || null); placed = [t, what.length]; }
    }
    else if (own && !isText) { const r = doc.createRange(); r.setStart(node, off); r.insertNode(what); placed = [what.parentNode, Array.prototype.indexOf.call(what.parentNode.childNodes, what) + 1]; }
    else {
      const { prev, next } = sibs(node, off);
      if (isDel(next)) {
        let x = next;
        while (x.nextSibling && isEl(x.nextSibling) && idOf(x.nextSibling) === idOf(next)) x = x.nextSibling;
        if (isIns(x)) putInto(x, false); else makeIns(idOf(next), (ins) => x.parentNode.insertBefore(ins, x.nextSibling));
      } else if (isIns(prev)) putInto(prev, false);
      else if (isDel(prev)) {
        const after = prev.nextSibling;
        if (isIns(after) && idOf(after) === idOf(prev)) putInto(after, true);
        else makeIns(idOf(prev), (ins) => prev.parentNode.insertBefore(ins, prev.nextSibling));
      } else {
        makeIns(newId(), (ins) => {
          if (node.nodeType === 3) { const rest = node.splitText(off); rest.parentNode.insertBefore(ins, rest); }
          else node.insertBefore(ins, node.childNodes[off] || null);
        });
      }
    }
    const r = doc.createRange(); r.setStart(placed[0], placed[1]); r.collapse(true); s.removeAllRanges(); s.addRange(r);
    if (isText) {
      const k = absOf(root, placed[0], placed[1]);
      tidy(root);
      caretAt(root, k);
    } else tidy(root);
  }

  /* what: 'strong' | 'em' | 'code' | 'link' (href: an address js/editor-md.js linkHref accepted; a link
     mark is an <a> WITHOUT href, so it never navigates while typing). */
  const FORMAT_TAG = Object.freeze({ strong: 'b', em: 'i', code: 'code', link: 'a' });
  function format(root, what, href) {
    const doc = root.ownerDocument;
    const s = doc.getSelection();
    if (!s.rangeCount || s.isCollapsed || !Object.prototype.hasOwnProperty.call(FORMAT_TAG, what)) return;
    if (what === 'link' && (typeof href !== 'string' || !href)) return;
    const r = s.getRangeAt(0);
    if (!root.contains(r.commonAncestorContainer)) return;
    const el = doc.createElement(FORMAT_TAG[what]);
    el.setAttribute(SUG, 'fmt');
    el.setAttribute('data-hc-fmt', what);
    if (what === 'link') el.setAttribute('data-hc-href', href);
    el.setAttribute(ID, newId());
    el.className = 'hc-sug hc-sug-fmt';
    try { r.surroundContents(el); } catch (e) { el.appendChild(r.extractContents()); r.insertNode(el); }
    s.removeAllRanges(); const r2 = doc.createRange(); r2.selectNodeContents(el); s.addRange(r2);
  }

  /* -> {detach()}. opts.onChange() runs after every handled edit; opts.plain: no suggestion marks
     (a code box: the browser edits plain text, Enter included). */
  function attach(root, opts) {
    const o = opts || {};
    const changed = () => { if (typeof o.onChange === 'function') o.onChange(); };
    function onBeforeInput(ev) {
      const t = ev.inputType;
      if (o.plain) {
        if (/^(insertText|insertReplacementText|insertLineBreak|insertParagraph|deleteContent(Backward|Forward)|deleteWord(Backward|Forward)|insertFromPaste)$/.test(t)) {
          if (t === 'insertFromPaste') { ev.preventDefault(); const text = ev.dataTransfer ? ev.dataTransfer.getData('text/plain') : ''; root.ownerDocument.execCommand('insertText', false, text); }
          return;                                   // plain text edits: the browser's own
        }
        ev.preventDefault();
        return;
      }
      if (ev.isComposing || t === 'insertCompositionText') return;
      if (/^insert(Text|ReplacementText|FromPaste|FromDrop)$/.test(t)) {
        ev.preventDefault();
        const text = ev.data != null ? ev.data : (ev.dataTransfer ? ev.dataTransfer.getData('text/plain') : '');
        insert(root, String(text).replace(/\r\n?/g, '\n').replace(/\n/g, ' '));
      } else if (t === 'insertLineBreak') { ev.preventDefault(); insert(root, root.ownerDocument.createElement('br')); }
      else if (/^delete(Word|SoftLine|HardLine)(Backward|Forward)$/.test(t)) {
        // a word or a line: the range the browser itself would delete, struck (or removed, where it is mine)
        ev.preventDefault();
        const tr = typeof ev.getTargetRanges === 'function' ? ev.getTargetRanges()[0] : null;
        if (tr && !tr.collapsed && root.contains(tr.startContainer) && root.contains(tr.endContainer)) {
          const r = root.ownerDocument.createRange();
          r.setStart(tr.startContainer, tr.startOffset); r.setEnd(tr.endContainer, tr.endOffset);
          const sel = root.ownerDocument.getSelection(); sel.removeAllRanges(); sel.addRange(r);
        }
        erase(root, /Forward$/.test(t));
      } else if (t === 'deleteContentBackward') { ev.preventDefault(); erase(root, false); }
      else if (t === 'deleteContentForward' || t === 'deleteByCut' || t === 'deleteContent') { ev.preventDefault(); erase(root, true); }
      else if (t === 'formatBold' || t === 'formatItalic') { ev.preventDefault(); format(root, t === 'formatBold' ? 'strong' : 'em'); }
      else { ev.preventDefault(); return; }        // Enter, undo, drag: not here
      changed();
    }
    /* A composition (a dead key, an IME) is typed by the browser itself; when it ends, the composed
       text right before the caret is taken out again and put back through insert(), so it becomes a
       suggestion like any other typing. Inside your own inserted text it already is one. */
    function onCompositionEnd(ev) {
      if (o.plain || !ev.data) return;
      const data = String(ev.data);
      root.ownerDocument.defaultView.setTimeout(() => {
        const c = caret(root);
        if (c && c.node.nodeType === 3 && !up(c.node, isIns, root) && c.off >= data.length
          && c.node.data.slice(c.off - data.length, c.off) === data) {
          c.node.deleteData(c.off - data.length, data.length);
          const r = root.ownerDocument.createRange(); r.setStart(c.node, c.off - data.length); r.collapse(true);
          const s = root.ownerDocument.getSelection(); s.removeAllRanges(); s.addRange(r);
          insert(root, data);
        }
        changed();
      }, 0);
    }
    root.addEventListener('beforeinput', onBeforeInput);
    root.addEventListener('compositionend', onCompositionEnd);
    return { detach() { root.removeEventListener('beforeinput', onBeforeInput); root.removeEventListener('compositionend', onCompositionEnd); } };
  }

  const API = { attach, insert, erase, format };
  if (typeof window !== 'undefined') window.HCEditorType = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
}());
