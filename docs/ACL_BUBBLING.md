# ACL Bubbling

> **TLDR**: When inviting someone to an embedded chat (inside an eigendoc/stickies/slides/sheets), ACL is set on the
> container document — not on the chat itself. A dedicated `POST /chat/:ownerId/:mountId/:chatId/invite` endpoint
> resolves the outermost container via `findContainerPath()`, merges the new ACL entry server-side, and delegates to
> `Drive.inviteToChat()`. The generic `Drive.updateACL()` is not involved.

## Why Not Set ACL on the Chat Directly

The generic `PUT /drive/.../acl` endpoint replaces the entire ACL array. The frontend builds that array from the
current path's ACL. An embedded chat typically has no direct ACL (it inherits from the container), so the built array
would contain only the new entry — overwriting the container's existing ACL entries. Server-side resolution and merging
avoids this data loss.

## findContainerPath()

**File**: `apps/api/src/lib/drive/acl.ts`

Walks the `parentId` chain upward from a starting path. Returns the outermost `DrivePath` whose MIME type is a collab
type (eigendoc, eigenstickies, eigenslides, eigensheets), or `null` if none is found (standalone chat).

```
chat/General.eigenchat  → not collab
my-doc.eigendoc         → IS collab → container
Projects/               → folder
root                    → stop
→ returns my-doc.eigendoc
```

Used by `ChatRoom.init()` and `Drive.inviteToChat()`.

## Invite Endpoint

```
POST /chat/:ownerId/:mountId/:chatId/invite
Body: { email: string }
Returns: { alreadyHasAccess: boolean, targetPathId: string }
```

Route in `apps/api/src/routes/chat.ts`. Delegates to `drive.inviteToChat(mountId, chatId, email)`.

### Drive.inviteToChat()

**File**: `apps/api/src/lib/drive/drive.ts`

1. Finds the chat path
2. Calls `findContainerPath()` to locate the outermost container
3. If embedded: sets ACL on the container document
4. If standalone: sets ACL on the chat itself
5. Lowercases the email before adding to ACL
6. Returns `{ alreadyHasAccess, targetPathId }`

### SharedDrive.inviteToChat() Override

**File**: `apps/api/src/lib/drive/sharedDrive.ts`

Adds permission checks before delegating to the underlying drive:

1. Verifies write permission on the chat
2. Finds container via `findContainerPath()`
3. Verifies write permission on the container (if present)
4. Checks `sharingRestricted` flag — blocks non-owners from inviting
5. Delegates to underlying drive

## Frontend

The `/invite` slash command in chat calls `useInviteToChat()`, which posts to the invite endpoint and invalidates
`driveKeys.path()` on success.

```
/invite alice@example.com
```

Handles the `alreadyHasAccess` response with an appropriate local message.

**Hook**: `useInviteToChat()` in `packages/lib/src/core/chat/hooks/use-chat.ts`
**Command handler**: `use-chat-room.ts` — the `/invite` case calls `inviteToChat.mutateAsync({ email })`

## Edge Cases

| Case                              | Behavior                                                  |
|-----------------------------------|-----------------------------------------------------------|
| Standalone chat                   | `findContainerPath()` returns `null` → ACL on chat itself |
| Embedded chat                     | ACL on outermost container document                       |
| Nested (chat in folder in doc)    | ACL on outermost container                                |
| Already has access                | Returns `alreadyHasAccess: true`, no ACL change           |
| Chat write but no container write | 403                                                       |
| `sharingRestricted` on container  | Blocks editors, owner bypasses                            |
| Invalid email                     | 400                                                       |
| No write permission               | 403                                                       |
| Case-insensitive emails           | Email lowercased before comparison and storage            |
| Self-invite                       | Allowed                                                   |

## Files

| File                                                | Purpose                                                     |
|-----------------------------------------------------|-------------------------------------------------------------|
| `apps/api/src/lib/drive/acl.ts`                     | `findContainerPath()` — walks parent chain                  |
| `apps/api/src/lib/drive/drive.ts`                   | `inviteToChat()` — resolves target, merges ACL              |
| `apps/api/src/lib/drive/sharedDrive.ts`             | `inviteToChat()` override — permission + restriction checks |
| `apps/api/src/routes/chat.ts`                       | `POST /chat/:ownerId/:mountId/:chatId/invite` route         |
| `packages/lib/src/core/chat/hooks/use-chat.ts`      | `useInviteToChat()` mutation hook                           |
| `packages/lib/src/core/chat/hooks/use-chat-room.ts` | `/invite` command handler                                   |
| `apps/api/src/tests/acl-bubbling.test.ts`           | Integration tests                                           |

See: [ACL.md](ACL.md) for the base ACL system, [CHAT.md](CHAT.md) for the chat system
