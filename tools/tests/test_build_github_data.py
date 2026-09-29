#!/usr/bin/env python3
# Author: Kyle Nelson
# Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
# Last substantive modification: 29 September 2026
# Affiliation: TUHH HippoCampus Robotics
# Purpose: Test the GitHub-layer builder on raw API fixtures: shapes, redaction, caching, paging and avatars.
"""Unit tests for tools/build_github_data.py.

Run from the repo root with plain python3 (no pytest, no gh, no network):

    python3 tools/tests/test_build_github_data.py

Every test drives the builder's --fixture mode over RAW GitHub responses: the
U0 captures in tools/tests/fixtures/github-data/ (read, never modified) plus
hostile cases written into a temporary fixture directory per test. The site
tree the builder reads (setup/projects/tools/people, contributors.json) is a
small temporary tree, so not one test touches data/graph/ of this repository.
"""
import copy
import datetime as dt
import io
import json
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import build_contributors as bc  # noqa: E402
import build_github_data as bgd  # noqa: E402
import check  # noqa: E402
import github_layer_rules as rules  # noqa: E402
import github_names as gn  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent.parent
U0 = ROOT / "tools" / "tests" / "fixtures" / "github-data"
TODAY = "2026-09-29"
SINCE = "2025-09-29T00:00:00Z"
PNG = rules.PNG_MAGIC + b"\x00" * 100
JPG = rules.JPEG_MAGIC + b"\xe0" + b"\x00" * 100
THIS = "/repos/desert-mango/hippocampus-docs"


def u0(name):
    return json.loads((U0 / name).read_text(encoding="utf-8"))


def commit(sha, date, login, name, message, bot=False):
    """A raw commits-API entry (GitHub's shape, trimmed to what matters)."""
    gh = None if login is None else {"login": login, "type": "Bot" if bot else "User",
                                     "id": 1}
    return {"sha": sha, "author": gh, "committer": gh,
            "commit": {"author": {"name": name, "email": "someone@example.invalid",
                                  "date": date},
                       "committer": {"name": name, "email": "someone@example.invalid",
                                     "date": date},
                       "message": message}}


class Fixture:
    """A temp fixture dir: index.json + bodies (+ header sidecars)."""

    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "avatars").mkdir()
        self.requests = []
        self.n = 0

    def add(self, path, query, body, link=None, status=200):
        self.n += 1
        name = f"b{self.n}.json"
        (self.root / name).write_text(json.dumps(body), encoding="utf-8")
        row = {"method": "GET", "path": path, "query": query, "status": status,
               "body": name}
        if link:
            (self.root / f"b{self.n}.headers").write_text(
                f"HTTP/2.0 200 OK\nLink: {link}\n", encoding="utf-8")
            row["headers"] = f"b{self.n}.headers"
        self.requests.append(row)

    def drop(self, where, **query):
        self.requests = [r for r in self.requests
                         if not (r["path"] == where and all(r["query"].get(k) == v
                                                           for k, v in query.items()))]

    def avatar(self, uid, data, ext="png"):
        (self.root / "avatars" / f"{uid}.{ext}").write_bytes(data)

    def save(self):
        (self.root / "index.json").write_text(json.dumps({"requests": self.requests}),
                                              encoding="utf-8")
        return self.root


def site_tree(root):
    """The registries the builder reads: 3 setup pages, 1 project, 1 tool, about."""
    root = Path(root)
    pages = [("raspberry-pi/ubuntu-24-04-server", "contents/raspberry_pi_setup/ubuntu_24.04_server_64bit"),
             ("raspberry-pi/ethernet", "contents/raspberry_pi_setup/ethernet"),
             ("getting-started/ros-installation", "contents/getting_started/ros_installation")]
    setup = {"sections": [{"id": "s", "title": "S", "pages": [
        {"id": pid, "title": pid, "file": f"content/setup/{pid}.md", "old": old}
        for pid, old in pages]}]}
    files = {f"content/setup/{pid}.md": f"# {pid}\n" for pid, _ in pages}
    files["content/projects/p1.md"] = "# P1\n"
    files["content/tools/t1.md"] = "# T1\n"
    files["content/about.md"] = "# About\n"
    docs = {
        "data/setup.json": setup,
        "data/projects.json": {"intro": "", "projects": [
            {"id": "p1", "name": "P1", "file": "content/projects/p1.md",
             "repos": [{"name": "docs"}]}]},
        "data/tools.json": {"intro": "", "tools": [
            {"id": "t1", "name": "T1", "file": "content/tools/t1.md"}]},
        "data/people.json": {"groups": [{"id": "a", "title": "A", "people": [
            {"name": n, "title": "", "photo": None, "link": None}
            for n in ("Kyle Nelson", "Nathalie Bauschmann", "Thies Lennart Alff",
                      "Daniel-André Dücker", "Finn Breuer", "Tim Hansen",
                      "René Hochdahl", "Vincent Lenz")]}]},
        "data/github-links.json": {"note": "t", "links": {"timzarhansen": "Tim Hansen",
                                                         "RHochdahl": "René Hochdahl"},
                                   "exclude": ["hippocampusmum"]},
        "data/graph/contributors.json": {"generated": "g", "org": "HippoCampusRobotics",
                                         "note": "n", "projects": {"p1": {"contributors": [
            {"login": "DanielDuecker", "name": "Daniel Duecker", "contributions": 3},
            {"login": "timzarhansen", "name": "Tim", "contributions": 2},
            {"login": "RHochdahl", "name": "RHochdahl", "contributions": 1},
            {"login": "hippocampusmum", "name": "hippocampusmum", "contributions": 1}]}}},
    }
    for rel, text in files.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(text, encoding="utf-8")
    for rel, doc in docs.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    return root


