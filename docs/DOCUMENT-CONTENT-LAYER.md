# Document Content Layer

> **TLDR:** Thin per-type module under `apps/api/src/lib/document/` — a media-free reader over a
> materialized `Y.Doc`, a Mount-side reader that adds the media map, and (where it exists) one writer
> per Eigen container type. The `*FromDoc` readers are what the document-transform Worker calls; the
> Mount-side readers wrap `loadYjsState()`; writers do direct Yjs mutations. Used by export, preview,
> import, and search extraction. Stickies and chat have no module —
> they read from their own SQLite tables. **Sheet and Doc writers are unsafe against live
> editors:** they snapshot-replace + clear pending ops, so any unflushed client edit is lost.

## Module surface

```
apps/api/src/lib/document/
  doc.ts      # readEigendocFromDoc(ydoc) → JSONContent
              #   + readEigendocContent(mount, path)  + writeEigendocToYjs(doc, json, schema)
              #   + writeEigendocUpdateToYjs(doc, update) — commits a prepared Yjs update
  sheets.ts   # readSheetsFromDoc(ydoc) → { sheets, recalcError }
              #   + readSheetsContent(mount, path) → Sheet[] + writeSheetsToYjs(doc, sheets)
              #   + writeSheetsSnapshotToYjs(doc, snapshotJson) — commits already-serialized JSON
  slides.ts   # readDeckFromDoc(ydoc) → DeckData
              #   + readSlidesContent(mount, path)    [no writer]
  media.ts    # listDocumentMedia / buildPreviewUrlMap (main thread) + toDataUriMap (Worker side)
```

| Type | Y.Doc reader | Mount reader | Writer | Mount reader returns |
|---|---|---|---|---|
| `.eigendoc` | `readEigendocFromDoc` | `readEigendocContent` | `writeEigendocToYjs` / `writeEigendocUpdateToYjs` | `{ json: JSONContent, mediaByName: Map<string, DrivePath> }` |
| `.eigensheets` | `readSheetsFromDoc` | `readSheetsContent` | `writeSheetsToYjs` / `writeSheetsSnapshotToYjs` | `Sheet[]` (replayed — see below) |
| `.eigenslides` | `readDeckFromDoc` | `readSlidesContent` | – | `{ deck: DeckData, mediaByName }` |
| `.eigenstickies` | – | – | – | reads its own `data.db` via app-specific code |
| `.eigenchat` | – | – | – | reads SQLite rows via `ChatRoom` |

The `*FromDoc` readers take an already-materialized `Y.Doc` and touch no Mount, so they run identically
on the main thread and inside the document-transform Worker (which materializes the captured blobs with
`materializeYjsState`). Every Mount reader follows the same recipe on top:
`mount.getChildByName(path.id, 'data.db')` → `mount.openDatabase(COLLAB_DB_CONFIG, …)` → `loadYjsState()`
(`lib/collab/yjs-loader.ts`) → the `*FromDoc` reader (+ `listDocumentMedia` where a media map is part of
the result). The managed DB is **not** closed on return — a live collab session may share the instance;
`Mount.closeAllDatabases` handles cleanup on shutdown.

ACL is enforced upstream by callers (`getSharedDrive(ownerId, user)` in routes); the module
itself takes a resolved `Mount`/`DrivePath` pair and assumes the caller already checked.

## Sheets — snapshot + ops replay

Fortune-sheet stores its state as `Y.Map('state').snapshot` (JSON-serialized last-flushed
`Sheet[]`) plus `Y.Array('ops')` (op batches since the last flush). Live editors push ops onto
the array and observe it for remote ops; on `beforeunload` they flush a fresh snapshot and clear
the ops array (see `apps/sheets/src/components/sheets/hooks/use-sheet.ts`).

`readSheetsFromDoc` parses the snapshot then replays pending op batches via
`replaySheetsOps()` (re-exported from `@workspace/sheet/engine`) — single source of
truth, also used by the FE on initial load. The replay path uses `opToPatchOnSheets()`
(`packages/lib/src/sheets/yjs-ops.ts`), kept in `@workspace/lib` so server-side replay doesn't
pull in the sheet package's DOM-coupled state barrel.

A doc with pending ops but no snapshot (browser killed before the first flush) replays from
`createDefaultSheets()` (engine) — the same base the editor seeded its grid from — on both FE
and BE. An op batch that cannot apply is rolled back and skipped with a warning rather than
failing the whole read; the doc stays loadable with everything else applied.

## Writers are unsafe against live editors

`writeSheetsSnapshotToYjs` — which `writeSheetsToYjs(doc, sheets)` composes after
`JSON.stringify`, and which the xlsx import path calls directly with the Worker's snapshot JSON —
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
when the target file has active editors — and ideally the route should refuse the write via
`Drive.isCollabOpen()`.

## Callers

| Surface | Files |
|---|---|
| Export (HTML/PDF/DOCX/XLSX) | Worker: `lib/export/{doc,sheets,slides}/transform.ts` (calls the `*FromDoc` readers); main thread: `lib/export/export-document.ts` |
| Preview generation | Worker: `lib/preview/eigen{doc,sheets,slides}-render.ts` (calls the `*FromDoc` readers); main thread: `lib/preview/eigen{doc,sheets,slides}-preview.ts` |
| Search extraction | `lib/search/extract-text.ts` — the only remaining caller of the Mount-side `read*Content` readers |
| Import dispatcher | `lib/import/import-document.ts` (calls writers) |
| Pure converters | `lib/import/{doc/{from-docx,transform}.ts, sheets/{from-xlsx,transform}.ts}` |

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
- **Stickies + chat readers** — useful when search indexing lands; both currently require app-
  specific code rather than going through this layer.
- **No `writeSlidesToYjs`** — slides import / round-trip not yet supported.

## See also

- [SHEETS.md](SHEETS.md) — sheet snapshot + ops invariants, headless formula engine
- [EXPORT.md](EXPORT.md) — eigen → docx/xlsx/pdf pipeline that consumes the readers
- [STORAGE.md](STORAGE.md) — Mount, `data.db` layout, `loadYjsState()`
- `packages/lib/src/sheets/yjs-ops.ts` — `opToPatchOnSheets` helper
- `apps/api/src/test/document-sheets.test.ts` — round-trip tests for the sheets module
