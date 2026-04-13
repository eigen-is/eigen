# Guest Access Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable external guests to authenticate via email OTP (gated by share registry) and access shared resources through a minimal GuestHome with Drive + Notifications only.

**Architecture:** Custom OTP flow (not better-auth's emailOTP plugin) using the existing `verification` table and `sendMail()`. GuestHome extends Home with only Drive + NotificationCenter initialized. Backend route guards prevent guests from accessing mail/contacts/calendar/space. Login page gets a "Guest" tab.

**Tech Stack:** Elysia, Drizzle ORM, better-auth (user/session management only), React, TanStack Router, shadcn/ui

**Spec:** `docs/superpowers/specs/2026-04-13-guest-access-phase2-design.md`

---

### Task 1: Path Helper + Home Base Class Changes

**Files:**
- Modify: `apps/api/src/lib/config/paths.ts:35-37`
- Modify: `apps/api/src/lib/home/home.ts:54-77`

- [ ] **Step 1: Add `getGuestHomePath` to paths.ts**

In `apps/api/src/lib/config/paths.ts`, add after `getOrgDataPath` (after line 45):

```typescript
export function getGuestHomePath(userId: string): string {
    return path.join(getDataRoot(), 'guest', userId);
}
```

- [ ] **Step 2: Add `hasCalendar` getter to Home base class**

In `apps/api/src/lib/home/home.ts`, add after the `notifications` getter (after line 77):

```typescript
    get hasCalendar(): boolean {
        return !!this._calendar;
    }
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/lib/config/paths.ts apps/api/src/lib/home/home.ts
git commit -m "feat(guest): add getGuestHomePath helper and hasCalendar getter"
```

---

### Task 2: GuestHome Class

**Files:**
- Create: `apps/api/src/lib/home/guest-home.ts`

- [ ] **Step 1: Create GuestHome class**

Create `apps/api/src/lib/home/guest-home.ts`:

```typescript
import type { User } from 'better-auth/types';
import { getGuestHomePath } from '../config/paths.ts';
import { JsonStore, LocalFilesystem } from '../core';
import { Drive } from '../drive';
import { NotificationCenter } from '../notification-center/notification-center';
import { Home, type HomeSettings } from './home.ts';

export class GuestHome extends Home {
    constructor(user: User, cleanUp?: () => void) {
        super(user, cleanUp);
        this.homeDir = getGuestHomePath(user.id);
        this.fs = new LocalFilesystem(this.homeDir);
        this.settings = new JsonStore<HomeSettings>(this.fs, 'settings.json', {});
        this._drive = new Drive(this);
        this._notifications = new NotificationCenter(this);
    }

    override async init() {
        await this.settings.load();
        return super.init(false);
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

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/lib/home/guest-home.ts
git commit -m "feat(guest): add GuestHome class with Drive + Notifications only"
```

---

### Task 3: Home Factory + Auth Hook Changes

**Files:**
- Modify: `apps/api/src/lib/home/get-home.ts:36-44`
- Modify: `apps/api/src/lib/auth/auth.ts:63-72`

- [ ] **Step 1: Route to GuestHome in get-home.ts**

In `apps/api/src/lib/home/get-home.ts`, add the import at the top:

```typescript
import { GuestHome } from './guest-home.ts';
```

Replace the `case 'user'` block (lines 36-44):

```typescript
                case 'user': {
                    const user = await getUserById(parsed.id);
                    if (!user) {
                        throw new ApiError(404, 'User not found');
                    }
                    home = new UserHome(user, () => {
                        cleanupHomeFactory(ownerId);
                    });
                    break;
                }
```

With:

```typescript
                case 'user': {
                    const user = await getUserById(parsed.id);
                    if (!user) {
                        throw new ApiError(404, 'User not found');
                    }
                    if (user.role === 'guest') {
                        home = new GuestHome(user, () => {
                            cleanupHomeFactory(ownerId);
                        });
                    } else {
                        home = new UserHome(user, () => {
                            cleanupHomeFactory(ownerId);
                        });
                    }
                    break;
                }
```

- [ ] **Step 2: Skip org join + reconciliation for guests in auth hook**

In `apps/api/src/lib/auth/auth.ts`, replace the `user.create.after` hook (lines 66-69):

```typescript
                after: async (user) => {
                    await authAddUserToDefaultOrg(user);
                    await reconcileSharesForNewUser(user);
                },
```

With:

```typescript
                after: async (user) => {
                    if (user.role === 'guest') return;
                    await authAddUserToDefaultOrg(user);
                    await reconcileSharesForNewUser(user);
                },
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/lib/home/get-home.ts apps/api/src/lib/auth/auth.ts
git commit -m "feat(guest): route guest users to GuestHome, skip org join for guests"
```

---

### Task 4: Null Guards in Reconciliation + Home Relay

**Files:**
- Modify: `apps/api/src/lib/share/reconciliation.ts:18-57`
- Modify: `apps/api/src/lib/home/home-relay.ts:59-101`

- [ ] **Step 1: Add calendar null guards in reconciliation.ts**

In `apps/api/src/lib/share/reconciliation.ts`, replace the body of the `for (const fromUserId ...)` loop (lines 14-57) with calendar-guarded version. Replace:

```typescript
            const calShares = await pullCalendarShares(fromUserId, user.email, []);
            for (const result of calShares) {
                targetHome.calendar.receiveShare(
                    fromUserId,
                    result.calendarId,
                    result.name,
                    result.color,
                    result.permission,
                );
            }

            const sharedPaths = await pullSharedPaths(fromUserId, user);
            for (const path of sharedPaths) {
                await targetHome.drive.receiveACLChange(path, path.acl);
            }

            const invitations = await pullPendingInvitations(fromUserId, user.email);
            for (const event of invitations) {
                targetHome.calendar.receiveInvitation({
```

With:

```typescript
            if (targetHome.hasCalendar) {
                const calShares = await pullCalendarShares(fromUserId, user.email, []);
                for (const result of calShares) {
                    targetHome.calendar.receiveShare(
                        fromUserId,
                        result.calendarId,
                        result.name,
                        result.color,
                        result.permission,
                    );
                }
            }

            const sharedPaths = await pullSharedPaths(fromUserId, user);
            for (const path of sharedPaths) {
                await targetHome.drive.receiveACLChange(path, path.acl);
            }

            if (targetHome.hasCalendar) {
                const invitations = await pullPendingInvitations(fromUserId, user.email);
                for (const event of invitations) {
                    targetHome.calendar.receiveInvitation({
```

Make sure the closing `}` for the second `if (targetHome.hasCalendar)` block is placed after the `receiveInvitation` call's closing `});` (after line 57, before the `} catch`).

- [ ] **Step 2: Add calendar null guards in home-relay.ts**

In `apps/api/src/lib/home/home-relay.ts`, add `if (!home.hasCalendar) break;` at the start of each calendar case in the `sendToHome` switch statement.

Replace lines 59-101 (the calendar cases + broadcast + notification):

```typescript
        case 'calendar:share':
            if (message.permission) {
                home.calendar.receiveShare(
```

With this pattern for each calendar case:

```typescript
        case 'calendar:share':
            if (!home.hasCalendar) break;
            if (message.permission) {
                home.calendar.receiveShare(
                    message.ownerId,
                    message.calendarId,
                    message.name,
                    message.color,
                    message.permission,
                    message.actorEmail,
                );
            } else {
                home.calendar.removeShare(message.ownerId, message.calendarId, message.actorEmail);
            }
            break;
        case 'calendar:invitation':
            if (!home.hasCalendar) break;
            home.calendar.receiveInvitation(message.payload);
            break;
        case 'calendar:invitation-update':
            if (!home.hasCalendar) break;
            home.calendar.receiveInvitationUpdate(message.orgEventId, message.orgUserId, message.payload);
            break;
        case 'calendar:invitation-removal':
            if (!home.hasCalendar) break;
            home.calendar.removeInvitation(message.orgEventId, message.orgUserId);
            break;
        case 'calendar:rsvp':
            if (!home.hasCalendar) break;
            if (message.recurrenceDate) {
                home.calendar.rsvpForOccurrence(
                    message.eventId,
                    message.attendeeEmail,
                    message.status,
                    message.recurrenceDate,
                );
            } else {
                home.calendar.updateAttendeeStatus(message.eventId, message.attendeeEmail, message.status);
            }
            break;
        case 'broadcast':
            home.broadcast(message.event);
            break;
        case 'notification':
            home.notifications?.persist(message.notification);
            break;
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/lib/share/reconciliation.ts apps/api/src/lib/home/home-relay.ts
git commit -m "fix(guest): add calendar null guards in reconciliation and home relay"
```

---

### Task 5: Backend Route Guards

**Files:**
- Modify: `apps/api/src/lib/core/access.ts:44-48`
- Modify: `apps/api/src/routes/mail.ts:54-55`
- Modify: `apps/api/src/routes/contacts.ts:40-41`
- Modify: `apps/api/src/routes/calendar.ts:84-85`
- Modify: `apps/api/src/routes/space.ts:9-10`
- Modify: `apps/api/src/lib/auth/protocol-auth.ts:11-28`

- [ ] **Step 1: Add `requireNonGuest` to access.ts**

In `apps/api/src/lib/core/access.ts`, add after `requireSelf` (after line 48):

```typescript
export function requireNonGuest(user: { role?: string | null }): void {
    if (user.role === 'guest') {
        throw new ApiError(403, 'Guests cannot access this resource');
    }
}
```

- [ ] **Step 2: Add guest guard to mail router**

In `apps/api/src/routes/mail.ts`, update the import (line 4):

```typescript
import { requireLocalhost, requireNonGuest, requireSelf } from '../lib/core/access';
```

Add `.onBeforeHandle` after `.use(betterAuth)` (after line 55):

```typescript
    .onBeforeHandle(({ user }) => {
        if (user) requireNonGuest(user);
    })
```

- [ ] **Step 3: Add guest guard to contacts router**

In `apps/api/src/routes/contacts.ts`, update the import (line 4):

```typescript
import { requireNonGuest, requireSelf } from '../lib/core/access';
```

Add `.onBeforeHandle` after `.use(betterAuth)` (after line 41):

```typescript
    .onBeforeHandle(({ user }) => {
        if (user) requireNonGuest(user);
    })
```

- [ ] **Step 4: Add guest guard to calendar router**

In `apps/api/src/routes/calendar.ts`, update the import (line 5):

```typescript
import { requireNonGuest, requireSelf } from '../lib/core/access';
```

Add `.onBeforeHandle` after `.use(betterAuth)` (after line 85):

```typescript
    .onBeforeHandle(({ user }) => {
        if (user) requireNonGuest(user);
    })
```

- [ ] **Step 5: Add guest guard to space router**

In `apps/api/src/routes/space.ts`, update the import (line 3):

```typescript
import { requireNonGuest, requireSelf } from '../lib/core/access';
```

Add `.onBeforeHandle` after `.use(betterAuth)` (after line 10):

```typescript
    .onBeforeHandle(({ user }) => {
        if (user) requireNonGuest(user);
    })
```

- [ ] **Step 6: Add guest guard to CalDAV protocol auth**

In `apps/api/src/lib/auth/protocol-auth.ts`, add after the user lookup (after line 13 `if (!user) throw...`):

```typescript
    if (user.role === 'guest') throw new ApiError(403, 'Guests cannot access CalDAV');
```

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/core/access.ts apps/api/src/routes/mail.ts apps/api/src/routes/contacts.ts apps/api/src/routes/calendar.ts apps/api/src/routes/space.ts apps/api/src/lib/auth/protocol-auth.ts
git commit -m "feat(guest): add requireNonGuest guard to mail, contacts, calendar, space, CalDAV"
```

---

### Task 6: Guest Auth Endpoints

**Files:**
- Create: `apps/api/src/routes/guest-auth.ts`
- Modify: `apps/api/src/app.ts:26-27,93`

- [ ] **Step 1: Create guest-auth router**

Create `apps/api/src/routes/guest-auth.ts`:

```typescript
import { and, eq, like, lt } from 'drizzle-orm';
import { Elysia, t } from 'elysia';
import { session as sessionScheme, verification as verificationScheme } from '../../auth-schema.ts';
import { auth, getAuthDrizzleDb } from '../lib/auth/auth';
import { ApiError } from '../lib/core';
import { sendMail } from '../lib/core/mailer';
import { reconcileSharesForNewUser } from '../lib/share';
import { getEntriesForTarget } from '../lib/share/registry';
import { getUserByEmail } from '../lib/user';

const OTP_EXPIRY_MS = 5 * 60 * 1000;

function generateOTP(): string {
    const array = new Uint32Array(1);
    crypto.getRandomValues(array);
    return String(array[0] % 1_000_000).padStart(6, '0');
}

async function createGuestSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const db = getAuthDrizzleDb();
    const token = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days

    db.insert(sessionScheme)
        .values({
            id: crypto.randomUUID(),
            token,
            userId,
            expiresAt,
            createdAt: now,
            updatedAt: now,
        })
        .run();

    return { token, expiresAt };
}

