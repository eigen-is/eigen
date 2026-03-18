# Plan: Server Settings & Admin Configuration

## Goal

Expand the server configuration with runtime-adjustable settings (auth secret, storage quotas, upload limits) and
provide an admin settings screen in the People app for managing them.

## Current State

### config.json (`data/server/config.json`)

Written once during setup, contains only infrastructure config:

```typescript
type ServerConfig = {
    domain: string;
    orgName: string;
    orgId: string;
    storage: { type: 'local-id' | 'local-fullnames' | 's3'; s3?: S3Config };
    setupCompleted: boolean;
    setupCompletedAt?: string;
};
```

### Hardcoded values that should be configurable

| Value                  | Location                          | Current                                    |
|------------------------|-----------------------------------|--------------------------------------------|
| Auth secret            | `apps/api/src/lib/auth/auth.ts:97` | Hardcoded base64 string                    |
| Home max size          | `apps/api/src/lib/home/home.ts:110` | `50` MB hardcoded, **not enforced**         |
| Single file upload     | `apps/api/src/routes/drive.ts:91`  | `35 * 1024 * 1024` (35 MB)                |
| Batch file upload      | `apps/api/src/routes/drive.ts:98`  | `10 * 1024 * 1024` (10 MB)                |
| Contact avatar upload  | `apps/api/src/routes/contacts.ts:93` | `15 * 1024 * 1024` (15 MB)              |
| Default storage type   | `apps/api/src/lib/mount/mount.ts:730` | Hardcoded `'local'`, ignores server config |

### Key architecture facts

- **Single-org model**: One org per Eigen instance. No multi-org complexity.
- **OrgHome exists** (`apps/api/src/lib/home/org-home.ts`) but is empty — has `orgId`, `homeDir`, `fs`, nothing else.
- **Settings pattern** already established: `JsonStore<T>` for UserSettings and TeamSettings, with GET/PUT endpoints.
- **No quota enforcement**: `home.size()` calculates usage and returns a hardcoded `max`, but nothing blocks uploads
  when exceeded.

## Design Decision: Where to Store Settings

### Option A: Expand `ServerConfig` in `data/server/config.json`

**Pros**: Single source of truth, already loaded at startup, no DB needed.
**Cons**: Requires server-config module changes. Mixing infrastructure config (domain, S3) with runtime settings
(quotas) in one file.

### Option B: Store in OrgHome (`data/org/{orgId}/settings.json`)

**Pros**: Follows existing UserSettings/TeamSettings pattern. Org-scoped. Clean separation from infrastructure config.
**Cons**: OrgHome must be initialized to read settings. Requires OrgHome to be loaded before first user home creation.
Circular dependency risk: creating a user home needs org settings, but org settings need the org to exist.

### Option C: Split — infrastructure in `config.json`, runtime settings in a new `data/server/settings.json`

**Pros**: Clean separation. `config.json` stays immutable after setup. `settings.json` is admin-editable at runtime.
Same `JsonStore` pattern, no DB needed. Loaded alongside config at startup — no Home dependency. Available before any
Home is created (solves the "new user" problem).
**Cons**: Two server-level files instead of one.

### Recommendation: Option C

Split into two files:

- **`config.json`** — Infrastructure config (domain, storage, orgId). Written during setup. Immutable at runtime.
- **`settings.json`** — Runtime settings (quotas, limits, secret). Editable by admins. Has sensible defaults.

Rationale:

1. Settings must be readable **before** any Home is initialized (to pass `maxHomeSize` to new homes and `maxUploadSize`
   to routes at startup).
2. Avoids coupling to OrgHome lifecycle — OrgHome is lazily created and destroyed on timeout.
3. Keeps `config.json` clean and immutable. No risk of admin accidentally breaking infrastructure config.
4. The `JsonStore` pattern with defaults handles missing keys gracefully — adding new settings never breaks existing
   installs.

## Implementation Plan

### Phase 1: Auth Secret in Config

**Problem**: The better-auth `secret` is hardcoded in `auth.ts:97`. It should be generated during setup and stored in
config.

**Changes**:

