# Maintainer protocols: how the lab runs this site

*Written 21 September 2026 for the day-one path: edit on github.com, then review, approve and
merge in the site's Review tab. When the site editor and the Media tab ship, their sections are
added here; the rest of this page stays as it is.*

This page is for Nathalie (the site's owner) and for lab members. You do not need to code.
You need a GitHub account and a web browser.

A few words used on this page:

- **Pull request (PR):** a proposed change. Nothing on the live site changes until someone
  merges it.
- **Merge:** accept a pull request. The site then updates by itself.
- **Branch:** a separate line of work in the repository. Each proposal lives on its own branch.
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
5. **To add a picture today:** ask Desert Mango to upload it for you, until the Media tab ships.
6. **A "derive" commit is:** the robot (`github-actions[bot]`) rebuilding the site's search index
   and graph data right after a merge; it needs nothing from you.
7. **For a "machinery" badge:** do not merge; ask Desert Mango, who reviews every change to the
   site's code.
8. **When a rename or removal is refused:** put the old id back so the check turns green, and ask
   Desert Mango to do the rename or removal for you.

For anything else, contact Desert Mango through `desert-mango.com`, or open an issue on the
repository.

## Who can do what

| GitHub role on the repo | Badge in the Review tab | Who | What they do |
|---|---|---|---|
| Admin | Admin | Nathalie, Desert Mango | Everything, including adding and removing people |
| Maintain | Maintainer | Trusted reviewers that Nathalie names | Review, approve, request changes, merge, update from main |
| Write | Editor | Lab members | Edit and propose changes; the Review tab shows them **Approve**, **Request changes**, **Update from main** and **Close**, but no **Merge** button |
| Read, or none | Read-only | Everyone else | Can read the public site; cannot propose or review |

Nathalie and the Maintainers merge. A Write member could still merge on github.com, because
nothing on the repository blocks a merge on purpose. The rule is simply: lab members propose,
Nathalie and the Maintainers merge.

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
   not let you approve your own proposal"; ask another reviewer, or merge it yourself if you are
   sure.
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

- **Update from main** brings the proposal up to date with the latest site. If the tab then says
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
same branch with the same pencil, and the check runs again by itself.

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
`derive: regenerate derived data after <short sha>`. This is normal and needs nothing from you.

A merge that adds or removes a page takes a little longer: the live site keeps showing the old
version for one to three minutes, until the robot's commit goes live. This holds once the deploy
test in the plan's M1 step 6 has passed. Until then, if a new page has not appeared after ten
minutes, tell Desert Mango.

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

## 7. Pictures

Today, ask Desert Mango to upload a picture for you, until the Media tab ships. Tell them which
page it is for and send the file. They upload it and give you the address to use.

## 8. Things only Desert Mango does

Ask Desert Mango (`desert-mango.com`) for:

- any proposal with a **machinery** badge;
- renaming or removing an existing id (a project, a tool, a setup page, a people group);
- a new setup page, or a new section in the setup pages;
- pictures, until the Media tab ships;
- a branch that "needs a human";
- anything this page does not answer.

Proposals from people outside the lab (from a fork) work too, but GitHub makes their first
proposal wait until a maintainer clicks **Approve and run**. That button is only for outsiders;
lab members never see it.
