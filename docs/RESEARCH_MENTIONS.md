# Mentions & Notification Center

> **TLDR**: Cross-cutting @mention system for chat, docs, and stickies. Mentions produce persisted notifications in a
> per-user SQLite database. A notification bell in the topbar shows unread count + dropdown list. SSE delivers real-time
> events. Chat mentions are detected server-side in `postMessage()`. Doc and stickies mentions use a lightweight POST
> endpoint. Mention autocomplete reuses the `ChatPlayerSuggest` pattern.

## 1. Problem Statement

Users need to tag other users across Eigen apps:

- **Chat messages**: `@alice@eigen.is` — already has `ChatPlayerSuggest` autocomplete, but no notification is sent
- **Doc inline mentions**: `@alice@eigen.is` as a Tiptap mention node in the document body
- **Doc comments**: Mentions inside comment threads (embedded eigenchats) — handled by chat mention detection
- **Stickies cards**: Mention a user in a card to assign or notify them

There is no notification center. SSE events trigger ephemeral toasts for curated events (incoming mail, share changes,
calendar invites). Users have no way to see missed notifications or to be notified when someone mentions them.

## 2. Existing Infrastructure

### SSE Pipeline

```
API mutation → home.notify(event) → SSE stream → client handler → cache invalidation + optional toast
```

- Each user subscribes to their Home's SSE stream (`/sse/:ownerId/events`, enforced by `requireSelf`)
- Events carry the `SSEventNotification` mixin (`body`, `tag?`, `link?`) — designed for a future notification center
  (see `docs/NOTIFICATIONS.md` "Future" section)
- Cross-user notification works: `ChatRoom.notifySharedUsers()` resolves ACL user IDs and calls `home.notify()` on
  each recipient's Home. Same pattern in `propagateACLChange()`, `notifySharedCalendarUsers()`, `propagateInvitation()`

### User Resolution

Mention targets are **emails** — consistent with ACL entries, chat whisper targets, and contact suggestions.
Autocomplete shows `name + email`; the stored mention is the email. `getUserByEmail()` resolves to user record.
`resolveACLUserIds()` resolves ACL entries (emails + teams) to user IDs.

### Chat @ Mention Support

- `getAtSuggestQuery()` in `chat-utils.ts` detects `@` trigger in chat input
- `ChatPlayerSuggest` shows dropdown merging room members + contact suggestions
- On selection, email replaces `@query`: `@ali` → `alice@eigen.is `
- `InlineEmail` renders emails with avatar + name in message list
- **Missing**: no notification sent when a message contains `@email`

### Tiptap Extensions

The docs editor uses Tiptap with Yjs collaboration. First-party `@tiptap/extension-mention` provides a `mention` node
type with `SuggestionPlugin` for autocomplete, rendered as `<span data-type="mention" data-id="...">`. Works with Yjs
out of the box.

### Yjs Considerations

- **Docs**: Tiptap mention extension stores mentions as ProseMirror nodes in the Yjs fragment — automatic
- **Stickies**: Card fields are plain strings in Y.Map. Mentions are tracked via an explicit `mentions: string[]`
  array field on the card Y.Map (avoids regex-parsing card text)

## 3. Architecture

### 3.A Notification Data Model

#### Storage

Per-user SQLite database following the Home pattern:

```
data/home/{userId}/eigen.notifications/notifications.db
```

#### Schema

```typescript
// apps/api/src/lib/notification/schema.ts
export const notifications = sqliteTable('notifications', {
    id: text('id').primaryKey(),
    type: text('type').notNull(),                                          // 'mention' | 'share' | 'invite'
    actorEmail: text('actorEmail').notNull(),                              // who triggered it (for avatar display)
    title: text('title').notNull(),                                        // "Alice mentioned you in #general"
    body: text('body'),                                                    // message excerpt
    link: text('link'),                                                    // deep link URL
    tag: text('tag').unique(),                                             // dedup key (NULL = no dedup)
    sourceApp: text('sourceApp'),                                          // 'chat' | 'docs' | 'stickies'
    read: integer('read', {mode: 'boolean'}).notNull().default(false),
    createdAt: integer('createdAt', {mode: 'timestamp'}).notNull().default(sql`(unixepoch())`),
});
```