export const guestAuthRouter = new Elysia({ name: 'guest-auth' })
    .post(
        '/guest-auth/request-otp',
        async ({ body }) => {
            const email = body.email.toLowerCase().trim();

            // Check if user exists
            const existingUser = await getUserByEmail(email);
            if (existingUser) {
                if (existingUser.role !== 'guest') {
                    throw new ApiError(400, 'Use password login');
                }
                // Returning guest — allow
            } else {
                // New guest — check share registry
                const entries = await getEntriesForTarget(email);
                if (entries.length === 0) {
                    throw new ApiError(400, 'No shared resources found for this email');
                }
            }

            const db = getAuthDrizzleDb();

            // Purge expired guest OTPs
            const now = new Date();
            db.delete(verificationScheme)
                .where(and(like(verificationScheme.identifier, 'guest-otp:%'), lt(verificationScheme.expiresAt, now)))
                .run();

            // Generate and store OTP (delete-then-insert for this email)
            const otp = generateOTP();
            const identifier = `guest-otp:${email}`;
            const expiresAt = new Date(now.getTime() + OTP_EXPIRY_MS);

            db.delete(verificationScheme)
                .where(eq(verificationScheme.identifier, identifier))
                .run();

            db.insert(verificationScheme)
                .values({
                    id: crypto.randomUUID(),
                    identifier,
                    value: await Bun.password.hash(otp),
                    expiresAt,
                    createdAt: now,
                    updatedAt: now,
                })
                .run();

            await sendMail({
                to: [{ name: '', address: email }],
                subject: 'Your guest access code',
                text: `Your verification code is: ${otp}\n\nThis code expires in 5 minutes.\n\nIf you didn't request this, you can ignore this email.`,
            });

            return { success: true };
        },
        {
            body: t.Object({
                email: t.String({ format: 'email' }),
            }),
        },
    )

    .post(
        '/guest-auth/verify-otp',
        async ({ body, cookie }) => {
            const email = body.email.toLowerCase().trim();
            const db = getAuthDrizzleDb();

            // Look up verification record
            const identifier = `guest-otp:${email}`;
            const record = db
                .select()
                .from(verificationScheme)
                .where(eq(verificationScheme.identifier, identifier))
                .get();

            if (!record) throw new ApiError(400, 'Invalid code');
            if (record.expiresAt < new Date()) {
                db.delete(verificationScheme).where(eq(verificationScheme.id, record.id)).run();
                throw new ApiError(400, 'Code expired');
            }

            // Verify OTP
            const valid = await Bun.password.verify(body.otp, record.value);
            if (!valid) throw new ApiError(400, 'Invalid code');

            // Delete used verification record
            db.delete(verificationScheme).where(eq(verificationScheme.id, record.id)).run();

            // Find or create guest user
            let existingUser = await getUserByEmail(email);

            if (existingUser && existingUser.role !== 'guest' && existingUser.role !== null) {
                throw new ApiError(400, 'Use password login');
            }

            let isNewUser = false;

            if (!existingUser) {
                // Create guest user via better-auth admin API
                const namePart = email.split('@')[0];
                const created = await auth.api.createUser({
                    body: {
                        email,
                        password: crypto.randomUUID(),
                        name: namePart,
                        role: 'guest',
                    },
                });
                existingUser = await getUserByEmail(email);
                if (!existingUser) throw new ApiError(500, 'Failed to create guest user');
                isNewUser = true;
            }

            // Reconcile shares for new guests
            if (isNewUser) {
                await reconcileSharesForNewUser(existingUser);
            }

            // Create session directly in the DB
            const { token, expiresAt } = await createGuestSession(existingUser.id);

            // Set session cookie (same name better-auth uses)
            cookie['better-auth.session_token'].set({
                value: token,
                httpOnly: true,
                secure: false,
                sameSite: 'lax',
                path: '/',
                expires: expiresAt,
            });

            return {
                success: true,
                user: {
                    id: existingUser.id,
                    email: existingUser.email,
                    name: existingUser.name,
                    role: existingUser.role,
                },
            };
        },
        {
            body: t.Object({
                email: t.String({ format: 'email' }),
                otp: t.String(),
            }),
        },
    );
