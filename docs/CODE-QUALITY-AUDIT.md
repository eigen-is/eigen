# Code Quality Audit

**Date**: 2026-05-17
**Scope**: Whole monorepo (apps + packages)
**Goal**: Find duplications, code smells, convention violations, and over-engineering — keep the codebase flat, simple, and consistent as it grows.

Findings come from six parallel audit agents. Each finding includes file:line references and a confidence rating. **Verify the current state before acting** — agents can be wrong, the codebase moves quickly, and the `feat/unify-comments-as-cards` branch is in flight.

---

## TL;DR

The codebase is in **good shape overall**. Shared-component discipline is high (~18 routes use `ColumnLayout`, 113+ `EmptyState`/`LoadingState` callsites, 100+ `TooltipButton` callsites, zero `clsx`/`twMerge`/`"use client"` violations, Eden Treaty type chain intact end-to-end, no service/manager layers).

The drift clusters in six areas:

1. **`apps/space` settings routes don't use `ColumnLayout`** (7 routes).
2. **Date formatting reimplemented** in admin/mail/calendar despite `@workspace/lib/date` existing.
3. **`adminKeys` query keys lack `ownerId`/`orgId` scoping** — real cache-staleness risk across orgs.
4. **Apps redefine view-model projection types** (`AdminUser`, `TeamMember`, `IcsEventSummary`, `ActiveComments` ×3) instead of inferring from hooks.
5. **A handful of backend routes drift** in error handling (`chat.editMessage` returns `{success:false}` with 200, `drive.ts:768` throws raw `Error`, `setup.ts` mutates `set.status`).
6. **Cross-app UI compositions are reassembled per app** (sidebar primary button, undo/redo toolbar, share/comments cluster, avatar-detail hero, danger zone). Primitives are shared, compositions aren't.

**One sharding-seam concern**: `resolveCalendarForEvents` returns another user's `Calendar` instance and routes write to it directly — bypasses `home-relay.ts`. Will need refactoring before multi-server deployment.

---

## What's working well

- **No `clsx` / `twMerge` / `"use client"` in apps**, anywhere. `cn()` discipline is universal.
- **No `*Service` / `*Manager` / `*Factory` classes** except `LockManager` (genuine WebDAV in-memory state). The "no service layers" rule has stuck.
- **MIME constants** funnel through `EIGEN_DOC_TYPE_INFO` — no hardcoded MIME strings in apps.
- **Eden Treaty type chain is intact** — `as any` exists only in legacy parser code (`packages/sheet`) and generated `routeTree.gen.ts` files.
- **SSE pattern is uniform** across every domain (`home.broadcast(buildXEvent(...))`).
- **`ApiError` usage in routes is consistent** — only a handful of stragglers.
- **21 lib-side `getHome` calls outside `home-relay.ts`** are each commented `// own home` or `// ownerId-routed`. Sharding rule is being respected.
- **`requireSelf` / `requireAdmin` / `requireNonGuest` / `requireTeamAccess` / `requireTeamAdmin`** form a clean ownership-guard vocabulary.

---

## Cross-cutting themes

- **Shared primitives exist; shared compositions don't.** `AppSidebar`, `TooltipButton`, `EmptyState`, `Column`, `FileMenu` are well-used. But the compositions *around* them (sidebar `+` button, undo/redo pair, "Share + Comments + DocumentMode" right cluster, alphabetized lists with letter headers, avatar-detail hero, danger-zone delete card) are reassembled in every app.
- **Apps occasionally bypass the hook layer.** Three components carry `useQueryClient` directly; five components run `try/catch` + manual `toast.error` around mutations that already have `onMutationError` in the hook.
- **The `[domain]Keys` shape isn't enforced.** `driveKeys` and `calendarKeys` follow `all → owner(id) → resource → instance`; `chatKeys`, `commentKeys`, `editorKeys`, `teamKeys`, `teamMountKeys`, and `adminKeys` don't.
- **The `:ownerId` second-segment rule has a fuzzy carve-out.** `settings.ts`, `setup.ts`, `public.ts` omit it; `waitlist.ts` includes it but never reads it. Either the rule needs an explicit "server-wide admin routes exempt" caveat, or these routes need to comply.

---

## Quick wins (≤ 1 day each)

Sorted by impact-to-effort. Each is mechanical and self-contained.

