# CMS plan — lab members edit the site through GitHub pull requests

*2026-09-03 · consensus via /plan-review. **Built and merged 2026-09-05** (commit
`c6957ae`): the hardened gate, the `.github/` scaffolding, `CONTRIBUTING.md`, and the
`CLAUDE.md` "Contribution pipeline" section all ship. This document is now a reconciled
record of that plan, not a pre-build proposal — read the reconciliation note directly below
for the three places reality diverged from the original plan.*

> ## Reconciliation note — 2026-09-09
>
> The pipeline is merged and, on a re-audit against today's `main`, sound: the gate's
> `READER_REQUIRED_KEYS` covers every registry reader with zero silent holes (the coverage
> audit re-derived the reader set and traced every bare dereference; nothing was missing).
> Three things changed after the original 2026-09-03 plan, and the body below is annotated to
> match — the appendix changelog is preserved verbatim as the historical record:
>
> 1. **Branch protection was DECLINED (2026-09-06), permanently.** The §6 G3 rule and the §5
>    "belt-and-braces" framing are **not a to-do and are never to be re-proposed** — a blocked
>    merge state must never land on a lab member. `main` carries no branch protection; the
>    Kyle-gate on publishing is *permissions* (no write collaborators) plus the "done means
>    merged" law. §5, §6, and the §9 decision rows are annotated accordingly.
> 2. **The People section shipped** (commit `15a3d91`): `data/people.json` + the About-page
>    roster exist, the registry is covered by `check.py`'s §6c validator, and `#/about`
>    resolves. The prerequisite **P-people** in §2 is **met** — the conditionality is closed.
> 3. **"Done means merged" replaced the Kyle-gated-publishing line** (`CLAUDE.md`, commit
>    `c4281f9`). Every push still deploys, but Kyle's own agents push `main` directly with his
>    identity (there is no protection to stop them); outside contributors and lab members
>    still go through the fork-PR pipeline below and never push `main`.
>
> Unchanged and re-verified: the site is still `noindex` staging (`index.html` robots meta +
> `vercel.json` `X-Robots-Tag`), and the org cut-over remains a team decision — so Phase D's
> staging framing stands.

**Goal (Kyle's words):** future lab members can update the site as they see fit, including
proposing edits as GitHub pull requests that get reviewed and merged.

**The one-sentence design:** the CMS *is* GitHub — web-UI editing on top of the existing
zero-build repo, a PR gate that runs the repo's own `tools/check.py` (hardened first, §4.0),
and a merge that only Kyle can perform. No software is installed anywhere, for anyone.

Research grounding: the "Robotics Documentation Websites" NotebookLM notebook
(`2944323b-c286-4a48-92dd-10f4763de9fe`, 30 sources: Diátaxis/docs-as-code, git-based CMS
practice, GitHub PR mechanics, contributor onboarding), 7 notebook queries + 1 cross-query
with the "Documenting Robotics Projects" notebook, 2026-09-03. A /plan-review debate
(fresh Opus reviewer each round, mutation-tested against the real repo every round)
hardened this plan through 32 accepted findings across five reviewer rounds; the final
round signed off ("I agree this plan is sound"). The changelog is at the bottom.

---

## 1. Fixed constraints

1. **Zero-build stays.** What you edit is what serves. No Node, no npm, no build step, no
   new dependencies in the serving path or in any contributor's setup. (Repo law,
   `CLAUDE.md`.) The one CI-side external input is a SHA-pinned `actions/checkout` —
   named honestly here and in the `CLAUDE.md` amendment (§5, Phase B).
2. **Any push to `main` publishes** (GitHub Pages + Vercel git auto-deploy). Therefore
   *merge is deploy*. *(Reconciled 2026-09-09: publishing is governed by the "done means
   merged" law, not a branch-protection gate. Kyle's own agents push `main` directly with his
   identity; outside contributors and lab members reach `main` only through the fork-PR
   pipeline below, because they have no write access.)*
3. **`tools/check.py` is the single gate command.** CI runs it verbatim — never a copy,
   never a weakened variant. Review found the current script is a *cross-file consistency*
   checker, not a schema validator: a valid-JSON registry entry with a missing key either
   crashes it (bare `KeyError` traceback) or passes green and then breaks the rendered
   page and the search-index rebuild. So the build starts by **strengthening** the gate
   (§4.0) — explicitly permitted by the law, which forbids only weakening it.
4. **The content model stays**: prose in `content/` (Markdown + the raw-HTML dialect for
   admonitions/tabs), facts in strict-JSON registries under `data/`, derived search shards
   under `search/`. The CMS adapts contributors to this model, not the model to a CMS.
5. All repo-settings changes (Actions, collaborators) are Kyle-gated: §6 records the exact
   steps. *(Reconciled 2026-09-09: the branch-protection step, G3, was **declined** — see §5
   and §6. The Actions posture (G1) and empty-collaborator policy (G4) remain the live
   repo-settings facts.)*

## 2. Who contributes, and with what access

Concrete personas (all real):

- **A student fixing a wrong pin number** in a setup page — one-line Markdown edit in
  `content/setup/…`. The canonical first contribution.
- **A lab member correcting a fact** in a strict-JSON registry — a `data/tools.json` or
  `data/projects.json` field edit. The canonical JSON case.
- **A project lead adding a project page** — a `data/projects.json` entry plus a
  `content/projects/<id>.md` body; the heaviest realistic case (two files, one PR).
- **Nathalie curating the People roster** — a live persona. *(Reconciled 2026-09-09:
  prerequisite **P-people** is **MET**. The People surface shipped in commit `15a3d91`:
  `data/people.json` + the About-page roster exist, `#/about` resolves, and the registry is
  validated by `check.py`'s §6c people validator — a dedicated section, deliberately kept out
  of the §4.0 `READER_REQUIRED_KEYS` dict. The original text carried this bullet as a
  *conditional* persona with a P-people prerequisite and fallback personas; that
  conditionality is now closed, and the People-specific items below — the `CONTRIBUTING.md`
  person template, the Phase D rehearsal choice — apply unconditionally.)*

