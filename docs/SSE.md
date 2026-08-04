# Server-Sent Events (SSE)

> **TLDR**: Real-time cache invalidation. The backend emits events via `home.broadcast()` → SSE stream → frontend
> handlers invalidate the TanStack Query cache. Events carry only what invalidation needs — no display text, no full
> domain objects. Toasts come exclusively from the notification center's own SSE event.

## Flow

```
API Mutation → home.broadcast(event)  → SSE Stream → Client
                                                        └── SSE Handler → QueryClient.invalidateQueries()

Notification → home.notifications.persist({...})
                 └── broadcasts notification:created SSE → toast + invalidate notification queries
```

SSE is personal-only — each user subscribes to their own Home's event stream. The SSE keepalive (every 15s)
re-acquires the Home via `getHome()` (which calls `touch()`), preventing idle destruction and self-healing if the
Home was destructed externally. An initial keepalive is sent immediately in `start()` to prevent Apache proxy
timeouts. The frontend `useSSE` hook auto-reconnects after HTTP errors (e.g. 502) with exponential backoff
(1s initial, doubling up to 30s max, with 20% jitter).

Events fall into two categories:

- **Cache invalidation**: domain events (drive, mail, calendar, chat, contacts) carry only IDs needed for
  `queryClient.invalidateQueries()`. No toasts, no display text
- **Notification**: `notification:created` carries the toast text plus the tag pair its View link needs (see Event
  Design). Created by `NotificationCenter.persist()`, which also writes to the per-user notifications database

See [NOTIFICATIONS.md](NOTIFICATIONS.md) for the toast pattern, [NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md)
for the notification center architecture.

## Where the code lives

Types live in `packages/lib/src/types/sse.ts`. Per domain, the backend builder is
`apps/api/src/lib/[domain]/sse-events.ts` and the frontend handler is
`packages/lib/src/core/[domain]/sse-handlers.ts`, registered in `packages/lib/src/core/sse/hooks/use-sse.ts` (mounted
by `packages/ui/src/components/layout/sse-provider/sse-provider.tsx`). The stream itself is
`apps/api/src/routes/sse.ts` plus `home.broadcast()` in `apps/api/src/lib/home/home.ts`.

## Event Design

Events are minimal — only what the frontend handler needs for cache invalidation:

- Drive: `path.ownerId`, `path.mountId`, `path.id`, `path.parentId`, `path.mimeType`, optional `oldParentId`
- Mail: `mail.messageId`, `mail.mailbox`, optional `mail.toMailbox`
- Calendar: `ownerId`
- Chat: `chat.chatId`, `chat.ownerId`, `chat.mountId`
- Contacts: `contactId` or `labelId`
- Notification: `title`, optional `body`, optional `notificationType` + `tag` — the last two let the toast's **View**
  action resolve the same deep link the bell uses (`resolveNotificationLink`), without shipping the whole row
- Space: just the event type
- Team: `teamId`

`notification:created` has a sibling, `notification:changed` (bare `{type}`), which tells the bell to refetch its
count and list without toasting — emitted after a read or dismiss.

Type prefixes: `drive:`, `mail:`, `contacts:`, `chat:`, `calendar:`, `notification:`, `space:`, `team:`

## Adding SSE to a New Domain

1. **Define types** in `packages/lib/src/types/sse.ts` — add to `SSEventType`, create event type, add to `SSEvent` union
2. **Create builder** at `apps/api/src/lib/[domain]/sse-events.ts` — `build[Domain]Event()` returning minimal data
3. **Emit from business logic** — call `this.home.broadcast(buildEvent(...))`
4. **Create handler** at `packages/lib/src/core/[domain]/sse-handlers.ts` — switch on event type, call invalidation
   functions. Do NOT add toast calls — toasts come from the notification center
5. **Register handler** in `packages/lib/src/core/sse/hooks/use-sse.ts`

## Implemented Domains

Drive, Mail, Contacts, Chat, Calendar and Notification are complete: builder, handler, and backend emits. Space and
Team have types and frontend handlers registered but no builder and no backend emit yet — the handlers are wired up
in advance, so adding the emit is all that is needed.
