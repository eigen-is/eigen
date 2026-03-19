# Eigen Codebase Review: Executive Overview

**Date:** 2026-03-19
**Scope:** Full-stack deep review across all domains — 7 backend reviews, 11 frontend reviews (18 total)
**Methodology:** Independent review agents per domain, each reading all relevant documentation and every source file
line-by-line. All findings verified against current code. Previous review (2026-03-18) challenged and corrected where
inaccurate.

---

## Overall Assessment

Eigen's codebase is architecturally disciplined and remarkably consistent for a project spanning 14 apps, 20+ backend
domains, and two shared packages. The documented patterns (CLAUDE.md, docs/) are followed in practice. The Home
singleton hierarchy, ManagedDatabase lifecycle, SSE event system, Eden Treaty type safety, and centralized hook
architecture in `packages/lib` all work as designed.

This review uncovered **40 critical issues**, **~136 important issues**, and **~170 minor issues** across 18 review
files. Compared to the previous review (2026-03-18), **~15 previously-reported critical issues have been fixed**, but
new issues were discovered — particularly around error handling gaps, stale closures, and SSE content leaks. Several
previous "critical" findings were confirmed as **false positives** and removed (e.g., mail XSS, contacts save indicator,
waitlist stale closure, calendar permission hardcoding, contacts `getMe()` null return).

The most severe confirmed findings are: unauthenticated mail delivery with no rate limiting, SSE content leaks in chat
delete/edit events, a race condition in Home lifecycle management, `ownerId` validation gaps across multiple backend
routes, and pervasive missing error handling on frontend mutations. None require architectural changes — the clean
structure makes targeted fixes straightforward.

### Key Changes from Previous Review (2026-03-18)

| Area                               | What Changed                                                                                                                                                                                                                                                                                                                                  |
|------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **False positives removed**        | Calendar permission hardcoding, calendar share leak to free-busy users, contacts `getMe()` null return, contacts save indicator, contacts avatar double-processing, waitlist stale closure, "Recommended" label wrong, path traversal in LocalFilesystem/LocalKeyStorage, singleton retry failure, auth secret hardcoded                      |
| **Issues fixed since last review** | Drive `matchesACL` await, `SharedDrive` slides/sheets overrides, MIME type typos, mail download URLs, drive `Content-Disposition` sanitization, `getTeamExists` await, `as any` cleanup in lib hooks (21→0), drive Rules of Hooks, chat polling removed, mail reply-to handling, mail draft error handling, several Dutch comments translated |
| **New issues found**               | Chat SSE content leaks (delete + edit), 2FA toggle cosmetic-only, mail toolbar sends stale data, `parseOwnerId` regex accepts non-hex, contacts delete dialog dead code, collab `closeCollabDocument` missing await                                                                                                                           |

---

## Domain Review Index

| Review                              | Domain                               | Critical | Important | Minor | File                                                            |
|-------------------------------------|--------------------------------------|----------|-----------|-------|-----------------------------------------------------------------|
| [BE Core](BE_core.md)               | Auth, Home, Config, Setup, SSE       | 2        | 7         | 12    | `apps/api/src/lib/{core,config,auth,home,setup,org,team,user}/` |
| [BE Drive](BE_drive.md)             | Drive, Mount, Storage, ACL, Previews | 2        | 6         | 6     | `apps/api/src/lib/{drive,mount,storage,preview,share,shared}/`  |
| [BE Mail](BE_mail.md)               | Maildir, EML, SMTP                   | 3        | 9         | 11    | `apps/api/src/lib/mail/`                                        |
| [BE Contacts](BE_contacts.md)       | Contact management                   | 0        | 5         | 11    | `apps/api/src/lib/contacts/`                                    |
| [BE Calendar](BE_calendar.md)       | Calendar, RRULE, sharing, invites    | 3        | 9         | 8     | `apps/api/src/lib/calendar/`                                    |
| [BE Chat](BE_chat.md)               | Chat rooms, slash commands           | 2        | 7         | 7     | `apps/api/src/lib/chat/`                                        |
| [BE Collab](BE_collab.md)           | Yjs, WebSocket, real-time editing    | 1        | 5         | 6     | `apps/api/src/lib/collab/`                                      |
| [FE Shared](FE_shared.md)           | packages/lib + packages/ui           | 3        | 11        | 8     | `packages/{lib,ui}/`                                            |
| [FE Drive](FE_drive.md)             | Drive app                            | 3        | 8         | 13    | `apps/drive/`                                                   |
| [FE Mail](FE_mail.md)               | Mail app                             | 3        | 9         | 12    | `apps/mail/`                                                    |
| [FE Contacts](FE_contacts.md)       | Contacts app                         | 4        | 7         | 16    | `apps/contacts/`                                                |
| [FE Calendar](FE_calendar.md)       | Calendar app                         | 3        | 10        | 14    | `apps/calendar/`                                                |
| [FE Chat](FE_chat.md)               | Chat app                             | 2        | 5         | 9     | `apps/chat/`                                                    |
| [FE Collab](FE_collab.md)           | Docs, Stickies, Slides, Sheets       | 2        | 12        | 9     | `apps/{docs,stickies,slides,sheets}/`                           |
| [FE Space](FE_space.md)             | User settings, profile               | 1        | 6         | 10    | `apps/space/`                                                   |
| [FE People](FE_people.md)           | Org/team admin                       | 2        | 7         | 10    | `apps/people/`                                                  |
| [FE Setup](FE_setup.md)             | Setup wizard, index/landing          | 1        | 6         | 9     | `apps/{setup,index}/`                                           |
| [FE Sheets Deep](FE_sheets_deep.md) | Sheets + fortune-sheet               | 3        | 7         | 10    | `apps/sheets/`, `packages/fortune-sheet/`                       |

