// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 14 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Run the R3 block-sentinel oracles (b) and (c) in a real headless Chrome over every content page.
/* R3 oracles (b) and (c) (plan D-E), the repo's first scripted Chrome test.
   Oracle (a) — the blocks join back to the file — runs in node
   (tools/tests/test_block_model.mjs); (b) and (c) are questions about the
   HTML tree builder, which node has none of, so they run here:

     (b) render-equivalence: a page rendered with HCCore.withSentinels(text),
         sentinels then removed from the DOM, equals the page rendered
         without them;
     (c) every sentinel is in the DOM and a DIRECT child of the page body;
     (d) grouping (U6): once the parent page posts the frame hc-editor
         {on: true}, js/editor-frame.js wraps the body's children between
         sentinels into one .hc-block[data-index] per sentinel, in order,
         losing and reordering nothing (oracle_parent.html has the rule).
     (e) the converter (js/editor-md.js, editor redesign U1): Chrome and node's DOM shim choose the
         same editor for every block, and real contenteditable typing round-trips (oracle_md.html).

   How: this file starts its OWN static server (node http, 127.0.0.1, an
   ephemeral port, the worktree root served as-is), finds Chrome (CHROME,
   else the macOS app, else google-chrome / chromium on PATH — no Chrome is a
   FAILURE, never a skip) and runs
     chrome --headless=new --disable-gpu --user-data-dir=<fresh> \
            --virtual-time-budget=<ms> --dump-dom \
            http://127.0.0.1:<port>/tools/tests/oracle_parent.html?pages=<batch>[&neg=1]
   over batches of content pages, a few Chrome processes at a time. The
   parent page renders the real site in an unsandboxed same-origin iframe,
   answers its bridge requests from the local files, judges each page and
   writes one verdict line per page into its own DOM; --dump-dom prints it.
   The test asserts one PASS per content/**\/*.md file (the verdict count is
   the file count) and that the ONE synthetic negative page — a sentinel
   inside an unclosed <div> — comes out FAIL on (c). Two refused `pages`
   values (a file outside the bridge allowlist, and a protocol-relative
   //host value) must come out FAIL with no request made for them.

   Hermetic: no request leaves the machine. Content pages and index.html
   name res.cloudinary.com images, and Chrome's background services phone
   home, so every Chrome gets
     --host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"  (every host
         but the loopback server fails to resolve)
     --disable-background-networking --disable-component-update --no-pings
     --disable-sync --disable-default-apps --no-first-run
     --no-default-browser-check --safebrowsing-disable-auto-update
   Unresolved images do not change a verdict: (b) compares two renders of
   the same page, both without them.
   The loopback server itself refuses dotfiles and dot-folders (.env.local,
   .git/…) and any symlink whose real path leaves the worktree (404).

   macOS quirk (seen in U0): headless Chrome does not always exit after
   --dump-dom, and its crash-report helper keeps inherited output pipes open.
   So Chrome writes to FILES, the test watches them for the finished dump,
   then stops Chrome itself (SIGTERM, then SIGKILL) under a hard time limit.
   The server and every Chrome are stopped in a finally.

   Runtime: about 5 s on the build Mac since the hermetic flags (measured
   4.3 s; 10-15 s before them): 92 pages, 8 batches of 12, 4 Chromes at a
   time; the target is <= 3 minutes, the test's hard limit 8.

     node --test tools/tests/browser_oracles.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, readFileSync, readdirSync, openSync, closeSync,
  realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const BATCH = 12;
const PARALLEL = 4;
const BUDGET_MS = 600000;            // virtual time: it only runs while the page is idle
const CHROME_LIMIT_MS = 180000;      // real time, per Chrome
const NEG_FILE = 'synthetic:unclosed-div';
const REFUSED_PAGES = ['README.md', '//evil.example/x'];
/* Hermetic: no request leaves the machine (see the header). */
const HERMETIC = ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
  '--disable-background-networking', '--disable-component-update', '--no-pings', '--disable-sync',
  '--disable-default-apps', '--no-first-run', '--no-default-browser-check', '--safebrowsing-disable-auto-update'];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function contentFiles(dir = path.join(ROOT, 'content')) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return contentFiles(p);
    return e.name.endsWith('.md') ? [path.relative(ROOT, p).split(path.sep).join('/')] : [];
  }).sort();
}

function findChrome() {
  if (process.env.CHROME) {
    if (existsSync(process.env.CHROME)) return process.env.CHROME;
    throw new Error(`CHROME=${process.env.CHROME} does not exist`);
  }
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(mac)) return mac;
  for (const name of ['google-chrome', 'chromium']) {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      const p = path.join(dir, name);
      if (dir && existsSync(p)) return p;
    }
  }
  throw new Error('no Chrome found: set CHROME, install Google Chrome, or put google-chrome/chromium on PATH');
}

/* Serves `root` read-only. Refused with a 404: any path segment starting
   with "." (.env.local, .git/…, and every ".." however it was encoded), and
   any file whose real path (symlinks resolved) is outside the real root. */
