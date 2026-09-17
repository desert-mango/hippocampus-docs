#!/usr/bin/env node
// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 5 September 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Measure rendered librarian search answers and request latency over HTTP.
/* bench_librarian — measure the librarian over HTTP, in two modes.

   PROBE MODE — what a browser would actually render, per probe:

     node tools/bench_librarian.mjs --probes
     node tools/bench_librarian.mjs --probes --base http://127.0.0.1:8141 --delay 0
     node tools/bench_librarian.mjs --probes --kind semantic
     node tools/bench_librarian.mjs --probes --probe "motor mount CAD"

   It runs data/search-probes.json through the REAL client engine — the very
   functions js/search.js hands the browser (buildItems, searchItems,
   projectCandidates, pickRows, mergePicks) — and mirrors the client's own
   rules rather than approximating them:

     - ROUTING. A single-word query never POSTs; a multi-word one always does,
       INCLUDING when the keyword engine found nothing (candidates: []). Of the
       twelve probes exactly five POST: three multi-word keyword probes and the
       two semantic ones.
     - THE SCHEMA CHECK. A 200 whose payload pickRows rejects — a bad href, a
       row missing kind or title — is a librarian FAILURE for that probe, not a
       silently smaller answer: rendered rank falls back to the local rank and
       the notice path is taken. So a PASS here means the browser would render
       the same rows, not merely that the function answered something.
     - THE NOTICE SPLIT. On a non-2xx the body is parsed once: exhausted → the
       quota notice, anything else → the unreachable notice. The row shows the
       status it took (e.g. `502 exhausted`).

   PROVIDER-COMPARISON MODE — which model answers better, on the KEYWORD probes:

     node tools/bench_librarian.mjs --base http://127.0.0.1:8131
     node tools/bench_librarian.mjs --base https://<deployment> --provider nemotron
     node tools/bench_librarian.mjs --base https://<deployment> --delay 12000

   The semantic probes are excluded from it by construction: their `expect` is a
   LIST and their bar is top-N, not rank 1, so they cannot be scored on the same
   scale — and keeping the comparison at 15 queries x 2 providers = 30 requests
   rather than 34 matters against a 50-a-day free cap. Rank is read off the
   MERGED rows (pickRows + mergePicks, exactly as the client folds an answer
   into the local list), never off the raw id list, because the raw ids are not
   what anybody sees.

   PACING, AND WHY IT IS NOT OPTIONAL. The function limits one caller to 6
   requests per rolling 60s window (one request is now up to three upstream
   calls) and 429s the seventh. Fired back-to-back, a run loses its last queries
   to the limiter — and those losses land in the error column, where they are
   indistinguishable from a provider that actually failed. So requests are
   spaced by 12,000ms: in PROBE mode on EVERY base, loopback included, because
   the per-key exemption does not protect the upstream's own 20-calls-a-minute
   free ceiling and one probe can spend three of them; in comparison mode on
   hosted bases only, where a direct loopback request carries no
   x-forwarded-for and is exempt from the per-key budget. `--delay 0` disables
   it — the right thing against tools/dev_site.mjs's mock, which calls nobody.

   It talks HTTP to a running site and nothing else: it never imports
   api/librarian.js, so it runs unchanged in a checkout that has no api/
   directory (the GitHub Pages copy) — it will simply report that the base URL
   has no librarian. Before the first query it GETs the function once and prints
   the `x-librarian-version` it answers with, so a run against a stale
   deployment is visible in line one instead of being read as bad ranking. That
   GET is refused with a 405 before the handler reads a body, checks an origin
   or touches the rate limiter, so it costs no quota and no limiter slot.

   The candidates it sends are the REAL ones. It loads the search shards off
   disk and runs js/search.js's own local engine over them, so the prompt the
   function builds during a bench run is byte-for-byte the prompt it builds for
   a browser.

   WHAT A COMPARISON RESULT MEANS. A winner is declared only when BOTH providers
   answered all 15 queries error-free. Anything else prints BLOCKED and the
   default provider order stays provisional. That rule exists so a provider can
   never "win" by being the only one with a key configured: the zero-key run and
   the one-key run reach exactly the same verdict — no winner.

   NOT A BENCHMARK OUTCOME: both entries are FREE variants by Kyle's decision
   (2026-09-04, "set and forget") and never a Llama-family model by policy. No
   number this script prints can put a paid or Llama model on the ballot.

   AND NOT A QUALITY MEASUREMENT AGAINST A MOCK. Run against
   `tools/dev_site.mjs --mock-provider=graph`, every number below describes
   PLUMBING — ids resolving, rows merging, the render surviving — because that
   mock ranks by token overlap. A semantic probe failing there is expected and
   means nothing about the real librarian.

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

const PROVIDERS = ['nemotron', 'nano'];
const KINDS = ['semantic', 'keyword'];
const REQUEST_TIMEOUT_MS = 30000;   // above the function's own 15s ceiling
// dev_site.mjs's own default port: probe mode is the local-first mode, so it
// has a working default and --base is optional there.
const DEFAULT_BASE = 'http://127.0.0.1:8131';

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

/* 5 requests per 60s against a limiter that now allows 6 — one spare slot, so
   ordinary network jitter cannot push the run over the edge. It was 6000ms
   when the limiter allowed 12; halving the budget doubles the interval. */
