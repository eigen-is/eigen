# Backend Code Review: Core (Auth, Home, Config, Setup, SSE)

## Summary

The core backend infrastructure is well-designed with clean separation of concerns: the Home singleton hierarchy, JsonStore for config persistence, ManagedDatabase for SQLite lifecycle, and the async singleton factory are all solid abstractions. The codebase follows its own documented patterns consistently. However, there are several bugs (one critical), a few security considerations worth hardening, race condition risks in the singleton/home lifecycle, and gaps in error handling and test coverage.

## Architecture Compliance

The code closely follows CLAUDE.md and the documented architecture patterns:

- **Home singleton pattern**: `UserHome`, `TeamHome`, `OrgHome` hierarchy with `getHome()` factory -- matches docs exactly.
- **Domain class layout**: `lib/[domain]/[domain].ts` for business logic, `lib/[domain]/schema.ts` for DB schemas -- consistent.
- **Route structure**: Thin Elysia routers in `routes/`, `{auth: true}` macro -- consistent.
- **ManagedDatabase**: WAL mode, versioned migrations, dirty tracking, sync callbacks -- all as documented.
- **SSE pattern**: `home.notify()` -> SSE stream -> frontend handlers -- correctly implemented.
- **Config/settings**: `JsonStore<ServerConfig>` and `JsonStore<ServerSettings>` with atomic writes (tmp+rename) -- clean.
- **Error handling**: `ApiError` thrown and caught in `app.ts` `onError` handler -- consistent.
- **`type` over `interface`**: Followed consistently. No JSDoc. English everywhere.

**Minor deviation**: `user.ts:29` has a JSDoc comment (`/** Resolves a user's org... */`) which contradicts the "No JSDoc" rule in CLAUDE.md.

## Issues Found

### Critical

**1. `getTeamExists` is missing `await` -- always returns `true`**
- **File**: `apps/api/src/lib/team/team.ts:11`
- **Code**: `return getTeam(teamId) !== undefined;`
- `getTeam()` is `async` and returns a `Promise`, which is always truthy (never `undefined`). This means `getTeamExists()` always returns `true`, even for non-existent team IDs. This allows creating `TeamHome` instances for fabricated team IDs via `getHome("team_nonexistent")`, which would create directories under `data/team/nonexistent/` and potentially be exploited for resource exhaustion or bypassing team membership checks.
- **Fix**: `return (await getTeam(teamId)) !== undefined;`

### Important

**2. Auth secret fallback is a hardcoded default**
- **File**: `apps/api/src/lib/auth/auth.ts:98`
- **Code**: `secret: getServerConfig()?.secret || "+/SmL4b3+bxwJgsJU7yT1Sbfm9YR/0GZhVGRaBm838c="`
- Before setup completes, `getServerConfig()` returns `null`, so the hardcoded secret is used. This is necessary for bootstrapping, but the fallback secret is committed to the repository. If the API is exposed before setup completes, sessions signed with this secret would be valid. After setup, a new random secret is generated, but any sessions created during setup with the default secret would become invalid (which is probably fine but worth noting).
- **Recommendation**: Log a warning when using the fallback secret. Consider refusing to start the auth system until setup is complete, or generating a random ephemeral secret at startup.

**3. `parseOwnerId` silently returns `{type: 'user', id: ''}` for invalid IDs**
- **File**: `packages/lib/src/types/owner.ts:25-26`
- When a non-UUID, non-email, non-prefixed value is passed, `parseOwnerId` returns `{type: 'user', id: ''}` -- an empty user ID. The callers in `get-home.ts:18` check `if (!parsed)` but `parseOwnerId` never returns a falsy value; it always returns an object. The empty `id` would then be passed to `getUserById('')`, which presumably returns `null`, triggering the 404. So this works by accident rather than by design.
- **Fix**: Either return `null` for invalid input and update the return type, or check `parsed.id === ''` in `get-home.ts`. The `if (!parsed)` guard on line 18 is dead code.

