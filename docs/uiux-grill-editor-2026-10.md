# UI/UX grill — Editor mode — October 2026

Findings from a screen-by-screen walk of Editor mode with Kyle (live site, 2026-10-21), signed in
first as `kyle-nelson-berkeley` (lab member), then as `desert-mango-robotics` (admin). Each line:
id · route/screen · what Kyle dislikes (his words) · fix direction · desktop/phone · priority
(P1 high, P3 low). The public-site findings are in `docs/uiux-grill-2026-10.md` on
`task/uiux-grill`; an ED finding that belongs to that build is marked "hand to the public-site build".

Design skills (researched, `~/.claude-os/runs/2026-10-21-1637-hippocampus-uiux-grill/artifacts/uiux-skills.md`):
taste-skill · emil-design-eng · web-design-guidelines · wcag-accessibility-audit · nielsen-heuristics-audit.

## Screens walked

| Screen / route | Findings |
|---|---|
| sign-in flow (pop-up, tabs, reload) | ED1, ED2, ED29 (3) |
| Editor switch (turning on) | ED3, ED22, ED23 (3) |
| the bubble (dock) | ED4–ED11, ED20, ED21, ED24, ED35, ED40 (14) |
| editing text in place (setup page) | ED14–ED19, ED30–ED34 (11) |
| adding blocks ("+") | ED25–ED28 (4) |
| project pages / per-project access (member) | ED37–ED42 (6) |
| sending (Send box) | ED43–ED45 (3) |
| proposals: top bar, list, review, shown in place | ED12, ED13, ED46–ED48, ED53 (6) |
| Guide, View settings, Media / New / Pages, Escape | ED49–ED52 (4) |
| Team page in Editor mode | ED54–ED58 (5) |
| width, theme, sign-out | ED36, ED59–ED63 (6) |
| phone (390px) | ED64, ED65 (2) |
| **member walk total** | **65** |
| admin walk (`desert-mango-robotics`): review accept/deny, admin-only screens, sign-out | NOT YET WALKED — continues after a compact |

Status: member walk complete (2026-10-21 → 23); admin walk pending. The build starts only after this line says "walk complete".

## Findings

