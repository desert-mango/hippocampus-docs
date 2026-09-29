// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 29 September 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test the editor's block model, span editor, block diff, overlay, cached fetcher and view settings.
/* Unit tests for the block-model half of js/cms-core.js (plan D-D, D-E, D-F):

     splitBlocks     the vendored marked lexer's top-level tokens, re-anchored
                     to real offsets, with the anchoring guard (block editing
                     turns OFF, with a reason, when marked read the text
                     differently from the bytes on disk)
     spanOf / replaceSpan / insertAt / moveBlock / deleteBlock / withSentinels
     blockDiff / overlayOnMain  (fixture: PR #1 at d0bdc64 over its merge base)
     cachedFetcher / resolveRef / viewSettings / membersOnly / SNIPPETS

   R3 oracle (a) runs here, in node, over every content/**\/*.md: the blocks
   join back to the file byte for byte and every block's text is the slice
   of the file at its own offsets. Oracles (b) and (c) need a real HTML tree
   builder and run in Chrome (tools/tests/browser_oracles.mjs).

     node --test tools/tests/test_block_model.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const C = require(path.join(ROOT, 'js', 'cms-core.js'));
const FIX = path.join(ROOT, 'tools', 'tests', 'fixtures', 'github-data');
const fixture = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');

function contentFiles(dir = path.join(ROOT, 'content')) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return contentFiles(p);
    return e.name.endsWith('.md') ? [p] : [];
  }).sort();
}

const trimEnd = (s) => s.replace(/\s+$/, '');
const nonSpace = (blocks) => blocks.filter((b) => b.kind !== 'space');

function assertPartition(text, split, label) {
  assert.equal(split.ok, true, `${label}: ${split.reason}`);
  const { blocks } = split;
  assert.equal(blocks.map((b) => b.text).join(''), text, `${label}: blocks join back to the file`);
  let at = 0;
  for (const b of blocks) {
    assert.equal(b.start, at, `${label}: blocks are contiguous`);
    assert.ok(b.end > b.start, `${label}: no empty block`);
    assert.equal(b.text, text.slice(b.start, b.end), `${label}: block text is its own slice`);
    at = b.end;
  }
  assert.equal(at, text.length, `${label}: the last block ends at the end of the file`);
}

// ------------------------------------------------------ R3 oracle (a) --

test('oracle (a): every content page splits, joins back byte for byte, and each block is its own slice', () => {
  const files = contentFiles();
  assert.ok(files.length >= 90, `expected the whole content tree, found ${files.length}`);
  const kinds = new Set();
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const split = C.splitBlocks(text);
    assertPartition(text, split, path.relative(ROOT, f));
    split.blocks.forEach((b) => kinds.add(b.kind));
  }
  for (const k of ['heading', 'paragraph', 'list', 'code', 'table', 'wrapper', 'image', 'space']) {
    assert.ok(kinds.has(k), `the content tree exercises kind '${k}'`);
  }
  for (const k of kinds) assert.ok(C.BLOCK_KINDS.includes(k), `kind '${k}' is a declared kind`);
});

test('wrappers: an adm box, nested tabs, a details and an img-grid are each ONE block', () => {
  const text = [
    '# Title', '',
    '<div class="adm adm-note"><p class="adm-title">Note</p>', '', 'Inside the note.', '', '- a list inside', '', '</div>', '',
    'Between.', '',
    '<div class="tabs">', '', '<div class="tab" data-label="One">', '', 'First.', '', '</div>', '',
    '<div class="tab" data-label="Two">', '', '```sh', 'echo two', '```', '', '</div>', '', '</div>', '',
    '<details><summary>More</summary>', '', 'Hidden text.', '', '</details>', '',
    '<div class="img-grid">', '', '![a](https://res.cloudinary.com/x/image/upload/a.jpg)', '', '</div>', '',
    'End.', '',
  ].join('\n');
  const split = C.splitBlocks(text);
  assertPartition(text, split, 'wrappers');
  const blocks = nonSpace(split.blocks);
  assert.deepEqual(blocks.map((b) => b.kind),
    ['heading', 'wrapper', 'paragraph', 'wrapper', 'wrapper', 'wrapper', 'paragraph']);
  assert.match(blocks[1].text, /^<div class="adm adm-note">[\s\S]*<\/div>\n/);
  assert.match(blocks[3].text, /^<div class="tabs">[\s\S]*echo two[\s\S]*<\/div>\n\n<\/div>\n/);
  assert.match(blocks[4].text, /^<details>[\s\S]*<\/details>\n/);
});

test('a numbered list with indented fences and an indented adm box inside it is ONE block', () => {
  const file = path.join(ROOT, 'content', 'setup', 'hippocampus-bringup', 'fcu-firmware.md');
  const text = fs.readFileSync(file, 'utf8');
  const split = C.splitBlocks(text);
  assertPartition(text, split, 'fcu-firmware');
  const lists = split.blocks.filter((b) => b.kind === 'list');
  assert.ok(lists.some((b) => /\n {4}```/.test(b.text) && /\n {4}<div class="adm/.test(b.text)),
    'one list block holds both the indented fence and the indented adm box');
});

test('an unclosed wrapper swallows the rest of the page into one block (never a block inside it)', () => {
  const text = 'Intro.\n\n<div class="adm adm-note">\n\nNever closed.\n\n## Heading\n\nMore.\n';
  const split = C.splitBlocks(text);
  assertPartition(text, split, 'unclosed');
  const blocks = nonSpace(split.blocks);
  assert.deepEqual(blocks.map((b) => b.kind), ['paragraph', 'wrapper']);
  assert.ok(blocks[1].text.endsWith('More.\n'));
});

test('an inline </div> inside a paragraph closes a wrapper the way the browser does', () => {
  const text = '<div class="adm adm-note">\n\ntext</div>\n\nAfter.\n';
  const split = C.splitBlocks(text);
  assertPartition(text, split, 'inline close');
  assert.deepEqual(nonSpace(split.blocks).map((b) => b.kind), ['wrapper', 'paragraph']);
});

test('a tag spelled inside code (a fence or a code span) never opens a wrapper', () => {
  const text = 'Use `<div class="adm">` like this:\n\n```html\n<div class="adm adm-note">\n```\n\nAfter.\n';
  const split = C.splitBlocks(text);
  assertPartition(text, split, 'code tags');
  assert.deepEqual(nonSpace(split.blocks).map((b) => b.kind), ['paragraph', 'code', 'paragraph']);
});

test('kinds: a paragraph that is only an image is an image block; an empty file has no blocks', () => {
  const text = '![A photo](https://res.cloudinary.com/x/image/upload/a.jpg)\n\nText with ![inline](https://res.cloudinary.com/x/image/upload/b.jpg) image.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
  const split = C.splitBlocks(text);
  assertPartition(text, split, 'kinds');
  assert.deepEqual(nonSpace(split.blocks).map((b) => b.kind), ['image', 'paragraph', 'table']);
  assert.deepEqual(C.splitBlocks(''), { ok: true, reason: null, blocks: [] });
  assert.equal(C.splitBlocks(null).ok, false);
});

// ------------------------------------------------- the anchoring guard --

test('edge: a reference definition after a heading is attached to the heading block; editing near it is exact', () => {
  const text = '# Title\n[site]: https://example.org\n\nSee [site] for more.\n\nLast paragraph.\n';
  const split = C.splitBlocks(text);
  assertPartition(text, split, 'ref def');
  const [h] = split.blocks;
  assert.equal(h.kind, 'heading');
  assert.equal(h.text, '# Title\n[site]: https://example.org\n\n');
  const i = split.blocks.findIndex((b) => b.text.startsWith('See [site]'));
  const span = C.spanOf(text, i);
  const edited = C.replaceSpan(text, span, 'See [site] now.');
  assert.equal(edited.text.slice(0, span.start), text.slice(0, span.start));
  assert.equal(edited.text.slice(edited.span.end), text.slice(span.end));
  assertPartition(edited.text, C.splitBlocks(edited.text), 'ref def after edit');
});

test('edge: reference definitions after a paragraph and at the end of the file are attached, never lost', () => {
  const text = 'Para [x].\n\n[x]: https://example.org "Title"\n\n## Next\n\nText.\n\n[y]: https://example.org/y\n';
  const split = C.splitBlocks(text);
  assertPartition(text, split, 'trailing defs');
  assert.ok(split.blocks[split.blocks.length - 1].text.endsWith('[y]: https://example.org/y\n'));
});

test('edge: a tab-indented line inside a fence turns block editing OFF with a reason (never a wrong split)', () => {
  const text = '# Title\n\n```sh\n\tindented with a tab\n```\n\nAfter.\n';
  const split = C.splitBlocks(text);
  assert.equal(split.ok, false);
  assert.match(split.reason, /tab/i);
  assert.deepEqual(split.blocks, []);
  assert.equal(C.spanOf(text, 0), null, 'no span: only "Edit whole page as Markdown" is offered');
  assert.equal(C.withSentinels(text, 'abcd1234'), null);
  assert.equal(C.insertAt(text, 1, 'note'), null);
  assert.equal(C.moveBlock(text, 0, 2), null);
  assert.equal(C.deleteBlock(text, 0), null);
});

test('edge: a CRLF file turns block editing OFF with a reason', () => {
  const text = '# Title\r\n\r\nA paragraph.\r\n';
  const split = C.splitBlocks(text);
  assert.equal(split.ok, false);
  assert.match(split.reason, /line endings|CR/);
  assert.equal(C.spanOf(text, 0), null);
});

test('edge: an edit that introduces a tab or a CR turns block editing off on the next split, and the bytes are still exact', () => {
  const text = '# Title\n\n```sh\necho hi\n```\n\nAfter.\n';
  const i = C.splitBlocks(text).blocks.findIndex((b) => b.kind === 'code');
  const span = C.spanOf(text, i);
  for (const insert of ['```sh\n\techo hi\n```\n', '```sh\r\necho hi\r\n```\r\n']) {
    const out = C.replaceSpan(text, span, insert);
    assert.equal(out.text, text.slice(0, span.start) + insert + text.slice(span.end));
    assert.equal(C.splitBlocks(out.text).ok, false);
  }
});

test('the guard: a gap with real content, or a raw that cannot be found, turns block editing off', () => {
  const text = 'One.\n\nTwo.\n';
  const skip = () => [{ type: 'paragraph', raw: 'Two.\n' }];
  assert.equal(C.splitBlocks(text, { lexer: skip }).ok, false, 'a gap made of a paragraph');
  const lost = () => [{ type: 'paragraph', raw: 'One.\n' }, { type: 'paragraph', raw: 'Three.\n' }];
  assert.equal(C.splitBlocks(text, { lexer: lost }).ok, false, 'a raw that is nowhere');
  const short = () => [{ type: 'paragraph', raw: 'One.\n' }];
  assert.equal(C.splitBlocks(text, { lexer: short }).ok, false, 'a tail with real content');
  const boom = () => { throw new Error('lexer broke'); };
  assert.equal(C.splitBlocks(text, { lexer: boom }).ok, false);
  const defGap = () => [{ type: 'paragraph', raw: 'One.\n' }, { type: 'paragraph', raw: 'Two.\n' }];
  const withDef = 'One.\n[a]: https://x.org\n\nTwo.\n';
  assert.equal(C.splitBlocks(withDef, { lexer: defGap }).ok, true, 'a definition-and-blank-line gap is fine');
  const midLine = () => [{ type: 'paragraph', raw: 'One.' }, { type: 'paragraph', raw: 'Two.\n' }];
  assert.equal(C.splitBlocks('One.[a]: https://x.org\nTwo.\n', { lexer: midLine }).ok, false,
    'a definition-looking text in the middle of a line is not a definition line');
});

// ----------------------------------------------------- the span editor --

const PAGE = '# Page\n\nFirst paragraph.\n\n## Section\n\nSecond paragraph.\n\n- one\n- two\n\nLast.\n';

test('spanOf gives the block offsets; out of range is null', () => {
  const { blocks } = C.splitBlocks(PAGE);
  blocks.forEach((b, i) => assert.deepEqual(C.spanOf(PAGE, i), { start: b.start, end: b.end }));
  assert.equal(C.spanOf(PAGE, blocks.length), null);
  assert.equal(C.spanOf(PAGE, -1), null);
  assert.equal(C.spanOf(PAGE, 1.5), null);
});

test('replaceSpan: typing an unclosed fence, then an unclosed wrapper, never touches the text outside the span', () => {
  const i = C.splitBlocks(PAGE).blocks.findIndex((b) => b.text.startsWith('First'));
  let span = C.spanOf(PAGE, i);
  let text = PAGE;
  const before = PAGE.slice(0, span.start);
  const after = PAGE.slice(span.end);
  let typed = '';
  for (const ch of '```js\nconst x = 1;\n<div class="adm adm-note">\n\nnot closed') {
    typed += ch;
    const out = C.replaceSpan(text, span, typed);
    text = out.text;
    span = out.span;
    assert.equal(text.slice(0, span.start), before, 'text before the span is byte-identical');
    assert.equal(text.slice(span.end), after, 'text after the span is byte-identical');
    assert.equal(text.slice(span.start, span.end), typed);
  }
  assert.throws(() => C.replaceSpan(PAGE, { start: 5, end: 2 }, 'x'));
  assert.throws(() => C.replaceSpan(PAGE, { start: 0, end: PAGE.length + 1 }, 'x'));
  assert.throws(() => C.replaceSpan(PAGE, { start: 0, end: 1 }, 42));
});

test('insertAt puts a snippet at a block boundary as its own block and returns its span', () => {
  const split = C.splitBlocks(PAGE);
  const at = split.blocks.findIndex((b) => b.text.startsWith('## Section'));
  const out = C.insertAt(PAGE, at, 'note');
  assert.ok(out && typeof out.text === 'string');
  const after = C.splitBlocks(out.text);
  assertPartition(out.text, after, 'after insert');
  const ins = out.text.slice(out.span.start, out.span.end);
  assert.match(ins, /^<div class="adm adm-note">/);
  const kinds = nonSpace(after.blocks).map((b) => b.kind);
  assert.deepEqual(kinds, ['heading', 'paragraph', 'wrapper', 'heading', 'paragraph', 'list', 'paragraph']);
  // every old block is still there, unchanged
  const old = nonSpace(split.blocks).map((b) => trimEnd(b.text));
  const now = nonSpace(after.blocks).map((b) => trimEnd(b.text));
  assert.deepEqual(now.filter((t) => !t.startsWith('<div')), old);
  // raw Markdown works too, at the very end and at the very start
  const end = C.insertAt(PAGE, split.blocks.length, 'Appended.');
  assert.ok(end.text.endsWith('Last.\n\nAppended.\n'));
  const start = C.insertAt(PAGE, 0, 'Prepended.');
  assert.ok(start.text.startsWith('Prepended.\n\n# Page\n'));
  assert.throws(() => C.insertAt(PAGE, 0, 42));
  assert.equal(C.insertAt(PAGE, split.blocks.length + 1, 'x'), null);
});

test('moveBlock and deleteBlock keep every other block byte-identical and never glue two blocks together', () => {
  const text = 'Alpha.\n# Heading\nBeta.\n\nGamma.\n';
  const split = C.splitBlocks(text);
  const names = nonSpace(split.blocks).map((b) => trimEnd(b.text));
  assert.deepEqual(names, ['Alpha.', '# Heading', 'Beta.', 'Gamma.']);
  const h = split.blocks.findIndex((b) => b.kind === 'heading');
  const del = C.deleteBlock(text, h);
  assert.deepEqual(nonSpace(C.splitBlocks(del).blocks).map((b) => trimEnd(b.text)), ['Alpha.', 'Beta.', 'Gamma.'],
    'deleting the heading does not merge Alpha and Beta into one paragraph');
  const g = split.blocks.findIndex((b) => b.text.startsWith('Gamma'));
  const moved = C.moveBlock(text, g, 0);
  assert.deepEqual(nonSpace(C.splitBlocks(moved).blocks).map((b) => trimEnd(b.text)),
    ['Gamma.', 'Alpha.', '# Heading', 'Beta.']);
  const down = C.moveBlock(text, 0, split.blocks.length);
  assert.deepEqual(nonSpace(C.splitBlocks(down).blocks).map((b) => trimEnd(b.text)),
    ['# Heading', 'Beta.', 'Gamma.', 'Alpha.']);
  assert.equal(C.moveBlock(text, 0, 0), text, 'a move onto itself changes nothing');
  assert.equal(C.deleteBlock(text, 99), null);
});

test('withSentinels puts one id-sentinel before every non-space block, and only an id (never a class)', () => {
  const split = C.splitBlocks(PAGE);
  const out = C.withSentinels(PAGE, 'abcd1234');
  const ids = [...out.matchAll(/\n\n<div id="(hcb-abcd1234-(\d+))"><\/div>\n\n/g)];
  const want = split.blocks.map((b, i) => (b.kind === 'space' ? null : i)).filter((i) => i !== null);
  assert.deepEqual(ids.map((m) => Number(m[2])), want);
  assert.equal(out.replace(/\n\n<div id="hcb-abcd1234-\d+"><\/div>\n\n/g, ''), PAGE, 'removing the sentinels gives the page back');
  assert.ok(!/class=/.test(out), 'a sentinel carries an id only');
  assert.throws(() => C.withSentinels(PAGE, 'bad prefix"'));
  assert.throws(() => C.withSentinels(PAGE, 'ab'));
  assert.throws(() => C.withSentinels(PAGE, 'abcd'), 'a 4-character prefix is refused (content could guess it)');
  assert.throws(() => C.withSentinels(PAGE, 'abcdefg'), 'the minimum is 8 characters');
  assert.ok(C.withSentinels(PAGE, 'a1b2c3d4e5f6'), 'the oracle\'s hex(6) prefix is accepted');
  const spans = [{ start: 0, end: 8 }, { start: 8, end: PAGE.length }];
  const given = C.withSentinels(PAGE, 'abcd1234', spans);
  assert.equal((given.match(/<div id="hcb-/g) || []).length, 2, 'given spans are used as they are');
});

// ------------------------------------------------------ diff + overlay --

const BASE = fixture('page-ubuntu-24-04-server.at-merge-base.md');
const MAIN = fixture('page-ubuntu-24-04-server.at-75f09dd.md');
const HEAD = fixture('page-ubuntu-24-04-server.at-d0bdc64.md');

test('blockDiff: same text is all "same"; the PR #1 fixture has adds and changes, and replays to the head', () => {
  const same = C.blockDiff(BASE, BASE);
  assert.ok(same.length > 5 && same.every((d) => d.status === 'same'));
  const d = C.blockDiff(BASE, HEAD);
  const st = new Set(d.map((x) => x.status));
  assert.ok(st.has('add') && st.has('change') && st.has('same'));
  const a = nonSpace(C.splitBlocks(BASE).blocks.map((b, i) => ({ ...b, i })));
  const b = nonSpace(C.splitBlocks(HEAD).blocks.map((x, i) => ({ ...x, i })));
  assert.deepEqual(d.filter((x) => x.a !== null).map((x) => x.a), a.map((x) => x.i), 'every base block once, in order');
  assert.deepEqual(d.filter((x) => x.b !== null).map((x) => x.b), b.map((x) => x.i), 'every head block once, in order');
  const blocksH = C.splitBlocks(HEAD).blocks;
  const blocksA = C.splitBlocks(BASE).blocks;
  for (const x of d) {
    if (x.status === 'same') assert.equal(trimEnd(blocksA[x.a].text), trimEnd(blocksH[x.b].text));
    if (x.status === 'change') assert.notEqual(trimEnd(blocksA[x.a].text), trimEnd(blocksH[x.b].text));
  }
  const small = C.blockDiff('A.\n\nB.\n\nC.\n', 'A.\n\nC.\n\nD.\n');
  assert.deepEqual(small.map((x) => x.status), ['same', 'del', 'same', 'add']);
  const chg = C.blockDiff('A.\n\nB.\n\nC.\n', 'A.\n\nB2.\n\nC.\n');
  assert.deepEqual(chg.map((x) => x.status), ['same', 'change', 'same']);
  assert.equal(C.blockDiff('a\r\n', 'b\n'), null, 'a split that fails gives no diff');
});

test('overlayOnMain: PR #1 over main (= its merge base) — no conflict, main blocks kept in order, PR blocks marked', () => {
  const o = C.overlayOnMain(MAIN, BASE, HEAD);
  assert.ok(o);
  assert.deepEqual(o.conflicts, []);
  const main = C.splitBlocks(MAIN).blocks;
  const fromMain = o.overlay.filter((e) => e.mainIndex !== null);
  assert.deepEqual(fromMain.map((e) => e.mainIndex), main.map((b, i) => (b.kind === 'space' ? null : i)).filter((i) => i !== null),
    'every main block appears once, in order');
  for (const e of o.overlay) {
    assert.equal(o.text.slice(e.start, e.end), e.text);
    if (e.mainIndex !== null) assert.equal(trimEnd(e.text), trimEnd(main[e.mainIndex].text));
    if (e.source === 'main') assert.equal(e.pr, null);
  }
  const adds = o.overlay.filter((e) => e.source === 'pr-add');
  const dels = o.overlay.filter((e) => e.source === 'pr-del');
  assert.ok(adds.length >= 5 && dels.length >= 1);
  assert.ok(adds.some((e) => e.text.startsWith('<div class="adm adm-attention">')));
  // a replaced block is kept BEFORE its replacement
  for (const dl of dels.filter((x) => x.pr && x.pr.head !== null)) {
    const at = o.overlay.indexOf(dl);
    assert.equal(o.overlay[at + 1].source, 'pr-add');
    assert.equal(o.overlay[at + 1].pr.head, dl.pr.head);
  }
  // the composite with sentinels over the overlay's own spans: one sentinel per entry
  const withS = C.withSentinels(o.text, 'ovl12345', o.overlay);
  assert.equal((withS.match(/<div id="hcb-ovl12345-\d+"><\/div>/g) || []).length, o.overlay.length);
});

test('overlayOnMain: a block main changed AND the PR changed is shown as main\'s version, marked, never guessed', () => {
  const base = 'Title.\n\nShared block.\n\nTail.\n';
  const main = 'Title.\n\nShared block, as main has it now.\n\nTail.\n';
  const head = 'Title.\n\nShared block, as the proposal has it.\n\nNew from PR.\n\nTail.\n';
  const o = C.overlayOnMain(main, base, head);
  assert.deepEqual(o.overlay.map((e) => e.source), ['main', 'conflict', 'pr-add', 'main']);
  const c = o.overlay[1];
  assert.equal(c.text, 'Shared block, as main has it now.');
  assert.equal(c.mainIndex, C.splitBlocks(main).blocks.findIndex((b) => b.text.startsWith('Shared')));
  assert.equal(o.conflicts.length, 1);
  assert.equal(o.conflicts[0].mainIndex, c.mainIndex);
  assert.ok(!o.text.includes('as the proposal has it'), 'the PR side of a conflict is not drawn');
  assert.equal(C.overlayOnMain('x\r\n', base, head), null);
});

// ------------------------------------------- cached fetcher + resolveRef --

test('cachedFetcher: a counting fetch across two edits reads each path once (D-D reload cost)', async () => {
  const SHA = 'b'.repeat(40);
  const reads = new Map();
  const cache = C.cachedFetcher(async (sha, p) => {
    reads.set(`${sha}:${p}`, (reads.get(`${sha}:${p}`) || 0) + 1);
    return { ok: true, status: 200, text: `${p}@${sha.slice(0, 4)}` };
  });
  const paths = ['data/site.json', 'data/setup.json', 'content/about.md', 'content/setup/x.md'];
  for (const edit of ['first edit', 'second edit']) {
    const fetcher = C.draftFetcher({ 'content/setup/x.md': edit }, cache.at(SHA));
    const got = await Promise.all(paths.map((p) => fetcher(p)));
    assert.equal(got[3].text, edit, 'the draft file comes from memory');
    assert.equal(got[0].text, 'data/site.json@bbbb');
  }
  assert.deepEqual([...reads.values()], [1, 1, 1], 'each base path read once; the draft path never');
  assert.equal(cache.size(), 3);
  assert.throws(() => cache.at('main'), /sha/);
});

test('cachedFetcher: a failed read is not remembered; concurrent reads share one request', async () => {
  const SHA = 'c'.repeat(40);
  let n = 0;
  const cache = C.cachedFetcher(async () => {
    n += 1;
    return n === 1 ? { ok: false, status: 502, text: '' } : { ok: true, status: 200, text: 'ok' };
  });
  const f = cache.at(SHA);
  assert.equal((await f('data/a.json')).ok, false);
  const [x, y] = await Promise.all([f('data/a.json'), f('data/a.json')]);
  assert.equal(x.text, 'ok');
  assert.equal(y.text, 'ok');
  assert.equal(n, 2);
});

test('resolveRef: a sha is itself; a branch is one GET of git/ref/heads/<branch> -> object.sha', async () => {
  const body = JSON.parse(fixture('ref-heads-main.json'));
  const calls = [];
  const client = { get: async (p, opts) => { calls.push([p, opts]); return { ok: true, status: 200, data: body }; } };
  const sha = 'd'.repeat(40);
  assert.equal(await C.resolveRef(client, sha), sha);
  assert.equal(calls.length, 0);
  assert.equal(await C.resolveRef(client, 'main'), body.object.sha);
  assert.equal(calls[0][0], '/repos/desert-mango/hippocampus-docs/git/ref/heads/main');
  await C.resolveRef(client, 'cms/some-login/fix-typo');
  assert.equal(calls[1][0], '/repos/desert-mango/hippocampus-docs/git/ref/heads/cms/some-login/fix-typo');
  const bad = { get: async () => ({ ok: false, status: 404, data: null }) };
  await assert.rejects(C.resolveRef(bad, 'main'), (e) => e.status === 404);
  const junk = { get: async () => ({ ok: true, status: 200, data: { object: { sha: 'nope' } } }) };
  await assert.rejects(C.resolveRef(junk, 'main'));
  await assert.rejects(C.resolveRef(client, '../x'));
});

// --------------------------------------------- view settings + members --

function memStorage(init) {
  const m = new Map(Object.entries(init || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    dump: () => Object.fromEntries(m),
  };
}

test('viewSettings: defaults, a round trip, bad values fall back one by one, a throwing storage is survived', () => {
  const V = C.viewSettings;
  assert.equal(V.KEY, 'hc-editor-view');
  assert.deepEqual(V.DEFAULTS, { suggestions: true, diff: 'inline', compact: false, outlines: true });
  const s = memStorage();
  assert.deepEqual(V.load(s), V.DEFAULTS);
  assert.equal(V.save(s, { suggestions: false, diff: 'side', compact: true, outlines: false }), true);
  assert.deepEqual(V.load(s), { suggestions: false, diff: 'side', compact: true, outlines: false });
  const odd = memStorage({ 'hc-editor-view': JSON.stringify({ suggestions: 'false', diff: 'split', compact: 1, outlines: false, x: 1 }) });
  assert.deepEqual(V.load(odd), { suggestions: true, diff: 'inline', compact: false, outlines: false });
  assert.deepEqual(V.load(memStorage({ 'hc-editor-view': '{not json' })), V.DEFAULTS);
  const boom = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.deepEqual(V.load(boom), V.DEFAULTS);
  assert.equal(V.save(boom, V.DEFAULTS), false);
  assert.deepEqual(V.load(null), V.DEFAULTS);
});

test('membersOnly: Admin, Maintainer and Editor (push: true); Read-only and junk are not members', () => {
  assert.equal(C.membersOnly(C.roleFromPermissions({ admin: true })), true);
  assert.equal(C.membersOnly(C.roleFromPermissions({ maintain: true })), true);
  assert.equal(C.membersOnly(C.roleFromPermissions({ push: true })), true);
  assert.equal(C.membersOnly(C.roleFromPermissions({ push: 'true' })), false);
  assert.equal(C.membersOnly(C.roleFromPermissions({ pull: true })), false);
  assert.equal(C.membersOnly(null), false);
  assert.equal(C.membersOnly({ key: 'push', canPush: 'yes' }), false);
  assert.equal(C.membersOnly({ key: 'owner', canPush: true }), false);
});

// ------------------------------------------------------------ snippets --

test('SNIPPET_CATALOG: the picker catalog, each in the site dialect (sanitizer classes only, no script-capable markup)', () => {
  assert.deepEqual(Object.keys(C.SNIPPET_CATALOG), ['note', 'warning', 'tabs', 'image', 'attention', 'video', 'repo']);
  for (const k of Object.keys(C.SNIPPETS)) assert.equal(C.SNIPPET_CATALOG[k], C.SNIPPETS[k], `${k}: the same entry as /cms/'s`);
  for (const k of Object.keys(C.SNIPPET_CATALOG)) assert.equal(typeof C.SNIPPET_CATALOG[k].label, 'string');
  const ins = C.insertSnippet('Text.', 5, 5, 'attention');
  assert.equal(ins.text.slice(ins.selStart, ins.selEnd), C.SNIPPET_CATALOG.attention.placeholder);
  const allowedClass = /^(adm|adm-(note|warning|attention|tip|hint|important|seealso|todo)|adm-title|tabs|tab|img-grid)$/;
  for (const [k, sn] of Object.entries(C.SNIPPET_CATALOG)) {
    const text = sn.before + sn.placeholder + sn.after;
    for (const m of text.matchAll(/class="([^"]*)"/g)) {
      for (const cls of m[1].split(/\s+/)) assert.match(cls, allowedClass, `${k}: class ${cls}`);
    }
    assert.ok(!/<(script|iframe|video|style|object|embed)\b|\son\w+=|javascript:/i.test(text), `${k}: no script-capable markup`);
    assert.ok(!/res\.cloudinary\.com/.test(text), `${k}: no Cloudinary address the manifest does not hold`);
    // a snippet inserted alone is one block (or one image/paragraph) of the page
    const page = C.insertAt('# T\n\nText.\n', 1, k).text;
    assert.equal(C.splitBlocks(page).ok, true, `${k}: the page still splits`);
  }
  assert.ok(C.SNIPPET_CATALOG.image.media, 'the image snippet asks the Media tab for its address');
});
