#!/usr/bin/env bash
# Author: Kyle Nelson
# Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
# Last substantive modification: 29 September 2026
# Affiliation: TUHH HippoCampus Robotics
# Purpose: Capture scrubbed raw GitHub API fixtures for the GitHub-data tests and verify the scrub.
#
# Two modes:
#
#   tools/tests/fixtures/github-data/capture.sh            re-capture every fixture (network;
#                                                           the `gh` CLI must be logged in)
#   tools/tests/fixtures/github-data/capture.sh --verify [DIR]
#                                                           offline scan of DIR (default: this
#                                                           folder); exits 1 on any hit
#
# The capture writes raw responses to a private temp folder, scrubs them there, and runs the
# `--verify` scan over that staged set. Only a staged set that passes replaces the scrubbed
# bodies (+ `.headers` sidecars) in this folder; a failing one exits 1 and leaves this folder
# untouched. The scan runs once more over this folder at the end. The scrub rules and the reason
# for every choice below are in README.md next to this file.
#
# Only GET requests are made (`gh api` without -X/-f), with the default `gh` account. Nothing is
# ever written to GitHub.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The embedded Python does all parsing, scrubbing and checking (python3 stdlib only).
read -r -d '' PYPROG <<'PY' || true
import json, os, re, sys
from pathlib import Path
from urllib.parse import parse_qsl

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")  # check.py's EMAIL_RE
SAFE_SUFFIX = "@example.invalid"
PLACEHOLDER_EMAIL = "redacted" + SAFE_SUFFIX
NULL_COMMIT_EMAIL = "noreply" + SAFE_SUFFIX
PROFILE_KEYS = ("email", "location", "company", "bio", "blog", "twitter_username", "hireable",
                "followers", "following", "public_repos", "public_gists", "notification_email")
PRIVATE_KEYS = ("private_gists", "total_private_repos", "owned_private_repos", "disk_usage",
                "collaborators", "two_factor_authentication", "plan")
VERIFICATION = {"verified": False, "reason": "unsigned", "signature": None, "payload": None}
MUST_BE_NULL = ("payload", "signature", "bio", "company", "location", "blog", "twitter_username")
HEADER_ALLOW = ("content-type", "etag", "last-modified", "link", "x-ratelimit-limit",
                "x-ratelimit-remaining", "x-ratelimit-reset", "x-ratelimit-resource",
                "x-ratelimit-used", "x-github-api-version-selected", "x-github-media-type")
COUNTS = {"commit_email": 0, "verification": 0, "profile_field": 0, "private_field": 0,
          "email_string": 0}


def scrub_text(text):
    def repl(m):
        if m.group(0).endswith(SAFE_SUFFIX):
            return m.group(0)
        COUNTS["email_string"] += 1
        return PLACEHOLDER_EMAIL
    return EMAIL_RE.sub(repl, text)


def scrub(node):
    if isinstance(node, dict):
        commit = node.get("commit")
        if isinstance(commit, dict):
            for role in ("author", "committer"):
                inner = commit.get(role)
                if isinstance(inner, dict) and "email" in inner:
                    top = node.get(role)
                    login = top.get("login") if isinstance(top, dict) else None
                    inner["email"] = (login + SAFE_SUFFIX) if login else NULL_COMMIT_EMAIL
                    COUNTS["commit_email"] += 1
        if isinstance(node.get("verification"), dict):
            node["verification"] = dict(VERIFICATION)
            COUNTS["verification"] += 1
        if "login" in node:
            for key in PROFILE_KEYS:
                if key in node:
                    node[key] = None
                    COUNTS["profile_field"] += 1
            for key in PRIVATE_KEYS:
                if key in node:
                    del node[key]
                    COUNTS["private_field"] += 1
        return {k: scrub(v) for k, v in node.items()}
    if isinstance(node, list):
        return [scrub(v) for v in node]
    if isinstance(node, str):
        return scrub_text(node)
    return node


def dump(doc, path):
    Path(path).write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def split_raw(raw_path):
    """`gh api --include` output -> (status line, [(name, value)], body text)."""
    raw = Path(raw_path).read_text(encoding="utf-8")
    raw = raw.replace("\r\n", "\n")
    head, _, body = raw.partition("\n\n")
    lines = head.split("\n")
    headers = []
    for line in lines[1:]:
        name, _, value = line.partition(":")
        headers.append((name.strip(), value.strip()))
    return lines[0].strip(), headers, body


def write_headers(status, headers, path):
    keep = [f"{n}: {v}" for n, v in headers if n.lower() in HEADER_ALLOW]
    Path(path).write_text(scrub_text("\n".join([status] + keep)) + "\n", encoding="utf-8")


