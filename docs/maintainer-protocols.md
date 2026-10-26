# Maintainer protocols: how the lab runs this site

*Written 21 September 2026 for the day-one path: edit on github.com, then review, approve and
merge in the site's Review tab. Updated 22 September 2026: the site editor (section 1b) and the
Media tab (section 7). Updated 2 October 2026: the site editor now lives on the site's own pages
(Editor mode), and the old editor at `/cms/` is gone (see the note after the quick answers).
Updated 26 October 2026: Editor mode now works from one small bubble on the page. The Guide,
the View settings, the proposals list, the review screen, the image library page, the page list
and the Send box are gone; you send, review and approve from the bubble and the page itself.
The github.com pencil (section 1) stays as a second way to make a change.*

This page is for Nathalie (the site's owner) and for lab members. You do not need to code.
You need a GitHub account and a web browser.

A few words used on this page:

- **Pull request (PR), or proposal:** a proposed change. Nothing on the live site changes until
  someone merges it. In Editor mode you never see these words: there you **send** your changes
  for review, and a reviewer **approves** them (they go live) or **denies** or **declines** them.
- **Merge:** accept a proposal. The site then updates by itself.
- **Branch:** a separate line of work in the repository. Each proposal lives on its own branch.
- **Main:** the repository's main branch. The live site is built from it, and a merge puts a
  proposal into it.
- **Repository (repo):** the folder of files the site is built from,
  `https://github.com/desert-mango/hippocampus-docs`.
- **The gate:** the site's rule checker (`tools/check.py`). It runs on every proposal and
  gives a green ✓ or a red ✗.
- **Editor mode:** the site editor. It works on the site's own pages, so you change a page
  while you look at it. You turn it on and off with the **Editor** switch in the bubble.
- **The bubble:** the small box at the top right of the page, under the header, once you are
  signed in. Its first row holds your photo, your role (**Admin**, **Can approve…**, **Can edit**
  or **Read only**), the **Editor** switch and **×**. Under it, rows appear only when they have
  something to say: your unsent changes, the sends waiting for you to review, and your own sends.
- **The editor page:** a plain page that is left only for two jobs: editing a whole page as
  Markdown, and the site's raw data files. You open it from the menu on your photo in the bubble
  (**Edit whole page as Markdown** or **Data files**).
- **Block:** one piece of a page, such as a heading, a paragraph, a list, a picture or a note
  box. In Editor mode you click a block to change it.
- **Draft:** a change you made that is not sent yet. It stays in this browser, even when you
  close the tab or reload, until you send it for review. Signing out keeps it too: it comes back
  the next time you sign in, in the same browser.

## Quick answers

1. **To approve a change:** sign in on the site and turn **Editor** on. In the bubble, click
   **N to review**, then click a row. The page opens with the changes marked, and a card stands
   beside each changed block: click **Approve** on each card, or **Approve all** on the row. For
   a project's facts, the team, a new project or an access request, click **Approve** on the row
   itself (section 2).
2. **A red ✗ means:** the change breaks one of the site's rules. In the bubble, the row's dot is
   red, and the first click on **Approve** says the problems in plain words. The three most
   common are a comma after the last item in a JSON file, a missing required key, and a renamed
   or removed id (all three are quoted below).
3. **To roll a change back:** on github.com, open the change that went live (section 4), click
   GitHub's **Revert** button, then **Create pull request**, and approve the new change like any
   other.
4. **To add a member:** an Admin opens
   `https://github.com/desert-mango/hippocampus-docs/settings/access`, clicks **Add people**, and
   gives the role Write to lab members, Maintain to trusted reviewers, and Admin only to Nathalie.
5. **To add a picture:** in Editor mode, press the **+** between two blocks, pick **Image**, then
   **Upload** a PNG, JPEG, GIF or WebP image under 5 MB, or **Pick one the site has**. To replace
   a picture, click it. Then click **Send for review** in the bubble (section 7).
6. **A "derive" commit is:** the robot (`hippocampus-derive[bot]`) rebuilding the site's search index
   and graph data right after a merge; it needs nothing from you.
7. **For a "machinery" badge:** do not merge; ask Desert Mango, who reviews every change to the
   site's code.
8. **When a rename or removal is refused:** put the old id back so the check turns green, and ask
   Desert Mango to do the rename or removal for you.
9. **To edit a page in the site editor:** open the page on the site, click **Sign in** at the
   top right (the first time), and turn on the **Editor** switch in the bubble. Click the block
   you want to change and type. Then click **Send for review** in the bubble (section 1b).
10. **To get edit access to a project:** sign in, open the project's page, and read the
   small box above the project's repositories (its list is headed **Who can edit**). Its first
   line says whether you can edit the project and why. If you cannot, click
   **Request edit access** (in Editor mode it sits in the line under the project's title); an
   admin approves or declines it from the bubble (section 2b).

The old editor addresses still work. `/cms/#/…`, `#/media`, `#/pages`, `#/help`, `#/view` and
`?editor=…` open the page with the bubble open; `#/review/<n>` opens that send on its page.

For anything else, contact Desert Mango through `desert-mango.com`, or open an issue on the
repository.

## Who can do what

| GitHub role on the repo | Role in the bubble | Who | What they do |
|---|---|---|---|
| Admin | Admin | Nathalie, Desert Mango | Everything, including adding and removing people; sees and approves every send |
| Maintain | Can approve | Trusted reviewers that Nathalie names | Review, approve and decline sends inside the projects they have edit access to (section 2b); on github.com also merge and update from main (bring a proposal up to date with the newest main) |
| Write | Can edit, or Can approve N projects | Lab members | Edit pages, send them for review, and upload pictures (a project's pages: only the projects they have edit access to, section 2b). Inside those projects they also see others' sends and can approve or deny them; the bubble then says **Can approve N projects** |
| Read, or none | Read only | Everyone else | Can read the public site; cannot send or review |

The role shows in the bubble, next to your photo, once you are signed in. The rest of this page
still says "Editor" for the Write role and "Read-only" for the last row.

Only the people who may approve a send see it in the bubble. Everyone else sees only their own
sends. This is how the site looks, not a lock: the repository is public on github.com, where
anyone can read every pull request. The real approval rules are GitHub's (below) and the robot's
(section 2), and they did not change.

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
   (In Editor mode, **Edit whole page as Markdown** in your photo's menu shows the file of the
   page on screen, with the link **edit on github.com instead**.)
2. Open the file on github.com and click the **pencil icon** (top right of the file view).
3. Make your edit. Click the **Preview** tab to check the text.
4. Click **Commit changes…**. In the box that opens, choose
   **Create a new branch for this commit and start a pull request**, then click
   **Propose changes**, then **Create pull request**.
5. Your proposal now shows in the bubble's **N to review** list for the people who may approve
   it (section 2).

You are a collaborator, so your branch lives in the repository itself. There is no fork and no
"Approve and run" button to wait for. The check starts on its own.

## 1b. Make a change in Editor mode (lab members)

Editor mode does the same as section 1, on the page itself. You need the Write role or higher
(the bubble says **Can edit**, **Can approve…** or **Admin**). With **Read only** you can look,
and the editor page says "View only: changing pages needs write access to this site's
repository." You can still propose a change on github.com (section 1).

**Sign in and turn Editor mode on.**

1. Open the page you want to change on the site.
2. Click **Sign in** at the top right of the header. A GitHub window opens; sign in there. The
   window closes by itself. Messages about the sign-in show next to the **Sign in** button. If
   your browser blocks the pop-up window, the sign-in goes on in the same tab and brings you back
   to your page.
3. The bubble appears at the top right, under the header: your photo, your role, the **Editor**
   switch and **×**. Turn the switch on. The page looks the same; you can now click its blocks.
   Click the switch again to turn Editor mode off.

You stay signed in when you reload the page or open the site in another tab, for up to 8 hours
(that is how long GitHub's sign-in lasts). Then you sign in again. To sign out, click your photo
in the bubble, then **Sign out**. This signs you out in every open tab of the site. Your unsent
changes stay in this browser and come back the next time you sign in here.

**The bubble.** It shows only what has something to say:

- **N pages changed · ↶ ↷ · Send for review** when you have changes that are not sent yet.
  The arrows undo and redo. Click **N pages changed** to see the list: each row is a page, how
  many blocks changed, and **Send this page**. Click a page's title to go to it with your
  changes marked.
- **N to review** when someone else's send waits for you (only for people who may approve it,
  section 2).
- **N sent · waiting** when you have sends of your own. Click it to see each one as
  **Waiting**, **Live** (it is on the site), **Declined** or **Seen** (a reviewer read your notes).

**×** folds the bubble into a small photo tab; click the photo to open it again. The bubble also
folds by itself when you scroll the page or start typing. On a phone, the bubble is a round photo
button at the bottom right; tap it, and the same rows open as a sheet from the bottom (drag it
down or press Escape to close it).

**Change a block.**

1. Click a block on the page. A thin line marks it, and a small toolbar sits at its top:
   **B** (bold), **I** (italic), **Link**, **Code**, **List** and **Comment**. A note box also has
   **Type ▾** (Note, Tip, Important, Warning, Danger); a code block has **Language ▾** (Shell,
   Python, YAML and the rest). The first four buttons work on words you select first; with
   nothing selected they say "Select some words first." **List** turns the block into a bulleted
   list, a second click makes it numbered, a third takes the list away.
2. Type your change straight into the page. The words you add and the words you strike out are
   marked in orange (yellow in dark mode). Your changes stay in this browser, even when you
   reload or close the tab, and so do the marks and the undo steps.
3. **Comment** adds a note beside the block without changing its text: a small card,
   "Your note", with a box to write in (and **Remove**). Your notes go with your send, and
   reviewers see them as note cards beside the block.
4. To add a new block, move the pointer to the gap between two blocks, click the **+** that
   shows, and pick a tile: **Image** (section 7), **Note**, **Tabs**, **Video** or **Repo** (a
   repository card). For a note box, pick its kind afterwards with **Type ▾**.
5. To remove a note box or a code block, open **Type ▾** (or **Language ▾**) and pick the last
   item, **Remove this box**. "Removed · Undo" shows for 8 seconds; click **Undo** to bring it
   back, or use the bubble's ↶.
6. Some pages cannot be split into blocks, and some changes are easier in one box. Click your
   photo in the bubble, then **Edit whole page as Markdown**: the editor page opens with the
   whole page in one box. (Markdown is the plain-text way the site's pages are written: `#`
   makes a heading, `**word**` makes bold.)

**Send it for review.**

1. Click **Send for review** in the bubble. That is all: there is no box to fill in. (To send
   only one page, open the **N pages changed** list and click **Send this page**.)
2. The bubble says "Sent · waiting for review", with **Undo** for 8 seconds. **Undo** takes the
   send back and puts your changes back as they were. If someone acted on the send in those
   seconds, it says "Can't undo: the send changed since" and leaves it alone.
3. The site names each send for you: "Edit <page>", "Edit 3 pages: …", "Update <project>
   facts", "Update the team" or "New project: <name>".
4. Different kinds of change go as separate sends, because they are reviewed in different ways.
   All your page edits go together, and a reviewer can approve them one block at a time. A
   project's facts, a change to the team, a new project and an access request each go as their
   own send, and a reviewer approves or declines each one whole.
5. If you already have an open send of the same kind for that page, your new change is added to
   it ("Added to your send"). This is also how you fix a red ✗ on your own send: change the page
   again and click **Send for review**.

From here it is reviewed (section 2). Your send shows under **N sent · waiting** until it goes
live or is declined.

**Project pages.** On a project you have edit access to (section 2b), you can also click the
project's title, its one-line description, its status (a small menu of the allowed values) and
its list of repositories (add or remove one by name), and change them in place. These are the
project's facts (`data/projects/<id>.json`); one click on **Send for review** sends them as their
own send, beside the story's. On a project you cannot edit, a line under the title says "Only
this project's editors can change it · Request edit access".

**New project and new page.** With Editor mode on, the Projects page ends with a
**+ New project** card. It opens a small form: the id (lowercase letters, digits and dashes; it
is the page's address, /projects/<id>), the name, a one-line description and the status. Send it
like any other change. A new project is three files: its story, its facts file
`data/projects/<id>.json` and one entry (`id`, `add` and `remove`, both lists empty) in
`data/projects.json`; a site admin approves a new project. After that, the people with edit
access to the project (section 2b) approve changes to its story and its facts. Each group in the
side menu ends with **+ New page**. It opens a GitHub issue that is already filled in, because
the setup pages are made from the lab's source files by a script (`tools/rst_convert.py`), not
by hand; Desert Mango adds the page.

**The data files.** Click your photo in the bubble, then **Data files**. The editor page lists
the site's data files (people, projects, site, tools, and the site's image list), edited as
plain JSON text. JSON is a strict text format for lists and fields. The "Locked ids" line above
the text lists the ids you must not rename or remove. **Discard changes** throws a data-file
draft away; **Send for review** sends it.

**What the editor refuses.** When something is wrong, a red line says why and nothing is sent.
The words, exactly as the editor shows them:

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
- Someone changed the page on GitHub while you edited: "<file> changed on GitHub since you
  opened it. Your draft is kept: copy your text somewhere, press "Discard changes", open the
  page again and put your change back in". **Discard changes** is on the editor page.
- Your send went live or was declined meanwhile: "Your send #n is no longer open: discard these
  changes and start from the live site."

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

Admins change the Team page in Editor mode, on the Team page itself:

1. **Change a name or a title:** click it and type. Enter (or a click elsewhere) keeps it;
   Escape puts the old words back.
2. **Change a photo:** click the photo and pick the new file (section 7).
3. **Move someone:** drag their card by its grip (the six dots that show when you point at the
   card), inside a list or between the current team and the alumni. Without a mouse, move the
   keyboard focus to the card: **Move up**, **Move down** and **Move to Alumni** (or
   **Move to Current team**) show on it. Alt+Up and Alt+Down also move the focused card.
4. A move pins a linked person only when the 30-day rule would send them back: moving someone who
   did no GitHub work lately onto the current team pins them to the team; moving someone who worked
   on GitHub in the last 30 days to the alumni pins them to the alumni. Any other move takes the
   pin off. A pinned card shows a small pin; point at it to read "Pinned: stays on the current
   team" or "Pinned: stays with the alumni". There is no separate pin button: a pin comes off
   when a move puts the person in the list the 30-day rule would put them in anyway.
5. **Remove someone:** point at the card (or give it the keyboard focus) and click the small
   **×**. "Removed · Undo" shows for 8 seconds; click **Undo** to bring the card back.
6. **Add someone:** click the **+** card at the end of a list. It turns into an empty card right
   there, with **GitHub account**, **Name**, **Title** and **Link**. Tick
   **Choose a profile image after adding** to pick the photo next, then click **Add**. The GitHub
   account links the card to the person's GitHub work (it is written to `data/github-links.json`
   in the same send).
7. Click **Send for review** in the bubble. The team changes go as one send, "Update the team",
   and an admin approves it.

**Lab members** may change only their own card, and only its name and photo (not the title).
Your own card is the one linked to your GitHub account. When you rename yourself, the same send
also updates your line in `data/github-links.json`, so your card stays linked to your GitHub work.
An admin approves it. Anything else on the Team page says "Only an admin can change the Team
page."

Inviting someone to the lab's GitHub organisation is not done from the site; an admin does it on
github.com (section 6).

## 2. Review, approve and merge (Nathalie and Maintainers)

**Who sees what.** Admins see every send. Maintainers and lab members see the sends inside the
projects they have edit access to (section 2b): a project's story and facts. Sends that touch
anything else (setup and tool pages, the Team page, new projects, access requests, the site's
data) reach the admins only. Nobody sees their own send in the review list.

**Open a send.**

1. Sign in on the site (section 1b) and turn **Editor** on. When something waits for you, the
   bubble shows **N to review**.
2. Click **N to review**. The list opens in the bubble. Each row shows the sender's photo and
   name, the page (or "3 pages"), when, a dot for the site rules (green: they pass; red: they
   fail, section 3; amber: still checking; grey: not read yet), and the kind of change when it is
   not a page edit: "project facts", "new project", "people", "access request", "site data" or
   "note".
3. Click a row. The site opens the first changed page, scrolls to the first change and marks
   the changes: new words in one colour, removed words struck out. The top of the bubble says
   "Viewing <name>'s changes", with **Back**. **Back** (or going to another page) returns to the
   normal page.

**Approve page edits, one block at a time.** Beside each changed block stands a card: the
sender's photo, when, and the change in words ("Replace: … with …", "Add: …", "Delete: …"). On a
narrow window the cards become small markers beside the page; click one to open its card. On a
phone the cards sit under their block.

- **Approve** puts that one change on the live site by itself, in about a minute: the card says
  "Approved. Going live… (about a minute)", and then the page shows the change in place. The
  site's robot does it (`.github/workflows/go-live.yml`), after checking the site rules;
  the change carries the sender's name.
- **Deny** marks the change as declined; it never goes live. Changed your mind? A declined card
  offers **Approve** again (the latest decision counts).
- **Comment** opens the change's conversation under the card: a **Reply** box, **Resolve** (or
  **Reopen**), and **Comment on this change** to start one. The comments also show on
  github.com. Comments are shown as plain text.
- **Approve all** on the row in the bubble approves every change of the send at once.
- A sender's notes (section 1b) show as cards named "<name>'s note" beside their block. A send
  that holds only notes has **Done** on its row: click it when you have read them. The sender
  then sees it as **Seen**.
- When every change of a send is live or declined, the robot closes it with
  "Everything here is live (or declined)."
- "Not live: …" means that change would break a site rule; it stays out, and the sender should
  fix it (a new version can be approved again). "This part changed on the site since it was
  proposed. Comment to ask for changes." means the live page moved on. If a card still says
  "Still waiting to go live" after five minutes, follow its link to the robot's runs, or ask
  Desert Mango.

**Approve a whole send.** A project's facts, a change to the team, a new project and an access
request are reviewed whole: their row has **Approve** and **Decline**. **Approve** puts the whole
send on the site; **Decline** closes it, and nothing of it goes live. When the site rules are red
or still checking, the first click on **Approve** does not approve: the row says why in plain
words (for example "The site rules do not pass on this proposal: …"), and the button becomes
**Approve anyway**. Only a second click approves. A change to the site's code never goes through
the bubble; Desert Mango reviews it (section 8).

If you sent the change yourself, you cannot approve it: GitHub does not let anyone approve their
own send. Ask another reviewer.

Two limits, stated plainly: anyone with write access can make a "this did not go live" note
appear on a card (it can stop a change from going live until the send is updated, never
make one go live); and when an admin is a proposal's author and its only valid code owner,
GitHub showed a non-owner's approval of it as enough (seen 15 October 2026), so admins ask
another admin, not a lab member, to approve their own proposals.

If Editor mode does not load, do the same review on github.com: open the pull request at
`https://github.com/desert-mango/hippocampus-docs/pulls`, check that the `check` line shows a
green ✓, open the **Files changed** tab, click **Review changes**, choose **Approve**, click
**Submit review**, then on the **Conversation** tab click **Squash and merge** and
**Confirm squash and merge**. github.com does not show the change on its page, so read the
changed text with care. Do not merge a pull request there once some of its changes were approved
or denied on the page: a merge would bring the denied changes back. Do not merge one that
touches the site's code (a file under `js/`, `css/`, `tools/`, `api/`, `cms/` or `.github/`, or
`index.html` or `vercel.json`): ask Desert Mango.

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
  a block, no "+", no new picture, no **Send for review**. A line under the project's title
  says "Only this project's editors can change it · Request edit access", and the bubble says
  "You can't edit this project." with the reason and the same **Request edit access** button
  (the same one as in the project's box, described below).
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

**To request edit access.** Click **Request edit access** in the box. The site sends a change
that adds your GitHub username to the project's `add` list in `data/projects.json` (and takes it
off the `remove` list, if it was there). It reaches the admins' review list in the bubble, marked
"access request". An admin clicks **Approve** (yes) or **Decline** (no). After the approval, the site's robot
rebuilds the list within a few minutes. If you are signed in but not a member of the repository
(the Read-only badge), the button opens a prefilled issue on GitHub instead, and an admin takes
it from there.

