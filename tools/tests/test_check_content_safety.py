#!/usr/bin/env python3
# Author: Kyle Nelson
# Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
# Last substantive modification: 21 September 2026
# Affiliation: TUHH HippoCampus Robotics
# Purpose: Test the content-safety, manifest, CMS-shell and authored-overlay rules of the site gate.
"""Unit tests for the CMS v2 hardening of the check gate (tools/check.py).

Run from the repo root with plain python3 (no pytest, no network):

    python3 tools/tests/test_check_content_safety.py

Covers 6d (content safety), the 6a manifest rules for CMS uploads
("source": null, the hippocampus-docs/ folder), the when-present CMS shell
check in section 7, and the authored-overlay id rule (9a). Every rule under
test is a pure function, proven red on an in-memory fixture or a temporary
tree; the integration tests read the real repo read-only and expect nothing.
One end-to-end test copies the repo into a temporary directory to prove the
overlay line is the FIRST failure a reader sees after a project rename.
"""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import check  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent.parent
SHA = "a" * 64
CLOUD = "dr76gues0"
TAIL = "— use the dialect blocks in CONTRIBUTING.md"


def tokens(text):
    return [tok for _line, tok in check.scan_markup(text)]


# --------------------------------------------------------------------------
# 6d. content safety — the scanner
# --------------------------------------------------------------------------
class ScanMarkup(unittest.TestCase):
    def test_script_tag(self):
        self.assertEqual(check.scan_markup("ok\n\n<script>alert(1)</script>\n"),
                         [(3, "<script>")])

    def test_every_forbidden_tag(self):
        for tag in ("script", "iframe", "object", "embed", "form", "meta",
                    "link", "style", "base", "svg"):
            with self.subTest(tag=tag):
                self.assertEqual(tokens(f"x <{tag} a=1>"), [f"<{tag}>"])

    def test_tags_are_case_insensitive_and_slash_separated(self):
        self.assertIn("<script>", tokens("<ScRiPt>x</script>"))
        self.assertIn("<svg>", tokens("<svg/onload=alert(1)>"))
        self.assertIn("onload=", tokens("<svg/onload=alert(1)>"))

    def test_event_handler(self):
        self.assertEqual(check.scan_markup("a\n<img src=x onerror=alert(1)>"),
                         [(2, "onerror=")])
        self.assertEqual(tokens('<div ONCLICK = "x()">'), ["onclick="])

    def test_srcdoc(self):
        self.assertIn("srcdoc=", tokens('<p srcdoc="x">'))

    def test_dangerous_schemes_in_links(self):
        cases = {
            "[x](javascript:alert(1))": "javascript:",
            "![x]( JavaScript:alert(1))": "javascript:",
            "[x](<vbscript:msgbox(1)>)": "vbscript:",
            '<a href="data:text/html,<b>x</b>">x</a>': "data:text/html",
            "<img src='javascript:x'>": "javascript:",
            "<a href=javascript:x>y</a>": "javascript:",
            "[x]: javascript:alert(1)": "javascript:",
            "<javascript:alert(1)>": "javascript:",
            "[x](javascript&#58;alert(1))": "javascript:",
            "[x](java\tscript:alert(1))": "javascript:",
            '<a href="' + " " * 200 + 'javascript:x">y</a>': "javascript:",
            "<a href='" + "&#9;" * 100 + "javascript:x'>y</a>": "javascript:",
            "[x](" + " " * 200 + "javascript:x)": "javascript:",
            "[x]: " + "&#32;" * 100 + "javascript:x": "javascript:",
        }
        for text, tok in cases.items():
            with self.subTest(text=text):
                self.assertEqual(tokens(text), [tok])

    def test_fenced_code_is_scanned_too(self):
        text = "intro\n\n```html\n<script>x</script>\n```\n"
        self.assertEqual(check.scan_markup(text), [(4, "<script>")])

    def test_legitimate_text_is_clean(self):
        clean = [
            "Put <base-url> and <your-ssh-public-key> here.",
            "<basename>/<link-name>/<formula>/<metadata>",
            "Written in plain JavaScript: no framework.",
            "[docs](https://example.org/a) and [route](#/setup/start/index)",
            '<div class="adm adm-note">turn on the pump; switch on = off</div>',
            '<img src="https://res.cloudinary.com/x/image/upload/a.jpg" alt="a">',
            "export ONLY_THIS=1 and --online=true",
            "data:image/png is a scheme name, not a link here",
        ]
        for text in clean:
            with self.subTest(text=text):
                self.assertEqual(check.scan_markup(text), [])


