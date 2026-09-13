---
title: "Welcome new users with an email and a contact"
description: "Write the welcome message new users find in their Inbox, and add the owner to their contacts, from the Onboarding page in Admin."
type: how-to
tags: [admin, onboarding, email, users, contacts]
related: [admin/manage-members, admin/waitlist]
order: 105
updated: 2026-09-13
---

When a new account is set up, Eigen can put a welcome message in that person's Inbox and add the owner to their contacts. You control both on the **Onboarding** page in Admin. Only the server owner sees that page.

To open it, sign in as the owner, go to [Admin](/admin), and click **Onboarding** in the sidebar.

## Write the welcome email

The **Welcome mail** section is near the bottom of the page.

1. Check that **Send welcome email** is on. It is on by default, and turning it off means new users get nothing.
2. Edit **Subject**. It starts as `Welcome to {orgName}!`.
3. Edit **Body**. It is a formatted text box, so the message arrives looking the way it does here.
4. Click **Save**.

**Save** and **Reset** appear once you have changed something. **Reset** puts every field on the page back to what is saved.

## Placeholders

You can use these in both **Subject** and **Body**. Eigen fills them in for each person as the message is written.

| Placeholder | Filled in with |
|---|---|
| `{name}` | The new user's name |
| `{orgName}` | Your organisation's name |
| `{domain}` | Your server's domain |

The same list is shown under the **Body** box, so you do not have to remember it.

## When the message arrives

Eigen writes the message straight into the new user's Inbox as their mailbox is created. It does not travel over your mail server, so it still works if outgoing email is not configured yet. It shows as coming from your organisation's name.

Only new accounts get it. Editing the subject or the body later changes what the next person receives, and does not resend anything to people who already have an account.

## Add the owner to new users' contacts

Under **Auto-add admin contact**, turn on **Add owner to new user contacts**, then click **Save**. This is off by default.

With it on, the owner is added as a contact in Contacts, so a new user has at least one address to write to on their first day. It happens once per person. If someone deletes that contact, it stays deleted. Nobody gets a card for themselves, and nothing is added if they already have a contact with the owner's address on it.
