# Changelog

All notable user-visible changes to Eigen are documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

## [0.4.2] - 2026-11-03

Sheets scrolls and looks things up faster, copies and pastes validation rules and hidden rows as Excel does, and its dialogs read and behave like the rest of Eigen. Drive, Mail and Contacts open a row's menu from the keyboard. Docs gets styled tables of contents, and emoji, Chinese and Korean text and equations draw the same in the apps and in downloads. Every update now makes a Full backup, `./eigen rollback` keeps today's data, and an update can warn open tabs before Eigen restarts. Three changes break old data: Vector and Slides text boxes saved by an earlier version disappear, Sheets validation rules need setting up again, and Light backups can no longer be restored. After you update, reload any tab you have open.

### Added

- **Demo reset warning** — a demo now warns five minutes before its hourly reset, with a countdown at the bottom of the page
- **Table of contents options in Docs** — on a computer or a tablet, select or right-click a table of contents to pick Plain text, Dotted or Links, how many heading levels it lists, and each level's font, size, bold and italic. PDFs and Word files show them, and a Word file's table of contents comes back with its page numbers, dots and fonts. A document without pages offers Links only
- **Duplicate in Drive lists** — **Duplicate** is also in the menu when you browse by file type or in a document app's list, but not on a drive's top-level folder
- **Mail several items from Drive** — with more than one item selected, the menu offers **Mail 3 items to…**
- **Shortcuts in the Drive menu** — on a computer, the menu shows ␣ next to **Quick preview** and ⌫ next to **Move to trash** and **Remove shared item**. On a touch screen no menu shows shortcuts
- **Row menus from the keyboard** — in the lists of Drive, Mail and Contacts, Shift+F10 (fn+Shift+F10 on most Mac keyboards) or the Menu key opens the menu of the row under the cursor. Tab no longer stops on each row's ⋮ and Share buttons
- **Unread comments on cards** — in Stickies and in the comment panel of Docs, Sheets, Slides and Vector, a red dot marks each card with a new reply, mention or assignment for you. Opening the card clears it
- **A warning before a restart** — `./eigen update`, `./eigen rollback` and `./eigen restore` take `--in 10m "Back at three"`, up to an hour. Every open tab counts down in a banner, then says Eigen is updating, or going back to an earlier version, while it is down. Ctrl+C or a lost SSH session cancels

### Changed

