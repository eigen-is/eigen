# File History

> **TLDR**: Every Drive path grows a typed event log. Two tables per mount `metadata.db`:
> `file_events` (the timeline) and `path_watchers` (subscriptions). Anyone with read access can
> **Watch** a file or folder; folder watches cascade to descendants and notify through the existing
> notification center, re-checked against ACL at delivery time. Surfaces: *Recent activity* in the
> Drive details panel, the *Activity* panel in every eigendoc editor, and a *Watched* view — all
> refreshed live by one SSE event.

## Data model

Tables live in the mount's `metadata.db` — drizzle definitions in `apps/api/src/lib/mount/schema.ts`,
created by migration v5 in `apps/api/src/lib/mount/db-config.ts`:

- `file_events` — `id`, `pathId` (FK → `paths.id`, `ON DELETE CASCADE`), `eventType`, `actorUserId`,
  `actorEmail`, `details` (JSON), `createdAt`; index on `(pathId, createdAt)`.
- `path_watchers` — `(pathId, userId)` primary key, `createdAt`, index on `userId`.

Shared types: `packages/lib/src/types/file-history.ts`. `FileEventDetailsMap` maps each event type
to its payload; `FileEventType` is that map's keys plus the detail-less `created`, `edited`,
`trashed`, `restored`, `deleted`. Today's vocabulary is the drive verbs (`uploaded`, `renamed`,
`moved`, `copied`, `acl-changed`, `version-restored`, …), the comment verbs (`commented`,
`assigned`, `resolved`, `reopened`) and the card verbs (`sticky-added`, `sticky-moved`,
`sticky-removed`). `FileEventInput` (write) demands `details` exactly when the type has them;
`FileEvent` (read) adds `pathName` + `pathType`, resolved at read time so a folder timeline can name
and link the descendant an event happened on. `toFileEventType` coerces any persisted string outside
the union to `'edited'`, so rows from other builds stay renderable and the phrasing helpers total.

Rows carry both `actorUserId` and `actorEmail` — denormalised so a row renders without an auth-db
join. Drive mutations take an optional `user`; **no actor means no row**, which keeps internal
scaffolding (chat seed files, `media/` folders) out of the user-visible timeline. History is
per-mount, not per-home or server-wide: the FK cascade cleans it up when a path is permanently
deleted, the write stays in the same database as the `paths` row it describes (homes are the
sharding unit — [SCALABILITY.md](SCALABILITY.md)), and it needs no new database file.

`FileHistory` (`apps/api/src/lib/drive/history.ts`) is constructed by `Mount` next to `paths` and
owns record / list / watchers / fan-out / prune. Two structural rules live there. **Container
internals never enter the timeline**: `isContainerInternal` walks the parent chain and drops events
for anything below an eigendoc or chat container (per-card comment threads, attachment media,
`data.db`) — the container speaks through its own events. And **`list` is a subtree read**: direct
events for a file, the whole subtree via a recursive CTE for a folder or container, newest first.

## Recording events

`Drive.recordFileEvent` (`apps/api/src/lib/drive/drive.ts`) is the single seam for mutations on a
live path: record → fan out → broadcast the live-refresh event; missing and trashed paths are
skipped. Callers: `createFolder`, `create`, `writeFileContent`, `renamePath`, `updateACL` (email
diff, actor-gated), version restore, trash restore, the comment assign/resolve/reopen methods,
`chat.ts` (`'commented'`, passing everyone the mention/activity notifications already covered as
`excludeEmails`), `collabDocument.ts` (`'edited'`), and the client-POST route.

Four mutations keep their **own inline record + fan-out** because they rewrite the parent chain or
recurse through the mount, and each therefore fires `broadcastFileHistoryUpdated` itself:

- **Upload** — `finalizeUpload` (`drive/upload.ts`) writes one row per file; the caller fans out
  once per batch, so a 100-file upload is one notification, not 100.
- **Move** — records `moved` with old and new parent, fans out over *both* chains, and captures the
  old breadcrumb before `updatePath` so watchers of the source folder still verify.
- **Copy** — `mount/copy.ts` records `copied` for the root *and* every recursive descendant;
  `Drive.copyPath` fans out only at the root (fresh paths have no watchers yet).
- **Trash** — `drive/trash.ts` captures the pre-trash breadcrumb *and* the pre-trash effective
  members before `trashPath` re-parents the item to the mount root and strips its share; the
  post-trash chain no longer resolves either. Permanent delete is notification-only: the FK cascade
  would kill the row instantly, so watchers and the `trashedFrom` chain are collected before the
  delete and only a notification goes out.

**Collab edits** are attributed server-side. `CollabDocument` keeps a `Map<connection, User>` filled
by subscribe/unsubscribe, resolves the Yjs update's `origin` connection back to a user, and records
`'edited'` throttled to one row per user per 10 minutes per document instance. Server-origin updates
(version restores) have no connection origin and are excluded for free. **Stickies boards skip the
generic `'edited'` row entirely** — every board action already records a specific `sticky-*` or
comment event, so an `'edited'` row would double-report each drag.

**Clients** may post a small allowlist of semantic events to
`POST /drive/:ownerId/:mountId/path/:pathId/history`. The route's typebox union *is* the allowlist:
`sticky-added` / `sticky-moved` (`card`, `toColumn`, `cardId`) and `sticky-removed` (`card`,
`cardId`); `isClientFileEventType` re-checks as defence in depth, and identical events from one
actor collapse within a 30 s dedupe window. `apps/stickies` posts them through `useRecordHistory`.
Slide, sheet and doc structural verbs are deliberately absent — they surface as `'edited'`.

