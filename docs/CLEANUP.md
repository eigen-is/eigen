# Cleanup & Optimization — Full-Stack Audit

Comprehensive findings from deep analysis of backend, frontend, database, security, build, and
code quality. Ordered by priority within each category.

---

## Architecture Notes

### Query & Cache Model

Global `staleTime: 2 * 60 * 1000` is set on the QueryClient (`packages/ui/.../eigen-app.tsx:31-38`).
`refetchOnMount` and `refetchOnWindowFocus` are not explicitly set, so they default to `true` — any
query older than 2 minutes refetches on mount or window focus. SSE-driven `invalidateQueries()`
overrides staleTime and always triggers a refetch.

Mutations call `invalidateQueries()` in `onSuccess` for instant feedback. SSE handlers call the same
`invalidateQueries()` for all connected clients. The initiator gets a double refetch (~50-100ms apart).
TanStack Query's structural sharing prevents re-renders if data hasn't changed.

### Database-Per-User Model

Each user gets separate SQLite databases for calendar, contacts, mail, notifications, plus mount
metadata databases. For 1000 concurrent users this means 5000+ open SQLite connections. Home instances
have a 5-minute idle timeout with cleanup, but this can cause thrashing for semi-active users.

---

## P0 — Security Vulnerabilities

### ACL Modification Without Write Permission [CRITICAL]

`sharedDrive.ts` `updateACL()` only checks write permission for `getPath()`, not for the ACL update
itself. Users with read-only access can escalate privileges by modifying ACLs on shared resources.

**File:** `apps/api/src/lib/drive/sharedDrive.ts:231-246`
**Evidence:** `apps/api/src/test/drive.test.ts:1115,1149` — TODO comments document this as known.

**Fix:** Wrap entire `updateACL` call in `withWritePermission()`, not just the path fetch.

### Unauthenticated Mail Delivery [HIGH]

`/mail/deliver/:to` accepts 25 MB POST bodies with no authentication, no IP allowlist, no rate limiting.

**File:** `apps/api/src/routes/mail.ts:30-31`

**Fix:** Add IP allowlist (localhost-only) and rate limiting. There's already a TODO for this.

### No Rate Limiting [MEDIUM]

No rate limiting middleware exists anywhere. Affects auth endpoints (brute force), mail delivery (spam),
file uploads (resource exhaustion), and waitlist signup (DoS).

**Fix:** Add rate limiting middleware to Elysia. Start with auth and mail delivery endpoints.

### Fortune-Sheet Dynamic Code Execution [MEDIUM]

`packages/fortune-sheet/src/core/modules/rowcol.ts:837-842` dynamically constructs and executes code
from array values. If array contents come from user-provided spreadsheet data, code injection is possible.

**Fix:** Replace with direct array manipulation (splice, unshift) without dynamic code generation.

---

## P1 — Request Explosion (Network Tab Issues)

The network screenshots show massive request duplication on a single page load: 7+ breadcrumb fetches,
8+ size fetches, 3+ mounts/root fetches, and N+1 avatar lookups. Root causes:

### SSE Keepalive Too Slow [CRITICAL]

SSE keepalive sends every 30 seconds (`apps/api/src/routes/sse.ts:68`), but connections die at ~29s.
The network tab shows 12+ failed `events` connections, each reconnecting and triggering full cache
invalidation.

**Fix:** Reduce keepalive interval to 15 seconds. Add `proxy_send_timeout 86400;` to nginx config.

### SSE Over-Invalidation [CRITICAL]

SSE event handlers use broad-sweep invalidation that causes cascading refetches:

| Event | Invalidates | Problem |
|-------|-------------|---------|
| `MAIL_*` (any) | Mailbox LIST + home size | Individual mailbox queries are targeted, but the shared mailbox list is invalidated on every event |
| `CALENDAR_EVENT_*` | ALL events for owner | One event edit refetches hundreds of events |
| `DRIVE_ACL_UPDATED` | ALL shared-by-me + shared-with-me | One file share invalidates all sharing lists |
| `TEAM_SETTINGS_UPDATED` | `calendarKeys.all` (global!) | Team name change refetches all calendar data |
| `NOTIFICATION_CREATED` | ALL notifications | One notification refetches entire notification list |

**Files:** `packages/lib/src/core/*/sse-handlers.ts`

**Fix:** Make invalidations granular — invalidate specific items/mailboxes/calendars, not entire
query families. For team settings, only invalidate when member/permission changes affect calendar.

### Avatar N+1 Problem [HIGH]

Each `<UserAvatar>` calls `useResolvedUser()` which fires 4 queries: `useContacts()`,
`usePublicUser(emailOrId)`, `usePublicConfig()`, and `usePeopleTeams(orgId)`. Plus an SVG avatar fetch.

