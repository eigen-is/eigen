---
title: "Import an Excel file"
description: "Bring an .xlsx spreadsheet into Eigen Sheets, either by uploading it from your computer or converting a file already in Drive."
type: how-to
tags: [sheets, import, excel, xlsx, spreadsheet]
related: [sheets/get-started, sheets/export-spreadsheet]
order: 110
updated: 2026-06-08
---

You can bring an Excel workbook into Sheets in two ways: import it into an existing spreadsheet to replace its
content, or convert an `.xlsx` file stored in Drive into a new spreadsheet.

## Import into an open spreadsheet

This replaces the current spreadsheet's content with the data from the Excel file.

1. Open the spreadsheet you want to replace.
2. Click **File** in the top-left of the menu bar.
3. Click **Import xlsx file…**.
4. A dialog opens. You can either:
   - Browse your Drive to pick an `.xlsx` file you have already uploaded, then click **Select**.
   - Click **Upload from device** to open a file chooser and pick an `.xlsx` file from your computer.

Sheets loads all the sheets from the workbook and replaces the spreadsheet's content straight away. The
change is saved automatically.

## Convert an Excel file in Drive to a new spreadsheet

If you have an `.xlsx` file sitting in Drive, you can turn it into a Sheets spreadsheet without opening it
first. This leaves the original file in place and creates a new spreadsheet alongside it.

1. Open [Drive](/drive) and find the `.xlsx` file.
2. Right-click the file (or open the **⋮** menu) and choose **Convert to Sheet**.

Drive creates a new spreadsheet in the same folder and opens it in Sheets.

## What carries over

The import reads every worksheet in the workbook and preserves:

- Cell values (text, numbers, booleans, and dates)
- Formulas
- Merged cells
- Column widths and row heights
- Cell borders
- Text formatting: bold, italic, underline, strikethrough, font size, and text colour
- Fill colours
- Text alignment (horizontal and vertical), text wrapping, and text rotation
- The sheet tab names and their order
- The gridlines setting (hidden or visible)

Fonts from Excel are mapped to the four fonts Sheets supports. Common sans-serif fonts (such as Calibri,
Arial, and Verdana) map to Inter; serif fonts (such as Times New Roman and Georgia) map to Source Serif 4;
monospace fonts (such as Courier New and Consolas) map to JetBrains Mono; Comic Sans maps to Excalifont.

## What does not carry over

The following are not imported:

- Charts
- Images embedded in cells
- Conditional formatting rules
- Data validation rules
- Hyperlinks (the link text is kept, but the URL is dropped)

If these are important, keep the original `.xlsx` file in Drive so you have a reference copy.
