# Self-hosters first

The work list for the weeks before the open-source repository is announced. One question orders it: what does a stranger with a VPS or a NAS hit, in the order they hit it? Install, then update, then "is my data safe", then "do I have to run a mail server". Features they ask for after it runs come later. Designs live in the linked proposals; this file is the order, the scope cut, and the checkboxes. Tick a box when its "done when" holds, and delete a block when it is finished and recorded in its own doc.

## Ready to announce when

- A host with Docker and Compose, and nothing else, installs Eigen from a release bundle in one sitting and updates it with one command.
- CI proves that install and the upgrade from the previous release, on every release.
- The whole server backs itself up on a schedule, off the box if the admin wants, and a restore onto a fresh machine has been done for real once.
- "I do not want to host email" is an answer setup accepts, and the result is a complete product.
- The README, the setup guide, and an operating guide tell the truth about requirements, updates, breaking releases, and what pre-1.0 means for someone's data.

## 1. Install and update without host Bun

[PROPOSAL_DOCKER_ONLY_SETUP.md](proposals/PROPOSAL_DOCKER_ONLY_SETUP.md) milestone 1. Size M. Everything else in this file stands on it.

- [ ] `docker/frontend/Dockerfile`: builder stage plus one Caddy runtime image for both the `edge` and `static` web modes; the `./dist`, `./Caddyfile` and `docker/caddy/*` bind mounts go
- [ ] `.env.production` leaves the API image: `env_file` on `eigen-api`, the `--env-file` flag out of the `CMD`, `.dockerignore` stops allowing it, and starts ignoring `dist/` and `**/node_modules`
- [ ] One Bun pin: `ARG BUN_VERSION` in both Dockerfiles, fed from `.bun-version`
- [ ] `setup.sh`, the POSIX launcher: preflight, network snapshot, configurator in the API image, `data/` and `backups/` ownership, start and wait for healthy
- [ ] `setup.ts` seams: `EIGEN_DOCKER_NETWORKS`, no `chown`, flags for a non-interactive run, no printed host build steps; `generate-env.sh` becomes a wrapper
- [ ] `update.sh` in source mode builds through Docker, backfills env keys by rerunning `setup.ts`, and prunes only Eigen's own images
- [ ] `test-deployments.sh` builds through the same Dockerfiles and needs no host Bun
- [ ] eigen.is moves over with its ordinary update

Done when: a fresh install and an update succeed on a machine with Docker and Compose but no Bun, and every profile combination passes `docker/test-deployments.sh`.

## 2. Prebuilt images, a release bundle, and the release gate

Same proposal, milestone 2. Size M.

- [ ] Compose inverts: `docker-compose.yml` names images, `docker-compose.build.yml` adds the `build:` blocks
- [ ] A tag-triggered publish workflow pushes the four images to GitHub Container Registry, `linux/amd64`, with version and revision labels; Unbound pinned by digest
- [ ] `release.ts` attaches the bundle: Compose files, the four scripts, `docker/fail2ban/`, `.env.example`, a manifest with digests and the breaking flag, checksums
- [ ] `update.sh` release mode: fetch, verify, re-exec, pull, backfill, snapshot, up
- [ ] The release gate in CI: install the previous bundle, create a document, update to the new bundle, assert healthy and the document survives; then a fresh install
- [ ] A release flagged breaking stops `update.sh` for confirmation

Done when: install and update work from a bundle without Git or a build, one image digest serves two hostnames, and the gate is green on a real previous-to-new upgrade.

Open decision: the registry namespace and image names (`ghcr.io/eigen-is/eigen-api` and siblings is the default unless something argues against it).

## 3. Whole-server backup

[PROPOSAL_BACKUP_RESTORE.md](proposals/PROPOSAL_BACKUP_RESTORE.md) phase ③, the P1 row in [ROADMAP.md](ROADMAP.md). Size S–M; phase ② left every primitive generic for it. This, not more passes over per-home backup, is what a self-hoster means by "backups".

