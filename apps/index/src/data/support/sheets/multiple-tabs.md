---
title: "Work with multiple sheet tabs"
description: "Add, rename, reorder, and switch between sheet tabs to organize your spreadsheet into separate sections."
type: how-to
tags: [sheets, tabs, sheets-tabs, rename, reorder]
related: [sheets/create-and-edit]
order: 100
updated: 2026-11-09
---

A spreadsheet can contain as many sheets as you need. Each sheet has its own tab along the bottom of the editor. You can add, rename, reorder, and color-code them to keep your data organized.

## Add a sheet

Click the **+** button at the left of the tab bar. The new sheet is added at the end of the tab bar.

You can also go to **Insert → Sheet** in the menu bar.

## Switch between sheets

Click any tab to switch to that sheet.

If you have many sheets and the tabs overflow the bar, scroll left or right using the arrow buttons that appear at the right of the tab bar.

To see all sheets at once, click the grid icon (next to the **+** button) to open the sheet list, then click the sheet you want.

## Rename a sheet

Double-click a tab to edit its name inline. Type the new name, then press **Enter** or click anywhere else to save.

A name has 1 to 31 characters. It can't contain `\ / ? * [ ] :`, and it can't start or end with an apostrophe (`'`). The fullwidth `：` and `？` are fine. If a name breaks these rules, Sheets keeps the old name and tells you why.

Two tabs can't share a name, and letter case doesn't count, as in Excel. If you type a name another tab already has, such as `data` next to `Data`, the tab keeps its old name and a **Notice** says "Another sheet already has this name". A formula finds the sheet even when its name's case differs, so `=data!A1` reads the tab named `Data`.

Formulas, formula rules, dropdown lists and links that name the sheet follow the new name, on every sheet, and **Undo** renames it back.

You can also click the **⌄** arrow on the tab and choose **Rename** from the menu.

## Reorder sheets

Drag a tab left or right and drop it in the new position.

You can also click the **⌄** arrow on a tab and choose **Move left** or **Move right** to shift it one place at a time.

## Copy a sheet

Click the **⌄** arrow on a tab and choose **Duplicate**. A copy of the sheet appears next to the original. The copy starts without comments: they stay on the original's cells.

## Add a color to a tab

Click the **⌄** arrow on a tab and choose **Change color**. Pick a color from the palette. A thin stripe of that color appears along the bottom of the tab.

To clear the color, open the same menu, choose **Change color** again, and click **Reset color**.

## Hide and show a sheet

To hide a sheet, click the **⌄** arrow on its tab and choose **Hide**. The tab disappears from the bar. You cannot hide the last visible sheet.

To show a hidden sheet again, open the **View** menu in the menu bar. If any sheets are hidden, a **Hidden sheets** submenu appears. Click the sheet name to make it visible again.

## Delete a sheet

Click the **⌄** arrow on a tab and choose **Delete**. You will be asked to confirm before the sheet is removed.

You cannot delete the last sheet in a spreadsheet.

Formulas on other sheets that name the deleted sheet show `#REF!`, and dropdown lists and links that name it stop working. **Undo** brings them back.
