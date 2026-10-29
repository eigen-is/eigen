# Proposal: a chart in a doc, deck or drawing keeps its numbers in a sheet of its own

This proposal gives every chart in Docs, Slides and Vector a real Eigen sheet as its data source, stored inside the document beside its comment threads. Edit data opens that sheet in the Sheets editor, so a chart's numbers can be formulas, formatted and typed with Sheets' own keys, and the chart keeps a copy of the numbers it draws so nothing else has to open the sheet.

**Status:** not built, approved. [ROADMAP.md](../ROADMAP.md) has its row in P2; [ROADMAP-POST-1.md](../ROADMAP-POST-1.md)'s charts row and [CHARTS-TODO.md](../CHARTS-TODO.md)'s "Edit data: embed the Sheets grid" row link here. The decisions below were made by the owner on 2026-10-29. What this proposal says about the code was true on 2026-10-29, as far as a read of the repository could tell. Treat every such claim as a pointer and verify it in the code before building on it.

> **TLDR**: A doc's, deck's or drawing's chart holds inline data today, edited in a grid of its own that looks like Sheets but has no formulas, undo or fill handle. This proposal stores one `.eigensheets` per chart in a new `sheets/` folder of the document's container, as comment threads live in `chat/`, and names it from the chart's `data` part. The chart keeps its inline data as a cache of what the sheet computes, so the layout, previews, exports, search, copy and older builds all keep reading inline numbers and never open the sheet. Only Edit data does: it mounts the Workbook on the chart's sheet, and while it is open each change the sheet computes rewrites the chart's cache, so the chart redraws as the user types. The chart reads the block of cells around A1 of the sheet's first tab, laid out as Office lays out a chart's embedded workbook, so there are no cell refs to shift. A chart gets its sheet the first time Edit data opens, filled with the numbers it holds: a new chart, a pasted one and an imported one alike. This is Office's own model, a chart part with a cache beside an embedded workbook, so a docx or pptx export can embed the chart's real workbook, formulas included. No database migration. About 3 weeks in three phases.

## Goals

1. A chart's numbers in Docs, Slides and Vector can be formulas, and they are edited with Sheets' grid, keys, undo, number formats and fill handle, with no second grid to keep alike.
2. Everything that draws or reads a chart today keeps working unchanged: the layout, the node view and canvas kind, previews, HTML and PDF export, search and the clipboard.
3. A chart's sheet travels with its document: copy, move, trash, sharing and the portable package need nothing new to carry it.
4. A chart pasted from another tab, document or app gets a sheet of its own, filled with the numbers it carries.
5. A docx or pptx export embeds the chart's own workbook, so Edit Data in Word or PowerPoint opens the formulas, and an import brings them back.
6. An older build that opens a chart with a sheet draws it from the cache and never overwrites the link.

## Non-goals

