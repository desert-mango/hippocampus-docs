#!/usr/bin/env python3
"""Unit tests for the graph half of the check gate (tools/check.py, checks 9-10).

Run from the repo root with plain python3 (no pytest, no network):

    python3 tools/tests/test_check_graph.py

Every check under test is a PURE function over already-loaded dicts, so a red is
proven with an in-memory fixture that is mutated in place — never by touching a
file under data/. The one test that reads the real data/graph/ files is a
read-only integration check: it loads them and expects zero errors.
"""
import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import check  # noqa: E402


# --------------------------------------------------------------------------
# fixtures: a miniature site — 2 setup pages, 1 project, 1 tool, about,
# the 3 index views, and 2 org repos (one of them a fork).
# --------------------------------------------------------------------------
def setup_reg():
    return {"sections": [
        {"title": "Start", "pages": [
            {"id": "start/index", "title": "Start here",
             "file": "content/setup/start/index.md"},
            {"id": "start/two", "title": "Second page",
             "file": "content/setup/start/two.md"},
        ]},
    ]}


def projects_reg():
    return {"projects": [
        {"id": "core", "name": "Core stack", "status": "active",
         "file": "content/projects/core.md", "repos": [{"name": "alpha"}]},
    ]}


def tools_reg():
    return {"tools": [
        {"id": "search", "name": "Search", "file": "content/tools/search.md"},
    ]}


def org_reg():
    return [
        {"name": "alpha", "url": "https://github.com/HippoCampusRobotics/alpha",
         "isFork": False, "isArchived": False, "pushedAt": "2024-01-02T03:04:05Z"},
        {"name": "beta", "url": "https://github.com/HippoCampusRobotics/beta",
         "isFork": True, "isArchived": False, "pushedAt": "2024-01-02T03:04:05Z"},
    ]


def wiki_doc():
    nodes = [
        {"id": "setup/start/index", "kind": "setup", "title": "Start here",
         "route": "#/setup/start/index", "where": "Setup · Start",
         "summary": "how to start", "file": "content/setup/start/index.md"},
        {"id": "setup/start/two", "kind": "setup", "title": "Second page",
         "route": "#/setup/start/two", "where": "Setup · Start",
         "summary": "the second page", "file": "content/setup/start/two.md"},
        {"id": "projects/core", "kind": "project", "title": "Core stack",
         "route": "#/projects/core", "where": "Project",
         "summary": "the core stack", "file": "content/projects/core.md"},
        {"id": "tools/search", "kind": "tool", "title": "Search",
         "route": "#/tools/search", "where": "Agent tool",
         "summary": "the search tool", "file": "content/tools/search.md"},
        {"id": "about", "kind": "about", "title": "About this site",
         "route": "#/about", "where": "About", "summary": "about the site",
         "file": "content/about.md"},
        {"id": "index:home", "kind": "index", "title": "Home", "route": "#/",
         "summary": "the landing view"},
        {"id": "index:projects", "kind": "index", "title": "Projects",
         "route": "#/projects", "summary": "every project"},
        {"id": "index:tools", "kind": "index", "title": "Agent tools",
         "route": "#/tools", "summary": "every tool"},
        {"id": "repo:alpha", "kind": "repo", "title": "alpha",
         "url": "https://github.com/HippoCampusRobotics/alpha",
         "summary": "the alpha node", "fork": False, "project": "core"},
        {"id": "repo:beta", "kind": "repo", "title": "beta",
         "url": "https://github.com/HippoCampusRobotics/beta",
         "summary": "upstream fork", "fork": True, "project": "core"},
    ]
    edges = [
        {"s": "index:home", "t": "setup/start/index", "type": "related",
         "why": "the home page's Setup card leads here first"},
        {"s": "setup/start/index", "t": "setup/start/two", "type": "links-to",
         "why": "explicit link"},
        {"s": "projects/core", "t": "repo:alpha", "type": "member",
         "why": "project repository"},
        {"s": "tools/search", "t": "projects/core", "type": "mentions",
         "why": "word-boundary match"},
    ]
    return {"generated": "run tools/build_wiki_graph.py to regenerate",
            "note": "index views are excluded from the page parity count",
            "counts": {"pages": 5, "index": 3, "repos": 2,
                       "edges": {"related": 1, "links-to": 1, "member": 1,
                                 "mentions": 1}},
            "nodes": nodes, "edges": edges}


