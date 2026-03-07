# Copilot Instructions for Eigen

A self-hosted Google Workspace alternative. Monorepo with integrated apps (Mail, Drive, Docs, Contacts, Calendar, etc.) sharing a single API server.

---

## Build, Test, and Lint Commands

### Development
```bash
# Run all apps + API server
bun run serve

# Run specific app with API server
bun serve:drive
bun serve:mail
bun serve:contacts
# etc. (see package.json for all serve:* scripts)

# Type check entire monorepo
bun run typecheck

# Run API integration tests
bun run test

# Run both type check and tests
bun run check
```

### Production Build
```bash
# Build all apps
bun run build

# Build for Docker deployment
bun run build:prod
```

### Testing
- Tests are API integration tests in `apps/api/src/test/`
- Run with `bun run test` (or `bun --filter '@apps/api' test`)
- Tests run with `--concurrency 1` due to shared SQLite connections via Home singleton
- Each test run uses isolated temp data directory (`data/test-{timestamp}/`)
- Test users: Alice (`alice@test.eigen.is`), Bob (`bob@test.eigen.is`), and Charlie (`charlie@test.eigen.is`)

---

## High-Level Architecture

### Monorepo Structure
- **`/apps/api`** - Elysia backend (port 8000) serving all frontend apps
- **`/apps/*`** - 11 frontend apps (React + TanStack Router), each on different port
- **`/packages/lib`** - Shared business logic, API client (Treaty), types, hooks, SSE handlers
- **`/packages/ui`** - Reusable UI components (shadcn/ui + custom layout system)

### Backend: Home Singleton Pattern
Every authenticated user gets a **Home** instance (`apps/api/src/lib/home/home.ts`):
- Owns domain class instances: `home.drive` (Drive), `home.mail` (Maildir), `home.contacts` (Contacts)
- Manages all SQLite database connections via `ManagedDatabase` (singleton per path)
- Broadcasts SSE events via `home.notify(event)` to all subscribed clients
- Auto-destructs after 5 minutes of inactivity (closes DBs, cleans up)
- Filesystem root: `home.fs` at `{EIGEN_DATA_ROOT}/home/{userId}/`

### Route → Business Logic Flow
```
API Route (thin)
  → Facade function (apps/api/src/lib/[domain]/[domain].ts)
    → Domain class method (e.g., home.drive.createFolder())
      → Storage backend + database
```

### Frontend: App Bootstrap Pattern
All apps follow the same structure:
```
main.tsx
  → <EigenApp>              (QueryClient, AuthProvider, SSEProvider, UploadProvider, Toaster)
    → <LabelProvider>       (optional)
      → <RouterProvider>    (TanStack Router with auth context)
        → routes/__root.tsx
          → <AppShell>      (Topbar + sidebar + content)
            → <Outlet/>
```

Protected routes use `_auth.tsx` layout that redirects to `/login` if not authenticated.

### Real-Time Updates (SSE)
```
User Action → API mutation → home.notify(event) → SSE stream → Client handler
                                                                  ↓
                                                        Cache invalidation + Toast
```

**Key locations:**
- Type definitions: `packages/lib/src/types/sse.ts`
- Event builders (backend): `apps/api/src/lib/[domain]/sse-events.ts`
- SSE handlers (frontend): `packages/lib/src/core/[domain]/sse-handlers.ts`
- Provider with toasts: `packages/ui/src/components/layout/sse-provider/sse-provider.tsx`

**Invalidation pattern:** Create dedicated invalidate functions called from both:
1. SSE handlers (cross-tab sync)
2. Mutation `onSuccess` callbacks (immediate local update)

### Data Storage Layout
```
{EIGEN_DATA_ROOT}/
├── server/
│   ├── users3.db          # better-auth (users, sessions, accounts)
│   ├── config.db          # System configuration
│   └── config.json        # Setup state
│
└── home/{userId}/
    ├── mounts/
    │   ├── default/
    │   │   ├── metadata.db    # Drive paths, labels, ACL
    │   │   ├── data/          # Files by UUID
    │   │   ├── thumbs/        # Thumbnails
    │   │   └── tmp/           # Collab temp files
    │   └── shared.db
    │
    ├── eigen.mail/
    │   ├── mail.db            # Email metadata
    │   └── Maildir/           # Maildir format
    │
    └── eigen.contacts/
        ├── contacts.db
        └── avatars/
```

