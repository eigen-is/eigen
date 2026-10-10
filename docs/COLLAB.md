# Collab Documents

> **TLDR:** A doc, a sheet, a slide deck, a stickies board and a drawing are all collab documents: several people edit one at the same time and see each other's changes and cursors live. Each browser holds a full copy of the document, and the server relays every change to the other browsers and stores it in the document's own SQLite file. The server half is `apps/api/src/lib/collab/` with the socket route `apps/api/src/routes/collab.ts`. The client half is `useCollabDoc` in `packages/lib/src/core/collab/`.

The document is a Yjs document. Yjs is a library for shared data that merges concurrent edits without conflicts. An edit becomes a small binary update, and every copy that applies the same updates, in any order, ends up the same. So the server does not need to understand a document to serve it. It passes updates on and keeps them. A chat is not a collab document: its messages are rows in a database ([CHAT.md](CHAT.md)).

On disk a collab document is a container: a Drive folder named like a file, such as `Notes.eigendoc`. Inside is `data.db`, a SQLite file with two tables. `doc_updates` holds every update since the last snapshot, as it arrived. `doc_snapshots` holds one snapshot, the whole document state in one blob, rewritten after every 100 updates or 1 MB of them. Loading a document reads the snapshot and the updates after it. The same folder holds `comments.db`, the comment threads, the media the document embeds and its version history ([COMMENTS.md](COMMENTS.md), [MEDIA-REFERENCES.md](MEDIA-REFERENCES.md), [STORAGE.md](STORAGE.md#version-snapshots-live-inside-the-container)).

A browser opens one WebSocket per document, and the server keeps one `CollabDocument` in memory for each document someone has open. The two sides first exchange what the other is missing, the sync handshake (y-websocket's sync step 1 and step 2). From then on each update goes to the server, into `data.db`, and out to the other sockets. Awareness is the second thing on the socket: who is here and where their cursor is. It is never stored.

Access is Drive's. The socket checks read when it opens and write on every update ([ACL.md](ACL.md)). Nothing persists in the browser, so an edit the server has not acknowledged is lost on reload, and the tab warns before that happens.

The sections follow the places where this picture needs care: big documents and slow links, hostile or stale peers, replacing a document under its editors, and the editor in the browser. Six things in them surprise people:

- The blobs in `data.db` are zstd on disk and raw on the wire, and the reader takes compressed and raw rows alike ([§ Yjs blobs](#yjs-blobs-are-zstd-on-disk-and-raw-on-the-wire)).
- A read-only peer can still send awareness, so it is validated before it is applied ([§ Awareness frames](#awareness-frames-are-validated-before-apply)).
- The route sends a heartbeat during a cold load, or the client would close the silent socket and retry forever ([§ The route speaks first](#the-route-speaks-first-during-a-cold-load)).
- The WebSocket uses a dedicated deflate compressor, because Safari drops a connection after a frame from Bun's default one ([§ Deflated frames](#a-deflated-frame-never-ends-the-deflate-stream)).
- A backup restore rotates the home's data epoch, an id that changes only when the home's data is replaced, so a reconnecting tab reloads instead of syncing its old state over the restored copy ([§ Home replacement](#home-replacement-closes-every-socket)).
- The editor waits on a latched `loaded`, never on `synced`, so a short outage keeps it mounted ([§ The client gates on `loaded`](#the-client-gates-on-loaded-never-synced)).

## Yjs blobs are zstd on disk and raw on the wire

Yjs blobs (`doc_snapshots.stateData`, `doc_updates.updateData`) are compressed at the SQLite boundary only, in `apps/api/src/lib/collab/blob-codec.ts`. **The live WebSocket protocol exchanges raw Yjs updates**, so sync is untouched by it. The motivation is that a Yjs snapshot embeds the whole document state verbatim: a large sheet's snapshot rides at ~48 MB raw and ~1 MB at zstd level 3. Updates below `COMPRESS_MIN_BYTES` (1 KiB) stay raw, because frame overhead outweighs the gain on a keystroke-sized update.

Reads are backward compatible with **no schema migration**: `decompressBlob` sniffs the 4-byte zstd frame magic and passes a legacy raw blob through untouched. The BLOB column stores either form and every row decodes independently, so old and new rows coexist. The magic cannot plausibly arise from lib0-encoded Yjs data, and a false positive would throw inside the caller's existing `try/catch` and skip that one row rather than silently corrupt state.

## Awareness frames are validated before apply

A read-only peer can send awareness, so `CollabDocument.handleMessage` validates an update before `applyAwarenessUpdate` rather than after. Otherwise one peer could flood or hijack the shared awareness map:

- at most `MAX_AWARENESS_CLIENT_IDS` (8) client ids per connection, since a real y-websocket client owns one per doc
- at most `MAX_AWARENESS_STATE_BYTES` (16 KiB) per state, since a legitimate state is name + color + userId + a cursor
- the state's `user.userId` must be the session user: a client may publish presence for itself only
- a client id belongs to the connection that declared it (`clientIdOwners`), so no peer can evict or overwrite another's cursor

The display name in the state is not checked. A user may label their own cursor with any name, but it still carries their own `userId`, and no peer can touch another's cursor.

## The route speaks first during a cold load

y-websocket hard-closes a connection that stays silent for 30 s (a hardcoded client constant) and reconnects on a ~2.5 s backoff, and every retry re-pays the full load. That spiral feeds itself and can degrade the whole server. So `apps/api/src/lib/collab/loading-heartbeat.ts` sends an empty awareness frame immediately and every 10 s until sync-step-1 takes over. Clients apply it as a no-op; it exists only to reset their silence timer.

The same 30 s window bounds the whole-state sync reply, because a frame only counts once it has fully arrived. A large sheet's reply is 12 MB or more raw, which a slow link can't deliver in 30 s, so the socket loops open → silent → closed forever. `perMessageDeflate` in `app.ts` only negotiates the extension; Bun deflates just the frames sent with `compress=true`, so every `CollabDocument` send goes through `sendFrame`, which compresses frames of 1 KiB and up.

## A deflated frame never ends the deflate stream

Bun's default compressor (`perMessageDeflate: true`, shared by all sockets) deflates a message under ~9 KB into a complete deflate stream, with the final-block bit (BFINAL) set. RFC 7692 allows that, but Safari on macOS and iOS delivers such a frame and then drops the connection ("The network connection was lost", a 1006 close on the server). Chrome accepts it. A doc edited by more than ~170 Yjs clients has a state vector over 1 KiB, so its very first frame, sync step 1, is deflated and Safari never loads it: the socket loops open → dropped → retry. So `app.ts` sets the dedicated `32KB` compressor, which always ends a frame with a sync flush and leaves the stream open, as browsers do themselves. It costs 32 KB of zlib state per socket and deflates a large sheet as well as the 256 KB `dedicated` one. `collab-ws-payload.test.ts` reads a deflated frame off a raw socket under the app config and fails on BFINAL.

## The route refuses before it speaks

An unauthenticated upgrade never reaches `open`. The `auth` macro answers the HTTP upgrade itself, so the handler's user is always a session user.

A caller without read access gets nothing but the constant empty awareness heartbeat ([The route speaks first during a cold load](#the-route-speaks-first-during-a-cold-load)), then close 1008. That is why the heartbeat may start before the access check: it carries no document data.

Three failed opens close with their own codes, so the tab knows what to do ([Each close code tells the tab what to do](#each-close-code-tells-the-tab-what-to-do)): home-replaced after a restore, storage-unavailable for any server-side (5xx) failure, an outage or a local one such as a full disk, and storage-gone (4410: the stored object is gone, so the client stops retrying). Every other failed open, such as a missing path, is 1008.

Binary frames arrive as Bun `Buffer`s. A string frame is `ping` or `pong`, or it is ignored.

The route keeps its per-socket state (the `opened` gate, the drive, the document, the keepalive) in a `WeakMap` keyed by the raw Bun socket. That socket is the one identity that survives Elysia's fresh wrapper per event. User and params come from the typed `ws.data`.

## Read is checked at open, write on every message

The route checks read once, when the socket opens, and write on every binary frame, so a writer demoted to reader loses write with the next frame. `CollabDocument.handleMessage` drops a sync update from a peer without write and still answers its sync step 1 and awareness.

A revoked read would otherwise keep receiving broadcasts until the socket drops. So `Drive.updateACL` and `Drive.movePath` call `enforceReadAccessBelow` (`apps/api/src/lib/drive/collab-registry.ts`), which walks every open document at or below the path and closes each connection that lost read with 1008. It re-checks read per connection rather than diffing the removed ACL entries, because read inherits from the whole ancestor chain: revoking a folder share must reach the documents inside it. Removing a member from a team does not re-check: a removed member keeps a socket that is already open ([ROADMAP.md](ROADMAP.md)).

## A document lingers after the last unsubscribe

`CollabDocument.scheduleClose` waits `CLOSE_LINGER_MS` (60 s) after the last connection drops before tearing the document down, so a reload or a brief disconnect reattaches to the loaded document instead of re-paying the load. A new subscribe cancels the timer.

## A drive that is shutting down refuses a new open

Once `Drive.destruct` starts its sweep of the open documents, the registry (`apps/api/src/lib/drive/collab-registry.ts`) answers every open with a 503. A document that registered after that sweep would never be destructed, and the mount teardown that follows would close its database under it.

## Modified moves for an update, never for an open or a close

The `update` handler stamps the container's Modified time at most once a minute (`TOUCH_THROTTLE_MS`), since typing fires many updates a second. An update the throttle skips is stamped when the document closes, with its own time. So a document that was only read keeps its Modified time, and the last edit is not dated a linger after the last viewer left. `apps/api/src/test/collab/collab-modified-touch.test.ts` pins it.

## A version restore rewrites an open document in one transaction

`CollabDocument.applySnapshotState` is how a version restore reaches a document that is open, and `apps/api/src/lib/versioning/restore.ts` is its only caller. It holds no container lock, because the surgery is synchronous and nothing can interleave with it. It delegates to `restoreYjsDoc` (`packages/lib/src/core/collab/yjs-utils.ts`), which replaces the doc's **declared roots** (the `yjsRoots` schema on `EIGEN_DOC_TYPE_INFO`) with a snapshot's contents inside one transaction. That transaction's update fires the normal `update` handler, so it persists and broadcasts like any other edit: **connected editors converge live, with no reload and no merge fight**, and disconnected sessions pick the new state up on their next sync handshake.

The walker handles every Y subtype an Eigen container uses (`Y.Map`, `Y.Array`, `Y.Text`, `Y.XmlFragment` for Tiptap) at any nesting depth. It rebuilds Y instances on the live doc rather than transplanting them, because a Y item's identity is tied to its source doc. Both docs' roots are force-typed before the walk: `Y.applyUpdate` hydrates a root as `AbstractType`, so an `instanceof` check would otherwise misclassify it.

## Home replacement closes every socket

When a backup restore replaces a home's folder, `closeCollabConnectionsForHome` (`apps/api/src/lib/collab/connections.ts`) closes every socket of that home with `COLLAB_STORAGE_UNAVAILABLE_CLOSE`, and a socket that connects while the restore runs meets the home's 503 and the same close. The tab keeps its document and retries, so the close alone does not stop it from syncing its old state back. The home's data epoch does: a restore rotates it once the new folder is whole, so the first reconnect after it names the old epoch and gets `COLLAB_HOME_REPLACED_CLOSE`, and the tab reloads instead of syncing the document it holds back over the restored copy. A restore that fails leaves the epoch, and the reconnect syncs the tab's edits. See [BACKUP.md](BACKUP.md).

A tab that was offline through a restore, or through `./eigen restore`, has no socket to close. The home's data epoch catches it ([SSE.md](SSE.md#a-restore-reloads-every-tab-of-the-home) defines it). Every open sends the epoch of the document's home in a `COLLAB_EPOCH_MESSAGE` frame before the sync, `useCollabDoc` reconnects with `?epoch=`, and the route closes a reconnect that names another epoch with `COLLAB_HOME_REPLACED_CLOSE` before it syncs anything. A restart or an update keeps the epoch, so an offline edit still syncs. The hook keeps BroadcastChannel off until the first epoch arrives and then joins a channel named after it: a reloaded tab never takes state from a sibling tab still holding the document from before the restore.

## The client gates on `loaded`, never `synced`

`useCollabDoc` (`packages/lib/src/core/collab/hooks/use-collab-doc.ts`) owns the Y.Doc, the WebSocket provider and the UndoManager for every editor. `synced` follows the socket. `loaded` latches on the first sync and resets only on teardown or a document switch. **Gate the loading screen on `loaded`.** A short outage must not unmount the editor, which would destroy its undo history and selection. While the socket is down, edits land in the local Y.Doc and y-websocket pushes them on the next handshake.

Every editor, sheets included, wraps its toolbar and body in `CollabDocumentGate` (`packages/ui/src/components/layout/app/`), so no toolbar exists before load. After 10 s the loading screen says storage is slow, since a cold open can legitimately take that long.

Before that, the route asks `useCollabDocumentInfo` whether the user may read the document. Only a 401 or 403 means no access. Anything else throws and shows an error, so an outage never offers to request access to a document the user owns.

## Each close code tells the tab what to do

The codes live in `packages/lib/src/constants/collab.ts`.

| Close | The tab |
|---|---|
| 1013 `storage-unavailable` | Any server-side (5xx) failed open, not only an outage. Shows "retrying" and reconnects itself after 5 s. y-websocket would retry every 2.5 s and re-pay the failing load each time. |
| 4410 `storage-gone` | Stops for good. The loading screen shows an error and offers the version list to a writer. An open editor stays mounted and reads as offline. |
| 1012 `home-replaced` | Reloads through `reloadReplacedHome`, the reload the event stream uses too, one render after clearing the unsynced flag, so the leave prompt doesn't block the reload. |

The share cluster's offline icon waits 1.5 s after a disconnect, so a blip or the storage retry's brief connect doesn't flash it.

## Unacknowledged edits guard the tab

Nothing persists in the browser, so a reload loses whatever the server has not acknowledged. `unsyncedEdits` arms on an update while the socket is down. It also arms on the disconnect event when this tab made updates since the last handshake: a silently dead socket looks connected until y-websocket's 30 s silence check, so the close is the first honest signal. For that check, updates y-websocket applied itself (from the server or a sibling tab) don't count, so a reader is never warned about someone else's edits. The flag clears on the next sync. Every editor renders `UnsyncedEditsGuard` once, which asks before a reload, a close or an in-app navigation.

## See also

- [CANVAS.md](CANVAS.md): one discrete op is one undo step on the canvas
- [STICKIES.md](STICKIES.md): the typed Yjs root accessors and the parent-child ref repair
- [DOCUMENT-CONTENT-LAYER.md](DOCUMENT-CONTENT-LAYER.md): the readers and writers over a materialized `Y.Doc`
- [BACKUP.md](BACKUP.md): what a restore does to an open document
- [STORAGE.md](STORAGE.md): container layout and file versioning
