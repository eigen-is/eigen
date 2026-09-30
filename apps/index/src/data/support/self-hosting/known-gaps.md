---
title: "What Eigen does not do yet"
description: "The known gaps of a pre-1.0 Eigen, from single sign-on to encrypted backups, so you know them before you install."
type: reference
category: Basics
tags: [self-hosting, limits, roadmap, sso, backup]
related: [self-hosting/get-started, self-hosting/update]
order: 140
updated: 2026-09-30
---

Eigen is not 1.0 yet, and it is built by one person. The core works, but some things you may expect are not there. This page lists the ones people ask about, so you can decide before you install. No need to report these as bugs.

## Server and install

| Missing | What there is today |
|---|---|
| A promise that your data survives every release | Before 1.0, a release can change how something is stored. See [what 1.0 means for your data](/support/self-hosting/update#what-10-means-for-your-data). |
| Encrypted backups | Backups are not encrypted, in `backups/` or in your backup bucket. Keep the bucket private and its keys for it alone. See [Back up and restore the whole server](/support/self-hosting/back-up-and-restore). |
| A ready-made setup for Synology and other NAS systems | None. Eigen has not been tested on a NAS. |
| Kubernetes, Helm, or an installer with windows and buttons | Docker Compose, through `./eigen` |
| 32-bit processors | amd64 and arm64 only |
| Changing the mail domain after the first setup | Every account is made on it, so pick it with care |
| Restoring one user's or team's backup on another server | A backup of one user or team restores on the server it came from. To move a whole server, see [Move Eigen to another server](/support/self-hosting/move-to-another-server). |

## Sign-in and mail

| Missing | What there is today |
|---|---|
| Single sign-on (OIDC or SAML, like Authentik, Keycloak, or Microsoft) | Eigen's own accounts, with two-factor sign-in and app passwords |
| The Mail app for mail hosted somewhere else | Keep your mail where it is and use your own mail app. Eigen then has no Mail app. See [Keep your existing mail](/support/self-hosting/keep-your-mail). |
| Answers to calendar invitations from outside, without hosted mail | The answer lands in the organizer's own mailbox, and the guest's status on the event stays as it was |
| Mail filters, out-of-office replies, and sending later | Not yet |

## In the apps

| Missing | What there is today |
|---|---|
| Subscribing to a calendar feed by its address | [Importing events](/support/calendar/import-events) from a file |
| Charts and pivot tables in Sheets | Not yet |
| Speaker notes and themes in Slides | Not yet |