**4. Singleton factory never clears failed initialization**
- **File**: `apps/api/src/utils/singleton.ts`
- If `factoryFn()` rejects, `initializationPromise` remains set to the rejected promise, and `instance` stays `null`. Every subsequent call will return the same rejected promise forever. The factory will never retry.
- For `getHome()`, this means if a Home fails to initialize (e.g., disk full, corrupt DB), the user is locked out until server restart.
- **Fix**: Add a `.catch()` handler that clears `initializationPromise` on failure:
  ```typescript
  initializationPromise = factoryFn().then(result => {
      instance = result;
      return result;
  }).catch(err => {
      initializationPromise = null;
      throw err;
  });
  ```

**5. Race condition between `cleanupHomeFactory` and `getHome`**
- **File**: `apps/api/src/lib/home/get-home.ts:28-29,62-64`
- When a Home's 5-minute timeout fires, it calls `cleanupHomeFactory(ownerId)` which deletes the factory from the map, then calls `destruct()`. If `getHome(ownerId)` is called between `cleanupHomeFactory` and `destruct` completing, a new Home will be created while the old one is still destructing (closing databases). This could cause two Home instances for the same user to exist simultaneously, leading to database contention or corrupt state.
- The `touch()` on line 59 resets the timer on every access, which helps, but the window exists when the timeout fires.
- **Recommendation**: Make the cleanup atomic -- either defer deletion from the map until after destruct completes, or use a "destructing" state that blocks new factory creation.

**6. Home `destruct()` re-opens databases to close them**
- **File**: `apps/api/src/lib/home/home.ts:150-159`
- In `destruct()`, the loop `for (const [key, getter] of this.managedDatabases)` calls `getter()` which is a `createAsyncSingleton` factory. If a managed database was never opened, calling `getter()` during destruct will *create and open* it just to close it. This is wasteful and potentially harmful.
- **Fix**: Track opened instances separately, or check if the singleton has been resolved before calling it.

**7. `home.size()` ignores non-default mounts**
- **File**: `apps/api/src/lib/home/home.ts:105-123`
- `size()` only computes `drive.size('default')` and returns `drive: {default: {...}}`. For users or teams with multiple mounts, storage used by non-default mounts is not counted in `total.used`, which could make the reported total misleading.

