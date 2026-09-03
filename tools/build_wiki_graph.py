#!/usr/bin/env python3
"""Build the wiki graph: one node per page, index view, and org repo.

    python3 tools/build_wiki_graph.py [--allow-empty-summaries]
    python3 tools/build_wiki_graph.py --xref-candidates      # review table only
    python3 tools/build_wiki_graph.py --dry-run              # validate, write nothing

Plain python3, stdlib only — no graphify, no network, no new dependencies.

Outputs (all under data/graph/, all deterministic: stable sorts, no timestamps)
  wiki.json         nodes + edges, the graph the site's wiki view reads
  summaries.json    one summary per page/index node, derived or hand-authored
  xref-terms.json   the linkifier allow-list (term -> node id) + its stoplist

Inputs it reads (never writes): data/setup.json, data/projects.json,
data/tools.json, data/site.json, data/org-repos.json, data/graph/repos-index.json,
the content/*.md bodies, and two OVERLAYS a human may author:
data/graph/edges-authored.json ("related" edges) and the "authored" entries of
summaries.json plus the "rejected" list and "stoplist" of xref-terms.json.

PARITY RULE: index nodes (#/, #/projects, #/tools) are landing views, not
content pages, so they are EXCLUDED from the page-kind parity count — the same
rule the search index uses (it indexes 90 pages, not landing views). The page
set here is enumerated exactly as tools/build_search_index.py enumerates it:
71 setup + 15 projects + 3 tools + 1 about = 90.

SURVIVABILITY RULE: every overlay keys on page node ids, which are the registry
ids. So a tools/rst_convert.py re-run either changes nothing, or this build
FAILS BY NAME ("unknown id — did rst_convert.py rename a page?") — an overlay
can never silently detach from the page it was written for.

Failure policy — loud, never silent. Any unresolvable route, unknown edge
endpoint, authored entry for an unknown id, missing "why", or a repos-index
that no longer matches org-repos aborts the run (exit 1) naming the offender.
Empty derived summaries are written to the file (so they can be reviewed) but
still exit 1 unless --allow-empty-summaries is passed.
"""
import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_search_index import excerpt  # noqa: E402  (hoisted to module level for this)

ROOT = Path(__file__).resolve().parent.parent
GRAPH_DIR = "data/graph"

GENERATED = "run tools/build_wiki_graph.py to regenerate"
PARITY_NOTE = (
    "Index nodes (#/, #/projects, #/tools) are landing views, not content pages: "
    "they are EXCLUDED from the page-kind parity count — the same rule the search "
    "index uses (it indexes 90 pages, not landing views). Edges: 'links-to' is an "
    "explicit #/ link, 'member' a project's repository, 'mentions' a word-boundary "
    "name match in prose (code stripped; terms that spray — stoplisted, vetoed, or "
    "matching more than 15 pages — are muted), 'related' a hand-authored edge from "
    "data/graph/edges-authored.json."
)
SUMMARY_NOTE = (
    "One summary per page and index node. source 'derived' is regenerated on every "
    "run (first prose paragraph via tools/build_search_index.py excerpt(); projects "
    "and tools fall back to their tagline); source 'authored' is written by hand and "
    "is NEVER overwritten. An authored id that no longer names a node fails the build."
)
XREF_NOTE = (
    "Allow-list for the client-side cross-reference linkifier: term -> node id. "
    "Candidates are page titles and org repo names only. A term is dropped when it "
    "is in the stoplist, is a single token shorter than 6 characters (unless it "
    "contains '_' or is camelCase), matches the prose of more than 15 pages, is "
    "ambiguous (the same string names two nodes), or is a prefix/suffix of a longer "
    "term with the same target. 'rejected' is the human veto list: it is preserved "
    "across runs and its terms are never re-added. 'stoplist' is authoritative once "
    "written — delete the key to reseed it from the built-in default. Longest-match-"
    "first is the client's job; this file is just the map."
)

XREF_MIN_LEN = 6
XREF_MAX_PAGES = 15
SUSPICIOUS_MIN_CHARS = 40

