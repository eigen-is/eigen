# Frontend Code Quality Review

**Date:** 2026-08-12 (consolidation of two independent reviews, 2026-08-07 and 2026-08-12)
**Scope:** `apps/*/src`, `packages/ui`, the frontend-facing parts of `packages/lib`, and the
[SHARED-PRIMITIVES.md](SHARED-PRIMITIVES.md) index. `apps/api` followed only where a frontend contract needed it.

> **TLDR**: The data layer is in excellent shape — zero `useQuery`/`useMutation` in app components, every lib
> mutation routes errors through `onMutationError`, zero `as any` in frontend apps. The real debt is
> **duplication and export-surface hygiene**: per-app scaffolds pasted 11× with drift (`main.tsx`, `_auth.tsx`),
> copy-paste clusters inside apps (calendar event dialogs ~180 lines, drive list routes ×4, person lists ×4),
> dead files and duplicate component pairs in `packages/ui`, and an import surface where the same component is
> reached three or four different ways because the `exports` maps are decorative. Four user-facing failure
> contracts (§1) and a short list of small verified bugs (§2) should go first.

**Method.** The two source reviews were written blind to each other. This document keeps only findings that were
re-verified against the code on 2026-08-12 (`main` @ 9c11d364) — fresh greps, diffs, md5 hashes, and per-call-site
checks; both sides of every duplication claim opened, every dead-code claim grepped across all workspaces
(including `apps/api` and `packages/sheet`) under every specifier variant. Where the reviews conflicted, the code
decided; claims that did not survive are recorded in §10. Line numbers are as of the verification commit — treat
them as hints, they rot.

## Priorities

| # | Fix | Why first |
|---|-----|-----------|
| 1 | The four failure contracts: waitlist, first-run setup, upload errors, calendar invite (§1) | User-visible failures that today end in a locked form, a silently-entered admin app, doubled error paths, or nothing at all |
| 2 | The small verified bugs (§2) | Cheap and real: mail shortcuts dead after focus loss, wrong grouping + no keyboard in Admin lists, slides z-index in the portal tier, no 404 page anywhere |
| 3 | Calendar event dialogs + drive list routes (§4.1–4.2) | The two largest duplications; both are code that must stay behaviourally in sync and is maintained 2× and 4× |
| 4 | `main.tsx` / `_auth.tsx` factories + index-route policy (§3.1–3.3) | 22 pasted files expressing ~1 line of real difference each; the guest policy finally gets a name; `createLoginRouteOptions` already proves the pattern |
| 5 | One canonical import path per primitive + export-surface cleanup (§7) | The systemic finding — it is why drift keeps re-appearing and why the primitives index under- and over-reports |
| 6 | Split the god files: `use-drive.ts`, `DriveLayout`, `chat-message-list` (§5.5, §6.1) | All three have documented internal seams already |
| 7 | Delete the dead code (§5.1, §6.4) | Cheap; de-noises SHARED-PRIMITIVES.md |
| 8 | Consistency drift (§8) and the `layout/` restructure (§5.4) | Mechanical, low priority, fix on touch |

## 1. Failure contracts (P1)

### 1.1 A rejected waitlist request leaves the form permanently disabled

The one data-layer violation in all apps, and a real lock-up.
[apps/index/src/routes/index.tsx](../apps/index/src/routes/index.tsx) sets `isSubmitting` and then awaits a raw
`publicApi.waitlist.post` with toast feedback, with no `try/catch/finally` (lines ~53–76). A rejected network
request skips `resetForm()`, so `isSubmitting` stays `true` and every control (`disabled={isSubmitting}`, four
sites) is permanently disabled with no message. `packages/lib/src/core/public/hooks/use-public.ts` holds only
query hooks — there is no waitlist mutation.

**Fix**: add `useJoinWaitlist` to `core/public/` — check `response.error`, throw `AppError`, `onMutationError` for
failures, success toast in the hook; the component keeps only form visibility and uses the mutation's pending
state. At minimum, `try/finally` so a rejection re-enables the form. Test the rejected-request path.

### 1.2 First-run setup can fall through on errors and has two data paths

- [packages/lib/src/core/admin/hooks/use-setup-status.ts](../packages/lib/src/core/admin/hooks/use-setup-status.ts)
  returns `res.data` without checking `res.error` — an HTTP error caches as successful `undefined` — unlike its
  neighbor `use-admin-users.ts`, which throws `AppError`.
- [apps/admin/src/routes/__root.tsx](../apps/admin/src/routes/__root.tsx) handles only `setupLoading` and
  `setupStatus?.setupRequired`; there is no error branch, so absent data falls through to `<AdminApp />` — a
  failed status query silently enters the normal admin app.
- [apps/admin/src/components/admin/setup-wizard.tsx](../apps/admin/src/components/admin/setup-wizard.tsx) then
  bypasses the hook entirely: a second raw `setupApi.status.get()` in an effect, locally reconstructed
  loading/configured/error state, and a raw completion mutation with hand-rolled error conversion.
- Related: `adminKeys.setupStatus()` is `['setup-status']`, escaping the `['admin']` namespace, so invalidating
  `adminKeys.all` cannot reach it (§6.3).

