---
title: "Draw shapes, freehand lines, and text"
description: "Place rectangles, diamonds, ellipses, freehand lines, text, images, and charts on a Vector drawing."
type: how-to
category: Editing
tags: [vector, drawing, shapes, text, images, charts]
related: [vector/get-started, vector/connect-with-arrows, vector/style-objects]
order: 20
updated: 2026-10-23
---

You build a drawing in Vector by placing objects on the canvas. Pick a tool, then click or drag to add a shape, a freehand line, a text box, or an image. Charts come from the **Insert** menu. This page covers each tool and what happens after you place something.

You need editor access to add objects. If you can only view the drawing, the tools are not shown.

## Place a shape

1. Open the drawing.
2. Pick a tool from the toolbar: **Rectangle**, **Diamond**, or **Ellipse**. You can also open the **Insert** menu and choose the same tools by name.
3. Click and drag on the canvas to draw the shape at the size you want.
4. The shape appears and is selected, ready to move or restyle.

A shape needs a drag, not a single click. Drag out the box, and let go when it is the size you want.

After you place a shape, the tool goes back to **Select** so your next click selects objects instead of drawing another one. To keep drawing, see [Keep a tool active](#keep-a-tool-active) below.

## Draw a freehand line

1. Pick the **Draw** tool from the toolbar, or choose **Draw** from the **Insert** menu.
2. Press and drag on the canvas to draw. The line follows your pointer.
3. Let go to finish the line.

The **Draw** tool stays active after each line, so you can keep drawing without picking it again.

## Keep a tool active

By default a tool switches back to **Select** once you place an object, so you don't draw a second one by accident. When you want to place several objects in a row, turn on **Keep selected tool**. It lives in the **Edit** menu, or you can press **Q** to toggle it. With it on, the tool you picked stays active until you change it.

The **Draw** and **Eraser** tools stay active on their own, whether or not **Keep selected tool** is on.

## Add text

1. Pick the **Text** tool from the toolbar, or choose **Text** from the **Insert** menu.
2. Click on the canvas to place a text box. It opens straight away for typing.
3. Type your text. A floating toolbar appears with formatting options such as bold, italic, and lists.
4. Press **Escape** or click outside the box to finish.

To edit a text object later, double-click it. You can also double-click an empty spot on the canvas to start a new text box there, without picking the **Text** tool first.

Once a text object is selected but not being edited, the properties panel on the right shows the full set of text options: font, size, color, alignment, and spacing.

## Add an image

1. Click **Add image** in the toolbar, choose **Image** from the **Insert** menu, or press `9`.
2. The **Add image** dialog opens. Do one of two things:
   - Click **Upload from device** to pick a file from your computer.
   - Browse your Drive, click an image to select it, then click **Select**.
3. The image appears on the canvas.

You can also drag one or more image files from your desktop and drop them onto the canvas. A **Drop images to add** overlay appears while you drag, and Vector places each image where you drop it.

## Add a chart

1. Open the **Insert** menu and choose **Chart**, then **Bar**, **Column**, **Line**, or **Pie**. A bar chart has horizontal bars, a column chart vertical ones.
2. The chart appears in the middle of your view with sample data, and stays selected.

With the chart selected, the properties panel shows its options. The **Chart** section sets the **Type**, the **Stacking** of a bar or column chart (**None**, **Standard** or **100%**), the **Title**, where the **Legend** goes, and the **Font** of all the chart's text. The **Horizontal axis** and **Vertical axis** sections hold each axis's **Title** and a **Show axis** box, which hides the axis's labels and line when you clear it. The axis with the categories also has **Reverse axis order**, which runs it the other way. The axis with the numbers also has **Min** and **Max**, which pick their own values while they're empty and are percents on a **100%** stack, and **Gridlines**. Switching **Stacking** to or from **100%** empties **Min** and **Max**. **Series** sets the color of each series. A pie chart has **Slices** instead, with a color for each slice. A color reads **Automatic** until you pick one; **Automatic** in a picked color's list puts it back.

### Edit the numbers

1. Double-click the chart, or click **Edit data** in the properties panel.
2. The **Edit data** dialog shows the data as a small spreadsheet: categories down column A, series across row 1, and the category axis title in A1. Click a cell and type to replace it, or double-click it (or press **F2**) to change part of it. Press **Enter** to move down or **Tab** to move right. **Escape** cancels what you typed in a cell. A cell left empty leaves a gap in the chart.
3. Type in an empty row or column after the data to add a category or a series. To remove one, click its row number or column letter and press **Delete**. **Delete** on selected cells empties them.
4. Click **Save** to update the chart, or **Cancel** to leave it as it was.

You can paste cells copied from a spreadsheet into the grid, and copy cells out of it. A paste fills the grid from the selected cell, and the grid grows to fit. A chart holds up to 12 series, 200 categories, and 2,000 values; when a paste has more, the dialog says how much it pasted and leaves the rest out. Numbers may have thousands separators, a currency sign or a percent sign, as a spreadsheet shows them. A chart with more data than that, for example from an imported file, opens its data read-only.

**Convert to shapes**, in the properties panel or the right-click menu, turns the chart into ordinary shapes and text boxes you can edit one by one. You can't turn them back into a chart, but undo (**⌘Z**, or **Ctrl+Z** on Windows) right after brings the chart back.

You can paste a chart copied in Sheets, Docs, or Slides onto a drawing, and it stays a chart you can edit. A chart you copy on its own from a drawing pastes into Docs and Sheets the same way; copied together with other objects, it pastes there as one picture. A chart copied from Sheets keeps the numbers it showed when you copied it. See [Arrange and align](/support/vector/arrange-and-align).

## Erase objects

Pick the **Eraser** tool, then drag across the objects you want to remove. Anything the eraser passes over is deleted. Pick another tool, or press **Select**, when you are done.

## Tool shortcuts

Each tool has a single-key shortcut. Press the key to pick the tool without going to the toolbar.

| Tool | Shortcut |
|---|---|
| **Select** | `V` |
| **Rectangle** | `R` |
| **Diamond** | `D` |
| **Ellipse** | `O` |
| **Draw** | `P` |
| **Text** | `T` |
| **Add image** | `9` |
| **Eraser** | `E` |
| **Keep selected tool** | `Q` |

The number keys pick the same tools in toolbar order, so `1` is **Select**, `2` is **Rectangle**, and so on. The **Arrow** (`A`) and **Line** (`L`) tools have their own article: [Connect objects with arrows](/support/vector/connect-with-arrows).

Once your objects are placed, [Style objects](/support/vector/style-objects) covers colors, borders, and fills, and [Arrange and align objects](/support/vector/arrange-and-align) covers moving, ordering, and lining things up.
