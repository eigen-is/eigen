# Code Review: Managing Director Overview

**Date**: 2026-03-19
**Scope**: Full-stack review of all 12 domains + core infrastructure + shared packages (29 review files)

---

## Executive Summary

Eigen is an impressively ambitious codebase with a solid architectural foundation. The Home singleton pattern, storage
abstraction, Eden Treaty type safety, SSE-driven real-time updates, and the shared packages/ui component library
demonstrate strong engineering decisions. The Yjs-based collaborative editing system is well-designed, and the
ACL/sharing model is thoughtfully layered.

However, this review uncovered **systemic issues** that repeat across nearly every domain. These are not isolated bugs
but patterns that need project-wide remediation. The most critical are:

1. **Silent mutation failures** -- the majority of frontend mutations have no error feedback
2. **Missing `ownerId` in query keys** -- 6 of 8 domains violate this documented rule
3. **XSS vulnerabilities** -- in `DeleteDialog` (via raw HTML rendering of user-provided filenames), `ShadowContent` (
   unsanitized email HTML -- Shadow DOM does NOT prevent script execution), and link inputs accepting `javascript:` URLs
4. **Missing `await` on async calls** -- the project's self-identified #1 bug class, found in 8+ domains
5. **Collab system type safety** -- 12 `@ts-ignore` directives at the WebSocket security boundary

The good news: most issues are mechanical fixes that don't require architectural changes. The patterns are already
documented in CLAUDE.md -- they just need consistent enforcement.

---

## Cross-Cutting Systemic Issues

### 1. Silent Mutation Failures (Every FE domain)

**Impact**: Users perform actions that fail with zero feedback. Data appears lost.

Every frontend app except People has mutations that silently swallow errors. The pattern: `mutateAsync` called without
`try/catch`, or errors caught with only `console.error()`. Zero `toast.error()` calls in: Contacts, Stickies, Slides,
Sheets. Incomplete coverage in: Mail, Calendar, Chat, Docs, Drive.

| Domain   | toast.error() calls    | Mutations without error feedback   |
|----------|------------------------|------------------------------------|
| Contacts | 0                      | All                                |
| Stickies | 0                      | All                                |
| Slides   | 0                      | All                                |
| Sheets   | 0                      | All                                |
| Mail     | 0                      | 5+ mutateAsync calls               |
| Calendar | 0 (console.error only) | Sidebar toggles, RSVP, delete      |
| Chat     | 0                      | postMessage, uploadFile            |
| Docs     | 0                      | Image upload, comment creation     |
| Drive    | Partial                | handleMovePath, handleSave, doSave |
| People   | Full                   | -- (good example to follow)        |

**Fix**: Project-wide sweep. Add `onError` callbacks to all mutation hooks in `packages/lib`, or ensure every call site
uses `try/catch` + `toast.error()`. People app is the gold standard.

**Relevant reviews
**: [FE_CONTACTS](FE_CONTACTS.md), [FE_MAIL](FE_MAIL.md), [FE_CALENDAR](FE_CALENDAR.md), [FE_CHAT](FE_CHAT.md), [FE_DOCS](FE_DOCS.md), [FE_STICKIES](FE_STICKIES.md), [FE_SLIDES](FE_SLIDES.md), [FE_SHEETS](FE_SHEETS.md), [FE_DRIVE](FE_DRIVE.md), [FE_PACKAGES_LIB](FE_PACKAGES_LIB.md)

### 2. Missing `ownerId` in Query Keys (6 domains)

**Impact**: Stale cached data served when switching between personal and team contexts. Live bug for Calendar (which
already supports team calendars).

| Domain   | ownerId in keys?   | Risk                            |
|----------|--------------------|---------------------------------|
| Drive    | Yes                | --                              |
| Chat     | Yes                | --                              |
| Mail     | No                 | Low (personal-only today)       |
| Contacts | No                 | Low (personal-only today)       |
| Calendar | No                 | **High** (team calendars exist) |
| Home     | No                 | Medium                          |
| Space    | No                 | Low                             |
| People   | No (missing orgId) | Low (single-org)                |

**Fix**: Add `ownerId` as the second segment in all query key hierarchies, following Drive's pattern. Calendar is the
highest priority since team calendars are already live.

