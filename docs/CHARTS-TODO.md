# Charts: TODO

This is the backlog for chart kinds and chart features: what Office files hold that Eigen can't draw yet, in the order to add it, and where Eigen draws a chart it does read unlike Office or Google. [CHARTS.md](CHARTS.md) describes how charts work today. Chart bugs and the storage work are in [ROADMAP.md](ROADMAP.md).

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
| 11 | **Dash, hatch and gradient in a written chart's `c:spPr`** | S–M | `writeChart` writes solid fills and lines only, so a chart's dashed stroke and hatch draw plain in Excel, Word and PowerPoint, and a gradient background goes as its middle color. DrawingML holds each: `a:prstDash`, `a:pattFill` and `a:gradFill`. Map them in `writeChart` and `readChartPartLook`, so all three formats gain them together ([ROADMAP.md](ROADMAP.md), Office charts: the look and Edit Data). The sketch has no equivalent. |
| 12 | **A pie's radius is sized from labels it then hides** | S | `layoutPie` (`packages/lib/src/charts/pie.ts`) shrinks the radius until every label of a slice of 5% or more fits the frame, and only then hides the labels that touch one placed before them. So a hidden label can still make the pie smaller. Size the radius from the labels that show, or let row 1's spread decide which show first. |
| 12 | **The other chartex kinds**: box and whisker, funnel, treemap, sunburst, region map | 5, 4, 3, 3, 1 | L each | A new layout each. |
| 13 | **Stock, surface** | 3 (docx), 4 | M each | |

A new field should nest inside a part the spec already stores, a per-series field in its series and a per-chart one in its axis, so a tab on an older build keeps it.

## Lost without a note

These ride on charts Eigen does read, and the import drops them silently. Each needs drawing or a counted import warning.

- **Data tables** (`c:dTable`): 4 files.
- **Error bars**: 2 files.
- **Data labels**: `c:dLbls` appears in 302 files, but Excel writes it even when every label is off. Count the files where a label shows (`c:showVal` or `c:showPercent` at 1) before ranking it; it could be the widest gap of all.
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
| 11 | **Dash, hatch and gradient in a written chart's `c:spPr`** | S–M | `writeChart` writes solid fills and lines only, so a chart's dashed stroke and hatch draw plain in Excel, and a gradient background draws none. DrawingML holds each: `a:prstDash`, `a:pattFill` and `a:gradFill`. Map them for xlsx now, and for docx and pptx with their chart parts ([ROADMAP.md](ROADMAP.md), Write charts to Office files as charts). The sketch has no equivalent. |

## Measuring

The gate summaries (`apps/api/src/scripts/{xlsx,docx,pptx}-audit.ts roundtrip`) don't count a chart that was not imported, so the gap above is only visible from a corpus scan. The pptx corpus alone holds about 234 charts the import drops. A counted `charts-not-imported` row in each summary would track this list.
