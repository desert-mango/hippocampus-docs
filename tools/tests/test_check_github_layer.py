#!/usr/bin/env python3
# Author: Kyle Nelson
# Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
# Last substantive modification: 29 September 2026
# Affiliation: TUHH HippoCampus Robotics
# Purpose: Test gate section 11 (the public GitHub-layer shapes), the github-links block and the index.html shell rule.
"""Unit tests for section 11 of the check gate and the rules module it shares
with the GitHub-data builder (tools/github_layer_rules.py).

Run from the repo root with plain python3 (no pytest, no network):

    python3 tools/tests/test_check_github_layer.py

The rule functions are pure and are proven red/green on in-memory documents.
Two end-to-end tests copy the repository into a temporary directory, make it
a throwaway git repository (the attribution-header check reads tracked
files), mutate it, and run the real tools/check.py there: one proves a
members-only key smuggled into a public file turns the gate red, the other
that a PR-shaped tree (a renamed roster person, a deleted setup page, a
dropped repository) stays GREEN while the GitHub files are stale — those are
notes, never errors.
"""
import copy
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import check  # noqa: E402
import github_layer_rules as rules  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent.parent
PNG = rules.PNG_MAGIC + b"\x00" * 64
JPG = rules.JPEG_MAGIC + b"\xe0" + b"\x00" * 64
BLOB = "0123456789abcdef0123456789abcdef01234567"


def valid_docs():
    """A minimal, fully valid set of the four files."""
    return {
        "org-activity": {
            "generated": "run tools/build_github_data.py to regenerate",
            "read_at": "2026-09-29", "org": "HippoCampusRobotics", "window_days": 365,
            "totals": {"public_repos": 3, "commits_365d": 2, "authors_365d": 1,
                       "repos_touched_365d": 1, "stars": 4, "forks": 1,
                       "open_issues": 0, "releases": 1},
            "weeks": [{"week": "2026-09-28", "days": [1, 1, None, None, None, None, None]}],
            "recent_commits": [{"repo": "docs", "sha": "abcdef0", "date": "2026-09-29",
                                "msg": "Add a page"}],
            "most_active_repos": [{"name": "docs", "commits": 2, "language": "Python",
                                   "pushed_at": "2026-09-29"}],
            "releases": [{"repo": "docs", "tag": "v1", "name": "One", "date": "2026-09-01"}],
            "truncated": [],
        },
        "github-repos": {
            "generated": "g", "read_at": "2026-09-29", "org": "HippoCampusRobotics",
            "repos": {"docs": {"name": "docs", "description": "Radio (@433 MHz)",
                               "language": "Python", "stars": 2, "forks": 0,
                               "open_issues": 0, "pushed_at": "2026-09-17",
                               "archived": False, "fork": False, "private": False,
                               "commits_365d": 2,
                               "html_url": "https://github.com/HippoCampusRobotics/docs"}},
        },
        "page-authors": {
            "generated": "g", "read_at": "2026-09-29", "note": "n", "prs_read": [2, 3],
            "pages": {
                "setup/raspberry-pi/ethernet": {
                    "original": {"repo": rules.OLD_DOCS_REPO,
                                 "path": "contents/raspberry_pi_setup/ethernet.rst",
                                 "authors": [{"login": "NBauschmann", "name": "Nathalie Bauschmann"},
                                             {"login": None, "name": "nat"}],
                                 "history_read": True, "blob": None},
                    "converted": {"date": "2026-08-28", "by": "kyle-nelson-berkeley",
                                  "tool": "tools/rst_convert.py", "commit": "b40ade4"},
                    "edited_here": [{"pr": 1, "by": "kyle-nelson-berkeley", "state": "open"}]},
                "about": {
                    "original": {"repo": rules.THIS_REPO, "path": "content/about.md",
                                 "authors": [], "history_read": True, "blob": BLOB},
                    "converted": None, "edited_here": []},
            },
        },
        "people-public": {
            "generated": "g", "read_at": "2026-09-29", "org": "HippoCampusRobotics",
            "note": "n",
            "people": {"NBauschmann": {"login": "NBauschmann", "name": "Nathalie Bauschmann",
                                       "avatar": "data/graph/avatars/NBauschmann.png",
                                       "html_url": "https://github.com/NBauschmann",
                                       "roster": "Nathalie Bauschmann"},
                       "someone": {"login": "someone", "name": "Some One", "avatar": None,
                                   "html_url": "https://github.com/someone", "roster": None}},
        },
    }


