#!/usr/bin/env python3
"""Unit tests for the PURE half of tools/build_repo_graphs.py.

Run from the repo root with plain python3 (no pytest, no graphify, no network):

    python3 tools/tests/test_build_repo_graphs.py

Everything under test here is deterministic and dependency-free: the one-liner
resolution chain, the raw-graph -> shard condensation, the shard size cap, the
stub shards for the known code-less repos, the abort-on-unexpected-empty guard,
and the repos-index rows. The clone/extract/cluster half needs graphify's
interpreter and is exercised by the real run, not by these tests.
"""
import io
import json
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import build_repo_graphs as brg  # noqa: E402


# --------------------------------------------------------------------------
# fixtures
# --------------------------------------------------------------------------
def org_row(name, description="", lang="Python", fork=False):
    return {
        "name": name,
        "url": f"https://github.com/HippoCampusRobotics/{name}",
        "description": description,
        "isFork": fork,
        "isArchived": False,
        "primaryLanguage": {"name": lang} if lang else None,
        "pushedAt": "2024-01-02T03:04:05Z",
    }


def node(nid, label, source_file, callable_=False, callable_class=False, community=0):
    n = {"id": nid, "label": label, "source_file": source_file,
         "source_location": "L1", "community": community}
    if callable_:
        n["_callable"] = True
    if callable_class:
        n["_callable"] = True
        n["_callable_class"] = True
    return n


def link(a, b):
    return {"source": a, "target": b, "relation": "calls"}


def raw_graph():
    """A small graph.json-shaped fixture.

    Community 0 lives in src/alpha.py, community 1 in src/beta.py.
    Degrees are engineered so the ranking is checkable by hand:
      Alpha(class)   6   src/alpha.py
      run()          4   src/alpha.py
      Beta(class)    4   src/beta.py   <- ties with run(), loses on name
      helper()       2   src/alpha.py
      alpha.py       5   (file node, excluded)
      lonely()       1   (isolated function stub, excluded)
      .method()      3   (method stub, excluded)
      json "name"    3   (json-key noise, excluded)
      str            3   (builtin noise label, excluded)
    """
    nodes = [
        node("n_alpha_cls", "Alpha", "src/alpha.py", callable_class=True),
        node("n_alpha_run", "run()", "src/alpha.py", callable_=True),
        node("n_alpha_helper", "helper()", "src/alpha.py", callable_=True),
        node("n_alpha_file", "alpha.py", "src/alpha.py"),
        node("n_alpha_lonely", "lonely()", "src/alpha.py", callable_=True),
        node("n_alpha_method", ".method()", "src/alpha.py", callable_=True),
        node("n_beta_cls", "Beta", "src/beta.py", callable_class=True, community=1),
        node("n_beta_util", "util()", "src/beta.py", callable_=True, community=1),
        node("n_json_key", "name", "package.json", community=1),
        node("n_builtin", "str", "src/beta.py", community=1),
        node("n_concept", "Idea", "", community=1),
    ]
    links = []

    def wire(nid, times, other="n_pad"):
        for i in range(times):
            links.append(link(nid, f"{other}{i}"))

    wire("n_alpha_cls", 6)
    wire("n_alpha_run", 4)
    wire("n_alpha_helper", 2)
    wire("n_alpha_file", 5)
    wire("n_alpha_lonely", 1)
    wire("n_alpha_method", 3)
    wire("n_beta_cls", 4)
    wire("n_beta_util", 2)
    wire("n_json_key", 3)
    wire("n_builtin", 3)
    wire("n_concept", 3)
    return {"nodes": nodes, "links": links}


META = {"repo": "demo", "url": "https://github.com/HippoCampusRobotics/demo",
        "description": "demo one-liner", "language": "Python",
        "pushedAt": "2024-01-02T03:04:05Z"}


