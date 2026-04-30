# Guest Access

> **TLDR**: External guests authenticate via Email OTP and get a disk-based `GuestHome` with `shared.db` +
> `notifications.db` — no mail, contacts, or calendar. Standard Drive inheritance handles ACL propagation.
> Logged-in users without access see a "Request access" screen.

## Three Access States

| State                      | What the user sees                       |
|----------------------------|------------------------------------------|
| Authenticated + has access | The resource                             |
| Authenticated + no access  | "Request access" screen with owner info  |
| Not authenticated          | Login page with guest OTP option         |

## GuestHome

`GuestHome` extends `Home` with minimal services — only Drive (for `shared.db`) and NotificationCenter.
Mail, contacts, and calendar are left uninitialized.

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
`getSharedPathsWithMe()` and receiving ACL propagation via `receiveACLChange()`.

### Why Disk-Based

Disk-based over in-memory because: (1) `Drive.home` and `Drive.emit()` are `private` — a subclass can't
override without changing access modifiers, (2) `receiveACLChange()` is ~50 lines that would need parallel
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

Two-step OTP flow via custom endpoints (not better-auth's emailOTP plugin):

### Request OTP

`POST /guest-auth/request-otp { email }` — validates email, checks the user is either an existing guest
or has pending shares in the registry, then sends a 6-digit OTP via email (5-minute expiry).

### Verify OTP

`POST /guest-auth/verify-otp { email, otp }` — verifies the OTP, finds or creates a guest user with
`role: 'guest'`, creates a deterministic password via `HMAC-SHA256('guest:{email}', auth.secret)`, signs
in via `auth.api.signInEmail()`, and calls `reconcileSharesForNewUser()` to pull pending shares from the
registry into `shared.db`.

Guest user creation bypasses `databaseHooks` — no org join, no default reconciliation. The reconciliation
runs explicitly after OTP verification instead.

## Access Request Flow

When an authenticated user visits a shared resource they don't have access to:

1. App renders `<RequestAccessView>` instead of a generic access-denied page
2. User clicks "Request access" → `POST /drive/:ownerId/:mountId/path/:pathId/request-access`
3. Endpoint sends a notification to the resource owner via `sendToHome()`
4. Notification tag: `access-request:{ownerId}:{mountId}:{pathId}:{email}` (idempotent via tag dedup)
5. Owner clicks notification → navigates to Drive with share dialog pre-filled with requester's email
6. Owner grants access → ACL propagation fires → `DRIVE_ACL_SHARED` SSE event → requester's
   permission query auto-refetches → resource appears

The endpoint always returns 200 regardless of whether the path exists (no existence leak).

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

**Login page** — two tabs: "Sign in" (password) and "Guest" (OTP). Guest tab: email input → send code →
6-digit input → verify → reload.

**Topbar** — guest app switcher limited to Drive, Docs, Stickies, Slides, Sheets, Chat. Simplified user
dropdown (logout only, no settings/profile/theme).

**Notification link resolution** — `resolveAccessRequestLink()` parses the notification tag and returns a
Drive URL with `sharePathId` and `shareEmail` query params to pre-fill the share dialog.

## Share Registry + Reconciliation

Standard flow, same as regular users:

1. **Before guest account exists**: share → `resolveACLUserIds` → user not found → registry entry created
2. **Guest verifies OTP**: account created → `reconcileSharesForNewUser()` pulls from registry into
   `shared.db` → deletes consumed registry entries
3. **After guest account exists**: share → `resolveACLUserIds` → user found → `receiveACLChange()` called
   directly → writes to `shared.db`

## Known Limitations

- **Team notifications**: team-owned resources (`team_xyz` ownerId) — `TeamHome` has no NotificationCenter,
  so access request notifications are silently skipped
- **No guest upgrade**: no endpoint or UI to convert a guest to a regular user (set password, change role,
  move data directory). Planned but not yet implemented
- **Request state**: "Access requested" state is client-side only (lost on refresh). Idempotent via tag
  dedup — re-requesting just updates the notification timestamp

## Files

| File | Purpose |
|------|---------|
| `apps/api/src/lib/home/guest-home.ts` | GuestHome class |
| `apps/api/src/lib/config/paths.ts` | `getGuestHomePath()` |
| `apps/api/src/lib/home/get-home.ts` | Routes guest users to GuestHome |
| `apps/api/src/lib/auth/guest-auth.ts` | OTP request/verify logic |
| `apps/api/src/routes/guest-auth.ts` | Guest auth endpoints |
| `apps/api/src/lib/core/access.ts` | `requireNonGuest()` |
| `apps/api/src/lib/auth/auth.ts` | Guest bypass in databaseHooks |
| `apps/api/src/routes/drive.ts` | `POST .../request-access` endpoint |
| `apps/api/src/lib/share/reconciliation.ts` | Share reconciliation with calendar null guards |
| `apps/api/src/lib/calendar/share-propagation.ts` | Calendar propagation with guest guard |
| `packages/ui/src/components/layout/app/request-access-view.tsx` | RequestAccessView component |
| `packages/ui/src/components/layout/app/topbar.tsx` | Guest app switcher + dropdown |
| `packages/ui/src/components/layout/pages/loginpage.tsx` | Guest OTP login tab |
| `packages/lib/src/core/drive/hooks/use-drive.ts` | `useRequestAccess()` hook |
| `packages/lib/src/core/drive/sse-handlers.ts` | Collab info invalidation on ACL events |
| `packages/lib/src/core/notification/resolve-link.ts` | Access request notification link resolution |