def standard_fixture(dirpath):
    """Raw U0 captures + synthetic answers for everything else a build reads."""
    fx = Fixture(dirpath)
    org = u0("org-repos.json")
    keep = {r["name"]: copy.deepcopy(r) for r in org
            if r["name"] in ("docs", "hippocampus_common", "mavros", "hippo_core")}
    keep["hippocampus_common"]["pushed_at"] = "2026-06-01T00:00:00Z"
    keep["mavros"]["pushed_at"] = "2026-06-01T00:00:00Z"     # a fork, pushed lately
    keep["hippo_core"]["pushed_at"] = "2024-01-01T00:00:00Z"   # outside the window
    fx.add("/orgs/HippoCampusRobotics/repos", {"type": "public", "per_page": "100"},
           [keep[n] for n in sorted(keep)])
    docs_commits = u0("commits-docs.json")
    fx.add("/repos/HippoCampusRobotics/docs/commits", {"since": SINCE, "per_page": "100"},
           docs_commits)
    common = u0("commits-hippocampus_common.json")
    for i, c in enumerate(common):         # move the 2022 history into the window
        c["commit"]["author"]["date"] = f"2026-0{1 + i % 8}-1{i % 9}T10:00:00Z"
    fx.add("/repos/HippoCampusRobotics/hippocampus_common/commits",
           {"since": SINCE, "per_page": "100"}, common)
    fx.add("/repos/HippoCampusRobotics/docs/releases", {"per_page": "100"},
           u0("releases-docs.json"))
    fx.add("/repos/HippoCampusRobotics/hippocampus_common/releases", {"per_page": "100"},
           [{"tag_name": "v1.0", "name": "First", "draft": False,
             "published_at": "2026-05-01T00:00:00Z"},
            {"tag_name": "v0.9", "name": "Draft", "draft": True,
             "published_at": "2026-05-02T00:00:00Z"}])
    # the old docs histories: the U0 captures, by their exact queries
    for row in u0("index.json")["requests"]:
        if row["body"].startswith("page-commits-"):
            fx.add(row["path"], row["query"], u0(row["body"]))
    for rel in ("content/projects/p1.md", "content/tools/t1.md", "content/about.md"):
        fx.add(f"{THIS}/commits", {"path": rel, "per_page": "100"},
               [commit("a" * 40, "2026-08-28T10:00:00Z", "kyle-nelson-berkeley",
                       "kyle", "first"),
                commit("b" * 40, "2026-09-01T10:00:00Z", None, "Desert Mango", "edit")])
    fx.add(f"{THIS}/pulls", {"state": "all", "per_page": "100"}, u0("pulls-all.json"))
    fx.add(f"{THIS}/pulls/1/files", {"per_page": "100"}, u0("pull-1-files.json"))
    fx.add(f"{THIS}/pulls/2/files", {"per_page": "100"},
           [{"filename": "content/about.md", "status": "modified"}])
    fx.add(f"{THIS}/pulls/3/files", {"per_page": "100"},
           [{"filename": "js/app.js", "status": "modified"},
            {"filename": "content/projects/p1.md", "status": "renamed",
             "previous_filename": "content/projects/old.md"}])
    users = {}
    for login in ("NBauschmann", "lennartalff", "DanielDuecker", "FinnBreu",
                  "RHochdahl", "timzarhansen"):
        users[login] = u0(f"user-{login}.json")
    me = u0("user.json")
    users["kyle-nelson-berkeley"] = me
    users["josina1234"] = {**copy.deepcopy(users["FinnBreu"]), "login": "josina1234",
                           "name": "Josina Gerdes", "id": 424242}
    for login, payload in users.items():
        fx.add(f"/users/{login}", {}, payload)
        fx.avatar(payload["id"], PNG)
    return fx


class BuildCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ghdata-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.site = site_tree(self.tmp / "site")
        self.fx = standard_fixture(self.tmp / "fx")

    def build(self, fx=None):
        fixture = (fx or self.fx).save()
        buf = io.StringIO()
        code = 0
        with redirect_stdout(buf), redirect_stderr(buf):
            try:
                bgd.main(["--fixture", str(fixture), "--root", str(self.site),
                          "--today", TODAY])
            except SystemExit as exc:
                code = exc.code if isinstance(exc.code, int) else 1
        return code, buf.getvalue()

    def out(self, name):
        return json.loads((self.site / rules.FILES[name]).read_text(encoding="utf-8"))

    def outputs_bytes(self):
        graph = self.site / "data" / "graph"
        return {p.relative_to(graph).as_posix(): p.read_bytes()
                for p in sorted(graph.rglob("*")) if p.is_file()}

    def ok(self, fx=None):
        code, log = self.build(fx)
        self.assertEqual(code, 0, log)
        return log


