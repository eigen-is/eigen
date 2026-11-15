---
title: Admin
description: People, teams, server settings and backups, for the person who runs the server.
---

eigen|admin⟩ is where you [run the server](/support/admin/get-started). Only admins see it. You add people, put them in teams, and see how much disk each one uses. The owner, the person who set the server up, also gets the settings and the backups.

::: video src="/data/about/media/admin-hero" caption="Saar's account beside the list of users, then the crew's team with its drive and its members."
:::

## People and teams

You [make an account](/support/admin/manage-members) with a name, a username and a first password. The username becomes the address on your mail domain.

Make someone an Admin to share the work. Reset a password when someone is locked out, which also signs them out everywhere. Or delete an account with everything in it.

A [team](/support/admin/teams) is a group you share with at once. Everyone joins the team named after your organization. Make more, add people one by one or a whole selection at a time, and turn on a team calendar.

A team gets its own drive, on the server's disk or in an [S3 bucket](/support/admin/s3-bucket-safety). At the festival the whole crew is one team, and Timo, Sanne and Tessa are a second one for stage and tech, which Saar shares her site access notes with. A new volunteer gets an account and joins the crew's team, and the plan, the budget and the crew's calendar are there at the first login.

[People from outside](/support/admin/guests) sign in with a code by mail and see only what was shared with them.

## Server settings

The owner's [Settings page](/support/admin/server-settings) shows the version, the free disk and the HTTPS certificate. It sets who Eigen's own mail comes from, with a button that sends you a test mail.

It also sets [how much each person may store](/support/admin/storage-quotas) and upload, how long the Trash keeps files, and which events also send an email. You can put [your own buttons](/support/admin/landing-page-buttons) on the landing page, beside Log in.

![The top of Settings: the organization's name, how the server is doing and who Eigen's mail comes from](/data/about/media/admin-still-settings.webp)

## Backups

Eigen [backs up the whole server](/support/self-hosting/back-up-and-restore) while it runs, every night once you turn that on, and nobody is signed out. Each backup is checked after it is made, and it can go to an S3 bucket of its own, off the server. Putting one back is `./eigen restore` on the server, also on a new machine.

You can also [back up one person or one team](/support/admin/back-up-home) from their panel, and [restore just that account](/support/admin/restore-home). The account as it was stays beside it as a safety copy, so a restore can be undone. A backup [holds everything](/support/admin/backup-contents), so treat it like a password.

::: carousel
![The admin backs up Saar's account, sees it verified, and deletes it again](/data/about/media/admin-backup)
![Settings, Backups: the nightly backup turned on, and a backup of the whole server made by hand, verified](/data/about/media/admin-still-backups.webp)
:::

## Updates

An [update](/support/self-hosting/update) is one command, `./eigen update`. It makes a backup first, warns everyone with Eigen open, and is down only for the switch. If the new version misbehaves, `./eigen rollback` goes back to the one before.