def summaries_doc():
    ids = ["setup/start/index", "setup/start/two", "projects/core",
           "tools/search", "about", "index:home", "index:projects", "index:tools"]
    return {"note": "derived unless authored", "generated": "build_wiki_graph.py",
            "pages": {i: {"summary": f"summary of {i}", "source": "derived"}
                      for i in ids}}


def xref_doc():
    return {"note": "cross-reference terms", "generated": "build_wiki_graph.py",
            "stoplist": ["and", "the", "setup"],
            "terms": {"alpha": "repo:alpha", "Second page": "setup/start/two"},
            "rejected": ["Core stack"]}


def authored_doc():
    return {"note": "hand-written overlay", "edges": [
        {"s": "index:home", "t": "setup/start/index",
         "why": "the home page's Setup card leads here first"},
    ]}


def repos_index_doc():
    return {"generated": "build_repo_graphs.py", "repos": [
        {"name": "alpha", "kind": "repo", "fork": False,
         "oneliner": "the alpha node", "project": "core", "god_nodes": []},
        {"name": "beta", "kind": "repo", "fork": True,
         "oneliner": "upstream fork", "project": None, "god_nodes": []},
    ]}


def shards_doc():
    return {"alpha": {"repo": "alpha",
                      "url": "https://github.com/HippoCampusRobotics/alpha",
                      "description": "the alpha node", "language": "C++",
                      "pushedAt": "2024-01-02T03:04:05Z",
                      "counts": {"nodes": 12, "edges": 20, "communities": 3},
                      "god_nodes": [], "communities": []}}


def contributors_doc():
    return {"generated": "build_contributors.py", "org": "HippoCampusRobotics",
            "note": "public GitHub data; display names as published by GitHub",
            "projects": {"core": {"contributors": [
                {"login": "aaa", "name": "A Person", "contributions": 9,
                 "roster": True},
                {"login": "bbb", "name": "B Person", "contributions": 3},
            ]}}}


class World:
    """A fresh, internally-consistent set of loaded documents per test."""

    def __init__(self):
        self.setup = setup_reg()
        self.projects = projects_reg()
        self.tools = tools_reg()
        self.org = org_reg()
        self.wiki = wiki_doc()
        self.summaries = summaries_doc()
        self.xref = xref_doc()
        self.authored = authored_doc()
        self.repos_index = repos_index_doc()
        self.shards = shards_doc()
        self.contributors = contributors_doc()

    # the checks, wired the way tools/check.py main() wires them
    def parity(self):
        return check.check_graph_parity(self.wiki, self.setup, self.projects,
                                        self.tools, self.org)

    def edges(self):
        return check.check_graph_edges(self.wiki)

    def sums(self):
        return check.check_graph_summaries(self.wiki, self.summaries)

    def shards_check(self):
        return check.check_graph_shards(self.org, self.repos_index,
                                        self.projects, self.shards)

    def xrefs(self):
        return check.check_xref_terms(self.xref, self.wiki)

    def overlay(self):
        return check.check_authored_edges(self.authored, self.wiki)

    def contribs(self):
        return check.check_contributors(self.contributors, self.projects)

    def node(self, nid):
        return next(n for n in self.wiki["nodes"] if n["id"] == nid)


class GraphTestCase(unittest.TestCase):
    def setUp(self):
        self.w = World()

    def assertRed(self, msgs, needle):
        joined = "\n".join(msgs)
        self.assertTrue(msgs, f"expected an error mentioning {needle!r}, got none")
        self.assertIn(needle, joined)


