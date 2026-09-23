---
title: "Set up your Eigen server"
description: "Run the first-time setup wizard to configure your organization, storage, and admin account before anyone can sign in."
type: overview
category: Basics
tags: [admin, setup, getting-started, configuration]
related: [admin/manage-members, admin/server-settings]
order: 10
updated: 2026-09-24
---

The setup wizard creates your admin account and gets the server ready for everyone else. It opens from the setup link that `./eigen setup` prints when it finishes. This page walks you through what to expect.

## The setup wizard

Open the setup link in a browser. It looks like `https://eigen.example.com/admin/#setup=…`, and you will see the **Welcome to Eigen** screen. Fill in the form below to get started.

The link works once, so nobody who finds your server before you can claim it. Opening `/admin` without it shows **Open the setup link that ./eigen setup printed.** instead of the form. Lost the link? Run `./eigen setup` again on your server, and it prints a fresh one.

### Server configuration

**Organization Name** is the display name for your organization. It appears in the interface and
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

**Username** is the first part of your admin address. The suffix next to it (for example `@example.com`) is the mail domain you picked in `./eigen setup`. You sign in with this address. Role and system names, like `admin`, `root`, `support` and `postmaster`, are reserved, so use your own name, like `jane`.

**Password** must be at least eight characters.

### Completing setup

Click **Complete Setup**. Eigen creates the organization and the admin account, then shows a
**Setup Complete!** confirmation. Click **Go to Login** to reach the sign-in page.

## What you can do after signing in

Once you are signed in with your admin account, Eigen opens the admin panel at [/admin](/admin).
The sidebar gives you access to the main areas:

- **Users**: view and manage all user accounts, add new users, and change roles.
- **Teams**: create groups of members to share content with whole teams at once.
- **Guests**: see external guest accounts that have been granted access to specific files.
- A user's or team's detail pane includes a **Backup** section. See [Back up a user or team](/support/admin/back-up-home).

As the server owner, you also see:

- **Settings**: configure storage quotas, default storage type for new users, and email
  notifications.
- **Onboarding**: control the waitlist, the invite email, and the welcome email sent to new users.
- **Guest access**: control whether guests can sign in without a prior share, and how long inactive guest accounts are kept.
- **Waitlist**: if the waitlist is enabled, review and accept or reject applications here.

See [Add and manage members](/support/admin/manage-members) to invite your first users, and
[Server settings](/support/admin/server-settings) to adjust quotas and defaults.
