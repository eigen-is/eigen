# Docker test harnesses

> **TLDR:** The Docker harnesses are shell scripts in `docker/` that install Eigen in a scratch folder, as a stranger would, and prove the install, update and release path. `./docker/test-all.sh` runs them in turn.

Read this before you run a harness or change the launcher, `apps/api/src/cli/configure.ts`, a Compose file or a Caddyfile. A harness keeps no data of its own: its scratch folder and Compose project go when it ends. The surprise: Docker's two image stores treat a moved tag differently ([§ A launcher change runs on both image stores](#a-launcher-change-runs-on-both-image-stores)).

## The Docker harnesses install Eigen as a stranger does

The scripts in `docker/` are not part of `bun run test`. Each copies the tracked files as the working tree has them into a scratch folder (`git add` a new file to include it) and runs `./eigen` there from a `docker:cli` container with no Bun, as its own Compose project on `127.0.0.1` ports 18000-18999, so it never touches your `data/` or a running stack. Every harness sources `docker/probe-lib.sh`, which runs Compose as root: a release install's `.env.production` is root's, and a Linux host's harness user can't read it (Docker Desktop hides this).

## A launcher change runs on both image stores

On a moved tag, Docker Desktop's containerd store drops `repo@sha256:<old>`, while Linux's classic store keeps it as a digest-only image that `docker image ls` shows only with `--all`. So the launcher pulls a pinned image back by digest before it reads one, and a launcher change runs on both stores: the Mac gate is containerd, CI's ubuntu classic.

## Each harness proves one path, and they run one at a time

Run them one at a time, since two can pick the same subnet; `./docker/test-all.sh` runs them in turn. Each script's header lists what it probes; `HARNESS_KEEP=1` leaves the scratch install up.

| Harness | What it proves |
|---|---|
| `test-launcher.sh` | The launcher alone under dash, BusyBox and the host `sh`, with a stub `docker`, and the installer `apps/index/public/install`. No stack. |
| `test-cli.sh` | The operator commands and their refusals, on installs made as another uid and as root. |
| `test-interactive.sh` | The questions as a person answers them, typed by `expect`. |
| `test-deployments.sh` | Every `COMPOSE_PROFILES` shape and a custom subnet. Run it before merging a change to `eigen`, `apps/api/src/cli/configure.ts`, a Compose file or a Caddyfile. |
| `test-host-proxies.sh` | nginx, Caddy and Apache in front of `eigen-static` with the snippets setup writes. |
| `test-release.sh` | The release gate: the previous published release is installed, seeded, updated to this one and rolled back, then update, rollback and breaking releases run in a registry of its own. |
| `test-boot.sh` | The arm64 gate: the candidate images answer `/eigen/health`. Needs a candidate on ghcr.io, so `test-all.sh` skips it. |
| `test-mail-hardening.sh` | The mail hardening of [MAIL.md § Submission is held to the login's own address](MAIL.md#submission-is-held-to-the-logins-own-address). `PROBES=2,3,4` runs a subset. |

## See also

- [TESTING.md](TESTING.md): the test suites, CI and the release gates
- [SELF-HOSTING.md](SELF-HOSTING.md): the install, update and rollback the Docker harnesses probe
