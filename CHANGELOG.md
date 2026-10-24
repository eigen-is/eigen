# Changelog

All notable user-visible changes to Eigen are documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

The Word, Excel and PowerPoint release. Eigen reads and writes `.docx`, `.xlsx` and `.pptx` files with its own code. Docs gets equations, page setup, headers and footers, and footnotes. Docs, Sheets, Slides and Vector get charts. After you update, reload every document you have open: a tab still on 0.3.3 deletes the equations, footnotes and charts it receives.

### Added

- **Word, Excel and PowerPoint files** — convert one to an Eigen document in Drive, import one into the document you have open, or download your work in that format
- **Word files** — keep their equations, headers and footers, footnotes and page setup
- **Excel files** — keep their hidden sheets and pictures
- **PowerPoint files** — keep their shapes, pictures and backgrounds
- **Charts in these files** — come in as charts you can edit, not as pictures
- **Import into a spreadsheet or deck** — add a file's sheets or slides to the one you have open, or replace it with the file. Eigen saves a version before it replaces anything, so you can go back
- **Equations** — write math in Docs in LaTeX and watch the preview as you type, or pick symbols from the menus above the field
- **Pasted math** — math copied from Word for the web, or from most web pages that show math, pastes as an equation you can edit
- **Equations in downloads** — PDF, web page and Word downloads keep your equations
- **Charts** — add a column, bar, line or pie chart in Docs, Sheets, Slides and Vector. You edit its numbers in a small sheet next to it
- **Charts in Sheets** — a chart follows the cells it shows, so it changes when they do
- **Copying charts** — a chart you copy into another Eigen app stays a chart you can edit
- **Chart style** — a chart takes the same fill, stroke and sketch style as a shape. In Vector and Slides you can turn one into shapes
- **Download image** — right-click a chart, or a selection in Vector or Slides, to save it as an SVG picture. This works when you can only view, too. The text in the picture stays real text
- **Vector downloads** — download a drawing as SVG from the editor, or as PDF from Drive
- **Page setup** — choose the paper size, orientation and margins in Docs. The editor, printing and every download use them
- **Slide size** — switch a deck between widescreen 16:9 and standard 4:3
- **Headers and footers** — add them in Docs, with page numbers and a page count. The first page can have its own. They show on every page when you print, and in PDF and Word downloads
- **Footnotes** — add numbered notes in Docs. In a PDF they print at the bottom of their page
- **More formatting in Docs** — line and paragraph spacing, indents, a font size box on the toolbar, and a background color for table cells
- **Normal text in Docs** — **Update 'Normal text' to match** gives all normal text the look of the text at your cursor

### Changed

- **Find and replace** — ⇧⌘H opens it in every editor, as in Google Docs. In Docs, ⌥⌘F now inserts a footnote
- **Printing from Docs** — Eigen prints through a PDF, so headers, footers and page numbers print too
- **Nested numbered lists** — number by level, as in Google Docs: 1., then a., then i. A nested list that showed 1. 2. 3. on every level now shows a. or i. on the deeper levels. To keep 1. 2. 3., pick that style for the list again
- **Text in Sheets** — long text spills into the empty cells next to it
- **Alignment in Sheets** — numbers and dates line up on the right unless you align them yourself
- **Column widths in Sheets** — an imported Excel file's columns are as wide as they are in Excel
- **Excel functions** — IFS, IFNA, XLOOKUP, TEXTJOIN and other newer Excel functions calculate in Sheets
- **Pictures and charts in Sheets** — you move, resize, rotate and stack them the same way
- **Large workbooks** — an Excel file imports as long as its cells fit. There is no longer a separate limit on sheets, rows or merged cells
- **Password-protected files** — an import tells you the file has a password, and where to remove it
- **Menus** — every menu orders its items the same way, with Delete last and in red
- **Choices in menus** — where you pick one of several options, the submenu shows a check next to the current one
- **Right-click menus** — shapes and pictures on a canvas, and tables and equations in Docs, get more of their actions in the right-click menu
- **Accent colors** — charts, calendars, labels and collaborators' cursors use one set of colors. It starts with Eigen's pink, and colors next to each other are easy to tell apart, also for color-blind readers
- **Clear formatting** — in Docs it keeps comments and links, and ⌘\ runs it

### Fixed

- **Access** — when someone removes your write access to a document you have open in Docs, the editor turns read-only right away
- **Sharing** — a sharing change applies right away to every open document in that drive
- **Links in Docs** — a collaborator's edit or an undo no longer turns a file name like plan.md into a link
- **Wrapped images in Docs** — a wrapped image leaves room for the text and lists beside it
- **Copying from Sheets** — cells you paste into another app keep their rows and columns
- **Pasting in Sheets** — a pasted cell keeps its font
- **Keys in Sheets** — Tab and Ctrl+arrow move the way they do in Excel
- **Mixed formatting in Sheets** — a cell with more than one format in its text, such as one bold word, counts in sorting, filters and formulas
- **Trash** — on local storage, a crash during a trash or a restore no longer leaves the file out of reach
- **Large files** — a file too large for the server's memory to import, export, preview or index is refused, instead of taking the server down

## [0.3.3] - 2026-10-13

Eigen reads and writes Word files itself, and Docs gets Google Docs' menus, with page breaks, Title and Subtitle, small caps, word count and resizable table columns. The update migrates each user's mail index, `mail.db`, and an older version can't open the migrated one. To go back, restore the backup the update made: run `./eigen rollback` right after the update, or later `./eigen restore` with the `server-pre-update-` backup that `./eigen rollback --help` lists. Reload open documents after the update: a tab still on 0.3.2 deletes the page breaks, titles and subtitles it receives.

### Added

- **Docs menus** — Format and Insert are always on screen when you can edit, with the submenus Google Docs has. Edit and Tools join them
- **Page break** — Insert → **Page break** or ⌘Enter starts a new page in print, PDF and Word, and a Word file's page breaks come in
- **Paragraph styles** — Title, Subtitle, Heading 5 and Heading 6. They survive a trip to Word and back
- **All caps and Small caps** — under Format → Text, ⌘⇧A for all caps. PDF, Word and paste keep them
- **Word count** — Tools → **Word count** or ⌘⇧C, for viewers too
- **Lists and alignment** — five numbered styles and **Restart numbering** under Format → Bullets and numbering, and **Justified** in the Align menu (⌘⇧J)
- **Tables and images** — drag a column border to resize it, or **Distribute columns**. The Image panel has a Width field, and Shift+arrows resize a selected image
- **Page setup** — File → **Page setup…** shows the page every document uses: A4 with 2 cm margins
- **Mail** — a message opens without the images it would load from the internet, so its sender can't tell when you read it. **Load images** shows them for that message
- **Command palette** — ⌘K offers **Download as** in each format of the open document's File → Download menu
- **Teams** — an access request on a team's drive reaches the team's members, by notification and email, unless **Notify members** is off on the team's Admin page

### Changed

- **Word export** — Eigen writes the `.docx` itself: fonts embedded, figures with their wrap and caption, lists with their start and style, task boxes, code blocks, quotes, page breaks and pasted images. Images go in as PNG or JPEG, without their EXIF data
- **Word import** — Eigen reads the `.docx` itself instead of through a third-party library. SmartArt text and chart titles come in, East Asian and right-to-left text gets its fonts, wide tables fit the page, and a password-protected file says so. Imported images count toward the drive's storage
- **Docs toolbar** — the icon row folds into the menus as the window narrows. Strikethrough, code, superscript, subscript, quote, line and table live in the menus
- **Docs look** — Heading 5 and 6 draw in Google's grey at body size, Heading 6 in italics. The page stays light in dark mode, in quick look and thumbnails too
- **Copy and paste in Docs** — a paste from another document keeps its formatting and images and drops its comments. A pasted font like Georgia becomes the bundled one
- **Sheets import** — a workbook with more than 10,000 merged ranges, 500 sheets or about 2 million rows is refused as too large
- **Notifications** — the bell keeps every unread notification, not only those among the newest 50. The new-mail notification goes read once the inbox has no unread mail
- **Mail** — a reply marks the message it answers as answered, also when sent later from Drafts, and the mail list shows a reply arrow. A reply or forward quotes the message's text and links, never its images
- **Calendar** — removing every guest from one occurrence of a series keeps the series' guests, and the event dialog says so. To leave them out, remove that occurrence
- **Contacts** — when a contact changes elsewhere while you edit it, the form keeps your edits and offers **Reload**. A label name takes at most 100 characters
- **Limits** — WebDAV stores at most 64 KB of properties and 32 locks per file, and a chunked WebDAV upload stops at the max upload size and at what is left of the drive. One share request adds at most 100 people
- **Server settings** — **Max Upload** stops at 1023 MB, since a larger upload was refused anyway. A **Trash Retention** of 0 keeps deleted files until the Trash is emptied
- **Storage quotas** — a drive has one limit, whoever uploads into it: its owner's team overrides raise it, never the uploader's
- **Admin** — the Guests page shows each guest's name, email and when they were last active
- **Mail ports** — 25, 465, 587 and 993 listen on IPv4 only: mail apps and other mail servers reach them over IPv4. 465 and 587 allow 20 sign-in attempts and 60 messages a minute per client IP
- **S3** — a read retries three times on throttling or a server error before it fails
- **Deleting a user** — also deletes the safety copies a restore left of their data, and their files in S3 buckets. A second server restored from a backup of this one must never run on the same bucket
- **`./eigen update`** — makes a Full backup first, without asking, when a release migrates a database a Light backup leaves out. `./eigen stop` waits for a running backup and its upload
- **`./eigen rollback`** — its `--help`, and its refusal when there is nothing to roll back, list the kept pre-update backups
- **Docker image** — the API image is about 340 MB smaller. A source install needs WeasyPrint 68 or later for PDF export

