// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 15 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Put approved per-edit changes from open proposals onto main, under the site's trust rules and gate.
/* The go-live engine (plan-u5 U5a), run by .github/workflows/go-live.yml from MAIN's own files.

   A reviewer approves one edit of a proposal on the page; the editor writes a record, a PR comment
   `hc-approved <key> …` (or `hc-declined <key> …`). This engine sweeps EVERY open proposal each run (so
   a cancelled or failed run loses nothing) and puts the approved edits on main:

     a proposal   head ref cms/* in this repository, open, not a draft, every changed file an existing
                  content/**.md (anything else: whole-proposal review on GitHub, never per edit)
     a record     trusted when its author (the comment's API login, never its text) is not the proposal's
                  author, wrote or committed no commit of the PR, and may approve that page
                  (HCCore.mayApproveEdit: role_name admin anywhere; maintain/write only as the project's
                  owner, the same people CODEOWNERS names); the latest trusted record per key wins
     an edit      HCCore.proposalEdits(path, merge base, head, main): applied in head order by
                  HCCore.applyEdits; a key not in the head's CURRENT diff is stale and ignored

   Order: work out the groups (one group = one PR x one file; reads only) -> none: exit quietly -> the
   gate (derive.py offline + check.py) on untouched main: red: exit 1, post nothing -> each group added
   onto the passing set, gate after each; a group that turns it red is put back and each of its keys gets
   a failure record `hc-go-live-failed <key> <head sha>: `<reason>`` (never retried at that head) ->
   the plan file for the push step. The engine never runs or checks out proposal code: proposal texts
   are DATA read through the contents API.

     node tools/go_live.mjs [--dry-run] [--pr <n>] [--plan <file>]   sweep (GH_TOKEN, GITHUB_REPOSITORY)
     node tools/go_live.mjs --commit <plan>                         commit the plan's groups (push step)
     node tools/go_live.mjs --close-done                            close proposals with nothing left open

   --dry-run writes and posts nothing and prints what it would do; with --pr <n> it also looks at a
   draft (the proof's first step). Node stdlib only; HCCore is js/cms-core.js (the browser's own code,
   so the page and the engine cannot drift). */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const C = require(path.join(ROOT, 'js', 'cms-core.js'));

export const CONTENT_RE = /^content\/[a-z0-9/_-]+\.md$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_PAGES = 30;

const lower = (s) => (typeof s === 'string' ? s.toLowerCase() : '');

async function allPages(api, p) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const sep = p.includes('?') ? '&' : '?';
    const res = await api.get(`${p}${sep}per_page=100&page=${page}`);
    if (res.status !== 200 || !Array.isArray(res.data)) throw new Error(`GET ${p}: HTTP ${res.status}`);
    out.push(...res.data);
    if (res.data.length < 100) break;
  }
  return out;
}

function isProposal(pull, repo, opts) {
  if (!pull || pull.state !== 'open') return false;
  if (pull.draft === true && !(opts.dryRun && opts.pr === pull.number)) return false;
  const h = pull.head || {};
  return typeof h.ref === 'string' && h.ref.startsWith('cms/') && SHA_RE.test(String(h.sha))
    && h.repo && h.repo.full_name === repo;
}

/* Everything one proposal needs, read once: its eligible paths, records, failures, committers, base. */
async function readProposal(api, repo, pull, files) {
  const RA = `/repos/${repo}`;
  const n = pull.number;
  const changed = await allPages(api, `${RA}/pulls/${n}/files`);
  const paths = changed.map((f) => f && f.filename);
  const eligible = changed.length > 0 && changed.every((f) => f && f.status === 'modified' && CONTENT_RE.test(f.filename));
  if (!eligible) return null;
  for (const p of paths) if ((await files.read(p)) === null) return null;
  const comments = await allPages(api, `${RA}/issues/${n}/comments`);
  const author = lower(pull.user && pull.user.login);
  const records = C.parseRecords(comments, { author }).list;
  if (!records.length) return null;
  const commits = await allPages(api, `${RA}/pulls/${n}/commits`);
  const committers = new Set();
  for (const c of commits) {
    for (const who of [c && c.author, c && c.committer]) {
      const l = lower(who && who.login);
      if (l && l !== 'web-flow') committers.add(l);
    }
  }
  const cmp = await api.get(`${RA}/compare/main...${pull.head.sha}`);
  const base = cmp.status === 200 && cmp.data && cmp.data.merge_base_commit && cmp.data.merge_base_commit.sha;
  if (!SHA_RE.test(String(base))) throw new Error(`#${n}: no merge base (HTTP ${cmp.status})`);
  return { n, pull, author, paths, records, failures: C.parseFailures(comments), committers, base };
}

