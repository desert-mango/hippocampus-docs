// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 1 October 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: One fake GitHub route table over the U0 fixtures, for the node tests and the localhost Editor walk.
/* The fake GitHub (plan D-C). ONE route table, used by
   tools/tests/test_editor.mjs (node, vm harness) and by the localhost walk
   page tools/tests/editor_walk.html (browser), so the vm tests and the walk
   run on the same fake. It answers from the scrubbed U0 fixtures in
   tools/tests/fixtures/github-data/ (index.json maps method + path + query to
   a body file) and never reaches the network.

     createFakeGitHub({readFixture, readFile, variant, onWrite})
       readFixture(name) -> Promise<string|null>   a fixture file's text
       readFile(path)    -> Promise<string|null>   a working-tree file's text
                                                   (main's content)
       variant           'push' (default, Write) | 'readonly' | 'maintain' | 'admin'
                         (maintain / admin: repo-push.json with those
                         permissions set, in memory; the fixture is unchanged)
       onWrite(method, url, body) -> {status, body}   optional; else 405
       extra             optional more open proposals, for the overlay
                         tests and walk steps (U7), all synthetic:
                           {pulls: [pull], files: {<n>: [file rows]},
                            contents: {<head sha>: {<path>: text}},
                            compare: {<head sha>: <merge base sha>},
                            checks: {<head sha>: check-runs payload},
                            updates: {<n>: <new head sha>}}
                         They join pulls?state=…, answer pulls/<n>,
                         pulls/<n>/files, contents at their head sha,
                         compare/<x>...<head> and commits/<head>/check-runs.
                         `updates`: PUT pulls/<n>/update-branch with the
                         current head as expected_head_sha moves PR n's head
                         to the new sha and answers 202 (GitHub's answer; the
                         real move is asynchronous, the fake's is at once);
                         another expected_head_sha answers 422.
     -> {fetch(url, init), calls, MAIN_SHA}

   Routes (GET, https://api.github.com):
     /user                                      user.json
     /repos/desert-mango/hippocampus-docs       repo-push.json | repo-readonly.json
     …/git/ref/heads/main                       MAIN_SHA, a FIXED fake sha distinct from
                                                the merge base: main has moved since
                                                PR #1's base, the real case
     …/git/ref/heads/<PR #1's branch>           PR #1's head sha
     …/contents/<path>?ref=MAIN_SHA             readFile(path)
     …/contents/<path>?ref=<PR #1 head | merge base>   the git_show files of
                                                index.json (others 404)
     …/pulls?state=open|closed|all              pulls-all.json, filtered (page > 1: [])
     …/pulls/1, …/pulls/1/files (page > 1: [])  the fixtures
     …/compare/<base>...<head>                  the compare fixture, when head is
                                                PR #1's head (any sha spelling)
     …/commits/<sha>/check-runs                 the fixture, for PR #1's head
     …/check-runs/<id>/annotations              the fixture, for its run id
     anything else                              an exact method + path + query
                                                lookup in index.json, else 404
   And this site's own /api/media (POST, api/media.js's shape): `list` answers
   the first 24 assets of the working tree's data/cloudinary-manifest.json
   (next_cursor null; width, height and created_at null), so the walk's
   Media tab has images; every other action is a write (onWrite, else 405).
   Every call is logged in `calls` ({method, url}); writes too. No token is
   read, kept or answered. */
