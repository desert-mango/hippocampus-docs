#!/usr/bin/env python3
"""Unit tests for tools/build_wiki_graph.py.

Run from the repo root with plain python3 (no pytest, no graphify, no network):

    python3 tools/tests/test_build_wiki_graph.py

Every test drives the builder over a tiny fixture site written into a temp
directory (its own data/ registries and content/*.md), so nothing here depends
on the real content and nothing here writes into the repo. The one exception is
the excerpt-hoist test, which imports the REAL tools/build_search_index.py to
prove excerpt() is importable at module level under plain python3.
"""
import io
import json
import sys
import unittest
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import build_search_index as bsi  # noqa: E402
import build_wiki_graph as bwg  # noqa: E402


# --------------------------------------------------------------------------
# fixture site
# --------------------------------------------------------------------------
INSTALL_MD = """# Install ROS 2

Install ROS 2 on the workstation, then continue with the rest of the setup.

See [Gantry usage](#/setup/guides/gantry-usage) before running the gantry, and
install the hippo_control_msgs package first. Deploy the vehicle afterwards.

```bash
ros2 run hippo_control talker
```

`hippo_control` is also named in an inline code span, and Hippo_Control is
spelled with the wrong case here on purpose.
"""

DEPLOY_MD = """# Deploy

Deploying the vehicle is the last step of a bring-up.
"""

GANTRY_MD = """# Gantry usage

Run the gantry from the GUI. Related: [install](#/setup/getting-started/install@anchor),
[the tool](#/tools/tool-one?x=1), [home](#/), [projects](#/projects),
[search](#/search?q=gantry) and the [setup index](#/setup).

<a href="#/projects/p-one">Project One</a>
"""

PROJECT_MD = """# Project One

Project One collects the controller packages used on the vehicle.
"""

TOOL_MD = """# tool-one

- a bullet
- another bullet
"""

ABOUT_MD = """# About this site

A tiny fixture site used by the unit tests.
"""


def org_row(name, fork=False):
    return {"name": name, "url": f"https://github.com/HippoCampusRobotics/{name}",
            "description": "", "isFork": fork, "isArchived": False,
            "primaryLanguage": {"name": "Python"}, "pushedAt": "2024-01-02T03:04:05Z"}


def index_row(name, fork=False, oneliner="one liner", project="p-one"):
    return {"name": name, "kind": "repo", "fork": fork, "oneliner": oneliner,
            "project": project, "god_nodes": []}


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def make_site(root, **files):
    """Write the fixture registries + content under `root`; return `root`."""
    root = Path(root)
    setup = {"sections": [
        {"id": "getting-started", "title": "Getting started", "pages": [
            {"id": "getting-started/install", "title": "Install ROS 2",
             "file": "content/setup/getting-started/install.md"},
            {"id": "getting-started/deploy", "title": "Deploy",
             "file": "content/setup/getting-started/deploy.md"}]},
        {"id": "guides", "title": "Guides & misc", "pages": [
            {"id": "guides/gantry-usage", "title": "Gantry usage",
             "file": "content/setup/guides/gantry-usage.md"}]}]}
    projects = {"intro": "Projects intro.", "projects": [
        {"id": "p-one", "name": "Project One", "status": "active",
         "tagline": "Project tagline.", "file": "content/projects/p-one.md",
         "repos": [
             {"name": "hippo_control", "role": "controller stack", "external": False},
             {"name": "hippo_control_msgs", "role": "message definitions", "external": False},
             {"name": "gantry", "role": "", "external": False},
             {"name": "ext-cad", "role": "CAD (external, canonical)", "external": True}],
         "links": [{"label": "see also", "href": "#/setup/guides/gantry-usage"}]}]}
    tools = {"intro": "Tools intro.", "tools": [
        {"id": "tool-one", "name": "tool-one", "file": "content/tools/tool-one.md",
         "tagline": "Tool tagline.", "chips": ["MCP"]}]}
    site = {"kicker": "k", "title": "t", "lead": "Site lead.", "home_cards": []}
    org = [org_row("hippo_control"), org_row("hippo_control_msgs", fork=True),
           org_row("gantry")]
    repos_index = {"generated": "x", "repos": [
        index_row("hippo_control", oneliner="controller stack"),
        index_row("hippo_control_msgs", fork=True, oneliner="message definitions"),
        index_row("gantry", oneliner="gantry rig")]}

    write(root / "data/setup.json", json.dumps(setup))
    write(root / "data/projects.json", json.dumps(projects))
    write(root / "data/tools.json", json.dumps(tools))
    write(root / "data/site.json", json.dumps(site))
    write(root / "data/org-repos.json", json.dumps(org))
    write(root / "data/graph/repos-index.json", json.dumps(repos_index))

    body = {"install": INSTALL_MD, "deploy": DEPLOY_MD, "gantry": GANTRY_MD,
            "project": PROJECT_MD, "tool": TOOL_MD, "about": ABOUT_MD}
    body.update(files)
    write(root / "content/setup/getting-started/install.md", body["install"])
    write(root / "content/setup/getting-started/deploy.md", body["deploy"])
    write(root / "content/setup/guides/gantry-usage.md", body["gantry"])
    write(root / "content/projects/p-one.md", body["project"])
    write(root / "content/tools/tool-one.md", body["tool"])
    write(root / "content/about.md", body["about"])
    return root


