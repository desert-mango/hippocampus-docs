#!/usr/bin/env python3
# Author: Kyle Nelson
# Project: https://hippocampus-docs.vercel.app/#/projects/docs-and-site
# Last substantive modification: 15 October 2026
# Affiliation: TUHH HippoCampus Robotics
# Purpose: Test the derive App token minter: the signed JWT, the narrow token request, and no key on disk.
"""Tests for tools/github_app_token.py (derive.yml's push identity).

A throwaway RSA key is made with openssl for each run; no real App key is
ever used. The HTTP calls go to a fake opener, so nothing touches GitHub.
"""

import base64
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))

import github_app_token as gat  # noqa: E402


def b64url_decode(part):
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


class FakeResponse(io.BytesIO):
    def __init__(self, status, body):
        super().__init__(json.dumps(body).encode())
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeOpener:
    """Records every request; answers from a table keyed by (method, path)."""

    def __init__(self, table):
        self.table = table
        self.calls = []

    def __call__(self, req, timeout=None):
        path = req.full_url.replace(gat.API, "")
        body = json.loads(req.data.decode()) if req.data else None
        self.calls.append({"method": req.get_method(), "path": path,
                           "auth": req.get_header("Authorization"), "body": body})
        status, payload = self.table[(req.get_method(), path)]
        if status >= 400:
            raise gat.urllib.error.HTTPError(req.full_url, status, "err", {},
                                             io.BytesIO(json.dumps(payload).encode()))
        return FakeResponse(status, payload)


class KeyCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        d = Path(cls.tmp.name)
        cls.key_path = d / "key.pem"
        cls.pub_path = d / "pub.pem"
        subprocess.run(["openssl", "genrsa", "-out", str(cls.key_path), "2048"],
                       check=True, capture_output=True)
        subprocess.run(["openssl", "rsa", "-in", str(cls.key_path), "-pubout",
                        "-out", str(cls.pub_path)], check=True, capture_output=True)
        cls.key = cls.key_path.read_text()

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()


