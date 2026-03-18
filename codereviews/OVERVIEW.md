# Eigen Codebase Review: Executive Overview

**Date:** 2026-03-18
**Scope:** Full-stack review across all 12 domains (7 backend, 18 frontend review files)
**Reviewed by:** 14 specialized agents + manual verification

---

## Overall Assessment

The Eigen codebase is architecturally sound. The monorepo structure is clean, patterns are well-established, and
the `CLAUDE.md` + docs are thorough. The core rule that all data hooks live in `packages/lib` is **consistently
followed** across every app — a notable achievement for a project of this size.

However, this review uncovered **12 critical bugs** and **~90 important issues** spanning security vulnerabilities,
data integrity risks, race conditions, and systematic type safety erosion. The most severe findings are a potential
XSS in email rendering, broken real-time collaboration broadcast, and several authorization bypasses. None are
difficult to fix individually, but they represent accumulated debt that should be addressed systematically.

---

## Domain Review Index

| Review | Domain | Critical | Important | File |
|--------|--------|----------|-----------|------|
| [BE Core](BE_core.md) | Auth, Home, Config, Setup, SSE | 1 | 8 | `apps/api/src/lib/{core,config,auth,home,setup}/` |
| [BE Drive](BE_drive.md) | Drive, Mount, Storage, ACL, Previews | 1 | 9 | `apps/api/src/lib/{drive,mount,storage,preview}/` |
| [BE Mail](BE_mail.md) | Maildir, IMAP | 2 | 7 | `apps/api/src/lib/mail/` |
| [BE Contacts](BE_contacts.md) | Contact management | 1 | 6 | `apps/api/src/lib/contacts/` |
| [BE Calendar](BE_calendar.md) | Calendar, RRULE, sharing | 1 | 8 | `apps/api/src/lib/calendar/` |
| [BE Chat](BE_chat.md) | Chat rooms, slash commands | 1 | 5 | `apps/api/src/lib/chat/` |
| [BE Collab](BE_collab.md) | Yjs, WebSocket, editor | 2 | 3 | `apps/api/src/lib/collab/` |
| [FE Shared](FE_shared.md) | packages/lib + packages/ui | 2 | 7 | `packages/{lib,ui}/` |
| [FE Drive](FE_drive.md) | Drive app | 2 | 5 | `apps/drive/` |
| [FE Mail](FE_mail.md) | Mail app | 1 | 7 | `apps/mail/` |
| [FE Contacts](FE_contacts.md) | Contacts app | 0 | 4 | `apps/contacts/` |
| [FE Calendar](FE_calendar.md) | Calendar app | 0 | 6 | `apps/calendar/` |
| [FE Chat](FE_chat.md) | Chat app | 0 | 4 | `apps/chat/` |
| [FE Collab](FE_collab.md) | Docs, Stickies, Slides, Sheets | 1 | 5 | `apps/{docs,stickies,slides,sheets}/` |
| [FE Space](FE_space.md) | User settings, profile | 0 | 4 | `apps/space/` |
| [FE People](FE_people.md) | Admin, teams, settings | 0 | 4 | `apps/people/` |
| [FE Setup](FE_setup.md) | Setup wizard, index | 0 | 3 | `apps/{setup,index}/` |
| [FE Sheets Deep](FE_sheets_deep.md) | Sheets + fortune-sheet | 1 | 2 | `apps/sheets/`, `packages/fortune-sheet/` |

---

## Critical Issues — Fix First

These are bugs that cause data loss, security vulnerabilities, or broken core functionality.

### P0: Security

