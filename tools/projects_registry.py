#!/usr/bin/env python3
# Author: Kyle Nelson
# Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
# Last substantive modification: 19 October 2026
# Affiliation: TUHH HippoCampus Robotics
# Purpose: Load the project registry: the shared index (ids, order, add and remove lists) merged with each project's facts file.
"""The project registry, read the one way every Python reader reads it.

Since 2026-10-14 a project lives in two places:

  data/projects.json            the shared index, admin-owned: intro,
                                org_snapshot, exclusions, and `projects`, the
                                list of {id, add, remove} in display order
  data/projects/<id>.json       that project's facts, editable by that
                                project's editors: name, status, tagline,
                                file, repos, hardware, links

`add` and `remove` (Kyle, 2026-10-19; `owners` was renamed to `add`) are an
admin's per-person overrides of the commits rule: tools/build_edit_access.py
turns them, with the commit counts, into who may edit each project.

load(root) merges them into the document every reader knew before the split
(each entry: id, add and remove from the index, then the facts), so a reader
changes one line. The facts never supply id, add, remove or owners: only the
admin-owned index decides those. An index entry with no facts file stays as it is (tools/check.py
reports it); an index entry that still carries facts (an older fixture) keeps
them, and a facts file fills only what the entry lacks.
"""
import copy
import json
from pathlib import Path

INDEX = "data/projects.json"
FACTS_DIR = "data/projects"
# What only the index may say about a project, in this order.
INDEX_KEYS = ("id", "add", "remove")


def facts_path(pid):
    return f"{FACTS_DIR}/{pid}.json"


def merge(index, facts_by_id):
    """index: the parsed data/projects.json; facts_by_id: {id: parsed facts}.
    -> a new document with every entry merged (never raises on a bad shape)."""
    doc = copy.deepcopy(index) if isinstance(index, dict) else index
    if not isinstance(doc, dict) or not isinstance(doc.get("projects"), list):
        return doc
    merged = []
    for entry in doc["projects"]:
        if not isinstance(entry, dict):
            merged.append(entry)
            continue
        facts = facts_by_id.get(entry.get("id")) if isinstance(entry.get("id"), str) else None
        out = {k: entry[k] for k in INDEX_KEYS if k in entry}     # the order: id, add, remove, then the facts
        if isinstance(facts, dict):
            out.update(copy.deepcopy({k: v for k, v in facts.items() if k not in INDEX_KEYS + ("owners",)}))
        out.update(entry)                 # the index's id, add and remove (and an older fixture's facts) win
        merged.append(out)
    doc["projects"] = merged
    return doc


def read_facts(root, ids, facts_dir=None):
    """{id: parsed facts} for every id whose facts file exists and parses
    (facts_dir: where the facts files are; default root's data/projects/)."""
    out = {}
    folder = Path(facts_dir) if facts_dir else Path(root) / FACTS_DIR
    for pid in ids:
        if not isinstance(pid, str):
            continue
        path = folder / f"{pid}.json"
        if path.is_file():
            try:
                out[pid] = json.loads(path.read_text(encoding="utf-8"))
            except ValueError:
                out[pid] = None
    return out


def ids_of(index):
    """The ids an index lists (entries that are objects with a string id)."""
    rows = index.get("projects") if isinstance(index, dict) else None
    return [e["id"] for e in rows if isinstance(e, dict) and isinstance(e.get("id"), str)] if isinstance(rows, list) else []


def with_facts(root, index, facts_dir=None):
    """An already-parsed index merged with root's facts files (or facts_dir's)."""
    return merge(index, read_facts(root, ids_of(index), facts_dir))


def load(root, index_path=None):
    """The merged registry from `root`. index_path overrides where the index is
    read from; its facts files are then the `projects/` folder beside it (the
    layout data/projects.json + data/projects/<id>.json, anywhere)."""
    path = Path(index_path) if index_path else Path(root) / INDEX
    return with_facts(root, json.loads(path.read_text(encoding="utf-8")), path.parent / "projects")
