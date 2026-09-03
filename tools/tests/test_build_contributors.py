#!/usr/bin/env python3
"""Unit tests for tools/build_contributors.py.

Run from the repo root with plain python3 (no pytest, no gh, no network):

    python3 tools/tests/test_build_contributors.py

Everything here is offline. The end-to-end tests drive the script's --fixture
mode, which reads canned JSON from a temp directory instead of shelling out to
`gh`; the retry/back-off tests drive the gh wrapper with a fake runner, so not
one test can touch the network, data/graph/, or the real GitHub API.
"""
import io
import json
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import build_contributors as bc  # noqa: E402


# --------------------------------------------------------------------------
# fixture helpers
# --------------------------------------------------------------------------
def org_row(name, fork=False):
    return {
        "name": name,
        "url": f"https://github.com/HippoCampusRobotics/{name}",
        "description": "",
        "isFork": fork,
        "isArchived": False,
        "primaryLanguage": {"name": "Python"},
        "pushedAt": "2024-01-02T03:04:05Z",
    }


def repo_row(name, external=False):
    row = {"name": name, "role": "does a thing",
           "url": f"https://github.com/HippoCampusRobotics/{name}"}
    if external:
        row["external"] = True
        row["url"] = f"https://github.com/SomeoneElse/{name}"
    return row


ORG = [org_row("alpha"), org_row("beta"), org_row("gamma"),
       org_row("upstream", fork=True)]

PROJECTS = {
    "projects": [
        {"id": "p-one", "name": "Project One",
         "repos": [repo_row("alpha"), repo_row("beta"),
                   repo_row("ext-repo", external=True)]},
        {"id": "p-two", "name": "Project Two", "repos": [repo_row("gamma")]},
        # a project whose only repo is an upstream fork: it must still get a
        # key, with an empty list, so the UI can tell "no data" from "not built"
        {"id": "p-forks", "name": "Forks Only",
         "repos": [repo_row("upstream")]},
    ]
}

PEOPLE = {
    "groups": [
        {"id": "active", "title": "Team", "people": [
            {"name": "Ada Lovelace", "title": "PI", "photo": None, "link": None},
            {"name": "Eve Stone", "title": "Student", "photo": None, "link": None},
        ]},
        {"id": "alumni", "title": "Alumni", "people": [
            {"name": "Cleo Zhang", "title": "Alum", "photo": None, "link": None},
            {"name": "Dana Nelson", "title": "Alum", "photo": None, "link": None},
        ]},
    ]
}

CONTRIBUTORS = {
    "alpha": [
        {"login": "ada", "contributions": 10, "type": "User"},
        {"login": "bob", "contributions": 5, "type": "User"},
        # dropped: bot by login suffix (its type lies and says "User")
        {"login": "dependabot[bot]", "contributions": 99, "type": "User"},
        # dropped: bot by type (its login looks human)
        {"login": "buildbot", "contributions": 50, "type": "Bot"},
    ],
    "beta": [
        {"login": "ada", "contributions": 3, "type": "User"},
        {"login": "cleo", "contributions": 8, "type": "User"},
        {"login": "eve", "contributions": 8, "type": "User"},
    ],
    "gamma": [
        {"login": "dana", "contributions": 1, "type": "User"},
    ],
    # NOTE: no "upstream" and no "ext-repo" file on purpose. If the builder ever
    # reads a fork or an external row it aborts on the missing file, which is
    # exactly how these tests prove those rows are skipped.
}

USERS = {
    "ada": {"name": "ada lovelace"},      # case variant of the roster name
    "bob": {"name": None},                # no display name -> login fallback
    "cleo": {"name": "Cleo  Zhang"},      # double space vs the roster name
    "eve": {"name": "Eve Stone"},         # exact roster match
    "dana": {"name": "Dana Nelsen"},      # near miss: Nelsen != Nelson
}


def make_fixture(tmp, contributors=None, users=None,
                 projects=None, org=None, people=None):
    """Write a --fixture directory and return its path."""
    root = Path(tmp)
    (root / "contributors").mkdir(parents=True, exist_ok=True)
    (root / "users").mkdir(parents=True, exist_ok=True)
    for repo, rows in (CONTRIBUTORS if contributors is None else contributors).items():
        payload = rows if isinstance(rows, str) else json.dumps(rows)
        (root / "contributors" / f"{repo}.json").write_text(payload, encoding="utf-8")
    for login, blob in (USERS if users is None else users).items():
        payload = blob if isinstance(blob, str) else json.dumps(blob)
        (root / "users" / f"{login}.json").write_text(payload, encoding="utf-8")
    (root / "projects.json").write_text(
        json.dumps(PROJECTS if projects is None else projects), encoding="utf-8")
    (root / "org-repos.json").write_text(
        json.dumps(ORG if org is None else org), encoding="utf-8")
    (root / "people.json").write_text(
        json.dumps(PEOPLE if people is None else people), encoding="utf-8")
    return root


