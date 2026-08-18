---
title: "Connect external apps to Eigen"
description: "Use Eigen Mail, Calendar, Contacts, and Drive from any IMAP, CalDAV, CardDAV, or WebDAV client by generating an app password on the Integrations page."
type: overview
tags: [connect, imap, caldav, carddav, webdav, app-passwords, integrations]
related: [connect/app-passwords, connect/mount-drive-on-your-computer, connect/contacts-client]
order: 10
updated: 2026-08-17
---

Eigen works in the browser, but your Mail, Calendar, Contacts, and Drive are also available to any standard
client app on your computer or phone. This page explains what you can connect and how credentials work.

## What you can connect

Open the [**Integrations** page](/space/services) in Space to see the connection details for all four protocols.

**Mail (IMAP and SMTP)**
Your Eigen mailbox is available over IMAP for reading and SMTP for sending. This lets you use any email client,
such as Thunderbird or Apple Mail, alongside or instead of the browser.

**Calendar (CalDAV)**
Your Eigen calendars sync over CalDAV. Any calendar app that supports CalDAV, including Thunderbird, Apple
Calendar, and most Android and iOS calendar apps, can stay in sync with your events.

**Contacts (CardDAV)**
Your Eigen contacts sync over CardDAV. Apple Contacts, DAVx5 on Android, and Thunderbird can keep your contacts
in step, both ways. See [Set up Eigen Contacts in a contacts app](/support/connect/contacts-client) for
step-by-step instructions.

**Drive (WebDAV)**
Each of your drives is accessible over WebDAV. You can browse and edit files in Finder, File Explorer, or any
WebDAV client. See [Mount Drive on your computer](/support/connect/mount-drive-on-your-computer) for step-by-step
instructions.

## App passwords

To connect an external client you need an **app password**, not your main account password. App passwords are
separate credentials you generate specifically for each client app. They keep working when two-factor
authentication is enabled, and you can revoke one at any time without changing your main password.

To create an app password, open the [**Integrations** page](/space/services), scroll to **App passwords**,
type a name for the password (for example, `Thunderbird` or `iPhone`), and click **Generate**. Copy the
password straight away. It is shown only once.

Your Eigen **email address** is the username for all four protocols: IMAP, CalDAV, CardDAV, and WebDAV.

## Where to find your connection details

All the server addresses, ports, and URLs you need are on the [**Integrations** page](/space/services):

- **CalDAV (Calendar sync)**: the server URL and a Thunderbird-specific URL.
- **CardDAV (Contacts sync)**: the address-book URL.
- **IMAP (Email sync)**: IMAP server, port, security setting, SMTP server, and SMTP port.
- **WebDAV (Drive sync)**: one URL per drive, for your personal drives and any team drives you belong to.

The username field on that page is pre-filled with your email address so you can copy it in one click.
