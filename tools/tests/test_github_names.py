#!/usr/bin/env python3
# Author: Kyle Nelson
# Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
# Last substantive modification: 29 September 2026
# Affiliation: TUHH HippoCampus Robotics
# Purpose: Test the one GitHub-login-to-roster-name matcher and its hand-kept map.
"""Unit tests for tools/github_names.py (plan D-L).

Run from the repo root with plain python3 (no pytest, no network):

    python3 tools/tests/test_github_names.py

The matcher is pure, so every test is an in-memory call. The last class runs
the matcher over the REAL roster (data/people.json) and the REAL map
(data/github-links.json) with the display names GitHub publishes today, and
pins the result the plan expects.
"""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import github_names as gn  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent.parent

ROSTER = ["Kyle Nelson", "Nathalie Bauschmann", "Vincent Lenz", "Finn Breuer",
          "Thies Lennart Alff", "Daniel-André Dücker", "Richard Wittmüß",
          "Eugen Solowjow", "Tim Hansen", "René Hochdahl", "Lukas Büsch",
          "René Geist", "Tobias Johannink"]


def match(names, roster=ROSTER, links=None):
    return gn.match(names, roster, links)


class TestNormalize(unittest.TestCase):
    def test_two_forms_for_german_letters(self):
        self.assertEqual(gn.normalize("Wittmüß"), ("wittmuess", "wittmuss"))
        self.assertEqual(gn.normalize("Büsch"), ("buesch", "busch"))

    def test_sharp_s_needs_casefold_not_lower(self):
        # NFKD leaves ß alone; only casefold() turns it into "ss"
        self.assertIn("strasse", gn.normalize("Straße"))

    def test_accents_drop_and_separators_become_spaces(self):
        self.assertEqual(gn.normalize("Daniel-André Dücker"),
                         ("daniel andre duecker", "daniel andre ducker"))
        self.assertEqual(gn.normalize("  thies.lennart_alff "), ("thies lennart alff",))

    def test_whitespace_collapses(self):
        self.assertEqual(gn.normalize("Cleo \t  Zhang"), ("cleo zhang",))

    def test_empty_and_non_strings(self):
        self.assertEqual(gn.normalize(""), ())
        self.assertEqual(gn.normalize("  - "), ())
        self.assertEqual(gn.normalize(None), ())
        self.assertEqual(gn.normalize(42), ())


class TestAutoMatch(unittest.TestCase):
    def test_both_normal_forms_match(self):
        linked, warnings = match({"rw": "Richard Wittmuss", "rw2": "Richard Wittmuess",
                                  "lb": "Lukas Busch"},
                                 roster=["Richard Wittmüß", "Lukas Büsch"])
        # two logins claim one roster name: ambiguity, see below — so test apart
        self.assertIsNone(linked["rw"])
        linked, warnings = match({"rw": "Richard Wittmuss", "lb": "Lukas Busch"},
                                 roster=["Richard Wittmüß", "Lukas Büsch"])
        self.assertEqual(linked, {"rw": "Richard Wittmüß", "lb": "Lukas Büsch"})
        self.assertEqual(warnings, [])
        linked, _ = match({"rw": "richard wittmuess", "lb": "LUKAS BUESCH"},
                          roster=["Richard Wittmüß", "Lukas Büsch"])
        self.assertEqual(linked, {"rw": "Richard Wittmüß", "lb": "Lukas Büsch"})

    def test_first_and_last_token_rule(self):
        linked, _ = match({"DanielDuecker": "Daniel Duecker"})
        self.assertEqual(linked["DanielDuecker"], "Daniel-André Dücker")
        linked, _ = match({"x": "Thies Alff"})
        self.assertEqual(linked["x"], "Thies Lennart Alff")

    def test_first_token_alone_is_not_enough(self):
        linked, _ = match({"x": "Rene Schmidt"})
        self.assertIsNone(linked["x"])

    def test_one_token_names_never_auto_match(self):
        linked, _ = match({"timzarhansen": "Tim"}, roster=["Tim"])
        self.assertIsNone(linked["timzarhansen"])
        linked, _ = match({"x": "Hansen"}, roster=["Tim Hansen"])
        self.assertIsNone(linked["x"])

    def test_login_as_name_does_not_match(self):
        linked, _ = match({"RHochdahl": "RHochdahl", "EugenSol": "EugenSol",
                           "JohTobi": "JohTobi"})
        self.assertEqual(linked, {"RHochdahl": None, "EugenSol": None, "JohTobi": None})

    def test_near_miss_does_not_match(self):
        linked, _ = match({"dana": "Dana Nelsen"}, roster=["Dana Nelson"])
        self.assertIsNone(linked["dana"])

    def test_missing_display_name_is_unlinked(self):
        linked, warnings = match({"bob": None, "eve": ""})
        self.assertEqual(linked, {"bob": None, "eve": None})
        self.assertEqual(warnings, [])


