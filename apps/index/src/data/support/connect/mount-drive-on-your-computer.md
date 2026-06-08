---
title: "Mount Drive on your computer"
description: "Access your Eigen Drive files directly in Finder, File Explorer, or any WebDAV client by connecting it as a network drive."
type: how-to
category: WebDAV
tags: [webdav, drive, finder, windows, mount]
crossSections: [drive]
related: [drive/get-started, drive/share-a-file]
updated: 2026-06-08
---

Eigen Drive supports WebDAV (RFC 4918), so you can connect any of your drives as a network volume on macOS or Windows. Files appear in Finder or File Explorer like a local folder, so you can open, edit, and save them without going through the browser.

## Before you start

You need an **app password** to connect. App passwords are separate credentials you create specifically for external clients. They work even when two-factor authentication is enabled, and you can revoke them at any time without changing your main password.

To create one, open the [**Integrations** page](/space/services) in Space, scroll to **App passwords**, enter a name (e.g. "Finder" or "My laptop"), and click **Generate**. Copy the password now. It's only shown once.

The same page lists the WebDAV URL for each of your drives. The URL format is:

```
https://<your-eigen-host>/webdav/<ownerId>/<mountId>/
```

## Connect on macOS (Finder)

1. In Finder, open **Go → Connect to Server** (⌘K).
2. Paste the WebDAV URL for your drive and click **Connect**.
3. Choose **Registered User**, enter your Eigen email address as the username, and the app password you generated as the password.
4. Click **Connect**. The drive appears under **Locations** in the Finder sidebar.

<div class="eigen-callout">

Finder's built-in WebDAV support works but can be slow on large folders and caches metadata aggressively. For better performance, consider [Mountain Duck](https://mountainduck.io) (commercial) or [rclone](https://rclone.org) (free, command-line).

</div>

## Connect on Windows (File Explorer)

Windows connects WebDAV drives through the **WebClient** service.

1. Make sure the **WebClient** service is running. Open Services (`services.msc`), find **WebClient**, and set its startup type to **Automatic** if it is not already running.
2. Open **This PC**, click **Map network drive** in the toolbar (or from the Computer menu).
3. Click **Connect to a Web site that you can use to store your documents and pictures**, then follow the wizard.
4. Enter the WebDAV URL for your drive, then your Eigen email and app password when prompted.

Windows requires HTTPS for HTTP Basic authentication. Plain HTTP connections are rejected. There is also a 50 MB default upload size limit; large files may fail unless the registry setting `FileSizeLimitInBytes` under `HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Services\WebClient\Parameters` is increased.

## What you can do over WebDAV

- **Open and save files**: most desktop apps (Word, Excel, TextEdit, and so on) can open files directly from the connected drive.
- **Copy and move files** within the same drive.
- **Create and delete folders**.
- **Read Eigen documents as folders**: documents, spreadsheets, and other Eigen file types appear as folders rather than single files. You can open and copy them (handy for backups), but you can't change what's inside them from a WebDAV client.

Cross-drive moves and copies aren't supported over WebDAV. To move files between drives, download them and upload them again.

## Sign in and authentication

Use your Eigen **email address** as the username, and the **app password** you generated as the password, not your main account password. If you have two-factor authentication switched on, you must use an app password; your main password won't work.

## Troubleshooting

**Drive does not appear after connecting on macOS**: check that the URL ends with a `/`. Finder sometimes drops the trailing slash.

**"The folder you specified does not appear to be valid" on Windows**: confirm the WebClient service is running and that the URL uses `https://`, not `http://`.

**401 Unauthorized**: double-check the app password was copied correctly. Passwords are only shown once; if you missed it, delete it from the Integrations page and generate a new one.

**Files or folders are missing**: Eigen documents (`.eigendoc`, `.eigensheets`, and so on) show up as folders in WebDAV listings, not as individual files. If a file is in the trash it will not appear in WebDAV listings.
