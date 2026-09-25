#!/usr/bin/env python3
# Author: Kyle Nelson
# Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
# Last substantive modification: 21 September 2026
# Affiliation: TUHH HippoCampus Robotics
# Purpose: Regenerate the derived data (wiki graph, site search shard, contributors) in one run.
"""Regenerate every derived file, so nobody needs a terminal to keep them fresh.

    python3 tools/derive.py                                  # graph + site shard
    python3 tools/derive.py --contributors                   # ... + contributors (gh)
    python3 tools/derive.py --contributors-if-changed <ref>  # ... + contributors when
                                                             #     its inputs differ
    python3 tools/derive.py --annotate <file>...             # CI: output -> annotations

Plain python3, stdlib only. The builders run in this order, each as its own
process, exactly as a maintainer would run them:

    1. tools/build_wiki_graph.py                 data/graph/{wiki,summaries,xref-terms}.json
    2. tools/build_search_index.py --site-only   search/{site,manifest}.json
    3. tools/build_contributors.py               data/graph/contributors.json
       (only with --contributors, or with --contributors-if-changed <ref> when
       data/projects.json, data/org-repos.json or data/people.json differ from
       <ref>; it needs `gh` and GH_TOKEN, so it stays off the pull-request path)

Output contract (the maintainer protocols quote it): one `derive:` line per
builder, then `derive: <n> files changed (<paths>)` or `derive: nothing to do`.
"Changed" means the bytes of a file under search/ or data/graph/ differ from
before the run. A builder that fails stops the run with exit 1: derive names it
on one line, then passes the builder's own output through unchanged, so the
builder's located message is the last thing printed.

--contributors-if-changed <ref>: in CI <ref> is the push's `before` sha, which a
shallow checkout may not hold. derive resolves it locally, then tries
`git fetch --depth=1 origin <ref>`; if that fails, or <ref> is the all-zeros
sha of a new branch, the inputs are treated as changed (running the builder is
the safe side: it only rewrites contributors.json).

--annotate is the CI helper for the check job: it reads saved derive.py and
check.py output and prints each finding as a GitHub `::error` annotation.
It always exits 0 and skips files that do not exist.
"""
import argparse
import hashlib
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

DERIVED_DIRS = ("search", "data/graph")
CONTRIBUTOR_INPUTS = ("data/projects.json", "data/org-repos.json", "data/people.json")
GRAPH = ("build_wiki_graph.py", [])
SITE_SHARD = ("build_search_index.py", ["--site-only"])
CONTRIBUTORS = ("build_contributors.py", [])


# --------------------------------------------------------------------------
# regeneration
# --------------------------------------------------------------------------
def snapshot(root):
    """{relative path: sha256} of every file under the derived directories."""
    digests = {}
    for d in DERIVED_DIRS:
        base = Path(root) / d
        if not base.is_dir():
            continue
        for p in base.rglob("*"):
            if p.is_file():
                rel = p.relative_to(root).as_posix()
                digests[rel] = hashlib.sha256(p.read_bytes()).hexdigest()
    return digests


def label(builder):
    name, args = builder
    return " ".join([name, *args])


def run_builder(root, builder):
    """(exit code, combined stdout+stderr in the order the builder wrote it)."""
    name, args = builder
    script = Path(root) / "tools" / name
    if not script.is_file():
        return 1, f"tools/{name}: builder not found\n"
    proc = subprocess.run([sys.executable, str(script), *args], cwd=root,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, encoding="utf-8", errors="replace")
    return proc.returncode, proc.stdout


def _git(root, *args):
    return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True)


def contributors_inputs_changed(root, ref):
    """(changed?, one-line reason). Unknown history counts as changed."""
    if re.fullmatch(r"0+", ref):
        return True, f"{ref[:12]}… is the all-zeros sha (a new branch) — treated as changed"

    def resolves():
        return _git(root, "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}").returncode == 0

    if not resolves():
        _git(root, "fetch", "--quiet", "--depth=1", "origin", ref)
        if not resolves():
            return True, (f"cannot resolve {ref} (not in this checkout, and "
                          f"`git fetch origin {ref}` did not bring it) — treated as changed")
    diff = _git(root, "diff", "--quiet", ref, "--", *CONTRIBUTOR_INPUTS)
    if diff.returncode == 0:
        return False, f"inputs unchanged since {ref}"
    if diff.returncode == 1:
        return True, f"inputs differ from {ref}"
    return True, f"git diff against {ref} failed — treated as changed"


