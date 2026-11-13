# Collab Documents

> **TLDR:** A doc, a sheet, a slide deck, a stickies board and a drawing are all collab documents: several people edit one at the same time and see each other's changes and cursors live. Each browser holds a full copy of the document, and the server relays every change to the other browsers and stores it in the document's own SQLite file. The server half is `apps/api/src/lib/collab/` with the socket route `apps/api/src/routes/collab.ts`. The client half is `useCollabDoc` in `packages/lib/src/core/collab/`.

The document is a Yjs document. Yjs is a library for shared data that merges concurrent edits without conflicts. An edit becomes a small binary update, and every copy that applies the same updates, in any order, ends up the same. So the server does not need to understand a document to serve it. It passes updates on and keeps them. A chat is not a collab document: its messages are rows in a database ([CHAT.md](CHAT.md)).

On disk a collab document is a container: a Drive folder named like a file, such as `Notes.eigendoc`. Inside is `data.db`, a SQLite file with two tables. `doc_updates` holds every update since the last snapshot, as it arrived. `doc_snapshots` holds one snapshot, the whole document state in one blob, rewritten after every 100 updates or 1 MB of them. Loading a document reads the snapshot and the updates after it. The same folder holds `comments.db`, the comment threads, the media the document embeds and its version history ([COMMENTS.md](COMMENTS.md), [MEDIA-REFERENCES.md](MEDIA-REFERENCES.md), [STORAGE.md](STORAGE.md#version-snapshots-live-inside-the-container)).

A browser opens one WebSocket per document, and the server keeps one `CollabDocument` in memory for each document someone has open. The two sides first exchange what the other is missing, the sync handshake (y-websocket's sync step 1 and step 2). From then on each update goes to the server, into `data.db`, and out to the other sockets. Awareness is the second thing on the socket: who is here and where their cursor is. It is never stored.

Access is Drive's. The socket checks read and its session when it opens and every 15 s, and write on every update ([ACL.md](ACL.md)). Nothing persists in the browser, so an edit the server has not acknowledged is lost on reload, and the tab warns before that happens.

The sections follow the places where this picture needs care: big documents and slow links, hostile or stale peers, replacing a document under its editors, and the editor in the browser. Six things in them surprise people:

- The blobs in `data.db` are zstd on disk and raw on the wire, and the reader takes compressed and raw rows alike ([§ Yjs blobs](#yjs-blobs-are-zstd-on-disk-and-raw-on-the-wire)).
- A read-only peer can still send awareness, so it is validated before it is applied ([§ Awareness frames](#awareness-frames-are-validated-before-apply)).
- The route sends a heartbeat during a cold load, or the client would close the silent socket and retry forever ([§ The route speaks first](#the-route-speaks-first-during-a-cold-load)).
- The WebSocket uses Bun's shared deflate compressor, which is safe for Safari since Bun 1.4.4 and costs no per-socket zlib state ([§ Deflated frames](#a-deflated-frame-never-ends-the-deflate-stream)).
- A backup restore rotates the home's data epoch, an id that changes only when the home's data is replaced or the server is updated, so a reconnecting tab reloads instead of syncing its old state over the restored copy ([§ Home replacement](#home-replacement-closes-every-socket)).
- The editor waits on a latched `loaded`, never on `synced`, so a short outage keeps it mounted ([§ The client gates on `loaded`](#the-client-gates-on-loaded-never-synced)).

## Yjs blobs are zstd on disk and raw on the wire

Yjs blobs (`doc_snapshots.stateData`, `doc_updates.updateData`) are compressed at the SQLite boundary only, in `apps/api/src/lib/collab/blob-codec.ts`. **The live WebSocket protocol exchanges raw Yjs updates**, so sync is untouched by it. The motivation is that a Yjs snapshot embeds the whole document state verbatim: a large sheet's snapshot rides at ~48 MB raw and ~1 MB at zstd level 3. Updates below `COMPRESS_MIN_BYTES` (1 KiB) stay raw, because frame overhead outweighs the gain on a keystroke-sized update.

`decompressBlob` sniffs the 4-byte zstd frame magic and passes a raw blob through untouched. The BLOB column stores either form and every row decodes independently. The magic cannot plausibly arise from lib0-encoded Yjs data, and a false positive would throw inside the caller's existing `try/catch` and skip that one row rather than silently corrupt state.

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

`app.ts` sets `perMessageDeflate: true`, Bun's compressor shared by all sockets. A dedicated one would hold ~282 KB of zlib state per socket on Bun 1.4.4 (its release notes: 149 KB before they honoured the window sizes; a shared one ~8 KB, unmeasured on 1.4.4). RFC 7692 lets a compressor end a message's deflate stream with the final-block bit (BFINAL), but Safari on macOS and iOS then delivers the frame and drops the connection ("The network connection was lost", a 1006 close on the server). Chrome accepts it. A doc edited by more than ~170 Yjs clients has a state vector over 1 KiB, so its very first frame, sync step 1, is deflated and Safari would never load it: the socket loops open → dropped → retry. Bun's shared compressor did exactly that for small messages until 1.4.4, which ends a frame with a sync flush and leaves the stream open, as browsers do themselves, so the Bun version is pinned. `collab-ws-payload.test.ts` reads a deflated frame off a raw socket under the app config and fails on BFINAL.

## The route refuses before it speaks

An unauthenticated upgrade never reaches `open`. The `auth` macro answers the HTTP upgrade itself, so the handler's user is always a session user.

A caller without read access gets nothing but the constant empty awareness heartbeat ([The route speaks first during a cold load](#the-route-speaks-first-during-a-cold-load)), then close 4403, and so does a path that does not exist, which reads as no access in `/info` too. That is why the heartbeat may start before the access check: it carries no document data.

Three failed opens close with their own codes, so the tab knows what to do ([Each close code tells the tab what to do](#each-close-code-tells-the-tab-what-to-do)): home-replaced after a restore, storage-unavailable for any server-side (5xx) failure, an outage or a local one such as a full disk, and storage-gone (4410: the stored object is gone, so the client stops retrying). Every other failed open, such as a document in the trash, is 1008.

Binary frames arrive as Bun `Buffer`s. A string frame is `ping` or `pong`, or it is ignored.

The route keeps its per-socket state (the `opened` gate, the drive, the document, the keepalive, the hold on the Home) in a `WeakMap` keyed by the raw Bun socket. That socket is the one identity that survives Elysia's fresh wrapper per event. User and params come from the typed `ws.data`.

## Read and the session are checked at open and every 15 s, write on every message

The route checks write on every binary frame, so a writer demoted to reader, or whose share or team went, loses write with the next frame. `CollabDocument.handleMessage` drops a sync update from a peer without write and still answers its sync step 1 and awareness. The route keeps each socket's session in a map keyed on `ws.raw`: Elysia's Bun WebSocket adapter hands every open, message and close a fresh wrapper, so a map keyed on `ws` never matches between events.

Read and the session have one check, `checkAccess` in the route's `open` (`apps/api/src/routes/collab.ts`). It runs when the socket has opened and again on the socket's 15 s keepalive. It reads the socket's session and that session's user with `getSessionUser` and asks `Drive.canRead` with that row. A session that is gone or past its expiry, a user with no row, or a user who may no longer read closes the socket with 4403. So nothing has to tell a socket what happened: an ACL change, a move out of a shared folder (read inherits from the whole ancestor chain), a team or membership that goes, a deleted user, a password reset, a sign-out, a session revoked through `/auth/revoke-session` or the admin's `/admin/revoke-user-session` and `/admin/revoke-user-sessions`, and a new email that the ACL doesn't name all reach it the same way, and no way out needs a hook of its own. `apps/api/src/test/collab/collab-membership-revoke.test.ts` pins them, running each tick by hand.

The price is up to 15 s. Until the tick a socket that lost read still receives edits and cursors, and a deleted or reset user's edit can still land, because the frame's write check uses the user as the socket opened and an ACL entry outlives its user. That is accepted. A check that throws is logged and leaves the socket, and the next tick asks again.

Each check reads straight from the databases, with no cache. Each socket's timer starts when it opens, so the checks spread by themselves, with no jitter and no batching. Measured on an M1 Pro dev Mac that other test runs shared, with 20,000 users and 1,200 open sockets: one check took about 240 µs, about 1.1 ms on a document 254 folders deep, and a thousand of them run at once 258 ms, which only timers that happened to coincide would do.

A session is one browser, so a socket ends with the session that opened it, and other devices keep theirs. The tab's event stream ends the same way ([SSE.md](SSE.md#the-keepalive-keeps-a-proxy-from-closing-the-stream)). What ends one:

| Action | Sessions it ends | The tab |
|---|---|---|
| Change password, **Log out of all other devices** ticked (`revokeOtherSessions`, the default) | All of the user's, its own included: better-auth deletes them and makes a new one with a new cookie | Every open document closes with 4403. In the browser that changed it the reload carries the new cookie, so the editor comes back |
| Change password, box unticked | None | Nothing closes |
| `/auth/revoke-sessions` | All of the user's, its own included | The reload lands on sign-in |
| `/auth/revoke-other-sessions` | All but its own | Other devices' reloads land on sign-in |
| Sign-out | That session, which every tab of that browser shares | The reload lands on sign-in |
| Turning two-factor on or off | That session, replaced by a new one with a new cookie | The browser's open documents reload once, onto the new cookie |
| Admin's password reset, `./eigen reset-password` | All of the user's | The reload lands on sign-in |
| Deleted user | All of the user's, and the user row | The reload lands on sign-in |

A reload can't loop: the page that comes back opens a socket only if the session and read hold, and those are what the check reads. A tick that lands in the moment between a password change's commit and the browser storing its new cookie reloads on the old cookie, which lands on sign-in. The user signs in again. Like any 4403, it loses only the typing still in flight in that round trip ([the 4403 row](#each-close-code-tells-the-tab-what-to-do)).

The check at open is why a change during a cold load isn't left to the first tick: it found no connection to close, and a load can take as long as a download. That check reads only SQLite, so no edit reaches the socket during it, and a client's frames wait for `opened`. A socket that fails has its session cleaned up first, so its sync step 1 gets no reply and a waiting edit lands nowhere. The test file above pins that with a held load. What such a socket did get before the close is the sync step 1 and the awareness frame of `subscribe`: a state vector and the other editors' names and cursors, no document content. A failed check at open closes with the retry code, so the client reconnects.

## A document lingers after the last unsubscribe

A document closes `CLOSE_LINGER_MS` (60 s) after its last connection drops, and as long after an open that no socket joins (`CollabDocument.scheduleClose`). A new subscribe cancels the timer. After a drop, the wait lets a reload or a brief disconnect reattach to the loaded document instead of paying for the load again. After an open, it closes the document of a server-side writer, such as an import or a convert, that no socket may ever join. Without it, that document would stay in memory with its `data.db` open until the Home closes. A lingering document holds its Home (`Drive.holdHome`), because edits over a socket are no requests, and after a long session the Home would otherwise close under the linger.

A workbook with batches in its op log ends its linger with a compaction: the server folds the head of the log, as much as it replays before the run's deadline, into a fresh snapshot before the close (`closeAfterLinger`, [SHEETS.md](SHEETS.md#the-server-folds-the-log-into-the-snapshot-when-the-workbook-closes)). The registry still holds the document during the run, so a socket that connects meanwhile reattaches to it, and the document stays open until its next linger. The swap deletes exactly the batches the run folded, and only while the log still opens with them, so a batch that came in after them during the run stays in the log. Before the swap it saves a version that keeps the log, and a version that fails leaves the document as it is. A batch that landed among the folded ones, or a new snapshot, during the run or the version makes the result stale: it is dropped, and the document lingers again. When a socket is connected at the end of the run, nothing is swapped and the document stays open. A socket that came and left during the run holds every batch the run folded, and the batches it holds past them stay in the log, so the swap goes ahead. A destruct aborts the run.

So a server-side writer opens the document right before it writes, with no await in between. The document can close during any await, such as a transform that outlasts the linger or a version while a compaction ends. A write into a closed document's Y.Doc throws nothing and is neither saved nor broadcast. An import reads what it needs early as a value and opens the document again for the commit, after its version, its pictures and its write check (`importIntoDocument`).

## A drive that is closing refuses a new open

Once `Drive.destruct` starts its sweep of the open documents, the registry (`apps/api/src/lib/drive/collab-registry.ts`) answers every open with a 503. A document that registered after that sweep would never be destructed, and the mount teardown that follows would close its database under it.

A trash refuses nothing of its own. It marks the path trashed before it closes anything, so from then on an open of the path or of anything under it is a 404, and the documents still open there close after the mark and save their last edits into the trash ([SOFT-DELETE.md](SOFT-DELETE.md#trash-marks-the-item-first-then-closes-what-is-open-under-it)).

## An open waits for data.db and never makes one

`Drive.create` makes a document's `data.db` and `comments.db` together with its container. A copy makes the container first and copies the files into it after, so an open in between finds no `data.db`. `CollabDocument.open` answers that open with a 503, and the socket gets the storage-unavailable close and retries until the copy is done. An open that made an empty `data.db` instead would stop the copy with a 409 and leave half a container with an empty document. A container whose copy stopped before its `data.db` landed never opens ([ROADMAP.md](ROADMAP.md)). `apps/api/src/test/collab/collab-open-during-copy.test.ts` pins it.

## Modified moves for an update, never for an open or a close

The `update` handler stamps the container's Modified time at most once a minute (`TOUCH_THROTTLE_MS`), since typing fires many updates a second. An update the throttle skips is stamped when the document closes, with its own time. So a document that was only read keeps its Modified time, and the last edit is not dated a linger after the last viewer left. For the same reason a workbook's compaction, which changes what is stored and not what the document shows, moves no Modified time: it runs under an origin of its own ([SHEETS.md](SHEETS.md#the-server-folds-the-log-into-the-snapshot-when-the-workbook-closes)). `apps/api/src/test/collab/collab-modified-touch.test.ts` pins it.

## A version restore rewrites an open document in one transaction

`CollabDocument.applySnapshotState` is how a version restore reaches a document that is open, and `apps/api/src/lib/versioning/restore.ts` is its only caller. It holds no container lock, because the surgery is synchronous and nothing can interleave with it. It delegates to `restoreYjsDoc` (`packages/lib/src/core/collab/yjs-utils.ts`), which replaces the doc's **declared roots** (the `yjsRoots` schema on `EIGEN_DOC_TYPE_INFO`) with a snapshot's contents inside one transaction. That transaction's update fires the normal `update` handler, so it persists and broadcasts like any other edit: **connected editors converge live, with no reload and no merge fight**, and disconnected sessions pick the new state up on their next sync handshake. An open sheet tab loads the restored snapshot into its mounted grid ([SHEETS.md](SHEETS.md#a-new-snapshot-loads-into-the-mounted-grid)).

The walker handles every Y subtype an Eigen container uses (`Y.Map`, `Y.Array`, `Y.Text`, `Y.XmlFragment` for Tiptap) at any nesting depth. It rebuilds Y instances on the live doc rather than transplanting them, because a Y item's identity is tied to its source doc. Both docs' roots are force-typed before the walk: `Y.applyUpdate` hydrates a root as `AbstractType`, so an `instanceof` check would otherwise misclassify it.

## Home replacement closes every socket

A socket holds the Home of its document's owner (`Drive.holdHome`) from the moment `getSharedDrive` finds it until `cleanupSession` lets go, so the Home never idles out under an editor who only types. A Home that closes anyway, such as for a backup restore, a deletion, a team drive's new storage or on/off switch, or the shutdown, destructs its open documents, but first runs the callback each socket passed to `holdHome`, which closes the socket with `COLLAB_STORAGE_UNAVAILABLE_CLOSE`. A document that closes alone, such as a trashed one, closes its sockets with no code, so those tabs reconnect without the "Storage unavailable" badge. A Home that began to close after `getSharedDrive` found it refuses the hold with a 503, and a socket that connects while a restore runs meets the restore's 503. The route closes both with the same code. `apps/api/src/test/collab/collab-home-pin.test.ts` pins the hold and the close.

The tab keeps its document and retries, so the close alone does not stop it from syncing its old state back. The home's data epoch does: a restore rotates it once the new folder is whole, so the first reconnect after it names the old epoch and gets `COLLAB_HOME_REPLACED_CLOSE`, and the tab reloads instead of syncing the document it holds back over the restored copy. A restore that fails before the rotation leaves the epoch as it was, and the reconnect syncs the tab's edits. A failure after it, in its save or in removing the note, leaves the epoch rotated over the home that went back, so the tab reloads once and drops what it had not synced, which is accepted. The route compares the epoch only after `getSharedDrive`, so a reconnect while the home is marked restoring gets the 503, whatever the epoch says at that moment, and reloads only for a restore that finished. See [BACKUP.md](BACKUP.md).

A tab that was offline through a restore, or through `./eigen restore`, has no socket to close. The home's data epoch catches it ([SSE.md](SSE.md#a-restore-reloads-every-tab-of-the-home) defines it). Every open sends the epoch of the document's home in a `COLLAB_EPOCH_MESSAGE` frame before the sync, `useCollabDoc` reconnects with `?epoch=`, and the route closes a reconnect that names another epoch with `COLLAB_HOME_REPLACED_CLOSE` before it syncs anything. A restart keeps the epoch, so an offline edit still syncs. An update changes it, so a tab from before the update reloads without syncing its edits: they may hold structures the new code no longer reads. The hook keeps BroadcastChannel off until the first epoch arrives and then joins a channel named after it: a reloaded tab never takes state from a sibling tab still holding the document from before the restore.

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
| 1012 `home-replaced` | Reloads through `reloadReplacedHome`, the reload the event stream uses too, one render after clearing the unsynced flag, so the leave prompt doesn't block the reload. A reconnect would sync the tab's copy back over the restore, so its unsynced edits go with it. |
| 4403 access lost | The user may not read this document, whether a revoke took it, the socket's session ended or an open was refused. Stops for good and reloads one render after clearing the unsynced flag, so typing in flight in that one round trip, which the server has not acknowledged, is lost. That is accepted. The reload shows what applies now: the editor again on a new session's cookie, the route's request-access screen, or sign-in. A query refetch can't do the second, because `AuthProvider` reads the session once per page load and `useCollabDocumentInfo` turns a 401 into no access. |
| 1008 | Any other failed open, such as a document in the trash. y-websocket retries it every 2.5 s. |

The share cluster's offline icon waits 1.5 s after a disconnect, so a blip or the storage retry's brief connect doesn't flash it.

## Unacknowledged edits guard the tab

Nothing persists in the browser, so a reload loses whatever the server has not acknowledged. `unsyncedEdits` arms on an update while the socket is down. It also arms on the disconnect event when this tab made updates since the last handshake: a silently dead socket looks connected until y-websocket's 30 s silence check, so the close is the first honest signal. For that check, updates y-websocket applied itself (from the server or a sibling tab) don't count, so a reader is never warned about someone else's edits. The flag clears on the next sync. Every editor renders `UnsyncedEditsGuard` once, which asks before a reload, a close or an in-app navigation.

## See also

- [CANVAS.md](CANVAS.md): one discrete op is one undo step on the canvas
- [STICKIES.md](STICKIES.md): the typed Yjs root accessors and the parent-child ref repair
- [DOCUMENT-CONTENT-LAYER.md](DOCUMENT-CONTENT-LAYER.md): the readers and writers over a materialized `Y.Doc`
- [BACKUP.md](BACKUP.md): what a restore does to an open document
- [STORAGE.md](STORAGE.md): container layout and file versioning
