# Architecture

> **TLDR:** The map of Eigen: where each backend, frontend and tooling concept lives and which doc explains it, then the package boundaries and the pitfalls that have bitten more than one domain. [AGENTS.md](../AGENTS.md) holds the rules an agent needs before its first edit; [§ Package boundaries](#package-boundaries) and [§ Pitfalls](#pitfalls) give the reasons behind them.

Eigen is one API server (`apps/api`) and a set of web apps (`apps/*`) that share the code in `packages/`: `lib` for the types, hooks and logic both sides use, `ui` for the shared components and `sheet` for the spreadsheet. The API keeps each user's and team's data in a Home, an instance per owner that is loaded on demand ([STORAGE.md](STORAGE.md#a-home-is-loaded-on-demand-and-dropped-when-idle)). The apps reach it through Eden, typed from the Elysia routes, with TanStack Query hooks for reads and writes and SSE for live changes ([SSE.md](SSE.md)). Use the tables to find where a concept lives. Read the boundaries and pitfalls before your first change in an area you have not worked in.

## Backend

Paths are under `apps/api/src/` unless they say otherwise.

| Concept | Location | What it is |
|---|---|---|
| **Home** | `lib/home/home.ts` | One instance per owner holding its databases and domain services: `UserHome`, `TeamHome`, `OrgHome`, `GuestHome`. See [STORAGE.md](STORAGE.md) |
| **Domain classes** | `lib/[domain]/[domain].ts` | The business logic of each domain (Drive, Mail, Contacts, Calendar, ChatRoom), called straight from the routes |
| **Routes** | `routes/[domain].ts` | Thin Elysia routers; `{auth: true}` guards a route |
| **Databases** | `lib/[domain]/schema.ts`, `db-config.ts`, `lib/core/managed-database.ts` | A Drizzle schema and versioned migrations per database, opened by `ManagedDatabase`. See [DATABASE.md](DATABASE.md) |
| **Blob store** | `lib/core/blob-store.ts` | What the CalDAV and CardDAV stores share: the stored blob is the truth and every other column a projection of it. See [CALENDAR.md](CALENDAR.md) and [CONTACTS.md](CONTACTS.md) |
| **Instance lock** | `instance-lock.ts`, `lib/config/data-lock.ts` | One API process per data folder; the swap of `./eigen restore` takes the same lock. See [DATABASE.md § One API process owns a data folder](DATABASE.md#one-api-process-owns-a-data-folder) |
| **Collab storage** | `lib/collab/` | One `CollabDocument` per open document, its Yjs updates and snapshots in the container's `data.db`. See [COLLAB.md](COLLAB.md) |
| **Storage backends** | `lib/storage/` | `LocalStorage` (the `local` and `local-key` modes) and `S3Storage`, every read the server consumes itself under a deadline. See [STORAGE.md](STORAGE.md#every-storage-read-has-a-30-s-idle-deadline) |
| **Errors** | `lib/core/errors.ts` | `throw new ApiError(status, message)` |
| **Public routes** | `routes/public.ts` | `/p/*` is the deliberate unauthenticated surface (avatars, the public config, invites, the waitlist, demo entry). The prefix is the contract: never add auth to one |
| **XML reads** | `lib/core/xml.ts` | `parseXml`, the one XML reader: it refuses a DOCTYPE and matches elements by namespace, never by prefix. See [WEBDAV.md](WEBDAV.md) |
| **OOXML** | `lib/ooxml/` | What the docx, xlsx and pptx readers and writers share: the zip reader and writer, packages, read budgets, DrawingML, charts and each format's vocabulary. It sits apart so `export/` and `import/` never import each other. See `lib/ooxml/README.md` and [EXPORT.md](EXPORT.md) |
| **Window limiter** | `lib/core/window-limiter.ts` | An in-memory sliding window per key, behind protocol auth failures, demo entry and the access-request mail |
| **SSE emission** | `lib/[domain]/sse-events.ts` | `home.broadcast(buildEvent(...))`. See [SSE.md](SSE.md) |
| **Notifications** | `lib/notification-center/` | `home.notify({...})` stores a user's notification and broadcasts it, which the frontend shows as a toast. See [NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md) and [ACTIVITY-ROWS.md](ACTIVITY-ROWS.md) |
| **Auth** | `lib/auth/auth.ts` | better-auth with org, team, 2FA and API key plugins over `users3.db`, which has no migrations: a new auth column goes into `auth-schema.ts`, the `setup.ts` DDL and `ensureAuthSchemaColumns` together, or better-auth refuses to start. See [DATABASE.md](DATABASE.md) |
| **Protocol auth** | `lib/auth/protocol-auth.ts` | `verifyProtocolAuth()`, the one login of IMAP, CalDAV, CardDAV and WebDAV: an app password, else the primary password |
| **Trusted networks** | `lib/auth/access.ts`, `trusted-networks.ts` | `requireLocalhost()` admits a direct caller from loopback or `TRUSTED_NETWORKS`, never one Caddy proxied. See [MAIL.md](MAIL.md#mail-only-arrives-from-the-local-mta) |
| **ACL and sharing** | `lib/drive/acl.ts`, `acl-propagation.ts` | Per-path ACLs, additive down the folder tree. See [ACL.md](ACL.md) |
| **Guests** | `lib/auth/guest-auth.ts`, `lib/home/guest-home.ts` | Sign-in by emailed code into a Home with only drive and notifications. See [GUEST-ACCESS.md](GUEST-ACCESS.md) |
| **Organization and teams** | `lib/org/`, `lib/team/` | One organization per server; teams are flat ACL groups that own a `TeamHome`. See [ORGANISATIONS-AND-TEAMS.md](ORGANISATIONS-AND-TEAMS.md) |
| **WebDAV** | `lib/webdav/` | The RFC 4918 server over Drive mounts. See [WEBDAV.md](WEBDAV.md) |
| **CardDAV** | `lib/carddav/`, `lib/vcard/` | RFC 6352 over the contacts store, where a card's vCard bytes are the truth. See [CARDDAV.md](CARDDAV.md) and [CONTACTS.md](CONTACTS.md) |
| **CalDAV** | `lib/caldav/`, `lib/ical/` | RFC 4791 over the calendar store, where a resource's iCalendar bytes are the truth. See [CALDAV.md](CALDAV.md) and [CALENDAR.md](CALENDAR.md) |
| **Shared DAV core** | `lib/dav/` | What the CalDAV and CardDAV routers answer alike: the XML envelope, PROPFIND, REPORT, sync tokens and status mapping. See [CALDAV.md](CALDAV.md) |
| **Calendar invitations** | `lib/calendar/invite-propagation.ts`, `invitations.ts`, `imip.ts` | An attendee's linked copy of an organizer's event, kept in step by relayed and mailed updates. See [CALENDAR.md](CALENDAR.md#a-linked-copy-is-an-ordinary-resource-with-the-organizers-stamp) |
| **Server config** | `lib/config/server-config.ts` | The server's identity and secrets, written at first boot and at setup. See [SERVER-SETTINGS.md](SERVER-SETTINGS.md#configjson-is-identity-settingsjson-is-runtime) |
| **Server settings** | `lib/config/server-settings.ts` | Runtime quotas, storage defaults, onboarding, guests and the system sender, the owner's to change. See [SERVER-SETTINGS.md](SERVER-SETTINGS.md) |
| **Setup token** | `lib/setup/setup-token.ts` | The one-time token in the setup link, stored only as a hash. The setup routes refuse without it |
| **Control socket** | `routes/control.ts` | The CLI's online commands reach the running API over a 0600 Unix socket, never the web. See [SELF-HOSTING.md](SELF-HOSTING.md) |
| **Operator CLI** | `eigen`, `cli/` | `./eigen`, a POSIX `sh` launcher on the host, does every Docker step, since no container gets the Docker socket; the Bun CLI in the API image does the rest. See [SELF-HOSTING.md](SELF-HOSTING.md) |
| **Docker images** | `docker/`, `docker-compose.yml`, `.github/workflows/publish.yml` | Five images, built for amd64 and arm64 and pinned by digest in `.env.production`. See [TESTING.md § A release publishes only the images its gates tested](TESTING.md#a-release-publishes-only-the-images-its-gates-tested) |
| **Release pins** | `lib/config/release.ts` | `PIN_KEYS`, the `.env.production` keys that pin a release, read by the CLI that pins them and the server backup that records them |
| **Backup** | `lib/backup/`, `routes/backup.ts`, `routes/server-backup.ts`, `apps/admin/src/components/admin/server-backup-section.tsx`, `packages/lib/src/core/admin/hooks/use-server-backup.ts` | A home's backup and restore, and the owner's whole-server backup with its schedule and bucket upload. The admin Server backup pane lists its archives with the `BackupArtifactRow` a home's Backup pane uses. See [BACKUP.md](BACKUP.md) |
| **Offline restore** | `cli/restore*.ts`, `lib/backup/restore-server.ts` | `./eigen restore` stages an archive beside the running API, so no module it loads opens a file on load, then swaps it in under a marker. See [BACKUP.md](BACKUP.md#eigen-restore-stages-while-eigen-runs-then-swaps-under-a-marker) |
| **Quota** | `lib/config/quota.ts`, `enforcement.ts` | Resolves a user's limits against team overrides and enforces them. See [QUOTA.md](QUOTA.md) |
| **Mailer** | `lib/mailer/` | `sendMail()`, to the bundled Postfix or the relay, From set by one sender rule. It imports only config and `core`, so any domain can send mail. See [SERVER-SETTINGS.md](SERVER-SETTINGS.md#one-rule-decides-who-a-mail-is-from) |
| **Environment** | `lib/config/env.ts` | `isProduction()`, `isDemo()` ([DEMO_MODE.md](DEMO_MODE.md)) and `isMailEnabled()` ([SERVER-SETTINGS.md](SERVER-SETTINGS.md#hosted-mail-and-the-relay-are-environment-not-settings)) |
| **Async singleton** | `utils/singleton.ts` | `createAsyncSingleton()`: one async build shared by every caller that asks while it runs |
| **Home relay** | `lib/home/home-relay.ts` | Every call from one Home into another. See [SCALABILITY.md](SCALABILITY.md) |
| **Data epoch** | `lib/home/data-epoch.ts` | Changes on a restore or an update, so a tab holding the old one reloads. See [SSE.md](SSE.md#a-restore-reloads-every-tab-of-the-home) |
| **Scheduler** | `lib/scheduler/` | In-process periodic jobs, registered in `jobs.ts` |
| **Document transforms** | `lib/document/transform/` | Every CPU-heavy transform (previews, exports, imports, search) in a bounded child process, never on the main thread. See [DOCUMENT-TRANSFORMS.md](DOCUMENT-TRANSFORMS.md) |
| **Previews** | `lib/preview/` | The version-keyed preview cache and thumbnails. See [PREVIEWS.md](PREVIEWS.md) |
| **Upload pipeline** | `lib/mount/upload-queue.ts` | Write-behind uploads of an `s3` mount's databases, drained by a queue per mount. See [SYNC.md](SYNC.md) |
| **Versioning** | `lib/versioning/` | Opt-in file snapshots inside the container. See [STORAGE.md](STORAGE.md#version-snapshots-live-inside-the-container) |
| **Copy and move** | `lib/mount/copy.ts`, `lib/drive/copy-across.ts` | A move stays in its mount; a copy goes anywhere. See [STORAGE.md](STORAGE.md#copy-goes-anywhere-a-move-stays-in-its-mount) |
| **Import from Drive** | `lib/drive/import-source.ts` | `readImportSourceBytes`, the one reader behind every import-from-drive route, with the user's own access and under a byte cap |
| **File history** | `lib/drive/history.ts` | Typed file events and watcher notifications. See [FILE-HISTORY.md](FILE-HISTORY.md) |
| **Trash** | `lib/mount/trash.ts`, `lib/drive/trash.ts` | A delete moves an item to trash and revokes its shares. See [SOFT-DELETE.md](SOFT-DELETE.md) |
| **Comments** | `lib/chat/` | A comment is a card in the Y.Doc and a chat thread in its container. See [COMMENTS.md](COMMENTS.md) |
| **Mail store** | `lib/mail/` | A per-user Maildir++ that Dovecot serves too; the files are the truth. See [MAIL.md](MAIL.md) and [IMAP.md](IMAP.md) |
| **Export and import** | `lib/export/`, `lib/import/` | Every format but xlsx, docx and pptx is one HTML document, PDF through WeasyPrint; the three Office formats have readers and writers of their own. See [EXPORT.md](EXPORT.md) |

### Drive Architecture

The Drive system has four layers, and a new Drive feature usually touches all four:

```
Route (thin handler)  →  SharedDrive (ACL wrapper)  →  Drive (business logic)  →  Mount (storage + DB)
```

- **Mount** (`lib/mount/mount.ts`): storage and the `metadata.db` of one mount, over one of three backends. Trash, copy, search and versioning are sibling modules over it ([STORAGE.md](STORAGE.md#a-mount-is-a-paths-table-over-one-of-three-backends)).
- **Drive** (`lib/drive/drive.ts`): the API over a Home's mounts, with ACL propagation, the collab document lifecycle, SSE and sharing.
- **SharedDrive** (`lib/drive/shared-drive.ts`): the ACL-checking wrapper, by composition, not inheritance. `getSharedDrive()` returns the raw `Drive` for the caller's own drive and a `SharedDrive` for another owner's, so a route can call only methods both have, and a `Drive` method without a wrapper is a type error at the route.
- **Routes** (`routes/drive.ts`): thin handlers that go through `getSharedDrive`.

A few owner-only routes, such as `/shared/by-me`, call `requireSelf` and then `getDrive(user)` for the raw Drive. The other unwrapped Drive methods serve server code such as collab, chat or the relay. A new route that needs one gets a `SharedDrive` wrapper first, not this escape hatch.

### Eigen file types

Every Eigen document is a Drive folder with its own `data.db` and `media/`. The MIME strings are the `DRIVE_MIME_*` constants in `packages/lib/src/types/drive.ts`; never type one by hand (gated). The MIME values and extensions are frozen.

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
| **SSE handlers** | `packages/lib/src/core/[domain]/sse-handlers.ts` | Each event goes to its domain's handler, which invalidates the query cache. See [SSE.md](SSE.md) |
| **Shared types** | `packages/lib/src/types/[domain].ts` | Types both the frontend and the backend use |
| **Validation** | `packages/lib/src/validation/` | Validation both sides share |
| **Colors** | `packages/lib/src/constants/colors.ts` | The palette and the one reader of a written color (`readHexColor`). See [LAYOUT.md](LAYOUT.md#pink-is-eigens-accent-color) |
| **Fonts** | `packages/lib/src/constants/fonts.ts`, `scripts/fonts/` | The bundled faces, cut into `unicode-range` slices, and every CSS font stack. See [TYPOGRAPHY.md](TYPOGRAPHY.md) |
| **App URLs** | `packages/lib/src/constants/app-urls.ts` | `APP_URLS`, each app's URL in the production build |
| **Mail off** | `packages/lib/src/core/public/hooks/use-public.ts`, `packages/ui/src/components/mail/mail-off-state.tsx` | `useEnabledApps()` leaves Mail out without hosted mail, and `MailOffState` is the one screen for a `/mail` URL then. See [SERVER-SETTINGS.md](SERVER-SETTINGS.md#mail-off-hides-the-mail-app-and-keeps-outbound-mail) |
| **Admin pages** | `apps/admin/`, `packages/ui/src/components/layout/app/settings-section.tsx` | The owner's Settings, Onboarding, Guest access and Waitlist, behind the guard in `_auth._owner.tsx`, with `useIsOrgOwner` (`packages/lib/src/core/admin/hooks/use-is-admin.ts`) the one read of the org owner role for that guard and the sidebar, and with one Save and Reset bar (`SettingsFooter`). See [SERVER-SETTINGS.md](SERVER-SETTINGS.md) |
| **Mail constants** | `packages/lib/src/constants/mail.ts` | Send caps, the relay port and the default sender address the mailer and the admin pages share |
| **Yjs utilities** | `packages/lib/src/core/collab/yjs-utils.ts` | `restoreYjsDoc` for a version restore ([COLLAB.md](COLLAB.md)) and the stickies accessors ([STICKIES.md](STICKIES.md)) |
| **Menus** | `packages/ui/src/components/context-menu/menu-sections.tsx` | `MenuSections`, the one group order of every context and ⋮ menu. See [LAYOUT.md](LAYOUT.md#menus-draw-their-rows-in-one-order) |
| **Leave guard** | `packages/ui/src/components/layout/app/leave-guard.tsx` | `LeaveGuard` asks before a reload, a closed tab or a navigation drops unsaved work |
| **Collab lifecycle** | `packages/lib/src/core/collab/hooks/use-collab-doc.ts` | `useCollabDoc` owns the Y.Doc, provider and undo manager of every collab editor. Gate the loading screen on `loaded`, never `synced`. See [COLLAB.md](COLLAB.md) |
| **Replaced-home reload** | `packages/lib/src/core/home/` | A tab reloads when a data epoch it holds changes. See [SSE.md](SSE.md#a-restore-reloads-every-tab-of-the-home) |
| **Canvas engine** | `packages/lib/src/vector/`, `packages/ui/src/components/vector/` | One engine for free-canvas documents: a React-free element model in lib, `CanvasEditor` in ui. See [CANVAS.md](CANVAS.md) |
| **Canvas editors** | `apps/vector/`, `apps/slides/` | One engine, two apps: the infinite canvas and a deck of frames. See [CANVAS.md](CANVAS.md) and [SLIDES.md](SLIDES.md) |
| **Canvas image** | `packages/ui/src/components/vector/canvas-image.ts` | The SVG the open editor downloads. See [EXPORT.md](EXPORT.md#a-drawing-downloads-its-own-svg-and-prints-as-layers) |
| **Canvas arrows** | `packages/lib/src/vector/binding.ts`, `elbow-route.ts` | A binding is stored on the arrow only. See [CANVAS.md](CANVAS.md#a-binding-is-stored-on-the-arrow-only) |
| **Charts** | `packages/lib/src/charts/`, `packages/ui/src/components/charts/` | One `ChartSpec`, drawn as plain SVG by every app that holds a chart. See [CHARTS.md](CHARTS.md) |
| **Docs editor** | `apps/docs/`, `packages/lib/src/docs/eigendoc/` | TipTap over Yjs, on one eigendoc schema that the editor and every server renderer share. See [DOCS.md](DOCS.md) |
| **Math** | `packages/math/` | One equation tree with readers and writers for OMML, MathML and LaTeX. See [MATH.md](MATH.md) |
| **Sheets engine** | `packages/sheet/src/engine/` | DOM-free formula evaluation and number display, the half of the sheet the server imports. See [SHEETS.md](SHEETS.md#the-engine-is-the-half-the-server-imports) |
| **Sheet cell glyphs** | `packages/sheet/src/state/modules/data-validation.ts`, `cell-glyph.ts` | Tick boxes, list chevrons and corner marks painted on the canvas. See [SHEETS.md](SHEETS.md#a-tick-box-is-a-validation-rule-and-the-value-is-its-state) |
| **Sheets export** | `apps/api/src/lib/export/sheets/` | Class-styled HTML and PDF, and the accepted xlsx round-trip drifts. See [SHEETS.md](SHEETS.md#the-full-export-styles-cells-by-class) |
| **Everyday UI** | `@workspace/ui` | Check these before building UI: `TooltipButton`, `DeleteDialog`, `ConfirmDialog`, `FormDialog`, `EmptyState`, `LoadingState`, `ErrorState`, `SearchBar`, `FileMenu`, `RequestAccessView`. Everything else: [SHARED-PRIMITIVES.md](SHARED-PRIMITIVES.md) |
| **App shell** | `packages/ui/src/components/layout/app/app-shell.tsx`, `eigen-app.tsx` | `EigenApp` (the providers) around `AppShell` (topbar, sidebar, content) in every app. See [LAYOUT.md](LAYOUT.md#every-app-is-eigenapp-around-appshell) |
| **Layout** | `packages/ui/src/components/layout/app/column-layout.tsx` | `ColumnLayout` and `Column`, which switch to one column on a phone. See [LAYOUT.md](LAYOUT.md) and [MOBILE.md](MOBILE.md) |
| **Routing** | `apps/[name]/src/routes/` | TanStack Router, file-based; `_auth.tsx` guards |
| **Command palette** | `packages/lib/src/core/command-palette/` | The ⌘K dialog. See [COMMAND-PALETTE.md](COMMAND-PALETTE.md) |
| **In-document search** | `packages/lib/src/doc-search/`, `packages/ui/src/components/search/` | The ⌘F find bar of every eigendoc editor. See [IN_DOCUMENT_SEARCH.md](IN_DOCUMENT_SEARCH.md) |
| **Search** | `apps/api/src/lib/mount/search-index.ts`, `packages/lib/src/core/search/` | Full-text indexes of mail and drive. See [SEARCH.md](SEARCH.md) |
| **Contact suggestions** | `packages/lib/src/core/contacts/hooks/use-contact-suggestions.ts` | The one hook that suggests people, from contacts and team members. See [CONTACTS.md](CONTACTS.md) |
| **New-chat wizard** | `packages/ui/src/components/chat/chat-create-wizard.tsx` | See [CHAT.md](CHAT.md#the-new-chat-wizard-opens-an-existing-chat-before-it-creates-one) |
| **Mail app** | `apps/mail/`, `packages/lib/src/core/mail/` | Keyset-paginated lists and opt-in keyboard shortcuts. See [MAIL.md](MAIL.md) |
| **Eigen-doc icons** | `packages/lib/src/core/eigendoc-icons.ts` | `EIGEN_DOC_ICONS`, the icon per document type |
| **Drive copy and move** | `packages/lib/src/core/drive/hooks/writes.ts` | Move to, Copy to and Duplicate. See [STORAGE.md](STORAGE.md#copy-goes-anywhere-a-move-stays-in-its-mount) |
| **File subject** | `packages/lib/src/core/file-subject.ts` | One file a surface can act on, whatever holds it (a Drive item, a mail part). See [PREVIEWS.md](PREVIEWS.md#a-file-subject-stores-identity-everything-else-is-derived) |
| **Drive actions** | `packages/lib/src/core/drive/drive-actions.ts`, `packages/ui/src/components/drive/drive-action-runner.tsx` | The one list of Drive item actions and their gates. See [LAYOUT.md](LAYOUT.md#one-drivecapabilities-value-gates-every-drive-action) |
| **File actions** | `packages/lib/src/core/file-actions.ts`, `packages/ui/src/components/file-actions/` | The one registry of what may be done with a file subject, and its runner. See [PREVIEWS.md](PREVIEWS.md) |
| **Quick-look views** | `packages/ui/src/components/mail/message-view.tsx`, `calendar/event-detail-card.tsx` | A message and an event drawn from data alone, by their app and by the quick look. See [PREVIEWS.md](PREVIEWS.md) |
| **Save to Drive** | `packages/ui/src/components/drive/save-to-drive-picker.tsx` | The one "where does this go" dialog for putting a file into Drive. See [PREVIEWS.md](PREVIEWS.md) |
| **Import to Calendar** | `packages/ui/src/components/calendar/import-to-calendar-picker.tsx` | Picks the calendar an `.ics` import goes into. See [CALENDAR.md](CALENDAR.md#an-import-needs-a-target-calendar) |

## Tooling

| Concept | Location | What it is |
|---|---|---|
| **Domain docs** | `.claude/skills/domain-doc/SKILL.md` | How a `docs/` domain doc is written and checked |
| **Help center** | `.claude/skills/support-article/SKILL.md`, `apps/index/src/data/support/` | How an article is written. See [HELP-CENTER.md](HELP-CENTER.md) and [SUPPORT-STYLE-GUIDE.md](SUPPORT-STYLE-GUIDE.md) |
| **App build** | `vite.shared.config.ts` | `createAppConfig()`, every app's Vite config. Its chunk groups name third-party packages only, because a group for a workspace package drags the ui and lib modules it imports into every page |
| **Release** | `scripts/release.ts` | `bun run release` bumps the version and drafts the GitHub Release. See [TESTING.md](TESTING.md#a-github-release-says-what-changed-in-a-few-lines) |
| **Release gate** | `docker/test-release.sh`, `.github/workflows/publish.yml` | Updates the previous release to the candidate images and rolls back before they publish. See [TESTING.md](TESTING.md#a-release-publishes-only-the-images-its-gates-tested) |

## Package boundaries

[AGENTS.md § Critical Rules](../AGENTS.md#critical-rules) states these rules in short. Each one follows with its reason.

### Dependency direction

**Dependencies run one way: `sheet → lib` and `ui → lib`, never back.** `packages/lib` is shared by the frontend and the backend, while `sheet` and `ui` depend on React and the DOM. If lib imported either, the backend would load React at module evaluation. A biome rule enforces it. So the sheet types both sides need (`Cell`, `Sheet`, `Op`, `Range`, …) live in `packages/lib/src/sheets/`, and the sheet package re-exports them.

`packages/math` is a leaf below all three: anything may import it and it imports nothing, no package and no React, DOM, Bun or Node API, so the browser, the API, a Worker and Node run it unchanged. Its biome rule and its tsconfig (`lib: ["ESNext"]`, no `types`) enforce it.

### Backend imports of lib

**The backend imports lib through React-free subpaths, never a `core/` domain barrel**, because every `@workspace/lib/<domain>` barrel re-exports React hooks. Safe by design are `types/*`, `constants`, `validation`, `sheets`, `vector`, `charts`, `background`, `docs/eigendoc` and the React-free leaf modules (`date`, `format`, `html`, `xml` and their siblings). A React-free module inside a domain directory gets an explicit subpath in lib's exports map, such as `collab/yjs-utils` or `mail/addresses`. A new one gets its entry next to those; lib has no wildcard exports into `core/`, so an uncarved deep import doesn't resolve.

Two names mislead. `download` is a leaf subpath but needs `document`, so it is frontend-only. `@workspace/lib/docs` is the Docs domain's barrel of React hooks, while `docs/eigendoc` is the React-free schema the backend imports. What each `@workspace/*` specifier resolves to: [CODE-STANDARDS.md § Imports](CODE-STANDARDS.md#imports).

### One source of truth per fact

**A set, map, schema or constant that answers a question** (which extensions are text-editable, which MIME is a spreadsheet, what a valid S3 config is) **lives in one module.** Import it and derive a subset from it; never re-list its members inline. Two lists of one fact drift apart.

### A primitive is shared only when its barrel exports it

**Reusable values go through the package's public entry** (`@workspace/ui`, `@workspace/lib/<domain>`), and reusable types through `@workspace/lib/types/<domain>`. An unexported primitive is invisible to the next author, who rebuilds it. A deep import past a barrel (`@workspace/lib/core/…`) usually means the thing should have been exported. An export also needs a user outside its file, which the standards script checks ([CODE-STANDARDS.md § Standards Gates](CODE-STANDARDS.md#standards-gates)).

### Third copy → shared wrapper

**When you are about to paste a scaffold into a third app, extract one wrapper into `packages/ui` instead.** That holds for route guards, `_auth.tsx` files, editor shells and loading, empty and error treatments, not just components. So `createEigenAppRouter` bootstraps every app but the marketing site, `createAuthRouteOptions` guards every app but admin, which also checks the org role, and `SidebarSection` is the one loading, error and empty treatment of every sidebar.

## Pitfalls

These patterns have caused bugs in more than one domain. The gated ones (MIME strings, `:ownerId`, hover without touch) are enforced by `scripts/check-standards.ts` ([CODE-EXAMPLES.md § Standards Gates](CODE-EXAMPLES.md#standards-gates)).

- **Query keys include `ownerId`** for any owner-scoped data ([CODE-STANDARDS.md § Key Patterns](CODE-STANDARDS.md#key-patterns)).
- **Every route-callable `Drive` method has a `SharedDrive` wrapper** with its permission check (`requireRead`, `requireWrite` or `requireDriveOwner`) ([§ Drive Architecture](#drive-architecture)).
- **MIME strings come from the constants** ([§ Eigen file types](#eigen-file-types), gated).
- **`validateSearch` in a shared route extracts every URL param the route uses**: a missing one, such as `uid`, silently breaks the detail pane of a shared item.
- **Never mutate the TanStack Query cache in place**: use `setQueryData()` or `invalidateQueries()`.
- **No `"use client"`**: this is Vite, not Next.js, and the directive does nothing.
- **Every authenticated route has `:ownerId` as its second path segment** (gated). It names the Home that owns the resource: `user.id` for personal data, `team_{teamId}` for a team, resolved by `parseOwnerId()` (`packages/lib/src/types/owner.ts`). The route checks the caller may act on that Home. The fixed position is what would let a router pin a Home to one server ([SCALABILITY.md](SCALABILITY.md)). Server-wide endpoints that act on no Home (setup, server-wide settings, public surfaces, the backup routes) carry none and have their own gate; `OWNER_ID_EXEMPT` in `scripts/check-standards.ts` lists them.
- **Hover-revealed affordances use `HOVER_REVEAL_CLASS`**, never `invisible`, so the keyboard reaches them, and a hand-written one adds the `pointer-coarse:` variant so it rests visible on touch (gated). See [LAYOUT.md § Hover-revealed affordances rest visible on touch](LAYOUT.md#hover-revealed-affordances-rest-visible-on-touch).
- **Never call `getHome()` for another owner's data**: a call from one Home into another goes through `home-relay.ts`, `sendToHome()` to push and `pull*()` to read. `getHome()` is fine for the request's own Home. So the relay is the one place sharding changes ([SCALABILITY.md](SCALABILITY.md)).
- **A page layout is `ColumnLayout` and `Column` with the toolbar as the `toolbar` prop**, never inside the page content. See [LAYOUT.md § Every page is a ColumnLayout of Columns with the toolbar as a prop](LAYOUT.md#every-page-is-a-columnlayout-of-columns-with-the-toolbar-as-a-prop).
