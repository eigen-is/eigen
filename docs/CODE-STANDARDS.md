# Code Standards

Reference for code style, architecture patterns, and conventions used in the Eigen codebase.

## Code Philosophy

This codebase values **simplicity, directness, and consistency** over cleverness or abstraction. Code should
be obvious at a glance. When in doubt, look at what already exists in the same directory and match it exactly.

- **Flat and direct** — no service layers, no repository patterns, no dependency injection. Routes call domain
  classes directly. Domain classes query the database directly with Drizzle
- **Functions > abstractions** — a 100-line method that handles a complete workflow is better than 5 small
  methods that you have to trace through. Don't extract helpers for one-time logic
- **Trust the type system** — no defensive null checks on typed data, no fallback defaults for required fields.
  Validate at system boundaries (user input, external APIs), trust internal code everywhere else
- **Consistency over originality** — new code must look like the code next to it. Same patterns, same naming,
  same structure. Don't invent new patterns when existing ones work

## Code Style

- **English everywhere** — code, comments, docs, commit messages
- **`type` over `interface`** — except when methods are needed
- **No JSDoc** — code should be self-documenting. Comments only where logic isn't obvious
- **No `as any`** — fix the type at the source. Eden Treaty gives end-to-end safety; casting breaks it
- **No `as Type` on Eden Treaty responses** — add explicit return types to backend methods instead of casting
  `response.data` in hooks. Types flow from backend → Eden Treaty → frontend automatically
- **Backend errors use `ApiError`** — `throw new ApiError(status, message)`, never `throw new Error()`
- **Theme tokens, not colors** — use `text-muted-foreground`, `bg-muted`, not `text-gray-500`, `bg-blue-50`.
  Use `selection-handle` token for selection UI (resize handles, bounding boxes)
- **Imports** — use `@workspace/lib/[domain]` and `@workspace/ui/components/...`, avoid deep relative paths
- **Comments explain WHY, never WHAT** — `// Walk parentId chain to find outermost container` is good.
  `// Set the variable to true` is noise. Most code needs zero comments

## Architecture

| Layer         | Location                                         | Pattern                                                    |
|---------------|--------------------------------------------------|------------------------------------------------------------|
| API routes    | `apps/api/src/routes/[domain].ts`                | Elysia router, `{auth: true}` for protected                |
| Domain logic  | `apps/api/src/lib/[domain]/[domain].ts`          | Class owned by Home singleton                              |
| DB schemas    | `apps/api/src/lib/[domain]/schema.ts`            | Drizzle ORM + `db-config.ts` for migrations                |
| Shared types  | `packages/lib/src/types/[domain].ts`             | Shared between frontend and backend                        |
| Data hooks    | `packages/lib/src/core/[domain]/hooks/`          | TanStack Query — **never** use `useQuery` directly in apps |
| SSE handlers  | `packages/lib/src/core/[domain]/sse-handlers.ts` | Invalidate query cache on server events                    |
| SSE builders  | `apps/api/src/lib/[domain]/sse-events.ts`        | Build SSEvent payloads on the backend                      |
| Frontend apps | `apps/[name]/src/routes/`                        | TanStack Router, file-based                                |
| Shared UI     | `packages/ui/src/components/`                    | shadcn/ui components and layout system                     |
| Validation    | `packages/lib/src/validation/`                   | Shared frontend/backend validation                         |

Detailed docs: [Database](DATABASE.md) | [Storage](STORAGE.md) | [SSE](SSE.md) | [ACL](ACL.md) | [Layout](LAYOUT.md)

### Cross-Home Relay

All cross-home interactions (where one user's action touches another user's Home) must go through the
home relay (`apps/api/src/lib/home/home-relay.ts`). Never call `getHome()` directly for cross-home
access.

- **Writes**: `sendToHome(targetUserId, { type: 'drive:acl-change', ... })` — typed `HomeMessage` union
- **Reads**: `pullSharedPaths()`, `pullCalendarShares()`, etc. — individual typed functions
- **Local home**: `getHome(user.id)` is fine for accessing the current request's own home

See [SCALABILITY.md](SCALABILITY.md) for the full design and sharding story.

## Key Patterns

### Query Keys

Every domain defines hierarchical query keys for TanStack Query. Export invalidation functions alongside hooks
so SSE handlers and mutation callbacks can reuse them.

```typescript
export const driveKeys = {
    all: ['drive'] as const,
    folders: () => [...driveKeys.all, 'folder'] as const,
    folder: (pathId: string) => [...driveKeys.folders(), pathId] as const,
};
```

### API Client (Eden Treaty)

Types flow directly from Elysia route definitions — no manual type sync needed.

```typescript
import { driveApi } from '@workspace/lib/api';
const response = await driveApi({ ownerId })({ mountId }).folder({ pathId }).get();
```

### Error Handling

All error/success handling belongs in hooks (`packages/lib/src/core/[domain]/hooks/`), not in app
components. This applies to mutations, direct API calls (e.g., `authClient`), and any async operation
that can fail. Every `useMutation` must have an `onError` callback using `onMutationError` from
`api-error.ts`. Apps should never add their own `try/catch` + `toast.error()`.

See [NOTIFICATIONS.md](NOTIFICATIONS.md) for the full pattern.

### Invalidation Functions

Export `invalidateFoo(queryClient, ...)` functions from hook files, next to the query key definitions.
Apps use these instead of importing `useQueryClient` and calling `invalidateQueries()` directly.

### Eigen File Types

