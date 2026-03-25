# Guest Access & Access Requests

> **TLDR**: External guests authenticate via Email OTP and get a lightweight `GuestHome` with no disk presence — shared
> paths are cached in memory on the GuestDrive instance, rebuilt from the share registry on each session. ACL email
> matching handles permissions without guest-specific code. Logged-in users without access see a "Request access"
> screen. Three phases, each independently shippable.

## Three Access States

Every shared resource URL resolves to one of three states:

| State                      | What the user sees                            |
|----------------------------|-----------------------------------------------|
| Authenticated + has access | The resource (works today)                    |
| Authenticated + no access  | "Request access" screen with owner info (new) |
| Not authenticated          | Login page with guest OTP option (new)        |

## Design: GuestHome (In-Memory)

### The Principle

Guests get a real `Home` object that participates in the system — SSE, ACL propagation, shared-with-me — but leaves
zero disk footprint. Shared paths are cached as an in-memory array on the `GuestDrive` instance, populated from the
share registry on init and kept current by `receiveACLChange()` while the Home is alive.

### GuestHome

```
GuestHome extends Home
├── homeDir: (none — no disk)
├── _drive: GuestDrive
│   └── sharedPaths: DrivePath[] (in-memory cache)
│       ├── getSharedPathsWithMe()  → returns cached array
│       └── receiveACLChange()      → updates cached array + broadcasts SSE
├── _notifications: null (no notification persistence)
├── _mail: null
├── _contacts: null
├── _calendar: null
├── broadcast() / subscribeSSE() / unsubscribeSSE() — standard (base Home)
└── touch() / destruct() — standard idle timeout, cache freed on eviction
```

No disk directory. No SQLite databases. The Home lives in memory for the standard 5-minute idle timeout.

### GuestDrive

Subclass of `Drive` that overrides three methods:

**`init()`** (~15 lines):

1. Query share registry for entries targeting the guest's email
2. For each `fromUserId`: call `ownerHome.drive.getSharedWith(guestUser)`
3. Store results in `this.sharedPaths` array
4. Skip mount creation (no personal storage)

**`getSharedPathsWithMe()`** (~1 line):
Return `this.sharedPaths`.

**`receiveACLChange(path, newACL, actorEmail)`** (~20 lines):

1. If no longer shared: remove from `sharedPaths` array
2. If already in array: update entry
3. If new share: push to array
4. Call `this.home.broadcast(buildDriveEvent(...))` for SSE
5. Notifications skipped (`_notifications` is null, all callers use `?.` optional chaining)

Note: `Drive.emit()` is private, so the override calls `this.home.broadcast()` directly.

Everything else on Drive (mount-dependent methods like `uploadFile`, `createFolder`) is never called on the guest's own
drive — guests access shared resources via `getSharedDrive(ownerId, user)` which wraps the _sharer's_ drive.

### Lifecycle

```
Guest logs in
  → getHome(guestId) creates GuestHome
  → GuestDrive.init() pulls shared paths from registry into in-memory cache
  → Guest navigates, accesses shared resources via sharer's drive (standard ACL)
  → If someone shares/unshares while guest is online:
      ACL propagation calls receiveACLChange() → updates cache + SSE event
  → 5 min idle → Home destructed → cache freed
  → Next request → GuestHome recreated → cache rebuilt from registry
```

### Share Registry for Guests

Today's flow: share → registry entry → user created → reconcile pulls into disk `shared.db` → registry entry deleted.

Guest flow: share → registry entry → guest created → registry entry **stays** → cache populated from registry on each
GuestHome init.

Registry entries are never deleted for guests (until they upgrade to a regular user). The registry is the permanent
source of truth; the in-memory cache is a session-scoped view of it.

### Calendar Propagation Guards

`reconciliation.ts` calls `targetHome.calendar.receiveShare()` and `targetHome.calendar.receiveInvitation()` directly
(no `?.` optional chaining). Since GuestHome has `_calendar = null`, these need guards:

```typescript
if (targetHome.calendar) {
    await pullCalendarShares(ownerHome, targetHome, ...);
}
if (targetHome.calendar) {
    await pullPendingInvitations(ownerHome, targetHome, ...);
}
```

These guards are needed regardless of storage approach — any GuestHome without a calendar requires them.

### Notification Routes

All notification routes use `requireSelf()`, so guests _can_ hit them. With `_notifications = null`, they'd throw.
Solution: frontend hides the notification bell for guests, so the routes are never called. No backend stubs needed.

All `home.notifications?.persist()` calls throughout the codebase (10+ sites) already use optional chaining — they
silently skip when notifications is null.

### Home Factory Change

In `get-home.ts`, the `case 'user'` branch checks `user.role`:

```
case 'user': {
    const user = await getUserById(parsed.id);
    if (user.role === 'guest') {
        home = new GuestHome(user, cleanUp);
    } else {
        home = new UserHome(user, cleanUp);
    }
}
```

---

## Alternative: Disk-Based GuestHome

Instead of in-memory caching, give guests a minimal disk home at `data/guest/{guestId}/` with `shared.db` and
optionally `notifications.db`. Standard reconciliation populates `shared.db` and cleans registry entries.

### Disk layout

```
data/guest/{guestId}/
├── mounts/shared.db              # ~10KB
└── eigen.notifications/
    └── notifications.db          # ~10KB
```

### Comparison