**To add or remove someone (Admins).** On the project's page, the **Who can edit** list has a
**Remove** button next to each person, and a "GitHub login" field with an **Add person** button
under the list. Both send a
change (named "Edit access: <project>") that changes the project's `add` or `remove` list.
Another admin approves it from the review list in the bubble (your own sends never show there),
or you merge it yourself on github.com, as an admin may. Removing someone keeps them off the
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

A red ✗ means the change breaks one of the site's rules. In the bubble, the send's row has a red
dot, and the first click on **Approve** names the first problems in plain words. The full list is
on github.com: open the pull request at `https://github.com/desert-mango/hippocampus-docs/pulls`
and click **Details** next to the red `check`. Fix the file on the same branch with the same
pencil, or in Editor mode: change the page again and click **Send for review**, and the fix is
added to your open send (section 1b). The check runs again by itself.

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

1. On github.com, open the list of finished pull requests:
   `https://github.com/desert-mango/hippocampus-docs/pulls?q=is%3Apr+is%3Amerged`.
2. Click the pull request of the change you want to undo.
3. Click GitHub's **Revert** button, then **Create pull request**. This makes a new pull request
   that undoes the old one.
4. The new one shows in the bubble's review list like any other. Approve it (or merge it on
   github.com, section 2). The site goes back to how it was.

