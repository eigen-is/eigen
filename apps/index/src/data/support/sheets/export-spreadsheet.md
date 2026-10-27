---
title: "Download a spreadsheet"
description: "Save a copy of your spreadsheet to your computer as an Excel workbook, a PDF, or a web page."
type: how-to
tags: [sheets, export, download, excel, xlsx, pdf]
related: [sheets/import-excel, sheets/get-started]
order: 160
updated: 2026-10-27
---

You can download a copy of any spreadsheet to your computer without removing it from Eigen. Three formats are available: Excel, PDF, and web page.

## Download a spreadsheet

1. Open the spreadsheet in Sheets.
2. Click **File** in the top-left of the menu bar.
3. Hover over **Download** to open the submenu.
4. Choose the format you want:
   - **Microsoft Excel (.xlsx)** saves the workbook in the standard Excel format. All sheets are included, and hidden sheets stay hidden.
   - **PDF (.pdf)** saves each visible sheet as a page in a single PDF document.
   - **Web Page (.html)** saves the visible sheets as an HTML file you can open in a browser.
5. An **Exporting document** progress bar appears while Eigen prepares the file. When it is ready, your browser downloads it automatically.

The downloaded file takes the name of the spreadsheet.

A PDF or web page shows a cell that mixes several styles in the cell's own style. A very large spreadsheet is cut short in the PDF and the web page, which leave out the cells and sheets past a size limit. Even cut short, a PDF of a very large spreadsheet can take too long to make and fail. To keep every cell, download it as Excel.

## What carries over to Excel

When you download as **Microsoft Excel (.xlsx)**, the following are preserved:

- Cell values: text, numbers, booleans, dates, and formulas
- Number formats
- Merged cells
- Column widths and row heights
- Cell borders
- Text formatting: bold, italic, underline, strikethrough, font, font size, text color, and fill color, also where one cell mixes several styles
- Text alignment, text wrapping, and text rotation
- The sheet tab names, colors, and order
- Hidden gridlines (if you hid them)
- Conditional formatting rules, data validation rules, and hyperlinks (Google Sheets doesn't show top or bottom, above-average, duplicate or data-bar rules)
- Charts, as charts you can edit in Excel (a rotated chart sits upright)
- Images, over the same cells and at the same angle, in front of or behind the charts as in Sheets. A WebP image is saved as PNG or JPEG, since Word, PowerPoint and Google's editors can't show WebP
- Frozen rows and columns, and the range a filter covers (the values ticked in each column's dropdown are not carried over)

## What to use each format for

- **Excel**: share with people who use Microsoft Excel or another spreadsheet app, or keep an offline backup you can edit elsewhere.
- **PDF**: send a version people cannot easily change, such as a report or a table for a presentation.
- **Web Page**: embed the spreadsheet in a web page or archive its appearance at a point in time.

There is no CSV export. To get data out as CSV, download as Excel and then save as CSV from Excel or another spreadsheet app.
