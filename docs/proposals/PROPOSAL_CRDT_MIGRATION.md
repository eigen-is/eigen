# Proposal: CRDT format migration

> **Status — Proposal, written 2026-07-05, re-verified against code 2026-07-06 (post storage-audit
> landings), not started.** Flagship P0 item from
> [ROADMAP.md](../ROADMAP.md) § Data-trust foundation. Eigen is live and its Yjs document formats
> (the root names and value shapes each app reads) are frozen. The day one of the four editors
> needs to restructure its data — stickies grows swimlanes, sheets replaces its op log, docs
> changes an attribute encoding — there is currently **no way to ship it**. This proposal designs
> the system that makes such a change routine: a per-container format stamp, a per-type migration
> registry, lazy migration on open plus a dormant-doc sweep, a WebSocket format handshake so stale
> clients can't write old-shaped data, and a snapshot-first rollback story. The core primitive
> already exists (`restoreYjsDoc`); everything on top is net-new.

## Problem

Every Eigen collab document (`.eigendoc`, `.eigenstickies`, `.eigenslides`, `.eigensheets`) is a
drive container whose `data.db` holds Yjs state as opaque update/snapshot BLOBs. What the *SQLite
schema* of that file looks like is versioned and migratable today (`ManagedDatabase` runs
`DatabaseConfig.migrations` on every open). What the *Yjs state inside the BLOBs* looks like — which
roots exist, what a task/slide/cell entry contains — is versioned nowhere. It is implicitly "whatever
the current app code writes", and the ROADMAP freezes it precisely because nothing can evolve it.

Concretely, four things are missing:

1. **No stamp.** Given a `data.db`, nothing records which semantic format its Yjs state is in.
2. **No migration path.** There is no place to put a "stickies v1 → v2" transform, and no machinery
   to run one against thousands of containers spread across local and S3-backed mounts.
3. **No client fencing.** The collab WebSocket accepts any authenticated client and applies its
   sync updates verbatim. A browser tab running last week's bundle would keep writing old-shaped
   data into a migrated document.
4. **No rollback story.** A migration that mangles content needs a designed recovery, not forensics.

Because a CRDT's update history cannot be rewritten (concurrent edits, GC'd tombstones, client
clocks), "migrating" cannot mean editing history. It has to mean **squash-to-snapshot**: build the
new-format state, persist it as a fresh consolidated snapshot, and fence out writers that still
speak the old format.

## Goals

1. A per-container **format version stamp** that survives copy, version-restore, export/import,
   and a server downgrade.
2. A **flat migration registry** — pure functions per `EigenDocType`, no plugin architecture —
   that migrates a doc's Yjs state from any stamped version to current.
3. **Lazy migrate-on-open**: any document opened for collab is migrated before the first client
   syncs, with a pre-migration version snapshot as the rollback net.
4. A **dormant-doc sweep** that walks the fleet in the background, paced so S3-backed mounts are
   not hammered, resumable, and able to report "all containers ≥ N" so format N−1 can eventually
   be declared archive-only.
5. A **format handshake** on the existing collab WebSocket so a stale client is refused before its
   first update, with a clear "reload" UX.
6. **Version history keeps working**: restoring a pre-migration snapshot must not re-introduce the
   old format into a live doc.

## Non-goals

- **Chat containers.** Chat's `data.db` is plain SQLite rows (`CHAT_ROOM_DB_CONFIG` in
  `../../apps/api/src/lib/chat/db-config.ts`), not Yjs; its shape already evolves through
  `ManagedDatabase` migrations, and it has no live CRDT clients to fence (messages go through
  REST + SSE). Same for `comments.db` (`COMMENT_INDEX_DB_CONFIG`). This proposal covers the four
  Yjs types only (`DriveCollabType` in `../../packages/lib/src/types/drive.ts`).
- **Rewriting update history.** Squash-to-snapshot is the mechanic; fine-grained intra-`data.db`
  history is compacted (it already is — see Current state).
- **Client-side offline persistence.** Eigen clients hold Yjs state in memory only (no
  y-indexeddb); this design does not add offline storage, it only handles the in-memory case.
- **A concrete first migration.** This is the machinery. The first real format change ships as its
  own reviewed change on top of it.

## Current state (grounded)

