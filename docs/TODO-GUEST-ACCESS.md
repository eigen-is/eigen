# Guest Access & Access Requests

> **TLDR**: External guests authenticate via Email OTP and get a lightweight in-memory `GuestHome` — no disk, but the
> same code paths as regular users. ACL email matching already handles permission checks. The share registry stays
> populated for guests and seeds their in-memory `shared.db` on each session. Logged-in users without access see a
> "Request access" screen. Three phases, each independently shippable.

## Three Access States

Every shared resource URL resolves to one of three states:

| State                      | What the user sees                            |
|----------------------------|-----------------------------------------------|
| Authenticated + has access | The resource (works today)                    |
| Authenticated + no access  | "Request access" screen with owner info (new) |
| Not authenticated          | Login page with guest OTP option (new)        |

## Design: GuestHome with In-Memory Databases

### Why not "no Home"?

Every cross-owner route already works for guests — `getSharedDrive(ownerId, user)` checks ACL by email, no
guest-specific code needed. The question is what happens with the guest's _own_ Home, used for:

- `shared.db` — tracking what's shared with this user (used by "shared with me" views)
- `notifications.db` — receiving notifications (share events, access requests)
- SSE — real-time cache invalidation (new chat messages, share changes)
- `receiveACLChange()` — called by ACL propagation to update `shared.db`

Without a Home, each of these needs a special code path. With an in-memory Home, they all work unchanged.

### GuestHome

`GuestHome` extends `Home` with in-memory SQLite databases instead of disk files. Zero disk footprint, same
interfaces, same code paths.

```
GuestHome extends Home
├── homeDir: (none)
├── _drive: GuestDrive
│   └── sharedDb: in-memory SQLite (shared_paths table)
│       ├── getSharedPathsWithMe() — reads from in-memory shared.db    ✓ same code
│       └── receiveACLChange()    — writes to in-memory shared.db      ✓ same code
├── _notifications: in-memory NotificationCenter (optional)
├── _mail: null (not initialized)
├── _contacts: null (not initialized)
├── _calendar: null (not initialized)
├── broadcast() — works (SSE listeners register on base Home)         ✓ same code
└── touch() / destruct() — standard idle timeout, in-memory DBs freed ✓ same code
```

### GuestDrive

Subclass of `Drive` that overrides `init()`:

1. Create in-memory SQLite database, run `SHARED_DB_CONFIG` migration on it
2. Query share registry for entries targeting the guest's email
3. For each `fromUserId`: call `ownerHome.drive.getSharedWith(guestUser)` to resolve shared paths
4. Insert results into the in-memory `shared_paths` table
5. Skip mount creation entirely (guest has no personal storage)

After init, `getSharedPathsWithMe()` and `receiveACLChange()` work exactly like the regular `Drive` — they read/write
`this.sharedDb` which happens to be in-memory. No method overrides needed for these.

Methods that require mounts (`uploadFile`, `createFolder`, etc.) naturally fail if called because no mounts exist. But
they're never called — guests access shared resources via `getSharedDrive(ownerId, user)` which uses the _sharer's_
drive, not the guest's.

### Lifecycle

```
Guest logs in
  → getHome(guestId) → creates GuestHome
  → GuestHome.init() → in-memory shared.db populated from registry
  → Guest navigates, accesses shared resources via sharer's drive
  → receiveACLChange() keeps in-memory shared.db current while online
  → SSE works (broadcast/subscribe on base Home)
  → 5 min idle → Home destructed → in-memory DBs freed
  → Next request → GuestHome recreated → re-populated from registry
```

On server restart: same flow. The registry is the persistent source of truth; the in-memory DB is a session cache.

### Share Registry for Guests

Today's flow: share → registry entry → user created → reconcile pulls into disk `shared.db` → registry entry deleted.

Guest flow: share → registry entry → guest created → registry entry **stays** → in-memory `shared.db` populated from
registry on each GuestHome init.

The registry entries are the guest's permanent record of who shared with them. They're never deleted (until the guest
upgrades to a regular user). The in-memory `shared.db` is rebuilt from the registry each time the GuestHome
initializes — typically once per login session.

### Home Factory Change

In `get-home.ts`, the `case 'user'` branch checks `user.role`:

```
case 'user': {
    const user = await getUserById(parsed.id);
    if (user.role === 'guest') {
        home = new GuestHome(user, cleanUp);    // in-memory, no disk
    } else {
        home = new UserHome(user, cleanUp);     // standard disk-based
    }
}
```

No guard, no rejection — guests get a real Home object that participates in the system normally.

---

## Phase 1: Access Request Screen

Independently useful. Works for any logged-in user who visits a resource without access.

### `<AccessGate/>` Component

