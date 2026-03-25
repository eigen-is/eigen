# Guest Access & Access Requests

> **TLDR**: External guests authenticate via Email OTP and get a disk-based `GuestHome` with `shared.db` +
> `notifications.db` — no mail, contacts, or calendar. Standard Drive inheritance handles ACL propagation and
> shared-with-me without overrides. Logged-in users without access see a "Request access" screen. Three phases,
> each independently shippable.

## Three Access States

Every shared resource URL resolves to one of three states:

| State                      | What the user sees                            |
|----------------------------|-----------------------------------------------|
| Authenticated + has access | The resource (works today)                    |
| Authenticated + no access  | "Request access" screen with owner info (new) |
| Not authenticated          | Login page with guest OTP option (new)        |

## Design: Disk-Based GuestHome

### Why Disk-Based Over In-Memory

The original doc proposed an in-memory `GuestDrive` with zero disk footprint. After code review, disk-based is
strongly preferred because:

1. **Private member access** — `Drive.home` and `Drive.emit()` are both `private` (not `protected`). An in-memory
   GuestDrive subclass can't call `this.home.broadcast()` or `this.emit()` without changing Drive's access modifiers.
   Disk-based approach inherits everything unchanged.
2. **Registry gap** — `resolveACLUserIds()` in `acl-propagation.ts` only creates registry entries when the user
   doesn't exist yet. Once a guest account is created, new shares propagate via `receiveACLChange()` directly. On
   GuestHome recreation after idle timeout, the in-memory cache would be rebuilt from registry — but the registry
   only has pre-creation entries. Post-creation shares would be lost. Disk-based `shared.db` persists across restarts.
3. **Zero code divergence** — `receiveACLChange()` is ~50 lines of branching logic (remove/update/insert + SSE +
   notifications). An in-memory override must replicate all of it with array operations. As Drive evolves, this
   parallel implementation drifts.
4. **Notifications work** — Guests get persistent notifications ("X shared Y with you") across sessions.

