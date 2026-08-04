# Server Settings

> **TLDR**: Runtime-configurable server settings in `data/server/settings.json`, held by a `JsonStore` with typed
> defaults. Admins edit them from the Admin app. `config.json` is the separate, setup-time identity file — it holds
> domain, orgName, orgId and secret, and nothing about storage. The storage type and S3 credentials are settings,
> under `defaults.mount`.

## config.json vs settings.json

|              | `config.json`                     | `settings.json`                              |
|--------------|-----------------------------------|----------------------------------------------|
| **Path**     | `data/server/config.json`         | `data/server/settings.json`                  |
| **Written**  | During setup                      | By an admin at runtime                       |
| **Contains** | domain, orgName, orgId, secret    | quotas, mount defaults, onboarding, guests, landing, notifications |
| **Editable** | No (immutable after setup)        | Yes (admin settings UI)                      |

`config.json` has **no** storage field (`apps/api/src/lib/config/server-config.ts`). Storage type and S3
credentials live in `settings.json` under `defaults.mount`. The settings store is a plain `JsonStore` with a
hardcoded `'local-fullnames'` default — it does not read anything out of `config.json`.

## JsonStore

Generic JSON persistence with deep-merge updates (`apps/api/src/lib/core/json-store.ts`), shared by ServerSettings,
UserSettings and TeamSettings.

- Constructed with a `LocalFilesystem`, a filename, and typed defaults
- `load()` reads the file and deep-merges it onto the defaults, so keys added later get their default value. A
  missing file or a parse error leaves the defaults in place
- `get()` returns the in-memory state; `set(update)` deep-merges a partial, writes atomically (tmp + rename),
  rolls back on failure, and returns the merged state
- The file is created on the first `set()`, not on `load()`

## What ServerSettings Holds

The type is defined in `packages/lib/src/types/settings.ts`; the defaults live next to the store in
`apps/api/src/lib/config/server-settings.ts`. Read those two for the exact shape — the branches are:

**`quotas`** — `mailAndContactsMaxMB` (100), `defaultMountMaxSizeMB` (500), `maxUploadSizeMB` (35), and
`trashRetentionDays` (30), which is how long `Mount` keeps soft-deleted paths before purging them. See
[QUOTA.md](QUOTA.md) and [SOFT-DELETE.md](SOFT-DELETE.md).

**`defaults.mount`** — `storageType` (`local-id` | `local-fullnames` | `s3`) and an optional `s3Config`. The
storage type is the backend given to a **new** user or team drive; existing mounts are never migrated.
`mapStorageType()` translates it to the mount-level type (`local-id` → `local-key`, `local-fullnames` → `local`,
`s3` → `s3`), and `UserHome`/`TeamHome` call it when they create a default mount. See [STORAGE.md](STORAGE.md).

**`onboarding`** — `waitlist.enabled` puts the "Join Waitlist" form on the landing page and gates every waitlist
route (`requireWaitlistEnabled`); `autoAddOwnerContact` seeds a new user's contacts with the org owner;
`welcomeMail` (enabled, subject, body) goes to a new account; `inviteEmail` (subject, body) is the mail a waitlist
accept sends. Bodies are HTML with `{name}` / `{orgName}` / `{domain}` / `{inviteLink}` placeholders.

**`guests`** — `openSignup` (any address may request an OTP) and `inactivityDays` (how long a guest survives
without session activity). See [GUEST-ACCESS.md](GUEST-ACCESS.md).

**`landing.links`** — optional extra buttons on the public landing page, each `{ title, url }`. Served to the
unauthenticated frontend through the public config route.

### notifications.email

The cross-cutting seam. Each flag turns one *email* on or off; the matching in-app notification always fires
regardless.

| Flag                   | Default | Fires when                                                          |
|------------------------|---------|---------------------------------------------------------------------|
| `guestOnAclAdd`        | `true`  | An address with no account (or a guest) is added to an ACL. This is the guest-onboarding trigger — see [GUEST-ACCESS.md](GUEST-ACCESS.md) |
| `userOnAclAdd`         | `false` | A registered user is added to an ACL — the bell already covers it    |
| `userOnCalendarInvite` | `true`  | A user is invited to an event — time-sensitive, matches Google/Outlook |
| `ownerOnAccessRequest` | `true`  | Someone requests access to an owner's path                          |

The ACL flags are read by `emailNewlyAddedAclEntries` in `apps/api/src/lib/drive/acl-propagation.ts`, the
access-request flag by `propagateAccessRequest` in `access-request-propagation.ts`. See [ACL.md](ACL.md).

## Server-Side Store

`apps/api/src/lib/config/server-settings.ts` builds the store at module load and awaits one `load()`.

| Function                       | Returns                                             |
|--------------------------------|-----------------------------------------------------|
| `getServerSettings()`          | The full `ServerSettings` object                    |
| `updateServerSettings(update)` | Deep-merges a partial update and persists it        |
| `getMaxUploadSize()`           | `quotas.maxUploadSizeMB` in bytes                   |
| `getStorageType()`             | `defaults.mount.storageType`                        |
| `getS3Config()`                | `defaults.mount.s3Config` (undefined when unset)    |

## Admin API

All endpoints require the org role `admin` or `owner`. Defined in `apps/api/src/routes/settings.ts`.

| Method | Path                      | Description                                                    |
|--------|---------------------------|----------------------------------------------------------------|
| GET    | `/settings/server`        | Read current server settings                                   |
| PUT    | `/settings/server`        | Partial update of any branch                                   |
| GET    | `/settings/s3config`      | Read the saved S3 configuration                                |
| PUT    | `/settings/s3config`      | Validate a connection, then write `defaults.mount.s3Config`     |
| POST   | `/settings/s3check`       | Test an S3 connection without saving                           |
| GET    | `/settings/users/:filter` | `guest` or `orphan` user list for the admin app                |
| DELETE | `/settings/user/:userId`  | Delete a user account (cannot delete self)                     |

Both S3 paths refuse a configuration that does not connect: `PUT /settings/s3config` runs `checkS3Connection`
before saving, and `PUT /settings/server` refuses `storageType: 's3'` unless a saved S3 config exists **and** still
connects. So the server never ends up defaulting new drives to a bucket it cannot reach.

## Frontend

Hooks in `packages/lib/src/core/settings/hooks/`: `useServerSettings()` / `useUpdateServerSettings()` /
`invalidateServerSettings()` over query key `['settings', 'server']`, `useServerS3Config()` /
`useUpdateServerS3Config()` / `invalidateServerS3Config()` over `['settings', 's3config']`, and
`useCheckS3Connection()` for the test button. Both queries use a 5-minute stale time.

The Admin app's `/settings` route renders `ServerSettingsPage`
(`apps/admin/src/components/admin/server-settings.tsx`) with four sections:

- **Storage Quotas** — mail/contacts max, default mount max, upload limit, trash retention
- **Defaults** — the storage type picker, which carries the S3 endpoint/bucket/credentials and the connection test
  inline (there is no separate S3 section)
- **Email notifications** — the four `notifications.email` switches
- **Landing page** — the landing link buttons

Onboarding and guest settings are separate admin pages over the same `PUT /settings/server` route — see
[ORGANISATIONS-AND-TEAMS.md](ORGANISATIONS-AND-TEAMS.md).
