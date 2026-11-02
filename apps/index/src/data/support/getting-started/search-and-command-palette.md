---
title: "Find anything with search and the command palette"
description: "Search your files and email, jump between apps, and run quick actions from one box with the command palette."
type: how-to
category: Basics
tags: [search, command-palette, navigation, getting-started]
related: [getting-started/your-first-steps, account/light-and-dark-theme, drive/get-started]
order: 3
updated: 2026-11-02
---

Eigen has one box that searches your files and email, jumps to any app, and runs quick actions. It's called the command palette, and you reach it from anywhere with a single keystroke. This page shows you how to open it and what it can do.

## Open the command palette

You can open the palette in two ways:

- Press **⌘K** on a Mac, or **Ctrl+K** on Windows.
- Click the search box at the top of the window. It reads **Search and jump anywhere**, or shows the document's name when you have one open.

The box appears in every Eigen app. The keyboard shortcut works from anywhere, even while you're typing in a message or a document. Press the same keys again, or **Esc**, to close it.

When the palette opens, type into the **Search and jump anywhere…** box. Results appear as you type, grouped by what they are. Use the arrow keys to move up and down, and press **Enter** to open the highlighted result. The hints along the bottom (**↑↓ navigate**, **↵ open**, **Tab scope**, **esc close**) are a reminder of these keys.

## Find a file

Start typing part of a file or folder name. Matches show up under a **Files** heading, each with the icon for its type.

Press **Enter** on a file to open it. Documents, spreadsheets, and presentations open in their editor; other files, such as images and PDFs, open in a preview. Search looks at file and folder names, and at the text inside your documents, spreadsheets, presentations, drawings, boards, and chats. It covers your own files and the drives of every team you belong to, so you don't have to remember where something lives.

## Find an email

Type a word from a message and matches appear under a **Mail** heading, showing the sender, the date, and the subject. Press **Enter** to open the message in Mail.

Email search looks at the subject, the sender, the people a message was sent to, and a short preview of the body. To narrow a search to a sender or recipient, add `from:` or `to:` followed by a name or address:

- `report from:alice` finds messages about a report from Alice.
- `invoice to:finance` finds messages about an invoice sent to finance.

Messages in your Trash and Junk are left out of the results.

## Narrow to one kind of result

If you only want one kind of result, you can limit the search. Press **Tab** to cycle through the groups: **Files**, then **Mail**, then **Actions**, then **Contacts**, then **Help**. With a document open, **In document** comes first. The current group shows as a small label above the box. Press **Backspace** with the box empty to clear it and search everything again.

You can also type a prefix to jump straight to a group:

- `file:` for files.
- `mail:` for email.
- `@` for contacts.
- `>` for actions.
- `?` for help articles.
- `doc:` for the document you have open.

So `mail: invoice` searches only your email, and `@alice` looks only for the contact Alice.

**Help** searches this help center from wherever you are, so you don't have to leave the app to look something up. Matches appear under a **Help** heading and open the article.

**In document** searches the document, spreadsheet, presentation, drawing, or board you have open. Matches in the text appear under **In document** and matches in its comments under **In comments**. Press **Enter** on one and the find bar opens with that match highlighted. Without a document open the palette tells you so.

## Jump to an app or run an action

The palette is also the fast way to move around and start things. Type the name of what you want and pick it from the **Actions** group:

- **Go to Mail**, **Go to Drive**, **Go to Calendar**, and the same for every other app.
- **New doc**, **New sheet**, **New slide**, and **New folder**, which create the item in Drive.
- **Toggle theme**, to switch between the light and dark look. See [Switch between light and dark theme](/support/account/light-and-dark-theme) for more.

Open the palette without typing anything and you get a short **Suggested** list of common actions to get you going.

## Type an email address or a link

The palette understands a couple of things you paste in:

- Type a full email address and choose **Mail to** to start a new message to that person.
- Paste a web address (starting with `http://` or `https://`) and choose **Open link** to open it in a new tab.

## Act on a file you've selected

In Drive, select a file or folder first, then open the palette. The actions for that item appear at the top under a **Selection** heading, each with the item's name beside it. They're the actions of the item's right-click menu, under the same names: you can **Open** it, **Rename** it, **Duplicate** it, **Move to…** or **Copy to…** another folder, **Share** it, **Copy link**, **Watch** it, **Move to trash**, and more, without leaving the keyboard. With several items selected you get the actions that work on all of them, such as **Move 3 items to trash**. **Email collaborators** shows only for an item someone else can see, and a file that can be converted or imported offers the same convert and import actions as its menu, such as **Convert to sheet** or **Import to Contacts**. In the trash, the palette offers **Restore** and **Delete permanently**.

Inside a document, the palette acts on the document you have open, with the actions of its **File** menu plus **Copy link** and **Mail to…**. Type "download" to see a row for each format the **File → Download** menu offers, such as **Download as Microsoft Word (.docx)**. A document selected in Drive offers the same rows.

<div class="eigen-callout">

The command palette lives inside the Eigen apps. This help center isn't an app, so the **⌘K** shortcut won't open it here. Open Drive, Mail, or any other app first.

</div>
