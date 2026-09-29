# Raw GitHub fixtures (`tools/tests/fixtures/github-data/`)

These files are **raw GitHub REST API responses**, captured with `gh api --include`, then
**scrubbed** of personal data. They keep GitHub's own shape (every key, every nesting), so
the GitHub-data builder and the fake GitHub server in later units can be tested against what
GitHub really sends. They are committed to a public repository, so the values that could
identify a person beyond a public login and display name are replaced (see "Scrub rules").

Nothing here is edited by hand. Re-create everything with:

    tools/tests/fixtures/github-data/capture.sh            # network; `gh` must be logged in
    tools/tests/fixtures/github-data/capture.sh --verify   # offline; exits 1 on any leak

The capture runs the `--verify` scan on its staged output BEFORE it replaces anything here
(a failing scan exits 1 and leaves this folder untouched), and once more on this folder at
the end. Re-running it gives the same bodies;
only the `X-Ratelimit-Remaining` / `X-Ratelimit-Used` header lines change (and, over time,
whatever GitHub itself changes: new commits, stars, the `main` ref).

## How to find a file: `index.json`

`index.json` is written by `capture.sh`. Each entry in `requests` is one request:
`method`, `path` (with a leading `/`), `query` (an object of strings, in request order),
`status`, `body` (the JSON file), `headers` (its sidecar), `source` (`gh` = captured, then
scrubbed; `hand-made` = derived from a captured body) and a `note`. Look a request up by
method + path + query, never by guessing a file name. `git_show` lists the page texts
taken from this repository with `git show`.

Each `<name>.headers` sidecar holds the HTTP status line, then an ALLOWLIST of headers:
`Content-Type`, `Etag`, `Last-Modified`, `Link`, `X-Ratelimit-*`,
`X-Github-Api-Version-Selected`, `X-Github-Media-Type`. Every other header (request ids,
OAuth scopes, client id, dates) is dropped.

## What was captured, and why

Capture day: 2026-09-29, with the default `gh` account (`kyle-nelson-berkeley`). Only GET
requests are made; PR #1 is read, never changed.

| Request | File | Why |
|---|---|---|
| `orgs/HippoCampusRobotics/repos?type=public&per_page=100` | `org-repos.json` | the COMPLETE list: all 94 public repos fit on page 1, so it has no `Link` header (a next page fails the capture, see "Complete answers") |
| `repos/…/docs/commits?since=2025-09-29…` | `commits-docs.json` | a non-fork repo, the last 365 days (the since date is a constant, so re-runs match). Page 1 only, by design |
| `repos/…/hippocampus_common/commits?since=2022-03-01…` | `commits-hippocampus_common.json` | holds two commits with `"author": null` (an unlinked git author). No org repo has such a commit in the last 365 days, so `since` is widened for this one repo. Page 1 only, by design |
| `repos/…/mavros/commits?since=2020-01-01…` | `commits-mavros.json` | a fork. No fork has a commit in the last 365 days, so `since` is widened so the fork has commits to exclude. Page 1 only, by design |
| `repos/…/docs/releases` | `releases-docs.json` | an empty release list |
| `users/<login>` ×6 | `user-<login>.json` | `NBauschmann`, `lennartalff`, `DanielDuecker`, `FinnBreu`, `RHochdahl`, `timzarhansen` (the auto-match and map-match cases) |
| `repos/…/docs/commits?path=…` | `page-commits-<page>-<when>.json` | the three example pages of the old docs repo, see below |
| `repos/desert-mango/hippocampus-docs/pulls?state=all` | `pulls-all.json` | this repo's pull requests |
| `…/pulls/1`, `…/pulls/1/files` | `pull-1.json`, `pull-1-files.json` | PR #1 (`proposal/hippo-01-parity-docs`) |
| `…/compare/75f09dd...d0bdc64` | `compare-75f09dd...d0bdc64.json` | PR #1 against its base |
| `…/commits/d0bdc64/check-runs` | `check-runs-d0bdc64.json` | the runs on PR #1's head |
| `…/check-runs/<id>/annotations` | `check-run-check-annotations.json` | the annotations of the run named `check` (empty: it passed) |
| `user` | `user.json` | the signed-in account |
| `repos/desert-mango/hippocampus-docs` | `repo-push.json`, `repo-readonly.json` | see "Permissions" |
| `…/git/ref/heads/main` | `ref-heads-main.json` | `main`'s head ref |
| hand-made | `org-repos-per50-p1.json`, `-p2.json` | see "Pagination" |

### The three example pages (old docs repo `HippoCampusRobotics/docs`)

