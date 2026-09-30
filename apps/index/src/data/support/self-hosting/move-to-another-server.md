---
title: "Move Eigen to another server"
description: "Make a Full backup on the old server, restore it on the new one with one line, and point your domain at it."
type: how-to
category: Maintenance
tags: [self-hosting, backup, restore, migrate, move]
related: [self-hosting/back-up-and-restore, self-hosting/install]
order: 100
updated: 2026-09-30
---

A Full backup holds the whole server, so moving is a backup on the old machine and a restore on the new one. Everyone keeps their account, mail, files, and settings, and stays signed in. Plan for some downtime: anything people change on the old server after the backup does not come along.

## 1. Make a backup on the old server

In the install folder, run `./eigen backup`, without `--light`: a Light backup leaves the files and the mail out. Then run `./eigen stop`, so nothing changes after the backup.

The backup is `backups/server-manual-full-<date>-<time>.tar`. The old server is gone? Take last night's backup from your backup bucket instead.

Also copy what a backup leaves out that you want to keep, like `docker-compose.override.yml` and the older backups in `backups/`. See [what a backup leaves out](/support/self-hosting/back-up-and-restore#what-a-backup-leaves-out).

## 2. Copy the backup to the new server

Install Docker on the new server, as in step 1 of [Install Eigen on a server](/support/self-hosting/install). Then copy the backup over, for example:

```bash
scp /opt/eigen/backups/server-manual-full-<date>-<time>.tar root@new-server:/root/
```

## 3. Restore it on the new server

On the new server, make an empty folder for Eigen and restore the backup into it:

```bash
mkdir -p /opt/eigen && cd /opt/eigen
curl -fsSL https://eigen.is/install | sh -s -- restore /root/server-manual-full-<date>-<time>.tar
```

There is no setup to run first. Eigen takes `.env.production` from the backup, with your setup answers in it, gets the version of Eigen that made the backup, restores everything, and starts. It asks before it restores, and `--yes` at the end skips that question.

This needs a backup that holds `.env.production`, made by an install from the one-line install. On a new server where Eigen is already set up, run `./eigen restore /root/server-manual-full-<date>-<time>.tar` in its install folder instead. If Eigen does not start and says `pool overlaps with other one on this address space`, see [Fix common server problems](/support/self-hosting/troubleshooting#eigen-does-not-start-pool-overlaps).

## 4. Point your domain at the new server

Change the A record of your web address to the IP address of the new server. Hosting mail? Also set the reverse DNS of the new IP address at your hosting provider. The key that signs your mail comes with the backup, so the other mail records stay as they are. The restore says so before it asks. If it says the backup has no DKIM key, the new server makes a new one: add its record as in [Host your mail on Eigen](/support/self-hosting/host-your-mail#add-the-mail-dns-records).

Eigen's own web server gets a new HTTPS certificate by itself once the domain points at the new server. Behind your own web server, set up its certificate and the certbot hook for mail again, as in [Run Eigen behind your own web server](/support/self-hosting/behind-your-web-server). Check on everything with `./eigen status`, and send yourself a mail. The nightly backup and the backup bucket come along with the rest of the settings.

## Drives in an S3 bucket

A drive stored in an S3 bucket keeps its files in the bucket. A Full backup holds only the list of them, and the restored server reads them from the same bucket, so leave the bucket as it is and keep its credentials valid. A Full + S3 backup, made with `./eigen backup --s3`, holds those files too. Restored with `--s3-from-archive`, it uploads them into the drive's bucket again, for a bucket that was lost or damaged.
