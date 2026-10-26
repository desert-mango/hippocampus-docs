// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 26 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test the U4 typing work on the editor's parent side: toolbar, comments, marks restored after a reload.
/* Made by U0 (editor UI/UX build) so unit U4 adds its tests here, not to a shared test file.
   The parent side of U4: notes (Comment, D8) in the draft, marks and history kept beside the draft under their own
   key (D6), the "+" Image tile's site images (D11), HCCore.validDraft's new fields.

     node --test tools/tests/test_editor_u4.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { settle, openSite, memoryStorage } from './editor_harness.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const C = require(path.join(ROOT, 'js', 'cms-core.js'));
const readRepo = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PAGE_ROUTE = '/setup/hippocampus-bringup/fcu-firmware';
const PAGE_FILE = 'content/setup/hippocampus-bringup/fcu-firmware.md';

async function on(route, local) {
  const page = openSite({ hash: `#${route}`, storage: memoryStorage(), localStorage: local || memoryStorage(), textEncoder: true });
  await settle();
  page.switchBtn().click();
  await settle();
  await page.send({ type: 'hc-ready' });
  return page;
}
// HCCore.validDraft is reached through the store's put, which refuses what it refuses
const validDraft = (d) => { try { C.createDraftStore(memoryStorage(), 'hc-test').put(d); return true; } catch (e) { return false; } };
const draftsOf = (page) => C.createDraftStore(page.local, C.draftsKey(page.login));
const plainJSON = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));   // the vm realm's objects, compared as data
const lastEditor = (page) => plainJSON(page.frame().posted.filter((x) => x.m.type === 'hc-editor').map((x) => x.m).at(-1));
const paragraphs = () => {
  const text = readRepo(PAGE_FILE);
  const s = C.splitBlocks(text);
  return s.blocks.map((b, i) => ({ i, b, md: text.slice(b.start, b.end) })).filter((x) => x.b.kind === 'paragraph');
};
async function typeIn(page, index, md) {
  await page.send({ type: 'hc-block-select', index });
  await page.send({ type: 'hc-block-state', index, editor: 'visual' });
  await page.send({ type: 'hc-block-md', index, md });
}
const marksEntry = (page) => {
  const keys = [];
  for (let i = 0; i < page.local.length; i += 1) keys.push(page.local.key(i));
  const k = keys.find((x) => x.indexOf(`hc-cms-marks:${page.login}/`) === 0);
  return k ? { key: k, value: JSON.parse(page.local.getItem(k)) } : null;
};

test('D6 the marks live under their own key per page, never in the draft; a new tab gets them back with both texts', async () => {
  const local = memoryStorage();
  const page = await on(PAGE_ROUTE, local);
  const [p] = paragraphs();
  await typeIn(page, p.i, 'The new words.\n\n');
  const html = '<p><del data-hc-sug="del" data-hc-id="s1" class="hc-sug hc-sug-del">old</del><ins data-hc-sug="ins" data-hc-id="s2" class="hc-sug hc-sug-ins">The new words.</ins></p>';
  await page.send({ type: 'hc-marks', index: p.i, html });
  const kept = marksEntry(page);
  assert.ok(kept, 'kept under hc-cms-marks:<login>/<page>');
  assert.match(kept.key, /^hc-cms-marks:bob\//);
  assert.deepEqual(Object.values(kept.value.marks), [html]);
  assert.match(Object.keys(kept.value.marks)[0], /^o:[0-9a-f]{8}:0$/, 'keyed by the hash of the block\'s original text and its occurrence');
  const d = draftsOf(page).list()[0];
  assert.equal('marks' in d || 'history' in d, false, 'never inside the draft record');
  // a new tab (the same browser): the frame is sent the marks once, with the draft's and the base's text
  const page2 = await on(PAGE_ROUTE, local);
  const m = plainJSON(page2.editorMessages().map((x) => x.marks).find((x) => Array.isArray(x) && x.length));
  assert.deepEqual(m, [{ index: p.i, html, md: 'The new words.', orig: p.md, kind: 'paragraph' }], 'the block\'s own text (its blank lines are the gap)');
  assert.equal(page2.editorMessages().filter((x) => Array.isArray(x.marks) && x.marks.length).length, 1, 'once per frame load');
  // marks '' (no mark left): the entry goes
  await typeIn(page2, p.i, 'The new words.\n\n');
  await page2.send({ type: 'hc-marks', index: p.i, html: '' });
  assert.deepEqual(Object.keys((marksEntry(page2) || { value: { marks: {} } }).value.marks), []);
});

test('D6 (ED31) the undo history survives a reload: the new tab undoes the typed step', async () => {
  const local = memoryStorage();
  const page = await on(PAGE_ROUTE, local);
  const [p] = paragraphs();
  await typeIn(page, p.i, 'Typed before the reload.\n\n');
  const kept = marksEntry(page);
  assert.ok(kept && kept.value.history && kept.value.history.undo.length === 1, 'one step kept');
  const page2 = await on(PAGE_ROUTE, local);
  assert.ok(draftsOf(page2).list()[0].files[PAGE_FILE].indexOf('Typed before the reload.') >= 0);
  await page2.send({ type: 'hc-key', op: 'undo' });
  const d = draftsOf(page2).list()[0];
  assert.ok(!d || d.files[PAGE_FILE] === readRepo(PAGE_FILE), 'undone: the page is back to its original text');
  // a kept history that does not end at the draft's text is dropped, never applied
  const k = marksEntry(page2);
  if (k) {
    k.value.history = { last: 'something else', undo: [{ text: 'x', index: 0, span: null }], redo: [] };
    local.setItem(k.key, JSON.stringify(k.value));
  }
  const page3 = await on(PAGE_ROUTE, local);
  await page3.send({ type: 'hc-key', op: 'undo' });
  assert.equal(draftsOf(page3).list().every((x) => x.files[PAGE_FILE] !== 'x'), true);
});

test('D8 (ED18) Comment: a note keyed by the block, in the draft, shown back beside it; "" removes it; no text changes', async () => {
  const page = await on(PAGE_ROUTE);
  const [, p] = paragraphs();
  await page.send({ type: 'hc-note', index: p.i, text: '  Please check this step.  ' });
  await settle();
  const d = draftsOf(page).list()[0];
  assert.ok(d, 'a notes-only draft is kept');
  assert.equal(d.files[PAGE_FILE], d.originals[PAGE_FILE], 'the text is unchanged');
  const key = await C.editKey(PAGE_FILE, p.md, p.md);
  assert.deepEqual(plainJSON(d.notes), [{ key, text: 'Please check this step.' }]);
  assert.equal(page.win.HCEditor.helpers.noteKey.length, 3);
  assert.equal(await page.win.HCEditor.helpers.noteKey(PAGE_FILE, p.md, p.md), key, 'HCEditor.helpers.noteKey is the rule');
  assert.ok(validDraft(d));
  await settle();
  const shown = plainJSON(page.editorMessages().map((x) => x.notes).filter((x) => Array.isArray(x) && x.length).at(-1));
  assert.deepEqual(shown, [{ index: p.i, text: 'Please check this step.' }]);
  await page.send({ type: 'hc-note', index: p.i, text: '' });
  await settle();
  const after = draftsOf(page).list()[0];
  assert.ok(!after || !after.notes, 'removed (and a draft with nothing left is gone)');
});

test('D11 the Image tile\'s "Pick one the site has": the parent answers with the site\'s images; only one of those is put in', async () => {
  const page = await on(PAGE_ROUTE);
  await page.send({ type: 'hc-media-list' });
  await settle();
  const media = lastEditor(page).media;
  assert.ok(Array.isArray(media) && media.length > 0, 'the site\'s images');
  assert.ok(media.every((a) => /^https:\/\/res\.cloudinary\.com\//.test(a.url) && typeof a.label === 'string'));
  const [p] = paragraphs();
  await page.send({ type: 'hc-image-use', index: p.i, url: 'https://res.cloudinary.com/evil/image/upload/x.png' });
  assert.equal(draftsOf(page).list().length, 0, 'an address the parent did not offer: nothing');
  await page.send({ type: 'hc-image-use', index: p.i, url: media[0].url });
  const d = draftsOf(page).list()[0];
  assert.ok(d && d.files[PAGE_FILE].indexOf(`](${media[0].url})`) >= 0, 'the image is in the page');
  assert.equal(page.opens.length, 0, 'no file chooser for a picked image');
});

test('HCCore.validDraft (through the draft store): notes a list; marks an object; history {undo, redo} lists; anything else refused', () => {
  const d = { key: 'setup/a', files: { 'a.md': 'x' }, originals: { 'a.md': 'y' }, base: { ref: 'main', sha: '1'.repeat(40), number: null } };
  assert.ok(validDraft(d));
  assert.ok(validDraft(Object.assign({}, d, { notes: [{ key: 'a'.repeat(64), text: 'n' }] })));
  assert.ok(validDraft(Object.assign({}, d, { marks: {}, history: { undo: [], redo: [] } })));
  for (const bad of [{ notes: 'x' }, { notes: {} }, { marks: [] }, { marks: 'x' }, { history: { undo: [] } }, { history: [] }]) {
    assert.equal(validDraft(Object.assign({}, d, bad)), false, JSON.stringify(bad));
  }
});

// ------------------------------------- fix round 1: the 256 KB cap, a full browser store, Remove's undo --

/* A localStorage whose writes under hc-cms-marks: go through `refuse(key, value)`: true throws a quota error.
   Every write it is asked for is kept in `tried` ({key, value}), refused or not. */
