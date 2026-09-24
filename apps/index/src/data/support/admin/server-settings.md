---
title: "Server settings"
description: "A reference for the Settings page in Admin, covering your organization name, the server status, the sender of Eigen's mail, storage quotas, default storage type, and email notifications."
type: reference
tags: [admin, settings, quotas, storage, notifications, mail]
related: [admin/get-started, admin/storage-quotas]
order: 80
updated: 2026-09-24
---

The **Settings** page in Admin lets the server owner rename the organization, check on the server, set the sender of Eigen's own mail, and control storage limits, how new users' files are stored, and which events trigger email notifications. Only the server owner sees this page in the sidebar.

To open it, sign in to Eigen as the owner and go to [Admin](/admin), then click **Settings** in the sidebar.

## General

**Organization name** is the name people see in Eigen and in the mail it sends. You can change it here.

**Web address** and **Mail domain** are shown but can't be changed. They were set when the server was first set up, and every account's address is on the mail domain.

## Server

This section shows how the server is doing. You can't change anything here.

| Row | What it shows |
|---|---|
| **Version** | The version of Eigen the server runs |
| **Mail** | Whether this server hosts mailboxes, or sends its mail through your relay |
| **Disk** | How much disk space is free |
| **Certificate** | When the server's HTTPS certificate expires. A server behind your own web server has none here. |

## Mail

The sender of the notifications, codes and invitations Eigen sends.

| Field | What it controls | Default |
|---|---|---|
| **Sender name** | The name these emails come from | Your organization name |
| **Sender address** | The address these emails come from. Your mail relay must allow it. | `noreply@` your mail domain |

Leave a field empty to use the default. A default name follows the organization name when you rename it.

On a server without mailboxes, a **Relay sends as users** switch appears. Turn it on if your mail relay allows sending from any address on your mail domain. Mail someone causes, like a share notification, then comes from their own address. Off, it comes from the sender address with their name, for example "Ada via Acme", and replies go to them.

**Send test mail** sends one email from you to you, the same way a share notification goes out. If it fails, Eigen shows the relay's answer. Save your changes first: the test uses the saved sender.

## Storage quotas

These four limits apply by default to every user. You can also set quota overrides per team from the Teams panel in Admin; when a user belongs to multiple teams, the most permissive limit wins.

| Field | What it controls | Default |
|---|---|---|
| **Mail, Contacts & Calendar (MB)** | Combined storage for all a user's email, contacts, and calendars | 100 MB |
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

## Email notifications

These toggles control whether Eigen sends an email for each type of event, in addition to the in-app notification that always fires.

| Toggle | What triggers the email |
|---|---|
| **Email guests when added to share** | A guest is given access to a file or folder. Guests have no in-app notifications, so this is often the only way they learn about the share. On by default. |
| **Email users when added to share** | A registered user is given access to a file or folder. An in-app notification already fires. Off by default. |
| **Email users for calendar invites** | A user receives a calendar invitation. On by default. |
| **Email owner on access request** | Someone requests access to a file the owner has locked. On by default. |

Click the toggle to change a setting. Click **Reset** to discard all unsaved changes.
