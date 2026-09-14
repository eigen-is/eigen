---
title: "Add your own buttons to the landing page"
description: "Put extra title-and-link buttons on the public landing page from the Settings page in Admin."
type: how-to
tags: [admin, settings, landing, links]
related: [admin/server-settings, admin/waitlist]
order: 85
updated: 2026-09-13
---

The landing page is what visitors see at the address of your server before they sign in. You can add your own buttons to it, each with a title you choose and a web address it opens. People use them for a status page, a handbook, or the organization's main website.

Only the server owner can do this.

## Add a button

1. Sign in as the owner and go to [Admin](/admin), then click **Settings** in the sidebar.
2. Scroll down to **Landing page**.
3. Click **Add button**. A new row appears with two boxes.
4. Type the button's text in the first box, and the full address in the second, for example `https://status.example.com`.
5. Click **Save** at the bottom of the page.

**Save** and **Reset** only appear once you have changed something. **Reset** throws away every unsaved change on the page, not only the buttons.

A few things happen when you save:

- The address has to start with `http://` or `https://`. If you leave that off, Eigen adds `https://` for you.
- A row with an empty title or an empty address is dropped.
- A title can be up to 80 characters long.
- You can have 20 buttons. At 20 the **Add button** button disappears.

## Where the buttons show up

The buttons sit on the landing page next to **Login**, in the order you listed them. If the waitlist is turned on, they come after the **Join Waitlist** button. See [Manage the waitlist](/support/admin/waitlist) for that form.

Clicking one opens the address in the same tab, so the visitor leaves the landing page.

<div class="eigen-callout">

Visitors who are already signed in never see the landing page. Eigen sends them straight to their workspace, so these buttons are for people who have not signed in yet.

</div>

## Change or remove a button

Open **Settings** again and scroll to **Landing page**. Edit either box to change a button's text or address. To take one away, click **Remove** (the bin icon) at the end of its row. Click **Save** when you are done.
