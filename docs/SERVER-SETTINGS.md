# Server Settings

> **TLDR:** A server keeps two JSON files in `data/server/`. `settings.json` holds the runtime settings the owner edits in the Admin app (`apps/api/src/lib/config/server-settings.ts`). `config.json` is the identity file (`server-config.ts`): the auth secret and what setup recorded. Neither holds the web address or whether this server hosts mail: those are environment. Not obvious from the code: the mail domain is recorded once and a boot on another one exits, a settings file that does not parse stops the boot instead of being overwritten, S3 becomes the default only while a saved config connects, and one sender rule in `buildMailOptions()` decides whether mail goes out as the person or "via" the organization.

## config.json is identity, settings.json is runtime

|  | `config.json` | `settings.json` |
|---|---|---|
| Holds | `secret`, `orgName`, `orgId`, `setupCompleted`, `setupCompletedAt`, `mailDomain` | quotas, mount defaults, onboarding, guests, landing, notifications, mail |
| Written | The secret at first boot, the rest when setup completes | By the owner at runtime; setup writes the storage type and the sender |
| Changes after setup | `orgName` only | Everything |

The secret is made at first boot and never changes, so a session signed in right after setup outlives the next restart. Setup writes `setupCompleted` last, so a failure in any earlier step leaves setup re-runnable (`completeSetup` in `apps/api/src/lib/setup/setup.ts`). The two stores are independent: the storage type and the S3 credentials are settings, under `defaults.mount`, and `config.json` has no storage field.

## The web address and the mail domain come from the environment

`getDomain()` reads `DOMAIN` and `getMailDomain()` reads `MAIL_DOMAIN`, falling back to `DOMAIN`. Both are what `./eigen setup` wrote to `.env.production`, because they are deployment identity: DNS, certificates and every account's address depend on them. The Admin app shows both read-only. [Hosted mail and the relay are environment too](#hosted-mail-and-the-relay-are-environment-not-settings).

## The mail domain is recorded once and never changes

Every account's address was made on the mail domain, so on another one nobody can sign in. Setup records `MAIL_DOMAIN` as `mailDomain` in `config.json`. Once it is recorded, `./eigen setup` states it instead of asking and refuses a different `--mail-domain` (`apps/api/src/cli/configure.ts`).

At boot `assertMailDomainUnchanged()` compares `MAIL_DOMAIN` with the recorded value. On a mismatch it exits in production, naming the value to put back, and warns in development. An install from before the field records the domain at the first boot whose `MAIL_DOMAIN` the owner's address is on. A boot it is not on records nothing, so a wrong value at that boot is never taken as the truth. An owner address on another domain only logs a warning.

## Renaming the organization renames its default team

`orgName` is the one identity field that changes after setup (`PUT /settings/organization`, `renameOrganization` in `apps/api/src/lib/org/org.ts`). The rename writes `config.json` and the better-auth organization. It also renames the team that still carries the old name, which is the default team setup made. A team renamed by hand keeps its name. The web address and the mail domain stay. `useUpdateOrgName` invalidates the public config, which carries the name to every app, and the team lists and the admin users list, which carry the default team's.

## JsonStore merges onto defaults and fails closed

`JsonStore` (`apps/api/src/lib/core/json-store.ts`) is the persistence behind `settings.json`, `config.json` and every Home's `UserSettings` and `TeamSettings`.

- `load()` deep-merges the file onto the typed defaults, so a key added to the defaults gets its value without a migration.
- A file that does not parse rejects the load, so the Home or the server fails to boot. Loading defaults instead would let the next `set()` write them over the real bytes.
- The merge recurses into plain objects only. An array or `null` in an update replaces the stored value whole, and an explicit `undefined` clears the key. That is how `routes/team.ts` clears a member override.
- `set()` writes a temp file and renames it over the old one, and rolls the in-memory state back when the write fails.
- The file appears at the first `set()`, not at `load()`.

## What settings.json holds

