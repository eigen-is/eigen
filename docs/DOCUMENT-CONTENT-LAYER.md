# Document Content Layer

> **TLDR:** Thin per-type module under `apps/api/src/lib/document/` — one reader and (where it
> exists) one writer per Eigen container type. Wraps `loadYjsState()` for reads and direct Yjs
> mutations for writes. Used by export, preview, and import. Stickies and chat have no module —
> they read from their own SQLite tables. **Sheet and Doc writers are unsafe against live
> editors:** they snapshot-replace + clear pending ops, so any unflushed client edit is lost.

## Module surface

```
apps/api/src/lib/document/
  doc.ts      # readEigendocContent(mount, path)        + writeEigendocToYjs(doc, json, schema)
  sheets.ts   # readSheetsContent(mount, path) → Sheet[] + writeSheetsToYjs(doc, sheets)
              #   + writeSheetsSnapshotToYjs(doc, snapshotJson) — commits already-serialized JSON
  slides.ts   # readSlidesContent(mount, path)          [no writer]
```

| Type | Reader | Writer | Returns |
|---|---|---|---|
| `.eigendoc` | `readEigendocContent` | `writeEigendocToYjs` | `{ json: JSONContent, mediaByName: Map<string, DrivePath> }` |
| `.eigensheets` | `readSheetsContent` | `writeSheetsToYjs` | `Sheet[]` (replayed — see below) |
| `.eigenslides` | `readSlidesContent` | – | `{ deck: DeckData, mediaByName }` |
| `.eigenstickies` | – | – | reads its own `data.db` via app-specific code |
| `.eigenchat` | – | – | reads SQLite rows via `ChatRoom` |

Every reader follows the same recipe: `mount.getChildByName(path.id, 'data.db')` →
`mount.openDatabase(COLLAB_DB_CONFIG, …)` → `loadYjsState()` (`lib/collab/yjs-loader.ts`) →
extract the relevant Y types. The managed DB is **not** closed on return — a live collab session
may share the instance; `Mount.closeAllDatabases` handles cleanup on shutdown.

ACL is enforced upstream by callers (`getSharedDrive(ownerId, user)` in routes); the module
itself takes a resolved `Mount`/`DrivePath` pair and assumes the caller already checked.

## Sheets — snapshot + ops replay

Fortune-sheet stores its state as `Y.Map('state').snapshot` (JSON-serialized last-flushed
`Sheet[]`) plus `Y.Array('ops')` (op batches since the last flush). Live editors push ops onto
the array and observe it for remote ops; on `beforeunload` they flush a fresh snapshot and clear
the ops array (see `apps/sheets/src/components/sheets/hooks/use-sheet.ts`).

`readSheetsContent` parses the snapshot then replays pending op batches via
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

`writeEigendocToYjs` (doc.ts:32) takes the same shape: clears the existing
`Y.XmlFragment('default')`, then `Y.applyUpdate` with the encoded state of a fresh
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
| Export (HTML/PDF/DOCX/XLSX) | `lib/export/{doc,sheets,slides}/{html,pdf,xlsx,docx}.ts` |
| Preview generation | `lib/preview/{eigendoc,eigensheets,eigenslides}-preview.ts` |
| Import dispatcher | `lib/import/import-document.ts` (calls writers) |
| Pure converters | `lib/import/{doc/from-docx.ts, sheets/{from-xlsx,transform}.ts}` |

The pure converters in `lib/import/{doc,sheets}/` are buffer ⇆ native-content (`Buffer →
Sheet[]`, `Buffer → JSONContent + images + schema`); the dispatcher wires them to the writers.
For xlsx the converter runs off-thread: `sheets/transform.ts` composes parse + recalc + snapshot
serialization inside the document-transform Worker, and the dispatcher only commits the returned
JSON (see [EXPORT.md § Sheets Import](EXPORT.md#sheets-import)).
Export has no equivalent dispatcher today — each format calls the reader directly.

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
