// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 19 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Test the content-source seam and the CMS preview bridge client in js/source.js.
/* Unit tests for js/source.js — HC.fetchText / HC.fetchJSON / HC.callFunction.

   Outside a preview frame the seam is plain same-origin fetch. Inside one (the
   page loaded as `index.html#preview=<nonce>&route=<route>` in a sandboxed
   iframe) every content read travels to the parent CMS page over postMessage.
   These tests drive js/source.js's own factory with a FAKE window and a FAKE
   parent — no browser, no DOM — and pin the protocol that the parent side
   (js/cms.js, unit U7a) is written against: the fragment convention, the
   message shapes, the id matching, the nonce echo, the event.source/origin
   checks, the path allowlist, the timeout and the librarian's 405.

     node --test tools/tests/test_preview_bridge.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const SOURCE_JS = path.join(ROOT, 'js', 'source.js');
const SRC = require(SOURCE_JS);
const { classifyStatus } = require(path.join(ROOT, 'js', 'search.js'));

const ORIGIN = 'https://docs.example';
const NONCE = 'n0nce-4f9c2a7e1b3d5f60';
// Planted where a careless frame might look for credentials: none of these
// strings may ever appear in a message the frame posts.
const PLANTED = '<yours>-planted-token-value';

// ------------------------------------------------------------------ fakes --

function fakeWindow(opts) {
  const o = opts || {};
  const listeners = {};
  const posts = [];
  const win = {
    reloads: 0,
    replaced: [],
    name: PLANTED,
    sessionStorage: { getItem: () => PLANTED },
    localStorage: { getItem: () => PLANTED },
    location: {
      origin: o.origin || ORIGIN,
      hash: o.hash || '',
      replace(url) { win.replaced.push(['location.replace', url]); win.location.hash = url.slice(url.indexOf('#')); },
      reload() { win.reloads += 1; },
    },
    history: {
      replaceState(state, title, url) {
        if (o.replaceStateThrows) throw new Error('SecurityError');
        win.replaced.push(['history.replaceState', url]);
        win.location.hash = url.slice(url.indexOf('#'));
      },
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
    },
    dispatch(type, ev) {
      const event = Object.assign({ stopped: false }, ev);
      event.stopImmediatePropagation = () => { event.stopped = true; };
      for (const fn of (listeners[type] || []).slice()) {
        if (event.stopped) break;
        fn(event);
      }
      return event;
    },
    listeners,
    posts,
  };
  const parent = {
    token: PLANTED,
    postMessage(msg, targetOrigin) { posts.push({ msg: JSON.parse(JSON.stringify(msg)), targetOrigin }); },
  };
  win.parent = o.framed === false ? win : parent;
  win.parentFake = parent;
  return win;
}

const previewHash = (route) => SRC.previewFragment(NONCE, route);

function reply(win, data, over) {
  return win.dispatch('message', Object.assign(
    { source: win.parentFake, origin: ORIGIN, data: Object.assign({ type: 'hc-file', nonce: NONCE }, data) },
    over,
  ));
}

const tick = () => new Promise((r) => setImmediate(r));

// A pending-or-settled probe that never throws unhandled.
function track(promise) {
  const t = { state: 'pending', value: undefined, error: undefined };
  promise.then((v) => { t.state = 'fulfilled'; t.value = v; },
    (e) => { t.state = 'rejected'; t.error = e; });
  return t;
}

/* A reference parent implementing the rules the plan gives js/cms.js (U7a):
   answer only when event.source is the frame's window, only for the current
   nonce, only for allowlisted paths; everything else gets {ok:false,
   status:403}. It is here to show the two halves fit — the real parent is
   U7a's code, not this. */
function referenceParent(win, files) {
  win.parentFake.postMessage = (msg) => {
    win.posts.push({ msg: JSON.parse(JSON.stringify(msg)) });
    const good = msg && msg.type === 'hc-fetch' && msg.nonce === NONCE
      && SRC.isBridgePath(msg.path);
    const has = good && Object.prototype.hasOwnProperty.call(files, msg.path);
    const answer = !good ? { ok: false, status: 403, text: '' }
      : has ? { ok: true, status: 200, text: files[msg.path] }
        : { ok: false, status: 404, text: '' };
    setImmediate(() => reply(win, Object.assign({ id: msg.id, nonce: msg.nonce }, answer)));
  };
}

// ----------------------------------------------------------------- loading --

test('js/source.js loads under plain node and exports its factory and helpers', () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof SRC.create, 'function');
  assert.equal(typeof SRC.previewFragment, 'function');
  assert.equal(typeof SRC.parsePreviewFragment, 'function');
  assert.equal(typeof SRC.isBridgePath, 'function');
  assert.ok(SRC.BRIDGE_TIMEOUT_MS >= 10000);
});

// -------------------------------------------------------- the live site --

test('outside a preview frame fetchText/fetchJSON are plain same-origin fetch', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, init]);
    if (url === 'data/site.json') return { ok: true, status: 200, text: async () => '{"title":"T"}' };
    return { ok: false, status: 404, text: async () => 'nope' };
  };
  const win = fakeWindow({ hash: '#/setup/x' });
  const HC = SRC.create(win, { fetch: fetchImpl });
  assert.equal(HC.preview, false);
  assert.deepEqual(await HC.fetchJSON('data/site.json'), { title: 'T' });
  assert.equal(await HC.fetchText('data/site.json'), '{"title":"T"}');
  await assert.rejects(HC.fetchText('content/missing.md'), (err) => {
    assert.equal(err.status, 404);
    assert.equal(err.message, 'content/missing.md: HTTP 404');
    return true;
  });
  assert.deepEqual(calls.map((c) => c[0]), ['data/site.json', 'data/site.json', 'content/missing.md']);
  assert.equal(win.posts.length, 0, 'the live site never talks to a parent');
  assert.equal(win.location.hash, '#/setup/x', 'an ordinary route is left alone');
  assert.equal(win.replaced.length, 0);
  assert.equal((win.listeners.message || []).length, 0, 'no message listener outside preview');
});

test('outside a preview frame callFunction is fetch with the caller\'s arguments', async () => {
  const calls = [];
  const HC = SRC.create(fakeWindow({ hash: '' }), {
    fetch: async (url, init) => { calls.push([url, init]); return { ok: true, status: 200 }; },
  });
  const init = { method: 'POST', body: '{"q":"a b"}' };
  const res = await HC.callFunction('api/librarian', init);
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [['api/librarian', init]]);
});

// ------------------------------------------------ the fragment convention --

