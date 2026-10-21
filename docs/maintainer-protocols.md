# Maintainer protocols: how the lab runs this site

*Written 21 September 2026 for the day-one path: edit on github.com, then review, approve and
merge in the site's Review tab. Updated 22 September 2026: the site editor (section 1b) and the
Media tab (section 7). Updated 2 October 2026: the site editor now lives on the site's own pages
(Editor mode), and the old editor at `/cms/` is gone (see the note after the quick answers).
The github.com pencil (section 1) stays as a second way to make a change.*

This page is for Nathalie (the site's owner) and for lab members. You do not need to code.
You need a GitHub account and a web browser.

A few words used on this page:

- **Pull request (PR), or proposal:** a proposed change. Nothing on the live site changes until
  someone merges it. The editor calls a pull request a "proposal".
- **Merge:** accept a proposal. The site then updates by itself.
- **Branch:** a separate line of work in the repository. Each proposal lives on its own branch.
- **Main:** the repository's main branch. The live site is built from it, and a merge puts a
  proposal into it.
- **Repository (repo):** the folder of files the site is built from,
  `https://github.com/desert-mango/hippocampus-docs`.
- **The gate:** the site's rule checker (`tools/check.py`). It runs on every proposal and
  gives a green ✓ or a red ✗.
- **Editor mode:** the site editor. It works on the site's own pages, so you change a page
  while you look at it. You turn it on and off with the **Editor** switch in the bubble at the top
  right of the page.
- **The editor page:** opens from **Proposals** in the bubble and covers the page until you press
  **Back to the page** (or Escape). It has four tabs: **Proposals**, **Data**, **View** and
  **Guide**. (Until 14 October 2026 this was a panel on the right called the tray; the steps below
  that say "tray" mean this page, and "Changes" means **Data**.)
- **Block:** one piece of a page, such as a heading, a paragraph, a list, a picture or a note
  box. In Editor mode you click a block to change it.
- **Draft:** a change you made that is not proposed yet. It stays in this browser, even when you close
  the tab, until you send it for review or sign out (signing out deletes it, after asking).

## Quick answers

1. **To approve a proposal:** on the site, open the **Proposals** tab
   (`https://hippocampus-docs.vercel.app/#/?editor=proposals`), click the proposal's title,
   check the green ✓ "site rules pass" line, click **Show on page** to see it on its page, then
   click **Approve** and then **Merge**.
2. **A red ✗ means:** the proposal breaks one of the site's rules. The proposal's card in the
   Proposals tab lists each problem under "What to fix (file, line, message):". The three most
   common are a comma after the last item in a JSON file, a missing required key, and a renamed
   or removed id (all three are quoted below).
3. **To roll a change back:** in the Proposals tab, click the proposal under
   **Recently merged**, click **Undo on GitHub**, click GitHub's **Revert** button, then approve
   and merge the new proposal that GitHub opens.
4. **To add a member:** an Admin opens
   `https://github.com/desert-mango/hippocampus-docs/settings/access`, clicks **Add people**, and
   gives the role Write to lab members, Maintain to trusted reviewers, and Admin only to Nathalie.
5. **To add a picture:** while you edit a block in the **Changes** tab, click
   **Image from Media**, upload a PNG, JPEG, GIF or WebP image under 5 MB (or pick one the site
   has), describe it, click **Insert into page**, and propose the page (section 7).
6. **A "derive" commit is:** the robot (`hippocampus-derive[bot]`) rebuilding the site's search index
   and graph data right after a merge; it needs nothing from you.
7. **For a "machinery" badge:** do not merge; ask Desert Mango, who reviews every change to the
   site's code.
8. **When a rename or removal is refused:** put the old id back so the check turns green, and ask
   Desert Mango to do the rename or removal for you.
9. **To edit a page in the site editor:** open the page on the site, click **Edit this page**
   at the bottom (or **Sign in to edit** if you are not signed in yet), click the block you want
   to change, change its text in the **Changes** tab, then click **Propose…** and **Propose**
   (section 1b).
10. **To get edit access to a project:** sign in, open the project's page, and read the
   small box above the project's repositories (its list is headed **Who can edit**). Its first
   line says whether you can edit the project and why. If you cannot, click
   **Request edit access**; an admin says yes or no in the Proposals tab (section 2b).

The old editor addresses (`/cms/#/review`, `/cms/#/pages`, `/cms/#/media` and the rest) still
work: each one sends you to the same place in Editor mode.

For anything else, contact Desert Mango through `desert-mango.com`, or open an issue on the
repository.

## Who can do what

| GitHub role on the repo | Badge in the header | Who | What they do |
|---|---|---|---|
| Admin | Admin | Nathalie, Desert Mango | Everything, including adding and removing people |
| Maintain | Maintainer | Trusted reviewers that Nathalie names | Review, approve, request changes, merge, update from main (bring a proposal up to date with the newest main) |
| Write | Editor | Lab members | Edit and propose changes, and upload pictures (a project's pages: only the projects they have edit access to, section 2b); a proposal's card shows them **Approve**, **Request changes**, **Update from main** and **Close**, but no **Merge** button. An Editor's **Approve** records their review on the proposal; it does not merge it |
| Read, or none | Read-only | Everyone else | Can read the public site and look at proposals; cannot propose or review |

The badge shows in the header, next to your name, once you are signed in.

Nathalie and the Maintainers merge. Since 15 October 2026 GitHub enforces who may approve:
`main` has a rule (the `main-review` ruleset) that every change needs a pull request, the green
`check`, and one approval from a **code owner** of the changed files. The code owners are the
site's admins for everything, and for each project the people who have **edit access** to it
(section 2b: everyone with a commit in that project's repositories, plus the people an admin
added, minus the people an admin removed). So a lab member can approve and merge only
proposals that stay inside a project they have edit access to, and never their own proposal.
Admins can still push to `main` directly; so can the site's robot (`hippocampus-derive[bot]`),
which only ever adds the derived data and the changes reviewers approved on the page (below).

## 1. Make a change on github.com (lab members)

1. Find the file to change. The table "Which file do I edit?" in `CONTRIBUTING.md` lists them.
   (In Editor mode, the **Changes** tab shows the file of the page on screen, with the link
   **edit on github.com instead**.)
2. Open the file on github.com and click the **pencil icon** (top right of the file view).
3. Make your edit. Click the **Preview** tab to check the text.
4. Click **Commit changes…**. In the box that opens, choose
   **Create a new branch for this commit and start a pull request**, then click
   **Propose changes**, then **Create pull request**.
5. Your proposal now shows in the Editor's **Proposals** tab for Nathalie and the Maintainers.

You are a collaborator, so your branch lives in the repository itself. There is no fork and no
"Approve and run" button to wait for. The check starts on its own.

## 1b. Make a change in Editor mode (lab members)

Editor mode does the same as section 1, on the page itself. You need the Editor badge or
higher. With the Read-only badge you can look, and the **Changes** tab says "View only: changing
pages needs write access to this site's repository. You can still propose a change on
github.com."

**Sign in and turn Editor mode on.**

1. Open the page you want to change on the site.
2. At the bottom of the page, click **Sign in to edit**. A GitHub window opens; the page says
   "Finish signing in in the GitHub window…". Sign in there. The window closes by itself.
3. Editor mode turns on. The page now shows inside the editor, and the header holds the
   **Editor** switch, your picture or initial, your first name and your role badge. Click the
   switch to turn Editor mode off and on. To sign out, click your picture, then **Sign out**.

Once you are signed in, the link at the bottom of every page says **Edit this page**. It turns
Editor mode on, on the page itself. The bubble at the top right holds your picture, your name
and role, a small **Proposals N** link, the **Editor** switch, and below them the change count
and **Send for review**. **Proposals N** opens the list of proposals: who, which page, when,
status; click one to see its page with its changes marked, each person in their own colour (your
own are magenta). **×** tucks the bubble into a tag on the right edge.

**Change a block.**

1. Click a block on the page (or the pencil next to it). The **Changes** tab opens with that
   block's text under "This block, as Markdown". (Markdown is the plain-text way the site's
   pages are written: `#` makes a heading, `**word**` makes bold.)
2. Change the text. The page shows your change a moment later, with the same block still
   picked. The line under the box says "Changed — kept as a draft in this browser, not proposed
   yet." Your draft stays in this browser (even when you close the tab) until you propose it.
3. The buttons above the box add a **Note box**, a **Warning**, **Tabs**, an **Attention** box,
   a **Video (a link)** or a **Repository card** at the cursor. **Insert link** adds a link to
   another page of the site (pick it under "Page to link to"). **Image from Media** adds a
   picture (section 7).
4. To add a new block, press the **+** between two blocks on the page and pick what to add:
   **Image**, **Note**, **Warning**, **Attention**, **Tabs**, **Video** or **Repo card**.
5. Some pages cannot be split into blocks. Then the tab says why, and
   **Edit whole page as Markdown** opens the whole page in one box. The same button works on
   any page.

The **Changes** tab edits setup pages, project pages, tool pages and the About page. On any
other page it says "The editor opens setup, project, tool and About pages. Go to one of them to
edit it."

**Propose your change.**

1. In the **Changes** tab, under "Your drafts, not proposed yet", click **Propose…** next to
   your draft. (**Discard** throws the draft away.)
2. In the box "What does this change do? (the proposal's title on GitHub)" write one short
   line. Check the list under "What goes in", then click **Propose**.
3. The editor says "Proposed as #n." and opens your proposal's card in the **Proposals** tab.
   From here it is reviewed like any other (section 2).

If you go to another page before you propose, your draft is kept. If you close the tab, the
browser asks first, because your drafts would be lost.

**Adding to your own open proposal.** When you have a proposal that is still open, the
**Changes** tab shows a "Start from:" choice. Pick "your proposal #n: <title>" and the page
shows that proposal's text; the tab says "Building on your proposal #n.", and the button
becomes **Add to proposal #n**. Your change becomes one more commit on that proposal, and the
editor says "Added to your proposal #n." Pick "the live site (a new proposal)" to start a new
one. This is also how you fix a red ✗ on your own proposal. Every changed draft on the same
starting point goes into the same proposal; "What goes in" lists them all.

**New project and New person.** At the bottom of the **Changes** tab, under **New**, click
**New project** or **New person**, fill in the form, and click **Make the draft** (project) or
**Add to the people draft** (person). Then propose it the same way. A new project is three files:
its story, its facts file `data/projects/<id>.json` and one entry (`id`, `add` and `remove`, both
lists empty) in `data/projects.json`; a site admin approves a new project. After that, the people
with edit access to the project (section 2b) approve changes to its two files (its story and its
facts). A person is one card on the About page; their
photo comes from **Photo from Media** (section 7). Both forms have the same "Start from:"
choice.

**The data files.** Under **Registries (raw JSON)** the **Changes** tab lists four data files
(people, projects, site, tools), edited as plain JSON text. JSON is a strict text format for
lists and fields. The "Locked ids" line above the text lists the ids you must not rename or
remove. **Discard changes** throws a data-file draft away.

**What the editor refuses.** When something is wrong, a red line says why and nothing is
proposed. The words, exactly as the editor shows them:

- A renamed or removed id: "data/projects.json: 'uvms' was removed or renamed — renaming or
  removing an existing id needs Desert Mango — open an issue". Put the old id back and ask
  Desert Mango (section 8).
- An id used twice: "the id 'uvms' is used twice — a new entry needs a new id".
- Broken JSON: "data/projects.json, line 5, column 19: a trailing comma before '}' — JSON allows
  none (strict JSON — no trailing commas, double quotes)". Go to that line and column and fix
  it.
- A new project whose id is taken: "a project with the id 'uvms' already exists — pick another
  id". An id must be "lowercase letters, digits and dashes (it is the page's address,
  /projects/<id>)".
- Someone changed the page on GitHub while you edited: "Not proposed: <file> changed on GitHub
  since you opened it. Your draft is kept: copy your text somewhere, press "Discard changes",
  open the page again and put your change back in."
- Your proposal was merged or closed meanwhile: "Your proposal #n is no longer open: discard
  these changes and start from the live site."

### The Team page: who is on the current team

The Team page (`#/team`) shows Lab activity, then the people: the **current team**, then the
**alumni**. A person whose GitHub account is linked to their card is on the current team when they
made a commit, a pull request or a review in the lab's repositories in the last 30 days. An admin
can **pin** a linked person to the list they are in: pinned to the team, they stay on the current
team without recent GitHub work; pinned to the alumni, they stay in the alumni even while they
work on GitHub. A person with no linked GitHub account stays in the list an admin put them in.

In `data/people.json` a pin is `"pinned": true` on the person. Its meaning comes from the group
the person is in: in the `active` group it pins them to the team, in the `alumni` group it pins
them to the alumni.

To change the lists, turn Editor on on the Team page:

1. **Move someone:** drag their card, or click it (or press Enter on it) for **Move up**, **Move
   down**, **Move to Alumni** / **Move to the current team**, and **Pin to the team** / **Unpin
   from the team** (on the current team) or **Pin to the alumni** / **Unpin from the alumni** (in
   the alumni). With the keyboard, Alt+Up and Alt+Down move the focused card.
2. A move pins a linked person only when the 30-day rule would send them back: moving someone who
   did no GitHub work lately onto the current team pins them to the team; moving someone who worked
   on GitHub in the last 30 days to the alumni pins them to the alumni. Any other move takes the
   pin off. The card then shows the word **Pinned**.
3. **Unpin** releases a person: the 30-day rule places them again. Unpinning someone in the alumni
   who worked on GitHub lately brings them back to the current team.
4. **Add someone:** the dashed **Add a person** card at the end of each list opens the New person
   form for that list.
5. **Send for review** proposes the new `data/people.json`. An admin approves people changes.

## 2. Review, approve and merge (Nathalie and Maintainers)

1. Sign in on the site (section 1b) and open the **Proposals** tab. (The direct address is
   `https://hippocampus-docs.vercel.app/#/?editor=proposals`.) Your role badge (Admin,
   Maintainer, Editor or Read-only) shows in the header.
2. The tab lists the **Open proposals** (yours first, marked "yours") and the
   **Recently merged** ones. A card says "touches this page" when the proposal changes the page
   on screen. Click a proposal's title: its card opens in place. Read the status line:
   - green ✓ "site rules pass": the gate is happy;
   - red ✗ "site rules fail": see section 3;
   - "still checking": the gate is still running. Wait a minute and reload;
   - "could not read the site rules check": the tab could not get the gate's result. Reload, or
     check the proposal on github.com.
3. Click **Show on page**. The page shows the proposal as it would look, with its changes
   marked: green is added or new, red is removed or old. The bar above the page says
   "Showing proposal #n on the page (read-only)." Nothing can be edited while it shows. If the
   proposal changes more than one page, the card has one button per page. **Back to your view**
   returns to the normal page. The card also lists the changed files, with "← this page" next to
   the file of the page on screen; click "The text diff" under a file to read the exact change.
   If the card says "Content only: …", the proposal also changes code, styles or other files
   that the page cannot show; read those under "Files changed".
4. If it looks right, click **Approve**. If the proposal is yours, the card answers "GitHub does
   not let you approve your own proposal". Ask another reviewer. Because you are Nathalie or a
   Maintainer, you may also merge your own proposal yourself if you are sure; lab members never
   merge their own.
5. Click **Merge**. The site updates by itself within a few minutes.
6. If something needs fixing, write what to fix in the box "What should change? (needed to
   request changes)" and click **Request changes**. If the proposal should not happen at all,
   click **Close**.

