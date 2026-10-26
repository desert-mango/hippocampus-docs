// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 26 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test the U7 layout work: a still page when Editor turns on, the instant switch, header word, Contents.
/* Made by U0 (editor UI/UX build) so unit U7 adds its tests here, not to a shared test file.

   Plan D12 (ED3, ED22, ED23, ED36, ED59, ED60):
     - switch-on is instant: the frame's src is set at once, before the open proposals are read; the
       proposal's marks reach the frame by a LATER hc-editor once they are in; the page the reader sees
       (#content) is hidden only after the frame's SECOND hc-ready (its first paint), never before;
     - the frame side posts that second hc-ready once: Editor mode applied, css/editor.css in, the page drawn;
     - the layout rules: the frame keeps the site's own column (no 52rem centring), the review rail is an
       overlay (no layout column, no dark band), no Contents button in Editor mode, "HippoCampus Editor" at
       every width.
   The geometry itself (equal within 1 px) is a browser check: tools/tests/editor_walk.html step on-geometry.

     node --test tools/tests/test_editor_layout.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { openSite, settle } from './editor_harness.mjs';
import { setupPage, fakeHC, fakeWin, makeDoc, el, kids } from './frame_harness.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const C = require(path.join(ROOT, 'js', 'cms-core.js'));
const EF = require(path.join(ROOT, 'js', 'editor-frame.js'));
const { createFakeGitHub } = require(path.join(ROOT, 'tools', 'tests', 'fake_github.js'));
const FIXTURES = path.join(ROOT, 'tools', 'tests', 'fixtures', 'github-data');
const readRepo = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PAGE_ROUTE = '/setup/hippocampus-bringup/fcu-firmware';
const UBUNTU_ROUTE = '/setup/raspberry-pi/ubuntu-24-04-server';        // PR #1 (a U0 fixture) touches this page
const UBUNTU_FILE = 'content/setup/raspberry-pi/ubuntu-24-04-server.md';
const OPEN_PULLS = /\/pulls\?state=open/;

async function on(opts) {
  const page = openSite(Object.assign({ hash: `#${PAGE_ROUTE}` }, opts));
  await settle();
  page.switchBtn().click();
  await settle();
  return page;
}
const live = (page) => page.body.classList.contains('hc-frame-live');

/* The open proposals held back: the fake GitHub's answer is given only on release(). */
function heldPulls() {
  const fake = createFakeGitHub({
    readFixture: async (name) => { try { return fs.readFileSync(path.join(FIXTURES, name), 'utf8'); } catch (e) { return null; } },
    readFile: async (p) => { try { return readRepo(p); } catch (e) { return null; } },
  });
  let release = null;
  let wanted = null;
  const held = new Promise((r) => { release = r; });
  return {
    intercept: (url, init) => {
      if (!OPEN_PULLS.test(url)) return null;
      if (!wanted) wanted = { url, init };
      return held;
    },
    asked: () => wanted !== null,
    release: () => release(fake.fetch(wanted.url, wanted.init)),
  };
}

// ------------------------------------------------- the instant switch ---

test('load order (1/2): with the open proposals still unread, the frame is already loading the page', async () => {
  const pulls = heldPulls();
  const page = await on({ hash: `#${UBUNTU_ROUTE}`, intercept: pulls.intercept });
  assert.ok(pulls.asked(), 'the open proposals were asked for');
  assert.ok(page.frame(), 'the frame is mounted');
  assert.equal(page.frame().srcs.length, 1, 'its src is set at once: the frame boots while GitHub answers');
  assert.match(page.frame().srcs[0], new RegExp(`route=${encodeURIComponent(UBUNTU_ROUTE)}$`));
  await page.send({ type: 'hc-ready' });
  const first = page.editorMessages();
  assert.equal(first.length, 1, 'hc-ready is answered at once');
  assert.deepEqual([...first[0].overlay], [], 'no marks yet: the proposals are not in');
});

