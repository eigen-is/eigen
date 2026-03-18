# Code Review Fix Progress

Tracking all findings from the [full code review](OVERVIEW.md). Work by pattern, not by file.

---

## Session 1: Collab System

- [x] ~~C8~~ Downgraded: Collab updates poll-synced via 5s resyncInterval, not broken. Added server-side broadcast for instant sync.
- [x] C9: Awareness removal on disconnect now broadcast (fixed alongside broadcast)
- [x] I14: Snapshot creation bounded DELETE (BE Collab #3)
- [x] I15: `createAsyncSingleton` resets on failure (BE Core #2)
- [x] I32: Collab document database now closed via `mount.closeDatabase()` (BE Collab #7)
- [x] I33: Double-unsubscribe fixed via shared cleanup function + WeakMap (BE Collab #6)

## Session 2: Missing `await` Sweep

- [ ] C16: Missing `await` on `matchesACL` in share propagation (BE Drive #1)
- [ ] C17: `getTeamExists` missing `await` -- always truthy (BE Core #1)
- [ ] I22: `updateUser` not awaited in contacts (BE Contacts #5)
- [ ] I39: Missing `await` on async calls in mail bulk operations (FE Mail #6)
- [ ] C32: `onSubmit` in ChangePassword does not await (FE Space C2)

## Session 3: Security Hardening

### Critical

- [ ] C1: Team calendar permissions are cosmetic (BE Calendar #1)
- [ ] C2: Whisper content in SSE events (BE Chat #1)
- [ ] C3: Calendar `access` endpoint leaks share list to free-busy users (BE Calendar #3)
- [ ] C4: Mailbox name path traversal (BE Mail #1)
- [ ] C5: Mail attachment header injection (BE Mail #2)
- [ ] C6: Public mail delivery endpoint has no protections (BE Mail #3)
- [ ] C7: Clients can post `system` type chat messages (BE Chat #2)

### Important (Tier 1)

- [ ] I1: Path traversal in contacts avatar download (BE Contacts #3)
- [ ] I2: Content-Disposition header injection in drive download (BE Drive #8)
- [ ] I3: Path traversal guard missing in `LocalFilesystem` (BE Core #7)
- [ ] I4: Path traversal guard missing in `LocalKeyStorage` (BE Core #26)
- [ ] I5: Hardcoded auth secret fallback in source (BE Core #5)
- [ ] I6: Calendar shared-with-me allows user ID enumeration (BE Calendar #7)
- [ ] I7: No message content length limit in chat (BE Chat #3)
- [ ] I8: No `limit` parameter validation/capping in chat (BE Chat #5)
- [ ] I9: HTML sanitization does not block CSS tracking in mail (BE Mail #12)

## Session 4: Broken Features Sweep

- [ ] C11: Slides and Sheets MIME type typos in 6 route files (FE Collab #1, FE Sheets #1)
- [ ] C12: Mail download and attachment URLs broken -- missing ownerId segment (FE Mail #1)
- [ ] C10: SharedDrive missing `createSlides` and `createSheets` overrides (BE Drive #2)
- [ ] C37: `validateSearch` drops `uid` in shared routes (FE Drive C2)
- [ ] C40: Sheets `validateSearch` drops `uid` -- same pattern (FE Sheets #2)
- [ ] C14: Waitlist form always submits empty strings (FE Setup #2)
- [ ] C15: Setup wizard uses wrong env variable (FE Setup #1)
- [ ] C36: Storage type "Recommended" label on wrong option (FE Setup #3)

## Session 5: Query Key + Cache Fixes

- [ ] C22: Drive query keys omit `ownerId` -- wrong data across owner switches (FE Shared #2)
- [ ] I38: Direct mutation of TanStack Query cache in mail (FE Mail #3)
- [ ] I49: `useChats` query key missing `ownerId` (FE Chat #4)
- [ ] I34: `MAIL_SENT` SSE handler is a no-op (FE Shared #4)
- [ ] I36: Draft mutations lack `onSuccess` cache invalidation (FE Shared #7)
- [ ] I37: `useSSE` `isConnected` is stale (not reactive state) (FE Shared #8)
- [ ] I48: Chat 5-second polling redundant with SSE (FE Chat #3)

## Session 6: Error Handling Sweep

- [ ] C13: Draft mutations silently swallow errors (FE Mail #2)
- [ ] C27: Missing `error` case in command dispatch -- whisper leak (FE Chat #1)
- [ ] C28: No error handling in `handleSendMessage` (FE Chat #2)
- [ ] I47: No error feedback anywhere in calendar (zero toast calls) (FE Calendar I9)

## Session 7: Data Integrity

- [ ] C18: BCC headers persisted in stored EML (BE Mail #4)
- [ ] C19: `deleteCalendar` orphans shared entries and linked invitations (BE Calendar #2)
- [ ] C20: `getMe()` returns null after self-contact creation (BE Contacts #1)
- [ ] I10: `movePath` allows moving folder into own descendant (BE Drive #5)
- [ ] I11: `movePath` missing write permission check on target parent (BE Drive #6)
- [ ] I12: Folder deletion does not propagate ACL removal for descendants (BE Drive #4)
- [ ] I13: `closeCollabDocument` writes mount total size instead of doc size (BE Drive #7)
- [ ] I16: Race condition in Home cleanup/recreation lifecycle (BE Core #3)
- [ ] I17: `Home.destruct()` opens unresolved databases just to close them (BE Core #4)
- [ ] I18: EML uses hardcoded MIME boundary string (BE Mail #5)
- [ ] I19: `messageDelete` deletes DB before file (inconsistency on failure) (BE Mail #6)
- [ ] I20: Non-atomic flag updates in mail (BE Mail #7)
- [ ] I21: `updateContact` with omitted `labels` strips all labels (BE Contacts #2)
- [ ] I23: No RRULE validation -- malformed rules crash all range queries (BE Calendar #4)
- [ ] I24: Recurring event range query loads ALL recurring events (BE Calendar #5)
- [ ] I25: `updateEvent` returns stale sequence number (BE Calendar #6)
- [ ] I26: Recurring vs non-recurring range filtering inconsistency (BE Calendar #10)
- [ ] I27: Team SSE notifications commented out (BE Calendar #11)
- [ ] I28: `removeMount` does not close mount resources (BE Drive #9)
- [ ] I29: `SharedDrive` inherits broken shared paths methods (BE Drive #3)
- [ ] I30: `getStorageFile` casts S3File to BunFile (S3 previews broken) (BE Drive #10)
- [ ] I31: Per-message WebSocket permission checks cause DB overhead (BE Collab #4)
- [ ] C35: Team calendar save overwrites entire shares array (FE People #2)

## Session 8: Frontend Correctness

- [ ] C23: Rules of Hooks violation -- conditional `useBreadcrumb` (FE Shared #1)
- [ ] C24: `getEventsForDay` drops timed events spanning midnight (FE Calendar C1)
- [ ] C25: RecurrencePicker receives UTC-parsed date (FE Calendar C2)
- [ ] C26: "This and following" delete is a no-op for exceptions (FE Calendar C3)
- [ ] C29: Contacts save indicator never activates (FE Contacts C1)
- [ ] C30: Avatar upload calls `setAvatar` twice (FE Contacts C2)
- [ ] C31: `revokeOtherSessions` checkbox is silently ignored (FE Space C1)
- [ ] C33: Space avatar upload double-processes response (FE Space C3)
- [ ] C34: People keyboard navigation selects wrong member (FE People #1)
- [ ] C38: `markDirty` forward-reference in MarkdownEditor (FE Drive C3)
- [ ] C39: Stale closure in fortune-sheet `onPaste` (FE Sheets #3)
- [ ] C41: Revision restore pushes raw JSON into Y.Array instead of Yjs types (FE Collab #2)
- [ ] C21: `applyOp` crashes if all sheets are hidden (FE Sheets #4)
- [ ] I40: Reply ignores `Reply-To` header (FE Mail #7)
- [ ] I41: Reply All includes self and omits original To recipients (FE Mail #8)
- [ ] I42: `EmailDraft` mutates props during render (cache corruption) (FE Mail #11)
- [ ] I43: Create-event `useEffect` resets form on calendar list change (FE Calendar I1)
- [ ] I44: Edit-event `useEffect` same dependency issue (FE Calendar I2)
- [ ] I45: Edit dialog missing `minTime` on end-time picker (FE Calendar I3)
- [ ] I46: `moveEvent` deletes parent series for exception (FE Calendar M14)
- [ ] I50: `window.location.href` in chat sidebar causes full page reload (FE Chat #5)
- [ ] I51: Auto-scroll fires unconditionally on every message count change (FE Chat #7)
- [ ] I52: Stickies/Slides return stale null refs before Yjs sync (FE Collab #3)
- [ ] I53: Slides font size uses `vh` units (wrong in editor canvas) (FE Collab #8)
- [ ] I54: Profile editor uses imperative fetch instead of query hook (FE Space I1)
- [ ] I55: TOTP secret extraction uses fragile string splitting (FE Space I3)
- [ ] I56: `space-8` is not a valid Tailwind class (missing `y`) (FE Space I4)
- [ ] I57: Index app Login button uses relative URL (FE Setup #5)
- [ ] I58: Never-resolving Promise in authenticated redirect (FE Setup #10)
- [ ] I60: Server settings quota inputs accept NaN/negatives (FE People #3)
- [ ] I61: Unbounded Y.Array growth for ops in sheets (FE Sheets #8)

## Session 9: Code Quality (ongoing)

- [ ] `as any` removal: 12 casts in calendar hooks (FE Shared #5, I35)
- [ ] `as any` removal: 7 casts in people/team/settings hooks (FE People #2, I59)
- [ ] `as any` removal: mail hooks dynamic property access
- [ ] `as any` removal: contacts label hooks (2 casts)
- [ ] `as any` removal: fortune-sheet (36 casts)
- [ ] `interface` to `type` conversion (~60+ instances across all apps)
- [ ] Remove `"use client"` directives from Vite apps (~41 files)
- [ ] Remove `console.log` statements (sheets: 13, collab: 10+, space: 2, SSE: 1)
- [ ] Translate Dutch comments to English (contacts hooks, space, index root, contacts seed)
- [ ] Fortune-sheet cleanup: remaining CSS files, `@ts-ignore` directives (81), Chinese comments
- [ ] Extract duplicated collab utilities (`jsonToYType`, revision restore) to `packages/lib`
- [ ] Hardcoded light-mode colors break dark mode (Drive, Chat, Space, Calendar)
- [ ] Systemic: `ownerId` URL parameter silently ignored across mail, contacts, SSE, calendar, home routes