class ContentSafetyFiles(unittest.TestCase):
    def tree(self, files):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        for rel, text in files.items():
            p = root / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text, encoding="utf-8")
        return root

    def test_markdown_located_line(self):
        root = self.tree({"content/setup/x.md": "\n" * 11 + "<script>x</script>\n",
                          "data/a.json": "{}"})
        self.assertEqual(check.check_content_safety(root), [
            "content/setup/x.md:12: inline script or event handler is not "
            f"allowed in content (<script>) {TAIL}"])

    def test_json_string_values_including_graph(self):
        root = self.tree({
            "content/about.md": "fine\n",
            "data/projects.json": json.dumps(
                {"projects": [{"id": "p", "tagline": "<iframe src=x>",
                               "links": [{"href": "javascript:alert(1)",
                                          "label": "x"}]}]}),
            "data/graph/summaries.json": json.dumps(
                {"pages": {"about": {"summary": "<img src=x onerror=f()>"}}}),
        })
        got = check.check_content_safety(root)
        self.assertEqual(got, [
            "data/graph/summaries.json: inline script or event handler is not "
            f"allowed in content (onerror=) at 'pages.about.summary' {TAIL}",
            "data/projects.json: inline script or event handler is not allowed "
            f"in content (<iframe>) at 'projects[0].tagline' {TAIL}",
            "data/projects.json: inline script or event handler is not allowed "
            f"in content (javascript:) at 'projects[0].links[0].href' {TAIL}",
        ])

    def test_unparseable_json_is_left_to_the_hygiene_scan(self):
        root = self.tree({"data/bad.json": "{nope"})
        self.assertEqual(check.check_content_safety(root), [])

    def test_real_repo_is_clean(self):
        self.assertEqual(check.check_content_safety(ROOT), [])


# --------------------------------------------------------------------------
# 6a. the Cloudinary manifest — CMS uploads carry "source": null
# --------------------------------------------------------------------------
def cms_entry(**over):
    e = {"source": None, "folder": "hippocampus-docs/setup",
         "public_id": "hippocampus-docs/setup/cms-test",
         "url": f"https://res.cloudinary.com/{CLOUD}/image/upload/v1/"
                "hippocampus-docs/setup/cms-test.jpg",
         "bytes": 1, "sha256": SHA}
    e.update(over)
    return e