**Totals:** 40 critical, ~136 important, ~171 minor issues across 18 reviews.

---

## All Critical Issues

Every critical issue from every review, organized by impact category.

### Security and Access Control

| # | Issue                                                                                                                                                                                                                                     | Location                                                                                          | Review                           |
|---|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------|----------------------------------|
| 1 | **Unauthenticated mail delivery with no rate limiting** — `POST /mail/deliver/:to` accepts arbitrary EML from any caller with no auth, rate limit, IP allowlist, size limit, or quota enforcement.                                        | [`apps/api/src/routes/mail.ts:28`](../apps/api/src/routes/mail.ts)                                | [BE Mail](BE_mail.md) C1         |
| 2 | **`getSharedDrive` does not validate caller access to ownerId** — any authenticated user can create a `SharedDrive` for any other user. `listMounts()` leaks mount metadata without permission check.                                     | [`apps/api/src/lib/drive/get-drive.ts:12-24`](../apps/api/src/lib/drive/get-drive.ts)             | [BE Drive](BE_drive.md) #1       |
| 3 | **`SharedDrive.movePath` skips write check on target parent** — source permission is checked, target is not. Users can move files into folders they have read-only access to.                                                             | [`apps/api/src/lib/drive/sharedDrive.ts:193-198`](../apps/api/src/lib/drive/sharedDrive.ts)       | [BE Drive](BE_drive.md) #2       |
| 4 | **`ownerId` in mail routes accepted but never validated** — all authenticated mail routes ignore the URL parameter and operate on the session user's Home. Cross-user isolation test reveals Bob can POST to Alice's ownerId and get 200. | [`apps/api/src/routes/mail.ts`](../apps/api/src/routes/mail.ts)                                   | [BE Mail](BE_mail.md) C2         |
| 5 | **`resolveCalendarForEvents` hardcodes `write` for team members** — bypasses share-level restrictions. Admins setting read-only or free-busy permissions see no effect.                                                                   | [`apps/api/src/lib/calendar/get-calendar.ts:29-35`](../apps/api/src/lib/calendar/get-calendar.ts) | [BE Calendar](BE_calendar.md) C1 |
| 6 | **Calendar `access` endpoint leaks share list to free-busy users** — users with free-busy access can see all shares including emails and permission levels.                                                                               | [`apps/api/src/routes/calendar.ts:165-170`](../apps/api/src/routes/calendar.ts)                   | [BE Calendar](BE_calendar.md) C3 |

### SSE Content Leaks

| # | Issue                                                                                                                                                                                           | Location                                                                    | Review                   |
|---|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------|--------------------------|
| 7 | **`deleteMessage` SSE event leaks pre-deletion content** — the `existing` object retains original content instead of the cleared empty string. Also leaks whisper content for deleted whispers. | [`apps/api/src/lib/chat/chat.ts:224`](../apps/api/src/lib/chat/chat.ts)     | [BE Chat](BE_chat.md) #1 |
| 8 | **`editMessage` SSE event leaks whisper content** — no whisper filtering on edit events, unlike the fixed post path. All SSE subscribers see edited whisper content.                            | [`apps/api/src/lib/chat/chat.ts:190-196`](../apps/api/src/lib/chat/chat.ts) | [BE Chat](BE_chat.md) #2 |

