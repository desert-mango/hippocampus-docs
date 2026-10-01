# Handoff gap list — 2026-10-01

*An audit, not a build. Written 2026-10-01 against `main` at `433f66a`, four days before the
lab handoff on 2026-10-05. Nothing in the code, data or content was changed. The master plan is
`docs/cms-v2-plan.md` (units U1–U12, steps M1–M10).*

**How to read the table.** `done` = the code is there, its tests pass, and the live part (if
any) answers. `partly` = the code is there and its tests pass, but the plan's live check has
not been run or is blocked. `missing` = not built, or not done. "Where it can be finished":
`this laptop` (Kyle's M1 MacBook Pro, where this audit ran) or `needs the M4 Mac` (Kyle's other
computer, out of reach today).

**What points to the M4 Mac.** Only one thing in the repo names it: the SSH key row in
`docs/cms-v2-plan.md:953` and step M6 (`docs/cms-v2-plan.md:1194`) record the key titled
`desert-mango-m4-macbookpro`. This laptop has its own Desert Mango key (comment
`desert-mango-m1-macbookpro`) behind the same `github-desert-mango` host name, and this file was
pushed with it, so pushing `main` (including `.github/` changes) works from here. The other
thing that may live on the M4 Mac is the newer plan (see below); that is a guess, not a finding.

## The newer plan (the 2026-09-29 U0–U5 commits)

**Not found.** Searched: `~/.claude-os/prompts/`, `~/.claude-os/runs/`, `~/.claude/projects/`
(no hippocampus project folder on this laptop), `docs/`, and every ref in `git log --all`
(including the four `archive/*` branches). Its unit list below is **inferred** from the commit
messages and code comments only. What the code says about it:

- It moves the editor out of `/cms/` and into the site itself, as an "Editor mode" with tabs
  (`#/<route>?editor=proposals|changes|media|guide`, decision D-H) — `js/cms-redirect.js:6-21`.
- It plans two files that do not exist yet: `js/editor.js` and `js/editor-frame.js`, already
  named in the reader list at `CLAUDE.md:110-111` and `tools/check.py:125`.
- Its U8 retires `/cms/` by loading `js/cms-redirect.js` there (`433f66a` message;
  `js/cms-core.js:1314`).
- There is no commit labelled U4, U6 or U7 of this plan.

The two plans reuse the same unit names (both have a "U8"). Rows for the newer plan carry an
`N-` prefix.

## Gap table

### CMS v2 plan — build units

