# Charts: TODO

This is the backlog for chart kinds and chart features: what Office files hold that Eigen can't draw yet, in the order to add it, and where Eigen draws a chart it does read unlike Office or Google. [CHARTS.md](CHARTS.md) describes how charts work today. Data-loss bugs and work shared across apps are in [ROADMAP.md](ROADMAP.md).

Eigen draws four kinds: column, bar, line and pie, with column and bar stacked or 100% stacked. `readChart` (`apps/api/src/lib/ooxml/ooxml-chart.ts`) reads 3-D bar, line and pie flat, and brings every other chart in as "<Name> chart not imported" with its title. That includes a combo, a second value axis, a log or reversed value axis and a stacked line. A chartex part (`cx:`, Excel 2016's waterfall, treemap and the rest) has no reader at all.

## Order to add them

Ranked by how many corpus files hold one (xlsx, docx and pptx together; files, not charts, so one file with 200 charts doesn't decide). The corpus is public sample files: gov.uk statistics plus the POI, LibreOffice, ClosedXML and docling test sets. Test sets over-represent odd kinds, so read the counts as a rough guide.

| # | What | Files (xlsx / docx / pptx) | Effort | Notes |
|---|---|---|---|---|
| 1 | **Second value axis and combo** (column plus line is the usual pair) | 52 with a second axis (33 / 7 / 12), 34 with a combo (21 / 5 / 8) | L | Not a new renderer: a per-series plot type and a per-series axis in the layout. Today these charts are dropped whole, so this brings back the most charts. |
| 2 | **Scatter** | 32 (18 / 4 / 10) | M | A new kind with a numeric x axis; the line renderer and its ticks carry over. |
| 3 | **Area**, plain, stacked and 100% | 18 (11 / 3 / 4) | S | A line filled to its baseline, on the stacking column and bar already have. |
| 4 | **Doughnut** | 6 (2 / 1 / 3) | S | A pie with an inner radius. |
| 5 | **Bubble** | 9 (3 / 0 / 6) | S | Scatter plus a size per point, once scatter is in. |
| 6 | **Radar** | 9 (3 / 2 / 4) | M | A new polar layout. |
| 7 | **Trendline** | 5 (4 / 0 / 1) | S | A linear fit, once scatter is in. Lost without a note today. |
| 8 | **Stacked and 100% line** | 3 (2 / 0 / 1) | S | The stacking the bars have. |
| 9 | **Pie of pie, bar of pie** | 6 (5 / 1 / 0) | M | |
| 10 | **Waterfall** (chartex) | 7 (1 / 4 / 2) | M | A stacked column with an invisible base, plus the first `cx:` reader. |
| 11 | **The other chartex kinds**: box and whisker, funnel, treemap, sunburst, region map | 5, 4, 3, 3, 1 | L each | A new layout each. |
| 12 | **Stock, surface** | 3 (docx), 4 | M each | |

A new field should nest inside a part the spec already stores, a per-series field in its series and a per-chart one in its axis, so a tab on an older build keeps it.

## Lost without a note

These ride on charts Eigen does read, and the import drops them silently. Each needs drawing or a counted import warning.

- **Data tables** (`c:dTable`): 4 files.
- **Error bars**: 2 files.
- **Data labels, per point**: a point's own `c:dLbl` is not read, so a nudged label (291 points in the corpus carry a `c:layout`), a custom text (about 40) and a deleted one (10, in 7 parts) read as their series' label. One gov.uk part shows labels only through per-point `c:dLbl showVal=1` under a series `showVal=0`, and reads as unlabelled.
- **Data labels, their position, format and text style**: the position is derived from the kind, so 13 imported clustered series at `inEnd` or `inBase` and 31 gov.uk stacked series at `inBase` draw at Eigen's position. A label's own `c:numFmt` (31 parts) reads as the values' format, and its `c:txPr` (492 labelled series, often white text inside dark segments) as the chart's label color, so the gov.uk 100% stacks draw dark text on the palette's dark accents. A `labels.position` key, and a label color that contrasts with its segment, which lib has no helper for yet, would close these.
- **Date axis** (`c:dateAx`): 26 files, read as a category axis. Check whether the spacing between dates matters in those files.

## Drawing as Office and Google do

Ranked by what a user notices, from a study of how ECharts, Chart.js, Plotly, Vega, Highcharts, LibreOffice and Excel draw ([CHART-DRAWING-RESEARCH.md](CHART-DRAWING-RESEARCH.md)).

| # | What | Effort | Notes |
|---|---|---|---|
| 1 | **Pie labels spread with leader lines** | M | Today a label that would touch one placed before it hides, and a slice under 5% has none (`layoutPie`, `packages/lib/src/charts/pie.ts`). Split the labels into left and right halves, spread each half one line apart within the frame, and draw a two-segment leader from the arc to each moved label, as ECharts' `shiftLayoutOnXY` and Highcharts' `distribute` do. |
| 2 | **Bar gap and overlap** | S–M | The spec has no gap or overlap, so a category's bars always fill Google's 61.8% of its band, the reader drops `c:gapWidth` and `c:overlap`, and the writer writes a gap of 150 (`apps/api/src/lib/ooxml/ooxml-chart-writer.ts`): an xlsx chart round-trips with bars wider than Excel drew them, and Excel opens Eigen's export at its 40%. Add both to `plots.column` and `plots.bar` in Excel's percent units, read and write them, and size the slot by LibreOffice's `band / (n + gap + overlap·(n−1))`, a chart that stores neither keeping 61.8%. |
| 3 | **Text widths outside Latin-1** | S | `measureLabel` has advances for Basic Latin and Latin-1 only, and every other character measures about one em, so a Cyrillic or Greek name reserves about 60% too much (`Москва` 5.96 em against Inter's 3.74) and turns, ellipsizes or drops a legend entry early. Extend `TEXT_WIDTH_RANGES` (`packages/lib/src/vector/text-width.ts`) and `apps/api/src/scripts/chart-text-widths.ts` to Latin Extended-A, Greek, Cyrillic, General Punctuation (`…`, `–`, curly quotes) and currency symbols, which the bundled fonts carry. The layout's own ellipsis then measures right too. |
| 4 | **Hover tooltips** | M | A chart's hit test is its box, so no app shows a value under the pointer. The layout's shape ids already name the series and point (`bar:<series>:<index>`, `marker:…`, `slice:0:<index>`): hit-test bars and slices by containment and line points within a few pixels, and show series, category and value. Sheets first, as Google Sheets shows them. |
| 5 | **`#N/A` draws through a line, as Excel's does** | S | `resolveRangeChartData` (`packages/sheet/src/engine/chart-data.ts`) reads every cell that isn't a number as blank, errors included, so `#N/A` breaks a line under the gap setting. Excel bridges `#N/A` in line, scatter and radar charts whatever its blanks setting, and users put `NA()` in a cell for exactly that. Mark `#N/A` apart from a blank and read `c16r3:dispNaAsBlank`, which turns it off. |
| 6 | **Category labels wrap before they turn** | M | Names that don't fit their band turn -45° and ellipsize; Highcharts, LibreOffice and Google wrap them to a second line first. Break at spaces into the band, two lines at most, and turn only when two lines don't fit. |
| 7 | **Headroom above the tallest bar** | S | A column of 95, 98 and 100 ends on the top gridline, as Google's does. Excel, LibreOffice, Highcharts and Plotly add a step when the data fills over 20/21 of the axis. |
| 8 | **A pinned min gets its own label** | S | A min of 3 ticks at 20, 40 and on, with no label at 3. Excel steps from the min, and Chart.js labels a pinned end (`includeBounds`). A pinned max also decides Excel's zero rule for a line (data of 90 to 100 under a max of 200 ticks from 0 in Excel, from 90 in Eigen). |
| 9 | **A sheet chart's ticks never repeat a label** | S | A sheet chart formats ticks with the cell format and ignores the step, so an integer format over a 0.5 step reads `0 1 1 2 2`. Ask for fewer ticks while two neighbours format alike, as LibreOffice does (tdf#48041). |
| 10 | **Read `c:firstSliceAng`** | S | An Excel pie turned by it draws from 12 o'clock (2 of 48 test-file pies). One number on `plots.pie`, drawn by the start angle `layoutPie` already takes. |
| 11 | **Dash, hatch and gradient in a written chart's `c:spPr`** | S–M | `writeChart` writes solid fills and lines only, so a chart's dashed stroke and hatch draw plain in Excel, Word and PowerPoint, and a gradient background goes as its middle color. DrawingML holds each: `a:prstDash`, `a:pattFill` and `a:gradFill`. Map them in `writeChart` and `readChartPartLook`, so all three formats gain them together ([Office round trip](#editing-and-the-office-round-trip)). The sketch has no equivalent. |
| 12 | **A pie's radius is sized from labels it then hides** | S | `layoutPie` (`packages/lib/src/charts/pie.ts`) shrinks the radius until every label of a slice of 5% or more fits the frame, and only then hides the labels that touch one placed before them. So a hidden label can still make the pie smaller. Size the radius from the labels that show, or let row 1's spread decide which show first. |

## Editing and the Office round trip

- **Edit data: embed the Sheets grid** (M–L (about 4–5 days)): The chart Edit data dialog is its own grid in Sheets' look and keys (`packages/ui/src/components/charts/chart-data-dialog.tsx`, [CHARTS.md](CHARTS.md#edit-data-looks-and-types-like-eigen-sheets)): a second keyboard model with no undo, fill handle, column resize or formulas. A probe that mounted a one-sheet Workbook in the dialog worked. First: the keystroke after a Delete is dropped inside the Radix dialog (likely its focus trap against `cellInput.focus()`; no root cause yet). The sheet's module-global copy state (`state/modules/clipboard.ts`, `selectionCache`) and `document` listeners let the main grid take the dialog's copy. Escape mid-edit closes the dialog until `WorkbookInstance` answers `isEditing()`. On Save only numbers and labels survive: formulas flatten, and formats, filters, images and comments go. The cell menu needs an allow-list; touch is unverified. [PROPOSAL_CHART_SHEETS.md](proposals/PROPOSAL_CHART_SHEETS.md) builds on this: a sheet of its own per chart, inside the document, so formulas stay.

- **Office charts: Edit Data and line width** ([CHARTS.md](CHARTS.md#a-docx-or-pptx-chart-carries-its-numbers-in-a-workbook-of-its-own)) (S–M): Edit Data on a docx or pptx chart is unverified in desktop Word, PowerPoint and Office for the web. Open an exported doc and deck with every chart kind in desktop Office: each draws, and Edit Data opens and redraws. Add a Series width row in `PaintSections` for line charts. Hatch, gradient and dash are row 11 of [Drawing as Office and Google do](#drawing-as-office-and-google-do).

- **Skip hidden rows and columns (Excel/Google default)** (S–M): `resolveRangeChartData` (`packages/sheet/src/engine/chart-data.ts`) plots hidden rows and columns, so a chart over a filtered table shows the filtered-out rows. Skip what `config.rowhidden` and `colhidden` hide, with a spec field (Excel's `c:plotVisOnly`) carried by the chart panel's Setup and the xlsx writer. The help-center article says hidden cells are included for now.

## Measuring

The gate summaries (`apps/api/src/scripts/{xlsx,docx,pptx}-audit.ts roundtrip`) don't count a chart that was not imported, so the gap above is only visible from a corpus scan. The pptx corpus alone holds about 234 charts the import drops. A counted `charts-not-imported` row in each summary would track this list.
