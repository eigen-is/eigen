# Code Examples

> **TLDR**: The long-form companion to [CODE-STANDARDS.md](CODE-STANDARDS.md): the common LLM mistakes with BAD/GOOD code, the worked examples behind the key patterns, and exactly what `bun scripts/check-standards.ts` measures. CODE-STANDARDS.md carries the rules; this file carries the examples and the gate's metric list.

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

Only use try-catch for: (1) fire-and-forget where failure is acceptable, (2) external integrations, (3) cleanup that must run regardless. Never re-wrap ApiError.

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

The rules are in [CODE-STANDARDS.md § Typing](CODE-STANDARDS.md#typing); this is the full form with the reasoning.

Types flow end-to-end from backend to frontend. Don't break the chain.

```
Elysia route handler return type → Eden Treaty infers response type → hook exposes typed data → component consumes
```

- **No `as any`** — fix the type at the source (route handler return type, schema definition), not by casting in hooks. Eden Treaty gives end-to-end safety; `as any` silently breaks it
- **No `as Type` on Eden Treaty responses** — if `response.data` has the wrong type, add an explicit return type to the backend route handler or domain method using the shared type from `packages/lib/src/types/`. Don't paper over mismatches with `as` casts in hooks
- **Shared types live in `packages/lib/src/types/[domain].ts`** — never redefine a type that already exists there. Import it. If the type doesn't exist yet, add it to the shared package so both FE and BE use it
- **`type` over `interface`** — except when methods are needed
- **Infer locally, annotate publicly** — don't annotate variables when TypeScript can infer (`const path = await drive.getPath(...)` not `const path: DrivePath = ...`). But always add explicit return types on backend route handlers, domain methods, and hooks — this is what powers Eden Treaty's end-to-end type flow
- **`import type` for type-only imports** — separate from value imports: `import type { DrivePath } from '@workspace/lib/types/drive'`
- **Drizzle `.$inferSelect` for DB row types** — use `typeof schema.messages.$inferSelect` for database row shapes, don't manually redefine column types

## Code Style

The rules are in [CODE-STANDARDS.md § Code Style](CODE-STANDARDS.md#code-style); this is the full form with the examples.

- **English everywhere** — code, comments, docs, commit messages
- **No JSDoc** — code should be self-documenting. Comments only where logic isn't obvious
- **Comments are only for high-complexity code, or functions whose use wouldn't be obvious to a maintainer of this repo** — and they explain WHY, never WHAT. Write them in simplified technical English and favor concision over grammar: `// Walk parentId chain to find outermost container` is good, `// Set the variable to true` is noise. Most code needs zero comments, and no comment is better than slop — reviewers should flag comment slop the same as dead code
- **Backend errors use `ApiError`** — `throw new ApiError(status, message)` for user-facing HTTP errors, never `throw new Error()`. Exception: internal invariants (db not open, missing config) may use `throw new Error()` since an HTTP status code wouldn't be semantically correct
- **Theme tokens, not colors** — use `text-muted-foreground`, `bg-muted`, not `text-gray-500`, `bg-blue-50`. Use `selection-handle` token for selection UI (resize handles, bounding boxes)
- **Use `cn()` for class merging** — import from `@workspace/ui/lib/utils`, never use raw `clsx`/`twMerge` or string concatenation for conditional Tailwind classes
- **Name for grep-ability; don't shadow libraries** — use the established prefixes so a whole category is one search away: `use*` (hooks), `Eigen*` (brand components), `*Dialog`, `*Provider`, `invalidate*` (cache helpers), `*Keys` (query-key factories). Don't reuse a name a dependency already owns (our search hook is `useSearchQuery`, not `useSearch`, to stay clear of TanStack Router's `useSearch`), and don't give three different helpers the same name (`isMobile`)

## Imports

The resolver table is in [CODE-STANDARDS.md § Imports](CODE-STANDARDS.md#imports); this is the reasoning around it.

Workspace imports resolve through each package's `exports` map (`packages/*/package.json`) — there are no tsconfig path aliases for `@workspace/*`. If a specifier doesn't resolve, the module isn't public: export it from its barrel or give it an exports entry, don't reach around the map. **Never suffix a workspace specifier with `.ts`/`.tsx`** — suffixed specifiers don't resolve, and Biome rejects them.

Prefer the barrel over a deep import when both reach the same primitive. SHARED-PRIMITIVES.md's *Import from* column lists the shortest specifier that resolves each primitive — the right default for components, hooks, and utils, but **not** authoritative for types and constants, where it collapses to the aggregate `@workspace/lib/types` / `@workspace/lib/constants`. There the resolver table in CODE-STANDARDS.md wins: import types from `@workspace/lib/types/<domain>` and constants from `@workspace/lib/constants/<x>`; the bare aggregate specifiers are tolerated legacy, not the convention. Backend code imports lib only through the React-free subpaths — see [ARCHITECTURE.md § Backend imports of lib](ARCHITECTURE.md#backend-imports-of-lib).

## Key Patterns

The rules are in [CODE-STANDARDS.md § Key Patterns](CODE-STANDARDS.md#key-patterns); these are the shapes they describe.

### Query Keys

```typescript
export const driveKeys = {
    all: ['drive'] as const,
    owner: (ownerId: string) => [...driveKeys.all, ownerId] as const,
    folders: (ownerId: string) => [...driveKeys.owner(ownerId), 'folder'] as const,
    folder: (ownerId: string, mountId: string, pathId: string) =>
        [...driveKeys.folders(ownerId), mountId, pathId] as const,
};
```

### API Client (Eden Treaty)

Types flow directly from Elysia route definitions — no manual type sync needed.

```typescript
import { driveApi } from '@workspace/lib/api';
const response = await driveApi({ ownerId })({ mountId }).folder({ pathId }).get();
```

## Standards Gates

The mechanical rules in [CODE-STANDARDS.md](CODE-STANDARDS.md) are enforced, not just documented. Biome carries what it can express (`noExplicitAny` is an error, and `noRestrictedImports` rejects extension-suffixed workspace specifiers and `lib → ui/sheet` imports). Everything else runs through `bun scripts/check-standards.ts`, part of `bun run check`. It scans non-test, non-generated `.ts`/`.tsx` under `apps/` and `packages/` (`packages/sheet` is a fork with its own conventions and is skipped) and counts twelve metrics.

Seven are hard zeros — any hit fails: `"use client"` directives, imports reaching past a package barrel (`@workspace/lib/core/…`, `@workspace/lib/src/…`, `@workspace/ui/src/…`, extension-suffixed specifiers), `export type` re-exports from a `packages/lib/src/core/**/index.ts` barrel, and `useQuery`/`useMutation`/`useInfiniteQuery`/`toast.error`/`toast.success` calls in an app outside a `hooks/` folder, plus three rules that carry the conventions the prose used to carry alone:

- **Non-canonical `application/eigen…` MIMEs** — the canonical six are read out of the `DRIVE_MIME_*` constants in `packages/lib/src/types/drive.ts` at run time, so a seventh document type needs no second list. Catches `eigenslide` for `eigenslides` and `eigensheet` for `eigensheets`. The `application/eigen-*` wire formats (drag, clipboard) are a different family and are not document MIMEs
- **Authenticated routes without `:ownerId` second** — every `{ auth: true }` route in `apps/api/src/routes/` must carry `:ownerId` as its second path segment. Unauthenticated routes answer to no Home and are skipped; the home-independent files (`setup.ts`, `settings.ts`, `waitlist.ts`, `public.ts`, `backup.ts`) are exempt in one list in the script; `/ws` counts as a transport prefix, not a segment
- **Hover-revealed affordances without touch** — a hiding utility (`invisible`, `hidden`, `opacity-0`) plus a revealing `group-hover:` in the same class string needs the matching `pointer-coarse:` variant, because touch has no hover. A decorative `group-hover:scale-105` reveals nothing and does not count, and `pointer-fine:group-hover:` declares the hover desktop-only on purpose

The other five ratchet: `as Type` casts, `interface` declarations (module augmentation excepted — it only merges through interfaces), `biome-ignore` suppressions, JSDoc blocks, and raw Tailwind colour utilities. Their allowance lives in `scripts/standards-baseline.json`, so a count can fall but never rise. After a cleanup run `bun run standards:update` to write the new, lower numbers; the script refuses to raise a baseline. `bun run standards -- --verbose` prints the per-file breakdown.
