// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 21 September 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Rank indexed documentation results and coordinate optional librarian answers.
/* Static in-browser search over the precomputed index in search/.
   No server, no keys: shards are plain JSON fetched once on first query.
   Scoring is deliberately simple and inspectable — exact symbol/name matches
   dominate, then prefixes, then substrings, then path/heading/body hits.
   Deep links: site hits -> hash routes (with @heading anchors when the heading
   is the better match); code/CAD/fork hits -> GitHub blob URLs (+#L<line>).

   On top of that sits an OPTIONAL semantic search — "the librarian", a
   serverless agent that walks this site's own knowledge graphs (api/librarian).
   The local engine always runs first and its ordering is a protected regression
   surface (tools/tests/test_search_routing.mjs locks the ten keyword probes at
   rank 1). The contract with the librarian is:

     - every multi-word query asks it, INCLUDING one the keyword engine found
       nothing for — that zero-hit case is the whole point of the walk — and it
       may answer with rows this index never had (a repository, a page, a code
       symbol), which render ahead of the local tail;
     - it may re-rank the local hits it was given, but it may NOT take position
       1 away from a local leader whose title token-covers the query (the
       STRONG-LEAD PIN, generalising the older exact-title pin). That rule is
       deliberately wide and has known false positives — "mavlink router" pins
       the launch helper `add_mavlink_routerd` above the PX4 Setup page — which
       is the recorded cost of a deterministic rendered rank 1 for the probes;
     - every failure mode — no function on this host, an unreachable one, an
       exhausted free quota, a malformed or unsafe answer — degrades to exactly
       the local answer, byte-identical, with at most a one-line notice.

   The site is dual-hosted: GitHub Pages (a subpath, no functions) and Vercel
   (the root, api/* runs). The one rule that keeps both working is that the
   fetch URL below stays RELATIVE. On Pages a POST to it returns 405, which this
   file reads as "no function on this host" and latches off for the session.

   Every read (the manifest, the shards) and the librarian POST go through the
   content-source seam in js/source.js when it is on the page: same-origin
   fetch on the live site; inside a CMS preview frame the files come over the
   preview bridge and the librarian answers 405, which latches it off exactly
   as on Pages. Without the seam (plain node, the tests) it is plain fetch.

   The pure helpers are exported for tools/tests/test_search_routing.mjs; the
   file loads cleanly under plain node with no window, no document, and issues
   no fetch at import time. */