class Manifest(unittest.TestCase):
    def run_manifest(self, *entries, root=None):
        doc = {"cloud": CLOUD, "assets": list(entries)}
        return check.check_manifest(doc, root or ROOT)

    def test_source_null_entry_is_valid(self):
        msgs, pids, sources = self.run_manifest(cms_entry())
        self.assertEqual(msgs, [])
        self.assertEqual(pids, {"hippocampus-docs/setup/cms-test"})
        self.assertEqual(sources, set())

    def test_source_null_still_needs_sha256(self):
        e = cms_entry()
        del e["sha256"]
        msgs, _, _ = self.run_manifest(e)
        self.assertEqual(msgs, [
            "data/cloudinary-manifest.json: manifest entry "
            "hippocampus-docs/setup/cms-test: missing/invalid sha256 — required "
            "for source drift detection"])

    def test_source_null_still_needs_bytes_url_public_id(self):
        e = cms_entry()
        del e["bytes"]
        self.assertEqual(self.run_manifest(e)[0], [
            "data/cloudinary-manifest.json: manifest entry "
            "hippocampus-docs/setup/cms-test: 'bytes' must be a positive whole "
            "number"])
        for key in ("url", "public_id"):
            with self.subTest(key=key):
                e = cms_entry()
                del e[key]
                msgs = self.run_manifest(e)[0]
                self.assertEqual(len(msgs), 1)
                self.assertIn("entry missing source/public_id/url", msgs[0])

    def test_source_key_itself_is_required(self):
        e = cms_entry()
        del e["source"]
        msgs = self.run_manifest(e)[0]
        self.assertEqual(len(msgs), 1)
        self.assertIn("entry missing source/public_id/url", msgs[0])

    def test_public_id_must_live_under_hippocampus_docs(self):
        e = cms_entry(public_id="portfolio/x",
                      url=f"https://res.cloudinary.com/{CLOUD}/image/upload/v1/"
                          "portfolio/x.jpg")
        self.assertEqual(self.run_manifest(e)[0], [
            "data/cloudinary-manifest.json: public_id 'portfolio/x' is outside "
            "the site's folder — every public_id starts with 'hippocampus-docs/'"])

    def test_uniqueness_holds_for_null_sources(self):
        msgs = self.run_manifest(cms_entry(), cms_entry())[0]
        self.assertIn("data/cloudinary-manifest.json: duplicate url "
                      f"'{cms_entry()['url']}'", msgs)
        self.assertIn("data/cloudinary-manifest.json: duplicate public_id "
                      "'hippocampus-docs/setup/cms-test'", msgs)
        self.assertFalse(any("duplicate source" in m for m in msgs))

    def test_wrong_cloud_is_still_caught(self):
        e = cms_entry(url="https://res.cloudinary.com/other/image/upload/"
                          "hippocampus-docs/setup/cms-test.jpg")
        msgs = self.run_manifest(e)[0]
        self.assertEqual(len(msgs), 1)
        self.assertIn("is not on cloud 'dr76gues0'", msgs[0])

    def test_local_source_keeps_existence_and_drift_checks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "assets").mkdir()
            (root / "assets" / "a.jpg").write_bytes(b"new bytes")
            e = cms_entry(source="assets/a.jpg")
            msgs, _, sources = self.run_manifest(e, root=root)
            self.assertEqual(len(msgs), 1)
            self.assertIn("assets/a.jpg changed since upload", msgs[0])
            self.assertEqual(sources, {(root / "assets" / "a.jpg").resolve()})
            e = cms_entry(source="assets/gone.jpg")
            msgs = self.run_manifest(e, root=root)[0]
            self.assertEqual(len(msgs), 1)
            self.assertIn("source file missing on disk: assets/gone.jpg", msgs[0])

    def test_directory_source_is_reported_not_raised(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "assets").mkdir()
            msgs = self.run_manifest(cms_entry(source="assets"), root=Path(tmp))[0]
            self.assertEqual(len(msgs), 1)
            self.assertIn("source file missing on disk: assets", msgs[0])

    def test_real_manifest_is_clean(self):
        doc = json.loads((ROOT / "data" / "cloudinary-manifest.json")
                         .read_text(encoding="utf-8"))
        self.assertEqual(check.check_manifest(doc, ROOT)[0], [])