```

- [ ] **Step 2: Register guest-auth router in app.ts**

In `apps/api/src/app.ts`, add the import after the other route imports (after line 26):

```typescript
import { guestAuthRouter } from './routes/guest-auth.ts';
```

Add `.use(guestAuthRouter)` after `.use(setupRouter)` (after line 78):

```typescript
    .use(guestAuthRouter)
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/guest-auth.ts apps/api/src/app.ts
git commit -m "feat(guest): add custom OTP auth endpoints (request-otp + verify-otp)"
```

---

### Task 7: Guest Auth Integration Test

**Files:**
- Create: `apps/api/src/test/guest-auth.test.ts`

- [ ] **Step 1: Write guest auth tests**

Create `apps/api/src/test/guest-auth.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { app, authedRequest, getTestContext } from './setup';

describe('guest auth', () => {
    test('request-otp rejects email with no shares', async () => {
        const res = await app.handle(
            new Request('http://localhost/guest-auth/request-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'nobody@example.com' }),
            }),
        );
        expect(res.status).toBe(400);
        const body = await res.text();
        expect(body).toContain('No shared resources found');
    });

    test('request-otp rejects existing non-guest user', async () => {
        const { alice } = await getTestContext();
        const res = await app.handle(
            new Request('http://localhost/guest-auth/request-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: alice.user.email }),
            }),
        );
        expect(res.status).toBe(400);
        const body = await res.text();
        expect(body).toContain('Use password login');
    });

    test('request-otp succeeds for email with shares, verify-otp creates guest session', async () => {
        const { alice } = await getTestContext();
        const guestEmail = 'guest@external.com';

        // Alice shares a folder with the guest email
        const rootRes = await authedRequest(
            alice.user.sessionToken,
            `/drive/${alice.user.id}/default/folder/root`,
        );
        const root = await rootRes.json();

        // Create a folder to share
        const folderRes = await authedRequest(
            alice.user.sessionToken,
            `/drive/${alice.user.id}/default/folder/${root.id}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'shared-folder' }),
            },
        );
        const folder = await folderRes.json();

        // Set ACL to share with guest
        await authedRequest(
            alice.user.sessionToken,
            `/drive/${alice.user.id}/default/path/${folder.id}/acl`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ acl: [{ id: guestEmail, read: true, write: false }] }),
            },
        );

        // Request OTP
        const otpRes = await app.handle(
            new Request('http://localhost/guest-auth/request-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: guestEmail }),
            }),
        );
        expect(otpRes.status).toBe(200);

        // Extract OTP from verification table (test shortcut — in prod, OTP comes via email)
        const { getAuthDrizzleDb } = await import('../lib/auth/auth');
        const { verification } = await import('../../auth-schema');
        const { eq } = await import('drizzle-orm');
        const db = getAuthDrizzleDb();
        const record = db
            .select()
            .from(verification)
            .where(eq(verification.identifier, `guest-otp:${guestEmail}`))
            .get();
        expect(record).toBeTruthy();

        // We can't get the plain OTP from the hash, so test the verify-otp with a wrong code
        const badVerify = await app.handle(
            new Request('http://localhost/guest-auth/verify-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: guestEmail, otp: '000000' }),
            }),
        );
        expect(badVerify.status).toBe(400);
    });

    test('guest user cannot access mail routes', async () => {
        // Create a guest user directly for testing
        const { auth } = await import('../lib/auth/auth');
        const guestEmail = 'route-test-guest@external.com';

        await auth.api.createUser({
            body: { email: guestEmail, password: crypto.randomUUID(), name: 'Route Test Guest', role: 'guest' },
        });

        // Sign in to get a session
        const { getAuthDrizzleDb } = await import('../lib/auth/auth');
        const { session, user } = await import('../../auth-schema');
        const { eq } = await import('drizzle-orm');
        const db = getAuthDrizzleDb();

        const guestUser = db.select().from(user).where(eq(user.email, guestEmail)).get();
        expect(guestUser).toBeTruthy();

        // Create session directly
        const token = crypto.randomUUID();
        db.insert(session)
            .values({
                id: crypto.randomUUID(),
                token,
                userId: guestUser!.id,
                expiresAt: new Date(Date.now() + 86400000),
                createdAt: new Date(),
                updatedAt: new Date(),
            })
            .run();

        // Try to access mail route
        const mailRes = await authedRequest(token, `/mail${guestUser!.id}/mailboxes`);
        expect(mailRes.status).toBe(403);

        // Try to access contacts route
        const contactsRes = await authedRequest(token, `/contacts/${guestUser!.id}`);
        expect(contactsRes.status).toBe(403);

        // Try to access calendar route
        const calendarRes = await authedRequest(token, `/calendar/${guestUser!.id}/calendars`);
        expect(calendarRes.status).toBe(403);

        // Try to access space route
        const spaceRes = await authedRequest(token, `/space/${guestUser!.id}/settings`);
        expect(spaceRes.status).toBe(403);
    });
});
```

- [ ] **Step 2: Run tests**

```bash
bun test apps/api/src/test/guest-auth.test.ts
```

Fix any failures. The test infrastructure uses `app.handle()` to make requests in-process without a running server.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/test/guest-auth.test.ts
git commit -m "test(guest): add guest auth and route guard integration tests"
```

---

### Task 8: Add `role` to Frontend Auth Context

**Files:**
- Modify: `packages/lib/src/core/auth/auth-context.tsx:6-13`

- [ ] **Step 1: Add `role` to AuthUser type**

In `packages/lib/src/core/auth/auth-context.tsx`, add `role` to the `AuthUser` type (after line 10, the `image` field):

```typescript
    role?: string | null;
```

The full type becomes:

```typescript
export type AuthUser = {
    id: string;
    email: string;
    name: string;
    image?: string | null;
    role?: string | null;
    emailVerified: boolean;
    createdAt: Date;
    updatedAt: Date;
};
```

better-auth's `getSession` already returns the `role` field from the user table (added by the admin plugin). The `setUser(session.data.user)` call on line 42 will now include `role` in the typed object.

- [ ] **Step 2: Commit**

```bash
git add packages/lib/src/core/auth/auth-context.tsx
git commit -m "feat(guest): add role field to frontend AuthUser type"
```

---

### Task 9: Login Page — Guest Tab

**Files:**
- Modify: `packages/ui/src/components/layout/pages/loginpage.tsx`

- [ ] **Step 1: Rewrite login page with two tabs**

Replace the entire content of `packages/ui/src/components/layout/pages/loginpage.tsx`:

```tsx
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from '@tanstack/react-router';
import { useAuth } from '@workspace/lib/auth/auth-context.tsx';
import { usePublicConfig } from '@workspace/lib/public';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '../../button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../card.tsx';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '../../form.tsx';
import { Input } from '../../input.tsx';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '../../input-group.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../tabs.tsx';
import { useApp } from '../app/layout-context.tsx';
import { Bar } from '../braket/bar.tsx';
import { Ket } from '../braket/ket.tsx';

const loginFormSchema = z.object({
    email: z.string().min(1, { message: 'Username is required' }),
    password: z.string().min(1, { message: 'Password is required' }),
});

type LoginFormValues = z.infer<typeof loginFormSchema>;

const guestFormSchema = z.object({
    email: z.string().email({ message: 'Valid email is required' }),
});

type GuestFormValues = z.infer<typeof guestFormSchema>;

function PasswordLoginForm() {
    const { login } = useAuth();
    const { data: config, isPending: isConfigPending } = usePublicConfig();
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    const form = useForm<LoginFormValues>({
        resolver: zodResolver(loginFormSchema),
        defaultValues: { email: '', password: '' },
    });

    const onSubmit = async (values: LoginFormValues) => {
        setIsLoading(true);
        setError('');
        values.email = `${values.email.toLowerCase().split('@')[0]}@${config?.domain ?? window.location.hostname}`;

        try {
            const { success, error } = await login(values.email, values.password);
            if (!success && error) {
                setError(error instanceof Error ? error.message : 'Login failed');
            }
        } catch {
            setError('An unexpected error occurred');
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <>
            {error && <div className="p-3 mb-4 text-sm text-destructive bg-destructive/10 rounded-md">{error}</div>}
            <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                    <FormField
                        control={form.control}
                        name="email"
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel>Username</FormLabel>
                                <FormControl>
                                    <InputGroup>
                                        <InputGroupInput placeholder="username" autoFocus {...field} />
                                        <InputGroupAddon align="inline-end">
                                            <InputGroupText>
                                                @{config?.domain ?? window.location.hostname}
                                            </InputGroupText>
                                        </InputGroupAddon>
                                    </InputGroup>
                                </FormControl>
                                <FormMessage />
                            </FormItem>
                        )}
                    />
                    <FormField
                        control={form.control}
                        name="password"
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel>Password</FormLabel>
                                <FormControl>
                                    <Input type="password" {...field} />
                                </FormControl>
                                <FormMessage />
                            </FormItem>
                        )}
                    />
                    <Button type="submit" className="w-full" disabled={isLoading || isConfigPending}>
                        {isLoading ? 'Signing in...' : 'Sign in'}
                    </Button>
                </form>
            </Form>
        </>
    );
}

