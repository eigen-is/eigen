# Code Review Fix Progress

Tracking all findings from the [full code review](OVERVIEW.md). Phases match the Recommended Fix Order in OVERVIEW.md.

---

## Phase 1: Collab + Security (highest impact)

- [x] Collab broadcast — added `doc.on('update')` handler for instant sync (was 5s poll)
- [x] Awareness broadcast — added `awareness.on('update')` handler, ghost cursors gone
- [x] Collab snapshot race — bounded DELETE with `WHERE id <= lastUpdate.id`
- [x] `createAsyncSingleton` — resets on transient failure (I15)
- [x] Collab DB leak — `closeCollabDocument` now closes the ManagedDatabase (I32)
- [x] Double-unsubscribe — shared cleanup via `ws.data`, no phantom documents (I33)
- [x] C1: Team calendar — `resolveCalendarForEvents` now calls `checkPermission` instead of hardcoding 'write'
- [x] C3: Calendar `access` endpoint — shares only returned for `write` permission holders
- [x] C2: Whisper SSE — content stripped from SSE payload, frontend refetches via filtered REST API
- [x] C7: `system` type removed from route body schema + frontend hook
- [x] C4: Mailbox name path traversal — `mailboxDir` now validates against `..` and control characters
- [x] C5: Mail attachment header injection — filename sanitized (control chars, `"`, `\` replaced)
- [x] C6: Mail delivery — 25MB body size limit added
- [x] I1: Contacts avatar download — path traversal blocked (reject `/`, `\`, `..`)
- [x] I2: Drive download — Content-Disposition filename sanitized
- [x] I3: `LocalFilesystem.getFilePath` — `path.resolve` + prefix check blocks traversal
- [x] I4: `LocalKeyStorage.getFilePath` — same fix
- [x] I5: Auth secret fallback — replaced hardcoded secret with `crypto.randomUUID()`
- [x] ~~I6~~: Calendar shared-with-me — not a real issue (ownerId is intentional for pull-based sharing)
- [x] I7: Chat message content — `maxLength: 50000` added to body schema
- [x] I8: Chat message limit — clamped to 1-200 range
- [ ] I9: CSS tracking in mail — deferred (needs image proxy or "load remote content" toggle, not a quick fix)

## Phase 2: Data Integrity + Broken Features

### Missing `await`

- [x] C16: `await matchesACL()` in `receiveACLChange` (drive.ts:565)
- [x] C17: `await getTeam()` in `getTeamExists` (team.ts:11)
- [x] I22: `await updateUser()` in contacts `updateContact` (contacts.ts:167)
- [x] I39: `await handleDeleteEmail/handleMoveEmail` in mail bulk handlers (4 locations)
- [x] C32: `await onPasswordChange()` in ChangePassword `onSubmit` (change-password.tsx:95)

### Broken features

- [x] C22: Drive query keys — added `ownerId` to all keys, hooks, invalidation functions, and SSE handler
- [x] C10: SharedDrive — added `createSlides` and `createSheets` overrides with permission checks
- [x] C11: MIME typos — `eigenslide`→`eigenslides`, `eigensheet`→`eigensheets` in 6 route files
- [x] C12: Mail URLs — added `ownerId` to download/attachment URL builders + updated call sites
- [x] C13: Draft mutations — removed try/catch, errors now propagate to TanStack Query
- [x] C37+C40: `validateSearch` — added `uid` extraction in 11 route files (drive, docs, stickies, slides, sheets)

### Data integrity

- [x] C20: `addYourself` now returns `addContact()` result (the DB-generated contactId)
- [x] C18: BCC stripped from EML, random MIME boundary generated (I18 also fixed)
- [x] C19: `deleteCalendar` propagates share removal before deleting
- [x] I10: `movePath` walks ancestor chain to prevent folder-into-descendant cycles
- [x] I11: `movePath` checks write permission on target parent
- [x] I12: `deleteFolder` recursively propagates ACL removal for descendants
- [x] I13: Removed incorrect mount-total-size write from `closeCollabDocument`
- [ ] I16: Deferred — Home cleanup/recreation race (low practical risk, 5-min timeout)
- [ ] I17: Deferred — databases are always opened during init, theoretical concern
- [x] I19: `messageDelete` now deletes file before DB record
- [ ] I20: Deferred — file+DB atomicity is a fundamental limitation, low risk
- [x] I21: `setContactLabels` only called when `labels !== undefined`
- [x] I23: RRULE validated via `RRule.parseString()` on create and update
- [ ] I24: Deferred — performance optimization, not a correctness bug
- [x] I25: `updateEvent` returns re-fetched event after `incrementSequence`
- [x] ~~I26~~: Dropped — asymmetry between timezone/non-timezone paths is intentional
- [x] I27: Improved comment explaining deliberate design choice (staleTime refresh)
- [x] I28: `removeMount` now calls `mount.closeAllDatabases()` before removing
- [x] I29: `SharedDrive` throws on `getSharedPathsByMe`/`getSharedPathsWithMe`/`getSharedWith`
- [ ] I30: Deferred — S3File/BunFile type mismatch needs design work
- [x] ~~I31~~: Dropped — per-message `canWrite` check is intentional
- [x] C35: Team calendar save merges team share with existing shares instead of replacing

## Phase 3: Frontend Correctness

### Critical

- [ ] C14: Waitlist form always submits empty strings
- [ ] C15: Setup wizard uses wrong env variable
- [ ] C36: Storage type "Recommended" label on wrong option
- [ ] C23: Rules of Hooks violation — conditional `useBreadcrumb`
- [ ] C24: `getEventsForDay` drops timed events spanning midnight
- [ ] C25: RecurrencePicker receives UTC-parsed date
- [ ] C26: "This and following" delete is a no-op for exceptions
- [ ] C27: Missing `error` case in command dispatch — whisper leak
- [ ] C28: No error handling in `handleSendMessage`
- [ ] C29: Contacts save indicator never activates
- [ ] C30: Avatar upload calls `setAvatar` twice
- [ ] C31: `revokeOtherSessions` checkbox silently ignored
- [ ] C33: Space avatar upload double-processes response
- [ ] C34: People keyboard navigation selects wrong member
- [ ] C38: `markDirty` forward-reference in MarkdownEditor
- [ ] C39: Stale closure in fortune-sheet `onPaste`
- [ ] C41: Revision restore pushes raw JSON into Y.Array
- [ ] C21: `applyOp` crashes if all sheets are hidden

### Important

- [ ] I34: `MAIL_SENT` SSE handler is a no-op
- [ ] I36: Draft mutations lack `onSuccess` cache invalidation
- [ ] I37: `useSSE` `isConnected` is stale (not reactive state)
- [ ] I38: Direct mutation of TanStack Query cache in mail
- [ ] I40: Reply ignores `Reply-To` header
- [ ] I41: Reply All includes self and omits original To recipients
- [ ] I42: `EmailDraft` mutates props during render
- [ ] I43: Create-event `useEffect` resets form on calendar list change
- [ ] I44: Edit-event `useEffect` same dependency issue
- [ ] I45: Edit dialog missing `minTime` on end-time picker
- [ ] I46: `moveEvent` deletes parent series for exception
- [ ] I47: No error feedback anywhere in calendar (zero toast calls)
- [ ] I48: Chat 5-second polling redundant with SSE
- [ ] I49: `useChats` query key missing `ownerId`
- [ ] I50: `window.location.href` in chat sidebar causes full page reload
- [ ] I51: Auto-scroll fires unconditionally on every message count change
- [ ] I52: Stickies/Slides return stale null refs before Yjs sync
- [ ] I53: Slides font size uses `vh` units
- [ ] I54: Profile editor uses imperative fetch instead of query hook
- [ ] I55: TOTP secret extraction uses fragile string splitting
- [ ] I56: `space-8` is not a valid Tailwind class
- [ ] I57: Index app Login button uses relative URL
- [ ] I58: Never-resolving Promise in authenticated redirect
- [ ] I60: Server settings quota inputs accept NaN/negatives
- [ ] I61: Unbounded Y.Array growth for ops in sheets

## Phase 4: Code Quality (ongoing)

- [ ] `as any` removal: calendar (12), people/team/settings (7), mail, contacts (2), fortune-sheet (36)
- [ ] Extract duplicated collab utilities (`jsonToYType`, revision restore) to `packages/lib`
- [ ] Remove `console.log` statements (sheets: 13, collab: 10+, space: 2, SSE: 1)
- [ ] Translate Dutch comments to English
- [ ] Remove `"use client"` directives (~41 files)
- [ ] Replace `interface` with `type` (~60+ instances)
- [ ] Fortune-sheet: CSS files, `@ts-ignore` (81), Chinese comments
- [ ] Hardcoded light-mode colors → theme tokens (Drive, Chat, Space, Calendar)
- [ ] `ownerId` URL param: validate or remove across mail, contacts, SSE, calendar, home routes