def cmd_scrub(raw_path, out_dir, name):
    status, headers, body = split_raw(raw_path)
    doc = scrub(json.loads(body))
    dump(doc, Path(out_dir) / f"{name}.json")
    write_headers(status, headers, Path(out_dir) / f"{name}.headers")


def cmd_scrub_text(in_path, out_path):
    Path(out_path).write_text(scrub_text(Path(in_path).read_text(encoding="utf-8")),
                              encoding="utf-8")


def cmd_field(json_path, expr):
    """Tiny accessor: 'check_runs[name=check].id' or 'head.sha'."""
    node = json.loads(Path(json_path).read_text(encoding="utf-8"))
    for part in expr.split("."):
        m = re.fullmatch(r"(\w+)\[(\w+)=([\w-]+)\]", part)
        if m:
            node = next(x for x in node[m.group(1)] if str(x.get(m.group(2))) == m.group(3))
        else:
            node = node[part]
    print(node)


def cmd_readonly(out_dir):
    """The hand-edited read-only variant of the repository response (see README)."""
    out = Path(out_dir)
    doc = json.loads((out / "repo-push.json").read_text(encoding="utf-8"))
    for key in ("admin", "maintain", "push", "triage"):
        doc["permissions"][key] = False
    dump(doc, out / "repo-readonly.json")
    (out / "repo-readonly.headers").write_text(
        (out / "repo-push.headers").read_text(encoding="utf-8"), encoding="utf-8")


def cmd_link_pages(out_dir, org, per_page):
    """Hand-made two-page split of the real org-repos body, with Link headers."""
    out = Path(out_dir)
    per_page = int(per_page)
    repos = json.loads((out / "org-repos.json").read_text(encoding="utf-8"))
    base = f"https://api.github.com/orgs/{org}/repos?type=public&per_page={per_page}"
    status, *rest = (out / "org-repos.headers").read_text(encoding="utf-8").splitlines()
    kept = [l for l in rest if l.split(":", 1)[0].lower() not in ("link", "etag")]
    pages = {
        1: (repos[:per_page], f'<{base}&page=2>; rel="next", <{base}&page=2>; rel="last"'),
        2: (repos[per_page:], f'<{base}&page=1>; rel="prev", <{base}&page=1>; rel="first"'),
    }
    for n, (items, link) in pages.items():
        name = f"org-repos-per{per_page}-p{n}"
        dump(scrub(items), out / f"{name}.json")
        (out / f"{name}.headers").write_text(
            scrub_text("\n".join([status] + kept + [f"Link: {link}"])) + "\n", encoding="utf-8")


def cmd_no_next(headers_path, request):
    """Exit 1 when a sidecar's Link header has rel="next": the answer has more pages."""
    for line in Path(headers_path).read_text(encoding="utf-8").splitlines()[1:]:
        name, _, value = line.partition(":")
        if name.strip().lower() == "link" and re.search(r'rel="?next"?', value):
            print(f"capture.sh: FAIL {request} answered with a Link rel=\"next\" header: "
                  "GitHub has more pages, but this fixture is recorded as the COMPLETE answer. "
                  "Paginate (or narrow) the request in capture.sh before re-capturing; "
                  "nothing in the fixture folder was changed.", file=sys.stderr)
            return 1
    return 0


def pr_head_shas(doc, number):
    """Every commit sha a pulls answer carries for PR NUMBER's head (see cmd_pr_pinned)."""
    if isinstance(doc, dict) and "head" in doc:                    # pulls/N
        return [doc["head"]["sha"]]
    if isinstance(doc, list) and all(isinstance(x, dict) and "number" in x for x in doc):
        return [x["head"]["sha"] for x in doc if str(x["number"]) == str(number)]  # pulls?state=
    if isinstance(doc, list) and all(isinstance(x, dict) and "filename" in x for x in doc):
        shas = []                                                  # pulls/N/files
        for x in doc:
            for key in ("blob_url", "raw_url", "contents_url"):
                shas += re.findall(r"(?:/blob/|/raw/|[?&]ref=)([0-9a-f]{40})", x.get(key) or "")
        return shas
    return []


