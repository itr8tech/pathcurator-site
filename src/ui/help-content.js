// src/ui/help-content.js — the in-app documentation. Two kinds: GUIDES (task-oriented, plain
// language, written for someone who has never curated a bookmark) and REFERENCES (compact facts).
// Bodies are markdown rendered through the app's own sanitizer. Keep sentences short. No jargon
// without an immediate explanation. Related topics link via the view (not markdown — internal
// #/ links don't pass the URL sanitizer, by design).

export const GUIDES = [
  {
    id: 'welcome',
    title: 'What is PathCurator?',
    blurb: 'The idea in two minutes — and where your data lives.',
    related: ['first-pathway', 'r-storage'],
    body: `
PathCurator helps you turn good links into a **learning pathway**: an ordered, guided path of
web pages, videos, courses, and podcasts that you choose and explain, so someone else can learn a
topic step by step.

A quick tour of the words you'll see:

- A **link** is a saved web address — the thing browsers call a bookmark — plus your notes about it.
- A **step** is a group of links with a purpose, like a chapter. "Start here", "Go deeper".
- A **pathway** is the whole journey: steps in order, with an introduction and a finish line.
- A **workspace** holds related pathways together, like a folder or a shelf.

Two things make PathCurator different:

1. **Your work lives in your browser, on your computer.** There is no account, no login, and no
company server. When you close the tab, your pathways are still here when you come back — but
they are *on this device*, so read the backup guide once you have work you care about.
2. **You publish when you choose.** A pathway can become a beautiful stand-alone web page for
learners, a file you email a colleague, or part of a shared team library — but nothing leaves
your browser until you export or share it.

Ready? The next guide walks you through your first pathway in about five minutes.
`,
  },
  {
    id: 'first-pathway',
    title: 'Create your first pathway',
    blurb: 'Workspace → pathway → steps → links, in five minutes.',
    related: ['collect', 'share'],
    body: `
# 1. Make a workspace

On the **Dashboard**, press **+ New workspace**. Give it a name — your team, your subject, or
just "My pathways". Ignore the GitHub fields entirely; they're optional and covered in the team
guide.

# 2. Make a pathway

Inside your new workspace, press **+ New pathway**. Give it a clear name and, if you like, a
description — who is this for, and what will they get out of it? You can write later; nothing
here is locked in.

# 3. Add steps

Open your pathway and press **+ Step**. A step is a stage of the journey. Three or four good
steps beat ten vague ones. Each step can have an *objective* ("After this step you can…") and a
*pause and reflect* prompt — a question for the learner to sit with.

# 4. Add links

Inside a step, press **+ Link**. Paste the web address, give it a human title, and — this is the
part that makes curation valuable — write a sentence of **context**: *why this link, and what to
look for in it.*

Mark each link **Required** or **Bonus**. Required links are the spine of the pathway; bonus
links are for the curious. Learners see a progress bar over the required ones.

# 5. Look at it

That's a pathway. Reorder anything with the arrow buttons. When it feels right, the sharing
guide shows you how to hand it to learners.
`,
  },
  {
    id: 'collect',
    title: 'Collect links with your Inbox',
    blurb: 'Grab links now, sort them later.',
    related: ['extension', 'first-pathway'],
    body: `
Good pathways are built from links you stumble on all week. The **Inbox** is where they wait
until you have time to sort them.

# Ways to get a link into your Inbox

- **In the app:** open **Inbox** and press **Add manually** — paste an address, add a note, done.
- **The bookmarklet:** on the Inbox page you'll find a special button you drag to your browser's
bookmarks bar once. After that, clicking it on *any* web page sends that page here.
- **The browser extension:** the most comfortable way — a toolbar button and right-click menu on
every page. See the extension guide.

# Sorting (we call it "filing")

Each Inbox item has a **File into a pathway…** button. Pick the pathway and step, check the
title, add context, choose Required or Bonus — and it becomes a proper link in your pathway.
Anything captured with the item (a note you wrote, the page's own description) comes along
automatically.

Not useful after all? **Dismiss** it. The Inbox is meant to reach empty.
`,
  },
  {
    id: 'share',
    title: 'Share a pathway with learners',
    blurb: 'One file, works anywhere, tracks their progress.',
    related: ['files', 'r-exports'],
    body: `
Open a pathway and press **⬇ Export…**, then choose **Web page (HTML)**.

You get **one file** that is the whole pathway: a clean, readable page with your steps, links,
context notes, and a progress bar. Email it, put it on a shared drive, drop it into a course
site — it works anywhere, even with no internet, because everything is inside the file.

# What learners can do on the page

- **Launch** links (each opens in a new tab) — the page remembers what they've launched and
fills in their progress bar over the required links.
- **Mark as done** anything the page can't detect automatically.
- **Search** the pathway, collapse and expand steps, switch light/dark.
- Under the **⚙ menu**: save their progress to a small file (so it survives a new computer or a
cleared browser), restore it, and even download the whole pathway as **browser bookmarks**.

# Two honest limits

- Progress lives in *each learner's* browser. It does not report back to you — nobody is
watching them, which is a feature.
- The page is a snapshot. When you improve the pathway, export again and share the new file —
their progress carries over, because it's tied to the links, not the file.

Prefer not to include your name? The export dialog has an attribution checkbox — off by default.
`,
  },
  {
    id: 'lms',
    title: 'Put a pathway in your LMS',
    blurb: 'A tracked activity in Moodle & friends — no plugins, no servers.',
    related: ['share', 'r-exports'],
    body: `
If your organisation runs a learning platform (Moodle, Totara, and most others), you can add a
pathway as a **tracked activity**: the LMS records each learner's progress, shows completion,
and puts a score in the gradebook — the percentage of required links they've launched.

# Fastest: restore the starter course

Choose **Moodle starter course (.mbz)** in the export dialog and you skip all setup:

1. In Moodle: *Site administration → Courses → Restore* (or **Restore** inside a course category).
2. Upload the .mbz file and restore it **as a new course**.

You get a complete course that opens straight into the pathway — single-activity format,
pre-configured the resource-friendly way: no "Enter" screen, no attempt counters, grade hidden
from learners, and progress that resumes across visits for as long as the pathway takes.
Rename the course, enrol your learners, done.

# Adding to an existing course instead

1. Open the pathway, press **⬇ Export…**, choose **SCORM package (zip)**.
2. In your Moodle course, turn editing on and add a **SCORM package** activity.
3. Upload the zip file. That's it — no plugin to install, no server to run.

By default Moodle presents SCORM rather quiz-like. For the resource feel, set: *Skip content
structure page* → Always · *Display attempt status* → No · *Attempts allowed* → Unlimited ·
*Force new attempt* → No — and hide the activity's grade item if you don't want it in the
gradebook. (The starter course above ships with exactly these.)

Learners see the same interactive page as the web export — steps, search, progress bar — inside
the course. Their progress is saved **by the LMS**, per learner, and survives log-outs and new
computers. (The page's own save/restore buttons disappear here, because the LMS has taken over
that job.)

# Keeping courses fresh — automatic (recommended)

If the pathway's workspace is connected to a **public** GitHub repository, open the pathway and
press **🌐 Publish…**. This keeps a SCORM package committed in the repository at a stable URL.
Point the Moodle activity at that URL (paste it as the Package, set *Auto-update frequency* to
"Every day") — or download the **auto-updating course file** from the same dialog and restore it,
already wired up. From then on: fix a link in PathCurator, commit, and every course refreshes
itself within a day. Nobody touches Moodle again.

Two requirements, both one-time: the repository must be public (Moodle downloads the package
without credentials), and a Moodle admin must enable URL packages (*Site administration →
Plugins → SCORM package → "Downloaded package"*). Mind the look-alike toggle next to it:
**"External SCORM manifest" is a different mode** — it wants a URL ending in
\`imsmanifest.xml\`, rejects package zips as *"Invalid URL specified"*, and in the activity's
Type dropdown it can appear selected when Downloaded package isn't enabled yet.

Heads-up on that admin toggle: with it still off, an auto-updating course **restores and plays
fine** — but saving the activity's settings fails with a database error about *"Column
'reference' cannot be null"*. That error means "enable the downloaded-package type", nothing
more. Courses restored before the toggle was flipped are fine afterwards; nothing needs
re-importing.

# Keeping courses fresh — manual

Export a fresh SCORM package and use the activity's settings to **replace the package file** —
don't create a new activity. PathCurator builds every package of the same pathway with the same
internal identity, so the LMS treats the replacement as an update: grades, attempts, and each
learner's progress carry over. Progress is tied to the links themselves, so learners only
"lose" credit for links you deleted.

# Good to know

- The score is a progress measure (0–100% of required links), not a test result.
- A pathway with no required links marks itself complete on first open — attendance, honestly.
- The **Web page (HTML)** export remains the right choice outside an LMS — same page, no
tracking infrastructure needed.
`,
  },
  {
    id: 'files',
    title: 'Back up, send, and receive files',
    blurb: 'Your safety net, and collaboration without any accounts.',
    related: ['r-imports', 'team'],
    body: `
Because your work lives in your browser, **you are the backup plan**. Happily, it's one button.

# Back up everything

On the Dashboard, press **⬇ Back up everything**. You get a single file containing every
workspace and pathway. Keep it somewhere safe — a drive, a cloud folder, an email to yourself.
Do this whenever you've done work you'd hate to lose.

# Restore or receive

Press **⬆ Import file…** (or just drag a file onto the Dashboard). PathCurator understands:

- its own backups and exports,
- a colleague's exported pathway or workspace,
- a **spreadsheet of links** (CSV with a URL column),
- **browser bookmarks** exported from Chrome, Firefox, Safari, or Edge — folders become steps,
- files from the old PathCurator.

Before anything changes, you'll see a review screen: what's new, what's identical, and what
differs from a copy you already have. Nothing is overwritten unless you choose **Take import** —
keeping your version is always the default.

# Collaborating by email

This is the simplest way to work with one other person: export a pathway, email it, they import
it, improve it, export it back. The review screen shows you exactly what they changed.
`,
  },
  {
    id: 'team',
    title: 'Work with a team (GitHub)',
    blurb: 'Optional: a shared library that keeps everyone in sync.',
    related: ['audit', 'r-sync'],
    body: `
If several people maintain the same pathways, emailing files gets old. PathCurator can connect a
workspace to **GitHub** — a free service for keeping shared work in sync. You don't need to
understand GitHub to use it; here's the honest minimum:

- Think of the connected **repository** as the team's shared shelf.
- **Commit** means *put my changes on the shelf* — with a note about what you changed.
- **Pull** means *fetch what teammates put on the shelf* since you last looked.

# Setting it up

Someone technical creates a repository once and gives it an access token. In PathCurator, press
the workspace's **Connect to GitHub…** button and paste the details. If the repository already
holds pathways — even ones from the old PathCurator — they import automatically.

# Day to day

Edit as normal. The workspace shows "**N uncommitted**" when you have changes only you can see;
press **Commit…** to share them, and **Pull** now and then to receive. If you and a teammate
changed the *same pathway*, PathCurator shows both versions side by side and asks which to keep —
it never silently overwrites anyone's work.

Curious what you've changed before committing? **Review…** shows the differences, and can
discard them if you've changed your mind.
`,
  },
  {
    id: 'audit',
    title: 'Keep your links healthy',
    blurb: 'Links rot. PathCurator notices for you.',
    related: ['extension', 'r-audit'],
    body: `
The saddest fate of a pathway is a learner clicking a dead link. PathCurator watches for that.

# Where the checkmarks come from

If your workspace is connected to GitHub, a weekly automatic check visits every link and records
what it found. The results appear in the app as small status pills on each link, and problems
gather on the **Audit** page. (You can also check on demand with the browser extension — see
that guide.)

# The Audit page

Problems are grouped: **Broken** (really dead), **Auth required** (behind a login — usually
fine), **Redirected** (moved somewhere else), and **Couldn't verify** (the automatic checker
couldn't reach it — often fine for internal links).

For each link you can:

- **✓ Good** — "this one's actually fine." Trusted for about 90 days, then checked again.
- **📌 Pin good** — "never flag this one again."
- **✗ Broken** — "trust me, it's dead," even if the checker disagrees.
- **↺ Auto** — hand it back to the automatic checker.
- **🗑 Remove** — take it out of the pathway right from the list.

Whole sites that always need a login (paywalls, staff intranets) can be **exempted** at the
bottom of the page so they stop showing up at all.
`,
  },
  {
    id: 'extension',
    title: 'The browser extension',
    blurb: 'One-click capture, and link-checking from your own seat.',
    related: ['collect', 'audit'],
    body: `
The PathCurator Companion is a small browser add-on with two talents.

# Capturing

Once installed, you get a toolbar button and a right-click menu on every page: **Save page**,
**Save link**, or **Save selection** (the selected text becomes your note). Everything lands in
your Inbox for filing later.

# Auditing from your seat

The weekly automatic check runs out on the internet — which means links on your organisation's
**internal network** look broken to it, even when they're fine. The extension can check links
*from your own browser*, which sits inside the network. On the **Audit** page you'll see an
**Audit now** button for each workspace once the extension is installed.

To allow this, open the extension's toolbar popup once and switch on **Enable link auditing** —
it asks the browser for permission to check pages on your behalf. It only ever reports *whether*
a link answers, never what's on the page.

# Setup

Ask whoever runs your PathCurator for the extension, or load it from the project's
extension folder. In the extension's **Options**, point it at the address where you open
PathCurator, and save.
`,
  },
];

