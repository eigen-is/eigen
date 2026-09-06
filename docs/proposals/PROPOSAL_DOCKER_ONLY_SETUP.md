# Proposal: Docker-only installation, with a Synology DSM preset

> **Status — Proposal, written 2026-09-06, reviewed against the code 2026-09-06. Not started.** "DSM" means Synology DiskStation Manager. No Synology hardware was exercised; every statement about the current install path below was checked against the repository, and the resolver image's platform list against its live registry manifest.

> **TLDR**: Eigen can install without Bun on the host, and it should. Three changes, in order. (1) A POSIX `sh` launcher runs the existing `scripts/setup.ts` inside the API image and the frontend build moves into a Docker build stage, so a host needs only Docker and Compose. (2) CI publishes versioned images plus a small install bundle, so the ordinary self-hoster builds nothing. (3) DSM becomes a documented preset: today's `static` profile behind DSM's own reverse proxy, installed through Container Manager. Docker removes host dependencies, not NAS hardware limits or the networking a mail server needs, so full mail stays an explicit choice and the mail-free experience is a separate, smaller piece of work.

## Why

The [setup guide](../../docker/SETUP-GUIDE.md) says everything runs in Docker, yet install and update both need host-side Bun: `bun install`, a full frontend build, and `scripts/update.sh` re-running all of it. That is fine for a developer on a VPS. On a NAS it is the wrong shape: Container Manager is the supported way to run software there, and every fresh install currently compiles the whole monorepo on the target machine. The guide's `--sequential` build flag exists precisely because 2 to 4 GB machines run out of memory doing that.

Two improvements with different payoffs:

| Approach | What runs on the host | Benefit |
|---|---|---|
| Build inside Docker | Docker, temporary build containers, the Eigen services | No host Bun, Node, or compiler. Still burns local CPU, RAM, disk, and bandwidth on a build. |
| Pull prebuilt images | Docker and the Eigen services | No build, no dependency install. This should become the normal self-hosting path. |

Neither needs Docker-in-Docker, a privileged container, or the Docker socket mounted into anything. The host engine builds or pulls; Compose starts sibling containers.

## What the code does today

Checked on 2026-09-06. The two rows marked **fixed** were repaired as part of this review.

