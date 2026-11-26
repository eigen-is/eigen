# Proposal: Public links

This proposal lets a user share a file, a folder or a collab document with anyone who has its link. The visitor needs no account and no emailed code: opening the link opens the item, view-only. Users ask for this again and again: today the only way to reach someone outside the server is a guest, and a guest needs an email address and a code for every sign-in.

**Status:** not built. [ROADMAP.md](../ROADMAP.md) has its row in P1. Sharing is described in [ACL.md](../ACL.md), guests in [GUEST-ACCESS.md](../GUEST-ACCESS.md), the collab socket in [COLLAB.md](../COLLAB.md). No password, no reset, no expiry date, no edit links, no view counter and no document export for a visitor in this version.

> **TLDR:** "Anyone with the link" is a third choice of **General access**, beside **Restricted** and **Anyone signed in**. It is one more value of the path's `visibility`, and nothing else is stored. The link is the item's ordinary URL, the one in the address bar, as with Google. Thirteen read routes and the collab socket answer a request that has no login when the path, or a folder above it, has that value. Every other route keeps asking for a signed-in user, so it refuses a visitor without anyone having to remember to. A signed-in person gets what "Anyone signed in, can view" gives today. There is no link account, no key, no cookie and no new route.

The whole design in one table:

| # | Concern | The one place | What it does |
|---|---|---|---|
| 1 | The link is on | `visibility: 'link'` on the path | One column, so a path is exactly one of restricted, signed-in or link |
| 2 | The switch | `sharing.publicLinks`, and never on a demo server | Checked once in `LinkDrive` and on save |
| 3 | What a link opens | `canReadByLink` in `lib/drive/acl.ts` | The path and what is below it, by an allow-list of types, never a write |
| 4 | What a visitor is handed | `LinkDrive` | A read-only wrapper: a few reads, trimmed |
| 5 | Which routes listen | The `linkAuth` macro | Thirteen read routes and the socket: `user ? getSharedDrive : LinkDrive` |
| 6 | The socket | `CollabDocument` and `routes/collab.ts` | A connection without a user gets no awareness and may send almost nothing |
| 7 | The visitor's screen | One `beforeLoad` guard for seven routes | The item's own route renders without a login; "visitor" means "no user" |

## The problem

- **Sharing outside the server needs an email address.** A link on a website, in a newsletter or in a chat group can't name its readers.
- **Every sign-in is a mail round trip.** For "have a look at this PDF" a six-digit code is too much, and a code that lands in spam loses the reader.
- **"Unrestricted" is not public.** The share dialog's **General access** lets "anyone signed in with the link" view. `canFromAncestors` (`apps/api/src/lib/drive/acl.ts`) grants `public-read` and `public-write` to a signed-in user only, and every drive route asks for a session.

## Why not a guest account

The first design made a link a `role: 'guest'` user with a reserved address and a real session. It is dropped. A session opens everything a guest reaches: better-auth's own `/auth/*` routes, every route without `requireNonGuest`, chat notifications, the bell. Keeping a link account out of all of that is a denylist, and a denylist is a place to forget. Here a visitor has no session, so a route has to opt in before it answers one.

## The link is the item's URL

There is one URL per item, the one people already share with members. A key in a second URL was the alternative; it needs an ACL entry kind, a cookie and an unauthenticated entry route, and it gives two links for one item.

So the secret is the path id. `Mount` makes every path id with `crypto.randomUUID()` (`apps/api/src/lib/mount/mount.ts`): a version 4 UUID, 122 random bits. Nobody guesses it. The owner id is a 32-character better-auth id or `team_<id>` and a personal mount id is the constant `'default'`, so neither adds to it. Eigen does not hide path ids from people with access nearby: every `DrivePath` carries its `parentId`, and `SharedDrive.ancestorIds` hands a reader the ids of the whole chain. The owner accepted what follows from that:

- **No Reset link.** Anyone who ever saw the URL can open the item while it is public. Choosing another General access closes it, and choosing "Anyone with the link" again opens the same URL.
- **A public folder is open to everyone who can already see something in it**, because they know its id.

