---
title: "Set up two-factor authentication"
description: "Protect your Eigen account by requiring a code from your authenticator app alongside your password when you sign in."
type: how-to
tags: [account, security, two-factor, authenticator, backup codes]
related: [account/change-password]
order: 30
updated: 2026-06-08
---

Two-factor authentication (2FA) adds a second check at sign-in. After you enter your password, Eigen asks for a
six-digit code from an authenticator app on your phone. If someone gets hold of your password, they still cannot
sign in without that code.

## Before you start

You need an authenticator app on your phone or tablet. Any TOTP-compatible app works, including Google
Authenticator, Authy, and Microsoft Authenticator.

## Turn on two-factor authentication

1. Open [**Two-Factor Authentication**](/space/security/2fa) in Space.
2. In the **Current Password** field, enter your Eigen password and click **Enable Two-Factor Authentication**.
3. A QR code appears. Open your authenticator app, choose to add a new account, and scan the code.
4. If you cannot scan the QR code, click the copy button next to the setup key and paste it into your app
   manually.
5. Click **Continue**.
6. Your app shows a six-digit code. Enter it in the **Verification Code** field and click **Verify and Enable**.

If the code is correct, two-factor authentication is now on and Eigen shows your recovery codes.

## Save your recovery codes

Recovery codes let you sign in if you ever lose access to your authenticator app. Eigen shows them once,
immediately after setup.

- Click **Copy all codes** to copy them to your clipboard, then paste them somewhere safe, such as a password
  manager.
- Once you have saved them, click **I've saved my recovery codes** to finish.

<div class="eigen-callout">

Recovery codes can each be used only once. If you use one to sign in, treat it as spent. If you run out or
think your codes have been compromised, turn 2FA off and set it up again to get a fresh set.

</div>

## Sign in with two-factor authentication

When you sign in to Eigen and 2FA is on, you are taken to a second screen after entering your password. Enter the
six-digit code shown in your authenticator app and click **Verify**.

You can tick **Trust this device** to skip the code check on that device for 30 days.

## Use a recovery code to sign in

If you do not have your authenticator app to hand, click **Use a backup code instead** on the sign-in screen.
Enter one of your saved recovery codes in the **Backup Code** field and click **Verify with backup code**.

## Turn off two-factor authentication

1. Open [**Two-Factor Authentication**](/space/security/2fa) in Space.
2. Click **Disable Two-Factor Authentication**.
3. Enter your password in the **Confirm your password** field and click **Disable**.

Two-factor authentication is removed from your account straight away.

## App passwords for external clients

When two-factor authentication is on, external apps such as Thunderbird or Finder cannot use your main
password. You need to create an app password for each of them. See
[Create and manage app passwords](/support/connect/app-passwords) for the details.
