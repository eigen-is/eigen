---
title: "Set up Eigen Contacts in a contacts app"
description: "Sync your Eigen contacts with Apple Contacts or DAVx5 on Android using CardDAV and an app password."
type: how-to
category: CardDAV
tags: [contacts, carddav, sync, integrations, app-passwords, davx5, apple-contacts]
related: [connect/app-passwords, connect/overview]
crossSections: [contacts]
order: 45
updated: 2026-08-17
---

Eigen Contacts syncs over CardDAV, so you can keep your contacts in step with Apple Contacts on a Mac or
iPhone, or with DAVx5 on Android. Changes flow both ways. Add a contact on your phone and it shows up in
Eigen. Edit one in Eigen and it reaches your phone.

## Before you start

You need two things: your Eigen web address, and an app password.

**Find your web address.** This is the address you use to open Eigen in your browser, for example
`https://your-domain`. Most CardDAV clients discover your address book from that base address on their own.
Some clients also accept the discovery path `https://your-domain/.well-known/carddav`.

**Generate an app password.** App passwords are separate credentials you give to external clients instead of
your main Eigen password. If you have two-factor authentication switched on, an app password is required;
your main password will not work for CardDAV.

1. Open the [**Integrations** page](/space/services) in Space.
2. Scroll down to **App passwords**.
3. Type a name in the field, such as `Apple Contacts` or `My phone`, then click **Generate**.
4. Copy the password now. It is shown only once.

## Connect in Apple Contacts (macOS or iOS)

### macOS

1. Open the **Contacts** app and go to **Contacts → Add Account** (or **Settings → Accounts → Add Account**).
2. Choose **Other Contacts Account** and click **Continue**.
3. Set **Account Type** to **Manual**.
4. Enter your Eigen **email address** as the username.
5. Paste your app password into the **Password** field.
6. In the **Server Address** field, enter your Eigen web address, such as `https://your-domain`.
7. Click **Sign In**. Apple Contacts finds your address book and starts syncing.

### iOS

1. Open **Settings** and scroll to **Contacts → Accounts → Add Account**.
2. Choose **Other**, then **Add CardDAV Account**.
3. In the **Server** field, enter your Eigen web address, such as `https://your-domain`.
4. Enter your Eigen **email address** as the username.
5. Paste the app password into the **Password** field.
6. Tap **Next**. iOS finds your address book automatically.

## Connect in DAVx5 (Android)

DAVx5 is the most common CardDAV client on Android. It syncs both contacts and calendars, but you can enable
just contacts.

1. Install **DAVx5** from your app store and open it.
2. Tap the **+** button to add an account.
3. Choose **Login with URL and user name**.
4. In the **Base URL** field, enter your Eigen web address, such as `https://your-domain`.
5. Enter your Eigen **email address** as the user name.
6. Enter your app password as the password, then tap **Login**.
7. DAVx5 lists the address book it finds. Turn on **Contacts** sync for the account.
8. Grant DAVx5 permission to access your contacts if Android asks.

Your contacts sync into the Android address book, and new contacts you add on the phone sync back to Eigen.

## Sign in

For all clients, use:

- **Username**: your Eigen email address
- **Password**: the app password you generated (not your main Eigen password)
- **Server**: your Eigen web address, such as `https://your-domain`

## What syncs over CardDAV

CardDAV gives access to your personal contacts. Contact photos and labels sync too. Team member suggestions
that appear inside Eigen are not personal contacts, so they do not sync to an external app.

<div class="eigen-callout">

Contacts created in your app appear in Eigen within a minute or two, and vice versa. Many clients sync on a
schedule rather than instantly.

</div>

## Troubleshooting

**The client asks for a password again and again.** The app password was probably not copied correctly. Delete
it on the [**Integrations** page](/space/services), generate a new one, and update your contacts app.

**The server address is rejected.** Use your plain Eigen web address, such as `https://your-domain`, without a
path after it. If the client still cannot find the account, try the discovery path
`https://your-domain/.well-known/carddav`.

**No contacts appear after connecting.** Give the client a minute to finish its first sync. On Android, check
that Contacts sync is switched on for the account in DAVx5 and that you granted the contacts permission.

**A blank or empty contact shows up.** Some apps store contact groups as their own hidden entry. A client such
as DAVx5 or Thunderbird can show that entry as a blank contact. It is harmless and does not affect your real
contacts.

**An animated contact photo does not show in Thunderbird.** Thunderbird does not display animated GIF contact
photos. The photo still syncs correctly and shows in Eigen and on other devices. Still photos, including
transparent PNG, show fine in Thunderbird.

**401 Unauthorized.** Your username or password is wrong. Confirm the username is your Eigen email address and
the password is the app password, not your main account password.
