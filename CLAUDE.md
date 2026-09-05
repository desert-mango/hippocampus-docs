# hippocampus-docs — agent operating rules

Zero-build static site. There is NO build step: what you edit is what serves.

## The one law

Run `python3 tools/check.py` after every change; it must print "all green" before any
commit. When images, `data/cloudinary-manifest.json`, or people-card links changed, ALSO
run `python3 tools/check_urls.py` (the network half of the gate — it probes exactly those
URLs; check.py stays offline) and it must pass. Never weaken a check to pass it — fix the
content it complains about.

## Edit map

- Setup page prose: `content/setup/<group>/<page>.md` (Markdown; raw-HTML wrappers
  `<div class="adm adm-note">`/`<div class="tabs">` are part of the dialect).
- Setup structure: prefer re-running `tools/rst_convert.py` over hand-editing
  `data/setup.json` (the converter also regenerates `docs/setup-parity.md`). The converter
  reads `data/cloudinary-manifest.json`: images with a manifest entry are emitted as
  Cloudinary URLs (the site serves images from the CDN; local `assets/` files are the
  upload sources); an image without an entry is listed loudly at the end of the run and
  must be uploaded before commit.
- Images: hosted on Cloudinary (folder `hippocampus-docs/`), mapped in
  `data/cloudinary-manifest.json`. Upload via the cloudinary-upload skill from the
  portfolio repo (credentials live there), add the manifest entry, reference the manifest
  URL. Local originals stay in `assets/` as sources. Exceptions that stay local:
  `assets/hippo.svg` (brand mark) and the `.stl`/`.3mf`/`.pdf` downloads.
- Projects: facts in `data/projects.json` (strict JSON), prose in
  `content/projects/<id>.md`. Coverage rule: every org repo in exactly one project.
- Tools: `data/tools.json` + `content/tools/<id>.md`.
- People roster (About page cards): `data/people.json` — a card is name, title, optional
  photo (a manifest URL), optional link; link decisions are recorded in
  `docs/people-links.md`. Cards without a link get no hover affordance.
- Home/About: `data/site.json` (home cards, kicker, lead) / `content/about.md` (About
  page prose; the People roster mounts inside it).
- After content changes, refresh the site search shard:
  `python3 tools/build_search_index.py --site-only` (plain python3; the full code
  reindex needs clones + graphify — see the script header).

## Contribution pipeline

- CI runs `python3 tools/check.py` VERBATIM on every pull request and every push to
  `main` (`.github/workflows/check.yml`, job `check`) — never a copy, never a weakened
  variant. A second job, `search-shard-advisory`, is a maintainer-only detector and is
  never a required check.
- `.github/` is part of the law, not contraband to tidy away: deleting or renaming the
  workflow leaves the required `check` status permanently "expected" on protected
  `main` and blocks ALL merges. Treat any `.github/`, `tools/` or `api/` diff as code
  review, not content review — a PR-head workflow can redefine the gate that judges it.
- The ONE CI-side external input is the SHA-pinned `actions/checkout` step. Nothing new
  enters the serving path or any contributor's local path; the deployed bytes stay
  byte-identical to the repo.
- The edit map above is CANONICAL. `CONTRIBUTING.md` restates it for humans and
  `README.md` carries a shorter table; when the map changes, reconcile those copies to
  this one — never the other way around.
- `tools/check.py` carries a required-keys dict (reader-inputs pass,
  `READER_REQUIRED_KEYS`). The rule has four parts: a new bare key dereference in
  any file that reads a `data/*.json` registry (today: `js/app.js`, `js/graph.js`,
  `tools/bench_librarian.mjs`, `tools/build_contributors.py`, `tools/build_repo_graphs.py`,
  `tools/build_search_index.py`, `tools/build_wiki_graph.py`, `tools/check.py`,
  `tools/check_urls.py`, `tools/rst_convert.py` — re-derive the list with
  `grep -rln "data/[a-z_-]*\.json" . --exclude-dir=.git --exclude-dir=data --exclude-dir=search`)
  gains a `keys` entry; a new list a reader ITERATES gains a `lists` entry (or an `each` entry
  when its items are objects) — this is the part that fails silently when forgotten,
  because a string in a list's place is an iterable of characters, not a type error;
  a nested object a reader dereferences into gains an `objects` entry (its child spec
  covers the inner keys); and a value gets a `types`/`str_lists` entry ONLY when a reader crashes on the
  wrong type or is silently wrong about it (the string `"false"` is truthy) — never
  as a general string-ness check on titles and names. A new `data/*.json` registry
  gets its own block (registries with their own dedicated section — the Cloudinary
  manifest, the People roster, everything under `data/graph/` — are listed as
  exclusions in its comment).

## Hard rules

- No credentials, key material, or personal emails in content — check.py enforces;
  placeholders look like `<yours>`.
- No new dependencies, no npm, no build tooling. Vendored marked stays sha256-pinned.
- Preview: `./tools/serve.sh` → http://localhost:8130 (file:// cannot fetch content).
- **Done means merged.** Work is not done until it is safely merged into `main` and
  pushed. Kyle is the sole or primary contributor of this project (true of every project
  so far, this one included), so an agent working for Kyle integrates through the
  git-worktree ownership gate and pushes `main` itself at task completion — it does not
  wait for Kyle. Every push deploys the site (Vercel + Pages), so `python3 tools/check.py`
  must be green in the integration worktree first; that gate stays. A verified task
  branch left unmerged "waiting on Kyle" is stranded work, not done work: say "stranded,
  not done" and list the unmerged commits.
  - Two paths, by who is pushing. Outside contributors and lab members use the
    pull-request pipeline above (`.github/`, `CONTRIBUTING.md`) and never push `main`.
    Kyle's agents push `main` with Kyle's own identity, which the branch-protection
    design in `docs/cms-plan.md` §6 (G3: admin bypass kept, Kyle's direct push verified)
    deliberately leaves able to push directly. If that bypass is ever removed, an agent's
    path becomes "open the PR, get `check` green, merge it" — done still means merged,
    never "PR opened".
  - The one exception: when Kyle is a small contributor to someone else's project, an
    agent never pushes that project's `main`; it opens a pull request against it
    instead. No project has been in that mode yet, so before using it an agent must
    verify which mode applies (repository ownership and share of commit authorship,
    e.g. `git shortlog -sne origin/main`) and say what it checked.
