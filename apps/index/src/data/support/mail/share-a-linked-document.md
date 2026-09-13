---
title: "Give access to a document you link in an email"
description: "When your message links to an Eigen document a recipient cannot open, Mail offers to share it as part of sending."
type: how-to
category: Sharing
tags: [mail, sharing, drive, documents, access]
related: [mail/attach-files, drive/share-a-file, mail/compose-and-send]
order: 115
updated: 2026-09-13
---

A document you attach from Drive travels as a link, not as a copy, so it opens only for people who already have
access. When you click **Send**, Mail checks each linked document against the people in the **To** and **Cc**
fields. If someone can't open it, Mail asks what you want to do before the message goes anywhere.

## Share before sending?

The **Share before sending?** dialog lists each document that somebody on the email can't open, with **Viewer**
beside it, and names the people who would be given access. You have three choices:

- **Share & send** gives those people view access to the documents listed, then sends the message. They can open
  the link as soon as it arrives.
- **Send without access** sends the message exactly as written and shares nothing. The link still goes out, and
  anyone without access lands on a screen where they can request it.
- **Cancel** closes the dialog and leaves you in the message. Nothing is sent, so you can take the link out or add
  the recipients from Drive yourself.

Access is only ever added, never taken away, and people who can already open the document are left alone.

## The notes underneath

The dialog can also show short notes about links it can't help with:

- **"Chat invitations aren't granted from mail"**: a chat you link stays as it is. Invite the person from the chat
  room instead. See [Share a chat room](/support/chat/share-room).
- **"Bcc recipients are not granted access"**: access is given to **To** and **Cc** recipients only. A **Bcc**
  recipient would show up in the document's list of people, which would give away that you copied them in.
- **"You can't share …"**: you can open that document yourself, but you're not allowed to pass access on. The note
  names the document, and the recipient can request access instead.

## When there is nothing to share

If every link is one of those cases, the dialog is titled **Send without sharing?** and its main button is a plain
**Send**. There's nothing Mail can grant here, so this is a heads-up: you hear that a link will land on the
request-access screen before you send, rather than after.

<div class="eigen-callout">

You never see this dialog when everyone can already open the documents you linked. In that case **Send** sends
straight away.

</div>
