---
title: "Enter and edit data"
description: "Type into cells, edit their contents, and clear them in Sheets."
type: how-to
category: Basics
tags: [sheets, cells, data, editing, keyboard, formula-bar]
related: [sheets/get-started, sheets/create-and-edit, sheets/formulas]
order: 30
updated: 2026-11-11
---

You can enter text, numbers, and formulas into any cell in Sheets, then edit or clear them at any time. Changes are saved automatically.

## Type into a cell

1. Click the cell where you want to enter data. A colored outline shows it is selected.
2. Start typing. The cell opens for editing and the text appears as you type.
3. Press **Enter** to confirm and move to the next row.

To cancel what you have typed before confirming, press **Escape**. The cell returns to its previous contents.

With an input method, such as for Japanese or Chinese, the first **Enter** confirms what you are composing and the cell stays open. Press **Enter** again to confirm the cell.

## Edit a cell you have already filled in

Select the cell, then do one of the following:

- **Double-click** the cell to place your cursor inside it.
- Press **F2** to open the cell for editing at the end of its contents.
- Click the formula bar (the input area below the menu bar) and edit there.

While the cell is open for editing, the arrow keys move the cursor within the text rather than moving to a neighboring cell. Press **Enter** when you are done.

<div class="eigen-callout">

If you select a cell and start typing, the new text **replaces** the existing contents rather than appending to them. To add to what is already there, open the cell with double-click or **F2** first.

</div>

## Add a line break inside a cell

Press **Alt+Enter** (Mac: **⌥+Enter**) while a cell is open for editing. The cursor moves to a new line within the same cell. Press **Enter** on its own to confirm and move to the next row.

## Clear cell contents

Select one or more cells, then press **Delete** or **Backspace**. The values, formulas and links are removed, and the cells keep their formatting, such as colors, bold and number format. To remove the formatting too, apart from the number format, use **Format → Clear formatting**.

To clear contents from the right-click menu, right-click the selection and choose **Clear contents**. The same option is available under **Edit → Delete → Clear contents**.

## Select a range of cells

- **Click and drag** to select a rectangle of cells.
- **Shift+click** to extend the selection to another cell.
- **Shift+arrow keys** to extend the selection one cell at a time.
- Click a column letter or row number to select the whole column or row.

## Fill down or fill right

To copy the top row of a selection into the rows below it, or its left column into the columns to its right, select the range first (including the source cells), then:

- Press **Ctrl+D** (Mac: **⌘D**) to fill down through the selected rows.
- Press **Ctrl+R** (Mac: **⌘R**) to fill right across the selected columns.

Sheets copies each cell's value or formula, formatting, borders, and link. When filling formulas, Sheets adjusts relative cell references automatically. An empty source cell clears the value, formatting, borders, and link of the cells it fills.

A filled cell also takes the data validation and conditional formatting of its source cell. Where the source cell has none, the filled cell loses its own, so a rule can end up with a gap in it.

## Undo and redo

- **Ctrl+Z** (Mac: **⌘Z**) undoes the last change.
- **Ctrl+Shift+Z** (Mac: **⇧⌘Z**) redoes it.

Both are also available under **Edit → Undo** and **Edit → Redo**.

Once someone else edits the spreadsheet, you can no longer undo or redo:

- Your last insert or delete of rows or columns.
- Your last added, duplicated, deleted or renamed sheet.
- A paste that added rows or columns.
- A conditional format rule you removed, or one you added to a sheet that already has rules.
- Anything you did before one of these.

What you did after it still undoes. If someone else renames a sheet, you can no longer undo or redo anything you did before that. Your own edit in another tab or on another device counts too.

When there is nothing left to undo for this reason, pressing undo shows a notice: "Someone else edited this spreadsheet, so this can't be undone anymore." Pressing redo says: "Someone else edited this spreadsheet, so this can't be redone anymore." The notice stops once you make a new edit.
