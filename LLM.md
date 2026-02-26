# Eigen — LLM Context Document

A self-hosted Google Workspace alternative. Monorepo with multiple integrated apps sharing a single API server, UI library, and business logic layer.

This file is the primary context source for contributors and coding agents. Keep it aligned with `docs/*.md` when architecture or workflows change.

---

## 1. Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Runtime | **Bun** (server + client) | latest |
| Backend | **Elysia** + **Drizzle ORM** (SQLite) | 1.4 + 0.44 |
| Frontend | **React 19** + **TypeScript** + **TanStack Router** | 19.1 + 1.140 |
| Data | **TanStack Query** + **Eden Treaty** (type-safe client) | 5.75 |
| UI | **Tailwind CSS 4** + **shadcn/ui** + **Lucide React** | 4.1 |
| Auth | **better-auth** | 1.4 |
| Forms | **react-hook-form** + **zod** | |
| Real-time | **Yjs** + **WebSocket** + **SSE** | |
| Notifications | **sonner** + **next-themes** | |
| Specialized | **@dnd-kit** (drag-drop), **slate** (editor), **react-markdown** | |

---

## 2. Monorepo Structure

```
/
├── apps/
│   ├── api/          # Elysia backend (port 8000)
│   ├── mail/         # Email client (port 3001)
│   ├── drive/        # File storage (port 3002)
│   ├── contacts/     # Contacts (port 3003)
│   ├── space/        # Team workspace / profile (port 3004)
│   ├── calendar/     # Calendar (port 3005)
│   ├── docs/         # Document editor — Slate.js (port 3006)
│   ├── stickies/     # Kanban board — Yjs (port 3007)
│   ├── admin/        # Admin dashboard (port 3010)
│   ├── setup/        # First-run setup wizard (port 3011)
│   ├── index/        # Landing page (port 3000)
│   └── chat/         # Chat — MUD-style slash commands, whispers, emotes (port 3008)
│
├── packages/
│   ├── lib/          # @workspace/lib — shared hooks, types, API client, SSE handlers
│   └── ui/           # @workspace/ui — shared React components (shadcn/ui + custom layout)
│
├── data/             # Runtime data (gitignored). Server DBs + per-user home dirs
├── docs/             # Architecture documentation (12 files, see §14)
├── types/            # External type declarations
├── .env.dev.local    # Local dev env vars
├── .env.eigen        # Production env vars
└── vite.shared.config.ts  # Shared Vite config factory for all frontend apps
```

**Workspace packages** (Bun workspaces, defined in root `package.json`):
- `@apps/api` — backend
- `@workspace/lib` — shared logic (depends on `@apps/api` for Treaty types)
- `@workspace/ui` — shared components (depends on `@workspace/lib`)

---

## 3. Running the Project

### 3.1 Development

```bash
bun run serve              # All frontend apps + API
bun run serve:drive        # API + Drive app
bun run serve:mail         # API + Mail app
bun run serve:contacts     # API + Contacts app
# ...see root package.json for all serve:* scripts

bun run typecheck          # TypeScript check across the monorepo
bun run test               # API integration tests
bun run check              # typecheck + test
```

### 3.2 Production Build

```bash
bun run build              # Build all apps
bun run build:prod         # Build artifacts for Docker deployment
```

### 3.3 Env and Runtime Notes

The API server runs with `--env-file=../../.env` and reads `EIGEN_DATA_ROOT` (defaults to `../../data` relative to `apps/api/`). Frontend apps use Vite env vars from root `.env*` files (`VITE_*` prefix).

---

## 4. Backend Architecture

### 4.1 Entry Point and App Setup

- `apps/api/src/index.ts` — starts Elysia on port 8000
- `apps/api/src/app.ts` — Elysia app instance with all routers, CORS, swagger, and global `onError` handler

**Global error handling**: `ApiError` class (`apps/api/src/lib/core/errors.ts`) carries an HTTP status code. The `onError` handler in `app.ts` catches these and returns the appropriate status + message. Unknown errors return 500.

