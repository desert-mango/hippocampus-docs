#!/usr/bin/env python3
# Author: Kyle Nelson
# Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
# Last substantive modification: 29 September 2026
# Affiliation: TUHH HippoCampus Robotics
# Purpose: Hold the one copy of the text-safety patterns and the GitHub-layer rules the gate and builder share.
"""Rules shared by tools/check.py and tools/build_github_data.py (plan D-B2).

ONE copy of:
  * the e-mail pattern of the 6b hygiene scan (EMAIL_RE / EMAIL_OK) and the
    active-markup scanner of the 6d content-safety scan (scan_markup and the
    patterns under it, EVENT_ATTR_RE among them). check.py imports them from
    here; the builder redacts against exactly these patterns, so a commit
    message such as "Bump onnx==1.17" can never turn the gate red.
  * section 11 of the gate: the public shapes of the four GitHub-layer files
    under data/graph/ (org-activity, github-repos, page-authors,
    people-public) and their avatars, and the data/github-links.json block.
    The builder runs check_github_layer() on its outputs BEFORE it writes
    them, so builder and gate cannot disagree.

Two kinds of rule, on purpose. HARD rules (check_github_layer,
check_github_links) depend on the files themselves only: exact key sets (the
proof that no per-person "who did what" reaches a guest-fetchable file), no
e-mail-shaped text, no '<' or '>' in names/messages/descriptions, avatars that
are real PNG/JPEG files of at most 16 KB, public repositories only. NOTES
(github_layer_notes, github_links_notes) compare against the registries —
pages, roster names, the org snapshot — and are printed, never red: pull
request CI does not rebuild the GitHub files, so a roster rename, a page
removal or a repository drop must not turn a pull request red with no fix
possible inside it. Nothing here compares against the current date.
"""
import html
import re

# ---- 6b: e-mail addresses -------------------------------------------------
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
EMAIL_OK = re.compile(r"@(github\.com|[\w.-]*\.local|example\.[a-z]+)$")

# ---- 6d: active markup ----------------------------------------------------
UNSAFE_TAGS = ("script", "iframe", "object", "embed", "form", "meta", "link",
               "style", "base", "svg")
# the tag name must END there: '<base-url>' and '<link-name>' are placeholders
UNSAFE_TAG_RE = re.compile(
    r"<(" + "|".join(UNSAFE_TAGS) + r")(?=[\s/>]|$)", re.IGNORECASE)
# any on*= attribute; '/' and quotes separate attributes as well as spaces do
EVENT_ATTR_RE = re.compile(r"(?:^|(?<=[\s/\"'`]))(on[a-z]+)\s*=",
                           re.IGNORECASE | re.MULTILINE)
SRCDOC_RE = re.compile(r"(?<![\w-])srcdoc\s*=", re.IGNORECASE)
# where a link target starts: a Markdown inline link/image, a reference
# definition, a CommonMark autolink, or an href/src attribute (any quoting).
# The WHOLE value is captured, never a bounded prefix: browsers strip any
# amount of leading whitespace (raw or as character references) first.
LINK_TARGET_RES = (
    re.compile(r"\]\(\s*<?([^)]*)"),
    re.compile(r"^ {0,3}\[[^\]]+\]:\s*<?(\S+)", re.MULTILINE),
    re.compile(r"<([a-z][a-z0-9+.\-]{1,31}:[^\s<>]*)>", re.IGNORECASE),
    re.compile(r"(?<![\w-])(?:href|src)\s*=\s*[\"'`]?([^\"'`>]*)",
               re.IGNORECASE),
)
UNSAFE_SCHEMES = ("javascript:", "vbscript:", "data:text/html")


def unsafe_scheme(target):
    """The forbidden scheme a link target starts with, or None.

    Browsers drop ASCII whitespace/control characters inside a URL scheme and
    decode character references first, so 'java&#58;script' and 'java<TAB>
    script:' are the same attack as 'javascript:' and are normalised the same.
    """
    flat = re.sub(r"[\x00-\x20]", "", html.unescape(target)).lower()
    return next((s for s in UNSAFE_SCHEMES if flat.startswith(s)), None)


