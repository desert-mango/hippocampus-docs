## What it is

The lab's public reference: setup guides, a map of every organization repository,
in-browser search over documentation and code, and the tools that keep those views in
step. The site is served directly from committed files with no framework or build step.

## The pieces

- **This site** — the current public documentation, project registry, knowledge graph,
  search index, and offline validation gate.
- **`docs`** — the earlier Sphinx documentation that supplied the Setup section. Its
  page-for-page migration record is preserved with the site tooling.
- **`hippocampusrobotics.github.io`** — the organization website.
- **`.github`** — the org profile readme shown on GitHub.

## Where it stands

This zero-build site is live at
[hippocampus-docs.vercel.app](https://hippocampus-docs.vercel.app). Its offline gate checks
registry coverage, content links, search probes, graph parity, contributor projections,
and vendored-source integrity before a change is published. Migrated setup pages retain
their earlier Sphinx source notes.