**8. SSE route ignores `ownerId` parameter**
- **File**: `apps/api/src/routes/sse.ts:8,13`
- The route is `/sse/:ownerId/events` but the handler always uses `user.id` to get the Home: `getHome(user.id)`. The `params.ownerId` is completely ignored. This means a user can never subscribe to team events via SSE. The test at `sse.test.ts:62-72` confirms this behavior (Bob requesting Alice's events gets his own).
- This is either intentional (security-correct) or a missing feature. If team SSE is needed, the route needs to validate that the user has access to the requested ownerId.

**9. `LocalFilesystem` has no path traversal protection**
- **File**: `apps/api/src/lib/core/local-filesystem.ts:16-18`
- `getFilePath` does `path.join(this.baseDir, filePath)` without any traversal check. While `LocalStorage` (drive storage) has explicit traversal protection, `LocalFilesystem` (used by Home for config files, mail, contacts) does not. If any user-controlled input flows into `LocalFilesystem` methods, it could escape the base directory.
- Currently, most `LocalFilesystem` usage is with hardcoded paths from `PATHS` constants, so the practical risk is low. But the `file()` method and `write()` method are used with user-influenced filenames in some contexts (e.g., mail attachments, contact avatars).
- **Recommendation**: Add the same traversal check as `LocalStorage.resolve()`.

### Minor

**10. Redundant `this.user = user` in `UserHome` constructor**
- **File**: `apps/api/src/lib/home/user-home.ts:17`
- `super(user, cleanUp)` already sets `this.user = user` in the `Home` constructor (line 44). The assignment in `UserHome` is redundant.

**11. `readdir` method uses `any` return type**
- **File**: `apps/api/src/lib/core/local-filesystem.ts:130-133`
- `readdir` returns `Promise<any[]>` and casts options with `as any`. This loses type safety. Should use proper overload signatures or a typed return.

**12. `toLocaleLowerCase()` vs `toLowerCase()` inconsistency**
- **File**: `apps/api/src/lib/user/user.ts:8`
- Uses `email.toLocaleLowerCase()` which is locale-dependent. `parseOwnerId` in `owner.ts:11` uses `.toLowerCase()`. Email normalization should be consistent across the codebase.

**13. Setup route has no rate limiting**
- **File**: `apps/api/src/routes/setup.ts`
- The `/setup/complete` endpoint can be called repeatedly (though it checks `isSetupRequired()`). Before setup is completed, there's no authentication. An attacker could attempt to complete setup before the legitimate admin. This is somewhat mitigated by the self-hosted nature, but worth noting.

**14. Console logging of OTP**
- **File**: `apps/api/src/lib/auth/auth.ts:76`
- `console.log('send otp', user, otp, ctx?.request)` logs the OTP code to stdout. This is clearly a development placeholder but could be a security issue if logs are exposed in production.

**15. Server config and settings use module-level `await`**
- **Files**: `apps/api/src/lib/config/server-config.ts:83`, `apps/api/src/lib/config/server-settings.ts:48`
- Both modules use top-level `await ensureLoaded()`. This means importing these modules blocks on file I/O. While this ensures data is available synchronously via `get()`, it couples module load order to filesystem state. If the data directory doesn't exist when these modules are first imported (e.g., during testing), it silently creates directories as a side effect.

**16. `WebSocket` keepalive doesn't close the socket**
- **File**: `apps/api/src/utils/websockets.ts:13`
- When ping fails, the code calls `onClose()` but doesn't actually close the WebSocket (`ws.close()`). The dead connection may linger.

**17. SSE `keepalive` event format mismatch**
- **File**: `apps/api/src/routes/sse.ts:35`
- The keepalive sends `{event: 'keepalive'}` but the `SSEvent` union type doesn't include a `keepalive` event type. The `controller.enqueue()` expects `SSEvent` but receives a non-conforming object. This works at runtime because JavaScript doesn't enforce types, but it's a type safety hole.

**18. `Home.getZip()` always throws**
- **File**: `apps/api/src/lib/home/home.ts:162-164`
- `getZip()` throws `'Not implemented'`. The route at `routes/home.ts:17-29` catches this and returns 500. This is dead code that should either be implemented or removed. The test confirms this returns 500.

**19. Empty catch blocks**
- **File**: `apps/api/src/lib/core/local-filesystem.ts:65,77,125,187`
- Multiple empty `catch` blocks silently swallow errors. While some are intentional (e.g., directory listing when dir doesn't exist), the `dirSize` catch at line 125 could hide real I/O errors that affect quota calculations.

**20. `config/schema.ts` appears unused**
- **File**: `apps/api/src/lib/config/schema.ts`
- Defines a `systemConfig` table but it doesn't appear to be used anywhere in the config system. `ServerConfig` and `ServerSettings` use `JsonStore` (JSON files), not SQLite. This is dead code.

## Robustness

**Error handling**: Generally good. `ApiError` is used consistently for user-facing errors, and the global `onError` handler in `app.ts` catches everything. The `Home.destruct()` method wraps each domain destruction in try/catch to prevent cascading failures. `JsonStore.load()` falls back to defaults on parse errors.

**Edge cases worth noting**:
- `JsonStore.save()` uses atomic write (tmp + rename) which is correct for crash safety.
- `ManagedDatabase` migrations run sequentially and are idempotent (`CREATE TABLE IF NOT EXISTS` style).
- The `deepMerge` in `json-store.ts` correctly handles nested objects, null values, and arrays (arrays are replaced, not merged, which is the right behavior for settings).
- `ManagedDatabase.close()` calls `sync()` then does a redundant second `wal_checkpoint(TRUNCATE)` on line 127. The `sync()` on line 126 already does the checkpoint. Minor redundancy.

**Missing defensive coding**:
- No timeout on `Home.init()` -- if a domain init hangs, the Home singleton is stuck in "initializing" state forever, blocking all subsequent requests for that user.
- `enforceAvatarUpload` at `enforcement.ts:46` uses `'default'` mount for quota resolution, which may not exist for all users.

## Test Coverage

**What's tested (well)**:
- Home size endpoint: structure validation, user isolation, ownerId spoofing protection (4 tests)
- Server settings: admin access control, read/update, non-admin rejection (5 tests)
- Quota enforcement: upload within quota, upload exceeding max (2 tests)
- Team mount management: CRUD, multi-mount scenarios (8 tests)
- Quota resolution with team overrides: elevation, clearing, most-permissive wins (4 tests)
- Setup flow: secret generation, default settings (2 tests)
- SSE: auth required, invalid token, headers, spoofing, multiple clients, cancellation, separate streams, ACL events (8 tests)

**What's missing**:
- **No `setup.test.ts`**: The setup flow is tested indirectly in `test/setup.ts` (test harness) and a few tests in `settings.test.ts`, but there's no dedicated test file for setup edge cases (double setup, invalid input, S3 validation).
- **No tests for `ManagedDatabase`**: Migration ordering, version skipping, WAL checkpoint, dirty tracking, sync timer, concurrent open attempts.
- **No tests for `JsonStore`**: Corrupt JSON, concurrent writes, deep merge edge cases.
- **No tests for `createAsyncSingleton`**: Concurrent calls, factory failure and retry, cleanup.
- **No tests for `LocalFilesystem`**: Path traversal, concurrent operations, `cleanupEmptyDirs`.
- **No tests for `parseOwnerId`**: Invalid inputs, edge cases (email-like strings, malformed prefixes).
- **No tests for `Home.init()` concurrency**: Multiple init calls for the same Home, timeout behavior.
- **No negative tests for settings**: Invalid quota values (0, negative), invalid storage types.
- **No tests for S3 config endpoints**: `GET/PUT /settings/s3config`, `POST /settings/s3check`.
- **No test for `enforceAvatarUpload`**.
- Test cleanup is commented out at `test/setup.ts:147-150`, so test data accumulates.

## Recommendations

**Priority 1 (bugs to fix now)**:
1. Add `await` to `getTeamExists` in `apps/api/src/lib/team/team.ts:11`.
2. Fix `createAsyncSingleton` to clear `initializationPromise` on rejection.
3. Fix `parseOwnerId` to return `null` for invalid IDs (or update callers to check empty `id`).

**Priority 2 (security hardening)**:
4. Add path traversal protection to `LocalFilesystem.getFilePath()`.
5. Remove OTP console.log from auth.ts or gate it behind a debug flag.
6. Add rate limiting or IP-based lockout to the setup endpoint.
7. Log a warning when using the fallback auth secret.

**Priority 3 (robustness)**:
8. Fix the Home destruct/cleanup race condition -- make cleanup atomic.
9. Fix `destruct()` to not open databases just to close them.
10. Add `ws.close()` in the websocket keepalive failure handler.
11. Add a timeout to `Home.init()` to prevent infinite hangs.

**Priority 4 (code quality)**:
12. Remove dead code: `config/schema.ts`, `Home.getZip()` (or implement it).
13. Remove redundant `this.user = user` in `UserHome`.
14. Remove JSDoc comment in `user.ts`.
15. Replace `any` types in `LocalFilesystem.readdir()`.
16. Normalize email case handling consistently (`toLowerCase` everywhere).

**Priority 5 (test coverage)**:
17. Add unit tests for `createAsyncSingleton`, `JsonStore`, `ManagedDatabase`.
18. Add integration tests for setup edge cases.
19. Add tests for `parseOwnerId` with invalid inputs.
20. Uncomment or fix test cleanup in `test/setup.ts`.
