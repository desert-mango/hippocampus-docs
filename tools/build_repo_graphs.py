#!/usr/bin/env python3
"""Build the committed semantic-graph shards for the org's repositories.

Run under graphify's interpreter (its AST extraction does the code parsing):

    uv tool run --from graphifyy python tools/build_repo_graphs.py \
        --clones-dir ~/code/hippocampus-graphify/clones

Pipeline, per NON-FORK org repo (79 of the 94 rows in data/org-repos.json):

    shallow clone/update  ->  graphify collect_files + extract (AST only)
      ->  build_from_json  ->  cluster (Leiden, seeded)  ->  to_json
      ->  condense to a <= 20 KB committed shard

There is NO LLM step and no API key anywhere in this pipeline: every number
below comes from the AST and from deterministic graph maths.

Outputs
  LOCAL ONLY, never committed (they live outside this repo):
    <clones-dir>/<repo>/                    shallow single-branch clone
    <graphs-dir>/<repo>/graph.json          raw graphify graph
  COMMITTED, in this repo:
    data/graph/repo-<repo>.json             condensed shard (<= 20 KB)
    data/graph/repos-index.json             one row per ALL 94 org repos

Failure policy — loud, never silent:
  * The 7 repos in KNOWN_EMPTY_REPOS have no code files at all; they get a
    stub shard carrying "stub": true and the reason.
  * ANY other repo that extracts to zero nodes, or that raises while being
    extracted, ABORTS the whole run with a message naming the repo (exit 1).
  * Shrinking a shard to fit the cap prints every drop.

Determinism: no "generated at now" timestamps, no randomness. graphify's
partitioner is seeded (seed=42) and canonicalises its edge order, and every
sort here is a total order, so a rerun over unchanged clones is byte-identical.
All graphify imports are FUNCTION-LOCAL so the pure half of this module (and
its unit tests, tools/tests/test_build_repo_graphs.py) imports under plain
python3 with no dependencies at all.
"""
import argparse
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "graph"

DEFAULT_CLONES_DIR = Path.home() / "code" / "hippocampus-graphify" / "clones"
DEFAULT_GRAPHS_DIR = Path.home() / "code" / "hippocampus-graphify" / "graphs"

MAX_SHARD_BYTES = 20 * 1024      # 20 KB per committed shard, serialized compact
GOD_NODE_TOP = 10                # highest-degree real entities kept per repo
COMMUNITY_TOP = 6                # largest communities kept per repo
COMMUNITY_MEMBERS_TOP = 8        # member names kept per community

INDEX_GENERATED = "run tools/build_repo_graphs.py to regenerate"

# Repos with no parseable code at all — verified by inspection. They are real
# org repos (message definitions, PCB artifacts, infra manifests), so they get a
# shard, but an honest empty one rather than a fabricated graph.
KNOWN_EMPTY_REPOS = frozenset({
    "apriltags",
    "hippo_infrastructure",
    "hippo_robot",
    "hippocampus_msgs",
    "hippocampus_pcbs",
    "scalar_field_interfaces",
    "sdr_msgs",
})
KNOWN_EMPTY_REASON = "no code files (AST-empty by inspection)"

# Build/vendor directories that are not this repo's own source.
SKIP_DIRS = {".git", "node_modules", "build", "install", "log", "__pycache__",
             "graphify-out"}

# --- god-node exclusion policy -------------------------------------------
# A faithful port of graphify.analyze.god_nodes' own filter, so "god node"
# here means what it means upstream: the most-connected REAL abstractions.
# Without it every repo's top ten would be its file list, because file hub
# nodes accumulate contains/import edges mechanically.
BUILTIN_NOISE_LABELS = frozenset({
    "str", "int", "float", "bool", "bytes", "bytearray", "complex", "object",
    "True", "False",
    "MagicMock", "Mock", "AsyncMock", "NonCallableMock",
    "NonCallableMagicMock", "PropertyMock", "patch", "sentinel",
    "Path", "Any", "Optional", "List", "Dict", "Set", "Tuple", "Union",
    "Callable", "Type", "ClassVar", "Final", "Literal", "Protocol",
    "Counter", "defaultdict", "OrderedDict", "datetime", "Enum",
    "os", "sys", "re", "json", "io", "abc", "typing",
    "Foundation", "SwiftUI", "UIKit", "AppKit", "Combine",
    "String", "Int", "Double", "Float", "Bool", "Data", "URL", "Date", "UUID",
    "Sendable", "Codable", "Decodable", "Encodable", "Equatable", "Hashable",
    "Identifiable", "Comparable", "AnyObject", "Error", "LocalizedError",
    "NSObject", "NSString", "NSError", "NSLock",
    "View", "Color", "Font", "DispatchQueue",
})
JSON_NOISE_LABELS = frozenset({
    "start", "end", "name", "id", "type", "properties",
    "value", "key", "data", "items", "title", "description", "version",
    "dependencies", "devdependencies", "peerdependencies",
    "optionaldependencies", "bundleddependencies", "bundledependencies",
})


