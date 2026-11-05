---
title: "Restore a previous version of a document"
description: "Save a named version of your document at any point and restore it later if you need to go back."
type: how-to
tags: [docs, versions, history, restore]
related: [docs/create-and-edit, docs/comments]
order: 130
updated: 2026-11-05
---

Docs keeps a version history for every document you own or can edit. You can save a snapshot at any point, then browse the list and roll back to an earlier state whenever you need to.

## Save a version

1. Open the document in Docs.
2. Click **File** in the toolbar.
3. Click **Save version now**.

A toast confirms "Version saved". The version is added to the list and labeled with the date and time it was saved.

## View and restore a version

1. Click **File** in the toolbar.
2. Click **Version history**. A submenu opens showing all saved versions, each labeled with its date and time.
3. If the list is empty, **No versions yet** appears. Save a version first if you want a restore point.
4. Click the version you want to go back to. A confirmation dialog opens.
5. Click **Restore** to confirm.

Docs saves the current state as a new version before it overwrites anything, so you can come back to where you were by restoring that entry.

<div class="eigen-callout">

A restore brings back the comments that version had, including one you deleted since. It doesn't roll back what was said: each comment's replies stay as they are now.

</div>

## Delete the version history

You can delete a document's whole version history, for example to free up space.

1. Click **File** in the toolbar.
2. Point at **Version history**. **Delete history…** is the last row, below the list of versions, and grayed out until there is a version.
3. Click **Delete history…**. A dialog says how much space it frees.
4. Click **Delete history** to confirm.

Every earlier version goes, and so do the versions of the document's comments. You can't undo this. Images and comments you deleted from the document are removed right away, except those added or replied to in the last three days. If removing them fails, the versions are still gone, but those images and comments stay. If someone else has the document open, their **Undo** can't bring those back.

## Who can use version history

Version history is available to anyone with edit access to the document. If you can only view the document, the **File** menu does not show these options. See [Share a document and set access](/support/docs/share-a-document) to change who can edit.

Only an owner of the drive the document is in can delete its history: you in your own drive, or any member of the team in a team drive. An editor you shared the document with can save and restore versions, but doesn't see **Delete history…**.