# --------------------------------------------------------------------------
# a. graph parity
# --------------------------------------------------------------------------
class TestGraphParity(GraphTestCase):
    def test_green(self):
        self.assertEqual(self.w.parity(), [])

    def test_enumeration_matches_the_registries(self):
        rows = check.enumerate_page_nodes(self.w.setup, self.w.projects,
                                          self.w.tools)
        self.assertEqual(rows, [("setup/start/index", "setup"),
                                ("setup/start/two", "setup"),
                                ("projects/core", "project"),
                                ("tools/search", "tool"),
                                ("about", "about")])

    def test_missing_page_node_is_red(self):
        self.w.wiki["nodes"] = [n for n in self.w.wiki["nodes"]
                                if n["id"] != "setup/start/two"]
        msgs = self.w.parity()
        self.assertRed(msgs, "page-kind nodes 4 != enumerated 5")
        self.assertRed(msgs, "registry page 'setup/start/two' has no node")

    def test_wrong_kind_is_red(self):
        self.w.node("tools/search")["kind"] = "project"
        self.assertRed(self.w.parity(), "expected 'tool'")

    def test_duplicate_page_node_is_red(self):
        self.w.wiki["nodes"].append(copy.deepcopy(self.w.node("about")))
        self.assertRed(self.w.parity(), "node 'about' appears 2 times")

    def test_stale_page_node_is_red(self):
        self.w.wiki["nodes"].append({"id": "setup/gone", "kind": "setup",
                                     "title": "Gone", "route": "#/setup/gone",
                                     "summary": "x", "file": "content/x.md"})
        self.assertRed(self.w.parity(), "stale page node 'setup/gone'")

    def test_missing_index_node_is_red(self):
        self.w.wiki["nodes"] = [n for n in self.w.wiki["nodes"]
                                if n["id"] != "index:tools"]
        self.assertRed(self.w.parity(), "index nodes")

    def test_unknown_kind_node_is_red(self):
        # Codex-review finding: a node of an unrecognised kind sat outside every
        # per-kind parity set and passed green. The node set must be closed.
        self.w.wiki["nodes"].append({"id": "unexpected", "kind": "other",
                                     "title": "?", "summary": "x"})
        self.w.summaries["pages"]["unexpected"] = {"summary": "x", "source": "derived"}
        self.assertRed(self.w.parity(), "node 'unexpected' has unknown kind 'other'")

    def test_extra_index_node_is_red(self):
        self.w.wiki["nodes"].append({"id": "index:blog", "kind": "index",
                                     "title": "Blog", "route": "#/blog",
                                     "summary": "x"})
        self.assertRed(self.w.parity(), "index nodes")

    def test_missing_repo_node_is_red(self):
        self.w.wiki["nodes"] = [n for n in self.w.wiki["nodes"]
                                if n["id"] != "repo:beta"]
        self.assertRed(self.w.parity(), "org repo node 'repo:beta' is missing")

    def test_unknown_repo_node_is_red(self):
        self.w.wiki["nodes"].append({"id": "repo:ghost", "kind": "repo",
                                     "title": "ghost", "summary": "x",
                                     "fork": False, "project": None})
        self.assertRed(self.w.parity(), "repo node 'repo:ghost' is not an org repo")

    def test_stale_counts_block_is_red(self):
        self.w.wiki["counts"]["pages"] = 4
        self.assertRed(self.w.parity(), "counts.pages says 4 but the graph holds 5")

    def test_stale_edge_counts_are_red(self):
        self.w.wiki["counts"]["edges"]["mentions"] = 99
        self.assertRed(self.w.parity(), "counts.edges")

    def test_missing_counts_block_is_red(self):
        del self.w.wiki["counts"]
        self.assertRed(self.w.parity(), "'counts' block missing")

    def test_duplicate_registry_page_id_is_red(self):
        self.w.setup["sections"][0]["pages"].append(
            {"id": "start/two", "title": "Dupe", "file": "content/x.md"})
        self.assertRed(self.w.parity(), "duplicate page id")


