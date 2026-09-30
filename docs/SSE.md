# Server-Sent Events (SSE)

> **TLDR**: Real-time cache invalidation. The backend emits events via `home.broadcast()` → SSE stream → frontend handlers invalidate the TanStack Query cache. Events carry only what invalidation needs: no display text, no full domain objects. Toasts come only from the notification center's own SSE event. Every stream also announces the data epoch of the user's homes, which reloads a tab whose home a restore replaced.

## Flow

```
API Mutation → home.broadcast(event)  → SSE Stream → Client
                                                        └── SSE Handler → QueryClient.invalidateQueries()

Notification → home.notifications.persist({...})
                 └── broadcasts notification:created SSE → toast + invalidate notification queries
```

SSE is personal-only: each user subscribes to their own Home's event stream. The SSE keepalive (every 15s) re-acquires the Home via `getHome()` (which calls `touch()`), preventing idle destruction and self-healing if the Home was destructed externally. An initial keepalive is sent immediately in `start()` to prevent Apache proxy timeouts. The frontend `useSSE` hook auto-reconnects after HTTP errors (e.g. 502) with exponential backoff (1s initial, doubling up to 30s max, with 20% jitter).

Events fall into two categories:

- **Cache invalidation**: domain events (drive, mail, calendar, chat, contacts) carry only IDs needed for `queryClient.invalidateQueries()`. No toasts, no display text
- **Notification**: `notification:created` carries the toast text plus the tag pair its View link needs (see Event Design). Created by `NotificationCenter.persist()`, which also writes to the per-user notifications database

See [NOTIFICATIONS.md](NOTIFICATIONS.md) for the toast pattern, [NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md) for the notification center architecture.

## Where the code lives

Types live in `packages/lib/src/types/sse.ts`. Per domain, the backend builder is `apps/api/src/lib/[domain]/sse-events.ts` and the frontend handler is `packages/lib/src/core/[domain]/sse-handlers.ts`, registered in `packages/lib/src/core/sse/hooks/use-sse.ts` (mounted by `packages/ui/src/components/sse-provider/sse-provider.tsx`). The stream itself is `apps/api/src/routes/sse.ts` and `apps/api/src/lib/home/sse-stream.ts`, plus `home.broadcast()` in `apps/api/src/lib/home/home.ts`.

## Event Design

Events are minimal, only what the frontend handler needs for cache invalidation:

- Drive: `path.ownerId`, `path.mountId`, `path.id`, `path.parentId`, `path.mimeType`, optional `oldParentId`
- Mail: `mail.messageId`, `mail.mailbox`, optional `mail.toMailbox`
- Calendar: `ownerId`
- Chat: `chat.chatId`, `chat.ownerId`, `chat.mountId`
- Contacts: `contactId` or `labelId`; the batched `contacts:changed` a whole-file import sends in place of one event per card carries neither, because a card change invalidates the owner's whole list ([CONTACTS.md](CONTACTS.md))
- Notification: `title`, optional `body`, optional `notificationType` + `tag`; the last two let the toast's **View** action resolve the same deep link the bell uses (`resolveNotificationLink`), without shipping the whole row
- Space: just the event type
- Team: `teamId`
- Home: `epochs`, the data epoch per owner id (see below)

`notification:created` has a sibling, `notification:changed` (bare `{type}`), which tells the bell to refetch its count and list without toasting. It is emitted after a read or dismiss.

Type prefixes: `drive:`, `mail:`, `contacts:`, `chat:`, `calendar:`, `notification:`, `space:`, `team:`, `backup:`, `home:`

## A restore reloads every tab of the home

A restore puts other data under every open tab of the home, and each tab's caches describe the home as it was. The data epoch (`apps/api/src/lib/home/data-epoch.ts`) marks that moment. It has two parts: the server's, a random id in `data/server/collab-epoch` drawn on first use, followed by the home's, from `data/server/collab-home-epochs.json`. A per-home restore rotates the home's part once the new folder is whole, so no tab reloads onto the 503 of a restore still running, and a failed restore leaves it alone. `./eigen restore` and `./eigen rollback` delete the server's file from the data they put back, so every epoch changes at the next start. A restart or an update keeps both.

Every stream sends `home:data-epochs` when it opens and after every keepalive: the epoch of the user's own home and of each of their teams. `handleHomeSSEvent` reloads through `reloadReplacedHome` when an epoch it holds changes. A home it has not heard of is new to it (a team joined), not replaced. One announcement covers every case, with no push across homes: a tab connected through the restore hears it on the next keepalive, within 15 s of the end, and a tab that was offline, or any tab after a whole-server restore, hears it on reconnect.

The epochs a tab holds live in its sessionStorage: an editor tab reloads the moment the restore closes its collab socket, and that page hears its first epoch only after the restore. The new epoch is stored before the reload, so the page reloads once and Stay on the leave prompt ends the asking.

The owner reloads in every app, and so does every member of a restored team. A user who only has something shared from the home does not; their open documents reload through the collab socket ([COLLAB.md](COLLAB.md#home-replacement-closes-every-socket)).

## Adding SSE to a New Domain

1. **Define types** in `packages/lib/src/types/sse.ts`: add to `SSEventType`, create the event type, add it to the `SSEvent` union
2. **Create builder** at `apps/api/src/lib/[domain]/sse-events.ts`: `build[Domain]Event()` returning minimal data
3. **Emit from business logic**: call `this.home.broadcast(buildEvent(...))`
4. **Create handler** at `packages/lib/src/core/[domain]/sse-handlers.ts`: switch on event type, call invalidation functions. Do NOT add toast calls; toasts come from the notification center
5. **Register handler** in `packages/lib/src/core/sse/hooks/use-sse.ts`

## Implemented Domains

Drive, Mail, Contacts, Chat, Calendar, Notification, Backup and Home are complete: builder, handler, and backend emits. Space and Team have types only: no builder, no backend emit and no handler.
