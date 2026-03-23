# Testing

> **TLDR**: API integration tests using Bun test runner + real Elysia app via `app.handle()` + Eden Treaty. No HTTP
> server needed. Temp data dir per run. Test users: Alice, Bob. Run: `bun run test`. Tests in `apps/api/src/test/`.

## Running

```bash
bun run check      # typecheck + test
bun run test       # tests only
bun run typecheck  # typecheck only
```

## Architecture

```
Test → Eden Treaty / authedRequest() → app.handle() → Real business logic → Temp data dir
```

- **Data isolation**: `EIGEN_DATA_ROOT` points to `data/test-<timestamp>`, cleaned up in `afterAll`
- **Test users**: Alice (`alice@test.eigen.is`), Bob (`bob@test.eigen.is`), Charlie (`charlie@test.eigen.is`)
- **Concurrency**: `--concurrency 1` (shared SQLite via Home singleton)
- **Setup**: `apps/api/src/test/setup.ts` creates temp dir, runs setup, creates users

## Test Files

| File                          | Tests                                                      |
|-------------------------------|------------------------------------------------------------|
| `auth.test.ts`                | Health, auth required, user access                         |
| `drive.test.ts`               | Mounts, folders, files, sharing, ACL, docs, stickies       |
| `home.test.ts`                | Size, isolation                                            |
| `contacts.test.ts`            | CRUD, labels, isolation                                    |
| `mail.test.ts`                | Mailboxes, drafts, moves, deletes, isolation               |
| `mail-imap.test.ts`           | Maildir format, flags, sync, simulated Dovecot             |
| `chat.test.ts`                | Messages, whispers, commands, read-only ACL                |
| `collab.test.ts`              | Yjs operations, storage                                    |
| `calendar.test.ts`            | Calendars, events, recurrence, sharing                     |
| `calendar-invites.test.ts`    | Invite propagation, RSVP, cancellation, linked event guard |
| `org.test.ts`                 | Org, teams, roles                                          |
| `org-drive.test.ts`           | Team drives, team ACL                                      |
| `sse.test.ts`                 | SSE endpoint, events                                       |
| `setup.test.ts`               | Setup wizard                                               |
| `delete-user.test.ts`         | User deletion, admin permissions, data cleanup             |
| `settings.test.ts`            | Server settings, admin access control                      |
| `share-registry.test.ts`      | Share registry push/pull, reconciliation                   |
| `team-calendar-share.test.ts` | Team calendar sharing                                      |
| `acl-bubbling.test.ts`        | Chat invite ACL bubbling to container                      |
| `calendar-timezone.test.ts`   | Timezone-aware recurrence expansion                        |
| `command-validation.test.ts`  | Chat command validation                                    |
| `comment-index.test.ts`       | Comment index CRUD, mentions                               |
| `effective-members.test.ts`   | Effective member resolution                                |
| `integration.test.ts`         | Cross-domain integration                                   |
| `json-store.test.ts`          | JsonStore read/write                                       |
| `preview.test.ts`             | File preview endpoints                                     |
| `public.test.ts`              | Public routes, avatars                                     |
| `editor.test.ts`              | Inline text editing                                        |
| `mount.test.ts`               | Mount storage backends                                     |
| `org-home.test.ts`            | Org/team Home lifecycle                                    |
| `sharing-restricted.test.ts`  | Sharing restriction enforcement                            |
| `storage.test.ts`             | Storage backend operations                                 |

## Key Details

- **Treaty**: Used for static path routes. `authedRequest()` for dynamic `:mountId` params
- **Contacts**: `addContact`/`addLabel` return plain UUID strings. Auto-seeds user as contact on first access