class TestAmbiguity(unittest.TestCase):
    def test_two_logins_one_roster_name_links_neither_and_warns(self):
        linked, warnings = match({"a": "Vincent Lenz", "b": "vincent lenz",
                                  "c": "Finn Breuer"})
        self.assertIsNone(linked["a"])
        self.assertIsNone(linked["b"])
        self.assertEqual(linked["c"], "Finn Breuer")      # the build continues
        self.assertEqual(len(warnings), 1)
        self.assertIn("'a'", warnings[0])
        self.assertIn("'b'", warnings[0])
        self.assertIn("Vincent Lenz", warnings[0])

    def test_one_login_two_roster_names_links_neither_and_warns(self):
        linked, warnings = match({"x": "Anna Maria Berg"},
                                 roster=["Anna Berg", "Anna Maria Berg Two"])
        # "Anna Berg": first + last equal; "Anna Maria Berg Two": last differs
        self.assertEqual(linked["x"], "Anna Berg")
        linked, warnings = match({"x": "Anna Berg"},
                                 roster=["Anna Berg", "Anna Maria Berg"])
        self.assertIsNone(linked["x"])
        self.assertEqual(len(warnings), 1)
        self.assertIn("'x'", warnings[0])
        self.assertIn("Anna Berg", warnings[0])
        self.assertIn("Anna Maria Berg", warnings[0])

    def test_ambiguity_is_settled_by_one_map_line(self):
        links = {"links": {"a": "Vincent Lenz"}, "exclude": []}
        linked, warnings = match({"a": "Vincent Lenz", "b": "vincent lenz"},
                                 links=links)
        self.assertEqual(linked["a"], "Vincent Lenz")
        self.assertIsNone(linked["b"])


class TestMap(unittest.TestCase):
    def test_map_links_what_the_rule_cannot(self):
        links = {"links": {"timzarhansen": "Tim Hansen", "RHochdahl": "René Hochdahl"},
                 "exclude": []}
        linked, warnings = match({"timzarhansen": "Tim", "RHochdahl": None},
                                 links=links)
        self.assertEqual(linked, {"timzarhansen": "Tim Hansen",
                                  "RHochdahl": "René Hochdahl"})
        self.assertEqual(warnings, [])

    def test_map_wins_over_the_rule(self):
        links = {"links": {"DanielDuecker": "Tim Hansen"}, "exclude": []}
        linked, _ = match({"DanielDuecker": "Daniel Duecker"}, links=links)
        self.assertEqual(linked["DanielDuecker"], "Tim Hansen")

    def test_null_override_never_links(self):
        links = {"links": {"DanielDuecker": None}, "exclude": []}
        linked, warnings = match({"DanielDuecker": "Daniel Duecker"}, links=links)
        self.assertIsNone(linked["DanielDuecker"])
        self.assertEqual(warnings, [])

    def test_a_wrong_match_is_fixed_by_one_line(self):
        names = {"rhein": "Rene Geist"}           # a stranger with a roster name
        before, _ = match(names)
        self.assertEqual(before["rhein"], "René Geist")
        after, _ = match(names, links={"links": {"rhein": None}, "exclude": []})
        self.assertIsNone(after["rhein"])

    def test_map_value_not_on_the_roster_is_unlinked_with_a_warning(self):
        links = {"links": {"EugenSol": "Eugen Solowjow-Renamed"}, "exclude": []}
        linked, warnings = match({"EugenSol": "EugenSol"}, links=links)
        self.assertIsNone(linked["EugenSol"])
        self.assertEqual(len(warnings), 1)
        self.assertIn("EugenSol", warnings[0])
        self.assertIn("Eugen Solowjow-Renamed", warnings[0])

    def test_exclude_drops_the_login_entirely(self):
        links = {"links": {}, "exclude": ["hippocampusmum"]}
        linked, warnings = match({"hippocampusmum": "Vincent Lenz", "x": "Finn Breuer"},
                                 links=links)
        self.assertNotIn("hippocampusmum", linked)
        self.assertEqual(linked["x"], "Finn Breuer")
        self.assertEqual(gn.excluded_logins(links), frozenset({"hippocampusmum"}))

    def test_a_mapped_roster_name_is_not_auto_matched_again(self):
        links = {"links": {"a": "Vincent Lenz"}, "exclude": []}
        linked, warnings = match({"a": "someone", "b": "Vincent Lenz"}, links=links)
        self.assertEqual(linked, {"a": "Vincent Lenz", "b": None})
        self.assertEqual(len(warnings), 1)
        self.assertIn("'b'", warnings[0])

    def test_two_map_entries_for_one_roster_name_link_neither_and_warn(self):
        # D-L's ambiguity rule holds for the map too: two logins mapped to the
        # same roster person link NEITHER, and a warning names the pair
        links = {"links": {"tim-a": "Tim Hansen", "tim-b": "Tim Hansen"}, "exclude": []}
        linked, warnings = match({"tim-a": None, "tim-b": None,
                                  "timzarhansen": "Tim Hansen"}, links=links)
        self.assertEqual(linked, {"tim-a": None, "tim-b": None, "timzarhansen": None})
        pair = [w for w in warnings if "'tim-a'" in w and "'tim-b'" in w]
        self.assertEqual(len(pair), 1, warnings)
        self.assertIn("Tim Hansen", pair[0])

    def test_two_map_entries_one_login_absent_still_links_neither(self):
        # The pair is read from the WHOLE map, not from this build's logins: a
        # former contributor ('b') missing today must not let 'a' link alone,
        # possibly to the wrong person
        links = {"links": {"a": "Tim Hansen", "b": "Tim Hansen"}, "exclude": []}
        linked, warnings = match({"a": None}, links=links)
        self.assertEqual(linked, {"a": None})
        pair = [w for w in warnings if "'a'" in w and "'b'" in w]
        self.assertEqual(len(pair), 1, warnings)
        self.assertIn("Tim Hansen", pair[0])

    def test_two_map_entries_both_absent_warn_nothing(self):
        links = {"links": {"a": "Tim Hansen", "b": "Tim Hansen"}, "exclude": []}
        linked, warnings = match({"c": None}, links=links)
        self.assertEqual(linked, {"c": None})
        self.assertEqual(warnings, [])

    def test_no_map_at_all_is_auto_only(self):
        linked, _ = gn.match({"x": "Finn Breuer"}, ROSTER, None)
        self.assertEqual(linked["x"], "Finn Breuer")


