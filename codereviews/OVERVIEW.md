# Eigen Codebase Review: Executive Overview

**Date:** 2026-03-18
**Scope:** Full-stack review across all domains -- 7 backend reviews, 11 frontend reviews (18 total)
**Methodology:** Deep-review agents per domain, cross-referenced and verified against source code

---

## Overall Assessment

The Eigen codebase is architecturally sound and impressively consistent for a project of this breadth. The monorepo structure is clean, the documented patterns (CLAUDE.md, docs/) are actually followed in practice, and the critical rule that all data hooks live in `packages/lib` is respected across every single app. The Home singleton hierarchy, ManagedDatabase lifecycle, SSE event system, and thin-route-to-domain-class pattern are well-designed and uniformly applied.

This deep review uncovered **19 critical issues**, **~80 important issues**, and **~120 minor issues** across the 18 review files. The most severe confirmed findings are: drive cache collisions from missing ownerId in query keys, several authorization bypasses in calendar and chat, and a class of missing-await bugs that silently break async control flow in multiple domains. There are also two broken navigation flows from MIME type typos, multiple broken frontend features (shared-items detail panes, mail attachments, waitlist form), and systemic type safety erosion from ~50+ `as any` casts in the shared hook layer.

None of these are architecturally difficult to fix. The codebase's clean structure makes targeted fixes straightforward. The main risk is the accumulated density of issues -- fixing them requires touching many files across many domains.

### Second-Round Corrections

Several first-round findings were challenged and re-evaluated in this deep review:

| Finding | Verdict | Detail |
|---------|---------|--------|
| Mail XSS via ShadowContent | **False positive** | Backend sanitizes all email HTML with `DOMPurify.sanitize()` at parse time (`mail-parse.ts:10`). The frontend component receives pre-sanitized HTML. Not a vulnerability. Downgraded to minor defense-in-depth observation. |
| Collab broadcast missing | **Downgraded to Important** | The server does NOT broadcast updates, but all frontend apps use `WebsocketProvider` with `resyncInterval: 5000` -- clients poll every 5 seconds and receive changes via sync handshake. Collab works with up to 5s latency, not "non-functional". Adding server-side broadcast would make it instant and reduce traffic. |
| Redundant WAL checkpoint in ManagedDatabase | **Corrected** | The second `wal_checkpoint(TRUNCATE)` in `close()` is NOT redundant -- `sync()` only checkpoints when dirty AND sync callbacks exist. For databases without sync callbacks, the explicit checkpoint is the only cleanup path. |
| Test cleanup "commented out" | **Corrected** | Cleanup runs at the *start* of each test run (`rmSync` on line 6 of setup.ts), not never. The pattern preserves data after a run for debugging. |
| Calendar `shared` endpoint ownerId | **Downgraded** | From Critical to Minor. The endpoint ignores ownerId but always returns the authenticated user's data -- no data leakage possible. |
| Whisper SSE leak severity | **Reclassified** | Currently limited by SSE architecture (events only go to the chat owner's Home). Remains critical as a latent defect -- any future SSE change would immediately expose whisper content. |
| Contacts save indicator (FE) | **Upgraded** | From Important to Critical. The component's own mutation hooks never fire, so `isPending` is always false -- enables double-submission with no feedback. |
| Waitlist form stale closure | **Upgraded** | From Minor to Critical. The empty `useCallback` dependency array means the form always submits empty strings -- the feature is completely broken. |

---

## Domain Review Index

| Review | Domain | Critical | Important | Minor | File |
|--------|--------|----------|-----------|-------|------|
| [BE Core](BE_core.md) | Auth, Home, Config, Setup, SSE | 1 | 9 | 16 | `apps/api/src/lib/{core,config,auth,home,setup}/` |
| [BE Drive](BE_drive.md) | Drive, Mount, Storage, ACL, Previews | 2 | 8 | 7 | `apps/api/src/lib/{drive,mount,storage,preview}/` |
| [BE Mail](BE_mail.md) | Maildir, EML, SMTP | 4 | 8 | 10 | `apps/api/src/lib/mail/` |
| [BE Contacts](BE_contacts.md) | Contact management | 1 | 7 | 11 | `apps/api/src/lib/contacts/` |
| [BE Calendar](BE_calendar.md) | Calendar, RRULE, sharing, invites | 3 | 10 | 6 | `apps/api/src/lib/calendar/` |
| [BE Chat](BE_chat.md) | Chat rooms, slash commands | 2 | 8 | 7 | `apps/api/src/lib/chat/` |
| [BE Collab](BE_collab.md) | Yjs, WebSocket, real-time editing | 0 | 7 | 8 | `apps/api/src/lib/collab/` |
| [FE Shared](FE_shared.md) | packages/lib + packages/ui | 3 | 11 | 11 | `packages/{lib,ui}/` |
| [FE Drive](FE_drive.md) | Drive app | 3 | 8 | 12 | `apps/drive/` |
| [FE Mail](FE_mail.md) | Mail app | 2 | 12 | 12 | `apps/mail/` |
| [FE Contacts](FE_contacts.md) | Contacts app | 2 | 5 | 15 | `apps/contacts/` |
| [FE Calendar](FE_calendar.md) | Calendar app | 3 | 9 | 15 | `apps/calendar/` |
| [FE Chat](FE_chat.md) | Chat app | 2 | 5 | 8 | `apps/chat/` |
| [FE Collab](FE_collab.md) | Docs, Stickies, Slides, Sheets | 2 | 10 | 14 | `apps/{docs,stickies,slides,sheets}/` |
| [FE Space](FE_space.md) | User settings, profile | 3 | 7 | 9 | `apps/space/` |
| [FE People](FE_people.md) | Org/team admin | 2 | 5 | 10 | `apps/people/` |
| [FE Setup](FE_setup.md) | Setup wizard, index/landing | 3 | 7 | 8 | `apps/{setup,index}/` |
| [FE Sheets Deep](FE_sheets_deep.md) | Sheets + fortune-sheet | 4 | 9 | 10 | `apps/sheets/`, `packages/fortune-sheet/` |

**Totals:** 19 critical, ~82 important, ~120 minor issues across 18 reviews.

---

## All Critical Issues

Every critical issue from every review, organized by impact category.

### Security and Authorization

| # | Issue | Location | Review |
|---|-------|----------|--------|
| 1 | **Team calendar permissions are cosmetic** -- `resolveCalendarForEvents` hardcodes `permission: 'write'` for all team members, bypassing share-level restrictions entirely. Admins setting read or free-busy see no effect. | `apps/api/src/lib/calendar/get-calendar.ts:29-35` | [BE Calendar](BE_calendar.md) #1 |
| 2 | **Whisper content in SSE events** -- private whisper messages are included unfiltered in SSE payloads. Currently limited by SSE architecture (only owner's Home receives), but any future SSE expansion immediately creates an active privacy leak. | `apps/api/src/lib/chat/chat.ts:116-122` | [BE Chat](BE_chat.md) #1 |
| 3 | **Calendar `access` endpoint leaks share list to free-busy users** -- users with free-busy access (meant to see only time blocks) can enumerate all shares including email addresses and permission levels. | `apps/api/src/routes/calendar.ts:165-170` | [BE Calendar](BE_calendar.md) #3 |
| 4 | **Mailbox name path traversal** -- `mailboxDir` only replaces the first `/`, and `..` segments are not validated. Authenticated users can create/read directories outside their Maildir. | `apps/api/src/lib/mail/maildir-store.ts:163-166` | [BE Mail](BE_mail.md) #1 |
| 5 | **Mail attachment header injection** -- `Content-Disposition` header interpolates unsanitized `params.fileName`, allowing response splitting via `"`, `\r`, `\n` characters. | `apps/api/src/routes/mail.ts:129` | [BE Mail](BE_mail.md) #2 |
| 6 | **Public mail delivery endpoint has no protections** -- `POST /mail/deliver/:to` accepts arbitrary EML from unauthenticated callers with no rate limiting, size limit, or quota enforcement. | `apps/api/src/routes/mail.ts:28` | [BE Mail](BE_mail.md) #3 |
| 7 | **Clients can post `system` type chat messages** -- no server-side guard prevents users from posting messages with `type: 'system'`, enabling social engineering (fake system announcements). | `apps/api/src/routes/chat.ts:40-45` | [BE Chat](BE_chat.md) #2 |

### Broken Core Functionality

| # | Issue | Location | Review |
|---|-------|----------|--------|
| ~~8~~ | ~~Collab updates never broadcast~~ | **Downgraded to Important** -- collab works via client-side 5s resyncInterval. Adding broadcast improves latency. | [BE Collab](BE_collab.md) #1 |
| 10 | **SharedDrive missing `createSlides` and `createSheets` overrides** -- these fall through to the base `Drive` class which has no initialized mounts, returning 404. Creating slides/sheets on shared or team drives is broken. | `apps/api/src/lib/drive/sharedDrive.ts` | [BE Drive](BE_drive.md) #2 |
| 11 | **Slides and Sheets MIME type typos** -- `application-eigenslide` (singular) used in 6 route files instead of `application-eigenslides` (plural). Navigation after create/delete and initial redirect show empty file lists. | `apps/slides/src/routes/index.tsx:11`, `apps/sheets/src/routes/index.tsx:11` (+ 4 more) | [FE Collab](FE_collab.md) #1, [FE Sheets](FE_sheets_deep.md) #1 |
| 12 | **Mail download and attachment URLs broken** -- URL builders omit the required `/:ownerId/` segment, producing 404s. All attachment downloads silently fail. | `packages/lib/src/core/api.ts:94-95` | [FE Mail](FE_mail.md) #1 |
| 13 | **Draft mutations silently swallow errors** -- try/catch returns `null` instead of re-throwing, making `useMutation.isError` unreachable. Users are navigated away from compose even on send failure, losing their draft. | `packages/lib/src/core/mail/hooks/use-draft.ts:22-44` | [FE Mail](FE_mail.md) #2 |
| 14 | **Waitlist form always submits empty strings** -- `useCallback` with empty `[]` deps captures initial empty `email`/`notes` values permanently. The waitlist feature is completely broken. | `apps/index/src/routes/index.tsx:47-66` | [FE Setup](FE_setup.md) #2 |
| 15 | **Setup wizard uses wrong env variable** -- reads `VITE_API_URL` instead of `VITE_API_HOST`. Falls back to `localhost:8000`, which breaks in non-development deployments. | `apps/setup/src/components/setup-wizard.tsx:24` | [FE Setup](FE_setup.md) #1 |

### Data Integrity

| # | Issue | Location | Review |
|---|-------|----------|--------|
| 16 | **Missing `await` on `matchesACL` in share propagation** -- `!matchesACL(...)` evaluates `!Promise` which is always false. The unshare branch only executes on full ACL removal, leaving stale shared.db entries when individual access is revoked. | `apps/api/src/lib/drive/drive.ts:561` | [BE Drive](BE_drive.md) #1 |
| 17 | **`getTeamExists` missing `await`** -- always returns truthy (a Promise), allowing TeamHome instances for non-existent teams. Creates directories under `data/team/<nonexistent>/`. | `apps/api/src/lib/team/team.ts:10-12` | [BE Core](BE_core.md) #1 |
| 18 | **BCC headers persisted in stored EML** -- `createEmlContent` always emits `BCC:` in the stored message. IMAP clients reading the Maildir expose BCC recipients, violating RFC 5322. | `apps/api/src/lib/mail/mailfile.ts:26-36` | [BE Mail](BE_mail.md) #4 |
| 19 | **`deleteCalendar` orphans shared entries and linked invitations** -- calendar deletion cascades DB rows but does not propagate share removal or cancellation to recipients. Stale entries persist in other users' databases. | `apps/api/src/lib/calendar/calendar.ts:245-252` | [BE Calendar](BE_calendar.md) #2 |
| 20 | **`getMe()` returns null after self-contact creation** -- `addYourself()` returns `user.id` but `getContactById` expects the DB-generated contact row UUID. | `apps/api/src/lib/contacts/contacts.ts:363-371` | [BE Contacts](BE_contacts.md) #1 |
| 21 | **`applyOp` crashes if all sheets are hidden** -- remote "hide sheet" op with all sheets hidden dereferences `undefined[0].id`, crashing the workbook for all connected clients. | `packages/fortune-sheet/src/components/Workbook/api.ts:88-95` | [FE Sheets](FE_sheets_deep.md) #4 |

### Additional Frontend Critical Issues

| # | Issue | Location | Review |
|---|-------|----------|--------|
| 22 | **Drive query keys omit `ownerId`** -- switching between personal and team drives serves cached data from the wrong owner. SSE invalidations also cross-contaminate. | `packages/lib/src/core/drive/hooks/use-drive.ts:10-26` | [FE Shared](FE_shared.md) #2 |
| 23 | **Rules of Hooks violation** -- conditional `useBreadcrumb` call based on prop value. Will corrupt React state if prop changes between renders. | `packages/ui/src/components/layout/drive/drive-list.tsx:58` | [FE Shared](FE_shared.md) #1 |
| 24 | **`getEventsForDay` drops timed events spanning midnight** -- only checks start time for non-all-day events. Multi-hour timed events crossing midnight are invisible on the second day. | `apps/calendar/src/components/calendar-utils.ts:73-76` | [FE Calendar](FE_calendar.md) C1 |
| 25 | **RecurrencePicker receives UTC-parsed date** -- `new Date("2024-03-15")` is UTC midnight, which in western timezones produces wrong weekday presets and RRULE `BYDAY` values. | `apps/calendar/src/components/create-event-dialog.tsx:227` | [FE Calendar](FE_calendar.md) C2 |
| 26 | **"This and following" delete is a no-op for exceptions** -- the expression always evaluates to null for recurrence exceptions since they don't carry the parent RRULE. | `apps/calendar/src/components/event-detail-dialog.tsx:167-174` | [FE Calendar](FE_calendar.md) C3 |
| 27 | **Missing `error` case in command dispatch** -- malformed commands fall through the switch and get posted as plain messages visible to all. `/whisper badformat` leaks intended private content. | `packages/lib/src/core/chat/hooks/use-chat-room.ts:89-137` | [FE Chat](FE_chat.md) #1 |
| 28 | **No error handling in `handleSendMessage`** -- zero try/catch blocks across 3 `.mutateAsync()` calls. Failures become unhandled promise rejections. Input is already cleared, so message text is lost. | `packages/lib/src/core/chat/hooks/use-chat-room.ts:69-141` | [FE Chat](FE_chat.md) #2 |
| 29 | **Contacts save indicator never activates** -- component instantiates its own mutation hooks, but actual save uses parent's mutation. `isPending` is always false, enabling double-submission. | `apps/contacts/src/components/contacts/contact-edit.tsx:84-85` | [FE Contacts](FE_contacts.md) C1 |
| 30 | **Avatar upload calls `setAvatar` twice** -- `onSuccess` callback and post-promise handler both fire, causing redundant state updates with potentially divergent values. | `apps/contacts/src/components/contacts/contact-edit.tsx:166-194` | [FE Contacts](FE_contacts.md) C2 |
| 31 | **`revokeOtherSessions` checkbox is silently ignored** -- the handler hardcodes `true`, discarding the user's explicit choice. Sessions are always revoked regardless of the checkbox state. | `apps/space/src/routes/_auth.security.password.tsx:12` | [FE Space](FE_space.md) C1 |
| 32 | **`onSubmit` in ChangePassword does not await** -- unhandled promise rejections, no loading state, allows double-submission during in-flight requests. | `apps/space/src/components/space/change-password.tsx:94-100` | [FE Space](FE_space.md) C2 |
| 33 | **Space avatar upload double-processes response** -- `setAvatar` called twice, second call may receive empty string from consumed Response body stream, overwriting correct value. | `apps/space/src/components/space/profile-editor.tsx:168-195` | [FE Space](FE_space.md) C3 |
| 34 | **People keyboard navigation selects wrong member** -- `activeId` uses membership ID but `getId` returns user UUID. Keyboard-driven selection shows empty detail pane. | `apps/people/src/components/people/members-list.tsx:79-83` | [FE People](FE_people.md) #1 |
| 35 | **Team calendar save overwrites entire shares array** -- saving team settings silently destroys all pre-existing individual user shares on the team calendar. | `apps/people/src/components/people/team-detail.tsx:250-253` | [FE People](FE_people.md) #2 |
| 36 | **Storage type "Recommended" label on wrong option** -- setup wizard labels `local-id` as recommended, but the project defaults to `local-fullnames` (including the most recent commit). | `apps/setup/src/components/setup-wizard.tsx:224` | [FE Setup](FE_setup.md) #3 |
| 37 | **`validateSearch` drops `uid` in shared routes** -- detail pane broken for shared-with-me items across drive, sheets, and other collab apps. | `apps/drive/src/routes/_auth.shared.$to.tsx:13-16` | [FE Drive](FE_drive.md) C2 |
| 38 | **`markDirty` forward-reference in MarkdownEditor** -- `onUpdate` callback captures `markDirty` before it is declared. Works by accident (callback fires asynchronously) but is one Tiptap update away from a crash. | `apps/drive/src/components/editor/markdown-editor.tsx:75-93` | [FE Drive](FE_drive.md) C3 |
| 39 | **Stale closure in fortune-sheet `onPaste`** -- reads `context` from closure instead of Immer draft, potentially pasting at wrong positions after state changes. | `packages/fortune-sheet/src/components/Workbook/index.tsx:691-787` | [FE Sheets](FE_sheets_deep.md) #3 |
| 40 | **Sheets `validateSearch` drops `uid`** -- same bug as #37, affecting the sheets shared-items view. | `apps/sheets/src/routes/_auth._sidebar.shared.$to.tsx:14-16` | [FE Sheets](FE_sheets_deep.md) #2 |
| 41 | **Revision restore pushes raw JSON into Y.Array instead of Yjs types** -- stickies/slides/sheets restore logic does not convert array elements, breaking collaborative editing on restored sheets data. | `apps/stickies/src/components/stickies/board.tsx:108` | [FE Collab](FE_collab.md) #2 |

---

## Important Issues -- Tiered Priority

### Tier 1: Security Hardening

| # | Issue | Location | Review |
|---|-------|----------|--------|
| 1 | Path traversal in contacts avatar download | `contacts.ts:317-318` | [BE Contacts](BE_contacts.md) #3 |
| 2 | Content-Disposition header injection in drive download | `routes/drive.ts:114` | [BE Drive](BE_drive.md) #8 |
| 3 | Path traversal guard missing in `LocalFilesystem` | `local-filesystem.ts:16-18` | [BE Core](BE_core.md) #7 |
| 4 | Path traversal guard missing in `LocalKeyStorage` | `local-key-storage.ts:16-18` | [BE Core](BE_core.md) #26 |
| 5 | Hardcoded auth secret fallback in source | `auth.ts:98` | [BE Core](BE_core.md) #5 |
| 6 | Calendar shared-with-me allows user ID enumeration | `routes/calendar.ts:173-177` | [BE Calendar](BE_calendar.md) #7 |
| 7 | No message content length limit in chat | `routes/chat.ts:39` | [BE Chat](BE_chat.md) #3 |
| 8 | No `limit` parameter validation/capping in chat | `routes/chat.ts:12` | [BE Chat](BE_chat.md) #5 |
| 9 | HTML sanitization does not block CSS tracking in mail | `mail-parse.ts:10` | [BE Mail](BE_mail.md) #12 |

### Tier 2: Data Integrity and Correctness

| # | Issue | Location | Review |
|---|-------|----------|--------|
| 10 | `movePath` allows moving folder into own descendant (orphan cycle) | `drive.ts:315-338` | [BE Drive](BE_drive.md) #5 |
| 11 | `movePath` missing write permission check on target parent | `drive.ts:329` | [BE Drive](BE_drive.md) #6 |
| 12 | Folder deletion does not propagate ACL removal for descendants | `drive.ts:285-286` | [BE Drive](BE_drive.md) #4 |
| 13 | `closeCollabDocument` writes mount total size instead of doc size | `drive.ts:505-509` | [BE Drive](BE_drive.md) #7 |
| 14 | Snapshot creation can lose concurrent updates (unbounded DELETE) | `collabDocument.ts:82-115` | [BE Collab](BE_collab.md) #3 |
| 15 | `createAsyncSingleton` permanently broken after transient error | `singleton.ts:19-22` | [BE Core](BE_core.md) #2 |
| 16 | Race condition in Home cleanup/recreation lifecycle | `home.ts:78-87`, `get-home.ts:62-64` | [BE Core](BE_core.md) #3 |
| 17 | `Home.destruct()` opens unresolved databases just to close them | `home.ts:151-158` | [BE Core](BE_core.md) #4 |
| 18 | EML uses hardcoded MIME boundary string | `mailfile.ts:35` | [BE Mail](BE_mail.md) #5 |
| 19 | `messageDelete` deletes DB before file (inconsistency on failure) | `maildir.ts:134-146` | [BE Mail](BE_mail.md) #6 |
| 20 | Non-atomic flag updates in mail | `maildir.ts:183-207` | [BE Mail](BE_mail.md) #7 |
| 21 | `updateContact` with omitted `labels` strips all labels | `contacts.ts:187` | [BE Contacts](BE_contacts.md) #2 |
| 22 | `updateUser` not awaited in contacts (fire-and-forget auth write) | `contacts.ts:167` | [BE Contacts](BE_contacts.md) #5 |
| 23 | No RRULE validation -- malformed rules crash all range queries | `calendar.ts:256-311` | [BE Calendar](BE_calendar.md) #4 |
| 24 | Recurring event range query loads ALL recurring events (no filtering) | `calendar.ts:442-457` | [BE Calendar](BE_calendar.md) #5 |
| 25 | `updateEvent` returns stale sequence number | `calendar.ts:386-401` | [BE Calendar](BE_calendar.md) #6 |
| 26 | Recurring vs non-recurring range filtering inconsistency | `calendar.ts:1081-1102` | [BE Calendar](BE_calendar.md) #10 |
| 27 | Team SSE notifications commented out | `share-propagation.ts:25-29` | [BE Calendar](BE_calendar.md) #11 |
| 28 | `removeMount` does not close mount resources | `drive.ts:101-106` | [BE Drive](BE_drive.md) #9 |
| 29 | `SharedDrive` inherits broken shared paths methods | `sharedDrive.ts` | [BE Drive](BE_drive.md) #3 |
| 30 | `getStorageFile` casts S3File to BunFile (S3 previews broken) | `mount.ts:444-447` | [BE Drive](BE_drive.md) #10 |
| 31 | Per-message WebSocket permission checks cause DB overhead | `routes/collab.ts:102-135` | [BE Collab](BE_collab.md) #4 |
| 32 | Collab document database never closed after disconnect | `collabDocument.ts:192-202` | [BE Collab](BE_collab.md) #7 |
| 33 | Double-unsubscribe can re-init closed collab document | `routes/collab.ts:137-160` | [BE Collab](BE_collab.md) #6 |

### Tier 3: Frontend Correctness

| # | Issue | Location | Review |
|---|-------|----------|--------|
| 34 | `MAIL_SENT` SSE handler is a no-op | `sse-handlers.ts:60-61` | [FE Shared](FE_shared.md) #4 |
| 35 | 12 `as any` casts in calendar hooks erase type safety | `use-calendar.ts` | [FE Shared](FE_shared.md) #5 |
| 36 | Draft mutations lack `onSuccess` cache invalidation | `use-draft.ts:46-62` | [FE Shared](FE_shared.md) #7 |
| 37 | `useSSE` `isConnected` is stale (not reactive state) | `use-sse.ts:62-64` | [FE Shared](FE_shared.md) #8 |
| 38 | Direct mutation of TanStack Query cache in mail | `_auth.$filterType.$filterId.tsx:62-63` | [FE Mail](FE_mail.md) #3 |
| 39 | Missing `await` on async calls in mail bulk operations | `_auth.$filterType.$filterId.tsx:121-155` | [FE Mail](FE_mail.md) #6 |
| 40 | Reply ignores `Reply-To` header | `_auth.$filterType.$filterId.tsx:163-167` | [FE Mail](FE_mail.md) #7 |
| 41 | Reply All includes self and omits original To recipients | `_auth.$filterType.$filterId.tsx:176-178` | [FE Mail](FE_mail.md) #8 |
| 42 | `EmailDraft` mutates props during render (cache corruption) | `email-draft.tsx:91-108` | [FE Mail](FE_mail.md) #11 |
| 43 | Create-event `useEffect` resets form on calendar list change | `create-event-dialog.tsx:74-102` | [FE Calendar](FE_calendar.md) I1 |
| 44 | Edit-event `useEffect` same dependency issue | `edit-event-dialog.tsx:108-136` | [FE Calendar](FE_calendar.md) I2 |
| 45 | Edit dialog missing `minTime` on end-time picker | `edit-event-dialog.tsx:285` | [FE Calendar](FE_calendar.md) I3 |
| 46 | `moveEvent` deletes parent series for exception | `edit-event-dialog.tsx:171-184` | [FE Calendar](FE_calendar.md) M14 |
| 47 | No error feedback anywhere in calendar (zero toast calls) | All calendar components | [FE Calendar](FE_calendar.md) I9 |
| 48 | Chat 5-second polling redundant with SSE | `use-chat.ts:34` | [FE Chat](FE_chat.md) #3 |
| 49 | `useChats` query key missing `ownerId` | `use-chat.ts:14-15` | [FE Chat](FE_chat.md) #4 |
| 50 | `window.location.href` in chat sidebar causes full page reload | `chat-sidebar.tsx:44` | [FE Chat](FE_chat.md) #5 |
| 51 | Auto-scroll fires unconditionally on every message count change | `chat-message-list.tsx:136-138` | [FE Chat](FE_chat.md) #7 |
| 52 | Stickies/Slides return stale null refs before Yjs sync | `use-board.ts:218-219`, `use-deck.ts:452-453` | [FE Collab](FE_collab.md) #3 |
| 53 | Slides font size uses `vh` units (wrong in editor canvas) | `slide-object.tsx:32` | [FE Collab](FE_collab.md) #8 |
| 54 | Profile editor uses imperative fetch instead of query hook | `profile-editor.tsx:48-65` | [FE Space](FE_space.md) I1 |
| 55 | TOTP secret extraction uses fragile string splitting | `_auth.security.2fa.tsx:28` | [FE Space](FE_space.md) I3 |
| 56 | `space-8` is not a valid Tailwind class (missing `y`) | `change-password.tsx:104` | [FE Space](FE_space.md) I4 |
| 57 | Index app Login button uses relative URL (breaks in dev) | `index.tsx:40` | [FE Setup](FE_setup.md) #5 |
| 58 | Never-resolving Promise in authenticated redirect | `__root.tsx:13-18` | [FE Setup](FE_setup.md) #10 |
| 59 | `as any` casts in people/team/settings hooks (7 locations) | Multiple hooks | [FE People](FE_people.md) #2 |
| 60 | Server settings quota inputs accept NaN/negatives | `server-settings.tsx:56-58` | [FE People](FE_people.md) #3 |
| 61 | Unbounded Y.Array growth for ops in sheets | `use-sheet.ts:145` | [FE Sheets](FE_sheets_deep.md) #8 |

---

## Systemic Patterns Across Multiple Domains

### 1. `ownerId` URL parameter silently ignored

Mail routes, contacts routes, SSE route, and calendar `shared` endpoint all accept an `ownerId` URL parameter but silently use the authenticated user's ID instead. This is security-correct (prevents spoofing) but creates a misleading API contract. Any future developer who assumes the parameter works will introduce bugs.

**Affected:** `routes/mail.ts` (all routes), `routes/contacts.ts` (all routes), `routes/sse.ts`, `routes/calendar.ts` (`/shared`), `routes/home.ts`

**Fix:** Either validate `ownerId === user.id` (or check team membership) and reject mismatches with 403, or remove the parameter entirely from routes where it serves no purpose.

### 2. Missing `await` on async calls

A recurring pattern across the codebase -- async functions called without `await`, causing silent failures, fire-and-forget behavior, or control flow bugs:
- `matchesACL` in drive share propagation (BE Drive #1)
- `updateUser` in contacts (BE Contacts #5)
- `addContact` and `cleanupAvatarImages` in contacts init (BE Contacts #7)
- `onSubmit`/`onPasswordChange` in Space password change (FE Space C2)
- Bulk delete/move handlers in mail (FE Mail #6)
- `getTeamExists` in team resolution (BE Core #1)

### 3. `as any` erosion of Eden Treaty type safety

The project chose Eden Treaty specifically for end-to-end type safety, but ~50+ `as any` casts in `packages/lib` hooks nullify this benefit. Concentrated in:
- Calendar hooks: 12 casts (every API call except list queries)
- Mail hooks: dynamic property access for wildcard routes
- People/team/settings hooks: 7 casts for role and body params
- Contacts label hooks: 2 casts

Root cause appears to be Eden Treaty's type inference struggling with Elysia's nested parameterized paths and optional body types. Should be fixed at the route/schema level rather than cast away in hooks.

### 4. `validateSearch` drops `uid` parameter across shared routes

The "shared with me" detail pane is broken across multiple apps. The `validateSearch` function extracts `pid` but not `uid`, and uses `as DriveSearchParams` to silence the type error. Since `uid` is always undefined, `usePathInfo` receives empty ownerId for shared items.

**Affected:** `apps/drive/`, `apps/sheets/`, and likely `apps/docs/`, `apps/stickies/`, `apps/slides/` (same route pattern).

### 5. Collab infrastructure has the highest bug density

The WebSocket-based Yjs collaboration system has 2 critical bugs (no broadcast, no awareness removal broadcast), plus important issues (snapshot race, permanent singleton failure, database never closed, per-message DB overhead). This is the highest-risk area because docs, stickies, slides, and sheets all depend on it. The fix for broadcast alone (adding a `doc.on('update', ...)` handler) unblocks multi-user editing across all 4 apps.

### 6. Hardcoded light-mode colors break dark mode

Multiple components use hardcoded Tailwind color classes (e.g., `text-gray-500`, `bg-blue-50`, `bg-orange-50/30`) instead of theme tokens (`text-muted-foreground`, `bg-background`). Affected areas:
- Drive: Tiptap editor CSS (FE Drive I4), access lists (FE Drive I7)
- Chat: whisper message styling (FE Chat #12)
- Space: info/error boxes (FE Space I7)
- Calendar: no dark mode variants at all in calendar components

### 7. `interface` used instead of `type` everywhere

CONTRIBUTING.md specifies "always `type` over `interface` except when methods are needed." Found ~60+ violations across all apps, mostly in `__root.tsx` route context types (inherited from TanStack Router examples) and component prop types. None require methods.

### 8. No error feedback in several apps

Calendar has zero `toast()` calls. Contacts has zero toast notifications on mutations. Space's password change and 2FA flows have incomplete error handling. Chat's `handleSendMessage` has zero try/catch blocks. The pattern should be: `try { await mutation } catch { toast.error() }` with consistent user feedback across all apps.

---

## Strengths Worth Preserving

- **Architectural discipline** -- hooks in `packages/lib`, never in apps. Universally followed across all 13 apps.
- **Query key pattern** -- consistent hierarchical key factories with exported invalidation functions across all domains.
- **SSE event system** -- clean emit/subscribe/invalidate pattern with domain-specific handlers for all 5 implemented domains.
- **Type sharing** -- shared types in `packages/lib/src/types/` used by both FE and BE, preventing drift.
- **Server-side sanitization** -- DOMPurify used consistently for HTML content at ingestion (mail, previews). The frontend correctly trusts pre-sanitized data.
- **ManagedDatabase** -- WAL mode, busy timeout, versioned migrations, dirty tracking, clean lifecycle. Well-designed.
- **JsonStore** -- atomic write-to-tmp-then-rename pattern, deep merge, crash safety. Now has test coverage.
- **Maildir compliance** -- correct Maildir++ conventions (tmp/new/cur, dot-prefix, flags, atomic delivery, Dovecot keyword preservation).
- **Timezone handling** -- the calendar's `utcToLocal`/`localToUtcSeconds` pair with double-verify DST correction is well-engineered.
- **Conflict resolution** -- the drive editor's `useEditorSave` with optimistic concurrency, Cmd+S, beforeunload, and 3-option conflict dialog is production-quality.
- **ACL enforcement in chat** -- `SharedDrive.getChat()` enforces `canRead`, all mutating routes additionally check `canWrite`.
- **Test coverage** -- solid integration test suites across core, drive, mail, contacts, calendar (4 files), chat, and collab domains.
- **Documentation** -- comprehensive `docs/` directory covering architecture, patterns, and domain specifics, actively maintained.

---

## Recommended Fix Order

### Phase 1: Collab + Security (highest impact)

Fix the collab system first -- it unblocks multi-user editing for 4 apps with a single focused change.

1. **Collab broadcast** (#8) -- add `doc.on('update', ...)` handler that broadcasts to peers
2. **Awareness broadcast** (#9) -- add `awareness.on('update', ...)` handler
3. **Collab snapshot race** (#14) -- bounded DELETE with WHERE clause
4. **Team calendar auth bypass** (#1) -- resolve actual permission instead of hardcoding 'write'
5. **Calendar access endpoint leak** (#3) -- check permission before returning shares
6. **Whisper SSE filtering** (#2) -- strip content from SSE payload for whisper messages
7. **System message spoofing** (#7) -- remove `system` from route body schema
8. **Mail path traversal** (#4) -- validate mailbox names against strict pattern
9. **Header injection** (#5, Tier 1 #2) -- sanitize filenames in Content-Disposition headers
10. **Mail delivery hardening** (#6) -- add rate limiting, size limit, localhost restriction

### Phase 2: Data Integrity + Broken Features

11. **Drive query keys** (#22) -- add ownerId to all non-global drive keys
12. **matchesACL await** (#16) -- add `await` before the `matchesACL` call
13. **SharedDrive missing overrides** (#10) -- add `createSlides`/`createSheets`
14. **MIME type typos** (#11) -- fix 6 route files in slides and sheets
15. **Mail download URLs** (#12) -- add ownerId segment to URL builders
16. **Draft error handling** (#13) -- remove try/catch wrapper, let errors propagate
17. **validateSearch uid** (#37, #40) -- add uid extraction to all shared route validators
18. **getTeamExists await** (#17) -- add await before the comparison
19. **getMe return value** (#20) -- capture and return contact ID from addContact
20. **BCC headers** (#18) -- exclude BCC from stored EML
21. **deleteCalendar orphans** (#19) -- propagate cancellation and share removal before delete
22. **movePath cycle detection** (#10 Tier 2) -- walk ancestry before allowing move
23. **movePath target permission** (#11 Tier 2) -- add canWrite check on target parent

### Phase 3: Frontend Correctness

24. **Waitlist form** (#14) -- fix useCallback dependencies
25. **Setup env variable** (#15) -- use VITE_API_HOST
26. **Calendar event spanning** (#24) -- use range-overlap check for timed events
27. **RecurrencePicker UTC date** (#25) -- append T00:00:00 to date string
28. **Chat error handling** (#27, #28) -- add error case + try/catch
29. **Contacts save indicator** (#29) -- remove internal mutation hooks, use parent state
30. **Reply-To handling** (#40, #41) -- check replyTo header, include To recipients
31. **Rules of Hooks** (#23) -- always call useBreadcrumb, use `enabled` option
32. **Calendar form reset** (Tier 3 #43, #44) -- fix useEffect dependencies

### Phase 4: Ongoing Code Quality

- Systematic `as any` removal (start with calendar's 12 casts, then people/team)
- Extract duplicated collab utilities (`jsonToYType`, revision restore) to `packages/lib`
- Clean up `console.log` statements (sheets: 13, collab: 10+, space: 2, SSE: 1)
- Translate Dutch comments to English (contacts hooks, space, index root, contacts seed)
- Remove `"use client"` directives from Vite apps (~41 files)
- Replace `interface` with `type` across all apps (~60+ instances)
- Fortune-sheet cleanup: remaining CSS files, `@ts-ignore` directives (81), `as any` casts (36), Chinese comments

---

## Test Coverage Gaps

Key areas lacking test coverage that would have caught critical bugs:

| Gap | Would have caught | Review |
|-----|-------------------|--------|
| Multi-client collab sync test | Broadcast missing (#8) | BE Collab |
| SharedDrive.createSlides/createSheets test | Missing overrides (#10) | BE Drive |
| S3 storage backend tests | S3 preview failures (Tier 2 #30) | BE Drive |
| Recursive folder deletion with descendant ACLs | Orphaned shared.db entries (Tier 2 #12) | BE Drive |
| Malformed RRULE create/expand | Calendar crash on expansion (Tier 2 #23) | BE Calendar |
| Team calendar permission enforcement | Auth bypass (#1) | BE Calendar |
| Path traversal in mailbox names | Maildir escape (#4) | BE Mail |
| WebSocket update tests conditional on status 101 | All WS tests skip silently if upgrade fails | BE Collab |