- [ ] The all-homes enumerator and the `server/` folder (`users3.db`, `eigen.db`, `waitlist.db`, `config.json`, `settings.json`, `avatars/`)
- [ ] A scheduled run with retention, configured in admin Settings
- [ ] Optional upload to a bucket that is not the one the data lives in; decide encryption at rest with it
- [ ] `update.sh` calls this instead of the offline `backup.sh`, which retires
- [ ] A restore drill: a fresh machine, the install from block 2, last night's archive, a known document and a known mailbox come back. Write down what was awkward and fix the guide
- [ ] [BACKUP.md](BACKUP.md) says out loud what stays the operator's job (`.env.production`, `caddy-data`, the Postfix queue)

Not in this block: phase ④ migration between servers, chunked artifact upload, the orphaned-bucket-object sweep. Their ROADMAP rows stand.

## 4. Eigen without hosted mail

The app side exists: `MAIL_ENABLED=0` hides every Mail entry point and the API authenticates to an external relay. Setup does not know about either, and a mail-off install made by hand points `SMTP_HOST` at a Postfix that is not there. Size S. Design in the Docker-only proposal § 5; it can land with block 1.

- [ ] `setup.ts` asks "Host email on this server?", writes the profile and `MAIL_ENABLED=0`, skips the mail DNS output, and asks for an outbound relay
- [ ] Both mail-off profile combinations join `test-deployments.sh`, with a notification delivered through a relay (Mailpit in the dev Compose)
- [ ] One audit pass over a mail-off server: what silently assumes a mailbox? Known: emailed calendar invitations and RSVPs cannot arrive. Fix what is small, document the rest
- [ ] The setup guide's mail-off section becomes a first-class path, not an alternative deployment

## 5. The documentation a stranger needs

Size S–M, mostly writing. Public text goes out in Reinder's voice.

- [ ] README quick start rewritten around the bundle; the Bun path moves under Development
- [ ] `docker/SETUP-GUIDE.md` rewritten for the launcher; it shrinks
- [ ] An operating guide: updating, breaking releases and the pre-1.0 data policy in plain words, backup and restore, moving to another machine, logs, where things live on disk, resetting an admin password. Decide where it lives (repository guide or help center; the ROADMAP help-center row has left this open)
- [ ] Requirements stated once: measured runtime memory, disk, `linux/amd64` only and why, Compose minimum, ports per profile
- [ ] Reverse-proxy recipes beyond the generated nginx, Apache and Caddy snippets: Traefik, and a tunnel with its shared rate-limit bucket caveat
- [ ] A short "what Eigen is not yet" section, so the first issue reports are not about things already known

## 6. Release hygiene

Size S.

- [ ] Every release has a version, a changelog entry, upgrade notes, and the breaking flag when it applies
- [ ] A secret scan over the full history and every published image layer before the announcement
- [ ] `SECURITY.md`, `CONTRIBUTING.md` and the issue templates read once more with a stranger's eyes; the bug template asks for version, profile set, and install mode

## Not now, and what would change that

| Item | Why it waits | Trigger |
|---|---|---|
| IMAP backend for mail hosted elsewhere ([proposal](proposals/PROPOSAL_EXTERNAL_MAIL_PROVIDER.md)) | Size L, depends on the SSO slice, and adds a second `MailStore` at the seam where bugs concentrate. Block 4 covers most of the need for a fraction of the cost. | Repeated requests from people running mail-off installs. |
| SSO ([proposal](proposals/PROPOSAL_SSO.md)) | Homelab users ask for OIDC after the thing runs, not before. | The first issues asking for Authentik, Keycloak or Authelia. Start with the `socialProviders` slice. |
| DSM preset (Docker-only milestone 3) | Needs real Synology hardware to be a support claim. | Hardware on the desk, or a tester with a listed model. |
| `linux/arm64` images | The resolver image is amd64-only and the native chain is untested on arm64. | A multi-arch resolver plus one real arm64 run. Expect this request early; Raspberry Pi and Ampere hosts are common. |
| Backup phase ④, Kubernetes or Helm, a GUI installer | None of them is on the path of a first install. | Demand. |
