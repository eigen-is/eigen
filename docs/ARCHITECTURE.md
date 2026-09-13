# Architecture

> **TLDR**: Where every backend and frontend concept lives, the four Drive layers, the package boundaries (`lib` never imports `ui` or `sheet`; the backend imports lib only through React-free subpaths) and the pitfalls that have bitten more than one domain. [AGENTS.md](../AGENTS.md) holds the rules an agent needs before its first edit; this file holds the map and the reasoning behind those rules.

## Backend

| Concept               | Location                                     | Pattern                                                                                                    |
|-----------------------|----------------------------------------------|------------------------------------------------------------------------------------------------------------|
| **Home singleton**    | `apps/api/src/lib/home/home.ts`              | Per-user instance managing DB connections + domain services. Subclasses: `UserHome`, `TeamHome`, `OrgHome` |
| **Domain classes**    | `apps/api/src/lib/[domain]/[domain].ts`      | Business logic (Drive, Mail, Contacts, Calendar, ChatRoom)                                                 |
| **Routes**            | `apps/api/src/routes/[domain].ts`            | Thin Elysia routers, `{auth: true}` for protected                                                          |
| **DB schemas**        | `apps/api/src/lib/[domain]/schema.ts`        | Drizzle ORM schemas                                                                                        |
| **DB config**         | `apps/api/src/lib/[domain]/db-config.ts`     | `DatabaseConfig` with versioned migrations                                                                 |
| **ManagedDatabase**   | `apps/api/src/lib/core/managed-database.ts`  | WAL mode, versioning, auto-sync, dirty tracking                                                            |
| **Collab storage**    | `apps/api/src/lib/collab/`                   | One `CollabDocument` per open doc; Yjs updates + snapshots as zstd BLOBs in `data.db`. See [COLLAB.md](COLLAB.md) |
| **Storage backends**  | `apps/api/src/lib/storage/`                  | Two classes — `LocalStorage` (serves both `local` + `local-key` modes) and `S3Storage`                     |
| **Errors**            | `apps/api/src/lib/core/errors.ts`            | `throw new ApiError(status, message)`                                                                      |
| **SSE emission**      | `apps/api/src/lib/[domain]/sse-events.ts`    | `home.broadcast(buildEvent(...))`                                                                          |
| **Notifications**     | `apps/api/src/lib/notification-center/`      | `home.notifications.persist({...})` — per-user SQLite, broadcasts SSE. See [NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md) + [ACTIVITY-ROWS.md](ACTIVITY-ROWS.md) |
| **Auth**              | `apps/api/src/lib/auth/auth.ts`              | better-auth with org/team/2FA/API key plugins. `users3.db` has no migration system: a new auth column goes in `auth-schema.ts`, the `setup.ts` DDL and `ensureAuthSchemaColumns` (boot-time ALTER for existing installs) together — better-auth refuses to start on a Drizzle schema that misses a plugin field |
| **Protocol auth**     | `apps/api/src/lib/auth/protocol-auth.ts`     | `verifyProtocolAuth()` — shared IMAP/CalDAV/CardDAV/WebDAV auth (app password → primary password fallback)         |
| **WebDAV**            | `apps/api/src/lib/webdav/`                   | RFC 4918 Class 1+2 server at `/webdav/:ownerId/:mountId/*`; mirrors the CalDAV layer. See [WEBDAV.md](WEBDAV.md) |
| **CardDAV**           | `apps/api/src/lib/carddav/`                  | RFC 6352 at `/dav/addressbooks/:ownerId/…`; the vCards are the source of truth, `contacts.db` an index that also OWNS sync/label metadata. The vCard parser/serializer/transcoder is shared FE+BE in `packages/lib/src/vcard/` (`@workspace/lib/vcard`), and `apps/api/src/lib/contacts/transfer.ts` replays a whole `.vcf` file through the same PUT seam. See [CONTACTS.md](CONTACTS.md) |
| **Server config**     | `apps/api/src/lib/config/server-config.ts`   | Identity + secrets written once at setup (`domain`, `orgName`, `orgId`, `secret`, `setupCompleted`)        |
| **Server settings**   | `apps/api/src/lib/config/server-settings.ts` | Runtime-adjustable quotas, storage defaults, onboarding, guests. See [SERVER-SETTINGS.md](SERVER-SETTINGS.md) |
| **Quota resolution**  | `apps/api/src/lib/config/quota.ts`           | `resolveUserQuotas()` — server default + team overrides (most permissive wins)                             |
| **Quota enforcement** | `apps/api/src/lib/config/enforcement.ts`     | `getUploadMaxSize`, `enforceAvatarUpload`                                                                  |
| **Mailer**            | `apps/api/src/lib/core/mailer.ts`            | `sendMail(OutboundMail)` — sendmail transport, skips in dev + demo mode, supports replyTo/attachments/envelope/messageId/threading (inReplyTo + references) |
| **Environment**       | `apps/api/src/lib/config/env.ts`             | `isProduction()` (`PRODUCTION=1`/`NODE_ENV=production`); `isDemo()` (`EIGEN_DEMO=1`) — demo-instance deployment shape, see [DEMO_MODE.md](DEMO_MODE.md) |
| **Singleton factory** | `apps/api/src/utils/singleton.ts`            | `createAsyncSingleton()` for Home/DB instances                                                             |
| **Home relay**        | `apps/api/src/lib/home/home-relay.ts`        | Cross-home messaging via `sendToHome()`; reads via `pull*()`. See [SCALABILITY.md](SCALABILITY.md)    |
| **Scheduler**         | `apps/api/src/lib/scheduler/`                | `scheduleInterval(name, ms, fn)` for in-process periodic jobs; register in `jobs.ts`                       |
| **Document transforms** | `apps/api/src/lib/document/transform/`     | Bounded runner + one-shot Bun Workers for every CPU-heavy transform (previews, exports, imports, search); never a main-thread fallback. See [DOCUMENT-TRANSFORMS.md](DOCUMENT-TRANSFORMS.md) |
| **Upload pipeline**   | `apps/api/src/lib/mount/upload-queue.ts` + `lib/sync/` | Write-behind S3 uploads: stage + enqueue, a per-mount `UploadQueue` drains with retry/backoff; `local`/`local-key` stay synchronous. See [SYNC.md](SYNC.md) |
| **Versioning**        | `apps/api/src/lib/versioning/`               | Opt-in file-level snapshots in `<container>/versions/`; snapshot/restore mechanics + locking in [STORAGE.md § File Versioning](STORAGE.md#file-versioning) |
| **Backup / restore**  | `apps/api/src/lib/backup/` + `apps/api/src/routes/backup.ts` | Per-home backup + restore, admin-only under `/admin/backup/*`; one primitive (`snapshotHome`), and a restore deletes nothing. See [BACKUP.md](BACKUP.md) |
| **Copy / move**       | `apps/api/src/lib/drive/copy-across.ts`      | Move stays in-mount; copy picks the same-storage fast path or the cross-mount bridge. See [STORAGE.md § Copy / Move](STORAGE.md#copy--move) |
| **File history + watch** | `apps/api/src/lib/drive/history.ts`       | `FileHistory` on `Mount` (`file_events` + `path_watchers`) — typed events, read-gated watcher notifications, `drive:file-history-updated` SSE. See [FILE-HISTORY.md](FILE-HISTORY.md) |

### Drive Architecture

The Drive system has four layers. When adding new features, all four need changes:

```
Route (thin handler)  →  SharedDrive (ACL wrapper)  →  Drive (business logic)  →  Mount (storage + DB)
```

- **Mount** (`apps/api/src/lib/mount/mount.ts`): Core storage operations on a single mount's `metadata.db`. Handles file CRUD, path resolution, storage key building. Three storage backends: `local` (hierarchical paths), `local-key` (flat UUID keys), `s3` (S3-compatible). Trash, copy, search-index and the managed document-DB lifecycle live in sibling `mount/*.ts` modules (plain functions over the mount — `Mount` stays the facade); versioning mechanics in `versioning/snapshot.ts`
- **Drive** (`apps/api/src/lib/drive/drive.ts`): High-level API over multiple mounts. Handles ACL propagation, collab document lifecycle, SSE emission, sharing
- **SharedDrive** (`apps/api/src/lib/drive/sharedDrive.ts`): ACL-enforcing wrapper, composition over inheritance — does NOT extend Drive. `getSharedDrive()` returns `Drive | SharedDrive`; routes can only call methods present on both, so adding a public method to `Drive` without a matching `SharedDrive` wrapper is a TS error at the callsite. Own-drive routes get raw Drive (no ACL overhead); cross-owner routes get SharedDrive (ACL-checked). **Escape hatch**: a small number of routes (`/shared/by-me`, `/shared/with-me`) need owner-only Drive methods that have no meaningful ACL semantics. They `requireSelf(params.ownerId, user.id)` first and then call `getDrive(user)` to obtain raw Drive — bypassing the SharedDrive surface. The drive.ts class doc explains which methods are non-route-callable (annotated `// Called by:` — invoked by peer lib code like collab/chat/home-relay, not from routes). If you add a route that needs one of those, add a SharedDrive wrapper first, don't reach for the escape hatch
- **Routes** (`apps/api/src/routes/drive.ts`): Thin Elysia handlers that delegate via `getSharedDrive`

## Frontend

| Concept            | Location                                              | Pattern                                                    |
|--------------------|-------------------------------------------------------|------------------------------------------------------------|
| **API client**     | `packages/lib/src/core/api.ts`                        | Eden Treaty — type-safe from Elysia definitions            |
| **Data hooks**     | `packages/lib/src/core/[domain]/hooks/`               | TanStack Query with hierarchical query keys                |
| **SSE handlers**   | `packages/lib/src/core/[domain]/sse-handlers.ts`      | Invalidate query cache on events                           |
| **Shared types**   | `packages/lib/src/types/[domain].ts`                  | Used by both FE and BE                                     |
| **Validation**     | `packages/lib/src/validation/`                        | Shared FE/BE validation                                    |
| **Colors**         | `packages/lib/src/constants/colors.ts`                | `EIGEN_COLORS`, `EIGEN_ACCENT_COLORS`                      |
| **Yjs utilities**  | `packages/lib/src/core/collab/yjs-utils.ts`           | `restoreYjsDoc` (live-state replacement on version restore, [COLLAB.md](COLLAB.md)) + stickies' typed root/id-array accessors ([CANVAS.md](CANVAS.md)) |
| **Collab lifecycle** | `packages/lib/src/core/collab/hooks/use-collab-doc.ts` | `useCollabDoc` owns the Y.Doc + provider + UndoManager for every collab editor — **gate the loading screen on `loaded`, never `synced`**. See [CANVAS.md](CANVAS.md) |
| **Canvas engine** | `packages/lib/src/vector/` + `packages/ui/src/components/vector/` | One engine for free-canvas documents: React-free element model + kind registry in lib, `CanvasEditor` the host in ui. See [CANVAS.md](CANVAS.md) |
| **Canvas editors** | `apps/vector/` + `apps/slides/` | One engine, two apps: `CanvasEditor` on the infinite canvas (drawings) and in frame mode (a deck of slides). See [CANVAS.md](CANVAS.md) + [SLIDES.md](SLIDES.md) |
| **App shell**      | `packages/ui/src/components/layout/app/app-shell.tsx` | Wraps every app (Topbar + sidebar + content)               |
| **Provider stack** | `packages/ui/src/components/layout/app/eigen-app.tsx` | Auth → SSE → Upload → Preview → CommandPalette → Toaster   |
| **Layout**         | `packages/ui/src/components/layout/app/column-layout.tsx` | `ColumnLayout` + `Column` with responsive mobile switching |
| **Routing**        | `apps/[name]/src/routes/`                             | TanStack Router, file-based. `_auth.tsx` guards            |
| **Command palette**| `packages/lib/src/core/command-palette/`              | `Mod+K` dialog; reach it through `useOptionalCommandPalette` so apps without the provider don't crash. See [the proposal](proposals/PROPOSAL_COMMAND_PALETTE.md) |
| **In-document search** | `packages/lib/src/doc-search/` + `packages/ui/src/components/search/` | ⌘F find bar (+ replace) in every eigendoc editor, on one shared 3-method `DocSearchController` contract. See [IN_DOCUMENT_SEARCH.md](IN_DOCUMENT_SEARCH.md) |
| **Search**         | `apps/api/src/lib/mount/search-index.ts` + `packages/lib/src/core/search/` | Per-scope inline FTS5 — mail + drive name/content indexes; FE `useSearchQuery` hook. See [SEARCH.md](SEARCH.md) |
| **Contact suggestions** | `packages/lib/src/core/contacts/hooks/use-contact-suggestions.ts` | Single canonical hook merging personal contacts + team members, used by mail compose, calendar share/attendees, drive share, chat @-mention, and the command palette. `ContactSuggestion` shape in `packages/lib/src/types/contact.ts` |
| **New-chat wizard** | `packages/ui/src/components/chat/chat-create-wizard.tsx` | `ChatCreateWizard` — two-step "New chat" dialog with open-don't-duplicate matching. See [CHAT.md](CHAT.md#new-chat-wizard) |
| **Mail shortcuts** | `apps/mail/src/components/mail/hooks/use-mail-shortcuts.ts` | Opt-in Gmail-style keyboard shortcuts; `?` in Mail opens the cheat-sheet. See [MAIL.md](MAIL.md) |
| **Mail list + pagination** | `packages/lib/src/core/mail/hooks/use-emails.ts` | Keyset-paginated `useInfiniteQuery` with optimistic per-id cache patches. See [MAIL.md](MAIL.md) |
| **Eigen-doc icons**| `packages/lib/src/core/eigendoc-icons.ts`             | `EIGEN_DOC_ICONS` — the single source for the icon per eigen-doc type. Kept out of `types/drive.ts` so that file stays type-only on the BE side |
| **Drive copy/move**| `packages/lib/src/core/drive/hooks/writes.ts`      | Right-click **Move to… / Copy to… / Duplicate** via `useMovePath`/`useCopyPath`/`useDuplicatePath` + the reused `DriveLocationPicker`. See [STORAGE.md § Copy / Move](STORAGE.md#copy--move) |

## Package boundaries

The rules in [AGENTS.md § Critical Rules](../AGENTS.md#critical-rules) are the short form; this is the reasoning.

### Dependency direction

**Package dependency direction is one-way: `sheet → lib` and `ui → lib`, never the reverse — `lib` imports neither.** `packages/lib` is shared FE+BE; `packages/sheet` declares React peer dependencies, and both `packages/sheet` and `packages/ui` are React/DOM-coupled modules. If lib imported either, the BE would transitively pull React in at module-eval time (a biome rule enforces it). Shared sheet types (`Cell`, `Sheet`, `Op`, `CellMatrix`, `Range`, `SingleRange`, `ConditionalFormatRule`, …) live in `packages/lib/src/sheets/types.ts`; the sheet package's `engine/types.ts` and `state/types.ts` re-export them. Sheet utilities that need to be importable by both FE and BE (e.g. `opToPatchOnSheets`) live in `packages/lib/src/sheets/`

### Backend imports of lib

**The backend imports lib through React-free subpaths, never `core/` domain barrels** — every `@workspace/lib/<domain>` barrel re-exports React hooks, so importing one from `apps/api` pulls React in at module-eval. BE-safe by design: `types/*`, `constants`(`/*`), `validation`, `sheets`(`/*`), `vcard`(`/*`), `vector`(`/*`), `background`, `docs/eigendoc`, and the React-free leaf modules (`content-line`, `date`, `format`, `html`). For a React-free module that lives *inside* a domain dir, lib's exports map carves out an explicit subpath — `calendar/calendar-utils`, `chat/emotes`, `chat/built-in-emotes`, `chat/format-preview`, `collab/yjs-utils`, `mail/addresses` — import those, not the barrel. Need a new one? Add the exports entry next to these and keep the module React-free; lib has no wildcard exports into `core/`, so an uncarved deep import simply won't resolve. `download` is the counter-example: a leaf subpath too, but it needs `document` and `URL.createObjectURL`, so it is FE-only and never BE-safe. The resolver itself (what each `@workspace/*` specifier gives you) is the table in [CODE-STANDARDS.md § Imports](CODE-STANDARDS.md#imports).

### One source of truth per fact

**One source of truth per fact** — a set, map, schema, or constant that answers a question (which extensions are text-editable? which MIME is a spreadsheet? what's a valid S3 config?) lives in exactly one module. Import it; never re-list its members inline "just for here." Two lists of one fact drift (we shipped three disagreeing "is this text?" registries). Need a subset? Derive it from the canonical one

### A primitive is shared only when its barrel exports it

**A primitive isn't "shared" until its barrel exports it** — reusable values go through the package's public entry (`@workspace/ui`, `@workspace/lib/<domain>`), reusable types through `@workspace/lib/types/<domain>`. An unexported primitive is invisible to the next author, who rebuilds it. The inverse is also a smell: deep-importing past a barrel (`@workspace/lib/core/…`) usually means the thing you reached for should have been exported

### Third copy → shared wrapper

**Third copy → shared wrapper** — the "if two+ apps need it, it goes in `packages/`" rule applies to *scaffolds*, not just components: route guards, `_auth.tsx` files, editor shells, loading/empty/error treatments. When you're about to paste one into a *third* app, stop and extract a single guarded wrapper into `packages/ui` — the way the 11 per-app `main.tsx` bootstraps and `_auth.tsx` guards became `createEigenAppRouter`/`createAuthRouteOptions`, and the app sidebars came to share one `SidebarSection` loading/error/empty treatment

## Pitfalls

These patterns have caused bugs across multiple domains. The gated ones (MIME strings, `:ownerId`, hover-without-touch) are enforced by `scripts/check-standards.ts`; see [CODE-EXAMPLES.md § Standards Gates](CODE-EXAMPLES.md#standards-gates).

- **Query keys must include `ownerId`** for any owner-scoped data. Without it, switching between personal and team contexts serves stale cached data from the wrong owner
- **Add a `SharedDrive` wrapper for every route-callable `Drive` method**, with the appropriate permission check (`withReadPermission`, `withWritePermission`, or owner check) — see [§ Drive Architecture](#drive-architecture)
- **MIME type strings** — the rule is one line in [AGENTS.md § Pitfalls](../AGENTS.md#pitfalls) (gated), and the table it matches is [AGENTS.md § Eigen File Types](../AGENTS.md#eigen-file-types)
- **`validateSearch` in shared routes must extract all URL params the route uses** — missing params (like `uid`) silently break detail panes for shared items
- **Never mutate TanStack Query cache directly** — use `queryClient.setQueryData()` or `invalidateQueries()`, not direct object mutation on cached data
- **No `"use client"` directives** — this is a Vite project, not Next.js. The directive is a no-op
- **Every authenticated route must include `:ownerId` as the second path segment** — `ownerId` identifies the Home that owns the resource. For personal data it equals `user.id`; for team data it's `team_{teamId}`. This consistent prefix enables future load-balancer sharding by ownerId (all requests for one Home on the same server). Routes must validate that the caller has access to the specified ownerId (owns it or is a team member). Gated, carve-outs included: server-wide endpoints that don't operate on a Home (setup, server-wide admin config, public surfaces, admin backup) must NOT carry `:ownerId` — they're protected by `requireAdmin(user.id)` or their own gate, not by Home ownership. The exempt list lives in `OWNER_ID_EXEMPT` in `scripts/check-standards.ts`
- **Never call `getHome()` for another user's data** — all cross-home interactions (where one user's action touches another user's Home) must go through the relay in `home-relay.ts`: `sendToHome()` for push, `pull*()` for reads. `getHome()` is fine for the current request's own home. This is the sharding seam — only `home-relay.ts` changes when homes move to different servers. See [SCALABILITY.md](SCALABILITY.md)
- **Use `ColumnLayout` + `Column` with the `toolbar` prop for page layout** — don't put the toolbar inside the page content. See [LAYOUT.md § Page Layout Pattern](LAYOUT.md#page-layout-pattern)