const HOSTED_MIN_INTERVAL_MS = 12000;
/* Probe mode paces on EVERY base, loopback included. The per-key exemption a
   direct loopback request enjoys is the FUNCTION's limiter, and that is not
   the binding constraint any more: one probe is up to three upstream calls
   against a free tier that allows 20 a minute, and a loopback dev server
   forwards to exactly the same upstream a deployment does. Against a mock,
   pass --delay 0. */
const PROBE_MIN_INTERVAL_MS = 12000;

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
  const out = {
    base: null, providers: PROVIDERS.slice(), delay: null,
    probes: false, kind: null, probe: null, pinned: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    if (arg === '--probes') { out.probes = true; continue; }
    let m = arg.match(/^--kind(?:=(.*))?$/);
    if (m) {
      const value = m[1] !== undefined ? m[1] : argv[++i];
      if (KINDS.indexOf(value) === -1) {
        throw new Error(`--kind must be one of ${KINDS.join('|')}`);
      }
      out.kind = value;
      continue;
    }
    m = arg.match(/^--probe(?:=(.*))?$/);
    if (m) {
      const value = m[1] !== undefined ? m[1] : argv[++i];
      if (typeof value !== 'string' || !value.trim()) {
        throw new Error('--probe needs the query text of a probe, e.g. --probe "motor mount CAD"');
      }
      out.probe = value.trim();
      continue;
    }
    m = arg.match(/^--base(?:=(.*))?$/);
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
      out.pinned = true;
      continue;
    }
    throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  // Flags that only mean something in one mode are REFUSED in the other rather
  // than ignored: a silently dropped --kind would have the run print twelve
  // rows and look like it obeyed.
  if (!out.probes && (out.kind || out.probe)) {
    throw new Error('--kind and --probe belong to --probes mode');
  }
  if (out.probes && out.pinned) {
    // The browser cannot pin a provider, and probe mode's whole claim is that
    // it does exactly what the browser does.
    throw new Error('--provider belongs to the comparison mode: probe mode mirrors the client, which never pins one');
  }
  return out;
}

// ------------------------------------------------------------- the queries --

/* A probe names the FILE it expects; the winning row may be the symbol inside
   that file (same URL plus a #L<line> anchor) or, for a page, the heading
   inside it (same route plus an @anchor). The probe is satisfied either way,
   so both anchors come off before the comparison — the same normalisation
   tools/tests/test_search_routing.mjs does on its side. */
