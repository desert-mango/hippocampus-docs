#!/usr/bin/env python3
"""Build the static search index (phase 2).

Run under graphify's interpreter (its AST extraction does the code parsing):

    uv tool run --from graphifyy python tools/build_search_index.py \
        --repos-dir /path/to/shallow-clones --branches /path/to/branches.json \
        [--fork-trees /path/to/fork-trees.json]

Inputs
  --repos-dir   : directory of shallow clones of the NON-FORK org repos
  --branches    : [{"name": repo, "branch": default_branch}, ...] for ALL repos
  --fork-trees  : {"repo": ["top-level path", ...]} shallow file lists for forks
                  (forks are indexed shallowly BY POLICY — see docs/site-plan.md §5)

Outputs (committed to THIS repo only — never to any source repo)
  search/manifest.json         shard list + per-shard entry counts and bytes
  search/site.json             site pages: titles, headings, excerpts
  search/cad.json              CAD part list from data/cad-tree.json
  search/code-<repo>.json      symbols per non-fork repo (graphify AST)
  search/forks.json            shallow file lists for upstream forks

Shard symbol row: [label, path, line, kind]  (kind: class|fn|file)
Size policy: a per-repo shard is capped at MAX_SHARD_BYTES by dropping, in
order, methods -> functions -> files (never classes); every drop is REPORTED
loudly here and recorded in the manifest — silent truncation is a bug.
"""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAX_SHARD_BYTES = 300_000
SKIP_DIRS = {".git", "node_modules", "build", "install", "log", "__pycache__"}


