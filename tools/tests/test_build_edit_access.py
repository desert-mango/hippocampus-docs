#!/usr/bin/env python3
# Author: Kyle Nelson
# Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
# Last substantive modification: 19 October 2026
# Affiliation: TUHH HippoCampus Robotics
# Purpose: Test the edit-access rule (commits first, admin add and remove win) and its fail-safe writer.
"""Unit tests for tools/build_edit_access.py.

Run from the repo root with plain python3 (no pytest, no network):

    python3 tools/tests/test_build_edit_access.py

The rule (Kyle, 2026-10-19), per project and per person:
  in the project's `remove` list          -> not an editor ("removed")
  else at least one commit in its repos   -> editor, why "commits"
  else in the project's `add` list        -> editor, why "added"
  else                                    -> not an editor
Logins compare in lowercase. Bots and excluded logins never count as commits.
"""
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import build_edit_access as bea  # noqa: E402


def index(*entries):
    return {"intro": "x", "projects": [dict(id=i, add=list(a), remove=list(r)) for i, a, r in entries]}


def bucket(repos, commits):
    return {"contributors": [], "repos": list(repos), "commits": commits}


def contributors(**buckets):
    return {"generated": "2026-10-19", "org": "HippoCampusRobotics", "note": "x", "projects": buckets}


LINKS = {"note": "x", "links": {}, "exclude": ["hippocampusmum"]}