**Access model (D1):** lab members contribute **from forks, with no write access** to the
repo. GitHub's web UI makes this invisible: clicking the pencil icon on any file prompts
"Fork this repository", then edit → Preview → Commit changes → **Propose changes** → Create
pull request, all in the browser (notebook q2 confirms this exact flow). Why fork-only:

- Only people with write access can merge or push; with zero write collaborators, the
  Kyle-gate on publishing is enforced by *permissions*, not just by policy. *(Reconciled
  2026-09-09: this permissions fact — plus the "done means merged" law — **is** the gate.
  The originally-planned branch-protection "belt-and-braces" layer, §6 G3, was declined, so
  no protection sits on top; none is needed, because non-writers simply cannot push.)*
- Contributors never deal with branches or clones unless they want to; the UI handles it.
- If a specific member later earns direct write access, that is a Kyle decision. *(It would
  reopen the branch-protection question §6 G3 settled as declined — that reopening is Kyle's
  call alone, not an agent's; nothing here re-proposes it.)*

**The no-edit path counts too:** anyone can file a content-fix **issue** (template in
Phase B: page URL + what is wrong + suggested wording) instead of a PR. For a genuinely
non-technical colleague, "report it, someone else edits it" is the lowest-friction
contribution, and it is the sanctioned route for the edits the web UI cannot safely make
(§3.1, "structural edits").

## 3. Contributor workflow (the happy path)

1. Contributor spots something to fix on the live site.
2. Finds the file via the **edit map** in `CONTRIBUTING.md` (a table: "what you want to
   change → which file"; canonical source stays `CLAUDE.md`'s edit map — §5's amendment
   records that relationship in the files themselves). Optional later phase: per-page
   "Edit this page on GitHub" links (§7, Phase E).
3. Pencil-icon edit in the GitHub web UI → auto-fork → Preview tab → Propose changes →
   Create pull request. The PR template (§5) pre-fills a short checklist.
4. **First-time contributors only:** the automatic check waits for Kyle to press
   **"Approve and run"** on the workflow (fork-PR safety default, §6 G1). CONTRIBUTING
   says so in plain words ("Kyle has to press a button before the robot check runs — this
   is normal, it is not you"), and pressing it is step zero of Kyle's review ritual.
5. CI runs `python3 tools/check.py` on the PR (§4). Red X = something to fix, with the
   check's actionable message (`file:line:col`, or the §4.0 required-key message) surfaced
   in the check **summary** on the PR page; the contributor fixes it with the same pencil
   editor, on the same branch. A two-file change (new project = entry + body) is
   *legitimately red between the two commits* — CONTRIBUTING warns that this is expected
   and says to commit both files to the same PR before asking for review.
6. Kyle reviews — Vercel's PR preview gives a rendered view where available (fork PRs may
   need Kyle's one-click authorization per PR, §6 G5; `./tools/serve.sh` on a local
   checkout is the fallback renderer) — then runs the **merge ritual** (§4.3): refresh the
   search shard *on the PR branch* if the advisory job says it is needed, then merge.
   Merge auto-deploys; one merge is one complete deploy.

### 3.1 What makes the dialect + strict JSON survivable for non-experts

Grounded in notebook q1/q6 (what actually kills docs-as-code for non-developers:
conceptual git overhead, brittle gates, raw-diff confusion, pedantic checks):

- **`CONTRIBUTING.md`** (written in the build phase, ≤ ~150 lines), structured per the
  notebook's onboarding findings: warm welcome; "no coding required" up front; the
  zero-setup web-UI path FIRST, local setup second; the human edit map; the two JSON rules
  that actually bite (**double quotes only, no trailing commas**) with a right/wrong
  example pair; the admonition/tabs copy-paste blocks; what not to touch (`js/`, `css/`,
  `tools/`, `search/`, `index.html`, `.github/`, vendored `marked.min.js`); the first-PR
  "Approve and run" wait (§3 step 4); the multi-file-red note (§3 step 5); "the only
  check that is yours is `check` — anything mentioning `search/` is the maintainer's";
  what happens after "Create pull request" (checks run, review comes — target
  acknowledgment within ~48 h, the threshold the research ties to contributors
  returning).
- **Structural edits are not web-UI edits.** `data/setup.json` is generated by
  `tools/rst_convert.py`, which rewrites it wholesale — a hand-added setup page would
  survive `check.py` yet be silently destroyed on the converter's next run. CONTRIBUTING
  therefore says plainly: *adding a brand-new setup page (or restructuring sections) is an
  issue, not a PR* — the maintainer runs the converter. Editing the *prose* of existing
  setup pages is always fair game.
- **Copy-paste templates, not prose rules**: a model `data/projects.json` repo entry, a
  model `data/tools.json` field edit, a model setup-page skeleton with one `adm-note` and
  one tab block, and — behind prerequisite P-people — a model People entry. Templates
  live inside `CONTRIBUTING.md` itself (one file to find, nothing new to serve).
- **Error messages contributors will actually see**: for JSON *syntax*, `check.py` already
  fails with located messages (`data/projects.json:41:7: Expecting ',' delimiter (strict
  JSON — no trailing commas, double quotes)`). §4.0 extends the same style to *structure*
  (missing keys) and guarantees no contributor ever sees a bare Python traceback. The CI
  workflow pipes the full output — stdout *and stderr* — into the PR check summary, so
  nobody opens the Actions tab (notebook q4).
- **Scope guardrail in review, not in tooling**: PRs that touch `js/`, `css/`, `tools/`,
  `index.html`, `search/`, or `.github/` are fine to *open* but the PR template asks
  contributors to flag it, and CODEOWNERS auto-requests Kyle on everything anyway.
  `.github/` matters specifically because `pull_request` workflows run from the PR head:
  a PR can carry a same-named but neutered `check` job that reports green — so Kyle's
  review reads any `.github/` or `tools/` hunk as *code*, not content (§5 ritual).

## 4. CI on every PR

### 4.0 Phase B0 — strengthen the gate before wiring it to PRs

Review's mutation tests proved two failure chains the current gate misses, both of them
the canonical "copied a template entry, dropped a field" mistake:

- a `data/projects.json` entry missing `"file"` → uncaught `KeyError` traceback on
  stderr (unreadable to a non-expert, and invisible to a summary that captures only
  stdout);
- an entry missing `"name"`/`"tagline"` → `check.py: all green`, merge, deploy →
  `undefined` rendered on the live project card, and the search-index rebuild then
  crashes with its own `KeyError`.

Phase B0 closes both, stdlib-only, in `tools/check.py` itself (strengthening, never
weakening):

1. **A reader-inputs pass** (widened twice in review — from "what the site reads" to
   "every reader input"). Two halves:
   - *Required keys per registry*, driven by a literal dict: every key that any of the
     three readers dereferences with `[]` — `js/app.js`, `tools/build_search_index.py`,
     **and `tools/check.py` itself** — across the enumerated registries:
     (all under `data/`): `projects.json`, `tools.json`, `setup.json`,
     `setup-structure.json`, `org-repos.json`, `old-docs-pages.json`,
     `search-probes.json`, `site.json` (the `data/` registry — not `search/site.json`),
     **`cad-tree.json`** (today never even parsed by the gate — round 3 proved a
     trailing comma there passes green; the full search rebuild's CAD shard dereferences
     its `repo` and `files`, so it is a real reader input even though the `--site-only`
     path skips it), plus the People registry under P-people. Failure message in the
     existing located style: `data/projects.json: projects[12] (id 'newproj') missing
     required key "name"`. *(Reconciled 2026-09-09: `data/people.json` did not land in this
     required-key dict after all — it shipped under `check.py`'s own §6c validator, a stricter
     dedicated section, and is a deliberate EXCLUSION from `READER_REQUIRED_KEYS`. The other
     registries listed here are covered exactly as planned; the 2026-09-09 audit confirmed the
     dict covers every non-excluded registry reader with zero holes.)*
   - *A fixed-path existence pass* for every hardcoded content path the readers open —
     today just `content/about.md` (round 3 proved deleting it passes green while the
     live `#/about` route 404s and the shard rebuild crashes) — same located style.
   Ordering: this pass runs immediately after the registry loads, *before* the
   cross-file consistency section — otherwise an existing bare dereference (e.g.
   `pr["file"]`) raises first and the wrapper prints the generic message instead of the
   located one the acceptance demands. It reports **only if the pass produced errors** —
   `if errors: report()`, the existing idiom at `check.py:57`. (Round 4 proved the
   unguarded form is a trap: `report()` with no errors prints `all green` and
   `sys.exit(0)`, silently skipping every cross-file check — a dead gate that passes
   all the mutation tests below, which is why test (e) exists.)
2. **A crash-proof wrapper**: `main()` runs under a top-level `except Exception` that
   converts any uncaught error into
   `check.py: internal error while validating — a malformed entry or a checker bug;
   details: <repr>` with exit 1 — a contributor never sees a bare traceback.

*Acceptance:* the six mutation tests below, re-run verbatim, produce located,
human-readable failures (and green on the unmodified repo).
*Verification:* `python3 tools/check.py` on the untouched repo still prints
`check.py: all green`; each mutation yields exit 1 with a located, traceback-free
message **on stdout**: (a) `projects.json` entry missing `"file"`; (b) `projects.json`
entry missing `"name"`+`"tagline"`; (c) `org-repos.json` entry missing `"name"`;
(d) `content/about.md` deleted; (e) — the short-circuit detector — a defect only a
*pre-existing cross-file check* catches (append a byte to `js/marked.min.js`, or drop
one probe from `search-probes.json`) must still exit 1, proving the new pass did not
terminate the run early and dead-end checks 2–8; (f) a trailing comma in
`data/cad-tree.json` must exit 1 with the located JSON-syntax message — the executable
proof that the one previously-unparsed registry actually entered the gate.

### 4.1 The one required check

`.github/workflows/check.yml` (written in the build phase):

- Triggers: `pull_request` and `push` to `main`.
- Runner: `runs-on: ubuntu-24.04` — pinned, not `ubuntu-latest`, so the interpreter under
  the required gate changes only by deliberate commit. A workflow comment states the job
  uses the image's system `python3` by design (stdlib-only script; no `setup-python`, no
  pip) and that bumping the image is a conscious edit.