**Relevant reviews**: [FE_PACKAGES_LIB](FE_PACKAGES_LIB.md) (item 4), [FE_CALENDAR](FE_CALENDAR.md) (item
1), [FE_CONTACTS](FE_CONTACTS.md), [FE_MAIL](FE_MAIL.md)

### 3. Missing `await` on Async Calls (8+ domains)

**Impact**: Fire-and-forget promises silently skip logic, swallow errors, create race conditions.

| Location                                       | Missing await                           | Impact                                                 |
|------------------------------------------------|-----------------------------------------|--------------------------------------------------------|
| `apps/mail/src/routes/_auth...tsx:167,186,199` | `handleNewDraftEmail()`                 | Draft may not exist when navigated to                  |
| `apps/contacts/src/lib/contacts.ts:89,106`     | `addContact()`, `cleanupAvatarImages()` | Seed contact may not exist; cleanup errors lost        |
| `apps/stickies/.../use-board.ts:143`           | `initializeDefaultBoard()`              | Duplicate boards on concurrent open                    |
| `apps/slides/.../editor.tsx:231`               | `reUploadImage()`                       | Image paste silently fails                             |
| `apps/people/src/routes/_auth.tsx:31`          | `setActive()`                           | Org activation silently skipped                        |
| `apps/space/.../fa2.tsx:66`                    | `clipboard.writeText()`                 | Success shown before clipboard write                   |
| `apps/api/src/lib/home/home.ts:78`             | `this.destruct()`                       | Race condition: new Home created while old one closing |
| `apps/api/src/lib/contacts/contacts.ts:89,106` | `addContact()`, `cleanupAvatarImages()` | Same as FE contacts                                    |

**Fix**: Search for all `async` function calls without `await` using the documented CLAUDE.md rule as a checklist.

**Relevant reviews**: [FE_MAIL](FE_MAIL.md) (item 1), [BE_CONTACTS](BE_CONTACTS.md) (items
1-2), [FE_STICKIES](FE_STICKIES.md) (item 2), [FE_SLIDES](FE_SLIDES.md) (item 1), [FE_PEOPLE](FE_PEOPLE.md) (item
1), [BE_CORE](BE_CORE.md) (item 1)

### 4. Security Vulnerabilities

| Severity   | Issue                                                                                                                    | Location                                | Review                                         |
|------------|--------------------------------------------------------------------------------------------------------------------------|-----------------------------------------|------------------------------------------------|
| **HIGH**   | XSS: `DeleteDialog` renders user filenames as raw HTML                                                                   | `packages/ui/.../delete-dialog.tsx:36`  | [FE_PACKAGES_UI](FE_PACKAGES_UI.md)            |
| **HIGH**   | XSS: `ShadowContent` inserts unsanitized email HTML (Shadow DOM is not a security boundary for scripts -- use DOMPurify) | `packages/ui/.../shadow-content.tsx:51` | [FE_PACKAGES_UI](FE_PACKAGES_UI.md)            |
| **HIGH**   | Unauthenticated mail delivery endpoint                                                                                   | `apps/api/src/routes/mail.ts:31`        | [BE_MAIL](BE_MAIL.md)                          |
| **HIGH**   | Header injection via unsanitized params.id                                                                               | `apps/api/src/routes/mail.ts:65`        | [BE_MAIL](BE_MAIL.md)                          |
| **MEDIUM** | No rate limiting on auth endpoints                                                                                       | `apps/api/src/app.ts`                   | [BE_CORE](BE_CORE.md)                          |
| **MEDIUM** | Calendar free-busy permission leak                                                                                       | `apps/api/src/routes/calendar.ts:108`   | [BE_CALENDAR](BE_CALENDAR.md)                  |
| **MEDIUM** | SSE whisper privacy leak in Chat                                                                                         | `apps/api/src/lib/chat/chat.ts:116`     | [BE_CHAT](BE_CHAT.md)                          |
| **MEDIUM** | User enumeration via public API                                                                                          | `apps/api/src/routes/public.ts:22`      | [BE_SPACE](BE_SPACE.md)                        |
| **MEDIUM** | Setup race condition (duplicate admin)                                                                                   | `apps/api/src/lib/setup/setup.ts:163`   | [BE_SETUP](BE_SETUP.md)                        |
| **MEDIUM** | `canWrite` leaked when `canRead` is false                                                                                | `apps/api/src/routes/collab.ts:17`      | [BE_SLIDES](BE_SLIDES.md)                      |
| **MEDIUM** | Link prompt accepts `javascript:` URLs                                                                                   | Drive + Docs markdown editors           | [FE_DRIVE](FE_DRIVE.md), [FE_DOCS](FE_DOCS.md) |
| **LOW**    | No WebSocket message size limit                                                                                          | `apps/api/src/routes/collab.ts`         | [BE_DOCS](BE_DOCS.md)                          |

