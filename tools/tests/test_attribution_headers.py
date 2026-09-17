#!/usr/bin/env python3
# Author: Kyle Nelson
# Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
# Last substantive modification: 17 September 2026
# Affiliation: TUHH HippoCampus Robotics
# Purpose: Test attribution inventory reconciliation and exact header validation failures.
"""Focused tests for the deterministic attribution-header checker."""

import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "check_attribution_headers.py"
SPEC = importlib.util.spec_from_file_location("check_attribution_headers", MODULE_PATH)
CHECKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKER)


HEADER = """# Author: Kyle Nelson
# Project: https://hippocampus-docs.vercel.app/#/projects/example
# Last substantive modification: 17 September 2026
# Affiliation: TUHH HippoCampus Robotics
# Purpose: Exercise a tiny first-party example.
"""
EXAMPLE_PROJECT_URL = "https://hippocampus-docs.vercel.app/#/projects/example"


class AttributionHeaderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)
        (self.root / "main.py").write_text(HEADER + "print('ok')\n", encoding="utf-8")
        (self.root / "vendor.js").write_text("// third-party fixture\n", encoding="utf-8")
        self.manifest = {
            "schema_version": 1,
            "candidate_extensions": [".js", ".py"],
            "canonical_project_url": "https://hippocampus-docs.vercel.app/#/projects/example",
            "files": {
                "main.py": {
                    "classification": "included",
                    "reason": "First-party test fixture.",
                    "header": {
                        "author": "Kyle Nelson",
                        "project": "https://hippocampus-docs.vercel.app/#/projects/example",
                        "last_substantive_modification": "17 September 2026",
                        "affiliation": "TUHH HippoCampus Robotics",
                        "purpose": "Exercise a tiny first-party example."
                    },
                    "evidence": {"commit": "0123456789abcdef", "baseline_sha256": "0" * 64}
                },
                "vendor.js": {
                    "classification": "excluded",
                    "reason": "Third-party test fixture.",
                    "evidence": {"baseline_sha256": "1" * 64}
                }
            }
        }
        self.manifest_path = self.root / "manifest.json"
        self._write_manifest()
        subprocess.run(["git", "add", "main.py", "vendor.js"], cwd=self.root, check=True)

    def tearDown(self):
        self.temp.cleanup()

    def _write_manifest(self):
        self.manifest_path.write_text(json.dumps(self.manifest), encoding="utf-8")

    def _errors(self):
        return CHECKER.check_repository(
            self.root, self.manifest_path, expected_project_url=EXAMPLE_PROJECT_URL
        )

    def test_valid_inventory_and_header_pass(self):
        self.assertEqual([], self._errors())

    def test_missing_header_fails(self):
        (self.root / "main.py").write_text("print('ok')\n", encoding="utf-8")
        self.assertTrue(any("missing exact header" in e for e in self._errors()))

    def test_duplicate_header_fails(self):
        (self.root / "main.py").write_text(HEADER + HEADER + "print('ok')\n", encoding="utf-8")
        self.assertTrue(any("exactly one header" in e for e in self._errors()))

    def test_duplicate_with_altered_purpose_fails(self):
        altered = HEADER.replace(
            "Exercise a tiny first-party example.", "Describe a conflicting second purpose."
        )
        (self.root / "main.py").write_text(HEADER + altered + "print('ok')\n", encoding="utf-8")
        self.assertTrue(any("leading Purpose field" in e for e in self._errors()))

    def test_malformed_header_fails(self):
        malformed = HEADER.replace(
            "# Author: Kyle Nelson\n# Project:",
            "# Project:",
        )
        (self.root / "main.py").write_text(malformed + "print('ok')\n", encoding="utf-8")
        self.assertTrue(any("missing exact header" in e for e in self._errors()))

    def test_stale_project_route_fails(self):
        stale = HEADER.replace("#/projects/example", "#/projects/old-page")
        (self.root / "main.py").write_text(stale + "print('ok')\n", encoding="utf-8")
        errors = self._errors()
        self.assertTrue(any("missing exact header" in e for e in errors))
        self.assertTrue(any("unapproved Project field" in e for e in errors))

    def test_manifest_project_must_match_canonical_route(self):
        stale = "https://hippocampus-docs.vercel.app/#/projects/old-page"
        self.manifest["files"]["main.py"]["header"]["project"] = stale
        self._write_manifest()
        (self.root / "main.py").write_text(
            HEADER.replace("https://hippocampus-docs.vercel.app/#/projects/example", stale)
            + "print('ok')\n",
            encoding="utf-8",
        )
        self.assertTrue(any("does not match canonical_project_url" in e for e in self._errors()))

    def test_manifest_canonical_route_is_independently_pinned(self):
        stale = "https://hippocampus-docs.vercel.app/#/projects/old-page"
        self.manifest["canonical_project_url"] = stale
        self.manifest["files"]["main.py"]["header"]["project"] = stale
        self._write_manifest()
        (self.root / "main.py").write_text(
            HEADER.replace(EXAMPLE_PROJECT_URL, stale) + "print('ok')\n", encoding="utf-8"
        )
        self.assertTrue(any("approved route" in e for e in self._errors()))

    def test_author_and_affiliation_are_exact(self):
        row = self.manifest["files"]["main.py"]["header"]
        row["author"] = "Someone Else"
        row["affiliation"] = "Another Lab"
        self._write_manifest()
        errors = self._errors()
        self.assertTrue(any("author must be exactly" in e for e in errors))
        self.assertTrue(any("affiliation must be exactly" in e for e in errors))

    def test_unclassified_new_candidate_fails(self):
        (self.root / "new.js").write_text("console.log('new');\n", encoding="utf-8")
        subprocess.run(["git", "add", "new.js"], cwd=self.root, check=True)
        self.assertTrue(any("unclassified candidate: new.js" in e for e in self._errors()))

    def test_header_must_follow_shebang(self):
        (self.root / "main.py").write_text(HEADER + "#!/usr/bin/env python3\n", encoding="utf-8")
        self.assertTrue(any("shebang must remain the first line" in e for e in self._errors()))

    def test_invalid_reviewed_date_fails(self):
        self.manifest["files"]["main.py"]["header"]["last_substantive_modification"] = "2026-09-17"
        self._write_manifest()
        self.assertTrue(any("reviewed date" in e for e in self._errors()))


if __name__ == "__main__":
    unittest.main()
