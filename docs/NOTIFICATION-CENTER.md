# Notification Center

> **TLDR**: Persistent notification bell/dropdown in topbar. `NotificationCenter` is a Home domain service (like
> Calendar, Contacts) with per-user SQLite database. `home.notify()` renamed to `home.broadcast()` (SSE push). Toast
> notifications removed from individual SSE handlers — toasts now come exclusively from the notification SSE handler
> when a new notification arrives. SSE events stripped to minimal cache-invalidation payloads across all domains.

## Architecture

### NotificationCenter as Home Domain Service

Follows the same pattern as Calendar, Contacts, Mail:

```
Home
├── _drive (Drive)                  → mounts/default/
├── _contacts (Contacts)            → eigen.contacts/contacts.db
├── _mail (Maildir)                 → eigen.mail/mail.db
├── _calendar (Calendar)            → eigen.calendar/calendar.db
└── _notifications (NotificationCenter) → eigen.notifications/notifications.db
```

**User-only** — notifications live in `UserHome`, not `TeamHome`. Team actions generate notifications in each affected
user's Home.

### SSE Rename: `home.notify()` → `home.broadcast()`

The old `home.notify()` name was ambiguous — it broadcasts SSE events for cache invalidation, not user-facing
notifications. Renamed to `home.broadcast()` to clarify that it pushes events to SSE listeners.

The new flow for cross-user events:

```
1. Something happens (e.g., drive share)
2. home.notifications.persist({...})   → writes to notifications.db + broadcasts notification SSE event
3. home.broadcast(domainEvent)         → existing SSE push for cache invalidation
```

### SSE Event Slim-Down

All SSE events stripped to carry only the minimum data needed for frontend cache invalidation. No more `title`, `body`,
`tag`, `link`, `SSEventNotification` mixin, or full domain objects (`DrivePath`, `ChatMessage`, etc.) on SSE events.
The notification SSE event carries only `title` and optional `body` for the toast.

### Toast Migration

**Before**: 7 toast calls scattered across 3 SSE handlers (drive, mail, calendar).
**After**: One `handleNotificationSSEvent()` handler shows toasts when `notification:created` arrives.

Removed toast calls:

| Handler                    | Events                                                             |
|----------------------------|--------------------------------------------------------------------|
| `drive/sse-handlers.ts`    | `DRIVE_ACL_SHARED`, `DRIVE_ACL_UNSHARED`                           |
| `mail/sse-handlers.ts`     | `MAIL_RECEIVED`                                                    |
| `calendar/sse-handlers.ts` | `CALENDAR_SHARED`, `CALENDAR_UNSHARED`, `CALENDAR_INVITE_RECEIVED` |

## Storage

```
data/home/{userId}/eigen.notifications/notifications.db
```

## Schema

```typescript
// apps/api/src/lib/notification-center/schema.ts
export const notifications = sqliteTable('notifications', {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    actorEmail: text('actorEmail'),
    title: text('title').notNull(),
    body: text('body'),
    tag: text('tag').unique(),
    read: integer('read', {mode: 'boolean'}).notNull().default(false),
    createdAt: integer('createdAt', {mode: 'timestamp'}).notNull().default(sql`(unixepoch())`),
});
```

The `tag` column with `UNIQUE` constraint enables `INSERT ... ON CONFLICT(tag) DO UPDATE` upsert. Multiple mentions in
the same chat produce one notification (refreshed, not duplicated). `NULL` tags are exempt (SQLite treats NULLs as
distinct).

## API Routes

Router: `apps/api/src/routes/notification.ts`, prefix `/notifications/`, all `{auth: true}`.

```
GET    /notifications/:ownerId                    Recent notifications (paginated)
GET    /notifications/:ownerId/unread-count        Badge count
PATCH  /notifications/:ownerId/:id/read            Mark one as read
POST   /notifications/:ownerId/mark-all-read       Mark all as read
DELETE /notifications/:ownerId/:id                 Dismiss
```

## Notification Sources