- Steps: SHA-pinned `actions/checkout` → the gate, captured stderr and all, fenced so
  the located messages render as a code block instead of a run-on Markdown paragraph:

  ```
  set -o pipefail
  echo '```text' >> "$GITHUB_STEP_SUMMARY"
  set +e
  python3 tools/check.py 2>&1 | tee -a "$GITHUB_STEP_SUMMARY"
  rc=${PIPESTATUS[0]}
  set -e
  echo '```' >> "$GITHUB_STEP_SUMMARY"
  exit $rc
  ```

  (`pipefail` keeps the exit code; `2>&1` keeps stderr — without it, a crashing check
  would show a red X above an *empty* summary. The `set +e`/`PIPESTATUS` dance matters:
  GitHub's default `run:` shell is `bash -e`, which would abort on the failing pipeline
  and leave the summary's code fence unterminated — round 3 caught that the closing
  fence was dead code on exactly the failing runs it exists for.)
- Job name: `check` — globally unique across workflows (required-check gotcha, q3).

**The "no build tooling" ruling (D4, ratified by review).** This CI is compatible with the
repo law. The law's target is the *serving path* and the *local edit path*: nothing gets
built, nothing new must be installed, the deployed bytes remain identical to the repo. CI
is a remote reviewer running the gate command the repo already mandates before every
commit — it adds review, not tooling. Stated honestly: the workflow does introduce one
CI-side external input, the SHA-pinned `actions/checkout`; it never touches serving. The
rejected fallback — Kyle manually running `check.py` on every PR checkout — does not scale
past the first weeks and silently stops happening.

### 4.2 What CI deliberately does NOT check

- **No external-link checking in the required gate** — external downtime must never block
  a typo fix (q1/q4 are emphatic). `check.py` already validates internal `#/...` routes
  and asset references, which is the offline-only pattern the research recommends.
- **No prose/style linting (Vale, markdownlint).** Wrong cost/benefit for this repo:
  pedantic gates are the documented contributor-killer, and the site's dialect is already
  machine-checked where it matters. Revisitable later as a *non-blocking* annotation job
  if content volume ever justifies it.