### Data Integrity and Core Bugs

| #  | Issue                                                                                                                                                                                                                      | Location                                                                                                                               | Review                           |
|----|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------|----------------------------------|
| 9  | **Race condition in Home cleanup/recreation** — `touch()` timeout removes singleton from Map synchronously but `destruct()` is async and not awaited. Two Home instances can exist concurrently with concurrent DB access. | [`apps/api/src/lib/home/home.ts:78-87`](../apps/api/src/lib/home/home.ts), [`get-home.ts:62-64`](../apps/api/src/lib/home/get-home.ts) | [BE Core](BE_core.md) C1         |
| 10 | **`Home.destruct()` opens never-used databases** — managed database map stores singleton factories that trigger during destruct even for databases never accessed.                                                         | [`apps/api/src/lib/home/home.ts:151-158`](../apps/api/src/lib/home/home.ts)                                                            | [BE Core](BE_core.md) C2         |
| 11 | **`deleteCalendar` orphans attendee invitations** — cascade-deletes events without propagating cancellations to attendees. Stale linked invitation copies persist in other users' databases.                               | [`apps/api/src/lib/calendar/calendar.ts:245-252`](../apps/api/src/lib/calendar/calendar.ts)                                            | [BE Calendar](BE_calendar.md) C2 |
| 12 | **Missing `await` on `closeCollabDocument`** — fire-and-forget async call in `unsubscribe()`. Skips database close on S3 backends, swallows errors.                                                                        | [`apps/api/src/lib/collab/collabDocument.ts:265`](../apps/api/src/lib/collab/collabDocument.ts)                                        | [BE Collab](BE_collab.md) #1     |
| 13 | **`readMessage()` returns stale file size** — `BunFile.size` captured at object creation time, not at read time. Returns 0 or stale values for recently-written files.                                                     | [`apps/api/src/lib/mail/maildir.ts`](../apps/api/src/lib/mail/maildir.ts)                                                              | [BE Mail](BE_mail.md) C3         |

### Frontend — Broken Functionality

| #  | Issue                                                                                                                                                                                                | Location                                                                                           | Review                           |
|----|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------|----------------------------------|
| 14 | **Mail toolbar Send bypasses form inputs** — sends stale cached data instead of user's current edits. Crashes for new compose (null as EmailDraftType).                                              | [`apps/mail/src/`](../apps/mail/src/)                                                              | [FE Mail](FE_mail.md) #2         |
| 15 | **Missing `await` on `handleNewDraftEmail`** in reply/forward — violates the project's #1 critical rule about awaiting async calls.                                                                  | [`apps/mail/src/routes/_auth.$filterType.$filterId.tsx:167,186,199`](../apps/mail/src/routes/)     | [FE Mail](FE_mail.md) #1         |
| 16 | **Mail mutation handlers have no error feedback** — 5 `mutateAsync` calls without try/catch or onError.                                                                                              | [`apps/mail/src/routes/_auth.$filterType.$filterId.tsx`](../apps/mail/src/routes/)                 | [FE Mail](FE_mail.md) #3         |
| 17 | **Contacts delete from toolbar has no confirmation** — immediate data loss on click.                                                                                                                 | [`apps/contacts/src/`](../apps/contacts/src/)                                                      | [FE Contacts](FE_contacts.md) C1 |
| 18 | **Contacts batch delete fires N parallel mutations with N navigations** — race condition between parallel deletes and navigates.                                                                     | [`apps/contacts/src/`](../apps/contacts/src/)                                                      | [FE Contacts](FE_contacts.md) C2 |
| 19 | **Contacts batch label toggle fires mutations in tight loop with no error handling**                                                                                                                 | [`apps/contacts/src/`](../apps/contacts/src/)                                                      | [FE Contacts](FE_contacts.md) C3 |
| 20 | **Contacts drag-and-drop label assignment — same fire-and-forget pattern**                                                                                                                           | [`apps/contacts/src/`](../apps/contacts/src/)                                                      | [FE Contacts](FE_contacts.md) C4 |
| 21 | **`RecurrencePicker` in edit dialog receives UTC-parsed date** — `new Date(startDate)` without `T00:00:00`. Wrong weekday presets in western timezones. Create dialog was fixed but edit was missed. | [`apps/calendar/src/components/edit-event-dialog.tsx`](../apps/calendar/src/components/)           | [FE Calendar](FE_calendar.md) C1 |
| 22 | **"This and following" delete is a no-op for exceptions** — exceptions don't carry the parent RRULE, so truncation logic is unreachable.                                                             | [`apps/calendar/src/components/event-detail-dialog.tsx:167-174`](../apps/calendar/src/components/) | [FE Calendar](FE_calendar.md) C2 |
| 23 | **Setup wizard uses wrong env variable** — reads `VITE_API_URL` instead of `VITE_API_HOST`. Breaks in Docker/production.                                                                             | [`apps/setup/src/components/setup-wizard.tsx:24`](../apps/setup/src/components/setup-wizard.tsx)   | [FE Setup](FE_setup.md) #1       |