**Proposals drawn on the page.** You do not have to open the tray to see proposals. When an
open proposal changes the page on screen, Editor mode draws its changes on the page, and a bar
above the page says "<name> proposes changes to this page", with the link **PR #n**, the check
("check green", "check red", "check pending" or "check unknown") and the button
**Review in tray**, which opens its card. When more people propose changes to the same page, the
bar adds "Also proposing changes here:" with a **Show on page** button for each. Click a marked
block to open its proposal. The **View** tab turns this off ("Show others’ suggestions") and
switches the "Diff style" between **Inline** and **Side by side**. These settings are yours
only and stay in your browser.

**Approve one change at a time, on the page.** When a proposal is drawn on the page, a column
of cards stands beside it: one card per changed block, with who proposed it, when, and the
change in words ("Replace: … with …", "Add: …", "Delete: …"). Hover a card and its block gets the
blue line. If you may approve that page (an admin anywhere; a person with edit access to the
project on its pages; never your own proposal), the card has a check mark (**Approve**) and a
cross (**Reject**),
and the bar above the page has **Approve all (N)**.

- **Approve** puts that one change on the live site by itself, in about a minute: the card says
  "Approved. Going live… (about a minute)", and the page reloads with the change in place. The
  site's robot does it (`.github/workflows/go-live.yml`), after the same site rules as a merge;
  the commit carries the proposer's name.
