---
title: "Share a spreadsheet and comment on cells"
description: "Give other people access to a spreadsheet in Sheets, control what they can do, and add comments to individual cells."
type: how-to
category: Sharing
tags: [sheets, sharing, permissions, comments, collaboration]
related: [sheets/get-started, drive/share-a-file, getting-started/how-sharing-works]
order: 120
updated: 2026-06-08
---

A spreadsheet is private to you until you share it. You can give specific people access, share with a
whole team, or give anyone with the link the ability to view or edit. Once collaborators have access,
you can use cell comments to leave notes and discuss specific values without changing the data itself.

## Open the Share dialog

There are two ways to open the Share dialog from inside Sheets:

- Click the **Share** button (the person-with-plus icon) in the top-right corner of the toolbar.
- Open the **File** menu and choose **Share**.

The dialog title shows the spreadsheet name: **Share 'your spreadsheet name'**.

## Share with specific people

1. Open the Share dialog.
2. Type a name or email address in the box at the top. Pick the person from the suggestions.
3. They appear under **People with access** as an **Editor** by default.
4. To change their access, open the dropdown next to their name and choose **Editor** (view and make
   changes) or **Viewer** (view only).
5. Click **Save**.

To remove someone later, open the same dialog, set their dropdown to **Remove**, and click **Save**.

Some people in the list may show "(inherited from /foldername)". They have access because the folder
containing this spreadsheet is already shared with them. Their access level cannot be changed here.
To change it, update the sharing on that folder in Drive.

## Share with a team

If you belong to one or more teams, a **Share with team** button appears at the bottom left of the
dialog. Click it and pick a team to give everyone in that team access.

## Share with a link

Under **General access**, the spreadsheet starts as **Restricted**, meaning only the people you have
added can open it.

To share more widely, click the lock icon to switch it to **Unrestricted**. A dropdown appears next
to the label where you can choose **Can view** or **Can edit**. Anyone signed in to Eigen who has
the link can then open the spreadsheet at that permission level.

To copy the link, click the link icon next to **People with access**.

<div class="eigen-callout">

An **Unrestricted** spreadsheet still requires the other person to sign in to Eigen. It is not open
to the public web. There is no anonymous, sign-in-free access.

</div>

## Email your collaborators

After saving your changes, you can send everyone who has access a message with a link.

1. Open the **File** menu and choose **Email collaborators**. (You can also click the envelope icon
   in the Share dialog's **People with access** section, but you must save any pending changes first.)
2. Fill in the **Subject** and write a **Message**.
3. Click **Send**. A link to the spreadsheet is included automatically.

## Control who can change sharing

If you own the spreadsheet, you can stop editors from sharing it with others. In the Share dialog,
look for the **Editors can share** checkbox near the bottom. When it is unchecked, only you can add
or remove people. Editors can still work on the spreadsheet but cannot change who else has access.

## Add a comment to a cell

You need write access to add comments. If you only have view access, the option is not available.

1. Click the cell you want to comment on.
2. Right-click and choose **Add comment** from the context menu. You can also open the **Insert**
   menu and choose **Comment**.
3. In the **New comment** dialog, the **Title** is pre-filled with the cell address (for example,
   "Cell B3"). Edit it if you like, and add a longer note in the **Description** field. Pick a colour
   for the comment marker.
4. Click **Add comment**.

A small triangle appears in the corner of the cell to show it has a comment attached.

## Open the comments panel

Click the **Comments** button (the speech bubble icon) in the top-right corner of the toolbar. A
number badge shows how many open comments the spreadsheet has.

The panel slides open on the right and lists every comment. Click a comment to open its thread.

## Filter comments

At the top of the panel, two controls let you narrow the list:

- **All / For you**: **For you** shows only comments where you have been mentioned in the thread.
- **Open / Resolved / All**: filters by status. The default is **Open**.

## Resolve or reopen a comment

When a discussion is finished, you can mark the comment resolved.

- Right-click the cell and choose **Resolve comment** from the menu.
- Or open the comment thread and click the checkmark icon (**Resolve**) near the top of the dialog.

Resolved comments stay in the spreadsheet. Switch the panel filter to **Resolved** or **All** to
see them. To reopen one, right-click the cell and choose **Reopen comment**, or open the thread and
click the circular-arrow icon (**Re-open**).

## Edit, change colour, or delete a comment

Right-click a cell that has a comment to see its options:

- **View comment**: opens the comment thread.
- **Comment color**: change the colour of the cell marker.
- **Resolve comment** / **Reopen comment**: toggle the status.
- **Delete comment**: removes the comment from the cell. This cannot be undone.

To edit the title or description of an existing comment, open the thread and click the pencil icon
(**Edit**) near the top of the dialog.

## Copy a link to a comment

Open a comment thread and click the link icon (**Copy link**) near the top of the dialog. The link
opens the spreadsheet with that comment thread already visible, so you can share it directly with
a collaborator.
