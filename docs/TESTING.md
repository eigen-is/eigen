# Testing

> **TLDR**: Every workspace keeps its tests in `<workspace>/src/test/` — nothing named `*.test.ts` lives anywhere else, and `bun scripts/check-test-layout.ts` enforces it. API integration tests use the Bun test runner + real Elysia app via `app.handle()` + Eden Treaty. No HTTP server needed. Temp data dir per run. Test users: Alice, Bob, Charlie. Run: `bun run test`.

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
bun test --preload ./src/test/preload.ts
```

- `--preload ./src/test/preload.ts` registers an `afterAll` hook that calls `cleanup()`
- No path argument: the layout rule already says where tests are, and a path here would mean a stray
  test file silently never runs
- The suite needs test files to run one at a time, because they share SQLite via the Home singleton.
  That comes free — Bun runs test files sequentially by default. This command used to carry
  `--concurrency 1`, which never did anything: Bun has no such flag (it has `--concurrent` and
  `--max-concurrency=<val>`), so `--concurrency` was ignored and the `1` was parsed as a positional
  test-name filter. It went unnoticed because the `./src/test/` path argument was a second filter that
  matched everything

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

- **Data isolation**: `EIGEN_DATA_ROOT` points to `data-test/test-<timestamp>` (relative to repo root), previous runs
  are cleaned on startup in `setup.ts`
- **Test users**: Alice (`alice@test.eigen.is`), Bob (`bob@test.eigen.is`), Charlie (`charlie@test.eigen.is`)
- **Setup**: `apps/api/src/test/setup.ts` clears old test data, creates temp dir, runs setup wizard, creates users,
  exports `getTestContext()` and helper functions (`authedRequest`, `drivePost`, `chatGet`, etc.)
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
- **One shared auth DB**: `setup.ts` POSTs `/setup/complete` once for the whole run, so every test file
  sees the same users/orgs table. Exact global count assertions (`users.length === 3`) break as soon as
  another file creates a user — scope assertions to the entities the test itself created

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

The CI job runs on `ubuntu-latest` with a 15-minute timeout. Locally `bun run check` is the same set plus
`bun scripts/check-home-imports.ts`, `bun scripts/check-test-layout.ts`, and `bun scripts/check-docs-links.ts`
(relative markdown links and backtick'd `apps/`|`packages/`|`docker/`|`scripts/` paths must resolve on disk):
lint → typecheck → home-import check → test-layout check → docs-link check → `primitives:check` → test.
