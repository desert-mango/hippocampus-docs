// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 14 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test the Editor mode converter: every content block round-trips byte for byte or opens as the Markdown box.
/* Unit tests for js/editor-md.js (HCEditorMd), the editor redesign's converter (plan section 6, U1).

   The bar, made falsifiable:
     - every block of every content page either passes the gate (serialize(renderBlock(md)) === md,
       byte for byte) or opens as the Markdown box with its bytes untouched; never a third way;
     - per-group floors: in setup, projects, tools and about, at least 95 % of paragraph, heading and
       list blocks open for typing in the page; code blocks and note boxes open in their own editors
       100 %; tables, tabs and other raw HTML are the Markdown box by design;
     - an edited block with Markdown-special characters serializes to Markdown that renders back to
       the same text and structure, every other block byte-identical (the span model);
     - the D1 suggestion marks: inserted text kept, deleted text dropped, a format mark written as
       the format;
     - the serializer refuses a DOM that js/app.js's enhance() touched (cross-reference links,
       heading anchors, copy buttons), so the gate can never pass on a DOM nobody typed into.

   The browser DOM is replaced by tools/tests/fixtures/dom_shim.mjs (the sanitizer's shim).

     node --test tools/tests/test_editor_md.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ShimDOMParser, ShimElement, ShimText, HTML_NS, parseHTML } from './fixtures/dom_shim.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
globalThis.DOMParser = ShimDOMParser;
const M = require(path.join(ROOT, 'js', 'editor-md.js'));
const C = require(path.join(ROOT, 'js', 'cms-core.js'));

function contentFiles() {
  const out = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d).sort()) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith('.md')) out.push(p);
    }
  };
  walk(path.join(ROOT, 'content'));
  return out;
}
const groupOf = (p) => {
  const r = path.relative(path.join(ROOT, 'content'), p).split(path.sep)[0];
  return r.endsWith('.md') ? r.replace(/\.md$/, '') : r;
};
const classOf = (b) => {
  if (['paragraph', 'heading', 'list'].includes(b.kind)) return 'text';
  if (b.kind === 'wrapper') return /^<div class="adm[ "]/.test(b.text) ? 'box' : 'other-html';
  return b.kind;
};

test('js/editor-md.js loads under node with the DOM shim and exposes the converter', () => {
  for (const f of ['renderBlock', 'serialize', 'gate', 'editorFor']) assert.equal(typeof M[f], 'function', f);
});

test('every block of every content page round-trips byte for byte or opens as the Markdown box; per-group floors hold', () => {
  const files = contentFiles();
  assert.ok(files.length >= 93, `all content pages (${files.length})`);
  const tally = {};
  const misses = [];
  for (const f of files) {
    const split = C.splitBlocks(fs.readFileSync(f, 'utf8'));
    assert.ok(split.ok, `${f} splits`);
    for (const b of split.blocks) {
      if (b.kind === 'space') continue;
      const ed = M.editorFor(b);
      const key = `${groupOf(f)}/${classOf(b)}`;
      tally[key] = tally[key] || { n: 0, open: 0 };
      tally[key].n += 1;
      if (ed === 'markdown') {
        // the Markdown box shows the block's own bytes: nothing to rewrite
        if (classOf(b) === 'text' || classOf(b) === 'box' || classOf(b) === 'code') misses.push(`${path.relative(ROOT, f)}: ${M.gate(b.text, b.kind).reason}`);
        continue;
      }
      tally[key].open += 1;
      // the gate's promise, re-checked here: the editor writes the block back unchanged
      const kind = b.kind === 'wrapper' ? 'wrapper' : b.kind;
      assert.equal(M.serialize(M.renderBlock(b.text), b.text, kind), b.text, `${path.relative(ROOT, f)} round-trips`);
    }
  }
  const share = (k) => (tally[k] ? tally[k].open / tally[k].n : 1);
  for (const g of ['setup', 'projects', 'tools', 'about']) {
    assert.ok(share(`${g}/text`) >= 0.95, `${g}: ${(100 * share(`${g}/text`)).toFixed(1)}% of paragraph/heading/list blocks open for typing (floor 95%)\n${misses.join('\n')}`);
    assert.equal(share(`${g}/code`), 1, `${g}: every code block opens in the code box`);
    assert.equal(share(`${g}/box`), 1, `${g}: every note box opens in the note-box editor\n${misses.join('\n')}`);
  }
  for (const k of Object.keys(tally).filter((x) => /\/(table|html|other-html)$/.test(x))) {
    assert.equal(tally[k].open, 0, `${k}: tables, tabs and raw HTML are the Markdown box by design`);
  }
});

/* An edit: render the block, change the text node holding `find` to `to`, serialize. */
function edit(md, kind, find, to) {
  const root = M.renderBlock(md);
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3 && c.data.includes(find)) { c.data = c.data.replace(find, to); return true; }
      if (c.nodeType === 1 && walk(c)) return true;
    }
    return false;
  };
  assert.ok(walk(root), `found "${find}"`);
  return { root, out: M.serialize(root, md, kind) };
}
/* Structure, with ONE deliberate exception written into the contract: a typed bare URL comes back as
   a link whose text is the URL itself (GFM autolink), exactly as every bare URL in content/ renders
   on the site. Any other new element (emphasis, code, a tag) is a failure. */
