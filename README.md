# Eigen

**Your own workspace. Simple, secure, self-hosted.**

**Try the live demo at [demo.eigen.is](https://demo.eigen.is).** It is a shared workspace that resets every hour.

Eigen is a self-hosted alternative to Google Workspace. It runs as a single server with integrated apps for email, file storage, documents, spreadsheets, presentations, drawings, kanban boards, calendar, contacts, and real-time chat — all sharing one API, one auth system, and one UI.

The name *Eigen* is Dutch and German for "own." You own your data, you own your infrastructure, you own your workspace.

> For the backstory on how and why this project started, see
> [Eigen: Building a Workspace](https://reindernijhoff.net/2025/10/eigen-building-a-workspace/).

## Why

Given the power large tech companies hold over our data, a self-hosted European alternative feels needed. Eigen aims
to be that alternative: a workspace you can run on your own server, where every byte of data stays under your control.

## Why not Nextcloud?

Nextcloud is the established self-hosted workspace. It is mature, has a huge ecosystem, and if you need something
proven today, it is the safer choice. Eigen is pre-1.0 and built by one person.

Eigen makes different choices:

- **One codebase.** Nextcloud is a core with apps and plugins. Eigen's apps are built together: one API, one auth
  system, one UI. Everything is designed to work with everything else.
- **Collaboration is built in.** In Nextcloud, collaborative editing comes from an external office server (Collabora
  or OnlyOffice). In Eigen, every app is collaborative through CRDTs (Yjs). Two people on the same document, sheet,
  or board works out of the box.
- **Simple to run.** One server, one compose file, SQLite per user. No PHP, no MySQL, no Redis. A backup is a file
  copy.

If Nextcloud works for you, keep using it. Eigen exists for people who want a workspace that feels like one product
instead of a platform with plugins.

## Goal

The first goal is a **self-hostable workspace for individuals, enthusiasts, and small organizations**. During active
development, expect rough edges — but the core is functional and improving fast. As the project matures and stabilizes,
the aim is to make Eigen reliable enough for mid-to-large organizations as well.

## Status & responsibilities

Eigen is **pre-1.0 and actively developed**. The core works, but be deliberate about what you put on it:

- **Breaking changes** are likely between minor versions until 1.0; expect occasional manual migration.
- **You own your data, including the backups.** Use `scripts/backup.sh` (or your own routine) and verify
  it restores. Eigen does not back up your data for you.
- **You own your server's security.** Keep the host patched, lock down SSH, use strong passwords, and
  watch your logs. A self-hosted server is your responsibility end-to-end.
- **No warranty** — see [LICENSE.txt](LICENSE.txt). Eigen is built by a single developer in their spare
  time. It's provided as-is, in good faith, with no SLA.

If data loss in your workspace would be catastrophic, wait for 1.0. For personal use, hobbyists, and
small teams comfortable with rough edges, the current build is functional and improving fast.

## Apps

Eigen ships as a monorepo with a single API server and a set of tightly integrated frontend apps:

- **Mail** — Webmail client with full mailbox management. Email is stored in standard Maildir++ format, fully
  compatible with Dovecot. Connect any IMAP client (Thunderbird, Apple Mail, etc.) to access your mail alongside the
  web UI.
- **Drive** — File storage with folders, sharing, ACL, thumbnails, file previews, and pluggable storage backends
  (local filesystem, flat key-based, or S3-compatible). Soft delete with configurable trash retention. Supports inline
  editing of text, code, and Markdown files. Mount your drives as a network drive in Finder, Windows Explorer, or any
  WebDAV client.
- **Docs** — Collaborative document editor built on Tiptap and Yjs. Multiple users edit the same document in
  real time. Export to DOCX, PDF, and HTML. Embedded comment threads with @mentions.
- **Sheets** — Collaborative spreadsheets using an in-tree sheet engine (forked from fortune-sheet/luckysheet) with Yjs-based op-level sync.
  Concurrent edits on different cells merge cleanly.
- **Slides** — Collaborative presentations with a pixel-based canvas (1920×1080), resolution-independent rendering,
  drag-and-drop objects, background images, and a presentation mode.
- **Vector** — Collaborative drawings on an infinite canvas: sketchy shapes, freehand strokes, arrows that dock to
  shapes, rich text, and images. Export to SVG.
- **Stickies** — Kanban boards with real-time collaboration via Yjs. Drag-and-drop cards and columns. Each card has
  its own embedded chat room for discussion.
- **Calendar** — Full calendar with recurring events (RFC 5545 RRULE), invitations with RSVP, shared calendars, and
  team calendars. Includes a **CalDAV server** — sync with Thunderbird, Apple Calendar, or DAVx5 using standard
  protocols.
- **Contacts** — Contact management with labels and avatars. Contacts are stored as standard vCard files on disk,
  indexed in SQLite. Includes a **CardDAV server** — sync your address book with iOS/macOS Contacts, Thunderbird,
  or DAVx5.
- **Chat** — Real-time chat inspired by classic MUDs. Over 80 built-in slash commands including emotes, whispers,
  and @mentions. Chat rooms live inside Drive (inheriting its ACL), and can be embedded inside documents and
  kanban cards as comment threads.
- **Space** — Personal account settings, profile, and preferences.
- **Admin** — Organization and team administration. Manage members, roles, shared drives, team calendars, quotas, and server-wide settings. Includes the first-run setup wizard.

### Protocol support

Eigen doesn't lock you into its web interface. Standard protocols let you use your favorite native clients:

- **IMAP** — Via Dovecot. Eigen writes Maildir++, Dovecot serves it over IMAP. They coexist on the same filesystem.
- **CalDAV** — Built-in CalDAV server with discovery, sync-collection, and recurring event support. Tested with
  Thunderbird.
- **CardDAV** — Built-in CardDAV server (RFC 6352) with discovery, sync-collection, and addressbook-query support.
  Accepts vCard 3.0 and 4.0; labels and contact photos sync along with the cards.
- **WebDAV** — Built-in WebDAV server (RFC 4918 Class 1+2). Mount your Drive as a network drive in Finder, Windows
  Explorer, Mountain Duck, rclone, or any standard WebDAV client.
- **SMTP** — Postfix handles inbound and outbound email, with DKIM signing and relay support.

## Getting started

### Prerequisites

- [Bun](https://bun.sh) (runtime for both server and client)
- [Git](https://git-scm.com)

### Quick start

```bash
git clone https://github.com/eigen-is/eigen.git
cd eigen
cp .env.development .env
bun install
bun run serve
```

Open `http://localhost:3009/admin` to run the first-time setup wizard. It creates your admin account and configures
storage.

### Docker deployment

For production, Eigen runs as five Docker containers: **Caddy** (reverse proxy with automatic HTTPS), **Eigen API** (Bun), **Postfix** (email), **Dovecot** (IMAP), and **Unbound** (DNS resolver for Postfix). See the [VPS Setup Guide](docker/SETUP-GUIDE.md) for step-by-step instructions, or the [Local Testing Guide](docker/LOCAL-TESTING.md) to try the full stack on your machine.

```bash
git clone https://github.com/eigen-is/eigen.git /opt/eigen
cd /opt/eigen
bun install
bun run setup
```

### Development

```bash
bun run serve          # All apps + API
bun serve:mail         # Single app + API (works for any app name)
bun run lint           # Lint + format check (Biome)
bun run lint:fix       # Auto-fix
bun run typecheck      # Type check all packages
bun run test           # Run all tests
bun run check          # lint + typecheck + repo guards + tests
```

## Architecture

Each user gets their own directory on the server. SQLite databases (per user) store metadata and structured data.
Files are stored separately. No shared database means no way to accidentally access someone else's data. Backups
are trivial — just copy a user's directory.

```
data/home/{userId}/
├── settings.json         # Per-user settings
├── mounts/default/       # Drive files + metadata.db
├── eigen.mail/           # Maildir + mail.db
├── eigen.contacts/       # vCard files + contacts.db + avatars
├── eigen.calendar/       # calendar.db
└── eigen.notifications/  # notifications.db
```

Organizations and teams follow the same pattern in sibling `data/team/{teamId}/` and `data/org/{orgId}/` trees: team drives, team calendars, and group-based ACL. Real-time collaboration runs through Yjs over WebSocket, while Server-Sent Events push live updates to all connected clients.

## Tech stack

| Layer     | Technology                                                        |
|-----------|-------------------------------------------------------------------|
| Runtime   | [Bun](https://bun.sh)                                            |
| Backend   | [Elysia](https://elysiajs.com) + [Drizzle ORM](https://orm.drizzle.team) (SQLite) |
| Frontend  | React 19 + TypeScript + [TanStack Router](https://tanstack.com/router) + [TanStack Query](https://tanstack.com/query) |
| API       | [Eden Treaty](https://elysiajs.com/eden/overview) (end-to-end type-safe) |
| Styling   | [Tailwind CSS 4](https://tailwindcss.com) + [shadcn/ui](https://ui.shadcn.com) + [Lucide](https://lucide.dev) |
| Auth      | [better-auth](https://www.better-auth.com) (email/password, 2FA, organizations, teams) |
| Real-time | [Yjs](https://yjs.dev) (collaborative editing) + WebSocket + SSE |
| Tooling   | [Biome](https://biomejs.dev) (lint + format) + [Vite](https://vite.dev) (build) |

## Contributing

Eigen is open source and contributions are welcome. The project is still in active early development — there's plenty
to do and plenty of room to shape the direction.

See [CONTRIBUTING.md](docs/CONTRIBUTING.md) for how to get involved — whether that's reporting bugs, submitting PRs,
adopting a subsystem, or sponsoring the project. The full project context (for humans and AI agents alike) lives in
[AGENTS.md](AGENTS.md), and [CODE-STANDARDS.md](docs/CODE-STANDARDS.md) covers code style and architecture patterns.

Found a security issue? Please **do not** open a public issue — see [SECURITY.md](SECURITY.md) for how to report
privately.

### Documentation

Architecture docs live in `docs/`:

| Area | Docs |
|------|------|
| Architecture | [Storage](docs/STORAGE.md), [Database](docs/DATABASE.md), [SSE](docs/SSE.md), [ACL](docs/ACL.md), [Search](docs/SEARCH.md), [Scalability](docs/SCALABILITY.md) |
| Deployment | [Docker Setup](docker/SETUP-GUIDE.md), [Local Testing](docker/LOCAL-TESTING.md), [S3 Sync](docs/SYNC.md), [Demo Mode](docs/DEMO_MODE.md), [Testing](docs/TESTING.md) |
| Frontend | [Layout](docs/LAYOUT.md), [Clipboard](docs/CLIPBOARD.md), [Previews](docs/PREVIEWS.md) |
| Features | [Mail](docs/MAIL.md), [Calendar](docs/CALENDAR.md), [Contacts](docs/CONTACTS.md), [Chat](docs/CHAT.md), [Notifications](docs/NOTIFICATION-CENTER.md), [IMAP](docs/IMAP.md), [WebDAV](docs/WEBDAV.md) |
| Apps | [Sheets](docs/SHEETS.md), [Slides](docs/SLIDES.md), [Canvas engine (Vector + Slides)](docs/CANVAS.md), [Stickies](docs/STICKIES.md), [Comments](docs/COMMENTS.md) |
| Operations | [Quota](docs/QUOTA.md), [Server Settings](docs/SERVER-SETTINGS.md), [Export](docs/EXPORT.md), [Organizations](docs/ORGANISATIONS-AND-TEAMS.md) |

## Contact

Questions, ideas, or want to contribute? Reach out at [reinder@eigen.is](mailto:reinder@eigen.is).
