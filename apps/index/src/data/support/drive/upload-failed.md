---
title: "Why a file will not upload"
description: "What to do when an upload fails in Drive because a file is too large or your storage quota is full."
type: troubleshooting
tags: [drive, upload, storage, quota]
related: [drive/upload-files]
order: 200
updated: 2026-06-08
---

When a Drive upload fails, a card appears at the bottom-right of the screen showing **Upload failed**. Two
common causes are a file that exceeds the maximum size limit, and a drive that has reached its storage quota.

## The file is too large

Each Eigen installation has a maximum size for a single uploaded file. If your file is over that limit, the
upload fails as soon as Drive tries to receive it.

**What to do:** Check the size of the file you are trying to upload. If it is very large, you may need to
compress it, split it into smaller parts, or find another way to transfer it. The exact limit depends on how
your Eigen server is configured. If you are not sure what the limit is, ask your administrator.

## Your storage is full

Each drive has a storage quota. If the drive is already at or near its limit, an upload fails even if the
file itself is small enough. Drive checks the remaining space before it starts receiving the file, so the
upload fails straight away rather than part-way through.

**How to check your storage:** The storage bar at the bottom of the sidebar shows how much space you have
used and how much is available. In Drive or any other Eigen app, look for the **Storage** progress bar at
the very bottom of the left sidebar.

**What to do:** Free up space by permanently deleting files you no longer need. See [Delete files and use the Trash](/support/drive/use-the-trash).

If you have freed up space and still cannot upload, your quota has been reached. Contact your
administrator to ask for more storage.

## Folder upload is not supported

Drive accepts individual files but not whole folders. If you drag a folder onto Drive, nothing is uploaded.
To recreate a folder structure, create the folders first and then upload files into each one.