| Surface | Current behaviour | Consequence for this proposal |
|---|---|---|
| [`scripts/setup.ts`](../../scripts/setup.ts) | Node built-ins plus `Bun.spawn`, no third-party imports. Spawns host `docker network ls/inspect` for subnet detection and `chown -R 1000:1000 data`. | Runs unchanged inside any Bun container, without `bun install`. Only the two spawns need a seam. **Fixed:** it omitted `VITE_APP_VECTOR_URL`, so a fresh install built without a Vector link until the first `update.sh` backfilled it, and it printed a dead `buildfordocker` step (the image runs from source and `.dockerignore` drops `apps/api/build`). |
| [`scripts/generate-env.sh`](../../scripts/generate-env.sh) | A second, Bash-only generator of `.env.production`. | Two copies of the deployment rules already drift (the Vector gap above). Do not add a third; make this a thin wrapper. |
| [`docker/api/Dockerfile`](../../docker/api/Dockerfile) | `COPY . .`, `bun install --frozen-lockfile` in the image, `CMD bun run --env-file=../../.env.production src/index.ts`. | The backend never needed host Bun. The image bakes `.env.production` (allowed by `.dockerignore`), so every API image contains the deployment's relay password and cannot be shared between installs. |
| [`docker/static/Dockerfile`](../../docker/static/Dockerfile) and the `caddy` service in [`docker-compose.yml`](../../docker-compose.yml) | Static image copies a host-built `dist/`; edge Caddy bind-mounts host `./dist`, `./Caddyfile`, and `docker/caddy/*`. | Both web modes depend on a host build. Changing only the static Dockerfile leaves the default edge mode broken. |
| [`.dockerignore`](../../.dockerignore) | Excludes root `*.md` except `README.md`. | A frontend builder stage needs `CHANGELOG.md`; [`build-changelog.ts`](../../apps/index/scripts/build-changelog.ts) reads it. |
| [`packages/lib/src/core/api.ts`](../../packages/lib/src/core/api.ts) | `VITE_API_HOST` and every `VITE_APP_*_URL` are relative and resolved against `window.location.origin`. | One frontend bundle serves any hostname. Per-domain JavaScript builds are unnecessary. |
| [`apps/index/scripts/prerender.tsx`](../../apps/index/scripts/prerender.tsx) | Reads build-time `DOMAIN` for canonical, Open Graph, JSON-LD, and `sitemap.xml`; omits all of them when unset. | A domain-neutral release build is already supported by the prerenderer; it just loses SEO metadata. |
| API runtime env in [`docker-compose.yml`](../../docker-compose.yml) | Compose passes `DOMAIN`, `MAIL_DOMAIN`, `SMTP_HOST`, `TRUSTED_NETWORKS`, and a few more explicitly. `API_URL` and the `VITE_APP_*_URL`s that [`mail-template.ts`](../../apps/api/src/lib/core/mail-template.ts) uses for absolute links in outbound email come only from the baked file. | Removing the baked file needs `env_file: .env.production` on `eigen-api`, the same wiring the `caddy` service already has. |
| [`scripts/update.sh`](../../scripts/update.sh) | `git pull`, host `bun install`, host frontend build, `compose up --build`, then `docker image prune`. | A Bun-free install is pointless if the first update needs Bun again. The global prune would also delete a NAS user's unrelated images. |
| [`docker/static/Caddyfile`](../../docker/static/Caddyfile) | Overwrites `X-Real-IP` and `X-Forwarded-For` with its own peer address, and [`clientIpKey`](../../apps/api/src/lib/core/access.ts) trusts `X-Real-IP` unconditionally. | Behind any host proxy (nginx today, DSM tomorrow) every client shares one rate-limit bucket. Pre-existing, tracked in the [roadmap](../ROADMAP.md); not a blocker here. |
| [`mailer.ts`](../../apps/api/src/lib/core/mailer.ts) | The API's SMTP transport takes a host and port only; no authentication. `SMTP_RELAY_*` is read by [the bundled Postfix](../../docker/postfix/entrypoint.sh). | A relay such as Brevo works only through Postfix. **Fixed:** the guide claimed the API could use `SMTP_RELAY_*` directly. |
| [`docker-compose.host-certs.yml`](../../docker-compose.host-certs.yml) | Uses `!override`, which [needs Compose 2.24.4+](https://github.com/compose-spec/compose-spec/blob/main/13-merge.md#replace-value). | **Fixed:** the file and guide said 2.20+. The launcher must check the minimum of the files it actually passes. |
| Resolver image | `mvance/unbound:latest`; `docker manifest inspect` on 2026-09-06 lists `linux/amd64` only. | The full mail stack is not arm64-ready as shipped. |
| Release automation | [`check.yml`](../../.github/workflows/check.yml) runs checks; [`release.ts`](../../scripts/release.ts) creates a GitHub release. No image publishing. | Milestone 2 is new CI, not a documentation change. |

## Design

### 1. The launcher: `scripts/setup.sh`

Plain `sh`, no Bash, no GNU-only flags, no `sudo`, `apt`, `git`, or `curl` assumed. It orchestrates Docker; the questions and the config generation stay in `setup.ts`, which also keeps serving `bun run setup` for developers. The setup runner is the API image itself: it already contains Bun, the repository, and therefore `scripts/setup.ts`. No separate setup image.

1. **Preflight.** `docker info` (daemon reachable and the user may talk to it; membership of the `docker` group is a printed prerequisite, never fixed by loosening socket permissions), `docker compose version` against the minimum of the files about to be used, and the daemon's architecture. In the source phase the API image is built first with `docker compose build eigen-api`; in the release phase it is pulled. Then one probe before anything is written: `docker run --rm <api-image> bun --version`. That proves the pinned Bun binary starts on this kernel and CPU; a pull succeeding proves nothing.
2. **Network snapshot.** The launcher writes `docker network inspect $(docker network ls -q)` to a temporary file and mounts it read-only. `setup.ts` reads that file when `EIGEN_DOCKER_NETWORKS` is set and spawns `docker` as today when it is not. Subnet selection stays in TypeScript, including the rerun rule that never shifts a live deployment's subnet. A failed inspect aborts; it is not "no networks".
3. **Run the configurator.** `docker run --rm -i --user "$(id -u):$(id -g)" -v "$PWD:/config" -w /config <api-image> bun /app/scripts/setup.ts`, adding `-t` only when stdin is a terminal. Piped and flag-driven runs need no TTY. The written `.env.production` is owned by the invoking user with mode 0600. Nothing else from the host is mounted; the Docker socket never is.
4. **Data directory.** `mkdir -p data`. If it is empty, one root container sets its ownership: `docker run --rm -v "$PWD/data:/data" alpine chown 1000:1000 /data`, one directory, not recursive. Then a write test as `--user 1000:1000`. An existing, non-empty `data/` is never touched; the `chown -R` in `setup.ts` moves out into this step, since it cannot succeed inside a non-root container anyway. Never `chmod 777`, never recurse through a Synology shared folder.
5. **Start.** `docker compose --env-file .env.production up -d`, with the build overlay in the source phase, then wait for `eigen-api` to report healthy with a bounded timeout. Print the admin URL and the remaining proxy and DNS steps. On failure keep the configuration and print the failing service's logs without echoing secrets.

`generate-env.sh` becomes a wrapper that runs the same container non-interactively (`setup.ts` gains `--domain`, `--proxy`, and friends; it already handles piped stdin, flags are just sturdier). Its stdout contract stays. Reruns keep existing profiles, domains, relay credentials, subnet, and unknown advanced keys, which `setup.ts` already does by reading the previous file rather than sourcing it as shell.

### 2. Build in Docker

**Frontend.** A new `docker/frontend/Dockerfile` with two stages. The builder is a pinned `oven/bun` image: `bun install --frozen-lockfile`, then `bun run --sequential --filter './apps/*' build`, which keeps the index app's prebuild and postbuild steps (content, licenses, changelog, prerender, search index). The relative `VITE_API_HOST` and `VITE_APP_*_URL` values become `ARG` defaults in that Dockerfile, the one place that owns them; the `VITE_` lines in `.env.production` stop mattering to the frontend and remain only because the API reads them for email links. The runtime stage is `caddy:2-alpine` with `COPY --from=builder /app/dist /www`, both Caddyfiles, `autoconfig.xml`, and `export-certs.sh`. One image serves both web modes: the `caddy` and `eigen-static` services differ only in `command`, ports, and volumes. The `./dist`, `./Caddyfile`, and `docker/caddy/*` bind mounts go away; `caddy-data` and `data/certs` stay.

**API.** Runtime unchanged: Sharp/libvips, ExifTool, FFmpeg, WeasyPrint, the worker entry points, running from source. Two edits: drop `--env-file=../../.env.production` from the `CMD` and `!.env.production` from `.dockerignore`, and add `env_file: .env.production` to `eigen-api` in Compose. Secrets leave the image layers, one API image serves every install, and changing a domain or relay is a restart rather than a rebuild. Do not switch to `buildfordocker` output or prune dependencies as part of this change.

**Build context.** `.dockerignore` keeps excluding `data/`, `caddy-data/`, backups, and every private env file, and starts including `CHANGELOG.md`. Only public build settings are passed as build args; never a production env or an SMTP password.

**Domain-neutral builds.** Release images build without `DOMAIN`, so the landing page ships without canonical, Open Graph, JSON-LD, and `sitemap.xml`. That is the documented tradeoff for a portable image; a source build with `DOMAIN` set keeps them. If runtime SEO ever matters, generate those few tags at container start rather than rewriting compiled JavaScript.

### 3. Release images and an install bundle

A tag-triggered CI job builds with Buildx and pushes `eigen-api`, `eigen-frontend`, `eigen-postfix`, and `eigen-dovecot` under the release version. Unbound is pinned by digest, `linux/amd64` only, until a multi-arch resolver replaces it. Each image carries the release version and source revision as labels; the API already exposes `EIGEN_COMMIT` and `EIGEN_BUILT_AT` in the About dialog, so pass them as build args.

The Compose model inverts: `docker-compose.yml` references images, and a `docker-compose.build.yml` overlay adds the `build:` blocks for source installs. `scripts/release.ts` attaches a bundle: the Compose files, `setup.sh`, `update.sh`, `.env.example`, and checksums. A release install needs no Git, no Buildx, no registry login, and no source checkout. Images are published before the bundle is, and the bundle pins the digests it was tested with; nothing deploys a moving `latest`.

Start with `linux/amd64`. Add `linux/arm64` only after the resolver is replaced and the native dependency chain passes on real arm64 hardware. A multi-arch manifest is not evidence that a given Synology model can run it.

### 4. DSM is a preset, not a fork

Install Synology's Container Manager from Package Center; its [package page](https://www.synology.com/en-global/dsm/packages/ContainerManager) and [release notes](https://www.synology.com/en-global/releaseNote/ContainerManager) define the model and DSM requirements. Never run the VPS guide's `get.docker.com` script on DSM or install a second daemon over Synology's.

The preset is `COMPOSE_PROFILES=static` (or `static,mail`), `EIGEN_STATIC_HOST=127.0.0.1`, `EIGEN_STATIC_PORT=8080`, and DSM's reverse proxy in front. Installation after this proposal ships:

1. Download the release bundle and extract it into a folder such as `/volume1/docker/eigen` (an example, not a requirement).
2. Over SSH, run `./setup.sh`. It asks the same questions `bun run setup` asks today.
3. In DSM, Control Panel > Login Portal > Advanced > Reverse Proxy: terminate HTTPS for the Eigen hostname and forward to `http://127.0.0.1:8080`, with the WebSocket custom headers Synology documents in its [reverse proxy help](https://kb.synology.com/en-global/DSM/help/DSM/AdminCenter/system_login_portal_advanced?version=7) and a long proxy timeout, since collaborative editing and SSE hold connections open.
4. Open `https://<hostname>/admin` and create the organisation and administrator.

The API stays private on the Docker network. DSM proxies to `eigen-static`, never to port 8000: the static gateway serves the apps and owns the API prefix routing, DAV discovery, streaming, and the internal-route 404s. A proxy running in another container cannot reach the host's `127.0.0.1`; the guide's existing shared-network recipe applies unchanged.

A Container Manager Project (GUI) path is worth offering, but only after it has been exercised in the real DSM interface: `env_file` interpolation and the ownership step must be verified there, not assumed. The shell path is the supported contract in the first release.

### 5. Mail is a choice, not a surprise

Public email hosting must not be a hidden prerequisite for someone who wants Drive, Docs, Sheets, Calendar, Contacts, and Chat on a NAS.

| Preset | Services | Intended use |
|---|---|---|
| DSM or existing HTTPS proxy | API + static frontend | Simple NAS mode. Honest today only with the warning below. |
| Full workspace behind an existing proxy | API + static frontend + Postfix + Dovecot + Unbound | Users who deliberately operate Eigen mail on the NAS. |
| Standalone VPS | API + edge Caddy + Postfix + Dovecot + Unbound | Today's default, unchanged. |

Two gaps stand between the first row and a finished experience, and both are separate work items so they do not block the build change: the Mail tab still appears when hosted mail is off, and the API's outbound transport cannot authenticate to an external relay. Until they ship, the installer offers the existing profiles with an explicit warning, not a supposedly complete "mail-free" mode.

Full mail on a NAS additionally needs inbound port 25, a PTR record, submission and IMAP ports that a Synology Mail Server package may already own, and valid certificates for the hostname mail clients use. Without edge Caddy the certificate exporter does not run, and DSM's certificate store is not `/etc/letsencrypt/live`, so the host-certs overlay is a starting point rather than a DSM answer. An HTTP reverse proxy or tunnel carries none of this.

## Compatibility: what can and cannot be promised

A container shares the host kernel; it does not add CPU instructions or upgrade an old NAS kernel, and a successful pull is not a compatibility check. The Bun `--version` probe in the launcher is the cheap first gate; the acceptance checks below cover the native chain and workers.

The release documentation records the tested DSM, Container Manager, and Compose versions, the model and CPU, kernel, and RAM, and the supported profiles. No 32-bit ARM. Bun's [installation docs](https://bun.com/docs/installation) list Linux x64 (SSE4.2 required) and arm64 and recommend kernel 5.6+; those are Bun's claims, and every native dependency has its own. CPU emulation is never the recommended workaround.

Compose minimums are per file: the base stack needs the 2.20+ the guide states, the host-certs overlay needs 2.24.4+. Synology's first Container Manager shipped Compose 2.5.1 and later releases added the `docker compose` spelling; the launcher checks the real version rather than inferring it from the package version, and optional overlays must not raise the minimum for the basic preset.

Ports 80 and 443 belong to DSM's own web services ([Synology's port list](https://kb.synology.com/en-global/DSM/tutorial/What_network_ports_are_used_by_Synology_services)). That is why the preset reuses DSM's reverse proxy instead of running edge Caddy, and why the installer never stops Synology services or edits DSM-managed webserver configuration.

Publish measured runtime memory and peak build memory separately. The guide's "2 GB+ RAM" is a VPS figure for running the stack, not a promise that a NAS can compile it, which is the strongest argument for prebuilt images.

## Updates and recovery

`update.sh` gains a release mode: download the matching bundle, verify checksums, `docker compose pull` everything first, run `scripts/snapshot.sh`, then `docker compose up -d` with the same project name and data locations. No `git pull`, no `bun install`, no host build, and no `docker image prune`. Source mode keeps working through the build overlay. The API's 30 s `stop_grace_period` and upload drain stay as they are.

[`snapshot.sh`](../../scripts/snapshot.sh) archives `data/` and `.env.production` after stopping the API. `caddy-data`, the `postfix-queue` volume, and `data/certs` are outside it, and Postfix and Dovecot keep writing while it runs. Whole-stack recovery is the [backup proposal's](PROPOSAL_BACKUP_RESTORE.md) job; this proposal only requires that the update path calls the snapshot and that a rollback keeps the prior release's bundle and snapshot together, because rolling images back after a schema migration is not safe on its own.

## Delivery plan

| Milestone | Deliverable | Done when |
|---|---|---|
| 1. No host Bun | `setup.sh`, the network and ownership seams in `setup.ts`, the frontend Dockerfile for both web modes, runtime-only `.env.production`, `update.sh` source mode through the build overlay | A fresh install and an update succeed on a host with Docker and Compose but no Bun, Node, or `dist/`. All four existing profile combinations still pass `docker/test-deployments.sh`. |
| 2. No local build | CI image publishing, image-based Compose with the build overlay, domain-neutral frontend build, checksummed bundle attached by `release.ts` | Install and update from a bundle without Git, a compiler, or `docker build`. The same image digests serve two differently configured hostnames. |
| 3. DSM supported | Compatibility matrix, DSM proxy instructions, tested Project path, the two mail follow-ups shipped or explicitly warned about, certificate guidance for full mail on DSM | A real, listed Synology model completes setup, reboot, update, and restore; the documented proxy and mail choices behave as described. |

Milestone 1 answers the Bun objection. Milestone 2 is the real simplification. Milestone 3 turns "probably works in Docker" into a support claim.

## Acceptance checks

Extend [`test-deployments.sh`](../../docker/test-deployments.sh), [`test-host-proxies.sh`](../../docker/test-host-proxies.sh), and [`test-mail-hardening.sh`](../../docker/test-mail-hardening.sh) rather than starting a second harness. They start and stop Compose projects, so they run in isolated projects and data directories, never against a real install.

| Area | Evidence |
|---|---|
| Clean build | From a clean checkout with no `node_modules`, `dist/`, or `.env.production`: every app serves its own bundle, index content and search work, native tools and workers run. A release install performs no build. |
| Configuration | Interactive, piped, and flag-driven runs; aborted input; rerun preserves everything; custom subnets and ports; paths with spaces; credentials with quotes and `$`; file mode 0600; no container sees the Docker socket. |
| Portable artifacts | One image digest on two hostnames: auth cookies, API, WebSocket, SSE, and app links all work; SEO metadata is absent by design; no secret or private file in any layer or bundle. |
| DSM | Listed hardware, real Compose version, bind mounts writable as 1000:1000 under Synology ACLs, survives reboot, port and network collisions detected, unsupported device fails before any data is written. |
| Real use | Admin enrolment, sign-in, upload and download, two-browser collaborative editing, notifications, previews and exports, DAV through the proxy. |
| Mail | Simple preset shows the warning; full preset passes inbound, outbound, IMAP, submission, TLS, and a renewal reload. |
| Operations | A failed pull leaves the running stack intact; a half-finished setup reruns cleanly; upgrade keeps data and config; restore brings back a known document and, where enabled, mail. |

Run `bun run check` for the implementation changes and publish the hardware results with the release. CI on a current Linux VM cannot stand in for an older DSM kernel.

## Out of scope

- Hiding the Mail tab when hosted mail is off, and an authenticated external SMTP transport for notifications. Both are small, both are prerequisites for calling the simple preset finished, and both are tracked as their own roadmap items.
- Whole-stack backup coverage ([backup proposal](PROPOSAL_BACKUP_RESTORE.md)).
- `linux/arm64` images.
- A GUI-only DSM install; the shell launcher is the first contract.
- Runtime SEO metadata for domain-neutral images.

## Recommendation

Do it, in the stated order. Milestones 1 and 2 are moderate effort, mostly Dockerfile and shell work over code that already runs from source, and they benefit every self-hoster, not just Synology owners. Keep one set of services and one Compose model; DSM is a preset on top. Treat the NAS's proxy, its hardware, and mail hosting as explicit choices made during setup, never as assumptions.