async function rawAt(api, repo, sha, p) {
  const res = await api.getRaw(`/repos/${repo}/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`);
  if (res.status !== 200 || typeof res.text !== 'string') throw new Error(`${p} at ${sha.slice(0, 7)}: HTTP ${res.status}`);
  return res.text;
}

function roleReader(api, repo) {
  const memo = new Map();
  return async (login) => {
    if (!memo.has(login)) {
      const res = await api.get(`/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`);
      memo.set(login, res.status === 200 && res.data && typeof res.data.role_name === 'string' ? res.data.role_name : 'none');
    }
    return memo.get(login);
  };
}

async function trustFor(prop, roleOf, projects) {
  const roles = new Map();
  for (const r of prop.records) if (!roles.has(r.login)) roles.set(r.login, await roleOf(r.login));
  return (p) => (login) => !prop.committers.has(login)
    && C.mayApproveEdit({ login, permission: roles.get(login), path: p, projects, author: prop.author });
}

const FAIL_WORDS = {
  conflict: 'this part changed on the site since it was proposed',
  'anchor-gone': 'the block it follows was removed from the site since',
  ambiguous: 'two edits here are identical; approve the whole proposal on GitHub',
  unsplittable: 'the page cannot be read block by block',
};

/* The sweep. o: {api, repo, fs: {read(p) -> text|null, write(p, text)}, gate() -> {ok, finding},
   dryRun, pr, log}. -> {groups: [{pr, path, applied, approvers, author: {login, id}}], failed}. */
export async function sweep(o) {
  const { api, repo, gate } = o;
  const files = o.fs;
  const log = o.log || (() => {});
  const projects = JSON.parse((await files.read('data/projects.json')) || 'null');
  const roleOf = roleReader(api, repo);
  const pulls = (await allPages(api, `/repos/${repo}/pulls?state=open`))
    .filter((p) => isProposal(p, repo, o) && (!o.pr || p.number === o.pr))
    .sort((a, b) => a.number - b.number);
  const work = [];
  for (const pull of pulls) {
    const prop = await readProposal(api, repo, pull, files);
    if (!prop) continue;
    const trust = await trustFor(prop, roleOf, projects);
    for (const p of prop.paths.slice().sort()) {
      const d = C.decisions(prop.records, trust(p));
      const keys = [...d].filter(([k, v]) => v.kind === 'approved'
        && !(prop.failures.get(k) || []).some((f) => f.sha === pull.head.sha)).map(([k]) => k);
      if (!keys.length) continue;
      work.push({ prop, path: p, keys, d,
        baseText: await rawAt(api, repo, prop.base, p), headText: await rawAt(api, repo, pull.head.sha, p) });
    }
  }
  if (!work.length) { log('go-live: nothing approved is waiting'); return { groups: [], failed: [] }; }
  const first = await gate();
  if (!first.ok) throw new Error(`main is red before go-live (nothing applied): ${first.finding}`);
  const memo = new Map();                                  // dry-run: texts as they would be
  const readNow = async (p) => (memo.has(p) ? memo.get(p) : files.read(p));
  const groups = [];
  const failed = [];
  for (const w of work) {
    const sha = w.prop.pull.head.sha;
    const before = await readNow(w.path);
    const r = await C.applyEdits(w.path, w.baseText, w.headText, before, w.keys);
    for (const x of r.refused) {
      if (x.reason !== 'stale') failed.push({ pr: w.prop.n, key: x.key, sha, reason: FAIL_WORDS[x.reason] || x.reason });
    }
    if (!r.applied.length) continue;
    const group = { pr: w.prop.n, path: w.path, applied: r.applied,
      approvers: [...new Set(r.applied.map((k) => w.d.get(k).login))],
      author: { login: w.prop.pull.user.login, id: w.prop.pull.user.id } };
    if (o.dryRun) { memo.set(w.path, r.text); groups.push(group); log(`would apply ${r.applied.length} edit(s) of #${group.pr} to ${w.path}`); continue; }
    await files.write(w.path, r.text);
    const g = await gate();
    if (g.ok) { groups.push(group); log(`applied ${r.applied.length} edit(s) of #${group.pr} to ${w.path}`); continue; }
    await files.write(w.path, before);
    for (const key of r.applied) failed.push({ pr: w.prop.n, key, sha, reason: `site rules: ${g.finding}` });
    log(`#${group.pr} ${w.path}: the site check failed, put back`);
  }
  for (const f of failed) {
    const body = C.failureBody(f.key, f.sha, f.reason);
    if (o.dryRun) { log(`would comment on #${f.pr}: ${body}`); continue; }
    const res = await api.post(`/repos/${repo}/issues/${f.pr}/comments`, { body });
    if (res.status !== 201) log(`#${f.pr}: the failure record was not written (HTTP ${res.status})`);
  }
  return { groups, failed };
}

