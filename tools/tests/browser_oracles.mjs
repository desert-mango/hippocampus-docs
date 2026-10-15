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
    const text = await ev(`(() => { const C = ${site}.HCCore; const d = C.createDraftStore(${site}.localStorage, (Object.keys(${site}.localStorage).find((k) => k.startsWith(C.DRAFTS_KEY + ':')) || '').split('/')[0]).get('setup/lab-gantry/usage'); return d ? d.files['content/setup/lab-gantry/usage.md'] : null; })()`);
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
    const quick = await ev(`(() => { const C = ${site}.HCCore; const d = C.createDraftStore(${site}.localStorage, (Object.keys(${site}.localStorage).find((k) => k.startsWith(C.DRAFTS_KEY + ':')) || '').split('/')[0]).get('setup/lab-gantry/usage'); return d ? d.files['content/setup/lab-gantry/usage.md'] : ''; })()`);
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
async function editorWalk(page, scratch, query = '', step = 'on') {
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
  const events = [];             // every protocol event (method + params), for tests that wait on one
  const sendTo = (sessionId, method, params = {}) => new Promise((r) => { const n = ++id; pend.set(n, r);
    ws.send(JSON.stringify(Object.assign({ id: n, method, params }, sessionId ? { sessionId } : {}))); });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const sid = m.sessionId || null;
    if (m.method) events.push({ method: m.method, params: m.params, sid });
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
  await send('Page.navigate', { url: `${origin}/tools/tests/editor_walk.html?step=${step}&page=${page}${query}` });
  // a walk that never gets ready closes its Chrome and server before it throws (else the test run hangs)
  const abort = (e) => { try { ws.close(); } catch { /* closed */ } try { child.kill('SIGKILL'); } catch { /* gone */ } server.closeAllConnections?.(); server.close(); throw e; };
  await until(() => ev("document.body && document.body.getAttribute('data-walk-step')").then((s) => s === `${step}:ready` || (s && s.endsWith(':failed') ? Promise.reject(new Error(s)) : false)), `the walk at "${step}"`).catch(abort);
  const frameCtx = async () => {
    for (const c of contexts.values()) {
      if (!c.ctx.auxData || !c.ctx.auxData.isDefault) continue;
      // a page with blocks, or the Team page (round 2, R5: data, no blocks — its people roster instead)
      try { if (await ev("typeof HC !== 'undefined' && HC.preview === true && !!document.querySelector('.hc-block, #people-root .person-card')", c)) return c; } catch (e) { /* gone */ }
    }
    return null;
  };
  const F = await until(frameCtx, 'the page frame grouped').catch(async (e) => {
    // say what each page context holds, so a frame that never grouped can be read from the failure
    const seen = [];
    for (const c of contexts.values()) {
      if (!c.ctx.auxData || !c.ctx.auxData.isDefault) continue;
      try { seen.push(await ev("location.href.slice(0, 80) + ' | ' + document.body.className + ' | ' + ((document.getElementById('content') || {}).textContent || '').slice(0, 160)", c)); } catch (x) { /* gone */ }
    }
    return abort(new Error(`${e.message}; contexts: ${seen.join(' ## ')}`));
  });
  const site = "document.querySelector('iframe').contentWindow";
  const draft = (key, file) => ev(`(() => { const C = ${site}.HCCore; const d = C.createDraftStore(${site}.localStorage, (Object.keys(${site}.localStorage).find((k) => k.startsWith(C.DRAFTS_KEY + ':')) || '').split('/')[0]).get('${key}'); return d ? d.files['${file}'] : null; })()`);
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
  return { send, sendTo, ev, F, site, until, sleep, draft, clickBlock, close, shot, events };
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

test('U4a walk: the dock (top right since V1) in a real Chrome (switch, avatar, count, Send), and the guest "Sign in" bubble', { timeout: 120000 }, async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'hc-u4a-walk-'));
  let W = null;
  try {
    W = await editorWalk('/setup/lab-gantry/usage', scratch);
    const { send, ev, F, site, until, sleep, clickBlock, shot } = W;
    const S = (x) => ev(`${site}.document.${x}`);
    assert.equal(await S("querySelector('.header-actions .hc-switch')"), null, 'no switch in the header');
    const box = await ev(`(() => { const d = ${site}.document.querySelector('.hc-dock'); if (!d || d.hidden) return null; const r = d.getBoundingClientRect(); const h = ${site}.document.querySelector('.site-header').getBoundingClientRect(); return { right: ${site}.innerWidth - r.right, below: r.top - h.bottom, sw: !!d.querySelector('.hc-switch'), av: !!d.querySelector('.hc-avatar') }; })()`);
    assert.ok(box && box.sw && box.av, 'the dock holds the switch and the avatar');
    // Kyle's live feedback (2026-10-14): top right, just under the header (it was bottom right in U4a)
    assert.ok(box.right >= 0 && box.right < 40 && box.below >= 0 && box.below < 30, `top right, under the header (${box.right}, ${box.below})`);
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

/* Kyle's live feedback (2026-10-14), the look (unit V1), in a real Chrome, LIGHT theme: the frame follows the
   site's theme (live too); no pencil; one left line (faint on hover, solid open); the title says "HippoCampus
   Editor" with "Editor" in the accent; the bubble sits top right under the TUHH mark in two rows; the format
   bar has Bold, Italic, inline code and Link, and Link refuses a script address. */
test('V1 walk: theme in the frame, the left line, the title, the bubble top right, Link and code', { timeout: 150000 }, async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'hc-v1-walk-'));
  let W = null;
  try {
    W = await editorWalk('/setup/lab-gantry/usage', scratch, '&theme=light');
    const { send, ev, F, site, until, sleep, draft, clickBlock, shot } = W;
    const KEY = 'setup/lab-gantry/usage';
    const FILE = 'content/setup/lab-gantry/usage.md';
    const S = (x) => ev(`${site}.eval(${JSON.stringify(x)})`);
    // 1. the theme crosses into the sandboxed frame
    assert.equal(await S("document.documentElement.getAttribute('data-theme')"), 'light');
    assert.equal(await ev("document.documentElement.getAttribute('data-theme')", F), 'light', 'the frame is light too');
    assert.equal(await ev('getComputedStyle(document.body).backgroundColor', F), 'rgb(250, 250, 250)', 'light page under a light site');
    // 2. no pencil; the left line: transparent at rest, solid accent on the open block
    assert.equal(await ev("document.querySelectorAll('.hc-pencil').length", F), 0, 'no pencil');
    const lineOf = (sel) => ev(`getComputedStyle(document.querySelector(${JSON.stringify(sel)}), '::after').backgroundColor`, F);
    assert.equal(await lineOf('.hc-block'), 'rgba(0, 0, 0, 0)', 'no line at rest');
    assert.equal(await ev("getComputedStyle(document.querySelector('.hc-block')).boxShadow", F), 'none', 'no ring');
    // (measured before a block opens: until V2 the right tray opens with it and the bubble steps left of it)
    // 3. the title: "HippoCampus Editor", "Editor" in the accent, "Robotics" gone
    await sleep(400);                                            // the slide
    const title = await S(`(() => { const ed = document.querySelector('.brand-editor'), ro = document.querySelector('.brand-robotics');
      return ed && ro ? { ed: getComputedStyle(ed).opacity, edColor: getComputedStyle(ed).color, ro: getComputedStyle(ro).opacity, roHidden: ro.getAttribute('aria-hidden'), edHidden: ed.getAttribute('aria-hidden') } : null; })()`);
    assert.ok(title, 'the brand has both words');
    assert.equal(title.ed, '1'); assert.equal(title.ro, '0');
    assert.equal(title.edColor, 'rgb(201, 37, 127)', '"Editor" in the edit magenta (round 2)');
    assert.equal(title.roHidden, 'true'); assert.equal(title.edHidden, null);
    // 4. the bubble: top right, under the header (not in it), its right edge at the TUHH mark's, two rows
    const pos = await S(`(() => { const d = document.querySelector('.hc-dock'), hd = document.querySelector('.site-header'), t = document.querySelector('.tuhh-link');
      const r = d.getBoundingClientRect(), h = hd.getBoundingClientRect(), tr = t.getBoundingClientRect();
      const row1 = d.querySelector('.hc-switch').getBoundingClientRect(), row2 = d.querySelector('.hc-dock-count').getBoundingClientRect();
      return { top: r.top, headerBottom: h.bottom, right: r.right, tuhhRight: tr.right, row1: row1.top, row2: row2.top, bottomGap: innerHeight - r.bottom }; })()`);
    assert.ok(pos.top >= pos.headerBottom && pos.top - pos.headerBottom <= 24, `just under the header (${JSON.stringify(pos)})`);
    assert.ok(Math.abs(pos.right - pos.tuhhRight) <= 12, `right edge under the TUHH mark (${pos.right} vs ${pos.tuhhRight})`);
    assert.ok(pos.row2 > pos.row1 + 10, 'two rows: switch above the count');
    assert.ok(await clickBlock('As a physical check'));
    await until(() => ev("(HCEditorFrame.runtime.open() || {}).editor === 'visual'", F), 'the block opens');
    await sleep(400);                                            // the line's colour transition
    // round 2 (R1): Editor mode paints in Desert Mango magenta, the light theme's --hc-edit
    const edit = await ev("getComputedStyle(document.documentElement).getPropertyValue('--hc-edit').trim()", F);
    assert.equal(edit.toUpperCase(), '#C9257F');
    assert.equal(await lineOf('.hc-block.hc-open'), 'rgb(201, 37, 127)', 'the open block has the solid magenta line');
    assert.equal(await ev("getComputedStyle(document.querySelector('.hc-block.hc-open')).boxShadow", F), 'none', 'and no ring');
    await shot('v1-light-open');
    // 5. the format bar: Bold, Italic, inline code, Link
    const selectWord = (word) => ev(`(() => { const p = document.querySelector('.hc-block.hc-open p'); const w = document.createTreeWalker(p, 4); let t; while ((t = w.nextNode())) { const i = t.data.indexOf(${JSON.stringify(word)}); if (i >= 0) { const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + ${word.length}); getSelection().removeAllRanges(); getSelection().addRange(r); return true; } } return false; })()`, F);
    assert.ok(await selectWord('physical'));
    await until(() => ev("!!document.querySelector('.hc-formatbar') && !document.querySelector('.hc-formatbar').hidden", F), 'the format bar');
    const kinds = await ev("[...document.querySelectorAll('.hc-formatbar .hc-fb')].map((b) => b.getAttribute('aria-label'))", F);
    assert.deepEqual(kinds, ['Bold', 'Italic', 'Inline code', 'Link']);
    await shot('v1-format-bar');
    await ev("document.querySelector('.hc-formatbar .hc-fb-code').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))", F);
    await sleep(250);
    assert.match(await draft(KEY, FILE), /As a `physical` check/, 'inline code in the draft');
    assert.ok(await selectWord('check'));
    await until(() => ev("!document.querySelector('.hc-formatbar').hidden", F), 'the bar again');
    await ev("document.querySelector('.hc-formatbar .hc-fb-link').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))", F);
    await until(() => ev("!!document.querySelector('.hc-formatbar .hc-fb-url') && document.activeElement === document.querySelector('.hc-formatbar .hc-fb-url')", F), 'the address field, focused');
    await send('Input.insertText', { text: 'javascript:alert(1)' });
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(150);
    assert.match(await ev("(document.querySelector('.hc-formatbar .hc-fb-err') || {}).textContent || ''", F), /https:\/\//, 'a script address is refused, in words');
    await shot('v1-link-refused');
    await ev("(() => { const i = document.querySelector('.hc-formatbar .hc-fb-url'); i.value = ''; })()", F);
    await send('Input.insertText', { text: '#/setup/lab-gantry/wiring' });
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(300);
    assert.match(await draft(KEY, FILE), /`physical` \[check\]\(#\/setup\/lab-gantry\/wiring\)/, 'the link in the draft');
    // keyboard: Cmd/Ctrl+K opens the address field for the selection; Escape gives the selection back
    assert.ok(await selectWord('movable'));
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 4 });
    await until(() => ev("document.activeElement === document.querySelector('.hc-formatbar .hc-fb-url')", F), 'Cmd+K opens the address field');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await until(() => ev("document.querySelector('.hc-formatbar').hidden && getSelection().toString() === 'movable'", F), 'Escape closes it and keeps the selection');
    await sleep(300);                                            // the selectionchange the restore fires
    assert.equal(await ev("document.querySelector('.hc-formatbar').hidden", F), true, 'and the bar stays closed');
    assert.ok(await ev("!!HCEditorFrame.runtime.open()", F), 'and the block stays open');
    // 6. the theme toggle: the frame follows at once
    await S("document.getElementById('theme-toggle').click()");
    await until(() => ev("document.documentElement.getAttribute('data-theme') === null", F), 'the frame turns dark with the site');
    await shot('v1-dark-after-toggle');
    console.log('V1 walk: light frame, one left line, "HippoCampus Editor", bubble under TUHH in two rows, code + link');
  } finally {
    if (W) W.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

/* V2 (Kyle, 2026-10-14) in a real Chrome: no right tray and no edge handle; the bubble's "Proposals" opens the
   editor page and Escape closes it; a REAL click on an image (trusted input, through the sandboxed frame)
   opens the browser's file dialog in the parent (the click's activation reaches it); Alt+ArrowDown on a
   focused image moves it in the draft. */
test('V2 walk: the editor page from the bubble, an image click opens the file dialog, Alt+Down moves the image', { timeout: 150000 }, async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'hc-v2-walk-'));
  let W = null;
  try {
    W = await editorWalk('/setup/lab-gantry/usage', scratch);
    const { send, ev, F, site, until, sleep, draft, shot, events } = W;
    const KEY = 'setup/lab-gantry/usage';
    const FILE = 'content/setup/lab-gantry/usage.md';
    const S = (x) => ev(`${site}.eval(${JSON.stringify(x)})`);
    assert.equal(await S("document.querySelectorAll('.hc-handle').length"), 0, 'no edge handle');
    assert.equal(await S("document.querySelector('#hc-tray').hidden"), true, 'no panel at the start');
    // the editor page
    await S("document.querySelector('.hc-dock-pages').click()");
    await until(() => S("!document.querySelector('#hc-tray').hidden"), 'the editor page opens');
    const cover = await S("(() => { const t = document.querySelector('#hc-tray').getBoundingClientRect(); return { left: t.left, right: innerWidth - t.right }; })()");
    assert.ok(cover.left <= 1 && cover.right <= 1, `a full page, not a side panel (${JSON.stringify(cover)})`);
    await shot('v2-editor-page');
    // round 2 (R3): the editor page is the proposals list: no tabs; its foot opens View settings
    assert.equal(await S("document.querySelectorAll('#hc-tray [role=tab]').length"), 0, 'no tabs');
    await until(() => S("!!document.querySelector('#hc-tray [data-action=foot-view]')"), 'the list foot');
    await S("document.querySelector('#hc-tray [data-action=foot-view]').click()");
    await until(() => S("document.querySelector('#hc-tray .hc-tray-title').textContent === 'View settings'"), 'View settings');
    await shot('v2-editor-page-view');
    await S("document.querySelector('#hc-tray').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await until(() => S("document.querySelector('#hc-tray').hidden"), 'Escape goes back to the page');
    // a trusted click on the first image block opens the file dialog
    await send('Page.setInterceptFileChooserDialog', { enabled: true });
    await ev("document.querySelector('.hc-block[data-hc-image]').scrollIntoView({ block: 'center' })", F);
    await sleep(300);
    const inF = await ev("(() => { const r = document.querySelector('.hc-block[data-hc-image] img').getBoundingClientRect(); return { x: r.left + Math.min(40, r.width / 2), y: r.top + Math.min(20, r.height / 2) }; })()", F);
    const frameAt = await S("(() => { const r = document.querySelector('.hc-frame').getBoundingClientRect(); return { x: r.left, y: r.top }; })()");
    const siteAt = await ev("(() => { const r = document.querySelector('iframe').getBoundingClientRect(); return { x: r.left, y: r.top }; })()");
    const x = siteAt.x + frameAt.x + inF.x;
    const y = siteAt.y + frameAt.y + inF.y;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await until(() => events.some((e) => e.method === 'Page.fileChooserOpened'), 'the browser\'s file dialog opened from the click in the frame');
    assert.equal(await ev("document.querySelector('.hc-block[data-hc-image]').classList.contains('hc-open')", F), false, 'the image did not open for typing');
    // Alt+ArrowDown on the focused image moves it below the next block, in the draft
    // where Alt+Down must land it: before the block after next (the frame's own wrappers), as HCCore.moveBlock
    const move = await ev("(() => { const ws = [...document.querySelectorAll('.page-body > .hc-block')]; const w = document.querySelector('.hc-block[data-hc-image]'); const k = ws.indexOf(w); const n = (x) => Number(x.getAttribute('data-index')); return { from: n(w), to: ws[k + 2] ? n(ws[k + 2]) : n(ws[k + 1]) + 1 }; })()", F);
    const want = await ev(`fetch('/${FILE}').then((r) => r.text()).then((t) => ${site}.HCCore.moveBlock(t, ${move.from}, ${move.to}))`);
    assert.ok(want && want.indexOf('![gantry gui screenshot]') > 0);
    // (the file dialog took the window's focus: the key goes to the focused block directly)
    await ev("(() => { const w = document.querySelector('.hc-block[data-hc-image]'); w.focus(); w.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true })); })()", F);
    await until(async () => (await draft(KEY, FILE)) === want, 'the image moved below the next block, in the draft, byte for byte');
    await sleep(600);
    await shot('v2-image-moved');
    console.log('V2 walk: full editor page from the bubble, Escape back; trusted image click -> file dialog; Alt+Down moves the image');
  } finally {
    if (W) W.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

/* U5b (plan-u5) in a real Chrome: a proposal drawn over the page gets a review rail BESIDE the frame, in the
   parent: one card per change on its block's line, no two overlapping; hovering a card lights its block in
   the frame; Approve (by mouse and by keyboard) writes exactly one approval record, and not within the 400 ms
   card guard; narrow windows show markers whose click opens the card. */
test('U5b walk: the review rail beside the page, cards on their lines, Approve writes one record, markers when narrow', { timeout: 150000 }, async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'hc-u5b-walk-'));
  let W = null;
  try {
    W = await editorWalk('/setup/lab-gantry/usage', scratch, '&variant=admin', 'overlay-inline');
    const { send, ev, F, site, until, sleep, shot } = W;
    const S = (x) => ev(`${site}.eval(${JSON.stringify(x)})`);
    await until(() => S("!!document.querySelector('.hc-rail') && !document.querySelector('.hc-rail').hidden && document.querySelectorAll('.hc-rslot:not([hidden])').length >= 2"), 'the rail with its cards');
    await sleep(400);
    const geo = await S(`(() => { const f = document.querySelector('.hc-frame').getBoundingClientRect(), r = document.querySelector('.hc-rail').getBoundingClientRect();
      const cards = [...document.querySelectorAll('.hc-rslot:not([hidden]) .hc-rcard')].map((c) => { const b = c.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, key: c.dataset.key, acts: [...c.querySelectorAll('[data-act]')].map((x) => x.dataset.act) }; });
      return { frameRight: f.right, railLeft: r.left, railRight: r.right, cards, approveAll: (document.querySelector('[data-action=approve-all]') || {}).textContent || null }; })()`);
    assert.ok(geo.railLeft >= geo.frameRight - 1, `the rail is beside the frame, not over it (${JSON.stringify(geo)})`);
    for (let i = 1; i < geo.cards.length; i += 1) assert.ok(geo.cards[i].top >= geo.cards[i - 1].bottom, 'no two cards overlap');
    assert.ok(geo.cards.every((c) => c.left >= geo.railLeft - 12), 'every card is in the rail');
    assert.ok(geo.cards.some((c) => c.acts.join() === 'approve,decline'), 'an admin gets Approve and Reject');
    assert.match(geo.approveAll || '', /^Approve all \(\d+\)$/);
    await shot('u5b-rail-dark-1280');
    // a card's line: the card of the changed paragraph starts within 40 px of its block (frame coordinates + offset)
    const lines = await ev(`[...document.querySelectorAll('.hc-block.hc-prop-del, .hc-block.hc-prop-add')].map((b) => Math.round(b.getBoundingClientRect().top))`, F);
    const frameTop = await S("document.querySelector('.hc-frame').getBoundingClientRect().top");
    assert.ok(geo.cards.some((c) => lines.some((t) => Math.abs(c.top - (frameTop + t)) <= 40)), `a card on its block's line (${JSON.stringify({ lines, frameTop, cards: geo.cards.map((c) => c.top) })})`);
    // hover a card: its block is lit in the frame
    await S("document.querySelector('.hc-rslot:not([hidden]) .hc-rcard').dispatchEvent(new MouseEvent('mouseenter'))");
    await until(() => ev("document.querySelectorAll('.hc-block.hc-hot').length === 1", F), 'the hovered card lights its block');
    // the click guard: an Approve right after the card appeared does nothing
    const key = geo.cards.find((c) => c.acts.includes('approve')).key;
    await S(`(() => { const c = document.querySelector('.hc-rcard[data-key="${key}"]'); c.dataset.armedAt = String(Date.now() + 400); c.querySelector('[data-act=approve]').click(); })()`);
    await sleep(150);
    const records = "window.walkWrites.filter((w) => /\\/issues\\//.test(w.url))";   // (the GraphQL thread list is a read sent as POST)
    assert.equal(await ev(`${records}.length`), 0, 'no record inside the 400 ms guard');
    // keyboard: focus Approve, press Enter (after the guard)
    await sleep(450);
    await S(`document.querySelector('.hc-rcard[data-key="${key}"] [data-act=approve]').focus()`);
    assert.equal(await S("document.activeElement && document.activeElement.dataset.act"), 'approve', 'Approve has the focus');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await until(() => ev(`${records}.length === 1`), 'one record');
    const w = await ev(`${records}[0]`);
    assert.equal(w.method, 'POST');
    assert.match(w.url, /\/repos\/desert-mango\/hippocampus-docs\/issues\/2\/comments$/);
    assert.deepEqual(w.body, { body: `hc-approved ${key}` });
    await until(() => S(`/Going live/.test(document.querySelector('.hc-rcard[data-key="${key}"]').textContent)`), 'the card says it is going live');
    await shot('u5b-going-live-dark-1280');
    // round 2 (R3): the proposals list, a row per proposal in its proposer's colour (dark, then light)
    const listShot = async (name) => {
      await S("document.querySelector('.hc-dock-pages').click()");
      await until(() => S("document.querySelectorAll('#hc-tray .hc-prow').length > 0"), 'the proposals list');
      assert.equal(await S("document.querySelectorAll('#hc-tray [role=tab]').length"), 0, 'no tabs');
      await sleep(300);
      await shot(name);
      await S("document.querySelector('#hc-tray .hc-tray-close').click()");
      await until(() => S("document.querySelector('#hc-tray').hidden"), 'back to the page');
    };
    await listShot('r3-list-dark-1280');
    // light theme
    await S("document.getElementById('theme-toggle').click()");
    await sleep(500);
    await shot('u5b-rail-light-1280');
    await listShot('r3-list-light-1280');
    // narrow: markers; a click opens the card beside the marker
    await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
    await until(() => S("document.querySelector('.hc-rail').classList.contains('is-markers')"), 'markers when narrow');
    await sleep(300);
    await S("document.querySelector('.hc-rslot:not([hidden]) .hc-rmark').click()");
    await sleep(300);
    const pop = await S("(() => { const c = document.querySelector('.hc-rslot.is-active .hc-rcard'); if (!c) return null; const b = c.getBoundingClientRect(); return { w: b.width, right: b.right, vis: getComputedStyle(c).display }; })()");
    assert.ok(pop && pop.vis === 'block' && pop.w > 200, `the marker opens its card (${JSON.stringify(pop)})`);
    await shot('u5b-markers-light-1024');
    W.close();
    W = null;
    // a phone (the site 390 px wide): no rail; the page bar's "Review N changes" opens them as a bottom sheet
    W = await editorWalk('/setup/lab-gantry/usage', scratch, '&variant=admin&width=390&theme=light', 'overlay-inline');
    const P = (x) => W.ev(`${W.site}.eval(${JSON.stringify(x)})`);
    await W.until(() => P("!!document.querySelector('[data-action=rail-sheet]')"), 'the page bar offers the sheet');
    assert.equal(await P("getComputedStyle(document.querySelector('.hc-rail')).display"), 'none', 'no rail on a phone');
    await P("document.querySelector('[data-action=rail-sheet]').click()");
    await W.until(() => P("document.querySelectorAll('.hc-rsheet .hc-rcard').length >= 2"), 'the sheet with the cards');
    const sheet = await P("(() => { const r = document.querySelector('.hc-rsheet').getBoundingClientRect(); return { left: r.left, right: innerWidth - r.right, bottom: innerHeight - r.bottom, focus: document.activeElement && document.activeElement.dataset.action }; })()");
    assert.ok(sheet.left <= 12 && sheet.right <= 12 && sheet.bottom <= 12, `a bottom sheet (${JSON.stringify(sheet)})`);
    assert.equal(sheet.focus, 'rail-sheet-close', 'the focus moves into the sheet');
    await W.shot('u5b-sheet-light-390');
    await P("document.querySelector('.hc-rsheet').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await W.until(() => P("!document.querySelector('.hc-rsheet')"), 'Escape closes the sheet');
    console.log('U5b walk: rail beside the frame, cards on their lines without overlap, hover lights the block, guard holds, Enter approves with one record, markers at 1024, a bottom sheet at 390');
  } finally {
    if (W) W.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

/* U6 in a real Chrome: a card opens its conversation; Comment starts one on the change's first line (a review
   comment, the exact body), Reply answers in it, Resolve goes through the GraphQL door; the text is shown as text. */
test('U6 walk: a conversation on a change: comment, reply, resolve, all from the card', { timeout: 150000 }, async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'hc-u6-walk-'));
  let W = null;
  try {
    W = await editorWalk('/setup/lab-gantry/usage', scratch, '&variant=admin&theme=light', 'overlay-inline');
    const { ev, site, until, sleep, shot } = W;
    const S = (x) => ev(`${site}.eval(${JSON.stringify(x)})`);
    await until(() => S("document.querySelectorAll('.hc-rslot:not([hidden]) .hc-rcard').length >= 2"), 'the cards');
    const key = await S("[...document.querySelectorAll('.hc-rslot:not([hidden]) .hc-rcard')].find((c) => c.querySelector('[data-act=approve]')).dataset.key");
    await S(`document.querySelector('.hc-rcard[data-key="${key}"]').click()`);
    await until(() => S(`!!document.querySelector('.hc-rcard[data-key="${key}"] [data-action=talk-new]')`), 'the active card offers Comment');
    await S(`(() => { const c = document.querySelector('.hc-rcard[data-key="${key}"]'); c.querySelector('.hc-talk-input').value = 'Is <b>this</b> right?'; c.querySelector('[data-action=talk-new]').click(); })()`);
    await until(() => ev("window.walkWrites.some((w) => /\\/pulls\\/2\\/comments$/.test(w.url))"), 'the comment write');
    const w = await ev("window.walkWrites.find((w) => /\\/pulls\\/2\\/comments$/.test(w.url))");
    assert.deepEqual(Object.keys(w.body).sort(), ['body', 'commit_id', 'line', 'path', 'side']);
    assert.equal(w.body.body, 'Is <b>this</b> right?');
    assert.equal(w.body.path, 'content/setup/lab-gantry/usage.md');
    assert.equal(w.body.side, 'RIGHT');
    await until(() => S(`/Is <b>this<\\/b> right\\?/.test(document.querySelector('.hc-rcard[data-key="${key}"] .hc-talk-text').textContent)`), 'the comment shows, as text');
    assert.equal(await S(`document.querySelector('.hc-rcard[data-key="${key}"] .hc-talk-text b')`), null, 'no markup from a comment');
    await S(`(() => { const t = document.querySelector('.hc-rcard[data-key="${key}"] .hc-talk-thread'); t.querySelector('.hc-talk-input').value = 'Yes.'; t.querySelector('[data-action=talk-reply]').click(); })()`);
    await until(() => ev("window.walkWrites.some((w) => /\\/comments\\/1000\\/replies$/.test(w.url))"), 'the reply write');
    await until(() => S(`document.querySelectorAll('.hc-rcard[data-key="${key}"] .hc-talk-msg').length === 2`), 'two messages');
    await S(`document.querySelector('.hc-rcard[data-key="${key}"] [data-action=talk-resolve]').click()`);
    await until(() => ev("window.walkWrites.some((w) => /\\/graphql$/.test(w.url) && /^mutation/.test(w.body.query) && w.body.variables.id === 'PRRT_walk1000')"), 'resolve through the door');
    await until(() => S(`!!document.querySelector('.hc-rcard[data-key="${key}"] .hc-talk-thread.is-resolved')`), 'shown resolved');
    await sleep(300);
    await shot('u6-conversation-light-1280');
    // another card: inactive cards say how many comments a change has
    await S("[...document.querySelectorAll('.hc-rslot:not([hidden]) .hc-rcard')].find((c) => c.dataset.key !== " + JSON.stringify(key) + ").click()");
    await until(() => S(`/2 comments/.test(document.querySelector('.hc-rcard[data-key="${key}"]').textContent)`), 'the count on the closed card');
    console.log('U6 walk: comment on the change line, reply, resolve via the GraphQL door; text stays text; the count on a closed card');
  } finally {
    if (W) W.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

/* Round 2 (R5): the guest site itself (no Editor), in a real Chrome at `hash`. */
async function siteWalk(hash, scratch, theme) {
  const chrome = findChrome();
  const server = await startServer(ROOT, []);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const child = spawn(chrome, ['--headless=new', '--disable-gpu', ...HERMETIC, '--window-size=1280,1100',
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
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error(`${expression.slice(0, 80)}: ${JSON.stringify(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description)}`);
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const until = async (fn, what, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(100); } };
  await send('Page.enable');
  await send('Runtime.enable');
  if (theme === 'light') await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { localStorage.setItem('hc-theme', 'light'); } catch (e) {}" });
  await send('Page.navigate', { url: `${origin}/${hash}` });
  const shot = async (name) => {
    const dir = process.env.HC_WALK_SHOTS;
    if (!dir) return;
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (r.result && r.result.data) { mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, `${name}.png`), Buffer.from(r.result.data, 'base64')); }
  };
  const close = () => { try { ws.close(); } catch { /* closed */ } try { child.kill('SIGKILL'); } catch { /* gone */ } server.closeAllConnections?.(); server.close(); };
  return { send, ev, until, sleep, shot, close, origin };
}

test('R5: the Team page — #/about and #/lab land on #/team; Lab activity, then People; whole cards are links; Kyle highlighted', { timeout: 120000 }, async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'hc-r5-team-'));
  let W = null;
  try {
    for (const [from, theme, to] of [['#/about', 'dark', '#/team'], ['#/lab', 'light', '#/team'], ['#/about?x=1@people', 'dark', '#/team?x=1@people']]) {
      W = await siteWalk(from, scratch, theme);
      const { ev, until } = W;
      await until(() => ev(`location.hash === ${JSON.stringify(to)} && document.querySelectorAll('.person-card').length > 5`), `${from} -> ${to} with the people`);
      await until(() => ev("!!document.querySelector('.team-lab .hc-heat, .team-lab .hc-tiles')"), 'the lab activity');
      const page = await ev(`(async () => {
        const roster = await (await fetch('data/people.json')).json();
        const pub = await (await fetch('data/graph/people-public.json')).json();
        const lab = document.querySelector('.team-lab'), ppl = document.querySelector('.team-people');
        const nav = [...document.querySelectorAll('.site-nav a')].map((a) => a.dataset.nav);
        const cards = [...document.querySelectorAll('.team-people .person-card')];
        const kyle = cards.find((c) => /Kyle Nelson/.test(c.textContent));
        const title = kyle && kyle.querySelector('.person-title');
        const team = [...document.querySelectorAll('[data-hc-list="team"] .person-name')].map((n) => n.textContent);
        return {
          h1: document.querySelector('#content h1').textContent.trim(),
          order: lab && ppl ? lab.compareDocumentPosition(ppl) & Node.DOCUMENT_POSITION_FOLLOWING : 0,
          labH2: lab && lab.querySelector('h2') ? lab.querySelector('h2').textContent : null,
          kicker: !!(lab && lab.querySelector('.kicker')),
          nav,
          linkedAreLinks: cards.filter((c) => c.dataset.link === '1').every((c) => c.tagName === 'A'),
          imgInsideLink: cards.filter((c) => c.querySelector('img')).filter((c) => c.tagName === 'A').length,
          triggers: document.querySelectorAll('.team-people .hc-pp-trigger, .team-people [role="button"]').length,
          kyleTag: kyle && kyle.tagName, highlight: title && title.classList.contains('is-highlight'), titleText: title && title.textContent,
          titleColor: title && getComputedStyle(title).color,
          accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
          team,
          expect: HCLab.splitTeam(roster, pub, new Date().toISOString().slice(0, 10)).team.map((e) => e.person.name),
        };
      })()`);
      assert.equal(page.h1, 'Team');
      assert.ok(page.order, 'Lab activity comes before People');
      assert.equal(page.labH2, 'Lab activity');
      assert.equal(page.kicker, false, 'no kicker above it');
      assert.ok(page.nav.includes('team') && !page.nav.includes('about') && !page.nav.includes('lab'), JSON.stringify(page.nav));
      assert.ok(page.linkedAreLinks, 'a card with a link is one <a>');
      assert.ok(page.imgInsideLink >= 3, 'the photo is inside the link');
      assert.equal(page.triggers, 0, 'no popover trigger on the cards');
      assert.equal(page.kyleTag, 'A');
      assert.equal(page.highlight, true);
      assert.equal(page.titleText, 'Site creator');
      assert.deepEqual(page.team, page.expect, 'the current team is splitTeam over the committed data');
      for (const n of ['Kyle Nelson', 'Nathalie Bauschmann', 'Vincent Lenz', 'Finn Breuer']) assert.ok(page.team.includes(n), n);
      const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
      if (theme === 'dark') assert.equal(page.titleColor, rgb(page.accent), 'the highlighted title is the site accent');
      else {                                                       // light: the accent darkened for small text
        const k = /^color\(/.test(page.titleColor) ? 255 : 1;        // color-mix() computes as color(srgb r g b)
        const [r, , bl] = page.titleColor.match(/[\d.]+/g).map((x) => Number(x) * k);
        assert.ok(bl > r + 60, `a blue title in light mode too (${page.titleColor})`);
      }
      await W.shot(`r5-team-${theme}-1280`);
      W.close(); W = null;
    }
    console.log('R5: #/about and #/lab redirect to #/team; lab then people; whole-card links; Kyle highlighted');
  } finally {
    if (W) W.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('R5 walk: the Team page in Editor mode — card tools (no block line), the menu, Alt+Down, a refused move, "+"', { timeout: 150000 }, async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'hc-r5-walk-'));
  let W = null;
  try {
    W = await editorWalk('/team', scratch, '&theme=light');
    const { ev, F, site, until, sleep, draft, shot } = W;
    const S = (x) => ev(`${site}.eval(${JSON.stringify(x)})`);
    await until(() => ev("document.querySelectorAll('.hc-padd').length === 2", F), 'a "+" card at the end of each list');
    const look = await ev(`(() => { const c = document.querySelector('[data-hc-list="team"] .person-card[data-hc-ptools]');
      return { blocks: document.querySelectorAll('.hc-block').length, cursor: getComputedStyle(c).cursor, edit: document.body.classList.contains('hc-people-edit') }; })()`, F);
    assert.deepEqual(look, { blocks: 0, cursor: 'grab', edit: true }, 'cards, not blocks: no block bar over the roster');
    await ev("document.getElementById('people-root').scrollIntoView({ block: 'start' })", F);
    await sleep(300);
    await ev("document.querySelector('[data-hc-list=\"team\"] .person-card[data-hc-ptools]').focus()", F);
    await shot('r5-team-editor-light-1280');
    // the menu on a card: a click opens it, not the person's page
    const first = await ev("document.querySelector('[data-hc-list=\"team\"] .person-card[data-hc-ptools]').getAttribute('data-hc-name')", F);
    await ev("document.querySelector('[data-hc-list=\"team\"] .person-card[data-hc-ptools]').click()", F);
    await until(() => ev("!!document.querySelector('.hc-pmenu')", F), 'the card menu');
    const items = await ev("[...document.querySelectorAll('.hc-pmenu [data-pact]')].map((b) => b.getAttribute('data-pact'))", F);
    assert.deepEqual(items.slice(0, 3), ['up', 'down', 'other']);
    await shot('r5-team-menu-light-1280');
    // an active, linked, unpinned person cannot be sent to the alumni: the note says why, nothing is posted
    const active = await ev("(document.querySelector('[data-hc-list=\"team\"] .person-card[data-active=\"1\"][data-pinned=\"0\"]') || {}).getAttribute?.('data-hc-name') || null", F);
    if (active) {
      await ev(`(() => { const c = [...document.querySelectorAll('.person-card[data-hc-name]')].find((x) => x.getAttribute('data-hc-name') === ${JSON.stringify(active)}); c.click(); document.querySelector('.hc-pmenu [data-pact="other"]').click(); })()`, F);
      await until(() => ev("/active on GitHub in the last 30 days/.test((document.querySelector('.hc-pnote') || {}).textContent || '')", F), 'the refused-move note');
    }
    // "+" on the alumni list opens the New person form with that list chosen; Escape comes back
    await ev("document.querySelector('.hc-padd[data-hc-padd=\"alumni\"]').click()", F);
    await until(() => S("!document.querySelector('#hc-tray').hidden && document.querySelector('#hc-tray select[data-field=group]') && document.querySelector('#hc-tray select[data-field=group]').value === 'alumni'"), 'New person for the alumni');
    await shot('r5-team-add-light-1280');
    await S("document.querySelector('#hc-tray').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await until(() => S("document.querySelector('#hc-tray').hidden"), 'back to the page');
    // Alt+Down on the first card: my draft of data/people.json changes, the bubble counts it
    await ev(`(() => { const c = document.querySelector('[data-hc-list="team"] .person-card[data-hc-ptools]'); c.focus();
      c.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true })); })()`, F);
    await until(() => S("/^\\d+ changes?$/.test(document.querySelector('[data-dock-count]').textContent)"), 'the bubble counts the change', 10000);
    await until(() => draft('data/people', 'data/people.json').then((t) => t && JSON.parse(t).groups[0].people[1].name === first), 'my draft: the first person moved down', 10000);
    await sleep(1500);
    await shot('r5-team-moved-light-1280');
    await S("document.getElementById('theme-toggle').click()");
    await sleep(800);
    await shot('r5-team-moved-dark-1280');
    console.log('R5 walk: Team page cards with tools, menu, refused move, Alt+Down into the draft');
  } finally {
    if (W) W.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
