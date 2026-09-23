# Testing

> **TLDR**: Every workspace keeps its tests in `<workspace>/src/test/` — nothing named `*.test.ts` lives anywhere else, and `bun scripts/check-test-layout.ts` enforces it. API integration tests use the Bun test runner + real Elysia app via `app.handle()` + Eden Treaty. No HTTP server needed. The API suite runs in parallel across worker processes, each with its own temp data dir and its own booted server. Test users: Alice, Bob, Charlie. Run: `bun run test`.

## Where tests live

Every workspace has exactly one test folder, `<workspace>/src/test/`. Inside it, tests group by subject:

- **A test covering one module mirrors that module's path.** `packages/lib/src/vector/snap.ts` is tested by `packages/lib/src/test/vector/snap.test.ts`. This is the shape in `packages/lib`, `packages/ui`, `packages/sheet`, `apps/slides` and `apps/stickies`, where tests genuinely target single modules.
- **A test covering a feature end-to-end gets a feature folder.** `apps/api/src/test/mail/`, `.../drive/`, `.../caldav/`. Most of the API suite boots a Home and drives the real API, so its subject is a feature, not a module — there is no module path to mirror.

Shared harness files (`setup.ts`, `preload.ts`, `test-env.ts`, `home-test-helpers.ts`, `contacts-test-helpers.ts`, `calendar-test-helpers.ts`, `mail-test-helpers.ts`, `mount-test-helpers.ts`, `dav-test-helpers.ts`, `db-test-helpers.ts`, `ics-test-helpers.ts`, `transfer-test-helpers.ts`, `fault-storage-helpers.ts`, `env-test-helpers.ts`, `fixtures/`) sit at the `src/test/` root, not in a feature folder. `fault-storage-helpers.ts` is the storage double for the drive resilience suites: a `StorageBackend` over a real `LocalStorage` whose writes and `exists()` probes can fail, stall, hang or be parked, plus `createFaultMount` to build a Mount on it. The two DAV stores need no such double: their truth is a BLOB column, so a suite injects a fault with `breakTransaction(domain)` (`db-test-helpers.ts`, shared by both suites), which throws inside the transaction callback — SQLite really undoes the statements — and then asserts that the previous bytes and the whole projection survived it.

`env-test-helpers.ts` holds `restoreEnvAfterEach(keys)`, which puts each named `process.env` key back after every test, so a suite that sets `MAIL_ENABLED`, `SMTP_*` or `PRODUCTION` leaks nothing into the next test or file.

`home-test-helpers.ts` is the one fake-Home harness: `openTestHome(create, dir, user)` builds a domain class over a temp directory with no booted app behind it (a stub Home with a memoized `getLocalDatabase`, the current user and a broadcast sink), and `makeTestHome(create, root)` gives each harness its own subdir. The returned harness carries `reopen()` — a fresh instance over the same directory, which is how a crash or restart is simulated — plus `database(relativePath)` and `close()`. `makeContacts` (`contacts-test-helpers.ts`) and `makeCalendar` (`calendar-test-helpers.ts`) are thin callers of it. `dav-test-helpers.ts` holds the DAV request pair every protocol suite shares: `basicAuth(email)` and `davRequest(method, path, { email, headers, body })`.

Two rules are enforced by `bun scripts/check-test-layout.ts`, which runs as part of `bun run check`:

1. No `*.test.ts` outside `<workspace>/src/test/`.
2. Every workspace that has tests has a `test` script — otherwise `bun --filter '*' test` skips it silently and the tests never run.

Note the second rule only fires once a workspace actually has tests. Do not add `"test": "bun test"` to a workspace pre-emptively: `bun test` exits 1 when it finds no test files, which would break `bun run check`.

## Running

