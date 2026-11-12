# Architecture

> **TLDR:** The map of Eigen: where each backend, frontend and tooling concept lives and which doc explains it, then the package boundaries and the pitfalls that bit more than one domain. [AGENTS.md](../AGENTS.md) states the rules in short; [§ Package boundaries](#package-boundaries) and [§ Pitfalls](#pitfalls) give their reasons.

Eigen is one API server (`apps/api`) and web apps (`apps/*`) sharing `packages/`: `lib` for the types, hooks and logic both sides use, `ui` for shared components, `sheet` for the spreadsheet. The API keeps each user's and team's data in a Home, one instance per owner loaded on demand ([STORAGE.md](STORAGE.md#a-home-is-loaded-on-demand-and-dropped-when-idle)). Apps reach it through Eden, typed from the Elysia routes, with TanStack Query hooks and SSE for live changes ([SSE.md](SSE.md)). Read the boundaries and pitfalls before your first change in an area new to you.

## Backend

Paths are under `apps/api/src/` unless they say otherwise.

| Concept | Location | What it is |
|---|---|---|
| **Home** | `lib/home/home.ts` | One instance per owner: `UserHome`, `TeamHome`, `OrgHome`, `GuestHome` ([STORAGE.md](STORAGE.md)) |
| **Domain classes** | `lib/[domain]/[domain].ts` | Each domain's business logic, called straight from the routes |
| **Routes** | `routes/[domain].ts` | Thin Elysia routers; `{auth: true}` guards a route |
| **Databases** | `lib/[domain]/schema.ts`, `db-config.ts`, `lib/core/managed-database.ts` | A Drizzle schema and versioned migrations per database, opened by `ManagedDatabase` ([DATABASE.md](DATABASE.md)) |
| **Blob store** | `lib/core/blob-store.ts` | Base of the CalDAV and CardDAV stores: the blob is the truth, every column a projection ([CALENDAR.md](CALENDAR.md), [CONTACTS.md](CONTACTS.md)) |
| **Instance lock** | `instance-lock.ts`, `lib/config/data-lock.ts` | One API process per data folder, `./eigen restore` included ([DATABASE.md](DATABASE.md#one-api-process-owns-a-data-folder)) |
| **Collab storage** | `lib/collab/` | `CollabDocument`, with Yjs updates and snapshots in the container's `data.db` ([COLLAB.md](COLLAB.md)) |
| **Storage backends** | `lib/storage/` | `LocalStorage` (`local`, `local-key`) and `S3Storage`; every read has a deadline ([STORAGE.md](STORAGE.md#every-storage-read-has-a-30-s-idle-deadline)) |
| **Errors** | `lib/core/errors.ts` | `throw new ApiError(status, message)` |
| **Public routes** | `routes/public.ts` | `/p/*`, the deliberate unauthenticated surface; never add auth to one |
| **XML reads** | `lib/core/xml.ts` | `parseXml`, the one XML reader: refuses a DOCTYPE, matches by namespace, never prefix ([WEBDAV.md](WEBDAV.md)) |
| **OOXML** | `lib/ooxml/` | What the docx, xlsx and pptx readers and writers share, apart so `export/` and `import/` never import each other (`lib/ooxml/README.md`, [EXPORT.md](EXPORT.md)) |
| **Window limiter** | `lib/core/window-limiter.ts` | An in-memory sliding window per key (protocol auth failures, demo entry, access-request and assignment mail) |
| **SSE emission** | `lib/[domain]/sse-events.ts` | `home.broadcast(buildEvent(...))` ([SSE.md](SSE.md)) |
| **Notifications** | `lib/notification-center/` | `home.notify({...})` stores and broadcasts a notification, shown as a toast ([NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md), [ACTIVITY-ROWS.md](ACTIVITY-ROWS.md)) |
| **Auth** | `lib/auth/auth.ts` | better-auth over `users3.db`, which has no migrations: a new column goes into `auth-schema.ts`, the `setup.ts` DDL and `ensureAuthSchemaColumns` together, or better-auth refuses to start ([DATABASE.md](DATABASE.md)) |
| **Protocol auth** | `lib/auth/protocol-auth.ts` | `verifyProtocolAuth()`, the one IMAP, CalDAV, CardDAV and WebDAV login: an app password, else the primary one |
| **Trusted networks** | `lib/auth/access.ts`, `trusted-networks.ts` | `requireLocalhost()` admits loopback or `TRUSTED_NETWORKS`, never a caller Caddy proxied ([MAIL.md](MAIL.md#mail-only-arrives-from-the-local-mta)) |
| **ACL and sharing** | `lib/drive/acl.ts`, `acl-propagation.ts` | Per-path ACLs, additive down the tree ([ACL.md](ACL.md)) |
| **Guests** | `lib/auth/guest-auth.ts`, `lib/home/guest-home.ts` | Emailed-code sign-in into a Home with only drive and notifications ([GUEST-ACCESS.md](GUEST-ACCESS.md)) |
| **Organization and teams** | `lib/org/`, `lib/team/` | One organization per server; teams are flat ACL groups that own a `TeamHome` ([ORGANISATIONS-AND-TEAMS.md](ORGANISATIONS-AND-TEAMS.md)) |
| **WebDAV** | `lib/webdav/` | RFC 4918 over Drive mounts ([WEBDAV.md](WEBDAV.md)) |
| **CardDAV** | `lib/carddav/`, `lib/vcard/` | RFC 6352; a card's vCard bytes are the truth ([CARDDAV.md](CARDDAV.md), [CONTACTS.md](CONTACTS.md)) |
| **CalDAV** | `lib/caldav/`, `lib/ical/` | RFC 4791; a resource's iCalendar bytes are the truth ([CALDAV.md](CALDAV.md), [CALENDAR.md](CALENDAR.md)) |
| **Shared DAV core** | `lib/dav/` | What both DAV routers share: XML envelope, PROPFIND, REPORT, sync tokens, status mapping ([CALDAV.md](CALDAV.md)) |
| **Calendar invitations** | `lib/calendar/invite-propagation.ts`, `invitations.ts`, `imip.ts` | An attendee's linked copy of an organizer's event, kept in step by relayed and mailed updates ([CALENDAR.md](CALENDAR.md#a-linked-copy-is-an-ordinary-resource-with-the-organizers-stamp)) |
| **Server config** | `lib/config/server-config.ts` | Identity and secrets, written at first boot and setup ([SERVER-SETTINGS.md](SERVER-SETTINGS.md#configjson-is-identity-settingsjson-is-runtime)) |
| **Server settings** | `lib/config/server-settings.ts` | The owner's runtime settings: quotas, storage defaults, onboarding, guests, system sender ([SERVER-SETTINGS.md](SERVER-SETTINGS.md)) |
| **Setup token** | `lib/setup/setup-token.ts` | The setup link's one-time token, stored hashed; setup routes refuse without it |
| **Control socket** | `routes/control.ts` | The CLI's online commands over a 0600 Unix socket, never the web ([SELF-HOSTING.md](SELF-HOSTING.md)) |
| **Operator CLI** | `eigen`, `cli/` | `./eigen`, a POSIX `sh` launcher on the host, does every Docker step, since no container gets the Docker socket; the Bun CLI in the API image does the rest ([SELF-HOSTING.md](SELF-HOSTING.md)) |
| **Docker images** | `docker/`, `docker-compose.yml`, `.github/workflows/publish.yml` | Five amd64 and arm64 images, pinned by digest in `.env.production` ([TESTING.md](TESTING.md#a-release-publishes-only-the-images-its-gates-tested)) |
| **Release pins** | `lib/config/release.ts` | `PIN_KEYS`, the `.env.production` keys that pin a release, for the CLI and the server backup |
| **Backup** | `lib/backup/`, `routes/backup.ts`, `routes/server-backup.ts`, `apps/admin/src/components/admin/server-backup-section.tsx`, `packages/lib/src/core/admin/hooks/use-server-backup.ts` | A home's backup and restore, and the owner's scheduled whole-server backup; both panes list archives with `BackupArtifactRow` ([BACKUP.md](BACKUP.md)) |
| **Offline restore** | `cli/restore*.ts`, `lib/backup/restore-server.ts` | `./eigen restore` stages beside the running API (so no module opens a file on load), then swaps under a marker ([BACKUP.md](BACKUP.md#eigen-restore-stages-while-eigen-runs-then-swaps-under-a-marker)) |
| **Quota** | `lib/config/quota.ts`, `enforcement.ts` | A user's limits with team overrides, and their enforcement ([QUOTA.md](QUOTA.md)) |
| **Mailer** | `lib/mailer/` | `sendMail()` with one From rule; imports only config and `core`, so any domain can send ([SERVER-SETTINGS.md](SERVER-SETTINGS.md#one-rule-decides-who-a-mail-is-from)) |
| **Environment** | `lib/config/env.ts` | `isProduction()`, `isDemo()` ([DEMO_MODE.md](DEMO_MODE.md)), `isMailEnabled()` ([SERVER-SETTINGS.md](SERVER-SETTINGS.md#hosted-mail-and-the-relay-are-environment-not-settings)) |
| **Async singleton** | `utils/singleton.ts` | `createAsyncSingleton()`: one async build shared by every caller while it runs |
| **Home relay** | `lib/home/home-relay.ts` | Every call from one Home into another, and `pullFromEach` for a read across many ([SCALABILITY.md](SCALABILITY.md)) |
| **Data epoch** | `lib/home/data-epoch.ts` | Changes on a restore or update, so a stale tab reloads ([SSE.md](SSE.md#a-restore-reloads-every-tab-of-the-home)) |
| **Scheduler** | `lib/scheduler/` | In-process periodic jobs, registered in `jobs.ts` |
| **Document transforms** | `lib/document/transform/` | Every CPU-heavy transform in a bounded child process ([DOCUMENT-TRANSFORMS.md](DOCUMENT-TRANSFORMS.md)) |
| **Previews** | `lib/preview/` | Version-keyed preview cache and thumbnails ([PREVIEWS.md](PREVIEWS.md)) |
| **Upload pipeline** | `lib/mount/upload-queue.ts` | Write-behind uploads of an `s3` mount's databases, one queue per mount ([SYNC.md](SYNC.md)) |
| **Versioning** | `lib/versioning/` | Opt-in snapshots inside the container ([STORAGE.md](STORAGE.md#version-snapshots-live-inside-the-container)) |
| **Copy and move** | `lib/mount/copy.ts`, `lib/drive/drive.ts` | A move stays in its mount; a copy goes anywhere ([STORAGE.md](STORAGE.md#copy-goes-anywhere-a-move-stays-in-its-mount)) |
| **Import from Drive** | `lib/drive/import-source.ts` | `readImportSourceBytes`, the one import-from-drive reader, with the user's access and a byte cap |
| **Recent files** | `lib/drive/recent.ts`, `lib/drive/aggregate.ts`, `apps/drive/src/routes/_auth.recent.tsx` | Which paths a user opened or was notified about, in their own `shared.db`, checked against each owner on every load ([STORAGE.md](STORAGE.md#recent-files-stores-only-which-path-and-when)) |
| **File history** | `lib/drive/history.ts` | Typed file events and watcher notifications ([FILE-HISTORY.md](FILE-HISTORY.md)) |
| **Trash** | `lib/mount/trash.ts`, `lib/drive/trash.ts` | A delete moves to trash and revokes shares ([SOFT-DELETE.md](SOFT-DELETE.md)) |
| **Comments** | `lib/chat/` | A card in the Y.Doc and a chat thread in its container ([COMMENTS.md](COMMENTS.md)) |
| **Mail store** | `lib/mail/` | A per-user Maildir++ Dovecot serves too; the files are the truth ([MAIL.md](MAIL.md), [IMAP.md](IMAP.md)) |
| **Export and import** | `lib/export/`, `lib/import/` | One HTML document per format (PDF via WeasyPrint), except xlsx, docx and pptx, which have their own readers and writers ([EXPORT.md](EXPORT.md)) |

### Drive Architecture

A Drive feature usually touches all four layers:

```
Route (thin handler)  →  SharedDrive (ACL wrapper)  →  Drive (business logic)  →  Mount (storage + DB)
```

- **Mount** (`lib/mount/mount.ts`): storage and `metadata.db` of one mount over one of three backends; trash, copy, search, sizes, temp files and versioning are sibling modules ([STORAGE.md](STORAGE.md#a-mount-is-a-paths-table-over-one-of-three-backends)).
- **Drive** (`lib/drive/drive.ts`): the API over a Home's mounts, with ACL propagation, the collab document lifecycle, SSE and sharing.
- **SharedDrive** (`lib/drive/shared-drive.ts`): the ACL-checking wrapper, by composition. `getSharedDrive()` returns the raw `Drive` for the caller's own drive and a `SharedDrive` for another owner's, so a `Drive` method without a wrapper is a type error at the route.
- **Routes** (`routes/drive.ts` for the tree, with `drive-listings.ts`, `drive-sharing.ts` and `drive-content.ts` beside it): thin handlers through `getSharedDrive`.

A few owner-only routes, such as `/shared/by-me`, call `requireSelf` and then `getDrive(user)`; other unwrapped Drive methods serve server code (collab, chat, the relay). A new route that needs one gets a `SharedDrive` wrapper, not this escape hatch.

### Eigen file types

Every Eigen document is a Drive folder with its own `data.db` and `media/`. The MIME strings are the `DRIVE_MIME_*` constants in `packages/lib/src/types/drive.ts`; never type one (gated). MIME values and extensions are frozen.

| Type | MIME | Extension | Storage |
|---|---|---|---|
| Document | `application/eigendoc` | `.eigendoc` | `data.db` (Yjs) + `comments.db` + `media/` |
| Stickies | `application/eigenstickies` | `.eigenstickies` | `data.db` (Yjs) + `comments.db` + `media/` |
| Chat | `application/eigenchat` | `.eigenchat` | `data.db` + `media/` |
| Slides | `application/eigenslides` | `.eigenslides` | `data.db` (Yjs) + `comments.db` + `media/` |
| Sheets | `application/eigensheets` | `.eigensheets` | `data.db` (Yjs) + `comments.db` + `media/` |
| Vector | `application/eigenvector` | `.eigenvector` | `data.db` (Yjs) + `comments.db` + `media/` |

## Frontend

| Concept | Location | What it is |
|---|---|---|
| **API client** | `packages/lib/src/core/api.ts` | Eden Treaty, typed from the Elysia routes |
| **Data hooks** | `packages/lib/src/core/[domain]/hooks/` | TanStack Query with hierarchical query keys |
| **SSE handlers** | `packages/lib/src/core/[domain]/sse-handlers.ts` | Per-domain handlers that invalidate the query cache ([SSE.md](SSE.md)) |
| **Shared types** | `packages/lib/src/types/[domain].ts` | Types both sides use |
| **Validation** | `packages/lib/src/validation/` | Validation both sides share |
| **Colors** | `packages/lib/src/constants/colors.ts` | The palette and `readHexColor`, the one reader of a written color ([LAYOUT.md](LAYOUT.md#pink-is-eigens-accent-color)) |
| **Fonts** | `packages/lib/src/constants/fonts.ts`, `scripts/fonts/` | Bundled faces in `unicode-range` slices, and every font stack ([TYPOGRAPHY.md](TYPOGRAPHY.md)) |
| **App URLs** | `packages/lib/src/constants/app-urls.ts` | `APP_URLS`, each app's production URL |
| **Mail off** | `packages/lib/src/core/public/hooks/use-public.ts`, `packages/ui/src/components/mail/mail-off-state.tsx` | Without hosted mail, `useEnabledApps()` drops Mail and `MailOffState` is the one `/mail` screen ([SERVER-SETTINGS.md](SERVER-SETTINGS.md#mail-off-hides-the-mail-app-and-keeps-outbound-mail)) |
| **Admin pages** | `apps/admin/`, `packages/ui/src/components/layout/app/settings-section.tsx` | The owner's pages behind `_auth._owner.tsx`; `useIsOrgOwner` (`packages/lib/src/core/admin/hooks/use-is-admin.ts`) is the one org-owner read, `SettingsFooter` the one Save and Reset bar ([SERVER-SETTINGS.md](SERVER-SETTINGS.md)) |
| **Mail constants** | `packages/lib/src/constants/mail.ts` | Send caps, relay port and default sender, shared by mailer and admin |
| **Yjs utilities** | `packages/lib/src/core/collab/yjs-utils.ts` | `restoreYjsDoc` ([COLLAB.md](COLLAB.md)) and the stickies accessors ([STICKIES.md](STICKIES.md)) |
| **Menus** | `packages/ui/src/components/context-menu/menu-sections.tsx` | `MenuSections`, the one group order of every menu ([LAYOUT.md](LAYOUT.md#menus-draw-their-rows-in-one-order)) |
| **Leave guard** | `packages/ui/src/components/layout/app/leave-guard.tsx` | `LeaveGuard` asks before unsaved work is dropped |
| **Collab lifecycle** | `packages/lib/src/core/collab/hooks/use-collab-doc.ts` | `useCollabDoc` owns every collab editor's Y.Doc, provider and undo manager; gate loading on `loaded`, never `synced` ([COLLAB.md](COLLAB.md)) |
| **Replaced-home reload** | `packages/lib/src/core/home/` | A tab reloads when its data epoch changes ([SSE.md](SSE.md#a-restore-reloads-every-tab-of-the-home)) |
| **Canvas engine** | `packages/lib/src/vector/`, `packages/ui/src/components/vector/` | A React-free element model in lib, `CanvasEditor` in ui ([CANVAS.md](CANVAS.md)) |
| **Canvas editors** | `apps/vector/`, `apps/slides/` | The infinite canvas and a deck of frames on one engine ([CANVAS.md](CANVAS.md), [SLIDES.md](SLIDES.md)) |
| **Canvas image** | `packages/ui/src/components/vector/canvas-image.ts` | The SVG the editor downloads ([EXPORT.md](EXPORT.md#a-drawing-downloads-its-own-svg-and-prints-as-layers)) |
| **Canvas arrows** | `packages/lib/src/vector/binding.ts`, `elbow-route.ts` | A binding is stored on the arrow only ([CANVAS.md](CANVAS.md#a-binding-is-stored-on-the-arrow-only)) |
| **Charts** | `packages/lib/src/charts/`, `packages/ui/src/components/charts/` | One `ChartSpec`, drawn as plain SVG by every app ([CHARTS.md](CHARTS.md)) |
| **Docs editor** | `apps/docs/`, `packages/lib/src/docs/eigendoc/` | TipTap over Yjs; one eigendoc schema for the editor and every server renderer ([DOCS.md](DOCS.md)) |
| **Math** | `packages/math/` | One equation tree, read and written as OMML, MathML and LaTeX ([MATH.md](MATH.md)) |
| **Sheets engine** | `packages/sheet/src/engine/` | DOM-free formulas and number display, the half the server imports ([SHEETS.md](SHEETS.md#the-engine-is-the-half-the-server-imports)) |
| **Sheet cell glyphs** | `packages/sheet/src/state/modules/data-validation.ts`, `cell-glyph.ts` | Tick boxes, list chevrons and corner marks on the canvas ([SHEETS.md](SHEETS.md#a-tick-box-is-a-validation-rule-and-the-value-is-its-state)) |
| **Sheets export** | `apps/api/src/lib/export/sheets/` | Class-styled HTML and PDF, and the accepted xlsx round-trip drifts ([SHEETS.md](SHEETS.md#the-full-export-styles-cells-by-class)) |
| **Everyday UI** | `@workspace/ui` | Check before building UI: `TooltipButton`, `DeleteDialog`, `ConfirmDialog`, `FormDialog`, `EmptyState`, `LoadingState`, `ErrorState`, `SearchBar`, `FileMenu`, `RequestAccessView`; the rest: [SHARED-PRIMITIVES.md](SHARED-PRIMITIVES.md) |
| **App shell** | `packages/ui/src/components/layout/app/app-shell.tsx`, `eigen-app.tsx` | `EigenApp` (providers) around `AppShell` (topbar, sidebar, content) ([LAYOUT.md](LAYOUT.md#every-app-is-eigenapp-around-appshell)) |
| **Layout** | `packages/ui/src/components/layout/app/column-layout.tsx` | `ColumnLayout` and `Column`, one column on a phone ([LAYOUT.md](LAYOUT.md), [MOBILE.md](MOBILE.md)) |
| **Routing** | `apps/[name]/src/routes/` | TanStack Router, file-based; `_auth.tsx` guards |
| **Command palette** | `packages/lib/src/core/command-palette/` | The ⌘K dialog ([COMMAND-PALETTE.md](COMMAND-PALETTE.md)) |
| **In-document search** | `packages/lib/src/doc-search/`, `packages/ui/src/components/search/` | The ⌘F find bar of every eigendoc editor ([IN_DOCUMENT_SEARCH.md](IN_DOCUMENT_SEARCH.md)) |
| **Search** | `apps/api/src/lib/mount/search-index.ts`, `packages/lib/src/core/search/` | Full-text indexes of mail and drive ([SEARCH.md](SEARCH.md)) |
| **Contact suggestions** | `packages/lib/src/core/contacts/hooks/use-contact-suggestions.ts` | The one people-suggestion hook ([CONTACTS.md](CONTACTS.md)) |
| **New-chat wizard** | `packages/ui/src/components/chat/chat-create-wizard.tsx` | [CHAT.md](CHAT.md#the-new-chat-wizard-opens-an-existing-chat-before-it-creates-one) |
| **Mail app** | `apps/mail/`, `packages/lib/src/core/mail/` | Keyset-paginated lists, opt-in shortcuts ([MAIL.md](MAIL.md)) |
| **Eigen-doc icons** | `packages/lib/src/core/eigendoc-icons.ts` | `EIGEN_DOC_ICONS`, the icon per document type |
| **Drive copy and move** | `packages/lib/src/core/drive/hooks/writes.ts` | Move to, Copy to, Duplicate ([STORAGE.md](STORAGE.md#copy-goes-anywhere-a-move-stays-in-its-mount)) |
| **File subject** | `packages/lib/src/core/file-subject.ts` | One file a surface acts on, whatever holds it ([PREVIEWS.md](PREVIEWS.md#a-file-subject-stores-identity-everything-else-is-derived)) |
| **Drive actions** | `packages/lib/src/core/drive/drive-actions.ts`, `packages/ui/src/components/drive/drive-action-runner.tsx` | The one list of Drive item actions and their gates ([LAYOUT.md](LAYOUT.md#one-drivecapabilities-value-gates-every-drive-action)) |
| **File actions** | `packages/lib/src/core/file-actions.ts`, `packages/ui/src/components/file-actions/` | The one registry of file-subject actions, and its runner ([PREVIEWS.md](PREVIEWS.md)) |
| **Quick-look views** | `packages/ui/src/components/mail/message-view.tsx`, `calendar/event-detail-card.tsx` | A message and an event drawn from data alone, for their app and the quick look ([PREVIEWS.md](PREVIEWS.md)) |
| **Save to Drive** | `packages/ui/src/components/drive/save-to-drive-picker.tsx` | The one dialog for putting a file into Drive ([PREVIEWS.md](PREVIEWS.md)) |
| **Import to Calendar** | `packages/ui/src/components/calendar/import-to-calendar-picker.tsx` | The target calendar of an `.ics` import ([CALENDAR.md](CALENDAR.md#an-import-needs-a-target-calendar)) |

## Tooling

| Concept | Location | What it is |
|---|---|---|
| **Domain docs** | `.claude/skills/domain-doc/SKILL.md` | How a domain doc is written and checked |
| **Help center** | `.claude/skills/support-article/SKILL.md`, `apps/index/src/data/support/` | How an article is written ([HELP-CENTER.md](HELP-CENTER.md), [SUPPORT-STYLE-GUIDE.md](SUPPORT-STYLE-GUIDE.md)) |
| **App build** | `vite.shared.config.ts` | `createAppConfig()`, every app's Vite config; chunk groups name third-party packages only, since a workspace-package group drags its ui and lib imports into every page |
| **Release** | `scripts/release.ts` | `bun run release` bumps the version and drafts the GitHub Release ([TESTING.md](TESTING.md#a-github-release-says-what-changed-in-a-few-lines)) |
| **Release gate** | `docker/test-release.sh`, `.github/workflows/publish.yml` | Updates the previous release to the candidate images and back before they publish ([TESTING.md](TESTING.md#a-release-publishes-only-the-images-its-gates-tested)) |
| **Docker harnesses** | `docker/test-*.sh`, `docker/probe-lib.sh` | Install Eigen in a scratch folder and probe the install, update and release path, apart from `bun run test` ([TESTING-DOCKER.md](TESTING-DOCKER.md)) |

## Package boundaries

[AGENTS.md § Critical Rules](../AGENTS.md#critical-rules) states these in short; here are their reasons.

### Dependency direction

**Dependencies run one way: `sheet → lib` and `ui → lib`, never back.** `lib` serves the backend too, while `sheet` and `ui` need React and the DOM, so a lib import of either would load React into the backend. A biome rule enforces it. So the sheet types both sides need (`Cell`, `Sheet`, `Op`, `Range`, …) live in `packages/lib/src/sheets/`, re-exported by the sheet package.

`packages/math` is a leaf below all three: anything may import it, and it imports no package and no React, DOM, Bun or Node API, so the browser, the API, a Worker and Node run it unchanged. Its biome rule and tsconfig (`lib: ["ESNext"]`, no `types`) enforce it.

### Backend imports of lib

**The backend imports lib through React-free subpaths, never a `core/` domain barrel**, because every `@workspace/lib/<domain>` barrel re-exports React hooks. Safe by design: `types/*`, `constants`, `validation`, `sheets`, `vector`, `charts`, `background`, `docs/eigendoc` and the React-free leaves (`date`, `format`, `html`, `xml` and siblings). A React-free module inside a domain directory gets its own subpath in lib's exports map beside `collab/yjs-utils` and `mail/addresses`; lib has no wildcard exports into `core/`, so an uncarved deep import doesn't resolve.

Two names mislead: `download` is a leaf subpath but needs `document`, so it is frontend-only, and `@workspace/lib/docs` is the Docs domain's barrel of React hooks, while `docs/eigendoc` is the React-free schema. Every specifier: [CODE-STANDARDS.md § Imports](CODE-STANDARDS.md#imports).

### One source of truth per fact

**A set, map, schema or constant that answers a question** (which extensions are text-editable, which MIME is a spreadsheet, what a valid S3 config is) **lives in one module.** Import it and derive subsets; never re-list its members, since two lists drift apart.

### A primitive is shared only when its barrel exports it

**Reusable values go through the package's public entry** (`@workspace/ui`, `@workspace/lib/<domain>`), reusable types through `@workspace/lib/types/<domain>`. An unexported primitive is invisible to the next author, who rebuilds it, and a deep import past a barrel (`@workspace/lib/core/…`) usually means something should be exported. An export also needs a user outside its file ([CODE-STANDARDS.md § Standards Gates](CODE-STANDARDS.md#standards-gates)).

### Third copy → shared wrapper

**About to paste a scaffold into a third app? Extract one wrapper into `packages/ui` instead**, for route guards, `_auth.tsx` files, editor shells and loading, empty and error treatments as well as components. So `createEigenAppRouter` bootstraps every app but the marketing site, `createAuthRouteOptions` guards every app with a signed-in area, admin included, which adds the org-role check in its page, and `SidebarSection` is every sidebar's loading, error and empty treatment.

## Pitfalls

These caused bugs in more than one domain. `scripts/check-standards.ts` gates the MIME strings, `:ownerId` and hover without touch ([CODE-EXAMPLES.md § Standards Gates](CODE-EXAMPLES.md#standards-gates)).

- **Query keys include `ownerId`** for owner-scoped data ([CODE-STANDARDS.md § Key Patterns](CODE-STANDARDS.md#key-patterns)).
- **Every route-callable `Drive` method has a `SharedDrive` wrapper** with its permission check (`requireRead`, `requireWrite` or `requireDriveOwner`) ([§ Drive Architecture](#drive-architecture)).
- **MIME strings come from the constants** ([§ Eigen file types](#eigen-file-types), gated).
- **`validateSearch` in a shared route extracts every URL param the route uses**: a missing one, such as `uid`, silently breaks the shared item's detail pane.
- **Never mutate the TanStack Query cache in place**: use `setQueryData()` or `invalidateQueries()`.
- **The React Compiler caches what it derives by the identity of what it read**, so a value derived in render from something mutated in place, such as react-hook-form's `formState.dirtyFields` or the DOM, goes stale in the served app while a unit test, which runs uncompiled, passes. Use state set by an event, or `'use no memo'` on the hook as `useFollowedFields` does, whose test runs it through the compiler. The compiler skips a component that calls `form.watch()` by itself, but not a hook that component hands `form` to.
- **No `"use client"`**: this is Vite, not Next.js.
- **Every authenticated route has `:ownerId` as its second path segment** (gated): the Home that owns the resource, `user.id` or `team_{teamId}`, resolved by `parseOwnerId()` (`packages/lib/src/types/owner.ts`), and the route checks the caller may act on it. The fixed position would let a router pin a Home to one server ([SCALABILITY.md](SCALABILITY.md)). Server-wide endpoints that act on no Home (setup, server-wide settings, public surfaces, backup routes) have their own gate and are listed in `OWNER_ID_EXEMPT` in `scripts/check-standards.ts`.
- **Hover-revealed affordances use `HOVER_REVEAL_CLASS`**, never `invisible`, so the keyboard reaches them, and a hand-written one adds the `pointer-coarse:` variant so it rests visible on touch (gated; [LAYOUT.md § Hover-revealed affordances rest visible on touch](LAYOUT.md#hover-revealed-affordances-rest-visible-on-touch)).
- **Never call `getHome()` for another owner's data**: a call from one Home into another goes through `home-relay.ts` (`sendToHome()` to push, `pull*()` to read), so the relay is the one place sharding changes ([SCALABILITY.md](SCALABILITY.md)). `getHome()` is fine for the request's own Home.
- **A page is `ColumnLayout` and `Column` with the toolbar as the `toolbar` prop**, never inside the page content ([LAYOUT.md § Every page is a ColumnLayout of Columns with the toolbar as a prop](LAYOUT.md#every-page-is-a-columnlayout-of-columns-with-the-toolbar-as-a-prop)).