class TestJwt(KeyCase):
    def test_header_and_claims(self):
        jwt = gat.make_jwt("123456", self.key, now=1_700_000_000)
        head, claims, _sig = jwt.split(".")
        self.assertEqual(json.loads(b64url_decode(head)), {"alg": "RS256", "typ": "JWT"})
        c = json.loads(b64url_decode(claims))
        self.assertEqual(c["iss"], "123456")
        # Backdated for clock drift; well under GitHub's 10-minute ceiling.
        self.assertEqual(c["iat"], 1_700_000_000 - 60)
        self.assertLessEqual(c["exp"] - c["iat"], 600)
        self.assertGreater(c["exp"], 1_700_000_000)

    def test_signature_verifies_with_the_public_key(self):
        jwt = gat.make_jwt("42", self.key, now=1_700_000_000)
        head, claims, sig = jwt.split(".")
        with tempfile.TemporaryDirectory() as d:
            data = Path(d) / "data"
            data.write_bytes(f"{head}.{claims}".encode())
            sigf = Path(d) / "sig"
            sigf.write_bytes(b64url_decode(sig))
            r = subprocess.run(["openssl", "dgst", "-sha256", "-verify", str(self.pub_path),
                                "-signature", str(sigf), str(data)], capture_output=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_no_padding_in_any_part(self):
        jwt = gat.make_jwt("7", self.key, now=1_700_000_000)
        self.assertNotIn("=", jwt)
        self.assertEqual(jwt.count("."), 2)

    def test_the_key_never_touches_the_disk(self):
        # The key goes to openssl on stdin: no file argument names it.
        seen = []
        real = subprocess.run

        def spy(args, **kw):
            seen.append((list(args), kw.get("input")))
            return real(args, **kw)

        gat.subprocess.run = spy
        try:
            gat.make_jwt("7", self.key, now=1_700_000_000)
        finally:
            gat.subprocess.run = real
        self.assertEqual(len(seen), 1)
        args, stdin = seen[0]
        self.assertIn("/dev/stdin", args)
        self.assertEqual(stdin, self.key.encode())
        for a in args:
            self.assertNotIn("BEGIN", a)

    def test_bad_key_fails_loudly_without_echoing_it(self):
        with self.assertRaises(gat.TokenError) as cm:
            gat.make_jwt("7", "-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----\n",
                         now=1_700_000_000)
        self.assertNotIn("not a key", str(cm.exception))

    def test_empty_inputs_refused(self):
        with self.assertRaises(gat.TokenError):
            gat.make_jwt("", self.key)
        with self.assertRaises(gat.TokenError):
            gat.make_jwt("12", "")
        with self.assertRaises(gat.TokenError):
            gat.make_jwt("12ab", self.key)


class TestMint(KeyCase):
    TABLE = {
        ("GET", "/repos/desert-mango/hippocampus-docs/installation"): (200, {"id": 99}),
        ("POST", "/app/installations/99/access_tokens"): (201, {"token": "ghs_fake", "permissions": {"contents": "write", "metadata": "read"}}),
        ("GET", "/app"): (200, {"slug": "hippocampus-derive"}),
        ("GET", "/users/hippocampus-derive%5Bbot%5D"): (200, {"id": 555, "login": "hippocampus-derive[bot]"}),
    }

    def mint(self, table=None):
        opener = FakeOpener(table or self.TABLE)
        out = gat.mint("1234", self.key, "desert-mango/hippocampus-docs", opener=opener)
        return out, opener

    def test_token_and_bot_identity(self):
        out, _ = self.mint()
        self.assertEqual(out["token"], "ghs_fake")
        self.assertEqual(out["name"], "hippocampus-derive[bot]")
        self.assertEqual(out["email"], "555+hippocampus-derive[bot]@users.noreply.github.com")

    def test_token_request_is_narrow(self):
        _, opener = self.mint()
        post = [c for c in opener.calls if c["method"] == "POST"]
        self.assertEqual(len(post), 1)
        self.assertEqual(post[0]["body"], {"repositories": ["hippocampus-docs"],
                                           "permissions": {"contents": "write"}})

    def test_app_calls_use_the_jwt(self):
        _, opener = self.mint()
        for c in opener.calls:
            if c["path"].startswith("/users/"):
                continue  # a public profile read
            self.assertTrue(c["auth"].startswith("Bearer ey"), c)

    def test_wrong_permissions_back_is_refused(self):
        table = dict(self.TABLE)
        table[("POST", "/app/installations/99/access_tokens")] = (
            201, {"token": "ghs_x", "permissions": {"contents": "read"}})
        with self.assertRaises(gat.TokenError):
            self.mint(table)

    def test_not_installed_is_a_plain_error(self):
        table = dict(self.TABLE)
        table[("GET", "/repos/desert-mango/hippocampus-docs/installation")] = (404, {"message": "Not Found"})
        with self.assertRaises(gat.TokenError) as cm:
            self.mint(table)
        self.assertIn("not installed", str(cm.exception))

    def test_bad_repository_refused(self):
        with self.assertRaises(gat.TokenError):
            gat.mint("1", self.key, "no-slash", opener=FakeOpener(self.TABLE))


class TestRevoke(unittest.TestCase):
    def test_revoke_deletes_with_the_token(self):
        opener = FakeOpener({("DELETE", "/installation/token"): (204, None)})
        self.assertTrue(gat.revoke("ghs_abc", opener=opener))
        self.assertEqual(opener.calls[0]["auth"], "token ghs_abc")

    def test_revoke_without_a_token_is_a_no_op(self):
        r = subprocess.run([sys.executable, "-I", str(REPO / "tools/github_app_token.py"), "--revoke"],
                           env={"PATH": os.environ["PATH"]}, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout, "")


class TestCli(KeyCase):
    def run_cli(self, env):
        full = {"PATH": os.environ["PATH"], **env}
        return subprocess.run([sys.executable, "-I", str(REPO / "tools/github_app_token.py")],
                              env=full, capture_output=True, text=True)

    def test_missing_env_exits_2_and_says_which(self):
        r = self.run_cli({"GITHUB_REPOSITORY": "a/b"})
        self.assertEqual(r.returncode, 2)
        self.assertIn("DERIVE_APP_ID", r.stderr)
        self.assertEqual(r.stdout, "")

    def test_key_is_never_printed(self):
        r = self.run_cli({"DERIVE_APP_ID": "abc", "DERIVE_APP_PRIVATE_KEY": self.key,
                          "GITHUB_REPOSITORY": "a/b"})
        self.assertNotEqual(r.returncode, 0)
        body = self.key.splitlines()[1]
        self.assertNotIn(body, r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