def scan_markup(text):
    """Every forbidden construct in `text`, as sorted (line, token) pairs."""
    hits = []
    for m in UNSAFE_TAG_RE.finditer(text):
        hits.append((m.start(), f"<{m.group(1).lower()}>"))
    for m in EVENT_ATTR_RE.finditer(text):
        hits.append((m.start(1), f"{m.group(1).lower()}="))
    for m in SRCDOC_RE.finditer(text):
        hits.append((m.start(), "srcdoc="))
    for rx in LINK_TARGET_RES:
        for m in rx.finditer(text):
            scheme = unsafe_scheme(m.group(1))
            if scheme:
                hits.append((m.start(1), scheme))
    out = []
    for pos, tok in sorted(set(hits)):
        line = text.count("\n", 0, pos) + 1
        if (line, tok) not in out:
            out.append((line, tok))
    return out


# ---- redaction (the builder's side of the same patterns) ------------------
REDACTED = "[redacted]"


def redact(text):
    """(clean text, [reason, ...]) for one free-text string from GitHub.

    '<' and '>' are stripped silently (they never reach an output). Then every
    e-mail-shaped substring (EMAIL_RE, with no allowlist) and every on…= word
    (EVENT_ATTR_RE) and srcdoc= becomes [redacted]. Anything scan_markup still
    finds after that (a javascript: link target) redacts the whole string.
    Never raises: free text is redacted, never a reason to abort.
    """
    if not isinstance(text, str):
        return text, []
    reasons = []
    out = text.replace("<", "").replace(">", "")
    if EMAIL_RE.search(out):
        out = EMAIL_RE.sub(REDACTED, out)
        reasons.append("e-mail-shaped text")
    if EVENT_ATTR_RE.search(out):
        out = EVENT_ATTR_RE.sub(
            lambda m: m.group(0).replace(m.group(1), REDACTED, 1), out)
        reasons.append("on…= text")
    if SRCDOC_RE.search(out):
        out = SRCDOC_RE.sub(REDACTED, out)
        reasons.append("srcdoc= text")
    if scan_markup(out):
        out = REDACTED
        reasons.append("script-capable link text")
    return out, reasons


# ---- section 11: the GitHub layer -----------------------------------------
GRAPH = "data/graph"
AVATAR_DIR = f"{GRAPH}/avatars"
AVATAR_MAX_BYTES = 16 * 1024
ORG = "HippoCampusRobotics"
THIS_REPO = "desert-mango/hippocampus-docs"
OLD_DOCS_REPO = f"{ORG}/docs"
MSG_MAX = 100
FILES = {
    "org-activity": f"{GRAPH}/org-activity.json",
    "github-repos": f"{GRAPH}/github-repos.json",
    "page-authors": f"{GRAPH}/page-authors.json",
    "people-public": f"{GRAPH}/people-public.json",
}
LINKS_FILE = "data/github-links.json"
# GitHub profile fields that must never reach an output: one of these as a KEY
# in an output is a structural leak (the builder aborts; the exact key sets
# below make the gate red).
PROFILE_KEYS = frozenset({
    "email", "location", "company", "bio", "blog", "twitter_username",
    "hireable", "followers", "following", "public_repos", "public_gists",
    "notification_email", "private_gists", "total_private_repos",
    "owned_private_repos", "disk_usage", "collaborators",
    "two_factor_authentication", "plan"})

TOP_KEYS = {
    "org-activity": {"generated", "read_at", "org", "window_days", "totals",
                     "weeks", "recent_commits", "most_active_repos", "releases",
                     "truncated"},
    "github-repos": {"generated", "read_at", "org", "repos"},
    "page-authors": {"generated", "read_at", "note", "prs_read", "pages"},
    "people-public": {"generated", "read_at", "org", "note", "people"},
}
TOTALS_KEYS = {"public_repos", "commits_365d", "authors_365d",
               "repos_touched_365d", "stars", "forks", "open_issues", "releases"}