### Sign-in flow
- ED1 · sign-in (any page) · "it's not allowing me to click 'sign in'" in a browser that blocks pop-ups (the Claude app's browser pane): the click seems to do nothing; the only message ("The sign-in window was blocked…") goes to the footer, off screen · say it where the click was (next to the button), and fall back to a same-tab sign-in when the pop-up is blocked · both · P1 · hand to the public-site build (sign-in button, `js/app.js` `signInClick`)
- ED2 · sign-in (every tab) · a sign-in lasts only in the tab where it was made; a new tab asks again · "stay signed in across tabs" until sign-out. Keep the token out of script-readable storage (a short-lived, httpOnly session cookie set by `api/auth.js`, or the same in-memory token shared by a BroadcastChannel hand-off between tabs) · both · P1
- ED29 · sign-in (reload) · reloading the tab signs you out (the token lives only in the page's memory); unsent edits survive (saved in the browser) · a reload keeps you signed in — same fix as ED2 · both · P1 (observed during the walk)

### Editor switch (turning Editor mode on)
- ED3 · any page, Editor on · the page jumps when Editor mode turns on: the side menu moves left, the text narrows, an empty dark band opens on the right · "keep it still": the page looks exactly as before sign-in; editing pieces are added on top, nothing reflows · desktop · P1

### The bubble (floating dock, top right)
- ED4 · bubble · "too much in one box": photo, "EDITOR" tag, "Proposals 2", switch, ×, "No changes yet", undo/redo, "Send for review" all crammed together · fewer things at rest; group the rest; one clear main action · both · P1
- ED5 · bubble · "unclear words": "Proposals 2", the "EDITOR" tag, "Send for review" do not say what they do · plain labels that name the result · both · P2
- ED6 · bubble · undo/redo arrows "too faint": tiny and grey · larger, clearer arrows (still muted when there is nothing to undo, but readable) · both · P2
- ED7 · bubble · the "No changes yet" line is not needed · "it can just be the proposals": with no unsent edits the bubble says nothing about edits. Once there are edits the count comes back, clickable (ED20) · both · P2
- ED8 · bubble → proposals · clicking Proposals should EXPAND THE BUBBLE to show the top three proposals, scrollable for more — no trip to a separate page · both · P1
- ED9 · bubble → a proposal · clicking a proposal in the bubble takes you to its page automatically, keeps the bubble open, and scrolls to the section the proposal changes · both · P1
- ED10 · page with a proposal · beside the changed section, comments in the side margin where you approve, deny, or comment on that change (Google-Docs style) · desktop (phone: below the section) · P1
- ED11 · proposals (who sees them) · "you should only see proposals if you are somebody who is able to actually press accept": a person who cannot approve a page's proposals never sees them (no count, no list, no marks) · both · P1

### Editing text in place (setup page)
- ED14 · setup page, editing · the blue line in the left margin that shows where you are is solid while you are away, but turns LIGHT blue when you hover the block you are editing · the block you are in stays solid blue, hover or not; hovering another block gives it the light line; clicking that block moves the solid line to it. Cause: the hover rule (`body.hc-edit-on.hc-outlines … .hc-block:hover::after`, `css/editor.css` ~l.69) carries one more class than the selected/open rule, so it wins · desktop · P1 (bug)
- (Kyle: the yellow underline on new words "looks good" — keep it.)
- ED15 · setup page, format toolbar · the black B / I / <> / link toolbar pops up over the selection and covers the heading above · put it at the top of the section being edited, shown once you click into that block (not on every selection) · desktop (phone: pinned above the keyboard) · P1
- ED16 · format toolbar · no list tool · add a list button (bulleted; numbered if cheap) · both · P2
- ED17 · format toolbar · order · link before code: link is used more often · both · P3
- ED18 · editing · no way to leave a note without changing text · a Comment tool: "if the user doesn't actually want to edit something or they just want to note something for the admin to review, then they can add a comment instead of actually changing anything"; comments travel with the proposal and show in the reviewer's side margin (ED10) · both · P1
- ED19 · editing, deleted (struck-through) words · selecting a word and pressing Delete strikes it through, but there is no way to bring it back bit by bit · with the cursor at the RIGHT end of a struck-through word, Backspace restores it letter by letter (un-strikes from the right), instead of jumping to the word's left end and deleting the space before it · both · P1 (bug-like)
- ED20 · bubble, unsent edits · the "1 change" count should be clickable like Proposals: the bubble expands into a list of your changes; clicking one takes you to where it is on the site · both · P1
- ED21 · bubble, sending · send one change on its own, or all of them with "Send for review" · both · P1
- ED22 · Editor switch · turning Editor mode on blanks the page for ~2 s before it comes back · switching on feels instant: the page stays visible while the editor loads · desktop · P1 (glitch)
- ED23 · Editor on · the layout lands differently each time (once the side menu jumped left and the text narrowed, once it stayed put) · one layout, every time (with ED3: the same as signed-out) · desktop · P1 (glitch)
- ED24 · bubble, a member who cannot approve · they still see THEIR OWN sent changes, each with its status (waiting / live / declined), in the bubble — and nobody else's (ED11) · both · P2
- ED30 · editing, after a reload · saved edits come back ("1 change") but without their marks: the deleted word is simply gone and new words look like normal text · saved edits always show their yellow/struck marks — after a reload, in a new tab, the next day · both · P1 (bug)
- ED31 · editing, after a reload · undo is greyed out for edits made before the reload · undo/redo history survives a reload (kept with the saved draft) · both · P2
- ED32 · note box · the × at the box's top right deletes the whole box in one click — "scary" · no one-click delete: move remove into a menu, or ask/confirm, and make it undoable · both · P1
- ED33 · code box · "Language: console ▾" is unclear · plain words ("Shell commands", "Python", …) or hide it behind a small menu; most people never change it · both · P2
- ED34 · note box, code box · the "Note ▾" and "Language" controls overlap the box's top border and look pasted on · controls sit cleanly inside (or above) the box, with ED15's toolbar at the top of the block being edited · both · P2
- ED35 · bubble, scrolling · the open bubble covers the right end of lines when you scroll (the note box's "…is n", "If in" cut off) · "shrink while scrolling": the bubble folds to the small photo tab when you scroll or type, and opens again on click · both · P1
- ED36 · setup page top (Editor on) · both a "Contents" button and an "▶ On this page" bar above the title · keep one · desktop · P2 · hand to the public-site build (`js/app.js` / `css/site.css`, from P1)

### Adding blocks (the "+" between blocks)
- ED25 · setup page, "+" · the "+" shows only when the mouse sits exactly on the 0-height line between two blocks; hard to hit · keep hover-on-the-line, but "make it more sensitive so it's easier to activate": a taller invisible hover band (≈ the whole gap between blocks) · desktop (phone: needs a tap target, see the phone sweep) · P1
- ED26 · "+" picker · Note / Warning / Attention are three separate tiles · merge into one "Note box" tile with the kind (note / warning / attention) chosen inside the box · both · P2
- ED27 · "+" picker · tiles are plain words with grey sub-words ("callout", "per platform", "a link", "org repository") · clearer tiles: a small icon + one word; drop the sub-words · both · P2
- ED28 · "+" picker · pushing the page down is OK "but only do it after you push the plus button, not just on the hover": nothing on the page moves on hover; the space opens only on click · both · P2

### Project pages (edit access as a member)
- ED37 · project page you can edit · only the story paragraphs are editable; the title, one-line description, ACTIVE tag and Status / facts box do nothing on click · click to edit each fact in place (title, description, status, repos), written to that project's `data/projects/<id>.json` in the proposal · both · P1
- ED38 · project page you cannot edit · nothing on the page itself says it is locked; clicking text just does nothing · show it on the page too (a quiet lock line near the title, a "can't edit" cursor/tooltip on click) · both · P2
- ED39 · bubble on a locked page · Kyle: the "You can't edit this project…" text + "Request edit access" button are "good" · move "Proposals" down next to the "Request edit access" button on this view · both · P3
- ED40 · bubble (every view) · an awkward gap between the "EDITOR" tag and the Editor switch · keep both, close the gap, make the bubble "a tad bit slimmer" · both · P2
- ED41 · bubble on a page you can edit · "An admin gave you access to this project." · drop it: if you can edit, just edit · both · P3
- ED42 · project page (public view too) · HippoCampus vehicle shows two "ACTIVE" tags · remove the one under the title; keep the one in the details row under the image · both · P2 · hand to the public-site build (`js/app.js` project page)

### Sending (the Send box)
- ED43 · bubble "Send for review" · it opens a big Send box (title field "(the proposal's title on GitHub)", a file path, a paragraph about commits and branches, a "Propose" button) · "Send for review should just finish it immediately": one click sends; the title/commit message is generated in code in the background; "it should not be this much effort for non-techy people" · both · P1
- ED44 · Send box · "there should be no send box"; the GitHub talk (file paths, commit, branch) is "too techy" — gone with the box. Afterwards a short plain confirmation in the bubble ("Sent — waiting for review"), with undo for a few seconds if cheap · both · P1
- ED45 · bubble change count · the same edit read "1 change", later "2 changes" · count one change PER PAGE ("1 page changed"); the ED20 list is then a list of changed pages, each opening that page · both · P2

### Guide, View settings, and the other editor screens
- ED49 · Guide (`#/help`) · one long numbered wall of 9+ steps in GitHub words ("frame", "pull request", "Markdown", "main") · "I don't want … these pages to exist; this is too much information. The UI needs to be so intuitive that there doesn't need to be instructions or settings": remove the Guide; whatever it explained must be obvious on screen instead (lab maintainers keep `docs/maintainer-protocols.md`) · both · P1
- ED50 · View settings · four switches ("Show others' suggestions", "Diff style: Inline / Side by side", "Compact mode", "Mark blocks on hover") and a "localStorage" note · remove the page; fixed good defaults (others' suggestions shown only to approvers per ED11, inline marks, normal density, hover line on) · both · P1
- ED51 · image library, New page / project / person, the list of all pages (`#/media`, `#/new/*`, `#/pages`) · a member finds no button for any of them; the old address `/#/media` shows "Page not found" · right where it goes: a "+ New project" card on the Projects page, "+ New page" at the end of each side-menu group, images through the "+" between blocks or by clicking an image; no separate library/pages screens · both · P1
- ED52 · Escape · pressing Escape to close the small account menu also closed the whole Proposals screen behind it · Escape closes only the top-most thing · both · P2 (glitch)
- ED53 · "Show #1 on page" · the "Showing proposal #1" bars followed to every later page, even "Page not found" · viewing a proposal ends when you leave its page (moot once ED46 removes the bars, but the stuck state must go too) · both · P2 (glitch)

### Team page (`#/team`) in Editor mode
- ED54 · team, a person card (admin) · clicking a card opens a menu (Move up, Move down, Move to Alumni, Unpin from the team, Open their page) with no way to change name, title or photo · edit in place: click the name or title to type, click the photo to replace it · both · P1
- ED55 · team, card menu · "delete the menu feature, that is buns"; "drag is enough": drag to move (within and between Current team / Alumni); no Move up/down, no Unpin wording. (Removing a person still needs a way: a small remove control shown on hover/focus, undoable — confirm in the plan) · both (phone: long-press drag) · P1
- ED56 · team, as a member · `kyle-nelson-berkeley` is not an admin, yet the Team page is fully editable for him · for a non-admin the Team page looks like normal reading mode (Editor switch and "HippoCampus Editor" stay as they are); the ONE exception: a member can edit their own card's name and photo — not their title. Every other Team decision is admin-only · both · P1 (permissions)
- ED57 · team, "Add a person" (admin) · clicking it creates a new empty card with fields for GitHub account, Name, Title and profile image · both · P1
- ED58 · team, "Add a person" with a GitHub account (admin) · adding the person also invites that GitHub account to the `HippoCampusRobotics` GitHub organization — as a member only, NOT with write access to the org's repos · both · P2 · needs a server-side org-invite call with an org owner's rights (check who holds them; never in the browser) — a new capability, flag in the plan

### Width, theme, sign-out
- ED59 · setup page at medium width (~840px), Editor on · TWO "Contents" buttons (one above the proposal strip, one inside the editable page) · "we don't need either Contents button since we have the On this page directory": remove both in Editor mode; on the public site the call is the public-site build's · desktop narrow · P2 · editor side: ours; the public "Contents" button: hand to the public-site build
- ED60 · header at medium width · the "Editor" word next to "HippoCampus" disappears · "HippoCampus Editor" shows at every width while Editor mode is on · both · P2 · header is `js/app.js`/`css/site.css` → coordinate with the public-site build
- ED61 · bubble "Send for review" (and every blue-filled button) · its text should be WHITE on the blue (Kyle overrides the earlier near-black #0a0a0a choice) · both · P2
- ED62 · bubble, light theme · the orange "EDITOR" tag clashes: it reads like a warning or a change mark · a neutral or blue tag · both · P2
- ED63 · signing out · signing out deletes unsent edits · keep them: unsent edits stay on this browser until you sign back in; sign-out only signs out · both · P1

### Phone (390px, checked through `tools/tests/editor_walk.html?step=phone` — Chrome could not shrink)
- ED64 · phone, the bubble · it floats right under the header and covers the "Contents" button and the top of the page · a small round photo button at the bottom right (thumb reach); a tap opens the bubble as a bottom sheet · phone · P1
- ED65 · phone, editing in general · Kyle expects members to edit on a phone "rarely": it must not look broken (no covered text, nothing off-screen, tap targets ≥ 44px), but phone editing is not a design driver; desktop-first for ED8–ED21 · phone · P2

### Proposal bar (top of a page) and the proposals pages
- ED12 · page top bar "kyle-nelson-berkeley proposes changes to this page · PR #1 · check green · Review" · "I really don't like the top of the screen feature at all" · remove it completely; its job moves to the bubble (ED8–ED10) · both · P1
- ED46 · "Show #1 on page" · two bars stack at the top, both "Showing proposal #1 on the page (read-only)", with two "Back to your view" buttons, taking a third of the screen · "I don't want either of those two blocks at the top of the page": both go (with ED12); the bubble names the proposal being viewed and holds "Back" · both · P1
- ED47 · a proposal shown on the page · after "Show #1 on page" nothing on the page marks what #1 changes; scrolling the whole page finds no marks · showing a proposal jumps straight to the changed words and marks them in the change colours (with ED9) · both · P1 (bug-like)
- ED48 · a proposal shown on the page · "read-only" is confusing: you cannot tell whether you are looking at your page or someone else's proposal · one clear visual state for "viewing someone's proposal" (their name + photo in the bubble, the marks in place), and one for "my edits" · both · P2
- ED13 · `#/` proposals list and `#/review/<n>` · "I also don't like the separate proposal page feature at all" · remove the separate proposals page and review screen; proposals live in the bubble and in place on the page (ED8–ED10). Keep the old addresses as redirects into the page + bubble · both · P1
