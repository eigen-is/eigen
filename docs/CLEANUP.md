# Cleanup & Optimization — Remaining Items

Items still to address. Ordered by priority.

---

## P1 — Network

### Avatar N+1 Problem [HIGH]

Each `<UserAvatar>` calls `useResolvedUser()` which fires 4 queries: `useContacts()`,
`usePublicUser(emailOrId)`, `usePublicConfig()`, and `useTeams(orgId)`.

TanStack Query deduplicates concurrent requests with the same queryKey, so shared queries
(`useContacts`, `usePublicConfig`, `useTeams`) only fetch once. But `usePublicUser(emailOrId)`
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

### Contacts.size() N+1 [LOW]

Lists all avatar files, then calls `storage.size()` per file.

**Fix:** Store avatar sizes in the database, or use a single directory stat.

---

## P2 — Type Safety

### Eden Treaty `as Type` Casts [HIGH]

~20 hooks cast `response.data` to a manually-defined type (e.g., `as CalendarItem[]`, `as EmailSummary[]`),
defeating Eden Treaty's end-to-end type safety. Root cause: Elysia route schemas likely return loosely-typed
responses.

Key files: `use-calendar.ts` (6 casts), `use-emails.ts`, `use-collab.ts`, `use-notifications.ts`,
`use-server-settings.ts`, `use-s3-config.ts`, `use-space-settings.ts`, `use-team-settings.ts`, `use-chat.ts`,
`use-comments.ts`, `use-drive.ts`, `use-setup-status.ts`

**Fix:** Tighten Elysia route response schemas to include proper return types, then remove the `as` casts.
Work route-by-route.

### `t.Any()` for Mail Draft/Send Body [HIGH]

`apps/api/src/routes/mail.ts` lines 180, 191 — draft PUT and send POST use `t.Any()` for the `mail` body
field, breaking Eden Treaty type inference.

**Fix:** Define a proper typed schema for the mail body.

### `SetupStatus` Type Manually Redefined [LOW]

`packages/lib/src/core/admin/hooks/use-setup-status.ts` defines `SetupStatus` locally instead of deriving it
from Eden Treaty.

**Fix:** Remove local type, use inferred return type from route.

### Unsafe `Partial<EmailDraft>` → `EmailDraft` Cast [LOW]

`packages/lib/src/core/mail/hooks/use-draft.ts` line 24 — casts a partial object to full `EmailDraft`.

**Fix:** Define a `NewDraft` type for draft creation, or build the object field-by-field.

---

## P2 — Architecture

### `sonner.tsx` Uses `next-themes` [MEDIUM]

`packages/ui/src/components/sonner.tsx` imports `useTheme` from `next-themes` instead of the project's
own `ThemeProvider`. May deliver wrong theme to the toast renderer.

**Fix:** Replace with the project's theme state from `layout/app/theme-provider.tsx`.

### Error Handling in App Components [MEDIUM]

Remaining app components that use `try/catch` + `toast.error()` directly (not via mutation hooks):

| File | Issue |
|------|-------|
| `apps/mail/.../use-mail-actions.ts` (144, 159, 181) | `toast.error()` on reply/forward (precondition check, not mutation) |
| `apps/space/.../security.password.tsx` | `try/catch` + `toast.error()` (direct authClient call) |
| `apps/space/.../security.2fa.tsx` (49-119) | 3 separate `try/catch` + `toast.error()` blocks (direct authClient calls) |

**Fix:** Space security routes need auth client calls wrapped in proper hooks in `packages/lib/src/core/auth/hooks/`.

### Direct `useQueryClient` in App [LOW]

`apps/drive/.../native-file-editor.tsx` imports `useQueryClient` directly to invalidate editor queries.

**Fix:** Add `invalidateEditorContent()` to `packages/lib/src/core/editor/hooks/`.

### Docs Editor Not Using `ColumnLayout` [LOW]

`apps/docs/src/routes/_auth.doc.$ownerId.$mountId.$pathId.tsx` wraps editor in a plain `<div>` instead
of `ColumnLayout` + `Column` as documented in AGENTS.md.

**Fix:** Wrap `<Column>` in `<ColumnLayout>` inside the editor component.

---

## P2 — DRY Violations

No remaining P2 DRY items.

---

## P3 — Code Quality

### `interface` vs `type` Convention [LOW]

~20 instances of `interface` remaining in app code (down from ~35), many in auto-generated `routeTree.gen.ts`.

**Fix:** Convert remaining hand-written instances. Biome's `useConsistentObjectType` rule could enforce this.

### Large Monolithic Components [LOW]

