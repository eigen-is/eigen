# Mentions & Notification Center

> **TLDR**: Cross-cutting @mention system for chat, docs, and stickies. Mentions produce persisted notifications stored
> in a per-user SQLite database. A notification bell in the topbar shows unread count + dropdown list. SSE delivers
> real-time notification events. Mention autocomplete reuses the existing `ChatPlayerSuggest` pattern. Docs get a
> Tiptap `Mention` extension. Chat already has @ suggest infrastructure that just needs notification wiring.

## 1. Problem Statement

Users need to tag other users across Eigen apps:

- **Chat messages**: `@alice@eigen.is check this out` -- already has `ChatPlayerSuggest` autocomplete that inserts the
  email, but no notification is sent to the mentioned user
- **Doc comments**: Mention a user inside a comment thread (which is itself an eigenchat) to draw their attention
- **Doc inline mentions**: `@alice@eigen.is` as a read-only inline token in the document body (Tiptap node)
- **Stickies cards**: Mention a user in a card title/description to assign or notify them
- **Future**: Calendar events, mail drafts (already has contact autosuggest, not a mention)

Today, there is no notification center. SSE events trigger ephemeral toasts for a handful of curated events
(incoming mail, share changes, calendar invites). Users have no way to see missed notifications or to be specifically
notified when someone mentions them.

## 2. Current State Analysis

### 2.1 Existing Notification Infrastructure

**SSE pipeline** (fully operational):

```
API mutation --> home.notify(event) --> SSE stream --> client handler --> cache invalidation + optional toast
```

- Each user subscribes to their own Home's SSE stream (`/sse/:ownerId/events`, enforced by `requireSelf`)
- Events are typed (`SSEvent` union in `packages/lib/src/types/sse.ts`)
- Events optionally carry `SSEventNotification` mixin (`body`, `tag?`, `link?`) -- designed for a future notification
  center (see `docs/NOTIFICATIONS.md` "Future" section)
- Cross-user notification already works: `ChatRoom.notifySharedUsers()` resolves ACL user IDs and calls
  `home.notify()` on each recipient's Home. Same pattern in `propagateACLChange()`, `notifySharedCalendarUsers()`,
  `propagateInvitation()`

**Toast notifications** (ephemeral):

- Mail received, drive shared/unshared, calendar shared/invited -- shown directly in SSE handlers
- No persistence, no unread tracking, no history

### 2.2 User Resolution

Users are identified by email throughout the system:

- ACL entries use email (`DriveACL.id` = email or `team_{id}`)
- Chat whisper targets use email
- Contact autosuggest (`useContactSuggestions`) matches by name or email against the user's contacts DB
- `getUserByEmail()` resolves email to user record (auth DB)
- `resolveACLUserIds()` resolves ACL entries to user IDs (handles both emails and team memberships)
- `ChatPlayerSuggest` merges room members (from ACL) + contact suggestions for the @ dropdown

**Key insight**: Mention targets should be emails. This is consistent with the existing system and avoids display name
ambiguity. The autocomplete shows `name + email`, but the stored mention is the email.

### 2.3 Chat @ Mention Infrastructure

Chat already has partial @ mention support:

- `getAtSuggestQuery()` in `chat-utils.ts` detects `@` at start or after whitespace
- `ChatPlayerSuggest` shows autocomplete dropdown merging room members + contacts
- On selection, the email replaces the `@query` text: `@ali` becomes `alice@eigen.is `
- `ChatMessageList` renders emails inline with avatar + name via `RichContent` / `InlineEmail`
- What's missing: no notification is sent when a message contains `@email`

### 2.4 Tiptap Extensions

The docs editor uses Tiptap with Collaboration (Yjs). Existing custom extensions:

- `CommentMark` -- marks text with `data-chat-name` attribute, links to embedded eigenchat
- `ResizableImage` -- image node with `mediaName` attribute

Tiptap has a first-party `@tiptap/extension-mention` that provides:

- A `mention` node type with configurable trigger character (`@`)
- `SuggestionPlugin` for autocomplete popup
- Renders as `<span data-type="mention" data-id="...">` -- works with Yjs collaboration

### 2.5 Yjs Considerations

Stickies and docs use Yjs for real-time sync. Mentions in Yjs documents need to be stored as Yjs-native data:

- **Docs**: Tiptap mention extension stores mentions as ProseMirror nodes in the Yjs fragment -- works automatically
- **Stickies**: Card `title` and `description` are plain strings in Y.Map. Mentions would be stored as email strings
  within the text (like chat). Alternatively, add a `mentions` array field to the card Y.Map for explicit tracking

## 3. Proposed Architecture

### 3.A Notification Data Model

#### Per-user notification database

Each user gets `eigen.notifications/notifications.db` inside their home directory:

```
data/home/{userId}/
  eigen.notifications/
    notifications.db
```

This follows the per-user pattern of `eigen.mail/`, `eigen.contacts/`, `eigen.calendar/`.

#### Schema

```typescript
// apps/api/src/lib/notification/schema.ts
export const notifications = sqliteTable('notifications', {
    id: text('id').primaryKey(),                    // UUID
    type: text('type').notNull(),                   // 'mention' | 'reply' | 'share' | 'invite' | ...
    actorId: text('actorId').notNull(),             // user ID of who triggered it
    actorEmail: text('actorEmail').notNull(),       // for display without lookup
    title: text('title').notNull(),                 // short summary: "alice mentioned you"
    body: text('body'),                             // context: message content excerpt
    link: text('link'),                             // deep link URL to navigate to source
    tag: text('tag'),                               // dedup key: "chat:{chatId}" or "doc:{pathId}"
    sourceApp: text('sourceApp'),                   // 'chat' | 'docs' | 'stickies'
    sourceId: text('sourceId'),                     // resource ID (chatId, pathId, etc.)
    read: integer('read', {mode: 'boolean'}).notNull().default(false),
    createdAt: integer('createdAt', {mode: 'timestamp'}).notNull().default(sql`(unixepoch())`),
});
```

**Why per-user SQLite**: Consistent with the Home pattern. No cross-user queries needed. Each user's notifications
are only read by that user. Scales to multi-server by keeping data co-located with the Home.

#### DatabaseConfig

```typescript
// apps/api/src/lib/notification/db-config.ts
export const NOTIFICATION_DB_CONFIG: DatabaseConfig<typeof schema> = {
    name: 'notification',
    currentVersion: 1,
    schema,
    migrations: [{
        version: 1,
        up: (db) => db.exec(`
            CREATE TABLE IF NOT EXISTS notifications (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                actorId TEXT NOT NULL,
                actorEmail TEXT NOT NULL,
                title TEXT NOT NULL,
                body TEXT,
                link TEXT,
                tag TEXT,
                sourceApp TEXT,
                sourceId TEXT,
                read INTEGER NOT NULL DEFAULT 0,
                createdAt INTEGER NOT NULL DEFAULT (unixepoch())
            );
            CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
            CREATE INDEX IF NOT EXISTS idx_notifications_createdAt ON notifications(createdAt DESC);
            CREATE INDEX IF NOT EXISTS idx_notifications_tag ON notifications(tag);
        `)
    }]
};
```

### 3.B Mention Detection & Autocomplete

#### 3.B.1 Chat Mentions (mostly exists)

The chat input already inserts `email` when selecting from the @ dropdown. Detection on the backend:

```typescript
// apps/api/src/lib/notification/mentions.ts
const EMAIL_MENTION_REGEX = /(?:^|[\s,.])([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?=[\s,.]|$)/g;

export function extractMentionedEmails(content: string): string[] {
    const emails: string[] = [];
    let match;
    while ((match = EMAIL_MENTION_REGEX.exec(content)) !== null) {
        emails.push(match[1].toLowerCase());
    }
    return [...new Set(emails)];
}
```

After `ChatRoom.postMessage()` inserts the message, call `extractMentionedEmails(content)` and create notifications
for each mentioned user.

**Filtering**: Only notify users who are not the author, and who have access to the chat room (are in the ACL or are
the owner). Mentioning someone who doesn't have access should NOT auto-invite them (see open questions).

#### 3.B.2 Doc Inline Mentions (Tiptap extension)

Add `@tiptap/extension-mention` to the docs editor:

```typescript
// apps/docs/src/components/docs/extensions/mention.ts
import Mention from '@tiptap/extension-mention';

export const EigenMention = Mention.configure({
    HTMLAttributes: { class: 'mention' },
    suggestion: {
        char: '@',
        items: ({ query }) => /* fetch from suggestion provider */,
        render: () => /* popup component */,
    },
    renderText: ({ node }) => `@${node.attrs.label}`,
});
```

The mention node stores `{ id: email, label: displayName }` in the Yjs document. The `id` field (email) is the
stable identifier; `label` is for display.

**Notification trigger**: When a mention node is inserted into the Yjs document, the backend (WebSocket collab
server) can detect new mention nodes by observing Yjs updates. However, this is complex. A simpler approach:

- The frontend, after inserting a mention node, sends a lightweight POST to a new endpoint:
  `POST /notification/:ownerId/mention` with `{ email, sourceApp, sourceId, link }`
- The backend creates the notification and pushes via SSE

This avoids parsing Yjs diffs on the server, which would be fragile and tightly coupled to Tiptap's internal format.

#### 3.B.3 Stickies Card Mentions

Stickies cards have plain-text `title` and `description` fields. Two approaches:

**Option A (recommended)**: Use the same email-in-text pattern as chat. When a user saves a card with an email
address preceded by `@`, extract mentions server-side. But stickies edits go through Yjs, not an API endpoint.

**Option B**: Add a `mentions: string[]` field to the card Y.Map. When the frontend detects a mention being added
(via the card settings dialog), it:

1. Writes the email to the `mentions` array in Yjs
2. Sends `POST /notification/:ownerId/mention` to create the notification

Option B is cleaner because it explicitly tracks mentions without regex-parsing card text.

#### 3.B.4 Shared Autocomplete Component

The mention autocomplete needs a list of eligible users. "Eligible" means users who have access to the resource:

```typescript
// packages/ui/src/components/layout/mentions/use-mention-suggestions.ts
export function useMentionSuggestions(ownerId: string, mountId: string, pathId: string) {
    // Reuses the same logic as ChatPlayerSuggest:
    // 1. Room members / ACL entries on the resource
    // 2. Contact suggestions from user's contacts DB
    // ACL-based filtering ensures you can only mention people who can see the resource
}
```

For docs and stickies, ACL comes from the Drive path. For chat, from the chat room path. The existing
`useContactSuggestions` + room member merge in `ChatPlayerSuggest` is the right pattern. Extract it into a shared
hook.

### 3.C Notification Backend

#### Domain class

```typescript
// apps/api/src/lib/notification/notification.ts
export class NotificationService {
    private home: Home;
    private db!: BunSQLiteDatabase<typeof schema>;

    constructor(home: Home) { this.home = home; }

    async init(): Promise<void> {
        const managedDb = await this.home.getLocalDatabase(
            NOTIFICATION_DB_CONFIG,
            'eigen.notifications/notifications.db'
        );
        this.db = managedDb.db;
    }

    async createNotification(data: {
        type: string;
        actorId: string;
        actorEmail: string;
        title: string;
        body?: string;
        link?: string;
        tag?: string;
        sourceApp?: string;
        sourceId?: string;
    }): Promise<Notification> {
        const id = randomUUID();
        const now = new Date();
        await this.db.insert(schema.notifications).values({ id, ...data, createdAt: now });

        // Deduplicate by tag: if tag exists, update instead of creating new
        if (data.tag) {
            // Could use INSERT OR REPLACE with tag as unique constraint,
            // or update the existing notification to bump it to the top
        }

        return { id, ...data, read: false, createdAt: now };
    }

    async getNotifications(limit: number = 50, unreadOnly: boolean = false) { /* ... */ }
    async markRead(notificationId: string) { /* ... */ }
    async markAllRead() { /* ... */ }
    async getUnreadCount(): Promise<number> { /* ... */ }
    async deleteOlderThan(days: number) { /* ... */ }
}
```

#### Integration with Home

Add `NotificationService` to `Home` alongside Drive, Contacts, Mail, Calendar:

```typescript
// In Home class
protected _notifications!: NotificationService;
get notifications(): NotificationService { return this._notifications; }
```

Initialize in `UserHome.constructor()`:

```typescript
this._notifications = new NotificationService(this);
```

#### API Routes

