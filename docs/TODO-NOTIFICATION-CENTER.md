# TODO: Notification Center

> **Goal**: Replace ephemeral toasts with a persistent notification bell/dropdown in the topbar. Per-user SQLite
> database
> stores notifications. SSE delivers real-time events. Existing `SSEventNotification` mixin (`body`, `tag?`, `link?`) on
> SSE events is designed for this — `isSSEventNotification()` already identifies which events to persist.

## Current State

- SSE events with `SSEventNotification` mixin carry `body`, `tag`, `link` fields (see [SSE.md](SSE.md))
- Cross-user notification works: `ChatRoom.notifySharedUsers()`, `propagateACLChange()`,
  `notifySharedCalendarUsers()`, `propagateInvitation()` all call `home.notify()` on recipient Homes
- Curated events already show ephemeral toasts in SSE handlers (see [NOTIFICATIONS.md](NOTIFICATIONS.md))
- No persistence — missed notifications are lost

## Proposed Architecture

### Storage

Per-user SQLite database following the Home pattern:

```
data/home/{userId}/eigen.notifications/notifications.db
```

### Schema

```typescript
// apps/api/src/lib/notification/schema.ts
export const notifications = sqliteTable('notifications', {
    id: text('id').primaryKey(),
    type: text('type').notNull(),                                       // 'mention' | 'share' | 'invite' | ...
    actorEmail: text('actorEmail').notNull(),                           // who triggered it
    title: text('title').notNull(),                                     // "Alice shared 'Report.pdf' with you"
    body: text('body'),                                                 // message excerpt
    link: text('link'),                                                 // deep link URL
    tag: text('tag').unique(),                                          // dedup key (NULL = no dedup)
    sourceApp: text('sourceApp'),                                       // 'chat' | 'drive' | 'calendar' | ...
    read: integer('read', {mode: 'boolean'}).notNull().default(false),
    createdAt: integer('createdAt', {mode: 'timestamp'}).notNull().default(sql`(unixepoch())`),
});
```

The `tag` column with `UNIQUE` constraint enables upsert-based deduplication. Multiple messages in the same chat
produce one notification (refreshed, not duplicated). `NULL` tags are exempt (SQLite treats NULLs as distinct).

Tag format examples:

- `chat:{ownerId}:{mountId}:{chatId}`
- `share:{ownerId}:{mountId}:{pathId}`
- `calendar:{ownerId}:{calendarId}:{eventId}`

### Backend Flow

```
Existing SSE event with SSEventNotification mixin
    → NotificationService.persist(userId, event)    // new: write to notifications.db
    → home.notify(event)                            // existing: push via SSE
```

### API Routes

```
GET    /notifications/:ownerId                      Unread + recent (paginated)
GET    /notifications/:ownerId/unread-count          Badge count
PATCH  /notifications/:ownerId/:id/read              Mark as read
POST   /notifications/:ownerId/mark-all-read         Mark all as read
DELETE /notifications/:ownerId/:id                   Dismiss
```

### Frontend

- `NotificationBell` in topbar — shows unread count badge
- Dropdown list with avatar, title, body excerpt, timestamp, click-to-navigate via `link`
- SSE handler appends new notifications in real-time (no page refresh needed)
- Mark as read on click/dismiss

### Notification Sources (initial)

| Source          | Event                          | Tag                                    |
|-----------------|--------------------------------|----------------------------------------|
| Drive share     | `drive:acl-shared`             | `share:{ownerId}:{mountId}:{pathId}`   |
| Calendar invite | `calendar:invite-received`     | `calendar:{ownerId}:{calId}:{eventId}` |
| Incoming mail   | `mail:new`                     | `mail:{ownerId}:{mailId}`              |
| Chat mention    | `chat:message-posted` (with @) | `chat:{ownerId}:{mountId}:{chatId}`    |

## Related: @Mentions

The [TODO-MENTIONS.md](TODO-MENTIONS.md) design extends this with cross-app @mention detection (chat, docs, stickies).
Mentions produce notifications using this same notification center infrastructure. Implement the notification center
first, then add mention detection as a follow-up.

## Files to Create

| File                                                            | Purpose        |
|-----------------------------------------------------------------|----------------|
| `apps/api/src/lib/notification/schema.ts`                       | Drizzle schema |
| `apps/api/src/lib/notification/db-config.ts`                    | DatabaseConfig |
| `apps/api/src/lib/notification/notification-service.ts`         | CRUD + persist |
| `apps/api/src/routes/notification.ts`                           | API routes     |
| `packages/lib/src/core/notification/hooks/use-notifications.ts` | Query hooks    |
| `packages/ui/src/components/layout/app/notification-bell.tsx`   | Topbar UI      |

## Existing Infrastructure to Leverage

- `SSEventNotification` mixin in `packages/lib/src/types/sse.ts`
- `isSSEventNotification()` type guard
- `home.notify()` for SSE delivery
- `ManagedDatabase` for SQLite lifecycle
- `UserAvatar` for actor display