const fileOf = (href) => {
  const s = String(href == null ? '' : href);
  if (s.startsWith('#/')) return s.split('@')[0];
  return s.replace(/#L\d+$/, '');
};

/* 1-based rank of the first row pointing at `expect`, or 0 when it is absent. */
function rankOf(rows, expect) {
  const want = fileOf(expect);
  return (Array.isArray(rows) ? rows : []).findIndex((r) => fileOf(r && r.href) === want) + 1;
}

const rankText = (rank) => (rank > 0 ? String(rank) : '—');

function loadItems() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'search', 'manifest.json'), 'utf8'));
  const shards = manifest.shards.map((s) =>
    JSON.parse(fs.readFileSync(path.join(ROOT, s.file), 'utf8')));
  return HC.buildItems(shards);
}

function readProbes() {
  return JSON.parse(
    fs.readFileSync(path.join(ROOT, 'data', 'search-probes.json'), 'utf8')).probes;
}

/* The comparison set: the KEYWORD probes verbatim plus the five extra queries.
   The semantic probes are filtered out here and nowhere else — one line, so
   the reason for it stays next to it. Their `expect` is a list of strings and
   their bar is "inside the top N", which is not the same measurement as "rank
   1" and cannot share a column with it. */
function buildCases(items) {
  const wanted = readProbes()
    .filter((p) => p.kind !== 'semantic')
    .map((p) => ({ q: p.q, expect: p.expect, note: p.kind }))
    .concat(EXTRA_QUERIES);

  const cases = [];
  for (const w of wanted) {
    const local = HC.searchItems(items, w.q);
    const candidates = HC.projectCandidates(local.results);
    const ids = HC.assignIds(local.results);
    const localRank = rankOf(local.results, w.expect);
    const expectId = localRank > 0 ? ids[localRank - 1] : null;
    const inCandidates = expectId !== null
      && candidates.some((c) => c.id === expectId);
    cases.push({
      q: w.q, note: w.note, expect: w.expect, expectId, localRank, inCandidates,
      candidates, localResults: local.results,
    });
  }
  return cases;
}

/* The probe set: every probe in the file, in file order, narrowed by --kind
   and --probe. `expects` is always a list and `top` always a number, so the
   keyword and semantic bars are two settings of one comparison rather than two
   code paths: keyword probes want their single link at rank 1, semantic probes
   want every listed link inside the top `top`. */
function buildProbeRuns(kind, only) {
  const runs = readProbes()
    .filter((p) => {
      if (kind === 'semantic') return p.kind === 'semantic';
      if (kind === 'keyword') return p.kind !== 'semantic';
      return true;
    })
    .filter((p) => (only ? String(p.q).trim().toLowerCase() === only.toLowerCase() : true))
    .map((p) => {
      const semantic = p.kind === 'semantic';
      return {
        q: String(p.q),
        kind: String(p.kind || ''),
        semantic,
        expects: semantic ? p.expect.slice() : [p.expect],
        fair: Array.isArray(p.fair) ? p.fair.slice() : [],
        top: semantic ? Number(p.top) : 1,
      };
    });
  if (only && !runs.length) {
    throw new Error(`--probe ${JSON.stringify(only)} matches no probe in data/search-probes.json`);
  }
  return runs;
}

// -------------------------------------------------------------- the client --

const endpoint = (base) => `${String(base).replace(/\/+$/, '')}/api/librarian`;

/* An Origin the handler accepts on any base: its OWN. A loopback origin passes
   the localhost branch of originAllowed(); a hosted one equals the request's
   Host header and passes the same-origin branch. Sending it (rather than
   sending none, which is also allowed) means the bench exercises the gate a
   browser goes through instead of the one curl gets waved past. */
function originFor(base) {
  try { return new URL(String(base)).origin; } catch (e) { return null; }
}

function headersFor(base) {
  const origin = originFor(base);
  const headers = { 'content-type': 'application/json' };
  if (origin) headers.origin = origin;
  return headers;
}

/* The deployment's own version stamp, for free. A GET is refused with 405
   BEFORE the handler reads a body, checks the origin or touches the rate
   limiter, so this spends no quota and no limiter slot — it is the readiness
   probe, and it is here so a run against a stale deployment reads as a stale
   deployment rather than as a bad model. */