WEEK_KEYS = {"week", "days"}
COMMIT_KEYS = {"repo", "sha", "date", "msg"}
ACTIVE_REPO_KEYS = {"name", "commits", "language", "pushed_at"}
RELEASE_KEYS = {"repo", "tag", "name", "date"}
REPO_KEYS = {"name", "description", "language", "stars", "forks", "open_issues",
             "pushed_at", "archived", "fork", "private", "commits_365d", "html_url"}
PAGE_KEYS = {"original", "converted", "edited_here"}
ORIGINAL_KEYS = {"repo", "path", "authors", "history_read", "blob"}
AUTHOR_KEYS = {"login", "name"}
CONVERTED_KEYS = {"date", "by", "tool", "commit"}
EDIT_KEYS = {"pr", "by", "state"}
EDIT_STATES = ("open", "merged", "closed")
PERSON_KEYS = {"login", "name", "avatar", "html_url", "roster"}
FREE_TEXT_KEYS = ("name", "msg", "description")

# The whole shape, leaf by leaf: a dict names an object's keys, a one-item list
# a list whose items all follow that item, ("each", spec) an object keyed by
# any name (repo, page id, login) whose values follow spec, ("nullable", spec)
# that spec or null, and LEAF a plain value — str, number, bool or null. So an
# object or a list can sit ONLY where the shape names one (HARD rule).
LEAF = "leaf"


def _leaves(keys):
    return {k: LEAF for k in keys}


SHAPES = {
    "org-activity": {**_leaves(TOP_KEYS["org-activity"]),
                     "totals": _leaves(TOTALS_KEYS),
                     "weeks": [{"week": LEAF, "days": [LEAF]}],
                     "recent_commits": [_leaves(COMMIT_KEYS)],
                     "most_active_repos": [_leaves(ACTIVE_REPO_KEYS)],
                     "releases": [_leaves(RELEASE_KEYS)],
                     "truncated": [LEAF]},
    "github-repos": {**_leaves(TOP_KEYS["github-repos"]),
                     "repos": ("each", _leaves(REPO_KEYS))},
    "page-authors": {**_leaves(TOP_KEYS["page-authors"]),
                     "prs_read": [LEAF],
                     "pages": ("each", {
                         "original": {**_leaves(ORIGINAL_KEYS),
                                      "authors": [_leaves(AUTHOR_KEYS)]},
                         "converted": ("nullable", _leaves(CONVERTED_KEYS)),
                         "edited_here": [_leaves(EDIT_KEYS)]})},
    "people-public": {**_leaves(TOP_KEYS["people-public"]),
                      "people": ("each", _leaves(PERSON_KEYS))},
}
SCALARS = (str, int, float, bool, type(None))


def _leaf_types(rep, node, spec, path):
    """Every value the shape calls a leaf is a plain value. A container in the
    wrong place is reported by the key/list checks, so it is skipped here."""
    if spec == LEAF:
        if not isinstance(node, SCALARS):
            kind = "an object" if isinstance(node, dict) else \
                "a list" if isinstance(node, list) else type(node).__name__
            rep.add(f"'{path}' must be a plain value (text, number, true/false or "
                    f"null), got {kind} — nothing may hide under a public key")
    elif isinstance(spec, tuple) and spec[0] == "nullable":
        if node is not None:
            _leaf_types(rep, node, spec[1], path)
    elif isinstance(spec, tuple) and spec[0] == "each":
        if isinstance(node, dict):
            for k, v in node.items():
                _leaf_types(rep, v, spec[1], f"{path}.{k}")
    elif isinstance(spec, list):
        if isinstance(node, list):
            for i, v in enumerate(node):
                _leaf_types(rep, v, spec[0], f"{path}[{i}]")
    elif isinstance(node, dict):
        for k, sub in spec.items():
            if k in node:
                _leaf_types(rep, node[k], sub, f"{path}.{k}" if path else k)


