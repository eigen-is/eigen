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
- **You own your data, including the backups.** Use `./eigen backup` (or your own routine) and verify it restores. Eigen does not back up your data for you.
- **You own your server's security.** Keep the host patched, lock down SSH, use strong passwords, and watch your logs. A self-hosted server is your responsibility end-to-end.
- **No warranty**: see [LICENSE.txt](LICENSE.txt). Eigen is built by a single developer in their spare time. It's provided as-is, in good faith, with no SLA.

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
- **Contacts** — Contact management with labels and avatars. Each contact is stored as its standard vCard bytes
  in SQLite, with the indexed columns projected from them. Includes a **CardDAV server** — sync your address book with iOS/macOS Contacts, Thunderbird,
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

### Install on a server

Eigen runs in Docker: **Caddy** (reverse proxy with automatic HTTPS), **Eigen API** (Bun), **Postfix** (email), **Dovecot** (IMAP), and **Unbound** (DNS resolver for Postfix). The server needs Docker with Compose 2.20 or newer and curl for the one line below, nothing else. Install Docker, run it, open the printed link:

```bash
mkdir -p /opt/eigen && cd /opt/eigen
curl -fsSL https://eigen.is/install | sh
```

The script fetches the `eigen` command and runs `./eigen setup`. Setup downloads the newest release, asks for your web address, mail domain, how HTTPS reaches Eigen and whether to host email, starts Eigen, and prints a one-time link that finishes the setup in your browser. The same command updates, backs up and restores: `./eigen help`. Rather not pipe a script into `sh`? The [Setup Guide](docker/SETUP-GUIDE.md) shows the same install from the release image with one `docker run`, and every step after it.

`./eigen setup` also builds the images from a clone of this repository. That is for developing Eigen: see [CONTRIBUTING.md § Eigen in Docker](docs/CONTRIBUTING.md#eigen-in-docker).

### Development

Needs [Bun](https://bun.sh) at the version in `.bun-version` (install it with `curl -fsSL https://bun.sh/install | bash -s "bun-v$(cat .bun-version)"`) and [Git](https://git-scm.com). PDF export needs `weasyprint` on your PATH and video thumbnails need `ffmpeg`. Everything else works without them.

```bash
git clone https://github.com/eigen-is/eigen.git
cd eigen
bun install
bun run serve
```

This starts the API on `localhost:8000` and every app on its own port. The API logs a one-time link, `Finish the setup at http://localhost:3009/admin/#setup=…`. Open it to create your admin account and choose where files are stored. Data lands in `data/` in the checkout.

The API reads `.env.development`. Put your own overrides in `.env`. Eigen sends no mail in development: the API logs each message's sender, recipient and subject instead. To read 2FA and guest codes, run [Mailpit](https://mailpit.axllent.org) and add `SMTP_HOST=localhost` and `SMTP_PORT=1025` to `.env`.

```bash
bun run serve:mail     # One app + API (works for any app name)
bun run lint           # Lint + format check (Biome)
bun run lint:fix       # Auto-fix
bun run typecheck      # Type check all packages
bun run test           # Run all tests
bun run check          # lint + typecheck + repo guards + tests, before every PR
```

Docker is only needed to test mail delivery, IMAP or the images: see [CONTRIBUTING.md](docs/CONTRIBUTING.md#eigen-in-docker).

## Architecture

Each user gets their own directory on the server. SQLite databases (per user) store metadata and structured data. Files are stored separately. No shared database means no way to accidentally access someone else's data. `./eigen backup` saves the whole server as one snapshot; [docs/BACKUP.md](docs/BACKUP.md) covers it and the backup of one user.

```
data/home/{userId}/
├── settings.json         # Per-user settings
├── mounts/default/       # Drive files + metadata.db
├── eigen.mail/           # Maildir + mail.db
├── eigen.contacts/       # contacts.db (the vCards themselves) + avatars
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
[AGENTS.md](AGENTS.md), [CODE-STANDARDS.md](docs/CODE-STANDARDS.md) covers code style, and [ARCHITECTURE.md](docs/ARCHITECTURE.md) covers the architecture patterns.

Found a security issue? Please **do not** open a public issue — see [SECURITY.md](SECURITY.md) for how to report
privately.

### Documentation

Architecture docs live in `docs/`:

| Area | Docs |
|------|------|
| Architecture | [Storage](docs/STORAGE.md), [Database](docs/DATABASE.md), [SSE](docs/SSE.md), [ACL](docs/ACL.md), [Search](docs/SEARCH.md), [Scalability](docs/SCALABILITY.md) |
| Deployment | [Docker Setup](docker/SETUP-GUIDE.md), [S3 Sync](docs/SYNC.md), [Demo Mode](docs/DEMO_MODE.md), [Testing](docs/TESTING.md) |
| Frontend | [Layout](docs/LAYOUT.md), [Clipboard](docs/CLIPBOARD.md), [Previews](docs/PREVIEWS.md) |
| Features | [Mail](docs/MAIL.md), [Calendar](docs/CALENDAR.md), [Contacts](docs/CONTACTS.md), [Chat](docs/CHAT.md), [Notifications](docs/NOTIFICATION-CENTER.md), [IMAP](docs/IMAP.md), [WebDAV](docs/WEBDAV.md) |
| Apps | [Sheets](docs/SHEETS.md), [Slides](docs/SLIDES.md), [Canvas engine (Vector + Slides)](docs/CANVAS.md), [Stickies](docs/STICKIES.md), [Comments](docs/COMMENTS.md) |
| Operations | [Quota](docs/QUOTA.md), [Server Settings](docs/SERVER-SETTINGS.md), [Export](docs/EXPORT.md), [Organizations](docs/ORGANISATIONS-AND-TEAMS.md) |

## Contact

Questions, ideas, or want to contribute? Reach out at [reinder@eigen.is](mailto:reinder@eigen.is).
