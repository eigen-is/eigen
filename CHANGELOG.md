# Changelog

All notable user-visible changes to Eigen are documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

### Added

- **Slides on a phone** — a row of slide thumbnails sits under the slide. Tap one to jump straight to it
- **SmartArt in PowerPoint files** — a SmartArt graphic comes into Slides as the shapes and text PowerPoint shows, each one a shape you can move, resize and edit. Editing its text doesn't rearrange the others
- **SmartArt saved without its shapes** — a graphic saved that way, as LibreOffice saves one, leaves its **SmartArt not imported** box with the graphic's text listed in it
- **Bra-ket notation in equations** — a Docs equation reads `\bra{\phi}`, `\ket{\psi}` and `\braket{\phi|\psi}`, and `\expval`, `\mel` and `\ketbra` for expectation values, matrix elements and outer products. Their brackets grow with what's inside them
- **Images behind or in front of the text** — in Docs, put an image or a chart behind the text or in front of it and drag it anywhere on the page. It moves with its paragraph when you type above it
- **Image layouts on a phone** — **Format → Image** has every way to place an image: in line, wrapped left or right, behind or in front of the text
- **Word files** — an image or a chart behind or in front of the text stays there when you import a Word file or download a document as Word
- **Table borders in Docs** — give the selected cells all borders, a box around them, or none, and pick the border color, in the **Table** panel or under **Format › Table**. A row or column you add takes the borders and fill of the one beside it
- **Table borders in Word files** — a Word table keeps its borders, their colors, widths and dashes, when it comes in and when you download a document as Word. A table without borders in Word has none in Docs
- **Styling part of a cell in Sheets** — while you edit a cell, select some of its words and make them bold, italic, underlined, struck through, or another color, font or size. **Ctrl+B**, **Ctrl+I** and **Ctrl+U** (Mac: **⌘B**, **⌘I**, **⌘U**) work as you type, and a style you pick with no words selected applies to what you type next. Text you type or paste over selected words takes their style, and text you paste comes in as plain text, as in Google Sheets. The cell keeps its styles when you download it as Excel
- **Outline in Docs** — **Tools → Show outline** lists the document's headings on the left, over the document, and a click jumps to one. It stays shown or hidden in your browser from one document to the next. On a phone it opens from the **⋮** menu
- **Table of contents in Docs** — **Insert → Table of contents** lists the document's headings to Heading 3, and keeps the list up to date as you or anyone else edits them. Click a line to jump to its heading. The PDF shows each heading's page number, and the Word file holds Word's own table of contents, which fills in its page numbers when Word updates it. Reload a document left open since the update before you add one, or the older tab removes it
- **Tables of contents in Word files** — a Word file's table of contents comes in as one that lists the document's headings. The message after an import says when those differ from the entries Word saved
- **Celebrations** — tick the last box of a card's checklist in Stickies, or of a comment card elsewhere, and now and then confetti bursts from it. Turn it off on the **Preferences** page in Space
- **Page-less documents in Docs** — **File → Page setup…** has **Pages** and **Page-less** tabs, as in Google Docs, and **Format** switches between them. A page-less document is one continuous column of text without page breaks, headers or footers, for everyone who opens it. It still prints on its paper
- **Text width** — in a page-less document, pick **Narrow**, **Medium**, **Wide** or **Full** on the **Page-less** tab. The width is yours: it follows you to every page-less document and device, and the people you share with keep theirs
- **Wide tables and images** — in a page-less document a table can grow past the text and scrolls sideways, and an image or a chart can be as wide as the paper. A Word file saved in Web Layout opens page-less with its tables at their widths, and a page-less document downloads as a Word file in Web Layout
- **Preferences in Space** — a page of its own, right below Personal info, where you pick the theme (Light, Dark or System) and turn Celebrations on or off
- **What a download left out** — after you download a document, spreadsheet, deck or drawing, a message counts what the file left out, cut short or drew simpler, such as a hatched fill a PowerPoint file draws solid. It also says when part of the document couldn't be read
- **What a printout left out** — printing a Docs document gives the same message once the PDF opens
- **Italic and underline shortcuts in Sheets** — select cells and press **Ctrl+I** or **Ctrl+U** (Mac: **⌘I**, **⌘U**) to make them italic or underlined, as **Ctrl+B** makes them bold
- **Chart data labels** — in Docs, Sheets, Slides and Vector, the **Data labels** box in a chart's **Series** section writes each value on a column, bar or line chart, in the values' number format. Labels that would overlap hide, and the bigger bar keeps its own
- **Data labels in Office files** — a chart's data labels come in from Excel, Word and PowerPoint files and go out when you download one
- **Image and chart size in Docs** — the **Image** and **Chart** panels set the width and the height in centimeters, with **Keep aspect ratio** as in Slides. Uncheck it to stretch an image, which keeps that size when you print, download it as PDF, a web page or Word, or open the Word file again
- **Text boxes in Docs** — **Insert › Text box** adds a box with paragraphs of its own, which you type in right where it stands. Put it on its own line, beside the text, or behind or in front of it, and drag it anywhere on the page
- **A text box's look** — the **Text box** panel sets a box's size, fill, outline and rounded corners, the space around its text, and whether its text sits at the top, middle or bottom. The box grows when its text needs more room
- **Text boxes in Word files** — a Word text box comes into Docs as a text box, at its place and with its look, and a document downloads as Word with Word's own text boxes. A text box in a header, footer or footnote, or in a group or a drawing canvas, still comes in as its text

### Changed

- **Labels in sentence case** — buttons, menus, dialog titles and fields in Admin, Calendar, Chat, Contacts, Docs, Drive, Mail, Sheets, Space and Stickies capitalize only the first word and names, such as **New event**, **Reply all** and **Web page (.html)**, as the rest of Eigen already does
- **Open documents after the update** — reload any Docs document you have open: a tab still on the previous version deletes the text boxes it receives
- **Forwarding email** — a forward brings the original's attachments along, pictures in the message included. Take one off with the **X** on its chip before you send
- **Space home** — an admin gets an Admin tile next to the apps. The **Help and support** tile takes the help center's teal
- **Help center colors** — the Admin section wears the Admin app's color, and a section page shows its title in its section's color, such as amber for Mail
- **Contacts** — the contact list fills the page until you open a contact. Its details then open beside a narrower list, and **Close** returns to the full list. A link to a contact that was deleted opens to **Contact not found**
- **Admin teams** — teams have their own list page, like users, instead of a list in the sidebar. Create a team with the **+** next to the search bar, and click a team to open its details
- **Adding people to a team** — dragging users onto a team is gone with the sidebar list. To add several people at once, select them on the **Users** page, right-click and choose **Add to team…**. A team's **Members** section still adds one person at a time
- **Admin users** — a user's details list their teams under the role, leaving out the team named after your organization that everyone joins. Add the user to a team with **Add to team**, or take them out of one with its **×**
- **Spreadsheet PDF** — a sheet too large for the PDF keeps the columns one page holds, 192 at the default width, because the page cuts off the rest. A web page download keeps more columns while all of the sheet's rows fit
- **Links** — a link is underlined, as in Word and Google Docs: in Docs, its previews and its web page and PDF downloads, and in Stickies, the email you write in Mail, the help center and the blog. A footnote's number and its ↩ in a web page download stay plain
- **Number fields in Slides and Vector** — a number in the side panel shows at most two decimals, and the line height and letter spacing show at least one, such as 1.0. While you type, the field shows what you typed
- **Spreadsheet downloads** — a cell's text stays inside its row in a web page or PDF download, as it does in the editor. A wrapped cell taller than its row shows the part that fits
- **Tables in Docs** — a table keeps its column widths when wider margins, a turn to portrait or a smaller paper size leave less room for the text, and scrolls sideways inside the page instead of shrinking. A table in a list or a cell still shrinks to fit. When you print or download a PDF, a table wider than the page shrinks to fit it
- **Page setup in Docs** — the margins show two decimals, such as 2.00 cm
- **Shortcuts in the Sheets menus** — the **Edit** and **Format → Text** menus show each shortcut next to its item, such as **⌘B** for bold on a Mac and **Ctrl+B** elsewhere
- **Menus in Docs, Sheets, Slides, Vector and Stickies** — with one menu open, point at another, such as **Edit**, to open it, or move across with the left and right arrow keys. One click on **Edit** while **Format** is open opens **Edit**, and so does one click on a menu while the font or style picker is open. A click outside an open menu also reaches the page, such as selecting a cell

### Fixed