**Storage.** Each collab container is an `.eigen*` drive folder holding `data.db` (plus
`comments.db`, `media/`, `chat/` — see `CollabDocument.create` in
`../../apps/api/src/lib/collab/collabDocument.ts`). `data.db` is a `ManagedDatabase` opened with
`COLLAB_DB_CONFIG` (`../../apps/api/src/lib/collab/db-config.ts`, currently schema v1): two tables,
`doc_updates` (one BLOB per Yjs update) and `doc_snapshots` (consolidated state BLOBs). BLOBs are
zstd-compressed at the storage seam by `blob-codec.ts`, which is the in-repo precedent for format
evolution at this layer: **new readers sniff the 4-byte zstd magic and pass legacy raw blobs
through untouched — absence of the marker means "old format", old and new rows coexist, no schema
migration needed**. This proposal reuses that stance one level up: absence of a format stamp means
format 1.

**Compaction already happens.** `DbProvider.createSnapshot` (in `collabDocument.ts`) squashes the
doc into a fresh snapshot every 100 updates or 1 MB, deletes the covered `doc_updates`, and keeps
only `MAX_DOC_SNAPSHOTS = 1` snapshot. Long-term history lives *outside* `data.db`, as whole-file
copies under the container's `versions/` folder (`../../apps/api/src/lib/versioning`). So
"migration compacts in-file update history" is not a new loss — it is the steady state.

**Lifecycle.** `Drive.getCollabDocument` delegates to `CollabRegistry`
(`../../apps/api/src/lib/drive/collab-registry.ts`), which keys one `createAsyncSingleton` per
`owner.mount.path` — **concurrent opens of the same doc coalesce into a single `init()`**; a second
opener awaits the first. `CollabDocument.init` opens `data.db` via `Drive.openDatabase` →
`Mount.openDatabase` (`../../apps/api/src/lib/mount/document-db.ts`, which runs `ManagedDatabase` SQLite
migrations; open and close are serialized per pathId via `closingDocumentDbs` — a 2026-07
storage-audit change), then `DbProvider` hydrates a `Y.Doc` via `loadYjsState`
(`../../apps/api/src/lib/collab/yjs-loader.ts`: latest snapshot + tail updates, corrupted rows skipped).

**Sync protocol.** `routes/collab.ts` exposes `/ws/collab/:ownerId/:mountId/:pathId`. Auth +
`canRead` at open, `canWrite` re-checked per message. Wire format is standard y-protocols: message
type 0 = sync (steps 1/2/update), 1 = awareness, plus a string `ping`/`pong` keepalive. There is
**no version negotiation of any kind**. Clients use stock `y-websocket`'s `WebsocketProvider`
against a URL from `getCollabWebSocketUrl` (`../../packages/lib/src/core/api.ts`) — see
`../../apps/docs/src/components/docs/editor.tsx` and
`../../apps/stickies/src/components/stickies/hooks/use-board.ts`. Each editor mount creates a fresh
in-memory `Y.Doc`; unsent edits live only in the tab.

**The restore primitive.** `restoreYjsDoc` (`../../packages/lib/src/core/collab/yjs-utils.ts`) replaces a
live `Y.Doc`'s declared roots with the contents of a state update, inside one transaction, so
connected editors converge through the normal update broadcast. It is driven by the per-type root
schema `EIGEN_DOC_TYPE_INFO[type].yjsRoots` (`../../packages/lib/src/types/drive.ts`) and used by
`CollabDocument.applySnapshotState` during version restore (`../../apps/api/src/lib/versioning/restore.ts`).
Its limits matter here: it **cannot remove a root** (Yjs roots are permanent once created in a doc)
and it only touches roots the schema declares.

**The server-side `Y.Doc` gotcha.** A doc hydrated via `Y.applyUpdate` exposes its roots as
`AbstractType` — `instanceof Y.Map` etc. fails on them. The codebase idiom is **force-typing roots
through the typed getters before use**: `forceTypeRoot` in `yjs-utils.ts` calls
`doc.getMap(name)`/`getArray`/`getText`/`getXmlFragment` per the declared `yjsRoots` schema, and
server-side readers like `readEigendocContent` (`../../apps/api/src/lib/document/doc.ts`) do the same by
calling `ydoc.getXmlFragment('default')` directly. (Earlier code sniffed internals like `_start`;
that idiom is gone — the declared-schema + force-typing approach superseded it.) Nested shared
types decode concretely; only roots need this. The migration runner below does it once, centrally.

**Declared roots per type** (the schema a migration registry is keyed by):

| Type | `yjsRoots` |
|---|---|
| `doc` | `{ default: 'xmlfragment' }` (Tiptap) |
| `stickies` | `{ columns: 'map', tasks: 'map', columnOrder: 'array' }` |
| `slides` | `{ slides: 'map', objects: 'map', slideOrder: 'array' }` |
| `sheets` | `{ state: 'map', ops: 'array' }` |
| `chat` | — (no Yjs; out of scope) |

