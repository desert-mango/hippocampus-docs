// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 22 September 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test the CMS Media tab: signed uploads, the manifest entry, duplicates, the in-use guard, image insertion.
/* Unit tests for the Media half of js/cms-core.js (U9) and for js/cms.js's
   Media views, run in a vm context over a fake DOM, a fake /api/media, a
   fake Cloudinary and a fake GitHub.

   Pure logic first: the manifest entry (exact keys, in the manifest's own
   order), duplicate detection by sha256, the in-use guard for rename and
   delete, the thumbnail URL, the upload request (exactly the signed params
   plus api_key, signature and the file — never the token), the gateway
   client, and `![alt](url)` at the cursor.

   Then js/cms.js itself: #/media lists the images with thumbnails and a
   next page; an upload from a page's editor goes sign -> Cloudinary ->
   one manifest draft entry -> "Insert into page" -> Propose with both
   files; a duplicate offers the site's URL and uploads nothing; delete of
   an image the site uses is refused with the verbatim line; New person
   takes a photo from Media.

   No browser, no network: every window, frame and fetch is a FAKE, and every
   token below is an obvious placeholder.

     node --test tools/tests/test_cms_media.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const C = require(path.join(ROOT, 'js', 'cms-core.js'));

const readRepo = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const TOKEN = '<yours>-media-token';
const REPO_API = 'https://api.github.com/repos/desert-mango/hippocampus-docs';
const MAIN_SHA = '1'.repeat(40);
const MAIN_TREE = '2'.repeat(40);
const MANIFEST_TEXT = readRepo('data/cloudinary-manifest.json');
const LIVE = JSON.parse(MANIFEST_TEXT);
const CLOUD = LIVE.cloud;
const USED = LIVE.assets[0];
const FREE_ID = 'hippocampus-docs/setup/old-sketch';
const FREE_URL = `https://res.cloudinary.com/${CLOUD}/image/upload/v1790000000/${FREE_ID}.png`;
const TS = '1790000000';
const SIG = 'a'.repeat(64);
const API_KEY = '123456789012345';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const shaOf = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const fakeFile = (bytes, o) => Object.assign({ name: 'Hippo Mark.png', type: 'image/png', size: bytes.length,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }, o || {});

class FakeFormData {
  constructor() { this.entries = []; }
  append(k, v) { this.entries.push([k, v]); }
}

function signed(mode, sub, slug) {
  const s = sub || 'setup';
  const folder = `hippocampus-docs/${s}`;
  const params = mode === 'dynamic'
    ? { asset_folder: folder, overwrite: 'false', public_id: `${folder}/${slug || 'hippo-mark'}`, timestamp: TS }
    : { folder, overwrite: 'false', public_id: slug || 'hippo-mark', timestamp: TS };
  return { cloud_name: CLOUD, api_key: API_KEY, timestamp: Number(TS), signature: SIG, params };
}
const uploaded = (id, bytes) => ({ public_id: id, version: 1790000001, format: 'png', bytes: bytes || 2048,
  secure_url: `https://res.cloudinary.com/${CLOUD}/image/upload/v1790000001/${id}.png` });

function reply(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

// ------------------------------------------------------- pure logic ---

test('thumbnail: c_limit,w_240 goes right after /image/upload/, so the public_id (and the gate\'s match) is unchanged', () => {
  assert.equal(C.thumbUrl(USED.url), USED.url.replace('/image/upload/', '/image/upload/c_limit,w_240/'));
  assert.equal(C.thumbUrl(`https://res.cloudinary.com/${CLOUD}/image/upload/f_auto/v1/hippocampus-docs/x.png`),
    `https://res.cloudinary.com/${CLOUD}/image/upload/c_limit,w_240/f_auto/v1/hippocampus-docs/x.png`);
  for (const bad of ['http://res.cloudinary.com/x/image/upload/a.png', 'https://evil.example/image/upload/a.png',
    'javascript:alert(1)', `https://res.cloudinary.com/${CLOUD}/image/upload/a b.png`, null, 42]) {
    assert.equal(C.thumbUrl(bad), null, String(bad));
  }
  // every image on the site today gets a thumbnail
  for (const a of LIVE.assets) assert.ok(C.thumbUrl(a.url), a.public_id);
});

test('manifest entry: exactly {source: null, folder, public_id, url, bytes, sha256}, in the manifest\'s key order', () => {
  const plan = C.uploadPlan(signed('fixed'), 'setup');
  assert.equal(plan.problem, null);
  const sha = shaOf(PNG);
  const made = C.manifestEntry(uploaded('hippocampus-docs/setup/hippo-mark', 3100), plan, sha);
  assert.equal(made.problem, null);
  assert.deepEqual(Object.keys(made.entry), Object.keys(USED), 'the same keys, in the same order, as today\'s entries');
  assert.deepEqual(made.entry, { source: null, folder: 'hippocampus-docs/setup', public_id: 'hippocampus-docs/setup/hippo-mark',
    url: `https://res.cloudinary.com/${CLOUD}/image/upload/v1790000001/hippocampus-docs/setup/hippo-mark.png`, bytes: 3100, sha256: sha });
  // dynamic folder mode lands on the same entry
  const dyn = C.uploadPlan(signed('dynamic'), 'setup');
  assert.deepEqual(C.manifestEntry(uploaded('hippocampus-docs/setup/hippo-mark', 3100), dyn, sha).entry, made.entry);
  // refused: an existing image (overwrite=false answers it), another id, a foreign cloud, no size, no sha
  assert.match(C.manifestEntry(Object.assign(uploaded('hippocampus-docs/setup/hippo-mark'), { existing: true }), plan, sha).problem,
    /already in hippocampus-docs\/setup/);
  assert.match(C.manifestEntry(uploaded('hippocampus-docs/people/hippo-mark'), plan, sha).problem, /another name/);
  assert.match(C.manifestEntry(Object.assign(uploaded('hippocampus-docs/setup/hippo-mark'),
    { secure_url: 'https://res.cloudinary.com/other/image/upload/v1/hippocampus-docs/setup/hippo-mark.png' }), plan, sha).problem, /https address/);
  assert.match(C.manifestEntry(Object.assign(uploaded('hippocampus-docs/setup/hippo-mark'), { bytes: 0 }), plan, sha).problem, /how big/);
  assert.match(C.manifestEntry(uploaded('hippocampus-docs/setup/hippo-mark'), plan, 'abc').problem, /sha256/);
  // added to the draft text: today's manifest round-trips byte for byte, and the entry is the whole diff
  assert.equal(C.addManifestEntry(MANIFEST_TEXT, made.entry).problem, null);
  const text = C.addManifestEntry(MANIFEST_TEXT, made.entry).text;
  const doc = JSON.parse(text);
  assert.equal(doc.assets.length, LIVE.assets.length + 1);
  assert.deepEqual(doc.assets.at(-1), made.entry);
  assert.equal(C.addManifestEntry(MANIFEST_TEXT, doc.assets.at(-1)).text, text);
  doc.assets.pop();
  assert.equal(`${JSON.stringify(doc, null, 2)}\n`, MANIFEST_TEXT, 'the rest of the file is untouched');
  for (const k of ['public_id', 'url', 'sha256']) {
    assert.match(C.addManifestEntry(MANIFEST_TEXT, Object.assign({}, made.entry, { [k]: USED[k] })).problem, new RegExp(`this ${k}`));
  }
  assert.match(C.addManifestEntry('{"cloud": "x"}', made.entry).problem, /could not be read/);
});

test('upload plan: exactly the signed params, then api_key and signature; a tampered answer is refused before any byte leaves', () => {
  const fixed = C.uploadPlan(signed('fixed'), 'setup');
  assert.equal(fixed.url, `https://api.cloudinary.com/v1_1/${CLOUD}/image/upload`);
  assert.deepEqual(fixed.fields, [['folder', 'hippocampus-docs/setup'], ['overwrite', 'false'], ['public_id', 'hippo-mark'],
    ['timestamp', TS], ['api_key', API_KEY], ['signature', SIG]]);
  assert.equal(fixed.expectedId, 'hippocampus-docs/setup/hippo-mark');
  const dyn = C.uploadPlan(signed('dynamic'), 'setup');
  assert.deepEqual(dyn.fields.map((f) => f[0]), ['asset_folder', 'overwrite', 'public_id', 'timestamp', 'api_key', 'signature']);
  assert.equal(dyn.expectedId, 'hippocampus-docs/setup/hippo-mark');
  // params without a timestamp: the top-level one is added, once
  const noTs = signed('fixed');
  delete noTs.params.timestamp;
  assert.deepEqual(C.uploadPlan(noTs, 'setup').fields.filter((f) => f[0] === 'timestamp'), [['timestamp', TS]]);
  const tamper = (fn) => { const s = signed('fixed'); fn(s); return C.uploadPlan(s, 'setup').problem; };
  assert.match(tamper((s) => { s.params.folder = 'portfolio'; }), /another place/);
  assert.match(tamper((s) => { s.params.folder = 'hippocampus-docs/people'; }), /another place/);
  assert.match(tamper((s) => { s.params.overwrite = 'true'; }), /never replace/);
  assert.match(tamper((s) => { s.params.notification_url = 'https://evil.example'; }), /does not know/);
  assert.match(tamper((s) => { s.params.public_id = '../x'; }), /another place/);
  assert.match(tamper((s) => { s.params.timestamp = '1'; }), /timestamp/);
  assert.match(tamper((s) => { s.signature = ''; }), /signature/);
  assert.match(tamper((s) => { s.cloud_name = 'x/../y'; }), /account name/);
  assert.match(C.uploadPlan(signed('fixed', 'setup'), 'people').problem, /another place/);
  assert.match(C.uploadPlan(null, 'setup').problem, /no upload parameters/);
});

test('guard: rename and delete only for images the live site does not use; the in-use line is verbatim', () => {
  assert.equal(C.REMOVE_FIRST_TEXT, 'remove it from the page first, merge, then delete');
  assert.ok(C.IN_USE_TEXT.includes(C.REMOVE_FIRST_TEXT));
  const live = C.manifestAssets(LIVE);
  assert.equal(C.mediaChangeProblem(USED.public_id, live, []), C.IN_USE_TEXT);
  for (const a of live) assert.equal(C.mediaChangeProblem(a.public_id, live, []), C.IN_USE_TEXT, a.public_id);
  assert.equal(C.mediaChangeProblem(FREE_ID, live, []), null);
  assert.equal(C.mediaChangeProblem(FREE_ID, live, [{ public_id: FREE_ID }]), C.IN_DRAFT_TEXT);
  for (const bad of ['portfolio/x', 'hippocampus-docs-evil/x', '', null]) {
    assert.match(C.mediaChangeProblem(bad, live, []), /outside the site's folder/, String(bad));
  }
  assert.equal(C.mediaFailure(409, { error: 'x is still referenced by the site' }), C.IN_USE_TEXT);
});

test('duplicates: found by sha256 in the live manifest or the draft; nothing is signed or uploaded', async () => {
  const sha = shaOf(PNG);
  const live = C.manifestAssets(LIVE).map((a, i) => (i === 3 ? Object.assign({}, a, { sha256: sha }) : a));
  assert.equal(C.findBySha(live, sha), live[3]);
  assert.equal(C.findBySha(C.manifestAssets(LIVE), sha), null);
  const calls = [];
  const deps = { media: { sign: async () => { calls.push('sign'); return { ok: false }; } },
    fetch: async () => { calls.push('cloudinary'); return reply(500, {}); }, FormData: FakeFormData, subtle: crypto.webcrypto.subtle };
  const site = await C.runUpload(deps, { file: fakeFile(PNG), subfolder: 'setup', live, draftText: MANIFEST_TEXT });
  assert.deepEqual([site.kind, site.where, site.entry.url], ['duplicate', 'site', live[3].url]);
  const draftDoc = JSON.parse(MANIFEST_TEXT);
  draftDoc.assets.push({ source: null, folder: 'hippocampus-docs/setup', public_id: FREE_ID, url: FREE_URL, bytes: 9, sha256: sha });
  const inDraft = await C.runUpload(deps, { file: fakeFile(PNG), subfolder: 'setup', live: C.manifestAssets(LIVE),
    draftText: JSON.stringify(draftDoc, null, 2) });
  assert.deepEqual([inDraft.kind, inDraft.where, inDraft.entry.public_id], ['duplicate', 'draft', FREE_ID]);
  assert.deepEqual(calls, [], 'a duplicate is never signed or uploaded');
});

test('files: images only, not empty, under 5 MB', () => {
  assert.equal(C.mediaFileProblem(fakeFile(PNG)), null);
  for (const type of ['image/jpeg', 'image/gif', 'image/webp']) assert.equal(C.mediaFileProblem(fakeFile(PNG, { type })), null, type);
  assert.match(C.mediaFileProblem(fakeFile(PNG, { type: 'image/svg+xml', name: 'x.svg' })), /x\.svg is not a PNG, JPEG, GIF or WebP/);
  assert.match(C.mediaFileProblem(fakeFile(PNG, { type: 'application/pdf' })), /not a PNG/);
  assert.match(C.mediaFileProblem(fakeFile(PNG, { size: 0 })), /empty/);
  assert.equal(C.mediaFileProblem(fakeFile(PNG, { size: C.MEDIA_MAX_BYTES })), null);
  assert.match(C.mediaFileProblem(fakeFile(PNG, { size: C.MEDIA_MAX_BYTES + 1 })), /5\.0 MB\. Keep images under 5 MB/);
  assert.match(C.mediaFileProblem(null), /Choose an image file/);
  assert.match(C.SIZE_HINT_TEXT, /Keep images under 5 MB/);
});

test('upload: file -> sha256 -> sign -> ONE direct multipart POST to Cloudinary with the signed params -> the manifest draft', async () => {
  for (const mode of ['fixed', 'dynamic']) {
    const media = [];
    const cloud = [];
    const mediaClient = C.createMediaClient({ token: TOKEN, fetch: async (url, init) => {
      media.push({ url, init, body: JSON.parse(init.body) });
      return reply(200, signed(mode));
    } });
    const deps = { media: mediaClient, FormData: FakeFormData, subtle: crypto.webcrypto.subtle,
      fetch: async (url, init) => { cloud.push({ url, init }); return reply(200, uploaded('hippocampus-docs/setup/hippo-mark', 2048)); } };
    const file = fakeFile(PNG);
    const out = await C.runUpload(deps, { file, subfolder: 'setup', live: C.manifestAssets(LIVE), draftText: MANIFEST_TEXT });
    assert.equal(out.kind, 'uploaded', mode);
    assert.deepEqual(media.map((m) => m.body), [{ action: 'sign', subfolder: 'setup', filename: 'Hippo Mark.png' }]);
    assert.equal(media[0].url, '/api/media', 'the token goes to this site\'s own function only');
    assert.equal(media[0].init.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(cloud.length, 1);
    assert.equal(cloud[0].url, `https://api.cloudinary.com/v1_1/${CLOUD}/image/upload`);
    assert.deepEqual(Object.keys(cloud[0].init), ['method', 'body'], 'no headers, no credentials: the form alone');
    const entries = cloud[0].init.body.entries;
    const s = signed(mode);
    assert.deepEqual(entries.map((e) => e[0]), [...Object.keys(s.params).sort(), 'api_key', 'signature', 'file']);
    for (const [k, v] of entries.slice(0, -3)) assert.equal(v, s.params[k], k);
    assert.equal(entries.at(-1)[1], file, 'the file itself');
    assert.ok(!JSON.stringify(entries.slice(0, -1)).includes(TOKEN), 'no token in the Cloudinary request');
    assert.deepEqual(JSON.parse(out.text).assets.at(-1), out.entry);
    assert.equal(out.entry.sha256, shaOf(PNG));
  }
  // Cloudinary saying no, or the gateway saying no, leaves the draft alone
  const deps = (signAnswer, cloudAnswer) => ({ media: { sign: async () => signAnswer }, FormData: FakeFormData,
    subtle: crypto.webcrypto.subtle, fetch: async () => cloudAnswer });
  const o = { file: fakeFile(PNG), subfolder: 'setup', live: [], draftText: MANIFEST_TEXT };
  const refused = await C.runUpload(deps({ ok: true, data: signed('fixed') }, reply(400, { error: { message: 'Invalid Signature' } })), o);
  assert.deepEqual([refused.kind, refused.message], ['problem', 'Cloudinary refused the upload: HTTP 400 (Invalid Signature).']);
  const gate = await C.runUpload(deps({ ok: false, status: 429, message: C.mediaFailure(429) }), o);
  assert.deepEqual([gate.kind, gate.status], ['problem', 429]);
  const otherCloud = await C.runUpload(deps({ ok: true, data: Object.assign(signed('fixed'), { cloud_name: 'someone-else' }) }), o);
  assert.match(otherCloud.message, /signs for Cloudinary account 'someone-else'/);
  assert.match((await C.runUpload(deps(), Object.assign({}, o, { subfolder: '../x' }))).message, /Pick a folder/);
});

test('media client: POST /api/media, same origin, with the bearer and {action, …}; failures in words', async () => {
  const seen = [];
  const m = C.createMediaClient({ token: TOKEN, fetch: async (url, init) => { seen.push([url, init]); return reply(200, { assets: [], next_cursor: null }); } });
  await m.list();
  await m.list('c2');
  await m.destroy(FREE_ID);
  await m.rename(FREE_ID, 'hippocampus-docs/setup/new-name');
  assert.deepEqual(seen.map(([u, i]) => [u, i.method, i.credentials, JSON.parse(i.body)]), [
    ['/api/media', 'POST', 'same-origin', { action: 'list' }],
    ['/api/media', 'POST', 'same-origin', { action: 'list', cursor: 'c2' }],
    ['/api/media', 'POST', 'same-origin', { action: 'destroy', public_id: FREE_ID }],
    ['/api/media', 'POST', 'same-origin', { action: 'rename', from: FREE_ID, to: 'hippocampus-docs/setup/new-name' }]]);
  const failing = (status, body) => C.createMediaClient({ token: TOKEN, fetch: async () => reply(status, body) }).list();
  assert.equal((await failing(409, { error: 'still referenced by the site' })).message, C.IN_USE_TEXT);
  assert.match((await failing(400, { error: 'Cloudinary is not configured on this host' })).message, /not set up on this site yet/);
  assert.match((await failing(502, { error: 'Cloudinary could not list the images — try again' })).message, /HTTP 502 \(Cloudinary could not list/);
  const down = await C.createMediaClient({ token: TOKEN, fetch: async () => { throw new Error('offline'); } }).list();
  assert.deepEqual([down.ok, down.status], [false, 0]);
  assert.throws(() => C.createMediaClient({ fetch: async () => null }), /token/);
});

test('insert: ![alt](url) at the cursor; the alt text is asked for and never empty', () => {
  const md = C.imageMarkdown('  The [hippo]\nmark ', USED.url);
  assert.deepEqual(md, { problem: null, text: `![The hippo mark](${USED.url})` });
  assert.match(C.imageMarkdown('   ', USED.url).problem, /Describe the image first/);
  assert.match(C.imageMarkdown('x', 'https://evil.example/a.png').problem, /Pick an image/);
  assert.match(C.imageMarkdown('x', `${USED.url}) <script>`).problem, /Pick an image/);
  const out = C.insertText('Intro.\n\nMore.', 8, 8, md.text);
  assert.equal(out.text, `Intro.\n\n${md.text}More.`);
  assert.equal(out.selStart, 8 + md.text.length);
  assert.equal(C.insertText('abcdef', 2, 4, 'X').text, 'abXef', 'a selection is replaced');
});

// ------------------------------------------------ js/cms.js in a fake page --

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.ownText = '';
    this.attrs = {};
    this.hidden = false;
    this.disabled = false;
    this.readOnly = false;
    this.className = '';
    this.dataset = {};
    this.listeners = {};
    this.value = '';
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.parent = null;
    if (this.tagName === 'IFRAME') {
      const frame = this;
      this.posted = [];
      this.srcs = [];
      this.contentWindow = { postMessage(m) { frame.posted.push(m); } };
    }
    const classes = new Set();
    this.classList = {
      toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
    };
  }
  get textContent() { return this.ownText + this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(t) { this.ownText = String(t); this.childNodes = []; }
  set src(u) { if (this.srcs) this.srcs.push(u); this.attrs.src = u; }
  get src() { return this.attrs.src; }
  appendChild(c) { this.childNodes.push(c); c.parent = this; return c; }
  replaceChildren(...cs) { this.ownText = ''; this.childNodes = cs; cs.forEach((c) => { c.parent = this; }); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  querySelectorAll() { return []; }
  remove() { if (this.parent) this.parent.childNodes = this.parent.childNodes.filter((c) => c !== this); }
  focus() {}
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
  fire(type) { for (const fn of this.listeners[type] || []) fn({ type, target: this, preventDefault() {} }); }
  click() { if (!this.disabled) this.fire('click'); }
}

function findAll(node, pred, out = []) {
  if (node && node.tagName && pred(node)) out.push(node);
  for (const c of (node && node.childNodes) || []) findAll(c, pred, out);
  return out;
}

const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 80; i += 1) await tick(); };

const SETUP_PAGE = JSON.parse(readRepo('data/setup.json')).sections[0].pages[0];
const SETUP_FILE = SETUP_PAGE.file;
const SETUP_TEXT = readRepo(SETUP_FILE);

/* The fake world: GitHub (a push-access user, main at MAIN_SHA), this
   site's /api/media and Cloudinary's upload endpoint. Every request is
   recorded in `calls` with the side it went to. */