- **Reject** marks the change as declined; it never goes live. Changed your mind? A declined card
  offers **Approve** again (the latest decision counts).
- When every change of a proposal is live or declined, the robot closes the proposal with
  "Everything here is live (or declined)."
- "Not live: site rules: …" means that change would break a site rule; it stays out, and the
  proposer should fix it (a new version of the proposal can be approved again). "This part
  changed on the site since it was proposed" means the live page moved on: use **Review** to ask
  for changes. If a card still says "Still waiting" after five minutes, follow its link to the
  robot's runs, or ask Desert Mango.
- Only proposals made in Editor mode that change existing pages can be approved this way.
  Anything else (a new page, a project's facts, the image list) is reviewed as a whole with
  **Review**, **Approve** and **Merge**.
- Once any change of a proposal was approved or declined on the page, the card in the
  Proposals tab no longer offers **Merge** (a merge would bring declined changes back). On
  github.com the **Merge** button still exists for a code owner; do not use it for such a
  proposal.
- **Talk about a change:** click its card. It opens the change's conversations (they are review
  comments on the proposal, so they show on github.com too), a **Reply** box, **Resolve** (or
  **Reopen**), and **Comment on this change** to start one. A closed card says how many comments
  the change has. Comments are shown as plain text.
- On a narrow window the cards become small round markers beside the page; click one to open
  its card. On a phone, **Review N changes** in the bar opens them as a sheet.