function startServer(root, seen) {
  const realRoot = realpathSync(root);
  const inRoot = (p) => p === realRoot || p.startsWith(realRoot + path.sep);
  const resolveFile = (rel) => {
    if (rel === null || rel.split(/[\\/]/).some((seg) => seg.startsWith('.'))) return null;
    try {
      let real = realpathSync(path.join(realRoot, rel));
      if (!inRoot(real)) return null;
      if (statSync(real).isDirectory()) real = realpathSync(path.join(real, 'index.html'));
      return inRoot(real) && statSync(real).isFile() ? real : null;
    } catch { return null; }                      // missing file, broken link
  };
  const server = createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { rel = null; }
    seen.push(rel === null ? req.url : rel);      // the path only: the parent's own query names the refused values
    const file = resolveFile(rel);
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/* Chrome's output goes to FILES (see the header); `done(stdout)` says when
   the dump is complete, then Chrome is stopped. The limit is the ceiling. */
function runChrome(chrome, args, limitMs, scratch, done, live) {
  const dir = mkdtempSync(path.join(scratch, 'io-'));
  const outPath = path.join(dir, 'stdout');
  const errPath = path.join(dir, 'stderr');
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  const read = () => [readFileSync(outPath, 'utf8'), readFileSync(errPath, 'utf8')];
  return new Promise((resolve) => {
    const child = spawn(chrome, args, { stdio: ['ignore', outFd, errFd] });
    live.add(child);
    let settled = false;
    let how = 'exited';
    const stop = (why) => {
      how = why;
      child.kill('SIGTERM');
      setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000).unref();
    };
    const poll = setInterval(() => {
      if (done(read()[0])) { clearInterval(poll); setTimeout(() => stop('stopped after output'), 300); }
    }, 200);
    const timer = setTimeout(() => { clearInterval(poll); stop(`killed at the ${limitMs} ms ceiling`); }, limitMs);
    const finish = (code, extra = '') => {
      if (settled) return;
      settled = true;
      live.delete(child);
      clearInterval(poll);
      clearTimeout(timer);
      closeSync(outFd);
      closeSync(errFd);
      const [out, err] = read();
      resolve({ code, how, stdout: out, stderr: err + extra });
    };
    child.once('error', (e) => finish(-1, String(e)));
    child.once('exit', (code, signal) => finish(code ?? signal));
  });
}

const unescapeHtml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/* The verdict lines of one dumped parent page, or null when it never
   finished (no #done). */
function verdictsOf(html) {
  if (!/<p id="done">/.test(html)) return null;
  const m = /<pre id="verdicts">([\s\S]*?)<\/pre>/.exec(html);
  return m ? unescapeHtml(m[1]).split('\n').filter(Boolean) : [];
}

async function inPool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

/* The loopback server serves the worktree root and nothing else: no dotfile
   or dot-folder (.env.local, .git/…), and no symlink that leaves the root. */
test('oracle server: refuses dotfiles and symlink escapes, serves plain files', async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'hc-oracle-srv-'));
  let server = null;
  try {
    const root = path.join(scratch, 'root');
    const outside = path.join(scratch, 'outside');
    mkdirSync(path.join(root, '.git'), { recursive: true });
    mkdirSync(path.join(root, 'sub'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(root, 'ok.txt'), 'ok');
    writeFileSync(path.join(root, 'sub', 'index.html'), '<p>sub</p>');
    writeFileSync(path.join(root, '.env.local'), 'SECRET=1');
    writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main');
    writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    symlinkSync(outside, path.join(root, 'linkdir'));
    symlinkSync(path.join(root, 'ok.txt'), path.join(root, 'inside-link.txt'));
    server = await startServer(root, []);
    const base = `http://127.0.0.1:${server.address().port}`;
    const status = async (u) => (await fetch(base + u)).status;
    assert.equal(await status('/ok.txt'), 200);
    assert.equal(await status('/sub/'), 200);
    assert.equal(await status('/inside-link.txt'), 200, 'a symlink that stays inside the root is served');
    for (const u of ['/.env.local', '/.git/HEAD', '/%2Eenv.local', '/sub/../.env.local', '/link.txt',
      '/linkdir/secret.txt', '/../outside/secret.txt', '/%2e%2e/outside/secret.txt']) {
      assert.equal(await status(u), 404, `${u} is refused`);
    }
  } finally {
    if (server) { server.closeAllConnections?.(); server.close(); }
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('R3 oracles (b) and (c): every content page, with sentinels, renders the same and keeps every sentinel top-level', { timeout: 480000 }, async () => {
  const t0 = Date.now();
  const files = contentFiles();
  assert.ok(files.length >= 90, `expected the whole content tree, found ${files.length}`);
  const chrome = findChrome();                       // no Chrome: this test FAILS
  const scratch = mkdtempSync(path.join(tmpdir(), 'hc-oracles-'));
  const live = new Set();
  let server = null;
  const seen = [];
  try {
    server = await startServer(ROOT, seen);
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const u of ['/.env.local', '/.git/HEAD', '/.gitignore']) {     // .gitignore exists: a refusal, not a miss
      assert.equal((await fetch(origin + u)).status, 404, `the oracle server refuses ${u}`);
    }
    const base = `${origin}/tools/tests/oracle_parent.html`;
    const batches = [];
    for (let i = 0; i < files.length; i += BATCH) batches.push(files.slice(i, i + BATCH));
    const runs = await inPool(batches, PARALLEL, async (batch, i) => {
      const pages = i === 0 ? batch.concat(REFUSED_PAGES) : batch;
      const url = `${base}?pages=${encodeURIComponent(pages.join(','))}${i === 0 ? '&neg=1' : ''}`;
      const args = ['--headless=new', '--disable-gpu', ...HERMETIC,
        `--user-data-dir=${mkdtempSync(path.join(scratch, `profile-${i}-`))}`,
        `--virtual-time-budget=${BUDGET_MS}`, '--dump-dom', url];
      const r = await runChrome(chrome, args, CHROME_LIMIT_MS, scratch, (out) => /<\/html>\s*$/i.test(out), live);
      return { batch, r, verdicts: verdictsOf(r.stdout) };
    });

    const lines = [];
    for (const { batch, r, verdicts } of runs) {
      assert.ok(verdicts, `a Chrome batch did not finish (chrome ${r.how}, exit ${r.code}): ${batch[0]} …`
        + ` stderr: ${r.stderr.slice(-300)}`);
      lines.push(...verdicts);
    }
    const fileOf = (l) => l.split(' ')[1];
    const refused = lines.filter((l) => REFUSED_PAGES.includes(fileOf(l)));
    assert.deepEqual(refused.map(fileOf).sort(), [...REFUSED_PAGES].sort(), 'each refused value is judged once');
    assert.ok(refused.every((l) => /^FAIL \S+ refused: not a bridge path/.test(l)), `refused values FAIL: ${refused.join(' | ')}`);
    assert.ok(!seen.some((u) => /README\.md|evil/.test(u)), 'no request was made for a refused value');
    const real = lines.filter((l) => fileOf(l) !== NEG_FILE && !REFUSED_PAGES.includes(fileOf(l)));
    const neg = lines.filter((l) => fileOf(l) === NEG_FILE);
    const failed = real.filter((l) => !l.startsWith('PASS '));
    assert.deepEqual(failed, [], 'every content page passes (b) and (c)');
    assert.equal(real.length, files.length, 'one verdict per content/**/*.md file');
    assert.deepEqual(real.map(fileOf).sort(), files, 'each content file judged exactly once');
    assert.equal(neg.length, 1, 'the synthetic negative page was judged');
    assert.match(neg[0], /^FAIL synthetic:unclosed-div .*\(c\) .*not a direct child/,
      'a sentinel inside an unclosed <div> is caught');
    const num = (l, k) => Number((new RegExp(` ${k}=(\\d+)`).exec(l) || [])[1]);
    const sentinels = real.reduce((n, l) => n + num(l, 'sentinels'), 0);
    assert.ok(real.every((l) => num(l, 'sentinels') > 0 && num(l, 'dom') > 100), 'every page rendered a real body with sentinels');
    assert.deepEqual(real.filter((l) => num(l, 'groups') !== num(l, 'sentinels')), [],
      '(d) every page is grouped into exactly one block per sentinel');
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`browser oracles: ${real.length} PASS over ${files.length} content pages (${sentinels} sentinels checked `
      + 'and grouped), '
      + `negative FAIL as it must; ${secs} s`);
  } finally {
    for (const child of live) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    if (server) { server.closeAllConnections?.(); server.close(); }
    rmSync(scratch, { recursive: true, force: true });
  }
});