| # | Issue | Location | Review |
|---|-------|----------|--------|
| 1 | **XSS in HTML email rendering** — raw HTML inserted into Shadow DOM without sanitization. Script execution possible, enabling session theft and full account compromise. | `packages/ui/src/components/layout/shadow-content.tsx:51` | [FE Mail](FE_mail.md) |
| 2 | **Whisper content leaks via SSE** — private whisper messages broadcast to all connected users through the SSE event stream, bypassing the REST API's per-user filtering. | `apps/api/src/lib/chat/chat.ts:116-122` | [BE Chat](BE_chat.md) |
| 3 | **Calendar `shared-with-me` authorization bypass** — any authenticated user can probe any other user's shared calendars by varying the `ownerId` parameter. | `apps/api/src/routes/calendar.ts:173-176` | [BE Calendar](BE_calendar.md) |
| 4 | **Unauthenticated mail delivery endpoint** — `POST /mail/deliver/:to` has no auth, rate limiting, or size limits. Open to spam flooding. | `apps/api/src/routes/mail.ts:28` | [BE Mail](BE_mail.md) |

### P0: Core Functionality

| # | Issue | Location | Review |
|---|-------|----------|--------|
| 5 | **Collab updates never broadcast to peers** — when one user edits a document, changes are persisted to DB but never delivered to other connected WebSocket clients. Multi-user real-time editing appears fundamentally broken. | `apps/api/src/lib/collab/collabDocument.ts:250-276` | [BE Collab](BE_collab.md) |
| 6 | **Drive query keys omit `ownerId`** — switching between personal drive and team drives serves cached data from the wrong owner. Most visible when accessing shared/team content. | `packages/lib/src/core/drive/hooks/use-drive.ts:10-26` | [FE Shared](FE_shared.md) |
| 7 | **Missing `await` on `matchesACL()` in share propagation** — the unshare branch is never executed, causing stale entries to accumulate in every user's `shared.db`. | `apps/api/src/lib/drive/drive.ts:561` | [BE Drive](BE_drive.md) |
| 8 | **`getMe()` returns null after self-contact creation** — `addYourself()` returns `user.id` but `getContactById` expects the DB-generated contact ID. The "me" contact card is perpetually missing. | `apps/api/src/lib/contacts/contacts.ts:363-371` | [BE Contacts](BE_contacts.md) |

### P0: Data Integrity

| # | Issue | Location | Review |
|---|-------|----------|--------|
| 9 | **Snapshot creation race condition** — `DELETE FROM doc_updates` has no WHERE clause and no transaction. Updates arriving between snapshot read and delete are permanently lost. | `apps/api/src/lib/collab/collabDocument.ts:82-115` | [BE Collab](BE_collab.md) |
| 10 | **`getTeamExists` missing `await`** — always returns truthy (a Promise), allowing Home instances for non-existent teams. | `apps/api/src/lib/team/team.ts:11` | [BE Core](BE_core.md) |
| 11 | **Stickies/Slides `useBoard`/`useDeck` return null ref** — on first render before WebSocket sync, user interactions silently fail. | `apps/stickies/src/components/stickies/hooks/use-board.ts:218-219` | [FE Collab](FE_collab.md) |
| 12 | **Sheets MIME type typo** — `application-eigensheet` (missing `s`) in 3 route files breaks navigation. | `apps/sheets/src/routes/index.tsx:12` | [FE Sheets](FE_sheets_deep.md) |

---

## Important Issues — Prioritized Fix List

### Tier 1: Security Hardening (fix this week)

| # | Issue | Location | Review |
|---|-------|----------|--------|
| 1 | Path traversal in contacts avatar download (filename not sanitized) | `apps/api/src/lib/contacts/contacts.ts:318` | [BE Contacts](BE_contacts.md) |
| 2 | Content-Disposition header injection via unsanitized filenames | `apps/api/src/routes/drive.ts:114` | [BE Drive](BE_drive.md) |
| 3 | Path traversal guard missing in `LocalKeyStorage` | `apps/api/src/lib/storage/local-key-storage.ts` | [BE Drive](BE_drive.md) |
| 4 | Hardcoded auth secret fallback exposed in repo | `apps/api/src/lib/auth/auth.ts:98` | [BE Core](BE_core.md) |
| 5 | `ownerId` param ignored in mail routes (misleading API, regression risk) | `apps/api/src/routes/mail.ts` (all routes) | [BE Mail](BE_mail.md) |
| 6 | `ownerId` param ignored in contacts routes | `apps/api/src/routes/contacts.ts` (all routes) | [BE Contacts](BE_contacts.md) |
| 7 | Clients can post `type: 'system'` chat messages | `apps/api/src/routes/chat.ts:40-45` | [BE Chat](BE_chat.md) |
| 8 | UUID validation regex accepts non-hex chars (`a-fA-Z` vs `a-fA-F`) | `packages/lib/src/types/owner.ts:24` | [FE Shared](FE_shared.md) |

