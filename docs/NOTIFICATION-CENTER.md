# Notification Center

> **TLDR**: `NotificationCenter` is a Home domain service (like Calendar, Contacts) backed by a per-user SQLite
> database. Producers call `home.notifications.persist({...})`, which upserts on `tag` (so repeats coalesce into one
> refreshed row) and broadcasts a `notification:created` SSE event. The frontend renders the stored rows in the
> topbar bell and toasts the SSE event. Row strings and link targets: [ACTIVITY-ROWS.md](ACTIVITY-ROWS.md).

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

A cross-user event does two separate things: `home.notifications.persist({...})` writes the row and broadcasts the
`notification:created` SSE event (toast + bell), while `home.broadcast(domainEvent)` pushes the domain event that
invalidates query caches. Toasts come only from the notification handler — domain SSE handlers never toast.

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
    details: text('details', {mode: 'json'}).$type<NotificationDetails | null>(), // v2
});
```

The `tag` column with `UNIQUE` constraint enables `INSERT ... ON CONFLICT(tag) DO UPDATE` upsert. Multiple mentions in
the same chat produce one notification (refreshed, not duplicated). `NULL` tags are exempt (SQLite treats NULLs as
distinct).

`details` (**v2 migration** — `ALTER TABLE notifications ADD COLUMN details TEXT`) holds a typed JSON blob keyed by
notification type (`NotificationDetailsMap` in `packages/lib/src/types/notification.ts`): the activity-row secondary
line plus deep-link parameters — `mail.{mailId, snippet}`, `calendar-invite(-updated).startTime`,
`file-event.{secondary, cardId, chatName, pathType}`, `access-request.{message, pathType}`, `*.pathType`. Additive and
nullable — pre-v2 rows read `null` and degrade to a plain title + body row. `PersistInput` is a discriminated write
input (`NotificationPersistInput`): `details` is allowed exactly for the types that define a `NotificationDetailsMap`
entry.

### Coalesce flag

`persist()` accepts an optional `coalesce: boolean` on `PersistInput`. When set and the tag-upsert hit an existing
row updated within the last 30 s, the SSE broadcast is skipped — the DB row still updates (title, `read = false`,
`createdAt`), so the bell stays correct, but rapid events on one tag don't toast-storm. The window slides: a
sustained sub-30 s event stream suppresses broadcasts for its whole duration; the bell catches up on the next
refetch. Only `file-event` notifications set it today; all other callers keep the always-broadcast default.

## Row content contract (unified activity)

The bell and the Drive *Recent activity* panel render the same row anatomy through one shared
`ActivityRow` (`packages/ui/src/components/activity-row.tsx`). Every producer persists to one contract:

- **`title` = the action sentence** — who did what, where (`New mail from Hanne Oberman`,
  `Mark added a card to "Eigen Feedback"`). Rendered as the small muted first line.
- **`body` = the primary content** — the thing the user scans for: mail subject, card title, `old → new` rename,
  item name. Rendered as the normal-size second line.
- **`details` = structured extras** — the optional secondary line (mail snippet, invite start time, `in To Do`) plus
  the deep-link parameters. Never a display string the toast needs.

The server composes file-event strings with `describeFileEvent` (`packages/lib/src/types/file-history.ts`), the
same phrasing the activity panel renders with; the client mirrors non-file notifications with `describeNotification`
(`packages/lib/src/core/notification/describe.ts`), which derives the secondary line from `details` (e.g. the invite
start time is formatted client-side with the `en-GB` locale, not baked into a stored string). Chat-derived bodies
(mentions, chat messages, comment previews) are persisted raw and normalized at render time by `formatChatPreview`
(`packages/lib/src/core/chat/format-preview.ts`): emote wire syntax becomes the chat-style sentence, emails resolve
to display names — so the stored `body` intentionally differs from what the bell/toast/panel show. Old rows without
`details` render title + body only. Per-type strings and link targets: [ACTIVITY-ROWS.md](ACTIVITY-ROWS.md).

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
| Drive share            | `Drive.receiveSharedPathChange()` (new share)   | `share`                     | `share:{ownerId}:{mountId}:{pathId}`                |
| Drive unshare          | `Drive.receiveSharedPathChange()` (removed)     | `unshare`                   | (no tag)                                            |
| Calendar share         | `Calendar.receiveShare()`                | `calendar-share`            | `calendar-share:{calId}:{ownerUserId}`              |
| Calendar unshare       | `Calendar.removeShare()`                 | `calendar-unshare`          | (no tag)                                            |
| Calendar invite        | `invite-propagation.ts`                  | `calendar-invite`           | `calendar-invite:{eventId}:{startTime}`             |
| Calendar invite update | `invite-propagation.ts`                  | `calendar-invite-updated`   | `calendar-invite:{eventId}:{startTime}`             |
| Calendar invite cancel | `invite-propagation.ts`                  | `calendar-invite-cancelled` | `calendar-invite:{eventId}:{startTime}`             |
| Incoming mail          | `Maildir` sync                           | `mail`                      | `mail:new` (constant — coalesces all incoming mail into one refreshed row) |
| Chat @mention          | `ChatRoom.postMessage()`                 | `mention-chat`              | `mention:{ownerId}:{mountId}:{chatId}:{email}`      |
| Comment @mention       | `ChatRoom.postMessage()` (embedded chat) | `mention-comment`           | `mention:{ownerId}:{mountId}:{containerId}:{name}:{email}` |
| Chat activity          | `ChatRoom.postMessage()` (regular msg)   | `chat-message`              | `chat-message:{ownerId}:{mountId}:{chatId}`         |
| Comment activity       | `ChatRoom.postMessage()` (embedded chat) | `comment-reply`             | `comment-reply:{ownerId}:{mountId}:{containerId}:{name}` |
| Comment assignment     | assignee PATCH route (`routes/collab.ts`) | `assigned`                 | `assigned:{ownerId}:{mountId}:{pathId}:{chatName}` — only on a real change to a registered non-self assignee |
| Access request         | `propagateAccessRequest()` (`lib/drive/access-request-propagation.ts`; the route delegates) | `access-request` | `access-request:{ownerId}:{mountId}:{pathId}:{email}` |
| File event (watch)     | `FileHistory.notifyWatchers()` via relay | `file-event`                | `file-event:{ownerId}:{mountId}:{pathId}` — burst events (`created`/`uploaded`/`copied`) tag the parent folder; always sent with `coalesce: true`. See [AGENTS.md § File history + watch](../AGENTS.md) |

`actorEmail` is set on all sources — the sharer, organizer, mail sender, mention author, or access requester.

What deliberately does NOT create a notification: your own actions (every source skips the actor), and plain
collaborator edits — they would be too spammy, so document changes only surface through watches (`file-event`)
and the activity panel.

## Frontend

### Topbar Bell

`NotificationBell` in topbar between document title and user dropdown. Shows unread count badge (fetched always).
Notification list fetched lazily only when popover opens.

### Link Resolution

Links are constructed client-side based on notification `type` and `tag`:

- `share`, `mention-chat`, `mention-comment`, `comment-reply`, `assigned` → async: fetches `DrivePath` via API on click, routes to correct app
  using `getDocumentUrl()` (eigendoc → Docs, eigenchat → Chat, etc.) or falls back to Drive
- `access-request` → async: fetches `DrivePath` to resolve parent folder, navigates to Drive at
  `/fs/{ownerId}/{mountId}/{parentId}?sharePathId={pathId}&shareEmail={email}`, auto-opening the share dialog
  with the requester's email pre-filled
- `calendar-invite`, `calendar-invite-updated`, `calendar-invite-cancelled` → month view
  `view/month/{from}/{to}?eventId={eventId}`, the month derived from the tag's `{startTime}` (falls back to
  `getCalendarAppUrl()` when the tag has no start time)
- `calendar-share`, `calendar-unshare` → `getCalendarAppUrl()`
- `mail` → `getMailAppUrl('box/inbox?mailId={id}')` when `details.mailId` is set (v2), else bare `box/inbox`
- `file-event` → async: fetches `DrivePath`; collab/chat docs open in their app via `getDriveItemUrl()`, appending
  `?card={cardId}` or `?chat={chatName}` when `details` carries them (deep-links to the exact card / comment thread);
  plain files and folders land on Drive at `/fs/{ownerId}/{mountId}/{parentId}?pid={pathId}&showHistory=1` (item
  selected, details sidebar open, Recent Activity scrolled into view)
- `unshare` → not clickable (resource no longer accessible)

Link resolution logic lives in `packages/lib/src/core/notification/resolve-link.ts`. No URLs stored in the
database — `tag` contains the IDs, frontend resolves using `get*AppUrl()` helpers from `api.ts`.

### Display Names

Eigen extensions (`.eigendoc`, `.eigenstickies`, etc.) are stripped from notification titles server-side using
`stripEigenExtension()` (from `packages/lib/src/types/drive.ts`) before persisting. The bell component displays
the stored title as-is.

### Actor Avatars

`UserAvatar` (from `packages/ui/src/components/user/user-avatar.tsx`) renders the `actorEmail` avatar next to each
notification item.

### Bell app badge

`NotificationBadge` (`packages/ui/src/components/layout/app/notification-badge.tsx`) overlaps a small circular
app-colored badge on the avatar's bottom-right so the source app reads pre-attentively. It maps the notification
`type` — plus `details.pathType` when the row concerns a specific drive item — to an app icon + color from the
single sources (`EIGEN_DOC_ICONS`, `getEigenDocInfoByType().colorVar`, the `--app-*-color` vars, and lucide
`Mail`/`Calendar`/`MessageSquare`/`Folder`/`File` for the non-eigendoc cases). Rows without a `pathType` fall back
per type (chat → chat glyph, share/file-event → folder on `--app-drive-color`), never blank. The badge is
**bell-only** — the *Recent activity* panel is already scoped to one item, so it renders no badge.

### SSE Handler

`handleNotificationSSEvent()` listens for `notification:created` → shows toast + invalidates notification queries.

## SSE Event

```typescript
type SSEventNotificationCreated = {
    type: typeof SSEventType.NOTIFICATION_CREATED;
    title: string;
    body?: string;
    notificationType?: string; // the notification's `type` — lets the toast resolve a "View" link
    tag?: string;              // the notification's tag — the other half of link resolution
};
```

`title`/`body` feed the toast (`toast(title, { description: body })`); `notificationType` + `tag` let the toast's
**View** action resolve the same target the bell uses (`resolveNotificationLink({ type, tag, details: null })`) and
open it in a new tab. Still minimal — no full row, no `details` (so the View link uses only tag-derivable targets;
`?card=`/`?mailId=` come from the fetched row in the bell). The list is fetched via API, not populated from SSE. A
sibling `SSEventNotificationChanged` (`notification:changed`, bare `{ type }`) tells the bell to refetch its
count/list without toasting (e.g. after a read or dismiss).

## Where the code lives

Backend: `apps/api/src/lib/notification-center/` (schema, db-config with the v2 `details` migration, the
`NotificationCenter` service, SSE builder) and `apps/api/src/routes/notification.ts`. Frontend:
`packages/lib/src/core/notification/` (hooks, SSE handler, `resolve-link.ts`, `describe.ts`), shared types in
`packages/lib/src/types/notification.ts`, and the bell + shared row in
`packages/ui/src/components/layout/` (`activity-row.tsx`, `app/notification-bell.tsx`, `app/notification-badge.tsx`).
