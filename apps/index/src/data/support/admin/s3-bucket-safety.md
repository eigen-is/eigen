---
title: "Make an S3 bucket safe for Eigen"
description: "Use the Bucket safety panel to turn on versioning and an old-version cleanup rule for the S3 bucket that holds your files."
type: how-to
tags: [admin, storage, s3, settings, backup]
related: [admin/storage-quotas, admin/server-settings]
order: 70
updated: 2026-09-13
---

When Eigen stores files in an S3 bucket, it writes the whole file again on every save. If the bucket has no versioning, the previous copy is replaced and nothing can bring it back. The **Bucket safety** panel tells you where the bucket stands and can set it right for you.

Only the server owner can reach these settings.

## Open the panel

1. Sign in as the owner and go to [Admin](/admin), then click **Settings** in the sidebar.
2. Under **Defaults**, set **Storage Type** to **S3 Bucket**. The **S3 Configuration** form appears.
3. Fill in **Endpoint**, **Bucket**, **Region**, **Access Key ID**, and **Secret Access Key**. Fill in **Prefix** as well if your files live under a path inside the bucket.
4. Click **Test Connection**.
5. When the test reports that the connection worked, the **Bucket safety** panel appears below the form.

The same **S3 Configuration** form, with the same panel, appears whenever you point a team's storage at an S3 bucket in Admin.

## What the panel tells you

The panel shows two lines, each with a tick or a warning sign.

**Versioning** is the one that protects your files:

| The line says | What it means |
|---|---|
| Versioning: on | Old copies are kept, so an overwrite or a delete can be undone. |
| Versioning: off. Overwrites are permanent. | The moment a file is saved over or deleted, the old copy is gone. |
| Versioning: suspended. New overwrites are permanent. | Versions from before are still there, but nothing new is kept. |
| Versioning: cannot be read with this access key. | The key does not have permission to read the bucket's settings. |

**Old-version cleanup** is about cost. Eigen re-uploads the whole file on every save, so a document someone works on all day leaves a lot of old versions behind. A cleanup rule removes them after a set number of days:

| The line says | What it means |
|---|---|
| Old-version cleanup: expires versions after 30 days | A rule is in place, and this is how long old versions are kept. |
| Old-version cleanup: no rule. Old versions grow forever. | Nothing removes old versions, and you keep paying for all of them. |
| Old-version cleanup: another lifecycle rule is in place. | The bucket has a rule that Eigen did not write, and Eigen never overwrites one of those. |
| Old-version cleanup: cannot be read with this access key. | The key does not have permission to read the bucket's settings. |

## Turn on safe defaults

1. Click **Enable safe defaults** at the top of the panel.
2. The **Make this bucket safe for Eigen** window opens. Under **Expire old versions after**, set how many days old versions are kept. It starts at 30, and you can set anything from 1 day to 3650 days.
3. Click **Enable**.

Eigen turns on versioning and adds one cleanup rule, then reads the bucket back and writes what it changed under the two lines. Versioning applies to the whole bucket. The cleanup rule covers only the path in **Prefix**, if you set one, so it leaves anything else in the bucket alone.

More days means a longer window to recover from, and more storage to pay for. Thirty days is a reasonable starting point for most servers.

<div class="eigen-callout">

**Enable safe defaults** only appears when Eigen can actually change something. If the access key cannot read the bucket's settings, or the bucket already has a lifecycle rule from somewhere else, there is no button and the panel gives you the commands instead.

</div>

## Change how long versions are kept

Once both lines have a tick, the button is gone. Click **Change** at the end of the **Old-version cleanup** line, set a new number of days in the window that opens, and click **Update**.

## Set the bucket up by hand

Some access keys are allowed to read and write files but not to change bucket settings. In that case, and when the bucket already has a lifecycle rule of its own, the panel shows the same settings as `aws` commands. Click **Copy commands** and run them against the bucket yourself, from a machine where the AWS command-line tool is set up for that provider.

The panel fills the commands in with your endpoint, bucket, prefix, and the number of days you picked. Keep the rule's ID as it is. Eigen recognises its own rule by that ID, so a rule under a different name reads as somebody else's and is left alone.

<div class="eigen-callout">

The lifecycle command replaces the bucket's whole lifecycle configuration. If the bucket already has rules you want to keep, add them to the command before you run it.

</div>

## Check it later

Come back to **Settings**, click **Test Connection** again, and read the two lines. They are read from the bucket each time, so they always show what the bucket says right now, not what you set last month.
