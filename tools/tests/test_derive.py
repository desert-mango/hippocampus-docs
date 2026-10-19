#!/usr/bin/env python3
# Author: Kyle Nelson
# Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
# Last substantive modification: 19 October 2026
# Affiliation: TUHH HippoCampus Robotics
# Purpose: Test derived-data regeneration order, filters, failure pass-through, and CI annotations.
"""Unit tests for tools/derive.py and the two workflow files that call it.

Run from the repo root with plain python3 (no pytest, no gh, no network):

    python3 tools/tests/test_derive.py

derive.py runs the builders it finds in <root>/tools/, so every test builds a
tiny fixture root in a temp directory whose tools/ holds FAKE builders: each
one appends its name to order.log and then writes, or fails, as the test
needs. Nothing here runs a real builder or writes into the repo. The
--contributors-if-changed tests make a throwaway git repository in the temp
directory (git is the only external program used).
"""
import re
import io
import os
import subprocess
import sys
import unittest
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import derive  # noqa: E402

REPO = Path(__file__).resolve().parent.parent.parent

FAKE_HEAD = """import sys, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
with open(root / "order.log", "a") as f:
    f.write(pathlib.Path(__file__).name + " " + " ".join(sys.argv[1:]) + "\\n")
"""


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def fake_writer(files):
    """A builder body that writes {relpath: text} under the root."""
    lines = []
    for rel, text in files.items():
        lines.append(f"p = root / {rel!r}; p.parent.mkdir(parents=True, exist_ok=True); "
                     f"p.write_text({text!r}, encoding='utf-8')")
    return "\n".join(lines) + "\n"


def git(root, *args):
    return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid",
                           "-c", "commit.gpgsign=false", *args],
                          cwd=root, check=True, capture_output=True, text=True).stdout.strip()


