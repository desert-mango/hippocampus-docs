#!/usr/bin/env python3
# Author: Kyle Nelson
# Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
# Last substantive modification: 29 September 2026
# Affiliation: TUHH HippoCampus Robotics
# Purpose: Project public GitHub org activity, repo cards, page authorship and people into privacy-filtered site data.
"""Build the GitHub layer under data/graph/ — the four public files and avatars.

Run it with plain python3 from the repo root (needs the `gh` CLI, logged in;
public reads only):

    python3 tools/build_github_data.py

Outputs (plan D-B; the exact key sets are section 11 of tools/check.py, held
in tools/github_layer_rules.py, which this script also runs on its outputs
before it writes anything):

  data/graph/org-activity.json   totals, the 53-week heatmap, the most active
                                 repositories, recent commits as
                                 {repo, sha, date, msg} (NO author fields),
                                 releases; forks excluded from every number
  data/graph/github-repos.json   repository metadata (the repo cards), public
                                 repositories only (private: false)
  data/graph/page-authors.json   who wrote each page — names only, no counts,
                                 no dates: the original authors (the old docs
                                 repository for setup pages, this repository
                                 for project/tool/about pages), the conversion,
                                 and this repository's pull requests
  data/graph/people-public.json  per login: login, display name, a committed
                                 avatar path, profile link, roster name; the
                                 logins of contributors.json (via a project
                                 with a non-fork org repo) and page-authors
  data/graph/avatars/<login>.<png|jpg>  64-px copies (PNG/JPEG by magic
                                 bytes, at most 16 KB, never SVG)

Reads (plan D-K; typically under 100 calls, under 250 worst case):
  orgs/<org>/repos?type=public            every public repository (paged)
  repos/<org>/<repo>/commits?since=…      non-fork repos pushed inside the
                                          365-day window; Link: rel="next"
                                          followed up to 5 pages, then the
                                          repo is named in "truncated"
  repos/<org>/<repo>/releases             the same repos, paged the same way
                                          (a cut names the repo in "truncated",
                                          so a count is never silently short)
  users/<login>                           display name and avatar id only
  repos/<org>/docs/commits?path=…         the old docs history of a setup page:
                                          the current path, then the pre-move
                                          path (and the pre-restructure one)
                                          with until=2025-03-11, de-duplicated
                                          by commit sha — FROZEN: cached in the
                                          committed page-authors.json, re-read
                                          only for pages missing from it
  repos/<this>/commits?path=…             project/tool/about page history,
                                          cached per page by the file's blob
                                          sha at HEAD, re-read when it changed
  repos/<this>/pulls?state=all            this repository's pull requests;
  repos/<this>/pulls/<n>/files            the file list of a closed/merged PR
                                          is read once (its number joins
                                          "prs_read"); open PRs every time

Privacy (plan D-B2): a commit's e-mail is never copied; profile fields
(email, location, company, bio, …) are never copied — a profile key reaching
an output is a STRUCTURAL LEAK and aborts the build. Free text (commit
message first line, at most 100 characters; display and git names; repository
descriptions; release names) is untrusted: '<' and '>' are stripped, and any
e-mail-shaped or on…=-shaped substring (the gate's own patterns) becomes
[redacted] with a warning naming the repository and sha — never an abort.
Bots are dropped; logins in data/github-links.json "exclude" are left out of
the people data entirely — cached and frozen author lists included. Avatars
are fetched from avatars.githubusercontent.com only (a redirect anywhere else
is refused); a Link header is followed only to https://api.github.com/.

Failure policy: any read that fails aborts with exit 1, and nothing is written
until everything has been read, projected and checked — so an aborted run
leaves the previous files byte-identical. tools/derive.py runs this LAST and
soft-fails on it (the site's other derived data still refreshes).

--fixture <dir> replaces every gh call with a raw response file, looked up in
<dir>/index.json by method + path + query (the layout of
tools/tests/fixtures/github-data/, see its README); avatars come from
<dir>/avatars/<id>.png|jpg. --today pins the day (tests); --root builds
another tree.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import github_layer_rules as rules  # noqa: E402
import github_names  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
ORG = rules.ORG
THIS_REPO = rules.THIS_REPO
OLD_DOCS_REPO = rules.OLD_DOCS_REPO
API_HOST = "https://api.github.com/"
AVATAR_NETLOC = "avatars.githubusercontent.com"
AVATAR_HOST = f"https://{AVATAR_NETLOC}/"
AVATAR_URL = AVATAR_HOST + "u/{id}?s=64&v=4"
GENERATED = "run tools/build_github_data.py to regenerate"
PER_PAGE = "100"
MAX_PAGES = 5                  # per paged read (plan D-K)
WINDOW_DAYS = 365
HEATMAP_WEEKS = 53
RECENT_COMMITS = 25
ACTIVE_REPOS = 8
RECENT_RELEASES = 10

# The old docs repository moved every page under contents/ on 2025-03-10
# ("moving all contents to seperate folder", dc94dad). The same day, a
# restructure (822b8c8) had renamed raspberry_pi_4b_setup/ to
# raspberry_pi_setup/. GitHub's commits?path= does not follow renames, so each
# older path is its own read, bounded by OLD_DOCS_UNTIL. Hand-kept.
OLD_DOCS_MOVED_PREFIX = "contents/"
OLD_DOCS_UNTIL = "2025-03-11T00:00:00Z"
OLD_DOCS_RENAMES = {"raspberry_pi_setup/": ("raspberry_pi_4b_setup/",)}
# Every setup page was converted from the old docs by one commit (a fixed fact
# of this repository's history, not re-read).
CONVERSION = {"date": "2026-08-28", "by": "kyle-nelson-berkeley",
              "tool": "tools/rst_convert.py", "commit": "b40ade4"}

PAGE_NOTE = ("who wrote each page: names only, no counts and no dates; "
             "'original' follows a setup page across the old docs repository's "
             "2025-03-10 folder move; 'blob' is the cache key of pages whose "
             "history lives in this repository")
PEOPLE_NOTE = ("public GitHub data only: login, the display name GitHub "
               "publishes, a 64-px avatar copy, the profile link and the "
               "People-roster name it matches (tools/github_names.py)")
REPO_NAME_RE = re.compile(r"[A-Za-z0-9._-]{1,100}")


class Abort(RuntimeError):
    """Anything that must stop the whole run rather than write partial data."""


class NotFound(Abort):
    """A 404 from GitHub (a deleted account, say)."""


class DownloadFailed(Exception):
    """An avatar could not be fetched; the person keeps no avatar."""


# =========================================================================
# sources: gh, or a fixture directory
# =========================================================================
def parse_link_next(value):
    """The rel="next" URL of a Link header, exactly as given, or None."""
    for part in (value or "").split(","):
        m = re.match(r'\s*<([^>]+)>\s*;\s*rel="([^"]+)"', part)
        if m and "next" in m.group(2).split():
            return m.group(1)
    return None


def _headers(lines):
    out = {}
    for line in lines:
        if ":" in line:
            k, v = line.split(":", 1)
            out[k.strip().lower()] = v.strip()
    return out


API_PATH_RE = re.compile(r"/[A-Za-z0-9._~%+-]+(?:/[A-Za-z0-9._~%+-]+)*")


def api_path(url):
    """The path?query of a GitHub API URL (what `gh api` is given); refuses
    any other scheme, host, port or user part, a fragment, and any path that
    is not plain segments (no '//', no '..', nothing URL-shaped)."""
    try:
        parts = urllib.parse.urlsplit(url)
        port = parts.port
    except ValueError:
        raise Abort(f"refusing an unparseable Link: {url[:80]}") from None
    if parts.scheme != "https" or parts.netloc != "api.github.com" or port \
            or parts.fragment or not API_PATH_RE.fullmatch(parts.path) \
            or any(seg in (".", "..") for seg in parts.path.split("/")):
        raise Abort(f"refusing to follow a Link outside {API_HOST}: {url[:80]}")
    return parts.path.lstrip("/") + (f"?{parts.query}" if parts.query else "")


def _avatar_url_ok(url):
    try:
        parts = urllib.parse.urlsplit(url)
        return parts.scheme == "https" and parts.netloc == AVATAR_NETLOC \
            and parts.port is None
    except ValueError:
        return False


class AvatarRedirects(urllib.request.HTTPRedirectHandler):
    """A redirect may only lead to another avatars.githubusercontent.com URL."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not _avatar_url_ok(newurl):
            raise DownloadFailed(f"refused a redirect off {AVATAR_NETLOC}: {newurl[:60]}")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


