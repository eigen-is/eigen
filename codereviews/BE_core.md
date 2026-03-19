# Backend Review: Core (Auth, Home, Config, Setup, SSE)

**Scope:** `apps/api/src/lib/{core,config,auth,home,setup,org,team,user}/`, `apps/api/src/utils/`, routes (`auth.ts`,
`home.ts`, `settings.ts`, `setup.ts`, `team.ts`, `sse.ts`), storage backends, related tests
**Date:** 2026-03-19

---

## Architecture Overview

The backend core follows a layered architecture centered on the **Home singleton** pattern:

1. **Home hierarchy** (`apps/api/src/lib/home/`): `Home` is the base class managing per-user/per-team/per-org state.
   `UserHome` (full services: Drive, Mail, Contacts, Calendar), `TeamHome` (Drive + Calendar only), and `OrgHome` (
   minimal) extend it. Homes are created via `getHome(ownerId)` which dispatches based on the `parseOwnerId()` result.
   Each Home manages its own filesystem root, domain class instances, settings, managed databases, and SSE listeners.
   Homes auto-destruct after 5 minutes of inactivity via the `touch()` timer.

2. **Singleton management** (`apps/api/src/utils/singleton.ts`): `createAsyncSingleton()` ensures each Home/database is
   initialized exactly once. The factory Map in `get-home.ts` stores one singleton factory per `ownerId`.

3. **ManagedDatabase** (`apps/api/src/lib/core/managed-database.ts`): Wrapper around Bun's SQLite with WAL mode,
   versioned migrations, dirty tracking, and periodic sync callbacks. Used for all domain databases.

4. **Config layer** (`apps/api/src/lib/config/`): `ServerConfig` (identity, storage type, secret) and `ServerSettings` (
   quotas, defaults) are stored as JSON files via `JsonStore`. Loaded at module import time via top-level `await`.

5. **Auth** (`apps/api/src/lib/auth/auth.ts`): better-auth with email/password, 2FA, organizations, and teams. Database
   hook auto-joins new users to the default org and reconciles pending shares.

6. **Storage backends** (`apps/api/src/lib/storage/`): `LocalKeyStorage` (flat UUID-keyed files), `LocalStorage` (
   directory hierarchy), `S3Storage` (S3-compatible). All implement `StorageBackend` interface.

7. **Routes**: Thin Elysia routers. Auth middleware via `betterAuth` macro with `{auth: true}`. Global error handler
   converts `ApiError` to proper HTTP responses.

**Data flow for a typical authenticated request:**
Request -> Elysia router -> `betterAuth` macro resolves session -> route handler calls `getHome(ownerId)` -> Home
singleton returned/created -> domain class method called -> response returned.

---

## Critical Issues

### C1. Race condition in Home cleanup/recreation lifecycle

- **Files:** `apps/api/src/lib/home/home.ts:78-87`, `apps/api/src/lib/home/get-home.ts:14-60`

When the 5-minute inactivity timeout fires, the `touch()` callback runs:

```typescript
// home.ts:82-85
this.timeout = setTimeout(() => {
    this.cleanUp && this.cleanUp();  // synchronous: removes from homeFactories Map
    return this.destruct();           // async: closes DBs, returns ignored Promise
}, 1000 * 60 * 5);
```

`cleanUp()` calls `cleanupHomeFactory(ownerId)` which synchronously deletes the entry from the `homeFactories` Map.
`destruct()` is async (it awaits database closes), but its returned Promise is not awaited -- the `return` inside a
`setTimeout` callback is meaningless.

If a request for the same `ownerId` arrives between the Map deletion (instant) and the completion of `destruct()` (which
takes time to close multiple databases), `getHome()` creates a new factory and initializes a new Home while the old one
is still tearing down. Two Home instances for the same user would exist simultaneously, potentially opening the same
SQLite databases concurrently. WAL mode handles concurrent reads, but concurrent opens with migrations could corrupt
data.

**Impact:** Potential database corruption or SQLite contention under concurrent requests near the timeout boundary.

**Fix:** Defer the Map deletion until after `destruct()` completes, or use a sentinel value in the Map that makes new
callers wait for destruction to finish:

