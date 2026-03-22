# ACL Bubbling

> **TLDR**: When a user invites someone to an embedded chat (inside an eigendoc/stickies/slides/sheets), ACL should be
> set on the container document — not on the chat itself. Implemented via a dedicated server-side
> `POST /chat/:ownerId/:mountId/:chatId/invite` endpoint that resolves the container, merges ACL, and calls
> `updateACL` on the container. `Drive.updateACL()` itself is NOT modified.

## Problem

The `/invite` command in chat (`use-chat-room.ts:121-136`) does:

```typescript
const currentAcl = chatPath.acl || [];
const newAcl = [...currentAcl, {id: local.target, read: true, write: true}];
await updateACL.mutateAsync({path: chatPath, acl: newAcl});
```

For an embedded chat, `chatPath` is the `.eigenchat` DrivePath inside the container. This sets ACL on the chat, not the
container document. The invited user can read chat messages but cannot open the document.

## Why NOT Redirect Inside `updateACL()`

Initial idea: add `findACLTarget()` inside `Drive.updateACL()` to silently redirect. **This is dangerous.**

The `PUT /drive/:ownerId/:mountId/path/:pathId/acl` endpoint replaces the entire ACL array. The frontend builds the
array from the current path's ACL:

```typescript
const currentAcl = chatPath.acl || [];    // embedded chat has null ACL (inherited)
const newAcl = [...currentAcl, {id: email, read: true, write: true}];
// newAcl = [{id: email, read: true, write: true}]  ← only the new entry!
```

If `updateACL` silently redirects to the container, it would **replace** the container's ACL with just `[{alice}]` —
dropping all existing entries like `[{bob}, {carol}]`. **Data loss.**

Proper ACL merging requires reading the container's ACL server-side. This belongs in a dedicated endpoint, not in the
generic `updateACL`.

## Solution

### 1. `findContainerPath()` Utility

Walk up the `parentId` chain to find the outermost collab container. Exported from `acl.ts` for reuse.

```typescript
// apps/api/src/lib/drive/acl.ts — new export

import {isCollabType} from '@workspace/lib/types/drive';

export async function findContainerPath(
    getPath: PathGetter,
    startPathId: string
): Promise<DrivePath | null> {
    let currentId: string | null = startPathId;
    let container: DrivePath | null = null;

    while (currentId) {
        const path = await getPath(currentId);
        if (!path) break;
        if (isCollabType(path.type)) {
            container = path;
        }
        currentId = path.parentId;
    }

    return container;
}
```

**Walk example** for `comment-123.eigenchat` inside `my-doc.eigendoc`:

```
comment-123.eigenchat  (type=chat)     → not collab
chat/                  (type=folder)   → not collab
my-doc.eigendoc        (type=doc)      → IS collab → container = this
Projects/              (type=folder)   → not collab
root                   (parentId=null) → stop
→ returns my-doc.eigendoc
```

**Standalone chat** (not inside a container): walk reaches root without finding a collab type → returns `null`.

### 2. `POST /chat/:ownerId/:mountId/:chatId/invite` Endpoint

New route in `apps/api/src/routes/chat.ts`:

```typescript
.post("/chat/:ownerId/:mountId/:chatId/invite", async ({params, body, user}) => {
    const drive = await getSharedDrive(params.ownerId, user);

    // Verify caller can write to the chat
    if (!(await drive.canWrite(params.mountId, params.chatId, user))) {
        throw new ApiError(403, 'No write permission');
    }

    // Validate email
    if (!validateEmailAddress(body.email)) {
        throw new ApiError(400, 'Invalid email address');
    }

    // Find the ACL target: container document if embedded, chat itself if standalone
    const mount = drive.getMount(params.mountId);
    const chatPath = await mount.getPath(params.chatId);
    if (!chatPath) throw new ApiError(404, 'Chat not found');

    const container = await findContainerPath(mount.getPath.bind(mount), chatPath.parentId ?? '');
    const targetPath = container ?? chatPath;

    // Check caller can write to the target
    if (container && !(await drive.canWrite(params.mountId, targetPath.id, user))) {
        throw new ApiError(403, 'No write permission on container document');
    }

    // Merge: read current ACL, check for duplicates, append
    const currentAcl = targetPath.acl || [];
    if (currentAcl.some(a => a.id.toLowerCase() === body.email.toLowerCase())) {
        return {success: true, alreadyHasAccess: true, targetPathId: targetPath.id};
    }

    const newAcl = [...currentAcl, {id: body.email, read: true, write: true}];
    await drive.updateACL(params.mountId, targetPath.id, newAcl);

    return {success: true, alreadyHasAccess: false, targetPathId: targetPath.id};
}, {
    body: t.Object({email: t.String()}),
    auth: true
})
```

**Key behaviors**:

- Standalone chat → `findContainerPath` returns `null` → ACL set on chat itself (preserves current behavior)
- Embedded chat → ACL set on container document (new behavior)
- ACL properly merged with existing entries (no data loss)
- Double-invite returns `alreadyHasAccess: true` (idempotent)

### 3. `Drive.getMount()` Visibility

The route needs `mount.getPath.bind(mount)` for `findContainerPath`. Currently `Drive.getMount()` is private:

```typescript
// apps/api/src/lib/drive/drive.ts
private getMount(mountId: string): Mount { ... }
```

Two options:

**Option A (recommended)**: Add a `findContainerPath` method to `Drive` itself:

```typescript
// apps/api/src/lib/drive/drive.ts — new method
async findContainerPath(mountId: string, pathId: string): Promise<DrivePath | null> {
    const mount = this.getMount(mountId);
    return findContainerPath(mount.getPath.bind(mount), pathId);
}
```

Then the route becomes:

```typescript
const container = await drive.findContainerPath(params.mountId, chatPath.parentId ?? '');
```

**Option B**: Make `getMount` protected. SharedDrive already extends Drive, so it would work. But it exposes internal
API unnecessarily.

### 4. `SharedDrive` Override

Add corresponding method to `SharedDrive`:

```typescript
// apps/api/src/lib/drive/sharedDrive.ts
public async findContainerPath(mountId: string, pathId: string): Promise<DrivePath | null> {
    return this.sharedDrive.findContainerPath(mountId, pathId);
}
```

No permission check needed — `findContainerPath` only reads paths (no mutation). The invite endpoint already checks
write permission before calling `updateACL`.

### 5. Frontend: Update `/invite` Handler

```typescript
// packages/lib/src/core/chat/hooks/use-chat-room.ts — replace lines 121-136

case 'invite': {
    if (!chatPath) return;
    const inviteError = validateEmailTarget(local.target, 'Invite');
    if (inviteError) {
        addLocalMessage(inviteError);
        return;
    }
    try {
        const response = await chatApi({ownerId})({mountId})({chatId}).invite.post({
            email: local.target
        });
        if (response.data?.alreadyHasAccess) {
            addLocalMessage(`${local.target} already has access.`);
        } else {
            addLocalMessage(`You invited ${local.target}.`);
        }
    } catch {
        addLocalMessage(`Failed to invite ${local.target}.`);
    }
    return;
}
```

This replaces `useUpdateACL` usage for invites. The `updateACL` import and hook can stay (used by the share dialog on
documents).

### 6. Treaty API Client

Add the invite endpoint to the Treaty client in `packages/lib/src/core/api.ts`:

```typescript
// Already auto-derived from Elysia route definitions — no manual change needed.
// Treaty infers the type from the chatRouter definition.
```

### 7. Invalidation

The invite endpoint calls `drive.updateACL()` which already:

1. Calls `propagateACLChange()` — updates recipient's `shared.db`
2. Emits `SSEventType.DRIVE_ACL_UPDATED` — triggers SSE

The frontend SSE handler already invalidates drive queries on ACL events. The `/invite` handler should also invalidate
the chat path info:

```typescript
// After successful invite, invalidate chatPath to refresh roomMembers
queryClient.invalidateQueries({queryKey: driveKeys.path(ownerId, mountId, chatId)});
```

This happens automatically if the SSE handler fires — but for the caller's immediate UI, an explicit invalidation after
the `post()` call is better. This can be done via a new `useInviteToChatRoom` mutation hook.

## Complete File Changes

| File | Change |
|------|--------|
| `apps/api/src/lib/drive/acl.ts` | Add `findContainerPath()` export |
| `apps/api/src/lib/drive/drive.ts` | Add `findContainerPath()` method |
| `apps/api/src/lib/drive/sharedDrive.ts` | Add `findContainerPath()` override |
| `apps/api/src/routes/chat.ts` | Add `POST /chat/:ownerId/:mountId/:chatId/invite` |
| `packages/lib/src/core/chat/hooks/use-chat-room.ts` | Replace `/invite` case to call new endpoint |
| `packages/lib/src/core/chat/hooks/use-chat.ts` | Add `useInviteToChat()` mutation hook |

## Edge Cases

| Case | Behavior |
|------|----------|
| Standalone chat (top-level `.eigenchat`) | `findContainerPath` returns `null` → ACL on chat |
| Embedded chat in eigendoc | ACL on eigendoc |
| Embedded chat in eigenstickies | ACL on eigenstickies |
| Chat inside slides/sheets | ACL on eigenslides/eigensheets |
| User already has access | Returns `alreadyHasAccess: true`, no ACL change |
| Caller has chat write but not doc write | 403 — correct, shouldn't invite to doc you can't manage |
| Self-invite | Allowed (harmless, filtered by `filterRedundantACL` if owner) |
| Team chat | Works — team member ACL on container, `filterRedundantACL` strips if redundant |
| Email not a registered user | ACL entry created (consistent with share dialog behavior) |
| Container has `sharingRestricted: true` | `drive.updateACL()` goes through `SharedDrive.updateACL()` which blocks — correct, editors cannot invite when sharing is restricted (see [TODO-RESHARE-PREVENTION.md](TODO-RESHARE-PREVENTION.md)) |

## What This Does NOT Change

- `Drive.updateACL()` — unchanged, still replaces full ACL array on the specified path
- Share dialog — already operates on documents, not embedded chats
- `PUT /drive/:ownerId/:mountId/path/:pathId/acl` — unchanged
- ACL inheritance model — unchanged (additive, parent → child)