const isAutolink = (n) => n.nodeType === 1 && n.localName === 'a' && n.getAttribute('href') === n.textContent && /^https?:\/\//.test(n.textContent);
const shape = (n) => (n.nodeType === 3 || isAutolink(n) ? '' : `${n.localName}(${n.childNodes.filter((c) => (c.nodeType === 1 && !isAutolink(c)) || (c.nodeType === 3 && /\S/.test(c.data))).map(shape).join(',')})`);
const normText = (n) => n.textContent.replace(/\s+/g, ' ').trim();

test('an edited block with Markdown-special characters renders back to the same text and structure', () => {
  const typed = [
    'stars * and _underscores_ and `ticks` and [brackets](x) and <div class="adm"> and # and > and | and \\',
    '1. at the start',
    '# not a heading',
    '- not a list',
    '> not a quote',
    'a &amp; entity and ~~tildes~~ and **bold**',
    'single ~tilde~ pairs, a ~35° tilt and ~/paths ~/here',
    'a <b>tag</b> typed as text and a URL https://example.org/x_y',
  ];
  const cases = [
    ['A plain paragraph here.\n\n', 'paragraph', 'plain paragraph here.'],
    ['## A heading\n\n', 'heading', 'A heading'],
    ['- one item\n- two item\n\n', 'list', 'two item'],
    ['Some **bold** and *em* text.\n\n', 'paragraph', ' text.'],
  ];
  for (const [md, kind, find] of cases) {
    for (const t of typed) {
      const to = kind === 'heading' ? t.replace(/\n/g, ' ') : (find.startsWith(' ') ? ` ${t}` : t);
      const { root, out } = edit(md, kind, find, to);
      const back = M.renderBlock(out);
      assert.equal(normText(back), normText(root), `text survives: ${JSON.stringify(t)} in ${JSON.stringify(md)}\n${out}`);
      assert.equal(shape(back), shape(root), `structure survives: ${JSON.stringify(t)} in ${JSON.stringify(md)}\n${out}`);
      assert.ok(out.endsWith('\n\n'), 'the trailing newlines stay');
    }
  }
});

test('an edit to one block leaves every other block of the page byte-identical (span model)', () => {
  const page = fs.readFileSync(path.join(ROOT, 'content/setup/lab-gantry/usage.md'), 'utf8');
  const split = C.splitBlocks(page);
  const i = split.blocks.findIndex((b) => b.text.includes('TODO: this needs to be fixed.'));
  const b = split.blocks[i];
  const { out } = edit(b.text, b.kind, 'TODO: this needs to be fixed.', 'If a motor still times out, check its cable first.');
  const next = C.replaceSpan(page, { start: b.start, end: b.end }, out).text;
  const after = C.splitBlocks(next);
  assert.equal(after.blocks.length, split.blocks.length);
  split.blocks.forEach((x, k) => { if (k !== i) assert.equal(after.blocks[k].text, x.text, `block ${k} unchanged`); });
  assert.match(after.blocks[i].text, /check its cable first\./);
});

test('typed DOM from contenteditable: a no-break space becomes a space; a typed URL stays a bare URL (it renders as a link, as in content)', () => {
  const root = M.renderBlock('Hello world.\n\n');
  root.childNodes[0].childNodes[0].data = 'Hello world, see https://example.org now.';
  assert.equal(M.serialize(root, 'Hello world.\n\n', 'paragraph'), 'Hello world, see https://example.org now.\n\n');
});