| #  | Win                                                                                  | Files                       | Effort  |
|----|--------------------------------------------------------------------------------------|-----------------------------|---------|
| 1  | `Drive.getCollabDocument` → `throw new ApiError(404, ...)` instead of `Error`       | 1 line (§4.7)               | ~5 min  |
| 2  | Mail `email-detail.tsx` hand-rolled separator → `<Separator orientation="vertical">` | 1 file (§1.8)               | ~5 min  |
| 3  | `apps/api/src/routes/drive.ts` inline guards → `requireSelf()`                       | 2 sites (§4.2)              | ~10 min |
| 4  | Delete `isTextPreviewSupported`; have callers branch on `getTextPreviewMode(...)`   | 1 file (§6.7)               | ~10 min |
| 5  | `chat.editMessage`/`deleteMessage` → `ApiError` instead of `{success:false}`        | 2 sites (§4.6)              | ~20 min |
| 6  | Replace inline date formatting in `_auth.waitlist.tsx`; drop `date-fns` dep         | 1 file (§2.2)               | ~20 min |
| 7  | `email-list.tsx` inline date formatting → `formatDateTime`                          | 1 file (§2.2)               | ~10 min |
| 8  | Setup-wizard hardcoded green SVG → Lucide `<CheckCircle2 className="text-success">` | 1 file + token (§2.4)       | ~15 min |
| 9  | `team_${id}` → `teamOwnerId(...)` sweep                                              | 4 sites (§5.6)              | ~30 min |
| 10 | Type-imports barrel sweep — `@workspace/lib/types/<domain>` direct imports           | 11 sites (§5.7)             | ~30 min |
| 11 | Lift `ActiveComments` to `packages/lib/src/types/comments.ts`                        | 4 files (§5.1)              | ~20 min |
| 12 | `Home.destruct` 6× try/catch → `Promise.allSettled([...])`                          | 1 file (§6.4)               | ~20 min |

---

## 1. Cross-app UI duplication

Patterns implemented in 2+ apps that should be promoted to `packages/ui`.

### 1.1 Sidebar primary "+" button (chat / calendar / contacts / mail) — high

Every app sidebar opens with the same `condensed ? 'w-10 p-0' : 'w-full justify-start gap-3'` button, wrapped in `<div className="px-3 py-2">`.

- `apps/chat/src/components/chat/chat-sidebar.tsx:115-127` ("New chat")
- `apps/contacts/src/components/contacts/contacts-sidebar.tsx:31-43` ("Create contact")
- `apps/calendar/src/components/calendar-sidebar.tsx:137-147` ("Create event")
- `apps/mail/src/components/mail/email-compose-button.tsx` (consumed by `email-sidebar.tsx:153-155`)

Mobile gap differs between chat (`gap-3`) and email compose (`gap-2`) — drift already happening.

**Action**: Extract `SidebarPrimaryButton` (icon + label + onClick + condensed) under `packages/ui/src/components/layout/sidebar/`. Pair with the existing `AppSidebar.newButton?` slot.

### 1.2 Yjs UndoManager toolbar wiring (stickies / slides / docs) — high

Identical 18-line `useEffect` subscribing to `'stack-item-added'`/`'popped'`/`'updated'` plus the Undo/Redo button pair.

- `apps/stickies/src/components/stickies/toolbar.tsx:45-68`, `104-117`
- `apps/slides/src/components/slides/toolbar.tsx:45-68`, `87-100`
- `apps/docs/src/components/docs/editor-toolbar.tsx:96-97, 215-223, 376-384`

**Action**: Two layers. (a) Hook `useYjsUndoState(undoManager, canWrite)` in `packages/lib/src/core/collab/` returning `{canUndo, canRedo, undo, redo}`. (b) `<UndoRedoButtons />` in `packages/ui/src/components/layout/toolbar/`. Stickies is the cleanest base.

### 1.3 "Share + Comments + DocumentMode" right cluster (slides / sheets / stickies / docs) — high

Right-side toolbar cluster: optional `CountBadge`-decorated comments toggle + `UserRoundPlus` share OR `DocumentModeButton` (when `!canWrite`). Sheets already extracted it as `ToolbarRightItems`.

- `apps/sheets/src/components/sheets/toolbar.tsx:83-110` (already named `ToolbarRightItems`)
- `apps/slides/src/components/slides/toolbar.tsx:113-130`
- `apps/stickies/src/components/stickies/toolbar.tsx:162-168` (no comments yet)
- `apps/docs/src/components/docs/editor-toolbar.tsx:720-730`

**Action**: Promote sheets' `ToolbarRightItems` to `packages/ui/src/components/layout/toolbar/document-share-cluster.tsx`. Comments props slot in once stickies unification lands.

### 1.4 Share editor: contact + permission row list (calendar / drive) — high

`ContactAutosuggest` + `+` button + scrollable `<UserItem>` rows with permission `<Select>`. The email-parsing helper `processContactInput` is near-duplicated.

- `apps/calendar/src/components/calendar-share-editor.tsx:1-190`
- `packages/ui/src/components/layout/drive/drive-access-list-edit.tsx:100-150` (production-tested)

Calendar share editor has no unit tests; drive's is well-tested. Bug fixes drift silently.

**Action**: Extract `ShareList<TPermission>` to `packages/ui/src/components/layout/sharing/`. Pull `processContactInput` into `packages/lib/src/validation/contact-input.ts` first.

### 1.5 "Avatar + name + email" detail hero — high

Same lockup in 4 places — byte-identical between the two admin instances.

