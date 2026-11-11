---
title: "Create and edit a spreadsheet"
description: "Create a new spreadsheet in Sheets, enter data, and use the menus and keyboard shortcuts to edit it."
type: how-to
tags: [sheets, spreadsheet, create, edit, cells, data]
related: [sheets/get-started, sheets/enter-and-edit-data]
order: 20
updated: 2026-11-09
---

You can create a spreadsheet directly in Drive or from inside Sheets, then enter data and edit it using the toolbar menus and keyboard shortcuts.

## Create a spreadsheet

### From Drive

1. Open Drive and navigate to the folder where you want the spreadsheet.
2. Click **New** in the sidebar.
3. Choose **New sheet** from the menu.
4. Type a name for the spreadsheet and click **Create**.

The spreadsheet opens in Sheets straight away.

### From inside Sheets

1. Click **File** in the top-left of the menu bar.
2. Click **New sheet**.
3. Type a name and click **Create**.

## The editor layout

When a spreadsheet is open, the editor has three main areas:

- **Menu bar**: a row of menus (**File**, **Edit**, **View**, **Insert**, **Format**, **Data**) at the top.
- **Formula bar**: below the menu bar. The box on the left shows the current cell address (for example, `A1`). The wider area to the right shows the cell's content or formula.
- **Sheet tabs**: a row of tabs along the bottom. Click a tab to switch between sheets. Click the **+** button at the left of the tab bar to add a new sheet tab.

## Enter and edit data

Click a cell to select it. Type to enter data. Press **Enter** to confirm and move down, or **Tab** to confirm and move right. Press **Escape** to cancel without saving.

To edit a cell you have already filled in, double-click it, or select it and start typing to replace its contents. You can also click the formula bar to edit there.

To delete the contents of one or more cells, select them and press **Backspace** or **Delete**.

## Select cells

Click a single cell to select it. To select a range, click and drag. To select a whole column or row, click its header letter or number.

You can select multiple separate ranges by holding **Ctrl** (Windows and Linux) or **⌘** (Mac) while clicking.

## Copy, cut, and paste

Use the standard keyboard shortcuts:

- **Ctrl+C** (Mac: **⌘C**) to copy
- **Ctrl+X** (Mac: **⌘X**) to cut
- **Ctrl+V** (Mac: **⌘V**) to paste

You can also use **Edit → Copy**, **Edit → Cut**, and **Edit → Paste** from the menu bar. If your browser doesn't let a menu read the clipboard, **Paste** shows a notice that says to press **Ctrl+V** (Mac: **⌘V**) instead.

A copy takes hidden rows and columns along, as in Excel. The one exception is a filter: a copy leaves out the rows a filter hides. A cut or a drag can't leave them behind, so over such rows it moves nothing and a notice says to clear the filter first. A copy of a merged cell that a filter partly hides shows a notice too. The rows and columns you paste over stay hidden or shown as they were.

When you paste in the same browser tab, the pasted cells bring their dropdowns, other data validation, conditional formatting, and links. They replace the ones on the cells they land on, so a copied cell without a link or a rule removes the destination's, and a rule can end up with a gap in it. A table pasted from another app removes the links of the cells it lands on. If you edit the copied cells before you paste, the paste brings them as they are now.

Copied cells paste into other apps as rows and columns, the same ones a paste in Sheets gets, for example into a text editor or a chart's **Edit data** grid.

## Undo and redo

- **Ctrl+Z** (Mac: **⌘Z**) undoes your last change.
- **Ctrl+Shift+Z** (Mac: **⇧⌘Z**) redoes it.

Both are also available under **Edit → Undo** and **Edit → Redo**.

Once someone else edits the spreadsheet, you can no longer undo or redo your last insert or delete of rows or columns, your last added, duplicated, deleted or renamed sheet, a paste that added rows or columns, or anything you did before it. What you did after it still undoes. If someone else renames a sheet, you can no longer undo or redo anything you did before that. Your own edit in another tab or on another device counts too.

When there is nothing left to undo for this reason, pressing undo shows a notice: "Someone else edited this spreadsheet, so this can't be undone anymore." Pressing redo says: "Someone else edited this spreadsheet, so this can't be redone anymore." The notice stops once you make a new edit.

## Format cells

The **Format** menu covers all formatting options:

- **Text**: bold (**Ctrl+B**), italic (**Ctrl+I**), underline (**Ctrl+U**), and strikethrough. On a Mac, press **⌘** in place of **Ctrl**.
- **Number**: choose a format such as currency, percentage, or date from the submenu.
- **Alignment**: left, center, or right horizontally; top, middle, or bottom vertically.
- **Wrapping**: overflow (default), wrap, or clip long text.
- **Font size**: pick from the list.
- **Fill color** and **Borders**: set a background color or draw borders around cells.
- **Merge cells**: combine a selection into one cell.
- **Clear formatting**: remove text styles, colors, alignment and borders from the selected cells. Values and number formats stay.

Quick buttons for the font, font size, **Bold**, **Italic**, **Text color**, **Fill color**, and horizontal alignment sit in the center of the menu bar. As the bar gets narrower, for example when a side panel is open, they fold away from the right, alignment first, until none are left. Everything they do stays in the **Format** menu.

## Find and replace

Press **Ctrl+F** (Mac: **⌘F**) to open the find panel, or **Edit → Find and replace**. A search box appears where you can search across all cells. Click **Show replace** to open the replace row.

## Sheet tabs

Each spreadsheet can contain multiple sheets. To manage them:

- Click the **+** button at the left of the tab bar to add a sheet.
- Double-click a tab to rename it.
- Click the **⌄** arrow on a tab to open a menu with options to **Rename**, **Duplicate**, **Change color**, **Hide**, **Move left**, **Move right**, and **Delete**.
- Drag a tab to a different position to reorder sheets.

## Save your work

Sheets saves your changes automatically. There is no **Save** button.
