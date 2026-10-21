#!/usr/bin/env python3
# Author: Kyle Nelson
# Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
# Last substantive modification: 19 October 2026
# Affiliation: TUHH HippoCampus Robotics
# Purpose: Test the project registry rules in the site quality gate: the add and remove lists and their shape.
"""Unit tests for the projects half of the check gate (tools/check.py).

Run from the repo root with plain python3 (no pytest, no network):

    python3 tools/tests/test_check_projects.py

Kyle, 2026-10-19: every project in data/projects.json carries `add` and
`remove`, the admin's per-person overrides of the commits rule (`owners`, the
older hand-kept list, was renamed to `add`). tools/build_edit_access.py turns
them, with the commit counts, into who may edit each project. The checks are pure
functions over loaded dicts; a red is proven with an in-memory fixture.
"""
import copy
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import check  # noqa: E402
import projects_registry  # noqa: E402
import build_codeowners  # noqa: E402


def spec_errors(doc):
    """The READER_REQUIRED_KEYS findings for one projects document (check.py collects into check.errors)."""
    before = len(check.errors)
    check.check_reader_registry("data/projects.json", doc, check.READER_REQUIRED_KEYS["data/projects.json"])
    out = check.errors[before:]
    del check.errors[before:]
    return out


class AccessListsTest(unittest.TestCase):
    """Each index entry's `add` and `remove` lists (Kyle, 2026-10-19): the admin's per-person overrides of the
    commits rule. `owners` was renamed to `add`."""

    def setUp(self):
        self.real = json.loads((ROOT / "data" / "projects.json").read_text(encoding="utf-8"))

    def test_j8_the_real_registry_is_clean_and_adds_kyle_to_three_projects(self):
        # J8 (UI/UX grill 2026-10): the run guide merged into Learning to Swim, so its own entry is gone.
        self.assertEqual(check.check_project_access(self.real), [])
        self.assertEqual(spec_errors(self.real), [])
        added = sorted(p["id"] for p in self.real["projects"] if "kyle-nelson-berkeley" in p["add"])
        self.assertEqual(added, ["learning-to-swim", "scalar-field", "underwater-localization"])
        self.assertTrue(all(p["remove"] == [] for p in self.real["projects"]))

    def test_add_and_remove_are_required_lists_of_strings(self):
        for key in ("add", "remove"):
            doc = copy.deepcopy(self.real)
            del doc["projects"][0][key]
            self.assertTrue(any(f'"{key}"' in e for e in spec_errors(doc)), spec_errors(doc))
            doc = copy.deepcopy(self.real)
            doc["projects"][0][key] = "kyle-nelson-berkeley"          # a string iterates as characters
            self.assertTrue(any(key in e for e in spec_errors(doc)), key)
            doc = copy.deepcopy(self.real)
            doc["projects"][0][key] = ["kyle-nelson-berkeley", 7]
            self.assertTrue(any(key in e for e in spec_errors(doc)), key)

    def test_empty_lists_are_fine(self):
        doc = {"projects": [{"id": "x", "add": [], "remove": []}]}
        self.assertEqual(check.check_project_access(doc), [])

    def test_each_login_is_well_formed_and_none_twice_in_a_list(self):
        for key in ("add", "remove"):
            doc = copy.deepcopy(self.real)
            doc["projects"][0][key] = ["kyle-nelson-berkeley", "Kyle-Nelson-Berkeley", "not a login", "-x", "@x",
                                       "dependabot[bot]", "a" * 40]
            errs = check.check_project_access(doc)
            self.assertEqual(len(errs), 6, errs)
            self.assertTrue(any("twice" in e for e in errs))
            self.assertTrue(all(doc["projects"][0]["id"] in e and f"`{key}`" in e for e in errs), errs)

    def test_legacy_logins_round_trip_through_the_lists(self):
        """One login pattern everywhere (2026-10-19): a legacy login such as "a--b" can hold commits and so be
        an editor; an admin must be able to remove it (and add one like "zz-") without the gate refusing the
        index the editor writes."""
        import build_edit_access
        self.assertIs(check.ACCESS_LIST_LOGIN_RE, build_edit_access.COMMIT_LOGIN_RE)
        doc = copy.deepcopy(self.real)
        entry = next(p for p in doc["projects"] if p["id"] == "scalar-field")
        entry["remove"] = ["a--b"]
        entry["add"] = entry["add"] + ["zz-"]
        self.assertEqual(check.check_project_access(doc), [])
        self.assertEqual(spec_errors(doc), [])
        contrib = {"projects": {"scalar-field": {"contributors": [], "repos": ["r"],
                                                 "commits": {"a--b": {"r": 4}, "ada": {"r": 1}}}}}
        got = build_edit_access.effective_access(doc, contrib, {"exclude": []})["projects"]["scalar-field"]
        self.assertEqual(got["removed"], [{"login": "a--b", "had_commits": True}])
        logins = [e["login"] for e in got["editors"]]
        self.assertNotIn("a--b", logins)
        self.assertIn("zz-", logins)

    def test_a_login_in_both_lists_is_refused_case_insensitively(self):
        doc = {"projects": [{"id": "x", "add": ["Ada-L"], "remove": ["ada-l"]}]}
        errs = check.check_project_access(doc)
        self.assertEqual(len(errs), 1, errs)
        self.assertIn("'ada-l'", errs[0])
        self.assertIn("both `add` and `remove`", errs[0])

    def test_a_leftover_owners_key_says_it_was_renamed(self):
        doc = {"projects": [{"id": "x", "owners": ["ada"], "add": [], "remove": []}]}
        errs = check.check_project_access(doc)
        self.assertEqual(len(errs), 1, errs)
        self.assertIn("renamed to `add` (2026-10-19): reload the editor", errs[0])
        # said once: check_project_files leaves the index's `owners` to check_project_access
        self.assertEqual(check.check_project_files(doc, {"data/projects/x.json": {"file": "content/projects/x.md"}}), [])

    def test_a_wrong_shape_never_raises_here(self):
        self.assertEqual(check.check_project_access({"projects": [{"id": "x", "add": "str", "remove": 3}, "y", {"id": "z"}]}), [])
        self.assertEqual(check.check_project_access([]), [])


