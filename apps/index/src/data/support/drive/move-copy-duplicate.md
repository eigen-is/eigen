---
title: "Move, copy, and duplicate files"
description: "Use Move to, Copy to, and Duplicate to put a file somewhere else in Drive, including another drive."
type: how-to
category: Basics
tags: [drive, files, folders, move, copy, duplicate, organize]
related: [drive/rename-move-organise, drive/share-a-file]
order: 75
updated: 2026-11-12
---

Dragging works well for a folder you can see on screen. When the destination is somewhere else, or in another drive, the right-click menu has three options that open a folder picker instead: **Move to…**, **Copy to…**, and **Duplicate**.

For dragging an item onto a folder, see [Rename, move, and organize files](/support/drive/rename-move-organise).

## Move a file to another folder

1. Right-click the file or folder (or click the **⋮** button at the end of its row).
2. Choose **Move to…**.
3. In the **Move to** dialog, pick the drive on the left, then click through the folders to the one you want.
4. Click **Move here**.

The picker starts in the folder you are browsing. The row at the top shows where you are, and you can click any part of it to step back up. To put the item somewhere that does not exist yet, click **New folder** and give it a name.

If some of the items fail, a message says how many and why, and the **Move to** dialog stays open with only those items left. Click **Move here** again to retry them.

<div class="eigen-callout">

**Move to…** works inside one drive. If you choose a different drive, Eigen tells you to use **Copy to…** instead.

</div>

## Copy a file somewhere else

1. Right-click the file or folder and choose **Copy to…**.
2. In the **Copy to** dialog, pick the drive and folder the way you would for a move.
3. Click **Copy here**.

The original stays where it is. Unlike a move, a copy can go into any drive you can write to, including a team drive.

When the copy is done, a message says **1 item copied** (or **3 items copied**, and so on) with an **Open folder** button that takes you to the destination.

If some of the items fail, a message says how many and why, and the **Copy to** dialog stays open with only those items left. Click **Copy here** again to retry them. The ones that already copied are not copied a second time.

Copying a folder copies everything inside it. A folder or a document only needs to fit in the free space of the drive you copy it to. A single file must also be within the upload size limit. A folder that fails part way leaves nothing half-copied in the folder you picked, and nothing in the Trash. If someone added their own files to the folder while it copied, the folder goes to the Trash instead, so those files can be restored. Copying a document, spreadsheet, presentation, board, or drawing gives you a working file with the same contents. The copy starts its own version history and does not get the original's. The copy leaves out the images and comments you deleted from the original, which only its earlier versions could bring back. The same goes for **Duplicate**.

## Duplicate a file in place

To make a second copy next to the original, right-click it and choose **Duplicate**. The new item appears in the same folder, named **Copy of** followed by the original name. Eigen shows no message when it is done.

With a document, spreadsheet, presentation, board, or drawing open, choose **File → Make a copy** for the same copy. A message says **Copy made**, with an **Open** button for the copy, and you stay in the original. The option is grayed out for a file you can only read or that someone shared with you.

**Duplicate** is also in the menu when you browse a list of files from several folders, such as a type filter, but not for a drive's top-level folder or for files you can only read.

## Work on several items at once

Select more than one item first. Hold Shift and click to select a range, or hold Ctrl (Command on a Mac) and click to add items one at a time. Right-click the selection and the menu counts them for you: **Move 3 items to…**, **Copy 3 items to…**, **Duplicate 3 items**, or **Mail 3 items to…**.

**Move to…** isn't offered in a list of files from several folders, such as a type filter. **Copy to…** and **Duplicate** are.

## What happens to sharing

- **A move keeps the item's own sharing.** The people you added to the file itself still have access. People who could only see it because they had access to the old folder lose it, and people with access to the new folder gain it.
- **A copy does not carry sharing over.** The new file starts private to you, and then picks up whatever the folder you copied it into is shared with. If other people need the copy, share it again. See [Share a file or folder](/support/drive/share-a-file).

You cannot move or copy a folder into itself, or into a folder inside it. Eigen refuses that, because the folder would end up containing itself.