test('load order (2/2): once the open proposals are in, the marks arrive by a LATER hc-editor, on the same load', async () => {
  const pulls = heldPulls();
  const page = await on({ hash: `#${UBUNTU_ROUTE}`, intercept: pulls.intercept, variant: 'admin' });   // U3 (ED11): an approver
  const nonce = page.nonce();
  await page.send({ type: 'hc-ready' });
  // the page file waits for the proposals (it is drawn ONCE, with them); the frame asks it meanwhile
  const id = 4242;
  await page.send({ type: 'hc-fetch', id, path: UBUNTU_FILE });
  const answer = () => page.frame().posted.find((x) => x.m.type === 'hc-file' && x.m.id === id);
  assert.equal(answer(), undefined, 'the page text is held until the proposals are known');
  const before = page.editorMessages().length;
  pulls.release();
  await settle();
  assert.equal(page.nonce(), nonce, 'the same load: the frame was not reloaded for the proposals');
  assert.equal(page.frame().srcs.length, 1);
  const after = page.editorMessages();
  assert.ok(after.length > before, 'a later hc-editor');
  const marks = [...after.at(-1).overlay];
  assert.ok(marks.length > 0, 'it carries the proposal\'s marks');
  const served = answer();
  assert.ok(served && served.m.ok, 'the page text came once the proposals were in');
  assert.match(served.m.text, new RegExp(`<div id="hcb-${nonce.slice(0, 16)}-`), 'with this load\'s sentinels');
});

test('a draft of the page needs no proposals: its text is served at once, the proposals still unread', async () => {
  const pulls = heldPulls();
  const page = await on({ hash: `#${PAGE_ROUTE}`, intercept: pulls.intercept });
  await page.send({ type: 'hc-ready' });
  const PAGE_FILE = 'content/setup/hippocampus-bringup/fcu-firmware.md';
  const i = C.splitBlocks(readRepo(PAGE_FILE)).blocks.findIndex((b) => b.kind === 'paragraph');
  await page.pick(i);
  await page.typeIn(i, 'A draft paragraph.\n\n');
  await page.send({ type: 'hc-key', op: 'redraw' });       // the page drawn again from the draft (a new load)
  const served = await page.asks(PAGE_FILE);
  assert.ok(served && served.ok, 'served without waiting for the proposals');
  assert.ok(served.text.includes('A draft paragraph.'));
});

test('the page the reader sees stays until the frame\'s first paint (its second hc-ready), then they swap', async () => {
  const page = await on();
  assert.ok(page.body.classList.contains('hc-editor-on'), 'Editor mode is on at once (header word, bubble)');
  assert.equal(page.host.hidden, false, 'the frame host is in the page (laid out unseen, so the frame paints)');
  assert.equal(live(page), false, '#content is still the one on screen');
  await page.send({ type: 'hc-ready' });
  assert.equal(live(page), false, 'the frame booted, but has not drawn the page yet');
  await page.send({ type: 'hc-ready' });
  assert.equal(live(page), true, 'drawn: the frame takes #content\'s place');
  // a reload inside Editor mode keeps the frame on screen; Editor off undoes the swap
  await page.go(`#/setup/lab-gantry/usage`);
  assert.equal(live(page), true);
  page.switchBtn().click();
  await settle();
  assert.equal(live(page), false);
  assert.equal(page.body.classList.contains('hc-editor-on'), false);
});

// Guard (passes on base too, by design): the swap must key on THIS load's nonce; a stale or forged hc-ready
// arriving between the handshake and the paint would otherwise blank the page before the frame drew it.
test('an hc-ready of another load never swaps the page', async () => {
  const page = await on();
  await page.send({ type: 'hc-ready' });
  await page.send({ type: 'hc-ready', nonce: 'f'.repeat(32) });
  assert.equal(live(page), false);
});

test('the host carries the window\'s scrollbar width (--hc-sb) for the frame\'s own scrollbar to sit in the page\'s padding', async () => {
  const page = openSite({ hash: `#${PAGE_ROUTE}` });
  await settle();
  const set = {};
  page.host.style.setProperty = (k, v) => { set[k] = v; };
  page.switchBtn().click();
  await settle();
  assert.ok(page.frame(), 'the frame is mounted');
  // the fake DOM has no layout: a probe measures nothing, so 0 px (overlay scrollbars measure 0 too)
  assert.equal(set['--hc-sb'], '0px');
});