## The value

`DriveVisibility` (`packages/lib/src/types/drive-access.ts`) gains `'link'`. It is stored in the `visibility` TEXT column that exists (`apps/api/src/lib/mount/schema.ts`), so there is no migration, and the one-of-three rule needs no code: one column holds one value.

| Choice in the dialog | `visibility` | Signed in, not a member | No login |
|---|---|---|---|
| Restricted | `private` | No access | No access |
| Anyone signed in with the link | `public-read`, `public-write` | Reads or edits | No access |
| Anyone with the link | `link` | Reads, exactly as under `public-read` | The visitor view |

**For a signed-in user `'link'` is `public-read`.** `grantsPublicRead` (`acl.ts`) answers true for it, and that is the whole change: `canFromAncestors` then reads it as `public-read` does, and `checkAccessForEmails` (`lib/drive/sharing.ts`) too. Write is untouched.

**It travels on the existing ACL route.** `PUT /drive/:ownerId/:mountId/path/:pathId/acl` already takes `visibility`, the dialog already sends it on Save through `useUpdateACL`, and `SharedDrive.updateACLDelta` already checks write and `sharingRestricted`. So an editor may publish under the same rule as any sharing change, and no new route or hook is needed. The copy-link icon copies `getDriveShareUrl(path)` as it does today.

**One place refuses it.** `Drive.updateACLDelta` refuses a path that becomes `'link'`: 403 while public links are off, and 400 on a chat, on a path inside a document, and on anything that is not a file, a folder or a collab document. A path that already is `'link'` saves as before, so it can be shared further or closed while public links are off. The mount root is refused already. It reads the path with `getActivePath`, which checks only the path's own `trashedAt`; the rule below checks the whole chain, so a value saved under a trashed folder opens nothing.

**The switch.** `sharing.publicLinks` is a boolean in `ServerSettings` (`packages/lib/src/types/settings.ts`), on by default. "On" for the code is `getServerSettings().sharing.publicLinks && !isDemo()` (`lib/config/env.ts`), since anyone can upload to a demo server. Off, no link can be saved and every existing one is closed. The values stay stored, so turning it on opens them again.

## What a link opens

`canReadByLink(chain)` sits beside `canFromAncestors` in `acl.ts` and is the whole visitor rule for a chain. It is pure. The switch is not its business: `LinkDrive` checks it once, before it asks the rule. It takes the path's breadcrumb and answers the index of the highest public path in the chain, or nothing:

1. No path in the chain is in the trash (`isTrashedChain`).
2. Some path in the chain has `visibility: 'link'`. So a folder's link covers everything below it, a private subfolder included, and nothing beside or above it.
3. The allow-list: from the public path down, every step is a folder, and the last may also be a file or a collab document (`isCollabType`). Past a collab document the chain may only go on into its `media/` folder and a file in it. Anything else is refused: a chat, a document's `data.db`, `comments.db`, comment threads and versions, and any path type added later.

There is no write variant: a visitor can't write because no code asks.

`LinkDrive` (`apps/api/src/lib/drive/link-drive.ts`) wraps the owner's `Drive` by composition, as `SharedDrive` does, with only the reads its routes call: `getPath`, `getFolderContents`, `breadCrumb`, `resolveFile` and `canRead`, and `getCollabDocument` with unit 3. Each runs the rule first, so `getPath` refuses a chat row too. `canRead(mountId, pathId)` takes no user and answers a boolean, and there is no `canWrite`: a visitor never writes, so the three routes that report rights answer `canWrite: false` themselves. The read methods share their signatures with the other two drives, so a route needs no `instanceof`. `resolveFile` hands the route the owner's own row, because it feeds the preview cache, which every caller shares, and never an answer. What a visitor is handed is trimmed in one place:

- Every `DrivePath` has `acl: null`.
- A breadcrumb starts at the public path. That path keeps its `parentId`, as it does for a signed-in sharee: the id names the folder above, never its name or contents.
- A folder listing holds only what the rule admits.