### 4.3 Search-shard freshness (D2, revised in review)

Facts: `search/site.json` **and** `search/manifest.json` are rewritten by
`python3 tools/build_search_index.py --site-only` (plain python3, no graphify; the full
code reindex is out of scope). The rebuild is **deterministic** — no timestamps — so a
clean `git status` after a rebuild is a trustworthy "nothing to do". **The indexed
surface is: page title, H2–H4 headings, a first-paragraph excerpt, and (for projects and
tools) the tagline — never body prose.** Most prose fixes therefore legitimately need no
ritual at all; a stale shard matters when titles, headings, taglines, or pages themselves
change (new pages unfindable — a real navigation loss on a docs site), and breaks nothing
structurally.

Decision, two halves:

- **Contributors never rebuild the shard.** Web-UI contributors *cannot* run Python;
  making freshness a required check would block every typo fix behind a tool the
  contributor doesn't have — the "simple edit inflation" failure mode (q7), with
  derived-state curation belonging to the maintainer (q8).
- **The rebuild happens *before* merge, not after** (review's improvement — a post-merge
  ritual is forgettable and stale-shard drift is silent and cumulative). Kyle's merge
  ritual, when the advisory job says the shard changed:
  `gh pr checkout <n>` → `python3 tools/check.py` →
  `python3 tools/build_search_index.py --site-only` → commit the refreshed `search/` to
  the contributor's branch (fork PRs default to "Allow edits by maintainers") → push →
  **wait for `check` to report green on the new head commit (press "Approve and run"
  again if prompted — required checks re-run per commit)** → merge. One merge = one
  complete deploy; nothing to remember afterwards. **Fallback** when the contributor
  unchecked maintainer-edits: merge, then rebuild + push to `main` immediately — the old
  post-merge ritual, demoted to exception path.