```typescript
this.timeout = setTimeout(async () => {
    await this.destruct();
    this.cleanUp?.();
}, 1000 * 60 * 5);
```

### C2. `Home.destruct()` opens never-used databases just to close them

- **File:** `apps/api/src/lib/home/home.ts:150-159`

```typescript
for (const [key, getter] of this.managedDatabases) {
    try {
        const db = await getter();  // calls the singleton factory
        await db.close();
    } catch (error) {
        console.error(`Failed to close managed database ${key}:`, error);
    }
}
```

The `managedDatabases` Map stores `createAsyncSingleton(factory)` getters. When a database was registered via
`getLocalDatabase()` but never actually accessed (the singleton was never resolved), calling `getter()` during destruct
triggers the factory -- opening, migrating, and initializing the database just to immediately close it. This creates
unnecessary I/O, extends shutdown time, and could cause errors if the filesystem state has changed.

**Impact:** Slow destruction, unnecessary disk I/O, potential errors during shutdown.

**Fix:** Track resolution state. Only close databases that were actually opened:

```typescript
private resolvedDatabases: Map<string, ManagedDatabase<any>> = new Map();

private async getManagedDatabase<S extends SchemaType>(
    key: string,
    factory: () => Promise<ManagedDatabase<S>>
): Promise<ManagedDatabase<S>> {
    if (!this.managedDatabases.has(key)) {
        const singleton = createAsyncSingleton(async () => {
            const db = await factory();
            this.resolvedDatabases.set(key, db);
            return db;
        });
        this.managedDatabases.set(key, singleton);
    }
    return this.managedDatabases.get(key)!() as Promise<ManagedDatabase<S>>;
}

// In destruct():
for (const [key, db] of this.resolvedDatabases) {
    await db.close();
}
```

---

## Important Issues

### I1. SSE and home/size routes ignore the `:ownerId` URL parameter

- **Files:** `apps/api/src/routes/sse.ts:8,13`, `apps/api/src/routes/home.ts:10-13`

Both routes declare `:ownerId` in the URL pattern but always use `user.id` from the authenticated session:

```typescript
// sse.ts:8,13
.get('/sse/:ownerId/events', async ({user}) => {
    const home = await getHome(user.id);  // params.ownerId ignored

// home.ts:10-11
.get("/home/:ownerId/size", async ({user}) => {
    const home = await getHome(user.id);  // params.ownerId ignored
```

This is security-correct (prevents spoofing -- confirmed by tests at `sse.test.ts:62-72` and `home.test.ts:42-54`), but
it means:

1. **Team SSE is impossible.** A client cannot subscribe to a TeamHome's event stream because the route always resolves
   to the user's personal Home. Team-triggered events (team drive changes, team calendar updates) cannot be delivered
   via SSE.
2. **The URL parameter is misleading.** The API contract suggests owner-scoped behavior, but the implementation ignores
   it.
3. **Inconsistency with other routes.** The drive, calendar, and chat routes properly use `params.ownerId` and validate
   access. The home/SSE routes break this pattern.

**Impact:** Team real-time events are not delivered. API contract is misleading.

**Fix:** Either use `params.ownerId` with proper membership validation (matching the pattern of other routes), or remove
`:ownerId` from the URL to make the API honest about its behavior.

### I2. `home.size()` only reports the default mount

- **File:** `apps/api/src/lib/home/home.ts:105-123`

```typescript
public async
size(teamIds
:
string[] = []
)
{
    const [mail, contacts, driveDefault] = await Promise.all([
        this._mail?.size(),
        this._contacts?.size(),
        this._drive.size('default')  // only default mount
    ]);
    // ...
    return {
        drive: {default: {used: driveDefault, max: quotas.mountMax}},
        total: {used: mailAndContactsUsed + driveDefault, ...},
    };
}
```

For teams with multiple mounts (created via `TeamHome.addMount()`), non-default mount storage is excluded from both the
response and `total.used`. The quota resolution also only considers the default mount's config.

**Impact:** Storage reporting is inaccurate for multi-mount configurations. Users/admins see incorrect usage figures.

**Fix:** Iterate all mounts, aggregate sizes, and include per-mount quotas in the response.

### I3. `enforceAvatarUpload` assumes a 'default' mount exists

