#!/usr/bin/env python3
# Author: Kyle Nelson
# Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
# Last substantive modification: 29 September 2026
# Affiliation: TUHH HippoCampus Robotics
# Purpose: Match GitHub logins to People-roster names: one pure matcher plus a hand-kept map.
"""The ONE name matcher of the site (plan D-L). Pure: no network, no writes.

Who uses it: tools/build_contributors.py (the `roster: true` flag) and
tools/build_github_data.py (people-public.json's `roster`). js/graph.js and
js/lab.js never match names themselves; they read people-public.json.

The rule. Each name gets TWO normal forms:
  (i)  NFC, German transliteration (ä→ae, ö→oe, ü→ue, ß→ss), NFKD with the
       combining marks dropped, casefold();
  (ii) NFC, NFKD with the combining marks dropped, casefold() (which turns ß
       into ss; lower() would not);
then '-', '.' and '_' become spaces and whitespace runs collapse. So
"Wittmüß" -> "wittmuess" / "wittmuss" and "Büsch" -> "buesch" / "busch".
Two names match when ANY pair of forms is equal, OR when both have at least
two tokens and, for some pair of forms, the first tokens are equal and the
last tokens are equal ("Daniel Duecker" ~ "Daniel-André Dücker"). A one-token
name never auto-matches ("Tim" needs the map).

The map, data/github-links.json (hand-kept):
  {"note": ..., "links": {"<login>": "<roster name>" | null},
   "exclude": ["<login>", ...]}
  * the map always wins over the rule;
  * a login mapped to null is never linked (the one-line fix for a wrong match);
  * a login in "exclude" is dropped from the people data entirely (org service
    accounts); match() leaves it out of its answer;
  * a map value that is not a current roster name counts as UNLINKED, with a
    warning naming it (a lab member may rename an alumnus in the editor, where
    the map is not editable; that must never break a build).

Ambiguity (two logins -> one roster name, or one login -> two roster names;
two map lines giving the same roster name count too) links NEITHER, adds a warning naming the pair, and the caller carries on; one
map line settles it.
"""
import json
import re
import unicodedata
from collections import defaultdict
from pathlib import Path

TRANSLIT = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss",
                          "Ä": "Ae", "Ö": "Oe", "Ü": "Ue", "ẞ": "SS"})
_SEPARATORS = re.compile(r"[-._]")
_WHITESPACE = re.compile(r"\s+")
MAP_PATH = "data/github-links.json"


def _drop_marks(text):
    return "".join(ch for ch in unicodedata.normalize("NFKD", text)
                   if not unicodedata.combining(ch))


def _fold(text):
    # casefold() can itself produce a combining mark ("İ" -> "i̇"): drop again
    folded = _drop_marks(_drop_marks(text).casefold())
    return _WHITESPACE.sub(" ", _SEPARATORS.sub(" ", folded)).strip()


def normalize(name):
    """The name's normal forms, (i) first; duplicates and empties removed."""
    if not isinstance(name, str):
        return ()
    nfc = unicodedata.normalize("NFC", name)
    forms = (_fold(nfc.translate(TRANSLIT)), _fold(nfc))
    return tuple(dict.fromkeys(f for f in forms if f))


def forms_match(a, b):
    """True when two tuples of normal forms name the same person (the rule).

    A one-token name never matches, not even an equal one: "Tim" is not
    evidence enough, so it needs the map."""
    for x in a:
        for y in b:
            tx, ty = x.split(" "), y.split(" ")
            if len(tx) < 2 or len(ty) < 2:
                continue
            if x == y or (tx[0] == ty[0] and tx[-1] == ty[-1]):
                return True
    return False


def roster_names(people):
    """Every non-empty roster name of data/people.json, in file order."""
    names = []
    for group in (people or {}).get("groups", []) or []:
        for person in (group or {}).get("people", []) or []:
            name = person.get("name") if isinstance(person, dict) else None
            if isinstance(name, str) and name.strip() and name not in names:
                names.append(name)
    return names