test('previewFragment / parsePreviewFragment pin the fragment convention', () => {
  assert.equal(SRC.previewFragment(NONCE, '/setup/lab-marker/design'),
    `#preview=${NONCE}&route=%2Fsetup%2Flab-marker%2Fdesign`);
  assert.equal(SRC.previewFragment(NONCE), `#preview=${NONCE}`);
  assert.equal(SRC.previewFragment(NONCE, '/search?q=a b&c'),
    `#preview=${NONCE}&route=%2Fsearch%3Fq%3Da%20b%26c`);
  assert.deepEqual(SRC.parsePreviewFragment(SRC.previewFragment(NONCE, '/search?q=a b&c')),
    { nonce: NONCE, route: '/search?q=a b&c' });
  assert.deepEqual(SRC.parsePreviewFragment(`#preview=${NONCE}`), { nonce: NONCE, route: '/' });
  assert.equal(SRC.parsePreviewFragment('#/setup/x'), null, 'a site route is not a preview');
  assert.equal(SRC.parsePreviewFragment('#/setup/x?preview=abc'), null);
  // A malformed nonce is no nonce, but the fragment is still recognised (so it gets stripped).
  assert.deepEqual(SRC.parsePreviewFragment('#preview=short&route=%2Fabout'), { nonce: null, route: '/about' });
  assert.deepEqual(SRC.parsePreviewFragment(`#preview=${NONCE}%3Cx&route=%2Fabout`), { nonce: null, route: '/about' });
  // A route must be a site route: it starts with one '/' and carries no control characters.
  assert.deepEqual(SRC.parsePreviewFragment(`#preview=${NONCE}&route=javascript%3Aalert(1)`), { nonce: NONCE, route: '/' });
  assert.deepEqual(SRC.parsePreviewFragment(`#preview=${NONCE}&route=%2F%2Fevil.example`), { nonce: NONCE, route: '/' });
  assert.deepEqual(SRC.parsePreviewFragment(`#preview=${NONCE}&route=%2Fa%0Ab`), { nonce: NONCE, route: '/' });
});

test('the nonce is read once at load and the fragment rewritten to the route', () => {
  const win = fakeWindow({ hash: previewHash('/setup/lab-marker/design') });
  const HC = SRC.create(win);
  assert.equal(HC.preview, true);
  assert.equal(win.location.hash, '#/setup/lab-marker/design', 'the router only ever sees #/…');
  assert.deepEqual(win.replaced, [['history.replaceState', '#/setup/lab-marker/design']]);

  const bare = fakeWindow({ hash: `#preview=${NONCE}` });
  assert.equal(SRC.create(bare).preview, true);
  assert.equal(bare.location.hash, '#/');
});

test('when history.replaceState is refused the fragment is replaced by location.replace', () => {
  const win = fakeWindow({ hash: previewHash('/about'), replaceStateThrows: true });
  const HC = SRC.create(win);
  assert.equal(HC.preview, true);
  assert.deepEqual(win.replaced, [['location.replace', '#/about']]);
  assert.equal(win.location.hash, '#/about');
});

test('a preview fragment on a window that is not framed is stripped and ignored', async () => {
  const calls = [];
  const win = fakeWindow({ hash: previewHash('/about'), framed: false });
  const HC = SRC.create(win, {
    fetch: async (url) => { calls.push(url); return { ok: true, status: 200, text: async () => 'md' }; },
  });
  assert.equal(HC.preview, false);
  assert.equal(win.location.hash, '#/about');
  assert.equal(await HC.fetchText('content/about.md'), 'md');
  assert.deepEqual(calls, ['content/about.md']);
});

test('a malformed nonce means no preview, but the fragment is still stripped', () => {
  const win = fakeWindow({ hash: '#preview=tooshort&route=%2Fabout' });
  const HC = SRC.create(win, { fetch: async () => ({ ok: true, status: 200, text: async () => '' }) });
  assert.equal(HC.preview, false);
  assert.equal(win.location.hash, '#/about');
  assert.equal(win.posts.length, 0);
});

test('a later fragment carrying preview= reloads the frame instead of reaching the router', () => {
  const win = fakeWindow({ hash: previewHash('/about') });
  SRC.create(win);
  let routed = 0;
  win.addEventListener('hashchange', () => { routed += 1; });   // js/app.js registers after us

  win.location.hash = '#/setup/x';
  let ev = win.dispatch('hashchange', {});
  assert.equal(ev.stopped, false);
  assert.equal(routed, 1);
  assert.equal(win.reloads, 0);

  win.location.hash = SRC.previewFragment('another-nonce-0123456789', '/tools/x');
  ev = win.dispatch('hashchange', {});
  assert.equal(ev.stopped, true, 'the router must not see a preview fragment');
  assert.equal(routed, 1);
  assert.equal(win.reloads, 1, 'a new nonce is only ever read by a fresh load');
});

// ---------------------------------------------------------- the messages --

test('each request posts {type, nonce, id, path} to the parent at the site origin', async () => {
  const win = fakeWindow({ hash: previewHash('/') });
  const HC = SRC.create(win);
  const a = track(HC.fetchText('content/setup/lab-marker/design.md'));
  const b = track(HC.fetchJSON('data/setup.json'));
  assert.equal(win.posts.length, 2);
  for (const p of win.posts) {
    assert.deepEqual(Object.keys(p.msg).sort(), ['id', 'nonce', 'path', 'type']);
    assert.equal(p.msg.type, 'hc-fetch');
    assert.equal(p.msg.nonce, NONCE);
    assert.equal(p.targetOrigin, ORIGIN, 'never "*": only a parent on the site origin hears it');
    assert.ok(Number.isInteger(p.msg.id) && p.msg.id > 0);
  }
  const [pa, pb] = win.posts.map((p) => p.msg);
  assert.notEqual(pa.id, pb.id);
  assert.equal(pa.path, 'content/setup/lab-marker/design.md');
  assert.equal(pb.path, 'data/setup.json');

  // Answers arrive out of order; each settles its own request.
  reply(win, { id: pb.id, ok: true, status: 200, text: '{"sections":[]}' });
  reply(win, { id: pa.id, ok: true, status: 200, text: '# Design' });
  await tick();
  assert.equal(a.state, 'fulfilled');
  assert.equal(a.value, '# Design');
  assert.equal(b.state, 'fulfilled');
  assert.deepEqual(b.value, { sections: [] });
});

test('an error status is passed through to the caller', async () => {
  const win = fakeWindow({ hash: previewHash('/') });
  const HC = SRC.create(win);
  const missing = track(HC.fetchText('content/setup/gone.md'));
  const broken = track(HC.fetchJSON('data/projects.json'));
  const refused = track(HC.fetchText('content/about.md'));
  const [m, b, r] = win.posts.map((p) => p.msg);
  reply(win, { id: m.id, ok: false, status: 404, text: '' });
  reply(win, { id: b.id, ok: false, status: 500, text: 'upstream' });
  reply(win, { id: r.id, ok: false, status: 403, text: '' });
  await tick();
  assert.equal(missing.state, 'rejected');
  assert.equal(missing.error.status, 404);
  assert.equal(missing.error.message, 'content/setup/gone.md: HTTP 404');
  assert.equal(broken.error.status, 500);
  assert.equal(broken.error.message, 'data/projects.json: HTTP 500');
  assert.equal(refused.error.status, 403);
});