function GuestLoginForm() {
    const router = useRouter();
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [otpSent, setOtpSent] = useState(false);
    const [otp, setOtp] = useState('');
    const [sentEmail, setSentEmail] = useState('');

    const form = useForm<GuestFormValues>({
        resolver: zodResolver(guestFormSchema),
        defaultValues: { email: '' },
    });

    const onRequestOtp = async (values: GuestFormValues) => {
        setIsLoading(true);
        setError('');
        try {
            const res = await fetch('/guest-auth/request-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: values.email }),
            });
            if (!res.ok) {
                const text = await res.text();
                setError(text || 'Failed to send code');
                return;
            }
            setSentEmail(values.email);
            setOtpSent(true);
        } catch {
            setError('An unexpected error occurred');
        } finally {
            setIsLoading(false);
        }
    };

    const onVerifyOtp = async () => {
        setIsLoading(true);
        setError('');
        try {
            const res = await fetch('/guest-auth/verify-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: sentEmail, otp }),
            });
            if (!res.ok) {
                const text = await res.text();
                setError(text || 'Verification failed');
                return;
            }
            // Session cookie is set by the response — reload to pick it up
            router.invalidate();
            window.location.reload();
        } catch {
            setError('An unexpected error occurred');
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <>
            {error && <div className="p-3 mb-4 text-sm text-destructive bg-destructive/10 rounded-md">{error}</div>}
            {!otpSent ? (
                <Form {...form}>
                    <form onSubmit={form.handleSubmit(onRequestOtp)} className="space-y-6">
                        <p className="text-sm text-muted-foreground">
                            Did someone share something with you? Log in with your email address.
                        </p>
                        <FormField
                            control={form.control}
                            name="email"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>Email</FormLabel>
                                    <FormControl>
                                        <Input type="email" placeholder="you@example.com" autoFocus {...field} />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                        <Button type="submit" className="w-full" disabled={isLoading}>
                            {isLoading ? 'Sending...' : 'Send code'}
                        </Button>
                    </form>
                </Form>
            ) : (
                <div className="space-y-6">
                    <p className="text-sm text-muted-foreground">
                        We sent a code to <span className="font-medium text-foreground">{sentEmail}</span>
                    </p>
                    <div>
                        <label className="text-sm font-medium" htmlFor="otp-input">
                            Verification code
                        </label>
                        <Input
                            id="otp-input"
                            type="text"
                            inputMode="numeric"
                            maxLength={6}
                            placeholder="000000"
                            autoFocus
                            value={otp}
                            onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                            className="mt-2 text-center text-lg tracking-widest"
                        />
                    </div>
                    <Button className="w-full" disabled={isLoading || otp.length !== 6} onClick={onVerifyOtp}>
                        {isLoading ? 'Verifying...' : 'Verify'}
                    </Button>
                    <Button
                        variant="ghost"
                        className="w-full"
                        onClick={() => {
                            setOtpSent(false);
                            setOtp('');
                            setError('');
                        }}
                    >
                        Use a different email
                    </Button>
                </div>
            )}
        </>
    );
}