**Versioning mechanics.** `snapshotContainerDataDb` (`../../apps/api/src/lib/versioning/snapshot.ts`)
copies `data.db` to `versions/<iso-ts>.db`, **self-locked on the container** via
`mount.withPathLock` — manual save and a restore's pre-restore snapshot block on that lock, while
the periodic timer/close path goes through the twin `trySnapshotContainerDataDb` (skip-if-contended
via `tryWithPathLock`, so a close can never park on a held container lock — a 2026-07 storage-audit
change). Both paths contend on the same lock, so anything holding it excludes every snapshot taker. `restoreContainer` (`versioning/restore.ts`) grabs the target into the OS temp
dir first, takes a pre-restore snapshot, then does Yjs surgery via
`readYjsStateFromFile` + `applySnapshotState` — never holding a lock across steps. Retention
(`versioning/retention.ts`) prunes by parsing the timestamp filename; **names that don't match
`SNAPSHOT_NAME_FORMAT` are invisible to both `listVersions` and the pruner** (relevant for the
rollback question below).

**Background-work precedents.** `scheduleInterval` + `jobs.ts` (`../../apps/api/src/lib/scheduler`) for
in-process periodic jobs; `ContentReindexQueue` (`../../apps/api/src/lib/mount/content-reindex-queue.ts`)
for per-mount paced drains where **the durable queue is a column on `paths`** (`contentDirty`,
added in metadata.db v6 with an open-time backfill) rather than a separate table. The sweep below
copies both patterns.

The roadmap row survives grounding as written: the primitive exists, everything else is net-new.

## Design

### Two version spaces, kept distinct

- **SQLite schema version** — already exists: `__schema_version` inside every `ManagedDatabase`,
  driven by `DatabaseConfig.migrations`. Answers "which tables/columns does this file have".
- **Collab format version** — new: a small integer per container answering "which semantic Yjs
  shape does the state in `doc_snapshots`/`doc_updates` follow for this `EigenDocType`".

The first is machinery we extend (one additive migration); the second is data this proposal adds.

### Where the stamp lives

Three candidate homes, weighed:

| Option | Survives byte-copy of the container? | Survives version-restore? | Survives export/import? | Cost |
|---|---|---|---|---|
| **A. Row in the container's `data.db`** | Yes — containers copy as byte copies and reference children by name ([AGENTS.md](../../AGENTS.md) § Copy/move), so `data.db` travels whole | Yes — `versions/<ts>.db` is a full copy of `data.db`, so every archive self-describes its format | Yes — exports carry the container's files | One additive `COLLAB_DB_CONFIG` migration |
| B. A meta root inside the `Y.Doc` | Yes | Only if restore surgery special-cases it | Yes | Is itself a frozen-format change to every doc; requires hydrating the doc just to read the version; `restoreYjsDoc` would need to exclude it from surgery |
| C. Column in the mount's `metadata.db` | **No** — cross-mount copy/export rebuilds rows; the stamp detaches from the bytes it describes | No — restore doesn't touch metadata | No | Cheap to query |

**Decision: A.** A single-row table in `data.db`, mirroring `__schema_version`'s shape exactly,
added as `COLLAB_DB_CONFIG` migration v2 (the existing, sanctioned mechanism — every open runs it):

```sql
CREATE TABLE IF NOT EXISTS doc_format (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL
);
```

- **Missing row ⇒ format 1.** Every `data.db` in production today, every old `versions/*.db`
  archive, every previously exported container reads as format 1 without backfill — the
  `blob-codec.ts` "absence means legacy" stance.
- New containers get the current version written at creation.
- Old server builds opening a stamped file are unaffected: `ManagedDatabase.runMigrations` only
  applies migrations *above* the stored schema version, and old code simply never reads
  `doc_format`. Deliberate downgrade tolerance (see Rollback).
- Option C returns below — not as the source of truth, but as a **query cache** so the sweep can
  find stale containers without downloading every `data.db`.

### Current format number: one source of truth

`EIGEN_DOC_TYPE_INFO` already centralizes per-type facts (mime, extension, `yjsRoots`); the current
format version joins it as a required field on the four collab entries:

```typescript
// packages/lib/src/types/drive.ts — EigenDocTypeInfo gains:
collabFormatVersion?: number;   // present iff yjsRoots is; starts at 1 for all four types
```

Shared FE+BE on purpose: the **client's** shipped bundle reads it to declare what it understands in
the WS handshake, and the **server** reads the same constant as the migration target. A startup
assertion (and a unit test) pins `1 + migrations.length === collabFormatVersion` per type so the
constant and the registry can never drift.

### The migration registry

Server-only, `apps/api/src/lib/collab/migrations.ts` — flat and direct, mirroring how
`EIGEN_DOC_TYPE_INFO` centralizes per-type facts. No plugin loading, no dynamic discovery:

