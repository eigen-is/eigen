# Testing

> **TLDR**: API integration tests using Bun test runner + real Elysia app via `app.handle()` + Eden Treaty. No HTTP
> server needed. Temp data dir per run. Test users: Alice, Bob, Charlie. Run: `bun run test`. Tests in
> `apps/api/src/test/`.

## Running

```bash
bun run check              # lint + typecheck + home-import check + primitives:check + test
bun run test               # tests only (all workspaces)
bun run test:api           # API tests only
bun run test:sheet         # sheet package unit tests only (packages/sheet, plain `bun test`, no preload)
bun run typecheck          # typecheck only
bun run lint               # lint + format check (biome)
```

The API test command (in `apps/api/package.json`) is:

```bash
bun test --preload ./src/test/preload.ts --concurrency 1 ./src/test/
```

- `--preload ./src/test/preload.ts` registers an `afterAll` hook that calls `cleanup()`
- `--concurrency 1` required because tests share SQLite via the Home singleton

### One file at a time

`bun test apps/api/src/test/drive.test.ts` from the repo root **fails** with `Setup has already been
completed`: Bun auto-loads the root `.env`, which collides with the harness's fresh-`EIGEN_DATA_ROOT`
setup flow. Run it from `apps/api` with the package script's own flags, and `-t` to filter by name:

```bash
cd apps/api && bun test --preload ./src/test/preload.ts --concurrency 1 ./src/test/drive.test.ts -t "rename"
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

Every API test lives in `apps/api/src/test/`, one `<subject>.test.ts` per subject, plus a `webdav/`
subdirectory for the WebDAV method suites and a `fixtures/` folder. Coverage spans CalDAV, WebDAV, mail,
drive, collab, file history, search, import/export, demo mode, upload-queue chaos and more — grep the
directory rather than assuming an area is untested.

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

The CI job runs on `ubuntu-latest` with a 15-minute timeout. Locally `bun run check` is the same set
plus `bun scripts/check-home-imports.ts`: lint → typecheck → home-import check → `primitives:check` → test.
