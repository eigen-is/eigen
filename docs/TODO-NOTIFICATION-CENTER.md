# Notification Center

> **TLDR**: Persistent notification bell/dropdown in topbar. `NotificationCenter` is a Home domain service (like
> Calendar, Contacts) with per-user SQLite database. `home.notify()` renamed to `home.broadcast()` (SSE push). Toast
> notifications removed from individual SSE handlers — toasts now come exclusively from the notification SSE handler
> when a new notification arrives.

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
    type: text('type').notNull(),                                       // 'share' | 'unshare' | 'invite' | 'mail' | ...
    actorEmail: text('actorEmail'),                                     // who triggered it (null for system)
    title: text('title').notNull(),                                     // "Report.pdf was shared with you"
    body: text('body'),                                                 // optional extra detail
    link: text('link'),                                                 // deep link path
    tag: text('tag').unique(),                                          // dedup key (NULL = no dedup)
    read: integer('read', {mode: 'boolean'}).notNull().default(false),
    createdAt: integer('createdAt', {mode: 'timestamp'}).notNull().default(sql`(unixepoch())`),
});
```

The `tag` column with `UNIQUE` constraint enables upsert-based deduplication. `NULL` tags are exempt (SQLite treats
NULLs as distinct).

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

| Source           | Where persisted                      | Tag format                           |
|------------------|--------------------------------------|--------------------------------------|
| Drive share      | `Drive.receiveACLChange()` (shared)  | `share:{ownerId}:{mountId}:{pathId}` |
| Drive unshare    | `Drive.receiveACLChange()` (removed) | (no tag — always new)                |
| Calendar share   | `Calendar.receiveShare()`            | `cal-share:{calId}:{ownerUserId}`    |
| Calendar unshare | `Calendar.receiveUnshare()`          | (no tag)                             |
| Calendar invite  | `invite-propagation.ts`              | `cal-invite:{eventId}`               |
| Incoming mail    | `Maildir.receive()`                  | `mail:{messageId}`                   |

## Frontend

### Topbar Bell

`NotificationBell` in topbar between document title and user dropdown. Shows unread count badge. Click opens popover
with latest notifications. Each notification: avatar + title + timestamp. Click navigates via `link`, marks as read.

### SSE Handler

`handleNotificationSSEvent()` listens for `notification:created` → shows toast + invalidates notification queries.

### Future: Space Page

A full notification page in Space app can be added later with search, filtering, and pagination.

## SSE Events

```typescript
// Added to SSEventType
NOTIFICATION_CREATED: 'notification:created'

// New SSE event type
type SSEventNotificationCreated = SSEventBase & {
    type: typeof SSEventType.NOTIFICATION_CREATED;
    notification: Notification;
};
```

## Files

| File                                                            | Purpose                          |
|-----------------------------------------------------------------|----------------------------------|
| `packages/lib/src/types/notification.ts`                        | Shared `Notification` type       |
| `apps/api/src/lib/notification-center/schema.ts`                | Drizzle schema                   |
| `apps/api/src/lib/notification-center/db-config.ts`             | DatabaseConfig + migration       |
| `apps/api/src/lib/notification-center/notification-center.ts`   | Domain service class             |
| `apps/api/src/lib/notification-center/sse-events.ts`            | SSE event builder                |
| `apps/api/src/routes/notification.ts`                           | API routes                       |
| `packages/lib/src/core/notification/hooks/use-notifications.ts` | Query + mutation hooks           |
| `packages/lib/src/core/notification/sse-handlers.ts`            | SSE handler (toast + invalidate) |
| `packages/ui/src/components/layout/app/notification-bell.tsx`   | Topbar bell + popover            |