- **Picking a theme** — the new theme shows the moment you pick it in the account menu or on **Preferences**, without a **Settings saved** message
- **Color scales in Sheets** — a color scale whose colors are written short, such as `#f00`, shades its cells instead of leaving them blank
- **Sharing a calendar** — when the owner stops sharing a calendar with you, the list of who has access refreshes at once, as it does when they share it
- **Contents title in Word files** — the title Word puts above a table of contents, such as **Contents**, comes in as normal text instead of a Heading 1, so it no longer lists itself in the outline
- **Trash in Drive** — a file or folder deleted for good disappears from the Trash open in your other tabs too
- **Unread counts in Mail** — a message you read in another mail app clears its unread count in Eigen's sidebar at once
- **Saving a text file in Drive** — when someone else changed the file since you opened it, even within the same second, Drive shows **File conflict** instead of overwriting their change
- **Recent activity in Drive** — saving a text file in Drive's editor shows as edited, not as an upload
- **Long tables in Docs PDFs** — a table too tall for what is left of a page starts there and continues on the next page, instead of jumping whole to the next page and leaving a gap. A tall row splits across the pages too, as Word does by default
- **Pasted photos in Docs downloads** — a web page or PDF download draws a pasted image without the camera details and location it carried, as the Word download already did. An animated GIF pasted that way shows its first frame, and one pasted in a form the download can't clean is left out
- **Merged cells in spreadsheet previews** — a merged cell too wide or too tall for the Drive preview, or for a download cut to fit, shows no border where the preview cuts it off
- **Spreadsheet previews** — an image or chart on a sheet with hidden columns shows in the Drive preview when it sits within the preview's first 50 visible columns
- **Search in Sheets** — searching your files finds a spreadsheet by a chart's title, axis titles and series names
- **Comments in downloads** — a Docs web page download and the Drive preview show commented text without its yellow highlight, as the PDF and Word downloads already do
- **Shared with me in Drive** — a text file or folder someone shared with you shows its full path at the top, starting with Shared with me, then the shared folder and every folder below it. Click Shared with me to go back to the list
- **Public files in Drive** — a public file or folder that nobody shared with you shows its path from the first folder you can open, without Shared with me
- **100% stacked charts in Office files** — a 100% stacked chart downloaded as Excel, Word or PowerPoint shows its axis from 0% to 100%, also when its numbers have a format of their own
- **Closing a shared text file** — closing a text file that was shared with you on its own takes you back to Shared with me instead of a page asking for access to its folder
- **Text files on a team drive** — the path above the file starts with the team drive's name, as its folder does, and each folder in it opens that folder
- **Excel named ranges** — a formula that uses a named range, such as `=SUM(Sales)`, keeps working after you edit the cells it reads, and a dropdown list from a named range comes in as a list. Sheets writes the cells the name stands for into the formula, so the name itself isn't kept. A named range that points at another workbook or at several separate ranges is counted in the message after the import
- **Excel files** — a row whose height is set to normal in Excel comes in at normal height, even when its text wraps. A spreadsheet you download as Excel keeps the row heights Eigen shows
- **Spreadsheet PDF** — a spreadsheet with thousands of small sheets prints its first 2,000 sheets instead of failing
- **Long code blocks** — a Docs document with many long code blocks and no language set downloads and previews at once. Past about 65,000 characters of such code in all, the rest comes without syntax colors
- **Copied charts** — a chart you copy from Sheets into Docs, Slides or Vector keeps the number format of its axis, so a column of percentages reads 25%, not 0.25
- **Sheets undo while others edit** — undo changes your own cell where it now is after someone else inserts or deletes rows or columns, or deletes another sheet, formulas pointing at the moved rows included. It skips a cell someone else changed after you, and a formula still undoes when someone changed a cell it reads. Undoing or redoing your own row, column or sheet change keeps the edits others made since, and everyone sees the same result. Undoing a row delete brings back the formulas it broke, on every sheet. Closing a spreadsheet leaves everyone else's view and undo history as they are
- **Delete in Sheets** — Delete and Backspace clear what the selected cells hold and keep their formatting, such as colors, bold and number format, as in Excel and Google Sheets. A link goes with its text
- **Errors in Sheets formulas** — an error you type into a formula, such as `#N/A`, is a value a function can check, so `=ISERROR(#N/A)` gives TRUE and `=ERROR.TYPE(#N/A)` gives 7, as in Excel. A function Excel lacks in a Google Sheets file saved as Excel shows #NAME? instead of #ERROR!
- **Resizing a chart in Sheets** — a chart stretches as you drag its corner and draws sharp at its new size when you let go, so a large sketched chart keeps up with the pointer
- **Sheets edits from others** — someone else's edit shows up for you, also on a sheet you never opened, such as a fresh copy or a sheet brought back with undo, and while your spreadsheet is still opening or reloading. A copy you never opened comes back with its cells when you undo its delete
- **Sheets undo** — after an undo or redo, every formula it touches shows the value its cells give now, also when someone else changed one of them in the meantime
- **Sheets** — a cell you are typing in moves with its row or column when someone else inserts or deletes rows or columns above it, so pressing Enter writes into your cell and not into theirs. If they delete your cell, the edit closes
- **Sheets** — a formula that points at another sheet follows the rows and columns someone inserts or deletes there in downloads, previews and for whoever opens the spreadsheet next, as it does on screen
- **Spreadsheet PDF** — a sheet with one cell of thousands of lines prints on one page instead of thousands
- **Spreadsheet downloads** — a spreadsheet with very many charts or pictures downloads as a web page or PDF with the ones that fit and leaves the rest out, instead of failing. Its preview shows the charts that fit instead of nothing
- **Sheets** — a wrapped cell that mixes styles, such as one from an Excel file, breaks its lines between words instead of keeping a long styled stretch on one line
- **Sheets** — turning on **Format → Wrapping → Wrap**, or picking a bigger size in the font size box or **Format → Font size**, makes the row tall enough for the cell's text
- **Deleting a team in Admin** — deletes the team's drives with every file on them, and its calendar, instead of leaving them on the server. While a backup or a restore of the team runs, the team can't be deleted, and the team named after your organization, which everyone joins, can't be deleted at all
- **Sheets shortcuts on other keyboard layouts** — on Dvorak, **Ctrl+C** (Mac: **⌘C**) copies the selected cells and **Ctrl+X** (Mac: **⌘X**) cuts them, instead of doing nothing or making them bold. On a Russian or Greek layout, **Ctrl+B**, **Ctrl+I** and **Ctrl+U** style the words you select while typing in a cell. On a Mac the shortcuts take **⌘**, not Ctrl, as in Docs
- **Undo while you type in a cell** — in Sheets, **Ctrl+Z** (Mac: **⌘Z**) in an open cell undoes your typing and leaves the spreadsheet's earlier changes alone
- **New events late in the evening in Calendar** — a new event made after 23:15 ends half an hour after it starts, on the next day, instead of before it starts. Turning off **All day** that late does the same

## [0.4.0] - 2026-10-26

Eigen now opens and saves Word, Excel and PowerPoint files. Docs gets equations, page setup, headers and footers, and footnotes. Docs, Sheets, Slides and Vector get charts. After you update, reload any document you have open, or a tab still on 0.3.3 deletes the equations, footnotes and charts it receives.

### Added

- **PowerPoint files** — convert one to a Slides deck in Drive, import one into the deck you have open, or download a deck as PowerPoint. Shapes, pictures and backgrounds come along
- **Word files** — keep their equations, headers and footers, footnotes and page setup
- **Excel files** — keep their hidden sheets, tab colors and pictures, both when they come in and when you download a spreadsheet as Excel. A cell with more than one format in its text, such as one bold word, comes in with it
- **Charts in these files** — come in as charts you can edit, not as pictures, with their background, text color, line color and line widths
- **Charts in downloads** — a chart in a Word, Excel or PowerPoint download is a chart there too, not a picture, with bars as wide as Eigen draws them. A sketched, hatched or dashed chart draws plain, a gradient background takes its middle color, a rotated one sits upright, and a see-through one on a slide is solid
- **Chart data in Word and PowerPoint downloads** — a chart keeps its numbers in a small spreadsheet inside the file, the way Word and PowerPoint keep a chart's data
- **Import into a spreadsheet or deck** — add a file's sheets or slides to the one you have open, or replace it with the file. Eigen saves a version before it replaces anything, so you can go back
- **What didn't come across** — after you import a file into an open document, spreadsheet or deck, a message counts what Eigen left out or simplified, such as a chart it can't draw
- **Pictures left out** — a Word or PowerPoint picture Eigen can't bring in leaves a **Picture not imported** mark where it was, in Docs and in Slides, so you can see what is missing. A chart Eigen can't draw leaves a mark too
- **Equations** — write math in Docs in LaTeX and watch the preview as you type, or pick symbols from the menus above the field. An equation sits in line with the text or on its own line
- **Pasted math** — math copied from Word for the web, or from most web pages that show math, pastes as an equation you can edit
- **Equations in downloads** — PDF, web page and Word downloads keep your equations
- **Charts** — add a column, bar, line or pie chart in Docs, Sheets, Slides and Vector. **Edit data** opens its numbers in a small sheet
- **Chart axes and stacking** — hide an axis, reverse the order of the categories, or stack a column or bar chart, plain or to 100%
- **Charts in Sheets** — a chart follows the cells it shows, so it changes when they do. You move, resize, rotate and stack it the way you do a picture
- **Copying charts** — a chart you copy into another Eigen app stays a chart you can edit
- **Chart style** — a chart takes the same fill, stroke and sketch style as a shape. In Vector and Slides you can turn one into shapes
- **Download image** — right-click a chart, or a selection in Vector or Slides, to save it as an SVG picture. This works when you can only view, too. The text in the picture stays real text
- **Page setup** — choose the paper size, orientation and margins in Docs. The editor, printing and every download use them
- **Slide size** — switch a deck between widescreen 16:9 and standard 4:3
- **Headers and footers** — add them in Docs, with page numbers and a page count. The first page can have its own. They show on every page when you print, and in PDF and Word downloads
- **Footnotes** — add numbered notes in Docs. In a PDF they print at the bottom of their page. A document with more than 1,500 notes, or one longer than a page, lists them after the text instead
- **More formatting in Docs** — line and paragraph spacing, indents, a font size box on the toolbar, and a background color for table cells
- **Normal text in Docs** — **Update 'Normal text' to match** gives all normal text the look of the text at your cursor
- **New functions in Sheets** — XLOOKUP, XMATCH, TEXTJOIN, MAXIFS and MINIFS calculate, and so do Excel's dotted names such as STDEV.S and NORM.DIST
- **Download from the command palette** — with a document selected in Drive, ⌘K offers **Download as** in each format its File › Download menu has

### Changed

- **Find and replace** — ⇧⌘H opens it in Docs, Sheets and text files in Drive, as in Google Docs. In Docs, ⌥⌘F now inserts a footnote
- **Printing from Docs** — Eigen prints through a PDF, so headers, footers and page numbers print too. Offline, with edits not yet saved, or when the PDF fails, it says so and prints from the browser without them
- **Nested numbered lists** — number by level, as in Google Docs: 1., then a., then i. A nested list that showed 1. 2. 3. on every level now shows a. or i. on the deeper levels. To keep 1. 2. 3., pick that style for the list again
- **Text in Sheets** — long text spills into the empty cells next to it
- **Alignment in Sheets** — numbers and dates line up on the right, and TRUE, FALSE and errors in the middle, unless you align them yourself. A tick box sits in the middle of its cell, or on the left when it has a label
- **Column widths in Sheets** — an imported Excel file's columns are as wide as they are in Excel
- **Font size in Sheets** — the size box takes any size from 1 to 400 points, half points too, where it stopped at 6 and 96
- **Font sizes in Slides** — sizes and letter spacing show in points, so a 44 pt PowerPoint title reads 44. The stroke width is a number you type, in Slides and in Vector
- **Sizes in Docs** — an image's width and the size shown while you resize a picture or chart are in centimeters
- **Vector downloads** — File › Download › **SVG image** draws the SVG in your browser, with its text as real text. Drive and the command palette offer a drawing as PDF only
- **Large workbooks** — an Excel file with many sheets, rows or merged cells imports as long as the file fits Eigen's size limits. There is no longer a separate limit on sheets, rows or merged cells
- **Password-protected files** — an Excel or PowerPoint import tells you the file has a password, and to remove it there, as a Word import does
- **Menus** — right-click and ⋮ menus order their items the same way in every app. In every menu, Delete comes last and in red
- **Choices in menus** — where you pick one of several options, the submenu shows a check next to the current one
- **Right-click menus** — shapes and pictures in Slides and Vector get more of their actions in the right-click menu. In Docs, tables, pictures, charts and equations get a right-click menu of their own
- **Accent colors** — calendars, labels, collaborators' cursors and now charts take their colors in a new order. It starts with Eigen's pink, and colors next to each other are easy to tell apart, also for color-blind readers. Collaborators' cursors take new colors
- **Clear formatting** — in Docs it keeps comments and links, and ⌘\ runs it
- **Server memory** — an open document's live connection holds about 8 KB of the server's memory while idle, where it held about 189 KB

