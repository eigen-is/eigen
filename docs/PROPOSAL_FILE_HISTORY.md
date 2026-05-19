# Proposal: File History + Watch

> **TLDR**: Every Drive path grows a typed event log — *created, uploaded, edited, renamed,
> moved, shared, trashed,* and Eigendoc-specific ops like *sticky-moved*. Two new tables in the
> mount's `metadata.db`: `file_events` (the timeline) and `path_watchers` (who wants
> notifications). Any user with read access can **Watch** a file or folder; folder watches
> cascade to descendants. Events fan out through the existing `NotificationCenter` +
> `home-relay.sendToHome` pipeline — one notification per file with `tag`-based coalescing,
> not one per event. UX surfaces a bell toggle in the file menu and in each Eigendoc toolbar,
> a *History* tab in the Drive properties panel, and a *Watched* row in the unified app
> sidebar. The only new SSE plumbing is one extra case in the existing notification
> handler — no new event types, no new cross-domain infrastructure.

## Goals

1. Per-file timeline of meaningful events — visible in a *History* panel on the file's
   properties, scoped to anyone with read access.
2. **Watch** a file or folder to receive notifications when new events land. Folder watches
   cascade to descendants, including ones added later.
3. Coverage extends beyond plain Drive mutations: Eigendoc apps record their own semantic
   events (sticky moved between columns, slide reordered, sheet column inserted) via a single
   thin endpoint.
4. Fan-out reuses the existing `NotificationCenter` so users see one notification per file
   with a running coalesced count, not one toast per keystroke.
5. The shape extends to future event types by adding a string to a union — not a new table.

## Non-goals

- **Generic cross-domain activity feed.** Mail, calendar, contacts each have their own
  timeline shapes; this proposal is *Drive-paths only*. A future *Recent activity* in Space
  app can union the per-mount logs but isn't part of v1.
- **Replay / undo.** History is descriptive, not reversible. Yjs `doc_updates` keep the
  byte-level revisions for collab docs; that's an orthogonal concern.
- **Per-event subscription filters.** Watch is on/off per path; users don't pick "only
  notify me about renames". Saves UI complexity and keeps the data model flat.
- **Watching as a permission model.** Watch never grants access — it only attaches a
  notification preference to an existing read grant.
- **Persisting history past permanent delete.** When a path is removed, its history goes
  with it (FK cascade). Trashed paths keep their history; restore brings it back.
- **Migration of pre-feature events.** Eigen is pre-release; no backfill, the timeline
  starts at upgrade time.

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
  prevents fifty edit-notifications becoming fifty toasts.

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
  history-sse.ts      # buildHistoryEvent(...) — only PATH_HISTORY_CHANGED for cache invalidation
```

`FileHistory` is owned by `Mount` (next to `paths`), same lifecycle, same db. Drive's
existing `emit()` call sites gain a sibling `history.record(...)` call.

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
        │ drive.updateACL()                 │    │ docs / sheets debounce edits    │
        │ drive.trashPath() / restorePath() │    │ → POST .../history { 'edited' } │
        │ comment posted (in chat domain)   │    │                                 │
        │                                   │    │ (server validates write access  │
        └────────────────┬──────────────────┘    │  before recording)              │
                         │                       └────────────────┬────────────────┘
                         └────────────┬───────────────────────────┘
                                      ▼
                          mount.history.record({...})
                                      │
                       ┌──────────────┴───────────────┐
                       ▼                              ▼
              INSERT into file_events       fanOut(pathId, eventType)
                                                      │
                              walk parentId chain → enumerate watchers (this path + ancestors)
                                                      │
                              skip actor; dedupe across ancestors; verify each still has read access
                                                      │
                              sendToHome(subscriberId, { type:'notification', notification:{...} })
                                                      │
                              NotificationCenter.persist({ tag, type:'file-event', ... }) → SSE toast
```

### Why per-mount, not per-home or per-server

Three reasons keep history co-located with paths:

- **Cascade-on-delete is automatic.** FK `pathId → paths.id ON DELETE CASCADE` cleans up
  history without a separate sweep when paths are permanently deleted.
