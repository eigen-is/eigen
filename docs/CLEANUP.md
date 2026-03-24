# Cleanup & Optimization Audit

Full-stack audit of the Eigen monorepo: performance, stability, bundle size, architecture.
Findings are ordered by priority within each section.

---

## 1. Backend Stability

### 1.1 No Graceful Shutdown Handler [CRITICAL]

`apps/api/src/index.ts` has no `SIGTERM`/`SIGINT` handler. On process kill (Docker stop, Ctrl+C, deploy):

- No `Home.shutdown()` is called
- Open databases are not checkpointed or closed
- WAL journal files may be left behind
- In-flight requests are dropped

**Fix:** Add signal handlers that iterate all active Homes and call `shutdown()` before exiting.

### 1.2 File Operations Are Not Atomic [HIGH]

In `apps/api/src/lib/mount/mount.ts`, file creation inserts the DB record first, then writes to storage.
If the process crashes between those steps:

- Orphaned DB entries point to non-existent files
- Quota calculations count non-existent files
- `downloadFile()` returns 404 for files the DB says exist

Same issue for delete (storage deleted before DB record removed) and recursive folder delete
(crash mid-loop leaves orphaned children).

**Fix:** Write to storage first (or a temp path), then insert DB record. For deletes, remove DB
record first, then clean up storage (orphaned storage files are harmless).

### 1.3 Fire-and-Forget Thumbnail Generation [MEDIUM]

Drive's `uploadFile` spawns thumbnail generation in a `.then()` chain with only a `.catch(console.error)`.
If it fails, there's no retry, no tracking, and the user never learns.

**Fix:** Store a `thumbnailStatus` or `thumbnailAttempts` field. Retry on next access if missing.

### 1.4 No Recycle Bin [MEDIUM]

File deletion is permanent - the DB row is deleted and storage is removed immediately.
Acceptable during dev (per CLAUDE.md: "data is throwaway"), but production needs soft delete.

**Fix (when ready):** Add `deletedAt` column to paths schema. Filter out deleted items in queries.
Background job permanently deletes after 30 days.

### 1.5 SSE Reconnection Uses Flat 5-Second Retry [LOW]

`packages/lib/src/core/sse/hooks/use-sse.ts:62` always retries after exactly 5 seconds.
Under sustained outage, every client hammers the server every 5 seconds.

**Fix:** Exponential backoff with jitter: 1s, 2s, 4s, 8s... capped at 30s.

---

## 2. Query & Cache Patterns

### 2.1 Double Cache Invalidation [HIGH]

Every mutation's `onSuccess` invalidates the same query keys that the SSE handler also invalidates.
This is the *correct* pattern (the TanStack Query maintainer recommends it: mutation gives instant
feedback to the initiator, SSE notifies all other clients). However, TanStack Query only deduplicates
if a refetch is *still in-flight*. If the first refetch completes before the SSE event arrives
(typically 10-100ms later), the second invalidation triggers a redundant refetch.

Affected domains: Drive (10+ mutations), Mail (5+), Calendar (6+), Contacts (3+), Chat (3+).

**Fix:** Set `staleTime` on SSE-backed queries so that data freshly fetched by the mutation's
invalidation is still considered fresh when the SSE event arrives:

```typescript
// In QueryClient defaults:
new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 2000, // Data stays fresh for 2 seconds after fetch
        },
    },
})
```

This eliminates double refetches without removing either invalidation path. The mutation still gives
instant feedback; SSE still notifies other clients. The only change is that a refetch that completed
<2 seconds ago won't trigger again.

### 2.2 Notification Polling Instead of SSE [HIGH]

`packages/lib/src/core/notification/hooks/use-notifications.ts:36` polls every 60 seconds
(`refetchInterval: 60_000`) despite having a working SSE handler for `notification:created`
that already invalidates the notification queries.

**Fix:** Remove `refetchInterval`. The SSE handler already handles real-time updates. If SSE
is disconnected, the reconnection + staleTime mechanism handles recovery.

### 2.3 No Global QueryClient Defaults [MEDIUM]

