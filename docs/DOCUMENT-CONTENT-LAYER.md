# Document Content Layer

> **TLDR:** `apps/api/src/lib/document/` holds a reader for every Eigen container type and a writer for docs and sheets. The `*FromDoc` readers take a materialized `Y.Doc` and touch no Mount, so export, preview, import and the search extract all run them inside the document-transform Worker. Stickies and chat keep light main-thread readers that only search uses. **The writers replace, they don't merge**: an import into a document someone is editing discards their pending work, and nothing checks for an open session first.

## A reader takes a Y.Doc, never a Mount

| Type | Reader | Returns | Writer |
|---|---|---|---|
| `.eigendoc` | `readEigendocFromDoc` (`doc.ts`) | ProseMirror `JSONContent` | `writeEigendocUpdateToYjs`, `writeEigendocToYjs` |
| `.eigensheets` | `readSheetsFromDoc` (`sheets.ts`) | `{ sheets, recalcError }` | `writeSheetsSnapshotToYjs` |
| `.eigenslides`, `.eigenvector` | `readVectorFromDoc` (`packages/lib/src/vector/read-vector.ts`) | `VectorScene` | none |
| `.eigenstickies` | `readStickiesContent` (`stickies.ts`, main thread) | card and column text | none |
| `.eigenchat` | `readChatContent` (`chat.ts`, main thread) | the newest messages as text | none |

The Worker has no Mount, so a `*FromDoc` reader works on the `Y.Doc` it is handed. The caller captures the compressed Yjs blobs on the main thread (`captureCollabSource`), and the Worker materializes them and runs the reader ([DOCUMENT-TRANSFORMS.md](DOCUMENT-TRANSFORMS.md)). No transform reads a persisted collab document on the main thread. Tests read through the same pipeline with the `readPersistedDoc` fixture. `COLLAB_DOCUMENT_TYPES` (`collab-types.ts`) maps a drive mime to the Worker's document type, and preview and search both dispatch off it.

## The canvas reader lives in packages/lib

`readVectorFromDoc` serves both canvas types and reaches the API over the React-free `./vector` subpath. The editor and the server share it because it is the scene's trust boundary ([CANVAS.md](CANVAS.md#the-reader-is-the-trust-boundary)). Slides and drawings have no writer, so a canvas can't be imported.

## Capture leaves the database open

Capture opens the container's `data.db` through `mount.openDatabase` and does not close it, because a live collab session may share that instance. `Mount.closeAllDatabases` closes it at teardown. The stickies and chat readers open theirs the same way.

## The caller checks access

The layer takes a resolved Mount and `DrivePath` and assumes the caller already checked access. Routes do that through `getSharedDrive(ownerId, user)`.

## Stickies and chat read on the main thread

These two serve only the search extract, and both are cheap. `readStickiesContent` materializes the board's small Y.Doc directly. Chat's `data.db` is relational, not a Yjs log, so `readChatContent` walks the newest messages a page at a time on the same `createdAt` index `getMessages` uses, and stops when the text reaches `capBytes`. The cap is a parameter because the extract indexes about 100 KB per file ([SEARCH.md](SEARCH.md#documents-are-extracted-by-the-readers-export-and-preview-use)).

## The sheets reader replays ops and recalcs only for export

`readSheetsFromDoc` decodes `state.snapshot`, replays the pending op batches through the engine's `replaySheetsOps`, and materializes each sheet's dense `data` matrix, which the renderers and the cross-sheet resolver read. The editor replays the same way, and the op rules are in [SHEETS.md](SHEETS.md#an-edit-is-an-op-in-a-yarray). A document with ops but no snapshot replays from `createDefaultSheets`, the base the editor recorded those ops against.

Only the export read recalcs, and only a workbook with formulas and no `calcChain`. Preview and the search extract pass `{ recalc: false }`, because a legacy uncomputed workbook can outlast their 30 s Worker deadline ([SHEETS.md](SHEETS.md#the-editor-computes-on-write-the-server-only-what-nobody-computed)). A recalc that throws falls back to the replayed values and reports `recalcError`, so an export never fails on it.

## The writers replace, they don't merge

`writeSheetsSnapshotToYjs` sets `state.snapshot` and clears `ops` in one transaction. `writeEigendocUpdateToYjs` clears the `default` fragment and applies a prepared Yjs update; clearing first is what makes an import a replacement ([EXPORT.md](EXPORT.md#a-docx-import-replaces-the-document)). `writeEigendocToYjs` builds that update from ProseMirror JSON. The import path hands both writers what the Worker produced, so the main thread never parses it ([EXPORT.md](EXPORT.md#an-import-writes-nothing-until-the-worker-succeeds)).

Both write into the live `CollabDocument`, so the change persists and reaches connected editors like any edit, and a sheet editor remounts on the new snapshot. But nothing merges. The sheet ops a peer made since the last flush are cleared with the rest, and a peer's unsynced typing inside a deleted paragraph has nowhere to land. `convertToDocument` writes into a document it has just created, so no one can be editing it. `importIntoDocument` writes into an existing one, and `Drive` has no check for an open session. The live-safe writers are open work in [ROADMAP.md](ROADMAP.md).

## See also

- [DOCUMENT-TRANSFORMS.md](DOCUMENT-TRANSFORMS.md): capture, the Worker and every caller of the readers
- [SHEETS.md](SHEETS.md): the snapshot codec, op replay and recalc
- [EXPORT.md](EXPORT.md): export and the import that calls the writers
- [SEARCH.md](SEARCH.md): the content index built from the readers
- [COLLAB.md](COLLAB.md): the live `CollabDocument` the writers mutate
- `apps/api/src/test/document/`: round-trip tests for the readers and writers
