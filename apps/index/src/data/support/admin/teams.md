---
title: "Create and manage teams"
description: "Create a team in Admin, add and remove members, and delete a team you no longer need."
type: how-to
tags: [admin, teams, members]
related: [admin/manage-members, admin/team-membership]
order: 30
updated: 2026-10-28
---

Teams let you group members together so you can share files, folders, and calendars with everyone in the group at once. You manage teams from the [Admin app](/admin/teams).

## Create a team

1. Open the [Admin app](/admin/teams).
2. The **Teams** page lists every team in your organization. From another Admin page, click **Teams** in the sidebar to get there.
3. Click the **+** button (**Create team**) next to the search bar at the top of the list.
4. In the **Create team** dialog, type a name for the team.
5. Click **Create**.

The new team appears in the list. Click it to open its detail panel on the right. To go back to the full list, click **Close** (the **X**) in the toolbar above the detail panel.

## Add members to a team

1. On the **Teams** page, click the team in the list.
2. In the **Members** section of the detail panel, click **Add**.
3. In the **Add member to team** dialog, search by name or email address.
4. Click a person to add them. The dialog stays open, so you can add the next one.
5. Close the dialog when you are done.

## Add several people at once

1. Open the **Users** page from the sidebar.
2. Select the people. Hold Shift and click to select a range, or hold Ctrl (Command on a Mac) and click to add people one by one.
3. Right-click the selection and choose **Add to team…**. On a phone or tablet, press and hold a person's row to add that one person.
4. In the **Add to team** dialog, search for the team and click it.

Everyone you selected joins that team. An account marked **no organization** can't be selected, because only members of your organization can join a team.

## Remove a member from a team

1. On the **Teams** page, click the team in the list.
2. In the **Members** section, find the person you want to remove.
3. Click the **×** button to the right of their name.

## Change one person's teams

1. On the [**Users**](/admin/users) page, click the person's name to open their detail panel.
2. The **Teams** section, under **Role**, lists the teams the person is in. The team named after your organization, which everyone joins, is not listed or counted, so **Not in any team yet** means the person is in no other team.
3. To add them to a team, click **Add to team**, then click the team in the **Add to team** dialog. Teams the person is already in are not listed, and neither is the team named after your organization.
4. To take them out of a team, click the **×** button to the right of the team's name.

An account marked **no organization** has no **Teams** section.

## Edit team settings

1. On the **Teams** page, click the team in the list.
2. Click **Edit** at the top of the detail panel.
3. Change the **Team name** if needed.
4. Under **Calendar**, turn the team calendar on or off, and set how much access members have: **Free/Busy**, **Read**, or **Write**.
5. **Notify members** is on for a new team. While it is on, every member gets a notification, and an email if your server sends them, when someone asks for access to a file on the team's Drive. Turn it off and nobody is told. Every new user joins the team named after your organization, so a request on its Drive reaches everyone.
6. Under **Quota overrides**, you can raise the storage limits of this team's members: **Mail, Contacts & Calendar (MB)** (**Contacts & Calendar (MB)** on a server without mailboxes), and **Default mount (MB)** for each member's own Drive. The team's own Drive keeps its own limit. Leave the fields empty to use the server defaults.
7. Click **Save settings**.

## Delete a team

1. On the **Teams** page, click the team in the list.
2. Click the delete icon (a bin) in the toolbar at the top right of the detail panel.
3. Read the confirmation message and click **Delete**.

Deleting a team also deletes its drives with every file on them, and its calendar. It cannot be undone.

The team named after your organization, which everyone joins, can't be deleted. Its detail panel has no delete icon and says it is your organization's default team.

<div class="eigen-callout">

If you want to understand what access members gain or lose when a team is created or deleted, see [How team membership and shared content work](/support/admin/team-membership).

</div>
