# Code Standards

Reference for code style and conventions. For architecture, file locations, and project structure, see
[AGENTS.md](../AGENTS.md).

## Code Philosophy

This codebase values **simplicity, directness, and consistency** over cleverness or abstraction. Code should
be obvious at a glance. When in doubt, look at what already exists in the same directory and match it exactly.

- **Flat and direct** — no service layers, no repository patterns, no dependency injection. Routes call domain
  classes directly. Domain classes query the database directly with Drizzle
- **Don't extract single-use helpers** — a method that handles a complete workflow inline is better than
  several small methods you have to trace through. Only extract when logic is reused
- **Trust the type system** — no defensive null checks on typed data, no fallback defaults for required fields.
  Validate at system boundaries (user input, external APIs), trust internal code everywhere else
- **Consistency over originality** — new code must look like the code next to it. Same patterns, same naming,
  same structure. Don't invent new patterns when existing ones work

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

### Reinventing existing code

BAD — redefining types and reimplementing utilities that already exist in shared packages:
```typescript
// Redefining a type that exists in packages/lib/src/types/chat.ts
type ChatMessage = { id: string; content: string; userId: string; createdAt: number };

// Reimplementing date formatting instead of using @workspace/lib/date
const formatted = new Date(timestamp).toLocaleDateString('en-US', { ... });

// Using clsx directly instead of the project's cn() wrapper (which adds tailwind-merge)
import clsx from 'clsx';
const classes = clsx('px-4', isActive && 'bg-blue-500');
```

GOOD — import from shared packages:
```typescript
import type { ChatMessage } from '@workspace/lib/types/chat';
import { formatDate } from '@workspace/lib/date';
import { cn } from '@workspace/ui/lib/utils';
```

## Typing

Types flow end-to-end from backend to frontend. Don't break the chain.

```
Elysia route handler return type → Eden Treaty infers response type → hook exposes typed data → component consumes
```

- **No `as any`** — fix the type at the source (route handler return type, schema definition), not by
  casting in hooks. Eden Treaty gives end-to-end safety; `as any` silently breaks it
- **No `as Type` on Eden Treaty responses** — if `response.data` has the wrong type, add an explicit return
  type to the backend route handler or domain method using the shared type from `packages/lib/src/types/`.
  Don't paper over mismatches with `as` casts in hooks
- **Shared types live in `packages/lib/src/types/[domain].ts`** — never redefine a type that already exists
  there. Import it. If the type doesn't exist yet, add it to the shared package so both FE and BE use it
- **`type` over `interface`** — except when methods are needed
- **Infer locally, annotate publicly** — don't annotate variables when TypeScript can infer
  (`const path = await drive.getPath(...)` not `const path: DrivePath = ...`). But always add explicit
  return types on backend route handlers, domain methods, and hooks — this is what powers Eden Treaty's
  end-to-end type flow
- **`import type` for type-only imports** — separate from value imports:
  `import type { DrivePath } from '@workspace/lib/types/drive'`
- **Drizzle `.$inferSelect` for DB row types** — use `typeof schema.messages.$inferSelect` for database
  row shapes, don't manually redefine column types

## Code Style

- **English everywhere** — code, comments, docs, commit messages
- **No JSDoc** — code should be self-documenting. Comments only where logic isn't obvious
- **Comments explain WHY, never WHAT** — `// Walk parentId chain to find outermost container` is good.
  `// Set the variable to true` is noise. Most code needs zero comments
- **Backend errors use `ApiError`** — `throw new ApiError(status, message)` for user-facing HTTP errors,
  never `throw new Error()`. Exception: internal invariants (db not open, missing config) may use
  `throw new Error()` since an HTTP status code wouldn't be semantically correct
- **Theme tokens, not colors** — use `text-muted-foreground`, `bg-muted`, not `text-gray-500`, `bg-blue-50`.
  Use `selection-handle` token for selection UI (resize handles, bounding boxes)