/* Oracle (e), editor redesign U1: js/editor-md.js decides the SAME editor for every block in a real
   Chrome DOM as it does under node's DOM shim (tools/tests/test_editor_md.mjs runs the floors there),
   and real contenteditable typing (execCommand) serializes to Markdown that renders back to the
   typed text: no-break spaces, Shift+Enter line breaks, Markdown-special characters. */
test('oracle (e): the converter decides the same editors in Chrome as under node, and real typing round-trips', { timeout: 300000 }, async () => {
  const { ShimDOMParser } = await import('./fixtures/dom_shim.mjs');
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const saved = globalThis.DOMParser;
  globalThis.DOMParser = ShimDOMParser;
  const M = req(path.join(ROOT, 'js', 'editor-md.js'));
  const C = req(path.join(ROOT, 'js', 'cms-core.js'));
  const LETTER = { visual: 'v', code: 'c', box: 'b', image: 'i', markdown: 'm' };
  const files = contentFiles();
  const nodeLetters = new Map(files.map((f) => [f, C.splitBlocks(readFileSync(path.join(ROOT, f), 'utf8')).blocks
    .filter((b) => b.kind !== 'space').map((b) => LETTER[M.editorFor(b)] || '?').join('')]));
  globalThis.DOMParser = saved;
  const chrome = findChrome();
  const scratch = mkdtempSync(path.join(tmpdir(), 'hc-oracle-md-'));
  const live = new Set();
  let server = null;
  try {
    server = await startServer(ROOT, []);
    const base = `http://127.0.0.1:${server.address().port}/tools/tests/oracle_md.html`;
    const batches = [];
    for (let i = 0; i < files.length; i += BATCH) batches.push(files.slice(i, i + BATCH));
    const runs = await inPool(batches, PARALLEL, async (batch, i) => {
      const url = `${base}?pages=${encodeURIComponent(batch.join(','))}${i === 0 ? '&typing=1' : ''}`;
      const args = ['--headless=new', '--disable-gpu', ...HERMETIC,
        `--user-data-dir=${mkdtempSync(path.join(scratch, `profile-${i}-`))}`,
        `--virtual-time-budget=${BUDGET_MS}`, '--dump-dom', url];
      const r = await runChrome(chrome, args, CHROME_LIMIT_MS, scratch, (o) => /<\/html>\s*$/i.test(o), live);
      return { batch, r, verdicts: verdictsOf(r.stdout) };
    });
    const lines = [];
    for (const { batch, r, verdicts } of runs) {
      assert.ok(verdicts, `a Chrome batch did not finish (chrome ${r.how}): ${batch[0]} … ${r.stderr.slice(-300)}`);
      lines.push(...verdicts);
    }
    const typing = lines.filter((l) => / typing:/.test(` ${l.split(' ')[1]}`) || /^(PASS|FAIL) typing:/.test(l));
    assert.equal(typing.length, 5, 'five typing cases ran');
    assert.deepEqual(typing.filter((l) => !l.startsWith('PASS')), [], 'real contenteditable typing round-trips');
    const pages = lines.filter((l) => !/^(PASS|FAIL) typing:/.test(l));
    assert.equal(pages.length, files.length, `one verdict per content page:\n${pages.filter((l) => !/^PASS content/.test(l)).slice(0, 12).join('\n')}`);
    const differ = [];
    for (const l of pages) {
      const [verdict, file, field] = l.split(' ');
      assert.equal(verdict, 'PASS', l);
      const got = (field || '').replace(/^editors=/, '');
      if (got !== nodeLetters.get(file)) differ.push(`${file}: chrome ${got} node ${nodeLetters.get(file)}`);
    }
    assert.deepEqual(differ, [], 'Chrome and the node shim choose the same editor for every block');
    const all = [...nodeLetters.values()].join('');
    console.log(`oracle (e): ${pages.length} pages, ${all.length} blocks, same editors in Chrome and node; typing 5/5`);
  } finally {
    for (const child of live) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    if (server) { server.closeAllConnections?.(); server.close(); }
    rmSync(scratch, { recursive: true, force: true });
  }
});

