---
title: "Sort and filter data"
description: "Reorder rows by the values in a column, or add filters to hide the rows you don't need."
type: how-to
tags: [sheets, sort, filter, data]
related: [sheets/get-started, sheets/rows-and-columns]
order: 130
updated: 2026-06-08
---

Sorting rearranges your rows by the values in a chosen column. Filtering hides rows that don't match the values you pick, so you can focus on the data you care about. Both work on the same sheet at the same time.

## Sort a range

### Quick sort

1. Select a cell, or highlight the range you want to sort.
2. Open the **Data** menu and hover over **Sort range**.
3. Choose **Ascending** to sort A to Z (or smallest to largest), or **Descending** to sort Z to A (or largest to smallest).

Sheets sorts the rows inside your selection. If you select a single cell, Sheets finds the continuous block of data around it and sorts that.

### Custom sort

**Custom sort** lets you choose which column to sort by, and whether your data has a header row.

1. Select any cell in your data, or highlight the range.
2. Open the **Data** menu, hover over **Sort range**, and click **Custom sort**.
3. Tick **Data has a header row** if the first row contains column names. Sheets will exclude that row from sorting and use the column names in the **Sort by** dropdown.
4. Choose the column to sort by from the **Sort by** dropdown.
5. Select **Ascending** or **Descending**.
6. Click **Sort**.

You can also reach **Custom sort** by right-clicking a cell and choosing **Sort**.

<div class="eigen-callout">

Sorting does not work on a range that contains merged cells. Unmerge the cells first, then sort.

</div>

## Filter rows by value

A filter adds a dropdown arrow to each column header in your data. Click an arrow to choose which values that column should show, and rows that don't match are hidden.

### Turn on a filter

1. Click any cell in your data.
2. Open the **Data** menu and click **Create filter**.

A dropdown arrow appears in each header cell of the data range. The range is highlighted with a blue border.

You can also right-click a cell and choose **Filter** to create a filter in one step.

### Choose which rows to show

1. Click the dropdown arrow in the column you want to filter.
2. A panel opens with the values found in that column. All values are checked (visible) by default.
3. Use the buttons at the top of the panel to change the whole selection at once:
   - **Check all**: shows every row.
   - **Clear**: hides every row.
   - **Inverse**: reverses your current selection.
4. To narrow the list, type in the search box below those buttons.
5. Untick individual values you want to hide.
6. Click **Confirm** to apply the filter.

Rows hidden by the filter are still in your sheet. They come back the moment you change or remove the filter.

### Filter by cell colour or font colour

If your cells have different background or font colours, you can filter by colour instead of value.

1. Click the dropdown arrow on the column.
2. Hover over **Filter by color**.
3. A sub-panel shows the colours used in that column. Untick any colour to hide rows with that colour.
4. Click **Confirm**.

### Sort from the filter dropdown

The filter dropdown also lets you sort the whole filtered range by that column without leaving the panel. Click **Ascending sort** or **Descending sort** at the top of the dropdown.

### Remove the filter

To remove all filters at once, open the **Data** menu and click **Clear filter**. The dropdown arrows disappear and all hidden rows return.

To remove just one column's filter, click that column's dropdown arrow, click **Check all** so all values are ticked, and click **Confirm**. The rows return, but the filter stays active on the other columns.
