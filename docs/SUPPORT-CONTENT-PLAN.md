# Eigen Support — Content Plan

A working backlog of help-center articles for **Eigen Support** (the `apps/index` help center). This is a
**curation document**: the lists below are candidates to keep, cut, merge, or re-title before anyone writes
prose. Once curated, each kept item becomes a markdown file under `apps/index/src/data/support/<section>/`.

## Provenance & ground rules

- **Taxonomy was harvested from `support.google.com`** (Gmail, Drive, Docs editors, Calendar, Contacts, Chat,
  Keep, Google Account, Workspace Admin) purely as a *structure* reference — what users typically need help
  with, organised into topics.
- **Pre-filtered to Eigen's actual features.** Every candidate below was cross-checked against an inventory of
  what the Eigen apps really implement. Google-only noise (Gemini/AI, mobile apps, Family Link, billing &
  storage upsell, DMA/legal, third-party app integrations, Meet/Vids/Forms/Sites) was dropped.
- **Inspiration, not copy.** We reuse the topic *shape* only. Every article is written from scratch in Eigen's
  voice, describing Eigen's real UI and behaviour. Do not paste or paraphrase Google's article text.

## Legend

- ★ — **first-batch essential.** Write these first to get a usable help center (see the suggested first batch
  at the end).
- ❓ — **verify the feature exists / how it works** before writing. The feature inventory couldn't confirm it,
  so confirm in the app (or ask) first.
- _(type)_ — suggested frontmatter `type` for the group: `overview` · `how-to` · `troubleshooting` · `faq` ·
  `reference`.

## How the help center is structured (recap)

- Sections are defined in `apps/index/src/components/support/sections.ts`; the section `id` is the folder name
  under `src/data/support/`.
- An article is a markdown file with frontmatter (`title`, `description`, `type`, `tags`, `related`,
  `crossSections`, `order`, `updated`). The build (`scripts/build-content.ts`) renders it and adds it to the
  manifest.
- **`crossSections`** lists an article under extra sections without changing its URL. We lean on this for two
  patterns: each app's "Get started" is cross-listed into `getting-started`, and each external-client setup
  guide is cross-listed into its app (Mail/Calendar/Drive).
- One article exists today: `connect/mount-drive-on-your-computer` (cross-listed into `drive`). ✅
- **Build & preview.** `cd apps/index && bun run scripts/build-content.ts` regenerates the content
  manifest; `bun run dev` then previews the help center at `http://localhost:3000/support`.

---

## Main themes review (sections)

The 13 sections in `sections.ts` already cover the "main themes" well — the apps, plus four global sections
(`getting-started`, `connect`, `account`, `admin`). **Recommendation: keep the sections as-is.** Google's
global help centers (Account, Admin, "getting started") map cleanly onto what we already have.

The cross-cutting topics Google splits out (Search, Sharing, Security, Keyboard shortcuts, Notifications,
Appearance) do **not** warrant new top-level sections. Place them instead via existing sections + `crossSections`:

- **Sharing & permissions** → author in `drive`, cross-list a general "How sharing works in Eigen" into
  `getting-started`.
- **Search & command palette** → `getting-started`.
- **Security / 2FA / app passwords** → `account` (app passwords also cross-listed into `connect`).
- **Keyboard shortcuts, appearance** → `getting-started`.

---

## getting-started

_Source: synthesized (Google has no single analog) · Basis: global onboarding + per-app intros_

**About & first steps** _(overview)_
- ★ About Eigen — what it is (a self-hosted Workspace), the apps at a glance, who it's for
- ★ Your first steps — signing in, the app launcher, and your personal Space
- How sharing works in Eigen (overview; cross-list from `drive`)
- ★ Find anything — global search and the command palette (Mod/Ctrl+K)
- Keyboard shortcuts
- Switch between light and dark theme ❓ (confirm where the toggle lives)

**Per-app "Get started" hub** _(overview)_
- Each app's "Get started with …" article (below) is cross-listed here via `crossSections: [getting-started]`,
  so this section doubles as a tour. Author them once in the app section.

