#!/usr/bin/env python3
# Author: Kyle Nelson
# Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
# Last substantive modification: 19 October 2026
# Affiliation: TUHH HippoCampus Robotics
# Purpose: Build data/graph/edit-access.json: who may edit each project, from commits and the admin's add and remove lists.
"""Build data/graph/edit-access.json — who may edit each project.

Run it with plain python3 from the repo root (no network; tools/derive.py runs
it on every call):

    python3 tools/build_edit_access.py           # write the file
    python3 tools/build_edit_access.py --check   # exit 1 when it is out of step

The rule (Kyle, 2026-10-19), for each project and each person:

    in the project's `remove` list             -> not an editor ("removed")
    else at least one commit in its repos      -> editor, why "commits"
    else in the project's `add` list           -> editor, why "added"
    else                                       -> not an editor

So commits come first, and an admin's add or remove always wins. Admins and
Maintainers edit every project anyway; this file does not need to list them.

Where the inputs come from:
  data/projects.json            each project's `add` and `remove` lists
  data/graph/contributors.json  each project's `repos` and `commits`
                                ({login: {repo: count}}, uncapped; written by
                                tools/build_contributors.py)
  data/github-links.json        `exclude`: org service accounts, never counted

GitHub logins are not case-sensitive, so every comparison is in lowercase. The
output keeps GitHub's spelling from contributors.json `commits`, else the
spelling of the add or remove list. Bots (a login ending in "[bot]") and
excluded logins never count as commits.

Output (indent=1, sorted keys, trailing newline, NO timestamp, so the bytes
change only when access changes):

    {"note": "<one sentence>",
     "projects": {"<id>": {"repos": <number of counted repos>,
        "editors": [{"login", "why": "commits"|"added", "repos_with_commits"}],
        "removed": [{"login", "had_commits": true|false}]}}}

Both lists are sorted by login in lowercase. Who reads it: tools/build_codeowners.py
(.github/CODEOWNERS, which GitHub enforces), js/cms-core.js and the editor (what
the site shows), tools/go_live.mjs (whose approvals count). None of them
re-computes the rule.

Fail-safe: when contributors.json (or github-links.json) is missing or
unreadable, or a project's entry in it lacks `repos` or `commits`, this prints
where and exits 1 and writes nothing, so the previous file stays. An index
project with NO entry in contributors.json (a project added since the last
contributor build) gets its add list only, and a printed note.
"""
import argparse
import json
import os
import re
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = "data/projects.json"
CONTRIBUTORS = "data/graph/contributors.json"
LINKS = "data/github-links.json"
OUT = "data/graph/edit-access.json"
# A login that may hold commits: 1-39 letters, digits or hyphens, not starting
# with a hyphen. Looser than today's sign-up rule on purpose: older GitHub
# accounts such as "a--b" or "a-" exist and can hold commits in a lab repo.
# tools/check.py uses this very pattern for contributors.json's commit logins
# (section 10) and for edit-access.json's logins (section 10b), so the builder
# never writes a login the gate refuses. A commit key that does not match
# never counts. tools/check.py holds the hand-kept add/remove lists to this
# same pattern, so an admin can remove (or add) any login that can be an editor.
COMMIT_LOGIN_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")
NOTE = ("Derived by tools/build_edit_access.py from data/projects.json (add, remove) and "
        "data/graph/contributors.json (commits): a person in a project's remove list cannot edit it; "
        "else one commit in its repos, or a place in its add list, lets them edit it.")


class Abort(Exception):
    """A located reason to stop without writing anything."""


def _key(login):
    return login.lower()


def _login_list(entry, key, pid):
    value = entry.get(key, [])
    if not isinstance(value, list) or not all(isinstance(x, str) for x in value):
        raise Abort(f"{INDEX}: '{pid}' `{key}` must be a list of GitHub logins — fix the index (tools/check.py names it)")
    return value


def _bucket(contributors, pid):
    """The project's ({repo, ...}, {login: {repo: count}}) or None when it has no bucket."""
    bucket = contributors["projects"].get(pid)
    if bucket is None:
        return None
    if not isinstance(bucket, dict):
        raise Abort(f"{CONTRIBUTORS}: '{pid}' must be an object — re-run tools/build_contributors.py")
    for key in ("repos", "commits"):
        if key not in bucket:
            raise Abort(f"{CONTRIBUTORS}: '{pid}' has no '{key}' (an older contributors.json) — "
                        f"re-run tools/build_contributors.py")
    repos, commits = bucket["repos"], bucket["commits"]
    if not isinstance(repos, list) or not all(isinstance(r, str) for r in repos):
        raise Abort(f"{CONTRIBUTORS}: '{pid}' 'repos' must be a list of repo names — re-run tools/build_contributors.py")
    if not isinstance(commits, dict) or not all(
            isinstance(v, dict) and all(isinstance(r, str) for r in v) for v in commits.values()):
        raise Abort(f"{CONTRIBUTORS}: '{pid}' 'commits' must map each login to {{repo: count}} — "
                    f"re-run tools/build_contributors.py")
    return set(repos), commits


