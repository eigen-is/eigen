# Eigen

**Your workspace in the cloud. Simple and secure. You control your own data.**

Eigen is a self-hosted alternative to Google Workspace. It runs as a single server with integrated apps for email,
file storage, documents, spreadsheets, presentations, calendar, contacts, and chat — all sharing one API, one auth
system, and one UI library.

## Apps

| App          | Description                                    |
|--------------|------------------------------------------------|
| **Mail**     | Email client with mailbox management           |
| **Drive**    | File storage and management                    |
| **Docs**     | Collaborative document editor (Tiptap + Yjs)   |
| **Sheets**   | Collaborative spreadsheet editor               |
| **Slides**   | Collaborative presentation editor              |
| **Stickies** | Kanban board (Yjs)                             |
| **Calendar** | Calendar and scheduling                        |
| **Contacts** | Contact management                             |
| **Chat**     | Real-time chat with slash commands             |
| **Space**    | User profile and account settings              |
| **People**   | Organization and team admin                    |

## Tech Stack

| Layer     | Technology                                                        |
|-----------|-------------------------------------------------------------------|
| Runtime   | [Bun](https://bun.sh)                                            |
| Backend   | Elysia + Drizzle ORM (SQLite)                                    |
| Frontend  | React 19 + TypeScript + TanStack Router + TanStack Query          |
| API       | Eden Treaty (end-to-end type-safe)                                |
| Styling   | Tailwind CSS 4 + shadcn/ui + Lucide React                        |
| Auth      | better-auth (email/password, 2FA, organizations, teams)           |
| Real-time | Yjs (collaborative editing) + WebSocket + SSE (live updates)      |
| Tooling   | Biome (lint + format) + Vite (build) + GitHub Actions (CI)        |

## Getting Started

```bash
git clone https://github.com/eigen-foundation/eigen.git
cd eigen
bun install
bun run serve
```

Visit `http://localhost:3011/setup` to run the setup wizard. It creates your admin account and configures storage.

## Development

```bash
bun run serve          # Start all apps + API
bun serve:mail         # Start single app + API (works for any app name)
bun run lint           # Check lint + format (Biome)
bun run lint:fix       # Auto-fix lint + format
bun run typecheck      # Type check all packages
bun run test           # Run all tests
bun run check          # All of the above: lint + typecheck + test
```

A pre-commit hook auto-fixes lint and formatting on every commit. CI runs the full check on every push.

## Project Structure

```
apps/
  api/            # Elysia backend (port 8000)
  mail/           # Email client         calendar/  # Calendar
  drive/          # File storage         contacts/  # Contacts
  docs/           # Document editor      chat/      # Real-time chat
  sheets/         # Spreadsheet editor   space/     # User settings
  slides/         # Presentations        people/    # Org/team admin
  stickies/       # Kanban board         index/     # Landing page

packages/
  lib/            # Shared types, hooks, API client, validation
  ui/             # Shared components and layout system
  fortune-sheet/  # Forked spreadsheet engine

data/             # Runtime storage (gitignored)
docs/             # Architecture documentation
```

## Documentation

Architecture docs live in `docs/`. Start with [CONTRIBUTING.md](docs/CONTRIBUTING.md) for code patterns and
development workflow, or [CLAUDE.md](AGENTS.md) for the full project context.

| Area | Docs |
|------|------|
| Architecture | [Storage](docs/STORAGE.md), [Database](docs/DATABASE.md), [SSE](docs/SSE.md), [ACL](docs/ACL.md) |
| Frontend | [Layout](docs/LAYOUT.md), [Clipboard](docs/CLIPBOARD.md), [Media References](docs/MEDIA-REFERENCES.md) |
| Features | [Calendar](docs/CALENDAR.md), [Chat](docs/CHAT.md), [Notifications](docs/NOTIFICATIONS.md), [Previews](docs/PREVIEWS.md) |
| Apps | [Sheets](docs/SHEETS.md), [Slides](docs/SLIDES.md), [Stickies](docs/STICKIES.md), [Comments](docs/COMMENTS_IN_DOCS.md) |
| Operations | [Docker](docs/DOCKER.md), [Testing](docs/TESTING.md), [Quota](docs/QUOTA.md), [Server Settings](docs/SERVER-SETTINGS.md) |

## License

[MIT License](LICENSE)