`packages/ui/src/components/layout/app/eigen-app.tsx:27` creates a bare `new QueryClient()`.
Every query individually configures `staleTime`, leading to inconsistency.

**Fix:**

```typescript
new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 2 * 60 * 1000,    // 2 minutes default
            retry: 1,                      // Fail faster
        },
    },
})
```

Individual queries can still override. The `Infinity` staleTime on mounts/root folder stays as-is.

### 2.4 Team Settings SSE Invalidates All Calendar Queries [MEDIUM]

`packages/lib/src/core/team/sse-handlers.ts` handles `TEAM_SETTINGS_UPDATED` by invalidating
`calendarKeys.all` - the entire calendar cache for all owners. A team name change causes every
calendar query to refetch.

**Fix:** Only invalidate the affected team's calendar queries, or split team-setting types
so that only member/permission changes trigger calendar invalidation.

---

## 3. Frontend Performance

### 3.1 No List Virtualization [CRITICAL]

No virtual scrolling library is used anywhere in the codebase. All lists render every item to
the DOM:

- **DriveTable** (`packages/ui/.../drive-table.tsx`): All folder contents as `<TableRow>`
- **EmailList** (`apps/mail/.../email-list.tsx`): All filtered emails
- **ChatMessageList** (`packages/ui/.../chat-message-list.tsx`): All loaded messages (infinite scroll loads more, but everything loaded is in the DOM)

A folder with 500 files = 500 DOM nodes with event handlers, context menus, drag props.

**Fix:** Add `@tanstack/react-virtual` for Drive table, email list, and chat messages.
Start with Drive (most likely to have hundreds of items).

### 3.2 Almost No Component Memoization [HIGH]

Only 3 files in the entire codebase use `React.memo` (2 in slides, 1 in fortune-sheet).
List item components (table rows, email items, chat messages) are not memoized, so any parent
re-render re-renders every child.

Specific hot paths:
- `DriveTable` renders 100+ `TableRow` components with inline functions per row
- `ChatMessageList` renders 100+ message blocks with complex formatting logic
- `ContactAutosuggest` re-renders suggestions on every keystroke

**Fix:** Wrap list item components in `React.memo()`. Stabilize callback props with `useCallback`.

**Note:** React Compiler (available since React 19) can automate this. Adding
`babel-plugin-react-compiler` to the Vite config would handle most cases without manual
memoization. Worth evaluating - would be high impact with near-zero code changes.

### 3.3 No Search Debouncing [HIGH]

Search inputs fire `onChange` on every keystroke with no debouncing:
- `SearchBar` (`packages/ui/.../search-bar.tsx:33-35`): Calls `onChange` directly
- `ContactAutosuggest`: Fires query on every character
- Email list search: Filters + sorts entire list per keystroke

**Fix:** Add a `useDebouncedValue` hook (simple ~10 line hook) and use it in search inputs.
200-300ms debounce is standard for search.

### 3.4 No Error Boundaries [HIGH]

Zero `ErrorBoundary` components in the codebase. A single component crash (bad data from API,
Yjs sync error, editor bug) crashes the entire app with a white screen.