- `apps/admin/src/components/admin/admin-user-list.tsx:114-120`
- `apps/admin/src/components/admin/member-detail.tsx:92-98`
- `apps/contacts/src/components/contacts/contact-detail.tsx:130-150` (richer — adds jobTitle/company)
- `apps/contacts/src/components/contacts/team-member-detail.tsx:19-26`

**Action**: Extract `<UserDetailHero name email imageUrl subtitle? actions? />` to `packages/ui/src/components/layout/`. Model the API on the richer contacts version.

### 1.6 "Danger zone" delete card (admin × 2) — high

Two byte-identical 18-line blocks in the same directory. Will spread to space/team/etc.

- `apps/admin/src/components/admin/admin-user-list.tsx:135-150`
- `apps/admin/src/components/admin/member-detail.tsx:135-153`

**Action**: `<DangerZone title? description confirmDescription buttonLabel onConfirm />` next to `DeleteDialog`.

### 1.7 Alphabetized list with letter headers (contacts × 2) — medium-high

Both files do the `groups[firstChar]` reducer themselves and render the same `bg-muted/50 px-6 py-2` letter header.

- `apps/contacts/src/components/contacts/contacts-list.tsx:144-216`
- `apps/contacts/src/components/contacts/team-member-list.tsx:25-69`

**Action**: Extract `<AlphabeticalList items renderItem getKey />`. Could compose with existing `useKeyboardListNavigation` + `useListSelection`.

### 1.8 Detail toolbar right cluster + hand-rolled vertical separator — medium

6 occurrences of `flex items-center gap-1 ml-auto`. Mail re-implements a vertical separator with `<div className="h-6 w-[1px] bg-border mx-1" />` instead of `<Separator orientation="vertical" />`.

- `apps/mail/src/components/mail/email-detail.tsx:59-66` (broken window)
- Plus 5 detail toolbars in admin/contacts that share the layout

### 1.9 Other (medium-priority)

- **Avatar stack** — `chat-sidebar.tsx:55-62` and `drive-share-summary.tsx:56-64` are essentially the same with different overlap amounts.
- **Color-checkbox** — `calendar-sidebar.tsx:24-42` reimplements a colored Check checkbox; stickies/team filters could use it.
- **AddMemberDialog pattern** — search input + scrollable `UserItem` rows with `+` on hover.

---

## 2. Frontend layout & shared component usage

### 2.1 `apps/space` routes bypass `ColumnLayout`/`Column` — high

7 settings routes use `<div className="flex flex-col m-8"><h1>…</h1><Component/></div>` instead of `ColumnLayout` + `Column` with toolbar slot.

- `apps/space/src/routes/_auth.user.tsx`
- `apps/space/src/routes/_auth.email.tsx`
- `apps/space/src/routes/_auth.data.tsx`
- `apps/space/src/routes/_auth.security.password.tsx`
- `apps/space/src/routes/_auth.security.2fa.tsx`
- `apps/space/src/routes/_auth.services.tsx`
- `apps/space/src/routes/_auth.index.tsx`

**Action**: Wrap each in `ColumnLayout` + `<Column id="detail" width="flex" toolbar={...}>`. The h1 belongs in the toolbar slot.

### 2.2 Hand-rolled date formatting instead of `@workspace/lib/date` — high (admin/mail), medium (calendar)

- `apps/admin/src/routes/_auth.waitlist.tsx:230-242` — four `new Date(x).toLocaleString()` + `formatDistanceToNow` from `date-fns` (line 19/132) instead of `formatTimeAgo`. **Introduces `date-fns` which the rest of the repo doesn't use.**
- `apps/mail/src/components/mail/email-list.tsx:117-129` — inline "today→time / else→date" branching.
- `apps/calendar/src/components/event-detail-dialog.tsx:46-70` — local `formatFullDate` helper duplicates `formatDateWithYear`.
- `apps/calendar/src/components/calendar-toolbar.tsx:18-28`, `recurrence-picker.tsx:34` — month-name formatting.

**Action**: Replace with `formatDate`/`formatDateTime`/`formatTimeAgo`. Add `formatLongDateTime` + `formatMonth(date, 'long'|'short')` to `core/date.ts` for the cases that don't fit.

### 2.3 Template-literal class concatenation (22 sites) — high

``className={`… ${cond ? 'foo' : 'bar'}`}`` instead of `cn()`. Representative:

- `apps/stickies/src/components/stickies/column.tsx:44, 53, 76` (three on one component)
- `apps/slides/src/components/slides/slide-object.tsx:241, 289`
- `apps/docs/src/components/docs/editor.tsx:656, 665, 682`
- The condensed-sidebar-button pattern repeats in 4 sidebars (folded into §1.1)

**Action**: Mechanical sweep to `cn('a', cond && 'b', !cond && 'c')`.

### 2.4 Non-theme Tailwind colors — high (setup-wizard), medium (blog/index)

