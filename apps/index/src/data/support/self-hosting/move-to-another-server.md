---
title: "Move Eigen to another server"
description: "Make a Full backup on the old server, restore it on the new one with one line, and point your domain at it."
type: how-to
category: Maintenance
tags: [self-hosting, backup, restore, migrate, move]
related: [self-hosting/back-up-and-restore, self-hosting/install]
order: 100
updated: 2026-10-01
---

A Full backup holds the whole server, so moving is a backup on the old machine and a restore on the new one. Everyone keeps their account, mail, files, and settings, and stays signed in. Plan for some downtime: anything people change on the old server after the backup does not come along. To test a restore without moving, see [Try a restore without moving](/support/self-hosting/back-up-and-restore#try-a-restore-without-moving).

## 1. Make a backup on the old server

In the install folder, run `./eigen backup`, without `--light`: a Light backup leaves the files and the mail out. Then run `./eigen stop`, so nothing changes after the backup.

The backup is `backups/server-manual-full-<date>-<time>.tar`.

The old server is gone? Take last night's backup from your backup bucket instead, with the endpoint, bucket name, and keys you wrote down. The backups are in the folder `<prefix>/<your web address>/`, like `eigen/eigen.example.com/` (leave out `<prefix>/` if you set none). Take the newest `server-scheduled-…` backup that has no `.partial` file beside it: that one holds every user and team. With the AWS command line tool, for example:

```bash
export AWS_ACCESS_KEY_ID=<access key id> AWS_SECRET_ACCESS_KEY=<secret access key>
aws s3 ls --endpoint-url <endpoint> s3://<bucket>/<prefix>/<your web address>/
aws s3 cp --endpoint-url <endpoint> s3://<bucket>/<prefix>/<your web address>/server-scheduled-full-<date>-<time>.tar /root/
```

Run this on the new server. Then follow steps 2 and 3 without the `scp`, with the name of this backup in place of `server-manual-full-<date>-<time>.tar`.

Also copy what a backup leaves out that you want to keep, like `docker-compose.override.yml` and the older backups in `backups/`. See [what a backup leaves out](/support/self-hosting/back-up-and-restore#what-a-backup-leaves-out).

## 2. Copy the backup to the new server

Install Docker on the new server, as in step 1 of [Install Eigen on a server](/support/self-hosting/install), and open the same ports as on the old server ([Network ports](/support/self-hosting/requirements#network-ports)). Then copy the backup over, for example:

```bash
scp /opt/eigen/backups/server-manual-full-<date>-<time>.tar root@new-server:/root/
```

Eigen runs as user 1000 and must be able to read the backup. On the new server, give it the file:

```bash
sudo chown 1000:1000 /root/server-manual-full-<date>-<time>.tar
```

## 3. Restore it on the new server

On the new server, make an empty folder for Eigen and restore the backup into it:

```bash
mkdir -p /opt/eigen && cd /opt/eigen
curl -fsSL https://eigen.is/install | sh -s -- restore /root/server-manual-full-<date>-<time>.tar
```

There is no setup to run first. Eigen takes `.env.production` from the backup, with your setup answers in it, gets the version of Eigen that made the backup, restores everything, and starts. It asks before it restores, and `--yes` at the end skips that question.

The backup must hold `.env.production`, and the old server must have been installed with the one-line install. The restore says so and stops if not. On a new server where Eigen is already set up, run `./eigen restore /root/server-manual-full-<date>-<time>.tar` in its install folder instead. If Eigen does not start and says `pool overlaps with other one on this address space`, see [Fix common server problems](/support/self-hosting/troubleshooting#eigen-does-not-start-pool-overlaps).

## 4. Point your domain at the new server

Change the A record of your web address to the IP address of the new server. Hosting mail? Also set the reverse DNS of the new IP address at your hosting provider. The key that signs your mail comes with the backup, so the other mail records stay as they are. The restore says so before it asks. If it says the backup has no DKIM key, the new server makes a new one: add its record as in [Host your mail on Eigen](/support/self-hosting/host-your-mail#add-the-mail-dns-records).

Eigen's own web server gets a new HTTPS certificate by itself once the domain points at the new server. Behind your own web server, set up its certificate and the certbot hook for mail again, as in [Run Eigen behind your own web server](/support/self-hosting/behind-your-web-server). Check on everything with `./eigen status`, and send yourself a mail. The nightly backup and the backup bucket come along with the rest of the settings. Keep the old server stopped: both would back up into the same folder of the bucket, and delete each other's backups.

## Drives in an S3 bucket

A drive stored in an S3 bucket keeps its files in the bucket. A Full backup holds only the list of them, and the restored server reads them from the same bucket, so leave the bucket as it is and keep its credentials valid. A Full + S3 backup, made with `./eigen backup --s3`, holds those files too. Restored with `--s3-from-archive`, it uploads them into the drive's bucket again, for a bucket that was lost or damaged.