# --------------------------------------------------------------------------
# b. edges
# --------------------------------------------------------------------------
class TestGraphEdges(GraphTestCase):
    def test_green(self):
        self.assertEqual(self.w.edges(), [])

    def test_dangling_endpoint_is_red(self):
        self.w.wiki["edges"][1]["t"] = "setup/nowhere"
        self.assertRed(self.w.edges(), "endpoint 'setup/nowhere' is not a node")

    def test_dangling_source_is_red(self):
        self.w.wiki["edges"][1]["s"] = "setup/nowhere"
        self.assertRed(self.w.edges(), "'s' endpoint 'setup/nowhere'")

    def test_self_edge_is_red(self):
        self.w.wiki["edges"][1]["t"] = self.w.wiki["edges"][1]["s"]
        self.assertRed(self.w.edges(), "self edge")

    def test_unknown_type_is_red(self):
        self.w.wiki["edges"][0]["type"] = "see-also"
        self.assertRed(self.w.edges(), "unknown type 'see-also'")

    def test_empty_why_is_red(self):
        self.w.wiki["edges"][2]["why"] = "   "
        self.assertRed(self.w.edges(), "'why' must be a non-empty string")

    def test_missing_why_is_red(self):
        del self.w.wiki["edges"][2]["why"]
        self.assertRed(self.w.edges(), "'why' must be a non-empty string")

    def test_duplicate_edge_is_red(self):
        self.w.wiki["edges"].append(copy.deepcopy(self.w.wiki["edges"][1]))
        self.assertRed(self.w.edges(), "duplicate edge")

    def test_same_pair_different_type_is_green(self):
        twin = copy.deepcopy(self.w.wiki["edges"][1])
        twin["type"] = "mentions"
        self.w.wiki["edges"].append(twin)
        self.assertEqual(self.w.edges(), [])


# --------------------------------------------------------------------------
# c. summaries
# --------------------------------------------------------------------------
class TestGraphSummaries(GraphTestCase):
    def test_green(self):
        self.assertEqual(self.w.sums(), [])

    def test_empty_page_summary_is_red(self):
        self.w.node("about")["summary"] = ""
        self.assertRed(self.w.sums(), "node 'about' has an empty summary")

    def test_empty_repo_summary_is_red(self):
        self.w.node("repo:alpha")["summary"] = "  "
        self.assertRed(self.w.sums(), "node 'repo:alpha' has an empty summary")

    def test_missing_summary_entry_is_red(self):
        del self.w.summaries["pages"]["index:home"]
        self.assertRed(self.w.sums(), "no entry for node 'index:home'")

    def test_unknown_summary_entry_is_red(self):
        self.w.summaries["pages"]["setup/ghost"] = {"summary": "x",
                                                    "source": "derived"}
        self.assertRed(self.w.sums(), "entry 'setup/ghost' is not a page or index node")

    def test_repo_id_in_summaries_is_red(self):
        self.w.summaries["pages"]["repo:alpha"] = {"summary": "x",
                                                   "source": "derived"}
        self.assertRed(self.w.sums(), "entry 'repo:alpha'")

    def test_blank_summary_entry_is_red(self):
        self.w.summaries["pages"]["about"]["summary"] = ""
        self.assertRed(self.w.sums(), "'about' has an empty summary")

    def test_unknown_source_is_red(self):
        self.w.summaries["pages"]["about"]["source"] = "guessed"
        self.assertRed(self.w.sums(), "source 'guessed'")

    def test_authored_source_is_green(self):
        self.w.summaries["pages"]["about"]["source"] = "authored"
        self.assertEqual(self.w.sums(), [])