// ----------------------------------------------- the frame's first paint ---

function linkOf(doc) {
  return kids(doc.head).find((c) => c.tagName === 'LINK');
}

test('frame: the second hc-ready comes once, after Editor mode is applied, css/editor.css is in and the page is drawn', () => {
  const { doc } = setupPage();
  const HC = fakeHC();
  EF.create(fakeWin(), doc, HC);
  assert.deepEqual(HC.posts.map((p) => p.type), ['hc-ready'], 'the handshake only');
  HC.send({ on: true });
  assert.equal(HC.posts.filter((p) => p.type === 'hc-ready').length, 1, 'the style sheet is still loading');
  const link = linkOf(doc);
  assert.ok(link && typeof link.onload === 'function', 'css/editor.css is added with a load handler');
  link.onload();
  assert.equal(HC.posts.filter((p) => p.type === 'hc-ready').length, 2, 'painted');
  HC.send({ on: true, selected: 2 });
  link.onload();
  assert.equal(HC.posts.filter((p) => p.type === 'hc-ready').length, 2, 'once per load');
});

test('frame: an empty #content (the page still loading) is not a paint; the page arriving is', () => {
  const doc = makeDoc();
  const content = el(doc, 'main', { id: 'content', class: 'content' }, el(doc, 'noscript', null, 'JavaScript required'));
  doc.body.appendChild(content);
  const HC = fakeHC();
  const F = EF.create(fakeWin(), doc, HC);
  HC.send({ on: true });
  linkOf(doc).onerror();                                    // a style sheet that failed still ends the wait
  assert.equal(HC.posts.filter((p) => p.type === 'hc-ready').length, 1, 'nothing drawn yet');
  content.appendChild(el(doc, 'div', { class: 'page-body' }, el(doc, 'h1', null, 'Title')));
  F.apply();                                                // what the #content observer does
  assert.equal(HC.posts.filter((p) => p.type === 'hc-ready').length, 2);
});

// Guard (passes on base too, by design): the paint signal must stay silent while Editor is off, or the parent
// would count a stray second hc-ready and swap a frame that shows the page without Editor mode.
test('frame: Editor off is no paint signal', () => {
  const { doc } = setupPage();
  const HC = fakeHC();
  EF.create(fakeWin(), doc, HC);
  HC.send({ on: false });
  assert.equal(HC.posts.filter((p) => p.type === 'hc-ready').length, 1);
});

// --------------------------------------------------------- layout rules ---

const EDITOR_CSS = readRepo('css/editor.css');
const SITE_CSS = readRepo('css/site.css');
const section = (css, from, to) => css.slice(css.indexOf(from), to ? css.indexOf(to, css.indexOf(from) + from.length) : undefined);
const U7_SECTION = section(EDITOR_CSS, '/* ==== frame layout (U7) ==== */', '/* ==== ');
const U7_OVERRIDE = section(EDITOR_CSS, '/* ==== override: U7 ==== */', '/* ==== override: U2 ==== */');
const squash = (s) => s.replace(/\s+/g, ' ');

/* The page's own padding tokens (css/site.css): .content above 900 px and in the 900 px block. */
const remOf = (v) => {
  // "2.2rem", "calc(3rem - 1.2rem)", "calc(3rem - 1.2rem - var(--hc-sb))" (the scrollbar counts 0 here)
  if (v.trim() === '0') return 0;
  const s = v.trim().replace(/^calc\((.*)\)$/, '$1').replace(/var\(--hc-sb(, 0px)?\)/g, '0rem');
  const terms = s.match(/[+-]?\s*-?[\d.]+rem/g);
  assert.ok(terms && terms.join('').replace(/\s/g, '') === s.replace(/\s/g, ''), `a rem sum: ${v}`);
  return terms.reduce((a, t) => a + Number(t.replace(/\s|rem/g, '')), 0);
};
const padOf = (decl) => {
  const parts = [''];                                       // split on spaces outside calc()
  let depth = 0;
  for (const ch of decl.trim()) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (/\s/.test(ch) && !depth) { if (parts[parts.length - 1]) parts.push(''); } else parts[parts.length - 1] += ch;
  }
  const [t, r = t, b = t, l = r] = parts.map(remOf);
  return { t, r, b, l };
};
const ruleIn = (css, re, what) => { const m = re.exec(squash(css)); assert.ok(m, what); return m[1]; };
const mediaBlock = (css, q) => {
  const at = squash(css).indexOf(`@media (${q}) {`);
  assert.ok(at >= 0, `@media (${q})`);
  const s = squash(css).slice(at);
  let depth = 0;
  for (let i = s.indexOf('{'); i < s.length; i += 1) {
    if (s[i] === '{') depth += 1;
    if (s[i] === '}') { depth -= 1; if (!depth) return s.slice(0, i + 1); }
  }
  return s;
};
const PAGE = padOf(ruleIn(section(SITE_CSS, '/* ---------- layout ---------- */', '/* ---- owner boundary'),
  /\.content \{ padding: ([^;]+); min-width: 0; \}/, 'the page\'s .content padding'));