test('a reply with the wrong nonce is ignored', async () => {
  const win = fakeWindow({ hash: previewHash('/') });
  const HC = SRC.create(win);
  const t = track(HC.fetchText('content/about.md'));
  const { id } = win.posts[0].msg;
  reply(win, { id, nonce: 'stale-nonce-from-the-last-load', ok: true, status: 200, text: 'OLD DRAFT' });
  reply(win, { id, nonce: undefined, ok: true, status: 200, text: 'NO NONCE' });
  await tick();
  assert.equal(t.state, 'pending');
  reply(win, { id, ok: true, status: 200, text: 'current' });
  await tick();
  assert.equal(t.value, 'current');
});

test('a reply from anything but window.parent, or from another origin, is ignored', async () => {
  const win = fakeWindow({ hash: previewHash('/') });
  const HC = SRC.create(win);
  const t = track(HC.fetchText('content/about.md'));
  const { id } = win.posts[0].msg;
  const answer = { id, ok: true, status: 200, text: 'EVIL' };
  reply(win, answer, { source: win });                         // the frame's own window
  reply(win, answer, { source: { postMessage() {} } });        // a popup or a sibling frame
  reply(win, answer, { source: null });
  reply(win, answer, { origin: 'https://evil.example' });      // right window, wrong origin
  reply(win, answer, { origin: 'null' });
  await tick();
  assert.equal(t.state, 'pending');
  reply(win, { id, ok: true, status: 200, text: 'real' });
  await tick();
  assert.equal(t.value, 'real');
});

test('unknown ids, wrong types, malformed and duplicate replies are ignored', async () => {
  const win = fakeWindow({ hash: previewHash('/') });
  const HC = SRC.create(win);
  const t = track(HC.fetchText('content/about.md'));
  const { id } = win.posts[0].msg;
  reply(win, { id: id + 100, ok: true, status: 200, text: 'x' });
  reply(win, { id, type: 'hc-fetch', ok: true, status: 200, text: 'x' });
  reply(win, { id: String(id), ok: true, status: 200, text: 'x' });
  win.dispatch('message', { source: win.parentFake, origin: ORIGIN, data: 'hc-file' });
  win.dispatch('message', { source: win.parentFake, origin: ORIGIN, data: null });
  await tick();
  assert.equal(t.state, 'pending');
  reply(win, { id, ok: true, status: 200, text: 'first' });
  reply(win, { id, ok: true, status: 200, text: 'second' });
  await tick();
  assert.equal(t.value, 'first');
});

test('an ok reply without a string body is a 502, not a crash', async () => {
  const win = fakeWindow({ hash: previewHash('/') });
  const HC = SRC.create(win);
  const t = track(HC.fetchText('content/about.md'));
  reply(win, { id: win.posts[0].msg.id, ok: true, status: 200, text: { not: 'text' } });
  await tick();
  assert.equal(t.state, 'rejected');
  assert.equal(t.error.status, 502);
});

test('js/app.js, api/librarian.js and content/../js/app.js are refused with 403, never asked', async () => {
  const win = fakeWindow({ hash: previewHash('/') });
  const HC = SRC.create(win);
  for (const p of ['js/app.js', 'api/librarian.js', 'content/../js/app.js']) {
    await assert.rejects(HC.fetchText(p), (err) => {
      assert.equal(err.status, 403, p);
      assert.equal(err.message, `${p}: HTTP 403`);
      return true;
    });
  }
  assert.equal(win.posts.length, 0, 'a refused path is never even posted');
});

test('isBridgePath is the plan\'s allowlist, with no dot segments', () => {
  for (const ok of [
    'content/setup/lab-marker/design.md', 'content/about.md', 'content/projects/docs-and-site.md',
    'data/site.json', 'data/graph/wiki.json', 'data/people.json', 'search/manifest.json',
    'search/code-.github.json', 'search/code-hippo_control.json',
  ]) assert.equal(SRC.isBridgePath(ok), true, ok);
  for (const bad of [
    'js/app.js', 'api/librarian.js', 'content/../js/app.js', 'content/./about.md', 'content//about.md',
    '/content/about.md', 'content/about.md?x=1', 'content/about.MD', 'content\\about.md',
    'content/%2e%2e/js/app.js', 'search/sub/x.json', 'data/x.md', 'index.html', 'vercel.json',
    '.github/workflows/check.yml', 'content/about.md\n', '', null, undefined, 42,
    'https://docs.example/content/about.md', 'data/../.env.json', 'content/..',
  ]) assert.equal(SRC.isBridgePath(bad), false, String(bad));
});

test('the frame and a parent following the plan\'s rules fit together', async () => {
  const win = fakeWindow({ hash: previewHash('/setup/lab-marker/design') });
  referenceParent(win, {
    'content/setup/lab-marker/design.md': '# Design (draft)',
    'data/setup.json': '{"sections":[{"id":"lab-marker"}]}',
  });
  const HC = SRC.create(win);
  assert.equal(await HC.fetchText('content/setup/lab-marker/design.md'), '# Design (draft)');
  assert.deepEqual(await HC.fetchJSON('data/setup.json'), { sections: [{ id: 'lab-marker' }] });
  await assert.rejects(HC.fetchText('content/setup/nope.md'), (e) => e.status === 404);
});

test('no token, storage value or window.name ever appears in a posted message', async () => {
  const win = fakeWindow({ hash: previewHash('/about') });
  referenceParent(win, { 'content/about.md': 'hi' });
  const HC = SRC.create(win);
  await HC.fetchText('content/about.md');
  await HC.fetchJSON('data/people.json').catch(() => null);
  await HC.fetchText('js/app.js').catch(() => null);
  await HC.callFunction('api/librarian', { method: 'POST', body: '{"q":"thruster model"}' });
  assert.ok(win.posts.length >= 2);
  for (const p of win.posts) {
    const s = JSON.stringify(p.msg);
    assert.ok(!s.includes(PLANTED), s);
    assert.ok(!/token|authorization|bearer|ghu_|ghs_|gho_/i.test(s), s);
    assert.deepEqual(Object.keys(p.msg).sort(), ['id', 'nonce', 'path', 'type']);
  }
});

test('an unanswered request times out with 504 and a late reply is harmless', async () => {
  const win = fakeWindow({ hash: previewHash('/') });
  const HC = SRC.create(win, { timeoutMs: 20 });
  const t = track(HC.fetchText('content/about.md'));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(t.state, 'rejected');
  assert.equal(t.error.status, 504);
  assert.match(t.error.message, /^content\/about\.md: /);
  reply(win, { id: win.posts[0].msg.id, ok: true, status: 200, text: 'late' });
  await tick();
  assert.equal(t.state, 'rejected');
});

