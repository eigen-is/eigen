# Phase 2: Guest Authentication + GuestHome

> Guest users authenticate via custom OTP (not better-auth's emailOTP plugin), gated by the share
> registry. Only emails that appear in an existing share can create guest accounts. Guests get a
> disk-based `GuestHome` with Drive (shared.db only) + NotificationCenter. No mail, contacts, or
> calendar.

## Decision: Custom OTP Over better-auth emailOTP

better-auth's `emailOTP` plugin is not viable:

1. **`disableSignUp: true`**: silently returns `{success: true}` without sending email for unknown
   users — impossible to distinguish "sent" from "rejected"
2. **`disableSignUp: false`**: auto-creates user during `signInEmailOTP` — no control point to check
   the share registry between "OTP verified" and "user created"
3. **Known bugs**: silent failure (#3202), OTP type confusion (#2160), rate limit bypass (#1891)

Custom OTP uses: the existing `verification` table for OTP storage, `sendMail()` for delivery, and
`auth.api.signUpEmail` for user creation after verification succeeds.

## Guest Auth Flow

### Share Registry Gate

`getEntriesForTarget(email)` queries the `share_registry` table. If empty, no shares exist for that
email — return a clear error: "No shared resources found for this email." (Option A — no silent
failures, appropriate for a self-hosted workspace.)

### Endpoints

```
POST /guest-auth/request-otp  { email }
POST /guest-auth/verify-otp   { email, otp }
```

**request-otp:**

1. Validate email format
2. `getUserByEmail(email)`:
   - Exists with `role === 'guest'` → allow (returning guest)
   - Exists with other role → 400 "Use password login"
   - Null → `getEntriesForTarget(email)` — if empty → 400 "No shared resources found for this email"
3. Purge expired guest OTPs: `DELETE FROM verification WHERE expiresAt < now AND identifier LIKE 'guest-otp:%'`
4. Generate 6-digit OTP
5. Store in `verification` table: identifier `guest-otp:{email}`, value = OTP hash, expiresAt =
   now + 5min. Use `onConflictDoUpdate` so re-requesting replaces the previous OTP.
6. `sendMail()` with OTP
7. Return `{ success: true }`

**verify-otp:**

1. Look up `verification` record by identifier `guest-otp:{email}`
2. Check expiry (5 min) — if expired → 400 "Code expired"
3. Verify OTP matches — if not → 400 "Invalid code"
4. Delete verification record (single-use)
5. `getUserByEmail(email)`:
   - Exists with `role === 'guest'`: sign in (create session via better-auth internal adapter)
   - Exists with other role: reject ("Use password login" — shouldn't happen if request-otp
     blocked it, but defense in depth)
   - Null: create user via `auth.api.signUpEmail({ email, password: randomUUID(), name: email
     username part, role: 'guest' })`. Random password is never exposed — guests authenticate
     only via OTP.
6. For new users: `reconcileSharesForNewUser(user)` — pulls pending shares from registry into
   the new GuestHome's shared.db
7. Set session cookie, return session

### Verification Table Usage

The `verification` table already exists in the auth DB (used by better-auth for 2FA). Schema:

```sql
CREATE TABLE verification (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    expiresAt INTEGER NOT NULL,
    createdAt INTEGER,
    updatedAt INTEGER
);
```

We store OTPs with identifier `guest-otp:{email}` and value = hashed OTP. This avoids adding new
tables and reuses existing infrastructure.

### Session Creation

For returning guests (user exists, `role === 'guest'`), we need to create a session without a
password. Two approaches:

**Approach A — Use auth internal adapter directly:** Access `auth.api` internals to create a session.
This requires either a custom better-auth plugin endpoint or using the admin API's impersonation flow.

**Approach B — Use a "sign-in" with the stored random password:** Not viable — we don't store the
random password.

**Approach C — Re-sign-up idempotently:** `auth.api.signUpEmail` will fail if user exists. Need a
different path for returning guests.

**Chosen: Direct session creation via auth DB.** For returning guests, insert a session record
directly into the `session` table using `getAuthDrizzleDb()`. Generate a session token
(`crypto.randomUUID()`), insert into `session` table with userId + expiresAt, then set the
`better-auth.session_token` cookie on the response. This is the same pattern better-auth uses
internally — fully controlled, no plugin dependencies.

For new guests, `auth.api.signUpEmail` handles user + account + session creation in one call. The
`role: 'guest'` field is set via the admin plugin's user metadata (verify during implementation that
`signUpEmail` accepts extra fields — if not, use `auth.api.createUser` from the admin plugin instead,
then create session manually as above).

## GuestHome

### Class

```typescript
// apps/api/src/lib/home/guest-home.ts
export class GuestHome extends Home {
    constructor(user: User, cleanUp?: () => void) {
        super(user, cleanUp);
        this.homeDir = getGuestHomePath(user.id);
        this.fs = new LocalFilesystem(this.homeDir);
        this.settings = new JsonStore<HomeSettings>(this.fs, 'settings.json', {});
        this._drive = new Drive(this);
        this._notifications = new NotificationCenter(this);
        // _mail, _contacts, _calendar left undefined
    }

    override async init() {
        await this.settings.load();
        return super.init(false); // false = no default mount
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

### Disk Layout

```
data/guest/{guestId}/
├── mounts/
│   └── shared.db       # shared-with-me paths (~10KB)
├── settings.json        # empty
└── eigen.notifications/
    └── notifications.db # notifications (~10KB)
```

### Path Helper

Add `getGuestHomePath(userId)` to `apps/api/src/lib/config/paths.ts`:

```typescript
export function getGuestHomePath(userId: string): string {
    return path.join(getDataRoot(), 'guest', userId);
}
```

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

### Auth Hook Change

Skip org join and reconciliation for guests during account creation (reconciliation runs explicitly
in the verify-otp handler instead):

```typescript
create: {
    after: async (user) => {
        if (user.role === 'guest') return;
        await authAddUserToDefaultOrg(user);
        await reconcileSharesForNewUser(user);
    },
},
```

## Null Guards

### Approach: `hasCalendar` Getter

`_calendar` is `protected` and typed as `Calendar` (not optional). External code can't check it
directly, and the public getter is typed non-nullable. Add a public getter to Home base class:

```typescript
get hasCalendar(): boolean { return !!this._calendar; }
```

### reconciliation.ts

`reconcileSharesForNewUser()` calls `targetHome.calendar.*` directly. Guard with `hasCalendar`:

```typescript
if (targetHome.hasCalendar) {
    const calShares = await pullCalendarShares(fromUserId, user.email, []);
    for (const result of calShares) {
        targetHome.calendar.receiveShare(...);
    }

    const invitations = await pullPendingInvitations(fromUserId, user.email);
    for (const event of invitations) {
        targetHome.calendar.receiveInvitation(...);
    }
}
```

### home-relay.ts

`sendToHome()` dispatches to `home.calendar.*` for calendar message types. Guard all calendar cases:

```typescript
case 'calendar:share':
    if (!home.hasCalendar) break;
    // ... existing code

case 'calendar:invitation':
case 'calendar:invitation-update':
case 'calendar:invitation-removal':
case 'calendar:rsvp':
    if (!home.hasCalendar) break;
    // ... existing code
```

## Backend Route Guards

Add `requireNonGuest(user)` to `apps/api/src/lib/core/access.ts`:

```typescript
export function requireNonGuest(user: { role?: string | null }): void {
    if (user.role === 'guest') {
        throw new ApiError(403, 'Guests cannot access this resource');
    }
}
```

Apply via `.onBeforeHandle()` on each restricted router — one line per file, guards all routes in
that module:

| Router file | Router name |
|-------------|-------------|
| `routes/mail.ts` | `mailRouter` |
| `routes/contacts.ts` | `contactsRouter` |
| `routes/calendar.ts` | `calendarRouter` |
| `routes/space.ts` | `spaceRouter` |

```typescript
.use(betterAuth)
.onBeforeHandle(({ user }) => { if (user) requireNonGuest(user); })
```

The `if (user)` check handles unauthenticated routes (e.g., mail's local delivery endpoint which
uses `requireLocalhost` instead of auth). CalDAV router (`caldav-router.ts`) uses protocol auth, not
betterAuth — needs a separate guard in `verifyProtocolAuth()` or at the route level.

## Login Screen

### Two-Tab Layout

Modify `packages/ui/src/components/layout/pages/loginpage.tsx`:

**Tab 1: "Sign in"** — existing email/password form, unchanged.

**Tab 2: "Guest"**:
- Text: "Did someone share something with you? Log in with your email address."
- Email input
- "Send code" button → POST /guest-auth/request-otp
- On success: 6-digit OTP input appears (auto-focus) + "Verify" button
- On error: show message ("No shared resources found for this email" / "Use password login")
- On verification success: redirect to `redirect` search param URL or `/drive`

### Topbar Changes

For `user.role === 'guest'`:
- Hide app switcher items except Drive
- Hide admin link
- Notification bell stays (GuestHome has NotificationCenter)

### Sidebar Changes

For guests in Drive app:
- Show "Shared with me" only
- Hide "My files", trash, etc.

Guest should not be able to navigate to mail, contacts, calendar, space, admin apps. The app roots
(`__root.tsx`) should redirect guests to `/drive` if they try.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `apps/api/src/lib/home/guest-home.ts` | Create | GuestHome class |
| `apps/api/src/lib/config/paths.ts` | Modify | Add `getGuestHomePath()` |
| `apps/api/src/lib/home/get-home.ts` | Modify | Route to GuestHome for role=guest |
| `apps/api/src/routes/guest-auth.ts` | Create | request-otp + verify-otp endpoints |
| `apps/api/src/lib/auth/auth.ts` | Modify | Skip org join for guests in hook |
| `apps/api/src/lib/home/home.ts` | Modify | Add `hasCalendar` getter |
| `apps/api/src/lib/core/access.ts` | Modify | Add `requireNonGuest()` |
| `apps/api/src/routes/mail.ts` | Modify | Add guest guard |
| `apps/api/src/routes/contacts.ts` | Modify | Add guest guard |
| `apps/api/src/routes/calendar.ts` | Modify | Add guest guard |
| `apps/api/src/routes/space.ts` | Modify | Add guest guard |
| `apps/api/src/lib/share/reconciliation.ts` | Modify | Calendar null guards |
| `apps/api/src/lib/home/home-relay.ts` | Modify | Calendar null guards |
| `packages/ui/src/components/layout/pages/loginpage.tsx` | Modify | Two-tab layout with guest OTP |
| `packages/ui/src/components/layout/app/topbar.tsx` | Modify | Hide non-guest items |
| Drive app sidebar/root | Modify | Guest restrictions |
