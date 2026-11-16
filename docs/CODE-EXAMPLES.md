# Code Examples

> **TLDR:** The long-form companion to [CODE-STANDARDS.md](CODE-STANDARDS.md), which carries the rules: the review hot spots with BAD/GOOD code, the worked examples behind the key patterns, and exactly what `bun scripts/check-standards.ts` measures.

Open a section here when a rule in CODE-STANDARDS.md is not obvious, or when a review points at one of the hot spots. Each section carries the name of the CODE-STANDARDS.md section it explains. A rule itself changes in CODE-STANDARDS.md, and this file follows it.

## Code Philosophy

The rules are in [CODE-STANDARDS.md § Code Philosophy](CODE-STANDARDS.md#code-philosophy); these are the reasons that are not obvious from them.

- **Our own replies are not re-checked** even from a child process or another Home, because a child or Home that a bad upload compromised already has the filesystem: re-checking its replies guards nothing.
- **A wipe needs a restorable copy, not only a guard**, because a flag kept in another file than the data it guards can be wrong about that data.
- **Patches cost more than the features they save**: the owner would rather ship less than grow a pile of special cases, flags and retries. Code that routes around a framework's own pipeline is a hack of the same kind.

## Review Hot Spots

These six slips recur in review here. Each shows the shape to avoid and the shape this codebase uses.

### Over-engineering

BAD: creating abstractions that aren't needed:
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

GOOD: just do the thing directly:
```typescript
home.notify({ type: 'chat:message', title, ... });
```

### Unnecessary error handling

BAD: defensive code around trusted internals:
```typescript
const { path } = await drive.resolveFile(mountId, pathId);
if (!path) throw new ApiError(404, 'Path not found'); // resolveFile already throws
try {
    await drive.deletePath(mountId, pathId);
} catch (error) {
    console.error('Failed to delete path:', error);
    throw new ApiError(500, 'Delete failed');        // ApiError already bubbles up
}
```

GOOD: trust the type system and let errors propagate:
```typescript
const { path } = await drive.resolveFile(mountId, pathId); // throws ApiError(404) if missing or trashed
await drive.deletePath(mountId, pathId);                    // errors bubble to Elysia handler
```

Only use try-catch for: (1) fire-and-forget where failure is acceptable, (2) external integrations, (3) cleanup that must run regardless. Never re-wrap ApiError.

### Not matching existing patterns

BAD: writing a query hook differently from the others in the same file:
```typescript
// Using different key structure, missing enabled guard, no staleTime
export function useFolder(folderId: string) {
    return useQuery({ queryKey: ['folder', folderId], queryFn: async () => { ... } });
}
```

GOOD: match the exact pattern of sibling hooks:
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

BAD: API calls, error toasts, or query hooks in app components:
```typescript
// In apps/drive/src/components/folder-view.tsx
const { data } = useQuery({ queryKey: ['drive', 'folder', id], ... });
toast.error('Something went wrong');
```

GOOD: hooks in `packages/lib`, error handling in hook callbacks, apps just use the hook:
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

BAD: redefining types and reimplementing utilities that already exist in shared packages:
```typescript
// Redefining a type that exists in packages/lib/src/types/chat.ts
type ChatMessage = { id: string; content: string; userId: string; createdAt: number };

// Reimplementing date formatting instead of using @workspace/lib/date
const formatted = new Date(timestamp).toLocaleDateString('en-US', { ... });

// Using clsx directly instead of the project's cn() wrapper (which adds tailwind-merge)
import clsx from 'clsx';
const classes = clsx('px-4', isActive && 'bg-blue-500');
```

GOOD: import from shared packages:
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

- **No `as any`**: fix the type at the source (route handler return type, schema definition), not by casting in hooks. Eden Treaty gives end-to-end safety; `as any` silently breaks it
- **No `as Type` on Eden Treaty responses**: if `response.data` has the wrong type, add an explicit return type to the backend route handler or domain method using the shared type from `packages/lib/src/types/`. Don't paper over mismatches with `as` casts in hooks
- **Shared types live in `packages/lib/src/types/[domain].ts`**: never redefine a type that already exists there. Import it. If the type doesn't exist yet, add it to the shared package so both FE and BE use it
- **`type` over `interface`**, except when methods are needed
- **Infer locally, annotate publicly**: don't annotate variables when TypeScript can infer (`const path = await drive.getPath(...)` not `const path: DrivePath = ...`). But always add explicit return types on backend route handlers, domain methods, and hooks: this is what powers Eden Treaty's end-to-end type flow. A hook that returns its `useQuery`, `useInfiniteQuery` or `useMutation` call as it is takes none, since Eden's type already flows through it
- **`import type` for type-only imports**, separate from value imports: `import type { DrivePath } from '@workspace/lib/types/drive'`
- **Drizzle `.$inferSelect` for DB row types**: use `typeof schema.messages.$inferSelect` for database row shapes, don't manually redefine column types

## Code Style

The rules are in [CODE-STANDARDS.md § Code Style](CODE-STANDARDS.md#code-style); this is the full form with the examples.

- **English everywhere**: code, comments, docs, commit messages
- **No JSDoc**: code should be self-documenting. Comments only where logic isn't obvious
- **Every source file opens with a header comment**, then a blank line, then the imports. It tells a developer who has never seen the file what the code does, why it exists, and where it sits in the bigger picture: who calls it, what it calls, when it runs. Plain words, two to five lines. Every `.ts`/`.tsx` source file gets one, `scripts/` and the `packages/sheet` fork included. It names functions and concepts (`getHome`), never file paths or docs, because those move and the IDE finds callers anyway. No history, no TODOs. Test files, generated files and config files have none. A good header:

  ```ts
  // A Home is everything one owner keeps on this server, such as a user's files, mail and calendar,
  // or the smaller set a team has. Every request reaches that data through getHome(ownerId), which
  // builds the Home on first use. It stays loaded while it is used and closes itself, databases
  // included, after a few idle minutes. This base class owns that lifecycle; each kind of home
  // decides which parts it has.
  ```

  A bad one: `// Home class. See STORAGE.md and get-home.ts. Uses allSettled since AUDIT 13.` It names the class instead of the idea, points at files that move, and tells history.

  A header is self-contained: it states what this file owns and stays true whatever other files do. Facts another file owns, such as which kinds exist, which parts they have or who calls this file, appear only as examples ("such as", "for example"), never as a complete list. The test: after someone adds a caller, a subclass or a feature elsewhere, is the header still true? A header that lists "the user, team, org and guest homes" is wrong the day someone adds an admin home.
- **Beyond the header, comments are only for high-complexity code, or functions whose use wouldn't be obvious to a maintainer of this repo**, and they explain WHY, never WHAT. Write them in plain English that a non-native reader understands on the first read: short sentences, common words, no chains of jargon. `// Walk parentId chain to find outermost container` is good, `// Set the variable to true` is noise. Most code needs zero comments, and no comment is better than slop. Reviewers should flag comment slop the same as dead code
- **Every class member states its access**: `public`, `private` or `protected`, the narrowest that compiles, so a reader sees at a glance what the rest of the code may use
- **Backend errors use `ApiError`**: `throw new ApiError(status, message)` for user-facing HTTP errors, never `throw new Error()`. Exception: internal invariants (db not open, missing config) may use `throw new Error()` since an HTTP status code wouldn't be semantically correct
- **Theme tokens, not colors**: use `text-muted-foreground`, `bg-muted`, not `text-gray-500`, `bg-blue-50`. Use `selection-handle` token for selection UI (resize handles, bounding boxes)
- **Use `cn()` for class merging**: import from `@workspace/ui/lib/utils`, never use raw `clsx`/`twMerge` or string concatenation for conditional Tailwind classes
- **UI labels are sentence case**: the proper nouns that keep their capital are Eigen and its apps used as names (Drive, Docs, Sheets, Slides, Mail, Calendar, Contacts, Chat, Stickies, Vector, Space), other products (Word, Excel, PowerPoint, Google Docs, Thunderbird), protocols and formats (WebDAV, CalDAV, IMAP, S3, PDF, CSV, URL, ID, 2FA) and key names (Enter, Tab, Shift). The gate's list is `PROPER_NOUNS` in `scripts/sentence-case.ts`. User-visible dates go through `formatDayMonth` / `formatDate`, which assemble the day-month order from the `'en'` locale's parts, because `'en-GB'` spells a short September "Sept" in browsers
- **Name for grep-ability; don't shadow libraries**: use the established prefixes so a whole category is one search away: `use*` (hooks), `Eigen*` (brand components), `*Dialog`, `*Provider`, `invalidate*` (cache helpers), `*Keys` (query-key factories). Don't reuse a name a dependency already owns (our search hook is `useSearchQuery`, not `useSearch`, to stay clear of TanStack Router's `useSearch`), and don't give three different helpers the same name (`isMobile`)

## Imports

The rules are in [CODE-STANDARDS.md § Imports](CODE-STANDARDS.md#imports); this is the resolver table and the reasoning around it.

| Specifier | What you get |
|---|---|
| `@workspace/ui/components/[name]` | One component, such as `@workspace/ui/components/confirm-dialog`. The package has no root entry, so every component, the everyday ones included ([ARCHITECTURE.md § Frontend](ARCHITECTURE.md#frontend), *Everyday UI*), comes from its own sub-path |
| `@workspace/ui/components/[area]` | Area barrel (drive, chat, comments, editor, media, user, …) |
| `@workspace/ui/components/[area]/[leaf]` | Extensionless deep import for a component its barrel doesn't export (`@workspace/ui/components/search/doc-search-provider`) |
| `@workspace/ui/components/layout/[dir]` | Layout system barrels: `app`, `pages`, `sidebar`, `toolbar` |
| `@workspace/ui/hooks/[hook]` | Shared DOM/interaction hooks (`@workspace/ui/hooks/use-long-press`) |
| `@workspace/ui/lib/utils` | `cn()` utility |
| `@workspace/lib/[domain]` | Domain barrel: hooks, query keys, invalidators |
| `@workspace/lib/types/[domain]` | Shared FE/BE types |
| `@workspace/lib/constants/[x]` | Shared constants (`@workspace/lib/constants/stale-time`) |
| `@workspace/lib/api` | Eden Treaty API client factories |
| `@workspace/lib/date` | Date formatting (`formatDate`, `formatTime`, `formatTimeAgo`) |
| `@workspace/lib/validation` | Shared FE/BE validation schemas |
| `@workspace/math` | The math package's one barrel: the equation tree, its OMML, MathML and LaTeX readers and writers, and the LaTeX command table ([MATH.md](MATH.md)) |

Workspace imports resolve through each package's `exports` map (`packages/*/package.json`). There are no tsconfig path aliases for `@workspace/*`. If a specifier doesn't resolve, the module isn't public: export it from its barrel or give it an exports entry, don't reach around the map. **Never suffix a workspace specifier with `.ts`/`.tsx`**: suffixed specifiers don't resolve, and Biome rejects them. An exports-map array target is for tsc only, since Bun takes the first entry, and a `*` in a subpath also matches across `/`.

Prefer the barrel over a deep import when both reach the same primitive. SHARED-PRIMITIVES.md's *Import from* column lists the shortest specifier that resolves each primitive. It is the right default for components, hooks, and utils, but **not** authoritative for types and constants, where it collapses to the aggregate `@workspace/lib/types` / `@workspace/lib/constants`. There the table above wins: import types from `@workspace/lib/types/<domain>` and constants from `@workspace/lib/constants/<x>`; the bare aggregate specifiers are tolerated, not the convention. Backend code imports lib only through the React-free subpaths: see [ARCHITECTURE.md § Backend imports of lib](ARCHITECTURE.md#backend-imports-of-lib).

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

Types flow directly from Elysia route definitions, so no manual type sync is needed.

```typescript
import { driveApi } from '@workspace/lib/api';
const response = await driveApi({ ownerId })({ mountId }).folder({ pathId }).get();
```

## Standards Gates

The mechanical rules in [CODE-STANDARDS.md](CODE-STANDARDS.md) are enforced, not just documented. Biome carries what it can express (`noExplicitAny` is an error, and `noRestrictedImports` rejects extension-suffixed workspace specifiers and `lib → ui/sheet` imports). Everything else runs through `bun scripts/check-standards.ts`, part of `bun run check`. It scans non-test, non-generated `.ts`/`.tsx` under `apps/` and `packages/` (the jison output `grammar-parser.ts` in the sheet engine counts as generated) and counts twenty-one metrics.

Fourteen are hard zeros, and any hit fails: `"use client"` directives, imports reaching past a package barrel (`@workspace/lib/core/…`, `@workspace/lib/src/…`, `@workspace/ui/src/…`, extension-suffixed specifiers), `export type` re-exports from a `packages/lib/src/core/**/index.ts` barrel, and `useQuery`/`useMutation`/`useInfiniteQuery`/`toast.error`/`toast.success` calls in an app outside a `hooks/` folder, plus ten rules that enforce conventions this prose states:

- **Non-canonical `application/eigen…` MIMEs**: the canonical six are read out of the `DRIVE_MIME_*` constants in `packages/lib/src/types/drive.ts` at run time, so a seventh document type needs no second list. Catches `eigenslide` for `eigenslides` and `eigensheet` for `eigensheets`. The `application/eigen-*` wire formats (drag, clipboard) are a different family and are not document MIMEs
- **Authenticated routes without `:ownerId` second**: every `{ auth: true }` route in `apps/api/src/routes/` must carry `:ownerId` as its second path segment. Unauthenticated routes answer to no Home and are skipped; the home-independent route files are exempt in one list in the script, `OWNER_ID_EXEMPT`; `/ws` counts as a transport prefix, not a segment
- **Delete or remove menu rows without the destructive variant**: a `DropdownMenuItem` or `SelectItem` that draws a `Trash2` icon, or whose label (JSX text or a string literal) says Delete, Remove or to trash, must carry `variant="destructive"`; a row tinted by `text-destructive` instead fails too ([LAYOUT.md § A row that deletes is red and last](LAYOUT.md#a-row-that-deletes-is-red-and-last)). A toggle's label, a ternary with one branch saying Remove and the other not, is an undo and does not count
- **Menu rows drawing their own check**: a `DropdownMenuItem` that draws a `Check` when a condition holds fails; a choice's options go through `ChoiceMenuItems` or `ChoiceMenuSub` and a toggle is a `DropdownMenuCheckboxItem`, so every menu checks a row the same way ([LAYOUT.md § A choice is a submenu with a check](LAYOUT.md#a-choice-is-a-submenu-with-a-check)). The color picker's swatch grid, which marks its color inside the swatch, is exempt
- **Dialog footers outside FormDialog**: a file under `apps/` or `packages/` that uses `DialogFooter` fails, because a dialog with a title, fields and Cancel/submit is a `FormDialog` with a `FormDialogForm`, which draws the footer, makes Enter submit and holds every close while a save runs. The gate sees only `DialogFooter`: a footer drawn by hand, or a `ConfirmDialog` with an input, passes, and review catches those. `dialog.tsx`, which defines it, `form-dialog.tsx` and tests pass. A dialog that is not a form (information only, several actions, a picker, a grid), or not yet moved onto `FormDialog`, is a reviewed exception on `OWN_DIALOG_FOOTER` in `scripts/dialog-footer.ts`, one path with its reason. A listed file that no longer uses `DialogFooter`, or is gone, fails too, so a dialog that moves onto `FormDialog` leaves the list in the same commit and the list only shrinks
- **Hover-revealed affordances without touch**: a hiding utility (`invisible`, `hidden`, `opacity-0`) plus a revealing `group-hover:` in the same class string needs the matching `pointer-coarse:` variant, because touch has no hover. A decorative `group-hover:scale-105` reveals nothing and does not count, and `pointer-fine:group-hover:` declares the hover desktop-only on purpose
- **Hover reveals Tab skips or a click keeps shown**: a bare `invisible` that a `group-hover:` makes visible, or a bare `hidden` that a `group-hover:` displays, fails, because Tab skips what they hide; so does a reveal on `focus:`, `focus-within:` or their `group-` forms, which keeps a control shown after a mouse click once the pointer has left, while `focus-visible:` and `group-has-focus-visible:` pass ([LAYOUT.md § Hover-revealed affordances rest visible on touch](LAYOUT.md#hover-revealed-affordances-rest-visible-on-touch)). A `hidden md:flex` beside an unrelated `group-hover:` reveals nothing and passes, and so does a hint with `pointer-events-none` and no `pointer-events-auto`, which holds no control
- **Module state, a draw or a locale call in the formula engine**: in `packages/formula/src` outside its tests, a `let` or `var` at module level, an empty `Map`, `Set`, `WeakMap`, `WeakSet`, `[]` or `{}` made at module level without a `readonly` type, any use of `Math` but a member other than `random`, and a `localeCompare` or `toLocale…` call fail; biome refuses `Date`, `Intl`, `performance` and `globalThis` there. A function's body keeps nothing between calls, so a reader, a list or a token cannot outlive its call, and one formula computes the same on every machine: state lives on the `Evaluator` or a `Frame`, the time and a draw reach a body only as the `NOW` and `RANDOM` parameters, which the author's pass hands out, and text orders and shows by the engine's own rules. A module-level typed array or object literal, such as the lexer's tables, passes.
- **Shared primitives nothing imports**: a function, hook, constant or component that [SHARED-PRIMITIVES.md](SHARED-PRIMITIVES.md) lists needs an importer outside its own file. `scripts/unused-primitives.ts` reads every tracked source file, tests and `scripts/` included, follows each import through the packages' `exports` maps and their barrels to the file that defines the name, and counts destructured or member-read dynamic imports and a `Promise.all` of them; a barrel that only passes a name on, a spread of a whole dynamic import and an import inside a comment or a string are no use. The fix is to drop the `export`, or the symbol when its own file doesn't use it either. A name only tests import is listed after the table but not gated, and the helpers of `packages/ui/src/test/` are exempt. The script reads the index, so a new export is seen once `bun run primitives` lists it, which `primitives:check` demands
- **Capitalized words in UI labels**: a word after the first that starts with a capital fails, in a string given to `label`, `title`, `placeholder`, `tooltipText`, `submitLabel`, `dialogTitle`, `confirmTitle`, `confirmText` or `cancelText` and in the text of `DialogTitle`, `Label`, `FormLabel` and `FieldLabel` ([CODE-STANDARDS.md](CODE-STANDARDS.md), UI labels are sentence case). Proper nouns pass from `PROPER_NOUNS` in `scripts/sentence-case.ts`, grown only from a real hit, and so does any all-caps acronym; the demo seed under `apps/api/src/scripts/demo/` is sample content and is skipped

The other seven ratchet: `as Type` casts, `!` non-null assertions, `interface` declarations (module augmentation excepted, since it only merges through interfaces), `biome-ignore` suppressions, JSDoc blocks, raw Tailwind color utilities, and shared types nothing imports, counted as the primitives above are, where the props type of a used component is not counted. Their allowance lives in `scripts/standards-baseline.json`, so a count can fall but never rise. Casts and `!` are allowed per file, a map from path to count, so a new one fails even when the same diff removes one elsewhere, and a file without an entry is allowed none. `as const` and a mapped type's key remap (`[P in Parts as Key<P>]`) are not casts. A `!` counts after a name, a call or an index, `!=` excepted, so `let x!: T` counts too. The other five keep one total. Every run writes a count that fell into the baseline, so commit `scripts/standards-baseline.json` with the cleanup; the script never raises a baseline. A `git mv` moves a file's cast and `!` entries to its new path by hand in the same commit, or the moved file starts at none. `bun run standards -- --verbose` prints the per-file breakdown.

The ratchet stops laziness, not natural code: a `biome-ignore` with a reason and a hand-raised baseline beats restructuring code only to silence a rule.

The script reads its files from `git ls-files`, so a probe file that tests a gate must be tracked, or the gate never sees it.