test('in preview the librarian answers 405 locally, so search latches off', async () => {
  const win = fakeWindow({ hash: previewHash('/search?q=thruster%20model') });
  const HC = SRC.create(win);
  assert.equal(win.location.hash, '#/search?q=thruster%20model');
  const res = await HC.callFunction('api/librarian', { method: 'POST', body: '{}' });
  assert.equal(res.ok, false);
  assert.equal(res.status, 405);
  assert.equal(classifyStatus(res.status), 'absent', 'js/search.js reads 405 as "no function here"');
  assert.equal(await res.json().catch(() => 'threw'), null);
  assert.equal(win.posts.length, 0, 'the librarian call never reaches the parent');
});

// ------------------------------------------------ Editor mode (protocol 9) --

function editorFrom(win, data, over) {
  return win.dispatch('message', Object.assign(
    { source: win.parentFake, origin: ORIGIN, data: Object.assign({ type: 'hc-editor', nonce: NONCE }, data) },
    over,
  ));
}

test('editor mode: HC.post sends the four frame messages, nonce added, to the parent at the site origin', () => {
  const win = fakeWindow({ hash: previewHash('/about') });
  const HC = SRC.create(win);
  assert.equal(HC.post('hc-ready'), true);
  assert.equal(HC.post('hc-route', { route: '/setup/lab-gantry/usage' }), true);
  assert.equal(HC.post('hc-block-select', { index: 3 }), true);
  assert.equal(HC.post('hc-block-insert', { index: 0, kind: 'note' }), true);
  assert.deepEqual(win.posts.map((p) => p.msg), [
    { type: 'hc-ready', nonce: NONCE },
    { type: 'hc-route', route: '/setup/lab-gantry/usage', nonce: NONCE },
    { type: 'hc-block-select', index: 3, nonce: NONCE },
    { type: 'hc-block-insert', index: 0, kind: 'note', nonce: NONCE },
  ]);
  assert.ok(win.posts.every((p) => p.targetOrigin === ORIGIN));
});

test('editor mode: HC.post refuses unknown types and bad fields, and posts nothing outside a preview', () => {
  const win = fakeWindow({ hash: previewHash('/about') });
  const HC = SRC.create(win);
  for (const [type, data] of [['hc-fetch', { path: 'content/about.md' }], ['hc-file', {}], ['hc-editor', {}],
    ['hc-block-select', { index: -1 }], ['hc-block-select', { index: 1.5 }], ['hc-block-select', { index: '2' }],
    ['hc-block-select', { index: 100001 }], ['hc-block-insert', { index: 1, kind: 'script' }],
    ['hc-block-insert', { index: 1 }], ['hc-route', { route: 42 }], ['hc-route', null]]) {
    assert.equal(HC.post(type, data), false, `${type} ${JSON.stringify(data)}`);
  }
  assert.equal(win.posts.length, 0);
  // a route that is not a site route is posted as '/'
  HC.post('hc-route', { route: '//evil.example/x' });
  assert.equal(win.posts[0].msg.route, '/');
  // no fields beyond the protocol's ride along
  HC.post('hc-block-select', { index: 1, html: '<img src=x onerror=alert(1)>', token: PLANTED });
  assert.deepEqual(Object.keys(win.posts[1].msg).sort(), ['index', 'nonce', 'type']);
  const live = fakeWindow({ hash: '#/about', framed: false });
  const HC2 = SRC.create(live);
  assert.equal(HC2.post('hc-ready'), false);
  assert.equal(HC2.onEditor(() => {}), false);
  assert.equal(HC2.blockPrefix, null);
  assert.equal(live.posts.length, 0);
});

test('editor mode: hc-editor reaches HC.onEditor cleaned; a forged one (source, origin, nonce) is ignored', () => {
  const win = fakeWindow({ hash: previewHash('/about') });
  const HC = SRC.create(win);
  const got = [];
  assert.equal(HC.onEditor((m) => got.push(m)), true);
  editorFrom(win, { on: true, selected: 2, settings: { diff: 'side', compact: true },
    overlay: [{ index: 1, mark: 'add' }, { index: 2, mark: 'boom' }, { index: -1, mark: 'del' }, 'x'] });
  editorFrom(win, { on: true }, { source: {} });                       // not window.parent
  editorFrom(win, { on: true }, { origin: 'https://evil.example' });   // another origin
  editorFrom(win, { on: true, nonce: 'another-nonce-123456' });        // another load's nonce
  editorFrom(win, { type: 'hc-editorx', on: true });
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], { on: true, selected: 2,
    settings: { suggestions: true, diff: 'side', compact: true, outlines: true },
    overlay: [{ index: 1, mark: 'add' }], theme: null, open: null, hot: null, locked: false, tint: 0, people: { edit: false, marks: [], focus: null }, cmd: null,
    focus: null, anchors: [],      // U3: the two new fields, empty
    peopleOwn: null, peopleAct: null, peopleAlert: null,   // U5
    facts: { edit: false, lock: false, create: false, statuses: [] } });   // U6
  // a late listener gets the last message at once
  const late = [];
  HC.onEditor((m) => late.push(m));
  assert.deepEqual(late, got);
  // wrong types fall back, never throw
  assert.deepEqual(SRC.editorMessage({ type: 'hc-editor', on: 'yes', selected: '1', settings: 'x', overlay: {} }),
    { on: false, selected: null, settings: { suggestions: true, diff: 'inline', compact: false, outlines: true }, overlay: [], theme: null, open: null, hot: null, locked: false, tint: 0, people: { edit: false, marks: [], focus: null }, cmd: null,
    focus: null, anchors: [],      // U3: the two new fields, empty
    peopleOwn: null, peopleAct: null, peopleAlert: null,   // U5
    facts: { edit: false, lock: false, create: false, statuses: [] } });   // U6
  assert.equal(SRC.editorMessage({ type: 'hc-file' }), null);
  // round 2, R1: the proposer's colour slot, a whole number 0..5, else 0
  for (const [v, want] of [[3, 3], [5, 5], [0, 0], [6, 0], [-1, 0], [2.5, 0], ['2', 0], [null, 0]]) {
    assert.equal(SRC.editorMessage({ type: 'hc-editor', on: true, tint: v }).tint, want, `tint ${v}`);
  }
  // the edit gate: locked is true only when the parent says exactly true
  for (const [v, want] of [[true, true], [false, false], ['true', false], [1, false], [undefined, false]]) {
    assert.equal(SRC.editorMessage({ type: 'hc-editor', on: true, locked: v }).locked, want, `locked ${v}`);
  }
});