**Auth middleware**: `apps/api/src/routes/auth.ts` defines a `betterAuth` Elysia plugin with a `macro` that resolves user/session from the `better-auth.session_token` cookie. Routes mark themselves as protected with `{auth: true}`.

### 4.2 Home Singleton (the core abstraction)

Every authenticated user gets a `Home` instance (`apps/api/src/lib/home/home.ts`), lazily created via `getHome(user)` in `apps/api/src/lib/home/get-home.ts`. The Home singleton:

- **Owns** domain class instances: `home.drive` (Drive), `home.mail` (Maildir), `home.contacts` (Contacts)
- **Manages** all SQLite database connections via `ManagedDatabase` (singleton per path, versioned migrations)
- **Broadcasts** SSE events via `home.notify(event)` → all subscribed clients
- **Auto-destructs** after 5 minutes of inactivity (closes DB connections, cleans up singleton)
- **Filesystem root**: `home.fs` is a `LocalStorage` at `{EIGEN_DATA_ROOT}/home/{userId}/`

**TeamHome** (`apps/api/src/lib/home/team-home.ts`) extends Home for team-owned drives. Uses a synthetic user ID `team_{teamId}`, data stored at `{EIGEN_DATA_ROOT}/team/{teamId}/`. Only initializes Drive (no mail/contacts). Created lazily via `getTeamHome(teamId)`.

### 4.3 Data Path Resolution

`apps/api/src/lib/config/paths.ts`:
- `getDataRoot()` reads `process.env['EIGEN_DATA_ROOT']` **lazily** (at call time, not import time) to support test isolation
- `getServerDataPath(filename?)` → `{root}/server/{filename}` — global server DBs
- `getUserHomePath(userId)` → `{root}/home/{userId}` — per-user data
- `getTeamDataPath(teamId)` → `{root}/team/{teamId}` — team-owned drives

### 4.4 API Routes

All in `apps/api/src/routes/`. Each domain has its own Elysia router:

| Router | File | Prefix | Auth |
|--------|------|--------|------|
| `mailRouter` | `mail.ts` | `/mail/` | yes |
| `driveRouter` | `drive.ts` | `/drive/` | yes |
| `contactsRouter` | `contacts.ts` | `/contacts/` | yes |
| `homeRouter` | `home.ts` | `/home/` | yes |
| `spaceRouter` | `space.ts` | `/space/` | yes |
| `adminRouter` | `admin.ts` | `/admin/` | yes |
| `chatRouter` | `chat.ts` | `/chat/` | yes |
| `collabRouter` | `collab.ts` | `/collab/`, `/ws/collab/` | yes (incl. WebSocket) |
| `sseRouter` | `sse.ts` | `/sse/` | yes |
| `publicRouter` | `public.ts` | `/p/` | **no** (public endpoints) |
| `configRouter` | `config.ts` | `/config/` | mixed |
| `setupRouter` | `setup.ts` | `/setup/` | mixed |

**Route → Business logic pattern**: Routes are thin. They call facade functions or domain class methods:
```
Route handler → facade function (apps/api/src/lib/[domain]/[domain].ts)
             → domain class method (e.g., home.drive.createFolder())
             → storage backend + database
```

### 4.5 Domain Classes

| Domain | Class | File | Storage |
|--------|-------|------|---------|
| Drive | `Drive` | `lib/drive/drive.ts` | Mount system (metadata.db + LocalKeyStorage/S3) |
| Mail | `Maildir` | `lib/mail/maildir.ts` | LocalStorage (Maildir format) + mail.db |
| Contacts | `Contacts` | `lib/contacts/contacts.ts` | LocalStorage (avatars/) + contacts.db |
| Collab | `CollabDocument` | `lib/collab/collab-document.ts` | Yjs updates in per-doc SQLite |

Each domain class also has:
- `schema.ts` — Drizzle table definitions
- `db-config.ts` — `DatabaseConfig` with versioned migrations
- `sse-events.ts` — SSE event builder functions