# word characters for term boundaries: '_' and '-' bind, so 'hippo_control'
# does not match inside 'hippo_control_msgs'
WORD_CHARS = r"A-Za-z0-9_\-"

ADMONITION_WORDS = frozenset({
    "note", "notes", "warning", "warnings", "tip", "tips", "caution", "danger",
    "important", "hint", "attention", "todo", "see", "seealso",
})

# Generic English and generic-documentation words that must never become links.
DEFAULT_STOPLIST = [
    "a", "about", "an", "and", "are", "as", "at", "be", "build", "by",
    "calibration", "client", "concept", "concepts", "config", "configuration",
    "deploy", "deployment", "design", "doc", "docs", "documentation", "for",
    "from", "general", "general information", "guide", "guides", "hardware",
    "home", "in", "index", "information", "install", "installation", "is", "it",
    "misc", "note", "notes", "of", "on", "or", "overview", "package", "packages",
    "page", "pages", "projects", "readme", "repositories", "repository", "run",
    "server", "setup", "software", "start", "started", "system", "test", "tests",
    "that", "the", "this", "to", "tool", "tools", "usage", "use", "using",
    "with",
]


class BuildError(Exception):
    """A validation failure that must abort the run, naming the offender."""


def _out(stream):
    return stream if stream is not None else sys.stdout


# --------------------------------------------------------------------------
# registries
# --------------------------------------------------------------------------
def read_json(root, rel):
    p = Path(root) / rel
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise BuildError(f"{rel}: missing")
    except json.JSONDecodeError as e:
        raise BuildError(f"{rel}:{e.lineno}:{e.colno}: {e.msg} (strict JSON)")


def read_json_optional(root, rel):
    p = Path(root) / rel
    if not p.exists():
        return None
    return read_json(root, rel)


def load_registries(root):
    reg = {
        "site": read_json(root, "data/site.json"),
        "setup": read_json(root, "data/setup.json"),
        "projects": read_json(root, "data/projects.json"),
        "tools": read_json(root, "data/tools.json"),
        "org": read_json(root, "data/org-repos.json"),
        "repos_index": read_json(root, f"{GRAPH_DIR}/repos-index.json"),
    }
    org, idx = reg["org"], reg["repos_index"]["repos"]
    if len(org) != len(idx):
        raise BuildError(
            f"{GRAPH_DIR}/repos-index.json has {len(idx)} rows but data/org-repos.json "
            f"has {len(org)} — re-run tools/build_repo_graphs.py")
    # Equal length is not parity: a duplicated row can mask an omitted repo, and a
    # duplicate would become a duplicate `repo:<name>` node id. Compare the full
    # name multisets, both ways, before any node is built.
    idx_names = [r["name"] for r in idx]
    dupes = sorted({n for n in idx_names if idx_names.count(n) > 1})
    if dupes:
        raise BuildError(
            f"{GRAPH_DIR}/repos-index.json lists repos more than once: {dupes} — "
            f"re-run tools/build_repo_graphs.py")
    org_names = {r["name"] for r in org}
    if len(org_names) != len(org):
        raise BuildError("data/org-repos.json lists a repo more than once")
    unknown = sorted(set(idx_names) - org_names)
    if unknown:
        raise BuildError(
            f"{GRAPH_DIR}/repos-index.json names repos that are not org repos: {unknown}")
    missing = sorted(org_names - set(idx_names))
    if missing:
        raise BuildError(
            f"{GRAPH_DIR}/repos-index.json is missing org repos: {missing} — "
            f"re-run tools/build_repo_graphs.py")
    return reg