A page edit approved on the page (section 2) goes live through the robot, and its pull request is
closed, not merged, so it is not in that list. Undo it in Editor mode instead: change the block
back and send it for review.

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

1. Open `https://github.com/desert-mango/hippocampus-docs/settings/access`.
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
there and adds it to the site's image list (`data/cloudinary-manifest.json`). That change goes
into the same send as the page that uses the picture.

**Replace or move a picture:** in Editor mode, click the picture on the page. Your computer's
file dialog opens: pick the new file. The editor uploads it and the page shows the new picture.
To move a picture, drag it to another place on the page (or click it once and press Alt+Up or
Alt+Down).

**Add a picture:**

1. Press the **+** in the gap where the picture should go, and pick the **Image** tile.
2. Click **Upload** and choose a file. The limits: "Images only (PNG, JPEG, GIF or WebP). Keep
   images under 5 MB."
3. Or click **Pick one the site has**: a grid of the pictures the site already has opens under
   the tiles. Click one to put it in. (This grid is the site's image library now; the old library
   page is gone.)
4. Click **Send for review** in the bubble. The picture and the page go in the same send.

**A person's photo:** on the Team page, click the photo and pick the new file (an admin, or the
person on their own card; see "The Team page" above). For a new person, tick
**Choose a profile image after adding** on the empty card.