def real_facts():
    return {f"data/projects/{p.name}": json.loads(p.read_text(encoding="utf-8"))
            for p in sorted((ROOT / "data" / "projects").glob("*.json"))}


def site_slugify(text):
    """The heading-id rule of js/app.js `slugify` (lowercase, strip non-word, spaces and _ to `-`)."""
    s = re.sub(r"[^\w\s-]", "", text.lower(), flags=re.ASCII).strip()
    s = re.sub(r"[\s_]+", "-", s).strip("-")
    return s or "section"


def markdown_headings(text, levels=(2, 3, 4)):
    """The h2-h4 heading texts of a Markdown file, outside fenced code (the levels `enhance` gives ids to)."""
    out, fence = [], False
    for line in text.splitlines():
        if line.lstrip().startswith(("```", "~~~")):
            fence = not fence
            continue
        m = None if fence else re.match(r"^(#{1,6})\s+(.*?)\s*#*\s*$", line)
        if m and len(m.group(1)) in levels:
            out.append(m.group(2))
    return out


class LearningToSwimMergeTest(unittest.TestCase):
    """J8 (UI/UX grill 2026-10): the simulation run guide is a section of the Learning to Swim page, not a project."""

    def setUp(self):
        self.text = (ROOT / "content" / "projects" / "learning-to-swim.md").read_text(encoding="utf-8")

    def test_j8_merged_page_heading_slugs_are_unique_and_the_guide_anchor_exists_once(self):
        slugs = [site_slugify(h) for h in markdown_headings(self.text)]
        dupes = sorted({s for s in slugs if slugs.count(s) > 1})
        self.assertEqual(dupes, [], f"duplicate heading slugs: {dupes}")
        self.assertEqual(slugs.count("simulation-run-guide"), 1, slugs)

    def test_j8_the_slug_rule_matches_the_site(self):
        self.assertEqual(site_slugify("Run it on the robot's Raspberry Pi"), "run-it-on-the-robots-raspberry-pi")
        self.assertEqual(site_slugify("The full check (optional)"), "the-full-check-optional")
        self.assertEqual(site_slugify("!!!"), "section")

    def test_j8_the_guide_is_no_longer_its_own_project(self):
        self.assertFalse((ROOT / "content" / "projects" / "learning-to-swim-run-guide.md").exists())
        self.assertFalse((ROOT / "data" / "projects" / "learning-to-swim-run-guide.json").exists())
        facts = json.loads((ROOT / "data" / "projects" / "learning-to-swim.json").read_text(encoding="utf-8"))
        self.assertIn({"href": "#/projects/learning-to-swim@simulation-run-guide", "label": "Simulation run guide"},
                      facts["links"])
        self.assertEqual(facts["hardware"], ["HippoCampus micro AUV", "BlueROV2 Heavy", "Raspberry Pi"])


