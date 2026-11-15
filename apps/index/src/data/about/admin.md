---
title: Admin
description: People, teams, server settings and backups, for the person who runs the server.
---

<!-- DRAFT: the owner rewrites this -->

eigen|admin⟩ is where you run the server. Only admins see it. You add people, put them in teams, and see how much disk each one uses. The owner, the person who set the server up, also gets the settings and the backups ([Set up your Eigen server](/support/admin/get-started)).

::: video src="/data/about/media/admin-hero" caption="Saar's account beside the list of users, then the crew's team with its drive and its members."
:::

## People and teams

You make an account with a name, a username and a first password. The username becomes the address on your mail domain. Make someone an Admin to share the work, reset a password when someone is locked out, which also signs them out everywhere, or delete an account with everything in it ([Add and manage members](/support/admin/manage-members)).

A team is a group you share with at once. Everyone joins the team named after your organization. Make more, add people one by one or a whole selection at a time, and turn on a team calendar ([Create and manage teams](/support/admin/teams)). A team gets its own drive, on the server's disk or in an S3 bucket ([Make an S3 bucket safe for Eigen](/support/admin/s3-bucket-safety)). People from outside sign in with a code by mail and see only what was shared with them ([Enable and configure guest access](/support/admin/guests)).

## Server settings

The owner's Settings page shows the version, the free disk and the HTTPS certificate. It sets who Eigen's own mail comes from, with a button that sends you a test mail, how much each person may store and upload, how long the Trash keeps files, and which events also send an email ([Server settings](/support/admin/server-settings), [Set storage quotas and the default storage type](/support/admin/storage-quotas)). You can put your own buttons on the landing page, beside Log in ([Add your own buttons to the landing page](/support/admin/landing-page-buttons)).

![The top of Settings: the organization's name, how the server is doing and who Eigen's mail comes from](/data/about/media/admin-still-settings.webp)

## Backups

Eigen backs up the whole server while it runs, every night once you turn that on, and nobody is signed out. Each backup is checked after it is made, and it can go to an S3 bucket of its own, off the server. Putting one back is `./eigen restore` on the server, also on a new machine ([Back up and restore the whole server](/support/self-hosting/back-up-and-restore)).

You can also back up one person or one team from their panel, and restore just that account. The account as it was stays beside it as a safety copy, so a restore can be undone ([Back up a user or team](/support/admin/back-up-home), [Restore a user or team from a backup](/support/admin/restore-home)). A backup holds everything, so treat it like a password ([What a backup contains and how it is checked](/support/admin/backup-contents)).

::: carousel
![The admin backs up Saar's account, sees it verified, and deletes it again](/data/about/media/admin-backup)
![Settings, Backups: the nightly backup turned on, and a backup of the whole server made by hand, verified](/data/about/media/admin-still-backups.webp)
:::

## Updates

An update is one command, `./eigen update`. It makes a backup first, warns everyone with Eigen open, and is down only for the switch. If the new version misbehaves, `./eigen rollback` goes back to the one before ([Update Eigen](/support/self-hosting/update)).