### Fixed

- **PDF export** — bold text and headings print bold again, a centered figure stays centered, a numbered list keeps its start number and a colored link its color, and an open task under a done one is no longer struck through
- **Docs editor** — lettered and roman lists draw again, the toolbar follows the cursor, a selected image drags again, the Image panel stays open while you use it, and **Replace image** no longer replaces another figure
- **Safari** — a document or board no longer reconnects without end and never loads
- **Storage** — on local storage, creating a file in a folder deleted meanwhile no longer overwrites a file of that name at the drive's root. A save into a file trashed meanwhile is refused, and of two saves of a text file from one version, the second gets a conflict
- **Calendar invitations** — an occurrence without a guest list of its own goes out with the series' guests. Cancelling or deleting a moved occurrence cancels its moved time for its guests, and putting a cancelled occurrence back sends no cancellation
- **Calendar editing** — someone the owner shared a calendar with for editing can edit the owner's own events, and an event a member organized on a team calendar stays editable
- **Backups** — a restore gives each mail message its own date again. An item whose name a file cannot have is left out with a warning instead of failing the backup, and a file overwritten during a backup is archived as it was copied. Verify warnings show on the backup's row in Admin
- **Mail** — a row in Sent names the recipient instead of you, and an attachment loads right after a mail client changes its message's flags
- **Lists** — dragging a row that is not selected drags that row, and Space and Enter after Select All act on the top selected row
- **Previews** — an image no longer flashes a checkerboard before the full image, an `.eml` quick look keeps the message's layout, and an `.ics` with too many events is refused
- **Images** — an image in a document or sheet whose file is gone shows as missing, and a Word import's images load on S3 without a reload
- **Small fixes** — Escape in a suggestion list inside a dialog closes only the list. ⌘P with nothing to print prints the page. `./eigen restart` repairs the launcher after an interrupted update. A WebDAV PROPPATCH with a refused change saves nothing. A CalDAV query for one UID answers with that event. A guest who opens a file they cannot see is told to ask the owner. An access request mails the owner at most once an hour. Restoring a spreadsheet version saved in an older format is refused instead of locking its editors. Scrolling back in chat no longer skips messages sent in the same second. An imported vCard with your address no longer becomes your own card. A malformed stickies column no longer breaks the board. Edits recovered after an unclean shutdown get a version. With mail turned off, a user's kept mail still counts toward their storage. Finder can save into a full drive over WebDAV. An HTML mail's preview line no longer shows a tracking-pixel address

### Security

- **Mail relay** — Postfix and OpenDKIM trusted the Docker network's gateway, which the host, Docker Desktop, rootless Docker and every IPv6 client arrive from. Such a client could send mail through port 25 without a login and get mail from your domain DKIM-signed, and the API trusted it too. A program on the host that sent through `localhost:25` now gets "Relay access denied": send through 587 with a login
- **Team mounts** — only team admins see a team's mount settings, S3 secret included, where every member could
- **PDF export** — the renderer opens only `data:` URIs, so a link in a document can no longer make the server fetch a URL or a local file into the PDF
- **Exports and previews** — HTML exports carry a Content-Security-Policy, an SVG can no longer make Firefox load outside URLs, and a sheet cell's color can no longer inject CSS
- **Chat search** — Drive's search index of a chat no longer holds the text of whispers
- **Imports** — a small crafted `.docx` or `.xlsx` can no longer take gigabytes of memory or minutes of CPU, and a slow SVG can no longer hold a thumbnail worker

## [0.3.2] - 2026-10-05

Fixes from a restore drill, and the same edge spacing across the apps. An install still on 0.3.0 updates to 0.3.1 first: `./eigen update 0.3.1`, then `./eigen update`.

### Changed

- **Layout** — lists, toolbars and panes keep the same space at their edges, more of it from tablet size up, so dates and menus clear the scrollbar. The sidebar and the app switcher keep less, and Contacts' letters sit over the avatars
- **Setup** — **Complete Setup** stays clickable, so the browser names a missing field. Each storage choice says what it means, and the sender name shows the organization name until you type one
- **Admin** — a user created on the Users page joins the team named after the organization and gets what was shared with it. The create button is labelled **Create User**
- **`.env.production`** — `./eigen restart` picks up an edit made while Eigen runs. Until then, `./eigen update` and `./eigen backup` refuse, since the backup would hold the old file

### Fixed

- **Mail** — Enter in To, Cc, Bcc or Subject no longer sends the mail. In Subject it moves on to the message
- **Drive** — opening a document without editing it leaves its Modified time alone
- **Setup** — files go under the S3 prefix you set instead of the bucket's root, and **Go to Login** opens the sign-in page
- **Rollback** — the backup `./eigen rollback` restores is kept when it was made with warnings
- **Restore** — it offers to delete what it kept aside only when it kept something. The installer, run with `restore` in a folder that already has an install, tells you to run `./eigen restore` there
- **Small fixes** — the landing page no longer logs a Content-Security-Policy error, an IMAP or DAV sign-in with the account password no longer logs an API key error, and update notes show links as text

## [0.3.1] - 2026-10-02

Whole-server backup and restore. Eigen backs up the whole server every night while it runs, can copy each backup to a bucket of its own, and puts one back with `./eigen restore`, on the same machine or a new one. The steps are in the help center's [Self-hosting section](https://eigen.is/support/self-hosting/get-started). Close every open document before you update from 0.3.0: an edit that has not reached the server is lost, offline edits included.

### Added

- **Nightly whole-server backup** — the owner turns it on in Settings → Backups: every user and team, the settings and databases, `.env.production` and the mail keys, newest seven kept. **Back up now** makes one by hand
- **Backup bucket** — each backup can also go to a private S3 bucket of its own. Keep its keys off the server: a new machine starts from them
- **Backup alerts** — the owner is notified, and `./eigen status` shows it, when a backup fails, misses the bucket or has warnings. A user or team with files gone from storage is backed up without them
- **Restore** — `./eigen restore <backup>` puts a server backup back and keeps the old data aside. On a new machine, run `curl -fsSL https://eigen.is/install | sh -s -- restore <backup>`. Settings → Backups shows both commands
- **One user or team** — restores from their Admin page out of a server backup
- **Download original image** — on every image in docs, sheets, slides and vector, for viewers too. Images in documents take comments
- **Font licenses** — the licenses page lists the bundled fonts with their OFL 1.1 text

### Changed

- **Backups (breaking)** — `./eigen backup` writes to `backups/` instead of `snapshots/` and needs Eigen running: drop any cron step that stops Eigen, and drop `--keep`, which now makes no backup. Snapshots in `snapshots/` no longer restore
- **Update and rollback** — `./eigen update` backs up first and refuses while Eigen is stopped. `./eigen rollback` puts that backup back with its version. After a restore, open tabs reload once
- **Setup** — answer the mail domain question with the domain you already have email on. With mail off and no relay, setup warns that sign-in codes and invitations cannot go out
- **Mail containers** — Dovecot and Postfix warn instead of failing when they cannot share the TLS or DKIM key with group 1000. The DKIM record prints on one line
- **`.env.production`** — becomes mode 0640 for group 1000, so a backup can hold it
- **Slides** — a slide menu on each thumbnail and on empty canvas replaces the + button. `9` opens the image picker in slides and vector
- **Imports and exports** — every one shows a progress dialog
- **Mail** — the list takes the full width while no mail is open
- **Chat** — a guest can no longer invite people to a chat