class FixtureCase(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.root = make_site(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def build(self, **kw):
        buf = io.StringIO()
        with redirect_stdout(buf), redirect_stderr(buf):
            result = bwg.build_all(self.root, **kw)
        self.out = buf.getvalue()
        return result

    def edges(self, result, etype):
        return [e for e in result["graph"]["edges"] if e["type"] == etype]

    def pairs(self, result, etype):
        return {(e["s"], e["t"]) for e in self.edges(result, etype)}


# --------------------------------------------------------------------------
# nodes
# --------------------------------------------------------------------------
class TestNodes(FixtureCase):
    def test_ids_kinds_routes(self):
        g = self.build()["graph"]
        by_id = {n["id"]: n for n in g["nodes"]}
        self.assertIn("setup/getting-started/install", by_id)
        self.assertIn("projects/p-one", by_id)
        self.assertIn("tools/tool-one", by_id)
        self.assertIn("about", by_id)
        self.assertIn("index:home", by_id)
        self.assertIn("repo:hippo_control", by_id)

        n = by_id["setup/getting-started/install"]
        self.assertEqual(n["kind"], "setup")
        self.assertEqual(n["route"], "#/setup/getting-started/install")
        self.assertEqual(n["where"], "Setup · Getting started")
        self.assertEqual(n["file"], "content/setup/getting-started/install.md")
        self.assertEqual(by_id["projects/p-one"]["where"], "Project")
        self.assertEqual(by_id["tools/tool-one"]["where"], "Agent tool")
        self.assertEqual(by_id["about"]["where"], "About")
        self.assertEqual(by_id["about"]["route"], "#/about")
        self.assertEqual(by_id["index:projects"]["route"], "#/projects")
        self.assertEqual(by_id["index:tools"]["title"], "Agent tools")
        self.assertEqual(by_id["index:home"]["summary"], "Site lead.")

    def test_repo_node_fields(self):
        g = self.build()["graph"]
        by_id = {n["id"]: n for n in g["nodes"]}
        r = by_id["repo:hippo_control_msgs"]
        self.assertEqual(r["kind"], "repo")
        self.assertEqual(r["title"], "hippo_control_msgs")
        self.assertEqual(r["url"], "https://github.com/HippoCampusRobotics/hippo_control_msgs")
        self.assertEqual(r["summary"], "message definitions")
        self.assertTrue(r["fork"])
        self.assertEqual(r["project"], "p-one")

    def test_counts_exclude_index_from_pages(self):
        g = self.build()["graph"]
        self.assertEqual(g["counts"]["pages"], 6)
        self.assertEqual(g["counts"]["index"], 3)
        self.assertEqual(g["counts"]["repos"], 3)
        self.assertEqual(len(g["nodes"]), 12)
        self.assertIn("parity", g["note"].lower())

    def test_nodes_sorted_by_id(self):
        g = self.build()["graph"]
        ids = [n["id"] for n in g["nodes"]]
        self.assertEqual(ids, sorted(ids))

    def test_repo_row_count_mismatch_fails(self):
        idx = json.loads((self.root / "data/graph/repos-index.json").read_text())
        idx["repos"] = idx["repos"][:2]
        (self.root / "data/graph/repos-index.json").write_text(json.dumps(idx))
        with self.assertRaises(bwg.BuildError) as cm:
            self.build()
        self.assertIn("repos-index", str(cm.exception))

    def test_duplicate_row_masking_an_omitted_repo_fails(self):
        # Same length, one name duplicated, one org repo missing: the length and
        # unknown-name checks both pass, so the set/duplicate checks must fire.
        idx = json.loads((self.root / "data/graph/repos-index.json").read_text())
        rows = idx["repos"]
        dropped = rows[-1]["name"]
        rows[-1] = dict(rows[0])
        idx["repos"] = rows
        (self.root / "data/graph/repos-index.json").write_text(json.dumps(idx))
        with self.assertRaises(bwg.BuildError) as cm:
            self.build()
        msg = str(cm.exception)
        self.assertIn("more than once", msg)
        self.assertIn(rows[0]["name"], msg)
        self.assertFalse((self.root / "data/graph/wiki.json").exists(),
                         f"no graph may be written when {dropped} is masked")

    def test_missing_repo_with_padding_row_fails(self):
        idx = json.loads((self.root / "data/graph/repos-index.json").read_text())
        rows = idx["repos"]
        dropped = rows.pop()["name"]
        rows.append(dict(rows[0], name="zz_not_an_org_repo"))
        (self.root / "data/graph/repos-index.json").write_text(json.dumps(idx))
        with self.assertRaises(bwg.BuildError) as cm:
            self.build()
        self.assertIn("not org repos", str(cm.exception))


# --------------------------------------------------------------------------
# links-to
# --------------------------------------------------------------------------
class TestLinksTo(FixtureCase):
    def test_routes_resolved_anchor_and_query_stripped(self):
        r = self.build()
        pairs = self.pairs(r, "links-to")
        src = "setup/guides/gantry-usage"
        self.assertIn((src, "setup/getting-started/install"), pairs)
        self.assertIn((src, "tools/tool-one"), pairs)
        self.assertIn((src, "index:home"), pairs)
        self.assertIn((src, "index:projects"), pairs)
        self.assertIn((src, "projects/p-one"), pairs)

    def test_nodeless_routes_skipped(self):
        r = self.build()
        targets = {t for s, t in self.pairs(r, "links-to")}
        self.assertNotIn("index:setup", targets)
        self.assertFalse(any("search" in t for t in targets))

    def test_project_links_are_see_also(self):
        r = self.build()
        why = {(e["s"], e["t"]): e["why"] for e in self.edges(r, "links-to")}
        self.assertEqual(why[("projects/p-one", "setup/guides/gantry-usage")],
                         "see-also link")
        self.assertEqual(
            why[("setup/getting-started/install", "setup/guides/gantry-usage")],
            "explicit link")

    def test_unknown_route_fails_loudly(self):
        write(self.root / "content/setup/getting-started/deploy.md",
              "# Deploy\n\nBroken [link](#/setup/nope/missing).\n")
        with self.assertRaises(bwg.BuildError) as cm:
            self.build()
        self.assertIn("#/setup/nope/missing", str(cm.exception))

    def test_no_self_edges(self):
        write(self.root / "content/setup/getting-started/deploy.md",
              "# Deploy\n\nA [self](#/setup/getting-started/deploy) link.\n")
        r = self.build()
        for e in r["graph"]["edges"]:
            self.assertNotEqual(e["s"], e["t"])


# --------------------------------------------------------------------------
# member
# --------------------------------------------------------------------------
class TestMember(FixtureCase):
    def test_member_edges_and_external_skipped(self):
        r = self.build()
        pairs = self.pairs(r, "member")
        self.assertIn(("projects/p-one", "repo:hippo_control"), pairs)
        self.assertIn(("projects/p-one", "repo:hippo_control_msgs"), pairs)
        self.assertIn(("projects/p-one", "repo:gantry"), pairs)
        self.assertFalse(any("ext-cad" in t for s, t in pairs))
        self.assertEqual(len(pairs), 3)

    def test_why_is_role_with_fallback(self):
        r = self.build()
        why = {(e["s"], e["t"]): e["why"] for e in self.edges(r, "member")}
        self.assertEqual(why[("projects/p-one", "repo:hippo_control")],
                         "controller stack")
        self.assertEqual(why[("projects/p-one", "repo:gantry")], "member repo")

    def test_tool_repo_chips_become_member_edges(self):
        tools = json.loads((self.root / "data/tools.json").read_text())
        tools["tools"][0]["chips"] = ["MCP", "gantry"]
        (self.root / "data/tools.json").write_text(json.dumps(tools))
        r = self.build()
        self.assertIn(("tools/tool-one", "repo:gantry"), self.pairs(r, "member"))


# --------------------------------------------------------------------------
# mentions
# --------------------------------------------------------------------------
class TestMentions(FixtureCase):
    def test_repo_name_word_boundary_and_case(self):
        r = self.build()
        pairs = self.pairs(r, "mentions")
        src = "setup/getting-started/install"
        # exact name, underscore counts as a word char
        self.assertIn((src, "repo:hippo_control_msgs"), pairs)
        # 'hippo_control' only occurs in a fence, in an inline span, inside a
        # longer name, and mis-cased -> no edge
        self.assertNotIn((src, "repo:hippo_control"), pairs)
        # lowercase 'gantry' in prose is an exact, case-sensitive hit
        self.assertIn((src, "repo:gantry"), pairs)

    def test_other_page_titles_matched_case_insensitively(self):
        r = self.build()
        pairs = self.pairs(r, "mentions")
        self.assertIn(("setup/getting-started/install", "setup/guides/gantry-usage"),
                      pairs)
        self.assertIn(("setup/guides/gantry-usage", "projects/p-one"), pairs)

    def test_own_title_excluded(self):
        r = self.build()
        self.assertNotIn(("setup/getting-started/install",
                          "setup/getting-started/install"),
                         self.pairs(r, "mentions"))

    def test_stoplisted_title_does_not_spray(self):
        r = self.build()
        # 'Deploy the vehicle' appears in install.md, but 'Deploy' is stoplisted
        self.assertNotIn(("setup/getting-started/install", "setup/getting-started/deploy"),
                         self.pairs(r, "mentions"))

    def test_why_names_the_term(self):
        r = self.build()
        why = {(e["s"], e["t"]): e["why"] for e in self.edges(r, "mentions")}
        self.assertIn("hippo_control_msgs",
                      why[("setup/getting-started/install", "repo:hippo_control_msgs")])

    def test_one_edge_per_pair(self):
        write(self.root / "content/setup/getting-started/deploy.md",
              "# Deploy\n\ngantry gantry gantry, all of them gantry.\n")
        r = self.build()
        pairs = [(e["s"], e["t"]) for e in self.edges(r, "mentions")]
        self.assertEqual(len(pairs), len(set(pairs)))

    def test_stoplisted_repo_name_is_muted(self):
        write(self.root / "data/graph/xref-terms.json", json.dumps(
            {"note": "n", "stoplist": ["gantry"], "terms": {}, "rejected": []}))
        r = self.build()
        self.assertNotIn(("setup/getting-started/install", "repo:gantry"),
                         self.pairs(r, "mentions"))

    def test_spraying_repo_name_muted_but_short_names_survive(self):
        prose = {f"p{i}": "docs everywhere" for i in range(16)}
        prose["p0"] += " and dvl too"
        kept, dropped = bwg.mention_repo_terms(["docs", "dvl"], prose, set(), set())
        self.assertEqual(kept, ["dvl"])
        self.assertIn(("docs", "matches 16 pages"), dropped)


# --------------------------------------------------------------------------
# prose stripping
# --------------------------------------------------------------------------
class TestProse(unittest.TestCase):
    def test_fences_inline_code_and_link_targets_removed(self):
        md = ("# Heading kept\n\nprose one `inline_code` two\n\n"
              "```\nfenced_code\n```\n\nlink [label](#/setup/target-slug) end\n"
              "<div class=\"adm adm-note\">html</div>\n")
        prose = bwg.prose_text(md)
        self.assertIn("Heading kept", prose)
        self.assertIn("prose one", prose)
        self.assertIn("label", prose)
        self.assertNotIn("inline_code", prose)
        self.assertNotIn("fenced_code", prose)
        self.assertNotIn("target-slug", prose)
        self.assertNotIn("adm-note", prose)

    def test_whitespace_normalised_so_wrapped_terms_match(self):
        prose = bwg.prose_text("A Gantry\nusage sentence.\n")
        self.assertIn("Gantry usage", prose)


# --------------------------------------------------------------------------
# related overlay
# --------------------------------------------------------------------------
class TestRelated(FixtureCase):
    def overlay(self, doc):
        write(self.root / "data/graph/edges-authored.json", json.dumps(doc))

    def test_missing_overlay_is_empty_and_loud(self):
        r = self.build()
        self.assertEqual(self.edges(r, "related"), [])
        self.assertIn("no authored edges overlay", self.out)

    def test_valid_overlay_becomes_related_edges(self):
        self.overlay({"note": "n", "edges": [
            {"s": "about", "t": "projects/p-one", "why": "the site is the project"}]})
        r = self.build()
        e = self.edges(r, "related")
        self.assertEqual(len(e), 1)
        self.assertEqual(e[0]["type"], "related")
        self.assertEqual(e[0]["why"], "the site is the project")

    def test_unknown_endpoint_fails(self):
        self.overlay({"note": "n", "edges": [
            {"s": "about", "t": "projects/nope", "why": "x"}]})
        with self.assertRaises(bwg.BuildError) as cm:
            self.build()
        self.assertIn("projects/nope", str(cm.exception))

    def test_missing_why_fails(self):
        self.overlay({"note": "n", "edges": [{"s": "about", "t": "projects/p-one"}]})
        with self.assertRaises(bwg.BuildError) as cm:
            self.build()
        self.assertIn("why", str(cm.exception))


# --------------------------------------------------------------------------
# summaries
# --------------------------------------------------------------------------
class TestSummaries(FixtureCase):
    def path(self):
        return self.root / "data/graph/summaries.json"

    def test_derived_excerpt_and_tagline_fallback(self):
        s = self.build()["summaries"]["pages"]
        self.assertEqual(s["setup/getting-started/deploy"]["summary"],
                         "Deploying the vehicle is the last step of a bring-up.")
        self.assertEqual(s["setup/getting-started/deploy"]["source"], "derived")
        # project body has prose -> excerpt wins over the tagline
        self.assertTrue(s["projects/p-one"]["summary"].startswith("Project One collects"))
        # tool body is bullets only -> tagline fallback
        self.assertEqual(s["tools/tool-one"]["summary"], "Tool tagline.")
        self.assertEqual(s["index:tools"]["summary"], "Tools intro.")

    def test_authored_preserved_derived_regenerated(self):
        write(self.path(), json.dumps({"note": "n", "pages": {
            "setup/getting-started/deploy": {"summary": "Hand written.",
                                             "source": "authored"},
            "about": {"summary": "stale derived text", "source": "derived"}}}))
        r = self.build()
        s = r["summaries"]["pages"]
        self.assertEqual(s["setup/getting-started/deploy"]["summary"], "Hand written.")
        self.assertEqual(s["setup/getting-started/deploy"]["source"], "authored")
        self.assertEqual(s["about"]["summary"], "A tiny fixture site used by the unit tests.")
        self.assertEqual(r["authored_ids"], ["setup/getting-started/deploy"])

    def test_unknown_authored_id_fails(self):
        write(self.path(), json.dumps({"note": "n", "pages": {
            "setup/getting-started/renamed": {"summary": "x", "source": "authored"}}}))
        with self.assertRaises(bwg.BuildError) as cm:
            self.build()
        msg = str(cm.exception)
        self.assertIn("setup/getting-started/renamed", msg)
        self.assertIn("rst_convert.py", msg)

    def test_empty_summary_exit_codes(self):
        write(self.root / "content/setup/getting-started/deploy.md",
              "# Deploy\n\n- only a bullet\n")
        buf = io.StringIO()
        with redirect_stdout(buf), redirect_stderr(buf):
            rc = bwg.main([], root=self.root)
        self.assertEqual(rc, 1)
        self.assertIn("setup/getting-started/deploy", buf.getvalue())
        buf = io.StringIO()
        with redirect_stdout(buf), redirect_stderr(buf):
            rc = bwg.main(["--allow-empty-summaries"], root=self.root)
        self.assertEqual(rc, 0)
        doc = json.loads(self.path().read_text())
        self.assertEqual(doc["pages"]["setup/getting-started/deploy"]["summary"], "")


# --------------------------------------------------------------------------
# xref terms
# --------------------------------------------------------------------------
class TestXref(FixtureCase):
    def test_terms_resolve_and_stoplist_applied(self):
        x = self.build()["xref"]
        self.assertEqual(x["terms"]["Install ROS 2"], "setup/getting-started/install")
        self.assertEqual(x["terms"]["gantry"], "repo:gantry")
        self.assertNotIn("Deploy", x["terms"])
        node_ids = {n["id"] for n in self.build()["graph"]["nodes"]}
        for term, target in x["terms"].items():
            self.assertIn(target, node_ids, term)

    def test_prefix_with_different_target_is_kept(self):
        x = self.build()["xref"]
        self.assertIn("hippo_control", x["terms"])
        self.assertIn("hippo_control_msgs", x["terms"])

    def test_rejected_preserved_and_never_readded(self):
        write(self.root / "data/graph/xref-terms.json", json.dumps(
            {"note": "n", "stoplist": [], "terms": {}, "rejected": ["gantry"]}))
        x = self.build()["xref"]
        self.assertEqual(x["rejected"], ["gantry"])
        self.assertNotIn("gantry", x["terms"])

    def test_min_length_rule_with_exceptions(self):
        prose = {"p1": "SSH a_b myVar Marker"}
        cands = [("SSH", "about", True), ("a_b", "about", True),
                 ("myVar", "about", True), ("Marker", "about", False)]
        kept, dropped = bwg.filter_candidates(cands, prose, set(), set())
        terms = {r["term"] for r in kept}
        self.assertEqual(terms, {"a_b", "myVar", "Marker"})
        self.assertIn(("SSH", "shorter than 6 characters"), [(t, why) for t, why, _ in dropped])

    def test_more_than_15_pages_dropped(self):
        prose = {f"p{i}": "widgets everywhere" for i in range(16)}
        cands = [("widgets", "about", False)]
        kept, dropped = bwg.filter_candidates(cands, prose, set(), set())
        self.assertEqual(kept, [])
        self.assertEqual(len(prose), 16)
        prose15 = {f"p{i}": "widgets everywhere" for i in range(15)}
        kept, _ = bwg.filter_candidates(cands, prose15, set(), set())
        self.assertEqual(len(kept), 1)
        self.assertEqual(len(kept[0]["pages"]), 15)

    def test_prefix_same_target_deduped(self):
        prose = {"p1": "Gantry and Gantry usage"}
        cands = [("Gantry", "setup/x", False), ("Gantry usage", "setup/x", False)]
        kept, dropped = bwg.filter_candidates(cands, prose, set(), set())
        self.assertEqual([r["term"] for r in kept], ["Gantry usage"])

    def test_case_collision_keeps_the_page(self):
        prose = {"p1": "Gantry and gantry"}
        cands = [("Gantry", "setup/hardware/gantry", False),
                 ("gantry", "repo:gantry", True)]
        kept, dropped = bwg.filter_candidates(cands, prose, set(), set())
        self.assertEqual([r["term"] for r in kept], ["Gantry"])
        self.assertTrue(any("case-insensitive duplicate" in why for _, why, _ in dropped))

    def test_ambiguous_term_dropped(self):
        prose = {"p1": "Cameras"}
        cands = [("Cameras", "setup/a", False), ("Cameras", "projects/b", False)]
        kept, dropped = bwg.filter_candidates(cands, prose, set(), set())
        self.assertEqual(kept, [])
        self.assertTrue(any("ambiguous" in why for _, why, _ in dropped))

    def test_candidate_report_lists_pages(self):
        rows = self.build()["candidates"]
        by_term = {r["term"]: r for r in rows}
        self.assertIn("setup/getting-started/install", by_term["gantry"]["pages"])


# --------------------------------------------------------------------------
# determinism + writes
# --------------------------------------------------------------------------
class TestOutputs(FixtureCase):
    def test_two_runs_identical_bytes(self):
        buf = io.StringIO()
        with redirect_stdout(buf), redirect_stderr(buf):
            self.assertEqual(bwg.main(["--allow-empty-summaries"], root=self.root), 0)
        first = {p: (self.root / "data/graph" / p).read_bytes()
                 for p in ("wiki.json", "summaries.json", "xref-terms.json")}
        with redirect_stdout(buf), redirect_stderr(buf):
            self.assertEqual(bwg.main(["--allow-empty-summaries"], root=self.root), 0)
        second = {p: (self.root / "data/graph" / p).read_bytes()
                  for p in ("wiki.json", "summaries.json", "xref-terms.json")}
        self.assertEqual(first, second)
        self.assertTrue(first["wiki.json"].endswith(b"\n"))

    def test_dry_run_writes_nothing(self):
        buf = io.StringIO()
        with redirect_stdout(buf), redirect_stderr(buf):
            self.assertEqual(bwg.main(["--dry-run", "--allow-empty-summaries"],
                                      root=self.root), 0)
        self.assertFalse((self.root / "data/graph/wiki.json").exists())

    def test_xref_candidates_prints_table_and_writes_nothing(self):
        buf = io.StringIO()
        with redirect_stdout(buf), redirect_stderr(io.StringIO()):
            self.assertEqual(bwg.main(["--xref-candidates"], root=self.root), 0)
        self.assertIn("gantry", buf.getvalue())
        self.assertIn("repo:gantry", buf.getvalue())
        self.assertFalse((self.root / "data/graph/xref-terms.json").exists())

    def test_edges_sorted_and_unique(self):
        g = self.build()["graph"]
        keys = [(e["type"], e["s"], e["t"]) for e in g["edges"]]
        self.assertEqual(keys, sorted(keys))
        self.assertEqual(len(keys), len(set(keys)))
        counts = g["counts"]["edges"]
        for t in ("links-to", "member", "mentions", "related"):
            self.assertEqual(counts[t], len([k for k in keys if k[0] == t]))

    def test_every_edge_endpoint_is_a_node(self):
        g = self.build()["graph"]
        ids = {n["id"] for n in g["nodes"]}
        for e in g["edges"]:
            self.assertIn(e["s"], ids)
            self.assertIn(e["t"], ids)


# --------------------------------------------------------------------------
# the excerpt() hoist in tools/build_search_index.py
# --------------------------------------------------------------------------
class TestExcerptHoist(unittest.TestCase):
    def test_excerpt_is_module_level_and_importable(self):
        self.assertTrue(callable(getattr(bsi, "excerpt", None)))
        self.assertEqual(bsi.excerpt("# Title\n\nHello [there](http://x).\n"),
                         "Hello there.")
        self.assertEqual(bsi.excerpt("# Title\n\n- bullet\n"), "")

    def test_build_site_shard_no_longer_nests_it(self):
        import inspect
        src = inspect.getsource(bsi.build_site_shard)
        self.assertNotIn("def excerpt", src)

    def test_wiki_graph_reuses_the_same_function(self):
        self.assertIs(bwg.excerpt, bsi.excerpt)


class TestHygiene(unittest.TestCase):
    def test_no_third_party_imports(self):
        src = Path(bwg.__file__).read_text(encoding="utf-8")
        for i, line in enumerate(src.splitlines(), 1):
            s = line.strip()
            if s.startswith(("import graphify", "from graphify")):
                self.fail(f"graphify import at line {i}: {s!r}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