### 4.6 Storage Backends

Three implementations in `apps/api/src/lib/storage/`:

| Backend | Class | Use case |
|---------|-------|----------|
| `LocalKeyStorage` | Drive mounts | Flat `data/{uuid}` files |
| `LocalStorage` | Mail, Contacts, Home.fs | Full directory hierarchy |
| `S3Storage` | Remote drive storage | S3-compatible |

All implement `StorageBackend` (read, write, delete, exists, size). `LocalStorage` additionally provides: list, listDirs, mkdir, rename, stat, dirExists, file(), pathJoin.

### 4.7 Mount System

A Mount (`apps/api/src/lib/mount/mount.ts`) bundles everything for Drive file storage:
- `metadata.db` — file/folder tree (paths, labels, ACL)
- `data/` — file blobs via storage backend
- `thumbs/` — thumbnails (always local)
- `tmp/` — temp files for collab sync

Each user has a `default` mount. Mounts support different storage backends (local-key or S3).

### 4.8 Database Architecture

All SQLite, managed by `ManagedDatabase` (`apps/api/src/lib/core/managed-database.ts`) with:
- Versioned migrations tracked in `__schema_version` table
- WAL mode
- Dirty tracking for remote sync
- Singleton per path

| Database | Path | Purpose |
|----------|------|---------|
| Auth | `{server}/users3.db` | better-auth (users, sessions, accounts) |
| Config | `{server}/config.db` | System config key-value store |
| Mount metadata | `{home}/mounts/{id}/metadata.db` | Drive paths, labels, ACL |
| Shared paths | `{home}/mounts/shared.db` | Files shared with this user |
| Contacts | `{home}/eigen.contacts/contacts.db` | Contact records + labels |
| Mail | `{home}/eigen.mail/mail.db` | Email metadata index |
| Collab doc | Per-document in mount storage | Yjs update blobs |

### 4.9 Error Handling

- `ApiError` class in `apps/api/src/lib/core/errors.ts` — carries HTTP status code
- Thrown from domain logic: `throw new ApiError(404, 'Not found')`
- Caught by global `onError` in `app.ts` → returns `err.status` + `err.message` as plain text
- Status codes used: 400 (bad request), 401 (unauthorized), 403 (forbidden), 404 (not found), 409 (conflict), 500 (server error)

### 4.10 System Configuration

`apps/api/src/lib/config/config.ts` manages a `system_config` key-value table in `config.db`. Stores: domain, SMTP settings, enabled apps, storage type, S3 config, max file size, registration toggle. The setup wizard (`apps/setup`) writes initial config.

---

## 5. Frontend Architecture

### 5.1 App Bootstrap Pattern

Every frontend app follows the same pattern:

```
main.tsx
├── <EigenApp>              (packages/ui — QueryClient, AuthProvider, SSEProvider, UploadProvider, Toaster)
│   └── <LabelProvider>     (optional, for apps with labels)
│       └── <RouterProvider> (TanStack Router with auth context)
│
routes/__root.tsx
├── <AppShell appName="..." sidebar={...}>    (Topbar + sidebar + content)
│   └── <Outlet/>
│
routes/_auth.tsx             (auth guard — redirects to /login if not authenticated)
│   └── <Outlet/>
│
routes/_auth.*.tsx           (actual app routes)
routes/login.tsx             (login page)
routes/index.tsx             (redirect to default route)
```

**Vite config**: Each app uses `createAppConfig(appName)` from `vite.shared.config.ts` which sets port, base path, plugins (TanStack Router, React, Tailwind, tsconfig paths), and build output to `dist/{appName}`.

### 5.2 Layout System

See `docs/LAYOUT.md` for full details. Key components in `packages/ui`:

- **`AppShell`** — topbar + optional sidebar + content area
- **`ColumnLayout`** + **`Column`** — multi-column layouts with responsive mobile switching via `mobileColumn` prop
- **`Topbar`** — blue header bar with app logo, user dropdown, app navigation
- **`SidebarContainer`** — collapsible sidebar (full → condensed → overlay on mobile)
- **`DriveLayout`** — shared two-column layout used by Drive, Docs, and Stickies apps

