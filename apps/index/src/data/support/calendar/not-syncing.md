---
title: "Your calendar is not syncing"
description: "Fix CalDAV sync problems between Eigen Calendar and an external calendar app such as Apple Calendar, Thunderbird, or BusyCal."
type: troubleshooting
tags: [calendar, caldav, sync, troubleshooting, app-passwords]
related: [calendar/get-started]
order: 200
updated: 2026-06-08
---

If you use an external calendar app alongside Eigen Calendar, the two stay in step via CalDAV. Most sync problems
come down to one of three things: wrong server address, wrong password, or a limitation of what CalDAV exposes.
This page covers those in order.

## Get the right connection settings

Eigen shows the exact CalDAV settings you need. Open the [**Integrations** page](/space/services) in Space and
look at the **CalDAV (Calendar sync)** section. You will see three fields:

- **Server URL**: the address to use in most CalDAV clients.
- **Server URL (Thunderbird)**: a longer address that points directly to your calendar collection; required by
  Thunderbird and some other clients that do not follow CalDAV discovery automatically.
- **Username**: your Eigen email address.

Copy the address from the page rather than typing it. A single wrong character stops the connection.

## Sign in with an app password

CalDAV uses HTTP Basic authentication. Your main account password works if you do not have two-factor
authentication switched on. If you do have it switched on, your main password will not work: you must use an
app password.

App passwords are separate credentials you create specifically for external clients. You can revoke one at any
time without changing your main password.

To create one:

1. Open the [**Integrations** page](/space/services) in Space.
2. Scroll to **App passwords**.
3. Type a name for the password, such as "Apple Calendar" or "My phone", then click **Generate**.
4. Copy the password now. It is shown only once.

Use your Eigen **email address** as the username and the app password as the password in your calendar app. If
you are not sure your existing app password was copied correctly, delete it on the Integrations page and
generate a new one.

## Common problems

**The client asks for a password again and again.** The most likely cause is a wrong app password. Passwords are
only shown once when you create them. Delete the old one on the Integrations page, generate a new one, and update
it in your calendar app.

**The server URL is rejected or the client cannot find the account.** Check that you are using the correct
**Server URL** from the Integrations page. Some clients, including Thunderbird, need the longer
**Server URL (Thunderbird)** that ends with your user ID. Try switching to that address.

**The client connects but shows no calendars.** CalDAV only exposes the calendars you own. Calendars that other
people have shared with you, and team calendars, are not available over CalDAV. You can see those by opening
[Calendar](/calendar) in the browser, but they do not appear in an external client.

**Events created in the external app do not appear in Eigen, or vice versa.** Check that the calendar app has
finished its sync cycle. Many apps sync every few minutes rather than instantly. If events still do not
appear after a minute or two, reconnect the account in your calendar app's settings to force a full resync.

**401 Unauthorized errors.** This means the username or password is wrong. Confirm your username is your Eigen
email address, and that the password is the app password, not your main account password.