- **File:** `apps/api/src/lib/config/enforcement.ts:46`

```typescript
export async function enforceAvatarUpload(userId: string, fileSize: number): Promise<void> {
    // ...
    const {home, quotas} = await resolveQuotas(userId, userId, 'default');
```

`resolveQuotas` calls `home.drive.getMountConfig('default')`. For `TeamHome` instances (which start with no mounts),
this would throw `ApiError(404, 'Mount not found: default')`. In practice, avatar uploads are only for real users (who
always have a default mount via `UserHome.init()`), but the assumption is fragile and would break if the function were
called in a team context.

**Impact:** Potential 404 error in edge cases.

**Fix:** Guard against missing mount or use a mount-independent quota check for avatars.

### I4. `getOrgRole` does not filter by organization ID

- **File:** `apps/api/src/lib/user/user.ts:41-45`

```typescript
export async function getOrgRole(userId: string): Promise<string | null> {
    const db = getAuthDrizzleDb();
    const row = await db.select({role: member.role}).from(member)
        .where(eq(member.userId, userId)).get();
    return row?.role ?? null;
}
```

This queries the `member` table filtered only by `userId`, without filtering by `organizationId`. In the current
single-org setup, this works because each user has exactly one membership row. However, if the system ever supports
multiple organizations (or if stale data exists), `.get()` returns the first matching row, which may be from the wrong
organization.

This function is used for admin authorization in `requireAdmin()` (`routes/settings.ts:9-11`) and `requireTeamAdmin()` (
`routes/team.ts:17-20`). An incorrect role from a different org could grant or deny admin access incorrectly.

**Impact:** Fragile single-org assumption in a security-critical path.

**Fix:** Accept an `orgId` parameter and filter by it:

```typescript
export async function getOrgRole(userId: string, orgId: string): Promise<string | null> {
    const db = getAuthDrizzleDb();
    const row = await db.select({role: member.role}).from(member)
        .where(and(eq(member.userId, userId), eq(member.organizationId, orgId))).get();
    return row?.role ?? null;
}
```

### I5. `parseOwnerId` returns a non-null object for invalid input

- **File:** `packages/lib/src/types/owner.ts:7-30`

```typescript
export function parseOwnerId(ownerId: string): ParsedOwnerId {
    // ...
    const uuidRegex = /^[0-9a-fA-Z]{32}$/i;
    if (!uuidRegex.test(id)) {
        return {type: 'user', id: ''};  // empty id, not null
    }
    return {id, type};
}
```

For invalid inputs (not a valid email, not a valid 32-char alphanumeric ID), the function returns
`{type: 'user', id: ''}`. The caller in `get-home.ts:18` has `if (!parsed)` which is dead code since the function always
returns a truthy object. The flow works by accident: `getUserById('')` returns `null`, triggering a 404.

Additionally, the two `if` statements for `team_` and `org_` prefixes (lines 14 and 18) are not `else if`. If someone
crafted a string starting with `team_org_...`, the `type` variable would be overwritten from `'team'` to `'org'`. This
is harmless in practice but shows fragile logic.

The regex character class `[0-9a-fA-Z]` with the `i` flag effectively matches `[0-9a-zA-Z]`, which is broader than UUID
hex digits but happens to match better-auth's 32-character alphanumeric IDs. The comment "check if id is valid uuid" is
misleading.

**Impact:** Dead code guard in `get-home.ts`. Misleading error message ("User not found" instead of "Invalid ownerId").

**Fix:** Return `null` for invalid input, update the return type to `ParsedOwnerId | null`, use `else if` for prefix
checks, and fix the comment.

### I6. `completeSetup` performs partial work on failure

- **File:** `apps/api/src/lib/setup/setup.ts:194-261`

```typescript
export async function completeSetup(input: SetupInput): Promise<SetupResult> {
    try {
        await initializeDatabaseSchema();   // Step 1: creates tables
        const user = await auth.api.createUser({...});  // Step 2: may fail
        const org = await auth.api.createOrganization({...});  // Step 3: may fail
        await saveServerConfig(serverConfig);  // Step 4: saves config
        // ...
    } catch (error) {
        return { success: false, error: ... };
    }
}
```

