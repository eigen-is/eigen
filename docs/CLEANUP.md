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

Fortune-sheet has ~17 remaining `console.error()`/`console.warn()` calls (down from 400+). Most were removed during
the fork cleanup.

**Fix:** Add esbuild/Vite plugin to strip remaining console calls in production builds.

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

### `interface` vs `type` Convention [LOW]

~35 instances of `interface` remaining in app code (down from 131), many in auto-generated `routeTree.gen.ts` files.

**Fix:** Convert remaining hand-written instances. Biome's `useConsistentObjectType` rule could enforce this.

### Large Monolithic Components [LOW]

| Component | Lines | Issue |
|-----------|-------|-------|
| `apps/docs/.../editor-toolbar.tsx` | 775 | Toolbar + formatting + layout |
| `apps/slides/.../editor.tsx` | 691 | Canvas + many internal functions |
| `apps/contacts/.../contact-edit.tsx` | 668 | Form + avatar upload + labels |
| `apps/slides/.../slide-properties-panel.tsx` | 647 | Animation + styling + text |
| `packages/ui/.../chat-message-input.tsx` | 367 | 3 suggest systems in one file |

**Fix:** Extract sub-components when touching these files.

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
| Console stripping in production          | P3       | 30 min   | Bundle   |
| Image lazy loading                       | P3       | 2-3 hr   | Bundle   |
| Email date formatting                    | P3       | 30 min   | Frontend |
| `interface` → `type` conversion          | P3       | 30 min   | Quality  |

### Completed

| Item                                     | Status |
|------------------------------------------|--------|
| Biome.js adoption                        | Done -- `biome.jsonc` configured, CI runs `bun run lint` |
| Mail-parser/mail-split JS -> TS          | Done -- all `.js` files converted to `.ts` |
| CI pipeline                              | Done -- `.github/workflows/check.yml` (lint + typecheck + test) |
| Console call cleanup (fortune-sheet)     | Mostly done -- reduced from 400+ to ~17 |
| `interface` -> `type` bulk conversion    | Mostly done -- reduced from 131 to ~35 (many in generated files) |
