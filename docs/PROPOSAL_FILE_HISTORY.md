# Proposal: File History + Watch

> **TLDR**: Every Drive path grows a typed event log — *created, uploaded, edited,
> renamed, moved, copied, trashed,* and Eigendoc-specific ops like *sticky-moved*.
> Two new tables in the mount's `metadata.db`: `file_events` (the timeline) and
> `path_watchers` (who wants notifications). Any user with read access can **Watch**
> a file or folder; folder watches cascade to descendants. Events fan out through
> the existing `NotificationCenter` + `home-relay.sendToHome` pipeline — one
> notification per file with `tag`-based coalescing, not one per event. UX surfaces
> a bell toggle in the file menu and in each Eigendoc toolbar, a *Recent Activity*
> section in the Drive properties panel, and a *Watched* row in the unified app
> sidebar. The only new SSE plumbing is one extra case in the existing notification
> handler — no new event types, no new cross-domain infrastructure.

## Goals

1. Per-file timeline of meaningful events — visible in a *Recent Activity* section
   on the file's properties, scoped to anyone with read access.
2. **Watch** a file or folder to receive notifications when new events land. Folder
   watches cascade to descendants, including ones added later.
3. Coverage extends beyond plain Drive mutations: stickies and slides record their
   own semantic events (sticky moved between columns, slide reordered) via a single
   thin endpoint.
4. Fan-out reuses the existing `NotificationCenter` so users see one notification
   per file with a running coalesced count, not one toast per keystroke.
5. The shape extends to future event types by adding a string to a union — not a
   new table.

## Non-goals

- **Generic cross-domain activity feed.** Mail, calendar, contacts each have their
  own timeline shapes; this proposal is *Drive-paths only*. A future *Recent
  activity* in Space app can union the per-mount logs but isn't part of v1.
- **Replay / undo.** History is descriptive, not reversible. Yjs `doc_updates`
  keep the byte-level revisions for collab docs; that's an orthogonal concern.
- **Per-event subscription filters.** Watch is on/off per path; users don't pick
  "only notify me about renames". Saves UI complexity and keeps the data model flat.
- **Watching as a permission model.** Watch never grants access — it only attaches
  a notification preference to an existing read grant.
- **Persisting history past permanent delete.** FK cascade cleans it up. Trashed
  paths keep their history; restore brings it back.
- **Migration of pre-feature events.** Eigen is pre-release; no backfill — the
  timeline starts at upgrade time.
- **Per-actor `'edited'` events on docs and sheets in v1.** TipTap Collaboration
  and the sheet engine own their Yjs updates internally; there is no client-side
  debounce surface to hook today, and Yjs awareness isn't yet mapped to user IDs
  on the server. Stickies and slides emit attributed semantic events from the
  client (drag handlers go through a single `yjsDoc.transact` boundary); docs and
  sheets get `'edited'` in v2.

## Why now

The notification system (`NOTIFICATION-CENTER.md`) covers cross-user *announcements* —
shares, mentions, calendar invites — but every notification is a one-shot toast scoped to
one user. There's no answer to "what happened to this document last week" or "tell me when
my colleague edits this folder". Three forces converge:

- Drive emit points already exist for every mutation (`drive.ts` already broadcasts
  `DRIVE_FOLDER_CREATED`, `DRIVE_PATH_MOVED`, `DRIVE_ACL_UPDATED`, …) — they just don't
  persist.
- Eigendoc apps are coming into their own as collaboration surfaces (stickies, slides,
  sheets, docs) and users need to know who changed what without opening the file.
- `NotificationCenter.persist()` already has `tag`-based upsert, which is exactly what
  prevents fifty edit-notifications becoming fifty rows in the bell.

Building on these means the new code is two tables, one domain class, and a notification
fan-out — not a new SSE channel or a new cross-domain audit framework.

## Architecture

```
data/home/{ownerId}/mounts/{mountId}/metadata.db
├── paths                       (existing)
├── file_events                 (new — the timeline)
└── path_watchers               (new — who gets notified)
```

A new module under the existing Drive layer:

```
apps/api/src/lib/drive/
  history.ts          # FileHistory — record(), list(), fan-out, watcher add/remove/list
  history-schema.ts   # Drizzle: file_events, path_watchers (added to mount.metadata.db)
```