(function () {
  'use strict';

  let loaded = null;   // Promise once loading starts
  const items = [];    // unified searchable entries

  function slugify(text) {
    return (text.toLowerCase().replace(/[^\w\s-]/g, '').trim()
      .replace(/[\s_]+/g, '-').replace(/^-+|-+$/g, '')) || 'section';
  }
  function tokens(s) {
    return String(s)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  }
  function ghUrl(repo, branch, path, line) {
    const p = path.split('/').map(encodeURIComponent).join('/');
    return `https://github.com/${repo}/blob/${branch}/${p}` + (line ? `#L${line}` : '');
  }

  function addItem(into, it) {
    it.ltitle = it.title.toLowerCase();
    it.ttoks = tokens(it.title);
    it.haystack = [it.path || '', (it.headings || []).join(' '), it.extra || '', it.body || '']
      .join(' ').toLowerCase();
    into.push(it);
  }

  /* Pure: shard documents in, searchable entries out. Split out of loadAll() so
     tests and tools/bench_librarian.mjs can build the very same items from disk
     instead of over the network. */
  function buildItems(shards) {
    const out = [];
    for (const shard of shards) {
      if (shard.kind === 'site') {
        for (const e of shard.entries) {
          addItem(out, { kind: 'page', title: e.t, where: e.w, href: e.r, route: e.r,
                         headings: e.h, body: e.x, extra: e.extra || '', snippet: e.x });
        }
      } else if (shard.kind === 'cad') {
        for (const [stem, path, ext] of shard.parts) {
          addItem(out, { kind: 'cad', title: stem, where: `CAD (.${ext})`, path,
                         href: ghUrl(shard.repo, shard.branch, path),
                         snippet: path });
        }
      } else if (shard.kind === 'code') {
        const short = shard.repo.split('/')[1];
        for (const [label, path, line, kind] of shard.symbols) {
          addItem(out, { kind, title: label, where: short, path,
                         href: ghUrl(shard.repo, shard.branch, path, kind === 'file' ? 0 : line),
                         snippet: path + (line && kind !== 'file' ? `:L${line}` : '') });
        }
      } else if (shard.kind === 'forks') {
        for (const [repo, path, branch] of shard.files) {
          addItem(out, { kind: 'fork', title: path, where: repo, path: `${repo}/${path}`,
                         href: ghUrl(`${shard.org}/${repo}`, branch, path),
                         snippet: `${repo}/${path}` });
        }
      }
    }
    return out;
  }

  // js/source.js's HC when the page has it; plain fetch otherwise (node).
  function seam() {
    return (typeof window !== 'undefined' && window.HC) ? window.HC : null;
  }
  function getJSON(path) {
    const hc = seam();
    if (hc) return hc.fetchJSON(path);
    return fetch(path).then((r) => {
      if (!r.ok) {
        const err = new Error(`${path}: HTTP ${r.status}`);
        err.status = r.status;
        throw err;
      }
      return r.json();
    });
  }

  async function loadAll() {
    const manifest = await getJSON('search/manifest.json').catch((err) => {
      if (err && err.status) throw new Error('search index missing — run tools/build_search_index.py');
      throw err;
    });
    const shards = await Promise.all(manifest.shards.map((s) => getJSON(s.file)));
    for (const it of buildItems(shards)) items.push(it);
    return items.length;
  }

  const KIND_BOOST = { page: 8, class: 8, cad: 4, fn: 2, file: 0, fork: -5 };

  function scoreItem(it, terms) {
    let score = 0;
    let matched = 0;
    for (const t of terms) {
      let s = 0;
      if (it.ltitle === t) s = 120;
      else if (it.ttoks.includes(t)) s = 50;
      else if (it.ltitle.startsWith(t)) s = 34;
      else if (it.ttoks.some((k) => k.startsWith(t))) s = 26;
      else if (it.ltitle.includes(t)) s = 18;
      if (it.haystack.includes(t)) s += s ? 6 : 10;
      if (s) matched += 1;
      score += s;
    }
    if (matched < terms.length) return 0;          // AND semantics
    const joined = terms.join(' ');
    if (it.ltitle === joined) score += 80;         // exact multi-word title
    else if (it.ltitle.includes(joined)) score += 25;
    return score + (KIND_BOOST[it.kind] || 0);
  }

  function bestHeadingAnchor(it, terms) {
    if (it.kind !== 'page' || !it.headings) return it.href;
    const titleHit = terms.some((t) => it.ltitle.includes(t) || it.ttoks.some((k) => k.startsWith(t)));
    if (titleHit) return it.href;
    for (const h of it.headings) {
      const hl = h.toLowerCase();
      if (terms.every((t) => hl.includes(t))) return `${it.route}@${slugify(h)}`;
    }
    return it.href;
  }

  /* The local engine, unchanged and pure: entries + query in, ranked hits out.
     Anything that alters this function alters the probe record — don't. */
  function searchItems(list, q) {
    const terms = tokens(q).slice(0, 8);
    if (!terms.length) return { total: list.length, results: [] };
    const scored = [];
    for (const it of list) {
      const s = scoreItem(it, terms);
      if (s > 0) scored.push([s, it]);
    }
    scored.sort((a, b) => b[0] - a[0] || a[1].title.localeCompare(b[1].title));
    return {
      total: list.length,
      results: scored.slice(0, 40).map(([s, it]) => ({
        score: s, kind: it.kind, title: it.title, where: it.where,
        href: bestHeadingAnchor(it, terms), snippet: it.snippet || '',
      })),
    };
  }

  // ====================================================================
  //  the librarian: an optional semantic re-rank of the local head
  // ====================================================================

  // RELATIVE on purpose. GitHub Pages serves this site from a subpath, so a
  // leading slash would post to the wrong origin path there; Vercel serves it
  // from the root, where the relative form resolves identically.
  const LIBRARIAN_URL = 'api/librarian';
  // 18s here against maxDuration: 15 on the function (vercel.json). The pair is
  // deliberate: the client must outlive the server's own ceiling so a function
  // that times out answers with its own error rather than being cut off blind.
  const LIBRARIAN_TIMEOUT_MS = 18000;
  const CANDIDATE_LIMIT = 25;   // how many local hits the librarian gets to see
  const PICK_LIMIT = 8;         // how many of them it may promote
  const LIBRARIAN_NOTICE = 'Answered by the local index — the librarian is unreachable.';
  // A spent free quota is not an outage, and telling the user it is invites a
  // re-try into a wall. The function says so explicitly (502 + exhausted).
  const LIBRARIAN_QUOTA_NOTICE =
    'The librarian is out of free requests for today — answered by the local index.';
  const CACHE_LIMIT = 50;       // answers remembered per session

  /* A row the local index never built can only be rendered if its link is one
     of the two shapes this site ever produces: an in-app hash route, or a
     github.com URL. Anything else — javascript:, data:, another origin — is a
     schema failure for the WHOLE answer, not a row to quietly skip. */
  function allowedHref(href) {
    return typeof href === 'string'
      && (/^#\//.test(href) || /^https:\/\/github\.com\//.test(href));
  }

  const str = (v) => (typeof v === 'string' ? v : '');

  /* Candidate ids. The scheme is `<kind>:<href>` — the route for a page, the
     GitHub blob URL (with its #L anchor) for code, CAD and fork rows — with a
     `~2`, `~3`… suffix appended on the rare collision, so ids are unique within
     a batch by construction. They are derived from the result and stable for a
     given result list; they only need to round-trip client -> server -> client
     inside one request, which is why nothing here is persisted or versioned. */
  function assignIds(results) {
    const used = new Set();
    return results.map((r) => {
      const base = `${r.kind}:${r.href}`;
      let id = base;
      let n = 2;
      while (used.has(id)) { id = `${base}~${n}`; n += 1; }
      used.add(id);
      return id;
    });
  }

  /* The payload the function sees: the top CANDIDATE_LIMIT local hits with the
     scoring internals stripped. Deliberately NOT filtered by kind — code and CAD
     rows are exactly the ones a semantic re-rank helps most. */
  function projectCandidates(results, limit) {
    const cap = typeof limit === 'number' ? limit : CANDIDATE_LIMIT;
    const ids = assignIds(results);
    return results.slice(0, cap).map((r, i) => ({
      id: ids[i], title: r.title, kind: r.kind, where: r.where, snippet: r.snippet || '',
    }));
  }

  /* 404/405/501 all mean the same thing: this host has no such function.
     GitHub Pages answers a POST to a missing path with 405. */
  function classifyStatus(status) {
    if (status === 404 || status === 405 || status === 501) return 'absent';
    if (typeof status === 'number' && status >= 200 && status < 300) return 'ok';
    return 'failed';
  }

  /* Strict schema read of {"results":[{id, why[, kind, title, where, href,
     snippet]}]}. A row that names a candidate id is just {id, why} — the
     client already owns that row. A row that brings its own href is a row this
     index never had, so it must bring everything needed to RENDER it and a
     link this site could have produced itself. Anything else is a failure, not
     an empty answer. */
  function pickRows(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    if (!Array.isArray(payload.results)) return null;
    const rows = [];
    for (const row of payload.results) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
      if (typeof row.id !== 'string' || !row.id) return null;
      const out = { id: row.id, why: str(row.why) };
      if (row.href !== undefined) {
        if (!allowedHref(row.href)) return null;
        if (typeof row.kind !== 'string' || !row.kind) return null;
        if (typeof row.title !== 'string' || !row.title) return null;
        out.href = row.href;
        out.kind = row.kind;
        out.title = row.title;
        out.where = str(row.where);
        out.snippet = str(row.snippet);
      }
      rows.push(out);
    }
    return rows;
  }

  /* The same read, ids only — kept because tools and tests speak in ids. */
  function pickIds(payload) {
    const rows = pickRows(payload);
    return rows ? rows.map((r) => r.id) : null;
  }

  /* A page hit whose best match was a HEADING carries an @anchor in its href,
     and therefore in its id; the server answers with the page's own route. The
     two must still be the same row, so id matching compares anchor-stripped. */
  function bareId(id) {
    const m = /^(page:#\/[^@]*)@/.exec(id);
    return m ? m[1] : id;
  }

  /* The strong-lead test: every query term is a token, or a token PREFIX, of
     the local leader's title — using the engine's own tokens(), so the rule is
     the engine's own idea of a word. Wide on purpose, and wide in fact: see the
     "mavlink router" counterexample recorded in the routing test. */
  function strongLead(localResults, q) {
    if (!Array.isArray(localResults) || !localResults.length) return false;
    const terms = tokens(q == null ? '' : q).slice(0, 8);
    if (!terms.length) return false;
    const lead = localResults[0];
    const title = tokens(lead && lead.title != null ? lead.title : '');
    if (!title.length) return false;
    return terms.every((t) => title.some((k) => k === t || k.startsWith(t)));
  }

  /* Fold the librarian's picks into the local list: picks first (deduped,
     capped at PICK_LIMIT), then every remaining local hit in its original local
     order. `rows` may be plain id strings or full rows. A row whose id is a
     local one renders the LOCAL row (a shallow copy carrying the `why`, so the
     local list's own objects are never touched); a row the local index never
     had renders from the server's fields once its href passes the allowlist; a
     row that is neither is dropped.

     Then the PIN, which runs ONLY when the librarian actually answered — with
     no answer the order stays byte-identical to what the local engine produced.
     The pinned row is the exact-title match if there is one, else the local
     leader when it token-covers the query (strongLead). librarianCount counts
     EVERY pick, local-matched or server-built, so the divider in js/app.js
     falls after the picks and the pin fires on any answer at all. */
  function mergePicks(localResults, rows, q) {
    const local = Array.isArray(localResults) ? localResults : [];
    const rowIds = assignIds(local);
    const byId = new Map();
    rowIds.forEach((id, i) => {
      if (!byId.has(id)) byId.set(id, i);
      const bare = bareId(id);
      if (!byId.has(bare)) byId.set(bare, i);
    });

    const picks = [];          // { index?, row } — index is set for local rows
    const taken = new Set();
    for (const raw of (Array.isArray(rows) ? rows : [])) {
      const row = typeof raw === 'string' ? { id: raw } : raw;
      if (!row || typeof row !== 'object') continue;
      const id = typeof row.id === 'string' ? row.id : '';
      if (!id) continue;
      const at = byId.has(id) ? byId.get(id) : byId.get(bareId(id));
      if (at !== undefined) {
        if (taken.has(at)) continue;
        taken.add(at);
        const why = str(row.why);
        picks.push({ index: at, row: why ? Object.assign({}, local[at], { why }) : local[at] });
      } else if (allowedHref(row.href)) {
        picks.push({ row: {
          score: 0, kind: str(row.kind), title: str(row.title), where: str(row.where),
          href: row.href, snippet: str(row.snippet), why: str(row.why),
        } });
      }
      if (picks.length >= PICK_LIMIT) break;
    }
    let librarianCount = picks.length;

    if (librarianCount > 0) {
      const want = String(q == null ? '' : q).trim().toLowerCase();
      let pin = -1;
      if (want) {
        pin = local.findIndex(
          (r) => String(r.title == null ? '' : r.title).trim().toLowerCase() === want);
      }
      if (pin < 0 && strongLead(local, q)) pin = 0;
      if (pin >= 0) {
        const at = picks.findIndex((p) => p.index === pin);
        if (at > 0) {
          picks.unshift(picks.splice(at, 1)[0]);
        } else if (at < 0 && picks.length >= PICK_LIMIT) {
          // Already at the cap: the pin takes the top slot and the LOWEST
          // ranked pick gives up its own, so there are never more than
          // PICK_LIMIT rows above the divider. A displaced LOCAL pick is not
          // thrown away — dropping it from `taken` puts it straight back into
          // the local tail below, in its original local position; a displaced
          // server row has no local position to fall back to and simply goes.
          const displaced = picks.pop();
          if (displaced.index !== undefined) taken.delete(displaced.index);
          picks.unshift({ index: pin, row: local[pin] });
          taken.add(pin);
        } else if (at < 0) {
          picks.unshift({ index: pin, row: local[pin] });
          taken.add(pin);
          librarianCount += 1;   // the divider still falls after the picks
        }
      }
    }

    const rest = local.filter((_, i) => !taken.has(i));
    return { results: picks.map((p) => p.row).concat(rest), librarianCount };
  }

  /* One librarian per session. The `absent` latch is in-memory and deliberately
     never reset: on a host without the function we spend exactly one wasted
     request per session and show the user nothing at all.

     The session also remembers ANSWERS, keyed on the trimmed lower-cased query:
     re-running or re-navigating to a search re-merges from memory with zero
     network. Only answers are cached — a failure is retried next time, so a
     blip never sticks to a query for the rest of the session. */
  function createLibrarian(opts) {
    const cfg = opts || {};
    const timeoutMs = cfg.timeoutMs || LIBRARIAN_TIMEOUT_MS;
    const doFetch = cfg.fetch || ((url, init) => {
      const hc = seam();
      return hc ? hc.callFunction(url, init) : fetch(url, init);
    });
    let absent = false;
    const answers = new Map();

    function remember(key, rows) {
      answers.delete(key);            // re-insert: Map keeps insertion order
      answers.set(key, rows);
      while (answers.size > CACHE_LIMIT) answers.delete(answers.keys().next().value);
    }

    async function enrich(q, local) {
      const results = (local && local.results) || [];
      const plain = { results, librarianCount: 0, notice: null };
      const failed = { results, librarianCount: 0, notice: LIBRARIAN_NOTICE };

      const trimmed = String(q == null ? '' : q).trim();
      const answered = (rows) => {
        const merged = mergePicks(results, rows, trimmed);
        return { results: merged.results, librarianCount: merged.librarianCount, notice: null };
      };

      if (!/\s/.test(trimmed)) return plain;   // single word: zero network, always
      if (absent) return plain;
      // An empty local list is NOT a reason to stay quiet: a multi-word query
      // the keyword engine cannot answer is exactly what the walk is for.
      const key = trimmed.toLowerCase();
      if (answers.has(key)) return answered(answers.get(key));

      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      try {
        let res;
        try {
          res = await doFetch(LIBRARIAN_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ q: trimmed, candidates: projectCandidates(results) }),
            signal: ctrl ? ctrl.signal : undefined,
          });
        } catch (e) {
          return failed;                       // network error, abort, timeout
        }
        const verdict = classifyStatus(res && res.status);
        if (verdict === 'absent') { absent = true; return plain; }
        if (verdict !== 'ok') {
          // One body read decides WHICH truth the notice tells. A spent free
          // quota is not an unreachable librarian, and saying so keeps the
          // reader from re-trying into a wall.
          let body = null;
          try { body = await res.json(); } catch (e) { body = null; }
          const spent = Boolean(body && typeof body === 'object' && body.exhausted === true);
          return {
            results, librarianCount: 0,
            notice: spent ? LIBRARIAN_QUOTA_NOTICE : LIBRARIAN_NOTICE,
          };
        }

        let payload;
        try {
          payload = await res.json();
        } catch (e) {
          return failed;                       // malformed body
        }
        const rows = pickRows(payload);
        if (!rows) return failed;              // schema-invalid body
        remember(key, rows);
        return answered(rows);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    return { enrich, isLatched: () => absent };
  }

  const librarian = createLibrarian();

  /* query(q) resolves the final merged shape {total, results, librarianCount,
     notice} — that contract is unchanged.

     query(q, {onLocal}) additionally hands the LOCAL ranking to onLocal the
     instant it exists, before any network call, so the page can paint at once
     instead of sitting on "Searching…" for as long as the librarian takes. The
     hook gets the local ordering byte-identical to what the engine produced,
     with librarianCount 0, notice null and the exact-title pin NOT applied —
     the pin is only ever correct once the librarian has actually answered.
     onLocal is called at most once. A multi-word query with NO local hits is
     still asked — onLocal paints the empty local answer, js/app.js shows the
     waiting line, and the final resolve carries whatever the walk found. */
  async function query(q, opts) {
    const options = opts || {};
    if (!loaded) loaded = loadAll();
    await loaded;
    const local = searchItems(items, q);
    const localShape = {
      total: local.total, results: local.results, librarianCount: 0, notice: null,
    };
    if (typeof options.onLocal === 'function') {
      // A renderer that throws is the renderer's problem, never the search's.
      try { options.onLocal(localShape); } catch (e) { /* keep going */ }
    }
    const enriched = await librarian.enrich(q, local);
    return {
      total: local.total,
      results: enriched.results,
      librarianCount: enriched.librarianCount,
      notice: enriched.notice,
    };
  }

  const API = {
    query,
    // pure helpers (exported for tools/tests/test_search_routing.mjs and
    // tools/bench_librarian.mjs — neither of which may touch api/)
    buildItems,
    searchItems,
    createLibrarian,
    assignIds,
    projectCandidates,
    classifyStatus,
    pickIds,
    pickRows,
    mergePicks,
    strongLead,
    librarianLatched: () => librarian.isLatched(),
    LIBRARIAN_URL,
    LIBRARIAN_NOTICE,
    LIBRARIAN_QUOTA_NOTICE,
    LIBRARIAN_TIMEOUT_MS,
    CANDIDATE_LIMIT,
    PICK_LIMIT,
  };

  if (typeof window !== 'undefined') window.HCSearch = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
}());
