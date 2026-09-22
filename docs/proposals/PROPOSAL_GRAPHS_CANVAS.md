# Proposal: Charts

> **TLDR**: Eigen has no charts. Sheets drops every chart when it imports an xlsx, and vector, slides and docs cannot make one. This proposal adds one chart model for all four apps. A chart is a `ChartSpec`: a type, a title, axes, a legend and a list of series. Its data comes from one of two sources. **Inline data** (categories and series with stable ids) is what vector, slides and docs store. **Range data** (each series points at a cell range by sheet id, row and column) is what sheets stores, so a sheets chart follows its cells the way an Excel chart does. A pure resolver turns either source into the same resolved table, and one pure layout module plus the existing roughjs painter draw it, synchronously and without a DOM, so the live editor, the preview Worker and every export draw the same chart. Scales and shapes come from `d3-scale` and `d3-shape`. There is no Vega and no Recharts. Rules are ported from Excalidraw's chart module, Observable Plot and ECharts, each with its test, the way the canvas engine ported Excalidraw's arrows. Range refs shift on row and column inserts and deletes inside the engine's existing structural-edit pass, so collab, undo and replay need nothing new. xlsx charts map well: the real workbook inspected here carries line and stacked-area charts whose series are row ranges on another sheet, which is exactly the range form. Bar, line, pie and area cover the common cases; combo charts, scatter and Excel 2016 chart types import as a visible placeholder. On a canvas, an arrow can bind to a single bar, slice or point through an optional `mark` on the existing binding, docked by the existing docking code.

**Status:** Proposed, not implemented. Facts below were checked against the repository on 2026-09-22. "Graphs" in the file name means data charts, not node-and-edge diagrams.

## Goals

1. One chart model, one layout and one painter for vector, slides, sheets and docs. A chart copied between apps stays a chart.
2. Sheets charts bound to cell ranges that update when the cells change and follow rows and columns when they are inserted or deleted.
3. xlsx import reads the charts a workbook carries, and xlsx export writes native charts back, so a round trip through Eigen keeps them.
4. Every preview and export draws the chart the editor draws: server previews, HTML, PDF, SVG, DOCX and xlsx.
5. On a canvas, an arrow can point at one bar, one slice or one line point and keep pointing at it when the data changes.

## Non-goals

- A general visualization grammar. The chart vocabulary is small and closed: bar, line, pie and area first, more types added one at a time with their tests.
- Pivot charts, chart sheets (`xl/chartsheets/`), 3D rendering and Excel's 2016 chart family (waterfall, histogram, treemap, sunburst, box and whisker, funnel). These import as a placeholder, see § xlsx import.
- Live links from a vector, slides or docs chart to a sheet in another document. That is a later phase with its own permission and identity questions (§ Phasing, later work).
- Annotating charts with arrows inside docs and sheets. Arrows need a scene; docs and sheets do not have one.

## Current state

**Nothing draws a chart.** No chart or d3 package is in the tree; `roughjs` 4.6.4 (`packages/lib/package.json`) is the only drawing dependency. The one chart trace is `chart_selection: unknown` in `packages/sheet/src/state/context.ts`, declared and initialized to `{}` and read nowhere: fortune-sheet's abandoned chart state. It is dead code, not a seam, and goes in phase 0.

**xlsx import drops charts and images.** `xlsxToSheets` (`apps/api/src/lib/import/sheets/from-xlsx.ts`) loads the workbook with ExcelJS 4.4.0 and reads a few things ExcelJS misses (internal hyperlinks) straight from the zip with JSZip and regex (`readLocationHyperlinks`, `xmlAttribute`). ExcelJS has no chart support at all: `lib/xlsx/xform/drawing/` holds picture anchors only (`pic-xform.js`, `one-cell-anchor-xform.js`, `two-cell-anchor-xform.js`), and a `graphicFrame` holding a chart is skipped. The importer does not call `worksheet.getImages()` either, so floating images are dropped on import too, even though ExcelJS parses those.

**xlsx export writes neither.** `to-xlsx.ts` builds an ExcelJS workbook and then post-processes the zip with JSZip (`rewriteInternalHyperlinks`), which is the pattern chart export needs. Floating images are dropped there today; that is its own ROADMAP row ("xlsx export drops floating images").

**Floating images are the sheets precedent.** `SheetImage` (`packages/lib/src/sheets/types.ts`) is `{ id, mediaName, x, y, width, height, angle? }` in unzoomed grid pixels from A1's top-left. `images` is a typed field on lib's `Sheet`, encoded explicitly by `snapshot-codec.ts`, materialized on every replay base by `withNormalizedSheet` (`engine/replay-ops.ts`), and drawn by the HTML/PDF export and the preview (`renderFloatingImages`, `apps/api/src/lib/export/sheets/render.ts`). In the editor, `ImgBoxs` (`packages/sheet/src/components/ImgBoxs/index.tsx`) draws each image with `ObjectTransform`, the active one at z-index 20 and the rest at 19. The editor state still routes images through a context mirror (`ctx.insertedImgs`, special-cased in `opToPatch` in `state/utils/patch.ts`), inherited from fortune-sheet.

**Structural edits already shift ranges and formulas.** `applySheetsInsertRowCol` and `applySheetsDeleteRowCol` (`packages/sheet/src/engine/rowcol.ts`) shift merges, row and column sizes, conditional-format `cellrange`s (inline range math in `applyInsert` and `applyDelete`) and, through `shiftFormulasAcrossSheets` and `functionStrChange`, every formula on every sheet that names the edited sheet. The same function runs on the editor's immer draft and in `replaySheetsOps`, and a structural batch ships every field of the edited sheet as an authoritative replace (`sheetMetadataOps`). Renaming a sheet does not rewrite formula text that names it: `editSheetName` (`state/modules/sheet.ts`) only sets the name.

