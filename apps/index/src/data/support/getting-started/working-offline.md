---
title: "Editing when your connection drops"
description: "What the red wifi icon means, where your edits go while you are offline, why Eigen warns you before you leave the page, and what to do when it is about to restart."
type: troubleshooting
category: Basics
tags: [offline, sync, editing, troubleshooting, getting-started]
related: [getting-started/your-first-steps, drive/file-versions]
order: 7
updated: 2026-11-12
---

Documents, spreadsheets, presentations, drawings, and boards save themselves as you type, which means they need the server. This page explains what you see when the connection to it goes away for a moment, and what happens to the work you did meanwhile.

## A red wifi icon appears in the toolbar

**What it means:** the editor has lost its connection to the server. The icon is a crossed-out wifi symbol at the right of the toolbar, and clicking it says "Offline, will sync when back online".

**What to do:** keep working. The document stays open and you can carry on typing. Your edits are held in this browser tab. The editor keeps trying to reconnect on its own, and sends them the moment the connection is back. The icon disappears when that happens.

A short hiccup never shows the icon at all. Eigen waits a second or two before deciding you are really offline, so a blink of the network passes unnoticed.

<div class="eigen-callout">

Edits made while the icon is showing live only in this browser tab. Nothing is kept on your computer, so closing the tab before the connection returns loses them. So does an update of Eigen while you are offline: the page then reloads instead of sending them.

</div>

## You are asked "Leave without syncing?"

**What it means:** you tried to go somewhere else while some of your edits still had not reached the server. Eigen puts a dialog in the way rather than dropping the work quietly.

**What to do:** click **Stay**, wait for the wifi icon to go away, then go where you were going. If you genuinely do not need those edits, click **Leave**.

The same check covers reloading the page and closing the tab, where your browser shows its own "leave this site?" warning instead.

## The icon says "Storage unavailable"

**What it means:** the connection is fine, but the server cannot reach the place your document is stored. The crossed-out wifi icon appears again, and clicking it says "Storage is temporarily unavailable, retrying. Edits will sync when it is back".

**What to do:** the same as being offline. Keep your tab open and Eigen retries every few seconds by itself. This one is usually a problem on the server rather than on your side, so if it lasts more than a few minutes, tell whoever runs your Eigen. In a team's documents it also shows for a few seconds when an admin gives one of the team's drives new storage or turns one on or off.

## The document is slow to open

**What it means:** a document you have not opened for a while has to be loaded before you can edit it, and that can take a moment. If it takes more than 10 seconds, the spinner adds "Storage is responding slowly, still connecting…" so you know it has not given up.

**What to do:** wait. If the server cannot reach your storage at all, the message changes to "Storage is temporarily unavailable, retrying automatically" and the editor keeps trying until it can open. If the document's stored data cannot be found, it stops trying instead: see the next section.

## The stored data could not be found

**What it means:** the server reached your storage, but the document's saved data is not there. Instead of the editor, you see "The stored data for this document could not be found." Waiting will not bring it back, so Eigen stops trying.

If the document was already open, it stays on screen and shows as offline. Reload the page to get the message above.

**What to do:** restore a saved version. In a file you can edit, the versions are listed under the message: click one, then **Restore**, and the page reloads onto it. If there is no version to go back to, ask whoever runs your Eigen to restore a backup.

## A banner says Eigen restarts

**What it means:** whoever runs your Eigen is about to update it, or to take it back to an earlier version. A banner at the foot of the page says what happens and when, and counts down. Below it may be a line from them, such as when Eigen is back.

**What to do:** send or save what you're writing before the time is up. Documents save themselves, but a comment you have not sent is lost when the page reloads. When Eigen goes back to an earlier version, what you change after the warning is not in that version, so wait with new work until it is back.

While Eigen restarts, the banner says "Eigen is updating. This page reloads when it's back." Keep the tab open: it reloads by itself once Eigen is back.

## The page reloads by itself

**What it means:** Eigen was updated, or someone restored this account from a backup, while you had the page open. The page in your tab is now out of date, so Eigen reloads it rather than sending the old copy back.

**What to do:** nothing. The page comes back on the new version or the restored document. Before an update, the banner above warns you first. Anything you typed in the seconds before the reload, or while Eigen was down, is not kept.