| Type     | MIME                        | Extension        | Storage                       |
|----------|-----------------------------|------------------|-------------------------------|
| Document | `application/eigendoc`      | `.eigendoc`      | Dir with `data.db` (Yjs)      |
| Stickies | `application/eigenstickies` | `.eigenstickies` | Dir with `data.db` (Yjs)      |
| Chat     | `application/eigenchat`     | `.eigenchat`     | Dir with `data.db` + `media/` |
| Slides   | `application/eigenslides`   | `.eigenslides`   | Dir with `data.db` (Yjs)      |
| Sheets   | `application/eigensheets`   | `.eigensheets`   | Dir with `data.db` (Yjs)      |

URL parameters use hyphens (`application-eigendoc`), database stores slashes.

## Public API

Unauthenticated endpoints under `/p/`:

| Endpoint                    | Returns                                          |
|-----------------------------|--------------------------------------------------|
| `GET /p/avatar/:emailOrId`  | Avatar image (cached 24h) or generated SVG       |
| `GET /p/user/:emailOrId`    | `{ name, email, avatar }`                        |
| `GET /p/config`             | Public server config (org name, registration)     |
| `POST /p/waitlist`          | Waitlist signup                                   |

Avatar component: `UserAvatar` (`packages/ui/.../user-avatar.tsx`), backed by `useResolvedUser`.

Route: `apps/api/src/routes/public.ts`

## Common LLM Mistakes

These mistakes come up in almost every LLM-generated code review. Don't make them.

### Over-engineering

BAD — creating abstractions that aren't needed:
```typescript
// Don't create wrapper functions for one-off logic
function buildNotificationPayload(type: string, userId: string) { ... }
function createNotification(payload: NotificationPayload) { ... }
const notification = createNotification(buildNotificationPayload('chat', user.id));

// Don't add "service" layers or "manager" classes
class NotificationService { send(notification: Notification) { ... } }

// Don't create generic helpers for specific tasks
function updateEntityField<T>(entity: T, field: keyof T, value: T[keyof T]) { ... }
```

GOOD — just do the thing directly:
```typescript
home.notifications.persist({ type: 'chat:message', userId: user.id, ... });
```

### Unnecessary error handling

BAD — defensive code around trusted internals:
```typescript
const path = await drive.getPath(mountId, pathId);
if (!path) throw new ApiError(404, 'Path not found'); // getPath already throws
try {
    await drive.deletePath(mountId, pathId);
} catch (error) {
    console.error('Failed to delete path:', error);
    throw new ApiError(500, 'Delete failed');        // ApiError already bubbles up
}
```

GOOD — trust the type system and let errors propagate:
```typescript
const path = await drive.getPath(mountId, pathId); // throws ApiError(404) if missing
await drive.deletePath(mountId, pathId);            // errors bubble to Elysia handler
```

Only use try-catch for: (1) fire-and-forget where failure is acceptable, (2) external integrations,
(3) cleanup that must run regardless. Never re-wrap ApiError.

### Not matching existing patterns

BAD — writing a query hook differently from the others in the same file:
```typescript
// Using different key structure, missing enabled guard, no staleTime
export function useFolder(folderId: string) {
    return useQuery({ queryKey: ['folder', folderId], queryFn: async () => { ... } });
}
```

GOOD — match the exact pattern of sibling hooks:
```typescript
export function useFolder(ownerId: string, mountId: string, pathId: string) {
    return useQuery({
        queryKey: driveKeys.folder(ownerId, mountId, pathId),
        queryFn: async () => { ... },
        enabled: !!ownerId && !!mountId && !!pathId,
        staleTime: 60_000,
    });
}
```

### Adding code where it doesn't belong

BAD — API calls, error toasts, or query hooks in app components:
```typescript
// In apps/drive/src/components/folder-view.tsx
const { data } = useQuery({ queryKey: ['drive', 'folder', id], ... });
toast.error('Something went wrong');
```

GOOD — hooks in `packages/lib`, error handling in hook callbacks, apps just use the hook:
```typescript
// In apps/drive/src/components/folder-view.tsx
const { data } = useFolderContents(ownerId, mountId, pathId);
```

### Adding unnecessary complexity

BAD:
```typescript
// Unnecessary generics
function createHandler<T extends Record<string, unknown>>(config: T): Handler<T> { ... }

// Unnecessary discriminated union for two cases
type Result = { success: true; data: Item } | { success: false; error: string };

// Feature flags for a single use case
const DEFAULT_OPTIONS = { enableRetry: true, maxRetries: 3, retryDelay: 1000 };
```

GOOD:
```typescript
// Direct implementation
async function handleItemCreated(item: DriveItem) { ... }

// Simple return, throw on error
return item; // or: throw new ApiError(404, 'Not found')

// Hard-code what you need
const MAX_RETRIES = 3;
```

## Self-Review Checklist

Before declaring any task complete, review every changed file against this list:

- [ ] Read the diff — does each change follow the patterns in the **surrounding code**?
- [ ] Did you read 2-3 existing files in the same directory before writing new code?
- [ ] Are hooks in `packages/lib/src/core/[domain]/hooks/`, not in app components?
- [ ] Are there any unnecessary abstractions, helpers, wrappers, or indirection?
- [ ] Could any of your new code be simpler or more direct?
- [ ] Are you using theme tokens, not hardcoded colors?
- [ ] Does the new code match the naming conventions of its neighbors?
- [ ] Did you avoid adding try-catch, null checks, or fallbacks for cases that can't happen?
- [ ] Are comments explaining WHY (not WHAT), and only where the logic isn't obvious?
- [ ] Would a reviewer see this and think "this looks like it was always here"?
