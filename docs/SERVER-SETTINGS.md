# Server Settings

> **TLDR**: Runtime-configurable server settings in `data/server/settings.json`, held by a `JsonStore` with typed defaults. The owner edits them from the Admin app. `config.json` is the separate identity file: the auth secret (made at first boot, never changed), and the orgName, orgId and mail domain setup records. Only orgName changes after setup, from the owner's Settings page. Neither file holds the web address, which is `DOMAIN` alone (`getDomain()`). The storage type and S3 credentials are settings, under `defaults.mount`; the system sender is a setting, under `mail`.

## config.json vs settings.json

|              | `config.json`                     | `settings.json`                              |
|--------------|-----------------------------------|----------------------------------------------|
| **Path**     | `data/server/config.json`         | `data/server/settings.json`                  |
| **Written**  | Secret at first boot, the rest at setup completion | By the owner at runtime, and the wizard's storage and sender at setup |
| **Contains** | orgName, orgId, secret, setupCompleted, setupCompletedAt, mailDomain | quotas, mount defaults, onboarding, guests, landing, notifications, mail |
| **Editable** | orgName only (`PUT /settings/organization`) | Yes (the owner's admin settings pages)       |

`config.json` has **no** storage field (`apps/api/src/lib/config/server-config.ts`). Storage type and S3 credentials live in `settings.json` under `defaults.mount`. The settings store is a plain `JsonStore` with a hardcoded `'local-fullnames'` default; it does not read anything out of `config.json`.

`mailDomain` is the `MAIL_DOMAIN` setup ran on, recorded at setup, or at first boot for an install that predates the field. Every account's address was made on it, so it cannot change: once it is recorded, `./eigen setup` states it instead of asking and refuses a different `--mail-domain` (`apps/api/src/cli/configure.ts`). At boot the API compares `MAIL_DOMAIN` from `.env.production` with the recorded one (`apps/api/src/server.ts`); on a mismatch it exits in production, naming the value to put back, and warns in development. An owner address on another domain only logs a warning.

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

**`mail`** — the system sender and how the relay treats users. `senderName` and `senderAddress` name the From of the mail the server sends itself (codes, notifications, invitations); empty means derived, the org name and `noreply@` the mail domain, so a later rename carries through. The setup wizard stores a sender only when it differs from those defaults. `relaySendsAsUsers` matters only without hosted mail: on, the relay accepts every address on the mail domain as a sender, so a user's mail goes out from their own address. See [Sending as a user](#mail-environment).

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

Defined in `apps/api/src/routes/settings.ts`. Changing the server's settings is the org owner's (`requireOwner`); admins keep what the Users, Guests and team pages read.

| Method | Path                      | Who   | Description                                                    |
|--------|---------------------------|-------|----------------------------------------------------------------|
| GET    | `/settings/server`        | admin | Read current server settings (the team page reads the quota defaults) |
| PUT    | `/settings/server`        | owner | Partial update of any branch; a `mail.senderAddress` must be an email address, a `mail.senderName` is stored trimmed |
| GET    | `/settings/s3config`      | owner | Read the saved S3 configuration                                |
| PUT    | `/settings/s3config`      | owner | Validate a connection, then write `defaults.mount.s3Config`     |
| POST   | `/settings/s3check`       | admin | Test an S3 connection without saving                           |
| POST   | `/settings/s3harden`      | admin | Turn on the bucket's versioning and expire noncurrent versions                 |
| GET    | `/settings/status`        | owner | `getServerStatus()`: version, hosted mail, disk, certificate expiry (what `./eigen status` reports) |
| PUT    | `/settings/organization`  | owner | Rename the organization: `config.json`'s orgName and the better-auth organization. The web address and mail domain stay |
| POST   | `/settings/mail/test`     | owner | Send one mail from the owner to the owner through `buildMailOptions`, so it tests the sender rule; a failure returns 502 with the transport's error |
| GET    | `/settings/users`         | admin | `AdminUserRow[]` — every org member **and** orphan for the Users page (auth-DB join incl. `lastLoginAt` + session-derived `lastActiveAt`, teams) |
| GET    | `/settings/users/usage`   | admin | `Record<userId, HomeSizeResponse>` — per-user disk usage via the `pullHomeSize` home-relay read, which sizes a home from its own databases (the mount `metadata.db`, `mail.db`, `contacts.db` and `calendar.db` totals, plus the avatars walk) rather than booting it (concurrency 4, 5-min in-memory cache) |
| GET    | `/settings/users/guests`  | admin | Guest accounts only, for the admin Guests page                 |
| DELETE | `/settings/user/:userId`  | admin | Delete a user account; refuses your own account and the owner's |
| PUT    | `/settings/user/:userId/password` | admin | Set a user's password via `resetUserPassword()`, the CLI's `./eigen reset-password` path: signs them out everywhere and revokes their app passwords. Refuses guests, and the owner unless the owner resets their own. better-auth's own `/auth/admin/set-user-password`, which revokes nothing, is in `disabledPaths` |

The waitlist routes (`/waitlist/entries`, `apps/api/src/routes/waitlist.ts`) are the owner's too, like the Waitlist page.

Both S3 paths refuse a configuration that does not connect: `PUT /settings/s3config` runs `checkS3Connection`
before saving, and `PUT /settings/server` refuses `storageType: 's3'` unless a saved S3 config exists **and** still
connects. So the server never ends up defaulting new drives to a bucket it cannot reach.

## Frontend

Hooks in `packages/lib/src/core/settings/hooks/`: `useServerSettings()` / `useUpdateServerSettings()` / `invalidateServerSettings()` over query key `['settings', 'server']`, `useServerS3Config()` / `useUpdateServerS3Config()` / `invalidateServerS3Config()` over `['settings', 's3config']`, `useCheckS3Connection()` for the test button, `useServerStatus()` (fetched only for the owner), `useUpdateOrgName()` (invalidates the public config, which carries the name) and `useSendTestMail()`.

The Admin app's `/settings` route sits behind the `_owner` guard, with Onboarding, Guest settings and Waitlist; an admin who opens one by URL sees "Only the server owner can open this page." It renders `ServerSettingsPage` (`apps/admin/src/components/admin/server-settings.tsx`) with these sections, each a shared `SettingsSection` over one `SettingsFooter`:

- **General** — the organization name, editable, beside the web address and mail domain, read-only
- **Server** — what `./eigen status` reports: version, hosted mail, disk, certificate (`server-status-section.tsx`)
- **Mail** — the sender name and address, **Relay sends as users** (only without hosted mail), and **Send test mail**
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

`MAIL_ENABLED` rides out to the frontend as `mailEnabled` on `GET /p/config`, where `useMailEnabled()` (`packages/lib/src/core/public/hooks/use-public.ts`) is the one read of it: it reports on until the config lands, so the common deployment never flashes a missing Mail app. Built on it: `useEnabledApps()` (the app switcher, the Space home and the cycling logo), the `mailOnly` flag on a `FILE_ACTIONS` row (**Import to Mail** on an `.eml`), `useHomeDataLabel()`, and `MailOffState` (`packages/ui`), the one screen for a typed `/mail` URL and the Space mail page. `useMailboxes` is the exception — it gates its fetch on `mailEnabled === true` from the config itself, so a mail-off server is never asked for a mailbox list. Outbound mail goes on with mailboxes off, as long as a relay is set: share notifications, invites and "Email collaborators" go out through it. Without a relay every email fails, two-factor codes by email and guest sign-in codes included; `./eigen setup` says so when it writes that shape.

**Sending as a user.** `buildMailOptions()` (`mailer.ts`) holds the one sender rule. A message's `from` is the person it is from; absent, it is the system's own mail and goes out from the system sender (`mail.senderName`, `mail.senderAddress`, empty meaning the org name and `noreply@` the mail domain). A person on the mail domain sends as themselves when Postfix hosts the domain, or when the relay takes any address on it (`mail.relaySendsAsUsers`). Everyone else goes out "via": the From is the system sender's address with `Ada via Acme` as its name, and Reply-To is the person, since a relay refuses an address it does not allow and receivers enforce DMARC. The envelope sender follows the resolved From.

**What mail off leaves out.** No Mail app, no IMAP, no inbound mail. Every home still builds its Maildir and watcher, an idle cost. The `/mail/:ownerId/*` routes stay live apart from the two imports and the send route, which refuse with 403 (`requireMailEnabled()`, `apps/api/src/lib/core/access.ts`); the UI hides them. Calendar invitations go out, but replies from outside attendees go to the organizer's own mailbox and Eigen never updates their status, since inbound iMIP needs hosted mail. The role addresses `postmaster@`, `abuse@` and `noreply@` stay unclaimable, and an address on the server's own mail domain is never a guest, even when its mailbox lives elsewhere.

Transport security follows `SMTP_RELAY_USER`: the hop to Postfix and an anonymous relay (self-signed, no cert) keep opportunistic TLS, while a relay that takes credentials must accept TLS, so credentials never travel in the clear; the API also checks the relay's certificate. `SMTP_RELAY_USER` without `SMTP_RELAY_PASSWORD` is a config error — `createTransport()` throws rather than authenticate with a blank password.