AVATAR_OPENER = urllib.request.build_opener(AvatarRedirects)


class GhApi:
    """GitHub through `gh api --include` (so the Link header is visible)."""

    def __init__(self):
        self.calls = 0

    def _run(self, endpoint):
        self.calls += 1
        try:
            proc = subprocess.run(["gh", "api", "--include", endpoint],
                                  capture_output=True, text=True)
        except FileNotFoundError:
            raise Abort("the gh CLI is not installed or not on PATH") from None
        if proc.returncode != 0:
            msg = (proc.stderr.strip() or proc.stdout.strip()[:200])
            if "HTTP 404" in proc.stderr:
                raise NotFound(f"{endpoint}: not found")
            raise Abort(f"{endpoint}: gh exited {proc.returncode} — {msg}")
        head, _, body = proc.stdout.replace("\r\n", "\n").partition("\n\n")
        # a 1xx/redirect preamble can precede the real header block
        while body.startswith("HTTP/"):
            head, _, body = body.partition("\n\n")
        try:
            data = json.loads(body) if body.strip() else []
        except ValueError as exc:
            raise Abort(f"{endpoint}: unparseable JSON — {exc}") from None
        return data, parse_link_next(_headers(head.split("\n")[1:]).get("link"))

    def get(self, path, query):
        qs = urllib.parse.urlencode(list(query.items()))
        return self._run(path + (f"?{qs}" if qs else ""))

    def get_url(self, url):
        return self._run(api_path(url))

    def download(self, url):
        if not _avatar_url_ok(url):
            raise DownloadFailed(f"not an avatar URL: {url[:60]}")
        try:
            with AVATAR_OPENER.open(url, timeout=20) as resp:
                if not _avatar_url_ok(resp.geturl()):
                    raise DownloadFailed(f"ended off {AVATAR_NETLOC}")
                return resp.read(rules.AVATAR_MAX_BYTES + 1)
        except OSError as exc:
            raise DownloadFailed(str(exc)) from None


