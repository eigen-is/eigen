# Testing

> **TLDR**: Every workspace keeps its tests in `<workspace>/src/test/` — nothing named `*.test.ts` lives anywhere else, and `bun scripts/check-test-layout.ts` enforces it. API integration tests use the Bun test runner + real Elysia app via `app.handle()` + Eden Treaty. No HTTP server needed. The API suite runs in parallel across worker processes, each with its own temp data dir and its own booted server. Test users: Alice, Bob, Charlie. Run: `bun run test`.

## Where tests live

Every workspace has exactly one test folder, `<workspace>/src/test/`. Inside it, tests group by subject:

- **A test covering one module mirrors that module's path.** `packages/lib/src/vector/snap.ts` is tested by `packages/lib/src/test/vector/snap.test.ts`. This is the shape in `packages/lib`, `packages/ui`, `packages/sheet`, `apps/slides` and `apps/stickies`, where tests genuinely target single modules.
- **A test covering a feature end-to-end gets a feature folder.** `apps/api/src/test/mail/`, `.../drive/`, `.../caldav/`. Most of the API suite boots a Home and drives the real API, so its subject is a feature, not a module — there is no module path to mirror.

Shared harness files (`setup.ts`, `preload.ts`, `test-env.ts`, `home-test-helpers.ts`, `contacts-test-helpers.ts`, `calendar-test-helpers.ts`, `mail-test-helpers.ts`, `mount-test-helpers.ts`, `dav-test-helpers.ts`, `db-test-helpers.ts`, `ics-test-helpers.ts`, `transfer-test-helpers.ts`, `fault-storage-helpers.ts`, `fake-s3-server.ts`, `env-test-helpers.ts`, `fixtures/`) sit at the `src/test/` root, not in a feature folder. `fault-storage-helpers.ts` is the storage double for the drive resilience suites: a `StorageBackend` over a real `LocalStorage` whose writes and `exists()` probes can fail, stall, hang or be parked, plus `createFaultMount` to build a Mount on it. That Mount is a `FaultMount`: its upload queue never retries on its own, so a test drives every retry with `drainPendingUploads({ flushNow: true })` and a jittered backoff timer can't fire into a later step (a restart mount's replay, a deliberately corrupted staged copy). Hold an in-flight PUT with `parkWrites` + `waitForParked`, never with `writeDelayMs` + `Bun.sleep`. A read fault needs `fake-s3-server.ts` instead: `S3Storage.read()` returns a lazy `S3File`, so a stalled or cut GET happens inside Bun's client, where FaultStorage never sees it. `FakeS3Server` is a raw TCP S3 endpoint over a `StorageBackend` that the real `S3Storage` talks to, with per-key faults (`stall`, `stall-body`, `cut`, `empty`, `fail`) and `heal()` to answer every held request. The two DAV stores need no such double: their truth is a BLOB column, so a suite injects a fault with `breakTransaction(domain)` (`db-test-helpers.ts`, shared by both suites), which throws inside the transaction callback — SQLite really undoes the statements — and then asserts that the previous bytes and the whole projection survived it.

`env-test-helpers.ts` holds `restoreEnvAfterEach(keys)`, which puts each named `process.env` key back after every test, so a suite that sets `MAIL_ENABLED`, `SMTP_*` or `PRODUCTION` leaks nothing into the next test or file.

`home-test-helpers.ts` is the one fake-Home harness: `openTestHome(create, dir, user)` builds a domain class over a temp directory with no booted app behind it (a stub Home with a memoized `getLocalDatabase`, the current user and a broadcast sink), and `makeTestHome(create, root)` gives each harness its own subdir. The returned harness carries `reopen()` — a fresh instance over the same directory, which is how a crash or restart is simulated — plus `database(relativePath)` and `close()`. `makeContacts` (`contacts-test-helpers.ts`) and `makeCalendar` (`calendar-test-helpers.ts`) are thin callers of it. `dav-test-helpers.ts` holds the DAV request pair every protocol suite shares: `basicAuth(email)` and `davRequest(method, path, { email, headers, body })`.

Two rules are enforced by `bun scripts/check-test-layout.ts`, which runs as part of `bun run check`:

1. No `*.test.ts` outside `<workspace>/src/test/`.
2. Every workspace that has tests has a `test` script — otherwise `bun --filter '*' test` skips it silently and the tests never run.

Note the second rule only fires once a workspace actually has tests. Do not add `"test": "bun test"` to a workspace pre-emptively: `bun test` exits 1 when it finds no test files, which would break `bun run check`.

## Running

Set up the checkout first: [CONTRIBUTING.md § Setting up your development environment](CONTRIBUTING.md#setting-up-your-development-environment).

```bash
bun run check              # lint + typecheck + home-import + test-layout + docs-link + standards + primitives:check + test
bun run test               # tests only (all workspaces: api + sheet + lib + index)
bun run test:api           # API tests only
bun run test:sheet         # sheet package unit tests only (packages/sheet, plain `bun test`, no preload)
bun run typecheck          # typecheck only
bun run lint               # lint + format check (biome)
```

The API test command (in `apps/api/package.json`) is:

```bash
bun test --preload ./src/test/preload.ts
```

- `--preload ./src/test/preload.ts` registers an `afterAll` hook that calls `cleanup()`
- No path argument: the layout rule already says where tests are, and a path here would mean a stray test file silently never runs
- Slow end-to-end suites are gated on `CI` (set by GitHub Actions) or `EIGEN_SLOW_TESTS=1`: the demo seeder contract test (`server/seed-demo.test.ts`, ~30 s, spawns the whole seeder) skips in a plain local run. Run it locally with `EIGEN_SLOW_TESTS=1 bun run test:api` after touching `src/scripts/demo/` or the readers it decodes with
- Files run sequentially by default, in one process. `--parallel=N` is the isolated mode, and what CI runs: it implies `--isolate`, so every test file evaluates in a fresh global and module graph, gets its own `EIGEN_DATA_ROOT` (a per-process dir under `data-test/`, see below) and boots its own server on first use. No two files share a Home singleton or a SQLite file, which is what makes running them concurrently safe. Setup is lazy: `setup.ts` exports `ensureServer()`, and the wizard POST (`/setup/complete`) runs once per file, the first time a test awaits `getTestContext()`, `authedRequest()`, or `ensureServer()`. A pure-unit test that needs a setup side effect (the configured mail domain, the org owner, the auth schema) awaits one of those in a `beforeAll`; it cannot rely on another file having booted the server. The same goes for a Home: `await collectSSE()` resolves once the user's Home is open and the listener attached, so a test never opens the Home itself or sleeps before the action it wants to observe
- Isolation needs Bun 1.4.1 or newer (`.bun-version`): under 1.3.14 the runtime keeps many finished files' globals alive with no retainer reachable from JS, and a worker grows by the whole app graph (~50 MB) per such file. Two pins are the app's own and outlive a file on any Bun: each Home's idle timeout and Elysia's sucrose cache sweep, both unref'd timers whose callbacks reach the module graph. The preload's `afterAll` clears them (`shutdownAllHomes()`, `clearSucroseCache(0)`), which is why it imports `./test-env` first: anything it pulls from `../lib` would otherwise open SQLite under the wrong data root
- Why sequential stays the local default: the per-file server boot (~1 s) is the price of `--isolate`, and on a laptop with few spare cores it eats the parallel gain, because many files spawn their own transform/thumbnail Worker threads on top of the test worker. CI runs `--parallel=4` (the runner's core count) for the isolation, not the speed: one sequential process holds every Home of the run and stalls on what ran before, and bun's file order differs per run on Linux

### One file at a time

`bun test apps/api/src/test/drive/drive.test.ts` from the repo root **fails** with `Setup has already been completed`: Bun auto-loads the root `.env`, which collides with the harness's fresh-`EIGEN_DATA_ROOT` setup flow. Run it from `apps/api` with the package script's own flags, and `-t` to filter by name:

```bash
cd apps/api && bun test --preload ./src/test/preload.ts ./src/test/drive/drive.test.ts -t "rename"
```

## Architecture

```
Test -> Eden Treaty / authedRequest() -> app.handle() -> Real business logic -> Temp data dir
```

- **Data isolation**: `apps/api/src/test/test-env.ts` (imported first by `setup.ts`, before the app/auth modules open their SQLite files) sets `EIGEN_DATA_ROOT` to `data-test/test-<pid>-<random>` — a fresh dir per worker process. It prunes by age alone, once per worker process: anything under `data-test/` older than ten minutes is a dead run. A live sibling's dir is never that old, so the many unit tests that keep their own `data-test/test-<name>-<ts>` scratch dir survive a concurrent run
- **Test users**: Alice (`alice@test.eigen.is`), Bob (`bob@test.eigen.is`), Charlie (`charlie@test.eigen.is`)
- **Setup**: `apps/api/src/test/setup.ts` boots the server lazily via `ensureServer()` (runs the setup wizard), seeds the three users on first `getTestContext()`, and exports the helper functions (`authedRequest`, `drivePost`, `chatGet`, etc.). It has no top-level `await` — under `--isolate` a suspended module would be observed mid-evaluation by the importing file, so its exports are all defined synchronously
- **Preload**: `apps/api/src/test/preload.ts` registers an `afterAll` cleanup hook
- **Integration tests** (`drive.test.ts`, `calendar.test.ts`, etc.) use test helpers from `setup.ts`: `getTestContext()` → returns `{ alice, bob, charlie }` test users with session tokens and API clients; `authedRequest(token, path, options?)` → make authenticated HTTP request; `driveGet/drivePost/drivePut/driveDelete` → typed drive API helpers; `driveGetPermission` → check read/write permissions
- **Unit tests** (`mount.test.ts`, `storage.test.ts`, etc.) create isolated instances with temp directories

## Test Files

Every API test lives in a feature folder under `apps/api/src/test/` — `acl/`, `auth/`, `backup/`, `caldav/`, `calendar/`, `carddav/`, `chat/`, `cli/`, `collab/`, `comments/`, `contacts/`, `core/`, `dav/`, `document/`, `drive/`, `export/`, `home/`, `ical/`, `import/`, `mail/`, `mount/`, `preview/`, `search/`, `server/`, `storage/`, `vcard/`, `webdav/` — one `<subject>.test.ts` per subject. Coverage spans CalDAV, WebDAV, mail, drive, collab, file history, search, import/export, demo mode, upload-queue chaos and more — grep the tree rather than assuming an area is untested.

Not part of the suite: `src/test/transform-benchmark.ts` is a standalone responsiveness/memory benchmark for document transforms — run it from `apps/api` with `bun src/test/transform-benchmark.ts` (see PREVIEWS.md).

Not part of the suite either: the Docker harnesses below.

## Docker harnesses

The scripts in `docker/` install Eigen the way a stranger does and probe it. Each copies the tracked files as the working tree has them (`git add` a new file to include it) into a scratch folder under `$TMPDIR`, runs `./eigen` there from a `docker:cli` container that has no Bun, as its own Compose project on `127.0.0.1` ports 18000-18999, and removes what it started on exit. They never touch your checkout's `data/` or a stack you run. `HARNESS_KEEP=1` leaves the scratch install up. They share `docker/probe-lib.sh`, so a new harness sources it first and adds only its own probes. Its Compose view of the install (`dc`, `stack_up`) runs from that container too, as root, because a release install and its `.env.production` are root's and the harness user on a Linux host cannot read them; Docker Desktop hides that by mapping ownership to your user.

Run them one at a time: two started together can pick the same subnet. `./docker/test-all.sh` runs them all, one after another, and prints one line per harness.

| Harness | What it proves |
|---|---|
| `docker/test-launcher.sh` | The launcher alone, under dash, BusyBox `sh` and the host's `/bin/sh` with a stub `docker`: every command's help, the refusals, local-build and release mode (a local build refuses `update` and `rollback`), the main channel, the lock, setup beside the launcher alone, and the installer script `apps/index/public/install`. No stack. |
| `docker/test-cli.sh` | The operator commands (`status`, the control socket, the setup link, `reset-password`, `backup`, `restore` and their refusals) on installs made as another uid and as root. |
| `docker/test-interactive.sh` | The questions as a person answers them in a terminal, typed by `expect` (install it first), Ctrl-C included. |
| `docker/test-deployments.sh` | Every `COMPOSE_PROFILES` shape (`edge,mail`, `static,mail`, `edge`, `static`) and a custom subnet: pages, app bundles, the API, WebSockets, the mail banners, and relay mail and collab sync without hosted mail. Run it before merging a change to `eigen`, `apps/api/src/cli/configure.ts`, a Compose file or a Caddyfile. |
| `docker/test-host-proxies.sh` | nginx, Caddy and Apache in front of `eigen-static` with the snippets `./eigen setup` writes. |
| `docker/test-release.sh` | The release gate the publish workflow runs before it builds: releases in a registry of its own, update, rollback, a breaking release, the refused versions, restoring a snapshot of an older release, the main channel, and installing from the launcher alone. |
| `docker/test-mail-hardening.sh` | The mail hardening of [SETUP-GUIDE.md § Mail hardening](../docker/SETUP-GUIDE.md#mail-hardening): sender checks, the queue alert and the SASL failure limiters. About 6 minutes; `PROBES=2,3,4` runs a subset. Its comments explain the SMTP AUTH behavior that looks like a bug and is not. |

## Key Details

- **Treaty**: Used for static path routes. `authedRequest()` for dynamic `:mountId` params
- **Contacts**: `addContact`/`addLabel` return plain UUID strings. Auto-seeds user as contact on first access
- **One auth DB per file**: under `--isolate` each test file boots its own server in its own data dir, so it sees only the users/orgs it (or its `getTestContext()`) created; files share no users/orgs table. Still scope assertions to the entities the test itself created: a single file that creates users beyond Alice/Bob/Charlie breaks an exact global count (`users.length === 3`) the same way

## CI

Tests run in GitHub Actions via `.github/workflows/check.yml` on push/PR to `main`:

```yaml
steps:
  - bun install --frozen-lockfile
  - bun run lint
  - bun run typecheck
  - bun run primitives:check      # Primitives index (docs/SHARED-PRIMITIVES.md is generated + gated)
  - bun --filter '!@apps/api' test --timeout 30000   # package suites, one sequential process each
  - bun --filter '@apps/api' test --parallel=4 --timeout 30000
```

The package suites run as one sequential process each; they still depend on file order (see the roadmap). The API suite runs isolated across four workers, the runner's core count: each file gets a fresh global, so nothing a file leaves behind reaches the next one, and no process holds every Home of the run. The 30 s per-test timeout is CI-only: the runner is slower than a laptop, and bun's 5 s default turned a slow file into a failure. Locally the default stays, so a slow test is caught where it is written. Under `GITHUB_ACTIONS` the API preload prints `[memory] worker N rss` after every file and bun prints per-test timings, so a worker's growth shows next to the file that caused it.

The check job runs on `ubuntu-latest` with a 15-minute timeout. A second job, `launcher`, runs `docker/test-launcher.sh` beside it: the launcher under dash, BusyBox and the runner's sh, with a stub `docker`, so no stack and no Bun (5-minute timeout).

A `v*` tag runs `.github/workflows/publish.yml` instead. It runs `docker/test-release.sh`, builds the images for linux/amd64 and linux/arm64 under candidate tags (`candidate-<version or main>-<platform>`), each on a runner of its own architecture, and publishes the version only once every image is built for both: each image's two candidates become the `<version>` index, which is then copied to `:latest`, which a prerelease leaves alone. A failed build leaves no partial release. A push to `main` runs the same workflow without the release gate and publishes the images as `:main`, the channel a release install can follow; a newer push waits for a running build of `main` and replaces one still queued. arm64 is proven by the harnesses on an Apple Silicon Mac, not by a CI stack. Locally `bun run check` is the check job's set plus `bun scripts/check-home-imports.ts`, `bun scripts/check-test-layout.ts`, `bun scripts/check-docs-links.ts` (relative markdown links and backtick'd `apps/`|`packages/`|`docker/`|`scripts/` paths must resolve on disk), and `bun scripts/check-standards.ts` (the ratcheting code-standards gate — see [CODE-STANDARDS.md § Standards Gates](CODE-STANDARDS.md#standards-gates)): lint → typecheck → home-import check → test-layout check → docs-link check → standards check → `primitives:check` → test.
