# Collab Documents (server)

> **TLDR:** `apps/api/src/lib/collab/` is the server half of every Yjs container — one `CollabDocument` per open document, Yjs updates and snapshots persisted as zstd-compressed BLOBs in the container's `data.db`, and a WebSocket route (`apps/api/src/routes/collab.ts`) that fans updates out to the connected peers. Four things here are not obvious from the code: the compression seam is backward compatible by magic-byte sniff, awareness frames are validated before apply, the route sends a heartbeat during a cold load, and a document lingers 60 s after the last unsubscribe. The client half — `useCollabDoc`, the loading gate, and what each close code does to the tab — is [CANVAS.md § Shared primitives](CANVAS.md#shared-primitives).

## The storage seam is zstd

Yjs blobs (`doc_snapshots.stateData`, `doc_updates.updateData`) are compressed at the SQLite boundary only, in `apps/api/src/lib/collab/blob-codec.ts`. **The live WebSocket protocol still exchanges raw Yjs updates**, so sync is untouched by it. The motivation is that a Yjs snapshot embeds the whole document state verbatim: a large sheet's snapshot rides at ~48 MB raw and ~1 MB at zstd level 3. Updates below `COMPRESS_MIN_BYTES` (1 KiB) stay raw, because frame overhead outweighs the gain on a keystroke-sized update.

Reads are backward compatible with **no schema migration**: `decompressBlob` sniffs the 4-byte zstd frame magic and passes a legacy raw blob through untouched. The BLOB column stores either form and every row decodes independently, so old and new rows coexist. The magic cannot plausibly arise from lib0-encoded Yjs data, and a false positive would throw inside the caller's existing `try/catch` and skip that one row rather than silently corrupt state.

## Awareness frames are validated before apply

A read-only peer can send awareness, so `CollabDocument.handleMessage` validates an update before `applyAwarenessUpdate` rather than after — otherwise one peer could flood or hijack the shared awareness map:

- at most `MAX_AWARENESS_CLIENT_IDS` (8) client ids per connection — a real y-websocket client owns one per doc
- at most `MAX_AWARENESS_STATE_BYTES` (16 KiB) per state — a legitimate state is name + color + userId + a cursor
- the state's `user.userId` must be the session user: a client may publish presence for itself only
- a client id belongs to the connection that declared it (`clientIdOwners`), so no peer can evict or overwrite another's cursor

## The route speaks first during a cold load

y-websocket hard-closes a connection that stays silent for 30 s (a hardcoded client constant) and reconnects on a ~2.5 s backoff, and every retry re-pays the full load — a self-sustaining spiral that once degraded the whole server. So `apps/api/src/lib/collab/loading-heartbeat.ts` sends an empty awareness frame immediately and every 10 s until sync-step-1 takes over. Clients apply it as a no-op; it exists only to reset their silence timer.

The same 30 s window bounds the whole-state sync reply, because a frame only counts once it has fully arrived. A large sheet's reply is 12 MB or more raw, which a slow link can't deliver in 30 s, so the socket loops open → silent → closed forever. `perMessageDeflate` in `app.ts` only negotiates the extension; Bun deflates just the frames sent with `compress=true`, so every `CollabDocument` send goes through `sendFrame`, which compresses frames of 1 KiB and up.

## The route refuses before it speaks

An unauthenticated upgrade never reaches `open`: the `auth` macro answers the HTTP upgrade itself, so the handler's user is always a session user. A caller without read access gets exactly one frame, the constant empty awareness heartbeat above, then close 1008. Home-replaced (restore) and storage-unavailable opens close with their own codes (`packages/lib/src/constants/collab.ts`); every other failed open is 1008. Binary frames arrive as Bun `Buffer`s; a string frame is `ping`/`pong` or ignored. The route keeps its per-socket state (the `opened` gate, the drive, the document, the keepalive) in a `WeakMap` keyed by the raw Bun socket — the one identity that survives Elysia's fresh wrapper per event — and reads user and params from the typed `ws.data`.

## A document lingers after the last unsubscribe

`CollabDocument.scheduleClose` waits `CLOSE_LINGER_MS` (60 s) after the last connection drops before tearing the document down, so a reload or a brief disconnect reattaches to the loaded document instead of re-paying the load. A new subscribe cancels the timer.

## Replacing live state (version restore)

`CollabDocument.applySnapshotState` is how a version restore reaches a document that is open, and `apps/api/src/lib/versioning/restore.ts` is its only caller — it holds no container lock, because the surgery is synchronous and nothing can interleave with it. It delegates to `restoreYjsDoc` (`packages/lib/src/core/collab/yjs-utils.ts`), which replaces the doc's **declared roots** — the `yjsRoots` schema on `EIGEN_DOC_TYPE_INFO` — with a snapshot's contents inside ONE transaction. That transaction's update fires the normal `update` handler, so it persists and broadcasts like any other edit: **connected editors converge live, with no reload and no merge fight**, and disconnected sessions pick the new state up on their next sync handshake.

The walker handles every Y subtype an Eigen container uses — `Y.Map`, `Y.Array`, `Y.Text`, `Y.XmlFragment` (Tiptap) — with arbitrary nesting. It rebuilds Y instances on the live doc rather than transplanting them, because a Y item's identity is tied to its source doc. Both docs' roots are force-typed before the walk: `Y.applyUpdate` hydrates a root as `AbstractType`, so an `instanceof` check would otherwise misclassify it.

## Home replacement closes every socket

`closeCollabConnectionsForHome` (`apps/api/src/lib/collab/connections.ts`) closes every socket belonging to one home with `COLLAB_HOME_REPLACED_CLOSE` (`packages/lib/src/constants/collab.ts`) when a backup restore replaces that home's folder, so a tab reloads instead of syncing the document it still holds in memory back over the restored copy. A tab that is offline during the restore has no socket to close, so the restore also rotates that home's part of the data epoch below (`rotateHomeCollabEpoch()`): the home's tabs reload on their next reconnect, and the tabs of every other home sync on. See [BACKUP.md](BACKUP.md).

`./eigen restore` and `./eigen rollback` replace every home while the API is stopped, so no socket is open to close, and a tab that was offline would not hear it anyway. The data epoch covers them. It has two parts (`apps/api/src/lib/collab/epoch.ts`): the server's, a random id in `data/server/collab-epoch` drawn on first use, followed by the home's, from `data/server/collab-home-epochs.json`, which only a per-home restore writes (a home never restored on its own has none). Every open sends the epoch of the document's home in a `COLLAB_EPOCH_MESSAGE` frame before the sync, `useCollabDoc` reconnects with `?epoch=`, and the route closes a reconnect that names another epoch with `COLLAB_HOME_REPLACED_CLOSE` before it syncs anything, so the tab reloads. The restore deletes the server's file from the data it puts back, so the next start draws a new server part and every tab reloads; a restart or an update keeps it, so an offline edit still syncs. The hook keeps BroadcastChannel off until the first epoch arrives and then joins a channel named after it: a reloaded tab never takes state from a sibling tab still holding the document from before the restore.

## See also

- [CANVAS.md](CANVAS.md) — `useCollabDoc`, the `loaded` gate, offline/unsynced-edits surfaces, the typed Yjs root accessors, sealing discipline
- [DOCUMENT-CONTENT-LAYER.md](DOCUMENT-CONTENT-LAYER.md) — the readers and writers over a materialized `Y.Doc`
- [BACKUP.md](BACKUP.md) — what a restore does to an open document
- [STORAGE.md](STORAGE.md) — container layout and file versioning
