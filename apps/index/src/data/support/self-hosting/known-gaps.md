---
title: "What Eigen does not do yet"
description: "The known gaps of a pre-1.0 Eigen, from single sign-on to encrypted backups, so you know them before you install."
type: reference
category: Basics
tags: [self-hosting, limits, roadmap, sso, backup]
related: [self-hosting/get-started, self-hosting/requirements, self-hosting/update]
order: 140
updated: 2026-11-02
---

Eigen is not 1.0 yet, and it is built by one person. The core works, but some things you may expect are not there. This page lists the ones that matter before you install. No need to report these as bugs.

## Server and backups

| Missing | What there is today |
|---|---|
| A promise that your data survives every release | Before 1.0, a release can change how something is stored. See [what 1.0 means for your data](/support/self-hosting/update#what-10-means-for-your-data). |
| Encrypted backups | Backups are not encrypted, in `backups/` or in your backup bucket. Keep the bucket private and its keys for it alone. See [Back up and restore the whole server](/support/self-hosting/back-up-and-restore). |
| Changing the mail domain after the first setup | Every account is made on it, so pick it with care |

## Sign-in and mail

| Missing | What there is today |
|---|---|
| Single sign-on (OIDC or SAML, like Authentik, Keycloak, or Microsoft) | Eigen's own accounts, with two-factor sign-in and app passwords |
| The Mail app for mail hosted somewhere else | Leave your mail with your current provider (Proton Mail, Google Workspace, Microsoft 365, Fastmail…) and use your own mail app. Eigen then has no Mail app. See [Keep your existing mail](/support/self-hosting/keep-your-mail). |
