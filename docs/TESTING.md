# Testing

> **TLDR:** Every workspace keeps its tests in `<workspace>/src/test/`. API tests drive the real Elysia app in process through `app.handle()` and Eden Treaty, with no HTTP server, and each API test file boots its own server in its own temp data dir, so CI and `bun run check` run the suite on parallel workers. `bun run test` runs the tests, `bun run check` everything CI checks, and the Docker harnesses in `docker/` prove the install, update and release path.

Read this before your first test in an area, a CI change or a release tag. A test passes or fails because of the code, never because of timing or what ran before it. The surprises: one API test file runs from `apps/api` with the preload ([§ One API test file](#one-api-test-file-runs-from-appsapi-with-the-preload)), a module mock outlives its test ([§ A module mock](#a-module-mock-lasts-for-the-rest-of-its-file)), storage faults are parked, not slept through ([§ Storage faults](#storage-faults-are-parked-and-driven-never-slept-through)), and a release publishes only images the Docker harnesses installed and upgraded ([§ A release publishes](#a-release-publishes-only-the-images-its-gates-tested)).

Two gates are read only when they apply: before a change to the xlsx, docx or pptx writer, [EXPORT.md § Each Office writer has a corpus round-trip gate](EXPORT.md#each-office-writer-has-a-corpus-round-trip-gate); before you run a script in `docker/` or change the launcher, `apps/api/src/cli/configure.ts`, a Compose file or a Caddyfile, [TESTING-DOCKER.md](TESTING-DOCKER.md).

## Every test lives in its workspace's `src/test/`

A module's test mirrors its path (`packages/lib/src/vector/snap.ts` → `packages/lib/src/test/vector/snap.test.ts`). An end-to-end feature test, most of the API suite, gets a feature folder such as `apps/api/src/test/mail/`. Shared harness files and `fixtures/` sit at the `src/test/` root. Grep the tree before you assume an area is untested.

`bun scripts/check-test-layout.ts` fails on a test file outside `<workspace>/src/test/` and on a workspace with tests but no `test` script, which `bun --filter '*' test` silently skips. Add the script with the first test, not before: `bun test` exits 1 when it finds no test files.

A fix or feature in an app ships with a test in that app, at the contract level: what the user clicks and what the app then shows or sends. An app without a runner gets a `test` script and `happy-dom` in its devDependencies, its tests calling `installHappyDom()` from `@workspace/ui/test/happy-dom` as `apps/docs` does. This `happy-dom` is approved for every app; any other new package still needs the owner's yes.

`apps/api/src/test/transform-benchmark.ts` is the document-transform benchmark ([DOCUMENT-TRANSFORMS.md](DOCUMENT-TRANSFORMS.md#the-runner-logs-one-line-per-job-overload-included)), not a test.

## One API test file runs from `apps/api` with the preload

Set up the checkout first ([CONTRIBUTING.md § Setting up your development environment](CONTRIBUTING.md#setting-up-your-development-environment)). `bun run test` runs every workspace's `test` script; `bun run test:api` and `bun run test:sheet` run one. One file, filtered by name:

```bash
cd apps/api && bun test --preload ./src/test/preload.ts ./src/test/drive/drive.test.ts -t "rename"
```

Without the preload, a file that imports `../lib` before `../setup` opens the checkout's own data root and every test fails with `Setup already completed`. From the repo root, Bun loads the root `.env`, whose settings (`PRODUCTION` among them) change what the server answers. The API's `test` script takes no path argument, so no stray test file silently never runs.

`bun test` reads an unknown flag's value as a name filter: `--concurrency 1` runs only tests whose name holds "1". After changing a test command, check that the test count didn't drop.

## `bun test` runs in UTC

So a bug that only shows at local midnight passes. Run the date and sheet-engine suites once under `TZ=Europe/Amsterdam`, or set `process.env.TZ` in the test and put back `originalTz ?? 'UTC'`: deleting `TZ` switches every later test in the process to the machine's zone, and assigning `undefined` keeps the test's.

## Each API test file boots its own server

`apps/api/src/test/test-env.ts` points `EIGEN_DATA_ROOT` at a fresh `data-test/test-<pid>-<random>` dir per worker, before any module opens its SQLite files, and prunes `data-test/` by age alone, since a young dir may be a live worker's.

Setup is lazy: the setup wizard runs once per file, when a test first awaits `ensureServer()`, `getTestContext()` or `authedRequest()` (`setup.ts`). `setup.ts` has no top-level `await`: under `--isolate` an importing file would see it suspended mid-evaluation.

- A unit test that needs a setup side effect (the mail domain, the org owner, the auth schema) awaits one of those in a `beforeAll`, never counting on another file having booted the server.
- `await collectSSE(userId)` resolves once the Home is open and the listener attached. Never sleep before the action you observe.
- A suite that sets `process.env` keys calls `restoreEnvAfterEach(keys)` (`env-test-helpers.ts`): `process.env` survives into the worker's next file.
- Assertions count only what the test created: a Home has data before the test writes any (the user's own card and default labels, from `Contacts.init`), and other tests add users, so `users.length === 3` breaks.

`getTestContext()` seeds Alice (the admin and org owner), Bob and Charlie, each with a session token and a typed Eden Treaty client.

## The preload clears the timers that pin a file's module graph

Each Home's idle timeout and Elysia's sucrose cache sweep are unref'd timers whose callbacks keep a finished file's whole app alive. The preload's `afterAll` clears them with `shutdownAllHomes()` and `clearSucroseCache(0)`; a `(fail) (unnamed) hook timed out` after the last file is that hook. `--isolate` needs Bun 1.4.1 or newer (`.bun-version`): older Bun leaks every finished file's globals.

A native Worker that outlives its test file crashes the parallel suite with `panic: NAPI FATAL ERROR: napi_define_properties`. Start such a job through `Mount.runInBackground`, as a thumbnail does, so `closeAllDatabases` waits for it. Never add `documentTransformRunner.close()` to the preload.

## Every package test file runs isolated, so file order doesn't matter

Every workspace but the API runs `bun test --isolate`: each file gets a fresh global, module graph and `process.env`, so no file inherits an earlier file's module mock, stubbed prototype or `TZ`. Such a leak passes on a Mac and fails CI, since Bun orders files differently on Linux. Isolation costs up to twice the suite's time. A bare `bun test` over several files still shares one process (bunfig.toml sets no isolation), so run package suites with `bun run test` and keep each file's restores in place.

## A module mock lasts for the rest of its file

`mock.module` replaces a module for every later test of the file. A partial mock leaves omitted exports `undefined`: spread a copy of the real module into it and put the copy back in `afterAll`. It must be a copy (`const real = { ...(await import('…')) }`), since `mock.module` rewrites the loaded module's exports in place. Give that `afterAll` a block body: returning the `mock.module` result makes the module's next mock not take. A mocked hook returns one object, not a fresh literal per call, or effects that depend on it re-run forever.

Never mock `createFileRoute` or a route file: the route keeps the stub for the whole file. Render the real `routeTree` with `createRouter` and `createMemoryHistory` under the providers its pages need, and mock the hooks.

Globals and the DOM:

- Restore, never delete, a global you didn't create. A file's happy-dom `Window`s share one set of element classes, so a getter stubbed on `HTMLElement.prototype` reaches every later test. A spy on a module's export is `mockRestore`d in `afterAll`.
- Load the UI after `installHappyDom()`, even to render a string: Radix picks its layout effect at load, and without a `document` its Select shows no value. A happy-dom `Window` needs a `url`, or `api.ts` throws at load.
- happy-dom lays nothing out, so a virtualized list draws no row until the test sets `clientHeight`. It runs an animation frame at once, before React has drawn: a Docs test wraps the action in `withBrowserFrames` or waits for async work with `waitUntil(holds, what)` (both in `apps/docs/src/test/fixtures/`), never a fixed sleep.
- A module that keeps the first DOM object it made keeps the first stub too: stub the vector text measurer through `stubCanvasMeasure` (`packages/ui/src/test/canvas-measure.ts`).
- Enter in a form field is `pressEnter(field)`, which clicks the form's first submit button, so nothing submits while it is disabled.
- A failed `toBeNull()` on an element prints its whole tree, which takes seconds: assert on labels or titles.

## Resource bounds measure the child, and scale rather than time

- A memory bound runs the work in a child process and reads `peakRss()` (`apps/api/src/lib/document/transform/peak-rss.ts`): on Linux a child's `maxRSS` starts at its parent's high-water mark, so CI's worker would read its own 1 GB.
- A quadratic guard compares CPU at n with CPU at a fraction of n, never an absolute bound: a CI runner is several times slower than a Mac.
- A bound on a hostile input's cost reads `cpuClock()` (`apps/api/src/test/cpu-time.ts`), never the wall clock. A comparison of two costs takes each side's fastest of several runs, so a collector pause fails nothing.
- A Bun Worker sees `TMPDIR` as its process started, so a private temp dir needs a child process. A child that hands back more than 64 KB writes it with `await Bun.write(Bun.stdout, …)`: once anything reads `process.stdout` (lib0 does, so anything reaching yjs), Bun cuts a `console.log` into a pipe at 64 KB on exit.

## Slow and Linux-only suites run on CI

A suite that takes tens of seconds skips unless `CI` or `EIGEN_SLOW_TESTS=1` is set. The demo seeder contract test (`server/seed-demo.test.ts`) is one: run it after touching `apps/api/src/scripts/demo/` or a reader it decodes with. The doc round trip (`import/doc/round-trip.test.ts`) runs a few hundred random seeds locally, more with `EIGEN_SLOW_TESTS`, and a different slice on each CI run.

macOS refuses `setrlimit` for the data segment, so the transform's memory limit is tested on Linux only ([DOCUMENT-TRANSFORMS.md](DOCUMENT-TRANSFORMS.md#a-child-runs-under-the-machines-memory)). On a Mac, run those tests in an `oven/bun` container with a copy of the checkout and its own `bun install --frozen-lockfile`, since the Mac's `node_modules` holds macOS binaries.

## Storage faults are parked and driven, never slept through

The drive resilience suites run on doubles at the `src/test/` root, each listing what it fakes in its header. The test holds and releases every fault:

- `FaultStorage` (`fault-storage-helpers.ts`) wraps a real `LocalStorage` whose writes and `exists()` can fail, stall, hang or be parked. Hold a PUT with `parkWrites` and `waitForParked`, never `writeDelayMs` and `Bun.sleep`. A `FaultMount`'s upload queue never retries on its own (`holdUploadRetries` spies `uploadBackoffMs` to a minute, for the rest of the file, or of the process in a single-process `bun run test:api`): the test drives each retry with `uploadQueue.drain({ flushNow: true })`, so no backoff timer fires into a later step.
- A read fault needs `fake-s3-server.ts`: `S3Storage.read()` returns a lazy `S3File`, so a stalled GET happens inside Bun's client, out of `FaultStorage`'s sight.
- A test that waits out a storage deadline awaits `passStorageDeadline(start, held)` (`fault-storage-helpers.ts`): it fakes the clock, starts the call, runs the clock past the deadline once the fake holds the request, and gives the real clock back even when it throws. It hands the call back as `started`, and `settlesWithin` then bounds the wait. `passPutDeadline(start, held)` does the same for the upload queue's PUT deadline, so the PUT that `start` queues times out into an orphan while `parkWrites` still holds it.
- A test that the event loop stays free counts turns with `countLoopTurns` (`setup.ts`), never time.
- A promise that settles after an event-loop turn, such as a backup, a restore or a storage read of 2 MiB or more, never goes to `expect(...).rejects`: there Bun sleeps until the next timer fires, often past the test's timeout. Await `rejectionOf(promise)` (`setup.ts`) and assert on the error it returns.
- The CalDAV and CardDAV stores keep their truth in a BLOB and need no double: `breakTransaction(domain)` (`db-test-helpers.ts`) throws inside the transaction, and the test asserts the previous bytes and projection survived.

`home-test-helpers.ts` is the one fake-Home harness: `openTestHome(create, dir, user)` builds a domain class such as `Contacts` over a temp directory without a booted app, and its `reopen()` simulates a restart.

## CI

`.github/workflows/check.yml` runs on a push to `main`, `develop`, `release-*` or `ci-*` (for work on the workflow itself) and on a pull request to `main` or `develop`. Its jobs run side by side:

- `checks`: the gates of `bun run check` except the API suite, then the package suites in turn with `bun --filter '!@apps/api' test --timeout 30000`.
- `api 1/3` to `api 3/3`: the API suite in three shards of four isolated workers each, balanced by the per-file times in `apps/api/src/test/timings.json`. Only these install the PDF engine.
- `api-files` fails unless the shards together ran every API test file.
- `launcher` runs `docker/test-launcher.sh`.

`bun run check` (`scripts/check.ts`) runs the same gates and every workspace's suite locally, all at once, the API's on eight isolated workers, so a test that leans on an earlier file's leftovers fails both. Every step runs to its end and the summary names each failure. It runs under `--no-env-file`, since the root `.env.development` would hand every suite `PRODUCTION` and `MAIL_DOMAIN`. The gates: dedupe, lint, typecheck, a typecheck of the repo's own `scripts/` (`scripts/tsconfig.json`, which no workspace covers), home imports, test layout, docs links (a relative link or a backtick'd `apps/`, `packages/`, `docker/` or `scripts/` path that doesn't exist), the ratcheting standards check ([CODE-STANDARDS.md § Standards Gates](CODE-STANDARDS.md#standards-gates)) and the primitives index.

`bun run test:api` instead runs the API suite in one process holding every Home of the run, so a file can fail on an earlier one's leftovers while CI stays green. Leave nothing a later file reads: server settings, archives in the backups folder, a socket at a fixed path, a home no backup can verify, a stray s3 mount. A server backup test, which verifies every home and lists every archive, is the usual victim.

`bun dedupe --check` fails when `bun.lock` holds two versions of a package one version could satisfy: two copies of `@codemirror/language` or of Radix's dismissable layer break at runtime without an error. Run `bun dedupe` and commit the lockfile.

- The 30 s per-test timeout is for CI and the check, with busy cores; a file run by hand keeps bun's 5 s, so a slow test is caught where it is written.
- `SQLITE_IOERR_VNODE` in a sandboxed run is the sandbox: rerun outside before calling it a failure. A loaded or sleeping machine fakes timeouts: check `uptime`, run no second suite beside the check, and use `caffeinate -ims bun run check` on a Mac.
- Under `GITHUB_ACTIONS` the preload prints each worker's RSS after every file. Exit code 143 is an out-of-memory kill; `bun --filter` buffers output, so the last test in the log is not the culprit.

Refresh the timings after a batch of new API test files; each shard uploads its times as the artifact `api-shard-<i>`:

```bash
gh run download <run id> -p 'api-shard-*' -D /tmp/api-shards
jq -s '{version: 1, files: (map(.files) | add | to_entries | sort_by(.key) | from_entries)}' /tmp/api-shards/*/timings-*.json > apps/api/src/test/timings.json
```

## Work lands on develop, and main moves only for a release

Every change and pull request targets `develop`. `main` moves only on the owner's word, by a fast-forward (`git switch main && git merge --ff-only develop`), and a push to it publishes the `:main` images, so `:main` and the release tags carry only code the owner chose to ship. A release bumps the version and its CHANGELOG section on `develop`, fast-forwards `main` and tags `main`; `bun run release` prints the commands.

## A GitHub release says what changed in a few lines

`bun run release publish` posts the intro paragraph of the version's CHANGELOG section and a link to the whole section, and refuses a section with no intro. Its readers don't know Eigen yet, so it lists no bullets; the [changelog skill](../.claude/skills/changelog/SKILL.md) says how the intro reads.

## A release publishes only the images its gates tested

`.github/workflows/publish.yml` runs on a `v*` tag and a push to `main`, and fails on anything else. It builds every image for linux/amd64 and linux/arm64 under a candidate tag (`candidate-<version or main>-<platform>`), which is no version, `latest` or `main`, so the launcher refuses it.

On a tag, `docker/test-release.sh` updates the previous published release to the amd64 candidates and rolls it back, and `docker/test-boot.sh` boots the arm64 candidates. Before publishing, the workflow checks each candidate's build stamp and takes it by digest, so a candidate another run built is never published. Only when every image is built and both gates pass do the candidates become the `<version>` index, copied to `:latest` unless a newer stable release is out (a prerelease or a backport leaves `:latest` alone). A failed build or gate leaves no partial release.

- A version already published fails the gate: a release is never published twice.
- In CI the gate fails when no earlier release is published, unless none is published at all: only the first release has none to update.
- A release whose `CHANGELOG.md` lists breaking changes under its own `## [<version>]` heading fails too, since `./eigen update` refuses it on every install. Run the workflow on its tag with `breaking: true` to publish it anyway; that run fails if the release lists no breaking change.

A push to `main` runs no gates and publishes `:main`. A newer push waits for a running build and replaces a queued one, so a cancel never leaves `:main` half promoted. In CI arm64 only boots; its update and rollback are proven by the harnesses on an Apple Silicon Mac.

## Dependencies are bumped right after a release tag

Bump them and read `bun audit` right after a `v*` tag, never in the days before one, so an upstream break surfaces with weeks to fix it. Run `bun update --recursive` (a plain run updates only the root's dependencies), then `bun dedupe`. The one exception before a tag is a security fix the owner asks for, bumped on its own.

better-auth refuses to boot when `apps/api/auth-schema.ts` misses a plugin's column, so a better-auth minor that adds one lands together with the column, the DDL in `apps/api/src/lib/setup/setup.ts` and `ensureAuthSchemaColumns` ([DATABASE.md](DATABASE.md)).

## See also

- [CONTRIBUTING.md](CONTRIBUTING.md): setting up a checkout and the pre-commit hook
- [DEMO_MODE.md](DEMO_MODE.md): the demo seeder that `server/seed-demo.test.ts` pins
- The [verify-in-browser skill](../.claude/skills/verify-in-browser/SKILL.md): proving a change in the running dev app
