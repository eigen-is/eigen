# BE Code Review: Setup

## Summary

The setup backend consists of two files: the setup domain class (`apps/api/src/lib/setup/setup.ts`, 263 lines) and the
route handler (`apps/api/src/routes/setup.ts`, 27 lines). It implements a first-run wizard that creates the database
schema, admin user, default organization, server configuration, and server settings. The route is registered without
authentication, which is appropriate for a first-run wizard but introduces security surface that needs careful handling.

## Critical Issues

### 1. Database connection leak in `initializeDatabaseSchema()`

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/setup/setup.ts`, line 25

The function opens a SQLite connection via `drizzle(dbPath)` but never closes it. After the 10 `db.run()` calls
complete, the `db` handle goes out of scope without being closed. In Bun's SQLite binding, this means the file
descriptor stays open until garbage collection (which is non-deterministic). During setup, the auth module later opens
the same `users3.db` file through better-auth. Having two unclosed connections to the same file can cause WAL
contention.

**Fix**: Close the database after schema creation:

```typescript
const db = drizzle(dbPath);
try {
    await db.run(/* ... */);
    // ...
} finally {
    db.$client.close(); // close underlying bun:sqlite handle
}
```

### 2. Race condition: concurrent setup requests

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/setup/setup.ts`, lines 163-164

The `completeSetup()` function checks `isSetupRequired()` at the start, but between that check and the
`saveServerConfig()` call on line 244, another concurrent request could also pass the check. Two parallel POST requests
could both create admin users and organizations, leaving the system in an inconsistent state with duplicate orgs and
users.

**Fix**: Add a mutex/lock (e.g., a module-level `let setupInProgress = false` flag, or use a proper async lock) to
serialize setup attempts:

```typescript
let setupInProgress = false;

export async function completeSetup(input: SetupInput): Promise<SetupResult> {
    if (setupInProgress) {
        return { success: false, error: "Setup is already in progress" };
    }
    setupInProgress = true;
    try {
        // ... existing logic
    } finally {
        setupInProgress = false;
    }
}
```

### 3. No email format validation on admin email

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/setup/setup.ts`, lines 186, 197-204

The backend validates that `adminEmail` is non-empty (via the route schema `t.String({minLength: 1})`), but never
validates that it is a properly formatted email address. The frontend constructs the email as
`${username}@${domain}`, but the backend accepts any non-empty string. The `auth.api.createUser` call may succeed with
an invalid email, creating an admin account that cannot receive password-reset emails.

**Fix**: Add email validation using `t.String({ format: 'email' })` in the route schema, or use the existing
`validateEmailAddress()` from `@workspace/lib/validation`.

## Pattern Violations

### 1. `interface` used instead of `type` (minor)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/setup.ts`

The route file uses Elysia's `t.Object()` inline schema rather than a shared type, which is fine for route definitions.
However, the domain types `SetupInput` and `SetupResult` in `setup.ts` (lines 131, 145) correctly use `type`. No
violation here.

### 2. Raw SQL instead of Drizzle schema definitions

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/setup/setup.ts`, lines 27-128

The `initializeDatabaseSchema()` function uses 10 raw `CREATE TABLE IF NOT EXISTS` SQL statements instead of using
Drizzle ORM schema definitions. The better-auth library already defines these same tables through its own schema. This
creates a maintenance risk: if better-auth updates its schema (adds columns, changes types), the raw SQL here will be
out of sync.

**Fix**: Use better-auth's own migration/schema initialization instead of duplicating the DDL.

### 3. Duplicated validation logic

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/setup/setup.ts`, lines 168-191 and
`/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/setup.ts`, lines 13-25

The route schema already validates `minLength: 1` for required fields and `minLength: 8` for the password. The
`completeSetup()` function then re-validates the same things. This is not harmful but adds noise. The function-level
validation would only fire if called directly (bypassing the route), which is a reasonable defensive pattern, but it
would be cleaner to have a single source of truth.

## Security Concerns

### 1. Setup endpoint is permanently accessible (by design, but worth noting)

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/setup.ts`, lines 4-6

The `/setup/status` and `/setup/complete` endpoints have no authentication. This is correct for a first-run wizard.
The `completeSetup()` function does check `isSetupRequired()` and returns an error if setup is already done. However:

- **GET `/setup/status`** leaks the configured domain name to unauthenticated users (line 157). This is a minor
  information disclosure.
- The check relies on an in-memory `loaded` flag in `server-config.ts`. If the server restarts and the config file is
  corrupted/deleted, setup could potentially be re-triggered, allowing an attacker to overwrite the admin account.

**Recommendation**: Consider adding rate limiting to the setup endpoint and logging setup attempts.

### 2. S3 credentials stored in plaintext

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/setup/setup.ts`, lines 230-237

