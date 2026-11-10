# Proposal: what Eigen's clipboard still lacks

Copy and paste between Eigen apps works for text, images, canvas elements and charts. This proposal lists what is still missing, in the order to build it, and how the first item fits with the chart sheets of [PROPOSAL_CHART_SHEETS.md](PROPOSAL_CHART_SHEETS.md).

**Status:** v1 is built and [CLIPBOARD.md](../CLIPBOARD.md) describes it. A block of cells on the clipboard is planned before 1.0 and has its row in [ROADMAP.md](../ROADMAP.md). The rest waits until after 1.0, in [ROADMAP-POST-1.md](../ROADMAP-POST-1.md). What this proposal says about the code was true on 2026-11-01; verify it before building on it.

> **TLDR**: The clipboard carries one typed JSON payload, `EigenClipboardData`, and four hosts read it: Docs, Sheets, Slides and Vector. The gap a user hits most is a block of cells. Sheets carries no cells on the wire, so a range pasted in another tab or by another user loses its formulas and formats. Fixing that is a new `cells` item, planned step by step in [SHEETS-TODO.md](../SHEETS-TODO.md#clipboard-put-sheets-on-the-shared-system). The block of cells it carries is the same thing a chart's own sheet is filled with, so the two share one block writer in the sheet engine, and neither has to wait for the other. After that come styled text runs into a slide, the apps with no clipboard yet, and small polish. The old v2 design's envelope, BroadcastChannel bus and converter registry are dropped: the v1 payload already grows by adding an item kind.

## What works today

A copy writes `EigenClipboardData` twice: on the `application/eigen-clipboard` type and inside a hidden marker span in `text/html`. An item is `text`, `image`, `elements` or `chart`. The reader validates every item and drops what it doesn't know, so a new kind is additive: an older build drops it and falls back to the HTML or plain text beside it (`isValidItem` in `packages/lib/src/core/clipboard/clipboard.ts`). An image travels as a name and re-uploads as the pasting user. Each host reads the flavors in its own order through `classifyPaste`. [CLIPBOARD.md](../CLIPBOARD.md) has the details.

## 1. A block of cells travels on the clipboard (before 1.0)

**The gap.** A sheets copy writes the payload but puts no cells in it. A paste in the same tab is served from `ctx.copyState`, which holds coordinates and re-reads the live cells, so formulas and formats survive. In another tab or another login there is no `copyState`, and the paste falls back to the HTML table: values and some styling, no formulas, number formats, conditional formats, validation or links ([CLIPBOARD.md § Sheets serves its own copies from memory](../CLIPBOARD.md#sheets-serves-its-own-copies-from-memory)).

**The plan** lives in [SHEETS-TODO.md § Clipboard](../SHEETS-TODO.md#clipboard-put-sheets-on-the-shared-system): a `cells` item built from lib's `Cell` records (`packages/lib/src/sheets/types.ts`, already the shape ops carry), a producer beside `copy` (`state/modules/clipboard.ts`), one paste path that takes the block whether it came from the wire or from `copyState`, and a flipped read order. Its "must not break" list holds: the visible `<table>` keeps going out verbatim for Excel, Google Sheets and Docs. Before building it the owner answers SHEETS-TODO's Q3 to Q9 (the in-memory cache, the item, the size cap, images, formula references, cut, and paste into a doc or slide).

**Why the item and not a v2 envelope.** A `cells` item is one more kind in the existing union. The reader drops an unknown kind, so a tab on an older build pastes the HTML table as it does now. The item carries its own source anchor and sheet name, which Q7 needs to shift formula references, so nothing else needs a source block.

## 2. Cells and chart sheets share one block writer

[PROPOSAL_CHART_SHEETS.md](PROPOSAL_CHART_SHEETS.md) gives every chart in Docs, Slides and Vector a sheet of its own, filled from the chart's numbers the first time Edit data opens. That fill and the paste of a `cells` item do the same thing: write a block of cells into a sheet at an anchor. So the sheet engine gets one pair of functions, one that reads a block from a sheet and one that writes it, and both features use it:

| User | Reads a block from | Writes the block into |
|---|---|---|
| A sheets copy and paste | The copied range | The target sheet, at the selected cell |
| A chart's first Edit data | The chart's inline numbers, laid out as `embeddedChartSheet` lays them out | The chart's new sheet, at A1 |
| A docs, slides or vector chart pasted into Sheets (chart sheets' open question 4) | The chart's inline numbers | The workbook, beside the chart, which then stores a range chart over them |

Neither feature has to wait for the other. The block shape is fixed by item 1 (lib's `Cell`, keyed relative to the block's top-left corner), and the clipboard item is a wire shape, not a stored one, so it can still change between builds. Building cells first is the cheaper order: chart sheets' phase 1 then moves `embeddedChartSheet` to the engine as a function that builds a block from numbers, and writes it with the same writer.

A chart copied from Sheets is the one case that could get better than either proposal alone. Its tab has the source cells live, so the copy can put a `cells` item of the chart's range beside the `chart` item, formulas included. The pasted chart's sheet could then start with those formulas instead of the numbers. Chart sheets creates a pasted chart's sheet at its first Edit data, so the block has to get there somehow. There are three ways, and the choice is the owner's:

- **Numbers only**, as chart sheets plans now. Nothing extra to build. A chart moved from Sheets to a doc loses its formulas.
- **Keep the block on the chart until its first Edit data**, as a key beside `workbook` in the chart's `data` part. The formulas survive, but the doc stores up to a range of cells it may never use, and the key is a stored-format addition.
- **Create the sheet at paste when a block rides along.** The formulas survive and nothing waits in the doc. The cost is that this paste writes a file: it needs the server, and an undone paste leaves an unused sheet behind, as a deleted chart already does.

The first is the default for chart sheets' phase 1. When the formulas are wanted, the third is the cleaner of the other two: it adds no stored key and keeps the doc small. A docs chart copied to Sheets gets only its numbers in any case: its sheet is a separate document that a copy event can't load in time.

## 3. Styled text runs reach a slide or a drawing (after 1.0)

A `text` item is plain text plus one set of box typography (`EigenClipboardTypography`). So text copied from Docs to a slide keeps its font and color, but a bold word or a link inside it is lost. A canvas rich-text box stores HTML (`Textual.html`, `packages/lib/src/vector/types.ts`), and the canvas already sanitizes pasted records with `sanitizeToLightEditorHtml`. The fix is for the canvas to read the copied `text/html` beside a text item through that sanitizer, rather than for the item to grow a second copy of the text. Check first that a docs copy's HTML maps onto the light editor's marks. S to M.

## 4. The apps outside the four hosts (after 1.0)

| App | What a copy would carry | What a paste would do |
|---|---|---|
| Stickies | A card's title and description as a `text` item, and as HTML | Accept text as a new card; accept a cells block as one card per row |
| Chat | Messages as text | Nothing new: chat already takes text and files |
| Calendar | An event as text, with an `.ics` flavor | Paste an `.ics` as a new event |
| Contacts | A contact as text, with a `.vcf` flavor | Paste a `.vcf` as a new contact |
| Drive | Files as references | Copy or move into the open folder, as drag already does |

None of them needs a new item kind to be useful: text and the standard file formats reach every other app too. A kind gets added only when an Eigen-to-Eigen paste would lose something the text form can't carry.

## 5. Smaller polish (after 1.0)

- **Cut across tabs copies.** Docs and the canvas delete on cut, so a paste anywhere carries the content. A sheets cut moves the cells only when pasted in the same tab (`pasteIsCut`); in another tab it acts as a copy and says nothing. SHEETS-TODO's Q8 recommends keeping that and saying so. No cross-tab bus is needed.
- **Paste special in Sheets**: values only, formats only. Sheets has neither today.
- **Docs: Edit › Paste and Paste without formatting**, already a ROADMAP-POST-1 row. Reading the clipboard from a menu asks the browser's permission, and the owner chose to wait.
- **An image URL pasted alone becomes an image** in Docs and on the canvas. The browser can rarely fetch it, since few sites allow cross-origin reads, so this needs the server-side fetch route that ROADMAP's row on doc figures with an external `src` already asks for, and the owner's yes.
- **A canvas copy pastes nothing into mail compose**, a row in [CANVAS-TODO.md](../CANVAS-TODO.md).
- **A chart linked to a sheet elsewhere in Drive** is the "linked data" part of ROADMAP-POST-1's charts row, not a clipboard feature.

## Dropped from the old v2 design

- **A v2 envelope with a `source` block and a `content` list.** The v1 union already grows by kind, and the one kind that needs a source anchor carries its own.
- **A BroadcastChannel bus** for cut and large payloads. It reaches only tabs of one browser profile, so it helps neither another login nor another machine. Cut needs no bus (item 5), and the size question has a cap and an honest fallback (SHEETS-TODO's Q5).
- **A converter registry.** Each host keeps its own paste ladder ([CLIPBOARD.md § Each app keeps its own paste ladder](../CLIPBOARD.md#each-app-keeps-its-own-paste-ladder)), and a conversion is a function in the host that needs it.
- **An async write that throws for the caller to toast.** Errors surface through the hooks' own notifications ([NOTIFICATIONS.md](../NOTIFICATIONS.md)).

## Related

- [CLIPBOARD.md](../CLIPBOARD.md): how the clipboard works today
- [SHEETS-TODO.md](../SHEETS-TODO.md#clipboard-put-sheets-on-the-shared-system): the step-by-step plan and questions for the `cells` item
- [PROPOSAL_CHART_SHEETS.md](PROPOSAL_CHART_SHEETS.md): a chart's own sheet, which shares the block writer
- [MEDIA-REFERENCES.md](../MEDIA-REFERENCES.md): why an image travels as a name