### Tier 2: Data Integrity & Correctness (fix next)

| # | Issue | Location | Review |
|---|-------|----------|--------|
| 9 | `movePath` allows moving folder into own descendant (creates orphan cycle) | `apps/api/src/lib/drive/drive.ts:315-338` | [BE Drive](BE_drive.md) |
| 10 | `movePath` missing write permission check on target parent | `apps/api/src/lib/drive/drive.ts:329` | [BE Drive](BE_drive.md) |
| 11 | Hardcoded MIME boundary in EML generation | `apps/api/src/lib/mail/mailfile.ts:35` | [BE Mail](BE_mail.md) |
| 12 | BCC header always emitted in stored EML (privacy leak) | `apps/api/src/lib/mail/mailfile.ts:26-36` | [BE Mail](BE_mail.md) |
| 13 | `home.size()` ignores non-default mounts | `apps/api/src/lib/home/home.ts:105-123` | [BE Core](BE_core.md) |
| 14 | RRULE validation missing — malformed rules crash on expansion | `apps/api/src/lib/calendar/calendar.ts:276, 303` | [BE Calendar](BE_calendar.md) |
| 15 | Unbounded recurrence expansion (no cap on generated occurrences) | `apps/api/src/lib/calendar/calendar.ts:1041-1113` | [BE Calendar](BE_calendar.md) |
| 16 | `removeMount` doesn't close mount databases or collab documents | `apps/api/src/lib/drive/drive.ts:101-106` | [BE Drive](BE_drive.md) |
| 17 | `createAsyncSingleton` permanently broken after transient error | `apps/api/src/utils/singleton.ts` | [BE Core](BE_core.md) |
| 18 | Direct mutation of TanStack Query cache in mail app | `apps/mail/src/routes/_auth.$filterType.$filterId.tsx:62-63` | [FE Mail](FE_mail.md) |
| 19 | Rules of Hooks violation (conditional `useBreadcrumb`) | `packages/ui/src/components/layout/drive/drive-list.tsx:58` | [FE Drive](FE_drive.md) |

### Tier 3: Type Safety & Code Quality (systematic cleanup)

| # | Issue | Scope | Review |
|---|-------|-------|--------|
| 20 | ~50+ `as any` casts across hooks in packages/lib | calendar (13), mail, team, settings, contacts, people hooks | [FE Shared](FE_shared.md) |
| 21 | `interface` used instead of `type` in ~20+ files | Across all frontend apps and packages/ui | Multiple |
| 22 | `console.log` statements in production code | sheets (13), space (2), SSE handler, collab | Multiple |
| 23 | Duplicated `jsonToYType` + revision restore across 3 apps | stickies, slides, sheets | [FE Collab](FE_collab.md) |
| 24 | Dutch comments in English-only codebase | contacts hooks, space login-2fa, index root | Multiple |
| 25 | `"use client"` Next.js directives in Vite apps (no-op) | 3 Space components | [FE Space](FE_space.md) |
| 26 | Chat 5-second polling redundant with SSE | `packages/lib/src/core/chat/hooks/use-chat.ts:34` | [FE Chat](FE_chat.md) |
| 27 | `MAIL_SENT` SSE handler is a no-op | `packages/lib/src/core/mail/sse-handlers.ts:60-61` | [FE Mail](FE_mail.md) |

### Tier 4: Fortune-Sheet

