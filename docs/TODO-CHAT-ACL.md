# Chat Membership vs ACL — Design Analysis

## Current State

Chat rooms in Eigen are `.eigenchat` files in Drive. The users who can participate in a chat are **exactly the users with ACL access** to that chat file. There is no separate "members" concept — ACL *is* membership.

This means:
- Granting someone `read` access → they can view messages
- Granting someone `write` access → they can post messages
- Revoking ACL access → they lose all access to the chat

## What Works Well

1. **Zero duplication**: No separate membership table to keep in sync with ACLs. One source of truth.
2. **Inherited access is free**: If you share a folder with your team, all chats inside it are automatically accessible. No per-chat invitation needed.
3. **Consistent permission model**: The same share dialog works for files, docs, stickies, and chats. Users learn one mental model.
4. **Read-only observers**: `read: true, write: false` naturally creates "lurker" access — useful for managers or auditors who should see discussions without posting.

## What's Awkward

### 1. Chat-specific roles don't map cleanly to read/write
In a typical chat system, you'd expect roles like:
- **Admin** — can rename room, manage members, pin messages
- **Member** — can post messages
- **Guest/Observer** — can read but not post

With ACLs, you only have `read` and `write`. There's no way to express "can post messages but can't rename the room" vs "can do everything". Currently, `write` means both.

**Impact**: Low for now. If you ever need chat-specific admin actions (pinning, muting, moderation), you'd need either a separate role system or a `details` JSON field on the chat path.

### 2. The `/invite` slash command creates ACL entries
When a user types `/invite bob@example.com` in a chat, the frontend creates a new ACL entry `{email: 'bob@example.com', read: true, write: true}`. This works, but it means:
- The invite is **permanent** until someone with write access changes the ACL
- There's no concept of "pending invite" — the user gets instant access
- The person who invited doesn't need to be the owner to invite (anyone with write access can)

**Impact**: This is actually fine for a team tool. Google Chat works similarly. But if you ever want invite approval flows, you'd need to build that separately.

### 3. Inherited chat access can be surprising
If Alice shares folder `Projects/` with Bob, and there's a chat `Projects/Team Chat.eigenchat` inside it, Bob gets immediate access to the chat. Alice might not realize that sharing the folder also shared the chat.

**Impact**: Medium. This is the same issue Google Drive has with Docs inside shared folders. The mitigation is the share dialog already showing inherited users.

### 4. No "leave chat" action
In most chat apps, a user can leave a room voluntarily. With the ACL model:
- If Bob has **direct** access, the owner could remove him (or Bob could remove himself if he has write access to change ACLs)
- If Bob has **inherited** access from a parent folder, he **cannot** leave the chat without losing access to the entire folder

**Impact**: Low-medium. For a team workspace tool, this is acceptable. Slack channels in a workspace also can't be individually "left" if they're default channels.

## Should You Decouple?

**My recommendation: Keep them coupled for now.** Here's why:

### The cost of decoupling is high
Introducing a separate `ChatMember` table means:
- A new schema, migration, and DB table
- Sync logic: when ACL changes, update members; when members change, update ACL (or don't — and now you have two sources of truth)
- Two different UIs: the share dialog for files/docs and a "members" panel for chats
- Edge cases: what if someone has ACL access but isn't a "member"? Can they still read messages?

### The benefit is small (for now)
The main features you'd gain from decoupling:
- **Leave room** — nice-to-have, not critical for a team tool
- **Chat-specific roles** — only needed if you add moderation features
- **Invite approval** — only needed for external/public rooms

### When to reconsider
Decouple if you ever need:
1. **Public/open rooms** that anyone in the organization can join (like Slack channels). These don't map to ACLs well because you'd need ACLs for every user.
2. **Per-user chat settings** (mute, notification preferences). These need a per-user-per-room record, which is effectively a members table.
3. **Chat room discovery** — a lobby where users browse and join rooms. ACLs are binary (you have access or you don't), not "discoverable but not yet joined."

## Suggested Incremental Path

If chat becomes more important, add a lightweight `chat_members` table **inside the chat's own `data.db`** (not a global table). This keeps it scoped to the chat and co-located with messages:

```sql
CREATE TABLE chat_members (
    email TEXT PRIMARY KEY,
    role TEXT DEFAULT 'member',  -- 'admin' | 'member' | 'observer'
    muted INTEGER DEFAULT 0,
    joined_at INTEGER DEFAULT (unixepoch())
);
```

The ACL remains the **gate** (can you access this chat at all?), and the members table adds **chat-specific state** on top. This gives you the best of both worlds without a full decoupling.
