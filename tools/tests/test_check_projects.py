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


if __name__ == "__main__":
    unittest.main()