```
GET    /notification/:ownerId                    # list (query: limit, unreadOnly)
GET    /notification/:ownerId/unread-count       # badge count
POST   /notification/:ownerId/mention            # create mention notification (from FE)
PATCH  /notification/:ownerId/:notificationId    # mark read
POST   /notification/:ownerId/read-all           # mark all read
DELETE /notification/:ownerId/old                # cleanup old notifications
```

Router file: `apps/api/src/routes/notification.ts`

#### SSE Events

```typescript
// In packages/lib/src/types/sse.ts
// Add to SSEventType:
NOTIFICATION_CREATED: 'notification:created',
NOTIFICATION_READ: 'notification:read',
NOTIFICATION_READ_ALL: 'notification:read-all',

// New event type:
type SSEventNotificationData = {
    notificationId: string;
    type: string;
    actorEmail: string;
    title: string;
    body?: string;
    link?: string;
};

type SSEventNotificationEvent = SSEventBase & SSEventNotification & {
    type: typeof SSEventType.NOTIFICATION_CREATED
        | typeof SSEventType.NOTIFICATION_READ
        | typeof SSEventType.NOTIFICATION_READ_ALL;
    notification: SSEventNotificationData;
};
```

#### Mention Notification Flow

```
1. User posts chat message containing "@alice@eigen.is"
2. ChatRoom.postMessage() saves message
3. extractMentionedEmails(content) returns ["alice@eigen.is"]
4. For each mentioned email:
   a. getUserByEmail("alice@eigen.is") --> User { id: "abc123" }
   b. Verify user has access to this chat (is in ACL or is owner)
   c. Skip if mentioner === mentioned
   d. getHome("abc123") --> alice's Home
   e. home.notifications.createNotification({
        type: 'mention',
        actorId: authorId,
        actorEmail: authorEmail,
        title: 'authorName mentioned you in chatName',
        body: content.slice(0, 200),
        link: getChatRoomUrl(ownerId, mountId, chatId),
        tag: 'chat:chatId',
        sourceApp: 'chat',
        sourceId: chatId,
      })
   f. home.notify(buildNotificationEvent(...))
```

This mirrors the existing `notifySharedUsers()` pattern in `ChatRoom`.

### 3.D Notification Center UI

#### Topbar Bell Icon

Add a notification bell to the topbar, next to the user avatar:

```typescript
// packages/ui/src/components/layout/app/notification-bell.tsx
export function NotificationBell() {
    const {data: count} = useUnreadNotificationCount();
    const [open, setOpen] = useState(false);

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button variant="ghost" size="icon"
                    className="relative text-white hover:bg-primary/20 hover:text-white">
                    <Bell className="h-5 w-5" />
                    {count > 0 && (
                        <span className="absolute -top-0.5 -right-0.5 h-4 w-4 rounded-full bg-destructive
                            text-[10px] font-bold text-white flex items-center justify-center">
                            {count > 9 ? '9+' : count}
                        </span>
                    )}
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-80 p-0" align="end">
                <NotificationList onClose={() => setOpen(false)} />
            </PopoverContent>
        </Popover>
    );
}
```

Insert in `Topbar` between the title area and `UserDropdown`:

```typescript
// In topbar.tsx
<div className="flex items-center px-4 shrink-0 gap-2">
    <NotificationBell />
    <UserDropdown rootRoute={rootRoute} />
</div>
```

#### Notification List Component

```typescript
// packages/ui/src/components/layout/app/notification-list.tsx
export function NotificationList({ onClose }: { onClose: () => void }) {
    const {data: notifications, isLoading} = useNotifications();
    const markRead = useMarkNotificationRead();
    const markAllRead = useMarkAllNotificationsRead();

    const handleClick = (notification: Notification) => {
        if (!notification.read) markRead.mutate(notification.id);
        if (notification.link) window.location.href = notification.link;
        onClose();
    };

    return (
        <div className="max-h-[400px] overflow-y-auto">
            <div className="flex items-center justify-between px-3 py-2 border-b">
                <span className="text-sm font-medium">Notifications</span>
                <Button variant="ghost" size="sm" onClick={() => markAllRead.mutate()}>
                    Mark all read
                </Button>
            </div>
            {notifications?.map(n => (
                <div
                    key={n.id}
                    className={cn(
                        "px-3 py-2 cursor-pointer hover:bg-muted",
                        !n.read && "bg-primary/5"
                    )}
                    onClick={() => handleClick(n)}
                >
                    <div className="flex items-start gap-2">
                        <UserAvatar email={n.actorEmail} size="sm" />
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium">{n.title}</p>
                            {n.body && (
                                <p className="text-xs text-muted-foreground truncate">{n.body}</p>
                            )}
                            <p className="text-xs text-muted-foreground">
                                {formatRelativeTime(n.createdAt)}
                            </p>
                        </div>
                        {!n.read && (
                            <div className="h-2 w-2 rounded-full bg-primary shrink-0 mt-1.5" />
                        )}
                    </div>
                </div>
            ))}
        </div>
    );
}
```

