# Code Review Fix Progress

Tracking all critical issues from the [2026-03-19 code review](OVERVIEW.md). Numbers match the OVERVIEW's "All Critical
Issues" section. Updated as work progresses.

---

## Security and Access Control (#1-#6)

| # | Issue                                                      | Status       | Notes                                                                                              |
|---|------------------------------------------------------------|--------------|----------------------------------------------------------------------------------------------------|
| 1 | Unauthenticated mail delivery — no rate limiting           | **Deferred** | Postfix delivers locally. 25 MB limit exists. TODO comment added for IP allowlist + rate limiting. |
| 2 | `getSharedDrive` doesn't validate caller access to ownerId | **Partial**  | SharedDrive blocks owner-only methods. ACL enforcement per-method. `listMounts` still open.        |
| 3 | `SharedDrive.movePath` skips target-parent write check     | **Fixed**    | Added `canWrite` on `targetParentId`.                                                              |
| 4 | `ownerId` in mail routes never validated                   | **Fixed**    | `requireSelf` on all mail routes. Spoofing test expects 403.                                       |
| 5 | Calendar `resolveCalendarForEvents` hardcodes `write`      | Open         | Needs verification — may be false positive.                                                        |
| 6 | Calendar `access` endpoint leaks shares to free-busy users | Open         | Needs verification — may be false positive.                                                        |

## SSE Content Leaks (#7-#8)

| # | Issue                                          | Status | Notes |
|---|------------------------------------------------|--------|-------|
| 7 | `deleteMessage` SSE leaks pre-deletion content | Open   |       |
| 8 | `editMessage` SSE leaks whisper content        | Open   |       |

## Data Integrity and Core Bugs (#9-#13)

| #  | Issue                                         | Status | Notes |
|----|-----------------------------------------------|--------|-------|
| 9  | Home cleanup/recreation race condition        | Open   |       |
| 10 | `Home.destruct()` opens never-used databases  | Open   |       |
| 11 | `deleteCalendar` orphans attendee invitations | Open   |       |
| 12 | Missing `await` on `closeCollabDocument`      | Open   |       |
| 13 | `readMessage()` returns stale file size       | Open   |       |

## Frontend — Broken Functionality (#14-#23)

| #  | Issue                                            | Status | Notes |
|----|--------------------------------------------------|--------|-------|
| 14 | Mail toolbar Send bypasses form inputs           | Open   |       |
| 15 | Missing `await` on `handleNewDraftEmail`         | Open   |       |
| 16 | Mail mutations have no error feedback            | Open   |       |
| 17 | Contacts delete — no confirmation                | Open   |       |
| 18 | Contacts batch delete — N parallel mutations     | Open   |       |
| 19 | Contacts batch label — fire-and-forget           | Open   |       |
| 20 | Contacts drag-and-drop label — fire-and-forget   | Open   |       |
| 21 | `RecurrencePicker` UTC date in edit dialog       | Open   |       |
| 22 | "This and following" delete no-op for exceptions | Open   |       |
| 23 | Setup wizard wrong env variable                  | Open   |       |

## Frontend — Type Safety and Cache Integrity (#24-#29)

| #  | Issue                                                     | Status | Notes |
|----|-----------------------------------------------------------|--------|-------|
| 24 | `useCreateChat` passes `mountId` where `ownerId` expected | Open   |       |
| 25 | `parseOwnerId` regex accepts non-hex (`a-Z`)              | Open   |       |
| 26 | Calendar query keys omit `ownerId`                        | Open   |       |
| 27 | Drive shared route `uid` not validated                    | Open   |       |
| 28 | `markDirty` forward-reference in MarkdownEditor           | Open   |       |
| 29 | `handleMovePath` has no error handling                    | Open   |       |

## Frontend — Chat and Collab (#30-#33)

| #  | Issue                                         | Status | Notes |
|----|-----------------------------------------------|--------|-------|
| 30 | Missing `error` case in chat command dispatch | Open   |       |
| 31 | No error handling in `handleSendMessage`      | Open   |       |
| 32 | Docs comment creation swallows errors         | Open   |       |
| 33 | Revision restore pushes raw JSON into Y.Array | Open   |       |

## Frontend — Space, People, Sheets (#34-#40)

| #  | Issue                                              | Status    | Notes                                                  |
|----|----------------------------------------------------|-----------|--------------------------------------------------------|
| 34 | 2FA toggle is cosmetic                             | **Fixed** | Removed toggle entirely — `verifyTotp` always enables. |
| 35 | People keyboard nav ID mismatch                    | Open      |                                                        |
| 36 | Team calendar shares not cleaned up on disable     | Open      |                                                        |
| 37 | Fortune-sheet stale closure in `onPaste`           | Open      |                                                        |
| 38 | `deleteSheet` sets `currentSheetId` to `undefined` | Open      |                                                        |
| 39 | Unbounded `Y.Array('ops')` growth in sheets        | Open      |                                                        |
| 40 | Mail query keys missing `ownerId`                  | Open      |                                                        |

---

## Systemic Fixes (Phases 4-6 from OVERVIEW)

### Phase 4: Error Handling Sweep

| App      | Status | Notes                                             |
|----------|--------|---------------------------------------------------|
| Mail     | Open   | 5 handlers need try/catch                         |
| Chat     | Open   | 3 handlers + add `error` case to command dispatch |
| Calendar | Open   | 0 toast calls in entire app                       |
| Contacts | Open   | Label mutations, drag-and-drop                    |
| Drive    | Open   | `handleMovePath`                                  |
| Collab   | Open   | Comment creation                                  |

### Phase 5: Query Key and Cache Correctness

| App      | Status | Notes                                           |
|----------|--------|-------------------------------------------------|
| Calendar | Open   | `calendarList`, `eventRange`, `sharedCalendars` |
| Mail     | Open   | All mail query keys                             |
| Contacts | Open   | Contact and label keys                          |

### Phase 6: Ongoing Code Quality

| Task                           | Status      | Notes                                                                                                                      |
|--------------------------------|-------------|----------------------------------------------------------------------------------------------------------------------------|
| Dark mode audit                | Open        | Drive editor CSS, collab, Space, Contacts, Setup/Index                                                                     |
| `ownerId` validation on routes | **Done**    | `requireSelf` on Mail, Contacts, SSE, Home, Space. Comments on Drive, Chat, Collab, Calendar explaining cross-owner model. |
| Fortune-sheet cleanup          | Open        | 81 `@ts-ignore`, 81 `as any`, ~700 Chinese comments                                                                        |
| `interface` → `type`           | **Partial** | Fixed in Space app. ~60+ remain across other apps.                                                                         |
| Remove `"use client"`          | **Partial** | Fixed in Space app. Others remain.                                                                                         |

---

## Additional Fixes (discovered during this session)

| Fix                                                                                         | Files                                                             |
|---------------------------------------------------------------------------------------------|-------------------------------------------------------------------|
| `useUpdateACL` missing `mountId` — ACL edits on team drives hit wrong mount                 | `drive-access-dialog.tsx`, `use-chat-room.ts`                     |
| SharedDrive blocks owner-only methods + target-parent write check on `movePath`             | `sharedDrive.ts`                                                  |
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
| FE Space full cleanup (all C/I/M issues from review)                                        | All files in `apps/space/src/`                                    |
