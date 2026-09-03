#!/usr/bin/env python3
"""The check gate. Run before every commit:  python3 tools/check.py

Validates, failing loudly with actionable messages:
  1. every data/*.json registry parses (strict JSON by construction);
  2. setup: every manifest page file exists; every content/setup/*.md is
     referenced exactly once; ids unique;
  3. parity: the setup structure disposes of EVERY old-site page exactly once
     (migrated or dropped) against data/old-docs-pages.json, and
     docs/setup-parity.md is newer than or equal to the structure's content;
  4. projects: every org repo (data/org-repos.json) appears exactly once across
     project rosters or the exclusion list; project body files exist;
  5. tools: every tool file exists;
  6. content: no orphan markdown; every internal '#/...' link in content resolves
     to a real route; every relative asset reference exists; no orphan assets;
     images live on Cloudinary — content may not point at a local assets/*.png|
     jpg|jpeg|gif|svg, every res.cloudinary.com reference must resolve to an
     entry of data/cloudinary-manifest.json (matched on public_id, so delivery
     transformations are fine), and every manifest entry must be referenced;
  6b. hygiene: no credentials, key material or personal emails in content/**.md,
     data/**/*.json (the graph shards included) or .mcp.json;
  6c. people: data/people.json (when present) carries exactly name/title/photo/
     link per person, every photo resolves to a manifest entry, every link is an
     http(s) URL;
  7. shell: index.html references exist; vendored marked.min.js matches its
     pinned sha256;
  8. probes: data/search-probes.json carries exactly 10 well-formed probes;
  9. graph: the semantic layer under data/graph/ is in step with the registries —
     every registry page is a wiki.json node exactly once with the right kind and
     no stale ones, the 3 index views and one node per org repo, the counts block
     matches the real tallies, every edge resolves/has a type and a 'why' and is
     unique, every node carries a summary and summaries.json covers exactly the
     page+index nodes, every non-fork repo has a data/graph/repo-<name>.json shard
     (and no fork or stray one does), repos-index.json has one well-formed row per
     org repo, xref terms resolve and collide with neither stoplist nor each other,
     and every hand-authored edge was merged into wiki.json as 'related';
  10. contributors: data/graph/contributors.json (when present) is the projected,
     address-free shape build_contributors.py writes.

This gate is OFFLINE by design (it never touches the network). URL liveness is
the job of its online twin, tools/check_urls.py.

Never weaken a check to make it pass — fix the content it is complaining about.
"""
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MARKED_SHA256 = "15fabce5b65898b32b03f5ed25e9f891a729ad4c0d6d877110a7744aa847a894"
# Images are served from Cloudinary; these extensions may not be referenced
# from content as local files (the originals stay in assets/ as upload sources).
# Same set as the upload skill's imageExt and as IMAGE_SUFFIXES in
# tools/rst_convert.py — widen all three together or a format slips the policy.
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp",
              ".tiff", ".tif", ".avif", ".heic", ".heif")
CLOUDINARY_RE = re.compile(r"https?://res\.cloudinary\.com/[^\s)\"'<>\]]+")
# a delivery-URL segment that sits BEFORE the public_id: a version ('v1788…')
# or a transformation group ('f_auto,q_auto', 'w_800', 'c_fill,g_face').
DELIVERY_PREFIX_RE = re.compile(r"v\d+|[a-z]{1,3}_[^/,]+(?:,[a-z]{1,3}_[^/,]+)*")
SECRET_KEY_RE = re.compile(
    r"(password|passwd|pwd|api_key|apikey|api_secret|secret|token)", re.IGNORECASE)
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
EMAIL_OK = re.compile(r"@(github\.com|[\w.-]*\.local|example\.[a-z]+)$")
# ---- the semantic graph under data/graph/ (checks 9 + 10) ----
GRAPH = "data/graph"
# index views are landing pages, not content: they are counted separately, the
# same rule tools/build_wiki_graph.py and the search index use.
PAGE_KINDS = ("setup", "project", "tool", "about")
INDEX_IDS = ("index:home", "index:projects", "index:tools")
EDGE_TYPES = ("links-to", "member", "mentions", "related")
SUMMARY_SOURCES = ("derived", "authored")
CONTRIB_ORG = "HippoCampusRobotics"
CONTRIB_MAX_ROWS = 12
errors = []


def err(msg):
    errors.append(msg)


def load(name):
    p = ROOT / name
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except FileNotFoundError:
        err(f"{name}: missing")
    except json.JSONDecodeError as e:
        err(f"{name}:{e.lineno}:{e.colno}: {e.msg} (strict JSON — no trailing commas, double quotes)")
    return None


def resolve_public_id(url, cloud, known):
    """Map a Cloudinary delivery URL onto a known public_id, or None.

    Accepts https://res.cloudinary.com/<cloud>/image/upload/[<transforms>/]
    [v<digits>/]<public_id>[.<ext>] so that adding a delivery transformation
    (f_auto,q_auto / w_800 / …) never breaks the gate. A foreign cloud or an
    unknown public_id still returns None — i.e. still fails.
    """
    prefix = f"https://res.cloudinary.com/{cloud}/"
    if not url.startswith(prefix):
        return None
    m = re.match(r"(?:image|video|raw)/(?:upload|fetch|private|authenticated)/(.+)$",
                 url[len(prefix):])
    if not m:
        return None
    seg = m.group(1).split("/")
    for start in range(len(seg)):
        # only version/transformation segments may precede the public_id
        if start and not DELIVERY_PREFIX_RE.fullmatch(seg[start - 1]):
            break
        cand = "/".join(seg[start:])
        for c in (cand, re.sub(r"\.[A-Za-z0-9]{1,5}$", "", cand)):
            if c in known:
                return c
    return None


def walk_json(node, path=""):
    """Yield (dotted-key-path, key-name, string value) for every string in a doc."""
    if isinstance(node, dict):
        for k, v in node.items():
            yield from walk_json(v, f"{path}.{k}" if path else str(k))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from walk_json(v, f"{path}[{i}]")
    elif isinstance(node, str):
        yield path, path.rsplit(".", 1)[-1].split("[")[0], node