#### Cross-App Navigation

The `link` field in notifications contains full URLs (e.g., `getChatRoomUrl(...)`, `getDocUrl(...)`). Clicking a
notification navigates to that URL. Since Eigen apps are separate Vite apps on different ports/subdomains, this is a
full page navigation, not a SPA route change. This is acceptable and consistent with how app switching already works
(topbar app dropdown uses `<a href>`).

### 3.E SSE Integration

#### SSE Event Builder

```typescript
// apps/api/src/lib/notification/sse-events.ts
export function buildNotificationEvent(
    type: 'notification:created' | 'notification:read' | 'notification:read-all',
    data: SSEventNotificationData,
): SSEvent {
    return {
        type,
        title: data.title,
        body: data.body ?? '',
        link: data.link,
        notification: data,
    } as SSEvent;
}
```

#### SSE Handler

```typescript
// packages/lib/src/core/notification/sse-handlers.ts
export function handleNotificationSSEvent(event: SSEvent, queryClient: QueryClient): boolean {
    if (!event?.type?.startsWith('notification:')) return false;

    switch (event.type) {
        case SSEventType.NOTIFICATION_CREATED:
            invalidateNotifications(queryClient);
            invalidateUnreadCount(queryClient);
            // Show a toast for the new notification
            if ('notification' in event) {
                toast(event.notification.title, {
                    description: event.notification.body,
                });
            }
            return true;

        case SSEventType.NOTIFICATION_READ:
        case SSEventType.NOTIFICATION_READ_ALL:
            invalidateNotifications(queryClient);
            invalidateUnreadCount(queryClient);
            return true;

        default:
            return false;
    }
}
```

Register in `use-sse.ts`:

```typescript
handleNotificationSSEvent(event, queryClient);
```

#### Replacing Existing Toasts

After the notification center is operational, the existing toasts in SSE handlers (mail received, drive shared, etc.)
should be migrated to create persisted notifications instead. The notification center toast from
`handleNotificationSSEvent` replaces the per-domain toasts. This is a gradual migration -- both can coexist.

### 3.F Frontend Data Hooks

```typescript
// packages/lib/src/core/notification/hooks/use-notifications.ts
export const notificationKeys = {
    all: (ownerId: string) => ['notification', ownerId] as const,
    list: (ownerId: string) => [...notificationKeys.all(ownerId), 'list'] as const,
    unreadCount: (ownerId: string) => [...notificationKeys.all(ownerId), 'unread-count'] as const,
};

export function useNotifications() {
    const { user } = useAuth();
    return useQuery({
        queryKey: notificationKeys.list(user?.id ?? ''),
        queryFn: async () => {
            const response = await notificationApi({ ownerId: user!.id }).get({
                query: { limit: '50' }
            });
            return response.data ?? [];
        },
        enabled: !!user?.id,
    });
}

export function useUnreadNotificationCount() {
    const { user } = useAuth();
    return useQuery({
        queryKey: notificationKeys.unreadCount(user?.id ?? ''),
        queryFn: async () => {
            const response = await notificationApi({
                ownerId: user!.id
            })['unread-count'].get();
            return response.data?.count ?? 0;
        },
        enabled: !!user?.id,
        refetchInterval: 60_000, // poll every minute as fallback
    });
}

export function useMarkNotificationRead() { /* ... */ }
export function useMarkAllNotificationsRead() { /* ... */ }

export function invalidateNotifications(queryClient: QueryClient) { /* ... */ }
export function invalidateUnreadCount(queryClient: QueryClient) { /* ... */ }
```

## 4. Implementation Plan

### Phase 1: Notification Backend + Center UI