test('editor mode: the sentinel prefix is the first 16 characters of this load\'s nonce', () => {
  const win = fakeWindow({ hash: previewHash('/about') });
  const HC = SRC.create(win);
  assert.equal(HC.blockPrefix, NONCE.slice(0, 16));
  assert.equal(SRC.sentinelPrefix(NONCE), NONCE.slice(0, 16));
  assert.equal(SRC.sentinelPrefix('short'), null);
  assert.equal(SRC.sentinelPrefix(null), null);
  // the insert kinds are the editor's snippet catalog
  const C = require(path.join(ROOT, 'js', 'cms-core.js'));
  assert.deepEqual([...SRC.BLOCK_INSERT_KINDS].sort(), Object.keys(C.SNIPPET_CATALOG).sort());
  assert.deepEqual([...SRC.OVERLAY_MARKS], ['add', 'del', 'change', 'conflict']);
});

test('vercel.json: every route may be framed by the site itself only (the editor preview frame is same-site)', async () => {
  const fs = await import('node:fs');
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const all = (vercel.headers || []).find((h) => h.source === '/(.*)');
  assert.ok(all, 'a header block covers every route');
  const csp = all.headers.find((h) => h.key.toLowerCase() === 'content-security-policy');
  assert.ok(csp, 'every route sends a Content-Security-Policy header');
  assert.equal(csp.value, "frame-ancestors 'self'", 'the policy is exactly frame-ancestors \'self\'');
  const xfo = all.headers.find((h) => h.key.toLowerCase() === 'x-frame-options');
  assert.ok(xfo && xfo.value === 'SAMEORIGIN', 'older browsers get X-Frame-Options: SAMEORIGIN');
});

test('typing in the page (U2): hc-editor `open` is cleaned field by field; the frame gets Markdown, never HTML', () => {
  const base = { type: 'hc-editor', on: true };
  const ok = SRC.editorMessage({ ...base, open: { index: 4, md: 'A paragraph.\n\n', kind: 'paragraph', html: '<b>x</b>' } });
  assert.deepEqual(ok.open, { index: 4, md: 'A paragraph.\n\n', kind: 'paragraph', as: null }, 'only index, md, kind and as cross');
  assert.equal(SRC.editorMessage({ ...base, open: { index: 4, md: 'x', kind: 'table', as: 'markdown' } }).open.as, 'markdown');
  assert.equal(SRC.editorMessage({ ...base, open: { index: 4, md: 'x', kind: 'table', as: '<b>' } }).open.as, null);
  for (const bad of [{ index: -1, md: 'x', kind: 'paragraph' }, { index: 1, md: 7, kind: 'paragraph' },
    { index: 1, md: 'x', kind: 'script' }, { index: 1, md: 'x'.repeat(SRC.MAX_BLOCK_MD + 1), kind: 'paragraph' }, 'x', null]) {
    assert.equal(SRC.editorMessage({ ...base, open: bad }).open, null, JSON.stringify(bad && bad.kind));
  }
});

test('typing in the page (U2): hc-block-md and hc-block-state are built from checked fields only', () => {
  assert.deepEqual(SRC.frameMessage('hc-block-md', { index: 3, md: 'New text.\n\n', extra: 1 }), { type: 'hc-block-md', index: 3, md: 'New text.\n\n' });
  assert.equal(SRC.frameMessage('hc-block-md', { index: 3, md: { html: '<b>' } }), null, 'Markdown is a string');
  assert.equal(SRC.frameMessage('hc-block-md', { index: 3, md: 'x'.repeat(SRC.MAX_BLOCK_MD + 1) }), null, 'over the cap');
  assert.equal(SRC.frameMessage('hc-block-md', { index: 'a', md: 'x' }), null);
  for (const editor of SRC.BLOCK_EDITORS) {
    assert.deepEqual(SRC.frameMessage('hc-block-state', { index: 1, editor, reason: 'why' }), { type: 'hc-block-state', index: 1, editor, reason: 'why' });
  }
  assert.equal(SRC.frameMessage('hc-block-state', { index: 1, editor: 'html' }), null);
  assert.equal(SRC.frameMessage('hc-block-state', { index: 1, editor: 'visual', reason: 'r'.repeat(900) }).reason.length, 300);
  assert.equal(SRC.frameMessage('hc-block-state', { index: 1, editor: 'visual', reason: 5 }).reason, '');
});

/* Kyle's live feedback retro (2026-10-14): the page frame is sandboxed without same-origin, so it cannot
   read the site's stored theme and drew dark content under a light site. The parent says the theme in
   the fragment (&theme=light, the one value; dark is the site's default) and again in hc-editor when it
   changes; the frame sets data-theme on its <html> and nothing else. */
test('the theme crosses into the frame: &theme=light in the fragment, theme in hc-editor, nothing else', () => {
  assert.equal(SRC.previewFragment(NONCE, '/about', 'light'), `#preview=${NONCE}&route=%2Fabout&theme=light`);
  assert.equal(SRC.previewFragment(NONCE, '/about', 'dark'), `#preview=${NONCE}&route=%2Fabout`, 'dark is the default');
  assert.equal(SRC.previewFragment(NONCE, '/', 'light'), `#preview=${NONCE}&theme=light`);
  assert.deepEqual(SRC.parsePreviewFragment(`#preview=${NONCE}&route=%2Fabout&theme=light`), { nonce: NONCE, route: '/about', theme: 'light' });
  assert.deepEqual(SRC.parsePreviewFragment(`#preview=${NONCE}&theme=x%22onload`), { nonce: NONCE, route: '/' }, 'any other value is no theme');
  const docEl = { dataset: {} };
  const win = fakeWindow({ hash: `#preview=${NONCE}&route=%2Fabout&theme=light` });
  win.document = { documentElement: docEl };
  SRC.create(win);
  assert.equal(docEl.dataset.theme, 'light', 'set before the site draws');
  assert.equal(win.location.hash, '#/about');
  const top = fakeWindow({ hash: '#/about', framed: false });
  const topEl = { dataset: {} };
  top.document = { documentElement: topEl };
  SRC.create(top);
  assert.equal(topEl.dataset.theme, undefined, 'never outside a preview');
  const base = { type: 'hc-editor', on: true };
  assert.equal(SRC.editorMessage({ ...base, theme: 'light' }).theme, 'light');
  assert.equal(SRC.editorMessage({ ...base, theme: 'dark' }).theme, 'dark');
  assert.equal(SRC.editorMessage({ ...base, theme: '<b>' }).theme, null);
  assert.equal(SRC.editorMessage(base).theme, null, 'absent: the frame keeps what it has');
});

/* U5b: the review rail. The frame reports where its MARKED blocks are (numbers only), and the parent may ask it
   to light one block (an index only). */