TanStack Query deduplicates concurrent requests with the same queryKey, so `useContacts()`,
`usePublicConfig()`, and `usePeopleTeams()` only fetch once when multiple avatars mount simultaneously.
However, `usePublicUser(emailOrId)` is unique per user — 10 unique users = 10 separate fetches.
Sequential (non-concurrent) mounts also bypass deduplication.

**Files:** `packages/lib/src/core/public/hooks/use-resolved-user.ts:14-18`,
`packages/ui/src/components/layout/user-avatar.tsx`

**Fix:** Batch user resolution — fetch all visible users in one query. The per-user
`usePublicUser()` calls are the main N+1 source; a batch endpoint would collapse them.

### Size Endpoint Over-Invalidation [HIGH]

`homeKeys.size(ownerId)` is invalidated from 12 call sites across 6 files (Drive, Calendar, Mail,
and Contacts SSE handlers and mutation callbacks). The `StorageUsage` component is mounted in every
sidebar, so each invalidation triggers a refetch.

**Files:** `packages/lib/src/core/home/hooks/use-home.ts:19`,
`packages/lib/src/core/*/sse-handlers.ts` (multiple)

**Fix:** Debounce size invalidation (e.g., 5-second window), or compute size incrementally from
mutation deltas instead of re-querying SUM.

### Breadcrumb N+1 in Drive Table [MEDIUM — FIXED]

Each item in a folder listing rendered `DriveShareSummary` → `useDriveAccess()` → `useBreadcrumb(item.id)`,
causing N breadcrumb API requests per folder view.

**Fixed:** `DriveList` now fetches the parent folder's breadcrumb once and passes it down via
`ancestorBreadcrumb` prop through `DriveTable` → `DriveShareSummary` → `useDriveAccess`. The
`useDriveAccess` hook accepts an optional `preloadedBreadcrumb` parameter that disables the
per-item `useBreadcrumb` query when provided.

---

## P1 — Backend N+1 Queries

### Breadcrumb: Recursive Parent Walk [CRITICAL]

`mount.getBreadcrumb()` walks the parent chain one query at a time. A 10-level deep folder = 10
sequential database queries.

**File:** `apps/api/src/lib/mount/mount.ts:701-711`

**Fix:** Replace with a recursive CTE that fetches the entire ancestor chain in one query:
```sql
WITH RECURSIVE ancestors AS (
  SELECT * FROM paths WHERE id = ?
  UNION ALL
  SELECT p.* FROM paths p JOIN ancestors a ON p.id = a.parentId
)
SELECT * FROM ancestors;
```

### Storage Path Resolution: Same N+1 [HIGH]

`mount.resolveStoragePath()` walks parents one-by-one to build file paths. Called on every file
upload, rename, and move.

**File:** `apps/api/src/lib/mount/mount.ts:415-429`

**Fix:** Same recursive CTE approach, or cache resolved paths.

### ACL Permission Checks: Recursive [HIGH]

`canRead()` and `canWrite()` in `acl.ts` recursively walk the parent chain. Called 3-5 times per
request (getFolderContents, createFolder, uploadFiles, movePath, updateACL).

**File:** `apps/api/src/lib/drive/acl.ts:29-31, 58-60`

**Fix:** Fetch full ancestor chain once (with CTE), check permissions on the result set.
Cache `getMemberships()` per request to avoid repeated team lookups.

### Folder Deletion: Recursive N+1 [MEDIUM]

`deleteDescendants()` recursively queries children one level at a time, then deletes individually.

**File:** `apps/api/src/lib/mount/mount.ts:464-477`

**Fix:** Use CTE to find all descendants, batch delete.

### Contacts.size(): File Stat N+1 [MEDIUM]

Lists all avatar files, then calls `storage.size()` per file.

**File:** `apps/api/src/lib/contacts/contacts.ts:109-117`

**Fix:** Store avatar sizes in the database, or use a single directory stat.

---

## P1 — Missing Database Indexes

### Contacts Schema: Zero Indexes [CRITICAL]

The contacts schema has no indexes at all. No index on `eigenId` (foreign key), `firstName`,
or `lastName`.

**File:** `apps/api/src/lib/contacts/schema.ts`

### Mount Schema: Missing Composites [HIGH]

- Missing index on `mimeType` (used in `getPathsByMimeType()` with LIKE queries)
- Missing composite index on `(parentId, name)` (used in `getChildByName()`)
- Missing composite index on `(type, parentId)` (used in folder listings)

**File:** `apps/api/src/lib/mount/db-config.ts`

### Mail Schema: Missing Composites [HIGH]

