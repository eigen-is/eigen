# AGENTS.md — Eigen Project Context

Eigen is a self-hosted Google Workspace alternative. Monorepo with integrated apps sharing a single API server, UI
library, and business logic layer.

Layout, stack, and scripts are derivable — read `package.json` (scripts + workspaces) and `ls apps packages`.
Two things that aren't written down anywhere else: the API serves every app from port 8000, and
`packages/sheet` is a fork of fortune-sheet/luckysheet.

## Critical Rules

- **No AI co-author trailers in commits** — never add `Co-authored-by: Claude/Copilot/...` lines to commit
  messages, even if your tooling defaults to it
- **Read [CODE-STANDARDS.md](docs/CODE-STANDARDS.md) before writing code** — defines typing rules, code style,
  common LLM mistakes with BAD/GOOD examples, and the **self-review checklist**. Must be followed before declaring
  any task complete
- **Read existing code before writing new code** — read 2-3 existing files in the same directory. Match their style,
  structure, naming, and patterns exactly. New code must look like it was always there
- **Search [SHARED-PRIMITIVES.md](docs/SHARED-PRIMITIVES.md) before building a shared hook, component, type, or
  util** — the generated index of everything `packages/ui` + `packages/lib` export. Import what already exists;
  if it's missing, export it from the package barrel so it gets catalogued. `bun run primitives` regenerates it
- **Read relevant docs before planning or coding** — check `docs/` for architecture docs on the domain you're
  touching (e.g., `docs/COMMENTS.md` before adding comment features, `docs/EXPORT.md` before changing export).
  Don't assume you know the conventions — verify them
- **Always run `bun run check`** after changes — lint, typecheck, the `getHome()` import guard, the shared-primitives
  index check, and every workspace's tests. When multiple agents run in parallel, only the main agent should run
  check — concurrent runs cause deadlocks
- **Code goes in the right layer** — hooks/mutations in `packages/lib/src/core/[domain]/hooks/`, shared types in
  `packages/lib/src/types/`, shared UI in `packages/ui/`, app-specific code in `apps/`. Rule of thumb: if two or
  more apps need it, it belongs in `packages/`. Never put `useQuery`, `useMutation`, error toasts, or `try/catch` +
  `toast.error()` in app components — all error handling lives in hooks using `onMutationError`.
  See [NOTIFICATIONS.md](docs/NOTIFICATIONS.md)
- **Package dependency direction is one-way: `sheet → lib` and `ui → lib`, never the reverse — `lib`
  imports neither.** `packages/lib` is shared FE+BE; `packages/sheet` declares React peer dependencies, and
  both `packages/sheet` and `packages/ui` are React/DOM-coupled modules. If lib imported either, the BE would transitively pull React in
  at module-eval time (a biome rule enforces it). Shared sheet types (`Cell`, `Sheet`, `Op`,
  `CellMatrix`, `Range`, `SingleRange`, `ConditionalFormatRule`, …) live in `packages/lib/src/sheets/types.ts`;
  the sheet package's `engine/types.ts` and `state/types.ts` re-export them. Sheet utilities that need to be importable
  by both FE and BE (e.g. `opToPatchOnSheets`) live in `packages/lib/src/sheets/`
- **The backend imports lib through React-free subpaths, never `core/` domain barrels** — every
  `@workspace/lib/<domain>` barrel re-exports React hooks, so importing one from `apps/api` pulls React in at
  module-eval. BE-safe by design: `types/*`, `constants`(`/*`), `validation`, `sheets`(`/*`), `slides`,
  `docs/eigendoc`, and the React-free leaf modules (`date`, `format`, `html`). For a React-free
  module that lives *inside* a domain dir, lib's exports map carves out an explicit subpath —
  `calendar/calendar-utils`, `chat/emotes`, `chat/built-in-emotes`, `chat/format-preview`, `collab/yjs-utils` —
  import those, not the barrel. Need a new one? Add the exports entry next to these and keep the module
  React-free; lib has no wildcard exports into `core/`, so an uncarved deep import simply won't resolve
- **Don't break the type chain** — types flow from Elysia route handlers → Eden Treaty → hooks → components
  automatically. No `as any`, no `as Type` casts. Fix types at the source (add return type annotations to backend
  handlers using shared types from `packages/lib/src/types/`). See CODE-STANDARDS.md § Typing