- **Mounts are the sharding unit.** Home is split per user; a mount belongs to one home.
  Cross-mount queries already go through `home-relay.ts`. History inherits that.
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
    | 'shared'    | 'unshared'  | 'acl-changed'
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

## Event emission

### Server-side: hooked into existing `drive.ts` emit sites

Every place that already calls `this.emit(DRIVE_*, path)` in `apps/api/src/lib/drive/drive.ts`
gains a sibling `await this.history.record(...)`. The actor on these is the authenticated
caller from the route layer (passed down where missing — most methods already have a
`user: User` parameter or can take one).

| Existing call site                              | New event       | Details                                |
|-------------------------------------------------|-----------------|----------------------------------------|
| `createFolder()` (drive.ts:198)                 | `created`       | —                                      |
| `create()` for Eigendoc (drive.ts:226)          | `created`       | —                                      |
| `uploadFiles()` final emit (drive.ts:1056)      | `uploaded`      | `{ size }`                             |
| `writeFileContent()` (drive.ts:542)             | `uploaded`      | `{ size }`                             |
| `movePath()` (drive.ts:448)                     | `moved`         | `{ oldParentId, newParentId }`         |
| `renamePath()` (drive.ts:463)                   | `renamed`       | `{ oldName, newName }`                 |
| `copyPath()` (currently no SSE emission)        | `copied`        | `{ sourceOwnerId, sourceMountId, sourcePathId }` |
| `updateACL()` (drive.ts:647)                    | `acl-changed`   | `{ added, removed }` (email diff)      |
| `receiveACLChange()` (drive.ts:929)             | `shared`        | —                                      |
| `receiveACLChange()` (drive.ts:885)             | `unshared`      | —                                      |
| `trashPath()` / `restorePath()` / permanent del | `trashed` / `restored` / `deleted` | —             |
| `ChatRoom.postMessage()` for embedded chats     | `commented`     | `{ commentPreview }` (first ~80 chars) |

The `copyPath` SSE gap gets closed at the same time — Drive's `emit(DRIVE_FILE_CREATED)` on
the destination joins the history insert. The Yjs `throttledTouchUpdatedAt` is **not**
hooked: Eigendoc apps emit their own semantic events from the client (next section), so a
server-side per-throttle `'edited'` would be a duplicate signal with worse attribution.

### Client-side: one endpoint for Eigendoc semantic ops

Stickies/slides/sheets/docs observe their own Yjs state and `POST` semantic events when
they spot one. The server doesn't try to diff blobs.

```
POST /drive/:ownerId/mounts/:mountId/paths/:pathId/history
body: { eventType: FileEventType, details?: FileEventDetails }
```

Guard: caller has **write** access on the path (writing to history is a write-class action,
even though watching is read-class). Server accepts only the client-emittable subset of
`FileEventType` — `'edited'`, `'sticky-*'`, `'slide-*'`; server-only types like `'created'`,
`'moved'`, or `'acl-changed'` are rejected. Dedupe window: identical
`(actor, eventType, JSON.stringify(details))` within 30s collapses to the latest insert.
Avoids flood from chatty observers.

Apps decide when to call:

| App      | When to POST `'edited'` (or semantic event)                                         |
|----------|-------------------------------------------------------------------------------------|
| Docs     | Debounced ~30s after the user stops typing; `details.summary` = section + delta    |
| Sheets   | Debounced ~30s after the user stops editing; `details.summary` = sheet name + cell range |
| Stickies | On column-change (`sticky-moved`), add (`sticky-added`), or remove (`sticky-removed`); no generic `'edited'` |
| Slides   | On structural change (`slide-added`, `slide-removed`, `slide-reordered`); no generic `'edited'` |

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

For "all my watches across every owner", the FE calls `GET /drive/:ownerId/watches` on each
owner the user has access to and concatenates. The list is short (one tuple per watched
path) and the call is cached per owner. No new cross-home aggregation endpoint needed.

### ACL semantics

- **Subscribing**: caller needs read access on the path. The check uses the existing
  `matchesACL(path.acl, callerId)` plus owner-equals checks — same gate as `GET path`.
- **At fan-out**: subscriber's read access is re-verified (defensive — a watcher whose
  share was revoked after subscribing is silently skipped). No watch-cleanup job in v1.