### Fixed

- **Backups** — a file renamed, moved, trashed or deleted during a backup no longer fails it, nor does a trashed file on a drive that stores files by name. **Verify** passes such a backup
- **Storage** — a save that races a folder rename is no longer lost, a stalled S3 bucket times out, and a document whose stored data is gone says so and offers version history
- **Mail** — a send with no recipients says "Add at least one recipient" and keeps the draft open. A link to a deleted mail says "Email not found"
- **Copy and paste** — a pasted image loads in docs and sheets, a vector or slides text box keeps its fonts in docs, and a refused copy says why
- **Previews** — a text file over 1 MiB says it is too large instead of spinning, a `.vcf`, `.ics` or `.eml` stored as text opens, and quick look keeps its keys over a stickies card
- **Uploads** — WebDAV holds an upload to the max upload size, and the help center's nginx snippet no longer caps uploads at 1 MB
- **Small fixes** — a resolved comment thread stays resolved, Postfix waits for its certificate on a first boot, and a sheet viewer gets no hand cursor over a dropdown it cannot use

## [0.3.0] - 2026-09-25

Self-hosting release. Eigen now installs from prebuilt images with one line, and the `./eigen` launcher updates, rolls back and backs up the server. Slides use the same canvas as eigen|vector>. Mail, calendar and contacts keep exactly what your mail, calendar and contacts apps write, and `.eml`, `.ics` and `.vcf` files open and import everywhere a file shows up. The findings of the September security audit are fixed.

**Breaking** — calendars, contacts, slides and vector drawings don't carry their data over from 0.2.0 (breaking). Events and contact books are dropped, decks open empty, and drawings lose their plain text and fills.

### Added

- **One-line install** — `curl -fsSL https://eigen.is/install | sh` downloads the `./eigen` launcher and runs setup. The host needs Docker and Compose, nothing else. Setup explains its questions, lists the DNS records you need, and ends with a one-time link to the wizard
- **Release images** — five images on GHCR, for amd64 and arm64, pinned by digest in `.env.production`. The resolver is Eigen's own unbound image
- **`./eigen` launcher** — `update` downloads while Eigen runs, takes a snapshot and switches. For a breaking release it shows the notes and asks first. `rollback` goes back one update. `status`, `logs`, `restart`, `stop` and `reset-password` do what they say. `update main` follows the main branch for people who develop Eigen
- **Whole-server snapshots** — `./eigen backup` saves the server to `snapshots/`, in full or light (databases and settings only), and keeps the last three of each. `./eigen restore` swaps one in and keeps the old data aside
- **Backup per user or team** — a Backup section on the admin Users and Teams pages backs up one user or team to a verified archive, without downtime. Verify, download, upload and restore from there. A restore keeps the old data as a safety copy
- **Admin settings** — the organization name, a Server section with version, disk and certificate, and a Mail section with the system sender, **Relay sends as users** and **Send test mail**. Admin Users lists past 100 members
- **Slides on the canvas engine** — every drawing element works on a slide: shapes, images, rich text, freehand, lines and arrows. Text is edited in place, and a box grows with its text. The properties panel offers gradient fills, corners, padding, typography and opacity, and with nothing selected it edits the slide background for this slide, this and following, or all. The slide always fits the window. Comments anchor to elements, `⌘F` searches text, and presence shows which slide each person is on. Links in present mode open in a new tab without advancing the deck
- **Quick look for every file** — Drive items and the attachments in mail, chat and cards open in the same quick look with the same action menu. Clicking an attachment chip previews it next to the message's other parts, and a mailed video seeks
- **`.eml`, `.ics` and `.vcf` files** — an `.eml` opens as the message it holds and imports into the inbox. An `.ics` opens as its events and imports into a calendar you own or a team calendar, from Drive, from a mail or from the calendar sidebar; each calendar exports as one `.ics`. A `.vcf` previews as its contacts and imports into Contacts. All three carry their app's icon in Drive
- **Contacts** — Export vCard on any selection, and Import contacts and Export all contacts in the toolbar
- **Mail** — folders an IMAP client created appear under Folders. A lone `from:` or `to:` filter searches on its own. `postmaster@`, `abuse@` and `noreply@` deliver to the org admins instead of bouncing
- **Calendar (CalDAV)** — a calendar app can delete a calendar, and Integrations lists one address per calendar, because Thunderbird subscribes per calendar. CalDAV is tested end to end against Thunderbird
- **Offline indicator** — every collaborative editor shows when you are offline or the server's storage is out, and asks before you leave with edits that have not reached the server
- **Sheets** — floating images appear in exports and previews. A progress dialog stays up while an Excel or Word file imports
- **Canvas** — image and text boxes draw in the same hand-drawn style as shapes
- **Keyboard** — Delete and Backspace act on the selection in Mail, Contacts and Drive, and document shortcuts pause while a dialog is open
- **Help center** — 25 new articles and a Vector section, with Support links in the app switcher and on the Space landing page
- **Demo** — seeded mail with real attachments and contact cards, chats and comments that link the documents they talk about, and the Mail app stays on without hosted mail

### Changed

- **Calendar and contacts storage (breaking)** — events and cards are stored exactly as a client wrote them and served back byte for byte. Calendar data counts toward the storage budget. Existing data is not converted
- **Mail off is a complete product** — without hosted mail the Mail app and its settings disappear, and one `SMTP_RELAY_*` key set serves both modes: Postfix relays through it, or the API sends through it itself
- **Owner-only administration** — only the owner sees server settings, onboarding, guest access, the waitlist and the S3 secret. The owner cannot be deleted. The wizard no longer asks for a domain
- **eigen|vector>** — text elements are rich text. Shapes get gradient fills, true rounded corners and an optional border. Arrows dock on a shape's real outline. Phones open a drawing view-only
- **Canvas editing** — a run of nudges is one undo step, and so is a typed panel value. The aspect-ratio lock is remembered per element. Copy and paste between apps keep text as text
- **Sheets numbers** — every number shows the way Excel's General format shows it: no rounding noise, long values cut to 11 characters, scientific notation past that. A typed number is stored as a number, and a copy keeps full precision
- **Sheets** — pasted text is read like typed input, `Ctrl+D` and `Ctrl+R` copy the whole source cell, conditional-format rules follow Excel on case and blanks, and an imported Excel rule stays one rule. Exports lay out exactly as the screen does
- **Sharing** — deleting an item shared directly with you leaves the share instead of trashing the owner's copy
- **Activity** — a team shows its name instead of an id, links inside content open a new tab, and a file's creation and share rows are kept without an age cap
- **Mail** — a message with thousands of addresses gets its links instantly. Every mail is flushed to disk as it is written. Junk is labeled Spam
- **Copy** — American English, and dates read day-month-year

### Fixed

- **Calendar series** — an "all events" edit from a later occurrence shifts the series instead of moving it, a series edit reaches every override, a moved occurrence shows in its new week, and one occurrence deletes on one confirm
- **Calendar invitations** — an edit of one occurrence reaches guests as that occurrence, a new guest gets the series' exceptions, and an event you organize is never locked as someone else's invitation
- **Calendar time zones** — Windows zone names resolve, conversions near DST are correct, and an event without a zone shows in your own
- **Contacts** — editing one value keeps its label, a duplicate card is refused with the holder's name, and one damaged card no longer blocks the address book
- **Mail** — drafts keep nameless attachments and attached invites, a folder an IMAP client recreates gets live updates again, a message opened from a notification no longer stays unread, and a delivery no longer fails on a file system that refuses a directory fsync
- **Sheets formulas** — inserting or deleting rows in one sheet no longer shifts formulas on the others, whole-column ranges survive a shift, errors propagate through operators and comparisons, an overflow is `#NUM!`, `TEXT` works, dates no longer land a day early west of Greenwich, and every edit recalculates its dependents
- **Sheets editing** — fills shift formulas correctly and never write into a merged cell, switching sheets closes the editor, and the row and column limits match their message
- **Canvas** — moving a shape re-docks both ends of its arrows, and a missing image draws a placeholder
- **Collaboration** — opening a document on slow storage says so and retries calmly, and large documents sync over slow links because Eigen compresses what it sends
- **Drive** — a copy keeps its thumbnail, a read-only shared folder no longer offers actions it cannot do, and long copies no longer time out and duplicate the tree on retry
- **WebDAV** — moving an item onto itself is refused instead of deleting it, and malformed requests get a 400
- **Export** — a PDF render that hits its time limit returns an error instead of an empty reply
- **Server** — a second API on the same data folder refuses to start, a session started right after setup survives a restart, sign-in retries a missed organization join, and the `static` gateway forwards the real client IP, so rate limiting is per visitor