### 5.3 Shared UI Components

All in `packages/ui/src/components/layout/`. Key ones:

- **User**: `UserAvatar`, `UserPublicAvatar`, `UserItem` (auto-fetch by email)
- **Labels**: `LabelManager`, `LabelDialog`, `LabelAssignSubMenu`, `LabelFilterHeader`
- **Drive**: `DriveLayout`, `DriveTable`, `DriveList`, `DriveDetail`, `DriveAccessDialog`, `FilePreview`
- **Contacts**: `ContactAutosuggest`
- **Providers**: `SSEProvider` (toasts), `UploadProvider` (progress tracking), `LabelProvider`
- **Common**: `SearchBar`, `TooltipButton`, `DeleteDialog`, `ShadowContent`, `ContextMenuAnchor`

### 5.4 Shared Hooks (packages/ui)

List interaction hooks — composable, not a shared list component:

| Hook | Purpose |
|------|---------|
| `useListSelection` | Multi-select with click, Ctrl+click, Shift+click |
| `useKeyboardListNavigation` | Arrow keys, Home/End, Enter/Space, Escape |
| `useListDrag` | Selection-aware drag source with `application/eigen-drag` MIME |
| `useListDropTarget` | Drop target for sidebar items |
| `useContextMenu` | Right-click context menu position tracking |

Used by `DriveTable`, `EmailList`, and `ContactsList` — all three follow the same pattern.

---

## 6. Shared Business Logic (packages/lib)

Package name: `@workspace/lib`. Import via: `@workspace/lib/[domain]`

### 6.1 API Client

`packages/lib/src/lib/api.ts` — Eden Treaty client generated from Elysia route types:

```typescript
import {treaty} from '@elysiajs/eden';
import type {app} from "@apps/api";
export const api = treaty<app>(API_HOST, { fetch: { credentials: 'include' } });
export const driveApi = api.drive;
export const mailApi = api.mail;
// etc.
```

Also exports URL builder functions for file downloads, thumbnails, WebSocket endpoints, etc.

### 6.2 Domain Modules

Each domain in `packages/lib/src/lib/[domain]/` contains:
- `hooks/use-[name].ts` — TanStack Query hooks (queries + mutations)
- `sse-handlers.ts` — SSE event handlers for cache invalidation
- `index.ts` — re-exports public API

**Query key convention**:
```typescript
export const driveKeys = {
    all: ['drive'] as const,
    folders: () => [...driveKeys.all, 'folder'] as const,
    folder: (pathId: string) => [...driveKeys.folders(), pathId] as const,
};
```

**Invalidation pattern**: Dedicated invalidate functions are defined alongside hooks and called from both SSE handlers (cross-tab sync) and mutation `onSuccess` callbacks (immediate local update).

### 6.3 Types

All shared types in `packages/lib/src/types/[domain].ts`. Import from `@workspace/lib/types/[domain]` or `@workspace/lib/types`.

**Rule**: Always use `type` (not `interface`), except when methods are involved. Check existing types before creating new ones.

Key types:
- `DrivePath` — file/folder metadata (id, name, type, parentId, mimeType, acl, labels, thumbnail, etc.)
- `DriveACL` — access control entry (email, read, write, optional type/targetId for team ACL)
- `DriveVisibility` — path visibility (`'private' | 'public-read' | 'public-write'`)
- `Contact` — contact record
- `Email` / `EmailDraft` — parsed email messages
- `SSEvent` — SSE event union type
- `MountConfig` — mount configuration
- `Label` — label with name and color

### 6.4 Auth

`packages/lib/src/lib/auth/` provides `useAuth()` hook and `AuthContextType`. Used by every app for session management and login redirection.

---

## 7. SSE (Real-Time Updates)

```
User Action → API mutation → home.notify(event) → SSE stream → Client handler
                                                                    ↓
                                                          Cache invalidation + Toast
```

