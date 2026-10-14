# Editor mode audit (2026-10-14)

The audit before the Editor mode redesign. It looks at the editor that shipped on 2026-10-02 ("direction A ·
Pencil": the Editor switch, a sandboxed page frame, and a five-tab tray on the right). It gives the cause of the
"page jumped or reloaded" glitch, measured in a browser; the ranked findings; and what the redesign must keep
and may cut.

Method:

- A browser walk over the real site with a fake GitHub (`tools/tests/editor_walk.html`, steps `on`, `select`,
  `edit`, `insert`, `tray-proposals`, `phone`, `overlay-inline` and the new `scroll`), with screenshots.
- A static review of `js/editor.js`, `js/editor-frame.js` and `css/editor.css` against three rule sets:
  Vercel's Web Interface Guidelines, impeccable's audit and critique, and taste-skill's
  redesign-existing-projects.
- Screenshots stay out of the repo (images serve from Cloudinary here). Each one is named by its file name.

One finding is held back until it is fixed.

## 1. The jump glitch: cause and measurement

**Cause (code):** each pause in typing reloads the whole page frame. In the tray's block box, every input runs
`blockChanged` (`js/editor.js:3038`). It calls `frameTo(route, true)` after a 600 ms debounce (`:3051`), which
calls `ed.host.load(route, …)` (`:2406`). That sets a new `iframe.src` with a fresh nonce (`js/source.js` §3,
"Re-load"), so a new document loads. The new document starts at the top. Then `apply()` in
`js/editor-frame.js:349` calls `scrollIntoView({block: 'center'})` on the selected block. The site sets
`html { scroll-behavior: smooth }` (`css/site.css:54`), so the page slides from the top back down to the block.

**Measurement:** the walk's `scroll` step selects the page's last paragraph, waits until the frame holds still,
types one character into the tray, then waits for the reload and one more second. A test-only hook in the frame
(`hc-walk-scroll`, active only on localhost under the walk page) answers with the frame document's scroll position
since it loaded: an ordered event log (`create`, `mutation`, `scroll`) and 16 ms samples. Page:
`#/setup/lab-gantry/usage`, 1280×900. The rule was fixed before any data was taken. "Reproduced" means all of:
the frame was ≥ 100 px down and steady before typing; the nonce changed (a new document); the new document's log
shows the content present at `scrollY < 20` before the first entry within 20 px of the old position.

Real-time run (headless Chrome over DevTools, no virtual time):

| | nonce (first 16) | scrollY | log entries |
|---|---|---|---|
| Before typing | `24cefb91b858949a` | 4256 (steady) | 70 |
| After typing | `aa4628a66d2bc736` (new) | 4814 | 72 |

After-typing log, in order: #0 `create` y=0 (page height 809) → #1 `mutation` y=0 (height 5870: content in,
at the top) → #5 `scroll` y=2 → #10 y=102 → #20 y=1650 → #40 y=3817 → #62 y=4237 → #69 y=4256 (back at the
block, about a second later) → #70 y=4449 → #71 y=4814. **Verdict: reproduced.** The last two entries are a
second jump: images further up finish loading, the page grows (6445 → 7003 px) and the block moves again. The
site window itself barely moves (max 28 px), so the jump is inside the frame.