class RuleTest(unittest.TestCase):
    def access(self, idx, contrib, links=LINKS):
        return bea.effective_access(idx, contrib, links)["projects"]

    def test_commits_alone_make_an_editor(self):
        got = self.access(index(("p", [], [])),
                          contributors(p=bucket(["a", "b", "c"], {"Ada": {"a": 3, "b": 1}, "bob": {"c": 2}})))
        self.assertEqual(got["p"], {
            "repos": 3,
            "editors": [{"login": "Ada", "why": "commits", "repos_with_commits": 2},
                        {"login": "bob", "why": "commits", "repos_with_commits": 1}],
            "removed": []})

    def test_add_without_commits_makes_an_editor(self):
        got = self.access(index(("p", ["cleo"], [])), contributors(p=bucket(["a"], {})))
        self.assertEqual(got["p"]["editors"], [{"login": "cleo", "why": "added", "repos_with_commits": 0}])

    def test_commits_win_over_add_for_the_reason(self):
        got = self.access(index(("p", ["ada"], [])), contributors(p=bucket(["a"], {"Ada": {"a": 1}})))
        self.assertEqual(got["p"]["editors"], [{"login": "Ada", "why": "commits", "repos_with_commits": 1}])

    def test_remove_wins_over_commits(self):
        got = self.access(index(("p", [], ["ADA"])), contributors(p=bucket(["a"], {"Ada": {"a": 5}})))
        self.assertEqual(got["p"]["editors"], [])
        self.assertEqual(got["p"]["removed"], [{"login": "Ada", "had_commits": True}])

    def test_remove_without_commits(self):
        got = self.access(index(("p", [], ["zed"])), contributors(p=bucket(["a"], {})))
        self.assertEqual(got["p"]["removed"], [{"login": "zed", "had_commits": False}])

    def test_remove_wins_over_add(self):
        # the gate refuses a login in both lists; the builder still never grants it
        got = self.access(index(("p", ["Zed"], ["zed"])), contributors(p=bucket(["a"], {})))
        self.assertEqual(got["p"]["editors"], [])
        self.assertEqual(got["p"]["removed"], [{"login": "zed", "had_commits": False}])

    def test_bots_and_excluded_logins_never_count(self):
        got = self.access(index(("p", [], [])), contributors(p=bucket(["a"], {
            "dependabot[bot]": {"a": 9}, "HippoCampusMUM": {"a": 4}, "ada": {"a": 1}})))
        self.assertEqual([e["login"] for e in got["p"]["editors"]], ["ada"])

    def test_a_commit_key_that_is_no_login_never_counts(self):
        # section 10 of the gate reports such a key; here it simply gives nothing (fail closed)
        got = self.access(index(("p", [], [])), contributors(p=bucket(["a"], {
            "x@y": {"a": 1}, "-x": {"a": 1}, "a--b": {"a": 1}})))
        self.assertEqual([e["login"] for e in got["p"]["editors"]], ["a--b"])

    def test_one_login_pattern_with_the_gate(self):
        import check
        self.assertIs(check.CONTRIB_LOGIN_RE, bea.COMMIT_LOGIN_RE)

    def test_commits_count_only_in_the_projects_own_repos(self):
        # a commit in another project's repo gives nothing here
        got = self.access(index(("p", [], []), ("q", [], [])),
                          contributors(p=bucket(["a"], {"ada": {"a": 1}}), q=bucket(["b"], {})))
        self.assertEqual(got["q"]["editors"], [])
        self.assertEqual(len(got["p"]["editors"]), 1)

    def test_logins_compare_in_lowercase_and_keep_githubs_spelling(self):
        got = self.access(index(("p", ["ada-L", "Bea"], [])), contributors(p=bucket(["a"], {"Ada-l": {"a": 1}})))
        self.assertEqual(got["p"]["editors"], [
            {"login": "Ada-l", "why": "commits", "repos_with_commits": 1},     # contributors' spelling
            {"login": "Bea", "why": "added", "repos_with_commits": 0}])        # the add list's spelling

    def test_lists_are_sorted_by_lowercase_login(self):
        got = self.access(index(("p", ["zoe", "Bob"], ["Yan", "amy"])),
                          contributors(p=bucket(["a"], {"Carl": {"a": 1}, "abe": {"a": 2}})))
        self.assertEqual([e["login"] for e in got["p"]["editors"]], ["abe", "Bob", "Carl", "zoe"])
        self.assertEqual([e["login"] for e in got["p"]["removed"]], ["amy", "Yan"])

    def test_a_duplicate_in_one_list_appears_once(self):
        got = self.access(index(("p", ["bob", "BOB"], [])), contributors(p=bucket(["a"], {})))
        self.assertEqual(got["p"]["editors"], [{"login": "bob", "why": "added", "repos_with_commits": 0}])

    def test_a_project_with_no_bucket_is_add_only_and_noted(self):
        notes = []
        doc = bea.effective_access(index(("new", ["ada"], ["bob"])), contributors(), LINKS, notes)
        self.assertEqual(doc["projects"]["new"], {
            "repos": 0,
            "editors": [{"login": "ada", "why": "added", "repos_with_commits": 0}],
            "removed": [{"login": "bob", "had_commits": False}]})
        self.assertEqual(len(notes), 1)
        self.assertIn("'new'", notes[0])
        self.assertIn("add list only", notes[0])

    def test_a_bucket_of_a_project_not_in_the_index_is_ignored(self):
        doc = bea.effective_access(index(("p", [], [])),
                                   contributors(p=bucket([], {}), gone=bucket(["a"], {"ada": {"a": 1}})), LINKS)
        self.assertEqual(sorted(doc["projects"]), ["p"])

    def test_a_bucket_without_repos_or_commits_aborts(self):
        for missing in ("repos", "commits"):
            b = bucket(["a"], {})
            del b[missing]
            with self.assertRaises(bea.Abort) as cm:
                bea.effective_access(index(("p", [], [])), contributors(p=b), LINKS)
            self.assertIn("'p'", str(cm.exception))
            self.assertIn(missing, str(cm.exception))

    def test_wrong_shapes_abort_with_a_located_message(self):
        bad = [
            (index(("p", [], [])), {"projects": []}, "data/graph/contributors.json"),
            (index(("p", [], [])), [], "data/graph/contributors.json"),
            (index(("p", [], [])), contributors(p={"contributors": [], "repos": "a", "commits": {}}), "'repos'"),
            (index(("p", [], [])), contributors(p=bucket(["a"], {"ada": 3})), "'commits'"),
            ({"projects": "x"}, contributors(), "data/projects.json"),
            ({"projects": [{"id": "p", "add": "ada", "remove": []}]}, contributors(), "`add`"),
            ({"projects": [{"id": "p", "add": [], "remove": ["ok", 7]}]}, contributors(), "`remove`"),
        ]
        for idx, contrib, where in bad:
            with self.assertRaises(bea.Abort, msg=where) as cm:
                bea.effective_access(idx, contrib, LINKS)
            self.assertIn(where, str(cm.exception))

    def test_the_document_has_a_note_and_nothing_else_at_the_top(self):
        doc = bea.effective_access(index(("p", [], [])), contributors(p=bucket([], {})), LINKS)
        self.assertEqual(sorted(doc), ["note", "projects"])
        self.assertIsInstance(doc["note"], str)
        self.assertNotIn("generated", json.dumps(doc), "no timestamp: the bytes change only when access does")

    def test_deterministic(self):
        idx = index(("p", ["zoe", "Bob"], ["Yan"]), ("q", [], []))
        contrib = contributors(p=bucket(["a", "b"], {"Carl": {"a": 1}, "abe": {"a": 2, "b": 1}}), q=bucket([], {}))
        one = bea.dump(bea.effective_access(idx, contrib, LINKS))
        # the same inputs in another order give the same bytes
        idx2 = index(("q", [], []), ("p", ["Bob", "zoe"], ["Yan"]))
        contrib2 = contributors(q=bucket([], {}), p=bucket(["a", "b"], {"abe": {"b": 1, "a": 2}, "Carl": {"a": 1}}))
        self.assertEqual(one, bea.dump(bea.effective_access(idx2, contrib2, LINKS)))
        self.assertTrue(one.endswith("}\n"))
        self.assertEqual(one, json.dumps(json.loads(one), indent=1, sort_keys=True, ensure_ascii=False) + "\n")


