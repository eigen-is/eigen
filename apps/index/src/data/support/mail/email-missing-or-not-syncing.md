---
title: "Email is missing or not syncing"
description: "Track down a message you can't find in Mail, and fix sync problems between Eigen and an external mail app over IMAP."
type: troubleshooting
category: Basics
tags: [mail, email, imap, sync, troubleshooting]
related: [mail/get-started, mail/move-email-between-folders, connect/mount-drive-on-your-computer]
order: 210
updated: 2026-06-08
---

A message that seems to have vanished is usually in another mailbox, not gone. And if you read the same account in
a separate mail app on your phone or computer, the two can fall out of step for a few clear reasons. This page
covers both: finding a missing message, and keeping Mail and an external app in sync.

Most of the time the cause is one of three things: the message is in a mailbox you weren't looking at, it's in a
custom folder that Mail doesn't show, or an external app is set up in a way that hides it.

## A message has disappeared from the Inbox

**The message left the Inbox but you didn't delete it.** Archiving, reporting spam, and deleting all move or refile
a message, so it's most likely in another mailbox. Check these, in order:

- **Archive**, if you or someone using the account archived it.
- **Spam**, if it was reported as junk, or filtered there as suspected junk.
- **Trash**, if it was deleted. A deleted message isn't gone right away.

Open each one from the sidebar to look. To bring a message back to your Inbox, move it there. See
[Move email between folders](/support/mail/move-email-between-folders).

## A message is in none of the mailboxes Mail shows

**Mail shows six mailboxes, and only those six.** The sidebar holds **Inbox**, **Drafts**, **Sent**, **Spam**,
**Trash**, and **Archive**. If you use a separate mail app on the same account and create your own folders there,
or your old provider had extra folders, Mail does not list them and does not show what's inside them.

The messages are not lost. They're still in those folders, and you can see them in any mail app connected over
IMAP. To read one in Mail, open the folder in your other app and move the message into one of the six mailboxes
above. It then appears in Mail.

<div class="eigen-callout">

This works the other way too. If you move a message in your other app **out** of the six standard folders and into
a custom one, it leaves Mail's view. Move it back into Inbox, Archive, or another standard folder and Mail picks it
up again.

</div>

## Mail in the browser looks out of date

**Mail updates on its own as messages arrive, are read, or are moved.** You don't need to reload the page, and
there's no manual sync button. New mail, read and unread changes, and moves all appear within moments.

If a view looks stale, reload the page in your browser. That refetches everything from the server.

## An external mail app isn't showing new mail

If you read the account in a separate app such as Apple Mail, Thunderbird, or your phone's mail app, and new
messages aren't arriving there, check the connection settings first.

- **Set the account up as IMAP.** The mail server speaks IMAP, which keeps every app in step with the server, so
  what you read, move, or delete in one place shows up in the others. Pick IMAP when your app asks for an account
  type.
- **Connect with SSL/TLS.** The mail server requires an encrypted connection on the IMAP port **993**. A plain,
  unencrypted connection is refused, so the app shows a connection error instead of your mail.
- **Sign in with an app password, not your main password.** Create an app password on the
  [**Integrations** page](/space/services) in Space, under **App passwords**, and use that as the password in your
  mail app. If you have two-factor authentication switched on, your main password will not work for a mail app at
  all: an app password is required. See [Mount Drive on your computer](/support/connect/mount-drive-on-your-computer)
  for how app passwords work and how to create one.

If the app still won't connect after that, the most common cause is the app password. It's shown only once when you
create it, so if you're not sure you copied it correctly, delete it on the Integrations page and generate a new
one.

## A folder you made in another app is missing from Mail

**Custom folders live on the server, but Mail only shows the six standard mailboxes.** A folder you create in an
external mail app stays there and keeps working in that app and any other IMAP app. It does not appear in Mail's
sidebar.

To keep a message reachable from Mail, file it in one of the six standard mailboxes rather than a folder of your
own.