- **Text boxes in Vector and Slides (breaking)** — a text box saved by an earlier version disappears when its drawing or deck opens. Text inside shapes stays
- **Open tabs after an update** — every open Eigen tab reloads by itself once the updated server is back, so no tab keeps running the old version. Anything a tab had not saved yet is lost, such as text typed while the server was down or a half-written comment
- **The sidebar and the top bar** — both sit on the page's own background, with no line between them and the page. The open sidebar item, and the one under the pointer, end in a point, as the eigen logo does
- **Jumping from a table of contents in Docs** — a click selects it. ⌘-click a line (Ctrl-click on Windows and Linux) to jump to its heading, or on a touch screen tap once, then tap a line
- **A shorter style list in Docs** — the style picker lists Normal text and the headings. **Title** and **Subtitle** move to **Format › Paragraph styles**, below **Heading 6**, and Word files keep them
- **Scrolling in Sheets** — the grid keeps up with a wheel or trackpad scroll on a 120 Hz screen, frozen rows and columns included, also on large sheets. Dragging the scrollbar still redraws the whole grid
- **Validation rules in Sheets (breaking)** — an existing spreadsheet opens without its dropdowns, tick boxes and other validation rules, and every cell keeps its value. Set the rules up again, or import the Excel file again
- **Whole-column rules in Sheets** — a validation rule on a whole column, picked by its header or from an Excel file, covers every row, below the data too. Only rows inserted inside a rule get it
- **Pasting over rules and links in Sheets** — cells you copy or cut in the same tab replace the validation rules and links where you paste them, as in Excel. A paste, fill or move that would break a rule into too many pieces is refused, with a notice
- **Copying hidden rows and columns in Sheets** — a copy, cut or drag move takes them along, as in Excel, where a cut used to lose them. A copy leaves out the rows a filter hides
- **The Sheets bar** — its format buttons fold into the **Format** menu a group at a time as the bar narrows, alignment first, as in Docs, and an open side panel counts. The menus no longer scroll sideways
- **Sheet names** — a tab name may hold a fullwidth ： or ？, as in Excel. A refused name says why: at most 31 characters, none of `\ / ? * [ ] :`, and no `'` at either end
- **Whole-column lookups in Sheets** — a sheet with 20,000 lookups into whole columns of 64,000 rows, such as INDEX and MATCH over `B:B`, opens about three seconds faster
- **Dialogs in Sheets** — Custom sort, Split text, row height and column width, the custom number, date and currency formats, Insert function, a conditional formatting rule, Data validation and the link editor have a close button in the corner, close on a click outside and apply on Enter
- **Refused rules in Sheets** — a conditional format or Data validation rule Sheets can't take keeps its dialog open with the reason under the field, and what you typed stays
- **Insert function in Sheets** — the search finds a function by its description, a name typed in full comes first, Up and Down move through the list, and Cancel leaves what you were typing in the cell
- **Menu names in Sheets** — **Data verification** is called **Data validation**, with types such as Whole number and Text length. **Management rules** is **Manage rules**, **Delete sheet rule** is **Delete sheet rules**, and **Insert › Auto SUM › Learn more...** is **More functions…**
- **Cell references in conditional formatting** — a value that starts with `=`, such as `=B1`, follows that cell as it changes, as in Excel and Google Sheets. Without the `=`, `B1` and `FY2024` are text
- **Colors in conditional formatting** — new color scales and data bars use Eigen's palette, and each scale's name lists its colors in the order its swatch draws them. Rules you already have keep their colors
- **Words in Sheets dialogs** — Split text heads its choices **Separators**. Data validation reads **Whole number**, **Greater than** and **Drop-down list**, where it read "Number-integer", "More than the" and "drop-down list"
- **Sort range in Sheets** — **Data › Sort range** works on one selected range and stays grayed out until exactly one is selected. Custom sort offers only the columns that hold data
- **Emoji** — emoji draw in one monochrome emoji font, in the color of the text, in the apps and in PDF, web page and SVG downloads, so they look the same on nearly every computer. Safari still draws keycap emoji such as 1️⃣ and some joined emoji in parts
- **Chinese and Korean text** — draws in Noto Sans SC and Noto Sans KR in the apps and in PDF, web page and SVG downloads, where a PDF printed Korean as boxes. Japanese kanji draw in their Chinese forms
- **Equations in Docs** — equations draw in New Computer Modern Math, so they look different, and the PDF and the web page show them in the editor's font
- **Web page downloads** — a download carries only the parts of each font its text uses: a short document is about 380 KB instead of 1.2 MB, a sheet or deck about 310 KB instead of 1 MB
- **The server image** — the API image installs no recommended packages, and no libvips or ImageMagick from Debian, which nothing used. SVG thumbnails draw Chinese and Korean text
- **Light backups (breaking)** — every `./eigen update` makes a Full backup, and `./eigen backup --light`, `./eigen update --full` and Light in **Back up now** are gone. Eigen no longer recognises the Light backups of 0.4.1 and before: it can't restore one, `./eigen status` doesn't list them and a start leaves their files as they are. Delete them by hand with `sudo rm backups/server-*-light-*`
- **Rolling back** — `./eigen rollback` keeps today's data when the version before opens it. It puts the update's backup back only when that version can't, or is too old to check, and a check that fails otherwise stops it with Eigen running as it was
- **Restoring a user or team in Admin** — the account keeps working while its backup is unpacked and checked, so a refused restore costs nobody their open pages. It goes offline only for the swap at the end, and needs room on the data disk
- **Private backups** — the files inside a backup and their records are for Eigen's own user alone. `backups/` takes the install folder's group with mode 2750, or stays as it is, with a warning, when other users share that group
- **Stopping during a backup** — before it stops Eigen, `./eigen` asks the server whether a backup or its upload runs, and waits for it. A server that doesn't answer gets a warning after a few tries, and the stop goes on
- **Copies a restore kept aside** — `./eigen status` lists the `data.pre-restore-*` and `.env.production.pre-restore-*` copies a restore leaves in the install folder, with the command to delete them. Each can be a full copy of `data/`
- **Uploading several files in Drive** — a file that fails no longer stops the files after it, and the files of one upload finish together
- **Copying in Drive** — **Copy to…** and **Save to Drive…** say "1 item copied" (or "3 items copied") with an **Open folder** button. **Duplicate** stays quiet
- **The command palette in Drive** — with items selected it offers what their right-click menu offers, in the same order and with the item's name beside each row. **Duplicate**, **Move to…**, **Copy to…**, **Watch**, convert and import are new there, and the Trash offers **Restore** and **Delete permanently**
- **Text files in Drive** — the editor for text, code and Markdown files no longer shows the properties column
- **The File menu of a document** — a document shared with you offers **Remove shared item**, and **Share** is hidden when you can't share it
- **Text boxes in PowerPoint files** — a text box aligned to the top downloads set to resize the shape to fit its text, and a rectangle set that way in a PowerPoint file comes in as a text box
- **Saving in dialogs** — Enter saves in New folder, Rename, Import to Calendar, a team's mounts and the bucket safety window. While a save runs, Cancel and Escape wait, and a failure keeps the dialog open with what you typed. Email collaborators and the Word, Excel and PowerPoint import choice wait the same way, and Email collaborators sends only on **Send**
- **Share** — **Save** stays grayed out until you change something, and the **Done** button is gone. **General access** reads Restricted or Unrestricted, and the lock on a shared item says "Anyone signed in with the link"
- **Importing events you already have** — Calendar says how many events were already in your calendars, or in the team's, instead of calling them duplicates