def compact_dump(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def norm_label(label):
    label = str(label).strip()
    label = re.sub(r"^\.", "", label)
    label = re.sub(r"\(\)$", "", label)
    return label


def extract_repo(repo_dir):
    from graphify.extract import collect_files, extract
    files = [f for f in collect_files(repo_dir)
             if not SKIP_DIRS & set(p.name for p in f.relative_to(repo_dir).parents)]
    if not files:
        return []
    result = extract(files, cache_root=repo_dir, parallel=False)
    rows = []
    for n in result["nodes"]:
        label = norm_label(n.get("label", ""))
        src = n.get("source_file") or ""
        if not label or not src:
            continue
        loc = n.get("source_location") or ""
        m = re.match(r"L(\d+)", str(loc))
        line = int(m.group(1)) if m else 0
        if n.get("_callable_class"):
            kind = "class"
        elif n.get("_callable"):
            kind = "fn"
        elif label == Path(src).name:
            kind = "file"
        else:
            continue  # imports/other references — files+symbols only
        rows.append([label, src, line, kind])
    # dedupe (same symbol can appear via decl+def)
    seen = set()
    out = []
    for r in rows:
        key = (r[0], r[1], r[3])
        if key not in seen:
            seen.add(key)
            out.append(r)
    return out


def cap_shard(repo, rows):
    dropped = {}
    order = ["fn", "file"]  # drop methods/functions first, then plain files; never classes
    while len(compact_dump(rows).encode()) > MAX_SHARD_BYTES and order:
        kind = order.pop(0)
        keep = [r for r in rows if r[3] != kind]
        dropped[kind] = len(rows) - len(keep)
        rows = keep
    if dropped:
        print(f"  !! {repo}: capped shard, dropped {dropped} (policy: MAX_SHARD_BYTES)")
    return rows, dropped


def excerpt(md_text):
    """First real prose paragraph of a Markdown body, links flattened, <= 220 chars.

    Module level on purpose: tools/build_wiki_graph.py derives its page
    summaries with EXACTLY this function, so the search index and the wiki
    graph can never drift apart on what a page's first sentence is.
    """
    for para in md_text.split("\n\n"):
        p = para.strip()
        if p and not p.startswith(("#", "<", "```", "!", "-", "|", "*")):
            return re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", p)[:220]
    return ""


def build_site_shard():
    """Pages, headings, and excerpts from the content registries."""
    entries = []

    def headings(md_text):
        return [re.sub(r"^#+\s*", "", h).strip()
                for h in re.findall(r"^#{2,4}\s+.+$", md_text, re.M)][:40]

    setup = json.loads((ROOT / "data/setup.json").read_text())
    for sec in setup["sections"]:
        for p in sec["pages"]:
            text = (ROOT / p["file"]).read_text(encoding="utf-8")
            entries.append({"t": p["title"], "r": f"#/setup/{p['id']}",
                            "w": f"Setup · {sec['title']}",
                            "h": headings(text), "x": excerpt(text)})
    projects = json.loads((ROOT / "data/projects.json").read_text())
    for pr in projects["projects"]:
        text = (ROOT / pr["file"]).read_text(encoding="utf-8")
        entries.append({"t": pr["name"], "r": f"#/projects/{pr['id']}", "w": "Project",
                        "h": headings(text),
                        "x": pr["tagline"],
                        "extra": " ".join(r["name"] for r in pr["repos"])})
    tools = json.loads((ROOT / "data/tools.json").read_text())
    for t in tools["tools"]:
        text = (ROOT / t["file"]).read_text(encoding="utf-8")
        entries.append({"t": t["name"], "r": f"#/tools/{t['id']}", "w": "Agent tool",
                        "h": headings(text), "x": t["tagline"]})
    about = (ROOT / "content/about.md").read_text(encoding="utf-8")
    entries.append({"t": "About this site", "r": "#/about", "w": "About",
                    "h": headings(about), "x": excerpt(about)})
    return entries


def build_cad_shard():
    cad = json.loads((ROOT / "data/cad-tree.json").read_text())
    repo = cad["repo"]
    rows = []
    for path in cad["files"]:
        name = Path(path).name
        stem = Path(path).stem
        if name.startswith(".") or "/OldVersions/" in f"/{path}" or "sync-conflict" in name:
            continue  # backups and sync artifacts would only produce duplicate hits
        rows.append([stem, path, Path(path).suffix.lstrip(".").lower()])
    return {"repo": repo, "branch": "main", "parts": rows,
            "skipped": "OldVersions/, sync-conflict files, dotfiles"}


def rebuild_site_only():
    """Refresh search/site.json after content edits (plain python3, no graphify)."""
    out_dir = ROOT / "search"
    manifest_p = out_dir / "manifest.json"
    manifest = json.loads(manifest_p.read_text())
    site = build_site_shard()
    data = compact_dump({"kind": "site", "entries": site})
    (out_dir / "site.json").write_text(data, encoding="utf-8")
    for s in manifest["shards"]:
        if s["file"] == "search/site.json":
            s["entries"] = len(site)
            s["bytes"] = len(data.encode())
    manifest_p.write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    print(f"site.json rebuilt: {len(site)} entries, {len(data.encode())} bytes")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site-only", action="store_true",
                    help="rebuild only the site-pages shard (no clones, no graphify)")
    ap.add_argument("--repos-dir", type=Path)
    ap.add_argument("--branches", type=Path)
    ap.add_argument("--fork-trees", type=Path)
    args = ap.parse_args()

    if args.site_only:
        rebuild_site_only()
        return
    if not args.repos_dir or not args.branches:
        ap.error("--repos-dir and --branches are required for a full build (or use --site-only)")

    branches = {b["name"]: b["branch"] for b in json.loads(args.branches.read_text())}
    org = json.loads((ROOT / "data/org-repos.json").read_text())
    nonforks = [r["name"] for r in org if not r["isFork"]]
    forks = [r["name"] for r in org if r["isFork"]]

    out_dir = ROOT / "search"
    out_dir.mkdir(exist_ok=True)
    for old in out_dir.glob("*.json"):
        old.unlink()

    manifest = {"generated": "run tools/build_search_index.py to regenerate",
                "policy": {"max_shard_bytes": MAX_SHARD_BYTES,
                           "forks": "shallow file lists only (docs/site-plan.md §5)"},
                "shards": []}

    def write_shard(name, payload, count, note=""):
        p = out_dir / name
        data = compact_dump(payload)
        p.write_text(data, encoding="utf-8")
        manifest["shards"].append({"file": f"search/{name}", "entries": count,
                                   "bytes": len(data.encode()),
                                   **({"note": note} if note else {})})
        print(f"  {name}: {count} entries, {len(data.encode())} bytes")

    # site
    site = build_site_shard()
    write_shard("site.json", {"kind": "site", "entries": site}, len(site))
    # cad
    cad = build_cad_shard()
    write_shard("cad.json", {"kind": "cad", **cad}, len(cad["parts"]),
                note=cad["skipped"])
    # code, one shard per non-fork repo
    missing = []
    for name in sorted(nonforks):
        repo_dir = args.repos_dir / name
        if not repo_dir.is_dir():
            missing.append(name)
            continue
        rows = extract_repo(repo_dir)
        rows, dropped = cap_shard(name, rows)
        if not rows:
            print(f"  -- {name}: no indexable code, skipped")
            continue
        write_shard(f"code-{name}.json",
                    {"kind": "code", "repo": f"HippoCampusRobotics/{name}",
                     "branch": branches.get(name, "main"), "symbols": rows},
                    len(rows), note=f"dropped {dropped}" if dropped else "")
    # forks (shallow)
    if args.fork_trees:
        trees = json.loads(args.fork_trees.read_text())
        fork_entries = []
        for name in sorted(forks):
            for path in trees.get(name, []):
                fork_entries.append([name, path, branches.get(name, "master")])
        write_shard("forks.json", {"kind": "forks", "org": "HippoCampusRobotics",
                                   "files": fork_entries}, len(fork_entries),
                    note="top-level file lists only, by policy")

    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    total = sum(s["bytes"] for s in manifest["shards"])
    print(f"manifest: {len(manifest['shards'])} shards, {total/1e6:.2f} MB total")
    if missing:
        print(f"MISSING CLONES ({len(missing)}): {missing}")
        sys.exit(1)


if __name__ == "__main__":
    main()