function world(o) {
  const x = o || {};
  const contents = Object.assign({
    [`${SETUP_FILE}@${MAIN_SHA}`]: SETUP_TEXT,
    [`data/cloudinary-manifest.json@${MAIN_SHA}`]: MANIFEST_TEXT,
    [`data/people.json@${MAIN_SHA}`]: readRepo('data/people.json'),
  }, x.contents || {});
  let k = 0;
  return (url, init) => {
    const method = init.method || 'GET';
    if (url === '/api/media') {
      const body = JSON.parse(init.body);
      if (x.media && x.media[body.action]) return x.media[body.action](body);
      if (body.action === 'sign') return reply(200, signed(x.mode || 'fixed', body.subfolder));
      if (body.action === 'list') {
        const pages = x.pages || { first: { assets: [], next_cursor: null } };
        return reply(200, pages[body.cursor || 'first']);
      }
      if (body.action === 'destroy') return reply(200, { result: 'ok', public_id: body.public_id });
      return reply(400, { error: 'unexpected' });
    }
    if (url.startsWith('https://api.cloudinary.com/')) {
      return reply(200, uploaded(`hippocampus-docs/${init.body.entries.find((e) => e[0] === 'folder')[1].split('/').pop()}/hippo-mark`, 2048));
    }
    if (method !== 'GET') {
      const rest = url.slice(REPO_API.length);
      const next = () => (k += 1).toString(16).padStart(40, 'a');
      if (['/git/blobs', '/git/trees', '/git/commits'].indexOf(rest) >= 0) return reply(201, { sha: next() });
      if (rest === '/git/refs') return reply(201, { ref: JSON.parse(init.body).ref, object: { sha: 'f'.repeat(40) } });
      if (rest === '/pulls') return reply(201, { number: 42 });
      if (/^\/pulls\/[0-9]+$/.test(rest)) return reply(200, { number: 42 });
      return reply(500, { message: `unexpected ${method} ${rest}` });
    }
    if (url === 'https://api.github.com/user') return reply(200, { login: 'bob' });
    if (url === REPO_API) return reply(200, { permissions: x.perms || { push: true } });
    const rest = url.slice(REPO_API.length);
    if (rest.startsWith('/pulls?state=open')) return reply(200, x.pulls || []);
    const refs = Object.assign({ main: MAIN_SHA }, x.refs || {});
    const ref = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
    if (ref && refs[ref[1]]) return reply(200, { ref: `refs/heads/${ref[1]}`, object: { sha: refs[ref[1]], type: 'commit' } });
    const commit = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest);
    if (commit && Object.values(refs).includes(commit[1])) return reply(200, { sha: commit[1], tree: { sha: MAIN_TREE } });
    const m = /^\/contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(rest);
    if (m && contents[`${decodeURIComponent(m[1])}@${m[2]}`] !== undefined) return reply(200, contents[`${decodeURIComponent(m[1])}@${m[2]}`]);
    return reply(404, { message: 'Not Found' });
  };
}

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

