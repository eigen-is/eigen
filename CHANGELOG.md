# Changelog

All notable user-visible changes to Eigen are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com).

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