test('hc-block-rects carries numbers only, rounded; anything else drops the whole message', () => {
  assert.deepEqual(SRC.frameMessage('hc-block-rects', { rects: [{ index: 3, top: 10.6, height: 40.2, html: '<b>' }], view: 812.5, md: 'x' }),
    { type: 'hc-block-rects', rects: [{ index: 3, top: 11, height: 40 }], view: 813 });
  assert.deepEqual(SRC.frameMessage('hc-block-rects', { rects: [], view: 800 }), { type: 'hc-block-rects', rects: [], view: 800 });
  for (const bad of [{ rects: 'x', view: 1 }, { rects: [{ index: -1, top: 0, height: 1 }], view: 1 },
    { rects: [{ index: 1, top: NaN, height: 1 }], view: 1 }, { rects: [{ index: 1, top: 0, height: -1 }], view: 1 },
    { rects: [{ index: 1, top: 2e7, height: 1 }], view: 1 }, { rects: [], view: 'tall' },
    { rects: Array.from({ length: 5001 }, (_, i) => ({ index: i, top: 0, height: 1 })), view: 1 }]) {
    assert.equal(SRC.frameMessage('hc-block-rects', bad), null, JSON.stringify(bad).slice(0, 80));
  }
});

test('hc-editor hot: one block index to light, or nothing', () => {
  const base = { type: 'hc-editor', on: true };
  assert.equal(SRC.editorMessage({ ...base, hot: 7 }).hot, 7);
  for (const bad of [-1, 1.5, '7', null, undefined, { index: 7 }]) assert.equal(SRC.editorMessage({ ...base, hot: bad }).hot, null);
});

/* V2 (Kyle, 2026-10-14): an image block is dragged to another place in the page; the frame says only the two
   block indices. */
test('hc-block-move is built from two checked indices only', () => {
  assert.deepEqual(SRC.frameMessage('hc-block-move', { index: 4, to: 9, md: '<img>', html: 'x' }), { type: 'hc-block-move', index: 4, to: 9 });
  for (const bad of [{ index: 4, to: 4 }, { index: -1, to: 2 }, { index: 1, to: 1.5 }, { index: 1 }, { index: '1', to: 2 }, { index: 1, to: 100001 }]) {
    assert.equal(SRC.frameMessage('hc-block-move', bad), null, JSON.stringify(bad));
  }
});

/* Each project's facts in its own file (Kyle, 2026-10-14): HC.fetchProjects reads the index, then every
   listed project's data/projects/<id>.json, and merges them into the shape every page knew (id, owners, then the
   facts). A missing facts file leaves the bare entry; an id that is not a page address is not fetched. */
test('HC.fetchProjects: the index merged with each project\'s facts file, in the index\'s order', async () => {
  const files = {
    '/data/projects.json': { intro: 'All of them.', projects: [{ id: 'b-proj', add: ['x'], remove: ['y'] },
      { id: 'a-proj', add: [], remove: [] }, { id: '../evil', add: [], remove: [] }, { id: 'gone', add: [], remove: [] }] },
    '/data/projects/b-proj.json': { name: 'B', status: 'active', file: 'content/projects/b-proj.md', add: ['sneaky'],
      remove: ['x'], owners: ['old'], id: 'zzz' },
    '/data/projects/a-proj.json': { name: 'A', status: 'legacy', file: 'content/projects/a-proj.md' },
  };
  const asked = [];
  const win = fakeWindow({ hash: '#/projects' });
  const HC = SRC.create(win, { fetch: async (url) => { asked.push(url); const v = files[url.replace(/^\./, '').replace(/^(?!\/)/, '/')];
    return v ? { ok: true, status: 200, text: async () => JSON.stringify(v) } : { ok: false, status: 404, text: async () => '' }; } });
  const doc = await HC.fetchProjects();
  assert.equal(doc.intro, 'All of them.');
  assert.deepEqual(doc.projects.map((p) => p.id), ['b-proj', 'a-proj', '../evil', 'gone']);
  assert.deepEqual(doc.projects[0], { id: 'b-proj', add: ['x'], remove: ['y'], name: 'B', status: 'active',
    file: 'content/projects/b-proj.md' }, 'the index\'s id, add and remove win; a facts file cannot widen access');
  assert.deepEqual(Object.keys(doc.projects[1]), ['id', 'add', 'remove', 'name', 'status', 'file']);
  assert.deepEqual(doc.projects[3], { id: 'gone', add: [], remove: [] }, 'no facts file: the bare entry');
  assert.ok(!asked.some((u) => u.includes('evil')), 'an id that is not a page address is never fetched');
  assert.deepEqual(SRC.mergeProjects({ projects: [{ id: 'a', add: [], remove: [] }] }, [{ name: 'A' }]).projects[0],
    { id: 'a', add: [], remove: [], name: 'A' });
  assert.equal(SRC.mergeProjects(null, []), null);
});

// ---- round 2, R5: the Team page's people tools ----
test('hc-people (frame -> parent): an order of names with pins, or "+" for a list; anything else posts nothing', () => {
  const ok = SRC.frameMessage('hc-people', { op: 'order', team: [{ name: 'Ann', pinned: true, x: 1 }], alumni: [{ name: 'Ben' }] });
  assert.deepEqual(ok, { type: 'hc-people', op: 'order', team: [{ name: 'Ann', pinned: true }], alumni: [{ name: 'Ben', pinned: false }], focus: null, act: null });
  assert.equal(SRC.frameMessage('hc-people', { op: 'order', team: [{ name: 'Ann' }], alumni: [], focus: 'Ann' }).focus, 'Ann');
  assert.deepEqual(SRC.frameMessage('hc-people', { op: 'add', group: 'alumni' }), { type: 'hc-people', op: 'add', group: 'alumni' });
  assert.equal(SRC.frameMessage('hc-people', { op: 'add', group: 'staff' }), null);
  assert.equal(SRC.frameMessage('hc-people', { op: 'drop', name: 'Ann' }), null);
  assert.equal(SRC.frameMessage('hc-people', { op: 'order', team: [{ name: '' }], alumni: [] }), null);
  assert.equal(SRC.frameMessage('hc-people', { op: 'order', team: [{ name: 'x'.repeat(201) }], alumni: [] }), null);
  assert.equal(SRC.frameMessage('hc-people', { op: 'order', team: 'Ann', alumni: [] }), null);
  assert.equal(SRC.frameMessage('hc-people', { op: 'order', team: new Array(501).fill({ name: 'a' }), alumni: [] }), null);
});

test('hc-editor.people (parent -> frame): edit on/off and the marks, cleaned', () => {
  const m = SRC.editorMessage({ type: 'hc-editor', on: true, people: { edit: true,
    marks: [{ name: 'Ann', mark: 'add' }, { name: 'Dot', mark: 'del', group: 'alumni', title: 'D' }, { name: 'X', mark: 'boom' }, { name: 5, mark: 'add' }] } });
  assert.deepEqual(m.people, { edit: true, marks: [{ name: 'Ann', mark: 'add', group: null, title: '' },
    { name: 'Dot', mark: 'del', group: 'alumni', title: 'D' }], focus: null });
  assert.deepEqual(SRC.editorMessage({ type: 'hc-editor', on: true }).people, { edit: false, marks: [], focus: null });
  assert.deepEqual(SRC.editorMessage({ type: 'hc-editor', on: true, people: { edit: 'yes', focus: 'Ann' } }).people, { edit: false, marks: [], focus: 'Ann' });
});