See [Design Decision Rationale](#design-decision-rationale) at the bottom for the full comparison.

### GuestHome

```
GuestHome extends Home
├── homeDir: data/guest/{guestId}/
├── fs: LocalFilesystem
├── settings: JsonStore (minimal)
├── _drive: Drive (standard — inherits receiveACLChange, getSharedPathsWithMe)
│   └── shared.db (standard — populated by reconciliation + ACL propagation)
├── _notifications: NotificationCenter (standard — notifications.db)
├── _mail: null (not initialized)
├── _contacts: null (not initialized)
├── _calendar: null (not initialized)
├── broadcast() / subscribeSSE() / unsubscribeSSE() — inherited from Home
└── touch() / destruct() — inherited from Home (5-min idle timeout)
```

### Disk Layout

```
data/guest/{guestId}/
├── mounts/
│   └── shared.db              # ~10KB, shared-with-me paths
├── settings.json              # minimal
└── eigen.notifications/
    └── notifications.db       # ~10KB
```

No `mounts/default/` directory — GuestHome does not call `super.init(true)` so no default mount is auto-created.
The `Drive.init()` reads mount settings from `settings.json` (empty for guests), creating zero mounts.

### GuestHome Constructor

```typescript
export class GuestHome extends Home {
    constructor(user: User, cleanUp?: () => void) {
        super(user, cleanUp);
        this.homeDir = getGuestHomePath(user.id);    // data/guest/{userId}/
        this.fs = new LocalFilesystem(this.homeDir);
        this.settings = new JsonStore<HomeSettings>(this.fs, 'settings.json', {});
        this._drive = new Drive(this);               // standard Drive, no mounts
        this._notifications = new NotificationCenter(this);
        // _mail, _contacts, _calendar left uninitialized (undefined)
    }

    override async init() {
        await this.settings.load();
        return super.init(false);  // false = don't auto-create default mount
    }

    override async size() {
        return {
            mailAndContacts: { used: 0, max: 0 },
            drive: { default: { used: 0, max: 0 } },
            total: { used: 0, max: 0 },
        };
    }
}
```

`size()` override is needed because `Home.size()` calls `this._drive.size('default')` which calls `getMount('default')`
— that throws since there are no mounts. The home size route uses `requireSelf()`, so guests can hit it.

### How Shared Resources Work

Guests never use their own Drive for content — they access shared resources via the owner's drive:

1. Guest visits `/drive/alice-id/default/file-uuid`
2. Route calls `getSharedDrive('alice-id', guestUser)` → `new SharedDrive(aliceHome, guestUser)`
3. SharedDrive delegates to Alice's drive with ACL checks against guest's email
4. Guest's own Drive is only used for `getSharedPathsWithMe()` (listing the "Shared with me" view)

### Lifecycle

```
Guest logs in (OTP)
  → getHome(guestId) creates GuestHome
  → Drive.init() opens shared.db (empty on first login, populated by reconciliation)
  → Guest navigates, accesses shared resources via SharedDrive (standard ACL)
  → If someone shares/unshares while guest is online:
      ACL propagation calls home.drive.receiveACLChange() → writes shared.db + SSE event
  → 5 min idle → Home destructed → DBs closed
  → Next request → GuestHome recreated → shared.db reopened (persisted)
```

### Share Registry + Reconciliation

Standard flow, same as regular users:

1. **Before guest account exists**: share → `resolveACLUserIds` → user not found → registry entry created
2. **Guest account created (OTP)**: `reconcileSharesForNewUser()` runs → pulls from registry into `shared.db` →
   deletes registry entries
3. **After guest account exists**: share → `resolveACLUserIds` → user found → `receiveACLChange()` called directly →
   writes to `shared.db`. No registry entry needed.

### Calendar + Mail Null Guards

GuestHome leaves `_calendar`, `_mail`, `_contacts` uninitialized (`undefined`). Code that accesses these on arbitrary
Home instances needs guards:

**`reconciliation.ts`** — `pullCalendarShares` and `pullPendingInvitations` call `targetHome.calendar.receiveShare()`
and `targetHome.calendar.receiveInvitation()` directly (no optional chaining). Add guards:

```typescript
// reconcileSharesForNewUser — after pullDriveShares
if (targetHome.calendar) {
    pullCalendarShares(ownerHome, targetHome, user.email, []);
    pullPendingInvitations(ownerHome, targetHome, user.email);
}
```

**`share-propagation.ts`** — `propagateCalendarShare()` calls `targetHome.calendar.receiveShare()` and
`targetHome.calendar.removeShare()` directly. Add guard:

```typescript
// propagateCalendarShare — inside the userId loop
const targetHome = await getHome(userId);
if (!targetHome.calendar) continue;  // GuestHome has no calendar
```

**`Home.destruct()`** — already uses `?.` for contacts, mail, calendar, notifications. But `this._drive.destruct()`
is called without `?.`. For GuestHome, `_drive` is always initialized, so this is fine.

### Notification Routes

Notification routes use `requireSelf()` — guests _can_ hit them with their own ownerId. Since GuestHome has
`_notifications` initialized, notifications work normally. No changes needed.

All `home.notifications?.persist()` calls throughout the codebase (8 call sites) already use optional chaining. For
GuestHome, `_notifications` IS set, so these all work normally.

### Home Factory Change

In `get-home.ts`, the `case 'user'` branch checks `user.role`:

```typescript
case 'user': {
    const user = await getUserById(parsed.id);
    if (!user) throw new ApiError(404, 'User not found');
    if (user.role === 'guest') {
        home = new GuestHome(user, () => cleanupHomeFactory(ownerId));
    } else {
        home = new UserHome(user, () => cleanupHomeFactory(ownerId));
    }
    break;
}
```

The `role` column exists on the `user` table (`auth-schema.ts` line 12) — added by better-auth's `admin()` plugin.

### Path Helper

Add to `apps/api/src/lib/config/paths.ts`:

```typescript
export function getGuestHomePath(userId: string): string {
    return path.join(getServerDataPath(), 'guest', userId);
}
```

---

## Phase 1: Access Request Screen

Independently useful. Works for any logged-in user who visits a resource without access.

### `<AccessGate/>` Component

Wrap resource routes with a smart gate that checks read permission:

```
<AccessGate ownerId={ownerId} mountId={mountId} pathId={pathId}>
  ├── Loading         → spinner
  ├── canRead = true  → children (the resource)
  └── canRead = false → <RequestAccessView>
       ├── Owner avatar + name (via GET /p/user/:emailOrId)
       ├── "Request access" button
       └── "You're signed in as bob@example.com"
```

Uses `GET /drive/:ownerId/:mountId/path/:pathId/permissions/read` (existing route) to check access.

Location: `packages/ui/src/components/layout/app/access-gate.tsx`

### Request Access Endpoint

```
POST /drive/:ownerId/:mountId/path/:pathId/request-access
Auth: required
Body: (none — requester identity from session)
```

1. Look up path name from owner's drive via `getHome(ownerId).drive.getPath(mountId, pathId)`
2. Persist notification in **owner's** NotificationCenter:
    - type: `access-request`
    - title: `"bob@example.com requested access to 'Document'"`
    - tag: `access-request:{ownerId}:{mountId}:{pathId}:{email}` (dedup via `onConflictDoUpdate`)
    - actorEmail: requester's email
3. Owner sees notification → clicks → share dialog opens → grants access

No new SSE events — the existing `notification:created` event handles the toast.

### Apps Updated

Replace `<AccessDenied/>` usage with `<AccessGate/>` in these files:

| File | Current behavior |
|------|-----------------|
| `apps/docs/src/routes/_auth.doc.$ownerId.$mountId.$pathId.tsx` | Uses `<AccessDenied/>` when `!docInfo?.canRead` |
| `apps/stickies/src/routes/_auth.board.$ownerId.$mountId.$pathId.tsx` | Same pattern |
| `apps/slides/src/routes/_auth.slide.$ownerId.$mountId.$pathId.tsx` | Same pattern |
| `apps/sheets/src/routes/_auth.sheet.$ownerId.$mountId.$pathId.tsx` | Same pattern |

These files do NOT currently use `<AccessDenied/>` and need a different approach:

| File | Current behavior | Change needed |
|------|-----------------|---------------|
| `apps/drive/src/routes/_auth.fs.$ownerId.$mountId.$pathId.tsx` | Shows `<NotFound/>` on error | Distinguish 403 from 404, show `<AccessGate/>` for 403 |
| `apps/chat/src/routes/_auth.$ownerId.$mountId.$chatId.tsx` | No access check shown | Add `<AccessGate/>` wrapper around chat view |

---

## Phase 2: Guest Authentication + GuestHome + Frontend

These ship together — guest auth without the frontend changes and GuestHome is unusable.

### Email OTP Plugin

Register better-auth's `emailOTP` plugin in `apps/api/src/lib/auth/auth.ts`:

```typescript
import { emailOTP } from "better-auth/plugins";

// In plugins array:
emailOTP({
    disableSignUp: true,
    async sendVerificationOTP({ email, otp, type }) {
        // Use configured mail transport to send OTP
        console.log(`[OTP] ${email}: ${otp} (${type})`);
    },
}),
```

### Guest Auth Router

New file: `apps/api/src/routes/guest-auth.ts`

```
POST /guest-auth/request-otp    { email }         → validate, create guest user, send OTP
POST /guest-auth/verify-otp     { email, otp }    → verify, create session, return cookie
```

`request-otp` flow:

1. Validate email format
2. If user exists with `role !== 'guest'` and `role !== null` → reject ("Use password login")
3. If no user → create via better-auth admin API with `role: 'guest'`
4. Call `auth.api.signInEmailOTP({ body: { email } })` to send OTP

`verify-otp` flow:

1. Call `auth.api.signInEmailOTP({ body: { email, otp } })` to verify
2. Return session cookie

Why custom endpoints: enforce `role: 'guest'` on creation, prevent regular users from bypassing password via OTP.

### Auth Hook Changes

In `apps/api/src/lib/auth/auth.ts`, modify the `user.create.after` hook:

```typescript
create: {
    after: async (user) => {
        if (user.role === 'guest') return;  // guests: no org join, no reconciliation
        await authAddUserToDefaultOrg(user);
        await reconcileSharesForNewUser(user);
    },
},
```

Note: `reconcileSharesForNewUser` IS skipped for guests during account creation. The first time a guest logs in
and GuestHome.init() runs Drive.init(), `shared.db` starts empty. Registry entries targeting the guest's email
are consumed by the standard `reconcileSharesForNewUser()` call — BUT that call was skipped above.

**Fix**: call `reconcileSharesForNewUser()` for guests on **first login** instead of account creation. Add a check
in `guest-auth.ts` verify-otp handler or in the GuestHome constructor:

```typescript
// In guest-auth.ts verify-otp, after successful verification:
const user = await getUserByEmail(email);
if (user) await reconcileSharesForNewUser(user);
```

This is safe to call multiple times — it queries registry, pulls shares, then deletes consumed entries.

### Login Page

Modify `packages/ui/src/components/layout/pages/loginpage.tsx`:

- Two-tab layout: **"Sign in"** | **"Continue as guest"**
- Guest tab: email input → "Send code" button → OTP input → "Verify" → redirect to original URL

Modify `packages/ui/src/components/layout/pages/login-route.tsx`:

- Add optional `email` search param to `loginSearchSchema` for pre-filling from share links

### Topbar & Sidebar

For `user.role === 'guest'`:

**Topbar** (`packages/ui/src/components/layout/app/topbar.tsx`):
- Show a "Create full account" button/link
- Notification bell can stay (GuestHome has NotificationCenter)

**Sidebar** (each app's `__root.tsx`):
- Show "Shared with me" only
- Hide Mail, Contacts, Calendar, Space navigation items

**App roots** (`apps/*/src/routes/__root.tsx`):
- Redirect guests away from personal apps (mail, contacts, calendar, space, people)

### Guest Restrictions

| Restriction        | Mechanism                                                  |
|--------------------|------------------------------------------------------------|
| No personal drive  | GuestHome's Drive has no mounts (empty `settings.json`)    |
| No mail            | `_mail` undefined + `requireSelf()` on mail routes         |
| No contacts        | `_contacts` undefined + `requireSelf()` on contacts routes |
| No calendar        | `_calendar` undefined + null guards in propagation         |
| No teams           | `authAddUserToDefaultOrg()` skipped                        |
| No admin           | `role: 'guest'` is not admin/owner                         |
| Read/write per ACL | `SharedDrive` enforces via ACL entries set by owner        |
| SSE                | Works — Home base class has broadcast/subscribe            |
| Notifications      | Works — GuestHome has NotificationCenter                   |

---

## Phase 3: Guest-to-User Upgrade

A guest upgrades to a regular user by setting a password:

1. Set password via better-auth (creates `account` entry with `providerId: 'credential'`)
2. Update `role` from `'guest'` to `null` via admin API
3. Evict GuestHome from factory via `evictHome(userId)`
4. Move `data/guest/{userId}/` → `data/home/{userId}/`
5. `getHome()` now creates a `UserHome` (full disk layout)
6. UserHome.init() creates default mount, initializes mail, contacts, calendar
7. Add to default org via `authAddUserToDefaultOrg()`

Triggered from a "Create full account" button in the guest's topbar.

```
POST /guest-auth/upgrade    { password }    → set password, change role, move data, evict
```

The `shared.db` and `notifications.db` carry over unchanged — the guest's shared items and notification history
persist through the upgrade.

---

## Route Impact Matrix

### Routes That Work for Guests Without Changes

| Domain   | Routes                               | Why                               |
|----------|--------------------------------------|-----------------------------------|
| Drive    | All read/write via SharedDrive       | `getSharedDrive()` → ACL by email |
| Collab   | Info, revisions, comments, WebSocket | Same — all use `getSharedDrive()` |
| Chat     | Messages, invite, read status        | Same                              |
| Editor   | Content read/write                   | Same                              |
| Public   | Avatar, user info, config            | No auth required                  |
| SSE      | Event stream                         | `requireSelf()` + Home.broadcast  |
| Notif.   | List, mark read, dismiss             | `requireSelf()` + NotificationCenter |

### Routes Guests Cannot Access (No Changes Needed)

| Domain        | Enforcement                       |
|---------------|-----------------------------------|
| Mail          | `requireSelf()` + `_mail` is null |
| Contacts      | `requireSelf()` + `_contacts` null|
| Space         | `requireSelf()`                   |
| Home (export) | `requireSelf()` + `getZip()` throws |
| Team          | `requireTeamAccess()`             |
| Settings      | `requireAdmin()`                  |

### Routes That Need Null Guards

| Route/Function | Issue | Fix |
|---------------|-------|-----|
| `Home.size()` via `GET /home/:ownerId/size` | Calls `_drive.size('default')` → no mount | Override in GuestHome |
| `reconciliation.ts` pullCalendarShares | `targetHome.calendar.receiveShare()` on null | Add `if (targetHome.calendar)` guard |
| `reconciliation.ts` pullPendingInvitations | `targetHome.calendar.receiveInvitation()` on null | Add `if (targetHome.calendar)` guard |
| `share-propagation.ts` propagateCalendarShare | `targetHome.calendar.receiveShare()` on null | Add `if (!targetHome.calendar) continue` |

### New Routes

| Route                                                       | Auth | Purpose                        |
|-------------------------------------------------------------|------|--------------------------------|
| `POST /guest-auth/request-otp`                              | No   | Send OTP to guest email        |
| `POST /guest-auth/verify-otp`                               | No   | Verify OTP, create session     |
| `POST /guest-auth/upgrade`                                  | Yes  | Convert guest to regular user  |
| `POST /drive/:ownerId/:mountId/path/:pathId/request-access` | Yes  | Notify owner of access request |

---

## Open Questions

- **Email delivery**: OTP requires sending emails. Self-hosted instances need a configured mail transport. Same
  requirement as password reset — not guest-specific, but a prerequisite
- **Guest session lifetime**: Should guest sessions expire faster than regular sessions? Better-auth supports
  per-session TTL configuration
- **Guest data cleanup**: Inactive guest directories (`data/guest/`) should be cleaned periodically. Options:
  delete after N days of no session, or delete when the user record is removed
- **Calendar sharing with guests**: Currently calendar share propagation would silently skip guests (via null guard).
  Should we track that a calendar was shared with a guest, so it appears after upgrade?

## Design Decision Rationale

### In-Memory vs Disk-Based

|                          | In-memory                                                    | Disk-based (chosen)                                      |
|--------------------------|--------------------------------------------------------------|----------------------------------------------------------|
| **Drive overrides**      | 3 methods (~50+ lines realistic)                             | 0 — all inherited                                        |
| **Access modifier changes** | Must change `Drive.home` from `private` to `protected`    | None needed                                              |
| **Registry management**  | Must always create entries for guests (modify propagation)   | Standard reconciliation                                  |
| **Disk footprint**       | Zero                                                         | ~20KB per guest                                          |
| **Guest leaves**         | Nothing to clean up                                          | Orphaned directory until cleanup                         |
| **Server restart**       | Re-pulls from registry on next login                         | shared.db + notifications.db survive                     |
| **Notifications**        | None (must hide bell)                                        | Persistent across sessions                               |
| **Upgrade to user**      | Run reconciliation, create UserHome from scratch             | Move directory, add missing services                     |
| **Code divergence risk** | High — `receiveACLChange` override must mirror Drive         | None — all inherited                                     |
| **Post-creation share gap** | Registry only has pre-creation entries; needs workaround  | No gap — standard ACL propagation writes to shared.db    |

---

## Files

| File                                                        | Phase | Purpose                                   |
|-------------------------------------------------------------|-------|-------------------------------------------|
| `apps/api/src/lib/home/guest-home.ts`                       | 2     | GuestHome class (Drive + Notifications)   |
| `apps/api/src/lib/config/paths.ts`                          | 2     | `getGuestHomePath()` helper               |
| `apps/api/src/lib/home/get-home.ts`                         | 2     | Route to GuestHome for `role: 'guest'`    |
| `apps/api/src/lib/share/reconciliation.ts`                  | 2     | Calendar null guards                      |
| `apps/api/src/lib/calendar/share-propagation.ts`            | 2     | Calendar null guard in propagation loop   |
| `apps/api/src/routes/guest-auth.ts`                         | 2     | OTP auth + upgrade + reconciliation       |
| `apps/api/src/routes/drive.ts`                              | 1     | Request-access endpoint                   |
| `apps/api/src/lib/auth/auth.ts`                             | 2     | emailOTP plugin, skip org join for guests |
| `packages/ui/src/components/layout/app/access-gate.tsx`     | 1     | AccessGate component                      |
| `packages/ui/src/components/layout/pages/loginpage.tsx`     | 2     | Guest OTP login tab                       |
| `packages/ui/src/components/layout/pages/login-route.tsx`   | 2     | Email search param                        |
| `packages/lib/src/core/drive/hooks/use-drive.ts`            | 1     | `useRequestAccess()` mutation hook        |
| `packages/ui/src/components/layout/app/topbar.tsx`          | 2     | "Create full account" button for guests   |
| `apps/docs/src/routes/_auth.doc.$ownerId.$mountId.$pathId.tsx`       | 1 | Replace AccessDenied with AccessGate |
| `apps/stickies/src/routes/_auth.board.$ownerId.$mountId.$pathId.tsx` | 1 | Same                                 |
| `apps/slides/src/routes/_auth.slide.$ownerId.$mountId.$pathId.tsx`   | 1 | Same                                 |
| `apps/sheets/src/routes/_auth.sheet.$ownerId.$mountId.$pathId.tsx`   | 1 | Same                                 |
| `apps/drive/src/routes/_auth.fs.$ownerId.$mountId.$pathId.tsx`       | 1 | Add AccessGate (currently NotFound)  |
| `apps/chat/src/routes/_auth.$ownerId.$mountId.$chatId.tsx`           | 1 | Add AccessGate (no current check)    |
| `apps/*/src/routes/__root.tsx`                              | 2     | Guest sidebar restrictions                |
| `docs/NOTIFICATION-CENTER.md`                               | 1     | Add access-request notification type      |