- **Folder cascade**: a watch on folder F notifies on events for F and *any* path with F in
  its `parentId` chain. The walk is the same query Drive already uses for path lookups.

### Where watch state lives

Watch state lives **only on the owner's mount** — `path_watchers(pathId, userId)`. This is
the hot path: fan-out joins `paths` + `path_watchers` to enumerate ancestor-watchers in one
query. "Show me everything I watch" reads each owner-home via the existing per-mount
endpoint, never aggregating across servers.

### Self-events suppressed

The actor of an event is skipped in the fan-out: editing your own doc doesn't toast you.
Watching is only useful for *other people's* changes (matches GitHub's mute-own behaviour).

## Notification fan-out

One notification per file, coalesced by `tag`:

```typescript
// Inside FileHistory.fanOut(...)
home.notifications.persist({
    type: 'file-event',
    actorEmail: event.actorEmail,
    title: `${actorDisplayName} ${eventVerb(event)} ${path.name}`,
    body: undefined,                                  // count appears in resolveNotificationLink
    tag: `file-event:${ownerId}:${mountId}:${pathId}`,
});
```

Multiple events on the same file collapse into one notification via the existing
`onConflictDoUpdate` on `tag` (see [NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md#schema)).
The notification's `createdAt` updates to the latest event; the title shows the most recent
actor + verb. Clicking the toast deep-links to the file with the history panel open.

Link resolution adds one case in
`packages/lib/src/core/notification/resolve-link.ts`: parse `file-event:{ownerId}:{mountId}:{pathId}`,
fetch the path, route via `getDocumentUrl()` with `?showHistory=1`.

No new SSE event type. The existing `notification:created` event already fans out to
watchers — `packages/lib/src/core/notification/sse-handlers.ts` gains one extra case: when
`notificationType === 'file-event'`, parse the tag for `(ownerId, mountId, pathId)` and
call `invalidateFileHistory(queryClient, ...)` so any open *History* panel refreshes.
Non-watchers with the panel open rely on `refetchOnWindowFocus: true` on the
`useFileHistory` query — acceptable since they didn't opt in to live updates.

## UX

### Watch verb

Following GitHub: **Watch** / **Stop watching**. Short, action-y, no overlap with existing
Eigen verbs. Backend matches: `path_watchers` table, `Watchers` domain class, `useWatch`
hook family.

### Where the toggle appears

| Surface                               | Element                                                |
|---------------------------------------|--------------------------------------------------------|
| Drive row context menu                | "Watch" / "Stop watching" item in `DriveItemMenuItems` |
| Open Eigendoc app toolbar             | Bell `TooltipButton`, filled when watched              |
| Drive properties panel — header strip | Bell button next to share button                       |
| Drive properties panel — *Recent Activity* footer | Inline "You're watching this · Stop watching" link |

`DriveItemMenuItems` is the single source for per-item actions across Drive and the
Eigendoc apps, so adding one menu item lights up all of them. The toolbar bell is a new
`TooltipButton` in each app's toolbar, sourced from a shared `<WatchToggleButton>` in
`packages/ui/src/components/layout/`.

### Recent Activity in the properties panel

A new *Recent Activity* section in the existing Drive properties panel ("PEEK" sidebar),
below *Shared with*. Shows the **5 most recent events** for the selected item — and for
folders, events on any descendant.

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

Avatar via existing `UserAvatar`, time via `formatTimeAgo`, per-event icon and verb mapping
in `packages/lib/src/core/drive/history-display.ts`. Rendering rules:

- Third-person past tense for everything: *"Laurens edited Roadmap 2026"*,
  *"Reinder created My todo"*.
- For `shared` / `unshared` where the viewer is one of the recipients, append
  *"with you"*: *"Hanna shared team-photo.jpg with you"*. For other recipients, render
  *"with Mark"* (single) or *"with 3 people"* (>1).
- For `copied`, show *"X copied Y here"*; the source `(ownerId, mountId, pathId)` line is
  only rendered if the viewer has read access on the source — otherwise hidden, not
  stubbed out.

No paginated full-timeline view in v1 — if 5 isn't enough, the *Watched* sidebar shows
latest events per watched item and is the natural "show me more" surface. If feedback
shows users want longer per-file scrollback, a "See all" expansion is a small follow-up.

### Watched view in Space

A new *Watched* row in the unified `AppSidebar` (already shared by Drive + the four
Eigendoc apps). Cross-app by design: clicking shows every watched item regardless of MIME,
sorted by most-recent-event-first. Each row links
into the right app via the existing `getDocumentUrl()` helper, with type indicator on the
left.

### Bell indicator

Watched bell icon has two states: outline (not watched) and filled (watched). No badge for
"new events on a watched file" in v1 — the existing topbar notification bell already
counts unread notifications, and a `file-event` notification IS a notification. Per-file
unread badges would be redundant.

## Retention and pruning

Run from each mount's lifecycle, same way `home.recents` prunes itself
(see [PROPOSAL_HOME_RECENTS.md](PROPOSAL_HOME_RECENTS.md#pruning)) — no global scheduler tick.

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

Invalidation functions exported beside the hooks: `invalidateFileHistory`, `invalidateWatches`.

## Future considerations

Out of scope for v1, but worth recording so the next round of design knows what's already
been weighed:

- **Sheet-specific event vocabulary.** `sheet-column-inserted`, `sheet-rows-deleted`,
  `sheet-formula-changed`, … as discrete types instead of the generic `'edited'` +
  `details.summary`. Add when the activity feed feels uninformative; cheap to fan out
  later.
- **Default-watch on share.** GitHub auto-watches the recipient on issue `@`-mention. We
  could mirror that for ACL grants. v1 stays opt-in; wiring is a one-liner when we want it.
- **Team-default watches.** Joining a team could auto-watch the team's root folder.
  Introduces a team-as-watcher subscription model that v1 doesn't have; revisit if asked.
- **Mute window.** Per-file "mute notifications for 1 hour" toggle. The topbar bell's
  mark-all-read plus `tag`-based coalescing covers the spam case for now.

## Files

| File                                                                  | Purpose                                       |
|-----------------------------------------------------------------------|-----------------------------------------------|
| `packages/lib/src/types/file-history.ts`                              | `FileEventType`, `FileEventDetails`, `FileEvent`, `PathWatch` |
| `apps/api/src/lib/drive/history-schema.ts`                            | Drizzle tables on mount.metadata.db           |
| `apps/api/src/lib/drive/history.ts`                                   | `FileHistory` domain class (record, list, fan-out, watchers) |
| `apps/api/src/lib/drive/history-sse.ts`                               | `buildHistoryEvent()` — `PATH_HISTORY_CHANGED` |
| `apps/api/src/lib/drive/drive.ts`                                     | Call sites hooked to `mount.history.record(...)` |
| `apps/api/src/lib/drive/sharedDrive.ts`                               | ACL-checked wrappers for watch / history routes |
| `apps/api/src/routes/drive.ts`                                        | `/watch`, `/history` routes                   |
| `apps/api/src/lib/notification-center/resolve-link.ts` (FE companion) | `file-event` tag → app URL with `?showHistory=1` |
| `packages/lib/src/core/drive/hooks/use-file-history.ts`               | `useFileHistory`, `useRecordHistory`, invalidations |
| `packages/lib/src/core/drive/hooks/use-watch-path.ts`                 | `useIsPathWatched`, `useWatchPath`, `useUnwatchPath`, `useUserWatches` |
| `packages/lib/src/core/drive/sse-handlers.ts`                         | Handle `PATH_HISTORY_CHANGED` → invalidate    |
| `packages/lib/src/core/notification/sse-handlers.ts`                  | New `'file-event'` case in toast click handler |
| `packages/ui/src/components/layout/properties/recent-activity.tsx`    | Recent Activity section for properties panel  |
| `packages/ui/src/components/layout/toolbar/watch-toggle-button.tsx`   | Shared bell `TooltipButton`                   |
| `packages/ui/src/components/layout/app/drive-item-menu-items.tsx`     | "Watch" / "Stop watching" menu entry          |
| `apps/space/src/...`                                                  | *Watched* sidebar row + watched-list view     |
| `apps/stickies/src/...` `apps/slides/src/...` `apps/sheets/src/...`   | Yjs observers calling `recordHistory(...)` for semantic ops |