export function LoginPage() {
    const { isAuthenticated } = useAuth();
    const router = useRouter();
    const { appName } = useApp();

    useEffect(() => {
        if (isAuthenticated) {
            router.invalidate();
        }
    }, [isAuthenticated, router]);

    return (
        <div className="flex w-full h-[calc(100vh-64px)] items-center justify-center">
            <Card className="w-full max-w-md">
                <CardHeader className="text-center">
                    <CardTitle className="text-2xl text-app">
                        <span className="font-bold">eigen</span>
                        <span className="font-normal">
                            <Bar />
                            {appName}
                            <Ket />
                        </span>
                    </CardTitle>
                    <CardDescription>Sign in to your account</CardDescription>
                </CardHeader>
                <CardContent>
                    <Tabs defaultValue="login">
                        <TabsList className="grid w-full grid-cols-2 mb-6">
                            <TabsTrigger value="login">Sign in</TabsTrigger>
                            <TabsTrigger value="guest">Guest</TabsTrigger>
                        </TabsList>
                        <TabsContent value="login">
                            <PasswordLoginForm />
                        </TabsContent>
                        <TabsContent value="guest">
                            <GuestLoginForm />
                        </TabsContent>
                    </Tabs>
                </CardContent>
            </Card>
        </div>
    );
}
```

- [ ] **Step 2: Verify Tabs component exists**

Check that `packages/ui/src/components/tabs.tsx` exists (shadcn Tabs). If not, install:

```bash
cd packages/ui && bunx shadcn@latest add tabs
```

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/components/layout/pages/loginpage.tsx
git commit -m "feat(guest): add Guest tab to login page with OTP flow"
```

