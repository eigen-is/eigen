# File History and Watch

> **TLDR:** Every Drive path has a typed event log, and anyone who can read a path can watch it. Both live in the mount's `metadata.db` (`file_events`, `path_watchers`), owned by `FileHistory` (`apps/api/src/lib/drive/history.ts`). Not obvious from the code: an event with no actor is never recorded, and container internals never enter the timeline. A folder watch covers every descendant, including later ones, and read access is checked again at delivery. Mutations that rewrite the parent chain capture it before they run. Retention is a count per file, never an age.

An event is one thing a person did to a file or folder: created, uploaded, edited, renamed, moved, shared, commented on, trashed or restored it. People read them in the Activity panel of every eigendoc editor and in the Drive details panel. A watch is a user's subscription to a path, and the Watched view lists them. Each later event on a watched path, or anywhere under a watched folder, becomes a row in the watcher's notification bell.

The server records almost every event itself, as part of the change, and only the stickies card events come from the client ([§ Clients post only the stickies card events](#clients-post-only-the-stickies-card-events)). A watcher's notification travels through the home relay into that watcher's own notification center ([NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md), [SCALABILITY.md](SCALABILITY.md)), and an SSE event refreshes every open panel ([SSE.md](SSE.md)). The log is a feed for people, not an audit trail: it is capped per file ([§ Retention](#retention-is-a-count-per-file-never-an-age)).

## History lives in the mount's `metadata.db`

`file_events` holds the timeline and `path_watchers` the subscriptions (`apps/api/src/lib/mount/schema.ts`). History is per mount ([STORAGE.md § A mount is a paths table](STORAGE.md#a-mount-is-a-paths-table-over-one-of-three-backends)), not per home or per server. The FK cascade cleans a path's events when the path is permanently deleted. The write lands in the same database as the `paths` row it describes, so it never crosses homes, which are the sharding unit ([SCALABILITY.md](SCALABILITY.md)). And it needs no extra database file.

A row stores both `actorUserId` and `actorEmail`, so it renders without an auth-db join. The event types and their detail payloads are `FileEventDetailsMap` in `packages/lib/src/types/file-history.ts`. A stored type outside today's union reads back as `'edited'`.

## No actor means no row

Drive mutations take an optional `user`. Without one, nothing is recorded, so internal scaffolding (a chat's seed files, `media/` folders) stays out of the timeline users see.

`FileHistory` also drops every event below an eigendoc or chat container: per-card comment threads, attachment media, `data.db`. The container speaks through its own events. `list` reads a subtree: a file's own events, or a folder's or container's whole subtree through a recursive CTE, newest first.

## `recordFileEvent` records every event on a live path

`Drive.recordFileEvent` records the row, fans out to watchers and broadcasts the live refresh. It skips a missing or trashed path. Creates, content writes, renames, sharing changes, version and trash restores, comment status changes, chat messages and collab edits all go through it.

## Chain-rewriting mutations record their own events

The fan-out finds the watchers to notify by walking up the parent chain from the changed path ([§ A watch covers the subtree](#a-watch-covers-the-subtree-and-never-grants-access)). Some mutations change that chain, or recurse through the mount. They record and fan out inline, and each broadcasts the live refresh itself:

- Move captures the old breadcrumb before `updatePath`, and fans out over both chains, so watchers of the source folder still qualify.
- Trash captures the old breadcrumb and the old effective members before `trashPath` re-parents the item to the root and strips its shares. After the trash neither resolves.
- Permanent delete only notifies. The FK cascade would delete a row at once, so it collects the watchers and the `trashedFrom` chain before the delete.
- Upload writes one row per file and fans out once per batch, so a 100-file upload is one notification.
- Copy records `copied` for the root and every descendant, and fans out only at the root, since fresh paths have no watchers yet.

## Collab edits are attributed on the server

`CollabDocument` maps each connection to its user. It resolves a Yjs update's origin connection back to that user and records `'edited'`, at most once per user per 10 minutes per open document. An update the server applies itself, like a version restore, has no connection origin and records nothing. A stickies board records no `'edited'` at all: every board action already records a `sticky-*` or comment event, and an `'edited'` row would report each drag twice.

## Clients post only the stickies card events

`POST /drive/:ownerId/:mountId/path/:pathId/history` takes `sticky-added`, `sticky-moved` and `sticky-removed` and needs write access. The route's body schema is the allowlist, and `isClientFileEventType` checks it again. Identical events from one actor within 30 s collapse into one row. Each detail string is capped at `CARD_TITLE_MAX_LENGTH` (200), and `useRecordHistory` clips to it before posting.

Slide, sheet and doc structural changes stay `'edited'`. A stickies action is a discrete, nameable client action. Docs and sheets have no such clean boundary on the client, and the Yjs update log is a short-lived sync buffer, so naming their changes would take interpreting ops on the server.

## A watch covers the subtree and never grants access

Watching needs read access to an untrashed path and a non-guest user. It grants nothing. `getWatchStatus` answers `{ direct, viaAncestor? }`, the ancestor being the nearest watched folder. `GET /drive/:ownerId/watches?all=1` gathers the caller's watches across their own home, their teams and every owner who shared into it (`apps/api/src/lib/drive/aggregate.ts`). It reads other homes, so it answers for the caller only.

Fan-out (`FileHistory.fanOut`) collects watchers with one upward CTE from the affected path and the chain roots. So a folder watch covers every descendant, including ones added later. The actor never hears about their own action. Each watcher's read access is checked again against the chain the caller captured, so a watcher whose share was revoked is skipped, and no cleanup job is needed. Delivery runs after the mutation committed, per watcher and best effort, so one failing lookup neither fails the mutation nor drops the other watchers. An event on an item already in trash never fans out.

## Notifications coalesce per file, and bursts per folder

A notification goes through `sendToHome` as type `file-event` with the tag `file-event:{ownerId}:{mountId}:{pathId}` and `coalesce: true`, so repeated events on one file collapse to one bell row. A create, upload or copy tags the parent folder instead, so a burst collapses too. The title and body come from `describeFileEvent`, the same phrasing the panels render. The pipeline is [NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md), the row phrasing and link targets [ACTIVITY-ROWS.md](ACTIVITY-ROWS.md).

## The live refresh reaches every member, not only the owner

A recorded event broadcasts `drive:file-history-updated` to the owner's home and to every effective member (`apps/api/src/lib/drive/sse-events.ts`). A plain `drive:*` event reaches only the owner's home, and a collaborator's open Activity panel must refresh too. The client invalidates its history queries on it.

## Retention is a count per file, never an age

`FileHistory.prune` runs off `Mount.init` without blocking it. Per path it keeps the newest 100 `'edited'` rows, then the newest 500 rows of any kind. There is no age cap: the Activity panel is the file's story, and a quiet file keeps its creation, sharing and assignment rows. The cap makes the log a feed, not an authoritative history. `path_watchers` is explicit user state and is never pruned.

Tests: `apps/api/src/test/drive/file-history.test.ts`, `file-watch.test.ts`, `drive-watch-fanout.test.ts`.

## See also

- [NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md): storage, coalescing and delivery of the bell rows
- [ACTIVITY-ROWS.md](ACTIVITY-ROWS.md): how an event renders and where it links
- [SOFT-DELETE.md](SOFT-DELETE.md): trash, restore and permanent delete
- [COMMENTS.md](COMMENTS.md): the assigned, resolved and reopened events
