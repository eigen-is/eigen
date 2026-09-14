# Code Standards

Code style and conventions. Architecture and file locations: [ARCHITECTURE.md](ARCHITECTURE.md). The reasoning and BAD/GOOD code behind every section here, plus the gate's metric list: [CODE-EXAMPLES.md](CODE-EXAMPLES.md).

## Code Philosophy

This codebase values **simplicity, directness, and consistency** over cleverness or abstraction. Code should be obvious at a glance. When in doubt, look at what already exists in the same directory and match it exactly.

- **Flat and direct** — no service layers, no repository patterns, no dependency injection. Routes call domain classes directly. Domain classes query the database directly with Drizzle
- **Don't extract single-use helpers** — a method that handles a complete workflow inline is better than several small methods you have to trace through. Only extract when logic is reused
- **Trust the type system** — no defensive null checks on typed data, no fallback defaults for required fields. Validate at system boundaries (user input, external APIs), trust internal code everywhere else
- **Consistency over originality** — new code must look like the code next to it. Same patterns, same naming, same structure. Don't invent new patterns when existing ones work

## Review Hot Spots

Six slips recur in review here, each with BAD/GOOD code in [CODE-EXAMPLES.md § Review Hot Spots](CODE-EXAMPLES.md#review-hot-spots): over-engineering, unnecessary error handling (try-catch only for fire-and-forget, external integrations and cleanup; never re-wrap `ApiError`), not matching existing patterns, adding code where it doesn't belong, adding unnecessary complexity, reinventing existing code.

## Typing

Types flow end-to-end: Elysia route handler return type → Eden Treaty → hook → component. Don't break the chain. Reasoning per rule: [CODE-EXAMPLES.md § Typing](CODE-EXAMPLES.md#typing).

- **No `as any`** — fix the type at the source (route handler return type, schema definition), never by casting in hooks
- **No `as Type` on Eden Treaty responses** — add an explicit return type to the backend route handler or domain method, using the shared type from `packages/lib/src/types/`
- **Shared types live in `packages/lib/src/types/[domain].ts`** — never redefine one; if it doesn't exist yet, add it there so FE and BE share it
- **`type` over `interface`** — except when methods are needed
- **Infer locally, annotate publicly** — no annotations where TypeScript infers; always explicit return types on backend route handlers, domain methods, and hooks
- **`import type` for type-only imports** — separate from value imports
- **Drizzle `.$inferSelect` for DB row types** — never redefine column types by hand

## Code Style

Examples per rule: [CODE-EXAMPLES.md § Code Style](CODE-EXAMPLES.md#code-style).

- **English everywhere** — code, comments, docs, commit messages
- **No JSDoc** — code should be self-documenting
- **Comments only for high-complexity code or functions whose use isn't obvious to a maintainer of this repo, and they explain WHY, never WHAT** — simplified technical English, concision over grammar. Most code needs zero comments; no comment beats slop, and reviewers flag comment slop the same as dead code
- **Backend errors use `ApiError`** — `throw new ApiError(status, message)` for user-facing HTTP errors, never `throw new Error()`; internal invariants (db not open, missing config) may use `throw new Error()`
- **Theme tokens, not colors** — `text-muted-foreground`, `bg-muted`, not `text-gray-500`; `selection-handle` for selection UI
- **Use `cn()` for class merging** — from `@workspace/ui/lib/utils`, never raw `clsx`/`twMerge` or string concatenation
- **Name for grep-ability; don't shadow libraries** — `use*`, `Eigen*`, `*Dialog`, `*Provider`, `invalidate*`, `*Keys`; never reuse a name a dependency owns (`useSearchQuery`, not `useSearch`) or give three helpers one name (`isMobile`)
- **Z-index: app-level components don't set one, and anything above 50 needs a comment** — the scale and its rules: [LAYOUT.md § Z-Index / Layering](LAYOUT.md#z-index--layering)

### Imports

Workspace imports resolve through each package's `exports` map, with no tsconfig aliases: if a specifier doesn't resolve, export the module from its barrel or give it an exports entry. **Never suffix a workspace specifier with `.ts`/`.tsx`.** Prefer the barrel over a deep import; for types and constants this table beats SHARED-PRIMITIVES.md's *Import from* column ([why](CODE-EXAMPLES.md#imports)). The backend imports lib only through React-free subpaths: [ARCHITECTURE.md § Backend imports of lib](ARCHITECTURE.md#backend-imports-of-lib).

| Specifier | What you get |
|---|---|
| `@workspace/ui` | Root barrel: the AGENTS.md Key UI Components, the layout system (app/sidebar/toolbar — not pages), generic leaf primitives |
| `@workspace/ui/components/[area]` | Area barrel (drive, chat, comments, editor, media, user, …) |
| `@workspace/ui/components/[leaf]` | Extensionless deep import for a component its barrel doesn't export (`@workspace/ui/components/search/doc-search-provider`) |
| `@workspace/ui/components/layout/[dir]` | Layout system barrels: `app`, `pages`, `sidebar`, `toolbar` |
| `@workspace/ui/hooks/[hook]` | Shared DOM/interaction hooks (`@workspace/ui/hooks/use-long-press`) |
| `@workspace/ui/lib/utils` | `cn()` utility |
| `@workspace/lib/[domain]` | Domain barrel: hooks, query keys, invalidators |
| `@workspace/lib/types/[domain]` | Shared FE/BE types |
| `@workspace/lib/constants/[x]` | Shared constants (`@workspace/lib/constants/stale-time`) |
| `@workspace/lib/api` | Eden Treaty API client factories |
| `@workspace/lib/date` | Date formatting (`formatDate`, `formatTime`, `formatTimeAgo`) |
| `@workspace/lib/validation` | Shared FE/BE validation schemas |

**User-visible dates are day-month-year** — "5 January 2026", "5 Jan", "5 Jan 2026, 14:30", "Mon 5 Jan", never "January 5, 2026": format through `formatDayMonth` / `formatDate` in `@workspace/lib/date` (they assemble the order from the `'en'` locale's parts; `'en-GB'` spells a short September "Sept" in browsers), and write hand-built shapes as `d MMM yyyy`. Spelling everywhere else stays en-US.

## Key Patterns

Worked examples: [CODE-EXAMPLES.md § Key Patterns](CODE-EXAMPLES.md#key-patterns).

- **Query keys** — hierarchical per domain (`driveKeys.folder(ownerId, mountId, pathId)`) and always including `ownerId`, or personal and team contexts serve each other's stale cache. Every `useQuery` has: `queryKey` from the domain keys, `queryFn` with error checking, an `enabled` guard, an explicit `staleTime`
- **API client (Eden Treaty)** — `driveApi({ ownerId })({ mountId }).folder({ pathId }).get()`; types flow directly from the Elysia route definitions, no manual type sync
- **Error handling** — in hooks (`packages/lib/src/core/[domain]/hooks/`), never in app components: every `useMutation` has `onError` using `onMutationError` from `api-error.ts`; apps never add `try/catch` + `toast.error()`. Full pattern: [NOTIFICATIONS.md](NOTIFICATIONS.md)
- **Invalidation functions** — export `invalidateFoo(queryClient, ...)` next to the query keys; apps call these, never `useQueryClient` + `invalidateQueries()` directly

## Self-Review Checklist

Before declaring any task complete, review every changed file against this list:

- Did you read 2-3 existing files in the same directory before writing new code?
- Are hooks in `packages/lib/src/core/[domain]/hooks/`, not in app components?
- Are there any unnecessary abstractions, helpers, wrappers, or indirection?
- Did you check `packages/ui/src/components/` and `packages/lib/src/` for existing utilities/components before writing new ones? (`cn()`, `formatDate`, `TooltipButton`, `DeleteDialog`, etc.)
- Are you using theme tokens, not hardcoded colors?
- Did you avoid adding try-catch, null checks, or fallbacks for cases that can't happen?
- Do new `useQuery` hooks have `enabled` guards and `staleTime`?
- Does the new code match the patterns and naming of its neighbors?
- Any new `z-index` set above 50? If yes, is it on the documented exceptions or does it have a `// Why:` comment? (See [LAYOUT.md § Z-Index / Layering](LAYOUT.md#z-index--layering))

## Standards Gates

The mechanical rules on this page are enforced, not just documented: Biome carries what it can express, and `bun scripts/check-standards.ts` (part of `bun run check`) counts twelve metrics over `apps/` and `packages/`: seven hard zeros and five ratcheting counts whose allowance in `scripts/standards-baseline.json` can fall but never rise (`bun run standards:update` after a cleanup). What each metric catches: [CODE-EXAMPLES.md § Standards Gates](CODE-EXAMPLES.md#standards-gates).
