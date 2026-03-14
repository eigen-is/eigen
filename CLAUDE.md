# CLAUDE.md — Eigen Project Context

Eigen is a self-hosted Google Workspace alternative. Monorepo with integrated apps sharing a single API server, UI
library, and business logic layer.

## Tech Stack

- **Runtime**: Bun (server + client)
- **Backend**: Elysia + Drizzle ORM (SQLite)
- **Frontend**: React 19 + TypeScript + TanStack Router + TanStack Query + Eden Treaty (type-safe API client)
- **UI**: Tailwind CSS 4 + shadcn/ui + Lucide React
- **Auth**: better-auth (email/password, 2FA, orgs, teams)
- **Real-time**: Yjs (collab editing), WebSocket, SSE (notifications)

## Project Structure

```
apps/
  api/          # Elysia backend (port 8000)
  mail/         # Email client
  drive/        # File storage
  docs/         # Document editor (Yjs/Tiptap)
  contacts/     # Contact management
  calendar/     # Calendar + scheduling
  chat/         # Real-time chat (MUD-inspired)
  stickies/     # Kanban board (Yjs)
  slides/       # Presentations (Yjs)
  sheets/       # Spreadsheets (fortune-sheet + Yjs)
  space/        # Team workspace
  people/       # Org/team admin
  index/        # Landing page
  setup/        # First-run wizard

packages/
  lib/          # @workspace/lib — shared types, hooks, API client, SSE handlers, validation
  ui/           # @workspace/ui — shared shadcn components, layout system
  fortune-sheet/ # Forked spreadsheet UI

data/           # Runtime storage (databases, user files)
docs/           # Architecture documentation
```

## Development

```bash
bun run serve          # All apps + API
bun serve:mail         # Single app + API
bun run typecheck      # Type check all packages
bun run test           # API integration tests
bun run check          # typecheck + test
```

### Critical Rules

- **Never run package install commands** — always ask the user
- **No migrations or backward compatibility** — data is throwaway during dev. Prefer clean schemas
- **Always run `bun run typecheck` and `bun run test`** after changes
- **English everywhere** — code, comments, docs
- **No JSDoc** — code should be self-documenting, minimal comments
- **`type` over `interface`** — except when methods are needed
- **Never use `useQuery`/`useMutation` directly in apps** — all data hooks live in
  `packages/lib/src/core/[domain]/hooks/`

## Architecture Patterns

### Backend

| Concept               | Location                                    | Pattern                                                                                                    |
|-----------------------|---------------------------------------------|------------------------------------------------------------------------------------------------------------|
| **Home singleton**    | `apps/api/src/lib/home/home.ts`             | Per-user instance managing DB connections + domain services. Subclasses: `UserHome`, `TeamHome`, `OrgHome` |
| **Domain classes**    | `apps/api/src/lib/[domain]/[domain].ts`     | Business logic (Drive, Maildir, Contacts, Calendar, ChatRoom)                                              |
| **Routes**            | `apps/api/src/routes/[domain].ts`           | Thin Elysia routers, `{auth: true}` for protected                                                          |
| **DB schemas**        | `apps/api/src/lib/[domain]/schema.ts`       | Drizzle ORM schemas                                                                                        |
| **DB config**         | `apps/api/src/lib/[domain]/db-config.ts`    | `DatabaseConfig` with versioned migrations                                                                 |
| **ManagedDatabase**   | `apps/api/src/lib/core/managed-database.ts` | WAL mode, versioning, auto-sync, dirty tracking                                                            |
| **Storage backends**  | `apps/api/src/lib/storage/`                 | `LocalKeyStorage`, `LocalStorage`, `S3Storage`                                                             |
| **Errors**            | `apps/api/src/lib/core/errors.ts`           | `throw new ApiError(status, message)`                                                                      |
| **SSE emission**      | `apps/api/src/lib/[domain]/sse-events.ts`   | `home.notify(buildEvent(...))`                                                                             |
| **Auth**              | `apps/api/src/lib/auth/auth.ts`             | better-auth with org/team/2FA plugins                                                                      |
| **Singleton factory** | `apps/api/src/utils/singleton.ts`           | `createAsyncSingleton()` for Home/DB instances                                                             |

### Frontend

| Concept            | Location                                              | Pattern                                                    |
|--------------------|-------------------------------------------------------|------------------------------------------------------------|
| **API client**     | `packages/lib/src/core/api.ts`                        | Eden Treaty — type-safe from Elysia definitions            |
| **Data hooks**     | `packages/lib/src/core/[domain]/hooks/`               | TanStack Query with hierarchical query keys                |
| **SSE handlers**   | `packages/lib/src/core/[domain]/sse-handlers.ts`      | Invalidate query cache on events                           |
| **Shared types**   | `packages/lib/src/types/[domain].ts`                  | Used by both FE and BE                                     |
| **Validation**     | `packages/lib/src/validation/`                        | Shared FE/BE validation                                    |
| **Colors**         | `packages/lib/src/constants/colors.ts`                | `EIGEN_COLORS`, `EIGEN_ACCENT_COLORS`                      |
| **App shell**      | `packages/ui/src/components/layout/app/app-shell.tsx` | Wraps every app (Topbar + sidebar + content)               |
| **Provider stack** | `packages/ui/src/components/layout/app/eigen-app.tsx` | Auth → SSE → Upload → Preview → Toaster                    |
| **Layout**         | `packages/ui/src/components/layout/column-layout.tsx` | `ColumnLayout` + `Column` with responsive mobile switching |
| **Routing**        | `apps/[name]/src/routes/`                             | TanStack Router, file-based. `_auth.tsx` guards            |