const PAGE_NARROW = padOf(ruleIn(SITE_CSS.slice(SITE_CSS.indexOf('@media (max-width: 900px) {\n  .layout { width: 100%;')),
  /\.content \{ padding: ([^;]+); \}/, 'the page\'s .content padding at 900 px and below'));
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);

// Review round 1, MAJOR 1: the frame is exactly the slot's width, never wider and clipped
test('css: the frame is exactly #content\'s slot (100 %), in a row that clips and is never scrolled by code', () => {
  const u7 = squash(U7_SECTION);
  const o = squash(U7_OVERRIDE);
  assert.doesNotMatch(squash(U7_SECTION + U7_OVERRIDE), /width: 100vw|-17rem/, 'no window-wide frame shifted under its slot');
  for (const css of [u7, o]) {
    assert.match(css, /\.hc-frame-row > \.hc-frame \{[^}]*width: 100%;/, 'the frame is as wide as the slot');
    assert.match(css, /\.hc-frame-row \{[^}]*overflow: clip;/, 'clip: no scroll container, so focus or scrollIntoView never slides it');
    assert.doesNotMatch(css, /\.hc-frame-row \{[^}]*overflow: hidden/);
  }
  assert.match(u7, /\.hc-frame-host \{[^}]*grid-column: -2 \/ -1;/, 'the host is in #content\'s grid column');
  assert.match(u7, /body\.hc-editor-on\.hc-frame-live #content \{ display: none; \}/, '#content goes only once the frame painted');
  assert.doesNotMatch(u7, /body\.hc-editor-on #content \{ display: none; \}/);
  // before the paint the host is laid out in that same column (its final width), unseen, out of the flow
  assert.match(u7, /body\.hc-editor-on \.layout \{ position: relative; \}/);
  assert.match(u7, /body:not\(\.hc-frame-live\) \.hc-frame-host \{ position: absolute; top: 0; left: 0; right: 0; z-index: -1; opacity: 0; pointer-events: none; \}/);
  assert.doesNotMatch(u7, /position: fixed/, 'not the window\'s width while it boots: it paints at its final width');
  // inside the frame: no sidebar track, the content box is the whole frame
  assert.match(u7, /body\.hc-framed \.site-header, body\.hc-framed \.site-footer, body\.hc-framed \.sidebar,/);
  assert.match(u7, /body\.hc-framed \.layout \{ display: block; width: auto; max-width: none; margin: 0; \}/);
});

// MAJOR 1, "no reflow": the column's place comes from the PARENT's media queries (the page's own tokens), not the frame's
test('css: the frame\'s column sits where the page\'s does, from the page\'s own padding tokens at every width', () => {
  const u7 = squash(U7_SECTION);
  const o = squash(U7_OVERRIDE);
  const FRAMED = padOf(ruleIn(u7, /body\.hc-framed \.content \{ padding: ([^;]+); \}/, 'the frame\'s .content padding'));
  // the override block repeats it unconditionally (an earlier section narrows it under 768 px)
  assert.deepEqual(padOf(ruleIn(o, /body\.hc-framed \.content \{ padding: ([^;]+); \}/, 'override')), FRAMED);
  // the frame's own padding is the page's 900 px sides (a frame as wide as the window there) and its desktop top
  near(FRAMED.l, PAGE_NARROW.l, 'left, at 900 px and below');
  near(FRAMED.r, PAGE_NARROW.r, 'right, at 900 px and below');
  near(FRAMED.t, PAGE.t, 'top, above 900 px');
  // above 900 px the parent's host adds the rest of the page's side padding around the frame
  const wide = mediaBlock(U7_SECTION, 'min-width: 901px');
  const HOST = padOf(ruleIn(wide, /body\.hc-editor-on \.hc-frame-host \{ padding: ([^;]+); \}/, 'the host\'s padding above 900 px'));
  near(HOST.t, 0, 'no band above the frame');
  near(FRAMED.l + HOST.l, PAGE.l, 'left, above 900 px');
  near(FRAMED.r + HOST.r, PAGE.r, 'right, above 900 px (the frame\'s scrollbar, --hc-sb, sits in that padding)');
  assert.match(wide, /padding: 0 calc\(3rem - 1\.2rem - var\(--hc-sb, 0px\)\) 0 calc\(3rem - 1\.2rem\)/);
  // at 900 px and below the host tucks the frame's extra top under the header, and is that much taller
  const narrow = mediaBlock(U7_SECTION, 'max-width: 900px');
  const lift = remOf(ruleIn(narrow, /body\.hc-editor-on \.hc-frame-host \{ margin-top: ([^;]+);/, 'the lift'));
  near(FRAMED.t + lift, PAGE_NARROW.t, 'top, at 900 px and below');
  assert.match(narrow, /height: calc\(100vh - var\(--header-h\) \+ 2\.2rem - 1\.5rem\);/);
});

test('css: Editor mode never moves the page by the window\'s own scrollbar (review minor 4)', () => {
  const u7 = squash(U7_SECTION);
  // above 900 px the window keeps its scrollbar's place, short page or long
  assert.match(mediaBlock(U7_SECTION, 'min-width: 901px'), /html:has\(> body\.hc-editor-on\) \{ overflow-y: scroll; scrollbar-gutter: stable; \}/);
  // at 900 px and below the frame is the window's width: ITS scrollbar is the one at the window's edge
  const narrow = mediaBlock(U7_SECTION, 'max-width: 900px');
  assert.match(narrow, /html:has\(> body\.hc-editor-on\) \{ scrollbar-width: none; \}/);
  // review round 2, minor A: the WebKit twin of scrollbar-width: none is a 900 px rule too; at every width it
  // would hide the window's classic scrollbar above 900 px (Safari), and the slot would move by its width
  assert.match(narrow, /html:has\(> body\.hc-editor-on\)::-webkit-scrollbar \{ width: 0; \}/);
  const outside = u7.replace(narrow, '');
  assert.doesNotMatch(outside, /::-webkit-scrollbar/, 'no WebKit scrollbar rule outside the 900 px block');
  assert.doesNotMatch(u7, /html:has\(> body\.hc-framed\) \{ overflow-y: scroll; \}/, 'the frame scrolls as the page does: only when it must');
});

test('css: the review rail is an overlay in the right gutter, never a layout column or a dark band', () => {
  const o = squash(U7_OVERRIDE);
  assert.match(o, /body\.hc-has-rail \.layout \{ width: 80%; max-width: 110rem; \}/, 'the layout stays where it was');
  assert.match(o, /\.hc-rail \{[^}]*position: absolute;[^}]*left: 100%;[^}]*background: none;[^}]*border-left: 0;/);
  assert.match(o, /\.hc-frame-row \{[^}]*display: block;/);
});

