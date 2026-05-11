# Changelog

All notable user-visible changes to Eigen are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com).

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