|                          | In-memory (recommended)                                      | Disk-based                                               |
|--------------------------|--------------------------------------------------------------|----------------------------------------------------------|
| **GuestDrive code**      | ~35 lines (init + 2 overrides)                               | ~5 lines (init override only)                            |
| **Inherited from Drive** | `getSharedPathsWithMe` and `receiveACLChange` need overrides | Both inherited unchanged                                 |
| **Disk footprint**       | Zero                                                         | ~20KB per guest                                          |
| **Guest leaves**         | Nothing to clean up                                          | Orphaned directory until cleanup cron                    |
| **Server restart**       | Re-pulls from registry on next login                         | shared.db survives instantly                             |
| **Registry entries**     | Kept permanently for guests                                  | Cleaned up (standard reconciliation)                     |
| **Notifications**        | None (bell hidden for guests)                                | Persistent across sessions                               |
| **Cleanup infra**        | None needed                                                  | Cron job for inactive guests                             |
| **Upgrade to user**      | Run reconciliation, create UserHome                          | Move `data/guest/` → `data/home/`, init missing services |
| **Code divergence risk** | `receiveACLChange` override could drift from Drive           | None — all inherited                                     |

### When to choose disk

- If persistent notifications for guests become important
- If the `receiveACLChange` override proves fragile during Drive evolution
- If rebuild-on-init latency is noticeable (unlikely — N sharers is typically 1-5)

### When to choose in-memory

- Guests are transient, zero-footprint is a clean property
- No cleanup infrastructure needed
- The override is small and focused (~35 lines)

---

## Shared Work (Both Approaches)

Regardless of storage approach, the following is needed:

**Backend:**

- `GuestHome` class extending `Home` (no mail, contacts, calendar)
- `GuestDrive` class extending `Drive` (no mounts)
- Home factory change in `get-home.ts`
- Calendar null guards in `reconciliation.ts` (~3 lines)
- Email OTP plugin in `auth.ts`
- Guest auth router (`guest-auth.ts`)
- Auth hook: skip org join for guests
- Request-access endpoint in `drive.ts`

**Frontend:**

- `<AccessGate/>` component (replaces `<AccessDenied/>`)
- Login page: guest OTP tab
- Topbar: hide notification bell for guests
- Sidebar: hide Mail, Contacts, Calendar, Space for guests
- App roots (`__root.tsx`): redirect guests from personal apps

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

- If `user.role === 'guest'`: skip `authAddUserToDefaultOrg()` (guests don't join the org)
- Skip `reconcileSharesForNewUser()` for guests (registry entries stay, cache populated on GuestHome init)

### Login Page

Modify `packages/ui/src/components/layout/pages/loginpage.tsx`:

- Two-tab layout: **"Sign in"** | **"Continue as guest"**
- Guest tab: email → "Send code" → OTP input → "Verify" → redirect to original URL
- Add optional `email` search param to `loginSearchSchema` for pre-filling

### Topbar & Sidebar

For `user.role === 'guest'`:

- Sidebar: show "Shared with me" only, hide Mail, Contacts, Calendar, etc.
- App roots (`__root.tsx`): redirect guests away from personal apps
- Hide notification bell (no notification center)

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
2. Evict GuestHome from factory
3. `getHome()` now creates a `UserHome` (disk-based)
4. Run `reconcileSharesForNewUser()` — creates Home on disk, pulls shares into `shared.db`, cleans registry
5. Add to default org via `authAddUserToDefaultOrg()`

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

## Open Questions

- **Email delivery**: OTP requires sending emails. Self-hosted Eigen instances need a configured mail transport. Same
  requirement as password reset — not guest-specific, but a prerequisite
- **Guest session lifetime**: Should guest sessions expire faster than regular sessions? Better-auth supports
  per-session TTL configuration
- **Storage approach**: See comparison table above. In-memory is recommended for zero-footprint, disk-based is the
  fallback if `receiveACLChange` override proves fragile

## Files

| File                                                      | Purpose                                 |
|-----------------------------------------------------------|-----------------------------------------|
| `apps/api/src/lib/home/guest-home.ts`                     | GuestHome class                         |
| `apps/api/src/lib/drive/guest-drive.ts`                   | GuestDrive (in-memory cache, no mounts) |
| `apps/api/src/lib/home/get-home.ts`                       | Route to GuestHome for `role: 'guest'`  |
| `apps/api/src/lib/share/reconciliation.ts`                | Calendar null guards                    |
| `apps/api/src/routes/guest-auth.ts`                       | OTP auth + upgrade endpoints            |
| `apps/api/src/routes/drive.ts`                            | Request-access endpoint                 |
| `apps/api/src/lib/auth/auth.ts`                           | emailOTP plugin, skip org join          |
| `packages/ui/src/components/layout/app/access-gate.tsx`   | AccessGate component                    |
| `packages/ui/src/components/layout/pages/loginpage.tsx`   | Guest OTP login tab                     |
| `packages/ui/src/components/layout/pages/login-route.tsx` | Email search param                      |
| `packages/lib/src/core/drive/hooks/use-drive.ts`          | `useRequestAccess()` mutation hook      |
| `packages/ui/src/components/layout/app/topbar.tsx`        | Guest topbar adaptations                |
| `apps/*/src/routes/_auth.*.tsx`                           | Replace AccessDenied with AccessGate    |
| `apps/*/src/routes/__root.tsx`                            | Guest sidebar restrictions              |
| `docs/NOTIFICATION-CENTER.md`                             | Add access-request notification type    |