### Query Keys Pattern

```typescript
export const driveKeys = {
    all: ['drive'] as const,
    folders: () => [...driveKeys.all, 'folder'] as const,
    folder: (id: string) => [...driveKeys.folders(), id] as const,
};
```

Export invalidation functions for use in SSE handlers + mutation `onSuccess`.

### SSE Pattern

Backend: mutation → `home.notify(buildEvent())` → SSE stream
Frontend: `useSSE` → domain handler → `queryClient.invalidateQueries()` + toast

### Eigen File Types

| Type     | MIME                        | Extension        | Storage                       |
|----------|-----------------------------|------------------|-------------------------------|
| Document | `application/eigendoc`      | `.eigendoc`      | Dir with `data.db` (Yjs)      |
| Stickies | `application/eigenstickies` | `.eigenstickies` | Dir with `data.db` (Yjs)      |
| Chat     | `application/eigenchat`     | `.eigenchat`     | Dir with `data.db` + `media/` |
| Slides   | `application/eigenslides`   | `.eigenslides`   | Dir with `data.db` (Yjs)      |
| Sheets   | `application/eigensheets`   | `.eigensheets`   | Dir with `data.db` (Yjs)      |

### Data Layout

```
data/home/{userId}/
├── mounts/default/       # Drive (metadata.db + data/ + thumbs/)
│   └── shared.db         # Shared-with-me paths
├── eigen.mail/           # mail.db + Maildir/
├── eigen.contacts/       # contacts.db + avatars/
└── eigen.calendar/       # calendar.db
```

Teams: `data/team/{teamId}/` (Drive + Calendar only)

### Owner ID Prefixes

| Type | Format          | Example         |
|------|-----------------|-----------------|
| User | Raw UUID        | `a1b2c3d4-...`  |
| Team | `team_{teamId}` | `team_x9y8z7w6` |

Resolution: `parseOwnerId()` in `packages/lib/src/types/owner.ts`

## Documentation Index

Detailed architecture docs in `docs/`:

| Doc                                                             | Topic                                           |
|-----------------------------------------------------------------|-------------------------------------------------|
| [CONTRIBUTING.md](docs/CONTRIBUTING.md)                         | Code style, patterns, development workflow      |
| [DATABASE.md](docs/DATABASE.md)                                 | SQLite databases, ManagedDatabase, migrations   |
| [STORAGE.md](docs/STORAGE.md)                                   | Storage backends, mount system, Home singleton  |
| [SSE.md](docs/SSE.md)                                           | Real-time events, adding SSE to new domains     |
| [ACL.md](docs/ACL.md)                                           | Additive ACL inheritance, visibility            |
| [ORGANISATIONS-AND-TEAMS.md](docs/ORGANISATIONS-AND-TEAMS.md)   | Org/team model, team drives, prefixed owner IDs |
| [LAYOUT.md](docs/LAYOUT.md)                                     | AppShell, ColumnLayout, responsive patterns     |
| [LAYOUT-SHARED-COMPONENTS.md](docs/LAYOUT-SHARED-COMPONENTS.md) | UI component lookup reference                   |
| [LAYOUT-UI-LIST.md](docs/LAYOUT-UI-LIST.md)                     | List hooks and patterns                         |
| [LAYOUT-UI-DRIVE.md](docs/LAYOUT-UI-DRIVE.md)                   | Drive UI component reference                    |
| [CHAT.md](docs/CHAT.md)                                         | Chat rooms, slash commands, embedded chats      |
| [CALENDAR.md](docs/CALENDAR.md)                                 | Calendar, RRULE, sharing, team calendars        |
| [SHARE-PROPAGATION.md](docs/SHARE-PROPAGATION.md)               | Push-based sharing, share registry              |
| [STICKIES.md](docs/STICKIES.md)                                 | Kanban board, Yjs data model                    |
| [SLIDES.md](docs/SLIDES.md)                                     | Presentation editor, percentage coordinates     |
| [SHEETS.md](docs/SHEETS.md)                                     | Spreadsheet, op-based Yjs sync                  |
| [CLIPBOARD.md](docs/CLIPBOARD.md)                               | Inter-app copy-paste                            |
| [HOTKEYS.md](docs/HOTKEYS.md)                                   | Keyboard shortcuts                              |
| [PUBLIC-API.md](docs/PUBLIC-API.md)                             | Public endpoints, avatar resolution             |
| [PEOPLE.md](docs/PEOPLE.md)                                     | Org/team management UI                          |
| [TESTING.md](docs/TESTING.md)                                   | Test setup, patterns, test files                |
| [DOCKER.md](docs/DOCKER.md)                                     | Docker deployment                               |

### Future/Planning Docs

| Doc                                                   | Topic                                    |
|-------------------------------------------------------|------------------------------------------|
| [TODO-CHAT-ACL.md](docs/TODO-CHAT-ACL.md)             | Chat membership vs ACL design discussion |
| [TODO-ENCRYPTION.md](docs/TODO-ENCRYPTION.md)         | E2E encryption design                    |
| [TODO-SCALABILITY.md](docs/TODO-SCALABILITY.md)       | Multi-server scaling design              |
| [TODO-GUEST-USERS.md](docs/TODO-GUEST-USERS.md)       | Guest user access plan                   |
| [FORTUNE-SHEETS-TODO.md](docs/FORTUNE-SHEETS-TODO.md) | Fortune-sheet refactoring audit          |