class SplitRegistryTest(unittest.TestCase):
    """Each project's facts in its own file (Kyle, 2026-10-14); the index keeps id, order, add and remove."""

    def setUp(self):
        self.index = json.loads((ROOT / "data" / "projects.json").read_text(encoding="utf-8"))
        self.facts = real_facts()

    def test_the_real_split_is_clean_and_every_facts_file_meets_its_spec(self):
        self.assertEqual(check.check_project_files(self.index, self.facts), [])
        self.assertEqual(len(self.facts), len(self.index["projects"]))
        for rel, doc in self.facts.items():
            before = len(check.errors)
            check.check_reader_registry(rel, doc, check.PROJECT_FACTS_SPEC)
            self.assertEqual(check.errors[before:], [], rel)
        for e in self.index["projects"]:
            self.assertEqual(list(e), ["id", "add", "remove"], e["id"])

    def test_the_merge_is_the_document_every_reader_knew(self):
        merged = projects_registry.load(ROOT)
        self.assertEqual([p["id"] for p in merged["projects"]], [p["id"] for p in self.index["projects"]], "the index's order")
        for p in merged["projects"]:
            self.assertEqual(list(p)[:3], ["id", "add", "remove"])
            self.assertEqual(p["file"], f"content/projects/{p['id']}.md")
            self.assertIn("repos", p)
        self.assertEqual(merged["intro"], self.index["intro"])

    def test_facts_in_the_index_a_missing_or_stray_file_and_access_keys_in_a_facts_file_are_named(self):
        index = copy.deepcopy(self.index)
        facts = copy.deepcopy(self.facts)
        index["projects"][0]["name"] = "sneaked back"                      # facts in the admin file
        del facts["data/projects/scalar-field.json"]                       # a listed project with no facts
        facts["data/projects/stray.json"] = {"name": "x"}                  # a facts file nobody listed
        facts["data/projects/learning-to-swim.json"]["owners"] = ["someone"]   # an editor widening access
        facts["data/projects/teaching.json"]["add"] = ["someone"]
        facts["data/projects/uvms.json"]["remove"] = ["someone"]
        facts["data/projects/cameras.json"]["id"] = "cameras"
        facts["data/projects/acoustics.json"]["file"] = "content/about.md"
        errs = check.check_project_files(index, facts)
        joined = "\n".join(errs)
        self.assertIn("carries ['name']", joined)
        self.assertIn("'scalar-field' has no facts file", joined)
        self.assertIn("data/projects/stray.json: not in data/projects.json", joined)
        self.assertIn("data/projects/learning-to-swim.json: 'owners' belongs in data/projects.json", joined)
        self.assertIn("data/projects/teaching.json: 'add' belongs in data/projects.json", joined)
        self.assertIn("data/projects/uvms.json: 'remove' belongs in data/projects.json", joined)
        self.assertIn("data/projects/cameras.json: 'id' belongs in data/projects.json", joined)
        self.assertIn("data/projects/acoustics.json: file must be content/projects/acoustics.md", joined)
        self.assertEqual(len(errs), 8, errs)

    def test_ids_must_be_page_addresses_and_unique(self):
        index = copy.deepcopy(self.index)
        index["projects"].append({"id": "Bad Id", "add": [], "remove": []})
        index["projects"].append(copy.deepcopy(index["projects"][0]))
        errs = check.check_project_files(index, self.facts)
        self.assertTrue(any("lowercase letters" in e for e in errs), errs)
        self.assertTrue(any("listed twice" in e for e in errs), errs)

    def test_coverage_runs_across_the_files(self):
        """The coverage rule (every org repo in exactly one project) sees the merged registry: a repo moved
        into a second project's facts file is counted twice."""
        merged = projects_registry.load(ROOT)
        names = [r["name"] for p in merged["projects"] for r in p["repos"] if not r.get("external")]
        self.assertEqual(len(names), len(set(names)), "every repo once across the facts files")
        org = {r["name"] for r in json.loads((ROOT / "data" / "org-repos.json").read_text(encoding="utf-8"))}
        excluded = {x["name"] for x in merged.get("exclusions", [])}
        self.assertEqual(org, set(names) | excluded)

    def test_a_split_registry_anywhere_reads_its_facts_beside_it(self):
        """A fixture laid out like data/ (projects.json + projects/<id>.json) is read from itself, never from
        this checkout's data/projects/ (tools/build_contributors.py --fixture uses this)."""
        import tempfile
        import build_contributors
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            (d / "projects").mkdir()
            (d / "projects.json").write_text(json.dumps({"intro": "x", "projects": [{"id": "fx", "add": [], "remove": []}]}), encoding="utf-8")
            (d / "projects" / "fx.json").write_text(json.dumps({"name": "Fixture", "repos": [{"name": "fixture_repo"}]}), encoding="utf-8")
            merged = projects_registry.load(ROOT, d / "projects.json")
            self.assertEqual(merged["projects"], [{"id": "fx", "add": [], "remove": [], "name": "Fixture", "repos": [{"name": "fixture_repo"}]}])
            _, projects, _, _ = build_contributors.load_inputs(str(d))
            self.assertEqual(projects["projects"][0]["repos"], [{"name": "fixture_repo"}], "the fixture's own facts")

    def test_the_loader_is_stdlib_only(self):
        src = (ROOT / "tools" / "projects_registry.py").read_text(encoding="utf-8")
        mods = {line.split()[1].split(".")[0] for line in src.splitlines() if line.startswith(("import ", "from "))}
        self.assertEqual(mods, {"copy", "json", "pathlib"})

    def test_a_shape_error_never_raises(self):
        self.assertEqual(check.check_project_files([], {}), [])
        self.assertEqual(check.check_project_files({"projects": ["x", {"id": 3}]}, {"data/projects/a.json": "str"})[:1],
                         ["data/projects/a.json: not in data/projects.json's list — add {\"id\": \"a\", \"add\": [], \"remove\": []} there "
                          "(a new project needs an admin) or remove the file"])