`sharedChainHead` (`packages/lib/src/types/drive.ts`) tells a cut chain by `parentId !== null`, so a visitor's chain reads as cut, as a sharee's does, and the breadcrumb and the detail column's Location row need no visitor case. The breadcrumb's Shared with me lookup takes the user's id, so it reads nothing for a visitor.

**The answers.** `createHome` (`lib/home/get-home.ts`) answers 404 for an unknown owner and 400 for a malformed one before any `LinkDrive` exists; owner ids are not secret. Past that, every refusal of `LinkDrive` is the same 403: a path that does not exist, one that is not public, one in the trash, and the switch off. An unknown mount id keeps `Drive.getMount`'s 404, since mount ids are not secret either. The permissions route answers `canRead: false` instead of a 403, as it does for a signed-in user.

## A visitor is no user

A visitor is not a `User`: a stand-in like `makeSyntheticUser` would flow into `getSharedDrive` (which hands out the raw `Drive` when the owner id equals the user id), `getMemberships`, `recordOpened`, the awareness check and every `actor` argument. A visitor has no Home, so `home-relay.ts` never comes into it: the request opens only the Home its URL names.

`routes/auth.ts` gets `linkAuth` beside `auth`. It is built on a small macro of its own, `optionalAuth`, which resolves the user or null, because in Elysia a macro's hook sees only what a macro it builds on resolved. No route names `optionalAuth` itself, and a test holds that:

| Macro | Resolves | Without a session |
|---|---|---|
| `auth: true`, unchanged | `user: User`, `session` | 401 |
| `linkAuth: true`, new | `user: User \| null`, `session` or null | Goes on |

A route fails closed in two ways. A route nobody touched still says `auth: true`. And a `linkAuth` handler holds a `User | null`, which `getSharedDrive` does not take, so it calls `getReadDrive(ownerId, user)` (`lib/drive/get-drive.ts`), which hands a user a `SharedDrive` and a visitor a `LinkDrive`, and can call only the methods all three drives have. The routes that report rights (4, 13 and the socket) branch on the user instead, because a member's `canRead` takes a `User`. There is no per-path choice between the two: a login decides.

For a request without a user the macro also sets two headers after the handler, on `set.headers` and on a returned `Response`: `X-Robots-Tag: noindex` and `Cache-Control: no-store`. Today previews and thumbnails answer `private, max-age=86400`, `serveFile` answers `private, no-cache`, and the JSON routes set nothing.

## The routes that opt in

Thirteen reads and the socket. Each resolves the path id in its own URL through the drive, so each runs the rule for that path.

| # | Route | File | Reads through |
|---|---|---|---|
| 1 | `GET /drive/:ownerId/:mountId/path/:pathId` | `routes/drive.ts` | `getPath` |
| 2 | `GET /drive/:ownerId/:mountId/folder/:pathId` | `routes/drive.ts` | `getFolderContents` |
| 3 | `GET /drive/:ownerId/:mountId/path/:pathId/breadcrumb` | `routes/drive.ts` | `breadCrumb` |
| 4 | `GET /drive/:ownerId/:mountId/path/:pathId/permissions` | `routes/drive-sharing.ts` | `canRead`; `canWrite` is false |
| 5 | `GET /drive/:ownerId/:mountId/file/:pathId/download` | `routes/drive.ts` | `resolveFile`, with ranges |
| 6 | `GET /drive/:ownerId/:mountId/file/:pathId/embed/:fileName` | `routes/drive-content.ts` | `resolveFile`, with ranges |
| 7–11 | `GET …/file/:pathId/preview`, `text-preview`, `vcard-preview`, `eml-preview`, `ics-preview` | `routes/drive-content.ts` | `resolveFile` |
| 12 | `GET /drive/:ownerId/:mountId/thumb/:fileName` | `routes/drive-content.ts` | `resolveFile` |
| 13 | `GET /collab/:ownerId/:mountId/:pathId/info` | `routes/collab.ts` | `canRead`, `getPath`, `getFolderContents`; `canWrite` is false |
| | `WS /ws/collab/:ownerId/:mountId/:pathId` | `routes/collab.ts` | `canRead`, `getCollabDocument` |