/* Editor redesign U2, end to end in a real Chrome over DevTools: the REAL site in Editor mode
   (tools/tests/editor_walk.html?step=on, the fake GitHub), a click on a paragraph INSIDE the
   sandboxed page frame, real typing (Input.insertText) and real Backspace key presses. Asserts:
   the block opens for typing in the page; typing is a suggestion (inserted text marked, deleted
   text struck, deleting your own inserted text removes it); the parent's draft holds exactly the
   new Markdown for that block's span; the page frame is NEVER reloaded (same src, same nonce) and
   the frame's scroll position does not move (the old "page jumped" bug). */
test('U2 walk: typing in the page in a real Chrome: suggestions, the draft by span, no reload, no jump', { timeout: 120000 }, async () => {
  const chrome = findChrome();
  const scratch = mkdtempSync(path.join(tmpdir(), 'hc-u2-walk-'));
  let server = null;
  let child = null;
  try {
    server = await startServer(ROOT, []);
    const origin = `http://127.0.0.1:${server.address().port}`;
    child = spawn(chrome, ['--headless=new', '--disable-gpu', ...HERMETIC, '--window-size=1280,900',
      `--user-data-dir=${mkdtempSync(path.join(scratch, 'profile-'))}`, '--remote-debugging-port=0', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let port = null;
    for (let i = 0; i < 150 && !port; i++) { const m = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(err); if (m) port = m[1]; else await sleep(100); }
    assert.ok(port, 'Chrome DevTools came up');
    const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => { ws.onopen = r; });
    let id = 0;
    const pend = new Map();
    const contexts = new Map();
    // the sandboxed page frame runs out of process: DevTools attaches to it as its own target (flatten)
    const sendTo = (sessionId, method, params = {}) => new Promise((r) => { const n = ++id; pend.set(n, r);
      ws.send(JSON.stringify(Object.assign({ id: n, method, params }, sessionId ? { sessionId } : {}))); });
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      const sid = m.sessionId || null;
      if (m.method === 'Runtime.executionContextCreated') contexts.set(`${sid}:${m.params.context.id}`, { sid, id: m.params.context.id, ctx: m.params.context });
      if (m.method === 'Runtime.executionContextDestroyed') contexts.delete(`${sid}:${m.params.executionContextId}`);
      if (m.method === 'Runtime.executionContextsCleared') for (const k of [...contexts.keys()]) if (k.startsWith(`${sid}:`)) contexts.delete(k);
      if (m.method === 'Target.attachedToTarget') {
        const s2 = m.params.sessionId;
        sendTo(s2, 'Runtime.enable');
        sendTo(s2, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
        sendTo(s2, 'Runtime.runIfWaitingForDebugger');
      }
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    };
    const send = (method, params = {}) => sendTo(null, method, params);
    const ev = async (expression, where) => {
      const params = Object.assign({ expression, returnByValue: true, awaitPromise: true }, where ? { contextId: where.id } : {});
      const r = await sendTo(where ? where.sid : null, 'Runtime.evaluate', params);
      if (r.result && r.result.exceptionDetails) throw new Error(`${expression.slice(0, 80)}: ${JSON.stringify(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description)}`);
      return r.result && r.result.result ? r.result.result.value : undefined;
    };
    const until = async (fn, what, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(100); } };
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await send('Page.navigate', { url: `${origin}/tools/tests/editor_walk.html?step=on&page=/setup/lab-gantry/usage` });
    await until(() => ev("document.body && document.body.getAttribute('data-walk-step')").then((s) => s === 'on:ready' || (s && s.endsWith(':failed') ? Promise.reject(new Error(s)) : false)), 'the walk at "on"');
    // the editor's page frame: the one execution context whose HC is a preview
    const frameCtx = async () => {
      for (const c of contexts.values()) {
        if (!c.ctx.auxData || !c.ctx.auxData.isDefault) continue;
        try { if (await ev("typeof HC !== 'undefined' && HC.preview === true && !!document.querySelector('.hc-block')", c)) return c; } catch (e) { /* gone */ }
      }
      return null;
    };
    const F = await until(frameCtx, 'the page frame grouped');
    const site = "document.querySelector('iframe').contentWindow";
    const srcBefore = await ev(`${site}.document.querySelector('#hc-frame-host iframe').getAttribute('src')`);
    const scrollBefore = await ev('scrollY', F);
    // click the paragraph with the TODO, at its own position
    const pt = await ev(`(() => { const p = [...document.querySelectorAll('.hc-block p')].find((x) => x.textContent.includes('TODO: this needs to be fixed.'));
      const r = p.getBoundingClientRect(); const x = r.right - 4, y = r.bottom - 6;
      p.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y })); return [x, y]; })()`, F);
    assert.ok(Array.isArray(pt));
    const open = await until(() => ev('HCEditorFrame.runtime.open()', F), 'the block opens for typing in the page');
    assert.equal(open.editor, 'visual');
    assert.equal(await ev("!!document.querySelector('.hc-block.hc-open .hc-edit-root p[contenteditable]')", F), true);
    // the caret at the end of the paragraph, then real typing
    await ev(`(() => { const p = document.querySelector('.hc-block.hc-open .hc-edit-root p'); p.focus(); const r = document.createRange(); r.selectNodeContents(p); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); })()`, F);
    await send('Input.insertText', { text: ' Check the cable firstt' });
    const bs = async (n) => { for (let i = 0; i < n; i++) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, commands: ['deleteBackward'] }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }); } };
    await bs(1);                                                  // own inserted text: removed outright
    await send('Input.insertText', { text: '.' });
    await sleep(100);
    const ins = await ev("[...document.querySelectorAll('.hc-open ins[data-hc-sug=ins]')].map((n) => n.textContent)", F);
    assert.deepEqual(ins, [' Check the cable first.'], 'one inserted suggestion, the typo removed outright');
    // now delete original text before the insertion: the caret moves before it, Backspace strikes
    await ev(`(() => { const p = document.querySelector('.hc-block.hc-open .hc-edit-root p'); const ins = p.querySelector('ins'); const r = document.createRange(); r.setStartBefore(ins); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); })()`, F);
    await bs(6);
    await sleep(700);
    const del = await ev("[...document.querySelectorAll('.hc-open del[data-hc-sug=del]')].map((n) => n.textContent)", F);
    assert.deepEqual(del, ['fixed.'], 'original text struck, not removed');
    assert.match(await ev("document.querySelector('.hc-open .hc-edit-root').textContent", F), /needs to be fixed\. Check the cable first\./, 'struck text stays on the page');
    // the parent's draft: exactly the block's new Markdown in its span
    const draft = await until(() => ev(`(() => { const raw = ${site}.sessionStorage.getItem('hc-draft:setup/lab-gantry/usage') || ''; return raw; })()`), 'the draft saved', 5000).catch(() => '');
    const store = draft || await ev(`JSON.stringify(Object.keys(${site}.sessionStorage))`);
    const text = await ev(`(() => { const C = ${site}.HCCore; const d = C.createDraftStore(${site}.sessionStorage).get('setup/lab-gantry/usage'); return d ? d.files['content/setup/lab-gantry/usage.md'] : null; })()`);
    assert.ok(text, `a draft exists (${String(store).slice(0, 200)})`);
    assert.ok(/all 3 motors should work\. TODO: this needs to be +Check the cable first\.\n/.test(text), 'deleted text gone, inserted text kept, in the Markdown');
    const orig = readFileSync(path.join(ROOT, 'content/setup/lab-gantry/usage.md'), 'utf8');
    const at = orig.indexOf('If you encounter any error messages');
    assert.equal(text.slice(0, at), orig.slice(0, at), 'everything before the block byte-identical');
    const tail = orig.slice(orig.indexOf('Example for timeout errror'));
    assert.ok(text.endsWith(tail), 'everything after the block byte-identical');
    // an IME composition (dead key / CJK) becomes a suggestion too
    await ev(`(() => { const p = document.querySelector('.hc-block.hc-open .hc-edit-root p'); const ins = p.querySelector('ins'); const r = document.createRange(); r.setStart(ins.firstChild, ins.firstChild.length); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); })()`, F);
    await ev(`(() => { const p = document.querySelector('.hc-block.hc-open .hc-edit-root p'); const t = document.createTextNode(''); p.appendChild(t); const r = document.createRange(); r.setStart(t, 0); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); })()`, F);
    await send('Input.imeSetComposition', { text: 'ü', selectionStart: 1, selectionEnd: 1 });
    await send('Input.insertText', { text: 'ü' });
    await sleep(150);
    const imeMarked = await ev("[...document.querySelectorAll('.hc-open ins[data-hc-sug=ins]')].some((n) => n.textContent.endsWith('ü'))", F);
    assert.equal(imeMarked, true, 'a composed character is marked as inserted');
    // Shift+Enter inserts a line break as a suggestion; Backspace right after takes it out again
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8, commands: ['insertLineBreak'] });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 });
    await sleep(100);
    assert.equal(await ev("document.querySelectorAll('.hc-open ins[data-hc-sug=ins] br').length", F), 1, 'Shift+Enter: one inserted line break');
    await bs(1);
    await sleep(100);
    assert.equal(await ev("document.querySelectorAll('.hc-open .hc-edit-root br').length", F), 0, 'Backspace removes the inserted break, nothing else');
    assert.equal(await ev("[...document.querySelectorAll('.hc-open ins[data-hc-sug=ins]')].some((n) => n.textContent.endsWith('first.ü'))", F), true, 'the text before it is intact');
    // a selection across a line break: typing over it takes the break too (inserted: gone)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8, commands: ['insertLineBreak'] });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 });
    await send('Input.insertText', { text: 'xy' });
    await ev(`(() => { const ins = document.querySelector('.hc-open ins[data-hc-sug=ins]'); const br = ins.querySelector('br'); const t = br.nextSibling; const r = document.createRange(); r.setStart(br.previousSibling, br.previousSibling.length); r.setEnd(t, t.length); getSelection().removeAllRanges(); getSelection().addRange(r); })()`, F);
    await bs(1);                                                  // Backspace over the selection
    await sleep(100);
    assert.equal(await ev("document.querySelectorAll('.hc-open .hc-edit-root br').length", F), 0, 'a selected line break is deleted with the selection');
    // Backspace after an emoji takes the whole character, never half of it
    await send('Input.insertText', { text: '🥳' });
    await bs(1);
    await sleep(80);
    assert.ok(await ev("![...document.querySelectorAll('.hc-open ins')].some((n) => /[\\ud800-\\udfff]/.test(n.textContent))", F), 'no lone surrogate left');
    // a word delete (Option+Backspace) takes the whole word: mine goes outright
    await send('Input.insertText', { text: ' Wordy' });
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, modifiers: 1, commands: ['deleteWordBackward'] });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, modifiers: 1 });
    await sleep(100);
    assert.equal(await ev("[...document.querySelectorAll('.hc-open ins[data-hc-sug=ins]')].map((n) => n.textContent).join('|')", F), ' Check the cable first.ü ', 'Option+Backspace removed the whole typed word');
    await bs(1);
    // strike the first letters of a paragraph, then type: the text goes where the caret is, not at the end
    const other = await ev(`(() => { const p = [...document.querySelectorAll('.hc-block p')].find((x) => x.textContent.startsWith('Example for timeout')); const r = p.getBoundingClientRect(); p.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 3, clientY: r.top + 5 })); return true; })()`, F);
    assert.ok(other);
    await until(() => ev("(HCEditorFrame.runtime.open() || {}).index !== undefined && document.querySelector('.hc-block.hc-open p') && document.querySelector('.hc-block.hc-open p').textContent.startsWith('Example')", F), 'the second paragraph opens');
    await ev(`(() => { const p = document.querySelector('.hc-block.hc-open .hc-edit-root p'); const t = p.firstChild; const r = document.createRange(); r.setStart(t, 2); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); })()`, F);
    await bs(2);
    await send('Input.insertText', { text: 'An e' });
    await sleep(100);
    assert.match(await ev("document.querySelector('.hc-block.hc-open .hc-edit-root p').textContent", F), /^ExAn eample for timeout/, 'typed at the caret after striking the first letters');
    await ev(`(() => { const p = [...document.querySelectorAll('.hc-block p')].find((x) => x.textContent.includes('Check the cable first.')); const r = p.getBoundingClientRect(); p.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.right - 4, clientY: r.bottom - 6 })); })()`, F);
    await until(() => ev(`(HCEditorFrame.runtime.open() || {}).index === ${open.index}`, F), 'back to the first paragraph');
    await ev(`(() => { const ins = [...document.querySelectorAll('.hc-open ins[data-hc-sug=ins]')].pop(); ins.closest('[contenteditable]').focus(); const t = ins.lastChild; const r = document.createRange(); r.setStart(t, t.length); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); })()`, F);
    // type, then pick another block at once: the last keystrokes are not lost
    await send('Input.insertText', { text: ' Quick' });
    await ev(`(() => { const p = [...document.querySelectorAll('.hc-block p')].find((x) => x.textContent.includes('ample for timeout errror')); const r = p.getBoundingClientRect(); p.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 })); })()`, F);
    await sleep(600);
    const quick = await ev(`(() => { const d = ${site}.HCCore.createDraftStore(${site}.sessionStorage).get('setup/lab-gantry/usage'); return d ? d.files['content/setup/lab-gantry/usage.md'] : ''; })()`);
    assert.ok(/first\.ü +Quick\n/.test(quick), `typed text reaches the draft even with an immediate switch to another block: ${JSON.stringify((/TODO[^\n]*/.exec(quick) || [''])[0])}`);
    // no reload, no jump
    assert.equal(await ev(`${site}.document.querySelector('#hc-frame-host iframe').getAttribute('src')`), srcBefore, 'the page frame was never reloaded');
    const F2 = await frameCtx();
    assert.ok(F2 && F2.sid === F.sid && F2.id === F.id, 'the same document');
    assert.ok(Math.abs((await ev('scrollY', F)) - scrollBefore) <= 2, 'the page did not scroll');
    console.log('U2 walk: typed in the page; suggestions marked; draft by span; no reload, no jump');
    ws.close();
  } finally {
    if (child) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    if (server) { server.closeAllConnections?.(); server.close(); }
    rmSync(scratch, { recursive: true, force: true });
  }
});

