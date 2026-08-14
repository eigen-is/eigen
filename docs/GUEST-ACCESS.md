# Guest Access

> **TLDR**: External guests authenticate via Email OTP and get a disk-based `GuestHome` with `shared.db` +
> `notifications.db` — no mail, contacts or calendar. Standard Drive ACL inheritance handles access, and the
> share registry survives guest deletion. Open signup is on by default; admins can require a pending share
> instead, list guests on the admin **Guests** page, and inactive guests are deleted once a day.

## Three Access States

| State                      | What the user sees                       |
|----------------------------|------------------------------------------|
| Authenticated + has access | The resource                             |
| Authenticated + no access  | "Request access" screen with owner info  |
| Not authenticated          | Login page with guest OTP option         |

## GuestHome

`GuestHome` (`apps/api/src/lib/home/guest-home.ts`) extends `Home` with minimal services — only Drive (for
`shared.db`) and NotificationCenter. Mail, contacts, and calendar are left uninitialized.

### Disk Layout

```
data/guest/{guestId}/
├── mounts/
│   └── shared.db              # shared-with-me paths
├── settings.json              # minimal
└── eigen.notifications/
    └── notifications.db
```

No default mount — guests have no personal drive. The Drive instance is only used for
`getSharedPathsWithMe()` and receiving ACL propagation via `receiveSharedPathChange()`.

### Why Disk-Based

Disk-based over in-memory because: (1) `Drive.home` and `Drive.emit()` are `private` — a subclass can't
override without changing access modifiers, (2) `receiveSharedPathChange()` is ~50 lines that would need parallel
reimplementation, (3) `shared.db` persists across idle timeouts and server restarts, (4) notifications
persist across sessions.

### Home Factory

`getHome()` checks `user.role` — guests get `GuestHome`, regular users get `UserHome`:

```typescript
if (user.role === 'guest') {
    home = new GuestHome(user, () => cleanupHomeFactory(ownerId));
}
```

`GuestHome.size()` returns zero for all quotas (no mounts to measure).

## Guest Authentication