def avatars(files=None):
    files = {"data/graph/avatars/NBauschmann.png": PNG} if files is None else files
    return files.get


class SharedPatterns(unittest.TestCase):
    def test_check_uses_the_one_copy(self):
        for name in ("EMAIL_RE", "EMAIL_OK", "EVENT_ATTR_RE", "scan_markup",
                     "unsafe_scheme", "UNSAFE_TAG_RE", "SRCDOC_RE", "LINK_TARGET_RES"):
            with self.subTest(name=name):
                self.assertIs(getattr(check, name), getattr(rules, name))

    def test_check_py_defines_none_of_them_itself(self):
        src = (ROOT / "tools" / "check.py").read_text(encoding="utf-8")
        for name in ("EMAIL_RE", "EMAIL_OK", "EVENT_ATTR_RE"):
            self.assertIsNone(re.search(rf"^{name}\s*=", src, re.M), name)
        self.assertIsNone(re.search(r"^def scan_markup\(", src, re.M))


class Redact(unittest.TestCase):
    def test_email_and_trailer(self):
        out, why = rules.redact("Fix it Signed-off-by: x <a@b.invalid>")
        self.assertEqual(out, "Fix it Signed-off-by: x [redacted]")
        self.assertTrue(why)
        self.assertFalse(rules.EMAIL_RE.search(out))

    def test_event_attr_shapes(self):
        out, why = rules.redact("Bump onnx==1.17")
        self.assertEqual(out, "Bump [redacted]==1.17")
        self.assertEqual(rules.scan_markup(out), [])
        out, _ = rules.redact("keeps the robot online = true")
        self.assertEqual(rules.scan_markup(out), [])
        self.assertIn("[redacted]", out)

    def test_angle_brackets_stripped_silently(self):
        out, why = rules.redact("<img src=x onerror=alert(1)>")
        self.assertNotIn("<", out)
        self.assertNotIn(">", out)
        self.assertEqual(rules.scan_markup(out), [])

    def test_script_link_redacts_the_whole_string(self):
        out, why = rules.redact("see [x](javascript:alert(1))")
        self.assertEqual(out, "[redacted]")

    def test_433_mhz_passes_untouched(self):
        self.assertEqual(rules.redact("Radio Frequency based localization (@433 MHz)"),
                         ("Radio Frequency based localization (@433 MHz)", []))