class Shapes(BuildCase):
    def test_every_output_has_its_exact_public_shape(self):
        self.ok()
        docs = {name: self.out(name) for name in rules.FILES}
        for name, doc in docs.items():
            self.assertEqual(set(doc), rules.TOP_KEYS[name], name)
        read = lambda rel: (self.site / rel).read_bytes() if (self.site / rel).is_file() else None
        self.assertEqual(rules.check_github_layer(docs, read), [])

    def test_the_gate_is_green_on_the_output(self):
        self.ok()
        # 6d over content/ and every data/**/*.json string
        self.assertEqual(check.check_content_safety(self.site), [])
        # 6b's e-mail scan (and section 11's stricter one, above)
        for p in (self.site / "data").rglob("*.json"):
            for _path, _key, value in check.walk_json(json.loads(p.read_text())):
                self.assertFalse(rules.EMAIL_RE.search(value), (p.name, value))

    def test_org_activity(self):
        self.ok()
        doc = self.out("org-activity")
        self.assertEqual(doc["read_at"], TODAY)           # day precision
        self.assertEqual(doc["window_days"], 365)
        self.assertEqual(len(doc["weeks"]), 53)
        self.assertEqual(doc["weeks"][-1]["week"], "2026-09-28")   # a Monday
        self.assertEqual(doc["weeks"][-1]["days"][2:], [None] * 5)
        t = doc["totals"]
        self.assertEqual(t["public_repos"], 4)
        self.assertEqual(t["repos_touched_365d"], 2)       # the fork is never read
        self.assertEqual(t["commits_365d"], 8 + 9)
        self.assertEqual(sum(sum(d or 0 for d in w["days"]) for w in doc["weeks"]), 17)
        self.assertEqual(t["releases"], 1)                  # the draft is dropped
        for c in doc["recent_commits"]:
            self.assertEqual(set(c), {"repo", "sha", "date", "msg"})
            self.assertEqual(len(c["sha"]), 7)
        self.assertEqual([r["name"] for r in doc["most_active_repos"]],
                         ["hippocampus_common", "docs"])
        self.assertEqual(doc["releases"], [{"repo": "hippocampus_common", "tag": "v1.0",
                                            "name": "First", "date": "2026-05-01"}])
        self.assertEqual(doc["truncated"], [])

    def test_author_null_commits_count_by_git_name(self):
        self.ok()
        # hippocampus_common: NBauschmann (linked), plus two author:null commits
        # named "NBauschmann" and "nat"; docs: FinnBreu, NBauschmann, VincentTUHH
        self.assertEqual(self.out("org-activity")["totals"]["authors_365d"], 5)

    def test_forks_skipped_for_commits_but_carded(self):
        self.ok()
        repos = self.out("github-repos")["repos"]
        self.assertEqual(sorted(repos), ["docs", "hippo_core", "hippocampus_common", "mavros"])
        self.assertTrue(repos["mavros"]["fork"])
        self.assertEqual(repos["mavros"]["commits_365d"], 0)
        self.assertTrue(all(r["private"] is False for r in repos.values()))
        self.assertEqual(repos["docs"]["html_url"],
                         "https://github.com/HippoCampusRobotics/docs")

    def test_private_repo_is_dropped(self):
        fx = self.fx
        org = json.loads((fx.root / "b1.json").read_text())
        leaked = copy.deepcopy(org[0])
        leaked.update(name="secret-thing", private=True, visibility="private",
                      pushed_at="2020-01-01T00:00:00Z")
        (fx.root / "b1.json").write_text(json.dumps(org + [leaked]))
        log = self.ok()
        self.assertNotIn("secret-thing", self.out("github-repos")["repos"])
        self.assertIn("not a public repository", log)

    def test_page_authors_follow_renames_and_dedupe_by_sha(self):
        self.ok()
        pages = self.out("page-authors")["pages"]
        ubuntu = pages["setup/raspberry-pi/ubuntu-24-04-server"]["original"]
        self.assertEqual(ubuntu["repo"], rules.OLD_DOCS_REPO)
        self.assertEqual(ubuntu["path"],
                         "contents/raspberry_pi_setup/ubuntu_24.04_server_64bit.rst")
        self.assertIsNone(ubuntu["blob"])
        self.assertTrue(ubuntu["history_read"])
        # dc94dad and 822b8c8 appear in several path reads: counted once each,
        # so NBauschmann 2 and lennartalff 2 (pre-restructure path) — a tie
        self.assertEqual([a["login"] for a in ubuntu["authors"]],
                         ["NBauschmann", "lennartalff"])
        ether = pages["setup/raspberry-pi/ethernet"]["original"]["authors"]
        self.assertEqual([a["login"] for a in ether],
                         ["NBauschmann", "josina1234", "lennartalff"])
        ros = pages["setup/getting-started/ros-installation"]["original"]["authors"]
        self.assertEqual([a["login"] for a in ros], ["lennartalff", "NBauschmann"])
        for a in ubuntu["authors"] + ether + ros:
            self.assertEqual(set(a), {"login", "name"})       # no counts, no dates
        # the git name "NBauschmann" gives way to the profile's display name
        self.assertEqual(ubuntu["authors"][0], {"login": "NBauschmann",
                                                "name": "Nathalie Bauschmann"})
        self.assertEqual(pages["setup/raspberry-pi/ethernet"]["converted"], bgd.CONVERSION)

    def test_this_repo_pages_and_author_null(self):
        self.ok()
        about = self.out("page-authors")["pages"]["about"]
        self.assertEqual(about["original"]["repo"], rules.THIS_REPO)
        self.assertRegex(about["original"]["blob"], r"^[0-9a-f]{40}$")
        self.assertIsNone(about["converted"])
        self.assertIn({"login": None, "name": "Desert Mango"}, about["original"]["authors"])
        # a linked author is named as GitHub publishes the account's name
        self.assertIn({"login": "kyle-nelson-berkeley", "name": "Kyle Nelson"},
                      about["original"]["authors"])

    def test_edited_here_from_pull_requests(self):
        self.ok()
        doc = self.out("page-authors")
        pages = doc["pages"]
        self.assertEqual(pages["setup/raspberry-pi/ethernet"]["edited_here"],
                         [{"pr": 1, "by": "kyle-nelson-berkeley", "state": "open"}])
        self.assertEqual(pages["about"]["edited_here"],
                         [{"pr": 2, "by": "kyle-nelson-berkeley", "state": "merged"}])
        self.assertEqual(pages["projects/p1"]["edited_here"],
                         [{"pr": 3, "by": "kyle-nelson-berkeley", "state": "merged"}])
        self.assertEqual(doc["prs_read"], [2, 3])            # open PR 1 is re-read

    def test_people_public_membership_roster_and_exclude(self):
        self.ok()
        people = self.out("people-public")["people"]
        self.assertEqual(sorted(people), sorted([
            "DanielDuecker", "timzarhansen", "RHochdahl",            # contributors
            "NBauschmann", "lennartalff", "josina1234",              # page history
            "kyle-nelson-berkeley"]))                                # conversion + PRs
        self.assertNotIn("hippocampusmum", people)                   # excluded
        roster = {k: v["roster"] for k, v in people.items()}
        self.assertEqual(roster, {
            "DanielDuecker": "Daniel-André Dücker", "timzarhansen": "Tim Hansen",
            "RHochdahl": "René Hochdahl", "NBauschmann": "Nathalie Bauschmann",
            "lennartalff": "Thies Lennart Alff", "josina1234": None,
            "kyle-nelson-berkeley": "Kyle Nelson"})
        for login, p in people.items():
            self.assertEqual(set(p), rules.PERSON_KEYS)
            self.assertEqual(p["html_url"], f"https://github.com/{login}")
            self.assertEqual(p["avatar"], f"data/graph/avatars/{login}.png")
            self.assertTrue((self.site / p["avatar"]).is_file())
        self.assertEqual(people["RHochdahl"]["name"], "RHochdahl")   # no display name

    def test_a_fork_only_contributor_is_not_published(self):
        # D-B: membership is contributors.json's NON-FORK org repos; a project
        # whose only org repository is a fork (mavros) publishes nobody
        proj = json.loads((self.site / "data/projects.json").read_text())
        proj["projects"].append({"id": "pf", "name": "PF", "file": "content/projects/pf.md",
                                 "repos": [{"name": "mavros"},
                                           {"name": "elsewhere", "external": True}]})
        (self.site / "data/projects.json").write_text(json.dumps(proj))
        (self.site / "content/projects/pf.md").write_text("# PF\n")
        contrib = json.loads((self.site / "data/graph/contributors.json").read_text())
        contrib["projects"]["pf"] = {"contributors": [
            {"login": "forkonly", "name": "Fork Only", "contributions": 9},
            {"login": "DanielDuecker", "name": "Daniel Duecker", "contributions": 1}]}
        (self.site / "data/graph/contributors.json").write_text(json.dumps(contrib))
        self.fx.add(f"{THIS}/commits", {"path": "content/projects/pf.md", "per_page": "100"},
                    [])
        self.fx.add("/users/forkonly", {}, {**u0("user-FinnBreu.json"), "login": "forkonly",
                                            "name": "Fork Only", "id": 515151})
        self.fx.avatar(515151, PNG)
        log = self.ok()
        people = self.out("people-public")["people"]
        self.assertNotIn("forkonly", people)
        self.assertIn("DanielDuecker", people)        # also in a non-fork project
        self.assertIn("'pf'", log)

    def test_profile_fields_are_dropped(self):
        self.ok()
        text = (self.site / rules.FILES["people-public"]).read_text()
        for key in ("email", "location", "company", "bio", "blog", "twitter_username",
                    "hireable", "followers", "following", "public_repos"):
            self.assertNotIn(f'"{key}"', text)

    def test_roster_agrees_with_build_contributors(self):
        self.ok()
        people = self.out("people-public")["people"]
        names = {login: None for login in people}
        names.update({"DanielDuecker": "Daniel Duecker", "timzarhansen": "Tim",
                      "RHochdahl": None})
        links = json.loads((self.site / "data/github-links.json").read_text())
        pdoc = json.loads((self.site / "data/people.json").read_text(encoding="utf-8"))
        with redirect_stdout(io.StringIO()):
            linked, _ = gn.match(names, gn.roster_names(pdoc), links)
            entry = bc.rank({"DanielDuecker": 3, "timzarhansen": 2, "RHochdahl": 1},
                            names, (), linked=linked)
        for row in entry["contributors"]:
            self.assertEqual(bool(row.get("roster")),
                             people[row["login"]]["roster"] is not None, row["login"])