# --------------------------------------------------------------------------
# nodes
# --------------------------------------------------------------------------
def page_rows(root, reg):
    """The 90 content pages, enumerated exactly as build_search_index does."""
    root = Path(root)
    rows = []
    for sec in reg["setup"]["sections"]:
        for p in sec["pages"]:
            rows.append({"id": f"setup/{p['id']}", "kind": "setup", "title": p["title"],
                         "route": f"#/setup/{p['id']}", "where": f"Setup · {sec['title']}",
                         "file": p["file"], "tagline": ""})
    for pr in reg["projects"]["projects"]:
        rows.append({"id": f"projects/{pr['id']}", "kind": "project", "title": pr["name"],
                     "route": f"#/projects/{pr['id']}", "where": "Project",
                     "file": pr["file"], "tagline": pr.get("tagline", "")})
    for t in reg["tools"]["tools"]:
        rows.append({"id": f"tools/{t['id']}", "kind": "tool", "title": t["name"],
                     "route": f"#/tools/{t['id']}", "where": "Agent tool",
                     "file": t["file"], "tagline": t.get("tagline", "")})
    rows.append({"id": "about", "kind": "about", "title": "About this site",
                 "route": "#/about", "where": "About", "file": "content/about.md",
                 "tagline": ""})
    seen = set()
    for r in rows:
        if r["id"] in seen:
            raise BuildError(f"duplicate page node id '{r['id']}'")
        seen.add(r["id"])
        f = root / r["file"]
        if not f.exists():
            raise BuildError(f"{r['id']}: missing body file {r['file']}")
        r["text"] = f.read_text(encoding="utf-8")
        r["prose"] = prose_text(r["text"])
    return rows


def index_rows(reg):
    return [
        {"id": "index:home", "kind": "index", "title": "Home", "route": "#/",
         "summary": (reg["site"].get("lead") or "").strip()},
        {"id": "index:projects", "kind": "index", "title": "Projects",
         "route": "#/projects", "summary": (reg["projects"].get("intro") or "").strip()},
        {"id": "index:tools", "kind": "index", "title": "Agent tools",
         "route": "#/tools", "summary": (reg["tools"].get("intro") or "").strip()},
    ]


def repo_rows(reg):
    org = {r["name"]: r for r in reg["org"]}
    rows = []
    for r in reg["repos_index"]["repos"]:
        name = r["name"]
        rows.append({"id": f"repo:{name}", "kind": "repo", "title": name,
                     "url": org[name]["url"], "summary": r.get("oneliner", ""),
                     "fork": bool(r.get("fork")), "project": r.get("project", "")})
    return rows


def assemble_nodes(pages, indexes, repos, summaries):
    nodes = []
    for p in pages:
        nodes.append({"id": p["id"], "kind": p["kind"], "title": p["title"],
                      "route": p["route"], "where": p["where"],
                      "summary": summaries[p["id"]]["summary"], "file": p["file"]})
    for i in indexes:
        nodes.append({"id": i["id"], "kind": "index", "title": i["title"],
                      "route": i["route"], "summary": summaries[i["id"]]["summary"]})
    nodes.extend(repos)
    return sorted(nodes, key=lambda n: n["id"])


# --------------------------------------------------------------------------
# prose
# --------------------------------------------------------------------------
def prose_text(md_text):
    """Human-readable prose of a Markdown body, whitespace-normalised.

    Removed: fenced code blocks, inline code spans, HTML comments and tags, and
    link/image DESTINATIONS (the label is kept — a URL is not prose, and leaving
    it in made every internal link also mention its own target's title).
    Headings are kept: a heading is prose a reader sees.
    """
    kept, fence = [], None
    for line in md_text.splitlines():
        stripped = line.strip()
        if fence:
            if stripped.startswith(fence):
                fence = None
            continue
        if stripped.startswith("```") or stripped.startswith("~~~"):
            fence = stripped[:3]
            continue
        kept.append(line)
    text = "\n".join(kept)
    text = re.sub(r"<!--.*?-->", " ", text, flags=re.S)
    text = re.sub(r"`[^`]*`", " ", text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"!?\[([^\]]*)\]\([^)\s]*(?:\s+[^)]*)?\)", r"\1", text)
    return re.sub(r"\s+", " ", text).strip()


def term_regex(term, case_sensitive):
    flags = 0 if case_sensitive else re.IGNORECASE
    return re.compile(rf"(?<![{WORD_CHARS}]){re.escape(term)}(?![{WORD_CHARS}])", flags)


_TERM_CACHE = {}


def term_matches(term, case_sensitive, prose):
    key = (term, case_sensitive)
    rx = _TERM_CACHE.get(key)
    if rx is None:
        rx = _TERM_CACHE[key] = term_regex(term, case_sensitive)
    return rx.search(prose) is not None