### Database Architecture
All SQLite, managed by `ManagedDatabase` with:
- Versioned migrations tracked in `__schema_version` table
- WAL mode
- Singleton per path
- Auto-closes on Home timeout

**Important:** `paths.ts` reads `EIGEN_DATA_ROOT` lazily (via function call) for test isolation.

---

## Key Conventions

### Code Style
- **ALWAYS USE ENGLISH** in all code
- **Use `type` instead of `interface`** (except when methods are needed)
- **No JSDoc comments** - code should be self-documenting
- **Minimal comments** - only for complex business logic
- camelCase (functions), PascalCase (components), domain-based (routes)

### Types & Shared Logic
- Types: `packages/lib/src/types/[domain].ts`
- Import: `@workspace/lib/types/[domain]` or `@workspace/lib/types`
- **Always discuss with user before adding/modifying types**
- Shared logic: `packages/lib/src/core/[domain]/`
- Import: `@workspace/lib/[domain]` (not deep paths)

### API Routes
- Location: `apps/api/src/routes/[domain].ts`
- Protected routes: `{auth: true}`
- Error handling: Throw `ApiError(status, message)` from `apps/api/src/lib/core/errors.ts`
- Global `onError` handler in `app.ts` catches ApiError and returns appropriate status

### Hooks & Data Fetching
- **CRITICAL:** NEVER use `useQuery`/`useMutation` directly in frontend apps (`apps/*/src/`)
- ALL data-fetching logic MUST live in hooks in `packages/lib/src/core/[domain]/hooks/`
- FE components only import and call these hooks
- Query keys pattern:
  ```typescript
  export const driveKeys = {
      all: ['drive'] as const,
      folders: () => [...driveKeys.all, 'folder'] as const,
      folder: (pathId: string) => [...driveKeys.folders(), pathId] as const,
  };
  ```

### API Client (Eden Treaty)

- Use Treaty client from `packages/lib/src/core/api.ts`
- Type-safe, auto-generated from Elysia routes
- Imports: `import {driveApi, mailApi, contactsApi} from '@workspace/lib/api';`
- Error handling: Eden populates `response.error` on API errors, makes `response.data` null
- Frontend hooks use `response.data || []` or check `response.error`

### Storage Backends
Three pluggable implementations in `apps/api/src/lib/storage/`:
- **LocalFilesystem** - Full filesystem operations (Mail, Contacts)
- **LocalKeyStorage** - Flat UUID-based files (Drive mounts)
- **S3Storage** - S3-compatible object storage

All implement `StorageBackend` interface. See `docs/STORAGE.md` for details.

### Mount System
A Mount (`apps/api/src/lib/mount/mount.ts`) bundles Drive file storage:
- `metadata.db` - file/folder tree (paths, labels, ACL)
- `data/` - file blobs via storage backend
- `thumbs/` - thumbnails (always local)
- `tmp/` - temp files for collab sync

Each user has a `default` mount. Supports different storage backends (local-key or S3).

### Custom File Types
| Type | MIME Type | Extension |
|------|-----------|-----------|
| Document | `application/eigendoc` | `.eigendoc` |
| Stickies | `application/eigenstickies` | `.eigenstickies` |
| Chat | `application/eigenchat` | `.eigenchat` |
| Chat room | `application/eigenchatroom` | `.eigenchatroom` |

**Quirk:** URL params use hyphens (`application-eigendoc`), database uses slashes (`application/eigendoc`).

### Validation
- **CRITICAL:** All email/target validation MUST use shared functions from `packages/lib/src/validation/`
- Never duplicate validation logic in FE or BE

### Layout System
See `docs/LAYOUT.md` for full details. Key components in `packages/ui`:
- **AppShell** - topbar + optional sidebar + content area
- **ColumnLayout** + **Column** - responsive multi-column layouts with `mobileColumn` prop
- **DriveLayout** - shared two-column layout (Drive, Docs, Stickies)
- **SidebarContainer** - collapsible sidebar (full → condensed → overlay on mobile)

### Shared List Hooks
Composable hooks in `packages/ui`, not a shared list component:
- `useListSelection` - Multi-select (click, Ctrl+click, Shift+click)
- `useKeyboardListNavigation` - Arrow keys, Home/End, Enter/Space, Escape
- `useListDrag` - Selection-aware drag with `application/eigen-drag` MIME
- `useListDropTarget` - Drop target for sidebar items
- `useContextMenu` - Right-click position tracking