class Hostile(BuildCase):
    def set_docs_commits(self, rows):
        self.fx.drop("/repos/HippoCampusRobotics/docs/commits", since=SINCE)
        self.fx.add("/repos/HippoCampusRobotics/docs/commits",
                    {"since": SINCE, "per_page": "100"}, rows)

    def recent(self):
        return {c["sha"]: c["msg"] for c in self.out("org-activity")["recent_commits"]}

    def test_signed_off_trailer_and_first_line_only(self):
        self.set_docs_commits([
            commit("1" * 40, "2026-09-20T10:00:00Z", "FinnBreu", "Finn",
                   "Fix pinout Signed-off-by: x <a@b.invalid>\n\nbody line\nSigned-off-by: y <y@z.de>"),
            commit("2" * 40, "2026-09-21T10:00:00Z", "FinnBreu", "Finn", "x" * 150)])
        log = self.ok()
        msgs = self.recent()
        self.assertEqual(msgs["1111111"], "Fix pinout Signed-off-by: x [redacted]")
        self.assertEqual(msgs["2222222"], "x" * 100)
        self.assertIn("redacted e-mail-shaped text in docs@1111111", log)
        self.assertNotIn("a@b.invalid", log)

    def test_an_address_crossing_the_100_char_cut_is_redacted_whole(self):
        # the cut used to come BEFORE redaction, so an address spanning chars
        # 90-110 lost its tail and the head leaked ("someone@exampl")
        self.set_docs_commits([
            commit("8" * 40, "2026-09-20T10:00:00Z", "FinnBreu", "Finn",
                   "x" * 89 + " someone@example.org and more text"),
            commit("9" * 40, "2026-09-21T10:00:00Z", "FinnBreu", "Finn",
                   "y" * 86 + " someone@example.org")])
        log = self.ok()
        msgs = self.recent()
        for sha in ("8888888", "9999999"):
            msg = msgs[sha]
            self.assertLessEqual(len(msg), rules.MSG_MAX)
            self.assertIn("[redacted]", msg)
            for part in ("someone", "@", "exampl", "example.org"):
                self.assertNotIn(part, msg, sha)
        self.assertEqual(msgs["8888888"], "x" * 89 + " [redacted]")
        self.assertIn("redacted e-mail-shaped text in docs@8888888", log)
        self.assertEqual(check.check_content_safety(self.site), [])
        docs = {name: self.out(name) for name in rules.FILES}
        read = lambda rel: (self.site / rel).read_bytes() if (self.site / rel).is_file() else None
        self.assertEqual(rules.check_github_layer(docs, read), [])

    def test_exclude_reaches_cached_authors_and_cached_edits(self):
        # frozen/cached entries never passed through project_authors(): a login
        # added to "exclude" later must still leave every list
        self.ok()
        before = json.dumps(self.out("page-authors"))
        self.assertIn('"lennartalff"', before)
        self.assertIn('"by": "kyle-nelson-berkeley", "state": "merged"', before)
        links = json.loads((self.site / "data/github-links.json").read_text())
        links["exclude"] += ["lennartalff", "kyle-nelson-berkeley"]
        (self.site / "data/github-links.json").write_text(json.dumps(links))
        for row in u0("index.json")["requests"]:        # prove the cache is used
            if row["body"].startswith("page-commits-"):
                self.fx.drop(row["path"], **row["query"])
        self.ok()
        pages = self.out("page-authors")["pages"]
        for key, page in pages.items():
            logins = [a["login"] for a in page["original"]["authors"]]
            self.assertNotIn("lennartalff", logins, key)
            self.assertNotIn("kyle-nelson-berkeley", logins, key)
            self.assertEqual([e for e in page["edited_here"]
                              if e["by"] in ("lennartalff", "kyle-nelson-berkeley")], [], key)
        people = self.out("people-public")["people"]
        self.assertNotIn("lennartalff", people)
        self.assertNotIn("kyle-nelson-berkeley", people)

    def test_a_malformed_map_aborts_and_writes_nothing(self):
        self.ok()
        before = self.outputs_bytes()
        (self.site / "data/github-links.json").write_text(
            json.dumps({"note": "n", "links": None, "exclude": []}))
        code, log = self.build()
        self.assertEqual(code, 1, log)
        self.assertIn("ABORT", log)
        self.assertIn("github-links.json", log)
        self.assertEqual(self.outputs_bytes(), before)

    def test_onnx_online_and_email_are_redacted_and_the_gate_stays_green(self):
        self.set_docs_commits([commit("3" * 40, "2026-09-20T10:00:00Z", "FinnBreu", "Finn",
                                      "Bump onnx==1.17")])
        org = json.loads((self.fx.root / "b1.json").read_text())
        for r in org:
            if r["name"] == "docs":
                r["description"] = "keeps the robot online = true; ask lab@tuhh.de"
            if r["name"] == "hippo_core":
                r["description"] = "Radio Frequency based localization (@433 MHz)"
        (self.fx.root / "b1.json").write_text(json.dumps(org))
        log = self.ok()
        self.assertEqual(self.recent()["3333333"], "Bump [redacted]==1.17")
        repos = self.out("github-repos")["repos"]
        self.assertEqual(repos["docs"]["description"],
                         "keeps the robot [redacted] = true; ask [redacted]")
        self.assertEqual(repos["hippo_core"]["description"],
                         "Radio Frequency based localization (@433 MHz)")
        self.assertIn("on…= text in docs@3333333", log)
        self.assertIn("docs description", log)
        self.assertEqual(check.check_content_safety(self.site), [])

    def test_email_shaped_git_author_name_is_redacted(self):
        self.fx.drop(f"{THIS}/commits", path="content/about.md")
        self.fx.add(f"{THIS}/commits", {"path": "content/about.md", "per_page": "100"},
                    [commit("c" * 40, "2026-09-01T10:00:00Z", None, "me@private.org", "x")])
        log = self.ok()
        authors = self.out("page-authors")["pages"]["about"]["original"]["authors"]
        self.assertEqual(authors, [{"login": None, "name": "[redacted]"}])
        self.assertIn("redacted e-mail-shaped text", log)

    def test_markup_is_stripped_from_names_messages_descriptions(self):
        self.set_docs_commits([commit("4" * 40, "2026-09-20T10:00:00Z", "FinnBreu", "F",
                                      "<img src=x onerror=alert(1)>")])
        users = json.loads(json.dumps(u0("user-FinnBreu.json")))
        self.fx.drop("/users/josina1234")
        self.fx.add("/users/josina1234", {}, {**users, "login": "josina1234", "id": 424242,
                                             "name": "<b>Jo</b> <script>x</script>"})
        org = json.loads((self.fx.root / "b1.json").read_text())
        org[0]["description"] = "a <svg/onload=alert(1)> b"
        (self.fx.root / "b1.json").write_text(json.dumps(org))
        self.ok()
        for name in rules.FILES:
            text = (self.site / rules.FILES[name]).read_text()
            self.assertNotIn("<", text, name)
            self.assertNotIn(">", text, name)
        self.assertEqual(self.out("people-public")["people"]["josina1234"]["name"],
                         "bJo/b scriptx/script")
        self.assertEqual(check.check_content_safety(self.site), [])

    def test_bots_are_dropped_everywhere(self):
        self.set_docs_commits([
            commit("5" * 40, "2026-09-20T10:00:00Z", "github-actions[bot]",
                   "github-actions[bot]", "derive", bot=True),
            commit("6" * 40, "2026-09-20T11:00:00Z", "renovate", "renovate", "deps",
                   bot=True),
            commit("7" * 40, "2026-09-20T12:00:00Z", "FinnBreu", "Finn", "real")])
        pulls = u0("pulls-all.json")
        bot_pr = copy.deepcopy(pulls[0])
        bot_pr.update(number=9, state="open", merged_at=None)
        bot_pr["user"] = {**bot_pr["user"], "login": "dependabot[bot]", "type": "Bot"}
        self.fx.drop(f"{THIS}/pulls", state="all")
        self.fx.add(f"{THIS}/pulls", {"state": "all", "per_page": "100"}, pulls + [bot_pr])
        self.ok()
        doc = self.out("org-activity")
        self.assertIn("7777777", self.recent())
        self.assertNotIn("5555555", self.recent())
        self.assertNotIn("6666666", self.recent())
        self.assertNotIn("[bot]", json.dumps(self.out("page-authors")))
        self.assertNotIn("dependabot", json.dumps(self.out("people-public")))
        self.assertEqual(doc["totals"]["commits_365d"], 1 + 9)

    def test_structural_leak_aborts_and_writes_nothing(self):
        self.ok()
        before = self.outputs_bytes()
        original = bgd.project_person

        def leaky(login, name, avatar, roster):
            row = original(login, name, avatar, roster)
            row["email"] = None                  # a copied profile key
            return row
        bgd.project_person = leaky
        self.addCleanup(setattr, bgd, "project_person", original)
        code, log = self.build()
        self.assertEqual(code, 1)
        self.assertIn("STRUCTURAL LEAK", log)
        self.assertEqual(self.outputs_bytes(), before)

    def test_a_failed_read_leaves_the_previous_files_byte_identical(self):
        self.ok()
        before = self.outputs_bytes()
        self.fx.drop("/repos/HippoCampusRobotics/docs/releases")
        code, log = self.build()
        self.assertEqual(code, 1)
        self.assertIn("no fixture payload", log)
        self.assertEqual(self.outputs_bytes(), before)


