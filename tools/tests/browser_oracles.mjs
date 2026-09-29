// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 29 September 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Run the R3 block-sentinel oracles (b) and (c) in a real headless Chrome over every content page.
/* R3 oracles (b) and (c) (plan D-E), the repo's first scripted Chrome test.
   Oracle (a) — the blocks join back to the file — runs in node
   (tools/tests/test_block_model.mjs); (b) and (c) are questions about the
   HTML tree builder, which node has none of, so they run here:

     (b) render-equivalence: a page rendered with HCCore.withSentinels(text),
         sentinels then removed from the DOM, equals the page rendered
         without them;
     (c) every sentinel is in the DOM and a DIRECT child of the page body.

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
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`browser oracles: ${real.length} PASS over ${files.length} content pages (${sentinels} sentinels checked), `
      + `negative FAIL as it must; ${secs} s`);
  } finally {
    for (const child of live) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    if (server) { server.closeAllConnections?.(); server.close(); }
    rmSync(scratch, { recursive: true, force: true });
  }
});
