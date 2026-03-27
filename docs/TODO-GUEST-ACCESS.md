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

Independently useful. Works for any logged-in user who visits a resource without access. Follows the Google
Docs/Drive standard: same URL shows either the resource or a "request access" screen — no redirect, no ambiguous
error page.

### Current Access-Denied Behavior (Problems)

| App | How permission is checked | What user sees on no-access | Problem |
|-----|--------------------------|----------------------------|---------|
| Docs | `GET /collab/.../info` returns `{canRead:false}` (200) | `<AccessDenied/>` — "Encountering the null vector" | No owner info, no request button, cryptic message |
| Stickies, Slides, Sheets | Same as Docs | Same | Same |
| Drive | `GET /drive/.../folder/:pathId` throws 403 via `SharedDrive.withReadPermission` | `<NotFound/>` | **403 shown as 404** — user thinks resource doesn't exist |
| Chat | `useMessages` silently returns `[]` on 403 (no error thrown) | Empty chat, no error state | **No access handling at all** |
| People | Client-side role check | `<AccessDenied/>` with role message | Fine as-is (admin-only, not resource-based) |

### Target Behavior (Google Standard)

When an authenticated user visits a resource they don't have access to:

1. **Same URL** — no redirect, the URL stays the same
2. **Lock icon** + "You need access" heading
3. **Owner info** — avatar, name, email (via existing `GET /p/user/:ownerId`)
4. **"Request access" button** — primary CTA, with optional message field
5. **Current identity** — "You're signed in as bob@example.com"
6. **After requesting** — button changes to "Access requested" (disabled), confirmation shown
7. **Idempotent** — clicking again doesn't create duplicate notifications (tag-based dedup)
8. **Auto-refresh** — when owner grants access, SSE triggers permission re-check → resource appears

### `<RequestAccessView/>` Component

A standalone component (not a wrapper) that each app places where appropriate based on its existing permission-check
pattern. This avoids redundant API calls in apps that already check permissions.

```
<RequestAccessView ownerId={ownerId} mountId={mountId} pathId={pathId}>
  ├── Uses usePublicUser(ownerId)         → owner avatar, name, email  (existing hook, no auth needed)
  ├── Uses useAuth()                      → current user email          (existing hook)
  ├── Uses useRequestAccess() mutation    → POST request-access         (new hook)
  └── Renders:
       ├── Lock icon (Lucide: LockKeyhole)
       ├── "You need access"
       ├── Owner avatar + name + email
       ├── Optional message textarea (collapsed by default)
       ├── "Request access" button → on success: "Access requested ✓" (disabled)
       └── "You're signed in as bob@example.com"
```

Location: `packages/ui/src/components/layout/app/request-access-view.tsx`

Why standalone instead of wrapper: Collab apps already check permissions via `useCollabDocumentInfo` (returns
`{canRead}` in the response body, not a 403). Adding a wrapper would duplicate the permission check. Each app
integrates `<RequestAccessView/>` in its existing control flow.

### Request Access Backend

**New endpoint:**

```
POST /drive/:ownerId/:mountId/path/:pathId/request-access
Auth: required
Body: { message?: string }
Response: { success: true }
```

Implementation in `apps/api/src/routes/drive.ts`:

1. Get path name from owner's drive: `getHome(ownerId).drive.getPath(mountId, pathId)`
   - If path not found → 404 (resource genuinely doesn't exist)
2. Persist notification in **owner's** NotificationCenter:
   - type: `access-request`
   - title: `"{requesterEmail} requested access to '{pathName}'"` (or just `"... requested access"` if no name)
   - body: the optional message from the requester (or null)
   - tag: `access-request:{mountId}:{pathId}:{email}` (dedup via `onConflictDoUpdate` — re-requesting updates
     timestamp and message, doesn't create duplicates)
   - actorEmail: requester's email
3. Return `{success: true}`

No new SSE events — the existing `notification:created` SSE event triggers the toast on the owner's screen.

**New hook** in `packages/lib/src/core/drive/hooks/use-drive.ts`:

```typescript
export function useRequestAccess(ownerId: string, mountId: string, pathId: string) {
    return useMutation({
        mutationFn: async (body: { message?: string }) => {
            const response = await driveApi({ownerId})({mountId}).path({pathId})['request-access'].post(body);
            if (response.error) throw new AppError(response);
            return response.data;
        },
    });
}
```

### SSE Auto-Refresh When Access is Granted

When the owner grants access via the share dialog, `propagateACLChange()` fires → `receiveACLChange()` on the
requester's Home → broadcasts `DRIVE_ACL_SHARED` SSE event to the requester.

The existing SSE handler in `packages/lib/src/core/drive/sse-handlers.ts` already handles this:

```typescript
case SSEventType.DRIVE_ACL_SHARED:
    invalidateAclSharedOrUnshared(queryClient, userId);     // invalidates shared-with-me
    invalidateAclUpdated(queryClient, path.ownerId, ...);   // invalidates driveKeys.read + driveKeys.write
```

`invalidateAclUpdated` invalidates `driveKeys.read(ownerId, mountId, pathId)` — which is the query key used by
`useCheckReadPermission`. So the permission query auto-refetches.

**Gap**: For collab apps, `useCollabDocumentInfo` uses `collabKeys.document(ownerId, mountId, pathId)` =
`['collab', 'info', ownerId, mountId, pathId]`. This is NOT invalidated by the SSE handler. Fix: add collab info
invalidation to the `DRIVE_ACL_SHARED` / `DRIVE_ACL_UNSHARED` case in `sse-handlers.ts`:

```typescript
case SSEventType.DRIVE_ACL_SHARED:
case SSEventType.DRIVE_ACL_UNSHARED:
    if (userId) invalidateAclSharedOrUnshared(queryClient, userId);
    invalidateAclUpdated(queryClient, path.ownerId, path.mountId, path.id, path.parentId);
    queryClient.invalidateQueries({queryKey: ['collab', 'info', path.ownerId, path.mountId, path.id]});
    return true;
```

This ensures that when a user is sitting on the "request access" screen in a collab app and the owner grants
access, the page automatically transitions to show the document.

### Per-App Integration

Each app has a different permission-check pattern. The integration is tailored to each:

**Collab apps** (Docs, Stickies, Slides, Sheets):
Already check permissions via `useCollabDocumentInfo()` which returns `{canRead: false, path: null}` on no-access
(200 response, not a 403). Replace `<AccessDenied/>` with `<RequestAccessView/>`:

```tsx
// Before:
if (!docInfo?.canRead || !docInfo.path) {
    return <AccessDenied/>;
}

// After:
if (!docInfo?.canRead || !docInfo.path) {
    return <RequestAccessView ownerId={ownerId} mountId={mountId} pathId={pathId}/>;
}
```

Files:
- `apps/docs/src/routes/_auth.doc.$ownerId.$mountId.$pathId.tsx` — line 44-46
- `apps/stickies/src/routes/_auth.board.$ownerId.$mountId.$pathId.tsx` — same pattern
- `apps/slides/src/routes/_auth.slide.$ownerId.$mountId.$pathId.tsx` — same pattern
- `apps/sheets/src/routes/_auth.sheet.$ownerId.$mountId.$pathId.tsx` — same pattern

**Drive app**:
Currently uses `useFolderContent` which throws `AppError` with `status: 403` on no-access. The error is caught by
TanStack Query and stored in `isFolderContentLoadingError`. Currently shown as `<NotFound/>`.

Fix: distinguish 403 from other errors:

```tsx
// Before (apps/drive/src/routes/_auth.fs.$ownerId.$mountId.$pathId.tsx line 120-122):
if (isFolderContentLoadingError) {
    return <NotFound/>;
}

// After:
if (isFolderContentLoadingError) {
    if (isFolderContentLoadingError instanceof AppError && isFolderContentLoadingError.status === 403) {
        return <RequestAccessView ownerId={ownerId} mountId={mountId} pathId={pathId}/>;
    }
    return <NotFound/>;
}
```

The `AppError` class in `packages/lib/src/core/api-error.ts` preserves the HTTP status code, so this check works.

**Chat app**:
Currently has NO access handling. `useMessages` silently returns `[]` on 403. `useChatRoom` already calls
`useCheckWritePermission` but not `useCheckReadPermission`.

Fix: add a read permission check in the chat route component:

```tsx
// apps/chat/src/routes/_auth.$ownerId.$mountId.$chatId.tsx
function ChatView() {
    const {ownerId, mountId, chatId} = Route.useParams();
    const {data: readPermission, isLoading: permLoading} = useCheckReadPermission(ownerId, mountId, chatId);

    if (permLoading) return <LoadingState/>;
    if (!readPermission?.canRead) {
        return <RequestAccessView ownerId={ownerId} mountId={mountId} pathId={chatId}/>;
    }

    // ... existing chat UI
}
```

**People app**: No changes. Uses role-based `<AccessDenied/>` which is correct for admin-only access.

### "Request Already Sent" State

For v1: optimistic client-side only. After a successful `POST /request-access`, the mutation's `isSuccess` state
keeps the button disabled as "Access requested". This is lost on page refresh — the user can click again, but it's
idempotent (tag-based `onConflictDoUpdate` in NotificationCenter just updates the timestamp).

Future improvement: a dedicated `access_requests` table in the central DB to track pending requests, enabling
"already requested" state on page load and a "pending requests" view for owners.

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
| Home (export) | `requireSelf()` (zip route removed) |
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

| File                                                        | Phase | Purpose                                          |
|-------------------------------------------------------------|-------|--------------------------------------------------|
| **Phase 1: Access Request Screen** | | |
| `packages/ui/src/components/layout/app/request-access-view.tsx`      | 1     | RequestAccessView component (lock icon, owner info, request button) |
| `packages/lib/src/core/drive/hooks/use-drive.ts`                     | 1     | `useRequestAccess()` mutation hook               |
| `apps/api/src/routes/drive.ts`                                       | 1     | `POST .../request-access` endpoint               |
| `packages/lib/src/core/drive/sse-handlers.ts`                        | 1     | Add collab info invalidation on ACL shared/unshared |
| `apps/docs/src/routes/_auth.doc.$ownerId.$mountId.$pathId.tsx`       | 1     | Replace `<AccessDenied/>` with `<RequestAccessView/>` |
| `apps/stickies/src/routes/_auth.board.$ownerId.$mountId.$pathId.tsx` | 1     | Same                                             |
| `apps/slides/src/routes/_auth.slide.$ownerId.$mountId.$pathId.tsx`   | 1     | Same                                             |
| `apps/sheets/src/routes/_auth.sheet.$ownerId.$mountId.$pathId.tsx`   | 1     | Same                                             |
| `apps/drive/src/routes/_auth.fs.$ownerId.$mountId.$pathId.tsx`       | 1     | Distinguish 403 from 404, show `<RequestAccessView/>` |
| `apps/chat/src/routes/_auth.$ownerId.$mountId.$chatId.tsx`           | 1     | Add read permission check + `<RequestAccessView/>` |
| `docs/NOTIFICATION-CENTER.md`                                        | 1     | Add `access-request` notification type           |
| **Phase 2: Guest Authentication + GuestHome + Frontend** | | |
| `apps/api/src/lib/home/guest-home.ts`                       | 2     | GuestHome class (Drive + Notifications)          |
| `apps/api/src/lib/config/paths.ts`                          | 2     | `getGuestHomePath()` helper                      |
| `apps/api/src/lib/home/get-home.ts`                         | 2     | Route to GuestHome for `role: 'guest'`           |
| `apps/api/src/lib/share/reconciliation.ts`                  | 2     | Calendar null guards                             |
| `apps/api/src/lib/calendar/share-propagation.ts`            | 2     | Calendar null guard in propagation loop          |
| `apps/api/src/routes/guest-auth.ts`                         | 2     | OTP auth + upgrade + reconciliation              |
| `apps/api/src/lib/auth/auth.ts`                             | 2     | emailOTP plugin, skip org join for guests        |
| `packages/ui/src/components/layout/pages/loginpage.tsx`     | 2     | Guest OTP login tab                              |
| `packages/ui/src/components/layout/pages/login-route.tsx`   | 2     | Email search param                               |
| `packages/ui/src/components/layout/app/topbar.tsx`          | 2     | "Create full account" button for guests          |
| `apps/*/src/routes/__root.tsx`                              | 2     | Guest sidebar restrictions                       |