def run_main(fixture, out):
    """Run the CLI end to end; returns (exit_code, stdout+stderr)."""
    buf = io.StringIO()
    code = 0
    with redirect_stdout(buf), redirect_stderr(buf):
        try:
            bc.main(["--fixture", str(fixture), "--out", str(out)])
        except SystemExit as exc:
            code = exc.code if isinstance(exc.code, int) else 1
    return code, buf.getvalue()


class FixtureCase(unittest.TestCase):
    """A temp dir per test; nothing is ever written inside the repo."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="contribtest-"))
        self.out = self.tmp / "out" / "contributors.json"
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def build(self, **kwargs):
        fixture = make_fixture(self.tmp / "fx", **kwargs)
        code, log = run_main(fixture, self.out)
        return code, log


# --------------------------------------------------------------------------
# pure helpers
# --------------------------------------------------------------------------
class TestNameNormalisation(unittest.TestCase):
    def test_trims_case_folds_and_collapses_spaces(self):
        self.assertEqual(bc.norm_name("  Cleo   Zhang "), bc.norm_name("cleo zhang"))
        self.assertEqual(bc.norm_name("Ada\tLovelace"), bc.norm_name("ada lovelace"))

    def test_different_names_stay_different(self):
        self.assertNotEqual(bc.norm_name("Dana Nelsen"), bc.norm_name("Dana Nelson"))

    def test_empty_and_none(self):
        self.assertEqual(bc.norm_name(None), "")
        self.assertEqual(bc.norm_name("   "), "")


class TestRosterIndex(unittest.TestCase):
    def test_covers_every_group(self):
        roster = bc.roster_index(PEOPLE)
        for name in ("Ada Lovelace", "Eve Stone", "Cleo Zhang", "Dana Nelson"):
            self.assertIn(bc.norm_name(name), roster)
        self.assertNotIn(bc.norm_name("Dana Nelsen"), roster)


class TestBotDetection(unittest.TestCase):
    def test_login_suffix(self):
        self.assertTrue(bc.is_bot({"login": "dependabot[bot]", "type": "User"}))

    def test_type_bot(self):
        self.assertTrue(bc.is_bot({"login": "buildbot", "type": "Bot"}))

    def test_plain_user(self):
        self.assertFalse(bc.is_bot({"login": "ada", "type": "User"}))

    def test_missing_type_is_not_a_bot(self):
        self.assertFalse(bc.is_bot({"login": "ada"}))


class TestSelectRepos(unittest.TestCase):
    def test_forks_and_external_rows_are_dropped(self):
        selected = bc.select_repos(PROJECTS, ORG)
        self.assertEqual(selected["p-one"], ["alpha", "beta"])
        self.assertEqual(selected["p-two"], ["gamma"])
        self.assertEqual(selected["p-forks"], [])

    def test_excluded_repos_are_dropped(self):
        selected = bc.select_repos(PROJECTS, ORG, excluded=frozenset({"beta"}))
        self.assertEqual(selected["p-one"], ["alpha"])

    def test_every_project_id_is_present(self):
        self.assertEqual(sorted(bc.select_repos(PROJECTS, ORG)),
                         ["p-forks", "p-one", "p-two"])


class TestTally(unittest.TestCase):
    def test_sums_across_repos_and_drops_bots(self):
        rows = CONTRIBUTORS["alpha"] + CONTRIBUTORS["beta"]
        totals = bc.tally(rows)
        self.assertEqual(totals["ada"], 13)      # 10 in alpha + 3 in beta
        self.assertEqual(totals["bob"], 5)
        self.assertEqual(totals["cleo"], 8)
        self.assertEqual(totals["eve"], 8)
        self.assertNotIn("dependabot[bot]", totals)
        self.assertNotIn("buildbot", totals)

    def test_bad_contribution_count_aborts(self):
        with self.assertRaises(bc.Abort):
            bc.tally([{"login": "ada", "contributions": "many", "type": "User"}])

    def test_missing_login_aborts(self):
        with self.assertRaises(bc.Abort):
            bc.tally([{"contributions": 3, "type": "User"}])


class TestRank(unittest.TestCase):
    def setUp(self):
        self.roster = bc.roster_index(PEOPLE)

    def test_sort_is_by_contributions_then_login(self):
        totals = {"eve": 8, "cleo": 8, "ada": 13, "bob": 5}
        names = {"ada": "ada lovelace", "bob": None,
                 "cleo": "Cleo  Zhang", "eve": "Eve Stone"}
        entry = bc.rank(totals, names, self.roster)
        self.assertEqual([c["login"] for c in entry["contributors"]],
                         ["ada", "cleo", "eve", "bob"])
        self.assertNotIn("truncated", entry)

    def test_projection_has_no_extra_keys(self):
        entry = bc.rank({"ada": 3}, {"ada": "Ada Lovelace"}, self.roster)
        self.assertEqual(set(entry["contributors"][0]),
                         {"login", "name", "contributions", "roster"})
        entry = bc.rank({"zed": 3}, {"zed": "Zed Nobody"}, self.roster)
        self.assertEqual(set(entry["contributors"][0]),
                         {"login", "name", "contributions"})

    def test_cap_and_truncated_count(self):
        totals = {f"user{i:02d}": 100 - i for i in range(15)}
        entry = bc.rank(totals, {}, self.roster)
        self.assertEqual(len(entry["contributors"]), bc.TOP_N)
        self.assertEqual(entry["truncated"], 15 - bc.TOP_N)
        self.assertEqual(entry["contributors"][0]["login"], "user00")
        self.assertEqual(entry["contributors"][-1]["login"],
                         f"user{bc.TOP_N - 1:02d}")

    def test_exactly_top_n_has_no_truncated_key(self):
        totals = {f"user{i:02d}": 100 - i for i in range(bc.TOP_N)}
        self.assertNotIn("truncated", bc.rank(totals, {}, self.roster))

    def test_null_display_name_falls_back_to_login(self):
        entry = bc.rank({"bob": 5}, {"bob": None}, self.roster)
        self.assertEqual(entry["contributors"][0]["name"], "bob")
        self.assertNotIn("roster", entry["contributors"][0])

    def test_blank_display_name_falls_back_to_login(self):
        entry = bc.rank({"bob": 5}, {"bob": "   "}, self.roster)
        self.assertEqual(entry["contributors"][0]["name"], "bob")

    def test_roster_match_variants(self):
        totals = {"ada": 3, "cleo": 2, "eve": 1, "dana": 1}
        names = {"ada": "ada lovelace", "cleo": "Cleo  Zhang",
                 "eve": "Eve Stone", "dana": "Dana Nelsen"}
        flags = {c["login"]: c.get("roster")
                 for c in bc.rank(totals, names, self.roster)["contributors"]}
        self.assertTrue(flags["ada"])       # case variant
        self.assertTrue(flags["cleo"])      # collapsed double space
        self.assertTrue(flags["eve"])       # exact
        self.assertIsNone(flags["dana"])    # near miss must NOT match


class TestNoEmailAssertion(unittest.TestCase):
    def test_clean_document_passes(self):
        bc.assert_no_at({"projects": {"p": {"contributors":
                        [{"login": "ada", "name": "Ada Lovelace",
                          "contributions": 3}]}}})

    def test_at_in_a_value_aborts(self):
        with self.assertRaises(bc.Abort):
            bc.assert_no_at({"contributors": [{"name": "ada@example.com"}]})

    def test_at_in_a_login_aborts(self):
        with self.assertRaises(bc.Abort):
            bc.assert_no_at({"contributors": [{"login": "a@b"}]})

    def test_at_in_a_key_aborts(self):
        with self.assertRaises(bc.Abort):
            bc.assert_no_at({"e@mail": "clean"})


class TestGhJsonParsing(unittest.TestCase):
    def test_single_page(self):
        self.assertEqual(bc.parse_gh_json('[{"login":"ada"}]', "x"),
                         [{"login": "ada"}])

    def test_paginated_pages_are_concatenated(self):
        text = '[{"login":"ada"}]\n[{"login":"bob"}]'
        self.assertEqual(bc.parse_gh_json(text, "x"),
                         [{"login": "ada"}, {"login": "bob"}])

    def test_object_payload(self):
        self.assertEqual(bc.parse_gh_json('{"name":"Ada"}', "x"), {"name": "Ada"})

    def test_empty_output_is_an_empty_list(self):
        self.assertEqual(bc.parse_gh_json("   \n", "x"), [])

    def test_garbage_aborts(self):
        with self.assertRaises(bc.Abort):
            bc.parse_gh_json("{not json", "repos/x/contributors")


class TestGhRetry(unittest.TestCase):
    """The gh wrapper, driven by a fake runner — no subprocess, no network."""

    def make_runner(self, results):
        calls = []

        def runner(args):
            calls.append(list(args))
            return results[min(len(calls) - 1, len(results) - 1)]
        return runner, calls

    def test_success_first_try(self):
        runner, calls = self.make_runner([(0, '[{"login":"ada"}]', "")])
        slept = []
        got = bc.gh_json(["repos/x/contributors"], runner=runner,
                         sleeper=slept.append)
        self.assertEqual(got, [{"login": "ada"}])
        self.assertEqual(len(calls), 1)
        self.assertEqual(slept, [])

    def test_rate_limited_then_success(self):
        runner, calls = self.make_runner([
            (1, "", "gh: HTTP 403: API rate limit exceeded"),
            (0, '[{"login":"ada"}]', ""),
        ])
        slept = []
        with redirect_stdout(io.StringIO()):
            got = bc.gh_json(["repos/x/contributors"], runner=runner,
                             sleeper=slept.append)
        self.assertEqual(got, [{"login": "ada"}])
        self.assertEqual(len(calls), 2)
        self.assertEqual(slept, [bc.BACKOFF_SECONDS])

    def test_rate_limited_twice_aborts(self):
        runner, calls = self.make_runner([(1, "", "gh: HTTP 429 too many requests")])
        slept = []
        with redirect_stdout(io.StringIO()), self.assertRaises(bc.Abort):
            bc.gh_json(["repos/x/contributors"], runner=runner, sleeper=slept.append)
        self.assertEqual(len(calls), 2)          # one retry, then give up
        self.assertEqual(slept, [bc.BACKOFF_SECONDS])

    def test_other_failure_aborts_without_retry(self):
        runner, calls = self.make_runner([(1, "", "gh: Not Found (HTTP 404)")])
        slept = []
        with self.assertRaises(bc.Abort):
            bc.gh_json(["repos/x/nope"], runner=runner, sleeper=slept.append)
        self.assertEqual(len(calls), 1)
        self.assertEqual(slept, [])


# --------------------------------------------------------------------------
# end to end, through the --fixture CLI path
# --------------------------------------------------------------------------
class TestEndToEnd(FixtureCase):
    def test_full_document(self):
        code, log = self.build()
        self.assertEqual(code, 0, log)
        doc = json.loads(self.out.read_text(encoding="utf-8"))

        self.assertEqual(doc["org"], "HippoCampusRobotics")
        self.assertEqual(doc["generated"],
                         "run tools/build_contributors.py to regenerate")
        self.assertIn("public GitHub data", doc["note"])
        self.assertEqual(sorted(doc["projects"]), ["p-forks", "p-one", "p-two"])

        one = doc["projects"]["p-one"]["contributors"]
        self.assertEqual(
            one,
            [{"login": "ada", "name": "ada lovelace", "contributions": 13,
              "roster": True},
             {"login": "cleo", "name": "Cleo  Zhang", "contributions": 8,
              "roster": True},
             {"login": "eve", "name": "Eve Stone", "contributions": 8,
              "roster": True},
             {"login": "bob", "name": "bob", "contributions": 5}])
        self.assertNotIn("truncated", doc["projects"]["p-one"])

        two = doc["projects"]["p-two"]["contributors"]
        self.assertEqual(two, [{"login": "dana", "name": "Dana Nelsen",
                                "contributions": 1}])

        self.assertEqual(doc["projects"]["p-forks"], {"contributors": []})

    def test_no_bot_survives_anywhere(self):
        self.build()
        text = self.out.read_text(encoding="utf-8")
        self.assertNotIn("[bot]", text)
        self.assertNotIn("buildbot", text)

    def test_no_at_sign_anywhere_in_the_output(self):
        self.build()
        self.assertNotIn("@", self.out.read_text(encoding="utf-8"))

    def test_serialisation_is_indent_1_sorted_and_newline_terminated(self):
        self.build()
        text = self.out.read_text(encoding="utf-8")
        self.assertTrue(text.startswith('{\n "generated"'), text[:40])
        self.assertTrue(text.endswith("\n"))
        keys = [ln.strip().split('"')[1] for ln in text.splitlines()
                if ln.startswith("  \"p-")]
        self.assertEqual(keys, sorted(keys))
        self.assertEqual(keys, ["p-forks", "p-one", "p-two"])

    def test_cap_and_truncated_end_to_end(self):
        rows = [{"login": f"user{i:02d}", "contributions": 100 - i,
                 "type": "User"} for i in range(15)]
        users = {f"user{i:02d}": {"name": None} for i in range(15)}
        contributors = dict(CONTRIBUTORS)
        contributors["gamma"] = rows
        users.update(USERS)
        code, log = self.build(contributors=contributors, users=users)
        self.assertEqual(code, 0, log)
        doc = json.loads(self.out.read_text(encoding="utf-8"))
        two = doc["projects"]["p-two"]
        self.assertEqual(len(two["contributors"]), bc.TOP_N)
        self.assertEqual(two["truncated"], 3)

    def test_user_lookups_are_cached(self):
        """ada appears in two repos but users/ada is fetched exactly once."""
        fixture = make_fixture(self.tmp / "fx")
        source = bc.FixtureSource(fixture)
        org = json.loads((fixture / "org-repos.json").read_text())
        projects = json.loads((fixture / "projects.json").read_text())
        people = json.loads((fixture / "people.json").read_text())
        with redirect_stdout(io.StringIO()):
            bc.build(source, org, projects, people)
        self.assertEqual(source.user_calls.count("ada"), 1)
        self.assertEqual(len(source.user_calls), len(set(source.user_calls)))


class TestEndToEndFailures(FixtureCase):
    def assertNoOutput(self):
        self.assertFalse(self.out.exists(),
                         "a failed run must leave no output file behind")

    def test_poisoned_display_name_aborts_and_writes_nothing(self):
        users = dict(USERS)
        users["ada"] = {"name": "ada@example.com"}
        code, log = self.build(users=users)
        self.assertEqual(code, 1)
        self.assertIn("ABORT", log)
        self.assertNoOutput()

    def test_poisoned_login_aborts_and_writes_nothing(self):
        contributors = {k: list(v) for k, v in CONTRIBUTORS.items()}
        contributors["gamma"] = [{"login": "dana@lab", "contributions": 2,
                                  "type": "User"}]
        users = dict(USERS)
        users["dana@lab"] = {"name": "Dana Nelson"}
        code, log = self.build(contributors=contributors, users=users)
        self.assertEqual(code, 1)
        self.assertNoOutput()

    def test_unparseable_payload_aborts_and_writes_nothing(self):
        contributors = dict(CONTRIBUTORS)
        contributors["beta"] = "{not json"
        code, log = self.build(contributors=contributors)
        self.assertEqual(code, 1)
        self.assertIn("ABORT", log)
        self.assertNoOutput()

    def test_missing_contributor_payload_aborts(self):
        contributors = {k: v for k, v in CONTRIBUTORS.items() if k != "beta"}
        code, log = self.build(contributors=contributors)
        self.assertEqual(code, 1)
        self.assertIn("beta", log)
        self.assertNoOutput()

    def test_missing_user_payload_aborts(self):
        users = {k: v for k, v in USERS.items() if k != "cleo"}
        code, log = self.build(users=users)
        self.assertEqual(code, 1)
        self.assertIn("cleo", log)
        self.assertNoOutput()

    def test_stale_output_is_left_untouched_when_the_run_aborts(self):
        code, _ = self.build()
        self.assertEqual(code, 0)
        good = self.out.read_text(encoding="utf-8")
        contributors = dict(CONTRIBUTORS)
        contributors["beta"] = "{not json"
        code, log = self.build(contributors=contributors)
        self.assertEqual(code, 1)
        self.assertEqual(self.out.read_text(encoding="utf-8"), good)


# --------------------------------------------------------------------------
# hygiene
# --------------------------------------------------------------------------
class TestModuleHygiene(unittest.TestCase):
    def test_stdlib_only(self):
        src = Path(bc.__file__).read_text(encoding="utf-8")
        allowed = {"argparse", "json", "os", "re", "subprocess", "sys",
                   "tempfile", "time", "collections", "pathlib"}
        for i, line in enumerate(src.splitlines(), 1):
            if line.startswith("import ") or line.startswith("from "):
                mod = line.split()[1].split(".")[0]
                self.assertIn(mod, allowed, f"line {i}: {line!r}")

    def test_default_output_lives_under_data_graph(self):
        self.assertEqual(bc.DEFAULT_OUT.name, "contributors.json")
        self.assertEqual(bc.DEFAULT_OUT.parent.name, "graph")


if __name__ == "__main__":
    unittest.main(verbosity=2)