### Fixed

- **Odd font names in Sheets** — a font name with a semicolon, an opening parenthesis, a quote, a backslash or a control character draws and exports as Inter, so a name like O'Neill falls back
- **Function suggestions in Sheets** — the list of functions under a formula closes when you click another cell to finish the edit, instead of staying on screen
- **Printing** — printing a document, an email or a contact waits for its fonts, and a few seconds at most for its pictures, so they show on the page
- **Moving equations in Docs** — drag an equation to move it, as you drag an image. One that had a line to itself leaves no empty line behind
- **Equation drafts in Docs** — what you type in the **Equation** panel stays when someone else types above the equation, instead of jumping back to the saved equation
- **Restoring a version in Docs** — charts, images and equations keep their data, size and display when you restore a version while the document is open
- **Dialogs in Docs** — **Add link** stays off until you type a URL, and a URL you cancel is gone the next time it opens. Page setup, Headers and footers, Word count and the spacing, indent and numbering dialogs have a close button in the corner
- **Pictures and text boxes from Word files** — stay on the paper and line up by the size Word draws them at, in a resized drawing group too. Older Word text boxes keep their theme-colored fills and outlines and their wrap side, but can still run past the paper
- **The Format menu in Docs** — **Format › Text** shows the shortcuts for **Bold**, **Italic** and **Underline**, and **Format › Align and indent** marks the current alignment, as the toolbar does
- **Dialogs in Calendar** — Enter in an event's title saves it, **Edit event** stays open while it saves, a calendar's name can't be left blank, and **+** beside the sharing field in **Edit calendar** adds the person without saving and closing the dialog
- **Filters in the sidebar** — **All docs**, **All stickies**, **All slides**, **All sheets** and **All vectors** stay selected in their own app when you click an item in the list
- **Rename field in Drive** — the field reads **File name** or **Folder name**, not **Rename name**
- **The name in Rename** — **Rename** opens with the name selected without its extension, so typing replaces it, also from the command palette and a document's **File** menu
- **Cancel in Share** — Cancel stays after a save fails, so you can still close the dialog
- **Email collaborators from Share in Drive** — the envelope in **Share** opens **Email collaborators** again, and the message starts with your signature even when the dialog opens before your settings have loaded
- **Links on cards and in emails** — Enter in the link field of the text toolbar adds the link and no longer also saves the card or sends the email. Escape closes only the link field, and opening it no longer shifts the dialog sideways
- **Keys in a dialog opened from Drive** — Enter, Space and the arrow keys in a dialog opened from a file's menu stay in the dialog, so Enter in **Import to Calendar** imports instead of opening the file
- **Lists and dialogs over a file preview** — menus, lists, tooltips and the command palette show above an open preview, such as the right-click menu in **Save to Drive**, and a dialog over it closes on Escape or a click outside, that dialog alone, such as **New folder** in **Save to Drive**
- **Retrying an import into a new calendar** — a new calendar whose import fails is removed, so trying again uses the name and calendar you pick then
- **Groups in a contacts file** — a group card in an imported vCard file is no longer reported as a skipped duplicate
- **Share for someone who may only view** — in Chat, a member who may not edit gets the list of who has access with **Close**, instead of a list whose **Save** fails
- **Share on another item** — going back or forward to another document with **Share** open shows that item's people, not the ones you were editing
- **The keyboard in Share** — Tab reaches the lock under **General access** when you can change access, and a long list of people who have access, and Enter or Space works them. The same goes for an event's guest list, the people shown on a shared item in Drive and Chat, and **Location** in **Copy to**, **Save to Drive** and **New chat**
- **Previews opened from a card in Stickies** — the preview takes the keyboard, so Space closes it and Tab stays in it, a long preview scrolls, and a click beside it closes only the preview
- **Hover buttons from the keyboard** — Tab and screen readers reach the buttons a row shows under the pointer: the × on a person in **New chat**, **Edit** and **Delete** on your chat messages, a server backup's buttons in Admin, the pencil on a label in the Contacts sidebar and a guest's **Remove** in Calendar. In Drive's and Contacts' lists the menu key reaches a row's ⋮ instead
- **Keys on a row's menu button** — in Drive, Mail and contact lists, Enter and Space on a row's ⋮ button open its menu, and an arrow key after the menu closes moves on from that row
- **The keyboard cursor in Drive and Contacts** — in Drive's list view and in contact lists, the row under the keyboard cursor shows only its colored edge, as in Mail, unless that row is open or selected
- **Editing a chat message on a touch screen** — **Edit** in a message's long-press menu keeps the edit box open with the cursor in it, where the box could close at once while the message field had the keyboard
- **Focus after a menu** — **File › Rename** and then Escape in Docs and Sheets puts the focus back on **File**. A menu or dialog you opened with the mouse gives the focus back without a focus ring, so a hover button such as a calendar's ⋮ hides again once the pointer leaves
- **Rows under the column header in Drive** — a row the arrow keys scroll into view stops below the list's column header instead of behind it
- **The copy button on a code block** — it takes no click while it is hidden, so a click on the code no longer copies it
- **PDF downloads** — a PDF renders once, where now and then it rendered a second time, which could make a long export fail
- **Creating users and teams in Admin** — **Create** stays grayed out until the form is filled in: a name, a username and a password of at least 8 characters for a user, a name for a team
- **Labels in Contacts** — **Save** stays off until the label has a name, and the delete confirmation opens on top of **Edit label**, so a cancel keeps your changes
- **Permanently deleting emails in Mail** — when some emails can't be deleted, the dialog stays open on the ones worth another try and drops those the server refused, such as one already gone
- **Editing together in Sheets** — every tab ends with the same cells, the later of two edits to a cell winning, edits made offline too. A row someone inserts or deletes moves your selection
- **The grid in Sheets** — grid lines cross without a darker dot, the numbers in a row sit on one line, and underlines are level
- **Frozen rows and columns in Sheets** — their text and merged cells stop at the freeze line instead of drawing over the cells that scroll past
- **Filters and hidden rows in Sheets** — applying, changing or clearing a filter leaves the rows you hid by hand hidden
- **Typing after a menu in Sheets** — after a command from the Edit, View, Insert, Format or Data menu, such as inserting a row, typing and Delete work on the grid without a click first, as in Google Sheets
- **Sheet names in formulas** — a formula finds a sheet even when its name's case differs, as in Excel, so `=data!A1` reads the tab Data. A tab can't take another tab's name in another case
- **Formulas that didn't update in Sheets** — formulas with spaces such as `=A1 + 1`, INDEX, whole columns on another sheet, and whole columns after a row insert or a paste below the data recalculate when their cells change
- **Conditional format values in Sheets** — a rule refuses text where it needs a number and a Between rule with one value
- **Hiding the last sheet** — Sheets says a workbook always shows at least one sheet, instead of talking about deleting it
- **Message details in Mail** — the details under a sender read From, Reply-to, To, Cc, Bcc, Date and Subject, in the reader and the .eml preview
- **Opening an email from a notification** — an email you open from the bell shows as read in the Mail list after you move on to another one, without a reload
- **Custom sort in Sheets** — with **Data has a header row** ticked, the header row stays where it is
- **Picking a range in Sheets** — choosing cells on the grid in Data validation or the link editor keeps the rest of what you typed, and opening another dialog meanwhile no longer leaves the cell editor hidden. **Delete validation** with no range says why
- **Formats from the keyboard in Sheets** — in the custom number, date and currency formats, Tab moves to a preset or a currency and Enter picks it
- **Typing after a dialog in Sheets** — when a dialog closes, the link editor included, typing and the arrow keys work on the grid without a click first, and **Insert function** leaves you typing after the bracket
- **Deleting a rule on a protected sheet** — **Manage rules** refuses the delete, as **Delete sheet rules** already did
- **Links with a space in Sheets** — the link editor keeps OK grayed out for an address with a space in its host name, such as `not a url`, which it used to save as a link
- **Pasting from WPS Office** — a table pasted from WPS keeps its cell styles, such as bold and colors
- **Filter buttons on narrow columns** — a column narrower than its filter button keeps the button inside it, so a click opens that column's filter
- **Retrying a copy in Drive** — after **Copy to…** or **Save to Drive…** fails for some items, the retry copies only those items, so nothing lands twice
- **Copying large folders in Drive** — copying a folder or document larger than the upload size limit works, as long as it fits in the free space
- **Copying items with the same name** — copying any number of items with the same name into one folder lands every one of them at once, each under its own name
- **Several screenshots in one message** — a message with any number of pasted screenshots of the same name posts with all of them, each under its own name, in Chat and in the comments of Docs, Sheets, Slides, Stickies and Vector
- **A copy that fails in Drive** — a folder or document copy that fails part way leaves no half-copied folder in the target or in its Trash. If someone added their own files to that folder meanwhile, it goes to the Trash, so they can be restored. When only some items copy, the message says why the others failed
- **A copy that never ends in Drive** — a folder copy takes only what the folder held when it began. Moving the target into the folder meanwhile, or two copies between drives in opposite directions, no longer copy on until the drive is full
- **Copying over WebDAV** — a WebDAV copy meets the drive's free space and the upload size limit, as a copy in Drive does, and writes nothing past them
- **Read-only views in Drive** — the **Share** submenu stays in Watched and in folders shared for viewing only, with **Copy link** and **Mail to…**
- **Quick preview of folders** — **Space** and the preview in the details column no longer open on a folder, and **Space** works in **Shared with me** and **Shared by me** in Docs, Sheets, Slides, Stickies and Vector
- **Dragging in Drive** — folders no longer light up as drop targets in views where you can't move items
- **Duplicate on shared files** — Drive no longer offers **Duplicate** on a file someone shared with you, or on a selection with one in it, which then failed
- **The command palette after a rename** — the palette shows an item's new name, and its **Watch** row shows when you already watch it
- **Keys after a dialog** — closing a dialog, the command palette or a preview puts the focus back where you were, so the arrow keys work without a click
- **Pictures in PowerPoint files** — a picture set to Fit or Fill downloads as one picture and comes back looking the same. An imported picture cropped evenly on two sides comes in as Fit or Fill, and the import message counts any other crop
- **Pasting text boxes in Vector and Slides** — a pasted text box in Chinese, emoji or bold text fits its text, and one undo removes the paste instead of first shrinking the box
- **Arrow labels in Vector and Slides** — a label's gap in its arrow fits the label after undo, redo and a late-loading font
- **Calendar notices** — an invitation or a shared calendar from someone with no name or address shows a plain title, such as "New invitation" or "Calendar shared with you", instead of "undefined shared a calendar"
- **One data folder, one server** — a second Eigen server on another machine or VM, such as one that reaches `data/` through a Docker Desktop folder or WSL2, refuses to start while the first one runs
- **Crafted backups** — a backup someone uploaded can no longer make an interrupted restore of one account move another account aside
- **Uploads after a restore** — a whole-server restore of an older backup keeps the files it had not yet sent to an S3 bucket, also after a restore of one account in between
- **The trash after a restore in Admin** — a file trashed before the backup stays in the trash for the full retention period, instead of being deleted for good seconds after the restore
- **The owner's backups in Admin** — only the owner can back up, restore, upload, verify, download or delete backups of the owner's account. Other admins no longer see its **Backup** section
- **Slow transfers in Drive and WebDAV** — a slow WebDAV or Drive upload, copy, convert, export or import no longer fails when it runs past five idle minutes
- **WebDAV locks** — a lock on a file no longer ends when your home goes idle. It lasts until it expires or the client releases it
- **Chats during a restore** — an open chat no longer fails when its version is restored at the same moment
- **Open files on the server** — a document, board or chat that was read for search or export no longer stays open until its home closes, so the server keeps fewer files open
- **Live updates and open editors** — a tab's live updates and an open editor stay connected while the tab is open, and reconnect after a restore
- **S3 uploads when a home closes** — an upload to S3 that a closing home cuts short can no longer overwrite newer edits

