---
title: "Email is missing or not syncing"
description: "Track down a message you can't find in Mail, and fix sync problems between Eigen and an external mail app over IMAP."
type: troubleshooting
category: Basics
tags: [mail, email, imap, sync, troubleshooting]
related: [mail/get-started, mail/move-email-between-folders, connect/mount-drive-on-your-computer]
order: 210
updated: 2026-09-21
---

A message that seems to have vanished is usually in another mailbox, not gone. And if you read the same account in
a separate mail app on your phone or computer, the two can fall out of step for a few clear reasons. This page
covers both: finding a missing message, and keeping Mail and an external app in sync.

Most of the time the cause is one of two things: the message is in a mailbox you weren't looking at, or an
external app is set up in a way that hides it.

## A message has disappeared from the Inbox

**The message left the Inbox but you didn't delete it.** Archiving, reporting spam, and deleting all move or refile
a message, so it's most likely in another mailbox. Check these, in order:

- **Archive**, if you or someone using the account archived it.
- **Spam**, if it was reported as junk, or filtered there as suspected junk.
- **Trash**, if it was deleted. A deleted message isn't gone right away.

Open each one from the sidebar to look. To bring a message back to your Inbox, move it there. See
[Move email between folders](/support/mail/move-email-between-folders).

## A message is in none of the six standard mailboxes

**Mail lists your own folders too, below the standard six.** **Inbox**, **Drafts**, **Sent**, **Spam**, **Trash**,
and **Archive** sit at the top of the sidebar. Folders you made in a separate mail app on the same account, or
that came across from an old provider, appear under **Folders**, with the unread count beside each name. Click one
to read what's in it.

A folder inside another folder shows its full path, so a folder called Acme inside Clients reads as
**Clients/Acme**.

<div class="eigen-callout">

Mail doesn't create, rename, or delete folders. Make them in your other mail app, and they appear in Mail.

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

**Mail lists the folders you make in another app, accents, ampersands, and emoji included.** A folder is left out only when its name would break the folder tree: a name holding a dot or a slash, a name that is empty or only spaces, or one longer than 200 characters. Such a folder stays on the server and keeps working in your other mail app, but Mail leaves it out of the sidebar.

Rename the folder in your other app, or move the messages into a folder Mail lists.