/* Close every proposal that has a trusted record and nothing left open (each edit live on main, or
   declined by its latest trusted record; conflict, anchor-gone and ambiguous count as open). */
export async function closeDone(o) {
  const { api, repo } = o;
  const files = o.fs;
  const projects = JSON.parse((await files.read('data/projects.json')) || 'null');
  const roleOf = roleReader(api, repo);
  const closed = [];
  const pulls = (await allPages(api, `/repos/${repo}/pulls?state=open`)).filter((p) => isProposal(p, repo, {}));
  for (const pull of pulls) {
    const prop = await readProposal(api, repo, pull, files);
    if (!prop) continue;
    const trust = await trustFor(prop, roleOf, projects);
    let trustedAny = false;
    let open = false;
    for (const p of prop.paths) {
      const d = C.decisions(prop.records, trust(p));
      if (d.size) trustedAny = true;
      const edits = await C.proposalEdits(p, await rawAt(api, repo, prop.base, p),
        await rawAt(api, repo, pull.head.sha, p), await files.read(p));
      if (!edits || edits.some((e) => e.state !== 'live' && !(d.get(e.key) && d.get(e.key).kind === 'declined'))) open = true;
    }
    if (!trustedAny || open) continue;
    await api.post(`/repos/${repo}/issues/${prop.n}/comments`, { body: 'Everything here is live (or declined).' });
    await api.patch(`/repos/${repo}/pulls/${prop.n}`, { state: 'closed' });
    closed.push(prop.n);
  }
  return closed;
}

/* One commit per kept group, in order, then the derived data. */
export function commitPlan(groups) {
  return groups.map((g) => {
    const n = g.applied.length;
    return {
      author_name: g.author.login,
      author_email: `${g.author.id}+${g.author.login}@users.noreply.github.com`,
      files: [g.path],
      message: `go-live: ${g.path} (${n} change${n === 1 ? '' : 's'} from #${g.pr}, approved by ${g.approvers.join(', ')})`,
    };
  });
}

/* Only the plan's pages and the derived folders may be in the commit (the App bypasses review). */
export function strayPaths(changed, plan) {
  const allowed = new Set(plan.flatMap((c) => c.files));
  return changed.filter((p) => !allowed.has(p) && !p.startsWith('search/') && !p.startsWith('data/graph/'));
}

// ------------------------------------------------------------------ CLI ---

