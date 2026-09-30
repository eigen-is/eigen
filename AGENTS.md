# AGENTS.md: Eigen Project Context

Eigen is a self-hosted alternative to Google Workspace. Monorepo with integrated apps sharing a single API server, UI library, and business logic layer.

Layout, stack, and scripts are derivable: read `package.json` (scripts + workspaces) and `ls apps packages`. Two things that aren't written down anywhere else: the API serves every app from port 8000, and `packages/sheet` is a fork of fortune-sheet/luckysheet.

## Critical Rules

- **No AI co-author trailers in commits**: never add `Co-authored-by: Claude/Copilot/...` lines to commit messages, even if your tooling defaults to it
- **Read [CODE-STANDARDS.md](docs/CODE-STANDARDS.md) before writing code**: typing (don't break the Elysia → Eden → hook → component type chain: no `as any`, no `as Type`), style, imports and the **self-review checklist**, which must pass before you declare any task complete
- **Read existing code before writing new code**: read 2-3 existing files in the same directory. Match their style, structure, naming, and patterns exactly. New code must look like it was always there
- **Search [SHARED-PRIMITIVES.md](docs/SHARED-PRIMITIVES.md) before building a shared hook, component, type, or util**: the generated index of everything `packages/ui` + `packages/lib` export. Import what exists; if it's missing, export it from the package barrel so it gets catalogued (`bun run primitives` regenerates it)
- **Read the domain doc before planning or coding**: the index below names it (`docs/COMMENTS.md` before comment features). Don't assume you know the conventions. Verify them
- **Run `bun run check` after code changes**. What it runs: [TESTING.md § CI](docs/TESTING.md#ci). Docs, copy and string-only edits skip it. When multiple agents run in parallel, only the main agent runs check: concurrent runs cause deadlocks
- **Code goes in the right layer**: hooks/mutations in `packages/lib/src/core/[domain]/hooks/`, shared types in `packages/lib/src/types/`, shared UI in `packages/ui/`, app-specific code in `apps/`. Rule of thumb: if two or more apps need it, it belongs in `packages/`. Never put `useQuery`, `useMutation`, error toasts, or `try/catch` + `toast.error()` in app components: all error handling lives in hooks using `onMutationError`. See [NOTIFICATIONS.md](docs/NOTIFICATIONS.md)
- **Third copy → shared wrapper**, scaffolds too (route guards, editor shells, loading/empty/error treatments): before pasting one into a third app, extract one guarded wrapper into `packages/ui` ([why](docs/ARCHITECTURE.md#third-copy--shared-wrapper))
- **Package dependency direction is one-way: `sheet → lib` and `ui → lib`, never the reverse; `lib` imports neither** (a biome rule enforces it). Why, and where shared sheet types live: [ARCHITECTURE.md § Dependency direction](docs/ARCHITECTURE.md#dependency-direction)
- **The backend imports lib through React-free subpaths, never `core/` domain barrels**. The BE-safe list and how to carve out a new subpath: [ARCHITECTURE.md § Backend imports of lib](docs/ARCHITECTURE.md#backend-imports-of-lib)
- **Think about every `await`**: a bare async call returns a truthy Promise (`if (!asyncFn())` is always false). Fire-and-forget must have `.catch()`. Skip `await` when blocking would hurt response time and failure is acceptable
- **Sanitize user-provided paths**: validate against `..`, `/`, and control characters before filesystem or header use. Never interpolate raw user input into HTTP headers
- **One source of truth per fact**: a set, map, schema, or constant that answers a question lives in exactly one module. Import it; never re-list its members inline; derive subsets from the canonical one ([why](docs/ARCHITECTURE.md#one-source-of-truth-per-fact))
- **A primitive isn't "shared" until its barrel exports it**: values through `@workspace/ui` / `@workspace/lib/<domain>`, types through `@workspace/lib/types/<domain>`; a deep import past a barrel means it should have been exported ([why](docs/ARCHITECTURE.md#a-primitive-is-shared-only-when-its-barrel-exports-it))
- **Fix broken windows**: fix pre-existing issues if the fix is straightforward. Over-engineered code is a broken window too: removing lines is always welcome when the result is cleaner and easier to understand
- **Keep docs up to date**: gotchas land in `docs/<DOMAIN>.md`, written and trimmed via the [domain-doc skill](.claude/skills/domain-doc/SKILL.md); this file only if cross-domain; a new backend or frontend concept gets its row in the [ARCHITECTURE.md](docs/ARCHITECTURE.md) tables. A user-visible change corrects the help center (`apps/index/src/data/support/`) in the same cycle, minimally, via the [support-article skill](.claude/skills/support-article/SKILL.md) and [SUPPORT-STYLE-GUIDE.md](docs/SUPPORT-STYLE-GUIDE.md)
- **No hard line-wrapping in Markdown prose**: when writing `.md` content (docs, blog posts, proposals), keep each paragraph on one line; never insert manual line breaks to satisfy a maximum line length. Editors soft-wrap, and rendered HTML is unaffected either way

## Working Method (multi-step changes)

Orchestrating multi-step work or dispatching subagents: the [orchestrate skill](.claude/skills/orchestrate/SKILL.md). Every reviewer is held to [REVIEW-STANDARD.md](docs/REVIEW-STANDARD.md).

## Where Things Are Documented

File locations and patterns per concept (backend + frontend tables, package boundaries, pitfalls): [ARCHITECTURE.md](docs/ARCHITECTURE.md). Per domain:

- Drive, storage, mounts, trash, versioning, copy/move: [STORAGE.md](docs/STORAGE.md); soft delete: [SOFT-DELETE.md](docs/SOFT-DELETE.md); file history and watch: [FILE-HISTORY.md](docs/FILE-HISTORY.md)
- Databases: [DATABASE.md](docs/DATABASE.md)
- Sharing and permissions: [ACL.md](docs/ACL.md); guests: [GUEST-ACCESS.md](docs/GUEST-ACCESS.md); organizations and teams: [ORGANISATIONS-AND-TEAMS.md](docs/ORGANISATIONS-AND-TEAMS.md)
- Collab documents (Yjs, offline, restore): [COLLAB.md](docs/COLLAB.md)
- Canvas engine (vector + slides): [CANVAS.md](docs/CANVAS.md), [SLIDES.md](docs/SLIDES.md); clipboard: [CLIPBOARD.md](docs/CLIPBOARD.md)
- Sheets: [SHEETS.md](docs/SHEETS.md); stickies: [STICKIES.md](docs/STICKIES.md); documents: [DOCUMENT-CONTENT-LAYER.md](docs/DOCUMENT-CONTENT-LAYER.md), [INLINE-EDITING.md](docs/INLINE-EDITING.md), [MEDIA-REFERENCES.md](docs/MEDIA-REFERENCES.md)
- Comments: [COMMENTS.md](docs/COMMENTS.md)
- Mail: [MAIL.md](docs/MAIL.md), [IMAP.md](docs/IMAP.md)
- Chat: [CHAT.md](docs/CHAT.md)
- Calendar, iCalendar, invitations and iMIP: [CALENDAR.md](docs/CALENDAR.md); CalDAV: [CALDAV.md](docs/CALDAV.md)
- Contacts: [CONTACTS.md](docs/CONTACTS.md); CardDAV: [CARDDAV.md](docs/CARDDAV.md)
- WebDAV: [WEBDAV.md](docs/WEBDAV.md)
- Search: [SEARCH.md](docs/SEARCH.md); in-document find bar: [IN_DOCUMENT_SEARCH.md](docs/IN_DOCUMENT_SEARCH.md)
- SSE: [SSE.md](docs/SSE.md); toasts: [NOTIFICATIONS.md](docs/NOTIFICATIONS.md); notification center: [NOTIFICATION-CENTER.md](docs/NOTIFICATION-CENTER.md); activity rows: [ACTIVITY-ROWS.md](docs/ACTIVITY-ROWS.md)
- Previews, quick look and file actions, export, off-thread transforms: [PREVIEWS.md](docs/PREVIEWS.md), [EXPORT.md](docs/EXPORT.md), [DOCUMENT-TRANSFORMS.md](docs/DOCUMENT-TRANSFORMS.md)
- Uploads and S3 sync: [SYNC.md](docs/SYNC.md), [STREAMING_UPLOADS.md](docs/STREAMING_UPLOADS.md)
- Backup and restore: [BACKUP.md](docs/BACKUP.md)
- Self-hosting and `./eigen`: [SELF-HOSTING.md](docs/SELF-HOSTING.md); the operator's steps live in the help center's `self-hosting/` section
- Server config, settings, quotas: [SERVER-SETTINGS.md](docs/SERVER-SETTINGS.md), [QUOTA.md](docs/QUOTA.md); demo instance: [DEMO_MODE.md](docs/DEMO_MODE.md)
- Cross-home relay and sharding: [SCALABILITY.md](docs/SCALABILITY.md)
- Layout, lists, keyboard, z-index, hover icons: [LAYOUT.md](docs/LAYOUT.md); mobile: [MOBILE.md](docs/MOBILE.md); typography: [TYPOGRAPHY.md](docs/TYPOGRAPHY.md); command palette: [the proposal](docs/proposals/PROPOSAL_COMMAND_PALETTE.md)
- Testing and browser verification: [TESTING.md](docs/TESTING.md), the [verify-in-browser skill](.claude/skills/verify-in-browser/SKILL.md)
- Help center: [HELP-CENTER.md](docs/HELP-CENTER.md), [SUPPORT-STYLE-GUIDE.md](docs/SUPPORT-STYLE-GUIDE.md)
- Backlog: [ROADMAP.md](docs/ROADMAP.md)

## Pitfalls

Full list: [ARCHITECTURE.md § Pitfalls](docs/ARCHITECTURE.md#pitfalls). The ones you hit on day one (three gated by `scripts/check-standards.ts`):

- **Drive has four layers**: Route → SharedDrive (ACL wrapper) → Drive → Mount; a feature changes all four, and every route-callable `Drive` method gets a `SharedDrive` wrapper with the right permission check ([ARCHITECTURE.md § Drive Architecture](docs/ARCHITECTURE.md#drive-architecture))
- **Eigen MIME type strings come from the `DRIVE_MIME_*` constants** in `packages/lib/src/types/drive.ts`, never typed by hand (gated); the file types they name: [ARCHITECTURE.md § Eigen file types](docs/ARCHITECTURE.md#eigen-file-types)
- **Every authenticated route carries `:ownerId` as its second path segment** (gated): the Home that owns the resource, access-checked in the route; home-independent surfaces are exempt (`OWNER_ID_EXEMPT` in `scripts/check-standards.ts`)
- **Never call `getHome()` for another user's data**: cross-home interactions go through `home-relay.ts` (`sendToHome()` for push, `pull*()` for reads); `getHome()` is fine for the request's own home. See [SCALABILITY.md](docs/SCALABILITY.md)
- **Hover-revealed affordances need the matching `pointer-coarse:` variant** so they rest visible on touch (gated): [LAYOUT.md § Hover-revealed affordances rest visible on touch](docs/LAYOUT.md#hover-revealed-affordances-rest-visible-on-touch)
- **Every page uses `ColumnLayout` + `Column` with the `toolbar` prop**: don't put the toolbar inside the page content ([LAYOUT.md § Every page is a ColumnLayout of Columns with the toolbar as a prop](docs/LAYOUT.md#every-page-is-a-columnlayout-of-columns-with-the-toolbar-as-a-prop))

## Testing

**Every workspace keeps its tests in `<workspace>/src/test/`; nothing named `*.test.ts` lives anywhere else.** A test covering one module mirrors that module's path; a feature test gets a feature folder. `bun scripts/check-test-layout.ts` enforces it as part of `bun run check`. Layout rationale, harness and helpers: [TESTING.md](docs/TESTING.md).

A single test file needs the preload and must run from `apps/api`: `cd apps/api && bun test --preload ./src/test/preload.ts ./src/test/<domain>/<file>.test.ts`.
