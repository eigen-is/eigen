---
title: "Insert text and images"
description: "Add text boxes, images, and charts to a slide, edit the content, and adjust position, size, and appearance."
type: how-to
tags: [slides, text, images, charts, objects, canvas]
related: [slides/get-started, slides/add-slides, slides/style-objects, slides/draw-shapes-and-arrows]
order: 40
updated: 2026-10-23
---

You build slides by placing text boxes, images, and charts on the canvas. They work the same way: add one from the toolbar, then move, resize, and adjust it from the properties panel on the right.

You need editor access to add or change content. If you can only view the presentation, the controls below are not available.

## Add a text box

1. Open the presentation and select the slide you want to edit in the left panel.
2. In the toolbar, click the **Text** tool, or press **T**. It sits in the tool cluster in the middle of the toolbar.
3. Click once on the slide to drop a text box, or drag to draw one at the size you want.
4. Type your text, then click outside the box when you are done.

While you are editing, a small formatting toolbar floats above the text for basics like **Bold** and **Italic**. When the text box is selected but not in edit mode, the properties panel on the right holds the full set of options: font, size, weight, color, alignment, letter spacing, and line height.

## Add an image

1. Select the slide you want to edit.
2. Click **Add image** in the toolbar.
3. The **Add image** dialog opens. Either click **Upload from device** to pick a file from your computer, or browse your Drive, click a file, and click **Select**.
4. The image appears on the slide.

You can also drag an image file from your desktop straight onto the canvas. A **Drop images to add** overlay appears, and Slides adds the image to the slide you are on.

When an image is selected, the properties panel shows an **Image** section. Use the **Fit** dropdown to choose how the picture fills its box: **Fit** (the whole image is visible), **Fill** (fills the box, cropping if needed), or **Stretch** (stretches to fill the box exactly).

## Add a chart

1. Open the **Insert** menu and choose **Chart**, then **Bar**, **Column**, **Line**, or **Pie**. A bar chart has horizontal bars, a column chart vertical ones.
2. The chart appears on the slide with sample data, and stays selected.

With the chart selected, the properties panel shows its options. The **Chart** section sets the **Type**, the **Stacking** of a bar or column chart (**None**, **Standard** or **100%**), the **Title**, where the **Legend** goes, and the **Font** of all the chart's text. The **Horizontal axis** and **Vertical axis** sections hold each axis's **Title** and a **Show axis** box, which hides the axis's labels and line when you clear it. The axis with the categories also has **Reverse axis order**, which runs it the other way. The axis with the numbers also has **Min** and **Max**, which pick their own values while they're empty and are percents on a **100%** stack, and **Gridlines**. Switching **Stacking** to or from **100%** empties **Min** and **Max**. **Series** sets the color of each series. A pie chart has **Slices** instead, with a color for each slice. A color reads **Automatic** until you pick one; **Automatic** in a picked color's list puts it back.

### Edit the numbers

1. Double-click the chart, or click **Edit data** in the properties panel.
2. The **Edit data** dialog shows the data as a small spreadsheet: categories down column A, series across row 1, and the category axis title in A1. Click a cell and type to replace it, or double-click it (or press **F2**) to change part of it. Press **Enter** to move down or **Tab** to move right. **Escape** cancels what you typed in a cell. A cell left empty leaves a gap in the chart.
3. Type in an empty row or column after the data to add a category or a series. To remove one, click its row number or column letter and press **Delete**. **Delete** on selected cells empties them.
4. Click **Save** to update the chart, or **Cancel** to leave it as it was.

You can paste cells copied from a spreadsheet into the grid, and copy cells out of it. A paste fills the grid from the selected cell, and the grid grows to fit. A chart holds up to 12 series, 200 categories, and 2,000 values; when a paste has more, the dialog says how much it pasted and leaves the rest out. Numbers may have thousands separators, a currency sign or a percent sign, as a spreadsheet shows them. A chart with more data than that, for example from an imported file, opens its data read-only.

**Convert to shapes**, in the properties panel or the right-click menu, turns the chart into ordinary shapes and text boxes you can edit one by one. You can't turn them back into a chart, but undo (**Cmd+Z** on a Mac, **Ctrl+Z** on Windows) right after brings the chart back.

You can paste a chart copied in Sheets, Docs, or Vector onto a slide, and it stays a chart you can edit. A chart you copy on its own from a slide pastes into Docs and Sheets the same way; copied together with other objects, it pastes there as one picture. A chart copied from Sheets keeps the numbers it showed when you copied it. See [Arrange and align](/support/slides/arrange-and-align).

## Add shapes and arrows

The same tool cluster has tools for rectangles, ellipses, lines, arrows, and freehand drawing. See [Draw shapes and arrows](/support/slides/draw-shapes-and-arrows).

## Move and resize objects

Click an object to select it. Handles appear at the corners and edges.

- **Move**: drag the object to any position on the canvas.
- **Resize**: drag a corner or edge handle.
- **Rotate**: drag the circular handle that appears above the object (visible when one object is selected).
- **Nudge**: use the arrow keys to move the object one step at a time.

You can also type exact values in the **X**, **Y**, **W**, **H**, and **Angle** fields in the **Transform** section of the properties panel.

## Select multiple objects

Hold **Shift** and click objects to add them to the selection. You can also drag a selection box across the canvas to select everything it touches.

With several objects selected, the properties panel adds an **Align** section. Use it to line objects up with each other (left, center, right, top, middle, or bottom), match their width or height, or space three or more of them evenly.

Any text or image properties you change while objects of the same type are selected apply to all of them at once.

## Style an image

Select an image and use the properties panel to give it an outline. The **Stroke** section sets the **Color**, the **Width**, and the **Style** (**Solid**, **Dashed**, or **Dotted**). The **Shape** section sets the **Corners** (**Straight**, **Curved**, or **Round**), so you can round an image's corners. For the full styling reference across every object, see [Style objects](/support/slides/style-objects).

## Change the layering order

Right-click an object and choose from the menu:

- **Bring to front**: places the object in front of all others.
- **Bring forward**: moves it one step toward the front.
- **Send backward**: moves it one step toward the back.
- **Send to back**: places the object behind all others.

The same menu has **Copy**, **Cut**, **Paste**, **Duplicate**, **Delete**, and **Add comment**. On an image it also has **Download original image**, which saves the image file at its full size and in its own format. If you can only view the presentation, right-clicking an image gives you that option alone.

## Delete an object

Select the object and press **Delete** or **Backspace**. Or right-click and choose **Delete** from the menu.

To undo a deletion, press **Cmd+Z** (Mac) or **Ctrl+Z** (Windows).

## Copy and paste objects

Select an object and press **Cmd+C** or **Ctrl+C** to copy it. Press **Cmd+V** or **Ctrl+V** to paste it onto the current slide. You can paste between slides in the same presentation.

You can also paste an image from the clipboard straight onto the canvas. Copy an image in another app, switch to Slides, and paste. The image is added to the current slide.