| Layer | Location |
|-------|----------|
| Type definitions | `packages/lib/src/types/sse.ts` |
| Event builders (backend) | `apps/api/src/lib/[domain]/sse-events.ts` |
| SSE handlers (frontend) | `packages/lib/src/lib/[domain]/sse-handlers.ts` |
| useSSE hook | `packages/lib/src/lib/sse/hooks/use-sse.ts` |
| SSE Provider (toasts) | `packages/ui/src/components/layout/sse-provider/sse-provider.tsx` |
| SSE route (backend) | `apps/api/src/routes/sse.ts` |

Events are namespaced: `drive:`, `mail:`, `contacts:`. Each domain handler checks the prefix, invalidates appropriate query keys, and returns `true` if handled.

---

## 8. File Types (Custom MIME Types)

| Type | MIME type | Extension | Storage |
|------|-----------|-----------|---------|
| Document | `application/eigendoc` | `.eigendoc` | Folder in metadata.db with `data.db` child (Yjs) |
| Stickies | `application/eigenstickies` | `.eigenstickies` | Same as above |
| Chat | `application/eigenchat` | `.eigenchat` | Room container (see `docs/CHAT.md`) |
| Chat room | `application/eigenchatroom` | `.eigenchatroom` | Per-room `data.db` (messages + read_state) |

**Quirk**: URL params use hyphens (`application-eigendoc`), database uses slashes (`application/eigendoc`).

---

## 9. Testing

Tests are API integration tests in `apps/api/src/test/`. Run with: `bun run test`

### Setup

- `preload.ts` — registered via `--preload`, imports setup and registers `afterAll` cleanup
- `setup.ts` — sets `EIGEN_DATA_ROOT` to a temp dir, calls the `/setup/complete` endpoint to initialize the auth DB and create Alice as admin, then dynamically imports `auth` (dynamic imports ensure env var is set before module load)
- Tests call `app.handle()` directly (no HTTP server) or use Eden Treaty
- Data isolation: each test run gets `data/test-{timestamp}/`, cleaned up after

### Test Users

| User | Email | Purpose |
|------|-------|---------|
| Alice | `alice@test.eigen.is` | Primary user |
| Bob | `bob@test.eigen.is` | Secondary (sharing, ACL, isolation) |
| Charlie | `charlie@test.eigen.is` | Third user for inheritance and multi-user ACL scenarios |

### Test Files

| File | Coverage |
|------|----------|
| `auth.test.ts` | Health check, auth required, user access |
| `drive.test.ts` | Mounts, folders, files, sharing/ACL, docs, stickies, breadcrumb, permissions |
| `org-drive.test.ts` | Team drives, team ACL on personal drives, redundant ACL filtering |
| `home.test.ts` | Storage size |
| `contacts.test.ts` | Contact CRUD, labels, isolation, me endpoint |
| `chat.test.ts` | Chat creation, messages, whisper visibility, slash commands, read-only ACL, backend validation |
| `mail.test.ts` | Mailbox listing, creation, duplicate (409), isolation |

**Important**: Tests run with `--concurrency 1` because test files share SQLite connections via the Home singleton.

---

## 10. Code Style Rules

- **Language**: English everywhere
- **TypeScript**: Strict. Run `bun run typecheck` after changes
- **`type` over `interface`**: Always, unless methods are needed
- **Comments**: Minimal. No JSDoc. Only for complex business logic. Code should be self-documenting
- **Naming**: camelCase (functions), PascalCase (components), domain-based (routes)
- **Imports**: Use `@workspace/lib/[domain]` and `@workspace/ui/components/layout/[component]`, not deep paths
- **UI**: Use shadcn defaults. Keep HTML clean and simple
- **State**: TanStack Query for server state, React hooks for local UI state
- **Hooks rule**: **NEVER** use `useQuery`/`useMutation` directly in frontend apps (`apps/*/src/`). All data-fetching logic MUST live in hooks in `packages/lib/src/lib/[domain]/hooks/`. FE components only import and call these hooks
- **Validation rule**: All email/target validation MUST use shared functions from `packages/lib/src/validation/`. Never duplicate validation logic in FE or BE
- **Package installation**: Do NOT install packages automatically. Ask the user to run the install command