`FileHistory` is owned by `Mount` (next to `paths`), same lifecycle, same db. Drive's
existing `emit()` call sites gain a sibling `mount.history.record(...)` call when an
actor is known — see § Actor for the threading.

### Two emission paths

Most events come from the server itself. Eigendoc-internal events (sticky moves, slide
reorders) the server can't see — Yjs updates are opaque blobs — so the apps emit them
explicitly via one endpoint.

```
                       SERVER                                  CLIENT
        ┌───────────────────────────────────┐    ┌─────────────────────────────────┐
        │ drive.createFolder()              │    │ stickies sees Y.Map column      │
        │ drive.uploadFiles()               │    │ change → POST .../history       │
        │ drive.movePath() / renamePath()   │    │ slides sees slide reorder       │
        │ drive.copyPath() (incl. recursion │    │ → POST .../history              │
        │   inside Mount.copyPath)          │    │                                 │
        │ drive.updateACL()                 │    │ (server validates write access  │
        │ drive.trashPath() / restorePath() │    │  before recording)              │
        │ comment posted (in chat domain)   │    │                                 │
        └────────────────┬──────────────────┘    └────────────────┬────────────────┘
                         │                                        │
                         └─────────────────┬──────────────────────┘
                                           ▼
                              mount.history.record({...})
                                           │
                       ┌───────────────────┴────────────────────┐
                       ▼                                        ▼
              INSERT into file_events            fanOut(pathId, eventType)
                                                                │
                              walk parentId chain → enumerate watchers (this path + ancestors)
                                                                │
                              skip actor; dedupe across ancestors; verify each still has read access
                                                                │
                              sendToHome(subscriberId, { type: 'notification', notification: {...} })
                                                                │
                              NotificationCenter.persist({ tag, type: 'file-event', ... }) → SSE toast
```

### Why per-mount, not per-home or per-server

Three reasons keep history co-located with paths:

- **Cascade-on-delete is automatic.** FK `pathId → paths.id ON DELETE CASCADE` cleans
  up history without a separate sweep when paths are permanently deleted.