# --------------------------------------------------------------------------
# d. repo shards + repos-index
# --------------------------------------------------------------------------
class TestGraphShards(GraphTestCase):
    def test_green(self):
        self.assertEqual(self.w.shards_check(), [])

    def test_missing_shard_for_non_fork_is_red(self):
        del self.w.shards["alpha"]
        self.assertRed(self.w.shards_check(), "missing shard for org repo 'alpha'")

    def test_shard_for_a_fork_is_red(self):
        self.w.shards["beta"] = {"repo": "beta", "counts": {}, "god_nodes": [],
                                 "communities": []}
        self.assertRed(self.w.shards_check(), "shard for a fork")

    def test_stray_shard_is_red(self):
        self.w.shards["ghost"] = {"repo": "ghost", "counts": {}, "god_nodes": [],
                                  "communities": []}
        self.assertRed(self.w.shards_check(), "stray shard")

    def test_repo_field_mismatch_is_red(self):
        self.w.shards["alpha"]["repo"] = "alfa"
        self.assertRed(self.w.shards_check(), "'repo' is 'alfa', expected 'alpha'")

    def test_missing_counts_is_red(self):
        del self.w.shards["alpha"]["counts"]
        self.assertRed(self.w.shards_check(), "'counts' block missing")

    def test_god_nodes_not_a_list_is_red(self):
        self.w.shards["alpha"]["god_nodes"] = {}
        self.assertRed(self.w.shards_check(), "'god_nodes' must be a list")

    def test_communities_not_a_list_is_red(self):
        del self.w.shards["alpha"]["communities"]
        self.assertRed(self.w.shards_check(), "'communities' must be a list")

    def test_unparseable_shard_is_skipped_not_double_reported(self):
        # main() stores None for a shard whose JSON did not parse; the widened
        # hygiene scan (6b) already reports the decode error.
        self.w.shards["alpha"] = None
        self.assertEqual(self.w.shards_check(), [])

    def test_missing_index_row_is_red(self):
        self.w.repos_index["repos"] = [r for r in self.w.repos_index["repos"]
                                       if r["name"] != "beta"]
        self.assertRed(self.w.shards_check(), "no row for org repo 'beta'")

    def test_duplicate_index_row_is_red(self):
        self.w.repos_index["repos"].append(
            copy.deepcopy(self.w.repos_index["repos"][0]))
        self.assertRed(self.w.shards_check(), "org repo 'alpha' has 2 rows")

    def test_unknown_index_row_is_red(self):
        self.w.repos_index["repos"].append(
            {"name": "ghost", "kind": "repo", "fork": False,
             "oneliner": "nope", "project": None, "god_nodes": []})
        self.assertRed(self.w.shards_check(), "row 'ghost' is not an org repo")

    def test_empty_oneliner_is_red(self):
        self.w.repos_index["repos"][0]["oneliner"] = ""
        self.assertRed(self.w.shards_check(), "has an empty oneliner")

    def test_fork_flag_mismatch_is_red(self):
        self.w.repos_index["repos"][1]["fork"] = False
        self.assertRed(self.w.shards_check(), "fork flag")

    def test_unknown_project_is_red(self):
        self.w.repos_index["repos"][0]["project"] = "not-a-project"
        self.assertRed(self.w.shards_check(), "names unknown project 'not-a-project'")

    def test_null_project_is_green(self):
        self.w.repos_index["repos"][0]["project"] = None
        self.assertEqual(self.w.shards_check(), [])


# --------------------------------------------------------------------------
# e. xref terms
# --------------------------------------------------------------------------
class TestXrefTerms(GraphTestCase):
    def test_green(self):
        self.assertEqual(self.w.xrefs(), [])

    def test_term_on_the_stoplist_is_red(self):
        self.w.xref["terms"]["Setup"] = "setup/start/index"
        self.assertRed(self.w.xrefs(), "is on the stoplist")

    def test_term_on_the_rejected_list_is_red(self):
        self.w.xref["terms"]["core stack"] = "projects/core"
        self.assertRed(self.w.xrefs(), "is on the rejected list")

    def test_unresolvable_target_is_red(self):
        self.w.xref["terms"]["alpha"] = "repo:ghost"
        self.assertRed(self.w.xrefs(), "which is not a wiki.json node")

    def test_empty_term_is_red(self):
        self.w.xref["terms"][" "] = "about"
        self.assertRed(self.w.xrefs(), "must be a non-empty string")

    def test_case_only_duplicate_terms_are_red(self):
        self.w.xref["terms"]["Alpha"] = "repo:alpha"
        self.assertRed(self.w.xrefs(), "differ only by case")


# --------------------------------------------------------------------------
# f. authored overlay
# --------------------------------------------------------------------------
class TestAuthoredEdges(GraphTestCase):
    def test_green(self):
        self.assertEqual(self.w.overlay(), [])

    def test_dangling_endpoint_is_red(self):
        self.w.authored["edges"][0]["t"] = "setup/nowhere"
        self.assertRed(self.w.overlay(), "endpoint 'setup/nowhere' is not a wiki.json node")

    def test_empty_why_is_red(self):
        self.w.authored["edges"][0]["why"] = ""
        self.assertRed(self.w.overlay(), "'why' must be a non-empty string")

    def test_unmerged_overlay_edge_is_red(self):
        # a stale wiki.json: the overlay grew an edge the graph never got
        self.w.authored["edges"].append(
            {"s": "about", "t": "projects/core", "why": "the About page names it"})
        self.assertRed(self.w.overlay(), "the overlay was not merged")

    def test_overlay_edge_merged_with_the_wrong_type_is_red(self):
        self.w.wiki["edges"][0]["type"] = "links-to"
        self.assertRed(self.w.overlay(), "the overlay was not merged")