// ---- round 2, R2b: Undo / Redo ----
test('hc-history and hc-key (frame -> parent); hc-editor.cmd (parent -> frame): checked field by field', () => {
  assert.deepEqual(SRC.frameMessage('hc-history', { index: 4, snap: 'f2-7', x: 1 }), { type: 'hc-history', index: 4, snap: 'f2-7' });
  assert.equal(SRC.frameMessage('hc-history', { index: 4, snap: '<b>' }), null);
  assert.equal(SRC.frameMessage('hc-history', { index: -1, snap: 'f1-1' }), null);
  assert.deepEqual(SRC.frameMessage('hc-key', { op: 'undo' }), { type: 'hc-key', op: 'undo' });
  assert.deepEqual(SRC.frameMessage('hc-key', { op: 'redo' }), { type: 'hc-key', op: 'redo' });
  assert.deepEqual(SRC.frameMessage('hc-key', { op: 'redraw' }), { type: 'hc-key', op: 'redraw' });
  assert.equal(SRC.frameMessage('hc-key', { op: 'save' }), null);
  const m = (cmd) => SRC.editorMessage({ type: 'hc-editor', on: true, cmd }).cmd;
  assert.deepEqual(m({ n: 3, op: 'restore', index: 2, snap: 'f1-1', save: 'u4' }), { n: 3, op: 'restore', index: 2, snap: 'f1-1', save: 'u4' });
  assert.equal(m({ n: 3, op: 'restore', index: 2, snap: 'f1-1' }), null, 'save is required');
  assert.equal(m({ n: 0, op: 'restore', index: 2, snap: 'f1-1', save: 'u1' }), null, 'n counts from 1');
  assert.equal(m({ n: 3, op: 'erase', index: 2, snap: 'f1-1', save: 'u1' }), null);
  assert.equal(m(undefined), null);
});

/* Per-unit blocks (editor UI/UX build, U0): each unit's paired bridge tests (a well-formed message passes, a
   malformed one is dropped) go in its own block. */
/* ---- U7 ---- */
// U7b: the window's width (the frame is narrower than the window above 900 px; rules keyed on the window read it)
test('U7b: hc-editor carries the window\'s width: a number, rounded and clamped 200-4000', () => {
  const w = (width) => SRC.editorMessage({ type: 'hc-editor', on: true, width }).width;
  assert.equal(w(1100), 1100);
  assert.equal(w(1100.6), 1101);
  assert.equal(w(120), 200, 'clamped up');
  assert.equal(w(9000), 4000, 'clamped down');
});

test('U7b: a malformed width is dropped (no width field at all)', () => {
  for (const width of [undefined, null, '1100', NaN, Infinity, -Infinity, true, {}, [1100]]) {
    const m = SRC.editorMessage({ type: 'hc-editor', on: true, width });
    assert.equal(Object.prototype.hasOwnProperty.call(m, 'width'), false, `width ${String(width)}`);
  }
});

/* ---- U4 ---- */

const IMG = 'https://res.cloudinary.com/demo/image/upload/v1/hippocampus-docs/setup/a.png';

test('U4 bridge: hc-marks passes an index and an HTML string; drops a wrong type, an over-long one, a bad index', () => {
  assert.deepEqual(SRC.frameMessage('hc-marks', { index: 2, html: '<p>a<ins data-hc-sug="ins">b</ins></p>', md: 'x' }),
    { type: 'hc-marks', index: 2, html: '<p>a<ins data-hc-sug="ins">b</ins></p>' });
  assert.deepEqual(SRC.frameMessage('hc-marks', { index: 2, html: '' }), { type: 'hc-marks', index: 2, html: '' }, '"" = no marks left');
  for (const bad of [{ index: 2, html: 5 }, { index: -1, html: '' }, { index: 2, html: 'x'.repeat(200001) }, { html: '' }]) {
    assert.equal(SRC.frameMessage('hc-marks', bad), null, JSON.stringify(bad).slice(0, 60));
  }
});

test('U4 bridge: hc-note passes plain text up to 2000 characters; hc-media-list carries nothing; hc-image-use only a Cloudinary address', () => {
  assert.deepEqual(SRC.frameMessage('hc-note', { index: 4, text: 'Check the wiring.', key: 'x' }), { type: 'hc-note', index: 4, text: 'Check the wiring.' });
  assert.equal(SRC.frameMessage('hc-note', { index: 4, text: 'x'.repeat(2001) }), null);
  assert.equal(SRC.frameMessage('hc-note', { index: 4, text: ['a'] }), null);
  assert.deepEqual(SRC.frameMessage('hc-media-list', { evil: '<b>' }), { type: 'hc-media-list' });
  assert.deepEqual(SRC.frameMessage('hc-image-use', { index: 3, url: IMG }), { type: 'hc-image-use', index: 3, url: IMG });
  for (const url of ['https://evil.example/a.png', 'javascript:alert(1)', `${IMG}" onerror="x`, 5, `${IMG} x`]) {
    assert.equal(SRC.frameMessage('hc-image-use', { index: 3, url }), null, String(url));
  }
});

test('U4 bridge: hc-editor marks / notes / media are cleaned entry by entry and absent when not sent', () => {
  const base = { type: 'hc-editor', on: true };
  const plain = SRC.editorMessage(base);
  assert.equal('marks' in plain || 'notes' in plain || 'media' in plain, false, 'absent when the parent did not send them');
  const m = SRC.editorMessage(Object.assign({}, base, {
    marks: [{ index: 1, html: '<p>x</p>', md: 'x\n', orig: 'y\n', kind: 'paragraph', extra: 1 }, { index: 2, html: 5, md: '', orig: '', kind: 'paragraph' },
      { index: 3, html: '', md: '', orig: '', kind: 'script' }, null],
    notes: [{ index: 1, text: 'see' }, { index: 'x', text: 'no' }, { index: 2, text: 'y'.repeat(2001) }],
    media: [{ url: IMG, label: 'a', x: 1 }, { url: 'https://evil.example/b.png', label: 'b' }, { url: IMG, label: 7 }],
  }));
  assert.deepEqual(m.marks, [{ index: 1, html: '<p>x</p>', md: 'x\n', orig: 'y\n', kind: 'paragraph' }]);
  assert.deepEqual(m.notes, [{ index: 1, text: 'see' }]);
  assert.deepEqual(m.media, [{ url: IMG, label: 'a' }, { url: IMG, label: '' }]);
  assert.equal(SRC.editorMessage(Object.assign({}, base, { media: 'x' })).media, undefined, 'a non-list is dropped');
});

