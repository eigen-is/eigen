# Contributing to Eigen

> **TLDR**: Monorepo with Bun + Elysia + React 19 + TanStack. Types go in `packages/lib/src/types/`. Hooks go in
`packages/lib/src/core/[domain]/hooks/`. Routes go in `apps/api/src/routes/`. Use `type` not `interface`. English
> everywhere. No JSDoc. Run `bun run check` (lint + typecheck + test) after changes. No migrations needed — data is throwaway
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
bun run lint           # Lint + format check (biome)
bun run lint:fix       # Auto-fix lint + format issues
bun run typecheck      # Type check all packages
bun run test           # Run all workspace tests (API + fortune-sheet)
bun run check          # lint + typecheck + test
```

- **Never run package install commands** — ask the user
- **No migrations needed** — data is throwaway during dev. Prefer clean schemas over compatibility
- See [TESTING.md](TESTING.md) for test patterns, [DOCKER.md](DOCKER.md) for deployment

## Public API

Public endpoints at `/p/` require no auth. Avatar URL: `{API_HOST}/p/avatar/{emailOrId}` —
HTTP-cacheable, server generates a fallback SVG when no avatar exists.

```
GET /p/avatar/:emailOrId   → image binary (Cache-Control: 86400s) or fallback SVG
GET /p/user/:emailOrId     → { name, email, avatar }
GET /p/config              → public server config (org name, etc.)
POST /p/waitlist           → waitlist signup
```

Components use `UserAvatar` (`packages/ui/src/components/layout/user-avatar.tsx`) which resolves via
`useResolvedUser` (`packages/lib/src/core/public/hooks/use-resolved-user.ts`). Direct loading:
`<img src="{API_HOST}/p/avatar/{emailOrId}" />`.

**Route**: `apps/api/src/routes/public.ts`

## Hotkeys

`@tanstack/react-hotkeys` for global shortcuts. `Mod` = Cmd (Mac) / Ctrl (Windows). Manual listeners kept for stateful
navigation and Tiptap editor. Use `formatForDisplay()` for tooltip labels.

| Shortcut             | Action                      | Location                           |
|----------------------|-----------------------------|------------------------------------|
| `Mod+B`              | Toggle sidebar              | `packages/ui/.../sidebar.tsx`      |
| `Mod+P`              | Print                       | `eigen-app.tsx`                    |
| `Mod+S`              | Save (Inline Editor)        | `use-editor-save.ts`              |
| `Escape`             | Close preview               | `file-preview.tsx`                 |
| `ArrowLeft/Right`    | Navigate preview            | `file-preview.tsx`                 |
| `Mod+Z`              | Undo (Stickies, Slides)     | `board.tsx`, `slides/editor.tsx`   |
| `Mod+Y`              | Redo (Stickies, Slides)     | `board.tsx`, `slides/editor.tsx`   |
| `Mod+Shift+Z`        | Redo alt (Stickies, Slides) | `board.tsx`, `slides/editor.tsx`   |
| `Delete`/`Backspace` | Delete selected (Slides)    | `slides/editor.tsx`                |
| `Escape`             | Deselect (Slides)           | `slides/editor.tsx`                |
| `Arrow keys`         | Nudge selected (Slides)     | `slides/editor.tsx`                |

**Use `@tanstack/react-hotkeys`** for: global shortcuts, simple actions, display formatting, cross-platform needs.

**Keep manual** for: stateful navigation (`use-keyboard-list-navigation.ts`), framework-specific (Tiptap editor),
simple input fields.

```tsx
import {useHotkey} from '@tanstack/react-hotkeys';
import {formatForDisplay} from '@tanstack/react-hotkeys';

useHotkey('Mod+S', () => save(), {enabled: canSave});
const label = formatForDisplay('Mod+S'); // "⌘S" on Mac, "Ctrl+S" on Windows
```