Everything else stays closed, by saying `auth: true`: the export route, effective members, the ACL route, `GET …/history`, the version list, every chat route with its messages, the comment index (`/collab/…/comments` and `/comments/search`), notifications, SSE, search, recent, shared with me, watches, request access, email collaborators, mounts, the root folder, the inline editor's content and every write. Two tests hold that against the list above, so a new route is closed until someone adds it there: one walks the app's route table and expects a 401 without a login, or the 422 of a route that validates its input first, and one reads the route files and expects `linkAuth: true` on exactly the listed routes.

Why no cookie: a visitor's request has nothing to carry. An `<img>`, a media request and the socket are plain requests to the item's URL.

A document refers to its pictures by name in its own `media/` folder ([MEDIA-REFERENCES.md](../MEDIA-REFERENCES.md)), which the link covers. A file attached by id that lives outside the public path does not open for a visitor. That is accepted.

## The socket

A socket that opens with a user is untouched, a signed-in reader of a public document included. A socket without a user differs in four ways:

- **No awareness, either way.** `CollabDocument.subscribe` takes `User | null`. Inbound awareness is dropped by the check that is there (`if (!user) return`). Two sends learn the same rule: `sendSyncStep1` skips the awareness states, and the awareness `update` handler sends only to connections with a user.
- **It may send almost nothing.** `maxPayloadLength` in `app.ts` is 128 MB and frames are not rate limited. So the route's `message` handler closes a socket without a user, with 1008, on a binary frame over 64 KiB. A sync step 2 and an update are dropped without being read, as for any reader. A sync step 1 is answered every time, as for any reader: the client sends one every 5 s (`resyncInterval` in `use-collab-doc.ts`), and on a quiet document that answer is the only frame that keeps y-websocket from closing the socket after 30 s.
- **`recordOpened` is skipped.**
- **The keepalive asks the rule.** `checkAccess` in `routes/collab.ts` is built on `ws.data.session.id` and `getSessionUser`, which a visitor does not have. For a socket without a user it asks only `LinkDrive.canRead` for its path, every 15 s:

| What happened | The next tick |
|---|---|
| Another General access is saved | No path in the chain is `'link'`: close 4403 |
| Public links are turned off | `LinkDrive` reads the switch: close 4403 |
| The path or a folder above it is trashed | `isTrashedChain`: close 4403. The trash itself closes the document first ([SOFT-DELETE.md](../SOFT-DELETE.md)) |
| The path is moved out of a public folder | Its chain no longer holds the folder: close 4403 |

A socket keeps the kind it opened with. Someone who signs in, or is given access, while a visitor tab is open stays a visitor there until a reload. That is accepted.

## The frontend

What the apps do today, read from the code:

- `AuthProvider` (`packages/lib/src/core/auth/auth-context.tsx`) reads `authClient.getSession()` once and holds `user: AuthUser | null`.
- Every app's `_auth.tsx` is `createAuthRouteOptions()` (`packages/ui/src/components/layout/pages/auth-route.tsx`): no user means a redirect to `/login`, and child routes get a user in their context. `_auth` is a layout without a URL segment.
- The five editor routes (`_auth.doc.…`, `_auth.sheet.…`, `_auth.slide.…`, `_auth.vector.…`, `_auth.board.…`) never read that context user. Each renders `EigenDocEditorRoute`, which loads `useCollabDocumentInfo`. The editors take `user: AuthUser | null` from `useAuth()`.
- Drive's folder route (`_auth.fs.…`) and its shared route (`_auth.shared.$to.tsx`) read the context user. A plain file's link today is the shared route with the file selected (`getDriveShareUrl`).
- The shell has a signed-out state: `Topbar` draws the logo and a **Log in** button and no app switcher, palette, bell or account menu, and `EigenDocRoot` and Drive's root route give no sidebar without a user.

The change, with no new route and no second URL:

- **Eight route files leave `_auth`**: the five editor routes and Drive's `fs`, `shared.$to` and `edit`. The URLs stay the same. Drive's `edit` route is the text editor, which a text file's link names; without a user it only forwards to the file's page under `shared`, where the guard checks it. Each app's root route and the file itself name the new route id, and Drive's two take their user from `useAuth()`.
- **One `beforeLoad` guards the other seven**, `guardLinkRoute` beside `createAuthRouteOptions` in `auth-route.tsx`. With a user it does nothing. With no user it asks the permissions route for the item the URL names, through `fetchPathPermissions` in lib, and redirects to `/login`, with the way back, on no read. A URL that names no item redirects at once: `/fs/<owner>/<mount>/root`, `/shared/by-me`, and `/shared/with-me` without `pid`. So a private item behaves as today, and `RequestAccessView` is untouched: only a signed-in user reaches it. Drive's folder route skips the guard while the visitor stays on that route, so opening a subfolder asks nothing twice; the API refuses what the link does not cover.
- **"Visitor" is "no user"**, read from `useAuth()` in the seams that have a guest case today or serve every app. `useCommentLifecycle` shows the cards and runs no thread, index or member query. `useDriveActionsFor` keeps Open, and `useFileActions` keeps Quick preview and a plain file's Download. The history and watch queries are off, and Watch, the sharing section and, on a lone file's page, the close button are not drawn. `FileMenu` keeps Print and drops Download, which is an export. `EigenDocEditorRoute` mounts no share dialog, and the top bar shows the document's name.
- **A lone file.** With no user the shared route leaves `useSharedPaths` off (it takes `skipToken` for an empty owner id) and gives `DriveLayout` the one file from `usePathInfo` as its list, read-only, with the file's name as the title. The visitor sees one row with the file open beside it, and the quick look works.

Who sees what on the one URL:

| Caller | Sees |
|---|---|
| A member, signed in | The full app, as today |
| Signed in, not a member, a guest included | The reader view `public-read` gives today |
| No login, public item | The visitor view |
| No login, private item | The login page, as today |

A visitor gets no event stream, so an open folder does not update by itself. An open document does, through its socket.

## What a visitor sees

Visitors see the item as it is stored. In a document that includes its comment cards: title, description, attachments, the author's address and the time, because a card lives in the Y.Doc (`writeCardToDoc`). On a stickies board the cards are the board. They also see the owner's name and avatar, since `/p/users` and `/p/avatar` are public and the owner id is in the URL. Visitors do not see the replies under a comment, the access list, the history, the versions or who is online. A visitor downloads a plain file. A document is to view, and to print where its editor prints. [ROADMAP.md](../ROADMAP.md) has a P2 row for the card's author and content in the document.

## The share dialog

**General access** in `DriveAccessListEdit` becomes one control with three choices, Google's way: **Restricted**, **Anyone signed in with the link** (with its **Can view** or **Can edit**), and **Anyone with the link**, which is view only. There is no separate section and no switch. The choice waits for **Save** like every other change in the dialog. It shows only on a file, a folder or a collab document, and not while public links are off, which `/p/config` tells the dialog. Under the third choice:

"Anyone who has this link can view this without signing in, and download files. The link is the item's address: whoever has seen it can open it for as long as this is on. Everything inside a public folder is public, private subfolders too. Visitors see comments and who wrote them, but not the replies, the history or who has access."

The read-only `DriveAccessList` and `DriveShareSummary` name the third state.

**The Admin setting** is one checkbox, **Allow public links**, on the **Guest access** page (`apps/admin/src/components/admin/guest-settings.tsx`), under the guest sign-up toggle, saved through `useServerSettings`. Both settings answer "who from outside gets in", and one checkbox does not earn a page.

## Lifecycle

| Event | What happens |
|---|---|
| Choose "Anyone with the link" and save | The value is written, the URL is open |
| Choose anything else and save | Closed with the save. Open visitor sockets close within 15 s |
| Trash | Closed. Restore opens the same URL again |
| Move | A move stays in its mount and keeps the row, so the URL holds. A path moved out of a public folder is closed |
| Copy | A copy gets a new row with the default `private` |
| Delete for good, owner or team deleted | The row or the Home is gone |

No sweep and no cleanup: a link is one value in one row.