test('D1 suggestion marks: inserted text is kept, deleted text dropped, a format mark is written as the format', () => {
  const md = 'If you encounter errors, keep going. TODO: this needs to be fixed.\n\n';
  const root = M.renderBlock(md);
  const p = root.childNodes.find((c) => c.nodeType === 1);
  p.childNodes = [];
  const add = (n) => { p.appendChild(n); return n; };
  const el = (name, attrs, text) => { const e = new ShimElement(name, HTML_NS); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text !== undefined) e.appendChild(new ShimText(text)); return e; };
  add(new ShimText('If you encounter errors, keep '));
  // exactly as js/editor-type.js draws them: data-hc-sug, data-hc-id and the hc-sug classes
  add(el('b', { 'data-hc-sug': 'fmt', 'data-hc-fmt': 'strong', 'data-hc-id': 's2', class: 'hc-sug hc-sug-fmt' }, 'going'));
  add(new ShimText('. '));
  add(el('del', { 'data-hc-sug': 'del', 'data-hc-id': 's1', class: 'hc-sug hc-sug-del' }, 'TODO: this needs to be fixed.'));
  add(el('ins', { 'data-hc-sug': 'ins', 'data-hc-id': 's1', class: 'hc-sug hc-sug-ins' }, 'Check the x-axis cable first.'));
  assert.equal(M.serialize(root, md, 'paragraph'), 'If you encounter errors, keep **going**. Check the x-axis cable first.\n\n');
  // a content <del> (~~text~~) is NOT a suggestion: it stays a strike-through
  assert.equal(M.serialize(M.renderBlock('Old ~~gone~~ text.\n\n'), 'Old ~~gone~~ text.\n\n', 'paragraph'), 'Old ~~gone~~ text.\n\n');
  // content cannot forge a suggestion mark: the sanitizer drops data-hc-sug
  const forged = M.renderBlock('A <del data-hc-sug="del">secret</del> word.\n\n');
  assert.match(M.serialize(forged, 'A ~~secret~~ word.\n\n', 'paragraph'), /secret/);
});

/* Kyle's live feedback (2026-10-14) item 5: the format bar adds Link and inline code. js/editor-type.js draws
   them as format suggestions like Bold/Italic; the serializer writes the Markdown; the address is checked
   on the way in (the bar) and again here, so a forged mark cannot carry a script address. */
test('format suggestions for inline code and a link are written as Markdown; a bad address is refused', () => {
  const md = 'Run the launch file, then read the guide.\n\n';
  const el = (name, attrs, ...kids) => { const e = new ShimElement(name, HTML_NS); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); for (const k of kids) e.appendChild(typeof k === 'string' ? new ShimText(k) : k); return e; };
  const build = (...parts) => { const root = M.renderBlock(md); const p = root.childNodes.find((c) => c.nodeType === 1); p.childNodes = []; for (const x of parts) p.appendChild(typeof x === 'string' ? new ShimText(x) : x); return root; };
  const code = (...k) => el('code', { 'data-hc-sug': 'fmt', 'data-hc-fmt': 'code', 'data-hc-id': 's1', class: 'hc-sug hc-sug-fmt' }, ...k);
  const link = (href, ...k) => el('a', { 'data-hc-sug': 'fmt', 'data-hc-fmt': 'link', 'data-hc-href': href, 'data-hc-id': 's2', class: 'hc-sug hc-sug-fmt' }, ...k);
  assert.equal(M.serialize(build('Run ', code('the launch file'), ', then read the guide.'), md, 'paragraph'), 'Run `the launch file`, then read the guide.\n\n');
  // a struck part inside the code mark is gone; a backtick inside gets the longer fence
  assert.equal(M.serialize(build('Run ', code('a', el('del', { 'data-hc-sug': 'del', 'data-hc-id': 's3', class: 'hc-sug hc-sug-del' }, 'xx'), '`b'), '.'), md, 'paragraph'), 'Run ``a`b``.\n\n');
  assert.equal(M.serialize(build('Read ', link('https://docs.ros.org/en/humble/', 'the guide'), '.'), md, 'paragraph'), 'Read [the guide](https://docs.ros.org/en/humble/).\n\n');
  assert.equal(M.serialize(build('Read ', link('#/setup/lab-gantry/usage', 'Usage'), '.'), md, 'paragraph'), 'Read [Usage](#/setup/lab-gantry/usage).\n\n');
  assert.equal(M.serialize(build('Read ', link('docs/a b.md', 'it'), '.'), md, 'paragraph'), 'Read [it](<docs/a b.md>).\n\n');
  for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,x', 'vbscript:x', 'mailto:a@b.c', '', 'foo:bar/baz',
    '//attacker.example', '#section', '?q=1', '\\\\host\\x', '/\\host']) {
    assert.equal(M.linkHref(bad), null, `refused: ${JSON.stringify(bad)}`);
    assert.throws(() => M.serialize(build('Read ', link(bad, 'it'), '.'), md, 'paragraph'), (e) => e.name === 'Unsupported', `serializer refuses ${JSON.stringify(bad)}`);
  }
  for (const [good, want] of [[' https://example.org/x ', 'https://example.org/x'], ['http://a.b', 'http://a.b'], ['#/about', '#/about'],
    ['/assets/x.pdf', '/assets/x.pdf'], ['wiring.md', 'wiring.md'], ['docs/x.md#part', 'docs/x.md#part']]) {
    assert.equal(M.linkHref(good), want, `allowed: ${good}`);
  }
});

