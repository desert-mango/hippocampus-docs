#!/usr/bin/env python3
"""Build data/graph/contributors.json — the per-project contributor lists.

Run it with plain python3 from the repo root (needs the `gh` CLI, logged in):

    python3 tools/build_contributors.py

Where the numbers come from: the GitHub REST API, through `gh`, never git
history — the clones this repo's graph pipeline makes are shallow, so
`git shortlog` would under-count. Two endpoints, both public data:

    gh api repos/<org>/<repo>/contributors --paginate   -> login, contributions
    gh api users/<login>                                -> display name

What lands on disk, per project in data/projects.json: the contributions of
that project's own NON-FORK org repos, summed per login. Skipped: upstream
forks (their commits are other people's work), `external: true` rows (other
people's repos listed for context), and anything in EXCLUDED_REPOS.

Privacy projection — the reason this script exists rather than a one-liner:
  * only three fields per person survive: login, name, contributions;
  * bots are dropped (login ending in "[bot]", or type "Bot");
  * before anything is written, every string in the document is checked for
    "@" and the run aborts if one is found. Email addresses can reach a
    contributor payload; they must never reach this repo.

Output schema (indent=1, project keys sorted, trailing newline):

    {"generated": ..., "org": ..., "note": ...,
     "projects": {"<project-id>": {
        "contributors": [{"login", "name", "contributions"[, "roster": true]}],
        "truncated": <how many were cut, only when > 0>}}}

A project with no contributors keeps its key with an empty list, so the UI can
tell "nobody found" apart from "never built". "roster": true marks a display
name that equals a name in data/people.json (exact after trimming, case-folding
and collapsing runs of whitespace — nothing fuzzier: a false roster link is
worse than a missed one).

Failure policy: loud and total. Any gh call that fails or returns unparseable
JSON aborts the run with exit 1, and the file is written once, atomically, at
the very end — so an aborted run leaves the previous contributors.json exactly
as it was, never a half-built one.

--fixture <dir> replaces every gh call with canned JSON, which is how the unit
tests drive the whole pipeline offline. Layout:

    <dir>/contributors/<repo>.json   the /contributors payload for that repo
    <dir>/users/<login>.json         the /users/<login> payload
    <dir>/projects.json              optional; else data/projects.json
    <dir>/org-repos.json             optional; else data/org-repos.json
    <dir>/people.json                optional; else data/people.json

A payload the run asks for and cannot find aborts, exactly like a failing gh
call would.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "data" / "graph" / "contributors.json"

ORG = "HippoCampusRobotics"
TOP_N = 12                      # contributors kept per project
BACKOFF_SECONDS = 30            # one pause before giving up on a rate limit

GENERATED = "run tools/build_contributors.py to regenerate"
NOTE = ("public GitHub data; display names as published by GitHub; "
        "logins only where no display name is set")

# Org repos whose contributor counts would misrepresent human work (machine
# generated release repos, mirrors, and the like). Empty by design: nothing in
# the org has been judged misleading yet. Add a name here only together with a
# one-line reason — an unexplained exclusion is indistinguishable from a bug.
EXCLUDED_REPOS = frozenset()

_WHITESPACE = re.compile(r"\s+")
_RATE_LIMITED = re.compile(r"\b(403|429)\b|rate limit", re.IGNORECASE)


class Abort(RuntimeError):
    """Anything that must stop the whole run rather than write partial data."""


# =========================================================================
# pure helpers — no network, no filesystem
# =========================================================================
def norm_name(value):
    """Trim, collapse whitespace runs, case-fold. The only matching we do."""
    if not value:
        return ""
    return _WHITESPACE.sub(" ", str(value)).strip().casefold()


def roster_index(people):
    """Normalised names of everyone on the About page, team and alumni alike."""
    names = set()
    for group in people.get("groups", []):
        for person in group.get("people", []):
            key = norm_name(person.get("name"))
            if key:
                names.add(key)
    return frozenset(names)


def is_bot(row):
    """GitHub marks some bots with type "Bot" and some only by the login."""
    login = (row.get("login") or "").strip()
    return login.endswith("[bot]") or (row.get("type") or "") == "Bot"


def select_repos(projects, org_rows, excluded=EXCLUDED_REPOS):
    """{project id: [org non-fork repo names]} — every project id present.

    Dropped: `external: true` rows (someone else's repo, listed for context),
    upstream forks, names absent from data/org-repos.json, and `excluded`.
    """
    non_forks = {row["name"] for row in org_rows if not row.get("isFork")}
    selected = {}
    for project in projects.get("projects", []):
        pid = project.get("id")
        if not pid:
            raise Abort("data/projects.json has a project with no id")
        names = set()
        for row in project.get("repos", []):
            name = (row.get("name") or "").strip()
            if not name or row.get("external") or name in excluded:
                continue
            if name in non_forks:
                names.add(name)
        selected[pid] = sorted(names)
    return selected


def tally(rows):
    """Sum contributions per login over raw contributor rows; drop the bots."""
    totals = Counter()
    for row in rows:
        login = (row.get("login") or "").strip()
        if not login:
            raise Abort(f"contributor row without a login: {row!r}")
        if is_bot(row):
            continue
        count = row.get("contributions")
        if isinstance(count, bool) or not isinstance(count, int):
            raise Abort(f"{login}: contributions is not an integer: {count!r}")
        totals[login] += count
    return totals


def rank(totals, names, roster, top=TOP_N):
    """The stored projection: three fields, sorted, capped, truncation counted."""
    rows = []
    for login, count in totals.items():
        display = (names.get(login) or "").strip() or login
        entry = {"login": login, "name": display, "contributions": count}
        if norm_name(display) in roster:
            entry["roster"] = True
        rows.append(entry)
    rows.sort(key=lambda r: (-r["contributions"], r["login"]))
    entry = {"contributors": rows[:top]}
    if len(rows) > top:
        entry["truncated"] = len(rows) - top
    return entry


def assert_no_at(obj, path="$"):
    """No "@" anywhere in the document — the last line of defence on emails."""
    if isinstance(obj, dict):
        for key, value in obj.items():
            assert_no_at(key, f"{path}.{key}")
            assert_no_at(value, f"{path}.{key}")
    elif isinstance(obj, list):
        for i, value in enumerate(obj):
            assert_no_at(value, f"{path}[{i}]")
    elif isinstance(obj, str) and "@" in obj:
        raise Abort(
            f'"@" found at {path}: {obj!r}. That looks like an email address, '
            f"which must never be published by this repo. Nothing was written; "
            f"fix the upstream data or the projection, then rerun.")


def build_document(entries):
    return {"generated": GENERATED,
            "org": ORG,
            "note": NOTE,
            "projects": {pid: entries[pid] for pid in sorted(entries)}}


def dump(doc):
    return json.dumps(doc, indent=1, ensure_ascii=False) + "\n"


def parse_gh_json(text, what):
    """Parse one gh payload, or the several a --paginate run concatenates."""
    blob = (text or "").strip()
    if not blob:
        # /contributors answers 204 No Content for a repo with no commits.
        return []
    decoder = json.JSONDecoder()
    pages, at = [], 0
    try:
        while at < len(blob):
            page, at = decoder.raw_decode(blob, at)
            pages.append(page)
            while at < len(blob) and blob[at] in " \t\r\n":
                at += 1
    except ValueError as exc:
        raise Abort(f"{what}: gh returned unparseable JSON — {exc}") from None
    if len(pages) == 1:
        return pages[0]
    merged = []
    for page in pages:
        if not isinstance(page, list):
            raise Abort(f"{what}: gh returned several non-list pages")
        merged.extend(page)
    return merged


# =========================================================================
# impure half — gh and the filesystem
# =========================================================================
def run_gh(args):
    """Returns (returncode, stdout, stderr). The only place gh is executed."""
    try:
        proc = subprocess.run(["gh", *args], capture_output=True, text=True)
    except FileNotFoundError:
        raise Abort("the gh CLI is not installed or not on PATH") from None
    return proc.returncode, proc.stdout, proc.stderr


def gh_json(api_args, runner=run_gh, sleeper=time.sleep):
    """`gh api <api_args>` as parsed JSON; one back-off retry on 403/429."""
    args = ["api", *api_args]
    what = api_args[0] if api_args else "gh api"
    code, out, err = runner(args)
    if code != 0:
        blob = f"{err}\n{out}"
        if not _RATE_LIMITED.search(blob):
            raise Abort(f"{what}: gh exited {code} — {err.strip() or out.strip()}")
        print(f"  rate limited on {what}; waiting {BACKOFF_SECONDS}s and "
              f"retrying once")
        sleeper(BACKOFF_SECONDS)
        code, out, err = runner(args)
        if code != 0:
            raise Abort(f"{what}: still rate limited after a "
                        f"{BACKOFF_SECONDS}s wait — {err.strip() or out.strip()}")
    return parse_gh_json(out, what)


class Source:
    """Where contributor and user payloads come from. Caches user lookups."""

    def __init__(self):
        self._users = {}
        self.user_calls = []       # one entry per real fetch, for the tests

    def contributors(self, repo):
        raise NotImplementedError

    def user(self, login):
        if login not in self._users:
            self.user_calls.append(login)
            self._users[login] = self._fetch_user(login)
        return self._users[login]

    def _fetch_user(self, login):
        raise NotImplementedError


class GhSource(Source):
    def contributors(self, repo):
        return gh_json([f"repos/{ORG}/{repo}/contributors", "--paginate"])

    def _fetch_user(self, login):
        return gh_json([f"users/{login}"])


class FixtureSource(Source):
    """The offline twin of GhSource: canned JSON from a directory."""

    def __init__(self, root):
        super().__init__()
        self.root = Path(root)

    def _read(self, path, what):
        if not path.exists():
            raise Abort(f"{what}: no fixture payload at {path}")
        return parse_gh_json(path.read_text(encoding="utf-8"), what)

    def contributors(self, repo):
        return self._read(self.root / "contributors" / f"{repo}.json",
                          f"repos/{ORG}/{repo}/contributors")

    def _fetch_user(self, login):
        return self._read(self.root / "users" / f"{login}.json", f"users/{login}")


def load_inputs(fixture=None):
    """(org rows, projects, people) — from data/, or from a fixture override."""
    def load(name):
        path = Path(fixture) / name if fixture else None
        if path is None or not path.exists():
            path = ROOT / "data" / name
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise Abort(f"cannot read {path}: {exc}") from None
    return load("org-repos.json"), load("projects.json"), load("people.json")


def display_names(source, logins):
    """login -> GitHub display name (None where the account has none set)."""
    names = {}
    for login in sorted(logins):
        payload = source.user(login)
        if not isinstance(payload, dict):
            raise Abort(f"users/{login}: expected an object, got "
                        f"{type(payload).__name__}")
        names[login] = payload.get("name")
    return names


def build(source, org_rows, projects, people, excluded=EXCLUDED_REPOS):
    """Fetch, aggregate, project, and check. Returns the finished document."""
    roster = roster_index(people)
    by_project = select_repos(projects, org_rows, excluded)
    entries = {}
    for pid in sorted(by_project):
        repos = by_project[pid]
        rows = []
        for repo in repos:
            payload = source.contributors(repo)
            if not isinstance(payload, list):
                raise Abort(f"repos/{ORG}/{repo}/contributors: expected a list, "
                            f"got {type(payload).__name__}")
            rows.extend(payload)
        totals = tally(rows)
        entry = rank(totals, display_names(source, totals), roster)
        entries[pid] = entry
        print(f"  {pid}: {len(repos)} repo(s), {len(totals)} contributor(s)"
              + (f", {entry['truncated']} beyond the top {TOP_N}"
                 if entry.get("truncated") else ""))
    doc = build_document(entries)
    assert_no_at(doc)
    return doc


def write_atomic(path, text):
    """Temp file in the target directory, then rename — never a partial file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, tmp = tempfile.mkstemp(dir=str(path.parent),
                                   prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, str(path))
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Aggregate GitHub contributors per project into "
                    "data/graph/contributors.json (login, display name and "
                    "commit count only — never an email address).")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT,
                    help="where to write the document (default: %(default)s)")
    ap.add_argument("--fixture", type=Path, default=None,
                    help="read canned JSON from this directory instead of "
                         "calling gh (offline; see the module docstring)")
    args = ap.parse_args(argv)

    try:
        org_rows, projects, people = load_inputs(args.fixture)
        source = FixtureSource(args.fixture) if args.fixture else GhSource()
        print(f"contributors for {len(projects.get('projects', []))} projects"
              + (f" (fixture: {args.fixture})" if args.fixture else
                 f" via gh, org {ORG}"))
        doc = build(source, org_rows, projects, people)
        write_atomic(args.out, dump(doc))
    except Abort as exc:
        print(f"\nABORT: {exc}", file=sys.stderr)
        raise SystemExit(1)

    people_count = sum(len(p["contributors"]) for p in doc["projects"].values())
    cut = sum(p.get("truncated", 0) for p in doc["projects"].values())
    print(f"wrote {args.out}: {len(doc['projects'])} projects, "
          f"{people_count} rows kept, {cut} beyond the per-project top {TOP_N}")


if __name__ == "__main__":
    main()