Two limits, stated plainly: anyone with write access can make a "this did not go live" note
appear on a card (it can stop a change from going live until the proposal is updated, never
make one go live); and when an admin is a proposal's author and its only valid code owner,
GitHub showed a non-owner's approval of it as enough (seen 15 October 2026), so admins ask
another admin, not a lab member, to approve their own proposals.

If Editor mode does not load, do the same review on github.com: open the pull request at
`https://github.com/desert-mango/hippocampus-docs/pulls`, check that the `check` line shows a
green ✓, open the **Files changed** tab, click **Review changes**, choose **Approve**, click
**Submit review**, then on the **Conversation** tab click **Squash and merge** and
**Confirm squash and merge**. github.com does not show the change on its page, so read the
changed text with care.

Other things the card and the bar can say:

- **Update from main** brings the proposal up to date with the newest main (the live site's
  files), without changing the proposal's own edits. If the card then says
  "This branch needs a human — ask Desert Mango.", ask Desert Mango.
- A dashed mark on a block means main changed that block after the proposal was made. The bar
  above the page then says "main changed this since the proposal — Update from main to bring it
  up to date." and has its own **Update from main** button.
- If **Merge** answers "Not merged: it changed since you looked, reload." (or **Update from main**
  answers "Not updated: it changed since you looked, reload."), someone changed the proposal
  while you were reading. Reload the page and look again before you merge.
