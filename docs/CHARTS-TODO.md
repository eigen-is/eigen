# Charts: TODO

This is the backlog for chart kinds and chart features: what Office files hold that Eigen can't draw yet, in the order to add it. [CHARTS.md](CHARTS.md) describes how charts work today. Chart bugs and the storage work are in [ROADMAP.md](ROADMAP.md).

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
| 11 | **Histogram and Pareto** (chartex) | 7 (7 / 0 / 0) | M | On the `cx:` reader from 10. |
| 12 | **The other chartex kinds**: box and whisker, funnel, treemap, sunburst, region map | 5, 4, 3, 3, 1 | L each | A new layout each. |
| 13 | **Stock, surface** | 3 (docx), 4 | M each | |

A new field should nest inside a part the spec already stores, a per-series field in its series and a per-chart one in its axis, so a tab on an older build keeps it.

## Lost without a note

These ride on charts Eigen does read, and the import drops them silently. Each needs drawing or a counted import warning.

- **Data tables** (`c:dTable`): 4 files.
- **Error bars**: 2 files.
- **Data labels**: `c:dLbls` appears in 302 files, but Excel writes it even when every label is off. Count the files where a label shows (`c:showVal` or `c:showPercent` at 1) before ranking it; it could be the widest gap of all.
- **Date axis** (`c:dateAx`): 26 files, read as a category axis. Check whether the spacing between dates matters in those files.

## Measuring

The gate summaries (`apps/api/src/scripts/{xlsx,docx,pptx}-audit.ts roundtrip`) don't count a chart that was not imported, so the gap above is only visible from a corpus scan. The pptx corpus alone holds about 234 charts the import drops. A counted `charts-not-imported` row in each summary would track this list.