- A chart linked to a sheet elsewhere in Drive, Google's model. That needs a permission-checked refresh through the Drive ACL wrapper and the Home relay, and stays the "linked data" part of the ROADMAP-POST-1 row. This proposal is its building block: a linked chart would be one whose sheet lives outside the container.
- One sheet shared by several charts. The owner chose one sheet per chart ([§ Decisions](#decisions)).
- Charts in Sheets. A sheet's chart already reads its own cells.
- Opening a chart's sheet in the Sheets app. It is a child of the document, hidden from Drive lists and search as comment threads are, and only Edit data opens it.
- Comments on a chart's sheet. The dialog hides the comment UI.
- Restoring a chart's sheet with a version of its document. A version restore brings back the chart's cache and leaves the sheet as it is ([§ Risks](#risks)).
- Drawings embedded in docs. CANVAS-TODO's row "Vector drawing app: embedding" plans a nested `drawings/` folder by the same pattern, and should share this one's rules when it is built.

## Current state

**A chart's data is inline or a range.** `ChartSpec.data` (`packages/lib/src/types/chart.ts`) is `InlineChartData` (`source: 'inline'`, `categories`, `series` with `values`) or `RangeChartData` (`source: 'range'`, `CellRangeRef`s into the workbook that holds the chart). Only a sheet resolves a range, so a docs `chart` node and a canvas `chart` element draw inline data only, and a range in them draws the placeholder ([CHARTS.md](../CHARTS.md)).

**Edit data is a grid of its own.** `ChartDataDialog` (`packages/ui/src/components/charts/chart-data-dialog.tsx`) shows inline data as a small sheet, categories down A and series along row 1, in Sheets' look and keys, with a draft that Save writes in one change ([CHARTS.md § Edit data](../CHARTS.md#edit-data-is-a-grid-over-inline-data-and-save-is-one-write)). It has no formulas, undo, fill handle or column resize, and stops at 12 series and 200 categories. CHARTS-TODO's row "Edit data: embed the Sheets grid" records a probe that mounted a one-sheet Workbook in the dialog, and the problems it found: a keystroke after Delete dropped inside the Radix dialog, the sheet's module-global copy state and `document` listeners, Escape mid-edit closing the dialog, and Save flattening formulas.

**An older build leaves unknown data alone.** `holdsUnknownChartData` (`packages/lib/src/charts/resolve.ts`) opens Edit data read-only when `data` or a series holds a key this build doesn't read, so a build never rebuilds data it can't carry ([CHARTS.md § A stored spec grows](../CHARTS.md#a-stored-spec-grows-only-in-ways-an-older-build-keeps)). A chart item on the clipboard carries every part as stored text, unknown keys included ([CLIPBOARD.md](../CLIPBOARD.md#a-chart-travels-as-its-spec-with-the-numbers-inline)).

**A container already holds documents of its own.** `CollabDocument.create` (`apps/api/src/lib/collab/collab-document.ts`) makes `media/` and `chat/` in every new doc, sheet, deck and drawing, and a comment thread is an `.eigenchat` created in `chat/` through `useCreateDriveItem('chat')` (`packages/lib/src/core/drive/hooks/writes.ts`, called by `use-create-comment-card.ts`) and named on its card by `chatName` ([COMMENTS.md](../COMMENTS.md#a-comment-lives-in-three-stores)). A name resolves to a path id at render through `MediaResolverProvider` ([MEDIA-REFERENCES.md](../MEDIA-REFERENCES.md)). Every path inside a container is left out of Drive lists and search (`docContainerDescendantIds`, [SEARCH.md](../SEARCH.md)). `findContainerFromAncestors` (`apps/api/src/lib/drive/acl.ts`) answers the outermost collab document for a nested path, so a child inherits the document's ACL ([ACL.md](../ACL.md)). A byte copy of a container is a valid independent document, because its children reference each other by name ([STORAGE.md](../STORAGE.md#copy-goes-anywhere-a-move-stays-in-its-mount)).

**The sheet engine runs anywhere.** `packages/sheet/src/engine/` imports nothing from the DOM or the editor state, and the API imports it ([SHEETS.md § The engine is the half the server imports](../SHEETS.md#the-engine-is-the-half-the-server-imports)). `resolveRangeChartData` (`engine/chart-data.ts`) turns refs into the categories and series the layout draws, reading computed values and display text through a `CellResolver`. `currentRegion` (`engine/chart-range.ts`) grows a cell to the table around it, stopping past `MAX_CHART_POINTS`. The barrel loads formulajs, 632 modules.

**Office already lays out a chart's sheet.** A docx or pptx export writes each chart's inline data into an embedded workbook, `embeddedChartSheet` (`apps/api/src/lib/ooxml/ooxml-chart-writer.ts`): series names along row 1 from B, categories down A from row 2, A1 empty, values in their format, a gap no cell ([CHARTS.md § A docx or pptx chart carries its numbers](../CHARTS.md#a-docx-or-pptx-chart-carries-its-numbers-in-a-workbook-of-its-own)). The imports read the chart's caches and never open the workbook, so a Word chart's formulas are lost today.

## Design

### Where the sheet lives

A chart's sheet is an ordinary `.eigensheets` container in its document's `sheets/` folder:

```
Report.eigendoc/
├── data.db
├── comments.db
├── media/
├── chat/
└── sheets/
    └── chart-1761730000000-a1b2c3.eigensheets/    one per chart
        ├── data.db
        ├── media/
        └── chat/
```

It is named as a comment thread is, `chart-<timestamp>-<nanoid6>`, and created through `useCreateDriveItem('sheets')` with the `sheets/` folder as parent, so `CollabDocument.create` provisions it and the collab route serves it by its own path id. `CollabDocument.create` adds `sheets/` to every new doc, deck and drawing beside `media/` and `chat/`. A container made before that gets the folder the first time a chart's sheet is created in it (open question 1). `MediaResolverProvider` learns a `resolveSheetId` for the fixed folder, as it resolves `chat/` names with `resolveChatId`.

Nothing else is new for the container. The sheet's ACL is the document's, since `findContainerFromAncestors` answers the outermost document. Drive lists, search and the Sheets app's list never show it. Copy, move, trash and restore of the document carry it, and a copy needs no rewriting because the chart names its sheet. The portable package of [PROPOSAL_PORTABLE_DOCUMENTS.md](PROPOSAL_PORTABLE_DOCUMENTS.md) gains a `sheets/` entry per chart.

### What the chart stores

The chart's `data` part stays `InlineChartData`, and grows one key, `workbook`, the name of its sheet in `sheets/`:

```json
{ "source": "inline", "workbook": "chart-1761730000000-a1b2c3.eigensheets",
  "categories": ["300", "400"], "series": [{ "id": "s-1", "name": "Sun", "values": [0.04, 0.12] }] }
```

The inline categories and series are the cache: the numbers the chart drew the last time its sheet was read. Everything that reads a chart reads them, so the layout, node view, canvas kind, previews, HTML and PDF export, `chartSearchText` and the clipboard need no change and never open a second container. `readChartSpec` reads `workbook` as a name of at most 255 characters that `MEDIA-REFERENCES`'s name rules accept, and drops anything else from `spec` while keeping it in `stored`. It is a key on a record, so the growth rules of [CHARTS.md](../CHARTS.md#a-stored-spec-grows-only-in-ways-an-older-build-keeps) hold: an older build draws the cache, and since `workbook` is a key it doesn't read, `holdsUnknownChartData` opens its Edit data read-only, so it can't rewrite the cache and leave the sheet behind.

The chart stores no cell refs. It reads a fixed block: the table `currentRegion` finds around A1 of the sheet's first tab, laid out as `embeddedChartSheet` lays it out, with series names along row 1 from B and categories down column A. Inserting a row grows the block, so nothing has to shift, and the user can put helper cells and other tabs beside it: a formula in the block may read any of them. A block past `MAX_CHART_SERIES` or `MAX_CHART_POINTS` doesn't resolve, the dialog says why with the Sheets insert's own refusal text (`CHART_RANGE_REFUSALS`), and the cache keeps its last numbers. Google's Setup (switch rows and columns, header row and column) can come later as a second key beside `workbook` without a format change.

Series ids are the cache's: the block's series take the ids of the cache's series at the same place, and a series past them gets a fresh `newChartSeriesId`, as Sheets' Setup keeps the id at each index. So a series' color and the points' styles, keyed by id, survive the round trip through the sheet.

### Edit data opens the chart's sheet

Edit data, from the panel and from a double-click, opens a dialog that mounts the Workbook on the chart's sheet, loaded with a dynamic `import('@workspace/sheet')` so Docs, Slides and Vector don't carry the formula engine until a dialog opens. What it opens depends on the chart's `workbook`:

| The chart's `workbook` | What Edit data does |
|---|---|
| Missing, as for a new chart, a pasted one or one from an older build | Creates a sheet, fills its first tab from the cache with `embeddedChartSheet`, and writes `workbook` |
| Resolves in this document's `sheets/`, and no other chart of the document names it | Opens it |
| Resolves, but another chart of the document names it too, as after a duplicate or a paste within the document | Copies it to a new name with `Drive.copyPath`, formulas kept, writes the copy's name, and opens the copy |
| Names nothing in `sheets/`, as for a chart pasted from another document | Creates a sheet filled from the cache, as for a missing one |

The last two rows keep one sheet per chart without the clipboard knowing where a chart came from. A sheet's name is a nanoid, so a name from another document resolves here only by a forgery, which the third row turns into a copy of a sheet the user can already read. "Another chart names it" is a walk over the document's chart nodes or canvas chart elements, done when the dialog opens.

`embeddedChartSheet` moves from `apps/api/src/lib/ooxml/ooxml-chart-writer.ts` to `packages/sheet/src/engine/`, so the dialog and the docx and pptx writers fill a sheet the same way. The writer keeps importing it from there.

The sheet is a live collab document, so an edit is stored as it is typed and there is no draft: Save and Cancel become one Done, as in Google's linked sheet. While the dialog is open, each change the sheet computes resolves the block (`resolveRangeChartData` over a `CellResolver` on the mounted workbook) and, when the result differs from the cache, writes the chart's `data` part through the chart's existing change path, debounced to one write per 300 ms. So the chart redraws behind the dialog as the user types, and a peer sees the doc's chart change. Opening the dialog does the same once, so a cache left stale by a crashed tab, a version restore or an older build is refreshed on the next open.

A cache write is no undo step in the document: the sheet's own undo stack undoes the edit, and a ⌘Z in the doc after Done must not set the cache back while the sheet stays. So the host writes it with an origin its undo manager doesn't track (open question 3). Two editors with the dialog open on one chart both write the same cache from the same sheet, and an equal cache writes nothing.

The dialog fixes the problems the CHARTS-TODO probe found before anything else: the focus trap that drops a keystroke, the workbook's module-global copy state and `document` listeners, and an Escape that closes the dialog while a cell is open (`WorkbookInstance` answers `isEditing()`). It hides the comment UI and the sheet's Insert → Chart. A viewer's Edit data opens the sheet read-only, as the collab route already enforces.

The inline grid stays for one case: a chart past its limits or holding data this build can't read opens read-only, as today. Every other chart edits its numbers in its sheet, so the 12-series and 200-category limits of the grid go away; the chart's own limits stay.

### Paste

A chart item on the clipboard carries the chart's parts as stored, `workbook` included, and its cache as the numbers. A paste into Docs, Slides or Vector stores the parts as it does today. The chart draws its cache at once, and its first Edit data gives it its own sheet by the table above: a copy of the source's sheet when it was copied within the document, else a sheet filled with the numbers it carries. So a chart copied from another tab, another document, Sheets or another Eigen app ends with a sheet of its own holding its numbers, and a paste writes no file: it stays synchronous, works offline, and an undone paste leaves no sheet behind.

A chart copied from Sheets carries its range read into numbers, so its pasted sheet holds the values, not the source cells' formulas. A paste into Sheets stores an inline chart, as today (open question 4).

### Office

A docx or pptx export of a chart whose sheet resolves writes that workbook, formulas included, through `writeXlsx` as the chart's embedding in place of `embeddedChartSheet`'s numbers, with the chart part's refs over the block and its caches from the chart's cache. The main thread captures the sheet's blobs with `captureCollabSource`, as it captures the document's, and the transform reads it with `readSheetsFromDoc`. A sheet that doesn't resolve, or whose block doesn't match the cache's shape, writes today's numbers-only workbook.

A docx or pptx import reads the chart's embedded workbook, when it has one, with the xlsx import's reader into a new sheet in `sheets/`, and the chart's caches into its inline data, as today. So a Word chart's formulas survive into Eigen and back. An embedding whose block isn't laid out from A1 as Office lays it out is left behind, and the chart keeps only its cache.

## Phasing and effort

| Phase | What | Effort |
|---|---|---|
| 1 | Docs: `sheets/` in the container, `workbook` in `readChartSpec`, `embeddedChartSheet` moved to the engine, the dialog on the Workbook with the probe's fixes, the live cache, the open table, copy on a shared name | 8 to 10 days, of which the CHARTS-TODO row's 4 to 5 |
| 2 | Slides and Vector: the canvas chart kind's Edit data on the same dialog, the walk over chart elements | 2 to 3 days |
| 3 | Office: the docx and pptx writers embed the chart's workbook, the importers read it into a sheet | 4 to 5 days |

Phase 1 ends with the domain docs: CHARTS.md's Edit data sections rewritten, MEDIA-REFERENCES.md's table and fixed folders, ARCHITECTURE.md's file-type storage column, the help-center chart article and the changelog.

## Risks

- **The cache and the sheet can disagree.** A version restore of the document, a crashed tab or an edit by an older build that can only read leaves the cache behind its sheet until the next Edit data opens. The chart draws the cache meanwhile, which is the number it showed last, never a wrong one it computed.
- **A deleted chart leaves its sheet.** As a comment thread stays when its anchor goes, so an undo or a version restore brings the chart back with its sheet. Nothing sweeps a sheet no chart names. A sheet is a few tens of KB, and a sweep is a later row once one is measured.
- **The Workbook in a dialog is the hard part.** The probe's focus, clipboard and Escape problems are known and the root cause of the first isn't. Phase 1 starts there, so a dead end is found before the rest is built.
- **Bundle size.** Docs, Slides and Vector load the sheet package only when a dialog opens; a first open waits for it.
- **A sheets document inside a document is new for collab.** The collab route, `findContainerPath`, version snapshots and `copyPathAcross` already handle a chat inside a document, and a sheets container is the same shape, but no test covers a collab document nested in another one yet. Phase 1 adds one for each.

## Decisions

- **One sheet per chart** (owner, 2026-10-29). A chart and its numbers copy, paste and delete together, as an Office chart and its embedded workbook do. A sheet shared by charts is not offered.
- **A pasted chart gets a sheet filled with its numbers, created at its first Edit data** (owner, 2026-10-29). A paste stays synchronous and offline-safe, an undone paste leaves no file, and a chart nobody edits never costs a container. A copy within the document keeps the source's formulas even when the source chart is deleted first: its sheet still resolves, and since no chart names it any more, the copy's first Edit data opens it.
- **The `sheets/` folder and a chart naming its sheet** (owner, 2026-10-29): a new seam beside `media/` and `chat/`, approved as designed here. A route change for open question 1 still needs its own yes.

## Open questions

1. **How does an older container get `sheets/`?** The client can create the folder through Drive's folder create when the first chart's sheet needs it, if that route accepts a container as parent; verify before phase 1. If it doesn't, the server creating the folder inside `Drive.create` when a sheets document's parent is a container's `sheets/` path is the alternative, and either is a route change that needs the owner's yes.
2. **Show Google's Setup in the dialog?** Phase 1 reads the fixed block. Switch rows and columns, and header row and column, would be a key beside `workbook` and the Sheets chart panel's Setup rows beside the grid.
3. **Can the cache write stay out of the document's undo?** Docs writes through y-prosemirror and a canvas through its own element writes; check that each has an origin its `Y.UndoManager` ignores before relying on it.
4. **What does a paste into Sheets do with a chart from Docs?** Today it stores an inline chart. Writing its numbers, or its sheet's cells, into the workbook beside the chart and making it a range chart would match Google's paste, and is a decision of its own.

## Related

- [CHARTS.md](../CHARTS.md) and [CHARTS-TODO.md](../CHARTS-TODO.md): the spec, Edit data and the probe this builds on
- [SHEETS.md](../SHEETS.md): the engine, range charts and `currentRegion`
- [COMMENTS.md](../COMMENTS.md) and [MEDIA-REFERENCES.md](../MEDIA-REFERENCES.md): the `chat/` pattern this copies
- [PROPOSAL_PORTABLE_DOCUMENTS.md](PROPOSAL_PORTABLE_DOCUMENTS.md): the package would carry `sheets/`
- [PROPOSAL_SHEETS_YJS_WORKBOOK.md](PROPOSAL_SHEETS_YJS_WORKBOOK.md): how a sheet stores its ops, which a nested sheet shares
- [ROADMAP-POST-1.md](../ROADMAP-POST-1.md): linked data, the chart whose sheet lives elsewhere in Drive