**Goal**: Notification storage, API, SSE events, bell icon with dropdown.

Files to create:

- `apps/api/src/lib/notification/schema.ts`
- `apps/api/src/lib/notification/db-config.ts`
- `apps/api/src/lib/notification/notification.ts`
- `apps/api/src/lib/notification/sse-events.ts`
- `apps/api/src/routes/notification.ts`
- `packages/lib/src/types/notification.ts`
- `packages/lib/src/core/notification/hooks/use-notifications.ts`
- `packages/lib/src/core/notification/sse-handlers.ts`
- `packages/lib/src/core/notification/index.ts`
- `packages/ui/src/components/layout/app/notification-bell.tsx`
- `packages/ui/src/components/layout/app/notification-list.tsx`

Files to modify:

- `apps/api/src/lib/home/home.ts` -- add `_notifications` field
- `apps/api/src/lib/home/user-home.ts` -- instantiate `NotificationService`
- `packages/lib/src/types/sse.ts` -- add notification event types
- `packages/lib/src/core/sse/hooks/use-sse.ts` -- register notification handler
- `packages/ui/src/components/layout/app/topbar.tsx` -- add `NotificationBell`
- `packages/lib/src/core/api.ts` -- add `notificationApi`

**Dependencies**: None. Can be built and tested independently.

### Phase 2: Chat Mentions --> Notifications

**Goal**: When a chat message contains `@email`, create a notification for the mentioned user.

Files to create:

- `apps/api/src/lib/notification/mentions.ts` (email extraction utility)

Files to modify:

- `apps/api/src/lib/chat/chat.ts` -- after `postMessage`, extract mentions and create notifications

**Dependencies**: Phase 1.

### Phase 3: Doc Inline Mentions

**Goal**: Tiptap `@mention` node in the docs editor with autocomplete and notification.

Files to create:

- `apps/docs/src/components/docs/extensions/mention.ts` (Tiptap mention extension)
- `apps/docs/src/components/docs/extensions/mention-suggestion.tsx` (popup component)

Files to modify:

- `apps/docs/src/components/docs/editor.tsx` -- add `EigenMention` extension
- `apps/api/src/routes/notification.ts` -- add `POST /notification/:ownerId/mention` endpoint

**Dependencies**: Phase 1. Install `@tiptap/extension-mention`.

### Phase 4: Stickies Card Mentions

**Goal**: Mention users in stickies card descriptions.

Files to modify:

- `apps/stickies/src/components/stickies/card-settings-dialog.tsx` -- add mention autocomplete to description
- `apps/stickies/src/components/stickies/types.ts` -- add optional `mentions` field to `CardItem`
- `apps/stickies/src/components/stickies/hooks/use-board.ts` -- persist mentions in Yjs, send notification

**Dependencies**: Phase 1.

### Phase 5: Migrate Existing Toasts

**Goal**: Replace ephemeral toasts with persisted notifications for share changes, mail received, calendar invites.

Files to modify:

- `apps/api/src/lib/drive/acl-propagation.ts` -- create notification on ACL change
- `apps/api/src/lib/calendar/share-propagation.ts` -- create notification on calendar share
- `apps/api/src/lib/calendar/invite-propagation.ts` -- create notification on invite
- `apps/api/src/lib/mail/maildir.ts` -- create notification on mail received
- `packages/lib/src/core/drive/sse-handlers.ts` -- remove toast (notification handler shows it)
- `packages/lib/src/core/mail/sse-handlers.ts` -- remove toast
- `packages/lib/src/core/calendar/sse-handlers.ts` -- remove toast

**Dependencies**: Phase 1. Can be done incrementally.

## 5. Open Questions & Trade-offs

### @email vs @displayname

**Recommendation**: Store email, display name. The autocomplete shows name + email. The stored mention uses email as
the stable identifier (people can change display names). The render shows the display name with avatar (like chat's
existing `InlineEmail` component).

### Notification storage: per-user SQLite vs shared DB

**Recommendation**: Per-user SQLite (`eigen.notifications/notifications.db`). Consistent with the Home pattern. No
cross-user queries needed. Future multi-server scaling keeps notifications co-located with the user's Home.

An alternative is storing in the server-level `eigen.db` (like the share registry), but this creates a single write
bottleneck and doesn't align with the per-user isolation model.

