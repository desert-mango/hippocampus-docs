#!/usr/bin/env python3
# Author: Kyle Nelson
# Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
# Last substantive modification: 21 September 2026
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


class TestOrderAndOutput(DeriveCase):
    def test_default_runs_graph_then_site_shard_and_skips_contributors(self):
        self.assertEqual(self.run_derive(), 0)
        self.assertEqual(self.order(), ["build_wiki_graph.py ", "build_search_index.py --site-only"])
        self.assertIn("derive: build_wiki_graph.py ok", self.lines)
        self.assertIn("derive: build_search_index.py --site-only ok", self.lines)
        self.assertTrue(any(l.startswith("derive: build_contributors.py skipped")
                            for l in self.lines), self.out)

    def test_one_line_per_builder_plus_summary(self):
        self.run_derive()
        self.assertEqual(len(self.lines), 4, self.out)
        self.assertTrue(all(l.startswith("derive: ") for l in self.lines), self.out)

    def test_contributors_flag_runs_all_three_in_order(self):
        self.assertEqual(self.run_derive("--contributors"), 0)
        self.assertEqual(self.order(), ["build_wiki_graph.py ",
                                        "build_search_index.py --site-only",
                                        "build_contributors.py "])
        self.assertIn("derive: build_contributors.py ok", self.lines)

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
        for name in ("data/projects.json", "data/org-repos.json", "data/people.json"):
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
        self.assertIn("contents: write", d)
        self.assertIn("if: github.actor != 'github-actions[bot]'", d)
        self.assertIn("fetch-depth: 2", d)
        self.assertIn("--contributors-if-changed", d)
        self.assertIn("41898282+github-actions[bot]@users.noreply.github.com", d)
        self.assertIn("derive: regenerate derived data after", d)
        self.assertIn("python3 tools/check.py", d)
        self.assertNotIn("secrets.", d)


class TestHygiene(unittest.TestCase):
    def test_stdlib_only(self):
        src = (REPO / "tools/derive.py").read_text()
        for mod in ("requests", "yaml", "graphify"):
            self.assertNotIn(f"import {mod}", src)


if __name__ == "__main__":
    unittest.main(verbosity=2)