If the function fails after `initializeDatabaseSchema()` but before `saveServerConfig()` (e.g., creating the admin user
or org fails), the database schema exists but the config is not saved. The next setup attempt will recreate tables (
using `CREATE TABLE IF NOT EXISTS`) but may encounter duplicate data -- for example, if `auth.api.createUser` succeeded
but `createOrganization` failed, retrying would attempt to create the same user again, potentially failing with a unique
constraint violation on the email.

**Impact:** Setup can get into a stuck state requiring manual cleanup.

**Fix:** Either use a SQLite transaction wrapping all the database operations, or implement idempotent retry logic that
cleans up on failure.

### I7. `Content-Disposition` header injection potential in zip route

- **File:** `apps/api/src/routes/home.ts:24`

```typescript
set.headers['Content-Disposition'] = `attachment; filename="${data.fileName}"`;
```

The `fileName` from `home.getZip()` is interpolated directly into the `Content-Disposition` header without sanitization.
Per CLAUDE.md rules: "Never interpolate raw user input into headers." Currently, `getZip()` always throws
`Error('Not implemented')`, so this code is unreachable. However, when implemented, if `fileName` contains quotes,
newlines, or other control characters, it could enable HTTP response header injection.

**Impact:** None currently (dead code), but a latent vulnerability when `getZip()` is implemented.

**Fix:** Sanitize `fileName` before interpolation, or use RFC 5987 encoding:

```typescript
const safeName = data.fileName.replace(/[^\w\-.]/g, '_');
set.headers['Content-Disposition'] = `attachment; filename="${safeName}"`;
```

---

## Minor Issues

### M1. Redundant `this.user = user` in `UserHome` constructor

- **File:** `apps/api/src/lib/home/user-home.ts:17`

```typescript
constructor(user: User, cleanUp?: () => void) {
    super(user, cleanUp);  // sets this.user = user in Home base class
    this.user = user;       // redundant
```

The `super()` call already sets `this.user` in the `Home` constructor (home.ts:44).

### M2. Console logging of OTP codes

- **File:** `apps/api/src/lib/auth/auth.ts:75`

```typescript
console.log('send otp', user, otp, ctx?.request);
```

This development placeholder logs the full OTP code and user object to stdout. In a deployed environment with log
aggregation, OTP codes would be exposed.

**Fix:** Replace with actual email-sending implementation or remove the OTP value from the log.

### M3. `readdir` method uses `any` return type

- **File:** `apps/api/src/lib/core/local-filesystem.ts:134-137`

```typescript
async readdir(dirPath: string, options?: { withFileTypes?: boolean }): Promise<any[]> {
    const fullPath = this.getFilePath(dirPath);
    return await fsPromises.readdir(fullPath, options as any);
}
```

Returns `Promise<any[]>` and casts options with `as any`. This violates the project rule against `as any`. The method
should use proper overload types or conditional return types.

### M4. `toLocaleLowerCase()` vs `toLowerCase()` inconsistency

- **File:** `apps/api/src/lib/user/user.ts:8`

```typescript
return await db.select().from(user).where(eq(user.email, email.toLocaleLowerCase())).get()
```

`toLocaleLowerCase()` is locale-dependent (e.g., Turkish 'I' rules differ). `parseOwnerId` in `owner.ts:11` uses
`.toLowerCase()`. For email addresses, `toLowerCase()` is correct per RFC 5321.

### M5. WebSocket keepalive does not close the socket

- **File:** `apps/api/src/utils/websockets.ts:10-13`

```typescript
try {
    ws.ping();
} catch (err) {
    clearInterval(pingInterval);
    console.log(`Ping failed, closing connection for user ${user.id}`);
    onClose();  // calls cleanup callback but never ws.close()
}
```

When ping fails, the code calls the `onClose` callback and clears the interval but never calls `ws.close()`. The
underlying WebSocket connection may linger as a half-open connection, consuming resources.

**Fix:** Call `ws.close()` before `onClose()`.

### M6. SSE keepalive event does not conform to `SSEvent` type

- **File:** `apps/api/src/routes/sse.ts:35`

```typescript
controller.enqueue({event: 'keepalive'});
```