# --------------------------------------------------------------------------
# 9. the semantic graph (data/graph/**) — pure checks over loaded documents.
#
# Each one takes already-parsed dicts and RETURNS a list of messages, so it can
# be exercised against in-memory fixtures without a file ever being touched.
# main() feeds the results to err(). See tools/tests/test_check_graph.py.
# --------------------------------------------------------------------------
def read_repo_shards(root):
    """{repo name: parsed data/graph/repo-<name>.json} for every shard on disk.

    A shard whose JSON does not parse maps to None: it still counts as present
    (so it is not reported as missing too), and the decode error is reported by
    the JSON hygiene scan at 6b, which walks data/**/*.json.
    """
    shards = {}
    for p in sorted((Path(root) / "data" / "graph").glob("repo-*.json")):
        name = p.name[len("repo-"):-len(".json")]
        try:
            shards[name] = json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            shards[name] = None
    return shards


def node_ids(wiki):
    return {n["id"] for n in wiki.get("nodes") or []
            if isinstance(n, dict) and isinstance(n.get("id"), str)}


def enumerate_page_nodes(setup, projects, tools):
    """Every content page the registries define, as (node id, kind) pairs.

    The id scheme is tools/build_wiki_graph.py's: 'setup/<id>', 'projects/<id>',
    'tools/<id>', 'about'. Index views and repos are not registry pages.
    """
    rows = []
    for sec in setup["sections"]:
        for p in sec["pages"]:
            rows.append((f"setup/{p['id']}", "setup"))
    for pr in projects["projects"]:
        rows.append((f"projects/{pr['id']}", "project"))
    for t in tools["tools"]:
        rows.append((f"tools/{t['id']}", "tool"))
    rows.append(("about", "about"))
    return rows


def check_graph_parity(wiki, setup, projects, tools, org):
    """wiki.json's node set is exactly the registries', repo for repo."""
    out = []
    nodes = wiki.get("nodes")
    if not isinstance(nodes, list):
        return [f"{GRAPH}/wiki.json: 'nodes' must be a list — re-run "
                f"tools/build_wiki_graph.py"]
    kept, by_id = [], {}
    for i, n in enumerate(nodes):
        if not isinstance(n, dict) or not isinstance(n.get("id"), str) or not n["id"]:
            out.append(f"{GRAPH}/wiki.json: node #{i} needs a non-empty string 'id' "
                       f"— re-run tools/build_wiki_graph.py")
            continue
        kept.append(n)
        by_id.setdefault(n["id"], []).append(n)
    nodes = kept
    for nid, dupes in sorted(by_id.items()):
        if len(dupes) > 1:
            out.append(f"{GRAPH}/wiki.json: node '{nid}' appears {len(dupes)} times "
                       f"— a node id is unique; re-run tools/build_wiki_graph.py")

    rows = enumerate_page_nodes(setup, projects, tools)
    want = dict(rows)
    if len(want) != len(rows):
        seen, dupes = set(), set()
        for nid, _ in rows:
            (dupes if nid in seen else seen).add(nid)
        out.append(f"data/setup.json + projects.json + tools.json: duplicate page id"
                   f"(s) {sorted(dupes)} — a page id is unique across the registries")
    for nid, kind in sorted(want.items()):
        got = by_id.get(nid)
        if not got:
            out.append(f"{GRAPH}/wiki.json: registry page '{nid}' has no node — "
                       f"re-run tools/build_wiki_graph.py")
        elif got[0].get("kind") != kind:
            out.append(f"{GRAPH}/wiki.json: node '{nid}' has kind "
                       f"'{got[0].get('kind')}', expected '{kind}' — re-run "
                       f"tools/build_wiki_graph.py")

    # Exact parity means the node set is CLOSED: every node is a registry page,
    # one of the fixed index views, or an org repo. A node of any other kind (or
    # an unknown id under a known kind) is stale or malformed and must fail here,
    # not slip between the per-kind checks below.
    allowed_kinds = set(PAGE_KINDS) | {"index", "repo"}
    for n in nodes:
        if n.get("kind") not in allowed_kinds:
            out.append(f"{GRAPH}/wiki.json: node '{n['id']}' has unknown kind "
                       f"'{n.get('kind')}' — a node is a registry page, an index "
                       f"view, or an org repo; re-run tools/build_wiki_graph.py")

    pages = [n for n in nodes if n.get("kind") in PAGE_KINDS]
    if len(pages) != len(want):
        out.append(f"{GRAPH}/wiki.json: page-kind nodes {len(pages)} != enumerated "
                   f"{len(want)} — re-run tools/build_wiki_graph.py")
    for n in pages:
        if n["id"] not in want:
            out.append(f"{GRAPH}/wiki.json: stale page node '{n['id']}' is in no "
                       f"registry — re-run tools/build_wiki_graph.py")

    index = [n["id"] for n in nodes if n.get("kind") == "index"]
    if sorted(index) != sorted(INDEX_IDS):
        out.append(f"{GRAPH}/wiki.json: index nodes {sorted(index)} != "
                   f"{sorted(INDEX_IDS)} — the landing views are fixed; re-run "
                   f"tools/build_wiki_graph.py")

    repos = [n["id"] for n in nodes if n.get("kind") == "repo"]
    want_repos = {f"repo:{r['name']}" for r in org
                  if isinstance(r, dict) and isinstance(r.get("name"), str)}
    for rid in sorted(want_repos - set(repos)):
        out.append(f"{GRAPH}/wiki.json: org repo node '{rid}' is missing — re-run "
                   f"tools/build_repo_graphs.py, then tools/build_wiki_graph.py")
    for rid in sorted(set(repos) - want_repos):
        out.append(f"{GRAPH}/wiki.json: repo node '{rid}' is not an org repo "
                   f"(data/org-repos.json) — re-run tools/build_wiki_graph.py")
    if len(repos) != len(want_repos):
        out.append(f"{GRAPH}/wiki.json: repo nodes {len(repos)} != org repos "
                   f"{len(want_repos)} — re-run tools/build_wiki_graph.py")

    counts = wiki.get("counts")
    if not isinstance(counts, dict):
        out.append(f"{GRAPH}/wiki.json: 'counts' block missing — re-run "
                   f"tools/build_wiki_graph.py")
    else:
        for key, actual in (("pages", len(pages)), ("index", len(index)),
                            ("repos", len(repos))):
            if counts.get(key) != actual:
                out.append(f"{GRAPH}/wiki.json: counts.{key} says "
                           f"{counts.get(key)} but the graph holds {actual} — "
                           f"stale counts; re-run tools/build_wiki_graph.py")
        tally = {}
        for e in wiki.get("edges") or []:
            if isinstance(e, dict) and isinstance(e.get("type"), str):
                tally[e["type"]] = tally.get(e["type"], 0) + 1
        if counts.get("edges") != tally:
            out.append(f"{GRAPH}/wiki.json: counts.edges {counts.get('edges')} != "
                       f"actual {tally} — stale counts; re-run "
                       f"tools/build_wiki_graph.py")
    return out