1. **`apps/api/src/lib/config/server-config.ts`** — Add `secret` field to `ServerConfig`:
   ```typescript
   type ServerConfig = {
       // ...existing fields
       secret: string;  // better-auth HMAC secret, base64 encoded
   };
   ```

2. **`apps/api/src/lib/setup/setup.ts`** — Generate random secret during setup:
   ```typescript
   import { randomBytes } from 'crypto';
   const secret = randomBytes(32).toString('base64');
   // Include in serverConfig
   ```

3. **`apps/api/src/lib/auth/auth.ts`** — Read secret from config instead of hardcode:
   ```typescript
   secret: getServerConfig()?.secret ?? generateFallbackSecret(),
   ```

4. **`apps/setup/src/components/setup-wizard.tsx`** — No UI change. Secret is auto-generated, not user-entered.

> **Note**: Changing the secret invalidates all existing sessions. This is acceptable during dev (data is throwaway).
> For the admin UI, the secret should be read-only / hidden — not editable. It's included in config for portability
> (backup/restore).

### Phase 2: Server Settings File

**New file**: `data/server/settings.json`

**Type definition** — `apps/api/src/lib/config/server-settings.ts`:

```typescript
export type ServerSettings = {
    maxHomeSizeMB: number;          // Max total storage per user home (MB). Default: 100
    maxUploadSizeMB: number;        // Max single file upload size (MB). Default: 35
    maxBatchUploadSizeMB: number;   // Max per-file in batch upload (MB). Default: 10
    defaultStorageType: ServerConfig['storage']['type'];  // Storage type for new homes. Default: from config
};
```

**Defaults**:

```typescript
const defaults: ServerSettings = {
    maxHomeSizeMB: 100,
    maxUploadSizeMB: 35,
    maxBatchUploadSizeMB: 10,
    defaultStorageType: getStorageType(),  // inherit from config.json
};
```

**Module pattern** (mirrors `server-config.ts`):

```typescript
const serverFs = new LocalFilesystem(getServerDataPath());
const settingsStore = new JsonStore<ServerSettings>(serverFs, 'settings.json', defaults);

await settingsStore.load();  // load on import

export function getServerSettings(): ServerSettings { return settingsStore.get(); }
export async function updateServerSettings(update: DeepPartial<ServerSettings>) { await settingsStore.set(update); }
```

**Accessor helpers** (for use in routes and Home):

```typescript
export function getMaxUploadSize(): number { return getServerSettings().maxUploadSizeMB * 1024 * 1024; }
export function getMaxBatchUploadSize(): number { return getServerSettings().maxBatchUploadSizeMB * 1024 * 1024; }
export function getMaxHomeSize(): number { return getServerSettings().maxHomeSizeMB * 1024 * 1024; }
export function getDefaultStorageType(): ServerConfig['storage']['type'] { return getServerSettings().defaultStorageType; }
```

### Phase 3: Wire Settings into Backend

#### 3a. Home size quota

**`apps/api/src/lib/home/home.ts`** — Replace hardcoded 50 MB:

```typescript
import { getMaxHomeSize } from '../config/server-settings';

public async size() {
    const [mail, contacts, drive] = await Promise.all([
        this._mail?.size(),
        this._contacts?.size(),
        this._drive.size('default')
    ]);
    const max = getMaxHomeSize();
    return { mail, contacts, drive, used: ((mail || 0) + (contacts || 0) + drive), max };
}
```

#### 3b. Upload size limits

**`apps/api/src/routes/drive.ts`** — Upload limits are set in Elysia schema validation (`t.File({maxSize})`). Elysia
evaluates these at route registration time, not per-request. Two approaches:

**Approach A — Dynamic body parsing** (preferred): Move size validation out of Elysia schema and into route handler:

```typescript
.post("/drive/:ownerId/upload", async ({ body, ... }) => {
    const maxSize = getMaxUploadSize();
    if (body.file.size > maxSize) throw new ApiError(413, `File exceeds ${maxSize} bytes`);
    // ...rest of handler
}, { body: t.Object({ file: t.File() }) })  // no maxSize in schema
```

**Approach B — Restart-required**: Keep Elysia schema validation, document that upload size changes require restart.
Simpler but worse UX.

