# Server Settings

> **TLDR**: Runtime-configurable server settings in `data/server/settings.json`, held by a `JsonStore` with typed
> defaults. Admins edit them from the Admin app. `config.json` is the separate, setup-time identity file — it holds
> orgName, orgId and the auth secret (made at first boot, never changed), and nothing about storage or the web address, which is `DOMAIN` alone (`getDomain()`). The storage type and S3 credentials are settings,
> under `defaults.mount`.

## config.json vs settings.json

|              | `config.json`                     | `settings.json`                              |
|--------------|-----------------------------------|----------------------------------------------|
| **Path**     | `data/server/config.json`         | `data/server/settings.json`                  |
| **Written**  | Secret at first boot, the rest during setup | By an admin at runtime                       |
| **Contains** | orgName, orgId, secret            | quotas, mount defaults, onboarding, guests, landing, notifications |
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
| GET    | `/settings/users/usage`   | `Record<userId, HomeSizeResponse>` — per-user disk usage via the `pullHomeSize` home-relay read, which sizes a home from its own databases (the mount `metadata.db`, `mail.db`, `contacts.db` and `calendar.db` totals, plus the avatars walk) rather than booting it (concurrency 4, 5-min in-memory cache) |
| GET    | `/settings/users/guests`  | Guest accounts only, for the admin Guests page                 |
| DELETE | `/settings/user/:userId`  | Delete a user account (cannot delete self)                     |
| PUT    | `/settings/user/:userId/password` | Set a user's password via `resetUserPassword()`, the CLI's `./eigen reset-password` path: signs them out everywhere and revokes their app passwords; refuses guests and the owner. better-auth's own `/auth/admin/set-user-password`, which revokes nothing, is in `disabledPaths` |

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

Whether this deployment hosts mailboxes at all, and how the API hands mail to an MTA, are deployment identity rather than runtime settings, so they live in the environment: `isMailEnabled()` (`apps/api/src/lib/config/env.ts`) and `createTransport()` (`apps/api/src/lib/core/mailer.ts`). The operator sets one relay, `SMTP_RELAY_*`, read in both modes: with hosted mail the API hands everything to the bundled Postfix (`SMTP_HOST`, set by Compose) and Postfix relays through `SMTP_RELAY_*`; without it the API sends through `SMTP_RELAY_*` itself. With no server to hand mail to, the transport is local `/usr/sbin/sendmail`.

| Variable              | Default              | Meaning                                                                    |
|-----------------------|----------------------|----------------------------------------------------------------------------|
| `MAIL_ENABLED`        | on                   | `0` on a server run without the `mail` docker profile — no hosted mailboxes |
| `SMTP_HOST`           | `postfix` in compose | With hosted mail: where the API hands its mail (Mailpit in dev)             |
| `SMTP_PORT`           | `25`                 | Its port                                                                    |
| `SMTP_RELAY_HOST`     | unset                | The outgoing relay. Unset: Postfix delivers directly, or, without hosted mail, every email fails |
| `SMTP_RELAY_PORT`     | `587`                | Its port. `465` is implicit TLS, any other port STARTTLS                    |
| `SMTP_RELAY_USER`     | unset                | SASL username. Set it and the transport authenticates                       |
| `SMTP_RELAY_PASSWORD` | unset                | SASL password. Required whenever `SMTP_RELAY_USER` is set                   |
| `SMTP_FROM`           | `<org name> <noreply@MAIL_DOMAIN>` | The system sender: an address or `Name <address>`; a bare address keeps the org name |

`MAIL_ENABLED` rides out to the frontend as `mailEnabled` on `GET /p/config`, where `useMailEnabled()` (`packages/lib/src/core/public/hooks/use-public.ts`) is the one read of it: it reports on until the config lands, so the common deployment never flashes a missing Mail app. `useMailboxes` is the exception — it gates its fetch on `mailEnabled === true` from the config itself, so a mail-off server is never asked for a mailbox list. Outbound mail goes on with mailboxes off, as long as a relay is set: share notifications, invites and "Email collaborators" go out through it. Without a relay every email fails, two-factor codes by email and guest sign-in codes included; `./eigen setup` says so when it writes that shape.

**Sending on a user's behalf.** `onBehalfOf()` (`mailer.ts`) picks the From of mail a user causes (share notifications, invitations, "Email collaborators", iMIP). With hosted mail and an address this server hosts, the user's own address is the From. Otherwise, mail off or an outside address, a relay would refuse the user's address and receivers enforce DMARC, so the From is the system sender with the user's name, `Ada via Acme <noreply@example.com>`, and Reply-To is the user. The system sender's own mail (codes, notifications) always comes from `SMTP_FROM`.

**What mail off leaves out.** No Mail app, no IMAP, no inbound mail. Every home still builds its Maildir and watcher, an idle cost. The `/mail/:ownerId/*` routes stay live; the UI hides them, and a direct send from them uses the user's address, which a relay refuses. Calendar invitations go out, but replies from outside attendees go to the organizer's own mailbox and Eigen never updates their status, since inbound iMIP needs hosted mail. The role addresses `postmaster@`, `abuse@` and `noreply@` stay unclaimable, and an address on the server's own mail domain is never a guest, even when its mailbox lives elsewhere.

Transport security follows `SMTP_RELAY_USER`: the hop to Postfix and an anonymous relay (self-signed, no cert) keep opportunistic TLS, while a relay that takes credentials must accept TLS, so credentials never travel in the clear; the API also checks the relay's certificate. `SMTP_RELAY_USER` without `SMTP_RELAY_PASSWORD` is a config error — `createTransport()` throws rather than authenticate with a blank password.
