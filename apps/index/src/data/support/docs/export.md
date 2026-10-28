---
title: "Export to Word, PDF, or HTML"
description: "Download a copy of your document as a Word file, PDF, or web page."
type: how-to
category: Files
tags: [docs, export, download, word, pdf, html]
related: [docs/import-word, docs/print]
order: 90
updated: 2026-10-28
---

You can download a copy of any document as a Word file, a PDF, or a standalone web page. The original document in Eigen stays exactly as it was.

## Export from inside the document

1. Open the document.
2. Click **File** in the toolbar.
3. Hover over **Download** to open the format submenu.
4. Choose one of the three formats:
   - **Microsoft Word (.docx)**: opens in Word, Pages, or any compatible word processor.
   - **PDF (.pdf)**: a fixed-layout version suitable for printing or sharing.
   - **Web Page (.html)**: a standalone HTML file with embedded fonts and images.

A progress dialog appears while the file is being prepared. Your browser downloads the file automatically when it is ready. The file is named after your document.

When the file leaves something out or draws it simpler, a message says so after the download, for example "1 chart was left out of the file; 2 charts were simplified." It also says when part of the document couldn't be read and is missing from the file.

## Export from Drive

You do not need to open the document to export it. In Drive, right-click the document (or click the **⋮** button next to it) and hover over **Download**. Choose the format you want. The same three formats are available.

## What is included

The exported file contains the document text and all formatting: headings, lists, tables, images, charts, code blocks, and other content. Code blocks keep their colors. Code blocks with no language set keep them up to about 65,000 characters of code in all. Past that, they are exported as plain text. Comment threads are not included in the exported file. In the Word file, a chart is a Word chart with its numbers, kept the way Word keeps a chart's data. A sketched, hatched, or dashed look is drawn plain, and a gradient background becomes its middle color. A WebP image is saved as PNG or JPEG, since Word, PowerPoint and Google's editors can't show WebP.

The PDF and the Word file put the header and footer on every page, with the page numbers and page count filled in, and give the first page its own when you set one. The web page shows the header at the top and the footer at the end, with **#** for a page number. See [Add headers, footers, and page numbers](/support/docs/headers-and-footers).

A text box looks in the PDF and the web page as it does in the editor, and is a Word text box in the Word file. A box whose text runs past the height you set grows to fit it in Word too. See [Add text boxes](/support/docs/text-boxes).

Footnotes print at the bottom of their page in the PDF and are Word footnotes in the Word file. When a document has more than 1,500 footnotes, or one footnote longer than a page, the PDF lists them all at the end instead, as the web page does. The web page numbers them in the text and lists them at the end, each linking back to its place.

A page break starts a new page in the PDF and the Word file. Equations show in all three formats. A PDF draws up to 1,000 different equations; past that, or when the equations are very large, the rest print as one-line text, such as `(a+b)/2`. The web page download and the preview in Drive have a similar limit, which only far larger documents reach. In all three formats, links to other files in Eigen point to your Eigen server, and a numbered list keeps the number it starts at and its style (1, a, A, i, or I).

A download carries the images the document shows. When they add up to more than 200 MB, Eigen refuses the download with "This document's images are too large to export".

The PDF, the web page, and the Word file use the editor's spacing, including the space around images and tables. In the PDF, a list next to an image that floats left or right starts below the image instead of beside it. An image behind or in front of the text near the end of a page is cut off at the paper's edge, or left out, since it doesn't continue on the next page, and one whose paragraph runs over two pages prints on the first. In the Word file:

- The fonts your document uses are included, so it keeps its typeface on a computer that doesn't have them.
- Paragraphs keep their line spacing, the space before and after them, and their indents. The first paragraph of a list item follows the list's indent.
- Images keep their width, alignment, and caption. An image that floats left or right floats in the Word file too, with the text wrapping around it. An image or a chart behind or in front of the text stays behind or in front of it, at its place relative to its paragraph.
- Numbered lists keep their numbers, and task lists keep their checkboxes, ticked or not.
- Tables keep their column widths, borders, and cell colors, and a header row repeats on every page.
- Quotes keep the bar along their left edge.
- Equations become Word equations that you can edit in Word, and a displayed one stays on its own line. The LaTeX you typed stays behind, since Word has no place for it, so after a round trip through Word the **LaTeX** field shows Eigen's way of writing the equation, which may differ from yours.

The PDF, the web page, and the Word file use the document's paper size, orientation, and margins, as set under **File → Page setup…**. A page-less document prints on that paper too, with its header, footer and page numbers, and in the PDF and the web page a table wider than the text shrinks to fit the page. Its Word file keeps the table's width.

<div class="eigen-callout">

PDF export requires WeasyPrint to be installed on your Eigen server. If the download fails when you choose PDF, ask your administrator to check the server setup.

</div>