- When the check is red ✗ or still checking, the first click on **Merge** does not merge: the
  card says "Site rules do not pass on this commit (or are still checking). A merge deploys
  nothing until main is green. Merge anyway?" and only a click on its **Merge anyway** button
  merges.
- A **machinery** badge ("needs a code review by Desert Mango") means the proposal touches the
  site's code: a file under `js/`, `css/`, `tools/`, `api/`, `cms/` or `.github/`, or
  `index.html` or `vercel.json`. Do not merge it. Ask Desert Mango.
- A **derived files** badge ("carries search/ or data/graph/ files, which the site regenerates
  after a merge") means the robot rebuilds those files after the merge, so no action is needed
  for that part.
- With the Read-only badge, a card says "You can read this proposal. Reviewing it needs write
  access to this site's repository." and shows no buttons.

## 2b. Who can edit which project (everyone)

The site knows who worked on what. Once a day it reads each person's commits across the lab's
GitHub repositories, and from that it builds one list per project: the people who can edit that
project. The rule, in order:

1. **An admin's "remove" wins.** If an admin removed you from a project, you cannot edit it, even
   with commits there.
2. **Commits count.** If you have at least one commit in any of the project's own repositories
   (the lab's repositories, not forks and not outside projects), you can edit the project.
3. **An admin's "add" counts too.** An admin can add you to a project even with no commits there.
4. Otherwise you cannot edit that project.

Admins and Maintainers can edit every project; the rule above is for lab members (Editors).

"Edit" means two things for a project's two files, its story `content/projects/<id>.md` and its
facts `data/projects/<id>.json`:

- **Change them in Editor mode.** An Editor can change only the projects they have edit access
  to. On any other project, Editor mode shows the page but lets you change nothing: no clicking
  a block, no "+", no new picture, no **Send for review**. The editor bubble says "You can't
  edit this project." with the reason and a **Request edit access** button (the same one as in
  the project's box, described below). On a project you can edit, the bubble says why in one line.
- **Approve and merge proposals** that change only those two files. The list is written into
  `.github/CODEOWNERS`, and GitHub's rule on `main` (section "Who can do what") uses that file.

Until the site has read the list, an Editor cannot change any project. The bubble says
"Checking who can edit this project…". If the list cannot be read, it says so, and the site
tries again a minute later. Admins and Maintainers never wait. Pages that are not a project
(setup, tools, the Team page, the home page) work as before: any Editor can propose a change, and
an admin or Maintainer approves it.

**What you see.** Signed in, with Editor mode off, every project page shows a small box above
its list of repositories. Its first line says one of:

- "You can edit every project (Admin)." or "(Maintainer)."
- "You can edit this project: you have commits in 2 of its 3 repos."
- "An admin gave you access to this project."
- "An admin removed your access to this project."
- "You have no commits in this project's repos yet."
- "You have commits here, but your GitHub account can't approve on this site yet: ask an admin
  to add you as a Write collaborator." (You are on the list, but you are not a member of the
  site's repository yet; section 6.)

Under it, **Who can edit** lists the people with edit access and why ("commits" or "added").

**To request edit access.** Click **Request edit access** in the box. The site opens a proposal
that adds your GitHub username to the project's `add` list in `data/projects.json` (and takes it
off the `remove` list, if it was there). The proposal shows in the Proposals tab with the label
"Access request". An admin merges it (yes) or closes it (no). After the merge, the site's robot
rebuilds the list within a few minutes. If you are signed in but not a member of the repository
(the Read-only badge), the button opens a prefilled issue on GitHub instead, and an admin takes
it from there.

**To add or remove someone (Admins).** On the project's page, the **Who can edit** list has a
**Remove** button next to each person, and a "GitHub login" field with an **Add person** button
under the list. Both open a
proposal (labelled "Access change") that changes the project's `add` or `remove` list. As an
admin you can merge it right away in the Proposals tab. Removing someone keeps them off the
project even if they have commits there; adding someone back takes them off the `remove` list.

**What GitHub enforces, and what the site only shows.** GitHub itself enforces only who
**approves** and who **merges**. A proposal that changes a project's files needs an approval from
someone on that project's list (or an admin), and a change to `data/projects.json` itself needs
an admin. The site's editor is what stops the editing: it does not let an Editor change a project
they have no access to. But a Write collaborator could still open a pull request on GitHub
directly, for any file. That pull request then needs an approved editor of that project, or an
admin, to merge it. So the site's buttons, the box and its words are a guide drawn from the same
list; GitHub is what stops a merge. Two more things to know:

- GitHub only counts a code owner who is a member of the repository with the Write role or
  higher. Someone with commits but no membership is on the list but cannot approve until an
  admin adds them (section 6).
- The list is rebuilt after every merge and once a day (the robot's `derive` run). GitHub turns
  off a daily run after 60 days without any change to the repository; if that happens, an admin
  opens `https://github.com/desert-mango/hippocampus-docs/actions/workflows/derive.yml`, clicks
  **Run workflow** from `main`, and the daily run is back.

## 3. When the check is red

A red ✗ means the proposal breaks one of the site's rules. The proposal's card lists each
problem under "What to fix (file, line, message):". The link "the full report" next to the
status line opens the full text on github.com. Fix the file on the same branch with the same
pencil, or in Editor mode with "Start from:" set to your proposal (section 1b), and the check
runs again by itself.

The three most common messages, exactly as the gate prints them:

**A comma after the last item.** JSON files (under `data/`) allow no comma after the last item
in a list, and only double quotes.

```text
✗ data/tools.json:12:37: Illegal trailing comma before end of array (strict JSON — no trailing commas, double quotes)
```

What to do: open that file, go to line 12, and delete the comma just before the `]` or `}`.

**A missing required key.** Each entry needs certain fields.

```text
✗ data/tools.json: tools[2] (id 'media-uploads') missing required key "tagline"
```

What to do: add the named field (here `"tagline"`) back to that entry.

**A renamed or removed id.** Some hand-made links in the site's graph point at page ids. The gate
refuses a change that breaks one.

```text
✗ data/graph/edges-authored.json: 'projects/radio-comms' is not a page or repository id any more — renaming or removing an existing id needs Desert Mango (docs/maintainer-protocols.md)
```

What to do: put the old id back so the check turns green, and ask Desert Mango to do the rename
or removal. Other red lines that name the same old id come from the same change and go away
with it.

A proposal that adds a whole project changes two files. Between the first and the second commit
the check is red; that is expected. Commit both files to the same proposal.

## 4. Roll a change back

1. In the **Proposals** tab, click the proposal under **Recently merged**. Its card says "This
   proposal was merged <date>." and shows one button: **Undo on GitHub**.
2. Click it. The proposal opens on github.com.
3. Click GitHub's **Revert** button, then **Create pull request**. This makes a new proposal
   that undoes the old one.
4. Back in the **Proposals** tab, the new proposal shows up like any other. **Approve** and
   **Merge** it. The site goes back to how it was.

Without Editor mode, open the merged pull request on github.com directly (the **Closed**
filter on the pull request list) and start at step 3.

## 5. The robot's "derive" commit, and the short wait after a merge

After every merge, a robot (`hippocampus-derive[bot]`) rebuilds the site's search index and graph
data and commits them to the site. Its commit is named
`derive: regenerate derived data after <short sha>`, where `<short sha>` is the short code
GitHub gives the merge's commit. This is normal and needs nothing from you.

A merge that adds or removes a page takes a little longer: the live site keeps showing the old
version for one to three minutes, until the robot's commit goes live. This holds once Desert
Mango's one-time test has shown that the robot's commits go live on their own. Until then, if a
new page has not appeared after ten minutes, tell Desert Mango.

## 6. Add or remove a member (Admins)

1. Open `https://github.com/desert-mango/hippocampus-docs/settings/access`. (Signed in as an
   Admin, the **Guide** tab has the same link: **Manage people**.)
2. Click **Add people**, type the person's GitHub username, and choose their role:
   - **Write** for lab members;
   - **Maintain** for trusted reviewers;
   - **Admin** only for Nathalie (and Desert Mango).
3. Confirm. The person gets an invitation from GitHub and must accept it.
4. To remove someone, find them in the same list and remove them.

Someone without a role can still sign in. They get the Read-only badge: they can look at
proposals, but they cannot propose or review. Adding them with a role fixes that; they reload the
page to see their new badge.

## 7. Pictures

The site's pictures are stored on Cloudinary (an image host). Editor mode uploads a picture
there and adds it to the site's image list (`data/cloudinary-manifest.json`). That change waits
in a draft called "Site image list" and goes into the same proposal as the page that uses the
picture.

**Replace or move a picture (the usual way, since 14 October 2026):** in Editor mode, click the
picture on the page. Your computer's file dialog opens: pick the new file. The editor uploads it
and the page shows the new picture. To move a picture, drag it to another place on the page
(or click it once and press Alt+Up or Alt+Down). To add one, press **+** between two blocks and
pick **Image**: the file dialog opens the same way.

**Put a picture in with the Markdown box:**

1. Pick the block on the page where the picture should go (section 1b). In the **Changes** tab,
   put the cursor where the picture should go and click **Image from Media**.
2. Pick a folder next to "Upload to", choose the file, and click **Upload**. The editor shows the
   limits: "Images only (PNG, JPEG, GIF or WebP). Keep images under 5 MB." Or pick a picture the
   site already has under "Or use one the site has:".
3. Under "Describe the image (alt text)" write what the picture shows, for people who cannot see
   it. Then click **Insert into page**. The editor writes `![your words](address)` at the cursor.
4. Propose as usual. "What goes in" lists two files: "Site image list" and your page.

**A person's photo:** in **New person**, click **Photo from Media**, upload or pick the photo, and
click **Use as photo**.

**The image library:** open the editor page's **Data** tab and click **The image library** (the
direct address is `https://hippocampus-docs.vercel.app/#/?editor=media`). It lists every picture with "on the
site", "in your image-list draft" or "not used by the site". You can upload there too, but each
new picture must be used on a page in the same proposal: the site's rules refuse an image
nothing uses. So go to the page, pick a block, press **Image from Media** and pick the picture.
**Discard the image-list draft** throws away the image-list change (the pictures stay on
Cloudinary, unused, and you can delete them there).

**What the image library refuses, in its own words:**

- A file over 5 MB: "<name> is <n> MB. Keep images under 5 MB: make it smaller and choose it
  again."
- Any other file type: "<name> is not a PNG, JPEG, GIF or WebP image." SVG pictures are refused
  on purpose, because an SVG file can carry code.
- A picture the site already has (the tab compares the file's contents, not its name): "This
  image is already on the site: <address>. Use that one; nothing was uploaded."
- A name that is taken: "An image named <name> is already in <folder>. Rename your file and
  choose it again."
- Deleting a picture the site uses: "The site uses this image: remove it from the page first,
  merge, then delete." The live site shows the picture until the merge, so deleting it first
  would break the live page at once. Take it off the page, propose, merge, then click
  **Delete**. Deleting cannot be undone ("Delete <id> from Cloudinary? This cannot be undone.").
- When the tab is not set up yet: "Media is not set up on this site yet (its Cloudinary keys are
  missing). Ask Desert Mango."

## 8. Things only Desert Mango does

Ask Desert Mango (`desert-mango.com`) for:

- any proposal with a **machinery** badge;
- renaming or removing an existing id (a project, a tool, a setup page, a people group);
- a new setup page, or a new section in the setup pages;
- a picture the Media tab cannot take (an SVG, for example), or when the tab says it is not set
  up yet;
- a branch that "needs a human";
- a members-only panel that says "tell Desert Mango" (section 9);
- anything this page does not answer.

Proposals from people outside the lab (from a fork) work too, but GitHub makes their first
proposal wait until a maintainer clicks **Approve and run**. That button is only for outsiders;
lab members never see it.

## 9. What signed-in lab members see on the public pages

Signed in with the Editor badge or higher, and with Editor mode **off**, the normal pages show a
little more than guests see: who committed what, read live from GitHub. (A commit is one saved
change in a repository's history.)

- The **Lab** page shows "People committing this year": for each person, their commits in the
  last 365 days across the lab's public repositories.
- A person's pop-up card (click a person on the Lab or About page) shows their commits this
  year, their projects and their recent commits.
- The "who wrote this" box at the bottom of a page lists the commits per author from the page's
  history.

Each of these says "Members only: read live from GitHub with your sign-in, kept 15 minutes in
this tab, never stored." Nothing of it is saved in the repository, and guests never see it. A
very long history is cut at its newest commits, and the count then says "at least". If GitHub
refuses a read, the panel says "GitHub answered <number> for <repository> — tell Desert Mango";
tell Desert Mango.