# --------------------------------------------------------------------------
# one-liner resolution chain
# --------------------------------------------------------------------------
class TestOneLiner(unittest.TestCase):
    def test_role_wins(self):
        row = org_row("hardware", description="org blurb")
        self.assertEqual(brg.resolve_oneliner(row, "ROS 2 hardware bring-up"),
                         "ROS 2 hardware bring-up")

    def test_description_when_role_empty(self):
        row = org_row("px4_msgs", description="ROS 2 messages for PX4")
        self.assertEqual(brg.resolve_oneliner(row, ""), "ROS 2 messages for PX4")
        self.assertEqual(brg.resolve_oneliner(row, None), "ROS 2 messages for PX4")
        self.assertEqual(brg.resolve_oneliner(row, "   "), "ROS 2 messages for PX4")

    def test_language_fallback_when_both_empty(self):
        row = org_row("docs", description="", lang="Python")
        self.assertEqual(brg.resolve_oneliner(row, ""), "Python repo")
        row_cpp = org_row("esc", description="  ", lang="C++")
        self.assertEqual(brg.resolve_oneliner(row_cpp, None), "C++ repo")

    def test_bare_repo_when_language_null(self):
        row = org_row("hippocampus_pcbs", description="", lang=None)
        self.assertEqual(brg.resolve_oneliner(row, ""), "repo")

    def test_never_empty_for_the_real_data_shapes(self):
        # every combination the two registries can produce must yield text
        for desc in ("", "   ", "a blurb"):
            for lang in (None, "Python"):
                for role in (None, "", "   ", "a role"):
                    out = brg.resolve_oneliner(org_row("x", desc, lang), role)
                    self.assertTrue(out.strip(), (desc, lang, role))

    def test_whitespace_is_trimmed(self):
        row = org_row("x", description="  padded blurb  ", lang="Python")
        self.assertEqual(brg.resolve_oneliner(row, "  padded role  "), "padded role")
        self.assertEqual(brg.resolve_oneliner(row, ""), "padded blurb")


# --------------------------------------------------------------------------
# condensation
# --------------------------------------------------------------------------
class TestCondense(unittest.TestCase):
    def setUp(self):
        self.shard = brg.condense(raw_graph(), META)

    def test_schema_keys_and_order(self):
        self.assertEqual(list(self.shard.keys()),
                         ["repo", "url", "description", "language", "pushedAt",
                          "counts", "god_nodes", "communities"])
        self.assertEqual(self.shard["repo"], "demo")
        self.assertEqual(self.shard["language"], "Python")
        self.assertEqual(self.shard["description"], "demo one-liner")
        self.assertEqual(sorted(self.shard["counts"]), ["communities", "edges", "nodes"])

    def test_counts(self):
        raw = raw_graph()
        self.assertEqual(self.shard["counts"]["nodes"], len(raw["nodes"]))
        self.assertEqual(self.shard["counts"]["edges"], len(raw["links"]))
        self.assertEqual(self.shard["counts"]["communities"], 2)

    def test_edges_key_alias_is_accepted(self):
        raw = raw_graph()
        raw["edges"] = raw.pop("links")
        alt = brg.condense(raw, META)
        self.assertEqual(alt["counts"]["edges"], self.shard["counts"]["edges"])
        self.assertEqual(alt["god_nodes"], self.shard["god_nodes"])

    def test_god_nodes_ranking_and_exclusions(self):
        names = [g["name"] for g in self.shard["god_nodes"]]
        # file node, method stub, isolated fn stub, json-key noise and builtin
        # noise are all excluded; the rest rank by degree.
        self.assertEqual(names, ["Alpha", "Beta", "run", "helper", "util"])
        self.assertNotIn("alpha.py", names)
        self.assertNotIn("method", names)
        self.assertNotIn("lonely", names)
        self.assertNotIn("name", names)
        self.assertNotIn("str", names)
        self.assertNotIn("Idea", names)

    def test_god_node_row_shape(self):
        top = self.shard["god_nodes"][0]
        self.assertEqual(sorted(top), ["degree", "kind", "name", "path"])
        self.assertEqual(top, {"name": "Alpha", "kind": "class",
                               "path": "src/alpha.py", "degree": 6})
        kinds = {g["name"]: g["kind"] for g in self.shard["god_nodes"]}
        self.assertEqual(kinds["run"], "fn")
        self.assertEqual(kinds["Beta"], "class")

    def test_god_node_tie_break_is_name_then_path(self):
        # Beta and run() both have degree 4; "Beta" sorts before "run"
        rows = [(g["name"], g["degree"]) for g in self.shard["god_nodes"]]
        self.assertEqual(rows[1], ("Beta", 4))
        self.assertEqual(rows[2], ("run", 4))

    def test_god_nodes_capped_at_ten(self):
        raw = {"nodes": [], "links": []}
        for i in range(25):
            nid = f"n{i}"
            raw["nodes"].append(node(nid, f"Sym{i:02d}", "src/big.py", callable_class=True))
            for j in range(30 - i):
                raw["links"].append(link(nid, f"pad{i}_{j}"))
        got = brg.condense(raw, META)["god_nodes"]
        self.assertEqual(len(got), brg.GOD_NODE_TOP)
        self.assertEqual([g["name"] for g in got],
                         [f"Sym{i:02d}" for i in range(brg.GOD_NODE_TOP)])

    def test_deterministic_across_input_order(self):
        raw = raw_graph()
        shuffled = {"nodes": list(reversed(raw["nodes"])),
                    "links": list(reversed(raw["links"]))}
        self.assertEqual(brg.compact_dump(brg.condense(shuffled, META)),
                         brg.compact_dump(self.shard))

    def test_only_the_supplied_timestamp_appears(self):
        # no "generated at now" field may leak into a committed shard
        blob = brg.compact_dump(self.shard)
        self.assertEqual(blob.count("2024-01-02T03:04:05Z"), 1)
        self.assertEqual(self.shard["pushedAt"], META["pushedAt"])
        # a second condensation of the same input is byte-identical
        self.assertEqual(brg.compact_dump(brg.condense(raw_graph(), META)), blob)


