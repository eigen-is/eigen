---
title: "See and restore previous versions of a file"
description: "View the version history of a document, spreadsheet, presentation, board, or drawing, and restore an earlier version if you need to."
type: how-to
category: Files
tags: [drive, versions, history, restore, docs, sheets, slides, stickies, vector]
related: [drive/get-started, drive/use-the-trash]
order: 120
updated: 2026-11-05
---

Eigen keeps a history of saved states for every document, spreadsheet, presentation, board, and drawing you own or can edit. You can browse that history and restore an earlier version at any time.

Version history is available in the **File** menu inside the editor. It is not shown for plain uploaded files, only for Docs, Sheets, Slides, Stickies, and Vector.

## Save a version manually

Open the file you want to snapshot, then click **File** in the toolbar and choose **Save version now**. Eigen saves the current state straight away and shows a brief "Version saved" confirmation. You can do this at any point, for example before making a big change.

Eigen also saves versions automatically as you work. These automatic saves follow the same retention schedule as manual ones, so the two are listed together in the history.

## View and restore a previous version

1. Open the file in its editor.
2. Click **File** in the toolbar, then point at **Version history**.
3. A list of saved states appears, each labeled with the date and time it was saved. The most recent is at the top.
4. Click the entry you want to go back to. A confirmation dialog opens.
5. Click **Restore**.

Eigen saves the current state as a new version before overwriting it, so the version you had open is not lost. To undo the restore, open **File → Version history** again and pick that newly saved entry. If the file's stored data could not be found, there is nothing to save, so Eigen restores without saving a version first. The same list of versions also shows on the screen that says the stored data could not be found, as described in [Editing when your connection drops](/support/getting-started/working-offline).

A spreadsheet version Eigen can't read can't be restored. Eigen says so, and the spreadsheet stays as it is.

<div class="eigen-callout">

A restore brings back the comments that version had, including one you deleted since. It doesn't roll back what was said: each comment's replies stay as they are now.

</div>

## Delete the version history

To free up the space a file's versions take, you can delete its whole history. Open the file, click **File** in the toolbar, point at **Version history** and click **Delete history…**, the last row below the list, grayed out until there is a version. A dialog says how much space it frees. Click **Delete history** to confirm.

Every earlier version goes, and so do the versions of the file's comments. You can't undo this. Images and comments you deleted from the file are removed right away, except those added or replied to in the last three days. If removing them fails, the versions are still gone, but those images and comments stay. If someone else has the file open, their **Undo** can't bring those back.

## How long versions are kept

Eigen keeps up to one version per hour for the last 24 edited hours, then one per day for the past seven days, one per week for the past four weeks, and one per month for up to a year. Once those limits are reached, older versions are removed automatically.

## Who can use version history

Version history is available to anyone who can edit the file. Viewers cannot save or restore versions.

Only an owner of the drive the file is in can delete its history: you in your own drive, or any member of the team in a team drive. An editor you shared the file with can save and restore versions, but doesn't see **Delete history…**.