def cmd_pr_pinned(json_path, number, pin):
    """Exit 1 unless every head sha this PR answer carries is PIN (the snapshot's head)."""
    doc = json.loads(Path(json_path).read_text(encoding="utf-8"))
    shas = pr_head_shas(doc, number)
    moved = sorted({s for s in shas if s != pin})
    if shas and not moved:
        return 0
    seen = ", ".join(moved) if moved else f"no head sha for PR #{number}"
    print(f"capture.sh: FAIL {Path(json_path).name}: PR #{number} has moved (found {seen}; "
          f"pinned {pin}). The fixture set is a snapshot at {pin[:7]}: re-pin PR_HEAD_FULL in "
          "capture.sh deliberately and re-review every PR-derived fixture before re-capturing; "
          "nothing in the fixture folder was changed.", file=sys.stderr)
    return 1


def cmd_index(table_path, out_dir):
    entries, pages = [], []
    for line in Path(table_path).read_text(encoding="utf-8").splitlines():
        kind, name, target, note = line.split("\t")
        if kind == "git":
            rev, path = target.split(":", 1)
            pages.append({"rev": rev, "path": path, "file": f"{name}.md", "note": note})
            continue
        path, _, query = target.partition("?")
        status = (Path(out_dir) / f"{name}.headers").read_text(encoding="utf-8").split()[1]
        entries.append({
            "method": "GET",
            "path": "/" + path,
            "query": dict(parse_qsl(query, keep_blank_values=True)),
            "status": int(status),
            "body": f"{name}.json",
            "headers": f"{name}.headers",
            "source": kind,
            "note": note,
        })
    index = {
        "schema": 1,
        "about": "Scrubbed raw GitHub REST responses; see README.md. Look a request up by "
                 "method + path + query; 'source' is 'gh' (captured verbatim, then scrubbed) "
                 "or 'hand-made' (derived from a captured body, see note).",
        "base_url": "https://api.github.com",
        "requests": entries,
        "git_show": pages,
    }
    dump(index, Path(out_dir) / "index.json")


