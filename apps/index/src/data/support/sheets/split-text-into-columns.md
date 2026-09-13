---
title: "Split text into columns"
description: "Split one column of text into several columns, using a separator such as a comma, a space, or a character you choose."
type: how-to
tags: [sheets, split text, data, columns]
related: [sheets/sort-and-filter, sheets/rows-and-columns]
order: 135
updated: 2026-09-13
---

If one column holds values that belong in several, such as `Ada,Lovelace` in a single cell, you can split
them apart. Sheets cuts each cell at the separator you pick and writes the pieces across the row.

## Split a column

1. Select the cells you want to split. Only the first column of the selection is split, so a selection that
   spans several columns still works on the leftmost one.
2. Open the **Data** menu and click **Split text**.
3. Under **Delimiters**, tick every separator your text uses: **Tab**, **semicolon**, **comma**, or
   **space**. For anything else, tick **Other** and type the character in the box beside it.
4. Tick **Consecutive separators are treated as a single** if two separators in a row should count as one.
   Without it, `Ada,,Lovelace` gives you an empty column in the middle.
5. Check the **Preview** table. It shows the split as you will get it, and updates as you change the
   delimiters.
6. Click **OK**.

The first piece of each cell replaces the value in the original cell. The rest land in the cells to its
right, one per column.

If the text contains none of the separators you ticked, there is nothing to split and the sheet stays as it
is.

## What happens to the columns on the right

Sheets does not insert new columns for the pieces. It writes them into the cells that are already there, so
anything in the way is replaced.

If those cells hold values, a **Notice** dialog appears first and asks: "There is already data here, do you
want to replace it?" Click **OK** to go ahead, or **Cancel** to leave the sheet alone.

<div class="eigen-callout">

To keep what is on the right, insert a few empty columns before you split. Right-click a column letter and
choose **Insert 1 column to the left** as many times as you need pieces.

</div>
