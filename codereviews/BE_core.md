# Backend Review: Core (Auth, Home, Config, Setup, SSE)

**Scope:** `apps/api/src/lib/{core,config,auth,home,setup,team}/`, `apps/api/src/utils/`, related routes
**Reviewed:** 2026-03-18

## Critical Issues

**1. `getTeamExists` missing `await` -- always returns `true`**
- **File:** `apps/api/src/lib/team/team.ts:10-12`
- **Code:** `return getTeam(teamId) !== undefined;`
- `getTeam()` is declared `async`, so it always returns a Promise, which is always truthy. This means `getTeamExists()` returns `true` for any input, including fabricated team IDs. The caller in `get-home.ts:34` (`if (!await getTeamExists(parsed.id))`) will never throw 404, allowing `TeamHome` instances to be created for non-existent teams. This creates directories under `data/team/<nonexistent>/` and could be exploited for disk exhaustion.
- Note: Drizzle's `.get()` on bun:sqlite is synchronous, but the `async` keyword on `getTeam` wraps the return value in a Promise regardless.
- **Fix:** `return (await getTeam(teamId)) !== undefined;`
- **Previous review:** Identified correctly. Still present.

## Important Issues

**2. Singleton factory permanently caches failed initialization**
- **File:** `apps/api/src/utils/singleton.ts:19-22`
- If `factoryFn()` rejects, `initializationPromise` stays set to the rejected promise and `instance` remains `null`. All subsequent calls return the same rejected promise forever. The factory never retries.
- Impact: if a Home initialization fails transiently (disk full, temporary DB corruption), the user is permanently locked out until server restart. This applies to every use of `createAsyncSingleton` throughout the codebase -- Home factories, Mount database singletons, collab document singletons.
- **Fix:** Clear `initializationPromise` on rejection so the next call retries.
- **Previous review:** Identified correctly. Still present.

**3. Race condition in Home cleanup/recreation lifecycle**
- **Files:** `apps/api/src/lib/home/home.ts:78-87`, `apps/api/src/lib/home/get-home.ts:62-64`
- When the 5-minute inactivity timeout fires (`touch()` callback), it first calls `cleanupHomeFactory(ownerId)` which removes the factory from the `homeFactories` map, then calls `this.destruct()` (which is async and takes time to close DBs). If a request for the same `ownerId` arrives between the map deletion and destruct completion, `getHome()` creates a new factory and Home while the old one is still closing databases. Two Home instances would then exist for the same user, potentially causing SQLite contention.
- The `touch()` method resets the timer on every access (line 59 in `get-home.ts`), so the window is narrow but real under concurrent requests near the timeout boundary.
- **Fix:** Either defer removing from the map until after destruct completes, or use a "destructing" sentinel that blocks new factory creation until the old Home is fully torn down.
- **Previous review:** Identified correctly. Still present.

**4. Home `destruct()` may open databases that were never used, just to close them**
- **File:** `apps/api/src/lib/home/home.ts:151-158`
- The `managedDatabases` map stores `createAsyncSingleton(factory)` getters. During `destruct()`, the loop calls `getter()` for every entry. If a database was registered (via `getLocalDatabase`) but never actually opened (the singleton was never resolved), calling `getter()` triggers the factory -- creating, opening, and initializing the database just to immediately close it.
- Impact: slow destruction, unnecessary I/O, potential errors during shutdown.
- **Fix:** Track whether each singleton has been resolved. Only call close on resolved instances. One approach: wrap the getter to track state.
- **Previous review:** Identified correctly. Still present.

**5. Auth secret uses hardcoded fallback before setup**
- **File:** `apps/api/src/lib/auth/auth.ts:98`
- `secret: getServerConfig()?.secret || "+/SmL4b3+bxwJgsJU7yT1Sbfm9YR/0GZhVGRaBm838c="`
- Before setup completes, `getServerConfig()` returns `null`, so the hardcoded fallback is used. This secret is committed to the repository. If the API is network-accessible before setup, an attacker could craft valid sessions. After setup, a random secret is generated (setup.ts:239), invalidating any pre-setup sessions.
- Practical risk is low for self-hosted deployments where setup happens immediately after first start, but worth hardening.
- **Mitigation:** Generate a random ephemeral secret at startup instead of using a static fallback. Or refuse auth operations until setup is completed.
- **Previous review:** Identified correctly. Still present.