### Fixed

- **Access** — when someone changes your access to a document you have open in Docs, the editor follows right away: it turns read-only when you lose write access, and editable when you get it. This holds for a change on a folder above the document or on its drive too
- **Team drives** — edits made in an open document stay saved when an admin gives its team drive new storage or turns the drive off
- **Settings** — two settings changes saved at the same moment both stick, and neither shows an error
- **Links in Docs** — a collaborator's edit or an undo no longer turns a file name like plan.md into a link
- **Wrapped images in Docs** — a wrapped image leaves room for the text and lists beside it
- **Tables in Word downloads** — a table you download as Word and import again keeps its column widths. This holds for a table inside a cell and for a table without set widths too
- **Copying from Sheets** — cells you paste into another app keep their rows and columns
- **Pasting in Sheets** — a pasted cell keeps its font, or takes the closest one Eigen has
- **Keys in Sheets** — Tab and Ctrl+arrow move the way they do in Excel and Google Sheets
- **Mixed formatting in Sheets** — a cell with more than one format in its text, such as one bold word, counts in sorting, filters and formulas
- **Formulas in Sheets** — INDEX, TEXT, FIND, SEARCH and a skipped argument, as in SUM(1,,2), give the answers Excel gives. Insert function and autocomplete offer only functions that calculate
- **Newer Excel functions** — IFS, IFNA, XLOOKUP and Excel's other newer functions in an imported file calculate, where they failed. An Excel download writes them so Excel calculates them too
- **Images in Sheets** — Delete removes a selected image, and an image that failed to load can be selected and deleted too
- **Hidden sheets in downloads** — a web page or PDF download of a spreadsheet leaves out its hidden sheets, as Excel prints them
- **Empty sheets in downloads** — an empty tab prints no blank page
- **Slides and Vector PDFs** — a PDF of a deck or a drawing prints all of its text and every see-through shape
- **Blank lines in text boxes** — a blank line in a Slides or Vector text box keeps its height in downloads and previews
- **Dragging shapes** — in Slides and Vector, dragging a shape moves it even while text on the page is selected, instead of dragging that text
- **Renaming and moving** — on local storage, a rename or move that fails leaves the file under its old name, instead of out of reach. An upload waiting behind a rename no longer writes over the renamed file
- **Trash** — on local storage, a trash or restore that failed or was cut short by a crash finishes when you try it again, instead of leaving the file out of reach
- **Trash** — a file you restore while the Trash is being emptied either comes back or is reported gone. It is never reported restored and then deleted
- **Trash** — emptying the Trash finishes when it holds a folder and items trashed from inside it, instead of stopping halfway
- **Trash** — a drive that closes while it clears out expired trash leaves no deleted files behind in its S3 bucket
- **Trash** — someone who opens a document while you trash it waits and then finds it in the Trash, instead of typing edits that are lost
- **Trash** — a chat in the trash restores with all its messages, even after someone tried to open it there
- **Sharing** — an item in the trash is closed to everyone you shared it with, and nobody can share it on from there. Restoring it gives them the same access again
- **Trash** — a file you create, upload, copy or move into a folder while someone trashes it is refused as not found. It no longer stays live inside the trashed folder
- **Trash** — deleting a folder for good also takes the items you trashed from inside it off every open Trash view, and tells the people who watched them
- **Sharing** — a trash that fails, such as when storage is down, leaves the item in your collaborators' **Shared with me**
- **Sharing** — someone you remove from an item while it is renamed or restored stays removed from their **Shared with me**
- **Sharing** — moving an item needs edit access to the folder it leaves, as renaming it does. Someone who can edit only the item can't take it out of your folder
- **WebDAV** — a file or folder you have no access to answers the same as one that doesn't exist, so nobody can guess the names in your drive
- **Guests** — a guest can't send mail to a file's collaborators, as a guest can't share. The File menu and Drive don't offer them **Email collaborators**
- **Copying documents** — opening a copy of a document before the copy is done waits for it. The copy then finishes with all of its content, instead of stopping halfway with an empty document
- **Uploads** — two files of one name created in one folder at the same moment, such as two uploads, keep the first file's contents on local storage. The second is refused as a duplicate
- **Uploads** — on S3 storage, a file added to a folder someone deletes for good at that moment is refused as not found, and leaves nothing behind in storage
- **Folder sizes** — a folder shows the right size after two moves of a file in it at the same moment
- **Large files** — a file too large for the server's memory to import, export, preview or index is refused, instead of taking the server down
- **Calendar** — looking up the calendar of a guest or of the organization answers that you have no access, instead of failing with a server error
- **Calendar** — looking up the calendar of an account that doesn't exist answers the same as one you can't see, so it doesn't tell which accounts exist
- **Excel theme colors** — a lighter or darker shade of a theme color, such as Text 2, Lighter 40%, comes into Sheets in the color Excel shows. A file you imported before keeps its old colors until you import it again
- **Very large spreadsheets** — a web page download of a spreadsheet draws up to 250,000 cells, shared by its sheets in tab order, instead of running until the export fails. A sheet cut short keeps one PDF page of columns, or more when all its rows fit, then the rows that fit. A sheet with too few cells left is left out. A PDF download is cut the same way, but a PDF of a very large spreadsheet can still fail
- **Merged cells in spreadsheet downloads** — a merged cell over a hidden row or column keeps the table's columns in line in the web page, PDF and preview, and shows its text and its outer border even when its first or last row or column is hidden
- **Long code blocks** — a Docs code block longer than about 65,000 characters, with no language set, downloads at once without syntax colors, instead of stalling the export

## [0.3.3] - 2026-10-13

Eigen reads and writes Word files itself, and Docs gets Google Docs' menus, with page breaks, Title and Subtitle, small caps, word count and resizable table columns. The update migrates each user's mail index, `mail.db`, and an older version can't open the migrated one. To go back, restore the backup the update made: run `./eigen rollback` right after the update, or later `./eigen restore` with the `server-pre-update-` backup that `./eigen rollback --help` lists. Reload open documents after the update: a tab still on 0.3.2 deletes the page breaks, titles and subtitles it receives.

### Added

- **Docs menus** — Format and Insert are always on screen when you can edit, with the submenus Google Docs has. Edit and Tools join them
- **Page break** — Insert → **Page break** or ⌘Enter starts a new page in print, PDF and Word, and a Word file's page breaks come in
- **Paragraph styles** — Title, Subtitle, Heading 5 and Heading 6. They survive a trip to Word and back
- **All caps and Small caps** — under Format → Text, ⌘⇧A for all caps. PDF, Word and paste keep them
- **Word count** — Tools → **Word count** or ⌘⇧C, for viewers too
- **Lists and alignment** — five numbered styles and **Restart numbering** under Format → Bullets and numbering, and **Justified** in the Align menu (⌘⇧J)
- **Tables and images** — drag a column border to resize it, or **Distribute columns**. The Image panel has a Width field, and Shift+arrows resize a selected image
- **Page setup** — File → **Page setup…** shows the page every document uses: A4 with 2 cm margins
- **Mail** — a message opens without the images it would load from the internet, so its sender can't tell when you read it. **Load images** shows them for that message
- **Command palette** — ⌘K offers **Download as** in each format of the open document's File → Download menu
- **Teams** — an access request on a team's drive reaches the team's members, by notification and email, unless **Notify members** is off on the team's Admin page

### Changed

- **Word export** — Eigen writes the `.docx` itself: fonts embedded, figures with their wrap and caption, lists with their start and style, task boxes, code blocks, quotes, page breaks and pasted images. Images go in as PNG or JPEG, without their EXIF data
- **Word import** — Eigen reads the `.docx` itself instead of through a third-party library. SmartArt text and chart titles come in, East Asian and right-to-left text gets its fonts, wide tables fit the page, and a password-protected file says so. Imported images count toward the drive's storage
- **Docs toolbar** — the icon row folds into the menus as the window narrows. Strikethrough, code, superscript, subscript, quote, line and table live in the menus
- **Docs look** — Heading 5 and 6 draw in Google's grey at body size, Heading 6 in italics. The page stays light in dark mode, in quick look and thumbnails too
- **Copy and paste in Docs** — a paste from another document keeps its formatting and images and drops its comments. A pasted font like Georgia becomes the bundled one
- **Sheets import** — a workbook with more than 10,000 merged ranges, 500 sheets or about 2 million rows is refused as too large
- **Notifications** — the bell keeps every unread notification, not only those among the newest 50. The new-mail notification goes read once the inbox has no unread mail
- **Mail** — a reply marks the message it answers as answered, also when sent later from Drafts, and the mail list shows a reply arrow. A reply or forward quotes the message's text and links, never its images
- **Calendar** — removing every guest from one occurrence of a series keeps the series' guests, and the event dialog says so. To leave them out, remove that occurrence
- **Contacts** — when a contact changes elsewhere while you edit it, the form keeps your edits and offers **Reload**. A label name takes at most 100 characters
- **Limits** — WebDAV stores at most 64 KB of properties and 32 locks per file, and a chunked WebDAV upload stops at the max upload size and at what is left of the drive. One share request adds at most 100 people
- **Server settings** — **Max Upload** stops at 1023 MB, since a larger upload was refused anyway. A **Trash Retention** of 0 keeps deleted files until the Trash is emptied
- **Storage quotas** — a drive has one limit, whoever uploads into it: its owner's team overrides raise it, never the uploader's
- **Admin** — the Guests page shows each guest's name, email and when they were last active
- **Mail ports** — 25, 465, 587 and 993 listen on IPv4 only: mail apps and other mail servers reach them over IPv4. 465 and 587 allow 20 sign-in attempts and 60 messages a minute per client IP
- **S3** — a read retries three times on throttling or a server error before it fails
- **Deleting a user** — also deletes the safety copies a restore left of their data, and their files in S3 buckets. A second server restored from a backup of this one must never run on the same bucket
- **`./eigen update`** — makes a Full backup first, without asking, when a release migrates a database a Light backup leaves out. `./eigen stop` waits for a running backup and its upload
- **`./eigen rollback`** — its `--help`, and its refusal when there is nothing to roll back, list the kept pre-update backups
- **Docker image** — the API image is about 340 MB smaller. A source install needs WeasyPrint 68 or later for PDF export

