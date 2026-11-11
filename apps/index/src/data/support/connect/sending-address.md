---
title: "Send as your own address"
description: "Your mail app has to send from the exact address you sign in with, because Eigen has no aliases and no send-as addresses."
type: troubleshooting
category: Email
tags: [mail, smtp, sending, aliases, integrations, "553"]
related: [connect/mail-client, connect/auth-failures]
crossSections: [mail]
order: 210
updated: 2026-11-11
---

Eigen gives you one email address, with no aliases and no send-as addresses. Your mail app has to send from that exact address. If it uses any other address, your mail still comes in, but every message you send is refused.

## Mail arrives, but nothing sends

**The address your mail app sends from does not match the address you sign in with.** Eigen only sends mail from the address that signed in, which keeps anyone from sending mail in your name. A mismatched message is refused, often with a `553 5.7.1` error. Receiving mail has no such check, so new mail keeps arriving while your outbox fills up.

Mail apps word the error in different ways. Some show your address, some show only the code, and some say the message could not be sent. A few even blame the recipient's address. The address that needs fixing is yours.

## Fix it

1. Open the [**Integrations**](/space/services) page in Space.
2. Copy your address from the **Username** field.
3. In your mail app, open the settings for your Eigen account and find the address it sends from. Apps call this the identity, the sender address, or the account's email address.
4. Paste your address in, so the sending address and the sign-in username match. Capitals don't matter, spelling does.
5. Send a test message to yourself.

If you set up the account with a different address at first, some apps keep that old address as a second identity. Remove or correct it too, or the app may go back to using it.

## Sending many messages at once stalls

**Eigen accepts up to 60 messages a minute from one network, and up to 20 sign-ins.** Most mail apps sign in once for every message, so sending more than 20 messages in a minute can hit the limit. Wait a minute, then send the rest. Most apps try again on their own, so nothing is lost.

<div class="eigen-callout">

This applies only to mail apps on your computer or phone. Sending from [Mail](/mail) in the browser is not affected.

</div>