class Section11Hard(unittest.TestCase):
    def run_rules(self, docs, files=None):
        return rules.check_github_layer(docs, avatars(files))

    def test_valid_set_is_green(self):
        self.assertEqual(self.run_rules(valid_docs()), [])

    def test_absent_files_are_fine(self):
        self.assertEqual(rules.check_github_layer({}, avatars({})), [])

    def test_members_only_key_in_a_person_is_red(self):
        docs = valid_docs()
        docs["people-public"]["people"]["someone"]["commits_365d"] = 12
        out = self.run_rules(docs)
        self.assertEqual(len(out), 1, out)
        self.assertIn("commits_365d", out[0])
        self.assertIn("not public", out[0])

    def test_author_on_a_recent_commit_is_red(self):
        docs = valid_docs()
        docs["org-activity"]["recent_commits"][0]["login"] = "NBauschmann"
        self.assertTrue(any("recent_commits" in m and "login" in m
                            for m in self.run_rules(docs)))

    def test_per_person_top_authors_list_is_red(self):
        docs = valid_docs()
        docs["org-activity"]["top_authors_365d"] = [{"login": "x", "commits": 3}]
        self.assertTrue(any("top_authors_365d" in m for m in self.run_rules(docs)))

    def test_profile_key_is_red(self):
        docs = valid_docs()
        docs["people-public"]["people"]["someone"]["email"] = None
        out = self.run_rules(docs)
        self.assertTrue(any("profile field" in m and "email" in m for m in out), out)

    def test_page_author_counts_are_red(self):
        docs = valid_docs()
        page = docs["page-authors"]["pages"]["setup/raspberry-pi/ethernet"]
        page["original"]["authors"][0]["commits"] = 4
        self.assertTrue(any("authors" in m and "commits" in m for m in self.run_rules(docs)))

    def test_email_anywhere_is_red(self):
        for where in ("msg", "desc", "name", "note"):
            docs = valid_docs()
            if where == "msg":
                docs["org-activity"]["recent_commits"][0]["msg"] = "x a@b.de"
            elif where == "desc":
                docs["github-repos"]["repos"]["docs"]["description"] = "ping a@example.com"
            elif where == "name":
                docs["people-public"]["people"]["someone"]["name"] = "me@lab.org"
            else:
                docs["page-authors"]["note"] = "mail x@y.io"
            with self.subTest(where=where):
                self.assertTrue(any("e-mail" in m for m in self.run_rules(docs)))

    def test_angle_brackets_in_free_text_are_red(self):
        docs = valid_docs()
        docs["github-repos"]["repos"]["docs"]["description"] = "a <b> c"
        self.assertTrue(any("'<' or '>'" in m for m in self.run_rules(docs)))
        docs = valid_docs()
        docs["org-activity"]["recent_commits"][0]["msg"] = "x > y"
        self.assertTrue(any("'<' or '>'" in m for m in self.run_rules(docs)))

    def test_long_or_multiline_msg_is_red(self):
        docs = valid_docs()
        docs["org-activity"]["recent_commits"][0]["msg"] = "x" * 101
        self.assertTrue(self.run_rules(docs))
        docs["org-activity"]["recent_commits"][0]["msg"] = "a\nb"
        self.assertTrue(self.run_rules(docs))

    def test_full_sha_is_red(self):
        docs = valid_docs()
        docs["org-activity"]["recent_commits"][0]["sha"] = BLOB
        self.assertTrue(any("7-character" in m for m in self.run_rules(docs)))

    def test_private_repo_is_red(self):
        docs = valid_docs()
        docs["github-repos"]["repos"]["docs"]["private"] = True
        self.assertTrue(any("private" in m for m in self.run_rules(docs)))
        docs["github-repos"]["repos"]["docs"]["private"] = "false"
        self.assertTrue(any("private" in m for m in self.run_rules(docs)))

    def test_blob_shapes(self):
        docs = valid_docs()
        docs["page-authors"]["pages"]["about"]["original"]["blob"] = None
        self.assertTrue(any("blob" in m for m in self.run_rules(docs)))
        docs = valid_docs()
        docs["page-authors"]["pages"]["setup/raspberry-pi/ethernet"]["original"]["blob"] = BLOB
        self.assertTrue(any("must be null" in m for m in self.run_rules(docs)))
        docs = valid_docs()
        docs["page-authors"]["pages"]["about"]["original"]["repo"] = "someone/else"
        self.assertTrue(any("original.repo" in m for m in self.run_rules(docs)))

    def test_edit_state(self):
        docs = valid_docs()
        docs["page-authors"]["pages"]["setup/raspberry-pi/ethernet"]["edited_here"][0]["state"] = "draft"
        self.assertTrue(any("state" in m for m in self.run_rules(docs)))

    def test_avatar_must_exist_and_be_png_or_jpeg_of_16kb(self):
        path = "data/graph/avatars/NBauschmann.png"
        self.assertTrue(any("does not exist" in m for m in self.run_rules(valid_docs(), {})))
        svg = b"<svg xmlns='http://www.w3.org/2000/svg'/>"
        self.assertTrue(any("magic bytes" in m
                            for m in self.run_rules(valid_docs(), {path: svg})))
        self.assertTrue(any("magic bytes" in m
                            for m in self.run_rules(valid_docs(), {path: JPG})))
        big = rules.PNG_MAGIC + b"\x00" * rules.AVATAR_MAX_BYTES
        self.assertTrue(any("at most" in m for m in self.run_rules(valid_docs(), {path: big})))
        docs = valid_docs()
        docs["people-public"]["people"]["NBauschmann"]["avatar"] = "https://avatars.githubusercontent.com/u/1"
        self.assertTrue(any(".avatar must be" in m for m in self.run_rules(docs)))

    def test_avatar_directory_files(self):
        self.assertEqual(rules.check_avatar_files([("a.png", PNG), ("b.jpg", JPG)]), [])
        self.assertEqual(len(rules.check_avatar_files([("a.svg", b"<svg/>"),
                                                       ("b.png", JPG),
                                                       ("c.png", PNG + b"\x00" * 20000)])), 3)

    def test_an_object_or_list_hidden_under_a_leaf_is_red(self):
        # a leaf is a plain value; an object under an allowed key used to pass
        hidden = {"commits": 627, "last_active": "2026-09-01"}
        page = "setup/raspberry-pi/ethernet"
        cases = {
            "people.name": lambda d: d["people-public"]["people"]["someone"].__setitem__(
                "name", hidden),
            "authors.name": lambda d: d["page-authors"]["pages"][page]["original"][
                "authors"][0].__setitem__("name", hidden),
            "recent_commits.repo": lambda d: d["org-activity"]["recent_commits"][0]
                .__setitem__("repo", {"author": "NBauschmann"}),
            "edited_here.by": lambda d: d["page-authors"]["pages"][page]["edited_here"][0]
                .__setitem__("by", hidden),
            "converted.by": lambda d: d["page-authors"]["pages"][page]["converted"]
                .__setitem__("by", [hidden]),
            "repos.language": lambda d: d["github-repos"]["repos"]["docs"].__setitem__(
                "language", ["Python", hidden]),
            "most_active.name": lambda d: d["org-activity"]["most_active_repos"][0]
                .__setitem__("name", hidden),
            "releases.tag": lambda d: d["org-activity"]["releases"][0].__setitem__(
                "tag", hidden),
            "top.read_at": lambda d: d["people-public"].__setitem__("read_at", hidden),
            "week.week": lambda d: d["org-activity"]["weeks"][0].__setitem__("week", hidden),
        }
        for where, smuggle in cases.items():
            docs = valid_docs()
            smuggle(docs)
            with self.subTest(where=where):
                out = self.run_rules(docs)
                self.assertTrue(any("plain value" in m for m in out), out)

    def test_sniff(self):
        self.assertEqual(rules.sniff_image(PNG), "png")
        self.assertEqual(rules.sniff_image(JPG), "jpg")
        self.assertIsNone(rules.sniff_image(b"<svg/>"))
        self.assertIsNone(rules.sniff_image(b"GIF89a"))
        self.assertIsNone(rules.sniff_image("text"))