class DeriveCase(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        # existing derived files, as a real checkout has them
        write(self.root / "data/graph/wiki.json", "wiki-v1\n")
        write(self.root / "search/site.json", "site-v1\n")
        write(self.root / "data/graph/contributors.json", "contrib-v1\n")
        for name in ("projects.json", "org-repos.json", "people.json"):
            write(self.root / "data" / name, "[]\n")
        write(self.root / "content/about.md", "# About\n")
        # default fakes: write exactly what is already there (a no-op rebuild)
        self.builder("build_wiki_graph.py", fake_writer({"data/graph/wiki.json": "wiki-v1\n"}))
        self.builder("build_search_index.py", fake_writer({"search/site.json": "site-v1\n"}))
        self.builder("build_contributors.py",
                     fake_writer({"data/graph/contributors.json": "contrib-v1\n"}))
        write(self.root / "data/graph/org-activity.json", "activity-v1\n")
        write(self.root / "data/graph/avatars/ada.png", "png-v1\n")
        self.builder("build_github_data.py",
                     fake_writer({"data/graph/org-activity.json": "activity-v1\n"}))
        # who may edit (2026-10-19): edit-access.json, then CODEOWNERS from it, on every call
        write(self.root / "data/graph/edit-access.json", "access-v1\n")
        write(self.root / ".github/CODEOWNERS", "owners-v1\n")
        self.builder("build_edit_access.py",
                     fake_writer({"data/graph/edit-access.json": "access-v1\n"}))
        self.builder("build_codeowners.py", fake_writer({".github/CODEOWNERS": "owners-v1\n"}))

    def builder(self, name, body):
        write(self.root / "tools" / name, FAKE_HEAD + body)

    def run_derive(self, *argv):
        buf = io.StringIO()
        with redirect_stdout(buf), redirect_stderr(buf):
            try:
                rc = derive.main(list(argv), root=self.root)
            except SystemExit as e:  # argparse errors
                rc = e.code
        self.out = buf.getvalue()
        self.lines = [l for l in self.out.splitlines() if l.strip()]
        return rc

    def order(self):
        p = self.root / "order.log"
        return p.read_text().splitlines() if p.exists() else []


ACCESS_STEPS = ["build_edit_access.py ", "build_codeowners.py "]


class TestOrderAndOutput(DeriveCase):
    def test_default_runs_graph_site_shard_then_access_and_skips_contributors(self):
        self.assertEqual(self.run_derive(), 0)
        self.assertEqual(self.order(), ["build_wiki_graph.py ", "build_search_index.py --site-only"]
                         + ACCESS_STEPS)
        self.assertIn("derive: build_wiki_graph.py ok", self.lines)
        self.assertIn("derive: build_search_index.py --site-only ok", self.lines)
        self.assertIn("derive: build_edit_access.py ok", self.lines)
        self.assertIn("derive: build_codeowners.py ok", self.lines)
        self.assertTrue(any(l.startswith("derive: build_contributors.py skipped")
                            for l in self.lines), self.out)

    def test_one_line_per_builder_plus_summary_in_order(self):
        self.run_derive()
        self.assertEqual(len(self.lines), 6, self.out)
        self.assertTrue(all(l.startswith("derive: ") for l in self.lines), self.out)
        # the skip line stands where the contributors step would have run
        self.assertTrue(self.lines[2].startswith("derive: build_contributors.py skipped"), self.out)
        self.assertEqual(self.lines[3:5], ["derive: build_edit_access.py ok", "derive: build_codeowners.py ok"])

    def test_contributors_flag_runs_all_five_in_order(self):
        self.assertEqual(self.run_derive("--contributors"), 0)
        self.assertEqual(self.order(), ["build_wiki_graph.py ",
                                        "build_search_index.py --site-only",
                                        "build_contributors.py "] + ACCESS_STEPS)
        self.assertIn("derive: build_contributors.py ok", self.lines)

    def test_codeowners_and_edit_access_changes_are_counted(self):
        self.builder("build_edit_access.py", fake_writer({"data/graph/edit-access.json": "access-v2\n"}))
        self.builder("build_codeowners.py", fake_writer({".github/CODEOWNERS": "owners-v2\n"}))
        self.assertEqual(self.run_derive(), 0)
        self.assertEqual(self.lines[-1], "derive: 2 files changed (.github/CODEOWNERS, "
                                         "data/graph/edit-access.json)")

    def test_a_new_codeowners_file_is_counted(self):
        (self.root / ".github/CODEOWNERS").unlink()
        self.assertEqual(self.run_derive(), 0)
        self.assertEqual(self.lines[-1], "derive: 1 file changed (.github/CODEOWNERS)")

    def test_other_github_files_are_not_counted(self):
        self.builder("build_codeowners.py", fake_writer({".github/CODEOWNERS": "owners-v1\n",
                                                         ".github/workflows/x.yml": "x\n"}))
        self.run_derive()
        self.assertEqual(self.lines[-1], "derive: nothing to do")

    def test_nothing_to_do_when_outputs_unchanged(self):
        self.run_derive("--contributors")
        self.assertEqual(self.lines[-1], "derive: nothing to do")

    def test_changed_files_are_counted_and_listed_sorted(self):
        self.builder("build_wiki_graph.py", fake_writer({"data/graph/wiki.json": "wiki-v2\n"}))
        self.builder("build_search_index.py", fake_writer({"search/site.json": "site-v2\n",
                                                           "search/manifest.json": "m\n"}))
        self.assertEqual(self.run_derive(), 0)
        self.assertEqual(self.lines[-1], "derive: 3 files changed (data/graph/wiki.json, "
                                         "search/manifest.json, search/site.json)")

    def test_one_changed_file_is_singular(self):
        self.builder("build_wiki_graph.py", fake_writer({"data/graph/wiki.json": "wiki-v2\n"}))
        self.run_derive()
        self.assertEqual(self.lines[-1], "derive: 1 file changed (data/graph/wiki.json)")

    def test_files_outside_the_derived_dirs_are_not_counted(self):
        self.builder("build_wiki_graph.py", fake_writer({"data/graph/wiki.json": "wiki-v1\n",
                                                         "stray.txt": "x\n"}))
        self.run_derive()
        self.assertEqual(self.lines[-1], "derive: nothing to do")

    def test_builder_chatter_is_not_echoed_on_success(self):
        self.builder("build_wiki_graph.py", 'print("nodes: 12 (lots of detail)")\n')
        self.run_derive()
        self.assertNotIn("nodes: 12", self.out)


class TestFailure(DeriveCase):
    LOCATED = ("data/graph/edges-authored.json: 'projects/old' is not a page or repository "
               "id any more — renaming or removing an existing id needs Desert Mango "
               "(docs/maintainer-protocols.md)")

    def test_located_failure_passes_through_unchanged_and_is_last(self):
        self.builder("build_wiki_graph.py",
                     f'print("  -- some chatter")\nprint({self.LOCATED!r})\nsys.exit(1)\n')
        self.assertEqual(self.run_derive(), 1)
        self.assertEqual(self.lines[-1], self.LOCATED)
        self.assertIn("  -- some chatter", self.out.splitlines())
        self.assertTrue(any(l.startswith("derive: build_wiki_graph.py FAILED (exit 1)")
                            for l in self.lines), self.out)
        self.assertNotIn("Traceback", self.out)

    def test_failure_stops_the_run_and_prints_no_summary(self):
        self.builder("build_wiki_graph.py", 'sys.exit(1)\n')
        self.assertEqual(self.run_derive(), 1)
        self.assertEqual(self.order(), ["build_wiki_graph.py "])
        self.assertFalse(any("files changed" in l or "nothing to do" in l for l in self.lines))

    def test_stderr_message_is_passed_through(self):
        self.builder("build_search_index.py",
                     'print("data/projects.json:3:5: Expecting value", file=sys.stderr)\n'
                     'sys.exit(2)\n')
        self.assertEqual(self.run_derive(), 1)
        self.assertIn("derive: build_search_index.py --site-only FAILED (exit 2) — "
                      "its own message follows:", self.lines)
        self.assertEqual(self.lines[-1], "data/projects.json:3:5: Expecting value")

    def test_contributors_failure_names_it(self):
        self.builder("build_contributors.py", 'print("ABORT: gh said 403", file=sys.stderr)\n'
                                              'sys.exit(1)\n')
        self.assertEqual(self.run_derive("--contributors"), 1)
        self.assertTrue(any(l.startswith("derive: build_contributors.py FAILED")
                            for l in self.lines), self.out)
        self.assertEqual(self.lines[-1], "ABORT: gh said 403")

    def test_missing_builder_fails_by_name(self):
        (self.root / "tools/build_search_index.py").unlink()
        self.assertEqual(self.run_derive(), 1)
        self.assertIn("build_search_index.py", self.lines[-1])
        self.assertNotIn("Traceback", self.out)

    def test_flags_are_mutually_exclusive(self):
        self.assertEqual(self.run_derive("--contributors", "--contributors-if-changed", "HEAD"), 2)


SOFT_FAIL = "derive: build_github_data.py FAILED — previous GitHub data kept"


class TestGithubData(DeriveCase):
    def test_off_by_default_and_silent(self):
        self.assertEqual(self.run_derive(), 0)
        self.assertNotIn("build_github_data.py ", self.order())
        self.assertFalse(any("build_github_data" in l for l in self.lines), self.out)

    def test_runs_last_after_contributors_and_access(self):
        self.assertEqual(self.run_derive("--contributors", "--github-data"), 0)
        self.assertEqual(self.order(), ["build_wiki_graph.py ",
                                        "build_search_index.py --site-only",
                                        "build_contributors.py "] + ACCESS_STEPS
                         + ["build_github_data.py "])
        self.assertIn("derive: build_github_data.py ok", self.lines)
        self.assertEqual(self.lines[-1], "derive: nothing to do")

    def test_combines_with_contributors_if_changed(self):
        self.assertEqual(self.run_derive("--contributors-if-changed", "0" * 40,
                                         "--github-data"), 0)
        self.assertEqual(self.order()[-4:], ["build_contributors.py "] + ACCESS_STEPS
                         + ["build_github_data.py "])

    def test_not_with_annotate(self):
        self.assertEqual(self.run_derive("--annotate", "x.txt", "--github-data"), 2)

    def test_new_outputs_are_counted(self):
        self.builder("build_github_data.py", fake_writer({
            "data/graph/org-activity.json": "activity-v2\n",
            "data/graph/avatars/bob.jpg": "jpg\n"}))
        self.assertEqual(self.run_derive("--github-data"), 0)
        self.assertEqual(self.lines[-1], "derive: 2 files changed (data/graph/avatars/bob.jpg, "
                                         "data/graph/org-activity.json)")

    def test_soft_fail_keeps_previous_bytes_and_exits_zero(self):
        self.builder("build_wiki_graph.py", fake_writer({"data/graph/wiki.json": "wiki-v2\n"}))
        # a builder that dies half-way: one file rewritten, one avatar added,
        # one avatar removed — derive must put every byte back
        self.builder("build_github_data.py", fake_writer({
            "data/graph/org-activity.json": "half-written\n",
            "data/graph/avatars/new.png": "new\n"})
            + "(root / 'data/graph/avatars/ada.png').unlink()\n"
            + 'print("ABORT: gh said 502", file=sys.stderr)\nsys.exit(1)\n')
        self.assertEqual(self.run_derive("--github-data"), 0)
        self.assertIn(SOFT_FAIL, self.lines)
        self.assertEqual((self.root / "data/graph/org-activity.json").read_text(),
                         "activity-v1\n")
        self.assertEqual((self.root / "data/graph/avatars/ada.png").read_text(), "png-v1\n")
        self.assertFalse((self.root / "data/graph/avatars/new.png").exists())
        # the graph still refreshed, and only it is reported as changed
        self.assertEqual(self.lines[-1], "derive: 1 file changed (data/graph/wiki.json)")
        # the builder's own message is shown, before the soft-fail line
        self.assertIn("ABORT: gh said 502", self.out)
        self.assertLess(self.out.index("ABORT: gh said 502"), self.out.index(SOFT_FAIL))

    def test_soft_fail_line_is_not_an_error_annotation(self):
        self.assertEqual(derive.findings(SOFT_FAIL + "\n"), [])

    def test_contributors_failure_is_still_hard(self):
        self.builder("build_contributors.py", "sys.exit(1)\n")
        self.assertEqual(self.run_derive("--contributors", "--github-data"), 1)
        self.assertNotIn("build_github_data.py ", self.order())
        self.assertNotIn("build_edit_access.py ", self.order(), "never build access from a failed count")


class TestAccessSteps(DeriveCase):
    """build_edit_access.py and build_codeowners.py: on every call, hard failures."""

    def test_edit_access_failure_is_hard_and_stops_codeowners(self):
        self.builder("build_edit_access.py",
                     'print("build_edit_access: FAILED — data/graph/contributors.json: missing")\nsys.exit(1)\n')
        self.assertEqual(self.run_derive("--github-data"), 1)
        self.assertEqual(self.order(), ["build_wiki_graph.py ", "build_search_index.py --site-only",
                                        "build_edit_access.py "])
        self.assertIn("derive: build_edit_access.py FAILED (exit 1) — its own message follows:", self.lines)
        self.assertEqual(self.lines[-1], "build_edit_access: FAILED — data/graph/contributors.json: missing")

    def test_codeowners_failure_is_hard(self):
        self.builder("build_codeowners.py", "sys.exit(1)\n")
        self.assertEqual(self.run_derive("--github-data"), 1)
        self.assertNotIn("build_github_data.py ", self.order())
        self.assertTrue(any(l.startswith("derive: build_codeowners.py FAILED") for l in self.lines), self.out)

    def test_a_builders_note_lines_are_passed_through_after_its_ok_line(self):
        # build_edit_access.py prints "  note: ..." for a project with no contributors entry yet
        self.builder("build_edit_access.py",
                     'print("  note: \'fresh\' has no entry in data/graph/contributors.json yet: its add list only")\n'
                     'print("wrote data/graph/edit-access.json: 1 projects, 1 editor entries")\n')
        self.assertEqual(self.run_derive(), 0)
        i = self.lines.index("derive: build_edit_access.py ok")
        self.assertEqual(self.lines[i + 1],
                         "  note: 'fresh' has no entry in data/graph/contributors.json yet: its add list only")
        self.assertEqual(self.lines[i + 2], "derive: build_codeowners.py ok")
        self.assertNotIn("wrote data/graph/edit-access.json", self.out, "other chatter stays quiet")

    def test_they_run_on_the_committed_contributors_when_it_is_not_rebuilt(self):
        self.assertEqual(self.run_derive(), 0)
        self.assertNotIn("build_contributors.py ", self.order())
        self.assertEqual(self.order()[-2:], ACCESS_STEPS)


class TestContributorsIfChanged(DeriveCase):
    def setUp(self):
        super().setUp()
        git(self.root, "init", "-q")
        git(self.root, "add", "-A")
        git(self.root, "commit", "-q", "-m", "one")
        self.first = git(self.root, "rev-parse", "HEAD")

    def commit(self, rel, text):
        write(self.root / rel, text)
        git(self.root, "add", "-A")
        git(self.root, "commit", "-q", "-m", "change " + rel)

    def ran_contributors(self):
        return "build_contributors.py " in self.order()

    def test_unchanged_inputs_skip_contributors(self):
        self.commit("content/about.md", "# About\n\nNew prose.\n")
        self.assertEqual(self.run_derive("--contributors-if-changed", self.first), 0)
        self.assertFalse(self.ran_contributors())
        self.assertTrue(any(l.startswith("derive: build_contributors.py skipped")
                            and self.first in l for l in self.lines), self.out)

    def test_each_input_file_triggers_contributors(self):
        # a project's facts file (2026-10-14): a repo added there changes the counts too
        for name in ("data/projects.json", "data/projects/learning-to-swim.json", "data/org-repos.json",
                     "data/people.json", "data/github-links.json"):
            with self.subTest(name=name):
                (self.root / "order.log").unlink(missing_ok=True)
                before = git(self.root, "rev-parse", "HEAD")
                self.commit(name, f"[{{\"v\": {len(name)}}}]\n")
                self.assertEqual(self.run_derive("--contributors-if-changed", before), 0)
                self.assertTrue(self.ran_contributors(), self.out)

    def test_zero_sha_means_changed(self):
        self.assertEqual(self.run_derive("--contributors-if-changed", "0" * 40), 0)
        self.assertTrue(self.ran_contributors())
        self.assertTrue(any("all-zeros" in l for l in self.lines), self.out)

    def test_unresolvable_ref_is_fetched_then_treated_as_changed(self):
        missing = "1234567890abcdef1234567890abcdef12345678"
        self.assertEqual(self.run_derive("--contributors-if-changed", missing), 0)
        self.assertTrue(self.ran_contributors())
        self.assertTrue(any("cannot resolve" in l and missing in l for l in self.lines),
                        self.out)

    def test_ref_fetched_from_origin_when_missing_locally(self):
        # a clone that lacks the commit locally, but its origin has it
        self.commit("data/projects.json", "[1]\n")
        target = git(self.root, "rev-parse", "HEAD~1")
        clone = Path(self._tmp.name) / "clone"
        subprocess.run(["git", "clone", "-q", "--depth=1", f"file://{self.root}", str(clone)],
                       check=True, capture_output=True)
        self.assertNotEqual(subprocess.run(
            ["git", "cat-file", "-e", f"{target}^{{commit}}"], cwd=clone,
            capture_output=True).returncode, 0)
        changed, why = derive.contributors_inputs_changed(clone, target)
        self.assertTrue(changed, why)
        self.assertIn("differ", why)


class TestAnnotate(unittest.TestCase):
    def annotate(self, *texts):
        with TemporaryDirectory() as d:
            paths = []
            for i, t in enumerate(texts):
                p = Path(d) / f"f{i}.txt"
                p.write_text(t, encoding="utf-8")
                paths.append(str(p))
            paths.append(str(Path(d) / "absent.txt"))
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = derive.main(["--annotate", *paths])
        self.assertEqual(rc, 0)
        return buf.getvalue().splitlines()

    def test_gate_lines_become_annotations_by_shape(self):
        out = self.annotate(
            "CHECK FAILED — 4 problem(s):\n"
            "  ✗ data/tools.json:7:3: Expecting property name (strict JSON)\n"
            "  ✗ content/setup/x.md:12: inline script\n"
            "  ✗ data/projects.json: project 'x' has no body file\n"
            "  ✗ search shard is stale: 3 pages missing\n"
            "    continuation detail that is not a finding\n")
        self.assertEqual(out, [
            "::error file=data/tools.json,line=7,col=3,title=check.py::"
            "Expecting property name (strict JSON)",
            "::error file=content/setup/x.md,line=12,title=check.py::inline script",
            "::error file=data/projects.json,title=check.py::project 'x' has no body file",
            "::error title=check.py::search shard is stale: 3 pages missing",
        ])

    def test_green_gate_emits_nothing(self):
        self.assertEqual(self.annotate("check.py: all green\nreminder: x\n"), [])

    def test_derive_failure_block_is_annotated_and_deduplicated(self):
        located = ("data/graph/edges-authored.json: 'projects/old' is not a page or "
                   "repository id any more — renaming or removing an existing id needs "
                   "Desert Mango (docs/maintainer-protocols.md)")
        derive_out = ("derive: build_wiki_graph.py FAILED (exit 1) — its own message follows:\n"
                      "  -- repo name 'x' muted\n"
                      "nodes: 3\n"
                      f"{located}\n")
        gate_out = f"CHECK FAILED — 1 problem(s):\n  ✗ {located}\n"
        out = self.annotate(derive_out, gate_out)
        self.assertEqual(out, [
            "::error file=data/graph/edges-authored.json,title=check.py::'projects/old' is not "
            "a page or repository id any more — renaming or removing an existing id needs "
            "Desert Mango (docs/maintainer-protocols.md)"])

    def test_fail_prefix_is_stripped(self):
        out = self.annotate("derive: build_wiki_graph.py FAILED (exit 1) — its own message "
                            "follows:\nFAIL: data/site.json:2:1: Expecting value (strict JSON)\n")
        self.assertEqual(out, ["::error file=data/site.json,line=2,col=1,title=check.py::"
                               "Expecting value (strict JSON)"])

    def test_unlocated_derive_failure_falls_back_to_last_line(self):
        out = self.annotate("derive: build_search_index.py --site-only FAILED (exit 1) — its "
                            "own message follows:\nTraceback (most recent call last):\n"
                            "  File \"x\", line 1\nKeyError: 'title'\n")
        self.assertEqual(out, ["::error title=check.py::KeyError: 'title'"])

    def test_workflow_command_escaping(self):
        out = self.annotate("  ✗ a,b.json: 100% broken\n")
        self.assertEqual(out, ["::error file=a%2Cb.json,title=check.py::100%25 broken"])

    def test_successful_derive_output_emits_nothing(self):
        self.assertEqual(self.annotate("derive: build_wiki_graph.py ok\n"
                                       "derive: nothing to do\n"), [])


class TestWorkflows(unittest.TestCase):
    """Shape checks on the YAML (no YAML parser in the stdlib: plain text rules)."""

    def setUp(self):
        self.check = (REPO / ".github/workflows/check.yml").read_text()
        self.derive = (REPO / ".github/workflows/derive.yml").read_text()

    def test_check_job_name_and_verbatim_gate(self):
        self.assertIn("\n  check:\n", self.check)
        self.assertIn("    name: check\n", self.check)
        gate = [l for l in self.check.splitlines() if "tools/check.py" in l
                and "tee" in l]
        self.assertEqual(len(gate), 1, gate)
        self.assertTrue(gate[0].strip().startswith("python3 tools/check.py 2>&1 | tee "), gate)
        self.assertIn("gate-output.txt", gate[0])

    def test_advisory_job_is_gone(self):
        self.assertNotIn("search-shard-advisory", self.check)

    def test_no_branch_protection_claims(self):
        self.assertNotIn("required status check", self.check.lower())
        self.assertNotIn("branch protection", self.check.lower())

    def test_regenerate_step_is_pull_request_only(self):
        i = self.check.index("python3 tools/derive.py 2>&1 | tee derive-output.txt")
        step = self.check[self.check.rindex("- name:", 0, i):i]
        self.assertIn("if: github.event_name == 'pull_request'", step)

    def test_only_external_action_is_pinned_checkout(self):
        for text in (self.check, self.derive):
            uses = [l.strip() for l in text.splitlines() if l.strip().startswith("- uses:")
                    or l.strip().startswith("uses:")]
            self.assertTrue(uses)
            for u in uses:
                self.assertRegex(u, r"uses: actions/checkout@[0-9a-f]{40}\b")

    def test_derive_workflow_guards(self):
        d = self.derive
        self.assertIn("branches: [main]", d)
        self.assertIn("concurrency: derive-main", d)
        # A push made with the App token starts workflows (GITHUB_TOKEN's did not),
        # so the loop guard is load-bearing: no bot push ever runs derive again. Never a skip by message: a human commit with
        # derive's subject must still be rebuilt (codex r1). Only a bot PUSH is skipped (2026-10-19):
        # a schedule or a manual dispatch always runs, and a dispatch only from main.
        self.assertIn("    if: ${{ (!endsWith(github.actor, '[bot]') || github.event_name != 'push') && "
                      "(github.event_name != 'workflow_dispatch' || github.ref == 'refs/heads/main') }}\n", d)
        self.assertNotIn("head_commit.message", d)
        self.assertIn("fetch-depth: 2", d)
        self.assertIn("--contributors-if-changed", d)
        self.assertIn("derive: regenerate derived data after", d)
        self.assertIn("python3 tools/check.py", d)

    def test_derive_pushes_as_the_app_only(self):
        d = self.derive
        # The secret lives in the `derive` environment (main only); the job names it.
        self.assertIn("    environment: derive\n", d)
        secrets = sorted(set(re.findall(r"secrets\.([A-Z_]+)", d)))
        self.assertEqual(secrets, ["DERIVE_APP_ID", "DERIVE_APP_PRIVATE_KEY"])
        # Kyle stored the App id as a secret (2026-10-15); a variable of that name wins if one is added
        self.assertIn("DERIVE_APP_ID: ${{ vars.DERIVE_APP_ID || secrets.DERIVE_APP_ID }}", d)
        self.assertIn("python3 tools/github_app_token.py", d)
        # The token is masked before anything else and revoked on exit.
        mint = d.index("python3 tools/github_app_token.py)")
        self.assertIn('echo "::add-mask::$APP_TOKEN"', d[mint:mint + 400])
        self.assertIn("python3 tools/github_app_token.py --revoke", d)
        # checkout keeps no credentials: the read-only GITHUB_TOKEN never pushes,
        # and the App token goes only to the push, never into .git/config.
        self.assertIn("persist-credentials: false", d)
        self.assertIn("GIT_CONFIG_KEY_0: ", d.replace("GIT_CONFIG_KEY_0=", "GIT_CONFIG_KEY_0: "))
        self.assertNotIn("x-access-token:$APP_TOKEN@", d)
        perms = d[d.index("    permissions:"):d.index("    steps:")]
        self.assertNotIn("contents: write", perms)
        self.assertIn("contents: read", perms)
        self.assertNotIn("github-actions[bot]@users.noreply", d)

    def test_derive_workflow_github_data(self):
        d = self.derive
        run = [l for l in d.splitlines() if "python3 tools/derive.py" in l
               and "--contributors-if-changed" in l]
        self.assertEqual(len(run), 1, run)
        self.assertIn('--contributors-if-changed "$BEFORE" --github-data', run[0])
        perms = d[d.index("    permissions:"):d.index("    steps:")]
        self.assertIn("pull-requests: read", perms)
        self.assertIn("::warning", d)
        self.assertIn(SOFT_FAIL, d)
        self.assertIn("set -euo pipefail", d)


    def test_derive_workflow_daily_schedule_and_dispatch(self):
        # Kyle, 2026-10-19: commit counts change when someone commits to a lab repo, not when this
        # repo changes, so who may edit is rebuilt daily; a manual run may start only from main.
        d = self.derive
        on = d[d.index("\non:\n"):d.index("\nconcurrency:")]
        self.assertIn("  push:\n    branches: [main]", on)
        self.assertIn("  schedule:\n    - cron: '17 4 * * *'", on)
        self.assertIn("  workflow_dispatch:", on)
        self.assertIn("ref: ${{ github.event_name == 'push' && github.sha || 'refs/heads/main' }}", d)
        self.assertIn("EVENT_NAME: ${{ github.event_name }}", d)
        self.assertIn('if [ "$EVENT_NAME" = push ]; then', d)
        run = [l.strip() for l in d.splitlines() if "python3 tools/derive.py" in l]
        self.assertEqual(len(run), 2, run)
        sched = [l for l in run if "--contributors-if-changed" not in l]
        self.assertEqual(len(sched), 1, run)
        self.assertTrue(sched[0].startswith("python3 tools/derive.py --contributors --github-data |"), sched)
        self.assertNotIn("BEFORE", sched[0])
        self.assertIn("60 days", d)

    def test_derive_workflow_commits_codeowners_too(self):
        d = self.derive
        self.assertIn('git status --porcelain search/ data/graph/ .github/CODEOWNERS', d)
        self.assertIn("git add -A search/ data/graph/ .github/CODEOWNERS", d)
        self.assertNotIn("git add -A\n", d)

    def guard_step(self):
        c = self.check
        i = c.index("- name: Refuse authorization data in a pull request")
        return c[i:c.index("- name:", i + 1)]

    def test_check_refuses_authorization_data_in_a_pull_request(self):
        step = self.guard_step()
        self.assertIn("if: github.event_name == 'pull_request'", step)
        self.assertIn("PR_AUTHOR: ${{ github.event.pull_request.user.login }}", step)
        self.assertIn("git diff --name-only HEAD^1 HEAD -- data/graph/contributors.json "
                      "data/graph/edit-access.json .github/CODEOWNERS", step)
        self.assertIn("*'[bot]')", step)
        self.assertIn("exit 1", step)
        self.assertIn("only through derive", step)
        run = step[step.index("run: |"):]
        self.assertNotIn("${{", run, "event text reaches the shell only through env")
        # its own step, BEFORE the derive step rewrites the workspace
        self.assertLess(self.check.index("- name: Refuse authorization data"),
                        self.check.index("python3 tools/derive.py 2>&1 | tee derive-output.txt"))

    def test_check_notice_lists_the_access_files(self):
        c = self.check
        note = c[c.index("- name: Note derived files carried by the pull request"):]
        self.assertIn("git status --porcelain search/ data/graph/ .github/CODEOWNERS", note)
        self.assertIn("data/graph/edit-access.json", note)
        self.assertIn(".github/CODEOWNERS", note)
        self.assertNotIn("contributors.json is optional to the gate", c)


class TestGoLiveWorkflow(unittest.TestCase):
    """go-live.yml (plan-u5 U5a): shape rules, plain text (no YAML parser in the stdlib)."""

    def setUp(self):
        self.g = (REPO / ".github/workflows/go-live.yml").read_text()
        self.derive = (REPO / ".github/workflows/derive.yml").read_text()

    def test_events_and_the_job_condition(self):
        g = self.g
        self.assertIn("  issue_comment:\n    types: [created]\n", g)
        self.assertIn("  schedule:\n    - cron: '*/30 * * * *'\n", g)
        self.assertIn("  workflow_dispatch:\n", g)
        cond = g[g.index("    if: >-"):g.index("    runs-on:")]
        # schedule and workflow_dispatch always run; a comment only when it is a record on a PR by
        # someone with access
        self.assertIn("github.event_name != 'issue_comment' ||", cond)
        self.assertIn("github.event.issue.pull_request", cond)
        self.assertIn("""contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association)""", cond)
        self.assertIn("startsWith(github.event.comment.body, 'hc-approved ')", cond)
        self.assertIn("startsWith(github.event.comment.body, 'hc-declined ')", cond)
        self.assertIn("concurrency: go-live-main", g)

    def test_no_event_text_inside_run(self):
        # values reach a script only through env: (never ${{ }} spliced into the shell text)
        for text in (self.g, self.derive):
            lines = text.splitlines()
            blocks = 0
            for i, line in enumerate(lines):
                m = re.match(r"^(\s+)run: ?(.*)$", line)
                if not m:
                    continue
                blocks += 1
                self.assertNotIn("${{", m.group(2), line)
                if m.group(2).strip() not in ("|", "|-", ">", ">-"):
                    continue
                for body in lines[i + 1:]:
                    if body.strip() and len(body) - len(body.lstrip()) <= len(m.group(1)):
                        break
                    self.assertNotIn("${{", body, body)
            self.assertGreaterEqual(blocks, 1)

    def test_main_only_no_pr_code(self):
        g = self.g
        self.assertIn("          ref: main\n", g)
        self.assertIn("persist-credentials: false", g)
        self.assertNotIn("pull_request_target", g)
        self.assertNotIn("head.sha }}", g)
        self.assertNotIn("head_ref", g)

    def test_permissions_explicit_and_narrow(self):
        g = self.g
        top = g[g.index("\npermissions:"):g.index("\njobs:")]
        self.assertEqual(top.strip(), "permissions:\n  contents: read")
        perms = g[g.index("    permissions:"):g.index("    steps:")]
        lines = sorted(l.split("#")[0].strip() for l in perms.splitlines()[1:] if l.strip())
        self.assertEqual(lines, ["actions: write", "contents: read", "issues: write", "pull-requests: write"])
        self.assertIn("    environment: derive\n", g)

    def test_the_key_only_in_the_push_step_and_unset_after_minting(self):
        g = self.g
        self.assertEqual(sorted(set(re.findall(r"secrets\.([A-Z_]+)", g))), ["DERIVE_APP_ID", "DERIVE_APP_PRIVATE_KEY"])
        self.assertIn("DERIVE_APP_ID: ${{ vars.DERIVE_APP_ID || secrets.DERIVE_APP_ID }}", g)
        steps = g.split("      - name: ")
        with_key = [s for s in steps if "DERIVE_APP_PRIVATE_KEY: ${{" in s]
        self.assertEqual(len(with_key), 1)
        push = with_key[0]
        self.assertTrue(push.startswith("Commit and push as the derive App"))
        mint = push.index("creds=$(python3 tools/github_app_token.py)")
        self.assertLess(mint, push.index("unset DERIVE_APP_PRIVATE_KEY", mint))
        self.assertLess(push.index("unset DERIVE_APP_PRIVATE_KEY", mint), push.index("node tools/go_live.mjs --commit"))
        self.assertIn('echo "::add-mask::$APP_TOKEN"', push)
        self.assertIn("python3 tools/github_app_token.py --revoke", push)
        sweep = [s for s in steps if "node tools/go_live.mjs --plan" in s]
        self.assertEqual(len(sweep), 1)
        self.assertNotIn("DERIVE_APP", sweep[0])
        self.assertEqual(sum("secrets.DERIVE_APP_ID" in s for s in steps), 1, "the App id only in the push step too")

    def test_pushes_are_plain_fast_forwards(self):
        for text in (self.g, self.derive):
            pushes = [l.strip() for l in text.splitlines() if "git push" in l and not l.strip().startswith("#")]
            self.assertTrue(pushes)
            for l in pushes:
                self.assertTrue(l.endswith("git push origin HEAD:main 2>&1); then"), l)
                for bad in ("--force", "-f ", "+HEAD", "--delete", ":refs", "--mirror"):
                    self.assertNotIn(bad, l)

    def test_check_before_push_and_bounded_restart(self):
        g = self.g
        push = g[g.index("Commit and push as the derive App"):]
        self.assertLess(push.index("python3 tools/check.py"), push.index("git push origin HEAD:main"))
        self.assertIn('if [ "$ATTEMPT" -ge 3 ]; then', push)
        self.assertIn('gh workflow run go-live.yml --ref main -f attempt="$((ATTEMPT + 1))"', push)
        self.assertIn("node tools/go_live.mjs --close-done", g)
        close = g[g.index("- name: Close proposals with nothing left open"):]
        self.assertIn("if: steps.push.outputs.main_is_local == 'yes'", close)
        self.assertEqual(push.count('echo "main_is_local=yes" >> "$GITHUB_OUTPUT"'), 2)
        restart = push[push.index('if [ "$ATTEMPT" -ge 3 ]'):push.index("- name: Close proposals")]
        self.assertNotIn("main_is_local", restart)


class TestHygiene(unittest.TestCase):
    def test_stdlib_only(self):
        src = (REPO / "tools/derive.py").read_text()
        for mod in ("requests", "yaml", "graphify"):
            self.assertNotIn(f"import {mod}", src)


if __name__ == "__main__":
    unittest.main(verbosity=2)