# --------------------------------------------------------------------------
# edges
# --------------------------------------------------------------------------
# '#/' alone is the home route, so the tail may be empty
ROUTE_MD_RE = re.compile(r"\]\((#/[^)\s]*)\)")
ROUTE_HTML_RE = re.compile(r'(?:src|href)="(#/[^"]*)"')

# routes that are real views but own no node (there is no index node for the
# setup landing view, and search is a query, not a page)
NODELESS = {"setup landing view", "search view"}


def find_routes(md_text):
    return ROUTE_MD_RE.findall(md_text) + ROUTE_HTML_RE.findall(md_text)


def route_to_id(route):
    """(node id, None) | (None, reason it owns no node); raises on unknown routes."""
    clean = route.split("@")[0].split("?")[0]
    seg = [s for s in clean.lstrip("#/").split("/") if s]
    if not seg:
        return "index:home", None
    head = seg[0]
    if head == "search":
        return None, "search view"
    if head == "about":
        return "about", None
    if head == "setup":
        if len(seg) == 1:
            return None, "setup landing view"
        return "setup/" + "/".join(seg[1:]), None
    if head == "projects":
        return ("index:projects" if len(seg) == 1 else f"projects/{seg[1]}"), None
    if head == "tools":
        return ("index:tools" if len(seg) == 1 else f"tools/{seg[1]}"), None
    raise BuildError(f"unknown route {route}")


def resolve_route(route, node_ids, where):
    try:
        nid, reason = route_to_id(route)
    except BuildError as e:
        raise BuildError(f"{where}: {e}")
    if nid is None:
        return None
    if nid not in node_ids:
        raise BuildError(f"{where}: link {route} resolves to '{nid}', which is not a node "
                         f"(check.py should have caught this — is a registry stale?)")
    return nid


def links_to_edges(pages, reg, node_ids):
    edges = []
    for p in pages:
        for route in find_routes(p["text"]):
            target = resolve_route(route, node_ids, p["file"])
            if target:
                edges.append({"s": p["id"], "t": target, "type": "links-to",
                              "why": "explicit link"})
    for pr in reg["projects"]["projects"]:
        for link in pr.get("links", []):
            href = link.get("href", "")
            if not href.startswith("#/"):
                continue
            target = resolve_route(href, node_ids, f"projects.json:{pr['id']}")
            if target:
                edges.append({"s": f"projects/{pr['id']}", "t": target,
                              "type": "links-to", "why": "see-also link"})
    return edges


def tool_repo_names(tool, org_names):
    """Org repos a tool entry names. tools.json has no repos[] field today, so
    only an exact chip match counts; a future repos[] is picked up unchanged."""
    names = []
    for r in tool.get("repos", []):
        names.append(r["name"] if isinstance(r, dict) else r)
    names.extend(tool.get("chips", []))
    return [n for n in names if n in org_names]


def member_edges(reg, node_ids):
    edges = []
    for pr in reg["projects"]["projects"]:
        for r in pr["repos"]:
            if r.get("external"):
                continue
            edges.append({"s": f"projects/{pr['id']}", "t": f"repo:{r['name']}",
                          "type": "member", "why": r.get("role") or "member repo"})
    org_names = {r["name"] for r in reg["org"]}
    for t in reg["tools"]["tools"]:
        for name in tool_repo_names(t, org_names):
            edges.append({"s": f"tools/{t['id']}", "t": f"repo:{name}",
                          "type": "member", "why": "repo behind this tool"})
    for e in edges:
        if e["t"] not in node_ids:
            raise BuildError(f"member edge {e['s']} -> {e['t']}: no such repo node "
                             f"(data/org-repos.json and projects.json disagree)")
    return edges


