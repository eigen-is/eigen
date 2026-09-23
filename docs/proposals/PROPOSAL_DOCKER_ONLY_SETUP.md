# Proposal: Docker-only installation, with a Synology DSM preset

> **Status — Proposal, reviewed against the code 2026-09-21. Not started.** "DSM" means Synology DiskStation Manager. No Synology hardware was exercised; every statement about the current install path below was checked against the repository, and the resolver image's platform list against its live registry manifest (2026-09-06). Milestones 1 and 2 are blocks 1 and 2 of [SELF-HOSTERS-FIRST.md](../SELF-HOSTERS-FIRST.md).

> **TLDR**: Eigen can install without Bun on the host, and it should. Three changes, in order. (1) One command, `eigen`: a POSIX `sh` launcher that hands every subcommand to a Bun CLI inside the API image, while the frontend build moves into a Docker build stage, so a host needs only Docker and Compose. (2) CI publishes versioned images, the API image carries the install bundle, so the ordinary self-hoster builds nothing, and a CI job installs, upgrades and rolls back from those images on every release. (3) DSM becomes a documented preset: today's `static` profile behind DSM's own reverse proxy, installed through Container Manager. Docker removes host dependencies, not NAS hardware limits or the networking a mail server needs, so full mail is a question setup asks, and the answer "no" produces a working mail-off install.

## Why

The [setup guide](../../docker/SETUP-GUIDE.md) says everything runs in Docker, yet install and update both need host-side Bun: `bun install`, a full frontend build, and `scripts/update.sh` re-running all of it. That is fine for a developer on a VPS. On a NAS it is the wrong shape: Container Manager is the supported way to run software there, and every fresh install currently compiles the whole monorepo on the target machine. The guide's `--sequential` build flag exists precisely because 2 to 4 GB machines run out of memory doing that.

Two improvements with different payoffs:

| Approach | What runs on the host | Benefit |
|---|---|---|
| Build inside Docker | Docker, temporary build containers, the Eigen services | No host Bun, Node, or compiler. Still burns local CPU, RAM, disk, and bandwidth on a build. |
| Pull prebuilt images | Docker and the Eigen services | No build, no dependency install. This should become the normal self-hosting path. |

Neither needs Docker-in-Docker, a privileged container, or the Docker socket mounted into anything. The host engine builds or pulls; Compose starts sibling containers.

## What the code does today

