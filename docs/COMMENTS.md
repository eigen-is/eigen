# Comments

> **TLDR**: Unified comment-card model across stickies / docs / slides / sheets. Each card is a
> `{ id, title, description, color?, chatName? }` record stored in a Y.Map on the container's Y.Doc. The
> server-side `comments.db` SQLite index holds derived metadata (status, assignee, lastAuthorEmail,
> messageCount, createdAt, createdBy) plus a `recentText` tail + FTS index for in-document comment search.
> Shared `<CardFormDialog>` and `<CardDialog>` in `packages/ui` render
> create + view/edit flows; per-app anchors connect cards to host content.

## Architecture

```
Y.Doc (per container)         comments.db (per container)            UI
─────────────────────────     ─────────────────────────────────      ──────────────────────────────
comments / tasks Y.Map        chatName (PK), status, resolvedBy,     useCommentCards (Y.Map → state)
  → CommentCard {              resolvedAt, lastAuthorEmail,          useCreateCommentCard (atomic
       id, title, description, lastMessageSnippet, lastActivityAt,    chat-create + Y.Doc write +
       color?, chatName?,      messageCount, createdAt, createdBy,    caller-supplied anchor)
       creator?, createdAt?    recentText (FTS), assignee, title          useUpdateCommentCard / useDelete-
     }                                                                CommentCard
```

Each container document (eigendoc, eigenstickies, eigenslides, eigensheets, eigenvector) stores `comments.db` alongside `data.db`. Comment chats live as `.eigenchat` folders in the container's `chat/` directory.

```
my-doc.eigendoc/
├── data.db              (Yjs collaborative state — includes the comments Y.Map)
├── comments.db          (server-side metadata index)
├── media/
└── chat/
    ├── comment-1.eigenchat/
    └── comment-2.eigenchat/
```

## Card storage (Y.Doc)

The shared `CommentCard` type (`packages/lib/src/types/comments.ts`):

```ts
type CommentCard = {
    id: string;
    title: string;
    description: string;
    color?: string;
    chatName?: string;
    creator?: string;     // user email at creation time
    createdAt?: number;   // ms epoch at creation time
    attachments?: ChatAttachment[];  // additive since 2026-06-10; absent on older cards
};
```

`creator` + `createdAt` live on the Y.Doc so they're collaborative + undoable + survive a Y.Doc
version revert. The server-side `comments.db` row carries the same metadata as `createdBy` /
`createdAt` (set by `seedCommentRow` at chat creation) — the two paths are independent stores of
the same fact.

Cards live in a Y.Map keyed by `id`. The map name is per-app:
- **Stickies**: `tasks` (unchanged for backwards compatibility)
- **Docs / Slides / Sheets / Vector**: `comments`

Color lives on the Y.Doc card — undoable via the Y.UndoManager, collaborative via y-websocket, no
REST round-trip on color change.

## Card attachments