- **Think about every `await`** — a bare async call returns a truthy Promise (dangerous in conditionals: `if
  (!asyncFn())` is always false). Fire-and-forget must have `.catch()`. Skip `await` when blocking would hurt
  response time and failure is acceptable
- **Sanitize user-provided paths** — validate against `..`, `/`, and control characters before filesystem or
  header use. Never interpolate raw user input into HTTP headers
- **One source of truth per fact** — a set, map, schema, or constant that answers a question (which
  extensions are text-editable? which MIME is a spreadsheet? what's a valid S3 config?) lives in exactly
  one module. Import it; never re-list its members inline "just for here." Two lists of one fact drift
  (we shipped three disagreeing "is this text?" registries). Need a subset? Derive it from the canonical one
- **A primitive isn't "shared" until its barrel exports it** — reusable values go through the package's
  public entry (`@workspace/ui`, `@workspace/lib/<domain>`), reusable types through
  `@workspace/lib/types/<domain>`. An unexported primitive is invisible to the next author, who rebuilds it.
  The inverse is also a smell: deep-importing past a barrel (`@workspace/lib/core/…`) usually means the
  thing you reached for should have been exported
- **Fix broken windows** — fix pre-existing issues if the fix is straightforward
- **Keep docs up to date** — update `docs/` and this file when changes affect architecture
- **No hard line-wrapping in Markdown prose** — when writing `.md` content (docs, blog posts, proposals), keep each paragraph on one line; never insert manual line breaks to satisfy a maximum line length. Editors soft-wrap, and rendered HTML is unaffected either way

## Working Method (multi-step changes)

How feature work runs here — evidence-first specs, own branch per unit, TDD, subagent delegation,
independent review, real-world verification — plus the Review Standard every reviewer is held to:
[WORKING-METHOD.md](docs/WORKING-METHOD.md). Read it when you are orchestrating a multi-step change
or reviewing one; an implementer working on a single file doesn't need it.

## Architecture Patterns

### Backend

| Concept               | Location                                     | Pattern                                                                                                    |
|-----------------------|----------------------------------------------|------------------------------------------------------------------------------------------------------------|
| **Home singleton**    | `apps/api/src/lib/home/home.ts`              | Per-user instance managing DB connections + domain services. Subclasses: `UserHome`, `TeamHome`, `OrgHome` |
| **Domain classes**    | `apps/api/src/lib/[domain]/[domain].ts`      | Business logic (Drive, Mail, Contacts, Calendar, ChatRoom)                                                 |
| **Routes**            | `apps/api/src/routes/[domain].ts`            | Thin Elysia routers, `{auth: true}` for protected                                                          |
| **DB schemas**        | `apps/api/src/lib/[domain]/schema.ts`        | Drizzle ORM schemas                                                                                        |
| **DB config**         | `apps/api/src/lib/[domain]/db-config.ts`     | `DatabaseConfig` with versioned migrations                                                                 |
| **ManagedDatabase**   | `apps/api/src/lib/core/managed-database.ts`  | WAL mode, versioning, auto-sync, dirty tracking                                                            |
| **Collab storage**    | `apps/api/src/lib/collab/`                   | Yjs updates/snapshots in `data.db` BLOBs; zstd-compressed at the storage seam (`blob-codec.ts`), BC via zstd magic-byte sniff; live WS sync unaffected. The WS route sends a loading heartbeat (`loading-heartbeat.ts`) until sync-step-1 so a slow cold load never trips y-websocket's 30s silence timeout, and docs linger 60s after the last unsubscribe (`CollabDocument.scheduleClose`) so reconnects reattach instead of re-paying the load |
| **Storage backends**  | `apps/api/src/lib/storage/`                  | Two classes — `LocalStorage` (serves both `local` + `local-key` modes) and `S3Storage`                     |
| **Errors**            | `apps/api/src/lib/core/errors.ts`            | `throw new ApiError(status, message)`                                                                      |
| **SSE emission**      | `apps/api/src/lib/[domain]/sse-events.ts`    | `home.broadcast(buildEvent(...))`                                                                          |
| **Notifications**     | `apps/api/src/lib/notification-center/`      | `home.notifications.persist({...})` — per-user SQLite, broadcasts SSE; typed `details` + `coalesce`. See [NOTIFICATION-CENTER.md](docs/NOTIFICATION-CENTER.md) + [ACTIVITY-ROWS.md](docs/ACTIVITY-ROWS.md) |
| **Auth**              | `apps/api/src/lib/auth/auth.ts`              | better-auth with org/team/2FA/API key plugins                                                              |
| **Protocol auth**     | `apps/api/src/lib/auth/protocol-auth.ts`     | `verifyProtocolAuth()` — shared IMAP/CalDAV/WebDAV auth (app password → primary password fallback)         |
| **WebDAV**            | `apps/api/src/lib/webdav/`                   | RFC 4918 Class 1+2 server at `/webdav/:ownerId/:mountId/*`; mirrors CalDAV layer                           |
| **Server config**     | `apps/api/src/lib/config/server-config.ts`   | Identity + secrets written once at setup (`domain`, `orgName`, `orgId`, `secret`, `setupCompleted`)        |
| **Server settings**   | `apps/api/src/lib/config/server-settings.ts` | Runtime-adjustable quotas, storage default (`defaults.mount.{storageType,s3Config}`), onboarding, guests   |
| **Quota resolution**  | `apps/api/src/lib/config/quota.ts`           | `resolveUserQuotas()` — server default + team overrides (most permissive wins)                             |
| **Quota enforcement** | `apps/api/src/lib/config/enforcement.ts`     | `getUploadMaxSize`, `enforceAvatarUpload`                                                                  |
| **Mailer**            | `apps/api/src/lib/core/mailer.ts`            | `sendMail(OutboundMail)` — sendmail transport, skips in dev + demo mode, supports replyTo/attachments/envelope/messageId/threading (inReplyTo + references) |
| **Environment**       | `apps/api/src/lib/config/env.ts`             | `isProduction()` (`PRODUCTION=1`/`NODE_ENV=production`); `isDemo()` (`EIGEN_DEMO=1`) — demo-instance deployment shape, see [DEMO_MODE.md](docs/DEMO_MODE.md) |
| **Singleton factory** | `apps/api/src/utils/singleton.ts`            | `createAsyncSingleton()` for Home/DB instances                                                             |
| **Home relay**        | `apps/api/src/lib/home/home-relay.ts`        | Cross-home messaging via `sendToHome()`; reads via `pull*()`. See [SCALABILITY.md](docs/SCALABILITY.md)    |
| **Scheduler**         | `apps/api/src/lib/scheduler/`                | `scheduleInterval(name, ms, fn)` for in-process periodic jobs; register in `jobs.ts`                       |
| **Document transforms** | `apps/api/src/lib/document/transform/`     | Bounded runner + one-shot Bun Workers for CPU-heavy document transforms (every eigensheets/eigendoc/eigenslides preview, every HTML/XLSX/PDF/DOCX export, the xlsx + docx import/convert, and background search extraction). One main-thread seam (`run-transform.ts`) over one per-kind limits table (`TRANSFORM_LIMITS`: kill deadline + admission cost), typed closed protocol, never a main-thread fallback; media prep and the import commit stay on the main thread. Same layout per type: Worker-pure modules (`export/<type>/{render,transform}.ts`, `preview/eigen<type>-render.ts`, `import/<type>/transform.ts`, `search/extract-render.ts`) behind thin main-thread entries (`export/export-document.ts`, `preview/preview-document.ts`, `import/import-document.ts`, `search/extract-text.ts`). See [DOCUMENT-TRANSFORMS.md](docs/DOCUMENT-TRANSFORMS.md) + [PREVIEWS.md](docs/PREVIEWS.md) + [EXPORT.md](docs/EXPORT.md) |
| **Upload pipeline**   | `apps/api/src/lib/mount/upload-queue.ts` + `lib/sync/` | Write-behind S3 uploads: `isRemote` mounts stage + enqueue in `metadata.db`, a per-mount `UploadQueue` drains with retry/backoff; `local`/`local-key` stay synchronous. See [SYNC.md](docs/SYNC.md) |
| **Versioning**        | `apps/api/src/lib/versioning/`               | Opt-in file-level snapshots in `<container>/versions/`; snapshot/restore mechanics + locking in [STORAGE.md § File Versioning](docs/STORAGE.md#file-versioning) |
| **Copy / move**       | `apps/api/src/lib/drive/copy-across.ts`      | Move stays in-mount; copy picks the same-storage fast path or the cross-mount bridge, containers copy safely by design. See [STORAGE.md § Copy / Move](docs/STORAGE.md#copy--move) |
| **File history + watch** | `apps/api/src/lib/drive/history.ts`       | `FileHistory` on `Mount` (`file_events` + `path_watchers`): typed events when an actor is threaded, read-gated watcher notifications via home-relay, shared `describeFileEvent` phrasing, live refresh via `drive:file-history-updated` SSE. See [FILE-HISTORY.md](docs/FILE-HISTORY.md) and [ACTIVITY-ROWS.md](docs/ACTIVITY-ROWS.md) |

#### Drive Architecture

The Drive system has four layers. When adding new features, all four need changes:

```
Route (thin handler)  →  SharedDrive (ACL wrapper)  →  Drive (business logic)  →  Mount (storage + DB)
```

- **Mount** (`apps/api/src/lib/mount/mount.ts`): Core storage operations on a single mount's `metadata.db`.
  Handles file CRUD, path resolution, storage key building. Three storage backends: `local` (hierarchical
  paths), `local-key` (flat UUID keys), `s3` (S3-compatible). Trash, copy, search-index and the managed
  document-DB lifecycle live in sibling `mount/*.ts` modules (plain functions over the mount — `Mount`
  stays the facade); versioning mechanics in `versioning/snapshot.ts`
- **Drive** (`apps/api/src/lib/drive/drive.ts`): High-level API over multiple mounts. Handles ACL
  propagation, collab document lifecycle, SSE emission, sharing
- **SharedDrive** (`apps/api/src/lib/drive/sharedDrive.ts`): ACL-enforcing wrapper, composition over
  inheritance — does NOT extend Drive. `getSharedDrive()` returns `Drive | SharedDrive`; routes can only
  call methods present on both, so adding a public method to `Drive` without a matching `SharedDrive`
  wrapper is a TS error at the callsite. Own-drive routes get raw Drive (no ACL overhead); cross-owner
  routes get SharedDrive (ACL-checked).
  **Escape hatch**: a small number of routes (`/shared/by-me`, `/shared/with-me`) need owner-only Drive
  methods that have no meaningful ACL semantics. They `requireSelf(params.ownerId, user.id)` first and
  then call `getDrive(user)` to obtain raw Drive — bypassing the SharedDrive surface. The drive.ts
  class doc explains which methods are non-route-callable (annotated `// Called by:` — invoked by peer
  lib code like collab/chat/home-relay, not from routes). If you add a route that needs one of those,
  add a SharedDrive wrapper first, don't reach for the escape hatch
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
| **Yjs utilities**  | `packages/lib/src/core/collab/yjs-utils.ts`           | `restoreYjsDoc` — server-side only (used by `CollabDocument.applySnapshotState` during version restore to replace the live Y.Doc's declared roots inside one transaction, so connected editors converge with no reload). Handles Y.Map, Y.Array, Y.Text, and Y.XmlFragment/Tiptap, with arbitrary nesting |
| **App shell**      | `packages/ui/src/components/layout/app/app-shell.tsx` | Wraps every app (Topbar + sidebar + content)               |
| **Provider stack** | `packages/ui/src/components/layout/app/eigen-app.tsx` | Auth → SSE → Upload → Preview → CommandPalette → Toaster   |
| **Layout**         | `packages/ui/src/components/layout/app/column-layout.tsx` | `ColumnLayout` + `Column` with responsive mobile switching |
| **Routing**        | `apps/[name]/src/routes/`                             | TanStack Router, file-based. `_auth.tsx` guards            |
| **Command palette**| `packages/lib/src/core/command-palette/` + `packages/ui/src/components/layout/app/command-palette/` | `Mod+K` dialog mounted by `AppShell.PaletteRunner`, gated via `useOptionalCommandPalette` so apps without the provider don't crash. See [PROPOSAL_COMMAND_PALETTE.md](docs/PROPOSAL_COMMAND_PALETTE.md); the `doc:` scope handoff is in [IN_DOCUMENT_SEARCH.md](docs/IN_DOCUMENT_SEARCH.md) |
| **In-document search** | `packages/lib/src/doc-search/` + `packages/ui/src/components/search/` + per-app controllers | ⌘F find bar (+ replace) in every eigendoc editor — one shared 3-method `DocSearchController` contract, `DocSearchProvider` session + keybinds, `?q=` deep links, phase-2 comment search. See [IN_DOCUMENT_SEARCH.md](docs/IN_DOCUMENT_SEARCH.md) |
| **Search**         | `apps/api/src/lib/mount/search-index.ts` + `apps/api/src/routes/search.ts` + `packages/lib/src/core/search/` | Per-scope inline FTS5 — mail (`MailDB.searchMail`) + drive name/content indexes with a per-mount reindex queue; FE `useSearch` hook. See [SEARCH.md](docs/SEARCH.md) |
| **Contact suggestions** | `packages/lib/src/core/contacts/hooks/use-contact-suggestions.ts` | Single canonical hook merging personal contacts + team members, used by mail compose, calendar share/attendees, drive share, chat @-mention, and the command palette. `ContactSuggestion` shape in `packages/lib/src/types/contact.ts` |
| **New-chat wizard** | `packages/lib/src/core/chat/hooks/use-chat.ts` + `packages/ui/src/components/chat/chat-create-wizard.tsx` | `ChatCreateWizard` — two-step "New chat" dialog (person + team mode) with open-don't-duplicate matching and server-side create + share. See [CHAT.md](docs/CHAT.md#new-chat-wizard) |
| **Mail shortcuts** | `apps/mail/src/components/mail/hooks/use-mail-shortcuts.ts` | Opt-in Gmail-style keyboard shortcuts; `?` in Mail opens the cheat-sheet. See [MAIL.md](docs/MAIL.md) |
| **Mail list + pagination** | `packages/lib/src/core/mail/hooks/use-emails.ts` + `apps/mail/src/components/mail/` | Keyset-paginated `useInfiniteQuery` with optimistic per-id cache patches; BE serves the DB immediately and reconciles via fire-and-forget sync. See [MAIL.md](docs/MAIL.md) |
| **Eigen-doc icons**| `packages/lib/src/core/eigendoc-icons.ts`             | `EIGEN_DOC_ICONS: Record<EigenDocType, LucideIcon>` — single source for the icon shown next to a doc/sheets/slides/stickies/chat row. Kept out of `types/drive.ts` so that file stays type-only on the BE side |
| **Drive copy/move**| `packages/lib/src/core/drive/hooks/writes.ts`      | Right-click **Move to… / Copy to… / Duplicate** via `useMovePath`/`useCopyPath`/`useDuplicatePath` + the reused `DriveLocationPicker`. See [STORAGE.md § Copy / Move](docs/STORAGE.md#copy--move) |

#### Page Layout Pattern

Every page uses `ColumnLayout` + `Column`. The toolbar is a **separate prop**, not part of the page content.
The `Column` renders the toolbar in a fixed `h-12` bar with `px-4 border-b`. This ensures consistent
toolbar height across all pages.

```tsx
<ColumnLayout mobileColumn={showDetail ? 'detail' : 'list'}>
    <Column id="list" width="flex" onBack="sidebar" toolbar={<MyToolbar />}>
        <MyContent />
    </Column>
    <Column id="detail" width="400px" onBack={handleBack} toolbar={<DetailToolbar />}>
        <DetailContent />
    </Column>
</ColumnLayout>
```

The first column passes `onBack="sidebar"` — the sentinel renders the mobile back arrow that steps
up to the sidebar column, and self-gates away when the app has no sidebar. Without it a mobile user
has no path back to navigation. Use `width="flex"` for a single full-width column. For a plain page title in the toolbar, use the shared
`ToolbarTitle` component (`@workspace/ui/components/layout/toolbar`), which applies the `.eigen-toolbar-title`
class (`text-sm font-normal text-foreground truncate` — thin, matching the breadcrumb) rather than
hand-rolling a styled span. Richer toolbars (drive's path) compose a `BreadcrumbPage` (`font-normal`), so
the two read at the same weight.

#### Hover-Only Icons Pattern

To show action icons only on row hover (like the share icon in Drive), use the Tailwind `group` +
`invisible group-hover:visible` pattern. Always add the matching `pointer-coarse:` variant so the
affordance rests visible on touch devices, which have no hover — mirror the value the mouse user sees on
hover (`group-hover:visible` → `pointer-coarse:visible`, `group-hover:opacity-80` →
`pointer-coarse:opacity-80`, `group-hover:opacity-100` → `pointer-coarse:opacity-100`):

```tsx
<TableRow className="eigen-list-item group">
    <TableCell>
        <span>Item name</span>
        <div className="invisible group-hover:visible pointer-coarse:visible ml-auto">
            <TooltipButton icon={Edit} tooltipText="Edit" className="h-7 w-7" onClick={...} />
        </div>
    </TableCell>
</TableRow>
```

Use `TooltipButton` from `packages/ui/src/components/layout/toolbar/tooltip-button.tsx` for icon buttons
with tooltips. Don't rebuild Tooltip+Button manually.

If hover icons would affect row height, use `absolute` positioning so they float over the row.

#### Key UI Components

Before building custom UI, check these exist in `packages/ui/src/components/`:

| Component       | File                        | Use for                              |
|-----------------|-----------------------------|--------------------------------------|
| `TooltipButton` | `layout/toolbar/tooltip-button.tsx` | Icon button with tooltip             |
| `DeleteDialog`  | `delete/delete-dialog.tsx`   | Destructive action confirmation      |
| `ConfirmDialog` | `confirm-dialog.tsx`         | Generic confirmation dialog          |
| `EmptyState`    | `layout/app/empty-state.tsx` | "Nothing here" message with icon     |
| `LoadingState`  | `layout/app/loading-state.tsx` | Centered spinner                     |
| `ErrorState`    | `layout/app/error-state.tsx` | Error message display                |
| `SearchBar`     | `search-bar/search-bar.tsx`  | Search input with icon               |
| `FileMenu`      | `layout/toolbar/file-menu.tsx` | File dropdown (rename, delete, etc.) |
| `RequestAccessView` | `layout/app/request-access-view.tsx` | "Request access" screen for shared resources (hides sidebar) |

Full component list: [SHARED-PRIMITIVES.md](docs/SHARED-PRIMITIVES.md) (generated, CI-gated); layout patterns in [LAYOUT.md](docs/LAYOUT.md)

### Common Pitfalls

These patterns have caused bugs across multiple domains:

- **Query keys must include `ownerId`** for any owner-scoped data. Without it, switching between personal and team
  contexts serves stale cached data from the wrong owner
- **Add a `SharedDrive` wrapper for every route-callable `Drive` method**, with the appropriate permission
  check (`withReadPermission`, `withWritePermission`, or owner check) — see Drive Architecture above
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
  validate that the caller has access to the specified ownerId (owns it or is a team member).
  **Carve-out for home-independent routes**: server-wide endpoints that don't operate on a Home — first-run setup
  (`setup.ts`), server-wide admin config (`settings.ts`, `waitlist.ts`), and unauthenticated public surfaces
  (`public.ts`) — must NOT carry `:ownerId`. They're protected by `requireAdmin(user.id)` or their own gate, not
  by Home ownership
- **Never call `getHome()` for another user's data** — all cross-home interactions (where one user's action
  touches another user's Home) must go through the relay in `home-relay.ts`: `sendToHome()` for push,
  `pull*()` for reads. `getHome()` is fine for the current request's own home. This is the sharding seam —
  only `home-relay.ts` changes when homes move to different servers. See [SCALABILITY.md](docs/SCALABILITY.md)
- **Use `ColumnLayout` + `Column` with the `toolbar` prop for page layout** — don't put the toolbar inside
  the page content. See Page Layout Pattern above
- **Third copy → shared wrapper** — the "if two+ apps need it, it goes in `packages/`" rule applies to
  *scaffolds*, not just components: route guards, `_auth.tsx` files, editor shells, loading/empty/error
  treatments. When you're about to paste one into a *third* app, stop and extract a single guarded wrapper
  into `packages/ui` — the way the 11 per-app `main.tsx` bootstraps and `_auth.tsx` guards became
  `createEigenAppRouter`/`createAuthRouteOptions`, and the app sidebars came to share one `SidebarSection`
  loading/error/empty treatment

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

The API integration tests are in `apps/api/src/test/`. `bun run test` runs every workspace's tests (api + sheet + lib + index); `bun run test:api` runs the API suite alone. A single file needs the preload and must run from `apps/api`: `cd apps/api && bun test --preload ./src/test/preload.ts --concurrency 1 ./src/test/[file].test.ts`.

**Integration tests** (`drive.test.ts`, `calendar.test.ts`, etc.) use test helpers from `setup.ts`:
- `getTestContext()` → returns `{ alice, bob, charlie }` test users with session tokens and API clients
- `authedRequest(token, path, options?)` → make authenticated HTTP request
- `driveGet/drivePost/drivePut/driveDelete` → typed drive API helpers
- `driveGetPermission` → check read/write permissions

**Unit tests** (`mount.test.ts`, `storage.test.ts`, etc.) create isolated instances with temp directories.

See [TESTING.md](docs/TESTING.md) for full patterns.