class TestCommunities(unittest.TestCase):
    def setUp(self):
        self.shard = brg.condense(raw_graph(), META)

    def test_label_is_dominant_path_stem(self):
        labels = [c["label"] for c in self.shard["communities"]]
        self.assertEqual(sorted(labels), ["src/alpha", "src/beta"])

    def test_row_shape_and_size(self):
        by_label = {c["label"]: c for c in self.shard["communities"]}
        alpha = by_label["src/alpha"]
        self.assertEqual(sorted(alpha), ["label", "size", "top"])
        self.assertEqual(alpha["size"], 6)
        # members ordered by degree desc, names normalised (".method()" -> "method")
        self.assertEqual(alpha["top"],
                         ["Alpha", "alpha.py", "run", "method", "helper", "lonely"])
        # ties inside a community break on the normalised name
        self.assertEqual(by_label["src/beta"]["top"],
                         ["Beta", "Idea", "name", "str", "util"])

    def test_sorted_by_size_desc(self):
        sizes = [c["size"] for c in self.shard["communities"]]
        self.assertEqual(sizes, sorted(sizes, reverse=True))

    def test_top_six_communities_only(self):
        raw = {"nodes": [], "links": []}
        for cid in range(12):
            for k in range(cid + 1):
                nid = f"c{cid}_n{k}"
                raw["nodes"].append(
                    node(nid, f"Sym{cid}_{k}", f"pkg/mod{cid:02d}/file.py",
                         callable_class=True, community=cid))
                raw["links"].append(link(nid, f"pad{cid}_{k}"))
        got = brg.condense(raw, META)
        self.assertEqual(got["counts"]["communities"], 12)
        self.assertEqual(len(got["communities"]), brg.COMMUNITY_TOP)
        self.assertEqual([c["size"] for c in got["communities"]], [12, 11, 10, 9, 8, 7])
        self.assertEqual(got["communities"][0]["label"], "pkg/mod11/file")

    def test_members_capped(self):
        raw = {"nodes": [], "links": []}
        for k in range(40):
            nid = f"n{k}"
            raw["nodes"].append(node(nid, f"Sym{k:02d}", "pkg/mod.py", callable_class=True))
            raw["links"].append(link(nid, f"pad{k}"))
        got = brg.condense(raw, META)["communities"][0]
        self.assertEqual(got["size"], 40)
        self.assertEqual(len(got["top"]), brg.COMMUNITY_MEMBERS_TOP)

    def test_label_falls_back_when_no_source_files(self):
        raw = {"nodes": [node("a", "Thing", "", community=3),
                         node("b", "Other", "", community=3)],
               "links": [link("a", "b")]}
        got = brg.condense(raw, META)
        self.assertEqual(got["communities"][0]["label"], "community-3")

    def test_label_tie_breaks_lexicographically(self):
        raw = {"nodes": [node("a", "A", "src/zulu.py"),
                         node("b", "B", "src/alpha.py")],
               "links": [link("a", "b")]}
        got = brg.condense(raw, META)
        self.assertEqual(got["communities"][0]["label"], "src/alpha")

    def test_nodes_without_a_community_are_skipped(self):
        raw = raw_graph()
        for n in raw["nodes"]:
            n["community"] = None
        got = brg.condense(raw, META)
        self.assertEqual(got["counts"]["communities"], 0)
        self.assertEqual(got["communities"], [])
        self.assertTrue(got["god_nodes"])  # ranking does not depend on communities


