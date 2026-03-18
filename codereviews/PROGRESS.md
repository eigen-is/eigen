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

- [ ] NEW: Calendar share permission resolution — individual share (read) overrides team share (write) in `shared_calendars` cache. `propagateCalendarShare` should resolve max permission across all matching shares.

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

- [x] C14: Waitlist form — added `email`, `notes` to useCallback deps
- [x] ~~C15~~: Dropped — false positive, `VITE_API_URL` is standard Vite pattern
- [x] C36: Recommended label moved to `local-fullnames`
- [x] C23: Rules of Hooks — always call `useBreadcrumb`, pass `undefined` pathId when disabled
- [x] C24: `getEventsForDay` — range-overlap check for timed events (startTime < dayEnd && endTime > dayStart)
- [x] C25: RecurrencePicker — `new Date(startDate + 'T00:00:00')` forces local parsing
- [ ] C26: Deferred — "This and following" delete for exceptions needs parent rrule fetch
- [x] ~~C27~~: Dropped — false positive, no `error` kind exists in `getLocalCommand`
- [ ] C28: No error handling in `handleSendMessage` — needs try/catch + toast
- [x] C29: Contacts save indicator — removed unused local mutations, use `form.formState.isSubmitting`
- [x] C30: Avatar upload — removed duplicate `setAvatar` after `response.ok`
- [x] C31: `revokeOtherSessions` — removed hardcoded `true`, pass through from form data
- [x] C33: Space avatar — removed duplicate `setAvatar` after `response.ok`
- [x] C34: People keyboard nav — `getId` now uses `m.id` consistently
- [x] ~~C38~~: Dropped — false positive, closure captures `markDirty` correctly
- [x] ~~C39~~: Dropped — low confidence, `context` is in dependency array
- [x] ~~C41~~: Dropped — false positive, `Y.Array.push` accepts plain JSON values
- [x] C21: `applyOp` — guard `shownSheets.length > 0` before accessing `[0].id`

### Important

- [x] I34: `MAIL_SENT` SSE handler — added `invalidateMailboxes` + `invalidateHomeSize`
- [x] I36: Draft mutations — added `onSuccess` cache invalidation for update + send
- [ ] I37: `useSSE` `isConnected` stale — needs useState for connection status
- [x] I38: Direct cache mutation — replaced with immutable `.map()` spread
- [x] I40: Reply — checks `email.replyTo || email.from`, prevents `RE: RE:` stacking
- [x] I41: Reply All — merges From + To + CC, filters out self
- [x] I42: `EmailDraft` — uses `useMemo` to derive `draft` from props without mutation
- [ ] I43: Deferred — create-event useEffect form reset on calendar list change
- [ ] I44: Deferred — edit-event useEffect same issue
- [x] I45: Edit dialog — added `minTime={addMinutes(startTime, 15)}`
- [ ] I46: Deferred — moveEvent deletes parent series (needs design)
- [x] I47: Calendar error feedback — added `toast.error()` in create + edit catch blocks
- [x] I48: Chat polling — removed redundant `refetchInterval: 5000` (SSE handles invalidation)
- [x] ~~I49~~: Already fixed with C22 (ownerId in drive query keys)
- [ ] I50: Chat `window.location.href` — needs router navigate
- [x] ~~I51~~: Dropped — could not verify, auto-scroll code not found
- [x] ~~I52~~: Dropped — UX loading state concern, not a bug
- [x] I53: Slides — replaced `vh` units with `cqh`/`cqw` container query units, 16:9 enforced
- [ ] I54: Profile editor imperative fetch — needs query hook
- [x] I55: TOTP secret — `new URL(...).searchParams.get('secret')`
- [x] I56: `space-8` → `space-y-8`
- [x] I57: Login button — `./space/` → `/space/`
- [x] ~~I58~~: Dropped — works in practice, standard cross-app redirect pattern
- [x] I60: Quota inputs — guard `isNaN(value) || value < 0`
- [x] ~~I61~~: Dropped — unverified, needs sheets app investigation
- [x] NEW: Calendar share permission — re-resolves max permission across individual + team shares in `syncTeamCalendars`

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