### Security

- **Audit of 2026-09-06** — every code-level finding is fixed: self-registration is closed unless open signup is on, comment descriptions and sheet paste are sanitized, previews go through the export sanitizer, presence updates are bounded and bound to the session, HTML mail loses `<form>`, WebDAV and mail parts are served with `nosniff` and a sandbox CSP, and ffmpeg runs with a protocol whitelist
- **iMIP** — invitations are processed only from senders whose DKIM signature Eigen verified itself
- **Headers and trust** — every app carries a Content-Security-Policy, the edge sends the security headers, and the mail stack trusts only `EIGEN_SUBNET`
- **Setup and relay** — the wizard runs only from a one-time link, relay credentials require STARTTLS, and admin impersonation is disabled
- **Dependencies** — DOMPurify, markdown-it, linkify-it and xmldom patched; nodemailer 10, sharp 0.35, better-auth 1.7

## [0.2.0] - 2026-09-02

Drawing, contacts sync, and hardening release. Eigen gains a new app, eigen|vector>, a collaborative whiteboard heavily inspired by Excalidraw's impressive work. Contacts are now stored as vCard files and served over CardDAV, so phones and desktops sync them the way they already sync calendars. Mail got its own parser, per-recipient document links, and a hardened outbound relay after an abuse incident. Under the hood, every collaborative editor shares one way to load and save, copy and paste, show live cursors and draw.

### Added

- **eigen|vector>** — a new collaborative whiteboard app. Shapes, freehand strokes with pen pressure, lines, text and images. Arrows stay bound to the shapes they connect, curved by default, with elbow routing, pinnable segments, heads and labels. There's an eraser, snap lines with align and distribute, live cursors, comments, an activity panel, and tuning for touch and stylus. Drawings export to SVG and PDF, show up in Drive previews and search, and paste into other apps as real images
- **Contacts over CardDAV** — contacts are stored as vCard files and served under `/dav/addressbooks`, so iOS, macOS, Thunderbird, and other clients sync them two-way. Apple clients edit in place, vCard 4.0 uploads are accepted, labels round-trip as categories, and contact photos become avatars. The Integrations page shows a CardDAV card next to CalDAV, a device setup article walks through each client, and the setup guide documents the `_carddavs._tcp` / `_caldavs._tcp` autodiscovery DNS records
- **Contacts** — edit a card straight from the context menu, select several contacts and email or chat with them at once, and the form shows what's wrong and marks only the fields that are required
- **Mail: send a document link** — the share-and-send dialog lists the linked files, gives the recipients read access when you send, and writes each recipient a personal link. When some recipients fail, Eigen tells you which
- **Mail** — outgoing mail carries the envelope, Message-ID and reply headers that other mail apps need, so replies thread correctly everywhere
- **Admin: Users** — a full-width responsive table with per-user storage usage, last sign-in, a guests-only filter, drag-to-team and multi-select, and orphaned accounts merged into the same list
- **Admin: S3 bucket safety** — one click on the S3 storage card enables bucket versioning and a lifecycle rule with safe defaults; the retention period stays editable afterwards
- **Drive** — sort by name, date or size from the column headers. Folders and documents show their real size. Folders group at the top only when you sort by name
- **Sheets** — tick boxes from the Insert menu and the cell's right-click menu, also for a whole column, limited to the rows that hold data. `Alt+Down` opens a cell's dropdown list. The data-validation hint shows as a card. Imported Excel booleans show as `TRUE` and `FALSE`
- **Slides** — live cursors and presence on the canvas, a right-click object menu, an aspect-ratio lock and W×H resize pill, and Alt-drag to duplicate
- **Demo** — the demo instance ships a hand-drawn festival site plan in the vector app

### Changed

- **Sheets border storage (breaking)** — cell borders are stored per cell, so two people bordering different cells converge instead of disagreeing forever, and toolbar-drawn borders now survive HTML export and previews. There is no migration: a sheet saved with toolbar-range borders before this release opens blank and read-only with an error banner instead of being overwritten. Sheets without such borders, and sheets whose borders were set per cell, open as before
- **Canvas editors work alike** — docs, slides, stickies and vector share undo, box selection, keyboard shortcuts, live cursors, dropping files, the properties panel, and copy and paste. Elements and images copy and paste between apps at their real aspect ratio, with one undo step per paste
- **Selection chrome** — a thinner selection ring and dashed group bounds across all canvas apps, matching the remote presence rings
- **Mail parser** — Eigen reads mail with its own parser instead of a port of nodemailer's, tested against a set of real-world emails. Three dependencies are gone. Address groups are flattened in reply-all and in the header rows, and the message body reads left-aligned at one unified width
- **Mail** — an empty message is refused instead of going out as "(No subject)", cleared recipients stay cleared when a draft is reopened, and the send button shows it's busy while Eigen checks who can open the linked files
- **Sheets** — conditional-format rules have human names and dialog titles, row and column resize is exact, the range picker sits under its cell at its old width, the dropdown chevron is always painted, the selection's move band and fill handle are easier to grab, and the sheet no longer carries a locale layer
- **Calendar (CalDAV)** — calendar apps see that you own your calendars and can write to them, so Apple's apps edit events in place instead of creating duplicates. MKCALENDAR uses the URL the app chose. A sync token ahead of the calendar is refused. The well-known DAV redirects work
- **Thumbnails** — animated images take their first frame, oversized images are skipped instead of exhausting the server, and thumbnail jobs no longer share temporary files
- **Docs** — pasted prose keeps its alignment, and the toolbar menus share one shell with slides and vector
- **Server** — a database newer than the running binary's schema is refused instead of opened, and a wrong data-dir argument fails with a clear error

### Fixed

- **Sheets** — text in cells, formulas and sheet names is escaped before the grid draws it. `IFERROR` catches errors from operators too, as in `IFERROR(1/0, 0)`. `TRUE`, `FALSE` and `NULL` work in any case. `F4` keeps cycling on absolute whole-row ranges. `Ctrl+Shift+F` stays in the workbook you pressed it in. Hidden columns no longer get filter buttons. Formula conditional-format rules stop at the last row. A tick box no longer hides values it doesn't recognize, and doesn't toggle while you type a formula. An invalid data-validation rule is refused instead of applied. A sheet that fails to load says so instead of showing a blank grid
- **Mail** — escaped characters in a mail's plain text decode correctly. Space freed by deleting mail counts toward your quota right away. The draft stays editable when you cancel share-and-send. The email header stays full width on wide screens
- **Calendar** — a deleted event that's created again syncs instead of staying deleted. An invitation received again and an event moved back show up again. Calendar apps notice a received invitation, and an app asking for one event gets it
- **Contacts** — birthdays keep the picked date in every timezone. Saving a form that someone else changed meanwhile is refused instead of overwriting their change. A duplicate label name is refused. A photo that fails to upload fails the save instead of clearing the photo
- **Drive** — copying to a media folder keeps its partial successes, and a missing app URL no longer white-screens the app
- **Stickies** — a card with only a title keeps room for a description, and a card's light edge shows only where the card is visible
- **Admin** — long names and emails truncate in person lists instead of overflowing
- **Server** — a failed write leaves no temporary file behind, a finished write survives a crash, and databases close cleanly
- **Docker** — a host dev API on port 8000 no longer conflicts with the docker stack

### Security