Replace `<AccessDenied/>` with a smart wrapper in all resource routes:

```
<AccessGate ownerId={ownerId} mountId={mountId} pathId={pathId}>
  ├── Loading         → spinner
  ├── canRead = true  → children (the resource)
  └── canRead = false → <RequestAccessView>
       ├── Owner avatar + name (via GET /p/user/:ownerId)
       ├── "Request access" button
       └── "You're signed in as bob@example.com"
```

Location: `packages/ui/src/components/layout/app/access-gate.tsx`

### Request Access Endpoint

```
POST /drive/:ownerId/:mountId/path/:pathId/request-access
Auth: required
Body: (none — requester identity from session)
```

1. Look up path name from owner's drive (for notification title)
2. Persist notification in **owner's** NotificationCenter:
    - type: `access-request`
    - title: `"bob@example.com requested access to 'Document'"`
    - tag: `access-request:{ownerId}:{mountId}:{pathId}:{email}` (dedup via upsert)
    - actorEmail: requester's email
3. Owner sees notification → clicks → share dialog opens → grants access

No new SSE events — the existing `notification:created` event handles the toast.

### Apps Updated

Replace `<AccessDenied/>` with `<AccessGate/>` in:

- `apps/docs/src/routes/_auth.doc.$ownerId.$mountId.$pathId.tsx`
- `apps/stickies/src/routes/_auth.board.$ownerId.$mountId.$pathId.tsx`
- `apps/slides/src/routes/_auth.slide.$ownerId.$mountId.$pathId.tsx`
- `apps/sheets/src/routes/_auth.sheet.$ownerId.$mountId.$pathId.tsx`
- `apps/drive/src/routes/_auth.fs.$ownerId.$mountId.$pathId.tsx`
- `apps/chat/src/routes/_auth.$ownerId.$mountId.$chatId.tsx`

---

## Phase 2: Guest Authentication + GuestHome + Frontend

These ship together — guest auth without the frontend changes and GuestHome is unusable.

### Email OTP Plugin

Register better-auth's `emailOTP` plugin in `apps/api/src/lib/auth/auth.ts` with `disableSignUp: true`.

### Guest Auth Router

New file: `apps/api/src/routes/guest-auth.ts`

```
POST /guest-auth/request-otp    { email }         → validate, create guest user, send OTP
POST /guest-auth/verify-otp     { email, otp }    → verify, create session, return cookie
```

`request-otp` flow:

1. Validate email
2. If user exists with `role !== 'guest'` → reject (regular users use password)
3. If no user → create with `role: 'guest'` via better-auth admin API
4. Send OTP

Why custom endpoints: enforce `role: 'guest'` on creation, prevent regular users from bypassing password via OTP.

### Auth Hook Changes

In `apps/api/src/lib/auth/auth.ts`, modify `user.create.after`:

- If `user.role === 'guest'`: skip `authAddUserToDefaultOrg()`, skip `reconcileSharesForNewUser()`
- Guests don't join the org and reconciliation is replaced by GuestHome's init-time registry pull

### Login Page

Modify `packages/ui/src/components/layout/pages/loginpage.tsx`:

- Two-tab layout: **"Sign in"** | **"Continue as guest"**
- Guest tab: email → "Send code" → OTP input → "Verify" → redirect to original URL
- Add optional `email` search param to `loginSearchSchema` for pre-filling

### Topbar & Sidebar

For `user.role === 'guest'`:

- Hide notification bell (or show it — in-memory notifications work, but lost on disconnect)
- Sidebar: show "Shared with me" only, hide Mail, Contacts, Calendar, etc.
- App roots (`__root.tsx`): redirect guests away from personal apps

### Guest Restrictions

All enforced by existing mechanisms — no new middleware:

| Restriction        | Mechanism                                           |
|--------------------|-----------------------------------------------------|
| No personal drive  | GuestDrive has no mounts                            |
| No mail            | `requireSelf()` + GuestHome._mail is null           |
| No contacts        | `requireSelf()` + GuestHome._contacts is null       |
| No calendar        | `requireSelf()` + GuestHome._calendar is null       |
| No teams           | `authAddUserToDefaultOrg()` skipped                 |
| No admin           | `role: 'guest'` is not admin/owner                  |
| Read/write per ACL | `SharedDrive` enforces via ACL entries set by owner |
| SSE                | Works — GuestHome has broadcast/subscribe           |

---

## Phase 3: Guest-to-User Upgrade

A guest upgrades to a regular user by setting a password:

1. Update `role` from `'guest'` to `null`
2. Evict GuestHome from factory (forces re-creation)
3. `getHome()` now creates a `UserHome` (disk-based)
4. Run `reconcileSharesForNewUser()` — pulls shares into disk `shared.db`
5. Delete consumed registry entries (standard cleanup)
6. Add to default org via `authAddUserToDefaultOrg()`