The `ReadableStream` is implicitly typed as `ReadableStream<SSEvent>`, but the keepalive object has an `event` property
while `SSEvent` requires `type` and `title`. This is a type safety gap. It works at runtime because Elysia's `sse()`
handles arbitrary objects, but it violates the generic constraint.

### M7. `config/schema.ts` appears unused

- **File:** `apps/api/src/lib/config/schema.ts`

Defines a `systemConfig` SQLite table that is not imported or used anywhere in the codebase. The config system uses
`JsonStore` (JSON files), not SQLite. This is dead code.

### M8. JSDoc comment violates project rules

- **File:** `apps/api/src/lib/user/user.ts:26-28`

```typescript
/**
 * Resolves a user's org and team memberships from the auth database.
 */
```

CLAUDE.md states "No JSDoc -- code should be self-documenting, minimal comments."

### M9. `Home.getZip()` always throws

- **File:** `apps/api/src/lib/home/home.ts:162-164`

```typescript
public async getZip(): Promise<{ data: ArrayBuffer, contentType: string, fileName: string }> {
    throw new Error('Not implemented');
}
```

The route at `routes/home.ts:17-29` catches the error and returns 500. The test at `home.test.ts:56-61` verifies this.
This is dead code providing no functionality.

### M10. `getTeamMembers` silently returns empty array on error

- **File:** `apps/api/src/lib/team/team.ts:14-24`

```typescript
export async function getTeamMembers(teamId: string) {
    try {
        const db = getAuthDrizzleDb();
        return db.select().from(teamMember)
            .innerJoin(user, eq(teamMember.userId, user.id))
            .where(eq(teamMember.teamId, teamId)).all();
    } catch {
        return [];
    }
}
```

The catch block returns `[]` for any error, including database corruption or schema mismatches. This hides real failures
and makes debugging difficult.

### M11. Module-level `await` creates import side effects

- **Files:** `apps/api/src/lib/config/server-config.ts:83`, `apps/api/src/lib/config/server-settings.ts:55`

Both modules use top-level `await ensureLoaded()`. This triggers filesystem I/O and creates directories on import. While
this is a valid Bun pattern, it means the import order matters and testing requires careful environment setup (setting
`EIGEN_DATA_ROOT` before import).

### M12. `S3Storage` has no key sanitization

- **File:** `apps/api/src/lib/storage/s3-storage.ts:40-42`

```typescript
private getKey(key: string): string {
    return this.prefix ? `${this.prefix}/${key}` : key;
}
```

Unlike `LocalKeyStorage` and `LocalStorage` which validate against path traversal, `S3Storage` passes keys through
without any validation. A key like `../other-bucket-prefix/secret` would be sent to S3 unmodified. The risk depends on
whether user input can reach this point (currently keys are system-generated UUIDs), but the inconsistency with local
backends is a defense-in-depth gap.

---

## Strengths

**1. Consistent architecture.** The codebase follows its documented patterns with high fidelity: Home singleton
hierarchy, domain class layout, thin Elysia routers, `ApiError` usage, `type` over `interface`. The consistency makes
the code predictable and easy to navigate.

**2. Comprehensive path traversal protection.** `LocalFilesystem`, `LocalKeyStorage`, and `LocalStorage` all have
explicit `path.resolve()` + `startsWith()` checks in their core path resolution methods. This is a well-implemented
security boundary.

**3. Robust `JsonStore` implementation.** The write-to-tmp-then-rename atomic write pattern (`json-store.ts:64-68`)
ensures crash safety. The `deepMerge` function correctly handles nested objects, null values, and arrays (replaced, not
merged). The comprehensive test suite (`json-store.test.ts`) covers defaults, persistence, deep merge, corrupt JSON
recovery, and multi-instance scenarios.

**4. Well-designed `ManagedDatabase`.** WAL mode with busy timeout handles concurrent access. Versioned migrations with
sequential ordering prevent version skipping. Dirty tracking optimizes sync frequency. The lifecycle (open/sync/close)
is clean with proper resource cleanup including WAL/SHM file deletion.

**5. Solid `createAsyncSingleton` implementation.** The singleton factory correctly handles concurrent initialization (
deduplicates via `initializationPromise`), caches successful results, and clears the promise on failure to allow
retries. This is a subtle pattern that is correctly implemented.

