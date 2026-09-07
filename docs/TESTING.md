# Testing

> **TLDR**: Every workspace keeps its tests in `<workspace>/src/test/` — nothing named `*.test.ts` lives anywhere else, and `bun scripts/check-test-layout.ts` enforces it. API integration tests use the Bun test runner + real Elysia app via `app.handle()` + Eden Treaty. No HTTP server needed. The API suite runs in parallel across worker processes, each with its own temp data dir and its own booted server. Test users: Alice, Bob, Charlie. Run: `bun run test`.

## Where tests live

Every workspace has exactly one test folder, `<workspace>/src/test/`. Inside it, tests group by subject:

- **A test covering one module mirrors that module's path.** `packages/lib/src/vector/snap.ts` is tested by `packages/lib/src/test/vector/snap.test.ts`. This is the shape in `packages/lib`, `packages/ui`, `packages/sheet`, `apps/slides` and `apps/stickies`, where tests genuinely target single modules.
- **A test covering a feature end-to-end gets a feature folder.** `apps/api/src/test/mail/`, `.../drive/`, `.../caldav/`. Most of the API suite boots a Home and drives the real API, so its subject is a feature, not a module — there is no module path to mirror.

Shared harness files (`setup.ts`, `preload.ts`, `contacts-test-helpers.ts`, `fault-storage-helpers.ts`, `fixtures/`, `bench/`) sit at the `src/test/` root, not in a feature folder. `fault-storage-helpers.ts` is the one storage double for the resilience suites: a `StorageBackend` over a real `LocalStorage` whose writes and `exists()` probes can fail, stall, hang or be parked, plus `createFaultMount` to build a Mount on it.

Two rules are enforced by `bun scripts/check-test-layout.ts`, which runs as part of `bun run check`:

1. No `*.test.ts` outside `<workspace>/src/test/`.
2. Every workspace that has tests has a `test` script — otherwise `bun --filter '*' test` skips it silently and the tests never run.

Note the second rule only fires once a workspace actually has tests. Do not add `"test": "bun test"` to a workspace pre-emptively: `bun test` exits 1 when it finds no test files, which would break `bun run check`.

## Running

```bash
bun run check              # lint + typecheck + home-import check + test-layout check + docs-link check + primitives:check + test
bun run test               # tests only (all workspaces)
bun run test:api           # API tests only
bun run test:sheet         # sheet package unit tests only (packages/sheet, plain `bun test`, no preload)
bun run typecheck          # typecheck only
bun run lint               # lint + format check (biome)
```

The API test command (in `apps/api/package.json`) is:

```bash
bun test --preload ./src/test/preload.ts --parallel=6
```

- `--preload ./src/test/preload.ts` registers an `afterAll` hook that calls `cleanup()`
- No path argument: the layout rule already says where tests are, and a path here would mean a stray
  test file silently never runs
- `--parallel=6` spreads the test files across six worker processes. `--parallel` implies `--isolate`, so
  every test file evaluates in a fresh module graph. Each file therefore gets its own `EIGEN_DATA_ROOT`
  (a per-process dir under `data-test/`, see below) and boots its own server on first use — no two files
  share a Home singleton or a SQLite file, which is what makes running them concurrently safe. Setup is
  lazy: `setup.ts` exports `ensureServer()`, and the wizard POST (`/setup/complete`) runs once per file,
  the first time a test awaits `getTestContext()`, `authedRequest()`, or `ensureServer()`. A pure-unit
  test that needs a setup side effect (the configured mail domain, the org owner, the auth schema) must
  await one of those in a `beforeAll` — it can no longer rely on another file having booted the server
- The pool is capped at 6, not left at Bun's default (one worker per core). Many files spawn their own
  transform/thumbnail Worker threads on top of the test worker, so one worker per core oversubscribes CPU
  on a high-core machine: heavy work (a per-file server boot, a cold mail index, a document export) then
  tips over Bun's 5 s default timeout under sustained back-to-back load. Six workers leave that headroom
  and still finish well under the sequential time. Raise it on a machine with cores to spare

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
  process. It prunes only what is safe to delete: its own `test-<pid>-` dirs whose worker is gone, plus anything
  older than an hour. It never touches a live sibling's dir, so the many unit tests that keep their own
  `data-test/test-<name>-<ts>` scratch dir survive a concurrent run
- **Test users**: Alice (`alice@test.eigen.is`), Bob (`bob@test.eigen.is`), Charlie (`charlie@test.eigen.is`)
- **Setup**: `apps/api/src/test/setup.ts` boots the server lazily via `ensureServer()` (runs the setup wizard),
  seeds the three users on first `getTestContext()`, and exports the helper functions (`authedRequest`,
  `drivePost`, `chatGet`, etc.). It has no top-level `await` — under `--isolate` a suspended module would be
  observed mid-evaluation by the importing file, so its exports are all defined synchronously
- **Preload**: `apps/api/src/test/preload.ts` registers an `afterAll` cleanup hook

## Test Files

Every API test lives in a feature folder under `apps/api/src/test/` — `acl/`, `auth/`, `caldav/`,
`calendar/`, `carddav/`, `chat/`, `collab/`, `comments/`, `contacts/`, `core/`, `document/`, `drive/`,
`export/`, `home/`, `import/`, `mail/`, `mount/`, `preview/`, `search/`, `server/`, `storage/`, `webdav/`
— one `<subject>.test.ts` per subject. Coverage spans CalDAV, WebDAV, mail, drive, collab, file history,
search, import/export, demo mode, upload-queue chaos and more — grep the tree rather than assuming an
area is untested.

Not part of the suite: `src/test/transform-benchmark.ts` is a standalone responsiveness/memory benchmark for
document transforms — run it from `apps/api` with `bun src/test/transform-benchmark.ts` (see PREVIEWS.md).

## Key Details

- **Treaty**: Used for static path routes. `authedRequest()` for dynamic `:mountId` params
- **Contacts**: `addContact`/`addLabel` return plain UUID strings. Auto-seeds user as contact on first access
- **One auth DB per file**: under `--isolate` each test file boots its own server in its own data dir, so
  it sees only the users/orgs it (or its `getTestContext()`) created — files no longer share a users/orgs
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