test('the serializer refuses a DOM that the page enhanced after the Markdown (so the gate never passes on it)', () => {
  const md = '## Run the setup\n\nSee the [Wiring](#/setup/lab-gantry/wiring) page.\n\n';
  const clean = M.renderBlock(md);
  assert.equal(M.serialize(clean, md, 'paragraph'), md, 'the clean render round-trips');
  const withAnchor = M.renderBlock(md);
  const h2 = withAnchor.childNodes.find((c) => c.nodeType === 1 && c.localName === 'h2');
  const a = new ShimElement('a', HTML_NS); a.setAttribute('class', 'heading-anchor'); a.setAttribute('href', '#x'); a.appendChild(new ShimText('#'));
  h2.appendChild(a);
  assert.throws(() => M.serialize(withAnchor, md, 'paragraph'), (e) => e.name === 'Unsupported' && /heading-anchor/.test(e.message));
  const withXref = parseHTML('<p>The <a class="xref" href="#/g">gantry</a> moves.</p>').body;
  assert.throws(() => M.serialize(withXref, 'The gantry moves.\n\n', 'paragraph'), (e) => e.name === 'Unsupported' && /xref/.test(e.message));
  const withCopy = parseHTML('<pre><code>x</code></pre><button class="copy-btn">copy</button>').body;
  assert.throws(() => M.serialize(withCopy, '```\nx\n```\n\n', 'code'), (e) => e.name === 'Unsupported');
});

test('note boxes: the wrapper lines are kept, the inside is typed, and the box type and title can change', () => {
  const md = '<div class="adm adm-note"><p class="adm-title">Note</p>\n\nSwitch the gantry on first.\n\n</div>\n\n';
  assert.equal(M.editorFor({ kind: 'wrapper', text: md }), 'box');
  const root = M.renderBlock(md);
  const box = root.childNodes.find((c) => c.nodeType === 1);
  box.setAttribute('class', 'adm adm-warning');
  box.childNodes.find((c) => c.nodeType === 1 && c.getAttribute('class') === 'adm-title').childNodes[0].data = 'Warning';
  const body = box.childNodes.filter((c) => c.nodeType === 1)[1];
  body.childNodes[0].data = 'Switch the gantry on at the wall first.';
  assert.equal(M.serialize(root, md, 'wrapper'), '<div class="adm adm-warning"><p class="adm-title">Warning</p>\n\nSwitch the gantry on at the wall first.\n\n</div>\n\n');
  assert.equal(M.editorFor({ kind: 'wrapper', text: '<div class="tabs">\n\n<div class="tab" data-label="A">\n\nx\n\n</div>\n</div>\n\n' }), 'markdown', 'tabs are the Markdown box');
});

test('code blocks: the fence lines are kept verbatim, only the inside changes', () => {
  const md = '```console\n$ ros2 launch gantry xyz_motors.launch.py\n```\n\n';
  assert.equal(M.editorFor({ kind: 'code', text: md }), 'code');
  const { out } = edit(md, 'code', 'xyz_motors', 'xyz_motors_v2');
  assert.equal(out, '```console\n$ ros2 launch gantry xyz_motors_v2.launch.py\n```\n\n');
  // the language picker (data-hc-lang on the <pre>) rewrites the fence's info string only
  const picked = M.renderBlock(md);
  picked.childNodes.find((c) => c.nodeType === 1).setAttribute('data-hc-lang', 'bash');
  assert.equal(M.serialize(picked, md, 'code'), '```bash\n$ ros2 launch gantry xyz_motors.launch.py\n```\n\n');
  // a typed fence line inside the code would end the block early: refused, never written
  const root = M.renderBlock(md);
  const code = root.childNodes.find((c) => c.nodeType === 1).childNodes[0];
  code.childNodes[0].data = '```\n$ ros2 launch\n';
  assert.throws(() => M.serialize(root, md, 'code'), (e) => e.name === 'Unsupported' && /fence/.test(e.message));
});

// ---- round 2, R2b: the Edit menu's Undo/Redo go to the Editor's history, also in a code block (codex r1) ----
test('HCEditorType: historyUndo / historyRedo are refused and handed to onHistory, rich and plain alike', async () => {
  const T = (await import('node:module')).createRequire(import.meta.url)('../../js/editor-type.js');
  for (const plain of [false, true]) {
    const listeners = {};
    const root = { addEventListener: (t, fn) => { listeners[t] = fn; }, removeEventListener() {}, ownerDocument: {} };
    const told = [];
    T.attach(root, { plain, onHistory: (op) => told.push(op), onBefore: () => told.push('before') });
    for (const inputType of ['historyUndo', 'historyRedo']) {
      let prevented = false;
      listeners.beforeinput({ inputType, preventDefault() { prevented = true; } });
      assert.equal(prevented, true, `${inputType} (plain ${plain}) is not the browser's`);
    }
    assert.deepEqual(told, ['undo', 'redo'], 'no restore point for an undo');
  }
});