**6. `parseOwnerId` returns `{type: 'user', id: ''}` for invalid input instead of null**
- **File:** `packages/lib/src/types/owner.ts:25-26`
- For inputs that are not valid emails and not valid IDs (failing the regex), `parseOwnerId` returns `{type: 'user', id: ''}`. The caller in `get-home.ts:18` checks `if (!parsed)`, but since the function always returns an object, this guard is dead code. The flow still works safely by accident: the empty `id` reaches `getUserById('')` which returns `null`, triggering a 404 with the misleading message "User not found" instead of "Invalid ownerId format".
- Additionally, the UUID regex `^[0-9a-fA-Z]{32}$` uses `A-Z` in the character class (matching all uppercase letters, not just hex digits A-F). Combined with the `i` flag, this matches the full alphanumeric range `[a-zA-Z0-9]`. This happens to be correct for better-auth's ID format (which uses `createRandomStringGenerator("a-z", "A-Z", "0-9")` to generate 32-character alphanumeric IDs), but the comment "check if id is valid uuid" is misleading since these are not UUIDs.
- **Fix:** Return `null` for invalid input and update the type to `ParsedOwnerId | null`. Update callers accordingly. Fix the comment to say "alphanumeric ID" rather than "uuid".
- **Previous review:** Identified the dead code and empty-id issue correctly. The regex analysis above adds new detail about why it happens to work for better-auth IDs despite the misleading character class.

**7. `LocalFilesystem` has no path traversal protection**
- **File:** `apps/api/src/lib/core/local-filesystem.ts:16-18`
- `getFilePath(filePath)` does `path.join(this.baseDir, filePath)` without checking that the result stays within `baseDir`. Compare with `LocalStorage.resolve()` in `local-storage.ts:18-23` which explicitly checks for traversal.
- Current risk is low because most `LocalFilesystem` callers use hardcoded constants from `PATHS`. However, the `file()` method, `write()`, and `rename()` are used in contexts where user-influenced strings could eventually flow in (e.g., contact avatars, mail filenames, JsonStore filenames).
- **Fix:** Add the same traversal check as `LocalStorage.resolve()`: verify that `path.resolve(fullPath).startsWith(this.baseDir + path.sep)`.
- **Previous review:** Identified correctly. Still present.

**8. SSE route and home/size route ignore the `:ownerId` URL parameter**
- **Files:** `apps/api/src/routes/sse.ts:8,13`, `apps/api/src/routes/home.ts:10-11`
- Both routes define `:ownerId` in the URL pattern but always use `user.id` instead of `params.ownerId`. This is security-correct behavior (prevents spoofing), but the unused URL parameter is misleading. The test at `sse.test.ts:62-72` and `home.test.ts:42-54` confirm spoofing is prevented.
- This means team SSE events are not subscribable from the client. Team-triggered events (e.g., team drive changes) would only be delivered if the client subscribes to the TeamHome's SSE stream, which is not currently possible.
- **Recommendation:** This is likely intentional for security. Document the pattern. If team SSE is needed in the future, add explicit ownerId validation with membership checks.
- **Previous review:** Identified correctly. Clarified that both SSE and home/size routes share this pattern.

**9. `home.size()` only reports the default mount**
- **File:** `apps/api/src/lib/home/home.ts:105-123`
- `size()` calls `this._drive.size('default')` and returns only `drive: {default: {...}}`. For users or teams with multiple mounts, non-default mount storage is excluded from `total.used` and from the response entirely.
- Impact: storage reporting is inaccurate for multi-mount configurations (teams typically use non-default mounts).
- **Fix:** Iterate over all mounts and aggregate their sizes.
- **Previous review:** Identified correctly. Still present.

**10. `enforceAvatarUpload` assumes a 'default' mount exists**
- **File:** `apps/api/src/lib/config/enforcement.ts:46`
- `resolveQuotas(userId, userId, 'default')` calls `home.drive.getMountConfig('default')`, which calls `getMount('default')`. If a user somehow has no default mount (e.g., TeamHome instances which start with no mounts), this would throw `ApiError(404, 'Mount not found: default')`.
- In practice, `UserHome.init()` always creates a default mount (user-home.ts:42), so this only affects TeamHome. Avatar uploads are likely only used by real users, but the assumption is fragile.
- **Previous review:** Identified correctly. Still present.

## Minor Issues

**11. Redundant double WAL checkpoint is not always redundant**
- **File:** `apps/api/src/lib/core/managed-database.ts:126-127`
- The previous review claimed `close()` does a redundant second `wal_checkpoint(TRUNCATE)` after `sync()`. This is incorrect. `sync()` only runs its checkpoint if `this.isDirty && this.callbacks.onSync` (line 110). For databases without sync callbacks (most local databases) or clean databases, `sync()` returns early without checkpointing. The explicit checkpoint on line 127 ensures WAL cleanup regardless.
- **Previous review finding corrected:** Not actually redundant.