class FixtureApi:
    """The offline twin: raw responses from <dir>/index.json (U0's layout)."""

    def __init__(self, root):
        self.root = Path(root)
        try:
            self.index = json.loads((self.root / "index.json").read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise Abort(f"cannot read fixture index {self.root}/index.json: {exc}") from None
        self.calls = 0
        self.seen = []

    def _find(self, path, query):
        path = "/" + path.lstrip("/")
        rows = [r for r in self.index.get("requests", [])
                if r.get("method", "GET") == "GET" and r.get("path") == path]
        exact = [r for r in rows if r.get("query", {}) == query]
        if exact:
            return exact[0]
        # the U0 commit captures widen `since` for two repos (README): a
        # request that differs from one capture in `since` alone gets it
        near = [r for r in rows if set(r.get("query", {})) == set(query)
                and {k: v for k, v in r["query"].items() if k != "since"}
                == {k: v for k, v in query.items() if k != "since"}]
        if len(near) == 1:
            return near[0]
        raise Abort(f"GET {path}?{urllib.parse.urlencode(query)}: no fixture payload")

    def get(self, path, query):
        self.calls += 1
        self.seen.append((path, dict(query)))
        row = self._find(path, query)
        if row.get("status", 200) == 404:
            raise NotFound(f"{path}: not found")
        try:
            data = json.loads((self.root / row["body"]).read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise Abort(f"{path}: unreadable fixture body — {exc}") from None
        link = None
        if row.get("headers"):
            sidecar = self.root / row["headers"]
            if sidecar.exists():
                link = _headers(sidecar.read_text(encoding="utf-8").splitlines()[1:]).get("link")
        return data, parse_link_next(link)

    def get_url(self, url):
        rest = api_path(url)
        path, _, qs = rest.partition("?")
        return self.get(path, dict(urllib.parse.parse_qsl(qs, keep_blank_values=True)))

    def download(self, url):
        m = re.search(r"/u/(\d+)", url)
        for ext in ("png", "jpg", "bin"):
            p = self.root / "avatars" / f"{m.group(1) if m else 'x'}.{ext}"
            if p.exists():
                return p.read_bytes()
        raise DownloadFailed("no fixture avatar")


def paged(api, path, query, max_pages=MAX_PAGES):
    """(every item over up to max_pages pages, truncated?)."""
    data, nxt = api.get(path, query)
    if not isinstance(data, list):
        raise Abort(f"{path}: expected a list, got {type(data).__name__}")
    items, pages = list(data), 1
    while nxt and pages < max_pages:
        data, nxt = api.get_url(nxt)
        if not isinstance(data, list):
            raise Abort(f"{path}: page {pages + 1} is not a list")
        items.extend(data)
        pages += 1
    return items, bool(nxt)


# =========================================================================
# pure projection
# =========================================================================
class Log:
    def __init__(self):
        self.warnings = []

    def warn(self, msg):
        self.warnings.append(msg)
        print(f"  warning: {msg}")


def clean(text, where, log):
    """Free text from GitHub, made safe: see rules.redact()."""
    out, reasons = rules.redact(text if isinstance(text, str) else "")
    if reasons:
        log.warn(f"redacted {', '.join(reasons)} in {where}")
    return out.strip()


def first_line(message):
    return (message or "").replace("\r", "").split("\n", 1)[0].strip()


def clean_msg(message, where, log):
    """Redact the WHOLE first line, then cut it to MSG_MAX: cutting first would
    leave the head of an address that crosses the cut ("someone@exampl")."""
    msg = clean(first_line(message), where, log)[:rules.MSG_MAX]
    # a cut cannot create a match the full line did not have; re-clean anyway
    return clean(msg, where, log)


def is_bot_login(login):
    return isinstance(login, str) and login.endswith("[bot]")


def commit_facts(c):
    """The only fields a commit contributes (never an e-mail)."""
    commit = c.get("commit") or {}
    author = commit.get("author") or {}
    gh = c.get("author") if isinstance(c.get("author"), dict) else None
    login = gh.get("login") if gh else None
    name = author.get("name") or ""
    bot = bool(gh and (gh.get("type") == "Bot" or is_bot_login(login))) \
        or is_bot_login(name)
    return {"sha": str(c.get("sha") or ""), "ts": str(author.get("date") or ""),
            "login": login, "name": name, "message": commit.get("message") or "",
            "bot": bot}


def heatmap(today, per_day):
    monday = today - dt.timedelta(days=today.weekday())
    start = monday - dt.timedelta(weeks=HEATMAP_WEEKS - 1)
    weeks = []
    for w in range(HEATMAP_WEEKS):
        first = start + dt.timedelta(weeks=w)
        days = []
        for d in range(7):
            day = first + dt.timedelta(days=d)
            days.append(per_day.get(day.isoformat(), 0) if day <= today else None)
        weeks.append({"week": first.isoformat(), "days": days})
    return weeks


def author_rank(rows):
    """[{login, name}] ordered by commit count (desc), then name — no counts."""
    counts, names = Counter(), {}
    for r in rows:
        key = ("login", r["login"]) if r["login"] else ("name", r["name"].casefold())
        counts[key] += 1
        names.setdefault(key, r)
    order = sorted(counts, key=lambda k: (-counts[k], names[k]["name"].casefold(), str(k)))
    return [{"login": names[k]["login"], "name": names[k]["name"]} for k in order]


def git_blob_sha(root, rel):
    """The file's blob sha at HEAD; the same sha computed from the file when
    git cannot answer (not a checkout, or an uncommitted file)."""
    proc = subprocess.run(["git", "-C", str(root), "rev-parse", f"HEAD:{rel}"],
                          capture_output=True, text=True)
    sha = proc.stdout.strip()
    if proc.returncode == 0 and re.fullmatch(r"[0-9a-f]{40}", sha):
        return sha
    data = (Path(root) / rel).read_bytes()
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def old_docs_paths(old):
    """[(path, until or None)] for one setup page's old docs history."""
    reads = [(f"{old}.rst", None)]
    if old.startswith(OLD_DOCS_MOVED_PREFIX):
        pre = old[len(OLD_DOCS_MOVED_PREFIX):]
        reads.append((f"{pre}.rst", OLD_DOCS_UNTIL))
        for prefix, older in OLD_DOCS_RENAMES.items():
            if pre.startswith(prefix):
                for o in older:
                    reads.append((f"{o}{pre[len(prefix):]}.rst", OLD_DOCS_UNTIL))
    return reads


def enumerate_pages(setup, projects, tools):
    """[(page key, content file, old docs stem or None)] — check.py's ids."""
    rows = []
    for sec in setup["sections"]:
        for p in sec["pages"]:
            old = p.get("old")
            rows.append((f"setup/{p['id']}", p["file"],
                         old if isinstance(old, str) and old else None))
    for pr in projects["projects"]:
        rows.append((f"projects/{pr['id']}", pr["file"], None))
    for t in tools["tools"]:
        rows.append((f"tools/{t['id']}", t["file"], None))
    rows.append(("about", "content/about.md", None))
    return rows


# =========================================================================
# the build
# =========================================================================
class Build:
    def __init__(self, api, root, today, log=None):
        self.api, self.root, self.today = api, Path(root), today
        self.log = log or Log()
        self.read_at = today.isoformat()
        self.window_start = today - dt.timedelta(days=WINDOW_DAYS)
        self.since = f"{self.window_start.isoformat()}T00:00:00Z"
        self.bots = set()

    def load(self, rel, default=None):
        p = self.root / rel
        if not p.exists():
            if default is not None:
                return default
            raise Abort(f"{rel}: missing")
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except ValueError as exc:
            raise Abort(f"{rel}: unparseable — {exc}") from None

    def previous(self, name):
        """The committed output (the cache), or {} when absent or unusable."""
        p = self.root / rules.FILES[name]
        try:
            doc = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
        except ValueError:
            self.log.warn(f"{rules.FILES[name]} does not parse — its cache is ignored")
            return {}
        return doc if isinstance(doc, dict) else {}

    # ---- repositories + activity -------------------------------------
    def repositories(self):
        rows, truncated = paged(self.api, f"orgs/{ORG}/repos",
                                {"type": "public", "per_page": PER_PAGE}, max_pages=10)
        if truncated:
            raise Abort(f"orgs/{ORG}/repos: more than 10 pages — raise the cap")
        repos = []
        for r in rows:
            name = r.get("name") if isinstance(r, dict) else None
            if not (isinstance(name, str) and REPO_NAME_RE.fullmatch(name)):
                self.log.warn(f"skipped a repository with an unusable name: {str(name)[:40]!r}")
                continue
            if r.get("private") is not False:
                self.log.warn(f"dropped '{name}': not a public repository")
                continue
            repos.append(r)
        return sorted(repos, key=lambda r: r["name"])

    def activity(self, repos):
        excluded = self.excluded
        flat, truncated, per_repo = [], [], Counter()
        release_rows = []
        for r in repos:
            if r.get("fork") or (r.get("pushed_at") or "") < self.since:
                continue
            name = r["name"]
            commits, cut = paged(self.api, f"repos/{ORG}/{name}/commits",
                                 {"since": self.since, "per_page": PER_PAGE})
            if cut:
                truncated.append(name)
            for c in commits:
                f = commit_facts(c)
                day = f["ts"][:10]
                if f["bot"] or not (self.window_start.isoformat() <= day <= self.read_at):
                    continue
                f["repo"] = name
                flat.append(f)
                per_repo[name] += 1
            releases, cut = paged(self.api, f"repos/{ORG}/{name}/releases",
                                  {"per_page": PER_PAGE})
            if cut and name not in truncated:
                truncated.append(name)         # a count is never silently short
            for rel in releases:
                if not isinstance(rel, dict) or rel.get("draft"):
                    continue
                day = str(rel.get("published_at") or "")[:10]
                if not (self.window_start.isoformat() <= day <= self.read_at):
                    continue
                # the build log is public in CI: a label names the repo and
                # the CLEANED tag, never the raw text GitHub sent
                tag = clean(rel.get("tag_name") or "", f"{name} release tag", self.log)
                release_rows.append({"repo": name, "tag": tag,
                                     "name": clean(rel.get("name") or tag,
                                                   f"{name} release {tag[:30]}", self.log),
                                     "date": day})
        flat.sort(key=lambda f: (f["ts"], f["repo"], f["sha"]), reverse=True)
        authors = {("login", f["login"]) if f["login"] else ("name", f["name"].casefold())
                   for f in flat if f["login"] not in excluded}
        per_day = Counter(f["ts"][:10] for f in flat)
        by_name = {r["name"]: r for r in repos}
        active = sorted(per_repo, key=lambda n: (-per_repo[n], n))[:ACTIVE_REPOS]
        release_rows.sort(key=lambda r: (r["date"], r["repo"], r["tag"]), reverse=True)
        doc = {
            "generated": GENERATED,
            "read_at": self.read_at,
            "org": ORG,
            "window_days": WINDOW_DAYS,
            "totals": {
                "public_repos": len(repos),
                "commits_365d": len(flat),
                "authors_365d": len(authors),
                "repos_touched_365d": len(per_repo),
                "stars": sum(int(r.get("stargazers_count") or 0) for r in repos),
                "forks": sum(int(r.get("forks_count") or 0) for r in repos),
                "open_issues": sum(int(r.get("open_issues_count") or 0) for r in repos),
                "releases": len(release_rows),
            },
            "weeks": heatmap(self.today, per_day),
            "recent_commits": [
                {"repo": f["repo"], "sha": f["sha"][:7], "date": f["ts"][:10],
                 "msg": clean_msg(f["message"], f"{f['repo']}@{f['sha'][:7]}", self.log)}
                for f in flat[:RECENT_COMMITS]],
            "most_active_repos": [
                {"name": n, "commits": per_repo[n], "language": by_name[n].get("language"),
                 "pushed_at": str(by_name[n].get("pushed_at") or "")[:10]}
                for n in active],
            "releases": release_rows[:RECENT_RELEASES],
            "truncated": sorted(truncated),
        }
        cards = {}
        for r in repos:
            name = r["name"]
            cards[name] = {
                "name": name,
                "description": clean(r.get("description") or "", f"{name} description",
                                     self.log),
                "language": r.get("language") if isinstance(r.get("language"), str) else None,
                "stars": int(r.get("stargazers_count") or 0),
                "forks": int(r.get("forks_count") or 0),
                "open_issues": int(r.get("open_issues_count") or 0),
                "pushed_at": str(r.get("pushed_at") or "")[:10],
                "archived": bool(r.get("archived")),
                "fork": bool(r.get("fork")),
                "private": False,
                "commits_365d": per_repo.get(name, 0),
                "html_url": f"https://github.com/{ORG}/{name}",
            }
        repos_doc = {"generated": GENERATED, "read_at": self.read_at, "org": ORG,
                     "repos": cards}
        return doc, repos_doc

    # ---- page authorship -------------------------------------------------
    def history(self, repo, path, until=None):
        query = {"path": path}
        if until:
            query["until"] = until
        query["per_page"] = PER_PAGE
        rows, _ = paged(self.api, f"repos/{repo}/commits", query)
        return [commit_facts(c) for c in rows]

    def page_authors(self, pages):
        prev = self.previous("page-authors")
        prev_pages = prev.get("pages") if isinstance(prev.get("pages"), dict) else {}
        out = {}
        for key, rel, old in pages:
            before = prev_pages.get(key) if isinstance(prev_pages.get(key), dict) else {}
            porig = before.get("original") if isinstance(before.get("original"), dict) else {}
            if old:
                path = f"{old}.rst"
                if porig.get("repo") == OLD_DOCS_REPO and porig.get("path") == path \
                        and porig.get("history_read") is True \
                        and isinstance(porig.get("authors"), list):
                    authors = porig["authors"]            # frozen history: cached
                else:
                    seen, rows = set(), []
                    for p, until in old_docs_paths(old):
                        for f in self.history(OLD_DOCS_REPO, p, until):
                            if f["sha"] in seen:
                                continue
                            seen.add(f["sha"])
                            rows.append(f)
                    authors = self.project_authors(rows, f"{OLD_DOCS_REPO}:{path}")
                original = {"repo": OLD_DOCS_REPO, "path": path, "authors": authors,
                            "history_read": True, "blob": None}
                converted = dict(CONVERSION)
            else:
                if not (self.root / rel).is_file():
                    raise Abort(f"{rel}: the page file is missing")
                blob = git_blob_sha(self.root, rel)
                if porig.get("repo") == THIS_REPO and porig.get("blob") == blob \
                        and isinstance(porig.get("authors"), list):
                    authors = porig["authors"]            # unchanged since: cached
                else:
                    authors = self.project_authors(self.history(THIS_REPO, rel),
                                                   f"{THIS_REPO}:{rel}")
                original = {"repo": THIS_REPO, "path": rel, "authors": authors,
                            "history_read": True, "blob": blob}
                converted = None
            out[key] = {"original": original, "converted": converted, "edited_here": []}
        prs_read = self.edits(out, pages, prev, prev_pages)
        return {"generated": GENERATED, "read_at": self.read_at, "note": PAGE_NOTE,
                "prs_read": prs_read, "pages": {k: out[k] for k in sorted(out)}}

    def project_authors(self, rows, where):
        keep = []
        for f in rows:
            if f["bot"] or f["login"] in self.excluded:
                continue
            name = clean(f["name"], f"{where}@{f['sha'][:7]} author name", self.log)
            keep.append({"login": f["login"], "name": name or (f["login"] or "unknown")})
        return author_rank(keep)

    def edits(self, out, pages, prev, prev_pages):
        by_file = {rel: key for key, rel, _old in pages}
        prev_read = {n for n in prev.get("prs_read", []) if isinstance(n, int)} \
            if isinstance(prev.get("prs_read"), list) else set()
        pulls, _ = paged(self.api, f"repos/{THIS_REPO}/pulls",
                         {"state": "all", "per_page": PER_PAGE})
        read = set()
        for pr in sorted(pulls, key=lambda p: p.get("number") or 0):
            n, user = pr.get("number"), pr.get("user") or {}
            login = user.get("login")
            if not isinstance(n, int) or not isinstance(login, str) \
                    or user.get("type") == "Bot" or is_bot_login(login) \
                    or login in self.excluded:
                continue
            state = "open" if pr.get("state") == "open" else \
                ("merged" if pr.get("merged_at") else "closed")
            if state != "open" and n in prev_read:
                read.add(n)                    # closed file lists are cached
                for key in out:
                    old = prev_pages.get(key) if isinstance(prev_pages.get(key), dict) else {}
                    for e in old.get("edited_here") or []:
                        if isinstance(e, dict) and e.get("pr") == n:
                            out[key]["edited_here"].append(
                                {"pr": n, "by": e.get("by"), "state": e.get("state")})
                continue
            files, _ = paged(self.api, f"repos/{THIS_REPO}/pulls/{n}/files",
                             {"per_page": PER_PAGE})
            touched = set()
            for f in files:
                for rel in (f.get("filename"), f.get("previous_filename")):
                    if rel in by_file:
                        touched.add(by_file[rel])
            for key in touched:
                out[key]["edited_here"].append({"pr": n, "by": login, "state": state})
            if state != "open":
                read.add(n)
        for page in out.values():
            page["edited_here"].sort(key=lambda e: e["pr"])
        return sorted(read)

    # ---- people ----------------------------------------------------------
    def people(self, page_doc):
        contrib = self.load(f"{rules.GRAPH}/contributors.json", default={})
        logins = set()
        # D-B: contributors.json counts NON-FORK org repositories only. It does
        # not say which repository a login came from, so the project's repo
        # list and this build's fork flags decide: a project with no non-fork
        # org repository publishes nobody (fail closed, e.g. a stale file)
        non_fork = {r["name"] for r in self.repo_rows if r.get("fork") is False}
        project_repos = {p.get("id"): {row.get("name") for row in p.get("repos") or []
                                       if isinstance(row, dict) and not row.get("external")}
                         for p in self.projects.get("projects") or []
                         if isinstance(p, dict)}
        for pid, bucket in (contrib.get("projects") or {}).items():
            rows = (bucket or {}).get("contributors") or []
            if not project_repos.get(pid, set()) & non_fork:
                if rows:
                    self.log.warn(f"contributors.json project '{pid}' has no non-fork "
                                  f"org repository — its logins are not published")
                continue
            for row in rows:
                if isinstance(row, dict) and isinstance(row.get("login"), str):
                    logins.add(row["login"])
        for page in page_doc["pages"].values():
            for a in page["original"]["authors"]:
                if a["login"]:
                    logins.add(a["login"])
            if page["converted"]:
                logins.add(page["converted"]["by"])
            for e in page["edited_here"]:
                logins.add(e["by"])
        profiles = {}
        for login in sorted(logins):
            if login in self.excluded or is_bot_login(login):
                continue
            if not rules.LOGIN_RE.fullmatch(login):
                self.log.warn(f"skipped an unusable login: {login[:40]!r}")
                continue
            try:
                payload, _ = self.api.get(f"users/{login}", {})
            except NotFound:
                self.log.warn(f"users/{login}: not found — kept by login, no avatar")
                payload = {}
            if not isinstance(payload, dict):
                raise Abort(f"users/{login}: expected an object")
            if payload.get("type") == "Bot":
                self.bots.add(login)
                continue
            # the ONLY profile fields ever read: display name, avatar id
            profiles[login] = {"name": payload.get("name"), "id": payload.get("id")}
        linked, warnings = github_names.match(
            {login: p["name"] for login, p in profiles.items()},
            github_names.roster_names(self.load("data/people.json", default={})),
            self.links)
        for w in warnings:
            self.log.warn(w)
        people, avatars = {}, {}
        for login, prof in profiles.items():
            avatar = self.avatar(login, prof["id"], avatars)
            people[login] = project_person(login, clean(
                prof["name"] or login, f"users/{login} name", self.log) or login,
                avatar, linked.get(login))
        return people, avatars

    def avatar(self, login, uid, staged):
        """The committed avatar path (reused, or downloaded now), or None."""
        base = self.root / rules.AVATAR_DIR
        for kind in ("png", "jpg"):
            p = base / f"{login}.{kind}"
            if p.is_file():
                data = p.read_bytes()
                if rules.sniff_image(data) == kind and len(data) <= rules.AVATAR_MAX_BYTES:
                    staged[rules.avatar_path(login, kind)] = data
                    return rules.avatar_path(login, kind)
        if not isinstance(uid, int) or isinstance(uid, bool):
            return None
        try:
            data = self.api.download(AVATAR_URL.format(id=uid))
        except DownloadFailed as exc:
            self.log.warn(f"avatar for {login} not downloaded ({exc}) — none shown")
            return None
        kind = rules.sniff_image(data)
        if kind is None:
            self.log.warn(f"avatar for {login} is not PNG or JPEG — none shown")
            return None
        if len(data) > rules.AVATAR_MAX_BYTES:
            self.log.warn(f"avatar for {login} is over {rules.AVATAR_MAX_BYTES} bytes "
                          f"— none shown")
            return None
        staged[rules.avatar_path(login, kind)] = data
        return rules.avatar_path(login, kind)

    # ---- everything ----------------------------------------------------
    def run(self):
        try:
            self.links = github_names.load_links(self.root / github_names.MAP_PATH)
        except ValueError as exc:
            raise Abort(f"{github_names.MAP_PATH}: {exc}") from None
        self.excluded = github_names.excluded_logins(self.links)
        setup = self.load("data/setup.json")
        projects = self.projects = self.load("data/projects.json")
        tools = self.load("data/tools.json")
        repos = self.repo_rows = self.repositories()
        activity, repo_doc = self.activity(repos)
        pages = self.page_authors(enumerate_pages(setup, projects, tools))
        people, avatars = self.people(pages)
        gone = self.bots | self.excluded
        for page in pages["pages"].values():
            # a Bot account found by its profile goes, and so does a login in
            # the map's "exclude" — cached and frozen entries included, which
            # never passed through project_authors(); a linked author is named
            # as the account's display name (the git name is only for authors
            # GitHub could not link), so a renamed account is picked up
            page["original"]["authors"] = [
                {"login": a["login"],
                 "name": people[a["login"]]["name"] if a["login"] in people else a["name"]}
                for a in page["original"]["authors"] if a["login"] not in gone]
            page["edited_here"] = [e for e in page["edited_here"] if e["by"] not in gone]
        people_doc = {"generated": GENERATED, "read_at": self.read_at, "org": ORG,
                      "note": PEOPLE_NOTE, "people": {k: people[k] for k in sorted(people)}}
        docs = {"org-activity": activity, "github-repos": repo_doc,
                "page-authors": pages, "people-public": people_doc}
        verify(docs, avatars)
        return docs, avatars


def project_person(login, name, avatar, roster):
    """The public person: exactly five fields (section 11)."""
    return {"login": login, "name": name, "avatar": avatar,
            "html_url": f"https://github.com/{login}", "roster": roster}


def verify(docs, avatars):
    """The shared rules over the outputs, BEFORE anything is written."""
    for name, doc in docs.items():
        leaks = rules.profile_key_leaks(doc)
        if leaks:
            raise Abort(f"STRUCTURAL LEAK: GitHub profile field(s) {leaks} reached "
                        f"{rules.FILES[name]} — nothing was written")
    problems = rules.check_github_layer(docs, avatars.get)
    problems += rules.check_avatar_files(
        [(rel.rsplit("/", 1)[1], data) for rel, data in avatars.items()])
    for name, doc in docs.items():
        for path, _key, value in rules._walk(doc):
            for _line, tok in rules.scan_markup(value):
                problems.append(f"{rules.FILES[name]}: active markup {tok} at '{path}'")
    if problems:
        raise Abort("the outputs fail the gate's own GitHub-layer rules — nothing was "
                    "written:\n  " + "\n  ".join(problems))


def dump(doc):
    return json.dumps(doc, indent=1, ensure_ascii=False) + "\n"


def write_all(root, docs, avatars):
    """Stage every file as a temp file, then rename them all; remove avatars
    of logins no longer present. Nothing is touched before all are staged."""
    root = Path(root)
    staged = []
    try:
        items = [(root / rules.FILES[name], dump(doc).encode("utf-8"))
                 for name, doc in docs.items()]
        items += [(root / rel, data) for rel, data in sorted(avatars.items())]
        for target, data in items:
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.is_file() and target.read_bytes() == data:
                continue                    # unchanged: leave the file alone
            fd, tmp = tempfile.mkstemp(dir=str(target.parent),
                                       prefix=target.name + ".", suffix=".tmp")
            with os.fdopen(fd, "wb") as fh:
                fh.write(data)
            staged.append((tmp, target))
    except BaseException:
        for tmp, _ in staged:
            try:
                os.unlink(tmp)
            except OSError:
                pass
        raise
    for tmp, target in staged:
        os.replace(tmp, str(target))
    keep = {Path(rel).name for rel in avatars}
    adir = root / rules.AVATAR_DIR
    if adir.is_dir():
        for p in adir.iterdir():
            if p.is_file() and p.name not in keep:
                p.unlink()


def main(argv=None):
    ap = argparse.ArgumentParser(description="Build the public GitHub layer under "
                                             "data/graph/ (see the module docstring).")
    ap.add_argument("--fixture", type=Path, default=None,
                    help="read raw responses from this directory instead of gh")
    ap.add_argument("--today", default=None, help="pin the day (YYYY-MM-DD); tests")
    ap.add_argument("--root", type=Path, default=ROOT, help="the site tree to build")
    args = ap.parse_args(argv)
    try:
        today = dt.date.fromisoformat(args.today) if args.today else \
            dt.datetime.now(dt.timezone.utc).date()
        api = FixtureApi(args.fixture) if args.fixture else GhApi()
        print(f"GitHub data for {ORG}" + (f" (fixture: {args.fixture})" if args.fixture
                                          else " via gh") + f", as of {today.isoformat()}")
        docs, avatars = Build(api, args.root, today).run()
        write_all(args.root, docs, avatars)
    except Abort as exc:
        print(f"\nABORT: {exc}", file=sys.stderr)
        raise SystemExit(1)
    t = docs["org-activity"]["totals"]
    print(f"wrote {len(docs)} files + {len(avatars)} avatars: {t['public_repos']} repos, "
          f"{t['commits_365d']} commits in {WINDOW_DAYS} days, "
          f"{len(docs['page-authors']['pages'])} pages, "
          f"{len(docs['people-public']['people'])} people; {api.calls} API calls")


if __name__ == "__main__":
    main()