DAY_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
SHA7_RE = re.compile(r"[0-9a-f]{7}")
SHA40_RE = re.compile(r"[0-9a-f]{40}")
LOGIN_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})")
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
JPEG_MAGIC = b"\xff\xd8\xff"


def sniff_image(data):
    """'png' or 'jpg' by magic bytes, else None (never SVG, never text)."""
    if not isinstance(data, (bytes, bytearray)):
        return None
    if data.startswith(PNG_MAGIC):
        return "png"
    if data.startswith(JPEG_MAGIC):
        return "jpg"
    return None


def avatar_path(login, kind):
    return f"{AVATAR_DIR}/{login}.{kind}"


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def _walk(node, path=""):
    """(path, key, value) for every string VALUE and every dict KEY."""
    if isinstance(node, dict):
        for k, v in node.items():
            here = f"{path}.{k}" if path else str(k)
            yield here, None, str(k)
            yield from _walk(v, here)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from _walk(v, f"{path}[{i}]")
    elif isinstance(node, str):
        yield path, path.rsplit(".", 1)[-1].split("[")[0], node


# the one place a profile-field NAME is legitimately a key: the org's count of
# public repositories in org-activity's totals tiles
NOT_PROFILE_PATHS = frozenset({"totals.public_repos"})


def profile_key_leaks(doc, path=""):
    """Every dict key in `doc` that is a GitHub profile field (a structural leak)."""
    out = []
    if isinstance(doc, dict):
        for k, v in doc.items():
            here = f"{path}.{k}" if path else str(k)
            if k in PROFILE_KEYS and here not in NOT_PROFILE_PATHS:
                out.append(here)
            out += profile_key_leaks(v, here)
    elif isinstance(doc, list):
        for i, v in enumerate(doc):
            out += profile_key_leaks(v, f"{path}[{i}]")
    return out


class _Report:
    def __init__(self, where):
        self.where = where
        self.out = []

    def add(self, msg):
        self.out.append(f"{self.where}: {msg}")

    def keys(self, node, want, label):
        if not isinstance(node, dict):
            self.add(f"{label} must be an object, got {type(node).__name__}")
            return False
        extra, missing = sorted(set(node) - want), sorted(want - set(node))
        if extra:
            self.add(f"{label} has key(s) {extra} that are not public — exactly "
                     f"{sorted(want)} (members-only data never reaches this file)")
        if missing:
            self.add(f"{label} is missing key(s) {missing} — exactly {sorted(want)}")
        return True

    def entries(self, node, key, want, label):
        rows = node.get(key) if isinstance(node, dict) else None
        if not isinstance(rows, list):
            self.add(f"{label}'{key}' must be a list")
            return []
        good = []
        for i, row in enumerate(rows):
            if self.keys(row, want, f"{label}'{key}'[{i}]"):
                good.append((i, row))
        return good


def _text_rules(rep, doc):
    """E-mail shapes anywhere (no allowlist), no '<'/'>' in free text."""
    for path, key, value in _walk(doc):
        if EMAIL_RE.search(value):
            rep.add(f"e-mail-shaped text at '{path}' — the builder redacts these; "
                    f"re-run tools/build_github_data.py")
        if key in FREE_TEXT_KEYS and ("<" in value or ">" in value):
            rep.add(f"'<' or '>' in '{path}' — GitHub text never carries markup "
                    f"here; re-run tools/build_github_data.py")


