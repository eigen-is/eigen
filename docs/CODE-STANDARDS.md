# Code Standards

How code in Eigen is written, and the bar a reviewer holds every change to ([REVIEW-STANDARD.md](REVIEW-STANDARD.md)). New code looks like the code next to it. Reasons and BAD/GOOD code are in [CODE-EXAMPLES.md](CODE-EXAMPLES.md) under the same headings, where files go is in [ARCHITECTURE.md](ARCHITECTURE.md), and what a machine can count is gated ([§ Standards Gates](#standards-gates)).

## Code Philosophy

Simplicity, directness and consistency over cleverness. When in doubt, match what the same directory does.

- Flat and direct: no service layers, repository patterns or dependency injection. Routes call domain classes; domain classes query the database with Drizzle
- No single-use helpers: one method for a whole workflow beats several you must trace. Extract only reused logic
- Trust the type system fully. Validate only at a boundary, which is anything a person or another program wrote: a request body, an uploaded or imported file, a collaborator's Yjs edit, inbound mail, an external API. What our own code produced is never checked again: a reply from our own transform child, a message between Homes, a row or file we wrote, an argument from another module. So no shape check, `typeof` guard, null check or fallback default on typed data, and no try/catch to survive a malformed result of our own call. This holds only while types tell the truth, which is why casts are banned
- No code for tests in production: no option, field, method, setter, timeout knob or state reset that only a test uses. A test drives the public path, and may import an exported constant or pure function to read a limit or test a unit
- Consistency over originality: the neighbours' patterns, naming and structure; no new pattern where one exists
- Fewer lines beat more: remove code whenever what remains is cleaner. Over-engineering (a flag threaded through layers, a prop every caller passes the same value for, a seam for a case that cannot happen) is a broken window: remove it on touch, never add it to close a nit
- Clean code beats more features: a feature or edge case that only a patch (a special case, a second code path, a flag, a cache, a retry) can cover is dropped or accepted, and you say so. Fix at the cause; when a second fix in one module needs a patch, redesign the module
- Not every edge case needs code: a rare case may fail with an error, a timeout or a user's retry while the server stays up and responsive and no stored data is lost. Handle it only when it can crash or block the server, lose or corrupt data, or leak access
- The file system is the truth, then the database. No memory state a restart would lose or that can disagree with disk: no module-level maps, sets or caches in the API to save a read, a download or a job. State about what this process is doing now (an open document, a lock, a restore) is the exception. In the frontend, TanStack Query is the only cache
- No placeholders: no stub method, type, field or flag for later. Code lands with its first real caller
- No backward compatibility for now (until the owner says otherwise, maybe from 0.5.0): no code for data an older build wrote. A renamed stored key is renamed, not kept beside the new one or dropped on read, and a reader for an old shape is deleted when you pass it, even if that loses an older build's data, such as an unreplayed edit
- Fix the root cause through the framework's own pipeline: a guest session goes through better-auth's API, never a hand-inserted row
- Speed first: independent work (requests, uploads, copies) runs in parallel; heavy work stays off the main thread and the server's event loop. Fix a race where it starts, never by queueing work
- Code that wipes or overwrites data first writes a timestamped copy it can restore from, and a failed copy stops the wipe; skip it only when there is nothing to lose. A guard alone is not enough

## Review Hot Spots

Six slips recur, with BAD/GOOD code in [CODE-EXAMPLES.md § Review Hot Spots](CODE-EXAMPLES.md#review-hot-spots): over-engineering, needless error handling (try/catch only for fire-and-forget, external integrations and cleanup; never re-wrap `ApiError`), not matching existing patterns, code in the wrong place, needless complexity, reinventing existing code.

## Typing

Types flow end to end: Elysia handler return type → Eden Treaty → hook → component ([CODE-EXAMPLES.md § Typing](CODE-EXAMPLES.md#typing)).

- No casts or non-null assertions in new code: no `as Type`, `as any`, `as unknown as` or `!` (`as const` is fine). Narrow with a type guard or `instanceof`, or fix the type at its source (a handler's return type, a schema, an optional field that is always set). Removing an old cast elsewhere doesn't pay for a new one
- A CSS variable in a `style` object needs no cast: React's `CSSProperties` accepts `--*` keys here (`style={{ '--gap': spacing }}`)
- Eden responses keep their inferred type: the backend handler or domain method gets an explicit return type from `packages/lib/src/types/`
- Shared types live in `packages/lib/src/types/[domain].ts`, never redefined; a missing one is added there. Only the leaves `@workspace/math` and `@workspace/formula` own their own ([ARCHITECTURE.md § Dependency direction](ARCHITECTURE.md#dependency-direction))
- `type` over `interface`, except when methods are needed
- Infer locally, annotate publicly: explicit return types on backend route handlers, domain methods and hooks, none where TypeScript infers. A hook that returns its `useQuery`, `useInfiniteQuery` or `useMutation` call as it is takes none: the route's type already flows through it from Eden, and a written one would only repeat it
- `import type` as its own statement beside the value import from the same module, so each import fits on one line
- Drizzle `.$inferSelect` for row types, never hand-written column types
- One type per concept: pass `User` or `DrivePath` even when a function reads two fields, never a narrower projection; convert a library's narrower shape where it enters. Test fixtures may keep their own
- Readonly where the holder doesn't let you write: a collection a hook, store or class owns goes out as `ReadonlySet`, `ReadonlyMap` or `readonly T[]`, and a function takes one it doesn't change as readonly. No lint asks for it, so review does, on code you touch, not as a sweep
- Only `apps/api`'s tsconfig sets `noPropertyAccessFromIndexSignature`: an index-signature read that compiles in `packages/sheet` fails in the API

## Code Style

Examples: [CODE-EXAMPLES.md § Code Style](CODE-EXAMPLES.md#code-style).

- English everywhere. No JSDoc
- Every `.ts`/`.tsx` source file, `scripts/` and the `packages/sheet` fork included, opens with a header comment and a blank line: two to five plain lines on what the file does, why it exists and where it sits (who calls it, when it runs). What other files own (kinds, parts, callers) appears only as examples, so it stays true when they change; no file paths or doc links. Test, generated and config files and a re-export-only barrel have none. An older file gets one the first time it changes. How: the [source-file skill](../.claude/skills/source-file/SKILL.md)
- Comments are rare: one or two short lines with a why a careful reader of this repo would not guess, in plain whole sentences, reason first. Most functions, fields and parameters have none; a needless comment is flagged like dead code. A reason that needs more is a design decision for the domain doc, or code to simplify
- Never in a comment: callers, what the header or domain doc says, a tour of fields or states, an edge case (its test names it), a measurement or incident, an answer to a reviewer, history, "see X" chains. A comment longer than its code is a patch smell: fix the code, or accept the edge case and delete both
- Every class member states `public`, `private` or `protected`, the narrowest that compiles, in this order: fields, constructor, getters, lifecycle (init, close), the rest
- Kebab-case file names; route files follow TanStack Router. Named exports only, except a config file whose tool needs a default (`vite.config.ts`, the Drizzle config). Fix an older file when you clean it up
- User-facing HTTP errors are `throw new ApiError(status, message)`; `throw new Error()` only for internal invariants (db not open, missing config)
- Think about every `await`: `if (!asyncFn())` is always false. Fire-and-forget has a `.catch()`; skip the `await` only when blocking hurts response time and failure is acceptable
- Sanitize user paths: refuse `..`, `/` and control characters before filesystem or header use; never put raw user input in an HTTP header
- `for (const x of arr)`, not `arr.forEach` (es-toolkit's `forEach(coll, fn)` excepted); flip one when you touch it
- Theme tokens, not colors (`text-muted-foreground`, not `text-gray-500`; `selection-handle` for selection UI). Merge classes with `cn()` from `@workspace/ui/lib/utils`, never `clsx`, `twMerge` or concatenation
- Name for grep: `use*`, `Eigen*`, `*Dialog`, `*Provider`, `invalidate*`, `*Keys`. Never reuse a dependency's name (`useSearchQuery`, not `useSearch`) or give three helpers one name (`isMobile`)
- Z-index: app components set none, and above 50 needs a comment ([LAYOUT.md § One z-index scale, and app code sets none](LAYOUT.md#one-z-index-scale-and-app-code-sets-none))

### Imports

Workspace imports resolve through each package's `exports` map, never tsconfig aliases: a specifier that doesn't resolve needs a barrel export or an exports entry. **Never suffix a workspace specifier with `.ts`/`.tsx`.** Prefer the barrel to a deep import. Types come from `@workspace/lib/types/<domain>` and constants from `@workspace/lib/constants/<x>`, whatever SHARED-PRIMITIVES.md's *Import from* column says. Every specifier: [CODE-EXAMPLES.md § Imports](CODE-EXAMPLES.md#imports). The backend imports lib only through React-free subpaths ([ARCHITECTURE.md § Backend imports of lib](ARCHITECTURE.md#backend-imports-of-lib)).

### Dates and labels

**User-visible dates are day-month-year**: "5 January 2026", "5 Jan 2026, 14:30", "Mon 5 Jan", never "January 5, 2026". Use `formatDayMonth` / `formatDate` from `@workspace/lib/date` (not `'en-GB'`), and `d MMM yyyy` for hand-built shapes. Every `toLocale*String` on a date passes `'en'`, never `[]` or no locale, or a Dutch browser writes "januari"; fix a sibling that passes `[]` on touch. A plain number's `.toLocaleString()` stays. Other spelling is en-US: fix British spelling on touch.

**UI labels are sentence case**: only the first word and proper nouns start with a capital ("Keep aspect ratio"), in buttons, menu items, dialog titles, tabs, field labels, tooltips, placeholders, toasts, empty states and section headings. `bun scripts/check-standards.ts` fails a capital after the first word in a label prop or element; `PROPER_NOUNS` in `scripts/sentence-case.ts` is the one list of names that keep theirs. Help-center articles quote labels exactly, so a renamed label changes the articles that bold it in the same commit.

## Key Patterns

Worked examples: [CODE-EXAMPLES.md § Key Patterns](CODE-EXAMPLES.md#key-patterns).

- **Query keys** are hierarchical per domain (`driveKeys.folder(ownerId, mountId, pathId)`) and always include `ownerId`, or personal and team contexts serve each other's stale cache. Every `useQuery` has a `queryKey` from the domain keys, a `queryFn` that checks errors, an `enabled` guard or `skipToken` and an explicit `staleTime`
- **A query whose argument may be missing** passes `skipToken` as its `queryFn` (`queryFn: teamId ? () => … : skipToken`) instead of `enabled: !!teamId` plus `teamId!`, so the guard also narrows the type
- **Eden Treaty**: `driveApi({ ownerId })({ mountId }).folder({ pathId }).get()`, typed from the Elysia routes
- **Errors are handled in hooks**, never app components: every `useMutation` has an `onError` using `onMutationError` from `api-error.ts`; apps add no `try/catch` + `toast.error()` ([NOTIFICATIONS.md](NOTIFICATIONS.md))
- **Invalidation**: export `invalidateFoo(queryClient, ...)` beside the query keys; apps call it, never `useQueryClient` + `invalidateQueries()`
- **Timestamps are `Date` end to end**: an `INTEGER` column of Unix seconds with Drizzle `mode: 'timestamp'`, routes that return `Date` (never `.toISOString()`), shared types that say `Date`; Eden's reviver restores it. A path-param time bound stays `t.Numeric()`. `assertJson<T>` in API tests and a raw `fetch` + `res.json()` skip the reviver, so revive there. The reviver also turns a bare `YYYY-MM-DD` into a `Date`, so date-only payloads go through `plainApi`; one that also carries timestamps, such as a calendar occurrence, puts its date back in the read hook

## Self-Review Checklist

Before calling a task complete, check every changed file: 2–3 siblings read first; hooks in `packages/lib/src/core/[domain]/hooks/`; no needless abstraction, helper, wrapper or indirection; existing utilities and components reused (`cn()`, `formatDate`, `TooltipButton`, `DeleteDialog`); theme tokens; no try/catch, null check or fallback for a case that can't happen or on data our own typed code produced; no option, method, setter or reset only a test uses; `enabled` and `staleTime` on new `useQuery` hooks; the neighbours' patterns and naming; owned collections handed out readonly, unchanged ones taken readonly; a header comment that is still true; every comment at most two lines, a why the code can't say, clear on first read; no code for a rare edge case that can't crash or block the server, lose data or leak access; a `z-index` above 50 a documented exception or with a `// Why:` comment.

## Standards Gates

Biome carries what it can express, including `style/useImportType` with `separatedType` and `style/useConsistentMemberAccessibility` with `explicit`. `bun scripts/check-standards.ts`, part of `bun run check`, counts twenty-one metrics over `apps/` and `packages/`: fourteen hard zeros and seven ratchets whose allowance in `scripts/standards-baseline.json` can fall but never rise. Casts and `!` are allowed per file, so a new one fails even where the same diff removes another, and an unlisted file is allowed none; a `git mv` moves the file's entries by hand in the same commit. Each run rewrites the baseline when a count fell, counting the working tree: commit it with the change, or reset it if the drop isn't yours; never leave it dirty in a shared tree. What each metric catches: [CODE-EXAMPLES.md § Standards Gates](CODE-EXAMPLES.md#standards-gates).

An exported primitive needs a user outside its file: search [SHARED-PRIMITIVES.md](SHARED-PRIMITIVES.md) before building one. A function, hook, constant or component the index lists that nothing else imports fails the script, and such a type counts against its baseline; one only tests import passes, and a used component's props type may stay exported.

Never restructure code just to silence a lint rule: use a lint-clean idiom that reads naturally (`/\p{Cc}/gu` for control characters), else a `biome-ignore` with a one-line reason and its baseline raised by hand in the same commit.