- **Use `cn()` for class merging** — import from `@workspace/ui/lib/utils`, never use raw `clsx`/`twMerge`
  or string concatenation for conditional Tailwind classes
- **Name for grep-ability; don't shadow libraries** — use the established prefixes so a whole category is
  one search away: `use*` (hooks), `Eigen*` (brand components), `*Dialog`, `*Provider`, `invalidate*`
  (cache helpers), `*Keys` (query-key factories). Don't reuse a name a dependency already owns (our search
  hook is `useSearchQuery`, not `useSearch`, to stay clear of TanStack Router's `useSearch`), and don't give
  three different helpers the same name (`isMobile`)

### Imports

Workspace imports resolve through each package's `exports` map (`packages/*/package.json`) — there are no
tsconfig path aliases for `@workspace/*`. If a specifier doesn't resolve, the module isn't public: export it
from its barrel or give it an exports entry, don't reach around the map. **Never suffix a workspace specifier
with `.ts`/`.tsx`** — suffixed specifiers don't resolve, and Biome rejects them.

| Specifier                            | What you get                                                  | Example                                    |
|--------------------------------------|---------------------------------------------------------------|--------------------------------------------|
| `@workspace/ui`                      | Root barrel: the AGENTS.md Key UI Components, the layout system (app/sidebar/toolbar — not pages), generic leaf primitives | `import { TooltipButton } from '@workspace/ui'` |
| `@workspace/ui/components/[area]`    | Area barrel (drive, chat, comments, editor, media, user, …)   | `@workspace/ui/components/drive`           |
| `@workspace/ui/components/[leaf]`    | Extensionless deep import for a component its barrel doesn't export | `@workspace/ui/components/search/doc-search-provider` |
| `@workspace/ui/components/layout/[dir]` | Layout system barrels: `app`, `pages`, `sidebar`, `toolbar` | `@workspace/ui/components/layout/app`      |
| `@workspace/ui/hooks/[hook]`         | Shared DOM/interaction hooks                                  | `@workspace/ui/hooks/use-long-press`       |
| `@workspace/ui/lib/utils`            | `cn()` utility                                                | `@workspace/ui/lib/utils`                  |
| `@workspace/lib/[domain]`            | Domain barrel: hooks, query keys, invalidators                | `@workspace/lib/drive`                     |
| `@workspace/lib/types/[domain]`      | Shared FE/BE types                                            | `@workspace/lib/types/calendar`            |
| `@workspace/lib/constants/[x]`       | Shared constants                                              | `@workspace/lib/constants/stale-time`      |
| `@workspace/lib/api`                 | Eden Treaty API client factories                              | `@workspace/lib/api`                       |
| `@workspace/lib/date`                | Date formatting (`formatDate`, `formatTime`, `formatTimeAgo`) | `@workspace/lib/date`                      |
| `@workspace/lib/validation`          | Shared FE/BE validation schemas                               | `@workspace/lib/validation`                |

Prefer the barrel over a deep import when both reach the same primitive. SHARED-PRIMITIVES.md's *Import from*
column lists the shortest specifier that resolves each primitive — the right default for components, hooks, and
utils, but **not** authoritative for types and constants, where it collapses to the aggregate
`@workspace/lib/types` / `@workspace/lib/constants`. There the table above wins: import types from
`@workspace/lib/types/<domain>` and constants from `@workspace/lib/constants/<x>`; the bare aggregate specifiers
are tolerated legacy, not the convention. Backend code imports lib only through the React-free subpaths — see the
carve-out in [AGENTS.md](../AGENTS.md).

## Key Patterns

### Query Keys

Every domain defines hierarchical query keys. Keys must always include `ownerId` — without it, switching
between personal and team contexts serves stale cached data. Export invalidation functions alongside hooks.

```typescript
export const driveKeys = {
    all: ['drive'] as const,
    owner: (ownerId: string) => [...driveKeys.all, ownerId] as const,
    folders: (ownerId: string) => [...driveKeys.owner(ownerId), 'folder'] as const,
    folder: (ownerId: string, mountId: string, pathId: string) =>
        [...driveKeys.folders(ownerId), mountId, pathId] as const,
};
```