# --------------------------------------------------------------------------
# g. hygiene widening (6b now scans data/**/*.json, graph shards included)
# --------------------------------------------------------------------------
class TestHygieneWidening(unittest.TestCase):
    def setUp(self):
        self.src = (Path(check.__file__).with_suffix(".py")).read_text(encoding="utf-8")

    def test_json_hygiene_walks_the_whole_data_tree(self):
        self.assertIn('(ROOT / "data").rglob("*.json")', self.src)

    def test_json_hygiene_no_longer_stops_at_the_top_level(self):
        self.assertNotIn('(ROOT / "data").glob("*.json")', self.src)

    def test_docstring_says_data_star_star(self):
        self.assertIn("data/**/*.json", check.__doc__)


# --------------------------------------------------------------------------
# h. contributors (optional-when-present)
# --------------------------------------------------------------------------
class TestContributors(GraphTestCase):
    def test_green(self):
        self.assertEqual(self.w.contribs(), [])

    def test_absent_file_is_green(self):
        self.assertEqual(check.check_contributors(None, self.w.projects), [])

    def test_extra_top_level_key_is_red(self):
        self.w.contributors["token"] = "x"
        self.assertRed(self.w.contribs(), "unknown top-level key(s)")

    def test_missing_top_level_key_is_red(self):
        del self.w.contributors["note"]
        self.assertRed(self.w.contribs(), "missing top-level key(s)")

    def test_wrong_org_is_red(self):
        self.w.contributors["org"] = "SomeoneElse"
        self.assertRed(self.w.contribs(), "expected 'HippoCampusRobotics'")

    def test_unknown_project_key_is_red(self):
        self.w.contributors["projects"]["ghost"] = {"contributors": []}
        self.assertRed(self.w.contribs(), "'ghost' is not a project id")

    def test_missing_project_key_is_red(self):
        del self.w.contributors["projects"]["core"]
        self.assertRed(self.w.contribs(), "no entry for project 'core'")

    def test_unknown_row_field_is_red(self):
        self.w.contributors["projects"]["core"]["contributors"][0]["email"] = "x"
        self.assertRed(self.w.contribs(), "unknown field(s)")

    def test_empty_login_is_red(self):
        self.w.contributors["projects"]["core"]["contributors"][0]["login"] = ""
        self.assertRed(self.w.contribs(), "'login' must be a non-empty string")

    def test_empty_name_is_red(self):
        self.w.contributors["projects"]["core"]["contributors"][1]["name"] = "  "
        self.assertRed(self.w.contribs(), "'name' must be a non-empty string")

    def test_zero_contributions_is_red(self):
        self.w.contributors["projects"]["core"]["contributors"][1]["contributions"] = 0
        self.assertRed(self.w.contribs(), "'contributions' must be a positive integer")

    def test_boolean_contributions_is_red(self):
        self.w.contributors["projects"]["core"]["contributors"][1]["contributions"] = True
        self.assertRed(self.w.contribs(), "'contributions' must be a positive integer")

    def test_roster_false_is_red(self):
        self.w.contributors["projects"]["core"]["contributors"][0]["roster"] = False
        self.assertRed(self.w.contribs(), "'roster' must be true when present")

    def test_bot_login_is_red(self):
        self.w.contributors["projects"]["core"]["contributors"][1]["login"] = "dependabot[bot]"
        self.assertRed(self.w.contribs(), "bot account")

    def test_an_at_sign_anywhere_is_red(self):
        self.w.contributors["projects"]["core"]["contributors"][1]["name"] = "b@example.com"
        self.assertRed(self.w.contribs(), "privacy projection")

    def test_an_at_sign_in_the_note_is_red(self):
        self.w.contributors["note"] = "ask kyle@example.com"
        self.assertRed(self.w.contribs(), "privacy projection")

    def test_unsorted_rows_are_red(self):
        rows = self.w.contributors["projects"]["core"]["contributors"]
        rows.reverse()
        self.assertRed(self.w.contribs(), "not sorted by contributions")

    def test_login_tiebreak_ordering_is_red(self):
        rows = self.w.contributors["projects"]["core"]["contributors"]
        rows[0]["contributions"] = 3
        rows[0]["login"] = "zzz"
        rows[1]["login"] = "aaa"
        self.assertRed(self.w.contribs(), "not sorted by contributions")

    def test_more_than_twelve_rows_is_red(self):
        rows = self.w.contributors["projects"]["core"]["contributors"]
        rows[:] = [{"login": f"u{i:02d}", "name": f"User {i}",
                    "contributions": 100 - i} for i in range(13)]
        self.assertRed(self.w.contribs(), "at most 12")

    def test_bad_truncated_is_red(self):
        self.w.contributors["projects"]["core"]["truncated"] = 0
        self.assertRed(self.w.contribs(), "must be a positive integer when present")

    def test_positive_truncated_is_green(self):
        self.w.contributors["projects"]["core"]["truncated"] = 39
        self.assertEqual(self.w.contribs(), [])

    def test_unknown_bucket_key_is_red(self):
        self.w.contributors["projects"]["core"]["emails"] = []
        self.assertRed(self.w.contribs(), "unknown key(s)")