def check_graph_edges(wiki):
    """Every edge resolves, is typed, explains itself, and appears once."""
    out = []
    edges = wiki.get("edges")
    if not isinstance(edges, list):
        return [f"{GRAPH}/wiki.json: 'edges' must be a list — re-run "
                f"tools/build_wiki_graph.py"]
    ids = node_ids(wiki)
    seen = set()
    for i, e in enumerate(edges):
        if not isinstance(e, dict):
            out.append(f"{GRAPH}/wiki.json: edge #{i} must be an object — re-run "
                       f"tools/build_wiki_graph.py")
            continue
        s, t, kind = e.get("s"), e.get("t"), e.get("type")
        where = f"{GRAPH}/wiki.json: edge #{i} {s} -> {t}"
        for side, value in (("s", s), ("t", t)):
            if not isinstance(value, str) or value not in ids:
                out.append(f"{where}: '{side}' endpoint '{value}' is not a node — "
                           f"dangling edge; re-run tools/build_wiki_graph.py")
        if s is not None and s == t:
            out.append(f"{where}: self edge on '{s}' — a page does not link to "
                       f"itself; re-run tools/build_wiki_graph.py")
        if kind not in EDGE_TYPES:
            out.append(f"{where}: unknown type '{kind}' — one of "
                       f"{sorted(EDGE_TYPES)}")
        if not (isinstance(e.get("why"), str) and e["why"].strip()):
            out.append(f"{where}: 'why' must be a non-empty string — every edge "
                       f"says why it exists")
        key = (str(s), str(t), str(kind))
        if key in seen:
            out.append(f"{GRAPH}/wiki.json: duplicate edge {s} -{kind}-> {t} — "
                       f"re-run tools/build_wiki_graph.py")
        seen.add(key)
    return out


def check_graph_summaries(wiki, summaries):
    """Every node carries prose, and summaries.json covers the page+index nodes."""
    out = []
    pages = summaries.get("pages")
    if not isinstance(pages, dict):
        return [f"{GRAPH}/summaries.json: 'pages' must be an object keyed by node "
                f"id — re-run tools/build_wiki_graph.py"]
    want = set()
    for n in wiki.get("nodes") or []:
        if not isinstance(n, dict):
            continue
        nid, text = n.get("id"), n.get("summary")
        if not (isinstance(text, str) and text.strip()):
            source = (f"its one-liner comes from {GRAPH}/repos-index.json"
                      if n.get("kind") == "repo"
                      else f"write one in {GRAPH}/summaries.json")
            out.append(f"{GRAPH}/wiki.json: node '{nid}' has an empty summary — "
                       f"{source}; re-run tools/build_wiki_graph.py")
        if n.get("kind") != "repo" and isinstance(nid, str):
            want.add(nid)
    for nid in sorted(want - set(pages)):
        out.append(f"{GRAPH}/summaries.json: no entry for node '{nid}' — re-run "
                   f"tools/build_wiki_graph.py")
    for nid in sorted(set(pages) - want):
        out.append(f"{GRAPH}/summaries.json: entry '{nid}' is not a page or index "
                   f"node of wiki.json — stale summary; re-run "
                   f"tools/build_wiki_graph.py")
    for nid in sorted(set(pages) & want):
        row = pages[nid]
        if not isinstance(row, dict):
            out.append(f"{GRAPH}/summaries.json: '{nid}' must be an object with "
                       f"summary/source")
            continue
        if not (isinstance(row.get("summary"), str) and row["summary"].strip()):
            out.append(f"{GRAPH}/summaries.json: '{nid}' has an empty summary — "
                       f"write one (source 'authored') or re-run "
                       f"tools/build_wiki_graph.py")
        if row.get("source") not in SUMMARY_SOURCES:
            out.append(f"{GRAPH}/summaries.json: '{nid}' has source "
                       f"'{row.get('source')}' — must be one of "
                       f"{sorted(SUMMARY_SOURCES)}")
    return out