**Fix**: make `useSetupStatus` throw on `response.error`; render a retryable `ErrorState` in `AdminRoot` and never
infer "configured" from absent data; add `useCompleteSetup`/`useCheckSetupS3` mutations; pass the already-fetched
status into `SetupWizard` (no second raw fetch); invalidate the status cache after completion. Test query failure,
completion failure, and the success transition.

### 1.3 Upload failures run the error path twice, and the avatar workflow is pasted twice

[packages/ui/src/components/layout/upload-provider/upload-with-progress.tsx](../packages/ui/src/components/layout/upload-provider/upload-with-progress.tsx)
invokes `onError(error)` **and** rejects the same promise, for both HTTP and network failures — two competing
error contracts. All three callers therefore run their error path twice (`onError` + `catch`): contacts
`contact-edit.tsx`, space `profile-editor.tsx`, and `packages/ui/.../drive/drive-upload-files.tsx`. The provider's
`error()` schedules a fresh 3s removal timer on every call, so one failed request creates duplicate timers.
Failures surface only as the generic "Upload failed" chip plus a `console.error` — no actionable message.

The contacts and space blocks are the same ~25-line avatar workflow pasted twice, and the space copy calls
`getContactsAvatarUploadUrl(user?.id || '')` — an empty-string fallback on a required id that builds a malformed
URL (the contacts copy guards with `if (!user) return`).

**Fix**: make the transport helper promise-only (resolve on success, reject once); migrate all three callers
together. Extract one `useUploadContactAvatar` workflow: `packages/lib` owns the request/mutation and
`onMutationError`; a UI adapter maps progress and the single rejection into `useUpload`. `lib` must not import
`ui`. Fix the empty-string id. Test HTTP and network failure: one error transition, one user-visible message.

### 1.4 The mail calendar widget owns fetching, parsing, and silent failure

[apps/mail/src/components/mail/calendar-invite-widget.tsx](../apps/mail/src/components/mail/calendar-invite-widget.tsx)
defines a second, regex-based iCalendar parser (`parseIcsField`/`parseIcs`/`icsDateToDate`), builds an
authenticated attachment URL, fetches it in an effect, and swallows every failure with `.catch(() => {})` —
malformed or unavailable invitations are indistinguishable from no invitation. The API's canonical parser is
`ical.js` ([apps/api/src/lib/caldav/ical-parse.ts](../apps/api/src/lib/caldav/ical-parse.ts)); the ad hoc grammar
handles neither full escaping nor parameters, date-only values, or timezone semantics.

**Fix**: expose typed calendar metadata from the mail parser/API (the server already parses the message). If the
fetch must stay lazy, add a `useCalendarInvite` query in `@workspace/lib/mail` with a stable key and explicit
error state, using a standards parser. Keep the widget presentational: loading/error/summary in, JSX out.

## 2. Small verified bugs

1. **Mail focus-reclaim regression.** `apps/mail/src/components/mail/email-list.tsx` reimplements the shared
   `useKeyboardListNavigation` (its comments admit it; the fork exists for virtualization + a parent-lifted
   cursor) but silently drops the shared hook's body-focus-reclaim block
   (`packages/ui/src/hooks/use-keyboard-list-navigation.ts:65-77`, `focusout` + `pageshow`), which was added for a
   real bug — so focus falling to `<body>` leaves mail shortcuts dead. Teach the shared hook a lifted-cursor
   option and delete the fork; at minimum port the reclaim block back.
2. **Signed-out Space loses its scroll container.** `apps/space/src/routes/__root.tsx`: the authed branch wraps
   `<Outlet/>` in `<div className="flex-1 overflow-auto">`; the signed-out branch returns a bare `<Outlet/>`.
   Fixed for free by §3.3.
3. **Admin person lists.** Both admin lists bucket with inline `name.charAt(0).toUpperCase()` instead of the
   shared `alphaGroupKey` (`packages/ui/src/components/layout/alphabetical-list.tsx` — NFD diacritic fold +
   `'#'` bucket), so "Émile" groups under "É" in Admin but "E" in Contacts. `admin-user-list.tsx` also has no
   keyboard navigation at all (no tabIndex, no onKeyDown). Route both through `alphaGroupKey` today; the full fix
   is §4.4.
4. **No app registers `defaultNotFoundComponent`** — a mistyped URL renders TanStack's default page in every app.
   Set it once in the §3.1 factory.
5. **Slides z-index.** `slide-canvas.tsx` puts canvas-internal overlays (rotation badge, snap lines, marquee,
   selection bounds) at `z-50`/`z-40` — the portal tier — on a `relative` container that establishes no stacking
   context, so they tie with every Radix dropdown and win/lose by DOM order. Per the CODE-STANDARDS table they
   belong ≤30 under `isolation: isolate`. And `editor.tsx`'s fullscreen present overlay sits at `z-50` where the
   documented full-screen tier is 100 — it renders below `FilePreview`.
6. **`getExtension('README')` → `'e'`.** `packages/lib/src/constants/preview.ts`:
   `fileName.slice(fileName.lastIndexOf('.'))` with an unguarded `-1` returns the last character for
   extensionless names. Harmless today (no registered extension is one character and results lack the leading
   dot), but a wrong primitive. Guard the `-1`.