Triggered from a "Create full account" button in the guest's topbar.

```
POST /guest-auth/upgrade    { password }    → set password, change role, evict GuestHome
```

---

## Route Impact Matrix

### Routes That Work for Guests Without Changes

| Domain   | Routes                               | Why                               |
|----------|--------------------------------------|-----------------------------------|
| Drive    | All read/write routes                | `getSharedDrive()` → ACL by email |
| Collab   | Info, revisions, comments, WebSocket | Same                              |
| Chat     | Messages, invite, read status        | Same                              |
| Editor   | Content read/write                   | Same                              |
| Calendar | Shared calendar event ranges         | `resolveCalendar()` → permission  |
| Public   | Avatar, user info, config            | No auth required                  |
| SSE      | Event stream                         | GuestHome has broadcast()         |

### Routes Guests Cannot Access (No Changes Needed)

| Domain        | Enforcement                    |
|---------------|--------------------------------|
| Mail          | `requireSelf()` + null service |
| Contacts      | `requireSelf()` + null service |
| Space         | `requireSelf()`                |
| Home (export) | `requireSelf()`                |
| Team          | `requireTeamAccess()`          |
| Settings      | `requireAdmin()`               |

### New Routes

| Route                                                       | Auth | Purpose                        |
|-------------------------------------------------------------|------|--------------------------------|
| `POST /guest-auth/request-otp`                              | No   | Send OTP to guest email        |
| `POST /guest-auth/verify-otp`                               | No   | Verify OTP, create session     |
| `POST /guest-auth/upgrade`                                  | Yes  | Convert guest to regular user  |
| `POST /drive/:ownerId/:mountId/path/:pathId/request-access` | Yes  | Notify owner of access request |

---

## Why This Works

- **No new permission model** — ACL email matching handles guests identically to regular users
- **No new database** — share registry already exists; GuestHome uses in-memory SQLite
- **No disk per guest** — zero storage, in-memory DBs freed on idle
- **No special code paths** — `receiveACLChange()`, `getSharedPathsWithMe()`, SSE, notifications all use the same
  code as regular users because GuestHome provides the same interfaces
- **Registry as source of truth** — in-memory `shared.db` is a session cache rebuilt from the registry on each
  GuestHome init. Survives server restarts, no data loss
- **Upgrade path** — guest → regular user evicts GuestHome, creates UserHome, runs standard reconciliation

## Open Questions

- **Email delivery**: OTP requires sending emails. Self-hosted Eigen instances need a configured mail transport. This
  is the same requirement as password reset — not guest-specific, but a prerequisite
- **Guest session lifetime**: Should guest sessions expire faster than regular sessions? Better-auth supports
  per-session TTL configuration
- **Notifications for guests**: In-memory `NotificationCenter` means notifications are lost when the GuestHome is
  evicted. Acceptable for v1 — guests are transient. Could add disk-backed notifications later if needed

## Files

| File                                                      | Purpose                                     |
|-----------------------------------------------------------|---------------------------------------------|
| `apps/api/src/lib/home/guest-home.ts`                     | GuestHome class (in-memory databases)       |
| `apps/api/src/lib/drive/guest-drive.ts`                   | GuestDrive (in-memory shared.db, no mounts) |
| `apps/api/src/lib/home/get-home.ts`                       | Route to GuestHome for `role: 'guest'`      |
| `apps/api/src/routes/guest-auth.ts`                       | OTP auth + upgrade endpoints                |
| `apps/api/src/routes/drive.ts`                            | Request-access endpoint                     |
| `apps/api/src/lib/auth/auth.ts`                           | emailOTP plugin, guest-aware creation hooks |
| `apps/api/src/lib/share/reconciliation.ts`                | Skip reconciliation for guests              |
| `packages/ui/src/components/layout/app/access-gate.tsx`   | AccessGate component                        |
| `packages/ui/src/components/layout/pages/loginpage.tsx`   | Guest OTP login tab                         |
| `packages/ui/src/components/layout/pages/login-route.tsx` | Email search param                          |
| `packages/lib/src/core/drive/hooks/use-drive.ts`          | `useRequestAccess()` mutation hook          |
| `packages/ui/src/components/layout/app/topbar.tsx`        | Guest topbar adaptations                    |
| `apps/*/src/routes/_auth.*.tsx`                           | Replace AccessDenied with AccessGate        |
| `apps/*/src/routes/__root.tsx`                            | Guest sidebar restrictions                  |
| `docs/NOTIFICATION-CENTER.md`                             | Add access-request notification type        |