(function () {
  'use strict';

  const API = 'https://api.github.com';
  const REPO = '/repos/desert-mango/hippocampus-docs';
  const MAIN_SHA = `c0ffee${'0'.repeat(34)}`;

  function answer(status, body) {
    const text = typeof body === 'string' ? body : JSON.stringify(body === undefined ? null : body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  }
  const notFound = () => answer(404, { message: 'Not Found' });

  function queryOf(u) {
    const out = {};
    u.searchParams.forEach((v, k) => { out[k] = v; });
    return out;
  }
  function sameQuery(a, b) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b || {}).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && String(a[k]) === String(b[k]));
  }

  const PERMISSIONS = Object.freeze({
    maintain: { admin: false, maintain: true, push: true, triage: true, pull: true },
    admin: { admin: true, maintain: true, push: true, triage: true, pull: true },
  });

  function createFakeGitHub(opts) {
    const o = opts || {};
    const x = o.extra && typeof o.extra === 'object' ? o.extra : {};
    const xPulls = Array.isArray(x.pulls) ? x.pulls.slice() : [];   // own copy: an update replaces a pull
    const own = (obj, k) => Boolean(obj) && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, k);
    const xHead = (sha) => (typeof sha === 'string' && sha.length >= 7
      ? xPulls.map((p) => p.head.sha).find((h) => h.indexOf(sha) === 0) || null : null);
    if (typeof o.readFixture !== 'function' || typeof o.readFile !== 'function') {
      throw new Error('createFakeGitHub: readFixture and readFile are needed');
    }
    const calls = [];
    let facts = null;

    async function json(name) {
      const t = await o.readFixture(name);
      return t === null || t === undefined ? null : JSON.parse(t);
    }
    // index.json, PR #1 and the compare fixture, read once
    function load() {
      if (!facts) {
        facts = Promise.all([json('index.json'), json('pull-1.json'), json('compare-75f09dd...d0bdc64.json')])
          .then(([index, pull, compare]) => ({
            index,
            head: pull.head.sha,
            branch: pull.head.ref,
            mergeBase: compare.merge_base_commit.sha,
          }));
      }
      return facts;
    }
    const isHead = (f, sha) => typeof sha === 'string' && sha.length >= 7 && f.head.indexOf(sha) === 0;

    async function fixture(name) {
      const t = await o.readFixture(name);
      return t === null || t === undefined ? notFound() : answer(200, t);
    }

    async function contents(f, p, ref) {
      if (own(x.contents, ref)) return own(x.contents[ref], p) ? answer(200, x.contents[ref][p]) : notFound();
      if (ref === MAIN_SHA) {
        const t = await o.readFile(p);
        return t === null || t === undefined ? notFound() : answer(200, t);
      }
      const rev = ref === f.mergeBase ? f.mergeBase.slice(0, 7) : (isHead(f, ref) && ref.length === 40 ? f.head.slice(0, 7) : null);
      if (!rev) return notFound();
      const hit = (f.index.git_show || []).find((g) => g.rev === rev && g.path === p
        && (rev !== f.mergeBase.slice(0, 7) || /merge-base/.test(g.file)));
      return hit ? fixture(hit.file) : notFound();
    }

    async function pulls(q) {
      if (Number(q.page || 1) > 1) return answer(200, []);
      const all = (await json('pulls-all.json') || []).concat(xPulls);
      const state = q.state || 'open';
      return answer(200, all.filter((p) => state === 'all' || p.state === state));
    }

    async function repoRoute(f, rest, q) {
      if (rest === '') {
        if (own(PERMISSIONS, o.variant)) {
          const repo = await json('repo-push.json');
          return answer(200, Object.assign({}, repo, { permissions: Object.assign({}, PERMISSIONS[o.variant]) }));
        }
        return fixture(o.variant === 'readonly' ? 'repo-readonly.json' : 'repo-push.json');
      }
      let n = /^\/pulls\/([0-9]+)(\/files)?$/.exec(rest);
      const xp = n ? xPulls.find((p) => String(p.number) === n[1]) : null;
      if (xp) {
        if (!n[2]) return answer(200, xp);
        return answer(200, Number(q.page || 1) > 1 ? [] : (x.files && x.files[n[1]]) || []);
      }
      n = /^\/compare\/([0-9a-f]{7,40})\.\.\.([0-9a-f]{7,40})$/.exec(rest);
      if (n && xHead(n[2]) && own(x.compare, xHead(n[2]))) {
        return answer(200, { status: 'ahead', merge_base_commit: { sha: x.compare[xHead(n[2])] } });
      }
      n = /^\/commits\/([0-9a-f]{7,40})\/check-runs$/.exec(rest);
      if (n && xHead(n[1])) {
        return own(x.checks, xHead(n[1])) ? answer(200, x.checks[xHead(n[1])]) : notFound();
      }
      let m = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
      if (m) {
        const ref = decodeURIComponent(m[1]);
        const sha = ref === 'main' ? MAIN_SHA : (ref === f.branch ? f.head : null);
        return sha ? answer(200, { ref: `refs/heads/${ref}`, object: { sha, type: 'commit' } }) : notFound();
      }
      m = /^\/contents\/(.+)$/.exec(rest);
      if (m) return contents(f, m[1].split('/').map(decodeURIComponent).join('/'), q.ref);
      if (rest === '/pulls') return pulls(q);
      if (rest === '/pulls/1') return fixture('pull-1.json');
      if (rest === '/pulls/1/files') return Number(q.page || 1) > 1 ? answer(200, []) : fixture('pull-1-files.json');
      m = /^\/compare\/([0-9a-f]{7,40})\.\.\.([0-9a-f]{7,40})$/.exec(rest);
      if (m) return isHead(f, m[2]) ? fixture('compare-75f09dd...d0bdc64.json') : notFound();
      m = /^\/commits\/([0-9a-f]{7,40})\/check-runs$/.exec(rest);
      if (m) return isHead(f, m[1]) ? fixture('check-runs-d0bdc64.json') : notFound();
      m = /^\/check-runs\/([0-9]+)\/annotations$/.exec(rest);
      if (m) {
        const hit = (f.index.requests || []).find((r) => r.path === `${REPO}${rest}`);
        return hit ? fixture(hit.body) : notFound();
      }
      return null;
    }

    // api/media.js's `list`, from the manifest: {assets: [...], next_cursor}
    async function mediaList() {
      const t = await o.readFile('data/cloudinary-manifest.json');
      let doc = null;
      try { doc = t ? JSON.parse(t) : null; } catch (e) { doc = null; }
      const all = doc && typeof doc === 'object' && doc.assets && typeof doc.assets === 'object' ? Object.values(doc.assets) : [];
      const assets = all.filter((a) => a && typeof a.public_id === 'string' && typeof a.url === 'string').slice(0, 24)
        .map((a) => ({ public_id: a.public_id, url: a.url, bytes: Number(a.bytes) || 0, width: null, height: null,
          format: (/\.([a-z0-9]+)$/i.exec(a.url) || [null, null])[1], created_at: null }));
      return answer(200, { assets, next_cursor: null });
    }
    // `updates`: Update from main on an extra proposal moves its head (a new pull object)
    function updateBranch(s, init) {
      const m = /^https:\/\/api\.github\.com\/repos\/desert-mango\/hippocampus-docs\/pulls\/([0-9]+)\/update-branch$/.exec(s);
      const i = m && own(x.updates, m[1]) ? xPulls.findIndex((p) => String(p.number) === m[1]) : -1;
      if (i < 0) return null;
      let body = null;
      try { body = JSON.parse((init && init.body) || 'null'); } catch (e) { body = null; }
      const p = xPulls[i];
      if (!body || body.expected_head_sha !== p.head.sha) {
        return answer(422, { message: 'expected head sha didn’t match current head ref.' });
      }
      xPulls[i] = Object.assign({}, p, { head: Object.assign({}, p.head, { sha: x.updates[m[1]] }) });
      return answer(202, { message: 'Updating pull request branch.' });
    }

    function mediaAction(init) {
      try { return JSON.parse((init && init.body) || 'null').action; } catch (e) { return null; }
    }

    async function fetchImpl(url, init) {
      const method = String((init && init.method) || 'GET').toUpperCase();
      const s = String(url);
      calls.push({ method, url: s });
      if (s === '/api/media' && method === 'POST' && mediaAction(init) === 'list') return mediaList();
      if (method === 'PUT') {
        const moved = updateBranch(s, init);
        if (moved) return moved;
      }
      if (method !== 'GET') {
        if (typeof o.onWrite === 'function') {
          let body;
          try { body = init && init.body ? JSON.parse(init.body) : undefined; } catch (e) { body = undefined; }
          const out = await o.onWrite(method, s, body);
          return answer(out.status, out.body);
        }
        return answer(405, { message: 'the fake GitHub takes no writes' });
      }
      if (s.indexOf(`${API}/`) !== 0) return notFound();
      const u = new URL(s);
      const p = u.pathname;
      const q = queryOf(u);
      const f = await load();
      if (p === '/user') return fixture('user.json');
      if (p === REPO || p.indexOf(`${REPO}/`) === 0) {
        const hit = await repoRoute(f, p.slice(REPO.length), q);
        if (hit) return hit;
      }
      const exact = (f.index.requests || []).find((r) => r.method === method && r.path === p && sameQuery(q, r.query));
      return exact ? fixture(exact.body) : notFound();
    }

    return Object.freeze({ fetch: fetchImpl, calls, MAIN_SHA });
  }

  const api = Object.freeze({ createFakeGitHub, MAIN_SHA });
  if (typeof window !== 'undefined') window.HCFakeGitHub = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}());
