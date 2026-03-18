# Plan: Server Settings, Quotas & Admin Configuration

## Goal

Add server-level configuration (auth secret, storage quotas, upload limits), per-mount quotas, per-team overrides,
quota enforcement, and an admin settings screen in the People app.

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

| Value                | Location                             | Current                                     |
|----------------------|--------------------------------------|---------------------------------------------|
| Auth secret          | `apps/api/src/lib/auth/auth.ts:97`   | Hardcoded base64 string                     |
| Home max size        | `apps/api/src/lib/home/home.ts:110`  | `50` MB hardcoded, **not enforced**         |
| Single file upload   | `apps/api/src/routes/drive.ts:91`    | `35 * 1024 * 1024` (35 MB)                 |
| Batch file upload    | `apps/api/src/routes/drive.ts:98`    | `10 * 1024 * 1024` (10 MB)                 |
| Contact avatar       | `apps/api/src/routes/contacts.ts:93` | `15 * 1024 * 1024` (15 MB)                 |
| Default storage type | `apps/api/src/lib/mount/mount.ts:730`| Hardcoded `'local'`, ignores server config  |

### Key architecture facts

- **Single-org model**: One org per Eigen instance.
- **OrgHome** (`org-home.ts`) is empty — has `orgId`, `homeDir`, `fs`, nothing else.
- **Settings pattern** established: `JsonStore<T>` for UserSettings and TeamSettings, with GET/PUT endpoints.
- **No quota enforcement**: `home.size()` calculates usage and returns a hardcoded `max`, nothing blocks uploads.
- **TeamHome** already has `calendar.enabled` toggle pattern we can reuse for team drive.
- **`getMemberships(userId)`** returns `{ orgIds, teamIds }` — available for quota resolution.

---

## Design Decisions

### 1. Secret — auto-generated, immutable, in config.json

The better-auth `secret` is an HMAC signing key for sessions. It belongs in `config.json` because:

- Generated once during setup, must never change accidentally
- Changing it **invalidates every active session** (all users get logged out)
- Not a tunable setting — it's cryptographic infrastructure

**No admin UI for secret.** If rotation is ever needed (security incident), a CLI command with explicit confirmation
is appropriate. Not a UI button.

### 2. Split config vs settings — Option C

- **`config.json`** — Infrastructure: domain, storage, orgId, secret. Written during setup. Immutable at runtime.
- **`settings.json`** — Runtime: quotas, upload limits, mount defaults. Editable by admins. Sensible defaults.

Rationale:

1. Settings must be readable **before** any Home is initialized (to pass defaults to new homes and upload limits to
   routes at startup).
2. Avoids coupling to OrgHome lifecycle — OrgHome is lazily created and destroyed on timeout.
3. Keeps `config.json` clean. No risk of admin accidentally breaking infrastructure config.
4. `JsonStore` defaults handle missing keys gracefully — adding new settings never breaks existing installs.

### 3. Quota model — separate buckets, per-mount limits

Two independent quota buckets per user:

- **Mail + Contacts** — combined quota (`mailAndContactsMaxMB`). Mail can grow fast with attachments; contacts are
  small. Grouped because they share a lifecycle and are both non-mount storage.
- **Drive mounts** — each mount has its own `maxSizeMB` in `MountConfig`. This is critical: when users later add
  extra mounts (NAS, S3 bucket), each mount has independent quota control.

Why separate: different workloads, different growth patterns. An email-heavy user shouldn't be blocked from uploading
files to drive, and vice versa.

### 4. Mount settings — stamped at first home init

Server settings define a **default mount template** (storageType, maxSizeMB). When a user's Drive initializes for
the first time:

1. Check if `UserSettings.mounts.default` exists
2. If not → read server defaults → stamp into `UserSettings.mounts.default`
3. Use stamped config for mount creation

The stamp happens at **first home init**, not at signup. This is intentional:

- Homes are lazily created (via `getHome()` singleton factory)
- If admin changes defaults after signup but before first login, user gets the latest defaults (they have no prior
  expectation since they haven't used their home yet)
- Once stamped, user settings are independent — admin changes only affect future users

This cleanly supports adding extra mounts later: user adds a mount, its config (including maxSizeMB) is written to
`UserSettings.mounts[mountId]`.

### 5. Per-team overrides — most permissive wins

A user's **effective quota** = `max(server default, ...all team overrides that are set)`.

Rules:

- Teams can **elevate** members' quotas, never restrict below server default
- `undefined` in team settings = "inherit" (team doesn't contribute to max calculation)
- If user is in Team A (200 MB mount max) and Team B (500 MB mount max), effective = `max(server, 200, 500)`
- User in no teams → effective = server default

Teams also control their **own** resources (independent of member overrides):

- `drive.enabled` — enable/disable team drive (mirrors existing `calendar.enabled` pattern)
- `drive.maxSizeMB` — team drive's own quota

### 6. Quota enforcement — soft limit at upload time

Enforce at upload entry points only (drive upload, batch upload, contact avatar):

```
if (currentUsage + fileSize > effectiveMax) → 413 "Storage quota exceeded"
```

**Two-stage check** in upload handlers:
1. File size check: `file.size > maxUploadSizeMB` → reject (too large for a single upload)
2. Quota check: `currentUsage + file.size > effectiveQuota` → reject (would exceed storage)

**Soft limit**: concurrent uploads may slightly exceed quota due to race conditions. This is acceptable — the overage
is small and self-correcting (next upload will be blocked). Hard enforcement would require file-level locking which
is overkill.

**Over-quota handling** (admin lowers limit, or team membership changes):
- Existing data is **never auto-deleted**
- New uploads are rejected with 413
- UI shows "over quota" state with current usage vs max
- User must delete files to get back under quota

### 7. Unified MountSettings — shared between users and teams

Both users and teams store mount configuration via a shared `MountSettings` type in a `mounts` record. This means:

- The **"add mount" wizard** is identical for teams (People app) and users (Space app, later)
- `Drive.init()` is generic — reads mounts from `home.settings`, initializes enabled ones
- Teams start with **no mounts** by default (admin adds mounts explicitly)
- Users always have a `default` mount (stamped from server settings at first init)
- Mounts can be **enabled/disabled** and `maxSizeMB` changed, but **never deleted** (data preservation)
- `storageType` is immutable after creation (changing would orphan existing files)

### 8. Team homes are always active

All team homes stay in memory. For quota resolution we use `getHome(teamOwnerId(teamId))` directly — no need for a
lightweight settings reader. This is simpler and guarantees settings are always fresh.

---

## Data Model

### ServerConfig (config.json) — add `secret`

```typescript
type ServerConfig = {
    domain: string;
    orgName: string;
    orgId: string;
    storage: { type: 'local-id' | 'local-fullnames' | 's3'; s3?: S3Config };
    secret: string;           // better-auth HMAC secret, base64-encoded, auto-generated at setup
    setupCompleted: boolean;
    setupCompletedAt?: string;
};
```

### ServerSettings (settings.json) — NEW

```typescript
type ServerSettings = {
    quotas: {
        mailAndContactsMaxMB: number;      // Default: 100. Combined mail + contacts per user
        defaultMountMaxSizeMB: number;     // Default: 500. Stamped into new users' default mount
        maxUploadSizeMB: number;           // Default: 35. Max single file upload
        maxBatchUploadSizeMB: number;      // Default: 10. Max per-file in batch upload
    };
    defaults: {
        mount: {
            storageType: 'local-id' | 'local-fullnames' | 's3';  // Inherited from config.json initially
        };
    };
};
```

### MountConfig — add `maxSizeMB`

```typescript
type MountConfig = {
    id: string;
    name: string;
    storageType: 'local' | 'local-key' | 's3';
    isDefault: boolean;
    maxSizeMB?: number;        // Per-mount quota. If unset, falls back to server default
    localPath?: string;
    s3Config?: S3Config;
    createdAt?: Date;
    updatedAt?: Date;
};
```

### MountSettings — NEW, shared between users and teams

Persisted in `UserSettings.mounts` and `TeamSettings.mounts`. The runtime `MountConfig` is derived from this.

```typescript
type MountSettings = {
    storageType: MountConfig['storageType'];
    maxSizeMB?: number;         // Per-mount quota. If unset, falls back to server default
    enabled: boolean;           // Can be toggled. Disabled mounts are not initialized
    name?: string;              // Display name. Defaults to 'My Drive' for 'default', mount id otherwise
};
```

### UserSettings — add `mounts`

```typescript
type UserSettings = {
    theme?: 'light' | 'dark' | 'system';
    mounts?: Record<string, MountSettings>;  // key = mount id. 'default' always exists for users
};
```

The `default` mount is stamped from server settings at first home init. Later, users can add extra mounts
via Space app (same "add mount" wizard used for teams).

### TeamSettings — add `mounts` and `memberOverrides`

```typescript
type TeamSettings = {
    calendar?: {
        enabled?: boolean;
    };
    mounts?: Record<string, MountSettings>;  // key = mount id. Teams start with NO mounts
    memberOverrides?: {
        mailAndContactsMaxMB?: number;  // undefined = inherit from server
        defaultMountMaxSizeMB?: number; // undefined = inherit from server
    };
};
```

Teams start with **no mounts**. An admin adds mounts via an "Add Mount" wizard in the People app. Each mount
has its own enabled/disabled toggle and maxSizeMB. Mounts cannot be deleted — only disabled (data preservation).
`storageType` is immutable after creation.

**How these relate**: `mounts` controls the team's own drive storage. `memberOverrides` elevates individual
members' personal quotas. They are independent concerns.

---

## Implementation Plan

### Phase 1: Auth Secret in Config

1. **`server-config.ts`** — Add `secret: string` to `ServerConfig` type.

2. **`setup.ts`** — Generate `randomBytes(32).toString('base64')` during setup:
   ```typescript
   const serverConfig: ServerConfig = {
       // ...existing fields
       secret: randomBytes(32).toString('base64'),
   };
   ```

3. **`auth.ts`** — Read secret from config:
   ```typescript
   secret: getServerConfig()?.secret ?? '+/SmL4b3+bxwJgsJU7yT1Sbfm9YR/0GZhVGRaBm838c=',
   ```
   Fallback to hardcoded value for backward compatibility with existing dev data (no migration needed).

No UI. Not editable. Not displayed in admin settings.

### Phase 2: Server Settings Store

**New file**: `apps/api/src/lib/config/server-settings.ts`

```typescript
const defaults: ServerSettings = {
    quotas: {
        mailAndContactsMaxMB: 100,
        defaultMountMaxSizeMB: 500,
        maxUploadSizeMB: 35,
        maxBatchUploadSizeMB: 10,
    },
    defaults: {
        mount: {
            storageType: getStorageType(),  // inherit from config.json
        },
    },
};

const serverFs = new LocalFilesystem(getServerDataPath());
const settingsStore = new JsonStore<ServerSettings>(serverFs, 'settings.json', defaults);
await settingsStore.load();

export function getServerSettings(): ServerSettings { return settingsStore.get(); }
export async function updateServerSettings(update: DeepPartial<ServerSettings>) { await settingsStore.set(update); }
```

**Accessor helpers**:

```typescript
export function getMaxUploadSize(): number {
    return getServerSettings().quotas.maxUploadSizeMB * 1024 * 1024;
}
export function getMaxBatchUploadSize(): number {
    return getServerSettings().quotas.maxBatchUploadSizeMB * 1024 * 1024;
}
```

### Phase 3: Mount Config Persistence & Stamping

#### 3a. Shared types

- Add `maxSizeMB?: number` to `MountConfig` in `packages/lib/src/types/mount.ts`
- Add `MountSettings` type to `packages/lib/src/types/settings.ts`
- Update `UserSettings` to use `mounts?: Record<string, MountSettings>`
- Update `TeamSettings` to use `mounts?: Record<string, MountSettings>` + `memberOverrides`

#### 3b. createMountConfig — derive MountConfig from MountSettings

```typescript
export function createMountConfig(id: string, settings: MountSettings): MountConfig {
    return {
        id,
        name: settings.name ?? (id === 'default' ? 'My Drive' : id),
        storageType: settings.storageType,
        isDefault: id === 'default',
        maxSizeMB: settings.maxSizeMB,
    };
}
```

#### 3c. Storage type mapping

Server config types → mount storage types:

```typescript
export function mapStorageType(type: ServerConfig['storage']['type']): MountConfig['storageType'] {
    switch (type) {
        case 'local-id': return 'local-key';
        case 'local-fullnames': return 'local';
        case 's3': return 's3';
    }
}
```

#### 3d. Drive.init() — generic, reads mounts from settings

`Drive.init()` becomes mount-agnostic. It reads whatever mounts exist in settings and initializes enabled ones:

```typescript
async init(): Promise<void> {
    const mountSettings = this.home.settings.get().mounts ?? {};

    for (const [id, ms] of Object.entries(mountSettings)) {
        if (!ms.enabled) continue;
        const config = createMountConfig(id, ms);
        await this.addMount(config);
    }

    this.sharedDb = await getSharedDatabase(this.home);
}
```

This works identically for UserHome and TeamHome. The **caller** is responsible for ensuring the right mounts
exist in settings before `Drive.init()` runs.

#### 3e. UserHome — stamp default mount before init

`UserHome` overrides `init()` to ensure a default mount exists before the generic `Drive.init()` runs:

```typescript
export class UserHome extends Home {
    override async init() {
        // Stamp default mount from server settings if not yet present
        if (!this.settings.get().mounts?.default) {
            const serverSettings = getServerSettings();
            await this.settings.set({
                mounts: {
                    default: {
                        storageType: mapStorageType(serverSettings.defaults.mount.storageType),
                        maxSizeMB: serverSettings.quotas.defaultMountMaxSizeMB,
                        enabled: true,
                    }
                }
            });
        }
        return super.init();
    }
}
```

TeamHome does **not** stamp anything — teams start with no mounts. Mounts are added explicitly via the
"Add Mount" wizard.

### Phase 4: Team Mount Management & Settings

#### 4a. TeamHome — no auto-mounts, update defaults

TeamHome constructor keeps settings minimal. No mounts by default:

```typescript
this.settings = new JsonStore<TeamSettings>(this.fs, 'settings.json', {
    calendar: { enabled: true },
});
```

TeamHome does **not** override `drive` getter (no global enable/disable toggle). Instead, if a team has
no mounts, its drive is simply empty (`listMounts()` returns `[]`). Individual mounts have their own
`enabled` flag.

#### 4b. Mount management endpoints

New endpoints in `apps/api/src/routes/team.ts`:

**Add mount** — creates a new mount for a team:

```typescript
.post("/team/:teamId/mount", async ({params, body, user}) => {
    await requireTeamAdmin(user.id, params.teamId);
    const teamHome = await getHome(teamOwnerId(params.teamId)) as TeamHome;

    const mountId = randomUUID().slice(0, 8);  // short, unique
    const mountSettings: MountSettings = {
        storageType: body.storageType ?? mapStorageType(getServerSettings().defaults.mount.storageType),
        maxSizeMB: body.maxSizeMB ?? getServerSettings().quotas.defaultMountMaxSizeMB,
        enabled: true,
        name: body.name,
    };

    // Write to settings
    await teamHome.settings.set({ mounts: { [mountId]: mountSettings } });

    // Initialize the mount immediately
    const config = createMountConfig(mountId, mountSettings);
    await teamHome.drive.addMount(config);

    return { id: mountId, ...mountSettings };
}, {
    body: t.Object({
        name: t.String({ minLength: 1 }),
        storageType: t.Optional(t.Union([
            t.Literal('local'), t.Literal('local-key'), t.Literal('s3'),
        ])),
        maxSizeMB: t.Optional(t.Number({ minimum: 10 })),
    }),
    auth: true,
})
```

**Update mount** — change enabled/maxSizeMB (storageType is immutable):

```typescript
.put("/team/:teamId/mount/:mountId", async ({params, body, user}) => {
    await requireTeamAdmin(user.id, params.teamId);
    const teamHome = await getHome(teamOwnerId(params.teamId)) as TeamHome;

    const existing = teamHome.settings.get().mounts?.[params.mountId];
    if (!existing) throw new ApiError(404, 'Mount not found');

    await teamHome.settings.set({ mounts: { [params.mountId]: { ...existing, ...body } } });
    return teamHome.settings.get().mounts![params.mountId];
}, {
    body: t.Object({
        enabled: t.Optional(t.Boolean()),
        maxSizeMB: t.Optional(t.Number({ minimum: 10 })),
        name: t.Optional(t.String({ minLength: 1 })),
    }),
    auth: true,
})
```

No delete endpoint. Mounts can only be disabled.

#### 4c. Team settings route — extend for memberOverrides

The existing `PUT /team/:teamId/settings` is extended with `memberOverrides`:

```typescript
.put("/team/:teamId/settings", async ({params, body, user}) => {
    await requireTeamAdmin(user.id, params.teamId);
    const teamHome = await getHome(teamOwnerId(params.teamId)) as TeamHome;
    return await teamHome.settings.set(body);
}, {
    body: t.Object({
        calendar: t.Optional(t.Object({ enabled: t.Optional(t.Boolean()) })),
        memberOverrides: t.Optional(t.Object({
            mailAndContactsMaxMB: t.Optional(t.Nullable(t.Number({ minimum: 10 }))),
            defaultMountMaxSizeMB: t.Optional(t.Nullable(t.Number({ minimum: 10 }))),
        })),
    }),
    auth: true,
})
```

Note: `t.Nullable` allows explicitly setting to `null` to clear an override (revert to inherit).
Mount management is handled via the dedicated mount endpoints above, not through settings.

### Phase 5: Quota Resolution

**New file**: `apps/api/src/lib/config/quota.ts`

All team homes are always active, so we use `getHome()` directly to read team settings.

#### 5a. Quota resolution functions

```typescript
import { getHome } from '../home';
import { teamOwnerId } from '@workspace/lib/types';
import type { TeamHome } from '../home/team-home';

type ResolvedQuotas = {
    mailAndContactsMax: number;   // bytes
    mountMax: number;             // bytes
};

export async function resolveUserQuotas(
    mountConfig: MountConfig,
    teamIds: string[],
): Promise<ResolvedQuotas> {
    const settings = getServerSettings();

    // Candidates: server default + all team overrides that are set
    const mailCandidates = [settings.quotas.mailAndContactsMaxMB];
    const mountCandidates = [mountConfig.maxSizeMB ?? settings.quotas.defaultMountMaxSizeMB];

    for (const teamId of teamIds) {
        const teamHome = await getHome(teamOwnerId(teamId)) as TeamHome;
        const ts = teamHome.settings.get();
        if (ts.memberOverrides?.mailAndContactsMaxMB != null) {
            mailCandidates.push(ts.memberOverrides.mailAndContactsMaxMB);
        }
        if (ts.memberOverrides?.defaultMountMaxSizeMB != null) {
            mountCandidates.push(ts.memberOverrides.defaultMountMaxSizeMB);
        }
    }

    return {
        mailAndContactsMax: Math.max(...mailCandidates) * 1024 * 1024,
        mountMax: Math.max(...mountCandidates) * 1024 * 1024,
    };
}
```

For team mount quotas — per-mount setting or server default:

```typescript
export function resolveTeamMountQuota(mountSettings: MountSettings): number {
    const serverDefault = getServerSettings().quotas.defaultMountMaxSizeMB;
    return (mountSettings.maxSizeMB ?? serverDefault) * 1024 * 1024;
}
```

### Phase 6: Quota Enforcement

#### 6a. Home.size() — return structured quotas

```typescript
public async size(teamIds: string[] = []) {
    const [mail, contacts, driveDefault] = await Promise.all([
        this._mail?.size(),
        this._contacts?.size(),
        this._drive.size('default'),
    ]);

    const mountConfig = this._drive.getMountConfig('default');
    const quotas = await resolveUserQuotas(mountConfig, teamIds);
    const mailAndContactsUsed = (mail || 0) + (contacts || 0);

    return {
        mailAndContacts: { used: mailAndContactsUsed, max: quotas.mailAndContactsMax },
        drive: { default: { used: driveDefault, max: quotas.mountMax } },
        total: {
            used: mailAndContactsUsed + driveDefault,
            max: quotas.mailAndContactsMax + quotas.mountMax,
        },
    };
}
```

`Drive` needs a `getMountConfig(mountId)` accessor to expose the mount's config (including `maxSizeMB`) for
quota resolution. Simple addition:

```typescript
getMountConfig(mountId: string): MountConfig {
    const mount = this.mounts.get(mountId);
    if (!mount) throw new ApiError(404, `Mount ${mountId} not found`);
    return mount.config;
}
```

#### 6b. Upload enforcement — drive routes

Move size validation from Elysia schema to handler (Elysia evaluates `t.File({maxSize})` at registration time,
not per-request):

```typescript
.post("/drive/:ownerId/:mountId/file/:pathId", async ({params, body, user}) => {
    // 1. File size check
    const maxUpload = getMaxUploadSize();
    if (body.file.size > maxUpload) throw new ApiError(413, 'File exceeds max upload size');

    // 2. Quota check
    const home = await getHome(params.ownerId);
    const mountConfig = home.drive.getMountConfig(params.mountId);
    const teamIds = (await getMemberships(user.id)).teamIds;
    const quotas = await resolveUserQuotas(mountConfig, teamIds);
    const currentSize = await home.drive.size(params.mountId);
    if (currentSize + body.file.size > quotas.mountMax) {
        throw new ApiError(413, 'Storage quota exceeded');
    }

    return await home.drive.uploadFile(params.mountId, params.pathId, body.file);
}, { body: t.Object({ file: t.File() }), auth: true })
```

Same pattern for batch upload (check each file + sum, use `getMaxBatchUploadSize()`).

#### 6c. Upload enforcement — contact avatar

Avatar uploads count against `mailAndContactsMax`:

```typescript
.post("/contacts/:ownerId/avatar", async ({body, user}) => {
    if (body.file.size > getMaxUploadSize()) throw new ApiError(413, 'File exceeds max upload size');

    const home = await getHome(user.id);
    const teamIds = (await getMemberships(user.id)).teamIds;
    const quotas = await resolveUserQuotas(home.drive.getMountConfig('default'), teamIds);
    const mailContactsSize = ((await home.mail?.size()) || 0) + ((await home.contacts?.size()) || 0);
    if (mailContactsSize + body.file.size > quotas.mailAndContactsMax) {
        throw new ApiError(413, 'Mail & contacts storage quota exceeded');
    }

    return await (await getContacts(user)).uploadAvatar(body.file);
}, { body: t.Object({ file: t.File({ format: 'image/*' }) }), auth: true })
```

### Phase 7: API Endpoints

**New file**: `apps/api/src/routes/settings.ts`

```typescript
async function requireAdmin(userId: string) {
    const role = await getOrgRole(userId);
    if (role !== 'admin' && role !== 'owner') throw new ApiError(403, 'Admin or owner role required');
}

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
            quotas: t.Optional(t.Object({
                mailAndContactsMaxMB: t.Optional(t.Number({ minimum: 10 })),
                defaultMountMaxSizeMB: t.Optional(t.Number({ minimum: 10 })),
                maxUploadSizeMB: t.Optional(t.Number({ minimum: 1 })),
                maxBatchUploadSizeMB: t.Optional(t.Number({ minimum: 1 })),
            })),
            defaults: t.Optional(t.Object({
                mount: t.Optional(t.Object({
                    storageType: t.Optional(t.Union([
                        t.Literal('local-id'),
                        t.Literal('local-fullnames'),
                        t.Literal('s3'),
                    ])),
                })),
            })),
        }),
        auth: true,
    });
```

Register in `app.ts`:

```typescript
import { settingsRouter } from './routes/settings';
// Add to router chain
.use(settingsRouter)
```

### Phase 8: Shared Types & Hooks

#### 8a. Types

Types are updated in Phase 3/4 (MountConfig, UserSettings, TeamSettings). Additionally, export `ServerSettings`
from `packages/lib/src/types/settings.ts` for frontend use (without the accessors — just the shape).

#### 8b. Query keys

**`packages/lib/src/core/settings/hooks/keys.ts`**:

```typescript
export const settingsKeys = {
    all: ['settings'] as const,
    server: () => [...settingsKeys.all, 'server'] as const,
};
```

#### 8c. Data hooks

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
        mutationFn: (settings: DeepPartial<ServerSettings>) => api.settings.server.put(settings),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: settingsKeys.server() }),
    });
}
```

### Phase 9: People App — Admin Settings Screen

#### 9a. New route

**`apps/people/src/routes/_auth.settings.tsx`**:

A form page. Contains:

- **Storage Quotas** section:
  - Mail & contacts max per user (number input, MB, min 10)
  - Default drive mount max per user (number input, MB, min 10)
  - Max single file upload size (number input, MB, min 1)
  - Max batch file upload size (number input, MB, min 1)
- **Defaults for New Users** section:
  - Storage type for new home mounts (select: Local ID-based / Local Filenames / S3)
- **Save** button

Uses `useServerSettings()` to load, `useUpdateServerSettings()` to save. Toast on success/error.
Save button disabled when no changes or mutation is pending.

#### 9b. Sidebar update

**`apps/people/src/components/people/people-sidebar.tsx`** — Add Settings item after Members and Teams:

```tsx
<SidebarItem icon={<Settings className="h-4 w-4" />} label="Settings" to="/settings" condensed={condensed} />
```

#### 9c. Form wireframe

```
┌──────────────────────────────────────────────────────┐
│  Settings                                            │
├──────────────────────────────────────────────────────┤
│                                                      │
│  Storage Quotas                                      │
│  ──────────────                                      │
│  Mail & contacts per user        [  100  ] MB        │
│  Default drive mount per user    [  500  ] MB        │
│  Max single file upload          [   35  ] MB        │
│  Max batch file upload           [   10  ] MB        │
│                                                      │
│  Defaults for New Users                              │
│  ──────────────────────                              │
│  Storage type for new mounts                         │
│  [ Local (ID-based)                ▼ ]               │
│                                                      │
│                            [ Save changes ]          │
│                                                      │
└──────────────────────────────────────────────────────┘
```

#### 9d. Team settings UI extension

The existing team settings screen (in People app) needs:

- **Mounts** section:
  - List of existing mounts (name, storageType, maxSizeMB, enabled status)
  - **"Add Mount" button** → opens wizard dialog:
    1. Mount name (text input, required)
    2. Storage type (dropdown, defaults to server setting)
    3. Max size MB (number input, defaults to server setting)
  - Per-mount controls: enabled toggle, maxSizeMB input, name edit
  - No delete button — only disable
  - storageType shown as read-only badge after creation
- **Member Quota Overrides** section:
  - Mail & contacts max (number input, with "Inherit from server" as default/clear)
  - Default mount max (number input, with "Inherit from server" as default/clear)

The **"Add Mount" wizard** component should be reusable — it will be used in Space app later for users
adding extra personal mounts. Extract to `packages/ui/src/components/mount/add-mount-wizard.tsx`.

---

## Edge Cases & Safeguards

| Edge Case | Handling |
|-----------|----------|
| Concurrent uploads slightly exceed quota | Soft limit by design. Small overage is self-correcting |
| Admin lowers quota below current usage | Data preserved, new uploads blocked, UI shows over-quota |
| Team membership changes | Quotas recalculated on next request (stateless, no cache to invalidate) |
| Admin changes default mount template | Only affects new users' first home init. Existing users keep stamped values |
| Legacy users without `mounts` in UserSettings | `UserHome.init()` detects missing default, stamps server defaults (seamless) |
| Team with no mounts | Drive is empty, `listMounts()` returns `[]`. Valid state |
| Team mount disabled | Mount not initialized in `Drive.init()`. Accessing it returns 404 |
| User in zero teams | Effective quota = server default. `Math.max(serverDefault)` works fine |
| `settings.json` missing | `JsonStore` returns defaults. File created on first admin save |
| Team memberOverrides all undefined | No contribution to max. Server default applies |
| Upload > max upload size AND within quota | Rejected at file size check (runs before quota check) |
| Batch upload: one large file in batch | Each file checked against `maxBatchUploadSizeMB` individually |
| Team mount quota | Per-mount via `resolveTeamMountQuota()`. Independent of member overrides |
| config.json has no `secret` field (old setup) | Fallback to hardcoded value. No breakage |
| S3 storage type selected but no S3 config | Mount creation would fail. Validate at mount creation time |
| Attempt to change mount storageType | Rejected — storageType is immutable after creation |
| Attempt to delete a mount | No endpoint. Mounts can only be disabled (data preservation) |

---

## File Change Summary

| File | Action | Description |
|------|--------|-------------|
| `packages/lib/src/types/settings.ts` | Edit | Add `ServerSettings`, `MountSettings`, extend `UserSettings` (mounts), extend `TeamSettings` (mounts, memberOverrides) |
| `packages/lib/src/types/mount.ts` | Edit | Add `maxSizeMB` to `MountConfig` |
| `apps/api/src/lib/config/server-config.ts` | Edit | Add `secret` to `ServerConfig` |
| `apps/api/src/lib/config/server-settings.ts` | New | `ServerSettings` store, defaults, accessors |
| `apps/api/src/lib/config/quota.ts` | New | `resolveUserQuotas()`, `resolveTeamMountQuota()` |
| `apps/api/src/lib/setup/setup.ts` | Edit | Generate `secret` during setup |
| `apps/api/src/lib/auth/auth.ts` | Edit | Read secret from config (fallback to hardcoded) |
| `apps/api/src/lib/home/home.ts` | Edit | Structured `size()` with resolved quotas |
| `apps/api/src/lib/home/user-home.ts` | Edit | Override `init()` to stamp default mount |
| `apps/api/src/lib/home/team-home.ts` | Edit | Update defaults (no auto-mounts), remove drive override |
| `apps/api/src/lib/drive/drive.ts` | Edit | Generic `init()` reads mounts from settings, add `getMountConfig()` |
| `apps/api/src/lib/mount/mount.ts` | Edit | `createMountConfig()` from MountSettings, `mapStorageType()` |
| `apps/api/src/routes/drive.ts` | Edit | Dynamic upload size + quota enforcement |
| `apps/api/src/routes/contacts.ts` | Edit | Dynamic avatar size + quota enforcement |
| `apps/api/src/routes/team.ts` | Edit | Add mount management endpoints (POST/PUT), extend settings for memberOverrides |
| `apps/api/src/routes/settings.ts` | New | GET/PUT `/settings/server` (admin only) |
| `apps/api/src/app.ts` | Edit | Register `settingsRouter` |
| `packages/lib/src/core/settings/hooks/keys.ts` | New | Query keys |
| `packages/lib/src/core/settings/hooks/use-server-settings.ts` | New | `useServerSettings`, `useUpdateServerSettings` |
| `packages/lib/src/core/settings/hooks/index.ts` | New | Barrel export |
| `packages/lib/src/core/settings/index.ts` | New | Barrel export |
| `packages/ui/src/components/mount/add-mount-wizard.tsx` | New | Reusable "Add Mount" wizard (shared by People + Space) |
| `apps/people/src/routes/_auth.settings.tsx` | New | Admin settings form page |
| `apps/people/src/components/people/people-sidebar.tsx` | Edit | Add Settings nav item |

---

## Non-Goals

- **No data migration** — data is throwaway during dev
- **No S3 config editing at runtime** — changing storage backend is dangerous (existing files wouldn't move)
- **No secret rotation UI** — CLI/emergency action for later
- **No per-user quota overrides in admin UI** — UserSettings already supports it structurally; UI can be added later
- **No retroactive "apply new defaults to existing users"** — by design (stamp once, then independent)
- **No mount deletion** — mounts can only be disabled (data preservation)
- **No storageType change after mount creation** — would orphan existing files
- **No user-facing "add extra mount" UI yet** — the wizard component is built, but Space app integration is future work
