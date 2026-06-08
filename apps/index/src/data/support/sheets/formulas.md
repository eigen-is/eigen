---
title: "Use formulas and functions"
description: "Write formulas in cells, use built-in functions, and get help from the autocomplete and function browser."
type: how-to
category: Formulas
tags: [sheets, formulas, functions, autocomplete]
related: [sheets/get-started, sheets/enter-and-edit-data]
order: 40
updated: 2026-06-08
---

Formulas let you calculate values from other cells. You type them directly in the grid or in the formula bar,
and Sheets updates the result whenever the referenced cells change.

## Write a formula

1. Click the cell where you want the result.
2. Type `=` to start the formula.
3. Type the expression. For example, `=A1+A2` adds the values in those two cells, and `=SUM(A1:A10)` adds
   all ten cells in the range.
4. Press **Enter** to confirm. Sheets shows the result in the cell. Press **Escape** if you want to cancel
   without saving.

You can also click the **formula bar** (the bar just below the menu bar) to enter or edit a formula there.
The formula bar and the cell always show the same content.

### Click cells to add references

While you are typing a formula, click any cell to insert its reference at the cursor position. Sheets
highlights the referenced cells in colour so you can see what the formula covers. You can also click and
drag to select a range.

## Use the autocomplete

As soon as you type one or more letters after the `=` sign, a dropdown list appears showing matching
function names.

- Press the **↑** and **↓** arrow keys to move through the list.
- Press **Enter** or **Tab** to insert the highlighted function. Sheets adds the function name and an
  opening bracket.
- Press **Escape** to close the list without inserting anything.

After you insert a function, a small hint panel appears below the cell. It shows the function signature,
a short description, and the name and purpose of each parameter.

## Quick functions with Auto SUM

For the most common calculations, open **Insert → Auto SUM**. The submenu offers:

- **Sum (SUM)**: total the values in the cells above or to the left of the selection.
- **Average**: arithmetic mean.
- **Count**: number of cells containing a number.
- **Max**: largest value.
- **Min**: smallest value.

Sheets inserts the chosen formula with the most likely range already filled in. Adjust the range if needed,
then press **Enter**.

## Browse all functions

To find a function you do not know by name:

1. Open **Insert → Auto SUM → Learn more...**
2. The **Select a function** dialog opens. Type a name or description in the **Search function** box to
   filter the list, or pick a category from the **Or select a category** dropdown (such as **Statistical**,
   **Logical**, or **Text**).
3. Click a function in the list to read its description.
4. Click **OK** to insert it into the active cell, or **Cancel** to close without inserting.

## Correct a formula

To edit a formula you have already entered, double-click the cell or click it and then click the
**formula bar**. The referenced cells are highlighted again so you can see the range. Edit the text, then
press **Enter** to save.

To delete a formula, select the cell and press **Backspace** or **Delete**.