The `tag` column has a `UNIQUE` constraint enabling upsert-based deduplication. When a notification arrives with a
matching tag, the existing row is updated (refreshed `title`, `body`, `createdAt`, reset `read = false`). This prevents
spam from multiple mentions in the same resource. `NULL` tags are exempt from uniqueness (SQLite treats NULLs as
distinct).

Tag format:

- Chat: `chat:{chatId}`
- Doc: `doc:{pathId}`
- Stickies: `stickies:{pathId}:{cardId}`

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
                actorEmail TEXT NOT NULL,
                title TEXT NOT NULL,
                body TEXT,
                link TEXT,
                tag TEXT UNIQUE,
                sourceApp TEXT,
                read INTEGER NOT NULL DEFAULT 0,
                createdAt INTEGER NOT NULL DEFAULT (unixepoch())
            );
            CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
            CREATE INDEX IF NOT EXISTS idx_notifications_createdAt ON notifications(createdAt DESC);
        `)
    }]
};
```

### 3.B Notification Service

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

    async create(data: NewNotification): Promise<Notification> {
        const id = randomUUID();
        const now = new Date();
        if (data.tag) {
            await this.db.insert(schema.notifications)
                .values({ id, ...data, createdAt: now })
                .onConflictDoUpdate({
                    target: schema.notifications.tag,
                    set: { title: data.title, body: data.body, createdAt: now, read: false },
                });
        } else {
            await this.db.insert(schema.notifications).values({ id, ...data, createdAt: now });
        }
        return { id, ...data, read: false, createdAt: now };
    }

    async list(limit = 50, unreadOnly = false): Promise<Notification[]> { /* query with order by createdAt DESC */ }
    async markRead(id: string): Promise<void> { /* update read = true */ }
    async markAllRead(): Promise<void> { /* update all read = true */ }
    async unreadCount(): Promise<number> { /* count where read = false */ }
    async deleteOlderThan(days: number): Promise<void> { /* cleanup */ }
}
```

#### Home Integration

Add `NotificationService` to `Home` alongside existing domain services. Only `UserHome` instantiates it — teams and
orgs do not receive notifications.

```typescript
// Home base class — add field and getter
protected _notifications?: NotificationService;
get notifications(): NotificationService | undefined { return this._notifications; }

// Home.init() — add to existing initialization sequence
await this._notifications?.init();

// UserHome constructor — instantiate
this._notifications = new NotificationService(this);
```

Database cleanup is automatic: `NotificationService` uses `home.getLocalDatabase()` which registers with the Home's
managed database tracker, closed in `Home.destruct()`. No explicit cleanup needed for `NotificationService`.

#### Convenience Function

```typescript
// apps/api/src/lib/notification/notification.ts
export async function getNotifications(userId: string): Promise<NotificationService> {
    const home = await getHome(userId);
    return home.notifications!;
}
```

### 3.C API Routes

```typescript
// apps/api/src/routes/notification.ts
GET / notification /
:
ownerId                     // list (query: limit, unreadOnly)
GET / notification /
:
ownerId / unread - count        // badge count
POST / notification /
:
ownerId / mention             // create mention notification (from docs/stickies FE)
PATCH / notification /
:
ownerId /
:
notificationId     // mark read
POST / notification /
:
ownerId / read - all            // mark all read
```

All routes use `requireSelf(params.ownerId, user.id)` — notifications are personal-only.

The `POST /notification/:ownerId/mention` endpoint accepts:

```typescript
body: {
    email: string;          // mentioned user's email
    sourceApp: string;      // 'docs' | 'stickies'
    sourceMountId: string;  // mount containing the resource
    sourcePathId: string;   // resource path ID
    link: string;           // deep link URL
}
```

The backend validates before creating the notification:

1. Caller has write access to the resource (via `sourceMountId`/`sourcePathId` ACL check)
2. Mentioned email has read access to the resource (is in ACL, is owner, or is team member)
3. Mentioned email resolves to a valid user (`getUserByEmail()`)
4. Mentioner !== mentioned (skip self-mentions)

Then creates the notification on the recipient's Home and pushes via SSE.

### 3.D SSE Events

Two new event types:

```typescript
// packages/lib/src/types/sse.ts — add to SSEventType
NOTIFICATION_CREATED: 'notification:created',
NOTIFICATION_UPDATED: 'notification:updated',      // read state changes
```

Add `SSEventNotificationEvent` to the `SSEvent` union:

```typescript
type SSEventNotificationEvent = SSEventBase & SSEventNotification & {
    type: typeof SSEventType.NOTIFICATION_CREATED | typeof SSEventType.NOTIFICATION_UPDATED;
};