### Fixed

- **PDF export** — bold text and headings print bold again, a centered figure stays centered, a numbered list keeps its start number and a colored link its color, and an open task under a done one is no longer struck through
- **Docs editor** — lettered and roman lists draw again, the toolbar follows the cursor, a selected image drags again, the Image panel stays open while you use it, and **Replace image** no longer replaces another figure
- **Safari** — a document or board no longer reconnects without end and never loads
- **Storage** — on local storage, creating a file in a folder deleted meanwhile no longer overwrites a file of that name at the drive's root. A save into a file trashed meanwhile is refused, and of two saves of a text file from one version, the second gets a conflict
- **Calendar invitations** — an occurrence without a guest list of its own goes out with the series' guests. Cancelling or deleting a moved occurrence cancels its moved time for its guests, and putting a cancelled occurrence back sends no cancellation
- **Calendar editing** — someone the owner shared a calendar with for editing can edit the owner's own events, and an event a member organized on a team calendar stays editable
- **Backups** — a restore gives each mail message its own date again. An item whose name a file cannot have is left out with a warning instead of failing the backup, and a file overwritten during a backup is archived as it was copied. Verify warnings show on the backup's row in Admin
- **Mail** — a row in Sent names the recipient instead of you, and an attachment loads right after a mail client changes its message's flags
- **Lists** — dragging a row that is not selected drags that row, and Space and Enter after Select All act on the top selected row
- **Previews** — an image no longer flashes a checkerboard before the full image, an `.eml` quick look keeps the message's layout, and an `.ics` with too many events is refused
- **Images** — an image in a document or sheet whose file is gone shows as missing, and a Word import's images load on S3 without a reload
- **Small fixes** — Escape in a suggestion list inside a dialog closes only the list. ⌘P with nothing to print prints the page. `./eigen restart` repairs the launcher after an interrupted update. A WebDAV PROPPATCH with a refused change saves nothing. A CalDAV query for one UID answers with that event. A guest who opens a file they cannot see is told to ask the owner. An access request mails the owner at most once an hour. Restoring a spreadsheet version saved in an older format is refused instead of locking its editors. Scrolling back in chat no longer skips messages sent in the same second. An imported vCard with your address no longer becomes your own card. A malformed stickies column no longer breaks the board. Edits recovered after an unclean shutdown get a version. With mail turned off, a user's kept mail still counts toward their storage. Finder can save into a full drive over WebDAV. An HTML mail's preview line no longer shows a tracking-pixel address

### Security

- **Mail relay** — Postfix and OpenDKIM trusted the Docker network's gateway, which the host, Docker Desktop, rootless Docker and every IPv6 client arrive from. Such a client could send mail through port 25 without a login and get mail from your domain DKIM-signed, and the API trusted it too. A program on the host that sent through `localhost:25` now gets "Relay access denied": send through 587 with a login
- **Team mounts** — only team admins see a team's mount settings, S3 secret included, where every member could
- **PDF export** — the renderer opens only `data:` URIs, so a link in a document can no longer make the server fetch a URL or a local file into the PDF
- **Exports and previews** — HTML exports carry a Content-Security-Policy, an SVG can no longer make Firefox load outside URLs, and a sheet cell's color can no longer inject CSS
- **Chat search** — Drive's search index of a chat no longer holds the text of whispers
- **Imports** — a small crafted `.docx` or `.xlsx` can no longer take gigabytes of memory or minutes of CPU, and a slow SVG can no longer hold a thumbnail worker

## [0.3.2] - 2026-10-05

Fixes from a restore drill, and the same edge spacing across the apps. An install still on 0.3.0 updates to 0.3.1 first: `./eigen update 0.3.1`, then `./eigen update`.

### Changed

- **Layout** — lists, toolbars and panes keep the same space at their edges, more of it from tablet size up, so dates and menus clear the scrollbar. The sidebar and the app switcher keep less, and Contacts' letters sit over the avatars
- **Setup** — **Complete Setup** stays clickable, so the browser names a missing field. Each storage choice says what it means, and the sender name shows the organization name until you type one
- **Admin** — a user created on the Users page joins the team named after the organization and gets what was shared with it. The create button is labelled **Create User**
- **`.env.production`** — `./eigen restart` picks up an edit made while Eigen runs. Until then, `./eigen update` and `./eigen backup` refuse, since the backup would hold the old file

### Fixed

- **Mail** — Enter in To, Cc, Bcc or Subject no longer sends the mail. In Subject it moves on to the message
- **Drive** — opening a document without editing it leaves its Modified time alone
- **Setup** — files go under the S3 prefix you set instead of the bucket's root, and **Go to Login** opens the sign-in page
- **Rollback** — the backup `./eigen rollback` restores is kept when it was made with warnings
- **Restore** — it offers to delete what it kept aside only when it kept something. The installer, run with `restore` in a folder that already has an install, tells you to run `./eigen restore` there
- **Small fixes** — the landing page no longer logs a Content-Security-Policy error, an IMAP or DAV sign-in with the account password no longer logs an API key error, and update notes show links as text

## [0.3.1] - 2026-10-02

Whole-server backup and restore. Eigen backs up the whole server every night while it runs, can copy each backup to a bucket of its own, and puts one back with `./eigen restore`, on the same machine or a new one. The steps are in the help center's [Self-hosting section](https://eigen.is/support/self-hosting/get-started). Close every open document before you update from 0.3.0: an edit that has not reached the server is lost, offline edits included.

### Added

- **Nightly whole-server backup** — the owner turns it on in Settings → Backups: every user and team, the settings and databases, `.env.production` and the mail keys, newest seven kept. **Back up now** makes one by hand
- **Backup bucket** — each backup can also go to a private S3 bucket of its own. Keep its keys off the server: a new machine starts from them
- **Backup alerts** — the owner is notified, and `./eigen status` shows it, when a backup fails, misses the bucket or has warnings. A user or team with files gone from storage is backed up without them
- **Restore** — `./eigen restore <backup>` puts a server backup back and keeps the old data aside. On a new machine, run `curl -fsSL https://eigen.is/install | sh -s -- restore <backup>`. Settings → Backups shows both commands
- **One user or team** — restores from their Admin page out of a server backup
- **Download original image** — on every image in docs, sheets, slides and vector, for viewers too. Images in documents take comments
- **Font licenses** — the licenses page lists the bundled fonts with their OFL 1.1 text

### Changed

- **Backups (breaking)** — `./eigen backup` writes to `backups/` instead of `snapshots/` and needs Eigen running: drop any cron step that stops Eigen, and drop `--keep`, which now makes no backup. Snapshots in `snapshots/` no longer restore
- **Update and rollback** — `./eigen update` backs up first and refuses while Eigen is stopped. `./eigen rollback` puts that backup back with its version. After a restore, open tabs reload once
- **Setup** — answer the mail domain question with the domain you already have email on. With mail off and no relay, setup warns that sign-in codes and invitations cannot go out
- **Mail containers** — Dovecot and Postfix warn instead of failing when they cannot share the TLS or DKIM key with group 1000. The DKIM record prints on one line
- **`.env.production`** — becomes mode 0640 for group 1000, so a backup can hold it
- **Slides** — a slide menu on each thumbnail and on empty canvas replaces the + button. `9` opens the image picker in slides and vector
- **Imports and exports** — every one shows a progress dialog
- **Mail** — the list takes the full width while no mail is open
- **Chat** — a guest can no longer invite people to a chat

### Fixed

- **Backups** — a file renamed, moved, trashed or deleted during a backup no longer fails it, nor does a trashed file on a drive that stores files by name. **Verify** passes such a backup
- **Storage** — a save that races a folder rename is no longer lost, a stalled S3 bucket times out, and a document whose stored data is gone says so and offers version history
- **Mail** — a send with no recipients says "Add at least one recipient" and keeps the draft open. A link to a deleted mail says "Email not found"
- **Copy and paste** — a pasted image loads in docs and sheets, a vector or slides text box keeps its fonts in docs, and a refused copy says why
- **Previews** — a text file over 1 MiB says it is too large instead of spinning, a `.vcf`, `.ics` or `.eml` stored as text opens, and quick look keeps its keys over a stickies card
- **Uploads** — WebDAV holds an upload to the max upload size, and the help center's nginx snippet no longer caps uploads at 1 MB
- **Small fixes** — a resolved comment thread stays resolved, Postfix waits for its certificate on a first boot, and a sheet viewer gets no hand cursor over a dropdown it cannot use

## [0.3.0] - 2026-09-25

Self-hosting release. Eigen now installs from prebuilt images with one line, and the `./eigen` launcher updates, rolls back and backs up the server. Slides use the same canvas as eigen|vector>. Mail, calendar and contacts keep exactly what your mail, calendar and contacts apps write, and `.eml`, `.ics` and `.vcf` files open and import everywhere a file shows up. The findings of the September security audit are fixed.

**Breaking** — calendars, contacts, slides and vector drawings don't carry their data over from 0.2.0 (breaking). Events and contact books are dropped, decks open empty, and drawings lose their plain text and fills.

### Added