**Undo an upload you do not want:** take the picture off the page again. Every new picture must
be used on a page in the same send: the site's rules refuse an image nothing uses. To throw the
image-list change away, click your photo in the bubble, then **Data files**, open the image list
and click **Discard changes** (the picture stays on Cloudinary, unused; Desert Mango can delete
it there).

**What the editor refuses, in its own words:**

- A file over 5 MB: "<name> is <n> MB. Keep images under 5 MB: make it smaller and choose it
  again."
- Any other file type: "<name> is not a PNG, JPEG, GIF or WebP image." SVG pictures are refused
  on purpose, because an SVG file can carry code.
- A picture the site already has (the editor compares the file's contents, not its name): "That
  image is already on the site: the page uses it now. Nothing was uploaded."
- A name that is taken: "An image named <name> is already in <folder>. Rename your file and
  choose it again."
- When uploads are not set up yet: "Media is not set up on this site yet (its Cloudinary keys are
  missing). Ask Desert Mango."

## 8. Things only Desert Mango does

Ask Desert Mango (`desert-mango.com`) for:

- any proposal with a **machinery** badge;
- renaming or removing an existing id (a project, a tool, a setup page, a people group);
- a new setup page, or a new section in the setup pages;
- a picture the editor cannot take (an SVG, for example), or when it says Media is not set up
  yet; and deleting a picture from Cloudinary;
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