### Frontend — Type Safety and Cache Integrity

| #  | Issue                                                                                                                                                              | Location                                                                                             | Review                                                         |
|----|--------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------|----------------------------------------------------------------|
| 24 | **`useCreateChat` passes `mountId` where `ownerId` expected** — `invalidateItemCreated` targets wrong owner, folder contents won't refresh.                        | [`packages/lib/src/core/drive/hooks/`](../packages/lib/src/core/drive/hooks/)                        | [FE Shared](FE_shared.md) #1                                   |
| 25 | **UUID validation regex accepts non-hex characters** — `parseOwnerId` uses `a-Z` instead of `a-f`, accepting any letter as hex digit.                              | [`packages/lib/src/types/owner.ts`](../packages/lib/src/types/owner.ts)                              | [FE Shared](FE_shared.md) #2                                   |
| 26 | **Calendar query keys omit `ownerId`** — `calendarList`, `eventRange`, `sharedCalendars` cause cross-context cache collisions between personal and team calendars. | [`packages/lib/src/core/calendar/hooks/`](../packages/lib/src/core/calendar/hooks/)                  | [FE Shared](FE_shared.md) #3, [FE Calendar](FE_calendar.md) C3 |
| 27 | **Shared route `uid` not validated in Drive** — detail panel broken for "Shared With Me" items on non-default mounts.                                              | [`apps/drive/src/routes/_auth.shared.$to.tsx`](../apps/drive/src/routes/)                            | [FE Drive](FE_drive.md) C1                                     |
| 28 | **`markDirty` forward-reference in MarkdownEditor** — works by accident (async callback), fragile against Tiptap updates.                                          | [`apps/drive/src/components/editor/markdown-editor.tsx:75-93`](../apps/drive/src/components/editor/) | [FE Drive](FE_drive.md) C2                                     |
| 29 | **`handleMovePath` has no error handling** — `mutateAsync` without try/catch or error toast.                                                                       | [`apps/drive/src/`](../apps/drive/src/)                                                              | [FE Drive](FE_drive.md) C3                                     |

### Frontend — Chat and Collab

| #  | Issue                                                                                                                                                             | Location                                                                                           | Review                       |
|----|-------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------|------------------------------|
| 30 | **Missing `error` case in command dispatch** — malformed `/whisper badformat` sent as public message, leaking intended private content.                           | [`packages/lib/src/core/chat/hooks/use-chat-room.ts:89-137`](../packages/lib/src/core/chat/hooks/) | [FE Chat](FE_chat.md) #1     |
| 31 | **No error handling in `handleSendMessage`** — three `.mutateAsync()` calls with zero try/catch. Input cleared before send, so text is lost on failure.           | [`packages/lib/src/core/chat/hooks/use-chat-room.ts:69-141`](../packages/lib/src/core/chat/hooks/) | [FE Chat](FE_chat.md) #2     |
| 32 | **Docs comment creation swallows errors** — `try/finally` with no `catch` and no `toast.error()`.                                                                 | [`apps/docs/src/components/comments/comment-dialog.tsx`](../apps/docs/src/components/)             | [FE Collab](FE_collab.md) C1 |
| 33 | **Revision restore pushes raw JSON into Y.Array** — stickies/slides restore logic doesn't use `jsonToYType()` for array elements, breaking collaborative editing. | [`apps/stickies/src/components/stickies/board.tsx:108`](../apps/stickies/src/components/)          | [FE Collab](FE_collab.md) C2 |

### Frontend — Space, People, Sheets