See [FE Sheets Deep Dive](FE_sheets_deep.md) for the full analysis. Key decisions:

- **Move `packages/fortune-sheet/` into `apps/sheets/`** — it is only used by the sheets app (confirmed via import grep). Keeping it in `packages/` is misleading.
- **Prioritize UI layer cleanup over core engine refactoring** — the 42K-line core works; the 1,740 lines of legacy CSS and 327 `luckysheet-*` class references are the highest-value cleanup targets.
- **Address the 70 `@ts-ignore` and 43 `as any` casts** incrementally, not in a big-bang refactor.

---

## Systemic Patterns Worth Addressing

### 1. `ownerId` parameter ignored across multiple domains

Mail routes, contacts routes, SSE route, and calendar `shared` endpoint all accept an `ownerId` URL parameter but
silently use the authenticated user's ID instead. This is a **systemic API design issue** — the parameter either
needs validation (`ownerId === user.id` or authorized team access) or should be removed to prevent confusion and
future regressions.

**Affected:** `routes/mail.ts`, `routes/contacts.ts`, `routes/sse.ts`, `routes/calendar.ts`

### 2. `as any` erosion of Eden Treaty type safety

The project chose Eden Treaty specifically for end-to-end type safety, but ~50+ `as any` casts in `packages/lib`
hooks nullify this benefit. The root cause appears to be Eden Treaty's type inference struggling with certain
Elysia route patterns (optional params, complex body types). These should be fixed at the route/schema level
rather than cast away in hooks.

### 3. Missing defense-in-depth on Drive operations

The `SharedDrive` wrapper provides ACL checks at the route level, but the underlying `Drive` class methods
(`downloadFile`, `getPreview`, `openDatabase`) have no permission checks. This is fragile — any new route
that calls `Drive` directly bypasses security. The fix is straightforward: add permission checks in `Drive`
methods as defense-in-depth.

### 4. Collab infrastructure needs attention

The WebSocket-based collaboration system has the most critical bugs in this review (no broadcast, snapshot race
condition, permanent singleton failure). Given that docs/stickies/slides/sheets all depend on it, this is the
highest-risk area of the codebase. Consider adding integration tests for multi-client scenarios.

---

## Strengths Worth Preserving

- **Architectural discipline** — hooks in `packages/lib`, not in apps. Universally followed.
- **Query key pattern** — consistent hierarchical key factories across all domains.
- **SSE event system** — clean emit/subscribe/invalidate pattern with domain-specific handlers.
- **Type sharing** — shared types in `packages/lib/src/types/` used by both FE and BE.
- **Test coverage** — 636 tests across 26 files, with solid happy-path coverage for most domains.
- **Documentation** — comprehensive docs/ covering architecture, patterns, and domain specifics.
- **Clean separation** — routes are thin, business logic lives in domain classes, DB access is encapsulated.

---

## Recommended Fix Order

1. **Week 1 — Security** (P0 items 1-4, Tier 1 items 1-8)
   - Sanitize HTML email rendering (DOMPurify)
   - Fix whisper SSE leak
   - Fix calendar auth bypass
   - Add auth/rate-limiting to mail delivery
   - Fix path traversal and header injection vectors

2. **Week 2 — Core Functionality** (P0 items 5-12)
   - Fix collab broadcast (this unlocks multi-user editing)
   - Fix collab snapshot race condition
   - Fix drive query keys (add ownerId)
   - Fix `matchesACL` await
   - Fix getMe(), getTeamExists, sheets MIME typo

3. **Week 3 — Data Integrity** (Tier 2 items 9-19)
   - Fix movePath cycle detection + target permission
   - Fix MIME boundary and BCC leak
   - Fix singleton retry, home.size() multi-mount
   - Fix RRULE validation + cap recurrence

4. **Ongoing — Code Quality** (Tier 3-4)
   - Systematic `as any` removal
   - Extract duplicated collab utilities
   - Clean up console.logs, Dutch comments, dead code
   - Fortune-sheet migration + CSS cleanup