## Watch and fan-out

Routes (`apps/api/src/routes/drive.ts`): POST / DELETE / GET on
`/drive/:ownerId/:mountId/path/:pathId/watch`, plus `GET /drive/:ownerId/watches` — with `?all=1`
for the self-only aggregation over the caller's own home, their teams, and every owner who shared
into their home (`drive/aggregate.ts`). Watching needs read access and a non-guest, non-trashed
path; it never grants access. `getWatchStatus` returns `{ direct, viaAncestor? }`, the ancestor
being the nearest watched folder up the chain.

Fan-out (`FileHistory.fanOut` → `collectWatcherIds` → `notifyWatchers`):

- Watchers come from one upward CTE seeded with the affected path plus the relevant chain roots, so
  a folder watch covers every descendant, including ones added later. Results are deduped, and
  **the actor is always excluded** — your own edits never notify you.
- **Read access is re-verified per watcher at delivery** against a `verifyAncestors` chain the
  caller captured before any chain-rewriting mutation. A watcher whose share was revoked is silently
  skipped; there is no watcher-cleanup job. Delivery is per-watcher concurrent, isolated and
  best-effort — one failing lookup can neither reject the already-committed mutation nor drop the
  other watchers.
- Each notification goes through `sendToHome` as type `file-event` with tag
  `file-event:{ownerId}:{mountId}:{pathId}` and `coalesce: true`, so repeated events on one file
  collapse to a single bell row. Burst events (`created` / `uploaded` / `copied`) tag the *parent
  folder* instead. Title and body are composed with `describeFileEvent` — the same phrasing layer
  the panels render with.
- Events on items already in trash never fan out; `'trashed'` itself passes its pre-trash snapshot.

The notification pipeline itself (storage, coalescing, SSE, routes) is
[NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md). Row phrasing and link targets are
[ACTIVITY-ROWS.md](ACTIVITY-ROWS.md).

Retention: `FileHistory.prune` runs fire-and-forget off `Mount.init` (a `setTimeout(0)` the teardown
can cancel) — delete `file_events` older than **90 days**, then trim each `pathId` to its newest
**500** rows, both hardcoded in `history.ts`. `path_watchers` is explicit user state, never pruned.

## UX surfaces

- **Watch bell** — `WatchToggleButton` / `WatchMenuItem`
  (`packages/ui/src/components/layout/toolbar/watch-toggle-button.tsx`), used by the Drive details
  header, the Drive item menu, and `DocumentShareCluster` in every eigendoc toolbar. A filled bell
  means a *direct* watch; a path covered by an ancestor watch reads "Watching via *{folder}*".
- **Recent activity** — `RecentActivity` in the Drive details panel: the 5 newest events (a folder
  includes its descendants), rendered by the shared `ActivityEventList`.
- **Activity panel** — `packages/ui/src/components/layout/comments/activity-panel.tsx`, hosted by
  docs, sheets, slides and stickies through `PanelColumn`, up to 50 events, rows opening the comment
  card they reference.
- **Watched view** — `apps/drive/src/routes/_auth.watched.tsx`, reached from the *Watched* sidebar
  row in `app-sidebar.tsx`; a read-only listing of everything the user watches, everywhere.
- **Click-through** — `core/notification/resolve-link.ts` parses the `file-event` tag: collab and
  chat items open in their app (deep-linking the card when the event carries one); everything else
  lands on the Drive view with `?showHistory=1`, which the route turns into `highlightHistory` and
  scrolls *Recent activity* into view.
- **Live refresh** — recording broadcasts `drive:file-history-updated` (`drive/sse-events.ts`) to
  the owner home *and* the effective members, since plain `drive:*` events only reach the owner
  home; `core/drive/sse-handlers.ts` invalidates the history keys on it.

Hooks live in `packages/lib/src/core/drive/hooks/`: `use-file-history.ts` (`useFileHistory` — keyed
by limit, so the 5-row and 50-row panels cache apart — `useRecordHistory`, `invalidateFileHistory`)
and `use-watch.ts`. Tests: `apps/api/src/test/file-history.test.ts`, `file-watch.test.ts`.

## Not built yet

Tracked as one ROADMAP row.

- **Email / digest channel.** Per-user cadence (`never` / `immediate` / `daily`) as an additive
  `UserSettings` field, plus a `notifications.db` migration for a per-row `emailedAt` marker and a
  `digest_state` row. Immediate mail sends at relay delivery, where the watcher's home is already
  open; the daily digest runs off an hourly scheduler tick asking each home to flush its own unread
  `file-event` rows. Notification rows are the queue — no outbox, no second pipeline.
- **In-doc history unified with Version History.** Four decisions settled while shipping the
  drive-level feature: (1) liveness rides SSE + the relay, no new channel — *shipped*; (2) extend
  the editor's Version History menu with actor/verb rows instead of standing up a second timeline;
  (3) rich semantic events only exist where the client has a discrete, nameable action (stickies) —
  docs and sheets have no clean client boundary and the Yjs update log is a transient sync buffer,
  so they stay coarse `'edited'` unless we build server-side op interpretation; (4) the 500/90-day
  prune is a feed cap, and an authoritative in-doc history wants tiered retention like
  `versioning/retention.ts`.
- **Richer sheet / doc / slide vocabulary** (`sheet-column-inserted`, `slide-reordered`, …) — a
  string in the union plus an emitter, but `'edited'` today.

Weighed and parked: default-watch on share, team-default watches, a per-file mute window, and a
watcher-side mirror table replacing the per-owner watch aggregation with one local query.
