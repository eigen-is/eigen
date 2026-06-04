# Eigen Code Quality Audit

_Generated 2026-06-04 by an automated 35-agent monorepo sweep (report-only — findings are candidates for review, not auto-applied)._

## Executive Summary

Eigen is a multi-app monorepo whose entire premise is shared infrastructure — `@workspace/ui`, `@workspace/lib`, a Drive/EigenDoc container model, Eden Treaty wire types, and a TanStack-Query hook layer. The audit confirms that premise is real but unevenly enforced: the shared primitives exist and are mostly good, yet the four EigenDoc apps (docs/slides/sheets/stickies) and several FE/BE seams keep re-deriving things that should live in one place. Code health is solid-but-drifting: no architectural rot, but a steady accumulation of copy-paste-with-drift and convention bypasses that are exactly the failure mode a shared monorepo is supposed to prevent. The 164 raw / 43 deduped findings cluster hard into two themes — Duplication and UX Inconsistency — and both trace back to the same root cause: a shared primitive doesn't exist (or isn't discoverable), so each app rolls its own and they diverge.

Duplication is the dominant and most damaging theme. The clearest case is the EigenDoc editor route scaffold (`apps/{docs,slides,sheets,stickies}/src/routes/_auth.*.$ownerId.$mountId.$pathId.tsx`): all four are the same component — same `useCollabDocumentInfo` + `setDocumentTitle` effect + `usePaletteDocSelection` + media/chat folder lookup + access guard + `DriveAccessDialog` — and they have already drifted (docs/stickies guard on `!docInfo?.canRead`, sheets/slides guard on `!path`; sheets mounts `MediaResolverProvider` and slides injects `mountId` into `path`, the others don't). The same story repeats at the storage layer (`LocalKeyStorage` vs `LocalStorage` are byte-for-byte identical except a `resolve`/`getFilePath` rename, with the path-traversal guard hand-copied a third time into `s3-storage.ts`/`local-filesystem.ts` with an inconsistent error type), in the comment lifecycle wiring across all four editors, in the contact-input state machine reimplemented in three share/attendee editors, and in calendar date/recurrence helpers duplicated FE↔BE. The highest-leverage cleanups are therefore the ones that collapse an N-way fork into one helper: a `useEigenDocRoute` hook (or shared route factory), a single `LocalDiskBackend` base class, a shared comment-lifecycle hook, and an `AddCardDialog`/`CardSettingsDialog` merge — each kills a whole row of "and they're already diverging" risk.

UX inconsistency is the same disease at the presentation layer. Identical states render differently because there's no shared component or copy constant: a native `window.confirm('You have unsaved changes. Discard?')` in `use-editor-save.ts:73` instead of the shared `ConfirmDialog`; toolbar titles hardcoded as raw `<span>`s in 7+ routes with no `ToolbarTitle`; `MediaResolverProvider` mounted at four different layers; divergent empty-state/delete/save micro-copy across mail/contacts/chat/admin; and admin detail panes exposing two competing delete affordances with different wording. None are individually severe, but collectively they read as four different products, which is precisely what the shared shell was meant to avoid.

Beneath those, the convention violations are the leading indicator worth taking seriously — they're cheap to fix and they predict future drift: hooks that bypass the mandated `invalidate*()` helpers with inline `invalidateQueries`, `as Type` casts on Eden responses (which Eden already types), query hooks missing the required explicit `staleTime` or throwing bare errors instead of `AppError`, and hand-rolled `en-US` date formatting that shadows `@workspace/lib/date` (a repeat offense per project memory on English-only dates). Two genuine correctness bugs surfaced and were verified: `Home.size()`/`destruct()` dereference `this._drive` non-optionally (home.ts:222/246) even though `OrgHome` legitimately has no drive — orgs never get one — so org-home `size()`/teardown throws a TypeError (the fix is to make `_drive` optional at those call sites like the `?.`-guarded `_mail`/`_contacts`, **not** to give orgs a drive); and the two calendar date→YYYY-MM-DD helpers disagree on timezone (`toISODateString` uses local `getFullYear/getMonth/getDate`, `occurrenceDateToString` uses UTC), which lands one free-busy computation on the wrong day. Finally there's a clear vein of pure dead weight that should just be deleted — `ConditionFormat/index.tsx` (only its sub-files are imported), `combobox.tsx` (zero importers and the sole reason `@base-ui/react` is a dependency), `useFileUpload`, three unreachable move-to-{inbox,archive,spam} mail endpoints, `FormulaEngine.evaluateAll()`, and the tell-tale `isTest() && false` that pins the better-auth logger permanently on. One honest caveat: `uploadWithProgress`'s dropped `headers` is not a silent bug — there's an explicit comment that custom headers are omitted to avoid a CORS preflight — but the param is still dead API surface (destructured as `_headers`) and should be removed from the signature so callers stop passing `additionalHeaders` that go nowhere.

## Prioritized Roadmap

### Quick wins
Mechanical, low-risk deletions and one-line conformance fixes. Each is directly PR-able.

| Opportunity | Category | Effort | Key files |
|---|---|---|---|
| Delete `combobox.tsx` and drop `@base-ui/react` (zero importers, sole consumer) | Dead Code | quick-win | `packages/ui/src/components/combobox.tsx`, `packages/ui/package.json` |
| Delete dead `ConditionFormat/index.tsx` (only `ConditionRules`/`ManageRules` are imported) | Dead Code | quick-win | `packages/sheet/src/components/ConditionFormat/index.tsx`, `packages/sheet/src/components/MenuBar/format-menu.tsx` |
| Delete dead `useFileUpload` (duplicate of `DriveUploadFiles` flow) | Dead Code | quick-win | `packages/ui/src/components/layout/drive/file-upload.tsx`, `drive-upload-files.tsx`, `index.ts` |
| Remove unreachable move-to-{inbox,archive,spam} mail endpoints + facades | Dead Code | quick-win | `apps/api/src/routes/mail.ts`, `apps/api/src/lib/mail/mail.ts` |
| Delete `FormulaEngine.evaluateAll()` (no caller, would compute wrong results) | Dead Code | quick-win | `packages/sheet/src/engine/formula-engine.ts` |
| Delete dead `getErrorMessage` shadow + dead SSE type re-exports | Dead Code | quick-win | `packages/lib/src/core/auth/hooks/use-auth-client.ts`, `core/sse/index.ts` |
| Fix `isTest() && false` so the better-auth logger is actually disabled in tests | Dead Code | quick-win | `apps/api/src/lib/auth/auth.ts:121` |
| Replace `window.confirm('…Discard?')` with shared `ConfirmDialog` | UX Consistency | quick-win | `apps/drive/src/components/editor/use-editor-save.ts:73`, `confirm-dialog.tsx` |
| Replace `as Type` casts on Eden responses with Eden's own types | Convention Violations | quick-win | `core/calendar/hooks/use-calendar.ts:173`, `chat-message-list.tsx:118`, `core/notification/hooks/use-notifications.ts:13` |
| Route inline `invalidateQueries` through the mandated `invalidate*()` helpers | Convention Violations | quick-win | `core/chat/hooks/use-chat.ts:90`, `use-comments.ts:37`, `core/admin/hooks/use-members.ts:57`, `use-teams.ts:49` |
| Add explicit `staleTime` to non-conforming query hooks; throw `AppError` not bare errors | Convention Violations | quick-win | `core/drive/hooks/use-drive.ts:497,564,611`, `use-file-content.ts:20`, `use-collab.ts:13` |
| Replace hand-rolled `en-US` date formatting with `@workspace/lib/date` | Convention Violations | quick-win | `contacts/contact-detail.tsx:115`, `event-detail-dialog.tsx:46` |
| Drop dead `parseOwnerId` null-guards + hand-parsed `team_` prefix | Convention Violations | quick-win | `acl.ts:11`, `drive.ts:699`, `calendar.ts:1046` |
| Create the two declared-but-missing calendar event indexes (schema vs migration drift) | Convention Violations | quick-win | `calendar/schema.ts:54`, `calendar/db-config.ts:55` |
| Import/derive shared types instead of re-spelling them | Convention Violations | quick-win | `chat/schema.ts:9`, `types/waitlist.ts:1`, `routes/drive.ts:101`, `home/home.ts:218` |
| Delete rename-only wrappers `arrayMatch`/`getFormulaRunList`; call engine directly | Over-Engineering | quick-win | `state/modules/formulaHelper.ts`, `formula-exec.ts` |
| Remove the dead `headers`/`additionalHeaders` param from `uploadWithProgress` (documented no-op) | Code Smells | quick-win | `upload-with-progress.tsx:9`, `file-upload.tsx:45` |
| Fix `tabContainerRef` double-attached to two DOM nodes | Code Smells | quick-win | `packages/sheet/src/components/SheetTab/index.tsx:94,143` |
| Make `getPublicConfig()` usage match its sync/non-nullable signature (drop `await`/`?.`) | Code Smells | quick-win | `server-config.ts:81`, `routes/public.ts:72`, `waitlist.ts:164` |

### Larger refactors
Ordered by impact. These collapse N-way forks or fix verified correctness bugs.

| Opportunity | Category | Severity | Why it matters | Key files |
|---|---|---|---|---|
| Extract `useEigenDocRoute` (or a shared route factory) for the 4 editor route scaffolds | Duplication | high | All 4 are the same component and have already drifted (canRead-vs-path guard, MediaResolverProvider, mountId injection) — the single worst monorepo-defeating fork | `apps/{docs,slides,sheets,stickies}/src/routes/_auth.*.$ownerId.$mountId.$pathId.tsx` |
| Make `_drive` optional in `Home.size()`/`destruct()` (org homes legitimately have none) | Code Smells | medium | Orgs have no drive by design; base `size()`/`destruct()` deref `this._drive` non-optionally → TypeError on org teardown/size. Fix = declare `_drive?: Drive` + `?.` at call sites like `_mail`/`_contacts`, not assign a drive | `home/home.ts:222,246`, `home/org-home.ts` |
| Collapse `LocalKeyStorage`/`LocalStorage` into one base; dedupe the 3× path-traversal guard | Duplication | high | Two byte-identical classes (only a `resolve`/`getFilePath` rename) + guard hand-copied with inconsistent error type | `storage/local-key-storage.ts`, `local-storage.ts`, `s3-storage.ts`, `core/local-filesystem.ts` |
| Extract a shared comment open/view/context-menu lifecycle hook for all 4 editors | Duplication | high | Same wiring copy-pasted into 4 editors; drift here breaks comments inconsistently per app | `docs/editor.tsx`, `slides/editor.tsx`, `sheets/editor.tsx`, `stickies/board.tsx` |
| Make `useChats`/`useTeamsHaveChats` reuse `useMimeContent` | Duplication | high | They re-implement it, swallow errors, and use a non-conforming staleTime | `core/chat/hooks/use-chat.ts`, `core/drive/hooks/use-drive.ts` |
| Extract one contact-input state machine for the 3 share/attendee editors | Duplication | high | Reimplemented across calendar↔drive ACL editors; security-adjacent input divergence | `drive-access-list-edit.tsx`, `calendar-share-editor.tsx`, `attendee-editor.tsx` |
| Merge `AddCardDialog` + `CardSettingsDialog` into one card form | Duplication | high | Same form, already drifting | `cards/add-card-dialog.tsx`, `cards/card-settings-dialog.tsx` |
| Make `apps/drive` `DriveNewMenu` use the shared registry-driven "New" menu | Duplication | high | Hand-rolls what the shared `drive-list.tsx` menu already does | `drive/drive-new-menu.tsx`, `drive/drive-list.tsx` |
| Unify the duplicated calendar date/time/recurrence helpers FE↔BE | Duplication | high | `truncateRRule`/`formatEventWhen`/`toISODateString`/event dialogs duplicated across the FE↔BE boundary | `calendar-utils.ts`, `api/.../calendar.ts`, create/edit/detail event dialogs |
| Consolidate the 3 date→YYYY-MM-DD helpers; pick one timezone semantics | Code Smells | medium | Verified bug: `toISODateString` (local) vs `occurrenceDateToString` (UTC) disagree → one free-busy use lands on the wrong day | `core/calendar/calendar-utils.ts:82,135`, `use-calendar.ts:216` |
| Replace the 4 calendar dialogs' manual `isLoading`+350ms `setTimeout` with mutation `isPending` | Code Smells | medium | Copy-pasted fake-latency pattern in 4 places; should use the real mutation state | create/edit/config/shared-config event dialogs |
| Avoid resolving effective members twice per chat `postMessage` (double ACL walk on hottest write) | Code Smells | medium | Perf on the highest-frequency write path | `chat/chat.ts:143,162`, `drive/drive.ts:668` |
| Delete `LabelProvider`; call lib mutation hooks directly from `LabelManager`/`LabelFilterHeader` | Over-Engineering | medium | Context wrapper adds nothing over the existing hooks | `labels/label-provider.tsx`, `contacts/main.tsx`, `label-manager.tsx`, `label-filter-header.tsx` |
| Drop the ~14 pure pass-throughs in the `mail.ts` facade; call client inline like contacts/calendar | Over-Engineering | medium | Facade adds indirection without behavior; contacts/calendar already do it inline | `api/src/lib/mail/mail.ts` |
| Split the 660-line `ContactEdit` god component; extract the array-field add/remove block | Code Smells | medium | Same add/remove block repeated 3×; hard to maintain | `contacts/contact-edit.tsx:356-590` |
| Add `ToolbarTitle` + standardize empty-state/delete/save micro-copy across apps | UX Consistency | low–medium | Identical states render/word differently across mail/contacts/chat/admin/space | `toolbar/`, mail/contacts/chat routes, `delete-dialog.tsx`, `member-detail.tsx` |
| Normalize `MediaResolverProvider` mount layer; consolidate admin double-delete affordances; route `EmailListToolbar`/setup-wizard through shared `Toolbar`/`InputGroup` | UX Consistency | low | Lower-stakes shell-consistency cleanups | sheets route, docs/slides/stickies editors, admin detail panes, `email-list.tsx`, `setup-wizard.tsx` |

### Suggested sequencing
Start with the Quick wins, leading with the pure deletions (combobox/`@base-ui/react`, ConditionFormat, useFileUpload, the three mail endpoints, evaluateAll) and the `isTest() && false` logger fix — they remove surface area, shrink the dependency graph, and de-risk every later refactor with near-zero chance of regression. Fold the convention fixes (invalidate helpers, Eden casts, staleTime/AppError, en-US dates) into the same pass: they're trivial and, more importantly, they're the leading indicators of drift, so closing them now stops the bleeding. Then fix the two verified correctness bugs early — the `_drive` non-optional access (org-home `size()`/teardown throws because orgs have no drive — make `_drive` optional, don't assign one) and the calendar local-vs-UTC date helper (a wrong-day bug) — since both are small but currently shipping incorrect behavior. Only after that take on the structural refactors, in this order: the EigenDoc route scaffold first (highest blast radius and already actively diverging), then the storage base class and the comment-lifecycle hook, then the contact-input/card-form/calendar-helper consolidations. Save `ContactEdit` and the broad UX-copy/`ToolbarTitle` standardization for last — they're the most invasive and least risky to defer, and they'll be cleaner to do once the shared primitives the other refactors introduce are in place.

## 1. Duplication & Unification Opportunities

This is the headline category: the same component, hook, util, or schema is hand-rewritten across apps and packages, and the copies have already started to drift (different guards, different error handling, different copy strings, divergent validation). Entries are grouped by the single shared artifact they should converge on, named with its target location in `packages/ui` or `packages/lib`. Drift that is *user-visible* or *security-relevant* is called out explicitly.

---

### Editor & collaboration scaffolding (4-way copy-paste across docs/slides/sheets/stickies)

The four EigenDoc apps share their *list* side (`EigenDocRoot`/`EigenDocListView`), but the *viewer* side was never factored, so three separate concerns are copy-pasted four times each. These are the largest and most drift-prone clusters in the codebase.

**Editor entry-route component duplicated verbatim across all 4 EigenDoc apps**
- **Severity:** high · **Effort:** moderate
- **Files:** `apps/docs/src/routes/_auth.doc.$ownerId.$mountId.$pathId.tsx`, `apps/slides/src/routes/_auth.slide.$ownerId.$mountId.$pathId.tsx`, `apps/sheets/src/routes/_auth.sheet.$ownerId.$mountId.$pathId.tsx`, `apps/stickies/src/routes/_auth.board.$ownerId.$mountId.$pathId.tsx`
- **Problem:** Each route independently declares the same `validateSearch ({ chat })`, calls `useCollabDocumentInfo`, runs an identical `setDocumentTitle` effect, calls `usePaletteDocSelection` (with the same copy-pasted WHY comment), derives `mediaFolderId`/`chatFolderId` via the same `folderContents.find(x => x.name === 'media'|'chat')?.id ?? null`, gates on `LoadingState` + `RequestAccessView`, and renders `DriveAccessDialog`. Only the editor component genuinely varies. Already drifted: docs/stickies guard on `!docInfo?.canRead || !docInfo.path` while slides/sheets guard only on `!path`; sheets/slides build a `{...docInfo.path, mountId}` memo that docs/stickies omit; `chatFolderId` is a `useMemo` in docs but a bare expression in slides.
- **Fix:** Add `useEigenDocEditorRoute(ownerId, mountId, pathId, chat)` in `packages/lib/src/core/collab/hooks/` returning `{ docInfo, isLoading, path, mediaFolderId, chatFolderId, accessDialogOpen, openAccessDialog }` (running the title effect + palette selection once), plus an `<EigenDocEditorShell>` in `packages/ui/src/components/layout/drive/` that renders the loading/RequestAccessView/DriveAccessDialog chrome via render-prop. Each route collapses to ~5 lines. Pick the `canRead`-based guard so all four converge.

**Comment open/view/context-menu lifecycle wiring duplicated across all 4 editors**
- **Severity:** high · **Effort:** moderate
- **Files:** `apps/docs/src/components/docs/editor.tsx:566`, `apps/slides/src/components/slides/editor.tsx:180`, `apps/sheets/src/components/sheets/editor.tsx:66`, `apps/stickies/src/components/stickies/board.tsx:68`
- **Problem:** Per-app comment *anchoring* (TipTap mark vs cardIds array vs cell matrix vs column membership) is by design per `docs/COMMENTS.md`. But the anchor-*independent* glue is copy-pasted: `openCardId` state, `useOpenCommentCard`, `useCardIdFromChatName`, the hook cluster (`useComments`/`useResolveComment`/`useCommentCards`/`useCreateCommentCard`/`useUpdateCommentCard`/`useUnresolvedCommentCount`/`useContextMenu`), and especially the `<CardDialog>` block whose `copyLinkUrl`/`onUpdate`/`onResolve`/`ownerId`/`mountId`/`canWrite` props are byte-identical across docs/slides/sheets. Drifting: sheets/slides pass `showResolveAction`, stickies passes `showResolveAction={false}`.
- **Fix:** Extract `useCommentLifecycle({ ownerId, mountId, pathId, path, doc, mapName, chatFolderId, initialChatName })` in `packages/lib/src/core/comments/` returning the full bundle, and a thin `<DocCommentDialogs>` in `packages/ui` that renders the shared `CardDialog` + `CommentContextMenu`. Each editor keeps only its anchor-specific `onDelete`/`handleSaveNew`.

**Yjs `WebsocketProvider` lifecycle boilerplate reimplemented in every editor**
- **Severity:** medium · **Effort:** moderate
- **Files:** `apps/slides/src/components/slides/hooks/use-deck.ts:102`, `apps/stickies/src/components/stickies/hooks/use-board.ts:105`, `apps/sheets/src/components/sheets/hooks/use-sheet.ts:55`, `apps/docs/src/components/docs/editor.tsx:117`
- **Problem:** Each reimplements `new Y.Doc()` → `getCollabWebSocketUrl(...)` → `new WebsocketProvider(wsUrl, '', doc, { resyncInterval: 5000, connect: true })` → `on('sync', ...)` flag + seed-defaults → `provider.disconnect()` + `doc.destroy()` teardown. The 5000ms resync interval and destroy-on-unmount contract live in four places; the sheets variant alone diverges (beforeunload flush).
- **Fix:** Add `useCollabDocument(ownerId, mountId, pathId)` in `packages/lib/src/core/collab/hooks/` owning the `Y.Doc` + provider lifecycle and returning `{ doc, provider, isSynced }`. Editors build their app-specific maps on top.

**Three identical `ActiveComments` EMPTY sentinels**
- **Severity:** low · **Effort:** quick-win
- **Files:** `apps/docs/src/components/docs/editor.tsx:163`, `apps/slides/src/components/slides/hooks/use-active-comments.ts:6`, `apps/sheets/src/components/sheets/hooks/use-active-comments.ts:5`
- **Problem:** `{ ids: new Set(), anchorTexts: new Map() } satisfies ActiveComments` is declared three times. The type is shared; the canonical empty value is not. (Per-app scanning logic genuinely differs and is fine.)
- **Fix:** Export `EMPTY_ACTIVE_COMMENTS: ActiveComments` next to the type in `packages/lib/src/types/comments.ts` and import it in all three.

---

### Card / form dialogs

**`AddCardDialog` and `CardSettingsDialog` are the same card form, duplicated**
- **Severity:** high · **Effort:** moderate
- **Files:** `packages/ui/src/components/layout/cards/add-card-dialog.tsx`, `packages/ui/src/components/layout/cards/card-settings-dialog.tsx`
- **Problem:** Both render the identical edit form for the same card entity: a `DialogContent size="md"` with a title `Input`, a `LightEditor` wrapped in the same `rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-within:ring-[3px] focus-within:ring-ring/50` box, an `EIGEN_STICKIES_COLORS` `ColorPicker (columns=8, showReset=false)`, and a Cancel/Save `DialogFooter` — both using the same `Required<Omit<Props,'open'>>` + `{open && <Content/>}` remount pattern. They have already drifted: `CardSettingsDialog` carries the `onReady` canonicalisation (avoids spurious-dirty) and emits a patch; `AddCardDialog` has an `isSubmitting` spinner and emits the full object. This is exactly the divergence a shared codebase prevents.
- **Fix:** Collapse to one `CardFormDialog` in `packages/ui/src/components/layout/cards/` owning the body + footer, driven by props (initial values, single `onSubmit` emitting a patch, optional `submitLabel`/placeholders, `isSubmitting`). Keep the `onReady` canonicalisation in the shared component so both create and edit avoid the spurious-dirty bug.

---

### Color-picker family (`packages/ui/src/components/layout/media/`)

Three findings orbit the same `ColorPicker` primitive; together they should produce one reusable swatch button + one contrast util.

**`ColorSwatchRow` re-implements a single-row `ColorPicker`; stickies toolbar inlines a third copy**
- **Severity:** medium · **Effort:** moderate
- **Files:** `packages/ui/src/components/layout/notes/color-swatch-row.tsx`, `packages/ui/src/components/layout/media/color-picker.tsx:64`, `apps/stickies/src/components/stickies/toolbar.tsx:90`
- **Problem:** `ColorSwatchRow` renders a row of `EIGEN_STICKIES_COLORS[0]` swatch buttons with the class `h-4 w-4 rounded-full border border-border/50 hover:scale-125 transition-transform flex items-center justify-center` + a `Check` overlay — exactly the swatch button `ColorPicker` already produces. The stickies toolbar inlines a third hand-rolled copy of the same button.
- **Fix:** Render `ColorSwatchRow` via `<ColorPicker colors={[EIGEN_STICKIES_COLORS[0]]} ... showReset={false} />` (or delete it and call `ColorPicker` at the callsite). Replace the stickies-toolbar inline swatches with the same so all three share one class string.

**Swatch-button + Popover + `ColorPicker` block duplicated across calendar/labels/docs**
- **Severity:** medium · **Effort:** quick-win
- **Files:** `apps/calendar/src/components/calendar-config-dialog.tsx:122`, `apps/calendar/src/components/shared-calendar-config-dialog.tsx:84`, `packages/ui/src/components/layout/labels/label-dialog.tsx:116`, `apps/docs/src/components/docs/editor-toolbar.tsx:516`
- **Problem:** The "swatch button opens a Popover containing `ColorPicker`" pattern is copy-pasted with a character-identical trigger (`<button type="button" className="h-9 w-9 rounded-md border border-input shrink-0" style={{ backgroundColor }} />`) and `<PopoverContent className="w-auto p-3" align="start"><ColorPicker showReset={false} /></PopoverContent>`, each managing its own `colorPickerOpen` state. The bare primitive exists; the swatch-trigger-+-popover wrapper everyone actually wants does not.
- **Fix:** Add `ColorPickerButton` (or `ColorSwatchPicker`) next to `ColorPicker` in `packages/ui/src/components/layout/media/`, owning the open state and embedding `ColorPicker` in the standard popover. Replace the three identical blocks (toolbar-button trigger variant for docs).

**`isLightColor(c) ? '#000' : '#fff'` contrast idiom repeated 5×**
- **Severity:** low · **Effort:** quick-win
- **Files:** `packages/ui/src/components/layout/notes/note-card.tsx:50`, `packages/ui/src/components/layout/notes/note-card-dialog.tsx:81`, `packages/ui/src/components/layout/notes/color-swatch-row.tsx:22`, `packages/ui/src/components/layout/media/color-picker.tsx:79`, `apps/stickies/src/components/stickies/toolbar.tsx:108`
- **Problem:** The readable-text-on-color computation (sometimes wrapped in `lightenColor`) is hand-written in ≥5 places with the literal hex pair repeated.
- **Fix:** Add `readableTextColor(bg: string): '#000' | '#fff'` next to `isLightColor`/`lightenColor` in `packages/lib/src/constants` and call it from all sites.

---

### Centered-message states (`packages/ui/src/components/layout/app/`)

**`AccessDenied` is a verbatim copy of `NotFound`; both re-implement `EmptyState`**
- **Severity:** medium · **Effort:** quick-win
- **Files:** `packages/ui/src/components/layout/app/access-denied.tsx`, `packages/ui/src/components/layout/app/not-found.tsx`, `packages/ui/src/components/layout/app/empty-state.tsx`, `apps/admin/src/routes/_auth.tsx`
- **Problem:** Verified byte-for-byte: `access-denied.tsx` and `not-found.tsx` are identical apart from the component name (same default message "Encountering the null vector…", same wrapper div). Both are a strict subset of `EmptyState`, which renders the identical wrapper + message and additionally supports `icon`/`action`. `AccessDenied`'s sole caller (`_auth.tsx:55`) always passes a custom message — so its default text is dead — and that file *already imports* `EmptyState`. Three components for one "centered message" UX.
- **Fix:** Delete `access-denied.tsx`; render the not-admin case in `_auth.tsx` via the already-imported `EmptyState`. Drop the `AccessDenied` export from the barrel. Collapse `NotFound` into `EmptyState` (render `<EmptyState message={...} />`) so the layout lives once.

---

### Topbar / settings shells

**`GuestUserDropdown` duplicates ~40 lines of `UserDropdown`**
- **Severity:** medium · **Effort:** moderate
- **Files:** `packages/ui/src/components/layout/app/topbar.tsx:129` and `:171`
- **Problem:** Verified — `GuestUserDropdown` is an exact subset of `UserDropdown`: identical `if (!auth.isAuthenticated) return null`, `LogoutDialog` + `AboutDialog`, avatar trigger Button, `UserItem` label, "About Eigen" item, "Log out" item. The only delta is the Profile/Settings/Theme block `UserDropdown` inserts. Any shell change must be made twice.
- **Fix:** Collapse to one `UserDropdown` that renders the Profile/Settings/Theme slice only when `!isGuest` (`{!isGuest && (<>…</>)}`), removing `GuestUserDropdown`.

**Every space settings page re-implements the same Column/scroll/`max-w-3xl` wrapper**
- **Severity:** high · **Effort:** moderate
- **Files:** `apps/space/src/routes/_auth.user.tsx`, `_auth.email.tsx`, `_auth.security.password.tsx`, `_auth.security.2fa.tsx`, `_auth.services.tsx`, `_auth.data.tsx`
- **Problem:** Six (seven with the 2FA branches) routes wrap content in the byte-identical `<ColumnLayout><Column id="detail" width="flex" toolbar={<span className="text-sm text-foreground font-normal">TITLE</span>}><div className="h-full overflow-y-auto"><div className="w-full max-w-3xl p-8">…`. Only the title and inner component differ; a new settings page can only be added by copy-paste.
- **Fix:** Add `SettingsPage` in `packages/ui/src/components/layout/app/settings-page.tsx` taking `title` + `children`. Each route becomes `<SettingsPage title="Mail"><SignatureSection/></SettingsPage>`. Admin settings routes share the same shell minus the title.

**"Important" info callouts hand-build a box that shadcn `Alert` already provides**
- **Severity:** medium · **Effort:** moderate
- **Files:** `apps/space/src/components/space/fa2.tsx` (×5: lines 116/160/207/257), `apps/space/src/components/space/profile-editor.tsx:196`, `apps/space/src/routes/_auth.services.tsx:58`
- **Problem:** The callout `<div className="bg-accent border text-accent-foreground rounded-md p-4">…<InfoIcon/>…<h3 className="font-medium">Title</h3><p className="text-sm">body</p>…</div>` is duplicated 5× in `fa2.tsx` plus elsewhere. `packages/ui/src/components/alert.tsx` already ships `Alert`/`AlertTitle`/`AlertDescription` rendering exactly this icon+title+body shape. This is the "use shared UI components" anti-pattern (per MEMORY).
- **Fix:** Replace with `<Alert><InfoIcon/><AlertTitle>…</AlertTitle><AlertDescription>…</AlertDescription></Alert>` from `@workspace/ui/components/alert`.

**Admin settings pages duplicate the draft/dirty state machine and Reset/Save footer**
- **Severity:** medium · **Effort:** moderate
- **Files:** `apps/admin/src/components/admin/server-settings.tsx`, `guest-settings.tsx`, `onboarding-settings.tsx`
- **Problem:** All three re-implement `[draft]`/`[dirty]` state, `update`/`handleSave`/`handleReset`, and the verbatim trailing `{dirty && (<><Separator/><div className="flex items-center justify-end gap-2"><Button variant="outline" onClick={handleReset}>Reset</Button><Button onClick={handleSave} disabled={saving}>{saving?'Saving...':'Save Changes'}</Button></div></>)}` footer.
- **Fix:** Extract a `SettingsSaveBar` (`packages/ui`) taking `dirty`/`saving`/`onSave`/`onReset`; optionally a `useDraftSettings` hook in `packages/lib` for the state machine.

---

### Share / contact-input editors

**Contact-input state machine reimplemented in 3 share/attendee editors**
- **Severity:** high · **Effort:** moderate
- **Files:** `packages/ui/src/components/layout/drive/drive-access-list-edit.tsx:99`, `apps/calendar/src/components/calendar-share-editor.tsx:46`, `apps/calendar/src/components/attendee-editor.tsx:51`
- **Problem:** All three wrap the shared `ContactAddRow` but re-hand-roll the identical input-state machine: a `processContactInput` parsing `email <name>`, a `handleContactSelected` branching on `value.includes('<') && value.includes('>')`, an `handleAddContactClick` commit, and a duplicated `excludeEmails` memo (shared targets + own email). `drive-access-list-edit` and `calendar-share-editor` are near-character-identical (verified), including the team-add `useMyTeams` dropdown with the same dedupe. Any fix (paste-multiple, trimming, validation message) must be made three times. The only real divergence is the permission vocabulary (editor/viewer vs write/read/free-busy).
- **Fix:** Lift the state machine to live with `ContactAddRow` — either `useContactInput({ onAdd, exclude })` in `packages/lib/src/core/contacts/hooks/` returning `{ value, onChange, onSubmit }`, or fold input/commit into `ContactAddRow` so callers pass only `onAdd(email, displayName)` + the exclude list. Add `useShareTargets`/`<ShareTargetList permissionOptions>`/`<ShareWithTeamMenu>` in `packages/ui` for the surrounding list + team plumbing; both editors pass their own permission options. *(Merges the two separate auditor reports of this same cluster.)*

---

### Calendar date/time/recurrence helpers

A dense cluster of duplicated calendar math. Several copies are FE↔BE (real bug magnets for DST/timezone) or already produce *user-visible* divergence.

**`truncateRRule` duplicated byte-for-byte between calendar FE and API BE**
- **Severity:** high · **Effort:** quick-win
- **Files:** `apps/calendar/src/components/calendar-utils.ts:27`, `apps/api/src/lib/calendar/calendar.ts:1566`
- **Problem:** Verified identical — same UTC arithmetic, `RRule.parseString` → set `until` → `delete count` → strip `RRULE:`. Depends only on `rrule` (FE+BE safe). Any DST/until fix has to be made twice.
- **Fix:** Move to a shared calendar util in `packages/lib` (it only imports `rrule`); import in both. Delete both local copies.

**Timezone-aware recurrence expansion duplicated between `expandRecurrence` and `computeOccurrenceTimes`**
- **Severity:** medium · **Effort:** moderate
- **Files:** `apps/api/src/lib/calendar/calendar.ts:1479` and `:1582` (plus the helpers at `:185`, `:1513`, `:1596`, `:1624`)
- **Problem:** Both implement "event UTC start → wall-clock dtstart → run RRule in wall-clock → convert matches back to UTC". The `new Date(Date.UTC(local.year, local.month-1, …))` build is copy-pasted at 3 sites; the inverse `localToUtc(tz, date.getUTC…)` at 3 more. A DST fix in one copy silently desyncs FE expansion from RSVP/exception occurrence times.
- **Fix:** Extract `wallClockDateFromLocal(c)` and `utcFromWallClockDate(tz, d)` next to `utcToLocal`/`localToUtc`; route both functions through one shared path.

**`event-detail-dialog` rolls its own event time-range formatter instead of shared `formatEventWhen`**
- **Severity:** medium · **Effort:** moderate
- **Files:** `apps/calendar/src/components/event-detail-dialog.tsx:46`, `packages/lib/src/core/date.ts:59`
- **Problem:** The dialog defines local `formatFullDate`/`formatTimeRange`; `packages/lib/src/core/date.ts` already exports `formatEventWhen(start, end, allDay, timezone)`, used server-side by iMIP. The local copy hardcodes `timeZone:'UTC'` for all-day and ignores `event.timezone` for timed events — so the **same event renders a different range in the email invite vs the detail dialog** (user-visible).
- **Fix:** Use `formatEventWhen` from `@workspace/lib/date` (passing `event.timezone`); delete the local formatters. Reconcile AM/PM vs en-GB-24h style in lib so there is one event-when formatter.

**`toLocalDateString` reimplements the shared `toISODateString` helper**
- **Severity:** medium · **Effort:** quick-win
- **Files:** `apps/calendar/src/components/calendar-utils.ts:20`, `packages/lib/src/core/calendar/calendar-utils.ts:82`
- **Problem:** Verified byte-for-byte identical to `toISODateString` already exported from lib (the calendar app imports from `@workspace/lib/calendar` elsewhere). (Note: lib's `formatInputDate` uses UTC and is *not* equivalent — `toISODateString` is the correct local match.)
- **Fix:** Delete `toLocalDateString`; import `toISODateString` from `@workspace/lib/calendar` (≈10 call sites).

**Create-event and edit-event dialogs are near-duplicate forms**
- **Severity:** high · **Effort:** large
- **Files:** `apps/calendar/src/components/create-event-dialog.tsx`, `apps/calendar/src/components/edit-event-dialog.tsx`
- **Problem:** Both reimplement the same event form: the `calendarOptions` useMemo, title/description/location/allDay/start-end/rrule/attendees state, the same all-day-vs-timed `Input`+`TimeSelect` branch with the same `text-lg border-0 border-b` title input, the same `AttendeeEditor`/`MapPin`/`AlignLeft` blocks, the same `handleStartTimeChange`/`handleEndTimeChange` wrap-to-next-day logic, and the same serialization + `DialogFooter`. `EditEventDialog` only adds recurrence-scope + linked-event read-only handling. Already drifting (create uses `getMinEndTime()`, edit inlines `addMinutes(startTime,15)`; create rounds the tz label off `Intl`, edit reads `event.timezone`).
- **Fix:** Extract `EventFormFields` + a `useEventForm` hook in `apps/calendar/src/components` (or `packages/ui/src/components/layout/calendar/` if shared further). The `calendarOptions` memo and time handlers live in the hook; both dialogs keep only mode-specific submit/recurrence wiring.

**`MonthView` and `WeekView` duplicate event-chip rendering and detail-dialog plumbing**
- **Severity:** high · **Effort:** moderate
- **Files:** `apps/calendar/src/components/month-view.tsx`, `apps/calendar/src/components/week-view.tsx`
- **Problem:** Both share verbatim: the `didAutoOpen` ref + initialEventId auto-open effect, `handleEventClick`, the `selectedCalendar`/`selectedSharedCalendar` resolution, the trailing `<EventDetailDialog>`, and the per-event chip computation (freeBusy/color/inviteStatus) + chip JSX (all-day pill vs timed dot, same `inviteStatus === 'pending'` dashed-border / `'declined'` opacity-40 styling, same key shape).
- **Fix:** Extract `<EventChip>` (props: event, color, inviteStatus, freeBusy, variant) and a `useCalendarEventDetail` hook owning selectedEvent/detailOpen + auto-open + calendar resolution + `EventDetailDialog`.

**Smaller calendar helpers**
- **Severity:** low · **Effort:** quick-win
- **Files:** `apps/calendar/src/components/create-event-dialog.tsx:27` + `edit-event-dialog.tsx:45` (`toTimeString`/`toLocalTimeString` are the same `HH:MM` padder); `apps/calendar/src/components/calendar-toolbar.tsx:17` (re-derives Monday start-of-week instead of `getWeekRange`)
- **Problem:** `toTimeString`/`toLocalTimeString` are identical under different names; `formatTitle` recomputes the `day === 0 ? 6 : day - 1` week-boundary math already encoded in `getWeekRange`, risking a mislabeled week vs the fetched range.
- **Fix:** Add `dateToTimeString` to `apps/calendar/src/components/time-select.ts` and import in both dialogs. Derive the toolbar week label from `getWeekRange(currentDate)`.

---

### Calendar share editor ↔ Drive ACL share editor

*(See "Contact-input state machine" above — the auditor finding "Calendar share editor duplicates the Drive ACL share-editor's contact/team add logic" (`calendar-share-editor.tsx` ↔ `drive-access-list-edit.tsx`) is the same cluster and is merged there.)*

---

### Drive "New" menu, access list, and download

**`apps/drive` `DriveNewMenu` hand-rolls the shared registry-driven "New" menu**
- **Severity:** high · **Effort:** moderate
- **Files:** `apps/drive/src/components/drive/drive-new-menu.tsx:65`, `packages/ui/src/components/layout/drive/drive-list.tsx:29`
- **Problem:** `drive-list.tsx` defines the canonical create-menu model: `CREATE_MENU_DEFS` derives folder + every `EigenDocType` + upload from `EIGEN_DOC_TYPE_INFO` + `EIGEN_DOC_ICONS`, and `getCreateMenuItems()` renders a Plus dropdown that hides absent callbacks and collapses to one button. `DriveNewMenu` re-implements the same dropdown by hand (hardcoded "New folder", manual icon/label iteration, "Upload file"), duplicating the registry mapping and per-type wiring. Adding a doc type now needs edits in two places; the menus diverge (drive-new-menu has no single-item collapse, no context-menu variant). The create dialogs (`DriveCreateFolder`/`DriveCreateEigenDoc`/`DriveUploadFiles`) are also copy-pasted across `DriveNewMenu`, `DriveLayout:309`, and app-shell `PaletteRunnerInner`.
- **Fix:** Lift `getCreateMenuItems` + `CREATE_MENU_DEFS` into a shared `drive/create-menu.ts` and expose one `<DriveNewMenu>`/`<NewItemButton>` taking the create callbacks. Drive's sidebar button, `DriveListToolbar`, and `EigenDocNewButton` all consume it.

**"General access" block duplicated between `DriveAccessList` and `DriveAccessListEdit`**
- **Severity:** medium · **Effort:** moderate
- **Files:** `packages/ui/src/components/layout/drive/drive-access-list.tsx:71`, `packages/ui/src/components/layout/drive/drive-access-list-edit.tsx:303`
- **Problem:** Both render the same "General access" section (`AvatarIcon` + Lock/Unlock toggle + the verbatim "Restricted"/"Unrestricted"/"Only people with access"/"Any authenticated user…" strings). The visibility→label/description mapping is hand-duplicated with subtly different wording (the list appends "…can edit/can view", the edit view doesn't). Both render for the same file via `DriveAccessDialog`, so the inconsistency is user-visible.
- **Fix:** Extract `<GeneralAccessRow path visibility editable onChange?>` in `drive/` owning the icon + label + description (and the can-edit/can-view select when editable). Both views render it.

**Anchor-click file-download idiom hand-rolled in 8 places**
- **Severity:** medium · **Effort:** moderate
- **Files:** `packages/lib/src/core/drive/hooks/use-export-document.ts:22`, `packages/ui/src/components/layout/drive/drive-layout.tsx:130`, `packages/ui/src/components/layout/drive/file-preview.tsx:75`, `packages/ui/src/components/layout/chat/chat-message-list.tsx:256`, `apps/mail/src/components/mail/read-attachments.tsx:41`, `apps/drive/src/components/editor/native-file-editor.tsx:44`, `apps/drive/src/components/editor/markdown-editor.tsx:136`, `apps/drive/src/components/editor/code-editor.tsx:247`
- **Problem:** Verified 8 sites. The `document.createElement('a')` → set `href`/`download` → `click()` → remove idiom is reimplemented across lib, ui, and three apps in two flavors (URL vs Blob). Copies are inconsistent: some `appendChild`/`removeChild`, some don't; `read-attachments` and `chat-message-list` never `URL.revokeObjectURL`, leaking object URLs.
- **Fix:** Add `downloadUrl(url, filename?)` and `downloadBlob(blob, filename)` (the latter creating + revoking the object URL) to `packages/lib` (e.g. `core/drive/download.ts`). Replace all 8 call sites. *(Supersedes the narrower drive-only report.)*

---

### Chat & drive query hooks (`packages/lib/src/core/`)

**`useChats`/`useTeamsHaveChats` re-implement the canonical `useMimeContent` hook**
- **Severity:** high · **Effort:** quick-win
- **Files:** `packages/lib/src/core/chat/hooks/use-chat.ts:25` and `:37`, `packages/lib/src/core/drive/hooks/use-drive.ts:132`
- **Problem:** Verified — `useChats` is a hand-rolled copy of `useMimeContent` (same `driveKeys.mime` key, same `driveApi({ownerId}).mime(...).get()`, same `DrivePath[]`) but **strictly worse**: it swallows errors (`return response.data || []` with no `throw new AppError`, so a failed fetch silently shows an empty chat list) and uses `staleTime: 60_000` instead of the canonical 5 minutes. `useTeamsHaveChats` inlines the same config a third time inside `useQueries`.
- **Fix:** `useChats(ownerId)` becomes `return useMimeContent(ownerId, EIGEN_DOC_TYPE_INFO.chat.urlSlug)`. For `useTeamsHaveChats`, reuse the same `{queryKey, queryFn, staleTime}` config so `useQueries` matches Drive behaviour (restores the AppError throw + 5-min staleTime).

**`mail-search` and `file-search` palette providers are near-identical copies**
- **Severity:** medium · **Effort:** moderate
- **Files:** `packages/lib/src/core/command-palette/providers/mail-search.ts`, `packages/lib/src/core/command-palette/providers/file-search.ts`
- **Problem:** Verified structurally identical: both declare a private `*_SEARCH_DEBOUNCE_MS = 150`, run `useDebouncedValue` + `parseQuery`, compute `scopeBlocks`, call `useSearch({ ..., limit: 6, enabled: !scopeBlocks && parsed.q.length > 0 })`, and end with the same three `willSearch`/`isDebouncing`/`isPending` lines. Differences: `sources`, which scopes block, mail-only `from`/`to`, and the per-kind result mapping. The design anticipates event/chat providers, so this grows linearly.
- **Fix:** Extract `useSearchProvider` in the same folder owning the debounce constant, `parseQuery`, `scopeBlocks` predicate (parametrised by blocking scopes), the `useSearch` call, and the `isPending` math. Both providers supply only `sources`, the blocking set, `from`/`to` passthrough, and a `mapResult` callback.

**`useCreateFolder` and `useCreateFolderItem` are two near-identical create-folder mutations**
- **Severity:** low · **Effort:** moderate
- **Files:** `packages/lib/src/core/drive/hooks/use-drive.ts:200` and `:213`
- **Problem:** Both POST a folder and `invalidateItemCreated` on success, differing only in whether `ownerId`/`mountId` are bound at hook-call time vs passed per-mutation. The `mutationFn` body is otherwise identical.
- **Fix:** Keep the per-variables `useCreateFolderItem` (the flexible superset); make the bound variant a thin wrapper closing over `ownerId`/`mountId`, or converge both call sites on the one hook.

**`useImportDocument`/`useImportFromDrive` duplicate body, and the docx/xlsx import handler block is duplicated between docs and sheets toolbars**
- **Severity:** medium · **Effort:** moderate
- **Files (hooks):** `packages/lib/src/core/drive/hooks/use-import-document.ts:6` and `:22`; **(consumers):** `apps/docs/src/components/docs/editor-toolbar.tsx:105`, `apps/sheets/src/components/sheets/toolbar.tsx:18`
- **Problem:** Two layers of the same import flow. In lib, both hooks share `fetch(url, {credentials:'include'})` → `if (!res.ok) throw` → `return { success: true }` plus the identical `onSuccess` invalidation + `onError: onMutationError`, differing only in URL/method. In the toolbars, both files declare `useImportDocument` + `useImportFromDrive`, the `importPickerOpen` state, and line-for-line-identical `handleImport`/`handleImportFromDrive`/`handleImportFromDevice` handlers + `DrivePickerWithUpload`; only the MIME constant/label differ.
- **Fix:** Extract a `<DocumentImportButton path mime accept label>` (or `useDocumentImport(path, { mime, accept })`) in `packages/ui/src/components/layout/toolbar/` owning the picker state, mutations, handlers, and picker. Within lib, share the `onSuccess` invalidation closure (or fold the JSON-vs-file distinction into one hook).

**Byte-identical mail invalidation helpers (read vs flag)**
- **Severity:** low · **Effort:** quick-win
- **Files:** `packages/lib/src/core/mail/hooks/use-emails.ts:206` and `:216`
- **Problem:** `invalidateMailReadChanged` and `invalidateMailFlagsChanged` have identical signatures and bodies (both invalidate `emailKeys.detail` + `emailKeys.list`). Two names for one behavior invite drift.
- **Fix:** Collapse to one helper (e.g. `invalidateMailMessage(queryClient, ownerId, messageId, mailbox)`); point the read + flag mutations and the SSE handler at it.

---

### Mail / contacts app handlers

**Mail action handlers duplicate the same fetch-mutate-navigate block 7×**
- **Severity:** medium · **Effort:** moderate
- **Files:** `apps/mail/src/components/mail/hooks/use-mail-actions.ts:120`
- **Problem:** `handleArchiveEmailById`/`…ByIds`, `handleReportSpamById`/`…ByIds`, and `handleMoveEmailToFolderById`/`…ByIds` are near-identical: fetch via `getEmailById`, then `handleMoveEmail`/`Promise.allSettled(moveMail.mutateAsync)` + `navigateToList`. Archive vs ReportSpam differ only by the literal mailbox; single vs plural by one-vs-array.
- **Fix:** Collapse to `moveOneById(id, mailbox)` and `moveManyByIds(ids, mailbox)` doing fetch+mutate+navigate once; define the rest as one-line wrappers (the plural helper serves the singular via `[id]`).

**Contact label add/toggle logic reimplemented in 3 places**
- **Severity:** medium · **Effort:** moderate
- **Files:** `apps/contacts/src/routes/__root.tsx:29`, `apps/contacts/src/routes/_auth.$filterType.$filterId.tsx:156` (+ `LabelAssignSubMenu` wiring)
- **Problem:** "Add `labelId` if absent" / "toggle `labelId` across a selection" is hand-written 3×, each spreading `c.labels || []`, checking `includes()`, and calling `updateContactMutation.mutateAsync({...c, labels})`. Per AGENTS.md, logic two+ places need belongs in a lib hook; `packages/lib/src/core/contacts/hooks/` has none for this.
- **Fix:** Add `useToggleContactLabel`/`assignLabelToContacts(contacts, labelId)` to `packages/lib/src/core/contacts/hooks/use-labels.ts`, performing add/remove via `Promise.allSettled` with `onMutationError`. Call from both `__root` and the route.

**Smaller mail/contact duplications**
- **Severity:** low · **Effort:** quick-win
- **Recipient-extraction (`toShort`/`toAddress`/`recipientsAll`)** — `apps/api/src/lib/mail/mail-parse.ts:17` and `apps/api/src/lib/mail/maildir.ts:342` derive these line-for-line from to/cc twice (used for both display and FTS); extract `deriveRecipients(to, cc)` in `mailutils.ts`.
- **`text/calendar` attachment predicate** — `apps/mail/src/components/mail/read-attachments.tsx:26`, `email-detail.tsx:291`, `hooks/use-draft.ts:219` inline `att.contentType.startsWith('text/calendar')`; add `isCalendarAttachment(att)` next to the `Attachment` type in `packages/lib/src/types/mail.ts`.
- **new/edit contact payload** — `apps/contacts/src/routes/_auth.new.tsx:16` and `_auth.edit.$filterType.$filterId.tsx:48` build the same `contactData` from `ContactFormValues`; extract `formValuesToContact(data)` next to `ContactFormValues` in `contact-edit.tsx`.
- **Near-duplicate `Contact` literals** — `apps/api/src/lib/contacts/contacts.ts:90` and `:325` repeat the 8 empty-default fields; extract `EMPTY_CONTACT_FIELDS` or `buildContact(...)`.

---

### Admin list views & routes (`apps/admin`)

**Guests and Orphans routes are the same file with two strings changed**
- **Severity:** medium · **Effort:** moderate
- **Files:** `apps/admin/src/routes/_auth.guests.tsx`, `apps/admin/src/routes/_auth.orphans.tsx`
- **Problem:** Line-for-line identical except `useAdminUsers('guest')` vs `('orphan')`, the nav target, and three label strings — ~75 lines duplicated (validateSearch, ColumnLayout, handleDelete, list/detail wiring).
- **Fix:** Extract `AdminUserManagementView` (in `apps/admin`) parametrised by `{ kind, basePath, searchPlaceholder, emptyMessage }`; both routes render it.

**`AdminUserList` and `MembersList` are near-duplicate list components**
- **Severity:** medium · **Effort:** moderate
- **Files:** `apps/admin/src/components/admin/admin-user-list.tsx:42`, `apps/admin/src/components/admin/members-list.tsx:65`
- **Problem:** Both `useMemo`-sort `[...items].sort((a,b)=>a.name.localeCompare(b.name))` + case-insensitive name/email filter, render an `EmptyState` then an `AlphabeticalList` grouped by first letter wrapping `<UserItem name email label={<Badge>role</Badge>}/>`. `MembersList` adds selection/drag, but the sort+filter+render skeleton is copy-pasted; `add-member-dialog.tsx:18` is a third copy of the sort+filter.
- **Fix:** Extract `filterUsersByQuery(items, query)` in `packages/lib`; consider a shared `AlphabeticalUserList` in `packages/ui` taking items + active id + optional selection handlers.

**Chat "create chat" flow duplicated between sidebar and index route**
- **Severity:** low · **Effort:** quick-win
- **Files:** `apps/chat/src/components/chat/chat-sidebar.tsx:96`/`:160`, `apps/chat/src/routes/_auth.index.tsx:31`/`:54`
- **Problem:** Both define an identical `handleAfterCreate(newPath)` navigating to `/$ownerId/$mountId/$chatId`, manage `createChatOpen`, and render the same `<DriveCreateEigenDoc type="chat" .../>`.
- **Fix:** Extract `useCreateChat()` or `<CreateChatDialog>` (in `apps/chat`) owning open state + after-create navigation; use from both buttons.

---

### Properties panels & misc UI

**Properties-panel title header hand-rolled in 4 places**
- **Severity:** low · **Effort:** quick-win
- **Files:** `apps/docs/src/components/docs/table-properties-panel.tsx:13`, `figure-properties-panel.tsx:37`, `apps/slides/src/components/slides/slide-properties-panel.tsx:85` and `:618`
- **Problem:** The header `<div className="px-3 py-2 border-b"><span className="text-sm font-medium">{title}</span></div>` is duplicated 4×; the shared `PropertiesPanel` has no title slot.
- **Fix:** Add a `title` prop to `PropertiesPanel` (`packages/ui/src/components/layout/properties-panel.tsx`) (or export `PropertiesPanelHeader`); panels pass `title="Image"/"Table"`.

**`ReferenceAttachmentChip` copies `SimpleAttachmentChip`'s chrome verbatim**
- **Severity:** medium · **Effort:** quick-win
- **Files:** `packages/ui/src/components/layout/attachment/reference-attachment-chip.tsx:20`, `simple-attachment-chip.tsx:28`
- **Problem:** Both duplicate the outer chip class `inline-flex items-center gap-1.5 rounded-md bg-muted text-xs text-foreground border overflow-hidden min-h-10` and a byte-identical remove-`<button>` block. The reference chip forks the chrome only to swap the left content + click target.
- **Fix:** Have `SimpleAttachmentChip` accept a `leading`/`trailing` slot or an `href`/`onClick` variant and render `ReferenceAttachmentChip` through it; at minimum hoist a shared `outerClass` const + `RemoveButton`.

**`UserItem` and `UserName` duplicate the resolved-email + mail-link anchor logic**
- **Severity:** low · **Effort:** quick-win
- **Files:** `packages/ui/src/components/layout/user-item.tsx:49`, `user-name.tsx:22`
- **Problem:** Both repeat `resolvedEmail && (resolvedEmail !== displayName || mailLink)` then `mailLink ? <a href={getMailComposeUrl(resolvedEmail)}>…</a> : resolvedEmail`. The non-obvious suppression rule lives in two places.
- **Fix:** Hoist a small `MailLinkEmail`/`renderEmail(resolvedEmail, displayName, mailLink)` colocated with the user components.

**`LabelFilterHeader` re-implements `LabelManager`'s edit-label flow**
- **Severity:** medium · **Effort:** moderate
- **Files:** `packages/ui/src/components/layout/labels/label-filter-header.tsx:13`, `label-manager.tsx:20`
- **Problem:** `LabelFilterHeader` duplicates `LabelManager`'s edit path (`selectedLabel`/`dialogOpen` state, `handleEditClick`, `handleSubmit` calling `updateLabel`, `handleDeleteLabel`, the `<LabelDialog>`). They diverge on error handling: `LabelManager` uses the documented `catch {}` (hook's `onMutationError` toasts), while `LabelFilterHeader` uses `catch (error) { console.error(...) }` — a CODE-STANDARDS violation.
- **Fix:** Extract `useLabelEditDialog` returning `{ selectedLabel, dialogOpen, openEdit, dialogProps }` colocated with `LabelDialog`; consume from both. Drop the `console.error`.

**`resolve-link.ts` re-derives the shared-with-me URL that `getDriveShareUrl` already builds**
- **Severity:** low · **Effort:** quick-win
- **Files:** `packages/lib/src/core/notification/resolve-link.ts:50`, `packages/lib/src/core/api.ts:188`
- **Problem:** `resolveDriveLink` does `getDriveItemUrl(path) ?? 'shared/with-me?pid=…&uid=…&mid=…'` — exactly what `getDriveShareUrl(path)` already encapsulates. The shared-with-me query string is now hand-built in two FE places.
- **Fix:** In the non-chat branch, return `getDriveShareUrl(path)` instead of re-deriving. Keep the chatName branch.

---

### API XML / storage / config (`apps/api`)

**WebDAV and CalDAV each define their own copy of the DAV XML builders**
- **Severity:** medium · **Effort:** moderate
- **Files:** `apps/api/src/lib/webdav/xml.ts:5`, `apps/api/src/lib/caldav/xml-builder.ts:7`/`:72`
- **Problem:** Verified — `escapeXml` is byte-for-byte identical in both (same 5 `.replace` calls), and `multistatus`/`response`/`propstatOk`/`propstatNotFound` differ only in whitespace and the namespace passed to `multistatus`. The `application/xml; charset=utf-8` content-type is `XML_CONTENT_TYPE` in CalDAV but inlined in WebDAV's `buildXmlResponse`. AGENTS.md states WebDAV "mirrors the CalDAV layer", so this DAV core is meant to be common. (Correctly *not* folded into `core/html.ts` `escapeHtml`, which uses `&#39;`/`&apos;` differently.) *(Three auditor findings collapsed here.)*
- **Fix:** Lift the namespace-agnostic primitives — `escapeXml`, a parametrised `multistatus(responses, { ns })`, `response`, `propstatOk`, `propstatNotFound`, and the content-type — into a shared `apps/api/src/lib/dav/xml.ts` (WebDAV passes `xmlns:D="DAV:"`, CalDAV passes its bundle). CalDAV keeps only its C:/CS:/ICAL: layers.

**`LocalKeyStorage` and `LocalStorage` are near-identical; delete/exists/size triplicated**
- **Severity:** high · **Effort:** moderate
- **Files:** `apps/api/src/lib/storage/local-key-storage.ts`, `apps/api/src/lib/storage/local-storage.ts`, `apps/api/src/lib/storage/s3-storage.ts:118`
- **Problem:** Verified — `LocalKeyStorage` and `LocalStorage` are identical except the private resolver name (`getFilePath` vs `resolve`); `LocalStorage` just adds `mkdir`/`rename`/`deleteDir`. On top, `delete()` (try → exists → delete → `catch+console.error` → false), `exists()`, and `size()` are reimplemented a third time near-verbatim in `S3Storage`. Three classes, one set of semantics.
- **Fix:** Collapse the two local backends into one `StorageBackend` (the flat-key variant simply doesn't expose mkdir/rename/deleteDir). Keep `S3Storage` separate but consider a shared `existsThenDelete(file)` free function in `storage/`.

**Path-traversal guard duplicated 3× with an inconsistent error type (security)**
- **Severity:** medium · **Effort:** quick-win
- **Files:** `apps/api/src/lib/storage/local-key-storage.ts:17`, `apps/api/src/lib/storage/local-storage.ts:18`, `apps/api/src/lib/core/local-filesystem.ts:16`
- **Problem:** Verified — the `path.resolve(base, key)` + `if (!resolved.startsWith(base + path.sep) && resolved !== base) throw` block is copy-pasted in three classes. The storage backends throw `ApiError(400, 'Invalid storage path: path traversal detected')` while `LocalFilesystem` throws a bare `new Error('Path traversal blocked: …')` — so the same security check surfaces as a clean 400 from one path and an **unhandled 500** from the other. AGENTS.md mandates `ApiError` and documents path sanitization as a critical rule.
- **Fix:** Extract `resolveWithinBase(baseDir, key): string` in `apps/api/src/lib/core` that throws `ApiError(400)` consistently; all three classes call it.

**Team route inlines the S3 config schema twice instead of reusing `s3ConfigBody`**
- **Severity:** medium · **Effort:** quick-win
- **Files:** `apps/api/src/routes/team.ts:89` and `:116`, `apps/api/src/routes/shared-schemas.ts:32`
- **Problem:** Verified — `shared-schemas.ts` exports the canonical `s3ConfigBody` (used by `settings.ts`/`setup.ts`), but `team.ts` hand-rolls the same six-field object inline in POST and PUT mount handlers. The inline copies **drift**: they drop the `{ minLength: 1 }` validators and make `prefix` required, so team mounts accept empty credentials the admin S3 config rejects. *(Two auditor findings, same cluster.)*
- **Fix:** Import `s3ConfigBody` into `team.ts`; replace both inline objects with `s3Config: t.Optional(s3ConfigBody)`.

**Identical hast→HTML converter duplicated between export render and text preview**
- **Severity:** medium · **Effort:** quick-win
- **Files:** `apps/api/src/lib/export/doc/render.ts:30`, `apps/api/src/lib/preview/text-preview.ts:107`
- **Problem:** The `HastNode` type + lowlight-AST→HTML walker are defined twice byte-for-byte (`hastToHtml` vs `toHtml`). Worse, `text-preview.ts`'s `code` branch reimplements the `createLowlight(common)` → highlight → `<pre><code>` flow that `renderCodeBlockNode` already provides.
- **Fix:** Move `HastNode` + the converter to one place (export from `export/doc/render.ts` or a `lib/shared/hast.ts`) and import in `text-preview.ts`; reuse the shared lowlight-highlight helper for the code mode.

**Eigendoc tiptap render wiring duplicated between export and preview generators**
- **Severity:** medium · **Effort:** moderate
- **Files:** `apps/api/src/lib/export/doc/html.ts:16`, `apps/api/src/lib/preview/eigendoc-preview.ts:12`
- **Problem:** Both independently set up `createLowlight(common)` + `getDocExtensions({ lowlight })` and pass an identical `renderToHTMLString` nodeMapping (`codeBlock`/`taskItem` are character-identical; `figure` differs only in the src resolver + a `{ lazy }` flag). `FigureImgSrcResolver` was created to parametrise this seam but isn't used to unify the callers.
- **Fix:** Extract `renderEigendocBodyHtml(json, { lowlight, extensions }, resolveImgSrc, opts?)` in `export/doc/render.ts`; both callers pass only their figure resolver + slicing.

**Smaller API duplications**
- **Severity:** low/medium · **Effort:** quick-win
- **Unique-filename collision block** — `apps/api/src/lib/drive/drive.ts:279` and `:329` repeat the `getChildByName` → `listFolder` → lowercased `usedNames` Set → `getUniqueFileName` dance verbatim in `uploadFiles` and `createFileFromData`; extract `private Drive.resolveUniqueChildName(mount, parentId, name)`.
- **Four owner-only trash guards** — `apps/api/src/lib/drive/sharedDrive.ts:311-343` copy-paste the membership + `isEffectiveOwnerSync` 403 across `restorePath`/`listTrash`/`permanentlyDelete`/`emptyTrash`; add a `withOwnerOnly<T>` helper next to the existing `with*Permission` wrappers.
- **`S3File`-as-Response-body workaround** — `apps/api/src/lib/drive/drive.ts:492` and `apps/api/src/lib/webdav/resource.ts:87` duplicate `const body = 'bucket' in file ? file.stream() : file` (the Bun 1.3.14 quirk, per MEMORY); extract `storageFileToBody(file)` in `core/http.ts` so the eventual Bun fix is a one-line removal.
- **media-by-name map** — `apps/api/src/lib/document/doc.ts:25` and `apps/api/src/lib/document/slides.ts:90` duplicate the 3-line `getChildByName('media')` → `listFolder` → `new Map(...)`; extract `loadMediaByName(mount, drivePath)`.
- **Sheet style enum tables** — border/alignment number↔string maps are maintained as 3 disconnected hand-written tables across `import/sheets/from-xlsx.ts`, `export/sheets/xlsx.ts`, `export/sheets/html.ts`; define each enum once (`BORDER_STYLES`/`H_ALIGN`/`V_ALIGN`) in a shared `export/sheets/styles.ts` and derive forward/reverse/CSS. Co-locate `EXCEL_EPOCH_MS`/`DAY_MS` (duplicated in from-xlsx.ts + xlsx.ts) there too.
- **iMIP email palette** — `apps/api/src/lib/calendar/imip.ts:31` inlines `#5f6368`/`#1a1a1a` instead of `EMAIL_MUTED`/`EMAIL_TEXT` from `mail-template.ts`; export those + a `renderEmailSection(label, value)` from `mail-template.ts`.
- **Calendar-home PROPFIND body** — `apps/api/src/lib/caldav/caldav-router.ts:49` and `:61` repeat the four-line home-listing body; extract `respondCalendarHome(ownerId, request)`.
- **`saveServerConfig`/`updateServerConfig`** — `apps/api/src/lib/config/server-config.ts:47` are redundant wrappers over `store.set()` (which already deep-merges a `DeepPartial`); keep `updateServerConfig` only.
- **`ManagedDatabase.destruct()`** — identical 3-line method in `calendar.ts:1444`, `contacts.ts:355`, `maildb.ts:225`, `notification-center.ts:49`. *Borderline / acceptable to leave* under the flat-direct philosophy; if touched, drop the redundant `if (this.managedDb)` guard (`close()` already no-ops). Do not build a base-class hierarchy for 3 lines.

---

### Sheet engine (`packages/sheet`)

**Two near-identical formula tokenizers: `functionCopy` vs `functionStrChange`**
- **Severity:** high · **Effort:** large
- **Files:** `packages/sheet/src/engine/formula-shift.ts:108` and `:198` (leaf shifters at `:21`, `:320`)
- **Problem:** Verified — both implement the exact same recursive formula-string walker: same bracket/paren handling, `"`-quote tracking, comma split, `&` handling, `operatorjson` lookahead with the same two-char-operator branch and the same `-`-as-unary-sign heuristic, then a leaf call at end-of-string. They differ *only* in the leaf-shifter (`shiftRef` vs `functionStrChange_range`) and cosmetic naming. The two leaf shifters likewise duplicate the sheet-name split, `detectAbsolute` $-tracking, missing-axis handling, and `formatRange` reassembly. A bug fixed in one walker silently persists in the other.
- **Fix:** Extract `walkFormulaRefs(txt, shiftLeaf: (ref) => string)` parametrised by the leaf callback; `functionCopy` passes `(ref) => shiftRef(...)`, `functionStrChange` passes `(ref) => functionStrChange_range(...)`. Factor the shared ref-parse/reassemble half into a `parseRef`/`formatRef` pair so each leaf shifter owns only its index-math.

**Range-shift-on-insert/delete algorithm duplicated across CF, alternate-format, and filter ranges**
- **Severity:** high · **Effort:** moderate
- **Files:** `packages/sheet/src/engine/rowcol.ts:333`/`:499`, `packages/sheet/src/state/modules/rowcol.ts:76`/`:636`/`:946`
- **Problem:** The identical "shift a `[r1,r2]`/`[c1,c2]` range when rows/cols are inserted/deleted" conditional ladder is hand-copied in ≥3 places × 2 axes × insert/delete (~12 copies), differing only in variable names. Any correctness fix must be applied in 6+ spots.
- **Fix:** Add `shiftRangeForInsert(lo, hi, index, count, direction)` and `shiftRangeForDelete(lo, hi, start, end)` (null = fully removed) in `engine/rowcol.ts`; call for both axes from CF rules, alternateFormatRules, and filterRange. State-side imports from the engine (the seam is already crossed).

**Clipboard / clear-content / row-col-delete handlers duplicated between ContextMenu and EditMenu**
- **Severity:** medium · **Effort:** moderate
- **Files:** `packages/sheet/src/components/ContextMenu/index.tsx:78`/`:470`, `packages/sheet/src/components/MenuBar/edit-menu.tsx:66`/`:98`
- **Problem:** The async paste flow (`sessionStorage` → `navigator.clipboard.readText()` → identical `catch { console.warn('Clipboard access blocked…') }` → `handlePasteByClick`) is copy-pasted verbatim including the warning string. The clear-content branch and delete-row/delete-column branches are likewise near-identical and have **already drifted** (EditMenu uses `<=1`, ContextMenu uses `<=slen` + an extra multi-selection guard).
- **Fix:** Extract `pasteFromClipboard(setContext)` (e.g. in `state/modules/clipboard.ts`) and shared clear-content / delete-row / delete-column handlers parametrised by the alert callback; invoke from both menus.

**Smaller sheet duplications**
- **Severity:** low · **Effort:** quick-win/moderate
- **`rangeText` (merge-aware selection label)** — `FxEditor/NameBox.tsx:9` and `SheetOverlay/index.tsx:324` duplicate the merge-config branch + the copied `biome-ignore` comment; add `getSelectionRangeText(context)` in state (SheetOverlay applies its SR `.replace` on top).
- **Keycode-filter + formula-popup wiring** — `FxEditor/index.tsx:165` and `SheetOverlay/InputBox.tsx:150` carry the same undocumented magic-number keycode guard + `FormulaSearch`/`FormulaHint` wiring; extract `shouldHandleFormulaInput(e)` (or `useFormulaInputOnChange`) next to `useFormulaAutocomplete`.
- **Error-string maps** — `engine/validation.ts:1` (`v:'#VALUE!'` …) and `engine/parser/error.ts:20` (`VALUE:'#VALUE!'` …) hand-maintain the same eight Excel strings across the parser fork seam; point the parser's display values at a shared `ERROR_STRINGS` const. *Low priority* — sits across an intentional vendored-parser boundary.

## 2. UX Consistency

The same interaction is implemented differently across the 12 apps: confirmations, empty states, save buttons, toolbar titles, and provider placement all drift. Most are one-line string edits or a swap to an existing shared component; the canonical pattern almost always already exists and just isn't used everywhere.

### 1. Native `window.confirm` for discard-unsaved-changes instead of the shared `ConfirmDialog`

**Severity:** medium · **Effort:** quick-win
**Files:** `apps/drive/src/components/editor/use-editor-save.ts:73`, `apps/drive/src/components/editor/markdown-editor.tsx:152`, `apps/drive/src/components/editor/code-editor.tsx:263`, `packages/ui/src/components/confirm-dialog.tsx`

**Problem:** `useEditorSave.confirmClose` pops a raw browser `window.confirm('You have unsaved changes. Discard?')` when closing the drive markdown/code editor dirty. Every other confirmation in the product uses the theme-styled `ConfirmDialog`/`DeleteDialog`. This is the only place across the 12 apps with OS chrome, no theming, and a blocked JS thread, and `ConfirmDialog` is the documented canonical generic confirmation (AGENTS.md/LAYOUT.md).

**Fix:** Replace `window.confirm` with `ConfirmDialog`. `confirmClose` is a hook callback, so lift a `showDiscardConfirm` boolean + pending-close ref into `useEditorSave`, render `<ConfirmDialog title="Discard changes?" description="You have unsaved changes. Discard them?" confirmText="Discard">` from the two editor components, and resolve the close on confirm.

### 2. Detail panes expose two competing delete affordances with duplicated copy

**Severity:** medium · **Effort:** moderate
**Files:** `apps/admin/src/components/admin/admin-user-list.tsx:92-140`, `apps/admin/src/components/admin/member-detail.tsx:60-140`, `apps/admin/src/routes/_auth.guests.tsx:62-72`, `apps/admin/src/routes/_auth.orphans.tsx:62-72`

**Problem:** For the same user, the detail screen renders **both** a toolbar `Trash2`→`DeleteDialog` **and** a body `DangerZone` (its own confirm dialog) — two paths to the same delete, with the destructive copy written twice and slightly diverging (`AdminUserDetail` repeats "Permanently delete {name} ({email})… This cannot be undone." in both). `MemberDetail` is worse: confirmed two *different* destructive actions stacked in one pane — the toolbar removes via `useRemoveMember` ("Remove Member", account preserved) while the body `DangerZone` deletes via `useDeleteUser` ("Delete User", deletes account + all data). This is inconsistent with `TeamDetail`/`WaitlistDetailToolbar`, which expose a single delete affordance in the toolbar.

**Fix:** One delete surface per pane. For guests/orphans, drop the body `DangerZone` and keep only the toolbar `Trash2`→`DeleteDialog` (matching `TeamDetail`). For `MemberDetail`, the two actions are genuinely different — keep them distinct but co-locate them (both in the toolbar, or both as `DangerZone` rows) so "remove from org" vs "delete account" aren't split across toolbar and body. Define each delete-copy string once.

### 3. Inconsistent micro-copy for identical states (confirmations, empty states, save buttons)

**Severity:** medium · **Effort:** quick-win

Three findings share one root cause: identical UI states are worded differently per app because the strings live at each call site instead of in one place. Treat as a single copy sweep.

**3a. Empty detail-pane / empty-list copy diverges**
**Files:** `apps/mail/src/routes/_auth.$filterType.$filterId.tsx:238`, `apps/contacts/src/routes/_auth.$filterType.$filterId.tsx:121,183`, `apps/admin/src/routes/_auth.members.tsx:72`, `apps/admin/src/routes/_auth.guests.tsx:71`, `apps/admin/src/routes/_auth.orphans.tsx:71`, `apps/admin/src/routes/_auth.teams.tsx:39`, `apps/admin/src/routes/_auth.waitlist.tsx:143`, `apps/chat/src/routes/_auth.index.tsx:65`, `apps/contacts/src/components/contacts/contacts-list.tsx:155`, `apps/contacts/src/components/contacts/team-member-list.tsx:31`, `apps/mail/src/components/mail/email-list.tsx:177`
The "nothing selected" `EmptyState` reads "Select an email/contact/member/user to view details", "Select a team from the sidebar to view details", and chat's odd-one-out "Select a chat from the sidebar" (no "to view details"). Empty-list copy splits on trailing punctuation: "No contacts found." / "No emails found." (period) vs "No members found" / "No chats yet" (none).

**3b. Delete-confirmation copy reads awkwardly with the appended item name**
**Files:** `apps/mail/src/routes/_auth.$filterType.$filterId.tsx:169-178`, `apps/contacts/src/routes/_auth.$filterType.$filterId.tsx:193-204`, `packages/ui/src/components/layout/delete/delete-dialog.tsx`
`DeleteDialog` appends `<strong>{itemName}</strong>` to the end of `description`. Mail passes "…permanently delete this email" + subject → "…delete this email Re: Lunch" (the subject dangles); neither dialog ends with a `?` or `.`.

**3c. Save-button label and ellipsis style differ**
**Files:** `apps/calendar/src/components/calendar-config-dialog.tsx:194`, `apps/contacts/src/components/contacts/contact-edit.tsx:650`, `apps/admin/src/components/admin/guest-settings.tsx:97`, `apps/admin/src/components/admin/member-detail.tsx:124`, `apps/space/src/components/space/profile-editor.tsx:210`, `apps/space/src/components/space/signature-section.tsx:61`, `packages/ui/src/components/layout/cards/add-card-dialog.tsx:99`
Idle label is variously "Save", "Save Changes" (title-case), and "Save changes" (sentence-case); busy label is "Saving..." (ASCII) everywhere except `add-card-dialog.tsx`/`mount-form.tsx`, which use "Saving…" (Unicode ellipsis).

**Fix:** One sweep, three rules. Empty detail pane → "Select a `<noun>` to view details" for every app (fix chat, drop "from the sidebar"). Empty list → no trailing period (the majority): "No `<nouns>` found". Delete confirmation → standardize on "Are you sure you want to permanently delete" with `itemName` carrying the subject/name, and have `DeleteDialog` append the trailing "?" so phrasing can't dangle. Save buttons → bare "Save" idle (dialog title already names the target) and one ellipsis character. Most are call-site string edits; the only shared-component touch is `DeleteDialog` appending punctuation.

### 4. Toolbar title rendered as a hardcoded raw span in 7+ routes

**Severity:** low · **Effort:** quick-win
**Files:** `apps/space/src/routes/_auth.user.tsx:15`, `apps/space/src/routes/_auth.services.tsx:141`, `apps/space/src/routes/_auth.security.2fa.tsx:88`, `apps/space/src/routes/_auth.security.password.tsx:28`, `apps/space/src/routes/_auth.data.tsx:15`, `apps/space/src/routes/_auth.email.tsx:15`, `apps/drive/src/routes/_auth.trash.tsx:33`

**Problem:** The Column `toolbar` prop is fed a hand-written `<span className="text-sm text-foreground font-normal">Title</span>` in 7+ routes. AGENTS.md says a plain toolbar title should match `BreadcrumbPage` styling (`text-sm text-foreground font-normal`), but the class string is copy-pasted per route, so it drifts the moment the convention changes or someone fat-fingers it. Other apps already use varied strings (e.g. `text-sm font-medium truncate`). No `ToolbarTitle` component exists today (confirmed: `packages/ui/src/components/layout/toolbar/` has no such file).

**Fix:** Add a `ToolbarTitle` component in `packages/ui/src/components/layout/toolbar/` that renders `<span className="text-sm text-foreground font-normal truncate">{children}</span>`, export it from the toolbar `index.ts`, and use it everywhere a Column needs a simple text title. One place owns the canonical breadcrumb-matching style.

### 5. `MediaResolverProvider` mounted at inconsistent layers across the four editors

**Severity:** low · **Effort:** quick-win
**Files:** `apps/sheets/src/routes/_auth.sheet.$ownerId.$mountId.$pathId.tsx:59`, `apps/docs/src/components/docs/editor.tsx:143`, `apps/slides/src/components/slides/editor.tsx:111`, `apps/stickies/src/components/stickies/board.tsx:234`

**Problem:** The same provider, with the same props (`ownerId`, `mountId`, `mediaFolderId`, `chatFolderId`), is mounted in two different layers: sheets wraps it in the **route file** around `<SheetEditor>`, while docs/slides/stickies wrap it **inside** their editor component. There's no functional reason for the split; it makes the editor boundary ambiguous (does the editor own its media context?) and forces a reader to check each app. Slides even introduces a `SlideEditor`→`SlideEditorInner` split purely to host the provider (confirmed at `editor.tsx:101`/`:130`).

**Fix:** Pick one layer for all four — inside each editor component is the natural home — and move sheets to match. This drops the sheet route's `MediaResolverProvider` wrapper and removes the `SlideEditor`/`SlideEditorInner` indirection.

### 6. `EmailListToolbar` renders a bare `SearchBar` without the shared `Toolbar` wrapper

**Severity:** low · **Effort:** quick-win
**Files:** `apps/mail/src/components/mail/email-list.tsx:19-29`, `apps/contacts/src/components/contacts/contacts-list.tsx:34-56`

**Problem:** `ContactsListToolbar` (and the mail detail/draft toolbars) wrap their content in the shared `<Toolbar>`, which adds the flex layout and the `no-print` class. `EmailListToolbar` returns a bare `<SearchBar>` with no `<Toolbar>` (confirmed). Besides the structural inconsistency, the missing `no-print` means the mail-list search bar isn't stripped when printing, unlike every other toolbar.

**Fix:** Wrap `EmailListToolbar`'s `SearchBar` in `<Toolbar>` to match `ContactsListToolbar` and pick up `no-print`.

### 7. Setup wizard hand-rolls the username `@domain` addon instead of `InputGroup`

**Severity:** low · **Effort:** quick-win
**Files:** `apps/admin/src/components/admin/setup-wizard.tsx:224-238`, `apps/admin/src/components/admin/create-user-dialog.tsx:67-77`, `apps/space/src/routes/signup.tsx:108-118`

**Problem:** The setup wizard builds the username-with-domain-suffix field from raw markup (`<div className="flex"><Input className="rounded-r-none"/><span className="…rounded-r-md border…bg-muted…">@{domain}</span></div>`). The identical UI in `create-user-dialog.tsx` and `signup.tsx` uses the shared `InputGroup`/`InputGroupAddon`/`InputGroupText` primitives (confirmed present at `packages/ui/src/components/input-group.tsx`). Same interaction, two implementations.

**Fix:** Swap the wizard's hand-built field for `InputGroup` + `InputGroupAddon align="inline-end"` + `InputGroupText` so all three `@domain` username fields render identically.

### 8. Event "when" string formatted two different ways (invite email vs detail dialog)

**Severity:** low · **Effort:** moderate
**Files:** `apps/calendar/src/components/event-detail-dialog.tsx:46-70`, `packages/lib/src/core/date.ts:59`

**Problem:** `packages/lib/src/core/date.ts` exports `formatEventWhen(start, end, allDay, timezone)`, the canonical human-readable event date/time renderer used by the iMIP invite composer. The calendar UI reimplements the concept inline via local `formatFullDate` + `formatTimeRange`, and the two diverge: the shared one is timezone-aware and uses `en-GB` with `·`/`–` separators; the dialog one uses `'en'`, hard-codes `timeZone: 'UTC'`, and rolls its own all-day/same-day branching. The same event reads differently in the invite email vs the detail dialog. (Note: severity is low, not medium — this is a single-component duplication, not a cross-app spread, though it does cause a user-visible mismatch.)

**Fix:** Use the shared `formatEventWhen` from `@workspace/lib/date` in `event-detail-dialog.tsx` and delete the local helpers. If the dialog needs a different layout, add an option to `formatEventWhen` rather than maintaining a second formatter.

### 9. Two ways to raise the same "OK" notice (`useAlert` wrapper vs raw `showDialog`)

**Severity:** low · **Effort:** quick-win
**Files:** `packages/sheet/src/components/ContextMenu/index.tsx:46`, `packages/sheet/src/hooks/useAlert.tsx`, `packages/sheet/src/hooks/useDialog.tsx`

**Problem:** Sheet-internal. `useAlert().showAlert(msg, 'ok')` is a one-line passthrough to `useDialog().showDialog(msg, 'ok')`. `ContextMenu/index.tsx` imports **both** hooks and uses `showAlert(…, 'ok')` in some branches and `showDialog(…)` in others within the same component. The `useAlert` indirection adds no behavior (confirmed ~6 callers in `packages/sheet/src`).

**Fix:** Pick one entry point. Simplest: inline `useAlert` into its callers and standardize on `showDialog`. At minimum, `ContextMenu` should import one hook, not both.

### 10. Rename dialog reuses the create dialog and shows a misleading "Location" breadcrumb

**Severity:** low · **Effort:** moderate
**Files:** `packages/ui/src/components/layout/drive/drive-rename-item.tsx:67-78`, `packages/ui/src/components/layout/drive/drive-create-folder-item.tsx:33,76-81`

**Problem:** Drive-internal. `DriveRenameItem` renders `DriveCreateItemDialog`, which always calls `useBreadcrumb` and renders a "Location" section. During a rename the location is fixed and irrelevant, so the dialog shows a confusing "Location: Drive > …" line and fires a needless breadcrumb query. The file/export names also mismatch: file `drive-create-folder-item.tsx`, export `DriveCreateItemDialog`, used for both create-folder and rename — while the new flat create flow uses the richer `DriveLocationPicker`, so two create-name dialog styles coexist in one folder.

**Fix:** Give `DriveCreateItemDialog` a flag to hide the Location block (and skip `useBreadcrumb`) when used for rename, or drop rename onto a plain name-input pattern without the location section. At minimum, rename the file to match its `DriveCreateItemDialog` export.

## 3. Convention Violations

The codebase has strong, explicitly documented conventions (`docs/CODE-STANDARDS.md`, `AGENTS.md`), and most violations are local drift from a pattern the same domain already follows correctly elsewhere. The recurring offenders: `as Type` casts on Eden Treaty responses, hand-rolled date formatting, redefined shared types, and inline `invalidateQueries` calls that bypass the mandated `invalidate*()` helpers. Nearly every entry below is a mechanical fix that converges onto an existing canonical site.

---

### Type-chain violations (`as` casts, redefined types)

These break the end-to-end type flow that `CODE-STANDARDS.md § Typing` and `AGENTS.md` ("Don't break the type chain") exist to protect.

**1. `as Type` casts on Eden Treaty responses**
**Severity** medium · **Effort** quick-win
**Files** `packages/lib/src/core/calendar/hooks/use-calendar.ts:173`, `packages/ui/src/components/layout/chat/chat-message-list.tsx:118`, `packages/lib/src/core/notification/hooks/use-notifications.ts:13`
**Problem** `CODE-STANDARDS.md § Typing` forbids `as Type` casts on Eden responses — the fix is an explicit return type at the route handler, not a cast in a hook/component. Three sites violate this:
- `useCalendarAccess` annotates its `queryFn` with a hand-written `Array<{ targetId: string; permission: string }>` and forces it onto the response with `return response.data as {...}`. The route (`apps/api/src/routes/calendar.ts:246`) actually returns `shares: CalendarShare[]`, and the inline type is *looser* than canonical (`permission: string` vs the `'free-busy' | 'read' | 'write'` union), silently broadening the chain.
- `chat-message-list.tsx` does `(contacts as Contact[]).find(...)` on data `useContacts()` already types as `Contact[]`.
- `parseNotification` launders a well-typed `Notification[]` through `Record<string, unknown>` and re-asserts `as Notification`, re-reviving `createdAt` even though Eden's reviver already returns a `Date` (see memory: Eden auto-parses ISO dates).

**Fix** Add explicit return types to the route handlers using the shared types (`apps/api/src/routes/calendar.ts` access handler `: { ownerUserId: string; shares: CalendarShare[] }`), then drop all three casts. `useNotifications` should return `response.data ?? []` directly and delete `parseNotification`.

**2. Shared types redefined/hand-spelled instead of imported or derived**
**Severity** low–medium · **Effort** quick-win (one moderate)
**Files** `apps/api/src/lib/chat/schema.ts:9`, `packages/lib/src/types/waitlist.ts:1`, `apps/api/src/lib/home/home.ts:218`, `apps/api/src/lib/home/guest-home.ts:23`, `apps/api/src/routes/drive.ts:101`, `apps/api/src/routes/shared-schemas.ts:11`
**Problem** `CODE-STANDARDS.md § Typing` ("never redefine a type that already exists … import it"; "Drizzle `.$inferSelect` for DB row types") is violated several times:
- `messages` schema re-states the `ChatMessageType` union inline as `.$type<'message' | 'emote' | 'whisper' | 'system'>()` — the file already imports `ChatAttachment` from `@workspace/lib/types/chat`, so the union is one identifier away.
- `WaitlistEntry` hand-declares every `waitlist` column instead of `$inferSelect`, has *drifted* (omits `updatedAt`/`inviteToken` even though `listWaitlist` does `select()`), and types every date as `string | Date` — violating the project-wide `Date` wire convention (memory: dates flow as `Date` via Eden's reviver) and forcing a redundant `new Date(entry.inviteExpiresAt)` re-wrap in `apps/admin/src/routes/_auth.waitlist.tsx:234`.
- `Home.size()` and `GuestHome.size()` both return the `HomeSizeResponse` shape (`packages/lib/src/types/settings.ts:96`) as an unannotated literal — a third hand-maintained copy.
- `EIGEN_DOC_TYPES` (`packages/lib/src/types/drive.ts:40`) is re-spelled as `t.Union([t.Literal('doc'), …])` in `drive.ts:101` and `shared-schemas.ts:11`; `drive.ts` even comments that it "mirrors EIGEN_DOC_TYPES" — a knowingly-maintained hand-copy, the exact drift `AGENTS.md` Common Pitfalls warns about.

**Fix** Import `ChatMessageType` and use `.$type<ChatMessageType>()`; derive `WaitlistEntry` from `typeof waitlist.$inferSelect` and tighten dates to `Date`/`Date | null`; annotate both `size()` methods `: Promise<HomeSizeResponse>`; export an `eigenDocTypeUnion = t.Union(EIGEN_DOC_TYPES.map((v) => t.Literal(v)))` helper next to `EIGEN_DOC_TYPES` and reuse it in both schemas.

**3. `EigenDocType` re-exported through the drive UI barrel**
**Severity** low · **Effort** quick-win
**Files** `packages/ui/src/components/layout/drive/eigendoc-config.ts:4`, `packages/ui/src/components/layout/drive/index.ts:11`
**Problem** `eigendoc-config.ts` does `export type { EigenDocType } from '@workspace/lib/types/drive'`, and `index.ts` does `export * from './eigendoc-config'`, so the canonical lib type becomes importable from a UI path. Violates the "no type re-exports through barrels" rule (memory + `AGENTS.md` typing) — domain barrels export values, shared types come straight from `packages/lib/src/types/<domain>`.
**Fix** Delete the `export type { EigenDocType }` line (it already imports the type for local use); consumers import from `@workspace/lib/types/drive`.

---

### Error-handling & query-hook conventions

`CODE-STANDARDS.md § Error Handling` and `§ Query Keys` define one shape for every query/mutation hook; these diverge from siblings in the same file.

**4. Query hooks throw raw/bare errors instead of `AppError`**
**Severity** low–medium · **Effort** quick-win
**Files** `packages/lib/src/core/drive/hooks/use-drive.ts:611`, `packages/lib/src/core/editor/hooks/use-file-content.ts:20`, `packages/lib/src/core/collab/hooks/use-collab.ts:13`
**Problem** The canonical idiom across `lib/core` is `if (response.error) throw new AppError(response)`, which preserves the HTTP status so toasts read e.g. "Not found (404)". Three hooks diverge:
- `useListTrash` does `if (error) throw error`, throwing the raw Eden error object — unlike every other hook in the *same file*.
- `useFileContent` does `throw new Error(String(res.error ?? 'No data'))`, stringifying the error and dropping the status — while its sibling `use-file-save.ts` already uses `AppError`.
- `useCollabDocumentInfo` is the only query hook that swallows `response.error` with `console.error(...)` and returns a fabricated `{ canRead: false, … }` fallback, silently downgrading a real 500 to "no access" → `RequestAccessView`.

**Fix** Replace all three with `if (response.error) throw new AppError(response); return response.data;`. For `useCollabDocumentInfo`, also drop the dead inner `if (!pathId)` branch and `pathId || ''` key fallback (the `enabled` guard already covers it); if degrading-to-no-access is genuinely intended, add a `// Why:` comment since it contradicts every other hook.

**5. Query hooks missing the mandatory explicit `staleTime`**
**Severity** medium · **Effort** quick-win
**Files** `packages/lib/src/core/drive/hooks/use-drive.ts:497,564,606`, `packages/lib/src/core/contacts/hooks/use-contacts.ts:37,103`
**Problem** `CODE-STANDARDS.md § Query Keys` and the self-review checklist require every `useQuery` to set an explicit `staleTime`. `useEffectiveMembers`, `useSharedPaths`, `useListTrash`, `useContact`, and `useMeContact` omit it, inheriting the global `0` (always-stale, refetch on every focus/mount). The neighbouring hooks in each file all set explicit values, so these are the lone outliers.
**Fix** Add `staleTime` matching the file idiom — `1000 * 60 * 5` for the drive path/permission family; `5 * 60 * 1000` for the contacts hooks (matching `useContacts`/`useLabels`).

**6. Inline `invalidateQueries` bypasses the mandated `invalidate*()` helpers**
**Severity** medium · **Effort** quick-win
**Files** `packages/lib/src/core/chat/hooks/use-chat.ts:90,140,155`, `packages/lib/src/core/chat/hooks/use-comments.ts:37`, `packages/lib/src/core/admin/hooks/use-members.ts:57,75,92,143`, `packages/lib/src/core/admin/hooks/use-teams.ts:49,68,125`
**Problem** `CODE-STANDARDS.md § Invalidation Functions` + `AGENTS.md` mandate that `invalidateQueries()` lives only inside exported `invalidate*()` helpers. Almost every domain complies, but: (1) `use-chat.ts` *exports* `invalidateMessages()` (line 162) yet `usePostMessage`/`useEditMessage`/`useDeleteMessage` re-inline the same call; (2) `use-comments.ts` exports `invalidateComments()` (line 43) but `useResolveComment` re-inlines it; (3) the admin domain inlines `adminKeys.members(...)`/`adminKeys.teams(...)` across 7 mutation callbacks and exports *no* `invalidateMembers`/`invalidateTeams` (contrast `invalidateAdminUsers`, exported in the same file). Inline copies drift when invalidation targets change.
**Fix** In chat, replace the inline bodies with the already-exported `invalidateMessages()`/`invalidateComments()`. In admin, add exported `invalidateMembers(queryClient, organizationId)` / `invalidateTeams(queryClient, organizationId)` next to the key factory and call them — matching `invalidateAdminUser`'s shape.

**7. `useExportDocument` hand-rolls loading state + try/catch instead of `useMutation`**
**Severity** low · **Effort** moderate
**Files** `packages/lib/src/core/drive/hooks/use-export-document.ts:5`
**Problem** Uses `useState(isExporting)` + a `useCallback` whose `catch` calls `onMutationError(e)` directly. `CODE-STANDARDS.md § Error Handling` puts all error handling in `useMutation`'s `onError`; this is the only direct `onMutationError` call outside a mutation `onError`, and `isExporting` duplicates `mutation.isPending`. `useUploadFile`/`useImportDocument` in the same directory already prove a raw-`fetch` blob flow fits inside `useMutation`.
**Fix** Reimplement as a `useMutation` whose `mutationFn` does the fetch + blob + anchor-download (throw on `!response.ok`), with `onError: onMutationError`; expose `mutate`/`isPending`.

---

### Owner-ID & MIME-slug idioms

**8. Dead `parseOwnerId` null-guards + hand-parsed `team_` prefix**
**Severity** low–medium · **Effort** quick-win
**Files** `apps/api/src/lib/drive/acl.ts:11,30,56,60,76`, `apps/api/src/lib/drive/drive.ts:699`, `apps/api/src/lib/calendar/calendar.ts:1046`
**Problem** Two facets of the same owner-id convention (`AGENTS.md` names `parseOwnerId()` the single canonical resolver):
- `parseOwnerId()` returns a non-nullable `ParsedOwnerId` (worst case `{type:'user', id:''}`, verified in `packages/lib/src/types/owner.ts`), yet `acl.ts` guards it five times as `if (parsed && parsed.type === …)` and `drive.ts:699` uses `parsed?.type`. These are dead defensive checks on typed internal data — exactly the `§ Trust the type system` rule. The same domain already does it right: `acl-propagation.ts:103` and `access-request-propagation.ts:31` write `parseOwnerId(e.id).type === 'user'` with no guard.
- `Calendar.checkPermission` hand-parses a team share with `share.targetId.startsWith('team_')` + `.substring(5)`, duplicating the prefix length `owner.ts` owns — while `get-calendar.ts`/`share-propagation.ts` already use `parseOwnerId`.

**Fix** Drop the truthiness guards (`if (parsed.type === 'team')`, etc.); replace the manual `team_` parse with `parseOwnerId(share.targetId)` and branch on `.type`, matching `get-calendar.ts`.

**9. Chat MIME slug `'application-eigenchat'` hand-typed instead of the registry constant**
**Severity** low · **Effort** quick-win
**Files** `packages/lib/src/core/chat/hooks/use-chat.ts:27,29,43,45`
**Problem** The route-safe slug literal is hardcoded four times for the `driveKeys.mime(...)` key. The canonical source is `EIGEN_DOC_TYPE_INFO.chat.urlSlug` (`packages/lib/src/types/drive.ts:117`). `AGENTS.md` Common Pitfalls: "MIME type strings must match the Eigen File Types table exactly — use the constants, don't type them by hand." The file already imports `DRIVE_MIME_CHAT` from the same module.
**Fix** Replace the four literals with `EIGEN_DOC_TYPE_INFO.chat.urlSlug`.

---

### Reinventing shared utilities & style

**10. Hand-rolled date formatting shadows `@workspace/lib/date` (and uses `en-US`)**
**Severity** medium · **Effort** quick-win
**Files** `apps/contacts/src/components/contacts/contact-detail.tsx:103-124`, `apps/calendar/src/components/event-detail-dialog.tsx:46,65`
**Problem** `CODE-STANDARDS.md § Reinventing existing code` lists "reimplementing date formatting instead of using `@workspace/lib/date`" as a BAD example.
- `contact-detail.tsx` defines a local `formatDate` with `new Intl.DateTimeFormat('en-US', {...})` — duplicating `formatDateWithYear` *and* violating the locale rule (memory: always `'en'`/`'en-GB'`, never `'en-US'`). It's called as `formatDate(new Date(contact.birthday || '').toISOString())` — a pointless string→Date→ISO→Date round-trip. The same file also ships a no-op `formatPhoneNumber` that returns its argument unchanged.
- `event-detail-dialog.tsx` defines local `formatFullDate`/`formatTimeRange` with raw `toLocaleDateString('en', …)`, duplicating the canonical `formatEventWhen(start, end, allDay, timezone)` (`packages/lib/src/core/date.ts:59`) — the same helper the backend iMIP mailer uses. The local copy hardcodes `timeZone: 'UTC'`, so the in-app time string can diverge from the emailed one.

**Fix** In `contact-detail.tsx`, use `formatDateWithYear(contact.birthday)` and render phone numbers directly; delete both local helpers. In `event-detail-dialog.tsx`, delete the local formatters and call `formatEventWhen(event.startTime, event.endTime, event.allDay, event.timezone)`.

**11. JSDoc blocks in `render.ts` violate the no-JSDoc rule**
**Severity** low · **Effort** quick-win
**Files** `apps/api/src/lib/export/doc/render.ts:10-13,52-55,67-71`
**Problem** `CODE-STANDARDS.md § Code Style` states "No JSDoc — code should be self-documenting." Verified: `render.ts` is the *only* file in the entire `apps/api/src/lib` tree carrying `/** … */` blocks; every sibling export/preview module uses plain `//` comments.
**Fix** Convert the three blocks to `//` comments, keeping only the WHY parts (the tiptap-static-renderer `checked` caveat, the side-effect-free lowlight note).

**12. `for...in` loop breaks the `for...of` idiom**
**Severity** low · **Effort** quick-win
**Files** `packages/lib/src/core/comments/hooks/use-card-id-from-chat-name.ts:25-31`
**Problem** `for (const cardId in cards)` is the only `for...in` in all of `packages/lib/src`. The codebase iterates Records via `for...of` over `Object.entries`/keys (memory: prefer `for-of`; `for...in` also walks inherited keys).
**Fix** `for (const [cardId, card] of Object.entries(cards)) { if (card.chatName === chatName) … }`.

**13. `LabelProvider` uses `console.error` stubs instead of throw-on-missing-provider**
**Severity** low · **Effort** quick-win
**Files** `packages/ui/src/components/layout/labels/label-provider.tsx:11-21`
**Problem** `LabelContext` is created with a non-null default whose methods are silent `console.error('LabelProvider not found')` stubs. Every other provider uses `createContext<…|null>(null)` and throws `useX must be used within <XProvider>` (e.g. `preview-provider.tsx`, `upload-provider.tsx`). The stub swallows misuse into a console log + no-op resolved Promise.
**Fix** `createContext<LabelContextType | null>(null)` and throw in `useLabels()` when null. (Lower priority if the provider is removed per the over-engineering findings.)

**14. `useLabels` missing the guest guard its sibling `useContacts` has**
**Severity** medium · **Effort** quick-win
**Files** `packages/lib/src/core/contacts/hooks/use-labels.ts:19`
**Problem** `useContacts` guards with `enabled: !!ownerId && !isGuest` (imports `useIsGuest` specifically), but `useLabels` in the same directory only guards `!!ownerId`. The backend `GET /contacts/:ownerId/labels` calls `requireNonGuest(user)` (`contacts.ts:96`) exactly like the contacts route, so for guests the labels query is guaranteed to fire and 403. The two hooks are consumed together.
**Fix** Import `useIsGuest` and change to `enabled: !!ownerId && !isGuest`, mirroring `useContacts`.

---

### Barrel & schema/migration hygiene

**15. `toolbar/index.ts` omits 3 of its own components, forcing deep imports across 4 apps**
**Severity** low · **Effort** quick-win
**Files** `packages/ui/src/components/layout/toolbar/index.ts`, `apps/docs/src/components/docs/editor-toolbar.tsx:28,30`, `apps/slides/src/components/slides/toolbar.tsx:8,10`, `apps/stickies/src/components/stickies/toolbar.tsx:14,17`, `apps/sheets/src/components/sheets/editor.tsx:21`
**Problem** The barrel re-exports only 5 of 8 components. `document-share-cluster`, `undo-redo-buttons`, and `version-history-menu` are real shared toolbar components but unexported, so docs/slides/stickies/sheets reach in via deep `@workspace/ui/components/layout/toolbar/<file>` paths (`AGENTS.md` Imports: use workspace aliases, not deep paths). This is the file-internal coupling a barrel is meant to hide, inconsistent with how the other components are consumed.
**Fix** Add `export * from './document-share-cluster';` and `export * from './undo-redo-buttons';` (version-history-menu may stay internal — only `file-menu` uses it), then switch the four app imports to the barrel.

**16. Two declared event indexes are never created (schema vs migration drift)**
**Severity** medium · **Effort** quick-win
**Files** `apps/api/src/lib/calendar/schema.ts:54,55`, `apps/api/src/lib/calendar/db-config.ts:55`
**Problem** Verified: `schema.ts` declares `idx_events_uid_calendar` (calendarId, uid) and `idx_events_uid` (uid), but the v1 migration in `db-config.ts` — the only DDL a real DB runs — creates neither (`ManagedDatabase.runMigrations()` executes only `migration.up()` SQL; no Drizzle push). So `getEventsByUid` (inbound iMIP REPLY path) runs `WHERE uid = ?` as a full table scan, and schema/migration disagree about what exists.
**Fix** Add `CREATE INDEX IF NOT EXISTS idx_events_uid_calendar ON events(calendarId, uid);` and `… idx_events_uid ON events(uid);` to the *existing* v1 block (pre-release, amend v1 not v2, per memory's no-migrations rule). Every `schema.ts` index should have a matching migration `CREATE INDEX`.

## 4. Over-Engineering

Four abstractions add a layer the reader must trace through for no behavioral gain. All are single-use indirection or rename-only wrappers that the project's standards explicitly reject ("don't extract single-use helpers"; "no DI/provider scaffolding for a single use case"). Each flattens cleanly with zero behavior change.

### 1. `LabelProvider` — React context wrapping lib hooks the app already imports directly

**Severity:** medium &nbsp;|&nbsp; **Effort:** moderate

**Files:** `packages/ui/src/components/layout/labels/label-provider.tsx`, `apps/contacts/src/main.tsx:32-65`, `packages/lib/src/core/contacts/hooks/use-labels.ts`

**Problem:** `LabelProvider` is a context that re-exposes three lib mutation hooks (`useAddLabel` / `useUpdateLabel` / `useDeleteLabel`) through optional `onAddLabel?` / `onUpdateLabel?` / `onDeleteLabel?` callbacks. The wiring is wrapper-of-a-wrapper: `main.tsx` calls the lib hooks (line 3), re-wraps each in a `useCallback` + `mutateAsync` (lines 39-58), passes them into the provider, which then re-guards each with `if (onAddLabel) { … }` (lines 38-54) before exposing them as a fresh `useLabels()` context. Used by exactly one app. The lib hooks already carry `onMutationError` and only need `useAuth()`, which is available app-wide via `EigenApp`. Tellingly, the same app already consumes the *data-read* `useLabels` hook from `@workspace/lib/contacts` directly in four components (`contact-detail.tsx`, `contacts-sidebar.tsx`, `contact-edit.tsx`, `_auth.$filterType.$filterId.tsx`) — the direct-lib-hook pattern is already the norm here.

**Fix:** Delete `label-provider.tsx` (both `LabelProvider` and the context `useLabels`). Have the two consumers — `LabelManager` and `LabelFilterHeader` in `packages/ui/.../labels/` — import `useAddLabel` / `useUpdateLabel` / `useDeleteLabel` from `@workspace/lib/contacts` directly, matching how the rest of the contacts app already consumes lib hooks. Remove the `InnerApp` callback scaffolding in `apps/contacts/src/main.tsx`.

### 2. `mail.ts` facade — ~14 pure 1:1 pass-throughs where sibling domains call the domain object inline

**Severity:** medium &nbsp;|&nbsp; **Effort:** moderate

**Files:** `apps/api/src/lib/mail/mail.ts` (`mailboxesList`, `mailboxGet`, `mailboxCreate`, `mailboxExists`, `messageGetFile`, `messageDelete`, `messageMove`, `messageCopy`, `messageHandleDraft`, `uploadDraftAttachment`, `messageSend`, `messageSetRead`, `messageSetFlagged`, `messageGetAttachment`)

**Problem:** Most exports are two-line wrappers — `const mail = await getMailClient(user); return await mail.<sameName>(...)` — that mirror `Maildir` method-for-method, doubling the surface to maintain. Sibling personal-data domains avoid this layer: contacts routes call `(await getContacts(user)).getContactById(id)` inline (`routes/contacts.ts`), and calendar routes call `resolveCalendar(user, ownerId)` then `cal.method()`. `IMAP.md` sanctions a "thin facade", but a 1:1 mirror is not thin. The logic-bearing functions are justified and stay.

**Fix:** Keep `getMailClient` plus the functions that add real logic — `mailboxDeliver` (iMIP handling), `messageGet` (404), `messageMoveToSpecial` and its `messageMoveTo{Inbox,Archive,Spam,Trash}` wrappers (flag lookup), `attachFromDrive`, `saveAttachmentsToDrive` (size limits / drive plumbing). Drop the pure mirrors and have mail routes call `(await getMailClient(user)).method(...)` directly, as `routes/contacts.ts` does. Removes ~14 functions with no behavior change.

### 3. Maildir draft-temp helpers — two single-use wrappers and a method that returns a constant

**Severity:** low &nbsp;|&nbsp; **Effort:** quick-win

**Files:** `apps/api/src/lib/mail/maildir.ts:621-633`, `apps/api/src/lib/mail/maildir-store.ts:67-70`

**Problem:** Two issues in the same subsystem. (a) `cleanupDraftTempFile` (`maildir.ts:631`) is a one-line passthrough to `this.store.cleanupDraftTemp(tempId)` with a single caller (line 494); `getDraftTempFile` (`:621`) wraps `store.readDraftTempFile` only to add a 404, one caller (line 455). (b) `getDraftTempDir()` (`maildir-store.ts:67`) is a method whose entire body is `return 'draft-attachments'`, called only internally, while the analogous draft-meta directory is hardcoded inline as the literal `'draft-meta'` in the same class (lines 124, 128, 154). Two sibling directories, two different conventions.

**Fix:** Inline `cleanupDraftTempFile` and `getDraftTempFile` at their single call sites (call `this.store.cleanupDraftTemp(...)` / `readDraftTempFile` directly; throw the 404 inline). Replace `getDraftTempDir()` with a `private readonly DRAFT_TEMP_DIR = 'draft-attachments'` field so both directories are treated the same way.

### 4. `arrayMatch` / `getFormulaRunList` — rename-only pass-throughs to the engine

**Severity:** low–medium &nbsp;|&nbsp; **Effort:** quick-win

**Files:** `packages/sheet/src/state/modules/formulaHelper.ts:167-179`

**Problem:** `arrayMatch` (`:171`) takes five params and forwards all five, unchanged, to `matchDependencies` from `engine/dependency-graph.ts` — even preserving the dead `_formulaCellInfoMap` / `_updateValueObjects` underscore names. `getFormulaRunList` (`:167`) is `return getCalculationOrder(updateValueArray, formulaCellInfoMap)` and nothing else. Each has exactly one caller (`formula-exec.ts:697,720`), which already imports from the engine elsewhere. The wrappers only add a rename layer the reader must trace through to find the real function lives in the engine.

**Fix:** Delete both. Have `formula-exec.ts` import and call `matchDependencies` and `getCalculationOrder` from `engine/dependency-graph.ts` directly. Drop the dead `_formulaCellInfoMap` / `_updateValueObjects` arguments at the call site while you're there.

## 5. Code Smells

Local quality issues found across the frontend packages and the API backend. The two clusters that recur most are **defensive code that contradicts the type system** (sync functions awaited, non-nullable values guarded with `?.`, dead try/catch and dead conditionals) and **copy-pasted blocks that reinvent an existing abstraction** (calendar dialog loading state, contacts array-fields, manual ACL re-resolution). Entries are ranked by severity, then by how widely the pattern spreads.

---

### Correctness-adjacent smells

These compile and lint clean but behave wrong or do redundant work on a hot path.

#### 1. `postMessage` resolves effective members twice per chat message
**Severity** medium · **Effort** moderate
**Files** `apps/api/src/lib/chat/chat.ts:143`, `apps/api/src/lib/chat/chat.ts:162`, `apps/api/src/lib/drive/drive.ts:668`

Every posted non-system message runs `drive.getEffectiveMembers(mountId, pathId)` twice: once inside `notifySharedUsers(event)` (line 143) for the SSE fan-out, and again at line 162 to build the `memberEmails` Set gating mention/activity notifications. `getEffectiveMembers` walks the full breadcrumb ACL chain and runs `resolveACLToEmails` (team expansion + dedupe) — not cheap, and this is the most frequent write in the system.

**Fix** Resolve members once at the top of `postMessage`, derive the lowercased `memberEmails` Set from that array, and thread the resolved list into `notifySharedUsers(event, members?)`. Keep the param optional so the `editMessage`/`deleteMessage` callers still resolve lazily.

#### 2. `uploadWithProgress` silently discards the `headers` a real caller passes
**Severity** medium · **Effort** quick-win
**Files** `packages/ui/src/components/layout/upload-provider/upload-with-progress.tsx:9,18,25`, `packages/ui/src/components/layout/drive/file-upload.tsx:45`

`UploadWithProgressOptions` declares `headers?: Record<string,string>`, but the implementation destructures it to `_headers` and never applies it (the comment explains custom headers are skipped to avoid a CORS preflight). Meanwhile `file-upload.tsx:45` builds a `headers` object — `{ credentials: 'include', ...options.additionalHeaders }` — and passes it, expecting it to be sent. It is silently swallowed, with no type or lint error. The `credentials: 'include'` key is also bogus (that is not a header). Any feature relying on `additionalHeaders` reaching the server is quietly broken.

**Fix** Remove the `headers` field from `UploadWithProgressOptions` so the dead option can't be passed, and delete the `headers` construction at `file-upload.tsx:45` (plus the now-unused `additionalHeaders` plumbing if nothing else consumes it). If per-request auth is genuinely needed later, solve it explicitly (query param or a real server CORS allowance).

#### 3. `Home.size()`/`destruct()` access `_drive` non-optionally, but org homes legitimately have none
**Severity** medium · **Effort** quick-win
**Files** `apps/api/src/lib/home/home.ts:222`, `apps/api/src/lib/home/home.ts:246`, `apps/api/src/lib/home/org-home.ts`

`Home.init()` already guards every subsystem with `?.` (e.g. `this._drive?.init()`, home.ts:98), but `destruct()` builds its subsystem array with bare `this._drive.destruct()` (line 246) and `size()` calls bare `this._drive.size('default')` / `getMountConfig('default')` (lines 222, 225). `OrgHome` — the filesystem-only home — never assigns `_drive`, **and that is by design: orgs do not have a drive.** So the defect is not a missing assignment; it is that `_drive` is declared `_drive!: Drive` and dereferenced non-optionally in exactly the two places a driveless home reaches — its idle-timeout teardown throws a `TypeError` while constructing the array, surviving only on an outer `.catch()`. The optionality is asymmetric: drive is treated as optional everywhere except where it actually matters for a driveless home.

**Fix** Make `_drive` genuinely optional, exactly like `_mail`/`_contacts`: declare it `_drive?: Drive` and mirror `init()` at the call sites — `this._drive?.destruct()` in the subsystem list, and guard `size()` behind a `hasDrive` getter (paralleling the existing `hasCalendar` at home.ts:80) so the drive branch is skipped for org homes. Do **not** give `OrgHome` a drive — orgs don't have one — and don't lean on the outer catch to swallow a predictable per-teardown `TypeError`.

#### 4. `tabContainerRef` is attached to two DOM elements in `SheetTab`
**Severity** medium · **Effort** quick-win
**Files** `packages/sheet/src/components/SheetTab/index.tsx:94`, `packages/sheet/src/components/SheetTab/index.tsx:143`

`tabContainerRef` is set as the ref on both the `#all-sheets` dropdown-trigger button (line 94) and the `#fortune-sheettab-container-c` scroll container (line 143). Both render when `context.allowEdit` is true, so the last commit wins and `tabContainerRef.current` may point at the wrong element. All scroll logic (`scrollBy`, the `scrollWidth - 2 > clientWidth` overflow check, the `onAddSheet` recompute) reads it expecting the tab strip, so overflow/scroll-button geometry is read off the wrong node. `leftScrollRef`/`rightScrollRef` are also declared and attached but never read.

**Fix** Give the `#all-sheets` button its own ref (or none) and keep `tabContainerRef` exclusively on `#fortune-sheettab-container-c`. Remove the dead `leftScrollRef`/`rightScrollRef`. (Tracked under the SheetTab shadcn migration, TODO-SHEETS #6, but the double-ref is a standalone bug worth fixing now.)

---

### Defensive code that fights the type system

`CODE-STANDARDS.md` forbids defensive null checks and fallback defaults on typed data, and AGENTS.md says to think about every `await`. These four violate that.

#### 5. `getPublicConfig()` is sync and non-nullable but is awaited and guarded
**Severity** medium · **Effort** quick-win
**Files** `apps/api/src/lib/config/server-config.ts:81`, `apps/api/src/routes/public.ts:47,72`, `apps/api/src/lib/waitlist/waitlist.ts:164`

`getPublicConfig()` is a plain synchronous function returning a non-nullable object. Yet `public.ts:72` does `await getPublicConfig()` (awaiting a non-Promise) while `public.ts:47` and `waitlist.ts:164` call it bare — the same function used three inconsistent ways. Callers then guard it: `config?.orgName ?? ''`, `config?.mailDomain ?? ''`, `config?.domain`, `config?.mailDomain ?? 'localhost'`, though the return can never be null. (The `config?.orgId` usages in `apps/admin` are a *different*, genuinely-loading config — leave those.)

**Fix** Drop the `await` at `public.ts:72` and remove the `config?.` / `?? ''` accessors on backend `getPublicConfig()` results — read `config.orgName`, `config.mailDomain` directly. One synchronous trusted call shape everywhere.

#### 6. `useFormField` has an unreachable null-guard
**Severity** low · **Effort** quick-win
**Files** `packages/ui/src/components/form.tsx:41-49`

`useFormField` dereferences `fieldContext` on lines 44 (`useFormState({ name: fieldContext.name })`) and 45 (`getFieldState(fieldContext.name, ...)`) *before* the `if (!fieldContext) throw …` guard on line 47. If `fieldContext` were ever falsy, lines 44–45 would already have thrown a `TypeError`, so the guard and its error message are dead. This is the upstream shadcn artifact, but the file has already been hand-edited locally (`'use client'` removal, interface→type), so it's a fair broken-window.

**Fix** Remove the dead `if (!fieldContext)` block — `FormFieldContext` always has a value when consumed via `FormField`. (If a guard is genuinely wanted, move it above the line-44 deref so it can run.)

#### 7. `getDomain()` fallback chain has an unreachable middle term
**Severity** low · **Effort** quick-win
**Files** `apps/api/src/lib/config/server-config.ts:63-67`

In `return store.get().domain || envDomain || 'localhost'`, the preceding `if (envDomain && envDomain !== 'localhost') return envDomain;` guarantees `envDomain` is by then either `undefined` or exactly `'localhost'`. So `|| envDomain` can only ever contribute `'localhost'` (already the trailing fallback) or `undefined` (skipped) — dead, and misleading because it implies env can win here.

**Fix** Simplify to `return store.get().domain || 'localhost';`.

#### 8. Redundant double error-swallowing in `messageGet` turns read failures into 404s
**Severity** low · **Effort** quick-win
**Files** `apps/api/src/lib/mail/maildir.ts:152`, `apps/api/src/lib/mail/maildir.ts:756`, `apps/api/src/lib/mail/mail.ts:65`

`messageGet` wraps its whole body in `try { … } catch { return null }`, but its only fallible call (`readAndParse`) already has its own `try { … } catch { return null }`. The outer catch is dead for parse/IO errors and only masks unexpected bugs (e.g. a logic error assembling the result) as a benign `null`, which the facade (`mail.ts:69`) then reports as a 404 "not found". A genuine disk-read or parser crash becomes indistinguishable from a missing message — the "defensive try/catch on internal code" pattern CODE-STANDARDS warns against.

**Fix** Remove the outer try/catch in `messageGet`; let `readAndParse` own the null-on-missing contract and let unexpected errors propagate to the Elysia handler (which already maps them). Optionally narrow `readAndParse`'s catch to `ENOENT`.

---

### Copy-paste / duplicated logic

#### 9. Four calendar dialogs copy-paste a manual `isLoading` + 350 ms `setTimeout`
**Severity** medium · **Effort** moderate
**Files** `apps/calendar/src/components/create-event-dialog.tsx:64,157`, `apps/calendar/src/components/edit-event-dialog.tsx:95,229`, `apps/calendar/src/components/calendar-config-dialog.tsx:45,91`, `apps/calendar/src/components/shared-calendar-config-dialog.tsx:34,61`

Each dialog declares its own `const [isLoading, setIsLoading] = useState(false)`, sets it true around `mutateAsync`, then resets with the identical `setTimeout(() => setIsLoading(false), 350)` after closing. The mutations already expose `isPending`, so this hand-rolled state is redundant; the bare `350` is an undocumented magic number repeated verbatim in four files (it keeps "Saving…" on for a beat while the dialog animates out — which also means the button shows "Saving…" for 350 ms *after* the dialog has closed).

**Fix** Drive the button's disabled/label from the mutation's `isPending` (e.g. `createCalendar.isPending || updateCalendar.isPending`) in all four. If the post-close grace is genuinely wanted, hoist it into one named const (`DIALOG_CLOSE_GRACE_MS`) — but prefer just using `isPending` since the dialog unmounts anyway.

#### 10. `ContactEdit` repeats the same array-field add/remove block three times
**Severity** medium · **Effort** large
**Files** `apps/contacts/src/components/contacts/contact-edit.tsx:356-590`

The email-addresses, phone-numbers, and addresses sections each repeat the identical scaffold (~80 lines × 3): a header row with an "Add" button doing `form.getValues(field)` / `form.setValue(field, […])`, then `form.watch(field).map()` rendering inputs plus a "remove" button that splices the array. react-hook-form's `useFieldArray` exists precisely for this. The whole component (avatar upload + 3 array sections + labels + birthday + notes) is one 660-line function.

**Fix** Replace the manual `getValues`/`setValue`/`splice` blocks with `useFieldArray` (`append`/`remove`), and extract a small `RepeatableField` wrapper (header + add button + rows) reused by all three sections.

#### 11. Three date→`YYYY-MM-DD` helpers in calendar with divergent timezone semantics
**Severity** medium · **Effort** moderate
**Files** `packages/lib/src/core/calendar/calendar-utils.ts:82`, `packages/lib/src/core/calendar/calendar-utils.ts:135`, `packages/lib/src/core/calendar/hooks/use-calendar.ts:216`, `packages/lib/src/core/date.ts`

`toISODateString(date)` (line 82) builds `YYYY-MM-DD` from *local* parts; `occurrenceDateToString(value)` (line 135) builds it from *UTC* parts. They look interchangeable but differ by a day near midnight. Every occurrence date in the app uses UTC `occurrenceDateToString` — except `useAllSharedCalendarEvents`, which uses local-time `toISODateString(block.startTime)` to set `occurrenceDate` on free-busy blocks (use-calendar.ts:216), landing them on the wrong calendar day in non-UTC zones. On top of that, `@workspace/lib/date` already exposes `formatInputDate` = `toISOString().slice(0,10)` (UTC), which is functionally the same — so there are effectively three implementations of one idea.

**Fix** Standardise on one UTC converter — route `formatInputDate` through `occurrenceDateToString` (or vice versa) and keep one canonical name. Switch use-calendar.ts:216 to it so free-busy `occurrenceDate` matches every other occurrence date. Delete `toISODateString` once its sole caller is migrated.

#### 12. `EmailDetailToolbar` wraps array callbacks back into per-id `forEach` loops
**Severity** low · **Effort** quick-win
**Files** `apps/mail/src/components/mail/email-detail.tsx:75-96`

`EmailContextMenu`'s callbacks are array-shaped (`onArchive(ids)`, `onDelete(ids)`, `onMoveToFolder(ids, folder)`), but `EmailDetailToolbar` holds singular handlers, so it passes four identical adapters like `onArchive={(ids) => ids.forEach((id) => onArchive(id))}`. The detail view always operates on exactly one email, so these just splice a single id back out.

**Fix** Give the toolbar's parent the same id-array handlers the list uses (actions already exposes `*ByIds` variants) and pass them straight through, or have `EmailContextMenu` accept a single id when `isSingleSelect`. Either removes the four `forEach` adapter closures.

#### 13. Anonymous `{ name: string; email: string }` actor shape repeated ~14× in the backend
**Severity** low · **Effort** moderate
**Files** `apps/api/src/lib/core/mail-composers.ts:23`, `apps/api/src/lib/drive/drive.ts:624`, `apps/api/src/lib/drive/sharedDrive.ts:231`, `apps/api/src/lib/drive/acl-propagation.ts:68`, `apps/api/src/lib/drive/access-request-propagation.ts:13`

The same inline structural type `{ name: string; email: string }` is passed as `actor`/`sender`/`requester`/`recipient` across ~14 backend functions. There's no shared named type, so the "person who triggered this email" contract is restated by hand at every signature; widening it (e.g. adding `userId`) means editing every site.

**Fix** Define one named type (`MailActor = { name: string; email: string }`) in `apps/api/src/lib/core` (or `packages/lib/src/types/mail.ts` if FE ever needs it) and use it across the mail-composer and drive-propagation signatures. Low priority but removes a repeated inline contract.

#### 14. Repeated `{ eventCtag: _ctag, ...rest }` strip where `dbEventToCalendarEvent` already drops it
**Severity** low · **Effort** quick-win
**Files** `apps/api/src/lib/calendar/calendar.ts:451`, `apps/api/src/lib/calendar/calendar.ts:692`, `apps/api/src/lib/calendar/calendar.ts:696`

`createEvent`/`updateEvent` call private `getEventById` (returns a `CalendarEventRow` carrying internal `eventCtag`) then manually strip it with `const { eventCtag: _ctag, ...calendarEvent } = event` three times to downcast to the public `CalendarEvent`. But `dbEventToCalendarEvent(row)` (line 197) already produces exactly a `CalendarEvent` with no `eventCtag` — so the strip reinvents an existing converter and leaves three unused `_ctag` bindings.

**Fix** Re-read the row after insert/update and convert with `dbEventToCalendarEvent(...)` instead of `getEventById` + manual destructure, removing all three strips.

---

### API / formatting inconsistencies

#### 15. Same "not a folder" precondition returns 400 vs 404 across Drive methods
**Severity** low · **Effort** quick-win
**Files** `apps/api/src/lib/drive/drive.ts:190`, `apps/api/src/lib/drive/drive.ts:263`, `apps/api/src/lib/drive/drive.ts:316`, `apps/api/src/lib/drive/drive.ts:427`

The logically identical guard "target/parent path exists but is not a folder" produces three different responses: `createFolder`/`uploadFiles` throw 404 "Parent folder not found"; `createFileFromData` throws 400 "Target is not a folder"; `movePath` throws 404 "Target parent is not a folder". Clients can't handle it uniformly and the wording drift reads as copy-paste rot.

**Fix** The codebase leans 404 here — align `createFileFromData:316` to 404 with a consistent message ("Parent folder not found").

#### 16. Chat notification-tag schema split: server interpolates, client positionally parses index 3
**Severity** low · **Effort** moderate
**Files** `packages/lib/src/core/chat/hooks/use-chat-unread.ts:10,12`, `apps/api/src/lib/chat/chat.ts:184`

The notification `tag` has two ad-hoc template-literal formats on the server (`mention:{owner}:{mount}:{path}[:{chatName}]:{email}` and `{type}:{owner}:{mount}:{path}[:{chatName}]`). The lib side reconstructs meaning by splitting on `:` and trusting `pathId` sits at index 3 (`getPathIdFromTag`), with a comment re-documenting the format. The contract only holds because owner/mount/path ids happen to be colon-free UUIDs — a fragile coupling that will silently misroute unread badges if either side's layout drifts.

**Fix** Define the format once: a `buildChatNotificationTag()` / `parseChatNotificationTag()` pair in a shared lib module both BE and FE import, so the emitter and `getPathIdFromTag` can't diverge.

#### 17. Four `sql` template literals broken across lines by an errant formatter
**Severity** low · **Effort** quick-win
**Files** `apps/api/src/lib/calendar/calendar.ts:339`, `apps/api/src/lib/calendar/calendar.ts:768`, `apps/api/src/lib/calendar/calendar.ts:781`, `apps/api/src/lib/calendar/calendar.ts:1464`

Four `sql\`…\`` templates have a newline + indentation embedded mid-string, e.g. `sql\`unixepoch\n                ()\`` (339–340) and `sql\`${schema.events.rrule}\n                IS NOT NULL\`` (768–769). SQLite tolerates the whitespace so these aren't runtime bugs, but every other `sql` template in the same file and in sibling `contacts.ts` is single-line. Clearly auto-format/merge damage.

**Fix** Collapse each to a single line to match the ~15 other `sql\`unixepoch()\`` / `sql\`${col} IS NOT NULL\`` usages. Mechanical, no behavior change.

---

### Minor / localized

#### 18. Redundant `{...docInfo.path, mountId}` spread in slides/sheets editor routes
**Severity** low · **Effort** quick-win
**Files** `apps/slides/src/routes/_auth.slide.$ownerId.$mountId.$pathId.tsx:31`, `apps/sheets/src/routes/_auth.sheet.$ownerId.$mountId.$pathId.tsx:32`

Both routes build `path = useMemo(() => docInfo?.path ? { ...docInfo.path, mountId } : null, …)`. But `DrivePath` (drive.ts:319) already includes `mountId`, equal to the same route param, so the spread is a no-op that obscures that `docInfo.path` is already complete. The docs/stickies routes confirm this by passing `docInfo.path` directly.

**Fix** Drop the spread and pass `docInfo.path` directly (as docs/stickies do); use `const path = docInfo?.path ?? null;` if a non-null narrowing is wanted.

#### 19. Upload auto-remove uses inconsistent magic timeouts with a wrong comment
**Severity** low · **Effort** quick-win
**Files** `packages/ui/src/components/layout/upload-provider/upload-provider.tsx:60-72`

`complete()` removes the finished upload after 1000 ms but is annotated `// Auto-remove after 3 seconds`; `error()` removes after 3000 ms with the same comment. The success comment is factually wrong, the two paths use different delays with no rationale, and 1000/3000 are bare magic numbers. CODE-STANDARDS says comments explain WHY not WHAT — a comment that contradicts the code is worse than none.

**Fix** Drop the WHAT-comments (the `setTimeout` is self-evident) or replace the literals with named constants (`COMPLETE_DISMISS_MS = 1000`, `ERROR_DISMISS_MS = 3000`). At minimum correct the "3 seconds" comment on `complete()`.

#### 20. Duplicate default-color computation + missing effect dep in `LabelDialog`
**Severity** low · **Effort** quick-win
**Files** `packages/ui/src/components/layout/labels/label-dialog.tsx:60-63`

`EIGEN_ACCENT_COLORS_SHUFFLED[labelCount % EIGEN_ACCENT_COLORS_SHUFFLED.length].value` is computed twice — inline in `useForm` defaultValues (line 60) and again as `const defaultColor` (line 63) used by the reset effect. The effect on line 65 also omits `defaultColor` from its dependency array (`[selectedLabel, form, open]`), a latent stale-value smell.

**Fix** Compute `defaultColor` once above `useForm`, reuse it in both places, and add it to the effect's dependency array.

#### 21. Slash-command parser inlined while sibling parsers live in `chat-utils`
**Severity** low · **Effort** quick-win
**Files** `packages/ui/src/components/layout/chat/chat-message-input.tsx:117-122`, `packages/ui/src/components/layout/chat/chat-utils.ts`

`chat-message-input` defines `getSlashQuery()` inline inside the component, while the two analogous parsers (`getAtSuggestQuery`, `getSlashTargetQuery`) are extracted to `chat-utils.ts`. All three are the same kind of pure string-parser and should sit together for consistency and unit-testability.

**Fix** Move `getSlashQuery` into `chat-utils.ts` next to the other two and import it.

---

*Dropped during triage:* none of the 23 were outright wrong; findings #21 and #22 from the raw set were the same calendar-dialog pattern reported by two agents and are merged here as entry #9 (kept at the higher medium severity).

## 6. Dead Code

Unused hooks, components, endpoints, props, and query-key scaffolding that ship in the bundle or widen the public API surface without a single caller. Most are quick deletions; two carry real cost (a whole extra dependency, a duplicated CF submenu) and a few create active traps (shadowed `getErrorMessage`, a logger flag that does the opposite of what it reads).

### High severity

**`useFileUpload` is a dead duplicate of `DriveUploadFiles`'s upload flow**
- **Severity** high · **Effort** quick-win
- **Files** `packages/ui/src/components/layout/drive/file-upload.tsx`, `packages/ui/src/components/layout/drive/drive-upload-files.tsx`, `packages/ui/src/components/layout/drive/index.ts`
- **Problem** `useFileUpload` has zero consumers (verified). Only its `UploadResult` type is imported, and that is re-exported through `drive-upload-files.tsx`. The hook body (`processFiles`: build `FormData`, `getDriveFileUploadUrl`, `uploadWithProgress` with progress/success/error, reset input) is a near-verbatim copy of `DriveUploadFiles.processFiles`, so two implementations of the same upload flow exist, one unreachable. It also carries `FileUploadOptions` (`uploadUrl` / `additionalHeaders`) — feature-flag-style options with no caller, which CODE-STANDARDS rejects.
- **Fix** Delete `file-upload.tsx` and its barrel export. Move the small `UploadResult` type into `drive-upload-files.tsx` (its only real user). If a reusable uploader is ever wanted, extract the single `DriveUploadFiles.processFiles` flow into one shared helper — don't keep a parallel hook.

**Dead `ConditionalFormat` component duplicates the live CF submenu verbatim**
- **Severity** high · **Effort** quick-win
- **Files** `packages/sheet/src/components/ConditionFormat/index.tsx`, `packages/sheet/src/components/MenuBar/format-menu.tsx`
- **Problem** `ConditionFormat({ items })` has zero consumers — not in the components barrel, no JSX usage, not re-exported. `MenuBar/format-menu.tsx::ConditionalFormattingSubmenu` reimplements the identical UI inline: the `highlightCellRules` / `itemSelectionRules` arrays, the per-item `flex items-center justify-between … text-xs opacity-50` markup, the `showDialog(<ConditionRules type={…} />)` handlers, and the delete/manage block. The dead copy will silently drift from the live menu.
- **Fix** Delete `ConditionFormat/index.tsx`. `ConditionRules` and `ManageRules` in the same folder stay (used by format-menu / RangeDialog). If a shared submenu is ever wanted, extract the two arrays + item renderer into one helper consumed by `format-menu.tsx`.

**Three `move-to-{inbox,archive,spam}` mail endpoints + facades are unreachable**
- **Severity** high · **Effort** quick-win
- **Files** `apps/api/src/routes/mail.ts`, `apps/api/src/lib/mail/mail.ts`
- **Problem** Routes `/message/move-to-inbox`, `/message/move-to-archive`, `/message/move-to-spam` and their facades `messageMoveToInbox` / `messageMoveToArchive` / `messageMoveToSpam` have zero callers across `packages/lib` and `apps/mail` (verified). The UI archive/spam actions both go through the generic `/message/move` endpoint (`useMoveEmail` with `'Archive'` / `'Junk'`). Only `move-to-trash` is live.
- **Fix** Delete the three routes and the three facade wrappers. Keep `messageMoveToSpecial` (still used by `messageMoveToTrash`) and the live `move-to-trash` route. Optionally fold `move-to-trash` into the generic `move` (`targetMailbox: 'Trash'`) to drop the last special-case route, since the UI already moves by target name everywhere.

### Medium severity

**Dead `getErrorMessage` shadows the canonical one through the `@workspace/lib/auth` barrel**
- **Severity** medium · **Effort** quick-win
- **Files** `packages/lib/src/core/auth/hooks/use-auth-client.ts:28-51`, `packages/lib/src/core/auth/hooks/index.ts:2`, `packages/lib/src/core/api-error.ts:25`
- **Problem** `use-auth-client.ts` defines `ErrorTypes`, `errorCodes`, and an exported `getErrorMessage(code, lang)` with zero callers (verified self-contained). `auth/hooks/index.ts` does `export * from './use-auth-client'`, so this dead `getErrorMessage` is re-exported from `@workspace/lib/auth` and collides by name with the real, heavily-used `getErrorMessage(error: unknown)` in `@workspace/lib/api-error` — two same-named exports with incompatible signatures on the public surface.
- **Fix** Delete `ErrorTypes`, `errorCodes`, and the `getErrorMessage` export (lines 28-51). The canonical helper is `getErrorMessage` in `api-error.ts`; there should be exactly one symbol with that name in the lib's public surface.

**`combobox.tsx` is dead and the sole reason `@base-ui/react` is a dependency**
- **Severity** medium · **Effort** quick-win
- **Files** `packages/ui/src/components/combobox.tsx`, `packages/ui/package.json:13`
- **Problem** `combobox.tsx` (271 lines) has zero consumers (verified, both alias and relative import forms). It is also the only file in the monorepo importing `@base-ui/react` (verified — single match). Every other primitive here is radix-ui or native; combobox alone pulls in a competing headless-UI library, so `@base-ui/react` sits in `package.json` and the bundle purely for one orphan. Unlike the zero-cost vendored shadcn primitives in this folder, this carries a real dependency.
- **Fix** Delete `packages/ui/src/components/combobox.tsx` and remove `@base-ui/react` from `packages/ui/package.json`. If a combobox is wanted later, add it via shadcn's radix-based registry to stay consistent.

**Dead SSE type re-exports in `core/sse/index.ts`**
- **Severity** medium · **Effort** quick-win
- **Files** `packages/lib/src/core/sse/index.ts:1-2`
- **Problem** Lines 1-2 re-export `SSEvent`/`SSEventChat`/`SSEventDrive`/`SSEventMail`/`SSEventType` from `types/sse`. This violates the project's "no type re-exports through domain barrels" rule and is dead: every consumer (including `core/sse` itself) imports these directly from `@workspace/lib/types/sse`. The barrel `@workspace/lib/sse` is imported only for the `useSSE` value (verified).
- **Fix** Delete lines 1-2, leaving only `export { useSSE } from './hooks/use-sse'`. No callers need updating.

**`FormulaEngine.evaluateAll()` has no production caller**
- **Severity** medium · **Effort** quick-win
- **Files** `packages/sheet/src/engine/formula-engine.ts:159`
- **Problem** `evaluateAll(cells, resolver)` is invoked nowhere outside its own test (verified). Production uses `evaluate()` and `recalculateAll()`. It is a parallel batch path that duplicates the result-caching block of `recalculateAll` (the `execFunctionGlobalData[key] = { v, ct: { t: …, fa: 'General' } }` snippet is identical) but skips dependency ordering, so it would produce wrong results if wired up — a "for future use" method with a misleading contract.
- **Fix** Delete `evaluateAll` and its test. Keep `recalculateAll` as the only batch path; if the shared caching snippet survives, make it a one-line private helper.

### Low severity — dead exports / API surface

**Unused query-key factory members copy-pasted from the standard key shape**
- **Severity** low · **Effort** quick-win
- **Files** `packages/lib/src/core/mail/hooks/use-mailboxes.ts:9-12`, `packages/lib/src/core/contacts/hooks/use-contacts.ts:13`, `packages/lib/src/core/contacts/hooks/use-labels.ts:13`
- **Problem** Several domains cloned the full `lists/list/details/detail` factory but use only a subset. Verified zero callers: `mailboxKeys.list` (filtered), `mailboxKeys.details`, `mailboxKeys.detail`, `mailboxKeys.exists` (only `mailboxKeys.lists` is used, all references are internal cross-definitions), `contactKeys.list`, and `labelKeys.list`. Where `.list(...)` is real (mail/notification/chat) it carries a meaningful arg like `mailboxPath`; here it carries an empty `{ filters }`.
- **Fix** Drop `list/details/detail/exists` from `mailboxKeys` (keep `all/owner/lists`); drop the filtered `list` from `contactKeys` and `labelKeys`. Keep only members with a real caller, per the no-placeholders rule.

**`detectCycle()` and `isCellReference()` are public engine API with zero callers**
- **Severity** low · **Effort** quick-win
- **Files** `packages/sheet/src/engine/dependency-graph.ts:96`, `packages/sheet/src/engine/formula-engine.ts:25`, `packages/sheet/src/engine/index.ts:30`, `packages/sheet/src/state/modules/formula-ui.ts:1`
- **Problem** `detectCycle` is re-exported from `engine/index.ts` and the package root, referenced only by its own test, despite `docs/SHEETS.md` claiming cycles are detected by it — actual cycle handling lives in `getCalculationOrder`'s color marking. `isCellReference` (with its own `CELL_REF_RE`) is re-exported twice but has no caller; the codebase uses `iscelldata` from `formula-utils.ts` instead.
- **Fix** Drop the `isCellReference` export and its regex. Either remove `detectCycle` and its barrel re-exports, or wire it into the path `docs/SHEETS.md` describes. A green test on dead exports gives false confidence.

**`getColorGradation` leaked through the public engine barrel**
- **Severity** low · **Effort** quick-win
- **Files** `packages/sheet/src/engine/index.ts:26`, `packages/sheet/src/engine/conditional-format.ts:62`
- **Problem** `getColorGradation` is exported from `engine/index.ts` alongside `cfSplitRange`/`evaluateConditionalFormat`, but has no external consumer — it is called only internally by `evaluateConditionalFormat`. (`cfSplitRange` has real state-layer callers and stays.)
- **Fix** Remove `getColorGradation` from the `engine/index.ts` export list; keep it module-private in `conditional-format.ts`.

**`userOwnerId()` is a dead identity wrapper**
- **Severity** low · **Effort** quick-win
- **Files** `packages/lib/src/types/owner.ts:41`
- **Problem** `userOwnerId(userId) { return userId; }` has zero call sites (verified; only its round-trip in `owner.test.ts`). A user owner id is just the raw UUID, so the wrapper does nothing — both dead code and the single-use/identity indirection CODE-STANDARDS rejects.
- **Fix** Delete `userOwnerId` and its test line. Callers already use `user.id` directly.

**Exported `CommentMenuItem` type is only used locally**
- **Severity** low · **Effort** quick-win
- **Files** `packages/ui/src/components/layout/comments/comment-menu-items.tsx:7`
- **Problem** `export type CommentMenuItem = …` is never imported and not re-exported from the barrel; it is only the local `item` prop type. The identical shape is independently re-declared and consumed as `CommentContextMenuItem` in `comment-context-menu.tsx`.
- **Fix** Drop the `export` keyword. Better: define the shape once and import it in both files to remove the duplication with `CommentContextMenuItem`.

**`useCalendarEvents` is dead, and its `as` cast hides a free-busy type bug**
- **Severity** low · **Effort** quick-win
- **Files** `packages/lib/src/core/calendar/hooks/use-calendar.ts:108`
- **Problem** `useCalendarEvents` is exported and listed in `docs/CALENDAR.md` but has no caller (only its query-key helper is reused, by `useAllSharedCalendarEvents`). The endpoint returns `CalendarEventOccurrence[] | FreeBusyBlock[]` by permission; this hook blindly casts `(response.data || []) as CalendarEventOccurrence[]` with no free-busy mapping, so it would mistype `FreeBusyBlock` rows if wired to a free-busy share. `useAllSharedCalendarEvents` is the live, correct hook.
- **Fix** Delete `useCalendarEvents` (keep `calendarKeys.calendarEvents`) and remove its row from `docs/CALENDAR.md`. A single-calendar variant should copy the permission-aware mapping, not the bare cast.

### Low severity — dead props / parameters

**`reUploadImage` carries two unused params that both callers still pass**
- **Severity** low · **Effort** quick-win
- **Files** `packages/lib/src/core/clipboard/clipboard.ts:70-98`, `apps/docs/src/components/docs/editor.tsx:481`, `apps/slides/src/components/slides/editor.tsx:442`
- **Problem** `reUploadImage` declares `_targetOwnerId` / `_targetMountId` (underscore = unused) and never references them, yet both call sites compute and pass `path.ownerId` / `path.mountId` into those slots — live code feeding dead arguments. CODE-STANDARDS forbids "for future use" parameters.
- **Fix** Drop both params from the signature and remove the `path.ownerId` / `path.mountId` arguments at both call sites. The function needs only the source identifiers + media folder + uploadFn + fileName.

**`isFunctionRange` threads three never-read params through its recursion**
- **Severity** low · **Effort** quick-win
- **Files** `packages/sheet/src/state/modules/formula-exec.ts:195`, `packages/sheet/src/state/modules/formula-exec.ts:45`
- **Problem** `isFunctionRange(ctx, txt, r, c, id, dynamicArray_compute, cellRangeFunction)` never reads `r`, `c`, or `dynamicArray_compute` — they appear only in recursive self-calls and the `checkSpecialFunctionRange` call, where the matching params are `_r`/`_c`/`_dynamicArray_compute` (also unused). Three args are carried through every frame purely to be ignored.
- **Fix** Drop `r`, `c`, `dynamicArray_compute` from both functions and update the single-file call sites in `setFormulaCellInfo`. Mechanical once the underscore params confirm disuse.

**Dead `triggerParentUpdate` prop on `ChangeColor`**
- **Severity** low · **Effort** quick-win
- **Files** `packages/sheet/src/components/ChangeColor/index.tsx:10`, `packages/sheet/src/components/SheetTab/SheetItem.tsx:245`
- **Problem** `ChangeColor` requires `triggerParentUpdate` but ignores it (destructured as `_triggerParentUpdate`); its only caller passes a no-op `() => {}`. The prop and its type are pure ceremony.
- **Fix** Drop `triggerParentUpdate` and `ChangeColorProps`; render `<ChangeColor />` with no props. State already flows through `setContext`.

**Dead `organizationId` prop on `CreateUserDialog`**
- **Severity** low · **Effort** quick-win
- **Files** `apps/admin/src/components/admin/create-user-dialog.tsx:12-18`, `apps/admin/src/components/admin/members-list.tsx:43-47`
- **Problem** `CreateUserDialogProps` declares `organizationId?: string` but the component destructures only `{ open, onOpenChange }` and resolves the org id from `usePublicConfig()` internally. `MembersListToolbar` still threads `organizationId={organizationId}`, falsely implying it's wired.
- **Fix** Remove `organizationId` from `CreateUserDialogProps` and drop the pass-through (and the param it only forwards) in `MembersListToolbar`. The component resolves orgId itself.

**`MailLink`'s compact / non-link branches are never exercised**
- **Severity** low · **Effort** quick-win
- **Files** `apps/mail/src/components/mail/email-detail.tsx:110-160`
- **Problem** `MailLink` takes `mailLink` (default true) and `compact` (default false). Every caller is `formatContactObject(s)`, themselves called with one argument from `MailHeaderDetails`, so `compact` is always false and `mailLink` always true — the compact branch (line 129) and non-link branch (line 140) are dead. `MailLink` is exported but used only in this file.
- **Fix** Drop the `compact` param and the non-link branch from `MailLink` and `formatContactObject(s)`, and unexport `MailLink`. Keep the one path that runs.

### Low severity — placeholders / traps

**`DownloadHome` / `/data` route is a placeholder with no entry point**
- **Severity** low · **Effort** quick-win
- **Files** `apps/space/src/components/space/download-home.tsx`, `apps/space/src/routes/_auth.data.tsx`, `apps/space/src/components/space/space-sidebar.tsx`
- **Problem** `DownloadHome` renders a permanently `disabled` button reading "This feature is not yet available." Its only host, `/_auth/data`, is not linked from `SpaceSidebar` or anywhere (verified) — reachable only by typing the URL. A "for future use" placeholder with no caller, against the project's no-placeholders guidance.
- **Fix** Remove `download-home.tsx` and `_auth.data.tsx` until data export exists; reintroduce both with a sidebar entry when it lands. If kept as a teaser, at least add the sidebar link.

**`isTest() && false` keeps the better-auth logger permanently on**
- **Severity** low · **Effort** quick-win
- **Files** `apps/api/src/lib/auth/auth.ts:121`
- **Problem** `logger: { disabled: isTest() && false }` always evaluates to `false`, so the logger is never disabled and `isTest()` is computed and discarded. Git history shows a commit titled "temp(auth): disable better auth logger" — the code reads as disabling logging in tests but does the opposite. A maintenance trap.
- **Fix** Write the real intent plainly: `logger: { disabled: isTest() }` (quiet under test) or drop the `logger` key entirely. Remove the leftover `&& false` either way.

**Unused `useDriveDialogs` `delete` bucket**
- **Severity** low · **Effort** quick-win
- **Files** `packages/ui/src/components/layout/drive/use-drive-dialogs.ts:28-29,43-50,91-97`
- **Problem** `useDriveDialogs` builds a `delete` bucket (`deleteOpen`/`deleteItems` state, `openDelete`/`closeDelete`) and returns it. Its only consumer, `DriveLayout`, never reads `dialogs.delete` — it deletes directly via `deletePathsMutation.mutate` with no confirmation. Dead state on every `DriveLayout` render.
- **Fix** Remove the delete state and the `delete` key from the returned object. If a confirmation step is intended, wire `DriveLayout` to `DriveDeleteItem` (which wraps the shared `DeleteDialog`) through this bucket instead.

**Dead `icsBlob` column on the events table**
- **Severity** low · **Effort** quick-win
- **Files** `apps/api/src/lib/calendar/schema.ts:45`, `apps/api/src/lib/calendar/db-config.ts:46`
- **Problem** `icsBlob TEXT` is declared in the Drizzle schema and the migration SQL but never read or written (repo-wide grep hits only the two declarations). A "for future use" column. (Neighbouring `eventCtag` is live for CalDAV sync and stays.)
- **Fix** Remove the `icsBlob` field from `schema.ts` and the `icsBlob TEXT,` line from the v1 migration. Re-add with a real reader/writer if CalDAV ever caches serialized ICS.

## Architecture Note — `packages/sheet` Package Boundary

_Added from a maintainer question ("sheet is only used by one app — should it move into the app?"). Verified against the source; the answer is **keep the package**, and the genuinely useful fix is far cheaper than a move._

`packages/sheet` (~65k LOC) is **not** single-consumer. It has two entry points with two different consumers:

| Entry | Lines | Consumed by |
|-------|------:|-------------|
| `./engine` (`src/engine/`, pure TS, React-free) | ~15.7k (24%) | **`apps/sheets` and `apps/api`** |
| `.` (`src/index.ts` → `components/`, `state/`, `hooks/`, `context/`, React/DOM) | ~49.7k (76%) | `apps/sheets` only |

The backend (`apps/api`) imports `@workspace/sheet/engine` in three places: `lib/document/sheets.ts` (`replaySheetsOps`), `lib/export/sheets/html.ts`, and `lib/import/sheets/from-xlsx.ts` (`parseA1Range`). Nothing in `packages/ui` / `packages/lib` imports it (the one-way `sheet → lib` rule holds).

- **Severity:** low (no bug; the architecture is sound) · **Effort:** large if the relocation is pursued, quick-win for the recommended action
- **Problem:** The tempting refactor — fold the package into `apps/sheets` — would *break* the architecture: `apps/api` would then import another app's source, and the `.` vs `./engine` export split that keeps React out of the backend bundle would be lost. The only genuinely odd thing is cosmetic: the package is named like shared infrastructure but 76% of it is single-app UI.
- **Fix:** Do **not** collapse the package. If tidiness is the goal, the defensible variant is to relocate the React UI (~49.7k LOC) into `apps/sheets` and leave `packages/sheet` as the pure shared engine — but that is large churn for modest ROI, since the subpath export already isolates concerns and React is not leaking into the API today. The high-leverage, low-cost action is to **enforce the load-bearing invariant** — `engine/` must stay React-free — via an import-boundary lint rule (or a documented contract), so a stray React import can't silently pull React into the backend.

## Appendix: Coverage & Methodology

Produced by 28 parallel auditor agents (23 subsystem + 5 cross-cutting), then 6 per-category synthesis editors and a final roadmap editor. Each auditor was required to read `AGENTS.md`, `docs/CODE-STANDARDS.md`, relevant domain docs, and representative source before judging, and to cite specific files. Report-only: 164 raw findings were collected, then clustered and de-duplicated into the entries above. Findings are review candidates, not verified fixes.

**Subsystem areas audited:** ui/drive; ui/app-shell; ui/chat-comments-labels; ui/misc-layout; ui/primitives; lib/drive+command-palette; lib/chat+calendar+mail; lib/comments+collab+contacts; lib/infra-cores; lib/types+validation; sheet/engine+state; sheet/ui; api/mail; api/calendar+caldav; api/drive+mount+share; api/chat+collab; api/infra; api/protocols+io; api/auth+config+setup; apps/mail+contacts; apps/calendar+drive; apps/editors; apps/chat+space+admin+index.

**Cross-cutting sweeps:** xc: cross-app UI duplication; xc: UX consistency across apps; xc: hook / data-fetching duplication; xc: backend pattern duplication; xc: type & utility duplication.