def mention_repo_terms(repo_names, prose_by_page, stoplist, rejected):
    """Repo names usable as mention terms, minus the SPRAY filters only.

    The org owns repos called 'docs', 'hardware', 'camera', 'control' — plain
    English words that otherwise wire nearly every page to one repo node (74
    pages "mention" the docs repo). So a repo name is dropped here when it is
    stoplisted, human-vetoed, or matches more than XREF_MAX_PAGES pages. The
    xref MIN-LENGTH and prefix/suffix rules deliberately do NOT apply: 'esc',
    'dvl' and 'uvms' are real names in prose even though they are too short to
    linkify safely. Both knobs live in data/graph/xref-terms.json, so tuning
    this is a data edit, never a code edit.
    """
    stop = {w.casefold() for w in stoplist}
    veto = set(rejected)
    kept, dropped = [], []
    for name in sorted(repo_names):
        if name.casefold() in stop or name in veto:
            dropped.append((name, "stoplist/rejected"))
            continue
        hits = sum(1 for prose in prose_by_page.values()
                   if term_matches(name, True, prose))
        if hits > XREF_MAX_PAGES:
            dropped.append((name, f"matches {hits} pages"))
            continue
        kept.append(name)
    return kept, dropped


def mentions_edges(pages, repo_names, title_terms):
    """repo names: exact and case-sensitive. page titles: case-insensitive.
    Both term sets have already been through the spray filters."""
    edges = []
    repo_terms = sorted((n, f"repo:{n}", True) for n in repo_names)
    page_terms = sorted((t, target, False) for t, target in title_terms.items())
    for p in pages:
        for term, target, case_sensitive in repo_terms + page_terms:
            if target == p["id"]:
                continue
            if term_matches(term, case_sensitive, p["prose"]):
                edges.append({"s": p["id"], "t": target, "type": "mentions",
                              "why": f"mentions “{term}”"})
    return edges


def load_authored_edges(root, out=None):
    doc = read_json_optional(root, f"{GRAPH_DIR}/edges-authored.json")
    if doc is None:
        print(f"  !! no authored edges overlay yet ({GRAPH_DIR}/edges-authored.json) — "
              f"0 'related' edges", file=_out(out))
        return {"note": "", "edges": []}
    return doc


def related_edges(overlay, node_ids):
    edges = []
    for i, e in enumerate(overlay.get("edges", [])):
        where = f"{GRAPH_DIR}/edges-authored.json[{i}]"
        for side in ("s", "t"):
            if not e.get(side):
                raise BuildError(f"{where}: authored edge has no '{side}'")
            if e[side] not in node_ids:
                raise BuildError(f"{where}: authored edge endpoint '{e[side]}' is not a "
                                 f"node id — did rst_convert.py rename a page?")
        if not (e.get("why") or "").strip():
            raise BuildError(f"{where}: authored edge {e['s']} -> {e['t']} has no 'why' "
                             f"(every related edge must say why in one line)")
        edges.append({"s": e["s"], "t": e["t"], "type": "related", "why": e["why"]})
    return edges


def finalize_edges(edges, node_ids):
    """Drop self-edges, dedupe on (type, s, t), sort, validate every endpoint."""
    seen, out_edges, self_edges = set(), [], 0
    for e in edges:
        if e["s"] == e["t"]:
            self_edges += 1
            continue
        key = (e["type"], e["s"], e["t"])
        if key in seen:
            continue
        seen.add(key)
        out_edges.append(e)
    for e in out_edges:
        for side in ("s", "t"):
            if e[side] not in node_ids:
                raise BuildError(f"edge {e['type']} {e['s']} -> {e['t']} ({e['why']}): "
                                 f"endpoint '{e[side]}' is not a node id")
    out_edges.sort(key=lambda e: (e["type"], e["s"], e["t"]))
    return out_edges, self_edges


# --------------------------------------------------------------------------
# summaries
# --------------------------------------------------------------------------
def derive_summaries(pages, indexes):
    """id -> (summary, how it was derived)."""
    derived = {}
    for p in pages:
        text = excerpt(p["text"])
        if p["kind"] in ("project", "tool") and not text:
            derived[p["id"]] = (p["tagline"].strip(), "tagline")
        else:
            derived[p["id"]] = (text, "excerpt")
    for i in indexes:
        derived[i["id"]] = (i["summary"], "registry")
    return derived


