# Changelog

All notable user-visible changes to Eigen are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com).

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