---

## mail

_Source: Gmail · Basis: compose (To/Cc/Bcc, rich text), attachments (device + from Drive), reply/forward,
folders, archive/spam/trash, search, signatures, IMAP/SMTP_

**Get started** _(overview)_
- ★ Get started with Mail — the mailboxes, list, and reading pane

**Read & organize** _(how-to)_
- ★ Read and reply to email (reply, reply all, forward)
- ★ Search your email (by sender, subject, and message text)
- Archive, delete, and report spam
- Move email between folders (drag-and-drop or menu)
- Select multiple emails for bulk actions
- Print an email
- Download an email as a `.eml` file

**Compose & send** _(how-to)_
- ★ Compose and send an email
- ★ Attach files — from your device or straight from Drive
- Format your message (rich text)

**Signatures** _(how-to)_
- ★ Create and manage your email signature (lives in Space → cross-list from `account`)

**Calendar in Mail** _(how-to)_
- Respond to a calendar invite from an email

**Connect a mail client** _(how-to)_
- ★ Set up Eigen Mail in Thunderbird / Apple Mail / Outlook (IMAP & SMTP) — author in `connect`, cross-list here

**Troubleshooting** _(troubleshooting)_
- Can't send: message rejected or attachment too large (quota)
- Email isn't syncing in my mail client
- ❓ Filters / rules, out-of-office auto-reply, schedule-send — *verify these exist* before listing

---

## drive

_Source: Google Drive · Basis: upload/download, folders, the new menu, preview, rename/move, trash + restore,
sharing (viewer/editor/commenter, public/team, restrict), shared-with-me/by-me, copy link, file versions, WebDAV_

**Get started** _(overview)_
- ★ Get started with Drive — the file browser, toolbar, and preview

