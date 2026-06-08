---
title: "Set storage quotas and the default storage type"
description: "Configure server-wide storage limits and the storage backend for new users, and override those limits for specific teams."
type: how-to
tags: [admin, quotas, storage, settings]
related: [admin/server-settings, admin/teams]
order: 60
updated: 2026-06-08
---

Storage quotas control how much space each user and team can use. You set server-wide defaults on the [**Settings**](/admin/settings) page, and you can raise those defaults for specific teams without changing the server-wide values. Only the server owner can access the **Settings** page.

## Set server-wide quotas

1. Sign in to Eigen as the server owner and open [Admin](/admin).
2. In the sidebar, click **Settings**.
3. Under **Storage Quotas**, update the fields you want to change:
   - **Mail & Contacts (MB)**: the combined storage limit for each user's email and contacts.
   - **Default Mount (MB)**: the storage limit for each user's primary Drive.
   - **Max Upload (MB)**: the largest single file any user can upload.
   - **Trash Retention (days)**: how long deleted files stay in the Trash before they are permanently removed.
4. Click **Save**.

The **Save** and **Reset** buttons appear only when you have unsaved changes. Click **Reset** to discard changes you have not yet saved.

<div class="eigen-callout">

These limits apply to all users by default. A user in a team with a higher override gets the higher limit. A user in multiple teams with different overrides gets the highest limit across all their teams.

</div>

## Set the default storage type for new users

The **Storage Type** setting under **Defaults** on the same **Settings** page controls where new users' Drive files are written the first time they sign in. Changing this setting has no effect on existing users' files.

1. In [Admin Settings](/admin/settings), scroll to **Defaults**.
2. Open the **Storage Type** dropdown and choose one of the following:
   - **Local (ID-based)**: files are stored on disk using internal identifiers rather than names.
   - **Local (Full names)**: files are stored on the server's local disk using their original filenames.
   - **S3 Bucket**: files are stored in an S3-compatible object storage bucket.
3. If you select **S3 Bucket**, fill in the **S3 Configuration** fields (endpoint, bucket, prefix, region, access key ID, and secret access key) and click **Test Connection** to verify the credentials before saving.
4. Click **Save**.

## Override quotas for a team

You can raise the mail and Drive limits above the server default for everyone in a specific team. This lets you give certain groups more space without changing the server-wide defaults for everyone else.

1. Open [Admin](/admin) and click the team's name in the sidebar.
2. Click **Edit** at the top of the detail panel.
3. Scroll to **Quota Overrides**.
4. Enter a value in **Mail & Contacts (MB)** or **Default Mount (MB)** (or both). Leave a field empty to keep the server default for that quota type.
5. Click **Save Settings**.

The override applies to all current and future members of that team. If you later remove the override by clearing the field and saving, those members return to the server-wide defaults.
