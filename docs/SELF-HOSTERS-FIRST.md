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
- [ ] `eigen`, the one command an operator learns: `eigen setup | update | backup | restore <archive> | reset-password <email> | status | logs`. Two layers, so the host needs nothing but Docker and Compose:
  - A small POSIX `sh` script on the host: no Bash, no GNU-only flags. It does the preflight, prints the `|eigen>` wordmark, and hands the command to the API image. Colour only on a terminal and without `NO_COLOR`. It stays thin, so an update can re-exec the new copy safely.
  - The interactive part runs in the API image as a Bun CLI (`docker run --rm -it <api-image> …`). The image is already on the machine, so prompts, spinners and summaries come from a library baked into the image (`@clack/prompts` or similar), and backup, restore and password reset reuse the API's own code instead of repeating it in shell. Every command also takes flags for a non-interactive run, for CI and `generate-env.sh`
- [ ] `eigen setup`: preflight, network snapshot, configurator in the API image, `data/` and `backups/` ownership, start and wait for healthy (the proposal's § 1)
- [ ] The first admin is not claimable by whoever finds the server first: today `/admin` runs the setup wizard for the first visitor, with no token. `eigen setup` creates the admin itself or prints a one-time setup link
- [ ] `eigen reset-password <email>`, a way back in for a locked-out admin. There is no self-service reset by email, and the Users admin page needs a second admin
- [ ] `setup.ts` seams: `EIGEN_DOCKER_NETWORKS`, no `chown`, flags for a non-interactive run, no printed host build steps; `generate-env.sh` becomes a wrapper
- [ ] `eigen update` replaces `update.sh`; in source mode it builds through Docker, backfills env keys by rerunning `setup.ts`, and prunes only Eigen's own images
- [ ] `test-deployments.sh` builds through the same Dockerfiles and needs no host Bun
- [ ] eigen.is moves over with its ordinary update

Done when: a fresh install and an update succeed on a machine with Docker and Compose but no Bun, and every profile combination passes `docker/test-deployments.sh`.

## 2. Prebuilt images, a release bundle, and the release gate

Same proposal, milestone 2. Size M.

- [ ] Compose inverts: `docker-compose.yml` names images, `docker-compose.build.yml` adds the `build:` blocks
- [ ] A tag-triggered publish workflow pushes the four images to GitHub Container Registry, `linux/amd64`, with version and revision labels; Unbound pinned by digest
- [ ] `release.ts` attaches the bundle: Compose files, the `eigen` launcher, `docker/fail2ban/`, `.env.example`, a manifest with digests and the breaking flag, checksums
- [ ] `eigen update` release mode: fetch, verify, re-exec, pull, backfill, snapshot, up
- [ ] The release gate in CI: install the previous bundle, seed it with the demo content, update to the new bundle, assert healthy and that a document, a sheet, a calendar event, a contact and a chat survive; then a fresh install
- [ ] A release flagged breaking stops `eigen update` for confirmation

Done when: install and update work from a bundle without Git or a build, one image digest serves two hostnames, and the gate is green on a real previous-to-new upgrade.

Open decision: the registry namespace and image names (`ghcr.io/eigen-is/eigen-api` and siblings is the default unless something argues against it).

## 3. Whole-server backup

[PROPOSAL_BACKUP_RESTORE.md](proposals/PROPOSAL_BACKUP_RESTORE.md) phase ③, the P1 row in [ROADMAP.md](ROADMAP.md). Size S–M; phase ② left every primitive generic for it. This, not more passes over per-home backup, is what a self-hoster means by "backups".

- [ ] The all-homes enumerator and the `server/` folder (`users3.db`, `eigen.db`, `waitlist.db`, `config.json`, `settings.json`, `avatars/`)
- [ ] A scheduled run with retention, configured in admin Settings
- [ ] Optional upload to a bucket that is not the one the data lives in, always encrypted: the archive holds `users3.db` and every mailbox
- [ ] Decide how `.env.production` survives the loss of the machine, because a restore without it does not work: in the encrypted archive, or setup makes the operator save it. The drill proves whichever it is
- [ ] `eigen backup` runs it on demand and `eigen update` calls it; the offline `backup.sh` retires. `eigen restore <archive>` restores the new archive onto an empty install and replaces `restore.sh`
- [ ] A restore drill: a fresh machine, the install from block 2, last night's archive, a known document and a known mailbox come back. Write down what was awkward and fix the guide
- [ ] [BACKUP.md](BACKUP.md) says out loud what stays the operator's job (`caddy-data`, the Postfix queue, and `.env.production` if the archive does not carry it)

Not in this block: phase ④ migration between servers, chunked artifact upload, the orphaned-bucket-object sweep. Their ROADMAP rows stand.

## 4. Mail: hosted, or not, and a relay either way

Two separate questions, and setup asks neither today. Does this server host mailboxes? And how does its outgoing mail leave? Size S. Design in the Docker-only proposal § 5; it can land with block 1.

Outgoing mail already works through a relay in both modes. With hosted mail, the bundled Postfix forwards through `SMTP_RELAY_HOST` and friends, which is the answer to a VPS that blocks port 25 and to receivers that distrust a fresh IP. Without hosted mail (`MAIL_ENABLED=0`, no `mail` profile), the API sends straight to an authenticated relay through `SMTP_HOST`, `SMTP_USER` and `SMTP_PASSWORD`. Both are documented in `docker/SETUP-GUIDE.md`, but you have to edit them into `.env.production` by hand, and a mail-off install made by hand still points `SMTP_HOST` at a Postfix that is not there.

Without any relay, a mail-off server quietly loses more than the Mail app. These all send email: two-factor codes sent by email, guest sign-in codes, share and access-request notifications, "email collaborators", waitlist invitations, and calendar invitations and RSVP replies. Only one thing needs hosted mail and cannot be fixed with a relay: replies from outside attendees to calendar invitations (iMIP) have no mailbox to arrive in.

The sender address is the other half. System mail always goes out as `noreply@` the mail domain (`defaultFrom()` in `apps/api/src/lib/core/mailer.ts`), with no setting to change it. Share emails, access requests, "email collaborators" and calendar invitations go out as the user's own address. On a mail-off server that address is usually at Gmail or an employer. A relay only accepts senders it has verified, and a receiver checking DMARC rejects a message from someone else's domain. So a self-hoster whose relay has verified `eigen@their-domain.nl` and nothing else can send nothing today.

- [ ] `eigen setup` asks "Host email on this server?" On "no" it writes the profile without `mail` and `MAIL_ENABLED=0`, and skips the mail DNS output
- [ ] `eigen setup` asks for an outbound relay in both modes, writing `SMTP_RELAY_*` for Postfix or `SMTP_*` for the API. Skipping it is allowed on a hosted-mail server. On a mail-off server, skipping it says plainly what stops working (the list above)
- [ ] A configurable system sender (`SMTP_FROM`, address and display name), defaulting to today's `noreply@` the mail domain. `eigen setup` asks for it together with the relay, and `defaultFrom()` reads it
- [ ] Mail sent on a user's behalf goes out from that system sender whenever the user's address is not on this server's mail domain: `From: "Alice via Eigen" <system sender>`, `Reply-To: Alice`. A mail-off server always takes this path. Calendar invitations keep Alice as `ORGANIZER`, so replies still reach her own mailbox
- [ ] Both mail-off profile combinations join `test-deployments.sh`, with a notification delivered through a relay (Mailpit in the dev Compose)
- [ ] One audit pass over a mail-off server for anything else that assumes a mailbox. Fix what is small, document the rest
- [ ] The setup guide's mail-off section becomes a first-class path, not an alternative deployment, and the relay moves out of "optional" into the main flow

## 5. The documentation a stranger needs

Size S–M, mostly writing. Public text goes out in Reinder's voice.

- [ ] README quick start rewritten around the bundle; the Bun path moves under Development
- [ ] `docker/SETUP-GUIDE.md` rewritten around `eigen`; it shrinks
- [ ] An operating guide: updating, breaking releases and the pre-1.0 data policy in plain words, backup and restore, moving to another machine, logs, where things live on disk, resetting an admin password. Decide where it lives (repository guide or help center; the ROADMAP help-center row has left this open)
- [ ] Requirements stated once: measured runtime memory, disk, `linux/amd64` only and why, Compose minimum, ports per profile
- [ ] Reverse-proxy recipes beyond the generated nginx, Apache and Caddy snippets: Traefik, and a tunnel with its shared rate-limit bucket caveat
- [ ] A short "what Eigen is not yet" section, so the first issue reports are not about things already known

## 6. Release hygiene

Size S.

- [ ] Every release has upgrade notes and the breaking flag when it applies; versions and `CHANGELOG.md` entries already exist
- [ ] A secret scan over the full history and every published image layer before the announcement
- [ ] `SECURITY.md` and the issue templates read once more with a stranger's eyes; the bug template asks for version, profile set, and install mode
- [ ] `CONTRIBUTING.md` written; it does not exist yet. It says plainly whether pull requests are welcome and what happens to them

## Not now, and what would change that

| Item | Why it waits | Trigger |
|---|---|---|
| IMAP backend for mail hosted elsewhere ([proposal](proposals/PROPOSAL_EXTERNAL_MAIL_PROVIDER.md)) | Size L, depends on the SSO slice, and adds a second `MailStore` at the seam where bugs concentrate. Block 4 covers most of the need for a fraction of the cost. | Repeated requests from people running mail-off installs. |
| SSO ([proposal](proposals/PROPOSAL_SSO.md)) | Homelab users ask for OIDC after the thing runs, not before. | The first issues asking for Authentik, Keycloak or Authelia. Start with the `socialProviders` slice. |
| DSM preset (Docker-only milestone 3) | Needs real Synology hardware to be a support claim. | Hardware on the desk, or a tester with a listed model. |
| `linux/arm64` images | The resolver image is amd64-only and the native chain is untested on arm64. Unbound only runs in the `mail` profile, so mail-off installs need just the arm64 run. | One real arm64 run of a mail-off install, then a multi-arch resolver for hosted mail. Expect this request early; Raspberry Pi and Ampere hosts are common. |
| Backup phase ④, Kubernetes or Helm, a GUI installer | None of them is on the path of a first install. | Demand. |
