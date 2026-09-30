---
title: "Move Eigen to another server"
description: "Take a full snapshot on the old server, install Eigen on the new one, restore the snapshot there, and point your domain at it."
type: how-to
category: Maintenance
tags: [self-hosting, backup, restore, migrate, move]
related: [self-hosting/back-up-and-restore, self-hosting/install]
order: 100
updated: 2026-09-30
---

A full snapshot holds the whole server, so moving is a backup on the old machine and a restore on the new one. Everyone keeps their account, mail, files, and settings. Plan for some downtime: anything people change on the old server after the snapshot does not come along.

## 1. Make a snapshot on the old server

In the install folder, run `./eigen backup`, without `--light`: a light snapshot leaves the files and the mail out. Then run `./eigen stop`, so nothing changes after the snapshot.

The snapshot is `snapshots/eigen-<time>.tar.gz`. Also copy anything a snapshot leaves out that you want to keep, like `docker-compose.override.yml` and the `backups/` folder. See [what a snapshot leaves out](/support/self-hosting/back-up-and-restore#what-a-snapshot-leaves-out).

## 2. Install Eigen on the new server

Follow steps 1, 3, and 4 of [Install Eigen on a server](/support/self-hosting/install), and give the same answers to the setup questions as on the old server. Leave the DNS for the end. You don't need to open the setup link: the restore brings your organization and accounts back.

The new install must run the same version of Eigen as the old one, or a newer one. The install gets the newest release, so that is usually the case.

## 3. Restore the snapshot

Copy the snapshot into a `snapshots/` folder in the new install folder, as the user that owns it. Make the folder first if it is not there. Then, in the install folder:

```bash
./eigen restore eigen-<time>.tar.gz
```

The restore puts back `data/` and `.env.production` from the old server, and brings back the version of Eigen that made the snapshot. The empty data of the fresh install is kept aside, and you can delete it once all is well. If Eigen does not start and says `pool overlaps with other one on this address space`, see [Fix common server problems](/support/self-hosting/troubleshooting#eigen-does-not-start-pool-overlaps).

## 4. Point your domain at the new server

Change the A record of your web address to the IP address of the new server. Hosting mail? Also set the reverse DNS of the new IP address at your hosting provider. The DKIM key comes with the snapshot, so the other mail records stay as they are.

Eigen gets a new HTTPS certificate by itself once the domain points at the new server. Check on everything with `./eigen status`, and send yourself a mail.

## Drives in an S3 bucket

A drive stored in an S3 bucket keeps its files in the bucket, not in the snapshot. The restored server reads them from the same bucket, so leave the bucket as it is and keep its credentials valid.