Mechanism that tells Kyle whether the ritual applies: a **second, advisory (non-required)
job** in the same workflow, `search-shard-advisory`. Its behavior is pinned by
*mechanism*, not just outcome (rounds 2–3 — an unspecified exit is wrong in both
directions, and `bash -e` would turn a crashing rebuild into the forbidden red X): the
step swallows the rebuild's own exit status —

  ```
  if ! python3 tools/build_search_index.py --site-only >shard.log 2>&1; then
    echo "::warning::MAINTAINER: shard rebuild could not run on this PR (see the check job) — no action for the contributor"
    exit 0
  fi
  ```

  — and only on a successful rebuild checks `git status --porcelain search/` (catching
`manifest.json`, not just `site.json`), **always exiting 0**. When the tree changed it
emits a `::warning::` annotation (visible on the PR without a red X) plus a step-summary
line worded for the maintainer — `MAINTAINER: search shard refresh needed before merge —
no action for the contributor`. (Job-level `continue-on-error` is NOT a substitute: it
keeps the workflow green but the job's own check run can still surface as failed on the
PR.) It is never in the required-checks list; it is a detector, not a gate, and it must
never show a contributor a red X about a directory they were told not to touch — even on
a PR whose broken registry makes the rebuild itself crash (that failure is the `check`
job's to report). CONTRIBUTING states it plainly: *the only check that is yours is
`check`; anything mentioning `search/` is the maintainer's.*

## 5. Review and merge flow

- **CODEOWNERS** (`.github/CODEOWNERS`):

  ```
  *          @kyle-nelson-berkeley
  /.github/  @kyle-nelson-berkeley
  ```

  Its value here is **auto-requesting Kyle as reviewer** on every PR and signalling
  ownership of the scaffolding — *not* enforcement. *(Reconciled 2026-09-09: the
  "Require review from Code Owners" toggle discussion below is moot — there is no branch
  protection at all (§6 G3 declined), so there is no toggle to leave off. The reasoning still
  documents why code-owner enforcement would have been wrong here: with zero write
  collaborators it enforces nothing that permissions don't already, and GitHub never requests
  review from a PR's own author, so it would have deadlocked every PR Kyle opens himself into
  an admin-bypass. The CODEOWNERS **file** is kept purely for auto-request and ownership
  signalling.)* Per-section owners (e.g. Nathalie for People data) stay future work:
  a code owner without write access triggers nothing (q3 gotcha).
- **PR template** (`.github/pull_request_template.md`), short: what changed + why; which
  content type (setup page / project / tools / data registry); "I previewed my change
  with the Preview tab"; "this PR does not touch `js/`, `css/`, `tools/`, `index.html`,
  `search/`, or `.github/` (if it does, say why)"; screenshots for anything visual.
- **Issue template** (`.github/ISSUE_TEMPLATE/content-fix.md`): page URL + what is wrong
  + suggested wording — the §2 no-edit path.
- **Review**: Kyle merges. Active members (Nathalie, Vincent, Finn) review for content
  correctness informally in PR comments — no formal approval role while nobody holds
  write access. Aspiration, stated in CONTRIBUTING: first response within ~48 h. Kyle's
  ritual: (0) "Approve and run" on first-time contributors' workflow runs; (1) read the
  diff + rendered preview — and read any `.github/` or `tools/` hunk as *code*, since a
  PR-head workflow can redefine the gate that judges it (§3.1); (2) §4.3 shard ritual if
  the advisory job flagged it; (3) squash-merge.
- **Merge method**: squash-merge as the default (one site change = one commit on `main`;
  keeps the deploy history readable).
- **Branch protection on `main` — DECLINED (2026-09-06), never to be re-proposed.** Kyle
  ruled it out permanently: a lab member (ME) must never hit a blocked merge state, and with
  zero write collaborators the permissions layer plus "done means merged" already provides the
  Kyle-gate. `main` therefore carries **no** protection rule. *(The original plan specified
  one — require PR before merging with required approvals 0, require the `check` status check,
  code-owners toggle off, "Do not allow bypassing" left unchecked so Kyle's direct pushes keep
  working. That specification is preserved in §6 G3 as the declined design, for the record
  only. See §9 D1/D3.)*
- **`CLAUDE.md` amendment (part of Phase B, review finding) — shipped:** the law file gained
  a short "Contribution pipeline" section: CI runs `tools/check.py` verbatim on every PR;
  `.github/` is part of the law, not contraband to be tidied away; the one CI dependency is
  SHA-pinned `actions/checkout` (nothing in the serving or local path); `CONTRIBUTING.md` and
  `README.md` restate the edit map from `CLAUDE.md`, which stays canonical. The three edit-map
  copies **agree** (re-verified 2026-09-09). *(One residual: the `CLAUDE.md` clause framing a
  deleted workflow as blocking "all merges" on protected `main` assumes a branch-protection
  rule that was later declined; since `check` is not a required status check, that specific
  consequence does not apply today. Flagged for Kyle — this reconciliation does not edit the
  law file's branch-protection prose.)*

## 6. Kyle-gated repo-settings actions — exact manual steps

> **Reconciled 2026-09-09 — G3 (branch protection) is DECLINED (2026-09-06), permanently.** What remains
> live from this section is the Actions posture (G1) and the empty-collaborator policy (G4);
> G2a (make `check` a required status check) and G2b (fork rehearsal of the required-check
> flow) are **moot** because there is no required check, and G3 is kept below **only as the
> declined design, for the record**. Nothing here is to be performed as a to-do or
> re-proposed. Reopening branch protection is Kyle's call alone (§2, §9 D1/D3).

This plan performs none of these. Ordering (as originally written, rounds 2–3 fixed
sequencing bugs): **G0 + G1 happen BEFORE the Phase B push** (both are read/confirm steps —
the Actions posture must be right before the first workflow ever runs), then the Phase B
push, then G4. *(The original ordering threaded G2a → G3 through here; with G3 declined and
G2a moot, only G1 and G4 remain live.)* All are on the public repo
`kyle-nelson-berkeley/hippocampus-docs`; every feature below is free on public repos (q3).
GitHub's UI wording drifts; steps are written against the September-2026 UI, and each
*intent* line is what to preserve if buttons have moved.

**G0 — inventory the identities that write to `main` today** *(original intent: branch
protection must not silently break an existing write path. Reconciled 2026-09-09: with G3
declined there is no protection to break a write path, so this is now good hygiene only —
knowing who can push `main` — not a pre-flight for a protection rule.)*
1. Known writers at plan time: Kyle's own git credentials (admin — bypasses protections
   with D3's setting), and the **`hippo-site` MCP server** from the private
   `hippocampus-team-onboarding` repo, which agents use for site edits (`README.md`).
2. Before G3, note which identity the MCP server authenticates as. If it is Kyle's own
   PAT (acting as the admin account), nothing changes. If it is any other identity
   (machine account, GitHub App, deploy key), decide explicitly: re-authenticate it as
   Kyle, or route its writes through PRs. Do not apply G3 with this unresolved.

**G1 — confirm GitHub Actions posture** *(intent: workflows may run; fork-PR runs need a
conscious policy)*
1. Open `https://github.com/kyle-nelson-berkeley/hippocampus-docs/settings/actions`.
2. Under **Actions permissions**, select **"Allow all actions and reusable workflows"**
   (or the stricter owner-actions + allow-listed `actions/checkout@*` variant if offered —
   the tighter posture; the workflow needs nothing else).
3. Under **Fork pull request workflows** / **"Require approval for..."**: keep the
   default **"Require approval for first-time contributors"** *(intent: a stranger's
   first PR does not run code in our CI unattended; lab members' first PRs wait for
   Kyle's one-time "Approve and run" click — documented in CONTRIBUTING and in Kyle's
   review ritual, §5)*. Do NOT select "Require approval for all outside collaborators" —
   that would put the button on *every* PR from every lab member forever, not just their
   first.
4. Under **Workflow permissions**, select **"Read repository contents and packages
   permissions"** — the check workflow only reads. Leave "Allow GitHub Actions to create
   and approve pull requests" **unchecked**.
5. Click **Save** in each changed section.

**G2a — confirm the check has reported** — **MOOT (G3 declined):** selecting a required
status check only matters if there is a protection rule to attach it to, and there is not.
The `check` workflow still runs on every push and PR; it is simply never *required*. *(Kept
for the record: a required check can only be selected after it has reported at least once
— q3 gotcha — and the workflow's `push` trigger means the Phase B push to `main` produced
that first run.)*

**G2b — fork-PR rehearsal** *(intent: exercise the "Approve and run" flow and Vercel's
per-PR fork authorization — still relevant to the outside-contributor path even without a
required check; it is simply no longer tied to G3. Kyle cannot fork his own repo, so this
needs a lab member or second account)*
1. A non-collaborator account opens a probe PR **from a fork** — e.g. a one-word
   `README.md` edit via the web UI — Kyle presses "Approve and run" if prompted, and
   `check` reports on the PR. Close the probe PR unmerged if it was only a probe.

**G3 — add the branch protection rule — DECLINED 2026-09-06 (never performed, never to be
re-proposed).** Kyle ruled branch protection out permanently: a lab member must never hit a
blocked merge state, and the permissions layer plus "done means merged" is the gate. The
admin-bypass toggle the design below leaves unchecked is therefore **moot — there is no
protection to bypass; Kyle's direct push to `main` works because `main` has no branch
protection at all.** The steps below are retained **only as the declined design**, so that
`CLAUDE.md`'s cross-reference to "§6 G3" resolves to a coherent record — they are not a
to-do.

*(Declined design, for the record — do not execute.)* Original intent: no merge to `main`
without a PR and a green `check`; Kyle keeps admin bypass.
1. Open `https://github.com/kyle-nelson-berkeley/hippocampus-docs/settings/branches`.
2. Click **Add branch protection rule** (classic rules; if only the newer Rulesets are
   offered, mirror the same intent there).
3. **Branch name pattern**: `main`.
4. Check **Require a pull request before merging**. Set **Required number of approvals
   before merging** to **0**. Leave **"Require review from Code Owners" unchecked**
   (§5 — it would deadlock Kyle's own PRs and enforces nothing extra here). Leave
   "Dismiss stale pull request approvals when new commits are pushed" **unchecked**
   (q3: approval loops that punish contributors for fixing what review asked).
5. Check **Require status checks to pass before merging**. In the search box, add
   **`check`**. Leave **"Require branches to be up to date before merging" unchecked**.
   Do NOT add `search-shard-advisory` to the required list — it is advisory by design.
6. Leave **"Do not allow bypassing the above settings" unchecked**.
7. Confirm **Allow force pushes** and **Allow deletions** are **unchecked** (defaults).
8. Click **Create** (or **Save changes**).
9. **Immediately verify both live write paths** (rollback is deleting the rule):
   Kyle direct-pushes a trivial commit to `main` (must succeed), and — per G0 — an
   `hippo-site` MCP write to `main` is exercised (must succeed, or its decided
   re-routing is applied before walking away).

**G4 — collaborator policy** *(intent: the merge gate is a permissions fact, not a habit)*
1. Open `https://github.com/kyle-nelson-berkeley/hippocampus-docs/settings/access`.
2. Verify the collaborator list is empty (Kyle as owner only). Adding any collaborator
   with write access is a future Kyle decision and reopens D1/D3 of this plan.

**G5 — nothing else changes.** GitHub Pages and Vercel configuration stay untouched.
Vercel will create preview deployments for PR branches; for fork PRs it may require a
one-time authorization per PR before building the preview — that button is Kyle's, treat
it as part of review (the repo holds no secrets, but authorizing is still a conscious
act). Where no preview exists, `./tools/serve.sh` on the checked-out PR branch is the
rendered fallback.

## 7. Explicitly NOT built

- **No hosted CMS, no database, no Node, no build pipeline, no new dependencies** — in
  the repo, in CI beyond SHA-pinned `actions/checkout`, or on any contributor machine.
- **No git-based CMS admin UI (Decap/Sveltia) in v1 — flagged alternative, default NO,
  Kyle-gated.** The notebook research (q5) is direct about when such an admin is *not*
  worth it, and this repo is the textbook case: a zero-build vanilla static site with
  low edit velocity and no dedicated platform owner. The honest cost accounting if Kyle
  ever wants it: the admin app itself is CDN-served static files (compatible with
  zero-build serving), **but** it requires (a) a GitHub OAuth gateway — a serverless
  function or third-party auth service, i.e. a real new dependency with a secret to
  manage; (b) a `config.yml` content schema that must be hand-maintained in lockstep
  with the registries; and (c) it cannot express `check.py`'s cross-file rules (repo
  coverage, parity, orphan checks), so it can happily produce edits the gate rejects —
  the worst contributor experience of all. Revisit only if several non-technical editors
  are contributing weekly and the web-UI path has measurably failed them.
- **No external-link checker, no prose linter** in the required gate (§4.2).
- **No bot that auto-commits search shards to PR branches** — fork-PR token mechanics
  make it fragile; §4.3's maintainer pre-merge ritual covers it with zero automation.
- **No changes to `content/`, `data/`, `js/`, `css/`, `index.html`** in the CMS build
  itself. Two scoped exceptions, each named: Phase B0 edits `tools/check.py`
  (strengthening only), and Phase E — optional, separately gated — would edit
  `js/app.js`.

## 8. Phases — acceptance criteria and verification each

Build happens via `/plan-implement` (or `/review-implement`) when Kyle says build; each
phase is a small, separately verifiable change. Local commits throughout; **every push
deploys, so `check.py` must be green before every push.** *(Reconciled 2026-09-09: under
"done means merged", Kyle's own agents push `main` directly with his identity rather than
waiting on Kyle — the deploy consequence is unchanged, but the gate is the green `check.py`,
not a Kyle sign-off.)*

- **Phase B0 — harden `tools/check.py`** (§4.0; runs first — the gate must be
  trustworthy before PRs rely on it).
  *Acceptance:* §4.0's reader-inputs pass exactly as specified there — required keys for
  every key any of the three readers (`js/app.js`, `build_search_index.py`, `check.py`
  itself) dereferences, across §4.0's enumerated registry list including
  `cad-tree.json`; the fixed-path existence pass (`content/about.md`); the stated
  ordering with the **guarded** report — `if errors: report()`, never an unconditional
  call (which would exit 0 early and dead-end checks 2–8); crash-proof top-level
  wrapper; messages in the existing located style.
  *Verification:* §4.0's six mutations verbatim — untouched repo still prints
  `check.py: all green`; (a) `projects.json` entry missing `"file"`, (b) `projects.json`
  entry missing `"name"`+`"tagline"`, (c) `org-repos.json` entry missing `"name"`,
  (d) `content/about.md` deleted, (e) a cross-file-only defect (tampered
  `js/marked.min.js` or a dropped search probe) proving the run was not short-circuited,
  (f) a trailing comma in `data/cad-tree.json` — each exits 1 with a located,
  traceback-free message on stdout.
- **Phase A — contributor docs.** Write `CONTRIBUTING.md` (root), per §3.1: welcome,
  zero-setup web-UI walkthrough (pencil → fork → Preview → Propose changes → PR,
  including the first-PR "Approve and run" wait), human edit map, JSON right/wrong pair,
  dialect copy-paste blocks, multi-file-red note, structural-edits-are-issues rule,
  do-not-touch list, what-happens-next + ~48 h aspiration, local `serve.sh`/`check.py`
  section for the technically inclined. People template only if P-people (§2) is met.
  *Acceptance:* every persona in §2 (with P-people applied or substituted) has a worked
  example; no new files beyond `CONTRIBUTING.md`.
  *Verification (review-hardened, made mechanical in round 2):* a cold agent gets
  `CONTRIBUTING.md` **alone** — no repo access, no web — and must output, per persona:
  the exact repo-relative file path(s) to edit, the exact JSON keys a new entry needs,
  and the exact raw-HTML wrapper for an admonition — **each answer with a verbatim
  quote of the `CONTRIBUTING.md` line it came from**. An answer that is correct but
  uncited counts as a prior-guess and FAILS (several paths are guessable from
  convention; only citation proves the document carries the fact). Pass only if every
  repo-specific answer is cited and matches the repo (checked against the actual files
  afterwards).
- **Phase B — `.github/` scaffolding + law amendment.** `workflows/check.yml` (required
  `check` job + `search-shard-advisory` job, §4), `CODEOWNERS`,
  `pull_request_template.md`, `ISSUE_TEMPLATE/content-fix.md`, and the `CLAUDE.md`
  "Contribution pipeline" section (§5).
  *Acceptance:* YAML minimal (pinned `ubuntu-24.04`, SHA-pinned checkout, the two python3
  invocations with `2>&1` + `pipefail` + fenced step summary); job names unique;
  edit-map agreement defined precisely (round 2): `CLAUDE.md`'s map is canonical and a
  **superset** — every row in `README.md` and `CONTRIBUTING.md` must match a canonical
  row exactly; the amendment adds the currently missing Home/About row
  (`data/site.json` / `content/about.md`) to `CLAUDE.md` as part of this reconciliation.
  *Verification:* `check.py` green locally; after Kyle's gated push, the workflow runs
  green on `main`; an induced-failure probe PR (deliberate trailing comma in a JSON
  registry, made via the web UI) shows a red `check` whose step summary contains the
  located message; a second induced failure (missing required key) shows the §4.0
  message the same way; both flip green when fixed in the same PR.
- **Phase C0 — pre-push settings check (Kyle).** Execute §6 G0 + G1 *before* the Phase B
  push: inventory the `main`-writing identities and set the Actions posture, so the very
  first workflow run happens under the intended policy.
  *Acceptance:* G0's identity question answered and recorded; G1's radio buttons match §6.
  *Verification:* screenshots or a settings read-back match the G1 selections.
- **Phase C1 — post-push settings (Kyle).** *(Reconciled 2026-09-09: with G3 declined and
  G2a moot, this reduces to §6 G4 — confirm the collaborator list is empty — plus, optionally,
  G2b's fork rehearsal when a second identity is available to exercise "Approve and run" and
  Vercel's per-PR fork authorization.)*
  *Acceptance:* collaborator list clean (Kyle as owner only).
  *Verification:* a probe PR **from a fork** reaches a reported `check` (after at most one
  "Approve and run" click); non-writers cannot merge because they have no write access
  (permissions, not a protection rule); Kyle's direct push to `main` works because `main`
  carries no protection. *(The original C1 verified a "Required — check" merge box and a
  bypass-warning state — both artifacts of the declined branch-protection rule, so neither is
  observable today.)*
- **Phase D — end-to-end dress rehearsal.** One real lab member goes pencil-to-merged
  with no help beyond `CONTRIBUTING.md` — a People-roster edit if P-people is met,
  otherwise a setup-page prose fix — while Kyle exercises "Approve and run", review,
  the §4.3 pre-merge shard ritual, merge, and deploy. Timing note (review finding): the
  site is still `noindex` staging until the org cut-over decision; run Phase D after
  cut-over, or frame it to the volunteer explicitly as a staging rehearsal so their
  goodwill is spent knowingly.
  *Acceptance:* the PR merges and deploys; the advisory job's verdict was obeyed.
  *Verification (restated in round 2 so it is always evaluable — a prose fix touches no
  indexed field and produces no shard change, which is success, not failure):* the live
  site shows the change; **the advisory verdict was obeyed** — if it flagged `search/`,
  a local `--site-only` rebuild on merged `main` leaves `git status --porcelain search/`
  clean; if it did not flag, no ritual was needed and none was performed. To exercise
  the ritual deliberately, pick a rehearsal edit that touches an indexed field (a page
  title or H2, or a project/tool tagline). The contributor's friction points are filed
  as issues against `CONTRIBUTING.md` and fixed in a follow-up PR.
- **Phase E (optional, default-deferred) — "Edit this page" links.** A small `js/app.js`
  footer link per rendered page to the file's GitHub edit URL, killing the
  find-the-file problem at the root.
  *Acceptance/verification:* defined when Kyle green-lights it; it is a site-code change
  and goes through this same PR + check pipeline like any other edit.
- **Phase F (optional, default NO) — static admin UI.** Only per §7's revisit trigger,
  and only via a fresh plan with its own review.

**Routing note:** when Kyle says build, this consensus plan is the input to
`/plan-implement`; C0 is Kyle's five-minute pre-flight, phases B0+A+B are one
implementation session, C1 is Kyle's manual settings batch, D needs a volunteer and a
merge window.

## 9. Decisions

| # | Decision | Call |
|---|---|---|
| D1 | Contributor access model | Fork-based PRs, zero write collaborators; **permissions + "done means merged" ARE the gate.** Branch protection (originally "belt-and-braces") **DECLINED 2026-09-06** — a lab member must never hit a blocked merge state |
| D2 | Search-shard freshness | Advisory CI detector + Kyle's **pre-merge** refresh on the PR branch (post-merge push only as fallback); never a required check, never contributor-owned |
| D3 | Admin bypass on `main` | **MOOT (branch protection declined 2026-09-06)** — there is no protection rule to bypass; Kyle's direct push to `main` works unconditionally. G0's MCP-write-path inventory remains good hygiene but has no rule to verify against |
| D4 | CI vs "no build tooling" law | Compatible: CI reviews, serving stays byte-identical; one named CI-side input (SHA-pinned checkout); `CLAUDE.md` amended so future agents read the workflow as law |
| D5 | Code-owners enforcement toggle | **MOOT (no branch protection, so no toggle)** — the CODEOWNERS **file** is kept for auto-request/signalling; the reasoning (the toggle would deadlock the sole maintainer's own PRs) is why enforcement was never wanted here |
| D6 | Gate trustworthiness | Phase B0 hardened `check.py` (required keys + crash-proofing) before any PR relied on it; a 2026-09-09 re-audit confirmed the `READER_REQUIRED_KEYS` pass covers every registry reader with zero silent holes |

## Appendix — review changelog (what the /plan-review debate changed)

- **Gate hardening (Phase B0, D6)** — reviewer's mutation tests proved missing-key
  entries either crash `check.py` (bare traceback) or pass green and break the deployed
  page + shard rebuild. Accepted: required-key pass, crash-proof wrapper, `2>&1`/
  `pipefail` in the CI step. *(blocking → resolved)*
- **People persona made conditional (P-people)** — the People surface is in-flight in a
  parallel session and absent at base; all People-specific items now carry an explicit
  prerequisite with named fallbacks. *(major → resolved)*
- **Fork-PR workflow approval** — first-time contributors' CI waits for "Approve and
  run"; policy chosen in G1, documented for contributors and in Kyle's ritual; fork-based
  probes added to G2/Phase C. *(major → resolved)*
- **`hippo-site` MCP write path** — G0 inventories main-writers; G3 verifies both live
  paths before leaving the settings page. *(major → resolved)*
- **Phase A verification hardened** — cold agent gets the doc alone and is scored on
  repo-specific facts (paths, keys, dialect), not GitHub priors. *(major → resolved)*
- **Code-owners toggle dropped (D5)** — enforces nothing under D1 and deadlocks Kyle's
  own PRs into bypass habit; CODEOWNERS file kept for auto-request. *(major → resolved)*
- **`CLAUDE.md` amendment in Phase B (D4)** — so future agent sessions read `.github/`
  as law, the checkout dependency is named, and the three edit-map copies declare
  `CLAUDE.md` canonical. *(major → resolved)*
- **Advisory job watches `search/` directory** (manifest.json too) and the rebuild's
  determinism is stated. *(minor → resolved)*
- **Shard refresh moved pre-merge** onto the PR branch via maintainer edits; post-merge
  push demoted to fallback. *(minor → resolved)*
- **Multi-file-red note + structural-edits-are-issues rule** added to CONTRIBUTING
  (web UI commits one file at a time; `rst_convert.py` rewrites `data/setup.json`
  wholesale). *(minor → resolved)*
- **Runner pinned to `ubuntu-24.04`** with the system-python rationale in a comment.
  *(minor → resolved)*
- **Issue path added** (content-fix template) and Phase D retimed/reframed around the
  org cut-over. *(minor → resolved)*

Round 2 (fresh Opus reviewer, re-verified round-1 resolutions by mutation test, raised
nine new findings; all accepted):

- **B0 key derivation widened to all three readers** — `check.py`'s own bare
  dereferences (e.g. `org-repos.json` `"name"`) were outside the rule; registries now
  enumerated; third mutation test added. *(major → resolved)*
- **Phase D verification made always-evaluable** — the shard indexes only
  title/headings/excerpt/tagline, so a prose fix rightly produces no shard change; the
  check is now "the advisory verdict was obeyed", with an indexed-field edit named for
  deliberately exercising the ritual. *(major → resolved)*
- **Advisory job behavior pinned** — always exits 0, `::warning::` annotation +
  maintainer-worded summary; contributors are told the only check that is theirs is
  `check`. *(major → resolved)*
- **`.github/` added to every scope list** and Kyle's ritual reads `.github/`/`tools/`
  hunks as code — a PR-head workflow can carry a same-named neutered `check` that
  reports green. *(major → resolved)*
- **Settings sequencing fixed** — C0 (G0+G1) before the Phase B push; G2's duplicated
  push instruction removed. *(minor → resolved)*
- **Merge ritual waits for `check` on the new head** before merging. *(minor → resolved)*
- **Edit-map agreement defined** — `CLAUDE.md` canonical superset, exact row matches,
  Home/About row added during reconciliation. *(minor → resolved)*
- **Step summary fenced** as a code block so located messages stay readable.
  *(minor → resolved)*
- **Phase A citations required** — an uncited correct answer counts as a prior-guess
  and fails, making the sufficiency test mechanical. *(minor → resolved)*

Round 3 (fresh Opus reviewer, verified the round-2 fold-in, raised six new findings;
all accepted):

- **§8 Phase B0 synced with §4.0** — the phase block still carried the pre-widening
  rule and two mutations; an implementer building from §8 would ship the disproven
  narrow rule. Plus the in-file ordering sentence (pass + `report()` before the
  cross-file section, so located messages actually win over the wrapper).
  *(major → resolved)*
- **B0 widened from keys to reader inputs** — `cad-tree.json` was never parsed by the
  gate at all (trailing comma passes green) and a deleted `content/about.md` passes
  green while the live route 404s; both now covered, fourth mutation added.
  *(major → resolved)*
- **Advisory job pinned by mechanism** — under `bash -e` a crashing rebuild turned the
  advisory job red on exactly the PRs where the contributor is most confused; the step
  now swallows the rebuild's exit and warns, with `continue-on-error` explicitly
  rejected as a substitute. *(major → resolved)*
- **Phase C1 verification restated as observable facts** — "merging without green is
  impossible" was true for no one (Kyle sees the bypass button by D3 design; everyone
  else lacks write). *(minor → resolved)*
- **G2 split into G2a/G2b** — the push-to-`main` run already makes `check` selectable,
  so protection no longer waits on a fork probe Kyle cannot create alone.
  *(minor → resolved)*
- **Step-summary snippet made `bash -e`-safe** — `set +e`/`PIPESTATUS` so the closing
  fence survives failing runs. *(minor → resolved)*

Round 4 (fresh Opus reviewer, executed the round-3 snippets under `bash -e` and
implemented the B0 ordering sentence literally on a scratch copy; one major + two
minors, all accepted; everything else verified clean under execution):

- **B0's `report()` call guarded** — the round-3 ordering sentence, implemented
  literally, produced a silently dead gate: `report()` with zero errors prints
  `all green` and exits 0 before checks 2–8, and all four mutations still passed.
  Fixed to the existing `if errors: report()` idiom, and mutation (e) — a
  cross-file-only defect that must still fail — added as the short-circuit detector.
  *(major → resolved)*
- **Registry enumeration disambiguated** (`site.json` means the `data/` registry) and
  the `cad-tree.json` justification corrected (the *full* rebuild's CAD shard reads it;
  `--site-only` does not). *(minors → resolved)*

Sign-off round (fresh Opus reviewer, fifth and final; implemented §4.0 verbatim on a
scratch copy, ran all five mutations AND the counterfactual with the guard removed —
proving mutation (e) really detects the dead gate — then verified every load-bearing
repo fact): **"I agree this plan is sound."** Two minors folded in rather than dropped:
the grounding paragraph's finding count refreshed, and mutation (f) added so
`cad-tree.json`'s coverage has an executable acceptance behind it (a trailing comma
there passes green today; after B0 it must fail with the located syntax message).
Final tally: 32 accepted findings, zero rejected, zero escalated.