- **Outbound mail relay** — hardened after the abuse incident of 2026-08-31. A signed-in sender may only send as themselves. Failed logins count toward the per-IP limit and show up as auth failures for fail2ban. A fail2ban filter and jail ship with the Docker stack, and `update.sh` turns them back on after a rebuild. The organization owner is notified when outgoing mail backs up in the queue
- **Input limits** — CalDAV and CardDAV requests have a size limit, 5 MiB for a card. The last email fields without a limit have one. The files linked in a sent mail are capped and counted once. Control characters are refused in vCards and DAV requests
- **SVG serving** — a drawing's SVG carries its images inside it, safely, and an image named in a document only loads for the document it belongs to
- **Access checks** — the access check for a link shared by email skips addresses that can't be given access. A user's own account can't be claimed by another account with the same email
- **Conditional writes** — a contact form opened before someone else's change can't overwrite it

## [0.1.1] - 2026-08-13

Mobile & reliability release. Every app now works properly on a phone — column navigation with
back arrows, touch context menus, collapsing toolbars, and comment & activity panels on small
screens. Under the hood, every preview, export, and import moved into sandboxed background
workers with hard deadlines, spreadsheet exports got an order-of-magnitude speedup, and
slow-loading documents no longer spiral into reconnect loops.

### Added

- **Mobile** — Eigen is now phone-friendly end to end: navigation is column-based with a back
  arrow in every app, toolbars collapse their controls into a kebab menu (sharing, calendar
  views, drive sort and view, the mail shortcuts cheat-sheet), dropdown submenus become
  drill-in pages, and calendar event and stickies card dialogs fit phone widths
- **Touch** — long-press opens the context menu everywhere right-click does (drive rows and
  grid tiles, chat messages, stickies cards, slide thumbnails); hover-only action icons rest
  visible on touch screens; drive rows get a per-file kebab and the details pane gains
  Move/Copy/Duplicate; and Move to trash asks for confirmation on touch devices
- **Comments & activity on mobile** — Docs, Sheets, and Slides show their comments and
  activity panels on small screens (taking over the editor area on phones, and available from
  tablet width instead of only on wide desktops); Docs adds Comment to the mobile Insert menu
- **Drive quick look** — press `Space` to open and close a preview of the selected file, and
  step through the list with the arrow keys while it is open
- **Slides** — presentation mode shows a transient exit button, so a presentation can be left
  by touch

### Changed

- **Reliability** — every document preview, HTML/PDF/XLSX/DOCX export, XLSX/DOCX import, and
  background search extraction now runs in an isolated worker with a hard deadline: one huge
  or degenerate file can no longer stall the server for everyone, and a stuck job is killed
  and reported instead of hanging forever
- **Sheets** — exporting a large spreadsheet to HTML or PDF is an order of magnitude faster
  and the output a fraction of the size (styles are shared instead of repeated per cell);
  previews and search indexing read stored values instead of recomputing every formula, so a
  formula-heavy sheet can no longer time out its own preview; sheets are saved in a leaner
  snapshot format that opens faster over a remote connection; and large-sheet editing
  operations (inserting rows and columns, filtering, copying) got a hot-path performance pass
- **Opening documents** — a document that takes long to load (a huge spreadsheet on a cold
  server) shows progress instead of spiraling into a connect/disconnect loop, and a
  just-closed document stays warm on the server for a minute so reopening is instant
- **Drive** — converting an `.xlsx` or `.docx` into an Eigen document shows a progress
  dialog, and the conversion finishes on the server even if you navigate away
- **App icon** — a redesigned, bolder app icon, including the Safari pinned-tab icon

### Fixed

- **Dark mode** — paper stays paper: the document page, the slides canvas, and the sheets
  formula bar always render light, so content reads the way it prints
- **Printing** — printed documents no longer show collaborator cursors, selections, search
  highlights, or comment markers
- **Mail** — wide HTML emails scale to fit on a phone instead of overflowing; message bodies
  render in the app's font; calendar invitations are summarized on the server and show a real
  error state instead of failing quietly; batch actions report exactly what succeeded; and
  the message list no longer steals keyboard focus while the composer is open
- **Calendar** — moving an event to another calendar is atomic on the server, and asks for
  confirmation first when the move would lose data; the edit dialog's recurrence options no
  longer shift the start date by a day in some timezones; all-day date fields stay legible on
  narrow screens
- **Sheets** — read-only viewers really are read-only (menus, shortcuts, and edit paths are
  disabled) and they see rows and columns that others insert or delete without a reload; menu
  color pickers are proper submenus and no longer leak keystrokes into the grid; the grid
  re-measures itself when a side panel opens; and headers, sheet tabs, and pickers work by
  keyboard and touch
- **Slides** — editing shortcuts no longer reach the deck while presenting, and slide
  thumbnails on mobile are view-only
- **Chat** — mouse users get the hover action icons back on messages (touch users keep the
  long-press menu), and guests no longer see a storage-usage bar
- **Drive** — Cancel in the inline text editor asks before discarding unsaved changes, and
  deleting a selection that spans your drive and a team drive moves every item to trash
- **Dialogs** — confirmation dialogs wait for their action to finish and surface failures
  instead of closing early, across delete, move, and save flows
- **Imports** — importing a `.docx` a second time updates its images instead of failing
- **Accessibility** — comment color and assignee pickers work by keyboard, and chat, contact,
  and slide-object actions are reachable by touch
- **Landing page** — a rejected waitlist signup no longer locks the join form, and
  social-media link previews use the server's real domain
- **Installed app** — navigation between apps works when Eigen is installed to the home
  screen or dock as a web app

### Security

- **Imports** — `.docx` files are capped by decompressed size before parsing (zip-bomb
  protection), and write permission is re-checked at the moment an import commits, not just
  when it starts

## [0.1.0] - 2026-07-19

Search, mail & collaboration release. Find & replace inside every editor and full-content search
across Drive, a much faster Mail with Gmail-style keyboard shortcuts, comment assignment with live
activity panels in the editors, a Drive grid view, a guided new-chat wizard, team avatars, a public
demo, a monochrome dark theme, and the fixes from two security audits.

### Added

- **Find & replace** — press `Mod+F` in Docs, Sheets, Slides, and Stickies for an in-document find
  bar with highlighted matches and next/previous; `Mod+Alt+F` opens replace and replace-all
  (case-preserving). The command palette gains a `doc:` scope that reveals matches inside the open
  document — including its comment threads — and opening a search result highlights and scrolls to
  the match, in documents and mail alike; the inline text editor in Drive gets the same find bar
- **Search** — Drive search now looks inside files, not just at names: documents, sheets, slides,
  boards, chats, and plain-text files are content-indexed in the background, with name matches
  ranked above content-only matches
- **Mail** — Gmail-style keyboard shortcuts: navigate and select with the keyboard, archive,
  delete, and reply with auto-advance, undo the last action with `z`, and send with `Mod+Enter`;
  press `?` for the full list, and turn shortcuts or auto-advance off in settings; flagged messages
  show a star in the list
- **Comment assignment** — assign a comment card to a person in Docs, Slides, Sheets, and Stickies
  (in Sheets straight from the cell comment menu); assignees are notified and shown on the card,
  and comments can be filtered by assignee, color, and status — per panel, and board-wide in
  Stickies
- **Activity in editors** — the Recent Activity timeline from Drive is now available inside Docs,
  Sheets, Slides, and Stickies through an Activity toggle next to sharing; it updates live while
  the document is open, and every row links to what it describes
- **New-chat wizard** — starting a chat is now a two-step dialog: pick the people (anyone you can
  share with, or a whole team), then name the chat and choose where it lives; if a chat with
  exactly those members already exists it opens instead of creating a duplicate, with a "Create new
  chat" escape hatch. Team chats are filed in a chats folder on the team drive, members with an
  account are no longer emailed about the share (invitees without one still are), and the wizard
  opens from the chat sidebar, Drive's + New menu, and a new Start chat action on contacts and team
  members
- **Drive views** — a list/grid toggle with a thumbnail grid view, a sort menu (name, modified,
  size), and remembered per-user view and sort preferences; grid tiles support keyboard
  navigation, drag-to-move onto folders, and unread badges, and Trash gains the same views,
  sorting, and multi-select
- **Team drives everywhere** — the per-type views (Documents, Sheets, and so on), search, the
  Watched view, and the chat sidebar now include your team drives alongside your personal drive
- **Sheets** — live collaborator cursors: everyone editing a shared sheet sees the others'
  selections in their color, with the same name labels as Docs
- **Sheets** — while editing a formula, `F4` cycles the reference under the caret through absolute
  and relative forms
