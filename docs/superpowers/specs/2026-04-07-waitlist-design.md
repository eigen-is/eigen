# Waitlist System Design

> Persistent waitlist with admin management, invite-based signup, and email templates.

## Overview

Replace the current fire-and-forget waitlist (email notification only) with a full waitlist system:
database-backed entries, admin UI for reviewing/accepting/rejecting, token-based invite emails,
and a self-service signup page for invited users.

## States

| Status       | Meaning                                      |
|--------------|----------------------------------------------|
| `pending`    | User submitted, awaiting admin review        |
| `invited`    | Admin accepted, invite email sent            |
| `registered` | User created their account via invite link   |
| `rejected`   | Admin rejected the entry                     |

## Database

**File**: `data/server/waitlist.db` (global, not per-home)

**Pattern**: `ManagedDatabase` + Drizzle schema, singleton instance (like server settings).

**Schema** (`apps/api/src/lib/waitlist/schema.ts`):

```
waitlist:
  id              text PK (nanoid)
  email           text NOT NULL UNIQUE
  notes           text NOT NULL DEFAULT ''
  status          text NOT NULL DEFAULT 'pending'
  inviteToken     text UNIQUE (nullable)
  inviteExpiresAt integer/timestamp (nullable)
  invitedAt       integer/timestamp (nullable)
  registeredAt    integer/timestamp (nullable)
  userId          text (nullable) — set when user creates account
  createdAt       integer/timestamp NOT NULL
  updatedAt       integer/timestamp NOT NULL
```

**DB config** (`apps/api/src/lib/waitlist/db-config.ts`): version 1, single migration creates the table.

## Domain Class

**File**: `apps/api/src/lib/waitlist/waitlist.ts`

Singleton instance, opened at server startup (alongside server settings).

| Method                        | Purpose                                                      |
|-------------------------------|--------------------------------------------------------------|
| `submit(email, notes)`        | Insert or update if email exists with status pending/rejected (dedup) |
| `list(status?)`               | Get entries, optionally filtered by status                   |
| `get(id)`                     | Get single entry by id                                       |
| `accept(id)`                  | Generate invite token (nanoid), set status `invited`, set `invitedAt` + `inviteExpiresAt` (7 days), return entry |
| `reject(id)`                  | Set status to `rejected`                                     |
| `validateToken(token)`        | Check token exists, not expired, status is `invited`         |
| `markRegistered(token, userId)` | Set status `registered`, store userId, clear token         |
| `resendInvite(id)`            | Regenerate token + expiry for `invited` entries              |
| `getByToken(token)`           | Fetch entry by invite token                                  |
| `remove(id)`                  | Delete entry permanently                                     |

The existing `waitlist()` function in `apps/api/src/lib/space/waitlist.ts` is removed. The public
route now calls `submit()` on the domain class and still sends the admin notification email if
`notifyEmail` is configured.

## API Routes

### Admin routes (`apps/api/src/routes/waitlist.ts`)