## Later

- **Document export for a visitor** needs a lane of its own in the transform queue, so visitors can't hold up members.
- **A password or a Reset link** need a stored key, a cookie and an unauthenticated entry route. The `visibility` value stays.
- **A page of its own for a lone file.**

## Where the design bends

1. **Not an option on `auth`, a second macro, and a third under it.** One macro has one resolve type, and `auth: true` must keep handing out `user: User`. `linkAuth` needs `optionalAuth` below it to read the user in its header hook.
2. **A visitor's sync step 2 is dropped, not a reason to close, and its sync step 1 is not counted.** The review asked to close on any update, and the plan then allowed one step 1 per connection. y-websocket answers the server's sync step 1 with a step 2 of its own, and Eigen's client sends a step 1 every 5 s, so either rule would close every visitor. The frame cap alone bounds what a visitor sends.
3. **Print for a visitor is the editor's own print**, which only Docs has today ([ROADMAP.md](../ROADMAP.md), P2).

## Risks, and what is accepted

- **The URL is a bearer token, and only choosing another General access closes it.** URLs travel: browser history, chat previews, forwarded mails. Choosing the link again, a restore from the trash, turning the setting off and on, or a backup restore from when it was public all open the same URL.
- **A visitor learns the id of the folder a public item sits in**, from the item's `parentId`, as a signed-in sharee does. It opens nothing while that folder is private. Accepted, for one chain rule on both sides.
- **A move tells a shared folder's readers the id of the folder on the other side.** A file moved between a private folder and a shared one carries the private folder's id in its history line and its live event, as every path carries its `parentId`. Those readers can open that folder once it is public. Accepted.
- **Ids are in logs.** Caddy's access log, the `[slow]` line in `app.ts` and `[collab] open path=` in `routes/collab.ts` hold path ids, which now open a public item.
- **A guest account reads more than a visitor.** With open guest sign-up anyone can make one and then read the member list and the comment threads of a public item, as `public-read` allows today. Accepted.
- **Any request without a login opens the Home its URL names** on every opt-in route, and a visitor's socket holds a document open. Only the per-IP limit in `app.ts` stands in front. Accepted for this version.
- **A public SVG shows the pictures beside it.** An SVG's preview builds in the media files it names in its own folder, for every reader, and a visitor gets that same preview. So a public SVG in a private folder shows those neighbours to anyone with the link. Accepted: one preview per file.
- **A visitor's socket can ask for the whole document again and again.** Each sync step 1 with an empty state is answered with the full document, encoded on the server's event loop, and frames are not counted. Any signed-in reader or guest can do the same today, so the bound belongs on every socket ([ROADMAP.md](../ROADMAP.md)).
- **A public file can be hotlinked** from another site. The inline routes already sandbox scriptable types (`scriptableInlineHeaders`).
- **Up to 15 s.** After a link is closed an open document still receives edits until the next keepalive, as after any revoke.

**What breaks.** No existing data changes. `'link'` is a new stored value. On a rollback to an older build a public path is closed, since that build's check does not know the value, and its share dialog shows the path as signed-in view and can't save it until another General access is chosen.

## The work

Files and folders first, then documents. **The setting is the gate.** Unit 1 adds `sharing.publicLinks` with the default off and no way to save it, so until unit 6 `Drive.updateACLDelta` refuses `'link'` and `LinkDrive` refuses every path: no link exists and no route answers without a login, whatever has merged. The route schema can't be the gate, because `_visibilitySchemaMatchesType` in `routes/drive-sharing.ts` holds it equal to `DriveVisibility`, so it gains `'link'` with the type in unit 1. Tests live in `<workspace>/src/test/`, written red first, and turn the setting on in the store.

