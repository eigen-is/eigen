# Cleanup & Optimization — Remaining Items

Items still to address. Ordered by priority.

---

## P1 — Network

### Avatar N+1 Problem [HIGH]

Each `<UserAvatar>` calls `useResolvedUser()` which fires 4 queries: `useContacts()`,
`usePublicUser(emailOrId)`, `usePublicConfig()`, and `usePeopleTeams(orgId)`.

TanStack Query deduplicates concurrent requests with the same queryKey, so shared queries
(`useContacts`, `usePublicConfig`, `usePeopleTeams`) only fetch once. But `usePublicUser(emailOrId)`
is unique per user — 10 unique users = 10 separate fetches.

**Fix:** Batch user resolution — fetch all visible users in one query via a batch endpoint.

---

## P2 — Frontend

### List Virtualization [HIGH]

No virtual scrolling. All lists render every item to the DOM:

- **DriveTable** (`packages/ui/.../drive-table.tsx`): All folder contents
- **EmailList** (`apps/mail/.../email-list.tsx`): All filtered emails
- **ChatMessageList** (`packages/ui/.../chat-message-list.tsx`): All loaded messages

React Compiler handles memoization automatically. The core issue is DOM node count.

**Fix:** Add `@tanstack/react-virtual`. Start with Drive (most likely to have hundreds of items).

### Email Date Formatting in Render Loop [LOW]

`email-list.tsx` creates Date objects and calls Intl formatting APIs per email per render.

**Fix:** Memoize formatted dates, or compute once on data fetch.

---

## P2 — Build & Bundle

### Font Lazy-Loading [MEDIUM]

`packages/ui/src/styles/fonts.css` loads 4 font families on every page. Only Inter is needed
by default. Source Serif 4, JetBrains Mono, and Excalifont are only used by specific features.

**Fix:** Move non-essential fonts to component-specific CSS.

### Console Stripping in Production [LOW]

Fortune-sheet has 54 `console.error()` and 357 `console.warn()` calls that ship to production.

**Fix:** Add esbuild/Vite plugin to strip console calls in production builds.

### Image Lazy Loading [LOW]

Zero uses of `loading="lazy"` in the codebase.

**Fix:** Add `loading="lazy"` to image components, especially in lists and previews.

---

## P2 — Backend

### Thumbnail Retry [MEDIUM]

Thumbnail generation is fire-and-forget with `.catch(console.error)`. No retry, no tracking.

**Fix:** Store `thumbnailStatus` field. Retry on next access if missing.

### Recycle Bin [MEDIUM]

File deletion is permanent.

**Fix (when ready):** Add `deletedAt` column. Filter deleted items. Background job purges after 30 days.

### Contacts.size() N+1 [LOW]

Lists all avatar files, then calls `storage.size()` per file.

**Fix:** Store avatar sizes in the database, or use a single directory stat.

---

## P3 — Code Quality

### `interface` vs `type` Convention [MEDIUM]

131 instances of `interface` in app components (should be `type` per CLAUDE.md).

**Fix:** Bulk convert. Consider adding a lint rule.

### Large Monolithic Components [LOW]

| Component | Lines | Issue |
|-----------|-------|-------|
| `apps/docs/.../editor-toolbar.tsx` | 708 | Toolbar + formatting + layout |
| `apps/contacts/.../contact-edit.tsx` | 653 | Form + avatar upload + labels |
| `apps/slides/.../slide-properties-panel.tsx` | 584 | Animation + styling + text |
| `apps/slides/.../editor.tsx` | 529 | Canvas + 29 internal functions |
| `packages/ui/.../chat-message-input.tsx` | 366 | 3 suggest systems in one file |

**Fix:** Extract sub-components when touching these files.

---

## P3 — Tooling

### Biome.js [EVALUATE]

Could replace ESLint + Prettier with a single Rust-based tool (10-100x faster).
Worth adopting if Tailwind class sorting is available.

---

## Summary

| Item                                     | Priority | Effort   | Category |
|------------------------------------------|----------|----------|----------|
| Avatar batch resolution                  | P1       | 2-3 hr   | Network  |
| List virtualization (Drive, email, chat) | P2       | 2-3 days | Frontend |
| Font lazy-loading                        | P2       | 2-4 hr   | Bundle   |
| Thumbnail retry                          | P2       | 1-2 hr   | Backend  |
| Recycle bin / soft delete                | P2       | 1-2 days | Backend  |
| Contacts.size() N+1                      | P2       | 30 min   | Backend  |
| Console stripping in production          | P3       | 1 hr     | Bundle   |
| Image lazy loading                       | P3       | 2-3 hr   | Bundle   |
| Email date formatting                    | P3       | 30 min   | Frontend |
| `interface` → `type` conversion          | P3       | 1-2 hr   | Quality  |
| Biome.js adoption                        | P3       | 1 day    | Tooling  |
