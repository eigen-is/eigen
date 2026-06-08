---
title: "Manage the waitlist"
description: "Review sign-up requests, send invitations, and track who has registered when the waitlist is turned on."
type: how-to
tags: [admin, waitlist, onboarding, invitations]
related: [admin/get-started, admin/manage-members]
order: 110
updated: 2026-06-08
---

When the waitlist is enabled, your Eigen landing page shows a sign-up form where people can submit
their email address and a short note. You review each request in the admin panel and decide whether
to invite them or reject their application.

## Turn on the waitlist

1. Open [Admin](/admin) and click **Onboarding** in the sidebar.
2. Under **Waitlist**, turn on **Enable waitlist**.
3. Click **Save**.

Once enabled, a **Waitlist** entry appears in the sidebar. The landing page now shows a "Join
Waitlist" form instead of a direct sign-up option.

<div class="eigen-callout">

The **Waitlist** sidebar item is visible only to the server owner, not to admins.

</div>

## Review applications

Click **Waitlist** in the sidebar. The list has four tabs:

- **Pending**: new applications waiting for a decision.
- **Invited**: people who have been sent an invitation but have not registered yet.
- **Registered**: people who accepted an invitation and created an account.
- **Rejected**: applications you have declined.

Click any row to open its detail panel on the right. You can see the email address, status,
any notes the person left, the date they submitted, and, for invited entries, when the invite
was sent and when it expires.

To filter the list, type in the **Filter by email...** bar at the top.

## Accept and invite

1. Select the application in the **Pending** tab.
2. Click **Accept & Invite** in the toolbar.

Eigen marks the entry as **Invited** and sends an invitation email immediately. The email
contains a sign-up link that expires after seven days.

## Reject an application

Select the entry and click **Reject** in the toolbar. The entry moves to the **Rejected** tab.
You can change your mind later: select a rejected entry and click **Re-accept & Invite** to
send an invitation.

## Resend an invitation

If an invite has expired or the person did not receive the email, select their entry in the
**Invited** tab and click **Resend Invite**. Eigen generates a fresh link (another seven days)
and sends a new invitation email.

## Delete an entry

Select the entry and click **Delete** in the toolbar. A confirmation dialog asks you to confirm
before removing it permanently.

## Customise the invitation email

1. Open **Onboarding** in the sidebar.
2. With **Enable waitlist** turned on, the **Invite Email** section appears below.
3. Edit the **Subject** and **Body**. The body supports basic formatting.
4. You can use the placeholders `{email}`, `{orgName}`, `{domain}`, and `{inviteLink}` anywhere
   in the subject or body.
5. Click **Save**.
