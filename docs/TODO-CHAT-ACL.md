# Chat Membership vs ACL

> **TLDR**: Design discussion. Chat ACL = membership (no separate members table). Advantages: zero duplication,
> inherited access, consistent model. Limitations: no chat-specific roles, no "leave room". Recommendation: keep coupled
> for now. If needed later, add lightweight `chat_members` table inside chat's `data.db`.

## Current State

Chat rooms in Eigen are `.eigenchat` files in Drive. The users who can participate in a chat are **exactly the users
with ACL access** to that chat file. There is no separate "members" concept — ACL *is* membership.

- Granting `read` access → user can view messages.
- Granting `write` access → user can post messages.
- Revoking ACL access → user loses all access.

## Advantages

1. **Zero duplication**: No separate membership table to sync with ACLs. One source of truth.
2. **Inherited access**: Sharing a folder with a team automatically grants access to all chats inside it. No per-chat
   invitation needed.
3. **Consistent permission model**: The share dialog works uniformly for files, docs, stickies, and chats.
4. **Read-only observers**: `read: true, write: false` creates "lurker" access (e.g., for auditors).

## Limitations

### 1. Missing Chat-Specific Roles

Typical chat systems have roles like Admin (rename room, manage members, pin messages). With ACLs, `write` means both
posting messages and managing the room.
**Impact**: Low. If chat-specific admin actions are needed, a separate role system or a `details` JSON field on the chat
path would be required.

### 2. `/invite` Command Modifies ACL

Typing `/invite bob@example.com` creates a new ACL entry `{email: 'bob@example.com', read: true, write: true}`.

- Invites are permanent until revoked by someone with write access.
- No "pending invite" concept.
- Anyone with write access can invite others.
  **Impact**: Acceptable for team tools. Approval flows would require separate implementation.

### 3. Inherited Access Surprises

Sharing a folder shares all chats inside it. Users might not realize this.
**Impact**: Medium. Mitigated by the share dialog showing inherited users.

### 4. No "Leave Chat" Action

- Direct access: Owner or user with write access can remove the user.
- Inherited access: User cannot leave the chat without losing access to the entire parent folder.
  **Impact**: Low-medium. Acceptable for team workspaces (similar to default Slack channels).

## Recommendation

**Keep them coupled for now.**

### Cost of Decoupling

Introducing a separate `ChatMember` table requires:

- New schema and migration.
- Sync logic between ACL and members.
- Two different UIs (share dialog vs. members panel).
- Handling edge cases (e.g., ACL access without membership).

### Benefits of Decoupling

- "Leave room" functionality.
- Chat-specific roles.
- Invite approval flows.

### When to Reconsider

Decouple if you need:

1. **Public/open rooms**: Anyone can join (like Slack channels). Binary ACLs don't map well to this.
2. **Per-user chat settings**: Mute, notification preferences. Requires per-user-per-room records.
3. **Chat room discovery**: Lobby for browsing and joining rooms.

## Suggested Incremental Path

If chat functionality expands, add a lightweight `chat_members` table **inside the chat's own `data.db`** (not global).
This keeps it scoped and co-located:

```sql
CREATE TABLE chat_members (
    email TEXT PRIMARY KEY,
    role TEXT DEFAULT 'member',  -- 'admin' | 'member' | 'observer'
    muted INTEGER DEFAULT 0,
    joined_at INTEGER DEFAULT (unixepoch())
);
```

ACL remains the gatekeeper, and the members table adds chat-specific state. This provides the benefits of decoupling
without the full cost.