- **One-line install** — `curl -fsSL https://eigen.is/install | sh` downloads the `./eigen` launcher and runs setup. The host needs Docker and Compose, nothing else. Setup explains its questions, lists the DNS records you need, and ends with a one-time link to the wizard
- **Release images** — five images on GHCR, for amd64 and arm64, pinned by digest in `.env.production`. The resolver is Eigen's own unbound image
- **`./eigen` launcher** — `update` downloads while Eigen runs, takes a snapshot and switches. For a breaking release it shows the notes and asks first. `rollback` goes back one update. `status`, `logs`, `restart`, `stop` and `reset-password` do what they say. `update main` follows the main branch for people who develop Eigen
- **Whole-server snapshots** — `./eigen backup` saves the server to `snapshots/`, in full or light (databases and settings only), and keeps the last three of each. `./eigen restore` swaps one in and keeps the old data aside
- **Backup per user or team** — a Backup section on the admin Users and Teams pages backs up one user or team to a verified archive, without downtime. Verify, download, upload and restore from there. A restore keeps the old data as a safety copy
- **Admin settings** — the organization name, a Server section with version, disk and certificate, and a Mail section with the system sender, **Relay sends as users** and **Send test mail**. Admin Users lists past 100 members
- **Slides on the canvas engine** — every drawing element works on a slide: shapes, images, rich text, freehand, lines and arrows. Text is edited in place, and a box grows with its text. The properties panel offers gradient fills, corners, padding, typography and opacity, and with nothing selected it edits the slide background for this slide, this and following, or all. The slide always fits the window. Comments anchor to elements, `⌘F` searches text, and presence shows which slide each person is on. Links in present mode open in a new tab without advancing the deck
- **Quick look for every file** — Drive items and the attachments in mail, chat and cards open in the same quick look with the same action menu. Clicking an attachment chip previews it next to the message's other parts, and a mailed video seeks
- **`.eml`, `.ics` and `.vcf` files** — an `.eml` opens as the message it holds and imports into the inbox. An `.ics` opens as its events and imports into a calendar you own or a team calendar, from Drive, from a mail or from the calendar sidebar; each calendar exports as one `.ics`. A `.vcf` previews as its contacts and imports into Contacts. All three carry their app's icon in Drive
- **Contacts** — Export vCard on any selection, and Import contacts and Export all contacts in the toolbar
- **Mail** — folders an IMAP client created appear under Folders. A lone `from:` or `to:` filter searches on its own. `postmaster@`, `abuse@` and `noreply@` deliver to the org admins instead of bouncing
- **Calendar (CalDAV)** — a calendar app can delete a calendar, and Integrations lists one address per calendar, because Thunderbird subscribes per calendar. CalDAV is tested end to end against Thunderbird
- **Offline indicator** — every collaborative editor shows when you are offline or the server's storage is out, and asks before you leave with edits that have not reached the server
- **Sheets** — floating images appear in exports and previews. A progress dialog stays up while an Excel or Word file imports
- **Canvas** — image and text boxes draw in the same hand-drawn style as shapes
- **Keyboard** — Delete and Backspace act on the selection in Mail, Contacts and Drive, and document shortcuts pause while a dialog is open
- **Help center** — 25 new articles and a Vector section, with Support links in the app switcher and on the Space landing page
- **Demo** — seeded mail with real attachments and contact cards, chats and comments that link the documents they talk about, and the Mail app stays on without hosted mail

### Changed

- **Calendar and contacts storage (breaking)** — events and cards are stored exactly as a client wrote them and served back byte for byte. Calendar data counts toward the storage budget. Existing data is not converted
- **Mail off is a complete product** — without hosted mail the Mail app and its settings disappear, and one `SMTP_RELAY_*` key set serves both modes: Postfix relays through it, or the API sends through it itself
- **Owner-only administration** — only the owner sees server settings, onboarding, guest access, the waitlist and the S3 secret. The owner cannot be deleted. The wizard no longer asks for a domain
- **eigen|vector>** — text elements are rich text. Shapes get gradient fills, true rounded corners and an optional border. Arrows dock on a shape's real outline. Phones open a drawing view-only
- **Canvas editing** — a run of nudges is one undo step, and so is a typed panel value. The aspect-ratio lock is remembered per element. Copy and paste between apps keep text as text
- **Sheets numbers** — every number shows the way Excel's General format shows it: no rounding noise, long values cut to 11 characters, scientific notation past that. A typed number is stored as a number, and a copy keeps full precision
- **Sheets** — pasted text is read like typed input, `Ctrl+D` and `Ctrl+R` copy the whole source cell, conditional-format rules follow Excel on case and blanks, and an imported Excel rule stays one rule. Exports lay out exactly as the screen does
- **Sharing** — deleting an item shared directly with you leaves the share instead of trashing the owner's copy
- **Activity** — a team shows its name instead of an id, links inside content open a new tab, and a file's creation and share rows are kept without an age cap
- **Mail** — a message with thousands of addresses gets its links instantly. Every mail is flushed to disk as it is written. Junk is labeled Spam
- **Copy** — American English, and dates read day-month-year

### Fixed

- **Calendar series** — an "all events" edit from a later occurrence shifts the series instead of moving it, a series edit reaches every override, a moved occurrence shows in its new week, and one occurrence deletes on one confirm
- **Calendar invitations** — an edit of one occurrence reaches guests as that occurrence, a new guest gets the series' exceptions, and an event you organize is never locked as someone else's invitation
- **Calendar time zones** — Windows zone names resolve, conversions near DST are correct, and an event without a zone shows in your own
- **Contacts** — editing one value keeps its label, a duplicate card is refused with the holder's name, and one damaged card no longer blocks the address book
- **Mail** — drafts keep nameless attachments and attached invites, a folder an IMAP client recreates gets live updates again, a message opened from a notification no longer stays unread, and a delivery no longer fails on a file system that refuses a directory fsync
- **Sheets formulas** — inserting or deleting rows in one sheet no longer shifts formulas on the others, whole-column ranges survive a shift, errors propagate through operators and comparisons, an overflow is `#NUM!`, `TEXT` works, dates no longer land a day early west of Greenwich, and every edit recalculates its dependents
- **Sheets editing** — fills shift formulas correctly and never write into a merged cell, switching sheets closes the editor, and the row and column limits match their message
- **Canvas** — moving a shape re-docks both ends of its arrows, and a missing image draws a placeholder
- **Collaboration** — opening a document on slow storage says so and retries calmly, and large documents sync over slow links because Eigen compresses what it sends
- **Drive** — a copy keeps its thumbnail, a read-only shared folder no longer offers actions it cannot do, and long copies no longer time out and duplicate the tree on retry
- **WebDAV** — moving an item onto itself is refused instead of deleting it, and malformed requests get a 400
- **Export** — a PDF render that hits its time limit returns an error instead of an empty reply
- **Server** — a second API on the same data folder refuses to start, a session started right after setup survives a restart, sign-in retries a missed organization join, and the `static` gateway forwards the real client IP, so rate limiting is per visitor

### Security

- **Audit of 2026-09-06** — every code-level finding is fixed: self-registration is closed unless open signup is on, comment descriptions and sheet paste are sanitized, previews go through the export sanitizer, presence updates are bounded and bound to the session, HTML mail loses `<form>`, WebDAV and mail parts are served with `nosniff` and a sandbox CSP, and ffmpeg runs with a protocol whitelist
- **iMIP** — invitations are processed only from senders whose DKIM signature Eigen verified itself
- **Headers and trust** — every app carries a Content-Security-Policy, the edge sends the security headers, and the mail stack trusts only `EIGEN_SUBNET`
- **Setup and relay** — the wizard runs only from a one-time link, relay credentials require STARTTLS, and admin impersonation is disabled
- **Dependencies** — DOMPurify, markdown-it, linkify-it and xmldom patched; nodemailer 10, sharp 0.35, better-auth 1.7

## [0.2.0] - 2026-09-02

Drawing, contacts sync, and hardening release. Eigen gains a new app, eigen|vector>, a collaborative whiteboard heavily inspired by Excalidraw's impressive work. Contacts are stored as vCard files and served over CardDAV, so phones and desktops sync them the way they already sync calendars. Mail got its own parser, per-recipient document links, and a hardened outbound relay after an abuse incident. Under the hood, every collaborative editor shares one way to load and save, copy and paste, show live cursors and draw.

### Added

- **eigen|vector>** — a new collaborative whiteboard app. Shapes, freehand strokes with pen pressure, lines, text and images. Arrows stay bound to the shapes they connect, curved by default, with elbow routing, pinnable segments, heads and labels. There's an eraser, snap lines with align and distribute, live cursors, comments, an activity panel, and tuning for touch and stylus. Drawings export to SVG and PDF, show up in Drive previews and search, and paste into other apps as real images
- **Contacts over CardDAV** — contacts are stored as vCard files and served under `/dav/addressbooks`, so iOS, macOS, Thunderbird, and other clients sync them two-way. Apple clients edit in place, vCard 4.0 uploads are accepted, labels round-trip as categories, and contact photos become avatars. The Integrations page shows a CardDAV card next to CalDAV, a device setup article walks through each client, and the setup guide documents the `_carddavs._tcp` / `_caldavs._tcp` autodiscovery DNS records
- **Contacts** — edit a card straight from the context menu, select several contacts and email or chat with them at once, and the form shows what's wrong and marks only the fields that are required
- **Mail: send a document link** — the share-and-send dialog lists the linked files, gives the recipients read access when you send, and writes each recipient a personal link. When some recipients fail, Eigen tells you which
- **Mail** — outgoing mail carries the envelope, Message-ID and reply headers that other mail apps need, so replies thread correctly everywhere
- **Admin: Users** — a full-width responsive table with per-user storage usage, last sign-in, a guests-only filter, drag-to-team and multi-select, and orphaned accounts merged into the same list
- **Admin: S3 bucket safety** — one click on the S3 storage card enables bucket versioning and a lifecycle rule with safe defaults; the retention period stays editable afterwards
- **Drive** — sort by name, date or size from the column headers. Folders and documents show their real size. Folders group at the top only when you sort by name
- **Sheets** — tick boxes from the Insert menu and the cell's right-click menu, also for a whole column, limited to the rows that hold data. `Alt+Down` opens a cell's dropdown list. The data-validation hint shows as a card. Imported Excel booleans show as `TRUE` and `FALSE`
- **Slides** — live cursors and presence on the canvas, a right-click object menu, an aspect-ratio lock and W×H resize pill, and Alt-drag to duplicate
- **Demo** — the demo instance ships a hand-drawn festival site plan in the vector app

### Changed

- **Sheets border storage (breaking)** — cell borders are stored per cell, so two people bordering different cells converge instead of disagreeing forever, and toolbar-drawn borders now survive HTML export and previews. There is no migration: a sheet saved with toolbar-range borders before this release opens blank and read-only with an error banner instead of being overwritten. Sheets without such borders, and sheets whose borders were set per cell, open as before
- **Canvas editors work alike** — docs, slides, stickies and vector share undo, box selection, keyboard shortcuts, live cursors, dropping files, the properties panel, and copy and paste. Elements and images copy and paste between apps at their real aspect ratio, with one undo step per paste
- **Selection chrome** — a thinner selection ring and dashed group bounds across all canvas apps, matching the remote presence rings
- **Mail parser** — Eigen reads mail with its own parser instead of a port of nodemailer's, tested against a set of real-world emails. Three dependencies are gone. Address groups are flattened in reply-all and in the header rows, and the message body reads left-aligned at one unified width
- **Mail** — an empty message is refused instead of going out as "(No subject)", cleared recipients stay cleared when a draft is reopened, and the send button shows it's busy while Eigen checks who can open the linked files
- **Sheets** — conditional-format rules have human names and dialog titles, row and column resize is exact, the range picker sits under its cell at its old width, the dropdown chevron is always painted, the selection's move band and fill handle are easier to grab, and the sheet no longer carries a locale layer
- **Calendar (CalDAV)** — calendar apps see that you own your calendars and can write to them, so Apple's apps edit events in place instead of creating duplicates. MKCALENDAR uses the URL the app chose. A sync token ahead of the calendar is refused. The well-known DAV redirects work
- **Thumbnails** — animated images take their first frame, oversized images are skipped instead of exhausting the server, and thumbnail jobs no longer share temporary files
- **Docs** — pasted prose keeps its alignment, and the toolbar menus share one shell with slides and vector
- **Server** — a database newer than the running binary's schema is refused instead of opened, and a wrong data-dir argument fails with a clear error