# --------------------------------------------------------------------------
# 7. the CMS shell — checked when present (U7a makes it required)
# --------------------------------------------------------------------------
class CmsShell(unittest.TestCase):
    def test_unterminated_or_empty_inline_script_is_caught(self):
        for body in ("<script>alert(1)", "<SCRIPT type=module>\nx", "<script></script>",
                     "<script\n>x</script>"):
            with self.subTest(body=body):
                root = self.tree({"cms/index.html": "<!doctype html>\n" + body})
                got = check.check_cms_shell(root)
                self.assertEqual(len(got), 1, got)
                self.assertTrue(got[0].startswith(
                    "cms/index.html:2: inline <script> (no src)"), got)

    def tree(self, files):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        for rel, text in files.items():
            p = root / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text, encoding="utf-8")
        return root

    def test_absent_is_skipped_silently(self):
        self.assertEqual(check.check_cms_shell(self.tree({"index.html": ""})), [])

    def test_clean_pages_pass(self):
        page = ('<!doctype html>\n<link rel="stylesheet" href="../css/cms.css">\n'
                '<script src="/js/cms.js" defer></script>\n'
                '<script src="cms-local.js?v=2"></script>\n'
                '<a href="https://github.com/x">x</a> <a href="../#/about">a</a>\n')
        root = self.tree({"cms/index.html": page, "cms/callback.html": page,
                          "css/cms.css": "", "js/cms.js": "",
                          "cms/cms-local.js": "", "index.html": ""})
        self.assertEqual(check.check_cms_shell(root), [])

    def test_a_directory_is_not_a_script(self):
        root = self.tree({"cms/index.html": '<!doctype html>\n<script src="../js">'
                                            '</script>\n', "js/cms.js": ""})
        self.assertEqual(check.check_cms_shell(root), [
            "cms/index.html:2: missing referenced file ../js"])

    def test_empty_resource_reference_is_caught(self):
        # an empty src/href loads nothing (or the page itself); the src
        # attribute would otherwise also satisfy the no-inline-script rule
        for tag in ('<script src=""></script>', "<script src=' '></script>",
                    '<script src=></script>', '<link rel="stylesheet" href="">',
                    '<img src="">'):
            with self.subTest(tag=tag):
                root = self.tree({"cms/index.html": "<!doctype html>\n" + tag})
                got = check.check_cms_shell(root)
                self.assertEqual(len(got), 1, got)
                self.assertTrue(got[0].startswith("cms/index.html:2: empty "), got)

    def test_empty_navigation_link_is_fine(self):
        root = self.tree({"cms/index.html": '<!doctype html>\n<a href="">self</a>'})
        self.assertEqual(check.check_cms_shell(root), [])

    def test_a_directory_index_is_not_a_script_or_stylesheet(self):
        # the index.html fallback is for navigation only: a script or a
        # stylesheet pointed at a directory gets an HTML page back
        for tag in ('<script src="../js/"></script>',
                    '<link rel="stylesheet" href="../js/">'):
            with self.subTest(tag=tag):
                root = self.tree({"cms/index.html": "<!doctype html>\n" + tag,
                                  "js/index.html": ""})
                self.assertEqual(check.check_cms_shell(root), [
                    "cms/index.html:2: missing referenced file ../js/"])
        root = self.tree({"cms/index.html": '<!doctype html>\n<a href="../js/">j</a>',
                          "js/index.html": ""})
        self.assertEqual(check.check_cms_shell(root), [])

    def test_script_src_must_be_a_file_not_a_fragment_or_data_url(self):
        for src in ("#x", "?v=1", "data:text/javascript,alert(1)",
                    "javascript:alert(1)"):
            with self.subTest(src=src):
                root = self.tree({"cms/index.html":
                                  f'<!doctype html>\n<script src="{src}"></script>'})
                got = check.check_cms_shell(root)
                self.assertEqual(len(got), 1, got)
                self.assertTrue(got[0].startswith("cms/index.html:2: "), got)

    def test_remote_script_or_stylesheet_is_caught(self):
        for tag in ('<script src="https://evil.example/payload.js"></script>',
                    '<script src="//cdn.example/x.js"></script>',
                    '<script src="HTTP://cdn.example/x.js"></script>',
                    '<link rel="stylesheet" href="https://cdn.example/x.css">'):
            with self.subTest(tag=tag):
                root = self.tree({"cms/index.html": "<!doctype html>\n" + tag})
                got = check.check_cms_shell(root)
                self.assertEqual(len(got), 1, got)
                self.assertTrue(got[0].startswith("cms/index.html:2: remote <"), got)

    def test_remote_image_is_fine(self):
        root = self.tree({"cms/index.html": '<!doctype html>\n'
                          '<img src="https://res.cloudinary.com/x/a.png" alt="">'})
        self.assertEqual(check.check_cms_shell(root), [])

    def test_only_a_real_src_attribute_excuses_a_script_body(self):
        # the browser ignores every one of these as a src, runs the body
        for tag in ('<script data.src="../js/cms.js">alert(1)</script>',
                    '<script x:src="../js/cms.js">alert(1)</script>',
                    '<script data-src="../js/cms.js">alert(1)</script>',
                    '<script title=" src=../js/cms.js">alert(1)</script>',
                    "<script title='x src=../js/cms.js'>alert(1)</script>"):
            with self.subTest(tag=tag):
                root = self.tree({"cms/index.html": "<!doctype html>\n" + tag,
                                  "js/cms.js": ""})
                got = check.check_cms_shell(root)
                self.assertIn("cms/index.html:2: inline <script> (no src) — CMS "
                              "pages load their code from files (the CSP forbids "
                              "inline script)", got)

    def test_first_src_wins_like_the_browser(self):
        root = self.tree({"cms/index.html": '<!doctype html>\n'
                          '<script src="" src="../js/cms.js">alert(1)</script>',
                          "js/cms.js": ""})
        got = check.check_cms_shell(root)
        self.assertIn("cms/index.html:2: empty src on <script> — a loaded "
                      "resource must name a file", got)

    def test_a_reference_is_read_after_character_references(self):
        root = self.tree({"cms/index.html": '<!doctype html>\n'
                          '<script src="&#46;&#46;/js/cms.js"></script>',
                          "js/cms.js": ""})
        self.assertEqual(check.check_cms_shell(root), [])

    HANDLER = ("inline event handler ({}=) — CMS pages attach handlers from "
               "their script files")

    def test_handler_after_a_quoted_gt_is_caught(self):
        # a tag regex stopped at the '>' inside title=">" and never saw the
        # handler the browser runs
        for tag, attr in (('<img title=">" onerror="alert(1)" src="ok.png">',
                           "onerror"),
                          ('<a href="#" title=">" onclick="x()">x</a>',
                           "onclick")):
            with self.subTest(tag=tag):
                root = self.tree({"cms/index.html": "<!doctype html>\n" + tag,
                                  "cms/ok.png": ""})
                self.assertEqual(check.check_cms_shell(root), [
                    "cms/index.html:2: " + self.HANDLER.format(attr)])

    def test_handler_on_a_later_tag_after_a_quoted_gt_is_caught(self):
        root = self.tree({"cms/index.html": (
            '<!doctype html>\n<p title="a > b">x</p>\n'
            '<div>y</div>\n<button type="button" onclick="go()">go</button>\n')})
        self.assertEqual(check.check_cms_shell(root), [
            "cms/index.html:4: " + self.HANDLER.format("onclick")])

    def test_benign_quoted_gt_is_clean(self):
        root = self.tree({"cms/index.html": (
            '<!doctype html>\n<img title=">" src="ok.png" alt="a > b">\n'
            '<a href="#" title=">">x</a>\n'), "cms/ok.png": ""})
        self.assertEqual(check.check_cms_shell(root), [])

    def test_a_tag_the_parser_did_not_read_is_judged_strictly(self):
        # inside a comment the parser reads no tag; a browser/parser
        # disagreement there must not hide a handler, so the text is judged
        root = self.tree({"cms/index.html": (
            '<!doctype html>\n<!-- <img src=x> -->\n<p>ok</p>\n'
            '<b title="x onmouseover=y">z</b>\n')})
        self.assertEqual(check.check_cms_shell(root), [
            "cms/index.html:4: " + self.HANDLER.format("onmouseover")])
        # html.parser reads <svg><title> as raw text; the browser does not,
        # and runs the handler
        root = self.tree({"cms/index.html": (
            '<!doctype html>\n<svg><title><img src=x onerror=a></title></svg>')})
        self.assertEqual(check.check_cms_shell(root), [
            "cms/index.html:2: " + self.HANDLER.format("onerror")])

    def test_present_and_broken_gives_located_lines(self):
        root = self.tree({
            "cms/index.html": ('<!doctype html>\n'
                               '<script src="../js/missing.js"></script>\n'
                               '<button onclick="go()">go</button>\n'),
            "cms/callback.html": ('<!doctype html>\n<p>x</p>\n'
                                  '<script>\n  window.close();\n</script>\n'),
        })
        self.assertEqual(check.check_cms_shell(root), [
            "cms/callback.html:3: inline <script> (no src) — CMS pages load "
            "their code from files (the CSP forbids inline script)",
            "cms/index.html:2: missing referenced file ../js/missing.js",
            "cms/index.html:3: inline event handler (onclick=) — CMS pages "
            "attach handlers from their script files",
        ])