def load_links(path):
    """The map document, or an empty map when the file does not exist.

    Raises ValueError on the wrong types (a non-object document or 'links', a
    non-list 'exclude', a value that is neither a string nor null) instead of
    coercing them: a null 'links' would silently drop every override."""
    path = Path(path)
    if not path.exists():
        return {"links": {}, "exclude": []}
    doc = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(doc, dict):
        raise ValueError(f"{path}: top level must be an object")
    links, exclude = doc.get("links", {}), doc.get("exclude", [])
    if not isinstance(links, dict) or any(
            not (v is None or isinstance(v, str)) for v in links.values()):
        raise ValueError(f"{path}: 'links' must map a login to a roster name or null")
    if not isinstance(exclude, list) or any(not isinstance(x, str) for x in exclude):
        raise ValueError(f"{path}: 'exclude' must be a list of logins")
    return doc


def _links(doc):
    links = (doc or {}).get("links") or {}
    return links if isinstance(links, dict) else {}


def excluded_logins(doc):
    exclude = (doc or {}).get("exclude") or []
    return frozenset(x for x in exclude if isinstance(x, str)) \
        if isinstance(exclude, list) else frozenset()


def match(logins_with_names, roster, links=None):
    """({login: roster name or None}, [warning, ...]).

    `logins_with_names` maps a login to its GitHub display name (None when the
    account sets none — then only the map can link it). Excluded logins are
    absent from the answer.
    """
    linkmap = _links(links)
    exclude = excluded_logins(links)
    roster = [r for r in dict.fromkeys(roster or []) if isinstance(r, str) and r.strip()]
    roster_set = set(roster)
    result, warnings, claimed = {}, [], {}

    # D-L ambiguity, in the map itself: read from the WHOLE map, so a login
    # absent from this build (a former contributor) still blocks its twin
    map_groups = defaultdict(list)         # roster name -> every login the map gives it
    for login in sorted(linkmap):
        if linkmap[login] in roster_set:
            map_groups[linkmap[login]].append(login)
    doubled = {name for name, logins in map_groups.items() if len(logins) > 1}

    present_doubled = set()
    for login in sorted(logins_with_names):
        if login in exclude or login not in linkmap:
            continue
        value = linkmap[login]
        if value is None:
            result[login] = None
        elif value in doubled:
            result[login] = None
            present_doubled.add(value)
            claimed.setdefault(value, login)
        elif value in roster_set:
            result[login] = value
            claimed.setdefault(value, login)
        else:
            result[login] = None
            warnings.append(f"{MAP_PATH}: '{login}' maps to '{value}', which is not "
                            f"a roster name in data/people.json — left unlinked")

    for name in sorted(present_doubled):
        warnings.append("ambiguous: " + " and ".join(f"'{x}'" for x in map_groups[name])
                        + f" are all mapped to '{name}' in {MAP_PATH} — linked to "
                        f"none; keep one line")

    roster_forms = {r: normalize(r) for r in roster}
    by_roster = defaultdict(list)
    for login in sorted(logins_with_names):
        if login in exclude or login in linkmap:
            continue
        forms = normalize(logins_with_names[login])
        hits = [r for r in roster if forms and forms_match(forms, roster_forms[r])]
        free = [r for r in hits if r not in claimed]
        for r in hits:
            if r in claimed:
                warnings.append(f"'{login}' also matches '{r}', which {MAP_PATH} "
                                f"gives to '{claimed[r]}' — left unlinked")
        if len(free) > 1:
            result[login] = None
            warnings.append(f"ambiguous: '{login}' matches "
                            + " and ".join(f"'{r}'" for r in free)
                            + f" — linked to neither; settle it in {MAP_PATH}")
        elif len(free) == 1:
            by_roster[free[0]].append(login)
        else:
            result[login] = None
    for name in sorted(by_roster):
        logins = by_roster[name]
        if len(logins) == 1:
            result[logins[0]] = name
            continue
        for login in logins:
            result[login] = None
        warnings.append("ambiguous: " + " and ".join(f"'{x}'" for x in logins)
                        + f" all match '{name}' — linked to none; settle it in {MAP_PATH}")
    return {login: result[login] for login in sorted(result)}, warnings
