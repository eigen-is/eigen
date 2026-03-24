# Guest Access & Access Requests

> **TLDR**: External guests authenticate via Email OTP and get a lightweight `GuestHome` at `data/guest/{guestId}/`
> with only `shared.db` and `notifications.db` — no drive mounts, mail, contacts, or calendar. Standard reconciliation
> populates `shared.db` and cleans registry entries like for any other user. ACL email matching handles permissions.
> Logged-in users without access see a "Request access" screen. Three phases, each independently shippable.

## Three Access States

Every shared resource URL resolves to one of three states:

| State                      | What the user sees                            |
|----------------------------|-----------------------------------------------|
| Authenticated + has access | The resource (works today)                    |
| Authenticated + no access  | "Request access" screen with owner info (new) |
| Not authenticated          | Login page with guest OTP option (new)        |

## Design: GuestHome

### The Principle

Guests get a real Home that participates in the system normally — just a minimal one. No special code paths, no
in-memory hacks, no permanent registry entries. The `GuestHome` is a ~20-line subclass that skips the services guests
don't need.

### GuestHome

```
data/guest/{guestId}/
├── mounts/shared.db              # what's shared with this guest (~10KB)
└── eigen.notifications/
    └── notifications.db          # persistent notifications (~10KB)
```

Compare to a regular `UserHome`:

```
data/home/{userId}/
├── settings.json
├── mounts/default/               # ← not created for guests
│   ├── metadata.db
│   ├── data/
│   └── thumbs/
├── mounts/shared.db              # same
├── eigen.mail/                   # ← not created for guests
├── eigen.contacts/               # ← not created for guests
├── eigen.calendar/               # ← not created for guests
└── eigen.notifications/          # same
```

Disk cost: ~20KB per guest. Negligible even at 1000 guests (20MB).

### GuestHome Class

```
GuestHome extends Home
├── homeDir: data/guest/{guestId}/
├── _drive: GuestDrive
│   └── sharedDb: disk-based shared.db (standard)
│       ├── getSharedPathsWithMe()  ✓ same code as Drive
│       └── receiveACLChange()      ✓ same code as Drive
├── _notifications: NotificationCenter (standard, disk-based)
├── _mail: null (not initialized)
├── _contacts: null (not initialized)
├── _calendar: null (not initialized)
└── broadcast() — works (SSE listeners on base Home)
```

### GuestDrive

Subclass of `Drive` that overrides `init()` to:

1. Open `shared.db` (standard, disk-based — via `getSharedDatabase(home)`)
2. Skip mount creation entirely (no personal storage)

That's it. `getSharedPathsWithMe()` and `receiveACLChange()` are inherited from `Drive` unchanged — they read/write
`this.sharedDb` which is a normal on-disk SQLite database. No overrides needed.

Mount-dependent methods (`uploadFile`, `createFolder`, etc.) naturally fail because no mounts exist. But they're never
called — guests access shared resources via `getSharedDrive(ownerId, user)` which uses the _sharer's_ drive.

### Standard Reconciliation

Guest creation triggers the same reconciliation as any user:

1. `user.create.after` fires
2. Skip `authAddUserToDefaultOrg()` (guests don't join the org)
3. Run `reconcileSharesForNewUser(user)` — this creates the GuestHome, pulls shares into `shared.db`, cleans registry
4. Registry entries deleted (standard cleanup — `shared.db` is the permanent record now)

No special reconciliation logic for guests. The only difference is that `getHome(guestId)` creates a `GuestHome`
instead of a `UserHome`.

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

### Why This Is Better Than In-Memory

- **Simpler**: No `GuestDrive` override for in-memory DB setup, no registry-as-permanent-source-of-truth, no
  rebuild-on-init logic
- **More robust**: Survives server restarts without re-pulling. No data loss on idle timeout
- **Standard reconciliation**: Same flow as regular users — pull shares, clean registry, done
- **Persistent notifications**: Guests see their notification history across sessions
- **Negligible cost**: ~20KB per guest vs ~0KB. Not worth the complexity to avoid

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
- Run `reconcileSharesForNewUser()` normally — this creates the GuestHome and populates `shared.db`

### Login Page

Modify `packages/ui/src/components/layout/pages/loginpage.tsx`:

- Two-tab layout: **"Sign in"** | **"Continue as guest"**
- Guest tab: email → "Send code" → OTP input → "Verify" → redirect to original URL
- Add optional `email` search param to `loginSearchSchema` for pre-filling

### Topbar & Sidebar

For `user.role === 'guest'`:

- Sidebar: show "Shared with me" only, hide Mail, Contacts, Calendar, etc.
- App roots (`__root.tsx`): redirect guests away from personal apps
- Notification bell works (GuestHome has persistent notifications)

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
3. Move `data/guest/{guestId}/` contents to `data/home/{userId}/` (preserve shared.db + notifications.db)
4. `getHome()` now creates a `UserHome` — initializes drive mounts, mail, contacts, calendar
5. Add to default org via `authAddUserToDefaultOrg()`

Triggered from a "Create full account" button in the guest's topbar.

```
POST /guest-auth/upgrade    { password }    → set password, change role, migrate home dir
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
- **No special code paths** — `receiveACLChange()`, `getSharedPathsWithMe()`, SSE, notifications all use the same
  code because GuestHome provides the same interfaces with real databases
- **Standard reconciliation** — same pull + cleanup flow as regular users, no permanent registry entries
- **Persistent state** — `shared.db` and `notifications.db` survive server restarts and session timeouts
- **Minimal disk** — ~20KB per guest, no drive mounts, no mail/contacts/calendar directories
- **Upgrade path** — guest → regular user moves the home dir and initializes the missing services

## Open Questions

- **Email delivery**: OTP requires sending emails. Self-hosted Eigen instances need a configured mail transport. This
  is the same requirement as password reset — not guest-specific, but a prerequisite
- **Guest session lifetime**: Should guest sessions expire faster than regular sessions? Better-auth supports
  per-session TTL configuration
- **Guest home cleanup**: Should inactive guest homes be cleaned up after a period (e.g. 90 days)? A cron job could
  remove `data/guest/` entries for guests who haven't logged in recently

## Files

| File                                                      | Purpose                                |
|-----------------------------------------------------------|----------------------------------------|
| `apps/api/src/lib/home/guest-home.ts`                     | GuestHome class (~20 lines)            |
| `apps/api/src/lib/drive/guest-drive.ts`                   | GuestDrive (shared.db only, no mounts) |
| `apps/api/src/lib/home/get-home.ts`                       | Route to GuestHome for `role: 'guest'` |
| `apps/api/src/lib/config/paths.ts`                        | Add `getGuestHomePath()`               |
| `apps/api/src/routes/guest-auth.ts`                       | OTP auth + upgrade endpoints           |
| `apps/api/src/routes/drive.ts`                            | Request-access endpoint                |
| `apps/api/src/lib/auth/auth.ts`                           | emailOTP plugin, skip org join         |
| `packages/ui/src/components/layout/app/access-gate.tsx`   | AccessGate component                   |
| `packages/ui/src/components/layout/pages/loginpage.tsx`   | Guest OTP login tab                    |
| `packages/ui/src/components/layout/pages/login-route.tsx` | Email search param                     |
| `packages/lib/src/core/drive/hooks/use-drive.ts`          | `useRequestAccess()` mutation hook     |
| `packages/ui/src/components/layout/app/topbar.tsx`        | Guest topbar adaptations               |
| `apps/*/src/routes/_auth.*.tsx`                           | Replace AccessDenied with AccessGate   |
| `apps/*/src/routes/__root.tsx`                            | Guest sidebar restrictions             |
| `docs/NOTIFICATION-CENTER.md`                             | Add access-request notification type   |
