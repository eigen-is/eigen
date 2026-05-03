# AGENTS.md — Eigen Project Context

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
  admin/        # Org/team admin + first-run setup wizard
  index/        # Landing page

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
bun run lint           # Lint + format check (biome)
bun run lint:fix       # Auto-fix lint + format issues
bun run typecheck      # Type check all packages
bun run test           # API integration tests
bun run check          # lint + typecheck + test
```

### Critical Rules

- **Read [CODE-STANDARDS.md](docs/CODE-STANDARDS.md) before writing code** — defines typing rules, code style,
  common LLM mistakes with BAD/GOOD examples, and the **self-review checklist**. Must be followed before declaring
  any task complete
- **Read existing code before writing new code** — read 2-3 existing files in the same directory. Match their style,
  structure, naming, and patterns exactly. New code must look like it was always there
- **Read relevant docs before planning or coding** — check `docs/` for architecture docs on the domain you're
  touching (e.g., `docs/COMMENTS.md` before adding comment features, `docs/EXPORT.md` before changing export).
  Don't assume you know the conventions — verify them
- **Always run `bun run check`** after changes (lint + typecheck + test). When multiple agents run in parallel,
  only the main agent should run check — concurrent runs cause deadlocks
- **Code goes in the right layer** — hooks/mutations in `packages/lib/src/core/[domain]/hooks/`, shared types in
  `packages/lib/src/types/`, shared UI in `packages/ui/`, app-specific code in `apps/`. Rule of thumb: if two or
  more apps need it, it belongs in `packages/`. Never put `useQuery`, `useMutation`, error toasts, or `try/catch` +
  `toast.error()` in app components — all error handling lives in hooks using `onMutationError`.
  See [NOTIFICATIONS.md](docs/NOTIFICATIONS.md)
- **Package dependency direction is one-way: `fortune-sheet → lib`, never the reverse.** `packages/lib` is shared
  FE+BE; `packages/fortune-sheet` has React peer dependencies and DOM-coupled modules. If lib imported fortune-sheet,
  the BE would transitively pull React in at module-eval time. Shared sheet types (`Cell`, `Sheet`, `Op`,
  `CellMatrix`, `Range`, `SingleRange`, `ConditionalFormatRule`, …) live in `packages/lib/src/sheets/types.ts`;
  fortune-sheet's `engine/types.ts` and `state/types.ts` re-export them. Sheet utilities that need to be importable
  by both FE and BE (e.g. `opToPatchOnSheets`) live in `packages/lib/src/sheets/`
- **Don't break the type chain** — types flow from Elysia route handlers → Eden Treaty → hooks → components
  automatically. No `as any`, no `as Type` casts. Fix types at the source (add return type annotations to backend
  handlers using shared types from `packages/lib/src/types/`). See CODE-STANDARDS.md § Typing
- **Backend errors use `ApiError`** — `throw new ApiError(status, message)` for HTTP errors.
  `throw new Error()` only for internal invariants (db not open, missing config)
- **Think about every `await`** — a bare async call returns a truthy Promise (dangerous in conditionals: `if
  (!asyncFn())` is always false). Fire-and-forget must have `.catch()`. Skip `await` when blocking would hurt
  response time and failure is acceptable
- **Sanitize user-provided paths** — validate against `..`, `/`, and control characters before filesystem or
  header use. Never interpolate raw user input into HTTP headers
- **Check existing code before writing new** — shared components in `packages/ui/src/components/layout/`
  (`TooltipButton`, `DeleteDialog`, `EmptyState`, etc.), utilities in `packages/lib/` (`cn()`, `formatDate`,
  shared types). Don't reinvent them. See [LAYOUT.md](docs/LAYOUT.md)
- **Fix broken windows** — fix pre-existing issues if the fix is straightforward
- **Self-review before declaring done** — review your diff against the checklist in CODE-STANDARDS.md
- **Keep docs up to date** — update `docs/` and this file when changes affect architecture

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
| **Auth**              | `apps/api/src/lib/auth/auth.ts`              | better-auth with org/team/2FA/API key plugins                                                              |
| **Protocol auth**     | `apps/api/src/lib/auth/protocol-auth.ts`     | `verifyProtocolAuth()` — shared IMAP/CalDAV/WebDAV auth (app password → primary password fallback)         |
| **WebDAV**            | `apps/api/src/lib/webdav/`                   | RFC 4918 Class 1+2 server at `/webdav/:ownerId/:mountId/*`; mirrors CalDAV layer                           |
| **Server config**     | `apps/api/src/lib/config/server-config.ts`   | Identity + secrets written once at setup (`domain`, `orgName`, `orgId`, `secret`, `setupCompleted`)        |
| **Server settings**   | `apps/api/src/lib/config/server-settings.ts` | Runtime-adjustable quotas, storage default (`defaults.mount.{storageType,s3Config}`), onboarding, guests   |
| **Quota resolution**  | `apps/api/src/lib/config/quota.ts`           | `resolveUserQuotas()` — server default + team overrides (most permissive wins)                             |
| **Quota enforcement** | `apps/api/src/lib/config/enforcement.ts`     | `getUploadMaxSize`, `enforceAvatarUpload`                                                                  |
| **Mailer**            | `apps/api/src/lib/core/mailer.ts`            | `sendMail(OutboundMail)` — sendmail transport, skips in dev, supports replyTo/attachments                  |
| **Environment**       | `apps/api/src/lib/config/env.ts`             | `isProduction()` — checks `PRODUCTION=1` or `NODE_ENV=production`                                         |
| **Singleton factory** | `apps/api/src/utils/singleton.ts`            | `createAsyncSingleton()` for Home/DB instances                                                             |
| **Home relay**        | `apps/api/src/lib/home/home-relay.ts`        | Cross-home messaging via `sendToHome()`; reads via `pull*()`. See [SCALABILITY.md](docs/SCALABILITY.md)    |
| **Scheduler**         | `apps/api/src/lib/scheduler/`                | `scheduleInterval(name, ms, fn)` for in-process periodic jobs; register in `jobs.ts`                       |

#### Drive Architecture

The Drive system has four layers. When adding new features, all four need changes:

```
Route (thin handler)  →  SharedDrive (ACL wrapper)  →  Drive (business logic)  →  Mount (storage + DB)
```

- **Mount** (`apps/api/src/lib/mount/mount.ts`): Core storage operations on a single mount's `metadata.db`.
  Handles file CRUD, path resolution, storage key building. Three storage backends: `local` (hierarchical
  paths), `local-key` (flat UUID keys), `s3` (S3-compatible)
- **Drive** (`apps/api/src/lib/drive/drive.ts`): High-level API over multiple mounts. Handles ACL
  propagation, collab document lifecycle, SSE emission, sharing
- **SharedDrive** (`apps/api/src/lib/drive/sharedDrive.ts`): ACL-enforcing wrapper, composition over
  inheritance — does NOT extend Drive. `getSharedDrive()` returns `Drive | SharedDrive`; routes can only
  call methods present on both, so adding a public method to `Drive` without a matching `SharedDrive`
  wrapper is a TS error at the callsite. Own-drive routes get raw Drive (no ACL overhead); cross-owner
  routes get SharedDrive (ACL-checked)
- **Routes** (`apps/api/src/routes/drive.ts`): Thin Elysia handlers that delegate via `getSharedDrive`

### Frontend

| Concept            | Location                                              | Pattern                                                    |
|--------------------|-------------------------------------------------------|------------------------------------------------------------|
| **API client**     | `packages/lib/src/core/api.ts`                        | Eden Treaty — type-safe from Elysia definitions            |
| **Data hooks**     | `packages/lib/src/core/[domain]/hooks/`               | TanStack Query with hierarchical query keys                |
| **SSE handlers**   | `packages/lib/src/core/[domain]/sse-handlers.ts`      | Invalidate query cache on events                           |
| **Shared types**   | `packages/lib/src/types/[domain].ts`                  | Used by both FE and BE                                     |
| **Validation**     | `packages/lib/src/validation/`                        | Shared FE/BE validation                                    |
| **Colors**         | `packages/lib/src/constants/colors.ts`                | `EIGEN_COLORS`, `EIGEN_ACCENT_COLORS`                      |
| **Yjs utilities**  | `packages/lib/src/core/collab/yjs-utils.ts`           | `jsonToYType`, `restoreYjsDoc` — shared across collab apps |
| **App shell**      | `packages/ui/src/components/layout/app/app-shell.tsx` | Wraps every app (Topbar + sidebar + content)               |
| **Provider stack** | `packages/ui/src/components/layout/app/eigen-app.tsx` | Auth → SSE → Upload → Preview → Toaster                    |
| **Layout**         | `packages/ui/src/components/layout/app/column-layout.tsx` | `ColumnLayout` + `Column` with responsive mobile switching |
| **Routing**        | `apps/[name]/src/routes/`                             | TanStack Router, file-based. `_auth.tsx` guards            |

#### Page Layout Pattern

Every page uses `ColumnLayout` + `Column`. The toolbar is a **separate prop**, not part of the page content.
The `Column` renders the toolbar in a fixed `h-12` bar with `px-4 border-b`. This ensures consistent
toolbar height across all pages.

```tsx
<ColumnLayout mobileColumn={showDetail ? 'detail' : 'list'}>
    <Column id="list" width="flex" toolbar={<MyToolbar />}>
        <MyContent />
    </Column>
    <Column id="detail" width="400px" onBack={handleBack} toolbar={<DetailToolbar />}>
        <DetailContent />
    </Column>
</ColumnLayout>
```

Use `width="flex"` for a single full-width column. The toolbar text should use the same sizing as other
toolbars — match the `BreadcrumbPage` styling (`text-sm text-foreground font-normal`).

#### Hover-Only Icons Pattern

To show action icons only on row hover (like the share icon in Drive), use the Tailwind `group` +
`invisible group-hover:visible` pattern:

```tsx
<TableRow className="eigen-list-item group">
    <TableCell>
        <span>Item name</span>
        <div className="invisible group-hover:visible ml-auto">
            <TooltipButton icon={Edit} tooltipText="Edit" className="h-7 w-7" onClick={...} />
        </div>
    </TableCell>
</TableRow>
```

Use `TooltipButton` from `packages/ui/src/components/layout/toolbar/tooltip-button.tsx` for icon buttons
with tooltips. Don't rebuild Tooltip+Button manually.

If hover icons would affect row height, use `absolute` positioning so they float over the row.

#### Key UI Components

Before building custom UI, check these exist in `packages/ui/src/components/layout/`:

| Component       | File                        | Use for                              |
|-----------------|-----------------------------|--------------------------------------|
| `TooltipButton` | `toolbar/tooltip-button.tsx` | Icon button with tooltip             |
| `DeleteDialog`  | `delete/delete-dialog.tsx`   | Destructive action confirmation      |
| `ConfirmDialog` | `delete/confirm-dialog.tsx`  | Generic confirmation dialog          |
| `EmptyState`    | `app/empty-state.tsx`        | "Nothing here" message with icon     |
| `LoadingState`  | `app/loading-state.tsx`      | Centered spinner                     |
| `ErrorState`    | `app/error-state.tsx`        | Error message display                |
| `SearchBar`     | `search-bar/search-bar.tsx`  | Search input with icon               |
| `FileMenu`      | `toolbar/file-menu.tsx`      | File dropdown (rename, delete, etc.) |
| `RequestAccessView` | `app/request-access-view.tsx` | "Request access" screen for shared resources (hides sidebar) |

Full component list: [LAYOUT.md](docs/LAYOUT.md)

### Query Keys Pattern

See [CODE-STANDARDS.md](docs/CODE-STANDARDS.md) for the canonical `driveKeys` example. **Query keys must
always include `ownerId`** — see Common Pitfalls below. Export invalidation functions for use in SSE
handlers + mutation `onSuccess`.

### Common Pitfalls

These patterns have caused bugs across multiple domains:

- **Query keys must include `ownerId`** for any owner-scoped data. Without it, switching between personal and team
  contexts serves stale cached data from the wrong owner
- **Add a `SharedDrive` wrapper for every route-callable `Drive` method** — `getSharedDrive` returns
  `Drive | SharedDrive`, so a `Drive` method without a matching `SharedDrive` method is unreachable from
  routes (TS error). Add the wrapper with the appropriate permission check (`withReadPermission`,
  `withWritePermission`, or owner check)
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
- **Never call `getHome()` for another user's data** — all cross-home interactions (where one user's action
  touches another user's Home) must go through the relay in `home-relay.ts`: `sendToHome()` for push,
  `pull*()` for reads. `getHome()` is fine for the current request's own home. This is the sharding seam —
  only `home-relay.ts` changes when homes move to different servers. See [SCALABILITY.md](docs/SCALABILITY.md)
- **Use `ColumnLayout` + `Column` with `toolbar` prop for page layout** — don't put the toolbar inside the page
  content. The `Column` component renders the toolbar in a fixed-height bar. See Page Layout Pattern above
- **Use existing shared components** — check `packages/ui/src/components/layout/` before building custom UI.
  `TooltipButton`, `DeleteDialog`, `EmptyState`, etc. already exist

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

### Owner ID Prefixes

User = raw UUID (`a1b2c3d4-...`), Team = `team_{teamId}`. Resolution: `parseOwnerId()` in
`packages/lib/src/types/owner.ts`. Data layout: see [STORAGE.md](docs/STORAGE.md).

For iMIP (external calendar invitations), external organizers have no Eigen user ID — `organizerUserId`
is set to `external_{email}` (e.g. `external_alice@example.com`). Same prefix convention, same
`startsWith('external_')` detection idiom. See [CALENDAR.md](docs/CALENDAR.md#imip-email-based-calendar-invitations).

## Testing

Tests are in `apps/api/src/test/`. Run with `bun run test` or `bun test apps/api/src/test/[file].test.ts`.

**Integration tests** (`drive.test.ts`, `calendar.test.ts`, etc.) use test helpers from `setup.ts`:
- `getTestContext()` → returns `{ alice, bob, charlie }` test users with session tokens and API clients
- `authedRequest(token, path, options?)` → make authenticated HTTP request
- `driveGet/drivePost/drivePut/driveDelete` → typed drive API helpers
- `driveGetPermission` → check read/write permissions

**Unit tests** (`mount.test.ts`, `storage.test.ts`, etc.) create isolated instances with temp directories.

See [TESTING.md](docs/TESTING.md) for full patterns.