def merge_summaries(existing, derived, node_ids):
    """(document, authored ids, ids whose final summary is empty)."""
    pages = {}
    authored = []
    for nid, entry in (existing or {}).get("pages", {}).items():
        if entry.get("source") != "authored":
            continue          # a stale derived entry is simply regenerated
        if nid not in node_ids:
            raise BuildError(f"{GRAPH_DIR}/summaries.json: authored entry for unknown id "
                             f"'{nid}' — did rst_convert.py rename a page?")
        pages[nid] = {"summary": entry.get("summary", ""), "source": "authored"}
        authored.append(nid)
    for nid, (summary, _how) in derived.items():
        if nid in pages:
            continue
        pages[nid] = {"summary": summary, "source": "derived"}
    doc = {"note": SUMMARY_NOTE, "generated": GENERATED,
           "pages": {k: pages[k] for k in sorted(pages)}}
    empty = sorted(k for k, v in doc["pages"].items() if not v["summary"].strip())
    return doc, sorted(authored), empty


def summary_flags(page, summary, how):
    """Why a derived summary looks unusable to a human reviewer."""
    flags = []
    s = summary.strip()
    if not s:
        return ["empty"]
    if len(s) < SUSPICIOUS_MIN_CHARS:
        flags.append(f"under {SUSPICIOUS_MIN_CHARS} chars")
    if not s[0].isalpha():
        flags.append("starts with a non-letter")
    first = re.split(r"[^A-Za-z]+", s, maxsplit=1)[0].lower()
    if first in ADMONITION_WORDS:
        flags.append("reads like an admonition/instruction fragment")
    if how == "tagline":
        flags.append("tagline fallback (page body has no lead paragraph)")
    return flags


def suspicious_summaries(pages, derived, summaries_doc):
    """Rows for the human review pass: only pages still on a DERIVED summary."""
    rows = []
    for p in pages:
        entry = summaries_doc["pages"][p["id"]]
        if entry["source"] != "derived":
            continue
        flags = summary_flags(p, entry["summary"], derived[p["id"]][1])
        if flags:
            rows.append({"id": p["id"], "title": p["title"], "kind": p["kind"],
                         "file": p["file"], "summary": entry["summary"],
                         "flags": flags, "head": p["text"].strip()[:300]})
    return rows


# --------------------------------------------------------------------------
# xref terms
# --------------------------------------------------------------------------
def is_camel_case(term):
    return re.search(r"[a-z][A-Z]", term) is not None


def filter_candidates(candidates, prose_by_page, stoplist, rejected):
    """Apply the hard filters. -> (kept rows, [(term, why, target), ...]).

    candidates: (term, target node id, case_sensitive) triples.
    """
    stop = {s.casefold() for s in stoplist}
    veto = {s for s in rejected}
    dropped = []
    rows = []

    by_term = {}
    for term, target, case_sensitive in candidates:
        by_term.setdefault(term, []).append((target, case_sensitive))
    for term in sorted(by_term):
        targets = by_term[term]
        distinct = sorted({t for t, _ in targets})
        if term.casefold() in stop:
            dropped.append((term, "stoplist", distinct[0]))
            continue
        if term in veto:
            dropped.append((term, "rejected by review", distinct[0]))
            continue
        if (" " not in term and len(term) < XREF_MIN_LEN
                and "_" not in term and not is_camel_case(term)):
            dropped.append((term, f"shorter than {XREF_MIN_LEN} characters", distinct[0]))
            continue
        if len(distinct) > 1:
            dropped.append((term, f"ambiguous ({len(distinct)} targets: "
                                  f"{', '.join(distinct)})", distinct[0]))
            continue
        target, case_sensitive = targets[0]
        pages = sorted(pid for pid, prose in prose_by_page.items()
                       if term_matches(term, case_sensitive, prose))
        if len(pages) > XREF_MAX_PAGES:
            dropped.append((term, f"matches {len(pages)} pages (> {XREF_MAX_PAGES})",
                            target))
            continue
        rows.append({"term": term, "target": target, "case_sensitive": case_sensitive,
                     "pages": pages})

    survivors = {r["term"]: r["target"] for r in rows}
    kept = []
    for r in rows:
        longer = [o for o, t in survivors.items()
                  if o != r["term"] and t == r["target"]
                  and (o.startswith(r["term"]) or o.endswith(r["term"]))]
        if longer:
            dropped.append((r["term"], f"prefix/suffix of {longer[0]} (same target)",
                            r["target"]))
            continue
        kept.append(r)
    # A linkifier cannot honour 'Gantry' -> the page and 'gantry' -> the repo at
    # the same time, so one term per casefolded spelling survives: the page wins.
    by_fold = {}
    for r in kept:
        by_fold.setdefault(r["term"].casefold(), []).append(r)
    winners = []
    for fold in sorted(by_fold):
        group = sorted(by_fold[fold],
                       key=lambda r: (r["target"].startswith("repo:"), r["term"]))
        winners.append(group[0])
        for loser in group[1:]:
            dropped.append((loser["term"],
                            f"case-insensitive duplicate of {group[0]['term']}",
                            loser["target"]))
    kept = winners
    kept.sort(key=lambda r: (r["term"].casefold(), r["term"]))
    dropped.sort(key=lambda d: (d[0].casefold(), d[0]))
    return kept, dropped