---

## 11. User Data Layout on Disk

```
{EIGEN_DATA_ROOT}/
├── server/
│   ├── users3.db         # better-auth DB (users, sessions, accounts)
│   ├── config.db         # System configuration
│   └── config.json       # Setup state
│
├── home/{userId}/
│   ├── mounts/
│   │   ├── default/
│   │   │   ├── metadata.db    # Drive paths, labels, ACL
│   │   │   ├── data/          # Files by UUID
│   │   │   ├── thumbs/        # Thumbnails (WebP)
│   │   │   └── tmp/           # Collab temp files
│   │   └── shared.db          # Paths shared with this user
│   │
│   ├── eigen.mail/
│   │   ├── mail.db            # Email metadata index
│   │   └── Maildir/           # Maildir format (.sent, .drafts, .trash, etc.)
│   │
│   └── eigen.contacts/
│       ├── contacts.db        # Contact data + labels
│       └── avatars/           # Avatar images (WebP thumbnails)
│
└── team/{teamId}/             # Team-owned drives (same mount structure as user)
    └── mounts/
        └── default/
            ├── metadata.db
            ├── data/
            ├── thumbs/
            └── tmp/
```

---

## 12. Environment Variables

### Dev (`.env.dev.local`)
```
PRODUCTION=0
API_URL=http://localhost:8000
VITE_API_HOST=http://localhost:8000
COOKIE_DOMAIN=localhost
VITE_APP_*_URL=http://localhost:{port}/{app}
```

### Production (`.env.eigen`)
```
PRODUCTION=1
API_URL=https://api.eigen.is
VITE_API_HOST=https://api.eigen.is
COOKIE_DOMAIN=.eigen.is
VITE_APP_*_URL=https://eigen.is/{app}
```

### Special
- `EIGEN_DATA_ROOT` — overrides data directory (used by tests, Docker)

---

## 13. Docker Deployment

Two-container setup (see `docs/DOCKER.md`):
1. **nginx** (~50MB) — serves pre-built static frontend apps, proxies API + WebSocket
2. **api** (~200MB) — Bun runtime with compiled backend

Build strategy: apps built **locally** first (`./build-for-docker.sh`), Docker just copies artifacts. Deploy with `./deploy.sh`.

Ports: nginx on 80/443, API on 8000 (internal). Volumes: `eigen-data` (databases), `eigen-uploads` (files).

---

## 14. Documentation Index

For deep-dives, read the relevant file in `docs/`:

| File | Topic |
|------|-------|
| `CONTRIBUTING.md` | Code style, architecture patterns, conventions |
| `DATABASE.md` | SQLite architecture, ManagedDatabase, migrations |
| `STORAGE.md` | Storage backends, mount system, user data layout |
| `SSE.md` | Real-time events: backend emission and frontend invalidation |
| `LAYOUT.md` | AppShell and responsive layout architecture |
| `LAYOUT-SHARED-COMPONENTS.md` | Shared UI component inventory |
| `LAYOUT-UI-LIST.md` | List interaction hooks and usage patterns |
| `LAYOUT-UI-DRIVE.md` | Drive-specific layout behavior |
| `ORGANISATIONS-AND-TEAMS.md` | Organization setup, teams, team drives, team ACL, prefixed owner IDs |
| `ACL.md` | ACL inheritance and effective permission model |
| `CHAT.md` | Chat architecture, room model, slash commands |
| `STICKIES.md` | Stickies architecture and collaborative behavior |
| `TESTING.md` | Test architecture, data isolation, test users, scripts |
| `DOCKER.md` | Docker deployment, build process, nginx config |

Backlog docs prefixed with `TODO-` are design proposals and planning notes; treat them as non-authoritative until implemented.

