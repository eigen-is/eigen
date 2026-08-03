# Testing

> **TLDR**: API integration tests using Bun test runner + real Elysia app via `app.handle()` + Eden Treaty. No HTTP
> server needed. Temp data dir per run. Test users: Alice, Bob, Charlie. Run: `bun run test`. Tests in
> `apps/api/src/test/`.

## Running

```bash
bun run check              # lint + typecheck + test (all workspaces)
bun run test               # tests only (all workspaces)
bun run test:api           # API tests only
bun run test:sheet         # sheet package unit tests only
bun run typecheck          # typecheck only
bun run lint               # lint + format check (biome)
```

The API test command (in `apps/api/package.json`) is:

```bash
bun test --preload ./src/test/preload.ts --concurrency 1 ./src/test/
```

- `--preload ./src/test/preload.ts` registers an `afterAll` hook that calls `cleanup()`
- `--concurrency 1` required because tests share SQLite via the Home singleton

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

| File                          | Tests                                                      |
|-------------------------------|------------------------------------------------------------|
| `acl-bubbling.test.ts`        | Chat invite ACL bubbling to container                      |
| `auth.test.ts`                | Health, auth required, user access                         |
| `calendar.test.ts`            | Calendars, events, recurrence, sharing                     |
| `calendar-invites.test.ts`    | Invite propagation, RSVP, cancellation, linked event guard |
| `calendar-timezone.test.ts`   | Timezone-aware recurrence expansion                        |
| `chat.test.ts`                | Messages, whispers, commands, read-only ACL                |
| `collab.test.ts`              | Yjs operations, storage                                    |
| `command-validation.test.ts`  | Chat command validation                                    |
| `comment-index.test.ts`       | Comment index CRUD, mentions                               |
| `contacts.test.ts`            | CRUD, labels, isolation                                    |
| `delete-user.test.ts`         | User deletion, admin permissions, data cleanup             |
| `document-transform.test.ts`  | Off-thread sheet preview: Worker equivalence, warnings, cache behavior |
| `document-transform-runner.test.ts` | Transform runner: concurrency, priorities, overload, timeout, crash, cancel, shutdown |
| `drive.test.ts`               | Mounts, folders, files, sharing, ACL, docs, stickies       |
| `editor.test.ts`              | Inline text editing                                        |
| `effective-members.test.ts`   | Effective member resolution                                |
| `home.test.ts`                | Size, isolation                                            |
| `integration.test.ts`         | Cross-domain integration                                   |
| `json-store.test.ts`          | JsonStore read/write                                       |
| `mail.test.ts`                | Mailboxes, drafts, moves, deletes, isolation               |
| `mail-imap.test.ts`           | Maildir format, flags, sync, simulated Dovecot             |
| `mail-parser.test.ts`         | Email parsing (plain, HTML, multipart, attachments)        |
| `mount.test.ts`               | Mount storage backends                                     |
| `org.test.ts`                 | Org, teams, roles                                          |
| `org-drive.test.ts`           | Team drives, team ACL                                      |
| `org-home.test.ts`            | Org/team Home lifecycle                                    |
| `preview.test.ts`             | File preview endpoints                                     |
| `public.test.ts`              | Public routes, avatars                                     |
| `settings.test.ts`            | Server settings, admin access control                      |
| `share-registry.test.ts`      | Share registry push/pull, reconciliation                   |
| `sheets-preview.test.ts`      | Eigensheets preview golden hash + budget contract          |
| `sharing-restricted.test.ts`  | Sharing restriction enforcement                            |
| `sse.test.ts`                 | SSE endpoint, events                                       |
| `storage.test.ts`             | Storage backend operations                                 |
| `streaming-upload.test.ts`    | Streaming file upload, multi-file upload                   |
| `team-calendar-share.test.ts` | Team calendar sharing                                      |
| `yjs-loader.test.ts`          | Yjs capture/materialize split, corruption equivalence      |

Not part of the suite: `src/test/transform-benchmark.ts` is a standalone responsiveness/memory benchmark for
document transforms — run it from `apps/api` with `bun src/test/transform-benchmark.ts` (see PREVIEWS.md).

## Key Details

- **Treaty**: Used for static path routes. `authedRequest()` for dynamic `:mountId` params
- **Contacts**: `addContact`/`addLabel` return plain UUID strings. Auto-seeds user as contact on first access

## CI

Tests run in GitHub Actions via `.github/workflows/check.yml` on push/PR to `main`:

```yaml
steps:
  - bun install --frozen-lockfile
  - bun run lint
  - bun run typecheck
  - bun --filter '*' test
```

The CI job runs on `ubuntu-latest` with a 15-minute timeout.
