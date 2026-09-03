# Document Content Layer

> **TLDR:** Thin per-type module under `apps/api/src/lib/document/` — a media-free reader over a
> materialized `Y.Doc` and (where it exists) one writer per Eigen container type. The `*FromDoc`
> readers are what the document-transform Worker calls for export, preview, import round-trips and
> search extraction; nothing reads a persisted collab document on the main thread anymore — callers
> capture compressed blobs (`captureCollabSource`) and the Worker materializes them. Writers do direct
> Yjs mutations. Stickies and chat have light Mount-side readers here too (`stickies.ts`, `chat.ts`),
> search-only and main-thread: stickies materializes its small Y.Doc directly, chat reads relational
> SQLite rows. **Sheet and Doc writers are unsafe against live editors:** they snapshot-replace + clear
> pending ops, so any unflushed client edit is lost.

## Module surface

```
apps/api/src/lib/document/
  doc.ts      # readEigendocFromDoc(ydoc) → JSONContent
              #   + writeEigendocToYjs(doc, json, schema)
              #   + writeEigendocUpdateToYjs(doc, update) — commits a prepared Yjs update
  sheets.ts   # readSheetsFromDoc(ydoc) → { sheets, recalcError }
              #   + writeSheetsToYjs(doc, sheets)
              #   + writeSheetsSnapshotToYjs(doc, snapshotJson) — commits already-serialized JSON
  stickies.ts # readStickiesContent(mount, path) → { tasks, columns } — main thread, search only
  chat.ts     # readChatContent(mount, path, capBytes) → string — main thread, search only
  media.ts    # listDocumentMedia / buildPreviewUrlMap (main thread) + toDataUriMap (Worker side)
  collab-types.ts  # COLLAB_DOCUMENT_TYPES — drive MIME → transform documentType (one map)

# Both canvas types read through packages/lib instead: readVectorFromDoc(ydoc) → VectorScene
# (packages/lib/src/vector/read-vector.ts, imported over the React-free ./vector subpath), because
# the engine's reader is shared FE/BE and is the scene's trust boundary. See CANVAS.md.
```

| Type | Y.Doc reader | Reader returns | Writer |
|---|---|---|---|
| `.eigendoc` | `readEigendocFromDoc` | `JSONContent` | `writeEigendocToYjs` / `writeEigendocUpdateToYjs` |
| `.eigensheets` | `readSheetsFromDoc` | `{ sheets, recalcError }` (replayed — see below) | `writeSheetsToYjs` / `writeSheetsSnapshotToYjs` |
| `.eigenslides` / `.eigenvector` | `readVectorFromDoc` (`packages/lib/src/vector/read-vector.ts`) | `VectorScene` — `{ elements, frames, meta }` | – |
| `.eigenstickies` | `readStickiesContent` (Mount-side, main thread) | `{ tasks, columns }` — card + column text | – |
| `.eigenchat` | `readChatContent` (Mount-side, main thread) | `string` — newest messages, capped at `capBytes` | – |

The `*FromDoc` readers take an already-materialized `Y.Doc` and touch no Mount. There is no Mount-side
read path anymore (the `read*Content` readers were deleted in Phase 4): whoever needs a persisted
document goes `mount.getChildByName(path.id, 'data.db')` → `mount.openDatabase(COLLAB_DB_CONFIG, …)` →
`readYjsStatePayload()` (`captureCollabSource`, a short blob copy) and hands the payload to the
document-transform Worker, which runs `materializeYjsState` → the `*FromDoc` reader. Media, where a
result needs it, is prepared on the main thread via `listDocumentMedia`. The managed DB is **not**
closed after capture — a live collab session may share the instance; `Mount.closeAllDatabases` handles
cleanup on shutdown. Tests use the same pipeline through the `readPersistedDoc` fixture.

Chat is the exception: its `data.db` is relational, not a Yjs log. `readChatContent` keyset-walks
the newest messages a page at a time (the same `createdAt` index `getMessages` uses) and stops as
soon as the accumulated text reaches `capBytes` — no Yjs, no full scan.

ACL is enforced upstream by callers (`getSharedDrive(ownerId, user)` in routes); the module
itself takes a resolved `Mount`/`DrivePath` pair and assumes the caller already checked.

## Sheets — snapshot + ops replay

Fortune-sheet stores its state as `Y.Map('state').snapshot` (the encoded last-flushed
workbook — SHEETS.md § Snapshot format v2; legacy docs hold plain `Sheet[]` JSON) plus
`Y.Array('ops')` (op batches since the last flush). Live editors push ops onto
the array and observe it for remote ops; on `beforeunload` they flush a fresh snapshot via
`encodeSheetsSnapshot` and clear the ops array (see
`apps/sheets/src/components/sheets/hooks/use-sheet.ts`).

`readSheetsFromDoc` decodes the snapshot (`decodeSheetsSnapshot` — v1 arrays pass
through untouched), replays pending op batches via `replaySheetsOps()`, and materializes each
sheet's dense `data` matrix for the renderers (re-exported from `@workspace/sheet/engine`) — single source of
truth, also used by the FE on initial load. The replay path uses `opToPatchOnSheets()`
(`packages/lib/src/sheets/yjs-ops.ts`), kept in `@workspace/lib` so server-side replay doesn't
pull in the sheet package's DOM-coupled state barrel.

A doc with pending ops but no snapshot (browser killed before the first flush) replays from
`createDefaultSheets()` (engine) — the same base the editor seeded its grid from — on both FE
and BE. An op batch that cannot apply is rolled back and skipped with a warning rather than
failing the whole read; the doc stays loadable with everything else applied.