**The canvas engine is ready for a new kind.** A kind is one `defineKind` file in `packages/lib/src/vector/kinds/` plus an `ELEMENT_KIND_UI` entry ([CANVAS.md](../CANVAS.md) § Adding a kind). `render(el, ctx)` is synchronous and DOM-free and returns an SVG string, which is why `sceneToSvg` and the compositor run unchanged in the transform Worker. The painter helpers (`renderRoughShape`, `baseRoughOptions`, `fillDefs`, `svgId`, `drawableToSvg`) live in `kinds/render-utils.ts` and are not barrel-exported. `arrow-render.ts` is the precedent for a render module beside its kind.

**Arrow bindings dock to a whole element.** `Binding = { elementId, fixedPoint }` (`packages/lib/src/vector/types.ts`, not exported; `parseBinding` is). `boundEndpoint`, `followBindings`, `anchorToScene` and `elbowAnchorScene` (`geometry.ts`) take a `VectorBindableElement` and use its box, its `outline(inflate)` and its gap policy. `OutlineShape` (`outline.ts`) is `rounded | polygon | ellipse | polyline`. `sameRouteContext` in `packages/ui/src/components/vector/element-layer.tsx` memoizes an elbow arrow on its two bound elements.

**Text cannot be measured in lib.** `font-metrics.ts` holds vertical metrics only, and `text-measure.ts` (canvas `measureText`) lives in `packages/ui`. The arrow label stores a client-measured `labelWidth`; a chart's labels are derived, so that answer does not apply.

**Docs have one figure path.** `FigureNode` (`packages/lib/src/docs/eigendoc/nodes/figure.ts`) is an inline atom with `layout: block | wrap-left | wrap-right`. `renderFigureNode` in `apps/api/src/lib/export/doc/render.ts` serves export and the eigendoc preview, and the app's node view (`apps/docs/src/components/docs/extensions/figure.tsx`) uses `ObjectTransform`.

**Exports and previews.** Every preview and export runs in the one-shot document-transform Worker ([PREVIEWS.md](../PREVIEWS.md), [EXPORT.md](../EXPORT.md)). Sheets previews never recalc and render stored values; the export read recalcs a stale workbook. HTML and PDF pass `sanitizeExportHtml`, which keeps SVG `fill="url(#…)"` references because they are attributes. DOCX goes through `@turbodocx/html-to-docx` 1.22.2, which accepts an `image/svg+xml` data URI: its default `svgHandling: 'convert'` rasterizes through sharp, and it can also embed the SVG natively (`asvg:svgBlip`). Canvas previews cap at 500 elements (`PREVIEW_MAX_ELEMENTS`, `apps/api/src/lib/preview/preview-scene.ts`).

## What an xlsx chart carries

Measured on a real project workbook exported by Google Sheets (16 sheets, not committed). Its "Project Dashboard" sheet holds three charts: two line charts and one stacked area chart.

| Part | What it holds | In the inspected file |
|---|---|---|
| `xl/worksheets/sheetN.xml` + rels | `<drawing r:id>` pointing at the sheet's one drawing part | `sheet1.xml` → `drawings/drawing1.xml` |
| `xl/drawings/drawingN.xml` | One anchor per object: `twoCellAnchor` (from and to cell + EMU offsets), `oneCellAnchor` (from cell + `ext` size) or `absoluteAnchor`. A `graphicFrame` names the chart by `c:chart r:id` | Three `oneCellAnchor`s at row 12, e.g. col 0 + 114300 EMU, size 4400550 × 2705100 EMU (462 × 284 px at 9525 EMU per px) |
| `xl/drawings/_rels/drawingN.xml.rels` | The chart part per `r:id` | `../charts/chart1.xml` … `chart3.xml` |
| `c:plotArea` | One or more chart groups (`c:lineChart`, `c:barChart`, `c:areaChart`, `c:pieChart`, …) plus their axes (`c:catAx`, `c:valAx`, `c:dateAx`) | One group per chart: `lineChart`, `areaChart` with `c:grouping val="stacked"`, `lineChart` |
| `c:ser` | `c:tx` (name: a `strRef` to one cell, or a literal), `c:cat` (`strRef`/`numRef`/`multiLvlStrRef`), `c:val` (`numRef`), each ref a formula `c:f` plus an optional cache; `c:spPr` colors; `c:marker`; `c:smooth`; `c:dPt` per-point overrides; `c:dLbls` data labels | Series are **row ranges on another sheet**: `'MASTER DATA'!$C$490:$AD$490` (28 points), categories `'MASTER DATA'!$C$915:$AD$915` ("Pre Project", "Week 1", …), names `'MASTER DATA'!$B$490` ("Sold"). One series has no `c:tx`. Value cells are formulas |
| Caches | `c:numCache` / `c:strCache` with the values at save time | **Empty**: every `numRef` has `<c:numCache/>` and no `strRef` has a `strCache`. The data exists only in the cells |
| Colors | `a:srgbClr` or `a:schemeClr` (theme, with `lumMod`/`lumOff`), with `a:alpha` | `srgbClr` with alpha, e.g. the area series are one purple at 10 %, 20 % and 30 % |
| Title, axes, legend | `c:title` rich text or a cell ref; `c:autoTitleDeleted`; axis `c:delete`, `c:axPos`, `c:scaling` (min, max, orientation, logBase), `c:majorGridlines`, `c:numFmt` (`sourceLinked`), axis titles; `c:legend` with `c:legendPos` | Titles as rich text; empty axis titles; value gridlines `B7B7B7`; `numFmt General sourceLinked="1"`; legend at top; theme font `+mn-lt` |
| Visibility | `c:plotVisOnly` (skip hidden cells), `c:dispBlanksAs` (gap, zero, span) | `plotVisOnly val="1"` |

