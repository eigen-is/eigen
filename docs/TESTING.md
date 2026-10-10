# Testing

> **TLDR:** Every workspace keeps its tests in `<workspace>/src/test/`, and `bun scripts/check-test-layout.ts` enforces it. API tests drive the real Elysia app in process through `app.handle()` and Eden Treaty, with no HTTP server. Each API test file boots its own server in its own temp data dir, which is what lets CI run the suite on four isolated workers. Not obvious from the code: one API test file runs from `apps/api` with the preload, never from the repo root; storage faults are parked and driven, never slept through; and a release publishes only images that the Docker harnesses in `docker/` installed and upgraded the way a self-hoster does. Run `bun run test` for the tests and `bun run check` for everything CI checks.

This doc governs where tests live, how they run on a laptop and in CI, and what a release must pass before it is published. Read it before you write the first test in an area, touch CI or tag a release. The rules share one aim: a test passes or fails because of the code, never because of timing or of what ran before it.

## Every test lives in its workspace's `src/test/`

Every workspace has exactly one test folder, `<workspace>/src/test/`. Inside it, a test that covers one module mirrors that module's path: `packages/lib/src/vector/snap.ts` is tested by `packages/lib/src/test/vector/snap.test.ts`. That is the shape of most package and frontend tests, which target single modules. A test that covers a feature end to end gets a feature folder instead, such as `apps/api/src/test/mail/`. Most of the API suite boots a Home and drives the real API, so its subject is a feature, and there is no module path to mirror. Shared harness files and `fixtures/` sit at the `src/test/` root. Grep the tree before you assume an area is untested.

`bun scripts/check-test-layout.ts` runs in `bun run check` and enforces two rules:

1. No `*.test.ts` or `*.test.tsx` outside `<workspace>/src/test/`.
2. Every workspace that has tests has a `test` script. `bun --filter '*' test` skips a workspace without one silently, so its tests would never run.

Add the `test` script together with the first test, not before. `bun test` exits 1 when it finds no test files, which would break `bun run check`.