class Paging(BuildCase):
    def test_link_next_is_followed_as_given(self):
        api = bgd.FixtureApi(U0)
        repos, cut = bgd.paged(api, "orgs/HippoCampusRobotics/repos",
                               {"type": "public", "per_page": "50"})
        self.assertFalse(cut)
        self.assertEqual([r["name"] for r in repos],
                         [r["name"] for r in u0("org-repos.json")])
        self.assertEqual(api.seen[1], ("orgs/HippoCampusRobotics/repos",
                                       {"type": "public", "per_page": "50", "page": "2"}))
        repos, cut = bgd.paged(bgd.FixtureApi(U0), "orgs/HippoCampusRobotics/repos",
                               {"type": "public", "per_page": "50"}, max_pages=1)
        self.assertTrue(cut)
        self.assertEqual(len(repos), 50)

    def test_foreign_link_host_is_refused(self):
        with self.assertRaises(bgd.Abort):
            bgd.api_path("https://evil.example.com/orgs/x/repos?page=2")

    def test_commit_history_is_capped_at_five_pages_and_marked_truncated(self):
        self.fx.drop("/repos/HippoCampusRobotics/docs/commits", since=SINCE)
        base = "https://api.github.com/repos/HippoCampusRobotics/docs/commits"
        for page in range(1, 8):
            query = {"since": SINCE, "per_page": "100"}
            if page > 1:
                query["page"] = str(page)
            nxt = f'<{base}?since={SINCE}&per_page=100&page={page + 1}>; rel="next"'
            self.fx.add("/repos/HippoCampusRobotics/docs/commits", query,
                        [commit(f"{page:x}" * 40, f"2026-09-0{page}T10:00:00Z", "FinnBreu",
                                "Finn", f"page {page}")], link=nxt)
        self.ok()
        doc = self.out("org-activity")
        self.assertEqual(doc["truncated"], ["docs"])
        self.assertEqual(self.out("github-repos")["repos"]["docs"]["commits_365d"], 5)


    def releases_pages(self, count):
        self.fx.drop("/repos/HippoCampusRobotics/hippocampus_common/releases")
        base = "https://api.github.com/repos/HippoCampusRobotics/hippocampus_common/releases"
        for page in range(1, count + 1):
            query = {"per_page": "100"}
            if page > 1:
                query["page"] = str(page)
            nxt = (f'<{base}?per_page=100&page={page + 1}>; rel="next"'
                   if page < count else None)
            self.fx.add("/repos/HippoCampusRobotics/hippocampus_common/releases", query,
                        [{"tag_name": f"v{page}", "name": f"R{page}", "draft": False,
                          "published_at": f"2026-05-0{page}T00:00:00Z"}], link=nxt)

    def test_releases_follow_link_next(self):
        self.releases_pages(2)
        self.ok()
        doc = self.out("org-activity")
        self.assertEqual(doc["totals"]["releases"], 2)
        self.assertEqual(sorted(r["tag"] for r in doc["releases"]), ["v1", "v2"])
        self.assertEqual(doc["truncated"], [])

    def test_releases_are_capped_at_five_pages_and_marked_truncated(self):
        self.releases_pages(7)
        self.ok()
        doc = self.out("org-activity")
        self.assertEqual(doc["totals"]["releases"], 5)
        self.assertEqual(doc["truncated"], ["hippocampus_common"])

    def test_a_release_tag_never_reaches_the_log_raw(self):
        # the warning label used to hold the raw tag, and the build log is
        # public in CI: an e-mail-shaped tag must reach neither the output
        # nor the printed warning
        addr = "ship" + "@" + "tag.invalid"
        self.fx.drop("/repos/HippoCampusRobotics/hippocampus_common/releases")
        self.fx.add("/repos/HippoCampusRobotics/hippocampus_common/releases",
                    {"per_page": "100"},
                    [{"tag_name": f"v1-{addr}", "name": f"R {addr}", "draft": False,
                      "published_at": "2026-05-01T00:00:00Z"}])
        log = self.ok()
        self.assertNotIn(addr, log)
        self.assertIn("redacted e-mail-shaped text in hippocampus_common release", log)
        rel = self.out("org-activity")["releases"][0]
        self.assertNotIn(addr, rel["tag"] + rel["name"])

    def test_api_path_accepts_only_api_github_com(self):
        self.assertEqual(bgd.api_path("https://api.github.com/orgs/x/repos?page=2"),
                         "orgs/x/repos?page=2")
        for url in ("https://api.github.com.evil.example/orgs/x",
                    "https://api.github.com@evil.example/orgs/x",
                    "https://evil.example/https://api.github.com/orgs/x",
                    "http://api.github.com/orgs/x",
                    "https://api.github.com:8443/orgs/x",
                    "https://user@api.github.com/orgs/x",
                    "https://api.github.com//evil.example/x",
                    "https://api.github.com/https://evil.example/x",
                    "https://api.github.com/orgs/../../x",
                    "https://api.github.com/orgs/x#frag"):
            with self.subTest(url=url), self.assertRaises(bgd.Abort):
                bgd.api_path(url)


