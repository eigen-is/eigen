---
title: "Set up Eigen Calendar in a calendar client"
description: "Sync your Eigen calendars with Apple Calendar, Thunderbird, or any CalDAV-compatible app using an app password."
type: how-to
category: CalDAV
tags: [calendar, caldav, sync, integrations, app-passwords, thunderbird, apple-calendar]
related: [connect/app-passwords, connect/overview]
crossSections: [calendar]
order: 40
updated: 2026-06-08
---

Eigen Calendar syncs over CalDAV, so you can keep your events in step with Apple Calendar, Thunderbird, or any
other CalDAV-compatible app on your computer or phone.

## Before you start

You need two things: the CalDAV server address, and an app password.

**Find the server address.** Open the [**Integrations** page](/space/services) in Space and look at the
**CalDAV (Calendar sync)** section. Two addresses are listed there:

- **Server URL**: the address to use in most CalDAV clients.
- **Server URL (Thunderbird)**: a longer address that points directly to your calendar collection. Use this
  one in Thunderbird and in any other client that does not follow CalDAV auto-discovery.

Copy the address from the page rather than typing it. A single wrong character stops the connection.

**Generate an app password.** App passwords are separate credentials you give to external clients instead of
your main Eigen password. If you have two-factor authentication switched on, an app password is required;
your main password will not work for CalDAV.

1. On the same [**Integrations** page](/space/services), scroll down to **App passwords**.
2. Type a name in the field, such as `Apple Calendar` or `My phone`, then click **Generate**.
3. Copy the password now. It is shown only once.

## Connect in Apple Calendar (macOS or iOS)

### macOS

1. Open the **Calendar** app and go to **File → Add Account**.
2. Choose **Other CalDAV Account** and click **Continue**.
3. Set **Account Type** to **Automatic** (or **Manual** if Automatic fails).
4. Enter your Eigen **email address** as the username.
5. Paste the **Server URL** you copied from the Integrations page.
6. Paste your app password into the **Password** field.
7. Click **Sign In**.

### iOS

1. Open **Settings** and scroll to **Calendar → Accounts → Add Account**.
2. Choose **Other**, then **Add CalDAV Account**.
3. In the **Server** field, paste the **Server URL** from the Integrations page.
4. Enter your Eigen **email address** as the username.
5. Paste the app password into the **Password** field.
6. Tap **Next**. iOS discovers your calendars automatically.

## Connect in Thunderbird

Thunderbird needs the longer **Server URL (Thunderbird)** from the Integrations page.

1. In Thunderbird, open the **Calendar** tab.
2. Click the **New Calendar** button (or right-click the calendar list and choose **New Calendar**).
3. Select **On the Network** and click **Next**.
4. Choose **CalDAV** as the format.
5. Paste the **Server URL (Thunderbird)** into the **Location** field.
6. Click **Find Calendars**.
7. Enter your Eigen **email address** as the username and the app password when prompted.
8. Thunderbird lists your calendars. Tick the ones you want to subscribe to and click **Subscribe**.

## Sign in

For all clients, use:

- **Username**: your Eigen email address
- **Password**: the app password you generated (not your main Eigen password)

## What syncs over CalDAV

CalDAV gives access to the calendars you own. Calendars that other people have shared with you, and team
calendars, do not appear in an external client. You can see those by opening [Calendar](/calendar) in the
browser.

<div class="eigen-callout">

Events created in your calendar client appear in Eigen within a minute or two, and vice versa. Many clients
sync on a schedule rather than instantly.

</div>

## Troubleshooting

**The client asks for a password again and again.** The app password was probably not copied correctly.
Delete it on the [**Integrations** page](/space/services), generate a new one, and update your calendar
client.

**The server address is rejected.** Make sure you copied the full address including the trailing `/`. Some
clients, including Thunderbird, need the **Server URL (Thunderbird)** rather than the shorter **Server URL**.

**No calendars appear after connecting.** Try signing out and back in to force your client to rediscover your
calendar list. If you still see nothing, check that you are using the right address for your client.

**401 Unauthorized.** Your username or password is wrong. Confirm the username is your Eigen email address and
the password is the app password, not your main account password.
