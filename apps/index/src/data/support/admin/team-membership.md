---
title: "How team membership and shared content work"
description: "Understand what a team is, what members can see and do, and how content is shared across the whole team."
type: overview
tags: [admin, teams, sharing, drive, calendar]
related: [admin/teams, admin/manage-members]
order: 40
updated: 2026-06-08
---

A team is a named group of members on your Eigen server. When you share something with a team, every member of that team gets access straight away. Adding someone to the team gives them that access too; removing them takes it away.

## What a team gets

When an admin creates a team, the team can have three things:

- **A team calendar.** A shared calendar that team members can see, and optionally edit. The admin sets the level of access: **Free/Busy** (members can only see when the team is busy), **Read** (members can see all events), or **Write** (members can add and edit events).
- **A team Drive.** One or more shared storage areas that the team owns. When a team Drive has storage configured, it appears in the sidebar of Drive and the other file apps under **Team Drives**. Every team member can browse and work in it.
- **Quota overrides.** The admin can set storage limits for mail and contacts (combined) and for Drive that are higher than the server defaults. If a member belongs to several teams with different overrides, the most permissive limit wins.

A team does not have to use all three. The admin can leave the team calendar off, or leave the team Drive empty, if the team only needs file sharing through the normal Drive share dialog.

## Roles

Every member has one of three roles. The role controls what they can do in Admin.

| Role | Can use Eigen | Can use Admin |
|---|---|---|
| Member | Yes | No |
| Admin | Yes | Yes: can manage members, teams, and guests |
| Owner | Yes | Yes: full access including server settings, onboarding, and guest access |

There is exactly one owner (the person who completed first-run setup). Their role cannot be changed or removed through Admin.

## How content is shared with a team

### Files and folders

When you open the **Share** dialog for a file or folder in Drive, a **Share with team** button appears at the bottom if you belong to at least one team. Click it to pick the team. Everyone in that team appears in the access list as a group and can open the item straight away.

You can set the team's permission to **Editor** (view and make changes) or **Viewer** (view only), the same as for individual people.

When someone joins a team, they automatically get access to any files and folders that were already shared with that team. When someone leaves, access is removed.

### Calendar

Each team has a default calendar that the admin can enable. When it is enabled, the calendar appears in Calendar for every team member. The admin's setting on the team determines the permission level for all members.

A member can also share their own personal calendar with the team directly from Calendar, choosing the same permission levels.

### What happens when a member is removed from a team

Removing a member from a team removes their access to:

- All files and folders shared with that team.
- The team Drive.
- The team calendar.

Their personal files and calendars are not affected. Files shared with them directly (not through the team) remain accessible.

## Guest users

Guests are a separate account type. They are not members and cannot belong to teams. They can only see content that has been shared with their email address directly. See [Enable and configure guest access](/support/admin/guests) for details.