## [0.4.1] - 2026-10-28

Docs gets page-less documents, text boxes, a table of contents and an outline, and an image can sit behind or in front of the text. In Sheets you can style part of a cell's text, and undo keeps up with other people's edits. In Slides and Vector you can type in shapes, and charts can show their values. After you update, reload any Docs document you have open, or a tab still on 0.4.0 deletes the text boxes and tables of contents it receives and can shrink wide tables for everyone.

### Added

- **Page-less documents in Docs** — **File → Page setup…** or **Format** turns a document into one continuous column with no page breaks, headers or footers, as in Google Docs. It still prints on its paper
- **Text width** — pick **Narrow**, **Medium**, **Wide** or **Full** for page-less documents. Your width follows you to every device, and the people you share with keep theirs
- **Wide tables and images** — in a page-less document, a table can grow past the text and scroll sideways, and an image or chart can be as wide as the paper
- **Page-less Word files** — a Word file in Web Layout opens page-less, and a page-less document downloads in Web Layout
- **Text boxes in Docs** — **Insert › Text box** adds a box you type in where it stands. Place it in line, beside, behind or in front of the text, and drag it anywhere
- **A text box's look** — the **Text box** panel sets its size, fill, outline, corners, padding and where its text sits. The box grows with its text
- **Text boxes in Word files** — come in and go out as text boxes, in place and with their look. One inside a header, footer, footnote, group or drawing canvas comes in as text
- **Images behind or in front of text** — in Docs, drag an image or chart anywhere, behind or in front of the text. It moves with its paragraph, and Word files keep it. On a phone, use **Format → Image**
- **Image and chart size in Docs** — set the width and height in centimeters, with **Keep aspect ratio**. A stretched image stays stretched in prints, downloads and Word files
- **Table borders in Docs** — all borders, a box or none, in any color, from the **Table** panel or **Format › Table**. A new row or column copies its neighbor's borders and fill
- **Table borders in Word files** — keep their colors, widths and dashes both ways, and a borderless Word table stays borderless
- **Outline in Docs** — **Tools → Show outline** lists the headings on the left. Click one to jump there. On a desktop it stays open across documents in that browser, on a phone it's in the **⋮** menu
- **Table of contents in Docs** — **Insert → Table of contents** lists the headings down to Heading 3 and stays up to date. Click a line to jump. PDFs show page numbers, and Word downloads hold Word's own
- **Tables of contents in Word files** — come in as a live table of contents, and the import message says when its entries differed. A **Contents** title above it stays normal text, not a Heading 1
- **Bra-ket notation in equations** — `\bra`, `\ket`, `\braket`, `\expval`, `\mel` and `\ketbra` in Docs equations, with brackets that grow to fit
- **Styling part of a cell in Sheets** — while you edit a cell, make selected words bold, italic, underlined, struck through, or another color, font or size. Pasted text comes in plain, and Excel downloads keep the styles
- **Italic and underline shortcuts in Sheets** — **Ctrl+I** and **Ctrl+U** (Mac: **⌘I**, **⌘U**) work on selected cells, and with **Ctrl+B** on selected words in a cell
- **Slides on a phone** — a row of slide thumbnails sits under the slide. Tap one to jump to it
- **SmartArt in PowerPoint files** — comes in as shapes and text you can edit. One saved without its shapes, as LibreOffice does, leaves a **SmartArt not imported** box with its text
- **Chart data labels** — **Data labels** writes each value on a column, bar or line chart, in Docs, Sheets, Slides and Vector. Labels that would overlap hide, and Office files keep them both ways
- **What a download left out** — after a download, or a print from Docs, a message counts what the file left out or drew simpler, and says when part of it couldn't be read
- **Preferences in Space** — a new page for the theme (Light, Dark or System) and Celebrations
- **Celebrations** — now and then, ticking the last box of a checklist on a Stickies card or a comment card bursts confetti
- **Text in shapes** — in Vector and Slides, double-click a rectangle, diamond or ellipse, or select it and press Enter, to type in it. Text that does not fit spills past its edge

