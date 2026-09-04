#!/usr/bin/env node
/* bench_librarian — compare the librarian's two providers on real queries.

     node tools/bench_librarian.mjs --base http://127.0.0.1:8131
     node tools/bench_librarian.mjs --base https://<deployment> --provider gptoss
     node tools/bench_librarian.mjs --base https://<deployment> --delay 6000

   PACING, AND WHY IT IS NOT OPTIONAL AGAINST A DEPLOYMENT. The function limits
   one caller to 12 requests per rolling 60s window and rejects the 13th with a
   429. Fired back-to-back, a 15-query run therefore loses its last queries to
   the limiter on ANY hosted base — and those losses land in the error column,
   where they are indistinguishable from a provider that actually failed. That
   would make the harness lie in the one place it is meant to be trusted, so
   requests to a non-loopback base are spaced out by default. A DIRECT loopback
   request carries no x-forwarded-for and is exempt from the per-key budget, so
   local runs against tools/dev_site.mjs stay unpaced and fast.

   It talks HTTP to a running site and nothing else: it never imports
   api/librarian.js, so it runs unchanged in a checkout that has no api/
   directory (the GitHub Pages copy) — it will simply report that the base URL
   has no librarian.

   The candidates it sends are the REAL ones. It loads the search shards off
   disk and runs js/search.js's own local engine over them, so the prompt the
   function builds during a bench run is byte-for-byte the prompt it builds for
   a browser.

   WHAT A RESULT MEANS. A winner is declared only when BOTH providers answered
   all 15 queries error-free. Anything else prints BLOCKED and the default
   provider order stays provisional. That rule exists so a provider can never
   "win" by being the only one with a key configured: the zero-key run and the
   one-key run reach exactly the same verdict — no winner.

   NOT A BENCHMARK OUTCOME: the gptoss entry's model (openai/gpt-oss-120b,
   never a Llama-family model) is fixed by POLICY. No number this script prints
   can change it; it is not on the ballot.

   BOTH ENTRIES CURRENTLY SHARE ONE GATEWAY (OpenRouter), so this compares two
   MODELS, not two vendors. A winner here settles which model answers first, and
   says nothing about infrastructure redundancy — see the note in
   api/librarian.js. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const HC = require(path.join(ROOT, 'js', 'search.js'));

const PROVIDERS = ['gptoss', 'nemotron'];
const REQUEST_TIMEOUT_MS = 30000;   // above the function's own 15s ceiling

/* 15 queries. The first ten are data/search-probes.json verbatim — the standing
   regression set — and the last five are multi-word queries drawn from real
   pages of this site. Two of those five (path planning, acoustic modem) are
   cases where the local keyword engine ranks a C++ symbol above the page a
   human actually wants: they are the ones a semantic re-rank has to earn. */
const EXTRA_QUERIES = [
  { q: 'path planning', expect: '#/setup/guides/informative-path-planning',
    note: 'the guide page, which the keyword engine ranks below path.hpp' },
  { q: 'acoustic modem', expect: '#/setup/hardware/acoustic-modems',
    note: 'the hardware page, ranked below a simulator class locally' },
  { q: 'apriltag detection', expect: '#/setup/getting-started/apriltag-localization',
    note: 'the localization setup page' },
  { q: 'gantry system', expect: '#/setup/lab-gantry/general-information',
    note: 'the lab gantry overview' },
  { q: 'ip cameras', expect: '#/setup/lab-cameras/ip-cameras',
    note: 'the IP camera page' },
];

// ------------------------------------------------------------------ pacing --

/* 10 requests per 60s against a limiter that allows 12 — two spare slots, so
   ordinary network jitter cannot push the run over the edge. */
const HOSTED_MIN_INTERVAL_MS = 6000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isLoopbackBase(base) {
  let hostname;
  try { hostname = new URL(String(base)).hostname; } catch (e) { return false; }
  hostname = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return hostname === 'localhost' || hostname === '::1' || hostname === '0.0.0.0'
    || hostname.startsWith('127.');
}

// -------------------------------------------------------------------- args --

function parseArgs(argv) {
  const out = { base: null, providers: PROVIDERS.slice(), delay: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    let m = arg.match(/^--base(?:=(.*))?$/);
    if (m) { out.base = m[1] !== undefined ? m[1] : argv[++i]; continue; }
    m = arg.match(/^--delay(?:=(.*))?$/);
    if (m) {
      const value = m[1] !== undefined ? m[1] : argv[++i];
      const ms = Number(value);
      if (!Number.isFinite(ms) || ms < 0) {
        throw new Error('--delay must be a non-negative number of milliseconds');
      }
      out.delay = ms;
      continue;
    }
    m = arg.match(/^--provider(?:=(.*))?$/);
    if (m) {
      const value = m[1] !== undefined ? m[1] : argv[++i];
      if (PROVIDERS.indexOf(value) === -1) {
        throw new Error(`--provider must be one of ${PROVIDERS.join('|')}`);
      }
      out.providers = [value];
      continue;
    }
    throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  return out;
}

// ------------------------------------------------------------- the queries --

const fileOf = (href) => String(href).replace(/#L\d+$/, '');

function loadItems() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'search', 'manifest.json'), 'utf8'));
  const shards = manifest.shards.map((s) =>
    JSON.parse(fs.readFileSync(path.join(ROOT, s.file), 'utf8')));
  return HC.buildItems(shards);
}