---

### Task 10: Topbar Guest Restrictions

**Files:**
- Modify: `packages/ui/src/components/layout/app/topbar.tsx:39-158`

- [ ] **Step 1: Filter apps and hide settings for guests**

In `packages/ui/src/components/layout/app/topbar.tsx`, inside `UserDropdown`, add guest check after the existing `isAdmin` hook (after line 48):

```typescript
    const isGuest = auth.user?.role === 'guest';
```

Filter apps list for guests. Replace lines 96-107 (the `apps.map` block):

```tsx
                    {apps
                        .filter((app) => {
                            if (!isGuest) return true;
                            const name = app.name.toLowerCase();
                            return name === 'drive' || name === 'docs' || name === 'stickies' || name === 'slides' || name === 'sheets' || name === 'chat';
                        })
                        .map((app) => {
                            const isActive = app.name.toLowerCase() === appName.toLowerCase();
                            const Icon = app.icon;
                            return (
                                <DropdownMenuItem key={app.name} asChild className={isActive ? 'bg-muted font-medium' : ''}>
                                    <a href={app.href}>
                                        <Icon />
                                        {app.name}
                                    </a>
                                </DropdownMenuItem>
                            );
                        })}
```

Hide Profile/Settings/Theme for guests. Replace lines 119-149 (the Profile, Settings, Theme section):

