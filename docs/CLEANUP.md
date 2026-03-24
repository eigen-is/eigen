# Cleanup & Optimization — Remaining Items

Items still to address from the full-stack audit. Ordered by priority.

---

## Backend Stability

### Thumbnail Retry [MEDIUM]

Drive's `uploadFile` spawns thumbnail generation in a `.then()` chain with only a `.catch(console.error)`.
If it fails, there's no retry, no tracking, and the user never learns.

**Fix:** Store a `thumbnailStatus` or `thumbnailAttempts` field. Retry on next access if missing.

### Recycle Bin [MEDIUM]

File deletion is permanent. Acceptable during dev, but production needs soft delete.

**Fix (when ready):** Add `deletedAt` column to paths schema. Filter out deleted items in queries.
Background job permanently deletes after 30 days.

### Team Settings SSE Over-Invalidation [MEDIUM]

`packages/lib/src/core/team/sse-handlers.ts` handles `TEAM_SETTINGS_UPDATED` by invalidating
`calendarKeys.all` — the entire calendar cache. A team name change causes every calendar query
to refetch.

**Fix:** Only invalidate the affected team's calendar queries, or split team-setting types
so that only member/permission changes trigger calendar invalidation.

---

## Frontend Performance

### List Virtualization [CRITICAL]

No virtual scrolling library is used. All lists render every item to the DOM:

- **DriveTable** (`packages/ui/.../drive-table.tsx`): All folder contents as `<TableRow>`
- **EmailList** (`apps/mail/.../email-list.tsx`): All filtered emails
- **ChatMessageList** (`packages/ui/.../chat-message-list.tsx`): All loaded messages

A folder with 500 files = 500 DOM nodes with event handlers, context menus, drag props.

**Fix:** Add `@tanstack/react-virtual` for Drive table, email list, and chat messages.
Start with Drive (most likely to have hundreds of items).

---

## Build & Bundle Size

### Fortune-Sheet Route Chunk: 2.6 MB [CRITICAL]

The sheets editor route bundles the entire fortune-sheet library + `@formulajs/formulajs` +
`lodash` + `immer` into one 2.6 MB chunk.

**Fix options:**
- Lazy-load the formula engine separately (only needed when cells contain formulas)
- Replace full `lodash` with `lodash-es` or individual function imports for tree-shaking
- Split fortune-sheet UI from formula engine into separate chunks via `manualChunks`

### Font Lazy-Loading [LOW]

`packages/ui/src/styles/fonts.css` loads 4 font families on every page. Most pages only need Inter.

**Fix:** Move non-essential font `@font-face` declarations to CSS files that are only imported by
components that use them (editor toolbar, code blocks, handwriting mode).

### Build Compression [LOW]

No gzip/brotli pre-compression configured in Vite. The web server must compress on-the-fly.

**Fix:** Add `vite-plugin-compression` for pre-compressed `.gz`/`.br` assets.

---

## Tooling

### Biome.js [EVALUATE]

Biome could replace ESLint + Prettier with a single Rust-based tool that's 10-100x faster.

**Pros:** Single tool, zero-config defaults, millisecond speed, production-ready (Discord, Astro),
works with Bun, monorepo support via `extends`.

**Cons:** Smaller rule set (~280 rules), no custom plugins, Tailwind class sorting support
needs verification.

**Recommendation:** Worth adopting if Tailwind class sorting is available.

---

## Summary

| Item | Priority | Effort |
|------|----------|--------|
| List virtualization (Drive, email, chat) | CRITICAL | 2-3 days |
| Fortune-sheet 2.6 MB chunk | CRITICAL | 2-4 hr |
| Thumbnail retry | MEDIUM | 1-2 hr |
| Recycle bin / soft delete | MEDIUM | 1-2 days |
| Team SSE over-invalidation | MEDIUM | 30 min |
| Font lazy-loading | LOW | 2-4 hr |
| Build compression | LOW | 30 min |
| Biome.js adoption | EVALUATE | 1 day |