/* The DevTools harness of the walks above, as one helper: the real site in Editor mode at `page`
   (editor_walk.html?step=on), with the sandboxed page frame's context found (it runs out of process). */
async function editorWalk(page, scratch) {
  const chrome = findChrome();
  const server = await startServer(ROOT, []);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const child = spawn(chrome, ['--headless=new', '--disable-gpu', ...HERMETIC, '--window-size=1280,900',
    `--user-data-dir=${mkdtempSync(path.join(scratch, 'profile-'))}`, '--remote-debugging-port=0', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let port = null;
  for (let i = 0; i < 150 && !port; i++) { const m = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(err); if (m) port = m[1]; else await sleep(100); }
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let id = 0;
  const pend = new Map();
  const contexts = new Map();
  const sendTo = (sessionId, method, params = {}) => new Promise((r) => { const n = ++id; pend.set(n, r);
    ws.send(JSON.stringify(Object.assign({ id: n, method, params }, sessionId ? { sessionId } : {}))); });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const sid = m.sessionId || null;
    if (m.method === 'Runtime.executionContextCreated') contexts.set(`${sid}:${m.params.context.id}`, { sid, id: m.params.context.id, ctx: m.params.context });
    if (m.method === 'Runtime.executionContextDestroyed') contexts.delete(`${sid}:${m.params.executionContextId}`);
    if (m.method === 'Target.attachedToTarget') {
      const s2 = m.params.sessionId;
      sendTo(s2, 'Runtime.enable');
      sendTo(s2, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      sendTo(s2, 'Runtime.runIfWaitingForDebugger');
    }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  };
  const send = (method, params = {}) => sendTo(null, method, params);
  const ev = async (expression, where) => {
    const r = await sendTo(where ? where.sid : null, 'Runtime.evaluate', Object.assign({ expression, returnByValue: true, awaitPromise: true }, where ? { contextId: where.id } : {}));
    if (r.result && r.result.exceptionDetails) throw new Error(`${expression.slice(0, 80)}: ${JSON.stringify(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description)}`);
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const until = async (fn, what, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(100); } };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send('Page.navigate', { url: `${origin}/tools/tests/editor_walk.html?step=on&page=${page}` });
  await until(() => ev("document.body && document.body.getAttribute('data-walk-step')").then((s) => s === 'on:ready' || (s && s.endsWith(':failed') ? Promise.reject(new Error(s)) : false)), 'the walk at "on"');
  const frameCtx = async () => {
    for (const c of contexts.values()) {
      if (!c.ctx.auxData || !c.ctx.auxData.isDefault) continue;
      try { if (await ev("typeof HC !== 'undefined' && HC.preview === true && !!document.querySelector('.hc-block')", c)) return c; } catch (e) { /* gone */ }
    }
    return null;
  };
  const F = await until(frameCtx, 'the page frame grouped');
  const site = "document.querySelector('iframe').contentWindow";
  const draft = (key, file) => ev(`(() => { const d = ${site}.HCCore.createDraftStore(${site}.sessionStorage).get('${key}'); return d ? d.files['${file}'] : null; })()`);
  // click the block whose text matches `needle` (a JS regexp source), at a point inside it
  const clickBlock = (needle, sel = 'p, li, td, pre, h2, h3') => ev(`(() => { const re = new RegExp(${JSON.stringify(needle)});
    const el = [...document.querySelectorAll('.hc-block :is(${sel})')].find((x) => re.test(x.textContent) && x.getClientRects().length);
    if (!el) return false; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 6, clientY: r.top + 6 })); return true; })()`, F);
  const close = () => { try { ws.close(); } catch { /* closed */ } try { child.kill('SIGKILL'); } catch { /* gone */ } server.closeAllConnections?.(); server.close(); };
  // HC_WALK_SHOTS=<dir>: a PNG per named state, to look at (nothing is written otherwise)
  const shot = async (name) => {
    const dir = process.env.HC_WALK_SHOTS;
    if (!dir) return;
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (r.result && r.result.data) { mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, `${name}.png`), Buffer.from(r.result.data, 'base64')); }
  };
  return { send, ev, F, site, until, sleep, draft, clickBlock, close, shot };
}

