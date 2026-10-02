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
  while you look at it. You turn it on and off with the **Editor** switch in the header.
- **The tray:** the Editor's panel on the right side of the screen (at the bottom on a phone).
  It has five tabs: **Proposals**, **Changes**, **Media**, **View** and **Guide**.
- **Block:** one piece of a page, such as a heading, a paragraph, a list, a picture or a note
  box. In Editor mode you click a block to change it.
- **Draft:** a change you made that is not proposed yet. It stays in your browser tab only.

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
6. **A "derive" commit is:** the robot (`github-actions[bot]`) rebuilding the site's search index
   and graph data right after a merge; it needs nothing from you.
7. **For a "machinery" badge:** do not merge; ask Desert Mango, who reviews every change to the
   site's code.
8. **When a rename or removal is refused:** put the old id back so the check turns green, and ask
   Desert Mango to do the rename or removal for you.
9. **To edit a page in the site editor:** open the page on the site, click **Edit this page**
   at the bottom (or **Sign in to edit** if you are not signed in yet), click the block you want
   to change, change its text in the **Changes** tab, then click **Propose…** and **Propose**
   (section 1b).

The old editor addresses (`/cms/#/review`, `/cms/#/pages`, `/cms/#/media` and the rest) still
work: each one sends you to the same place in Editor mode.

For anything else, contact Desert Mango through `desert-mango.com`, or open an issue on the
repository.

## Who can do what

| GitHub role on the repo | Badge in the header | Who | What they do |
|---|---|---|---|
| Admin | Admin | Nathalie, Desert Mango | Everything, including adding and removing people |
| Maintain | Maintainer | Trusted reviewers that Nathalie names | Review, approve, request changes, merge, update from main (bring a proposal up to date with the newest main) |
| Write | Editor | Lab members | Edit and propose changes, and upload pictures; a proposal's card shows them **Approve**, **Request changes**, **Update from main** and **Close**, but no **Merge** button. An Editor's **Approve** records their review on the proposal; it does not merge it |
| Read, or none | Read-only | Everyone else | Can read the public site and look at proposals; cannot propose or review |

The badge shows in the header, next to your name, once you are signed in.

Nathalie and the Maintainers merge. An Editor's **Approve** is a useful second opinion, but
only Nathalie or a Maintainer turns a proposal into a merge. A Write member could still merge on
github.com, because nothing on the repository blocks a merge on purpose. The rule is simply: lab
members propose, Nathalie and the Maintainers merge.

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
Editor mode on with the **Changes** tab open. The tray starts closed: the tab
**Editor · N proposals** on the right edge opens it, and **×** hides it again.

**Change a block.**

1. Click a block on the page (or the pencil next to it). The **Changes** tab opens with that
   block's text under "This block, as Markdown". (Markdown is the plain-text way the site's
   pages are written: `#` makes a heading, `**word**` makes bold.)
2. Change the text. The page shows your change a moment later, with the same block still
   picked. The line under the box says "Changed — kept as a draft in this tab, not proposed
   yet." Your draft lives only in this browser tab until you propose it.
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
**Add to the people draft** (person). Then propose it the same way. A new project is two files:
its story and one entry in `data/projects.json`. A person is one card on the About page; their
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

After every merge, a robot (`github-actions[bot]`) rebuilds the site's search index and graph
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

## 7. Pictures: the Media tab

The site's pictures are stored on Cloudinary (an image host). Editor mode uploads a picture
there and adds it to the site's image list (`data/cloudinary-manifest.json`). That change waits
in a draft called "Site image list" and goes into the same proposal as the page that uses the
picture.

**Put a picture on a page (the usual way):**

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

**The Media tab itself:** open the tray's **Media** tab (the direct address is
`https://hippocampus-docs.vercel.app/#/?editor=media`). It lists every picture with "on the
site", "in your image-list draft" or "not used by the site". You can upload there too, but each
new picture must be used on a page in the same proposal: the site's rules refuse an image
nothing uses. So go to the page, pick a block, press **Image from Media** and pick the picture.
**Discard the image-list draft** throws away the image-list change (the pictures stay on
Cloudinary, unused, and you can delete them there).

**What the Media tab refuses, in its own words:**

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
