/* Static in-browser search over the precomputed index in search/.
   No server, no keys: shards are plain JSON fetched once on first query.
   Scoring is deliberately simple and inspectable — exact symbol/name matches
   dominate, then prefixes, then substrings, then path/heading/body hits.
   Deep links: site hits -> hash routes (with @heading anchors when the heading
   is the better match); code/CAD/fork hits -> GitHub blob URLs (+#L<line>).

   On top of that sits an OPTIONAL semantic re-ranker — "the librarian". The
   local engine always runs first and its ordering is a protected regression
   surface (tools/tests/test_search_routing.mjs locks the ten probes at rank 1);
   the librarian may only reorder the head of the list, never replace it, and
   every one of its failure modes degrades back to exactly the local answer.

   The site is dual-hosted: GitHub Pages (a subpath, no functions) and Vercel
   (the root, api/* runs). The one rule that keeps both working is that the
   fetch URL below stays RELATIVE. On Pages a POST to it returns 405, which this
   file reads as "no function on this host" and latches off for the session.

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

  async function loadAll() {
    const manifest = await fetch('search/manifest.json').then((r) => {
      if (!r.ok) throw new Error('search index missing — run tools/build_search_index.py');
      return r.json();
    });
    const shards = await Promise.all(manifest.shards.map((s) =>
      fetch(s.file).then((r) => {
        if (!r.ok) throw new Error(`${s.file}: HTTP ${r.status}`);
        return r.json();
      })));
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

  /* Strict schema read of {"results":[{"id","why"}]}. Anything else is treated
     as a failure, not as an empty answer. */
  function pickIds(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    if (!Array.isArray(payload.results)) return null;
    const ids = [];
    for (const row of payload.results) {
      if (!row || typeof row !== 'object') return null;
      if (typeof row.id !== 'string' || !row.id) return null;
      ids.push(row.id);
    }
    return ids;
  }

  /* Fold the librarian's picks into the local list: picks first (deduped, capped
     at PICK_LIMIT, unknown ids dropped), then every remaining local hit in its
     original local order. The exact-title pin runs ONLY when the librarian
     actually answered — with no answer the order must stay byte-identical to
     what the local engine produced. */
  function mergePicks(localResults, ids, q) {
    const rowIds = assignIds(localResults);
    const byId = new Map();
    rowIds.forEach((id, i) => { if (!byId.has(id)) byId.set(id, i); });

    const chosen = [];
    const taken = new Set();
    for (const raw of ids) {
      if (typeof raw !== 'string' || !byId.has(raw)) continue;
      const i = byId.get(raw);
      if (taken.has(i)) continue;
      taken.add(i);
      chosen.push(i);
      if (chosen.length >= PICK_LIMIT) break;
    }
    let librarianCount = chosen.length;

    if (librarianCount > 0) {
      const want = String(q == null ? '' : q).trim().toLowerCase();
      if (want) {
        const pin = localResults.findIndex(
          (r) => String(r.title == null ? '' : r.title).trim().toLowerCase() === want);
        if (pin >= 0) {
          const at = chosen.indexOf(pin);
          if (at > 0) {
            chosen.splice(at, 1);
            chosen.unshift(pin);
          } else if (at < 0 && chosen.length >= PICK_LIMIT) {
            // Already at the cap: the pin takes the top slot and the LOWEST
            // ranked pick gives up its own, so there are never more than
            // PICK_LIMIT rows above the divider. The displaced pick is not
            // thrown away — dropping it from `taken` puts it straight back into
            // the local tail below, in its original local position.
            const displaced = chosen.pop();
            taken.delete(displaced);
            chosen.unshift(pin);
            taken.add(pin);
          } else if (at < 0) {
            chosen.unshift(pin);
            taken.add(pin);
            librarianCount += 1;   // the divider still falls after the picks
          }
        }
      }
    }

    const rest = localResults.filter((_, i) => !taken.has(i));
    return { results: chosen.map((i) => localResults[i]).concat(rest), librarianCount };
  }

  /* One librarian per session. The `absent` latch is in-memory and deliberately
     never reset: on a host without the function we spend exactly one wasted
     request per session and show the user nothing at all. */
  function createLibrarian(opts) {
    const cfg = opts || {};
    const timeoutMs = cfg.timeoutMs || LIBRARIAN_TIMEOUT_MS;
    const doFetch = cfg.fetch || ((url, init) => fetch(url, init));
    let absent = false;

    async function enrich(q, local) {
      const results = (local && local.results) || [];
      const plain = { results, librarianCount: 0, notice: null };
      const failed = { results, librarianCount: 0, notice: LIBRARIAN_NOTICE };

      const trimmed = String(q == null ? '' : q).trim();
      if (!/\s/.test(trimmed)) return plain;   // single word: zero network, always
      if (absent) return plain;
      if (!results.length) return plain;       // nothing to re-rank

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
        if (verdict !== 'ok') return failed;

        let payload;
        try {
          payload = await res.json();
        } catch (e) {
          return failed;                       // malformed body
        }
        const ids = pickIds(payload);
        if (!ids) return failed;               // schema-invalid body
        const merged = mergePicks(results, ids, trimmed);
        return { results: merged.results, librarianCount: merged.librarianCount, notice: null };
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
     onLocal is called at most once. */
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
    if (!local.results.length) return localShape;
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
    mergePicks,
    LIBRARIAN_URL,
    LIBRARIAN_NOTICE,
    LIBRARIAN_TIMEOUT_MS,
    CANDIDATE_LIMIT,
    PICK_LIMIT,
  };

  if (typeof window !== 'undefined') window.HCSearch = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
}());