Excel-authored files add things this Google export does not: filled caches, `twoCellAnchor` with `editAs`, `schemeClr` colors, `c:style` and `mc:AlternateContent` blocks, and `cx:chart` parts for the 2016 chart family. No xlsx fixture in the repository contains a chart (there are no committed `.xlsx` files at all), so phase 3 adds a small set: this shape (rows, cross-sheet, empty caches), an Excel-authored bar and pie with caches and theme colors, a combo chart and a `cx:` chart for the placeholder path.

Two conclusions drive the design. First, **an xlsx chart is series-first and range-bound**: each series names its own ranges, and nothing requires a rectangular table. Second, **caches cannot be the source**: this producer leaves them empty, and in an Eigen sheet the cells are the truth anyway. Excalidraw's parser (`tryParseCells`) returns the same series-first shape (`{ title, labels, series: [{ title, values }] }`), so both routes into a chart agree.

## Design

### One model, two data sources

The shared types live in `packages/lib/src/types/chart.ts`; a sketch, not yet exported:

```typescript
type CellRangeRef = { sheetId: string; row: [number, number]; column: [number, number] };

type ChartSeriesStyle = { fill: Fill; markers: boolean; curved: boolean };

type InlineChartData = {
    source: 'inline';
    categories: { id: string; label: string }[];
    series: ({ id: string; name: string; values: (number | null)[] } & ChartSeriesStyle)[];
};

type RangeChartData = {
    source: 'range';
    categories: CellRangeRef | null; // null: 1, 2, 3 …
    series: ({ id: string; name: string | CellRangeRef; values: CellRangeRef | null } & ChartSeriesStyle)[];
    plotHidden: boolean; // xlsx plotVisOnly, inverted
};

type ChartSpec = {
    v: 1;
    type: 'bar' | 'line' | 'pie' | 'area';
    stacking: 'none' | 'stacked';
    title: string;
    legend: 'top' | 'bottom' | 'left' | 'right' | 'none';
    valueAxis: { title: string; min: number | null; max: number | null; gridlines: boolean; format: string | null };
    categoryAxis: { title: string };
    blanks: 'gap' | 'zero' | 'connect';
    pointFills?: Record<string, Fill>; // pie slices and xlsx c:dPt, keyed by category key
    data: InlineChartData | RangeChartData;
};

type ChartMarkRef = { seriesId: string; categoryKey: string };
```

`Fill` is the existing canonical type (`packages/lib/src/types/background.ts`): paint plus hatch style, with `#rrggbbaa` colors, so an xlsx alpha maps without loss.

**Why series-first rather than a table.** The alternative is an ECharts-style table: columns with ids, rows with ids, series as numeric columns. It reads well in a chart editor, but it cannot express what an xlsx chart is: each series owns its own ranges, series may sit in rows or columns, and series may have different lengths or come from different sheets. Every spreadsheet, DrawingML and Excalidraw's parser model charts series-first. The chart editor can still show inline data as a grid (categories down, series across); that is a view, not the storage.

**Why two sources rather than one.** Range data only makes sense next to a workbook. Inline data is what a drawing, a slide and a document can own. Forcing sheets to copy cell values into the chart would make every chart stale after the next edit and would duplicate the cells in the snapshot. Forcing canvases to reference a sheet would make a drawing depend on another document's permissions and existence. So the spec is shared and only `data` differs. The rules:

- Vector, slides and docs accept only `source: 'inline'`. Their readers reject a range source.
- Sheets accepts both. A chart pasted into a sheet from a drawing stays inline.
- Copying a sheets chart out of the workbook resolves it once and stores the result as inline data with fresh category ids. The copy is a snapshot and the paste says so.

**Resolution.** `resolveChartData(spec, lookup)` returns one `ResolvedChartData`: category keys and labels, and per series its id, name, style and `(number | null)[]` values, plus diagnostics. For inline data the keys are the category ids. For range data the keys are positional (`#0`, `#1`, …), and `lookup` is the sheet engine's `CellResolver` (`engine/cell-resolver.ts`), so the resolver for sheets lives in `packages/sheet/src/engine/` (sheet imports lib, never the reverse). Values are the cell's computed `v` when it is a number; text, booleans and error cells resolve to `null` with a diagnostic. Category labels and series names are the cell's display text `m`, so dates and currency read as the sheet shows them. With `plotHidden: false` the resolver skips hidden rows and columns, including rows a filter hides, as Excel does. A series range must be one row or one column; the category range must be too. A value range longer than the categories gets blank labels; a shorter one plots its own length.

**Why `CellRangeRef` is structured and keyed by sheet id.** The xlsx form is A1 text (`'MASTER DATA'!$C$490:$AD$490`), and formulas in Eigen are A1 text too. But renaming a sheet does not rewrite formula text today, so a chart stored as A1 text would break on the first rename. A sheet id survives the rename, and a structured range needs no parser on every draw. The importer and exporter convert at the file boundary with the engine's existing `parseA1Range` and `getSheetIdByName`.

**Tick formats.** `valueAxis.format` is an Excel number format or `null`. `null` means "linked to the source": the sheets resolver takes the first value cell's format and formats ticks through the engine's formatter (`engine/format.ts`). On a canvas, where there is no format engine, ticks use lib's own formatter: precision from the tick step, pinned to the `en` locale so a Worker and a browser agree. The layout takes the formatter as a parameter, which is the one seam between the two.

### Layout and paint

```text
ChartSpec + resolved data + box + paint (stroke, roughness, seed, font, background)
                               |
                        layoutChart (pure, sync)
                               |
          marks with keys, boxes and outlines; axes; ticks; labels; legend
                  /                                  \
      renderChartSvg (roughjs painter)          dock targets (canvas only)
```