export type SSEvent = SSEventDrive | SSEventMail | ... | SSEventNotificationEvent;
```

Event builders:

```typescript
// apps/api/src/lib/notification/sse-events.ts
export function buildNotificationCreatedEvent(title: string, body?: string, link?: string): SSEvent {
    return { type: SSEventType.NOTIFICATION_CREATED, title, body: body ?? '', link } as SSEvent;
}

export function buildNotificationUpdatedEvent(): SSEvent {
    return { type: SSEventType.NOTIFICATION_UPDATED, title: 'Notification' } as SSEvent;
}
```

SSE handler:

```typescript
// packages/lib/src/core/notification/sse-handlers.ts
export function handleNotificationSSEvent(event: SSEvent, queryClient: QueryClient): boolean {
    if (!event?.type?.startsWith('notification:')) return false;

    invalidateNotifications(queryClient);
    invalidateUnreadCount(queryClient);

    if (event.type === SSEventType.NOTIFICATION_CREATED && 'body' in event && event.body) {
        toast(event.title, { description: event.body });
    }

    return true;
}
```

Register in `use-sse.ts` alongside the other domain handlers:

```typescript
handleNotificationSSEvent(event, queryClient);
```

### 3.E Mention Detection

#### Chat (server-side, Phase 2)

After `ChatRoom.postMessage()` inserts a message, extract mentioned emails and create notifications:

```typescript
// apps/api/src/lib/notification/mentions.ts
const EMAIL_REGEX = /(?:^|[\s,.])([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?=[\s,.]|$)/g;

export function extractMentionedEmails(content: string): string[] {
    const emails: string[] = [];
    let match;
    while ((match = EMAIL_REGEX.exec(content)) !== null) {
        emails.push(match[1].toLowerCase());
    }
    return [...new Set(emails)];
}
```

Notification flow added to `ChatRoom.postMessage()`:

1. `extractMentionedEmails(content)` → `["alice@eigen.is"]`
2. For each mentioned email:
    - `getUserByEmail()` → user record
    - Verify user has access to the chat (in ACL or is owner)
    - Skip if author === mentioned
    - `getHome(userId)` → recipient's Home
    - `home.notifications!.create({ type: 'mention', actorEmail, title, body, link, tag, sourceApp: 'chat' })`
    - `home.notify(buildNotificationCreatedEvent(title, body, link))`

This mirrors the existing `notifySharedUsers()` pattern in `ChatRoom`.

#### Docs (Tiptap extension, Phase 3)

Add `@tiptap/extension-mention` to the docs editor:

```typescript
// apps/docs/src/components/docs/extensions/mention.ts
export const EigenMention = Mention.configure({
    HTMLAttributes: { class: 'mention' },
    suggestion: {
        char: '@',
        items: ({ query }) => /* fetch from mention suggestion provider */,
        render: () => /* popup component reusing ChatPlayerSuggest pattern */,
    },
    renderText: ({ node }) => `@${node.attrs.label}`,
});
```

The mention node stores `{ id: email, label: displayName }` in the Yjs document. After inserting a mention node, the
frontend sends `POST /notification/:ownerId/mention` to trigger the notification server-side. This avoids parsing Yjs
diffs on the server, which would be fragile and tightly coupled to Tiptap's internal format.

#### Stickies (explicit mentions array, Phase 4)

Add an optional `mentions: string[]` field to the card `Y.Map`. When the frontend detects a new mention being added
(via the card settings dialog):

1. Write the email to the `mentions` array in Yjs
2. Send `POST /notification/:ownerId/mention` to create the notification

This explicitly tracks mentions without regex-parsing card text.

### 3.F Frontend

#### Query Keys & Data Hooks

```typescript
// packages/lib/src/core/notification/hooks/use-notifications.ts
export const notificationKeys = {
    all: ['notification'] as const,
    owner: (ownerId: string) => [...notificationKeys.all, ownerId] as const,
    list: (ownerId: string) => [...notificationKeys.owner(ownerId), 'list'] as const,
    unreadCount: (ownerId: string) => [...notificationKeys.owner(ownerId), 'unread-count'] as const,
};

export function useNotifications() {
    const { user } = useAuth();
    const ownerId = user?.id ?? '';
    return useQuery({
        queryKey: notificationKeys.list(ownerId),
        queryFn: async () => {
            const response = await notificationApi({ ownerId }).get({ query: { limit: '50' } });
            return response.data ?? [];
        },
        enabled: !!ownerId,
    });
}

export function useUnreadNotificationCount() {
    const { user } = useAuth();
    const ownerId = user?.id ?? '';
    return useQuery({
        queryKey: notificationKeys.unreadCount(ownerId),
        queryFn: async () => {
            const response = await notificationApi({ ownerId })['unread-count'].get();
            return response.data?.count ?? 0;
        },
        enabled: !!ownerId,
        refetchInterval: 5 * 60_000, // 5-min poll as SSE fallback
    });
}

export function useMarkNotificationRead() { /* useMutation, invalidate on success */ }
export function useMarkAllNotificationsRead() { /* useMutation, invalidate on success */ }

export function invalidateNotifications(queryClient: QueryClient) {
    queryClient.invalidateQueries({ queryKey: notificationKeys.all });
}
export function invalidateUnreadCount(queryClient: QueryClient) {
    queryClient.invalidateQueries({ queryKey: notificationKeys.all });
}
```

#### Notification Bell

Add to the topbar, next to `UserDropdown`:

```typescript
// packages/ui/src/components/layout/app/notification-bell.tsx
export function NotificationBell() {
    const { data: count } = useUnreadNotificationCount();
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

Insert in `topbar.tsx`:

```typescript
<div className="flex items-center px-4 shrink-0 gap-2">
    <NotificationBell />
    <UserDropdown rootRoute={rootRoute} />
</div>
```

#### Notification List

```typescript
// packages/ui/src/components/layout/app/notification-list.tsx
```

Standard scrollable list (max 400px height) with:

- Header: "Notifications" + "Mark all read" button
- Items: `UserAvatar` by `actorEmail` + title + body excerpt + `formatRelativeTime(createdAt)` + unread dot
- Click: mark read + navigate to `notification.link` via `window.location.href` (full page navigation, consistent
  with cross-app linking)

#### Mention Autocomplete

Extract the shared suggestion logic from `ChatPlayerSuggest` into a reusable hook:

```typescript
// packages/ui/src/components/layout/mentions/use-mention-suggestions.ts
export function useMentionSuggestions(query: string, members: ContactSuggestion[])
```

Merges ACL-based resource members with `useContactSuggestions` results, deduplicates by email. Used by:

- `ChatPlayerSuggest` (refactored to use the shared hook)
- Docs mention suggestion popup
- Stickies card mention dialog

## 4. Implementation Plan

### Phase 1: Notification Backend + Center UI

Notification storage, API, SSE events, bell icon with dropdown. No dependencies — can be built and tested
independently by manually creating notifications via the API.

**Create:**

- `apps/api/src/lib/notification/schema.ts`
- `apps/api/src/lib/notification/db-config.ts`
- `apps/api/src/lib/notification/notification.ts` (service + `getNotifications()`)
- `apps/api/src/lib/notification/sse-events.ts`
- `apps/api/src/routes/notification.ts`
- `packages/lib/src/types/notification.ts`
- `packages/lib/src/core/notification/hooks/use-notifications.ts`
- `packages/lib/src/core/notification/sse-handlers.ts`
- `packages/lib/src/core/notification/index.ts`
- `packages/ui/src/components/layout/app/notification-bell.tsx`
- `packages/ui/src/components/layout/app/notification-list.tsx`

**Modify:**

- `apps/api/src/lib/home/home.ts` — add `_notifications` field, getter, init call
- `apps/api/src/lib/home/user-home.ts` — instantiate `NotificationService`
- `apps/api/src/app.ts` — register `notificationRouter`
- `packages/lib/src/types/sse.ts` — add `NOTIFICATION_CREATED`, `NOTIFICATION_UPDATED`, `SSEventNotificationEvent`
  to the `SSEvent` union
- `packages/lib/src/core/sse/hooks/use-sse.ts` — register `handleNotificationSSEvent`
- `packages/lib/src/core/api.ts` — add `notificationApi`
- `packages/ui/src/components/layout/app/topbar.tsx` — add `NotificationBell`

### Phase 2: Chat Mentions → Notifications

When a chat message contains `@email`, create a notification for the mentioned user.

**Create:**

- `apps/api/src/lib/notification/mentions.ts` (email extraction utility)

**Modify:**

- `apps/api/src/lib/chat/chat.ts` — after `postMessage`, extract mentions and create notifications

Depends on Phase 1.

### Phase 3: Doc Inline Mentions

Tiptap `@mention` node in the docs editor with autocomplete and notification.

**Create:**

- `apps/docs/src/components/docs/extensions/mention.ts` (Tiptap mention extension config)
- `apps/docs/src/components/docs/extensions/mention-suggestion.tsx` (popup component)
- `packages/ui/src/components/layout/mentions/use-mention-suggestions.ts` (shared hook)

**Modify:**

- `apps/docs/src/components/docs/editor.tsx` — add `EigenMention` extension

**Install:** `@tiptap/extension-mention`

Depends on Phase 1.

### Phase 4: Stickies Card Mentions

Mention users in stickies card descriptions.

**Modify:**

- Stickies card settings dialog — add mention autocomplete to description
- Stickies card types (`CardItem`) — add optional `mentions: string[]` field
- Stickies board hook — persist mentions in Yjs, send notification via POST endpoint

Depends on Phase 1.

## 5. Design Decisions

### Mention identifier: email

Store email as the stable identifier (display names change). Autocomplete shows name + email. Rendering shows display
name with avatar, reusing the existing `InlineEmail` component.

### Notification storage: per-user SQLite

`eigen.notifications/notifications.db` inside the Home directory. Consistent with the per-user Home pattern
(`eigen.mail/`, `eigen.contacts/`, `eigen.calendar/`). No cross-user queries needed. Scales to multi-server by keeping
data co-located with the user's Home.

### Mentioning non-members: disallowed

The autocomplete only shows users who already have access (in the ACL or is the owner). Mentioning does not
auto-invite — first share the resource, then mention. Exception: in team context, all team members have implicit
access and appear in autocomplete even without explicit ACL entries.

### Deduplication: UNIQUE tag + upsert

One notification per tag. New notification with matching tag updates the existing row (`createdAt` bumped, `body`
refreshed, `read` reset to `false`). Prevents spam from multiple mentions in the same resource.

### Notification retention

Auto-delete read notifications after 30 days and all notifications after 90 days. Run cleanup during
`NotificationService.init()`.

### Cross-app navigation

Notification `link` fields contain full URLs (e.g., `getChatRoomUrl(...)`, `getDocUrl(...)`). Clicking navigates via
`window.location.href`. Consistent with how app switching already works (topbar app dropdown uses `<a href>`).

### Doc comments vs doc inline mentions

Different features, same notification outcome through different paths:

- **Comments** (existing): embedded eigenchat → mentions detected by chat mention extraction (Phase 2)
- **Inline mentions** (new): Tiptap `Mention` node → notification via `POST /mention` endpoint (Phase 3)

### Doc/stickies mention trigger: frontend POST

The frontend sends `POST /notification/:ownerId/mention` after inserting a mention. The backend validates access
before creating the notification. This avoids parsing Yjs diffs server-side, which would be fragile and tightly
coupled to Tiptap's internal format. The `tag` field prevents duplicate notifications if a user undoes and re-inserts
a mention.

## 6. Future Extensions

- **Migrate existing toasts**: Replace ephemeral toasts (mail received, share changes, calendar invites) with
  persisted notifications. Gradual migration — both coexist during transition.
- **Notification preferences**: Mute by resource (tag-based), disable by type, per-user settings table.
- **Desktop notifications**: Web Push API integration with the notification center.

## 7. Files Reference

| Category              | File                                                                    | Purpose                                          |
|-----------------------|-------------------------------------------------------------------------|--------------------------------------------------|
| **Existing SSE**      | `packages/lib/src/types/sse.ts`                                         | Event type definitions                           |
| **Existing SSE**      | `packages/lib/src/core/sse/hooks/use-sse.ts`                            | Event dispatcher                                 |
| **Existing SSE**      | `apps/api/src/lib/home/home.ts`                                         | `notify()` method, domain service fields         |
| **Existing SSE**      | `apps/api/src/routes/sse.ts`                                            | SSE stream endpoint                              |
| **Existing Chat**     | `apps/api/src/lib/chat/chat.ts`                                         | `ChatRoom.postMessage()` + `notifySharedUsers()` |
| **Existing Chat**     | `packages/ui/src/components/layout/chat/chat-player-suggest.tsx`        | @ autocomplete                                   |
| **Existing Chat**     | `packages/ui/src/components/layout/chat/chat-utils.ts`                  | `getAtSuggestQuery()`                            |
| **Existing Chat**     | `packages/ui/src/components/layout/chat/chat-message-list.tsx`          | `InlineEmail` rendering                          |
| **Existing Docs**     | `apps/docs/src/components/docs/editor.tsx`                              | Tiptap editor + extensions                       |
| **Existing Docs**     | `apps/docs/src/components/docs/extensions/comment-mark.ts`              | Comment mark extension                           |
| **Existing Stickies** | `apps/stickies/src/components/stickies/types.ts`                        | `CardItem` type                                  |
| **Existing Stickies** | `apps/stickies/src/components/stickies/hooks/use-board.ts`              | Yjs board hook                                   |
| **Existing Users**    | `apps/api/src/lib/user/user.ts`                                         | `getUserByEmail()`                               |
| **Existing ACL**      | `apps/api/src/lib/drive/acl-propagation.ts`                             | `resolveACLUserIds()`                            |
| **Existing Contacts** | `packages/ui/src/components/layout/contacts/use-contact-suggestions.ts` | Contact autocomplete                             |
| **Existing Topbar**   | `packages/ui/src/components/layout/app/topbar.tsx`                      | Where bell icon goes                             |
| **Existing API**      | `packages/lib/src/core/api.ts`                                          | Treaty client, app URL helpers                   |