def check_graph_shards(org, repos_index, projects, shards):
    """One shard per non-fork org repo, and one repos-index row per org repo."""
    out = []
    org_rows = {r["name"]: r for r in org
                if isinstance(r, dict) and isinstance(r.get("name"), str)}
    project_ids = {p["id"] for p in projects.get("projects", [])
                   if isinstance(p, dict)}
    for name in sorted(org_rows):
        fork = bool(org_rows[name].get("isFork"))
        present = name in shards
        if fork and present:
            out.append(f"{GRAPH}/repo-{name}.json: shard for a fork — forks are "
                       f"upstream code and get no graph shard; delete it")
            continue
        if not fork and not present:
            out.append(f"{GRAPH}/repo-{name}.json: missing shard for org repo "
                       f"'{name}' — re-run tools/build_repo_graphs.py")
            continue
        doc = shards.get(name)
        if doc is None:
            continue  # unparseable: the 6b hygiene scan reports the decode error
        if not isinstance(doc, dict):
            out.append(f"{GRAPH}/repo-{name}.json: top level must be an object — "
                       f"re-run tools/build_repo_graphs.py")
            continue
        if doc.get("repo") != name:
            out.append(f"{GRAPH}/repo-{name}.json: 'repo' is '{doc.get('repo')}', "
                       f"expected '{name}' — the shard is filed under the wrong "
                       f"name; re-run tools/build_repo_graphs.py")
        if not isinstance(doc.get("counts"), dict):
            out.append(f"{GRAPH}/repo-{name}.json: 'counts' block missing — re-run "
                       f"tools/build_repo_graphs.py")
        for key in ("god_nodes", "communities"):
            if not isinstance(doc.get(key), list):
                out.append(f"{GRAPH}/repo-{name}.json: '{key}' must be a list, got "
                           f"{type(doc.get(key)).__name__} — re-run "
                           f"tools/build_repo_graphs.py")
    for name in sorted(set(shards) - set(org_rows)):
        out.append(f"{GRAPH}/repo-{name}.json: stray shard — '{name}' is not an org "
                   f"repo (data/org-repos.json); delete it")

    rows = repos_index.get("repos")
    if not isinstance(rows, list):
        out.append(f"{GRAPH}/repos-index.json: 'repos' must be a list — re-run "
                   f"tools/build_repo_graphs.py")
        return out
    seen = {}
    for i, r in enumerate(rows):
        if not isinstance(r, dict) or not isinstance(r.get("name"), str):
            out.append(f"{GRAPH}/repos-index.json: row #{i} needs a string 'name' — "
                       f"re-run tools/build_repo_graphs.py")
            continue
        seen.setdefault(r["name"], []).append(r)
    for name in sorted(org_rows):
        n = len(seen.get(name, []))
        if n == 0:
            out.append(f"{GRAPH}/repos-index.json: no row for org repo '{name}' — "
                       f"re-run tools/build_repo_graphs.py")
        elif n > 1:
            out.append(f"{GRAPH}/repos-index.json: org repo '{name}' has {n} rows — "
                       f"exactly one per repo; re-run tools/build_repo_graphs.py")
    for name in sorted(set(seen) - set(org_rows)):
        out.append(f"{GRAPH}/repos-index.json: row '{name}' is not an org repo "
                   f"(data/org-repos.json) — re-run tools/build_repo_graphs.py")
    for name in sorted(seen):
        for r in seen[name]:
            if not (isinstance(r.get("oneliner"), str) and r["oneliner"].strip()):
                out.append(f"{GRAPH}/repos-index.json: '{name}' has an empty "
                           f"oneliner — every repo card needs one line; re-run "
                           f"tools/build_repo_graphs.py")
            if name in org_rows and bool(r.get("fork")) != bool(
                    org_rows[name].get("isFork")):
                out.append(f"{GRAPH}/repos-index.json: '{name}' fork flag "
                           f"{bool(r.get('fork'))} != data/org-repos.json isFork "
                           f"{bool(org_rows[name].get('isFork'))} — re-run "
                           f"tools/build_repo_graphs.py")
            pid = r.get("project")
            if pid is not None and pid not in project_ids:
                out.append(f"{GRAPH}/repos-index.json: '{name}' names unknown "
                           f"project '{pid}' — must be null or an id from "
                           f"data/projects.json")
    return out


def check_xref_terms(xref, wiki):
    """Cross-reference terms resolve and collide with nothing."""
    out = []
    terms = xref.get("terms")
    if not isinstance(terms, dict):
        return [f"{GRAPH}/xref-terms.json: 'terms' must be an object mapping term "
                f"to node id — re-run tools/build_wiki_graph.py"]
    ids = node_ids(wiki)
    stop = {s.lower() for s in xref.get("stoplist") or [] if isinstance(s, str)}
    rejected = {s.lower() for s in xref.get("rejected") or [] if isinstance(s, str)}
    folded = {}
    for term in sorted(terms):
        if not (isinstance(term, str) and term.strip()):
            out.append(f"{GRAPH}/xref-terms.json: term {term!r} must be a non-empty "
                       f"string — drop it")
            continue
        low = term.lower()
        target = terms[term]
        if low in stop:
            out.append(f"{GRAPH}/xref-terms.json: term '{term}' is on the stoplist "
                       f"— drop it from 'terms', or from 'stoplist' if it really "
                       f"should link")
        if low in rejected:
            out.append(f"{GRAPH}/xref-terms.json: term '{term}' is on the rejected "
                       f"list — a rejected term may not also be linked")
        if not isinstance(target, str) or target not in ids:
            out.append(f"{GRAPH}/xref-terms.json: term '{term}' points at "
                       f"'{target}', which is not a wiki.json node — re-run "
                       f"tools/build_wiki_graph.py")
        folded.setdefault(low, []).append(term)
    for low, group in sorted(folded.items()):
        if len(group) > 1:
            out.append(f"{GRAPH}/xref-terms.json: terms {sorted(group)} differ only "
                       f"by case — the client matches case-insensitively; keep one")
    return out


def check_authored_edges(authored, wiki):
    """The hand-written overlay resolves and was merged into wiki.json."""
    out = []
    rows = authored.get("edges")
    if not isinstance(rows, list):
        return [f"{GRAPH}/edges-authored.json: 'edges' must be a list"]
    ids = node_ids(wiki)
    related = {(e.get("s"), e.get("t")): e.get("why") for e in wiki.get("edges") or []
               if isinstance(e, dict) and e.get("type") == "related"}
    for i, e in enumerate(rows):
        if not isinstance(e, dict):
            out.append(f"{GRAPH}/edges-authored.json: edge #{i} must be an object")
            continue
        s, t = e.get("s"), e.get("t")
        where = f"{GRAPH}/edges-authored.json: edge #{i} {s} -> {t}"
        for side, value in (("s", s), ("t", t)):
            if not isinstance(value, str) or value not in ids:
                out.append(f"{where}: '{side}' endpoint '{value}' is not a "
                           f"wiki.json node — fix the overlay or re-run "
                           f"tools/build_wiki_graph.py")
        if not (isinstance(e.get("why"), str) and e["why"].strip()):
            out.append(f"{where}: 'why' must be a non-empty string — an authored "
                       f"edge says why it exists")
        if (s, t) not in related:
            out.append(f"{GRAPH}/edges-authored.json: edge {s} -> {t} is not in "
                       f"wiki.json as a 'related' edge — the overlay was not "
                       f"merged; re-run tools/build_wiki_graph.py")
        elif related[(s, t)] != e.get("why"):
            # the generator copies the why verbatim; a mismatch is a stale wiki.json
            out.append(f"{GRAPH}/edges-authored.json: edge {s} -> {t} 'why' differs "
                       f"from wiki.json's related edge — stale graph; re-run "
                       f"tools/build_wiki_graph.py")
    return out


