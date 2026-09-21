# hippocampus-docs CMS v2 — the editing system for the lab handoff

*Plan, 2026-09-21, revision 3 (plan-review rounds 1–3 folded in; reviewer sign-off in round 3 — see the changelog before §12).
Author: Fable 5.1 (Chief Architect role). Receiver: /plan-review with an Opus 5 reviewer, run by
the orchestrator. This is a plan, not code. Nothing in either repo was edited.*

**One sentence.** Keep "the CMS is GitHub", add a thin signed-in area at `/cms/` on the site itself
(vanilla JS, no bundle, no framework) where lab members sign in with a GitHub App, edit pages and
registries with a live preview rendered by the site's own code, and press one button that opens a
pull request; Nathalie reviews the PR in the same area (rendered preview, green ✓ / red ✗), approves
and merges; a GitHub Action regenerates derived data on `main`; Vercel runs `tools/check.py` before
every deploy; images go straight to Cloudinary through signed uploads that a small serverless
function scopes to `hippocampus-docs/`; a "Private" tab lists lab repositories at view time with the
viewer's own GitHub rights.

**Where the deploy path stands.** Kyle decided on 2026-09-21 that the site moves to a **new
Desert Mango Vercel account** (GitHub login `desert-mango-robotics`, Hobby to start), re-imported
from `desert-mango/hippocampus-docs`, with the domain and the environment variables moved fresh
(§3 "Hosting"). Vercel's own docs, read today, put two rules under the heading "Deploying private
Git repositories": a Hobby team cannot deploy a private repository owned by a GitHub organization,
and on organization repositories only the Hobby owner's own commits deploy; "for public Git
repositories, a different behavior applies" — commits usually deploy automatically and only pull
requests from forks need an authorization click [S1][S2][S3]. So the choice in front of Kyle now,
before the build, is the pair in E1: **private + Pro ($20–40/month)** or **public + Hobby ($0)**.
Going forward `main` is authored as Desert Mango (the repo-local identity); today's HEAD `a47a27a`
is authored by a SimpleLogin alias and `b114a20` by `kyle-nelson@berkeley.edu`, so the import's
first deploy builds a non-owner-authored HEAD and its result alone proves nothing — M1 carries the
three tests that do (owner commit, non-owner squash merge, bot commit). Every unit below is
host-neutral (the editor, previews and reviews run on the GitHub API, not on Vercel previews), so
the plan works unchanged under either choice.

---

## Delivery tiers (plan-review round 1, R1-F8)

The handoff date is 2026-10-05. Desert Mango keeps maintaining the site afterwards, so the
deadline covers only what needs Kyle's presence at TUHH or what would block the lab from working
alone. Review-with-preview comes first: editing already works on github.com today (the pencil
path in `CONTRIBUTING.md`), while a rendered preview for approval exists nowhere yet and is
Nathalie's core job. Each unit header in §4 carries its tier.

| Tier | What | Why it sits here |
|---|---|---|
| **Must-have by 2026-10-05** | E1 decided by Kyle + M1 with the corrected tests (owner commit, non-owner squash merge, bot commit) and the gated domain move; M2 → M3 (GitHub App variables); U1; U2 with the authored-overlay rule; U3; M5; M9 + PR #1 judged by Kyle in the CMS (M9 after U2 is merged); U4 without the CSP headers (sanitizer fixed, seam, bridge); U5; U7a (CMS shell: sign-in, role badge, the `#/review` routes); U8 without Undo (the protocol points to GitHub's own **Revert** button [S89]); U11 written for the day-one path (github.com pencil to edit, CMS Review tab to preview, approve and merge). | Without these the lab cannot see, approve and deploy a change alone, or the deploy is not gated. |
| **Next — targeted inside the window if on track** | U7b (the editor: drafts, snippets, live preview, Propose), then M4 + the Cloudinary part of M3, U6 + U9 (media). | Editing on github.com works today; the editor is comfort, and media is the next most-asked-for. |
| **After the handoff** | M2b + M7, U10 (Private tab: needs the second, read-only App and a lab-org owner anyway), Undo in the Review tab, form-based registry editors, U4b (the CSP headers), M10 tidy-ups. | None blocks the lab; each is a normal Desert Mango maintenance change through the same pipeline. |

U12 (the integration rehearsal) runs once per tier, on what that tier shipped.

---

## 0. Table of contents

0. Delivery tiers (above)
1. Requirement trace
2. Decisions and rejected alternatives
3. Architecture — what exists, what is added
4. Build units U1–U12, with U7 split into U7a/U7b and U4b split from U4 (files, acceptance, dependencies, model tier, delivery tier)
5. Security model
6. Kyle's manual steps (exact clicks) — and the lab's one-time steps
7. Docs to change
8. Cost
9. Escalations
10. What could not be verified
11. Build rules for the implementer
— Revision 1, 2 and 3 changelogs (plan-review rounds 1–3)
12. Sources

---

## 1. Requirement trace

| Req | Kyle's ask | Units that meet it | Manual steps | Tier |
|---|---|---|---|---|
| R1 | Upload and manage media on Cloudinary with an API key, via our CMS | U6 (`api/media.js`, signed uploads scoped to `hippocampus-docs/`), U9 (Media tab), U3 (manifest entries without a local source) | M4 (Cloudinary key pair), M3 (Vercel env) | U3 must-have; U6, U9 next |
| R2 | Nathalie can approve reviews and merges | U8 (Review tab: approve, request changes, merge; rollback through GitHub's Revert), U11 (protocols) | M5 (Nathalie = repo Admin) | must-have |
| R3 | GitHub is the auth layer; private repos tracked at view time, case by case, nothing committed | U5 (GitHub App login), U10 (Private tab reads a second, read-only App's installation on the lab org with the viewer's token), U3 (no private-repo data can enter `search/` or `data/graph/`: derived data is built only from the public snapshot) | M2 (editor App), M2b + M7 (viewer App, installed by the lab org) | U5 must-have; U10 after the handoff |
| R4 | Written maintainer protocols for non-technical owners | U11 (`docs/maintainer-protocols.md`) | — | must-have (day-one path) |
| R5 | See what edits look like before approving | U4 (site renders from any git ref through a sandboxed preview bridge), U7a (the CMS shell that hosts the Review tab), U8 (PR preview; PR #1 is the acceptance test), U7b (live preview while editing) | M9 (PR #1 conflict fix) | U4, U7a, U8 must-have; U7b next |
| R6 | A GitHub Action regenerates derived data; nobody needs a terminal | U2 (`tools/derive.py`, `derive.yml`, regenerate-before-check on pull requests, the authored-overlay rule) | M6 (done), M8 fallback only | must-have |
| R7 | Vercel runs `tools/check.py` before each deploy; served bytes byte-identical | U1 (`buildCommand`, no bytecode in output, no Vercel builds for `cms/**`), U11 (`CLAUDE.md` amendment) | M1 (deploy-path tests) | must-have |

---

## 2. Decisions and rejected alternatives

### D1. The editor is a thin custom `/cms/`, not Sveltia, Decap or Pages CMS

**Chosen:** `cms/index.html` + `js/cms.js` + `js/cms-core.js` (pure, unit-tested) + `css/cms.css`.
Vanilla JS, GitHub REST API from the browser, previews rendered by the site's own `js/app.js`.

**Why, with the facts that decided it:**

- R5 needs a rendered preview of PR #1, a pull request made with git outside any CMS. Sveltia
  discovers only its own `cms/…` branches and labels; reviewing arbitrary PRs is not stated as
  supported [S71]. Decap likewise [S82]. A custom Review tab reads any PR.
- The preview must be the site's own rendering. The dialect (`<div class="adm adm-note">`,
  `<div class="tabs">`) needs the site's CSS and the JS in `enhance()` (tabs are built at
  runtime). Sveltia's preview sanitizes HTML with DOMPurify by default and warns that turning it off
  exposes the CMS to XSS [S76]; custom templates are React class components [S77]. Decap's preview
  templates are React too [S85]. Neither runs `js/app.js`.
- Cloudinary in both products means Cloudinary's hosted widget script and a Cloudinary user login
  per editor [S73][S84][S65]. That is a third-party script from a CDN (forbidden by the scope guard)
  and gives editors the whole account, which also holds the portfolio. Kyle's decision is the
  opposite: secret on the server only, operations only inside `hippocampus-docs/`.
- Bundle rule. Decap's `decap-cms.js` is 5.15 MB split across about 180 chunk files [S80], not one
  file. Sveltia's `sveltia-cms.js` is 2.11 MB plus a `dist/chunks/react-dom.js` whose load
  condition is not stated [S74]. The scope guard allows one vendored, sha256-pinned file.
- Registries. Sveltia rewrites JSON with 2-space indentation and config-ordered keys [S75]; our
  cross-file rules (repo coverage, parity, orphans) cannot be expressed in a CMS config, so a CMS
  can produce edits the gate rejects — the worst experience for a non-technical editor. The custom
  editor validates JSON before it commits and shows the gate's own messages.
- Login work is the same either way: Sveltia's GitHub backend also needs an OAuth app plus a small
  server [S70]. We would write `api/auth.js` regardless.
- Pages CMS is free but edits files directly in the branch (no PR workflow stated), stores media
  in the repo, and self-hosting needs Next.js and PostgreSQL [S87]. TinaCMS and Keystatic need a
  framework and npm [S88].

**Cost of the choice:** about 2,000–2,500 lines of vanilla JS and two ~150-line functions, all
ours to maintain. Mitigation: pure logic lives in `js/cms-core.js` with node tests; the UI is
deliberately plain (forms, textareas, one iframe); and the delivery tiers above put only the
review half (U7a + U8) inside the handoff window — the editor and media follow.

### D2. Sign-in is a GitHub App (user access tokens), not an OAuth App or personal tokens

- A GitHub App user token "can only access resources that both the user and app can access"
  [S28]; an OAuth App's `repo` scope "grants full access to public and private repositories"
  the user can reach [S31]. For a token that sits in a browser tab, the narrow one wins.
- The token exchange needs the client secret [S28], so it runs in `api/auth.js` on Vercel. Device
  flow would avoid the secret but GitHub says browser apps should use the web flow [S28].
- User tokens expire after 8 hours [S29]; we keep expiry on (re-sign-in is one click) and do not
  implement refresh tokens in v1.
- A second, read-only App gives R3 its "case by case" mechanism (D7) without committing anything
  and without asking the lab org to grant write access to a company-owned App.
- Personal access tokens (which Sveltia supports [S70]) are rejected: a lab member would have to
  create and paste a token — the opposite of "sign in with GitHub".
- The editor App is **public** ("Any account"). A private App can be authorized only by members
  of the organization that owns it [S92], and Nathalie and the lab members are outside
  collaborators of `desert-mango`, not members — with a private App nobody but
  `desert-mango-robotics` could sign in (R2-F1). Public changes nothing about reach: only
  `desert-mango` installs it, so tokens still reach only this repository, and `js/cms.js` ignores
  every other repository. Lab members do not join the org to work around this.

### D3. Previews come from the GitHub API inside a sandboxed iframe, not from Vercel previews

- Works for both deploy outcomes and for any host.
- Vercel preview URLs are protected by Vercel Authentication by default, which non-members cannot
  open [S12][S13]; Hobby has one seat. Nathalie could not open them anyway.
- The preview is the real site: `index.html` loaded in an `<iframe sandbox="allow-scripts
  allow-popups">` (opaque origin, no `allow-same-origin`) at `index.html#preview=<nonce>`; the
  nonce is fresh per load and travels in the URL fragment, never in `window.name` (which survives
  navigation, so anything that navigated the frame would inherit the channel). The frame asks its
  parent for files over `postMessage`; the parent answers only messages that carry the current
  nonce, only from `event.source === iframe.contentWindow`, only for paths under `content/`,
  `data/` and `search/`, and only at the previewed ref (or the in-memory draft), fetching from the
  GitHub Contents API. The token never enters the frame.
- Where a Vercel preview comment exists on a PR, the Review tab shows the link as an extra; it is
  never the mechanism.

### D4. Derived data is never carried by a pull request

