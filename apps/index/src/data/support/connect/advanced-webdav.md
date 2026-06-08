---
title: "Advanced WebDAV with rclone and Mountain Duck"
description: "Use rclone or Mountain Duck to mount your Eigen drives with better performance and reliability than the built-in WebDAV client in Finder or File Explorer."
type: how-to
category: WebDAV
tags: [webdav, drive, rclone, mountain-duck, sync, backup]
related: [connect/mount-drive-on-your-computer, connect/app-passwords]
crossSections: [drive]
order: 50
updated: 2026-06-08
---

Eigen Drive supports WebDAV, and the built-in WebDAV client in Finder or File Explorer works. On large folders,
though, Finder can be slow and caches file metadata aggressively. rclone and Mountain Duck are two well-regarded
alternatives that handle those cases better. Both use exactly the same connection details as the built-in client.

## Before you start

You need two things from the [**Integrations**](/space/services) page in Space before you configure either tool:

- **Your WebDAV URL.** Under the **WebDAV (Drive sync)** heading, each drive you have access to is listed with
  its own URL. The format is:

  ```
  https://<your-eigen-host>/webdav/<ownerId>/<mountId>/
  ```

  Copy the URL for the drive you want to connect. If you have multiple drives, you'll set up a separate
  connection for each one.

- **An app password.** Scroll down to **App passwords**. In the **Name** field, type a label such as
  `rclone` or `Mountain Duck`, then click **Generate**. Copy the password straight away. It is shown only once.

Your username for both tools is the email address shown on the same page under **WebDAV (Drive sync)**.

## Connect with rclone

[rclone](https://rclone.org) is a free, command-line tool that works on macOS, Windows, and Linux. It can mount
your drive as a local folder, sync files to and from it, or copy it to another location for backups.

To add a new remote, run:

```
rclone config
```

When prompted, choose to add a new remote and select **WebDAV** as the storage type. Set:

- **URL**: paste the WebDAV URL you copied from the Integrations page.
- **Vendor**: choose **Other**.
- **User**: your Eigen email address.
- **Password**: when rclone asks for a password, enter the app password you generated.

Once configured, you can mount the remote as a local folder:

```
rclone mount eigenDrive: /path/to/mountpoint --vfs-cache-mode full
```

Replace `eigenDrive` with the name you gave the remote, and `/path/to/mountpoint` with an empty folder on your
computer. The `--vfs-cache-mode full` flag caches files locally so that desktop apps can open and save them
normally.

On macOS, rclone requires [FUSE-T](https://www.fuse-t.org) (free) to create the mount point. On Windows, it
requires [WinFsp](https://winfsp.dev) (also free).

<div class="eigen-callout">

Eigen document files (such as `.eigendoc` or `.eigensheets`) appear as folders in the mount. You can read and
copy them, but you cannot edit their contents from the mount. To work on a document, open it in the browser.

</div>

## Connect with Mountain Duck

[Mountain Duck](https://mountainduck.io) is a commercial app for macOS and Windows that mounts WebDAV drives in
Finder and File Explorer using the operating system's native file provider. It handles reconnects automatically
and avoids the metadata caching issues that affect the built-in Finder WebDAV client.

To add a new connection, open Mountain Duck and create a new WebDAV (HTTPS) bookmark. Enter:

- The server hostname from your WebDAV URL (the part after `https://` and before the first `/`).
- The path (everything after the hostname, starting with `/webdav/`).
- Your Eigen email address as the username.
- The app password you generated as the password.

Save the bookmark and connect. The drive appears in Finder or File Explorer.

## Use rclone for backups

rclone is particularly useful for backing up your Eigen drives to another location. To copy everything from a
drive to a local folder:

```
rclone copy eigenDrive: /path/to/local/backup
```

To keep a local folder in sync with the remote (adding new files and removing deleted ones):

```
rclone sync eigenDrive: /path/to/local/backup
```

Both commands copy Eigen document files as folders, preserving their full contents.