| Source                 | Where persisted                          | Type                        | Tag format                                          |
|------------------------|------------------------------------------|-----------------------------|-----------------------------------------------------|
| Drive share            | `Drive.receiveACLChange()` (new share)   | `share`                     | `share:{ownerId}:{mountId}:{pathId}`                |
| Drive unshare          | `Drive.receiveACLChange()` (removed)     | `unshare`                   | (no tag)                                            |
| Calendar share         | `Calendar.receiveShare()`                | `calendar-share`            | `calendar-share:{calId}:{ownerUserId}`              |
| Calendar unshare       | `Calendar.removeShare()`                 | `calendar-unshare`          | (no tag)                                            |
| Calendar invite        | `invite-propagation.ts`                  | `calendar-invite`           | `calendar-invite:{eventId}`                         |
| Calendar invite update | `invite-propagation.ts`                  | `calendar-invite-updated`   | `calendar-invite:{eventId}`                         |
| Calendar invite cancel | `invite-propagation.ts`                  | `calendar-invite-cancelled` | `calendar-invite:{eventId}`                         |
| Incoming mail          | `Maildir` sync                           | `mail`                      | `mail:{messageId}`                                  |
| Chat @mention          | `ChatRoom.postMessage()`                 | `mention-chat`              | `mention:{ownerId}:{mountId}:{chatId}:{email}`      |
| Comment @mention       | `ChatRoom.postMessage()` (embedded chat) | `mention-comment`           | `mention:{ownerId}:{mountId}:{containerId}:{email}` |

`actorEmail` is set on all sources — the sharer, organizer, mail sender, or mention author.

## Frontend

### Topbar Bell

`NotificationBell` in topbar between document title and user dropdown. Shows unread count badge (fetched always).
Notification list fetched lazily only when popover opens.

### Link Resolution

Links are constructed client-side based on notification `type` and `tag`:

- `share`, `mention-chat`, `mention-comment` → async: fetches `DrivePath` via API on click, routes to correct app
  using `getDocumentUrl()` (eigendoc → Docs, eigenchat → Chat, etc.) or falls back to Drive
- `calendar-*` → `getCalendarAppUrl()`
- `mail` → `getMailAppUrl('box/inbox')`
- `unshare`, `calendar-unshare` → not clickable (resource no longer accessible)

No URLs stored in the database — `tag` contains the IDs, frontend resolves using `get*AppUrl()` helpers from `api.ts`.

### Display Names

Eigen extensions (`.eigendoc`, `.eigenstickies`, etc.) are stripped from notification titles using
`stripEigenExtension()` from `packages/lib/src/types/drive.ts`.

### SSE Handler

`handleNotificationSSEvent()` listens for `notification:created` → shows toast + invalidates notification queries.

### Future: Space Page

A full notification page in Space app can be added later with search, filtering, and pagination.

## SSE Event

```typescript
type SSEventNotificationCreated = {
    type: typeof SSEventType.NOTIFICATION_CREATED;
    title: string;
    body?: string;
};
```

Minimal — only what the toast needs. The notification list is fetched via API, not populated from SSE.

## Files

| File                                                            | Purpose                          |
|-----------------------------------------------------------------|----------------------------------|
| `packages/lib/src/types/notification.ts`                        | Shared `Notification` type       |
| `packages/lib/src/types/drive.ts`                               | `stripEigenExtension()` utility  |
| `packages/lib/src/core/date.ts`                                 | `formatTimeAgo()` utility        |
| `apps/api/src/lib/notification-center/schema.ts`                | Drizzle schema                   |
| `apps/api/src/lib/notification-center/db-config.ts`             | DatabaseConfig + migration       |
| `apps/api/src/lib/notification-center/notification-center.ts`   | Domain service class             |
| `apps/api/src/lib/notification-center/sse-events.ts`            | SSE event builder                |
| `apps/api/src/routes/notification.ts`                           | API routes                       |
| `packages/lib/src/core/notification/hooks/use-notifications.ts` | Query + mutation hooks           |
| `packages/lib/src/core/notification/sse-handlers.ts`            | SSE handler (toast + invalidate) |
| `packages/ui/src/components/layout/app/notification-bell.tsx`   | Topbar bell + popover            |
