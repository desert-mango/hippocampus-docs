#!/usr/bin/env python3
"""The check gate. Run before every commit:  python3 tools/check.py

Validates, failing loudly with actionable messages:
  1. every data/*.json registry parses (strict JSON by construction);
  1b. reader inputs: every key the readers (js/app.js,
     tools/build_search_index.py, this script) dereference without a guard is
     present, and every hardcoded content path they open exists;
  2. setup: every manifest page file exists; every content/setup/*.md is
     referenced exactly once; ids unique;
  3. parity: the setup structure disposes of EVERY old-site page exactly once
     (migrated or dropped) against data/old-docs-pages.json, and
     docs/setup-parity.md is newer than or equal to the structure's content;
  4. projects: every org repo (data/org-repos.json) appears exactly once across
     project rosters or the exclusion list; project body files exist;
  5. tools: every tool file exists;
  6. content: no orphan markdown; every internal '#/...' link in content resolves
     to a real route; every relative asset reference exists; no orphan assets;
     images live on Cloudinary — content may not point at a local assets/*.png|
     jpg|jpeg|gif|svg, every res.cloudinary.com reference must resolve to an
     entry of data/cloudinary-manifest.json (matched on public_id, so delivery
     transformations are fine), and every manifest entry must be referenced;
  6b. hygiene: no credentials, key material or personal emails in content/**.md,
     data/*.json or .mcp.json;
  6c. people: data/people.json (when present) carries exactly name/title/photo/
     link per person, every photo resolves to a manifest entry, every link is an
     http(s) URL;
  7. shell: index.html references exist; vendored marked.min.js matches its
     pinned sha256;
  8. probes: data/search-probes.json carries exactly 10 well-formed probes.

This gate is OFFLINE by design (it never touches the network). URL liveness is
the job of its online twin, tools/check_urls.py.

Never weaken a check to make it pass — fix the content it is complaining about.
"""
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MARKED_SHA256 = "15fabce5b65898b32b03f5ed25e9f891a729ad4c0d6d877110a7744aa847a894"
# Images are served from Cloudinary; these extensions may not be referenced
# from content as local files (the originals stay in assets/ as upload sources).
# Same set as the upload skill's imageExt and as IMAGE_SUFFIXES in
# tools/rst_convert.py — widen all three together or a format slips the policy.
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp",
              ".tiff", ".tif", ".avif", ".heic", ".heif")
CLOUDINARY_RE = re.compile(r"https?://res\.cloudinary\.com/[^\s)\"'<>\]]+")
# a delivery-URL segment that sits BEFORE the public_id: a version ('v1788…')
# or a transformation group ('f_auto,q_auto', 'w_800', 'c_fill,g_face').
DELIVERY_PREFIX_RE = re.compile(r"v\d+|[a-z]{1,3}_[^/,]+(?:,[a-z]{1,3}_[^/,]+)*")
SECRET_KEY_RE = re.compile(
    r"(password|passwd|pwd|api_key|apikey|api_secret|secret|token)", re.IGNORECASE)
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
EMAIL_OK = re.compile(r"@(github\.com|[\w.-]*\.local|example\.[a-z]+)$")