def xref_candidates(pages, repo_names):
    cands = [(p["title"], p["id"], False) for p in pages]
    cands += [(n, f"repo:{n}", True) for n in sorted(repo_names)]
    return cands


def render_candidates(rows, dropped, stoplist):
    lines = ["# xref candidates (post-filter)", "",
             "Generated by `python3 tools/build_wiki_graph.py --xref-candidates`. "
             "Candidates are page titles and org repo names. Everything below "
             "SURVIVED the hard filters; move a term into `rejected` in "
             "`data/graph/xref-terms.json` to veto it for good.", "",
             f"Filters: stoplist ({len(stoplist)} words), single tokens under "
             f"{XREF_MIN_LEN} characters (unless they carry '_' or are camelCase), "
             f"terms matching more than {XREF_MAX_PAGES} pages, ambiguous terms, and "
             "prefix/suffix duplicates of the same target.", "",
             f"**{len(rows)} terms survived, {len(dropped)} were dropped.**", "",
             "## Surviving terms", "",
             "term → target — pages matched", ""]
    for r in rows:
        pages = ", ".join(r["pages"]) if r["pages"] else "(no current match)"
        n = len(r["pages"])
        lines.append(f"- `{r['term']}` → `{r['target']}` — "
                     f"{n} page{'' if n == 1 else 's'}: {pages}")
    lines += ["", "## Dropped", ""]
    for term, why, target in dropped:
        lines.append(f"- `{term}` → `{target}` — {why}")
    lines.append("")
    return "\n".join(lines)


# --------------------------------------------------------------------------
# build
# --------------------------------------------------------------------------
def dump_json(obj):
    return json.dumps(obj, indent=1, ensure_ascii=False) + "\n"