- Missing composite index on `(mailbox, isRead)` (used in unread count queries)
- Missing index on `date` (used for sorting)

**File:** `apps/api/src/lib/mail/db-config.ts`

### Calendar Count Queries [LOW]

`calendar.ts:556-557` fetches `.all().length` instead of using `COUNT(*)` — loads all rows into
memory just to count them.

---

## P2 — Frontend Rendering Performance

### List Virtualization [CRITICAL]

No virtual scrolling library is used. All lists render every item to the DOM:

- **DriveTable** (`packages/ui/.../drive-table.tsx:180-249`): All folder contents as `<TableRow>`
  with 4 inline event handlers per row (onDragOver, onDragEnter, onDragLeave, onDrop)
- **EmailList** (`apps/mail/.../email-list.tsx:110-174`): All filtered emails, plus expensive
  `toLocaleTimeString()`/`toLocaleDateString()` calls per item in the render loop
- **ChatMessageList** (`packages/ui/.../chat-message-list.tsx:246-396`): All loaded messages

500 files = 500 DOM nodes with event handlers, context menus, and drag props.

**Note:** React Compiler (`babel-plugin-react-compiler` v1.0.0) is enabled project-wide
(`vite.shared.config.ts:37-41`), which auto-memoizes components and hooks. Manual `React.memo`
and `useCallback` are not needed. The core issue is DOM node count, not re-renders.

**Fix:** Add `@tanstack/react-virtual`. Start with Drive (most likely to have hundreds of items).

### Email Date Formatting in Render Loop [MEDIUM]

`email-list.tsx:113-126` creates 2 `new Date()` objects and calls Intl formatting APIs per email
per render. For 500 emails, that's 1000 Date objects + 500 Intl calls on every re-render.

**Fix:** Memoize formatted dates, or compute once on data fetch.

---

## P2 — Build & Bundle

### Fortune-Sheet: Full Lodash Import [CRITICAL]

46 files in `packages/fortune-sheet/src/` use `import _ from "lodash"` — the full, non-tree-shakeable
bundle (~25 KB minified). Combined with `@formulajs/formulajs` and `immer`, the sheets chunk is
oversized.

**Fix:** Replace `lodash` with `lodash-es` or individual function imports across all 46 files.
Add fortune-sheet as a manual chunk in vite config. Lazy-load formula engine separately.

### Tiptap Dual Versions [LOW — INTENTIONAL]

`apps/docs` uses Tiptap v2.11.5 (full collaborative editor with Yjs, 23 extensions, custom marks).
`apps/drive` uses v3.20.2 (lightweight markdown editor, 11 extensions, no collaboration).

This is intentional: docs relies on `@tiptap/extension-collaboration` and custom extensions
(CommentMark, ResizableImage) that would need refactoring for v3. Drive was built later with v3
for its `tiptap-markdown` plugin. Both versions bundle separately into different apps, so there's
no user-facing duplication. Upgrading docs to v3 is a future option but requires significant
testing of collaboration flows and custom extension migration.

### Build Compression [MEDIUM]

No gzip/brotli pre-compression. Server compresses on-the-fly.

**Fix:** Add `vite-plugin-compression` for `.gz`/`.br` assets. Expected 60-70% transfer reduction.

### Font Lazy-Loading [MEDIUM]

`packages/ui/src/styles/fonts.css` loads 4 font families (Inter, Source Serif 4, JetBrains Mono,
Excalifont) on every page. Only Inter is needed by default.

**Fix:** Move non-essential fonts to component-specific CSS (editor toolbar, code blocks, handwriting).

### Console Statements in Production [LOW]

Fortune-sheet has 54 `console.error()` and 357 `console.warn()` calls that ship to production.

**Fix:** Add esbuild/Vite plugin to strip console calls in production builds.

### No Image Lazy Loading [LOW]

Zero uses of `loading="lazy"` found in the codebase.

**Fix:** Add `loading="lazy"` to image components, especially in lists and previews.

---

## P2 — Backend Stability

### Home Singleton Race Condition [HIGH]

`home.ts:102-111`: `touch()` extends the 5-minute idle timeout, but there's no guard against
concurrent requests calling `touch()` while `destruct()` is already in progress. A request can
receive a destroyed Home instance.

**Fix:** Add a `destructing` flag. If `touch()` is called while destructing, wait for destruction
to complete and create a new instance.

### Unimplemented `/home/:ownerId/zip` [MEDIUM]

`home.ts:198` throws `'Not implemented'`, but the route exists at `routes/home.ts:19`. This is
a runtime error waiting to happen.

**Fix:** Remove the route until implemented, or implement it.

### Thumbnail Retry [MEDIUM]

Thumbnail generation is fire-and-forget with `.catch(console.error)`. No retry, no tracking.

