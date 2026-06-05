# Eigen Code-Quality Audit

> **Generated 2026-06-04 (overnight, multi-agent run).** Parts A & B complete — **22 dimensions,
> 180 verified findings** (104 structural/UX + 76 correctness/security/perf/maintainability). An
> adversarial pass re-verified all 31 high-impact findings against the code — **29 confirmed, 2 narrowed,
> 0 disputed** (see the Verification ledger). Nothing was modified — this is a findings report.

## Executive summary

**Eigen is fundamentally healthy.** The architecture is sound, the standards in `docs/CODE-STANDARDS.md`
are real and largely followed, and the *lint-catchable* drift is **already controlled** (0 `useQuery` in
app components, ~0 raw `clsx`, 0 real `as any`). The risk as the codebase grows is **not rot** — it is two
specific things:

1. **Re-derivation from primitives that aren't discoverable.** The single largest theme. The same hook,
   component, route-guard, or registry is rebuilt per app and then *drifts* — because finding the canonical
   one is harder than rewriting it. This is the AI-slop vector, and it is overwhelmingly fixable by
   collapsing each copy back onto one shared primitive **and making that primitive findable**
   (`docs/CODE-STANDARDS-ENFORCEMENT.md` Tier 5: a generated `SHARED-PRIMITIVES.md` catalog + barrel
   exports + a "search before you build" instruction).
2. **A thin layer of reachable correctness / security / test-integrity bugs** that accumulated faster than
   review caught them. Almost none are architectural; nearly all are small, source-level fixes.

Two dimensions need **prompt action**: **test integrity** (ACL and collab-WebSocket security tests pass
*vacuously* — you appear covered but aren't) and **authorization** (an unguarded mount-list method leaks
every user's/team's mounts). Everything else is proactive hygiene that keeps Eigen easy to extend.

### Recommended action plan

**🔴 Tier 1 — Do first (reachable security, correctness & test-integrity)**

> **Implementation status (2026-06-05, branch `fix/audit-tier1`).** Landed: items 1, 2, 4, 5, 6,
> 8, the iMIP-SEQUENCE half of 7, and the stored-XSS (`nosniff` + scoped sandbox CSP) and
> OTP-atomicity halves of 9. **Reverted after review as misjudgments of *intentional* design:**
> item 3 (SSRF) — blocking the S3 endpoint breaks self-hosted MinIO-on-LAN and first-run setup is
> a trusted-operator window; and the `/p/users` auth-gate inside item 9 — `/p/` is the deliberate
> **public** API surface (sits beside `/p/avatar`, `/p/config`). **Deferred:** the VTIMEZONE half
> of item 7 (interop-only; the audit's suggested `@ical.js/timezones` package does not exist — it
> needs a real tz-data dependency such as `@touch4it/ical-timezones`). Two independent reviews
> (incl. a fresh Opus pass) confirmed the landed set; the lesson — audit *findings*, not just
> their fixes, can misread design intent — is in project memory.

| # | Item | Dimension | Where |
|---|------|-----------|-------|
| 1 | `SharedDrive.listMounts()` has no authorization guard — leaks every user's/team's mount list | Authz | §Security |
| 2 | ACL access-denial tests pass vacuously (`driveGet` turns 403 → `[]`); 5 collab-WS security tests `return` before asserting | Testing | §Testing |
| 3 | SSRF via caller-controlled S3 endpoint, unauthenticated on first-run setup | Security | §Security |
| 4 | `closeCollabDocument` deletes the map entry *after* destruct → hands a closing doc to concurrent openers | Async | §Error/async |
| 5 | `getHome` race overwrites a just-set factory → orphans a fully-initialised Home | Async | §Error/async |
| 6 | Calendar `event-range` route: missing return type hides a **cancelled event leaking into free/busy** | Type safety | §Type safety |
| 7 | iMIP `REQUEST` applied with no `SEQUENCE` guard (stale/replay overwrites live events); iCal emits `TZID` with no `VTIMEZONE` (shifts times in strict CalDAV clients) | Standards | §Standards |
| 8 | Yjs collab hooks leak `UndoManager`/observers/WS-provider on doc-switch | Lifecycle | §Lifecycle |
| 9 | Inline-HTML stored XSS at `/embed` (no `nosniff`/CSP); non-atomic OTP (one code → two sessions); unauthenticated `/p/users` enumeration | Security | §Security |

**⚡ Tier 2 — Quick wins (high-impact, small-effort, mostly unifying)**

| # | Item | Dimension | Where |
|---|------|-----------|-------|
| 10 | Collapse **3 drifting text-file extension/MIME registries** into one (`isInlineEditable`) — they already disagree | Duplication | §Duplication |
| 11 | One `EigenDocEditorGuard` for the **4 near-identical editor routes**; one `eigenDocEditorValidateSearch` | Duplication | §Duplication |
| 12 | `EmailList`/`EmailSidebar` silently swallow load errors → show "No emails found" on failure | UX / Smell | §UX |
| 13 | `onRowActivate` copied across 3 drive routes — **live bug**: preview next/prev broken from Shared view | Duplication | §Duplication |
| 14 | `sidebarMode:'hidden'` is dead **and** silently breaks the admin teams view | Dead code | §Dead code |
| 15 | Memo the `LayoutContext` value (fresh object every `AppShell` render → app-wide re-render cascade) | Frontend perf | §Performance |
| 16 | Accessible-names sweep: icon-only controls + clickable `div`s lack names/keyboard paths (weakest dimension) | A11y | §Accessibility |
| 17 | Typed `getTeamHome`/`getUserHome` helpers to kill the raw `as TeamHome` casts in routes | Smell | §Code smells |
| 18 | Slides has no mobile Edit menu → **undo/redo unreachable** on tablet/narrow windows | UX | §UX |
| 19 | Wire up `knip` and sweep the confirmed dead-export vein in one pass | Dead code | §Dead code |

**🏗️ Tier 3 — Structural (medium-effort, high-leverage)**

| # | Item | Dimension | Where |
|---|------|-----------|-------|
| 20 | Fix the ~20-site frontend pattern where a failed `mutateAsync` leaves dialogs/forms stuck open | Error handling | §Error/async |
| 21 | Generate `docs/SHARED-PRIMITIVES.md` + add missing barrel exports (`SearchBar`, `DriveLayout`, 5 type files) — the structural cure for re-derivation | Discoverability | §Discoverability |
| 22 | Move the `canWrite` gate for import/export/convert out of routes into the Drive layer | Smell / Authz | §Code smells |
| 23 | Memoise `MonthView`/`WeekView` (O(days × events) every render); cache the sheet-export snapshot parse | Frontend perf | §Performance |

## Quality scorecard

A heat-map, not a verdict — grades reflect both health and *urgency*, and should be read alongside the
evidence (the "High" column is the count of high-impact verified findings). Re-running this audit after
fixes turns the scorecard into a regression gauge.

**Legend:** 🟢 Strong · 🟡 Solid (cleanup only) · 🟠 Watch (notable issues, some high) · 🔴 Action (reachable high-severity)

| Pillar | Dimension | Grade | High | Note |
|---|---|:--:|:--:|---|
| **A. Maintainability** | 1. Duplication / re-derivation | 🟠 | 3 | Pervasive but shallow drift; root cause is discoverability |
| | 2. Over-engineering | 🟢 | 0 | Genuinely disciplined — most "complexity" is load-bearing |
| | 3. Readability / complexity | 🟠 | 3 | God files + type-chain leaks + the EmailList error-swallow (1 narrowed to medium) |
| | 4. Dead code & cruft | 🟡 | 2 | Low-impact; wire up `knip`; one dead variant is a real bug |
| | 5. Module boundaries & deps | 🟡 | 1 | Structurally sound; type-reexport + DOM-in-backend tidies |
| | 6. Naming & discoverability | 🟠 | 1 | `isMobile`/`useSearch` collisions + missing barrels = the AI-slop root |
| | 7. Documentation accuracy | 🟠 | 1 | Half-documented `ServerSettings`; dead doc links (narrowed to medium) defeat "findable" |
| | 8. Test quality & coverage | 🔴 | 3 | ACL/WS security tests pass **vacuously**; 507 path untested — green but isn't |
| **B. Correctness** | 9. Type safety & type chain | 🟠 | 2 | Chain intact, but `as` casts hid 2 real backend bugs |
| | 10. Error handling & resilience | 🟠 | 1 | ~20-site stuck-dialog pattern; single global `ErrorBoundary` |
| | 11. Async & concurrency | 🟠 | 2 | Two reachable core races (collab close, `getHome` overwrite) |
| | 12. State & cache correctness | 🟡 | 0 | Minor coherence gaps (draft rollback, stale Sent folder) |
| | 13. Resource lifecycle & leaks | 🟡 | 1 | Yjs hooks leak on doc-switch; otherwise clean |
| **C. Security** | 14. Path / header input safety | 🟠 | 1 | Pre-auth SSRF on first-run S3 setup; inline-HTML stored XSS |
| | 15. Authorization & access control | 🔴 | 1 | Unguarded `listMounts()` leaks all mounts; enumeration; non-atomic OTP |
| **D. Performance** | 16. Backend efficiency | 🟡 | 0 | Serial-await / per-call DB round-trips — cheap mechanical wins |
| | 17. Frontend efficiency | 🟠 | 1 | App-wide `LayoutContext` re-render cascade (calendar O(days×events) narrowed to medium) |
| **E. Product quality** | 18. Cross-app UX consistency | 🟠 | 2 | Slides loses mobile undo/redo; mail swallows load errors |
| | 19. Accessibility | 🟠 | 2 | Weakest dimension: icon-only controls + clickable divs lack names/keyboard |
| | 20. Convention adherence | 🟡 | 0 | Real but shallow; lint-drift already controlled |
| | 21. API surface consistency | 🟡 | 1 | Mostly consistent; chat `limit` silent-zero + S3 empty-creds schema |
| | 22. Protocol & standards conformance | 🟠 | 2 | iMIP `SEQUENCE` replay; iCal `TZID` without `VTIMEZONE` |

---

## Verification ledger

All 31 high-impact findings were independently re-checked by adversarial verifiers that read the actual
code and tried to **refute** each one. **Result: 29 confirmed, 2 narrowed in scope, 0 disputed** — and
three had their severity corrected from high to medium. Where this ledger and a Part A/B section disagree,
trust the ledger. Verifiers also surfaced several bonus issues (below the table).

| # | Finding | Verdict |
|---|---------|---------|
| #1 | Two drifting extension/MIME registries for "is this a text file?" | ✅ Confirmed |
| #2 | `onRowActivate` copied across three drive routes (with a live preview bug) | ✅ Confirmed |
| #3 | Four near-identical EigenDoc editor routes | ✅ Confirmed |
| #4 | Type-safe getTeamHome / getUserHome instead of raw `as TeamHome` casts in routes | ✅ Confirmed |
| #5 | Move the `canWrite` gate for import/export/convert out of routes and into the Drive layer | ◑ Narrowed · sev → medium |
| #6 | Collapse the `*ById` / `*ByIds` mail-action pairs and the four `forEach` adapters | ✅ Confirmed |
| #7 | EmailList silently swallows its `error` prop — load failures show "No emails found" | ✅ Confirmed |
| #8 | Slides has no mobile Edit menu — undo/redo is unreachable on tablet/narrow windows | ✅ Confirmed |
| #9 | EmailList and EmailSidebar silently swallow load errors | ✅ Confirmed |
| #10 | `sidebarMode: 'hidden'` is a dead variant — and silently breaks the admin teams view | ✅ Confirmed |
| #11 | Wire up `knip` and sweep the confirmed dead exports | ✅ Confirmed |
| #12 | Calendar event-range route: missing return type hides a cancelled-event free/busy bug | ✅ Confirmed |
| #13 | Backend route handlers lack return types; `updateLabel` leaks the raw DB row | ✅ Confirmed |
| #14 | Frontend: unhandled `mutateAsync` rejections leave dialogs/forms stuck open | ✅ Confirmed |
| #15 | `closeCollabDocument` deletes the map entry after destruct, handing a closing doc to concurrent openers | ✅ Confirmed |
| #16 | `getHome` race unconditionally overwrites a just-set factory, orphaning a fully-initialised Home | ✅ Confirmed |
| #17 | SSRF via caller-controlled S3 endpoint (unauthenticated on first-run setup) | ✅ Confirmed |
| #18 | `SharedDrive.listMounts()` has no authorization guard | ✅ Confirmed |
| #19 | LayoutContext value is a fresh object literal on every AppShell render | ✅ Confirmed |
| #20 | MonthView / WeekView recompute O(days × events) on every render | ✅ Confirmed · sev → medium |
| #21 | ACL access-denial tests pass vacuously because driveGet turns 403 into [] | ✅ Confirmed |
| #22 | Five collab WebSocket security tests are structurally dead — they `return` before asserting | ◑ Narrowed |
| #23 | Mount capacity quota (507 Insufficient Storage) has zero integration coverage | ✅ Confirmed |
| #24 | Icon-only controls have no accessible name | ✅ Confirmed |
| #25 | Interactive divs used as buttons (no keyboard path) | ✅ Confirmed |
| #26 | SERVER-SETTINGS.md documents only half of the `ServerSettings` type | ✅ Confirmed |
| #27 | WEBDAV.md links to three docs that don't exist | ✅ Confirmed · sev → medium |
| #28 | Yjs collab hooks leak UndoManager, observers, and the WS provider on teardown | ✅ Confirmed |
| #29 | S3 mount schema duplicated inline in `team.ts`, weaker than the canonical `s3ConfigBody` | ✅ Confirmed |
| #30 | iMIP REQUEST applied without a SEQUENCE guard (stale/replay overwrites live events) | ✅ Confirmed |
| #31 | iCalendar emits DTSTART;TZID / RECURRENCE-ID;TZID with no VTIMEZONE component | ✅ Confirmed |

### Severity corrections (high → medium)

- **#5 — `canWrite` gate.** The *convert* route is already write-gated inside `SharedDrive.create`; only the
  *import* routes rely solely on the route-level check. The current code is correct — the risk is future
  drift, so this is an architectural-hygiene fix, not a live hole.
- **#20 — calendar O(days × events) render.** The week-grid rebuild is trivially cheap; the real cost is N
  filter passes per render, unlikely to be user-visible at realistic event counts. Worth fixing for clarity.
- **#27 — WEBDAV.md dead links.** No code path breaks; only contributor navigation degrades.

### Bonus issues the verifiers surfaced

- **🐛 New bug — mail Trash deletion skips its confirm dialog.** `handleDeleteEmailById` is passed to
  `EmailDetailToolbar` without the `needsConfirmation` wrapper that `handleDeleteEmailsByIds` gets, so
  deleting a Trash email from the detail toolbar bypasses confirmation
  (`apps/mail/src/routes/_auth.$filterType.$filterId.tsx:150` vs `:117-123`). Resolved by the #6 refactor.
- **#2 has a third copy.** The MIME route (`_auth.mime.$mimeType.tsx:76`) omits the preview sibling array
  too — the broken-next/prev bug is **three** sites, not two.
- **#9 — `EmailSidebar` is worse than "swallowed".** It *does* read `error` (line 102) but renders phantom
  UI rather than a proper error state.
- **#17 — second unauthenticated surface.** `/setup/complete` also calls `checkS3Connection` unauthenticated
  during first-run (`setup.ts:275`); fix it alongside `/setup/s3check`.
- **#22 undercounts.** **Seven** tests carry the dead `return` guard, not five; and two "read-only user"
  tests assert only `ws.readyState > 0` — too weak to verify the security property even once the WS test
  environment is fixed.
- **#24 — `TooltipButton` caveat.** Its `label` prop renders as visible text, not `aria-label`, so it can't
  supply an accessible name when `label` is undefined (the default at the cited call sites).
- **#28 — sheets nuance.** `use-sheet.ts` does *not* create a `Y.UndoManager` (only `use-board.ts` /
  `use-deck.ts` do); the sheets leak is limited to unregistered observers + disconnect-vs-destroy. The core
  leak finding stands for all three hooks.