# ---- 1b. reader inputs -----------------------------------------------------
# Every key one of the site's three readers — js/app.js,
# tools/build_search_index.py and this script — dereferences WITHOUT a guard.
# A missing one is not cosmetic: the browser paints "undefined" into the page
# and the two Python readers die with a KeyError. The list follows the readers,
# but never requires a key the shipped data lacks (the rule when the two
# disagree is: report it, do not guess).
#
# MAINTENANCE: a new data/*.json registry, or a new bare dereference in
# js/app.js / tools/build_search_index.py / tools/check.py, must gain an entry
# here.
#
# Two registries are deliberately EXCLUDED, each already having its own
# dedicated and stricter validator:
#   data/cloudinary-manifest.json — section 6a (source/public_id/url + sha256);
#   data/people.json              — section 6c (exact field set, photo, link).
#
# Spec node shape:
#   {"keys":      (keys this object must carry,),
#    "lists":     (keys that must hold a LIST when present; entries not walked),
#    "types":     {key: python type its value must have when present},
#    "str_lists": (keys whose list MEMBERS must each be a string,),
#    "each":      {list key: spec node applied to every entry of that list},
#    "entries":   spec node applied to every entry of a top-level LIST document}
# A list named in "each" or "lists" but not in "keys" is optional: absent is
# fine, present is shape-checked.
#
# Why "lists" exists as well as "each": walking a list proves it IS one, so
# "each" keys get their shape checked for free. Lists of SCALARS are never
# walked, and a string in place of one is the dangerous case — it is not a type
# error to the readers, it is an iterable of characters. build_cad_shard() would
# emit a CAD shard of 3 single-letter "parts" from "abc", and section 3's
# set(old_pages["pages"]) would become a set of letters. Both used to pass this
# gate. Name every scalar-entry list a reader iterates.
#
# "types" / "str_lists" go one level deeper: the right container, a wrong VALUE
# type inside it. They are deliberately narrow — a value earns an entry only
# when a reader either CRASHES on the wrong type (Path(42); sorted() over mixed
# types) or is SILENTLY WRONG about it. The string "false" is the motivating
# case: it is truthy, so `if not r["isFork"]` misfiles the repo as a fork and
# build_search_index.py drops it from the code shard with no error anywhere.
# NOT a general string-ness check on every title/name — a reader that only
# renders a value through esc()/String() coerces it harmlessly, so 'hardware'
# and 'chips' members are out of scope.
TYPE_WORDS = {bool: "true or false", str: "a string", int: "a whole number"}
READER_REQUIRED_KEYS = {
    "data/site.json": {
        "keys": ("kicker", "title", "lead", "home_cards"),
        "each": {"home_cards": {"keys": ("href", "title", "text")}},
    },
    "data/setup.json": {
        "keys": ("sections",),
        "each": {"sections": {
            "keys": ("title", "pages"),
            "each": {"pages": {"keys": ("id", "title", "file"),
                               "types": {"id": str, "file": str}}}}},
    },
    "data/setup-structure.json": {
        "keys": ("groups", "dropped"),
        "each": {"groups": {"keys": ("pages",),
                            "each": {"pages": {"keys": ("old",)}}},
                 "dropped": {"keys": ("old",)}},
    },
    "data/projects.json": {
        "keys": ("projects", "intro"),
        "each": {"projects": {
                     "keys": ("id", "name", "tagline", "status", "file", "repos"),
                     "types": {"id": str, "file": str},
                     # optional; app.js renders (p.hardware || []).map(…)
                     "lists": ("hardware",),
                     "each": {"repos": {"keys": ("name", "url")},
                              # 'links' is optional; when present the About-style
                              # "See also" list dereferences both fields.
                              "links": {"keys": ("href", "label")}}},
                 # 'exclusions' is optional (section 4 reads it with .get()).
                 "exclusions": {"keys": ("name",)}},
    },
    "data/tools.json": {
        "keys": ("tools", "intro"),
        "each": {"tools": {"keys": ("id", "name", "tagline", "file"),
                           "types": {"id": str, "file": str},
                           # optional; app.js renders (t.chips || []).map(…)
                           "lists": ("chips",)}},
    },
    # a top-level list, not an object. isFork must be a real boolean:
    # build_search_index.py branches on it, and "false" is truthy. 'name' must
    # be a string: section 4 sorts org_names, and sorting mixed types raises.
    "data/org-repos.json": {"entries": {"keys": ("name", "isFork"),
                                        "types": {"name": str,
                                                  "isFork": bool}}},
    # section 3 does set(old_pages["pages"]) then sorts it — a non-string
    # member makes that sort raise
    "data/old-docs-pages.json": {"keys": ("pages",), "lists": ("pages",),
                                 "str_lists": ("pages",)},
    # Section 8 checks probe INTERNALS (q/expect/kind), but it reaches them via
    # p.get(), so a non-object entry crashes it before it can complain. "each"
    # with no required keys asks only "is every entry an object?" and leaves the
    # fields to section 8. It subsumes "lists" here — it reports the same
    # non-list message — so declaring both would just duplicate the error.
    "data/search-probes.json": {"keys": ("probes",),
                                "each": {"probes": {"keys": ()}}},
    # build_cad_shard() iterates cad["files"] and calls Path() on each
    "data/cad-tree.json": {"keys": ("repo", "files"), "lists": ("files",),
                           "str_lists": ("files",)},
}