class WriterTest(unittest.TestCase):
    """The CLI: writes data/graph/edit-access.json, or exits 1 and writes nothing."""

    def tree(self, contrib=None, links=LINKS, idx=None):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        (root / "data" / "graph").mkdir(parents=True)
        (root / "data" / "projects.json").write_text(
            json.dumps(idx or index(("p", ["ada"], []))), encoding="utf-8")
        if contrib is not None:
            text = contrib if isinstance(contrib, str) else json.dumps(contrib)
            (root / "data" / "graph" / "contributors.json").write_text(text, encoding="utf-8")
        if links is not None:
            (root / "data" / "github-links.json").write_text(json.dumps(links), encoding="utf-8")
        return root

    def run_main(self, *argv):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = bea.main(list(argv))
        return code, buf.getvalue()

    def out(self, root):
        return root / "data" / "graph" / "edit-access.json"

    def test_writes_the_file(self):
        root = self.tree(contributors(p=bucket(["a"], {"bob": {"a": 1}})))
        code, log = self.run_main("--root", str(root))
        self.assertEqual(code, 0, log)
        doc = json.loads(self.out(root).read_text(encoding="utf-8"))
        self.assertEqual([e["login"] for e in doc["projects"]["p"]["editors"]], ["ada", "bob"])
        self.assertIn("wrote data/graph/edit-access.json", log)

    def test_missing_contributors_exits_1_and_writes_nothing(self):
        root = self.tree(None)
        self.out(root).write_text("OLD\n", encoding="utf-8")
        code, log = self.run_main("--root", str(root))
        self.assertEqual(code, 1)
        self.assertIn("data/graph/contributors.json", log)
        self.assertEqual(self.out(root).read_text(encoding="utf-8"), "OLD\n", "the previous file is kept")

    def test_unreadable_contributors_exits_1_and_writes_nothing(self):
        root = self.tree("{not json")
        code, log = self.run_main("--root", str(root))
        self.assertEqual(code, 1)
        self.assertIn("data/graph/contributors.json", log)
        self.assertFalse(self.out(root).exists())

    def test_a_bucket_without_commits_exits_1_and_writes_nothing(self):
        root = self.tree(contributors(p={"contributors": [], "repos": []}))
        code, log = self.run_main("--root", str(root))
        self.assertEqual(code, 1)
        self.assertIn("'p'", log)
        self.assertFalse(self.out(root).exists())

    def test_missing_links_exits_1(self):
        root = self.tree(contributors(p=bucket([], {})), links=None)
        code, log = self.run_main("--root", str(root))
        self.assertEqual(code, 1)
        self.assertIn("data/github-links.json", log)
        self.assertFalse(self.out(root).exists())

    def test_a_new_project_without_a_bucket_is_written_with_a_note(self):
        root = self.tree(contributors(), idx=index(("new", ["ada"], [])))
        code, log = self.run_main("--root", str(root))
        self.assertEqual(code, 0, log)
        self.assertIn("note:", log)
        self.assertIn("'new'", log)
        doc = json.loads(self.out(root).read_text(encoding="utf-8"))
        self.assertEqual(doc["projects"]["new"]["editors"][0]["why"], "added")

    def test_check_mode(self):
        root = self.tree(contributors(p=bucket([], {})))
        code, log = self.run_main("--root", str(root), "--check")
        self.assertEqual(code, 1, "no file yet: out of step")
        self.assertFalse(self.out(root).exists(), "--check writes nothing")
        self.assertEqual(self.run_main("--root", str(root))[0], 0)
        code, log = self.run_main("--root", str(root), "--check")
        self.assertEqual(code, 0, log)
        before = self.out(root).read_bytes()
        self.assertEqual(self.run_main("--root", str(root))[0], 0)
        self.assertEqual(self.out(root).read_bytes(), before, "a second run writes the same bytes")

    def test_the_real_tree_builds(self):
        """The committed inputs build (read-only: --check never writes)."""
        code, log = self.run_main("--root", str(ROOT), "--check")
        self.assertIn(code, (0, 1), log)
        self.assertNotIn("FAILED", log)

    def test_stdlib_only(self):
        src = (ROOT / "tools" / "build_edit_access.py").read_text(encoding="utf-8")
        mods = {line.split()[1].split(".")[0] for line in src.splitlines() if line.startswith(("import ", "from "))}
        self.assertLessEqual(mods, {"argparse", "json", "os", "re", "sys", "tempfile", "pathlib"})


if __name__ == "__main__":
    unittest.main()