Every `useQuery` hook must have: `queryKey` using the domain keys, `queryFn` with error checking,
`enabled` guard (`!!ownerId && !!mountId`), and explicit `staleTime`.

### API Client (Eden Treaty)

Types flow directly from Elysia route definitions — no manual type sync needed.

```typescript
import { driveApi } from '@workspace/lib/api';
const response = await driveApi({ ownerId })({ mountId }).folder({ pathId }).get();
```

### Error Handling

All error/success handling belongs in hooks (`packages/lib/src/core/[domain]/hooks/`), not in app
components. Every `useMutation` must have an `onError` callback using `onMutationError` from
`api-error.ts`. Apps should never add their own `try/catch` + `toast.error()`.

See [NOTIFICATIONS.md](NOTIFICATIONS.md) for the full pattern.

### Invalidation Functions

Export `invalidateFoo(queryClient, ...)` functions from hook files, next to the query key definitions.
Apps use these instead of importing `useQueryClient` and calling `invalidateQueries()` directly.

### Z-Index / Layering

One scale, project-wide. Higher values are progressively rarer — if you reach for one, justify it
with a comment.

| Layer                                        | z-index | Examples                                                |
|----------------------------------------------|---------|---------------------------------------------------------|
| Document content                             | auto    | Default; everything flows                               |
| In-content floating UI                       | 10      | Inline autocompletes, chat/contact suggestion lists     |
| Sheet canvas-internal overlays               | 8–30    | Selection, freeze handles, scrollbars, hint boxes — scoped under `cellArea` |
| Portaled UI (dropdowns, popovers, dialogs)   | 50      | shadcn / Radix default — leave it alone                 |
| Full-screen overlay                          | 100     | `FilePreview`                                           |
| Dialog above preview                         | 200     | `DialogContent` with `abovePreview` prop                |
| Toaster                                      | library | Sonner manages its own stack                            |

Rules:

- **App-level components don't set z-index.** Use layout instead — flex sibling (slides pattern) or
  absolute inside a parent that establishes a stacking context (docs pattern with `position: relative
  overflow-hidden`). Side panels (comments, properties) belong here.
- **`position: relative` alone does *not* establish a stacking context** — the element needs a
  `z-index` other than `auto` (or one of: `transform`, `opacity < 1`, `filter`, `isolation: isolate`,
  `will-change`). If you want to contain children's z-indices, add `isolation: isolate`.
- **Don't override shadcn primitives' z-50.** If a portaled menu is being covered, fix the offending
  high z-index, don't escalate the menu.
- **Anything > 50 needs a comment** explaining why (current exceptions are `FilePreview` and the
  `abovePreview` Dialog prop).
- **The sheet engine's `cellArea` is its own world** — overlays under it stay ≤ 30; portaled menus
  rely on shadcn's z-50 to land above.

## Self-Review Checklist

Before declaring any task complete, review every changed file against this list:

- Did you read 2-3 existing files in the same directory before writing new code?
- Are hooks in `packages/lib/src/core/[domain]/hooks/`, not in app components?
- Are there any unnecessary abstractions, helpers, wrappers, or indirection?
- Did you check `packages/ui/src/components/` and `packages/lib/src/` for existing utilities/components
  before writing new ones? (`cn()`, `formatDate`, `TooltipButton`, `DeleteDialog`, etc.)
- Are you using theme tokens, not hardcoded colors?
- Did you avoid adding try-catch, null checks, or fallbacks for cases that can't happen?
- Do new `useQuery` hooks have `enabled` guards and `staleTime`?
- Does the new code match the patterns and naming of its neighbors?
- Any new `z-index` set above 50? If yes, is it on the documented exceptions or does it have a
  `// Why:` comment? (See § Z-Index / Layering)