# --------------------------------------------------------------------------
# 10. contributors — optional-when-present, like data/people.json at 6c.
# --------------------------------------------------------------------------
def check_contributors(contributors, projects):
    """data/graph/contributors.json, when it exists, is address-free and sorted.

    The file is a gated artifact: a checkout without it is fine (None), and the
    check is then a no-op — the same shape as the people.json rule at 6c.
    """
    if contributors is None:
        return []
    where = f"{GRAPH}/contributors.json"
    if not isinstance(contributors, dict):
        return [f"{where}: top level must be an object with generated/org/note/"
                f"projects — re-run tools/build_contributors.py"]
    out = []
    want_keys = {"generated", "org", "note", "projects"}
    extra = sorted(set(contributors) - want_keys)
    missing = sorted(want_keys - set(contributors))
    if extra:
        out.append(f"{where}: unknown top-level key(s) {extra} — exactly "
                   f"generated/org/note/projects")
    if missing:
        out.append(f"{where}: missing top-level key(s) {missing} — exactly "
                   f"generated/org/note/projects")
    if contributors.get("org") != CONTRIB_ORG:
        out.append(f"{where}: 'org' is {contributors.get('org')!r}, expected "
                   f"'{CONTRIB_ORG}' — this file only ever covers the lab's org")
    for keypath, _key, value in walk_json(contributors):
        if "@" in value:
            out.append(f"{where}: '@' in the string at '{keypath}' — this file "
                       f"carries logins and display names only (privacy "
                       f"projection); re-run tools/build_contributors.py")
    buckets = contributors.get("projects")
    if not isinstance(buckets, dict):
        out.append(f"{where}: 'projects' must be an object keyed by project id — "
                   f"re-run tools/build_contributors.py")
        return out
    project_ids = {p["id"] for p in projects.get("projects", [])
                   if isinstance(p, dict)}
    for pid in sorted(set(buckets) - project_ids):
        out.append(f"{where}: '{pid}' is not a project id of data/projects.json — "
                   f"re-run tools/build_contributors.py")
    for pid in sorted(project_ids - set(buckets)):
        out.append(f"{where}: no entry for project '{pid}' — every project gets a "
                   f"bucket; re-run tools/build_contributors.py")
    for pid in sorted(set(buckets) & project_ids):
        bucket = buckets[pid]
        if not isinstance(bucket, dict):
            out.append(f"{where}: '{pid}' must be an object with a 'contributors' "
                       f"list")
            continue
        extra_keys = sorted(set(bucket) - {"contributors", "truncated"})
        if extra_keys:
            out.append(f"{where}: '{pid}' has unknown key(s) {extra_keys} — exactly "
                       f"contributors/truncated")
        if "truncated" in bucket and not (
                isinstance(bucket["truncated"], int)
                and not isinstance(bucket["truncated"], bool)
                and bucket["truncated"] > 0):
            out.append(f"{where}: '{pid}' has truncated={bucket['truncated']!r} — "
                       f"must be a positive integer when present")
        rows = bucket.get("contributors")
        if not isinstance(rows, list):
            out.append(f"{where}: '{pid}' has no 'contributors' list — re-run "
                       f"tools/build_contributors.py")
            continue
        if len(rows) > CONTRIB_MAX_ROWS:
            out.append(f"{where}: '{pid}' lists {len(rows)} contributors — at most "
                       f"{CONTRIB_MAX_ROWS}; re-run tools/build_contributors.py")
        order = []
        seen_logins = set()
        for i, r in enumerate(rows):
            who = f"{where}: '{pid}' row #{i}"
            if not isinstance(r, dict):
                out.append(f"{who} must be an object")
                continue
            dup_login = r.get("login")
            if isinstance(dup_login, str):
                if dup_login in seen_logins:
                    out.append(f"{who}: login '{dup_login}' appears more than once in "
                               f"'{pid}' — one row per contributor; re-run "
                               f"tools/build_contributors.py")
                seen_logins.add(dup_login)
            extra_fields = sorted(set(r) - {"login", "name", "contributions",
                                            "roster"})
            if extra_fields:
                out.append(f"{who}: unknown field(s) {extra_fields} — a row is "
                           f"exactly login/name/contributions[/roster]")
            for key in ("login", "name"):
                if not (isinstance(r.get(key), str) and r[key].strip()):
                    out.append(f"{who}: '{key}' must be a non-empty string")
            n = r.get("contributions")
            if not (isinstance(n, int) and not isinstance(n, bool) and n > 0):
                out.append(f"{who}: 'contributions' must be a positive integer, got "
                           f"{n!r}")
            if "roster" in r and r["roster"] is not True:
                out.append(f"{who}: 'roster' must be true when present, got "
                           f"{r['roster']!r}")
            login = r.get("login")
            if isinstance(login, str) and login.endswith("[bot]"):
                out.append(f"{who}: bot account '{login}' — bots are not "
                           f"contributors; re-run tools/build_contributors.py")
            if isinstance(login, str) and isinstance(n, int) \
                    and not isinstance(n, bool):
                order.append((-n, login))
        if order != sorted(order):
            out.append(f"{where}: '{pid}' rows are not sorted by contributions "
                       f"(descending) then login — re-run "
                       f"tools/build_contributors.py")
    return out


