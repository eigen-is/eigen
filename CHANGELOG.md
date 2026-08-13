# Changelog

All notable user-visible changes to Eigen are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com).

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
  server) shows progress instead of spiralling into a connect/disconnect loop, and a
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
  The app-coloured topbar option is gone
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

- **Visual refresh** — a redesigned app switcher (a grid of large, app-coloured icons with names), a
  lighter font-weight scale across the apps, Drive file icons tinted by app, an animated
  `eigen|app>` wordmark on the landing page and Space home, and a topbar that can switch between
  app-coloured and neutral chrome; toolbar titles are lighter, toolbar borders fade in on scroll,
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
- **Calendar** — cancelled events are excluded from free/busy, and replayed iMIP invitations (a
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
  switcher now shows a clear colour dot for colour-tagged sheets
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
  dragged left), matching standard design-tool behaviour
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