### Changed

- **Labels in sentence case** — buttons, menus, dialogs and fields in Admin, Calendar, Chat, Contacts, Docs, Drive, Mail, Sheets, Space and Stickies capitalize only the first word and names, such as **Reply all**
- **Menus in Docs, Sheets, Slides, Vector and Stickies** — with a menu open, point at another or use the arrow keys to open it. One click switches menus
- **Links** — underlined, as in Word and Google Docs, in Docs and its downloads, Stickies, the email you write in Mail, the help center and the blog
- **Tables in Docs** — a table keeps its column widths when the page gets narrower, and scrolls sideways. A table in a list or a cell still shrinks
- **Decimals** — Docs margins show two decimals, such as 2.00 cm. Number fields in Slides and Vector show at most two, and line height and letter spacing at least one, such as 1.0
- **Shortcuts in the Sheets menus** — **Edit** shows the shortcut of Undo, Redo, Cut, Copy, Paste, Find and Find and replace, and **Format → Text** shows it for Bold, Italic and Underline
- **How far undo goes in Sheets** — back 200 steps, and no further back than the tenth latest insert or delete of rows, columns or sheets
- **Large sheets in PDFs** — a sheet too large for the PDF keeps the columns one page holds, 192 at the default width. A web page download keeps more while all its rows fit
- **Shapes in PowerPoint files** — a shape with text imports and exports as one shape holding its text. Text boxes, titles, text on a line or arrow, and turned text stay text boxes
- **Forwarding email** — a forward brings the original's attachments, inline pictures too. Remove one with the **X** on its chip
- **Contacts** — the list fills the page until you open a contact. A link to a deleted contact opens to **Contact not found**
- **Teams in Admin** — teams get a list page, like users. To add people, select them on the **Users** page, right-click and choose **Add to team…**, which replaces dragging them onto a team
- **Users in Admin** — a user's details list their teams, with **Add to team** and a **×** to take them out of one
- **Restore commands in Admin** — the server backup settings show each restore command with a copy button
- **Space home** — admins get an Admin tile, and **Help and support** takes the help center's teal
- **Help center colors** — each app's section shows its title in the app's color, such as amber for Mail

