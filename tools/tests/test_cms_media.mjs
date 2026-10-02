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
