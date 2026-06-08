---
title: "Set up your Eigen server"
description: "Run the first-time setup wizard to configure your domain, storage, and admin account before anyone can sign in."
type: overview
category: Basics
tags: [admin, setup, getting-started, configuration]
related: [admin/manage-members, admin/server-settings]
order: 10
updated: 2026-06-08
---

When you open Eigen for the first time, the setup wizard runs automatically. It collects a few
essential details, creates your admin account, and marks the server as ready. This page walks you
through what to expect.

## The setup wizard

Open your Eigen instance in a browser. If setup has not been completed yet, you will see the
**Welcome to Eigen** screen instead of the login page. Fill in the form below to get started.

### Server configuration

**Domain** is the address where Eigen will be reachable, for example `eigen.example.com`. If your
server has a `DOMAIN` environment variable set to a real hostname, the field is pre-filled and
read-only.

**Organization Name** is the display name for your organisation. It appears in the interface and
in emails sent to members.

**Storage Type** controls where Eigen stores user files. Three options are available:

- **Local (Full names)**: files are stored on the server's local disk using their original names. A
  good default for most self-hosted setups.
- **Local (ID-based)**: files are stored on disk using internal identifiers rather than names.
- **S3 Bucket**: files are stored in an S3-compatible object storage bucket. If you choose this
  option, extra fields appear for the **Endpoint**, **Bucket**, **Prefix**, **Region**,
  **Access Key ID**, and **Secret Access Key**. Eigen verifies the connection before letting you
  proceed.

### Admin account

**Full Name** is the display name for your admin user account.

**Username** is the local part of the admin email address. The field shows a suffix (for example
`@example.com`) drawn from the domain you entered above.

**Password** must be at least eight characters.

### Completing setup

Click **Complete Setup**. Eigen creates the organisation and the admin account, then shows a
**Setup Complete!** confirmation. Click **Go to Login** to reach the sign-in page.

<div class="eigen-callout">

If Eigen has already been configured, the wizard shows an **Already Configured** message. Click
**Go to Login** to proceed to the sign-in page.

</div>

## What you can do after signing in

Once you are signed in with your admin account, Eigen opens the admin panel at [/admin](/admin).
The sidebar gives you access to the main areas:

- **Members**: view and manage all user accounts, add new users, and change roles.
- **Teams**: create groups of members to share content with whole teams at once.
- **Guests**: see external guest accounts that have been granted access to specific files.
- **Orphans**: review user records that are no longer linked to an active account.

As the server owner, you also see:

- **Settings**: configure storage quotas, default storage type for new users, and email
  notifications.
- **Onboarding**: control the waitlist, the invite email, and the welcome email sent to new users.
- **Guest access**: control whether guests can sign in without a prior share, and how long inactive guest accounts are kept.
- **Waitlist**: if the waitlist is enabled, review and accept or reject applications here.

See [Add and manage members](/support/admin/manage-members) to invite your first users, and
[Server settings](/support/admin/server-settings) to adjust quotas and defaults.
