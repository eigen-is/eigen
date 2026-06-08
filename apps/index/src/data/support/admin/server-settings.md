---
title: "Server settings"
description: "A reference for every setting on the Settings page in Admin, covering storage quotas, default storage type, and email notifications."
type: reference
tags: [admin, settings, quotas, storage, notifications]
related: [admin/get-started, admin/storage-quotas]
order: 80
updated: 2026-06-08
---

The **Settings** page in Admin lets the server owner control storage limits, how new users' files are stored, and which events trigger email notifications. Only the server owner sees this page in the sidebar.

To open it, sign in to Eigen as the owner and go to [Admin](/admin), then click **Settings** in the sidebar.

## Storage quotas

These four limits apply by default to every user. You can also set quota overrides per team from the Teams panel in Admin; when a user belongs to multiple teams, the most permissive limit wins.

| Field | What it controls | Default |
|---|---|---|
| **Mail & Contacts (MB)** | Combined storage for all a user's email and contacts | 100 MB |
| **Default Mount (MB)** | Storage for a user's primary Drive | 500 MB |
| **Max Upload (MB)** | Largest single file a user can upload | 35 MB |
| **Trash Retention (days)** | How long deleted files stay in the Trash before being permanently removed | 30 days |

Enter a number in each field. The **Save** button appears at the bottom of the page once you have made a change.

## Defaults

### Storage type

**Storage Type** controls where new users' Drive files are written when their account is first created. Changing this setting does not move existing files; it affects only accounts created after the change.

| Option | Where files are stored |
|---|---|
| **Local (Full names)** | On the server's local disk, using each file's real name |
| **Local (ID-based)** | On the server's local disk, using internal identifiers |
| **S3 Bucket** | In an S3-compatible object storage bucket |

When you select **S3 Bucket**, an **S3 Configuration** form appears. Fill in all the fields below, then click **Test Connection** to confirm Eigen can reach the bucket before saving.

| Field | What to enter |
|---|---|
| **Endpoint** | The S3 provider's URL, for example `https://s3.amazonaws.com` |
| **Bucket** | The name of the bucket |
| **Prefix** | An optional path prefix within the bucket, for example `eigen/` |
| **Region** | The bucket's region, for example `eu-west-1` |
| **Access Key ID** | Your S3 access key ID |
| **Secret Access Key** | Your S3 secret access key |

<div class="eigen-callout">

If the connection test reports that bucket versioning is off or suspended, consider enabling it in your S3 provider. Without versioning, an overwritten file cannot be recovered.

</div>

## Email notifications

These toggles control whether Eigen sends an email for each type of event, in addition to the in-app notification that always fires.

| Toggle | What triggers the email |
|---|---|
| **Email guests when added to share** | A guest is given access to a file or folder. Guests have no in-app notifications, so this is often the only way they learn about the share. On by default. |
| **Email users when added to share** | A registered user is given access to a file or folder. An in-app notification already fires. Off by default. |
| **Email users for calendar invites** | A user receives a calendar invitation. On by default. |
| **Email owner on access request** | Someone requests access to a file the owner has locked. On by default. |

Click the toggle to change a setting. Click **Reset** to discard all unsaved changes.