function guardedStorage(refuse) {
  const st = memoryStorage();
  const tried = [];
  st.setItem = (k, v) => {
    const s = String(v);
    if (String(k).indexOf('hc-cms-marks:') === 0) {
      tried.push({ key: k, value: s });
      if (refuse(k, s)) { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; }
    }
    st.raw.set(k, s);
  };
  st.tried = tried;
  return st;
}
const marked = (words) => `<p><ins data-hc-sug="ins" data-hc-id="s1" class="hc-sug hc-sug-ins">${words}</ins></p>`;

test('D6 a browser store that refuses every marks write: typing, undo and the draft still work', async () => {
  const local = guardedStorage(() => true);
  const page = await on(PAGE_ROUTE, local);
  const [p] = paragraphs();
  await typeIn(page, p.i, 'Typed into a full store.\n\n');
  await page.send({ type: 'hc-marks', index: p.i, html: marked('Typed into a full store.') });
  assert.ok(local.tried.length >= 2, 'the history and the marks were both tried (and refused)');
  assert.equal(marksEntry(page), null, 'nothing kept beside the draft');
  const d = draftsOf(page).list()[0];
  assert.ok(d && d.files[PAGE_FILE].indexOf('Typed into a full store.') >= 0, 'the draft is written under its own key');
  await page.send({ type: 'hc-key', op: 'undo' });
  const after = draftsOf(page).list()[0];
  assert.ok(!after || after.files[PAGE_FILE] === readRepo(PAGE_FILE), 'undo still works in this tab');
  await page.send({ type: 'hc-key', op: 'redo' });
  assert.ok(draftsOf(page).list()[0].files[PAGE_FILE].indexOf('Typed into a full store.') >= 0, 'and redo');
});