function buildCases(items) {
  const probes = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'data', 'search-probes.json'), 'utf8')).probes;
  const wanted = probes.map((p) => ({ q: p.q, expect: p.expect, note: p.kind }))
    .concat(EXTRA_QUERIES);

  const cases = [];
  for (const w of wanted) {
    const local = HC.searchItems(items, w.q);
    const candidates = HC.projectCandidates(local.results);
    const ids = HC.assignIds(local.results);
    const localRank = local.results.findIndex((r) => fileOf(r.href) === fileOf(w.expect)) + 1;
    const expectId = localRank > 0 ? ids[localRank - 1] : null;
    const inCandidates = expectId !== null
      && candidates.some((c) => c.id === expectId);
    cases.push({
      q: w.q, note: w.note, expect: w.expect, expectId, localRank, inCandidates, candidates,
    });
  }
  return cases;
}

// -------------------------------------------------------------- the client --

async function ask(base, body) {
  const url = `${base.replace(/\/+$/, '')}/api/librarian`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    const ms = Date.now() - started;
    let doc = null;
    try { doc = JSON.parse(text); } catch (e) { /* keep the raw text as the reason */ }
    if (!res.ok) {
      const detail = doc && Array.isArray(doc.providers)
        ? doc.providers.map((p) => `${p.provider}: ${p.reason}`).join('; ')
        : (doc && doc.error) || text.slice(0, 160);
      return { ok: false, ms, status: res.status, reason: `HTTP ${res.status} — ${detail}` };
    }
    if (!doc || !Array.isArray(doc.results)) {
      return { ok: false, ms, status: res.status, reason: 'answer was not the agreed JSON shape' };
    }
    return { ok: true, ms, status: res.status, doc };
  } catch (e) {
    const ms = Date.now() - started;
    const reason = e && e.name === 'AbortError'
      ? `timed out after ${REQUEST_TIMEOUT_MS}ms`
      : String((e && e.message) || e);
    return { ok: false, ms, status: 0, reason };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ report --

function median(numbers) {
  if (!numbers.length) return null;
  const s = numbers.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function pct(n, total) {
  return total ? `${Math.round((n / total) * 100)}%` : 'n/a';
}

/* Module-scope so the spacing carries ACROSS providers: the limiter's window is
   per caller, not per provider, and the second provider starts the instant the
   first one ends. */
let lastRequestStartedAt = 0;

async function runProvider(base, provider, cases, delay) {
  const row = {
    provider, answered: 0, errors: 0, latencies: [], top1: 0, inPicks: 0,
    promptChars: [], temperatures: new Set(), models: new Set(),
    firstError: null, perQuery: [],
  };
  for (const c of cases) {
    if (delay) {
      const since = Date.now() - lastRequestStartedAt;
      if (lastRequestStartedAt && since < delay) await sleep(delay - since);
    }
    lastRequestStartedAt = Date.now();
    const out = await ask(base, { q: c.q, candidates: c.candidates, provider });
    row.latencies.push(out.ms);
    if (!out.ok) {
      row.errors += 1;
      if (!row.firstError) row.firstError = out.reason;
      row.perQuery.push({ q: c.q, ok: false, reason: out.reason });
      continue;
    }
    row.answered += 1;
    if (typeof out.doc.promptChars === 'number') row.promptChars.push(out.doc.promptChars);
    row.temperatures.add(out.doc.temperature);
    row.models.add(out.doc.model);
    const ids = out.doc.results.map((r) => r.id);
    const at = ids.indexOf(c.expectId) + 1;
    if (at === 1) row.top1 += 1;
    if (at > 0) row.inPicks += 1;
    row.perQuery.push({ q: c.q, ok: true, rank: at || null, picks: ids.length, ms: out.ms });
  }
  return row;
}

function printProvider(row, total) {
  const out = [];
  out.push(`provider ${row.provider}`);
  out.push(`  answered      ${row.answered}/${total}`);
  out.push(`  errors        ${row.errors}`);
  out.push(`  median ms     ${median(row.latencies) === null ? 'n/a' : median(row.latencies)}`);
  // The tail is what a timeout has to be set against, not the median.
  const okMs = row.perQuery.filter((q) => q.ok).map((q) => q.ms).sort((a, b) => a - b);
  if (okMs.length) {
    const p90 = okMs[Math.min(okMs.length - 1, Math.floor(okMs.length * 0.9))];
    out.push(`  answered ms   p90 ${p90}  max ${okMs[okMs.length - 1]}  (successful answers only)`);
  }
  out.push(`  top-1 hits    ${row.top1}/${total} (${pct(row.top1, total)})`);
  out.push(`  in-picks hits ${row.inPicks}/${total} (${pct(row.inPicks, total)})`);
  out.push(`  prompt chars  ${row.promptChars.length ? median(row.promptChars) : 'n/a'} (median, measured by the function)`);
  // Every distinct failure, with a count. A single "first error" line hid the
  // other fourteen reasons in a 0/15 run and sent the diagnosis down the wrong
  // road; the record has to carry all of them.
  const reasons = new Map();
  for (const q of row.perQuery) {
    if (q.ok) continue;
    const key = String(q.reason).slice(0, 160);
    reasons.set(key, (reasons.get(key) || []).concat(q.q));
  }
  for (const [reason, qs] of reasons) {
    out.push(`  failure x${qs.length}   ${reason}`);
    out.push(`                on: ${qs.map((q) => JSON.stringify(q)).join(', ')}`);
  }
  const temps = Array.from(row.temperatures);
  out.push(`  temperature   ${temps.length ? temps.join(', ') : 'n/a'} (reported per answer; the client cannot set it)`);
  const models = Array.from(row.models);
  out.push(`  model         ${models.length ? models.join(', ') : 'n/a'}`);
  if (row.firstError) out.push(`  first error   ${row.firstError}`);
  return out.join('\n');
}

// -------------------------------------------------------------------- main --

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
}
if (args.help || !args.base) {
  process.stdout.write(
    'usage: node tools/bench_librarian.mjs --base <url> [--provider groq|nvidia] [--delay <ms>]\n'
    + '  --base is required; it is the site root, e.g. http://127.0.0.1:8131\n'
    + '  --delay spaces requests out; it defaults to '
    + `${HOSTED_MIN_INTERVAL_MS}ms against a hosted base and 0 against loopback,\n`
    + '          because the deployed function 429s the 13th request in any 60s window.\n'
    + '          Pass 0 to disable it; expect rate-limit errors if you do.\n');
  process.exit(args.help ? 0 : 1);
}

const items = loadItems();
const cases = buildCases(items);
const delay = args.delay !== null
  ? args.delay
  : (isLoopbackBase(args.base) ? 0 : HOSTED_MIN_INTERVAL_MS);
process.stdout.write(`librarian bench — ${cases.length} queries against ${args.base}\n`);
process.stdout.write(`  local index: ${items.length} entries\n`);
process.stdout.write(delay
  ? `  pacing:      ${delay}ms between requests (the function 429s the 13th in any 60s window)\n`
  : '  pacing:      none (loopback base is exempt from the per-key budget)\n');
const unusable = cases.filter((c) => !c.inCandidates);
for (const c of unusable) {
  process.stdout.write(
    `  note: "${c.q}" — the expected hit is not in the candidate list `
    + `(local rank ${c.localRank || 'miss'}); scored as a miss for every provider\n`);
}
process.stdout.write('\n');

const rows = [];
for (const provider of args.providers) {
  rows.push(await runProvider(args.base, provider, cases, delay));
}
for (const row of rows) process.stdout.write(`${printProvider(row, cases.length)}\n\n`);

const blocked = [];
for (const row of rows) {
  if (row.errors > 0) {
    blocked.push(`${row.provider}: ${row.answered}/${cases.length} answered — ${row.firstError}`);
  } else if (Array.from(row.temperatures).some((t) => t !== 0)) {
    blocked.push(`${row.provider}: answered at temperature ${Array.from(row.temperatures).join(', ')}, not 0`);
  }
}
if (args.providers.length < PROVIDERS.length) {
  blocked.push(`${PROVIDERS.filter((p) => args.providers.indexOf(p) === -1).join(', ')}: not run (--provider narrowed the comparison)`);
}

if (blocked.length) {
  for (const line of blocked) process.stdout.write(`BLOCKED: ${line}\n`);
  process.stdout.write(
    '\nNo winner. A provider is only declared the winner when BOTH answered all '
    + `${cases.length} queries error-free at temperature 0, so that availability can never `
    + 'look like quality.\nThe default order in api/librarian.js (groq primary, nvidia '
    + 'fallback) stays PROVISIONAL.\n');
} else {
  const ranked = rows.slice().sort((a, b) =>
    b.top1 - a.top1 || b.inPicks - a.inPicks || median(a.latencies) - median(b.latencies));
  const [win, lose] = ranked;
  const tied = win.top1 === lose.top1 && win.inPicks === lose.inPicks;
  process.stdout.write(tied
    ? `TIE on quality (${win.top1}/${cases.length} top-1 each) — ${ranked[0].provider} is faster `
      + `(${median(ranked[0].latencies)}ms vs ${median(ranked[1].latencies)}ms median).\n`
    : `WINNER: ${win.provider} — ${win.top1}/${cases.length} top-1 vs ${lose.top1}/${cases.length}, `
      + `median ${median(win.latencies)}ms vs ${median(lose.latencies)}ms.\n`);
  process.stdout.write(
    'Reminder: this decides the PRIMARY/FALLBACK ORDER only. Groq\'s model choice '
    + '(openai/gpt-oss-120b, never a Llama-family model) is a policy constraint and is '
    + 'not a benchmark outcome.\n');
}