The shape is `ServerSettings` in `packages/lib/src/types/settings.ts`, and the defaults are next to the store in `server-settings.ts`.

| Branch | What it decides | Where it is read |
|---|---|---|
| `quotas` | The per-user budgets, the per-file upload cap, trash retention | [QUOTA.md](QUOTA.md), [SOFT-DELETE.md](SOFT-DELETE.md) |
| `defaults.mount` | The storage backend of a new drive, and the S3 config it uses | [S3 becomes the default only while it connects](#s3-becomes-the-default-only-while-it-connects) |
| `onboarding` | The waitlist, seeding the owner as a contact, the welcome mail, the waitlist invite mail | `requireWaitlistEnabled` gates every waitlist route; `welcome.ts` skips the welcome mail without hosted mail |
| `guests` | Whether any address may ask for a sign-in code, and how long an idle guest lives | [GUEST-ACCESS.md](GUEST-ACCESS.md) |
| `landing.links` | Extra buttons on the public landing page | `GET /p/config`, which is unauthenticated |
| `notifications.email` | Which events also send an email | [The notification flags gate the email only](#the-notification-flags-gate-the-email-only) |
| `mail` | The system sender, and whether the relay may send as users | [One rule decides who a mail is from](#one-rule-decides-who-a-mail-is-from) |
| `backups` | The nightly schedule, and the bucket archives are uploaded to | [BACKUP.md](BACKUP.md) |

The storage type is `local-id`, `local-fullnames` or `s3`. `mapStorageType()` translates it to the mount's own vocabulary (`local-key`, `local`, `s3`). It reaches only a drive made after the change: `UserHome` and `TeamHome` stamp it into a new mount, and an existing mount keeps its backend ([QUOTA.md](QUOTA.md#a-mount-keeps-what-it-was-stamped-with)).

## The notification flags gate the email only

Each `notifications.email` flag turns one email on or off. The in-app notification fires either way for a recipient with an account.

| Flag | Default | The email goes out when | Why the default |
|---|---|---|---|
| `guestOnAclAdd` | on | An address without an account, or a guest, is added to an ACL | The email is the guest's only way in ([GUEST-ACCESS.md](GUEST-ACCESS.md)) |
| `userOnAclAdd` | off | A registered user is added to an ACL | The bell already tells them |
| `userOnCalendarInvite` | on | An Eigen user is invited to an event | An invitation is time-sensitive, and Google and Outlook mail it too |
| `ownerOnAccessRequest` | on | Someone asks for access to a user's path | A team-owned path sends no email |

The ACL flags are read inline in `propagateSharedPathChange` (`apps/api/src/lib/drive/acl-propagation.ts`), the access-request flag in `access-request-propagation.ts` and the invite flag in `invite-propagation.ts`. See [ACL.md](ACL.md).

## Settings are the owner's, the pages admins need are theirs too

`apps/api/src/routes/settings.ts` holds the routes. Changing the server's settings is the org owner's (`requireOwner`), and so is the waitlist (`apps/api/src/routes/waitlist.ts`). In the Admin app the `_owner` route guard puts Settings, Onboarding, Guest settings and Waitlist behind the same rule, and an admin who types one of those URLs sees "Only the server owner can open this page."

Admins keep what the Users, Guests and team pages need. They read `GET /settings/server`, because the team page shows the quota defaults and the team mount form starts from the S3 defaults. A non-owner gets the S3 config and the backup bucket with an empty `secretAccessKey`: the secrets are the owner's. A save of the backup bucket with a blank secret keeps the stored one, unless the access key changed with it. They can also test an S3 connection and harden a bucket (`/settings/s3check`, `/settings/s3harden`) for a team mount, and manage user accounts. Deleting refuses your own account and the owner's.

## An admin password reset revokes every way in

`PUT /settings/user/:userId/password` calls `resetUserPassword()` (`apps/api/src/lib/user/reset-password.ts`), the same path as `./eigen reset-password`. It signs the user out everywhere and revokes their app passwords, since those open IMAP, CalDAV and WebDAV without the password. It refuses a guest, who signs in with a code, and it refuses the owner unless the owner resets their own. better-auth's own `/admin/set-user-password` revokes nothing, so it is in `disabledPaths` (`apps/api/src/lib/auth/auth.ts`).

## The Users page sizes homes without booting them

`GET /settings/users/usage` sizes every user through `pullHomeSize` (`apps/api/src/lib/home/home-relay.ts`), which reads the home's own databases and folders instead of booting the Home. A boot apiece costs seconds. `getAllUsersUsage` (`apps/api/src/lib/user/admin-usage.ts`) still caps the disk work at four homes at once, caches the result for five minutes per exact set of users, and skips a home that fails rather than failing the page. What each number counts is in [QUOTA.md](QUOTA.md#a-cold-read-reports-what-a-live-home-reports).

## The status section is what ./eigen status reports

`getServerStatus()` (`apps/api/src/lib/config/server-status.ts`) answers both `GET /settings/status` and `/status` on the CLI's control socket (`apps/api/src/routes/control.ts`), so the page and the command never disagree. The certificate is read from `data/certs/cert.pem`, where Caddy's export script copies its Let's Encrypt certificate. Without one, Postfix writes a self-signed stand-in, which the report flags. Whether the bundled Caddy runs is the `edge` profile in `COMPOSE_PROFILES`, which the API reads from `.env.production` through Compose's `env_file`.

## S3 becomes the default only while it connects

`PUT /settings/s3config` runs `checkS3Connection` before it saves. `PUT /settings/server` refuses `storageType: 's3'` unless a saved S3 config exists and still connects. So new drives never default to a bucket the server cannot reach. The Admin settings page saves the S3 config before the other settings, so switching to S3 and entering its config in one Save passes that check. A team mount's own S3 config gets the same check when it is added or changed (`TeamHome.addMount`, `updateMount`).

## The settings page asks before it drops changes

The Admin settings page (`apps/admin/src/components/admin/server-settings.tsx`) edits a draft and saves every section with one `SettingsFooter`, whose `LeaveGuard` asks before the page is left with unsaved changes. What each section does for the owner is in the help center: [Server settings](../apps/index/src/data/support/admin/server-settings.md) and [Storage quotas](../apps/index/src/data/support/admin/storage-quotas.md). The hooks are in `packages/lib/src/core/settings/hooks/`.

## Hosted mail and the relay are environment, not settings

Whether this server hosts mailboxes, and which server the API hands mail to, are deployment shape rather than runtime settings. They live in `.env.production`, which `./eigen setup` writes: `isMailEnabled()` (`apps/api/src/lib/config/env.ts`) and `createTransport()` (`apps/api/src/lib/core/mailer.ts`). With hosted mail the API hands everything to the bundled Postfix at `SMTP_HOST`, and Postfix relays through `SMTP_RELAY_*` when it is set. Without hosted mail the API sends through `SMTP_RELAY_*` itself. How an operator picks a relay is in the help center ([Choose a mail relay](../apps/index/src/data/support/self-hosting/mail-relay.md)), and the keys are listed in [SELF-HOSTING.md](SELF-HOSTING.md).

| Variable | Default | Effect |
|---|---|---|
| `MAIL_ENABLED` | on | `0` on a server run without the `mail` Compose profile: no hosted mailboxes |
| `SMTP_HOST`, `SMTP_PORT` | `postfix`, `25` in Compose | Where the API hands mail with hosted mail (Mailpit in dev) |
| `SMTP_RELAY_HOST` | unset | The outgoing relay. Unset, Postfix delivers directly, and without hosted mail every email fails |
| `SMTP_RELAY_PORT` | `587` | `465` is implicit TLS, any other port STARTTLS |
| `SMTP_RELAY_USER`, `SMTP_RELAY_PASSWORD` | unset | SASL credentials. A user without a password is a config error |

With no server to hand mail to, `createTransport()` throws. Outside production, `sendMail()` then logs the message instead of sending it, and a demo box always does.

## Credentials to a relay travel only over verified TLS

A relay that takes credentials must accept TLS and present a valid certificate (`requireTLS` and `rejectUnauthorized` follow `SMTP_RELAY_USER`). Without `requireTLS`, a relay that offers no STARTTLS would get the password in the clear. The hop to Postfix and an anonymous relay keep opportunistic TLS, because Postfix's own certificate is self-signed or missing. `SMTP_RELAY_USER` without `SMTP_RELAY_PASSWORD` makes `createTransport()` throw rather than sign in with a blank password.

## One rule decides who a mail is from

`buildMailOptions()` (`mailer.ts`) holds the sender rule for every outbound mail. A message's `from` is the person it is from. Without one, it is the system's own mail and goes out from the system sender: `mail.senderName` and `mail.senderAddress`, where empty means the org name and `noreply@` the mail domain.

A person on the mail domain sends as themselves when Postfix hosts the domain, or when the owner says the relay takes any address on it (`mail.relaySendsAsUsers`). Everyone else goes out "via": the From is the system sender's address with `Ada via Acme` as its name, and Reply-To is the person. A relay refuses an address it does not allow, and receivers enforce DMARC. The envelope sender follows the resolved From.

`storedSender()` stores a sender name or address only when it differs from the derived default, for both the setup wizard and `PUT /settings/server`. So renaming the organization renames a default sender too. `POST /settings/mail/test` sends one mail from the owner to the owner, so it exercises the same rule, and answers 502 with the transport's error when it fails.

## Mail off hides the Mail app and keeps outbound mail

`GET /p/config` carries `mailEnabled`, which is `isMailAppEnabled()`: hosted mail, or a demo box, which seeds mailboxes without an MTA. `useMailEnabled()` (`packages/lib/src/core/public/hooks/use-public.ts`) is the one read of it. It reports on until the config lands, so the common deployment never flashes a missing Mail app. Everything that hides Mail builds on it: `useEnabledApps()`, the `mailOnly` flag on a `FILE_ACTIONS` row, `useHomeDataLabel()`, and `MailOffState` (`packages/ui`), the one screen for a typed `/mail` URL and the Space mail page. `useMailboxes` is the exception. It waits for `mailEnabled === true` from the config itself, so a server without mail is never asked for a mailbox list.

Outbound mail goes on without mailboxes, as long as a relay is set. Share notifications, invites and "Email collaborators" go out through it. Without a relay every email fails, including two-factor and guest sign-in codes, and `./eigen setup` says so when it writes that shape.

## What a server without hosted mail leaves out

- No Mail app, no IMAP and no inbound mail. Every Home still builds its Maildir and watcher, an idle cost.
- The `/mail/:ownerId/*` routes stay live, apart from the send route and the two imports, which answer 403 (`requireMailEnabled()`, `apps/api/src/lib/core/access.ts`). The UI hides them.
- No welcome mail, since nobody would ever read it.
- Calendar invitations go out, but an outside attendee's reply goes to the organizer's own mailbox and Eigen never updates their status, because inbound iMIP needs hosted mail.
- The role addresses `postmaster@`, `abuse@` and `noreply@` stay unclaimable, and an address on the server's own mail domain is never a guest, even when its mailbox lives elsewhere.

## See also

- [QUOTA.md](QUOTA.md): how the quota settings resolve and where they are enforced
- [GUEST-ACCESS.md](GUEST-ACCESS.md), [ACL.md](ACL.md): the guest and notification settings in use
- [SELF-HOSTING.md](SELF-HOSTING.md) and the [self-hosting help center](../apps/index/src/data/support/self-hosting/): setting up the environment
- [MAIL.md](MAIL.md): the Mail app on top of hosted mail
