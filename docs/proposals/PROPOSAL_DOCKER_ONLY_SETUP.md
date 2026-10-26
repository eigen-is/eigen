# Proposal: Docker-only installation, with a Synology DSM preset

> **Status:** the `eigen` command that needs only Docker on the host, the published release images and setup's mail question are built. [SELF-HOSTING.md](../SELF-HOSTING.md) and the help center's [Self-hosting](https://eigen.is/support/self-hosting/get-started) section describe them. This page designs what remains, the Synology DSM preset (milestone 3), which no Synology hardware has exercised yet. "DSM" means Synology DiskStation Manager.

> **TLDR**: DSM becomes a documented preset: the `static` profile behind DSM's own reverse proxy, installed through Container Manager. Docker removes host dependencies, not NAS hardware limits or the networking a mail server needs, so full mail is a question setup asks, and the answer "no" produces a working mail-off install.

## Design

### DSM is a preset, not a fork

Install Synology's Container Manager from Package Center; its [package page](https://www.synology.com/en-global/dsm/packages/ContainerManager) and [release notes](https://www.synology.com/en-global/releaseNote/ContainerManager) define the model and DSM requirements. Never run the VPS guide's `get.docker.com` script on DSM or install a second daemon over Synology's.

The preset is `COMPOSE_PROFILES=static` (or `static,mail`), `EIGEN_STATIC_HOST=127.0.0.1`, `EIGEN_STATIC_PORT=8080`, and DSM's reverse proxy in front. Installation after this proposal ships:

1. Over SSH, in a folder such as `/volume1/docker/eigen` (an example, not a requirement), run `curl -fsSL https://eigen.is/install | sh`.
2. The installer runs `./eigen setup`. It asks the setup questions and prints a one-time setup link.
3. In DSM, Control Panel > Login Portal > Advanced > Reverse Proxy: terminate HTTPS for the Eigen hostname and forward to `http://127.0.0.1:8080`, with the WebSocket custom headers Synology documents in its [reverse proxy help](https://kb.synology.com/en-global/DSM/help/DSM/AdminCenter/system_login_portal_advanced?version=7) and a long proxy timeout, since collaborative editing and SSE hold connections open.
4. Open the setup link and create the organization and administrator.

The API stays private on the Docker network. DSM proxies to `eigen-static`, never to port 8000: the static gateway serves the apps and owns the API prefix routing, DAV discovery, streaming, and the internal-route 404s. A proxy running in another container cannot reach the host's `127.0.0.1`; the guide's existing shared-network recipe applies unchanged.

A Container Manager Project (GUI) path is worth offering, but only after it has been exercised in the real DSM interface: `env_file` interpolation and the ownership step must be verified there, not assumed. The shell path is the supported contract in the first release.

### Full mail on a NAS

Full mail on a NAS additionally needs inbound port 25, a PTR record, submission and IMAP ports that a Synology Mail Server package may already own, and valid certificates for the hostname mail clients use. Without edge Caddy the certificate exporter does not run, and DSM's certificate store is not `/etc/letsencrypt/live`, so the setup guide's certbot deploy hook is a starting point rather than a DSM answer. An HTTP reverse proxy or tunnel carries none of this.

## Compatibility: what can and cannot be promised

A container shares the host kernel; it does not add CPU instructions or upgrade an old NAS kernel, and a successful pull is not a compatibility check. The launcher has no probe for it; the acceptance checks below cover the native chain and workers.

The release documentation records the tested DSM, Container Manager, and Compose versions, the model and CPU, kernel, and RAM, and the supported profiles. No 32-bit ARM. Bun's [installation docs](https://bun.com/docs/installation) list Linux x64 (SSE4.2 required) and arm64 and recommend kernel 5.6+; those are Bun's claims, and every native dependency has its own. CPU emulation is never the recommended workaround.

Compose minimums are per file: the base stack needs the 2.20+ the guide states, an override that uses `!override` needs 2.24.4+. Synology's first Container Manager shipped Compose 2.5.1 and later releases added the `docker compose` spelling; the launcher checks the real version rather than inferring it from the package version, and optional overlays must not raise the minimum for the basic preset.

Ports 80 and 443 belong to DSM's own web services ([Synology's port list](https://kb.synology.com/en-global/DSM/tutorial/What_network_ports_are_used_by_Synology_services)). That is why the preset reuses DSM's reverse proxy instead of running edge Caddy, and why the installer never stops Synology services or edits DSM-managed webserver configuration.

Runtime memory is measured: about 200 MB idle and 850 MB at peak during exports, so 2 GB minimum and 4 GB recommended ([requirements](../../apps/index/src/data/support/self-hosting/requirements.md)). That is for running the stack, not a promise that a NAS can compile it, which is the strongest argument for prebuilt images.

## Delivery plan

| Milestone | Deliverable | Done when |
|---|---|---|
| 3. DSM supported | Compatibility matrix, DSM proxy instructions, tested Project path, certificate guidance for full mail on DSM | A real, listed Synology model completes setup, reboot, update, and restore; the documented proxy and mail choices behave as described. |

Milestone 3 turns "probably works in Docker" into a support claim, and waits for hardware.

## Acceptance checks

Extend [`test-deployments.sh`](../../docker/test-deployments.sh), [`test-host-proxies.sh`](../../docker/test-host-proxies.sh), and [`test-mail-hardening.sh`](../../docker/test-mail-hardening.sh) rather than starting a second harness. They start and stop Compose projects, so they run in isolated projects and data directories, never against a real install.

| Area | Evidence |
|---|---|
| DSM | Listed hardware, real Compose version, bind mounts writable as 1000:1000 under Synology ACLs, survives reboot, port and network collisions detected, unsupported device fails before any data is written. |

Run `bun run check` for the implementation changes and publish the hardware results with the release. CI on a current Linux VM cannot stand in for an older DSM kernel.

## Out of scope

- Mail that lives at another provider ([PROPOSAL_EXTERNAL_MAIL_PROVIDER.md](PROPOSAL_EXTERNAL_MAIL_PROVIDER.md)). Mail off plus a relay is this proposal's whole answer.
- A GUI-only DSM install; the shell launcher is the first contract.