# --------------------------------------------------------------------------
# 20 KB cap
# --------------------------------------------------------------------------
def fat_shard(n_communities, label_len=60, members=8, member_len=60):
    return {
        "repo": "fat", "url": "https://example.invalid/fat",
        "description": "fat repo", "language": "C++",
        "pushedAt": "2024-01-02T03:04:05Z",
        "counts": {"nodes": 9999, "edges": 9999, "communities": n_communities},
        "god_nodes": [{"name": f"God{i:02d}", "kind": "class",
                       "path": f"src/pkg/file{i:02d}.cpp", "degree": 100 - i}
                      for i in range(10)],
        "communities": [
            {"label": ("m%02d" % i) + "x" * (label_len - 3),
             "size": n_communities - i,
             "top": [("s%02d_%02d" % (i, j)) + "y" * (member_len - 6)
                     for j in range(members)]}
            for i in range(n_communities)],
    }


class TestCap(unittest.TestCase):
    def test_under_cap_is_untouched(self):
        shard = brg.condense(raw_graph(), META)
        buf = io.StringIO()
        with redirect_stdout(buf):
            out = brg.cap_shard("demo", shard)
        self.assertEqual(out, shard)
        self.assertEqual(buf.getvalue(), "")

    def test_members_dropped_first_and_loudly(self):
        shard = fat_shard(60)
        self.assertGreater(len(brg.compact_dump(shard).encode()), brg.MAX_SHARD_BYTES)
        buf = io.StringIO()
        with redirect_stdout(buf):
            out = brg.cap_shard("fat", shard)
        self.assertLessEqual(len(brg.compact_dump(out).encode()), brg.MAX_SHARD_BYTES)
        # members gone, communities kept
        self.assertEqual(len(out["communities"]), 60)
        self.assertTrue(all(c["top"] == [] for c in out["communities"]))
        noise = buf.getvalue()
        self.assertIn("fat", noise)
        self.assertIn("dropped", noise.lower())
        self.assertIn("member", noise.lower())

    def test_communities_dropped_second_and_loudly(self):
        shard = fat_shard(400)
        buf = io.StringIO()
        with redirect_stdout(buf):
            out = brg.cap_shard("fat", shard)
        self.assertLessEqual(len(brg.compact_dump(out).encode()), brg.MAX_SHARD_BYTES)
        self.assertLess(len(out["communities"]), 400)
        self.assertGreater(len(out["communities"]), 0)
        noise = buf.getvalue()
        self.assertIn("communit", noise.lower())
        # smallest communities go first: the largest survivor is still first
        sizes = [c["size"] for c in out["communities"]]
        self.assertEqual(sizes, sorted(sizes, reverse=True))
        self.assertEqual(sizes[0], 400)

    def test_god_nodes_never_dropped(self):
        shard = fat_shard(400)
        before = list(shard["god_nodes"])
        buf = io.StringIO()
        with redirect_stdout(buf):
            out = brg.cap_shard("fat", shard)
        self.assertEqual(out["god_nodes"], before)

    def test_cap_is_twenty_kib(self):
        self.assertEqual(brg.MAX_SHARD_BYTES, 20 * 1024)