# Content files the readers open by HARDCODED name. Files reached through a
# registry ('file' fields) are already checked by sections 2, 4 and 5.
READER_FIXED_PATHS = {
    "content/about.md": "js/app.js viewAbout() fetches it; "
                        "tools/build_search_index.py build_site_shard() indexes it",
}

errors = []


def err(msg):
    errors.append(msg)


def load(name):
    p = ROOT / name
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except FileNotFoundError:
        err(f"{name}: missing")
    except json.JSONDecodeError as e:
        err(f"{name}:{e.lineno}:{e.colno}: {e.msg} (strict JSON — no trailing commas, double quotes)")
    return None


def resolve_public_id(url, cloud, known):
    """Map a Cloudinary delivery URL onto a known public_id, or None.

    Accepts https://res.cloudinary.com/<cloud>/image/upload/[<transforms>/]
    [v<digits>/]<public_id>[.<ext>] so that adding a delivery transformation
    (f_auto,q_auto / w_800 / …) never breaks the gate. A foreign cloud or an
    unknown public_id still returns None — i.e. still fails.
    """
    prefix = f"https://res.cloudinary.com/{cloud}/"
    if not url.startswith(prefix):
        return None
    m = re.match(r"(?:image|video|raw)/(?:upload|fetch|private|authenticated)/(.+)$",
                 url[len(prefix):])
    if not m:
        return None
    seg = m.group(1).split("/")
    for start in range(len(seg)):
        # only version/transformation segments may precede the public_id
        if start and not DELIVERY_PREFIX_RE.fullmatch(seg[start - 1]):
            break
        cand = "/".join(seg[start:])
        for c in (cand, re.sub(r"\.[A-Za-z0-9]{1,5}$", "", cand)):
            if c in known:
                return c
    return None


def walk_json(node, path=""):
    """Yield (dotted-key-path, key-name, string value) for every string in a doc."""
    if isinstance(node, dict):
        for k, v in node.items():
            yield from walk_json(v, f"{path}.{k}" if path else str(k))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from walk_json(v, f"{path}[{i}]")
    elif isinstance(node, str):
        yield path, path.rsplit(".", 1)[-1].split("[")[0], node


def entry_label(path, entry):
    """Locate a list entry for a human: its id or name if it has one, else index."""
    if isinstance(entry, dict):
        for key in ("id", "name"):
            value = entry.get(key)
            if isinstance(value, str) and value.strip():
                return f"{path} ({key} '{value}')"
    return path


def check_reader_keys(name, node, spec, path="", label=""):
    """Report every reader-required key `node` is missing, recursively.

    `label` locates `node` inside the file ("" at the document root,
    "projects[3] (id 'x')" for a list entry). This never raises: a shape
    surprise (a string where a list belongs) is reported as a located error
    instead, so a caller can stop before a later section meets it.
    """
    at = f"{name}: {label} " if label else f"{name}: "
    if not isinstance(node, dict):
        err(f"{name}: {label or 'top level'} must be a JSON object, "
            f"got {type(node).__name__}")
        return
    for key in spec.get("keys", ()):
        if key not in node:
            err(f'{at}missing required key "{key}"')
    # scalar-entry lists: shape only — a string here is silently iterable
    declared_lists = spec.get("lists", ())
    for key in declared_lists:
        if key in node and not isinstance(node[key], list):
            err(f'{at}"{key}" must be a list, got {type(node[key]).__name__}')
    # value types a reader crashes on or is silently wrong about
    for key, expected in spec.get("types", {}).items():
        if key in node and not isinstance(node[key], expected):
            want = TYPE_WORDS.get(expected, expected.__name__)
            err(f'{at}"{key}" must be {want}, got {type(node[key]).__name__}')
    for key in spec.get("str_lists", ()):
        if key not in node:
            continue
        value = node[key]
        if not isinstance(value, list):
            # self-sufficient: a string would otherwise pass this loop happily,
            # every "member" being a one-character string.
            if key not in declared_lists:      # else "lists" already said so
                err(f'{at}"{key}" must be a list, got {type(value).__name__}')
            continue
        for i, item in enumerate(value):
            if not isinstance(item, str):
                err(f'{at}"{key}"[{i}] must be a string, '
                    f"got {type(item).__name__}")
    for key, child in spec.get("each", {}).items():
        if key not in node:
            continue          # optionality is decided by "keys", not by "each"
        value = node[key]
        if not isinstance(value, list):
            err(f'{at}"{key}" must be a list, got {type(value).__name__}')
            continue
        prefix = f"{path}.{key}" if path else key
        for i, item in enumerate(value):
            item_path = f"{prefix}[{i}]"
            check_reader_keys(name, item, child, item_path,
                              entry_label(item_path, item))