def _check_org_activity(doc, rep):
    if not rep.keys(doc, TOP_KEYS["org-activity"], "top level"):
        return
    if rep.keys(doc.get("totals"), TOTALS_KEYS, "'totals'"):
        for k, v in doc["totals"].items():
            if k in TOTALS_KEYS and not (_is_int(v) and v >= 0):
                rep.add(f"'totals.{k}' must be a whole number >= 0, got {v!r}")
    if not _is_int(doc.get("window_days")):
        rep.add("'window_days' must be a whole number")
    for i, week in rep.entries(doc, "weeks", WEEK_KEYS, ""):
        days = week.get("days")
        if not (isinstance(days, list) and len(days) == 7
                and all(d is None or (_is_int(d) and d >= 0) for d in days)):
            rep.add(f"'weeks'[{i}].days must be 7 counts (null for days to come)")
    for i, c in rep.entries(doc, "recent_commits", COMMIT_KEYS, ""):
        if not (isinstance(c.get("sha"), str) and SHA7_RE.fullmatch(c["sha"])):
            rep.add(f"'recent_commits'[{i}].sha must be the 7-character form")
        msg = c.get("msg")
        if not isinstance(msg, str) or "\n" in msg or len(msg) > MSG_MAX:
            rep.add(f"'recent_commits'[{i}].msg must be one line of at most "
                    f"{MSG_MAX} characters")
    rep.entries(doc, "most_active_repos", ACTIVE_REPO_KEYS, "")
    rep.entries(doc, "releases", RELEASE_KEYS, "")
    trunc = doc.get("truncated")
    if not (isinstance(trunc, list) and all(isinstance(t, str) for t in trunc)):
        rep.add("'truncated' must be a list of repository names")


def _check_github_repos(doc, rep):
    if not rep.keys(doc, TOP_KEYS["github-repos"], "top level"):
        return
    repos = doc.get("repos")
    if not isinstance(repos, dict):
        rep.add("'repos' must be an object keyed by repository name")
        return
    for name, row in repos.items():
        if not rep.keys(row, REPO_KEYS, f"repo '{name}'"):
            continue
        if row.get("private") is not False:
            rep.add(f"repo '{name}' has private={row.get('private')!r} — only public "
                    f"repositories may be published (private must be false)")
        if row.get("name") != name:
            rep.add(f"repo '{name}' is filed under the wrong name ({row.get('name')!r})")
        for flag in ("fork", "archived"):
            if not isinstance(row.get(flag), bool):
                rep.add(f"repo '{name}'.{flag} must be true or false")


def _check_page_authors(doc, rep):
    if not rep.keys(doc, TOP_KEYS["page-authors"], "top level"):
        return
    prs = doc.get("prs_read")
    if not (isinstance(prs, list) and all(_is_int(n) for n in prs)):
        rep.add("'prs_read' must be a list of pull request numbers")
    pages = doc.get("pages")
    if not isinstance(pages, dict):
        rep.add("'pages' must be an object keyed by page id")
        return
    for key, page in pages.items():
        label = f"page '{key}'"
        if not rep.keys(page, PAGE_KEYS, label):
            continue
        orig = page.get("original")
        if rep.keys(orig, ORIGINAL_KEYS, f"{label}.original"):
            repo, blob = orig.get("repo"), orig.get("blob")
            if repo == THIS_REPO:
                if not (isinstance(blob, str) and SHA40_RE.fullmatch(blob)):
                    rep.add(f"{label}.original.blob must be the page file's blob "
                            f"sha (history in {THIS_REPO})")
            elif repo == OLD_DOCS_REPO:
                if blob is not None:
                    rep.add(f"{label}.original.blob must be null (history in the "
                            f"old docs repository)")
            else:
                rep.add(f"{label}.original.repo must be '{THIS_REPO}' or "
                        f"'{OLD_DOCS_REPO}', got {repo!r}")
            if not isinstance(orig.get("history_read"), bool):
                rep.add(f"{label}.original.history_read must be true or false")
            for i, a in rep.entries(orig, "authors", AUTHOR_KEYS, f"{label}.original."):
                if not (a.get("login") is None or isinstance(a.get("login"), str)):
                    rep.add(f"{label}.original.authors[{i}].login must be a string or null")
        conv = page.get("converted")
        if conv is not None:
            rep.keys(conv, CONVERTED_KEYS, f"{label}.converted")
        for i, e in rep.entries(page, "edited_here", EDIT_KEYS, f"{label}."):
            if e.get("state") not in EDIT_STATES:
                rep.add(f"{label}.edited_here[{i}].state must be one of {EDIT_STATES}")