// Review round 1, MAJOR 2: at 768-900 px the markers rail lay past the window's right edge (sideways scroll)
test('css: at 900 px and below the rail lies inside the frame host, at its right edge, never past the window', () => {
  const narrow = '@media (max-width: 900px) { .hc-rail { left: auto; right: 0; } }';
  assert.ok(squash(U7_OVERRIDE).includes(narrow), 'a 900 px rule anchors the rail at the host\'s right edge');
  // it is the last word on the rail's position: nothing later in the override block puts it back
  const after = squash(U7_OVERRIDE).slice(squash(U7_OVERRIDE).indexOf(narrow) + narrow.length);
  assert.doesNotMatch(after, /\.hc-rail[^{]*\{[^}]*left:/);
});

// Review round 2, minor B: at 768-900 px the markers rail (z-index 30) lies over the frame's right edge; only
// its markers and cards take the pointer, the empty strip between them lets clicks and the wheel reach the frame
test('css: the rail\'s empty strip lets the pointer through to the frame; its slots take it', () => {
  const o = squash(U7_OVERRIDE);
  assert.match(o, /\.hc-rail \{[^}]*pointer-events: none;/, 'the rail itself takes no pointer');
  assert.match(o, /\.hc-rslot \{ pointer-events: auto; \}/, 'each slot (marker, card) does');
  const after = o.slice(o.search(/\.hc-rslot \{ pointer-events: auto; \}/));
  assert.doesNotMatch(after, /\.hc-rail[^{]*\{[^}]*pointer-events: auto/, 'nothing later gives the strip the pointer back');
});

// Review round 2, minor C: the unseen host (before the frame's paint) is out of the Tab order and the
// accessibility tree: inert from Editor on until the swap (the paint, or the 8 s fallback); off, it is hidden
test('the frame host is inert until the frame takes #content\'s place', async () => {
  const page = await on();
  assert.equal(page.host.inert, true, 'unseen host: no Tab stop, nothing read out');
  await page.send({ type: 'hc-ready' });
  assert.equal(page.host.inert, true, 'the handshake is not the paint');
  await page.send({ type: 'hc-ready' });
  assert.equal(live(page), true);
  assert.equal(page.host.inert, false, 'on screen: usable');
  await page.go(`#/setup/lab-gantry/usage`);
  assert.equal(page.host.inert, false, 'a later load keeps the frame on screen and usable');
  page.switchBtn().click();
  await settle();
  assert.equal(page.host.hidden, true);
  assert.equal(page.host.inert, false, 'off: hidden, and no inert left behind');
  page.switchBtn().click();
  await settle();
  assert.equal(page.host.inert, true, 'on again: unseen again until this load paints');
});

test('the 8 s fallback that shows a frame which never painted also makes the host usable', async () => {
  let offset = 0;
  const held = [];
  const page = openSite({ hash: `#${PAGE_ROUTE}`, afterScript: (f, win) => {
    if (f !== 'js/marked.min.js') return;
    const RealDate = Date;                       // the vm's own Date is an intrinsic, not a property of win
    win.Date = new Proxy(RealDate, { get: (t, k) => (k === 'now' ? () => RealDate.now() + offset : Reflect.get(t, k)) });
    const run = win.setTimeout;
    win.setTimeout = (fn, ms) => (ms === 8000 ? (held.push(fn), 0) : run(fn, ms));
  } });
  await settle();
  page.switchBtn().click();
  await settle();
  await page.send({ type: 'hc-ready' });
  assert.equal(page.host.inert, true);
  assert.equal(held.length, 1, 'the fallback timer is set');
  offset = 8000;
  held[0]();
  assert.equal(live(page), true, 'the fallback swapped');
  assert.equal(page.host.inert, false, 'and the host is usable');
});

// The orchestrator's walk at 390 px (round 2): on phones the parent's sidebar is the closed drawer off the left
// edge and the frame's is hidden, so neither is on screen; on-geometry compares the sidebar only when it is
test('walk: on-geometry compares the sidebar only when it was on screen before (never the phone drawer)', () => {
  const walk = readRepo('tools/tests/editor_walk.html');
  const step = walk.slice(walk.indexOf("'on-geometry': async () => {"), walk.indexOf('scroll: async () => {'));
  assert.ok(step.length > 100, 'the on-geometry step');
  assert.match(step, /const onScreen = \(n\) =>/, 'an on-screen test of the sidebar');
  assert.match(step, /hc-phone/, 'never the phone layout');
  assert.match(step, /hc-drawer-open/, 'never the closed drawer');
  assert.match(step, /SW\.innerWidth/, 'its box meets the window');
  assert.match(step, /if \(before\.sidebarShown\) near\(before\.sidebar, after\.sidebar, \['left', 'top', 'width', 'height'\], 'sidebar'\);/);
  // every other comparison stays unconditional
  assert.match(step, /\n {8}near\(before\.column, after\.column, \['left', 'top', 'width'\], 'column'\);/);
  assert.match(step, /\n {8}near\(before\.heading, after\.heading, \['left', 'top', 'width'\], 'heading'\);/);
  assert.match(step, /if \(after\.contentShown !== 'none'\)/);
  assert.match(step, /if \(said !== 2\)/);
});

test('css: no Contents button in Editor mode (parent and frame); "HippoCampus Editor" at every width', () => {
  assert.match(squash(SITE_CSS), /body\.hc-editor-on #sidebar-toggle \{ visibility: hidden; pointer-events: none; \}/);
  assert.match(squash(U7_SECTION), /body\.hc-framed \.sidebar-toggle/);
  // the 900 px block hides the soft word for the public header only
  assert.match(squash(SITE_CSS), /\.brand-soft \{ display: none; \} body\.hc-editor-on \.brand-soft \{ display: inline-grid; \}/);
});

/* ---- U7b: the frame knows the window's width ----
   Above 900 px the frame is narrower than the window, so the page's own rules keyed on the WINDOW width
   (.page-nav at 640 px, .quietgrid at 899 px, .hc-cols at 900 px, lab.js's dialogMode at 768 px) would answer
   to the frame's width. The parent sends the window's width in hc-editor; the frame marks <html> with
   data-hc-win (wide > 900, medium 641-900, narrow <= 640) and --hc-win; framed twins keyed on it keep the
   window's layout. The public page never carries data-hc-win, so it is unchanged. */

const widths = (page) => page.editorMessages().map((m) => m.width);

test('U7b: hc-editor carries the window\'s width on load, and again after a resize (debounced)', async () => {
  const page = openSite({ hash: `#${PAGE_ROUTE}` });
  await settle();
  page.win.innerWidth = 1100;
  page.switchBtn().click();
  await settle();
  await page.send({ type: 'hc-ready' });
  assert.equal(page.editorMessages().at(-1).width, 1100, 'the load\'s first hc-editor says the window\'s width');
  const before = page.editorMessages().length;
  page.win.innerWidth = 950;
  for (let i = 0; i < 3; i += 1) for (const fn of page.listeners.resize || []) fn({ type: 'resize' });
  await settle();
  const after = page.editorMessages();
  assert.equal(after.length, before + 1, 'three resizes in a burst: one hc-editor');
  assert.equal(after.at(-1).width, 950);
});

test('U7b: with no number for the window\'s width, hc-editor has no width field', async () => {
  const page = await on();
  await page.send({ type: 'hc-ready' });
  assert.ok(page.editorMessages().length > 0);
  assert.ok(widths(page).every((w) => w === undefined), 'the fake window has no innerWidth');
});

test('U7b: Editor off, a resize sends nothing', async () => {
  const page = await on();
  await page.send({ type: 'hc-ready' });
  const frame = page.frame();
  const count = () => frame.posted.filter((x) => x.m.type === 'hc-editor').length;
  page.switchBtn().click();
  await settle();
  const n = count();
  page.win.innerWidth = 1200;
  for (const fn of page.listeners.resize || []) fn({ type: 'resize' });
  await settle();
  assert.equal(count(), n);
});

function htmlEl(doc) {
  const root = el(doc, 'html');
  const props = {};
  root.style = { props, setProperty: (k, v) => { props[k] = String(v); }, removeProperty: (k) => { delete props[k]; },
    getPropertyValue: (k) => props[k] || '' };
  doc.documentElement = root;
  return root;
}

test('U7b frame: <html> gets data-hc-win and --hc-win from the window\'s width while framed', () => {
  const { doc } = setupPage();
  const root = htmlEl(doc);
  const HC = fakeHC();
  EF.create(fakeWin(), doc, HC);
  const cases = [[1100, 'wide'], [901, 'wide'], [900, 'medium'], [641, 'medium'], [640, 'narrow'], [320, 'narrow']];
  for (const [width, want] of cases) {
    HC.send({ on: true, width });
    assert.equal(root.getAttribute('data-hc-win'), want, `${width} px`);
    assert.equal(root.style.props['--hc-win'], `${width}px`);
  }
  HC.send({ on: true });                                      // no width: nothing to go by
  assert.equal(root.getAttribute('data-hc-win'), null);
  assert.equal(root.style.props['--hc-win'], undefined);
  HC.send({ on: true, width: 1100 });
  HC.send({ on: false, width: 1100 });                        // Editor off: the page answers to its own width
  assert.equal(root.getAttribute('data-hc-win'), null);
  assert.equal(root.style.props['--hc-win'], undefined);
});

test('U7b css: the framed twins restore the window\'s layout, each keyed under html[data-hc-win="wide"]', () => {
  const css = squash(SITE_CSS.replace(/\/\*[\s\S]*?\*\//g, ''));   // the rules, without their comments
  const W = 'html[data-hc-win="wide"]';
  const twin = (sel, decl) => assert.ok(css.includes(`${W} ${sel} { ${decl} }`), `${W} ${sel} { ${decl} }`);
  // each restores the rule its media query changes, to the value it has outside the query
  twin('.page-nav', 'grid-template-columns: 1fr 1fr;');
  twin('.page-nav .page-nav-next', 'grid-column: 2;');
  assert.match(css, /\.page-nav \{ display: grid; grid-template-columns: 1fr 1fr;/);
  assert.match(css, /\.page-nav \.page-nav-next \{ grid-column: 2;/);
  twin('.quietgrid', 'grid-template-columns: repeat(4, minmax(0, 1fr));');
  assert.match(css, /\.quietgrid \{ display: grid; grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
  const cols = 'grid-template-columns: minmax(0, 1.3fr) minmax(16rem, 1fr) minmax(16rem, 1fr);';
  twin('.hc-cols', cols);
  assert.ok(css.includes(`.hc-cols { display: grid; ${cols}`));
  // every rule that names data-hc-win is a twin of one of these (nothing else keys on it)
  const named = css.match(/[^{}]*data-hc-win[^{}]*\{/g) || [];
  assert.equal(named.length, 4, named.join(' | '));
  for (const s of named) assert.ok(s.trim().startsWith(W), s);
  // the twins sit outside every @media block: they apply whatever the frame's own width is
  for (const q of ['max-width: 640px', 'max-width: 899px', 'max-width: 900px']) {
    let at = -1;
    while ((at = css.indexOf(`@media (${q}) {`, at + 1)) >= 0) assert.doesNotMatch(mediaBlock(css.slice(at), q), /data-hc-win/);
  }
});

test('U7b lab: dialogMode reads the window\'s width from the frame\'s --hc-win when framed', () => {
  const { dialogMode } = require(path.join(ROOT, 'js', 'lab.js'));
  const root = (win, px) => ({ getAttribute: (k) => (k === 'data-hc-win' ? win : null),
    style: { getPropertyValue: (k) => (k === '--hc-win' ? px : '') } });
  assert.equal(dialogMode(600, root('wide', '1100px')), 'pop', 'a 600 px frame in an 1100 px window: a popover');
  assert.equal(dialogMode(1100, root('narrow', '400px')), 'sheet');
  assert.equal(dialogMode(600, root(null, '')), 'sheet', 'not framed: its own width');
  assert.equal(dialogMode(600, root('wide', 'x')), 'sheet', 'no number: its own width');
  assert.equal(dialogMode(600, null), 'sheet');
  assert.equal(dialogMode(1280), 'pop', 'no document (node): as before');
});

test('U7b walk: wide-grids compares the Lab activity columns, Editor off and on, at a wide window', () => {
  const walk = readRepo('tools/tests/editor_walk.html');
  const u7 = walk.slice(walk.indexOf('/* ---- U7 ---- */'));
  const step = u7.slice(u7.indexOf("'wide-grids': async () => {"));
  assert.ok(step.length > 100 && u7.indexOf("'wide-grids'") > 0, 'the wide-grids step in the U7 block');
  assert.match(step, /data-walk-grids/);
  assert.match(step, /'wide'/);
  assert.match(step, /\.hc-cols/);
  assert.match(walk, /grids/, 'the frame reports its grids through the test-only hook');
});