- **Homes are the sharding unit** (see [SCALABILITY.md](SCALABILITY.md)). Mounts belong
  to a single home, so colocating history with `paths` keeps a single mutation inside
  one DB transaction. Cross-home reads (watchers in another user's home) already go
  through `home-relay.ts`; history inherits that.
- **No new database file.** Reuses `metadata.db` — one more table per mount, no new
  `DatabaseConfig`, no new singleton.

## Data model

Added to mount `metadata.db` (existing schema bump — Eigen is pre-release, no migration
boilerplate per project convention):

```typescript
// apps/api/src/lib/drive/history-schema.ts
export const fileEvents = sqliteTable('file_events', {
    id: text('id').primaryKey(),
    pathId: text('pathId').notNull().references(() => paths.id, { onDelete: 'cascade' }),
    eventType: text('eventType').notNull(),       // FileEventType, see below
    actorUserId: text('actorUserId').notNull(),
    actorEmail: text('actorEmail').notNull(),     // denormalized for display without a join
    details: text('details', { mode: 'json' }),   // type-specific payload, typed per eventType
    createdAt: integer('createdAt', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, t => [index('idx_file_events_path_created').on(t.pathId, t.createdAt)]);

export const pathWatchers = sqliteTable('path_watchers', {
    pathId: text('pathId').notNull().references(() => paths.id, { onDelete: 'cascade' }),
    userId: text('userId').notNull(),
    createdAt: integer('createdAt', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, t => [primaryKey({ columns: [t.pathId, t.userId] }), index('idx_path_watchers_user').on(t.userId)]);
```

Shared types in `packages/lib/src/types/file-history.ts`:

```typescript
export type FileEventType =
    | 'created'   | 'uploaded'  | 'edited'
    | 'renamed'   | 'moved'     | 'copied'
    | 'acl-changed'
    | 'trashed'   | 'restored'  | 'deleted'
    | 'commented'
    // Eigendoc-emitted (client posts these via POST .../history):
    | 'sticky-added' | 'sticky-moved' | 'sticky-removed'
    | 'slide-added'  | 'slide-removed' | 'slide-reordered';

export type FileEventDetails = {
    renamed:  { oldName: string; newName: string };
    moved:    { oldParentId: string; newParentId: string };
    copied:   { sourceOwnerId: string; sourceMountId: string; sourcePathId: string };
    'acl-changed': { added: string[]; removed: string[] };
    'sticky-moved': { stickyId: string; oldColumn: string; newColumn: string };
    // …one entry per eventType, undefined for events with no details
};
```

`details` is JSON in storage but **typed per `eventType` in code** — the `FileHistory.record`
signature uses a discriminated union so callers can't pass a malformed payload. The
hand-rolled JSON column is constrained by the type system, matching the typing rules in
[CODE-STANDARDS.md](CODE-STANDARDS.md#typing).

## Actor

History is only useful if it points at the actual human. Today `Drive` methods don't
carry the calling user — they run against `this.owner = home.user`, which for a
`UserHome` happens to be the caller but for a `TeamHome` is the team pseudo-user.
Recording `this.owner` would attribute every team-drive action to the team. That's not
acceptable.

Of fifteen route-callable `Drive` methods, three (`updateACL`, `inviteToChat`,
`receiveACLChange`) already accept an explicit actor. The remaining twelve
(`createFolder`, `create`, `uploadFiles`, `createFileFromData`, `deletePath`,
`restorePath`, `permanentlyDelete`, `emptyTrash`, `movePath`, `renamePath`, `copyPath`,
`writeFileContent`) need an optional `user: User` parameter. `SharedDrive` wrappers
already hold `this.user` (the request caller) and thread it through. The escape-hatch
routes (`/shared/by-me`, `/shared/with-me`) are read-only listings, so they don't need
history recording at all.

When `user` is omitted — the case for internal scaffolding like
`ChatRoom.create` → `drive.touchFile` / `drive.createFolder('media')` — history is
*not* recorded. Internal seed files shouldn't appear in the user-visible timeline. The
"no actor → no history row" rule is a locally checkable property: the recorder takes a
non-null `User` and returns void; absence means absence.

## Event emission

### Server-side: hooked into existing `drive.ts` emit sites

Every place in `Drive` that already calls `this.emit(DRIVE_*, path)` gains a sibling
`mount.history.record({ actor, eventType, pathId, details })` when an actor is supplied.

| Existing call site                            | New event       | Details                                          |
|-----------------------------------------------|-----------------|--------------------------------------------------|
| `createFolder`                                | `created`       | —                                                |
| `create` (Eigendoc container)                 | `created`       | —                                                |
| `uploadFiles` (via `finalizeUpload`)          | `uploaded`      | `{ size }`                                       |
| `writeFileContent`                            | `uploaded`      | `{ size }`                                       |
| `movePath`                                    | `moved`         | `{ oldParentId, newParentId }`                   |
| `renamePath`                                  | `renamed`       | `{ oldName, newName }`                           |
| `copyPath` (root and descendants)             | `copied`        | `{ sourceOwnerId, sourceMountId, sourcePathId }` |
| `updateACL`                                   | `acl-changed`   | `{ added, removed }` (email diff)                |
| `deletePath` / `restorePath` / `permanentlyDelete` | `trashed` / `restored` / `deleted` | — |
| `ChatRoom.postMessage` (embedded chat only)   | `commented`     | `{ commentPreview }` (first ~80 chars)           |

Two notes on coverage:

- **`copyPath` recursion**. `Drive.copyPath` delegates to `Mount.copyPath`, which calls
  `Mount.createFolder` / `Mount.createFileFromTemp` directly — Drive's `emit()` never
  fires for descendants. So descendants of a copied folder produce zero SSE events
  today, and naïvely hooking only `Drive.copyPath` would inherit the same blind spot.
  The fix lives **inside** `Mount.copyPath`: each recursive call records a `copied`
  row with the descendant's source coordinates, and the top-level `Drive.copyPath`
  records its own at the root. The actor flows through as a second parameter on
  `Mount.copyPath`. While we're here, `Drive.copyPath` should also start emitting
  `DRIVE_FILE_CREATED` / `DRIVE_FOLDER_CREATED` at the root — closing the pre-existing
  SSE gap as a side benefit.
- **ACL share / unshare**. `Drive.updateACL` is the originator, runs in the *owner's*
  home, and already accepts an actor — that's where the `acl-changed` row goes.
  `Drive.receiveACLChange` runs in the *recipient's* home, where the path isn't in
  the recipient's mount; it produces a share/unshare *notification* (which is what
  the existing code already does) but no history row. The owner-side `acl-changed`
  event is the canonical record.

The Yjs `throttledTouchUpdatedAt` in `CollabDocument` is **not** hooked. Without an
awareness → user mapping the actor would be unknown (or worse, attributed to the
home owner). Docs and sheets land in v2 once awareness IDs are linked to user IDs.

### Client-side: one endpoint for Eigendoc semantic ops

Stickies and slides observe their own Yjs state through a single `yjsDoc.transact`
boundary (the drag-end handler in each app's DnD hook) and `POST` semantic events when
they spot one. The server doesn't try to diff blobs.

```
POST /drive/:ownerId/mounts/:mountId/paths/:pathId/history
body: { eventType: FileEventType, details?: FileEventDetails }
```

Guard: caller has **write** access on the path (writing to history is a write-class
action, even though watching is read-class). Server accepts only the client-emittable
subset of `FileEventType` — `'sticky-added'`, `'sticky-moved'`, `'sticky-removed'`,
`'slide-added'`, `'slide-removed'`, `'slide-reordered'`. Server-only types
(`'created'`, `'moved'`, `'acl-changed'`, …) are rejected. Dedupe window: identical
`(actor, eventType, JSON.stringify(details))` within 30 s collapses to the latest
insert.

Apps decide when to call:

| App      | When to POST                                                                            |
|----------|-----------------------------------------------------------------------------------------|
| Stickies | On column / task drag end (single `yjsDoc.transact` in `use-drag-and-drop.ts`)          |
| Slides   | On slide reorder / add / remove (single `yjsDoc.transact` in `use-slide-dnd.ts`)        |
| Docs     | v2 — no client-side debounce surface today (TipTap Collaboration owns Yjs internally)   |
| Sheets   | v2 — sheet engine owns its Yjs updates; no exposed mutation boundary                    |

A small `useRecordHistory(ownerId, mountId, pathId)` hook in
`packages/lib/src/core/drive/hooks/` wraps the POST so app code does
`recordHistory({ eventType: 'sticky-moved', details: { stickyId, oldColumn, newColumn } })`.

## Watch model

### Routes (under existing Drive router)

```
POST   /drive/:ownerId/mounts/:mountId/paths/:pathId/watch    Watch (caller has read access)
DELETE /drive/:ownerId/mounts/:mountId/paths/:pathId/watch    Unwatch
GET    /drive/:ownerId/mounts/:mountId/paths/:pathId/watch    Is watched? (caller scope)
GET    /drive/:ownerId/mounts/:mountId/paths/:pathId/history  Paginated timeline (read access)
                                                              ?limit= &before=ISO
GET    /drive/:ownerId/watches                                The caller's watches on this owner's mounts
```

"All my watches across every owner" — the FE walks `/drive/:ownerId/watches` for each
owner it has visibility on (own home; team homes; owners of paths in the share
registry). Cached per owner. A future v2 may mirror watch state into the watcher's own
home for a single local query, but it isn't worth the dual-write complexity today.

### Fan-out query

Once a row lands in `file_events`, fan-out walks `paths.parentId` and joins
`path_watchers` in one recursive CTE:

```sql
WITH RECURSIVE ancestors AS (
    SELECT id, parentId FROM paths WHERE id = :pathId
    UNION ALL
    SELECT p.id, p.parentId FROM paths p JOIN ancestors a ON p.id = a.parentId
)
SELECT DISTINCT pw.userId
FROM   path_watchers pw
WHERE  pw.pathId IN (SELECT id FROM ancestors)
       AND pw.userId != :actorUserId;
```

For each returned user, the owner-side mount re-verifies read access via
`canReadFromAncestors` (defensive — a watcher whose share was revoked after subscribing
is silently skipped). Then `sendToHome(watcherUserId, { type: 'notification',
notification: { ... } })`. No watch-cleanup job in v1; defensive verification is enough.

### ACL semantics

- **Subscribing**: caller needs read access on the path. The check uses the existing
  `matchesACL(path.acl, callerId)` plus ownership / team-membership checks — the same
  gate as `GET path`.
- **At fan-out**: subscriber's read access is re-verified at notification time.
- **Folder cascade**: a watch on folder F notifies on events for F and *any* path with
  F in its `parentId` chain (the CTE above).

### Where watch state lives

Watch state lives **only on the owner's mount** — `path_watchers(pathId, userId)`.
Fan-out joins `paths` + `path_watchers` to enumerate ancestor-watchers in one query.
"Show me everything I watch" reads each owner-home via the per-mount endpoint, never
aggregating across servers.

### Self-events suppressed

The actor of an event is skipped in the fan-out: editing your own doc doesn't toast you.
Watching is only useful for *other people's* changes (matches GitHub's mute-own behaviour).

## Notification fan-out

```typescript
// Inside FileHistory.fanOut(...)
home.notifications.persist({
    type: 'file-event',
    actorEmail: event.actorEmail,
    title: `${actorDisplayName} ${eventVerb(event)} ${path.name}`,
    body: undefined,
    tag: `file-event:${ownerId}:${mountId}:${pathId}`,
    coalesce: true,
});
```

The existing `INSERT … ON CONFLICT(tag) DO UPDATE` upsert collapses multiple events
on the same file into one DB row: `createdAt`, `read`, title, and `actorEmail` all
update in place. The bell list stays correct.

**Toast-side coalescing is not automatic today.** `NotificationCenter.persist` calls
`home.broadcast(buildNotificationCreatedEvent(...))` on every invocation, and
`handleNotificationSSEvent` calls `toast()` unconditionally. Fifty edits on a watched
doc would currently produce fifty toasts even though the underlying DB row coalesces.
The fix is one small extension on `persist`:

```typescript
persist(input: PersistInput & { coalesce?: boolean }): Notification
```

When `coalesce: true` *and* the upsert hit an existing row whose `createdAt` is within
a per-tag throttle window (e.g. 30 s), the SSE broadcast is skipped. The DB row still
updates; the bell list catches up on the next refetch. Other call sites (`share`,
`mention-chat`, mail) keep their current always-broadcast default.

### Existing comment notifications stay as-is

`ChatRoom.postMessage` already emits `mention-comment` and `comment-reply`
notifications via `sendToHome`. Those stay; the proposal does **not** add a parallel
`file-event` notification for `'commented'`. Adding one would double-toast every
comment (`comment-reply:…` and `file-event:…` use different tags, so they wouldn't
collide). The `'commented'` event still lives in the history timeline (so the
properties panel's *Recent Activity* shows it), but the notification channel for
comments remains the existing one.

### Tag parsing

`packages/lib/src/core/notification/resolve-link.ts` gets one new clause. The
`parseDriveTag` helper already handles `share` / `mention` / `chat-message` /
`comment-reply` prefixes; we widen its prefix allowlist to include `'file-event'`,
add `'file-event'` to `isClickableNotification`, and add the case to
`resolveNotificationLink` (parsing `file-event:{ownerId}:{mountId}:{pathId}` and
calling the existing `driveApi(...).path({pathId}).get()` → `getDriveItemUrl(path)`
flow).

### Deep-linking with the history panel open

`getDocumentUrl()` (and the `get*Url` helpers it delegates to) doesn't currently
accept query params. The simplest path: append `?showHistory=1` post-hoc in
`resolveNotificationLink` for the `file-event` case, and have each Eigendoc app's
root route effect read the param on mount and open the properties panel. One extra
line per Eigendoc app shell; no helper-API changes.

## UX

### Watch verb

Following GitHub: **Watch** / **Stop watching**. Short, action-y, no overlap with
existing Eigen verbs. Backend matches: `path_watchers` table, `Watchers` domain class,
`useWatch` hook family.

### Where the toggle appears

| Surface                               | Element                                                |
|---------------------------------------|--------------------------------------------------------|
| Drive row context menu                | "Watch" / "Stop watching" item in `DriveItemMenuItems` |
| Open Eigendoc app toolbar             | Bell `TooltipButton`, `active` when watched            |
| Drive properties panel — header strip | Bell button next to share button                       |
| Drive properties panel — *Recent Activity* footer | Inline "You're watching this · Stop watching" link |

`DriveItemMenuItems` is the single source for per-item actions across Drive and the
Eigendoc apps, so adding one menu item lights up all of them. The toolbar bell is a
new `TooltipButton` (its `active` prop already toggles filled/outline rendering),
sourced from a shared `<WatchToggleButton>` in `packages/ui/src/components/layout/`.

### Recent Activity in the properties panel

The Drive properties panel (`packages/ui/src/components/layout/properties-panel/`)
gains a new *Recent Activity* section component. The panel itself already exists; the
section is new ground. Shows the **5 most recent events** for the selected item — and
for folders, events on any descendant.

```
┌─────────────────────────────────────────────┐
│ RECENT ACTIVITY                             │
├─────────────────────────────────────────────┤
│  (LM)  Laurens edited Roadmap 2026          │
│        Q3 milestones — added "self-host…"   │
│        2 min ago                            │
│                                             │
│  (PA)  Patrice commented Launch deck        │
│        "can we move slide 12 before…"       │
│        14 min ago                           │
│                                             │
│  (RN)  Reinder created My todo              │
│        4 hr ago                             │
│                                             │
│  (HK)  Hanna shared team-photo.jpg          │
│        with you                             │
│        yesterday                            │
│  ─────────────────────────────────────────  │
│  You're watching this · Stop watching       │
└─────────────────────────────────────────────┘
```

Avatar via existing `UserAvatar`, time via `formatTimeAgo`, per-event icon and verb
mapping in `packages/lib/src/core/drive/history-display.ts`. Rendering rules:

- Third-person past tense for everything: *"Laurens edited Roadmap 2026"*,
  *"Reinder created My todo"*.
- For ACL events where the viewer is one of the recipients, append
  *"with you"*: *"Hanna shared team-photo.jpg with you"*. For other recipients, render
  *"with Mark"* (single) or *"with 3 people"* (>1).
- For `copied`, show *"X copied Y here"*; the source `(ownerId, mountId, pathId)` line
  is only rendered if the viewer has read access on the source — otherwise hidden, not
  stubbed out.

No paginated full-timeline view in v1 — if 5 isn't enough, the *Watched* sidebar shows
latest events per watched item and is the natural "show me more" surface. If feedback
shows users want longer per-file scrollback, a "See all" expansion is a small
follow-up.

### Watched view in Space

A new *Watched* row in the unified `AppSidebar` (already shared by Drive + the four
Eigendoc apps — see `packages/ui/src/components/layout/sidebar/app-sidebar.tsx`).
Cross-app by design: clicking shows every watched item regardless of MIME, sorted by
most-recent-event-first. Each row links into the right app via the existing
`getDocumentUrl()` helper, with type indicator on the left.

### Bell indicator

Watched bell icon has two states: outline (not watched) and filled (watched). No badge
for "new events on a watched file" in v1 — the existing topbar notification bell
already counts unread notifications, and a `file-event` notification IS a notification.
Per-file unread badges would be redundant.

## Retention and pruning

Run from each mount's lifecycle, same way `home.recents` prunes itself
(see [PROPOSAL_HOME_RECENTS.md](PROPOSAL_HOME_RECENTS.md#pruning)) — no global scheduler
tick.

- **On mount open**, fire-and-forget prune: drop `file_events` rows older than 90 days,
  then trim each `pathId` to the most-recent 500 rows.
- No prune of `path_watchers` — explicit user state, never expires.
- Both numbers tunable via `serverSettings.fileHistory.{maxAgeDays,maxPerPath}` later;
  hardcoded for v1 to skip a settings round-trip.

## Hooks (frontend)

Added under `packages/lib/src/core/drive/hooks/`, matching sibling patterns:

```typescript
useFileHistory(ownerId, mountId, pathId)             // paginated timeline
useIsPathWatched(ownerId, mountId, pathId)           // boolean + invalidation
useWatchPath()         // useMutation, onMutationError + onSuccess invalidate
useUnwatchPath()       // useMutation, same
useUserWatches(userId) // user-wide list (multi-owner concat on the FE)
useRecordHistory(ownerId, mountId, pathId)  // client-side eventType POST for Eigendoc apps
```

Query keys join the existing `driveKeys` family:

```typescript
driveKeys.history       = (ownerId) => [...driveKeys.owner(ownerId), 'history']
driveKeys.fileHistory   = (ownerId, mountId, pathId) => [...driveKeys.history(ownerId), mountId, pathId]
driveKeys.watches       = (ownerId) => [...driveKeys.owner(ownerId), 'watches']
driveKeys.pathWatched   = (ownerId, mountId, pathId) => [...driveKeys.watches(ownerId), mountId, pathId]
```

Invalidation functions exported beside the hooks: `invalidateFileHistory`,
`invalidateWatches`.

## Future considerations

Out of scope for v1, but worth recording so the next round of design knows what's
already been weighed:

- **Per-actor `'edited'` events on docs and sheets.** Requires linking Yjs awareness
  client IDs to user IDs in `CollabDocument` (carry the user ID through awareness
  state on connect; persist the mapping in the doc db). Once landed, the existing
  `throttledTouchUpdatedAt` becomes an attributed `'edited'` insert.
- **Sheet-specific and doc-specific event vocabulary.** `sheet-column-inserted`,
  `sheet-rows-deleted`, `doc-section-edited`, … as discrete types instead of the
  generic `'edited'` + `details.summary`. Cheap to fan out later.
- **Default-watch on share.** GitHub auto-watches the recipient on issue `@`-mention.
  Mirror that for ACL grants. v1 stays opt-in; wiring is a one-liner when we want it.
- **Team-default watches.** Joining a team could auto-watch the team's root folder.
  Introduces a team-as-watcher subscription model that v1 doesn't have; revisit if
  asked.
- **Mute window.** Per-file "mute notifications for 1 hour" toggle. The topbar bell's
  mark-all-read plus `tag`-based coalescing covers the spam case for now.
- **Watcher-side mirror table.** Local single-query "all my watches", removing the
  per-owner fan-out the FE currently does. Adds dual-write complexity; only worth it
  if the FE-side aggregation becomes a real bottleneck.

## Files

| File                                                                  | Purpose                                       |
|-----------------------------------------------------------------------|-----------------------------------------------|
| `packages/lib/src/types/file-history.ts`                              | `FileEventType`, `FileEventDetails`, `FileEvent`, `PathWatch` |
| `apps/api/src/lib/drive/history-schema.ts`                            | Drizzle tables on mount.metadata.db           |
| `apps/api/src/lib/drive/history.ts`                                   | `FileHistory` domain class (record, list, fan-out, watchers) |
| `apps/api/src/lib/drive/drive.ts`                                     | Optional `user: User` on twelve methods; call sites hooked to `mount.history.record(...)` |
| `apps/api/src/lib/mount/mount.ts`                                     | `Mount.copyPath` records `copied` for each recursive descendant |
| `apps/api/src/lib/drive/sharedDrive.ts`                               | Pass `this.user` through to the twelve newly-actor-aware Drive methods; ACL-checked wrappers for `/watch` and `/history` |
| `apps/api/src/routes/drive.ts`                                        | `/watch`, `/history` routes                   |
| `apps/api/src/lib/notification-center/notification-center.ts`         | Optional `coalesce` flag on `persist`; skip SSE broadcast on within-window upserts |
| `packages/lib/src/core/notification/resolve-link.ts`                  | `file-event` tag → app URL with `?showHistory=1` |
| `packages/lib/src/core/drive/hooks/use-file-history.ts`               | `useFileHistory`, `useRecordHistory`, invalidations |
| `packages/lib/src/core/drive/hooks/use-watch-path.ts`                 | `useIsPathWatched`, `useWatchPath`, `useUnwatchPath`, `useUserWatches` |
| `packages/ui/src/components/layout/properties-panel/recent-activity.tsx` | Recent Activity section (new component)    |
| `packages/ui/src/components/layout/toolbar/watch-toggle-button.tsx`   | Shared bell `TooltipButton`                   |
| `packages/ui/src/components/layout/drive/drive-item-menu.tsx`         | "Watch" / "Stop watching" menu entry          |
| `packages/ui/src/components/layout/sidebar/app-sidebar.tsx`           | *Watched* row                                 |
| `apps/stickies/src/components/stickies/hooks/use-drag-and-drop.ts`    | Calls `recordHistory(...)` for sticky moves   |
| `apps/slides/src/components/slides/hooks/use-slide-dnd.ts`            | Calls `recordHistory(...)` for slide reorders |
| `apps/[doc|sheet|stickies|slides]/src/.../route shell`                | Reads `?showHistory=1` and opens the panel    |