`attachments` reuses chat's exact wire type (`ChatAttachment = string | AttachmentReference`): a
plain string is a filename in the **container's `media/` folder**, a reference points at an
external drive item. Card attachments are distinct from message attachments in the card's thread
(those live in the comment chat's own `media/`, unchanged).

- **Staging**: `CardFormDialog` stages drafts locally (`CardAttachmentDraft = ChatAttachment |
  DrivePath | File`); nothing touches the server until Save, so Cancel leaves no orphans.
- **Resolution** (`useResolveCardAttachments`): device files upload into container `media/`;
  regular drive picks are **copied** there (the container's ACL must cover them for every
  collaborator — same rule as chat); containers stay references. A failed upload aborts the save.
- **Removal** orphans the media file deliberately — same model as docs inline images; it is what
  lets undo and Y.Doc version revert restore attachments intact.
- **Rendering**: chips in `CardDialog` (preview on click); on unopened cards (`NoteCard`) the
  first image attachment's drive thumbnail renders as a small cover plus a paperclip count, via
  `useAttachmentMeta` — filename resolution rides MediaResolver's cached folder lookup, one query
  per board. References are skipped for the cover (no thumbnail).
- Hosts gate the UI on `mediaFolderId` (`allowAttachments`); a container without a resolvable
  media folder simply hides the attachment controls.

## Per-app anchoring

Each app anchors a card to host content differently:

| App      | Anchor                                                                  |
|----------|-------------------------------------------------------------------------|
| Stickies | Column membership: `columnsMap.<col>.taskIds` contains the cardId       |
| Docs     | TipTap mark `data-comment-id="<cardId>"` on a text range                |
| Sheets   | `Cell.commentCardIds?: string[]` on the cell                            |
| Slides / Vector | `VectorElementBase.commentCardIds` on the element — a JSON id string |

A card with no anchor is "orphaned" — its Y.Map entry, `.eigenchat`, and `comments.db` row all
persist (enabling undo/redo + Y.Doc version revert), but it is hidden from the comment panel.

## Database schema

**`comments` table** (`apps/api/src/lib/chat/comment-schema.ts`, v5 since 2026-07-10):
`chatName` (PK), `status` (open|resolved), `resolvedBy`, `resolvedAt`, `lastAuthorEmail`,
`lastMessageSnippet`, `lastActivityAt`, `messageCount`, `createdAt`, `createdBy` (v2),
`recentText` (v3 — newest ~8 KB of the thread's messages, recomputed on every comment write),
`assignee` (v4 — lowercased member email, NULL = unassigned; server-authoritative like resolve),
`title` (v5 — best-effort client-posted card-title cache, refreshed on every assign/status PATCH;
can lag a rename until the next action — used for activity-event labels, not as a UI source).
v4 and v5 are split deliberately: dev runtimes stamped v4 as assignee-only mid-build, and a
stamped migration is immutable — amend-in-place broke those databases until v5 healed them.

**`comments_fts`** (v3): external-content FTS5 over `recentText`, kept in sync by triggers; the
UPDATE trigger is gated on `recentText` so status/activity/count writes don't churn the index.

**`comment_mentions` table**: `chatName` + `email` (composite PK). Write-only since 2026-07-10:
`addMention` still records rows at post time, but mentions left the wire type (`CommentEntry`) and
`list()` no longer joins them — the "For you" tab was the only reader. Kept for a possible
cross-document mentions view later.

There is no `color` column in the current schema — card color lives on the Y.Doc card. Databases
created before 2026-05-17 may still carry an ignored legacy `color` column (nothing reads it).

## Row seeding

A `comments.db` row is created **at chat creation** when the new chat lands inside a container's
`chat/` folder. `Drive.create` calls a private `seedCommentRow(...)` helper that resolves the
container via `findContainerPath`, opens the index via `openCommentIndex` (every real container
has a `comments.db` by construction — `CollabDocument.create` provisions it; standalone chats bail
earlier at `findContainerPath`), and calls `ensureComment(chatName, { createdBy: user.email })`.

The `ensureComment` upsert uses `INSERT ... ON CONFLICT DO UPDATE SET createdBy = COALESCE(createdBy,
EXCLUDED.createdBy)` — a real value is never overwritten by null, making the call idempotent.
`postMessage` also seeds on every message so legacy chats (pre-this-column) self-heal on first
activity.

Standalone chats (e.g. team-chats at mount root) get no `comments.db` row — same behavior as before
the column was added.

## CommentIndex service

`CommentIndex` (`apps/api/src/lib/chat/comment-index.ts`) wraps `comments.db`:

| Method           | Description                                                                       |
|------------------|-----------------------------------------------------------------------------------|
| `ensureComment`  | Idempotent upsert; accepts `{ createdBy?, createdAt? }` seed via COALESCE         |
| `updateActivity` | Update last author/snippet/activity, optionally increment `messageCount`          |
| `addMention`     | Insert mention row (dedup via composite PK)                                       |
| `resolve`        | Set `status='resolved'`, record `resolvedBy`/`resolvedAt`                         |
| `reopen`         | Set `status='open'`, clear resolved fields                                        |
| `assign`         | Set/clear `assignee` (lowercased email or NULL)                                   |
| `setTitle`       | Refresh the client-posted `title` cache (200-char cap applied by the callers)     |
| `decrementCount` | `MAX(0, messageCount - 1)`                                                        |
| `setRecentText`  | Replace the thread's ~8 KB `recentText` tail (FTS re-index via trigger)           |
| `list`           | All comments (plain row spread; no mentions join since 2026-07-10)              |
| `searchComments` | FTS5 body search → ranked `{ chatName, snippet }` matches (in-document search)    |

Message-driven updates go through `ChatRoom.updateCommentIndex(fn)`, which opens the index, runs
the callback, recomputes `recentText`, and emits `CHAT_COMMENT_INDEX_UPDATED` SSE (owner home
broadcast + effective-member fan-out). The REST mutations (`/status`, `/assignee`) go through the
`Drive.setCommentStatus` / `Drive.assignComment` domain methods (write-gated `SharedDrive`
wrappers), which first `assertCommentChatExists` (404 on an unknown thread — see API routes below),
then mutate the index and record the file events; the routes then emit the same SSE
via `broadcastCommentIndexUpdated` (`lib/chat/sse-events.ts` — owner home + member fan-out through
`sendToHome`, which self-gates on `atHome()`), so resolve/assign reach other clients live.
`seedCommentRow` writes the index directly with no broadcast (creation already emits drive SSE).

**Activity + notifications**: `assignComment` records an `'assigned'` file event (details
`{ assignee, card?, chatName? }` — `card` is the client-posted title, same trust model as the
`sticky-*` events; the assignee is excluded from the watcher fan-out because the route already
sends them a direct `'assigned'` notification, tag `assigned:owner:mount:path:chatName`, resolved
client-side like `mention-comment`). `setCommentStatus` records `'resolved'`/`'reopened'` events.
Unassign records nothing and notifies nobody; unregistered invitees can be assigned but get no
notification (`getUserByEmail` guard, mirroring mentions).

## API routes (`apps/api/src/routes/collab.ts`)

```
GET    /collab/:ownerId/:mountId/:pathId/comments                    List comments (CommentEntry[])
GET    /collab/:ownerId/:mountId/:pathId/comments/search?q=          FTS body search (in-document search)
PATCH  /collab/:ownerId/:mountId/:pathId/comments/:chatName/status   Resolve or reopen ({ status, title? }); 404 unknown chat
PATCH  /collab/:ownerId/:mountId/:pathId/comments/:chatName/assignee Assign ({ assignee: email|null, title? });
                                                                     403 without write, 400 non-member, 404 unknown chat
```

Both PATCH writes reject an unknown `chatName` with **404 `Comment thread not found`**: `assertCommentChatExists`
(`comment-index.ts`) requires the name to resolve to a real `.eigenchat` under the container's `chat/` folder
before `ensureComment` runs, so a writer can never mint an index row (+ `assigned` event + dead-link
notification) for a phantom name. Real legacy chats missing their row still heal — that check passes for them, and the FE keeps assign/resolve reachable for such cards: `CommentMenuItems` and `CardDialog` treat a missing entry as open and unassigned (the `matchesCommentFilter` rule), so the first write is what seeds the row.

There is no longer a `PATCH .../color` route — color lives on the Y.Doc card and round-trips via
y-websocket.

## Frontend hooks

**Server-derived metadata** (`packages/lib/src/core/chat/hooks/use-comments.ts`):

| Hook / export        | Description                                                          |
|----------------------|----------------------------------------------------------------------|
| `commentKeys`        | Query key factory: `all`, `container`, `list`                        |
| `useComments`        | `GET .../comments` — returns `CommentEntry[]`                        |
| `useResolveComment`  | `PATCH .../comments/:chatName/status` (`{ chatName, status, title? }`) |
| `useAssignComment`   | `PATCH .../comments/:chatName/assignee` (`{ chatName, assignee, title? }`) |
| `invalidateComments` | Called by SSE handler to invalidate container keys                   |

**Y.Doc card state** (`packages/lib/src/core/comments/`):

| Hook / helper             | Description                                                                       |
|---------------------------|-----------------------------------------------------------------------------------|
| `useCommentCards(doc, mapName)` | `Record<cardId, CommentCard>` synced to the Y.Map (`comments` or `tasks`)   |
| `useCommentLifecycle`     | The whole bundle above in one hook (open-card state, server entries, resolve mutation, create/update, `?chat=` resolution). Used by all four editors; `mapName` selects the Y.Map (`'comments'` default, stickies passes `'tasks'`), and hosts that mount before Yjs sync pass `ready` (+ optional `onChatNotFound`) |
| `useCreateCommentCard`    | Returns `(input, anchorInTransact?) => Promise<void>`. Creates the `.eigenchat`, then writes the card + runs the caller's anchor inside one Y.Doc `transact` → single undo step. The anchor callback receives the new `CommentCard` synchronously inside the transaction |
| `useUpdateCommentCard`    | `(cardId, patch) => void` — applies a partial patch to the Y.Map card             |
| `useOpenCommentCard`      | `(cards, entries, openCardId)` → `{ card, entry }` — resolves the open dialog's `chatName` against the server-side entries |
| `useResolveCardAttachments` | `(ownerId, mountId, mediaFolderId)` → async `(drafts) => ChatAttachment[]` — settles form drafts: uploads Files, copies regular drive picks into container `media/`, references containers |
| `useCardIdFromChatName`   | Resolves a `?chat=<chatName>` URL param to a cardId. Optional `{ ready, onChatNotFound }` lets hosts gate on Yjs sync + clean up the URL when the chat genuinely doesn't exist |
| `useAssignedCommentCount` | `(cards, entries, activeCardIds, currentUserEmail) => number` — open active comments assigned to the current user. The toolbar badge is personal by design: a document-wide unresolved count showed the same red number to every viewer, including for threads owned by someone else |
| `readCards`, `writeCardToDoc`, `applyCardPatch` | Pure Y.Doc helpers (React-free, unit-tested) |

`useCommentCards` reads the map synchronously on mount (a host mounting after sync must see its
cards on the first effect run, or `?chat=` deep links die against an empty map) and preserves card
object identity across refreshes so memoized card components skip re-rendering. Deleting a card is
host-specific (the anchor strip *is* the delete); there is no shared delete hook.

## Shared UI components

### NoteCard (`packages/ui/src/components/notes/`)

Shared card component used across all apps for list-row rendering. Renders a colored card with
title, description, status icon, and reply count. Also provides `NoteCardDialog` (dialog shell
with chat-thread slot).

### CommentMenuItems (`packages/ui/src/components/comments/comment-menu-items.tsx`)

The single source of truth for the "Add / View / Color / Resolve / Reopen / Delete" menu used
across all four apps. Renders items inside whichever menu family the host uses by accepting a
`primitives` slot (`{ Item, Sub, SubTrigger, SubContent }` — either Radix `DropdownMenu*` or
`ContextMenu*` works). The `noun` prop tunes labels (`"comment"` by default, stickies passes
`"sticky"`).

### Assignee UI (`packages/ui/src/components/comments/`)

One shared searchable people-list recipe backs every assignment surface: `MemberCommandList`
(cmdk `Command`; search hidden ≤ 8 members, `max-h-56` scroll, "n people" footer; pinned rows
render in a `header` slot outside the filtered list so typing never hides them), `MemberAvatar`
(tiny tooltip avatar via `useResolvedUser`), `AssigneeChip` (avatar + resolved name). On top of
those: `AssigneePicker` (Popover trigger = children; pinned **Assign to me** / **Unassigned**) used
by `CardFormDialog` (staged, applied on Save — `onSave`'s third arg, `undefined` = untouched) and
`CardDialog` (inline chip reassign, immediate PATCH); `AssigneeMenuItems` (an **Assign to** submenu whose members are real menu items, so arrow-key roving and the mobile drill-in page work) embedded in `CommentMenuItems`, which gained optional `members`/`currentUserEmail`/`onAssign` props — the current assignee reads from `item.entry.assignee`, and the callbacks carry `card.title` so the server can cache it. Every host gets these from `CommentLifecycleMenuItems`, so the wiring is identical in all apps. `NoteCard`
renders a muted assignee `MemberAvatar` at the far right of its footer meta row (`assigneeEmail`
prop, board + panel pass `entry?.assignee`).

### CommentLifecycleMenuItems (`packages/ui/src/components/comments/comment-lifecycle-menu-items.tsx`)

Binds every comment row — view, **edit**, colour, assign, resolve/re-open, delete — to a `useCommentLifecycle` bundle, so all hosts offer the same actions from one wiring and a new row lands everywhere at once. A host passes only what its anchor decides: the `item` under the cursor, `canWrite`, and its own `onAddComment`/`onDelete` (those strip or write the host anchor). Every mutating row is gated on `canWrite` here, not per app. Two hosts render it: `<CommentContextMenu>` (docs, stickies, the two canvas apps, the panel rows) and the sheet's cell menu via `hooks.commentLifecycle`. Selecting a row closes the host menu on its own — every row is a real menu item, and `ContextMenuAnchor` turns Radix's close into the singleton menu's `close()`.

**Edit** calls `lifecycle.openCardForEdit(cardId)`, which opens `<CardDialog>` straight in its edit form. Edit mode lives in the lifecycle bundle (`openCardEditing` / `setOpenCardEditing`) pinned to a card id, so opening a different card lands in view mode with no reset effect.

### CommentContextMenu (`packages/ui/src/components/comments/comment-context-menu.tsx`)

Convenience wrapper that pairs `<CommentLifecycleMenuItems>` with the project's singleton `useContextMenu` + `ContextMenuAnchor` pattern; `noun` tunes the labels (stickies passes `"sticky"` through `<CommentLifecycleDialogs>`). All four editors render it via `<CommentLifecycleDialogs>`.

### CommentLifecycleDialogs (`packages/ui/src/components/comments/comment-lifecycle-dialogs.tsx`)

Renders the `<CardDialog>` + `<CommentContextMenu>` pair driven by a `useCommentLifecycle` bundle.
The host owns the `useContextMenu` instance and supplies the per-app `onDelete` that strips the
host anchor. Optional `noun` and `onCardDialogClose` (stickies clears its `?chat=` URL param on
close).

### CommentPanel (`packages/ui/src/components/comments/comment-panel.tsx`)

Properties-panel overlay showing all comments for a document. The caller passes `cards`, `entries`,
`activeCardIds`, and `anchorTexts` — the panel is pure projection.

- **Filter** (`CommentFilterButton`, title-row `ListFilter` popover): assignee (Anyone / Me / Unassigned /
  member), color swatches, and status (Open default / Resolved / All). The host owns one
  `useCommentFilter()` instance; the panel projects via `matchesCommentFilter`. Active filters show
  a summary strip (status label always leads) + "n hidden · Clear filters" footer; the empty state
  offers Clear filters. Cards without an entry yet are treated as "open" and unassigned. The old
  All/For-you tabs + status Select are gone.
- **Hosting**: `CommentPanel` and `ActivityPanel` are list bodies with no chrome. Docs, slides and sheets mount the same `PanelColumn` (`packages/ui/src/components/comments/panel-column.tsx`) on every viewport: one `Column` with id `panel` whose toolbar carries `ToolbarTitle`, `CommentFilterButton` in comments mode, and the close affordance — `Column`'s own back arrow below the breakpoint, an X above it. `Column` also sizes the pane: full width on mobile, a `PROPERTIES_PANEL_WIDTH_PX` sibling with `border-l` on desktop, so hosts drop their own width. Mount it outside any `<ColumnLayout mobileColumn="…">` — a `Column` self-hides when its id doesn't match, so a host that wraps it gets no pane at all, silently. Props are pure projection plus one `onOpenCard(cardId)`. On mobile every host passes plain `setOpenCardId`: the editor is hidden while the pane is up, so scroll-to-mark (docs) and the slide + element reveal (slides) would drive a view nobody can see, and an activity row's card opens over the Activity pane rather than switching it to Comments under the dialog. On desktop docs and slides pass their reveal, and docs' activity tap still switches to Comments. `activeComments` is the one optional prop — an activity-only host (stickies) never renders the comments body. Those three hide the editor (a `hidden` wrapper) rather than unmounting it and mount the pane's `Column` as a sibling, so tiptap node views, slide thumbnails, scroll position and selection survive a pane visit — that is also why docs' two resize observers and the sheet engine's skip 0×0 boxes (`display: none` measures zero) and why docs' figure node view refuses to size an image off a 0-width page. Hiding takes the find bar with it, so each of the three passes `DocSearchProvider`'s `onOpenChange` and closes the pane when a session opens below the breakpoint (⌘F, a palette in-document hit) — the bar would open inside the hidden editor otherwise. Desktop keeps its layout: slides and sheets mount the pane as a right-hand sibling, docs inside its absolute right-edge overlay. **Stickies is the fourth host and is desktop-only**: it mounts `PanelColumn` for activity behind `!isMobile`, hides nothing and passes no `onOpenChange`, and its toolbar toggle is absent on mobile. Giving stickies the mobile pane is recorded as next-round work in [MOBILE.md](MOBILE.md). **Both canvas apps are the fifth host** — slides and vector share one anchoring path, and slides adds the deck's own reveal (opening a card activates that element's slide, then selects it). Cards live in the doc's `comments` Y.Map and anchor per element through `VectorElementBase.commentCardIds` — a JSON id **string**, not an array, because every stored canvas field is a scalar. A card raised from the canvas object menu anchors to that element; one raised from the pane stays document-level, so `PanelColumn` keeps its optional `onAddComment` — a "New comment" button in the comments-pane toolbar that only renders when a host passes it; content-anchored hosts omit it and are unaffected. The canvas' card delete removes the map entry and strips the id from its anchor element, and is deliberately outside the canvas `UndoManager` scope (tracking the comments map would let ⌘Z resurrect cards mid-edit — every host keeps comment maps untracked).
- **Open state**: `useDocumentPanels(isMobile)` (`@workspace/lib/comments`) owns the comments/activity
  pair for docs, slides and sheets — one `panel: 'comments' | 'activity' | null` slot, so the two can
  never both be open. Host-owned like `useCommentFilter`. It also returns `mobilePanelOpen` and the
  `onSearchOpenChange` handler every host hands to `DocSearchProvider`.

### Comment filters (`packages/lib/src/core/comments/filter.ts` + filter UI)

Session-only client state, never persisted. Model: `CommentFilter = { assignee: 'all' | 'me' |
'unassigned' | { email }, colors: Set<string> | null, status: 'open' | 'resolved' | 'all' }` with
`useCommentFilter(defaults?)` (state + `isActive` + `clear()`) and the pure, unit-tested
`matchesCommentFilter(card, entry, filter, currentUserEmail)`.

**Placement rule (Reinder, 2026-07-10): the filter control lives on the surface it filters.**
Docs/slides/sheets filters narrow only the comments panel, so their only control is the panel's
`CommentFilterButton` — there is deliberately NO toolbar View menu (a toolbar menu would mutate
invisible state while the panel is closed). Stickies filters the board itself, so its toolbar
Filter menu (the former mobile-only dropdown, now on all viewports) hosts the same three groups
via `CommentFilterMenuItems` (a primitives-slot component like `CommentMenuItems`); the center
color-dot row stays as the desktop quick affordance and shares the same filter instance. The
pinned Anyone/Me/Unassigned block is shared between button and menu as
`PinnedAssigneeFilterRows` (internal to `packages/ui/.../comments/`). The one-line active-filter
summary ("Open · assigned to me" + Clear) is the shared `FilterSummary` component — the panel
renders it as a full-width strip, the stickies toolbar inline (`inline` prop) after the color
dots. Member lists hide the current user's named row (the pinned Me row covers them). Menu close
semantics: single-choice picks (assignee, status, Clear) dismiss the stickies Filter menu; color
swatches keep it open for multi-toggle.

### CommentThread (`packages/ui/src/components/comments/comment-thread.tsx`)

Single comment thread: resolves `chatName` to `chatId` via `useMediaResolver`, renders
`ChatMessageList` + `ChatMessageInput`. Embedded inside `<CardDialog>` when a card has a `chatName`.

### CardForm + CardFormDialog (`packages/ui/src/components/cards/`)

`CardForm` is the shared create/edit form (title input, `LightEditor` description, attachment
staging, one non-wrapping meta row: compact `ColorPicker` left + `AssigneePicker` right),
selected by a `mode` prop. It renders in two shells: `CardFormDialog` (a thin standard-Dialog
wrapper — the create flow) and in-place inside `CardDialog` via `NoteCardDialog`'s `editForm`
slot (the edit flow — no second dialog is ever stacked). Its field area scrolls with the
Save/Cancel `DialogFooter` pinned, so short viewports get a scrollbar instead of overflow.
The host wires `mode="create"` to `useCreateCommentCard` — typically:

```ts
const handleSaveNew = async ({ title, description, color }) => {
    await createCard({ title, description, color }, (card) => {
        // anchor: TipTap mark / commentCardIds append / column taskIds push
    });
};
```

- **`mode="create"`** (default) emits concrete values (trimmed title + seeded color) so a new card
  never persists an empty title or a missing color.
- **`mode="edit"`** emits a minimal patch (changed fields only), so an unchanged save is a no-op
  Yjs update.

Description is edited via `<LightEditor>` and sanitized on read in `useCommentCards` (`sanitizeCommentCardHtml`, the LightEditor allowlist plus task lists) because a peer's raw Y.Doc write reaches every viewer's `dangerouslySetInnerHTML`; color via the shared `<ColorPicker>`
(`EIGEN_STICKIES_COLORS`). Card creation is lazy: clicking "Add comment" opens the dialog purely
client-side; the backend is only touched on Save.

### CardDialog (`packages/ui/src/components/cards/card-dialog.tsx`)

Shared view/edit dialog. Wraps `<NoteCardDialog>` with `<CommentThread>` inside. The pencil
toggles **in-place edit**: `CardForm mode="edit"` replaces the body inside the same dialog
(thread + reply composer hidden while editing; never a stacked dialog). View-mode height
contract: everything above the thread caps at ~60% of the dialog (42vh of the 70vh dialog cap;
the description scrolls internally) so the thread + reply input always keep the rest; the meta
footer row has a stable height so assigning (Unassigned ↔ avatar chip) never shifts layout.
Optional `onResolve`/`onAssign` for apps that surface resolve/assign at the dialog level.

## Per-app integration

### Docs

- TipTap mark `CommentMark` carries attribute `cardId`.
- `useActiveComments(editor)` walks the doc and collects `Set<cardId>` + first-anchor texts.
- `comment-mark.ts` decoration plugin keys decoration colors by `cardId` from the `cards` map.
- On selection right-click → CardFormDialog opens with the selected text as `initialTitle`. On save,
  `useCreateCommentCard`'s `anchorInTransact` callback runs `editor.chain().setComment(card.id)`.

### Sheets

- `Cell.commentCardIds?: string[]` (one-or-more cardIds per cell).
- `useActiveComments(flowdata)` scans the cell matrix; anchor text is `"Cell A1"` etc.
- Sheet canvas draws an indicator triangle; color comes from `hooks.getCommentInfo(r, c)` which the
  host wires up.
- Add Comment fires `hooks.onAddComment(r, c)`; the host opens CardFormDialog with the cell ref as
  initial title and then `setCellFormat(r, c, 'commentCardIds', [...existing, card.id])`.

### Stickies

- `tasks` Y.Map kept (legacy name; cards there are full `CommentCard`s). The board consumes
  `useCommentLifecycle({ mapName: 'tasks', ready: isSynced, ... })` + `<CommentLifecycleDialogs
  noun="sticky">` like its siblings; `useBoard` only manages columns/order, the provider, and the
  UndoManager.
- Cards are anchored by column membership in `columnsMap.<col>.taskIds`.
- Board-wide filtering: the board owns `useCommentFilter({ status: 'all' })` (resolved cards show
  by default); `columnCards` filters via `matchesCommentFilter` against `entryByChatName`, and the
  toolbar Filter menu + color-dot row drive the same instance (see the filter section above).
- Delete is a board-level helper `deleteCardFromBoard(cardId)` that walks columns + removes the
  Y.Map entry in one `transact` (single undo step, no orphan column refs).

### Slides and Vector (the canvas)

- `VectorElementBase.commentCardIds` is a JSON id string on the element (`parseIdList` / `serializeIdList`); the host adds and removes an id inline through those two. `elementForCommentCard` (`packages/lib/src/vector/comments.ts`) resolves a card back to its anchor element.
- `useCanvasComments(elements, cards)` builds the `ActiveComments` projection: every card is active, and `commentAnchorTexts` gives each anchored card the element's own `searchText` (first anchor wins, falling back to the kind's UI label).
- A commented element flags its top-right corner on the canvas; clicking the flag opens its first card, and opening a card from the panel selects its anchor element.
- On Add Comment from the canvas object menu the host appends the card id to that element once `createCard` has resolved — a separate `updateElement`, not `useCreateCommentCard`'s in-transaction anchor, because the card only exists after an awaited server call. The append is idempotent, so a double submit lists the card once. From the pane the card stays document-level.

## Active vs orphaned comments

The Y.Doc is the source of truth for which cards are "active":
- Anchor present in host content (mark / commentCardIds / column membership) → active
- Anchor absent (user removed it) → orphan; Y.Map entry, `.eigenchat`, and `comments.db` row all
  persist for undo/redo and version revert. CommentPanel hides orphans by intersecting
  `activeCardIds` with `cards`.
- **The canvas is the exception**: every card in a vector document's `comments` map is active, so a card whose anchor element was deleted degrades to a document-level comment instead of disappearing from the panel. Its row then falls back to the kind's label rather than an anchor text.

## Key files

| File                                                                | Purpose                                       |
|---------------------------------------------------------------------|-----------------------------------------------|
| `apps/api/src/lib/chat/comment-schema.ts`                           | Drizzle schema (v5)                           |
| `apps/api/src/lib/chat/comment-db-config.ts`                        | DB config + v1–v5 migrations (v3: `recentText` + FTS; v4: `assignee`; v5: `title`) |
| `apps/api/src/lib/chat/comment-index.ts`                            | CommentIndex + `openCommentIndex` + `getCommentIndex` |
| `apps/api/src/lib/drive/drive.ts`                                   | `seedCommentRow` helper called from `Drive.create` |
| `apps/api/src/routes/collab.ts`                                     | Comment REST routes (list + search + status)  |
| `packages/lib/src/core/chat/hooks/use-comments.ts`                  | Server-side metadata hooks + invalidation     |
| `packages/lib/src/core/comments/`                                   | Y.Doc card hooks + helpers + filter model (+ unit tests) |
| `packages/lib/src/types/comments.ts`                                | `CommentCard` type                            |
| `packages/lib/src/types/chat.ts`                                    | `CommentEntry` type (server projection)       |
| `packages/lib/src/docs/eigendoc/nodes/comment-mark.ts`              | TipTap mark schema (attr `cardId`)            |
| `packages/lib/src/sheets/types.ts`                                  | `Cell.commentCardIds`                         |
| `packages/lib/src/vector/comments.ts`                               | Canvas anchoring helpers over `commentCardIds` (slides + vector) |
| `packages/ui/src/components/cards/`                          | Shared CardFormDialog + CardDialog |
| `packages/ui/src/components/comments/`                       | PanelColumn + CommentPanel + ActivityPanel + CommentThread + CommentMenuItems + CommentContextMenu + CreatedByMeta |
| `packages/ui/src/components/notes/`                          | NoteCard + NoteCardDialog                     |
| `apps/docs/src/components/docs/editor.tsx`                          | Docs editor integration                       |
| `apps/docs/src/components/docs/extensions/comment-mark.ts`          | ProseMirror plugins (interaction + decorations) |
| `apps/slides/src/components/slides/editor.tsx`                      | Slides editor integration (the canvas anchoring path) |
| `apps/sheets/src/components/sheets/editor.tsx`                      | Sheets editor integration                     |
| `apps/sheets/src/components/sheets/hooks/use-active-comments.ts`    | Scan cell matrix for cardIds                  |
| `apps/stickies/src/components/stickies/board.tsx`                   | Stickies board adoption                       |
| `apps/stickies/src/components/stickies/hooks/use-board.ts`          | Stickies hook (+ `deleteCardFromBoard`)        |