| # | Unit | Files | Size | Risk seam | Tests |
|---|---|---|---|---|---|
| 1 | The value, the switch, the rule | `types/drive-access.ts`, `types/settings.ts`, `server-settings.ts`, `acl.ts`, `Drive.updateACLDelta`, the ACL route's schema | S | Yes: an ACL check, a stored value | `test/acl/link-rule.test.ts`: the path, a descendant, a private subfolder, a sibling, the parent, the trash, the switch, the demo, each allowed and refused type, inside a document only `media/`; a signed-in non-member reads and can't write; the refusals of `updateACLDelta`, the default included |
| 2 | Files and folders without a login | `link-drive.ts`, `get-drive.ts`, `routes/auth.ts`, `drive.ts`, `drive-content.ts`, `drive-sharing.ts`, `scripts/check-standards.ts` | M | Yes: an ACL check, routes that serve bytes without a login | `test/acl/link-routes.test.ts`: each of routes 1–12 serves a public path and answers 403 for a sibling and an unknown id; every other route in the route table answers 401; `acl` is null, the head keeps its `parentId`, the breadcrumb is cut, a listing is filtered; `no-store` and `noindex` without a user; a member is served as before |
| 3 | Documents without a login | `collab-document.ts`, `routes/collab.ts` | M | Yes: `CollabDocument.subscribe` and its broadcast | `test/collab/collab-link-visitor.test.ts`: no awareness at sync or after; awareness, step 2 and updates dropped; a repeated step 1 is answered and a 64 KiB frame closes 1008; each row of the keepalive table closes within one tick; no Recent row; a user socket is unchanged |
| 4 | The guard and Drive's visitor view | `auth-route.tsx`, Drive's `fs` and `shared.$to` routes, `useDriveActionsFor`, `useFileActions` | M | Yes: routes that leave the guard, seams every app shares | Signed out on a private item, on `root` and on `/shared/*` without `pid` lands on login; the lone-file page; a browser check signed in and out |
| 5 | The editors' visitor view | Five editor routes and root routes, `EigenDocEditorRoute`, `useCommentLifecycle`, `FileMenu`, `topbar.tsx` | M | Yes: the same | The same, per app ([verify-in-browser](../../.claude/skills/verify-in-browser/SKILL.md)) |
| 6 | Open it | The default on, the settings save, `/p/config`, the Admin checkbox, `drive-access-list-edit.tsx`, `drive-access-list.tsx`, `drive-share-summary.tsx`, Caddy's `noindex` | M | Yes: the unit that opens it | Dialog tests for the three choices and the setting; an editor saves `'link'`, and `sharingRestricted` refuses it; end to end from Save to file bytes without a login |
| 7 | Docs | ACL.md, COLLAB.md, GUEST-ACCESS.md, SERVER-SETTINGS.md, ARCHITECTURE.md (the "Route → SharedDrive → Drive → Mount" pitfall names the third wrapper), a help-center article, CHANGELOG | S | No | |

Three notes on the units:

- **Unit 1 ends with a named check**, reported before unit 2 starts: does a path id reach someone without read access through search results, stored notification rows, file-history events, the shared-with-me and recent lists after access was removed, or mentions and links inside documents? The id is the secret now, and these were not traced. The check found one leak, closed in its own commit: a copy's `copied` history event stored the original's owner, mount and path id, which any reader of the copy could read. It also found the move case under Risks.
- **Unit 2 changes the `:ownerId` gate** in `scripts/check-standards.ts`: it matches `auth: true` case-sensitively, so a `linkAuth` route would slip past it.
- **Unit 4 starts by walking Drive's detail pane and quick look without a user.** What it finds there are queries that answer 401, never a leak.

The total is L.

## Needs the owner's yes

No new route, no migration, no package. Each of these changes what an existing route takes or answers, and is asked right before it is built:

| Route | Change |
|---|---|
| `PUT /drive/:ownerId/:mountId/path/:pathId/acl` | The body's `visibility` takes `'link'` |
| The settings save in `routes/settings.ts` | The body takes `sharing.publicLinks` |
| `GET /settings/server` and the settings save's answer | They gain `sharing.publicLinks`, with the type, in unit 1 |
| `GET /p/config` | The answer gains `publicLinks` |
| The thirteen read routes and the socket | They answer without a login, through `linkAuth` |

## Open questions

1. **The words of the three choices and of the sentence under the third.** Recommended: as written above. Decide on screenshots.