7. **Non-null-assertion clusters.** `apps/drive/src/components/editor/native-file-editor.tsx` uses `data!` four
   times where the guard (`!data && !preview`) doesn't narrow `data`; practically safe because the Edit
   affordance is gated on `!!data`, but that invariant is invisible to TS — `if (!data) return <LoadingState/>`
   removes all four. Same idiom: `event.data!.attendees!` in `apps/calendar/src/components/event-detail-dialog.tsx`.
8. **Unneeded MouseEvent casts.** `apps/docs/src/components/docs/editor.tsx` casts a native MouseEvent
   `as unknown as React.MouseEvent` (2×) to call `useContextMenu.handleContextMenu` — but the hook already
   exposes `openAt(item, x, y)` taking raw coordinates. Use it; delete both casts.
9. **Index-route strays.** `apps/calendar/src/routes/index.tsx` carries an `as never` cast on redirect params —
   the only forbidden cast in app code; `apps/chat/src/routes/_auth.index.tsx` has a dead `!userId → redirect`
   inside a route already guarded by `_auth`. Both fold into §3.2.

## 3. Cross-app scaffolds: the same file pasted 11 times

### 3.1 `main.tsx` — 11 copies, one line of difference

`apps/{admin,calendar,chat,contacts,docs,drive,mail,sheets,slides,space,stickies}/src/main.tsx`, 39–41 lines each.
`diff apps/docs/src/main.tsx apps/sheets/src/main.tsx` is exactly one line (`basepath`). The 39-line variants
dropped three comments — paste drift, not intent. The Index app is genuinely different (SSR/hydration) and stays
outside the extraction.

**Fix**: a typed `createEigenAppRouter({ routeTree, basepath })` + `mountEigenApp(router)` in `packages/ui`, next
to `mountReactApp`. Each `main.tsx` keeps its local router constant and TanStack `Register` declaration for type
inference; shared code owns the provider and auth-context wiring — and registers `defaultNotFoundComponent`
(§2.4). Do not grow this into a generic framework; two helpers with the current fixed defaults are enough.

### 3.2 `_auth.tsx` — 11 copies, 4 shapes

md5 groups: chat = drive; docs = sheets = slides = stickies; calendar = contacts = mail = space; admin unique (its
org/admin gate is genuinely different). The `beforeLoad` redirect block is byte-identical in all ten non-admin
files. The four EigenDoc apps wrap `<Outlet/>` in a pointless named `AuthLayout` function the other six don't
have. The guest→drive bounce (calendar/contacts/mail/space) is an intentional policy — but it is encoded by
presence/absence across ten files with nothing naming the decision.

**Fix**: `createAuthRouteOptions({ redirectGuests?: boolean })` in `packages/ui`, mirroring
`createLoginRouteOptions`. Ten files become one line each and the guest policy gets a name. Keep every route file —
do not replace them with route generation. Fold in the index-route strays: delete chat's dead check (§2.9), move
calendar's and drive's index-route auth re-checks into their `_auth.tsx` (drive's index bounces guests to
`/shared/with-me` while its `_auth.tsx` has no guest branch — the policy lives in the wrong file), and fix the
`as never`.

### 3.3 `__root.tsx` — the "not signed in" branch, 6 copies + 1 one-liner

The identical ~7-line `if (!user) return <AppShell…><Outlet/></AppShell>` early return exists in
`apps/{calendar,contacts,mail,space,drive}/src/routes/__root.tsx` and
`packages/ui/src/components/layout/drive/eigendoc-root.tsx`. Chat solves it in one line:
`sidebar={user ? … : undefined}`. Real drift already exists — the Space scroll bug (§2.2).

**Fix**: adopt chat's shape everywhere, or hoist the `!user` branch into `AppShell`.

### 3.4 Settings-page route scaffold — 6 copies, 2 content widths

`apps/admin/src/routes/_auth.{settings,onboarding,guest-settings}.tsx` (20 lines each, identical modulo
title/component) and `apps/space/src/routes/_auth.{user,email,data}.tsx` (same plus a `max-w-3xl app-gutter`
wrapper). Admin instead pushes `max-w-2xl` into each page component (`server-settings.tsx`,
`onboarding-settings.tsx`, `guest-settings.tsx`) — so Admin and Space settings pages render at different widths
and two layers own the same responsibility.

**Fix**: a shared `<SettingsPage title>` in `packages/ui/src/components/layout/app/` owning Column + scroller +
one canonical max-width.

### 3.5 `_auth.guests.tsx` ≡ `_auth.orphans.tsx`

73 lines each in `apps/admin/src/routes/`; the diff is 12 hunks of names/strings plus
`useAdminUsers('guest'|'orphan')` — the same page over the two values the hook already accepts. Copy drift has
crept into the detail pane ("Select a guest…" vs "Select a user…").

**Fix**: one app-local `AdminFilteredUserRoute` component taking filter, route target, and strings; keep the two
route files and their `validateSearch` thin. This stays in the Admin app — no other app owns this server-wide
user classification.

### 3.6 AGENTS.md is half stale on this topic