### Fixed

- **Sheets** — text in cells, formulas and sheet names is escaped before the grid draws it. `IFERROR` catches errors from operators too, as in `IFERROR(1/0, 0)`. `TRUE`, `FALSE` and `NULL` work in any case. `F4` keeps cycling on absolute whole-row ranges. `Ctrl+Shift+F` stays in the workbook you pressed it in. Hidden columns no longer get filter buttons. Formula conditional-format rules stop at the last row. A tick box no longer hides values it doesn't recognize, and doesn't toggle while you type a formula. An invalid data-validation rule is refused instead of applied. A sheet that fails to load says so instead of showing a blank grid
- **Mail** — escaped characters in a mail's plain text decode correctly. Space freed by deleting mail counts toward your quota right away. The draft stays editable when you cancel share-and-send. The email header stays full width on wide screens
- **Calendar** — a deleted event that's created again syncs instead of staying deleted. An invitation received again and an event moved back show up again. Calendar apps notice a received invitation, and an app asking for one event gets it
- **Contacts** — birthdays keep the picked date in every timezone. Saving a form that someone else changed meanwhile is refused instead of overwriting their change. A duplicate label name is refused. A photo that fails to upload fails the save instead of clearing the photo
- **Drive** — copying to a media folder keeps its partial successes, and a missing app URL no longer white-screens the app
- **Stickies** — a card with only a title keeps room for a description, and a card's light edge shows only where the card is visible
- **Admin** — long names and emails truncate in person lists instead of overflowing
- **Server** — a failed write leaves no temporary file behind, a finished write survives a crash, and databases close cleanly
- **Docker** — a host dev API on port 8000 no longer conflicts with the docker stack

### Security

- **Outbound mail relay** — hardened after the abuse incident of 2026-08-31. A signed-in sender may only send as themselves. Failed logins count toward the per-IP limit and show up as auth failures for fail2ban. A fail2ban filter and jail ship with the Docker stack, and `update.sh` turns them back on after a rebuild. The organization owner is notified when outgoing mail backs up in the queue
- **Input limits** — CalDAV and CardDAV requests have a size limit, 5 MiB for a card. The last email fields without a limit have one. The files linked in a sent mail are capped and counted once. Control characters are refused in vCards and DAV requests
- **SVG serving** — a drawing's SVG carries its images inside it, safely, and an image named in a document only loads for the document it belongs to
- **Access checks** — the access check for a link shared by email skips addresses that can't be given access. A user's own account can't be claimed by another account with the same email
- **Conditional writes** — a contact form opened before someone else's change can't overwrite it

## [0.1.1] - 2026-08-13

Mobile and reliability release. Every app works on a phone, with column navigation and back arrows, touch context menus, collapsing toolbars, and comment and activity panels on small screens. Under the hood, every preview, export, and import moved into sandboxed background workers with hard deadlines, spreadsheet exports got an order-of-magnitude speedup, and slow-loading documents no longer spiral into reconnect loops.

### Added

- **Mobile** — Eigen works on a phone end to end. Navigation is column-based, with a back arrow in every app. Toolbars fold their controls into a ⋮ menu (sharing, calendar views, drive sort and view, the mail shortcuts cheat sheet). Submenus open as pages of their own, and calendar event and stickies card dialogs fit a phone's width
- **Touch** — long-press opens the context menu everywhere right-click does (drive rows and grid tiles, chat messages, stickies cards, slide thumbnails). Action icons that appear on hover stay visible on touch screens. Drive rows get a ⋮ menu per file, and the details pane gets Move, Copy and Duplicate. Move to trash asks for confirmation on touch devices
- **Comments and activity on mobile** — Docs, Sheets and Slides show their comments and activity panels on small screens. On a phone the panel takes over the editor, and from tablet width up it sits beside it. Docs adds Comment to the mobile Insert menu
- **Drive quick look** — press `Space` to open and close a preview of the selected file, and step through the list with the arrow keys while it is open
- **Slides** — presentation mode briefly shows an exit button, so you can leave a presentation by touch

### Changed

- **Reliability** — every document preview, export (HTML, PDF, XLSX, DOCX), import (XLSX, DOCX) and search indexing job runs in a separate worker with a time limit. One huge or broken file can no longer stall the server for everyone, and a stuck job is stopped and reported instead of hanging forever
- **Sheets** — exporting a large spreadsheet to HTML or PDF is about ten times faster, and the file a fraction of the size. Previews and search read stored values instead of recalculating every formula, so a sheet full of formulas can no longer time out its own preview. Sheets are saved in a smaller format that opens faster over a slow connection. Inserting rows and columns, filtering and copying are faster in large sheets
- **Opening documents** — a document that takes long to load (a huge spreadsheet on a cold server) shows progress instead of connecting and disconnecting over and over. A document you just closed stays loaded on the server for a minute, so reopening it is instant
- **Drive** — converting an `.xlsx` or `.docx` into an Eigen document shows a progress dialog, and the conversion finishes on the server even if you navigate away
- **App icon** — a redesigned, bolder app icon, including the Safari pinned-tab icon

### Fixed

- **Dark mode** — the document page, the slides canvas and the sheets formula bar always stay light, so content reads the way it prints
- **Printing** — printed documents no longer show collaborator cursors, selections, search highlights, or comment markers
- **Mail** — wide HTML emails scale to fit on a phone instead of overflowing. Message bodies use the app's font. A calendar invitation that fails to load says so instead of failing quietly. Actions on several messages report exactly what succeeded. The message list no longer takes keyboard focus while the composer is open
- **Calendar** — moving an event to another calendar happens in one step on the server, and asks first when the move would lose data. The edit dialog's repeat options no longer shift the start date by a day in some timezones. All-day date fields stay readable on narrow screens
- **Sheets** — viewers can't edit through menus or shortcuts, and they see rows and columns that others insert or delete without a reload. Color pickers in menus are submenus and no longer send keystrokes to the grid. The grid resizes when a side panel opens. Headers, sheet tabs and pickers work by keyboard and touch
- **Slides** — editing shortcuts no longer reach the deck while presenting, and slide thumbnails on mobile are view-only
- **Chat** — with a mouse, messages show their action icons on hover again (on touch, long-press keeps its menu), and guests no longer see a storage bar
- **Drive** — Cancel in the inline text editor asks before discarding unsaved changes, and deleting a selection that spans your drive and a team drive moves every item to trash
- **Dialogs** — confirmation dialogs for delete, move and save wait for their action to finish, and show a failure instead of closing early
- **Imports** — importing a `.docx` a second time updates its images instead of failing
- **Accessibility** — comment color and assignee pickers work by keyboard, and chat, contact, and slide-object actions are reachable by touch
- **Landing page** — a rejected waitlist signup no longer locks the join form, and social-media link previews use the server's real domain
- **Installed app** — navigation between apps works when Eigen is installed to the home screen or dock as a web app

### Security

- **Imports** — a `.docx` file is refused when it unpacks to more than a set size (zip-bomb protection), and write permission is checked again when an import finishes, not only when it starts

## [0.1.0] - 2026-07-19

Search, mail and collaboration release. Find and replace inside every editor, and search through the content of files in Drive, a much faster Mail with Gmail-style keyboard shortcuts, comment assignment with live activity panels in the editors, a Drive grid view, a guided new-chat wizard, team avatars, a public demo, a monochrome dark theme, and the fixes from two security audits.

### Added

