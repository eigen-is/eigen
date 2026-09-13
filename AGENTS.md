# AGENTS.md — Eigen Project Context

Eigen is a self-hosted alternative to Google Workspace. Monorepo with integrated apps sharing a single API server, UI library, and business logic layer.

Layout, stack, and scripts are derivable — read `package.json` (scripts + workspaces) and `ls apps packages`. Two things that aren't written down anywhere else: the API serves every app from port 8000, and `packages/sheet` is a fork of fortune-sheet/luckysheet.

## Critical Rules

- **No AI co-author trailers in commits** — never add `Co-authored-by: Claude/Copilot/...` lines to commit messages, even if your tooling defaults to it
- **Read [CODE-STANDARDS.md](docs/CODE-STANDARDS.md) before writing code** — typing, style, imports and the **self-review checklist**, which must pass before you declare any task complete
- **Read existing code before writing new code** — read 2-3 existing files in the same directory. Match their style, structure, naming, and patterns exactly. New code must look like it was always there
- **Search [SHARED-PRIMITIVES.md](docs/SHARED-PRIMITIVES.md) before building a shared hook, component, type, or util** — the generated index of everything `packages/ui` + `packages/lib` export. Import what exists; if it's missing, export it from the package barrel so it gets catalogued (`bun run primitives` regenerates it)
- **Read the domain doc before planning or coding** — the index below names it (`docs/COMMENTS.md` before comment features). Don't assume you know the conventions — verify them
- **Always run `bun run check` after changes** — what it runs: [TESTING.md § CI](docs/TESTING.md#ci). When multiple agents run in parallel, only the main agent runs check — concurrent runs cause deadlocks
- **Code goes in the right layer** — hooks/mutations in `packages/lib/src/core/[domain]/hooks/`, shared types in `packages/lib/src/types/`, shared UI in `packages/ui/`, app-specific code in `apps/`. Rule of thumb: if two or more apps need it, it belongs in `packages/`. Never put `useQuery`, `useMutation`, error toasts, or `try/catch` + `toast.error()` in app components — all error handling lives in hooks using `onMutationError`. See [NOTIFICATIONS.md](docs/NOTIFICATIONS.md)
- **Third copy → shared wrapper** — scaffolds too (route guards, editor shells, loading/empty/error treatments): before pasting one into a third app, extract one guarded wrapper into `packages/ui` ([why](docs/ARCHITECTURE.md#third-copy--shared-wrapper))
- **Package dependency direction is one-way: `sheet → lib` and `ui → lib`, never the reverse — `lib` imports neither** (a biome rule enforces it). Why, and where shared sheet types live: [ARCHITECTURE.md § Dependency direction](docs/ARCHITECTURE.md#dependency-direction)
- **The backend imports lib through React-free subpaths, never `core/` domain barrels** — the BE-safe list and how to carve out a new subpath: [ARCHITECTURE.md § Backend imports of lib](docs/ARCHITECTURE.md#backend-imports-of-lib)
- **Don't break the type chain** — types flow from Elysia route handlers → Eden Treaty → hooks → components automatically. No `as any`, no `as Type` casts. Fix types at the source ([CODE-STANDARDS.md § Typing](docs/CODE-STANDARDS.md#typing))
- **Think about every `await`** — a bare async call returns a truthy Promise (`if (!asyncFn())` is always false). Fire-and-forget must have `.catch()`. Skip `await` when blocking would hurt response time and failure is acceptable
- **Sanitize user-provided paths** — validate against `..`, `/`, and control characters before filesystem or header use. Never interpolate raw user input into HTTP headers
- **One source of truth per fact** — a set, map, schema, or constant that answers a question lives in exactly one module. Import it; never re-list its members inline; derive subsets from the canonical one ([why](docs/ARCHITECTURE.md#one-source-of-truth-per-fact))
- **A primitive isn't "shared" until its barrel exports it** — values through `@workspace/ui` / `@workspace/lib/<domain>`, types through `@workspace/lib/types/<domain>`; a deep import past a barrel means it should have been exported ([why](docs/ARCHITECTURE.md#a-primitive-is-shared-only-when-its-barrel-exports-it))
- **Fix broken windows** — fix pre-existing issues if the fix is straightforward
- **Keep docs up to date** — gotchas land in `docs/<DOMAIN>.md`; this file only if cross-domain. A user-visible change corrects the help center (`apps/index/src/data/support/`) in the same cycle, minimally, via the [support-article skill](.claude/skills/support-article/SKILL.md) and [SUPPORT-STYLE-GUIDE.md](docs/SUPPORT-STYLE-GUIDE.md)
- **No hard line-wrapping in Markdown prose** — keep each paragraph on one line; never insert manual line breaks to satisfy a maximum line length. Editors soft-wrap, and rendered HTML is unaffected either way

## Working Method (multi-step changes)

How feature work runs here, plus the Review Standard every reviewer is held to: [WORKING-METHOD.md](docs/WORKING-METHOD.md). Read it when you are orchestrating a multi-step change or reviewing one; an implementer working on a single file doesn't need it.

## Where Things Are Documented

File locations and patterns per concept (backend + frontend tables, package boundaries, pitfalls): [ARCHITECTURE.md](docs/ARCHITECTURE.md). Per domain:

- Drive, storage, mounts, trash, versioning, copy/move: [STORAGE.md](docs/STORAGE.md); soft delete: [SOFT-DELETE.md](docs/SOFT-DELETE.md); file history and watch: [FILE-HISTORY.md](docs/FILE-HISTORY.md)
- Databases: [DATABASE.md](docs/DATABASE.md)
- Sharing and permissions: [ACL.md](docs/ACL.md); guests: [GUEST-ACCESS.md](docs/GUEST-ACCESS.md); organisations and teams: [ORGANISATIONS-AND-TEAMS.md](docs/ORGANISATIONS-AND-TEAMS.md)
- Collab documents (Yjs, offline, restore): [COLLAB.md](docs/COLLAB.md)
- Canvas engine (vector + slides): [CANVAS.md](docs/CANVAS.md), [SLIDES.md](docs/SLIDES.md); clipboard: [CLIPBOARD.md](docs/CLIPBOARD.md)
- Sheets: [SHEETS.md](docs/SHEETS.md); stickies: [STICKIES.md](docs/STICKIES.md); documents: [DOCUMENT-CONTENT-LAYER.md](docs/DOCUMENT-CONTENT-LAYER.md), [INLINE-EDITING.md](docs/INLINE-EDITING.md), [MEDIA-REFERENCES.md](docs/MEDIA-REFERENCES.md)
- Comments: [COMMENTS.md](docs/COMMENTS.md)
- Mail: [MAIL.md](docs/MAIL.md), [IMAP.md](docs/IMAP.md)
- Chat: [CHAT.md](docs/CHAT.md)
- Calendar, CalDAV, iMIP: [CALENDAR.md](docs/CALENDAR.md)
- Contacts, CardDAV: [CONTACTS.md](docs/CONTACTS.md)
- WebDAV: [WEBDAV.md](docs/WEBDAV.md)
- Search: [SEARCH.md](docs/SEARCH.md); in-document find bar: [IN_DOCUMENT_SEARCH.md](docs/IN_DOCUMENT_SEARCH.md)
- SSE, toasts, notification center, activity rows: [SSE.md](docs/SSE.md), [NOTIFICATIONS.md](docs/NOTIFICATIONS.md), [NOTIFICATION-CENTER.md](docs/NOTIFICATION-CENTER.md), [ACTIVITY-ROWS.md](docs/ACTIVITY-ROWS.md)
- Previews, export, off-thread transforms: [PREVIEWS.md](docs/PREVIEWS.md), [EXPORT.md](docs/EXPORT.md), [DOCUMENT-TRANSFORMS.md](docs/DOCUMENT-TRANSFORMS.md)
- Uploads and S3 sync: [SYNC.md](docs/SYNC.md), [STREAMING_UPLOADS.md](docs/STREAMING_UPLOADS.md)
- Backup and restore: [BACKUP.md](docs/BACKUP.md)
- Server config, settings, quotas: [SERVER-SETTINGS.md](docs/SERVER-SETTINGS.md), [QUOTA.md](docs/QUOTA.md); demo instance: [DEMO_MODE.md](docs/DEMO_MODE.md)
- Cross-home relay and sharding: [SCALABILITY.md](docs/SCALABILITY.md)
- Layout, lists, keyboard, z-index, hover icons: [LAYOUT.md](docs/LAYOUT.md); mobile: [MOBILE.md](docs/MOBILE.md); typography: [TYPOGRAPHY.md](docs/TYPOGRAPHY.md); command palette: [the proposal](docs/proposals/PROPOSAL_COMMAND_PALETTE.md)
- Testing and browser verification: [TESTING.md](docs/TESTING.md), [VERIFICATION.md](docs/VERIFICATION.md)
- Help center: [HELP-CENTER.md](docs/HELP-CENTER.md), [SUPPORT-STYLE-GUIDE.md](docs/SUPPORT-STYLE-GUIDE.md)
- Backlog: [ROADMAP.md](docs/ROADMAP.md)

## Pitfalls

Full list: [ARCHITECTURE.md § Pitfalls](docs/ARCHITECTURE.md#pitfalls). The ones you hit on day one (three gated by `scripts/check-standards.ts`):

- **Drive has four layers** — Route → SharedDrive (ACL wrapper) → Drive → Mount; a feature changes all four, and every route-callable `Drive` method gets a `SharedDrive` wrapper with the right permission check ([ARCHITECTURE.md § Drive Architecture](docs/ARCHITECTURE.md#drive-architecture))
- **MIME type strings must match the Eigen File Types table exactly** — use the constants, don't type them by hand (gated)
- **Every authenticated route carries `:ownerId` as its second path segment** (gated) — the Home that owns the resource, access-checked in the route; home-independent surfaces are exempt (`OWNER_ID_EXEMPT` in `scripts/check-standards.ts`)
- **Never call `getHome()` for another user's data** — cross-home interactions go through `home-relay.ts` (`sendToHome()` for push, `pull*()` for reads); `getHome()` is fine for the request's own home. See [SCALABILITY.md](docs/SCALABILITY.md)
- **Hover-revealed affordances need the matching `pointer-coarse:` variant** so they rest visible on touch (gated): [LAYOUT.md § Hover-Only Icons](docs/LAYOUT.md#hover-only-icons)
- **Every page uses `ColumnLayout` + `Column` with the `toolbar` prop** — don't put the toolbar inside the page content ([LAYOUT.md § Page Layout Pattern](docs/LAYOUT.md#page-layout-pattern))

### Key UI Components

Before building custom UI, check these exist in `packages/ui/src/components/`:

| Component | File | Use for |
|---|---|---|
| `TooltipButton` | `layout/toolbar/tooltip-button.tsx` | Icon button with tooltip |
| `DeleteDialog` | `delete/delete-dialog.tsx` | Destructive action confirmation |
| `ConfirmDialog` | `confirm-dialog.tsx` | Generic confirmation dialog |
| `EmptyState` | `layout/app/empty-state.tsx` | "Nothing here" message with icon |
| `LoadingState` | `layout/app/loading-state.tsx` | Centered spinner |
| `ErrorState` | `layout/app/error-state.tsx` | Error message display |
| `SearchBar` | `search-bar/search-bar.tsx` | Search input with icon |
| `FileMenu` | `layout/toolbar/file-menu.tsx` | File dropdown (rename, delete, etc.) |
| `RequestAccessView` | `layout/app/request-access-view.tsx` | "Request access" screen for shared resources (hides sidebar) |

Full component list: [SHARED-PRIMITIVES.md](docs/SHARED-PRIMITIVES.md) (generated, CI-gated)

### SSE Pattern

Backend: mutation → `home.broadcast(buildEvent())` → SSE stream
Frontend: `useSSE` → domain handler → `queryClient.invalidateQueries()`
Notifications: `home.notifications.persist({...})` → writes to DB + broadcasts `notification:created` SSE event → toast

### Eigen File Types

| Type | MIME | Extension | Storage |
|---|---|---|---|
| Document | `application/eigendoc` | `.eigendoc` | Dir with `data.db` (Yjs) + `comments.db` + `media/` |
| Stickies | `application/eigenstickies` | `.eigenstickies` | Dir with `data.db` (Yjs) + `comments.db` + `media/` |
| Chat | `application/eigenchat` | `.eigenchat` | Dir with `data.db` + `media/` |
| Slides | `application/eigenslides` | `.eigenslides` | Dir with `data.db` (Yjs) + `comments.db` + `media/` |
| Sheets | `application/eigensheets` | `.eigensheets` | Dir with `data.db` (Yjs) + `comments.db` + `media/` |
| Vector | `application/eigenvector` | `.eigenvector` | Dir with `data.db` (Yjs) + `comments.db` + `media/` |

### Owner ID Prefixes

User = raw UUID (`a1b2c3d4-...`), Team = `team_{teamId}`. Resolution: `parseOwnerId()` in `packages/lib/src/types/owner.ts`. External iMIP organizers follow the same convention with `external_{email}`: [CALENDAR.md § iMIP](docs/CALENDAR.md#imip-email-based-calendar-invitations).

## Testing

**Every workspace keeps its tests in `<workspace>/src/test/` — nothing named `*.test.ts` lives anywhere else.** A test covering one module mirrors that module's path; a feature test gets a feature folder. `bun scripts/check-test-layout.ts` enforces it as part of `bun run check`. Layout rationale, harness and helpers: [TESTING.md](docs/TESTING.md).

A single test file needs the preload and must run from `apps/api`: `cd apps/api && bun test --preload ./src/test/preload.ts ./src/test/<domain>/<file>.test.ts`.
