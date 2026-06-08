---
title: "Why an email will not send"
description: "Fix the common reasons a message won't send: a missing recipient, a rejected message, or an attachment that is too large or over your storage limit."
type: troubleshooting
category: Troubleshooting
tags: [mail, sending, attachments, errors, troubleshooting]
related: [mail/compose-and-send, mail/attach-files]
order: 200
updated: 2026-06-08
---

When you click **Send** and the message doesn't go, Mail tells you why. Some checks happen before the message
leaves your screen, and some come back from the mail server as a short message at the bottom of the window. This
page covers the usual causes and what to do about each one.

A message that fails to send is not lost. It stays in your **Drafts** folder, so you can fix the problem and try
again.

## "Please specify at least one recipient"

You need at least one address in the **To** field. Mail shows a **Cannot send** box with this message when the
**To** field is empty.

Add an address in the **To** field and click **Send** again. As you type, Mail suggests matching people from your
contacts and team; pick one, or type the full address yourself.

## "Please add a subject or message"

A message with no **Subject** and no body has nothing to send. Add a subject, or write something in the message
area, then send.

If you fill in the body but leave the subject blank, Mail doesn't block you. It asks **Send without subject?**
first. Click **Send** to send it anyway, or close the box to go back and add a subject.

## The message could not be sent

If the recipient's address is fine but the mail server can't deliver the message, you'll see **Failed to send
email** at the bottom of the window. This usually means the server refused or couldn't hand off the message, for
example because the recipient's address doesn't exist or their mail system rejected it.

Your message stays safe in **Drafts**. Open it from the **Drafts** folder in the sidebar, check the addresses for
typos, and send again. If it keeps failing for everyone you write to, the problem is likely with mail delivery on
the server rather than with your message, so contact whoever runs your Eigen server.

## An attachment is too large

Each attachment has a size limit. If a file is over it, the attachment fails and Mail shows a message telling you
the limit, such as **Attachment exceeds 25MB limit**. The same limit applies whether you add a file from your
computer or attach one from Drive.

To send a large file, share it from Drive instead of attaching it:

1. Upload the file to Drive, or find it there if it's already saved.
2. Share it and copy the link. See [Share a file or folder](/support/drive/share-a-file) for the steps.
3. Paste the link into your message.

The reader opens the file from the link, and your email stays small. This also keeps everyone on the same copy
rather than passing a file back and forth. For more on attachments, see
[Attach files to an email](/support/mail/attach-files).

## Your mail storage is full

Sent and received mail counts towards your storage limit. When it's full, adding an attachment or sending fails
with **Insufficient Storage**.

Free up some space, then try again:

- Empty your **Trash** and **Spam** folders.
- Delete old messages with large attachments.

<div class="eigen-callout">

Saving an attachment to Drive instead of keeping it in your mailbox is a good habit for big files. Open a message,
choose to save its attachments to Drive, and you can then delete the email to reclaim the space.

</div>

## You can't change who the email is from

The **From** field shows your own name and address, and you can't edit it. Every message you send goes out as you.
There's no way to send on behalf of another person or address from here.