After replay, `readSheetsFromDoc` can run a **gated server-side recalc**: `sheetsNeedRecalc()`
(formula cells but no `calcChain`) decides whether to hand the sheets to `recalcSheets()`. Only the
export read opts in — preview and search extract pass `{ recalc: false }` and serve replayed values
as-is, because a legacy never-computed workbook costs an unbounded recalc (~39s measured), past
their 30s Worker deadline (SHEETS.md § Server-side recalc). This is why an xlsx import that was
never opened in an editor still exports with values (the import persists computed values with
`computed: true`, which makes the decoder seed a `calcChain`, so post-import docs never fire the
gate anywhere). A live-edited doc already persists
fresh `v`/`m` through its ops, so it pays nothing. A recalc that throws falls back to the replayed
values — an export must never 500 because recalc hiccuped.

## Writers are unsafe against live editors

`writeSheetsSnapshotToYjs` — which `writeSheetsToYjs(doc, sheets, { computed })` composes
after `encodeSheetsSnapshot`, and which the xlsx import path calls directly with the Worker's
already-encoded snapshot —
does:

```typescript
doc.transact(() => {
    doc.getMap('state').set('snapshot', snapshotJson); // wholesale replace
    doc.getArray('ops').delete(0, ops.length);         // wipes pending edits
});
```

`writeEigendocUpdateToYjs` takes the same shape: clears the existing `Y.XmlFragment('default')`,
then `Y.applyUpdate` with a prepared update — the docx import path calls it directly with the
Worker's update, and `writeEigendocToYjs(doc, json, schema)` composes it after encoding a fresh
`prosemirrorJSONToYDoc` temp doc.

If a live client has unflushed ops in `Y.Array('ops')` (sheets) or local typing not yet
synced (doc) when one of these writers fires, the client's work is lost — CRDT can't merge a
JSON-stringified snapshot or a fragment delete + apply-state. The two callers
(`importIntoDocument` and `convertToDocument` in `lib/import/import-document.ts`) assume the
target is not currently being edited:

- `convertToDocument` — creates a fresh path then writes. **Safe.** No editors yet.
- `importIntoDocument` — writes into an existing eigendoc / eigensheets path. **Unsafe** if the
  path is open in any browser tab.

The fix shape (deferred): replace `writeSheetsToYjs` with op-push primitives that go through
`Y.Array('ops').push([ops])` so live observers replay them like a remote user's edit. Build
high-level ops (`buildSetCellRangeOp`, etc.) on top. For docs, replace fragment-delete +
apply-state with y-prosemirror's diff/transform path. Until then, the import UX should warn
when the target file has active editors — and ideally the route should refuse the write while a
collab session holds the document open. No such liveness check exists on `Drive` today.

## Callers

| Surface | Files |
|---|---|
| Export (HTML/PDF/DOCX/XLSX) | Worker: `lib/export/{doc,sheets,canvas,vector}/transform.ts` (calls the `*FromDoc` readers); main thread: `lib/export/export-document.ts` |
| Preview generation | Worker: `lib/preview/eigen{doc,sheets,slides,vector}-render.ts` (calls the `*FromDoc` readers); main thread: `lib/preview/preview-document.ts` |
| Search extraction | Worker: `lib/search/extract-render.ts` (the `extract-text` op, calls the `*FromDoc` readers); main thread: `lib/search/extract-text.ts` — mime dispatch plus the stickies/chat/plain-file arms (`readStickiesContent` / `readChatContent` from this layer) |
| Import dispatcher | `lib/import/import-document.ts` (calls writers) |
| Pure converters | `lib/import/{doc/{from-docx,transform}.ts, sheets/{from-xlsx,transform}.ts}` |

`extract-text.ts` is the layer's broadest consumer: it dispatches on mime and calls every reader,
so the body text the drive search index stores can't drift from what export and preview render.
It caps each document at ~100 KB — the reason `readChatContent` takes an explicit byte cap.

The pure converters in `lib/import/{doc,sheets}/` are buffer ⇆ native-content (`Buffer →
Sheet[]`, `Buffer → JSONContent + images`); the dispatcher wires them to the writers. Both run
off-thread: `sheets/transform.ts` composes parse + recalc + snapshot serialization and
`doc/transform.ts` composes parse + ProseMirror-to-Yjs conversion inside the document-transform
Worker, and the dispatcher only commits the returned snapshot JSON / Yjs update and writes the
extracted docx media (see [EXPORT.md § Sheets Import](EXPORT.md#sheets-import)).
Export has a matching dispatcher: `lib/export/export-document.ts` owns the whole main-thread side —
`(mime, format)` dispatch, the format→envelope table and media prep — while the per-type
`export/<type>/transform.ts` modules call the readers inside the Worker.

## Pending work

- **Op-push primitive for sheets writes** (replaces snapshot-replace) — unblocks safe XLSX
  import into open documents and any future scripting / batch tools.
- **Live-safe doc writer** — same idea via y-prosemirror.
- **No canvas writer** — slides / vector import and round-trip are not yet supported.

## See also

- [SHEETS.md](SHEETS.md) — sheet snapshot + ops invariants, headless formula engine
- [EXPORT.md](EXPORT.md) — eigen → docx/xlsx/pdf pipeline that consumes the readers
- [SEARCH.md](SEARCH.md) — the drive content index built on `extract-text.ts`
- [STORAGE.md](STORAGE.md) — Mount, `data.db` layout, `loadYjsState()`
- `packages/lib/src/sheets/yjs-ops.ts` — `opToPatchOnSheets` helper
- `apps/api/src/test/document/document-sheets.test.ts` — round-trip tests for the sheets module