Used by `DriveTable`, `EmailList`, `ContactsList` following the same pattern.

### Package Installation
- **NEVER run package install commands automatically**
- Always ask the user to run the command

---

## Adding New Features

### New API Endpoint
1. Add route in `apps/api/src/routes/[domain].ts` with `{auth: true}`
2. Business logic in `apps/api/src/lib/[domain]/[domain].ts`
3. Throw `ApiError(status, message)` for errors
4. For new DB tables: add schema in `schema.ts`, migration in `db-config.ts`

### New Frontend Hook

1. Create `packages/lib/src/core/[domain]/hooks/use-[name].ts`
2. Define query keys in the same file
3. Export from `packages/lib/src/core/[domain]/index.ts`
4. Import as `@workspace/lib/[domain]`

### New SSE Events for a Domain
1. Define event types in `packages/lib/src/types/sse.ts`
2. Create event builders in `apps/api/src/lib/[domain]/sse-events.ts`
3. Emit from business logic via `this.home.notify(buildEvent(...))`
4. Create handler in `packages/lib/src/core/[domain]/sse-handlers.ts`
5. Register handler in `packages/lib/src/core/sse/hooks/use-sse.ts`

### New Frontend App
1. Create `apps/{appname}/` with `main.tsx`, `routes/__root.tsx`, `vite.config.ts`
2. Use `createAppConfig(appName)` from `vite.shared.config.ts`
3. Wrap in `<EigenApp>` → `<RouterProvider>`
4. Root route uses `<AppShell>` with optional sidebar
5. Auth routes under `_auth.tsx` layout
6. Add `serve:{appname}` script to root `package.json`
7. Add port to `vite.shared.config.ts` `APP_PORTS`
8. Read docs/LAYOUT*.md documentation

### New Shared Type
1. Define in `packages/lib/src/types/[domain].ts`
2. Export from `packages/lib/src/types/index.ts`
3. Use `type` keyword (not `interface`)
4. **Always discuss with the user first**

---

## Important Quirks

- **Auth DB schema**: better-auth does NOT auto-create tables. Setup flow (`/setup/complete`) creates them via `initializeDatabaseSchema()`. Tests use the same endpoint.
- **Collab documents** are folders (not files) in metadata.db containing a `data.db` child. The `data.db` pathId is the storage key.
- **ACL inheritance**: Purely additive (Google Drive model). Child can only *add* permissions, never revoke inherited ones. Supports team-based ACL. Redundant entries auto-stripped. See `docs/ACL.md` and `docs/ORGANISATIONS-AND-TEAMS.md`.
- **Owner IDs**: User IDs are raw UUIDs (no prefix). Team IDs are `team_{uuid}`. Parsed via `parseOwnerId()` from `packages/lib/src/types/owner.ts`.
- **Home singleton timeout**: 5 minutes of inactivity → auto-destruct.
- **Test concurrency**: Must be 1 due to shared SQLite connections.
- **Maildir path sanitization**: `sanitizeDirName()` lowercases and dot-prefixes mailbox names (e.g., `Sent` → `.sent`). INBOX is `Maildir/.` which resolves to `Maildir/`.
- **Thumbnails**: Generated on upload for images only (sharp → WebP in `thumbs/`). Video/PDF thumbnails not supported.
- **`config.json`**: Simple JSON file tracking setup completion. Separate from `config.db`.

---

## Documentation Reference

For deep-dives, see `docs/`:
- **CONTRIBUTING.md** - Code style, architecture patterns, conventions
- **DATABASE.md** - SQLite architecture, ManagedDatabase, migrations
- **STORAGE.md** - Storage backends, mount system, user data layout
- **SSE.md** - Real-time events (backend emission, frontend handling)
- **LAYOUT.md** - Responsive layout system (AppShell, ColumnLayout, Column)
- **TESTING.md** - Test architecture, data isolation, test users
- **DOCKER.md** - Docker deployment, build process, nginx config
- **LAYOUT-SHARED-COMPONENTS.md** - UI components inventory
- **LAYOUT-UI-LIST.md** - List hooks (selection, keyboard nav, drag-and-drop)
- **ACL.md** - Access control inheritance model
- **ORGANISATIONS-AND-TEAMS.md** - Organization setup, teams, team drives, team ACL

Also see **LLM.md** (root) - Single source of truth for project context.