**12. Redundant `this.user = user` in `UserHome` constructor**
- **File:** `apps/api/src/lib/home/user-home.ts:17`
- `super(user, cleanUp)` already sets `this.user = user` in the `Home` base constructor (home.ts:44). The second assignment is redundant.
- **Previous review:** Identified correctly. Still present.

**13. Console logging of OTP codes**
- **File:** `apps/api/src/lib/auth/auth.ts:75`
- `console.log('send otp', user, otp, ctx?.request)` logs the full OTP code and the entire user object to stdout. This is a development placeholder (the OTP email sending is not implemented), but if logs are collected in a deployed environment, OTP codes would be exposed.
- **Fix:** Replace with a proper email-sending implementation, or at minimum log without the actual OTP value.
- **Previous review:** Identified correctly. Still present.

**14. `readdir` method uses `any` return type**
- **File:** `apps/api/src/lib/core/local-filesystem.ts:130-132`
- Returns `Promise<any[]>` and casts options with `as any`. Type safety is lost.
- **Previous review:** Identified correctly. Still present.

**15. `toLocaleLowerCase()` vs `toLowerCase()` inconsistency**
- **File:** `apps/api/src/lib/user/user.ts:8`
- `getUserByEmail` uses `email.toLocaleLowerCase()` which is locale-dependent (e.g., Turkish 'I' lowercase rules). `parseOwnerId` in `owner.ts:11` uses `.toLowerCase()`. For email addresses, `toLowerCase()` is the correct choice per RFC 5321.
- **Previous review:** Identified correctly. Still present.

**16. WebSocket keepalive does not actually close the socket**
- **File:** `apps/api/src/utils/websockets.ts:10-13`
- When ping fails (or socket is not OPEN), the code calls `onClose()` and clears the interval, but never calls `ws.close()`. The underlying WebSocket connection may linger as a half-open connection.
- **Fix:** Call `ws.close()` before or after `onClose()`.
- **Previous review:** Identified correctly. Still present.

**17. SSE keepalive event does not conform to SSEvent type**
- **File:** `apps/api/src/routes/sse.ts:35`
- `controller.enqueue({event: 'keepalive'})` sends an object with an `event` property, but the `SSEvent` union type (in `packages/lib/src/types/sse.ts`) requires `type` and `title` properties at minimum. The `ReadableStream<SSEvent>` typing is violated at runtime. This works because Elysia's `sse()` serialization handles arbitrary objects, but it is a type safety gap.
- **Previous review:** Identified correctly. Still present.

**18. `config/schema.ts` appears unused**
- **File:** `apps/api/src/lib/config/schema.ts`
- Defines a `systemConfig` SQLite table that is not used anywhere. The config system uses `JsonStore` (JSON files on disk), not SQLite.
- **Previous review:** Identified correctly. Still present.

**19. JSDoc comment in user.ts**
- **File:** `apps/api/src/lib/user/user.ts:26-28`
- `/** Resolves a user's org and team memberships from the auth database. */` contradicts the "No JSDoc" rule in CLAUDE.md.
- **Previous review:** Identified correctly (line number was 29, now 26-28).

**20. `Home.getZip()` always throws**
- **File:** `apps/api/src/lib/home/home.ts:162-164`
- Always throws `Error('Not implemented')`. The route at `routes/home.ts:17-29` catches it and returns 500. This is dead code unless there are plans to implement it.
- **Previous review:** Identified correctly. Still present.