| Surface | Current behavior | Consequence for this proposal |
|---|---|---|
| [`scripts/setup.ts`](../../scripts/setup.ts) | Node built-ins plus `Bun.spawn`, no third-party imports. Spawns host `docker network ls/inspect` for subnet detection and `chown -R 1000:1000 data`. Its "next steps" print a host `bun install` and frontend build. | Runs unchanged inside any Bun container, without `bun install`. Only the two spawns and the printed steps need a seam. |
| `setup.ts`, deployment shape | Always writes `COMPOSE_PROFILES=edge,mail` or `static,mail`. It never asks whether to host mail, never writes `MAIL_ENABLED`, and never writes the API's `SMTP_*` relay keys. | A mail-off install is hand-edited today ([setup guide § mail off](../../docker/SETUP-GUIDE.md)). With the `mail` profile off and nothing else set, `SMTP_HOST` still defaults to `postfix`, a host that does not exist, so share notifications and invites fail. Setup has to own this choice (§ 5). |
| [`scripts/generate-env.sh`](../../scripts/generate-env.sh) | A second, Bash-only generator of `.env.production`, listing every `VITE_APP_*_URL` again. | Two copies of the deployment rules that must be edited together. Do not add a third; make this a thin wrapper. |
| [`docker/api/Dockerfile`](../../docker/api/Dockerfile) | `FROM oven/bun:1.3.14-slim`, `COPY . .`, `bun install --frozen-lockfile --ignore-scripts` in the image, `CMD bun run --env-file=../../.env.production src/index.ts`. | The backend never needed host Bun. The image bakes `.env.production` (allowed by `.dockerignore`), so every API image contains the deployment's relay password and cannot be shared between installs. The Bun pin is a third copy of `.bun-version` (CI reads the file; the Dockerfile repeats it). |
| [`docker/static/Dockerfile`](../../docker/static/Dockerfile) and the `caddy` service in [`docker-compose.yml`](../../docker-compose.yml) | Static image copies a host-built `dist/`; edge Caddy bind-mounts host `./dist`, `./Caddyfile`, and `docker/caddy/*`. | Both web modes depend on a host build. Changing only the static Dockerfile leaves the default edge mode broken. |
| API volumes in `docker-compose.yml` | Bind-mounts `./data` and `./backups`; the API runs as `1000:1000`. Docker creates a missing mount point as root. | The launcher prepares both folders, not only `data/`. `update.sh` creates `backups/` for existing installs today. |
| [`.dockerignore`](../../.dockerignore) | Excludes root `*.md` except `README.md`. Ignores `node_modules` at the root only, and does not ignore `dist/`. | A frontend builder stage needs `CHANGELOG.md`; [`build-changelog.ts`](../../apps/index/scripts/build-changelog.ts) reads it. Once nothing copies a host `dist/`, ignore it, and ignore `**/node_modules` so a developer's workspace installs never enter the context. |
| [`packages/lib/src/core/api.ts`](../../packages/lib/src/core/api.ts) | `VITE_API_HOST` and every `VITE_APP_*_URL` are relative and resolved against `window.location.origin`. | One frontend bundle serves any hostname. Per-domain JavaScript builds are unnecessary. |
| [`vite.security-headers.ts`](../../vite.security-headers.ts) | The Content-Security-Policy is a `<meta>` in every app shell, computed at build time; in a production build everything is `'self'`. | The policy travels inside the bundle and names no hostname, so it is portable too. |
| [`apps/index/scripts/prerender.tsx`](../../apps/index/scripts/prerender.tsx) | Reads build-time `DOMAIN` for canonical, Open Graph, JSON-LD, and `sitemap.xml`; omits all of them when unset. | A domain-neutral release build is already supported by the prerenderer; it just loses SEO metadata. |
| API runtime env in [`docker-compose.yml`](../../docker-compose.yml) | Compose passes `DOMAIN`, `MAIL_DOMAIN`, `MAIL_ENABLED`, `SMTP_*`, `TRUSTED_NETWORKS`, and a few more explicitly. `API_URL` and the `VITE_APP_*_URL`s that [`mail-template.ts`](../../apps/api/src/lib/core/mail-template.ts) uses for absolute links in outbound email come only from the baked file. | Removing the baked file needs `env_file: .env.production` on `eigen-api`, the same wiring the `caddy` service already has. |
| [`scripts/update.sh`](../../scripts/update.sh) | Bash. `git pull`, re-exec of the freshly pulled script, `add_var_if_missing` backfills into `.env.production`, creates `backups/`, wipes every `node_modules`, host `bun install`, host frontend build, `compose up --build`, a Caddy config reload, a fail2ban filter refresh and jail reload, then `docker builder prune` and `docker image prune`. | A Bun-free install is pointless if the first update needs Bun again. The env backfills are a third copy of the env rules. The global image prune would also delete a NAS user's unrelated dangling images. The re-exec and the fail2ban reload are worth keeping. |
| [`docker/static/Caddyfile`](../../docker/static/Caddyfile) | Trusts `X-Real-IP` from private-range peers (`trusted_proxies` + `client_ip_headers`) and forwards `{client_ip}`, so [`clientIpKey`](../../apps/api/src/lib/core/access.ts) sees the real visitor behind a host proxy. `X-Forwarded-For` alone is not trusted; the generated nginx, Apache and Caddy snippets all set `X-Real-IP`. | A host proxy that sets only `X-Forwarded-For` degrades to one shared rate-limit bucket. Not a blocker here. |
| Mail off | `MAIL_ENABLED=0` hides the Mail app and every entry point to it ([SERVER-SETTINGS.md § Mail environment](../SERVER-SETTINGS.md#mail-environment)). [`mailer.ts`](../../apps/api/src/lib/core/mailer.ts) authenticates to an external relay when `SMTP_USER` and `SMTP_PASSWORD` are set, with mandatory STARTTLS and a verified certificate. `SMTP_RELAY_*` is a separate pair read by [the bundled Postfix](../../docker/postfix/entrypoint.sh). | The app side of a mail-off install exists. What is missing is setup asking for it and one audit of what degrades without inbound mail (emailed calendar invitations and RSVPs). |
| [`docker-compose.host-certs.yml`](../../docker-compose.host-certs.yml) | Uses `!override`, which [needs Compose 2.24.4+](https://github.com/compose-spec/compose-spec/blob/main/13-merge.md#replace-value). | The launcher must check the minimum of the files it actually passes. |
| [`docker/test-deployments.sh`](../../docker/test-deployments.sh) | Needs host Bun: `ensure_dist` runs `bun install` and the frontend build when `dist/` is missing, then builds `eigen-static` from it. | The harness moves with the change: it builds through the same Dockerfiles and loses its Bun prerequisite. |
| [`routes/setup.ts`](../../apps/api/src/routes/setup.ts) | `/admin` runs the setup wizard for the first visitor, with no token. Before setup, `/setup/s3check` and `/setup/s3harden` are open to anyone and make the server call any S3 endpoint. | The first admin needs a one-time setup link that gates all three `/setup/*` routes (§ 1). |
| Resolver image | `mvance/unbound:latest`; `docker manifest inspect` on 2026-09-06 lists `linux/amd64` only. | The full mail stack is not arm64-ready as shipped. |
| Release automation | [`check.yml`](../../.github/workflows/check.yml) runs checks with a read-only token; [`release.ts`](../../scripts/release.ts) creates a GitHub release with notes and no assets. No image publishing. | Milestone 2 is new CI, not a documentation change. |

## Design

### 1. The launcher: `eigen`

The operator learns one command, `eigen`: `setup`, `update`, `rollback`, `backup`, `restore <archive>`, `reset-password <email>`, `status` and `logs`. It has two layers. On the host, a thin POSIX `sh` launcher does the preflight and hands the command to the API image. Everything else is a Bun CLI in `apps/api/src/cli/`, next to the code it reuses, so backup, restore and password reset call the API's own code instead of repeating it in shell. `scripts/setup.ts` moves into that CLI or is imported from it, and `bun run setup` keeps working for developers. There is no separate setup image: the API image already contains Bun and the CLI.

The launcher is plain `sh`, tested under `dash` and BusyBox `sh`: no Bash, no GNU-only flags, no `sudo`, `apt`, or `curl` assumed, and `git` only in source mode. It stays thin, so an update can re-exec the new copy safely.

**Online and offline commands.** The backup job map lives in memory in the API process, with the 409 guard, the restore's offline gate and the shutdown drain. A second process running the API's code would bypass all of it. So online commands (`status`, `reset-password`, and `backup` once whole-server backup lands) run through `docker compose exec eigen-api` and talk to the running API over a Unix socket in `data/server/`, mode 0600, owned by the API user. No token and no TCP port. Offline commands (the first `setup`, before the stack exists, and `restore` onto a stopped stack) run through `docker compose run --rm` and write under `data/` as `1000:1000`. `reset-password` also revokes the user's sessions.

**The setup link.** `eigen setup` generates a one-time token, stores only its hash under `data/server/`, and prints `https://<host>/admin?setup=<token>`. The web wizard keeps its job: organization, administrator, storage type, and the S3 check and harden. The token gates `/setup/complete`, `/setup/s3check` and `/setup/s3harden`, so nobody who merely finds a fresh server can claim it or point it at an S3 endpoint. While setup is pending, `eigen setup` prints a fresh link.

**Terminal UI.** Setup, update, rollback, restore and reset-password are linear flows built with `@clack/prompts`. `eigen status` is a one-shot report, not a full-screen interface: version and pending update, health per service, disk use, the last snapshot and its age, certificate expiry, and the mail queue. The `sh` layer prints only the `|eigen>` wordmark and the preflight lines, so the operator sees one program. The look is clack's style with one accent color and no emoji. Long steps are spinners that hide their output unless the step fails, and then show its last lines. Each flow ends with a summary holding the URL and the next steps, and every error says what to do next. Every command also takes flags for a non-interactive run, and a flag-driven or non-TTY run never touches clack. Every interactive `docker run` gets `--init` (Bun as PID 1 ignores Ctrl-C), passes `TERM` and `NO_COLOR`, adds `-t` only when stdin is a terminal, and sets `HOME=/tmp` under an arbitrary `--user`.

**Source mode.** A Git checkout with the build overlay present (`.git` plus `docker-compose.build.yml`) is a source install. There the launcher and Compose files come from the checkout, not from the image, and the images are built through the overlay with no host Bun. eigen.is runs this way and deploys from `main`.

**Snapshots.** Until whole-server backup lands ([SELF-HOSTERS-FIRST.md](../SELF-HOSTERS-FIRST.md) block 3), `eigen backup`, the update snapshot and `eigen restore` are the offline stop-and-archive of today's `backup.sh` and `restore.sh`: `data/` plus `.env.production`. They run inside a container, so file ownership never depends on the host user. The archive records the Eigen version, and a restore refuses an archive newer than the install. Block 3 swaps the engine without changing the command.

`eigen setup` runs these steps:

1. **Preflight.** `docker info` (daemon reachable and the user may talk to it; membership of the `docker` group is a printed prerequisite, never fixed by loosening socket permissions), `docker compose version` against the minimum of the files about to be used, and the daemon's architecture. In source mode the API image is built first with `docker compose build eigen-api`; in release mode `bootstrap` has already pulled it. Then one probe before anything is written: `docker run --rm <api-image> bun --version`. That proves the pinned Bun binary starts on this kernel and CPU; a pull succeeding proves nothing.
2. **Network snapshot.** The launcher writes `docker network inspect $(docker network ls -q)` to a temporary file and mounts it read-only. `setup.ts` reads that file when `EIGEN_DOCKER_NETWORKS` is set and spawns `docker` as today when it is not. Subnet selection stays in TypeScript, including the rerun rule that never shifts a live deployment's subnet. A failed inspect aborts; it is not "no networks".
3. **Run the configurator.** The CLI's setup runs in the API image with the install folder mounted at `/config` and `--user "$(id -u):$(id -g)"`, adding `-t` only when stdin is a terminal. Piped and flag-driven runs need no TTY. The written `.env.production` is owned by the invoking user with mode 0600. Nothing else from the host is mounted; the Docker socket never is.
4. **Data and backup directories.** `mkdir -p data backups`. For each one that is empty, one root container sets its ownership: `docker run --rm -v "$PWD/data:/data" alpine chown 1000:1000 /data`, one directory, not recursive. Then a write test as `--user 1000:1000`. An existing, non-empty folder is never touched; the `chown -R` in `setup.ts` moves out into this step, since it cannot succeed inside a non-root container anyway. Never `chmod 777`, never recurse through a Synology shared folder.
5. **Start.** `docker compose --env-file .env.production up -d`, with the build overlay in source mode, then wait for `eigen-api` to report healthy with a bounded timeout. Print the one-time setup link and the remaining proxy and DNS steps. On failure keep the configuration and print the failing service's logs without echoing secrets.

`setup.ts` stops printing build commands; when `EIGEN_DOCKER_NETWORKS` is set the launcher owns the next steps, and `bun run setup` on a developer machine points at `eigen setup`.

`generate-env.sh` becomes a wrapper that runs the same container non-interactively (`setup.ts` gains `--domain`, `--proxy`, `--no-mail`, and friends; it already handles piped stdin, flags are just sturdier). Its stdout contract stays. Reruns keep existing profiles, domains, relay credentials, subnet, and unknown advanced keys, which `setup.ts` already does by reading the previous file rather than sourcing it as shell. That rerun is also how an update backfills new keys (§ Updates and recovery), so the key list lives in `setup.ts` and nowhere else.

### 2. Build in Docker

**Frontend.** A new `docker/frontend/Dockerfile` with two stages. The builder is a pinned `oven/bun` image: `bun install --frozen-lockfile`, then `bun run --sequential --filter './apps/*' build`, which keeps the index app's prebuild and postbuild steps (content, licenses, changelog, prerender, search index). The relative `VITE_API_HOST` and `VITE_APP_*_URL` values become `ARG` defaults in that Dockerfile, the one place that owns them for the frontend; the `VITE_` lines in `.env.production` stop mattering to the frontend and remain only because the API reads them for email links. The runtime stage is `caddy:2-alpine` with `COPY --from=builder /app/dist /www`, both Caddyfiles, `autoconfig.xml`, and `export-certs.sh`. One image serves both web modes: the `caddy` and `eigen-static` services differ only in `command`, ports, and volumes. The `./dist`, `./Caddyfile`, and `docker/caddy/*` bind mounts go away; `caddy-data` and `data/certs` stay. An admin who edited the bind-mounted `Caddyfile` loses that edit, so the guide names the supported route: a Compose override that mounts their own file.

A build inside a fresh layer always installs from an empty `node_modules`, which is what `update.sh` wipes the host tree to get today.

**API.** Runtime unchanged: Sharp/libvips, ExifTool, FFmpeg, WeasyPrint, the worker entry points, running from source. Two edits: drop `--env-file=../../.env.production` from the `CMD` and `!.env.production` from `.dockerignore`, and add `env_file: .env.production` to `eigen-api` in Compose. Secrets leave the image layers, one API image serves every install, and changing a domain or relay is a restart rather than a rebuild. `env_file` hands the API every key in the file, including Postfix's `SMTP_RELAY_PASSWORD`, which the API does not read; the `caddy` service has the same exposure today, and the alternative is re-listing fourteen `VITE_APP_*_URL` keys under `environment:`. Accept it. Do not switch to `buildfordocker` output or prune dependencies as part of this change.

**One Bun pin.** Both Dockerfiles take `ARG BUN_VERSION` with no default. The build overlay passes `${BUN_VERSION}`, which the launcher, the test harness, and CI read from `.bun-version`. The file stays the single source.

**Build context.** `.dockerignore` keeps excluding `data/`, `caddy-data/`, backups, and every private env file, starts excluding `dist/` and `**/node_modules`, and starts including `CHANGELOG.md`. Both Dockerfiles copy `package.json`, the workspace manifests and `bun.lock` before the source, so the install layer stays cached when dependencies did not change. Only public build settings are passed as build args; never a production env or an SMTP password.

**Domain-neutral builds.** Release images build without `DOMAIN`, so the landing page ships without canonical, Open Graph, JSON-LD, and `sitemap.xml`. That is the documented tradeoff for a portable image; a source build with `DOMAIN` set keeps them. If runtime SEO ever matters, generate those few tags at container start rather than rewriting compiled JavaScript.

### 3. Release images, with the install bundle inside

A tag-triggered workflow, separate from `check.yml` so the check job keeps its read-only token, builds with Buildx and pushes `eigen-api`, `eigen-frontend`, `eigen-postfix`, and `eigen-dovecot` to GitHub Container Registry under the release version (`packages: write` on that job only; the packages are made public once, by hand). Unbound is pinned by digest, `linux/amd64` only, until a multi-arch resolver replaces it. Each image carries the release version and source revision as OCI labels; the API already exposes `EIGEN_COMMIT` and `EIGEN_BUILT_AT` in the About dialog, so pass them as build args.

The Compose model inverts: `docker-compose.yml` references images, and a `docker-compose.build.yml` overlay adds the `build:` blocks for source installs. The API image carries the install bundle: the `eigen` launcher, the Compose files, `docker/fail2ban/`, `.env.example`, and a small manifest (version, the sibling images' digests, whether the release breaks a persisted format). A release install starts in an empty folder with one command, `docker run --rm -v "$PWD:/out" ghcr.io/eigen-is/eigen-api:<version> bootstrap`, which writes the bundle, and then `./eigen setup`. It needs no Git, no Buildx, no registry login, no source checkout, and no `curl`. Digest pinning carries integrity: every image runs by digest, and nothing deploys a moving `latest`. The host never downloads a tarball or computes a checksum, because SHA-256 tools differ across Linux, macOS and BusyBox. `release.ts` may attach the same files to the GitHub release for reading; nothing installs from them.

**The release gate.** Before a version is published as a release, a CI job runs on a clean runner with Docker and no Bun: bootstrap the previous release non-interactively, seed it with a document, a sheet, a calendar event, a contact and a chat, run `eigen update` to the new version, and assert the stack is healthy and every item is intact. Then `eigen rollback`, and the same assertions. Then a fresh install of the new version alone. An update that breaks is worse for a self-hoster than a missing feature, and the env-backfill breakages show the class recurs; this is the test that would have caught them.

Start with `linux/amd64`. Add `linux/arm64` only after the resolver is replaced and the native dependency chain passes on real arm64 hardware. A multi-arch manifest is not evidence that a given Synology model can run it.

### 4. DSM is a preset, not a fork

Install Synology's Container Manager from Package Center; its [package page](https://www.synology.com/en-global/dsm/packages/ContainerManager) and [release notes](https://www.synology.com/en-global/releaseNote/ContainerManager) define the model and DSM requirements. Never run the VPS guide's `get.docker.com` script on DSM or install a second daemon over Synology's.

The preset is `COMPOSE_PROFILES=static` (or `static,mail`), `EIGEN_STATIC_HOST=127.0.0.1`, `EIGEN_STATIC_PORT=8080`, and DSM's reverse proxy in front. Installation after this proposal ships:

1. Over SSH, in a folder such as `/volume1/docker/eigen` (an example, not a requirement), run the `bootstrap` command from § 3.
2. Run `./eigen setup`. It asks the same questions `bun run setup` asks today and prints a one-time setup link.
3. In DSM, Control Panel > Login Portal > Advanced > Reverse Proxy: terminate HTTPS for the Eigen hostname and forward to `http://127.0.0.1:8080`, with the WebSocket custom headers Synology documents in its [reverse proxy help](https://kb.synology.com/en-global/DSM/help/DSM/AdminCenter/system_login_portal_advanced?version=7) and a long proxy timeout, since collaborative editing and SSE hold connections open.
4. Open the setup link and create the organization and administrator.

The API stays private on the Docker network. DSM proxies to `eigen-static`, never to port 8000: the static gateway serves the apps and owns the API prefix routing, DAV discovery, streaming, and the internal-route 404s. A proxy running in another container cannot reach the host's `127.0.0.1`; the guide's existing shared-network recipe applies unchanged.

A Container Manager Project (GUI) path is worth offering, but only after it has been exercised in the real DSM interface: `env_file` interpolation and the ownership step must be verified there, not assumed. The shell path is the supported contract in the first release.

### 5. Mail is a choice, not a surprise

Public email hosting must not be a hidden prerequisite for someone who wants Drive, Docs, Sheets, Calendar, Contacts, and Chat on a NAS or behind a home connection.

| Preset | Services | Intended use |
|---|---|---|
| Mail off, behind an existing HTTPS proxy (DSM included) | API + static frontend | Simple NAS mode. |
| Mail off, standalone | API + edge Caddy | A VPS whose owner keeps their mail elsewhere. |
| Full workspace behind an existing proxy | API + static frontend + Postfix + Dovecot + Unbound | Users who deliberately operate Eigen mail behind their own proxy. |
| Standalone VPS | API + edge Caddy + Postfix + Dovecot + Unbound | Today's default, unchanged. |

Setup asks "Host email on this server?" with today's behavior as the default. On "no" it writes the profile without `mail`, writes `MAIL_ENABLED=0`, skips the mail-domain and DNS-record output that only a mail host needs, and asks for an outbound relay (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`) that the API authenticates to directly. Without it, two-factor codes sent by email, guest sign-in codes, share and access-request notifications, waitlist invitations, and calendar invitations and RSVP replies do not go out; skipping the relay is allowed and setup lists exactly that. On "yes" setup asks for a relay too, written as `SMTP_RELAY_*` for the bundled Postfix to forward through, because many VPS providers block outbound port 25 and receivers distrust a fresh IP. Only hosted mail can receive replies from outside attendees to calendar invitations; no relay fixes that. The one open piece on the app side is an audit for anything else a mail-off server loses, so the guide states it instead of a user finding it.

Full mail on a NAS additionally needs inbound port 25, a PTR record, submission and IMAP ports that a Synology Mail Server package may already own, and valid certificates for the hostname mail clients use. Without edge Caddy the certificate exporter does not run, and DSM's certificate store is not `/etc/letsencrypt/live`, so the host-certs overlay is a starting point rather than a DSM answer. An HTTP reverse proxy or tunnel carries none of this.

## Compatibility: what can and cannot be promised

A container shares the host kernel; it does not add CPU instructions or upgrade an old NAS kernel, and a successful pull is not a compatibility check. The Bun `--version` probe in the launcher is the cheap first gate; the acceptance checks below cover the native chain and workers.

The release documentation records the tested DSM, Container Manager, and Compose versions, the model and CPU, kernel, and RAM, and the supported profiles. No 32-bit ARM. Bun's [installation docs](https://bun.com/docs/installation) list Linux x64 (SSE4.2 required) and arm64 and recommend kernel 5.6+; those are Bun's claims, and every native dependency has its own. CPU emulation is never the recommended workaround.

Compose minimums are per file: the base stack needs the 2.20+ the guide states, the host-certs overlay needs 2.24.4+. Synology's first Container Manager shipped Compose 2.5.1 and later releases added the `docker compose` spelling; the launcher checks the real version rather than inferring it from the package version, and optional overlays must not raise the minimum for the basic preset.

Ports 80 and 443 belong to DSM's own web services ([Synology's port list](https://kb.synology.com/en-global/DSM/tutorial/What_network_ports_are_used_by_Synology_services)). That is why the preset reuses DSM's reverse proxy instead of running edge Caddy, and why the installer never stops Synology services or edits DSM-managed webserver configuration.

Publish measured runtime memory and peak build memory separately. The guide's "2 GB+ RAM" is a VPS figure for running the stack, not a promise that a NAS can compile it, which is the strongest argument for prebuilt images.

## Updates and recovery

`eigen update` has two modes, and both take a snapshot before anything changes.

**Release mode.** The current image's CLI resolves the target version to image digests, and the `sh` launcher pulls every image first. Then the NEW image's CLI performs the update: it backfills new keys into `.env.production` by rerunning setup non-interactively, takes a snapshot, keeps the previous release's digests and Compose files beside it, rewrites the launcher and Compose files from the new image, and runs `docker compose up -d` with the same project name and data locations. New upgrade logic therefore runs on the update that ships it. No `git pull`, no `bun install`, no host build. A failed pull leaves the running stack untouched. The API's 30 s `stop_grace_period` and upload drain stay as they are.

**Source mode.** `eigen update` runs `git pull`, re-execs the freshly pulled `eigen`, builds the images through `docker-compose.build.yml` with no host Bun, lets the new API image backfill `.env.production` and take the snapshot, then runs `up`. The cached install layer (§ 2) keeps a build on eigen.is close to today's time. `scripts/update.sh` is a shim that execs `./eigen update`.

What happens to today's other steps: the Caddy reload goes away, because the Caddyfile lives in the image and a new image recreates the container. The fail2ban filter refresh and jail reload stay, fed from the `docker/fail2ban/` that `bootstrap` or the checkout provides. Pruning narrows to Eigen's own superseded images, selected by their OCI source label; the build-cache prune runs in source mode only.

**Rollback.** `eigen rollback` restores the previous release's image digests, its Compose files and the pre-update snapshot together, because rolling images back after a schema change is not safe on its own. Anything written since the update goes with it.

**Breaking releases.** Before 1.0 a release may drop or convert a persisted format ([ROADMAP.md](../ROADMAP.md) states the policy). The manifest in the new image flags such a release; `eigen update` prints the release note and asks for confirmation before it touches anything, and refuses in a non-interactive run without an explicit flag. A self-hoster must never learn this from missing data.

**Moving an existing install.** eigen.is moves over with its ordinary update: its last old-style `scripts/update.sh` run pulls and re-execs the shim, which hands over to `eigen update`, and that run must succeed with no Bun on the path. The host's `dist/` and `node_modules` become leftovers the script names and leaves alone.

The snapshot (§ 1) archives `data/` and `.env.production` after stopping the API. `caddy-data`, the `postfix-queue` volume, and `data/certs` are outside it, and Postfix and Dovecot keep writing while it runs. Whole-stack recovery is the [backup proposal's](PROPOSAL_BACKUP_RESTORE.md) phase ③. The update path calls `eigen backup`'s engine, which switches to the phase ③ backup once it exists.

## Delivery plan

| Milestone | Deliverable | Done when |
|---|---|---|
| 1. No host Bun | The `eigen` launcher and CLI with `setup`, `backup`, `restore`, `reset-password`, `status` and `logs`; the one-time setup link for the first admin; the control socket for online commands; the network and ownership seams in `setup.ts`, the mail question with its relay prompts, the frontend Dockerfile for both web modes, runtime-only `.env.production`, the single Bun pin, the cached install layer, `eigen update` source mode through the build overlay with `update.sh` as its shim, the harness off host Bun | A fresh install and an update succeed on a host with Docker and Compose but no Bun, Node, or `dist/`. Every profile combination, the two mail-off ones included, passes `docker/test-deployments.sh`. eigen.is has made the move. |
| 2. No local build | The publish workflow, image-based Compose with the build overlay, domain-neutral frontend build, the bundle and manifest inside the API image with `bootstrap`, `eigen update` release mode, `eigen rollback`, the breaking-release confirmation, the release gate | Install and update from `bootstrap` without Git, a compiler, or `docker build`. The same image digests serve two differently configured hostnames. The release gate passes in CI on the previous-to-new upgrade and the rollback. |
| 3. DSM supported | Compatibility matrix, DSM proxy instructions, tested Project path, certificate guidance for full mail on DSM | A real, listed Synology model completes setup, reboot, update, and restore; the documented proxy and mail choices behave as described. |

Milestone 1 answers the Bun objection. Milestone 2 is the real simplification. Milestone 3 turns "probably works in Docker" into a support claim, and waits for hardware.

## Acceptance checks

Extend [`test-deployments.sh`](../../docker/test-deployments.sh), [`test-host-proxies.sh`](../../docker/test-host-proxies.sh), and [`test-mail-hardening.sh`](../../docker/test-mail-hardening.sh) rather than starting a second harness. They start and stop Compose projects, so they run in isolated projects and data directories, never against a real install.

| Area | Evidence |
|---|---|
| Clean build | From a clean checkout with no `node_modules`, `dist/`, or `.env.production`: every app serves its own bundle, index content and search work, native tools and workers run. A release install performs no build. |
| Configuration | Interactive, piped, and flag-driven runs; aborted input; rerun preserves everything and backfills a key the old file lacks; custom subnets and ports; paths with spaces; credentials with quotes and `$`; file mode 0600; no container sees the Docker socket. |
| Portable artifacts | One image digest on two hostnames: auth cookies, API, WebSocket, SSE, the CSP, and app links all work; SEO metadata is absent by design; no secret or private file in any layer or bundle (`docker history` and a layer scan for `.env`). |
| DSM | Listed hardware, real Compose version, bind mounts writable as 1000:1000 under Synology ACLs, survives reboot, port and network collisions detected, unsupported device fails before any data is written. |
| Real use | Admin enrollment through the setup link, which alone opens all three `/setup/*` routes; `reset-password` revokes sessions; sign-in, upload and download, two-browser collaborative editing, notifications, previews and exports, DAV through the proxy. |
| Mail | A mail-off install shows no Mail entry point and delivers a share notification through the configured relay; without a relay it says so at setup. The full preset passes inbound, outbound, IMAP, submission, TLS, and a renewal reload. |
| Operations | A failed pull leaves the running stack intact; a half-finished setup reruns cleanly; upgrade from the previous release keeps data and config; a release flagged breaking stops for confirmation; rollback brings back the previous release and its data; restore brings back a known document and, where enabled, mail, and refuses an archive newer than the install. |

Run `bun run check` for the implementation changes and publish the hardware results with the release. CI on a current Linux VM cannot stand in for an older DSM kernel.

## Out of scope

- Mail that lives at another provider ([PROPOSAL_EXTERNAL_MAIL_PROVIDER.md](PROPOSAL_EXTERNAL_MAIL_PROVIDER.md)). Mail off plus a relay is this proposal's whole answer.
- Whole-stack backup coverage ([backup proposal](PROPOSAL_BACKUP_RESTORE.md) phase ③).
- `linux/arm64` images.
- A GUI-only DSM install; the shell launcher is the first contract.
- Runtime SEO metadata for domain-neutral images.
- Slimming the API image (build tools, dev dependencies). It works; measure first.

## Recommendation

Do it, in the stated order. Milestones 1 and 2 are moderate effort, mostly Dockerfile and shell work over code that already runs from source, and they benefit every self-hoster, not just Synology owners. Keep one set of services and one Compose model; DSM is a preset on top. Treat the NAS's proxy, its hardware, and mail hosting as explicit choices made during setup, never as assumptions.