**6. Good error handling architecture.** `ApiError` provides clean user-facing errors with proper HTTP status codes. The
global `onError` handler (`app.ts:47-56`) distinguishes between `ApiError` (returns the message) and unexpected errors (
logs and returns generic message). `Home.destruct()` wraps each domain destruction in individual try/catch blocks (
home.ts:126-149), preventing cascading failures.

**7. Quota system is well-designed.** The `resolveUserQuotas()` function implements "most permissive wins" semantics
across team overrides, which is the correct approach for additive quotas. The enforcement functions (
`enforceFileUpload`, `enforceBatchUpload`) properly check both per-file limits and total storage limits.

**8. Setup flow is well-guarded.** The setup route has proper validation for all required fields, minimum password
length, S3 config requirements when S3 is selected, and an `isSetupRequired()` guard against double-setup.

**9. Auth database hook pattern.** Auto-joining new users to the default org and reconciling pending shares via
`databaseHooks.user.create.after` is an elegant way to handle the "share before user exists" scenario without polling or
manual reconciliation.

---

## Test Coverage Analysis

**Well-covered areas:**

- Auth flow: health check, auth required, session validation, multi-user isolation (`auth.test.ts`)
- Home size: structure validation, user isolation, ownerId spoofing prevention (`home.test.ts`)
- Org infrastructure: setup creates org, admin is owner, auto-join, team CRUD, role management, membership edge cases (
  `org.test.ts`)
- OrgHome: existence checks, getHome resolution, 404 for nonexistent (`org-home.test.ts`)
- Server settings: admin read/write, non-admin rejection, quota updates, storage type changes (`settings.test.ts`)
- Quota enforcement: upload within quota, upload exceeding max size (`settings.test.ts`)
- Team mounts: creation, listing, enable/disable, multiple mounts, member overrides (`settings.test.ts`)
- Quota resolution with team overrides: elevation, clearing, most permissive wins, below-default (`settings.test.ts`)
- SSE: auth required, spoofing, multiple clients, cancellation, cross-user isolation, ACL events (`sse.test.ts`)
- JsonStore: defaults, persistence, deep merge, arrays, corrupt JSON, atomic writes, multi-instance (
  `json-store.test.ts`)
- Storage backends: LocalKeyStorage and LocalStorage CRUD, path traversal rejection (`storage.test.ts`)
- Cross-domain integration: drive+chat, public API, home+drive size, collab permissions (`integration.test.ts`)

**Gaps in test coverage:**

- **`createAsyncSingleton`**: No unit tests for concurrent access, failure retry, or edge cases. The implementation is
  correct but untested in isolation.
- **`ManagedDatabase`**: No unit tests for migration ordering, WAL checkpoint behavior, sync timer, dirty tracking, or
  the `close()` lifecycle.
- **Setup edge cases**: No tests for double setup attempt (though `isSetupRequired` guard exists), partial failure
  recovery, or S3 storage type during setup.
- **`LocalFilesystem`**: No dedicated tests for path traversal blocking, directory size calculation, empty directory
  cleanup, or the `watch()` method.
- **`parseOwnerId`**: No dedicated tests for invalid input, email-format owner IDs, edge cases like `team_org_...`, or
  the empty-id fallback behavior.
- **S3 endpoints**: No tests for `GET/PUT /settings/s3config` or `POST /settings/s3check` (these require real or mocked
  S3).
- **`enforceAvatarUpload`**: No tests for the avatar quota enforcement path.
- **Home timeout/destruct lifecycle**: No tests verifying the 5-minute timeout, cleanup callback, or destruct behavior.
- **WebSocket keepalive**: No tests for `keepWebSocketAlive` behavior.

**Test infrastructure quality:** The test setup (`test/setup.ts`) is solid. It uses temp directories with timestamp
isolation, cleans up previous runs at start, creates three test users with proper session tokens, and provides helper
functions for authenticated requests. The `authedRequest()` helper and drive utility functions reduce boilerplate
effectively. Tests run with `--concurrency 1` to avoid SQLite contention, which is correct for the shared Home singleton
pattern.