| Unit | Status | Evidence | Where it can be finished |
|---|---|---|---|
| U1 gate before deploy | done | `vercel.json:3` runs `tools/check.py` as the build; CI run on `433f66a` = success | this laptop |
| U2 derived data without a terminal | done | `derive` run on `433f66a` = success; `test_derive.py` 42/42 OK | this laptop |
| U3 harden `check.py` | done | `python3 tools/check.py` → all green; `test_check_content_safety.py` 49/49 OK | this laptop |
| U4 sanitizer, content seam, preview bridge, "Edit this page" | done | `test_sanitize.mjs` 24/24, `test_preview_bridge.mjs` 21/21; link at `js/app.js:650` | this laptop |
| U4b CSP headers (after handoff) | missing | `vercel.json:15-22` sets only `X-Robots-Tag` | this laptop |
| U5 `api/auth.js` + callback | done | `test_auth_handler.mjs` 35/35; live `GET /api/auth?app=editor` → 200 with a client id | this laptop |
| U6 `api/media.js` Cloudinary gateway | partly | `test_media_handler.mjs` 44/44; live `POST /api/media` → 400 "Cloudinary is not configured on this host" (M4 not done) | this laptop |
| U7a signed-in shell | partly | `test_cms_core.mjs` 90/90; `/cms/` → 200; the plan's live sign-in check (Editor badge, Admin badge) is not recorded anywhere | this laptop |
| U7b editor: drafts, snippets, preview, Propose | partly | `HCCore.runPropose` at `js/cms-core.js:1672`, called at `js/cms.js:1010`; `test_cms_editor.mjs` 32/32 against a fake GitHub; no proposal has ever been made from the editor (public PR list holds only #1–#3, none on a `cms/` branch) | this laptop |
| U8 Review tab (without Undo) | partly | `test_cms_core.mjs` 90/90 incl. badges, check-run status, annotations, Revert link (`js/cms-core.js:876`); the R5 test is not done: PR #1 still open (`mergeable_state: clean`, head `d0bdc64`); no red-PR test recorded | this laptop |
| U8 Undo inside the tab (after handoff) | missing | only "Undo on GitHub" exists (`js/cms.js:546`) | this laptop |
| U9 Media tab | partly | `test_cms_media.mjs` 18/18; live upload blocked by the same missing Cloudinary keys as U6 | this laptop |
| U10 Private tab (after handoff) | missing | route is a placeholder: `js/cms-core.js:115` | this laptop |
| U11 docs and protocols | partly | `docs/maintainer-protocols.md` matches the code: every button and message it quotes was found in `js/cms.js`, `js/cms-core.js` or `js/app.js` (e.g. "Proposed as #n." `js/cms-core.js:1744`, "What to fix (file, line, message):" `js/cms.js:455`); the plan's cold-agent test is not recorded. It describes `/cms/`, so it goes stale if the newer plan retires `/cms/` | this laptop |
| U12 rehearsal, must-have tier | missing | needs a real GitHub sign-in (two accounts), which this audit could not do; no PR or record shows it ran | this laptop |
| U12 rehearsal, next tier (editor proposal + media upload) | missing | blocked by U7b live, M4 | this laptop |

### CMS v2 plan — Kyle's manual steps

| Step | Status | Evidence | Where it can be finished |
|---|---|---|---|
| M1 account, import, deploy tests, domain move | done | recorded passed, `docs/cms-v2-plan.md:1402-1493` | this laptop |
| M2 editor GitHub App | done | live `GET /api/auth?app=editor` returns a client id | this laptop |
| M3 GitHub App variables | done | same live answer (the id and secret are both required, `api/auth.js:35`) | this laptop |
| M3 Cloudinary variables | missing | live `/api/media` → "Cloudinary is not configured on this host" | this laptop |
| M4 Cloudinary key pair | missing | same live answer | this laptop |
| M5 Nathalie gets Admin | missing | not recorded anywhere; the collaborator list needs a sign-in to read | this laptop |
| M6 SSH key for workflow pushes | done | `docs/cms-v2-plan.md:1194`; this laptop's own key pushed this file | this laptop |
| M8 Actions write fallback | done (not needed) | `derive.yml` runs succeed (`derive` on `433f66a` = success) | this laptop |
| M9 unblock PR #1 | partly | agent half done (`docs/cms-v2-plan.md:1228`); Kyle's judgement in `/cms/#/review/1` still open | this laptop |
| M2b viewer App (after handoff) | missing | not recorded | this laptop |
| M7 lab org installs viewer App (after handoff) | missing | needs a `HippoCampusRobotics` owner | this laptop |
| M10 optional tidy-ups | missing | not recorded | this laptop |

### Newer plan (inferred, not found)

| Unit | Status | Evidence | Where it can be finished |
|---|---|---|---|
| N-U0 raw GitHub API fixtures | done | `f4ad17c`; used by `test_build_github_data.py` 41/41 OK | this laptop |
| N-U1 GitHub layer builder + gate section 11 | done | `22331a7`; `test_build_github_data.py` 41/41, `test_check_github_layer.py` 42/42 OK | this laptop |
| N-U2 login-to-roster matcher | done | `5f351c3`; `test_github_names.py` 32/32, `test_build_contributors.py` 53/53 OK | this laptop |
| N-U3 public Lab page, repo cards, popover | done | `05d7082`; `test_lab_ui.mjs` 17/17; loaded at `index.html:61` | this laptop |
| N-U4 (unknown) | missing | no commit carries this label; its content is unknown without the plan | needs the M4 Mac |
| N-U5 block model, span editor, org reader | partly | `433f66a`; `test_block_model.mjs` 27/27, `browser_oracles.mjs` 2/2; but no page uses it yet: `splitBlocks`, `createOrgReader`, `blockDiff` appear only in `js/cms-core.js` | this laptop |
| N-U6/U7 (inferred) Editor mode inside the site | missing | `js/editor.js` and `js/editor-frame.js` do not exist; `js/app.js` has no `?editor=` handling | this laptop |
| N-U8 retire `/cms/` (load the redirect) | missing | `js/cms-redirect.js` is loaded by no page (`cms/index.html:38-40` loads `source.js`, `cms-core.js`, `cms.js` only). Do not load it before Editor mode exists: it would send `/cms/` users to tabs that are not there | this laptop |

**Counts:** 14 done, 8 partly, 14 missing (36 rows). 35 can be finished on this laptop; 1
(N-U4, because its plan may live there) needs the M4 Mac.

## The three gaps that matter most for 2026-10-05

1. **The must-have rehearsal (U12) and Kyle's PR #1 judgement (M9, U8's R5 test).** Nothing
   proves the Review tab works with real accounts. First step: Kyle signs in at
   `https://hippocampus-docs.vercel.app/cms/` as `desert-mango-robotics`, opens `#/review/1`,
   and checks for the green ✓ line and the rendered preview.