export const REFERENCES = [
  {
    id: 'r-exports',
    title: 'Export formats',
    blurb: 'What each export is, and when to use it.',
    related: ['share', 'r-imports'],
    body: `
From a pathway's **⬇ Export…** dialog:

- **Data file (JSON)** — the complete pathway, for importing into PathCurator. The only format
that round-trips *everything*. Use for backups and for sending to other curators.
- **Web page (HTML)** — the learner-facing page with progress tracking. Self-contained, works
offline. Use for sharing with the people who'll take the pathway.
- **SCORM package (zip)** — the same learner page, wrapped for an LMS (Moodle & friends): the
LMS tracks per-learner completion and grades. Replacing the package in an activity is an
*update* — progress and grades survive.
- **Moodle starter course (.mbz)** — a complete Moodle course with the SCORM activity already
inside and configured resource-style (no "Enter" page, no attempt counters, grade hidden).
One-time bootstrap: restore it as a new course, then keep it fresh by replacing the package.
- **Spreadsheet (CSV)** — one row per link. Opens in Excel or Google Sheets. Re-importable.
- **Feed (RSS)** — one item per link, for feed readers and other tools.
- **Browser bookmarks (HTML)** — importable by any browser; each step becomes a folder.

From the Dashboard: **⬇** on a workspace exports all its pathways in one data file;
**⬇ Back up everything** exports all workspaces, plus your audit settings.

The attribution checkbox (your name in the published output) applies to the web page, SCORM,
CSV, and RSS. It is **off** unless you switch it on, and your choice is remembered.
`,
  },
  {
    id: 'r-imports',
    title: 'Import formats',
    blurb: 'Everything the Import button and drag-and-drop accept.',
    related: ['files'],
    body: `
**⬆ Import file…** on the Dashboard (or drag a file onto it) accepts:

- PathCurator **data files**: pathway, workspace, or full backup.
- A **raw pathway file** downloaded straight from a connected repository.
- **Legacy PathCurator** files (curator-pathways.json) — converted automatically.
- **CSV** — needs a column named URL (or Link); optional columns: Step, Title, Type, Required,
Description, Context, Added. No Step column? Everything lands in one step.
- **Browser bookmarks** (the file browsers produce from "Export bookmarks") — folders become
steps, nested folders become "Parent / Child" steps.

Every import shows a review first: **new** items, **identical** ones (skipped), and ones that
**differ** from a copy you already have — those default to keeping *your* version unless you
pick **Take import**. Unsafe web addresses inside a file are quietly refused. Importing the same
file twice changes nothing.
`,
  },
  {
    id: 'r-audit',
    title: 'Audit statuses',
    blurb: 'Every pill and section, decoded.',
    related: ['audit'],
    body: `
**Pills on links:**

- **OK** — answered normally on the last check.
- **Broken / Not found / Server error** — really failing. Fix or remove.
- **Auth required** — wants a login. Usually fine for intranet or subscription content.
- **Redirects →** — answers, but from a different address. Consider updating the link.
- **Exempt** — on your exemption list; never checked.
- No pill — not checked yet.

**Audit-page sections:** the same categories, plus **Couldn't verify from CI** (the weekly
checker timed out — common for internal links; often fine) and **Unreachable from your browser**
(the *extension* couldn't reach it from inside your network — a much stronger sign of a real
problem). **Verified good** lists your own ✓/📌 decisions.

**Override lifetimes:** ✓ Good lasts about 90 days, then automatic checking resumes.
📌 Pin lasts forever. Both travel with the workspace when it's connected to GitHub, so your
decisions apply on every computer.
`,
  },
  {
    id: 'r-sync',
    title: 'Sync, step by step',
    blurb: 'What every chip and button on a connected workspace means.',
    related: ['team'],
    body: `
- **In sync** — your copy matches the shared library.
- **N uncommitted** — you have local changes teammates can't see yet. Commit when ready.
- **audit changes pending** — you changed link-health settings (verdicts, exemptions); these
ride along with your next commit.
- **Conflict — pull to review** — a teammate committed while you also had changes. Pull, and
PathCurator shows both versions to choose between. Nothing is lost either way.
- **Commit…** — write your changes to the shared library, with an optional message.
- **Pull** — fetch teammates' changes. Safe changes apply automatically; real conflicts ask you.
- **Review…** — see exactly what you've changed since the last commit; optionally discard it all.
- **Auto-commit** — commits for you every few minutes when you have changes. Off unless you
switch it on, per workspace.

PathCurator **never force-overwrites** the shared library, and never overwrites your local work
without showing you first.
`,
  },
  {
    id: 'r-writing',
    title: 'Writing and formatting',
    blurb: 'The description fields understand simple formatting.',
    related: ['first-pathway'],
    body: `
Description, context, objective, and similar fields accept **Markdown** — plain text with light
formatting marks. The **Preview** tab shows exactly how it will look. The toolbar (and shortcuts)
insert the marks for you:

- Bold: two asterisks around words (Ctrl/⌘ B)
- Italic: one asterisk (Ctrl/⌘ I)
- Link: square brackets for the text, round for the address (Ctrl/⌘ K)
- Lists: start lines with a dash, or with 1. for numbered lists
- Headings: start a line with one or more # marks
- Quotes: start a line with >

Anything unsafe (scripts, forms, trackers) is stripped everywhere your text is shown, including
in exported pages — you can paste from anywhere without worry.
`,
  },
  {
    id: 'r-storage',
    title: 'Where your data lives (privacy)',
    blurb: 'Plain answers about storage, and what ever leaves your device.',
    related: ['files'],
    body: `
- Everything you create is stored **inside your browser, on your device** — in a private
database only this site can read. There is no PathCurator server and no account.
- **Nothing leaves your device** unless you export a file, publish a page, or connect a
workspace to GitHub (then only that workspace's content goes to *your* repository).
- Each browser is its own island: Chrome and Firefox on the same computer have separate copies.
Use GitHub sync or file exports to move between them.
- **Private/incognito windows can't run PathCurator** — that mode forbids the storage it needs.
- Browsers may clear site data under storage pressure or after long disuse (Safari especially).
PathCurator asks the browser for protected storage, but the honest safety net is **⬇ Back up
everything** — or a connected repository, which is a continuous off-device copy.
- GitHub access tokens are stored encrypted, never leave this device, and are never included in
any export, commit, or published page.
`,
  },
  {
    id: 'r-trouble',
    title: 'Troubleshooting',
    blurb: 'The screens you might hit, and what they mean.',
    related: ['r-storage'],
    body: `
**"Read-only — PathCurator is active in another tab."** Two tabs are open; one owns the
database and the other watches. Work in the other tab, or close it and this one takes over.

**"PathCurator can't save data here."** The page tells you the likely cause: a private window
(open a normal one), a locked-down browser, or — if you opened an http:// address on another
machine — the connection itself. PathCurator needs an https:// address (or localhost).

**A new version is available.** A small notice with a Reload button appears when the app has
updated. One click.

**The extension's Audit button doesn't appear.** Check the extension is installed, its Options
point at this exact address, and reload the page.

**For developers** — running from a laptop for another device on your network: plain
http://host:port won't work (no secure context). Easiest: SSH port-forward and open
localhost on the other machine; or add the origin to the browser's insecure-origin allowlist;
or set up local HTTPS (mkcert). Details in the repository's docs/README.
`,
  },
];

const ALL = [...GUIDES, ...REFERENCES];
export const topicById = (id) => ALL.find((t) => t.id === id) || null;
