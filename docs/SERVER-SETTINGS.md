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
  missing file leaves the defaults in place; a file that does not parse rejects the load, so the home fails to boot
  rather than letting the next `set()` persist defaults over the real bytes
- The merge recurses into plain objects only: an array or `null` in the update replaces the stored value wholesale,
  and an explicitly `undefined` key clears it (how `routes/team.ts` clears a member override)
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
| GET    | `/settings/users`         | `AdminUserRow[]` — every org member **and** orphan for the Users page (auth-DB join incl. `lastLoginAt` + session-derived `lastActiveAt`, teams) |
| GET    | `/settings/users/usage`   | `Record<userId, HomeSizeResponse>` — per-user disk usage via the `pullHomeSize` home-relay read, which sizes a home from its own files (the mount `metadata.db` total + the maildir/cards/avatars walks) rather than booting it (concurrency 4, 5-min in-memory cache) |
| GET    | `/settings/users/guests`  | Guest accounts only, for the admin Guests page                 |
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

## Mail environment

Whether this deployment hosts mailboxes at all, and how the API hands mail to an MTA, are deployment identity rather than runtime settings, so they live in the environment: `isMailEnabled()` (`apps/api/src/lib/config/env.ts`) and `createTransport()` (`apps/api/src/lib/core/mailer.ts`). Without `SMTP_HOST` the transport is local `/usr/sbin/sendmail`.

| Variable        | Default              | Meaning                                                                       |
|-----------------|----------------------|-------------------------------------------------------------------------------|
| `MAIL_ENABLED`  | on                   | `0` on a server run without the `mail` docker profile — no hosted mailboxes     |
| `SMTP_HOST`     | `postfix` in compose | The MTA to relay through. Unset → sendmail                                     |
| `SMTP_PORT`     | `25`                 | Its port                                                                       |
| `SMTP_USER`     | unset                | SASL username. Set it and the transport authenticates                          |
| `SMTP_PASSWORD` | unset                | SASL password                                                                  |
| `SMTP_SECURE`   | port `465`           | `1` = implicit TLS from the first byte, `0` = plain + STARTTLS                  |

`MAIL_ENABLED` rides out to the frontend as `mailEnabled` on `GET /p/config`, where `useMailEnabled()` (`packages/lib/src/core/public/hooks/use-public.ts`) is the one read of it. Outbound mail is unaffected: share notifications, invites and "Email collaborators" keep going out over SMTP with mailboxes off.

Certificate verification follows `SMTP_USER`: an anonymous hop is the bundled postfix or a host-local relay (self-signed, no cert) and stays unverified, while a relay that takes credentials must present a certificate that checks out. These are the API's own credentials — the `SMTP_RELAY_*` pair in `.env.production` is read by the bundled postfix instead, and the two are independent.
