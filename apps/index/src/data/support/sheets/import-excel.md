---
title: "Import an Excel file"
description: "Bring an .xlsx spreadsheet into Eigen Sheets, either by uploading it from your computer or converting a file already in Drive."
type: how-to
tags: [sheets, import, excel, xlsx, spreadsheet]
related: [sheets/get-started, sheets/export-spreadsheet]
order: 110
updated: 2026-10-23
---

You can bring an Excel workbook into Sheets in two ways: import it into an existing spreadsheet to replace its content, or convert an `.xlsx` file stored in Drive into a new spreadsheet.

## Import into an open spreadsheet

This replaces the current spreadsheet's content with the data from the Excel file.

1. Open the spreadsheet you want to replace.
2. Click **File** in the top-left of the menu bar.
3. Click **Import xlsx file…**.
4. A dialog opens. You can either:
   - Browse your Drive to pick an `.xlsx` file you have already uploaded, then click **Select**.
   - Click **Upload from device** to open a file chooser and pick an `.xlsx` file from your computer.

An **Importing xlsx file** dialog shows while Sheets loads all the sheets from the workbook. When it closes, the spreadsheet's content is replaced. The change is saved automatically.

## Convert an Excel file in Drive to a new spreadsheet

If you have an `.xlsx` file sitting in Drive, you can turn it into a Sheets spreadsheet without opening it first. This leaves the original file in place and creates a new spreadsheet alongside it.

1. Open [Drive](/drive) and find the `.xlsx` file.
2. Right-click the file (or open the **⋮** menu) and choose **Convert to Sheet**.

Drive creates a new spreadsheet in the same folder and opens it in Sheets.

## What carries over

The import reads every sheet in the workbook and preserves:

- Cell values (text, numbers, booleans, and dates)
- Formulas
- Merged cells
- Column widths and row heights
- Cell borders
- Text formatting: bold, italic, underline, strikethrough, font size, and text color, also where one cell mixes several formats
- Fill colors
- Text alignment (horizontal and vertical), text wrapping, and text rotation
- The sheet tab names, colors, and order
- Hidden sheets, which stay hidden until you show them from the **View** menu
- The gridlines setting (hidden or visible)
- Conditional formatting rules, data validation rules, and hyperlinks
- Frozen rows and columns, and the range a filter covers (the values ticked in each column's dropdown are not carried over)
- Column, bar, line, and pie charts, with their colors and title, over the same cells as in Excel. A 3-D chart comes in flat. See [Add a chart to a spreadsheet](/support/sheets/add-a-chart).
- Chart sheets, each as a sheet of its own with its chart in the top-left corner

A chart reads its cells, so it changes when you edit them. A chart whose data comes from a named range, from several separate ranges, or from another workbook shows the numbers saved in the file instead, and doesn't change with the cells.

Fonts from Excel are mapped to the four fonts Sheets supports. Common sans-serif fonts (such as Calibri, Arial, and Verdana) map to Inter; serif fonts (such as Times New Roman and Georgia) map to Source Serif 4; monospace fonts (such as Courier New and Consolas) map to JetBrains Mono; Comic Sans maps to Excalifont.

## What does not carry over

The following are not imported:

- Charts Sheets can't draw the way Excel does, such as area, scatter, doughnut, combo, and waterfall charts. A chart sheet holding one comes in as an empty sheet.
- Images, whether in cells or floating over them, and shapes such as text boxes
- Comments and notes

If these are important, keep the original `.xlsx` file in Drive so you have a reference copy.

A password-protected Excel file can't be imported. Open it in Excel, remove the password, save it, and import it again.