---

## 15. Key Patterns to Follow

### Adding a new API endpoint
1. Add route in `apps/api/src/routes/[domain].ts` with `{auth: true}`
2. Business logic in `apps/api/src/lib/[domain]/[domain].ts`
3. Throw `ApiError(status, message)` for errors
4. For new DB tables: add schema in `schema.ts`, migration in `db-config.ts`

### Adding a new frontend hook
1. Create `packages/lib/src/lib/[domain]/hooks/use-[name].ts`
2. Define query keys in the same file
3. Export from `packages/lib/src/lib/[domain]/index.ts`
4. Import as `@workspace/lib/[domain]`

### Adding SSE events for a domain
1. Define event types in `packages/lib/src/types/sse.ts`
2. Create event builders in `apps/api/src/lib/[domain]/sse-events.ts`
3. Emit from business logic via `this.home.notify(buildEvent(...))`
4. Create handler in `packages/lib/src/lib/[domain]/sse-handlers.ts`
5. Register handler in `packages/lib/src/lib/sse/hooks/use-sse.ts`

### Adding a new frontend app
1. Create `apps/{appname}/` with `main.tsx`, `routes/__root.tsx`, `vite.config.ts`
2. Use `createAppConfig(appName)` from `vite.shared.config.ts`
3. Wrap in `<EigenApp>` → `<RouterProvider>`
4. Root route uses `<AppShell>` with optional sidebar
5. Auth routes under `_auth.tsx` layout
6. Add `serve:{appname}` script to root `package.json`
7. Add port to `vite.shared.config.ts` `APP_PORTS`

### Adding a new shared type
1. Define in `packages/lib/src/types/[domain].ts`
2. Export from `packages/lib/src/types/index.ts`
3. Use `type` keyword (not `interface`)
4. **Always discuss with the user before adding/modifying types**

---

## 16. Quirks and Gotchas

- **Eden Treaty** populates `response.error` on API errors and makes `response.data` null. Frontend hooks use `response.data || []` or check `response.error` — they handle error responses gracefully without needing to know the status code
- **Maildir path sanitization**: `sanitizeDirName()` lowercases and dot-prefixes mailbox names (e.g., `Sent` → `Maildir/.sent`). INBOX is `Maildir/.` which resolves to `Maildir/`
- **Collab documents** are folders (not files) in metadata.db containing a `data.db` child. The `data.db` pathId is used as the storage key
- **ACL inheritance**: Purely additive (Google Drive model). Permissions always check local ACL first, then walk up to parent. A child can only *add* permissions, never revoke inherited ones. Supports team-based ACL via `type: 'team'` entries. Redundant ACL entries (already covered by parent or ownership) are auto-stripped on save. See `docs/ACL.md` and `docs/ORGANISATIONS-AND-TEAMS.md`
- **Home singleton timeout**: 5 minutes of inactivity → auto-destruct (closes all DBs, removes from factory cache)
- **Auth DB schema**: better-auth with drizzle adapter does NOT auto-create tables. The setup flow (`/setup/complete`) creates them via `initializeDatabaseSchema()`. Tests use this same setup endpoint rather than manual SQL
- **Import hoisting**: `paths.ts` reads `EIGEN_DATA_ROOT` lazily (via function call) because ES module static imports are hoisted before any code runs. This is critical for test isolation
- **Test concurrency**: Must be 1 because Home singletons share SQLite connections across test files
- **Sidebar Ctrl+B conflict**: The sidebar toggle shortcut conflicts with Bold in the Docs editor. Known issue documented in `docs/TODO-HOTKEYS.md`
- **WebSocket collab**: The `collabRouter` uses Elysia's WebSocket support for Yjs document sync, not the SSE system
- **Thumbnails**: Generated on upload for images only (sharp). Stored as WebP in `thumbs/`. Video/PDF thumbnails not supported
- **`config.json`**: A simple JSON file in `{server}/` that tracks whether initial setup is complete. Separate from `config.db`