# --------------------------------------------------------------------------
# 9a. authored overlays name only current page / repository ids
# --------------------------------------------------------------------------
def registries():
    setup = {"sections": [{"title": "Start", "pages": [
        {"id": "start/index", "title": "Start", "file": "content/setup/a.md"}]}]}
    projects = {"projects": [{"id": "core", "file": "content/projects/core.md"}]}
    tools = {"tools": [{"id": "hammer", "file": "content/tools/hammer.md"}]}
    org = [{"name": "firmware", "isFork": False, "url": "u"}]
    return setup, projects, tools, org


def overlays():
    authored = {"edges": [
        {"s": "index:home", "t": "setup/start/index", "why": "w"},
        {"s": "projects/core", "t": "repo:firmware", "why": "w"},
        {"s": "tools/hammer", "t": "about", "why": "w"}]}
    summaries = {"pages": {
        "projects/core": {"summary": "s", "source": "authored"},
        "setup/start/index": {"summary": "s", "source": "derived"}}}
    return authored, summaries


class OverlayIds(unittest.TestCase):
    def test_consistent_overlays_pass(self):
        self.assertEqual(check.check_overlay_ids(*overlays(), *registries()), [])

    def test_renamed_project_names_the_overlay_once(self):
        authored, summaries = overlays()
        authored["edges"].append({"s": "projects/core", "t": "about", "why": "w"})
        setup, projects, tools, org = registries()
        projects["projects"][0]["id"] = "core-v2"
        self.assertEqual(check.check_overlay_ids(authored, summaries, setup,
                                                 projects, tools, org), [
            "data/graph/edges-authored.json: 'projects/core' is not a page or "
            "repository id any more — renaming or removing an existing id needs "
            "Desert Mango (docs/maintainer-protocols.md)",
            "data/graph/summaries.json: 'projects/core' is not a page or "
            "repository id any more — renaming or removing an existing id needs "
            "Desert Mango (docs/maintainer-protocols.md)",
        ])

    def test_removed_repo_and_derived_summaries(self):
        authored, summaries = overlays()
        summaries["pages"]["setup/gone"] = {"summary": "s", "source": "derived"}
        setup, projects, tools, org = registries()
        org[0]["name"] = "firmware2"
        got = check.check_overlay_ids(authored, summaries, setup, projects,
                                      tools, org)
        # derived summaries are parity's business, not the overlay rule's
        self.assertEqual(got, [
            "data/graph/edges-authored.json: 'repo:firmware' is not a page or "
            "repository id any more — renaming or removing an existing id needs "
            "Desert Mango (docs/maintainer-protocols.md)"])

    def test_malformed_overlays_never_raise(self):
        setup, projects, tools, org = registries()
        for authored, summaries in (({"edges": "x"}, {"pages": []}),
                                    ({"edges": [1, {"s": 3}]}, {"pages": {"a": 1}}),
                                    ([], None)):
            with self.subTest(authored=authored):
                check.check_overlay_ids(authored, summaries, setup, projects,
                                        tools, org)

    def test_real_overlays_are_consistent(self):
        load = lambda rel: json.loads((ROOT / rel).read_text(encoding="utf-8"))
        self.assertEqual(check.check_overlay_ids(
            load("data/graph/edges-authored.json"), load("data/graph/summaries.json"),
            load("data/setup.json"), load("data/projects.json"),
            load("data/tools.json"), load("data/org-repos.json")), [])


