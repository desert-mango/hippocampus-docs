#!/usr/bin/env python3
# Author: Kyle Nelson
# Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
# Last substantive modification: 14 October 2026
# Affiliation: TUHH HippoCampus Robotics
# Purpose: Test the project registry rules in the site quality gate: owners and their shape.
"""Unit tests for the projects half of the check gate (tools/check.py).

Run from the repo root with plain python3 (no pytest, no network):

    python3 tools/tests/test_check_projects.py

Kyle, 2026-10-14: every project in data/projects.json names its `owners`, the
GitHub logins who may approve its edits (the editor shows Approve to them, and
.github/CODEOWNERS gives them the project's files). The checks are pure
functions over loaded dicts; a red is proven with an in-memory fixture.
"""
import copy
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import check  # noqa: E402
import projects_registry  # noqa: E402


def spec_errors(doc):
    """The READER_REQUIRED_KEYS findings for one projects document (check.py collects into check.errors)."""
    before = len(check.errors)
    check.check_reader_registry("data/projects.json", doc, check.READER_REQUIRED_KEYS["data/projects.json"])
    out = check.errors[before:]
    del check.errors[before:]
    return out


class OwnersTest(unittest.TestCase):
    def setUp(self):
        self.real = json.loads((ROOT / "data" / "projects.json").read_text(encoding="utf-8"))

    def test_the_real_registry_is_clean_and_names_the_four_owned_projects(self):
        self.assertEqual(check.check_project_owners(self.real), [])
        self.assertEqual(spec_errors(self.real), [])
        owned = sorted(p["id"] for p in self.real["projects"] if "kyle-nelson-berkeley" in p["owners"])
        self.assertEqual(owned, ["learning-to-swim", "learning-to-swim-run-guide", "scalar-field", "underwater-localization"])

    def test_owners_is_required_and_must_be_a_list_of_strings(self):
        doc = copy.deepcopy(self.real)
        del doc["projects"][0]["owners"]
        self.assertTrue(any("owners" in e for e in spec_errors(doc)), spec_errors(doc))
        doc = copy.deepcopy(self.real)
        doc["projects"][0]["owners"] = "kyle-nelson-berkeley"          # a string iterates as characters
        self.assertTrue(any("owners" in e for e in spec_errors(doc)))
        doc = copy.deepcopy(self.real)
        doc["projects"][0]["owners"] = ["kyle-nelson-berkeley", 7]
        self.assertTrue(any("owners" in e for e in spec_errors(doc)))

    def test_each_owner_is_a_login_and_none_twice(self):
        doc = copy.deepcopy(self.real)
        doc["projects"][0]["owners"] = ["kyle-nelson-berkeley", "Kyle-Nelson-Berkeley", "not a login", "-x", "a--b", "@x"]
        errs = check.check_project_owners(doc)
        self.assertEqual(len(errs), 5, errs)
        self.assertTrue(any("twice" in e for e in errs))
        self.assertTrue(all(doc["projects"][0]["id"] in e for e in errs))

    def test_a_wrong_shape_never_raises_here(self):
        self.assertEqual(check.check_project_owners({"projects": [{"id": "x", "owners": "str"}, "y", {"id": "z"}]}), [])
        self.assertEqual(check.check_project_owners([]), [])


def real_facts():
    return {f"data/projects/{p.name}": json.loads(p.read_text(encoding="utf-8"))
            for p in sorted((ROOT / "data" / "projects").glob("*.json"))}


class SplitRegistryTest(unittest.TestCase):
    """Each project's facts in its own file (Kyle, 2026-10-14); the index keeps id, order and owners."""

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
            self.assertEqual(sorted(e), ["id", "owners"], e["id"])

    def test_the_merge_is_the_document_every_reader_knew(self):
        merged = projects_registry.load(ROOT)
        self.assertEqual([p["id"] for p in merged["projects"]], [p["id"] for p in self.index["projects"]], "the index's order")
        for p in merged["projects"]:
            self.assertEqual(list(p)[:2], ["id", "owners"])
            self.assertEqual(p["file"], f"content/projects/{p['id']}.md")
            self.assertIn("repos", p)
        self.assertEqual(merged["intro"], self.index["intro"])

    def test_facts_in_the_index_a_missing_or_stray_file_and_owners_in_a_facts_file_are_named(self):
        index = copy.deepcopy(self.index)
        facts = copy.deepcopy(self.facts)
        index["projects"][0]["name"] = "sneaked back"                      # facts in the admin file
        del facts["data/projects/scalar-field.json"]                       # a listed project with no facts
        facts["data/projects/stray.json"] = {"name": "x"}                  # a facts file nobody listed
        facts["data/projects/learning-to-swim.json"]["owners"] = ["someone"]   # an owner widening ownership
        facts["data/projects/acoustics.json"]["file"] = "content/about.md"
        errs = check.check_project_files(index, facts)
        joined = "\n".join(errs)
        self.assertIn("carries ['name']", joined)
        self.assertIn("'scalar-field' has no facts file", joined)
        self.assertIn("data/projects/stray.json: not in data/projects.json", joined)
        self.assertIn("data/projects/learning-to-swim.json: 'owners' belongs in data/projects.json", joined)
        self.assertIn("data/projects/acoustics.json: file must be content/projects/acoustics.md", joined)
        self.assertEqual(len(errs), 5, errs)

    def test_ids_must_be_page_addresses_and_unique(self):
        index = copy.deepcopy(self.index)
        index["projects"].append({"id": "Bad Id", "owners": []})
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
            (d / "projects.json").write_text(json.dumps({"intro": "x", "projects": [{"id": "fx", "owners": []}]}), encoding="utf-8")
            (d / "projects" / "fx.json").write_text(json.dumps({"name": "Fixture", "repos": [{"name": "fixture_repo"}]}), encoding="utf-8")
            merged = projects_registry.load(ROOT, d / "projects.json")
            self.assertEqual(merged["projects"], [{"id": "fx", "owners": [], "name": "Fixture", "repos": [{"name": "fixture_repo"}]}])
            _, projects, _, _ = build_contributors.load_inputs(str(d))
            self.assertEqual(projects["projects"][0]["repos"], [{"name": "fixture_repo"}], "the fixture's own facts")

    def test_the_loader_is_stdlib_only(self):
        src = (ROOT / "tools" / "projects_registry.py").read_text(encoding="utf-8")
        mods = {line.split()[1].split(".")[0] for line in src.splitlines() if line.startswith(("import ", "from "))}
        self.assertEqual(mods, {"copy", "json", "pathlib"})

    def test_a_shape_error_never_raises(self):
        self.assertEqual(check.check_project_files([], {}), [])
        self.assertEqual(check.check_project_files({"projects": ["x", {"id": 3}]}, {"data/projects/a.json": "str"})[:1],
                         ["data/projects/a.json: not in data/projects.json's list — add {\"id\": \"a\", \"owners\": []} there "
                          "(a new project needs an admin) or remove the file"])


if __name__ == "__main__":
    unittest.main()