The "four near-identical EigenDoc editor routes and four sidebars rendering loaders four ways" line: the editor
routes are now thin (46–71 lines over `useEigenDocEditorRoute`) and the four EigenDoc apps have **no** sidebars —
they route through `EigenDocRoot` and the shared `AppSidebar`. The loader-drift problem moved to the six remaining
app sidebars (admin, calendar, chat, contacts, mail, space — see §8.1). Update AGENTS.md to point at the live
offenders.

## 4. Copy-paste clusters inside apps

### 4.1 Calendar event dialogs — the worst single instance

`apps/calendar/src/components/create-event-dialog.tsx` (318 lines) vs `edit-event-dialog.tsx` (480): ~180 of
create's lines have a verbatim twin in edit — the `calendarOptions` memo, both time-change handlers, the
all-day/timed Date construction, the entire date-time row JSX (~80 lines), location/description rows, the
calendar `<Select>`, and the `DialogFooter`. The same helper exists under two names
(`toTimeString`/`toLocalTimeString`).

**Fix**: extract the shared field rows into one form component both dialogs compose; move `calendarOptions` to
`calendar-utils`.

### 4.2 Drive list routes — the scaffold written four times

`apps/drive/src/routes/_auth.fs.$ownerId.$mountId.$pathId.tsx` (194 lines) · `_auth.mime.$mimeType.tsx` (119) ·
`_auth.shared.$to.tsx` (130) · `_auth.watched.tsx` (112). Each repeats the same `validateSearch` pid/uid(/mid)
extraction, `onQuickLook` (byte-identical ×4), the same 4-way `onRowActivate` dispatch (folder → route,
eigen-doc → `openDocument`, inline-editable → edit route, else preview), `handleBack*`, and a ~23-prop
`<DriveLayout>` call. Only the data hook and the `allow*`/`show*` flags differ meaningfully (the fs route
legitimately adds the share dialog, `RequestAccessView`, and root-id resolution; folder-branch targets differ per
view).

**Fix**: a `useDriveListRoute({ items, capabilities })` scaffold in `packages/ui`; collapses ~300 lines and
shrinks with §5.5's `capabilities` object.

### 4.3 Calendar month/week views

`month-view.tsx` and `week-view.tsx` share verbatim blocks: the `didAutoOpen`/`initialEventId` effect,
`handleEventClick`, the `selectedCalendar`/`selectedSharedCalendar` derivation, the `EventDetailDialog` wiring,
and the invite-status opacity classes. **Fix**: one `useEventDetailState` hook + a shared event-pill class helper.

### 4.4 Person lists — four implementations, feature drift

