#!/usr/bin/env python3
# Author: Kyle Nelson
# Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
# Last substantive modification: 23 October 2026
# Affiliation: TUHH HippoCampus Robotics
# Purpose: Test that the editor's facts rules (js/cms-core.js FACTS_RULES) match the gate's project facts spec.
"""The editor checks a project's facts file (data/projects/<id>.json) before it
sends it (js/cms-core.js validFacts, plan D17). Its rules, FACTS_RULES, are a
copy of what the gate holds: PROJECT_FACTS_SPEC in tools/check.py and the
status list section 4 accepts. This test reads both files and fails when the
two differ in any key, so the copy can never drift.

    python3 tools/tests/test_facts_rules.py
"""
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import check  # noqa: E402

CMS_CORE = ROOT / "js" / "cms-core.js"
CHECK_PY = ROOT / "tools" / "check.py"
START = "/* facts-rules: strict JSON, read by tools/tests/test_facts_rules.py */"
END = "/* end facts-rules */"
TYPE_NAMES = {str: "str", int: "int", bool: "bool", list: "list", dict: "dict"}


def js_rules():
    text = CMS_CORE.read_text(encoding="utf-8")
    a = text.index(START) + len(START)
    b = text.index(END, a)
    return json.loads(text[a:b])


def py_rules():
    spec = check.PROJECT_FACTS_SPEC
    src = CHECK_PY.read_text(encoding="utf-8")
    m = re.search(r'if pr\["status"\] not in \(([^)]*)\):', src)
    statuses = re.findall(r'"([^"]+)"', m.group(1)) if m else None
    return {
        "keys": list(spec.get("keys", ())),
        "types": {k: TYPE_NAMES[v] for k, v in spec.get("types", {}).items()},
        "lists": list(spec.get("lists", ())),
        "each": {k: {"keys": list(v.get("keys", ()))} for k, v in spec.get("each", {}).items()},
        "statuses": statuses,
    }


class FactsRulesMirror(unittest.TestCase):
    def test_the_status_list_is_found_in_check_py(self):
        self.assertTrue(py_rules()["statuses"], "section 4's status tuple was not found in tools/check.py")

    def test_every_part_matches_key_for_key(self):
        js, py = js_rules(), py_rules()
        self.assertEqual(sorted(js), sorted(py), "the same parts")
        for part in py:
            self.assertEqual(js[part], py[part], f"FACTS_RULES.{part} differs from tools/check.py")

    def test_the_spec_has_no_part_the_mirror_leaves_out(self):
        known = {"keys", "types", "lists", "each"}
        self.assertEqual(set(check.PROJECT_FACTS_SPEC) - known, set(),
                         "PROJECT_FACTS_SPEC gained a part: mirror it in FACTS_RULES and here")
        for k, v in check.PROJECT_FACTS_SPEC.get("each", {}).items():
            self.assertEqual(set(v) - {"keys"}, set(), f"each.{k} gained a part")


if __name__ == "__main__":
    unittest.main()