`packages/lib/src/charts/` holds the model code: validation, limits, `resolveChartData` for inline data, `layoutChart`, the text-width table and the pasted-text parser. It is a new React-free subpath `@workspace/lib/charts`, listed with `sheets` and `vector` as BE-safe ([ARCHITECTURE.md § Backend imports of lib](../ARCHITECTURE.md#backend-imports-of-lib)). The painter, `renderChartSvg`, lives in `packages/lib/src/vector/kinds/chart-render.ts` beside `arrow-render.ts`, so it uses the internal painter helpers without exporting them, and it is exported from `@workspace/lib/vector` for sheets and docs. React lives in `packages/ui/src/components/charts/`: the chart editor, the data grid and "View data". It never computes a scale or draws.

**Paint is a parameter, not stored in the spec.** On a canvas the chart element supplies it: stroke, roughness, seed and opacity from the base fields every kind has, and `fontFamily`, `fontSize`, `color` and the background `fill` as the kind's own fields, the way the rich-text kind stores its font. Sheets and docs have no element, so their chart records carry a `paint` object with the same keys and a flat preset (roughness 0, Inter), which is also how an imported Excel chart should look.

**Dependencies.** `d3-scale` for linear and band scales (`ticks`, `nice`, band `padding`, `round`) and `d3-shape` for `arc`, `pie`, `line`, `area` and `stack`. Both are pure and DOM-free, but `d3-scale` pulls `d3-array`, `d3-format`, `d3-interpolate`, `d3-time` and `d3-time-format`, so phase 0 measures the bundle cost. If it is not worth it for four chart types, the tick and arc math is written inline. Either way the layout module stays pure and synchronous.

**Marks map onto roughjs calls the engine already makes.**

| Mark | Painter call | Notes |
|---|---|---|
| Bar | `rectangle`, with the shape's corner treatment | Same small-shape roughness adjustment as a rectangle element, computed on the bar's own size |
| Line | `linearPath`, or `curve` when curved | A `null` value splits the path with `blanks: 'gap'` |
| Area | `polygon` from `d3-shape` `area` over the `stack` offsets | Same fill rules as a closed line |
| Point marker | `ellipse` | |
| Pie slice | `arc(cx, cy, w, h, start, stop, closed = true)` | roughjs draws a closed arc as a sector, hatch included; a single full slice is an `ellipse` |
| Axes, ticks, gridlines | `line` | |

**Determinism.** Each mark's roughjs seed derives from the chart's seed and the mark's series id and category key, never its position, so reordering data does not reroll every hatch. Gradient and clip ids go through `svgId` scoped by chart id and mark key, and stay SVG attributes, never CSS `url()`, which the export sanitizer would strip. Opacity applies once on the layer. Labels are plain SVG `<text>`, never `foreignObject`, and because the kind stores `fontFamily` and has search text, `sceneFontFamilies` collects it for export font embedding. Series colors are assigned from the palette once at creation and stored, so hiding or reordering a series never recolors the others.

**Text width.** Add a build-time advance-width table per Eigen font and weight (`EIGEN_FONTS`, `packages/lib/src/constants/fonts.ts`) beside `font-metrics.ts`, and a `measureLabel(text, family, size)` that reads it. Browser and Worker then lay out identically. A label wider than its slot is truncated with an ellipsis by the same measure; the full text is in the data view.

**Size.** Layout runs at the chart's logical size. A thumbnail scales the finished drawing and never recomputes ticks. A box too small to lay out draws a visible placeholder; a malformed stored spec draws a bounded error placeholder and is kept untouched for recovery.

### Numeric behavior

| Input | Behavior |
|---|---|
| Finite number | Plotted. Negative bars extend below the baseline; a bar or area scale always includes zero. |
| `null` (blank, text, error) | `blanks` decides: `gap` (default) breaks a line and draws no bar, `zero` plots 0, `connect` joins the neighbors. |
| Zero | Valid data, distinct from missing. A zero bar keeps a baseline dock point. |
| Pie with a negative value | Data error shown on the chart and in the editor, never absolute values or silent omission. |
| Pie with zero total, empty data, one point, constant series | A deterministic non-degenerate scale or an explicit empty state; never NaN or Infinity in SVG. |
| Duplicate category labels | Separate points by key, no aggregation. |

### Porting rules from mature tools

The canvas engine got its design by porting Excalidraw's rules with their tests, not by embedding Excalidraw. Charts follow the same method.

| Source | Port | Leave |
|---|---|---|
| Excalidraw `packages/excalidraw/charts/` | `tryParseNumber` (sign, currency symbol, thousands separators, trailing `%`); `tryParseSpreadsheet` (tab, comma or semicolon, most consistent columns wins); header detection (a first row with no numeric cell); the wide-format rule (more value columns than rows transposes, so rows become series); the label slot layout (`CARTESIAN_BASE_SLOT_WIDTH` 44, `CARTESIAN_LABEL_MIN_WIDTH` 28, the rotated fallback `CARTESIAN_LABEL_ROTATION`); `GRID_OPACITY` 10; seeded palette offsets (`getSeriesColors(count, getColorOffset(seed))`) so two charts on one page differ; the fixtures in `tests/charts.test.tsx` as our parser corpus. | Its storage: a chart becomes loose rectangles and text with no data behind them. Its clamping of negative values to zero. Radar. |
| d3-scale, d3-shape | Taken as dependencies (subject to phase 0): linear `ticks`, `nice`, `tickFormat` precision from the step; band `paddingInner`, `paddingOuter`, `round`; `arc` with `padAngle` and `cornerRadius`; `pie` with `sort(null)` and `startAngle`; `line` and `area` with `defined`; `stack` with `stackOffsetNone`. | Nothing; they are pure functions. |
| Observable Plot | Bar domains include zero; band padding 0.1; band scales round to whole pixels; tick count from pixel spacing, not a fixed number; ellipsis for overlong tick labels. | The DOM renderer and the mark API. |
| ECharts | `seriesLayoutBy` (series in rows or columns: the "switch rows and columns" button); pie `avoidLabelOverlap` and label lines as the reference for pie labels. | zrender and its layout code. |
| Excel, Google Sheets | Chart from selection: a text first row names series, a text first column names categories, and series run along the longer side; `dispBlanksAs` (gap by default); `plotVisOnly`; axes cross at zero; value ticks take the source cell's number format. | Their range behavior on edits is specified by Eigen's own rules below, not assumed. |

### Sheets: range-bound charts

**Storage.** lib's `Sheet` gains `charts?: Record<string, SheetChart>`, with `SheetChart = { id, index, x, y, width, height, spec, paint }`: pixel coordinates from A1 like `SheetImage`, a fractional `index` for paint order like canvas elements, the spec and the paint preset. A map keyed by id rather than an array, because array paths are positional in the op log: two clients adding a chart at once land on the same index, and a delete shifts a peer's edit onto the wrong chart. The map is materialized on every sheet wherever a sheet enters a consumer, in `withNormalizedSheet` beside `images`, because a base less materialized than the writer makes the first chart's `add` fail to resolve and the whole batch roll back ([SHEETS.md](../SHEETS.md), `calcChain` and `images` are the same case). The snapshot codec encodes the key explicitly and omits it when empty, as it does for `images`. No backwards compatibility is owed for sheets, so no migration either.

**Writes.** Charts are written in immer recipes through `ctx.sheets[i].charts` directly, one recipe per insert, move, resize, edit or delete, so collab and undo come from the existing op pipeline. They do not copy the `insertedImgs` context mirror, which exists only because fortune-sheet had it. A spec edit replaces that chart's `spec` as one value: two people editing the same chart's settings at once resolve last-writer-wins for that chart, the same limit rich text boxes have. The chart editor records the spec it started from and, on Apply, offers reload or overwrite when a peer changed it meanwhile.

**Structural edits.** `applyInsert` and `applyDelete` in `engine/rowcol.ts` shift every `CellRangeRef` in every sheet's charts whose `sheetId` is the edited sheet, in the same pass that shifts cross-sheet formulas. The range math is the one already written inline for conditional-format ranges, extracted into one `shiftRangeForInsert`/`shiftRangeForDelete` pair that both callers use. The rules follow Excel: an insert before a range moves it, an insert inside it grows it, an insert right after it does nothing; a delete shrinks it, and deleting all of it sets that ref to `null`, which draws as a "#REF" diagnostic, not a guess. Because the shift is inside the recipe, undo inverts it, and because the same function runs in `replaySheetsOps`, a joiner and a peer land on the same refs. A sort moves cell values under a fixed range, so the chart follows the values' new positions, as in Excel. Deleting the source sheet leaves an unresolved ref and a visible diagnostic.

**Updates.** A sheets chart has no cached values. It resolves from the materialized workbook on every render, memoized on the chart record and the revision of the sheets it reads, so a formula recalc, a peer's edit, an undo or a paste all show up on the next frame with no invalidation list to maintain. On the server, `readSheetsFromDoc` already returns every sheet with `data` materialized, so the preview and the export resolve the same way; the preview renders stored values and never recalcs, like the grid beside it.

**Editor.** An overlay beside `ImgBoxs`, using `ObjectTransform` at the same z-index scheme, draws each chart's SVG from `renderChartSvg`. "Insert chart" takes the selection, applies the Excel rules above and creates range data with one ref per series; the chart editor offers type, title, series, "switch rows and columns", legend, axes and colors. Double-click opens it.

**Output.** The HTML/PDF export and the preview draw charts in the same overlay as `renderFloatingImages`, at the stored box, clipped to the preview window like an image. The export takes the resolved SVG inline, so WeasyPrint draws vectors and text. xlsx export is § xlsx export.

### xlsx import

The importer reads charts straight from the zip it already holds, in the same Worker, after ExcelJS has produced the sheets (so sheet ids exist and names resolve). It parses the drawing and chart parts with `fast-xml-parser`, already an `apps/api` dependency (WebDAV, CardDAV), because chart XML is nested far deeper than the flat tags the hyperlink regex handles. The path is: sheet rels → drawing part → each anchor's `graphicFrame` → drawing rels → chart part. The same walk also finds `xdr:pic` anchors; importing floating images through `worksheet.getImages()` belongs next to it and should ship in the same phase.

| DrawingML | Maps to | Notes |
|---|---|---|
| `lineChart` | `line` | `c:marker` symbol → `markers` (every symbol draws as a circle); `c:smooth` → `curved` |
| `barChart` with `barDir="col"`, `grouping` clustered or stacked | `bar`, `stacking` | `gapWidth`/`overlap` → band padding defaults |
| `areaChart`, standard or stacked | `area`, `stacking` | The inspected file needs this, which is why `area` and `stacked` enter the model with import rather than later |
| `pieChart`, `varyColors` | `pie` | Slice colors from `c:dPt` → `pointFills` keyed `#index` |
| `bar3DChart`, `line3DChart`, `pie3DChart`, `area3DChart` | The 2D type | Flattened; the import notes it |
| `c:ser` `c:tx`, `c:cat`, `c:val` | Series name, categories, values as `CellRangeRef` | Sheet names resolve through the imported sheets. A multi-level category ref uses its innermost level |
| Refs to another workbook (`[1]Sheet1!A1`) | Inline data from the cache | Empty cache → placeholder |
| `c:spPr` fill and line: `srgbClr`, `schemeClr` + `lumMod`/`lumOff`, `alpha` | `fill` | Through the importer's theme palette (`extractThemePalette`, `applyTint`), plus `lumMod`/`lumOff`. No color → the theme accents in order, as Excel does |
| `c:title` (rich text or a cell ref), `c:autoTitleDeleted` | `title` | Runs flattened to text. A single-series chart without a title gets the series name, as Excel does |
| Value axis `c:scaling` min and max, `c:majorGridlines`, `c:numFmt`, `c:title` | `valueAxis` | `sourceLinked="1"` → `format: null` |
| `c:legend` / `c:legendPos`, `c:plotVisOnly`, `c:dispBlanksAs` | `legend`, `plotHidden`, `blanks` | |
| Theme fonts (`+mn-lt`) and explicit `a:latin` | `paint.fontFamily` | Through the importer's `mapToSupportedFont` |
| `twoCellAnchor`, `oneCellAnchor`, `absoluteAnchor` | `x`, `y`, `width`, `height` | Cell position from the imported `columnlen`/`rowlen` (or the defaults) plus the EMU offset ÷ 9525 |

**Not in the first release**, each imported as a placeholder chart that keeps the anchor, the title and the type name and says "This chart type is not supported yet": `scatterChart`, `bubbleChart`, `radarChart`, `stockChart`, `surfaceChart`, `doughnutChart`, `ofPieChart`, horizontal bars (`barDir="bar"`), percent stacking, more than one chart group in a plot area (combo charts), secondary axes, logarithmic or reversed axes, date axes with a time scale, data labels (`c:dLbls`), trendlines, error bars, `cx:` charts and chart sheets. A placeholder beats a chart that draws the wrong thing. Placeholders are not written back on export, and the export says so. Doughnut, horizontal bars and data labels are cheap follow-ups and the first candidates.

Limits apply at import as everywhere (§ Limits); a chart over them imports as a placeholder with the reason.

### xlsx export

ExcelJS cannot write charts, so the exporter writes them in a JSZip pass after `writeBuffer`, beside `rewriteInternalHyperlinks`:

- a `xl/charts/chartN.xml` per chart, from a DrawingML writer that is the importer's mapping in reverse;
- a drawing part per sheet with one `twoCellAnchor editAs="oneCell"` per chart, the cell and EMU offset computed from the pixel box and the sheet's column widths and row heights. When floating-image export lands through ExcelJS's `addImage`, the chart anchors are added into ExcelJS's own drawing part, because a sheet has exactly one `<drawing>`;
- the rels, the `<drawing r:id>` element in the sheet XML at its schema position (after page setup, before `legacyDrawing`, `tableParts` and `extLst`), and the content-type overrides.

Range data is written as A1 formulas with quoted sheet names, plus `numCache` and `strCache` filled from the resolved values, so viewers that do not recompute (Quick Look, some mobile apps) show data; Excel and Google Sheets read the refs. Inline data in a sheet is written as `c:numLit`/`c:strLit`. Colors are written as `srgbClr` with `alpha`. The round-trip test is import, export, import again and compare specs; manual verification opens the file in Excel, LibreOffice and Google Sheets.

### Vector and slides

The chart is a kind: `'chart'` in `VectorElementType` and `VectorBindableElement`, `kinds/chart.ts` with `defineKind`, one `ELEMENT_KIND_UI` entry, the patch surface in `use-canvas-doc.ts`, and the registry completeness tests. The spec rides one JSON scalar field, `chart`, validated in the kind's `read` like `points` or `fill`. Capabilities: `creation: 'none'` (inserted from the Insert menu, like an image), `bindable: true`, `silhouette: 'box'`, `fill` (the background), `strokeStyle`, `corners`. `searchText` returns the title, series names and category labels. One chart is one selection, comment and z-order object. Pasting tab-, comma- or semicolon-separated text onto a canvas creates a chart through the ported Excalidraw parser. Slides get all of it through the shared engine; a new chart takes the host's style table (`VECTOR_STYLE_DEFAULTS` or `SLIDES_STYLE_DEFAULTS`).

A chart counts toward the preview's 500-element cap as one element, but its marks count against a per-chart cap (§ Limits), so one chart is not a way around the budget.

### Arrows attached to marks

Phase 1 ships the identity (series ids and category ids allocated once and never rebuilt), so every chart made from the start is a valid target. The docking arrives in phase 5 without a migration.

**The binding grows one optional field.** `Binding = { elementId, fixedPoint, mark?: ChartMarkRef }`. The chart stays `elementId`, so `arrowsBoundTo` and every element-level rule keep working. `boundEndpoint` uses three things from its target: a box for `fixedPoint`, an `outline(inflate)` and a gap policy. A mark has all three at a smaller scale, so a `DockTarget = { box, outline(inflate), silhouette }` is derived either from the element (today's behavior, unchanged) or from a resolved mark, and `boundEndpoint`, `followBindings`, `elbowAnchorScene`, the aim lines and the elbow router's obstacles take a `DockTarget`. One docking algorithm, one gap policy, one set of tests. A bar's local box is oriented from baseline (`v = 1`) to value end (`v = 0`), so `[0.5, 0]` stays the value end when the value turns negative.

**The kind seam.** `KindSpec` gains two optional members: `dockTargets(el)` for every current mark and `dockTarget(el, mark)` to resolve one reference or return `null`. Other kinds omit both. `OutlineShape` gains `sector` (center, radii, start and end angle) with path, containment and intersection in `outline.ts`, so an arrow meets the wedge the user sees. Bars are `rounded`, points are `ellipse`.

| Mark | Default `fixedPoint` | Outline |
|---|---|---|
| Bar | Value-end center `[0.5, 0]` | `rounded` |
| Pie slice | Outer arc at the middle angle | `sector` |
| Line point | Marker center; docking backs off to the marker's edge | `ellipse` |
| Area point | The top of the stacked value at that category | `ellipse` of marker size |

**Lifecycle.** `parseBinding` accepts `mark`; an unresolvable mark is kept, not dropped. Hover highlights the mark and shows its label and value; Ctrl or Cmd still suppresses binding. An elbow arrow uses the mark's box as its obstacle and heading source, and the chart's own box does not block a way in to an inner mark. `sameRouteContext` includes the chart's `chart` field and box for any arrow with a `mark`. Previews, exports and `FrameView` resolve mark endpoints from the current data through the same pure pass; stored points are the fallback, never authoritative over a resolved mark. Duplicate and paste remap the element id and keep series and category ids; `planElementsPaste` already collects the remaps.

**Missing targets.** Deleting a category or series, a `null` value or a zero slice makes a reference unresolvable. The arrow keeps the reference and its last endpoint, shows an unresolved marker, and offers reattach or detach. It never retargets to whatever is now at the old position, a matching label or the whole chart. Undo that restores the id resolves it again.

### Docs

A `ChartNode` beside `FigureNode` in `packages/lib/src/docs/eigendoc/nodes/`, with the same inline-atom shape and the same `layout`, `width` and `alignment` attributes, so every figure placement rule applies unchanged. The spec and the paint ride node attributes. The app node view reuses the figure view's `ObjectTransform` shell. `renderChartNode` sits beside `renderFigureNode` and serves both export and preview; `collectProseMirrorText` picks up the chart's text once the node exposes it. HTML serialization and parsing are tested so the node survives the server schema and the sanitizer.

### Previews and exports

| Surface | Vector, slides | Sheets | Docs |
|---|---|---|---|
| Live | The kind's `render` | Overlay SVG beside `ImgBoxs` | Node view |
| Server preview | The compositor, as any element | Floating overlay in `renderSheetsPreviewHtml`, stored values, no recalc | `renderChartNode` in the eigendoc preview |
| HTML, PDF | Inline SVG through the compositor; WeasyPrint draws it | Inline SVG in the floating overlay | Inline SVG in the figure wrapper |
| SVG | Native (`sceneToSvg`) | Not offered | Not offered |
| DOCX | Not offered | Not offered | `<img>` with an SVG data URI; html-to-docx converts it (phase 6 checks label fonts in the sharp rasterization, and falls back to the native `svgBlip` embed if they fail) |
| xlsx | Not offered | Native chart parts (§ xlsx export) | Not offered |

**Clipboard.** A canvas chart, alone or with bound arrows, rides the existing typed `elements` item through `readElementsClipboardItem`. Docs and sheets read and write a chart from that same item, never a second chart flavor. A sheets chart copied out is resolved to inline data first. "Copy as SVG" is derived output under [CLIPBOARD.md](../CLIPBOARD.md)'s flavor rules.

### Limits and validation

One table in `packages/lib/src/charts/limits.ts`, enforced by the chart editor, every reader (canvas, sheets codec, docs node) and the xlsx importer, so a hostile peer, clipboard or file meets it. Provisional values: 64 KiB per stored spec, 32 series, 2,000 points per series, 2,000 marks per chart, 200 charts per workbook, 16 KiB of label text per chart. A range longer than the point cap is rejected with a message, never sampled. roughjs work is bounded before drawing, by the mark cap, not by an output size check after generating a million hatch lines. Stored and pasted specs are untrusted: the validator checks the version, the type, finite numbers, unique ids, refs inside the sheet bounds, and colors through `isColorToken`; every label is escaped.

## Rulings and decisions to approve

Rulings that apply: **no backwards compatibility for sheets** (Reinder, 2026-09-03), so `charts` enters the snapshot without a migration. The `.eigenvector` shape is not frozen ([ROADMAP.md](../ROADMAP.md)) and slides carry the same no-backwards-compatibility ruling ([SLIDES.md](../SLIDES.md)), so the `chart` kind needs no migration either.

Decisions this proposal asks for:

1. One `ChartSpec`, series-first, with inline data for vector, slides and docs and range data for sheets.
2. `CellRangeRef` keyed by sheet id, shifted in `engine/rowcol.ts` beside formulas; no cached values in sheets.
3. `d3-scale` and `d3-shape`, subject to the phase 0 measurement; no Vega, no Recharts.
4. Placeholders for unsupported xlsx chart types rather than a best-effort drawing.
5. `mark` as an optional field on the existing binding, with `DockTarget` replacing the element in the docking functions.
6. Charts in docs and sheets without arrows in the first release.

## Phasing

Each phase ships on its own.

0. **Prototype and cleanup (S).** Delete `chart_selection`. Bar, line and pie through `layoutChart` and the painter, in the browser and in a real Bun Worker. Gate: identical SVG from both, the advance-width table in place, seeds stable under reorder, the measured cost of `d3-scale` and `d3-shape` against inline math.
1. **Canvas charts (M).** The kind, inline data, bar, line and pie, the chart editor with its data grid and "View data", Insert-menu and paste-text creation in vector and slides, preview and export through the existing compositor. Existing shape SVG stays byte-identical.
2. **Sheets charts (M).** `charts` on the sheet and in the codec and replay base, range data and the engine resolver, the range shift extracted from the conditional-format code, the overlay, "Insert chart" from a selection, HTML/PDF export and preview. `area` and `stacking` join the model here.
3. **xlsx import (M).** The drawing and chart reader, the mapping table, anchors, theme colors, placeholders, the fixtures in § What an xlsx chart carries. Floating-image import alongside (S).
4. **xlsx export (M).** The DrawingML writer and the zip pass, pixel box to anchor, caches, and the import-export-import round-trip tests. The floating-image export ROADMAP row is best done in the same phase, since both write the sheet's one drawing part.
5. **Arrows to marks (M).** `DockTarget`, the `sector` outline, the kind seam, the lifecycle and missing-target states; read-only output resolves the same endpoints.
6. **Docs charts (M).** `ChartNode`, its view, export and preview, DOCX through the SVG image path, cross-app copy.

Later, each its own decision: doughnut, horizontal bars and data labels (S each); scatter and time axes (M); combo charts and secondary axes (M); live links from a canvas or doc to another document's sheet range (L: a permission-checked refresh through the Drive ACL wrapper and the Home relay, and a key column for category identity before arrows can follow records); embedded canvas scenes in docs and sheets for annotated charts (its own proposal); "Convert to shapes".

## Testing

Tests follow the workspace layout: chart model, layout and binding contracts under `packages/lib/src/test/`, range shifting and the resolver under `packages/sheet/src/test/`, import, export and preview routes under `apps/api/src/test/`.

1. **Paint parity.** An isolated bar or marker matches the equivalent rectangle or ellipse element across fill styles, gradients, stroke styles, roughness and corners.
2. **Determinism.** Reload, reorder, duplicate, thumbnail and export give the same SVG up to scoped ids; the browser and the Worker agree.
3. **Ranges.** Insert and delete rows and columns before, inside, at the edge of and after a range, on the chart's sheet and on another sheet; delete a whole range; delete and rename the source sheet; sort inside the range; undo each; replay the ops from the snapshot and compare with the live result.
4. **Live data.** A formula feeding a series recalcs; a peer's edit, an undo and a paste all redraw; hidden and filtered rows follow `plotHidden`.
5. **xlsx.** Each fixture imports with the right types, refs, colors and anchors; unsupported charts become placeholders; import, export, import is stable; the exported files open in Excel, LibreOffice and Google Sheets.
6. **Attachment.** Rename and reorder categories and series, flip a bar negative or zero, change pie proportions: every arrow still names the same series and category and meets the intended mark; deleted targets show the unresolved state and never retarget.
7. **Formats.** Open the real SVG, HTML, PDF and DOCX output and check presence, labels, hatches, gradients and arrow endpoints.
8. **Limits.** Oversized ranges, hostile ids, labels and colors, and a malformed chart part produce a bounded placeholder or a clear rejection without losing the stored chart.

Work runs by [WORKING-METHOD.md](../WORKING-METHOD.md), with browser verification of each app and real-consumer checks of every output format.

## Evidence

- Canvas engine: `packages/lib/src/vector/kinds/kind.ts` (`KindSpec`, `Capabilities`, `defineKind`, `VECTOR_STYLE_DEFAULTS`, `SLIDES_STYLE_DEFAULTS`), `kinds/render-utils.ts`, `kinds/arrow-render.ts`, `types.ts` (`Binding`, `parseBinding`, `VectorElementBase`), `geometry.ts` (`boundEndpoint`, `followBindings`, `anchorToScene`, `elbowAnchorScene`), `outline.ts` (`OutlineShape`), `font-metrics.ts`, `packages/ui/src/components/vector/element-layer.tsx` (`sameRouteContext`), `text-measure.ts`, `apps/api/src/lib/preview/preview-scene.ts` (`PREVIEW_MAX_ELEMENTS` = 500).
- Sheets: `packages/lib/src/sheets/types.ts` (`SheetImage`, `SingleRange`), `snapshot-codec.ts`, `packages/sheet/src/engine/rowcol.ts` (`applyInsert`, `applyDelete`, `shiftFormulasAcrossSheets`), `engine/formula-shift.ts` (`functionStrChange`), `engine/cell-resolver.ts` (`createArrayResolver`), `engine/a1-notation.ts` (`parseA1Range`), `engine/replay-ops.ts` (`withNormalizedSheet`), `state/utils/patch.ts` (`sheetMetadataOps`, the `insertedImgs` case in `opToPatch`), `state/modules/sheet.ts` (`editSheetName`), `state/context.ts` (`chart_selection`), `components/ImgBoxs/index.tsx`.
- Import and export: `apps/api/src/lib/import/sheets/from-xlsx.ts` (`xlsxToSheets`, `readLocationHyperlinks`, `extractThemePalette`, `applyTint`, `mapToSupportedFont`), `apps/api/src/lib/export/sheets/to-xlsx.ts` (`rewriteInternalHyperlinks`), `export/sheets/render.ts` (`renderFloatingImages`, `renderSheetsPreviewHtml`), ExcelJS 4.4.0 `lib/xlsx/xform/drawing/` (picture anchors only, no chart xform), `@turbodocx/html-to-docx` 1.22.2 (`svgHandling: 'convert'` default, `asvg:svgBlip`).
- Docs: `packages/lib/src/docs/eigendoc/nodes/figure.ts`, `apps/api/src/lib/export/doc/render.ts` (`renderFigureNode`), `apps/docs/src/components/docs/extensions/figure.tsx`.
- xlsx chart structure: a 16-sheet workbook exported by Google Sheets, inspected 2026-09-22: `xl/drawings/drawing1.xml` (three `oneCellAnchor` graphic frames), `xl/charts/chart1.xml` to `chart3.xml` (two `lineChart`, one stacked `areaChart`; series refs to `'MASTER DATA'` rows; empty `c:numCache`; `srgbClr` with `alpha`; legend top; `plotVisOnly`).
- Excalidraw charts: `packages/excalidraw/charts/charts.parse.ts` (`tryParseNumber`, `tryParseCells`, `tryParseSpreadsheet`), `charts.constants.ts`, `charts.helpers.ts` (`getSeriesColors`, `getColorOffset`), `charts.bar.ts` (the `Math.max(0, value)` clamp), `tests/charts.test.tsx`.