Two-step OTP flow via custom endpoints (not better-auth's emailOTP plugin). Logic in
`apps/api/src/lib/auth/guest-auth.ts` + `otp-rate-limit.ts`, routes in `apps/api/src/routes/guest-auth.ts`.

### Request OTP

`POST /guest-auth/request-otp { email }` — rate-limited per-email (3/hour) and per-IP (10/hour) by an
in-memory sliding window. Behavior depends on the `guests.openSignup` setting:

- `openSignup = true` (default): accept any email that isn't already a non-guest user.
- `openSignup = false`: require a pending share registry entry for the email.

Sends a 6-digit OTP via email (5-minute expiry). Returns 429 when the rate limit is hit.

### Verify OTP

`POST /guest-auth/verify-otp { email, otp }` — verifies the OTP, finds or creates a guest user with
`role: 'guest'`, creates a deterministic password via `HMAC-SHA256('guest:{email}', auth.secret)`, signs
in via `auth.api.signInEmail()`, and calls `reconcileSharesForNewUser()` to seed `shared.db` from the
registry. Registry entries are NOT consumed — they persist across guest deletion so re-OTP after deletion
rehydrates the same shared resources.

Guest user creation bypasses `databaseHooks` — no org join, no default reconciliation. The reconciliation
runs explicitly after OTP verification instead.

## Access Request Flow

When an authenticated user visits a shared resource they don't have access to:

1. App renders `<RequestAccessView>` instead of a generic access-denied page
2. User clicks "Request access" → `POST /drive/:ownerId/:mountId/path/:pathId/request-access`
3. The route calls `propagateAccessRequest` (`apps/api/src/lib/drive/access-request-propagation.ts`), which reads
   the path through the home relay and pushes a notification into the owner's notification center
4. Notification tag: `access-request:{ownerId}:{mountId}:{pathId}:{email}` (idempotent via tag dedup)
5. For a user-owned path it also mails the owner when `notifications.email.ownerOnAccessRequest` is set (default
   on) — see [SERVER-SETTINGS.md](SERVER-SETTINGS.md)
6. Owner clicks notification → navigates to Drive with share dialog pre-filled with requester's email
7. Owner grants access → ACL propagation fires → `DRIVE_ACL_SHARED` SSE event → requester's
   permission query auto-refetches → resource appears

The route skips the SharedDrive facade by design — the caller has no permission yet, which is the point — and
always returns 200 regardless of whether the path exists (no existence leak).

### Per-App Integration

| App      | Permission check pattern                  | Integration                               |
|----------|-------------------------------------------|-------------------------------------------|
| Docs     | `useCollabDocumentInfo()` → `canRead`     | `<RequestAccessView>` when `!canRead`     |
| Stickies | Same                                      | Same                                      |
| Slides   | Same                                      | Same                                      |
| Sheets   | Same                                      | Same                                      |
| Drive    | `useFolderContent` throws `AppError(403)` | Check `AppError.status === 403`           |
| Chat     | `useCheckPermissions()` → `canRead`       | `<RequestAccessView>` when `!canRead`     |

SSE handlers invalidate both drive permission keys and `['collab', 'info', ...]` keys on
`DRIVE_ACL_SHARED` / `DRIVE_ACL_UNSHARED`, so collab apps auto-refresh when access is granted.

## Guest Restrictions

| Restriction       | Mechanism                                                  |
|-------------------|------------------------------------------------------------|
| No personal drive | GuestHome's Drive has no mounts (empty `settings.json`)    |
| No mail           | `_mail` undefined, `requireSelf()` on mail routes          |
| No contacts       | `_contacts` undefined, `requireSelf()` on contacts routes  |
| No calendar       | `_calendar` undefined, null guards in propagation          |
| No teams          | `authAddUserToDefaultOrg()` skipped for guests             |
| No admin          | `role: 'guest'` is not admin/owner                         |
| No sharing        | `requireNonGuest()` on `PUT /drive/.../acl`                |
| Read/write per ACL| SharedDrive enforces via ACL entries set by owner           |

Calendar null guards in `reconciliation.ts` (`if (targetHome.hasCalendar)`) and
`share-propagation.ts` prevent crashes when ACL propagation targets a GuestHome.

## Frontend

**Login page** (`packages/ui/src/components/layout/pages/login-page.tsx`) — two tabs: "Sign in" (password) and
"Guest" (OTP). Guest tab: email input → send code → 6-digit input → verify → reload.

**Topbar** — guest app switcher limited to Drive, Docs, Stickies, Slides, Sheets, Chat. Simplified user
dropdown (logout only, no settings/profile/theme).

**Notification link resolution** — `resolveAccessRequestLink()` parses the notification tag and returns a
Drive URL with `sharePathId` and `shareEmail` query params to pre-fill the share dialog.

## Share Registry + Reconciliation

The registry is a durable projection of "user X shared resource Y with email Z" rather than a queue of
pending shares. Entries persist across guest creation AND deletion so re-OTP rehydrates `shared.db`
identically.

1. **Before guest account exists**: share → `resolveACLUserIds` → user not found → registry entry created, and
   `emailNewlyAddedAclEntries` (`apps/api/src/lib/drive/acl-propagation.ts`) mails the address. That mail is the
   guest-onboarding trigger — without it nobody knows to come and OTP in. Gated by
   `notifications.email.guestOnAclAdd` (default true). Send-time mail grants ([MAIL.md § Send-time access grants](MAIL.md#send-time-access-grants)) mint the same registry entries but suppress this mail (`suppressShareEmail: 'all'`); the user's own message carries the `?email=` invite link
2. **Guest verifies OTP**: account created → `reconcileSharesForNewUser()` reads (does not delete) from
   registry → idempotently writes to `shared.db` via `Drive.receiveSharedPathChange`
3. **After guest account exists**: share → `resolveACLUserIds` → user found → `receiveSharedPathChange()` called
   directly → writes to `shared.db`
4. **Guest deleted**: `deleteUserCompletely` removes the home directory, sessions, and FROM-this-user
   registry entries. TO-this-email entries are preserved. Re-OTP later rebuilds the home and re-reads the
   same registry rows.

**Team-owned sources.** A mail-send grant on a team drive path stores `team_<id>` as the registry source. `reconcileSharesForNewUser` resolves it through the team home (`getTeam`) instead of treating it as a user id: it delivers the team's shared paths attributed to the team name, and drive paths only, since teams have no calendars or invitations to reconcile. Without this a guest granted a team-owned doc got OTP admission but never the shared-path mirror or notification.

For non-guest users, deletion still purges TO-this-email entries (the registry-as-pending-queue semantics
make sense for users who can't reappear with the same email + a new identity).

## Inactivity Cleanup

Guests with no recent session activity are deleted automatically once a day. The sweep is registered in
`apps/api/src/lib/scheduler/jobs.ts` and runs at server startup + every 24 hours.

**Activity signal**: `MAX(session.updatedAt)` for the guest, falling back to `user.updatedAt` when the
guest has no session rows yet. Better-auth refreshes session rows on validation, so any authenticated
request keeps the guest alive.

**Skipped**: guests whose home is currently loaded (`atHome(userId) === true`) — protects in-flight
collaboration sessions; they get cleaned up on the next sweep after the home idles out.

**Deletion path**: `cleanupInactiveGuests` (`apps/api/src/lib/auth/guest-cleanup.ts`) calls
`deleteUserCompletely(userId, null)` — system mode that bypasses better-auth's admin API and deletes auth rows
directly. Home directory removed; share registry entries preserved (see above).

## Admin

Two pages in `apps/admin/src/routes/`:

- **Guest access** (`/guest-settings`) — the `guests.openSignup` toggle and the `guests.inactivityDays` threshold
- **Guests** (`/guests`) — every `role: 'guest'` account, from `GET /settings/users/guest` via
  `useAdminUsers('guest')`, with a detail view and delete

## Known Limitations

- **Team notifications**: team-owned resources (`team_xyz` ownerId) — `TeamHome` has no NotificationCenter,
  so access request notifications are silently skipped
- **No guest upgrade**: no endpoint or UI to convert a guest to a regular user (set password, change role,
  move data directory). Planned but not yet implemented
- **Request state**: "Access requested" state is client-side only (lost on refresh). Idempotent via tag
  dedup — re-requesting just updates the notification timestamp
- **Open-signup OTP exposure**: with `openSignup=true` an attacker can trigger up to 3 OTP emails per
  hour to any address (rate-limited per-email and per-IP). Set `guests.openSignup=false` to require a
  pending share before issuing OTPs.
- **Rate-limit state is per-process**: lost on server restart and not shared across replicas. Fine while
  Eigen runs as a single API process; needs a DB-backed swap if we ever shard.
- **Registry GC for revoked shares**: when an owner removes an email from an ACL, the registry entry
  isn't proactively removed (the share might still be reachable via another path). Bounded leak — only
  matters at very long lifetimes / very high revoke rates.
- **Access-check email probing**: on `openSignup=false` servers the drive access-check (`checkAccessForEmails`, used by the mail Share & send dialog) returns `needsGuestAdmission` per email, so any non-guest user who can read a path can probe an arbitrary address for "has an account, or was ever shared with anything". Same information class `request-otp` already exposes (and rate-limits); accepted.

See: [ACL.md](ACL.md) for the sharing model, [SERVER-SETTINGS.md](SERVER-SETTINGS.md) for the `guests` and
`notifications.email` settings, [ORGANISATIONS-AND-TEAMS.md](ORGANISATIONS-AND-TEAMS.md) for user deletion
