#!/usr/bin/env python3
# Author: Kyle Nelson
# Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
# Last substantive modification: 17 September 2026
# Affiliation: TUHH HippoCampus Robotics
# Purpose: Reconcile tracked code candidates and validate their approved attribution headers.
"""Validate explicit, provenance-reviewed attribution metadata without dependencies."""

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path


DEFAULT_MANIFEST = Path(__file__).with_name("attribution_headers.json")
EXPECTED_PROJECT_URL = "https://hippocampus-docs.vercel.app/#/projects/docs-and-site"
FIELD_ORDER = (
    ("Author", "author"),
    ("Project", "project"),
    ("Last substantive modification", "last_substantive_modification"),
    ("Affiliation", "affiliation"),
    ("Purpose", "purpose"),
)
ENCODING_RE = re.compile(r"coding[:=]\s*[-\w.]+")
PROJECT_RE = re.compile(r"^(?:#|//) Project: (.+)$", re.MULTILINE)
FIELD_RE = re.compile(
    r"^(?:#|//) (Author|Project|Last substantive modification|Affiliation|Purpose): ",
    re.MULTILINE,
)


def _git_candidates(root, extensions):
    result = subprocess.run(
        ["git", "ls-files", "-s", "-z"], cwd=root, check=True, capture_output=True
    )
    candidates = set()
    for record in result.stdout.decode("utf-8", "surrogateescape").split("\0"):
        if not record:
            continue
        metadata, path = record.split("\t", 1)
        mode = metadata.split()[0]
        if Path(path).suffix.lower() in extensions or mode == "100755":
            candidates.add(path)

    return candidates


def _comment_prefix(path):
    return "//" if Path(path).suffix.lower() in {
        ".c", ".cc", ".cjs", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx",
        ".ino", ".js", ".jsx", ".mjs", ".ts", ".tsx",
    } else "#"


def _expected_header(path, metadata):
    prefix = _comment_prefix(path)
    fields = metadata["header"]
    return "".join(f"{prefix} {label}: {fields[key]}\n" for label, key in FIELD_ORDER)


def _header_start(lines):
    index = 0
    if lines and lines[0].startswith("#!"):
        index = 1
    if index < len(lines) and ENCODING_RE.search(lines[index]):
        index += 1
    return index


def _validate_manifest(manifest, expected_project_url):
    errors = []
    if manifest.get("schema_version") != 1:
        errors.append("manifest: schema_version must be 1")
    extensions = manifest.get("candidate_extensions")
    if not isinstance(extensions, list) or not extensions:
        errors.append("manifest: candidate_extensions must be a non-empty list")
    elif any(not isinstance(value, str) or not value.startswith(".") for value in extensions):
        errors.append("manifest: every candidate extension must be a dot-prefixed string")
    canonical_project = manifest.get("canonical_project_url")
    if canonical_project != expected_project_url:
        errors.append(
            "manifest: canonical_project_url does not match this repository's approved route"
        )
    files = manifest.get("files")
    if not isinstance(files, dict):
        errors.append("manifest: files must be an object keyed by relative path")
        return errors
    for path, metadata in files.items():
        where = f"manifest: {path}"
        if not isinstance(metadata, dict):
            errors.append(f"{where}: entry must be an object")
            continue
        classification = metadata.get("classification")
        if classification not in {"included", "excluded"}:
            errors.append(f"{where}: classification must be included or excluded")
        if not isinstance(metadata.get("reason"), str) or not metadata["reason"].strip():
            errors.append(f"{where}: reason must be non-empty")
        if classification != "included":
            continue
        header = metadata.get("header")
        if not isinstance(header, dict) or set(header) != {key for _, key in FIELD_ORDER}:
            errors.append(f"{where}: header fields must exactly match the five-field template")
            continue
        if any(not isinstance(value, str) or not value.strip() for value in header.values()):
            errors.append(f"{where}: every header value must be non-empty text")
        if header.get("author") != "Kyle Nelson":
            errors.append(f"{where}: author must be exactly 'Kyle Nelson'")
        if header.get("affiliation") != "TUHH HippoCampus Robotics":
            errors.append(
                f"{where}: affiliation must be exactly 'TUHH HippoCampus Robotics'"
            )
        date = header.get("last_substantive_modification", "")
        try:
            parsed = datetime.strptime(date, "%d %B %Y")
            if f"{parsed.day} {parsed.strftime('%B %Y')}" != date:
                raise ValueError
        except ValueError:
            errors.append(f"{where}: reviewed date must use 'D Month YYYY', got {date!r}")
        project = header.get("project", "")
        if project != canonical_project:
            errors.append(f"{where}: project does not match canonical_project_url")
    return errors


def check_repository(root, manifest_path=DEFAULT_MANIFEST,
                     expected_project_url=EXPECTED_PROJECT_URL):
    root = Path(root).resolve()
    manifest_path = Path(manifest_path)
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [f"manifest: cannot load {manifest_path}: {exc}"]
    errors = _validate_manifest(manifest, expected_project_url)
    if errors or not isinstance(manifest.get("files"), dict):
        return errors

    extensions = {value.lower() for value in manifest["candidate_extensions"]}
    try:
        candidates = _git_candidates(root, extensions)
    except (OSError, subprocess.CalledProcessError, UnicodeError) as exc:
        return [f"candidate discovery failed: {exc}"]
    inventoried = set(manifest["files"])
    errors.extend(f"unclassified candidate: {path}" for path in sorted(candidates - inventoried))
    errors.extend(f"manifest path is not an eligible candidate: {path}"
                  for path in sorted(inventoried - candidates))

    for path in sorted(candidates & inventoried):
        metadata = manifest["files"][path]
        if metadata.get("classification") != "included":
            continue
        full = root / path
        try:
            raw = full.read_bytes()
            text = raw.decode("utf-8")
        except (OSError, UnicodeError) as exc:
            errors.append(f"{path}: cannot read UTF-8 source: {exc}")
            continue
        expected = _expected_header(path, metadata)
        count = text.count(expected)
        if count == 0:
            errors.append(f"{path}: missing exact header from reviewed metadata")
        elif count != 1:
            errors.append(f"{path}: expected exactly one header, found {count}")
        lines = text.splitlines(keepends=True)
        leading = "".join(lines[:20])
        projects = PROJECT_RE.findall(leading)
        expected_project = metadata["header"]["project"]
        for project in projects:
            if project != expected_project:
                errors.append(f"{path}: unapproved Project field {project!r}")
        field_counts = {label: 0 for label, _key in FIELD_ORDER}
        for label in FIELD_RE.findall(leading):
            field_counts[label] += 1
        for label, count_fields in field_counts.items():
            if count_fields != 1:
                errors.append(
                    f"{path}: expected exactly one leading {label} field, "
                    f"found {count_fields}"
                )
        start = _header_start(lines)
        if lines and any(line.startswith("#!") for line in lines[1:]):
            errors.append(f"{path}: shebang must remain the first line")
        if count == 1 and "".join(lines[start:start + 5]) != expected:
            errors.append(f"{path}: header starts at line {text[:text.index(expected)].count(chr(10)) + 1}, "
                          f"expected line {start + 1} after shebang/encoding preamble")
    return errors


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    args = parser.parse_args(argv)
    errors = check_repository(args.root, args.manifest)
    if errors:
        print(f"attribution headers: FAILED ({len(errors)} problem(s))")
        for error in errors:
            print(f"  - {error}")
        return 1
    print("attribution headers: all green")
    return 0


if __name__ == "__main__":
    sys.exit(main())