# --------------------------------------------------------------------------
# stubs and the abort guard
# --------------------------------------------------------------------------
class TestStubs(unittest.TestCase):
    def test_the_seven_known_empty_repos(self):
        self.assertEqual(sorted(brg.KNOWN_EMPTY_REPOS), [
            "apriltags", "hippo_infrastructure", "hippo_robot",
            "hippocampus_msgs", "hippocampus_pcbs", "scalar_field_interfaces",
            "sdr_msgs"])

    def test_stub_shape(self):
        meta = dict(META, repo="hippocampus_msgs", description="ROS 2 message package",
                    language=None)
        shard = brg.stub_shard(meta)
        self.assertEqual(list(shard.keys()),
                         ["repo", "url", "description", "language", "pushedAt",
                          "counts", "god_nodes", "communities", "stub", "reason"])
        self.assertEqual(shard["counts"], {"nodes": 0, "edges": 0, "communities": 0})
        self.assertEqual(shard["god_nodes"], [])
        self.assertEqual(shard["communities"], [])
        self.assertIs(shard["stub"], True)
        self.assertEqual(shard["reason"], "no code files (AST-empty by inspection)")
        self.assertEqual(shard["description"], "ROS 2 message package")
        self.assertIsNone(shard["language"])

    def test_stub_is_under_cap(self):
        shard = brg.stub_shard(dict(META, repo="apriltags"))
        self.assertLessEqual(len(brg.compact_dump(shard).encode()), brg.MAX_SHARD_BYTES)


class TestAbortGuard(unittest.TestCase):
    def test_known_empty_repo_is_allowed_to_be_empty(self):
        self.assertIsNone(brg.check_node_count("sdr_msgs", 0))

    def test_unexpected_empty_aborts_loudly(self):
        with self.assertRaises(brg.ExtractionAbort) as cm:
            brg.check_node_count("esc", 0)
        msg = str(cm.exception)
        self.assertIn("esc", msg)
        self.assertIn("0 nodes", msg)

    def test_non_empty_passes(self):
        self.assertIsNone(brg.check_node_count("esc", 1))
        self.assertIsNone(brg.check_node_count("hippocampus_msgs", 42))

    def test_extraction_failure_is_wrapped_with_the_repo_name(self):
        err = brg.extraction_failure("mjpeg_cam", ValueError("tree-sitter blew up"))
        self.assertIsInstance(err, brg.ExtractionAbort)
        self.assertIn("mjpeg_cam", str(err))
        self.assertIn("tree-sitter blew up", str(err))