### 5. Collab System (Shared across Docs, Stickies, Slides, Sheets)

The Yjs collab system is architecturally sound but has repeated findings across all four reviews:

- **12 `@ts-ignore` directives** in `collab.ts` -- the WebSocket security boundary has zero type safety
- **Per-message permission check** hits the database on every keystroke from every user
- **`new Buffer()` deprecated** -- should be `Buffer.from()`
- **Snapshot compaction not in a transaction** -- crash during compaction can corrupt state
- **`keepWebSocketAlive` interval leak** on normal close
- **`normalizeDeck`/`normalizeBoard` in observer callbacks** -- Yjs mutations during observation cause re-entrant loops

**Fix**: Fix these once in the shared collab system and all four apps benefit.

**Relevant reviews
**: [BE_DOCS](BE_DOCS.md), [BE_STICKIES](BE_STICKIES.md), [BE_SLIDES](BE_SLIDES.md), [BE_SHEETS](BE_SHEETS.md)

### 6. Hardcoded Colors (Dark Mode Broken)

Found in: Docs (12+ hex values in CSS), Slides (5 locations), Contacts, Chat (whisper orange), Index (link blue), Setup,
People, Sheets/Fortune-sheet (extensive), Drive (minor).

The worst offenders are:

- `apps/docs/css/globals.css` -- 12+ hardcoded hex colors for the entire editor
- `packages/fortune-sheet/` -- dozens of hardcoded colors across all components
- `apps/slides/` -- `blue-500` / `#3b82f6` for selection UI

**Relevant reviews
**: [FE_DOCS](FE_DOCS.md), [FE_SLIDES](FE_SLIDES.md), [FE_SHEETS](FE_SHEETS.md), [FE_CHAT](FE_CHAT.md), [FE_CONTACTS](FE_CONTACTS.md)

### 7. `interface` vs `type` (Project-Wide)

Found in every frontend app. Estimated 50+ `interface` declarations that should be `type` per CLAUDE.md rules. A bulk
find-and-replace would fix most of these.

---

## Priority Fix List

### P0 -- Fix Immediately (Security + Data Corruption)