class AvatarTree(unittest.TestCase):
    def test_a_subfolder_or_a_file_inside_one_is_red(self):
        with tempfile.TemporaryDirectory() as tmp:
            adir = Path(tmp) / rules.AVATAR_DIR
            adir.mkdir(parents=True)
            (adir / "a.png").write_bytes(PNG)
            self.assertEqual(check.check_avatar_dir(tmp), [])
            (adir / "sub").mkdir()
            (adir / "sub" / "x.svg").write_bytes(b"<svg onload=alert(1)/>")
            out = check.check_avatar_dir(tmp)
            self.assertTrue(any("sub" in m and "subfolder" in m for m in out), out)
            self.assertTrue(any("x.svg" in m for m in out), out)

    def test_no_folder_is_fine(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(check.check_avatar_dir(tmp), [])


class Section11Notes(unittest.TestCase):
    def test_stale_keys_are_notes(self):
        docs = valid_docs()
        docs["people-public"]["people"]["NBauschmann"]["roster"] = "Old Name"
        notes = rules.github_layer_notes(docs, {"about"}, {"Kyle Nelson"}, {"other"})
        self.assertEqual(len(notes), 3, notes)
        self.assertTrue(any("setup/raspberry-pi/ethernet" in n for n in notes))
        self.assertTrue(any("Old Name" in n for n in notes))
        self.assertTrue(any("'docs'" in n for n in notes))
        # and the hard rules do not care about any of it
        self.assertEqual(rules.check_github_layer(docs, avatars()), [])

    def test_graph_shards_ignore_the_four_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            graph = Path(tmp) / "data" / "graph"
            graph.mkdir(parents=True)
            for name, doc in valid_docs().items():
                (graph / f"{name}.json").write_text(json.dumps(doc), encoding="utf-8")
            shards = check.read_repo_shards(tmp)
            self.assertEqual(shards, {})
            self.assertEqual(check.check_graph_shards([], {"repos": []}, {"projects": []},
                                                      shards), [])


class LinksBlock(unittest.TestCase):
    def good(self):
        return {"note": "n", "links": {"RHochdahl": "René Hochdahl", "x-y": None},
                "exclude": ["hippocampusmum"]}

    def test_green(self):
        self.assertEqual(rules.check_github_links(self.good()), [])
        real = json.loads((ROOT / "data" / "github-links.json").read_text(encoding="utf-8"))
        self.assertEqual(rules.check_github_links(real), [])

    def test_shape_is_hard(self):
        for bad in ([], {"links": {}, "exclude": []}, {**self.good(), "extra": 1},
                    {**self.good(), "links": []}, {**self.good(), "exclude": "hippocampusmum"},
                    {**self.good(), "links": {"a": 3}}, {**self.good(), "links": {"a b": None}}):
            with self.subTest(bad=bad):
                self.assertTrue(rules.check_github_links(bad))

    def test_linked_and_excluded_is_hard(self):
        doc = self.good()
        doc["exclude"].append("RHochdahl")
        out = rules.check_github_links(doc)
        self.assertEqual(len(out), 1)
        self.assertIn("both linked and excluded", out[0])

    def test_a_null_or_list_map_file_is_red(self):
        for text in ("null", "[]", '"x"', "3"):
            with self.subTest(text=text), tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / rules.LINKS_FILE
                path.parent.mkdir(parents=True)
                path.write_text(text, encoding="utf-8")
                doc, problems = check.read_github_links(tmp)
                self.assertTrue(problems, text)
        with tempfile.TemporaryDirectory() as tmp:
            doc, problems = check.read_github_links(tmp)
            self.assertTrue(any("missing" in m for m in problems), problems)
        doc, problems = check.read_github_links(ROOT)
        self.assertEqual(problems, [])
        self.assertIsInstance(doc, dict)

    def test_two_map_lines_for_one_roster_name_is_a_note(self):
        doc = self.good()
        doc["links"]["other-login"] = "René Hochdahl"
        self.assertEqual(rules.check_github_links(doc), [])       # never red
        notes = rules.github_links_notes(doc, {"René Hochdahl"}, None)
        pair = [n for n in notes if "'RHochdahl'" in n and "'other-login'" in n]
        self.assertEqual(len(pair), 1, notes)
        self.assertIn("René Hochdahl", pair[0])

    def test_unknown_roster_name_and_absent_login_are_notes(self):
        notes = rules.github_links_notes(self.good(), {"Someone Else"},
                                         {"people": {"x-y": {}}})
        self.assertEqual(len(notes), 2, notes)
        self.assertTrue(any("René Hochdahl" in n for n in notes))
        self.assertTrue(any("'RHochdahl' is not in" in n for n in notes))


class IndexShell(unittest.TestCase):
    def shell(self, text=None):
        with tempfile.TemporaryDirectory() as tmp:
            dst = Path(tmp)
            for rel in ("index.html", "cms/index.html", "cms/callback.html"):
                (dst / rel).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy(ROOT / rel, dst / rel)
            for sub in ("js", "css"):
                shutil.copytree(ROOT / sub, dst / sub)
            (dst / "data").mkdir()
            shutil.copy(ROOT / "data" / "cloudinary-manifest.json", dst / "data")
            if text is not None:
                (dst / "index.html").write_text(text, encoding="utf-8")
            return [m for m in check.check_cms_shell(dst) if m.startswith("index.html")]

    def test_index_html_is_green_today(self):
        self.assertIn("index.html", check.SHELL_PAGES)
        self.assertEqual(self.shell(), [])

    def test_inline_script_and_handler_are_red(self):
        base = (ROOT / "index.html").read_text(encoding="utf-8")
        out = self.shell(base.replace("</body>", "<script>alert(1)</script></body>"))
        self.assertTrue(any("inline <script>" in m for m in out), out)
        out = self.shell(base.replace("<body", '<body onload="x()"', 1))
        self.assertTrue(any("onload=" in m for m in out), out)

    def test_remote_script_and_stylesheet_are_red(self):
        base = (ROOT / "index.html").read_text(encoding="utf-8")
        out = self.shell(base.replace(
            "</body>", '<script src="https://cdn.example.com/x.js"></script></body>'))
        self.assertTrue(any("remote <script>" in m for m in out), out)
        out = self.shell(base.replace(
            "</head>", '<link rel="stylesheet" href="https://cdn.example.com/x.css"></head>'))
        self.assertTrue(any("remote <link>" in m for m in out), out)

    def test_icon_only_from_cloudinary(self):
        base = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertIn('<link rel="icon" href="https://res.cloudinary.com/', base)
        out = self.shell(base.replace("https://res.cloudinary.com/", "https://evil.example.com/", 1))
        self.assertTrue(any("remote <link>" in m for m in out), out)

    def test_icon_rel_and_account_are_pinned(self):
        base = (ROOT / "index.html").read_text(encoding="utf-8")
        cloud = json.loads((ROOT / "data" / "cloudinary-manifest.json")
                           .read_text(encoding="utf-8"))["cloud"]
        good = f"https://res.cloudinary.com/{cloud}/image/upload/v1/x/favicon.png"
        self.assertEqual(self.shell(base.replace(
            "</head>", f'<link rel="shortcut icon" href="{good}"></head>')), [])
        # the real favicon (as index.html holds it) stays green
        self.assertEqual(self.shell(base), [])
        bad = {
            "stylesheet icon": f'<link rel="stylesheet icon" href="{good}">',
            "icon preload": f'<link rel="icon preload" href="{good}">',
            "other account": '<link rel="icon" href="https://res.cloudinary.com/'
                             'someone-else/image/upload/v1/f.png">',
            "raw upload": f'<link rel="icon" href="https://res.cloudinary.com/{cloud}'
                          f'/raw/upload/v1/x.css">',
            # the prefix test alone passed these: the path climbs out of the
            # site's own account after the prefix
            "dot-dot climb": f'<link rel="icon" href="https://res.cloudinary.com/{cloud}'
                             f'/image/upload/../../../otheracct/image/upload/x.png">',
            "dot segment": f'<link rel="icon" href="https://res.cloudinary.com/{cloud}'
                           f'/image/upload/./x.png">',
            "trailing dot-dot": f'<link rel="icon" href="https://res.cloudinary.com/{cloud}'
                                f'/image/upload/v1/..">',
            "encoded dots": f'<link rel="icon" href="https://res.cloudinary.com/{cloud}'
                            f'/image/upload/%2E%2e/%2e%2E/otheracct/image/upload/x.png">',
            "backslash": f'<link rel="icon" href="https://res.cloudinary.com/{cloud}'
                         f'/image/upload/..\\..\\otheracct/x.png">',
        }
        # a Cloudinary image path never needs percent-encoding: an encoded
        # separator ('%2f', '%5c') climbs out as surely as a literal one
        up = f"https://res.cloudinary.com/{cloud}/image/upload/"
        for label, path in {
            "encoded slash climb": "%2f..%2f..%2fotheracct/image/upload/x.png",
            "encoded slash upper": "v1%2Fx%2Ffavicon.png",
            "encoded backslash": "..%5c..%5cotheracct/x.png",
            "encoded backslash upper": "..%5C..%5Cotheracct/x.png",
            "lone percent": "v1/x/fav%icon.png",
        }.items():
            bad[label] = f'<link rel="icon" href="{up}{path}">'
        for label, tag in bad.items():
            with self.subTest(label=label):
                out = self.shell(base.replace("</head>", tag + "</head>"))
                self.assertTrue(any("remote <link>" in m for m in out), out)


# --------------------------------------------------------------------------
# end to end: the real gate over a copied tree
# --------------------------------------------------------------------------
def copy_repo(dst):
    shutil.copytree(ROOT, dst, ignore=shutil.ignore_patterns(
        ".git", "graphify-out", "node_modules", "__pycache__"))
    graph = dst / "data" / "graph"
    if not (graph / "people-public.json").exists():   # before the first build
        for name, doc in valid_docs().items():
            (graph / f"{name}.json").write_text(json.dumps(doc, indent=1), encoding="utf-8")
        (graph / "avatars").mkdir(exist_ok=True)
        (graph / "avatars" / "NBauschmann.png").write_bytes(PNG)


def run_gate(dst):
    for args in (["init", "-q"], ["add", "-A"]):
        subprocess.run(["git", *args], cwd=dst, check=True, capture_output=True)
    return subprocess.run([sys.executable, str(dst / "tools" / "check.py")],
                          capture_output=True, text=True)


def edit_json(path, fn):
    doc = json.loads(path.read_text(encoding="utf-8"))
    fn(doc)
    path.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


class EndToEnd(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="gh-layer-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.dst = self.tmp / "repo"
        copy_repo(self.dst)

    def test_members_only_key_smuggled_into_a_public_file_is_red(self):
        def smuggle(doc):
            login = sorted(doc["people"])[0]
            doc["people"][login]["last_active"] = "2026-09-01"
        edit_json(self.dst / "data" / "graph" / "people-public.json", smuggle)
        run = run_gate(self.dst)
        self.assertEqual(run.returncode, 1, run.stdout)
        self.assertIn("last_active", run.stdout)
        self.assertIn("not public", run.stdout)

    def test_pr_shaped_tree_with_stale_github_files_is_green(self):
        graph = self.dst / "data" / "graph"
        pa = json.loads((graph / "page-authors.json").read_text(encoding="utf-8"))
        pp = json.loads((graph / "people-public.json").read_text(encoding="utf-8"))
        gr = json.loads((graph / "github-repos.json").read_text(encoding="utf-8"))
        # 1. a renamed roster person: pick one the GitHub files link to
        linked = sorted(p["roster"] for p in pp["people"].values() if p["roster"])
        self.assertTrue(linked)
        old = linked[0]

        def rename(doc):
            for g in doc["groups"]:
                for p in g["people"]:
                    if p["name"] == old:
                        p["name"] = old + " Renamed"
        edit_json(self.dst / "data" / "people.json", rename)
        # 2. a deleted setup page: the GitHub files still carry its key (a page
        # the registries no longer enumerate) — simulated by an extra key, so
        # the rest of the tree (setup.json, parity, wiki graph) stays in step
        key = sorted(pa["pages"])[0]
        edit_json(graph / "page-authors.json",
                  lambda d: d["pages"].__setitem__("setup/removed/page",
                                                   copy.deepcopy(d["pages"][key])))
        # 3. a dropped repository: github-repos still lists it
        name = sorted(gr["repos"])[0]

        def extra_repo(d):
            row = copy.deepcopy(d["repos"][name])
            row["name"] = "dropped-repo"
            d["repos"]["dropped-repo"] = row
        edit_json(graph / "github-repos.json", extra_repo)
        # 4. a mapped login the GitHub files do not know (yet)
        edit_json(self.dst / "data" / "github-links.json",
                  lambda d: d["links"].__setitem__("new-member-login", "Kyle Nelson"))
        run = run_gate(self.dst)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("check.py: all green", run.stdout)
        for needle in (old, "setup/removed/page", "dropped-repo", "new-member-login"):
            self.assertIn(needle, run.stdout)
        self.assertIn("note:", run.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=1)
