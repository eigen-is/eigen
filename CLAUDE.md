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

- **No migrations or backward compatibility** — data is throwaway during dev. Prefer clean schemas
- **Always run `bun run typecheck` and `bun run test`** after changes
- **English everywhere** — code, comments, docs
- **No JSDoc** — code should be self-documenting, minimal comments
- **`type` over `interface`** — except when methods are needed
- **Never use `useQuery`/`useMutation` directly in apps** — all data hooks live in
  `packages/lib/src/core/[domain]/hooks/`
- **Never use `as any`** — fix the type at the source (route schema, response type) instead of casting in hooks.
  Eden Treaty provides end-to-end safety; `as any` silently breaks it
- **Always `await` async calls**. A bare async call returns a truthy Promise, silently skipping the intended logic.
  Especially dangerous in conditionals (`if (!asyncFn())` is always false)
- **Sanitize user-provided paths and filenames** — validate against `..`, `/`, and control characters before using in
  file system paths or HTTP headers (e.g., `Content-Disposition`). Never interpolate raw user input into headers
- **Use theme tokens, not hardcoded colors** — use `text-muted-foreground`, `bg-muted`, `border` etc. instead of
  `text-gray-500`, `bg-blue-50`. Hardcoded colors break dark mode
- **Mutation error/success handling lives in hooks, not in apps** — every `useMutation` in
  `packages/lib/src/core/[domain]/hooks/` must have an `onError` callback using `onMutationError` from `api-error.ts`.
  Add `onSuccess` toasts only for fire-and-forget operations where the UI doesn't visually reflect the result (e.g.,
  "Email sent", "Settings saved"). Apps should never add their own `try/catch` + `toast.error()` around mutations.
  Apps only need `try/catch` when they must do extra work on failure (e.g., reset UI state), and in that case they
  must NOT show a toast. See [NOTIFICATIONS.md](docs/NOTIFICATIONS.md)
- **Keep docs up to date** — when a task is fully completed, update relevant docs in `docs/` and this file if the
  change affects architecture patterns, file locations, or critical rules

## Architecture Patterns

### Backend

| Concept               | Location                                     | Pattern                                                                                                    |
|-----------------------|----------------------------------------------|------------------------------------------------------------------------------------------------------------|
| **Home singleton**    | `apps/api/src/lib/home/home.ts`              | Per-user instance managing DB connections + domain services. Subclasses: `UserHome`, `TeamHome`, `OrgHome` |
| **Domain classes**    | `apps/api/src/lib/[domain]/[domain].ts`      | Business logic (Drive, Maildir, Contacts, Calendar, ChatRoom)                                              |
| **Routes**            | `apps/api/src/routes/[domain].ts`            | Thin Elysia routers, `{auth: true}` for protected                                                          |
| **DB schemas**        | `apps/api/src/lib/[domain]/schema.ts`        | Drizzle ORM schemas                                                                                        |
| **DB config**         | `apps/api/src/lib/[domain]/db-config.ts`     | `DatabaseConfig` with versioned migrations                                                                 |
| **ManagedDatabase**   | `apps/api/src/lib/core/managed-database.ts`  | WAL mode, versioning, auto-sync, dirty tracking                                                            |
| **Storage backends**  | `apps/api/src/lib/storage/`                  | `LocalKeyStorage`, `LocalStorage`, `S3Storage`                                                             |
| **Errors**            | `apps/api/src/lib/core/errors.ts`            | `throw new ApiError(status, message)`                                                                      |
| **SSE emission**      | `apps/api/src/lib/[domain]/sse-events.ts`    | `home.broadcast(buildEvent(...))`                                                                          |
| **Notifications**     | `apps/api/src/lib/notification-center/`      | `home.notifications.persist({...})` — per-user SQLite, broadcasts SSE                                      |
| **Auth**              | `apps/api/src/lib/auth/auth.ts`              | better-auth with org/team/2FA plugins                                                                      |
| **Server settings**   | `apps/api/src/lib/config/server-settings.ts` | Runtime-adjustable quotas & defaults via `JsonStore<ServerSettings>`                                       |
| **Quota resolution**  | `apps/api/src/lib/config/quota.ts`           | `resolveUserQuotas()` — server default + team overrides (most permissive wins)                             |
| **Quota enforcement** | `apps/api/src/lib/config/enforcement.ts`     | `enforceFileUpload`, `enforceBatchUpload`, `enforceAvatarUpload`                                           |
| **Singleton factory** | `apps/api/src/utils/singleton.ts`            | `createAsyncSingleton()` for Home/DB instances                                                             |

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

### Common Pitfalls

These patterns have caused bugs across multiple domains:

- **Query keys must include `ownerId`** for any owner-scoped data. Without it, switching between personal and team
  contexts serves stale cached data from the wrong owner
- **`SharedDrive` must override every `Drive` creation method** — when adding a new eigen file type, add a
  corresponding `create*` override in `SharedDrive` or it will 404 on shared/team drives
- **MIME type strings must match the Eigen File Types table exactly** — use the constants, don't type them by hand.
  `eigenslides` not `eigenslide`, `eigensheets` not `eigensheet`
- **`validateSearch` in shared routes must extract all URL params the route uses** — missing params (like `uid`)
  silently break detail panes for shared items
- **Never mutate TanStack Query cache directly** — use `queryClient.setQueryData()` or `invalidateQueries()`, not
  direct object mutation on cached data
