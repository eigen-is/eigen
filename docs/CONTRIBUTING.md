# Contributing to Eigen

## Code Style

- **English everywhere** — code, comments, docs, commit messages
- **`type` over `interface`** — except when methods are needed
- **No JSDoc** — code should be self-documenting. Comments only where logic isn't obvious
- **No `as any`** — fix the type at the source. Eden Treaty gives end-to-end safety; casting breaks it
- **Theme tokens, not colors** — use `text-muted-foreground`, `bg-muted`, not `text-gray-500`, `bg-blue-50`
- **Imports** — use `@workspace/lib/[domain]` and `@workspace/ui/components/...`, avoid deep relative paths

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

Mutation error/success handling belongs in hooks (`packages/lib/src/core/[domain]/hooks/`), not in app
components. Every `useMutation` must have an `onError` callback using `onMutationError` from `api-error.ts`.
Apps should never add their own `try/catch` + `toast.error()` around mutations.

See [NOTIFICATIONS.md](NOTIFICATIONS.md) for the full pattern.

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

## Development

```bash
bun run serve          # All apps + API
bun serve:mail         # Single app + API
bun run lint           # Lint + format check (Biome)
bun run lint:fix       # Auto-fix lint + format
bun run typecheck      # Type check all packages
bun run test           # Run all tests
bun run check          # lint + typecheck + test
```

- **No migrations** — data is throwaway during dev. Prefer clean schemas over backward compatibility
- **Never run package install commands** — ask the user
- See [TESTING.md](TESTING.md) for test patterns, [DOCKER.md](DOCKER.md) for deployment
