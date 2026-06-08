---
title: "Insert, delete, and resize rows and columns"
description: "Add, remove, and resize rows and columns in a Sheets spreadsheet."
type: how-to
tags: [sheets, rows, columns, resize]
related: [sheets/create-and-edit, sheets/enter-and-edit-data]
order: 80
updated: 2026-06-08
---

You can add and remove rows and columns at any point, and adjust their size to fit your data. All of these actions are available from the menu bar or by right-clicking directly on the grid.

## Insert rows

**From the menu bar:**

1. Click the cell where you want the new row to appear.
2. Open **Insert → Row**.
3. Choose **Insert 1 row above** or **Insert 1 row below**.

**From the right-click menu:**

1. Right-click any cell.
2. The context menu shows an **Insert** entry with a count input and a direction. Type the number of rows you want, then click the row direction: **Above** or **Below**.

To add rows to the end of the sheet, use the **Add** button at the very bottom of the grid. Type a count in the box next to it, then click **Add**.

## Insert columns

**From the menu bar:**

1. Click the cell where you want the new column to appear.
2. Open **Insert → Column**.
3. Choose **Insert 1 column left** or **Insert 1 column right**.

**From the right-click menu:**

1. Right-click any cell.
2. The context menu shows an **Insert** entry with a count input and a direction. Type the number of columns you want, then click the column direction: **Left** or **Right**.

## Delete rows

**From the menu bar:**

1. Click any cell in the row you want to remove.
2. Open **Edit → Delete → Row**.

**From the right-click menu:**

1. Click the row number on the left to select the whole row. You can hold Shift and click another row number to extend the selection.
2. Right-click the selected area and choose **Delete selected Row**.

You cannot delete the last remaining row in a sheet.

## Delete columns

**From the menu bar:**

1. Click any cell in the column you want to remove.
2. Open **Edit → Delete → Column**.

**From the right-click menu:**

1. Click the column letter at the top to select the whole column. You can hold Shift and click another letter to extend the selection.
2. Right-click the selected area and choose **Delete selected Column**.

You cannot delete the last remaining column in a sheet.

## Resize rows and columns by dragging

Move the pointer to the border between two row numbers on the left, or between two column letters at the top. The cursor changes to a resize handle. Drag the border to set the new size.

To set a column to fit its contents, double-click the right edge of the column letter. The column widens or narrows to fit the longest value in that column.

## Set an exact size

1. Click a row number or column letter to select it.
2. Right-click the selection.
3. In the context menu, find the **RowHeight** or **ColumnWidth** entry. Type a number in the box next to it, then click the entry to apply. Row height accepts values from 1 to 545 px; column width accepts values from 1 to 2038 px.

## Hide and show rows or columns

To hide rows or columns you do not want to see at the moment:

1. Click a row number or column letter to select the whole row or column.
2. Right-click and choose **Hide selected Row** or **Hide selected Column**.

To bring them back, click a row number or column letter near the hidden rows or columns to select it, then right-click and choose **Show hidden Row** or **Show hidden Column**.

<div class="eigen-callout">

A sheet can have at most 10,000 rows and 1,000 columns. Inserting rows or columns beyond these limits is blocked.

</div>