### Mention someone who doesn't have access?

**Recommendation**: No. Do not auto-invite on mention. The autocomplete should only show users who already have
access (are in the ACL). This avoids accidental permission grants. If you want to mention someone, first share the
resource with them (existing ACL flow), then mention them.

Exception: In a team context, all team members have implicit access, so they should all appear in the autocomplete
even without explicit ACL entries.

### Deduplication (tag field)

The `tag` field prevents notification spam. For example, if Alice mentions Bob 5 times in the same chat room within
a short period, only one notification should exist (or the existing one should be bumped). The tag format:

- Chat: `chat:{chatId}`
- Doc: `doc:{pathId}`
- Stickies: `stickies:{pathId}:{cardId}`

When a new notification arrives with a matching tag, UPDATE the existing row (bump `createdAt`, update `body`, set
`read = false`) instead of inserting a new row.

### Notification retention

Old notifications should be cleaned up. Options:

- Auto-delete read notifications after 30 days
- Auto-delete all notifications after 90 days
- Run cleanup on `Home.init()` or on a periodic schedule

### Real-time typing indicators for mentions

Out of scope. The existing `CHAT_TYPING` SSE event is already defined but unused. Typing indicators are independent
of the mention system.

### Notification preferences / muting

Defer to a later phase. When needed, add a `notification_preferences` table or a field in user settings to control:

- Mute notifications from specific resources (tag-based)
- Disable mention notifications globally
- Disable specific notification types

### Doc comments vs doc inline mentions

These are different features:

- **Comment** (exists): Highlight text --> create embedded eigenchat --> discuss in thread. Uses `CommentMark`.
- **Inline mention** (new): Insert `@alice` as a read-only token in the document body. Uses `Mention` node.

Both can generate notifications, but through different paths. A comment mention is just a chat mention in an embedded
chat. An inline mention uses the `POST /notification/:ownerId/mention` endpoint.

## Files Reference

| Category              | File                                                                    | Purpose                                          |
|-----------------------|-------------------------------------------------------------------------|--------------------------------------------------|
| **Existing SSE**      | `packages/lib/src/types/sse.ts`                                         | Event type definitions                           |
| **Existing SSE**      | `packages/lib/src/core/sse/hooks/use-sse.ts`                            | Event dispatcher                                 |
| **Existing SSE**      | `apps/api/src/lib/home/home.ts`                                         | `notify()` method                                |
| **Existing SSE**      | `apps/api/src/routes/sse.ts`                                            | SSE stream endpoint                              |
| **Existing Chat**     | `apps/api/src/lib/chat/chat.ts`                                         | `ChatRoom.postMessage()` + `notifySharedUsers()` |
| **Existing Chat**     | `packages/ui/src/components/layout/chat/chat-player-suggest.tsx`        | @ autocomplete                                   |
| **Existing Chat**     | `packages/ui/src/components/layout/chat/chat-utils.ts`                  | `getAtSuggestQuery()`                            |
| **Existing Chat**     | `packages/ui/src/components/layout/chat/chat-message-list.tsx`          | `InlineEmail` rendering                          |
| **Existing Docs**     | `apps/docs/src/components/docs/editor.tsx`                              | Tiptap editor + extensions                       |
| **Existing Docs**     | `apps/docs/src/components/docs/extensions/comment-mark.ts`              | Comment mark extension                           |
| **Existing Stickies** | `apps/stickies/src/components/stickies/types.ts`                        | `CardItem` type                                  |
| **Existing Stickies** | `apps/stickies/src/components/stickies/hooks/use-board.ts`              | Yjs board hook                                   |
| **Existing Users**    | `apps/api/src/lib/user/user.ts`                                         | `getUserByEmail()`, `getMemberships()`           |
| **Existing Users**    | `apps/api/src/lib/drive/acl-propagation.ts`                             | `resolveACLUserIds()`                            |
| **Existing Contacts** | `packages/ui/src/components/layout/contacts/use-contact-suggestions.ts` | Contact autocomplete                             |
| **Existing Topbar**   | `packages/ui/src/components/layout/app/topbar.tsx`                      | Where bell icon goes                             |
| **Existing Topbar**   | `packages/ui/src/components/layout/app/app-shell.tsx`                   | App shell layout                                 |
