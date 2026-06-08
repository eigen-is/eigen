---
title: "Share a room and manage access"
description: "Add people to a chat room, choose what they can do, and control who can change the access list."
type: how-to
tags: [chat, rooms, sharing, permissions, access]
related: [chat/create-room, chat/personal-and-team-chats]
order: 90
updated: 2026-06-08
---

By default, a room you create is private. Only you can see it until you invite someone. You can share a room
with specific people, with a whole team, or with anyone on your Eigen server who has the link.

## Open the Share dialog

Open the room and click the **Share** button (the person-with-plus icon) in the toolbar at the top right.
The **Share** dialog opens, titled with the name of the room.

## Add people

1. Type a name or email address in the box at the top of the dialog. Matching contacts appear as you type.
2. Select the person from the list, or press Enter once you have typed a full email address.
3. They appear under **People with access** as an **Editor** (they can send messages and read the room).
4. To change what they can do, open the dropdown next to their name and pick **Editor** or **Viewer**. Viewers can read messages but cannot post.
5. To remove someone, set their dropdown to **Remove**.
6. Click **Save**.

## Share with a team

If you belong to a team, click **Share with team** at the bottom of the dialog and pick the team from the
list. Everyone in that team gets access to the room.

## Share with a link

Under **General access**, a room starts as **Restricted**: only people you have added can open it.

To let anyone on your Eigen server join, click the lock icon to switch it to **Unrestricted**, then choose
**Can view** or **Can edit** from the dropdown that appears. Copy the link using the copy-link icon next to
**People with access** and send it to whoever you like.

<div class="eigen-callout">

An **Unrestricted** room still requires the other person to sign in to Eigen. It is not open to the public
web.

</div>

## Let people know by email

After you save, click the envelope icon in the **People with access** toolbar to open the **Email
collaborators** dialog. Write a message, then click **Send**. A link to the room is included automatically.

## Control who can change sharing

If you own the room, you can stop editors from adding or removing people. In the **Share** dialog, untick
**Editors can share**. With this off, only you can change who has access. Editors can still post messages,
but they cannot invite new people or remove anyone.

## Team rooms

Team rooms belong to a team, so access follows team membership rather than a per-room list. The **Share**
button is still available for adding individual guests alongside the team, but you cannot remove or restrict
team members through the room's share settings. To add or remove a team member, an admin needs to change
their team membership.

## Invite someone with a slash command

You can also invite someone directly from the message input without opening the dialog. Type `/invite`
followed by their email address and press Enter:

```
/invite alice@example.com
```

If the person already has access, Chat tells you so. Otherwise they are added to the room straight away.