`apps/api/src/test/transform-benchmark.ts` is not a test. It is the document-transform benchmark ([DOCUMENT-TRANSFORMS.md](DOCUMENT-TRANSFORMS.md#the-runner-logs-one-line-per-job-overload-included)), run from `apps/api` with `bun src/test/transform-benchmark.ts`.

## One API test file runs from `apps/api` with the preload

Set up the checkout first: [CONTRIBUTING.md § Setting up your development environment](CONTRIBUTING.md#setting-up-your-development-environment). Then:

- `bun run test` runs every workspace's `test` script, and `bun run test:api` and `bun run test:sheet` run one workspace.
- The API's script is `bun test --preload ./src/test/preload.ts`, with no path argument. The layout rule already says where tests are, and a path would let a stray test file silently never run.
- One file, filtered by name with `-t`:

```bash
cd apps/api && bun test --preload ./src/test/preload.ts ./src/test/drive/drive.test.ts -t "rename"
```

Both parts matter. Without the preload, a test file that imports `../lib` before `../setup` opens the server config under the checkout's own data root, where setup is done, so every test fails with `Setup already completed`. From the repo root, Bun also loads the root `.env` when there is one, and its settings (`PRODUCTION` among them) change what the server answers.

## Each API test file boots its own server

`apps/api/src/test/test-env.ts` sets `EIGEN_DATA_ROOT` to a fresh `data-test/test-<pid>-<random>` dir per worker process. It must run before any app or auth module opens its SQLite files, so `setup.ts` and `preload.ts` both import it first. It prunes `data-test/` once per worker, by age alone: anything older than ten minutes is a dead run. A live sibling's dir is never that old, so a concurrent run keeps its own dir and the `data-test/test-<name>-<ts>` scratch dirs that unit tests make for themselves.

Setup is lazy. `setup.ts` exports `ensureServer()`, and the setup wizard (`POST /setup/complete`) runs once per file, the first time a test awaits `ensureServer()`, `getTestContext()` or `authedRequest()`. `setup.ts` has no top-level `await`: under `--isolate` the importing file would see a suspended module mid-evaluation, so every export is defined synchronously.

- A pure unit test that needs a setup side effect (the mail domain, the org owner, the auth schema) awaits one of those in a `beforeAll`. It cannot count on another file having booted the server.
- `await collectSSE(userId)` resolves once the user's Home is open and the listener attached. A test never opens the Home itself or sleeps before the action it wants to observe.
- A suite that sets `process.env` keys (`MAIL_ENABLED`, `SMTP_*`, `PRODUCTION`) calls `restoreEnvAfterEach(keys)` from `env-test-helpers.ts`. `process.env` survives the fresh module graph of the next file in the same worker.

`getTestContext()` seeds the three test users, Alice (`alice@test.eigen.is`, the admin and org owner), Bob and Charlie, each with a session token and a typed Eden Treaty client. `authedRequest(token, path)` takes a raw path, and the `drive*` and `chat*` helpers in `setup.ts` build on it.

## Assertions count only what the test created

Each file has its own auth database, so it sees only the users and orgs it created. A file that creates users beyond Alice, Bob and Charlie still breaks an exact global count such as `users.length === 3`. Some data exists before the test writes any: a Home's contacts book holds the user's own card and the default labels from its first open (`Contacts.init`). Scope every assertion to the entities the test made.

## The preload clears the timers that pin a file's module graph

`--isolate` gives every test file a fresh global and module graph, and it needs Bun 1.4.1 or newer (`.bun-version`). Older Bun keeps many finished files' globals alive with no retainer reachable from JS, so a worker grows by the whole app graph, about 50 MB, per such file.

Two pins are the app's own and outlive a file on any Bun: each Home's idle timeout and Elysia's sucrose cache sweep. Both are unref'd timers whose callbacks reach the module graph. The preload's `afterAll` clears them with `shutdownAllHomes()` and `clearSucroseCache(0)`.

## Locally files run in one process, in CI on four isolated workers

`--parallel=N` implies `--isolate`, so every file gets its own `EIGEN_DATA_ROOT` and its own server. No two files share a Home singleton or a SQLite file, which is what makes running them concurrently safe.

A plain local run stays sequential in one process. The per-file server boot (about 1 s) is the price of `--isolate`, and on a laptop with few spare cores it eats the parallel gain, because many files spawn their own transform and thumbnail Worker threads on top of the test worker. CI runs `--parallel=4`, the runner's core count, for the isolation, not the speed. One sequential process holds every Home of the run and stalls on what ran before, and bun's file order differs per run on Linux. So a test that leans on what an earlier file left behind, such as a file written without waiting or a setting another test changed, passes the local run and fails CI: run the `--parallel=4` command below before main gets a push.

That one process also shares one data root, so a file that passes alone can fail a later one locally while CI stays green. Leave behind nothing a later file reads: server settings, archives in the backups folder, a socket file at a fixed path, a home no backup can verify (a corrupted document, a control character in a path) or a stray home with an s3 mount. A server backup test verifies every home in the data root and lists every archive, so it is the usual victim.

## Resource bounds measure the child, and scale rather than time

A test that bounds memory runs the work in a child process and reads the child's peak with `peakRss()` (`apps/api/src/test/rss-test-helpers.ts`): on Linux a child's `maxRSS` starts at the high-water mark of the process that spawned it, so CI's worker would read its own 1 GB, and `VmHWM` in `/proc/self/status` is the child's alone. A test that guards against a quadratic compares CPU at n with CPU at a fraction of n instead of holding an absolute bound, because a CI runner spends two to four times this Mac's CPU and the old quadratic was only a few times slower at test sizes. A Bun Worker sees `TMPDIR` as it was when its process started, so a test that needs a private temp dir runs the work in a child process with its own `TMPDIR` and working directory.

## Slow end-to-end suites run on CI only

A suite that takes tens of seconds skips unless `CI` (set by GitHub Actions) or `EIGEN_SLOW_TESTS=1` is set. The demo seeder contract test, `server/seed-demo.test.ts`, spawns the whole seeder in about 30 s. Run it with `EIGEN_SLOW_TESTS=1 bun run test:api` after you touch `apps/api/src/scripts/demo/` or a reader it decodes with.

## Storage faults are parked and driven, never slept through

The drive resilience suites run on doubles at the `src/test/` root, and each double's header comment lists what it can fake. The rules:

- `fault-storage-helpers.ts` wraps a real `LocalStorage` in `FaultStorage`, whose writes and `exists()` probes can fail, stall, hang or be parked. Its `createFaultMount` builds a `FaultMount`, whose upload queue never retries on its own. A test drives every retry with `drainPendingUploads({ flushNow: true })`, so a jittered backoff timer can't fire into a later step, such as a restart mount's replay.
- Hold an in-flight PUT with `parkWrites` and `waitForParked`, never with `writeDelayMs` and `Bun.sleep`. A sleep races the code it waits for.
- A read fault needs `fake-s3-server.ts`. `S3Storage.read()` returns a lazy `S3File`, so a stalled or cut GET happens inside Bun's client, where `FaultStorage` never sees it. `FakeS3Server` is a raw TCP S3 endpoint that the real `S3Storage` talks to, with per-key faults and `heal()` to answer every held request.
- A test that waits out a storage deadline shrinks it with `setStorageTimeoutMs(SHRUNK_STORAGE_TIMEOUT_MS)` and restores `STORAGE_TIMEOUT_MS` afterwards. `settlesWithin` (`fault-storage-helpers.ts`) then bounds one call by `STALL_BOUND_MS` and a settle of several steps (a mount teardown, a backup job) by `SETTLE_BOUND_MS`.
- A test that the event loop stays free counts its turns with `countLoopTurns` (`setup.ts`), a `setImmediate` chain, never time, so a slow disk changes nothing. Bun waits on a promise inside `expect(...).rejects` or `.resolves` in a nested loop, where a `setImmediate` turn resumes only at the next timer, so one turn there can take up to a second. That is why `eventLoopTurn` (`apps/api/src/lib/core/stream.ts`) schedules a second, empty immediate.
- The CalDAV and CardDAV stores keep their truth in a BLOB column, so their suites need no storage double. `breakTransaction(domain)` (`db-test-helpers.ts`) throws inside the transaction callback, so SQLite really undoes the statements, and the test asserts that the previous bytes and the whole projection survived.

## A domain class runs without a booted app

`home-test-helpers.ts` is the one fake-Home harness. `openTestHome(create, dir, user)` builds a domain class, such as `Contacts` or `Calendar`, over a temp directory, with a stub Home that supplies only a memoized `getLocalDatabase`, the current user and a broadcast sink. Its `reopen()` returns a fresh instance over the same directory, which is how a test simulates a crash or restart. `makeContacts` and `makeCalendar` are thin callers of it.

## The Docker harnesses install Eigen as a stranger does

The scripts in `docker/` are not part of `bun run test`. Each one copies the tracked files as the working tree has them into a scratch folder under `$TMPDIR` (`git add` a new file to include it). It runs `./eigen` there from a `docker:cli` container that has no Bun, as its own Compose project on `127.0.0.1` ports 18000-18999, and removes what it started on exit. So a harness never touches your checkout's `data/` or a stack you run. `HARNESS_KEEP=1` leaves the scratch install up.

Every harness sources `docker/probe-lib.sh` first and adds only its own probes. The library's Compose view of the install (`dc`, `stack_up`) runs from that container as root, because a release install and its `.env.production` are root's, and on a Linux host the harness user cannot read them. Docker Desktop hides this by mapping ownership to your user.

Run them one at a time: two started together can pick the same subnet. `./docker/test-all.sh` runs them in turn and prints one line per harness. Each script's header lists everything it probes.

| Harness | What it proves |
|---|---|
| `docker/test-launcher.sh` | The launcher alone, under dash, BusyBox `sh` and the host's `/bin/sh` with a stub `docker`: every command's help, the refusals, local-build and release mode (a local build refuses `update` and `rollback`), the main channel, the lock, setup beside the launcher alone, and the installer script `apps/index/public/install`. No stack. |
| `docker/test-cli.sh` | The operator commands (`status`, the control socket, the setup link, `reset-password`, `backup`, `restore` and their refusals) on installs made as another uid and as root. |
| `docker/test-interactive.sh` | The questions as a person answers them in a terminal, typed by `expect` (install it first), Ctrl-C included. |
| `docker/test-deployments.sh` | Every `COMPOSE_PROFILES` shape (`edge,mail`, `static,mail`, `edge`, `static`) and a custom subnet: pages, app bundles, the API, WebSockets, the mail banners, and relay mail and collab sync without hosted mail. Run it before merging a change to `eigen`, `apps/api/src/cli/configure.ts`, a Compose file or a Caddyfile. |
| `docker/test-host-proxies.sh` | nginx, Caddy and Apache in front of `eigen-static` with the snippets `./eigen setup` writes. |
| `docker/test-release.sh` | The release gate the publish workflow runs beside its builds. First the real upgrade: it installs the newest release on ghcr.io before this one, as published, seeds a document with text, a sheet with a cell, an event, a contact and a chat message, updates it to the release this tree becomes, and rolls back, checking the seed, the pre-update server backup the published release makes (`backups/server-pre-update-<level>-*.tar`, the file `.eigen/last-update` names), the image pins and the site. In the workflow that release is its amd64 candidate images (`CANDIDATE`), the ones it then publishes; locally it is the working tree built as that release, and a tree whose version is out already becomes the next patch release. Then releases in a registry of its own: update, rollback, a breaking release, the refused versions, restoring an older release's backup with its launcher and Compose files, the main channel, and installing from the launcher alone. |
| `docker/test-boot.sh` | The publish workflow's arm64 gate: its candidate images (`CANDIDATE=candidate-<version or main>-<platform>`), installed with mail off, answer `/eigen/health`. It needs a candidate on ghcr.io, so `test-all.sh` leaves it out. |
| `docker/test-mail-hardening.sh` | The mail hardening of [MAIL.md § Submission is held to the login's own address](MAIL.md#submission-is-held-to-the-logins-own-address): sender checks, the queue alert and the SASL failure limiters, DKIM signing with a key the API can read, and a TLS key it can read too (probes 13 and 14): the server backup archives both. About 6 minutes; `PROBES=2,3,4` runs a subset. Its comments explain the SMTP AUTH behavior that looks like a bug and is not. |

## CI

`.github/workflows/check.yml` runs on every push and pull request to `main`. Its `check` job installs with `--frozen-lockfile`, then runs `bun dedupe --check`, `bun run lint`, `bun run typecheck` and `bun run primitives:check`, then the tests:

- `bun --filter '!@apps/api' test --timeout 30000`: the package suites, one sequential process each. They still depend on file order, which a [ROADMAP.md](ROADMAP.md) row tracks.
- `bun --filter '@apps/api' test --parallel=4 --timeout 30000`: the API suite on four isolated workers.

`bun dedupe --check` fails when `bun.lock` holds two versions of a package that one version could satisfy. Two copies of `@codemirror/language` or of Radix's dismissable layer break at runtime without an error, and a dependency bump or `bun add` can bring a copy back. Run `bun dedupe` and commit the lockfile it writes.

The 30 s per-test timeout is for CI alone. The runner is slower than a laptop, and bun's 5 s default fails a slow file there. Locally the default stays, so a slow test is caught where it is written. Under `GITHUB_ACTIONS` the API preload prints `[memory] worker N rss` after every file, so a worker's growth shows next to the file that caused it.

A second job, `launcher`, runs `docker/test-launcher.sh`. It needs no stack and no Bun, so it runs on a plain runner beside the check job.

Locally, `bun run check` runs the check job's set plus four scripts, in this order: dedupe check, lint, typecheck, `bun scripts/check-home-imports.ts`, `bun scripts/check-test-layout.ts`, `bun scripts/check-docs-links.ts`, `bun scripts/check-standards.ts`, `primitives:check`, test. The docs-link check fails on a relative markdown link or a backtick'd `apps/`, `packages/`, `docker/` or `scripts/` path that does not resolve on disk. The standards check is the ratcheting code-standards gate ([CODE-STANDARDS.md § Standards Gates](CODE-STANDARDS.md#standards-gates)).

## A release publishes only the images its gates tested

`.github/workflows/publish.yml` runs on a `v*` tag and on a push to `main`. A run on any other branch or tag, a manual one included, fails before it builds. The workflow builds the images for linux/amd64 and linux/arm64 under candidate tags (`candidate-<version or main>-<platform>`), each on a runner of its own architecture. A candidate is no version, `latest` or `main`, so the launcher refuses it.

On a tag, two gates test those candidates, the images that get published. `docker/test-release.sh` updates the previous published release to the amd64 candidates and rolls it back, building its own releases while it waits for them. `docker/test-boot.sh` installs the arm64 candidates on an arm64 runner and checks `/eigen/health`. The release gate waits for the candidates stamped with this run's build time, and the boot check runs once every build is done. Before it publishes, the workflow checks each candidate's stamp and takes it by digest, so a candidate another run built is never published.

- A tag whose version is published already, a prerelease included, fails the gate: a release is never published twice.
- In CI, the gate fails when no release before this one is published, unless none is published at all.
- A release whose `CHANGELOG.md` lists breaking changes since the previous one fails it too, since `./eigen update` refuses it on every install. To publish it anyway, run the workflow on its tag with the input `breaking: true`, which updates with `--accept-breaking` and checks the seed only after the rollback. A `(breaking)` line counts only under the release's own `## [<version>]` heading, since `update-check` skips `[Unreleased]`. The gate names the path it took, and a run with `breaking: true` whose release lists no breaking change fails.

The version is published only once every image is built and both gates passed. Each image's two candidates become the `<version>` index, which is then copied to `:latest` when no newer stable release is out. A prerelease, or a backport such as 0.2.1 after 0.3.0, leaves `:latest` alone. A failed build or gate leaves no partial release.

A push to `main` runs no gates and publishes the images as `:main`, the channel a release install can follow. A newer push waits for a running build of `main` and replaces one still queued, so a cancel never leaves `:main` half promoted.

In CI arm64 only boots. Its update and rollback are proven by the harnesses on an Apple Silicon Mac.

## Dependencies are bumped before a release tag

Before a `v*` tag, bump the dependencies and read `bun audit`. Run `bun update --recursive`, because a plain run at the root updates only the root's own dependencies. Then `bun dedupe`, `bun run check` and a browser pass.

better-auth checks `apps/api/auth-schema.ts` against its plugins' models at startup and refuses to boot on a `SCHEMA_MISMATCH`. So a better-auth minor that adds columns lands with the column in `auth-schema.ts`, the DDL in `apps/api/src/lib/setup/setup.ts` and `ensureAuthSchemaColumns` together ([DATABASE.md](DATABASE.md)).

## See also

- [CONTRIBUTING.md](CONTRIBUTING.md): setting up a checkout and the pre-commit hook
- [DEMO_MODE.md](DEMO_MODE.md): the demo seeder that `server/seed-demo.test.ts` pins
- [SELF-HOSTING.md](SELF-HOSTING.md): the install, update and rollback the Docker harnesses probe
- The [verify-in-browser skill](../.claude/skills/verify-in-browser/SKILL.md): proving a change in the running dev app
