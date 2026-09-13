---
title: "Send as your own address"
description: "Your mail client has to send using the exact address you sign in with, because Eigen has no aliases and no send-as addresses."
type: troubleshooting
category: Email
tags: [mail, smtp, sending, aliases, integrations, "553"]
related: [connect/mail-client, connect/auth-failures]
crossSections: [mail]
order: 210
updated: 2026-09-13
---

Eigen gives you one email address, with no aliases and no send-as addresses. A mail client has to send using
that exact address. If it is set up with any other sender address, it still receives your mail normally, but
every message you try to send is refused.

## Mail arrives, but nothing sends

**The sender address in your client does not match the address you sign in with.** The submission ports check
the two against each other, and refuse the message with a `553 5.7.1` error when they differ. Receiving is a
separate connection with no such check, which is why the account looks half-broken: new mail keeps arriving
while the outbox fills up.

The error text your client shows varies. Some report the address, some show only the code, and some say the
message could not be sent. The check runs at the point where your client names the recipient, so a few clients
report it as a problem with the recipient's address. The address at fault is yours.

## Fix it

1. Open the [**Integrations**](/space/services) page in Space.
2. Copy your address from the **Username** field.
3. In your mail client, open the settings for the Eigen account and find the address it sends from. Clients
   call this the identity, the sender address, or the email address of the account.
4. Paste your address in, so the sending address and the sign-in username are the same string. Capitalisation
   does not matter, spelling does.
5. Send a test message to yourself.

If the account was set up with a different address from the start, some clients keep the original one as a
separate identity. Remove or correct that identity too, otherwise the client can fall back to it.

## Why there are no aliases

One address per account is what makes the check possible, and the check is what stops a stolen password being
used to send forged mail. A single account was enough to push thousands of spam messages through a server
before this was in place. Binding every message to the address that signed in ends that.

## Sending many messages at once stalls

**Each submission port accepts up to 20 sign-in attempts a minute from one internet address.** Most clients
sign in once per message, so sending more than 20 messages in a minute from the same network reaches the cap.
Wait a minute, then send the rest. The limit counts per internet address, so one busy client cannot use up
another one's allowance.

<div class="eigen-callout">

This applies to external clients only. Sending from [Mail](/mail) in the browser goes a different route and is
not affected.

</div>