On 2025-03-10 the old docs repo moved every page under `contents/` ("moving all contents to
seperate folder", `dc94dad`). The same day, a restructure (`822b8c8`) had already renamed the
Raspberry Pi folder from `raspberry_pi_4b_setup/` to `raspberry_pi_setup/`. GitHub's
`commits?path=` does not follow renames, so each path is a separate request. The older paths
use `until=2025-03-11T00:00:00Z`.

| Page | current path | pre-move path | before the restructure |
|---|---|---|---|
| Ubuntu 24.04 server | `contents/raspberry_pi_setup/ubuntu_24.04_server_64bit.rst` | `raspberry_pi_setup/ubuntu_24.04_server_64bit.rst` | `raspberry_pi_4b_setup/ubuntu_24.04_server_64bit.rst` |
| Raspberry Pi ethernet | `contents/raspberry_pi_setup/ethernet.rst` | `raspberry_pi_setup/ethernet.rst` | `raspberry_pi_4b_setup/ethernet.rst` |
| ROS installation | `contents/getting_started/ros_installation.rst` | `getting_started/ros_installation.rst` | (not renamed) |

### The Ubuntu page in this repository

`content/setup/raspberry-pi/ubuntu-24-04-server.md`, taken with `git show` (not the API):
`page-ubuntu-24-04-server.at-d0bdc64.md` (PR #1's head), `.at-merge-base.md` and
`.at-75f09dd.md` (PR #1's base). PR #1's merge base with `75f09dd` IS `75f09dd`, so the
merge-base file and the `75f09dd` file are the same bytes. Both are kept on purpose: a
later branch may move `main`, and the tests should name which one they mean.

### Permissions

Both logged-in accounts get `permissions.push: true` on this repository. `repo-push.json` is
the default account's real answer (a write collaborator: `push` and `triage` true, `admin`
and `maintain` false). `repo-readonly.json` is a HAND-EDITED copy of it: `admin`,
`maintain`, `push` and `triage` set to `false` (`pull` stays `true`), which is what a
read-only visitor sees. Its sidecar is a copy of `repo-push.headers`.

### Pagination (hand-made)

No captured response needs a second page, so `capture.sh` makes one: it splits the captured
`org-repos.json` into `per_page=50` pages. Page 1 (`org-repos-per50-p1`, the request without
`page`) carries `Link: <…&page=2>; rel="next", <…&page=2>; rel="last"`; page 2
(`…&page=2`) carries only `rel="prev"` and `rel="first"`. Following `next` from page 1 must
give exactly the repos of `org-repos.json`. Real GitHub may write the `Link` URLs as
`/organizations/<id>/repos`; these use `/orgs/HippoCampusRobotics/repos` so a fake server
can serve them from this index. A builder must follow the `Link` URL as given.

### Complete answers vs page 1

Every captured request stands for GitHub's COMPLETE answer, except the three `commits-*`
captures (`commits-docs`, `commits-hippocampus_common`, `commits-mavros`): those are page 1
(`per_page=100`) BY DESIGN, and later pages, if GitHub ever has them, are not fetched. For
every other capture, `capture.sh` reads the scrubbed sidecar right after the request: a
`Link` header with `rel="next"` (GitHub has more pages) stops the run with an error, before
this folder is touched. So if the org ever has more than 100 public repos, a re-capture fails
loudly instead of writing a short `org-repos.json` (and short hand-made pages derived from
it); the fix is to paginate that request in `capture.sh`.

### PR #1 is a snapshot at d0bdc64

Every PR #1 fixture describes ONE fixed moment: PR #1 with its head at `d0bdc64`
(`d0bdc64b22147adde2707e86df4f7e7e4658dfeb`, the constant `PR_HEAD_FULL` in `capture.sh`).
The compare, the check runs, the annotations and the `git show` page text ask for that sha
by name. `pulls?state=all`, `pulls/1` and `pulls/1/files` cannot: GitHub answers them with
whatever PR #1 points at today. So right after those three requests, `capture.sh` reads every
head sha they carry for PR #1 (`head.sha` in `pull-1.json` and in PR #1's entry of
`pulls-all.json`; the sha inside each `blob_url`, `raw_url` and `contents_url` of
`pull-1-files.json`) and stops the run with an error, before this folder is touched, if any of
them is not `d0bdc64` (or PR #1 is missing). A re-capture therefore never mixes a moved PR
with the pinned snapshot. If PR #1 has moved on purpose, re-pin `PR_HEAD_FULL` deliberately
and re-review every PR-derived fixture.

## Scrub rules (applied by `capture.sh`, to every body and sidecar)

1. Every `commit.author.email` and `commit.committer.email` becomes `<login>@example.invalid`,
   where `<login>` is the matching top-level `author.login` / `committer.login`. When that
   top-level object is `null`, it becomes `noreply@example.invalid`.
2. Every `verification` object becomes
   `{"verified": false, "reason": "unsigned", "signature": null, "payload": null}`.
3. In every object that has a `login` key (`users/<login>`, `user`, any embedded user), the
   profile fields `email`, `location`, `company`, `bio`, `blog`, `twitter_username`,
   `hireable`, `followers`, `following`, `public_repos`, `public_gists`,
   `notification_email` are set to `null`. The KEY stays, so a test can prove the builder
   drops it. The private-only fields of `user` (`private_gists`, `total_private_repos`,
   `owned_private_repos`, `disk_usage`, `collaborators`, `two_factor_authentication`, `plan`)
   are removed.
4. Any other e-mail-shaped string (`check.py`'s `EMAIL_RE`) that does not end in
   `@example.invalid` becomes `redacted@example.invalid`. This also hits strings that are not
   personal: every `ssh_url` (GitHub's SSH clone address, user `git` at host `github.com`) now starts
   with `redacted@example.invalid:`,
   and commit-message trailers such as `Co-Authored-By: … <…>` are redacted. That is the
   rule, on purpose: no exceptions to reason about.

`--verify` re-checks all four rules, and that every sidecar holds only allowlisted headers.
It was proved to FAIL on an unscrubbed copy of the `hippocampus_common` commits and `user`
responses (69 problems, exit 1) before the first real capture.

`tools/check.py` does not scan this folder today (it scans `content/` and `data/`), so no
fixture was changed to satisfy the gate.