/* js/cms-core.js and js/cms.js in a fresh vm context standing in for
   cms/index.html; HC.fetchJSON reads this repository's files (the live
   manifest can be swapped with opts.live). */
function openPage(opts) {
  const ids = ['cms-main', 'cms-notice', 'cms-sign-in', 'cms-sign-out', 'cms-who', 'cms-nav'];
  const els = Object.fromEntries(ids.map((id) => [id, new FakeElement('div')]));
  const storage = memoryStorage();
  C.writeSession(storage, C.makeSession(TOKEN, null, 'bob', Date.now()));
  const calls = [];
  const listeners = {};
  const confirms = [];
  const created = [];
  const location = { origin: 'https://docs.example.org', hash: opts.hash };
  const github = world(opts.world);
  const win = vm.createContext({
    document: {
      getElementById: (id) => els[id] || null,
      createElement: (tag) => { const e = new FakeElement(tag); created.push(e); return e; },
      createTextNode: (text) => ({ textContent: String(text) }),
      documentElement: new FakeElement('html'),
    },
    sessionStorage: storage,
    localStorage: memoryStorage(),
    location,
    crypto: { getRandomValues: (arr) => crypto.webcrypto.getRandomValues(arr), subtle: crypto.webcrypto.subtle },
    FormData: FakeFormData,
    fetch: (url, init) => {
      const u = String(url);
      const side = u === '/api/media' ? 'media' : u.startsWith('https://api.cloudinary.com/') ? 'cloudinary' : 'github';
      calls.push({ side, url: u, init: init || {}, method: (init && init.method) || 'GET',
        body: init && typeof init.body === 'string' ? JSON.parse(init.body) : init && init.body });
      return Promise.resolve(github(u, init || {}));
    },
    open: () => null,
    confirm: (text) => { confirms.push(text); return opts.confirm !== undefined ? opts.confirm : true; },
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    HC: { fetchJSON: async (p) => (opts.live && /cloudinary-manifest/.test(p) ? JSON.parse(JSON.stringify(opts.live))
      : JSON.parse(readRepo(p.replace(/^\.\.\//, '')))) },
    setInterval, clearInterval, clearTimeout,
    setTimeout: (fn) => setTimeout(fn, 0),
  });
  win.window = win;
  for (const f of ['cms-core.js', 'cms.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), win, { filename: f });
  const main = els['cms-main'];
  return {
    els, calls, storage, confirms, listeners, location, created,
    main: () => main.textContent,
    all: (pred) => findAll(main, pred),
    one: (pred) => findAll(main, pred)[0],
    byData: (k, v, within) => findAll(within || main, (e) => e.attrs[`data-${k}`] === v)[0],
    field: (k) => findAll(main, (e) => e.attrs['data-field'] === k)[0],
    textarea: () => findAll(main, (e) => e.tagName === 'TEXTAREA' && e.attrs['data-editor'] !== undefined)[0],
    media: () => calls.filter((c) => c.side === 'media'),
    cloud: () => calls.filter((c) => c.side === 'cloudinary'),
    writes: () => calls.filter((c) => c.side === 'github' && c.method !== 'GET'),
    draft: (key) => C.createDraftStore(storage).get(key),
  };
}

test('js/cms.js #/media: the images with c_limit,w_240 thumbnails, "on the site" marks, and a next page on next_cursor', async () => {
  const pages = {
    first: { assets: [{ public_id: USED.public_id, url: USED.url, bytes: USED.bytes, width: 800, height: 600, format: 'jpg' },
      { public_id: FREE_ID, url: FREE_URL, bytes: 1200, width: 300, height: 200, format: 'png' }], next_cursor: 'c2' },
    c2: { assets: [{ public_id: 'hippocampus-docs/brand/spare', url: `https://res.cloudinary.com/${CLOUD}/image/upload/v1/hippocampus-docs/brand/spare.png`,
      bytes: 10, width: 1, height: 1, format: 'png' }], next_cursor: null },
  };
  const page = openPage({ hash: '#/media', world: { pages } });
  await settle();
  assert.ok(findAll(page.els['cms-nav'], (e) => e.attrs.href === '#/media' && e.attrs['data-nav'] === 'media').length, 'nav has Media');
  const tiles = () => page.all((e) => e.attrs['data-asset'] !== undefined);
  assert.deepEqual(tiles().map((t) => t.attrs['data-asset']), [USED.public_id, FREE_ID]);
  const thumbs = page.all((e) => e.tagName === 'IMG' && /c_limit,w_240/.test(e.attrs.src || ''));
  assert.deepEqual(thumbs.map((i) => i.attrs.src), [C.thumbUrl(USED.url), C.thumbUrl(FREE_URL)]);
  assert.match(tiles()[0].textContent, /on the site/);
  assert.match(tiles()[1].textContent, /not used by the site/);
  // the folder picker is the fixed list
  assert.deepEqual(page.field('media-folder').childNodes.map((o) => o.attrs.value), C.MEDIA_SUBFOLDERS);
  page.byData('action', 'media-more').click();
  await settle();
  assert.deepEqual(page.media().map((c) => c.body), [{ action: 'list' }, { action: 'list', cursor: 'c2' }]);
  assert.equal(tiles().length, 3);
  assert.equal(page.byData('action', 'media-more'), undefined, 'no more pages');
  for (const c of page.media()) assert.equal(c.init.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(page.writes(), []);
});

test('js/cms.js #/media: delete of an image the site uses says the verbatim line and calls nothing; a free one asks, then deletes', async () => {
  const pages = { first: { assets: [{ public_id: USED.public_id, url: USED.url, bytes: 1 },
    { public_id: FREE_ID, url: FREE_URL, bytes: 1 }], next_cursor: null } };
  const page = openPage({ hash: '#/media', world: { pages } });
  await settle();
  const tile = (id) => page.one((e) => e.attrs['data-asset'] === id);
  page.byData('action', 'media-delete', tile(USED.public_id)).click();
  await settle();
  assert.ok(tile(USED.public_id).textContent.includes('remove it from the page first, merge, then delete'));
  page.byData('action', 'media-rename', tile(USED.public_id)).click();
  await settle();
  assert.equal(page.one((e) => e.attrs['data-field'] === 'media-new-name'), undefined, 'no rename form for an image in use');
  assert.deepEqual(page.media().map((c) => c.body.action), ['list'], 'no destroy or rename was sent');
  assert.deepEqual(page.confirms, []);
  page.byData('action', 'media-delete', tile(FREE_ID)).click();
  await settle();
  assert.equal(page.confirms.length, 1);
  assert.match(page.confirms[0], /old-sketch/);
  assert.deepEqual(page.media().at(-1).body, { action: 'destroy', public_id: FREE_ID });
  assert.equal(tile(FREE_ID), undefined, 'the deleted image leaves the list');
});

test('js/cms.js #/media: a 409 from the gateway (the site started using it) shows the same line; rename sends {from, to}', async () => {
  const pages = { first: { assets: [{ public_id: FREE_ID, url: FREE_URL, bytes: 1 }], next_cursor: null } };
  const page = openPage({ hash: '#/media', world: { pages, media: {
    destroy: () => reply(409, { error: `${FREE_ID} is still referenced by the site` }),
    rename: (b) => reply(200, { public_id: b.to, url: FREE_URL.replace('old-sketch', 'new-sketch') }),
  } } });
  await settle();
  const tile = () => page.one((e) => e.attrs['data-asset'] !== undefined);
  page.byData('action', 'media-delete', tile()).click();
  await settle();
  assert.ok(tile().textContent.includes(C.IN_USE_TEXT));
  page.byData('action', 'media-rename', tile()).click();
  await settle();
  page.field('media-new-name').value = 'New Sketch!';
  page.byData('action', 'media-rename-save').click();
  await settle();
  assert.match(tile().textContent, /lowercase letters, digits and dashes/);
  page.field('media-new-name').value = 'new-sketch';
  page.byData('action', 'media-rename-save').click();
  await settle();
  assert.deepEqual(page.media().at(-1).body, { action: 'rename', from: FREE_ID, to: 'hippocampus-docs/setup/new-sketch' });
  assert.equal(tile().attrs['data-asset'], 'hippocampus-docs/setup/new-sketch');
});

const openMedia = async (page) => {
  page.byData('action', 'media-open').click();
  await settle();
};
const upload = async (page, file, folder) => {
  page.field('media-folder').value = folder || 'setup';
  page.field('media-file').files = [file];
  page.byData('action', 'media-upload').click();
  await settle();
};

test('js/cms.js editor: Image from Media uploads (sign -> Cloudinary), adds ONE manifest entry, inserts ![alt](url), proposes both files', async () => {
  const page = openPage({ hash: `#/edit/setup/${SETUP_PAGE.id}` });
  await settle();
  const ta = page.textarea();
  await openMedia(page);
  assert.match(page.main(), /Keep images under 5 MB/);
  await upload(page, fakeFile(PNG));
  assert.deepEqual(page.media().map((c) => c.body), [{ action: 'sign', subfolder: 'setup', filename: 'Hippo Mark.png' }]);
  assert.equal(page.cloud().length, 1);
  const post = page.cloud()[0];
  assert.equal(post.url, `https://api.cloudinary.com/v1_1/${CLOUD}/image/upload`);
  assert.deepEqual(post.body.entries.map((e) => e[0]), ['folder', 'overwrite', 'public_id', 'timestamp', 'api_key', 'signature', 'file']);
  assert.equal(post.init.headers, undefined, 'no Authorization, no headers at all');
  assert.ok(!JSON.stringify(post.body.entries.slice(0, -1)).includes(TOKEN));
  // the manifest draft gained exactly one entry
  const md = page.draft(C.MANIFEST_KEY);
  const assets = JSON.parse(md.files[C.MANIFEST_FILE]).assets;
  assert.equal(assets.length, LIVE.assets.length + 1);
  const url = `https://res.cloudinary.com/${CLOUD}/image/upload/v1790000001/hippocampus-docs/setup/hippo-mark.png`;
  assert.deepEqual(assets.at(-1), { source: null, folder: 'hippocampus-docs/setup', public_id: 'hippocampus-docs/setup/hippo-mark',
    url, bytes: 2048, sha256: shaOf(PNG) });
  assert.equal(md.base.ref, 'main');
  // the alt text is asked for: empty inserts nothing
  const at = SETUP_TEXT.indexOf('\n') + 1;
  ta.selectionStart = ta.selectionEnd = at;
  page.byData('action', 'media-insert').click();
  await settle();
  assert.equal(ta.value, SETUP_TEXT);
  assert.match(page.main(), /Describe the image first/);
  page.field('media-alt').value = 'The hippo mark';
  page.byData('action', 'media-insert').click();
  await settle();
  assert.equal(ta.value, SETUP_TEXT.slice(0, at) + `![The hippo mark](${url})` + SETUP_TEXT.slice(at));
  assert.ok(page.draft(`setup/${SETUP_PAGE.id}`).files[SETUP_FILE].includes(`![The hippo mark](${url})`));
  // Propose lists the page and the image list together, and sends both in one tree
  page.byData('action', 'propose').click();
  await settle();
  assert.match(page.main(), /What goes in \(2 files\):/);
  assert.ok(page.main().includes(C.MANIFEST_FILE) && page.main().includes(SETUP_FILE));
  page.byData('action', 'send-proposal').click();
  await settle();
  const tree = page.writes().find((c) => c.url.endsWith('/git/trees'));
  assert.deepEqual(tree.body.tree.map((e) => e.path), [C.MANIFEST_FILE, SETUP_FILE].sort());
  assert.equal(page.location.hash, '#/review/42');
  assert.equal(page.draft(C.MANIFEST_KEY), null, 'the image list went into the proposal');
});

test('js/cms.js editor: a duplicate (same sha256 as a site image) offers the site\'s URL and uploads nothing', async () => {
  const live = JSON.parse(MANIFEST_TEXT);
  live.assets[2].sha256 = shaOf(PNG);
  const page = openPage({ hash: `#/edit/setup/${SETUP_PAGE.id}`, live });
  await settle();
  await openMedia(page);
  await upload(page, fakeFile(PNG));
  assert.deepEqual(page.media(), [], 'not signed');
  assert.deepEqual(page.cloud(), [], 'not uploaded');
  assert.ok(page.main().includes(live.assets[2].url), 'the existing URL is offered');
  assert.match(page.main(), /already on the site/);
  assert.equal(page.draft(C.MANIFEST_KEY), null, 'the image list is unchanged');
  const ta = page.textarea();
  ta.selectionStart = ta.selectionEnd = 0;
  page.field('media-alt').value = 'A photo';
  page.byData('action', 'media-insert').click();
  await settle();
  assert.ok(ta.value.startsWith(`![A photo](${live.assets[2].url})`));
});

test('js/cms.js editor: an image the site has can be picked without uploading; a file over 5 MB is refused before any call', async () => {
  const page = openPage({ hash: `#/edit/setup/${SETUP_PAGE.id}` });
  await settle();
  await openMedia(page);
  await upload(page, fakeFile(PNG, { size: C.MEDIA_MAX_BYTES + 1 }));
  assert.match(page.main(), /Keep images under 5 MB: make it smaller/);
  assert.deepEqual([page.media().length, page.cloud().length], [0, 0]);
  const pick = page.field('media-pick');
  pick.value = USED.url;
  pick.fire('change');
  await settle();
  page.field('media-alt').value = 'IMU';
  const ta = page.textarea();
  ta.selectionStart = ta.selectionEnd = 0;
  page.byData('action', 'media-insert').click();
  await settle();
  assert.ok(ta.value.startsWith(`![IMU](${USED.url})`));
});

test('js/cms.js New person: Photo from Media sets the photo to a site image', async () => {
  const page = openPage({ hash: '#/new/person' });
  await settle();
  await openMedia(page);
  const pick = page.field('media-pick');
  pick.value = USED.url;
  pick.fire('change');
  await settle();
  page.byData('action', 'media-use').click();
  await settle();
  page.field('group').value = 'alumni';
  page.field('name').value = 'Ada Example';
  page.byData('action', 'add-person').click();
  await settle();
  assert.equal(page.location.hash, '#/edit/data/people');
  const d = page.draft('data/people');
  assert.equal(JSON.parse(d.files['data/people.json']).groups[1].people.at(-1).photo, USED.url);
  assert.deepEqual(page.writes(), []);
});

test('js/cms.js #/media: read-only people see why they cannot manage images, and no gateway call is made', async () => {
  const page = openPage({ hash: '#/media', world: { perms: { push: false, pull: true } } });
  await settle();
  assert.match(page.main(), /View only: managing the site's images needs write access/);
  assert.deepEqual(page.media(), []);
});

test('js/cms.js New person on my open proposal: an image already proposed on that branch can be picked as the photo', async () => {
  const HEAD_B = '3'.repeat(40);
  const OWN = 'cms/bob/add-a-photo-260921';
  const onBranch = JSON.parse(MANIFEST_TEXT);
  const proposed = { source: null, folder: 'hippocampus-docs/people', public_id: 'hippocampus-docs/people/ada',
    url: `https://res.cloudinary.com/${CLOUD}/image/upload/v1790000002/hippocampus-docs/people/ada.png`, bytes: 99, sha256: 'b'.repeat(64) };
  onBranch.assets.push(proposed);
  const pulls = [{ number: 7, title: 'Add a photo', state: 'open', user: { login: 'bob' },
    head: { ref: OWN, sha: HEAD_B, repo: { full_name: 'desert-mango/hippocampus-docs' } }, base: { ref: 'main' } }];
  const page = openPage({ hash: '#/new/person', world: { pulls, refs: { [OWN]: HEAD_B }, contents: {
    [`data/cloudinary-manifest.json@${HEAD_B}`]: `${JSON.stringify(onBranch, null, 2)}\n`,
    [`data/people.json@${HEAD_B}`]: readRepo('data/people.json') } } });
  await settle();
  page.field('base').value = '7';
  await openMedia(page);
  const pick = page.field('media-pick');
  assert.ok(pick.childNodes.some((o) => o.attrs.value === proposed.url), 'the proposal\'s own image is offered');
  pick.value = proposed.url;
  pick.fire('change');
  await settle();
  page.byData('action', 'media-use').click();
  await settle();
  page.field('group').value = 'alumni';
  page.field('name').value = 'Ada Example';
  page.byData('action', 'add-person').click();
  await settle();
  assert.equal(page.location.hash, '#/edit/data/people', page.main());
  const d = page.draft('data/people');
  assert.equal(d.base.number, 7);
  assert.equal(JSON.parse(d.files['data/people.json']).groups[1].people.at(-1).photo, proposed.url);
  assert.deepEqual(page.writes(), []);
});