- **Mail** — paste files or images from the clipboard straight into the composer as attachments
- **Teams** — team avatars: upload an image for a team from its Admin page and it shows wherever
  the team appears; profile, contact, and team pictures share one avatar editor
- **Demo mode** — a server can run as a public, self-resetting demo: visitors press a single
  "Enter demo" button and land in a seeded festival workspace as one of its members, with a
  warning banner, outgoing mail disabled, and periodic resets — live at demo.eigen.is
- **Landing page** — admins can add their own link buttons (a title and a URL) to the landing page
  from Server Settings
- **Marketing site** — a `/changelog` page generated from this file, linked from the site footer
  and the app's About dialog
- **Chat** — new `/whoami` and `/hide` slash commands

### Changed

- **Dark mode** — a monochrome dark theme with layered surfaces: cards, popovers, and dialogs sit
  visibly above the background, native scrollbars follow the theme, and note cards match the mail
  list's dark treatment; the spreadsheet canvas deliberately stays white so sheets read as sheets.
  The app-colored topbar option is gone
- **Mail** — big-mailbox performance: the message list is virtualized and loads in pages, actions
  (move, read, flag, delete) apply instantly and sync in the background, mailbox sync no longer
  blocks the list, and search runs on the server; unread rows are marked with a dot instead of a
  border
- **Notifications** — rebuilt on one activity-row design shared with Recent Activity:
  notifications name who did what to what, chat notifications preview the message, and each row
  deep-links to the exact card, comment, or email; notification links open in the same tab
- **People** — users are shown by display name with a hover card consistently — chat authors,
  @-mentions and their suggestions, "Created by" lines, and activity rows
- **Sheets** — editing recalculates only the cells that depend on the change instead of the whole
  workbook, keeping large sheets responsive while typing
- **Uploads** — uploads stream to disk in constant memory, so a large upload no longer holds its
  full size in server RAM
- **Drive** — empty folders and views explain what belongs there and how to add it; files you have
  already viewed revalidate with ETags instead of re-downloading

### Fixed

- **Docs, Slides & Sheets** — images inserted into a document no longer vanish right after upload
  (the finished upload was misread as failed and the editors removed the image)
- **Sheets** — imported spreadsheets that were never opened now compute their formulas on the
  server, so previews and exports show values instead of blanks; imported `m`/`M` date formats
  resolve to months or minutes correctly
- **Sheets** — the selection stats read a cell's real value, so formatted cells sum and count
  correctly; drag-fill keeps the number format in every direction; `=` and `<>` compare
  case-insensitively like Google Sheets; sorting uses English collation; overlays and header
  highlights clip correctly at frozen panes; and collaborator cursors survive switching sheets
- **Mail** — a moved or deleted message shows up in its target mailbox without a reload; the list
  scrolls back to the top when you change mailbox or search (and search gains a clear button); an
  inbox opened from a notification can no longer get stuck empty; and a sync race no longer drops
  just-moved messages from the list
- **Calendar** — events no longer disappear from the 25-hour day when DST falls back, and
  ambiguous local times resolve per RFC 5545; the calendar link in invitation emails opens the
  right month instead of the year 57479
- **CalDAV** — deleted occurrences are advertised as EXDATE so a client edit can't resurrect them,
  older stored events serve correctly instead of erroring, and several recurrence-exception edge
  cases (timezones, floating times) were fixed for clients like Thunderbird
- **Chat** — very tall new messages scroll into view; with no personal chats, the first team chat
  opens automatically
- **Drive** — `.txt` previews render as readable paragraphs like `.md`; file names are normalized
  (NFC) so accented names no longer appear twice; files on a team drive open correctly from the
  per-type views and sidebar links
- **Contacts** — the contact and team-member detail views behave the same, and Edit/Delete are
  hidden when they don't apply instead of shown disabled
- **Admin** — deleting a user now removes everything tied to the account on every deletion path;
  previously some paths could leave orphaned team memberships behind
- **Self-hosting** — the bundled Caddy revalidates the app shell on every load and reloads its
  config after an update, so a new version is picked up immediately instead of serving a stale
  page
- **Reliability** — continued storage hardening: interrupted uploads to S3-compatible storage that
  timed out mid-write are detected and repaired, corrupt staged copies are refused, same-name
  create races are closed with a unique index, and database open/close races that could bite under
  load were serialized

### Security

- **Admin** — a privilege-escalation hole is closed: a signed-in user could create their own
  organization and pass the server's admin check; admin rights are now scoped to the server's
  organization and self-created organizations are disabled
- **Protocol sign-in** — accounts with 2FA can no longer be accessed over IMAP, CalDAV, or WebDAV
  with just email and password (use an app password); protocol sign-in attempts are rate-limited,
  and a valid app password is never blocked by that limiter
- **Exports** — slides and sheets HTML exports escape untrusted styling (a stored-XSS vector), and
  PDF export can no longer be steered into fetching internal URLs
- **Calendar** — events are verified to belong to their calendar on update and delete; incoming
  invitation mail (iMIP) is bound to the envelope sender, validates timezone ids, ignores replayed
  cancellations, and scopes replies to the right occurrence; recurrence expansion is bounded
- **Server** — internal API endpoints are unreachable through the reverse proxy, clients can no
  longer spoof their rate-limit identity via forwarded headers, API documentation and timing
  headers are disabled in production, and websocket message size is capped
- **Sheets** — crafted `.xlsx` files with forged headers or oversized contents are rejected with
  hard caps on decompressed size and cell count
- **Mail** — the mail parser is hardened against hostile input (boundary and text-extraction caps)
  and pinned by a deterministic fuzz-test suite
- **Chat** — deleting a chat attachment is confined to that chat's own media folder

## [0.0.6] - 2026-06-25

Activity & history release. A per-file activity timeline with file and folder watching,
copy/move/duplicate across drives, attachments on comment cards, a big spreadsheet import-fidelity
pass, a filled-out help center, and a visual refresh, plus data-loss hardening for remote storage.

### Added

- **File activity & history** — every file in Drive now keeps a timeline of what happened to it
  (created, uploaded, edited, renamed, moved, copied, commented) and who did it, shown in a Recent
  Activity panel on the file's details; collaborative-document edits and comments are attributed to
  the people who made them
- **File & folder watching** — watch any file or folder to be notified when it changes; watching a
  folder cascades to everything inside it, a new Watched view lists everything you are watching, and
  bursts of changes are coalesced into a single notification
- **Copy, move & duplicate** — right-click a file or folder (or a multi-selection) in Drive to
  Move to…, Copy to…, or Duplicate; copy works anywhere, including across mounts and into team
  drives, while move stays within a drive; folders copy recursively and collaborative documents
  copy as independent, fully working documents
- **Comment attachments** — attach files to comment cards in Docs, Slides, Sheets, and Stickies, and
  to chat; paste or drag-and-drop files straight into the card form or the chat input
- **Sheets** — XLSX import now preserves much more: hyperlinks, data-validation rules, conditional
  formatting, autofilters, hidden rows and columns, and frozen panes; these survive a round-trip
  back out to XLSX export
- **Sheets** — a formatting toolbar with font family, size, bold, and italic; number formatting
  gains Google-style custom-format dialogs for dates, numbers, and currency, and the Format → Number
  menu matches Google's structure
- **Sheets** — the column filter menu can now filter by condition (text contains, greater than, and
  so on), not just by selecting values
- **Stickies** — resolve a card, and reopen it later; resolved cards show a check
- **Slides** — right-click a slide object for a context menu of its actions
- **Help center** — the Eigen Support help center now has 120 articles, searchable from the command
  palette through a new Help scope as well as on the site
- **Drive** — files are served with HTTP range support, so video and audio scrub instantly in the
  preview and interrupted downloads can resume
- **Marketing site** — a new `/licenses` page lists the open-source software Eigen is built on

### Changed

- **Visual refresh** — a redesigned app switcher (a grid of large, app-colored icons with names), a
  lighter font-weight scale across the apps, Drive file icons tinted by app, an animated
  `eigen|app>` wordmark on the landing page and Space home, and a topbar that can switch between
  app-colored and neutral chrome; toolbar titles are lighter, toolbar borders fade in on scroll,
  and the Drive, Trash, and Calendar layouts were tidied up
- **Landing page** — the marketing landing page is prerendered, so it paints instantly and is
  friendlier to search engines; signed-in visitors are sent straight into the app
