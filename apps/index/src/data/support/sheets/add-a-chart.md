---
title: "Add a chart to a spreadsheet"
description: "Turn a range of cells into a column, bar, line, or pie chart that updates when the cells change."
type: how-to
tags: [sheets, charts, graphs]
related: [sheets/get-started, sheets/export-spreadsheet]
order: 147
updated: 2026-10-23
---

You can turn a table of numbers into a chart that floats over the grid. The chart reads its cells, so it changes as soon as you change a value.

## Add a chart

1. Select the cells you want to chart, including the row of names at the top and the column of labels on the left. If you select a single cell, Sheets charts the whole table around it.
2. Open the **Insert** menu and click **Chart**.

A column chart appears below the cells, and the **Chart editor** opens on the right. Sheets reads your table the way most charts are laid out:

- Text in the first row and the first column is read as names, not values.
- Each column of numbers becomes a series, named by the text above it. When the table has more columns than rows, each row becomes a series instead, named by the text on its left.
- The series names make the chart title.

A chart holds up to 32 series and 2,000 values. Hidden rows and columns are included in the chart for now.

## Change the data and the look

The **Chart editor** opens whenever you double-click a chart. Under **Setup**:

- **Data range** shows the cells the chart reads, such as `A1:D10`. Type a new range and press Enter to chart other cells. To chart cells on another tab, put the tab name in front, such as `'Sales 2026'!A1:D10`.
- **Switch rows/columns** turns each row into a series instead of each column.
- **Use row 1 as headers** and **Use column A as labels** say whether the first row and column hold names or values.

Below that you pick the chart's **Type** (**Bar**, **Column**, **Line**, or **Pie**), its **Stacking** (**None**, **Standard** or **100%**), **Title**, **Legend** and **Font**, the axis titles, whether each axis shows (**Show axis**), whether the category axis runs the other way (**Reverse axis order**), the lowest and highest value on the value axis (a percent on a **100%** stack, and automatic again when you switch to or from **100%**), the gridlines, and a color for each series or pie slice, which reads **Automatic** until you pick one.

Click a cell to close the editor.

## Move, resize, and remove a chart

Click a chart to select it. Drag it to move it, or drag a handle on its frame to resize it. Press Delete to remove the selected chart.

Hover over a chart and click the three dots in its top-right corner for its menu:

- **Edit the chart** opens the **Chart editor**.
- **Delete chart** removes it.
- **Download chart** → **SVG (.svg)** saves the chart as a picture. This works with view access too.

## Copy a chart

Select a chart and press **Ctrl+C** (Mac: **⌘C**) to copy it, or **Ctrl+X** (Mac: **⌘X**) to cut it. Cutting copies the chart and removes it. A chart that shows `#REF!` or **Too much data for a chart** can't be copied.

Paste it with **Ctrl+V** (Mac: **⌘V**):

- **In the same spreadsheet**, the copy reads the same cells as the original, so it changes when they do.
- **In Docs, Slides, Vector, or another spreadsheet**, the chart keeps the numbers it showed when you copied it. It stays a chart you can edit there, and you change its numbers with **Edit data**.

<div class="eigen-callout">

Charts appear in the PDF and web page downloads and in the preview of the file in Drive. They are not included when you download the spreadsheet as Excel.

</div>