### Fixed

- **Undo in Sheets while others edit** — undo finds your cell after others insert or delete rows, columns or sheets, skips a cell someone else changed since, and keeps their edits
- **Formulas after an undo** — every formula an undo or redo touches shows what its cells give now, and undoing a row delete repairs the formulas it broke
- **Others' edits in Sheets** — show up on a sheet you never opened, and while the spreadsheet is still opening. Closing a spreadsheet leaves everyone else's view and undo history alone
- **Typing in a cell while others edit** — your cell moves with its row or column as others insert or delete them, so Enter writes where you meant. If they delete it, the edit closes
- **Formulas across sheets** — a formula that points at another sheet follows the rows and columns inserted or deleted there, in downloads and previews too, and for whoever opens it next
- **Undo while you type in a cell** — **Ctrl+Z** (Mac: **⌘Z**) undoes only your typing
- **Delete in Sheets** — Delete and Backspace clear cells, links too, and keep their formatting, as in Excel and Google Sheets
- **Errors in Sheets formulas** — a formula sees an error in a cell it reads: with 1/0 in B1, `=IFERROR(B1,"none")` gives none and `=B1+1` gives #DIV/0!. COUNTIF counts the error cells you name, and AGGREGATE can skip them
- **Errors in Excel files** — error cells such as #N/A import and export as errors, and `#N/A` typed into a text-formatted cell stays text
- **IFERROR in Sheets** — gives its fallback for a mistyped name. An Excel function Sheets can't calculate yet, such as FILTER, shows #NAME? unless IF, CHOOSE, IFS or SWITCH skips it. An imported file keeps Excel's value
- **Sheets shortcuts on other keyboard layouts** — copy and cut work on Dvorak, and bold, italic and underline work in a cell on Russian and Greek layouts. On a Mac they take **⌘**, as in Docs
- **Wrapped text in Sheets** — **Wrap** or a bigger font size makes the row tall enough for the text, and a cell that mixes styles breaks its lines between words
- **Color scales in Sheets** — short colors such as `#f00` shade cells instead of leaving them blank
- **Conditional colors in Sheets** — a cell a rule colors keeps that color while you type in it, and when you copy it into another app
- **Link cards in Sheets** — a menu or dialog open over a link cell no longer shows that cell's link card
- **Resizing a chart in Sheets** — a large sketched chart keeps up with the pointer
- **Sheets menus on a phone** — all six menus fit a 390 pixel wide screen, and a narrower one scrolls
- **Names and charts in search** — search finds a chat message or emote by a person's name, and a spreadsheet by its charts' titles and series names. Comment results in the command palette name who wrote last
- **Inserting an Excel file in Sheets** — an insert that would make the spreadsheet larger than an import allows is refused with **This spreadsheet is too large to import**, and nothing changes
- **Excel named ranges** — a formula like `=SUM(Sales)` keeps working as its cells change, though the name isn't kept. A dropdown from a named range comes in as a list, and the import message counts names Eigen can't follow
- **Excel row heights** — a normal-height row with wrapped text stays normal, and Excel downloads keep the heights Eigen shows
- **Copied charts** — a chart copied from Sheets into Docs, Slides or Vector keeps its axis number format, so 25% doesn't turn into 0.25
- **100% stacked charts in Office downloads** — the axis runs from 0% to 100%
- **Spreadsheet PDF** — thousands of small sheets print the first 2,000 instead of failing, and a cell of thousands of lines prints on one page
- **Spreadsheet downloads** — a spreadsheet with very many charts or pictures downloads with the ones that fit instead of failing, and so does its preview. A picture too large to process is left out
- **Spreadsheet previews** — a merged cell cut off at the edge shows no border there. An image or chart on a sheet with hidden columns shows within the first 50 visible columns
- **Wide tables in Docs PDFs** — a table wider than the page fits it in the PDF and web page download, with no columns cut off. A word too long for its column breaks inside its cell
- **Long tables in Docs PDFs** — a table continues on the next page instead of jumping there whole, and a tall row splits, as in Word
- **Pictures in downloads** — a document, spreadsheet or deck with photos downloads as a PDF much faster and at a fraction of the size. Office files and PDFs hold photos and screenshots as JPEG, and only see-through pictures as PNG
- **Pasted photos in Docs downloads** — web page and PDF downloads strip a pasted photo's camera details and location, as Word downloads do. An animated GIF shows its first frame, and an image that can't be cleaned is left out
- **Pictures in footnotes** — a picture in a Docs footnote sits on a line of its own, not beside the note's text
- **Comments in downloads** — web page downloads and Drive previews show commented text without the yellow highlight
- **Long code blocks** — many long code blocks with no language set no longer stall a download or preview. Past about 65,000 characters in all, the rest has no syntax colors
- **PowerPoint arrows** — bent and curved connectors keep their arrowheads. A bent one with three or more right-angle legs comes in as an elbow arrow, other bent ones as a sharp arrow, a curved one as a curved arrow
- **Saving a text file in Drive** — a save over someone else's newer change shows **File conflict** instead of overwriting it. Recent activity lists your save as an edit, not an upload
- **Paths in Drive** — a file or folder shared with you shows its path from **Shared with me**, a public one from the first folder you can open, a team drive's from the drive's name, each folder a link
- **Closing a text file shared on its own** — takes you back to **Shared with me**, not to an access request for its folder
- **Team drives** — a file someone adds, renames, moves or trashes in a team drive or shared folder shows at once in the open view of everyone who can open it. A big upload fills the list as it goes
- **Trash in Drive** — a file or folder deleted for good leaves the Trash in your other tabs too
- **Unread counts in Mail** — reading a message in another mail app clears its count at once
- **Sharing a calendar** — the list of who has access refreshes at once in every open tab when a calendar is shared or stops being shared
- **New events late in the evening** — in Calendar, a new event made after 23:15 ends on the next day instead of before it starts. So does one with **All day** turned off that late
- **Job titles in Contacts** — a contact with a job title and no company shows the title under the name
- **Finding a person in a filter** — **Home** and **End** in a person search, such as Stickies' **Filter › Assigned to**, move the cursor on Windows and Linux
- **Passwords with accents** — a password with accents or other non-English letters works for calendar, contacts and file sync
- **Last active in Admin** — a mail, calendar or file client that signs in with an account's password no longer counts, so it shows when the person last used Eigen in a browser
- **Picking a theme** — the theme changes the moment you pick it, without a **Settings saved** message
- **Deleting a team in Admin** — removes its drives, files and calendar from the server. A team being backed up or restored can't be deleted, and the dialog says why. The default team has no delete or remove buttons
- **Backups on a shared server** — `data/`, backups, `./eigen`'s log and what a backup, check or restore unpacks are readable by Eigen's own user alone. 0.4.0's home backups close at the next start, and `backups/` itself stays readable
- **Updates on the main channel** — an update to a new build of `main` makes a Full backup when a change not released yet is marked as needing one
- **Restore and rollback** — when one would set aside the folder of a user or team made since the backup, it lists them and asks again before it stops Eigen. A user or team being deleted can't be restored
- **Setup copies of the accounts** — `./eigen status` lists each copy of the login database that setup kept, and how to delete it

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
