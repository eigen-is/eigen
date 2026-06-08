---
title: "See and restore previous versions of a file"
description: "View the version history of a document, spreadsheet, presentation, or board, and restore an earlier version if you need to."
type: how-to
category: Files
tags: [drive, versions, history, restore, docs, sheets, slides, stickies]
related: [drive/get-started, drive/use-the-trash]
order: 120
updated: 2026-06-08
---

Eigen keeps a history of saved states for every document, spreadsheet, presentation, and board you own or can
edit. You can browse that history and restore an earlier version at any time.

Version history is available in the **File** menu inside the editor. It is not shown for plain uploaded files,
only for Docs, Sheets, Slides, and Stickies.

## Save a version manually

Open the file you want to snapshot, then click **File** in the toolbar and choose **Save version now**. Eigen
saves the current state straight away and shows a brief "Version saved" confirmation. You can do this at any
point, for example before making a big change.

Eigen also saves versions automatically as you work. These automatic saves follow the same retention schedule as
manual ones, so the two are listed together in the history.

## View and restore a previous version

1. Open the file in its editor.
2. Click **File** in the toolbar, then point at **Version history**.
3. A list of saved states appears, each labelled with the date and time it was saved. The most recent is at the
   top.
4. Click the entry you want to go back to. A confirmation dialog opens.
5. Click **Restore**.

Eigen saves the current state as a new version before overwriting it, so the version you had open is not lost.
To undo the restore, open **File → Version history** again and pick that newly saved entry.

<div class="eigen-callout">

Comments and attachments are not rolled back when you restore a version. Only the file contents change.

</div>

## How long versions are kept

Eigen keeps up to one version per hour for the last 24 edited hours, then one per day for the past seven days,
one per week for the past four weeks, and one per month for up to a year. Once those limits are reached, older
versions are removed automatically.

## Who can use version history

Version history is available to anyone who can edit the file. Viewers cannot save or restore versions.