class Caching(BuildCase):
    def test_frozen_history_and_closed_prs_are_not_re_read(self):
        self.ok()
        first = self.outputs_bytes()
        for row in u0("index.json")["requests"]:
            if row["body"].startswith("page-commits-"):
                self.fx.drop(row["path"], **row["query"])
        for rel in ("content/projects/p1.md", "content/tools/t1.md", "content/about.md"):
            self.fx.drop(f"{THIS}/commits", path=rel)
        self.fx.drop(f"{THIS}/pulls/2/files")
        self.fx.drop(f"{THIS}/pulls/3/files")
        for f in (self.fx.root / "avatars").iterdir():
            f.unlink()                                  # avatars are reused too
        self.ok()
        self.assertEqual(self.outputs_bytes(), first)   # same day: byte-identical

    def test_a_changed_page_is_re_read(self):
        self.ok()
        self.fx.drop(f"{THIS}/commits", path="content/about.md")
        (self.site / "content" / "about.md").write_text("# About, edited\n")
        code, log = self.build()
        self.assertEqual(code, 1)
        self.assertIn("content%2Fabout.md", log)

    def test_the_open_pr_is_re_read(self):
        self.ok()
        self.fx.drop(f"{THIS}/pulls/1/files")
        code, log = self.build()
        self.assertEqual(code, 1)
        self.assertIn("pulls/1/files", log)

    def test_read_at_is_a_day(self):
        self.ok()
        for name in rules.FILES:
            self.assertRegex(self.out(name)["read_at"], r"^\d{4}-\d{2}-\d{2}$")