- **Sheets** — inserting or deleting rows and columns no longer ships the whole sheet, keeping large
  sheets responsive

### Fixed

- **Mail** — deleting a Trash email from the detail toolbar now asks for confirmation and then
  permanently deletes, instead of silently doing nothing
- **Mail** — HTML emails authored for a light background render on a light canvas in dark mode so
  they stay readable; unread senders are bolder; and a failed mailbox load shows an error state
  instead of an empty "no emails" message
- **Drive** — the preview's next/previous arrows work again for files opened from the Shared and
  file-type views
- **Slides** — on medium-width screens the editing controls (undo/redo and add slide/text/image)
  stay reachable through an Edit menu instead of disappearing
- **Sheets** — imported dates render through their number format, an unknown filter condition
  matches every row instead of hiding them all, and cell focus returns when a context menu closes
- **Accessibility** — icon-only buttons now have accessible names and keyboard paths, and tall
  popovers and menus clamp to the viewport and scroll instead of clipping
- **Reliability** — uploads to S3-compatible storage are now write-behind, so a slow or failing
  storage backend becomes background retry instead of a hung or failed request, with no loss of
  durability; crash-recovered databases are re-synced and a stored document is never overwritten
  with an empty or invalid working copy (continuing the storage-incident hardening from 0.0.5)

### Security

- **Drive** — a team's mount list is no longer readable by non-members
- **Drive** — files served inline carry `nosniff` and a sandbox CSP, closing a stored-XSS vector for
  uploaded HTML and SVG
- **Auth** — guest one-time codes are consumed atomically so one code cannot create two sessions;
  sign-in and 2FA are rate-limited to 10 per minute per IP
- **Abuse** — rate limiting is keyed on the real client IP behind the reverse proxy (with avatar
  fetches exempt), fixing a server-wide lockout
- **Calendar** — canceled events are excluded from free/busy, and replayed iMIP invitations (a
  stale sequence number) are ignored
- **Sheets** — hyperlink navigation is hardened with an allowed-scheme list, `noopener`, and
  ReDoS-safe parsing

## [0.0.5] - 2026-06-04

Version history release. Automatic, restorable version snapshots for every collaborative app
and chat, new slide-editing tools (rotate, Alt-drag duplicate, align & distribute), a
spreadsheet visual refresh, and storage, preview, and kanban-board performance work.

### Added

- **Version history** — Docs, Sheets, Slides, Stickies, and Chat now keep automatic version
  snapshots. A "Version history" entry in the File menu lets you browse earlier versions and
  restore any of them. For collaborative documents the restore applies live — everyone with the
  document open converges to the restored content immediately, with no reload. Retention follows
  an hourly/daily/weekly/monthly model, keeping fine-grained recent history while thinning older
  snapshots
- **Slides** — rotate objects with a dedicated rotate handle (hold Shift to snap to common
  angles, with a live angle readout); resizing is now rotation-aware
- **Slides** — hold Alt and drag an object to drop a duplicate
- **Slides** — a new Arrange section in the properties sidebar aligns and distributes the
  selected objects
- **Admin** — when a configured S3 bucket has object versioning disabled or suspended, the
  storage settings (setup wizard, server settings, and per-team mount create/edit) show a
  warning recommending you enable versioning and a noncurrent-version lifecycle policy

### Changed

- **Drive** — folders and document containers now report their real size instead of always
  showing 0; sizes are computed on demand, cached, and invalidated up the tree on writes
- **Sheets** — visual refresh of the formula bar, column/row headers, the area around the grid,
  and the bottom bar: theme colors throughout, an accent-tinted header highlight, and a single
  compact bar combining the sheet tabs with the Count/Sum/Average selection stats. The all-sheets
  switcher now shows a clear color dot for color-tagged sheets
- **Slides, Stickies, Sheets** — canvas and toolbar styling aligned with Docs (rounded canvas
  corners, consistent toolbar height)
- **Stickies** — large boards stay smooth: cards are memoized and reused across updates, so
  editing one card no longer re-renders the whole board
- **Previews** — document, sheet, and slide previews appear instantly from the last cached
  version and refresh in the background, instead of blocking on regeneration the first time you
  view them after an edit
- **Storage** — collaborative-document snapshots and updates are zstd-compressed on disk,
  reducing the on-disk growth of Yjs documents

### Fixed

- **Sheets** — a formula referencing a cell in another sheet now refreshes correctly even when
  that row has not been loaded into the grid yet
- **Calendar** — attendee email addresses are validated when added to an event
- **Reliability** — hardened collab- and chat-document storage (atomic backing-file creation;
  sync failures are no longer silent) to reduce the risk of data loss, following a storage
  incident investigation

## [0.0.4] - 2026-05-28

Search release. A Mod+K command palette with full-text search across Drive and mail, native
spreadsheet scrolling, a big spreadsheet-open speedup, compact file previews, and rich-text
sticky cards.

### Added

- **Command palette** — press `Mod+K` (or the topbar search pill) anywhere to search files,
  mail, and contacts, jump between apps, create documents, and act on the current selection
  (open, share, rename, download, mail to…); smart suggestions turn a typed email/URL or a
  matched contact name into a one-press "Send mail to…" action
- **Search** — full-text search across Drive files and mail, scoped per kind (`file:`, `mail:`,
  or the Tab scope chip); mail search filters by mailbox and by `from:`/`to:`, excluding
  trash and spam by default
- **Stickies** — card descriptions are now rich text with checkable task lists; toggling a
  checkbox on a board card or in the card dialog persists, and cards show a task-progress strip
- **Support** — new searchable Eigen Support help center on the marketing site, including a
  WebDAV drive-mount guide
- **Drive** — "Mail to…" in the item context menu opens a mail composer with the file attached

### Changed

- **Sheets** — spreadsheet scrolling is now native: wheel, trackpad, keyboard, touch, and the
  browser scrollbar all work directly, replacing the old wheel-hijack and thin custom scrollbars;
  overscroll bounce is suppressed so the grid no longer tears at the edges
- **Sheets** — opening a large imported spreadsheet is dramatically faster (a 16-sheet xlsx that
  took ~60s now paints in a couple of seconds); the collab snapshot is also compressed on the
  wire, so opening big sheets over a remote connection is much quicker
- **Previews** — in-app quick-look previews are capped for large files (sheets show the first
  sheet, slides the first 8, documents the first 20 blocks) with an "open to see everything"
  marker; downloads and exports stay complete. Text previews cache longer and stale preview
  files are pruned

### Fixed

- **Sheets (XLSX import)** — files with rich-text hyperlink cells (e.g. Google Sheets exports)
  no longer fail to import with a spurious "not a valid xlsx file" error
- **Sheets** — a bare reference to an empty cell (e.g. `='Sheet'!B13`) now evaluates to `0`
  instead of `true`
- **Calendar & UI** — month and weekday names render in English instead of leaking the
  browser's locale (e.g. Dutch) in the otherwise English-only UI
- **Space** — the 2FA setup QR code renders again instead of crashing the setup step
- **Setup** — the first-run wizard is re-runnable after a partial failure instead of getting
  stuck on "user already exists"
- **Admin** — team and member action errors show the real message instead of `[object Object]`
- **Sidebar** — long chat and folder names truncate with an ellipsis instead of forcing a
  horizontal scrollbar

## [0.0.3] - 2026-05-18

Quality release. Video thumbnails, optimistic image insert across collab apps, unified comments
model, redesigned drive properties panel, shared sidebar across drive + eigendoc apps, and a
deep refactor of the sheets engine.

### Added

- **Drive** — server-side video thumbnail generation: uploaded `video/*` files get a 512px WebP
  still (1s fast-seek, fallback 0s) and `duration` on `path.details`. ffmpeg ships in the docker
  image; absence is graceful (no thumbnail, no errors)
- **Docs, Slides, Sheets** — optimistic image placeholders: dropped/pasted images render
  instantly from a local blob URL and swap to the server URL once upload settles; zombie
  pending cleanup on tab crash
- **Slides** — direction-based marquee selection (contain when dragged right, intersect when
  dragged left), matching standard design-tool behavior
- **Slides** — hold Alt to scale objects from center; Shift to constrain aspect ratio during
  resize
- **Slides** — unified `BackgroundFill` type covers solid colors and gradients for slide and
  text-block backgrounds; shared `BackgroundFillBlock` properties panel with brand-color default,
  color carry-over between fill modes, and tabbed segmented control
