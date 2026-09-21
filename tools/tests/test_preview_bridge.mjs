// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 21 September 2026
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