def build_all(root=None, out=None):
    root = Path(root) if root is not None else ROOT
    stream = _out(out)
    reg = load_registries(root)
    pages = page_rows(root, reg)
    indexes = index_rows(reg)
    repos = repo_rows(reg)
    node_ids = ({p["id"] for p in pages} | {i["id"] for i in indexes}
                | {r["id"] for r in repos})

    derived = derive_summaries(pages, indexes)
    existing_summaries = read_json_optional(root, f"{GRAPH_DIR}/summaries.json")
    summaries, authored_ids, empty_ids = merge_summaries(
        existing_summaries, derived, node_ids)
    nodes = assemble_nodes(pages, indexes, repos, summaries["pages"])

    prose_by_page = {p["id"]: p["prose"] for p in pages}
    existing_xref = read_json_optional(root, f"{GRAPH_DIR}/xref-terms.json") or {}
    stoplist = existing_xref.get("stoplist")
    if stoplist is None:
        stoplist = list(DEFAULT_STOPLIST)
    rejected = list(existing_xref.get("rejected", []))
    repo_names = [r["title"] for r in repos]
    kept, dropped = filter_candidates(
        xref_candidates(pages, repo_names), prose_by_page, stoplist, rejected)
    terms = {r["term"]: r["target"] for r in kept}
    for term, target in terms.items():
        if target not in node_ids:
            raise BuildError(f"xref term '{term}' targets '{target}', which is not a node")
    xref = {"note": XREF_NOTE, "generated": GENERATED,
            "stoplist": stoplist, "terms": terms, "rejected": rejected}

    title_terms = {t: target for t, target in terms.items()
                   if not target.startswith("repo:")}
    mention_repos, muted = mention_repo_terms(repo_names, prose_by_page, stoplist, rejected)
    for name, why in muted:
        print(f"  -- repo name '{name}' muted for 'mentions' edges: {why}", file=stream)
    edges = (links_to_edges(pages, reg, node_ids)
             + member_edges(reg, node_ids)
             + mentions_edges(pages, mention_repos, title_terms)
             + related_edges(load_authored_edges(root, stream), node_ids))
    edges, self_edges = finalize_edges(edges, node_ids)
    if self_edges:
        print(f"  -- dropped {self_edges} self-edge(s) (a page linking to itself)",
              file=stream)

    counts = {"pages": len(pages), "index": len(indexes), "repos": len(repos),
              "edges": {t: len([e for e in edges if e["type"] == t])
                        for t in ("links-to", "member", "mentions", "related")}}
    graph = {"generated": GENERATED, "note": PARITY_NOTE, "counts": counts,
             "nodes": nodes, "edges": edges}
    return {"graph": graph, "summaries": summaries, "xref": xref,
            "candidates": kept, "dropped": dropped, "authored_ids": authored_ids,
            "empty_ids": empty_ids,
            "suspicious": suspicious_summaries(pages, derived, summaries),
            "pages": pages, "root": root}


def main(argv=None, root=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--allow-empty-summaries", action="store_true",
                    help="write empty derived summaries without failing the run")
    ap.add_argument("--xref-candidates", action="store_true",
                    help="print the post-filter candidate table and write nothing")
    ap.add_argument("--dry-run", action="store_true",
                    help="validate and report, write nothing")
    args = ap.parse_args(argv)

    stream = sys.stderr if args.xref_candidates else sys.stdout
    try:
        r = build_all(root, out=stream)
    except BuildError as e:
        print(f"FAIL: {e}", file=sys.stderr)
        return 1

    if args.xref_candidates:
        print(render_candidates(r["candidates"], r["dropped"], r["xref"]["stoplist"]))
        return 0

    g = r["graph"]
    c = g["counts"]
    print(f"nodes: {len(g['nodes'])} ({c['pages']} pages + {c['index']} index views "
          f"+ {c['repos']} repos; index views are excluded from the page parity count)")
    print(f"edges: {len(g['edges'])} " + ", ".join(f"{k}={v}" for k, v in c["edges"].items()))
    print(f"xref: {len(r['xref']['terms'])} terms kept, {len(r['dropped'])} dropped, "
          f"{len(r['xref']['rejected'])} rejected by review")

    if not args.dry_run:
        out_dir = Path(r["root"]) / GRAPH_DIR
        out_dir.mkdir(parents=True, exist_ok=True)
        for name, doc in (("wiki.json", g), ("summaries.json", r["summaries"]),
                          ("xref-terms.json", r["xref"])):
            p = out_dir / name
            p.write_text(dump_json(doc), encoding="utf-8")
            print(f"  wrote {GRAPH_DIR}/{name} ({len(p.read_bytes())} bytes)")
    else:
        print("  -- dry run: nothing written")

    print(f"authored summaries preserved: {len(r['authored_ids'])}"
          + (f" ({', '.join(r['authored_ids'])})" if r["authored_ids"] else ""))
    if r["suspicious"]:
        print(f"  !! {len(r['suspicious'])} derived summaries need a human look "
              f"(empty or suspicious) — run the review pass")
    if r["empty_ids"]:
        print(f"  !! {len(r['empty_ids'])} EMPTY summaries:")
        for nid in r["empty_ids"]:
            print(f"       {nid}")
        if not args.allow_empty_summaries:
            print("FAIL: empty summaries — author an override in "
                  f"{GRAPH_DIR}/summaries.json (source: \"authored\") or re-run with "
                  "--allow-empty-summaries", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
