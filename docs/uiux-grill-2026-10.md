# UI/UX grill — October 2026

Findings from a page-by-page walk with Kyle (live site, 2026-10-21). Each line: id · route ·
what Kyle dislikes · fix direction · desktop/phone · priority (P1 high, P3 low).

Design skills (researched, `~/.claude-os/runs/2026-10-21-1637-hippocampus-uiux-grill/artifacts/uiux-skills.md`):
taste-skill · emil-design-eng · web-design-guidelines · wcag-accessibility-audit · nielsen-heuristics-audit.

## Routes walked

| Route | Findings |
|---|---|
| `/` home | H1–H5 |
| `#/search` | S1–S6 |
| `#/setup`, `#/setup/getting-started/px4-setup` | P1–P11 |
| `#/projects`, `#/projects/hippocampus-vehicle` | J1–J12 |
| `#/tools` | T1 |
| `#/team` | M1–M17 |
| unknown route, theme | E1–E2 |
| phone (375px): `/`, setup page | F1–F6 |
| header search, note boxes (site-wide) | G1–G2 |
| Editor mode | NOT YET WALKED — continued in a separate session (see below) |

## Findings

### Home (`/`)
- H1 · `/` · Team card sits alone on a second row (4 cards in a 3-col grid) · balance the grid (4 across, or 2×2) · desktop · P2
- H2 · `/` footer · "HippoCampusRobotics lab documentation · staging": missing space, stale "staging", repeats "Sign in to edit" · fix the text, drop "staging", one sign-in entry · both · P2
- H3 · `/` · too many example chips (7, uneven 5+2 rows) · fewer chips, one even row · both · P2
- H4 · `/` · lead text reads like a spec sheet · shorter, plainer lead · both · P2
- H5 · `/` · hero is plain: no vehicle visual · add a vehicle image/visual to the hero, keep search as the front door · both · P1
- Overall: right feel, small fixes (not a restyle).

### Search (`#/search`)
- S1 · search · multi-word queries fail: placeholder example "how do I flash PX4" and the "flash PX4" chip return nothing; "PX4" alone gives 40 · keyword search matches any/most words, ranked · both · P1 (functional)
- S2 · search · librarian `POST /api/librarian` returns 502 on live ("the librarian is unreachable") · find the cause and fix (env key? model? timeout?) · both · P1 (functional)
- S3 · search results · pages buried among code symbols/files · group or tab results (Pages / Code / CAD), pages first · both · P1
- S4 · search results · raw Markdown in snippets ("**not**") · strip/render Markdown in snippets · both · P2
- S5 · search no-results · dead end · suggestions (chips, nearest pages, "ask the librarian") · both · P2
- S6 · search results · bland list · type badges/icons, highlighted match words · both · P2

### Setup pages (`#/setup/...`)
- P1 · setup page · no "On this page" heading list on long pages · add a right-side table of contents (sticky, current heading marked; folds away on phone) · desktop · P1
- P2 · setup page · long code lines cut off (sideways scroll); copy buttons only on hover · wrap or clearly signal overflow; copy button always visible · both · P1
- P3 · setup page · text column feels narrow with empty space on the right (at an ~800px pane) · use the space (the TOC from P1 fills it on wide screens); keep the 80%/110rem shell rule unless Kyle says otherwise · desktop · P2
- P4 · all pages · floating "Sign in ×" box stays pinned over the content while scrolling · move sign-in into the header (one quiet button), no floating box for readers · both · P1
- P5 · sidebar · 71 links all open · collapsible groups, only the current group open · both · P1
- P6 · sidebar · duplicate names ("Pre-built Packages", "Quality-of-Life Features" twice) · disambiguate labels in the sidebar (e.g. show the group) · both · P2
- P7 · sidebar · tiny gray caps group labels hard to scan · stronger group headings · both · P2
- P8 · `#/setup` intro · mentions `docs/setup-parity.md` (internal) · drop the repo-file sentence (content edit) · both · P3
- P9 · setup page · prev/next links weak · card-style prev/next buttons with labels · both · P2
- P10 · setup page · no "last updated" / author info · show last-updated date (and who-wrote-this if the GitHub layer has it) · both · P2
- P11 · (also H) · see P4: Kyle now dislikes the sign-in box too