- **Find and replace** — press `Mod+F` in Docs, Sheets, Slides and Stickies for a find bar that highlights matches and steps through them. `Mod+Alt+F` opens replace and replace all, which keeps each match's capitals. The command palette gets a `doc:` scope that finds matches in the open document, its comment threads included. Opening a search result highlights the match and scrolls to it, in documents and mail alike. The text editor in Drive gets the same find bar
- **Search** — Drive search looks inside files, not only at their names. Documents, sheets, slides, boards, chats and plain-text files are indexed in the background, and a match on the name ranks above a match in the content
- **Mail** — Gmail-style keyboard shortcuts. Move through and select messages, archive, delete and reply, with auto-advance to the next message. Undo the last action with `z` and send with `Mod+Enter`. Press `?` for the full list, and turn shortcuts or auto-advance off in settings. Flagged messages show a star in the list
- **Comment assignment** — assign a comment card to a person in Docs, Slides, Sheets, and Stickies (in Sheets from the cell's comment menu). The assignee is notified and shown on the card. Filter comments by assignee, color and status, per panel, or for the whole board in Stickies
- **Activity in editors** — the Recent Activity timeline from Drive opens inside Docs, Sheets, Slides and Stickies from an Activity button next to sharing. It updates live while the document is open, and every row links to what it describes
- **New-chat wizard** — starting a chat is a two-step dialog. Pick the people (anyone you can share with, or a whole team), then name the chat and choose where it lives. If a chat with exactly those members exists, it opens instead of a duplicate, and "Create new chat" still makes a new one. Team chats go in a chats folder on the team drive. Members with an account no longer get an email about the share (invitees without one still do). The wizard opens from the chat sidebar, Drive's + New menu, and a new Start chat action on contacts and team members
- **Drive views** — switch between a list and a grid of thumbnails, and sort by name, modified or size. Drive remembers your choice. Grid tiles work with the keyboard, can be dragged onto folders and show unread badges. Trash gets the same views, sorting and multi-select
- **Team drives everywhere** — the per-type views (Documents, Sheets, and so on), search, the Watched view and the chat sidebar include your team drives next to your personal drive
- **Sheets** — live cursors. Everyone editing a shared sheet sees the others' selections in their color, with name labels as in Docs
- **Sheets** — while editing a formula, `F4` cycles the reference under the cursor through absolute and relative forms
- **Mail** — paste files or images from the clipboard straight into the composer as attachments
- **Teams** — team avatars. Upload an image for a team on its Admin page and it shows wherever the team appears. Profile, contact and team pictures use the same avatar editor
- **Demo mode** — a server can run as a public demo that resets itself. Visitors press "Enter demo" and land in a sample festival workspace as one of its members, with a warning banner and outgoing mail turned off. It runs at demo.eigen.is
- **Landing page** — admins can add their own link buttons (a title and a URL) to the landing page from Server Settings
- **Marketing site** — a `/changelog` page generated from this file, linked from the site footer and the app's About dialog
- **Chat** — new `/whoami` and `/hide` slash commands

### Changed

- **Dark mode** — a monochrome dark theme. Cards, popovers and dialogs stand out from the background, scrollbars follow the theme, and note cards match the mail list. The spreadsheet grid stays white, so sheets read as sheets. The app-colored topbar option is gone
- **Mail** — large mailboxes are fast. The message list loads in pages, and moving, reading, flagging and deleting apply at once and sync in the background. Syncing a mailbox no longer blocks the list, and search runs on the server. Unread rows show a dot instead of a border
- **Notifications** — look like the rows in Recent Activity. Each one says who did what to what, a chat notification previews the message, and every row links to the exact card, comment or email. Notification links open in the same tab
- **People** — every place that shows a user shows their display name, with a card on hover: chat authors, @-mentions and their suggestions, "Created by" lines and activity rows
- **Sheets** — editing recalculates only the cells that depend on the change instead of the whole workbook, keeping large sheets responsive while typing
- **Uploads** — an upload streams straight to disk, so a large one no longer takes its full size in server memory
- **Drive** — empty folders and views explain what belongs there and how to add it. A file you already viewed isn't downloaded again unless it changed

### Fixed

- **Docs, Slides and Sheets** — an image you insert no longer vanishes right after it uploads
- **Sheets** — imported spreadsheets that were never opened compute their formulas on the server, so previews and exports show values instead of blanks. Imported `m` and `M` date formats read as months or minutes correctly
- **Sheets** — the selection's sum and count read each cell's real value, so formatted cells add up correctly. Drag-fill keeps the number format in every direction. `=` and `<>` ignore case, as in Google Sheets. Sorting follows English alphabetical order. Highlights stop correctly at frozen rows and columns. Collaborators' cursors stay after you switch sheets
- **Mail** — a moved or deleted message shows up in its new mailbox without a reload. The list scrolls back to the top when you change mailbox or search, and search gets a clear button. An inbox opened from a notification no longer gets stuck empty. A message you just moved no longer drops out of the list during a sync
- **Calendar** — events no longer disappear from the 25-hour day when daylight saving time ends, and a local time that occurs twice resolves as RFC 5545 says. The calendar link in invitation emails opens the right month instead of the year 57479
- **CalDAV** — a deleted occurrence is sent as an EXDATE, so an edit in a calendar app can't bring it back. Older stored events load instead of failing. Several edge cases in edited occurrences (time zones, floating times) are fixed for apps like Thunderbird
- **Chat** — a very tall new message scrolls into view. With no personal chats, the first team chat opens
- **Drive** — a `.txt` preview shows readable paragraphs, as `.md` does. A file name with accents no longer appears twice. Files on a team drive open from the per-type views and sidebar links
- **Contacts** — the contact and team-member detail views behave the same, and Edit/Delete are hidden when they don't apply instead of shown disabled
- **Admin** — deleting a user removes everything tied to the account, whichever way you delete it. Some ways left team memberships behind
- **Self-hosting** — the bundled Caddy revalidates the app shell on every load and reloads its config after an update, so a new version is picked up immediately instead of serving a stale page
- **Reliability** — more storage hardening. An upload to S3-compatible storage that timed out halfway is found and repaired. A damaged copy waiting to upload is refused. Two files created with the same name at the same moment can no longer both exist. Opening and closing databases under load no longer races

### Security

- **Admin** — a signed-in user could create their own organization and pass the server's admin check. Admin rights now belong to the server's organization only, and users can't create organizations
- **Protocol sign-in** — an account with 2FA can no longer be reached over IMAP, CalDAV or WebDAV with only its email and password: use an app password. Sign-in attempts over these protocols are rate-limited, and a valid app password is never blocked by that limit
- **Exports** — slides and sheets HTML exports escape untrusted styling (a stored-XSS vector), and PDF export can no longer be steered into fetching internal URLs
- **Calendar** — an update or delete checks that the event belongs to its calendar. Incoming invitation mail (iMIP) must match its envelope sender, checks time zone ids, ignores replayed cancellations and applies replies to the right occurrence. A repeating event can only expand so far
- **Server** — internal API endpoints can't be reached through the reverse proxy. A client can no longer fake its address with forwarded headers to dodge rate limits. API documentation and timing headers are off in production, and WebSocket messages have a size limit
- **Sheets** — a crafted `.xlsx` file with forged headers or oversized contents is refused, with hard limits on unpacked size and cell count
- **Mail** — the mail parser is hardened against hostile input, with limits on parts and extracted text, and tested with generated hostile mail
- **Chat** — deleting a chat attachment is confined to that chat's own media folder

## [0.0.6] - 2026-06-25

Activity and history release. A timeline per file with file and folder watching, copy, move and duplicate across drives, attachments on comment cards, a big spreadsheet import-fidelity pass, a filled-out help center, and a visual refresh, plus data-loss hardening for remote storage.

### Added

- **File activity and history** — every file in Drive keeps a timeline of what happened to it (created, uploaded, edited, renamed, moved, copied, commented) and who did it. It shows in a Recent Activity panel in the file's details. Edits and comments in a shared document are credited to the people who made them
- **File and folder watching** — watch a file or folder to be notified when it changes. Watching a folder covers everything inside it. A new Watched view lists everything you watch, and a burst of changes becomes one notification
- **Copy, move and duplicate** — right-click a file, a folder or a selection in Drive for Move to…, Copy to… or Duplicate. Copy works anywhere, also across storage locations and into team drives. Move stays within a drive. A folder copies with everything in it, and a document copies as a separate document that works on its own
- **Comment attachments** — attach files to comment cards in Docs, Slides, Sheets and Stickies, and to chat. Paste or drop files into the card form or the chat input
- **Sheets** — an XLSX import keeps much more: hyperlinks, data-validation rules, conditional formatting, filters, hidden rows and columns, and frozen panes. They survive an XLSX export too
- **Sheets** — a formatting toolbar with font, size, bold and italic. Number formatting gets Google-style custom format dialogs for dates, numbers and currency, and the Format → Number menu matches Google Sheets
- **Sheets** — the column filter menu can filter by condition (text contains, greater than, and so on), not only by picking values
- **Stickies** — resolve a card, and reopen it later; resolved cards show a check
- **Slides** — right-click a slide object for a context menu of its actions
- **Help center** — Eigen Support has 120 articles. Search them on the site, or from the command palette with the new Help scope
- **Drive** — video and audio scrub instantly in the preview, and an interrupted download can resume
- **Marketing site** — a new `/licenses` page lists the open-source software Eigen is built on

### Changed

- **Visual refresh** — a new app switcher, a grid of large app-colored icons with names. Lighter font weights across the apps, Drive file icons tinted by app, an animated `eigen|app>` wordmark on the landing page and Space home, and a topbar that can be app-colored or neutral. Toolbar titles are lighter, toolbar borders fade in as you scroll, and the Drive, Trash and Calendar layouts are tidier
- **Landing page** — the landing page is prerendered, so it shows instantly and search engines read it better. Signed-in visitors go straight into the app
- **Sheets** — inserting or deleting rows and columns no longer sends the whole sheet, so large sheets stay responsive

### Fixed

- **Mail** — deleting an email in Trash from the message toolbar asks for confirmation and deletes it for good, instead of doing nothing
- **Mail** — an HTML email made for a light background stays on a light background in dark mode, so it stays readable. Unread senders are bolder. A mailbox that fails to load says so instead of showing "no emails"
- **Drive** — the preview's next/previous arrows work again for files opened from the Shared and file-type views
- **Slides** — on medium-width screens the editing controls (undo/redo and add slide/text/image) stay reachable through an Edit menu instead of disappearing
- **Sheets** — imported dates render through their number format, an unknown filter condition matches every row instead of hiding them all, and cell focus returns when a context menu closes
- **Accessibility** — buttons with only an icon have names for screen readers and work by keyboard. Tall popovers and menus fit the window and scroll instead of being cut off
- **Reliability** — uploads to S3-compatible storage finish in the background, so slow or failing storage means a retry later instead of a hung or failed request, without losing data. Databases recovered after a crash are synced again, and a stored document is never overwritten with an empty or broken copy. This continues the storage hardening of 0.0.5

### Security

- **Drive** — a team's mount list is no longer readable by non-members
- **Drive** — files shown in the browser carry `nosniff` and a sandbox CSP, so an uploaded HTML or SVG file can't run scripts
- **Auth** — a guest's one-time code can't be used twice to create two sessions. Sign-in and 2FA allow 10 tries per minute per IP
- **Abuse** — rate limits count per real client IP behind the reverse proxy (avatars don't count), which fixes a lockout of the whole server
- **Calendar** — canceled events don't count as busy, and a replayed iMIP invitation (an old sequence number) is ignored
- **Sheets** — a link in a cell opens only for allowed schemes, with `noopener`, and a crafted link can't stall the parser

## [0.0.5] - 2026-06-04

Version history release. Automatic versions you can restore in every collaborative app and in chat, new slide tools (rotate, Alt-drag to duplicate, align and distribute), a fresh look for spreadsheets, and faster storage, previews and boards.

### Added

- **Version history** — Docs, Sheets, Slides, Stickies and Chat keep versions automatically. **Version history** in the File menu lets you browse earlier versions and restore any of them. A restore applies live: everyone with the document open sees the restored content at once, without a reload. Eigen keeps hourly, daily, weekly and monthly versions, so recent history is detailed and older history thins out
- **Slides** — rotate objects with a rotate handle. Hold Shift to snap to common angles, and watch the angle as you turn. Resizing follows the rotation
- **Slides** — hold Alt and drag an object to drop a duplicate
- **Slides** — an Arrange section in the properties sidebar aligns and distributes the selected objects
- **Admin** — when a configured S3 bucket has object versioning disabled or suspended, the storage settings (setup wizard, server settings, and a team's storage locations) warn you and recommend turning on versioning with a lifecycle rule for old versions

### Changed

- **Drive** — folders and documents show their real size instead of 0. Eigen works a size out when you need it and keeps it until something inside changes
- **Sheets** — a new look for the formula bar, the column and row headers, the area around the grid and the bottom bar. Theme colors throughout, an accent color on highlighted headers, and one compact bar with the sheet tabs and the selection's Count, Sum and Average. The all-sheets list shows a color dot for sheets with a color
- **Slides, Stickies, Sheets** — canvas and toolbar look like Docs, with rounded canvas corners and the same toolbar height
- **Stickies** — large boards stay smooth: editing one card no longer redraws the whole board
- **Previews** — document, sheet and slide previews show the last saved preview at once and refresh in the background, instead of making you wait the first time you look after an edit
- **Storage** — collaborative documents are compressed on disk, so they grow more slowly

### Fixed

- **Sheets** — a formula that reads a cell on another sheet refreshes, even when that row hasn't loaded yet
- **Calendar** — attendee email addresses are validated when added to an event
- **Reliability** — after a storage incident, storage of documents and chats is hardened against data loss: files are created in one step, and a failed sync no longer goes unnoticed

## [0.0.4] - 2026-05-28

Search release. A Mod+K command palette that searches Drive and mail, native scrolling in spreadsheets, much faster opening of large spreadsheets, compact file previews, and rich text on sticky cards.

### Added

- **Command palette** — press `Mod+K` (or the topbar search pill) anywhere to search files, mail, and contacts, jump between apps, create documents, and act on the current selection (open, share, rename, download, mail to…). Type an email address, a URL or a contact's name and it offers "Send mail to…" in one press
- **Search** — search the text of Drive files and mail, one kind at a time with `file:`, `mail:` or the scope chip that Tab switches. Mail search filters by mailbox and by `from:` and `to:`, and leaves out trash and spam unless you ask
- **Stickies** — card descriptions are rich text with task lists. Ticking a box on the board or in the card dialog is saved, and cards show how many tasks are done
- **Support** — a searchable Eigen Support help center on the website, with a guide to mounting your drive over WebDAV
- **Drive** — "Mail to…" in the item context menu opens a mail composer with the file attached

### Changed

- **Sheets** — scrolling is native: wheel, trackpad, keyboard, touch and the browser's scrollbar all work directly, in place of the old custom scrolling and thin scrollbars. The grid no longer bounces and tears at its edges
- **Sheets** — a large imported spreadsheet opens much faster: a 16-sheet xlsx that took about 60 seconds shows in a couple of seconds. The sheet is compressed on its way to the browser, so big sheets open much faster over a slow connection
- **Previews** — quick look shows part of a large file (the first sheet, the first 8 slides, the first 20 blocks of a document) with a note to open it for the rest. Downloads and exports stay complete. Text previews are kept longer, and old preview files are cleaned up

### Fixed

- **Sheets (XLSX import)** — a file with formatted link cells, such as a Google Sheets export, no longer fails with "not a valid xlsx file"
- **Sheets** — a formula that is only a reference to an empty cell, such as `='Sheet'!B13`, gives `0` instead of `true`
- **Calendar and UI** — month and weekday names are in English, like the rest of Eigen, instead of in the browser's language (Dutch, for example)
- **Space** — the 2FA setup QR code renders again instead of crashing the setup step
- **Setup** — you can run the first-run wizard again after a partial failure, instead of getting stuck on "user already exists"
- **Admin** — team and member action errors show the real message instead of `[object Object]`
- **Sidebar** — long chat and folder names truncate with an ellipsis instead of forcing a horizontal scrollbar

## [0.0.3] - 2026-05-18

Quality release. Video thumbnails, images that show the moment you insert them, one kind of comment card everywhere, a new Drive properties panel, one sidebar across Drive and the document apps, and a cleanup of the spreadsheet engine.

### Added

- **Drive** — video thumbnails. An uploaded video gets a still from one second in, and its details show its length. ffmpeg ships in the Docker image. Without it, a video gets no thumbnail and no error
- **Docs, Slides, Sheets** — a dropped or pasted image shows at once, while it uploads. An upload left behind by a crashed tab is cleaned up
- **Slides** — box selection by direction, as in design tools: drag right to select what's fully inside, drag left to select what the box touches
- **Slides** — hold Alt to resize objects from their center, and Shift to keep their proportions
- **Slides** — solid colors and gradients for slide and text box backgrounds, in one panel. It starts with the brand color and keeps your color when you switch between solid and gradient
- **Slides** — gradient backgrounds in PDF downloads
- **Comments** — Docs, Slides, Sheets and Stickies use the same comment card, with its author, date and color. The paperclip button attaches a file from Drive
- **Drive** — a new properties panel with tabs, and the same item menu in the list and in the preview
- **Drive and the document apps** — one sidebar, with each app's accent color, uppercase section labels, and links to the other apps
- **Toolbars** — Slides and Stickies get the shared sharing badge and undo and redo buttons
- **Stickies** — a new card scrolls into view, and board cards have a minimum height
- **Admin** — letter dividers in the members, guests and orphans lists

### Changed

- **Sheets** — the comments sidebar sits next to the grid instead of on top of it
- **Drive** — app links come from a separate `EIGEN_STATIC_BIND` setting while the server runs, which fixes installs where the API and the apps share one address
- **Drive previews** — document and slide thumbnails scale to their real width, and thumbnails of text and code files show an A4 page
- **Mail** — mail settings get their own section in the App settings sidebar
- **Performance** — images load without blocking the page, so every app scrolls and draws more smoothly
- **Slides** — dragging with snapping does less work, so it stays smooth

### Fixed

- **Drive** — a new image no longer flashes as broken when its upload finishes
- **Drive** — a missing document says it's not found instead of failing silently
- **Drive** — internal fields no longer show in a file's details
- **Mail** — a broken address inside angle brackets, such as `<foo@>`, is refused
- **Comments** — the card dialog no longer opens by itself after you add a comment in Docs, Slides and Sheets
- **Comments** — a comment thread is half the window tall again, and "View comment" always has the same icon. In Docs, opening a comment's link again works, and a comment card shows correctly before the document has synced
- **Comments** — other people see a new comment without a reload
- **Slides** — a background fill no longer counts as changed when it isn't
- **Slides** — in the background panel, the "Apply to" list and the "Apply" button have the same height
- **Admin** — Shift+Arrow extends selection in the members list
- **Chat** — a failed edit or delete shows an error
- **Sheets** — closing a sheet on the server can no longer close it twice

## [0.0.2] - 2026-05-11

Maintenance release. Email notifications, guest access settings, XLSX import, security hardening, and many spreadsheet fixes.

### Added

- **Sheets** — XLSX import. Open an `.xlsx` file in Drive to convert it into an Eigen sheet, with its values, number formats, formulas, merged cells, borders, fonts, and column and row sizes
- **Mail** — plain `http://` and `https://` addresses in received mail become links
- **Admin → Email notifications** — four switches for outgoing mail: calendar invitations to guests, mail when someone gets access to a file, file access requests, and mail to a shared file's collaborators
- **Admin → Guest access** — a switch for open signup and the number of inactive days before a guest is removed (by default open signup is on, and guests go after 7 inactive days)
- **Drive** — email the collaborators on a shared file, from a composer that starts with your email signature
- **Drive** — mail goes out for access requests, new access and shares, if the admin switches allow it
- **Calendar** — guests with an Eigen account get an invitation by email, if the calendar invitation switch is on
- **User** — a user or team avatar shows who it is in a popover

### Changed

- **Spreadsheet edits** — a value you just typed survives a reload before the next automatic save, and is in an XLSX export too
- **Mail** — share, access request, attachment and collaborator emails share one layout, and file chips look the same in mail, chat and Drive
- **Mail** — a new mail no longer notifies twice
- **Popovers** — no longer cut off at the edge of the window

### Fixed

- **Spreadsheet paste** — pasting diagonal borders over a copy of several ranges no longer crashes
- **Spreadsheet rows and columns** — an insert or delete on a read-only range, or a broken one, shows a clear error instead of damaging the sheet
- **Dialogs** — a click that starts inside a dialog and ends outside no longer closes it, for example when you select text past its edge
- **Composers** — chat, mail and Drive composers drop empty lines at the end before they save
- **Welcome and invite emails** — headers with non-English characters show correctly (RFC 2047)
- **Shared-document emails** — the plain-text version includes the document's link
- **Postfix** — DKIM-signs mail relayed from the Docker bridge network
- **Postfix** — delivers to Eigen one recipient at a time
- **Guest cleanup** — waits until setup is done, and repairs a guest's account at every sign-in. Two code requests at once no longer clash
- **About dialog** — shows the build date in a readable format

### Security

- **Mail templates** — text a user typed is escaped in welcome and invite emails
- **Guest sign-in codes** — at most 3 requests per email and 10 per IP an hour
- **Mail body links** — open in a new tab with `rel="noopener noreferrer"`

## [0.0.1] - 2026-05-03

First public release. A workspace you host yourself, with email, file storage, documents, spreadsheets, presentations, kanban boards, calendar, contacts and real-time chat. They all share one API, one sign-in and one UI.

### Apps

- **Mail** — webmail with full mailbox management. Mail is stored as Maildir++ on disk, with IMAP through Dovecot
- **Drive** — files and folders with sharing, permissions, thumbnails and previews, stored on local disk (as named files or flat keys) or on S3
- **Docs** — collaborative document editor (Tiptap + Yjs); export to DOCX, PDF, and HTML
- **Sheets** — collaborative spreadsheets, on an engine forked from fortune-sheet
- **Slides** — collaborative presentations on a 1920×1080 pixel canvas with presentation mode
- **Stickies** — collaborative kanban boards with per-card embedded chat threads
- **Calendar** — recurring events (RFC 5545 RRULE), invitations with RSVP, shared and team calendars
- **Contacts** — contact management with avatars
- **Chat** — real-time chat with over 100 slash commands, most of them emotes. A chat lives in Drive and is shared like a file, and docs and kanban cards use chats as comment threads
- **Space** — personal account settings, profile, and preferences
- **Admin** — manage the organization, teams, members, roles, quotas and server settings, with a setup wizard for the first run

### Protocols

- **IMAP** via Dovecot (Maildir++ co-existing with the web UI on the same filesystem)
- **CalDAV** server with discovery, sync and repeating events, tested with Thunderbird
- **WebDAV** server (RFC 4918 Class 1+2) for Drive mounts
- **SMTP** submission on ports 587/465 with DKIM signing; Postfix handles inbound and outbound

### Auth

- Email/password with optional TOTP 2FA
- App passwords for protocol access (IMAP/CalDAV/WebDAV)
- Organizations with teams and role-based admin
- Guest access for shared resources

### Deployment

- Docker Compose stack with optional `edge` (Caddy) and `mail` (Postfix, Dovecot, Unbound) profiles. Leave either out when the host already runs its own web server or mail server
- `bun run setup` — an interactive setup of four questions that writes `.env.production`
- Automatic HTTPS via Caddy, automatic DKIM key generation
- Backup script and auto-migrating update script
- Mail addresses can use another domain (`MAIL_DOMAIN`) than the web address (`DOMAIN`)
