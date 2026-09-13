---
title: "Editing when your connection drops"
description: "What the red wifi icon means, where your edits go while you are offline, and why Eigen warns you before you leave the page."
type: troubleshooting
category: Basics
tags: [offline, sync, editing, troubleshooting, getting-started]
related: [getting-started/your-first-steps, drive/file-versions]
order: 7
updated: 2026-09-13
---

Documents, spreadsheets, presentations, drawings, and boards save themselves as you type, which means they need
the server. This page explains what you see when the connection to it goes away for a moment, and what happens
to the work you did meanwhile.

## A red wifi icon appears in the toolbar

**What it means:** the editor has lost its connection to the server. The icon is a crossed-out wifi symbol at
the right of the toolbar, and clicking it says "Offline, will sync when back online".

**What to do:** keep working. The document stays open and you can carry on typing. Your edits are held in this
browser tab and are sent the moment the connection is back, which the editor keeps trying to do on its own. The
icon disappears when that happens.

A short hiccup never shows the icon at all. Eigen waits a second or two before deciding you are really offline,
so a blink of the network passes unnoticed.

<div class="eigen-callout">

Edits made while the icon is showing live only in this browser tab. Nothing is kept on your computer, so
closing the tab before the connection returns loses them.

</div>

## You are asked "Leave without syncing?"

**What it means:** you tried to go somewhere else while some of your edits still had not reached the server.
Eigen puts a dialog in the way rather than dropping the work quietly.

**What to do:** click **Stay**, wait for the wifi icon to go away, then go where you were going. If you
genuinely do not need those edits, click **Leave**.

The same check covers reloading the page and closing the tab, where your browser shows its own "leave this
site?" warning instead.

## The icon says "Storage unavailable"

**What it means:** the connection is fine, but the server cannot reach the place your document is stored. The
crossed-out wifi icon appears again, and clicking it says "Storage is temporarily unavailable, retrying. Edits
will sync when it is back".

**What to do:** the same as being offline. Keep your tab open and Eigen retries every few seconds by itself.
This one is usually a problem on the server rather than on your side, so if it lasts more than a few minutes,
tell whoever runs your Eigen.

## The document is slow to open

**What it means:** a document you have not opened for a while has to be loaded before you can edit it, and that
can take a moment. If it takes more than 10 seconds, the spinner adds "Storage is responding slowly, still
connecting…" so you know it has not given up.

**What to do:** wait. If the server cannot reach your storage at all, the message changes to "Storage is
temporarily unavailable, retrying automatically" and the editor keeps trying until it can open.

## The page reloads by itself

**What it means:** someone restored this account from a backup while you had the document open. The copy in your
tab belongs to the version that has been replaced, so Eigen reloads the page onto the restored one rather than
syncing the old copy back over it.

**What to do:** nothing. The page comes back on the restored document. Anything you typed in the seconds before
the reload belongs to the replaced copy and is not kept.