def main():
    site = load("data/site.json")
    setup = load("data/setup.json")
    structure = load("data/setup-structure.json")
    projects = load("data/projects.json")
    tools = load("data/tools.json")
    old_pages = load("data/old-docs-pages.json")
    org = load("data/org-repos.json")
    probes = load("data/search-probes.json")
    cloudinary = load("data/cloudinary-manifest.json")
    # the semantic layer: committed artifacts, so a missing one is an error
    wiki = load(f"{GRAPH}/wiki.json")
    summaries = load(f"{GRAPH}/summaries.json")
    xref = load(f"{GRAPH}/xref-terms.json")
    authored = load(f"{GRAPH}/edges-authored.json")
    repos_index = load(f"{GRAPH}/repos-index.json")
    if errors:
        report()

    # ---- 2. setup manifest <-> files ----
    setup_ids = set()
    referenced_md = set()
    for sec in setup["sections"]:
        for p in sec["pages"]:
            if p["id"] in setup_ids:
                err(f"setup.json: duplicate page id {p['id']}")
            setup_ids.add(p["id"])
            f = ROOT / p["file"]
            referenced_md.add(f.resolve())
            if not f.exists():
                err(f"setup.json: {p['id']} points at missing file {p['file']}")
            if not p.get("title"):
                err(f"setup.json: {p['id']} has no title")

    on_disk = {q.resolve() for q in (ROOT / "content" / "setup").rglob("*.md")}
    for orphan in sorted(on_disk - referenced_md):
        err(f"orphan content file (not in setup.json): {orphan.relative_to(ROOT)}")
    # (missing files already reported above)

    # ---- 3. parity: old pages disposed exactly once ----
    disposed = {}
    for g in structure["groups"]:
        for p in g["pages"]:
            disposed.setdefault(p["old"].removeprefix("contents/") if False else p["old"], []).append("migrated")
    for d in structure["dropped"]:
        disposed.setdefault(d["old"], []).append("dropped")
    old_set = set(old_pages["pages"])
    for page in sorted(old_set):
        n = len(disposed.get(page, []))
        if n == 0:
            err(f"parity: old page '{page}' has no disposition (add to a group or dropped list)")
        elif n > 1:
            err(f"parity: old page '{page}' disposed {n} times")
    for page in sorted(set(disposed) - old_set):
        err(f"parity: structure names unknown old page '{page}'")
    parity_md = ROOT / "docs" / "setup-parity.md"
    if not parity_md.exists():
        err("docs/setup-parity.md missing — run tools/rst_convert.py")
    else:
        m = re.search(r"Pages found: (\d+) · migrated: (\d+) · dropped: (\d+)",
                      parity_md.read_text(encoding="utf-8"))
        if not m:
            err("docs/setup-parity.md: counts line missing")
        elif int(m.group(1)) != len(old_set):
            err(f"docs/setup-parity.md counts stale ({m.group(1)} vs {len(old_set)} old pages) — re-run tools/rst_convert.py")

    # ---- 4. projects coverage ----
    org_names = {r["name"] for r in org}
    seen = {}
    for pr in projects["projects"]:
        f = ROOT / pr["file"]
        if not f.exists():
            err(f"projects.json: {pr['id']} points at missing file {pr['file']}")
        if pr["status"] not in ("active", "maintained", "legacy", "archive"):
            err(f"projects.json: {pr['id']} has unknown status '{pr['status']}'")
        for r in pr["repos"]:
            if r.get("external"):
                continue
            seen.setdefault(r["name"], []).append(pr["id"])
    for x in projects.get("exclusions", []):
        seen.setdefault(x["name"], []).append("excluded")
        if not x.get("reason"):
            err(f"projects.json: exclusion '{x['name']}' has no reason")
    for name in sorted(org_names):
        n = len(seen.get(name, []))
        if n == 0:
            err(f"projects coverage: org repo '{name}' is in no project and not excluded")
        elif n > 1:
            err(f"projects coverage: org repo '{name}' appears {n} times ({seen[name]})")
    for name in sorted(set(seen) - org_names):
        err(f"projects.json names unknown org repo '{name}' (update data/org-repos.json?)")

    # ---- 5. tools ----
    tool_ids = set()
    for t in tools["tools"]:
        tool_ids.add(t["id"])
        if not (ROOT / t["file"]).exists():
            err(f"tools.json: {t['id']} points at missing file {t['file']}")

    # ---- 6. content links + assets ----
    project_ids = {p["id"] for p in projects["projects"]}
    md_files = sorted((ROOT / "content").rglob("*.md"))
    used_assets = set()
    link_re = re.compile(r"\]\(([^)\s]+)\)")
    html_ref_re = re.compile(r'(?:src|href)="([^"]+)"')
    # embedded images only — a plain hyperlink that happens to point at a .svg
    # elsewhere on the web is a link, not an image this site serves.
    img_md_re = re.compile(r"!\[[^\]]*\]\(([^)\s]+)\)")
    img_html_re = re.compile(r"""<img[^>]*?\ssrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>"']+))""",
                             re.IGNORECASE)

    def check_route(route, where):
        route = route.split("@")[0]
        seg = [s for s in route.lstrip("#/").split("/") if s]
        if not seg:
            return
        if seg[0] == "setup":
            if len(seg) > 1 and "/".join(seg[1:]) not in setup_ids:
                err(f"{where}: broken internal link {route}")
        elif seg[0] == "projects":
            if len(seg) > 1 and seg[1] not in project_ids:
                err(f"{where}: broken internal link {route}")
        elif seg[0] == "tools":
            if len(seg) > 1 and seg[1] not in tool_ids:
                err(f"{where}: broken internal link {route}")
        elif seg[0] not in ("about", "search"):
            err(f"{where}: unknown route {route}")

    def is_image(href):
        return href.split("?")[0].split("#")[0].lower().endswith(IMAGE_EXTS)

    def is_local_asset(href):
        return href.split("?")[0].lstrip("./").startswith("assets/")

    for md in md_files:
        rel = md.relative_to(ROOT)
        text = md.read_text(encoding="utf-8")
        targets = link_re.findall(text) + html_ref_re.findall(text)
        # every image the page actually embeds, however it is quoted
        embedded = set(img_md_re.findall(text))
        embedded |= {a or b or c for a, b, c in img_html_re.findall(text)}
        for href in targets:
            if href.startswith("#/"):
                check_route(href, str(rel))
            elif href.startswith(("http://", "https://", "mailto:")):
                continue
            elif href.startswith("#"):
                continue  # same-page anchor
            else:
                if not (ROOT / href).exists():
                    err(f"{rel}: missing local file {href}")
                else:
                    used_assets.add((ROOT / href).resolve())
        # images are served from Cloudinary — a local one means a migration was
        # missed (non-image downloads stay local)
        for ref in sorted(set(targets) | embedded):
            if is_local_asset(ref) and is_image(ref):
                err(f"{rel}: local image reference '{ref}' — images must be uploaded "
                    f"to Cloudinary and referenced via data/cloudinary-manifest.json")
        # …and an embedded image may not hang off somebody else's host either
        for src in sorted(embedded):
            if src.startswith(("http://", "https://")) \
                    and not src.startswith("https://res.cloudinary.com/"):
                err(f"{rel}: image embedded from a foreign host '{src}' — upload it to "
                    f"Cloudinary and reference it via data/cloudinary-manifest.json")

    # ---- 6a. cloudinary manifest <-> references ----
    index_text = (ROOT / "index.html").read_text(encoding="utf-8")
    people_path = ROOT / "data" / "people.json"          # may not exist yet
    scanned = [(str(m.relative_to(ROOT)), m.read_text(encoding="utf-8")) for m in md_files]
    scanned.append(("index.html", index_text))
    if people_path.exists():
        scanned.append(("data/people.json", people_path.read_text(encoding="utf-8")))

    cloud = cloudinary.get("cloud") or ""
    if not cloud:
        err("data/cloudinary-manifest.json: no 'cloud' name")
    manifest_sources = set()
    public_ids, urls, sources = set(), set(), set()
    for e in cloudinary.get("assets", []):
        src, pid, url = e.get("source"), e.get("public_id"), e.get("url")
        if not (src and pid and url):
            err(f"data/cloudinary-manifest.json: entry missing source/public_id/url: {e}")
            continue
        for value, seen, what in ((src, sources, "source"), (url, urls, "url"),
                                  (pid, public_ids, "public_id")):
            if value in seen:
                err(f"data/cloudinary-manifest.json: duplicate {what} '{value}'")
            seen.add(value)
        # The digest is what makes drift detectable, so it is mandatory: an entry
        # without one would otherwise count as a valid source and quietly opt out
        # of the guarantee below.
        recorded = e.get("sha256")
        digest_ok = isinstance(recorded, str) and re.fullmatch(r"[0-9a-f]{64}", recorded)
        if not digest_ok:
            err(f"data/cloudinary-manifest.json: manifest entry {pid}: missing/invalid "
                f"sha256 — required for source drift detection")
        p = ROOT / src
        if not p.exists():
            err(f"data/cloudinary-manifest.json: source file missing on disk: {src} "
                f"(the local original is the upload source — do not delete it)")
        else:
            manifest_sources.add(p.resolve())
            # Drift guard: edit the local original and the site would keep
            # serving the OLD remote image. Only sha256 is compared — 'bytes'
            # is what Cloudinary stored after its own processing and legitimately
            # differs from the source (it does for the two GIFs).
            digest = hashlib.sha256(p.read_bytes()).hexdigest()
            if digest_ok and digest != recorded:
                err(f"data/cloudinary-manifest.json: {src} changed since upload "
                    f"({digest[:12]}… vs {recorded[:12]}…) — re-upload it and "
                    f"refresh the manifest, or the site serves the old image")
        if cloud and not url.startswith(f"https://res.cloudinary.com/{cloud}/"):
            err(f"data/cloudinary-manifest.json: url for {pid} is not on cloud "
                f"'{cloud}': {url}")

    referenced_ids = set()
    for where, text in scanned:
        for url in CLOUDINARY_RE.findall(text):
            url = url.rstrip(".,;:")
            pid = resolve_public_id(url, cloud, public_ids)
            if pid is None:
                err(f"{where}: Cloudinary reference with no manifest entry: {url} "
                    f"(upload it and re-run the manifest step)")
            else:
                referenced_ids.add(pid)
    for pid in sorted(public_ids - referenced_ids):
        err(f"orphan cloudinary asset (uploaded but nothing references it): {pid}")

    # ---- 6c. people roster (data/people.json — optional; older checkouts) ----
    if people_path.exists():
        people = load("data/people.json")
        # Container types first: the About page swallows a malformed roster and
        # renders nobody, so an empty or wrongly-shaped 'groups' must fail here
        # rather than quietly ship a people-less page.
        if not isinstance(people, dict):
            err(f"data/people.json: top level must be an object with a 'groups' list, "
                f"got {type(people).__name__}")
        elif not isinstance(people.get("groups"), list):
            err(f"data/people.json: 'groups' must be a list, got "
                f"{type(people.get('groups')).__name__}")
        elif not people["groups"]:
            err("data/people.json: 'groups' is empty — the About page would render "
                "no people at all")
        else:
            group_ids = set()
            for gi, g in enumerate(people["groups"]):
                if not isinstance(g, dict):
                    err(f"data/people.json: group #{gi} must be an object, got "
                        f"{type(g).__name__}")
                    continue
                where = f"data/people.json: group {g.get('id') or f'#{gi}'}"
                if not (isinstance(g.get("id"), str) and g["id"].strip()):
                    err(f"{where}: 'id' must be a non-empty string")
                if not (isinstance(g.get("title"), str) and g["title"].strip()):
                    err(f"{where}: 'title' must be a non-empty string")
                if g.get("id") in group_ids:
                    err(f"{where}: duplicate group id")
                group_ids.add(g.get("id"))
                if not isinstance(g.get("people"), list):
                    err(f"{where}: 'people' must be a list, got "
                        f"{type(g.get('people')).__name__}")
                    continue
                for pi, p in enumerate(g["people"]):
                    if not isinstance(p, dict):
                        err(f"{where}: person #{pi} must be an object, got "
                            f"{type(p).__name__}")
                        continue
                    who = f"data/people.json: {p.get('name') or '<unnamed>'}"
                    extra = sorted(set(p) - {"name", "title", "photo", "link"})
                    if extra:
                        err(f"{who}: unknown field(s) {extra} — a person is exactly "
                            f"name/title/photo/link (typo?)")
                    for key in ("name", "title", "photo", "link"):
                        if key not in p:
                            err(f"{who}: missing '{key}'")
                    if not (isinstance(p.get("name"), str) and p["name"].strip()):
                        err(f"{who}: 'name' must be a non-empty string")
                    if not isinstance(p.get("title"), str):
                        err(f"{who}: 'title' must be a string (\"\" is allowed)")
                    photo = p.get("photo")
                    if photo is not None:
                        if not isinstance(photo, str) or not photo.startswith("https://"):
                            err(f"{who}: 'photo' must be null or an https URL")
                        elif resolve_public_id(photo, cloud, public_ids) is None:
                            err(f"{who}: photo is not in data/cloudinary-manifest.json: "
                                f"{photo} — upload it and refresh the manifest")
                    link = p.get("link")
                    if link is not None and not (isinstance(link, str)
                                                 and link.startswith(("http://", "https://"))):
                        err(f"{who}: 'link' must be null or an http(s) URL")

    asset_dir = ROOT / "assets"
    always_used = {(asset_dir / "hippo.svg").resolve()}
    for a in sorted(asset_dir.rglob("*")):
        # a manifest source counts as used: kept originals are upload sources
        # and the local fallback, not orphans.
        if a.is_file() and a.resolve() not in used_assets | always_used | manifest_sources:
            err(f"orphan asset (nothing references it): {a.relative_to(ROOT)}")

    # ---- 6b. content hygiene: no credentials or personal data, ever ----
    email_ok = EMAIL_OK
    for md in md_files:
        rel = md.relative_to(ROOT)
        for i, line in enumerate(md.read_text(encoding="utf-8").splitlines(), 1):
            m = re.search(r"(?<![A-Za-z0-9_])[\"']?(plain_text_passwd|password|passwd|pwd)[\"']?\s*[:=]\s*[\"']?([^\s\"']+)",
                          line, re.IGNORECASE)
            if m and not m.group(2).startswith(("<", "$")) \
                    and m.group(2).lower() not in ("false", "true", "none", "null"):
                err(f"{rel}:{i}: literal credential value ('{m.group(1)}') — use a <placeholder>")
            if re.search(r"ssh-(rsa|ed25519|ecdsa|dss)\s+[A-Za-z0-9+/=]{30,}", line):
                err(f"{rel}:{i}: real SSH public key material — use <your-ssh-public-key>")
            for em in re.findall(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", line):
                if not email_ok.search(em) and em != "git@github.com":
                    err(f"{rel}:{i}: personal email address '{em}' — do not republish personal data")

    # the same hygiene rules over the JSON side of the site: every registry and
    # graph artifact under data/**/*.json, plus the MCP wiring. A key NAMED like
    # a credential must not carry a literal value ('sha256' is a checksum, not a
    # secret, and never matches).
    json_files = sorted((ROOT / "data").rglob("*.json"))
    if (ROOT / ".mcp.json").exists():
        json_files.append(ROOT / ".mcp.json")
    for jf in json_files:
        rel = jf.relative_to(ROOT)
        try:
            doc = json.loads(jf.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            err(f"{rel}:{e.lineno}:{e.colno}: {e.msg} (strict JSON)")
            continue
        for keypath, key, value in walk_json(doc):
            if SECRET_KEY_RE.search(key) and value.strip() \
                    and not value.startswith(("$", "<")):
                err(f"{rel}: literal credential value at '{keypath}' — use a "
                    f"<placeholder> or a ${{ENV_VAR}} reference")
            for em in EMAIL_RE.findall(value):
                if not email_ok.search(em) and em != "git@github.com":
                    err(f"{rel}: personal email address '{em}' at '{keypath}' — "
                        f"do not republish personal data")

    # ---- 7. shell ----
    index = index_text
    for ref in html_ref_re.findall(index):
        if ref.startswith(("http", "#", "data:")):
            continue
        if not (ROOT / ref).exists():
            err(f"index.html: missing referenced file {ref}")
    marked = ROOT / "js" / "marked.min.js"
    if not marked.exists():
        err("js/marked.min.js missing")
    else:
        digest = hashlib.sha256(marked.read_bytes()).hexdigest()
        if digest != MARKED_SHA256:
            err(f"js/marked.min.js sha256 mismatch ({digest[:12]}…) — if you upgraded marked "
                f"on purpose, update MARKED_SHA256 in tools/check.py and note it in README.md")

    # ---- 8. probes ----
    plist = probes["probes"]
    if len(plist) != 10:
        err(f"search-probes.json: expected exactly 10 probes, found {len(plist)}")
    for p in plist:
        if not (p.get("q") and p.get("expect") and p.get("kind")):
            err(f"search-probes.json: malformed probe {p}")

    # ---- 9. graph: data/graph/** in step with the registries ----
    # Valid JSON is not a valid document: a list/scalar/null root must fail as
    # a reported check, not as an AttributeError traceback inside a helper.
    graph_docs = {"wiki.json": wiki, "summaries.json": summaries,
                  "xref-terms.json": xref, "edges-authored.json": authored,
                  "repos-index.json": repos_index}
    bad_roots = [name for name, doc in graph_docs.items() if not isinstance(doc, dict)]
    for name in bad_roots:
        err(f"{GRAPH}/{name}: top level must be a JSON object, got "
            f"{type(graph_docs[name]).__name__} — re-run the graph build tools")
    if not bad_roots:
        shards = read_repo_shards(ROOT)
        for msg in (check_graph_parity(wiki, setup, projects, tools, org)
                    + check_graph_edges(wiki)
                    + check_graph_summaries(wiki, summaries)
                    + check_graph_shards(org, repos_index, projects, shards)
                    + check_xref_terms(xref, wiki)
                    + check_authored_edges(authored, wiki)):
            err(msg)

    # ---- 10. contributors (optional artifact — absent is fine) ----
    contributors_path = ROOT / "data" / "graph" / "contributors.json"
    contributors = load(f"{GRAPH}/contributors.json") \
        if contributors_path.exists() else None
    if contributors_path.exists() and not isinstance(contributors, dict):
        err(f"{GRAPH}/contributors.json: top level must be a JSON object, got "
            f"{type(contributors).__name__} — re-run tools/build_contributors.py")
    else:
        for msg in check_contributors(contributors, projects):
            err(msg)

    report(site)


def report(site=None):
    if errors:
        print(f"CHECK FAILED — {len(errors)} problem(s):")
        for e in errors:
            print(f"  ✗ {e}")
        sys.exit(1)
    print("check.py: all green")
    print("reminder: URL liveness is checked by tools/check_urls.py — run it when "
          "images, links, or the manifest changed")
    sys.exit(0)


if __name__ == "__main__":
    main()