| Component | Lines | Issue |
|-----------|-------|-------|
| `apps/docs/.../editor-toolbar.tsx` | 775 | Toolbar + formatting + layout |
| `apps/slides/.../editor.tsx` | 691 | Canvas + many internal functions |
| `apps/contacts/.../contact-edit.tsx` | 668 | Form + avatar upload + labels |
| `apps/slides/.../slide-properties-panel.tsx` | 647 | Animation + styling + text |
| `apps/admin/.../team-detail.tsx` | 429 | Extracted AddMemberDialog + MountDialog; still has 20+ state vars |
| `packages/ui/.../chat-message-input.tsx` | 367 | 3 suggest systems in one file |

**Fix:** Extract sub-components when touching these files.

### Shadow DOM Hardcoded Colors [LOW]

`packages/ui/.../shadow-content.tsx` lines 48-61 — uses `#333` and `#2563eb` inside Shadow DOM CSS.
Shadow DOM is style-isolated and can't access Tailwind tokens directly.

**Fix:** Inject CSS custom property values from the host element via `getComputedStyle`.

### Drizzle Contacts `relations()` Possibly Dead [LOW]

`apps/api/src/lib/contacts/schema.ts` exports Drizzle `relations()` definitions, but relational queries
(`.query.`) are never used in the contacts module.

**Fix:** Verify unused, then remove.

### `as ViewMode` / `as RecurringAction` Casts [LOW]

`apps/calendar/.../calendar-toolbar.tsx` and `recurring-action-dialog.tsx` — Select/RadioGroup `onValueChange`
returns `string`, requiring casts to union types.

**Fix:** Add type guards or use the union directly in the handler.

### Mail Parser `as unknown as` Casts [INFO]

`apps/api/src/lib/mail/mail-parser/mail-parser.ts` and `simple-parser.ts` — 15+ casts in ported JS library.
Major rewrite needed; low ROI.

### Collab `as Uint8Array` Casts [INFO]

5 locations in collab code — Drizzle blob returns `Buffer`, Yjs needs `Uint8Array`. Safe at runtime
(`Buffer extends Uint8Array`). Drizzle typing limitation.

---

## Summary

| Item                                     | Priority | Effort   | Category |
|------------------------------------------|----------|----------|----------|
| Avatar batch resolution                  | P1       | 2-3 hr   | Network  |
| Eden Treaty `as Type` casts (~20 hooks)  | P2       | 1-2 days | Types    |
| `t.Any()` in mail draft/send routes      | P2       | 1-2 hr   | Types    |
| `sonner.tsx` uses `next-themes`          | P2       | 30 min   | Arch     |
| Error handling in app components (6+)    | P2       | 2-3 hr   | Arch     |
| ~~Duplicated Yjs utilities (3 patterns)~~| ~~P2~~   | Done     | DRY      |
| List virtualization (Drive, email, chat) | P2       | 2-3 days | Frontend |
| Font lazy-loading                        | P2       | 2-4 hr   | Bundle   |
| Thumbnail retry                          | P2       | 1-2 hr   | Backend  |
| Contacts.size() N+1                      | P2       | 30 min   | Backend  |
| ~~Duplicated calendar utilities~~        | ~~P3~~   | Done     | DRY      |
| ~~Calendar routes ignore `:ownerId`~~    | ~~P3~~   | Done     | Arch     |
| Large monolithic components (6 files)    | P3       | per-file | Quality  |
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
| `interface` -> `type` bulk conversion    | Mostly done -- reduced from 131 to ~20 (many in generated files) |
| Code quality sweep (2025-04)             | Done -- dead code, comments, `"use client"`, colors, `.catch()`, ApiError |
| Eden Treaty type safety                  | Done -- backend return types + ~20 cast removals from hooks |
| `next-themes` → MutationObserver         | Done -- sonner.tsx uses local useTheme hook |
| Yjs DRY (jsonToYType, restoreYjsDoc)     | Done -- shared in `packages/lib/core/collab/yjs-utils.ts` |
| Calendar DRY (utils + insertSharedCal)   | Done -- `calendar-utils.ts` + private helper |
| Drive dialogs DRY                        | Done -- `useDialogState()` helper (155→114 lines) |
| SharedDrive getSharedWith wrapper        | Done -- route goes through SharedDrive, self-filtering |
| Calendar requireSelf on shared routes    | Done -- 3 routes now validate ownerId |
| NewDraft type                            | Done -- replaces unsafe `as EmailDraft` cast |
| team-detail.tsx decomposition            | Done -- extracted AddMemberDialog + MountDialog (547→429 lines) |
| Mail `t.Any()` → MailDraftSchema         | Done -- typed schema for draft/send routes |
| Error handling (stickies, slides, labels) | Done -- removed redundant try/catch |
| Recycle bin / soft delete                | Done -- trash with auto-purge, ACL propagation, frontend UI. See [SOFT-DELETE.md](SOFT-DELETE.md) |
