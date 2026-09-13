---
title: "Put a link in a cell"
description: "Link a cell to a web page, to a range of cells, or to another sheet tab, then edit or remove that link."
type: how-to
tags: [sheets, links, hyperlinks, cells]
related: [sheets/enter-and-edit-data, sheets/multiple-tabs]
order: 140
updated: 2026-09-13
---

A cell can carry a link to a web page, to a range of cells, or to another sheet tab in the same spreadsheet.
The cell shows the text you choose for it, in blue with an underline.

## Add a link

1. Select the cell.
2. Open the **Insert** menu and click **Insert link**. Right-clicking the cell and choosing **Insert link**
   does the same thing.
3. In the **Insert link** dialog, type what the cell should show in **Display text**.
4. Pick where the link goes from **Link type**:
   - **Webpages**: type the address in **Link address**. An address without `https://` in front of it gets
     one added.
   - **Cell range**: type a range such as `Sheet1!A1:C8` in **Cell range**, or click the grid icon inside the
     field and select the range with the mouse.
   - **Sheet**: choose a tab from the **Worksheet** list.
5. Click **OK**.

If you leave **Display text** empty, the cell shows the address instead. If the address is not one Sheets can
open, a short message appears under the field and **OK** does nothing until you correct it.

## Open a link

Hover over a cell that has a link. A small card appears under it.

- For a web page, click **Open link**. The page opens in a new browser tab.
- For a cell range or another sheet, the card reads **Go to** followed by the address. Click it to jump
  there.

## Edit or remove a link

The same card carries three icon buttons on its right, as long as you can edit the spreadsheet:

- The copy icon copies the web address to your clipboard. It appears for web links only.
- The pencil icon reopens the dialog, now headed **Edit link**, where you can change the display text, the
  type, or the address. Click **OK** to save.
- The broken-link icon removes the link. The cell keeps its text and loses the blue underline.

People who can only view the spreadsheet see the card with the open button, but none of these three.
