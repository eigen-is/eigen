# Server-Sent Events (SSE)

> **TLDR**: Real-time cache invalidation. Backend emits events via `home.notify()` → SSE stream → frontend handlers
> invalidate TanStack Query cache. A small set of curated events also show toast notifications (see
> [NOTIFICATIONS.md](NOTIFICATIONS.md)). Add new domain SSE: define types in `packages/lib/src/types/sse.ts`,
> create builder in `apps/api/src/lib/[domain]/sse-events.ts`, create handler in
> `packages/lib/src/core/[domain]/sse-handlers.ts`, register in `use-sse.ts`.

## Flow

```
API Mutation → home.notify(event) → SSE Stream → Client
                                                    └── SSE Handler → QueryClient.invalidateQueries()
                                                                    → toast (only for curated remote events)
```

SSE is personal-only — each user subscribes to their own Home's event stream. Events fall into two categories:

- **Self-triggered**: your own action bounces back for cache invalidation. No toast needed — the UI already reflects
  the change
- **Recipient-only**: explicitly propagated to another user's Home (share, invite, incoming mail). These show a
  toast notification directly in the SSE handler

See [NOTIFICATIONS.md](NOTIFICATIONS.md) for the full notification pattern.

## File Locations

| Purpose           | Location                                                          |
|-------------------|-------------------------------------------------------------------|
| Type definitions  | `packages/lib/src/types/sse.ts`                                   |
| Event builders    | `apps/api/src/lib/[domain]/sse-events.ts`                         |
| SSE handlers (FE) | `packages/lib/src/core/[domain]/sse-handlers.ts`                  |
| useSSE hook       | `packages/lib/src/core/sse/hooks/use-sse.ts`                      |
| SSE Provider      | `packages/ui/src/components/layout/sse-provider/sse-provider.tsx` |
| SSE route         | `apps/api/src/routes/sse.ts`                                      |
| Home.notify()     | `apps/api/src/lib/home/home.ts`                                   |

## Event Design

- All events have `title` (base field)
- Notification events add `body`, `tag?`, `link?` (via `SSEventNotification` mixin)
- Domain-specific payloads: `path` (Drive), `mail` (Mail), `contact`/`label` (Contacts), `chat` (Chat), `calendar` (
  Calendar)
- Type prefixes: `drive:`, `mail:`, `contacts:`, `chat:`, `calendar:`, `space:`, `team:`

## Adding SSE to a New Domain

1. **Define types** in `packages/lib/src/types/sse.ts` — add to `SSEventType`, create event type, add to `SSEvent` union
2. **Create builder** at `apps/api/src/lib/[domain]/sse-events.ts` — templates + `build[Domain]Event()`
3. **Emit from business logic** — add `emit()` helper calling `this.home.notify()`
4. **Create handler** at `packages/lib/src/core/[domain]/sse-handlers.ts` — call invalidation functions from hooks.
   If the event is a recipient-only remote event (share, invite), add a `toast()` call directly in the handler
5. **Register handler** in `packages/lib/src/core/sse/hooks/use-sse.ts`

## Implemented Domains

Drive, Mail, Contacts, Chat, Calendar, Space, Team