# --------------------------------------------------------------------------
# integration: the REAL data/graph/ files must be green (read-only)
# --------------------------------------------------------------------------
class TestContributorDuplicates(GraphTestCase):
    def test_duplicate_login_in_a_project_is_red(self):
        # Codex-review finding: a repeated login that keeps the sort order passed.
        pid = next(iter(self.w.contributors["projects"]))
        rows = self.w.contributors["projects"][pid]["contributors"]
        rows.append(dict(rows[0], contributions=1))
        rows.sort(key=lambda r: (-r["contributions"], r["login"]))
        msgs = check.check_contributors(self.w.contributors, self.w.projects)
        self.assertRed(msgs, f"login '{rows[0]['login']}' appears more than once")


class TestAuthoredWhyPropagation(GraphTestCase):
    def test_edited_why_not_regenerated_is_red(self):
        e = self.w.authored["edges"][0]
        e["why"] = e["why"] + " (edited after the last build)"
        msgs = check.check_authored_edges(self.w.authored, self.w.wiki)
        self.assertRed(msgs, "'why' differs from wiki.json")


class TestRealTree(unittest.TestCase):
    """Read-only: loads the committed artifacts and expects zero errors.

    Nothing here writes to data/ — a red is only ever proven above, in memory.
    """

    @classmethod
    def setUpClass(cls):
        def rd(rel):
            return json.loads((check.ROOT / rel).read_text(encoding="utf-8"))
        cls.setup = rd("data/setup.json")
        cls.projects = rd("data/projects.json")
        cls.tools = rd("data/tools.json")
        cls.org = rd("data/org-repos.json")
        cls.wiki = rd("data/graph/wiki.json")
        cls.summaries = rd("data/graph/summaries.json")
        cls.xref = rd("data/graph/xref-terms.json")
        cls.authored = rd("data/graph/edges-authored.json")
        cls.repos_index = rd("data/graph/repos-index.json")
        cls.shards = check.read_repo_shards(check.ROOT)
        p = check.ROOT / "data" / "graph" / "contributors.json"
        cls.contributors = (json.loads(p.read_text(encoding="utf-8"))
                            if p.exists() else None)

    def test_parity(self):
        self.assertEqual(check.check_graph_parity(
            self.wiki, self.setup, self.projects, self.tools, self.org), [])

    def test_edges(self):
        self.assertEqual(check.check_graph_edges(self.wiki), [])

    def test_summaries(self):
        self.assertEqual(check.check_graph_summaries(self.wiki, self.summaries), [])

    def test_shards(self):
        self.assertEqual(check.check_graph_shards(
            self.org, self.repos_index, self.projects, self.shards), [])

    def test_xref(self):
        self.assertEqual(check.check_xref_terms(self.xref, self.wiki), [])

    def test_authored(self):
        self.assertEqual(check.check_authored_edges(self.authored, self.wiki), [])

    def test_contributors(self):
        self.assertEqual(check.check_contributors(self.contributors, self.projects), [])

    def test_the_real_enumeration_is_the_expected_size(self):
        # 71 setup pages + 15 projects + 3 tools + about
        rows = check.enumerate_page_nodes(self.setup, self.projects, self.tools)
        self.assertEqual(len(rows), 90)
        self.assertEqual(len({r for r, _ in rows}), 90)


if __name__ == "__main__":
    unittest.main(verbosity=2)