def run_copy(mutate):
    """Copy the repo (no .git) into a temp dir, mutate it, run its check.py."""
    with tempfile.TemporaryDirectory() as tmp:
        dst = Path(tmp) / "repo"
        shutil.copytree(ROOT, dst, ignore=shutil.ignore_patterns(
            ".git", "graphify-out", "node_modules"))
        mutate(dst)
        return subprocess.run([sys.executable, str(dst / "tools" / "check.py")],
                              capture_output=True, text=True)


class EndToEndScriptLink(unittest.TestCase):
    def test_javascript_link_is_one_accurate_line(self):
        def mutate(dst):
            about = dst / "content" / "about.md"
            about.write_text(about.read_text(encoding="utf-8")
                             + "\n[x](javascript:alert(1))\n", encoding="utf-8")
        run = run_copy(mutate)
        self.assertEqual(run.returncode, 1)
        failures = [ln for ln in run.stdout.splitlines() if ln.startswith("  ✗")
                    and "attribution header" not in ln]
        self.assertEqual(len(failures), 1, run.stdout)
        self.assertIn("(javascript:)", failures[0])
        self.assertTrue(failures[0].startswith("  ✗ content/about.md:"))


class EndToEndOrdering(unittest.TestCase):
    """A renamed project breaks the overlay AND the graph parity: the overlay
    line must be the first failure the reader sees (acceptance case f)."""

    def test_overlay_line_precedes_parity_noise(self):
        with tempfile.TemporaryDirectory() as tmp:
            dst = Path(tmp) / "repo"
            shutil.copytree(ROOT, dst, ignore=shutil.ignore_patterns(
                ".git", "graphify-out", "node_modules"))
            path = dst / "data" / "projects.json"
            doc = json.loads(path.read_text(encoding="utf-8"))
            ids = [p["id"] for p in doc["projects"]]
            self.assertIn("scalar-field", ids)
            for p in doc["projects"]:
                if p["id"] == "scalar-field":
                    p["id"] = "scalar-field-v2"
            path.write_text(json.dumps(doc, indent=2), encoding="utf-8")
            run = subprocess.run([sys.executable, str(dst / "tools" / "check.py")],
                                 capture_output=True, text=True)
            self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
            lines = run.stdout.splitlines()
            self.assertTrue(lines[0].startswith("CHECK FAILED"), lines[:3])
            self.assertEqual(lines[1],
                             "  ✗ data/graph/edges-authored.json: "
                             "'projects/scalar-field' is not a page or repository "
                             "id any more — renaming or removing an existing id "
                             "needs Desert Mango (docs/maintainer-protocols.md)")
            self.assertNotIn("Traceback", run.stdout + run.stderr)
            self.assertTrue(any("wiki.json" in ln for ln in lines[2:]))


if __name__ == "__main__":
    unittest.main()
