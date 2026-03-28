# Eigen

**Your workspace in the cloud. Simple and secure. You control your own data.**

A self-hosted Google Workspace alternative. Monorepo with integrated apps sharing a single API server, UI library, and
business logic layer.

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
| **Chat**     | Real-time chat with slash commands and whispers |
| **Space**    | User profile and account settings              |
| **People**   | Organization and team admin                    |
| **Index**    | Landing page                                   |
| **Setup**    | First-run setup wizard                         |

## Tech Stack

- **Runtime**: Bun
- **Backend**: Elysia + Drizzle ORM (SQLite)
- **Frontend**: React 19 + TypeScript + TanStack Router + TanStack Query
- **API client**: Eden Treaty (end-to-end type-safe from Elysia route definitions)
- **Styling**: Tailwind CSS 4 + shadcn/ui + Lucide React
- **Auth**: better-auth (email/password, 2FA, organizations, teams)
- **Real-time**: Yjs (collaborative editing), WebSocket, SSE (notifications)
- **Linting**: Biome
- **Build**: Vite

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) (latest version)

### Installation

```bash
git clone https://github.com/eigen-foundation/eigen.git
cd eigen
bun install
```

### First Run Setup

On first run, Eigen requires initial configuration through a setup wizard:

1. Start the server:
   ```bash
   bun run serve
   ```

2. Visit `http://localhost:3011/setup` in your browser.

3. Configure your instance:
    - **Domain**: Enter your domain (e.g., `eigen.example.com` or `localhost` for development).
    - **Storage type**:
        - `local-fullnames`: Files stored with original names (recommended for development).
        - `local-id`: Files stored by ID (better for production).
        - `s3`: Amazon S3 or compatible storage (for cloud deployment).
    - **Admin account**: Set up your primary admin credentials.

4. After setup completes, you will be redirected to sign in with your admin account.

Setup can only be completed once. The configuration is stored in the server data directory.

## Development

```bash
bun run serve          # All apps + API
bun serve:mail         # Single app + API (works for any app name)
bun run lint           # Lint + format check (Biome)
bun run lint:fix       # Auto-fix lint + format issues
bun run typecheck      # Type check all packages
bun run test           # Run all tests
bun run check          # lint + typecheck + test
bun run build          # Build for production
```

### CI

GitHub Actions (`.github/workflows/check.yml`) runs lint, typecheck, and test on every push to `main` and on pull
requests.

### Pre-commit Hook

A Biome pre-commit hook auto-fixes staged files on commit. Installed via `bun install` (which runs
`git config core.hooksPath .githooks`).

## Docker Deployment

```bash
./deploy.sh --local    # Local: build + Docker Compose at http://localhost/
./deploy.sh            # Production
```

See [docs/DOCKER.md](docs/DOCKER.md) for details.

## Project Structure

```
apps/
  api/            # Elysia backend (port 8000)
  mail/           # Email client
  drive/          # File storage
  docs/           # Document editor (Tiptap + Yjs)
  sheets/         # Spreadsheet editor
  slides/         # Presentation editor
  stickies/       # Kanban board
  calendar/       # Calendar + scheduling
  contacts/       # Contact management
  chat/           # Real-time chat
  space/          # User profile / account settings
  people/         # Org/team admin
  index/          # Landing page
  setup/          # First-run wizard

packages/
  lib/            # @workspace/lib - shared types, hooks, API client, SSE handlers, validation
  ui/             # @workspace/ui - shared shadcn components, layout system
  fortune-sheet/  # Forked spreadsheet engine

data/             # Runtime storage (databases, user files) - gitignored
docs/             # Architecture documentation
```

## Documentation

| Doc | Topic |
|-----|-------|
| [CLAUDE.md](CLAUDE.md) | Project context and architecture for LLMs |
| [CONTRIBUTING.md](docs/CONTRIBUTING.md) | Code style, patterns, development workflow |
| [DATABASE.md](docs/DATABASE.md) | SQLite databases, ManagedDatabase, migrations |
| [STORAGE.md](docs/STORAGE.md) | Storage backends, mount system, Home singleton |
| [SSE.md](docs/SSE.md) | Real-time events and cache invalidation |
| [ACL.md](docs/ACL.md) | Access control, sharing, reshare prevention |
| [LAYOUT.md](docs/LAYOUT.md) | AppShell, ColumnLayout, responsive components |
| [ORGANISATIONS-AND-TEAMS.md](docs/ORGANISATIONS-AND-TEAMS.md) | Org/team model, team drives, People app |
| [NOTIFICATIONS.md](docs/NOTIFICATIONS.md) | Error/success toasts, SSE notification pattern |
| [NOTIFICATION-CENTER.md](docs/NOTIFICATION-CENTER.md) | Persistent notification bell, per-user DB |
| [CHAT.md](docs/CHAT.md) | Chat rooms, slash commands, embedded chats |
| [CALENDAR.md](docs/CALENDAR.md) | Calendar, RRULE, sharing, team calendars |
| [COMMENTS_IN_DOCS.md](docs/COMMENTS_IN_DOCS.md) | Comment index, mentions, resolution tracking |
| [STICKIES.md](docs/STICKIES.md) | Kanban board, Yjs data model |
| [SLIDES.md](docs/SLIDES.md) | Presentation editor, percentage coordinates |
| [SHEETS.md](docs/SHEETS.md) | Spreadsheet, op-based Yjs sync |
| [CLIPBOARD.md](docs/CLIPBOARD.md) | Inter-app copy-paste |
| [MEDIA-REFERENCES.md](docs/MEDIA-REFERENCES.md) | Name-based media/chat references in eigendocs |
| [INLINE-EDITING.md](docs/INLINE-EDITING.md) | Inline text file editing in Drive |
| [PREVIEWS.md](docs/PREVIEWS.md) | File preview system |
| [TYPOGRAPHY.md](docs/TYPOGRAPHY.md) | Self-hosted font system, FontPicker |
| [QUOTA.md](docs/QUOTA.md) | Quota model, resolution, enforcement |
| [SERVER-SETTINGS.md](docs/SERVER-SETTINGS.md) | Runtime-adjustable settings, admin API |
| [TESTING.md](docs/TESTING.md) | Test setup and patterns |
| [IMAP.md](docs/IMAP.md) | Maildir storage, Dovecot compatibility |
| [DOCKER.md](docs/DOCKER.md) | Docker deployment |

## License

[MIT License](LICENSE)