test('D6 a write too large for the store: the history is dropped first, the marks are kept', async () => {
  // a store with room for the marks but not for the history (each history step holds the whole page's text)
  const local = guardedStorage((k, v) => v.length > 1500);
  const page = await on(PAGE_ROUTE, local);
  const [p, q] = paragraphs();
  const html = marked('Kept words.');
  await typeIn(page, p.i, 'Kept words.\n\n');
  await page.send({ type: 'hc-marks', index: p.i, html });
  await typeIn(page, q.i, 'More words.\n\n');               // a new step: its history write is too large
  const refused = local.tried.filter((t) => t.value.length > 1500);
  assert.ok(refused.length > 0 && refused.every((t) => JSON.parse(t.value).history), 'the too-large writes carried the history');
  const last = JSON.parse(local.tried.at(-1).value);
  assert.equal(last.history, null, 'the write that fit dropped the history');
  assert.deepEqual(Object.values(last.marks), [html], 'and kept the marks');
  assert.deepEqual(Object.values(marksEntry(page).value.marks), [html]);
  assert.ok(draftsOf(page).list()[0].files[PAGE_FILE].indexOf('More words.') >= 0, 'the draft has the newest text');
});

test('D6 marks over 256 KB are not kept; the draft is untouched', async () => {
  const local = memoryStorage();
  const page = await on(PAGE_ROUTE, local);
  const [p, q] = paragraphs();
  const big = (w) => marked(w + ' ' + 'x'.repeat(150 * 1024));   // each under the per-block limit; the two over the cap
  await typeIn(page, p.i, 'First.\n\n');
  await page.send({ type: 'hc-marks', index: p.i, html: big('First.') });
  assert.equal(Object.keys(marksEntry(page).value.marks).length, 1, 'one block\'s marks fit');
  await typeIn(page, q.i, 'Second.\n\n');
  await page.send({ type: 'hc-marks', index: q.i, html: big('Second.') });
  const k = marksEntry(page);
  assert.ok(!k || JSON.stringify(k.value).length <= 256 * 1024, 'never more than the cap');
  assert.ok(!k || Object.keys(k.value.marks).length < 2, 'the two blocks\' marks are not kept');
  const d = draftsOf(page).list()[0];
  assert.ok(d.files[PAGE_FILE].indexOf('First.') >= 0 && d.files[PAGE_FILE].indexOf('Second.') >= 0, 'the draft has both texts');
});