def check_reader_registry(name, doc, spec):
    """Apply one READER_REQUIRED_KEYS spec to one loaded registry."""
    entries = spec.get("entries")
    if entries is None:
        check_reader_keys(name, doc, spec)
        return
    if not isinstance(doc, list):
        err(f"{name}: top level must be a JSON list, got {type(doc).__name__}")
        return
    for i, item in enumerate(doc):
        path = f"[{i}]"
        check_reader_keys(name, item, entries, path, entry_label(path, item))


def main():
    site = load("data/site.json")
    setup = load("data/setup.json")
    structure = load("data/setup-structure.json")
    projects = load("data/projects.json")
    tools = load("data/tools.json")
    old_pages = load("data/old-docs-pages.json")
    org = load("data/org-repos.json")
    probes = load("data/search-probes.json")
    cad = load("data/cad-tree.json")
    cloudinary = load("data/cloudinary-manifest.json")
    if errors:
        report()

    # ---- 1b. reader inputs: required keys + fixed content paths ----
    # Runs before every cross-file section below, because those sections (and
    # the site itself) dereference these keys bare. Registry -> loaded document;
    # the two deliberate exclusions are documented at READER_REQUIRED_KEYS.
    registries = {
        "data/site.json": site,
        "data/setup.json": setup,
        "data/setup-structure.json": structure,
        "data/projects.json": projects,
        "data/tools.json": tools,
        "data/old-docs-pages.json": old_pages,
        "data/org-repos.json": org,
        "data/search-probes.json": probes,
        "data/cad-tree.json": cad,
    }
    for rel in sorted(set(READER_REQUIRED_KEYS) - set(registries)):
        err(f"{rel}: has a READER_REQUIRED_KEYS entry but no load() call in "
            f"tools/check.py — add one so a syntax error is located too")
    for rel, spec in READER_REQUIRED_KEYS.items():
        if rel in registries:
            check_reader_registry(rel, registries[rel], spec)
    for rel, consumers in READER_FIXED_PATHS.items():
        if not (ROOT / rel).is_file():
            err(f"{rel}: missing — {consumers}")
    if errors:
        report()

    # ---- 2. setup manifest <-> files ----
    setup_ids = set()
    referenced_md = set()
    for sec in setup["sections"]:
        for p in sec["pages"]:
            if p["id"] in setup_ids:
                err(f"setup.json: duplicate page id {p['id']}")
            setup_ids.add(p["id"])
            f = ROOT / p["file"]
            referenced_md.add(f.resolve())
            if not f.exists():
                err(f"setup.json: {p['id']} points at missing file {p['file']}")
            if not p.get("title"):
                err(f"setup.json: {p['id']} has no title")

    on_disk = {q.resolve() for q in (ROOT / "content" / "setup").rglob("*.md")}
    for orphan in sorted(on_disk - referenced_md):
        err(f"orphan content file (not in setup.json): {orphan.relative_to(ROOT)}")
    # (missing files already reported above)

    # ---- 3. parity: old pages disposed exactly once ----
    disposed = {}
    for g in structure["groups"]:
        for p in g["pages"]:
            disposed.setdefault(p["old"].removeprefix("contents/") if False else p["old"], []).append("migrated")
    for d in structure["dropped"]:
        disposed.setdefault(d["old"], []).append("dropped")
    old_set = set(old_pages["pages"])
    for page in sorted(old_set):
        n = len(disposed.get(page, []))
        if n == 0:
            err(f"parity: old page '{page}' has no disposition (add to a group or dropped list)")
        elif n > 1:
            err(f"parity: old page '{page}' disposed {n} times")
    for page in sorted(set(disposed) - old_set):
        err(f"parity: structure names unknown old page '{page}'")
    parity_md = ROOT / "docs" / "setup-parity.md"
    if not parity_md.exists():
        err("docs/setup-parity.md missing — run tools/rst_convert.py")
    else:
        m = re.search(r"Pages found: (\d+) · migrated: (\d+) · dropped: (\d+)",
                      parity_md.read_text(encoding="utf-8"))
        if not m:
            err("docs/setup-parity.md: counts line missing")
        elif int(m.group(1)) != len(old_set):
            err(f"docs/setup-parity.md counts stale ({m.group(1)} vs {len(old_set)} old pages) — re-run tools/rst_convert.py")

    # ---- 4. projects coverage ----
    org_names = {r["name"] for r in org}
    seen = {}
    for pr in projects["projects"]:
        f = ROOT / pr["file"]
        if not f.exists():
            err(f"projects.json: {pr['id']} points at missing file {pr['file']}")
        if pr["status"] not in ("active", "maintained", "legacy", "archive"):
            err(f"projects.json: {pr['id']} has unknown status '{pr['status']}'")
        for r in pr["repos"]:
            if r.get("external"):
                continue
            seen.setdefault(r["name"], []).append(pr["id"])
    for x in projects.get("exclusions", []):
        seen.setdefault(x["name"], []).append("excluded")
        if not x.get("reason"):
            err(f"projects.json: exclusion '{x['name']}' has no reason")
    for name in sorted(org_names):
        n = len(seen.get(name, []))
        if n == 0:
            err(f"projects coverage: org repo '{name}' is in no project and not excluded")
        elif n > 1:
            err(f"projects coverage: org repo '{name}' appears {n} times ({seen[name]})")
    for name in sorted(set(seen) - org_names):
        err(f"projects.json names unknown org repo '{name}' (update data/org-repos.json?)")

    # ---- 5. tools ----
    tool_ids = set()
    for t in tools["tools"]:
        tool_ids.add(t["id"])
        if not (ROOT / t["file"]).exists():
            err(f"tools.json: {t['id']} points at missing file {t['file']}")

    # ---- 6. content links + assets ----
    project_ids = {p["id"] for p in projects["projects"]}
    md_files = sorted((ROOT / "content").rglob("*.md"))
    used_assets = set()
    link_re = re.compile(r"\]\(([^)\s]+)\)")
    html_ref_re = re.compile(r'(?:src|href)="([^"]+)"')
    # embedded images only — a plain hyperlink that happens to point at a .svg
    # elsewhere on the web is a link, not an image this site serves.
    img_md_re = re.compile(r"!\[[^\]]*\]\(([^)\s]+)\)")
    img_html_re = re.compile(r"""<img[^>]*?\ssrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>"']+))""",
                             re.IGNORECASE)

    def check_route(route, where):
        route = route.split("@")[0]
        seg = [s for s in route.lstrip("#/").split("/") if s]
        if not seg:
            return
        if seg[0] == "setup":
            if len(seg) > 1 and "/".join(seg[1:]) not in setup_ids:
                err(f"{where}: broken internal link {route}")
        elif seg[0] == "projects":
            if len(seg) > 1 and seg[1] not in project_ids:
                err(f"{where}: broken internal link {route}")
        elif seg[0] == "tools":
            if len(seg) > 1 and seg[1] not in tool_ids:
                err(f"{where}: broken internal link {route}")
        elif seg[0] not in ("about", "search"):
            err(f"{where}: unknown route {route}")

    def is_image(href):
        return href.split("?")[0].split("#")[0].lower().endswith(IMAGE_EXTS)

    def is_local_asset(href):
        return href.split("?")[0].lstrip("./").startswith("assets/")

    for md in md_files:
        rel = md.relative_to(ROOT)
        text = md.read_text(encoding="utf-8")
        targets = link_re.findall(text) + html_ref_re.findall(text)
        # every image the page actually embeds, however it is quoted
        embedded = set(img_md_re.findall(text))
        embedded |= {a or b or c for a, b, c in img_html_re.findall(text)}
        for href in targets:
            if href.startswith("#/"):
                check_route(href, str(rel))
            elif href.startswith(("http://", "https://", "mailto:")):
                continue
            elif href.startswith("#"):
                continue  # same-page anchor
            else:
                if not (ROOT / href).exists():
                    err(f"{rel}: missing local file {href}")
                else:
                    used_assets.add((ROOT / href).resolve())
        # images are served from Cloudinary — a local one means a migration was
        # missed (non-image downloads stay local)
        for ref in sorted(set(targets) | embedded):
            if is_local_asset(ref) and is_image(ref):
                err(f"{rel}: local image reference '{ref}' — images must be uploaded "
                    f"to Cloudinary and referenced via data/cloudinary-manifest.json")
        # …and an embedded image may not hang off somebody else's host either
        for src in sorted(embedded):
            if src.startswith(("http://", "https://")) \
                    and not src.startswith("https://res.cloudinary.com/"):
                err(f"{rel}: image embedded from a foreign host '{src}' — upload it to "
                    f"Cloudinary and reference it via data/cloudinary-manifest.json")

    # ---- 6a. cloudinary manifest <-> references ----
    index_text = (ROOT / "index.html").read_text(encoding="utf-8")
    people_path = ROOT / "data" / "people.json"          # may not exist yet
    scanned = [(str(m.relative_to(ROOT)), m.read_text(encoding="utf-8")) for m in md_files]
    scanned.append(("index.html", index_text))
    if people_path.exists():
        scanned.append(("data/people.json", people_path.read_text(encoding="utf-8")))

    cloud = cloudinary.get("cloud") or ""
    if not cloud:
        err("data/cloudinary-manifest.json: no 'cloud' name")
    manifest_sources = set()
    public_ids, urls, sources = set(), set(), set()
    for e in cloudinary.get("assets", []):
        src, pid, url = e.get("source"), e.get("public_id"), e.get("url")
        if not (src and pid and url):
            err(f"data/cloudinary-manifest.json: entry missing source/public_id/url: {e}")
            continue
        for value, seen, what in ((src, sources, "source"), (url, urls, "url"),
                                  (pid, public_ids, "public_id")):
            if value in seen:
                err(f"data/cloudinary-manifest.json: duplicate {what} '{value}'")
            seen.add(value)
        # The digest is what makes drift detectable, so it is mandatory: an entry
        # without one would otherwise count as a valid source and quietly opt out
        # of the guarantee below.
        recorded = e.get("sha256")
        digest_ok = isinstance(recorded, str) and re.fullmatch(r"[0-9a-f]{64}", recorded)
        if not digest_ok:
            err(f"data/cloudinary-manifest.json: manifest entry {pid}: missing/invalid "
                f"sha256 — required for source drift detection")
        p = ROOT / src
        if not p.exists():
            err(f"data/cloudinary-manifest.json: source file missing on disk: {src} "
                f"(the local original is the upload source — do not delete it)")
        else:
            manifest_sources.add(p.resolve())
            # Drift guard: edit the local original and the site would keep
            # serving the OLD remote image. Only sha256 is compared — 'bytes'
            # is what Cloudinary stored after its own processing and legitimately
            # differs from the source (it does for the two GIFs).
            digest = hashlib.sha256(p.read_bytes()).hexdigest()
            if digest_ok and digest != recorded:
                err(f"data/cloudinary-manifest.json: {src} changed since upload "
                    f"({digest[:12]}… vs {recorded[:12]}…) — re-upload it and "
                    f"refresh the manifest, or the site serves the old image")
        if cloud and not url.startswith(f"https://res.cloudinary.com/{cloud}/"):
            err(f"data/cloudinary-manifest.json: url for {pid} is not on cloud "
                f"'{cloud}': {url}")

    referenced_ids = set()
    for where, text in scanned:
        for url in CLOUDINARY_RE.findall(text):
            url = url.rstrip(".,;:")
            pid = resolve_public_id(url, cloud, public_ids)
            if pid is None:
                err(f"{where}: Cloudinary reference with no manifest entry: {url} "
                    f"(upload it and re-run the manifest step)")
            else:
                referenced_ids.add(pid)
    for pid in sorted(public_ids - referenced_ids):
        err(f"orphan cloudinary asset (uploaded but nothing references it): {pid}")

    # ---- 6c. people roster (data/people.json — optional; older checkouts) ----
    if people_path.exists():
        people = load("data/people.json")
        # Container types first: the About page swallows a malformed roster and
        # renders nobody, so an empty or wrongly-shaped 'groups' must fail here
        # rather than quietly ship a people-less page.
        if not isinstance(people, dict):
            err(f"data/people.json: top level must be an object with a 'groups' list, "
                f"got {type(people).__name__}")
        elif not isinstance(people.get("groups"), list):
            err(f"data/people.json: 'groups' must be a list, got "
                f"{type(people.get('groups')).__name__}")
        elif not people["groups"]:
            err("data/people.json: 'groups' is empty — the About page would render "
                "no people at all")
        else:
            group_ids = set()
            for gi, g in enumerate(people["groups"]):
                if not isinstance(g, dict):
                    err(f"data/people.json: group #{gi} must be an object, got "
                        f"{type(g).__name__}")
                    continue
                where = f"data/people.json: group {g.get('id') or f'#{gi}'}"
                if not (isinstance(g.get("id"), str) and g["id"].strip()):
                    err(f"{where}: 'id' must be a non-empty string")
                if not (isinstance(g.get("title"), str) and g["title"].strip()):
                    err(f"{where}: 'title' must be a non-empty string")
                if g.get("id") in group_ids:
                    err(f"{where}: duplicate group id")
                group_ids.add(g.get("id"))
                if not isinstance(g.get("people"), list):
                    err(f"{where}: 'people' must be a list, got "
                        f"{type(g.get('people')).__name__}")
                    continue
                for pi, p in enumerate(g["people"]):
                    if not isinstance(p, dict):
                        err(f"{where}: person #{pi} must be an object, got "
                            f"{type(p).__name__}")
                        continue
                    who = f"data/people.json: {p.get('name') or '<unnamed>'}"
                    extra = sorted(set(p) - {"name", "title", "photo", "link"})
                    if extra:
                        err(f"{who}: unknown field(s) {extra} — a person is exactly "
                            f"name/title/photo/link (typo?)")
                    for key in ("name", "title", "photo", "link"):
                        if key not in p:
                            err(f"{who}: missing '{key}'")
                    if not (isinstance(p.get("name"), str) and p["name"].strip()):
                        err(f"{who}: 'name' must be a non-empty string")
                    if not isinstance(p.get("title"), str):
                        err(f"{who}: 'title' must be a string (\"\" is allowed)")
                    photo = p.get("photo")
                    if photo is not None:
                        if not isinstance(photo, str) or not photo.startswith("https://"):
                            err(f"{who}: 'photo' must be null or an https URL")
                        elif resolve_public_id(photo, cloud, public_ids) is None:
                            err(f"{who}: photo is not in data/cloudinary-manifest.json: "
                                f"{photo} — upload it and refresh the manifest")
                    link = p.get("link")
                    if link is not None and not (isinstance(link, str)
                                                 and link.startswith(("http://", "https://"))):
                        err(f"{who}: 'link' must be null or an http(s) URL")

    asset_dir = ROOT / "assets"
    always_used = {(asset_dir / "hippo.svg").resolve()}
    for a in sorted(asset_dir.rglob("*")):
        # a manifest source counts as used: kept originals are upload sources
        # and the local fallback, not orphans.
        if a.is_file() and a.resolve() not in used_assets | always_used | manifest_sources:
            err(f"orphan asset (nothing references it): {a.relative_to(ROOT)}")

    # ---- 6b. content hygiene: no credentials or personal data, ever ----
    email_ok = EMAIL_OK
    for md in md_files:
        rel = md.relative_to(ROOT)
        for i, line in enumerate(md.read_text(encoding="utf-8").splitlines(), 1):
            m = re.search(r"(?<![A-Za-z0-9_])[\"']?(plain_text_passwd|password|passwd|pwd)[\"']?\s*[:=]\s*[\"']?([^\s\"']+)",
                          line, re.IGNORECASE)
            if m and not m.group(2).startswith(("<", "$")) \
                    and m.group(2).lower() not in ("false", "true", "none", "null"):
                err(f"{rel}:{i}: literal credential value ('{m.group(1)}') — use a <placeholder>")
            if re.search(r"ssh-(rsa|ed25519|ecdsa|dss)\s+[A-Za-z0-9+/=]{30,}", line):
                err(f"{rel}:{i}: real SSH public key material — use <your-ssh-public-key>")
            for em in re.findall(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", line):
                if not email_ok.search(em) and em != "git@github.com":
                    err(f"{rel}:{i}: personal email address '{em}' — do not republish personal data")

    # the same hygiene rules over the JSON side of the site: registries and the
    # MCP wiring. A key NAMED like a credential must not carry a literal value
    # ('sha256' is a checksum, not a secret, and never matches).
    json_files = sorted((ROOT / "data").glob("*.json"))
    if (ROOT / ".mcp.json").exists():
        json_files.append(ROOT / ".mcp.json")
    for jf in json_files:
        rel = jf.relative_to(ROOT)
        try:
            doc = json.loads(jf.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            err(f"{rel}:{e.lineno}:{e.colno}: {e.msg} (strict JSON)")
            continue
        for keypath, key, value in walk_json(doc):
            if SECRET_KEY_RE.search(key) and value.strip() \
                    and not value.startswith(("$", "<")):
                err(f"{rel}: literal credential value at '{keypath}' — use a "
                    f"<placeholder> or a ${{ENV_VAR}} reference")
            for em in EMAIL_RE.findall(value):
                if not email_ok.search(em) and em != "git@github.com":
                    err(f"{rel}: personal email address '{em}' at '{keypath}' — "
                        f"do not republish personal data")

    # ---- 7. shell ----
    index = index_text
    for ref in html_ref_re.findall(index):
        if ref.startswith(("http", "#", "data:")):
            continue
        if not (ROOT / ref).exists():
            err(f"index.html: missing referenced file {ref}")
    marked = ROOT / "js" / "marked.min.js"
    if not marked.exists():
        err("js/marked.min.js missing")
    else:
        digest = hashlib.sha256(marked.read_bytes()).hexdigest()
        if digest != MARKED_SHA256:
            err(f"js/marked.min.js sha256 mismatch ({digest[:12]}…) — if you upgraded marked "
                f"on purpose, update MARKED_SHA256 in tools/check.py and note it in README.md")

    # ---- 8. probes ----
    plist = probes["probes"]
    if len(plist) != 10:
        err(f"search-probes.json: expected exactly 10 probes, found {len(plist)}")
    for p in plist:
        if not (p.get("q") and p.get("expect") and p.get("kind")):
            err(f"search-probes.json: malformed probe {p}")

    report(site)


def report(site=None):
    if errors:
        print(f"CHECK FAILED — {len(errors)} problem(s):")
        for e in errors:
            print(f"  ✗ {e}")
        sys.exit(1)
    print("check.py: all green")
    print("reminder: URL liveness is checked by tools/check_urls.py — run it when "
          "images, links, or the manifest changed")
    sys.exit(0)


if __name__ == "__main__":
    # A traceback is never an acceptable gate result: it reads as "the tool is
    # broken" when it usually means "the content is malformed". Exception (NOT
    # BaseException) is deliberate — report() ends the run with sys.exit, whose
    # SystemExit must pass through untouched.
    try:
        main()
    except Exception as exc:
        print(f"check.py: internal error while validating — a malformed entry "
              f"or a checker bug; details: {exc!r}")
        sys.exit(1)
