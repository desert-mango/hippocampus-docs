// Author: Kyle Nelson
// Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
// Last substantive modification: 21 September 2026
// Affiliation: TUHH HippoCampus Robotics
// Purpose: Rank indexed documentation results and coordinate optional librarian answers.
/* Static in-browser search over the precomputed index in search/.
   No server, no keys: shards are plain JSON fetched once on first query.
   Scoring is deliberately simple and inspectable — exact symbol/name matches
   dominate, then prefixes, then substrings, then path/heading/body hits.
   A query is read as its WORDS minus English stopwords ("how do I flash PX4"
   searches flash + px4). Since S1 (2026-10-21) a row no longer has to match
   every word: rows that match ALL of them rank first, then rows that match
   fewer (each kept only when a word of 3+ letters hit), so a phrased question
   is never a dead end. The old AND semantics survive as the `full` flag on
   each row, and only the full rows are shown to the librarian as candidates.
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
  /* S1: the words a query is searched by. tokens() is unchanged (titles use it
     too); a query drops these English stopwords first. A query made of nothing
     else still searches all of its words — "how to" is a fair title. */
  const STOPWORDS = new Set(('a an and are as at be by can do for from how i in is it of on or '
    + 'that the this to what where which with you your does did').split(' '));
  const MAX_TERMS = 8;
  function queryTerms(q) {
    const all = tokens(q == null ? '' : q);
    const kept = all.filter((t) => !STOPWORDS.has(t));
    return (kept.length ? kept : all).slice(0, MAX_TERMS);
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

  /* -> {score, matched}; score 0 means "not a hit". S1: the rank key is
     score + matched * MATCH_WEIGHT, and searchItems sorts on `matched` first
     anyway, so every row matching ALL terms ranks above any row matching
     fewer, whatever the weights. A partial row is a hit only when at least one
     word of 3+ letters matched — a two-letter hit alone is noise. */
  const MATCH_WEIGHT = 1000;
  const RESULT_LIMIT = 40;   // rows of any kind
  const PAGE_TAIL = 20;      // extra page rows from below the cut (S3)
  function scoreItem(it, terms) {
    let score = 0;
    let matched = 0;
    let strong = false;
    for (const t of terms) {
      let s = 0;
      if (it.ltitle === t) s = 120;
      else if (it.ttoks.includes(t)) s = 50;
      else if (it.ltitle.startsWith(t)) s = 34;
      else if (it.ttoks.some((k) => k.startsWith(t))) s = 26;
      else if (it.ltitle.includes(t)) s = 18;
      if (it.haystack.includes(t)) s += s ? 6 : 10;
      if (s) {
        matched += 1;
        if (t.length >= 3) strong = true;
      }
      score += s;
    }
    if (!matched) return { score: 0, matched: 0 };
    if (matched < terms.length && !strong) return { score: 0, matched: 0 };
    if (matched === terms.length) {
      const joined = terms.join(' ');
      if (it.ltitle === joined) score += 80;         // exact multi-word title
      else if (it.ltitle.includes(joined)) score += 25;
    }
    return { score: score + (KIND_BOOST[it.kind] || 0) + matched * MATCH_WEIGHT, matched };
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

  /* The local engine, changed 2026-10-21 for S1, still pure: entries + query
     in, ranked hits out. Anything that alters this function alters the probe
     record — tools/tests/test_search_routing.mjs pins every keyword probe at
     rank 1. Each row carries `full`: true when it matched every query term
     (the old AND result, always a prefix of the list), false for a partial. */
  function searchItems(list, q) {
    const terms = queryTerms(q);
    if (!terms.length) return { total: list.length, results: [] };
    const scored = [];
    for (const it of list) {
      const s = scoreItem(it, terms);
      if (s.score > 0) scored.push([s, it]);
    }
    scored.sort((a, b) => b[0].matched - a[0].matched || b[0].score - a[0].score
      || a[1].title.localeCompare(b[1].title));
    // S3: the top RESULT_LIMIT rows, then up to PAGE_TAIL more PAGE rows from
    // below the cut — still in rank order, since every one of them ranks below
    // the 40th row. Without the tail the Pages tab was starved by code symbols
    // ("ros": 10 of 19 matching pages, "camera": 3 of 12).
    const head = scored.slice(0, RESULT_LIMIT);
    const tail = scored.slice(RESULT_LIMIT).filter(([, it]) => it.kind === 'page').slice(0, PAGE_TAIL);
    return {
      total: list.length,
      results: head.concat(tail).map(([s, it]) => ({
        score: s.score, kind: it.kind, title: it.title, where: it.where,
        href: bestHeadingAnchor(it, terms), snippet: it.snippet || '',
        full: s.matched === terms.length,
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
  // S2 (2026-10-21): calmer, and true for every failure it covers — a timeout
  // or a 502 is "did not answer this time", not "unreachable".
  const LIBRARIAN_NOTICE = 'Keyword results shown; the librarian did not answer this time.';
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

  /* S1: what the librarian is actually sent. Only the rows that match EVERY
     word are candidates — the old AND list, byte-identical, and always a prefix
     of `results`, so their ids are the ids the merge assigns. Partial rows are
     not the keyword index's answer (the hop-1 prompt promises the model that
     each candidate "matches every query word"), and an empty list still asks
     for the graph walk. A row with no `full` flag counts as full. */
  function librarianCandidates(results, limit) {
    const rows = Array.isArray(results) ? results : [];
    return projectCandidates(rows.filter((r) => r && r.full !== false), limit);
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
    const terms = queryTerms(q);
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
    const inflight = new Map();     // key -> promise of one request's outcome (review S-1)

    function remember(key, rows) {
      answers.delete(key);            // re-insert: Map keeps insertion order
      answers.set(key, rows);
      while (answers.size > CACHE_LIMIT) answers.delete(answers.keys().next().value);
    }

    async function enrich(q, local) {
      const results = (local && local.results) || [];
      const plain = { results, librarianCount: 0, notice: null };

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

      // review S-1: one request per query while it is in flight. A second
      // enrich for the same key (a tab click during the wait) awaits the
      // first one's outcome instead of POSTing again; the entry goes in
      // finally, so a failure is still retried next time.
      let pending = inflight.get(key);
      if (!pending) {
        pending = ask(trimmed, results).finally(() => { inflight.delete(key); });
        inflight.set(key, pending);
      }
      const out = await pending;
      if (out.rows) return answered(out.rows);
      if (out.plain) return plain;
      return { results, librarianCount: 0, notice: out.notice };
    }

    /* One librarian request. Its outcome is independent of the caller's
       result list, so concurrent callers can share it: { rows } for an
       answer, { plain: true } once the librarian is absent, else { notice }. */
    async function ask(trimmed, results) {
      const key = trimmed.toLowerCase();
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      try {
        let res;
        try {
          res = await doFetch(LIBRARIAN_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ q: trimmed, candidates: librarianCandidates(results) }),
            signal: ctrl ? ctrl.signal : undefined,
          });
        } catch (e) {
          return { notice: LIBRARIAN_NOTICE };     // network error, abort, timeout
        }
        const verdict = classifyStatus(res && res.status);
        if (verdict === 'absent') { absent = true; return { plain: true }; }
        if (verdict !== 'ok') {
          // One body read decides WHICH truth the notice tells. A spent free
          // quota is not an unreachable librarian, and saying so keeps the
          // reader from re-trying into a wall.
          let body = null;
          try { body = await res.json(); } catch (e) { body = null; }
          const spent = Boolean(body && typeof body === 'object' && body.exhausted === true);
          return { notice: spent ? LIBRARIAN_QUOTA_NOTICE : LIBRARIAN_NOTICE };
        }

        let payload;
        try {
          payload = await res.json();
        } catch (e) {
          return { notice: LIBRARIAN_NOTICE };     // malformed body
        }
        const rows = pickRows(payload);
        if (!rows) return { notice: LIBRARIAN_NOTICE };   // schema-invalid body
        remember(key, rows);
        return { rows };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    return { enrich, isLatched: () => absent };
  }

  const librarian = createLibrarian();

  /* ---------- the home hero (direction A: search is the front door) ----------

     The homepage's big search field runs the very same query() below, so these
     helpers are only about PRESENTING its answer in a panel that is six rows
     tall instead of a whole page. They are pure on purpose: js/app.js cannot
     load under node (it reaches for #content at import time), so everything
     worth testing about the hero lives here, in tools/tests/test_home_hero.mjs. */

  /* The example-query chips, read from data/site.json's example_queries. Each
     chip is a LABEL a reader can recognise and the QUERY it actually runs —
     the two differ where the readable phrase is not the term the index knows
     ("the gantry" searches "gantry"). Anything unusable is dropped rather than
     rendered as an empty pill, and a string where the list belongs yields no
     chips instead of one chip per character. */
  function exampleQueries(site) {
    const list = (site && Array.isArray(site.example_queries)) ? site.example_queries : [];
    return list
      .filter((c) => c && typeof c === 'object')
      .map((c) => ({
        label: String(c.label == null ? (c.q == null ? '' : c.q) : c.label).trim(),
        q: String(c.q == null ? '' : c.q).trim(),
      }))
      .filter((c) => c.label && c.q);
  }

  /* The exact path under a hero hit's title. A site hit is its own hash route.
     A code, file, CAD or fork hit already carries a repository-relative path in
     `snippet`, which beats showing the raw GitHub blob URL — prefixed by the
     repository in `where`, but only when `where` is a repository name (one
     token) and does not already lead the snippet. A row whose snippet is prose
     (a page excerpt, a repository description) has no path to show, so the
     destination itself is the honest answer. */
  function hitPath(row) {
    const r = row || {};
    const href = String(r.href == null ? '' : r.href);
    if (href.startsWith('#')) return href;
    const snippet = String(r.snippet == null ? '' : r.snippet).trim();
    if (!snippet || /\s/.test(snippet)) return href;
    const where = String(r.where == null ? '' : r.where).trim();
    if (!where || /\s/.test(where)) return snippet;
    if (snippet === where || snippet.startsWith(`${where}/`)) return snippet;
    return `${where}/${snippet}`;
  }

  /* The rows the hero panel shows: the leading `limit` of whatever ordering the
     search produced (librarian picks already lead res.results), minus any row
     with no destination — a malformed librarian row must not render as a link
     to nowhere. */
  function heroHits(res, limit) {
    const rows = (res && Array.isArray(res.results)) ? res.results : [];
    const n = Math.max(0, Math.trunc(Number(limit) || 0));
    return rows.filter((r) => r && r.href).slice(0, n);
  }

  /* The one status line above the hero panel. `waiting` is viewSearch's rule,
     narrowed to one line: a multi-word query the keyword index answered with
     nothing is still out with the librarian, so saying "no results" would be
     wrong about a search that has not finished. */
  function heroStatus(res, shown, waiting) {
    const rows = (res && Array.isArray(res.results)) ? res.results : [];
    if (!rows.length) return waiting ? 'no keyword match — asking the librarian…' : 'no keyword match';
    const total = Number((res && res.total) || 0);
    return `${shown} of ${total.toLocaleString('en-US')} indexed entries`;
  }

  /* Is this hash the home route? The header's own search box collapses there
     (the page itself is the search box), so the router toggles a class on every
     navigation and needs the same answer the view dispatch reaches: js/app.js
     splits the hash on '@', then '?', then counts '/'-segments. */
  function isHomeHash(hash) {
    const raw = String(hash == null ? '' : hash).replace(/^#/, '');
    const path = raw.split('@')[0].split('?')[0];
    return path.split('/').filter(Boolean).length === 0;
  }

  /* ---------- the results page (uiux grill 2026-10, S3–S6) ----------

     Pure helpers js/app.js's viewSearch renders with, tested in
     tools/tests/test_search_routing.mjs. */

  /* S4: index snippets are raw Markdown excerpts ("**not**"). A result row
     shows plain words: emphasis and code marks, heading marks, link and image
     syntax and HTML tags go; whitespace collapses; the text is cut at 200
     characters on a word boundary with "…". Underscores stay (symbol names
     like add_mavlink_routerd carry them). The output is still TEXT — the
     renderer escapes it. */
  const SNIPPET_CHARS = 200;
  function plainSnippet(text) {
    let t = String(text == null ? '' : text);
    t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')          // images go
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')             // [text](url) -> text
      .replace(/<[^>]*>/g, ' ')                           // HTML tags
      .replace(/(^|\n)\s{0,3}#{1,6}\s+/g, '$1')              // heading marks
      .replace(/[*`]+/g, '')                              // emphasis and code marks
      .replace(/\s+/g, ' ')
      .trim();
    if (t.length <= SNIPPET_CHARS) return t;
    const cut = t.slice(0, SNIPPET_CHARS + 1);
    const space = cut.lastIndexOf(' ');
    const head = space > 0 ? cut.slice(0, space) : t.slice(0, SNIPPET_CHARS);
    return `${head.replace(/[\s.,;:–—-]+$/, '')}…`;
  }

  /* S3: the three tabs' rows, in the order the search produced them. A kind
     no tab claims is still listed under All. */
  const TAB_OF_KIND = { page: 'page', class: 'code', fn: 'code', file: 'code', repo: 'code',
    cad: 'cad', fork: 'cad' };
  const TABS = ['page', 'code', 'cad', 'all'];
  function groupResults(results) {
    const out = { page: [], code: [], cad: [] };
    for (const r of (Array.isArray(results) ? results : [])) {
      const tab = r && TAB_OF_KIND[r.kind];
      if (tab) out[tab].push(r);
    }
    return out;
  }

  /* S3: which tab a #/search hash shows. An explicit kind= wins; without one
     (or with junk), Pages when any page matched, else All. */
  function searchTab(hash, groups) {
    const raw = String(hash == null ? '' : hash);
    const qs = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1).split('@')[0] : '';
    let kind = null;
    try { kind = new URLSearchParams(qs).get('kind'); } catch (e) { kind = null; }
    if (TABS.includes(kind)) return kind;
    return (groups && Array.isArray(groups.page) && groups.page.length) ? 'page' : 'all';
  }

  /* S3: a tab is a real link, so the URL holds the tab and Cmd-click works. */
  function searchTabHref(q, kind) {
    return `#/search?q=${encodeURIComponent(String(q == null ? '' : q))}&kind=${encodeURIComponent(kind)}`;
  }

  /* S5: what an empty tab offers instead of a dead end: up to four example
     searches, the three nearest PAGES among whatever did match (S1's partial
     rows), and whether the librarian is still out. */
  function noResultsModel(res, site, waiting) {
    const rows = (res && Array.isArray(res.results)) ? res.results : [];
    return {
      chips: exampleQueries(site).slice(0, 4).map((c) => ({
        label: c.label, q: c.q, href: `#/search?q=${encodeURIComponent(c.q)}`,
      })),
      nearest: rows.filter((r) => r && r.kind === 'page' && r.href).slice(0, 3),
      waiting: Boolean(waiting),
    };
  }

  /* S6: split text into plain and matched segments so the renderer can escape
     EACH segment and wrap only the matched ones — never innerHTML of raw text.
     Case-insensitive, regex characters literal, the longer term first where
     two overlap, one-letter terms ignored, adjacent hits merged. The segments
     always join back to the input. */
  function highlightParts(text, terms) {
    const src = String(text == null ? '' : text);
    if (!src) return [];
    const words = Array.from(new Set((Array.isArray(terms) ? terms : [])
      .map((t) => String(t == null ? '' : t).toLowerCase())
      .filter((t) => t.length >= 2)))
      .sort((a, b) => b.length - a.length);
    if (!words.length) return [{ text: src, hit: false }];
    const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
    const parts = [];
    const push = (t, hit) => {
      if (!t) return;
      const last = parts[parts.length - 1];
      if (last && last.hit === hit) last.text += t;
      else parts.push({ text: t, hit });
    };
    let at = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      push(src.slice(at, m.index), false);
      push(m[0], true);
      at = m.index + m[0].length;
    }
    push(src.slice(at), false);
    return parts;
  }

  /* S3: switching tabs re-routes (the tab is in the URL), and that must not
     cost a second librarian request. The last finished answer is remembered
     by its trimmed lower-cased query; viewSearch reuses it only for a hash
     that names a tab, so a fresh search still asks again after a failure. */
  let last = null;
  function lastAnswer(q) {
    const key = String(q == null ? '' : q).trim().toLowerCase();
    return (last && last.key === key) ? last.res : null;
  }

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
    const res = {
      total: local.total,
      results: enriched.results,
      librarianCount: enriched.librarianCount,
      notice: enriched.notice,
    };
    last = { key: String(q == null ? '' : q).trim().toLowerCase(), res };
    return res;
  }

  const API = {
    query,
    // pure helpers (exported for tools/tests/test_search_routing.mjs and
    // tools/bench_librarian.mjs — neither of which may touch api/)
    buildItems,
    searchItems,
    queryTerms,
    createLibrarian,
    assignIds,
    projectCandidates,
    librarianCandidates,
    classifyStatus,
    pickIds,
    pickRows,
    mergePicks,
    strongLead,
    // the home hero's pure helpers (tools/tests/test_home_hero.mjs)
    exampleQueries,
    hitPath,
    heroHits,
    heroStatus,
    isHomeHash,
    // the results page's pure helpers (S3–S6)
    plainSnippet,
    groupResults,
    searchTab,
    searchTabHref,
    noResultsModel,
    highlightParts,
    lastAnswer,
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
