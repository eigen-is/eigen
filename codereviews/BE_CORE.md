# BE Code Review: Core Infrastructure

## Summary

The core backend infrastructure provides a well-designed foundation with clear separation of concerns: the Home
singleton pattern, ManagedDatabase lifecycle management, pluggable storage backends, and a quota/enforcement system. The
architecture is thoughtful and appropriate for a self-hosted product. However, there are several issues ranging from
critical race conditions in the singleton lifecycle to missing security controls (no rate limiting, no CSRF, no path
validation on S3 keys), a missing `await` pattern concern in the share registry, and a secret-generation fallback that
silently weakens authentication. The overall quality is high, but the issues below should be addressed before production
use.

---

## Critical Issues

### 1. Race condition between Home destruct and re-acquisition

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/home/home.ts` (lines 78-86) and
`/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/home/get-home.ts` (lines 14-60)

When the 5-minute inactivity timer fires, `touch()` calls `cleanUp` (which deletes the factory from the map) and then
calls `this.destruct()`. But `destruct()` is async and not awaited (the timeout callback returns the Promise without
awaiting it). During the time `destruct()` is running, a new request could arrive, call `getHome()`, and create a new
Home while the old one is still closing databases. This creates two problems:

- The old Home's `destruct()` could close databases that the new Home is trying to open (since they share the same file
  paths).
- The `createAsyncSingleton` in `getHome` caches the resolved instance permanently. Once `cleanupHomeFactory` removes
  it, a new singleton is created, but the old singleton's closure still references stale state.

**Impact**: Potential database corruption or "Database not open" errors under moderate load.

**Fix**: Make `destruct()` synchronous with the cleanup. Either: (a) mark the Home as "destructing" and have `getHome`
wait for destruction to complete before re-creating, or (b) await the destruct in the timeout handler and only then
remove from the factory map:

```typescript
this.timeout = setTimeout(async () => {
    await this.destruct();
    this.cleanUp?.();
}, 1000 * 60 * 5);
```

### 2. Auth secret falls back to random UUID on every restart

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/auth/auth.ts` (line 98)

```typescript
secret: getServerConfig()?.secret || crypto.randomUUID(),
```

Before setup is completed, `getServerConfig()` returns `null`, so the secret becomes a random UUID. This means:

- Every server restart before setup invalidates all sessions (the secret changes).
- If `config.json` is ever lost or corrupted, the same thing happens post-setup.
- The fallback uses `crypto.randomUUID()` (122 bits of entropy), which is fine entropy-wise but the transience is the
  problem.

**Impact**: Silent session invalidation; potential for session-related issues if config file is lost.

**Fix**: Log a warning when falling back to a random secret. Consider persisting the generated secret immediately so
restarts are consistent, or fail loudly if post-setup the config is missing.

### 3. Auth macro throws generic `Error` instead of `ApiError` -- clients get 500 for unauthenticated requests

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/auth.ts` (line 25)

```typescript
throw new Error("Unauthorized");
```

The global error handler in `app.ts` only sets a proper status code for `ApiError` instances. A plain `Error` will
result in a 500 status code with "Internal server error" message instead of 401.

**Impact**: Clients receive 500 instead of 401 for unauthenticated requests to protected routes.

**Fix**: Change to `throw new ApiError(401, "Unauthorized");`

---

## Pattern Violations

### 1. `toLocaleLowerCase` vs `toLowerCase` inconsistency

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/user/user.ts` (line 8)

Uses `email.toLocaleLowerCase()` which is locale-sensitive (e.g., Turkish locale converts `I` to a different character
than `i`). All other email normalization in the codebase uses `.toLowerCase()`. This could cause lookup mismatches if
the server locale changes.

**Fix**: Use `.toLowerCase()` consistently for email normalization.

### 2. `parseOwnerId` returns a non-null result with empty `id` instead of null

**File**: `/Users/reinder/Documents/GitHub/eigen/packages/lib/src/types/owner.ts` (lines 7-30)

When the UUID validation fails, it returns `{type: 'user', id: ''}` instead of `null` or throwing. The `getHome`
function in `get-home.ts` line 18 checks `if (!parsed)` but this never triggers since `parseOwnerId` never returns a
falsy value. An invalid ownerId like `../../etc/passwd` would pass the null check, hit the `user` case, and call
`getUserById('')` which returns null, leading to a 404. While this ultimately fails safely, the validation gap means
malformed IDs are processed further than necessary.