```typescript
type CollabFormatMigration = {
    toVersion: number;                            // 2, 3, ... contiguous
    fromRoots: Record<string, YjsRootKind>;       // the *pre*-migration root schema
    migrate: (from: Y.Doc, to: Y.Doc) => void;    // pure, synchronous, in-memory
};

const COLLAB_FORMAT_MIGRATIONS: Record<DriveCollabType, CollabFormatMigration[]> = {
    doc: [], stickies: [], slides: [], sheets: [],
};
```

- `migrate` reads from a hydrated temp doc and **writes into a fresh empty doc**. The runner
  force-types `from`'s roots per `fromRoots` before calling it (`forceTypeRoot`, reused from
  `yjs-utils.ts` — today module-private there; export it), so migration authors work with concrete
  `Y.Map`/`Y.Array`/etc. and never touch
  the `AbstractType` gotcha. Writing into a fresh doc — rather than mutating in place — is what
  lets a migration **drop or rename a root**, which `restoreYjsDoc` alone cannot.
- `fromRoots` is snapshotted into the entry because root schemas may change across versions;
  `EIGEN_DOC_TYPE_INFO.yjsRoots` always describes the *current* format (the post-state of the last
  migration), which is exactly what the live-doc surgery needs.
- The pure core the rest of the system calls:

```typescript
// Chain v_from → current entirely in memory; no I/O, no persistence.
function migrateCollabState(type: DriveCollabType, state: Uint8Array, fromVersion: number): Uint8Array;
```

### What "migrating" persists: squash-to-snapshot

Rewriting `doc_updates` rows is off the table — Yjs updates reference client clocks and GC'd
tombstones that no transform can preserve coherently. The persistent mechanic is:

1. Load the stored state (`loadYjsState` — latest snapshot + tail updates).
2. `migrateCollabState` → new-format state bytes.
3. In **one SQLite transaction** on `data.db`: insert the new state as the sole `doc_snapshots`
   row, delete all `doc_updates`, delete older snapshots, upsert `doc_format.version`.

Consequences, stated plainly:

- **In-file granular history is compacted.** Already the norm (`SNAPSHOT_INTERVAL`,
  `MAX_DOC_SNAPSHOTS = 1`); user-visible history is `versions/*.db`, untouched.
- **The squashed doc is a fresh `Y.Doc`** — new client IDs, no tombstones. Any update produced
  against the pre-migration doc can never merge meaningfully. That is a feature (the handshake
  makes it an explicit refusal, not silent garbage) and the reason the handshake must ship
  **before or with** the first real migration.
- **All-or-nothing**: the transaction either lands (stamp bumped, state squashed) or rolls back
  (old state + old stamp intact). There is no half-migrated persistent state.

### Lazy migrate-on-open