`apps/contacts/.../contacts-list.tsx` (selection + drag + keyboard + context menu), `apps/admin/.../members-list.tsx`
(no context menu), `apps/contacts/.../team-member-list.tsx` (keyboard only), `apps/admin/.../admin-user-list.tsx`
(no keyboard at all). Byte-level shared: the search/sort memo, the scroller div
(`flex-1 overflow-y-auto outline-none` + `tabIndex={0}` — also in mail's `email-list.tsx`), and the row shell
(`px-6 py-3 eigen-list-item` + `<UserItem>`). Two defects fall out of the drift (§2.3).

**Fix**: extract `<PersonList>` into `packages/ui`; at minimum route Admin through `alphaGroupKey` today.

### 4.5 Select-then-open-menu idiom — 3 copies, drifted anchor

Canonical in `packages/ui/.../drive/use-drive-item-controller.ts` (`if (!selection.isSelected(id))
selection.select(id); contextMenu.handleContextMenu(e, item)`); re-implemented in `contacts-list.tsx` and mail's
`email-list.tsx` (diff = type names only). Drift: drive anchors the ⋮ menu at `rect.right`, contacts at
`rect.left`. **Fix**: generalize into a `useSelectableContextMenu<T>` in `packages/ui/src/hooks/` — the logic
touches nothing but `id`.

### 4.6 Import/export scaffold — docs + sheets + slides

The import handlers (`handleImport`/`handleImportFromDrive`/`handleImportFromDevice`) in docs'
`editor-toolbar.tsx` and sheets' `toolbar.tsx` are byte-for-byte identical; the import JSX differs in three
literals. The export triple (`useExportDocument` + `handleExport` + `<ProgressDialog title="Exporting document">`)
appears at 4 sites — docs, sheets, slides toolbars and `packages/ui/.../drive-layout.tsx` — with the title string
typed out four times. **Fix**: let `useExportDocument` take a `DrivePath` and own the progress dialog; add a
shared `DocumentImportPicker`.

## 5. packages/ui

### 5.1 Dead code (grep-verified zero importers, all workspaces, all specifier variants)

| Item | Evidence |
|---|---|
| `src/components/sheet.tsx` (full shadcn Sheet, ~100 lines) | no importer of the file or any `Sheet*` symbol |
| `src/components/skeleton.tsx` | `Skeleton` referenced nowhere outside its file |
| `src/hooks/use-mobile.ts` (body is `export * from '@workspace/lib/media'`) | zero importers; all `useIsMobile` consumers import `@workspace/lib/media` directly |
| `layout/delete/index.ts`, `layout/search-bar/index.ts` | zero importers of either barrel — every consumer deep-imports the underlying file (15× / 5×) |
| `useDocSearchBar` (doc-search provider) | zero references; only `useOptionalDocSearchBar` is called (7×) |

Also exported but referenced only inside their own file (drop the `export`): `buttonVariants`, `badgeVariants`,
`tabsListVariants`, `useFormField`, `memberRowClassName`, `loginSearchSchema`. Delete, then `bun run primitives`.

### 5.2 Byte-identical and near-duplicate components

- **`NotFound` ≡ `AccessDenied`** (`layout/app/`): 13-line files identical apart from names, down to the same
  default flavor string; `EmptyState` renders the same DOM for the message-only case. Consumers: 5 + 1. Replace
  the 6 call sites with `<EmptyState message>` (and point §2.4's not-found registration at the same treatment).
- **`ConfirmDialog` vs `DeleteDialog`**: identical `pending` lifecycle and `onOpenChange` guard, with three
  explanatory comment blocks copy-pasted verbatim. `DeleteDialog` has 18 render sites. Merge into `ConfirmDialog`
  with `destructive?`/`itemName?`; keep `DeleteDialog` as a thin preset.
- **`ColorSwatchRow`** (`layout/notes/`) re-implements `ColorPicker`'s swatch button near token-for-token; one
  consumer (`cards/card-form.tsx`). Delete; pass `colors`/`showReset` to `ColorPicker`.
- **`ReferenceAttachmentChip`** duplicates `SimpleAttachmentChip`'s `outerClass` string and the entire `onRemove`
  X-button block verbatim. Add an icon slot to `SimpleAttachmentChip`.
- **`UserName`** duplicates `UserItem`'s email-link block (same condition, same anchor); exactly one consumer
  (calendar's event-detail dialog). Fold in or extract the fragment.
- **`LoadingScreen`**: one internal caller (`eigen-app.tsx`), zero external. Stop publishing it.

### 5.3 Structural hazards

- **Import cycle through the base Dialog** (real, traced): `components/dialog.tsx` → `preview-provider` →
  `drive/file-preview` → `drive-location-picker` → `components/dialog`. The lowest shadcn primitive transitively
  depends on the Drive feature tree, for the `abovePreview` z-index flag. Let `PreviewProvider` publish "preview
  open" through a small context module `dialog.tsx` can import without the provider implementation.
- **`components.json` declares `"rsc": true`** on a Vite project — `shadcn add` will emit the `"use client"`
  directives AGENTS.md forbids. One-word fix.
- **`packages/lib/tsconfig.json` maps `"@workspace/ui/*"` to lib's own `./src/*`** — dead and misleading (only
  biome, not tsc, guards the layering rule). Delete the line.
- **`docs/CODE-STANDARDS.md` documents `@workspace/ui/components/ui/button`** — `components/ui/` does not exist;
  primitives sit flat in `components/`. Fix the table row (part of §7's reconciliation).

### 5.4 `components/layout/` is a junk drawer

213 of 246 component files live under `layout/`, including domain trees that aren't layout — `drive/` (43 files,
~5.8k lines), `comments/` (17), `chat/` (7), `media/`, `labels/`, `contacts/`, `cards/`, `notes/`, `mount/` —
plus providers. The name has stopped carrying information and inflates every import specifier. Mechanical,
low-priority fix: `components/{drive,chat,comments,…}` for domains, keep `components/layout/` for actual layout.

### 5.5 God files

- **`layout/drive/drive-layout.tsx`** (504 lines): one large component, 29 hook calls (14 `useCallback`), a
  27-field props type with 7 boolean `allow*`/`show*` toggles. Split the dialog orchestration out of the
  list/detail layout; collapse the flags into one `capabilities` object (also shrinks §4.2's call sites).
- **`layout/chat/chat-message-list.tsx`** (673 lines): mixes a generic URL/email tokenizer (`RichContent`), a
  contact/mention inspect card + location-picker dialog, an inline message editor, and the scroll list (plain
  `scrollTop` tracking — not virtualized). Split off `rich-content.tsx` + `inline-edit.tsx`.
- `chat-create-wizard.tsx` (506), `dropdown-menu.tsx` (435, mobile drill-in fork), `doc-search-provider.tsx`
  (430) are large but cohesive — leave.

## 6. packages/lib

### 6.1 One god file: `use-drive.ts` (944 lines, 44 exports, five concerns)

Its own section-banner comments mark the seams, and `core/drive/hooks/` already holds sibling modules, so the
split follows existing convention: `keys.ts` (driveKeys + invalidators — also removes the
`use-watch.ts → use-drive.ts` import edge), reads, writes, sharing, trash. `core/drive/index.ts` already
`export *`s from `./hooks`, so the split is invisible to consumers. Everything else in lib is healthy —
`use-calendar.ts` (361 lines) reads as a clean keys/CRUD/sharing rhythm, not a god file.

### 6.2 The one real type fork: the BE mail parser

`packages/lib/src/types/mail.ts` and `apps/api/src/lib/mail/mail-parser/mail-parser.ts` both define
`StructuredHeader`, `HeaderValue`, `HeaderLines`, `EmailAddress`, `AddressObject`, `Attachment`, `ParsedMail` —
and they have diverged: `ParsedMail.html` is `string | false` in lib vs `string | null` in the parser;
`Attachment.calendarMethod` is `ImipMethod` vs an inline union; the parser names its header map **`Headers`**,
shadowing the fetch/DOM global (lib calls the same type `MailHeaders`). These copies meet — parser output flows
into the FE-facing `Email`. **Fix**: the parser imports the 7 types from `@workspace/lib/types/mail`; reconcile
`false` vs `null` at that moment.

### 6.3 Small pattern breaks (the only ones found)

- `use-app-passwords.ts` — no `staleTime`; file-private key factory whose `['app-passwords']` key carries nothing
  user-identifying (safe today only because logout calls `queryClient.removeQueries()`).
- `use-invite-signup.ts` — the only raw inline `queryKey` in lib; also no `staleTime`.
- `admin/hooks/keys.ts` — `setupStatus: () => ['setup-status']` escapes the `['admin']` namespace (see §1.2).
- `use-drive.ts` — hand-splices `[...driveKeys.owner(ownerId), 'effective-members', …]` instead of a factory entry.
- `staleTime` spellings: five minutes is written `5 * 60 * 1000` (12×), `1000 * 60 * 5` (14×), and `5 * 60_000`
  (1×). Export one `STALE_TIME` constant set — "which queries cache for 5 minutes" should be greppable.
- Key-factory placement: only admin has a `hooks/keys.ts`; search and versioning keep `keys.ts` at the domain
  root; the other domains inline the factory in the biggest hook file. Standardize (helps §6.1).

### 6.4 Dead exports

**`useActiveMember`** (`core/admin/hooks/use-active-member.ts`) and **`useContact`**
(`core/contacts/hooks/use-contacts.ts`): zero call sites in the entire repo, yet both are catalogued in
SHARED-PRIMITIVES.md, which makes them look adopted. Delete and regenerate. (`getErrorMessage` in `api-error.ts`
is *not* dead — it is called within its own file; only the `export` keyword is unneeded.)

### 6.5 Placement and layering nits

- **`useDebouncedValue`** is a generic 6-line React util living under `core/command-palette/`;
  `chat-create-wizard.tsx` imports the whole palette barrel to debounce an input. Move to `core/`.
- **`htmlToPlainText`** (`core/html.ts`) calls `document.createElement` in a module 12 `apps/api` files import.
  Not a bug today (the BE only uses `escapeHtml`/`stripTagsServer`, and the file documents the split), but a
  landmine: move the DOM variant to a browser-only module — its only consumers are in `apps/slides`.
- **The BE deep-import carve-out is unwritten**: 4 imports in `apps/api` use `@workspace/lib/core/…` (chat
  emotes/format-preview, collab yjs-utils). They exist because the domain barrels re-export React hooks — but
  they only resolve via the tsconfig path fallback; the package `exports` map (`"./*": "./src/core/*"`) would
  send them to a nonexistent `src/core/core/…`. Give lib explicit BE-safe subpaths and write the carve-out into
  AGENTS.md.
- **Comment hooks are split across two domains**: `useComments`/`useResolveComment`/`useAssignComment` live in
  `core/chat/hooks/use-comments.ts` (exported from `@workspace/lib/chat`) while `core/comments/` exports the
  comment-card hooks. Move or re-export so `@workspace/lib/comments` finds the thread hooks.
- Minor inversion: calendar-flavored `formatEventWhen` lives in generic `date.ts` while generic
  `isSameDay`/`isToday` live in `calendar-utils.ts`, and `date.ts` re-derives "is today" inline. Fold on next
  touch.

## 7. Import-path and export-surface hygiene — the systemic finding

**The `exports` maps are decorative.** Every app tsconfig declares `"@workspace/ui/*": ["../../packages/ui/src/*"]`
and Vite resolves via `tsconfigPaths`, so the curated entry points constrain nothing — while the SHARED-PRIMITIVES
generator treats them as the source of truth, and CODE-STANDARDS contradicts both (it prescribes
`@workspace/ui/components/...`, says there is no top-level alias, and its one example path doesn't exist — §5.3).
Consequences, all live today:

1. **The same component is imported up to four ways.** `ColumnLayout`: `@workspace/ui/components/layout` (1×),
   `…/app/column-layout` (11×), `…/app/column-layout.tsx` (22×). `TooltipButton`: `@workspace/ui` (14×), deep
   (6×), deep + `.tsx` (4×). 97 extension-suffixed import specifiers in apps and 107 more inside `packages/ui`
   (counting relative + workspace specifiers; 59/7 of those are `@workspace/*`). All 11 `login.tsx` files import
   the `.tsx` leaf path.
2. **Invisible primitives**: components apps actively deep-import that are absent from SHARED-PRIMITIVES.md
   because their directory has no barrel or exports-map entry — `SearchBar` (an AGENTS.md "Key UI Component"),
   `DocSearchProvider`, `MountForm`, `S3ConfigCard`, `SidebarPrimaryButton`, `DroppableSidebarItem`, `FontPicker`.
3. **Over-publishing**: `DriveTable`, `DriveBrowser`, `LoginPage`, `PreviewProvider`, `CommentThread` are all
   listed in the index with zero consumers outside `packages/ui` (5/5 on spot-check; the 2026-08-12 review
   measured 87 of 201 ui primitives — 43% — as external-consumer-free, a ratio not re-verified but the pattern
   is). `export *` sub-barrels leak internal composition units into the index and erode its "search here first"
   promise.
4. **Two incoherent barrels**: `src/index.ts` re-exports 25 of 42 layout entries with no discernible rule;
   `components/layout/index.ts` re-exports 5 of 26 subdirs and has exactly one consumer.

**Fix, in order**: (a) decide the canonical specifier per primitive and make CODE-STANDARDS, the
`package.json` exports, and the SHARED-PRIMITIVES generator agree — don't start the sweep before they do;
(b) one lint rule banning `.tsx`/`.ts` suffixes in import specifiers plus a mechanical codemod; (c) convert
`export *` sub-barrels to explicit named exports (drive/ and chat/ first); (d) add the missing barrels
(`search/`, `mount/`) so the real shared surface becomes visible.

Related naming debt: lib's `useSearch` shadows TanStack Router's `useSearch` — mail's filter route imports both
in one file, and CODE-STANDARDS already cites this as its bad-naming example. Rename (e.g. `useSearchQuery`).
Two unrelated components are both named `EditMenu` (`packages/ui/.../toolbar/edit-menu.tsx` and
`packages/sheet/.../MenuBar/edit-menu.tsx`) — rename the sheet one.

## 8. Consistency drift between apps

### 8.1 Sidebars: one shell, several loader treatments

The six app sidebars (admin, calendar, chat, contacts, mail, space) share the same wrapper div with the class
string in two orders (`flex h-full flex-col` in chat/mail/space; `h-full flex flex-col` in
calendar/contacts/admin). Loading states differ per app: `flex justify-center py-4` (chat),
`flex items-center justify-center py-4` (mail), bare `<EigenLoader/>` (contacts; calendar ×3), none (space,
admin). `contacts-sidebar.tsx` hand-rolls error and empty divs while the same app uses `ErrorState`/`EmptyState`
two files away. `StorageUsage` is present in mail/contacts/calendar/space and ui's `app-sidebar`, absent in
chat/admin — decide, don't drift. Inside `calendar-sidebar.tsx`, the personal-calendar row is a near-exact copy
of its own `SharedCalendarItem`. **Fix**: move the wrapper into `SidebarBody`; give `SidebarSection`
`loading`/`error`/`empty` props; parameterize the calendar row.

### 8.2 Fonts re-listed outside the registry

The canonical registry is `EIGEN_FONTS`/`getFontFamily` in `packages/lib/src/constants/fonts.ts`. Re-listings:
`apps/docs/.../editor.tsx` inlines a `fontMap` with the exact family strings `getFontFamily()` returns; slides
hardcodes `'Inter'` in `types.ts`, `normalize-deck.ts`, and `slide-properties-panel.tsx`; the BE re-lists the
bundled fonts in `apps/api/src/lib/import/sheets/from-xlsx.ts` (`FONT_MAP`) and
`apps/api/src/lib/export/sheets/fonts.ts` (`FONT_ARRAY`), with more hardcoded `"Inter"` in the doc/slides export
transforms (`export/slides/render.ts` does it right). One fact, many homes — route them all through the lib
constants.

### 8.3 Editor access-prop contract

The four EigenDoc editor routes pass document access two ways: docs `access={docInfo}`, sheets/slides/stickies
`canWrite={docInfo.canWrite}`. Pick one (`canWrite`; 3 of 4 use it).

### 8.4 Three hand-written ESLint suppressions in a Biome repo

`apps/mail/.../email-detail.tsx`, `email-draft.tsx`, and `apps/slides/.../use-snap-lines.ts` carry
`eslint-disable` comments that suppress nothing under Biome. Two point at unstable callback dependencies — useful
design information masquerading as tooling config. Resolve each dependency intentionally (`useEffectEvent` may
fit the two Mail effects; the Slides `useMemo` needs its own decision); if an omission remains necessary, use a
scoped Biome suppression with the reason. (Generated `routeTree.gen.ts` files and the forked `packages/sheet`
also contain `eslint-disable` lines — those are out of scope.)

### 8.5 One app-local type exported without a consumer

`apps/space/.../profile-editor.tsx` exports `ProfileFormValues`; nothing outside the file imports it. Remove the
`export`.

## 9. Verified clean

Worth recording — it means the house rules are working where they're enforced, and a validated non-finding
prevents re-litigation:

- **Data layer**: zero `useQuery`/`useMutation` in app components; `toast.error` appears once in app code — the
  §1.1 bug itself. All 93 lib `useMutation` call sites route errors through `onMutationError` (87 direct, 6 via
  custom `onError` handlers that call it after optimistic rollback or a 409 guard). Zero
  `@ts-ignore`/`@ts-expect-error` in lib; lib's one escape-hatch cast (`as unknown as`, `core/search/pagefind.ts`)
  is a justified dynamic-import seam; zero `as any` in lib **and** in all frontend app code (not just outside
  generated route trees — the route trees are clean of it too).
- **Styling**: zero `animate-spin` in apps (every spinner is `EigenLoader`); zero raw `clsx`; hardcoded hex in
  Slides/Stickies describes user document content, not theme chrome.
- **Scaffolding that already works**: `login.tsx` is fully factored — all 11 files are 4-line adapters over
  `createLoginRouteOptions`, the model §3 should copy (their `.tsx` import path is §7's problem, not theirs).
  The four EigenDoc editor routes are thin (46–71 lines) over `useEigenDocEditorRoute`; `EigenDocRoot`,
  `EigenDocListView`, app configs, and route validation are shared correctly.
- **Deliberate non-findings** (investigated, should not become cleanup tasks without new evidence):
  - `_auth._sidebar.tsx` files: 5-line structural `Outlet` route nodes required by file routing. Leave them.
  - Large Docs/Slides editors: cohesive editor-state coordination. Split only around a stable responsibility,
    not a line count.
  - Sheets vs Slides `useActiveComments`: shared return type, inherently different traversal (cell matrix vs
    slide deck). A generic abstraction would add indirection without reuse.
  - Calendar's `toast.info('You cannot invite yourself')` (`attendee-editor.tsx`): immediate input feedback at
    the interaction layer, not mutation error handling. Appropriate.
  - `MediaPreview` (used by `MediaGrid`), `parseMediaGrids` (used by `apps/index/scripts/build-content.ts`),
    `ActivityRow` (used by the notification bell and Drive's activity event list) — all alive.
  - `layout/drive/file-presentation.tsx`: a JSX wrapper over lib's DOM-free icon registry, with a comment
    explaining the boundary. Justified split.
  - `ColorPicker`'s `DEFAULT_COLORS`: derived from `EIGEN_ACCENT_COLOR_ROW`/`EIGEN_COLORS`, not a re-listing.
  - The direct `useQueryClient` in drive's `native-file-editor.tsx` feeds the shared `invalidateEditorContent`
    helper — the sanctioned pattern, not a violation.
  - App-specific sidebars/toolbars own different navigation and domain actions; the shared-shell drift in §8.1
    is worth fixing, a generic mega-sidebar component is not.

## 10. Claims that did not survive verification

Both source reviews contained assertions the code refutes or corrects. Recorded so they don't resurface:

- **2026-08-07: "No dead component file was confirmed."** Refuted — `sheet.tsx`, `skeleton.tsx`,
  `use-mobile.ts`, and two barrels are zero-importer dead, plus dead exports in both packages (§5.1, §6.4).
- **2026-08-07: `as any` "occurrences are in generated TanStack route trees."** Frontend apps have zero `as any`
  anywhere, generated files included; the only real hit in the repo's app code is one API test.
- **2026-08-07: "Three ESLint suppression comments."** Three *hand-written app* suppressions; generated route
  trees (13) and the forked sheet package (5) also carry `eslint-disable` lines.
- **2026-08-12: `getErrorMessage` is a dead export.** Refuted — called within its own file; only the `export`
  keyword is unneeded.
- **2026-08-12: app-passwords is "the only lib query with no `staleTime`."** `use-invite-signup.ts` also lacks it.
- **2026-08-12: "93/93 mutations have `onError: onMutationError`."** 87 direct + 6 custom handlers that call it —
  the substance (100% coverage) holds, the literal claim didn't.
- **2026-08-12: "one type cast in all of lib."** True only for escape-hatch casts (`as any` 0, `as unknown as` 1);
  ordinary `as` assertions exist (e.g. raw-fetch `res.json()` results in `use-drive.ts`).
- **2026-08-12 counts corrected**: `DeleteDialog` has 18 call sites (not ~13); `DriveLayout` has 27 props / 7
  boolean flags (not ~30/10); `chat-message-list` is **not** virtualized and its inline card is a
  contact/mention card, not a drive-item card; `TooltipButton` splits 14/6/4 (not 11/4/4); the 96/107
  extension-suffix counts include relative specifiers (59/7 are `@workspace/*`); `FindReplaceBar` is missing
  from the index but only imported internally; search/versioning keep `keys.ts` at the domain root, not under
  `hooks/`; upload failures do surface a generic "Upload failed" chip (just nothing actionable).
- **2026-08-12: rolldown treats `foo` and `foo.tsx` as distinct pre-bundle module ids.** Not verified; dropped.
  The specifier-chaos finding stands without it.

## 11. Suggested sequence

1. **Failure contracts** (§1) — independent workflows, each with focused tests; don't bundle with mechanical
   cleanup.
2. **Small bugs** (§2) — several fall out of later extractions for free; do the rest directly.
3. **Scaffolds and duplication** (§3–4) — router/provider extraction has a broad compile blast radius; typecheck
   every affected workspace, smoke-test routes.
4. **Surface hygiene** (§7) — reconcile CODE-STANDARDS + exports + generator *first*, then the lint rule and the
   mechanical sweep.
5. **Dead code and mechanical consistency** (§5.1, §6.4, §8) — cheap, anytime; regenerate SHARED-PRIMITIVES.md
   when exports change.

`bun run check` after every phase.