```bash
bun run check              # lint + typecheck + home-import check + test-layout check + docs-link check + primitives:check + test
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
- No path argument: the layout rule already says where tests are, and a path here would mean a stray
  test file silently never runs
- Slow end-to-end suites are gated on `CI` (set by GitHub Actions) or `EIGEN_SLOW_TESTS=1`: the demo
  seeder contract test (`server/seed-demo.test.ts`, ~30 s, spawns the whole seeder) skips in a plain
  local run. Run it locally with `EIGEN_SLOW_TESTS=1 bun run test:api` after touching
  `src/scripts/demo/` or the readers it decodes with
- Files run sequentially by default. `--parallel=N` is supported and safe: it implies `--isolate`, so
  every test file evaluates in a fresh module graph, gets its own `EIGEN_DATA_ROOT` (a per-process dir
  under `data-test/`, see below) and boots its own server on first use. No two files share a Home
  singleton or a SQLite file, which is what makes running them concurrently safe. Setup is lazy:
  `setup.ts` exports `ensureServer()`, and the wizard POST (`/setup/complete`) runs once per file, the
  first time a test awaits `getTestContext()`, `authedRequest()`, or `ensureServer()`. A pure-unit test
  that needs a setup side effect (the configured mail domain, the org owner, the auth schema) awaits one
  of those in a `beforeAll`; it cannot rely on another file having booted the server
- Why sequential stays the default: the per-file server boot (~1 s) is the price of `--isolate`, and it
  eats most of the parallel gain. Measured on the 2810-test suite: sequential 166 s; `--parallel=4` (the
  CI runner's core count) 159 s; `--parallel=6` on a 10-core laptop 125-145 s. One worker per core on a
  high-core machine oversubscribes CPU, because many files spawn their own transform/thumbnail Worker
  threads on top of the test worker, and heavy work then tips over Bun's 5 s default timeout. Use
  `--parallel=6` on a machine with cores to spare; the route to a fast CI step is `--shard=i/N` across
  jobs, where each shard is a plain sequential process that boots once

### One file at a time

`bun test apps/api/src/test/drive/drive.test.ts` from the repo root **fails** with `Setup has already been
completed`: Bun auto-loads the root `.env`, which collides with the harness's fresh-`EIGEN_DATA_ROOT`
setup flow. Run it from `apps/api` with the package script's own flags, and `-t` to filter by name:

```bash
cd apps/api && bun test --preload ./src/test/preload.ts ./src/test/drive/drive.test.ts -t "rename"
```

## Architecture

```
Test -> Eden Treaty / authedRequest() -> app.handle() -> Real business logic -> Temp data dir
```

- **Data isolation**: `apps/api/src/test/test-env.ts` (imported first by `setup.ts`, before the app/auth modules
  open their SQLite files) sets `EIGEN_DATA_ROOT` to `data-test/test-<pid>-<random>` — a fresh dir per worker
  process. It prunes by age alone, once per worker process: anything under `data-test/` older than ten minutes is a
  dead run. A live sibling's dir is never that old, so the many unit tests that keep their own
  `data-test/test-<name>-<ts>` scratch dir survive a concurrent run
- **Test users**: Alice (`alice@test.eigen.is`), Bob (`bob@test.eigen.is`), Charlie (`charlie@test.eigen.is`)
- **Setup**: `apps/api/src/test/setup.ts` boots the server lazily via `ensureServer()` (runs the setup wizard),
  seeds the three users on first `getTestContext()`, and exports the helper functions (`authedRequest`,
  `drivePost`, `chatGet`, etc.). It has no top-level `await` — under `--isolate` a suspended module would be
  observed mid-evaluation by the importing file, so its exports are all defined synchronously
- **Preload**: `apps/api/src/test/preload.ts` registers an `afterAll` cleanup hook
- **Integration tests** (`drive.test.ts`, `calendar.test.ts`, etc.) use test helpers from `setup.ts`: `getTestContext()` → returns `{ alice, bob, charlie }` test users with session tokens and API clients; `authedRequest(token, path, options?)` → make authenticated HTTP request; `driveGet/drivePost/drivePut/driveDelete` → typed drive API helpers; `driveGetPermission` → check read/write permissions
- **Unit tests** (`mount.test.ts`, `storage.test.ts`, etc.) create isolated instances with temp directories

## Test Files

Every API test lives in a feature folder under `apps/api/src/test/` — `acl/`, `auth/`, `backup/`, `caldav/`, `calendar/`, `carddav/`, `chat/`, `cli/`, `collab/`, `comments/`, `contacts/`, `core/`, `dav/`, `document/`, `drive/`, `export/`, `home/`, `ical/`, `import/`, `mail/`, `mount/`, `preview/`, `search/`, `server/`, `storage/`, `vcard/`, `webdav/` — one `<subject>.test.ts` per subject. Coverage spans CalDAV, WebDAV, mail, drive, collab, file history, search, import/export, demo mode, upload-queue chaos and more — grep the tree rather than assuming an area is untested.

Not part of the suite: `src/test/transform-benchmark.ts` is a standalone responsiveness/memory benchmark for
document transforms — run it from `apps/api` with `bun src/test/transform-benchmark.ts` (see PREVIEWS.md).

Not part of the suite either: the Docker harnesses in `docker/test-*.sh` install Eigen from the working tree into a scratch folder with `./eigen`, with no Bun on the host, and probe it (every deployment shape, the operator commands, updates, the release gate). `docker/test-all.sh` runs them one after another; run them one at a time, since two at once can pick the same subnet. The publish workflow runs `docker/test-release.sh` before it pushes a release. The list and what each covers: [LOCAL-TESTING.md § Smoke-test the deployment shapes](../docker/LOCAL-TESTING.md#smoke-test-the-deployment-shapes).

## Key Details

- **Treaty**: Used for static path routes. `authedRequest()` for dynamic `:mountId` params
- **Contacts**: `addContact`/`addLabel` return plain UUID strings. Auto-seeds user as contact on first access
- **One auth DB per file**: under `--isolate` each test file boots its own server in its own data dir, so
  it sees only the users/orgs it (or its `getTestContext()`) created; files share no users/orgs
  table. Still scope assertions to the entities the test itself created: a single file that creates users
  beyond Alice/Bob/Charlie breaks an exact global count (`users.length === 3`) the same way

## CI

Tests run in GitHub Actions via `.github/workflows/check.yml` on push/PR to `main`:

```yaml
steps:
  - bun install --frozen-lockfile
  - bun run lint
  - bun run typecheck
  - bun run primitives:check      # Primitives index (docs/SHARED-PRIMITIVES.md is generated + gated)
  - bun --filter '*' test
```

The CI job runs on `ubuntu-latest` with a 15-minute timeout. Locally `bun run check` is the same set plus `bun scripts/check-home-imports.ts`, `bun scripts/check-test-layout.ts`, `bun scripts/check-docs-links.ts` (relative markdown links and backtick'd `apps/`|`packages/`|`docker/`|`scripts/` paths must resolve on disk), and `bun scripts/check-standards.ts` (the ratcheting code-standards gate — see [CODE-STANDARDS.md § Standards Gates](CODE-STANDARDS.md#standards-gates)): lint → typecheck → home-import check → test-layout check → docs-link check → standards check → `primitives:check` → test.