def regenerate(root, args):
    before = snapshot(root)
    builders = [GRAPH, SITE_SHARD]
    skip_reason = None
    if args.contributors:
        builders.append(CONTRIBUTORS)
    elif args.contributors_if_changed:
        changed, why = contributors_inputs_changed(root, args.contributors_if_changed)
        if changed:
            print(f"derive: contributors inputs: {why}")
            builders.append(CONTRIBUTORS)
        else:
            skip_reason = why
    else:
        skip_reason = "not requested; pass --contributors to run it"

    for builder in builders:
        rc, output = run_builder(root, builder)
        if rc != 0:
            print(f"derive: {label(builder)} FAILED (exit {rc}) — its own message follows:")
            sys.stdout.write(output if output.endswith("\n") or not output else output + "\n")
            sys.stdout.flush()
            return 1
        print(f"derive: {label(builder)} ok")
    if skip_reason:
        print(f"derive: {label(CONTRIBUTORS)} skipped ({skip_reason})")

    after = snapshot(root)
    changed = sorted(p for p in set(before) | set(after) if before.get(p) != after.get(p))
    if changed:
        noun = "file" if len(changed) == 1 else "files"
        print(f"derive: {len(changed)} {noun} changed ({', '.join(changed)})")
    else:
        print("derive: nothing to do")
    return 0


# --------------------------------------------------------------------------
# CI annotations
# --------------------------------------------------------------------------
GATE_LINE = re.compile(r"^  ✗ (.+)$")
DERIVE_FAILED = re.compile(r"^derive: .+ FAILED \(exit -?\d+\)")
LOCATED = [
    re.compile(r"^(?P<file>[^\s:]+):(?P<line>\d+):(?P<col>\d+): (?P<msg>.+)$"),
    re.compile(r"^(?P<file>[^\s:]+):(?P<line>\d+): (?P<msg>.+)$"),
    # a bare `path: message` needs a file extension, so "nodes: 12" is not a path
    re.compile(r"^(?P<file>[^\s:]+\.[A-Za-z0-9]+): (?P<msg>.+)$"),
]


def _esc_data(s):
    return s.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def _esc_prop(s):
    return _esc_data(s).replace(":", "%3A").replace(",", "%2C")


def annotation(message):
    for rx in LOCATED:
        m = rx.match(message)
        if m:
            props = [f"file={_esc_prop(m['file'])}"]
            if "line" in rx.groupindex:
                props.append(f"line={m['line']}")
            if "col" in rx.groupindex:
                props.append(f"col={m['col']}")
            props.append("title=check.py")
            return f"::error {','.join(props)}::{_esc_data(m['msg'])}"
    return f"::error title=check.py::{_esc_data(message)}"


def findings(text):
    """The failure lines of saved check.py or derive.py output."""
    found = []
    block = None                      # lines after a `derive: … FAILED` line
    for line in text.splitlines():
        m = GATE_LINE.match(line)
        if m:
            found.append(m.group(1))
            continue
        if DERIVE_FAILED.match(line):
            block = []
            continue
        if block is not None and line.strip():
            block.append(line)
    if block:
        picked = []
        for line in block:
            msg = line[len("FAIL: "):] if line.startswith("FAIL: ") else line
            if line.startswith("FAIL: ") or (not line[0].isspace()
                                             and any(rx.match(msg) for rx in LOCATED)):
                picked.append(msg)
        found.extend(picked or [block[-1].strip()])
    return found


def annotate(paths):
    seen = []
    for p in paths:
        p = Path(p)
        if not p.is_file():
            continue
        for msg in findings(p.read_text(encoding="utf-8", errors="replace")):
            cmd = annotation(msg)
            if cmd not in seen:
                seen.append(cmd)
    for cmd in seen:
        print(cmd)
    return 0


# --------------------------------------------------------------------------
def main(argv=None, root=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--contributors", action="store_true",
                      help="also run tools/build_contributors.py (needs gh + GH_TOKEN)")
    mode.add_argument("--contributors-if-changed", metavar="REF",
                      help="run build_contributors.py only when its inputs differ from REF")
    mode.add_argument("--annotate", nargs="+", metavar="FILE",
                      help="print saved derive/check output as GitHub ::error annotations")
    args = ap.parse_args(argv)
    if args.annotate:
        return annotate(args.annotate)
    return regenerate(Path(root) if root is not None else ROOT, args)


if __name__ == "__main__":
    sys.exit(main())