def _check_people_public(doc, rep, read_avatar):
    if not rep.keys(doc, TOP_KEYS["people-public"], "top level"):
        return
    people = doc.get("people")
    if not isinstance(people, dict):
        rep.add("'people' must be an object keyed by login")
        return
    for login, p in people.items():
        label = f"person '{login}'"
        if not rep.keys(p, PERSON_KEYS, label):
            continue
        if p.get("login") != login:
            rep.add(f"{label} is filed under the wrong login ({p.get('login')!r})")
        if p.get("html_url") != f"https://github.com/{login}":
            rep.add(f"{label}.html_url must be https://github.com/{login}")
        roster = p.get("roster")
        if not (roster is None or isinstance(roster, str)):
            rep.add(f"{label}.roster must be a roster name or null")
        avatar = p.get("avatar")
        if avatar is None:
            continue
        if avatar not in (avatar_path(login, "png"), avatar_path(login, "jpg")):
            rep.add(f"{label}.avatar must be null or {AVATAR_DIR}/{login}.png|jpg, "
                    f"got {avatar!r}")
            continue
        data = read_avatar(avatar)
        if data is None:
            rep.add(f"{label}.avatar {avatar} does not exist — re-run "
                    f"tools/build_github_data.py")
        elif sniff_image(data) != avatar.rsplit(".", 1)[1]:
            rep.add(f"{label}.avatar {avatar} is not a {avatar.rsplit('.', 1)[1].upper()} "
                    f"file by its magic bytes (avatars are PNG or JPEG, never SVG)")
        elif len(data) > AVATAR_MAX_BYTES:
            rep.add(f"{label}.avatar {avatar} is {len(data)} bytes — at most "
                    f"{AVATAR_MAX_BYTES}")


def check_avatar_files(names_and_bytes):
    """Every file under data/graph/avatars/ is a PNG/JPEG of <= 16 KB whose
    extension says what it is. `names_and_bytes`: [(file name, bytes)]."""
    out = []
    for name, data in names_and_bytes:
        ext = name.rsplit(".", 1)[-1] if "." in name else ""
        kind = sniff_image(data)
        if ext not in ("png", "jpg") or kind != ext:
            out.append(f"{AVATAR_DIR}/{name}: not a .png/.jpg file whose bytes are "
                       f"PNG/JPEG — avatars are never SVG or anything else; re-run "
                       f"tools/build_github_data.py")
        elif len(data) > AVATAR_MAX_BYTES:
            out.append(f"{AVATAR_DIR}/{name}: {len(data)} bytes — at most "
                       f"{AVATAR_MAX_BYTES}")
    return out


def check_github_layer(docs, read_avatar):
    """HARD rules over the four files. `docs` maps a FILES key to its parsed
    document, or None when the file is absent (absent is fine: the renderers
    show "not built yet"). `read_avatar(relative path)` -> bytes or None."""
    out = []
    checks = {"org-activity": _check_org_activity,
              "github-repos": _check_github_repos,
              "page-authors": _check_page_authors}
    for name, path in FILES.items():
        doc = docs.get(name)
        if doc is None:
            continue
        rep = _Report(path)
        if name == "people-public":
            _check_people_public(doc, rep, read_avatar)
        else:
            checks[name](doc, rep)
        _leaf_types(rep, doc, SHAPES[name], "")
        for leak in profile_key_leaks(doc):
            rep.add(f"GitHub profile field '{leak}' — profile data never reaches "
                    f"this file")
        _text_rules(rep, doc)
        out += rep.out
    return out