Additionally, the UUID regex `/^[0-9a-fA-Z]{32}$/i` uses `a-fA-Z` (all letters A-Z) instead of `a-fA-F` (hex digits
only). This means any 32-character alphanumeric string passes validation, not just UUIDs. While better-auth generates
proper UUIDs, this weak validation could mask bugs.

**Fix**: Fix the regex to `/^[0-9a-fA-F]{32}$/` and have `parseOwnerId` return `null` for invalid inputs, or throw.

### 3. Home constructor uses `!` (definite assignment) assertions

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/home/home.ts` (lines 24-31)

The base `Home` class declares `homeDir!`, `fs!`, `settings!`, `_drive!`, `_contacts!`, `_mail!`, `_calendar!` with
definite assignment assertions. These are set by subclasses in their constructors, which is fine, but accessing
`this.mail` or `this.contacts` on a `TeamHome` (which never sets them) returns `undefined` and then calling methods on
`undefined` would throw a confusing runtime error.

The `destruct()` method uses optional chaining (`this._contacts?.destruct()`) which mitigates this for cleanup, but the
public getters (`get contacts()`, `get mail()`) have no guard.

**Fix**: Either make the getters throw `ApiError(404, 'Service not available')` for services not supported by the Home
subclass, or make the types nullable.

---

## Security Concerns

### 1. No rate limiting on any endpoint

**Files**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/app.ts`, all route files

There is no rate limiting on authentication endpoints (`/auth/*`), the public API (`/p/*`), the waitlist endpoint, or
the setup endpoint. This makes the server vulnerable to:

- Brute-force password attacks via `/auth/sign-in/email`
- Denial of service via expensive operations (e.g., `/home/:ownerId/size`, which recursively calculates directory sizes)
- Waitlist email spam via `/p/waitlist`

**Impact**: High for brute-force attacks on auth; medium for DoS.

**Fix**: Add Elysia rate-limiting plugin at minimum on auth and public endpoints.

### 2. No CSRF protection

**Files**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/auth.ts`,
`/Users/reinder/Documents/GitHub/eigen/apps/api/src/app.ts`

better-auth provides CSRF protection by default, but the CORS configuration allows credentials from 14+ trusted origins
including all localhost ports. There is no explicit CSRF token validation for state-changing operations outside
better-auth's scope (e.g., settings updates, team operations).

**Impact**: Medium -- mitigated by CORS origin checks, but any XSS on a trusted origin could perform state-changing
operations.

### 3. Setup endpoint has no authentication and no protection against re-invocation race

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/setup.ts`

The setup endpoint checks `isSetupRequired()` internally, but this is a TOCTOU race: two simultaneous requests could
both pass the check and run setup twice. The second would fail on user creation (duplicate email) but could leave
partial
state.

**Impact**: Low in practice (setup happens once), but the endpoint is permanently exposed without auth.

**Fix**: Add a mutex/lock to `completeSetup`, or disable the route after setup.

### 4. S3Storage has no path traversal protection

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/storage/s3-storage.ts` (lines 40-42)

The `getKey` method simply concatenates prefix + key without any traversal check:

```typescript
private getKey(key: string): string {
    return this.prefix ? `${this.prefix}/${key}` : key;
}
```

While S3 does not have a filesystem hierarchy (so `..` is technically just a literal key), a key like
`../other-prefix/secret` could escape the intended prefix namespace in S3 if the bucket is shared.

**Contrast**: `LocalKeyStorage` and `LocalStorage` both have explicit path traversal checks.

**Fix**: Validate that the key does not contain `..` segments, or normalize and verify the key stays within the prefix.

### 5. Waitlist endpoint sends to hardcoded email with unsanitized content

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/space/waitlist.ts` (lines 28-37)

The waitlist endpoint sends notification emails to a hardcoded personal address. The `notes` field is HTML-escaped for
`<` and `>` but not for other injection vectors. The email HTML template interpolates `${email}` and `${notes}`
directly.

