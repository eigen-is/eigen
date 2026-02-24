# Testing

API integration tests for the Eigen backend using Bun's test runner.

---

## Running Tests

```bash
bun run check          # typecheck + test
bun run test           # tests only
bun run typecheck      # typecheck only
```

## Architecture

Tests call the real Elysia app via `app.handle()` and Eden Treaty — **no HTTP server needed**.

```
Test File → Eden Treaty / authedRequest() → app.handle() → Real business logic → Isolated temp data dir
```

### Data Isolation

`EIGEN_DATA_ROOT` env var in `apps/api/src/lib/config/paths.ts` points to a temp directory (`data/test-<timestamp>`). Each test run gets a fresh directory, cleaned up in `afterAll`.

### Two Test Users

| User | Email | Purpose |
|------|-------|---------|
| Alice | `alice@test.eigen.is` | Primary — owns files, creates content |
| Bob | `bob@test.eigen.is` | Secondary — tests sharing, ACL, isolation |

Users are created via `auth.api.signUpEmail()` (falls back to `signInEmail()` if already exists). Session tokens are extracted from `set-cookie` headers.

## Test Files

| File | Tests | Count |
|------|-------|-------|
| `auth.test.ts` | Health check, root route, auth required, Alice/Bob access | 6 |
| `drive.test.ts` | Mounts, folders (CRUD), files (upload/download/rename/move/delete), image upload, sharing & ACL (read/write/revoke), docs, stickies, breadcrumb, permissions | 31 |
| `home.test.ts` | Size structure, used=sum, Bob isolation | 3 |
| `contacts.test.ts` | Contact CRUD, labels CRUD, cross-user isolation, me endpoint | 10 |
| `mail.test.ts` | Mailbox listing, create mailbox, Bob isolation | 3 |

**Total: 51 tests**

## Key Implementation Details

- **Concurrency**: Tests run with `--concurrency 1` because test files share SQLite connections via the `Home` singleton
- **Drive routes**: Use `authedRequest()` helper with raw `app.handle()` for mount-specific routes (avoids Treaty's strict string literal typing for dynamic `:mountId` params)
- **Treaty**: Used for routes with static path segments (mounts list, home size, shared-with-me)
- **Contacts**: `addContact`/`addLabel` return plain UUID strings, not JSON objects
- **Contacts init**: Auto-seeds the user themselves as a contact + default labels on first access

## Scripts

### Root `package.json`

```json
"test": "bun --filter '@apps/api' test",
"check": "bun run typecheck && bun run test"
```

### `apps/api/package.json`

```json
"test": "bun test --preload ./src/test/preload.ts --concurrency 1 ./src/test/"
```
