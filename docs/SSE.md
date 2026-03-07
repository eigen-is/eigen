# Server-Sent Events (SSE) Architecture

Real-time notifications and cache invalidation across browser tabs.

## Overview

```
User Action → API Mutation → home.notify() → SSE Stream → Client Handler
                                                               ↓
                                                     ┌─────────┴─────────┐
                                                     │                   │
                                               Cache Invalidation    Toast Notification
```

**Currently implemented:** Drive, Mail, Contacts, Chat

## File Locations

| Purpose                  | Location                                                          |
|--------------------------|-------------------------------------------------------------------|
| Type definitions         | `packages/lib/src/types/sse.ts`                                   |
| Event builders (backend) | `apps/api/src/lib/[domain]/sse-events.ts`                         |
| SSE handlers (frontend)  | `packages/lib/src/core/[domain]/sse-handlers.ts`                  |
| useSSE hook              | `packages/lib/src/core/sse/hooks/use-sse.ts`                      |
| SSE Provider (toasts)    | `packages/ui/src/components/layout/sse-provider/sse-provider.tsx` |
| SSE route (backend)      | `apps/api/src/routes/sse.ts`                                      |
| Home class (notify)      | `apps/api/src/lib/home/home.ts`                                   |

## 1. Type Definitions

See `packages/lib/src/types/sse.ts` for all types.

### Key Design Decisions

1. **All events have `title`** - Used for toast headings
2. **Notification events have `body`** - Checked via `isSSEventNotification()` type guard
3. **Domain-specific data** - Drive uses `path: DrivePath`, Mail uses `mail: SSEventMailData`, Contacts uses `contact` or `label`, Chat uses `chat: SSEventChatData`
4. **Type prefixes** - Events are namespaced (`drive:`, `mail:`, `contacts:`, `chat:`)

## 2. Backend: Emitting Events

### 2.1 Event Templates

Create `apps/api/src/lib/[domain]/sse-events.ts` with:
- Templates for event text (title, body)
- A `build[Domain]Event()` function that constructs the SSEvent

See `apps/api/src/lib/drive/sse-events.ts` for reference.

### 2.2 Emitting from Business Logic

In your domain class, add an `emit` helper that calls `this.home.notify()`:

```typescript
private emit(type: DriveEventType, path: DrivePath): void {
    this.home.notify(buildDriveEvent(type, path));
}
```

Call `emit()` after mutations. See `apps/api/src/lib/drive/drive.ts` for reference.

### 2.3 Home.notify()

The `Home` class at `apps/api/src/lib/home/home.ts` manages:
- `subscribeSSE()` / `unsubscribeSSE()` - listener management
- `notify(event)` - broadcasts to all connected clients

## 3. Frontend: Receiving Events

### 3.1 useSSE Hook

Location: `packages/lib/src/core/sse/hooks/use-sse.ts`

- Establishes EventSource connection when authenticated
- Dispatches to domain handlers for cache invalidation
- Calls `onNotification` callback for toast-worthy events

### 3.2 SSE Handlers (Cache Invalidation)

Each domain has a handler at `packages/lib/src/core/[domain]/sse-handlers.ts`:

- Checks event type prefix (`drive:`, `mail:`, `contacts:`)
- Calls appropriate invalidation functions from hooks
- Returns `true` if handled

See existing implementations:

- `packages/lib/src/core/drive/sse-handlers.ts`
- `packages/lib/src/core/mail/sse-handlers.ts`
- `packages/lib/src/core/contacts/sse-handlers.ts`
- `packages/lib/src/core/chat/sse-handlers.ts`

### 3.3 SSEProvider (Toast Notifications)

Location: `packages/ui/src/components/layout/sse-provider/sse-provider.tsx`

Wraps `useSSE` and displays toasts via sonner for notification events.

## 4. Adding SSE to a New Domain

### Checklist

1. **Define event types** in `packages/lib/src/types/sse.ts`
   - Add constants to `SSEventType`
   - Create domain event type (e.g., `SSEventNewDomain`)
   - Add to `SSEvent` union
2. **Create event templates** at `apps/api/src/lib/[domain]/sse-events.ts`
   - Define templates with `title` and `body` functions
   - Export `build[Domain]Event()` function
3. **Emit from business logic** in `apps/api/src/lib/[domain]/[domain].ts`
   - Add `emit()` helper method
   - Call after mutations
4. **Create SSE handler** at `packages/lib/src/core/[domain]/sse-handlers.ts`
   - Export `handle[Domain]SSEvent()` function
   - Call invalidation functions from hooks
5. **Register handler** in `packages/lib/src/core/sse/hooks/use-sse.ts`
   - Import handler
   - Add to `handleEvent` callback
6. **Clean up UI code**
   - Remove `toast.success()` calls from mutations (SSE handles toasts)
   - Keep `invalidateQueries()` in `onSuccess` for immediate local updates

## 5. Summary

| Layer      | Location                                         | Responsibility                      |
|------------|--------------------------------------------------|-------------------------------------|
| Types      | `packages/lib/src/types/sse.ts`                  | Event type definitions              |
| Templates  | `apps/api/src/lib/{domain}/sse-events.ts`        | Text strings + event builder        |
| Emit       | `apps/api/src/lib/{domain}/{domain}.ts`          | Call `this.emit()` after mutations  |
| Broadcast  | `apps/api/src/lib/home/home.ts`                  | `notify()` sends to all subscribers |
| Receive    | `packages/lib/src/core/sse/hooks/use-sse.ts`     | EventSource connection              |
| Invalidate | `packages/lib/src/core/{domain}/sse-handlers.ts` | Cache invalidation logic            |
| Toast      | `packages/ui/.../sse-provider.tsx`               | Display notifications               |

### Benefits

- **Centralized toast notifications** - No scattered `toast.success()` calls
- **Centralized cache invalidation** - No duplicate `invalidateQueries()` calls
- **Cross-tab sync** - Changes in one tab update others automatically
- **Cross-app notifications** - Get Drive notifications while in Mail
- **Localizable text** - All strings in one place per domain
- **Type-safe** - Full TypeScript coverage end-to-end
