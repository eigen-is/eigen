# Document Content Layer

> **TLDR**: One reader per Eigen container type under `apps/api/src/lib/document/`, plus writers
> for doc and sheets. Used by export, preview, import, and the drive content-search indexer.
> **Sheet and Doc writers are unsafe against live editors** — they snapshot-replace and clear
> pending ops, so any unflushed client edit is lost.

## Module surface

```
apps/api/src/lib/document/
  doc.ts       # readEigendocContent(mount, path)        + writeEigendocToYjs(doc, json, schema)
  sheets.ts    # readSheetsContent(mount, path) → Sheet[] + writeSheetsToYjs(doc, sheets)
  slides.ts    # readSlidesContent(mount, path)          [no writer]
  stickies.ts  # readStickiesContent(mount, path)        [no writer]
  chat.ts      # readChatContent(mount, path, capBytes)  [no writer]
```

| Type | Reader | Writer | Returns |
|---|---|---|---|
| `.eigendoc` | `readEigendocContent` | `writeEigendocToYjs` | `{ json: JSONContent, mediaByName: Map<string, DrivePath> }` |
| `.eigensheets` | `readSheetsContent` | `writeSheetsToYjs` | `Sheet[]` (replayed + recalced — see below) |
| `.eigenslides` | `readSlidesContent` | – | `{ deck: DeckData, mediaByName }` |
| `.eigenstickies` | `readStickiesContent` | – | `{ tasks, columns }` — card titles/descriptions + column titles |
| `.eigenchat` | `readChatContent` | – | `string` — newest messages, capped at `capBytes` |

Every Yjs-backed reader follows the same recipe: `mount.getChildByName(path.id, 'data.db')` →
`mount.openDatabase(COLLAB_DB_CONFIG, …)` → `loadYjsState()` (`lib/collab/yjs-loader.ts`) →
extract the relevant Y types. The managed DB is **not** closed on return — a live collab session
may share the instance; `Mount.closeAllDatabases` handles cleanup on shutdown.

Chat is the exception: its `data.db` is relational, not a Yjs log. `readChatContent` keyset-walks
the newest messages a page at a time (the same `createdAt` index `getMessages` uses) and stops as
soon as the accumulated text reaches `capBytes` — no Yjs, no full scan.

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

After replay, `readSheetsContent` runs a **gated server-side recalc**: `sheetsNeedRecalc()`
(formula cells but no `calcChain`) decides whether to hand the sheets to `recalcSheets()`. This is
why an xlsx import that was never opened in an editor still exports and previews with values. A
live-edited doc already persists fresh `v`/`m` through its ops, so it pays nothing. A recalc that
throws falls back to the replayed values — an export must never 500 because recalc hiccuped.

## Writers are unsafe against live editors

`writeSheetsToYjs` (`sheets.ts`) does:

```typescript
doc.transact(() => {
    doc.getMap('state').set('snapshot', JSON.stringify(sheets)); // wholesale replace
    doc.getArray('ops').delete(0, ops.length);                   // wipes pending edits
});
```

`writeEigendocToYjs` (`doc.ts`) takes the same shape: clears the existing
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
when the target file has active editors — and ideally the route should refuse the write while a
collab session holds the document open. No such liveness check exists on `Drive` today.

## Callers

| Surface | Files |
|---|---|
| Export (HTML/PDF/DOCX/XLSX) | `lib/export/{doc,sheets,slides}/{html,pdf,xlsx,docx}.ts` |
| Preview generation | `lib/preview/{eigendoc,eigensheets,eigenslides}-preview.ts` |
| Content-search indexer | `lib/search/extract-text.ts` (all five readers) |
| Import dispatcher | `lib/import/import-document.ts` (calls writers) |
| Pure converters | `lib/import/{doc/from-docx.ts, sheets/from-xlsx.ts}` |

`extract-text.ts` is the layer's broadest consumer: it dispatches on mime and calls every reader,
so the body text the drive search index stores can't drift from what export and preview render.
It caps each document at ~100 KB — the reason `readChatContent` takes an explicit byte cap.

The pure converters in `lib/import/{doc,sheets}/` are buffer ⇆ native-content (`Buffer →
Sheet[]`, `Buffer → JSONContent + images + schema`); the dispatcher wires them to the writers.
Export has no equivalent dispatcher today — each format calls the reader directly.

## Pending work

- **Op-push primitive for sheets writes** (replaces snapshot-replace) — unblocks safe XLSX
  import into open documents and any future scripting / batch tools.
- **Live-safe doc writer** — same idea via y-prosemirror.
- **No `writeSlidesToYjs`** — slides import / round-trip not yet supported.

## See also

- [SHEETS.md](SHEETS.md) — sheet snapshot + ops invariants, headless formula engine
- [EXPORT.md](EXPORT.md) — eigen → docx/xlsx/pdf pipeline that consumes the readers
- [SEARCH.md](SEARCH.md) — the drive content index built on `extract-text.ts`
- [STORAGE.md](STORAGE.md) — Mount, `data.db` layout, `loadYjsState()`
- `packages/lib/src/sheets/yjs-ops.ts` — `opToPatchOnSheets` helper
- `apps/api/src/test/document-sheets.test.ts` — round-trip tests for the sheets module
