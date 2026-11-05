# Document Content Layer

> **TLDR:** The server reads Eigen documents to export them, preview them and index them for search, and writes docs, sheets and decks to import a file into them. `apps/api/src/lib/document/` holds a reader for every Eigen document type and a writer for docs, sheets and decks. The heavy readers run in a child process, off the API's event loop, and import parses its file there too. **A replacing writer doesn't merge**: an import that replaces a document someone is editing discards their pending work, so it saves a version first. An inserting writer, a deck's new slides or a workbook's new tabs, arrives like a peer's edit.

Most of the time the server does not look inside a document. A collab document is Yjs data that the browsers edit, and the server only relays and stores it ([COLLAB.md](COLLAB.md)). Four features need the content as content. Export turns a document into a file such as DOCX, XLSX, PDF or SVG ([EXPORT.md](EXPORT.md)). Preview renders what Drive shows of a file before it is opened ([PREVIEWS.md](PREVIEWS.md)). Search pulls the text out for its content index ([SEARCH.md](SEARCH.md)). Import turns a `.docx`, `.xlsx` or `.pptx` into a doc, sheet or deck: a new one, or into an open one, beside its content or in place of it.

A reader turns a stored document into plain data: a doc into ProseMirror JSON (the editor's document tree), a sheet into its cells, a slide deck or drawing into a scene of elements. A writer goes the other way, for docs, sheets and slide decks.

A collab document is stored as compressed Yjs blobs in the `data.db` of its container, the Drive folder that holds the document. Materializing it means applying those blobs to a fresh `Y.Doc` in memory, and that costs CPU in proportion to the document's size. So the heavy work runs in a transform process, a separate Bun process that keeps it off the event loop every other request shares ([DOCUMENT-TRANSFORMS.md](DOCUMENT-TRANSFORMS.md)). The main thread copies the blobs out, and the transform builds the `Y.Doc` and runs the reader. A transform has no Mount, the object through which Drive reaches a mount's files and databases ([STORAGE.md](STORAGE.md#a-mount-is-a-paths-table-over-one-of-three-backends)). That is why a reader takes a `Y.Doc` and never a Mount. A stickies board is small and a chat is not Yjs at all, so those two readers run on the main thread, and only search uses them.

Two details surprise people: only the export read recalculates a sheet ([§ The sheets reader](#the-sheets-reader-replays-ops-and-recalcs-only-for-export)), and a replace into an open document drops what its editors had pending ([§ A replace doesn't merge](#a-replace-doesnt-merge-an-insert-arrives-as-a-peers-edit)).

## A reader takes a Y.Doc, never a Mount

| Type | Reader | Returns | Writer |
|---|---|---|---|
| `.eigendoc` | `readEigendocFromDoc`, `readEigendocPage`, `readEigendocStyle` (`doc.ts`) | ProseMirror `JSONContent`, the `PageSetup`, the `NormalStyle` | `commitEigendocImport` |
| `.eigensheets` | `readSheetsFromDoc` (`sheets.ts`) | `{ sheets, recalcError }` | `writeSheetsSnapshot`, `appendSheetsToYjs` |
| `.eigenslides` | `readVectorFromDoc` (`packages/lib/src/vector/read-vector.ts`) | `VectorScene` | `replaceSlidesInYjs`, `insertSlidesIntoYjs` (`slides.ts`), for the pptx import |
| `.eigenvector` | `readVectorFromDoc` | `VectorScene` | none |
| `.eigenstickies` | `readStickiesContent` (`stickies.ts`, main thread) | card and column text | none |
| `.eigenchat` | `readChatContent` (`chat.ts`, main thread) | the newest messages as text | none |

The caller captures the blobs with `captureCollabSource`, and the transform hands the `*FromDoc` reader the `Y.Doc` it built ([DOCUMENT-TRANSFORMS.md](DOCUMENT-TRANSFORMS.md)). No transform reads a persisted collab document on the main thread. Tests read through the same pipeline with the `readPersistedDoc` fixture. `COLLAB_DOCUMENT_TYPES` (`collab-types.ts`) maps a drive mime to the transform's document type, and preview and search both dispatch off it.

## The canvas reader lives in packages/lib

`readVectorFromDoc` serves both canvas types and reaches the API over the React-free `./vector` subpath. The editor and the server share it because it is the scene's trust boundary ([CANVAS.md](CANVAS.md#the-reader-is-the-trust-boundary)). The deck writer reads its update back through it before writing, and writes through the same package's `write-vector.ts` ([SLIDES.md](SLIDES.md#the-deck-writer-inserts-under-fresh-ids-and-only-a-replace-clears-the-deck)). A drawing has no writer.

## Capture holds the database only while it reads

Capture reads the container's `data.db` inside `mount.withDatabase`, and so do the stickies and chat readers. A live collab session may share that instance, so a reader never closes it itself: it lets go, and the database closes after its idle time once no holder is left ([DATABASE.md](DATABASE.md#a-reader-holds-a-container-database-only-while-it-runs)).

## The caller checks access

The layer takes a resolved Mount and `DrivePath` and assumes the caller already checked access. Routes do that through `getSharedDrive(ownerId, user)`.

## Stickies and chat read on the main thread

These two serve only the search extract, and both are cheap. `readStickiesContent` materializes the board's small Y.Doc directly. Chat's `data.db` is relational, not a Yjs log, so `readChatContent` walks the newest messages a page at a time on the same `createdAt` index `getMessages` uses, and stops when the text reaches `capBytes`. Each line starts with its author's name and email, so a Drive search finds a chat by either. The cap is a parameter because the extract indexes about 100 KB per file ([SEARCH.md](SEARCH.md#documents-are-extracted-by-the-readers-export-and-preview-use)).

## The sheets reader replays ops and recalcs only for export

`readSheetsFromDoc` decodes `state.snapshot`, replays the pending op batches through the engine's `replaySheetsOps`, and materializes each sheet's dense `data` matrix, which the renderers and the cross-sheet resolver read. The editor replays the same way, and the op rules are in [SHEETS.md](SHEETS.md#an-edit-is-an-op-in-a-yarray). A document with ops but no snapshot replays from `createDefaultSheets`, the base the editor recorded those ops against.

Only the export read recalcs, and only a workbook nobody computed ([SHEETS.md § The editor computes on write](SHEETS.md#the-editor-computes-on-write-the-server-only-what-nobody-computed)). A recalc that throws falls back to the replayed values and reports `recalcError`, so an export never fails on it.

## The references reader names the parts a state uses

`documentReferences` (`references.ts`) returns what one state of a document names among its own parts: the files in its `media/` folder, the comment threads in its `chat/` folder, and the comment cards it has in use. The sweep builds on it, and keeps only the parts some state names ([MEDIA-REFERENCES.md](MEDIA-REFERENCES.md#a-file-stays-while-a-state-names-it-and-a-sweep-deletes-the-rest)). A name it misses would delete a part in use, so it errs toward more names. A throw means "delete nothing": the sweep skips the document, and a copy takes it whole.

Media come from `mediaNamesIn` over every content root: a doc's body and every band, a canvas's elements and its frame pictures (`sceneMediaNames`), a workbook's floating images. A card's attachment that is a name is a file in `media/` too. Only a card in use counts, by its host's rule: a doc's `comment` mark or a node's `commentCardId` in any fragment (`commentCardIdsIn`), a canvas card that an element anchors or that is not marked deleted (`activeCommentCardIds`), a cell's `commentCardIds`, and a stickies card some column lists (`boardCardIds`). A restore brings back a version's anchors but keeps today's cards, so a read of the current state can be given the cards the saved versions have in use, and then names the thread and the files today's card holds for each. `REFERENCE_READER_VERSION` changes whenever what a reader finds changes.

Each type reads its content as its editor does, so a shape the editor never shows names nothing:

- A doc and a workbook are walked whole for any `mediaName` and any anchor field, whatever node or cell holds it, so a node type the reader does not know still names its parts.
- A workbook is read as stored, its snapshot plus every pending op and no replay, so an image or a comment an op removed stays named until the next compaction. A snapshot it can't decode, such as broken JSON or another format, throws, and so does an op it can't read.
- The canvas reads its scene through `readVectorFromDoc`, which drops an element its editor can't read, so that element names nothing and draws nothing either.
- A board reads its cards through `boardCardIds`, as the board does: an id that no column lists, or that the `tasks` map holds as no card, is not in use.

The cards are read strictly in every type. A card that is no map, or whose thread name or attachment list has a shape the editor never writes, throws, because dropping it could drop a part it names.

## A replace doesn't merge; an insert arrives as a peer's edit

Each type has a replacing writer. `writeSheetsSnapshot` sets `state.snapshot`, stamps a fresh base (the compaction's swap names the base it folded) and clears `ops` in one transaction. `commitEigendocImport` clears the `default` fragment and the header and footer fragments, applies a prepared Yjs update and sets the page and Normal keys, in one transaction; clearing first is what makes an import a replacement ([EXPORT.md](EXPORT.md#a-docx-import-replaces-the-document)). The import's transform builds that update itself (`apps/api/src/lib/import/doc/transform.ts`). `replaceSlidesInYjs` clears the deck's frames and elements and writes the file's, with its `meta`. A replace hands its writer what the transform produced, so the main thread never parses the file ([EXPORT.md](EXPORT.md#an-import-writes-nothing-until-the-transform-succeeds)).

They write into the live `CollabDocument`, so the change persists and reaches connected editors like any edit, and a sheet editor remounts on the new snapshot. But nothing merges. The sheet ops a peer made since the last compaction are cleared with the rest, and a peer's unsynced typing inside a deleted paragraph has nowhere to land. So an Import… that replaces saves a version first ([EXPORT.md](EXPORT.md#a-replace-saves-a-version-first)), and `Drive` still has no check for an open session ([ROADMAP.md](ROADMAP.md)). `convertToDocument` writes into a document it has just created, so no one can be editing it.

The inserting writers add records and rewrite none, so a live editor keeps what it holds, its undo stack and its comments. `insertSlidesIntoYjs` writes every slide and element under a fresh id after the current slide ([SLIDES.md](SLIDES.md#the-deck-writer-inserts-under-fresh-ids-and-only-a-replace-clears-the-deck)). `appendSheetsToYjs` pushes the file's sheets as `addSheet` ops onto `ops`, which an open tab applies like a peer's new tab ([SHEETS.md](SHEETS.md#an-imported-tab-arrives-as-an-addsheet-op-renamed-as-duplicate-names-a-copy)). It decodes the file's snapshot on the main thread to rename and re-id its sheets, and the ops hold the sheets whole until the next compaction folds them into the snapshot.

## See also

- [DOCUMENT-TRANSFORMS.md](DOCUMENT-TRANSFORMS.md): capture, the transform process and every caller of the readers
- [SHEETS.md](SHEETS.md): the snapshot codec, op replay and recalc
- [EXPORT.md](EXPORT.md): export and the import that calls the writers
- [SEARCH.md](SEARCH.md): the content index built from the readers
- [COLLAB.md](COLLAB.md): the live `CollabDocument` the writers mutate
- `apps/api/src/test/document/`: round-trip tests for the readers and writers