/* ---- U5 ---- */
test('U5 hc-people (frame -> parent): field, remove and add-in-place pass cleaned; an order carries its Move button', () => {
  const f = (d) => SRC.frameMessage('hc-people', d);
  assert.deepEqual(f({ op: 'field', name: 'Ann', field: 'name', value: 'Anna', x: 1 }), { type: 'hc-people', op: 'field', name: 'Ann', field: 'name', value: 'Anna' });
  assert.deepEqual(f({ op: 'field', name: 'Ann', field: 'title', value: '' }), { type: 'hc-people', op: 'field', name: 'Ann', field: 'title', value: '' });
  assert.deepEqual(f({ op: 'field', name: 'Ann', field: 'photo' }), { type: 'hc-people', op: 'field', name: 'Ann', field: 'photo' }, 'ask for the file');
  assert.deepEqual(f({ op: 'remove', name: 'Ben' }), { type: 'hc-people', op: 'remove', name: 'Ben' });
  assert.deepEqual(f({ op: 'add-in-place', group: 'team', login: ' @ann-b ', name: 'Ann B', title: 'Student', link: 'https://x.org', photo: true, extra: 1 }),
    { type: 'hc-people', op: 'add-in-place', group: 'team', login: 'ann-b', name: 'Ann B', title: 'Student', link: 'https://x.org', photo: true });
  assert.deepEqual(f({ op: 'add-in-place', group: 'alumni', login: '', name: '' }),
    { type: 'hc-people', op: 'add-in-place', group: 'alumni', login: '', name: '', title: '', link: '', photo: false }, 'the parent says what is missing');
  assert.equal(f({ op: 'order', team: [{ name: 'Ann' }], alumni: [], act: 'down' }).act, 'down');
  assert.equal(f({ op: 'order', team: [{ name: 'Ann' }], alumni: [], act: 'jump' }).act, null);
});

test('U5 hc-people (frame -> parent): malformed field, remove and add-in-place messages post nothing', () => {
  const f = (d) => SRC.frameMessage('hc-people', d);
  assert.equal(f({ op: 'field', name: 'Ann', field: 'link', value: 'x' }), null, 'only name, title, photo');
  assert.equal(f({ op: 'field', name: 'Ann', field: 'name' }), null, 'a name needs a value');
  assert.equal(f({ op: 'field', name: '', field: 'name', value: 'x' }), null);
  assert.equal(f({ op: 'field', name: 'Ann', field: 'title', value: 7 }), null);
  assert.equal(f({ op: 'field', name: 'Ann', field: 'title', value: 'x'.repeat(501) }), null);
  assert.equal(f({ op: 'remove', name: { toString: () => 'Ann' } }), null);
  assert.equal(f({ op: 'add-in-place', group: 'staff', login: '', name: 'A' }), null);
  assert.equal(f({ op: 'add-in-place', group: 'team', login: 'not a login', name: 'A' }), null);
  assert.equal(f({ op: 'add-in-place', group: 'team', login: 'a', name: 'x'.repeat(201) }), null);
  assert.equal(f({ op: 'add-in-place', group: 'team', name: 'A' }), null, 'login is always sent ("" for none)');
  assert.equal(f({ op: 'erase', name: 'Ann' }), null);
});

test('U5 hc-editor (parent -> frame): people.own, people.act and people.alert, cleaned', () => {
  const e = (people) => SRC.editorMessage({ type: 'hc-editor', on: true, people });
  const ok = e({ edit: false, marks: [], focus: 'Ann', own: 'Kyle Nelson', act: 'up', alert: 'No.' });
  assert.deepEqual([ok.peopleOwn, ok.peopleAct, ok.peopleAlert], ['Kyle Nelson', 'up', 'No.']);
  const bad = e({ own: 7, act: 'fly', alert: { x: 1 } });
  assert.deepEqual([bad.peopleOwn, bad.peopleAct, bad.peopleAlert], [null, null, null]);
  const none = SRC.editorMessage({ type: 'hc-editor', on: true });
  assert.deepEqual([none.peopleOwn, none.peopleAct, none.peopleAlert], [null, null, null]);
  assert.equal(e({ alert: 'x'.repeat(400) }).peopleAlert.length, 300);
});

/* ---- U6 ---- */
// plan D17: hc-facts {field, value}; hc-new-project and hc-access-ask (no fields); hc-editor.facts
test('U6 hc-facts (frame -> parent): each field passes well-formed and is dropped malformed', () => {
  const f = (d) => SRC.frameMessage('hc-facts', d);
  assert.deepEqual(f({ field: 'name', value: 'Core stack', x: 1 }), { type: 'hc-facts', field: 'name', value: 'Core stack' });
  assert.deepEqual(f({ field: 'tagline', value: '' }), { type: 'hc-facts', field: 'tagline', value: '' }, 'the parent says why it is refused');
  assert.equal(f({ field: 'name', value: 'x'.repeat(301) }), null);
  assert.equal(f({ field: 'name', value: 7 }), null);
  assert.deepEqual(f({ field: 'status', value: 'legacy' }), { type: 'hc-facts', field: 'status', value: 'legacy' });
  assert.equal(f({ field: 'status', value: 'Legacy!' }), null);
  assert.deepEqual(f({ field: 'repos', value: ['hippo_core', 'a.b-c'] }), { type: 'hc-facts', field: 'repos', value: ['hippo_core', 'a.b-c'] });
  assert.deepEqual(f({ field: 'repos', value: [] }), { type: 'hc-facts', field: 'repos', value: [] });
  assert.equal(f({ field: 'repos', value: ['a b'] }), null);
  assert.equal(f({ field: 'repos', value: 'hippo_core' }), null);
  assert.equal(f({ field: 'repos', value: Array(201).fill('a') }), null);
  assert.equal(f({ field: 'file', value: 'content/x.md' }), null);
  assert.equal(f(null), null);
});

test('U6 hc-new-project and hc-access-ask (frame -> parent): the type alone, any other field dropped', () => {
  assert.deepEqual(SRC.frameMessage('hc-new-project', { id: 'x' }), { type: 'hc-new-project' });
  assert.deepEqual(SRC.frameMessage('hc-access-ask', { login: 'x' }), { type: 'hc-access-ask' });
});

test('U6 hc-editor.facts (parent -> frame): booleans only when true, the statuses as plain words', () => {
  const f = (facts) => SRC.editorMessage({ type: 'hc-editor', on: true, facts }).facts;
  assert.deepEqual(f({ edit: true, lock: false, create: true, statuses: ['active', 'legacy'] }),
    { edit: true, lock: false, create: true, statuses: ['active', 'legacy'] });
  assert.deepEqual(f({ edit: 'yes', lock: 1, create: 'true', statuses: ['<b>', 'archive', 3] }),
    { edit: false, lock: false, create: false, statuses: ['archive'] });
  assert.deepEqual(f(undefined), { edit: false, lock: false, create: false, statuses: [] });
  assert.equal(f({ statuses: Array(20).fill('active') }).statuses.length, 12);
});
