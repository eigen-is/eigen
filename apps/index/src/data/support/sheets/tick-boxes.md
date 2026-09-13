---
title: "Add tick boxes to cells"
description: "Turn cells into tick boxes you can click, and read the TRUE or FALSE value each one holds."
type: how-to
tags: [sheets, tick boxes, checkboxes, data-validation]
related: [sheets/data-validation, sheets/enter-and-edit-data]
order: 55
updated: 2026-09-13
---

A tick box turns a cell into a box you click instead of a cell you type `TRUE` or `FALSE` into. Use them for
checklists, or for a column that marks which rows are done.

## Turn cells into tick boxes

1. Select the cells you want tick boxes in.
2. Open the **Insert** menu and click **Tick box**.

You can also right-click the selection and choose **Tick box**. Both routes do the same thing, and neither
opens a dialog.

Empty cells in the selection get the value `FALSE` and show an empty box. Cells that already hold `TRUE` or
`FALSE` keep the value they have, so pointing tick boxes at a column you filled in earlier does not change
your data.

If you select a whole column by clicking its letter, Sheets covers the rows that hold something, not all
thousand empty rows below them.

## Tick and untick

Click the box itself to switch the cell between `TRUE` and `FALSE`. Clicking anywhere else in the cell
selects it the usual way, so you can copy a tick box or read it in the formula bar without flipping it.

With the cell selected, press **Space** or **Enter** to toggle it from the keyboard.

A cell that holds a formula does not toggle. Writing `TRUE` into it would replace the formula, so the box
shows the result and stays as it is.

## What the cell holds

A ticked box is the value `TRUE` and an empty box is `FALSE`. Nothing else is stored, which means a `TRUE`
that arrives some other way (typed in, pasted, imported from Excel, or produced by a formula) draws as a
ticked box too.

If a cell in the range holds something else, such as a word, the box appears and the text stays visible
beside it.

## Use your own values instead

**Insert → Tick box** is a shortcut for the **Checkbox** validation rule with `TRUE` and `FALSE` as its two
values. To use a different pair, such as `Yes` and `No`, set the rule up in **Data → Data verification**
instead and fill in the **Selected** and **Not selected** values. A box with custom values shows its value
next to the box, so you can tell one state from the other. See
[Set up data validation](/support/sheets/data-validation).

## Remove tick boxes

1. Select the cells.
2. Open **Data → Data verification**.
3. Click **Delete verification**.

The boxes go away, and the values stay: a cell that was ticked now reads `TRUE`. To clear those as well,
keep the cells selected and press Delete.
