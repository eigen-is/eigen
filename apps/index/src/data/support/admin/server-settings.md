---
title: "Server settings"
description: "A reference for the Settings page in Admin, covering your organization name, the server status, the sender of Eigen's mail, storage quotas, default storage type, backups of the whole server, email notifications, and the landing page buttons."
type: reference
tags: [admin, settings, quotas, storage, notifications, mail, backup]
related: [admin/get-started, admin/storage-quotas, self-hosting/back-up-and-restore]
order: 80
updated: 2026-10-01
---

The **Settings** page in Admin is where the server owner sets up the organization, mail, storage, backups, and notifications. Only the owner sees it in the sidebar.

To open it, sign in to Eigen as the owner and go to [Admin](/admin), then click **Settings** in the sidebar.

## General

**Organization name** is the name people see in Eigen and in the mail it sends. You can change it here.

**Web address** and **Mail domain** are shown but can't be changed. They were set when the server was first set up, and every account's address is on the mail domain.

## Server

This section shows how the server is doing. You can't change anything here.

| Row | What it shows |
|---|---|
| **Version** | The version of Eigen the server runs |
| **Mail** | Whether this server hosts mailboxes, sends its mail through your relay (named here), or has no relay and sends no email |
| **Disk** | How much disk space is free |
| **Certificate** | When the server's HTTPS certificate expires. **Managed by the bundled Caddy** means the web server that comes with Eigen holds it. A self-signed certificate is the one the mail server makes for itself when there is no other. Behind your own web server, it shows that mail certificate when this server hosts mail, and none otherwise. |

## Mail

The sender of the notifications, codes and invitations Eigen sends.

| Field | What it controls | Default |
|---|---|---|
| **Sender name** | The name these emails come from | Your organization name |
| **Sender address** | The address these emails come from. Your mail relay must allow it. | `noreply@` your mail domain |

Leave a field empty to use the default. A default name follows the organization name when you rename it.

On a server without mailboxes that sends through a relay, a **Relay sends as users** switch appears. Turn it on if your mail relay allows sending from any address on your mail domain. Mail someone causes, like a share notification, then comes from their own address. Off, it comes from the sender address with their name, for example "Ada via Acme", and replies go to them.

**Send test mail** sends one email from you to you, the same way a share notification goes out. If it fails, Eigen shows the relay's answer. Save your changes first: the test uses the saved sender. A server with no mailboxes and no relay sends no email, so the section says mail is off instead.

## Storage quotas

These four limits apply by default to every user. A changed **Default Mount (MB)** reaches drives created after the change: a user's existing drive keeps the limit it was created with. You can also set quota overrides per team from the Teams panel in Admin; when a user belongs to multiple teams, the most permissive limit wins.

| Field | What it controls | Default |
|---|---|---|
| **Mail, Contacts & Calendar (MB)** | Combined storage for all a user's email, contacts, and calendars. On a server without mailboxes it reads **Contacts & Calendar (MB)**. | 100 MB |
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

If the connection test reports that bucket versioning is off or suspended, click **Enable safe defaults** under **Bucket safety**. Without versioning, an overwritten file cannot be recovered.

</div>

## Backups

A backup of the whole server: every user and team, and the server's own databases and settings. Backups are not encrypted. For how to use them, see [Back up and restore the whole server](/support/self-hosting/back-up-and-restore).

| Field | What it controls | Default |
|---|---|---|
| **Back up every night** | A Full backup once a day, at the time below. Turned on after that time, the first one starts within a few minutes. | Off |
| **Time** | When the nightly backup starts. The list shows your own time with UTC beside it. | 02:00 UTC |
| **Nightly backups to keep** | How many good nightly backups stay on the server, up to 365. A night that failed never pushes out the last good one. | 7 |
| **Include files in S3 buckets** | Only there when nightly backups are on and a user or team keeps a drive in an S3 bucket. On, the nightly backup copies every file of those drives. Off, it holds their file list and the bucket keeps the files. | Off |
| **Upload to a backup bucket** | Sends each backup that verified to a private S3 bucket that holds nothing else of Eigen. Backups made before an update stay on this server. | Off |
| **Backups to keep in the bucket** | How many nightly backups the bucket keeps, up to 365. It always keeps the newest one that holds every user and team, and backups made by hand stay. | 30 |

With **Upload to a backup bucket** on, the same S3 fields appear as for the storage type, with **Test Connection**. The test refuses a bucket or an access key that Eigen keeps files with, and a bucket anyone can read. It warns when no rule cleans up uploads that were cut off halfway. The **Secret Access Key** is never shown again: leave it empty to keep the saved one. Once you save a new bucket, a notice asks you to write its details down somewhere other than this server, with any warning from the test.

Below the settings, **Back up now** makes a backup at the level you pick: **Full**, **Light**, or **Full + S3** when a drive is in an S3 bucket. The section shows its progress while it runs. Each backup in the list shows:

- Its date, level, and why it was made: **Scheduled**, **Manual**, or **Before an update**.
- Its size, and whether it verified and reached the bucket.
- Under **Not in this backup**, any user or team that failed.

Hover over a row for **Upload to the bucket**, which sends a good backup again even if the bucket has it, and **Delete**.

There is no download: a backup leaves the server by the bucket, or by a copy you make on the server, like `scp`.

## Email notifications

These toggles control whether Eigen sends an email for each type of event. A user with an account gets the in-app notification either way.

| Toggle | What triggers the email |
|---|---|
| **Email guests when added to share** | A guest is given access to a file or folder. Guests have no in-app notifications, so this is often the only way they learn about the share. On by default. |
| **Email users when added to share** | A registered user is given access to a file or folder. An in-app notification already fires. Off by default. |
| **Email users for calendar invites** | A user receives a calendar invitation. On by default. |
| **Email owner on access request** | Someone requests access to a file the owner has locked. On by default. |

Click the toggle to change a setting. Click **Reset** to discard all unsaved changes.

## Landing page

Extra buttons on the public landing page, each with a title and a web address. Click **Add button** for a new one, and **Remove** (the trash icon) to take one away. See [Add your own buttons to the landing page](/support/admin/landing-page-buttons).