class PipelineAbort(RuntimeError):
    """Anything that must stop the whole run rather than degrade a shard."""


class ExtractionAbort(PipelineAbort):
    """A repo produced no graph, and it is not a known code-less repo."""


# =========================================================================
# pure helpers — no graphify, no network, no filesystem
# =========================================================================
def compact_dump(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def resolve_oneliner(org_row, role=None):
    """The one-liner shown for a repo. Never empty.

    projects.json role -> org-repos.json description -> "<language> repo".
    Measured ground truth: description is empty for all 79 non-forks and role
    is populated for all 79, so the first link carries the non-fork site; the
    later links carry forks and anything the registries stop covering.
    """
    if role and role.strip():
        return role.strip()
    desc = (org_row.get("description") or "").strip()
    if desc:
        return desc
    lang = (org_row.get("primaryLanguage") or {}).get("name")
    lang = (lang or "").strip()
    return f"{lang} repo" if lang else "repo"


def norm_name(label):
    """Display name for a node: '.run()' -> 'run', 'Klass' -> 'Klass'."""
    name = str(label or "").strip()
    if name.startswith("."):
        name = name[1:]
    if name.endswith("()"):
        name = name[:-2]
    return name


def graph_links(raw):
    """graph.json writes 'links'; some node_link writers use 'edges'."""
    links = raw.get("links")
    if links is None:
        links = raw.get("edges")
    return links or []


def node_degrees(nodes, links):
    """Undirected degree per node id, counting only real graph endpoints."""
    ids = {n.get("id") for n in nodes}
    deg = Counter({nid: 0 for nid in ids if nid is not None})
    for link in links:
        for end in (link.get("source"), link.get("target")):
            if end in deg:
                deg[end] += 1
    return deg


def is_file_node(node):
    """Label is the source file's basename, or a dir-qualified suffix of it."""
    label = str(node.get("label") or "")
    src = str(node.get("source_file") or "").replace("\\", "/")
    if not label or not src:
        return False
    if label == src.rsplit("/", 1)[-1]:
        return True
    return "/" in label and (src == label or src.endswith("/" + label))


def node_kind(node):
    if node.get("_callable_class"):
        return "class"
    if node.get("_callable"):
        return "fn"
    if is_file_node(node):
        return "file"
    return "symbol"


def is_god_candidate(node, degree):
    """graphify's own god-node filter, ported (see the policy note above)."""
    label = str(node.get("label") or "")
    src = str(node.get("source_file") or "")
    if not label:
        return False
    if is_file_node(node):
        return False                                   # file hub
    if label.startswith(".") and label.endswith("()"):
        return False                                   # method stub
    if label.endswith("()") and degree <= 1:
        return False                                   # isolated function stub
    if not src:
        return False                                   # injected concept node
    if "." not in src.split("/")[-1]:
        return False                                   # not a real file path
    if src.lower().endswith(".json") and label.strip().lower() in JSON_NOISE_LABELS:
        return False                                   # json key noise
    if label in BUILTIN_NOISE_LABELS:
        return False                                   # builtin / framework name
    return True


def pick_god_nodes(nodes, degrees, top_n=GOD_NODE_TOP):
    rows = []
    for node in nodes:
        nid = node.get("id")
        deg = degrees.get(nid, 0)
        if not is_god_candidate(node, deg):
            continue
        rows.append({"name": norm_name(node.get("label")),
                     "kind": node_kind(node),
                     "path": str(node.get("source_file") or ""),
                     "degree": deg})
    rows.sort(key=lambda r: (-r["degree"], r["name"], r["path"], r["kind"]))
    return rows[:top_n]


def community_label(source_files, cid):
    """Dominant path/module stem of a community's members.

    'src/alpha.py' -> 'src/alpha'. Ties break lexicographically; a community
    whose members carry no source file falls back to 'community-<cid>'. No
    invented semantics: the label is a path that exists in the repo.
    """
    stems = Counter()
    for src in source_files:
        src = str(src or "").replace("\\", "/").strip("/")
        if not src:
            continue
        head, _, tail = src.rpartition("/")
        stem = tail.rsplit(".", 1)[0] if "." in tail else tail
        if not stem:
            continue
        stems[f"{head}/{stem}" if head else stem] += 1
    if not stems:
        return f"community-{cid}"
    return min(stems, key=lambda s: (-stems[s], s))


def summarize_communities(nodes, degrees, top_n=COMMUNITY_TOP,
                          members_top=COMMUNITY_MEMBERS_TOP):
    """Largest communities, each named after its dominant path stem."""
    members = {}
    for node in nodes:
        cid = node.get("community")
        if cid is None:
            continue
        members.setdefault(cid, []).append(node)
    rows = []
    for cid, group in members.items():
        ranked = sorted(group,
                        key=lambda n: (-degrees.get(n.get("id"), 0),
                                       norm_name(n.get("label")),
                                       str(n.get("id"))))
        rows.append({"label": community_label(
                         (n.get("source_file") for n in group), cid),
                     "size": len(group),
                     "top": [norm_name(n.get("label"))
                             for n in ranked[:members_top]]})
    rows.sort(key=lambda r: (-r["size"], r["label"]))
    return rows[:top_n], len(members)


def condense(raw, meta):
    """Raw graphify graph.json dict -> the committed shard (pre-cap)."""
    nodes = raw.get("nodes") or []
    links = graph_links(raw)
    degrees = node_degrees(nodes, links)
    communities, n_communities = summarize_communities(nodes, degrees)
    return {
        "repo": meta["repo"],
        "url": meta["url"],
        "description": meta["description"],
        "language": meta["language"],
        "pushedAt": meta["pushedAt"],
        "counts": {"nodes": len(nodes), "edges": len(links),
                   "communities": n_communities},
        "god_nodes": pick_god_nodes(nodes, degrees),
        "communities": communities,
    }


def stub_shard(meta):
    """Shard for a repo that genuinely has no code to parse."""
    return {
        "repo": meta["repo"],
        "url": meta["url"],
        "description": meta["description"],
        "language": meta["language"],
        "pushedAt": meta["pushedAt"],
        "counts": {"nodes": 0, "edges": 0, "communities": 0},
        "god_nodes": [],
        "communities": [],
        "stub": True,
        "reason": KNOWN_EMPTY_REASON,
    }


def cap_shard(repo, shard, max_bytes=MAX_SHARD_BYTES):
    """Shrink a shard to the cap. Drops community member names first, then the
    smallest communities. god_nodes are never dropped. Every drop is printed."""
    out = dict(shard)
    if len(compact_dump(out).encode()) <= max_bytes:
        return out
    out["communities"] = [dict(c) for c in out["communities"]]
    dropped_members = sum(len(c["top"]) for c in out["communities"])
    for c in out["communities"]:
        c["top"] = []
    print(f"  !! {repo}: over {max_bytes} B — dropped {dropped_members} community "
          f"member names from {len(out['communities'])} communities "
          f"(policy: MAX_SHARD_BYTES)")
    while (len(compact_dump(out).encode()) > max_bytes and out["communities"]):
        gone = out["communities"].pop()          # list is size-descending
        print(f"  !! {repo}: over {max_bytes} B — dropped community "
              f"{gone['label']!r} (size {gone['size']})")
    if len(compact_dump(out).encode()) > max_bytes:
        print(f"  !! {repo}: STILL over {max_bytes} B with communities emptied "
              f"— god_nodes are never dropped; shard written oversized")
    return out


def check_node_count(repo, node_count):
    """Zero nodes is only ever acceptable for the known code-less repos."""
    if node_count > 0:
        return None
    if repo in KNOWN_EMPTY_REPOS:
        return None
    raise ExtractionAbort(
        f"{repo}: extraction produced 0 nodes, and {repo} is not in "
        f"KNOWN_EMPTY_REPOS. Either the clone is broken or the repo genuinely "
        f"lost its code — decide which, then fix the clone or add it to "
        f"KNOWN_EMPTY_REPOS with a reason. No silent stub is written.")


def extraction_failure(repo, exc):
    """Wrap a per-repo exception so the abort names the repo that caused it."""
    return ExtractionAbort(f"{repo}: extraction failed — {type(exc).__name__}: {exc}")


def role_and_project_maps(projects):
    """{repo: role} and {repo: project id} from data/projects.json.

    external:true rows are other people's repos listed for context, not org
    repos, so they are skipped.
    """
    roles, owners = {}, {}
    for project in projects.get("projects", []):
        for row in project.get("repos", []):
            if row.get("external"):
                continue
            name = row.get("name")
            if not name:
                continue
            roles.setdefault(name, (row.get("role") or "").strip())
            owners.setdefault(name, project.get("id"))
    return roles, owners


def build_index_rows(org, projects, shards):
    """One row per org repo, sorted by name. `shards` maps repo -> shard dict."""
    roles, owners = role_and_project_maps(projects)
    rows = []
    for org_row in org:
        name = org_row["name"]
        fork = bool(org_row.get("isFork"))
        # Forks mirror upstream code, so their one-liner comes from GitHub, not
        # from a role this org wrote — but every fork still belongs to exactly
        # one project in data/projects.json (the coverage rule), and the wiki
        # graph's member edges need that ownership for forks too.
        role = None if fork else roles.get(name)
        shard = shards.get(name) or {}
        god = [] if fork else [g["name"] for g in shard.get("god_nodes", [])]
        rows.append({
            "name": name,
            "kind": "repo",
            "fork": fork,
            "oneliner": resolve_oneliner(org_row, role),
            "project": owners.get(name),
            "god_nodes": god,
        })
    rows.sort(key=lambda r: r["name"])
    return rows


def build_index(org, projects, shards):
    return {"generated": INDEX_GENERATED,
            "repos": build_index_rows(org, projects, shards)}


def repo_meta(org_row, role):
    lang = (org_row.get("primaryLanguage") or {}).get("name") or None
    return {"repo": org_row["name"],
            "url": org_row["url"],
            "description": resolve_oneliner(org_row, role),
            "language": lang,
            "pushedAt": org_row.get("pushedAt")}


# =========================================================================
# impure half — git and graphify
# =========================================================================
def _git(args, cwd=None):
    proc = subprocess.run(["git", *args], cwd=str(cwd) if cwd else None,
                          capture_output=True, text=True)
    if proc.returncode != 0:
        raise PipelineAbort(
            f"git {' '.join(args)} failed ({proc.returncode}): "
            f"{proc.stderr.strip() or proc.stdout.strip()}")
    return proc.stdout


def ensure_clone(repo, url, dest, skip_clone):
    """Shallow clone, or shallow-update an existing clone. Returns what it did."""
    if (dest / ".git").exists():
        if skip_clone:
            return "kept"
        _git(["fetch", "--depth", "1", "origin", "HEAD"], cwd=dest)
        _git(["reset", "--hard", "FETCH_HEAD"], cwd=dest)
        return "updated"
    if dest.exists():
        raise PipelineAbort(f"{repo}: {dest} exists but is not a git clone")
    if skip_clone:
        raise PipelineAbort(
            f"{repo}: no clone at {dest} and --skip-clone was passed")
    dest.parent.mkdir(parents=True, exist_ok=True)
    _git(["clone", "--depth", "1", "--single-branch", url, str(dest)])
    return "cloned"


def collect_repo_files(repo_dir):
    """graphify's file discovery, minus build/vendor trees."""
    from graphify.extract import collect_files
    return [f for f in collect_files(repo_dir)
            if not SKIP_DIRS & {p.name for p in f.relative_to(repo_dir).parents}]


def run_graphify(repo_dir, graph_path):
    """extract -> build -> cluster -> to_json. Returns the raw graph dict."""
    from graphify.build import build_from_json
    from graphify.cluster import cluster
    from graphify.export import to_json

    files = collect_repo_files(repo_dir)
    if not files:
        return {"nodes": [], "links": []}
    from graphify.extract import extract
    result = extract(files, cache_root=repo_dir, root=repo_dir, parallel=False)
    graph = build_from_json(result, root=repo_dir)
    communities = cluster(graph)
    graph_path.parent.mkdir(parents=True, exist_ok=True)
    # force=True: this is a full rebuild, so a smaller graph than last run is a
    # legitimate result, not the silent-shrink accident to_json guards against.
    to_json(graph, communities, str(graph_path), force=True, built_at_commit="")
    return json.loads(graph_path.read_text(encoding="utf-8"))


def build_shard(org_row, role, repo_dir, graph_path, skip_clone):
    """One repo, clone through condensed shard."""
    name = org_row["name"]
    meta = repo_meta(org_row, role)
    try:
        action = ensure_clone(name, org_row["url"], repo_dir, skip_clone)
    except PipelineAbort:
        if name not in KNOWN_EMPTY_REPOS:
            raise
        action = "skipped (known code-less)"
    if name in KNOWN_EMPTY_REPOS:
        if (repo_dir / ".git").exists():
            found = len(collect_repo_files(repo_dir))
            if found:
                print(f"  !! {name}: listed as code-less but {found} parseable "
                      f"file(s) are present — stub written per policy; revisit "
                      f"KNOWN_EMPTY_REPOS")
        print(f"  {name}: {action}, stub shard ({KNOWN_EMPTY_REASON})")
        return stub_shard(meta)
    try:
        raw = run_graphify(repo_dir, graph_path)
    except Exception as exc:                       # noqa: BLE001 — re-raised named
        raise extraction_failure(name, exc) from exc
    check_node_count(name, len(raw.get("nodes") or []))
    shard = cap_shard(name, condense(raw, meta))
    counts = shard["counts"]
    print(f"  {name}: {action}, {counts['nodes']} nodes / {counts['edges']} edges "
          f"/ {counts['communities']} communities, "
          f"{len(shard['god_nodes'])} god nodes")
    return shard


def main():
    ap = argparse.ArgumentParser(
        description="Clone the org's non-fork repos, graph them with graphify, "
                    "and write the condensed shards under data/graph/.")
    ap.add_argument("--clones-dir", type=Path, default=DEFAULT_CLONES_DIR,
                    help="where the shallow clones live (outside this repo)")
    ap.add_argument("--graphs-dir", type=Path, default=DEFAULT_GRAPHS_DIR,
                    help="where the raw graphify graphs live (outside this repo)")
    ap.add_argument("--repos", default="",
                    help="comma-separated subset of non-fork repos to rebuild")
    ap.add_argument("--skip-clone", action="store_true",
                    help="use the clones already on disk; no network at all")
    args = ap.parse_args()

    org = json.loads((ROOT / "data/org-repos.json").read_text(encoding="utf-8"))
    projects = json.loads((ROOT / "data/projects.json").read_text(encoding="utf-8"))
    roles, _ = role_and_project_maps(projects)
    by_name = {r["name"]: r for r in org}
    nonforks = sorted(r["name"] for r in org if not r.get("isFork"))

    selected = nonforks
    if args.repos.strip():
        selected = [n.strip() for n in args.repos.split(",") if n.strip()]
        unknown = [n for n in selected if n not in by_name]
        forks = [n for n in selected if n in by_name and by_name[n].get("isFork")]
        if unknown:
            sys.exit(f"ABORT: --repos names repos not in data/org-repos.json: {unknown}")
        if forks:
            sys.exit(f"ABORT: forks get no shard, by policy: {forks}")
        selected = sorted(set(selected))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    args.clones_dir.mkdir(parents=True, exist_ok=True)
    print(f"building {len(selected)} of {len(nonforks)} non-fork repos "
          f"(clones: {args.clones_dir})")

    try:
        for name in selected:
            shard = build_shard(by_name[name], roles.get(name),
                                args.clones_dir / name,
                                args.graphs_dir / name / "graph.json",
                                args.skip_clone)
            (OUT_DIR / f"repo-{name}.json").write_text(
                compact_dump(shard), encoding="utf-8")
    except PipelineAbort as exc:
        print(f"\nABORT: {exc}", file=sys.stderr)
        sys.exit(1)

    # The index covers all 94 repos and reads god nodes from whatever shards are
    # on disk, so a subset rebuild leaves the other rows exactly as they were.
    shards = {}
    for path in sorted(OUT_DIR.glob("repo-*.json")):
        shards[path.stem[len("repo-"):]] = json.loads(path.read_text(encoding="utf-8"))
    missing = [n for n in nonforks if n not in shards]
    if missing:
        print(f"  !! {len(missing)} non-fork repo(s) have no shard on disk, so "
              f"their index rows carry no god nodes: {missing}")
    index = build_index(org, projects, shards)
    (OUT_DIR / "repos-index.json").write_text(
        json.dumps(index, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")

    total = sum(len(compact_dump(s).encode()) for s in shards.values())
    biggest = max(((len(compact_dump(s).encode()), n) for n, s in shards.items()),
                  default=(0, "-"))
    print(f"data/graph: {len(shards)} shards, {total/1024:.1f} KB total, "
          f"largest {biggest[1]} at {biggest[0]} B; "
          f"repos-index.json: {len(index['repos'])} rows")


if __name__ == "__main__":
    main()