S3 access key ID and secret access key are stored directly in the `config.json` file via `saveServerConfig()`. While
this is common for self-hosted applications, it should be documented as a security consideration. The secret key in
particular should have restricted file permissions on the config file.

### 3. Server secret generated correctly

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/setup/setup.ts`, line 239

The server secret is generated using `randomBytes(32).toString('base64')`, which is cryptographically secure. Good.

### 4. No CSRF protection on setup POST

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/routes/setup.ts`, line 6

The POST endpoint has no CSRF token validation. An attacker on the same network could submit a cross-origin POST
during the brief window when setup is available. Since the endpoint requires `Content-Type: application/json`, browser
CORS protections provide some defense (the preflight OPTIONS request would need to be allowed). The CORS configuration
in `app.ts` does restrict origins, which mitigates this.

## Data Integrity

### 1. No rollback on partial failure

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/setup/setup.ts`, lines 194-261

If `auth.api.createUser` succeeds but `auth.api.createOrganization` fails, the admin user exists in the database but
no organization was created. The server config is not saved, so `isSetupRequired()` still returns `true`, meaning
setup can be retried. However, the retry will try to create the admin user again with the same email, which will fail
due to the UNIQUE constraint on `user.email`. The system is now stuck.

**Fix**: Either delete the user on org creation failure, or check for existing user before creating.

### 2. `saveServerConfig()` is not called atomically with DB operations

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/setup/setup.ts`, lines 244-248

If `saveServerConfig()` succeeds but `updateServerSettings()` fails, the setup is marked complete but server settings
may be wrong. This is a minor issue since settings have sensible defaults, but the ordering means a partial setup
could result in the wrong default storage type.

## Code Quality

### 1. Non-null assertions on S3 config

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/setup/setup.ts`, lines 231-234

```typescript
bucket: input.s3Bucket!,
region: input.s3Region!,
accessKeyId: input.s3AccessKeyId!,
secretAccessKey: input.s3SecretAccessKey!,
```

These `!` assertions are safe because of the guard on line 181, but using non-null assertions is fragile. If the
validation logic changes, these silently become undefined.

**Fix**: Use `?? ''` or restructure so the S3 config block is only built after a type narrowing check.

### 2. Magic string for database filename

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/api/src/lib/setup/setup.ts`, line 18

`'users3.db'` is a magic string. If better-auth or the auth module changes this filename, setup will create tables in
the wrong database. This should reference a shared constant.

## Architecture

### 1. Setup does not use the standard domain class pattern

The rest of the codebase follows a clear pattern: domain class in `lib/[domain]/[domain].ts`, schema in
`lib/[domain]/schema.ts`, config in `lib/[domain]/db-config.ts`. Setup uses a single file with no schema or config
file. This is understandable (setup is a one-time operation, not a persistent domain), but it means the DDL is
disconnected from the auth module's schema management.

### 2. Setup vite config is custom, not using shared config

**File**: `/Users/reinder/Documents/GitHub/eigen/apps/setup/vite.config.ts`

The setup app has its own custom Vite config instead of using `createAppConfig('setup')` from `vite.shared.config.ts`.
This means it misses out on TanStack Router plugin, tree-shaking configuration, and other shared settings. Since setup
is a single-page wizard without routing, this is intentional but creates maintenance divergence.

## Positive Patterns

1. **Clean guard against re-triggering**: `completeSetup()` checks `isSetupRequired()` at the top and returns a clear
   error if setup is already done. This is the most important security property of a setup wizard.
2. **Strong route schema validation**: The Elysia `t.Object()` schema on the POST body provides runtime type checking
   with specific constraints (`minLength`, `t.Union` for storage types).
3. **Cryptographically secure secret**: Uses `randomBytes(32)` for the server secret.
4. **Org slug sanitization**: Line 211 properly sanitizes the org name into a URL-safe slug.
5. **Error handling returns structured responses**: Both success and failure return a `SetupResult` with clear
   messages.

## Recommendations

| Priority | Issue                              | Description                                                           |
|----------|------------------------------------|-----------------------------------------------------------------------|
| **P0**   | Race condition                     | Add mutex to prevent concurrent setup execution                       |
| **P0**   | Partial failure leaves stuck state | Handle user-exists case on retry, or clean up on org creation failure |
| **P1**   | DB connection leak                 | Close the drizzle connection after schema init                        |
| **P1**   | Email validation                   | Validate admin email format on the backend                            |
| **P1**   | Raw SQL schema duplication         | Use better-auth's schema init instead of hand-written DDL             |
| **P2**   | Non-null assertions                | Replace `!` with safer narrowing                                      |
| **P2**   | Magic DB filename                  | Extract `'users3.db'` to a shared constant                            |
| **P2**   | Domain leak in status              | Consider omitting domain from unauthenticated status response         |