- `apps/admin/src/components/admin/setup-wizard.tsx:130, 132` — `bg-green-100` + `text-green-600` on "Setup Complete" icon. **Breaks dark mode. First screen new admins see.**
- `apps/admin/src/components/admin/setup-wizard.tsx:130-138` — also a hand-rolled inline `<svg>` checkmark.
- `apps/admin/src/components/admin/storage-type-picker.tsx:155` — `text-green-600` for connection success.
- `apps/index/src/routes/blog.index.tsx:61` — `hover:text-blue-600`.

**Action**: Add a `--success` / `text-success` token. Replace inline SVG with `<CheckCircle2 className="w-8 h-8 text-success" />`.

### 2.5 Hand-rolled `<Dialog>` for confirmation flows — high (2 cases)

`ConfirmDialog` exists and accepts `title/description/onConfirm/confirmText`.

- `apps/drive/src/components/editor/conflict-dialog.tsx` — pure confirmation.
- `apps/mail/src/components/mail/email-draft.tsx:348-358` — "Cannot send" alert, hand-rolled next to a `ConfirmDialog` call below.
- 16 files import `Dialog` directly; many are legitimate (input-bearing dialogs), but the "Cancel + submit" footer is duplicated.

**Action**: Convert pure confirmations to `ConfirmDialog`. Consider extracting `FormDialog` for the input-bearing pattern.

### 2.6 Hand-rolled tooltip+button trios in docs editor — medium

`docs/editor-toolbar.tsx:518-532, 561-566` builds `<Tooltip>...<TooltipTrigger asChild><Button>...</Button></TooltipTrigger>...</Tooltip>` because the button is also a Popover trigger and `TooltipButton` doesn't currently support that.

**Action**: Add `TooltipPopoverButton` variant in `packages/ui/src/components/layout/toolbar/`.

### 2.7 Other (low priority)

- `login-fa2.tsx:153, 209` — text-link buttons; use `<Button variant="link" size="sm">`.
- `stickies/column.tsx:102` — "Add a sticky" plain `<Button variant="ghost">`.
- `chat/chat-sidebar.tsx:136` — inline `<div>No chats yet</div>`; could be a `SidebarEmptyHint`.
- `team-detail.tsx:392` — inline `<p>No members in this team yet.</p>`; should be `EmptyState`.

---

## 3. Hook layer

### 3.1 `adminKeys` lacks `ownerId`/`orgId` root — caches across orgs — high