- **Slides** — gradient backgrounds in server-side PDF export (oklab interpolation; plain-color
  fallback under WeasyPrint)
- **Comments** — unified model across Docs, Slides, Sheets, Stickies via a shared `CommentCard`
  Y.Doc card (`createdBy`, `createdAt`, `color`); drive-attachment flow on the paperclip button
- **Drive** — redesigned properties panel: tabbed segmented control, unified item context menu
  across list and preview rows, shared `DriveItemMenuItems`
- **Drive + EigenDoc apps** — unified `AppSidebar` with per-app accent colors, uppercase section
  labels, and cross-app navigation
- **Toolbars** — shared `DocumentShareCluster` sharing badge and shared `UndoRedoButtons` /
  `useYjsUndoState` used in Slides and Stickies
- **Stickies** — newly added cards scroll into view; board cards have a minimum height matching
  the production look
- **Admin** — alphabetical letter dividers in members, guests, and orphans lists via shared
  `AlphabeticalList`

### Changed

- **Sheets** — engine renamed from `fortune-sheet` to `sheet`; internal field names migrated
  from `luckysheet_*` snake_case to camelCase (`ctx.sheets`, `filterRange`, `setEditingCell`,
  etc.); jQuery snippets and upstream port stubs removed
- **Sheets** — comments sidebar is now a flex sibling of the canvas, not a z-index overlay
- **Drive** — frontend URLs are runtime-resolved via a split `EIGEN_STATIC_BIND` variable,
  fixing deployments where the API and static frontend share an origin
- **Drive previews** — document and slide thumbnails scale by intrinsic width; plaintext/code
  thumbnails render on the A4 page layout
- **Mail** — settings split into a dedicated section in the App settings sidebar
- **Performance** — images decode off the main thread for smoother rendering across apps
- **Slides** — drag-snapping skips `setState` when the snapped rect is unchanged

### Fixed

- **Drive** — pending blob URLs no longer swap out before the server URL preloads, eliminating
  a flash of broken image
- **Drive** — missing collab documents throw `ApiError(404)` instead of returning silently
- **Drive** — internal metadata fields no longer leak into the details display
- **Mail** — email-address validation rejects malformed addresses inside angle brackets
  (e.g. `<foo@>`)
- **Comments** — `CardDialog` no longer auto-opens after comment creation in Docs, Slides,
  and Sheets
- **Comments** — restored `h-[50vh]` on `CommentThread`; "View comment" actions consistently
  use the `MessageSquare` icon; URL re-navigation and pre-sync card visibility fixed in Docs
- **Comments** — `CHAT_COMMENT_INDEX_UPDATED` broadcast when a comment row is seeded, so
  other clients see new comments without reload
- **Slides** — `isSameFill` treats `null` and `undefined` as equivalent, preventing spurious
  dirty-state on background fills
- **Slides** — "Apply to" select and "Apply" button align in height in the background
  properties panel
- **Admin** — Shift+Arrow extends selection in the members list
- **Chat** — edit and delete throw `ApiError` on failure instead of returning a success flag
- **Home** — two-phase destruct avoids a double-close race on sheet teardown

## [0.0.2] - 2026-05-11

Maintenance release. Email-notification flows, guest-access controls, XLSX import, security
hardening, and a major spreadsheet quality pass.

### Added

- **Sheets** — XLSX import: open an `.xlsx` file in Drive to convert it into an Eigen sheet,
  preserving cell values, number formats, formulas, merged cells, borders, fonts, and column/
  row sizes
- **Mail** — autolink bare `http(s)://` URLs in received message bodies
- **Admin → Email notifications** — four toggles controlling outbound mail: calendar invitations
  to attendees, file ACL additions, file access requests, and shared-file collaborators
- **Admin → Guest access** — open-signup toggle and inactivity-days threshold (defaults:
  open-signup on, cleanup after 7 days of inactivity)
- **Drive** — email shared-file collaborators via a composer pre-populated with the user's
  email signature (uses the same LightEditor that powers chat)
- **Drive** — outbound notifications on access requests, ACL additions, and shares (gated by
  the new admin toggles)
- **Calendar** — email Eigen-user attendees on invite, gated by the calendar-invite toggle
- **User** — owner-info popover on user and team avatars

### Changed

- **Spreadsheet edits made before auto-flush** survive page reload. The backend replays pending
  ops on read (and on XLSX export), so a freshly typed cell value is preserved if you reload
  before the next auto-flush
- **Calendar wire format** — server timestamps travel as native `Date` end-to-end via Eden
  Treaty's reviver (previously Unix-second integers)
- **Mail** — share, access-request, attachment, and collaborator emails share a single HTML
  shell with unified chip styling across mail, chat, and drive
- **Mail** — duplicate new-mail notifications are deduped via a stable tag
- **UI popovers** — edge-collision padding and dynamic max-height so they no longer clip at the
  viewport edge

### Fixed

- **Spreadsheet paste** — slash-direction border paste across multi-tile copies no longer crashes
- **Spreadsheet row/col ops** — read-only ranges and malformed ops surface clear errors instead
  of corrupting sheet state
- **Dialogs** — pointer events that start inside a dialog and end outside no longer dismiss it
  (e.g. selecting text that overshoots the edge)
- **LightEditor** — trims trailing empty paragraphs before save (chat, mail, drive composers)
- **Welcome/invite email headers** — encode UTF-8 correctly (RFC 2047)
- **Shared-document emails** — plain-text fallback now includes the document URL
- **Postfix** — DKIM signs mail relayed from the docker bridge network interface
- **Postfix** — per-recipient delivery limit set to 1 for the Eigen pipe
- **Guest cleanup** — skips when initial setup is incomplete; reconciles on every login to repair
  session/user drift; OTP request race fixed
- **About dialog** — `builtAt` renders in a localized format

### Security

- **Mail templates** — user-provided tokens in welcome/invite emails are HTML-escaped
- **Guest OTP requests** — rate-limited (3 per email per hour, 10 per IP per hour) via an
  in-memory limiter
- **Mail body links** — open in a new tab with `rel="noopener noreferrer"`

## [0.0.1] - 2026-05-03

First public release. Self-hostable workspace with email, file storage, documents, spreadsheets,
presentations, kanban boards, calendar, contacts, and real-time chat — all sharing one API, one auth
system, and one UI.

### Apps

- **Mail** — webmail with full mailbox management; Maildir++ on disk, IMAP via Dovecot
- **Drive** — files with folders, sharing, ACL, thumbnails, previews; local, flat-key, and S3 backends
- **Docs** — collaborative document editor (Tiptap + Yjs); export to DOCX, PDF, and HTML
- **Sheets** — collaborative spreadsheets with op-level Yjs sync (forked fortune-sheet engine)
- **Slides** — collaborative presentations on a 1920×1080 pixel canvas with presentation mode
- **Stickies** — collaborative kanban boards with per-card embedded chat threads
- **Calendar** — recurring events (RFC 5545 RRULE), invitations with RSVP, shared and team calendars
- **Contacts** — contact management with avatars
- **Chat** — real-time chat with 80+ slash commands; rooms live inside Drive (inheriting ACL) and embed
  inside docs and kanban cards as comment threads
- **Space** — personal account settings, profile, and preferences
- **Admin** — organization, team, member, role, quota, and server-wide settings administration; first-run
  setup wizard

### Protocols

- **IMAP** via Dovecot (Maildir++ co-existing with the web UI on the same filesystem)
- **CalDAV** server with discovery, sync-collection, RRULE — tested with Thunderbird
- **WebDAV** server (RFC 4918 Class 1+2) for Drive mounts
- **SMTP** submission on ports 587/465 with DKIM signing; Postfix handles inbound and outbound

### Auth

- Email/password with optional TOTP 2FA
- App passwords for protocol access (IMAP/CalDAV/WebDAV)
- Organizations with teams and role-based admin
- Guest access for shared resources

### Deployment

- Docker Compose stack with optional `edge` (Caddy) and `mail` (Postfix/Dovecot/Unbound) profiles —
  opt out of either when the host already runs its own webserver or mail server
- `bun run setup` — interactive 4-question setup writing `.env.production`
- Automatic HTTPS via Caddy, automatic DKIM key generation
- Backup script and auto-migrating update script
- Mail-domain split: address suffix (`MAIL_DOMAIN`) decoupled from web hostname (`DOMAIN`)