test('D9 (ED32) a box removed from its menu (md \'\') is its own undo step: Undo brings the box back', async () => {
  const page = await on(PAGE_ROUTE);
  const text = readRepo(PAGE_FILE);
  const s = C.splitBlocks(text);
  const i = s.blocks.findIndex((b) => text.slice(b.start, b.end).indexOf('<div class="adm') === 0);
  assert.ok(i >= 0, 'the page has a note box');
  const box = text.slice(s.blocks[i].start, s.blocks[i].end);
  const [p] = paragraphs();
  await typeIn(page, p.i, 'Typed first.\n\n');               // a typing burst before the removal
  await page.send({ type: 'hc-block-select', index: i });
  await page.send({ type: 'hc-block-state', index: i, editor: 'box' });
  const typed = box.replace('Add instructions', 'Typed in the box. Add instructions');
  assert.notEqual(typed, box);
  await page.send({ type: 'hc-block-md', index: i, md: typed });   // typing in the box, then Remove in the same burst
  await page.send({ type: 'hc-block-md', index: i, md: '' });
  const d = draftsOf(page).list()[0];
  assert.ok(d && d.files[PAGE_FILE].indexOf(box) < 0, 'removed from the draft');
  await page.send({ type: 'hc-key', op: 'undo' });
  const after = draftsOf(page).list()[0];
  assert.ok(after && after.files[PAGE_FILE].indexOf(typed.trimEnd()) >= 0, 'the box is back, with the words typed into it');
  assert.ok(after.files[PAGE_FILE].indexOf('Typed first.') >= 0, 'one undo took back the removal only, not the typing before it');
});

test('D8 (m4) a draft whose notes hold a null item: Comment still works and the bad item is dropped', async () => {
  const local = memoryStorage();
  const page = await on(PAGE_ROUTE, local);
  const [p] = paragraphs();
  await typeIn(page, p.i, 'Some words.\n\n');
  const st = draftsOf(page);
  const d = st.list()[0];
  d.notes = [null, { key: 'b'.repeat(64), text: 'kept' }];
  st.put(d);
  const page2 = await on(PAGE_ROUTE, local);
  await page2.send({ type: 'hc-note', index: p.i, text: 'A note.' });
  await settle();
  const notes = plainJSON(draftsOf(page2).list()[0].notes);
  assert.equal(notes.length, 2, 'the good note and the new one');
  assert.ok(notes.every((n) => n && typeof n.key === 'string'), 'no null item left');
  assert.ok(notes.some((n) => n.text === 'A note.'));
});

test('D6 (ED31) a typing burst of several edits: the kept history ends at the newest text, so a reload keeps it', async () => {
  const local = memoryStorage();
  const page = await on(PAGE_ROUTE, local);
  const [p] = paragraphs();
  await typeIn(page, p.i, 'One.\n\n');
  await page.send({ type: 'hc-block-md', index: p.i, md: 'One two.\n\n' });     // the same burst
  await page.send({ type: 'hc-block-md', index: p.i, md: 'One two three.\n\n' });
  const draft = draftsOf(page).list()[0].files[PAGE_FILE];
  assert.equal(marksEntry(page).value.history.last, draft, 'the kept history ends at the draft\'s text');
  const page2 = await on(PAGE_ROUTE, local);
  await page2.send({ type: 'hc-key', op: 'undo' });
  const d = draftsOf(page2).list()[0];
  assert.ok(!d || d.files[PAGE_FILE] === readRepo(PAGE_FILE), 'the new tab undoes the whole burst');
});