def github_layer_notes(docs, page_keys, roster_names, org_names):
    """NOTES only (printed, never red): stale keys the renderers ignore."""
    out = []
    pages = (docs.get("page-authors") or {}).get("pages")
    if isinstance(pages, dict):
        for key in sorted(set(pages) - set(page_keys)):
            out.append(f"{FILES['page-authors']}: page '{key}' is not a current page "
                       f"(ignored until the next GitHub-data build)")
    people = (docs.get("people-public") or {}).get("people")
    if isinstance(people, dict):
        for login in sorted(people):
            roster = people[login].get("roster") if isinstance(people[login], dict) else None
            if isinstance(roster, str) and roster not in roster_names:
                out.append(f"{FILES['people-public']}: '{login}' links to '{roster}', "
                           f"not a name in data/people.json (ignored until the next "
                           f"GitHub-data build)")
    repos = (docs.get("github-repos") or {}).get("repos")
    if isinstance(repos, dict) and org_names is not None:
        for name in sorted(set(repos) - set(org_names)):
            out.append(f"{FILES['github-repos']}: '{name}' is not in the "
                       f"data/org-repos.json snapshot")
    return out


def check_github_links(doc):
    """HARD: the map's shape, and no login both linked and excluded."""
    where = LINKS_FILE
    if not isinstance(doc, dict):
        return [f"{where}: top level must be an object with note/links/exclude"]
    out = []
    want = {"note", "links", "exclude"}
    extra, missing = sorted(set(doc) - want), sorted(want - set(doc))
    if extra:
        out.append(f"{where}: unknown key(s) {extra} — exactly note/links/exclude")
    if missing:
        out.append(f"{where}: missing key(s) {missing} — exactly note/links/exclude")
    if "note" in doc and not isinstance(doc["note"], str):
        out.append(f"{where}: 'note' must be a string")
    links = doc.get("links")
    if not isinstance(links, dict):
        out.append(f"{where}: 'links' must be an object mapping a GitHub login to a "
                   f"roster name or null")
        links = {}
    for login, name in links.items():
        if not LOGIN_RE.fullmatch(login):
            out.append(f"{where}: '{login}' is not a GitHub login")
        if not (name is None or (isinstance(name, str) and name.strip())):
            out.append(f"{where}: '{login}' must map to a roster name or null, "
                       f"got {name!r}")
    exclude = doc.get("exclude")
    if not (isinstance(exclude, list) and all(isinstance(x, str) for x in exclude)):
        out.append(f"{where}: 'exclude' must be a list of GitHub logins")
        exclude = []
    for login in sorted(set(exclude) & set(links)):
        out.append(f"{where}: '{login}' is both linked and excluded — pick one")
    return out


def github_links_notes(doc, roster_names, people_public):
    """NOTES only: map values that are not roster names (a lab member may have
    renamed an alumnus in the editor, where the map is not editable), and
    mapped logins absent from people-public.json."""
    out = []
    links = doc.get("links") if isinstance(doc, dict) else None
    if not isinstance(links, dict):
        return out
    by_name = {}
    for login in sorted(links):
        name = links[login]
        if isinstance(name, str) and name not in roster_names:
            out.append(f"{LINKS_FILE}: '{login}' maps to '{name}', which is not a name "
                       f"in data/people.json — left unlinked until the map is fixed")
        if isinstance(name, str):
            by_name.setdefault(name, []).append(login)
    for name in sorted(by_name):
        if len(by_name[name]) > 1:        # D-L ambiguity: the matcher links neither
            out.append(f"{LINKS_FILE}: " + " and ".join(f"'{x}'" for x in by_name[name])
                       + f" are all mapped to '{name}' — linked to none until one "
                       f"line is removed")
    people = (people_public or {}).get("people") if isinstance(people_public, dict) else None
    if isinstance(people, dict):
        for login in sorted(set(links) - set(people)):
            out.append(f"{LINKS_FILE}: '{login}' is not in {FILES['people-public']}")
    return out
