# Server-Sent Events (SSE)

> **TLDR**: Real-time cache invalidation. Backend emits events via `home.broadcast()` → SSE stream → frontend handlers
> invalidate TanStack Query cache. User-facing notifications (toasts) come exclusively from the notification center's
> SSE event. SSE events carry only the minimum data needed for cache invalidation — no display text, no full domain
> objects. Add new domain SSE: define types in `packages/lib/src/types/sse.ts`, create builder in
> `apps/api/src/lib/[domain]/sse-events.ts`, create handler in `packages/lib/src/core/[domain]/sse-handlers.ts`,
> register in `use-sse.ts`.

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
- **Notification**: `notification:created` carries `title` + optional `body` for the toast. Created by
  `NotificationCenter.persist()` which also writes to the per-user notifications database

See [NOTIFICATIONS.md](NOTIFICATIONS.md) for the toast pattern, [NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md)
for the notification center architecture.

## File Locations

| Purpose           | Location                                                          |
|-------------------|-------------------------------------------------------------------|
| Type definitions  | `packages/lib/src/types/sse.ts`                                   |
| Event builders    | `apps/api/src/lib/[domain]/sse-events.ts`                         |
| SSE handlers (FE) | `packages/lib/src/core/[domain]/sse-handlers.ts`                  |
| useSSE hook       | `packages/lib/src/core/sse/hooks/use-sse.ts`                      |
| SSE Provider      | `packages/ui/src/components/layout/sse-provider/sse-provider.tsx` |
| SSE route         | `apps/api/src/routes/sse.ts`                                      |
| Home.broadcast()  | `apps/api/src/lib/home/home.ts`                                   |

## Event Design

Events are minimal — only what the frontend handler needs for cache invalidation:

- Drive: `path.ownerId`, `path.mountId`, `path.id`, `path.parentId`, `path.mimeType`, optional `oldParentId`
- Mail: `mail.messageId`, `mail.mailbox`, optional `mail.toMailbox`
- Calendar: `ownerId`
- Chat: `chat.chatId`, `chat.ownerId`, `chat.mountId`
- Contacts: `contactId` or `labelId`
- Notification: `title`, optional `body`
- Space: just the event type
- Team: `teamId`

Type prefixes: `drive:`, `mail:`, `contacts:`, `chat:`, `calendar:`, `notification:`, `space:`, `team:`

## Adding SSE to a New Domain

1. **Define types** in `packages/lib/src/types/sse.ts` — add to `SSEventType`, create event type, add to `SSEvent` union
2. **Create builder** at `apps/api/src/lib/[domain]/sse-events.ts` — `build[Domain]Event()` returning minimal data
3. **Emit from business logic** — call `this.home.broadcast(buildEvent(...))`
4. **Create handler** at `packages/lib/src/core/[domain]/sse-handlers.ts` — switch on event type, call invalidation
   functions. Do NOT add toast calls — toasts come from the notification center
5. **Register handler** in `packages/lib/src/core/sse/hooks/use-sse.ts`

## Implemented Domains

| Domain       | sse-events builder | sse-handler | Backend emits |
|--------------|--------------------|-------------|---------------|
| Drive        | Yes                | Yes         | Yes           |
| Mail         | Yes                | Yes         | Yes           |
| Contacts     | Yes                | Yes         | Yes           |
| Chat         | Yes                | Yes         | Yes           |
| Calendar     | Yes                | Yes         | Yes           |
| Notification | Yes                | Yes         | Yes           |
| Space        | —                  | Yes         | No            |
| Team         | —                  | Yes         | No            |

Space and Team have SSE types defined and frontend handlers registered, but no backend code broadcasts these
events yet. The handlers are wired up in advance so adding the backend emit is all that's needed.