**Fix:** Store `thumbnailStatus` field. Retry on next access if missing.

### Recycle Bin [MEDIUM]

File deletion is permanent.

**Fix (when ready):** Add `deletedAt` column. Filter deleted items. Background job purges after 30 days.

### Missing Transactions [MEDIUM]

Multi-step operations lack transactions:

- `deleteDescendants()` — individual deletes per child
- `setContactLabels()` — delete then insert without transaction
- ACL propagation during folder deletion

**Fix:** Wrap multi-step operations in `db.transaction()`.

---

## P3 — Code Quality

### `interface` vs `type` Convention [MEDIUM]

131 instances of `interface` in app components (should be `type` per CLAUDE.md). `packages/lib`
is clean (0 violations).

**Fix:** Bulk convert with search-and-replace. Consider adding a lint rule.

### Large Monolithic Components [LOW]

| Component | Lines | Issue |
|-----------|-------|-------|
| `apps/docs/.../editor-toolbar.tsx` | 708 | Toolbar + formatting + layout |
| `apps/contacts/.../contact-edit.tsx` | 653 | Form + avatar upload + labels |
| `apps/slides/.../slide-properties-panel.tsx` | 584 | Animation + styling + text |
| `apps/slides/.../editor.tsx` | 529 | Canvas + 29 internal functions |
| `packages/ui/.../chat-message-input.tsx` | 366 | 3 suggest systems in one file |

**Fix:** Extract sub-components when touching these files.

### Non-ASCII Content-Disposition [LOW]

File download headers use `filename="..."` but not `filename*=UTF-8''...` (RFC 5987). Non-ASCII
filenames may be corrupted.

**Fix:** Add RFC 5987 `filename*` encoding for international filenames.

---

## P3 — Tooling

### Biome.js [EVALUATE]

Could replace ESLint + Prettier with a single Rust-based tool (10-100x faster).

**Pros:** Single tool, millisecond speed, production-ready (Discord, Astro), Bun-compatible.
**Cons:** Smaller rule set (~280 rules), no custom plugins.

**Recommendation:** Worth adopting if Tailwind class sorting is available.

### Bundle Analysis [EVALUATE]

No bundle visualization tool configured.

**Fix:** Add `rollup-plugin-visualizer` to identify dead code and optimize chunk splits.

---

## Summary

| Item | Priority | Effort | Category | Status |
|------|----------|--------|----------|--------|
| ACL privilege escalation fix | P0 | 1 hr | Security | DONE |
| Mail delivery localhost check | P0 | 2-3 hr | Security | DONE |
| Rate limiting (300 req/min/IP) | P0 | 3-4 hr | Security | DONE |
| Fortune-sheet dynamic code execution fix | P0 | 1-2 hr | Security | DONE |
| SSE keepalive interval (30s to 15s) | P1 | 15 min | Network | DONE |
| SSE granular invalidation | P1 | 3-4 hr | Network | DONE |
| Avatar batch resolution | P1 | 2-3 hr | Network | |
| Size endpoint debounce/cache | P1 | 1-2 hr | Network | DONE |
| Breadcrumb recursive CTE | P1 | 2-3 hr | Backend | DONE |
| Storage path CTE | P1 | 1-2 hr | Backend | DONE |
| ACL permission CTE + caching | P1 | 2-3 hr | Backend | |
| Add missing database indexes | P1 | 1-2 hr | Database | DONE |
| Calendar count queries (.all().length) | P1 | 15 min | Database | DONE |
| Breadcrumb N+1 in Drive table | P1 | 1-2 hr | Frontend | DONE |
| List virtualization (Drive, email, chat) | P2 | 2-3 days | Frontend | |
| Fortune-sheet lodash replacement | P2 | 2-4 hr | Bundle | |
| Build compression (gzip/brotli) | P2 | 30 min | Bundle | |
| Font lazy-loading | P2 | 2-4 hr | Bundle | |
| Home singleton race condition | P2 | 2 hr | Backend | |
| Missing transactions | P2 | 2-3 hr | Backend | |
| Remove /home/:ownerId/zip route | P2 | 5 min | Backend | DONE |
| Thumbnail retry | P2 | 1-2 hr | Backend | |
| Recycle bin / soft delete | P2 | 1-2 days | Backend | |
| `interface` to `type` conversion | P3 | 1-2 hr | Quality | |
| Non-ASCII Content-Disposition | P3 | 30 min | Quality | |
| Console stripping in production | P3 | 1 hr | Bundle | |
| Image lazy loading | P3 | 2-3 hr | Bundle | |
| Biome.js adoption | P3 | 1 day | Tooling | |
| Bundle analysis tooling | P3 | 1 hr | Tooling | |
