# Self-hosters first

The work list for the weeks before the open-source repository is announced. One question orders it: what does a stranger with a VPS or a NAS hit, in the order they hit it? Install, then update, then "is my data safe", then "do I have to run a mail server". Designs live in the linked proposals; this file is the order, the scope cut, and the checkboxes. Delete a line once it is done, and a block once its "done when" holds and it is recorded in its own doc.

Done and recorded elsewhere: install, update and rollback without host Bun, prebuilt images with the bundle inside, the first tagged release through `publish.yml` (v0.3.0), eigen.is and demo.eigen.is as release installs on the `main` channel, mail-off setup with a relay in both modes, mail off as a first-class setup path, and release hygiene (upgrade notes, secret scan, `SECURITY.md`, issue templates, `CONTRIBUTING.md`).

## Ready to announce when

- CI proves the upgrade from the previous published release, on every release.
- The whole server backs itself up on a schedule, off the box if the admin wants, and a restore onto a fresh machine has been done for real once.
- The README, the setup guide, and an operating guide tell the truth about requirements, updates, breaking releases, and what pre-1.0 means for someone's data.

## 1. The release gate

[PROPOSAL_DOCKER_ONLY_SETUP.md](proposals/PROPOSAL_DOCKER_ONLY_SETUP.md) milestone 2. Today `docker/test-release.sh` builds its releases from the working tree into a registry of its own.

- [ ] The gate installs the previous published release, seeds it, updates to the new release, and rolls back

Done when: the gate is green on a real previous-to-new upgrade and its rollback.

## 2. Whole-server backup

[PROPOSAL_BACKUP_RESTORE.md](proposals/PROPOSAL_BACKUP_RESTORE.md) phase ③, the P1 row in [ROADMAP.md](ROADMAP.md). Size S–M; phase ② left every primitive generic for it. This, not more passes over per-home backup, is what a self-hoster means by "backups".

- [ ] The all-homes enumerator and the `server/` folder (`users3.db`, `eigen.db`, `waitlist.db`, `config.json`, `settings.json`, `avatars/`)
- [ ] A scheduled run with retention, configured in admin Settings
- [ ] Optional upload to a bucket that is not the one the data lives in, always encrypted: the archive holds `users3.db` and every mailbox
- [ ] Decide how `.env.production` survives the loss of the machine, because a restore without it does not work: in the encrypted archive, or setup makes the operator save it. The drill proves whichever it is
- [ ] `./eigen backup` runs it on demand and `./eigen update` calls it, replacing today's offline snapshot engine (`apps/api/src/cli/snapshot.ts`). `./eigen restore <archive>` restores the new archive onto an empty install
- [ ] A restore drill: a fresh machine, last night's archive, a known document and a known mailbox come back. Write down what was awkward and fix the guide
- [ ] [BACKUP.md](BACKUP.md) keeps saying what stays the operator's job (today `caddy-data`, the Postfix queue, `backups/` and `docker-compose.override.yml`) for the new archive

Not in this block: phase ④ migration between servers, chunked artifact upload, the orphaned-bucket-object sweep. Their ROADMAP rows stand.

## 3. The documentation a stranger needs

Size S–M, mostly writing. Public text goes out in Reinder's voice.

- [ ] An operating guide: updating, breaking releases and the pre-1.0 data policy in plain words, backup and restore, moving to another machine, logs, where things live on disk, resetting an admin password. Decide where it lives (repository guide or help center; the ROADMAP help-center row has left this open)
- [ ] Requirements stated once: measured runtime memory, disk, amd64 and arm64, Compose minimum, ports per profile
- [ ] A Traefik recipe beside the generated nginx, Apache and Caddy snippets and the tunnel section
- [ ] A short "what Eigen is not yet" section, so the first issue reports are not about things already known

## Not now, and what would change that

| Item | Why it waits | Trigger |
|---|---|---|
| IMAP backend for mail hosted elsewhere ([proposal](proposals/PROPOSAL_EXTERNAL_MAIL_PROVIDER.md)) | Size L, depends on the SSO slice, and adds a second `MailStore` at the seam where bugs concentrate. Mail off with a relay covers most of the need for a fraction of the cost. | Repeated requests from people running mail-off installs. |
| SSO ([proposal](proposals/PROPOSAL_SSO.md)) | Homelab users ask for OIDC after the thing runs, not before. | The first issues asking for Authentik, Keycloak or Authelia. Start with the `socialProviders` slice. |
| DSM preset (Docker-only milestone 3) | Needs real Synology hardware to be a support claim. | Hardware on the desk, or a tester with a listed model. |
| Backup phase ④, Kubernetes or Helm, a GUI installer | None of them is on the path of a first install. | Demand. |