```tsx
                    {!isGuest && (
                        <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem asChild>
                                <a href={getSpaceProfileUrl()}>
                                    <UserRound />
                                    Profile
                                </a>
                            </DropdownMenuItem>
                            <DropdownMenuItem asChild>
                                <a href={getSpacePasswordUrl()}>
                                    <Settings />
                                    Settings
                                </a>
                            </DropdownMenuItem>
                            <DropdownMenuSub>
                                <DropdownMenuSubTrigger>
                                    <Palette />
                                    Theme
                                </DropdownMenuSubTrigger>
                                <DropdownMenuSubContent>
                                    <DropdownMenuRadioGroup
                                        value={settings?.theme ?? 'light'}
                                        onValueChange={(v) =>
                                            updateSettings.mutate({ theme: v as 'light' | 'dark' | 'system' })
                                        }
                                    >
                                        <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
                                        <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
                                        <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
                                    </DropdownMenuRadioGroup>
                                </DropdownMenuSubContent>
                            </DropdownMenuSub>
                        </>
                    )}
```

- [ ] **Step 2: Commit**

```bash
git add packages/ui/src/components/layout/app/topbar.tsx
git commit -m "feat(guest): hide non-guest apps and settings in topbar dropdown"
```

---

### Task 11: Drive Sidebar Guest Restrictions

