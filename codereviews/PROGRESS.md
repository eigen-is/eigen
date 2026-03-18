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
- [ ] C10: SharedDrive missing `createSlides` and `createSheets` overrides
- [ ] C11: Slides and Sheets MIME type typos in 6 route files
- [ ] C12: Mail download and attachment URLs broken — missing ownerId segment
- [ ] C13: Draft mutations silently swallow errors
- [ ] C37: `validateSearch` drops `uid` in drive shared routes
- [ ] C40: Sheets `validateSearch` drops `uid` — same pattern

### Data integrity

- [ ] C20: `getMe()` returns null after self-contact creation
- [ ] C18: BCC headers persisted in stored EML
- [ ] C19: `deleteCalendar` orphans shared entries and linked invitations
- [ ] I10: `movePath` allows moving folder into own descendant
- [ ] I11: `movePath` missing write permission check on target parent
- [ ] I12: Folder deletion does not propagate ACL removal for descendants
- [ ] I13: `closeCollabDocument` writes mount total size instead of doc size
- [ ] I16: Race condition in Home cleanup/recreation lifecycle
- [ ] I17: `Home.destruct()` opens unresolved databases just to close them
- [ ] I18: EML uses hardcoded MIME boundary string
- [ ] I19: `messageDelete` deletes DB before file
- [ ] I20: Non-atomic flag updates in mail
- [ ] I21: `updateContact` with omitted `labels` strips all labels
- [ ] I23: No RRULE validation — malformed rules crash range queries
- [ ] I24: Recurring event range query loads ALL recurring events
- [ ] I25: `updateEvent` returns stale sequence number
- [ ] I26: Recurring vs non-recurring range filtering inconsistency
- [ ] I27: Team SSE notifications commented out
- [ ] I28: `removeMount` does not close mount resources
- [ ] I29: `SharedDrive` inherits broken shared paths methods
- [ ] I30: `getStorageFile` casts S3File to BunFile (S3 previews broken)
- [ ] I31: Per-message WebSocket permission checks cause DB overhead
- [ ] C35: Team calendar save overwrites entire shares array

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