Virtual-time run (`--virtual-time-budget`, the walk's usual mode): the reload and the reset to the top were seen
(new nonce `14abb33ee8b4db47`; y=0 with height 5870), but the slide back was not, because smooth scrolling does not
advance under virtual time (before-typing position only 100 px). So virtual time can show the reload, not the
slide; the real-time run is the evidence.

**Pinning test for the fix (Phase 3):** after typing, `nonce16` is unchanged and the series never leaves the
before-typing position.

Screens: `walk-setup-lab-gantry-usage-scroll-1280.png`, `realtime-scroll.png`; data `realtime-scroll.json`,
`walk-setup-lab-gantry-usage-scroll.json`.

## 2. Findings, ranked

P0 = breaks trust or the task. P1 = a non-technical member gets stuck or confused. P2 = polish.

1. **P0** `js/editor.js:3051` — every pause in typing reloads the page frame (section 1).
2. **P0** `js/editor-frame.js:349` + `css/site.css:54` — after each reload the selected block is scrolled to with a
   smooth slide from the top; late images then move it again.
3. **P0** `js/editor.js:3097` — you edit a block as raw Markdown in a 340-px side panel (`css/editor.css:16`), away
   from the text you clicked. This is "editing felt odd". Screen: `walk-…-select-1280.png`.
4. **P1** `css/editor.css:36`, `:47` — the pencil and the `+` buttons are invisible until hover, so first-time
   users, phones and keyboards never find them.
5. **P1** `js/editor.js:995`, `:1233` — the one action that matters, sending for review, is a "Propose…" button
   in a draft list below the editor, which opens a second "Propose" button.
6. **P1** `js/editor.js:2764`, `:2726`, `:2788`; `:849`–`:853`; `:1240`–`:1246`; `css/editor.css:71` — GitHub words
   everywhere: "PR #n", "check green", "Update from main", "pull request", "gate", "commit on a new branch".
   Screens: `walk-…-overlay-inline-1280.png`, `walk-…-tray-proposals-1280.png`.
7. **P1** `js/editor.js:532`–`:539`, `:1853`, `:708` — opening a card or changing a View toggle redraws the whole
   tab: the list flashes "Loading proposals…" and keyboard focus drops to the page.
8. **P1** `css/editor.css:63` — in inline review, added and removed blocks differ only by green vs red; no word,
   no strike-through (WCAG 1.4.1).
9. **P1** `js/editor.js:1973` (and `:2836`, `:1002`, `:1651`) — errors read "Something went wrong: <raw
   exception>" with no next step.
10. **P1** `js/editor.js:3175`, `css/editor.css:200` — a closed tray shrinks to a rotated side tab that says
    "Editor" until its count loads.
11. **P1** `js/editor-frame.js:210`; `js/editor.js:3158`, `:3141` — the `+` picker, the tray tabs and the avatar
    menu have no arrow keys and do not move focus.
12. **P1** `js/editor-frame.js:253` — a click anywhere in a block selects it, even after dragging to copy text.
13. **P1** `js/editor.js:1608` — "Image from Media" is a dropdown of file names, no thumbnails.
14. **P1** layout — opening the tray narrows the page column, so the whole page re-wraps (compare
    `walk-…-on-1280.png` with `walk-…-select-1280.png`).
15. **P2** `js/editor.js:910` and five more — native `window.confirm` dialogs.
16. **P2** `css/editor.css:263`–`:379` — a leftover `cms-*` style block beside the `hc-*` styles: two visual systems.
17. **P2** `css/editor.css:188`, `:176`, `:84` — tiny grey all-caps headings and text down to .62rem.
18. **P2** `css/editor.css:109`, `:122`, `:46` — the switch, avatar and `+` are below 44-px touch size; the
    switch's label is hidden on phones (`:432`).
19. **P2** `css/editor.css:112`, `:250` — knobs animate `left`; no `prefers-reduced-motion` block.
20. **P2** `js/editor.js:856`–`:858`, `:1881` — copy says "out of v1", "not in the editor yet", "localStorage".

## 3. Keep (the redesign must not lose these)

- Sign-in and session end: `createSignIn` `js/cms-core.js:250` (message check `:310`–`:320`); `endSession`
  `js/editor.js:177` with the stale-answer drop (`:109`, `:199`–`:209`).
- The sandboxed page frame without same-origin (`js/editor.js:2281`–`:2282`), a fresh nonce per load and the
  source + nonce check (`createPreviewHost` `js/cms-core.js:659`–`:704`, `frameMessage` `js/editor.js:2822`).
- Roles: `canEdit` `js/editor.js:904`, `roleFromPermissions` `js/cms-core.js:93`, `reviewActionsFor` `:894`.
- `createDraftStore` `js/cms-core.js:1384` and the leave-page prompt (`js/editor.js:3815`).
- `runPropose` `js/cms-core.js:1672` and its order: base head → stale-file refusal → blobs → tree → commit →
  ref → pull request.
- Media through `api/media.js` (`js/cms-core.js:1770`, `:1854`), including the in-use refusal.
- `isAllowedWrite` `js/cms-core.js:450` over the write allowlist.
- Both stale-head guards: merges pinned to the head sha (`js/cms-core.js:940`) and Propose's stale-file refusal.
- The text-only DOM builder `h()` (`js/editor.js:127`), span-only edits through `replaceSpan` (`:3042`).
- The parity table in `docs/cms-v2-plan.md`, enforced by `tools/tests/test_parity_table.mjs`: its rows are
  re-homed by name, never deleted.

## 4. Cut

The per-keystroke frame reload; the tray's Markdown box as the main way to edit (it stays only for tables, tabs
and raw HTML); pencil + whole-block click-to-select; a `+` rail before every block; the five-tab tray, the
vertical handle and the duplicate "Showing proposal" bar; side-by-side diff for the first version; the list
re-read on every card open; `window.confirm` (use inline undo); raw-JSON registries in the main flow; the Guide's
long text; the leftover `cms-*` CSS; repeated "edit on github.com instead" links (keep one).

## 5. Why it feels the way Kyle described

- **Glitchy:** typing reloads the page and slides it back from the top; tray actions repaint and flash.
- **Hard to find things:** edit controls are invisible until hover; the main action hides behind "Propose…" in
  GitHub words; a closed tray becomes a sideways tab.
- **Unfinished:** tiny grey all-caps headings, two style systems, native confirm boxes, raw error text, and copy
  that admits "out of v1".