# --------------------------------------------------------------------------
# repos-index rows
# --------------------------------------------------------------------------
class TestIndexRows(unittest.TestCase):
    def setUp(self):
        self.org = [
            org_row("hardware", description="", lang="Python"),
            org_row("apriltags", description="", lang=None),
            org_row("px4_msgs", description="uORB message mirrors", lang="CMake",
                    fork=True),
            org_row("mu_auv_localization", description="", lang="Python", fork=True),
            org_row("orphan", description="", lang="C++"),
        ]
        self.projects = {"projects": [
            {"id": "vehicle", "repos": [
                {"name": "hardware", "role": "ROS 2 hardware bring-up"},
                {"name": "apriltags", "role": "AprilTag assets"},
                {"name": "px4_msgs", "role": "fork used by the stack", "fork": True},
                {"name": "outside", "role": "external thing", "external": True},
            ]},
        ]}
        self.shards = {
            "hardware": {"god_nodes": [{"name": "Bridge"}, {"name": "Node"}],
                         "counts": {"nodes": 10}},
            "apriltags": {"god_nodes": [], "stub": True},
        }
        self.rows = brg.build_index_rows(self.org, self.projects, self.shards)

    def test_one_row_per_org_repo_sorted_by_name(self):
        names = [r["name"] for r in self.rows]
        self.assertEqual(names, sorted(names))
        self.assertEqual(len(names), len(self.org))

    def test_row_shape(self):
        row = next(r for r in self.rows if r["name"] == "hardware")
        self.assertEqual(list(row.keys()),
                         ["name", "kind", "fork", "oneliner", "project", "god_nodes"])
        self.assertEqual(row["kind"], "repo")
        self.assertIs(row["fork"], False)
        self.assertEqual(row["oneliner"], "ROS 2 hardware bring-up")
        self.assertEqual(row["project"], "vehicle")
        self.assertEqual(row["god_nodes"], ["Bridge", "Node"])

    def test_forks_keep_project_ownership_but_get_no_god_nodes(self):
        # Every fork belongs to exactly one project (the coverage rule); the
        # wiki graph's member edges need that ownership for forks too. Only the
        # role-based one-liner and god nodes are non-fork-only.
        fork = next(r for r in self.rows if r["name"] == "px4_msgs")
        self.assertIs(fork["fork"], True)
        self.assertEqual(fork["project"], "vehicle")
        self.assertEqual(fork["god_nodes"], [])
        self.assertEqual(fork["oneliner"], "uORB message mirrors")

    def test_fork_oneliner_skips_role_and_falls_back_to_language(self):
        fork = next(r for r in self.rows if r["name"] == "mu_auv_localization")
        self.assertEqual(fork["oneliner"], "Python repo")

    def test_stub_repo_has_empty_god_nodes_but_keeps_its_project(self):
        row = next(r for r in self.rows if r["name"] == "apriltags")
        self.assertEqual(row["god_nodes"], [])
        self.assertEqual(row["project"], "vehicle")
        self.assertEqual(row["oneliner"], "AprilTag assets")

    def test_repo_in_no_project_gets_null_project_and_a_fallback_oneliner(self):
        row = next(r for r in self.rows if r["name"] == "orphan")
        self.assertIsNone(row["project"])
        self.assertEqual(row["oneliner"], "C++ repo")

    def test_no_empty_oneliner_anywhere(self):
        for r in self.rows:
            self.assertTrue(r["oneliner"].strip(), r["name"])

    def test_index_document_shape(self):
        doc = brg.build_index(self.org, self.projects, self.shards)
        self.assertEqual(list(doc.keys()), ["generated", "repos"])
        self.assertEqual(doc["generated"],
                         "run tools/build_repo_graphs.py to regenerate")
        self.assertEqual(doc["repos"], self.rows)


# --------------------------------------------------------------------------
# hygiene: the pure half must import without graphify
# --------------------------------------------------------------------------
class TestModuleHygiene(unittest.TestCase):
    def test_no_module_level_graphify_import(self):
        src = (Path(brg.__file__)).read_text(encoding="utf-8")
        for i, line in enumerate(src.splitlines(), 1):
            if line.startswith(("import graphify", "from graphify")):
                self.fail(f"module-level graphify import at line {i}: {line!r}")

    def test_compact_dump_is_compact_and_utf8_clean(self):
        self.assertEqual(brg.compact_dump({"a": 1, "b": ["x", "ü"]}),
                         '{"a":1,"b":["x","ü"]}')

    def test_shard_round_trips_as_json(self):
        shard = brg.condense(raw_graph(), META)
        self.assertEqual(json.loads(brg.compact_dump(shard)), shard)


if __name__ == "__main__":
    unittest.main(verbosity=2)