- **No `"use client"` directives** — this is a Vite project, not Next.js. The directive is a no-op
- **Every authenticated route must include `:ownerId` as the second path segment** — `ownerId` identifies the Home
  that owns the resource. For personal data it equals `user.id`; for team data it's `team_{teamId}`. This consistent
  prefix enables future load-balancer sharding by ownerId (all requests for one Home on the same server). Routes must
  validate that the caller has access to the specified ownerId (owns it or is a team member)

### SSE Pattern

Backend: mutation → `home.broadcast(buildEvent())` → SSE stream
Frontend: `useSSE` → domain handler → `queryClient.invalidateQueries()`
Notifications: `home.notifications.persist({...})` → writes to DB + broadcasts `notification:created` SSE event → toast

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

| Doc                                                             | Topic                                                                        |
|-----------------------------------------------------------------|------------------------------------------------------------------------------|
| [CONTRIBUTING.md](docs/CONTRIBUTING.md)                         | Code style, patterns, development workflow, public API, hotkeys              |
| [DATABASE.md](docs/DATABASE.md)                                 | SQLite databases, ManagedDatabase, migrations                                |
| [STORAGE.md](docs/STORAGE.md)                                   | Storage backends, mount system, Home singleton                               |
| [SERVER-SETTINGS.md](docs/SERVER-SETTINGS.md)                   | ServerSettings, JsonStore, admin API, settings UI                            |
| [QUOTA.md](docs/QUOTA.md)                                       | Quota model, resolution, enforcement functions                               |
| [SSE.md](docs/SSE.md)                                           | Real-time events, adding SSE to new domains                                  |
| [ACL.md](docs/ACL.md)                                           | ACL inheritance, share propagation, chat invite bubbling, reshare prevention |
| [ORGANISATIONS-AND-TEAMS.md](docs/ORGANISATIONS-AND-TEAMS.md)   | Org/team model, team drives, prefixed owner IDs, People app                  |
| [LAYOUT.md](docs/LAYOUT.md)                                     | AppShell, ColumnLayout, shared components, Drive UI, list patterns           |
| [CHAT.md](docs/CHAT.md)                                         | Chat rooms, slash commands, embedded chats                                   |
| [COMMENTS_IN_DOCS.md](docs/COMMENTS_IN_DOCS.md)                 | Comment index, mentions, resolution tracking                                 |
| [CALENDAR.md](docs/CALENDAR.md)                                 | Calendar, RRULE, sharing, team calendars                                     |
| [STICKIES.md](docs/STICKIES.md)                                 | Kanban board, Yjs data model                                                 |
| [SLIDES.md](docs/SLIDES.md)                                     | Presentation editor, percentage coordinates                                  |
| [SHEETS.md](docs/SHEETS.md)                                     | Spreadsheet, op-based Yjs sync                                               |
| [CLIPBOARD.md](docs/CLIPBOARD.md)                               | Inter-app copy-paste                                                         |
| [MEDIA-REFERENCES.md](docs/MEDIA-REFERENCES.md)                 | Name-based media/chat references in eigendocs                                |
| [INLINE-EDITING.md](docs/INLINE-EDITING.md)                     | Inline text file editing in Drive                                            |
| [PREVIEWS.md](docs/PREVIEWS.md)                                 | File preview system, text/image/video previews                               |
| [NOTIFICATIONS.md](docs/NOTIFICATIONS.md)                       | Error/success toasts, SSE notification pattern                               |
| [TODO-NOTIFICATION-CENTER.md](docs/TODO-NOTIFICATION-CENTER.md) | Notification center: persistent bell, per-user DB                            |
| [TESTING.md](docs/TESTING.md)                                   | Test setup, patterns, test files                                             |
| [DOCKER.md](docs/DOCKER.md)                                     | Docker deployment                                                            |
| [IMAP.md](docs/IMAP.md)                                         | Maildir storage format, Dovecot compatibility                                |
| [TYPOGRAPHY.md](docs/TYPOGRAPHY.md)                             | Self-hosted font system, FontPicker                                          |

| [Code Reviews](codereviews/OVERVIEW.md)                         | Full-stack code review findings + fix priorities |

### Future/Planning Docs

| Doc                                                             | Topic                                    |
|-----------------------------------------------------------------|------------------------------------------|
| [TODO-MENTIONS.md](docs/TODO-MENTIONS.md)                       | Cross-app @mention system                |
| [TODO-CHAT-ACL.md](docs/TODO-CHAT-ACL.md)                       | Chat membership vs ACL design discussion |
| [TODO-ENCRYPTION.md](docs/TODO-ENCRYPTION.md)                   | E2E encryption design                    |
| [TODO-SCALABILITY.md](docs/TODO-SCALABILITY.md)                 | Multi-server scaling design              |
| [TODO-GUEST-USERS.md](docs/TODO-GUEST-USERS.md)                 | Guest user access plan                   |
| [TODO-CALENDAR-TIMEZONE.md](docs/TODO-CALENDAR-TIMEZONE.md)     | Timezone-aware recurrence expansion      |
| [FORTUNE-SHEETS-TODO.md](docs/FORTUNE-SHEETS-TODO.md)           | Fortune-sheet refactoring audit          |
| [RESEARCH_AI.md](docs/RESEARCH_AI.md)                           | Local/private AI integration research    |
| [RESEARCH_CALDAV.md](docs/RESEARCH_CALDAV.md)                   | CalDAV implementation plan               |
