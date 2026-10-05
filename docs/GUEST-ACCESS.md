# Guest Access

> **TLDR:** A guest is an external person who signs in with an emailed code instead of a password and reaches only what was shared with them. Sign-in lives in `apps/api/src/lib/auth/guest-auth.ts`, the home in `apps/api/src/lib/home/guest-home.ts`. Access itself is the ordinary Drive ACL ([ACL.md](ACL.md)). Not obvious from the code: a guest gets a real disk-based `GuestHome` with no mail, contacts or calendar; the share registry outlives a deleted guest, so signing in again rebuilds the same shares; open signup is on by default, and closed signup admits only an address someone shared with; inactive guests are deleted once a day.

Guests are how a user shares with someone who has no account on the server. The user shares a document, a folder or a chat with an email address. Eigen mails that address a link, and the person signs in on the login page's Guest tab with a code sent to the same address. From then on the guest opens what was shared in the same Drive, editors and chat as everyone else.

Underneath, a guest is an ordinary account with `role: 'guest'`, so the rest of Eigen needs almost no guest case. What a guest may open is decided by the ACL, through the same `SharedDrive` check every user goes through. The guest's Home, the data folder every account has ([STORAGE.md § A Home is loaded on demand](STORAGE.md#a-home-is-loaded-on-demand-and-dropped-when-idle)), keeps `shared.db`, the list of paths others shared with the guest. A share made before the guest exists waits in the share registry, a server-wide list of "this owner shared something with this address", and each sign-in reads it into `shared.db` ([ACL.md § Reconciliation](ACL.md#reconciliation)).

The sections cover the guest's Home and limits, the sign-in and its rate limits, the registry, access requests, the narrower frontend and the daily cleanup.

## A guest has a disk-based home with only drive and notifications

