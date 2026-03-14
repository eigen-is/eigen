# Contributing to Eigen

> **TLDR**: Monorepo with Bun + Elysia + React 19 + TanStack. Types go in `packages/lib/src/types/`. Hooks go in
`packages/lib/src/core/[domain]/hooks/`. Routes go in `apps/api/src/routes/`. Use `type` not `interface`. English
> everywhere. No JSDoc. Run `bun run typecheck && bun run test` after changes. No migrations needed — data is throwaway
> during dev.

## Code Style

- **Language**: English everywhere (code, comments, docs)
- **Types**: Always `type` over `interface` (except when methods needed)
- **Naming**: `camelCase` functions, `PascalCase` components, domain-based routes
- **Comments**: Minimal. Code should be self-documenting. No JSDoc
- **Imports**: Use `@workspace/lib/[domain]` and `@workspace/ui/components/...` — avoid deep relative paths

## Architecture Quick Reference

| Layer         | Location                                         | Pattern                                                    |
|---------------|--------------------------------------------------|------------------------------------------------------------|
| API routes    | `apps/api/src/routes/[domain].ts`                | Elysia router, `{auth: true}` for protected                |
| Domain logic  | `apps/api/src/lib/[domain]/[domain].ts`          | Class owned by Home singleton                              |
| DB schemas    | `apps/api/src/lib/[domain]/schema.ts`            | Drizzle ORM + `db-config.ts` for migrations                |
| Shared types  | `packages/lib/src/types/[domain].ts`             | Shared between FE/BE                                       |
| Data hooks    | `packages/lib/src/core/[domain]/hooks/`          | TanStack Query — **never** use `useQuery` directly in apps |
| SSE handlers  | `packages/lib/src/core/[domain]/sse-handlers.ts` | Cache invalidation on events                               |
| SSE builders  | `apps/api/src/lib/[domain]/sse-events.ts`        | Build SSEvent payloads                                     |
| Frontend apps | `apps/[name]/src/routes/`                        | TanStack Router, file-based                                |
| Shared UI     | `packages/ui/src/components/`                    | shadcn/ui defaults                                         |
| Validation    | `packages/lib/src/validation/`                   | Shared FE/BE validation                                    |

See: [DATABASE.md](DATABASE.md), [SSE.md](SSE.md), [LAYOUT.md](LAYOUT.md), [ACL.md](ACL.md), [STORAGE.md](STORAGE.md)

## Key Patterns

### Query Keys

```typescript
export const driveKeys = {
    all: ['drive'] as const,
    folders: () => [...driveKeys.all, 'folder'] as const,
    folder: (pathId: string) => [...driveKeys.folders(), pathId] as const,
};
```

Export invalidation functions alongside hooks for reuse in SSE handlers and mutation callbacks.

### API Client (Eden Treaty)

```typescript
import { driveApi } from '@workspace/lib/api';
const response = await driveApi({ ownerId })({ mountId }).folder({ pathId }).get();
```

Type-safe — types flow from Elysia route definitions. See `packages/lib/src/core/api.ts`.

### Eigen File Types

| Type     | MIME                        | Extension        | Storage                       |
|----------|-----------------------------|------------------|-------------------------------|
| Document | `application/eigendoc`      | `.eigendoc`      | Dir with `data.db` (Yjs)      |
| Stickies | `application/eigenstickies` | `.eigenstickies` | Dir with `data.db` (Yjs)      |
| Chat     | `application/eigenchat`     | `.eigenchat`     | Dir with `data.db` + `media/` |
| Slides   | `application/eigenslides`   | `.eigenslides`   | Dir with `data.db` (Yjs)      |
| Sheets   | `application/eigensheets`   | `.eigensheets`   | Dir with `data.db` (Yjs)      |

URL params use hyphens (`application-eigendoc`), database uses slashes.

## Development

```bash
bun run serve          # All apps + API
bun serve:mail         # Single app + API
bun run typecheck      # Type check all packages
bun run test           # Run API tests
bun run check          # typecheck + test
```

- **Never run package install commands** — ask the user
- **No migrations needed** — data is throwaway during dev. Prefer clean schemas over compatibility
- See [TESTING.md](TESTING.md) for test patterns, [DOCKER.md](DOCKER.md) for deployment