**Fix:** Add error boundaries at:
1. App shell level (catch-all with "Something went wrong" + reload button)
2. Editor level (Tiptap/fortune-sheet/slides crashes don't take down the shell)
3. List level (bad item data doesn't crash the table)

### 3.5 Context Over-Subscription [MEDIUM]

- **AuthProvider** exposes `{isLoading, isAuthenticated, user, login, logout}` as one context.
  Components that only need `user.id` re-render when `isLoading` toggles.
- **LayoutContext** has 7 values (`sidebarOpen`, `isMobile`, `appName`, etc.).
  A sidebar toggle re-renders components that only care about `isMobile`.
- **UploadProvider** stores the full `uploads[]` array. Upload progress updates re-render
  all subscribers.

**Fix:** Split high-churn contexts. For example, separate `AuthUserContext` (stable after login)
from `AuthLoadingContext` (changes during auth flow). Or use `useSyncExternalStore` / selector
pattern.

### 3.6 Devtools Bundled in Production [MEDIUM]

- `ReactQueryDevtools` is rendered unconditionally in `eigen-app.tsx:45`
- `TanStackRouterDevtools` is rendered unconditionally in `app-shell.tsx:57` and `apps/index/__root.tsx:26`

These add to bundle size even when the button is hidden.

**Fix:** Guard with `import.meta.env.DEV`:

```typescript
{import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
```

Or use dynamic import so the devtools chunk is never loaded in production:

```typescript
const DevTools = import.meta.env.DEV
    ? lazy(() => import('@tanstack/react-query-devtools').then(m => ({default: m.ReactQueryDevtools})))
    : () => null;
```

---

## 4. Build & Bundle Size

### 4.1 Fortune-Sheet Route Chunk: 2.6 MB [CRITICAL]

The sheets editor route bundles the entire fortune-sheet library + `@formulajs/formulajs` (formula
engine) + `lodash` + `immer` into one 2.6 MB JavaScript chunk. This is loaded when the user opens
any spreadsheet.

**Fix options (pick one or combine):**
- Lazy-load the formula engine separately (it's only needed when cells contain formulas)
- Replace full `lodash` with `lodash-es` or individual function imports for tree-shaking
- Split fortune-sheet UI from formula engine into separate chunks via `manualChunks`

### 4.2 No Vendor Chunk Splitting [HIGH]

All vendor libraries (React, Radix UI, TanStack Query/Router/Table) are bundled into each app's
main chunk. With 13 apps, React alone is duplicated 13 times in the dist output.

`vite.shared.config.ts` has no `rollupOptions.output.manualChunks` configuration.

**Fix:** Add vendor splitting to the shared Vite config:

```typescript
rollupOptions: {
    output: {
        manualChunks: {
            react: ['react', 'react-dom'],
            radix: ['@radix-ui/react-dialog', '@radix-ui/react-dropdown-menu', /* ... */],
            query: ['@tanstack/react-query'],
        },
    },
}
```

This puts shared vendor code in separate cacheable chunks. When deploying updates, vendor chunks
stay cached if only app code changed.

**Note:** Since each app is a separate Vite build, vendor chunks won't be shared *across* apps.
But they will be shared across routes *within* each app, and provide better cache granularity.

### 4.3 No `sideEffects: false` in Package Configs [MEDIUM]

None of the workspace packages (`packages/lib`, `packages/ui`, `packages/fortune-sheet`) declare
`"sideEffects": false` in their `package.json`. This can prevent the bundler from tree-shaking
unused exports.

**Fix:** Add `"sideEffects": false` to `packages/lib/package.json` and `packages/ui/package.json`.
For `packages/fortune-sheet`, audit for side effects first (CSS imports, global registrations).

### 4.4 All Fonts Loaded on Every Page [LOW]

`packages/ui/src/styles/fonts.css` loads 4 font families (Inter, Source Serif 4, JetBrains Mono,
Excalifont) on every page. Most pages only need Inter.

**Fix:** Move non-essential font `@font-face` declarations to CSS files that are only imported by
components that use them (editor toolbar, code blocks, handwriting mode).

### 4.5 No Build Compression [LOW]

No gzip/brotli pre-compression configured in Vite. The web server must compress on-the-fly.

**Fix:** Add `vite-plugin-compression` for pre-compressed `.gz`/`.br` assets. Configure the web
server to serve pre-compressed files when available.

---

## 5. Architecture & Patterns

### 5.1 SSE vs WebSocket [NO ACTION NEEDED]

The project uses SSE for cache invalidation and WebSocket for Yjs collaborative editing. This is
the correct architecture:

- SSE: Low-frequency, unidirectional, automatic reconnection, 1 connection per user
- WebSocket: High-frequency, bidirectional, per-document, binary protocol for Yjs

Multiplexing SSE events over the Yjs WebSocket would couple two unrelated concerns and add
complexity without meaningful benefit. Under HTTP/2 (which Bun supports), the connection overhead
of separate SSE is negligible.

### 5.2 SSE Event Payloads [NO ACTION NEEDED]

Events carry only identifiers needed for cache invalidation (50-200 bytes per event), not full
objects. This is optimal.

### 5.3 SSE Broadcast Scope [NO ACTION NEEDED]

Each Home broadcasts only to its own SSE listeners. No cross-user fan-out. Optimal.

### 5.4 Server Crash Recovery [ACCEPTABLE]

On server crash, SSE clients reconnect after 5 seconds. No event replay, but data is durable in
SQLite. TanStack Query refetches stale data on reconnect. No data loss, self-healing architecture.

The only gap is the flat 5-second retry (see 1.5).

---

## 6. Tooling

### 6.1 Biome.js [EVALUATE]

Biome could replace ESLint + Prettier with a single Rust-based tool that's 10-100x faster.

**Pros:**
- Single tool for linting + formatting + import sorting
- Zero-config sensible defaults
- Extremely fast (~milliseconds for this project's size)
- Production-ready (used by Discord, Astro)
- Works with Bun (runtime-agnostic, operates on source files)
- Monorepo support via `extends` in sub-package configs

**Cons:**
- Smaller rule set (~280 rules vs ESLint's thousands with plugins)
- No custom rule plugins
- Tailwind CSS class sorting support may be limited (needs verification)
- No cascading config (must explicitly extend root config per package)

**Recommendation:** Worth adopting if Tailwind class sorting is available. Check current
Biome release notes. The speed improvement alone justifies it for a monorepo this size.

### 6.2 React Compiler [EVALUATE]

The React Compiler (shipped with React 19) auto-memoizes components and hooks at build time.
This could address the memoization gap (section 3.2) without manual `React.memo`/`useCallback`
everywhere.

**How to try:** Add `babel-plugin-react-compiler` to `vite.shared.config.ts`:

```typescript
plugins: [
    react({
        babel: {
            plugins: [['babel-plugin-react-compiler']],
        },
    }),
]
```

**Caveat:** Code must follow Rules of React (no side effects in render, no direct state mutation).
Audit before enabling. Start with one app to validate.

---

## Summary: Quick Wins (High Impact, Low Effort)

| Change | Impact | Effort | Section |
|--------|--------|--------|---------|
| Guard devtools with `import.meta.env.DEV` | Bundle size | 5 min | 3.6 |
| Set global `staleTime: 2000` on QueryClient | Eliminates double refetches | 5 min | 2.1 |
| Remove notification `refetchInterval` | Eliminates 60s polling | 1 min | 2.2 |
| Add `SIGTERM` handler in `index.ts` | Prevents dirty shutdown | 15 min | 1.1 |
| Add root `ErrorBoundary` | Prevents white-screen crashes | 30 min | 3.4 |
| Add `sideEffects: false` to packages | Better tree-shaking | 5 min | 4.3 |
| SSE exponential backoff | Reduces thundering herd | 15 min | 1.5 |
| Add `useDebouncedValue` for search | Reduces keystroke re-renders | 20 min | 3.3 |

## Summary: Medium-Term Improvements

| Change | Impact | Effort | Section |
|--------|--------|--------|---------|
| Add `@tanstack/react-virtual` to Drive table | Major perf for large folders | 2-4 hr | 3.1 |
| Vendor chunk splitting in Vite config | Better caching, smaller updates | 1 hr | 4.2 |
| Add `React.memo` to list item components | Reduces re-renders | 2-3 hr | 3.2 |
| Evaluate React Compiler | Automates memoization | 2 hr | 6.2 |
| Split AuthContext | Reduces auth-related re-renders | 1-2 hr | 3.5 |
| Fortune-sheet chunk splitting | Reduces 2.6MB initial load | 2-4 hr | 4.1 |

## Summary: Long-Term Considerations

| Change | Impact | Effort | Section |
|--------|--------|--------|---------|
| Atomic file operations | Data integrity on crash | 1-2 days | 1.2 |
| Recycle bin / soft delete | User safety | 1-2 days | 1.4 |
| List virtualization across all apps | Scales to large datasets | 2-3 days | 3.1 |
| Biome.js adoption | Faster dev tooling | 1 day | 6.1 |
| Font lazy-loading | Faster first paint | 2-4 hr | 4.4 |