**21. Empty catch blocks in `LocalFilesystem`**
- **File:** `apps/api/src/lib/core/local-filesystem.ts:65,75,102,125,187`
- Several methods silently swallow errors. Most are intentional (returning empty arrays when directories don't exist), but `dirSize` at line 125 could hide I/O errors that affect quota calculations.
- **Previous review:** Identified correctly (line numbers slightly adjusted).

**22. Module-level `await` in config modules**
- **Files:** `apps/api/src/lib/config/server-config.ts:83`, `apps/api/src/lib/config/server-settings.ts:55`
- Both use top-level `await ensureLoaded()`. This is a standard Bun pattern and works correctly, but it means importing these modules triggers filesystem I/O as a side effect and creates the `data/server/` directory if it does not exist.
- **Previous review:** Identified correctly. This is more of an architectural note than an issue.

**23. `getTeamMembers` silently returns empty array on error**
- **File:** `apps/api/src/lib/team/team.ts:14-24`
- The `catch` block returns `[]` for any error, including non-"not found" errors like database corruption. This hides real failures.
- **Previous review:** Not identified. New finding.

**24. Setup `completeSetup` performs partial work on failure**
- **File:** `apps/api/src/lib/setup/setup.ts:194-261`
- If the function fails after `initializeDatabaseSchema()` but before `saveServerConfig()` (e.g., creating the admin user or org fails), the database schema is created but the config is not saved. The next setup attempt will succeed (schema tables use `CREATE TABLE IF NOT EXISTS`), but there may be leftover partial data (e.g., a user row without an org).
- Since this is a first-run setup and data is throwaway during dev, the practical impact is low. For production, wrapping this in a transaction would be more robust.
- **Previous review:** Not identified. New finding.

**25. `parseOwnerId` does not handle `team_` and `org_` prefixes exclusively**
- **File:** `packages/lib/src/types/owner.ts:14-21`
- The two `if` statements are not `else if`. If a string starts with `team_` (which is checked first), it also falls through to check if it starts with `org_`. This is harmless in practice since no string starts with both `team_` and `org_`, but it should use `else if` for clarity and correctness.
- **Previous review:** Not identified. New finding (minor).

**26. `LocalKeyStorage` has no path traversal protection**
- **File:** `apps/api/src/lib/storage/local-key-storage.ts:16-18`
- Similar to `LocalFilesystem`, `getFilePath(key)` does `path.join(this.dataDir, key)` without traversal checking. Unlike `LocalStorage` which has explicit traversal protection (`resolve()` method), `LocalKeyStorage` does not.
- Risk is low because keys are typically UUIDs generated by the system (via `buildStorageKey`), but the class accepts arbitrary string keys.
- **Previous review:** Not identified. New finding.

## Observations

**Architecture compliance is strong.** The codebase closely follows its own documented patterns: Home singleton hierarchy, domain class layout, thin Elysia routers, `ApiError` usage, `type` over `interface`, no JSDoc (with one exception). The consistency is notably high.

**Error handling is generally good.** `ApiError` provides clean user-facing errors. The global `onError` handler in `app.ts:47-56` catches both `ApiError` and unexpected errors. `Home.destruct()` wraps each domain destruction in individual try/catch blocks (home.ts:126-149), preventing cascading failures. `JsonStore.load()` gracefully falls back to defaults on parse errors.

**JsonStore atomic writes are correctly implemented.** The write-to-tmp-then-rename pattern (json-store.ts:64-68) ensures crash safety. The `deepMerge` function handles nested objects, null values, and arrays (replaced, not merged) correctly.

**ManagedDatabase is well-designed.** WAL mode, busy timeout, versioned migrations with sequential ordering, dirty tracking for sync optimization, and clean lifecycle management (open/sync/close). Migration logging provides good visibility.

**Test coverage has improved since the previous review.** A `json-store.test.ts` file now exists with 10 tests covering defaults, persistence, deep merge, arrays, corrupt JSON, atomic writes, and multi-instance scenarios. The previous review listed "No tests for JsonStore" as missing coverage -- this has been addressed.

**Test cleanup approach is valid.** The previous review noted that cleanup is "commented out" at `test/setup.ts:147-150`. However, line 6 (`rmSync(TEST_DATA_ROOT, {recursive: true, force: true})`) cleans up at the start of each test run. This is a deliberate pattern that preserves test data after a run for debugging, while ensuring a clean state for the next run.

**Missing test coverage (still applicable):**
- No dedicated setup edge case tests (double setup, invalid S3 config)
- No unit tests for `createAsyncSingleton` (failure retry, concurrent calls)
- No unit tests for `ManagedDatabase` (migration ordering, WAL checkpoint, sync timer)
- No tests for `LocalFilesystem` path handling
- No tests for `parseOwnerId` with edge cases
- No tests for S3 config endpoints (`GET/PUT /settings/s3config`, `POST /settings/s3check`)
- No tests for `enforceAvatarUpload`

**Previous review accuracy assessment:**
- Issues 1-9, 11-20: All correctly identified and verified against the current code
- Issue 10 (redundant WAL checkpoint): Partially incorrect -- the second checkpoint is not redundant for databases without sync callbacks. Corrected in this review.
- Test coverage claim about JsonStore: Now outdated -- tests exist
- Test cleanup claim: Slightly misleading -- cleanup happens at next run start, not never