class TestHelpers(unittest.TestCase):
    def test_roster_names_from_people(self):
        people = {"groups": [{"people": [{"name": "A B"}, {"name": " "}]},
                             {"people": [{"name": "C D"}, {"title": "x"}]}]}
        self.assertEqual(gn.roster_names(people), ["A B", "C D"])

    def test_load_links_missing_file_is_empty(self):
        self.assertEqual(gn.load_links(ROOT / "no-such-file.json"),
                         {"links": {}, "exclude": []})


    def test_load_links_refuses_the_wrong_types(self):
        # a null or list 'links' would silently lose every override: raise
        import tempfile
        bad = ([], None, {"links": None, "exclude": []}, {"links": [], "exclude": []},
               {"links": {}, "exclude": "x"}, {"links": {}, "exclude": [3]},
               {"links": {"a": 3}, "exclude": []}, {"links": {"a": ["X Y"]}, "exclude": []})
        for doc in bad:
            with self.subTest(doc=doc), tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / "github-links.json"
                path.write_text(json.dumps(doc), encoding="utf-8")
                with self.assertRaises(ValueError):
                    gn.load_links(path)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "github-links.json"
            path.write_text(json.dumps({"note": "n", "links": {"a": None, "b": "X Y"},
                                        "exclude": ["c"]}), encoding="utf-8")
            self.assertEqual(gn.load_links(path)["links"], {"a": None, "b": "X Y"})


class TestRealRoster(unittest.TestCase):
    """The plan's expected result over today's data (D-L)."""

    NAMES = {  # display names as GitHub publishes them (see the U0 fixtures)
        "NBauschmann": "Nathalie Bauschmann",
        "lennartalff": "Thies Lennart Alff",
        "VincentTUHH": "Vincent Lenz",
        "DanielDuecker": "Daniel Duecker",
        "FinnBreu": "Finn Breuer",
        "kyle-nelson-berkeley": "Kyle Nelson",
        "RHochdahl": None,
        "EugenSol": None,
        "JohTobi": None,
        "timzarhansen": "Tim",
        "hippocampusmum": None,
        "mmistakes": "Michael Rose",
        "LorenzMeier": "Lorenz Meier",
    }

    def test_expected_links(self):
        people = json.loads((ROOT / "data" / "people.json").read_text(encoding="utf-8"))
        links = gn.load_links(ROOT / "data" / "github-links.json")
        linked, warnings = gn.match(self.NAMES, gn.roster_names(people), links)
        self.assertEqual(warnings, [])
        self.assertEqual(linked, {
            "NBauschmann": "Nathalie Bauschmann",
            "lennartalff": "Thies Lennart Alff",
            "VincentTUHH": "Vincent Lenz",
            "DanielDuecker": "Daniel-André Dücker",
            "FinnBreu": "Finn Breuer",
            "kyle-nelson-berkeley": "Kyle Nelson",
            "RHochdahl": "René Hochdahl",
            "EugenSol": "Eugen Solowjow",
            "JohTobi": "Tobias Johannink",
            "timzarhansen": "Tim Hansen",
            "mmistakes": None,
            "LorenzMeier": None,
        })

    def test_map_file_shape(self):
        doc = json.loads((ROOT / "data" / "github-links.json").read_text(encoding="utf-8"))
        self.assertEqual(set(doc), {"note", "links", "exclude"})
        self.assertEqual(doc["exclude"], ["hippocampusmum"])
        self.assertFalse(set(doc["exclude"]) & set(doc["links"]))


class TestHygiene(unittest.TestCase):
    def test_stdlib_only(self):
        src = Path(gn.__file__).read_text(encoding="utf-8")
        allowed = {"json", "re", "unicodedata", "collections", "pathlib"}
        for i, line in enumerate(src.splitlines(), 1):
            if line.startswith(("import ", "from ")):
                self.assertIn(line.split()[1].split(".")[0], allowed, f"line {i}: {line!r}")


if __name__ == "__main__":
    unittest.main(verbosity=1)