### Projects (`#/projects`, `#/projects/<id>`)
- J1 · project page · story text crushed to ~130px beside the repo column; a link overflows into the repos · two columns only when there is room, else repos move below the story (or a fold-out "Repositories (n)") · desktop narrow + phone · P1
- J2 · projects list · 17 tall cards in one column · 2–3 column grid and a status filter (Active / Maintained / Legacy) · desktop · P1
- J3 · projects list · monospace repo-name chips + "+5 more" on every card are clutter · drop or reduce (e.g. "12 repositories") · both · P2
- J4 · projects · no pictures · a thumbnail/image per project where one exists (Cloudinary manifest), tasteful fallback otherwise · both · P2
- J5 · project page repo cards · "★ 0 · 0 issues · pushed 2021-03-04" and "not in the org snapshot" tags are low-value noise · quieter cards: name, one-line purpose, language; detail on hover or omitted · both · P2
- J6 · projects list · left sidebar duplicates the cards · hide the sidebar on the list page; keep it inside project pages · desktop · P2
- J7 · project page right column · empty "REPOSITORIES" heading, then "HARDWARE" and "SEE ALSO" lists in the same column · hide empty headings; clear sub-sections · both · P1
- J8 · projects · "Learning to Swim: simulation run guide" listed as its own project · it belongs inside the Learning to Swim project (a guide/sub-page), not the project list or sidebar · both · P1 (`data/projects.json` change)
- J9 · project pages · "Who wrote this" with "PR #5 by Kyle Nelson: closed" and the "From git history…" fine print is noise · remove the section (as on Team, M15), or reduce to one quiet line · both · P2
- J10 · project page · wall of text, no visuals · hero image/video where available (Cloudinary), figures inline · both · P1
- J11 · project page first screen · show: hero image/video, a key-facts row (status · people · # repos · last activity), "who to ask" faces (open the M5 profile popover), and 1–3 "start here" setup links · both · P1
- J12 · projects list · grouped sections (Vehicles, Software, Research, Lab infrastructure, Teaching, Fun), each a 2–3 col image-card grid, plus status filter chips (Active / Maintained / Legacy) — supersedes J2 · both · P1

### Agent tools (`#/tools`)
- T1 · tools list + sidebar · "Media uploads (gap)" is a page about a missing tool, shown publicly · remove it from the public list (keep it as a maintainer note) · both · P2

### Team (`#/team`)
- M1 · team · opens with GitHub stats; people photos come last; a "who can edit what" rules paragraph sits in between · order: current team → alumni → activity; move the edit-rules paragraph to Editor help / maintainer protocols · both · P1 · NOTE: the edit-rules paragraph is from the in-flight `task/project-rights` session — coordinate, don't clobber
- M2 · team "Most active repositories" · column so thin names break letter by letter ("scal ar_f ield _sim") · fix the column layout/min width, never break mid-name · desktop narrow · P1
- M3 · team "People on GitHub" · "Desert Mango @desert-mango-robotics" listed as if a lab member · exclude it (`data/github-links.json` `exclude`, a Desert Mango data change) · both · P2
- M4 · team stat tiles · 7 tiles in a 4-col grid leave a hole; "0 releases" is low value · even row; cut low-value tiles · desktop · P3
- M5 · team person cards · clicking a person should open a small profile panel (photo, role, projects, GitHub, link) instead of jumping away · both · P1
- (Kyle: alumni cards stay the same size as current team.)
- M6 · team activity heading · "Team" H1 + "Lab activity" H2 stacked is too much · the activity block's heading is just "Lab activity"; the nav tab stays "Team" · both · P2
- M7 · team activity lead · remove the sentence "What the lab's 97 public repositories did in the last 365 days…"; put "GitHub data as of <date>" directly right of the "Lab activity" heading, separated by a middle dot · both · P2
- M8 · team stat tiles · remove: "authors, last 365 days", "repositories touched", "stars, all repositories" (and "0 releases", M4) · keep commits / public repositories / open issues · both · P2
- M9 · team "open issues" tile · clickable: lab members (or at least admins — agent's call) with access see the open issues · both · P2
- M10 · team heatmap · hover tooltip too slow; default-looking · instant, site-styled tooltip (date + commit count) · desktop · P2
- M11 · team "Recent commits" · only the 10 most recent; each row shows its author; clicking a commit opens a small site-styled overlay: author, repository, which project(s) it belongs to — less info is better · both · P1
- M12 · team "Most active repositories" · clicking a repo opens a similar overlay: short info, which projects and which setup pages it touches; drop the code-language label · both · P1
- M13 · team "People on GitHub" · show the 10 most active contributors, the rest collapsed; when expanded, remove the sentence about "everyone who has committed to a non-fork repository or to the pages of this site" · both · P2
- M14 · team · remove the "Source: public GitHub REST API reads" sentence above the people section · both · P3
- M15 · team · remove the "Who wrote this" section from the Team page ("Written by kyle and Desert Mango": lowercase login, company not person) · both · P2
- M16 · team purpose · people and activity matter equally (frames M1's order: people first, activity right after)
- M17 · all overlays (M5, M11, M12) share one site-styled popover/dialog component (focus trap, Esc closes, works on phone as a bottom sheet) · both · P1

### Error page + theme
- E1 · unknown route (`#/nonexistent-page`) · red "Something broke — Unknown page" box with developer advice (`./tools/serve.sh`, `file://`); tab title stays the previous page's ("Team") · a friendly "page not found" with search box + links to Setup/Projects; correct tab title; keep dev advice only for real fetch failures on localhost · both · P1
- E2 · light theme · looks flat/washed out next to dark · give light mode depth: surface contrast, borders, card shadows, accent use · both · P2
- (Kyle: the theme button works well — leave it.)

### Phone (375px)
- F1 · setup/project pages · full 71-link sidebar sits above the article · sidebar behind a menu button that opens a slide-in drawer; article first · phone · P1
- F2 · header nav row · buttons unevenly spaced · Kyle's rule: equal space between buttons, and HALF that space between each edge button and the screen edge (CSS `justify-content: space-evenly` is not it — it is `space-around`) · phone · P1
- F3 · sign-in button · covers nav/page; should recede (slide away/shrink) once you start scrolling; icon should be a simple person/profile icon, not a pen; properly sized (on phone it looks awkwardly small) · both, mostly phone · P1 (merges with P4)
- F4 · home search · placeholder cut off ("…on the Hipp"); header search shrinks to "Search.." · shorter placeholder on phone; header search becomes an icon button that opens full-width search · phone · P2
- F5 · home chips · 7 chips wrap to 4 rows and push the cards below the fold · fewer chips (H3), one horizontally scrollable row on phone · phone · P2
- F6 · header · TUHH wordmark disappears on phone and the nav wraps to a second row · keep a small TUHH mark; deliberate two-row header that follows F2 · phone · P2

### Site-wide
- G1 · header search box (top right) · on focus the four corners light up · instead the box's whole outline turns blue (the site's #2391FF accent), no corner glow · both · P2
- G2 · note boxes · "attention" boxes (30 in setup pages, `adm adm-attention`; also `adm-warning`/`adm-caution`, which share `--note-warn` in `css/site.css`) are super-important info but only have an orange left border + orange title · fill the WHOLE box with the same orange as the title, lighter (lower opacity / tint of the same hue); apply to every box of that color site-wide, both themes · both · P1

## Editor mode
Not walked here. A separate session walks Editor mode with Kyle (signed in as `kyle-nelson-berkeley`, lab member, then `desert-mango-robotics`, admin) and logs its findings in `docs/uiux-grill-editor-2026-10.md`. The sign-in button (P4/F3) belongs to THIS file's build.

## Later (non-UI wording)
