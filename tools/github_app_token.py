#!/usr/bin/env python3
# Author: Kyle Nelson
# Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
# Last substantive modification: 15 October 2026
# Affiliation: TUHH HippoCampus Robotics
# Purpose: Mint a short-lived, contents-only GitHub App installation token for derive.yml's push to main.
"""Mint the token derive.yml pushes with (Kyle, 2026-10-15: the org-owned App).

Why an App: the `main-review` ruleset requires a reviewed pull request on main,
and GitHub refuses the GitHub Actions app as a ruleset bypass actor here. An
org-owned App installed on this repository only can be one, so derive.yml pushes
its derived-data commit as that App.

What it does, stdlib only, with openssl for the one RS256 signature:
  1. signs a JWT for the App (iss = DERIVE_APP_ID, 9 minutes, backdated 60 s);
  2. finds the App's installation on GITHUB_REPOSITORY;
  3. asks for an installation token limited to THIS repository and to
     contents: write, and refuses one that came back with any other grant;
  4. reads the App's bot identity (slug, user id) for the commit author.

Output on stdout, three lines: token, bot name, bot email. The caller masks the
token (`::add-mask::`) before anything else. `--revoke` (token in
DERIVE_APP_TOKEN) ends a token early.

The private key comes from the DERIVE_APP_PRIVATE_KEY environment variable
(the `derive` environment's secret) and goes to openssl on stdin: it is never
written to disk, never put in an argument list, never printed. Errors name what
failed, never the key.
"""

import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.github.com"
JWT_BACKDATE = 60      # seconds: tolerate a runner clock slightly ahead of GitHub's
JWT_LIFETIME = 540     # seconds after now; GitHub's ceiling is 10 minutes
WANT_PERMISSIONS = {"contents": "write"}


class TokenError(Exception):
    """A failure that is safe to print (it never holds key material)."""


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def make_jwt(app_id, private_key, now=None):
    app_id = (app_id or "").strip()
    if not app_id.isdigit():
        raise TokenError("DERIVE_APP_ID must be the App's numeric id")
    if not private_key or "PRIVATE KEY" not in private_key:
        raise TokenError("DERIVE_APP_PRIVATE_KEY is empty or not a PEM private key")
    now = int(time.time() if now is None else now)
    header = b64url(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode())
    claims = b64url(json.dumps({"iat": now - JWT_BACKDATE, "exp": now + JWT_LIFETIME,
                                "iss": app_id}, separators=(",", ":")).encode())
    signing_input = f"{header}.{claims}".encode()
    # The key goes in on stdin and the data through a pipe passed as /dev/fd/N,
    # so neither the key nor a key path appears on disk or in argv.
    r_fd, w_fd = os.pipe()
    try:
        os.write(w_fd, signing_input)
    finally:
        os.close(w_fd)
    try:
        result = subprocess.run(
            ["openssl", "dgst", "-sha256", "-binary", "-sign", "/dev/stdin", f"/dev/fd/{r_fd}"],
            input=private_key.encode(), capture_output=True, pass_fds=(r_fd,), check=False)
    finally:
        os.close(r_fd)
    if result.returncode != 0 or not result.stdout:
        raise TokenError("openssl could not sign the App JWT (is DERIVE_APP_PRIVATE_KEY the App's key?)")
    return f"{header}.{claims}.{b64url(result.stdout)}"


def _call(opener, method, path, auth=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("User-Agent", "hippocampus-docs-derive")
    if auth:
        req.add_header("Authorization", auth)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with opener(req, timeout=30) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        e.close()
        return e.code, None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise TokenError(f"{method} {path}: network error ({type(e).__name__})") from None


def mint(app_id, private_key, repository, opener=None):
    opener = opener or urllib.request.urlopen
    if repository.count("/") != 1 or not all(repository.split("/")):
        raise TokenError("GITHUB_REPOSITORY must be owner/name")
    owner, name = repository.split("/")
    bearer = "Bearer " + make_jwt(app_id, private_key)

    status, inst = _call(opener, "GET", f"/repos/{owner}/{name}/installation", bearer)
    if status == 404:
        raise TokenError(f"the App is not installed on {repository} (HTTP 404)")
    if status != 200 or not isinstance(inst, dict) or not isinstance(inst.get("id"), int):
        raise TokenError(f"could not read the App's installation on {repository} (HTTP {status})")

    status, tok = _call(opener, "POST", f"/app/installations/{inst['id']}/access_tokens", bearer,
                        {"repositories": [name], "permissions": WANT_PERMISSIONS})
    if status != 201 or not isinstance(tok, dict) or not isinstance(tok.get("token"), str):
        raise TokenError(f"GitHub refused the installation token (HTTP {status})")
    granted = {k: v for k, v in (tok.get("permissions") or {}).items() if k != "metadata"}
    if granted != WANT_PERMISSIONS:
        raise TokenError(f"the token came back with {sorted(granted.items())}, not contents: write only")

    status, app = _call(opener, "GET", "/app", bearer)
    slug = app.get("slug") if status == 200 and isinstance(app, dict) else None
    if not isinstance(slug, str) or not slug:
        raise TokenError(f"could not read the App's slug (HTTP {status})")
    login = f"{slug}[bot]"
    status, user = _call(opener, "GET", "/users/" + urllib.parse.quote(login, safe=""))
    uid = user.get("id") if status == 200 and isinstance(user, dict) else None
    if not isinstance(uid, int):
        raise TokenError(f"could not read the bot user {login} (HTTP {status})")
    return {"token": tok["token"], "name": login,
            "email": f"{uid}+{login}@users.noreply.github.com"}


def revoke(token, opener=None):
    status, _ = _call(opener or urllib.request.urlopen, "DELETE", "/installation/token",
                      f"token {token}")
    return status == 204


def main(argv):
    if argv[1:] == ["--revoke"]:
        token = os.environ.get("DERIVE_APP_TOKEN", "")
        if not token:
            return 0
        try:
            ok = revoke(token)
        except TokenError as e:
            ok = False
            print(f"github_app_token: {e}", file=sys.stderr)
        print("github_app_token: token revoked" if ok else "github_app_token: revoke failed (it expires within the hour)",
              file=sys.stderr)
        return 0
    if argv[1:]:
        print("usage: github_app_token.py [--revoke]", file=sys.stderr)
        return 2
    missing = [n for n in ("DERIVE_APP_ID", "DERIVE_APP_PRIVATE_KEY", "GITHUB_REPOSITORY")
               if not os.environ.get(n)]
    if missing:
        print("github_app_token: missing " + ", ".join(missing)
              + " (the job needs `environment: derive`)", file=sys.stderr)
        return 2
    try:
        out = mint(os.environ["DERIVE_APP_ID"], os.environ["DERIVE_APP_PRIVATE_KEY"],
                   os.environ["GITHUB_REPOSITORY"])
    except TokenError as e:
        print(f"github_app_token: {e}", file=sys.stderr)
        return 1
    sys.stdout.write(f"{out['token']}\n{out['name']}\n{out['email']}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