`getHome()` builds a `GuestHome` for a user with `role: 'guest'`. It holds a Drive and a NotificationCenter under `data/guest/{guestId}/` ([STORAGE.md](STORAGE.md#a-home-is-loaded-on-demand-and-dropped-when-idle)), and leaves mail, contacts and calendar uninitialized. Its `settings.json` names no mounts, so the Drive only carries `shared.db`, the mirror of what others shared with the guest. `GuestHome.size()` reports zero everywhere.

The home is on disk rather than in memory so it reuses Drive and NotificationCenter unchanged. An in-memory stand-in would have to subclass `Drive`, whose `home` is private, and reimplement `receiveSharedPathChange`. On disk, `shared.db` and the notifications also survive idle eviction, restarts and the next session.

## A guest can do less than a user

| Restriction       | Mechanism                                                  |
|-------------------|------------------------------------------------------------|
| No personal drive | GuestHome's Drive has no mounts                            |
| No mail, contacts or calendar | The services are absent, and `requireNonGuest()` guards every mail, contacts and calendar route |
| No org or team membership | Guest creation skips the auth hooks, and `authEnsureDefaultOrgMembership` skips guests on sign-in |
| No admin          | Admin checks read the org role, and a guest has none       |
| No sharing or access requests | `requireNonGuest()` on the ACL route, the chat `/invite` route, the drive `access-check` and `request-access` |
| Read/write per ACL| SharedDrive enforces the entries the owner set             |

A calendar invitation treats a guest like an external address: an iMIP mail and a registry entry, no in-app copy (`invite-propagation.ts`, [CALENDAR.md § The organizer's writes fan out](CALENDAR.md#the-organizers-writes-fan-out-and-only-the-organizers)). A guest answers from their own mail, which reaches the organizer through [inbound iMIP](CALENDAR.md#inbound-imip-acts-only-on-a-sender-our-own-mta-verified). The home relay skips calendar messages for a home without a calendar (`hasCalendar`), and reconciliation skips the calendar steps, so no calendar push crashes on a `GuestHome`.

## Sign-in is a two-step code flow on custom endpoints

Guests do not use better-auth's emailOTP plugin. `POST /guest-auth/request-otp` mails a 6-digit code, and `POST /guest-auth/verify-otp` checks it and signs the guest in (`apps/api/src/routes/guest-auth.ts`). The code expires after 5 minutes. A new request replaces the email's previous code, so only the newest one works.

`request-otp` refuses an address that belongs to a non-guest user ("use password login") and an address on the server's own mail domain. The second check is needed because a guest is created by a direct insert that skips the auth hook guarding that domain.

## Open signup decides who may ask for a code

`guests.openSignup` is on by default: any address may ask. Off, an address without an account needs a share-registry entry, so only someone a user shared with can become a guest. Both settings are in [SERVER-SETTINGS.md](SERVER-SETTINGS.md).

With open signup on, anyone can make the server mail a code to any address, up to the per-email cap. Turning it off closes that, and a closed server still tells a caller whether an address was ever shared with ([The access check tells a sharer whether an address was ever shared with](#the-access-check-tells-a-sharer-whether-an-address-was-ever-shared-with)).

## Code requests are rate-limited per email and per IP

`otp-rate-limit.ts` keeps an in-memory sliding window of an hour: 10 requests per email, 100 per IP. The per-IP cap leaves room for an office of guests behind one address. A successful sign-in hands its slots back (the email's bucket, and that email's entries in the IP bucket), so only requests that never prove the mailbox count. Over the cap the route answers 429.

The state is per process: a restart clears it, and a second API process would not share it. Eigen runs one API process.

## A code gets ten guesses and mints one session

A wrong guess leaves the code usable. A code gets 10 guesses (`MAX_OTP_GUESSES`), counted in memory before the async hash check so parallel guesses can't outrun the cap, and the next one burns the code with a 429. The code is consumed only on success, by a delete that reports whether it removed the row, so two concurrent requests with the right code mint one session. The worst case per email is 10 codes × 10 guesses an hour against a million codes.

## Verification creates the guest and reconciles on every sign-in

A successful verify finds or creates the user with `role: 'guest'`. The insert is direct, so it bypasses `databaseHooks`: no org join and no default reconciliation. The guest signs in through `auth.api.signInEmail()` with a password nobody sees, `HMAC-SHA256('guest:{email}', auth secret)`, re-derived and written on every sign-in so a tampered credential heals.

Every successful sign-in, not only the first, calls `reconcileSharesForNewUser()` to seed `shared.db` from the share registry ([ACL.md § Reconciliation](ACL.md#reconciliation)). A failed first reconcile then heals at the next sign-in.

## The share registry is a durable record, not a queue

For a guest the registry records "owner X shared something with address Z" and is never consumed. It survives the guest's creation and deletion, so signing in again after a deletion rebuilds the same `shared.db`.

1. **Before the guest exists**: a share finds no user, so the address gets a registry entry and a share mail. That mail is how the guest learns to come and sign in, gated by `notifications.email.guestOnAclAdd` (default on). Send-time mail grants ([MAIL.md § A send grants access only when the sender says so](MAIL.md#a-send-grants-access-only-when-the-sender-says-so)) mint the same entries but suppress this mail (`suppressShareEmail: 'all'`): the user's own message carries the `?email=` link.
2. **The guest verifies**: reconciliation reads (does not delete) the registry and writes `shared.db` idempotently through `receiveSharedPathChange`.
3. **After the guest exists**: a share resolves the user and pushes into `shared.db` directly.
4. **The guest is deleted**: the teardown removes the home and the registry entries the guest created, and keeps the entries addressed to the guest ([ORGANISATIONS-AND-TEAMS.md](ORGANISATIONS-AND-TEAMS.md#deleting-a-user-runs-one-teardown-from-every-entry-point)).

A deleted non-guest user loses the entries addressed to them too. A user cannot come back as the same identity with the same address, so for them the entries only ever mattered until the account existed.

A share on a team drive path records the team as the source, and reconciliation handles that case ([ACL.md § Reconciliation](ACL.md#reconciliation)).

## A revoked share leaves its registry entry

Removing an address from an ACL does not remove its registry entry, since the owner may still share something else with it. Reconciliation re-reads the owner's current shares, so a stale entry delivers nothing. On a closed-signup server it still lets that address ask for a code and become a guest with nothing shared. The leak is bounded and only matters at very long lifetimes or very high revoke rates.

## The access check tells a sharer whether an address was ever shared with

On a closed-signup server, the drive `access-check` (`checkAccessForEmails`, used by the mail Share & send dialog) returns `needsGuestAdmission` per address. Any non-guest user who can read a path can therefore probe an arbitrary address for "has an account, or was shared with before". `request-otp` already exposes the same information and rate-limits it, so this is accepted.

## A signed-in user without access sees a request screen

| State                      | What the user sees                       |
|----------------------------|------------------------------------------|
| Authenticated + has access | The resource                             |
| Authenticated + no access  | "Request access" screen with owner info  |
| Not authenticated          | Login page with guest OTP option         |

Every document app (docs, stickies, slides, sheets, vector) renders `<RequestAccessView>` from `EigenDocEditorRoute` when `useCollabDocumentInfo()` says `!canRead`. Drive shows it when the folder listing fails with a 403 `AppError`, chat when `useCheckPermissions()` says `!canRead`.

A guest sees the same screen without the request form, told to ask the owner to share: `POST .../request-access` rejects guests with 403 (`requireNonGuest`).

## An access request notifies the owner and never reveals the path

`POST /drive/:ownerId/:mountId/path/:pathId/request-access` calls `propagateAccessRequest` (`apps/api/src/lib/drive/access-request-propagation.ts`), which reads the path through the home relay and pushes an `access-request` notification into the owner's home. The route skips the SharedDrive facade by design: the caller has no permission yet, which is the point. It returns 200 whether or not the path exists or is trashed, so it never reveals a path. An unknown owner or mount still answers 404.

The notification tag is `access-request:{ownerId}:{mountId}:{pathId}:{email}`, so a repeat request updates the same notification. For a user-owned path the owner also gets an email when `notifications.email.ownerOnAccessRequest` is on (default). A team-owned path reaches no one: a `TeamHome` has no NotificationCenter, and the email goes to user owners only ([ROADMAP.md](ROADMAP.md) § Cheap wins).

The "Access requested" state on the button is client-side only and resets on a refresh.

## A granted request refreshes the requester's view

Clicking the notification opens Drive with the share dialog pre-filled: `resolveAccessRequestLink()` (`packages/lib/src/core/notification/resolve-link.ts`) turns the tag into a Drive URL with `sharePathId` and `shareEmail`. When the owner grants access, propagation sends `DRIVE_ACL_SHARED` to the requester. The SSE handler invalidates the drive permission keys and the `['collab', 'info', ...]` keys on `DRIVE_ACL_SHARED` and `DRIVE_ACL_UNSHARED`, so the waiting app shows the resource without a reload.

## The guest frontend is a narrower shell

The login page (`packages/ui/src/components/layout/pages/login-page.tsx`) has a "Guest" tab next to "Sign in": email, send code, 6-digit code, verify, reload. A login URL with `?email=` opens on the Guest tab with the address filled in, which is where a share mail's link lands.

The topbar limits a guest's app switcher to Drive, Docs, Stickies, Slides, Vector, Sheets and Chat (`GUEST_APPS` in `topbar.tsx`), and gives them a reduced user menu with no settings, profile or theme.

## Inactive guests are deleted once a day

`cleanupInactiveGuests` (`apps/api/src/lib/auth/guest-cleanup.ts`) runs at startup and every 24 hours (`apps/api/src/lib/scheduler/jobs.ts`). It deletes a guest whose last activity is older than `guests.inactivityDays`.

Activity is `MAX(session.updatedAt)` for the guest, falling back to `user.updatedAt` when the guest has no session yet. better-auth refreshes a session row when it validates it, so any authenticated request keeps the guest alive.

A guest whose home is loaded (`atHome(userId)`) is skipped, to protect an in-flight collaboration session. The next sweep after the home idles out catches it.

The sweep calls `deleteUserCompletely(userId, null)`, the system mode that goes through better-auth's internal adapter instead of its admin API. The teardown is the same as any deletion, and the registry entries addressed to the guest stay.

## Guests have two Admin pages, and one is the org owner's

The Admin app has two guest pages. **Guests** (`/guests`) is every admin's: every `role: 'guest'` account from `GET /settings/users/guests`, with a detail view and delete. **Guest access** (`/guest-settings`) holds the `guests.openSignup` toggle and the `guests.inactivityDays` threshold, and only the org owner sees it, because it is server settings ([ORGANISATIONS-AND-TEAMS.md](ORGANISATIONS-AND-TEAMS.md#the-owner-holds-server-settings-and-admins-manage-people)). No endpoint turns a guest into a regular user ([ROADMAP-POST-1.md](ROADMAP-POST-1.md)).

## See also

- [ACL.md](ACL.md): the sharing model, propagation and the share registry
- [SERVER-SETTINGS.md](SERVER-SETTINGS.md): the `guests` and `notifications.email` settings
- [ORGANISATIONS-AND-TEAMS.md](ORGANISATIONS-AND-TEAMS.md): user deletion
- [DEMO_MODE.md](DEMO_MODE.md): the demo sign-in that shares the scoped-password session mint
