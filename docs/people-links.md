# People-card link resolution

*Companion to `data/people.json` — records, per person, why a card links where it does (or
why it has no link), so a `null` link is distinguishable from a failed lookup. Resolved
2026-09-03. The rules (Kyle, 2026-09-03): a card links the person's personal TUHH page when
one exists; otherwise a personal page only at ≥90% identity confidence where the page itself
shows TUHH/HippoCampus affiliation; otherwise no link. LinkedIn/ResearchGate/Scholar
profiles are deliberately never linked (login walls, instability); found ones are listed as
candidates. `tools/check_urls.py` probes every non-null link for liveness.*

On the Team page the whole card is the link; a plain click opens the profile, which holds the link
(a cmd/ctrl-click or middle click opens the link itself in a new tab; uiux 2026-10, M5).

## Active

| Person | Resolution | Link |
|---|---|---|
| Kyle Nelson | RESOLVED 2026-09-03 (was flagged: the auto-generated project URL `portfolio-kyle-nelson-berkeleys-projects.vercel.app` 302s to Vercel SSO). Kyle supplied the public production alias, which serves the latest production deployment without disabling deployment protection — verified 200 anonymously. | https://kyle-nelson-berkeley.vercel.app |
| Nathalie Bauschmann | Personal TUHH page, verified 200 | https://www.tuhh.de/mum/team/wimi/nathalie-bauschmann |
| Vincent Lenz | Personal TUHH page, verified 200 | https://www.tuhh.de/mum/team/wimi/vincent-lenz |
| Finn Breuer | CORRECTED BY KYLE 2026-09-03: the lab people page lists him as "Finn Busch" — that surname is wrong (their page's error, left for Nathalie to fix on their site). The earlier KTH-RPL candidate research chased that wrong name and is moot. Link supplied directly by Kyle (LinkedIn, tracking params stripped). LinkedIn blocks anonymous probes (HTTP 999 for live and dead profiles alike), so check_urls.py reports this link as unverifiable rather than passing/failing it — verify in a browser. | https://www.linkedin.com/in/finnj-breuer/ |

## Alumni

| Person | Resolution | Link |
|---|---|---|
| Thies Lennart Alff | Personal TUHH page, verified 200 | https://www.tuhh.de/mum/team/wimi/thies-lennart-alff |
| Daniel-André Dücker | Personal TUHH page still exists, verified 200 (per the decision: TUHH page, not a TUM page) | https://www.tuhh.de/mum/team/wimi/daniel-duecker |
| Niklas Trekel | LINK REMOVED 2026-09-03 — Kyle could not confirm the identity ("not sure"), and nobody on this side knows him, so the cautious default applies. Candidate for Nathalie to confirm: his Uni Bonn (StachnissLab) page, which states both his degrees are from Hamburg University of Technology — https://www.ipb.uni-bonn.de/people/niklas-trekel/index.html | none |
| Richard Wittmüß | No TUHH page; only a LinkedIn profile found (shows TU Hamburg) — not linked by policy. Candidate: https://de.linkedin.com/in/richard-wittmuess | none |
| Eugen Solowjow | Personal TUHH page still exists, verified 200 | https://www.tuhh.de/mum/team/wimi/eugen-solowjow |
| Axel Hackbarth | Personal TUHH page still exists, verified 200 | https://www.tuhh.de/mum/team/wimi/axel-hackbarth |
| Tim Hansen | No TUHH page; now at Constructor University per Scholar/LinkedIn, but no stable personal page showing TUHH affiliation. Candidate: https://de.linkedin.com/in/tim-hansen-8b5aa1170 | none |
| René Hochdahl | Personal TUHH page (back at MUM as research staff), verified 200 | https://www.tuhh.de/mum/team/wimi/rene-hochdahl |
| Roman Sartorti | Personal TUHH page (now at the SKF institute), verified 200 | https://www.tuhh.de/skf/institute/staff/roman-sartorti |
| Malte Flehmke | Personal TUHH page (now at the IPMT institute), verified 200 | https://www.tuhh.de/ipmt/das-ipmt/team/mf |
| Benedikt Mersch | No TUHH page. Non-TUHH personal page, ≥90%: his Uni Bonn (StachnissLab) page states his master's degree is from Hamburg University of Technology. CONFIRMED by Kyle 2026-09-03. | https://www.ipb.uni-bonn.de/people/benedikt-mersch/index.html |
| Matti Vahs | No TUHH page. Non-TUHH personal page, ≥90%: his KTH profile states both his degrees are from Hamburg University of Technology. CONFIRMED by Kyle 2026-09-03. | https://www.kth.se/profile/vahs |
| Lukas Büsch | Personal TUHH page (now at the IFPT institute), verified 200 | https://www.tuhh.de/ifpt/institut/mitarbeiter/wissenschaftliche-mitarbeiter/lukas-buesch-msc |
| Philip Carstensen | Personal TUHH page (external doctoral candidate at MUM), verified 200 | https://www.tuhh.de/mum/team/wimi/philip-carstensen |
| Kevin Eusemann | No TUHH page; no personal page found (only unclaimed ResearchGate/SemanticScholar entries). No link by rule | none |
| Sean Maroofi | No TUHH page; only a LinkedIn profile found (shows TU Hamburg) — not linked by policy. Candidate: https://se.linkedin.com/in/sean-maroofi | none |
| Viktor Rausch | No TUHH page; only ResearchGate/Scholar profiles found — not linked by policy | none |
| René Geist | LINK REMOVED 2026-09-03 — Kyle could not confirm it. He stays on the roster because he is listed on the lab's current people page (verified same day; placeholder photo, no title there). Candidate for Nathalie to confirm: https://andregeist.github.io/ (states Theoretical Mechanical Engineering at TU Hamburg; a HippoCampus-era paper carries the MUM institute affiliation) | none |
| Tobias Johannink | No TUHH page; only LinkedIn/ResearchGate found (both show TUHH history) — not linked by policy. Candidate: https://de.linkedin.com/in/tobias-johannink-a2b060163 | none |

## Non-TUHH links for Kyle's review

Resolved 2026-09-03 — Kyle reviewed person by person (he knows few of these people, so
anything he could not confirm falls back to no link; candidates stay listed above for Nathalie):

- Niklas Trekel → **link removed** (not sure)
- Benedikt Mersch → **kept** (confirmed)
- Matti Vahs → **kept** (confirmed)
- René Geist → **link removed** (unconfirmed); card kept because he is on the lab's current people page
