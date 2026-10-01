# Document Content Layer

> **TLDR:** The server reads Eigen documents to export them, preview them and index them for search, and writes docs and sheets to import a file into them. `apps/api/src/lib/document/` holds a reader for every Eigen document type and a writer for docs and sheets. The heavy readers run inside the document-transform Worker, where import also parses its file. **The writers replace, they don't merge**: an import into a document someone is editing discards their pending work, and nothing checks for an open session first.

Most of the time the server does not look inside a document. A collab document is Yjs data that the browsers edit, and the server only relays and stores it ([COLLAB.md](COLLAB.md)). Four features need the content as content. Export turns a document into a file such as DOCX, XLSX, PDF or SVG ([EXPORT.md](EXPORT.md)). Preview renders what Drive shows of a file before it is opened ([PREVIEWS.md](PREVIEWS.md)). Search pulls the text out for its content index ([SEARCH.md](SEARCH.md)). Import turns a `.docx` into a doc or an `.xlsx` into a sheet, either a new one or by replacing an existing one's content.

A reader turns a stored document into plain data: a doc into ProseMirror JSON (the editor's document tree), a sheet into its cells, a slide deck or drawing into a scene of elements. A writer goes the other way, for docs and sheets only.

A collab document is stored as compressed Yjs blobs in the `data.db` of its container, the Drive folder that holds the document. Materializing it means applying those blobs to a fresh `Y.Doc` in memory, and that costs CPU in proportion to the document's size. So the heavy work runs in a transform Worker, a separate Bun thread that keeps it off the event loop every other request shares ([DOCUMENT-TRANSFORMS.md](DOCUMENT-TRANSFORMS.md)). The main thread copies the blobs out, and the Worker builds the `Y.Doc` and runs the reader. A Worker has no Mount, the object through which Drive reaches a mount's files and databases ([STORAGE.md](STORAGE.md#a-mount-is-a-paths-table-over-one-of-three-backends)). That is why a reader takes a `Y.Doc` and never a Mount. A stickies board is small and a chat is not Yjs at all, so those two readers run on the main thread, and only search uses them.

Two details surprise people: capture leaves the database open, because a live session may share it ([§ Capture leaves the database open](#capture-leaves-the-database-open)), and only the export read recalculates a sheet ([§ The sheets reader](#the-sheets-reader-replays-ops-and-recalcs-only-for-export)).

## A reader takes a Y.Doc, never a Mount

| Type | Reader | Returns | Writer |
|---|---|---|---|
| `.eigendoc` | `readEigendocFromDoc` (`doc.ts`) | ProseMirror `JSONContent` | `writeEigendocUpdateToYjs`, `writeEigendocToYjs` |
| `.eigensheets` | `readSheetsFromDoc` (`sheets.ts`) | `{ sheets, recalcError }` | `writeSheetsSnapshotToYjs` |
| `.eigenslides`, `.eigenvector` | `readVectorFromDoc` (`packages/lib/src/vector/read-vector.ts`) | `VectorScene` | none |
| `.eigenstickies` | `readStickiesContent` (`stickies.ts`, main thread) | card and column text | none |
| `.eigenchat` | `readChatContent` (`chat.ts`, main thread) | the newest messages as text | none |

The caller captures the blobs with `captureCollabSource`, and the Worker hands the `*FromDoc` reader the `Y.Doc` it built ([DOCUMENT-TRANSFORMS.md](DOCUMENT-TRANSFORMS.md)). No transform reads a persisted collab document on the main thread. Tests read through the same pipeline with the `readPersistedDoc` fixture. `COLLAB_DOCUMENT_TYPES` (`collab-types.ts`) maps a drive mime to the Worker's document type, and preview and search both dispatch off it.

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

Only the export read recalcs, and only a workbook nobody computed ([SHEETS.md § The editor computes on write](SHEETS.md#the-editor-computes-on-write-the-server-only-what-nobody-computed)). A recalc that throws falls back to the replayed values and reports `recalcError`, so an export never fails on it.

## The writers replace, they don't merge

`writeSheetsSnapshotToYjs` sets `state.snapshot` and clears `ops` in one transaction. `writeEigendocUpdateToYjs` clears the `default` fragment and applies a prepared Yjs update; clearing first is what makes an import a replacement ([EXPORT.md](EXPORT.md#a-docx-import-replaces-the-document)). `writeEigendocToYjs` takes ProseMirror JSON instead; only tests call it, because the import's Worker builds the update itself (`apps/api/src/lib/import/doc/transform.ts`). The import path hands both writers what the Worker produced, so the main thread never parses the file ([EXPORT.md](EXPORT.md#an-import-writes-nothing-until-the-worker-succeeds)).

Both write into the live `CollabDocument`, so the change persists and reaches connected editors like any edit, and a sheet editor remounts on the new snapshot. But nothing merges. The sheet ops a peer made since the last flush are cleared with the rest, and a peer's unsynced typing inside a deleted paragraph has nowhere to land. `convertToDocument` writes into a document it has just created, so no one can be editing it. `importIntoDocument` writes into an existing one, and `Drive` has no check for an open session. The live-safe writers are open work in [ROADMAP.md](ROADMAP.md).

## See also

- [DOCUMENT-TRANSFORMS.md](DOCUMENT-TRANSFORMS.md): capture, the Worker and every caller of the readers
- [SHEETS.md](SHEETS.md): the snapshot codec, op replay and recalc
- [EXPORT.md](EXPORT.md): export and the import that calls the writers
- [SEARCH.md](SEARCH.md): the content index built from the readers
- [COLLAB.md](COLLAB.md): the live `CollabDocument` the writers mutate
- `apps/api/src/test/document/`: round-trip tests for the readers and writers