def cmd_verify(folder):
    problems = []
    folder = Path(folder)
    files = sorted(p for p in folder.rglob("*") if p.is_file())

    def walk(node, where):
        if isinstance(node, dict):
            commit = node.get("commit")
            if isinstance(commit, dict):
                for role in ("author", "committer"):
                    inner = commit.get(role)
                    if isinstance(inner, dict) and "email" in inner and not (
                            isinstance(inner["email"], str)
                            and inner["email"].endswith(SAFE_SUFFIX)):
                        problems.append(f"{where}: commit.{role}.email is not {SAFE_SUFFIX}")
            if "verification" in node and node["verification"] not in (VERIFICATION, None):
                problems.append(f"{where}: verification object is not the placeholder")
            if "login" in node:
                for key in PROFILE_KEYS:
                    if key in node and node[key] is not None:
                        problems.append(f"{where}: profile field '{key}' is not null")
                for key in PRIVATE_KEYS:
                    if key in node:
                        problems.append(f"{where}: private field '{key}' present")
            for key in MUST_BE_NULL:
                if key in node and node[key] is not None:
                    problems.append(f"{where}: '{key}' is not null")
            for key in ("email", "notification_email"):
                value = node.get(key)
                if value is not None and not (isinstance(value, str)
                                              and value.endswith(SAFE_SUFFIX)):
                    problems.append(f"{where}: '{key}' carries a value")
            for v in node.values():
                walk(v, where)
        elif isinstance(node, list):
            for v in node:
                walk(v, where)

    for p in files:
        rel = p.relative_to(folder)
        try:
            text = p.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            problems.append(f"{rel}: not UTF-8 text (fixtures are text only)")
            continue
        for i, line in enumerate(text.splitlines(), 1):
            for m in EMAIL_RE.finditer(line):
                if not m.group(0).endswith(SAFE_SUFFIX):
                    problems.append(f"{rel}:{i}: e-mail-shaped string outside {SAFE_SUFFIX}")
        if p.suffix == ".json":
            try:
                walk(json.loads(text), str(rel))
            except json.JSONDecodeError as e:
                problems.append(f"{rel}: invalid JSON ({e.msg})")
        if p.suffix == ".headers":
            for line in text.splitlines()[1:]:
                if line.split(":", 1)[0].strip().lower() not in HEADER_ALLOW:
                    problems.append(f"{rel}: header outside the allowlist: "
                                    f"{line.split(':', 1)[0]}")
    for msg in problems:
        print(f"verify: FAIL {msg}")
    print(f"verify: {len(files)} files, {len(problems)} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "verify":
        sys.exit(cmd_verify(*args))
    if cmd == "no-next":
        sys.exit(cmd_no_next(*args))
    if cmd == "pr-pinned":
        sys.exit(cmd_pr_pinned(*args))
    {"scrub": cmd_scrub, "scrub-text": cmd_scrub_text, "field": cmd_field,
     "readonly": cmd_readonly, "link-pages": cmd_link_pages, "index": cmd_index}[cmd](*args)
    if cmd in ("scrub", "link-pages", "readonly") and any(COUNTS.values()):
        print("scrub " + " ".join(f"{k}={v}" for k, v in COUNTS.items() if v), file=sys.stderr)
PY

py() { python3 -c "$PYPROG" "$@"; }

if [[ "${1:-}" == "--verify" ]]; then
  py verify "${2:-$HERE}"
  exit $?
fi
if [[ $# -ne 0 ]]; then
  echo "usage: $0 [--verify [DIR]]" >&2
  exit 2
fi

ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"
RAW="$(mktemp -d)"            # unscrubbed responses live ONLY here, and are deleted on exit
OUT="$RAW/out"
mkdir -p "$OUT"
trap 'rm -rf "$RAW"' EXIT
TABLE="$RAW/table.tsv"

ORG=HippoCampusRobotics
SITE=desert-mango/hippocampus-docs
BASE=75f09dd                  # origin/main when PR #1 was captured; PR #1's base
# PR #1 (proposal/hippo-01-parity-docs) is captured as a FIXED snapshot at this head. Every
# PR-derived fixture is pinned to it; the three live PR answers (pulls?state=all, pulls/1,
# pulls/1/files) are checked against it (py pr-pinned) and the run stops if PR #1 has moved.
PR_HEAD_FULL=d0bdc64b22147adde2707e86df4f7e7e4658dfeb
PR_HEAD="${PR_HEAD_FULL:0:7}"   # d0bdc64: the short form in file names and requests
SINCE_365=2025-09-29T00:00:00Z   # capture day 2026-09-29 minus 365 days (a constant: re-runs match)
SINCE_NULL=2022-03-01T00:00:00Z  # widened: no org repo has an author:null commit in 365 days
SINCE_FORK=2020-01-01T00:00:00Z  # widened: no fork has a commit in 365 days
UNTIL_MOVE=2025-03-11T00:00:00Z  # the old docs moved every page under contents/ on 2025-03-10
UBUNTU=raspberry_pi_setup/ubuntu_24.04_server_64bit.rst
ETHERNET=raspberry_pi_setup/ethernet.rst
ROS=getting_started/ros_installation.rst
OLD_PI=raspberry_pi_4b_setup   # the Pi pages' folder before the same-day restructure (822b8c8)
PAGE=content/setup/raspberry-pi/ubuntu-24-04-server.md

# cap NAME 'API PATH?QUERY' 'note' [page1] — one GET, headers included, scrubbed into $OUT.
# Every capture is recorded as GitHub's COMPLETE answer, so a `Link: rel="next"` header (more
# pages exist) stops the whole run before this folder is touched. Only a capture marked `page1`
# (the three commits-* captures: page 1 by design) may have further pages.
cap() {
  gh api --include "$2" > "$RAW/$1.raw"
  py scrub "$RAW/$1.raw" "$OUT" "$1"
  [[ "${4:-}" == page1 ]] || py no-next "$OUT/$1.headers" "$2"
  printf 'gh\t%s\t%s\t%s\n' "$1" "$2" "$3" >> "$TABLE"
}

cap org-repos "orgs/$ORG/repos?type=public&per_page=100" "all of the org's public repos: they fit on page 1, and a next page fails the capture"
cap commits-docs "repos/$ORG/docs/commits?since=$SINCE_365&per_page=100" "non-fork, the old docs repo, last 365 days; page 1 only by design" page1
cap commits-hippocampus_common "repos/$ORG/hippocampus_common/commits?since=$SINCE_NULL&per_page=100" "non-fork with author:null commits (since widened); page 1 only by design" page1
cap commits-mavros "repos/$ORG/mavros/commits?since=$SINCE_FORK&per_page=100" "a fork (since widened so it has commits); page 1 only by design" page1
cap releases-docs "repos/$ORG/docs/releases?per_page=100" "empty release list"
for login in NBauschmann lennartalff DanielDuecker FinnBreu RHochdahl timzarhansen; do
  cap "user-$login" "users/$login" "public profile; profile fields nulled"
done
cap page-commits-ubuntu-current "repos/$ORG/docs/commits?path=contents/$UBUNTU&per_page=100" "Ubuntu 24.04 server page, current path"
cap page-commits-ubuntu-premove "repos/$ORG/docs/commits?path=$UBUNTU&until=$UNTIL_MOVE&per_page=100" "Ubuntu 24.04 server page, pre-move path"
cap page-commits-ubuntu-pre-restructure "repos/$ORG/docs/commits?path=$OLD_PI/ubuntu_24.04_server_64bit.rst&until=$UNTIL_MOVE&per_page=100" "Ubuntu page, folder before the restructure"
cap page-commits-ethernet-current "repos/$ORG/docs/commits?path=contents/$ETHERNET&per_page=100" "Raspberry Pi ethernet page, current path"
cap page-commits-ethernet-premove "repos/$ORG/docs/commits?path=$ETHERNET&until=$UNTIL_MOVE&per_page=100" "Raspberry Pi ethernet page, pre-move path"
cap page-commits-ethernet-pre-restructure "repos/$ORG/docs/commits?path=$OLD_PI/ethernet.rst&until=$UNTIL_MOVE&per_page=100" "ethernet page, folder before the restructure"
cap page-commits-ros-current "repos/$ORG/docs/commits?path=contents/$ROS&per_page=100" "ROS installation page, current path"
cap page-commits-ros-premove "repos/$ORG/docs/commits?path=$ROS&until=$UNTIL_MOVE&per_page=100" "ROS installation page, pre-move path"
cap pulls-all "repos/$SITE/pulls?state=all&per_page=100" "this repo's pull requests, every state"
cap pull-1 "repos/$SITE/pulls/1" "PR #1 (read-only)"
cap pull-1-files "repos/$SITE/pulls/1/files?per_page=100" "PR #1's changed files"
for pr_answer in pulls-all pull-1 pull-1-files; do
  py pr-pinned "$OUT/$pr_answer.json" 1 "$PR_HEAD_FULL"   # PR #1 moved -> stop here
done
cap "compare-$BASE...$PR_HEAD" "repos/$SITE/compare/$BASE...$PR_HEAD" "PR #1 against its base"
cap "check-runs-$PR_HEAD" "repos/$SITE/commits/$PR_HEAD/check-runs" "check runs on PR #1's head"
CHECK_ID="$(py field "$OUT/check-runs-$PR_HEAD.json" 'check_runs[name=check].id')"
cap check-run-check-annotations "repos/$SITE/check-runs/$CHECK_ID/annotations" "annotations of the 'check' run"
cap user "user" "the signed-in account; profile nulled, private-only fields removed"
cap repo-push "repos/$SITE" "the repo as the signed-in account sees it (permissions.push true)"
py readonly "$OUT"
printf 'hand-made\trepo-readonly\t%s\t%s\n' "repos/$SITE" "hand-edited copy of repo-push: admin/maintain/push/triage false" >> "$TABLE"
cap ref-heads-main "repos/$SITE/git/ref/heads/main" "main's head ref"
py link-pages "$OUT" "$ORG" 50
printf 'hand-made\torg-repos-per50-p1\t%s\t%s\n' "orgs/$ORG/repos?type=public&per_page=50" "org-repos split in two; Link rel=next" >> "$TABLE"
printf 'hand-made\torg-repos-per50-p2\t%s\t%s\n' "orgs/$ORG/repos?type=public&per_page=50&page=2" "second half; Link rel=prev/first, no next" >> "$TABLE"

# The Ubuntu page's text in THIS repo at PR #1's head, at the merge base and at the base.
git -C "$ROOT" fetch -q origin "$PR_HEAD_FULL"
MERGE_BASE="$(git -C "$ROOT" merge-base "$BASE" "$PR_HEAD")"
for spec in "at-$PR_HEAD:$PR_HEAD" "at-merge-base:$MERGE_BASE" "at-$BASE:$BASE"; do
  label="${spec%%:*}"; rev="${spec#*:}"
  git -C "$ROOT" show "$rev:$PAGE" > "$RAW/page.txt"
  py scrub-text "$RAW/page.txt" "$OUT/page-ubuntu-24-04-server.$label.md"
  printf 'git\tpage-ubuntu-24-04-server.%s\t%s:%s\t%s\n' "$label" "${rev:0:7}" "$PAGE" "git show" >> "$TABLE"
done

py index "$TABLE" "$OUT"
# Verify the STAGED set first: this folder's committed fixtures are only replaced by a capture
# that already passed the scan, so a leak the scrubber missed never lands here, even briefly.
if ! py verify "$OUT"; then
  echo "capture.sh: FAIL the staged capture did not pass verify (see above); nothing in the" \
       "fixture folder was changed." >&2
  exit 1
fi
find "$HERE" -maxdepth 1 -type f \( -name '*.json' -o -name '*.headers' -o -name 'page-*.md' \) -delete
cp "$OUT"/* "$HERE"/
py verify "$HERE"             # the folder as committed: the same scan once more