class Avatars(BuildCase):
    def uid(self, login):
        return u0(f"user-{login}.json")["id"]

    def test_svg_and_oversized_avatars_are_refused(self):
        self.fx.avatar(self.uid("lennartalff"), b"<svg xmlns='x'/>")
        self.fx.avatar(self.uid("NBauschmann"), rules.PNG_MAGIC + b"\x00" * 20000)
        log = self.ok()
        people = self.out("people-public")["people"]
        self.assertIsNone(people["lennartalff"]["avatar"])
        self.assertIsNone(people["NBauschmann"]["avatar"])
        self.assertIn("avatar for lennartalff is not PNG or JPEG", log)
        self.assertIn("avatar for NBauschmann is over", log)
        self.assertFalse(list((self.site / rules.AVATAR_DIR).glob("lennartalff.*")))

    def test_jpeg_lands_as_jpg_and_stale_files_are_removed(self):
        (self.fx.root / "avatars" / f"{self.uid('FinnBreu')}.png").unlink()
        adir = self.site / rules.AVATAR_DIR
        adir.mkdir(parents=True, exist_ok=True)
        (adir / "gone-login.png").write_bytes(PNG)
        self.fx.avatar(self.uid("DanielDuecker"), JPG, ext="jpg")
        (self.fx.root / "avatars" / f"{self.uid('DanielDuecker')}.png").unlink()
        self.ok()
        people = self.out("people-public")["people"]
        self.assertEqual(people["DanielDuecker"]["avatar"],
                         "data/graph/avatars/DanielDuecker.jpg")
        self.assertEqual((adir / "DanielDuecker.jpg").read_bytes(), JPG)
        self.assertFalse((adir / "gone-login.png").exists())

    def test_avatar_redirects_leave_only_for_the_avatar_host(self):
        import urllib.request
        handler = bgd.AvatarRedirects()
        req = urllib.request.Request("https://avatars.githubusercontent.com/u/1?s=64&v=4")
        ok = handler.redirect_request(req, None, 302, "Found", {},
                                      "https://avatars.githubusercontent.com/u/1?s=64&v=5")
        self.assertIsNotNone(ok)
        for url in ("https://evil.example/a.png", "http://avatars.githubusercontent.com/u/1",
                    "https://avatars.githubusercontent.com.evil.example/u/1",
                    "https://x@avatars.githubusercontent.com/u/1"):
            with self.subTest(url=url), self.assertRaises(bgd.DownloadFailed):
                handler.redirect_request(req, None, 302, "Found", {}, url)
        self.assertIn(bgd.AvatarRedirects,
                      [type(h) for h in bgd.AVATAR_OPENER.handlers])

    def test_missing_avatar_is_no_avatar_not_a_failure(self):
        (self.fx.root / "avatars" / "424242.png").unlink()        # josina1234
        log = self.ok()
        self.assertIsNone(self.out("people-public")["people"]["josina1234"]["avatar"])
        self.assertIn("avatar for josina1234 not downloaded", log)


