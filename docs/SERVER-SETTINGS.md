# Server Settings

## TLDR

Runtime-configurable server settings stored in `data/server/settings.json` via `JsonStore`. Admins manage quotas and
defaults through the People app settings page. Separate from `config.json` (infrastructure, immutable at runtime).

## JsonStore

Generic JSON persistence with deep-merge updates, used by ServerSettings, UserSettings, and TeamSettings.

- Constructed with a `LocalFilesystem`, filename, and typed defaults
- `load()` reads from disk, deep-merges onto defaults (missing keys get default values)
- `get()` returns the current in-memory state
- `set(update)` deep-merges the partial update, writes atomically (tmp + rename), rolls back on failure
- Missing file on load is not an error -- defaults are used, file created on first `set()`

| File                                  | Purpose                                     |
|---------------------------------------|---------------------------------------------|
| `apps/api/src/lib/core/json-store.ts` | `JsonStore<T>` class, `DeepPartial<T>` type |

## ServerSettings Type

```typescript
type ServerSettings = {
    quotas: {
        mailAndContactsMaxMB: number;      // Default: 100
        defaultMountMaxSizeMB: number;     // Default: 500
        maxUploadSizeMB: number;           // Default: 35
        maxBatchUploadSizeMB: number;      // Default: 10
    };
    defaults: {
        mount: {
            storageType: 'local-id' | 'local-fullnames' | 's3';
        };
    };
};
```

Defined in `packages/lib/src/types/settings.ts`. The `storageType` maps to mount-level types via `mapStorageType()`
(`local-id` -> `local-key`, `local-fullnames` -> `local`, `s3` -> `s3`).

## Server-Side Store

The settings store initializes at module load. On first load, if `settings.json` does not exist and setup is
completed, it inherits the storage type from `config.json`.

Exported accessors:

| Function                       | Returns                                      |
|--------------------------------|----------------------------------------------|
| `getServerSettings()`          | Full `ServerSettings` object                 |
| `updateServerSettings(update)` | Deep-merges partial update, persists         |
| `getMaxUploadSize()`           | `maxUploadSizeMB * 1024 * 1024` (bytes)      |
| `getMaxBatchUploadSize()`      | `maxBatchUploadSizeMB * 1024 * 1024` (bytes) |

| File                                         | Purpose                   |
|----------------------------------------------|---------------------------|
| `apps/api/src/lib/config/server-settings.ts` | Store instance, accessors |

## Admin API

All endpoints require admin or owner role. Defined in `apps/api/src/routes/settings.ts`.

| Method | Path                     | Description                                  |
|--------|--------------------------|----------------------------------------------|
| GET    | `/settings/server`       | Read current server settings                 |
| PUT    | `/settings/server`       | Update quotas and/or defaults (partial)      |
| GET    | `/settings/s3config`     | Read S3 storage configuration                |
| PUT    | `/settings/s3config`     | Update S3 storage configuration              |
| POST   | `/settings/s3check`      | Test S3 connection with provided credentials |
| DELETE | `/settings/user/:userId` | Delete a user account (cannot delete self)   |

## Frontend Hooks

| Hook                                    | Purpose                                                   |
|-----------------------------------------|-----------------------------------------------------------|
| `useServerSettings()`                   | Fetches server settings (5 min stale time)                |
| `useUpdateServerSettings()`             | Mutation to save settings, invalidates cache, shows toast |
| `invalidateServerSettings(queryClient)` | Manual cache invalidation                                 |

Query key: `['settings', 'server']`

| File                                                          | Purpose              |
|---------------------------------------------------------------|----------------------|
| `packages/lib/src/core/settings/hooks/use-server-settings.ts` | Hooks and query keys |

## Settings UI

The People app has a `/settings` route with the `ServerSettingsPage` component. Contains:

- **Storage Quotas** -- mail/contacts max, default mount max, upload limits
- **Default Mount Storage Type** -- dropdown for new user mounts
- **S3 Configuration** -- endpoint, bucket, credentials, connection test

| File                                                    | Purpose            |
|---------------------------------------------------------|--------------------|
| `apps/people/src/routes/_auth.settings.tsx`             | Route definition   |
| `apps/people/src/components/people/server-settings.tsx` | Settings form page |

## config.json vs settings.json

|              | `config.json`                           | `settings.json`             |
|--------------|-----------------------------------------|-----------------------------|
| **Path**     | `data/server/config.json`               | `data/server/settings.json` |
| **Written**  | During setup                            | By admin at runtime         |
| **Contains** | domain, orgName, orgId, storage, secret | quotas, mount defaults      |
| **Editable** | No (immutable after setup)              | Yes (admin settings UI)     |

## File Reference

| File                                                          | Purpose                                                                 |
|---------------------------------------------------------------|-------------------------------------------------------------------------|
| `packages/lib/src/types/settings.ts`                          | `ServerSettings`, `UserSettings`, `TeamSettings`, `MountSettings` types |
| `apps/api/src/lib/core/json-store.ts`                         | `JsonStore<T>` generic persistence                                      |
| `apps/api/src/lib/config/server-settings.ts`                  | Server settings store and accessors                                     |
| `apps/api/src/routes/settings.ts`                             | Admin API endpoints                                                     |
| `packages/lib/src/core/settings/hooks/use-server-settings.ts` | Frontend hooks                                                          |
| `apps/people/src/routes/_auth.settings.tsx`                   | Settings route                                                          |
| `apps/people/src/components/people/server-settings.tsx`       | Settings form UI                                                        |
