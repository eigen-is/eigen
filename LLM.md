# Eigen — LLM Context Document

Eigen is a self-hosted Google Workspace alternative. It is a monorepo with multiple integrated apps sharing a single API
server, UI library, and business logic layer.

This document serves as the entry point for coding agents. For deep-dives into specific systems, follow the references
to `docs/*.md`.

## Tech Stack

- **Runtime**: Bun (server + client)
- **Backend**: Elysia + Drizzle ORM (SQLite)
- **Frontend**: React 19 + TypeScript + TanStack Router + TanStack Query + Eden Treaty (type-safe API client)
- **UI**: Tailwind CSS 4 + shadcn/ui + Lucide React
- **Auth**: better-auth
- **Real-time**: Yjs (collab), WebSocket, Server-Sent Events (SSE)

## Project Structure

- `/apps/api`: Backend server (`port 8000`)
- `/apps/*`: Frontend applications (e.g., `mail`, `drive`, `contacts`, `chat`, `docs`, `slides`, `sheets`, `stickies`, `calendar`, `space`, `index`, `people`, `setup`)
- `/packages/lib`: `@workspace/lib` — Shared types, hooks, API client, SSE handlers
- `/packages/ui`: `@workspace/ui` — Shared UI components (shadcn defaults)
- `/data`: Runtime storage (databases, user files)
- `/docs`: Architecture documentation

## Development Workflow

- **Never run package install commands** - always ask the user.
- **Run dev server**: `bun run serve`
- **Tests & Types**: Always run `bun run typecheck` and `bun run test` after changes.

## Code Style & Rules

- **Language**: English everywhere.
- **Types**: Always use `type` instead of `interface` (except when methods are involved).
- **Naming**: `camelCase` for functions, `PascalCase` for components, domain-based for routes.
- **Comments**: Keep them minimal. Code should be self-documenting. No JSDoc.
- **Imports**: Import from `@workspace/lib/[domain]` and `@workspace/ui/components/...`. Avoid deep relative paths.
- **Data Fetching**: NEVER use `useQuery`/`useMutation` directly in frontend apps. All data-fetching logic MUST live in
  `packages/lib/src/core/[domain]/hooks/`.
- **Validation**: Shared validation logic lives in `packages/lib/src/validation/`. Do not duplicate in FE/BE.

## Backend Architecture

- **Home Singleton**: The core abstraction. `apps/api/src/lib/home/home.ts`. Owns DB connections and domain classes (
  `Drive`, `Maildir`, `Contacts`).
- **TeamHome**: Team-owned drives using synthetic user ID `team_{teamId}`. Extends Home with Drive only.
- **OrgHome**: Organization-level operations and management.
- **Routing**: `apps/api/src/routes/[domain].ts`. Routes are thin and call domain class methods.
- **Databases**: SQLite managed by `ManagedDatabase`. Uses versioned migrations. Stored in user's `/data/home/{userId}/`
  or `/data/team/{teamId}/`.
- **Storage Backends**: `LocalKeyStorage` (Drive), `LocalFilesystem` (Mail, Contacts), `S3Storage`.
- **Error Handling**: Throw `ApiError(status, message)` (`apps/api/src/lib/core/errors.ts`), caught by global `onError`.

See:

- [Database Architecture](docs/DATABASE.md)
- [Storage & Mounts](docs/STORAGE.md)
- [Organizations & Teams](docs/ORGANISATIONS-AND-TEAMS.md)
- [ACL & Sharing](docs/ACL.md)
- [Chat System](docs/CHAT.md)

## Frontend Architecture

- **App Shell**: Standardized layout via `<AppShell>` (`packages/ui`).
- **Real-Time**:
    - Mutations invalidate local TanStack Query cache.
    - Backend emits SSE via `home.notify()`.
  - FE listens via handlers in `packages/lib/src/core/[domain]/sse-handlers.ts` to invalidate cache across tabs.
- **File Types**: `.eigendoc` (Docs), `.eigenstickies` (Stickies), `.eigenchat` (Chat), `.eigenslides` (Slides),
  `.eigensheets` (Sheets). They are directories with internal `data.db` SQLite files.

See:

- [SSE Architecture](docs/SSE.md)
- [Layout System](docs/LAYOUT.md)
- [Shared Components](docs/LAYOUT-SHARED-COMPONENTS.md)
- [List UI Patterns](docs/LAYOUT-UI-LIST.md)

## Documentation Index

Read these for specific implementation details:

- `docs/CONTRIBUTING.md`: Full architecture patterns and guidelines.
- `docs/CHAT.md`: Chat system architecture.
- `docs/STICKIES.md`: Kanban board collaborative structure.
- `docs/SLIDES.md`: Slides app implementation plan.
- `docs/SHEETS.md`: Spreadsheet editor overview.
- `docs/TESTING.md`: Test setup and guidelines.
- `docs/DOCKER.md`: Deployment structure.