| #  | Issue                                                                                               | Type            | Location                                  | Review                                |
|----|-----------------------------------------------------------------------------------------------------|-----------------|-------------------------------------------|---------------------------------------|
| 1  | XSS in `DeleteDialog` -- replace raw HTML rendering with React elements                             | Security        | `packages/ui/.../delete-dialog.tsx:36`    | [FE_PACKAGES_UI](FE_PACKAGES_UI.md)   |
| 2  | XSS in `ShadowContent` -- add DOMPurify sanitization (Shadow DOM does not prevent script execution) | Security        | `packages/ui/.../shadow-content.tsx:51`   | [FE_PACKAGES_UI](FE_PACKAGES_UI.md)   |
| 3  | Unauthenticated mail delivery endpoint                                                              | Security        | `apps/api/src/routes/mail.ts:31`          | [BE_MAIL](BE_MAIL.md)                 |
| 4  | Header injection via `params.id` in Content-Disposition                                             | Security        | `apps/api/src/routes/mail.ts:65`          | [BE_MAIL](BE_MAIL.md)                 |
| 5  | Auth macro throws `Error` instead of `ApiError(401)` -- all unauthed requests return 500            | Bug             | `apps/api/src/routes/auth.ts:25`          | [BE_CORE](BE_CORE.md)                 |
| 6  | `parseOwnerId` UUID regex accepts non-hex characters (G-Z)                                          | Bug             | `packages/lib/src/types/owner.ts:24`      | [BE_CORE](BE_CORE.md)                 |
| 7  | Race condition: Home destruct vs re-creation                                                        | Data Corruption | `apps/api/src/lib/home/home.ts:78-86`     | [BE_CORE](BE_CORE.md)                 |
| 8  | Setup race condition: duplicate admin on concurrent POST                                            | Security        | `apps/api/src/lib/setup/setup.ts:163`     | [BE_SETUP](BE_SETUP.md)               |
| 9  | Slide reorder deletes entire Y.Array -- concurrent additions lost                                   | Data Loss       | `apps/slides/.../use-slide-dnd.ts:38-42`  | [FE_SLIDES](FE_SLIDES.md)             |
| 10 | `useCreateChat` passes wrong arguments to `invalidateItemCreated`                                   | Bug             | `packages/lib/.../use-chat.ts:63`         | [FE_PACKAGES_LIB](FE_PACKAGES_LIB.md) |
| 11 | Stickies: read-only users can mutate board via UI                                                   | Access Control  | `apps/stickies/.../board.tsx`             | [FE_STICKIES](FE_STICKIES.md)         |
| 12 | Calendar: free-busy users see full event details via all-calendars route                            | Info Leak       | `apps/api/src/routes/calendar.ts:108`     | [BE_CALENDAR](BE_CALENDAR.md)         |
| 13 | Collab: `canWrite` leaked when `canRead` is false                                                   | Info Leak       | `apps/api/src/routes/collab.ts:17`        | [BE_SLIDES](BE_SLIDES.md)             |
| 14 | Setup partial failure leaves system stuck (user exists, org doesn't)                                | Data Integrity  | `apps/api/src/lib/setup/setup.ts:194-261` | [BE_SETUP](BE_SETUP.md)               |

### P1 -- Fix Before Production (Reliability + UX)

| #  | Issue                                                                           | Scope           | Review(s)                                      |
|----|---------------------------------------------------------------------------------|-----------------|------------------------------------------------|
| 15 | Add `toast.error()` to all mutations across all FE apps                         | All FE          | All FE reviews                                 |
| 16 | Add `ownerId` to query keys in mail, contacts, calendar, home, space, people    | All FE          | [FE_PACKAGES_LIB](FE_PACKAGES_LIB.md)          |
| 17 | Add `await` to all un-awaited async calls                                       | All             | Multiple reviews                               |
| 18 | Replace 12 `@ts-ignore` in collab.ts with proper WebSocket data types           | BE Collab       | [BE_DOCS](BE_DOCS.md)                          |
| 19 | Add rate limiting to auth + public endpoints                                    | BE Core         | [BE_CORE](BE_CORE.md)                          |
| 20 | Cache `canWrite` per-connection in collab WS (not per-message)                  | BE Collab       | [BE_DOCS](BE_DOCS.md)                          |
| 21 | Fix `sendMail` error handling -- don't move to Sent on failure                  | BE Mail         | [BE_MAIL](BE_MAIL.md)                          |
| 22 | Chat: fix SSE whisper privacy leak                                              | BE Chat         | [BE_CHAT](BE_CHAT.md)                          |
| 23 | Chat: fix attachment name vs pathId mismatch in deleteMessage                   | BE Chat         | [BE_CHAT](BE_CHAT.md)                          |
| 24 | Chat: implement infinite scroll (only 50 messages visible)                      | FE Chat         | [FE_CHAT](FE_CHAT.md)                          |
| 25 | Calendar: validate `from`/`to` range params (unbounded RRULE expansion)         | BE Calendar     | [BE_CALENDAR](BE_CALENDAR.md)                  |
| 26 | Sheets: ops Y.Array grows without bound (memory leak)                           | FE Sheets       | [FE_SHEETS](FE_SHEETS.md)                      |
| 27 | Validate link URLs to prevent `javascript:` protocol in editors                 | FE Docs + Drive | [FE_DOCS](FE_DOCS.md), [FE_DRIVE](FE_DRIVE.md) |
| 28 | Add `maxLength` to all string fields in route schemas                           | All BE routes   | Multiple BE reviews                            |
| 29 | Fix `validateName` to reject control characters                                 | BE Drive        | [BE_DRIVE](BE_DRIVE.md)                        |
| 30 | Hardcoded email in waitlist (`reinder@infi.nl`)                                 | BE Space        | [BE_SPACE](BE_SPACE.md)                        |
| 31 | Mail: context menu uses `mailbox.name` instead of `mailbox.path`                | FE Mail         | [FE_MAIL](FE_MAIL.md)                          |
| 32 | Contacts: dead code -- `addContactMutation` result check always false           | FE Contacts     | [FE_CONTACTS](FE_CONTACTS.md)                  |
| 33 | Stickies: `normalizeBoard` in observer callback causes re-entrant Yjs mutations | FE Stickies     | [FE_STICKIES](FE_STICKIES.md)                  |
| 34 | Docs: `useEditor` dependency array missing `mediaFolderId` (stale closure)      | FE Docs         | [FE_DOCS](FE_DOCS.md)                          |
| 35 | Replace all hardcoded colors with theme tokens (dark mode)                      | All FE          | Multiple FE reviews                            |
| 36 | Remove all `"use client"` directives (8 files)                                  | Packages        | [FE_PACKAGES_UI](FE_PACKAGES_UI.md)            |
| 37 | Index: waitlist form hangs on error (no try/catch)                              | FE Index        | [FE_INDEX](FE_INDEX.md)                        |
| 38 | Index: authenticated redirect hangs if env var undefined                        | FE Index        | [FE_INDEX](FE_INDEX.md)                        |
| 39 | Wrap collab snapshot creation in a transaction                                  | BE Collab       | [BE_DOCS](BE_DOCS.md)                          |
| 40 | Replace `new Buffer()` with `Buffer.from()` in collab                           | BE Collab       | [BE_DOCS](BE_DOCS.md)                          |

### P2 -- Improve When Convenient

- Convert all `interface` to `type` (50+ locations)
- Remove dead code (unused props, commented-out JSX, unused types)
- Extract duplicated utilities (`truncateRRule`, `emptyContact`, `parseFrontmatter`, user-resolution logic)
- Fix N+1 queries in Contacts `getContacts()`
- Remove hardcoded "Reinder Nijhoff" seed contact
- Add unique constraints on calendar `shared_calendars` and `(parentEventId, recurrenceDate)`
- Extract `IDrive` interface to catch missing `SharedDrive` overrides at compile time
- Standardize `nanoid` lengths in Stickies
- Remove Dutch comment in Contacts BE

---

## Domain Health Summary

| Domain           | BE Health | FE Health | Biggest Risk                                                        |
|------------------|-----------|-----------|---------------------------------------------------------------------|
| **Core**         | Fair      | --        | Auth returns 500 for 401; Home race condition; no rate limiting     |
| **Drive**        | Good      | Good      | Missing error feedback on move/save; embed XSS potential            |
| **Mail**         | Fair      | Fair      | Unauthenticated delivery; header injection; missing await on drafts |
| **Calendar**     | Fair      | Fair      | Free-busy permission leak; missing ownerId in query keys            |
| **Chat**         | Fair      | Fair      | Whisper SSE leak; broken attachment deletion; only 50 messages      |
| **Docs/Collab**  | Fair      | Fair      | 12x @ts-ignore; no WS size limit; hardcoded colors everywhere       |
| **Contacts**     | Fair      | Poor      | Missing await x2; zero error toasts; dead code paths                |
| **Stickies**     | Fair      | Poor      | Read-only bypass; async in sync callback; board hidden with 1 col   |
| **Slides**       | Fair      | Fair      | Destructive slide reorder; missing await; zero error toasts         |
| **Sheets**       | Fair      | Fair      | Unbounded ops array; revision restore corruption risk               |
| **Space**        | Good      | Good      | Hardcoded waitlist email; minor issues                              |
| **People**       | Good      | Good      | Missing await on setActive; client-side admin check                 |
| **Setup**        | Fair      | Fair      | Race condition; partial failure stuck state                         |
| **Index**        | --        | Fair      | Form hangs on error; hardcoded colors                               |
| **packages/lib** | --        | Fair      | Wrong args in useCreateChat; missing ownerId in 6 domains           |
| **packages/ui**  | --        | Fair      | XSS in DeleteDialog + ShadowContent; triplicated user resolution    |

---

## What's Working Well

These patterns should be preserved and extended to domains that don't follow them yet:

1. **Drive query keys with `ownerId`** -- the gold standard. All other domains should follow this pattern.
2. **People app error handling** -- every mutation has `try/catch` + `toast.error()`. Other apps should follow.
3. **Path traversal protection in local storage** -- consistent across `LocalFilesystem`, `LocalKeyStorage`,
   `LocalStorage`.
4. **SSE architecture** -- clean pattern of mutation -> notify -> invalidate. Well-documented
   in [docs/SSE.md](../docs/SSE.md).
5. **Eden Treaty end-to-end type safety** -- when not broken by `as any` casts, this is excellent.
6. **Quota enforcement** -- clean three-tier system (settings -> resolution -> enforcement).
7. **Atomic file writes in JsonStore** -- correct write-temp-then-rename pattern.
8. **SharedDrive ACL proxy** -- solid pattern for cross-user access control.
9. **Maildir compatibility** -- thorough IMAP/Dovecot compatibility implementation.
10. **Yjs snapshot compaction** -- reasonable defaults (100 updates, 50 revisions) with revision history.

---

## All Review Files

### Backend

| File                             | Domain                                                   |
|----------------------------------|----------------------------------------------------------|
| [BE_CORE.md](BE_CORE.md)         | Core infrastructure (auth, home, storage, config, share) |
| [BE_MAIL.md](BE_MAIL.md)         | Mail                                                     |
| [BE_DRIVE.md](BE_DRIVE.md)       | Drive                                                    |
| [BE_CONTACTS.md](BE_CONTACTS.md) | Contacts                                                 |
| [BE_CALENDAR.md](BE_CALENDAR.md) | Calendar                                                 |
| [BE_CHAT.md](BE_CHAT.md)         | Chat                                                     |
| [BE_DOCS.md](BE_DOCS.md)         | Docs / Collab                                            |
| [BE_STICKIES.md](BE_STICKIES.md) | Stickies (via Collab)                                    |
| [BE_SLIDES.md](BE_SLIDES.md)     | Slides (via Collab)                                      |
| [BE_SHEETS.md](BE_SHEETS.md)     | Sheets (via Collab)                                      |
| [BE_SPACE.md](BE_SPACE.md)       | Space                                                    |
| [BE_PEOPLE.md](BE_PEOPLE.md)     | People / Teams                                           |
| [BE_SETUP.md](BE_SETUP.md)       | Setup                                                    |

### Frontend

| File                                     | Domain          |
|------------------------------------------|-----------------|
| [FE_MAIL.md](FE_MAIL.md)                 | Mail            |
| [FE_DRIVE.md](FE_DRIVE.md)               | Drive           |
| [FE_CONTACTS.md](FE_CONTACTS.md)         | Contacts        |
| [FE_CALENDAR.md](FE_CALENDAR.md)         | Calendar        |
| [FE_CHAT.md](FE_CHAT.md)                 | Chat            |
| [FE_DOCS.md](FE_DOCS.md)                 | Docs            |
| [FE_STICKIES.md](FE_STICKIES.md)         | Stickies        |
| [FE_SLIDES.md](FE_SLIDES.md)             | Slides          |
| [FE_SHEETS.md](FE_SHEETS.md)             | Sheets          |
| [FE_SPACE.md](FE_SPACE.md)               | Space           |
| [FE_PEOPLE.md](FE_PEOPLE.md)             | People          |
| [FE_SETUP.md](FE_SETUP.md)               | Setup           |
| [FE_INDEX.md](FE_INDEX.md)               | Index / Landing |
| [FE_PACKAGES_LIB.md](FE_PACKAGES_LIB.md) | packages/lib    |
| [FE_PACKAGES_UI.md](FE_PACKAGES_UI.md)   | packages/ui     |

---

## Recommended Fix Order

1. **Security first**: P0 items 1-4 (XSS + unauthenticated endpoint + header injection)
2. **Core bug fixes**: P0 items 5-7 (auth 500, UUID regex, Home race condition)
3. **Data integrity**: P0 items 8-14 (setup, slides, collab, stickies, calendar)
4. **Project-wide sweeps** (most efficient as bulk changes):
    - Add `toast.error()` to all mutations (P1 #15)
    - Add `ownerId` to all query keys (P1 #16)
    - Add `await` to all async calls (P1 #17)
    - Replace hardcoded colors with theme tokens (P1 #35)
    - Convert `interface` to `type` (P2)
    - Remove `"use client"` directives (P1 #36)
5. **Domain-specific fixes**: remaining P1 items per domain