async function askVersion(base) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint(base), {
      method: 'GET', headers: headersFor(base), signal: ctrl.signal,
    });
    return { status: res.status, version: res.headers.get('x-librarian-version') };
  } catch (e) {
    return { status: 0, reason: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

/* One POST, reported RAW: the status, the parsed body if there was one, and
   the wall time. Nothing is judged here — probe mode has to mirror the
   client's own reading of a non-2xx (exhausted or not) and the comparison mode
   wants its own error strings, so a verdict baked in at this level would have
   to be unpicked by both. `status: 0` means the request never completed. */
async function ask(base, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  /* `ms` measures the REQUEST ONLY. Both callers sleep for pacing BEFORE they
     call in here, so the wait that spaces requests is outside this clock and
     is never reported as latency — the same invariant probe mode keeps by
     re-stamping its own mark just before this call. */
  const started = Date.now();
  try {
    const res = await fetch(endpoint(base), {
      method: 'POST',
      headers: headersFor(base),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    const ms = Date.now() - started;
    let doc = null;
    try { doc = JSON.parse(text); } catch (e) { /* keep the raw text as the reason */ }
    return { ms, status: res.status, doc, text, version: res.headers.get('x-librarian-version') };
  } catch (e) {
    const ms = Date.now() - started;
    const reason = e && e.name === 'AbortError'
      ? `timed out after ${REQUEST_TIMEOUT_MS}ms`
      : String((e && e.message) || e);
    return { ms, status: 0, doc: null, text: '', reason };
  } finally {
    clearTimeout(timer);
  }
}

/* The comparison mode's verdict on one answer: 2xx, the agreed shape, and a
   payload the CLIENT would accept — a body pickRows rejects never reaches a
   browser, so counting it as an answer here would score rows nobody sees. */
function judge(out) {
  if (out.status === 0) return { ok: false, reason: out.reason };
  if (out.status < 200 || out.status >= 300) {
    const detail = out.doc && Array.isArray(out.doc.providers)
      ? out.doc.providers.map((p) => `${p.provider}: ${p.reason}`).join('; ')
      : (out.doc && out.doc.error) || String(out.text).slice(0, 160);
    return { ok: false, reason: `HTTP ${out.status} — ${detail}` };
  }
  if (!out.doc || !Array.isArray(out.doc.results)) {
    return { ok: false, reason: 'answer was not the agreed JSON shape' };
  }
  const rows = HC.pickRows(out.doc);
  if (!rows) {
    return { ok: false, reason: 'the answer failed the client schema check (pickRows)' };
  }
  return { ok: true, rows };
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
    const verdict = judge(out);
    if (!verdict.ok) {
      row.errors += 1;
      if (!row.firstError) row.firstError = verdict.reason;
      row.perQuery.push({ q: c.q, ok: false, reason: verdict.reason });
      continue;
    }
    row.answered += 1;
    if (typeof out.doc.promptChars === 'number') row.promptChars.push(out.doc.promptChars);
    row.temperatures.add(out.doc.temperature);
    row.models.add(out.doc.model);
    /* Scored on the MERGED list — what the browser would show — not on the raw
       ids. The two differ: the answer may carry rows the local index never had,
       the pin may move the leader, and rows the client refuses never appear.
       "in picks" therefore means "above the divider", i.e. the librarian
       actually promoted it, rather than the vacuous "somewhere in the merged
       list", which every local hit satisfies by construction. */
    const merged = HC.mergePicks(c.localResults, verdict.rows, c.q);
    const at = rankOf(merged.results, c.expect);
    if (at === 1) row.top1 += 1;
    if (at > 0 && at <= merged.librarianCount) row.inPicks += 1;
    row.perQuery.push({
      q: c.q, ok: true, rank: at || null, picks: merged.librarianCount, ms: out.ms,
    });
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

// -------------------------------------------------------------- probe mode --

/* One probe, run the way the browser runs it. Everything that decides an
   outcome here is imported from js/search.js, so this cannot drift from the
   client by being reimplemented: only the ROUTING decision (single word or
   not) is written out, and it is written out in the client's own words. */
async function runProbe(base, probe, items, delay) {
  /* Wall ms measures the REQUEST ONLY, never the pacing wait: this mark is
     RE-STAMPED just before the fetch (below), after the sleep that spaces
     requests. Stamped once up here it counted the sleep, and a probe the
     function answered in 311ms was reported as 1673ms wall — enough to name
     the wrong probe "slowest search". Pacing itself is unchanged: `delay`
     still spaces request STARTS. */
  let measuredFrom = Date.now();
  const local = HC.searchItems(items, probe.q);
  const trimmed = probe.q.trim();
  const row = {
    q: probe.q, kind: probe.kind, semantic: probe.semantic, top: probe.top,
    localRank: rankOf(local.results, probe.expects[0]),
    posted: false, calls: null, hops: null, fnMs: null,
    provider: 'local', notice: null, rendered: local.results, librarianCount: 0,
  };

  const settle = () => {
    row.wallMs = Date.now() - measuredFrom;
    row.ranks = probe.expects.map((e) => rankOf(row.rendered, e));
    row.fairRanks = probe.fair.map((e) => rankOf(row.rendered, e));
    row.pass = row.ranks.length > 0 && row.ranks.every((r) => r > 0 && r <= probe.top);
    return row;
  };

  // The routing rule, verbatim from js/search.js: a single word is answered by
  // the local index with ZERO network, whatever it found.
  if (!/\s/.test(trimmed)) {
    row.provider = 'none (single word)';
    return settle();
  }

  if (delay) {
    const since = Date.now() - lastRequestStartedAt;
    if (lastRequestStartedAt && since < delay) await sleep(delay - since);
  }
  lastRequestStartedAt = Date.now();
  row.posted = true;
  // candidates MAY be empty — a multi-word query the keyword engine cannot
  // answer is exactly the one the walk exists for, and the client posts it.
  const candidates = HC.projectCandidates(local.results);
  measuredFrom = Date.now();   // the wall clock starts HERE: the pacing wait is over.
  const out = await ask(base, { q: trimmed, candidates });
  row.status = out.status;

  if (out.status === 0) {
    row.provider = 'unreachable';
    row.notice = HC.LIBRARIAN_NOTICE;
    row.reason = out.reason;
    return settle();                         // local order, untouched
  }
  const verdict = HC.classifyStatus(out.status);
  if (verdict === 'absent') {
    // 404/405/501: this host has no function. The client latches and shows
    // nothing at all — not even a notice.
    row.provider = `${out.status} absent`;
    return settle();
  }
  if (verdict !== 'ok') {
    // ONE body read decides which truth the notice tells, exactly as the
    // client decides it.
    const spent = Boolean(out.doc && typeof out.doc === 'object' && out.doc.exhausted === true);
    row.provider = `${out.status} ${spent ? 'exhausted' : 'unreachable'}`;
    row.notice = spent ? HC.LIBRARIAN_QUOTA_NOTICE : HC.LIBRARIAN_NOTICE;
    row.reason = out.doc && Array.isArray(out.doc.providers)
      ? out.doc.providers.map((p) => `${p.provider} hop ${p.hop}: ${p.reason}`).join('; ')
      : (out.doc && out.doc.error) || String(out.text).slice(0, 160);
    return settle();
  }

  if (typeof out.doc.calls === 'number') row.calls = out.doc.calls;
  if (typeof out.doc.hops === 'number') row.hops = out.doc.hops;
  if (typeof out.doc.ms === 'number') row.fnMs = out.doc.ms;
  row.partial = Boolean(out.doc.partial);

  const rows = HC.pickRows(out.doc);
  if (!rows) {
    // A payload the client refuses is a librarian FAILURE, not a thin answer:
    // the browser would show the local list and the notice, so that is what
    // this row reports and what it is graded on.
    row.provider = 'schema failure';
    row.notice = HC.LIBRARIAN_NOTICE;
    return settle();
  }
  const merged = HC.mergePicks(local.results, rows, trimmed);
  row.rendered = merged.results;
  row.librarianCount = merged.librarianCount;
  row.provider = String(out.doc.provider || 'answered') + (row.partial ? ' (partial)' : '');
  return settle();
}

const COLUMNS = ['q', 'kind', 'local', 'rendered', 'calls', 'hops', 'provider', 'wall ms', ''];

function probeTable(rows) {
  const cells = rows.map((r) => [
    r.q,
    r.kind,
    rankText(r.localRank),
    r.ranks.map(rankText).join(','),
    r.calls === null ? '—' : String(r.calls),
    r.hops === null ? '—' : String(r.hops),
    r.provider,
    r.posted ? String(r.wallMs) : '—',
    r.pass ? 'PASS' : 'FAIL',
  ]);
  const widths = COLUMNS.map((h, i) =>
    Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c) => c.map((v, i) => (i === c.length - 1 ? v : v.padEnd(widths[i]))).join('  ');
  const out = [`  ${line(COLUMNS)}`, `  ${widths.map((w) => '-'.repeat(w)).join('  ')}`];
  for (const c of cells) out.push(`  ${line(c)}`);
  return out.join('\n');
}

function probeReport(rows) {
  const out = [];
  const posted = rows.filter((r) => r.posted);
  const calls = posted.filter((r) => r.calls !== null).map((r) => r.calls);
  const slowest = posted.slice().sort((a, b) => b.wallMs - a.wallMs)[0];
  const passed = rows.filter((r) => r.pass).length;

  out.push('');
  out.push(`  POSTed          ${posted.length}/${rows.length} searches (single-word probes never reach the network)`);
  out.push(slowest
    ? `  slowest search  ${JSON.stringify(slowest.q)} ${slowest.wallMs}ms wall`
    : '  slowest search  n/a (nothing was POSTed)');
  out.push(calls.length
    ? `  mean calls      ${(calls.reduce((a, b) => a + b, 0) / calls.length).toFixed(2)} per POSTed search `
      + `(${calls.reduce((a, b) => a + b, 0)} model calls over ${calls.length} answers)`
    : '  mean calls      n/a (no search was answered)');
  out.push(`  passed          ${passed}/${rows.length}`);

  const timed = posted.filter((r) => r.fnMs !== null);
  if (timed.length) {
    out.push('  function ms     (the function\'s own clock, per POSTed probe)');
    for (const r of timed) {
      out.push(`                  ${String(r.fnMs).padStart(6)}ms  ${JSON.stringify(r.q)}`);
    }
  }
  const notices = rows.filter((r) => r.notice);
  for (const r of notices) {
    out.push(`  notice          ${JSON.stringify(r.q)} → ${r.notice}`);
    if (r.reason) out.push(`                  ${String(r.reason).slice(0, 200)}`);
  }
  const fair = rows.filter((r) => r.fairRanks.length);
  for (const r of fair) {
    out.push(`  fair extras     ${JSON.stringify(r.q)} → ${r.fairRanks.map(rankText).join(', ')} `
      + '(informational: acceptable, never required)');
  }
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
const USAGE =
  'usage: node tools/bench_librarian.mjs --base <url> [--provider nemotron|nano] [--delay <ms>]\n'
  + '       node tools/bench_librarian.mjs --probes [--base <url>] [--delay <ms>]'
  + ' [--kind semantic|keyword] [--probe "<q>"]\n'
  + '  --probes runs data/search-probes.json through the real client engine and prints, per\n'
  + '          probe, the local rank, the RENDERED rank, calls, hops, provider and wall time.\n'
  + `          --base is optional here and defaults to ${DEFAULT_BASE}.\n`
  + '          --kind narrows to the 10 keyword probes (3 POSTs) or the 2 semantic ones (2 POSTs);\n'
  + '          --probe runs a single probe by its exact query text.\n'
  + '  --base is required in comparison mode; it is the site root, e.g. http://127.0.0.1:8131\n'
  + '  --delay spaces requests out. In --probes mode it defaults to '
  + `${PROBE_MIN_INTERVAL_MS}ms on EVERY base,\n`
  + '          loopback included: one probe is up to three upstream calls against a free tier\n'
  + '          that allows 20 a minute. In comparison mode it defaults to '
  + `${HOSTED_MIN_INTERVAL_MS}ms against a\n`
  + '          hosted base and 0 against loopback, because the deployed function 429s the 7th\n'
  + '          request in any 60s window. Pass 0 to disable it — the right thing against\n'
  + '          tools/dev_site.mjs --mock-provider=graph, which calls no provider at all.\n';

if (args.help || (!args.probes && !args.base)) {
  process.stdout.write(USAGE);
  process.exit(args.help ? 0 : 1);
}

const base = args.base || DEFAULT_BASE;
const items = loadItems();

/* Printed before anything is measured: a run against a deployment that predates
   the walk would otherwise look like a run against a bad model. */
const stamp = await askVersion(base);
const versionLine = stamp.status === 0
  ? `unreachable (${stamp.reason})`
  : `${stamp.version || 'ABSENT — this deployment predates the walk'} (GET answered ${stamp.status}, zero quota)`;

if (args.probes) {
  let runs;
  try {
    runs = buildProbeRuns(args.kind, args.probe);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
  const delay = args.delay !== null ? args.delay : PROBE_MIN_INTERVAL_MS;
  const willPost = runs.filter((r) => /\s/.test(r.q.trim())).length;
  process.stdout.write(
    `librarian bench — ${runs.length} probe${runs.length === 1 ? '' : 's'} against ${base}\n`);
  process.stdout.write(`  x-librarian-version: ${versionLine}\n`);
  process.stdout.write(`  local index: ${items.length} entries\n`);
  process.stdout.write(`  POSTs:       ${willPost} of ${runs.length} probes are multi-word\n`);
  process.stdout.write(delay
    ? `  pacing:      ${delay}ms between POSTs, on every base\n`
    : '  pacing:      none (--delay 0)\n');
  process.stdout.write('\n');

  const probeRows = [];
  for (const probe of runs) probeRows.push(await runProbe(base, probe, items, delay));
  process.stdout.write(`${probeTable(probeRows)}\n`);
  process.stdout.write(`${probeReport(probeRows)}\n`);
  process.stdout.write(
    '\n  PASS means the BROWSER would render it: keyword probes at rendered rank 1, semantic\n'
    + '  probes with every expected link inside the top N. Against a mock provider these\n'
    + '  numbers describe plumbing only — the mock ranks by token overlap, not by meaning.\n');
  process.exit(0);
}

const cases = buildCases(items);
const delay = args.delay !== null
  ? args.delay
  : (isLoopbackBase(base) ? 0 : HOSTED_MIN_INTERVAL_MS);
process.stdout.write(`librarian bench — ${cases.length} queries against ${base}\n`);
process.stdout.write(`  x-librarian-version: ${versionLine}\n`);
process.stdout.write(`  local index: ${items.length} entries\n`);
process.stdout.write(delay
  ? `  pacing:      ${delay}ms between requests (the function 429s the 7th in any 60s window)\n`
  : '  pacing:      none (loopback base is exempt from the per-key budget)\n');
process.stdout.write(
  '  scope:       the 10 keyword probes + 5 extra queries; the 2 semantic probes are\n'
  + '               scored by --probes instead (their bar is top-N, not rank 1)\n');
const unusable = cases.filter((c) => !c.inCandidates);
for (const c of unusable) {
  process.stdout.write(
    `  note: "${c.q}" — the expected hit is not in the candidate list `
    + `(local rank ${c.localRank || 'miss'}); scored as a miss for every provider\n`);
}
process.stdout.write('\n');

const rows = [];
for (const provider of args.providers) {
  rows.push(await runProvider(base, provider, cases, delay));
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
    + 'look like quality.\nThe default order in api/librarian.js (nemotron primary, nano '
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
    'Reminder: this decides the PRIMARY/FALLBACK ORDER only. Free-only and '
    + 'never-Llama are policy constraints and are '
    + 'not a benchmark outcome.\n');
}