test('U3 walk: the block editors in the page, in a real Chrome: note box type, Markdown box, code language, format bar', { timeout: 120000 }, async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'hc-u3-walk-'));
  let W = null;
  try {
    W = await editorWalk('/setup/lab-gantry/usage', scratch);
    const { send, ev, F, until, sleep, draft, clickBlock, shot } = W;
    const KEY = 'setup/lab-gantry/usage';
    const FILE = 'content/setup/lab-gantry/usage.md';
    const openIs = (editor) => until(() => ev(`(HCEditorFrame.runtime.open() || {}).editor === '${editor}'`, F), `a block open as ${editor}`);
    // 1. a note box: the type bar on its edge; Warning
    assert.ok(await clickBlock('motor position is stored inside the motion controller'));
    await openIs('box');
    assert.ok(await ev("!!document.querySelector('.hc-block.hc-open .hc-boxbar .hc-box-type')", F), 'the note box bar');
    await ev("document.querySelector('.hc-block.hc-open .hc-box-type').click()", F);
    await ev("[...document.querySelectorAll('.hc-boxmenu .hc-pm-item')].find((b) => b.textContent === 'Warning').click()", F);
    await sleep(200);
    await shot('u3-note-box');
    assert.match(await draft(KEY, FILE), /<div class="adm adm-warning"><p class="adm-title">Warning<\/p>\n\nThe motor position is stored/, 'the box type changed in the draft');
    // 2. a tabs block: the in-place Markdown box with live preview
    assert.ok(await clickBlock('Homing Using the GUI|Run the GUI', 'p, li'));
    await openIs('mdbox');
    assert.ok(await ev("!!document.querySelector('.hc-block.hc-open .hc-mdbox .hc-md-src')", F), 'the Markdown box in place');
    await ev("(() => { const t = document.querySelector('.hc-open .hc-md-src'); t.focus(); t.setSelectionRange(0, 0); })()", F);
    await send('Input.insertText', { text: 'Before the tabs.\n\n' });
    await sleep(200);
    assert.match(await ev("document.querySelector('.hc-open .hc-md-prev').textContent", F), /Before the tabs\./, 'the preview follows the typing');
    await shot('u3-markdown-box');
    assert.match(await draft(KEY, FILE), /Before the tabs\.\n\n<div class="tabs">/, 'the box text reaches the draft as typed');
    await ev("document.querySelector('.hc-open .hc-md-done').click()", F);
    await until(() => ev('HCEditorFrame.runtime.open() === null', F), 'Done closes the box');
    // 3. a code block: the language picker rewrites the fence's info string
    assert.ok(await clickBlock('^\\$ ros2 launch gantry xyz_motors\\.launch\\.py\\s*$', 'pre'));
    await openIs('code');
    await ev("(() => { const s = document.querySelector('.hc-block.hc-open .hc-codebar select'); s.value = 'bash'; s.dispatchEvent(new Event('change')); })()", F);
    await sleep(200);
    assert.match(await draft(KEY, FILE), /```bash\n\$ ros2 launch gantry xyz_motors\.launch\.py\n```/, 'the fence says bash now');
    // 4. a paragraph: select a word, the format bar, Bold -> a format suggestion
    assert.ok(await clickBlock('As a physical check'));
    await openIs('visual');
    await ev("(() => { const p = document.querySelector('.hc-block.hc-open p'); const t = p.firstChild; const i = t.data.indexOf('physical'); const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 8); getSelection().removeAllRanges(); getSelection().addRange(r); })()", F);
    await until(() => ev("!!document.querySelector('.hc-formatbar') && !document.querySelector('.hc-formatbar').hidden", F), 'the format bar over the selection');
    await shot('u3-format-bar');
    await ev("document.querySelector('.hc-formatbar .hc-fb-strong').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))", F);
    await sleep(200);
    assert.equal(await ev("(document.querySelector('.hc-open b[data-hc-sug=fmt]') || {}).textContent", F), 'physical');
    assert.match(await draft(KEY, FILE), /As a \*\*physical\*\* check/, 'Bold in the draft');
    console.log('U3 walk: note box type, Markdown box with preview, code language, format bar: all in the page');
  } finally {
    if (W) W.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('U4a walk: the dock at the bottom right in a real Chrome (switch, avatar, count, Send), and the guest "Sign in" bubble', { timeout: 120000 }, async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'hc-u4a-walk-'));
  let W = null;
  try {
    W = await editorWalk('/setup/lab-gantry/usage', scratch);
    const { send, ev, F, site, until, sleep, clickBlock, shot } = W;
    const S = (x) => ev(`${site}.document.${x}`);
    assert.equal(await S("querySelector('.header-actions .hc-switch')"), null, 'no switch in the header');
    const box = await ev(`(() => { const d = ${site}.document.querySelector('.hc-dock'); if (!d || d.hidden) return null; const r = d.getBoundingClientRect(); return { right: ${site}.innerWidth - r.right, bottom: ${site}.innerHeight - r.bottom, sw: !!d.querySelector('.hc-switch'), av: !!d.querySelector('.hc-avatar') }; })()`);
    assert.ok(box && box.sw && box.av, 'the dock holds the switch and the avatar');
    assert.ok(box.right >= 0 && box.right < 40 && box.bottom >= 0 && box.bottom < 40, `bottom right (${box.right}, ${box.bottom})`);
    assert.ok(await clickBlock('As a physical check'));
    await until(() => ev("(HCEditorFrame.runtime.open() || {}).editor === 'visual'", F), 'the block opens');
    await ev("(() => { const p = document.querySelector('.hc-block.hc-open p'); p.focus(); const r = document.createRange(); r.selectNodeContents(p); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); })()", F);
    await send('Input.insertText', { text: ' Then home it.' });
    await sleep(300);
    assert.equal(await S("querySelector('.hc-dock-count').textContent"), '1 change');
    await shot('u4a-dock');
    await ev(`${site}.document.querySelector('.hc-dock-send').click()`);
    await until(() => S("querySelector('.hc-sendbox .hc-propose-slot') && document.querySelector('iframe').contentWindow.document.querySelector('.hc-sendbox .hc-propose-slot').childElementCount > 0"), 'the send box with the propose form');
    await shot('u4a-send');
    // a 320-px phone: every dock control stays on screen
    await ev(`(() => { const f = document.querySelector('iframe'); f.style.width = '320px'; })()`);
    await until(() => ev(`${site}.innerWidth === 320`), 'the site at 320 px');
    await sleep(800);                                             // the media query and the dock's reflow
    const fits = await ev(`(() => { const w = ${site}; const d = w.document.querySelector('.hc-dock'); const r = d.getBoundingClientRect();
      const all = [...d.querySelectorAll('button')].filter((b) => !b.hidden && b.getClientRects().length).map((b) => b.getBoundingClientRect());
      return { dock: [r.left, r.right], vw: w.innerWidth, out: all.filter((b) => b.left < 0 || b.right > w.innerWidth).length }; })()`);
    assert.equal(fits.out, 0, `every dock button inside a 320-px screen (${JSON.stringify(fits)})`);
    await shot('u4a-phone');
    W.close(); W = null;
    // a guest: the bubble holds "Sign in" in the same place
    W = await (async () => {
      const chrome = findChrome();
      const server = await startServer(ROOT, []);
      const child = spawn(chrome, ['--headless=new', '--disable-gpu', ...HERMETIC, '--window-size=1280,900', `--user-data-dir=${mkdtempSync(path.join(scratch, 'g-'))}`,
        '--virtual-time-budget=8000', '--dump-dom', `http://127.0.0.1:${server.address().port}/index.html#/setup/lab-gantry/usage`], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      for (let i = 0; i < 150 && !/<\/html>\s*$/i.test(out); i++) await new Promise((r) => setTimeout(r, 100));
      child.kill('SIGKILL'); server.closeAllConnections?.(); server.close();
      return { out, close() {} };
    })();
    assert.match(W.out, /<div class="hc-guest-dock" role="region" aria-label="Sign in to edit"><button type="button" class="hc-guest-signin"[^>]*>Sign in<\/button>/, 'the guest bubble with "Sign in"');
    console.log('U4a walk: dock bottom right with switch + avatar + count + Send; guest bubble "Sign in"');
  } finally {
    if (W) W.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