def _count(n):
    return n if isinstance(n, int) and not isinstance(n, bool) and n > 0 else 0


def effective_access(index, contributors, links, notes=None):
    """The edit-access document for parsed inputs. Pure: reads nothing, writes
    nothing. `notes` (a list), when given, gains one line per index project that
    has no contributors entry. Raises Abort on a shape it cannot trust."""
    if not isinstance(index, dict) or not isinstance(index.get("projects"), list):
        raise Abort(f"{INDEX}: expected an object with a 'projects' list")
    if not isinstance(contributors, dict) or not isinstance(contributors.get("projects"), dict):
        raise Abort(f"{CONTRIBUTORS}: expected an object with a 'projects' object — re-run tools/build_contributors.py")
    exclude = links.get("exclude", []) if isinstance(links, dict) else []
    skip = {_key(x) for x in exclude if isinstance(x, str)} if isinstance(exclude, list) else set()

    projects = {}
    for entry in index["projects"]:
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str):
            continue
        pid = entry["id"]
        add = _login_list(entry, "add", pid)
        remove = _login_list(entry, "remove", pid)
        found = _bucket(contributors, pid)
        if found is None:
            repos, commits = set(), {}
            if notes is not None:
                notes.append(f"'{pid}' has no entry in {CONTRIBUTORS} yet: its add list only "
                             f"(the next contributor build counts its commits)")
        else:
            repos, commits = found

        # who has commits here, by lowercase login -> (GitHub's spelling, repos with a commit)
        committed = {}
        for login in sorted(commits):
            if login.endswith("[bot]") or not COMMIT_LOGIN_RE.match(login) or _key(login) in skip:
                continue
            k = sum(1 for repo, n in commits[login].items() if repo in repos and _count(n))
            if k and _key(login) not in committed:
                committed[_key(login)] = (login, k)

        removed, gone = [], set()
        for login in remove:
            if _key(login) in gone:
                continue
            gone.add(_key(login))
            spelled = committed[_key(login)][0] if _key(login) in committed else login
            removed.append({"login": spelled, "had_commits": _key(login) in committed})

        editors, seen = [], set()
        for low, (login, k) in committed.items():
            if low not in gone:
                editors.append({"login": login, "why": "commits", "repos_with_commits": k})
                seen.add(low)
        for login in add:
            if _key(login) in gone or _key(login) in seen:
                continue
            seen.add(_key(login))
            editors.append({"login": login, "why": "added", "repos_with_commits": 0})

        order = lambda row: (_key(row["login"]), row["login"])  # noqa: E731
        projects[pid] = {"repos": len(repos), "editors": sorted(editors, key=order),
                         "removed": sorted(removed, key=order)}
    return {"note": NOTE, "projects": projects}


def dump(doc):
    return json.dumps(doc, indent=1, sort_keys=True, ensure_ascii=False) + "\n"


def _read(root, rel):
    path = Path(root) / rel
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise Abort(f"{rel}: missing — it is needed to decide who may edit; "
                    + ("run tools/build_contributors.py" if rel == CONTRIBUTORS else "restore it"))
    except (OSError, ValueError) as exc:
        raise Abort(f"{rel}: unreadable ({exc}) — fix or rebuild it")


def build(root=ROOT, notes=None):
    """The document for the files under `root`."""
    return effective_access(_read(root, INDEX), _read(root, CONTRIBUTORS), _read(root, LINKS), notes)


def write_atomic(path, text):
    """Temp file in the target directory, then rename — never a partial file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
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
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", default=str(ROOT), help="the repository to read and write (default: this one)")
    ap.add_argument("--check", action="store_true", help=f"exit 1 when {OUT} differs; write nothing")
    args = ap.parse_args(argv)
    notes = []
    try:
        text = dump(build(args.root, notes))
    except Abort as exc:
        print(f"build_edit_access: FAILED — {exc}; nothing written")
        return 1
    for line in notes:
        print(f"  note: {line}")
    path = Path(args.root) / OUT
    have = path.read_text(encoding="utf-8") if path.exists() else None
    if args.check:
        if have != text:
            print(f"{OUT} is out of step with its inputs: run python3 tools/build_edit_access.py")
            return 1
        print(f"{OUT}: in step")
        return 0
    if have != text:
        write_atomic(path, text)
    doc = json.loads(text)
    editors = sum(len(p["editors"]) for p in doc["projects"].values())
    print(f"wrote {OUT}: {len(doc['projects'])} projects, {editors} editor entries")
    return 0


if __name__ == "__main__":
    sys.exit(main())
