<div id="people-root"></div>

# About this site

This is the documentation home of the **HippoCampusRobotics** lab at TUHH's Institute of
Mechanics and Ocean Engineering. It brings four things into one place: setup guides
(migrated page for page from the old Sphinx site), the team's projects (every repository
in the org, grouped and explained), an in-browser search over code and CAD, and
documentation for the lab's agent tools.

## How it is built

- **Zero-build static site.** Plain HTML, CSS, and JavaScript — no framework, no npm,
  no build step. The only vendored library is `marked` v12.0.2 (MIT) for Markdown.
- **Content is data.** Pages are Markdown under `content/`; structure lives in strict-JSON
  registries under `data/`. Editing a page means editing one file and refreshing.
- **A check gate, not good intentions.** `python3 tools/check.py` validates the registries,
  the content files, internal links, image references (against the Cloudinary manifest),
  and the projects-coverage rule (every org repo accounted for). Run it before every
  commit; when images, the image manifest, or people-card links changed, also run
  `python3 tools/check_urls.py` — the network half of the gate, probing exactly those URLs.
- **Images from a CDN.** Images are served from Cloudinary; the mapping (and the upload
  sources kept under `assets/`) lives in `data/cloudinary-manifest.json`.
- **Preview** with `./tools/serve.sh` and open <http://localhost:8130/>.
- **Search** starts from a precomputed, static index shipped with the site — the keyword
  search needs no server and no API keys. Code symbols come from AST extraction over the
  org's repositories; CAD parts from the canonical CAD repo's file tree. On the Vercel host,
  multi-word queries are also answered by the librarian: a free model that walks the site's
  own knowledge graph and adds the pages, repositories, code symbols and CAD parts the
  keywords missed, each with a one-line reason. When it is unreachable or out of free
  requests for the day, the keyword answer stands.

## Provenance

- Setup pages carry a footer linking the exact old-site page they were migrated from.
  The migration mapping and the dropped-page list (deprecated ROS 1 content) are in
  `docs/setup-parity.md`.
- Project pages are grounded in the repositories' own READMEs and metadata; the coverage
  table is enforced by the check gate.
- This site supersedes the learning-to-swim story site as the team record; the org
  cut-over (replacing the old docs site's URL) is a team decision, made separately.

## Editing

Small fixes: edit the Markdown, run the check, commit. New setup pages: add the file under
`content/setup/<group>/` and a manifest entry in `data/setup.json`. New projects: add the
entry in `data/projects.json` and a body in `content/projects/`. The check gate will tell
you what is missing — its failure messages are written to be followed.