**Derived outputs:** `search/site.json`, `search/manifest.json`, `data/graph/wiki.json`, the
`"source": "derived"` entries of `data/graph/summaries.json`, the `terms` of
`data/graph/xref-terms.json`, and `data/graph/contributors.json`. They are deterministic functions
of the content. **Authored overlays are a different thing** (R1-F4): `data/graph/edges-authored.json`
(39 hand-authored edges today), the 23 `"source": "authored"` summaries in `summaries.json`, and
the `rejected` (14) and `stoplist` (71) lists of `xref-terms.json` are hand-kept inputs that the
builders read and preserve, so they are never called "derived" and `CLAUDE.md` gains no "never
hand-edited" line about them (§7). Two of them key on registry ids — the edges and the authored
summaries — and `build_wiki_graph.py` fails by name when an id they point at disappears (its
stated survivability rule); the CMS keeps existing ids read-only (D8, U7b) so a lab member cannot
strand one. The `rejected` and `stoplist` lists are word lists (".github", "Firmware", "Raspberry
Pi Setup", common words) that the builder uses only as veto sets; a rename cannot break them and
no id rule applies to them (R2-F4).

- Evidence: PR #1 is unmergeable today (`mergeable_state: dirty`) and `git merge-tree` shows the
  only conflicts are `search/manifest.json` and `search/site.json` — because the branch committed
  a shard rebuild and `main` moved. A blocked "conflicts" state is exactly what Kyle forbade for
  lab members.
- Therefore: the CMS never commits the derived outputs; **on pull requests only**, the `check` job
  regenerates them in the workspace (not committed) and then runs the verbatim gate, so a PR that
  adds a project is green without a terminal; on `push` to `main` the gate judges the committed
  tree, so CI agrees with the deploy build and with the "verbatim" law (R1-F11); after a merge,
  `derive.yml` regenerates and commits the outputs as `github-actions[bot]`.
  `build_contributors.py` stays off the PR path: it is network-bound (a flaky red for lab
  members) and `contributors.json` is optional to the gate ("when present", section 10).
- Accepted side effect: for a merge that changes the page set or the repo roster, the merge
  commit's own CI check and deploy build fail the gate (stale parity), and the bot's follow-up
  commit is meant to deploy green one to three minutes later. Production keeps serving the
  previous deploy meanwhile. The protocol names this. **Whether the bot's commit deploys at all is
  unverified until M1 step 6 passes (R1-F2, D5).** (Vercel `ignoreCommand` was considered and
  rejected: it would need the builders and `gh` inside Vercel's build, and it hides genuine
  failures.)
- Renaming or removing an existing id that an overlay points at is a Desert Mango change, whether
  attempted in the CMS (not offered) or with the github.com pencil (the gate answers with one plain
  located line naming the overlay file — U2, U3 — never a traceback).
- The old `search-shard-advisory` job is retired; `derive.yml` replaces its purpose.

### D5. The Action commits with `GITHUB_TOKEN` as `github-actions[bot]`

- Pushes made with `GITHUB_TOKEN` do not start new workflow runs [S35], so no loop is possible and
  no extra secret is needed. The derive job runs `check.py` itself before pushing and refuses to
  push red.
- The job elevates `permissions: contents: write` in its own YAML; the repository default stays
  "Read repository contents and packages permissions". GitHub states the workflow file can add or
  remove `GITHUB_TOKEN` access [S37]; U2 proves it on the first run, with M8 as the fallback.
- Trap from the brief: on Vercel Hobby with a **private** repository the commit author must be the
  team owner — now `desert-mango-robotics` on the new account. Kyle's pushes going forward
  (authored as Desert Mango, `323077863+desert-mango-robotics@users.noreply.github.com`) match;
  `github-actions[bot]` and Nathalie do not, so per the docs neither would deploy on a private
  organization repository [S1][S3]. This plan does not design around that rule (authoring the
  bot's commits as Desert Mango would be exactly that); it is part of the E1 decision.
- **Whether a bot commit deploys is unverified on every Vercel option (R1-F2).** On Pro the rule
  is "the commit author must be a member of the team" [S1][S3], and `github-actions[bot]` cannot
  be a team member; the docs only ask that bots be "clearly identified as automated" [S3]. On
  Hobby with a public repository the docs say commits "usually deploy automatically" [S1]. M1
  step 6 tests one bot commit under whichever option Kyle picks; until it shows **Ready**, D4's
  "the bot's follow-up commit deploys green" is a hope, not a fact, and E1-A's price carries that
  risk. On Cloudflare Pages any author deploys.

### D6. Cloudinary: server-signed direct uploads, folder locked by the signature

- Signed parameters must be sent back "with identical name=value pairs" [S54], so a `folder`,
  `asset_folder` or `public_id` chosen by the server cannot be changed by the browser. Unsigned
  presets are rejected: the client may send `folder` on an unsigned upload [S56] and a preset
  folder lock is not stated [S57].
- The browser posts the file straight to `api.cloudinary.com` [S55]; the function never sees file
  bytes (Vercel's 4.5 MB body limit [S15] is irrelevant).
- Admin API calls (list, delete, rename) need Basic auth with the secret [S59], so they live in
  `api/media.js` only. Deletion and renaming are allowed only for assets absent from the live
  `data/cloudinary-manifest.json` (the gate guarantees "in the manifest ⇔ referenced").
- Folder mode: new clouds are dynamic since 2024-06-04 [S58]; `dr76gues0` may be either. The
  function reads `folder_mode` from the Admin API `config` endpoint once [S58] and signs
  `folder` (fixed mode) or `asset_folder` + full-path `public_id` (dynamic mode).
- The docs site gets its own API key pair (Cloudinary allows generating and revoking key pairs
  [S66]); the portfolio key is never used here. Folder roles on API keys exist "on all plans" via
  the Admin API [S67] but their enforcement is not stated, so the lock stays in the function.

### D7. The Private tab reads a second, read-only App's installation on the lab org — nothing is committed

- Two GitHub Apps, both registered under `desert-mango` (R1-F6): the **editor App**
  (`HippoCampus Docs Editor`: Contents and Pull requests read and write, Checks read, Commit
  statuses read; installed on `desert-mango/hippocampus-docs` only) and the **viewer App**
  (`HippoCampus Docs Viewer`: Metadata, Contents read, Pull requests read; installed by the lab
  org on the repositories it chooses to track). The Private tab has its own "Sign in to view lab
  repositories" button that authorizes the viewer App. R3 needs read only, and the lab org is
  never asked to grant write to a company-owned App — the likely reason M7 would otherwise be
  refused.
- `GET /user/installations` and `GET /user/installations/{id}/repositories` return what the
  authenticated user has explicit permission to access for that installation [S34]. So the tracked
  set = the repositories the lab org selected when installing the viewer App; per-person visibility
  = that person's own GitHub access. Nathalie adds a person by giving them access to the repository
  on GitHub. No name of a private repository exists in this repo, in `search/`, in `data/graph/`
  or in the CMS code.
- The owner of an App can generate a private key at any time and mint installation tokens with no
  user involved; "no private key generated" is a current state, not a guarantee. What bounds it is
  the viewer App's permission set (read only) and the lab org's own repository selection; §5
  states this plainly. If the lab prefers, `HippoCampusRobotics` can own the viewer App instead —
  that changes M2b's URL and nothing else.
- Alternative rejected: an OAuth App with `repo` scope and a topic filter — broad token; the token
  risk is worse (D2).
- Tier: after the handoff (§ Delivery tiers).

### D8. Roles

| GitHub role on `desert-mango/hippocampus-docs` | Who | What the CMS shows |
|---|---|---|
| Admin | Nathalie, Desert Mango | Everything, plus "Manage people" (link to GitHub settings) |
| Maintain | Trusted reviewers Nathalie names | Review: approve, request changes, merge, update from main |
| Write | Lab members | Edit and propose (U7b), media upload (U9); existing registry ids are read-only; the Merge button is hidden |
| Read, or none | Everyone else | The editor App is public, so any GitHub account can authorize it — that is "sign in" (a private App could be authorized only by `desert-mango` org members, and Nathalie and the lab are outside collaborators [S92], R2-F1). What comes next depends on the repository: while it is private, the CMS's one repository lookup (`GET /repos/desert-mango/hippocampus-docs`) answers 404 for a non-collaborator and the CMS shows "you do not have access to this site's repository" and nothing else; if E1-C makes it public, the lookup succeeds for everyone and they get the **read-only state** — Review tab without buttons, previews, no Media, no Propose. `permissions.push` gates every action; `js/cms.js` never reads or lists any other repository the token could reach. The public site is unchanged either way. |

The CMS reads `permissions` from `GET /repos/desert-mango/hippocampus-docs` with the user's token.
Hiding a button is a courtesy, not a lock: Kyle's rule is no merge-blocking anything. A Write
member can still merge on github.com; the protocol says who merges. Renaming or removing an
existing id (project, tool, setup page, people group) is not offered in the CMS and is routed to
Desert Mango (D4); rollback is GitHub's own **Revert** button on the merged PR [S89] until the
Review tab's Undo ships after the handoff.

Lab members are collaborators with branches in the repo, not fork contributors: the App's user
token must reach the repo (D2), same-repo PRs need no "Approve and run" click, and the Actions
approval setting only concerns fork PRs from people without write access [S37][S50]. The
fork-PR path stays available to outsiders and is unchanged.

### D9. The deploy path is decided by test M1, not by design

Per the brief: no designing around a plan restriction. See E1.

---

## 3. Architecture — what exists, what is added

**Hosting (Kyle's decision, 2026-09-21).** The site moves off Kyle's personal Vercel account
(`kyle-nelson-berkeley`, which still hosts desert-mango.com and the portfolio) to a **new Desert
Mango Vercel account** whose GitHub login is `desert-mango-robotics`, on the Hobby plan to start.
Kyle creates the account himself (M1). The project `hippocampus-docs` is re-imported there from
`desert-mango/hippocampus-docs`; the domain `hippocampus-docs.vercel.app` moves over from the old
personal project; environment variables are set fresh in the new account (`OPENROUTER_API_KEY` =
Desert Mango's key, the Cloudinary key pair from M4, the GitHub App id and secret from M2). The
domain is removed from the old project's Domains and added to the new project only after the new
project shows a **Ready** production deploy of current `main` under the chosen E1 option (M1 step
8, R2-F2), so the public docs never go dark; the old project keeps the domain until then and is
deleted last, after Kyle's OK. Going forward `main` is authored as
Desert Mango (the repo-local `user.email` is the `desert-mango-robotics` noreply address), so
Kyle's agents' pushes satisfy Hobby's owner-only author rule on a private repository; today's HEAD
`a47a27a` is authored by the SimpleLogin alias `github.reoccupy179@slmails.com` and `b114a20` by
`kyle-nelson@berkeley.edu` (R1-F10), so the import's first deploy builds a non-owner-authored HEAD.
Nathalie's merges and the rebuild bot's commits are never the owner's (D5). Vercel's "no private
organization repositories on Hobby" rule applies to the private option [S1][S2]; the M1 tests are
the empirical word, and the plan holds under either E1 choice. Hobby is officially non-commercial
[S14]; a business account hosting a client, even for free, is a gray area — flagged in §8, not
solved here. Local note: the `vercel` CLI on Kyle's machine is logged in to the old account; U1's
live check needs `vercel login` as the new one.

**Unchanged:** zero-build serving, `js/marked.min.js` (sha256-pinned), the registries and dialect,
`api/librarian.js`, the fork-PR pipeline for outsiders, "done means merged", no branch protection.

**New files**

| Path | Purpose |
|---|---|
| `cms/index.html`, `css/cms.css` | The signed-in area shell (hash routes: `#/`, `#/edit/<page>`, `#/edit/data/<registry>`, `#/new/project`, `#/new/person`, `#/review`, `#/review/<n>`, `#/media`, `#/private`, `#/help`) |
| `cms/callback.html`, `js/cms-callback.js` | OAuth popup landing page: posts `{code, state}` to the opener and closes; the opener compares `state` and calls `/api/auth`, so the token never exists in the popup (R1-F12) |
| `js/cms-core.js` | Pure helpers: branch names, PR body, JSON validation with located messages, manifest entry builder, role mapping, page tree from registries, Git Data API tree builder, bridge protocol, annotation → message mapping |
| `js/cms.js` | The UI and the GitHub API calls |
| `js/source.js` | The content-source seam used by `app.js`, `search.js`, `graph.js`: same-origin fetch normally; the `postMessage` bridge when the page was loaded as `index.html#preview=<nonce>` |
| `js/sanitize.js` | Allowlist HTML sanitizer applied to every rendered Markdown page (live site and previews) |
| `api/auth.js` | GitHub App code→token exchange (needs `GH_APP_CLIENT_ID`, `GH_APP_CLIENT_SECRET`) |
| `api/media.js` | Cloudinary gateway: `sign`, `list`, `destroy`, `rename`, all scoped to `hippocampus-docs/` |
| `tools/derive.py` | One command that runs the derived-data builders in order (`build_wiki_graph.py`, `build_search_index.py --site-only`, `build_contributors.py` when its inputs changed) |
| `.github/workflows/derive.yml` | Post-merge regeneration and commit on `main` |
| `.vercelignore` | Keeps `__pycache__` out of the deployment |
| `docs/maintainer-protocols.md` | R4 |
| `docs/cms-v2-plan.md` | This plan, committed for the record |
| tests: `tools/tests/test_check_content_safety.py`, `test_sanitize.mjs`, `test_auth_handler.mjs`, `test_media_handler.mjs`, `test_cms_core.mjs`, `test_preview_bridge.mjs`, `test_derive.py` | |

**Changed files:** `vercel.json` (build command, `git.deploymentEnabled` for `cms/**`; the
headers in U4b after the handoff), `.github/workflows/check.yml` (regenerate step on pull
requests, annotation step), `tools/check.py`, `tools/build_wiki_graph.py` (located overlay
message), `tools/dev_site.mjs`, `js/app.js`, `js/search.js`, `js/graph.js`, `index.html` (one
script tag, one footer link), `tools/attribution_headers.json` (one `included` entry with a
baseline sha256 per new `.js`/`.mjs`/`.py` file — `tools/check_attribution_headers.py` runs inside
`check.py` and fails on any tracked code file that is missing from the inventory or lacks the
five-line header, R1-F15), `CLAUDE.md`, `CONTRIBUTING.md`, `README.md`, `.github/CODEOWNERS`,
`.github/pull_request_template.md`, `docs/cms-plan.md`.

**Data flows**

1. Edit (U7b): browser → Git Data API — `POST /git/blobs` per file, `POST /git/trees` with
   `main`'s tree as base, `POST /git/commits`, `POST /git/refs` for
   `refs/heads/cms/<login>/<slug>` — **one commit per proposal** however many files it touches
   (Contents: write covers all four [S33]; R1-F14) → `POST /pulls`. No red intermediate commit,
   one CI run, and no Vercel build, because `git.deploymentEnabled` is `false` for `cms/**` (U1).
2. Preview: parent (token) ↔ sandboxed `index.html` (no token) over `postMessage` with a per-load
   nonce; files come from `GET /contents/{path}?ref=<sha>` with the raw media type (≤100 MB
   [S52]) or from the draft; only `content/`, `data/` and `search/` paths are answered.
3. Review: `GET /pulls`, `GET /commits/{sha}/check-runs` (the `check` job's conclusion) and
   `GET /check-runs/{id}/annotations` (the located `✗` lines that `check.yml` re-emits as
   `::error` annotations — both need the editor App's Checks: read [S33][S90]; R1-F5),
   `POST /pulls/{n}/reviews` (`APPROVE` / `REQUEST_CHANGES`) [S47], `PUT /pulls/{n}/merge`
   (`squash`, with `sha`) [S46], `PUT /pulls/{n}/update-branch`.
4. Merge → `push` on `main` → `check.yml` (gate) and `derive.yml` (regenerate, commit as bot) →
   host builds with `python3 tools/check.py` → deploy.
5. Media: browser → `POST /api/media {action:"sign"}` (bearer = user token; function verifies
   `permissions.push` on the repo via GitHub) → browser → `api.cloudinary.com` upload → manifest
   entry `{source:null, …}` added to the draft.
6. Private (after the handoff): browser, with the viewer App's token → `GET /user/installations`
   → `/user/installations/{id}/repositories` → per repo `GET /pulls?state=open`,
   `GET /commits?per_page=10`.

---

## 4. Build units

Ordering inside the must-have tier: U1, U3, U2 in parallel; then U4 and U5 in parallel; then U7a;
then U8; then U11; then U12 on the must-have set. Next tier: U7b, then U6 and U9. After the
handoff: U10, U4b, Undo, the registry forms. Model tiers follow Kyle's role rules: Opus 5 for logic
and prose, Sonnet 5 only for the one clearly trivial unit (U1). Every unit ends with
`python3 tools/check.py` printing `check.py: all green`, and its own tests green, before commit;
every new `.js`/`.mjs`/`.py` file carries the five-line attribution header and an `included` entry
in `tools/attribution_headers.json` (§11).

### U1 — Gate before deploy (R7) — Sonnet 5 — MUST-HAVE

**Files:** `vercel.json`, `.vercelignore`.

**Change:** `"buildCommand": "python3 --version && PYTHONDONTWRITEBYTECODE=1 python3 -B tools/check.py"`,
keep `"outputDirectory": "."`. `.vercelignore` contains `__pycache__/` and `*.pyc`. The `-B` flag
and the env var say the same thing twice on purpose (inline env in a build command is "not
stated" in Vercel's docs [S8]; the flag needs no env). Also
`"git": {"deploymentEnabled": {"cms/**": false}}` — CMS proposal branches get no Vercel build,
because previews come from the bridge (D3) and every push would otherwise cost a build; the
pattern is minimatch and `*` does not cross `/`, hence `**` [S19] (R1-F14).

**Acceptance:**
- `vercel login` (as the new Desert Mango account, M1) then `vercel link` to the new project, then
  `vercel pull --yes --environment=production && vercel build` (local, no deploy) → log contains
  `Python 3.12` (the build image's default Python [S6][S7]) and `check.py: all green`;
  `find .vercel/output -name '__pycache__' -o -name '*.pyc' | wc -l` → `0`.
- After M1 decides the host: a branch with a deliberate trailing comma in `data/tools.json` →
  the host's build fails and its log shows the located message `data/tools.json:<line>:<col>: …`;
  production still serves the previous deploy. Fixing the comma → green build.
- `diff <(git ls-files) <(list of files served)` is not runnable on Vercel; the byte-identical
  claim is proven by the two lines above (nothing written, nothing built).
- After U7b exists: a push to a `cms/<login>/x` branch → `https://vercel.com/<new-team-slug>/hippocampus-docs/deployments`
  shows no deployment for it.

**Depends on:** M1 (with E1 decided) for the live half. **Not** on other units.

### U2 — Derived data without a terminal (R6) — Opus 5 — MUST-HAVE

**Files:** `tools/derive.py` (new), `tools/tests/test_derive.py` (new),
`tools/build_wiki_graph.py` (the located overlay message), `.github/workflows/check.yml`,
`.github/workflows/derive.yml` (new), `tools/attribution_headers.json` (entries for the two new
Python files).

**`tools/derive.py`:** stdlib only. Runs `build_wiki_graph.py`, then `build_search_index.py
--site-only`, then — only with `--contributors` or with `--contributors-if-changed <ref>` when
`data/projects.json`, `data/org-repos.json` or `data/people.json` differ from `<ref>` —
`build_contributors.py` (which needs `gh` and `GH_TOKEN`). Prints one line per builder and a
final `derive: <n> files changed` (listing them) or `derive: nothing to do`. Exit 1 if any
builder fails, loudly, naming it, passing the builder's own located message through unchanged.
Deterministic (the builders already are).

**The authored-overlay rule (R1-F4, scoped by R2-F4).** `build_wiki_graph.py` already fails by
name when an id-keyed overlay — an edge in `edges-authored.json` or an authored summary in
`summaries.json`, the only two — points at an id that no longer exists (the `xref-terms.json`
`rejected`/`stoplist` word lists are veto sets and cannot fail the build). Its message becomes
one located, human line in the gate's own style, at the root, not in a wrapper:
`data/graph/edges-authored.json: 'project:<old-id>' is not a page or repository id any more —
renaming or removing an existing id needs Desert Mango (docs/maintainer-protocols.md)`; same
shape for `summaries.json`. Exit 1, never a traceback. `check.py` says the
same thing on its own (U3), so a github.com pencil edit gets the line even when nothing
regenerates. The CMS never offers a rename or removal of an existing id (D8, U7b).

**`check.yml`:** keep the `check` job name and the gate step's command `python3 tools/check.py`
verbatim. Four changes around it:
1. *Before* the gate, **on `pull_request` only** (`if: github.event_name == 'pull_request'`), a
   step "Regenerate derived data in the workspace (not committed) so the gate judges what main
   will hold after derive.yml" running `python3 tools/derive.py 2>&1 | tee derive-output.txt`
   with `${PIPESTATUS[0]}` recorded but **never aborting the job** — the gate still runs and
   reports on its own. The wiki graph and the site shard only; `build_contributors.py` stays off
   the PR path (network-bound, a flaky red for lab members, and `contributors.json` is optional to
   the gate). On `push` to `main` there is no regenerate step: the gate judges the committed tree,
   so CI agrees with the deploy build and with the "verbatim" law (R1-F11).
2. The gate step's `tee` also writes a copy of the output to `gate-output.txt` (the command and
   its arguments are unchanged; only the tee target list grows).
3. *After* the gate, a separate step with `if: failure()` reads **whichever of**
   `derive-output.txt` (written on pull requests only) and `gate-output.txt` **exist** —
   `for f in derive-output.txt gate-output.txt; do [ -f "$f" ] || continue; …; done` — and never
   fails on a missing file; on `push` to `main` only `gate-output.txt` exists (R2-F6). It re-emits
   each failing line as a GitHub annotation (R1-F5): lines shaped
   `path:line:col: message` or `path:line: message` become
   `::error file=<path>,line=<line>,col=<col>,title=check.py::<message>`; lines shaped
   `path: message` become `::error file=<path>,title=check.py::<message>`; anything else becomes
   `::error title=check.py::<message>` [S91]. The Review tab reads them back through the Checks
   API (U8). The job summary keeps the full fenced output as today. GitHub caps the annotations it
   shows per step (the number is not stated on the commands page); the summary is the full record.
4. Also after the gate, if `git status --porcelain search/ data/graph/` is non-empty **and** the
   PR itself committed any of those paths, print `::notice::this PR carries derived files;
   derive.yml regenerates them after merge — no action needed`.
Delete the `search-shard-advisory` job. Runner stays `ubuntu-24.04` (system Python 3.12.3, `gh`
2.100.0 preinstalled [S39]). `actions/checkout` stays the only external action, SHA-pinned.

**`derive.yml`:** `on: push: branches: [main]`; `concurrency: derive-main`; job `derive` with
`permissions: contents: write`; `if: github.actor != 'github-actions[bot]'`. Steps: checkout
(`fetch-depth: 2`); `GH_TOKEN=${{ github.token }} python3 tools/derive.py
--contributors-if-changed ${{ github.event.before }}`; `python3 tools/check.py` (red → the job
fails and pushes nothing — root cause, never a skip); if `git status --porcelain search/
data/graph/` is non-empty: commit as `github-actions[bot]
<41898282+github-actions[bot]@users.noreply.github.com>` with message `derive: regenerate derived
data after <short sha>` and push; on a non-fast-forward rejection, `git pull --rebase`, re-run
derive and check, retry (max 3). Whether the host deploys this bot commit is M1 step 6's
question, not this unit's (D5).

**Acceptance (commands → expected):**
- `python3 tools/tests/test_derive.py` → `OK` (uses fixtures; covers ordering, the
  `--contributors-if-changed` path filter, the pass-through of a builder's located failure, the
  failure exit, and the "nothing to do" line).
- `python3 tools/tests/test_build_wiki_graph.py` → `OK` with a new case: an authored edge naming a
  missing id → exit 1 and exactly the located line above on stdout, no traceback.
- Local: `python3 tools/derive.py` on the untouched repo → `derive: nothing to do`;
  `git status --porcelain search/ data/graph/` → empty.
- Local mutation (the measured case from the brief): add a project entry + `content/projects/x.md`,
  run `python3 tools/check.py` → exit 1 with the 3 parity failures; run
  `python3 tools/derive.py --contributors` then `python3 tools/check.py` → `check.py: all green`.
- Local mutation (the overlay case): rename the id of a project that an authored edge or summary
  points at (in `data/projects.json` and its `content/projects/<id>.md`) →
  `python3 tools/derive.py` → exit 1 whose last line is the located overlay message naming the
  overlay file and "needs Desert Mango"; `python3 tools/check.py` on the same tree → exit 1 with
  the same message from U3's rule; no traceback in either.
- Live (workflow files push over SSH, M6 done): open a test PR that adds a project (no derived
  files in it) → `gh run list --workflow CI --branch <branch> --json conclusion` → `success`;
  the check summary shows `check.py: all green`. Open a test PR with a deliberate trailing comma
  in `data/tools.json` → the run is `failure` and `gh api repos/desert-mango/hippocampus-docs/check-runs/<id>/annotations`
  returns one annotation with `path: data/tools.json`, the right `start_line`, and the gate's
  message (R1-F5).
- Merge the project PR → the `check` run on the merge commit is red (stale parity — expected,
  the deploy build says the same) → within 3 minutes `git log origin/main -1 --format='%an %s'`
  → `github-actions[bot] derive: regenerate derived data after <sha>`; `gh run list --workflow
  derive --json conclusion` → `success`; then `python3 tools/derive.py` on a fresh checkout of
  `main` → `derive: nothing to do` and `python3 tools/check.py` → green.
- Merge a text-only PR whose heading changed → one bot commit touching only `search/`; a text-only
  PR touching no indexed field → no bot commit (`derive: nothing to do` in the log).
- First-run proof for D5: the push step succeeds with the repository default left at
  "Read repository contents and packages permissions". If it is refused with 403, apply M8 and
  record it in the unit's notes; do not weaken anything else.
- First-run proof for `build_contributors.py` under `GITHUB_TOKEN` (on `main` only): the log shows
  the contributors step completing against `HippoCampusRobotics` public repos. If GitHub refuses,
  the documented fallback is a fine-grained PAT of `desert-mango-robotics` with *no* repository
  permissions (public read only) stored as Actions secret `CONTRIB_TOKEN` — record which path was
  needed.

**Depends on:** nothing for the local half; M6 (done) to push workflow files; M9 for PR #1.

### U3 — Harden `tools/check.py` for the new inputs — Opus 5 — MUST-HAVE

**Files:** `tools/check.py`, `tools/tests/test_check_content_safety.py` (new),
`tools/attribution_headers.json` (entry for the new test file).

**Changes, all strengthening:**
1. New section 6d "content safety": in `content/**.md` (and every string value in `data/**.json`)
   reject `<script`, `<iframe`, `<object`, `<embed`, `<form`, `<meta`, `<link`, `<style`, `<base`,
   `<svg`, `srcdoc=`, any ` on[a-z]+=` attribute, and `javascript:`, `vbscript:`, `data:text/html`
   in `href`/`src`. Message style: `content/setup/x.md:12: inline script or event handler is not
   allowed in content (<script>) — use the dialect blocks in CONTRIBUTING.md`.
2. Section 6a: a manifest entry may carry `"source": null` (uploaded through the CMS). Then the
   local-file existence and drift checks are skipped, but `sha256` (64 hex), `url` on the cloud,
   `public_id` and `bytes` are still required, uniqueness still holds, and every `public_id` must
   start with `hippocampus-docs/` (new rule; today all 51 entries do).
3. Section 7 "shell": the same missing-file check runs over `cms/index.html` and
   `cms/callback.html`.
4. `READER_REQUIRED_KEYS` comment list gains `js/cms.js`, `js/cms-core.js`, `js/source.js`; the
   builder re-derives the reader list with the documented grep and adds a `keys`/`lists`/`each`
   entry for every new bare dereference (the four-part rule in `CLAUDE.md`).
5. Section 9 gains the authored-overlay rule (R1-F4, scoped by R2-F4): every id named by
   `edges-authored.json` or by an authored entry of `summaries.json` must be a current page or
   repository node — the `rejected` and `stoplist` lists of `xref-terms.json` hold words, not ids,
   and are not checked (a rule on them would go red on the untouched repo); the message is the
   same located line as U2's
   (`data/graph/edges-authored.json: 'project:<old-id>' is not a page or repository id any more —
   renaming or removing an existing id needs Desert Mango (docs/maintainer-protocols.md)`). Today
   this passes (the 2026-09-09 audit found the overlays consistent), so it changes nothing green.

**Acceptance:**
- `python3 tools/tests/test_check_content_safety.py` → `OK`.
- Mutations, each → exit 1 with the located message on stdout, no traceback:
  (a) `<script>alert(1)</script>` in `content/about.md`; (b) `<img src=x onerror=alert(1)>` in a
  setup page; (c) `[x](javascript:alert(1))`; (d) manifest entry with `"source": null` and no
  `sha256`; (e) manifest `public_id` `portfolio/x`; (f) a project id renamed while an authored
  edge still names the old id → the overlay line, and it appears **before** the parity noise so
  it is the first thing a reader sees.
- Manifest entry `{"source": null, "folder": "hippocampus-docs/setup", "public_id":
  "hippocampus-docs/setup/cms-test", "url": "https://res.cloudinary.com/dr76gues0/image/upload/v1/hippocampus-docs/setup/cms-test.jpg", "bytes": 1, "sha256": "<64 hex>"}`
  referenced from a page → `check.py: all green`; `python3 tools/check_urls.py` probes it
  (expected to fail until a real upload exists — that is the online twin doing its job).
- Untouched repo → `check.py: all green`.

**Depends on:** nothing.

### U4 — Site-side: sanitizer, content-source seam, preview bridge, "Edit this page" — Opus 5 — MUST-HAVE

(The CSP headers are split out as U4b, after the handoff — R1-F8.)

**Files:** `js/sanitize.js` (new), `js/source.js` (new), `js/app.js`, `js/search.js`,
`js/graph.js`, `index.html`, `tools/tests/test_sanitize.mjs` (new),
`tools/tests/test_preview_bridge.mjs` (new), `tools/attribution_headers.json` (entries for the
four new files).

**Sanitizer:** `HCSanitize.clean(html)` — DOMParser-based allowlist. Elements: p, br, hr, h1–h6,
ul, ol, li, blockquote, pre, code, em, strong, b, i, u, s, del, sup, sub, a, img, table, thead,
tbody, tr, th, td, div, span, details, summary, kbd, dl, dt, dd, figure, figcaption. Attributes:
`class` (only `adm`, `adm-*`, `tabs`, `tab`, `adm-title`, `page-body` and the classes `app.js`
emits), `id`, `href` (http, https, `#`, **and same-origin relative URLs: no scheme, not starting
with `/` or `//`, no `..` segment, resolving under `assets/`** — the seven download links in
`content/setup/lab-marker/design.md` are `assets/setup/*.stl`, `*.3mf` and `cutout.pdf`, R1-F7),
`src` (`https://res.cloudinary.com/` only), `alt`, `title`, `width`, `height`, `data-label`,
`colspan`, `rowspan`, `loading`, and **`align` on `th`/`td`** (marked emits it for aligned
columns). Everything else is dropped. `renderMarkdown` becomes `sanitize(marked.parse(md))`
before `enhance()`.

**Seam:** `js/source.js` defines `HC.fetchText(path)` / `HC.fetchJSON(path)`; `app.js`,
`search.js` and `graph.js` call it instead of `fetch(path)`. Outside a preview frame it is
`fetch`. When the page was loaded as `index.html#preview=<nonce>` it posts
`{type:"hc-fetch", nonce, id, path}` to `window.parent` and resolves on the matching
`{type:"hc-file", id, ok, status, text}`. The parent side (in `js/cms.js`, U7a) answers only when
`event.source === iframe.contentWindow`, the nonce equals the one it generated for this load, and
`path` matches `^(content/[A-Za-z0-9_./-]+\.md|data/[A-Za-z0-9_./-]+\.json|search/[A-Za-z0-9_.-]+\.json)$`
with no `..` segment; everything else is answered `{ok:false, status:403}` (R1-F13). The
librarian POST answers 405 in preview so the client latches off, as it already does on Pages.
`localStorage` access is already guarded; `sessionStorage` use (none today) must be too.

**"Edit this page":** one footer link per rendered page: `/cms/#/edit/<page-id>`; hidden in
preview mode; until U7b ships it lands on the CMS's "edit on github.com" pointer. Not a redesign.

**Acceptance:**
- `node --test tools/tests/test_sanitize.mjs` → `# fail 0`; cases: script tag dropped, `onerror`
  dropped, `javascript:` href dropped, foreign `img src` dropped, `//evil.example/x` and
  `../x` hrefs dropped, the seven relative `assets/setup/*` links from `design.md` kept verbatim,
  `<td align="center">` kept, dialect blocks kept intact (`<div class="adm adm-note"><p
  class="adm-title">…`, tabs), tables kept, headings kept.
- `node --test tools/tests/test_preview_bridge.mjs` → `# fail 0`: request/response ids, error
  status passthrough, nonce mismatch ignored, wrong `event.source` ignored, `js/app.js`,
  `api/librarian.js` and `content/../js/app.js` refused with 403, no token in any message.
- `node --test tools/tests/test_search_routing.mjs tools/tests/test_graph_ui.mjs` → still
  `# fail 0`.
- Browser pass (the builder, with the Browser pane against `node tools/dev_site.mjs`): the routes
  `#/`, `#/setup/<any>`, **`#/setup/lab-marker/design` (all seven download links present and
  pointing at `assets/setup/…`)**, `#/projects/<any>`, `#/tools/<any>`, `#/about`,
  `#/search?q=controller` render identically to before, in **Chrome, Safari and Firefox**.
- `python3 tools/check.py` → `check.py: all green` (new script files referenced by `index.html`
  exist; `marked` digest unchanged; attribution inventory complete).

**Depends on:** U3 (shell check covers new files).

### U4b — CSP and hardening headers — Opus 5 — AFTER THE HANDOFF

**Files:** `vercel.json` (headers), `tools/dev_site.mjs` (header passthrough so local runs match).

**Change:** `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'
'unsafe-inline'; img-src 'self' https://res.cloudinary.com https://avatars.githubusercontent.com
data:; connect-src 'self' https://api.github.com https://api.cloudinary.com; frame-src 'self';
frame-ancestors 'self'; base-uri 'self'; form-action 'self' https://github.com; object-src 'none'`
plus `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`, on
all paths. `index.html` has no inline scripts today (four `<script src>` tags); the builder must
remove any inline `on*=` handlers in generated HTML strings first (grep). Why after the handoff:
the sandbox and the sanitizer (U4) and the gate (U3) are the must-have layers; CSP is the fourth,
and `'self'` matching inside opaque-origin sandboxed documents has differed between browsers, so it
needs its own Safari and Firefox pass with the preview bridge on.

**Acceptance:**
- `grep -nE "on[a-z]+=\"" js/app.js js/search.js js/graph.js js/cms*.js js/source.js` → nothing.
- `curl -sI https://<host>/ | grep -i content-security-policy` → the header above.
- Browser pass of every U4 route plus `/cms/#/review/<n>` with a preview open, in Chrome, Safari
  and Firefox: zero CSP violations in the console; the preview still renders.
- `python3 tools/check.py` → `check.py: all green`.

**Depends on:** U4, U7a, U8.

### U5 — `api/auth.js` and the callback page — Opus 5 — MUST-HAVE

**Files:** `api/auth.js` (new), `cms/callback.html` (new), `js/cms-callback.js` (new),
`tools/dev_site.mjs` (route every `api/*.js`, load `.env.local`), `tools/tests/test_auth_handler.mjs`
(new), `tools/attribution_headers.json` (entries for the three new code files).

**Contract:** raw Node like `librarian.js` (no Vercel helpers). `POST /api/auth` with JSON
`{code, app}` (`app` ∈ {`editor`, `viewer`}; the viewer App arrives with U10) → server checks
`Origin` equals its own origin → `POST https://github.com/login/oauth/access_token` (`client_id`,
`client_secret`, `code`, `redirect_uri`, `Accept: application/json`) → `200 {token, expires_in}`;
errors → `400`/`502` with no secret in any message; never logs the code or token.

**The `state` round trip (R1-F12):** `js/cms.js` generates `state` with `crypto.getRandomValues`
and keeps it in the opener's memory. The callback page does one thing:
`window.opener.postMessage({type:"hc-code", code, state}, location.origin)` and closes — it never
touches storage and never calls the function. The opener accepts the message only from the popup
it opened (`event.source === popup`) and from its own origin, compares `state` with its own copy
(the CSRF guard), then calls `POST /api/auth` itself. The token never exists in the popup, and
nothing depends on whether the popup's storage survives the cross-origin round trip. The token
lives in the opener's `sessionStorage` only, with its expiry; "Sign out" clears it.

**Env (Vercel):** `GH_APP_CLIENT_ID`, `GH_APP_CLIENT_SECRET` (and, with U10,
`GH_VIEWER_CLIENT_ID`, `GH_VIEWER_CLIENT_SECRET`).

**Acceptance:**
- `node --test tools/tests/test_auth_handler.mjs` → `# fail 0`: happy path with a fake fetch;
  wrong `Origin` → 403; missing code → 400; unknown `app` → 400; GitHub 4xx → 502 with a generic
  message; the response body never contains the client secret; the request to GitHub carries it.
- `node --test tools/tests/test_cms_core.mjs` (U7a) covers the opener side: a message from another
  source or origin is ignored; a `state` mismatch never reaches `/api/auth`.
- Live, after M2 and M3: `node tools/dev_site.mjs` with `.env.local` holding the real App's id
  and secret → sign in from `http://localhost:8131/cms/` succeeds through the App's second callback
  URL; on the host, sign in at `https://hippocampus-docs.vercel.app/cms/` succeeds. **The sign-in
  is done with an outside-collaborator account** — `kyle-nelson-berkeley` holds Write and is not a
  `desert-mango` member, the real user shape (R2-F1) — and the role badge reads Editor. Until M2
  exists the builder tests with fakes only.
- `python3 tools/check.py` → `check.py: all green`.

**Depends on:** nothing for tests; M2 + M3 for the live flow.

### U6 — `api/media.js`, the Cloudinary gateway (R1) — Opus 5 — NEXT

**Files:** `api/media.js` (new), `tools/tests/test_media_handler.mjs` (new),
`tools/attribution_headers.json` (entries for both).

**Contract:** `POST /api/media` with `Authorization: Bearer <user token>` and JSON
`{action, …}`. Every call: `Origin` check; body ≤ 64 KB; verify the caller with
`GET https://api.github.com/repos/desert-mango/hippocampus-docs` using the bearer → require
`permissions.push === true` (cache 5 min keyed by `sha256(token)`); 60 calls/min per token.
Actions:
- `sign {subfolder, filename}` → `subfolder` ∈ {`setup`, `people`, `projects`, `tools`, `brand`};
  `filename` slugified to `[a-z0-9-]{1,80}`; returns `{cloud_name, api_key, timestamp, signature,
  params}` where `params` is exactly what was signed: fixed mode → `folder=hippocampus-docs/<sub>`,
  `public_id=<slug>`; dynamic mode → `asset_folder=hippocampus-docs/<sub>`,
  `public_id=hippocampus-docs/<sub>/<slug>`; both include `overwrite=false`. Signature: SHA-256
  over the sorted `name=value` pairs joined with `&` plus the secret [S54]; valid 1 hour [S54].
  Folder mode is read once from the Admin API `config?settings=true` [S58] and cached.
- `list {cursor?}` → Admin API `GET /resources/image/upload?prefix=hippocampus-docs/&max_results=500`
  [S60] (Basic auth) → `{assets:[{public_id, url, bytes, width, height, format, created_at}],
  next_cursor}`.
- `destroy {public_id}` and `rename {from, to}` → refuse unless every id starts with
  `hippocampus-docs/` **and** is absent from the live manifest (`GET https://<own host>/data/cloudinary-manifest.json`),
  then call the signed Upload API `destroy` / `rename` with `invalidate=true` [S62][S63].
- Secrets only from `process.env` (`CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`,
  `CLOUDINARY_API_SECRET`); never logged, never in a response except `api_key` (public by
  Cloudinary's own design for signed uploads [S55]).

**Acceptance:**
- `node --test tools/tests/test_media_handler.mjs` → `# fail 0`: signature matches a hand-computed
  vector; `subfolder: "../portfolio"`, `"portfolio"`, `"hippocampus-docs-evil"` → 400; caller
  with `permissions.push: false` → 403; `destroy` of a manifest-referenced id → 409 with
  `still referenced by the site`; `destroy` of `portfolio/x` → 403; dynamic vs fixed mode
  parameter sets; no secret in any response body.
- Live (after M3, M4): `curl -s -X POST https://<host>/api/media -H "Authorization: Bearer bad"
  -d '{"action":"list"}'` → `401`.
- `python3 tools/check.py` → `check.py: all green`.

**Depends on:** U3 (manifest schema); M3, M4 for the live check.

### U7a — The signed-in area shell: sign-in, role badge, routes (R5) — Opus 5 — MUST-HAVE

(U7 split per R1-F8's refinement: the shell is needed to reach U8; the editor is U7b.)

**Files:** `cms/index.html`, `css/cms.css`, `js/cms-core.js`, `js/cms.js`,
`tools/tests/test_cms_core.mjs`, `tools/attribution_headers.json` (entries for the three new
code files).

**Behaviour:**
- Sign in with GitHub (popup, U5; the opener-side `state` check lives here). Show login, role
  badge (D8: Admin / Maintainer / Editor / Read-only from `permissions`), "Sign out".
- Routes: `#/` (home: open proposals — all open PRs, mine first — recent merges, links to
  `docs/maintainer-protocols.md` and to the github.com pencil path), `#/review` and
  `#/review/<n>` (U8), `#/help`. The editor and media routes (`#/edit/…`, `#/new/…`, `#/media`)
  and `#/private` render one line — "not here yet: edit this page on github.com (link)" — until
  U7b, U9 and U10 ship.
- The preview host: the sandboxed `index.html#preview=<nonce>` frame and the parent side of the
  bridge (U4's rules: source, nonce, path allowlist, ref).
- `js/cms.js` talks to `desert-mango/hippocampus-docs` only — the repository name is a constant;
  no other repository the token could reach is ever read, listed or written (R2-F1). A signed-in
  account whose repository lookup answers 404 sees "you do not have access to this site's
  repository" and nothing else (D8).
- Nothing is written to the repository by this unit.

**Acceptance:**
- `node --test tools/tests/test_cms_core.mjs` → `# fail 0`: role mapping from `permissions`
  (`admin` → Admin, `maintain` → Maintainer, `push` → Editor, else Read-only); route parsing;
  PR list ordering; the opener-side `state` check (wrong source, wrong origin, mismatched `state`
  → no call).
- Browser pass (builder, `node tools/dev_site.mjs`, the real App after M2/M3, fakes before): sign
  in with the outside-collaborator account `kyle-nelson-berkeley` → the badge reads Editor; sign
  in as `desert-mango-robotics` → Admin (R2-F1) → `#/review` lists PR #1 → Sign out clears
  `sessionStorage`. In Chrome, Safari and Firefox (the bridge runs here — R1-F13).
- `python3 tools/check.py` → `check.py: all green`.

**Depends on:** U4, U5.

### U7b — The editor: drafts, snippets, live preview, Propose — Opus 5 — NEXT

**Files:** `js/cms-core.js`, `js/cms.js`, `css/cms.css`, tests extended.

**Behaviour:**
- Page tree from the registries, exactly like `site-mcp`'s `page_index`: setup pages, projects,
  tools, About; plus **raw-JSON** registry editors for `data/people.json`, `data/projects.json`,
  `data/tools.json`, `data/site.json` (guarded with `JSON.parse` located errors — the two rules
  that bite are caught before commit). Form-based registry editors come after the handoff.
- **Existing ids are read-only** (R1-F4): the editor shows `id` fields of existing entries as
  locked and refuses a draft that removes an entry or changes an id, with the message "renaming or
  removing an existing id needs Desert Mango — open an issue". New entries get a new id.
- Editor: textarea with snippet buttons (note box, warning, tabs, image from Media once U9 ships,
  internal link picker over the page tree); live preview pane = the sandboxed frame served the
  draft through the bridge (U4), deep-linked to the page being edited.
- "New project": form (`id`, `name`, `status`, `tagline`, repos) + story body → registry entry +
  `content/projects/<id>.md` in one draft. "New person": people entry (photo optional).
- Propose (R1-F14): **one commit per proposal** through the Git Data API — `POST /git/blobs` per
  changed file, `POST /git/trees` with `base_tree` = `main`'s tree, `POST /git/commits`,
  `POST /git/refs` for `refs/heads/cms/<login>/<slug>-<yymmdd>` — then `POST /pulls` (template
  body: summary, pages, "Made in the site editor", link to `/cms/#/review/<n>`), then route to
  Review. Adding to an open proposal of mine = one more commit on that branch the same way
  (`base_tree` = the branch head's tree, `PATCH /git/refs`). No red intermediate commit, one CI
  run per proposal, no Vercel build (U1's `cms/**` rule).
- Never writes `search/`, `data/graph/`, `js/`, `css/`, `tools/`, `api/`, `.github/`, `cms/`,
  `index.html`, `vercel.json`. Never pushes to `main`.

**Acceptance:**
- `node --test tools/tests/test_cms_core.mjs` → `# fail 0`: page tree equals the registries'
  page set (71 setup + 17 projects + 3 tools + 1 about with today's data); branch-name slugging;
  JSON validation messages carry line and column; new-project draft produces exactly two files
  with the registry keys `id,name,status,tagline,file,repos`; a draft that changes or drops an
  existing id is refused with the message above; the tree builder emits one tree with every
  changed path; forbidden paths rejected.
- Browser pass (builder, `node tools/dev_site.mjs`, a real token): sign in → open a setup page →
  change a heading → the preview frame shows it → Propose → `gh pr view <n> --json headRefName,
  commits,files` shows `cms/<login>/…`, **exactly one commit**, and only that file; a new-project
  proposal shows one commit with two files; `gh run list --branch cms/<login>/…` → one `check`
  run, `success`; the Vercel deployments page shows no build for the branch.
- `python3 tools/check.py` → `check.py: all green`.

**Depends on:** U7a, U4, U5.

### U8 — Review tab: preview, approve, merge (R2, R5) — Opus 5 — MUST-HAVE (Undo after the handoff)

**Files:** `js/cms.js`, `js/cms-core.js`, tests extended.

**Behaviour:**
- List open PRs (title, author, age, files count, a "machinery" badge when any file is under
  `js/ css/ tools/ api/ cms/ .github/ index.html vercel.json` — "needs a code review by Desert
  Mango"; a "derived files" badge for `search/ data/graph/`).
- One PR: status line from `GET /commits/{head.sha}/check-runs` (the `check` run's conclusion) →
  green ✓ "site rules pass", red ✗, or "still checking"; on red, the located messages come from
  `GET /check-runs/{id}/annotations` (`path`, `start_line`, `message` — the lines `check.yml`
  re-emitted, R1-F5) and are shown as "file, line, what to fix"; a link to the job summary for the
  full text. The files list with a text diff; the **rendered preview** (sandboxed frame at the PR
  head, opened on the first changed page; navigable); the Vercel bot comment link if one exists.
- Actions by role: **Approve** (`POST /reviews` `APPROVE`; GitHub refuses self-approval [S48], the
  UI says so), **Request changes** (with a comment), **Merge** (`PUT /merge`, `squash`, `sha` =
  head → 409 shows "changed since you looked, reload"), **Update from main**
  (`PUT /update-branch`; on a conflict the UI says "needs a human — ask Desert Mango"), **Close**.
- **Rollback (must-have path):** on a merged PR the tab shows one button, "Undo on GitHub", that
  opens the PR on github.com where GitHub's own **Revert** button creates a new pull request
  reverting the merge commit [S89]; that PR then comes back through this tab for approval and
  merge. Revert needs write permission [S89], which every lab role has.
- **Undo inside the tab (after the handoff):** builds the inverse of the merge commit on a branch
  `cms/<login>/undo-<n>` with the Git Data API and opens "Undo #n"; never touches `search/` or
  `data/graph/`. Not in the must-have set — GitHub's Revert already does the job.

**Acceptance:**
- `node --test tools/tests/test_cms_core.mjs` → `# fail 0`: badge classification; check-run →
  status mapping (success/failure/in-progress/none); annotation → "file, line, message" mapping
  including annotations without a line; the github.com Revert URL builder.
- Live rehearsal (U12) with a second GitHub account holding Write and Nathalie's role simulated
  by `desert-mango-robotics`: PR opened with the github.com pencil → the reviewer sees the
  preview → approve → merge → `gh pr view <n> --json merged` → `true`; "Undo on GitHub" →
  **Revert** → the revert PR appears in the tab → merge it → the page shows the old text.
- **Real red PR (R1-F5):** a PR with a deliberate trailing comma in `data/tools.json` → the tab
  shows red ✗ with `data/tools.json`, the line number and the gate's message, read from the
  annotations endpoint (not from the summary). Fixing it on the branch flips the tab to green ✓.
- **R5's real test:** after M9, PR #1 opens in Review with green ✓ and a rendered preview of the
  nine changed setup pages; Kyle judges it there; if he merges, `derive.yml` regenerates
  `search/` and the site shows the Raspberry Pi fixes.

**Depends on:** U7a, U2 (statuses and annotations meaningful), M2 (Checks: read), M9.

### U9 — Media tab (R1) — Opus 5 — NEXT

**Files:** `js/cms.js`, `js/cms-core.js`, tests extended.

**Behaviour:** list (thumbnails via `c_limit,w_240` delivery transformations — the gate matches
on public_id, so transformations are fine), upload (choose file → `crypto.subtle` sha256 →
duplicate check against the manifest → `sign` → direct upload → manifest entry `{source: null,
folder, public_id, url: secure_url, bytes, sha256}` added to the current draft → "Insert into
page" writes `![alt](url)`), rename and delete (only assets not in the live manifest; otherwise the
UI explains "remove it from the page first, merge, then delete"). Subfolder picker from the fixed
list. File-size hint: keep images under 5 MB (Cloudinary's Free limit is reported as 10 MB but
unverified).

**Acceptance:**
- `node --test tools/tests/test_cms_core.mjs` → `# fail 0` (manifest entry builder, duplicate
  detection by sha256, referenced-asset guard).
- Live: upload `assets/hippo.svg`'s PNG export to `setup/` → `python3 tools/check.py` on the draft
  branch → green; `python3 tools/check_urls.py` → the new URL answers 200; `gh pr view` shows the
  manifest and the page in the same PR.
- Deleting a referenced asset via `curl` directly → `409`.

**Depends on:** U6, U7b, U3.

### U10 — Private tab (R3) — Opus 5 — AFTER THE HANDOFF

**Files:** `js/cms.js`, `js/cms-core.js`, `api/auth.js` (the `viewer` app branch), tests extended.

**Behaviour:** its own "Sign in to view lab repositories" button authorizes the **viewer App**
(D7, M2b) — a second token, held beside the editor token. Then `GET /user/installations` → every
installation of the viewer App except `desert-mango` → repos via
`/user/installations/{id}/repositories` (skip `desert-mango/hippocampus-docs`) → per repo: name,
private/public badge, description, open PRs (title, author, age, link), last 10 commits (message,
author, date, link), "open on GitHub". Empty state: "No lab repositories are shared with you yet.
Ask Nathalie." Nothing is cached past the tab session; nothing is ever written; the viewer App
cannot write (Metadata, Contents: read, Pull requests: read).

**Acceptance:**
- `node --test tools/tests/test_cms_core.mjs` → `# fail 0` (installation filtering, self-repo
  exclusion, empty state, the two tokens kept apart).
- `git grep -n "HippoCampusRobotics/" -- cms js/cms*.js` → no private repository name anywhere;
  the only org string is the public org used by the contributors builder, unchanged.
- Live after M2b and M7: a member with access to one selected repo sees exactly that repo; a
  member without access sees the empty state; `desert-mango-robotics` sees whatever the lab
  granted it; `gh api /app --jq .permissions` on the viewer App shows no `write` value.

**Depends on:** U7a, U5; M2b + M7 for the live check.

### U11 — Docs and protocols (R4) — Opus 5 (prose) — MUST-HAVE, written for the day-one path

**Files:** `docs/maintainer-protocols.md` (new), `docs/cms-v2-plan.md` (this plan, committed),
`CONTRIBUTING.md`, `README.md`, `CLAUDE.md`, `.github/CODEOWNERS`,
`.github/pull_request_template.md`, `docs/cms-plan.md`. Details in §7.

**The day-one path the protocols describe (R1-F8):** edit with the github.com pencil (the
existing `CONTRIBUTING.md` path, now on a branch in the repo instead of a fork), then open
`/cms/#/review`, read the green ✓ / red ✗ line, look at the rendered preview, **Approve**,
**Merge**; roll back with "Undo on GitHub" → **Revert** → approve → merge; a red ✗ is shown as
"file, line, what to fix" and the three common ones are named (the JSON comma, the missing key,
the "renaming or removing an existing id needs Desert Mango" line); the "derive" commit is the
robot tidying the search index after a merge; a "machinery" badge means "do not merge — ask Desert
Mango"; a page-adding merge shows the old site for one to three minutes until the robot's commit
deploys (M1 step 6 proved that the robot's commit deploys under the chosen option). When U7b and U9 ship, the editor and media sections are added; the protocol's structure
does not change.

**Acceptance:**
- Cold-agent test as in cms-plan Phase A: an agent given `docs/maintainer-protocols.md` alone
  answers, with a verbatim quoted line each: how to approve a proposal; what a red ✗ means and
  the three most common messages; how to roll a change back (must name **Revert**); how to add a
  member and which role; how to add a picture (today: ask Desert Mango, until U9); what a "derive"
  commit is; whom to call for a "machinery" badge; what to do when a rename is refused.
- `CLAUDE.md`'s edit map is a superset; every row in `README.md` and `CONTRIBUTING.md` matches a
  canonical row exactly (`diff` of the extracted tables → empty).
- `python3 tools/check.py` → `check.py: all green`; `python3 tools/build_search_index.py
  --site-only` → `git status --porcelain search/` empty (docs are not indexed).

**Depends on:** the must-have units (written last in that tier; the R7 amendment may ship with U1).

### U12 — Integration rehearsal — Opus 5 (orchestrated) — once per tier

**Must-have tier**, on the live host after M1 (with E1 decided), M2, M3, M5, M9: (0) an
outside-collaborator account (`kyle-nelson-berkeley`) signs in at `/cms/` and sees the Editor
badge (R2-F1); (1) PR #1
reviewed and judged by Kyle in the CMS (R5); (2) a pencil-made PR from a Write account that adds a
project → green without derived files → approved and merged by the Admin role in the Review tab
→ bot commit → deploy green, or the documented E1 outcome (R2, R6, R7); (3) a deliberate red PR
shows file, line and message in the tab, then flips green; (4) a Revert round trip; (5) the
protocols followed by a person who has not read the code (R4).
**Next tier:** a proposal made in the editor with one commit; a media upload inserted into a page
(R1). **After the handoff:** the Private tab with one granted and one non-granted member (R3);
Undo in the tab; CSP on in three browsers.
Each step's evidence: the `gh` commands from the units above, plus the host's deploy log lines.
Any failure is fixed at its root; no step is skipped.

---

## 5. Security model

**Where every credential lives (and nowhere else)**

| Credential | Lives in | Reaches the browser? | Reaches the repo? |
|---|---|---|---|
| Editor App client secret | Vercel env `GH_APP_CLIENT_SECRET` (the new Desert Mango account) | never | never |
| Editor App client id | Vercel env + the CMS page (public by design) | yes | as a public id only |
| Viewer App client secret / id (after the handoff, U10) | Vercel env `GH_VIEWER_CLIENT_SECRET` / `GH_VIEWER_CLIENT_ID` | secret never; id yes | id only |
| GitHub App private keys (both Apps) | **none generated.** The App owner (`desert-mango`) could generate one at any time and mint installation tokens with no user involved — a standing capability, not a guarantee (R1-F6). What bounds it: each App's permission set (the viewer App is read-only) and each installing account's own repository selection — we install the editor App only on this repo; both Apps are public, so another account could install one on its own repositories, which is that account's choice and relevant only if a key were ever made (R2-F1). | — | — |
| User access token (8 h) | the signed-in user's `sessionStorage` | yes (it is theirs) | never |
| `GITHUB_TOKEN` | the Actions run, `contents: write` only in `derive.yml` | never | never |
| Cloudinary API secret | Vercel env `CLOUDINARY_API_SECRET` (a key pair made for this site) | never | never |
| Cloudinary API key | Vercel env; returned with signed upload params | yes (public by Cloudinary's design [S55]) | never |
| `OPENROUTER_API_KEY` | Vercel env in the new account (Desert Mango's key, set fresh) | never | never |
| Vercel account token | nowhere (no CLI deploys); the CLI login on Kyle's machine is his own | — | — |
| SSH key `~/.ssh/id_ed25519_desert_mango_github` (comment and GitHub title `desert-mango-m4-macbookpro`; its own passphrase in Keychain) | Kyle's machine; registered on the `desert-mango-robotics` account (M6 done) | — | — |

The gate's hygiene section (6b) keeps literal secrets out of `content/` and `data/`; placeholders
look like `<yours>`.

**Threat: GitHub token scope.** A GitHub App user token reaches only repositories where the App
is installed and the user has access [S28]. The editor App is public ("Any account"), because a
private App can be authorized only by members of the owning organization and the lab are outside
collaborators [S92]; we install it on the docs repo alone. Being public, anyone could install it
on their own repositories — their choice, and it matters only if a private key were ever
generated (none is); a user token still reaches only repositories where both the App is installed
and the user has access, and `js/cms.js` ignores every repository except
`desert-mango/hippocampus-docs` (R2-F1). The viewer App (after the handoff) is installed by the
lab org on the lab repos it selected, read-only. An OAuth
`repo`-scope token would have reached every private repo the user can see [S31]; rejected. Each
token is in `sessionStorage` (gone when the tab closes), expires in 8 hours [S29], and is sent
only to `api.github.com` and (the editor token) to our own `/api/media` as the caller's identity
proof; the function forwards it to GitHub once, caches a hash, never logs it. The editor App asks
for Contents and Pull requests (read and write), Checks (read), Commit statuses (read) and
Metadata — no Administration, no Workflows [S33]; so a token cannot change collaborators, settings
or `.github/workflows` files through the App. The `state` check runs in the opener, so a forged
popup message cannot start an exchange (U5).

**Threat: the Cloudinary secret.** Only `api/media.js` holds it. The function signs uploads with
server-chosen folder and public_id; a signed parameter cannot be altered client-side [S54]. Delete
and rename require the id to start with `hippocampus-docs/` and to be absent from the live
manifest; the Admin API is never exposed. The site's own key pair can be revoked in one click
[S66] without touching the portfolio. Kyle's account remains the single tenant; the plan does
not claim a folder-level key restriction (unproven [S67]).

**Threat: private-repo content leaking into a public repo, page or the search index.**
Nothing about a private repository is written anywhere: the Private tab is read-only and
session-only, and its App cannot write; the tracked set lives in the viewer App's installation on
the lab org (D7); `derive.py`
builds `search/` and `data/graph/` from `data/org-repos.json` (the public org snapshot) and
public `contributors` endpoints; `check.py` section 9 already rejects a `repos-index.json` row that
is not in the public snapshot, and 6b rejects e-mail addresses. The CMS never commits from the
Private tab. `git grep` for org-qualified names is part of U10's acceptance.

**Threat: a PR-head workflow redefining the gate that judges it.** Facts: `pull_request` runs
the workflow from the PR head; lab members hold Write, so they can push such a branch (they can
also push `main` directly — Kyle's no-blocking rule accepts that). Fork PRs get a read-only
token and no secrets [S38]. Mitigations, layered: (1) the only secret any workflow can reach is
`GITHUB_TOKEN`; `derive.yml` runs only on `push` to `main`, so a branch cannot obtain its write
token, and the regenerate and annotation steps on pull requests hold only the read token;
(2) R7 makes the **deploy** re-run the real `tools/check.py` from the merged tree, so a
neutered CI check alone cannot put a bad change live — unless the PR also edits `tools/check.py`,
which is why (3) the Review tab flags any diff under `.github/ tools/ api/ js/ cms/ vercel.json
index.html` with a "machinery — code review by Desert Mango" badge, and the protocol says such
proposals are not merged by the lab; (4) `CODEOWNERS` keeps the ownership signal (inert while the
repo is private on the Free plan [S26], live if it goes public); (5) `pull_request_target` is
never used [S51]. Nothing here blocks a merge; it makes the risk visible, which is Kyle's chosen
posture.

**Threat: script injection through CMS preview or content.** Four layers, three of them in the
must-have tier. (1) Previews render in a sandboxed iframe without `allow-same-origin`: an
injected script runs in an opaque origin with no access to the parent's `sessionStorage`, the
token or the API; the bridge answers only the current nonce, only the iframe's own window, only
`content/`, `data/` and `search/` paths at the previewed ref (R1-F13). (2) `js/sanitize.js`
allowlists what the Markdown renderer may output, on the live site and in previews (relative
`assets/` links and `align` kept, R1-F7). (3) `check.py` 6d rejects scripts, handlers and
`javascript:` URLs before merge. (4) CSP `script-src 'self'` — no inline scripts anywhere, no
third-party scripts, `object-src 'none'` — ships after the handoff (U4b) once the three-browser
pass with the bridge is done. Cross-origin requests to the functions are refused (`Origin` check,
like the librarian). The opener compares `state` before it will exchange a code (U5).

**Also:** rate limits on both functions; body caps; no Vercel-injected helpers (the raw-Node
pattern); `noindex` stays; the CMS page is public HTML that does nothing without a token. Any
GitHub account can authorize the public App; while the repo is private, a non-collaborator stops
at the 404 from the repository lookup; if E1-C makes it public, they get the read-only state —
every write path checks `permissions.push` (D8, R2-F1).

---

## 6. Kyle's manual steps (exact clicks)

Do them in the tier order below. Each line: URL, then the button or field label. The
September-2026 UI wording is used; if a label moved, keep the intent. M6 is already done.

**Manual steps by tier (R2-F5).**
- Must-have, in this order: **M1** (account, import, the three tests, E1 decided, then the gated
  domain move) → **M2** (editor App; after M1's domain move) → **M3** (the GitHub App variables
  only) → **M5** (Nathalie's role; under E1-A also her Vercel seat) → **M9** (PR #1; after U2 is
  merged, so the regenerate-on-PR step exists). **M8** only if U2's first push is refused.
- Next: **M4**, plus the Cloudinary part of **M3**.
- After the handoff: **M2b**, **M7**, **M10**.
- Done: **M6**.

**M1 — New Desert Mango Vercel account, import, deploy-path tests, E1, then the domain move.**
Kyle started this from chat instructions on 2026-09-21, in the order below (N2). Kyle does the
account creation himself (accounts are never created by an agent). Nothing is deleted without his
OK. The three tests (steps 4–6) are the empirical word on E1; each records the commit author
before reading Vercel, because a test that passes for the wrong author proves nothing (R1-F3).
The domain moves last of all, only onto a project that has already deployed (R2-F2); the public
docs keep running on the old project until then.
1. Create the account: in a private browser window, `https://vercel.com/signup` → **Continue with
   GitHub** → authorize as `desert-mango-robotics` → **Hobby** → team name `Desert Mango`. The
   team's GitHub login connection must be `desert-mango-robotics`
   (`https://vercel.com/account/login-connections`).
2. **Add New…** → **Project** → if `desert-mango` is not listed, **Adjust GitHub App
   Permissions** → install the Vercel GitHub App on the `desert-mango` organization → **Only
   select repositories** → `hippocampus-docs` → **Install**. If the Vercel app is already installed on
   `desert-mango`, this screen edits that one installation: add `hippocampus-docs` to the existing
   selection and do not unselect anything.
3. Import: **Import** next to `desert-mango/hippocampus-docs` → **Project Name**
   `hippocampus-docs` → **Framework Preset** `Other` → leave Build and Output to the repo's
   `vercel.json` → **Environment Variables**: `OPENROUTER_API_KEY` (Desert Mango's key) →
   **Deploy**. This first deploy is the private-org-repo test, with one caveat:
   - Vercel refuses the import, or the deployment is **Blocked** with a Hobby/organization
     message → the private+Hobby path is closed, as the docs say [S1]; E1 (A or C) is decided now.
   - It reaches **Ready** → HEAD `a47a27a` is authored by the SimpleLogin alias, not the owner
     (R1-F10), so a Ready here already contradicts the docs' author rule; record it and run steps
     4–6 before concluding anything.
   The generated name is suffixed (`hippocampus-docs-<hash>.vercel.app`) until step 8.
4. Owner test: push one trivial commit to `main` authored as Desert Mango (any agent: a one-word
   `README.md` change; `git log -1 --format='%an <%ae>'` must show
   `323077863+desert-mango-robotics@users.noreply.github.com` before the push) →
   `https://vercel.com/<new-team-slug>/hippocampus-docs/deployments` → the newest row must be
   **Ready**. (On the old account `b114a20`, authored by `kyle-nelson@berkeley.edu`, was
   **Blocked** on 2026-09-11 — so this is not a formality.)
5. Non-owner test — the one that decides R2 (R1-F3): an account with Write that is not
   `desert-mango-robotics` (`kyle-nelson-berkeley`, which already holds Write, or a lab member)
   **creates the branch, authors the commit and opens the PR on github.com** (pencil on
   `README.md`), then merges it with **Squash and merge** — the CMS's method. Before reading
   Vercel: `git fetch origin && git log -1 --format='%an <%ae>' origin/main`; if the author is
   `desert-mango-robotics`, the test is void — redo it. Then the deployments page must show
   **Ready** for that merge commit. **Blocked**, or no deployment at all → the non-owner path is
   closed on this option.
   **Under E1-A (Pro) the rule is team membership, so the tester must be on the Vercel team
   (R2-F3):** (a) the tester signs up to Vercel with **Continue with GitHub** on their own GitHub
   account; (b) Kyle invites them at `https://vercel.com/<new-team-slug>/~/settings/members` →
   **Invite** (the button may read **Add Member**) → their GitHub username or e-mail → role
   **Viewer** → send; they accept; run the test; (c) only if it is **Blocked**, change their role
   to **Member** on the same page and run the test again with a fresh PR. Record which role gave
   **Ready** — that is the $20-versus-$40 answer (E1-A, §8). If Vercel offers a Pro trial at
   upgrade time (not verified, §10), run A's tests inside it, before paying.
6. Bot test — decides whether R6's follow-up commits deploy (R1-F2): trigger `derive.yml` once it
   exists (merge a PR that changes a page heading, so the search shard changes) and wait for the
   `github-actions[bot]` commit on `main`; the deployments page must show **Ready** for it. Before
   U2 exists, run the same test with a throwaway workflow that pushes one commit with the Actions
   token (`git -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' commit --allow-empty -m 'bot deploy test'`
   and push; `permissions: contents: write`), and remove that workflow afterwards.
7. Record the results of steps 3–6 in `docs/cms-v2-plan.md` §9. Steps 5 and 6 run under
   whichever E1 option Kyle picks (after making the repo public for C, or after upgrading for A);
   the option is confirmed only when both show **Ready**. **If either fails under A, return to Kyle with the evidence; C runs only after its history audit and
   his e-mail decision (E1-C(1)), and Pro is cancelled or downgraded (or the trial ended) before C's
   tests; if C fails too, B** (R2-F3, R3-F3). Nothing moves on until one
   option has both tests **Ready**.
8. Domain move — **only now**, once the new project's Deployments page shows a **Ready**
   production deploy of current `main` under the confirmed option (R2-F2); until then the old
   project keeps `hippocampus-docs.vercel.app` (M2 does not wait; see below). An agent may do this; it asks Kyle
   before any delete (R1-F9). Old account
   `https://vercel.com/kyle-nelson-berkeleys-projects/hippocampus-docs/settings/domains` → next to
   `hippocampus-docs.vercel.app` click **Edit** → **Remove** → confirm. New account
   `https://vercel.com/<new-team-slug>/hippocampus-docs/settings/domains` → **Add** →
   `hippocampus-docs.vercel.app` → **Add**; open the URL and confirm the site renders.
   **Rollback:** if the new project fails after the move, put the domain back on the old project
   (its Domains page → **Add** → `hippocampus-docs.vercel.app` → **Add**); it still exists because
   it is deleted last. M2 does NOT wait for this step (R3-F2): the final domain is already known.
9. Old project, last, with Kyle's OK: `https://vercel.com/kyle-nelson-berkeleys-projects/hippocampus-docs/settings`
   → **Delete Project** → type the name → **Delete**. Kyle's other projects there are untouched.

**M2 — Create the editor GitHub App (for U5, U8). Right after M1 step 3; only the live sign-in checks on `https://hippocampus-docs.vercel.app/cms/` (U5 live, U12) wait for M1 step 8.**
1. `https://github.com/organizations/desert-mango/settings/apps/new` (signed in as
   `desert-mango-robotics`).
2. **GitHub App name**: `HippoCampus Docs Editor`. **Homepage URL**:
   `https://hippocampus-docs.vercel.app`. **Callback URL**:
   `https://hippocampus-docs.vercel.app/cms/callback.html`; click **Add Callback URL** and add
   `http://localhost:8131/cms/callback.html` (local testing).
3. Leave **Expire user authorization tokens** checked. Leave **Request user authorization (OAuth)
   during installation** unchecked. Leave **Enable Device Flow** unchecked.
4. Under **Webhook**, uncheck **Active**.
5. **Permissions** → **Repository permissions**: **Contents** → *Read and write*; **Pull requests**
   → *Read and write*; **Checks** → *Read-only* (the Review tab reads check runs and their
   annotations, R1-F5); **Commit statuses** → *Read-only* (Vercel's deploy status after a merge);
   **Metadata** stays *Read-only*. Nothing else — no Administration, no Workflows.
6. **Where can this GitHub App be installed?** → **Any account** (a public App). Required, not
   optional: a private App can be authorized only by members of the owning organization [S92],
   and Nathalie and the lab members are outside collaborators of `desert-mango` — with "Only on
   this account" nobody but `desert-mango-robotics` could sign in (R2-F1). We still install it on
   the docs repo alone (step 9); other accounts could install it on their own repositories, which
   changes nothing for us (§5).
7. Click **Create GitHub App**.
8. On the app page: copy **Client ID**. Click **Generate a new client secret** → copy it now (it is
   shown once) → it goes into M3. Do **not** click **Generate a private key** (not needed; §5 says
   what generating one would allow).
9. Left sidebar **Install App** → next to **desert-mango** click **Install** → **Only select
   repositories** → `hippocampus-docs` → **Install**.

**M2b — Create the viewer GitHub App (for U10) — after the handoff.**
Same page as M2 step 1. **GitHub App name** `HippoCampus Docs Viewer`; **Callback URL**
`https://hippocampus-docs.vercel.app/cms/callback.html` (plus the localhost one); **Expire user
authorization tokens** checked; Webhook **Active** unchecked; **Repository permissions**:
**Contents** → *Read-only*, **Pull requests** → *Read-only*, **Metadata** *Read-only*, nothing
else; **Where can this GitHub App be installed?** → **Any account** (the lab org installs it);
**Create GitHub App** → copy **Client ID** → **Generate a new client secret** → both into the
Vercel env as `GH_VIEWER_CLIENT_ID` / `GH_VIEWER_CLIENT_SECRET` (M3). Never generate a private
key. Do not install it on `desert-mango`. If the lab prefers to own it, the same steps run at
`https://github.com/organizations/HippoCampusRobotics/settings/apps/new` by one of its owners.

**M3 — Vercel environment variables in the NEW account.** Two visits (R2-F5).
`https://vercel.com/<new-team-slug>/hippocampus-docs/settings/environment-variables`
→ for each row fill **Key** and **Value**, tick **Production** and **Preview**, click **Save**.
- Must-have (for U5, U7a, U8), right after M2: `OPENROUTER_API_KEY` (Desert Mango's key, if not
  already added at import), `GH_APP_CLIENT_ID`, `GH_APP_CLIENT_SECRET`.
- Next tier (for U6, U9), together with M4: `CLOUDINARY_CLOUD_NAME` (= `dr76gues0`),
  `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`.
- After the handoff (for U10), with M2b: `GH_VIEWER_CLIENT_ID`, `GH_VIEWER_CLIENT_SECRET`.
Nothing is copied from the old account. After each visit: **Deployments** → newest → **⋯** →
**Redeploy** so the functions see the new values.

**M4 — A Cloudinary key pair for this site.**
1. `https://console.cloudinary.com/settings/api-keys` → **Generate New API Key** → name it
   `hippocampus-docs` → copy **API Key** and **API Secret** into M3.
2. `https://console.cloudinary.com/` → note whether the dashboard says **Fixed** or **Dynamic**
   folder mode (the function detects it too; this is a cross-check for the builder).

**M5 — Nathalie gets Admin on this repo only.**
1. `https://github.com/organizations/desert-mango/settings/member_privileges` → under
   **Repository outside collaborators** make sure **Allow repository administrators to invite
   outside collaborators to repositories for this organization** is checked → **Save**.
2. `https://github.com/desert-mango/hippocampus-docs/settings/access` → **Add people** → type
   `NBauschmann` → select her → **Choose a role** → **Admin** → **Add NBauschmann to this
   repository**.
3. Only if **Admin** is not offered for an outside collaborator (not stated in GitHub's docs, §10)
   is the fallback org membership — and an org member gets the org's **base permission** on every
   `desert-mango` repository, which is **Read** today (`default_repository_permission: read`, read
   from the API on 2026-09-21; R1-F16). So first:
   `https://github.com/organizations/desert-mango/settings/member_privileges` → **Base
   permissions** → **No permission** → **Save**; confirm with
   `GH_TOKEN=$(gh auth token --user desert-mango-robotics) gh api orgs/desert-mango --jq .default_repository_permission`
   → `none`. Only then `https://github.com/orgs/desert-mango/people` → **Invite member** →
   `NBauschmann` → role **Member** (never Owner) → **Send invitation**; after she accepts, repeat
   step 2.
4. Under E1-A only (R2-F3): Nathalie needs a Vercel account linked to her GitHub and a seat on the
   team, because on Pro the commit author must be a team member [S1]. She signs up at
   `https://vercel.com/signup` → **Continue with GitHub** (`NBauschmann`); Kyle invites her at
   `https://vercel.com/<new-team-slug>/~/settings/members` → **Invite** → `NBauschmann` → the
   role M1 step 5 proved (**Viewer** if a Viewer's merge deployed, otherwise **Member**) → send;
   she accepts. Under C nothing on Vercel is needed for her.

**M6 — SSH key so workflow files can be pushed — DONE 2026-09-21 (R1-F17).** The key is
`~/.ssh/id_ed25519_desert_mango_github` (comment and GitHub title `desert-mango-m4-macbookpro`,
its own passphrase, held in Keychain), registered on the `desert-mango-robotics` account;
`~/.ssh/config` maps `Host github-desert-mango` to it with `IdentitiesOnly yes`. Verified today:
`ssh -T git@github-desert-mango` → `Hi desert-mango-robotics! You've successfully
authenticated`, and both repositories fetch over SSH. Kyle's naming rule, so the next key is never
confused with the personal `id_ed25519_github` / `kyle-m4-macbookpro`: the file name starts with
the account and ends with the service; the comment is `account-machine-macbookpro`.

**M7 — The lab org installs the viewer App on the repos to track (R3) — after the handoff.**
Needs an owner of `HippoCampusRobotics` (Nathalie is a public member; whether she is an owner is
not known — §10). `https://github.com/apps/hippocampus-docs-viewer/installations/new` → choose
**HippoCampusRobotics** → **Only select repositories** → pick the repositories to track →
**Install**. The install screen shows the App asks for read-only access; that is the whole ask.
Later changes: `https://github.com/organizations/HippoCampusRobotics/settings/installations` →
**Configure** next to the app → change **Repository access** → **Save**. Per-person visibility is
each repository's own collaborator list.

**M8 — Fallback only, if U2's first push is refused.**
`https://github.com/desert-mango/hippocampus-docs/settings/actions` → **Workflow permissions** →
**Read and write permissions** → **Save**. Leave **Allow GitHub Actions to create and approve pull
requests** unchecked.

**M9 — Unblock PR #1 (the R5 test).** Run after U2 is merged: once the search files are dropped
from the branch, PR #1's green depends on the regenerate-on-PR step that U2 adds to `check.yml`
(R2-F5). In a terminal, or by an agent:
```
git fetch origin && git checkout proposal/hippo-01-parity-docs
git checkout origin/main -- search/manifest.json search/site.json
git commit -m "proposal: drop derived files (derive.yml regenerates them after merge)"
git push origin proposal/hippo-01-parity-docs
```
Then `gh pr view 1 --json mergeable` → `MERGEABLE`. Judge it in `/cms/#/review/1`.

**M10 — Optional tidy-ups (new account).** `https://vercel.com/<new-team-slug>/hippocampus-docs/settings/git`
→ **Pull Request Comments** → off (the links would be protected previews the lab cannot open;
Vercel says this setting now lives in the dashboard [S19]). Deployment Protection stays as is.
On Kyle's machine: `vercel logout && vercel login` as the new account when U1's live check runs,
then `vercel login` back to the personal account afterwards (the CLI holds one login at a time).

---

## 7. Docs to change

`CLAUDE.md` is canonical; the others are reconciled to it, never the other way round.

**`CLAUDE.md`** (each item names whether it is the approved R7 amendment or a description that
follows from R1–R6):
1. *(R7 amendment)* Top line "There is NO build step" → "There is no build step that produces
   files: the deploy runs `python3 tools/check.py` as its build command (`vercel.json`
   `buildCommand`) and serves the repository as-is; a red gate never goes live." Same in "The one
   law".
2. *(follows R6; wording fixed per R1-F4)* Edit map: add two rows. "Derived outputs —
   `search/site.json`, `search/manifest.json`, `data/graph/wiki.json`,
   `data/graph/contributors.json`, the `"source": "derived"` entries of `summaries.json` and the
   `terms` of `xref-terms.json` — regenerated by `tools/derive.py`; never committed in a pull
   request; `derive.yml` commits them on `main`." And "Authored graph overlays —
   `data/graph/edges-authored.json`, the `"source": "authored"` entries of `summaries.json`, the
   `rejected` and `stoplist` lists of `xref-terms.json` — hand-kept inputs the builders preserve.
   The edges and the authored summaries key on registry ids, and the builders fail by name when
   an id they point at disappears, so renaming or removing an existing id is a Desert Mango
   change; the `rejected` and `stoplist` lists are word lists a rename cannot break (R2-F4)." No
   "never hand-edited" line.
3. *(follows R1–R5)* Edit map: add "The site editor — `cms/`, `js/cms*.js`, `js/source.js`,
   `js/sanitize.js`, `api/auth.js`, `api/media.js` — code, not content; the protocols are
   `docs/maintainer-protocols.md`." Add the manifest note: entries with `"source": null` are
   CMS uploads (sha256 of the uploaded bytes).
4. *(follows R2, R6)* Contribution pipeline: `check.yml` keeps the verbatim gate command and
   gains the uncommitted regenerate step on pull requests only and the annotation step after the
   gate; `search-shard-advisory` is retired; `derive.yml` is the second workflow; lab members are
   Write collaborators on branches in the repo, Nathalie (Admin) and named Maintainers merge; the
   CMS opens pull requests only, one commit per proposal; "treat any `.github/`, `tools/`,
   `api/`, `js/`, `cms/`, `vercel.json` diff as code review". The ONE CI-side external input stays
   `actions/checkout`. New code files carry the attribution header and an inventory entry (the
   existing `check_attribution_headers.py` rule, now stated in the law file).
5. *(fact fix)* "Every push deploys the site (Vercel + Pages)" → "(Vercel)": GitHub Pages is not
   enabled on `desert-mango/hippocampus-docs` (`has_pages: false`) and is public-repo-only on the
   Free plan [S26].
6. *(follows R1)* Hard rules: add "No third-party script from any CDN — not the Cloudinary
   widget, not a CMS bundle. A browser library is vendored as one file and sha256-pinned."
7. *(follows the READER rule)* the reader list gains `js/cms.js`, `js/cms-core.js`, `js/source.js`.
8. *(credentials)* a four-line table of which env var lives where (Vercel env only).
Items 2–8 describe approved requirements; if the reviewer reads any of them as a new law, it is
Kyle's call (E2).

**`CONTRIBUTING.md`:** in the must-have tier the first path stays the github.com pencil (now on a
branch in the repo for lab members, on a fork for outsiders) and gains "then open `/cms/#/review`
to see it rendered and get it approved and merged"; remove "Approve and run" from the lab path
(kept for forks); the edit map rows copied verbatim from `CLAUDE.md`; "Do not touch" adds `cms/`;
"never commit `search/` or `data/graph/`"; "renaming or removing an existing id is a Desert Mango
change"; "what the robot commit is"; rollback = the PR's **Revert** button. When U7b ships, the
first path becomes "Sign in at `/cms/` → edit → Propose" and the multi-file-red note is replaced
by "the editor commits every file of a proposal at once"; when U9 ships, a "Pictures" section
(Media tab; sizes).

**`README.md`:** edit map rows match `CLAUDE.md`; "Run it" adds `node tools/dev_site.mjs` (the
function-aware server) and the `.env.local` keys for local CMS testing; Status mentions the site
editor; the CI paragraph names both workflows.

**`.github/CODEOWNERS`:** `/content/ /data/ @NBauschmann @desert-mango-robotics`; everything else
and `/.github/ /tools/ /api/ /js/ /cms/ /vercel.json` → `@desert-mango-robotics`
(`@kyle-nelson-berkeley` kept while he holds Write). Comment: code owners need write access [S49];
the file is inert while the repository is private on the Free plan [S26] and becomes live if it
goes public; it never blocks (no protection).

**`.github/pull_request_template.md`:** drop the `search/` and "Approve and run" lines; add
"Proposals from the site editor say so in the body"; the do-not-touch list adds `cms/`.

**`docs/cms-plan.md`:** a supersession note at the top: which parts v2 replaces ("Kyle merges" →
Nathalie and Maintainers merge; fork-only → collaborators with branches; the advisory job →
`derive.yml`; Phase F "static admin UI, default NO" → built as a custom `/cms/`, with D1's
reasons) and a pointer to `docs/cms-v2-plan.md`. The body stays as the historical record.

---

## 8. Cost

Target: $0/month. Today's stack stays at $0; every item that could cost money is listed.

| Item | Today | Would cost | Notes |
|---|---|---|---|
| Vercel Hobby (the new Desert Mango account) | $0 | — | **Flagged.** Terms: "non-commercial, personal use only" [S14]. A business account hosting a client site, even served free, is a gray area — noted here per the brief, not solved by this plan; E1-A closes it, E1-C leaves it. One seat. Functions: 1M invocations, 300 s max, 4.5 MB body [S15]. |
| Vercel Pro (E1 option A: private repo) | — | **$20/month**, plus **$20/month per extra deploying seat** [S16]; Pro Viewer seats are free [S17] — M1 step 5 under A tests a Viewer first, then a Member, and records which one deploys (R2-F3): $20 if a Viewer's merges deploy, $40 if Nathalie needs a Member seat | Honest price $20–40/month — **and the derive bot's commits are unverified on Pro** (M1 step 6, R1-F2): if they do not deploy, page-adding merges stay undeployed until a human pushes, at that price. If A fails either test, the fallback is C, then B. |
| E1 option C: public repo + Hobby | — | **$0** | Non-monetary costs only (E1-C): history and e-mail audit, the gray area unchanged, CODEOWNERS live, read-only CMS state. Actions minutes become free (public repository) [S41]. |
| Vercel Password Protection | — | $20/month/project, Pro only [S11] | Not used. |
| GitHub Free (org) | $0 | — | 2,000 Actions minutes/month for private repos, 500 MB packages [S26][S27]; unlimited on a public repo [S41]. Expected use: ~2 runs × ~1–2 min per PR event or merge ≈ 100–300 min/month. |
| GitHub Actions overage | — | Linux minutes billed per minute above 2,000 [S41] (reported $0.006/min) | Unlikely to be reached. |
| GitHub Team (would light up code owners, rules, Pages on private repos) | — | **$4/user/month** [S26] | Not needed by this plan. |
| GitHub App | $0 | — | |
| Cloudinary Free | $0 | — | 25 credits/month; 1 credit = 1,000 transformations or 1 GB storage or 1 GB bandwidth [S64]. Today: 51 assets, 28.6 MB, three folders — far under. 3 users, 1 account [S64]. |
| Cloudinary Plus | — | **$99/month** [S64] | Only if the lab ever exceeds 25 credits. |
| OpenRouter free models (librarian) | $0 | — | Unchanged; 50 requests/day, degrades to keyword search. |
| Cloudflare Pages (E1 option B) | — | $0; Workers Paid **$5/month** only above 500 builds/month [S22][S25] | |
| SSL, domains, e-mail | $0 | — | `hippocampus-docs.vercel.app`; no custom domain. |

---

## 9. Escalations

**E1 — Which deploy path: Kyle decides now, before the build (R1-F1).** Vercel's docs (read
2026-09-21) put two rules under the heading "Deploying private Git repositories": a Hobby team
cannot deploy a private repository in a GitHub organization, and on organization repositories
only the Hobby owner's own commits deploy [S1][S2]; a Vercel staff reply says "Hobby plans only
allow deployments from the account owner" [S20]. The same page says "for public Git repositories,
a different behavior applies": commits usually deploy automatically and only pull requests from
forks need an authorization click [S1]; the troubleshooting page adds that collaboration is free
for public repositories [S3]. Kyle's current import — a private organization repository on Hobby —
is therefore expected by the docs to be blocked. The pair to put to Kyle, with M1 steps 5 and 6
as the final word under whichever he picks:

- **A. Keep the repository private; upgrade the new Desert Mango team to Pro — $20/month, plus
  $20/month per extra deploying seat** [S16]. Keeps every unit unchanged and closes the Hobby
  non-commercial gray area. On Pro the commit author must be a team member [S1], so Nathalie
  needs a Vercel account linked to her GitHub and a seat (M5 step 4); Pro Viewer seats are free
  [S17] but whether a Viewer counts as "a member of the team" is not stated (§10), so M1 step 5
  under A tests a **Viewer first, then a Member**, and records which one deploys (R2-F3) — $20 if
  Viewer suffices, $40 if Member is needed; run those tests inside a Pro trial if Vercel offers
  one at upgrade time, before paying. **Risk named (R1-F2):** the derive bot
  (`github-actions[bot]`) cannot be a team member, and the docs never say bot commits deploy on
  Pro [S3]; if M1 step 6 shows **Blocked** under A, every page-adding merge leaves production on
  the old deploy until a human pushes — R6/R7 would break silently after the handoff, at
  $20–40/month. If either test fails under A, the fallback is C, then B (M1 step 7).
- **C. Make the repository public; stay on Hobby — $0.** The docs' public-repository behavior
  deploys any author [S1], so Nathalie's merges and the bot's commits should deploy; Actions
  minutes become free [S41]. Its real costs, none of them money: (1) **the history goes public**
  — 59 commits, 58 with `kyle-nelson@berkeley.edu` as author e-mail and one (`a47a27a`, today's
  HEAD) with the SimpleLogin alias `github.reoccupy179@slmails.com`; the local `user.email` is
  the noreply address now, the history is not. Before flipping: a history audit
  (`git log --format='%ae' | sort | uniq -c`; `git log -p --all | grep -nE '@|token|secret|key'`
  over the whole history — `check.py` 6b covers only the working tree) and Kyle's decision on the
  two addresses: accept them as public (an institutional address and a burner alias), or rewrite
  history once before going public (a force-push Kyle's agents can do; it invalidates PR #1's base
  and needs M9 redone); (2) the Hobby non-commercial gray area is unchanged (A closes it); (3)
  `CODEOWNERS` goes live [S26] — still non-blocking, it only auto-requests reviewers; (4) any
  GitHub account can already authorize the public editor App (R2-F1); on a public repository the
  CMS's repository lookup then succeeds for everyone, so the CMS needs the read-only state (D8,
  U7a) — nothing can be written without `permissions.push`; (5) the Private tab is unaffected (it
  never depended on this repository's visibility).
- **B. Cloudflare Pages — $0 — only if Kyle wants neither A nor C.** Private and organization
  repositories are supported on the free plan [S23]; 500 builds/month [S22]; the v3 build image
  has Python 3.13.3 [S24], so the R7 build command runs there as `python3 tools/check.py`. Costs
  one extra Opus 5 unit: port `api/librarian.js` to a Pages Function (it reads its graph files
  from disk today; on Workers it would read them through the static-asset binding) and its local
  mocks. Reverses Kyle's "hosting stays on Vercel" decision.
- **Rejected, not offered:** deploying from GitHub Actions with the Vercel CLI (staff say CLI
  deploys skip the author check [S21]) — it works around a Hobby rule instead of respecting it,
  which the brief forbids, and it would put a Vercel account token in Actions.

Kyle said he prefers private if it works. Recommendation: **private ⇒ A ($20–40/month); $0 ⇒ C;
B only if he wants neither.** Whichever he picks, M1 steps 5 and 6 must show **Ready** under it
before the domain moves (M1 step 8) and before U1's live half; if A fails either, C, then B
(R2-F3). The orchestrator puts the pair to Kyle right after this review, with the M1 evidence so
far.

**E2 — `CLAUDE.md` wording beyond R7.** §7 items 2–8 change the law file's text to describe
R1–R6 (edit-map rows, the pipeline section, the "(Vercel + Pages)" fact, the no-CDN-script rule).
The plan treats them as descriptions of approved asks, not new laws. If Kyle or the reviewer
reads any as a new law, Kyle decides before U11 ships.

No third escalation. Nothing else spends money or reverses a decision.

---

## 10. What could not be verified

1. **Outcome of M1 on the new Desert Mango account.** The docs say blocked twice over for a
   private org repo (the repo itself; non-owner authors); Kyle's own experience (a private
   personal repo deploys) is consistent with the docs, which single out organization repos.
   Settled by M1 steps 4–6, never by restating the docs. The import's first deploy builds a
   non-owner-authored HEAD (`a47a27a`, the SimpleLogin alias — R1-F10), so a Blocked result there
   is confounded; the decisive owner test is step 4 (a Desert-Mango-authored commit). The new
   account did not exist when this plan was written, so nothing about it was observed.
1b. **Whether a bot commit (`github-actions[bot]`) deploys on Vercel under A or C** (R1-F2).
   Not stated for either; M1 step 6 is the only evidence that counts. Until it passes, R6's
   "page-adding merges deploy after the bot's commit" is unproven.
2. **Whether an outside collaborator can hold the Admin role** on an organization repository (the
   role list is not stated on the pages read [S42][S44]); M5 step 3 is the fallback and keeps
   "not org owner".
3. **Whether a workflow's `permissions:` key can elevate `contents: write`** when the repository
   default is read: one GitHub page says the workflow file can add access [S37], another only
   describes the default [S38]. U2's first run proves it; M8 is the fallback.
4. **Whether `GITHUB_TOKEN` can read `HippoCampusRobotics` public contributor endpoints** from
   Actions (the token page says it is limited to the workflow's repository [S35] but public reads
   are generally allowed). U2 proves it; the fallback is a no-permission fine-grained PAT.
5. **Cloudinary folder mode of `dr76gues0`** and the Free-plan file-size limit (reported 10 MB;
   the support article returned 403). U6 detects the mode; the UI advises ≤ 5 MB.
6. **Whether a Vercel Pro Viewer counts as a "member of the team"** for the commit-author rule
   [S3][S17]. Decides E1-A's price; M1 step 5 under A tests a Viewer first, then a Member, and
   records which one deploys (R2-F3).
7. **Squash-merge author identity** (PR author vs merger) is not stated by GitHub [S45]. That is
   exactly why M1 step 5 has the non-owner author, open and squash-merge the PR and records
   `git log -1 --format='%an <%ae>'` before reading Vercel (R1-F3).
8. **`.vercelignore` on Git deployments** is "not stated" [S10]; U1's `-B` flag and env var make
   it belt-and-braces, and the acceptance proves the output is clean.
9. **Whether Nathalie is an owner of `HippoCampusRobotics`** (she is a public member). M7 needs
   an owner once.
10. **PR #1's commit count**: the brief says 5 commits; the API shows 15 commits over 11 files
    (9 setup pages + the two `search/` files). The plan uses the API's numbers.
11. **The brief's "Cloudinary MCP" wish (memory 2026-09-03)** is out of scope here and untouched.
12. **Whether Vercel offers a Pro trial at upgrade time.** Not verified; M1 step 5 uses one only
    if it is offered (R2-F3).
13. **The exact label of Vercel's team-invite button** (**Invite** or **Add Member**) — the intent
    is what M1 step 5 and M5 step 4 preserve.

---

## 11. Build rules for the implementer

- Never delete, skip, or hard-code around a failing test or check to go green; fix the root
  cause. A red `check.py` is content to fix or a gate to strengthen, never a check to weaken.
- `python3 tools/check.py` → `check.py: all green` before every commit; `python3
  tools/check_urls.py` whenever images or the manifest changed.
- No npm, no build tooling, no framework, no third-party script from a CDN; `js/marked.min.js`
  stays sha256-pinned; new browser code is our own files.
- `.github/workflows/*` changes push only over SSH (`github-desert-mango`, key
  `~/.ssh/id_ed25519_desert_mango_github`, M6 done); org API calls use
  `GH_TOKEN=$(gh auth token --user desert-mango-robotics)`; never `gh auth switch`.
- Every new `.js`, `.mjs` or `.py` file (tests included) carries the five-line header
  (`Author`, `Project` = the canonical URL, `Last substantive modification`, `Affiliation`,
  `Purpose`, in that order, `#` or `//` per language) and an `included` entry with its baseline
  sha256 in `tools/attribution_headers.json`; `tools/check_attribution_headers.py` runs inside
  `check.py` and fails on a missing entry or header (R1-F15). Add the entry in the same commit
  as the file.
- Commits are authored as Desert Mango; done means merged into `main` and pushed (the
  git-worktree ownership gate applies); every push deploys, so the gate is green first.
- The delivery tiers are the build order: nothing from "next" starts while a must-have unit is
  red, and nothing from "after the handoff" starts before 2026-10-05 unless every earlier tier
  is merged and rehearsed.
- No setup-page content changes; no homepage or visual redesign; the old org docs site is not
  touched.
- Secrets never enter the repo, a log line, a test fixture, a prompt, or a response body.

---

## Revision 1 changelog (plan-review round 1, 2026-09-21)

One line per finding; the author responses in the review transcript are the binding text.

- R1-F1 — E1 rewritten: C (public repo + Hobby) is a real $0 option with its non-monetary costs (history and e-mail audit with both addresses named, gray area unchanged, CODEOWNERS live, read-only CMS state, Actions free); A is $20–40/month with the bot risk named; B only if neither; the pair goes to Kyle now. Intro and §10.1 corrected the same way.
- R1-F2 — M1 step 6 (step 7 before the round-2 renumbering) tests a `github-actions[bot]` commit for deploy; D5 and D4 say "unverified"; §10.1b added; E1-A and the cost table carry the risk.
- R1-F3 — M1 step 5 (step 6 before the round-2 renumbering): the non-owner authors, opens and squash-merges the PR; the merge author is recorded before Vercel is read; void if it is `desert-mango-robotics`. §10.7 points at it.
- R1-F4 — D4 separates derived outputs from authored overlays (39 edges, 23 authored summaries, 14 rejected + 71 stoplist terms); §7 item 2 is two rows, no "never hand-edited"; existing ids are read-only in the CMS (D8, U7b); U2 and U3 gain the located overlay message and acceptance cases, for CMS and pencil edits alike.
- R1-F5 — M2 adds Checks: read and Commit statuses: read; `check.yml` gains a separate `if: failure()` annotation step reading a copy of the gate output (the gate command stays verbatim); U8 reads `/check-runs/{id}/annotations` and has a real-red-PR test.
- R1-F6 — the Private tab uses a second, read-only viewer App (M2b, M7, U10, D7); §5 states the private-key fact and what bounds it; moved after the handoff.
- R1-F7 — the sanitizer allows same-origin relative URLs under `assets/` (the seven `design.md` download links) and `align` on `th`/`td`; test cases and the `#/setup/lab-marker/design` browser route added.
- R1-F8 — new "Delivery tiers" section; every unit header carries its tier; U7 split into U7a (shell + sign-in, must-have) and U7b (editor, next); U4's CSP split out as U4b (after the handoff); U8 ships without Undo (GitHub's Revert is the rollback); U11 is written for the day-one path; U12 runs per tier.
- R1-F9 — M1 domain order: remove the domain from the old project's Domains, add it to the new project, run M2 after, delete the old project last with Kyle's OK.
- R1-F10 — N4 corrected: `a47a27a` (HEAD) carries the SimpleLogin alias, `b114a20` carries `kyle-nelson@berkeley.edu`; the import's first deploy builds a non-owner-authored HEAD; §3 and the intro say "going forward".
- R1-F11 — `check.yml` regenerates on `pull_request` only; on `main` the gate judges the committed tree; `build_contributors.py` stays off the PR path.
- R1-F12 — the callback page posts `{code, state}` to the opener; the opener checks `state` and calls `/api/auth`; the token never exists in the popup.
- R1-F13 — bridge nonce in the URL fragment (not `window.name`), `event.source` check, path allowlist (`content/`, `data/`, `search/`) at the previewed ref; tests added; U4/U7a browser passes run in Chrome, Safari and Firefox.
- R1-F14 — proposals are one commit through the Git Data API (blobs → tree → commit → ref); `vercel.json` `git.deploymentEnabled` is `false` for `cms/**` (U1).
- R1-F15 — attribution headers and `tools/attribution_headers.json` entries are in §11 and in every unit's file list.
- R1-F16 — M5's org-member fallback first sets the org's base permission to "No permission" (it is Read today) and confirms it by API.
- R1-F17 — M6 marked done with the real names: `~/.ssh/id_ed25519_desert_mango_github`, comment and GitHub title `desert-mango-m4-macbookpro`; §5 table and §11 fixed.

### Revision 2 (plan-review round 2, 2026-09-21)

- R2-F1 (blocking) — the editor App is public ("Any account", M2 step 6): a private App can be authorized only by members of the owning org [S92], and Nathalie and the lab are outside collaborators. `js/cms.js` ignores every repository except `desert-mango/hippocampus-docs` (U7a); §5 states the install-anywhere fact and what bounds it; D8, §5 "Also" and E1-C(4) now say "authorize the public App" and describe the 404 stop on a private repo; U5, U7a and U12 gain a live sign-in by an outside collaborator (`kyle-nelson-berkeley`). Nobody joins the org to work around it.
- R2-F2 (major) — the domain moves only after the new project shows a Ready production deploy of current `main` under the confirmed E1 option (M1 step 8, now last before the delete), with a rollback line (put the domain back on the old project, which still exists); §3 says the docs never go dark. (Round 3 lifted "M2 waits for it"; see R3-F2.)
- R2-F3 (major) — under E1-A the non-owner tester joins the Vercel team as Viewer first, then Member only if Blocked, and the passing role is recorded (M1 step 5); Nathalie gets a Vercel account and that role (M5 step 4); if A fails either test, C, then B (M1 step 7, E1); A's tests run inside a Pro trial if one is offered; §8, §10.6, §10.12–13 updated.
- R2-F4 (minor) — the overlay rule covers only `edges-authored.json` and the authored summaries; `rejected`/`stoplist` are word lists (veto sets), hand-kept but not id-keyed and not checked (D4, U2, U3 item 5, §7 item 2).
- R2-F5 (minor) — "Manual steps by tier" added at the top of §6: must-have M1 → M2 → M3 (App variables) → M5 → M9 (after U2 is merged); next M4 + Cloudinary part of M3; after the handoff M2b, M7, M10; M3 split into three visits; the tier table and M9 updated.
- R2-F6 (minor) — the annotation step reads only the output files that exist (`derive-output.txt` on pull requests only), never failing on a missing file (U2 check.yml item 3).

---

### Revision 3 (plan-review round 3, 2026-09-21: reviewer signed off, "I agree this plan is sound")

- R3-F1 (minor): stale references fixed. The R1-F3 changelog line points at M1 step 5. The header reads revision 3. The TOC names every changelog. U11 no longer mentions a "step 6 failed" branch that step 7 now rules out.
- R3-F2 (minor): M2 runs right after M1 step 3, because the final domain `hippocampus-docs.vercel.app` is already known and GitHub does not check the callback at creation. Only the live sign-in checks (U5 live, U12) wait for M1 step 8.
- R3-F3 (minor): M1 step 7's fallback returns to Kyle with the evidence. C runs only after its history audit and his e-mail decision (E1-C(1)). Pro is cancelled or downgraded, or the trial ended, before C's tests.
- R3-F4 (minor): M1 step 2 says that if the Vercel app is already installed on `desert-mango`, the screen edits that one installation. Add `hippocampus-docs` and do not unselect anything.

## 12. Sources

All read on 2026-09-21 with WebFetch/WebSearch (Firecrawl was out of credits). Quotes in the body
are short paraphrases of what the pages state; where a page did not state a thing, §10 says so.

**Vercel**
- [S1] https://vercel.com/docs/git (page updated 2026-09-08) — under "Deploying private Git repositories": Hobby cannot deploy a private org repository; "the commit author must be the owner of the Hobby team"; Pro: "the commit author must be a member of the team". "For public Git repositories, a different behavior applies": commits from forks "will usually deploy automatically", fork PRs need an authorization click.
- [S2] https://vercel.com/docs/limits — Hobby teams cannot connect projects to org-owned repositories.
- [S3] https://vercel.com/docs/deployments/troubleshoot-project-collaboration (updated 2026-03-13) — Hobby: no collaboration for private repos; "Collaboration is free for public repositories"; Pro: author must be a team member; bots should be "clearly identified as automated" (nothing on whether they deploy).
- [S4] https://vercel.com/docs/deploy-hooks (updated 2026-09-16) — 5 hooks per project on Hobby and Pro; hooks re-run the Build Step; 60/hour.
- [S5] https://vercel.com/kb/guide/why-aren-t-commits-triggering-deployments-on-vercel — "Collaboration has never been permitted on Hobby plans"; hooks build the latest branch commit.
- [S6] https://vercel.com/docs/builds/build-image (updated 2026-08-11) — Amazon Linux 2023; Python 3.14, 3.13, 3.12.
- [S7] https://vercel.com/docs/functions/runtimes/python — 3.12 default.
- [S8] https://vercel.com/docs/project-configuration/vercel-json (updated 2026-08-14) — `buildCommand`, `ignoreCommand`, `outputDirectory`; inline env "not stated".
- [S9] https://vercel.com/docs/builds/configure-a-build — only the Output Directory is served.
- [S10] https://vercel.com/docs/deployments/vercel-ignore — `.vercelignore` excludes files from the deployment.
- [S11] https://vercel.com/docs/deployment-protection/usage-and-pricing — Vercel Authentication included on Hobby; Password Protection not on Hobby ($20/month/project on Pro).
- [S12] https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication — non-members cannot open protected deployments; Hobby can enable or disable.
- [S13] https://vercel.com/changelog/deployment-protection-is-now-enabled-by-default-for-new-projects — on by default (2023-11-02).
- [S14] https://vercel.com/docs/plans/hobby — "non-commercial, personal use only".
- [S15] https://vercel.com/docs/functions/limitations — 4.5 MB request body; 300 s; 2 GB.
- [S16] https://vercel.com/pricing — Pro $20/month; developer seat $20/month.
- [S17] https://vercel.com/docs/rbac/access-roles (updated 2026-09-15) — "Pro Viewer seats are provided free of charge on Pro teams".
- [S18] https://vercel.com/docs/git/vercel-for-github (updated 2026-09-17) — org Owner or Member connects; app permissions; PR comments on by default; fork PRs need authorization.
- [S19] https://vercel.com/docs/project-configuration/git-configuration (updated 2026-08-25) — `github.silent` deprecated in favour of the dashboard setting; `git.deploymentEnabled`.
- [S20] https://community.vercel.com/t/vercel-hobby-plan-deployment-blocked-because-commit-author-lacks-access/35446 (2026-03-05) — block message; staff: "Hobby plans only allow deployments from the account owner".
- [S21] https://community.vercel.com/t/vercel-github-deployment-blocked-by-committer-not-associated-error-on-hobby-plan/37045 — staff: CLI deploys skip the check.

**Cloudflare / GitHub Pages / GitHub plans**
- [S22] https://developers.cloudflare.com/pages/platform/limits/ — 500 builds/month free; 1 concurrent.
- [S23] https://developers.cloudflare.com/pages/get-started/git-integration/ — private and public repositories supported.
- [S24] https://developers.cloudflare.com/pages/configuration/build-image/ — v3 image: Python 3.13.3, `PYTHON_VERSION`.
- [S25] https://developers.cloudflare.com/workers/platform/pricing/ — Workers Paid $5/month minimum.
- [S26] https://github.com/pricing — Team $4/user/month; Free: 2,000 minutes, 500 MB; public-only on Free: repository rules, code owners, required reviewers, Pages and wikis.
- [S27] https://docs.github.com/en/get-started/learning-about-github/githubs-plans — Free for organizations: unlimited private repositories with a limited feature set; 2,000 Actions minutes.

**GitHub Apps, Actions, roles, API**
- [S28] https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app — token limited to what both user and app can access; 8 h; `client_secret` required for the exchange; device flow; "if your app runs in the browser, use the web application flow".
- [S29] https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens — "User-to-server token expiration" opt-in/opt-out; 8 h / 6 months; refresh needs `client_secret`.
- [S30] https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app — field labels used in M2.
- [S31] https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps — `repo` grants full access to public and private repositories; `workflow` scope for workflow files.
- [S32] https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps — OAuth apps reach all of the user's accessible resources.
- [S33] https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps — Contents write for git data; Pull requests write for reviews and merge; Administration for collaborators; Workflows write for workflow files.
- [S34] https://docs.github.com/en/rest/apps/installations — `GET /user/installations`, `GET /user/installations/{id}/repositories` return what the user has explicit permission to access.
- [S35] https://docs.github.com/en/actions/concepts/security/github_token — events triggered by `GITHUB_TOKEN` do not create new workflow runs; token limited to the workflow's repository.
- [S36] https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow — an App installation token or PAT does trigger runs.
- [S37] https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository — the two workflow-permission options (restricted is default); the workflow file's `permissions` key can add or remove access; "Require approval for fork pull request workflows"; "Allow GitHub Actions to create and approve pull requests".
- [S38] https://docs.github.com/en/actions/writing-workflows/workflow-syntax#permissions — fork PRs typically cannot be granted write.
- [S39] https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md (image 20260907.300.1) — gh 2.100.0, Python 3.12.3, OpenSSL 3.0.13.
- [S40] https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api — `GITHUB_TOKEN` 1,000/hour/repository; users 5,000/hour.
- [S41] https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions — free for public repositories; per-minute overage for Linux.
- [S42] https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization — Admin manages individual, team and outside collaborator access.
- [S43] https://docs.github.com/en/organizations/managing-organization-settings/setting-permissions-for-adding-outside-collaborators — by default anyone with admin access to a repository can invite outside collaborators; org owners can switch it off.
- [S44] https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-outside-collaborators/adding-outside-collaborators-to-repositories-in-your-organization — choose the access level per collaborator; no paid seat on the free plan.
- [S45] https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/merging-a-pull-request — author e-mail selector; squash authorship not stated.
- [S46] https://docs.github.com/en/rest/pulls/pulls — `PUT /pulls/{n}/merge`, `merge_method`, `sha`, 405/409.
- [S47] https://docs.github.com/en/rest/pulls/reviews — `POST /pulls/{n}/reviews`, `APPROVE`.
- [S48] https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/approving-a-pull-request-with-required-reviews — authors cannot approve their own pull requests.
- [S49] https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners — code owners must have write permissions.
- [S50] https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/approving-workflow-runs-from-public-forks — fork PR runs may require approval.
- [S51] https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/ — `pull_request_target` with an untrusted checkout is dangerous.
- [S52] https://docs.github.com/en/rest/repos/contents — 1 MB full; raw media type to 100 MB; `ref`.
- [S53] https://docs.github.com/en/rest/search/search — 30 requests/minute; not used by the plan.

**Cloudinary**
- [S54] https://cloudinary.com/documentation/authentication_signatures — sorted `name=value` pairs joined with `&`, secret appended, SHA-1 or SHA-256; sent values must match; valid one hour.
- [S55] https://cloudinary.com/documentation/client_side_uploading — signed direct browser upload; unsigned requests cannot overwrite.
- [S56] https://cloudinary.com/documentation/image_upload_api_reference_upload.md — unsigned-upload parameter list includes `folder`; response fields; `folder`, `asset_folder`, `public_id_prefix`.
- [S57] https://cloudinary.com/documentation/upload_presets — preset precedence; no folder lock stated.
- [S58] https://cloudinary.com/documentation/folder_modes — dynamic mode default since 2024-06-04; `config` with `settings=true` returns `folder_mode`; legacy `folder`.
- [S59] https://cloudinary.com/documentation/admin_api_overview.md — Basic auth; 500 requests/hour on Free; Upload API not rate-limited.
- [S60] https://cloudinary.com/documentation/admin_api_resources_get_resources.md — `prefix`; `max_results` ≤ 500; `next_cursor`.
- [S61] https://cloudinary.com/documentation/search_api — `folder:` / `asset_folder:` expressions.
- [S62] https://cloudinary.com/documentation/image_upload_api_reference_destroy_by_public_id.md — signed `destroy`; `invalidate`.
- [S63] https://cloudinary.com/documentation/image_upload_api_reference_rename_public_id.md — signed `rename`.
- [S64] https://cloudinary.com/pricing — 25 monthly credits; credit definition; 3 users; Plus $99/month.
- [S65] https://cloudinary.com/documentation/media_library_widget — hosted script; Cloudinary login; only the documented configuration is supported.
- [S66] https://cloudinary.com/documentation/product_environment_settings — generate new API key and secret pairs; deactivate and delete keys.
- [S67] https://cloudinary.com/documentation/dam_admin_permissions — folder roles on API keys via the Admin API on all plans; enforcement not stated.
- [S68] https://cloudinary.com/documentation/advanced_url_delivery_options — URLs work without a version component.

**CMS products**
- [S69] https://github.com/sveltia/sveltia-cms/releases — v0.217.0 (2026-09-19).
- [S70] https://sveltiacms.app/en/docs/backends/github — OAuth app plus an OAuth client server; "Sign In with Token" (PATs); GitHub App sign-in not stated.
- [S71] https://sveltiacms.app/en/docs/workflows/editorial — `cms/[COLLECTION]/[SLUG]` branches, labels, merge on publish; arbitrary PRs not stated.
- [S72] https://sveltiacms.app/en/docs/workflows/open — open authoring; private repos need an org and `repo` scope.
- [S73] https://sveltiacms.app/en/docs/media/cloudinary — opens Cloudinary's Media Library widget; `cloud_name`, `api_key`; secret must not be in the config.
- [S74] https://sveltiacms.app/en/docs/start and https://app.unpkg.com/@sveltia/cms@0.217.0/files/dist — `sveltia-cms.js` 2.11 MB plus `chunks/react-dom.js` 220 kB.
- [S75] https://sveltiacms.app/en/docs/data-output — body-only Markdown gets no front matter; JSON re-serialized with 2-space indent, config-ordered keys.
- [S76] https://sveltiacms.app/en/docs/fields/richtext — `sanitize_preview` defaults to true (DOMPurify); disabling it can expose XSS.
- [S77] https://sveltiacms.app/en/docs/api/preview-templates — custom previews are React class components.
- [S78] https://sveltiacms.app/en/docs/roadmap — v1.0 expected late 2026; PKCE waiting on GitHub.
- [S79] https://github.com/decaporg/decap-cms/releases — 3.16.1 (2026-09-08).
- [S80] https://app.unpkg.com/decap-cms@3.16.1/files/dist — `decap-cms.js` 5.15 MB, ~180 chunks, 385 files.
- [S81] https://decapcms.org/docs/github-backend/ — all users need push access; Netlify or external OAuth client.
- [S82] https://decapcms.org/docs/editorial-workflows/ — `cms/collectionName/entrySlug` branches and pull requests.
- [S83] https://decapcms.org/docs/open-authoring/ — forks; private repos need `read` and `repo` scope.
- [S84] https://decapcms.org/docs/cloudinary/ — the user must be logged in to the Cloudinary account connected to the `api_key`.
- [S85] https://decapcms.org/docs/customization/ — React preview templates, `registerPreviewTemplate`.
- [S86] https://decapcms.org/docs/backends-overview/ and https://raw.githubusercontent.com/sveltia/sveltia-cms-auth/main/src/index.js — the popup `postMessage` handshake.
- [S87] https://pagescms.org/ , https://pagescms.org/docs/ , https://github.com/pages-cms/pages-cms — free; edits files directly; self-host needs Next.js and PostgreSQL; GitHub App asks Administration read and write.
- [S88] https://tina.io/docs/frameworks/other and https://keystatic.com/docs/installation-next-js — framework and npm required.

**Added in revision 1**
- [S89] https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/reverting-a-pull-request — "Reverting a merged pull request creates a new pull request that reverts the original merge commit"; "You must have write permissions"; steps: Pull requests → the PR → **Revert** → merge the resulting PR.
- [S90] https://docs.github.com/en/rest/checks/runs — `GET /repos/{owner}/{repo}/commits/{ref}/check-runs`; `GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations` with `path`, `start_line`, `end_line`, `start_column`, `end_column`, `annotation_level`, `title`, `message`.
- [S91] https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands — `::error file={name},line={line},endLine={endLine},title={title}::{message}`; no per-step annotation limit is stated on this page.

**Added in revision 2**
- [S92] https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private — a private App "can only be installed on the account that owns the app" and "Only members of the organization that owns it can authorize it"; a public App: "any user on GitHub can install it and authorize it".

**Local observations (not external claims):** GitHub API reads of `desert-mango/hippocampus-docs`
(private; collaborators `kyle-nelson-berkeley` Write, `desert-mango-robotics` Admin; Actions on,
default token read; no secrets; `has_pages: false`; PR #1 = 15 commits, 11 files, `mergeable_state:
dirty`; the org's `default_repository_permission` is `read`), `git merge-tree` (conflicts only in
`search/`), `git log --format='%ae'` (59 commits: 58 `kyle-nelson@berkeley.edu`, 1
`github.reoccupy179@slmails.com` at HEAD `a47a27a`; `b114a20` is `kyle-nelson@berkeley.edu`),
`data/graph/` (23 authored summaries, 39 authored edges, 14 `rejected` and 71 `stoplist` xref
entries), `content/setup/lab-marker/design.md` (seven relative `assets/setup/*` links),
`tools/check_attribution_headers.py` (run by `check.py`; inventory `tools/attribution_headers.json`
with `included`/`excluded` classifications and baseline sha256), the Vercel API of the OLD
personal account (project still linked to `kyle-nelson-berkeley/hippocampus-docs` repoId
1349523391; env `OPENROUTER_API_KEY`; deployment of `b114a20` on 2026-09-11 **Blocked** with no
author login; the `vercel` CLI is logged in as `kyle-nelson-berkeley`), `ssh -T
git@github-desert-mango` → `Hi desert-mango-robotics!` with key
`~/.ssh/id_ed25519_desert_mango_github` (comment `desert-mango-m4-macbookpro`), `python3
tools/check.py` → `check.py: all green`.
