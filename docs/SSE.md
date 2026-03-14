# Server-Sent Events (SSE)

> **TLDR**: Real-time cache invalidation + toast notifications. Backend emits events via `home.notify()` → SSE stream →
> frontend handlers invalidate TanStack Query cache. Add new domain SSE: define types in
`packages/lib/src/types/sse.ts`,
> create builder in `apps/api/src/lib/[domain]/sse-events.ts`, create handler in
`packages/lib/src/core/[domain]/sse-handlers.ts`, register in `use-sse.ts`.

## Flow

```
API Mutation → home.notify(event) → SSE Stream → Client
                                                    ├── SSE Handler → QueryClient.invalidateQueries()
                                                    └── SSEProvider → Toast notification
```

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

- All events have `title` (for toast headings)
- Notification events add `body` (checked via `isSSEventNotification()`)
- Domain-specific payloads: `path` (Drive), `mail` (Mail), `contact`/`label` (Contacts), `chat` (Chat), `calendar` (
  Calendar)
- Type prefixes: `drive:`, `mail:`, `contacts:`, `chat:`, `calendar:`

## Adding SSE to a New Domain

1. **Define types** in `packages/lib/src/types/sse.ts` — add to `SSEventType`, create event type, add to `SSEvent` union
2. **Create builder** at `apps/api/src/lib/[domain]/sse-events.ts` — templates + `build[Domain]Event()`
3. **Emit from business logic** — add `emit()` helper calling `this.home.notify()`
4. **Create handler** at `packages/lib/src/core/[domain]/sse-handlers.ts` — call invalidation functions
5. **Register handler** in `packages/lib/src/core/sse/hooks/use-sse.ts`
6. **Clean up UI** — remove manual `toast.success()` from mutations, keep `invalidateQueries()` in `onSuccess` for
   immediate local updates

## Implemented Domains

Drive, Mail, Contacts, Chat, Calendar
