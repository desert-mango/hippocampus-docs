# Maintainer protocols: how the lab runs this site

*Written 21 September 2026 for the day-one path: edit on github.com, then review, approve and
merge in the site's Review tab. Updated 22 September 2026: the site editor (section 1b) and the
Media tab (section 7) are here now. The github.com pencil (section 1) stays as a second way to
make a change.*

This page is for Nathalie (the site's owner) and for lab members. You do not need to code.
You need a GitHub account and a web browser.

A few words used on this page:

- **Pull request (PR):** a proposed change. Nothing on the live site changes until someone
  merges it.
- **Merge:** accept a pull request. The site then updates by itself.
- **Branch:** a separate line of work in the repository. Each proposal lives on its own branch.
- **Main:** the repository's main branch. The live site is built from it, and a merge puts a
  proposal into it.
- **Repository (repo):** the folder of files the site is built from,
  `https://github.com/desert-mango/hippocampus-docs`.
- **The gate:** the site's rule checker (`tools/check.py`). It runs on every pull request and
  gives a green ✓ or a red ✗.

## Quick answers

1. **To approve a proposal:** open `https://hippocampus-docs.vercel.app/cms/#/review`, click the
   proposal, check the green ✓ "site rules pass" line and the preview, then click
   **Approve** and then **Merge**.
2. **A red ✗ means:** the proposal breaks one of the site's rules, and the Review tab lists each
   problem under "What to fix (file, line, message):"; the three most common are a comma after the last item in
   a JSON file, a missing required key, and a renamed or removed id (all three are quoted below).
3. **To roll a change back:** open the merged proposal in the Review tab, click
   **Undo on GitHub**, click GitHub's **Revert** button, then approve and merge the new
   proposal that GitHub opens.
4. **To add a member:** an Admin opens
   `https://github.com/desert-mango/hippocampus-docs/settings/access`, clicks **Add people**, and
   gives the role Write to lab members, Maintain to trusted reviewers, and Admin only to Nathalie.
5. **To add a picture:** while editing the page in the site editor, click **Image from Media**,
   upload a PNG, JPEG, GIF or WebP image under 5 MB (or pick one the site has), describe it,
   click **Insert into page**, and propose the page (section 7).
6. **A "derive" commit is:** the robot (`github-actions[bot]`) rebuilding the site's search index
   and graph data right after a merge; it needs nothing from you.
7. **For a "machinery" badge:** do not merge; ask Desert Mango, who reviews every change to the
   site's code.
8. **When a rename or removal is refused:** put the old id back so the check turns green, and ask
   Desert Mango to do the rename or removal for you.
9. **To edit a page in the site editor:** open `https://hippocampus-docs.vercel.app/cms/#/pages`,
   click the page, change the text, check the **Preview** under it, then click **Propose…** and
   **Propose** (section 1b).

For anything else, contact Desert Mango through `desert-mango.com`, or open an issue on the
repository.

## Who can do what

| GitHub role on the repo | Badge in the Review tab | Who | What they do |
|---|---|---|---|
| Admin | Admin | Nathalie, Desert Mango | Everything, including adding and removing people |
| Maintain | Maintainer | Trusted reviewers that Nathalie names | Review, approve, request changes, merge, update from main (bring a proposal up to date with the newest main) |
| Write | Editor | Lab members | Edit and propose changes, and upload pictures; the Review tab shows them **Approve**, **Request changes**, **Update from main** and **Close**, but no **Merge** button. An Editor's **Approve** records their review on the proposal; it does not merge it |
| Read, or none | Read-only | Everyone else | Can read the public site; cannot propose or review |

Nathalie and the Maintainers merge. An Editor's **Approve** is a useful second opinion, but
only Nathalie or a Maintainer turns a proposal into a merge. A Write member could still merge on
github.com, because nothing on the repository blocks a merge on purpose. The rule is simply: lab
members propose, Nathalie and the Maintainers merge.

## 1. Make a change (lab members)

1. Find the file to change. The table "Which file do I edit?" in `CONTRIBUTING.md` lists them.
2. Open the file on github.com and click the **pencil icon** (top right of the file view).
3. Make your edit. Click the **Preview** tab to check the text.
4. Click **Commit changes…**. In the box that opens, choose
   **Create a new branch for this commit and start a pull request**, then click
   **Propose changes**, then **Create pull request**.
5. Your proposal now shows in the Review tab for Nathalie and the Maintainers.

You are a collaborator, so your branch lives in the repository itself. There is no fork and no
"Approve and run" button to wait for. The check starts on its own.

## 1b. Make a change in the site editor (lab members)

The site editor does the same as section 1 on one page, with a live preview. You need the
Editor badge or higher; with the Read-only badge the editor says "View only: changing pages
needs write access to this site's repository. You can still propose a change on github.com."

1. Open `https://hippocampus-docs.vercel.app/cms/#/pages` and sign in with GitHub. (The **Edit**
   link at the top of the editor goes there too, and the **Edit this page** link at the bottom
   of a page on the site opens that page in the editor.)
2. Under **Edit a page**, click the page you want to change.
3. Change the text in the box. The **Preview** under it shows the page as it will look. The line
   under the box says "Changed — kept as a draft in this tab, not proposed yet." Your draft
   lives only in this browser tab until you propose it.
4. Click **Propose…**. In the box "What does this change do? (the proposal's title on GitHub)"
   write one short line. Check the list under "What goes in", then click **Propose**.
5. The editor says "Proposed as #n." and opens your proposal in the Review tab. From here it is
   reviewed like any other (section 2).

To throw a draft away, click **Discard changes**.

**Adding to your own open proposal.** When you have a proposal that is still open, the editor
shows a "Start from:" choice. Pick "your proposal #n: <title>" and the button becomes
**Add to proposal #n**: your change becomes one more commit on that proposal, and the editor
says "Added to your proposal #n." Pick "the live site (a new proposal)" to start a new one.
This is also how you fix a red ✗ on your own proposal. Every changed draft on the same starting
point goes into the same proposal; "What goes in" lists them all.

**New project and New person.** Under **Edit a page**, click **New project** or **New person**,
fill in the form, and click **Make the draft** (project) or **Add to the people draft**
(person). Then propose it the same way. A new project is two files: its story and one entry in
`data/projects.json`. A person is one card on the About page; their photo comes from
**Photo from Media** (section 7). Both forms have the same "Start from:" choice.

**The data files.** The page list also holds four data files (people, projects, site, tools),
edited as plain JSON text. The "Locked ids" line above the text lists the ids you must not
rename or remove.

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

1. Open `https://hippocampus-docs.vercel.app/cms/#/review` and sign in with GitHub. Your role
   badge (Admin, Maintainer, Editor or Read-only) shows at the top.
2. Click a proposal in the list. Read the status line:
   - green ✓ "site rules pass": the gate is happy;
   - red ✗ "site rules fail": see section 3;
   - "still checking": the gate is still running. Wait a minute and reload;
   - "could not read the site rules check": the tab could not get the gate's result. Reload, or
     check the proposal on github.com.
3. Look at the preview under the **Preview** heading. It shows the proposal's pages and data on
   the site's current code. Click around in it. If the heading says **Preview (content only)**,
   the proposal also changes code, styles or other files that the preview does not show; read
   those under **Files changed**.
4. If it looks right, click **Approve**. If the proposal is yours, the tab answers "GitHub does
   not let you approve your own proposal". Ask another reviewer. Because you are Nathalie or a
   Maintainer, you may also merge your own proposal yourself if you are sure; lab members never
   merge their own.
5. Click **Merge**. The site updates by itself within a few minutes.
6. If something needs fixing, click **Request changes** and write what to fix. If the proposal
   should not happen at all, click **Close**.

If the Review tab is not open yet or is down, do the same review on github.com: open the pull
request at `https://github.com/desert-mango/hippocampus-docs/pulls`, check that the `check` line
shows a green ✓, open the **Files changed** tab, click **Review changes**, choose **Approve**,
click **Submit review**, then on the **Conversation** tab click **Squash and merge** and
**Confirm squash and merge**. The preview is only in the Review tab, so on github.com
read the changed text with care.

Other things the Review tab can say:

- **Update from main** brings the proposal up to date with the newest main (the live site's
  files), without changing the proposal's own edits. If the tab then says
  "This branch needs a human — ask Desert Mango.", ask Desert Mango.
- If **Merge** answers "Not merged: it changed since you looked, reload." (or **Update from main**
  answers "Not updated: it changed since you looked, reload."), someone changed the proposal
  while you were reading. Reload the page and look again before you merge.
- When the check is red ✗ or still checking, the first click on **Merge** does not merge: the
  tab says "Site rules do not pass on this commit (or are still checking). A merge deploys
  nothing until main is green. Merge anyway?" and only a click on its **Merge anyway** button
  merges.
- A **machinery** badge ("needs a code review by Desert Mango") means the proposal touches the
  site's code: a file under `js/`, `css/`, `tools/`, `api/`, `cms/` or `.github/`, or
  `index.html` or `vercel.json`. Do not merge it. Ask Desert Mango.
- A **derived files** badge ("carries search/ or data/graph/ files, which the site regenerates
  after a merge") means the robot rebuilds those files after the merge, so no action is needed
  for that part.

## 3. When the check is red

A red ✗ means the proposal breaks one of the site's rules. The Review tab lists each problem
under "What to fix (file, line, message):". The link "the full report" next to the status line
opens the full text on github.com. Fix the file on the
same branch with the same pencil, or in the site editor with "Start from:" set to your
proposal (section 1b), and the check runs again by itself.

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

1. In the Review tab, open the merged proposal. It shows one button: **Undo on GitHub**.
2. Click it. The proposal opens on github.com.
3. Click GitHub's **Revert** button, then **Create pull request**. This makes a new proposal
   that undoes the old one.
4. Back in the Review tab, the new proposal shows up like any other. **Approve** and **Merge**
   it. The site goes back to how it was.

Without the Review tab, open the merged pull request on github.com directly (the **Closed**
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

1. Open `https://github.com/desert-mango/hippocampus-docs/settings/access`.
2. Click **Add people**, type the person's GitHub username, and choose their role:
   - **Write** for lab members;
   - **Maintain** for trusted reviewers;
   - **Admin** only for Nathalie (and Desert Mango).
3. Confirm. The person gets an invitation from GitHub and must accept it.
4. To remove someone, find them in the same list and remove them.

Someone without a role sees "you do not have access to this site's repository" when they sign in
to the Review tab. Adding them with a role fixes that.

## 7. Pictures: the Media tab

The site's pictures are stored on Cloudinary (an image host). The Media tab uploads a picture
there and adds it to the site's image list (`data/cloudinary-manifest.json`). That change waits
in a draft called "Site image list" and goes into the same proposal as the page that uses the
picture.

**Put a picture on a page (the usual way):**

1. Open the page in the editor (section 1b). Put the cursor where the picture should go and
   click **Image from Media**.
2. Pick a folder next to "Upload to", choose the file, and click **Upload**. The editor shows the
   limits: "Images only (PNG, JPEG, GIF or WebP). Keep images under 5 MB." Or pick a picture the
   site already has under "Or use one the site has:".
3. Under "Describe the image (alt text)" write what the picture shows, for people who cannot see
   it. Then click **Insert into page**. The editor writes `![your words](address)` at the cursor.
4. Propose as usual. "What goes in" lists two files: "Site image list" and your page.

**A person's photo:** in **New person**, click **Photo from Media**, upload or pick the photo, and
click **Use as photo**.

**The Media tab itself:** open `https://hippocampus-docs.vercel.app/cms/#/media` (the **Media**
link at the top). It lists every picture with "on the site", "in your image-list draft" or "not
used by the site". You can upload there too, but, in the tab's words: "Use each new image on a
page in the same proposal: the site's rules refuse an image nothing uses. Open the page under
Edit, press "Image from Media" and pick it."

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
- anything this page does not answer.

Proposals from people outside the lab (from a fork) work too, but GitHub makes their first
proposal wait until a maintainer clicks **Approve and run**. That button is only for outsiders;
lab members never see it.
