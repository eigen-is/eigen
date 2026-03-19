# Code Review Fix Progress

Tracking fixes from the [2026-03-19 code review](OVERVIEW.md). Updated as work progresses.

---

## Phase 1: Security (8 items)

| # | Issue                                            | Status       | Notes                                                                                                                                                                                                                                     |
|---|--------------------------------------------------|--------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 1 | Harden `/mail/deliver/:to`                       | **Deferred** | Postfix delivers locally. 25 MB size limit exists. TODO comment + IP allowlist/rate limit noted for pre-production.                                                                                                                       |
| 2 | Validate `ownerId` in `getSharedDrive`           | **Partial**  | SharedDrive now blocks owner-only methods (`getMountConfig`, `addMount`, `removeMount`, `receiveACLChange`, shared-path queries). `getSharedDrive` itself still creates SharedDrive for any ownerId — ACL enforcement happens per-method. |
| 3 | `SharedDrive.movePath` target-parent write check | **Fixed**    | Added `canWrite` check on `targetParentId` in `sharedDrive.ts`.                                                                                                                                                                           |
| 4 | Chat `deleteMessage` SSE leaks content           | Open         |                                                                                                                                                                                                                                           |
| 5 | Chat `editMessage` SSE leaks whisper content     | Open         |                                                                                                                                                                                                                                           |
| 6 | Fix `parseOwnerId` regex `a-Z` → `a-f`           | Open         |                                                                                                                                                                                                                                           |
| 7 | Gate calendar `access` endpoint                  | Open         | Needs verification — may be false positive.                                                                                                                                                                                               |
| 8 | Team calendar permission hardcoding              | Open         | Needs verification — may be false positive.                                                                                                                                                                                               |

## Phase 2: Data Integrity (7 items)

| #  | Issue                                         | Status | Notes |
|----|-----------------------------------------------|--------|-------|
| 9  | Home cleanup race condition                   | Open   |       |
| 10 | `Home.destruct()` opens unused databases      | Open   |       |
| 11 | Await `closeCollabDocument` in unsubscribe    | Open   |       |
| 12 | `deleteCalendar` orphans attendee invitations | Open   |       |
| 13 | `readMessage()` stale file size               | Open   |       |
| 14 | Revision restore Y.Array bug                  | Open   |       |
| 15 | Unbounded `Y.Array('ops')` in sheets          | Open   |       |

## Phase 3: Broken Frontend Features (14 items)

| #  | Issue                                      | Status    | Notes                                                  |
|----|--------------------------------------------|-----------|--------------------------------------------------------|
| 16 | Mail toolbar Send sends stale data         | Open      |                                                        |
| 17 | Missing `await` on mail reply/forward      | Open      |                                                        |
| 18 | Mail mutations lack error handling         | Open      |                                                        |
| 19 | `RecurrencePicker` UTC date in edit dialog | Open      |                                                        |
| 20 | "This and following" delete no-op          | Open      |                                                        |
| 21 | Calendar query keys missing `ownerId`      | Open      |                                                        |
| 22 | Mail query keys missing `ownerId`          | Open      |                                                        |
| 23 | `useCreateChat` ownerId/mountId swap       | Open      |                                                        |
| 24 | Setup wizard wrong env variable            | Open      |                                                        |
| 25 | Contacts delete no confirmation            | Open      |                                                        |
| 26 | Contacts batch operations fire-and-forget  | Open      |                                                        |
| 27 | 2FA toggle cosmetic                        | **Fixed** | Removed toggle entirely — `verifyTotp` always enables. |
| 28 | People keyboard nav ID mismatch            | Open      |                                                        |
| 29 | Team calendar share cleanup on disable     | Open      |                                                        |

## Phase 4: Error Handling Sweep

| App      | Status | Notes                                             |
|----------|--------|---------------------------------------------------|
| Mail     | Open   | 5 handlers need try/catch                         |
| Chat     | Open   | 3 handlers + add `error` case to command dispatch |
| Calendar | Open   | 0 toast calls in entire app                       |
| Contacts | Open   | Label mutations, drag-and-drop                    |
| Drive    | Open   | `handleMovePath`                                  |
| Collab   | Open   | Comment creation                                  |

## Phase 5: Query Key and Cache Correctness

| App      | Status | Notes                                           |
|----------|--------|-------------------------------------------------|
| Calendar | Open   | `calendarList`, `eventRange`, `sharedCalendars` |
| Mail     | Open   | All mail query keys                             |
| Contacts | Open   | Contact and label keys                          |

## Phase 6: Ongoing Code Quality

| Task                           | Status      | Notes                                                                                                                      |
|--------------------------------|-------------|----------------------------------------------------------------------------------------------------------------------------|
| Dark mode audit                | Open        | Drive editor CSS, collab, Space, Contacts, Setup/Index                                                                     |
| `ownerId` validation on routes | **Done**    | `requireSelf` on Mail, Contacts, SSE, Home, Space. Comments on Drive, Chat, Collab, Calendar explaining cross-owner model. |
| Fortune-sheet cleanup          | Open        | 81 `@ts-ignore`, 81 `as any`, ~700 Chinese comments                                                                        |
| `interface` → `type`           | **Partial** | Fixed in Space app. ~60+ remain across other apps.                                                                         |
| Remove `"use client"`          | **Partial** | Fixed in Space app. Others remain.                                                                                         |

---

## Additional Fixes (not in original review)

Fixes discovered and applied during this session that weren't in the original review:

| Fix                                                                                         | Files                                                             |
|---------------------------------------------------------------------------------------------|-------------------------------------------------------------------|
| `useUpdateACL` missing `mountId` — ACL edits on team drives hit wrong mount                 | `drive-access-dialog.tsx`, `use-chat-room.ts`                     |
| App icons: shared `icon` component in `apps.ts`, deduplicated from topbar                   | `apps.ts`, `topbar.tsx`, `_auth.index.tsx`                        |
| App colors: `style={{ color }}` with CSS variables instead of purged Tailwind classes       | `apps.ts`, `_auth.index.tsx`, `index/routes/index.tsx`            |
| `useMeContact` hook replaces imperative fetch in profile editor                             | `use-contacts.ts`, `profile-editor.tsx`                           |
| `UserAvatar` respects explicitly passed `imageUrl` (fixes avatar removal)                   | `user-avatar.tsx`                                                 |
| `validatePasswordStrength` moved to shared `packages/lib/src/validation/`                   | `password.ts`, `change-password.tsx`                              |
| `getCalendarAppUrl` added (Calendar was only app using raw `import.meta.env`)               | `api.ts`, `apps.ts`                                               |
| `requireSelf` / `requireTeamAccess` / `requireTeamAdmin` in `core/access.ts`                | `access.ts`, all route files                                      |
| Editor route refactored — logic moved to `Drive.getEditableContent` / `saveEditableContent` | `editor.ts`, `drive.ts`, `inline-edit.ts`, `sharedDrive.ts`       |
| Space routes now include `:ownerId` with `requireSelf`                                      | `space.ts`, `use-space-settings.ts`                               |
| Spoofing tests updated to expect 403                                                        | `contacts.test.ts`, `mail.test.ts`, `home.test.ts`, `sse.test.ts` |