All require auth + admin role. Follow `:ownerId` convention (admin's own userId).

| Method   | Path                                      | Purpose                              |
|----------|-------------------------------------------|--------------------------------------|
| `GET`    | `/waitlist/:ownerId/entries`              | List entries (optional `?status=`)   |
| `PUT`    | `/waitlist/:ownerId/entries/:id/accept`   | Accept + send invite email           |
| `PUT`    | `/waitlist/:ownerId/entries/:id/reject`   | Reject entry                         |
| `PUT`    | `/waitlist/:ownerId/entries/:id/resend`   | Re-send invite (regenerate token)    |
| `DELETE` | `/waitlist/:ownerId/entries/:id`          | Delete entry permanently             |

The `accept` and `resend` endpoints send the invite email using the configured template
via `sendMail()`.

### Public routes (update `apps/api/src/routes/public.ts`)

| Method | Path                         | Purpose                                          |
|--------|------------------------------|--------------------------------------------------|
| `POST` | `/p/waitlist`                | Submit to waitlist (existing — now stores in DB)  |
| `GET`  | `/p/invite/:token`          | Validate invite token for signup page             |
| `POST` | `/p/invite/:token/register` | Create account + log in                           |

### Validate token response

`GET /p/invite/:token` returns:

```typescript
{ valid: true, email: string, orgName: string }   // token is valid
{ valid: false }                                    // invalid or expired
```

Always returns 200 — the signup page uses `valid` to decide what to render.

### Register endpoint flow

1. Validate token (exists, not expired, status is `invited`)
2. Construct email as `username@domain` (same as create-user-dialog)
3. Create user via `auth.api.createUser({ name, email, password, role: 'user' })`
   — triggers `authAddUserToDefaultOrg` + `reconcileSharesForNewUser` automatically
4. Mark waitlist entry as `registered` with the new userId
5. Sign the user in via `auth.api.signInEmail({ body: { email, password } })` which creates a
   session and returns `Set-Cookie` headers
6. Forward the session headers in the response — user is immediately logged in

## Server Settings

Add invite email template to `ServerSettings.onboarding`:

```typescript
inviteEmail: {
    subject: string;   // default: "You're invited to {orgName}"
    body: string;      // default: "Hi!\n\nYou've been invited to join {orgName} at {domain}.\n\n
                       //   Click the link below to create your account:\n{inviteLink}\n\n
                       //   This link expires in 7 days."
};

// Placeholders: {email} (waitlist email), {orgName}, {domain}, {inviteLink}
```

Update `packages/lib/src/types/settings.ts` and `apps/api/src/lib/config/server-settings.ts`
with the new fields and defaults.

## Admin Frontend

### Sidebar (`apps/admin/src/components/admin/admin-sidebar.tsx`)

New "Waitlist" item with `UserPlus` icon, below "Onboarding". Only visible when waitlist is
enabled AND user is owner. The `_auth` route already loads server settings via `useServerSettings()`
— pass `waitlistEnabled` down to the sidebar alongside `isOwner`.

### Route (`apps/admin/src/routes/_auth.waitlist.tsx`)

Two-column layout following the members page pattern:

**Left column**:
- Tab bar: Pending | Invited | Registered | Rejected (using shadcn `Tabs`)
- List of entries per tab, each showing email + notes preview + timestamp
- `SearchBar` for filtering by email
- Click to select → shows detail in right column
- `EmptyState` when no entries for a tab

**Right column (detail pane)**:
- Email, full notes, all timestamps (submitted, invited, registered)
- Status `Badge`
- Actions depending on status:
  - **Pending**: "Accept & Invite" `Button`, "Reject" `Button`
  - **Invited**: "Resend Invite" `Button`, "Reject" `Button`, shows token expiry
  - **Registered**: Read-only, shows linked user info
  - **Rejected**: "Re-accept & Invite" `Button`, "Delete" `Button` (via `DeleteDialog`)

### Onboarding settings update (`apps/admin/src/components/admin/onboarding-settings.tsx`)

New "Invite Email" section between Waitlist toggle and Auto-add admin contact:
- Subject `Input` field
- Body `Textarea` field
- Placeholder reference: `{email}`, `{orgName}`, `{domain}`, `{inviteLink}`

### Hooks (`packages/lib/src/core/admin/hooks/use-waitlist.ts`)

| Hook                          | Type     | Endpoint                          |
|-------------------------------|----------|-----------------------------------|
| `useWaitlistEntries(status?)` | query    | `GET /waitlist/:ownerId/entries`  |
| `useAcceptWaitlistEntry()`    | mutation | `PUT .../accept`                  |
| `useRejectWaitlistEntry()`    | mutation | `PUT .../reject`                  |
| `useResendWaitlistInvite()`   | mutation | `PUT .../resend`                  |
| `useDeleteWaitlistEntry()`    | mutation | `DELETE .../entries/:id`          |

Query keys: `waitlistKeys.all`, `waitlistKeys.status(status)`.

All mutations use `onMutationError` from `api-error.ts`. Accept/resend show success toast
("Invite sent to {email}").

## Signup Page

### Route (`apps/space/src/routes/signup.tsx`)

Public page, no auth required. URL: `/space/signup?token=abc123`

**On load**: `useValidateInviteToken(token)` calls `GET /p/invite/:token`
- Invalid/expired → error state with message
- Valid → signup form showing "You've been invited as **user@gmail.com**"

**Form** (reuses shadcn components + existing patterns from login page and create-user-dialog):
- Name (`Input`)
- Username (`InputGroup` with `@domain` addon suffix)
- Password (`Input` type="password", min 8)
- Confirm password (`Input` type="password")
- Submit `Button`

**Submit**: `POST /p/invite/:token/register` with `{ name, username, password }`
- Success → session cookie set, redirect to `/space/`
- Username taken → inline error
- Token expired → error toast, redirect to landing page

### Hooks (`packages/lib/src/core/auth/hooks/use-invite-signup.ts`)

| Hook                              | Type     | Endpoint                              |
|-----------------------------------|----------|---------------------------------------|
| `useValidateInviteToken(token)`   | query    | `GET /p/invite/:token`               |
| `useInviteRegister(token)`        | mutation | `POST /p/invite/:token/register`     |

## Files

| File                                                          | Action | Purpose                              |
|---------------------------------------------------------------|--------|--------------------------------------|
| `apps/api/src/lib/waitlist/schema.ts`                         | Create | Drizzle schema                       |
| `apps/api/src/lib/waitlist/db-config.ts`                      | Create | ManagedDatabase config               |
| `apps/api/src/lib/waitlist/waitlist.ts`                       | Create | Domain class (singleton)             |
| `apps/api/src/routes/waitlist.ts`                             | Create | Admin API routes                     |
| `apps/api/src/routes/public.ts`                               | Modify | Store in DB, add invite endpoints    |
| `apps/api/src/lib/space/waitlist.ts`                          | Remove | Replaced by domain class             |
| `apps/api/src/app.ts`                                         | Modify | Register waitlist router, init DB    |
| `packages/lib/src/types/settings.ts`                          | Modify | Add inviteEmail to onboarding type   |
| `apps/api/src/lib/config/server-settings.ts`                  | Modify | Add inviteEmail defaults             |
| `packages/lib/src/core/admin/hooks/use-waitlist.ts`           | Create | Admin waitlist hooks                 |
| `packages/lib/src/core/auth/hooks/use-invite-signup.ts`       | Create | Signup page hooks                    |
| `apps/admin/src/routes/_auth.waitlist.tsx`                     | Create | Admin waitlist page                  |
| `apps/admin/src/components/admin/admin-sidebar.tsx`            | Modify | Add Waitlist sidebar item            |
| `apps/admin/src/components/admin/onboarding-settings.tsx`      | Modify | Add invite email template section    |
| `apps/space/src/routes/signup.tsx`                             | Create | Invite signup page                   |