| #  | Issue                                                                                                                                                   | Location                                                                                                        | Review                            |
|----|---------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------|-----------------------------------|
| 34 | **2FA toggle is cosmetic** — `enableTwoFactor` changes toast text but is never sent to the backend. User sees "disabled" while 2FA is actually enabled. | [`apps/space/src/`](../apps/space/src/)                                                                         | [FE Space](FE_space.md) C1        |
| 35 | **Keyboard navigation selects wrong member** — `activeId` uses membership ID but `getId` returns user UUID. Selection shows empty detail pane.          | [`apps/people/src/components/people/members-list.tsx:79-83`](../apps/people/src/components/)                    | [FE People](FE_people.md) #1      |
| 36 | **Calendar shares not cleaned up when disabling team calendar** — stale elevated permissions resurface when re-enabled.                                 | [`apps/people/src/components/people/team-detail.tsx:250-253`](../apps/people/src/components/)                   | [FE People](FE_people.md) #2      |
| 37 | **Stale closure in `onPaste`** — reads `context` outside Immer recipe, potentially pasting at wrong positions.                                          | [`packages/fortune-sheet/src/components/Workbook/index.tsx:691-787`](../packages/fortune-sheet/src/components/) | [FE Sheets](FE_sheets_deep.md) #1 |
| 38 | **`deleteSheet` sets `currentSheetId` to `undefined as string`** — when no visible sheets remain after deletion.                                        | [`packages/fortune-sheet/src/core/modules/sheet.ts:183`](../packages/fortune-sheet/src/core/modules/)           | [FE Sheets](FE_sheets_deep.md) #2 |
| 39 | **Unbounded `Y.Array('ops')` growth** — ops never compacted or cleared, causing monotonic memory growth.                                                | [`apps/sheets/src/hooks/use-sheet.ts:137-139`](../apps/sheets/src/hooks/)                                       | [FE Sheets](FE_sheets_deep.md) #3 |
| 40 | **Mail query keys missing `ownerId`** — cross-context cache collisions possible.                                                                        | [`packages/lib/src/core/mail/hooks/`](../packages/lib/src/core/mail/hooks/)                                     | [FE Mail](FE_mail.md) #6          |

---

## Systemic Patterns Across Multiple Domains

### 1. Missing error handling on frontend mutations

The most pervasive issue across the entire frontend. CLAUDE.md explicitly requires "every mutation needs error
feedback", but multiple apps have `mutateAsync` calls with no try/catch, no onError callback, and no toast notification:

- **Mail**: 5 handlers, 0 try/catch ([FE Mail](FE_mail.md) #3)
- **Chat**: 3 `mutateAsync` calls, 0 try/catch ([FE Chat](FE_chat.md) #2)
- **Calendar**: 0 `toast()` calls in entire app ([FE Calendar](FE_calendar.md) I3-I5)
- **Contacts**: label mutations, drag-and-drop, batch operations ([FE Contacts](FE_contacts.md) C3, C4, I1-I3)
- **Collab**: comment creation ([FE Collab](FE_collab.md) C1)
- **Drive**: `handleMovePath` ([FE Drive](FE_drive.md) C3)

**Fix pattern**: Wrap every `mutateAsync` in `try { await mutateAsync(...) } catch { toast.error("...") }`.

### 2. `ownerId` parameter ignored in backend routes

Multiple route files accept `:ownerId` in the URL but silently use the authenticated user's ID instead.
Security-correct (prevents spoofing) but creates a misleading API contract and prevents team-context functionality:

- **Mail**: all routes ([BE Mail](BE_mail.md) C2)
- **Contacts**: all routes ([BE Contacts](BE_contacts.md) #2)
- **SSE**: SSE route ([BE Core](BE_core.md) I1)
- **Calendar**: `/shared` endpoint ([BE Calendar](BE_calendar.md) M1)
- **Chat**: SSE route ([BE Chat](BE_chat.md) #16)

**Fix**: Either validate `ownerId === user.id || isTeamMember(ownerId)` with 403 on mismatch, or remove the parameter
from routes where it serves no purpose.

### 3. Query keys missing `ownerId` (frontend cache collisions)

Calendar, mail, and contacts query keys omit `ownerId`, causing stale cached data from the wrong owner when switching
between personal and team contexts:

- **Calendar**: `calendarList`, `eventRange`, `sharedCalendars` ([FE Shared](FE_shared.md)
  #3, [FE Calendar](FE_calendar.md) C3)
- **Mail**: all mail query keys ([FE Mail](FE_mail.md) #6)
- **Contacts**: contact and label keys ([FE Contacts](FE_contacts.md) I7)
- **Chat**: already fixed (was reported in previous review but verified as correct now)

### 4. Hardcoded colors break dark mode

Components across multiple apps use hardcoded Tailwind colors (`text-gray-500`, `bg-blue-50`, `border-blue-500`,
`#3b82f6`) instead of theme tokens:

- **Drive**: 242 lines of hardcoded light-mode CSS in Tiptap editor ([FE Drive](FE_drive.md) I4)
- **Collab**: `border-blue-500`, `bg-white`, `text-blue-600`, `#3b82f6`, `#9810fa` across docs and
  slides ([FE Collab](FE_collab.md) I2)
- **Space**: password strength meter, app cards ([FE Space](FE_space.md) I5, I6)
- **Contacts**: `text-blue-600` ([FE Contacts](FE_contacts.md) I6)
- **Shared UI**: usage.tsx, mount-form.tsx ([FE Shared](FE_shared.md) #12, #13)
- **Setup/Index**: both apps ([FE Setup](FE_setup.md) #15)

### 5. Fire-and-forget async calls (missing `await`)

Still present after several were fixed since the last review:

- `closeCollabDocument` in collab unsubscribe ([BE Collab](BE_collab.md) #1)
- `addContact` in contacts init ([BE Contacts](BE_contacts.md) #3)
- `cleanupAvatarImages` in contacts init ([BE Contacts](BE_contacts.md) #4)
- Propagation in calendar (inconsistent `.catch` handling) ([BE Calendar](BE_calendar.md) I4)
- `handleNewDraftEmail` in mail reply/forward ([FE Mail](FE_mail.md) #1)

### 6. `interface` used instead of `type` everywhere

CLAUDE.md specifies `type` over `interface` except when methods are needed. Found across nearly every app's
`__root.tsx`, component props, and type definitions. Not a correctness issue but a consistent style violation.

### 7. Fortune-sheet technical debt

The forked spreadsheet UI carries significant legacy burden:

- 81 `@ts-ignore` directives, 81 `as any` casts, ~700 Chinese comments
- 327 `luckysheet-*` class names, 5 CSS files (1,740 lines)
- Stale closure in `onPaste`, unbounded Y.Array growth, `deleteSheet` crash

---

## Strengths Worth Preserving

- **Architectural discipline** — hooks in `packages/lib`, never in apps. Universally followed across all 14 apps.
- **`as any` cleanup** — down from 21 casts to 0 in `packages/lib/src/` since the previous review. Eden Treaty type
  safety is now fully preserved in the shared layer.
- **Query key pattern** — consistent hierarchical key factories with exported invalidation functions across all domains.
- **SSE event system** — clean emit/subscribe/invalidate pattern with domain-specific handlers. Broadcast architecture
  in collab is now correct (both updates and awareness).
- **ManagedDatabase** — WAL mode, busy timeout, versioned migrations, dirty tracking, clean lifecycle. Well-designed and
  battle-tested.
- **Maildir compliance** — correct Maildir++ conventions with Dovecot coexistence support, atomic delivery, keyword
  preservation.
- **Path traversal protection** — `LocalKeyStorage` and `LocalFilesystem` both use `path.resolve` + `startsWith` checks.
  Maildir has dual-layer validation. Previously reported gaps were false positives.
- **Singleton lifecycle** — `createAsyncSingleton` correctly handles retry-on-failure (previously reported as broken,
  verified as correct).
- **Test coverage** — solid integration tests across core, drive, mail, contacts, calendar (4 files, ~70 tests), chat (
  728 lines), and collab. Calendar timezone handling has dedicated DST tests.
- **Conflict resolution** — Drive editor's `useEditorSave` with optimistic concurrency, Cmd+S, beforeunload, and
  3-option conflict dialog is production-quality.
- **ACL enforcement in chat** — `SharedDrive.getChat()` enforces `canRead`, all mutating routes check `canWrite`.
- **Collab broadcast** — Server-side update and awareness broadcasting now works correctly (was previously reported as
  missing).
- **Name-based media references** — Eigendocs reference images/chats by filesystem name, surviving move/rename
  operations.

---

## Recommended Fix Order

### Phase 1: Security (highest impact, lowest effort)

These are access control and data leak issues that affect production safety.

| # | Issue                                                                                 | Effort  | Review                           |
|---|---------------------------------------------------------------------------------------|---------|----------------------------------|
| 1 | **Harden `/mail/deliver/:to`** — add localhost-only restriction, rate limit, size cap | Small   | [BE Mail](BE_mail.md) C1         |
| 2 | **Validate `ownerId` in `getSharedDrive`** — check caller is owner or team member     | Small   | [BE Drive](BE_drive.md) #1       |
| 3 | **Add target-parent write check to `SharedDrive.movePath`**                           | Small   | [BE Drive](BE_drive.md) #2       |
| 4 | **Strip content from chat delete SSE events**                                         | Small   | [BE Chat](BE_chat.md) #1         |
| 5 | **Filter whisper content from chat edit SSE events**                                  | Small   | [BE Chat](BE_chat.md) #2         |
| 6 | **Fix `parseOwnerId` regex** — change `a-Z` to `a-f`                                  | Trivial | [FE Shared](FE_shared.md) #2     |
| 7 | **Gate calendar `access` endpoint** behind write permission check                     | Small   | [BE Calendar](BE_calendar.md) C3 |
| 8 | **Resolve actual team calendar permissions** instead of hardcoding `write`            | Small   | [BE Calendar](BE_calendar.md) C1 |

### Phase 2: Data Integrity (prevents data loss and corruption)

| #  | Issue                                                                                | Effort  | Review                            |
|----|--------------------------------------------------------------------------------------|---------|-----------------------------------|
| 9  | **Fix Home cleanup race condition** — await `destruct()` before removing from Map    | Medium  | [BE Core](BE_core.md) C1          |
| 10 | **Fix `Home.destruct()` opening unused databases** — check if singleton was resolved | Medium  | [BE Core](BE_core.md) C2          |
| 11 | **Await `closeCollabDocument`** in collab unsubscribe                                | Trivial | [BE Collab](BE_collab.md) #1      |
| 12 | **Propagate cancellations before `deleteCalendar`** cascade                          | Medium  | [BE Calendar](BE_calendar.md) C2  |
| 13 | **Fix `readMessage()` stale file size** — read size after `text()`                   | Small   | [BE Mail](BE_mail.md) C3          |
| 14 | **Fix revision restore Y.Array** — use `jsonToYType()` for array elements            | Small   | [FE Collab](FE_collab.md) C2      |
| 15 | **Compact `Y.Array('ops')`** in sheets — clear after applying to engine state        | Medium  | [FE Sheets](FE_sheets_deep.md) #3 |

### Phase 3: Broken Frontend Features (user-facing bugs)

| #  | Issue                                                                   | Effort  | Review                              |
|----|-------------------------------------------------------------------------|---------|-------------------------------------|
| 16 | **Fix mail toolbar Send** — read from form inputs, not stale cache      | Medium  | [FE Mail](FE_mail.md) #2            |
| 17 | **Add `await` to mail reply/forward handlers**                          | Trivial | [FE Mail](FE_mail.md) #1            |
| 18 | **Add error handling to all mail mutations**                            | Small   | [FE Mail](FE_mail.md) #3            |
| 19 | **Fix `RecurrencePicker` UTC date in edit dialog** — append `T00:00:00` | Trivial | [FE Calendar](FE_calendar.md) C1    |
| 20 | **Fix "This and following" delete for exceptions**                      | Medium  | [FE Calendar](FE_calendar.md) C2    |
| 21 | **Add `ownerId` to calendar query keys**                                | Small   | [FE Calendar](FE_calendar.md) C3    |
| 22 | **Add `ownerId` to mail query keys**                                    | Small   | [FE Mail](FE_mail.md) #6            |
| 23 | **Fix `useCreateChat` ownerId/mountId swap**                            | Trivial | [FE Shared](FE_shared.md) #1        |
| 24 | **Fix setup wizard env variable** — `VITE_API_HOST`                     | Trivial | [FE Setup](FE_setup.md) #1          |
| 25 | **Fix contacts delete — add confirmation dialog**                       | Small   | [FE Contacts](FE_contacts.md) C1    |
| 26 | **Fix contacts batch operations** — sequential with error handling      | Small   | [FE Contacts](FE_contacts.md) C2-C4 |
| 27 | **Fix 2FA toggle** — send `enableTwoFactor` to backend                  | Small   | [FE Space](FE_space.md) C1          |
| 28 | **Fix People keyboard navigation ID mismatch**                          | Trivial | [FE People](FE_people.md) #1        |
| 29 | **Fix team calendar share cleanup on disable**                          | Small   | [FE People](FE_people.md) #2        |

### Phase 4: Error Handling Sweep (systemic)

Add `try { await mutateAsync(...) } catch { toast.error("...") }` across all apps:

| App      | Mutations needing error handling     | Review                              |
|----------|--------------------------------------|-------------------------------------|
| Mail     | 5 handlers                           | [FE Mail](FE_mail.md) #3            |
| Chat     | 3 handlers                           | [FE Chat](FE_chat.md) #2            |
| Calendar | All mutation calls (0 toasts in app) | [FE Calendar](FE_calendar.md) I3-I5 |
| Contacts | Label mutations, drag-and-drop       | [FE Contacts](FE_contacts.md) I1-I3 |
| Drive    | `handleMovePath`                     | [FE Drive](FE_drive.md) C3          |
| Collab   | Comment creation                     | [FE Collab](FE_collab.md) C1        |

Also add the `error` case to the chat command dispatch switch ([FE Chat](FE_chat.md) #1).

### Phase 5: Query Key and Cache Correctness

| App      | Keys needing `ownerId`                          | Review                           |
|----------|-------------------------------------------------|----------------------------------|
| Calendar | `calendarList`, `eventRange`, `sharedCalendars` | [FE Calendar](FE_calendar.md) C3 |
| Mail     | All mail query keys                             | [FE Mail](FE_mail.md) #6         |
| Contacts | Contact and label keys                          | [FE Contacts](FE_contacts.md) I7 |

### Phase 6: Ongoing Code Quality

- **Dark mode audit** — replace all hardcoded colors with theme tokens across Drive editor CSS, collab components,
  Space, Contacts, Setup/Index
- **`ownerId` validation audit** — either validate or remove from Mail, Contacts, SSE, Calendar, Chat routes
- **Fortune-sheet cleanup** — `@ts-ignore` → `@ts-expect-error`, reduce `as any`, translate Chinese comments, rename
  `luckysheet-*` classes
- **Style consistency** — `interface` → `type` across all apps (~60+ instances), remove `"use client"` directives

---

## Test Coverage Gaps

Key areas lacking test coverage that would have caught critical bugs:

| Gap                                                | Would have caught                     | Review                        |
|----------------------------------------------------|---------------------------------------|-------------------------------|
| `SharedDrive` ownerId validation test              | Access control bypass (#2)            | [BE Drive](BE_drive.md)       |
| Chat SSE content assertions                        | Delete/edit content leaks (#7, #8)    | [BE Chat](BE_chat.md)         |
| Home concurrent cleanup test                       | Race condition (#9)                   | [BE Core](BE_core.md)         |
| Calendar permission enforcement test               | Team permission bypass (#5)           | [BE Calendar](BE_calendar.md) |
| Mail delivery rate/auth test                       | Unauthenticated abuse (#1)            | [BE Mail](BE_mail.md)         |
| Collab document close after disconnect             | Missing await (#12)                   | [BE Collab](BE_collab.md)     |
| S3 storage backend tests                           | S3 preview/thumbnail failures         | [BE Drive](BE_drive.md)       |
| WebSocket tests gated behind `if (status !== 101)` | All WS behavioral tests skip silently | [BE Collab](BE_collab.md)     |

---

## Review File Index

All review files are in the `codereviews/` directory:

| File                                     | Lines | Domain                                                  |
|------------------------------------------|-------|---------------------------------------------------------|
| [`BE_core.md`](BE_core.md)               | 473   | Auth, Home, Config, Setup, SSE, Singleton               |
| [`BE_drive.md`](BE_drive.md)             | 371   | Drive, Mount, Storage, ACL, Previews, Share Propagation |
| [`BE_mail.md`](BE_mail.md)               | 592   | Maildir, EML, SMTP                                      |
| [`BE_contacts.md`](BE_contacts.md)       | 366   | Contact management                                      |
| [`BE_calendar.md`](BE_calendar.md)       | 482   | Calendar, RRULE, sharing, invites                       |
| [`BE_chat.md`](BE_chat.md)               | 394   | Chat rooms, slash commands, whispers                    |
| [`BE_collab.md`](BE_collab.md)           | 441   | Yjs, WebSocket, real-time editing                       |
| [`FE_shared.md`](FE_shared.md)           | 370   | packages/lib + packages/ui                              |
| [`FE_drive.md`](FE_drive.md)             | 566   | Drive app                                               |
| [`FE_mail.md`](FE_mail.md)               | 589   | Mail app                                                |
| [`FE_contacts.md`](FE_contacts.md)       | 550   | Contacts app                                            |
| [`FE_calendar.md`](FE_calendar.md)       | 382   | Calendar app                                            |
| [`FE_chat.md`](FE_chat.md)               | 420   | Chat app                                                |
| [`FE_collab.md`](FE_collab.md)           | 467   | Docs, Stickies, Slides, Sheets                          |
| [`FE_space.md`](FE_space.md)             | 377   | User settings, profile, security                        |
| [`FE_people.md`](FE_people.md)           | 461   | Org/team admin                                          |
| [`FE_setup.md`](FE_setup.md)             | 390   | Setup wizard, index/landing                             |
| [`FE_sheets_deep.md`](FE_sheets_deep.md) | 423   | Sheets + fortune-sheet                                  |