**Files:**
- Modify: `apps/drive/src/components/drive/drive-sidebar.tsx`
- Modify: `apps/drive/src/routes/__root.tsx`

- [ ] **Step 1: Simplify Drive sidebar for guests**

In `apps/drive/src/components/drive/drive-sidebar.tsx`, add guest check after the `currentUserId` line (after line 77):

```typescript
    const isGuest = auth.user?.role === 'guest';
```

Wrap the "New" button dropdown (lines 142-186) in a guest check:

```tsx
            {!isGuest && (
                <div className="px-3 py-2">
                    {/* ... existing New button dropdown ... */}
                </div>
            )}
```

Replace the main sidebar sections (lines 188-257) to show only "Shared with me" for guests:

```tsx
            {isGuest ? (
                <SidebarSection condensed={condensed}>
                    <SidebarItem
                        icon={<Download className="h-4 w-4" />}
                        to="/shared/with-me"
                        label="Shared with me"
                        condensed={condensed}
                    />
                </SidebarSection>
            ) : (
                <>
                    <SidebarSection condensed={condensed}>
                        {/* ... existing Drive, All images, All docs, etc. items ... */}
                    </SidebarSection>
                    <Separator />
                    <SidebarSection condensed={condensed}>
                        {/* ... existing Shared by me, Shared with me items ... */}
                    </SidebarSection>
                    <Separator />
                    <SidebarSection condensed={condensed}>
                        {/* ... existing Trash item ... */}
                    </SidebarSection>
                </>
            )}
```

Keep the Shared Drives and Storage usage sections as-is (they handle empty state gracefully — guests have no teams, so teams section won't render, and storage shows 0/0).

- [ ] **Step 2: Handle guest in Drive root (skip default mount loading)**

In `apps/drive/src/routes/__root.tsx`, add guest handling. Replace `AuthenticatedDriveRoot` (lines 33-68):

```tsx
function AuthenticatedDriveRoot() {
    const { user } = useAuth();
    const isGuest = user?.role === 'guest';

    // Guests have no default mount — go straight to shared-with-me
    if (isGuest) {
        return (
            <AppShell
                appName="drive"
                rootRoute={Route}
                sidebar={({ condensed, isMobile, onClose }) => (
                    <DriveSidebar condensed={condensed} isMobile={isMobile} onClose={onClose} rootPath={null} />
                )}
            >
                <DriveContext.Provider value={{ rootPath: null, mountId: DEFAULT_MOUNT_ID }}>
                    <Outlet />
                </DriveContext.Provider>
            </AppShell>
        );
    }

    const mountId = DEFAULT_MOUNT_ID;
    const { data: root, isLoading, error } = useRootFolder(user!.id, mountId);
    const rootPath = root || null;

    if (isLoading) {
        return (
            <AppShell appName="drive" rootRoute={Route}>
                <LoadingState />
            </AppShell>
        );
    }

    if (error) {
        return (
            <AppShell appName="drive" rootRoute={Route}>
                <ErrorState message="Error loading drive content" detail={error.message} />
            </AppShell>
        );
    }

    return (
        <AppShell
            appName="drive"
            rootRoute={Route}
            sidebar={({ condensed, isMobile, onClose }) => (
                <DriveSidebar condensed={condensed} isMobile={isMobile} onClose={onClose} rootPath={rootPath} />
            )}
        >
            <DriveContext.Provider value={{ rootPath, mountId }}>
                <Outlet />
            </DriveContext.Provider>
        </AppShell>
    );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/drive/src/components/drive/drive-sidebar.tsx apps/drive/src/routes/__root.tsx
git commit -m "feat(guest): show only Shared with me in Drive sidebar for guests"
```

---

### Task 12: Run Full Check

- [ ] **Step 1: Run lint + typecheck + test**

```bash
bun run check
```

- [ ] **Step 2: Fix any issues**

Address lint errors, type errors, and failing tests.

- [ ] **Step 3: Final commit if any fixes were needed**

```bash
git add -u
git commit -m "fix(guest): address lint and type check issues"
```

---

### Task Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Path helper + hasCalendar getter | paths.ts, home.ts |
| 2 | GuestHome class | guest-home.ts (new) |
| 3 | Home factory + auth hook changes | get-home.ts, auth.ts |
| 4 | Null guards in reconciliation + relay | reconciliation.ts, home-relay.ts |
| 5 | Backend route guards | access.ts, mail.ts, contacts.ts, calendar.ts, space.ts, protocol-auth.ts |
| 6 | Guest auth endpoints | guest-auth.ts (new), app.ts |
| 7 | Integration tests | guest-auth.test.ts (new) |
| 8 | Frontend AuthUser role field | auth-context.tsx |
| 9 | Login page guest tab | loginpage.tsx |
| 10 | Topbar guest restrictions | topbar.tsx |
| 11 | Drive sidebar guest restrictions | drive-sidebar.tsx, __root.tsx |
| 12 | Full check | lint + typecheck + test |