def access(**projects):
    return {"note": "x", "projects": {pid: {"repos": 1, "editors": [
        {"login": login, "why": "added", "repos_with_commits": 0} for login in logins], "removed": []}
        for pid, logins in projects.items()}}


class CodeownersTest(unittest.TestCase):
    """.github/CODEOWNERS is rendered from data/graph/edit-access.json (Kyle, 2026-10-19) and checked in step."""

    def test_the_committed_file_is_the_generator_output(self):
        self.assertEqual((ROOT / ".github" / "CODEOWNERS").read_text(encoding="utf-8"), build_codeowners.expected(ROOT))

    def test_editors_get_their_project_files_and_admins_keep_the_rest(self):
        text = build_codeowners.render(access(**{
            "learning-to-swim": ["kyle-nelson-berkeley", "Ada-L"],
            "acoustics": [],
            "x": ["Desert-Mango-Robotics"]}))
        lines = [l.split() for l in text.splitlines() if l and not l.startswith("#")]
        rule = {l[0]: l[1:] for l in lines}
        admins = ["@desert-mango-robotics", "@NBauschmann"]
        self.assertEqual(lines[0], ["*"] + admins)
        self.assertEqual(rule["/content/projects/learning-to-swim.md"], admins + ["@kyle-nelson-berkeley", "@Ada-L"])
        self.assertEqual(rule["/data/projects/learning-to-swim.json"], admins + ["@kyle-nelson-berkeley", "@Ada-L"])
        self.assertNotIn("/content/projects/acoustics.md", rule, "no editors: the admins' * line")
        self.assertNotIn("/content/projects/x.md", rule, "an admin as editor adds nothing (case-insensitive)")
        # the admin-only paths come LAST (later lines win), CODEOWNERS and the index among them
        tail = [l[0] for l in lines[-len(build_codeowners.ADMIN_ONLY):]]
        self.assertEqual(tuple(tail), build_codeowners.ADMIN_ONLY)
        for path in ("/.github/", "/data/projects.json", "/js/", "/tools/"):
            self.assertEqual(rule[path], admins, path)
        self.assertNotIn("@kyle-nelson-berkeley", " ".join(" ".join(rule[p]) for p in build_codeowners.ADMIN_ONLY))

    def test_removed_people_never_appear(self):
        doc = access(p=["ada"])
        doc["projects"]["p"]["removed"] = [{"login": "bob", "had_commits": True}]
        self.assertNotIn("@bob", build_codeowners.render(doc))

    def test_projects_come_in_id_order(self):
        text = build_codeowners.render(access(zeta=["ada"], alpha=["ada"]))
        self.assertLess(text.index("/content/projects/alpha.md"), text.index("/content/projects/zeta.md"))

    def test_the_header_says_the_rule_and_that_the_ruleset_is_on(self):
        text = build_codeowners.render(access())
        head = text.split("\n\n")[0]
        self.assertIn("GENERATED by tools/build_codeowners.py from data/graph/edit-access.json", head)
        self.assertIn("main-review", head)
        self.assertIn("ON since 2026-10-15", head)
        self.assertIn("commits", head)
        self.assertIn("remove", head)
        self.assertIn("daily", head)
        self.assertNotIn("not yet", head)

    def test_a_wrong_shape_never_raises(self):
        for doc in (None, [], {"projects": []}, {"projects": {"p": "x"}}, {"projects": {"p": {"editors": [3, {"login": 7}]}}}):
            text = build_codeowners.render(doc)
            self.assertTrue(text.startswith("# GENERATED"))

    def run_cli(self, root, *argv):
        import io
        from contextlib import redirect_stdout
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = build_codeowners.main(["--root", str(root), *argv])
        return code, buf.getvalue()

    def test_cli_writes_checks_and_refuses_without_edit_access(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".github").mkdir()
            (root / "data" / "graph").mkdir(parents=True)
            code, log = self.run_cli(root)
            self.assertEqual(code, 1, "no edit-access.json: never write an admins-only file by accident")
            self.assertIn("data/graph/edit-access.json", log)
            self.assertFalse((root / ".github" / "CODEOWNERS").exists())
            (root / "data" / "graph" / "edit-access.json").write_text(json.dumps(access(p=["ada"])), encoding="utf-8")
            self.assertEqual(self.run_cli(root, "--check")[0], 1)
            self.assertEqual(self.run_cli(root)[0], 0)
            self.assertIn("@ada", (root / ".github" / "CODEOWNERS").read_text(encoding="utf-8"))
            self.assertEqual(self.run_cli(root, "--check")[0], 0)
            (root / ".github" / "CODEOWNERS").write_text("drift\n", encoding="utf-8")
            code, log = self.run_cli(root, "--check")
            self.assertEqual(code, 1)
            self.assertEqual((root / ".github" / "CODEOWNERS").read_text(encoding="utf-8"), "drift\n", "--check writes nothing")

    def test_check_py_fails_when_the_file_drifts(self):
        import shutil
        import subprocess
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            dst = Path(tmp) / "repo"
            shutil.copytree(ROOT, dst, ignore=shutil.ignore_patterns(".git", "graphify-out", "node_modules"))
            p = dst / ".github" / "CODEOWNERS"
            p.write_text(p.read_text(encoding="utf-8") + "/content/setup/ @kyle-nelson-berkeley\n", encoding="utf-8")
            run = subprocess.run([sys.executable, str(dst / "tools" / "check.py")], capture_output=True, text=True)
            self.assertEqual(run.returncode, 1, run.stdout[-600:])
            self.assertIn(".github/CODEOWNERS: not in step with data/graph/edit-access.json", run.stdout)

    def copy_tree(self, tmp):
        import shutil
        dst = Path(tmp) / "repo"
        shutil.copytree(ROOT, dst, ignore=shutil.ignore_patterns(".git", "graphify-out", "node_modules"))
        return dst

    def gate(self, dst):
        import subprocess
        run = subprocess.run([sys.executable, str(dst / "tools" / "check.py")], capture_output=True, text=True)
        return run, [l for l in run.stdout.splitlines() if l.startswith("  ✗")]

    def test_check_py_is_red_without_edit_access_json(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            dst = self.copy_tree(tmp)
            (dst / "data" / "graph" / "edit-access.json").unlink()
            run, red = self.gate(dst)
            self.assertEqual(run.returncode, 1, run.stdout[-600:])
            self.assertIn("  ✗ data/graph/edit-access.json: missing — run python3 tools/derive.py "
                          "(it builds it and .github/CODEOWNERS)", red)

    def test_check_py_is_red_without_codeowners(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            dst = self.copy_tree(tmp)
            (dst / ".github" / "CODEOWNERS").unlink()
            run, red = self.gate(dst)
            self.assertEqual(run.returncode, 1, run.stdout[-600:])
            self.assertIn("  ✗ .github/CODEOWNERS: missing — run python3 tools/build_codeowners.py", red)

    def test_removing_a_project_never_turns_access_data_red(self):
        """Design D4: a pull request that removes a project cannot rebuild contributors.json (network) nor
        commit it (check.yml's guard). Other checks may still be red until derive runs (the wiki graph
        names the page); the access data never is: its leftovers are notes."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            dst = self.copy_tree(tmp)
            pid = "holiday-fun"
            p = dst / "data" / "projects.json"
            doc = json.loads(p.read_text(encoding="utf-8"))
            doc["projects"] = [e for e in doc["projects"] if e["id"] != pid]
            p.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
            (dst / "data" / "projects" / f"{pid}.json").unlink()
            (dst / "content" / "projects" / f"{pid}.md").unlink()
            run, red = self.gate(dst)
            self.assertFalse([l for l in red if "contributors" in l or "edit-access" in l or "CODEOWNERS" in l],
                             red)
            # the gate reached sections 10 and 10b (their notes are printed), so the silence above is real
            self.assertIn(f"note: data/graph/contributors.json: '{pid}' is not a project id of data/projects.json",
                          run.stdout)
            self.assertIn(f"note: data/graph/edit-access.json: '{pid}' is not in data/projects.json", run.stdout)

    def test_check_py_notes_an_extra_project_in_edit_access_and_stays_quiet_on_it(self):
        """A project removal merged by a pull request must not turn main red before derive runs (design D4)."""
        import shutil
        import subprocess
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            dst = Path(tmp) / "repo"
            shutil.copytree(ROOT, dst, ignore=shutil.ignore_patterns(".git", "graphify-out", "node_modules"))
            p = dst / "data" / "graph" / "edit-access.json"
            doc = json.loads(p.read_text(encoding="utf-8"))
            doc["projects"]["gone-project"] = {"repos": 0, "editors": [], "removed": []}
            import build_edit_access
            p.write_text(build_edit_access.dump(doc), encoding="utf-8")
            run = subprocess.run([sys.executable, str(dst / "tools" / "check.py")], capture_output=True, text=True)
            red = [l for l in run.stdout.splitlines() if l.startswith("  ✗")]
            self.assertFalse([l for l in red if "edit-access" in l or "CODEOWNERS" in l], red)
            self.assertIn("note: data/graph/edit-access.json: 'gone-project' is not in data/projects.json", run.stdout)


if __name__ == "__main__":
    unittest.main()
