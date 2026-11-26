---
title: "Share with a public link"
description: "Let anyone who has the link view a file, a folder or a document, with no account and no sign-in."
type: how-to
category: Sharing
tags: [drive, sharing, permissions, public-link]
related: [drive/share-a-file, getting-started/how-sharing-works, admin/guests]
order: 25
updated: 2026-11-26
---

A public link lets anyone who has it view a file, a folder or a document, without an account and without signing in. Use it for a link on a website, in a newsletter or in a group chat, where you can't name the readers.

## Turn on a public link

1. Open the **Share** dialog for the file, folder or document, as in [Share a file or folder](/support/drive/share-a-file).
2. Under **General access**, open the dropdown and choose **Anyone with the link**. The line under it reads "Anyone on the internet with the link can view".
3. Click **Save**.
4. Click **Copy link** next to **People with access**, and send the link to whoever you like.

You can do this on a file, a folder or a document in Docs, Sheets, Slides, Vector or Stickies. A chat room can't have a public link.

## The link is the item's address

The link is the same address you see in the browser when you open the item. It doesn't change, and there is no separate secret link. Anyone who has ever seen the address can open the item for as long as it is public. Search engines are asked not to list it.

## Everything inside a public folder is public

A public folder opens everything inside it, its subfolders included, even a subfolder whose own access is **Restricted**. A file inside the folder still shows **Restricted** in its own **Share** dialog, because the link sits on the folder above it.

Moving an item out of a public folder closes the link for it, unless the item has a public link of its own.

## What someone with the link sees

Someone who opens the link without signing in can:

- Look at a file in its preview and download it.
- Browse a public folder and open what is in it.
- Read a document as it is now, with edits from others showing up live. In Docs they can also print it.
- See the comments on a document, with who wrote each one.

They can't edit or comment, download a document in another format, or see the replies under a comment, the people with access, the version history or who else is viewing. The top bar has a **Log in** button that brings them back to the same item after they sign in.

Someone who is signed in to your Eigen server opens the link as a viewer, as with **Anyone signed in with the link**.

## Turn a public link off

Open the **Share** dialog, choose **Restricted** or **Anyone signed in with the link** under **General access**, and click **Save**. From then on the link opens nothing for someone who isn't signed in, and a visitor who has the document open loses it within 15 seconds.

Moving the item to the trash also closes the link. Restoring it, or choosing **Anyone with the link** again later, opens the same address once more.

## When your server doesn't allow public links

The owner of your Eigen server can turn public links off for everyone, with **Allow public links** on the [**Guest access**](/admin/guest-settings) page in Admin ([Enable and configure guest access](/support/admin/guests)). Public links are on unless the owner turns them off, and they are always off on a demo server.

While they are off, **Anyone with the link** isn't offered. An item that already had a public link keeps the setting, but its **Share** dialog says "Public links are turned off on this server, so this link opens nothing." Nobody who isn't on the item's list of people can open it, signed in or not. Turning public links on again opens those links again.