`ensureCollabFormat` is a plain helper in `lib/collab/migrations.ts` with **exactly two callers**:
`CollabDocument.init` (after `Drive.openDatabase` resolves, before `DbProvider` hydrates or any
client subscribes) and the dormant-doc sweep. It is deliberately *not* wired into
`Mount.openDatabase`/`buildDocumentDb`: that seam is config-generic (the same factory serves
`comments.db` and chat's `data.db`) and doesn't know the container's `EigenDocType`; and inside a
still-unresolved factory the pre-migration snapshot would capture lagged bytes — `takeSnapshot`/
`stageDataDbSnapshot` deliberately `peek()` the `documentDbs` cache and never await the getter (the
storage-audit close-wedge fix), so an unresolved entry falls through to staged-copy/storage bytes
instead of the live working copy. Also: never wrap the helper in `withPathLock` —
`snapshotContainerDataDb` self-locks there and the lock is not reentrant. The sequence:

1. Read `doc_format` (missing ⇒ 1). If equal to `EIGEN_DOC_TYPE_INFO[type].collabFormatVersion`,
   continue as today — one cheap SELECT on the hot path.
2. If stale: take a **pre-migration version snapshot** via the existing
   `mount.snapshotContainerDataDb(containerId, policy)` — the same call `restoreContainer` makes,
   self-locked on the container, no lock held across steps (`restore.ts`'s stated discipline) —
   then probe it with `verifySnapshotDb` ([PROPOSAL_DATA_INTEGRITY.md](PROPOSAL_DATA_INTEGRITY.md)):
   a cheap validity check, so migration never proceeds without a proven-readable rollback net.
3. Run the squash transaction above as a **compare-and-swap**: re-read `doc_format.version` inside
   the write transaction and abort if it is no longer the expected from-version. bun:sqlite
   statements are synchronous, so the CAS is airtight — if two paths race on the same dormant doc,
   exactly one squash commits and the loser is a no-op.
4. Proceed with normal hydration; every subscriber — including the one whose open triggered this —
   only ever sees the new format.

**Concurrency** falls out of existing structure rather than new locks:

- Two clients opening the same dormant doc: `CollabRegistry.get`'s `createAsyncSingleton` coalesces
  them; the second awaits the same `init()` and thus the same migration.
- Migration vs. the version-snapshot timer / manual save: `snapshotContainerDataDb` self-locks on
  `withPathLock(containerId)`; step 2 serializes there like every other caller. The squash
  transaction itself is a plain SQLite transaction on an exclusively-owned open handle.
- Migration vs. restore: `restoreContainer` goes through `getCollabDocument` for Yjs types, so a
  restore of a dormant doc first runs the open-time migration, then the restore surgery.
- Sweep vs. a concurrent collab open: the registry singleton only serializes collab opens, not the
  sweep — the CAS in step 3 is what makes that residual race a harmless no-op for whichever path
  loses. The sweep additionally skips live docs and never touches shared handles (see the sweep
  section).

**Failure handling.** If step 2 or 3 throws, the transaction rolls back — old state, old stamp,
never half-migrated — and the error is logged loudly with the container path. The doc is then
**write-fenced**, not opened for editing: stamped N−1, the handshake below would accept both old
clients (`fmt` = stamp) *and* new clients (`fmt` > stamp) as writers, producing hybrid content that
the retried migration would later run a pure N−1 transform over. So a failed migration refuses the
collab session with a distinct close code — `4503`, "document temporarily unavailable" — while REST
reads (export, preview, content extraction) keep working through the in-memory chain below; editing
resumes when a later open's migration succeeds. (A read-only collab session was considered instead,
but it would hand new bundles N−1 state to render; refusal keeps the N−1-over-WS surface at zero.)
Alerting on repeated failures belongs to the sibling
[PROPOSAL_DATA_INTEGRITY.md](PROPOSAL_DATA_INTEGRITY.md).

**Readers outside `CollabDocument`.** The export/content loaders (`apps/api/src/lib/document/*.ts`,
`extract-text.ts`) and `readYjsStateFromFile` read `data.db` without opening a collab session, so a
dormant doc reaches them in old format. They get one shared helper in `yjs-loader.ts` that reads
the stamp alongside the state and pipes it through `migrateCollabState` **in memory, never
persisting** — read paths stay read-only. That keeps every server-side consumer on current-format
shapes without a second write path.

### Version history: restoring a pre-migration snapshot

A `versions/<ts>.db` archive self-describes (its `doc_format` row, or absence ⇒ 1). The restore
pipeline in `versioning/restore.ts` changes in one place: after `readYjsStateFromFile`, read the
archive's stamp and run `migrateCollabState(type, state, archiveVersion)` before
`applySnapshotState`. The live doc's stamp stays current; connected editors converge onto the
migrated old content through the existing `restoreYjsDoc` broadcast. Old format never re-enters a
live doc, and version history remains fully restorable across format boundaries — permanently,
because the registry keeps every migration ever shipped (that is its point; entries are never
deleted).

The chat branch of restore (byte-overwrite via `replaceContainerDataDb`) is untouched.

### The sync handshake

**Declaring.** The client declares its understood format as a query param on the WS URL:
`?fmt=<EIGEN_DOC_TYPE_INFO[type].collabFormatVersion>`. A query param, not a new protocol message:
y-websocket's message handlers are fixed (sync/awareness), the URL is the one extension point stock
clients already flow through, and the server needs the answer *before* accepting the first sync
message anyway. Absent param ⇒ client format 1 (today's bundles). Delivery detail: all four call
sites construct `new WebsocketProvider(wsUrl, '', doc, opts)`, and y-websocket assembles its final
URL as `serverUrl + '/' + room + '?' + params` — so `fmt` must ride in the provider's `params`
option (which y-websocket serializes into the query string), **not** be baked into the string
`getCollabWebSocketUrl` returns, where the provider's URL assembly would mangle it.

**Enforcing.** In the `.ws('/ws/collab/...')` `open` handler in `routes/collab.ts`, after the ACL
check and `getCollabDocument` (so lazy migration has already run): if the doc's stamp is still
below the server's current format — the failed-migration fence — close `4503` for *every* client;
otherwise, if the declared format is **lower** than the doc's stamped format, close with an
application close code before `subscribe`:

```
ws.close(4426, 'Document format upgraded — reload to continue');   // 4426 ≈ HTTP 426
```

The refusal must not leak the doc it just caused to open: mirroring `restoreYjsContainer`'s
discipline in `versioning/restore.ts`, check `Drive.hasCollabDocument` *before* the
`getCollabDocument` call, and after refusing — if the doc wasn't previously open and
`connectionCount === 0` — close it via `closeCollabDocument`. Otherwise a post-deploy wave of stale
tabs would hold every doc it touched open (and migrated) with zero subscribers, and
close-on-last-unsubscribe would never fire.

A client *newer* than the doc is accepted: the doc was just migrated to the server's current format
at open, so `fmt` > stamp only occurs during brief FE/API deploy skew, and a newer bundle reads
current-format state fine. The only rejected direction is old-client → new-doc — exactly the
write-corruption vector. Note what this buys: outside the failed-migration fence above, **a client
never receives N−1 state over the WS at all**. "N−1 tolerance" in this design means *server-side
read tolerance* (the in-memory chain in the reader helper, plus the permanent `versions/*` restore
path) — never FE rendering of old shapes.

**Client UX.** `WebsocketProvider` retries forever by default; a small shared helper in
`../../packages/lib/src/core/collab` listens for `connection-close` with codes 4426 and 4503, calls
`provider.destroy()` to stop the retry loop, and surfaces a blocking state in the four editor
shells (docs/stickies/slides/sheets — the same four call sites that build providers today): "This
document was upgraded. Reload to continue." for 4426, "temporarily unavailable" for 4503. Additionally `CollabDocumentInfo`
(`../../packages/lib/src/types/collab.ts`, served by `/collab/:ownerId/:mountId/:pathId/info`) gains
`formatVersion` so routes can gate *before* mounting an editor — advisory UX; the close code
remains the enforcement.

**The nasty case — a stale offline client with pending updates.** Eigen has no client-side Yjs
persistence: unsent edits exist only in a live tab's memory. A tab running the old bundle that lost
its connection (laptop lid, deploy restart) reconnects through `open` → declares old `fmt` →
refused at 4426 → **its buffered old-format updates are never transmitted**. That is the fence.
The unsent edits in that tab are lost on reload; the window is one tab-generation across a deploy,
and the pre-migration snapshot plus the user's still-rendered tab content are the recovery paths.
Accepted for v1 (see Open questions for the salvage alternative).

**Why not epoch/GUID fencing instead?** y-protocols sync carries no document identity — the server
applies whatever `readSyncMessage` decodes, and `Y.Doc.guid` is never compared on this protocol.
Update payloads are opaque binary; the server cannot classify a single update as old- or new-format
at message time. So identity-style fencing would have to be bolted on as a protocol fork for stock
y-websocket clients to break against. Connect-time refusal keyed on the declared format gives the
same guarantee — an accepted connection is same-format for its whole life, because a doc's format
cannot change while it is open (migration runs only at open; the registry holds the doc until the
last unsubscribe; restore re-migrates before applying) — without forking the wire format.

### The dormant-doc sweep

Lazy-on-open converges actively-used documents fast, but declaring format N−1 archive-only needs
*every* container converged, including ones nobody has opened in a year.

**Finding stale containers cheaply.** Opening every `data.db` just to read its stamp means
downloading whole objects on S3 mounts — unacceptable as a scan. So the mount's `metadata.db` gets
a **cache column** (additive migration, the `contentDirty` v6 precedent): `paths.collabFormat`,
`NULL` = unknown. Written wherever the truth changes: container creation, migration completion, and
left `NULL` by copies/imports (safe — `NULL` means "check me", and the `data.db` stamp inside the
copied bytes is canonical). No backfill needed: pre-existing rows are `NULL`, which is the correct
initial answer.

**Draining.** A scheduled job (`scheduleInterval('collab-format-sweep', ...)` registered in
`scheduler/jobs.ts`, daily like `guest-cleanup`) iterates owners (users from the auth DB, then
teams), opens each home's mounts, and per mount queries
`type IN (collab types) AND (collabFormat IS NULL OR collabFormat < current)`. Containers with a
live `CollabDocument` are skipped outright (`Drive.hasCollabDocument` — their open already migrated
them and stamped the cache). For each remaining hit the sweep opens `data.db` via
`Mount.openDatabase` (SQLite migrations run there), calls the same `ensureCollabFormat` helper
`CollabDocument.init` uses, records the resulting stamp into `paths.collabFormat`, and closes the
handle **only if it opened it cold** — a handle found already cached belongs to another consumer
and is left to the mount lifecycle (`readEigendocContent`'s stated rule); yanking it would pull the
db out from under a live session. The CAS makes the residual sweep-vs-open race on a dormant doc
safe either way. Pacing copies `ContentReindexQueue`'s discipline: a fixed batch
budget per mount per pass (its `REINDEX_BATCH`-style constant; start ~25, since each S3 container
is a full download+upload), strictly serial within a mount, and stop-on-teardown. **Resumability is
free**: the column is the durable cursor, exactly as the `contentDirty` bit is for reindexing — a
crashed sweep just re-queries next pass. Homes the sweep opens are reclaimed by the existing
idle-home eviction.

**Declaring victory.** "All containers ≥ N" is a per-mount count of the same query. An admin-gated
endpoint (in `routes/settings.ts`, `requireAdmin` like its siblings) sums it across owners and
reports `{ total, belowCurrent, unknown }`. Only when that reads zero across the fleet may new
code treat format N−1 as **archive-only** — no live container carries it, lazy migrations stop
firing, and the failed-migration fence window is closed fleet-wide. `versions/*.db` archives are
exempt by design — they never migrate in place; the restore path and the registry serve them
forever.

### Rollback story

**What gets snapshotted:** the entire pre-migration `data.db` (state, updates, old stamp) as
`versions/<iso-ts>.db` via the standard mechanic, immediately before the squash transaction, under
the container lock. It appears in the normal version-history UI like any other snapshot.

**One document:** restore that snapshot through the existing UI/route
(`/drive/:o/:m/file/:p/versions/:name/restore`). Note the sharp edge honestly: restore re-runs the
*current* migration chain on the archived state — so if migration vN itself mangles content,
restoring and re-migrating through the same buggy vN reproduces the mangling. Rollback of a **buggy
migration** is therefore **roll-forward**: fix or supersede it (ship vN+1 correcting the damage —
migrations compose), then restore affected docs so the corrected chain re-runs. The snapshot
guarantees the pristine old-format bytes exist for as long as retention holds them.

**A fleet:** no bulk tool in v1. The realistic sequence is: halt the sweep (it's a scheduler job),
fix the migration, redeploy, let lazy-open + sweep re-converge, restore individually where content
was damaged (the blast radius is bounded by how far the sweep got, which the admin endpoint
reports). A true binary downgrade also works mechanically — old server code opens stamped files
fine (it ignores `doc_format`; `runMigrations` only applies versions above the stored one) — but
already-migrated docs would render wrong under old app code, so it is the last resort, paired with
per-doc restores.

## Frozen-format impact

Everything here is **additive**, done through the sanctioned migration mechanisms:

- `COLLAB_DB_CONFIG` v2 adds the `doc_format` table (`ManagedDatabase` migration — the existing
  pattern; chat's and mail's DBs already evolve this way). No existing table changes.
- `metadata.db` (at v7 today) gains `paths.collabFormat` via its next `DatabaseConfig` version
  (the v6 `contentDirty` precedent). Note [PROPOSAL_DATA_INTEGRITY.md](PROPOSAL_DATA_INTEGRITY.md)'s
  `paths.integrityCheckedAt` contends for the same slot — whichever lands second takes the next
  number.
- Yjs roots, drive MIME values, container layout: untouched by the machinery itself. The first
  *actual* format bump is a deliberate frozen-format change per type and gets its own review — this
  proposal is what makes that reviewable at all.
- The WS URL gains a query param; old servers ignore it, old clients omit it. `CollabDocumentInfo`
  gains an optional field. Both wire-compatible in each direction.

## Open questions

**OQ1 — Should pre-migration snapshots be exempt from retention pruning?** Retention keeps ≤47
timestamped snapshots and the pre-migration one competes in its hour bucket; months later it may be
pruned. Grounded alternative: `selectSnapshotsToPrune` and `listVersions` both ignore names that
don't match `SNAPSHOT_NAME_FORMAT`, so a distinguished name (e.g. `pre-format-2.db`) would be
retention-immune — but also invisible in the version-history UI and un-restorable without teaching
`listVersions` about it. *Recommendation:* keep the standard timestamp name in v1 (visible,
restorable, prunable on the same horizon as all history — weeks-to-months, ample time to notice a
bad migration); revisit distinguished names only if a real migration proves riskier than that
horizon.

**OQ2 — Salvage unsent edits in a stale tab before forcing reload?** The 4426 handler could
serialize the tab's un-synced state for manual recovery before reloading. *Recommendation:* no for
v1 — the window is one tab-generation across a deploy, the machinery (old-format export of a
memory-only doc) is disproportionate, and the pre-migration snapshot is the designed net. Revisit
if `PROPOSAL_E2E_COLLAB_TESTING.md`'s stale-client scenarios show the window bites in practice.

**OQ3 — Per-type or global format number?** A single global version would force empty migrations
onto three types whenever one changes, and stamp bumps on docs whose shape didn't move.
*Recommendation:* per-type, keyed by `DriveCollabType` — it mirrors `yjsRoots`, and the handshake
already knows the doc's type.

**OQ4 — Migrate on *every* server-side read, or tolerate N−1 in readers?** Persisting from read
paths (export, content extract) would converge faster but adds a write path outside the container
lock discipline. *Recommendation:* readers migrate in memory only (the shared `yjs-loader.ts`
helper); persistence happens in exactly two places — collab open and the sweep — both under the
established locking.

**OQ5 — Where does the first real migration's test corpus come from?** Fixtures hand-built with
old app code rot. *Recommendation:* when shipping migration vN, commit a small binary fixture
`data.db` per affected type captured from a real pre-migration container (the sheets xlsx-fidelity
program's real-workbook discipline). Validity and measures (readable state, root presence, entry
counts) come from `verifySnapshotDb` in
[PROPOSAL_DATA_INTEGRITY.md](PROPOSAL_DATA_INTEGRITY.md); the per-type semantic-**equality**
comparator (old state ≈ migrated state, field by field) does not exist there — it is new work owned
by *this* proposal, built alongside the first migration. CRDT bytes are not comparable; states are.

## Phasing

Each phase ships independently; nothing user-visible changes until a real migration exists.

1. **Stamp plumbing (small).** `COLLAB_DB_CONFIG` v2 + write-current-on-create + read helper;
   `collabFormatVersion` in `EIGEN_DOC_TYPE_INFO`; registry skeleton with empty arrays + the
   startup/test drift assertion; `formatVersion` in `CollabDocumentInfo`. Pure bookkeeping.
2. **Handshake.** `?fmt=` via the `WebsocketProvider` `params` option at the four editor call
   sites, the 4426 gate in `routes/collab.ts`, the shared client guard + reload UX in the four
   editors. Ships while all formats are still 1, so it
   fences nothing yet — which is exactly when to soak it.
3. **Migration runner.** `migrateCollabState` + `forceTypeRoot` reuse; `ensureCollabFormat`
   called from `CollabDocument.init` with `verifySnapshotDb`-probed pre-migration snapshot + CAS
   squash transaction + the 4503 write-fence on failure; restore-path re-migration; in-memory
   migration in the shared reader helper. Unit-tested against synthetic registry entries on
   fixture docs (the real registry stays empty).
4. **Sweep.** `paths.collabFormat` cache column, the scheduler job with per-mount budget, the
   admin fleet-status endpoint.
5. **First real migration** (own change, own review): registry entry + fixtures + the semantic
   comparator (OQ5) + fleet run to completion; only after the fleet reports converged is that
   format treated as archive-only.

## Testing

Integration tests extend `../../apps/api/src/test/collab/collab.test.ts` patterns (`getTestContext`, real WS
connections against the test server); migration-runner units live beside the registry.

- **Runner:** synthetic v1→v2 entry per root kind (map/array/text/xmlfragment) on fixture docs —
  migrated state matches expected semantic shape; roots dropped by a migration are absent; stamp
  bumped and updates squashed atomically; a throwing migration rolls back file-identically.
- **Open path:** dormant stale doc → first WS open sees migrated state; two concurrent opens run
  the migration once (singleton coalescing); a version snapshot exists dated before the squash. A
  doc whose migration failed → collab session refused with 4503, REST reads still serve
  migrated-in-memory content, next open retries.
- **Handshake:** stale `fmt` (and absent `fmt` against a v2 doc) → close code 4426 before any sync
  message is processed; equal/newer `fmt` → normal sync-step-1. Stale client holding pending
  updates reconnects → refused, and the doc's state provably contains none of its edits. A refused
  connection on a previously-closed doc leaves no zero-subscriber `CollabDocument` behind.
- **Restore:** restore a pre-migration `versions/*.db` onto a migrated live doc → content matches
  the migrated old state, stamp stays current, a second connected client converges.
- **Sweep:** mount with mixed stale/current/NULL rows → converges within budgeted passes, cache
  column accurate, fleet endpoint counts correct; sweep interrupted mid-mount resumes without
  rework; sweep racing a concurrent collab open on the same dormant doc → exactly one CAS commit,
  no double-migration, the live session unaffected.
- **E2E:** the multi-client stale-tab scenario (old bundle, live edits, deploy, reconnect) is
  delegated to `PROPOSAL_E2E_COLLAB_TESTING.md` — its scenario matrix gains the row. Snapshot
  validity probes come from `PROPOSAL_DATA_INTEGRITY.md`'s `verifySnapshotDb`; the semantic-equality
  comparator is this proposal's own work (OQ5).