**Impact**: Low (only affects the admin's email client), but still a code smell.

**Fix**: Use a proper HTML escaping library or text-only emails. Make the recipient configurable.

### 6. Public avatar endpoint allows user enumeration

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/public.ts` (line 22)

The `/p/user/:emailOrId` endpoint returns user info (name, email) without authentication. This allows anyone to
enumerate all users by email or ID.

**Impact**: Medium for a self-hosted product. Acceptable if intentional (noted in PUBLIC-API.md), but worth documenting
as a conscious decision.

### 7. No input sanitization on `userId` / `teamId` / `orgId` in path construction

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/config/paths.ts` (lines 16-25)

`getUserHomePath`, `getTeamDataPath`, and `getOrgDataPath` directly interpolate IDs into filesystem paths:

```typescript
export function getUserHomePath(userId: string): string {
    return path.join(getDataRoot(), 'home', userId);
}
```

If an attacker could control `userId` (e.g., via a crafted session), they could inject `../../etc` to escape the data
directory. In practice, `userId` comes from better-auth which generates UUIDs, and `teamId`/`orgId` similarly. But the
defense-in-depth principle suggests validating the format before using it in paths.

**Fix**: Add a UUID format check in these functions, or rely on `parseOwnerId` validation being fixed (see Pattern
Violations #2).

---

## Data Integrity

### 1. ManagedDatabase migrations run without a transaction

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/core/managed-database.ts` (lines 81-97)

Migrations run one at a time, each calling `migration.up(this.rawDb)` followed by a version update. If a migration
partially succeeds (e.g., creates one table but fails on the next statement), the version is not updated, so the
migration will re-run on next startup. But the already-created table will cause `CREATE TABLE` to fail unless all DDL
uses `IF NOT EXISTS`.

All existing migrations use `CREATE TABLE IF NOT EXISTS` (checked in share/db-config.ts, and the pattern is consistent),
so this is mitigated. But it is a latent risk for future migrations that include data transforms or ALTER TABLE
statements.

**Impact**: Low currently, high risk for future non-idempotent migrations.

**Fix**: Wrap each migration in a transaction:

```typescript
this.rawDb.run('BEGIN');
try {
    migration.up(this.rawDb);
    this.rawDb.run('UPDATE __schema_version SET version = ?', [migration.version]);
    this.rawDb.run('COMMIT');
} catch (e) {
    this.rawDb.run('ROLLBACK');
    throw e;
}
```

### 2. WAL checkpoint during sync could conflict with concurrent reads

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/core/managed-database.ts` (line 112)

`PRAGMA wal_checkpoint(TRUNCATE)` is called during sync. `TRUNCATE` mode waits for all readers to finish and then
truncates the WAL. With concurrent requests, this could block or be blocked by long-running reads. `PASSIVE` mode would
be safer for periodic checkpoints (it skips busy pages), reserving `TRUNCATE` for close only.

**Impact**: Potential request latency spikes under load.

**Fix**: Use `PRAGMA wal_checkpoint(PASSIVE)` in `sync()`, keep `TRUNCATE` in `close()`.

### 3. JsonStore atomic write has a gap

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/core/json-store.ts` (lines 58-69)

The `save()` method writes to a `.tmp` file and then renames. This is the correct atomic-write pattern. However,
`this.data` is updated in `set()` (line 59) *before* `save()` is called. If `save()` fails (e.g., disk full), the
in-memory state diverges from the on-disk state. Subsequent reads return the new data, but a restart would revert to the
old data.

**Impact**: Low -- disk-full scenarios are unlikely on a self-hosted server, but the inconsistency could be confusing.

**Fix**: Only update `this.data` after `save()` succeeds, or catch and revert on failure.

### 4. `createAsyncSingleton` never resets instance after factory resolves

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/utils/singleton.ts` (lines 3-28)

The singleton factory correctly resets `initializationPromise` on error (line 23), allowing retry. But if the factory
succeeds, `instance` is set permanently. There is no mechanism to invalidate or destroy the instance. Combined with the
`getHome` lifecycle (which removes the factory on cleanup), this means: if a Home is destroyed, the factory is removed,
a new factory is created, but the old singleton within the removed factory is orphaned with its cached instance.

This is actually fine because the outer `homeFactories` Map in `get-home.ts` is the authority -- deleting the entry
forces a new `createAsyncSingleton` to be created. But the orphaned closure retains a reference to the old Home, which
could prevent garbage collection if any code holds a reference to the old singleton function.

**Impact**: Minor memory leak potential.

---

## Code Quality

### 1. Dead middleware file

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/middlewares/auth-middleware.ts`

This file defines `userMiddleware` and `userInfo` but is not imported anywhere in the codebase. The actual auth
middleware is the `betterAuth` macro in `routes/auth.ts`. This is dead code.

**Fix**: Delete the file.

### 2. `readdir` uses `any` return type

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/core/local-filesystem.ts` (line 134)

```typescript
async readdir(dirPath: string, options?: { withFileTypes?: boolean }): Promise<any[]> {
```

Uses `any` in the return type and casts options to `any`. This violates the project rule against `as any`.

**Fix**: Use proper overload signatures or union return type.

### 3. Duplicate Drizzle DB instance for auth

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/auth/auth.ts` (lines 42, 120-140)

The `betterAuth` configuration creates its own Drizzle instance (line 42), and `getAuthDrizzleDb()` creates a separate
one (line 124). Both point to the same `users3.db` file. Since Bun SQLite uses WAL mode by default, this works, but it
means two separate connection objects to the same database, which doubles memory usage for the connection and could
cause
subtle issues with transaction isolation.

**Fix**: Share a single Drizzle instance between better-auth and application queries, or document why separate instances
are needed.

### 4. Inconsistent async function declarations in reconciliation

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/share/reconciliation.ts` (lines 50-66)

`pullCalendarShares` and `pullPendingInvitations` are declared `async` but contain no `await` expressions. The
underlying calls (`getSharedWith`, `receiveShare`, `receiveInvitation`) are synchronous. This is misleading -- the
functions should either drop the `async` keyword or the callers should verify whether the callees truly need awaiting.

---

## Architecture

### 1. Home singleton lifecycle is sound but fragile

The `Home -> getHome -> createAsyncSingleton -> cleanupHomeFactory` lifecycle works for the current use case but has the
race condition noted in Critical Issues #1. The 5-minute inactivity timeout is appropriate for a self-hosted server.

The hierarchy `Home -> UserHome / TeamHome / OrgHome` is clean. TeamHome correctly limits services to Drive + Calendar.
OrgHome is minimal (no services). The use of `declare` in subclasses to narrow the settings type is a reasonable
TypeScript pattern.

### 2. Storage backend abstraction is well-designed

The `StorageBackend` interface is minimal and clean. The optional methods (`getPath`, `mkdir`, `rename`, `deleteDir`)
are
correctly typed as optional, since they only make sense for local storage. Path traversal is consistently checked in
local backends.

### 3. Quota system is appropriately layered

`ServerSettings -> resolveUserQuotas (with team overrides) -> enforcement` is a clean three-tier design. The "most
permissive wins" policy for team overrides is clearly documented and implemented. The enforcement functions correctly
check both per-file limits and aggregate quotas.

### 4. Share registry is a good design choice

The push-based sharing with pull-based reconciliation is architecturally sound. The registry stores minimal data (just
`fromUserId -> targetIdentifier` pairs), and domain-specific pull functions handle the actual data transfer. This keeps
the registry lightweight and domain-agnostic.

### 5. Config loading uses module-level `await`

**Files**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/config/server-config.ts` (line 83),
`/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/config/server-settings.ts` (line 55)

Both config modules use top-level `await ensureLoaded()`. This is elegant and ensures config is loaded before any route
handler runs. However, it means import order matters: if any module imports `server-settings.ts` before
`server-config.ts` is loaded, the settings module may read stale config values when determining the default storage
type.
Currently this works because Bun resolves imports depth-first, but it is an implicit coupling.

---

## Performance

### 1. `resolveUserQuotas` creates a Home for every team membership on every check

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/config/quota.ts` (lines 21-29)

For each team the user belongs to, `resolveUserQuotas` calls `getHome(teamOwnerId(teamId))`, which creates (or retrieves
from cache) a full TeamHome including Drive and Calendar initialization. This happens on every file upload quota check.

For a user in 5 teams, this is 5 `getHome` calls per upload. While the singletons cache makes subsequent calls fast, the
first call for each team initializes Drive + Calendar for teams that may never be accessed otherwise.

**Impact**: Increased startup latency for first upload after server restart.

**Fix**: Consider a lightweight settings-only accessor for team quota overrides that does not require full Home
initialization.

### 2. `dirSize` is recursively calculated on every call

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/core/local-filesystem.ts` (lines 115-132)

`dirSize` walks the entire directory tree with sequential async stat calls. For a drive with thousands of files, this
could take hundreds of milliseconds. It is called from `Home.size()` and from quota enforcement.

**Impact**: Latency on `/home/:ownerId/size` endpoint and during file uploads when quota is near the limit.

**Fix**: Consider caching directory sizes and updating incrementally on file add/delete, or use Bun's `glob` for faster
directory walking.

### 3. `getMemberships` queries two tables per call with no caching

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/user/user.ts` (lines 29-38)

Every call to `getMemberships` runs two separate queries against the auth database. This is called from quota
resolution, access checks, and ACL operations. For a single request that checks access and then enforces quotas, this
could be 2+ calls to `getMemberships`.

**Fix**: Cache memberships per-request (e.g., via Elysia's derive/resolve), or cache with a short TTL.

---

## Positive Patterns

1. **Path traversal protection is consistent across local storage backends.** `LocalFilesystem`, `LocalKeyStorage`, and
   `LocalStorage` all validate that resolved paths stay within their base directory. This is a strong security pattern.

2. **The `createAsyncSingleton` utility** correctly handles concurrent initialization (multiple callers get the same
   Promise) and error recovery (failed init resets the Promise for retry). This is a clean implementation.

3. **Atomic file writes in `JsonStore`** using write-to-temp-then-rename is the correct pattern for preventing data
   corruption on crash.

4. **The enforcement module** is well-separated from quota resolution. `enforceFileUpload`, `enforceBatchUpload`, and
   `enforceAvatarUpload` are clean, focused functions with clear error messages.

5. **The SSE implementation** in `sse.ts` correctly handles cleanup (unsubscribe listener, clear keepalive interval) in
   the `cancel` handler, and guards against writing to closed streams.

6. **The `requireSelf` / `requireTeamAccess` / `requireTeamAdmin` access control functions** provide a clean,
   composable authorization layer. Their consistent use across routes is good.

7. **ManagedDatabase's dirty tracking** via `total_changes()` is an efficient way to avoid unnecessary syncs, especially
   for remote storage backends.

8. **The setup wizard** properly generates a cryptographically strong secret (`randomBytes(32).toString('base64')`) and
   stores it in the server config.

---

## Recommendations

### P0 (Fix immediately)

| # | Issue                                                                                         | File                              | Line(s) |
|---|-----------------------------------------------------------------------------------------------|-----------------------------------|---------|
| 1 | Auth macro throws `Error` instead of `ApiError(401)` -- clients get 500 for unauthed requests | `apps/api/src/routes/auth.ts`     | 25      |
| 2 | Race condition between Home destruct and re-creation                                          | `apps/api/src/lib/home/home.ts`   | 78-86   |
| 3 | `parseOwnerId` UUID regex allows all alphanumeric, not just hex                               | `packages/lib/src/types/owner.ts` | 24      |

### P1 (Fix before production)

| #  | Issue                                                              | File                                        | Line(s) |
|----|--------------------------------------------------------------------|---------------------------------------------|---------|
| 4  | No rate limiting on auth or public endpoints                       | `apps/api/src/app.ts`                       | --      |
| 5  | S3Storage has no path/key validation                               | `apps/api/src/lib/storage/s3-storage.ts`    | 40-42   |
| 6  | Auth secret silently falls back to random UUID on config loss      | `apps/api/src/lib/auth/auth.ts`             | 98      |
| 7  | `toLocaleLowerCase` vs `toLowerCase` inconsistency for emails      | `apps/api/src/lib/user/user.ts`             | 8       |
| 8  | Migrations run without transaction wrapping                        | `apps/api/src/lib/core/managed-database.ts` | 81-97   |
| 9  | Use `PASSIVE` WAL checkpoint in sync, reserve `TRUNCATE` for close | `apps/api/src/lib/core/managed-database.ts` | 112     |
| 10 | No input sanitization on IDs used in filesystem paths              | `apps/api/src/lib/config/paths.ts`          | 16-25   |
| 11 | Duplicate Drizzle DB connections to users3.db                      | `apps/api/src/lib/auth/auth.ts`             | 42, 124 |

### P2 (Improve when convenient)

| #  | Issue                                                                           | File                                          | Line(s) |
|----|---------------------------------------------------------------------------------|-----------------------------------------------|---------|
| 12 | Delete dead `auth-middleware.ts`                                                | `apps/api/src/middlewares/auth-middleware.ts` | all     |
| 13 | Fix `readdir` return type from `any[]`                                          | `apps/api/src/lib/core/local-filesystem.ts`   | 134     |
| 14 | Guard `Home` getters for unsupported services (mail/contacts on TeamHome)       | `apps/api/src/lib/home/home.ts`               | 48-51   |
| 15 | Cache `getMemberships` per-request to avoid redundant queries                   | `apps/api/src/lib/user/user.ts`               | 29-38   |
| 16 | Cache `dirSize` or compute incrementally                                        | `apps/api/src/lib/core/local-filesystem.ts`   | 115-132 |
| 17 | `resolveUserQuotas` initializes full TeamHome just to read settings             | `apps/api/src/lib/config/quota.ts`            | 21-29   |
| 18 | `JsonStore.set()` updates memory before confirming disk write                   | `apps/api/src/lib/core/json-store.ts`         | 58-62   |
| 19 | Remove hardcoded personal email in waitlist                                     | `apps/api/src/lib/space/waitlist.ts`          | 27      |
| 20 | `parseOwnerId` should return `null` for invalid IDs, not `{type:'user', id:''}` | `packages/lib/src/types/owner.ts`             | 25-26   |
