#!/usr/bin/env python3
# Author: Kyle Nelson
# Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
# Last substantive modification: 3 September 2026
# Affiliation: TUHH HippoCampus Robotics
# Purpose: Check referenced image URLs and public people-card links for liveness.
"""The liveness gate — the ONLINE twin of tools/check.py.

  python3 tools/check_urls.py            # image URLs fatal, people links advisory
  python3 tools/check_urls.py --strict    # people links fatal too

tools/check.py is offline by design: it proves the manifest and the content
agree with each other, but it cannot know whether a URL still serves. This
script asks the network:

  1. every res.cloudinary.com URL referenced in content/**.md and index.html;
  2. every 'url' in data/cloudinary-manifest.json;
  3. when data/people.json exists: every "photo" URL (joins set 1/2) and every
     "link" URL (a separate, softer set).

Image URLs must answer 200 — a broken image is a broken page, so any failure is
fatal. People links are advisory unless --strict: a transient tuhh.de outage
must never teach a future editor to delete a link that is in fact fine.

Links on BOT_BLOCKED_HOSTS are reported as "unverifiable", never passing and
never fatal: those hosts answer every anonymous request with an anti-bot status
(LinkedIn: HTTP 999) whether the page exists or not, so a probe result carries
no liveness information either way. Verify those in a real browser.

Stdlib only (urllib) — no dependencies, like every other tool here.
"""
import argparse
import http.cookiejar
import json
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
CLOUDINARY_RE = re.compile(r"https?://res\.cloudinary\.com/[^\s)\"'<>\]]+")
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
TIMEOUT = 15
WORKERS = 4          # polite: a handful of connections, never a flood

# Hosts that answer EVERY anonymous request with an anti-bot status (LinkedIn:
# HTTP 999), for live and dead pages alike — a probe result carries no liveness
# information. Links here are reported as unverifiable, not passed or failed.
BOT_BLOCKED_HOSTS = {"linkedin.com", "www.linkedin.com"}


def _walk(node, path=""):
    """Yield (key-name, string value) for every string in a JSON document."""
    if isinstance(node, dict):
        for k, v in node.items():
            yield from _walk(v, str(k))
    elif isinstance(node, list):
        for v in node:
            yield from _walk(v, path)
    elif isinstance(node, str):
        yield path, node


def collect(root=ROOT):
    """Return (image_urls, people_links) as sets. Never touches the network."""
    images, links = set(), set()

    texts = [p.read_text(encoding="utf-8") for p in sorted((root / "content").rglob("*.md"))]
    index = root / "index.html"
    if index.exists():
        texts.append(index.read_text(encoding="utf-8"))
    for text in texts:
        for url in CLOUDINARY_RE.findall(text):
            images.add(url.rstrip(".,;:"))

    manifest = root / "data" / "cloudinary-manifest.json"
    if manifest.exists():
        try:
            doc = json.loads(manifest.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            print(f"data/cloudinary-manifest.json: not valid JSON ({e}) — run check.py")
            sys.exit(1)
        for a in doc.get("assets", []):
            if a.get("url"):
                images.add(a["url"])

    people = root / "data" / "people.json"          # not there yet; that is fine
    if people.exists():
        try:
            doc = json.loads(people.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            print(f"data/people.json: not valid JSON ({e}) — run check.py")
            sys.exit(1)
        for key, value in _walk(doc):
            if not value.startswith(("http://", "https://")):
                continue
            if key == "photo":
                images.add(value)
            elif key == "link":
                links.add(value)
    return images, links


def _request(url, method):
    # A fresh cookie jar per request: some university sites (kth.se) answer the
    # first hit with a silent-auth bounce that only resolves once a cookie is
    # kept, and a cookie-less client loops until urllib gives up. A jar per call
    # also keeps this thread-safe under the pool below.
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    req = urllib.request.Request(url, method=method, headers={
        "User-Agent": UA, "Accept": "*/*"})
    with opener.open(req, timeout=TIMEOUT) as resp:
        if method == "GET":
            resp.read(1)            # touch the body, do not download it
        return resp.status


def _status(url, method):
    try:
        return _request(url, method), None
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception as e:          # URLError, timeout, DNS, TLS…
        return None, f"{type(e).__name__}: {e}"


def _attempt(url):
    """One full attempt: HEAD, then GET whenever HEAD does not answer 200.

    HEAD is only an optimisation. Plenty of servers mishandle it — 403, 405, or
    a bare 400 (kth.se) — so any non-200 HEAD is re-asked as a GET before the
    URL is called dead. -> (ok, detail)
    """
    code, netfail = _status(url, "HEAD")
    if not netfail and code == 200:
        return True, "200"
    head_detail = netfail or f"HTTP {code}"
    code, netfail = _status(url, "GET")
    if netfail:
        return False, netfail
    if code == 200:
        return True, "200"
    return False, f"HTTP {code} (HEAD said {head_detail})"


def probe(url):
    """Return (ok, detail). One short retry on a network wobble or a 5xx."""
    ok, detail = _attempt(url)
    if ok:
        return True, detail
    if not detail.startswith("HTTP ") or detail.startswith("HTTP 5"):
        time.sleep(1.5)
        ok, detail = _attempt(url)
    return ok, detail


def run(urls):
    urls = sorted(urls)
    if not urls:
        return []
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        return list(zip(urls, pool.map(probe, urls)))


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--strict", action="store_true",
                    help="treat a failing people.json link as fatal too")
    args = ap.parse_args()

    images, links = collect()
    unverifiable = sorted(
        u for u in links if urlsplit(u).hostname in BOT_BLOCKED_HOSTS)
    img_results = run(images)
    link_results = run(links - set(unverifiable))

    img_bad = [(u, d) for u, (ok, d) in img_results if not ok]
    link_bad = [(u, d) for u, (ok, d) in link_results if not ok]

    print(f"images: {len(img_results)} referenced / "
          f"{len(img_results) - len(img_bad)} passing")
    if links:
        line = (f"people links: {len(links)} referenced / "
                f"{len(link_results) - len(link_bad)} passing")
        if unverifiable:
            line += f" / {len(unverifiable)} unverifiable (bot-blocked host)"
        print(line)

    if img_bad:
        print(f"\ndead image URL — the page is broken until this serves again "
              f"({len(img_bad)}):")
        for u, d in img_bad:
            print(f"  ✗ {u} — {d}")
    if link_bad:
        head = "stale link — verify and edit data/people.json"
        print(f"\n{head} ({len(link_bad)}"
              f"{'' if args.strict else ', non-fatal'}):")
        for u, d in link_bad:
            print(f"  {'✗' if args.strict else '!'} {u} — {d}")
    if unverifiable:
        print(f"\nunverifiable — the host blocks anonymous probes; open in a "
              f"browser to verify ({len(unverifiable)}):")
        for u in unverifiable:
            print(f"  ? {u}")

    fatal = bool(img_bad) or (args.strict and bool(link_bad))
    if fatal:
        sys.exit(1)
    if unverifiable:
        print(f"check_urls.py: all probeable URLs reachable "
              f"({len(unverifiable)} unverifiable listed above)")
    else:
        print("check_urls.py: all reachable")
    sys.exit(0)


if __name__ == "__main__":
    main()