function realApi(token) {
  const headers = (accept) => ({ Accept: accept, Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'hippocampus-docs-go-live' });
  const call = async (method, p, body, accept) => {
    const res = await fetch(`https://api.github.com${p}`, { method, headers: { ...headers(accept || 'application/vnd.github+json'),
      ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return res;
  };
  const json = async (res) => { try { return await res.json(); } catch (e) { return null; } };
  return {
    async get(p) { const r = await call('GET', p); return { status: r.status, data: await json(r) }; },
    async getRaw(p) { const r = await call('GET', p, null, 'application/vnd.github.raw+json'); return { status: r.status, text: await r.text() }; },
    async post(p, b) { const r = await call('POST', p, b); return { status: r.status, data: await json(r) }; },
    async patch(p, b) { const r = await call('PATCH', p, b); return { status: r.status, data: await json(r) }; },
  };
}

const treeFs = {
  read: async (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (e) { return null; } },
  write: async (p, t) => { fs.writeFileSync(path.join(ROOT, p), t, 'utf8'); },
};

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function realGate() {
  const d = run('python3', ['tools/derive.py']);
  if (!d.ok) return { ok: false, finding: `derive failed: ${d.out.trim().split('\n').pop()}` };
  const c = run('python3', ['tools/check.py']);
  if (c.ok) return { ok: true, finding: '' };
  const line = c.out.split('\n').find((l) => l.includes('✗')) || c.out.trim().split('\n')[0] || 'check.py failed';
  return { ok: false, finding: line.replace(/^\s*✗\s*/, '').trim() };
}

function git(args) {
  const r = run('git', args);
  if (!r.ok) throw new Error(`git ${args[0]} failed: ${r.out.trim().slice(0, 300)}`);
  return r.out;
}

async function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const repo = process.env.GITHUB_REPOSITORY || 'desert-mango/hippocampus-docs';
  if (argv.includes('--commit')) {
    const plan = JSON.parse(fs.readFileSync(arg('--commit'), 'utf8'));
    const changed = git(['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean).map((l) => l.slice(3));
    const stray = strayPaths(changed, plan);
    if (stray.length) throw new Error(`refusing to commit files outside the plan: ${stray.slice(0, 5).join(', ')}`);
    for (const c of plan) {
      git(['add', '--', ...c.files]);
      git(['commit', '-q', '--author', `${c.author_name} <${c.author_email}>`, '-m', c.message]);
    }
    git(['add', '-A', '--', 'search', 'data/graph']);
    if (!run('git', ['diff', '--cached', '--quiet']).ok) git(['commit', '-q', '-m', 'derive: regenerate derived data after go-live']);
    console.log(`go-live: ${plan.length} commit(s) made`);
    return 0;
  }
  const token = process.env.GH_TOKEN;
  if (!token) { console.error('go_live: GH_TOKEN is needed'); return 2; }
  const api = realApi(token);
  if (argv.includes('--close-done')) {
    const closed = await closeDone({ api, repo, fs: treeFs });
    console.log(`go-live: closed ${closed.length ? closed.map((n) => `#${n}`).join(', ') : 'nothing'}`);
    return 0;
  }
  const pr = arg('--pr') ? Number(arg('--pr')) : null;
  const out = await sweep({ api, repo, fs: treeFs, gate: realGate, dryRun: argv.includes('--dry-run'), pr, log: (s) => console.log(s) });
  if (out.groups.length && !argv.includes('--dry-run')) {
    const final = realGate();                              // derived data for exactly the kept tree
    if (!final.ok) throw new Error(`the kept set no longer passes: ${final.finding}`);
  }
  const planFile = arg('--plan');
  if (planFile) fs.writeFileSync(planFile, JSON.stringify(commitPlan(out.groups), null, 2));
  console.log(`go-live: ${out.groups.length} group(s) ready, ${out.failed.length} failure record(s)`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; },
    (e) => { console.error(`go_live: ${e.message}`); process.exitCode = 1; });
}