- **#12 / #13 / #31 — minor.** Cancelled-event filter belongs at `calendar.ts:167` (the recurring path
  already guards); `chat.ts:15` GET is already annotated (only the POST isn't); `ical.js ^2.2.1` is already
  a dependency, so the iCal fix needs no new package.

---

## About this report

### What it is

A proactive, whole-codebase audit aimed at keeping Eigen **easy to extend** as it grows. Each finding is
prioritized by **impact ÷ effort**, with concrete `file:line` locations and a concrete, *flat-and-direct*
fix. Findings whose "fix" was an inheritance base class, an extra indirection layer, or moving server-only
data into the FE bundle were **deliberately dropped** — they trade the project's "flat, direct, simple"
bar for ceremony the standards reject.

### Method

Multi-agent fan-out, then adversarial synthesis:

- **Round 1 (Part A):** 23 auditors → 166 raw findings → 6 synthesis leads that **verified each finding by
  re-reading the cited code**, deduped, and prioritized → 104 kept.
- **Round 2 (Part B):** 17 auditors → 117 raw findings → 11 synthesis leads, same discipline → 76 kept.
- **Excluded:** `packages/sheet` *internals* (forked engine, own campaign in `docs/TODO-SHEETS.md`).
  `apps/sheets` and the sheet↔lib boundary are in scope.

### Criteria — the 22 dimensions

| Pillar | Dimensions |
|---|---|
| **A. Maintainability & evolvability** | Duplication · Over-engineering · Readability/complexity · Dead code · Module boundaries · Naming/discoverability · Docs accuracy · Test quality |
| **B. Correctness & reliability** | Type safety · Error handling · Async/concurrency · State/cache · Resource lifecycle |
| **C. Security** | Path/header safety · Authorization |
| **D. Performance & efficiency** | Backend efficiency · Frontend efficiency |
| **E. Product quality & consistency** | UX consistency · Accessibility · Convention adherence · API consistency · Standards conformance |

### How to read the sections

Within each section, findings are ordered **highest impact ÷ effort first** — the top 2–3 of each are the
ones genuinely worth doing. The **Impact / Effort / Confidence** tags let you batch a quick-wins sprint
(small-effort, high-confidence) separately from the structural refactors.

---

## Part A — Structural & UX quality

| Dimension | Kept / Raw | Takeaway |
|---|---|---|
| **Duplication & re-derivation** | 18 / 53 | Canonical primitives re-derived per app and **drifted** — wrong 404/access messages, a broken preview sibling-array, divergent text-file extension sets. |
| **Over-engineering** | 11 / 20 | Pass-through wrappers, never-varied options objects, dead props — flatten with no behaviour change. |
| **Code smells** | 24 / 32 | Type-chain leaks + ACL/error-handling contract breaks + re-derived scaffolds (a 789-line god editor). |
| **UX inconsistency** | 14 / 17 | Shared chrome exists but apps diverge; **slides loses mobile undo/redo**, **mail swallows load errors**. |
| **Convention drift** | 17 / 24 | Shallow, high-confidence lint gaps + 2 real cross-app inconsistencies. |
| **Dead code** | 20 / 20 | Every item verified real; wire up `knip`; admin `sidebarMode='hidden'` is dead **and** silently broken. |
## Duplication & Re-derivation — unify into shared primitives

Of the 53 raw findings, the ones that survive are concrete re-derivations where a canonical primitive already exists (or trivially should) and the copies have measurably *drifted* — wrong messages, broken sibling-arrays, divergent extension sets. Findings whose "fix" was an inheritance base class, an Elysia `.derive()` indirection, or moving server-only data into the FE bundle were dropped or de-prioritised: they trade the project's "flat, direct, simple" bar for ceremony the enforcement doc explicitly tells us not to add. The highest-leverage items below collapse a whole class of drift (one extension registry, one editor-route guard, one event-form hook) rather than tidying a single call site.

### Byte-identical invalidation functions split by name only
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `packages/lib/src/core/calendar/hooks/use-calendar.ts:322-332` (`invalidateEventCreated` / `invalidateEventUpdated` / `invalidateEventDeleted`) and `:338-345` (`invalidateCalendarShared` / `invalidateCalendarUnshared`); `packages/lib/src/core/mail/hooks/use-emails.ts:206-224` (`invalidateMailReadChanged` / `invalidateMailFlagsChanged`)
- **Problem:** The three calendar event invalidators have *identical* bodies (`invalidateQueries({ queryKey: calendarKeys.events(ownerId) })`); the two share/unshare invalidators are also identical to each other; the two mail invalidators are identical. The names carry no behavioural information, yet every new SSE case must pick one. This actively hides a correctness subtlety: `calendar/sse-handlers.ts:51-65` calls the event invalidators with `userId` for iMIP invites but `event.ownerId` for CRUD — both work *only because the bodies are the same*, so the three-way split makes that equivalence invisible.
- **Proposal:** Collapse to one function per real invalidation shape: `invalidateCalendarEvents(queryClient, ownerId)`, `invalidateSharedCalendars(queryClient, ownerId)`, and `invalidateMailMessageChanged(queryClient, ownerId, messageId, mailbox)`, all kept next to their query-key factories. The iMIP SSE branches then read explicitly as `invalidateCalendarEvents(queryClient, userId)`. Net: 7 functions → 3, and the shared scope is documented by the single name.

### Two drifting extension/MIME registries for "is this a text file?"
- **Impact:** high  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `packages/lib/src/types/drive.ts:190-288` (`INLINE_EDITABLE_EXTENSIONS`, `INLINE_EDITABLE_MIMES`, `isInlineEditable`), `packages/lib/src/constants/preview.ts:1-105` (`CODE_EXTENSIONS`, `CODE_MIMES`, `getTextPreviewMode`), `packages/lib/src/core/file-presentation.ts:27-38` (a third, private `CODE_MIMES`)
- **Problem:** Three independent `Set`/array declarations answer the same question across the same corpus, and they have *already diverged*: `drive.ts` lists `.markdown`, `.txt`, `.env.local`, `.env.example` that `preview.ts` omits; `preview.ts` puts `.csv` in its code set; `file-presentation.ts`'s `CODE_MIMES` is a different exact-match list again. The result is that "this file is editable" and "this file previews as code" silently disagree for some types, and the file-icon picker disagrees with both. New file types get added to one list and forgotten in the others — the canonical re-derivation failure the enforcement doc names.
- **Proposal:** Make `packages/lib/src/types/drive.ts` the single registry (it already owns `isInlineEditable`). Delete `CODE_EXTENSIONS`/`CODE_MIMES` from `preview.ts` and have `getTextPreviewMode` fall through to `isInlineEditable(mimeType, fileName)` for the generic `'code'` case, keeping only its unique eigen-doc MIME checks. In `file-presentation.ts`, drop the private `CODE_MIMES` and reach the `FileCode` branch via `isInlineEditable`. One list, three thin consumers.

### `onRowActivate` copied across three drive routes (with a live preview bug)
- **Impact:** high  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/drive/src/routes/_auth.fs.$ownerId.$mountId.$pathId.tsx:104-121`, `apps/drive/src/routes/_auth.shared.$to.tsx:64-79`, `apps/drive/src/routes/_auth.mime.$mimeType.tsx:65-80`
- **Problem:** All three routes hand-roll the same activate ladder (folder → `navigate`; eigen-doc → `openDocument`; `isInlineEditable` → `/edit`; else → `openPreview`). It has already drifted: the Shared route calls `openPreview(path)` with **no sibling array**, while the fs route passes `openPreview(path, folderContents)` — so next/previous navigation in the preview lightbox is broken for files opened from the Shared view. The mobile `onRowSelect` path is copied the same way.
- **Proposal:** Extract `useDriveRowHandlers({ onFolderNavigate, openPreview, navigate, isMobile, folderContents })` into `packages/ui/src/components/layout/drive/` (or fold it into `DriveLayout`, which already receives `onRowActivate` as a prop). Each route supplies only its `onFolderNavigate` target; the shared hook composes the rest and fixes the sibling-array bug in one place.

### NotFound / AccessDenied are byte-identical wrappers of EmptyState — one with a wrong message
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `packages/ui/src/components/layout/app/not-found.tsx`, `packages/ui/src/components/layout/app/access-denied.tsx`, `packages/ui/src/components/layout/app/empty-state.tsx`
- **Problem:** `NotFound` and `AccessDenied` are structurally identical to each other and to `<EmptyState message="…" />` minus the `icon`/`action` slots — same wrapper, same classes, same default copy *"Encountering the null vector: a rendezvous with nothing at all."* For `AccessDenied` that default is simply wrong (it should mention permissions). They exist only because they were scaffolded independently, and `EmptyState` has since grown `icon`/`action` props neither inherited.
- **Proposal:** Delete both files; replace the four call sites (`apps/admin/src/routes/_auth.tsx`; the three drive `_auth.*` routes) with `<EmptyState message="…" />` using a caller-supplied, semantically correct message, and remove the exports from the `app/` barrel.

### Four near-identical EigenDoc editor routes
- **Impact:** high  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/docs/src/routes/_auth.doc.$ownerId.$mountId.$pathId.tsx`, `apps/slides/src/routes/_auth.slide.$ownerId.$mountId.$pathId.tsx`, `apps/stickies/src/routes/_auth.board.$ownerId.$mountId.$pathId.tsx`, `apps/sheets/src/routes/_auth.sheet.$ownerId.$mountId.$pathId.tsx`
- **Problem:** All four share the same `validateSearch` (the `chat` param), the same `useEigenDocEditorRoute` call, the same `LoadingState` → `RequestAccessView` guard, and the same trailing `DriveAccessDialog`. Only the route-path string and the editor component differ — ~35 lines of scaffolding repeated four times. This is the exact "4× EigenDoc route" example the enforcement doc cites as the model re-derivation to unify. The inline `chat` `validateSearch` duplication is doubly avoidable: `eigendoc-config.ts` already exports `eigenDocValidateSearch` for the *list* routes.
- **Proposal:** Add `eigenDocEditorValidateSearch` next to the existing `eigenDocValidateSearch` in `packages/ui/src/components/layout/drive/eigendoc-config.ts` (one-line win, do immediately). Then add an `EigenDocEditorGuard` wrapper in the same directory that owns the loading/access/dialog shell and takes the editor as a child, reducing each route to a config-only stub.

### Two `_auth.tsx` guard variants copied across ten apps
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `_auth.tsx` in `apps/{docs,slides,stickies,sheets,chat,drive}` (basic redirect-to-login, byte-identical) and `apps/{calendar,contacts,mail,space}` (redirect + guest-redirect-to-drive, byte-identical)
- **Problem:** There are exactly two bodies, copied ten times. Any change to the auth flow (a new redirect condition) means editing ten files. The pattern already mirrors `createLoginRouteOptions`, which exists at `packages/ui/src/components/layout/pages/login-route.tsx:19`.
- **Proposal:** Add `createAuthRouteOptions({ redirectGuests }?)` beside `createLoginRouteOptions`. Each `_auth.tsx` collapses to `export const Route = createFileRoute('/_auth')(createAuthRouteOptions())` (or `{ redirectGuests: true }`). The admin app's `_auth.tsx` does a real org-membership check and stays bespoke.

### `calendarOptions` derivation duplicated across the two event dialogs
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/calendar/src/components/create-event-dialog.tsx:38-51`, `apps/calendar/src/components/edit-event-dialog.tsx:71-84` (and the same data fetched again in `calendar-sidebar.tsx`); type `CalendarOption` in `apps/calendar/src/components/calendar-utils.ts:4`
- **Problem:** Both dialogs call `useCalendars` + `useSharedCalendars` + `useMyTeams` and build `CalendarOption[]` via a **byte-identical** `useMemo` (personal calendars, then write-permitted shared calendars via `resolveCalendarName`). Both also define their own `toTimeString`/`toLocalTimeString` pad helper. Any future permission-rule change must be applied in three places. This is the small, high-confidence core of the larger "the two event dialogs duplicate the whole form" finding.
- **Proposal:** Add `useWritableCalendarOptions(ownerId): CalendarOption[]` to `packages/lib/src/core/calendar/hooks/` and move `CalendarOption` into `packages/lib/src/types/calendar.ts`; all three call sites collapse to one line. Move the time-pad helper next to `addMinutes`/`timeToMinutes` in `time-select.ts`. (The fuller `<EventFormFields>` extraction is a reasonable follow-on once the hook lands, but the hook + type move is the de-risked first step.)

### Shared DAV XML primitives copied between WebDAV and CalDAV
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/caldav/xml-builder.ts:11-21,72-79`, `apps/api/src/lib/webdav/xml.ts:5-28`
- **Problem:** `escapeXml` is **byte-for-byte identical** in both files (RFC-correctness-sensitive: a new character to escape must be fixed twice). `response`, `propstatOk`, and `propstatNotFound` are functionally identical, differing only in whitespace. CalDAV is a protocol layer on top of WebDAV emitting the same `DAV:` multistatus wire format, so the split is incidental.
- **Proposal:** Extract `escapeXml`, `response`, `propstatOk`, `propstatNotFound` into `apps/api/src/lib/webdav/dav-xml.ts` (webdav is the right home). Both files import them; the CalDAV-specific props (`calendarCollectionProps`, `multistatus` with extra namespaces) and the WebDAV resource props stay where they are. The byte-identical `escapeXml` is the zero-risk core; unifying the propstat helpers also normalises whitespace harmlessly.

### Collab data.db read preamble repeated across the document readers
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/document/doc.ts:15-27`, `apps/api/src/lib/document/slides.ts:59-66,90-93`, `apps/api/src/lib/document/sheets.ts:13-18`
- **Problem:** Each `readXxxContent` opens its Yjs doc with the identical four steps: `getChildByName(id, 'data.db')` → null-throw with a domain-specific message → `mount.openDatabase(COLLAB_DB_CONFIG, …)` → `loadYjsState`. Separately, the three-line `media/` resolution (`getChildByName('media')` → `listFolder` → `new Map(children…)`) is byte-identical in `doc.ts` and `slides.ts`. A fourth content reader will copy both again.
- **Proposal:** Two flat free functions in `apps/api/src/lib/document/` (not a class): `openCollabYjsDoc(mount, drivePath, label)` (preamble; `label` preserves the per-type error message) and `readMediaByName(mount, drivePath)` (the media map). Doc/slides use both; sheets uses only the first. Stays flat and direct — no service layer.

### `GuestUserDropdown` re-derives most of `UserDropdown`
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `packages/ui/src/components/layout/app/topbar.tsx:129-168` (guest) and `:171-244` (full)
- **Problem:** The two components share the entire shell — `useLogout`, the `LogoutDialog` + `AboutDialog` state, the `DropdownMenu` trigger with `UserAvatar`, the About and Log-out items. `UserDropdown` only *adds* Profile/Settings/Theme. The guest variant is the full one with three items removed, i.e. re-derivation rather than extension.
- **Proposal:** Merge into a single `UserDropdown({ rootRoute, isGuest })` that always renders the shared shell and conditionally renders Profile/Settings/Theme when `!isGuest`. The dialog state lives once; `LogoutDialog` (a 6-line `ConfirmDialog` wrapper with no other caller) inlines as a fragment.

### Auto-resize chat textarea duplicated between input and inline-edit
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `packages/ui/src/components/layout/chat/chat-message-input.tsx:298,304`, `packages/ui/src/components/layout/chat/chat-message-list.tsx:157,178,194`
- **Problem:** The auto-grow logic (`style.height = 'auto'` then `${Math.min(scrollHeight, 120)}px`) and the full className string (`flex-1 min-w-0 resize-none rounded-lg border bg-background px-3 py-2.5 text-sm … min-h-[40px] max-h-[120px] leading-[1.125]`) are copy-pasted between `ChatMessageInput` and the `InlineEdit` helper in `ChatMessageList`. The 120px cap and the class string are both duplicated; a design change touches both files.
- **Proposal:** Extract a small `AutoResizeTextarea` (or `useAutoResizeTextarea(ref, max = 120)`) into `packages/ui/src/components/layout/chat/`. The className and the cap become single constants. Both call sites consume it; `InlineEdit` stays a private helper. No package boundary crossed.

### Avatar-picker scaffold duplicated, carrying bare `console.error` catches
- **Impact:** medium  ·  **Effort:** medium  ·  **Confidence:** high
- **Where:** `apps/space/src/components/space/profile-editor.tsx:95-150`, `apps/contacts/src/components/contacts/contact-edit.tsx:180-230`
- **Problem:** Both components rebuild the same picker: a hidden `<input type="file">`, `useUpload()` + `uploadWithProgress()`, a `DropdownMenu` camera button over `UserAvatar`, and the same `try/catch` that ends in `console.error`. It has already drifted (profile-editor has a "Remove avatar" item contact-edit lacks), and the duplicated `try/catch` + `console.error` in app components violates the project's "no error handling in app components" rule.
- **Proposal:** Extract `<AvatarPicker imageUrl uploadUrl onAvatarChange />` next to `UserAvatar` in `packages/ui`. Callers pass the URL and receive the new one via callback; the upload error handling lives in one place instead of two bare catches.

### Stickies re-derives shared comment-card primitives instead of `readCards` / `useCommentLifecycle`
- **Impact:** medium  ·  **Effort:** medium  ·  **Confidence:** high
- **Where:** `apps/stickies/src/components/stickies/hooks/use-board.ts:122-159` vs `packages/lib/src/core/comments/hooks/use-comment-cards.ts:5-48`; `apps/stickies/src/components/stickies/board.tsx:68-127` vs `packages/lib/src/core/comments/hooks/use-comment-lifecycle.ts`
- **Problem:** `useBoard.updateReactState` hand-rolls a field-by-field `CommentCard` deserialiser (every field with the same `typeof` guards) that already exists as the exported `readCards(map)` — which even supports the `'tasks'` map name. Separately, `board.tsx` manually assembles `useComments` + create/update card hooks rather than `useCommentLifecycle` (which slides and sheets use), so stickies has no `unresolvedCount` badge and no resolve action. Future `CommentCard` fields must be added in two places, and the resolve/badge UX silently lags the other apps.
- **Proposal:** Have `useBoard` call `readCards(tasksMap)` for the card read (keep the local `sameCard` identity check if a benchmark justifies it). Then extend `useCommentLifecycle` to accept `mapName?: 'comments' | 'tasks'` (its sub-hooks already do) and adopt it in `board.tsx`, wiring `unresolvedCount` into the stickies toolbar to close the UX gap.

### Client-side mail search re-implements the backend FTS5 index
- **Impact:** medium  ·  **Effort:** medium  ·  **Confidence:** high
- **Where:** `apps/mail/src/components/mail/email-list.tsx:70-80` vs `packages/lib/src/core/search/hooks/use-search.ts` + the `mail.db` FTS5 index (`apps/api/src/lib/mail/maildb.ts` `searchMail`)
- **Problem:** `EmailList` filters the already-fetched list with `subject/fromShort/textShort .toLowerCase().includes()`. This loads every email before filtering, misses `bm25` relevance ranking, can't search body text past the 200-char `textShort` preview, and can't cross mailboxes — re-deriving (worse) a capability the project deliberately built. `useSearch({ sources: ['mail'], mailbox })` already exists and AGENTS.md's Search section points to it.
- **Proposal:** Replace the `useMemo` filter with a debounced `useSearch({ ownerId, q, sources: ['mail'], mailbox: filterId })`; render its results when the query is non-empty and fall back to the full list when empty. The `SearchBar`/toolbar stay; only the filter mechanism changes.

### Inline type→MIME map and name-collision block in the drive/mount backend
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/mount/mount.ts:295-303` (inline `mimeTypeMap`) vs `EIGEN_DOC_TYPE_INFO` + `getEigenDocInfoByType` in `packages/lib/src/types/drive.ts:135`; `apps/api/src/lib/drive/drive.ts:279-287` and `:329-334` (collision block)
- **Problem:** Two small but exact re-derivations. (1) `Mount.createFolder` builds a six-entry `mimeTypeMap` that hand-copies the canonical `EIGEN_DOC_TYPE_INFO`; a new container type falls through to `DRIVE_MIME_FOLDER` with no type error. (2) The `getChildByName` → `listFolder` → `new Set(siblings.map(s => s.name.toLowerCase()))` → `getUniqueFileName` block is verbatim in both `uploadFiles` and `createFileFromData` — exactly two callers of identical logic, the project's own "extract when reused" threshold.
- **Proposal:** Replace the inline map with `getEigenDocInfoByType(type)?.mime ?? DRIVE_MIME_FOLDER` (one line, exhaustive against the registry). Extract a private `Drive.resolveUniqueName(mount, parentId, safeName)` and call it from both upload paths so the collision/NFC semantics live in one place.

### Recipient summary and S3 schema duplicated in the mail/team backend
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/mail/mail-parse.ts:17-24` and `apps/api/src/lib/mail/maildir.ts:345-356`; `apps/api/src/routes/team.ts:89-98,116-125` vs `s3ConfigBody` in `apps/api/src/routes/shared-schemas.ts:49-56`
- **Problem:** (1) The `to`/`cc` → `{ toShort, toAddress, recipientsAll }` flatten is copy-pasted between EML parsing and the fast-path draft save (`mailutils.ts` is where every other pure address helper already lives). (2) `team.ts` declares the S3 config shape inline twice (POST + PUT) instead of importing `s3ConfigBody`, and the copies have drifted — they require `prefix` where the canonical schema makes it optional.
- **Proposal:** Add `summariseRecipients(to?, cc?)` to `mailutils.ts`; both call sites become one line. Import `s3ConfigBody` in `team.ts` as `t.Optional(s3ConfigBody)` for both bodies, which also fixes the `prefix` required/optional mismatch.

### Minor: per-write ctag re-read; duplicated undo hotkeys; multi-select swatch row
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** medium
- **Where:** `apps/api/src/lib/calendar/calendar.ts:407,653,721` (`incrementCtag(id)` then `getCalendarById(id)!.ctag`); `apps/slides/src/components/slides/editor.tsx:188-211` vs `apps/stickies/src/components/stickies/board.tsx:81-106` (three `useHotkey` undo/redo registrations); `apps/stickies/src/components/stickies/toolbar.tsx:86-126` vs `packages/ui/src/components/layout/notes/color-swatch-row.tsx`
- **Problem:** Three small, real repetitions. The three event-write paths increment the ctag then issue a second `SELECT` to read it back (two round-trips where one suffices, repeated verbatim). The identical `Mod+Z` / `Mod+Y` / `Mod+Shift+Z` undo block lives in both Yjs editors — and `useYjsUndoState` already sits in `packages/lib/src/core/collab/hooks/`. The stickies toolbar hand-rolls a multi-select colour filter that `ColorSwatchRow` (single-select today) nearly covers.
- **Proposal:** Have `incrementCtag` return the new value via Drizzle `.returning({ ctag })`; call sites become `const newCtag = this.incrementCtag(id)`. Add a sibling `useYjsUndoHotkeys(undoManager, canWrite)` next to `useYjsUndoState` and have both editors call it. Extend `ColorSwatchRow` with an optional `activeColors: Set<string>` + `onReset` so stickies drops its 40-line reimplementation. Each is independently optional; bundle on touch.
## Over-engineering — flatten toward direct, simple code

Eleven of the twenty raw findings survived verification: each is a wrapper, options-object, dead prop, or re-derivation that adds indirection over "flat, direct, simple" with no payoff. Nine were dropped — most because the cited abstraction is actually load-bearing (`deepMerge` backs the genuinely-nested settings wire type; `scheduleInterval` is a documented architecture seam; `formatTime` is a deliberate compact-format primitive) or because the recommendation traded a working primitive for inlined ceremony.

### Drop the no-op `SharedDrive` database wrappers

- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/drive/sharedDrive.ts:380-398` (the three wrappers); real callers hold raw `Drive`: `apps/api/src/lib/chat/chat.ts:58`, `apps/api/src/lib/collab/collabDocument.ts:179,182`, `apps/api/src/lib/chat/comment-index.ts:101`
- **Problem:** `SharedDrive.openDatabase` / `createDatabase` / `closeDatabase` each delegate to `this.sharedDrive` with **no ACL check** — every sibling method on the class (`listVersions`, `saveVersion`, `restoreContainer`) wraps with `withReadPermission`/`withWritePermission`, but these three forward blind. They have **zero route callers** (confirmed by grep over `apps/api/src/routes`); the only callers are lib code (`ChatRoom`, `CollabDocument`, `comment-index`) holding a raw `Drive`. So the wrappers exist purely to satisfy the `Drive | SharedDrive` union and bypass the ACL contract AGENTS.md ascribes to `SharedDrive` — the worst of both worlds.
- **Proposal:** These are non-route-callable per the drive-layer doc. Remove the three wrappers from `SharedDrive` and annotate the `Drive` originals (`drive.ts:851,860,901`) with the existing `// Called by:` convention (collab/chat/comment-index). No permission semantics are lost — there were none — and the surface shrinks by ~18 lines.

### Stop threading `organizationId` through admin components — read `usePublicConfig()` directly

- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/admin/src/components/admin/members-list.tsx:21,29,46`, `apps/admin/src/components/admin/member-detail.tsx:39,42`, `apps/admin/src/components/admin/team-detail.tsx:34,37,63,66`, `apps/admin/src/components/admin/create-user-dialog.tsx:15` (declared but never destructured at `:18`)
- **Problem:** `organizationId` is prop-threaded route → list → detail → dialog, but it is always `config.orgId`, and `usePublicConfig()` is a singleton query with `staleTime: Infinity` (`packages/lib/src/core/public/hooks/use-public.ts:24`) — any component can read it with zero waterfall cost. `CreateUserDialog` is the proof: it declares `organizationId?` in its props, never destructures it, and calls `usePublicConfig()` + `config?.orgId` internally. The prop and its entire pass-through chain (`MembersListToolbar` forwards it solely to that dialog) are dead cargo.
- **Proposal:** Drop the `organizationId` prop from `CreateUserDialog`, `MembersListToolbar`, `MemberDetail`, `TeamDetail`, and `TeamDetailToolbar`. Each component that feeds a hook calls `usePublicConfig()` and passes `config?.orgId` locally. Flattens four prop surfaces and deletes the dead prop.

### Hard-code `excludeDocumentChildren` — it is never `false`

- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/mount/mount.ts:1213,1221`, `apps/api/src/lib/drive/drive.ts:567-571,591-596`, `apps/api/src/lib/drive/sharedDrive.ts:90-105`, `apps/api/src/routes/drive.ts:450-451,461-462`
- **Problem:** `getMimeTypeContents` / `getMountMimeTypeContents` carry an `{ excludeDocumentChildren?: boolean }` option duplicated across four layers (Mount, Drive, SharedDrive, route). The two route handlers both pass `{ excludeDocumentChildren: true }`, and both domain methods *default* to `true`. The value `false` appears nowhere in the codebase — this is a never-exercised variation axis with the type written out four times. Matches CODE-STANDARDS' "feature flags for a single use case" BAD example.
- **Proposal:** Remove the option from all four signatures and hard-code the exclusion inside `getPathsByMimeType` at the Mount level. Deletes ~8 lines of option-forwarding plumbing and four type annotations, zero behaviour change.

### Replace the `ThumbnailOptions` / `DEFAULT_OPTIONS` object with explicit parameters

- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/shared/thumbnails.ts:11-21` (type + `DEFAULT_OPTIONS`), `:34-38` (merge); three callers — `apps/api/src/lib/contacts/contacts.ts:281`, `apps/api/src/lib/preview/preview-cache.ts:207`, `apps/api/src/lib/drive/drive.ts:1162` (no options)
- **Problem:** `generateImagePreview` / `saveThumbnail` take an optional `{ maxSize?, quality?, fit? }` merged against a `DEFAULT_OPTIONS` constant on every call, for exactly three callers whose values all differ (`512/80/cover`, `2560/85`, defaults). A named type + a defaults constant + a spread-merge is precisely the "Hard-code what you need" anti-pattern.
- **Proposal:** Promote `maxSize = 512`, `quality = 80`, `fit: 'inside' | 'cover' = 'inside'` to named parameters with inline defaults; delete `ThumbnailOptions` and `DEFAULT_OPTIONS`. Three callsites update mechanically and each becomes self-documenting at the call.

### Pass a plain boolean to `enclosingDocumentContainer`, not `{ includeSelf }`

- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/webdav/container-guard.ts:17`; six callsites in `apps/api/src/lib/webdav/resource.ts:132,192,214`, `move-copy.ts:66,92`, `proppatch.ts:145`
- **Problem:** The function's second argument is a single boolean wrapped in a one-key object `{ includeSelf: boolean }`. CODE-STANDARDS' "Adding unnecessary complexity" section explicitly flags "options objects for one caller"; here `{ includeSelf: !existing }` is no clearer than `!existing` at a named parameter. (The doc comment explaining the two modes stays — it's the genuinely useful part.)
- **Proposal:** Change the signature to `enclosingDocumentContainer(breadcrumb: DrivePath[], includeSelf: boolean)`. Six callsites unwrap the object (`{ includeSelf: false }` → `false`, etc.) — pure mechanical change, no logic touched.

### Delete the `userOwnerId` no-op identity function

- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `packages/lib/src/types/owner.ts:41-43`
- **Problem:** `userOwnerId(userId)` returns its argument unchanged. It exists only for visual symmetry with `teamOwnerId`/`orgOwnerId`/`externalOwnerId`, but AGENTS.md already states "User = raw UUID" — the identity is self-evident, and the wrapper falsely implies a transformation. Verified **zero callers anywhere**, including the test (the `owner.test.ts` round-trip no longer references it).
- **Proposal:** Delete the function and its barrel export. Callers that need a user's ownerId already hold the userId and use it directly.

### Move `emptyContact` out of `packages/lib` into the contacts app

- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `packages/lib/src/constants/contact.ts`; sole consumers `apps/contacts/src/routes/_auth.new.tsx:2,50` and `apps/contacts/src/routes/_auth.edit.$filterType.$filterId.tsx:2,108`
- **Problem:** `emptyContact` is a default form-value object used only by two routes in `apps/contacts/`. Living in `packages/lib/src/constants/` falsely signals cross-app shared logic; per the project's "if two or more apps need it, it belongs in packages" rule (and its inverse), a single-app default belongs next to its callers.
- **Proposal:** Move `emptyContact` into `apps/contacts/src/` (alongside the contact-edit form or a small local constants file), delete `constants/contact.ts`, and drop its `constants/index.ts` export. No other package is affected.

### Remove the redundant `beforeLoad` guard in chat's `_auth.index.tsx`

- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/chat/src/routes/_auth.index.tsx:68-74` vs parent `apps/chat/src/routes/_auth.tsx:4-9`
- **Problem:** The `/_auth/` index route adds its own `beforeLoad` checking `context.auth?.user?.id` and redirecting to `/login`. The parent `_auth.tsx` already guards every `/_auth/*` request (`if (!context.auth.isAuthenticated)`) before any child `beforeLoad` runs. The child guard is dead code that also muddies which layer owns the auth gate — and uses a *different* predicate than the parent, inviting future divergence.
- **Proposal:** Delete the `beforeLoad` from `_auth.index.tsx`; the parent guard is sufficient, as in every other app.

### Inline `getMinEndTime` in create-event-dialog

- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/calendar/src/components/create-event-dialog.tsx:121-123` (definition), `:209` (sole call); sibling `apps/calendar/src/components/edit-event-dialog.tsx:302` already inlines `addMinutes(startTime, 15)`
- **Problem:** `getMinEndTime` is a zero-arg wrapper that returns `addMinutes(startTime, 15)`, called exactly once. The sibling edit dialog inlines the identical expression. This is the textbook "don't extract single-use helpers" case, made worse by being inconsistent with its neighbour.
- **Proposal:** Delete `getMinEndTime` and inline `addMinutes(startTime, 15)` at the callsite, matching `edit-event-dialog.tsx`.

### Stop re-deriving the parsed ICS event in `CalendarInviteWidget`

- **Impact:** medium  ·  **Effort:** medium  ·  **Confidence:** medium
- **Where:** `apps/mail/src/components/mail/calendar-invite-widget.tsx:20-79,93-100`; backend parser already at `apps/api/src/lib/caldav/ical-parse.ts`
- **Problem:** The widget `fetch()`es the raw `.ics` attachment in the browser and re-parses it with a hand-rolled multi-regex (`parseIcsField`/`parseIcs`) that re-derives exactly what the backend's `ical.js`-based `parseIcs` already extracts (`uid`, `summary`, `dtstart`, `dtend`, `location`, `organizer`). This is the "re-derivation" failure mode the standards target — a weaker FE copy of a BE primitive — and the FE copy carries a real correctness bug: `icsDateToDate` (`:74-79`) only honours a trailing `Z`, so `TZID`-qualified events render in UTC instead of local time.
- **Proposal:** Extend `Attachment` in `packages/lib/src/types/mail.ts` with optional parsed fields (`icsUid?`, `icsSummary?`, `icsStart?`, `icsEnd?`, `icsLocation?`, `icsOrganizer?`) and populate them in the mail-parser pass that already reads the `content-type method` param. The widget then reads from `attachment` directly — no client fetch, no regex parser, bug gone. Smaller fallback if the wire-type change is too large: replace the regex parser with a shared `ICAL.parse` utility and fix the timezone handling there.

### Drop the redundant `usePathInfo` re-fetch in `DriveNewMenu`

- **Impact:** low  ·  **Effort:** medium  ·  **Confidence:** medium
- **Where:** `apps/drive/src/components/drive/drive-new-menu.tsx:29-44`
- **Problem:** The menu uses `useMatch` to recover `ownerId/mountId/pathId` from the URL, then calls `usePathInfo` to re-fetch the current path purely to compute `targetPath` — data the `_auth.fs` route already resolved via `usePathInfo`, plus the `currentPath || rootPath` fallback is implemented in both places. The result is a second parallel query for the same path on every sidebar render.
- **Proposal:** Add an optional `currentPath: DrivePath | null` to `DriveContextType` (`packages/lib/src/types/drive.ts`); the `_auth.fs` route writes it on navigation, and `DriveNewMenu` reads it from context (no `useMatch`, no second `usePathInfo`). Non-fs routes leave it null and the menu falls back to `rootPath` — the existing correct behaviour, now expressed once.
## Code smells — god files, tangled logic, local inconsistency

Of 32 raw findings, 24 survived verification (two pairs were duplicates; six were dropped as overstated, speculative, or in direct conflict with the project's "flat, direct, simple" preference for inline workflows). Two are genuine correctness bugs hiding behind a smell (a silently-swallowed `ApiError`, an invisible mail load-error); the rest are type-safety leaks, re-derived scaffolding, and god functions/components that have drifted from a pattern the same file or its siblings already establish. Highest-leverage items unify many call sites or restore the end-to-end type chain.

### Type-safe `getTeamHome` / `getUserHome` instead of raw `as TeamHome` casts in routes
- **Impact:** high  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/home/home-relay.ts:35-39` (private `getTeamHome` with `instanceof` guard), and 7 raw-cast callsites: `apps/api/src/routes/team.ts:32,42,71,81,108`, `apps/api/src/routes/space.ts:17,28`
- **Problem:** `home-relay.ts` already has `getTeamHome(teamOwnerId)` doing `getHome()` + an `instanceof TeamHome` guard that throws a meaningful error on mismatch — but it is module-private. The team and space routes instead write `(await getHome(params.ownerId)) as TeamHome` / `(await getHome(user.id)) as UserHome`, the exact `as Type` cast AGENTS.md forbids ("Don't break the type chain — no `as Type` casts"). A non-team ownerId reaching these routes yields a runtime `TypeError` on property access instead of a clear invariant message.
- **Proposal:** Export `getTeamHome` from `apps/api/src/lib/home/index.ts` (which already re-exports the `TeamHome`/`UserHome` classes) and add a symmetric `getUserHome` beside it using the same `instanceof` guard. Routes then do `const home = await getTeamHome(params.ownerId)` — no cast, the guard carries the invariant. Deletes 7 casts.

### Move the `canWrite` gate for import/export/convert out of routes and into the Drive layer
- **Impact:** high  ·  **Effort:** medium  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/drive/drive.ts:561-565` (`resolveFile` returns `{ mount, path }`), `apps/api/src/lib/drive/sharedDrive.ts:162-164` (`resolveFile` wrapped with `withReadPermission` only), `apps/api/src/routes/drive.ts:188-193` and `:210-215` (import / import-from-drive: `resolveFile` then a separate `drive.canWrite` check), `:180-182` (convert: `resolveFile` then `convertToDocument(drive, mount, path, …)`)
- **Problem:** `resolveFile` is a read-gated method, yet it hands a raw `Mount` (a storage-layer object) back to the route, which then performs a second, manual `drive.canWrite(...)` check before mutating. This splits the ACL contract: the write check lives in the thin route, not in `SharedDrive`. AGENTS.md is explicit that every route-callable write must go through a `SharedDrive` wrapper with the permission check; a future import-style route that forgets the manual `canWrite` would let a read-only caller mutate. Routes obtaining `Mount` instances also violates "routes are thin / don't couple to storage internals."
- **Proposal:** Add `importFile(mountId, pathId, buffer)`, `convertFile(mountId, pathId, targetType)`, and (if needed) `exportFile`/`getPreview` methods to `Drive`, each encapsulating the `Mount` lookup and calling the existing `importIntoDocument`/`convertToDocument` helpers; add matching `SharedDrive` wrappers gated by `withWritePermission` (write) or `withReadPermission` (convert/export/preview). Routes then call one drive method and no raw `Mount` escapes. Demote `resolveFile` off the `SharedDrive` public surface (keep it internal for the lib callers that truly need the `Mount`).

### Collapse the `*ById` / `*ByIds` mail-action pairs and the four `forEach` adapters
- **Impact:** high  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/mail/src/components/mail/hooks/use-mail-actions.ts:97-151` (eight functions: `handleDeleteEmailById`/`…ByIds`, `handleMoveEmailToFolderById`/`…ByIds`, `handleArchiveEmailById`/`…ByIds`, `handleReportSpamById`/`…ByIds`), `apps/mail/src/components/mail/email-detail.tsx:75-94` (four inline `ids.forEach(id => onX(id))` adapters), `apps/mail/src/components/mail/email-context-menu.tsx:22-25`
- **Problem:** `EmailContextMenu` was built array-first (`onArchive(ids: string[])`, `onDelete`, `onReportSpam`, `onMoveToFolder(ids, folderId)`). Embedding it in the single-email `EmailDetailToolbar` produces four hand-rolled `forEach` adapters to bridge `(id: string)` to `(ids: string[])`, and the same impedance mismatch forces `useMailActions` to carry two cardinalities of every action — eight functions that each just `getEmailById()` and fan out.
- **Problem continued:** every one of these is a per-call lookup that differs only in count.
- **Proposal:** Keep `EmailContextMenu` array-only and give `EmailDetailToolbar` a single `email: Email` prop, deriving `[email.id]` once before delegating to the shared array action. Delete the four `*ById` variants from `useMailActions`; single-ID callers call `*ByIds([id])`. Removes the four `forEach` wrappers and ~50 lines of duplicated lookup logic.

### EmailList silently swallows its `error` prop — load failures show "No emails found"
- **Impact:** high  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/mail/src/components/mail/email-list.tsx:39` (`error?: Error | null` declared in props) and `:51-66` (never destructured/rendered); route wires it at `apps/mail/src/routes/_auth.$filterType.$filterId.tsx:96,187` (`error={emailsError}`)
- **Problem:** The route passes `emailsError` into `EmailList`, but `error` is never read. On a failed mailbox fetch `isLoading` is false and `emails` is `[]`, so the component falls through to `<EmptyState message="No emails found" />`. The user sees a blank "empty" panel with no signal that the network failed. This is a real user-visible bug, not just a smell.
- **Proposal:** Destructure `error` and early-return before the loading guard: `if (error) return <ErrorState message="Could not load emails" detail={error.message} />;`. `ErrorState` already exists in `@workspace/ui` (`app/error-state.tsx`).

### Extract a file-private `MessageRow` from ChatMessageList's three near-identical branches
- **Impact:** medium  ·  **Effort:** medium  ·  **Confidence:** high
- **Where:** `packages/ui/src/components/layout/chat/chat-message-list.tsx:449-490` (emote), `:493-531` (whisper), `:534-583` (normal)
- **Problem:** The emote, whisper, and normal message types are three fully written-out JSX branches (~135 lines total) sharing the identical outer `cn('flex gap-3 px-5 …')` container, the `w-9 shrink-0` avatar column, the `displayName` + `formatDateTime` header, the `RichContent` call, and `renderAttachments`. The real deltas are tiny: whisper's `bg-primary/5` base + "whisper" label, emote's `✦` grouped-avatar placeholder + italic content class, and inline-edit support only on normal. Any change to avatar size, hover, or spacing means editing three copies. This is exactly the "re-derivation" vein the enforcement doc targets — shrinking the surface is the fix.
- **Proposal:** Add a file-private `MessageRow` taking `message`, `grouped`, `isHovered`, `onMouseEnter`, `variant: 'normal' | 'emote' | 'whisper'`, plus the edit/attachment callbacks. Drive the variant-specific values (base className, content className, header badge, grouped-avatar icon) from a small lookup keyed by `variant`; keep the inline-edit branch in the normal case. The `.map()` collapses from ~135 lines to ~20.

### Delete the redundant predicate in `invalidateMyTeams`
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `packages/lib/src/core/home/hooks/use-home.ts:60-65`
- **Problem:** `invalidateMyTeams` passes both `queryKey: homeKeys.all` **and** `predicate: (query) => query.queryKey.includes('my-teams')`. The `queryKey` already scopes the scan to the `['home']` subtree, so the predicate is a runtime string match layered on top — it bypasses the typed `homeKeys.myTeams(ownerId)` factory two lines above, and `.includes('my-teams')` would match any future `['home', …, 'my-teams', …]` key as a raw substring. Every other `invalidate*` in the codebase targets a typed key. (Note: because of the `homeKeys.all` scope, the original "scans every cached query / over-invalidates all owners" framing is overstated — the real defect is just the superfluous, untyped predicate.)
- **Proposal:** Drop the predicate and invalidate the typed prefix directly: `queryClient.invalidateQueries({ queryKey: homeKeys.all })`, or introduce `homeKeys.myTeamsAll = [...homeKeys.all, 'my-teams'] as const` and invalidate that. Callers (`admin` `use-teams`/`use-members` hooks) are unchanged — the cross-owner intent is preserved by the `homeKeys.all` prefix.

### Delete the `getContacts` wrapper; access `home.contacts` directly like every other route
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/routes/contacts.ts:47,56,65,77,89,98,107,119,131,141,155,168` (12× `await (await getContacts(user)).method()`), wrapper at `apps/api/src/lib/contacts/contacts.ts:21-24`
- **Problem:** `getContacts(user)` does nothing but `return (await getHome(user.id)).contacts`. Every contacts handler then double-awaits `(await getContacts(user)).method()`, forcing two layers of async indirection per line to reach what is a plain property access. `routes/calendar.ts:224` shows the house style: `const home = await getHome(user.id); home.calendar.method()`. Contacts is the only route file wrapping a home sub-service behind a module-level async function — a single-use helper hiding a property access, which the standards call out as over-engineering.
- **Proposal:** In each handler do `const home = await getHome(user.id);` after `requireSelf`, then call `home.contacts.method()` directly. Delete `getContacts` from `contacts.ts`.

### Add `.catch()` to the three fire-and-forget `notifySharedUsers` calls
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/chat/chat.ts:332` (editMessage), `:376` (deleteMessage), `:410` (updateCommentIndex)
- **Problem:** `notifySharedUsers` is async and is called bare (no `await`, no `.catch()`) at these three sites. AGENTS.md: "Fire-and-forget must have `.catch()`." Although the method wraps each per-member send in try/catch, the outer `Promise.all` and the `getEffectiveMembers` fallback (when `members` is undefined) can still reject, producing an unhandled rejection. The matching call in `postMessage` (line 161) at least documents the intent with a comment; these three have neither.
- **Proposal:** `this.notifySharedUsers(event, members).catch(() => {});` at all three. This is an SSE fan-out that must not block the HTTP response, so the `.catch()` form (not `await`) is correct.

### Extract a shared `HEADER_KEYS` constant and remove the duplicate `'to'`
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/mail/mail-parser/mail-parser.ts:1017-1029`, `apps/api/src/lib/mail/mail-parser/simple-parser.ts:108-120`
- **Problem:** Both parsers iterate the same hard-coded header-key array `['subject','references','date','to','from','to','cc','bcc','message-id','in-reply-to','reply-to']` — and `'to'` is listed twice in each copy. The second `'to'` is a no-op (the loop just re-sets a key it already set) but it is confusing noise that has already survived one copy-paste between the two files and will propagate on the next.
- **Proposal:** Define `const HEADER_KEYS = [...]` once (single `'to'`) near the top of `mail-parser.ts` and import it into `simple-parser.ts`. One source, no divergence.

### `messageGet` / `readAndParse` bare `catch` swallows `ApiError` into a 404
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/mail/maildir.ts:159-193` (`messageGet`: whole body in `try { … } catch { return null; }`), `:759-775` (`readAndParse`: same)
- **Problem:** Both methods wrap their entire body in `catch { return null; }`. This silences not just expected "file gone mid-parse" errors but any `ApiError` (e.g. from a stored mailbox name failing validation) and any unexpected error — all collapse to `null`, which the route turns into a 404, hiding the real cause (malformed stored data). The standards require `ApiError` to bubble; only genuinely recoverable filesystem errors should be caught.
- **Proposal:** In `readAndParse`, narrow the catch to `ENOENT` (file missing) and let everything else propagate. In `messageGet`, drop the outer try/catch entirely — the `!cached` early-return covers "not in DB" and `readAndParse` returning `null` covers "file gone"; anything thrown should reach the Elysia handler.

### Move stickies dialog-open state out of the `useBoard` data hook
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/stickies/src/components/stickies/hooks/use-board.ts:36,203,228-229`
- **Problem:** `useBoard` owns `isAddColumnDialogOpen` / `setIsAddColumnDialogOpen` (line 36) and closes the dialog as a side effect of `handleAddColumn` (line 203), then returns the setter (228-229). Dialog open/close is UI lifecycle; data hooks should expose data + mutations only. Coupling the Yjs mutation to a dialog boolean makes the hook harder to reuse or test and mixes two responsibilities.
- **Proposal:** Remove the boolean and setter from `useBoard`; let `StickiesBoard` own `const [isAddColumnDialogOpen, setIsAddColumnDialogOpen] = useState(false)` and close the dialog in its own `onAddColumn` handler after invoking `handleAddColumn`. `useBoard` becomes purely data-and-mutations.

### contact-edit Addresses section should use the existing `RepeatableField` header
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/contacts/src/components/contacts/contact-edit.tsx:472-485` (hand-rolled label + Add button), vs the `RepeatableField` helper used for email/phone in the same file
- **Problem:** The file defines `RepeatableField` for exactly the "label + Add button + children" layout and uses it for email and phone. The Addresses section re-creates that header by hand — a `<div className="flex items-center justify-between">` with a `<FormLabel>` and an `<Button variant="outline" size="sm" className="h-7 gap-1">` — the precise signature `RepeatableField` already encapsulates. Three repeatable sections, two patterns.
- **Proposal:** Wrap Addresses in `<RepeatableField label="Addresses" onAdd={() => appendAddress({})}>` and move the per-address card grid inside as children. Removes ~10 lines of duplicated header markup and makes the three sections consistent.

### contact-edit: drop the React default import (React 19)
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/contacts/src/components/contacts/contact-edit.tsx:22` (`import React, { useState } from 'react'`), used only at `:105` (`React.useRef`) and for `React.ReactNode` type refs
- **Problem:** This is the only non-`main.tsx` file in contacts/calendar using a React default import; every sibling uses named imports (`import { useState, useRef } from 'react'`). With React 19 + the automatic JSX transform the default import is unnecessary, and `React.useRef` is its only value-level driver.
- **Proposal:** Switch to `import { useState, useRef } from 'react'`, change `React.useRef` → `useRef`, and use `import type { ReactNode } from 'react'` for the type refs. Matches the rest of the monorepo.

### Chat index: replace `useEffect`+`navigate` with a `beforeLoad`/`loader` redirect
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/chat/src/routes/_auth.index.tsx:17-29`
- **Problem:** `ChatIndex` fetches the chat list and navigates to the first chat inside a `useEffect`, so the component mounts and renders a flash before redirecting. The route already uses `beforeLoad` for the login redirect, and Drive's index route (`apps/drive/src/routes/index.tsx`) does this synchronously with `throw redirect(...)` and no flash. The effect also uses `chat?.ownerId || ''` / `mountId || ''` / `id || ''` fallbacks on `data[0]`, which is only reached when `data.length > 0` — defensive empty strings on already-narrowed data, contradicting "trust the type system."
- **Proposal:** Move the first-chat navigation into a `loader` (or `beforeLoad`) that reads the chats query and `throw redirect(...)` when one exists; keep the empty-state ("No chats yet") as the component body. Drops the flash and the empty-string fallbacks.

### Fix AppSidebar's wrong `calc(100vh-3.5rem)` magic number
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `packages/ui/src/components/layout/sidebar/app-sidebar.tsx:132,174`
- **Problem:** Both sidebar variants use `min-h-[calc(100vh-3.5rem)]`, assuming a 3.5rem (56px) topbar — but the topbar is `h-12` (3rem/48px), confirmed at `packages/ui/src/components/layout/app/topbar.tsx:261` and `column-layout.tsx:38`. The number is already wrong and will drift further on any topbar change. The sidebar already lives inside an `h-full` flex child, so the constraint is defensive at best.
- **Proposal:** Remove both `min-h-[calc(100vh-3.5rem)]` (the `h-full flex flex-col` is sufficient). If a short-sidebar regression appears on the mobile overlay, use `min-h-full` — no magic numbers.

### Sort emails at the DB layer, not on every React render
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** medium
- **Where:** `apps/mail/src/components/mail/email-list.tsx:79` (client `.sort((a,b) => date desc)`), `apps/api/src/lib/mail/maildb.ts:147-149` (`getAllEmails`: bare `SELECT … WHERE mailbox = ?`, no `ORDER BY`)
- **Problem:** `getAllEmails` returns rows in SQLite heap order, so `EmailList` re-sorts by date on every render to compensate. The sort responsibility is split and invisible to API readers; doing it client-side on each render is a mild, repeated cost.
- **Proposal:** Add `ORDER BY date DESC, id DESC` to `getAllEmails` (matching the order `searchMail` already returns), then drop the `.sort(...)` from the `useMemo`. The order becomes authoritative at the source and leaves the render path.

### Extract `CreateTeamDialog` from AdminSidebar
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/admin/src/components/admin/admin-sidebar.tsx:47-58` (owns `usePublicConfig`, `useCreateTeam`, `showCreate`, `newTeamName`) and the inline `Dialog` + form (~lines 144-167)
- **Problem:** A sidebar whose job is navigation also owns create-team mutation state, form state, and renders a full inline `Dialog` + form (~30 lines). The matching admin dialogs — `CreateUserDialog`, `MountDialog`, `AddMemberDialog` — are all standalone files invoked by their parent. This mixes two responsibilities in a nav component.
- **Proposal:** Extract `apps/admin/src/components/admin/create-team-dialog.tsx` shaped like `CreateUserDialog`; AdminSidebar renders `<CreateTeamDialog open={showCreate} onOpenChange={setShowCreate} organizationId={config?.orgId} />`. Removes `useCreateTeam` and `usePublicConfig` from the sidebar.

### Split the 789-line docs `editor.tsx` god component
- **Impact:** medium  ·  **Effort:** medium  ·  **Confidence:** high
- **Where:** `apps/docs/src/components/docs/editor.tsx` (789 lines): `CollaborativeEditor` WebSocket lifecycle at `:94-153`; `TiptapEditor` at `:200-789` inlining image handling, clipboard copy/cut, comment-decoration sync, selection tracking, and placeholder cleanup
- **Problem:** `TiptapEditor` is ~589 lines mixing five image-handling functions, a clipboard listener, comment decoration sync, sidebar selection tracking, and zombie-placeholder cleanup in one component. Slides distributes the equivalent across `editor` + `use-deck.ts`; the contrast is stark (`slides/toolbar.tsx` is 88 lines vs the docs editor area). The file is hard to navigate and the concerns are independent.
- **Proposal:** Extract `useDocImageHandler(editor, mediaFolderId, …)` and `useDocClipboard(editor, mediaFolderId, …)` into `apps/docs/src/components/docs/hooks/`; the comment/decoration sync has a natural home in the existing `use-active-comments.ts`. `TiptapEditor` then drops below ~250 lines and `editor.tsx` becomes a readable two-component file. (These are genuinely reused logic blocks, not one-off helpers, so extraction is consistent with the standards.)

### Move TeamDetail's settings edit into a dialog, matching the other admin edits
- **Impact:** medium  ·  **Effort:** medium  ·  **Confidence:** high
- **Where:** `apps/admin/src/components/admin/team-detail.tsx:66-417` (417 lines; `showSettingsForm` toggle at `:70,186,194`; serial `handleSaveSettings` at `:126`)
- **Problem:** TeamDetail manages five concerns (settings form, quota overrides, mounts, members, delete) with eleven hooks and five draft-state variables, and uses an inline `showSettingsForm` edit/view toggle that diverges from the app's own convention — `MountDialog`, `AddMemberDialog`, and `DeleteDialog` are all already used as dialogs *in this same file*. With the settings form open the detail pane is 200+ lines of JSX. `handleSaveSettings` also fires three serial awaited mutations with no rollback on partial failure.
- **Proposal:** Extract `TeamSettingsDialog` (name/calendar/quota inline edit) as a dedicated dialog consistent with the sibling admin dialogs, and pull the member-list and mount-list sections into named sub-components. Brings TeamDetail to ~150 lines and aligns with the dialog-for-edits pattern.

### Extract notification dispatch from the 181-line `postMessage`
- **Impact:** medium  ·  **Effort:** medium  ·  **Confidence:** medium
- **Where:** `apps/api/src/lib/chat/chat.ts:68-247` (notification block `:159-245` is ~87 lines of nested conditionals)
- **Problem:** `postMessage` does five things: slash-command parsing/mutation, whisper-target validation, DB insert + `ChatMessage` build, SSE broadcast + comment-index update, and a large notification block with per-type fan-out (mentions, plus whisper→recipient vs message/emote→participants+owner). Determining which notifications fire for a whisper vs an emote means reading 80+ lines of branches with independent try/catch and participant resolution.
- **Proposal:** Extract `private async notifyParticipants(type, authorEmail, authorId, content, members, whisperTo?)` holding the mention-set + activity-type/tag logic. `postMessage` then reads: insert row → broadcast → update comment index → `await this.notifyParticipants(...)`. This is a reusable logic block (the per-type fan-out), so the extraction is justified rather than a one-off split.

### `draftFastSave`: replace `as unknown as` attachment stubs with a narrower return type
- **Impact:** low  ·  **Effort:** medium  ·  **Confidence:** medium
- **Where:** `apps/api/src/lib/mail/maildir.ts:360-373` and `:379-383` (`headers: new Map() as Email['headers']`, `headerLines: [] as unknown as Email['headerLines']`)
- **Problem:** The fast-save path returns an `EmailDraft` with stub attachment objects whose `headers`/`headerLines` are produced via `as unknown as` casts — the type chain is broken at the seam rather than fixed at the source. The casts exist only because `EmailDraft` inherits `ParsedMail.attachments: Attachment[]` (requiring full `Headers`), while the fast path deliberately skips re-parsing the EML.
- **Proposal:** Give the fast-save path a narrower return type (`DraftSummary`, or `Omit<EmailDraft, 'attachments'>` plus the scalar fields the compose hook actually consumes — subject, body, recipients). The client already knows its attachment list from prior state, so the response needn't carry full `Attachment` objects. Makes the intentional incompleteness explicit in the type and removes the casts.

### Fan out the serial chat activity-notification loop
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** medium
- **Where:** `apps/api/src/lib/chat/chat.ts:226-243` (`await notifyActivity(userId)` inside a `for…of`)
- **Problem:** The participant activity loop awaits each `sendToHome` sequentially — N serial round-trips for N prior participants, blocking the HTTP response longer than necessary in active rooms. The correct pattern already exists in this file: `notifySharedUsers` (line ~422) fans out with `Promise.all`.
- **Proposal:** Collect target userIds and fan out: `await Promise.all([...participants].filter(...).map(([, userId]) => notifyActivity(userId)))` (each `notifyActivity` already has its own inner try/catch, so `Promise.all` is safe).

### Parallelise the drag-to-team member-add loop in admin `__root.tsx`
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** medium
- **Where:** `apps/admin/src/routes/__root.tsx:53-57`
- **Problem:** `handleAddMembersToTeam` calls `addMember.mutateAsync({ teamId, userId })` in a serial `for…of`; a multi-select drag of N members is N serial round-trips, though each add is independent.
- **Proposal:** `await Promise.all(memberIds.map(userId => addMember.mutateAsync({ teamId, userId })))`. Caveat: `useMutation` tracks a single in-flight call, so only the last `isPending` is observed — fine here since the loading state isn't surfaced. If accurate per-item state is ever needed, use raw API calls + one invalidation.

### Move the runtime `mapStorageType` out of the BE types file
- **Impact:** low  ·  **Effort:** medium  ·  **Confidence:** medium
- **Where:** `packages/lib/src/types/settings.ts:102-111` (the only function in the file); callers: `apps/api/src/lib/config/server-settings.ts` (BE) and `apps/admin/src/components/admin/team-detail.tsx:110` (FE)
- **Problem:** `ServerStorageType` (`'local-id' | 'local-fullnames' | 's3'`, the on-disk JSON format) and `MountSettings.storageType` (`'local' | 'local-key' | 's3'`) are two unions for the same concept, bridged by `mapStorageType`. The two *types* coexisting is intentional backward-compat; the smell is that a runtime function lives in a `types/` file, breaking the project's "types files stay type-only on the BE side" convention (the reason `EIGEN_DOC_ICONS` was kept out of `types/drive.ts`).
- **Proposal:** Leave the types in place; move only `mapStorageType` into `packages/lib/src/core/settings/` (alongside the settings hooks, importable by both the API and `apps/admin`). The `types/settings.ts` file returns to type-only.
## UX inconsistency across apps — make the shared codebase show

Fourteen findings survived verification. They split cleanly into two veins the enforcement doc already names: **re-derivation** (the same chrome — comment panel, storage footer, sidebar loaders, undo/redo, link input, error/loading states — built per app and then diverging) and **drift away from documented shared primitives** (`ConfirmDialog`/`DeleteDialog`, shadcn `Select`, `ErrorState`). None require new abstraction; almost every fix is "call the primitive that already exists" or "delete the local re-derivation." One dropped finding (the drive root loading shell) was already using the correct `LoadingState`/`ErrorState` primitives and was mischaracterized; another (a fully-unified chat sidebar) the auditor itself judged out of scope, with its actionable parts tracked separately below.

### Slides has no mobile Edit menu — undo/redo is unreachable on tablet/narrow windows
- **Impact:** high  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/slides/src/components/slides/toolbar.tsx:61-63` (gap); reference patterns `apps/stickies/src/components/stickies/toolbar.tsx:57-75` and `apps/docs/src/components/docs/editor-toolbar.tsx:194-214`
- **Problem:** Below the 1200px breakpoint the slides toolbar renders only FileMenu | Present | DocumentShareCluster. `UndoRedoButtons` is gated `canWrite && !isMobile` with **no mobile fallback**, so a writer on a tablet or narrow window has no undo/redo at all. Docs and stickies both render an "Edit" dropdown carrying Undo/Redo in exactly this case. This is the one user-visible *functionality loss*, not just a cosmetic difference.
- **Proposal:** Mirror the stickies pattern verbatim. `canUndo/canRedo/undo/redo` are already computed from `useYjsUndoState` at line 43; add `{canWrite && isMobile && (<DropdownMenu>…Undo/Redo items…</DropdownMenu>)}` next to the existing desktop `UndoRedoButtons`. No shared component — this is a 12-line block copied from a sibling toolbar.

### `EmailList` and `EmailSidebar` silently swallow load errors
- **Impact:** high  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/mail/src/components/mail/email-list.tsx:39` (dead `error` prop) + `:109` (only-guard) + route `apps/mail/src/routes/_auth.$filterType.$filterId.tsx:187` (passes `error={emailsError}`); `apps/mail/src/components/mail/email-sidebar.tsx:22-78,134`
- **Problem:** Two related mail failures. (1) `EmailList` declares `error?: Error | null`, the route threads `emailsError` into it, but the prop is **never destructured or rendered**; on error `emails` defaults to `[]` so the user sees "No emails found" instead of a failure — contacts/drive both render `<ErrorState>` on the same path. (2) `EmailSidebar` does `isLoading || error ? defaultMailboxes : processedMailboxes`, swapping in a static array of fake `unread: 0` counts and hard-coded hrefs on error — phantom UI that looks real but reflects no server state, directly violating "trust the type system / no defensive fallbacks."
- **Proposal:** In `email-list.tsx`, after the loading guard add `if (error) return <ErrorState message="Could not load emails." detail={error.message} />;` (import `ErrorState` from `@workspace/ui`). In `email-sidebar.tsx`, delete `defaultMailboxes` and the `error` branch entirely: render `<EigenLoader>` while loading, a one-line error message (or `<ErrorState>`) on error, and `processedMailboxes` otherwise.

### `window.prompt('URL')` in the markdown toolbar bypasses the editor's own inline link input
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/drive/src/components/editor/markdown-toolbar.tsx:144`; the solved pattern lives in `packages/ui/src/components/layout/editor/light-editor-toolbar.tsx:30-41,95-104`
- **Problem:** The link button calls `window.prompt('URL')` — a native modal that blocks the page, ignores the theme, can't be tested, and renders differently per browser. `LightEditorToolbar` already solves this exact case with an in-toolbar `<input>` driven by `showLinkInput`/`linkUrl` state, with Enter/Escape handling and `https://` normalization. Two TipTap toolbars sit side by side in the repo implementing link insertion oppositely.
- **Proposal:** Port the `LightEditorToolbar` inline-input pattern into `markdown-toolbar.tsx`: add `showLinkInput`/`linkUrl` `useState`, replace the `window.prompt` call with `setShowLinkInput(true)`, and render the styled `<input>` next to the toolbar. The extension sets differ, so no new shared component — just reuse the established shape (~15 lines).

### Stickies board has no comment panel — present in docs, slides, and sheets
- **Impact:** medium  ·  **Effort:** medium  ·  **Confidence:** high
- **Where:** `apps/stickies/src/components/stickies/board.tsx`; `apps/stickies/src/components/stickies/toolbar.tsx:130` (the `DocumentShareCluster` call passes only `canWrite`/`onAccessDialogOpen`); reference wiring in `apps/sheets/src/components/sheets/editor.tsx`, `apps/slides/src/components/slides/editor.tsx`, `apps/docs/src/components/docs/editor.tsx`
- **Problem:** Docs, slides, and sheets all mount the shared `CommentPanel` and feed `unresolvedCommentCount` into the `DocumentShareCluster` button. Stickies wires none of it: there is no panel, no badge count, no way to see a board's comments except opening cards one by one. A board with 20 sticky comments has no summary view — a real cross-app capability gap, not a cosmetic one, with the shared `CommentPanel` (`@workspace/ui`) already built and used by three siblings.
- **Proposal:** Reuse the existing shared `CommentPanel` and follow the sheets wiring: drive the comment lifecycle, derive active card IDs from board tasks (anchor text = each card title), pass `unresolvedCommentCount` + `onToggleCommentPanel` into the toolbar's `DocumentShareCluster`, and render `<CommentPanel>` as a layout sibling. No new primitive — this consumes what docs/slides/sheets already consume.

### App-password deletion fires on a single click with no confirmation
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/space/src/routes/_auth.services.tsx:113` (`onClick={() => deleteMutation.mutate(pw.id)}`)
- **Problem:** The trash icon revokes an app password immediately — a mis-click silently disconnects any live IMAP/CalDAV/WebDAV client using it. Every other destructive delete in the repo (drive items, waitlist, calendar, stickies columns, admin teams/users) routes through the shared `DeleteDialog` first. This is the most consequential missing confirmation because it is security/connectivity-sensitive and irreversible.
- **Proposal:** Use the shared `DeleteDialog` (`@workspace/ui/components/layout/delete/delete-dialog`), as `apps/admin/src/routes/_auth.waitlist.tsx` does: track `pendingDeleteId` in state, have the trash button set it, and render `<DeleteDialog open={!!pendingDeleteId} … title="Revoke app password" description="Revoking this password will disconnect any client currently using it." onDelete={…}>`.

### Toolbar "compact" breakpoint (1200px) is an undocumented magic number, three times over
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/docs/src/components/docs/editor-toolbar.tsx:111`, `apps/slides/src/components/slides/toolbar.tsx:44`, `apps/stickies/src/components/stickies/toolbar.tsx:44` — each `useMediaQuery('(max-width: 1200px)')` aliased as `isMobile`; the canonical hooks are in `packages/lib/src/core/media/hooks/use-media-query.ts:20-30` (`useIsMobile`=768, `useIsTablet`=1024, `useIsDesktop`)
- **Problem:** The shared layout system defines mobile at 768px and tablet at 1024px, but all three editor toolbars hand-roll a fourth breakpoint at 1200px and mislabel it `isMobile`. At ~900px the AppShell shows desktop chrome (full sidebar, no burger) while the toolbar has already collapsed to mobile dropdowns — desktop frame, cramped mobile toolbar. The 1200px value is repeated literally and centralized nowhere.
- **Proposal:** Add `useIsCompact()` returning `(max-width: 1200px)` next to the existing exports in `packages/lib/src/core/media/hooks/use-media-query.ts`, and replace the three inline `useMediaQuery('(max-width: 1200px)')` calls with it. One tunable definition, named consistently with the sibling hooks so the next toolbar author finds it instead of re-typing the literal.

### Chat is the only EigenDoc app with no command-palette selection
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/chat/src/routes/_auth.$ownerId.$mountId.$chatId.tsx` (`ChatView`, `chat.chatPath` already available at :45/:50/:116); `usePaletteDocSelection` lives in `packages/lib/src/core/command-palette/` (used by docs/sheets/slides/stickies via `useEigenDocEditorRoute` → `usePaletteDocSelection` in `packages/ui/src/hooks/use-eigen-doc-editor-route.ts`)
- **Problem:** The four file-based EigenDoc apps register the open document as a palette selection, so Mod+K offers context-aware actions (Copy link, Mail to…, Move to trash, Share). Chat never calls `usePaletteDocSelection`, so opening Mod+K inside a chat yields none of those actions while every sibling app does. Inconsistent affordance for an identical interaction.
- **Proposal:** Add `usePaletteDocSelection(chat.chatPath ?? undefined)` in `ChatView` (import from `@workspace/lib/command-palette`). `chat.chatPath` is already in hand from `useChatRoom`. One line brings chat to parity.

### Chat sidebar is the only custom sidebar missing the `StorageUsage` footer
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/chat/src/components/chat/chat-sidebar.tsx` (no `StorageUsage`); siblings `apps/mail/src/components/mail/email-sidebar.tsx:191`, `apps/calendar/src/components/calendar-sidebar.tsx`, `apps/contacts/src/components/contacts/contacts-sidebar.tsx:81` all render `<StorageUsage className="mt-auto" condensed={condensed} />`
- **Problem:** Mail, calendar, and contacts share an identical sidebar footer; chat ends abruptly after the last chat item. Verified: `StorageUsage` appears in the other three sidebars and zero times in chat's. The user sees a different sidebar bottom depending on the app.
- **Proposal:** Import `StorageUsage` from `@workspace/ui` and append `{!isGuest && <StorageUsage className="mt-auto" condensed={condensed} />}` at the end of the chat sidebar's flex column, matching the three siblings exactly.

### Four sidebars render section loaders four different ways
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/chat/src/components/chat/chat-sidebar.tsx:125-128` (`flex justify-center py-4`), `apps/mail/src/components/mail/email-sidebar.tsx:156-159` (`flex items-center justify-center py-4`), `apps/calendar/src/components/calendar-sidebar.tsx:150-151` (bare `<EigenLoader />`), `apps/contacts/src/components/contacts/contacts-sidebar.tsx:63-64` (bare `<EigenLoader />`); shared host `packages/ui/src/components/layout/sidebar/sidebar-section.tsx`
- **Problem:** All four custom sidebars show `<EigenLoader>` while their section data loads, each with a different wrapper — so the spinner sits at a different vertical position per app. Pure re-derivation of the same intent.
- **Proposal:** Add an optional `isLoading?: boolean` to the already-shared `SidebarSection`: when true it renders `<div className="flex items-center justify-center py-4"><EigenLoader /></div>` instead of `children`. The four sidebars then pass `isLoading` and delete their bespoke branches. One definition, one appearance — and it lands in the component they already use.

### Contact label picker is a hand-styled native `<select>` instead of shadcn `Select`
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/contacts/src/components/contacts/contact-edit.tsx:359-388`
- **Problem:** The Labels field uses a raw `<select className="h-7 w-auto rounded-md border border-input px-2 py-1 text-xs shadow-sm">` with CSS hand-rolled to *approximate* shadcn. The native control won't match dark mode or custom themes and bypasses the design system; the rest of the form and the entire calendar app use shadcn `Select`. The primitive exists at `packages/ui/src/components/select.tsx` and is not currently imported here.
- **Proposal:** Drop-in swap to shadcn `<Select>`/`<SelectContent>`/`<SelectItem>` calling `field.onChange` on value change; move the per-option `disabled={field.value?.includes(label.id)}` onto `SelectItem disabled`. No new code in `packages/ui` — just consume the existing component.

### `ContactDetail` has a third treatment for the same labels load state
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** medium
- **Where:** `apps/contacts/src/components/contacts/contact-detail.tsx:129-143`; siblings `apps/contacts/src/components/contacts/contacts-list.tsx` (`ErrorState`/`LoadingState`) and `contacts-sidebar.tsx:61-64` (plain destructive `<div>`)
- **Problem:** For the *same* `useLabels()` query, the app shows three different loading/error treatments: the list uses shared `ErrorState`/`LoadingState`, the sidebar uses a plain `text-destructive` div, and the detail view renders an inline `<EigenLoader />` then a `<p className="text-sm text-destructive">` inside the hero's `badges` prop. By the time the detail renders, labels are already cached (sidebar and list both fetched them) — so the inline spinner/error is defensive code around a trusted internal cache.
- **Proposal:** Per "trust the type system," remove the `labelsLoading`/`labelsError` branching from the `badges` render prop: render the badges when `contactLabels.length > 0`, otherwise render nothing. No inline loader or error string in the detail hero.

### Stickies empty board uses `visibility: hidden` instead of `EmptyState`
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** medium
- **Where:** `apps/stickies/src/components/stickies/board.tsx:260-268`
- **Problem:** When `board.columnOrder.length === 0` the board renders its full `DndContext` tree but sets `visibility: hidden` on the wrapper — an invisible surface with no copy and no call to action, briefly visible after a new board initializes its default columns. Docs and drive use the shared `EmptyState` (icon + description) for empty lists.
- **Proposal:** Render `<EmptyState icon={SquareKanban} title="No columns" description="Add a column to get started." />` (from `@workspace/ui`) for the empty case, with the existing add-column affordance beside it. Removes the `visibility:hidden` hack and matches the cross-app empty pattern.

### Documented shared primitives aren't reachable from the `@workspace/ui` barrel
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `packages/ui/src/index.ts` (no entry for confirm-dialog / layout/delete / layout/search-bar); components at `packages/ui/src/components/confirm-dialog.tsx`, `packages/ui/src/components/layout/delete/delete-dialog.tsx`, `packages/ui/src/components/layout/search-bar/search-bar.tsx`
- **Problem:** AGENTS.md's Key UI Components table names `ConfirmDialog`, `DeleteDialog`, and `SearchBar` as canonical, but none is re-exported from the top barrel — every caller uses a deep path (`@workspace/ui/components/confirm-dialog`, `.../layout/delete/delete-dialog`, `.../layout/search-bar/search-bar`), while `EmptyState`/`LoadingState`/`TooltipButton` come from `@workspace/ui`. This is the exact discoverability gap CODE-STANDARDS-ENFORCEMENT.md Tier 5 targets: the documented primitive is harder to find than rebuilding it.
- **Proposal:** Add `export * from './components/confirm-dialog'`, `export * from './components/layout/delete'`, and `export * from './components/layout/search-bar'` to `packages/ui/src/index.ts` (the latter two have their own `index.ts` already). Existing deep-path imports keep working; the canonical name simply becomes importable from `@workspace/ui`. (Note: scoped to documented primitives — this is not a license to barrel everything, per "What NOT to enforce.")
## Convention drift — the semantic / lint-gap layer

This is the "rules live in prose, not in CI" layer: small, individually-trivial deviations from documented standards (missing `staleTime`, `cn()`, `randomUUID`, inline `invalidateQueries`, toasts-in-components) plus two genuine cross-app inconsistencies. Everything below was opened and confirmed against the current tree. Findings that required adding ceremony purely to satisfy a lint rule — `enabled` guards on param-less admin/settings hooks that are already gated by their mount site, an unused `_userId` SSE parameter "for future use", and an ownerId-resolution refactor the finding itself waters down — were dropped as fighting "flat, direct, simple".

### `useAppPasswords` misses every part of the query-hook contract
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `packages/lib/src/core/auth/hooks/use-app-passwords.ts:5-48` (single consumer: `apps/space/src/routes/_auth.services.tsx`)
- **Problem:** This is the only `useQuery` in `packages/lib/src/core` that violates the contract three ways at once: no `staleTime` (refetches on every focus for data that changes rarely and never via SSE), no `enabled` guard, and a global cache key `appPasswordKeys.all = ['app-passwords']` with no `userId` — so the entry is shared across any identity that loads the page, against the "keys must include ownerId" pitfall in AGENTS.md. Both mutations also call `queryClient.invalidateQueries(...)` inline rather than via an exported `invalidate*()` helper (named Tier-3 drift in CODE-STANDARDS-ENFORCEMENT).
- **Proposal:** Bring it to the canonical `driveKeys`/`useFolder` shape: `appPasswordKeys = { all: (userId: string) => ['app-passwords', userId] as const }`; add `staleTime: 5 * 60 * 1000` and `enabled: !!user?.id` (`useAuth` from the same dir); extract `invalidateAppPasswords(queryClient, userId)` next to the keys and call it from both `onSuccess`. With exactly one consumer this is a contained fix.

### Toasts and API calls live in app components instead of hooks
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/index/src/routes/index.tsx:12,57-74` (raw `publicApi.waitlist.post()` + `toast.success`/`toast.error` + inline `setTimeout` delay + local form state machine); `apps/calendar/src/components/attendee-editor.tsx:12,42` (`toast.info('You cannot invite yourself')`)
- **Problem:** AGENTS.md and CODE-STANDARDS.md are explicit: "Never put `useQuery`, `useMutation`, error toasts, or `try/catch` + `toast.error()` in app components — all error handling lives in hooks." The landing page calls the waitlist endpoint directly and surfaces both success and error toasts from the route; there is no hook in `packages/lib` for it. The calendar case is a UI-layer validation toast where the silent guard already prevents the action.
- **Proposal:** Add `useJoinWaitlist()` in `packages/lib/src/core/public/hooks/` (`useMutation` with `onSuccess`/`onError` toasts, the artificial delay inside `mutationFn` if kept); the route just calls the hook and renders the form. For `attendee-editor.tsx`, drop the `toast.info` and the `sonner` import — the existing `if (… === currentUserEmail …) return;` already enforces it silently, matching how the other apps handle self-invite.

### 2FA page re-fetches the session by hand to read one missing `AuthUser` field
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/space/src/routes/_auth.security.2fa.tsx:30,37-46`; type at `packages/lib/src/core/auth/auth-context.tsx:5-14`
- **Problem:** `AuthProvider` already does `authClient.getSession()` on mount and stores `session.data.user` into `AuthUser` — but `AuthUser` omits `twoFactorEnabled`, so the 2FA page fires its own redundant `authClient.getSession()` in a raw `useEffect`, parks the result in a `boolean | null` local, and render-then-fetch flickers the whole page while pending. No other part of the app calls `authClient.*` from a component; everything reads user state from `useAuth()`.
- **Proposal:** Add `twoFactorEnabled?: boolean` to `AuthUser` in `auth-context.tsx`. better-auth's session already returns it, so it flows in through the existing `setUser(session.data.user)` with no new fetch. The page then reads `user.twoFactorEnabled` from `useAuth()` — deleting the effect, the local null-state, and the direct `authClient` call.

### EigenDoc editor access prop: docs takes `{canRead, canWrite}`, slides/stickies take `canWrite`
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/docs/src/components/docs/editor.tsx:94-108` (`access: { canRead, canWrite }`), passed `access={docInfo}` at `apps/docs/src/routes/_auth.doc.$ownerId.$mountId.$pathId.tsx:41`; `apps/slides/src/components/slides/editor.tsx:81-89` (`canWrite: boolean`); `apps/stickies/src/components/stickies/board.tsx:39` (`canWrite: boolean`)
- **Problem:** The four EigenDoc apps share the route layer but their top-level editor components diverge on prop shape. `canRead` is already enforced at the route before the component mounts, so the docs `access.canRead` field is redundant — only `canWrite` is consumed. An LLM following docs will rebuild the object shape; following slides it won't. This is the re-derivation/divergence vector the enforcement doc targets.
- **Proposal:** Change `CollaborativeEditor` (and its `TiptapEditor`) to accept a flat `canWrite: boolean`, matching slides and stickies; the route guard already covers `canRead`. One canonical, flat prop across all four editors.

### `SidebarContainer` builds className with a template literal instead of `cn()`
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `packages/ui/src/components/layout/sidebar/sidebar-container.tsx:32-38`
- **Problem:** CODE-STANDARDS.md mandates `cn()` for conditional Tailwind ("never use raw `clsx`/`twMerge` or string concatenation"). This is the only sidebar file still composing classes via a multi-line template literal with embedded ternaries; every sibling (`sidebar-item`, `sidebar-section`, `droppable-sidebar-item`, `app-sidebar`) uses `cn()`. Without `cn()`, tailwind-merge never runs, so conflicting width utilities (`w-16` vs `w-64`) aren't deduped.
- **Proposal:** `cn('border-r h-full overflow-y-auto overflow-x-hidden', isMobile ? (sidebarOpen ? 'fixed inset-0 z-50 bg-background' : 'hidden') : 'block', isTablet ? 'w-16' : 'w-64')`, importing `cn` from `@workspace/ui/lib/utils` like the siblings. This is also a clean candidate for the deferred Tier-2 `clsx`/`tailwind-merge` import-ban seam.

### `useRestoreVersion` invalidates chat messages inline instead of via the existing helper
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `packages/lib/src/core/versioning/hooks.ts:52`; helper at `packages/lib/src/core/chat/hooks/use-chat.ts:138`
- **Problem:** The callsite does `queryClient.invalidateQueries({ queryKey: chatKeys.messages(ownerId, mountId, pathId) })` directly. The canonical `invalidateMessages(queryClient, ownerId, mountId, chatId)` already exists and is used by the SSE handler and the chat read/send mutations. The inline form bypasses it, so a future change to `chatKeys.messages` shape won't be caught by grepping for `invalidateMessages`. (The surrounding "chat replaces data.db wholesale" comment is correct and should stay.)
- **Proposal:** Import `invalidateMessages` from `../chat/hooks/use-chat` and call it (`pathId` is the same value as the helper's `chatId`). One line, removes a maintenance split.

### `uuid` package used in two backend files where the rest use native `randomUUID`
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/contacts/contacts.ts:6` (5 `uuidv4()` calls); `apps/api/src/lib/calendar/calendar.ts:20` (7 `uuidv4()` calls)
- **Problem:** Eleven files under `apps/api/src/lib/` use `import { randomUUID } from 'node:crypto'` (Bun built-in, zero deps); only these two still pull `{ v4 as uuidv4 } from 'uuid'`, a third-party package providing the same cryptographic UUIDs. Pure consistency + an unnecessary dependency.
- **Proposal:** Swap both imports to `import { randomUUID } from 'node:crypto'` and rename the `uuidv4()` calls to `randomUUID()`. Once both are gone, `uuid` can be dropped from the manifest.

### `NotificationCenter.list()` hand-writes epoch SQL instead of a Drizzle operator
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/notification-center/notification-center.ts:92-96`
- **Problem:** The before-cursor uses `sql\`${schema.notifications.createdAt} < ${Math.floor(before.getTime() / 1000)}\`` — a raw template with a manual ms→seconds conversion that assumes knowledge of the column's storage unit. Every other date comparison in the backend (chat, collab, calendar) uses Drizzle's typed `lt()`/`lte()` with a `Date`, which maps timestamp-mode columns correctly and keeps type safety.
- **Proposal:** `import { lt } from 'drizzle-orm'` and `query = query.where(lt(schema.notifications.createdAt, before)) as typeof query;` — dropping the `Math.floor`/`getTime` and the multi-line literal, matching the chat callsite exactly.

### Single-use `get*Database` wrappers split the DB-open out of `init()`
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/contacts/contacts.ts:26-28` (called once at `:68`); `apps/api/src/lib/calendar/calendar.ts:105-107` (called once at `:272`)
- **Problem:** `getContactsDatabase(home)` and `getCalendarDatabase(home)` each wrap a single `home.getLocalDatabase(CONFIG, path)` expression with one caller and no logic — exactly the "Don't extract single-use helpers" anti-pattern in CODE-STANDARDS.md. `MailDB` and `NotificationCenter` correctly inline this call in `init()`.
- **Proposal:** Delete both free functions and inline `this.managedDb = await this.home.getLocalDatabase(...)` into each `init()`, matching the MailDB/NotificationCenter pattern.

### `array.forEach` on a live ObservableArray in `use-sheet.ts`
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/sheets/src/components/sheets/hooks/use-sheet.ts:78-88`
- **Problem:** `event.changes.delta.forEach(...)` and the nested `(delta.insert as Op[][]).forEach(...)` are plain array callbacks (not the functional `forEach(coll, fn)` from es-toolkit). Project convention prefers `for-of` and flips `array.forEach` on touch.
- **Proposal:** `for (const delta of event.changes.delta)` and `for (const ops of delta.insert as Op[][])` — identical logic, consistent style.

### `LightEditorToolbar` reimplements `TooltipButton` privately with native `title`
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** medium
- **Where:** `packages/ui/src/components/layout/editor/light-editor-toolbar.tsx:6-27` (only consumer: `light-editor.tsx`)
- **Problem:** It defines a local `ToolbarButton` that uses the browser-native `title` attribute and `p-1.5` sizing, plus a hand-rolled `onMouseDown`+`preventDefault`. The package already has `TooltipButton` (Radix tooltip, `h-8 w-8`, a `preventFocusLoss` prop that does exactly that mousedown handling) and AGENTS.md says "Don't rebuild Tooltip+Button manually." Two semantically identical buttons now diverge inside `packages/ui` itself.
- **Proposal:** Replace the private `ToolbarButton` with `TooltipButton` (`tooltipText` instead of `title`, `preventFocusLoss`, `className="h-7 w-7"` to keep the compact floating look), deleting the local component.

### `useValidateInviteToken` is missing `staleTime`
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `packages/lib/src/core/auth/hooks/use-invite-signup.ts:5-16`
- **Problem:** It has `enabled: !!token` and `retry: false` but no `staleTime`, so it refetches on every focus for the lifetime of the invite page — server load for an effectively immutable check. CODE-STANDARDS.md mandates explicit `staleTime` on every `useQuery`. (This is a precise target for the proposed Tier-3 "useQuery missing staleTime" GritQL rule.)
- **Proposal:** Add `staleTime: Infinity` — an invite token's validity doesn't change mid-session; if it has expired the user gets the error on submit.

### Query-key factories live in three different places
- **Impact:** low  ·  **Effort:** medium  ·  **Confidence:** high
- **Where:** inline at the hook top for the majority (`drive`, `calendar`, `mail`, `contacts`, `chat`, `space`, …); a separate `hooks/keys.ts` for `packages/lib/src/core/admin/hooks/keys.ts`; a domain-level `keys.ts` outside `hooks/` for `packages/lib/src/core/versioning/keys.ts` and `packages/lib/src/core/search/keys.ts`
- **Problem:** "Where do this domain's query keys live?" has three answers, with no size or structural rule distinguishing them (`adminKeys` is 11 lines and lives apart; `driveKeys` is larger and stays inline). CODE-STANDARDS.md's canonical example shows inline colocation. This is precisely the re-derivation risk the enforcement doc names — the layout an LLM copies depends on which domain it happened to read first.
- **Proposal:** Make inline colocation the single rule (already the majority and the documented one). Fold `admin/hooks/keys.ts` into its primary hook file, and move `versioning/keys.ts` + `search/keys.ts` (with their `invalidate*` fns) into `versioning/hooks.ts` and `search/hooks/use-search.ts`. Eliminates two layouts and reduces file count — consistent with "flat and direct".

### Collab WebSocket route puts `:ownerId` in the third path segment
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** medium
- **Where:** `apps/api/src/routes/collab.ts:98` (`.ws('/ws/collab/:ownerId/:mountId/:pathId', …)`); client URL in `packages/lib/src/core/api.ts` (`getCollabWebSocketUrl`)
- **Problem:** AGENTS.md: "every authenticated route must include `:ownerId` as the second path segment" to enable future load-balancer sharding by ownerId prefix. This is the only `.ws()` route, and the `/ws/` prefix pushes `ownerId` to position 3 — inconsistent with the sibling HTTP collab routes in the same file (`/collab/:ownerId/...`). A position-2 LB rule would mis-route WS traffic.
- **Proposal:** Rename to `/ws/:ownerId/collab/:mountId/:pathId` (protocol marker first, `ownerId` second), updating the Elysia route and `getCollabWebSocketUrl` together. Purely structural; no auth/logic change. (Also the natural target for the proposed Tier-4 "every authenticated route has `:ownerId` second" convention test.)
## Dead code & cleanup

All 20 raw findings verified as real and current — nothing was speculative or already covered by Biome (which only sees unused symbols *within* a file, never dead exports). They collapse into eight items: one genuine user-visible bug, one high-leverage "wire up knip + sweep the confirmed dead exports" lever (the enforcement doc's own Tier-4 mechanism, still unadopted), and six straightforward deletions. None recommend new abstraction; every fix is a removal, in line with "flat, direct, simple".

### `sidebarMode: 'hidden'` is a dead variant — and silently breaks the admin teams view

- **Impact:** high  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `packages/ui/src/components/layout/sidebar/sidebar-container.tsx:23` (only checks `=== 'none'`), `packages/ui/src/components/layout/app/layout-context.tsx:10` and `packages/ui/src/components/layout/app/app-shell.tsx:32` (union declares `'collapsible' | 'hidden' | 'none'`), `apps/admin/src/routes/__root.tsx:63`
- **Problem:** The `sidebarMode` union carries three values but `SidebarContainer` only branches on `'none'` (`if (sidebarMode === 'none') return null`). `'hidden'` therefore has runtime behaviour *identical* to `'collapsible'`. Admin passes `sidebarMode={isTeamDetailSelected ? 'hidden' : 'collapsible'}` intending to hide the sidebar on a team-detail view — it has no effect, so the sidebar stays visible. This is the only finding in the category with user-visible fallout, and it stems from a dead type-union member that encodes a misunderstanding.
- **Proposal:** Drop `'hidden'` from the union in both `layout-context.tsx` and `app-shell.tsx` (leaving `'collapsible' | 'none'`), and change the admin callsite to pass `'none'` when `isTeamDetailSelected`. One type edit plus a one-word string swap; collapsing the union to the two values the renderer actually honours makes the remaining states exhaustive.

### Wire up `knip` and sweep the confirmed dead exports

- **Impact:** high  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `packages/lib/src/core/mail/hooks/use-mailboxes.ts:10-12` (`mailboxKeys.details` / `detail` / `exists` — only self-referential), `packages/lib/src/constants/fonts.ts` (`DEFAULT_FONT`), `packages/lib/src/core/media/hooks/use-media-query.ts` (`useIsDesktop`), `packages/lib/src/validation/index.ts:6` (`EMAIL_REGEX` re-export), `packages/lib/src/core/clipboard/clipboard.ts` (`EIGEN_CLIPBOARD_MIME` export), `packages/lib/src/slides/types.ts:62` + `apps/slides/src/components/slides/types.ts:8` (`percentToPx`), `packages/lib/src/docs/eigendoc/index.ts:5` (`SmallMark` re-export), `packages/ui/src/components/layout/braket/index.ts` (`Bra`), `packages/ui/src/components/layout/linked-text.tsx` (`LinkedText` component — only its `URL_REGEX` is consumed)
- **Problem:** Nine exports across `lib` and `ui` have zero importers (verified by grep). Each is individually trivial, but together they are a *class* the current toolchain structurally cannot catch: Biome is single-file, and `CODE-STANDARDS-ENFORCEMENT.md` Tier 4 names `knip` as the tool for "unused *exports*, files, and dependencies across the monorepo" — yet it is still unadopted. Picking these off one-by-one in an audit is the slow path; the leverage is installing the standing check.
- **Proposal:** Add `knip` to CI (report-only first, then fail-on-new, exactly as the enforcement doc prescribes) and clear the nine confirmed hits in the same pass. Demote the four internal-only constants (`EMAIL_REGEX`, `EIGEN_CLIPBOARD_MIME`, and the `mailboxKeys` leaf trio) to module-private; delete the genuinely unused (`DEFAULT_FONT`, `useIsDesktop`, `percentToPx`, the `Bra` export + `bra.tsx`, the `SmallMark` *export* line — the mark stays registered via `extensions.ts`). For `linked-text.tsx`, move `URL_REGEX` to its sole consumer `chat-message-list.tsx` (or `packages/lib/src/constants/`) and delete the orphaned `LinkedText` component. This is the category's single highest-ROI move: one lever retires the whole vein and stops it re-accruing.

### Delete eight never-imported shadcn primitives (and two stranded Radix deps)

- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `packages/ui/src/components/kbd.tsx`, `item.tsx`, `native-select.tsx`, `navigation-menu.tsx`, `aspect-ratio.tsx`, `accordion.tsx`, `alert-dialog.tsx`, `packages/ui/src/components/layout/toolbar/tooltip-toggle.tsx` (re-exported at `toolbar/index.ts:6`)
- **Problem:** Eight shadcn/Radix primitives were scaffolded into `packages/ui` but have zero callers anywhere in the monorepo (verified — the one `AspectRatio` grep hit in `apps/docs/.../figure.tsx` is a local `useState` variable and CSS property, not the component). They are exported per-file via the `./components/*` package.json mapping, so they inflate the package's API surface and "make the component list harder to scan" with no consumer. `navigation-menu.tsx` and `accordion.tsx` are additionally the *only* real importers of `@radix-ui/react-navigation-menu` and `@radix-ui/react-accordion` (all other matches are `.vite` build artifacts).
- **Proposal:** Delete all eight files, remove the `tooltip-toggle` re-export line from `toolbar/index.ts`, and drop `@radix-ui/react-navigation-menu` + `@radix-ui/react-accordion` from `packages/ui/package.json`. No central barrel to touch (there is no `components/index.ts`), so the deletions are clean. Each is a self-contained shadcn primitive that re-scaffolds in minutes if a real feature ever needs it — knip (above) would also flag all eight, so this is the file-level half of the same sweep.

### Remove the dead `email_labels` / `emails_to_labels` schema

- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/mail/schema.ts:26-47`, `apps/api/src/lib/mail/db-config.ts:34-49` (v1 migration DDL)
- **Problem:** `emailLabels` and `emailsToLabels` are declared in the Drizzle schema and created by the v1 migration, but no route, no `MailDB` method, and no frontend hook references them (verified — zero importers outside the two definition files). The tables are created empty and unmanaged in every user's `mail.db`. Dead schema baked into a versioned migration is exactly the "noise that misleads future readers" the standards warn against.
- **Proposal:** Drop both table definitions from `schema.ts` and their `CREATE TABLE` / `CREATE INDEX` blocks from the v1 migration. Eigen is pre-release with no migration-compat guarantee (per project memory), so editing the v1 DDL is acceptable; label support, if ever wanted, lands cleanly as a fresh migration with real callers.

### Delete the unreachable `/data` route and its placeholder `DownloadHome`

- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/space/src/routes/_auth.data.tsx`, `apps/space/src/components/space/download-home.tsx`
- **Problem:** `DownloadHome` renders a disabled button and the text "This feature is not yet available." `SpaceSidebar` has no link to `/_auth/data` (verified), so the route is unreachable through any UI. This is the textbook case the project's own standard prohibits — "No placeholders in code: don't add stub methods for future use; only land code with a real caller today."
- **Proposal:** Delete both files. When data export actually ships, add the route, a real implementation, and the sidebar entry together.

### Remove dead local code: `reUploadImage` ghost params, `TeamMemberDetailToolbar`, two `LocalFilesystem` methods

- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `packages/lib/src/core/clipboard/clipboard.ts:70-98` (`_targetOwnerId`, `_targetMountId`), `apps/contacts/src/components/contacts/team-member-detail.tsx:7-9` + callsite `apps/contacts/src/routes/_auth.$filterType.$filterId.tsx:117`, `apps/api/src/lib/core/local-filesystem.ts:67` (`listDirs`) and `:158` (`pathBasename`)
- **Problem:** Three small dead-code smells that knip won't catch (they are params or intra-app helpers, not unused exports). `reUploadImage` takes underscore-prefixed `_targetOwnerId`/`_targetMountId` that both call sites dutifully pass but the body never reads — placeholders for cross-drive paste that was never built (the underscore prefix is also why Biome's `noUnusedVariables` stays silent). `TeamMemberDetailToolbar` is a function returning `<Toolbar>{null}</Toolbar>`; since `Column.toolbar` is `toolbar?: ReactNode` rendered as `{toolbar && (…)}`, omitting it produces the identical empty bar — the component is pure ceremony, violating "don't extract single-use helpers." `LocalFilesystem.listDirs()` and `pathBasename()` have zero callers across `apps/api`.
- **Proposal:** Drop the two `reUploadImage` params and stop passing them at the `apps/docs` and `apps/slides` editor call sites. Delete `TeamMemberDetailToolbar` and remove the `toolbar={<TeamMemberDetailToolbar />}` prop at line 117 (pass nothing). Delete both `LocalFilesystem` methods — `path.basename` is one import away and `listDirs` mirrors `list()` if ever needed.

### Inline the seven single-use `DriveType*` aliases into their unions

- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** medium
- **Where:** `packages/lib/src/types/drive.ts:22-28` (`DriveTypeDoc` … `DriveTypeFile`)
- **Problem:** Seven `type DriveTypeX = typeof DRIVE_TYPE_X` aliases exist solely to be assembled into `DrivePathType`, `DriveCollabType`, and `DriveContainerType` in the *same file* — no external consumer imports any of them (verified). (Note: the raw finding's stated rationale, that they have "zero callers" and the unions "inline the same literals", is inaccurate — the unions are built *from* these aliases at lines 30-37 and 155-157, so a blind delete would not type-check.) They are a textbook single-use indirection: a reader chasing `DriveCollabType` hops through four aliases to reach four string literals.
- **Proposal:** Replace each alias reference inside the three union definitions with the literal it resolves to (`type DriveCollabType = 'doc' | 'stickies' | 'slides' | 'sheets'`, etc.) and delete the seven aliases. The const declarations and the union types both stay; the file loses a layer of pointer-chasing with no loss of information. Lower confidence only because this is a judgment call on indirection, not a clear-cut dead symbol.

### Clear the three stale "team deletion not yet implemented" test stubs

- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/test/org.test.ts:237-238` (comment-only) and `:446-451` (empty `afterAll` body — comments only), `apps/api/src/test/org-drive.test.ts:1180-1183` (a `test()` that does a `drivePost` then asserts nothing)
- **Problem:** Three blocks mark tests removed because team deletion has no API endpoint (verified — no DELETE-team route exists). The empty `afterAll()` runs as a no-op on every suite execution, and `org-drive.test.ts:1175` is an assertion-free test that still does setup work — both are dead weight in the test run.
- **Proposal:** Delete the comment-only block and the empty `afterAll()` in `org.test.ts`, and the assertion-free placeholder test in `org-drive.test.ts`, replacing all three with a single tracked issue for team-deletion coverage. (If team deletion is on the near roadmap, implementing it and restoring real tests is the better long-term answer — but the dead stubs should not sit in the suite meanwhile.)

---

## Part B — Correctness, security, performance & maintainability

The deeper lens a linter can't see. Eleven dimensions.

| Dimension | Kept / Raw | Takeaway |
|---|---|---|
| **Type safety & type chain** | 7 / 13 | Chain largely intact, but missing route return types + `as` casts mask 2 real backend bugs and a null-deref. |
| **Error handling & async** | 7 / 10 | Two reachable backend races (collab close, `getHome` overwrite) + a ~20-site stuck-dialog frontend pattern. |
| **Security** | 5 / 10 | Pre-auth SSRF on first-run setup, an unguarded mount-list leak, user enumeration, stored XSS, non-atomic OTP. |
| **Performance** | 12 / 16 | Two app-wide React re-render cascades + an uncached multi-MB sheet parse; backend serial-awaits are cheap wins. |
| **State & cache** | 4 / 4 | All real, currently-reachable cache-coherence gaps — failed draft saves shown as "saved", stale Sent folder. |
| **Architecture** | 8 / 14 | Structurally sound; leverage is in 2 route-handler defects + barrel/boundary tidies, not REST renaming. |
| **Testing** | 6 / 8 | Two ACL/security tests pass **vacuously**; collab-WS tests dead in CI; 507 path untested. Green but isn't. |
| **Accessibility** | 6 / 10 | Weakest dimension: icon-only controls + clickable divs ship without accessible names or keyboard paths. |
| **Discoverability & docs** | 15 / 17 | Dead doc links, a half-documented type, and shared primitives AGENTS.md advertises but no barrel surfaces. |
| **Resource lifecycle** | 3 / 7 | Three Yjs collab hooks leak UndoManager/observers/WS-provider on teardown; a timer + a constants tidy. |
| **Standards conformance** | 5 / 8 | iMIP stale-`REQUEST` overwrite + an iCal serializer referencing timezones it never defines. |

The full Part B sections follow.
## Type safety & the end-to-end type chain

The audit's central type-chain rule — types flow Elysia handler → Eden Treaty → hook → component, fixed at the source with annotations, never with `as` casts — held up well. Verification confirmed two real bugs hiding behind missing annotations (a cancelled event leaking into free/busy with an invalid status value, and `updateLabel` shipping raw DB rows including internal timestamps), a latent null-deref crash in the drive editor, plus several clean cast/validation removals; one speculative defensive-validation finding was dropped as contrary to the project's "trust the type system" stance.

### Calendar event-range route: missing return type hides a cancelled-event free/busy bug
- **Impact:** high  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/routes/calendar.ts:155-182` (handler; the `as` cast is line 172); consumed in `packages/lib/src/core/calendar/hooks/use-calendar.ts:108-121`
- **Problem:** The `/calendars/:calId/event-range/:from/:to` handler branches between `FreeBusyBlock[]` and `CalendarEventOccurrence[]` with no explicit return type, so Eden infers a union that the hook papers over with `as CalendarEventOccurrence[]` at `use-calendar.ts:116`. Worse, line 172 does `status: e.status as FreeBusyBlock['status']` — but `CalendarEvent.status` is `'confirmed' | 'tentative' | 'cancelled'` (`types/calendar.ts:58`) while `FreeBusyBlock.status` only permits `'confirmed' | 'tentative'` (`types/calendar.ts:75`). A cancelled event is therefore reported as a free/busy block carrying an invalid `'cancelled'` status instead of being excluded. This violates "Don't break the type chain" (AGENTS.md) and the cast silently hides a reachable correctness bug.
- **Proposal:** Filter cancelled events before mapping — `events.filter((e) => e.status !== 'cancelled').map((e): FreeBusyBlock => …)` — and drop the `as FreeBusyBlock['status']` cast (the narrowed value then satisfies the type). Add the explicit handler return type `Promise<CalendarEventOccurrence[] | FreeBusyBlock[]>` (mirroring the access route at `calendar.ts:241`, which already annotates `Promise<{ ownerUserId: string; shares: CalendarShare[] }>`). That lets `use-calendar.ts:116` drop its cast. Leave the `as FreeBusyBlock[]`/`as CalendarEventOccurrence[]` casts in `useAllSharedCalendarEvents` (lines 191/218) — those are legitimate runtime union-discrimination via `sc.permission`, not removable by the annotation.

### Backend route handlers lack return types; `updateLabel` leaks the raw DB row
- **Impact:** high  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/contacts/contacts.ts:222-237` (`updateLabel` returns `typeof schema.labels.$inferSelect | undefined`); all contacts handlers `apps/api/src/routes/contacts.ts:42-171`; contacts domain methods `addContact` (135), `deleteContact` (156), `updateContact` (165), `deleteLabel` (239); unpinned handler boundaries in `apps/api/src/routes/calendar.ts:108,118,185,195,265`, `apps/api/src/routes/home.ts:15,28`, `apps/api/src/routes/chat.ts:30,60`. Canonical types: `packages/lib/src/types/label.ts`, `packages/lib/src/types/calendar.ts`.
- **Problem:** Two distinct symptoms of one root cause — handlers (and several domain methods) infer their response type instead of annotating it with the shared type. The concrete bug: `Contacts.updateLabel` SELECTs the row after the UPDATE and returns it raw, so the wire payload includes the `createdAt`/`updatedAt` timestamp columns (`schema.ts:22-23`) that are *not* part of the shared `Label` type, and it returns `undefined` when the id is missing instead of erroring — both leak internal shape and weaken every `Route.useSearch`/hook consumer downstream. Contrast `getLabels(): Promise<Label[]>` (`contacts.ts:202`), which is correct. The calendar/home/chat domain methods *are* already annotated (`createCalendar(): CalendarItem`, `postMessage(): Promise<ChatMessage>`, etc.), so those handlers infer correctly today — but the contract isn't pinned at the route boundary, so a future domain-method change silently shifts the wire type with no TS error. `home.ts:28` (`my-teams`) is the worst case: it returns a hand-built object literal with no named type, so the entire shape is structural and un-auditable. AGENTS.md: "Fix types at the source (add return type annotations to backend handlers using shared types)."
- **Proposal:** Make `updateLabel` map the row and tighten the contract: `return { id: updated.id, name: updated.name, color: updated.color };`, annotate `: Promise<Label>`, and `throw new ApiError(404, 'Label not found')` instead of returning `undefined`. Add explicit `Promise<T>` return types to the remaining contacts domain methods (`addContact(): Promise<string>`, `deleteContact(): Promise<void>`, `updateContact(): Promise<void>`, `deleteLabel(): Promise<void>`) and to the contacts/calendar/home/chat handlers, using shared types from `@workspace/lib/types/`. For `my-teams`, define and export a named type in `packages/lib/src/types/home.ts` (it is already consumed by `useMyTeams` in `use-home.ts:45`) and annotate the handler with it.

### Docs editor double-casts a DOM MouseEvent through `unknown`
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/docs/src/components/docs/editor.tsx:282,285`; hook at `packages/ui/src/components/layout/context-menu/use-context-menu.ts:7`
- **Problem:** TipTap's `onCommentContextMenu`/`onSelectionContextMenu` deliver a raw DOM `MouseEvent`, but `useContextMenu.handleContextMenu` is typed `(e: React.MouseEvent, …)`. The call sites bridge the gap with `event as unknown as React.MouseEvent` — an `as unknown` hop that bypasses TypeScript entirely. The hook only ever reads `preventDefault()`, `stopPropagation()`, `clientX`, `clientY` (`use-context-menu.ts:8-11`), all of which exist on both event types, so the synthetic-event lie is gratuitous.
- **Proposal:** Widen the one parameter in `use-context-menu.ts:7` to `(e: React.MouseEvent | MouseEvent, item: T)`. Both call sites in `editor.tsx` then pass `event` directly with no cast, and the type now honestly models that the hook works from either event origin. Flat, direct, and strictly safer.

### `native-file-editor` uses `data!` on a path reachable with `data === null`
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/drive/src/components/editor/native-file-editor.tsx:88,91,106,107`
- **Problem:** The early-exit guard at line 56 is `if (error || (!data && !preview))` — it only bails when *both* are missing, so the editing branch at lines 88+ is reachable with `data === null` whenever `preview` is truthy. The Edit button is gated by `!!data`, but `data` can become null after mount if the query refetches (e.g. the file is deleted in another tab) while the editor stays mounted; at that point `data!.updatedAt`, `data!.content`, `data!.editMode`, and `data!.frontmatter` all crash. The four `!` assertions assert a fact the control flow does not guarantee.
- **Proposal:** Add `if (!data) return <LoadingState />;` immediately before line 88. TypeScript then narrows `data` for the rest of the function and the four `data!` become plain `data.` accesses — handling the refetch race correctly with no extra state, matching the project's "guard at the real boundary, then trust the type" idiom.

### Drive export/convert and mail attachment routes take unvalidated path params
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/routes/drive.ts:162-173` (`export/:format`, no params schema), `apps/api/src/routes/drive.ts:174-185` (`convert/:targetType`, runtime `if` check but no schema), `apps/api/src/routes/mail.ts:274-286` (`attachment/:index/:fileName`, `Number(params.index)` at line 282, no schema)
- **Problem:** None of these routes declare a `params:` validator, so Elysia skips coercion/validation and Eden types the segment as a bare `string`. `export` passes any `:format` straight to `exportDocument`, and the callsite loses the `'docx' | 'pdf' | 'html' | 'xlsx'` literal union. `convert` re-checks `:targetType` by hand (`drive.ts:177`) — work a `t.Union` would do declaratively. `mail` converts `:index` with `Number()`, so `Number('')` → `0` quietly fetches the wrong attachment. (The downstream guard `index >= attachments.length` in `maildir.ts:207` means `NaN` degrades to a `null` body rather than crashing, so this is robustness/consistency, not a live exploit.) The sibling calendar event-range routes already use `t.Numeric()` for their `from`/`to` params, so this is an inconsistency as much as a gap.
- **Proposal:** Add params schemas: `export` → `format: t.Union([t.Literal('docx'), t.Literal('pdf'), t.Literal('html'), t.Literal('xlsx')])`; `convert` → `targetType: t.Union([t.Literal('eigensheets'), t.Literal('eigendoc')])` (this also deletes the manual `if`); `mail` → `index: t.Numeric({ minimum: 0 })`, which validates the boundary and narrows `params.index` to a number so the `Number()` call goes away. (Skip the `/settings/users/:filter` route flagged by the raw finding — it is an admin-only, intentionally home-independent route whose `filter` already falls through to a safe default with no crash path.)

### `validateSearch` casts its return instead of annotating it
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/mail/src/routes/_auth.$filterType.$filterId.tsx:48`, `apps/contacts/src/routes/_auth.$filterType.$filterId.tsx:23`
- **Problem:** Both `validateSearch` functions build an object literal and cast it `as MailSearchParams` / `as ContactsSearchParams`. TanStack Router derives every `Route.useSearch()` type from this function's inferred return, so the cast suppresses the one check that would catch a renamed or mistyped property and silently degrades type safety for all downstream search consumers. CODE-STANDARDS.md §Typing: "No `as Type` … add an explicit return type."
- **Proposal:** Annotate the function return type instead of casting: `validateSearch: (search: Record<string, unknown>): MailSearchParams => { … }`. The compiler then verifies the literal satisfies the type and the `as` cast is dropped.

### `auth.user!` is asserted across ~8 `_auth` route sites with no shared narrowing
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** medium
- **Where:** `apps/drive/src/routes/__root.tsx:55`, `apps/drive/src/routes/_auth.trash.tsx:47`, `apps/drive/src/routes/_auth.shared.$to.tsx:33`, `apps/drive/src/routes/_auth.mime.$mimeType.tsx:34`, `apps/docs/src/components/docs/editor.tsx:296,298`, `apps/sheets/src/components/sheets/editor.tsx:299`, `apps/slides/src/components/slides/editor.tsx:778`
- **Problem:** `useAuth()` returns `user: AuthUser | null`. Each of these components is only reachable behind the `_auth` route layout (which redirects when unauthenticated), but TypeScript can't narrow through the route boundary, so every site reaches for `auth.user!`. The count is real and growing, and `CODE-STANDARDS-ENFORCEMENT.md` flags `noNonNullAssertion` as a worthwhile *nudge* scoped to `packages/lib` (explicitly "a nudge, not a mandate").
- **Proposal:** Add a small `useRequiredAuth()` to `packages/lib/src/core/auth/` that calls `useAuth()`, throws if `user` is null, and returns `{ user: AuthUser; isAuthenticated: true }`. The throw is correct behaviour in the rare unmount-during-redirect case. All sites become `const { user } = useRequiredAuth()` with no assertion, while `useAuth()` keeps its `AuthUser | null` contract for components like `__root.tsx` that deliberately render for unauthenticated visitors. This is genuinely shared infrastructure (not single-use ceremony), so it stays within the "flat/direct" bar — but it is the lowest-priority item here and is optional polish, not a correctness fix.
## Error handling, resilience & async correctness

Eight of ten findings survived verification; the two strongest are reachable backend concurrency bugs (a delete-after-destruct race in collab close and a `getHome` factory-overwrite that orphans fully-initialised Homes), and the broadest is a ~20-site frontend pattern where unhandled `mutateAsync` rejections leave dialogs stuck open. Two were dropped as defensive code for paths that cannot occur in the current architecture.

### Frontend: unhandled `mutateAsync` rejections leave dialogs/forms stuck open

- **Impact:** high  ·  **Effort:** medium  ·  **Confidence:** high
- **Where:** `apps/calendar/src/components/edit-event-dialog.tsx:159,169,203,205,218,220` · `apps/calendar/src/components/event-detail-dialog.tsx:144` (`handleNonRecurringDelete`) · `apps/calendar/src/components/calendar-config-dialog.tsx:77,84,94` · `apps/calendar/src/components/create-event-dialog.tsx:140` · `apps/calendar/src/components/shared-calendar-config-dialog.tsx:54,62` · `apps/contacts/src/routes/_auth.new.tsx:25` · `apps/contacts/src/routes/_auth.edit.$filterType.$filterId.tsx:58,63` · `apps/admin/src/components/admin/create-user-dialog.tsx:40` · `apps/admin/src/components/admin/member-detail.tsx:56,68`
- **Problem:** Every mutation hook attaches `onError: onMutationError` (verified in `use-calendar.ts:60,74,88,…`), which fires the toast — but TanStack Query's `mutateAsync` still **rethrows** afterward. These handlers `await mutateAsync(...)` with no surrounding `try/catch`, so on failure the toast shows, the rejection escapes as an unhandled promise rejection, and the line *after* the await (`onOpenChange(false)`, `navigate(...)`) is skipped — the dialog stays open or the form sits stuck on a half-submitted contact. This is the dominant frontend instance of AGENTS.md "Think about every `await`": the success-path side effect is silently lost on the error path.
- **Proposal:** Where the handler only cares about side effects already owned by `onError`/`onSuccess`, switch `await mutateAsync(...)` to fire-and-forget `mutate(...)` (no rethrow). Where sequential awaits and a final close are needed, adopt the `try { … } finally { onOpenChange(false) }` shape **already used correctly** in `event-detail-dialog.tsx:handleRecurringDelete` (lines 102–140) so the dialog closes on both paths and the rejection is consumed. Do not add `toast.error()` in the components — error reporting stays in the hooks per CODE-STANDARDS § Error Handling.

### `closeCollabDocument` deletes the map entry after destruct, handing a closing doc to concurrent openers

- **Impact:** high  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/drive/drive.ts:822-834` (delete at line 829, after `await documentFn()` on 827 and `doc.destruct()` on 828)
- **Problem:** `this.documents.delete(key)` runs *after* the `await` and `destruct()`. During the async suspension a concurrent `getCollabDocument` (`drive.ts:805-818`) finds the key still present, returns the same singleton, and the WS `open` handler (`collab.ts:127-129`) calls `subscribe(user, ws)` on it. `subscribe` (`collabDocument.ts:270-276`) short-circuits on `if (this.closed) return` and never sends sync-step-1 — the client connects to a dead document and stalls with no initial state. The sibling `Mount.closeDatabase` (`mount.ts:1162-1170`) already documents the correct ordering: *"Delete BEFORE closing — a concurrent openDatabase() during the async close must create a fresh ManagedDatabase, not reuse the closing one."*
- **Proposal:** Mirror `Mount.closeDatabase`: capture the getter, `this.documents.delete(key)` first, then `const doc = await documentFn(); doc.destruct(); …`. Concurrent `getCollabDocument` callers then build a fresh singleton instead of receiving the closing instance.

### `getHome` race unconditionally overwrites a just-set factory, orphaning a fully-initialised Home

- **Impact:** high  ·  **Effort:** medium  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/home/get-home.ts:19-83` (delete at line 25, unconditional `homeFactories.set` at line 28)
- **Problem:** When the cached Home is `destructing`, the function deletes the factory (line 25) and **unconditionally** sets a new one (line 28). Two callers that both observe the destructing Home both reach line 28; the second `set` overwrites the singleton the first installed. The first factory's `createAsyncSingleton` closure still runs `await home.init()` to completion in the background, but nothing references it anymore — its `ManagedDatabase` SQLite handles, `openCold` sync `setInterval`, and the `Home.touch` idle timer (`home.ts:120`) never close, because the orphan's `cleanupHomeFactory(ownerId)` callback targets the *current* map entry (the second factory), not itself. Two live Homes for one owner then both subscribe to SSE and write the same `data.db`. This is a genuine TOCTOU across the `delete` → `set` gap, not theoretical.
- **Proposal:** After the delete, re-enter the singleton path instead of blindly setting: guard the `homeFactories.set` with a post-delete `if (homeFactories.has(ownerId)) return (await homeFactories.get(ownerId)!()).touch();`, so the loser of the race reuses the winner's factory. This matches the "only create if the map still has no entry" contract `createAsyncSingleton` itself relies on.

### Serialized `sendToHome` loops give shared-resource writes O(n) cold-Home latency

- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/drive/acl-propagation.ts:92-98` · `apps/api/src/lib/calendar/share-propagation.ts:35-41` and `75-92` (the `getMemberships` + `sendToHome` pair at lines 77 and 80)
- **Problem:** Each loop `await`s `sendToHome(userId, …)` sequentially, and `sendToHome` calls `getHome(targetUserId)` (`home-relay.ts:70`), which cold-initialises that user's entire Home (SQLite open + Drive/Mail/Calendar/notifications `init`). For a resource shared with N users the route blocks for the **sum** of N cold inits rather than the max; `propagateCalendarshare` additionally serialises a `getMemberships` round trip per user. These are independent per-user operations with no ordering constraint.
- **Proposal:** Replace the `for … await sendToHome` loops with `await Promise.allSettled(ids.map((id) => sendToHome(id, msg)))`, the exact pattern already used in `home.ts:destruct` (lines 262, 272). In `propagateCalendarShare`, move the `getMemberships` + `checkPermission` + `sendToHome` trio into the mapped async function so each user's work runs in parallel. `allSettled` preserves the existing per-user error isolation that the current `try/catch` provides.

### Bare `throw new Error` in setup escapes to a generic 500 the wizard can't read

- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/setup/setup.ts:325`
- **Problem:** After the `try/catch` that wraps org creation, `if (!org) throw new Error('Failed to create default organization')` throws a bare `Error`. better-auth's `createOrganization` can legitimately return a falsy value without throwing, so this path bypasses the descriptive `catch` at line 321 and reaches Elysia's global `onError`, which returns an opaque 500 to the setup wizard — indistinguishable from a filesystem fault. AGENTS.md is explicit: `throw new Error()` is for internal invariants only; a recoverable, user-facing setup failure is an HTTP error.
- **Proposal:** Use `throw new ApiError(500, 'Failed to create default organization')` (the `ApiError` import already exists at `setup.ts:15`) so the wizard receives a structured, displayable message. Every other guard in this function already uses `ApiError` (lines 266-294).

### Single global `ErrorBoundary` with no route isolation or reset

- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `packages/ui/src/components/layout/app/eigen-app.tsx:57` · `packages/ui/src/components/error-boundary.tsx:13-44`
- **Problem:** One `<ErrorBoundary>` wraps every app's entire router outlet. A render throw in any single route blanks the whole app to the generic "null vector" fallback, and the only recovery is `window.location.reload()` (`error-boundary.tsx:38`), which discards all in-progress drafts and navigates straight back to the broken route — there is no `reset`. No `__root.tsx` currently uses TanStack Router's `errorComponent` (confirmed: zero matches across `apps/*/src/routes/__root.tsx`), so nothing contains a per-view crash.
- **Proposal:** Add an `errorComponent` to each app's `createRootRouteWithContext()` (or wrap individual `<Column>` content) rendering the existing `ErrorState` from `@workspace/ui` (`packages/ui/src/components/layout/app/error-state.tsx`) as the fallback. The router's `errorComponent` supplies a typed `error` plus a `reset` callback — the idiomatic recovery path that lets the user retry or navigate away without a full reload. Keep the global `EigenApp` boundary as the last-resort catch for provider-level errors.

### Collab close/sync errors are swallowed with no diagnostic or client recovery

- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** medium
- **Where:** `apps/api/src/lib/collab/collabDocument.ts:302` (`closeCollabDocument(...).catch(() => {})`) · `apps/api/src/routes/collab.ts:154-161` (message handler `catch` logs only)
- **Problem:** Two failures on durability/sync-critical paths vanish. The empty `.catch(() => {})` at `collabDocument.ts:302` discards everything `closeCollabDocument` triggers — snapshot serialization, WAL checkpoint, and the S3 `onClose` upload on remote backends — so a failed final flush silently drops the last edits with no log entry, violating the AGENTS.md broken-window that fire-and-forget must have a *meaningful* `.catch()`. Separately, when `syncProtocol.readSyncMessage` throws on a malformed update (`collab.ts:158`), the handler only `console.error`s; the client gets no rejection signal and believes its update was applied, so the document silently diverges.
- **Proposal:** Replace the empty catch with a logging handler — `.catch((err) => console.error('[CollabDocument] closeCollabDocument failed:', err))` — matching the logged catches already used at `collabDocument.ts:235,241` and in `Mount.closeAllDatabases`. For the message handler, after logging, send a fresh sync-step-1 from `this.doc` back to the offending connection so the client re-syncs its full state rather than continuing on a diverged doc (the awareness decoder at `collabDocument.ts:341` already takes the recover-rather-than-crash stance).

---

**Dropped after verification.** *invite-propagation per-attendee catches* — the finding itself concludes no change is needed; the per-attendee fire-and-forget relay (with logging) is the deliberate, correct best-effort pattern, consistent with `notifySharedCalendarUsers`. *Home.init `initWaiters` reject path* — `Home.init` is only ever invoked through the `createAsyncSingleton` factory at `get-home.ts:78` (subclass `super.init()` calls funnel into that single invocation), so the `initWaiters` concurrency guard never has a second waiter; adding a reject channel hardens a path that cannot execute, which CODE-STANDARDS explicitly rejects ("don't add try-catch/null checks for cases that can't happen").
## Security — paths, headers & authorization

Five issues survived verification: a server-wide SSRF reachable pre-auth on first-run setup, a missing authorization guard that leaks every user's and team's mount list, an unauthenticated bulk user-enumeration endpoint, a stored-XSS vector from serving uploaded HTML inline without `nosniff`/CSP, and a non-atomic OTP consumption race. The dropped half were either already mitigated by the project's mandated header sanitizer/`validateName`, or were defense-in-depth hardening the finding itself flagged as not reachable.

### SSRF via caller-controlled S3 endpoint (unauthenticated on first-run setup)
- **Impact:** high  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/storage/s3-storage.ts:7-72` (`checkS3Connection` / `checkS3Versioning`); reachable via `apps/api/src/routes/setup.ts:10-16` (unauthenticated, gated only by `isSetupRequired()`), `apps/api/src/lib/setup/setup.ts:275`, `apps/api/src/lib/home/team-home.ts:60` (`requireTeamAdmin`), and `apps/api/src/routes/settings.ts:35,122,174` (`requireAdmin`)
- **Problem:** `checkS3Connection` takes a free-form `config.endpoint` and issues outbound network connections to it — a Bun `S3Client` write/exists/delete probe plus a signed `fetch()` to `${endpoint}/${bucket}?versioning` — with no scheme or host restriction. On a fresh install `POST /setup/s3check` is reachable by any unauthenticated caller, who can point `endpoint` at `http://169.254.169.254/...` (cloud IMDS), `http://localhost:5432`, or any internal host. The exception message is returned in the response body (`{ ok:false, message }` / `ApiError(400, ...)`), so the probe doubles as a reachability/error oracle for internal services. The 5 s `AbortSignal.timeout` bounds the window but does not prevent the request. AGENTS.md requires validating user input at system boundaries; this boundary validates nothing.
- **Proposal:** Validate the endpoint once, centrally, at the top of `checkS3Connection` so all six callers are covered: parse with `new URL(endpoint.startsWith('http') ? endpoint : 'https://' + endpoint)`, reject any non-`https?:` scheme and any host that is loopback/link-local/ULA (`localhost`, `127.0.0.0/8`, `::1`, `169.254.0.0/16`, `fc00::/7`), and throw `ApiError(400, 'Endpoint is not allowed')` with a generic message (don't echo which host was blocked). Additionally gate the pre-setup route with a localhost/trusted-IP check on top of `isSetupRequired()` so the SSRF surface is not internet-reachable during setup.

### `SharedDrive.listMounts()` has no authorization guard
- **Impact:** high  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/drive/sharedDrive.ts:79-81`; route `apps/api/src/routes/drive.ts:23-30`
- **Problem:** `listMounts()` delegates straight to `this.sharedDrive.listMounts()` with no membership or owner check. The route `GET /drive/:ownerId/mounts` obtains a `SharedDrive` for any non-self `ownerId` via `getSharedDrive(params.ownerId, user)` and calls it unconditionally, so any authenticated user (guests included) can read another user's or any team's mount list — IDs, names, storage types, total bytes used, file counts. It is the lone unguarded wide-scan method on `SharedDrive`: `getMimeTypeContents`/`getMountMimeTypeContents` call `requireTeamMembership()` (lines 94/103) and `getRootFolder` re-checks `canRead` (line 87). The guard was simply never added.
- **Proposal:** Mirror the existing `requireTeamMembership()` shape (lines 72-77): if `parseOwnerId(this.owner.id)` is a team, require the caller to be a member; otherwise require `this.user.id === this.owner.id`. Throw `ApiError(403, 'No read permission')` on failure before delegating — consistent with every other scoped method on the class.

### Unauthenticated `/p/users` bulk user enumeration
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/routes/public.ts:24-27` (`GET /p/user/:emailOrId`, `POST /p/users`); `apps/api/src/lib/space/public.ts:16-50` (`getPublicInfo` / `getBatchPublicInfo`)
- **Problem:** `POST /p/users` has no `auth: true` guard and accepts up to 100 email-or-id values per call, returning `{ name, email, avatar }` for every match; `GET /p/user/:emailOrId` is the single-value equivalent. The global limiter is 300 req/min per IP (`apps/api/src/app.ts:76-79`), so an unauthenticated host can probe ~30,000 addresses/min/IP and confirm which emails are registered users plus harvest their real names — a spearphishing/OSINT prerequisite on a self-hosted deployment. The FE only consumes these from authenticated app views (`usePublicUser` / `user-batcher.ts`); there is no unauthenticated use case. Avatars are served separately by the (legitimately public) `GET /p/avatar/:emailOrId`.
- **Proposal:** Add `auth: true` to both `/p/user/:emailOrId` and `POST /p/users`. Leave `/p/avatar/:emailOrId` and `/p/config` public (they are the only surfaces a pre-auth page needs). If pre-auth name resolution is ever genuinely required, add a narrow endpoint that returns `name` only (never `email`) under a tighter per-route limit.

### Uploaded HTML served inline at `/embed` without `nosniff`/CSP — stored XSS
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** medium
- **Where:** `apps/api/src/lib/drive/drive.ts:486-502` (`serveFile`); route `apps/api/src/routes/drive.ts:236-243` (`/embed/:fileName`, `disposition: 'inline'`)
- **Problem:** `serveFile` sets `Content-Type: path.mimeType` and returns the bytes with no `X-Content-Type-Options: nosniff` and no `Content-Security-Policy`. The stored `mimeType` is the attacker-controlled multipart `Content-Type` taken verbatim at upload (`drive.ts:289,296` → `result.mimeType`, with no server-side type check). A user with write access to a shared folder can plant an HTML file declared `text/html`; the `/embed/:fileName` route — reachable with only read permission and used by the preview system (`getScreenPreview` passes the embed URL at `drive.ts:249`) — serves it `inline` in the API server's own origin, so embedded script runs with the victim's cookies/session.
- **Proposal:** Add `'X-Content-Type-Options': 'nosniff'` to the `serveFile` response headers for every disposition. For the inline embed path specifically, neutralize active content: either add `Content-Security-Policy: sandbox` (or `default-src 'none'`), or force `Content-Disposition: attachment` when the resolved MIME type is `text/html` (or any scriptable type) so it cannot execute in-origin.

### OTP verification is not atomic — one code can mint two sessions
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/auth/guest-auth.ts:80-91` (`verifyOtpAndSignIn`)
- **Problem:** Verification runs SELECT → `await Bun.password.verify` → DELETE as three non-atomic steps. `Bun.password.verify` yields the event loop (~bcrypt cost), so two concurrent requests for the same email+OTP can both pass the SELECT and both verify against the same hash before either DELETEs — yielding two authenticated guest sessions from a single code. The sibling `requestOtp` was already hardened against exactly this interleaving (see its comment at lines 47-50 and the transaction at 53-70); the verify path is the counterpart gap. The in-memory 3/hour rate limit does not prevent replay of one valid code.
- **Proposal:** Delete the row *before* the async verify, inside a transaction, so a second concurrent caller finds nothing: in one `db.transaction`, SELECT the row, DELETE it (capturing it into an outer variable), then outside the transaction run `Bun.password.verify` against the captured hash and throw `ApiError(400, 'Invalid or expired code')` if absent/expired/mismatched. Consuming the OTP on a wrong guess is the correct trade-off (forces a fresh request) and matches the existing `requestOtp` reasoning.
## Performance & efficiency

Verification kept a tight set of high-leverage items: two React re-render cascades that fan out across whole apps, one O(days×events) render loop, an uncached multi-megabyte parse on the export path, and a cluster of serial-await/per-call DB round-trips on read hot paths. Dropped were two memoization findings whose premise — that memoizing props/callbacks would stop child re-renders — is false because the children involved are not `React.memo`-wrapped, making the fix pure ceremony against the project's "flat, direct, simple" bar.

### LayoutContext value is a fresh object literal on every AppShell render
- **Impact:** high  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `packages/ui/src/components/layout/app/app-shell.tsx:54-67`
- **Problem:** The `<LayoutContext.Provider>` value is an inline object literal rebuilt on every render. `AppShell` re-renders on every `useIsMobile`/`useIsTablet` change and on every one of its four `useState` updates (sidebar open/hidden, app name, document title). Context consumers re-render whenever the provider value identity changes — and at least a dozen components call `useLayout()` (Topbar, SidebarContainer, Column, the drive routes, etc.). So a single sidebar toggle or resize event cascades a re-render through every layout consumer in the app. Unlike prop-drilling, this cascade is not avoidable by memoizing the children — context subscription fires on value identity.
- **Proposal:** Wrap the value in `useMemo(() => ({ appName, setAppName, documentTitle, setDocumentTitle, sidebarOpen, setSidebarOpen, sidebarMode: effectiveSidebarMode, sidebarHidden, setSidebarHidden, isMobile, isTablet }), [appName, documentTitle, sidebarOpen, effectiveSidebarMode, sidebarHidden, isMobile, isTablet])`. The `useState` setters are stable, so the memo invalidates only when a primitive actually changes. This is the canonical context pattern, not added abstraction.

### MonthView / WeekView recompute O(days × events) on every render
- **Impact:** high  ·  **Effort:** medium  ·  **Confidence:** high
- **Where:** `apps/calendar/src/components/month-view.tsx:58-61` (un-memoized `weeks`), `apps/calendar/src/components/month-view.tsx:98-102` and `apps/calendar/src/components/week-view.tsx:93-97` (inline `getEventsForDay` per cell); helper at `packages/lib/src/core/calendar/calendar-utils.ts:70-81`
- **Problem:** `getEventsForDay(events, day)` does a full `.filter` over every event (confirmed at calendar-utils.ts:70), and it is called inline once per day cell inside the render map. For a 35-cell month over 200 events that is ~7,000 comparisons per render — and it re-runs on every render, including the re-render triggered by hovering/selecting an event (`setSelectedEvent`). The `weeks` slicing array is also rebuilt every render even though its only input, `days`, is already memoized. Neither view is `React.memo`-wrapped, so there is no boundary stopping the recompute.
- **Proposal:** Move `weeks` into `useMemo(() => …, [days])`. Build a `Map<string, CalendarEventOccurrence[]>` keyed by ISO date once in `useMemo(() => …, [events])`, then replace each inline `getEventsForDay` call with an O(1) Map lookup. This collapses per-render work from O(days × events) to O(events) once plus O(1) per cell.

### Sheet export re-parses the full snapshot JSON on every download with no cache
- **Impact:** medium  ·  **Effort:** medium  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/document/sheets.ts:12-22` (`readSheetsContent`), consumed uncached by `apps/api/src/lib/export/sheets/xlsx.ts:45-46`, `pdf.ts:12-14`, `html.ts:69-71` via `apps/api/src/lib/export/export-document.ts:27-29`
- **Problem:** `readSheetsContent` opens the collab `data.db`, replays the full Yjs state, reads the `state.snapshot` Y.Map entry (a single JSON string — up to ~48 MB in production per project memory), and runs a synchronous `JSON.parse` plus `replaySheetsOps` on the request path. The preview pipeline already wraps this in a robust read-through cache keyed by `updatedAt`, with in-flight dedup (`apps/api/src/lib/preview/preview-cache.ts`). The export pipeline has no equivalent cache, so every xlsx/pdf/html download — and any concurrent download of the same sheet — re-runs the whole open-replay-parse cycle, blocking the Bun event loop for the duration.
- **Proposal:** Reuse the preview cache's `updatedAt`-stamped, content-addressed filename strategy to cache export output (or at minimum the deserialized `Sheet[]`) so repeat/concurrent downloads hit disk instead of re-parsing. (The off-main-thread / `scheduler.run()` idea in the raw finding is a speculative future option and is excluded — the cache is the concrete win.)

### Drive ACL checks re-query memberships and breadcrumb per call
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/drive/drive.ts:776-790` (`canRead`/`canWrite` each fetch breadcrumb + memberships), `:431-447` (`movePath` calls `canWrite` twice, then re-walks ancestors via `mount.getPath` per level), `:636-637` (`updateACL` fetches breadcrumb + memberships a third time); `getMemberships` is two auth-DB SELECTs at `apps/api/src/lib/user/user.ts:48-58`
- **Problem:** `getMemberships` issues two SELECTs (member + teamMember) every call, and `canWrite`/`canRead` accept an optional `memberships` param that is never threaded from callers. `movePath` therefore fires `canWrite` twice → two `getBreadcrumb` + four membership SELECTs on the `MOVE` request, then the descendant-cycle guard at lines 440-446 re-queries `mount.getPath(ancestor.parentId)` once per ancestor level even though `canWrite(targetParentId)` already fetched that exact ancestor chain in one recursive-CTE breadcrumb. `updateACL` adds a third independent membership fetch. Pure waste on every ACL-gated drive op.
- **Proposal:** Resolve memberships once at the top of any op needing multiple checks and pass the `Memberships` object into each `canRead`/`canWrite` via the existing optional param. For the cycle check, reuse the breadcrumb already collected by the target's `canWrite` (or call `getBreadcrumb(targetParentId)` once) and walk it in memory instead of per-level `getPath` round-trips.

### getPathsByMimeType returns the entire mount with no LIMIT
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** medium
- **Where:** `apps/api/src/lib/mount/mount.ts:1210-1232`, exposed via routes `apps/api/src/routes/drive.ts:447-465`; reachable from the sidebar filter row `getDriveAppUrl('mime/image')` at `packages/ui/src/components/layout/sidebar/app-sidebar.tsx:54`
- **Problem:** The query is a `LIKE '<prefix>%'` scan that returns every matching row with no pagination. The AppSidebar's "Images" filter sends `mime/image` → `image/` prefix, so for a drive with thousands of images this loads all rows into memory and serializes them all over the wire. The `mimeType` column is indexed so the scan is fast, but the result cardinality is unbounded — the route was shaped for small eigendoc-container lists yet the LIKE-prefix makes it apply to broad media types.
- **Proposal:** Add an optional `limit` (and cursor) to both mime-filter routes and thread it into `getPathsByMimeType`; a default cap (e.g. 500) makes the endpoint self-protecting without breaking the eigendoc-container use case, which is small by count.

### emptyTrash deletes one item per round-trip on the request path
- **Impact:** medium  ·  **Effort:** medium  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/drive/drive.ts:412-418` (called on `DELETE /drive/:ownerId/:mountId/trash` at `apps/api/src/routes/drive.ts:533`); same shape in the fire-and-forget `apps/api/src/lib/mount/mount.ts:916-932` (`purgeTrash`)
- **Problem:** `emptyTrash` loads all trashed items then calls `permanentlyDelete` in a sequential `for…of`; each call does its own `getPath` + `permanentlyDeleteFromTrash` and emits a per-item SSE event. For N trashed items that is O(N) serial mount-DB round-trips on the request path. `purgeTrash` repeats the pattern (lower priority — it runs detached from the `Mount` constructor, not a request).
- **Proposal:** Batch the delete via a recursive-CTE DELETE (mirroring how `trashDescendants` already does a single `db.run(sql…)`) and emit one batch deletion event instead of N per-item SSE events on empty. The `purgeTrash` background job can share the same batch helper.

### syncTeamCalendars runs serial permission lookups on every shared-calendar read
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/calendar/get-calendar.ts:52-97`, called unconditionally by `GET /calendar/:ownerId/shared` at `apps/api/src/routes/calendar.ts:267-275`
- **Problem:** Every read of the shared-calendar list runs `syncTeamCalendars`, which serially awaits `pullCalendars` per team and `pullCalendarPermission` per calendar (each is a `getHome` + single-row SELECT, line 190-203 of home-relay.ts), then a second serial loop re-checks every user-shared calendar. For a user in T teams with C calendars each, that is T + T×C sequential round-trips per request, unbounded in team/calendar count, with no stale-time guard at this layer.
- **Proposal:** The per-team `pullCalendars` and each `pullCalendarPermission` are independent reads with no write dependency, so wrap both loops in `Promise.all` to collapse the T×C serial chain into one concurrent round.

### propagateInvitation resolves attendees in three serial loops
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** medium
- **Where:** `apps/api/src/lib/calendar/invite-propagation.ts:29-129` (added/removed/existing loops), same shape in `propagateCancellation`
- **Problem:** Each of the three attendee loops awaits `getUserByEmail(attendee.email)` per attendee against the shared auth DB; an update that adds/removes/keeps attendees fires one SELECT per attendee, fully serial. This runs on event create/update (a write side-effect path, not a read hot path), so impact is bounded.
- **Proposal:** Deduplicate the union of the three email lists, batch-resolve them once (`SELECT … WHERE email IN (…)`), and look up the result map in the loops. Keep the `sendToHome`/`addRegistryEntry`/`sendMail` side-effects in their existing per-recipient form — the safe win is collapsing the user lookups, not reordering the side-effects.

### listMounts serialises two aggregate queries per mount
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/drive/drive.ts:137-150`
- **Problem:** `listMounts` awaits `getTotalSize()` then `getFileCount()` sequentially inside a `for…of` over every mount, so independent SQLite aggregations across mounts and the two per-mount queries all serialise.
- **Proposal:** `await Promise.all([...this.mounts].map(...))` across mounts and `Promise.all([getTotalSize(), getFileCount()])` per mount.

### mailboxesList issues two count queries per mailbox
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/mail/maildir.ts:119-127` + `:777-791` (`getMailboxInfo`), backed by separate counts at `apps/api/src/lib/mail/maildb.ts:69-80`
- **Problem:** `GET /mail/:ownerId/mailboxes` loops the standard folders and calls `getMailboxInfo` per folder, which fires `getEmailsCount` and `getEmailsCountUnread` as two separate `COUNT(*)` queries — ~16 serial queries for one request. Absolute cost is low on a warm connection, but it scales with mailbox count.
- **Proposal:** Replace the two per-mailbox methods with one grouped query: `SELECT mailbox, COUNT(*) AS total, COUNT(CASE WHEN isRead=0 THEN 1 END) AS unread FROM emails GROUP BY mailbox`, reducing 16 queries to 1.

### Chat / linked-text re-tokenise every message on every render
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** medium
- **Where:** `packages/ui/src/components/layout/chat/chat-message-list.tsx:65-84` (`tokenize` + `RichContent`), `packages/ui/src/components/layout/linked-text.tsx:6-32` (`LinkedText`)
- **Problem:** `RichContent` calls `tokenize(text)` bare in the render body for every message, and `tokenize` runs two regex scans over the message text on every render — including the re-renders caused by hover/typing in a busy room. (The raw finding's "regex compilation" cost is overstated — `new RegExp(existingRegex)` clones an already-compiled pattern rather than re-parsing it; the per-call clone is to get a fresh `/g` `lastIndex`, which is correct.) The real waste is re-tokenising unchanged text on every parent render.
- **Proposal:** Wrap the token array in `useMemo(() => tokenize(text), [text])` inside `RichContent` (and the equivalent in `LinkedText`), so unchanged messages skip re-tokenising during hover/typing renders.

### ChatItem fires usePublicUser even in icon-only sidebar mode
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** medium
- **Where:** `apps/chat/src/components/chat/chat-sidebar.tsx:36-64`; hook at `packages/lib/src/core/drive/hooks/use-drive-access.ts:32-35`
- **Problem:** Every `ChatItem` calls `useDriveAccess(chat, undefined, [])`, which always calls `usePublicUser(path.ownerId)` (line 34) even though `allEntries` is only rendered when `!condensed`. In condensed (icon-only) mode the avatars are never shown, yet the hook subscription still exists and re-evaluates on every `unreadChatIds` change (frequent on SSE). (Note: items sharing one owner dedupe to a single network request via TanStack Query, so the cost is hook churn, not N requests.)
- **Proposal:** Extract the avatar strip into a small sub-component that is rendered only when `!condensed`, so `useDriveAccess`/`usePublicUser` mount only when avatars are actually displayed. Do not gate the hook with a conditional `condensed ? {…} : useDriveAccess(…)` — that violates the Rules of Hooks.

### displayEmails derivation runs un-memoised on every MailRoute render
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/mail/src/routes/_auth.$filterType.$filterId.tsx:104-107`
- **Problem:** `selectedEmailInData = emails.find(...)` and `displayEmails = … emails.map(...)` are computed bare in the render body, so a `.find` + `.map` over the full mailbox runs on every render — and this route holds several UI states (`deleteDialogOpen`, `pendingDeleteEmails`, `filePickerOpen`) that toggle on interaction.
- **Proposal:** Wrap both in one `useMemo(() => { … }, [emails, selectedEmail])`, matching the `useMemo` already used for `attachRefs`/`initialDriveAttachments` in the same file. (Kept because it is a one-liner consistent with existing neighbours, not because it cures a re-render cascade.)
## State & cache correctness

All four raw findings survived verification: each is a real, currently-reachable cache-coherence gap in the TanStack Query / SSE layer, and each fix is a flat one-liner-to-small-block change that aligns with the project's own query-key and invalidation conventions (none requires new abstraction). They range from a user-visible "saved but actually failed" desync down to one wasted refetch per calendar-share. These are exactly the semantic, cross-file cache issues `CODE-STANDARDS-ENFORCEMENT.md` flags as Tier-4 "fitness function" territory that Biome cannot see — none is lint-catchable.

### Draft auto-save optimistic update has no rollback — failed save shows edits as "saved"
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `packages/lib/src/core/mail/hooks/use-draft.ts:85-102` (`onMutate`) and `:112` (`onError`); depends on `packages/lib/src/core/mail/hooks/use-emails.ts:49` (`useEmail` `staleTime: Infinity`)
- **Problem:** `useUpdateDraft`'s `onMutate` writes the user's edits into the draft-detail cache via `setQueryData` but returns no context, so `onError` (`onMutationError`, toast-only) has nothing to roll back to. The save is a real network PUT fired on unmount/auto-save; on a 5xx or offline failure the cache permanently shows the unsaved edits as the canonical draft. Because `useEmail` is `staleTime: Infinity` and the server-side `MAIL_DRAFT_UPDATED` SSE only fires on *success* (`apps/api/src/lib/mail/maildir.ts:359,531`), the wrong state never auto-heals — it persists until a manual navigation triggers an explicit invalidation or the composer remounts. The standard TanStack optimistic-update contract (save previous, return as context, restore on error) is half-implemented.
- **Proposal:** Complete the pattern: in `onMutate`, after capturing `previous`, `return { key, previous }`; change `onError` to `(err, _vars, context) => { if (context) queryClient.setQueryData(context.key, context.previous); onMutationError(err); }`. `onSuccess` already overwrites with the server response, so rollback only affects the error path. Flat, direct, no new helper.

### Sent folder never invalidated after sending — list stays stale up to 60s
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `packages/lib/src/core/mail/hooks/use-draft.ts:123-128` (`useSendDraft` `onSuccess`) and `packages/lib/src/core/mail/sse-handlers.ts:68-72` (`MAIL_SENT` case)
- **Problem:** After a send, neither path invalidates `emailKeys.list(ownerId, 'Sent')`. `useSendDraft.onSuccess` invalidates mailboxes, the Drafts list, and home size; the `MAIL_SENT` SSE handler invalidates mailboxes, home size, and search but ignores `mail.mailbox` — even though the backend emits `{ messageId, mailbox: 'Sent' }` (`apps/api/src/lib/mail/maildir.ts:662`). Result is a visible asymmetry: the item vanishes from Drafts immediately but does not appear in Sent until the 1-minute `staleTime` lapses and a focus/mount refetch fires. The exact tool already exists — `invalidateMailReceived(queryClient, userId, mailbox)` (`use-emails.ts:178`) takes the mailbox argument and is how `MAIL_RECEIVED` keeps the inbox fresh.
- **Proposal:** Mirror the inbox path. In `MAIL_SENT`, call `invalidateMailReceived(queryClient, userId, mailbox)` (the normalized `mailbox` is already in scope). In `useSendDraft.onSuccess`, add `queryClient.invalidateQueries({ queryKey: emailKeys.list(ownerId, 'Sent') })`.

### `useCollabDocumentInfo` enabled guard omits `!!mountId`
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `packages/lib/src/core/collab/hooks/use-collab.ts:31`
- **Problem:** The guard is `enabled: !!ownerId && !!pathId`, but both the query key (`:14`) and the request (`:18`, `api.collab({ ownerId })({ mountId })({ pathId })`) use `mountId` as a path segment. An empty `mountId` (a route rendering before its URL param resolves, or a future caller passing `''`) would fire a malformed request with an empty path segment. The sole current call site (`packages/ui/src/hooks/use-eigen-doc-editor-route.ts:26`) passes non-empty route params, so this is latent rather than firing today — but it violates the documented query-hook standard (`docs/CODE-STANDARDS.md:84`, `enabled: !!ownerId && !!mountId && !!pathId`) that every sibling collab/drive hook follows.
- **Proposal:** Broken-window fix — `enabled: !!ownerId && !!mountId && !!pathId`. One token, matches every neighbour.

### Calendar share/unshare invalidates the recipient's own events
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** medium
- **Where:** `packages/lib/src/core/calendar/hooks/use-calendar.ts:340` and `:345` (`invalidateCalendarShared`, `invalidateCalendarUnshared`); reached from `packages/lib/src/core/calendar/sse-handlers.ts:43-49`
- **Problem:** Both functions invalidate `sharedCalendars(ownerId)` (correct) *and* `events(ownerId)` (the recipient's own event-range queries). A share/unshare event doesn't change the recipient's own events; the shared calendar's events are keyed under the *other* user's id — `calendarKeys.calendarEvents(sc.ownerUserId, …)` via `useAllSharedCalendarEvents` (`:183`) — so they sit outside the `events(ownerId)` prefix and are picked up by the auto-mount cycle once `sharedCalendars` refetches. The `events(ownerId)` line therefore only triggers a wasted refetch of the recipient's own ranges per share/unshare. (Confidence medium because it's a verified inefficiency, not a correctness bug — the current behaviour is merely redundant work on a rare action.)
- **Proposal:** Drop the `queryClient.invalidateQueries({ queryKey: calendarKeys.events(ownerId) })` line from both functions; the `sharedCalendars(ownerId)` invalidation alone drives the auto-mount of the new calendar's queries. Removes one round-trip per event.
## Architecture — module boundaries & API consistency

Verification kept eight findings: two route-handler defects with real correctness/validation impact (a duplicated S3 schema that accepts empty credentials, a chat `limit` param that silently returns zero rows), four small consistency/hygiene fixes that protect the Eden type chain and documented standards, and two latent-crash module-boundary issues in `packages/lib`. Four REST-naming/HTTP-method findings were dropped as URL-rename churn with no correctness driver — the project documents `:ownerId` placement, not pluralization or verb purity, and `What NOT to enforce` warns against ceremony.

### S3 mount schema duplicated inline in `team.ts`, weaker than the canonical `s3ConfigBody`
- **Impact:** high  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/routes/team.ts:89-98` (POST `/mount`) and `apps/api/src/routes/team.ts:116-125` (PUT `/mount/:mountId`); canonical schema at `apps/api/src/routes/shared-schemas.ts:49-74`
- **Problem:** `team.ts` hand-rolls the `s3Config` object twice and never imports the shared `s3ConfigBody`/`toS3Config`. The inline version diverges in two concrete ways: (1) `endpoint`/`bucket`/`accessKeyId`/`secretAccessKey` use bare `t.String()` with no `minLength`, so **empty-string S3 credentials pass validation**; (2) `prefix` is required (`t.String()`) where the canonical schema makes it optional and defaults it to `''` in `toS3Config`. `home.addMount`/`updateMount` (`team-home.ts:49-92`) take `s3Config?: S3Config` whose `prefix` is required — so the inline schema forces the client to send a prefix the admin S3 form does not, and the two surfaces disagree on the same operation. `setup.ts` and `settings.ts` already reuse `s3ConfigBody` + `toS3Config`; `team.ts` is the lone outlier.
- **Proposal:** `import { s3ConfigBody, toS3Config } from './shared-schemas'`; replace both inline `t.Object({...})` blocks with `s3ConfigBody`; pass `toS3Config(body.s3Config)` into `home.addMount`/`updateMount`. Mechanical, matches the existing two callers, and closes the empty-credential and prefix-required gaps in one move.

### Chat `limit` query param typed as `t.String()` + manual `parseInt`, yields silent zero-result responses
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/routes/chat.ts:18` (handler) and `:24` (schema), in GET `/chat/:ownerId/:mountId/:chatId/messages`
- **Problem:** the schema declares `limit: t.Optional(t.String())` and the handler does `Math.min(Math.max(1, query.limit ? parseInt(query.limit, 10) : 50), 200)`. `limit=abc` → `parseInt` = `NaN` → `Math.max(1, NaN)` = `NaN` → `Math.min(NaN, 200)` = `NaN`, which SQLite's `LIMIT` treats as `0`. The caller gets **zero messages with a 200**, not a 4xx. This bypasses the project's validate-at-boundaries rule, and the sibling endpoints `notification.ts:21` and `search.ts:57` already validate `limit` at the schema so Elysia rejects bad values before the handler.
- **Proposal:** match the siblings — `limit: t.Optional(t.Number({ minimum: 1, maximum: 200 }))` — and collapse the handler to `const limit = query.limit ?? 50;`. (`notification.ts`/`search.ts` use `t.Number` on a query param and it coerces correctly, so reuse that exact shape rather than introducing `t.Numeric`.)

### Five imports use non-canonical `@workspace/lib/core/…` deep paths that bypass the exports map
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/collab/collabDocument.ts:1` (`/core/collab/yjs-utils`), `apps/api/src/lib/chat/commands.ts:1` (`/core/chat/emotes`), `apps/space/src/routes/_auth.services.tsx:8` (`/core/auth/hooks/use-app-passwords`), `apps/admin/src/components/admin/setup-wizard.tsx:2` (`/core/api-error`), `apps/drive/src/routes/_auth.fs.$ownerId.$mountId.$pathId.tsx:5` (`/core/api-error`)
- **Problem:** `packages/lib/package.json` maps `"./*": "./src/core/*"`, so the canonical sub-path is `@workspace/lib/<file>` (e.g. `@workspace/lib/api-error`, `@workspace/lib/collab/yjs-utils`). Prefixing with `core` resolves through the exports map to `src/core/core/...`, which does not exist. These five only compile because every consumer's `tsconfig` declares a two-entry fallback `["./src/core/*", "./src/*"]` and the **second** entry happens to match `src/core/...`. That is tsconfig-only resolution: invisible to any bundler that honours `package.json` exports, and it breaks silently if the fallback order changes. Every other consumer in the repo uses the canonical paths.
- **Proposal:** rewrite the five specifiers to canonical form (`@workspace/lib/collab/yjs-utils`, `@workspace/lib/chat/emotes`, `@workspace/lib/auth/hooks/use-app-passwords`, `@workspace/lib/api-error`) — import-string change only, no code. Optionally add a grep CI check (in the style of the existing `check-home-imports.ts`) that fails on any literal `@workspace/lib/core/` to prevent regression.

### Delete handlers return implicit `void` in contacts and mail, `{ success: true }` everywhere else
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/routes/contacts.ts:89` and `:131`, `apps/api/src/routes/mail.ts:122` (DELETE `/message/:id`); canonical shape at `drive.ts:337`, `calendar.ts:131`, `notification.ts:61`
- **Problem:** `deleteContact`, `deleteLabel` (`contacts.ts:156,239`) and `messageDelete` (`maildir.ts:221`) all return `void`, and the handlers `return await …` that undefined. Elysia serialises it as an empty 200, so Eden Treaty infers the response type as `void` for these destructive ops while drive/calendar/notification infer `{ success: true }`. Equivalent operations expose inconsistent types to mutation callbacks and optimistic-UI code — a type-chain inconsistency the standards explicitly guard.
- **Proposal:** after each void domain call, `return { success: true as const };`, matching drive/calendar/notification/chat. Three lines added, zero removed, immediately aligns Eden inference.

### Types re-exported through domain barrels, violating "domain barrels export values only"
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `packages/lib/src/core/drive/hooks/use-drive-access.ts:9-25` defines `DirectAccessItem`/`InheritedAccessItem`/`DriveAccessItem`, re-exported via `export *` in the `drive` barrel and imported as types by `packages/ui/src/components/layout/drive/drive-access-list-edit.tsx:4` and `drive-share-summary.tsx:1`. `packages/lib/src/core/calendar/calendar-utils.ts:5` defines `ViewMode`, re-exported by the `calendar` barrel, imported by `apps/calendar/src/components/calendar-toolbar.tsx:1`. `AuthContextType` (`packages/lib/src/core/auth/auth-context.tsx:16`) flows through the `auth` barrel into **13** apps' `__root.tsx` for TanStack Router context typing.
- **Problem:** AGENTS.md and the `feedback_no_type_reexports.md` standard require types to be imported directly from `types/<domain>`, not pulled through value barrels. The drive and calendar types live in hook/util files and leak through `export *`. `AuthContextType` is React-coupled (it is the context shape) so it cannot move to `types/`, but it need not flow through the barrel either.
- **Proposal:** move `DirectAccessItem`/`InheritedAccessItem`/`DriveAccessItem` to `packages/lib/src/types/drive.ts` and `ViewMode` to `packages/lib/src/types/calendar.ts`, updating the three import sites. Point the 13 `AuthContextType` imports at the concrete source `@workspace/lib/auth/auth-context` (already reachable via the `./*` wildcard) instead of the barrel. Note: because the barrels use `export *` rather than literal `export type` statements, a GritQL "ban `export type` in `core/**/index.ts`" rule would **not** catch these — the fix has to move the definitions, not just lint the barrel.

### `packages/lib/src/core/html.ts` mixes a DOM-only function into a backend-imported module
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `packages/lib/src/core/html.ts:10-14` (`htmlToPlainText` calls `document.createElement`); imported by 11 `apps/api` files (e.g. `lib/core/mail-composers.ts:1`, `lib/waitlist/waitlist.ts:2`, `lib/export/doc/render.ts:1`)
- **Problem:** the module exports `escapeHtml` and `stripTagsServer` (pure, BE-safe and BE-used) alongside `htmlToPlainText`, which calls a DOM API that does not exist under Bun. No crash today because the API only imports the two safe functions, but the unsafe one sits on the exact module path the backend already pulls. Any future `import { htmlToPlainText } from '@workspace/lib/html'` in API code crashes at runtime — the same class of module-eval hazard the engine-React-free seam exists to prevent. `htmlToPlainText` has two real FE callers in `apps/slides`, so it can't simply be deleted.
- **Proposal:** split into `html-server.ts` (`escapeHtml`, `stripTagsServer`) and keep `htmlToPlainText` in a browser-only file; add the named exports and repoint the 11 API imports at the server file and the two slides imports at the browser file. The BE-safe surface becomes explicit and the DOM call is unreachable from the API.

### Settings `/users/:filter` accepts arbitrary strings; unknown values silently return members
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/routes/settings.ts:130-155` (GET `/settings/users/:filter`)
- **Problem:** the handler branches on `params.filter === 'guest'` with no `params` schema, so `/settings/users/anything` falls through to the member list (`settings.ts:146-152`). The valid values are invisible to Eden Treaty and Elysia can't reject bad input at the boundary — a direct violation of validate-at-boundaries. Admin-only, so the security blast radius is small, but it's a free correctness/clarity win.
- **Proposal:** add `params: t.Object({ filter: t.Union([t.Literal('guest'), t.Literal('member')]) })`. Handler logic is unchanged; Elysia returns 422 for unknown filters and the union surfaces in the client type.

### `packages/lib` BE-safe surface is not mechanically enforced (barrel + wildcard sub-path vectors)
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** every React-heavy domain barrel (`packages/lib/src/core/{calendar,chat,drive,auth,mail,…}/index.ts`, each `export *`-ing `./hooks`); FE-only direct modules `packages/lib/src/core/eigendoc-icons.ts` and `file-presentation.ts` (import `lucide-react`) and `command-palette/`; exposed by the wildcard `"./*": "./src/core/*"` in `packages/lib/package.json`; `apps/api/src/lib/calendar/calendar.ts:2-3` carries only a prose comment as the guard
- **Problem:** the API stays React-free today by importing sub-paths (verified: **no** `apps/api` file imports any domain barrel or FE-only sub-path). But nothing stops a future convenience import of `@workspace/lib/calendar` or `@workspace/lib/eigendoc-icons` in API code from pulling `@tanstack/react-query`/React/`lucide-react` into the backend graph and crashing at module-eval. The two landed seams in `biome.jsonc` (engine-React-free, `lib`↛`sheet`) prove this is enforceable and low-false-positive; the parallel BE→FE-barrel seam is the one gap. The CODE-STANDARDS-ENFORCEMENT doc already classifies this tier as the highest-leverage, and the API genuinely never needs these paths, so a ban carries no real false-positive risk.
- **Proposal:** add one `biome.jsonc` `overrides` entry scoped to `apps/api/src/**` (modelled on the existing `lib`↛`sheet` override) that bans the FE domain barrels plus the known FE-only sub-paths (`@workspace/lib/eigendoc-icons`, `@workspace/lib/file-presentation`, `@workspace/lib/command-palette`), each with a message pointing at the safe sub-path. Pair it with a one-line note in AGENTS.md naming the BE-safe subset (`types/*`, `sheets/*`, `validation/`, `html-server.ts`, `date.ts`, `constants/`, and the named utility sub-paths). No code reorganization — the split already exists in the file layout; this only makes it mechanical.
## Testing quality & coverage

Six findings survived verification; the two highest are real test-correctness bugs where a helper or skip-guard lets a security/ACL test pass without ever exercising the thing it claims to verify, plus three genuine coverage gaps (mount-quota 507, WebDAV Destination traversal, a known order-dependent flake) and one debuggability fix. Two findings were dropped: the "no HTTP restore convergence" gap (the internal `restoreContainer` tests at `versioning.test.ts:232-264`/`296-327` already assert restored content, so a silent no-op would fail) and the "global context pollution" item (speculative, and its try/finally proposal adds the defensive ceremony CODE-STANDARDS discourages while the tests that matter already use `afterEach`).

### ACL access-denial tests pass vacuously because `driveGet` turns 403 into `[]`

- **Impact:** high  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/test/setup.ts:181` (`return res.status !== 200 ? ([] as T) : ...`); the three access-denial tests at `apps/api/src/test/drive.test.ts:317-324`, `:564-571`, and `:716-723` (the finding cited only the first two)
- **Problem:** `driveGet`/`driveGetList` collapse every non-200 response to a typed empty array. The denied path is real — `SharedDrive.getFolderContents` is wrapped in `withReadPermission`, which throws `ApiError(403)` (`apps/api/src/lib/drive/sharedDrive.ts:47,116`). So each `expect(contents).toEqual([])` passes whether the server returns 403 (denied) or 200-with-`[]` (allowed but empty). These tests cannot distinguish "access denied" from "permitted and empty", so a silently-broken ACL check that exposed an empty-but-readable folder would still go green. This is the vacuous-pass failure the standards' "verify end-to-end" bar exists to prevent.
- **Proposal:** Rewrite the three denial tests to use `authedRequest` directly and assert `expect(res.status).toBe(403)`, matching the existing status-assertion pattern (`streaming-upload.test.ts:101`, `acl-bubbling.test.ts:381+`). The empty-array equality stays valid for the *positive* listing tests; only the denial assertions need the status check.

### Five collab WebSocket security tests are structurally dead — they `return` before asserting

- **Impact:** high  ·  **Effort:** medium  ·  **Confidence:** high
- **Where:** `apps/api/src/test/collab.test.ts:144-174` (ping-pong), `:235-267`, `:269-315`, `:317-344`, `:346-384` (Document Updates), `:388-431`, `:433-483` (Permission Changes); logic under test at `apps/api/src/lib/collab/collabDocument.ts:306-317`
- **Problem:** Every one of these tests opens with `if (wsRes.status !== 101) { return; }`. In Bun's in-process `app.handle()` test environment the HTTP→WS upgrade does not complete to 101, so the `return` fires and Bun records a passed test with zero assertions executed. The bodies that never run include the core authorization checks — "read-only user cannot mutate the doc", "downgrading to read-only prevents writes", "revoking permission disconnects" — so the write-permission enforcement is effectively untested in CI while appearing green. (The two earlier tests at `:110-122` and `:124-142` use an acceptable `expect(...).not.toBe(101)` shape and are fine; the auth-guard skip there is legitimate.)
- **Proposal:** Test the enforcement logic where it lives, not through a WS upgrade that cannot happen in-process. `CollabDocument.handleMessage(conn, update, canWrite)` drops sync type-1/type-2 messages when `!canWrite` (`collabDocument.ts:315`). Unit-test it directly: construct a `CollabDocument`, feed a sync-update payload with `canWrite=false`, and assert the `Y.Doc` state is unchanged; repeat with `canWrite=true` and assert it applies. This converts three dead security tests into real ones with no WS dependency.

### Mount capacity quota (507 Insufficient Storage) has zero integration coverage

- **Impact:** high  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/config/enforcement.ts:41` (`enforceMountQuota` → 507) and `:48-50` (`getUploadMaxSize` → 507 when remaining ≤ 0); only the 413 per-file path is tested, at `apps/api/src/test/settings.test.ts:110-133`
- **Problem:** The single upload-limit test exercises `maxUploadSizeMB` (a 413), a different code path from the mount-capacity 507. No test fills a mount near its `maxSizeMB` and confirms the next upload is rejected with 507, even though that path guards both drive uploads and WebDAV PUT. An off-by-one or sign error in `used + addBytes - creditExisting > max` would ship undetected.
- **Proposal:** Add a test next to the existing 413 case: create a team mount with `maxSizeMB: 1` via the already-used `POST /team/:teamOwner/mount` helper (`settings.test.ts:165-176`), upload ~0.9MB to fill it, then upload another file exceeding the remainder and assert `res.status === 507`. Mirror the structure of "upload exceeding max upload size returns 413" exactly.

### Known-flaky "disabling one mount" test depends on `Object.keys` order and a prior test's side effect

- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/test/settings.test.ts:249-264`
- **Problem:** The test does `const [id1, id2] = Object.keys(mounts)`, disables `id1`, then asserts `id2` stays enabled — leaning on object insertion order and on "admin can disable a mount" (`:184-200`) having already run. It is the confirmed intermittent CI failure recorded in project memory; under the parallel workspace runner the ordering/shared-state coupling occasionally breaks and the assertion either passes trivially or fails for the wrong reason.
- **Proposal:** Make the test self-contained: resolve the two mounts by name (as the sibling test at `:266-269` already does with `Object.entries(...).find(([, m]) => m.name === 'Archives')`), capture each mount's `enabled` before mutating, disable one, assert the delta (`disabled === false`, the other `=== true`), then re-enable as cleanup. This removes both the key-order assumption and the cross-test dependency.

### Test helpers `drivePost`/`drivePut`/`driveDelete` parse JSON on any status, masking HTTP errors

- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/test/setup.ts:204-216`, `:219-231`, `:234-241` (each ends `return res.json() as Promise<T>` regardless of `res.status`)
- **Problem:** When a route returns 403/404/422, these helpers still parse the error body and type it as `DrivePath`/`{ success: boolean }`. A `beforeAll` step like `const folder = await drivePost(...)` that actually errored yields `folder.id === undefined`, and every downstream test then fails with a misleading "expected undefined to be a string" that hides the real cause. This is the same root cause as the `driveGet` finding (helpers hiding status), but for the write helpers the symptom is cryptic *failure* rather than false *pass*. The repo already has the correct shape in `assertJson` (`setup.ts:159-162`).
- **Proposal:** Add a status guard to the three helpers — `if (!res.ok) throw new Error(\`drive request failed: ${res.status} ${await res.text()}\`)` before `res.json()`, matching `assertJson` and the local `saveVersion`/`restoreVersion` helpers in `versioning.test.ts:124,140`. All current callers expect success, so this is backward-compatible and turns silent corruption into an actionable failure message.

### WebDAV Destination path traversal and cross-owner MOVE are not regression-tested end-to-end

- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** medium
- **Where:** `apps/api/src/test/webdav/move-copy.test.ts` (no `..`-in-Destination or cross-owner case); guard at `apps/api/src/lib/mount/mount.ts:255` (`resolvePath` rejects `..`/`.` segments); header decoding via `apps/api/src/lib/webdav/webdav-router.ts:23-26`
- **Problem:** The MOVE/COPY suite covers "Destination outside `/webdav` → 400" (`move-copy.test.ts:78-84`) but never sends a Destination *inside* `/webdav` whose decoded path escapes the mount (e.g. `.../mount1/../../bob/mount2/file.txt` or a `%2E%2E` segment), nor a Destination pointing at a different owner's mount. The `resolvePath` `..` guard exists and is unit-tested, but there is no HTTP-level test confirming the decoded-header → `resolvePath` chain holds together, so a future refactor that decodes the Destination differently could open a traversal without failing any test.
- **Proposal:** Add two tests in `move-copy.test.ts`: (1) a MOVE whose Destination contains a `..` segment resolving outside the mount, asserting a 400/403 (not 201/204); (2) a MOVE whose Destination targets another owner's mount URL, asserting 403. These lock the full header→decode→guard path that the unit test in isolation cannot.
## Accessibility

Biome's a11y rules are deliberately off in this repo, so none of these are linter-duplicates. All 10 raw findings verified as real and reachable against the current tree; they collapse into 6 issues, all driven by one root cause — interactive shadcn/Lucide controls and clickable `div`s that ship without an accessible name or keyboard path. Every fix is a small, flat attribute change (an `aria-label`, a `<button>` instead of a `div`, an `aria-hidden` on decoration), squarely aligned with "flat, direct, simple"; none introduce abstraction.

### Icon-only controls have no accessible name

- **Impact:** high · **Effort:** small · **Confidence:** high
- **Where:** `packages/ui/src/components/layout/app/topbar.tsx:91-99` (AppSwitcher `Grip`, rendered twice — desktop L274 and mobile L288); `packages/ui/src/components/layout/app/notification-bell.tsx:93-101` (`Bell` button) + `packages/ui/src/components/layout/count-badge.tsx:4` (badge); `packages/ui/src/components/layout/toolbar/document-share-cluster.tsx:24-32` (Comments button + its `CountBadge`); `packages/ui/src/components/layout/properties-panel/alignment-picker.tsx:12-20` (3 `Toggle`s); `packages/ui/src/components/layout/editor/light-editor-toolbar.tsx:13-27` (`ToolbarButton`) + its link `<input>` at L96-107
- **Problem:** These `Button`/`Toggle` controls render only a Lucide SVG child. Lucide marks its SVGs `aria-hidden` by default, so the button has no accessible name and a screen reader announces an empty button. A `title` attribute (LightEditorToolbar) and a Radix tooltip (Comments `TooltipButton`) are not reliable accessible names — `title` is widely ignored by screen readers, and the tooltip text is not wired to `aria-labelledby`. The sibling burger button (`topbar.tsx:271`) already does this right with `<span className="sr-only">Open menu</span>`, and the `TooltipToggle` primitive already sets `aria-label={ariaLabel || tooltipText}` (`tooltip-toggle.tsx:33`) — these controls just bypass the established pattern. The `CountBadge` overlay has `pointer-events-none` but no `aria-hidden`, so its bare number ("3") is announced as a separate, contextless node.
- **Proposal:** Add an `aria-label` to each icon-only control: `aria-label="Switch app"` on the AppSwitcher `Button`; a count-aware `aria-label={count > 0 ? \`Notifications, ${count} unread\` : 'Notifications'}` on the bell; `aria-label="Comments"` on the Comments `TooltipButton`; `aria-label="Align left|center|right"` on the three `Toggle`s; swap `title` → `aria-label` on `ToolbarButton` and add `aria-label="Link URL"` to the link `<input>`. Mark `CountBadge` `aria-hidden` since its value is now part of the button's label. (No new component needed — `TooltipButton` already accepts a `label`; this is attribute-only.)

### Interactive `div`s used as buttons (no keyboard path)

- **Impact:** high · **Effort:** small · **Confidence:** high
- **Where:** `packages/ui/src/components/layout/app/notification-bell.tsx:37-44` (notification row `<div onClick>`) and its dismiss `Button` at L64-74; `packages/ui/src/components/layout/home/usage.tsx:36` (`StorageUsage` expander `<div onClick>`)
- **Problem:** Both are primary controls built as a plain `<div onClick>` with no `role`, no `tabIndex`, and no `onKeyDown` — unreachable by Tab and unactivatable by keyboard or screen-reader users. The notification row is the panel's main navigation action; `StorageUsage` ships in every `AppSidebar`. Compounding it, the row's dismiss `Button` (the only destructive action) is hidden with `opacity-0 group-hover/item:opacity-100` and has no `focus-visible` style — keyboard users cannot hover, so it never surfaces. The `Button` primitive already provides a `focus-visible` ring, so only the visibility toggle is wrong.
- **Proposal:** Replace each outer `<div onClick>` with `<button type="button">` (the row's mixed children are fine inside a button; if layout fights it, use `role="button" tabIndex={0}` + an Enter/Space `onKeyDown`). For `StorageUsage` add `aria-expanded={showDetails}`. For the dismiss button, add `focus-visible:opacity-100` alongside the existing hover class so it appears on keyboard focus.

### CommandPalette dialog has no accessible name

- **Impact:** medium · **Effort:** small · **Confidence:** high
- **Where:** `packages/ui/src/components/layout/app/command-palette/command-palette.tsx:114-150`
- **Problem:** The palette renders `Dialog` + `DialogContent` directly with no `DialogTitle`/`DialogDescription`, so Radix produces a nameless `role="dialog"` (and logs a dev warning). The visible navigation hints in `CommandFooter` (`↑↓`, `↵`, `esc`) are presentational text only and are not exposed as instructions. Note: the raw finding suggested switching to the `CommandDialog` wrapper in `command.tsx` "which has it right" — verified false: that wrapper places its sr-only `DialogHeader` *outside* `DialogContent` (`command.tsx:35-39`), so Radix never wires it to `aria-labelledby`. Use the direct fix, not that wrapper.
- **Proposal:** Inside `DialogContent`, add an `sr-only` `DialogHeader` with `<DialogTitle>` ("Search and jump anywhere") and `<DialogDescription>` ("Type to search. Arrow keys to navigate, Enter to open, Escape to close."). This names the dialog and makes the keyboard instructions available to assistive tech, so the footer arrows become redundant reinforcement rather than the only source.

### Mobile sidebar overlay is not modal or keyboard-dismissible

- **Impact:** medium · **Effort:** medium · **Confidence:** high
- **Where:** `packages/ui/src/components/layout/sidebar/sidebar-container.tsx:30-46`
- **Problem:** On mobile the sidebar opens as a `fixed inset-0 z-50` panel with a `z-40` backdrop, but the panel has no `role="dialog"`/`aria-modal`/`aria-label` and the backdrop closes only on `onClick`. There is no Escape handler, so keyboard users cannot dismiss it, and without `aria-modal` a screen reader's virtual cursor can wander into the content behind it.
- **Proposal:** Mark the open panel `role="dialog" aria-modal="true" aria-label="Navigation menu"`. Add a `useEffect` that registers a `keydown` listener calling `setSidebarOpen(false)` on Escape while `isMobile && sidebarOpen` (the same shape Radix dialogs use). Add `aria-hidden` to the purely-visual backdrop; it keeps its `onClick`.

### Colour swatches convey selection by colour alone

- **Impact:** medium · **Effort:** medium · **Confidence:** high
- **Where:** `packages/ui/src/components/layout/media/color-picker.tsx:61-86`; `packages/ui/src/components/layout/notes/color-swatch-row.tsx:9-28`
- **Problem:** Both render grids of swatch `<button>`s carrying only a `title` and a colour `style`; selection is shown with a `ring-2` outline or a tiny `Check` icon and no `aria-pressed`/`aria-checked`, so a screen reader announces every swatch identically and never says which is selected. `ColorPicker`'s default grid is 14 × 9 ≈ 126 buttons (it varies with the `colors` prop), every one a separate Tab stop — a real operability burden even for sighted keyboard users.
- **Proposal:** Give each swatch `aria-label={color.label}` (reliable where `title` is not) and `aria-pressed={isSelected}` (or wrap the grid `role="radiogroup" aria-label="Color"` with `role="radio" aria-checked` per swatch). For `ColorPicker`, add roving-`tabIndex` arrow-key navigation so only the selected swatch is tabbable — this removes the ~126-Tab-stop penalty. `ColorSwatchRow` is a single row: the `aria-pressed` change alone is enough.

### SidebarItem colour dot has no text alternative when condensed

- **Impact:** low · **Effort:** small · **Confidence:** high
- **Where:** `packages/ui/src/components/layout/sidebar/sidebar-item.tsx:42-49`; consumer `packages/ui/src/components/layout/labels/label-manager.tsx:81-88`
- **Problem:** In the full sidebar the visible label text carries the meaning, so the `colorDot` is fine. In `condensed` mode the label text is suppressed (`{!condensed && label && …}`, L46) and the `icon` passed by `LabelManager` is an empty fragment `<></>` (label-manager.tsx:84) — leaving the colour dot as the *only* differentiator, with no `title`/`aria-label`/`sr-only` text. Every collapsed label row is announced identically.
- **Proposal:** When `condensed && label`, still emit `<span className="sr-only">{label}</span>` inside `content` (it costs nothing visually). A single-line change in `sidebar-item.tsx` fixes it for all consumers.
## Discoverability & documentation accuracy

Verification confirmed the dominant problem in this dimension is **docs and barrels that point at the wrong place** — dead links to docs that were never written, a config type that documents half its fields, and shared primitives that AGENTS.md advertises but that aren't reachable from the barrel a developer (or an LLM following "search before you build") would actually import. These directly defeat the project's own Tier-5 discoverability strategy in `docs/CODE-STANDARDS-ENFORCEMENT.md`, where "make the right answer the easy answer" is the stated fix for AI-driven re-derivation. Every kept item is a concrete pointer/barrel fix, not new abstraction. Two raw findings were dropped as speculative surface-building.

### SERVER-SETTINGS.md documents only half of the `ServerSettings` type
- **Impact:** high  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `docs/SERVER-SETTINGS.md:27-38` vs source of truth `packages/lib/src/types/settings.ts:46-86`
- **Problem:** The `## ServerSettings Type` block lists three quota fields and a bare `defaults.mount.storageType`. The real type adds `quotas.trashRetentionDays`, `defaults.mount.s3Config`, and three entire top-level sections — `onboarding` (waitlist, autoAddOwnerContact, welcomeMail, inviteEmail), `guests` (openSignup, inactivityDays), and `notifications.email` (guestOnAclAdd, userOnAclAdd, userOnCalendarInvite, ownerOnAccessRequest). The documented `storageType` union (`'local-id' | 'local-fullnames' | 's3'`) is also a stale literal — the source uses `ServerStorageType`. An LLM building an admin settings form or a settings migration from this doc silently omits more than half the configurable surface.
- **Proposal:** Replace the type block in `docs/SERVER-SETTINGS.md` with the verbatim shape from `packages/lib/src/types/settings.ts:46-86` (or, better, drop the inlined copy and point the reader at that file as the single source so it can't drift again).

### WEBDAV.md links to three docs that don't exist
- **Impact:** high  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `docs/WEBDAV.md:140`, `:141`, `:150`, `:155`, `:167`, `:168` — referencing `docs/WEBDAV-MOUNTAIN-DUCK.md`, `docs/WEBDAV-RCLONE.md`, `docs/TODO-WEBDAV.md` (none present in `docs/`)
- **Problem:** Five dead links. The Clients table sends macOS/Windows setup to two missing client recipes; the Limits section twice defers the known chunked-PUT and rate-limit gaps to a non-existent `TODO-WEBDAV.md`; the See-also section lists all three as if canonical. `TODO-WEBDAV.md` is treated as authoritative elsewhere (project memory calls it the "canonical follow-up list") yet was never written — so the documented limitations and follow-ups are unreachable. Anyone extending WebDAV follows the links into nothing and misses the limitation list entirely.
- **Proposal:** Either create the three stubs with real content (Mountain Duck/rclone client recipes; a TODO list capturing the chunked-PUT-without-Content-Length and 300-req/min gaps already named inline), or strip the links and inline the one-line essentials at each site. At minimum remove the dead links so agents stop trying to open them.

### Five shared type files are absent from the `@workspace/lib/types` barrel
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `packages/lib/src/types/index.ts` omits `./background`, `./command-palette`, `./comments`, `./drive-reference`, `./versioning` (the files exist and export `BackgroundFill`, `PaletteResult`/`Command`/`CommandContext`/`Sections`, `CommentCard`/`ActiveComments`, `AttachmentReference`, `Snapshot`)
- **Problem:** CODE-STANDARDS documents `@workspace/lib/types` as the one-stop shared-types import, but the barrel re-exports the other ~20 domains and silently skips these five. Every one of the ~40 current consumers (`apps/*`, `packages/ui`, `apps/api`) is forced onto the `@workspace/lib/types/<file>` deep path. That works, but a developer or LLM grepping the barrel for "where does `CommentCard`/`Snapshot`/`PaletteResult` live" finds nothing and may redefine the type — the exact re-derivation vector the standards warn against.
- **Proposal:** Add `export * from './background'; export * from './command-palette'; export * from './comments'; export * from './drive-reference'; export * from './versioning';` to `packages/lib/src/types/index.ts`, then run `bun run typecheck` to confirm no name collisions with the existing exports. Deep-path imports can stay; the point is to make the barrel complete.

### LAYOUT.md mis-describes SSEProvider as the toast source
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `docs/LAYOUT.md:147` (Providers table) vs `packages/ui/src/components/layout/sse-provider/sse-provider.tsx` and the contradicting `docs/NOTIFICATIONS.md:75`
- **Problem:** The Providers table describes `SSEProvider` as "SSE events → toast notifications". The component is a 9-line wrapper that calls `useSSE()` and renders `children` — it produces no toasts. NOTIFICATIONS.md states the opposite for the same file ("just calls `useSSE()`, no toasts"); toasts come from `packages/lib/src/core/notification/sse-handlers.ts`. The inaccurate description trains an LLM to add toast logic to `SSEProvider` instead of the notification domain handler where it belongs — and the two docs already disagree.
- **Proposal:** Change the LAYOUT.md:147 description to something accurate, e.g. "Mounts `useSSE()`; routes domain events to cache-invalidation handlers (toasts are emitted by `notification/sse-handlers.ts`)."

### `SearchBar` is advertised in AGENTS.md but not surfaced by any parent barrel
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `packages/ui/src/components/layout/search-bar/search-bar.tsx` (component); `packages/ui/src/components/layout/index.ts` and `packages/ui/src/index.ts` (both omit it); consumers all deep-path: `apps/mail/src/components/mail/email-list.tsx:5`, `apps/contacts/src/components/contacts/contacts-list.tsx:17`, `apps/admin/src/components/admin/members-list.tsx:6`, `apps/admin/src/components/admin/admin-user-list.tsx:7`, `apps/admin/src/routes/_auth.waitlist.tsx:15`
- **Problem:** AGENTS.md's *Key UI Components* table lists `SearchBar` as a shared component to reach for before building custom UI, and a `search-bar/index.ts` re-exporting it already exists — but neither `@workspace/ui` (root `index.ts`) nor `@workspace/ui/components/layout` (`layout/index.ts`) re-exports the `search-bar/` folder, and `package.json` has no `./components/layout/search-bar` entry. So the one path that surfaces it is the private `@workspace/ui/components/layout/search-bar/search-bar`, which all five consumers use. A new app browsing the documented barrels won't see it and will re-implement a search input.
- **Proposal:** Add `export * from './search-bar';` to `packages/ui/src/components/layout/index.ts` (and to `packages/ui/src/index.ts` so `@workspace/ui` surfaces it directly). The folder's `index.ts` already exists; no new barrel is being introduced, just completed.

### `DriveLayout` and `DriveAccessDialog` missing from the drive barrel despite cross-app use
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `packages/ui/src/components/layout/drive/index.ts` (lists 17 siblings, omits these two); deep-path consumers: `DriveAccessDialog` in `apps/{sheets,stickies,chat,docs,slides,drive}` route files, `DriveLayout` in `apps/drive/src/routes/_auth.{shared.$to,fs…,mime…}.tsx`
- **Problem:** The barrel exports less-used internals (`drive-table`, `drive-mount-list`) but skips the two most widely consumed entries — `DriveAccessDialog` (7 routes across 6 apps) and `DriveLayout` (3 drive routes). Every consumer hard-codes the deep path. A developer adding a new EigenDoc app greps existing apps for the deep path instead of reading `drive/index.ts`, perpetuating the deep-path habit.
- **Proposal:** Add `export * from './drive-layout';` and `export * from './drive-access-dialog';` to `packages/ui/src/components/layout/drive/index.ts` (the file already exports the rest of the folder). Optionally migrate the route imports to `@workspace/ui/components/layout/drive`.

### Three mobile-detection patterns collide on the name `isMobile`
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `packages/lib/src/core/media/hooks/use-media-query.ts:20` (`useIsMobile` = 768px) vs raw `useMediaQuery('(max-width: 1200px)')` assigned to `isMobile` in `apps/stickies/src/components/stickies/toolbar.tsx:44`, `apps/docs/src/components/docs/editor-toolbar.tsx:111`, `apps/slides/src/components/slides/toolbar.tsx:44` (and `isWide` at `apps/docs/src/components/docs/editor.tsx:638`); plus `useLayout().isMobile` from `layout-context`
- **Problem:** `isMobile` means 768px when it comes from `useIsMobile()`/`useLayout()`, but the four editor-panel toolbars compute it inline at a different 1200px breakpoint and reuse the same variable name. The identical name carrying two thresholds is a silent trap: an LLM picks one hook at random and may apply the wrong breakpoint. There is no named primitive for the 1200px editor-panel threshold, so it gets re-typed by hand each time.
- **Proposal:** Add `useIsNarrow()` returning `useMediaQuery('(max-width: 1200px)')` next to the existing `useIsMobile/useIsTablet/useIsDesktop` in `use-media-query.ts` (same file, same pattern — no new abstraction), export it from `@workspace/lib/media`, and replace the four inline calls. One line in AGENTS.md clarifying "`useIsMobile()` = 768px system breakpoint, `useIsNarrow()` = 1200px editor-panel breakpoint, `useLayout().isMobile` = context-aware value inside AppShell" closes the ambiguity.

### `useSearch` (global mail/file search) collides by name with TanStack Router's `useSearch`
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `packages/lib/src/core/search/hooks/use-search.ts:20` and the export at `packages/lib/src/core/search/index.ts:2`; router's `useSearch` is already imported in `packages/ui/src/components/layout/pages/login-route.tsx:1`; current consumers are only `packages/lib/src/core/command-palette/providers/{file-search,mail-search}.ts`
- **Problem:** `@workspace/lib/search` exports a data-fetching hook named `useSearch`; TanStack Router exports a `useSearch` for reading URL query params, used pervasively as `Route.useSearch()`/`useSearch({ strict: false })`. The project hook is currently consumed only by the two command-palette providers, so the collision is latent — but the name is a trap for any new route component that also wants global search, and it breaks the project's own grep-ability convention (domain-scoped hook names like `useComments`, `useContactSuggestions`).
- **Proposal:** Rename to `useGlobalSearch` (or `useMailSearch`) in `use-search.ts`, update the `search/index.ts` export and the two provider callers. Mechanical, no external callers outside `packages/lib`.

### Deep-path imports bypass the public barrels for `AppError`, `useLayout`, and `useApp`
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `AppError` from the private `@workspace/lib/core/api-error` in `apps/admin/src/components/admin/setup-wizard.tsx:2` and `apps/drive/src/routes/_auth.fs.$ownerId.$mountId.$pathId.tsx:5` (public path is `@workspace/lib/api-error`); `useLayout`/`useApp` from `@workspace/ui/components/layout/app/layout-context[.tsx]` in `apps/admin/src/routes/_auth.tsx:6`, `apps/slides/src/components/slides/editor.tsx:23`, `apps/index/src/routes/{blog.$id,support.$section.$article}.tsx`, `apps/space/src/components/space/login-fa2.tsx:17`, `apps/drive/src/{components/editor/native-file-editor.tsx:8, routes/_auth.shared.$to.tsx, routes/_auth.fs…, routes/_auth.mime…}` (public path is `@workspace/ui/components/layout/app`; several even hard-code the `.tsx` extension)
- **Problem:** Both symbols have stable public barrel entries, yet a handful of app files import the private module path (one variant pins the `.tsx` extension). If `api-error.ts` or `layout-context.tsx` is reorganized, the barrel path stays valid while these break — and they model the deep-path habit for the next file. Note: imports of `./layout-context` *within* `packages/ui/.../app/` are correct relative siblings and are not in scope; only cross-package app imports are.
- **Proposal:** Repoint those app files to `@workspace/lib/api-error` and `@workspace/ui/components/layout/app` respectively. Pure import rewrites, no logic change. (The `AppError`-vs-backend-`ApiError` naming asymmetry was considered and left alone: renaming a class used across dozens of hook files for a theoretical confusion risk is high-churn, and "is this name confusing?" is a judgment call the enforcement doc explicitly says not to police.)

### Stale single-line doc references (COMMENTS, DEPLOYMENT, STORAGE, GuestHome)
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `docs/CHAT.md:190` and `docs/DATABASE.md:109` link to non-existent `COMMENTS_IN_DOCS.md` (correct file is `docs/COMMENTS.md`); `docs/IMAP.md:201` links to non-existent `docs/DEPLOYMENT.md` for the Docker architecture; `docs/STORAGE.md` StorageBackend table omits the `readRange?` method that exists in `apps/api/src/lib/storage/types.ts:10`; `AGENTS.md:100` lists Home subclasses as "UserHome, TeamHome, OrgHome" but `apps/api/src/lib/home/guest-home.ts:9` defines a fourth, `GuestHome` (Drive + NotificationCenter, `data/guest/{guestId}/`)
- **Problem:** Four small, individually trivial accuracy gaps that each send a reader to a dead end: two dead `COMMENTS_IN_DOCS.md` links (the real comment-index doc exists, just renamed), one dead `DEPLOYMENT.md` link that is the only pointer to how Dovecot/checkpassword/the API container wire together, a `StorageBackend` table that would lead a new backend implementor to skip the Range method WebDAV depends on, and a Home subclass list that hides `GuestHome` from anyone extending the Home system.
- **Proposal:** Fix in place: retarget the two `COMMENTS_IN_DOCS.md` links to `COMMENTS.md`; either create `DEPLOYMENT.md` or inline the Docker context into IMAP.md's Dovecot section and drop the link; add a `readRange? | StorageFile | Byte-range slice (end exclusive); used by WebDAV Range requests` row to the STORAGE.md table; append `GuestHome` to the AGENTS.md:100 subclass list.

### Comment query-key/invalidation primitives aren't reachable from `@workspace/lib/comments`
- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `commentKeys` and `invalidateComments` are defined in `packages/lib/src/core/chat/hooks/use-comments.ts:5` (re-exported via `@workspace/lib/chat`), while the card-layer API (`useCommentCards`, `useCommentLifecycle`, …) lives in `packages/lib/src/core/comments/` and `packages/lib/src/core/comments/index.ts` re-exports only `./hooks`
- **Problem:** A developer writing an SSE handler or mutation that must invalidate comment data naturally greps `@workspace/lib/comments`, which exposes the card API but not the backing query-key factory or message-level invalidation — those are visible only from `@workspace/lib/chat`. The split is technically correct (comments are backed by chat messages), but it hides the boundary from the consumer and leaves the comments primitive catalog incomplete.
- **Proposal:** Re-export `commentKeys` and `invalidateComments` from `packages/lib/src/core/comments/index.ts` (pointing at the existing chat-domain definitions; keep the implementation where it is). Add a one-line comment in `chat/hooks/use-comments.ts` noting that comments are chat-message-backed so the layering is clear.
## Resource lifecycle & configuration

Verification confirmed one genuinely high-leverage correctness class — Yjs collab hooks tear down their `Y.Doc` but leak the `UndoManager`, observers, and (for sheets) the WebSocket provider, with the correct pattern already living in-repo. The remaining survivors are a trivial React timer-cleanup fix and a small, broken-windows-on-touch consolidation of duplicated time-interval literals. The "scattered `process.env`" finding was dropped: its one concrete fix would break an existing test, and the rest is discoverability ceremony the project's own standards reject.

### Yjs collab hooks leak UndoManager, observers, and the WS provider on teardown

- **Impact:** high  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/stickies/src/components/stickies/hooks/use-board.ts:113,162-164,179-183` · `apps/slides/src/components/slides/hooks/use-deck.ts:110,145-147,157-161` · `apps/sheets/src/components/sheets/hooks/use-sheet.ts:71,91,136-144`
- **Problem:** All three hooks create a `Y.UndoManager` (an `ObservableV2` with its own event emitters) and register `observeDeep`/`observe` callbacks, but the `useEffect` cleanup only calls `provider.disconnect()` + `doc.destroy()`. The UndoManager is never destroyed and the observers are never unregistered. Because the effect deps include `pathId`, switching between boards/decks/sheets re-runs the effect *without* an unmount — so the old UndoManager and its observer closures (which capture the React `setState` functions and `workbookRef`) survive and can fire against torn-down state until GC. Sheets is worst: it only calls `wsProvider.disconnect()` (not `.destroy()`), and its `opsArray.observe`/`stateMap.observe` callbacks are inline, so a WS message racing `doc.destroy()` runs an observer against a destroyed doc. The repo already does this correctly in two places, so these three are the outliers.
- **Proposal:** Mirror the existing correct patterns — `packages/lib/src/core/comments/hooks/use-comment-cards.ts:42` (`return () => map.unobserveDeep(refresh)`) and `apps/docs/src/components/docs/editor.tsx:124-127` (`yProvider.off(...)` + `yProvider.destroy()`). In each cleanup: hold the observer in a named const and call the matching `unobserveDeep`/`unobserve`, call `undoManager.current?.destroy(); undoManager.current = null`, and replace `wsProvider.disconnect()` with `wsProvider.destroy()` (which disconnects internally and removes the provider's own doc listeners) before `doc.destroy()`. No new abstraction — just complete the teardown the sibling hooks already model.

### Scattered/duplicated time-interval literals lack shared named constants

- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `resyncInterval: 5000` duplicated 4× — `apps/sheets/src/components/sheets/hooks/use-sheet.ts:66`, `apps/stickies/src/components/stickies/hooks/use-board.ts:117`, `apps/slides/src/components/slides/hooks/use-deck.ts:114`, `apps/docs/src/components/docs/editor.tsx:118`; SSE/WS keepalive `15000` duplicated in `apps/api/src/lib/home/home.ts:205` and `apps/api/src/utils/websockets.ts:24`; unnamed `5000` debounce in `packages/lib/src/core/home/hooks/use-home.ts:38-41`; SSE backoff inline `1000`/`30000` in `packages/lib/src/core/sse/hooks/use-sse.ts:42,72`; and two-form staleTime divergence (`1000 * 60 * 5` 12× vs `5 * 60 * 1000` 12×; `1000 * 60 * 2` 4× vs `2 * 60 * 1000` 5×) across `packages/lib/src/core/drive/hooks/use-drive.ts`, `.../admin/hooks/`, `.../chat/hooks/`.
- **Problem:** The same logical duration is written several ways with no shared constant, so a coupled value (the 4× collab resync; the two keepalive intervals that must stay in lockstep) can silently diverge. The project already establishes this exact pattern — `AUTO_SAVE_DEBOUNCE_MS`, `SNAPSHOT_INTERVAL`, `SNAPSHOT_BYTES`, `TOUCH_THROTTLE_MS` are all named — it's just applied unevenly.
- **Proposal:** Add the genuinely-coupled values as named constants and reference them: `COLLAB_WS_RESYNC_INTERVAL_MS = 5_000` in `packages/lib/src/constants/` (a new `collab.ts` re-exported from `index.ts`) used by all four collab hooks; `SSE_KEEPALIVE_INTERVAL_MS = 15_000` used by both `home.ts` and `websockets.ts`. Name the local one-offs in place (`use-home.ts` debounce, `use-sse.ts` retry initial/max). For the staleTime forms, do **not** run a mechanical sweep — normalize on touch per the broken-windows rule (per `docs/CODE-STANDARDS-ENFORCEMENT.md` "What NOT to enforce" and memory entry `feedback_subagent_mechanical_sweeps`); the only structural win is picking one form. Leave the truly local backend timeouts (thumbnail worker `30_000`, S3 health-check `5000`, Home idle `5 * 60 * 1000`) as local named constants — they need no cross-file sharing.

### TimeSelect scroll effect schedules a setTimeout with no cleanup

- **Impact:** low  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/calendar/src/components/time-select.tsx:95-118`
- **Problem:** The effect that scrolls the selected slot into view does `setTimeout(() => { ... }, 100)` but returns no cleanup. In keyboard-driven flows the dropdown can close before the 100 ms elapses, so the closure runs after the component has re-rendered/unmounted; with deps `[open, value]` each re-open schedules another orphaned timer. The `listRef.current` null-guard prevents a crash but does not stop the timer accumulating.
- **Proposal:** Standard React timer cleanup — `const timer = setTimeout(() => { ... }, 100); return () => clearTimeout(timer);`. Any effect re-run (including unmount) then clears the prior timer before scheduling a new one.
## Protocol & standards conformance

Five reachable protocol bugs survived verification against the cited code: an iMIP replay/stale-update overwrite, an iCalendar serializer that emits `TZID` references with no `VTIMEZONE` (silently shifting every timed event in strict clients), a WebDAV `COPY Depth:1` that copies the whole subtree instead of rejecting it, malformed RFC 5322 address headers from unquoted display names, and a missing RFC 4918 lock-null path. Two raw findings were dropped — the CalDAV `calendar-data` "CDATA vs XML-escape" item (XML-escaping is already correct XML; the claimed client breakage is speculative) and the IMAP `\Inbox` flag (non-standard, but there is no live IMAP-LIST wire surface emitting it today — it is internal-only).

### iMIP REQUEST applied without a SEQUENCE guard (stale/replay overwrites live events)
- **Impact:** high  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/calendar/calendar.ts:1132-1187` (`receiveInvitationUpdate`), dispatched from `apps/api/src/lib/calendar/imip.ts:169-188`
- **Problem:** `receiveInvitationUpdate()` loads the `linked` event and then unconditionally `UPDATE`s title/time/location/status/`sequence` from the inbound iTIP REQUEST. It never compares `payload.sequence` against `linked.sequence`. RFC 5546 §3.2.2.1 requires a REQUEST whose SEQUENCE is `<=` the stored value to be ignored as stale or a replay. The inbound `sequence` is fully parsed (`ical-parse.ts:84`) and the stored row already carries `sequence`, so the data for the check is present — it is simply not consulted. A reordered, duplicated, or replayed REQUEST from an external calendar system reverts the attendee's live copy to an older revision.
- **Proposal:** Add a one-line early return at the top of `receiveInvitationUpdate()` after the `linked` lookup: `if (payload.sequence <= linked.sequence) return;`. No new abstraction — a direct guard alongside the existing `if (!linked) return;`.

### iCalendar emits DTSTART;TZID / RECURRENCE-ID;TZID with no VTIMEZONE component
- **Impact:** high  ·  **Effort:** medium  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/caldav/ical-serialize.ts:98-100` (`DTSTART`/`DTEND`), `:128` (`RECURRENCE-ID`), wrapped by `wrapInVCalendar` at `:168-173`
- **Problem:** When `event.timezone` is set the serializer writes `DTSTART;TZID=America/New_York:...` etc., but `wrapInVCalendar()` builds a `VCALENDAR` whose body contains only `VEVENT`s — no `VTIMEZONE`. RFC 5545 §3.6.5 requires every `TZID` referenced in a property parameter to be defined by an inline `VTIMEZONE` (or a server-published one). Strictly-conformant clients (Thunderbird, Apple Calendar) treat an undefined `TZID` as unknown and fall back to UTC, silently shifting every timed event by the zone offset on export and on outbound iMIP. `ical.js` (`^2.2.1`) is already a dependency and ships the IANA timezone database, so the `VTIMEZONE` text can be produced without a new dep.
- **Proposal:** In `wrapInVCalendar()`, collect the unique non-null `TZID`s present in the event lines, render one `BEGIN:VTIMEZONE…END:VTIMEZONE` block per zone via `ICAL.TimezoneService`/`ICAL.Timezone`, and inject them before the first `VEVENT`. While in this file, fix the adjacent broken window: the four `VALARM` structural lines (`ical-serialize.ts:157-161`) use raw `lines.push()` and bypass the `prop()`/`foldLine` helper every other property uses — route them through `prop()` so a future longer value can't violate the 75-octet fold rule.

### WebDAV COPY Depth:1 on a collection copies the full subtree instead of returning 400
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** high
- **Where:** `apps/api/src/lib/webdav/move-copy.ts:155-161` (`handleCopy`), fed by `parseDepth` in `apps/api/src/lib/webdav/webdav-router.ts:13-17`
- **Problem:** `parseDepth()` maps the header `"1"` to the literal `'1'` and passes it through, but `handleCopy()` only special-cases `depth === '0'`; any other value (including `'1'`) falls through to `drive.copyPath()`, which copies the entire subtree. RFC 4918 §9.8.3 lists `0` and `infinity` as the only valid Depth values for a collection COPY — `Depth:1` MUST be rejected with `400 Bad Request`. Litmus sends `Depth:1` on COPY expecting the 400; treating it as infinity is wrong, and is a plausible contributor to the documented 101/105 litmus baseline (`docs/WEBDAV.md:7`).
- **Proposal:** Before the existing `depth === '0'` branch in `handleCopy()`, add: `if (args.depth === '1' && src.type !== 'file') return new Response(null, { status: 400 });`. One guard, consistent with the existing depth branching.

### MIME address headers built from unquoted display names (RFC 5322 §3.2.3)
- **Impact:** medium  ·  **Effort:** small  ·  **Confidence:** medium
- **Where:** `apps/api/src/lib/mail/mailfile.ts:24-32` (`formatAddresses`), consumed at `:35-39`
- **Problem:** `formatAddresses()` concatenates `addr.name` straight into `` `${name} <${address}>` `` with no RFC 5322 phrase quoting and no RFC 2047 encoding, then hands the finished *string* to `MailComposer`. Given a structured `{ name, address }` object MailComposer would encode the phrase itself, but a pre-formatted string is taken as already-final, so the encoding step is bypassed. A display name containing a comma, parentheses, angle brackets, semicolon, or backslash produces a malformed header — e.g. `Doe, John <j@example.com>` parses as two recipients, and non-ASCII names ship raw.
- **Proposal:** Delete `formatAddresses()` and pass structured address objects to `MailComposer` (`from: input.from ? { name: ..., address: ... } : undefined`, same for `to`/`cc`/`bcc`), letting nodemailer do the RFC 2047/quoting. This is *flatter* than the helper — it removes a single-use function and relies on the library at its proper seam.

### WebDAV LOCK on a non-existent path returns 404 (no lock-null / locked-empty resource)
- **Impact:** low  ·  **Effort:** large  ·  **Confidence:** medium
- **Where:** `apps/api/src/lib/webdav/locks.ts:73-74` (`handleLock`)
- **Problem:** `handleLock()` throws `ApiError(404)` the moment `resolvePath()` returns null. RFC 4918 §7.3 allows LOCK on a not-yet-existent resource (creating a lock-null / "locked empty" resource the client then PUTs into); some clients LOCK-before-PUT on a new path. This is a genuine spec gap and a candidate among the four remaining litmus failures (`docs/WEBDAV.md:7`). Ranked low: Eigen's blessed clients (Windows Explorer, Word/Excel, Mountain Duck, rclone) are all verified working without it, and the conforming fix is heavy — a placeholder DB row that must be excluded from PROPFIND Depth:1 and GET, then replaced on PUT — which cuts against the deliberately lean in-memory lock design documented for this layer.
- **Proposal:** Only pursue if a target client is shown to require it. If so, the minimal shape that fits the existing model: on null `resolvePath`, verify the parent exists (`409` otherwise), acquire a lock keyed on a synthetic pathId derived from the path string, and return `201` with `Lock-Token` + a `lockdiscovery` body — without persisting a visible placeholder (keep null-resource locks in the in-memory `LockManager`, consumed by the subsequent PUT), so PROPFIND/GET need no exclusion logic.
