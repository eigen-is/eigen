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

## Move, resize, rotate, and remove a chart

Click a chart to select it. A frame with square handles appears around it.

- Drag the chart to move it.
- Drag a corner or edge handle to resize it. Hold **Shift** while you drag a corner to keep the width and height in proportion.
- Drag the round handle on the short stalk above the chart to rotate it. Hold **Shift** while you drag to snap the angle to steps of 15 degrees.

On a phone or tablet, tap a chart to select it, then drag it. Swiping across a chart you haven't selected scrolls the sheet.

Press Delete to remove the selected chart, or Esc to deselect it.

While a chart is selected, a panel headed **Chart** opens on the right. It has the same **X**, **Y**, **W**, **H**, **Angle** and **Keep aspect ratio** as the [image panel](/support/sheets/images-in-a-spreadsheet), the **Arrange** buttons, **Edit chart** and **Delete chart**. The **Chart editor** ends with the same numbers.

Right-click a chart, or press and hold it on a touch screen, for its menu:

- **Cut** and **Copy**, as described below.
- **Duplicate** puts a copy on top, a little down and to the right.
- **Edit chart** opens the **Chart editor**.
- **Order** brings the chart in front of the charts and images it overlaps, or sends it behind them.
- **Download image** saves the chart as an SVG picture on a white background, named after its title. This works with view access too. A chart that shows **#REF!** or has too much data doesn't have it.
- **Delete** removes it.

Charts and images stack together. With a chart selected, **⌘]** brings it forward a step and **⌘[** sends it back a step, and adding **Shift** brings it to the front or sends it to the back. Use **Ctrl** in place of **⌘** on Windows.

## Copy a chart

Select a chart and press **Ctrl+C** (Mac: **⌘C**) to copy it, or **Ctrl+X** (Mac: **⌘X**) to cut it. **Cut** and **Copy** in the chart's menu and in the **Edit** menu do the same. Cutting copies the chart and removes it. A chart that shows `#REF!` or **Too much data for a chart** can't be copied.

Paste it with **Ctrl+V** (Mac: **⌘V**):

- **In the same spreadsheet**, the copy reads the same cells as the original, so it changes when they do.
- **In Docs, Slides, Vector, or another spreadsheet**, the chart keeps the numbers it showed when you copied it. It stays a chart you can edit there, and you change its numbers with **Edit data**.

<div class="eigen-callout">

Charts appear in the PDF and web page downloads and in the preview of the file in Drive. They are not included when you download the spreadsheet as Excel.

</div>