**Files & folders** _(how-to)_
- ★ Upload files _(folder upload isn't supported — files only)_
- Create folders and new documents (the New menu)
- ★ Download files and folders
- Preview a file (quick look)
- Rename, move, and organize files
- Filter your files by type (images, videos, …)

**Sharing** _(how-to)_
- ★ Share a file or folder (viewer, editor, commenter)
- Share with a public link or a team
- Restrict, limit, or stop sharing
- Email collaborators when you share
- ★ Find files shared with you and by you
- Request access to a file you can't open

**Trash & recovery** _(how-to)_
- ★ Delete files and use the Trash
- Restore a deleted file
- Empty the Trash

**Versions** _(how-to)_
- ★ See and restore previous versions of a file

**Connect** _(how-to)_
- ✅ Mount Drive on your computer (WebDAV) — *exists* (`connect/mount-drive-on-your-computer`, cross-listed here)

**Troubleshooting** _(troubleshooting)_
- Upload failed or file too large (quota)
- A file won't open

---

## docs

_Source: Docs editors · Basis: collaborative editing, rich text, headings, lists/checkboxes, links, images
(device/Drive), tables, colors/fonts, undo/redo, comments, export (docx/pdf/html/txt), import (docx + from Drive)_

**Get started** _(overview)_
- ★ Get started with Docs
- ★ Create and edit a document

**Formatting** _(how-to)_
- ★ Format text — bold, headings, lists, alignment, colors, fonts
- Add and edit links
- ★ Insert images and tables
- Clear formatting

**Collaboration** _(how-to)_
- ★ Share a document and set access
- ★ Comment and discuss (the comments sidebar; resolving comments)
- Edit together in real time

**Import & export** _(how-to)_
- ★ Export to Word, PDF, HTML, or plain text
- Import a Word (`.docx`) document
- Import from another Eigen document
- Print a document
- ❓ Restore a previous version of a document — *verify version history surfaces for docs*

---

## sheets

_Source: Sheets · Basis: cell editing + formulas (autocomplete), number formats, conditional formatting, data
validation, row/col insert-delete-resize, freeze, multiple sheet tabs, cell comments, xlsx import_

**Get started** _(overview)_
- ★ Get started with Sheets
- ★ Create and edit a spreadsheet

**Data & formulas** _(how-to)_
- ★ Enter and edit data
- ★ Use formulas and functions (with autocomplete)
- Set up data validation (dropdowns and rules)

**Formatting** _(how-to)_
- ★ Format cells and numbers
- Apply conditional formatting
- Insert, delete, and resize rows and columns
- Freeze rows and columns

**Structure** _(how-to)_
- Work with multiple sheet tabs
- ❓ Sort and filter data — *verify*
- ❓ Charts — *verify*
- ❓ Pivot tables — *verify*

**Import / export** _(how-to)_
- ★ Import an Excel (`.xlsx`) file
- ❓ Export to Excel or CSV — *verify*

**Collaboration** _(how-to)_
- Share a spreadsheet
- Comment on cells

---

## slides

_Source: Slides · Basis: collaborative editing, add/delete slides, insert text/images/shapes, share, comments.
**Low-confidence inventory — verify the editing surface before writing this section.**_

**Get started** _(overview)_
- ★ Get started with Slides
- ★ Create and edit a presentation

**Build slides** _(how-to)_
- ★ Add, duplicate, and reorder slides
- Insert text, images, and shapes
- ❓ Apply a theme or layout — *verify*

**Present** _(how-to)_
- ❓ Present your slides (present mode) — *verify*
- ❓ Speaker notes — *verify*

**Collaboration** _(how-to)_
- Share a presentation
- Comment on slides

**Export** _(how-to)_
- ❓ Export to PDF or PowerPoint — *verify*

---

## calendar

_Source: Google Calendar · Basis: month/week views, navigate/today, create event on a date, own + shared
calendars, toggle calendar visibility, external invitations (iMIP), CalDAV_

**Get started** _(overview)_
- ★ Get started with Calendar
- Switch between month and week views; navigate dates and jump to today

**Events** _(how-to)_
- ★ Create and edit an event
- ★ Invite people and manage attendees
- Respond to an invitation
- ❓ Recurring events — *verify*
- ❓ Add a location or video link — *verify*

**Calendars & sharing** _(how-to)_
- Show or hide calendars
- ❓ Share a calendar and control access — *verify the sharing UI*
- ❓ Subscribe to another calendar — *verify*

**External invitations** _(faq)_
- How invitations to/from people outside Eigen work (iMIP)

**Connect a calendar client** _(how-to)_
- ★ Set up Eigen Calendar in Apple Calendar / Thunderbird (CalDAV) — author in `connect`, cross-list here

**Troubleshooting** _(troubleshooting)_
- My calendar isn't syncing (CalDAV)

---

## contacts

_Source: Google Contacts · Basis: list, create, edit fields (name/phone/email/address/labels/birthday/avatar),
labels/groups, search_

**Get started** _(overview)_
- ★ Get started with Contacts

**Manage contacts** _(how-to)_
- ★ Add a contact
- ★ Edit or delete a contact
- Add a photo, birthday, and other details
- Organize contacts with labels and groups
- Search your contacts

**Import / export** _(how-to)_
- ❓ Import contacts (vCard) — *verify*
- ❓ Export your contacts — *verify*
- ❓ Merge duplicate contacts — *verify*

---

## chat

_Source: Google Chat · Basis: rooms (personal + team), send/edit/delete messages, attachments, @-mentions,
load earlier, rename room, share + access, unread indicators. (Eigen chat is MUD-inspired.)_

**Get started** _(overview)_
- ★ Get started with Chat
- Personal chats vs team chats

**Messaging** _(how-to)_
- ★ Send, edit, and delete messages
- ★ Mention someone (@-mention)
- ★ Share files in a chat
- Load earlier messages
- ❓ Message formatting — *verify the rich-text extent*
- ❓ Chat commands (slash/MUD commands) — *verify and document if present*

**Rooms** _(how-to)_
- ★ Create a chat room
- Rename a room
- Share a room and manage access
- Unread indicators and notifications

---

## stickies

_Source: Google Keep (loose analog — Eigen Stickies is a **kanban board**, not notes/lists) · Basis: boards
with columns, cards, drag-and-drop, column settings, card comments, share_

**Get started** _(overview)_
- ★ Get started with Stickies (kanban boards)

**Boards & cards** _(how-to)_
- ★ Create a board and add columns
- ★ Add and edit cards
- Move and reorder cards (drag-and-drop)
- Customize columns (column settings)
- Delete cards

**Collaboration** _(how-to)_
- Share a board and manage access
- Discuss a card (comments)

---

## connect

_Source: Eigen-specific (seeded from Gmail IMAP/POP + Calendar "use with other apps") · Basis: app passwords,
WebDAV, IMAP/SMTP, CalDAV_

**Overview** _(overview)_
- ★ Connect external apps to Eigen — app passwords and the available protocols

**App passwords** _(how-to)_
- ★ Create and manage app passwords (Space → Integrations; cross-list from `account`)

**Per-protocol setup** _(how-to)_
- ✅ Mount Drive on your computer (WebDAV) — *exists*; cross-listed into `drive`
- ★ Set up Eigen Mail in a mail client (IMAP & SMTP) — cross-list into `mail`
- ★ Set up Eigen Calendar in a calendar client (CalDAV) — cross-list into `calendar`
- Advanced WebDAV: rclone and Mountain Duck

**Troubleshooting** _(troubleshooting)_
- 401 Unauthorized / authentication failures
- Windows requires HTTPS (and the 50 MB upload limit)

---

## account

_Source: Google Account · Basis: profile, change password, 2FA (TOTP + backup codes), app passwords, data
export (download-home), signatures_

**Profile** _(how-to)_
- ★ Update your profile (name and picture)

**Security** _(how-to)_
- ★ Change your password
- ★ Set up two-factor authentication (TOTP, backup codes)
- Manage app passwords (cross-list into `connect`)

**Your data** _(how-to)_
- ❌ Export and download your data — **not implemented yet** (confirmed 2026-06-08). Don't write until it ships.

**Preferences** _(how-to)_
- Create your email signature (cross-list into `mail`)
- Switch between light and dark theme ❓ (confirm location)

---

## admin

_Source: Workspace Admin · Basis: first-run setup wizard, members, teams, guests + guest settings, server
settings, quotas/storage defaults (local/S3), orphaned-data cleanup, waitlist. **Self-hosted admin — most of
Google's admin taxonomy (billing, devices, DLP, domains) does not apply.**_

**Get started** _(overview)_
- ★ Set up your Eigen server (the first-run setup wizard)

**Members & teams** _(how-to)_
- ★ Add and manage members
- Remove a member
- ★ Create and manage teams
- How team membership and shared content work

**Access & guests** _(how-to)_
- Enable and configure guest access

**Storage & quotas** _(how-to)_
- Set storage quotas and the default mount
- ❓ Configure the storage backend (local / S3) — *verify this is in the admin UI vs config files*

**Server operations** _(reference)_
- Server settings overview
- Onboarding settings
- Clean up orphaned data
- Waitlist management
- ❓ Deploying / self-hosting Eigen — *decide whether deployment docs belong here or stay in `docs/`*

---

## Suggested first batch (~15 articles)

Highest-value ★ items to write first, for a help center that's immediately useful:

1. **getting-started** — About Eigen
2. **getting-started** — Your first steps (sign in, app launcher, Space)
3. **getting-started** — Find anything: search & the command palette
4. **drive** — Get started with Drive
5. **drive** — Share a file or folder
6. **drive** — Delete files and use the Trash
7. **mail** — Get started with Mail
8. **mail** — Compose and send an email (+ attachments)
9. **mail** — Create and manage your email signature
10. **docs** — Get started with Docs
11. **sheets** — Get started with Sheets
12. **connect** — Set up Eigen Mail in a mail client (IMAP/SMTP)
13. **connect** — Set up Eigen Calendar in a calendar client (CalDAV)
14. **account** — Set up two-factor authentication
15. **account** — Update your profile (name and picture)

(Drive's WebDAV mount article already exists, so the "connect" theme is partly seeded.)