- `packages/lib/src/core/admin/hooks/keys.ts:1-8` — only `adminKeys.org(orgId)` provides scoping, all callers fall back to `organizationId ?? ''`.
- `packages/lib/src/core/admin/hooks/use-admin-users.ts:7` — uses inline `[...adminKeys.all, 'users', filter]` (the `'users'` slot isn't even defined in `keys.ts`).

Cross-org cache pollution risk when `organizationId === undefined` mid-mount.

**Action**: Add `adminKeys.users(orgId)` and `adminKeys.usersFiltered(orgId, filter)`. Drop the `?? ''` fallback; gate with `enabled: !!organizationId`.

### 3.2 Flat key shapes (`chatKeys`, `commentKeys`, `editorKeys`, `teamKeys`, `teamMountKeys`) — high

Don't follow the `all → owner(id) → resource → instance` hierarchy:

- `packages/lib/src/core/chat/hooks/use-chat.ts:10-14` — `['chat', 'messages', ownerId, mountId, chatId]`
- `packages/lib/src/core/chat/hooks/use-comments.ts:5-11` — skips `owner()` entirely
- `packages/lib/src/core/editor/hooks/use-file-content.ts:4-8` — `['editor', 'content', ownerId, ...]`
- `packages/lib/src/core/team/hooks/use-team-settings.ts:8-12` and `use-team-mounts.ts:7-9` — flat, plus `teamMountKeys` is a sibling object instead of nesting

**Action**: Adopt `driveKeys` shape uniformly. For team-scoped data: `teamKeys.owner(teamOwnerId(teamId))`.

### 3.3 Apps reaching into the QueryClient — high

- `apps/admin/src/routes/_auth.orphans.tsx:1, 27, 36` — `queryClient.invalidateQueries({ queryKey: [...adminKeys.all, 'users'] })` after delete.
- `apps/admin/src/routes/_auth.guests.tsx:1, 27, 36` — identical pattern.

Both routes invalidate `'users'` because `useDeleteUser` (`packages/lib/src/core/admin/hooks/use-members.ts:81-94`) only invalidates `adminKeys.members(orgId)` — the user list isn't invalidated, so apps compensate.

**Action**: Make `useDeleteUser` invalidate the user list (export `invalidateAdminUsers(queryClient)`). Drop `useQueryClient` from both routes.

### 3.4 Manual `try/catch` + `toast.error` in components — high

- `apps/space/src/components/space/login-fa2.tsx:57-71` — `try/catch` around `authClient.twoFactor.verifyTotp/verifyBackupCode` + manual `toast.error('Verification failed')`. A `useVerifyTotp` hook already exists (`use-security.ts:31`).
- `apps/index/src/routes/index.tsx:66-70` — direct `publicApi.waitlist.post(...)` + manual toasts. No hook.
- `apps/admin/src/components/admin/setup-wizard.tsx:68-96` — direct `setupApi.complete.post(...)` + `setError`. No hook.
- `apps/contacts/src/components/contacts/contact-edit.tsx:106-112` — `try { await onSave() } catch { setError(...) }` swallows the real `AppError` message.
- `apps/space/src/components/space/fa2.tsx:91-110` — `try/catch` around hook-provided mutations → produces double toasts.

**Action**: Move to hooks. Add `useCompleteSetup`, `useJoinWaitlist`. Delete app-side try/catch in contact-edit / fa2.

### 3.5 `useNotifications` / `useUnreadNotificationCount` missing `staleTime` — medium

- `packages/lib/src/core/notification/hooks/use-notifications.ts:17-37` — defaults to 0 → every remount refetches.

**Action**: `staleTime: 30_000` or `60_000` (SSE already invalidates).

### 3.6 `useComments` missing `ownerId`/`mountId` guards and `staleTime` — medium

- `packages/lib/src/core/chat/hooks/use-comments.ts:13-22` — `enabled: !!containerId` only.

**Action**: `enabled: !!ownerId && !!mountId && !!containerId`, `staleTime: 120_000`.

### 3.7 Inline `try/catch` inside `useChatRoom` — medium

- `packages/lib/src/core/chat/hooks/use-chat-room.ts:207-217` — wraps `inviteToChat.mutateAsync` and adds a generic chat message, but `useInviteToChat` already toasts via `onMutationError`. Double signal.

### 3.8 Inline query keys — medium

- `packages/lib/src/core/calendar/hooks/use-calendar.ts:166` — inline `[...calendarKeys.owner(ownerId), 'access', calendarId]`. Should be `calendarKeys.access(...)`.
- `packages/lib/src/core/drive/hooks/use-drive.ts:492` — inline `[...driveKeys.path(...), 'breadcrumb']`. Should be `driveKeys.breadcrumb(...)`.

### 3.9 Other patterns to standardize

- `authClient.*` wrappers (`useChangePassword`, some admin hooks) throw `new Error(String(error))` — should throw `AppError` so `onMutationError` produces consistent UI.
- `useMarkChatRead` (`use-chat-unread.ts:73-77`) calls `notificationApi(...).patch()` outside `useMutation` for optimistic-update reasons. Document the rationale or wrap in `useMutation` with `onMutate`.

---

## 4. Backend pattern consistency

### 4.1 [HIGHEST] Calendar writes bypass the home-relay sharding seam — high

- `apps/api/src/lib/calendar/get-calendar.ts:49-55` — `resolveCalendarForEvents` returns `ownerHome.calendar` for non-team, non-own-owner callers.
- `apps/api/src/routes/calendar.ts:171-203` — POST/PUT/DELETE on events call `calendar.createEvent/updateEvent/deleteEvent` directly on that instance.

This is a textbook sharding-seam violation per `docs/SCALABILITY.md`. In a sharded deployment the owner's calendar lives on a different server; today's code path mutates `ownerHome.calendar` in-process. Refactoring this now is much cheaper than after multi-server.

**Action**: Add `calendar:event-create/update/delete` `HomeMessage` variants. Route writes through `sendToHome(ownerId, ...)`. Consider a `pullEventsForCalendar(...)` for reads too.

### 4.2 `apps/api/src/routes/drive.ts` inline ownerId guards — high

Lines 43 and 52 use `if (params.ownerId !== user.id) throw new ApiError(403, 'Not your drive')` instead of `requireSelf(params.ownerId, user.id)`. Different error message than every other route.

**Action**: Replace with `requireSelf(...)`.

### 4.3 `SharedDrive.getMimeTypeContents` silently returns `[]` on no permission — medium-high

- `apps/api/src/lib/drive/sharedDrive.ts:85-110` — non-team-member callers get `[]` instead of 403.

Inconsistent with every other unauthorized `SharedDrive` method (e.g. `restorePath`, `listTrash`, `permanentlyDelete`).

**Action**: Throw `ApiError(403, 'No read permission')` when caller is not a team member.

### 4.4 `settings.ts` routes lack the `:ownerId` segment — medium

All 7 settings routes (`/settings/server`, `/settings/s3config`, etc.) at `apps/api/src/routes/settings.ts:19, 28, 108, 117, 130, 147, 160` use only `requireAdmin(user.id)`.

**Action**: Either (a) prefix every settings route with `/settings/:ownerId/...` and add `requireSelf` + `requireAdmin`, or (b) document the "admin/server-wide route" carve-out in AGENTS.md. Lean toward (b).

### 4.5 `waitlist.ts` declares `:ownerId` but never reads it — high

- `apps/api/src/routes/waitlist.ts:20-76` — `:ownerId` is purely cargo-cult; only `requireAdmin(user.id)` is checked.

URL contract is a lie. Either remove `:ownerId` or add `requireSelf(params.ownerId, user.id)`.

### 4.6 `chat.editMessage` returns `{success:false}` with HTTP 200 — medium-high

- `apps/api/src/routes/chat.ts:67-71` — when `editMessage` returns null (not found / not owned), returns `{ success: false, error: '...' }` with 200 instead of throwing `ApiError(404)` or `ApiError(403)`.
- Adjacent `.delete` at line 86 has the same anti-pattern.

**Action**: Throw `ApiError(404, 'Message not found or not owned')` from the domain method. Drop success-flag pattern.

### 4.7 `Drive.getCollabDocument` throws raw `new Error()` for a route-reachable path — high

- `apps/api/src/lib/drive/drive.ts:768` — `throw new Error('Document not found')`. Reachable from `routes/collab.ts:73, 86, 189`. Surfaces as 500 instead of 404.

**Action**: `throw new ApiError(404, 'Document not found')`.

### 4.8 SharedDrive coverage gaps (forward-looking) — low-medium

`getSharedPathsByMe`, `getSharedPathsWithMe` reachable from routes via the `getDrive(user)` escape hatch after `params.ownerId !== user.id` rejection. Intentional but only documented in inline comments.

Several `Drive` methods (`size`, `findContainerPath`, `touchUpdatedAt`, `touchFile`, `receiveACLChange`, `closeCollabDocument`) are not wrapped — none currently route-reachable, but future drift risk.

**Action**: Either make them `private`/`protected`, or document the escape-hatch pattern in AGENTS.md.

### 4.9 `setup.ts` mutates `set.status` instead of throwing `ApiError` — medium

- `apps/api/src/routes/setup.ts:11-14, 23-25` — `set.status = 400/403` plus `{ok:false}` payload. Adjacent `public.ts:32` does it correctly.

**Action**: Throw `ApiError`.

---

## 5. Shared types & utilities

### 5.1 `ActiveComments` duplicated 3× — high

Identical `type ActiveComments = { ids: Set<string>; anchorTexts: Map<string, string> }` in three apps:

- `apps/docs/src/components/docs/editor.tsx:143`
- `apps/slides/src/components/slides/hooks/use-active-comments.ts:5`
- `apps/sheets/src/components/sheets/hooks/use-active-comments.ts:4`
- Canonical home: `packages/lib/src/types/comments.ts` (currently only `CommentCard`)

**Action**: Lift to `packages/lib/src/types/comments.ts`. Natural to do as part of the in-progress comments-unification branch. The three `useActiveComments` hooks could probably move to `packages/lib/src/core/comments/` next.

### 5.2 `ApplyTo` declared twice in slides; same concept named `RecurringAction` in calendar — high (slides), medium (cross-app)

- `apps/slides/src/components/slides/slide-properties-panel.tsx:489` + `hooks/use-deck.ts:9` — both: `type ApplyTo = 'this' | 'this-and-following' | 'all'`
- `apps/calendar/src/components/recurring-action-dialog.tsx:7` — same union, named `RecurringAction`

**Action**: At minimum, lift to `apps/slides/src/components/slides/types.ts`. Cross-app unification depends on whether slides semantics align with calendar's RFC 5545 model — verify first.

### 5.3 `AdminUser` projection duplicates the hook return shape — high

- `apps/admin/src/components/admin/admin-user-list.tsx:14` — local type already produced by `packages/lib/src/core/admin/hooks/use-admin-users.ts:5` via Eden Treaty.

**Action**: Use `ReturnType<typeof useAdminUsers>['data'][number]` or add `AdminUser` to `packages/lib/src/types/admin.ts` (file exists).

### 5.4 `TeamMember` redefined locally — high

- `apps/contacts/src/components/contacts/team-member-list.tsx:6` — `export type TeamMember = { email: string; name: string }` (drops avatar/id/role).
- Canonical: `useTeamMembers` in `packages/lib/src/core/team/hooks/use-team-members.ts:6`.

**Action**: Delete the projection; use the element type of `useTeamMembers` return.

### 5.5 `IcsEventSummary` + `parseIcs` reimplemented in mail — high

- `apps/mail/src/components/mail/calendar-invite-widget.tsx:11-62` — second `.ics` parser with its own narrow type.
- Canonical: `apps/api/src/lib/caldav/ical-parse.ts` (full RFC-aware) consuming `EventData` from `packages/lib/src/types/calendar.ts:16`.

**Action**: Add a FE-safe `parseIcsSummary(raw: string): Pick<EventData, ...>` in `packages/lib/src/core/calendar/`, or expose a `/calendar/parse-ics` route.

### 5.6 Hardcoded `team_${id}` instead of `teamOwnerId()` — high

- `apps/admin/src/components/admin/team-detail.tsx:98`
- `apps/api/src/lib/calendar/share-propagation.ts:64`
- `apps/api/src/lib/drive/acl-propagation.ts:23`
- `apps/api/src/lib/share/reconciliation.ts:69`
- Canonical: `packages/lib/src/types/owner.ts:45`

**Action**: Replace 4 sites with `teamOwnerId(...)`.

### 5.7 Type imports through the `@workspace/lib/types` barrel (11 sites) — high

Convention is `import type {...} from '@workspace/lib/types/<domain>'`, not via the index.

- `apps/admin/src/components/admin/storage-type-picker.tsx:2`, `mount-dialog.tsx:1`
- `apps/api/src/lib/home/team-home.ts:2`, `config/server-settings.ts:1`, `config/quota.ts:1`, `drive/sharedDrive.ts:1`, `routes/shared-schemas.ts:1`, `routes/settings.ts:1`
- `packages/lib/src/core/settings/hooks/use-s3-check.ts:3`, `use-s3-config.ts:3` (the shared package itself)

**Action**: Mechanical sweep to `@workspace/lib/types/<domain>`. Note that `EMPTY_S3` and `teamOwnerId` are *values* and may stay on the index.

### 5.8 `S3CheckResult` shape duplicated — high

- `apps/admin/src/components/admin/storage-type-picker.tsx:11` — `type S3CheckResult`
- `packages/lib/src/core/settings/hooks/use-s3-check.ts:8` — inline return annotation
- Backend route: `apps/api/src/routes/settings.ts` — no return-type annotation (Eden Treaty infers)

**Action**: Add `export type S3CheckResult` to `packages/lib/src/types/settings.ts`; use as the route handler's return type. Drop the duplicates.

### 5.9 Deep relative imports into `packages/ui` from `apps/api` — high

- `apps/api/src/lib/export/fonts.ts:2, 5, 8, 11, 14, 17` — 6 font imports through `../../../../../packages/ui/src/...`
- `apps/api/src/lib/export/slides/html.ts:4`, `doc/html.ts:8` — CSS imports.

**Action**: Add `"./assets/*": "./src/assets/*"` and `"./styles/*": "./src/styles/*"` to `packages/ui/package.json` `exports`. Switch to `@workspace/ui/assets/...` / `@workspace/ui/styles/...`.

### 5.10 Type-safety casts to review

The Eden Treaty type chain is intact. `as any` only appears in `packages/sheet/src/engine/parser/grammar-parser/grammar-parser.ts:555, 613` (legacy parser code); all 80 other `as any` hits are TanStack-Router generated `routeTree.gen.ts` files. **No action needed there.**

Casts worth fixing:

- `selectedEmail as EmailDraftType` (`apps/mail/src/routes/_auth.$filterType.$filterId.tsx:92, 172`) — extract `isEmailDraft(email)` type guard.
- `home.settings.get() as TeamSettings` (`apps/api/src/lib/home/home-relay.ts:164, 172`) — expose a typed getter on `Home`.
- `{ type, ownerId } as SSEvent` casts in `sse-events.ts` files — tighten `buildEvent()` return types.

Acceptable seams (no action): Yjs `toArray()`, `JSON.parse`, `mailparser` outputs.

---

## 6. Over-engineering & code smells

The codebase is overwhelmingly disciplined here — almost no defensive null checks, no service layers, type system is trusted. Genuine smells are localized.

### 6.1 `useDeck` is a 538-line god-hook returning 23 callbacks — medium

- `apps/slides/src/components/slides/hooks/use-deck.ts:57` — exposes the entire slides API in one call (deck state, slide CRUD, object CRUD, ordering, comments, undo/redo). Editor destructures 23+ fields.

Comments-related fields (`addCommentToObject`, `removeCommentFromObject`) were grafted on rather than living next to the comment-cards layer.

**Action**: Consider splitting comment-on-object mutations into `useObjectComments` once the unification lands. Keep `useDeck` to deck/object/yjs concerns. Not urgent — coherent today.

### 6.2 Comment-card lookup re-implemented per editor — high

Identical `unresolvedCount` / `openEntry` projection logic in slides and docs editors (and presumably stickies/sheets).

- `apps/slides/src/components/slides/editor.tsx:180`
- `apps/docs/src/components/docs/editor.tsx` — both compute `cards[id]` → `find(c => c.chatName === card.chatName)` against `useComments` data

Recent commit `7abefaf6 refactor(docs): comment mark attribute chatName → cardId` — slides still uses `chatName` on the card. **Drift already happened.**

**Action**: After unification PR lands, factor a `useCardWithEntry(cards, allComments, cardId)` selector into the comments domain hook.

### 6.3 Defensive `try {} catch {}` around `controller.enqueue` and SSE wiring — medium

- `apps/api/src/lib/home/home.ts:170-204` — every `controller.enqueue` is wrapped in empty-catch, plus an outer try/catch in the keepalive loop.

```ts
try { controller.enqueue({ event: 'keepalive' }); } catch { isClosed = true; }
```

The `desiredSize === null` check above already detects closed streams. Empty catches make the close path unreachable through normal control flow.

**Action**: Collapse to a single `if (controller.desiredSize === null) { isClosed = true; return; }` guard before enqueue. Same for the unsubscribe try/catch blocks.

### 6.4 `Home.destruct` repeats the same try/catch 6× — high

- `apps/api/src/lib/home/home.ts:241-279` — six identical `try { await this._x?.destruct(); } catch (error) { console.error('Failed to destruct x:', error); }` blocks back-to-back.

Each subsystem destruct is independent — no ordering guarantees needed.

**Action**: Inline as `await Promise.allSettled([...])` over the six destructors + the managedDatabases close loop, logging rejections with their key. Drops ~25 lines.

### 6.5 `parseIfHeaderTokens` exported but only used in-file — high (low impact)

- `apps/api/src/lib/drive/lock-manager.ts:145` — exported but every call is in the same file. Same shape for `LOCK_DEFAULT_TTL_MS` (line 150).

**Action**: Drop the `export` keywords; promote only when a second caller appears.

### 6.6 `LANGUAGE_MAP` + `getLanguageFromFileName` indirection — medium

- `apps/api/src/lib/preview/text-preview.ts:60-63` — function that just does `LANGUAGE_MAP[ext]`.

**Action**: Inline `LANGUAGE_MAP[ext.toLowerCase()]` at the one callsite.

### 6.7 `getTextPreviewMode` + `isTextPreviewSupported` is a discriminator pair where one would do — high

- `apps/api/src/lib/preview/text-preview.ts:65-67` — `isTextPreviewSupported` exists solely as `getTextPreviewMode(...) !== null`. Callers then re-call `getTextPreviewMode` to discriminate.

**Action**: Delete `isTextPreviewSupported`; have callers branch on `getTextPreviewMode(...)`.

### Long files — judged

| File                                                       | Lines | Verdict       | Reason                                                                                          |
|------------------------------------------------------------|-------|---------------|-------------------------------------------------------------------------------------------------|
| `apps/api/src/lib/calendar/calendar.ts`                    | 1643  | ✓ legitimate | One class, one DB, CRUD + occurrence-expansion. Tightly coherent.                              |
| `apps/api/src/lib/mail/mail-parser/mail-parser.ts`         | 1424  | ✓ legitimate | Vendored/forked mail parser. Don't touch unless rewriting.                                     |
| `apps/api/src/lib/mount/mount.ts`                          | 1105  | ✓ legitimate | Storage facade across local/local-key/S3. Layered correctly.                                   |
| `apps/api/src/lib/drive/drive.ts`                          | 1073  | ⚠ mixed      | Top-level Drive class. Coherent today, but ACL + collab + SSE concerns are starting to crowd. |
| `apps/slides/src/components/slides/editor.tsx`             | 925   | ⚠ mixed      | One component file is fine; the comments-card duplication suggests projection helpers belong in `packages/lib`. |
| `apps/docs/src/components/docs/editor.tsx`                 | 843   | ⚠ mixed      | Same shape as slides editor; same prescription.                                                |
| `apps/docs/src/components/docs/editor-toolbar.tsx`         | 793   | ✓ legitimate | Big toolbar = lots of buttons; splitting hurts readability.                                    |

### Cross-cutting observations

- **Defensive try/catch on internal calls** appears in three places: `Home.destruct`, the SSE controller wrappers, and `commentIndex.update` (chat.ts:395). All eat errors with `console.error`. Some are justified (mailer fire-and-forget); others aren't.
- **`*Result` types are mostly fine** — plain return-shape structs, not discriminated unions papered over.
- **Cross-app projection of the same shared state** (comments cards × comment entries) is the most expensive duplication today.

---

## Suggested next steps

1. **Land the quick wins** — all mechanical, well-scoped, reduce per-PR friction.
2. **Decide on `:ownerId` carve-out for admin routes** — either fix `settings.ts`/`waitlist.ts`, or document the exemption in AGENTS.md.
3. **Standardize `[domain]Keys` shape** — sweep `chatKeys`, `commentKeys`, `editorKeys`, `teamKeys`, `teamMountKeys`, `adminKeys` to match `driveKeys`. Most impactful: `adminKeys` (real cache-staleness risk).
4. **Move app-side `try/catch` + `toast.error` into hooks** — 5 known sites (§3.4). Add the missing hooks.
5. **Schedule the `resolveCalendarForEvents` relay refactor** — only real sharding-seam violation.
6. **Promote 2-3 cross-app UI compositions** — sidebar primary button (§1.1), undo/redo wiring (§1.2), share+comments cluster (§1.3). Already drifting; landing them stops the bleeding.
7. **After comments unification lands**, lift `ActiveComments` + the `useCardWithEntry(...)` selector into `packages/lib/src/core/comments/` (§5.1 + §6.2). Most expensive duplication today.

---

## Notes on this audit

- All six audit agents completed. Findings include file:line refs — **verify the current state before acting** (the codebase moves quickly; the `feat/unify-comments-as-cards` branch is in flight).
- Confidence ratings: **high** = directly observed; **medium** = pattern-match with concrete examples; **low** = forward-looking risk.
- This audit is a snapshot. Re-run when significant refactors land.