**Recommendation**: Approach A. Remove `maxSize` from `t.File()` schemas, add manual size check in handlers. Same for
batch uploads and avatar uploads.

#### 3c. Default storage type for new homes

**`apps/api/src/lib/mount/mount.ts`** — Use server setting:

```typescript
import { getDefaultStorageType } from '../config/server-settings';

export function createDefaultMountConfig(
    id: string = 'default',
    storageType: MountConfig['storageType'] = mapStorageType(getDefaultStorageType())
): MountConfig { ... }
```

Note: Server config storage types (`'local-id' | 'local-fullnames' | 's3'`) need mapping to mount storage types
(`'local' | 'local-key' | 's3'`):

```typescript
function mapStorageType(type: ServerConfig['storage']['type']): MountConfig['storageType'] {
    switch (type) {
        case 'local-id': return 'local-key';
        case 'local-fullnames': return 'local';
        case 's3': return 's3';
    }
}
```

### Phase 4: API Endpoints

**New file**: `apps/api/src/routes/settings.ts`

```typescript
export const settingsRouter = new Elysia({ name: "settings" })
    .use(betterAuth)

    .get("/settings/server", async ({ user }) => {
        await requireAdmin(user.id);
        return getServerSettings();
    }, { auth: true })

    .put("/settings/server", async ({ body, user }) => {
        await requireAdmin(user.id);
        await updateServerSettings(body);
        return getServerSettings();
    }, {
        body: t.Object({
            maxHomeSizeMB: t.Optional(t.Number({ minimum: 10 })),
            maxUploadSizeMB: t.Optional(t.Number({ minimum: 1 })),
            maxBatchUploadSizeMB: t.Optional(t.Number({ minimum: 1 })),
            defaultStorageType: t.Optional(t.Union([
                t.Literal('local-id'),
                t.Literal('local-fullnames'),
                t.Literal('s3')
            ])),
        }),
        auth: true
    });
```

**Admin check helper** (reuse from team.ts pattern):

```typescript
async function requireAdmin(userId: string) {
    const role = await getOrgRole(userId);
    if (role !== 'admin' && role !== 'owner') throw new ApiError(403, 'Admin or owner role required');
}
```

**Register in app.ts**:

```typescript
import { settingsRouter } from './routes/settings';
// Add to router chain
.use(settingsRouter)
```

### Phase 5: Shared Types & Hooks

#### 5a. Types

**`packages/lib/src/types/settings.ts`** — Add server settings type:

```typescript
export type ServerSettings = {
    maxHomeSizeMB: number;
    maxUploadSizeMB: number;
    maxBatchUploadSizeMB: number;
    defaultStorageType: 'local-id' | 'local-fullnames' | 's3';
};
```

#### 5b. Query keys

**`packages/lib/src/core/settings/hooks/keys.ts`**:

```typescript
export const settingsKeys = {
    all: ['settings'] as const,
    server: () => [...settingsKeys.all, 'server'] as const,
};
```

#### 5c. Data hooks

**`packages/lib/src/core/settings/hooks/use-server-settings.ts`**:

```typescript
export function useServerSettings() {
    return useQuery({
        queryKey: settingsKeys.server(),
        queryFn: () => api.settings.server.get(),
    });
}

export function useUpdateServerSettings() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (settings: Partial<ServerSettings>) => api.settings.server.put(settings),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: settingsKeys.server() }),
    });
}
```

### Phase 6: People App — Settings Screen

#### 6a. New route

**`apps/people/src/routes/_auth.settings.tsx`**:

A form page (not a column layout — settings doesn't need list/detail). Contains:

- **Storage Limits** section:
  - Max home size (number input, MB, min 10)
  - Max single file upload size (number input, MB, min 1)
  - Max batch file upload size (number input, MB, min 1)
- **Storage** section:
  - Default storage type for new homes (select: Local (ID-based) / Local (filenames) / S3)
- **Save** button at bottom

Uses `useServerSettings()` to load current values, `useUpdateServerSettings()` to save. Shows toast on success/error.

#### 6b. Sidebar update

**`apps/people/src/components/people/people-sidebar.tsx`** — Add Settings item:

```tsx
<SidebarItem
    icon={<Settings className="h-4 w-4" />}
    label="Settings"
    to="/settings"
    condensed={condensed}
/>
```

Place after Members and Teams, separated by the existing `<Separator>`.

#### 6c. Form design

```
┌─────────────────────────────────────────────┐
│  Settings                                   │
├─────────────────────────────────────────────┤
│                                             │
│  Storage Limits                             │
│  ─────────────                              │
│  Max home size              [  100  ] MB    │
│  Max file upload size       [   35  ] MB    │
│  Max batch file upload size [   10  ] MB    │
│                                             │
│  Defaults                                   │
│  ─────────                                  │
│  Storage type for new homes                 │
│  [ Local (ID-based)          ▼ ]            │
│                                             │
│                          [ Save changes ]   │
│                                             │
└─────────────────────────────────────────────┘
```

Uses existing shadcn components: `Input` (type="number"), `Select`, `Button`, `Label`, `Separator`.

Form state managed with `useState`, initialized from `useServerSettings()` data. Save button disabled when no changes
or mutation is pending.

## File Change Summary

| File                                                     | Action | Description                                  |
|----------------------------------------------------------|--------|----------------------------------------------|
| `apps/api/src/lib/config/server-config.ts`               | Edit   | Add `secret` field to `ServerConfig`         |
| `apps/api/src/lib/config/server-settings.ts`             | New    | `ServerSettings` type, store, accessors      |
| `apps/api/src/lib/setup/setup.ts`                        | Edit   | Generate secret during setup                 |
| `apps/api/src/lib/auth/auth.ts`                          | Edit   | Read secret from config                      |
| `apps/api/src/lib/home/home.ts`                          | Edit   | Use `getMaxHomeSize()` instead of hardcoded  |
| `apps/api/src/lib/mount/mount.ts`                        | Edit   | Use `getDefaultStorageType()` for new mounts |
| `apps/api/src/routes/drive.ts`                           | Edit   | Dynamic upload size validation               |
| `apps/api/src/routes/contacts.ts`                        | Edit   | Dynamic avatar upload size validation        |
| `apps/api/src/routes/settings.ts`                        | New    | GET/PUT `/settings/server` endpoints         |
| `apps/api/src/app.ts`                                    | Edit   | Register `settingsRouter`                    |
| `packages/lib/src/types/settings.ts`                     | Edit   | Add `ServerSettings` type                    |
| `packages/lib/src/core/settings/hooks/keys.ts`           | New    | Query keys for settings                      |
| `packages/lib/src/core/settings/hooks/use-server-settings.ts` | New | `useServerSettings`, `useUpdateServerSettings` |
| `packages/lib/src/core/settings/hooks/index.ts`          | New    | Barrel export                                |
| `packages/lib/src/core/settings/index.ts`                | New    | Barrel export                                |
| `apps/people/src/routes/_auth.settings.tsx`              | New    | Settings page with form                      |
| `apps/people/src/components/people/people-sidebar.tsx`   | Edit   | Add Settings nav item                        |

## Open Questions

1. **Quota enforcement**: This plan makes quotas visible and configurable but does not add enforcement (rejecting
   uploads when home is full). Should enforcement be part of this work or a follow-up?

2. **Per-user overrides**: Should individual users be able to have a quota override (e.g., give one user 500 MB while
   the default is 100 MB)? If so, this would go in UserSettings and `home.size()` would check user setting first, then
   fall back to server setting. Not included in this plan — can be added later.

3. **S3 config editing**: Should the admin be able to change S3 bucket/region/keys from the settings screen, or only
   during setup? Currently excluded — changing storage backend at runtime is dangerous (existing files wouldn't move).

4. **Secret rotation**: Should the admin be able to rotate the auth secret? This invalidates all sessions. Could be
   useful but needs a "are you sure" confirmation. Not included in this plan.

## Non-Goals

- No migration logic — data is throwaway during dev.
- No per-user or per-team quota overrides (future work).
- No S3 config editing at runtime.
- No secret rotation UI.
- No quota enforcement (just making the limit configurable and visible).