2. **Nathalie's Admin role (M5).** Without it she cannot approve or merge. First step: Kyle opens
   `https://github.com/desert-mango/hippocampus-docs/settings/access` and checks that
   `NBauschmann` is listed with the Admin role.
3. **One real editor proposal (U7b live).** `runPropose` is tested only against a fake GitHub.
   First step: sign in as `kyle-nelson-berkeley`, edit one setup page, click **Propose**, then
   `gh pr view <n> --json headRefName,commits,files` should show a `cms/…` branch with exactly one
   commit.

Media (U6, U9) stays blocked until M4 + the Cloudinary part of M3; the plan puts those in the
"next" tier, so the handoff can go without them if the protocols keep saying "ask Desert Mango"
for pictures.

## Needs Kyle

- Do the sign-in steps above (U12, M9, U7b live); an agent cannot sign in.
- Confirm or do M5 (Nathalie as Admin).
- Decide whether M4 (Cloudinary key pair + Vercel variables) happens before 2026-10-05.
- Find the newer plan (U0–U8, Editor mode, decisions D-A to D-M), maybe on the M4 Mac, and decide
  whether any of it is meant for the handoff. Today `/cms/` is the working editor and the
  protocols describe it.
- The old-docs password leak: not raised with the lab; Kyle's call how and when.
- Rotate the OpenRouter key (open follow-up in `docs/cms-v2-plan.md:1490-1493`).
- Node is not on this laptop's `PATH`; this audit ran the tests with the Node 24 binary bundled
  under `~/.cache/codex-runtimes/`. Installing Node would make the tests easy to run here.

## Test and gate evidence (2026-10-01, at `433f66a`)

- `node --test tools/tests/test_*.mjs` (14 files): 482 tests, 482 pass, 0 fail, 0 skipped.
  `test_auth_handler` 35, `test_block_model` 27, `test_cms_core` 90, `test_cms_editor` 32,
  `test_cms_media` 18, `test_cms_redirect` 3, `test_graph_ui` 24, `test_home_hero` 17,
  `test_lab_ui` 17, `test_librarian_handler` 74, `test_media_handler` 44,
  `test_preview_bridge` 21, `test_sanitize` 24, `test_search_routing` 56.
- `node --test tools/tests/browser_oracles.mjs` (headless Chrome): 2/2 pass.
- `python3 -m unittest tools/tests/test_*.py` (10 files): 470 tests, all OK.
  `test_attribution_headers` 12, `test_build_contributors` 53, `test_build_github_data` 41,
  `test_build_repo_graphs` 46, `test_build_wiki_graph` 55, `test_check_content_safety` 49,
  `test_check_github_layer` 42, `test_check_graph` 98, `test_derive` 42, `test_github_names` 32.
- `python3 tools/check.py` → `check.py: all green`.
- Live, read-only (no sign-in): `/cms/` 200; `GET /api/auth?app=editor` 200; `POST /api/media`
  400 "Cloudinary is not configured on this host"; public GitHub API: PR #1 open and clean, CI
  and `derive` runs on `433f66a` success.
