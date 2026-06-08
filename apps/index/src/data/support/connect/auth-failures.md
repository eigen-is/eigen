---
title: "Fix authentication failures"
description: "Resolve 401 Unauthorized errors when connecting an external client to Eigen Mail, Calendar, or Drive."
type: troubleshooting
category: Authentication
tags: [authentication, app passwords, imap, caldav, webdav, "401", integrations]
related: [connect/app-passwords, connect/overview]
order: 200
updated: 2026-06-08
---

If an external client shows a sign-in error or refuses to connect, the cause is almost always one of three
things: the wrong password, the wrong username, or a connection over plain HTTP instead of HTTPS. This article
covers each case.

## 401 Unauthorized

A `401 Unauthorized` response means the server received your credentials but could not verify them.

**The password was typed or pasted incorrectly.** App passwords are long and easy to mis-copy. Open the
[**Integrations**](/space/services) page, find the password in the **App passwords** list, and delete it using
the trash icon. Then click **Generate** to create a fresh one. Copy the new password straight from the box
before you click **Done**.

**Two-factor authentication is on, but you used your main password.** When two-factor authentication is
enabled, external clients cannot use your main Eigen password. An app password is required. Create one on
the [**Integrations**](/space/services) page and enter it in your client instead.

**The username is wrong.** Use your Eigen **email address** as the username, not a display name or a short
login. The email address to use is shown in the **Username** field on the [**Integrations**](/space/services)
page.

**The app password belongs to a different account.** Each app password is tied to the account that created
it. If you have more than one Eigen account, make sure the app password matches the email address you are
entering as the username.

## The client says it cannot connect, or the connection times out

**The URL or server address is wrong.** Check that you copied the correct address from the
[**Integrations**](/space/services) page. CalDAV and WebDAV URLs must end with a `/`. WebDAV URLs follow
this format:

```
https://<your-eigen-host>/webdav/<ownerId>/<mountId>/
```

The CalDAV server URL for most clients is `https://<your-eigen-host>/dav/`. Thunderbird uses a longer URL
that includes your user ID; both are listed on the Integrations page.

**The connection is over HTTP instead of HTTPS.** Eigen requires an encrypted connection for all external
clients. Change the URL in your client to start with `https://` rather than `http://`. For IMAP, use port
`993` with SSL/TLS, not an unencrypted port. For SMTP, use port `465` with SSL/TLS.

<div class="eigen-callout">

The IMAP server rejects plain (unencrypted) connections regardless of whether the password is correct.

</div>

## Still not working

If none of the above fixes the problem, try these steps:

1. Delete the app password from the [**Integrations**](/space/services) page.
2. Generate a new one, giving it a clear name so you know which client it is for.
3. Copy the new password immediately from the confirmation box.
4. In your client, remove the existing account and add it again from scratch, pasting the new app password
   when prompted.

If you still cannot connect, check that your Eigen host is reachable from your device (try opening it in a
browser), and that the server address in your client matches the address you use to sign in to Eigen.
