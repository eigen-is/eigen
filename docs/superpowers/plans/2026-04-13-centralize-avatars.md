# Centralize User Avatars Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move user avatars to server-level storage (`data/server/avatars/`) so public avatar serving doesn't require `getHome()`, and make all Home → server profile updates go through `home-relay.ts`.

**Architecture:** Add `pushUserProfile()` to `home-relay.ts` as the single Home → server seam for profile updates (name + avatar). The public endpoint reads directly from `data/server/avatars/{userId}.webp`. Remove `pullAvatarFile()` from the relay entirely.

**Tech Stack:** Bun filesystem APIs, Elysia routes, existing `getServerDataPath()` utility.

**Spec:** `docs/superpowers/specs/2026-04-13-centralize-avatars-design.md`

---

### Task 1: Add `pushUserProfile()` to home-relay

**Files:**
- Modify: `apps/api/src/lib/home/home-relay.ts:140-148`
- Modify: `apps/api/src/lib/config/paths.ts:19-25`

- [ ] **Step 1: Add `getAvatarsDir()` helper to paths.ts**

Add a helper that returns the server avatars directory path, creating it lazily:

```typescript
// In apps/api/src/lib/config/paths.ts, add after getServerDataPath():

export function getAvatarsDir(): string {
    const avatarsDir = path.join(getDataRoot(), 'server', 'avatars');
    if (!fs.existsSync(avatarsDir)) {
        fs.mkdirSync(avatarsDir, { recursive: true });
    }
    return avatarsDir;
}
```

- [ ] **Step 2: Add `pushUserProfile()` to home-relay.ts**

Replace the `pullAvatarFile()` function (lines 140-148) with `pushUserProfile()`. This is the Home → server seam for profile updates:

```typescript
// Replace lines 140-148 in home-relay.ts with:

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAvatarsDir } from '../config/paths';
import { updateUser } from '../user/';

/**
 * Home → server: sync public profile (name + avatar).
 * Today this is a direct in-process call. In a sharded deployment,
 * this becomes an RPC to the central server.
 */
export async function pushUserProfile(userId: string, name: string, avatarWebP: Buffer | null): Promise<void> {
    const avatarPath = path.join(getAvatarsDir(), `${userId}.webp`);

    if (avatarWebP) {
        await Bun.write(avatarPath, avatarWebP);
    } else if (fs.existsSync(avatarPath)) {
        fs.unlinkSync(avatarPath);
    }

    await updateUser(userId, name, avatarWebP ? `server/avatars/${userId}.webp` : '');
}
```

Note: `updateUser` currently takes `(me: User, name, image)` but only uses `me.id`. We'll simplify it to take `userId` directly in Task 2.

- [ ] **Step 3: Remove the `BunFile` import if no longer needed**

Check the remaining imports in `home-relay.ts`. `pullAvatarFile` was the only function returning `BunFile`. If no other function uses it, remove `type { BunFile } from 'bun'` from the imports.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/lib/home/home-relay.ts apps/api/src/lib/config/paths.ts
git commit -m "feat(relay): add pushUserProfile for Home→server avatar sync, remove pullAvatarFile"
```

---

### Task 2: Update `updateUser()` to accept userId instead of User object

**Files:**
- Modify: `apps/api/src/lib/user/user.ts:16-19`

- [ ] **Step 1: Simplify `updateUser` signature**

Change `updateUser` to accept `userId: string` instead of `me: User`, since that's all it uses:

```typescript
// In apps/api/src/lib/user/user.ts, replace lines 16-19:

export async function updateUser(userId: string, name: string, image: string) {
    const db = getAuthDrizzleDb();
    return await db.update(user).set({ name, image }).where(eq(user.id, userId));
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/lib/user/user.ts
git commit -m "refactor(user): simplify updateUser to accept userId string"
```

---

### Task 3: Update `Contacts.updateContact()` to use `pushUserProfile()`

**Files:**
- Modify: `apps/api/src/lib/contacts/contacts.ts:164-170`

- [ ] **Step 1: Replace `updateUser()` call with `pushUserProfile()`**

In `updateContact()`, when editing yourself, read the avatar file from home-local storage and call `pushUserProfile()` instead of `updateUser()` directly:

```typescript
// In apps/api/src/lib/contacts/contacts.ts

// Replace import:
//   import { getOrgOwner, updateUser } from '../user/';
// with:
import { getOrgOwner } from '../user/';
import { pushUserProfile } from '../home/home-relay';

// Replace lines 164-170 (inside updateContact) with:
    public async updateContact(id: string, contact: Omit<Contact, 'id'>) {
        if (await this.you(id)) {
            const name = `${contact.firstName} ${contact.lastName}`;
            let avatarBuffer: Buffer | null = null;

            if (contact.avatar) {
                const filename = contact.avatar.split('/').pop();
                if (filename) {
                    const data = await this.downloadAvatar(filename);
                    if (data) avatarBuffer = Buffer.from(data);
                }
            }

            await pushUserProfile(this.home.user.id, name, avatarBuffer);

            if (!contact.email.includes(this.home.user.email)) {
                contact.email = [this.home.user.email, ...contact.email];
            }
        }
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/lib/contacts/contacts.ts
git commit -m "feat(contacts): route self-profile updates through pushUserProfile relay"
```

---

### Task 4: Update public avatar serving to read from server storage

**Files:**
- Modify: `apps/api/src/lib/space/public.ts:51-59`

- [ ] **Step 1: Rewrite `getAvatarByEmailOrId()` to read from server storage**

Replace the current implementation that uses `pullAvatarFile()` with direct server-level file access:

```typescript
// In apps/api/src/lib/space/public.ts

// Replace import:
//   import { pullAvatarFile } from '../home/home-relay';
// with:
import * as path from 'node:path';
import { getAvatarsDir } from '../config/paths';

// Replace lines 51-59 (getAvatarByEmailOrId) with:

export async function getAvatarByEmailOrId(emailOrId: string): Promise<BunFile | null> {
    const parsed = parseOwnerId(emailOrId);
    let userId: string;

    if (parsed.type === 'team') {
        // Teams don't have server-level avatars (yet)
        return null;
    }

    const user = await getUserByEmailOrId(emailOrId);
    if (!user) return null;
    userId = user.id;

    const file = Bun.file(path.join(getAvatarsDir(), `${userId}.webp`));
    return (await file.exists()) ? file : null;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/lib/space/public.ts
git commit -m "feat(public): serve avatars from server storage instead of Home"
```

---

### Task 5: Write tests

**Files:**
- Modify: `apps/api/src/test/public.test.ts`

- [ ] **Step 1: Add test for avatar upload → public serving round-trip**

Add a test that uploads an avatar for a user's own contact, then verifies it's served from the public endpoint as WebP (not the fallback SVG):

```typescript
// Add to the '/p/avatar/:emailOrId' describe block in public.test.ts:

test('returns uploaded avatar as WebP after profile update', async () => {
    // Create a small test image (1x1 red PNG)
    const pngBytes = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
        0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8,
        0xcf, 0xc0, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, 0x33, 0x00, 0x00, 0x00,
        0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    const file = new File([pngBytes], 'test-avatar.png', { type: 'image/png' });

    // Upload avatar via contacts route
    const formData = new FormData();
    formData.append('file', file);
    const uploadRes = await authedRequest(
        ctx.bob.user.sessionToken,
        `/contacts/${ctx.bob.user.id}/avatar`,
        { method: 'POST', body: formData },
    );
    expect(uploadRes.status).toBe(200);
    const avatarPath = await uploadRes.text();

    // Get bob's "me" contact to update it with the avatar
    const meRes = await authedRequest(ctx.bob.user.sessionToken, `/contacts/${ctx.bob.user.id}/me`);
    const meContact = (await meRes.json()) as { id: string; firstName: string; lastName: string; email: string[] };

    // Update contact with avatar (triggers pushUserProfile)
    await authedRequest(ctx.bob.user.sessionToken, `/contacts/${ctx.bob.user.id}/contacts/${meContact.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            ...meContact,
            avatar: avatarPath,
            labels: [],
        }),
    });

    // Public avatar endpoint should now return WebP
    const avatarRes = await ctx.app.handle(new Request(`http://localhost/p/avatar/${ctx.bob.user.id}`));
    expect(avatarRes.status).toBe(200);
    expect(avatarRes.headers.get('Content-Type')).toBe('image/webp');
});

test('returns fallback SVG after avatar removal', async () => {
    // Get bob's "me" contact
    const meRes = await authedRequest(ctx.bob.user.sessionToken, `/contacts/${ctx.bob.user.id}/me`);
    const meContact = (await meRes.json()) as { id: string; firstName: string; lastName: string; email: string[] };

    // Update contact with empty avatar (triggers deletion)
    await authedRequest(ctx.bob.user.sessionToken, `/contacts/${ctx.bob.user.id}/contacts/${meContact.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            ...meContact,
            avatar: '',
            labels: [],
        }),
    });

    // Public avatar endpoint should return fallback SVG
    const avatarRes = await ctx.app.handle(new Request(`http://localhost/p/avatar/${ctx.bob.user.id}`));
    expect(avatarRes.status).toBe(200);
    expect(avatarRes.headers.get('Content-Type')).toBe('image/svg+xml');
});
```

- [ ] **Step 2: Add `authedRequest` import if not already present**

Ensure the test file imports `authedRequest` from setup:

```typescript
import { assertJson, authedRequest, getTestContext } from './setup';
```

- [ ] **Step 3: Run tests**

```bash
bun test apps/api/src/test/public.test.ts
```

Expected: all tests pass, including the two new ones.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/test/public.test.ts
git commit -m "test(public): add avatar upload→serve round-trip and removal tests"
```

---

### Task 6: Run full check and clean up

- [ ] **Step 1: Run `bun run check`**

```bash
bun run check
```

Expected: lint + typecheck + all tests pass.

- [ ] **Step 2: Verify no remaining references to `pullAvatarFile`**

Search the codebase for any lingering imports or calls:

```bash
grep -r "pullAvatarFile" apps/api/src/
```

Expected: no matches.

- [ ] **Step 3: Commit any cleanup**

If any lint/type fixes were needed, commit them:

```bash
git commit -m "chore: cleanup after avatar centralization"
```