class Hygiene(unittest.TestCase):
    def test_stdlib_only(self):
        src = Path(bgd.__file__).read_text(encoding="utf-8")
        allowed = {"argparse", "datetime", "hashlib", "json", "os", "re", "subprocess",
                   "sys", "tempfile", "urllib", "collections", "pathlib",
                   "github_layer_rules", "github_names"}
        for i, line in enumerate(src.splitlines(), 1):
            if line.startswith(("import ", "from ")):
                self.assertIn(line.split()[1].split(".")[0], allowed, f"line {i}")

    def test_old_docs_rename_table(self):
        self.assertEqual(bgd.old_docs_paths("contents/raspberry_pi_setup/ethernet"), [
            ("contents/raspberry_pi_setup/ethernet.rst", None),
            ("raspberry_pi_setup/ethernet.rst", "2025-03-11T00:00:00Z"),
            ("raspberry_pi_4b_setup/ethernet.rst", "2025-03-11T00:00:00Z")])
        self.assertEqual(bgd.old_docs_paths("index"), [("index.rst", None)])

    def test_heatmap_is_53_monday_weeks(self):
        weeks = bgd.heatmap(dt.date(2026, 9, 29), {"2026-09-28": 2})
        self.assertEqual(len(weeks), 53)
        self.assertEqual(weeks[-1], {"week": "2026-09-28",
                                     "days": [2, 0, None, None, None, None, None]})
        self.assertEqual(weeks[0]["week"], "2025-09-29")


if __name__ == "__main__":
    unittest.main(verbosity=1)
