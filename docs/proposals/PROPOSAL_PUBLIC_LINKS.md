# Proposal: Public links

This proposal lets a user share a file, a folder or a collab document with anyone who has its link. The visitor needs no account and no emailed code: opening the link opens the item, view-only. Users ask for this again and again: today the only way to reach someone outside the server is a guest, and a guest needs an email address and a code for every sign-in.

**Status:** built. [ROADMAP.md](../ROADMAP.md) keeps the follow-ups. Sharing is described in [ACL.md](../ACL.md), guests in [GUEST-ACCESS.md](../GUEST-ACCESS.md), the collab socket in [COLLAB.md](../COLLAB.md). No password, no reset, no expiry date, no edit links, no view counter and no document export for a visitor in this version.

> **TLDR:** "Anyone with the link" is a third choice of **General access**, beside **Restricted** and **Anyone signed in**. It is one more value of the path's `visibility`, and nothing else is stored. The link is the item's ordinary URL, the one in the address bar, as with Google. Fourteen read routes answer a request that has no login when the path, or a folder above it, has that value. Every other route keeps asking for a signed-in user, so it refuses a visitor without anyone having to remember to. A signed-in person gets what "Anyone signed in, can view" gives today. There is no link account, no key and no cookie. A document reaches a visitor over one new read route, its stored state, and never over the collab socket, which needs a login.

The whole design in one table:

| # | Concern | The one place | What it does |
|---|---|---|---|
| 1 | The link is on | `visibility: 'link'` on the path | One column, so a path is exactly one of restricted, signed-in or link |
| 2 | The switch | `sharing.publicLinks`, and never on a demo server | Asked by `LinkDrive` before it opens the Home, and on save |
| 3 | What a link opens | `canReadByLink` in `lib/drive/acl.ts` | The path and what is below it, by an allow-list of types, never a write |
| 4 | What a visitor is handed | `LinkDrive` | A read-only wrapper: a few reads, trimmed |
| 5 | Which routes listen | The `linkAuth` macro | Fourteen read routes: `user ? getSharedDrive : LinkDrive` |
| 6 | A document | `routes/collab.ts` | The socket is for a live reader, signed in and reading by name or allowed to write; anyone else, a visitor included, loads the stored state over HTTP |
| 7 | The visitor's screen | One `beforeLoad` guard for seven routes | The item's own route renders without a login; "visitor" means "no user" |

## The problem

- **Sharing outside the server needs an email address.** A link on a website, in a newsletter or in a chat group can't name its readers.
- **Every sign-in is a mail round trip.** For "have a look at this PDF" a six-digit code is too much, and a code that lands in spam loses the reader.
- **"Unrestricted" is not public.** The share dialog's **General access** lets "anyone signed in with the link" view. `canReadFromAncestors` (`apps/api/src/lib/drive/acl.ts`) grants `public-read` and `public-write` to a signed-in user only, and every drive route asks for a session.

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
| Anyone with the link, public links off | `link` | No access | No access |

**For a signed-in user `'link'` is `public-read` while public links are on.** `grantsPublicRead` (`acl.ts`) answers true for it only while its caller says public links are on (`arePublicLinksEnabled()`), and that is the whole change: `canReadFromAncestors` then reads it as `public-read` does, and `checkAccessForEmails` (`lib/drive/sharing.ts`) too. Write is untouched. With public links off a link is closed for everyone: a signed-in non-member or a guest loses the read too, and only people with an ACL entry, the owner and the team keep their access.

**It travels on the existing ACL route.** `PUT /drive/:ownerId/:mountId/path/:pathId/acl` already takes `visibility`, the dialog already sends it on Save through `useUpdateACL`, only after the person picked a choice in that dialog, and `SharedDrive.updateACLDelta` checks write held by name and `sharingRestricted` (`requireShare`). So an editor by name, an owner, a team member or someone an ACL entry lets write, may publish under the same rule as any sharing change, and no new route or hook is needed. Someone who edits only through "Anyone signed in with the link" may not. Nor may they move the item to another folder, where it could be theirs to publish, or email its collaborators: both need write held by name too (`requireWriteByName`, [ACL.md § Re-Share Prevention](../ACL.md#re-share-prevention)). The copy-link icon copies `getDriveShareUrl(path)` as it does today.

**One place refuses it.** `Drive.updateACLDelta` refuses a path that becomes `'link'`: 403 while public links are off, and 400 on a chat, on a path inside a document, and on anything that is not a file, a folder or a collab document. A path that already is `'link'` saves as before, so it can be shared further or closed while public links are off. The mount root is refused already. It reads the path with `getActivePath`, which checks only the path's own `trashedAt`; the rule below checks the whole chain, so a value saved under a trashed folder opens nothing.

**The switch.** `sharing.publicLinks` is a boolean in `ServerSettings` (`packages/lib/src/types/settings.ts`), on by default. "On" for the code is `getServerSettings().sharing.publicLinks && !isDemo()` (`lib/config/env.ts`), since anyone can upload to a demo server. Off, no link can be saved and every existing one is closed, for a visitor and a signed-in non-member alike. The values stay stored, so turning it on opens them again, and the share dialog can still save another General access over one.

## What a link opens

`canReadByLink(chain)` sits beside `canReadFromAncestors` in `acl.ts` and is the whole visitor rule for a chain. It is pure. The switch is not its business: `LinkDrive` asks it first, before it opens the owner's Home and before it asks the rule. It takes the path's breadcrumb and answers the index of the highest public path in the chain, or nothing:

1. No path in the chain is in the trash (`isTrashedChain`).
2. Some path in the chain has `visibility: 'link'`. So a folder's link covers everything below it, a private subfolder included, and nothing beside or above it.
3. The allow-list: from the public path down, every step is a folder, and the last may also be a file or a collab document (`isCollabType`). Past a collab document the chain may only go on into its `media/` folder and a file in it. Anything else is refused: a chat, a document's `data.db`, `comments.db`, comment threads and versions, and any path type added later.

There is no write variant: a visitor can't write because no code asks.

`LinkDrive` (`apps/api/src/lib/drive/link-drive.ts`) takes the owner id and wraps the owner's `Drive` by composition, as `SharedDrive` does, opening the Home only after the switch says yes, with only the reads its routes call: `getPath`, `getFolderContents`, `breadCrumb`, `resolveFile` and `canRead`. Each read runs the rule first, so `getPath` refuses a chat row too. `canRead(mountId, pathId)` takes no user and answers a boolean, and there is no `canWrite`: a visitor never writes. `getReaderAccess` (`lib/drive/get-drive.ts`) is the one place that answers a member's or a visitor's rights, `canWrite: false` for a visitor, and the permissions route and the collab info route both ask it. The read methods share their signatures with the other two drives, so a route needs no `instanceof`. `resolveFile` hands the route the owner's own row, because it feeds the preview cache, which every caller shares, and never an answer. What a visitor is handed is trimmed in one place:

- Every `DrivePath` has `acl: null`.
- A breadcrumb starts at the public path. That path keeps its `parentId`, as it does for a signed-in sharee: the id names the folder above, never its name or contents.
- A folder listing holds only what the rule admits.

`sharedChainHead` (`packages/lib/src/types/drive.ts`) tells a cut chain by `parentId !== null`, so a visitor's chain reads as cut, as a sharee's does, and the breadcrumb and the detail column's Location row need no visitor case. The breadcrumb's Shared with me lookup takes the user's id, so it reads nothing for a visitor.

**The answers.** While public links are on, the Home lookup (`lib/home/get-home.ts`) answers 404 for an unknown owner and 400 for a malformed one; owner ids are not secret. With links off, `LinkDrive` refuses first, so an unknown owner answers 403 and no Home is opened. Past that, every refusal of `LinkDrive` is the same 403: a path that does not exist, one that is not public, one in the trash, and the switch off. An unknown mount id keeps `Drive.getMount`'s 404, since mount ids are not secret either. The permissions route answers `canRead: false` instead of a 403, as it does for a signed-in user.

## A visitor is no user

A visitor is not a `User`: a stand-in like `makeSyntheticUser` would flow into `getSharedDrive` (which hands out the raw `Drive` when the owner id equals the user id), `getMemberships`, `recordOpened`, the awareness check and every `actor` argument. A visitor has no Home, so `home-relay.ts` never comes into it: the request opens only the Home its URL names.

`routes/auth.ts` gets `linkAuth` beside `auth`. It is built on a small macro of its own, `optionalAuth`, which resolves the user or null, because in Elysia a macro's hook sees only what a macro it builds on resolved. No route names `optionalAuth` itself, and a test holds that:

| Macro | Resolves | Without a session |
|---|---|---|
| `auth: true`, unchanged | `user: User`, `session` | 401 |
| `linkAuth: true`, new | `user: User \| null`, `session` or null | Goes on |

A route fails closed in two ways. A route nobody touched still says `auth: true`. And a `linkAuth` handler holds a `User | null`, which `getSharedDrive` does not take, so it calls `getReadDrive(ownerId, user)` (`lib/drive/get-drive.ts`), which hands a user a `SharedDrive` and a visitor a `LinkDrive`, and can call only the methods all three drives have. The routes that report rights (4 and 13) ask `getReaderAccess` instead, because a member's `canRead` takes a `User`. The socket keeps `auth: true`. There is no per-path choice between the two: a login decides.

For a request without a user the macro also sets two headers after the handler, on `set.headers` and on a returned `Response`: `X-Robots-Tag: noindex` and `Cache-Control: no-store`. Today previews and thumbnails answer `private, max-age=86400`, `serveFile` answers `private, no-cache`, and the JSON routes set nothing.

## The routes that opt in

Fourteen reads. Each resolves the path id in its own URL through the drive, so each runs the rule for that path.

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
| 13 | `GET /collab/:ownerId/:mountId/:pathId/info` | `routes/collab.ts` | `canRead`, `getPath`, `getFolderContents`; `canWrite` and `live` are false |
| 14 | `GET /collab/:ownerId/:mountId/:pathId/state` | `routes/collab.ts` | `resolveFile`, one cached merged state, with an ETag and 304 |

Everything else stays closed, by saying `auth: true`: the collab socket, the export route, effective members, the ACL route, `GET …/history`, the version list, every chat route with its messages, the comment index (`/collab/…/comments` and `/comments/search`), notifications, SSE, search, recent, shared with me, watches, request access, email collaborators, mounts, the root folder, the inline editor's content and every write. Two tests hold that against the list above, so a new route is closed until someone adds it there: one walks the app's route table and expects a 401 without a login, or the 422 of a route that validates its input first, and one reads the route files and expects `linkAuth: true` on exactly the listed routes.

Why no cookie: a visitor's request has nothing to carry. An `<img>`, a media request and the state fetch are plain requests to the item's URL.

A document refers to its pictures by name in its own `media/` folder ([MEDIA-REFERENCES.md](../MEDIA-REFERENCES.md)), which the link covers. A file attached by id that lives outside the public path does not open for a visitor. That is accepted.

## A document without the socket

The collab socket is for a live reader: someone signed in who reads the document by name, as its owner, a team member or through an ACL entry, or who may write it, "Anyone signed in with the link, can edit" included (`live` in `getReaderAccess`). The route is `auth: true`, so an upgrade without a login is a 401, and a signed-in reader who is not live is closed with 4403 at open and on the 15 s keepalive. The info route answers the same rule as `live`.

Everyone else who may read loads the stored state: a visitor, and someone signed in who reads only through a link or "Anyone signed in, can view". `GET /collab/:ownerId/:mountId/:pathId/state` answers the document's current state as one garbage-collected Yjs update, what a member's first sync carries, so a link reader never receives text an author deleted. It answers with an ETag and a 304 on `If-None-Match`, and opens no `CollabDocument`. The transform process builds the state once per version, in the background for a link reader, and the preview cache keeps it, so a later request is a file send. `useCollabDoc` makes no socket for such a reader. It asks again when the tab is shown, and reloads the page on a 401 or 403, so a visitor whose link closed lands on the login page. [COLLAB.md](../COLLAB.md#a-reader-who-is-not-live-loads-the-stored-state-over-http) has the route and the client.

No visitor ever reaches the socket, so nothing there needs a visitor case: no sync or awareness rule of its own, no link-rule check on the keepalive, and `recordOpened` always has a user.

## The frontend

What the apps do today, read from the code:

- `AuthProvider` (`packages/lib/src/core/auth/auth-context.tsx`) reads `authClient.getSession()` once and holds `user: AuthUser | null`.
- Every app's `_auth.tsx` is `createAuthRouteOptions()` (`packages/ui/src/components/layout/pages/auth-route.tsx`): no user means a redirect to `/login`, and child routes get a user in their context. `_auth` is a layout without a URL segment.
- The five editor routes (`_auth.doc.…`, `_auth.sheet.…`, `_auth.slide.…`, `_auth.vector.…`, `_auth.board.…`) never read that context user. Each renders `EigenDocEditorRoute`, which loads `useCollabDocumentInfo`. The editors take `user: AuthUser | null` from `useAuth()`.
- Drive's folder route (`_auth.fs.…`) and its shared route (`_auth.shared.$to.tsx`) read the context user. A plain file's link today is the shared route with the file selected (`getDriveShareUrl`).
- The shell has a signed-out state: `Topbar` draws the logo and a **Log in** button and no app switcher, palette, bell or account menu, and `EigenDocRoot` and Drive's root route give no sidebar without a user.

The change, with no new route and no second URL:

- **Eight route files leave `_auth`**: the five editor routes and Drive's `fs`, `shared.$to` and `edit`. The URLs stay the same. Drive's `edit` route is the text editor, which a text file's link names; without a user it only forwards to the file's page under `shared`, where the guard checks it. Each app's root route and the file itself name the new route id, and Drive's two take their user from `useAuth()`.
- **One `beforeLoad` guards the other seven**, `guardLinkRoute` beside `createAuthRouteOptions` in `auth-route.tsx`. With a user it does nothing. With no user it asks the permissions route for the item the URL names, through `fetchPathPermissions` in lib, and redirects to `/login`, with the way back, on no read. A URL that names no item redirects at once: `/fs/<owner>/<mount>/root`, `/shared/by-me`, and `/shared/with-me` without `pid`. So a private item behaves as today. `RequestAccessView` sends a person with no login to the login page, the way the guard does, so they never see the Request access form, which needs an account; that covers a visitor whose link closes while the page is open. The top bar's **Log in** button keeps the page as the way back (`loginLocation`). The guard runs only on the way into a route (TanStack's cause is `enter` or `preload`, not `stay`), so a search change or a move to another item of the same route asks nothing again, on every link route; the API refuses what the link does not cover. A refused read inside a route shows `RequestAccessView`, and Drive's `shared.$to` shows an empty read-only list for a private `pid`.
- **"Visitor" is "no user"**, read from `useAuth()` in the seams that have a guest case today or serve every app. `useCommentLifecycle` shows the cards and runs no thread, index or member query, and `useIsCardDeleted` does not read a visitor's missing chat folder as every thread gone. `useCollabDoc` opens no socket for them, so nothing about the visitor is sent. `useDriveActionsFor` keeps Open, and `useFileActions` keeps Quick preview and a plain file's Download. The history and watch queries are off, and Watch, the sharing section and, on a lone file's page, the close button are not drawn. `FileMenu` keeps only the editor's own rows, which is Page setup and Print in Docs and Page setup in Slides, and no menu elsewhere; Download goes as a whole, Vector's SVG included. Docs' Print is the browser's own for a visitor, since the PDF comes from the export route. `EigenDocEditorRoute` mounts no share dialog, `useCommentsColumn` and the Stickies board offer no Activity, and the top bar shows the document's name. The guard does not run for another document in the same route, which is a `stay`: the API refuses it, and the editor route sends a visitor to log in through `RequestAccessView`.
- **A lone file.** With no user the shared route leaves `useSharedPaths` off (it takes `skipToken` for an empty owner id) and gives `DriveLayout` the one file from `usePathInfo` as its list, read-only, with the file's name as the title. The visitor sees one row with the file open beside it, and the quick look works.

Who sees what on the one URL:

| Caller | Sees |
|---|---|
| A member, signed in | The full app, as today |
| Signed in, not a member, a guest included | The reader view `public-read` gives today |
| No login, public item | The visitor view |
| No login, private item | The login page, as today |

A visitor gets no event stream and no socket, so an open folder does not update by itself, and an open document shows new edits only when its tab is shown again or reloaded.

## What a visitor sees

Visitors see the item as it is stored. In a document that includes its comment cards: title, description, attachments, the author's address and the time, because a card lives in the Y.Doc (`writeCardToDoc`). On a stickies board the cards are the board. They also see the owner's name and avatar, since `/p/users` and `/p/avatar` are public and the owner id is in the URL. Visitors see no live edits, and they do not see the replies under a comment, the access list, the history, the versions or who is online. A visitor downloads a plain file. A document is to view, and to print where its editor prints. [ROADMAP.md](../ROADMAP.md) has a P2 row for the card's author and content in the document.

## The share dialog

**General access** in `DriveAccessListEdit` is one dropdown with three choices, Google's way: **Restricted**, **Anyone signed in with the link** (with its **Can view** or **Can edit** beside it), and **Anyone with the link**, which is view only. There is no separate section and no switch. The choice waits for **Save** like every other change in the dialog. The third choice is offered only on a file, a folder or a collab document while public links are on, which `/p/config` tells the dialog, and on a path that already has the value.

Each choice has its icon and one short line under it, from `GENERAL_ACCESS` in `drive-access-list.tsx`: "Only people with access", "They sign in to open it" and "No sign-in needed". In the dialog the third choice's line is "Anyone on the internet with the link can view", and while public links are off "Public links are turned off on this server, so this link opens nothing."

The read-only `DriveAccessList` and `DriveShareSummary` read the same `GENERAL_ACCESS`, so every place names the three states alike; the summary shows the choice's icon with its name as the tooltip. The read-only list names the stored value without reading the switch, so it says "No sign-in needed" for a public item while public links are off; that is accepted (§ Risks).

**The Admin setting** is one switch, **Allow public links**, in a section of its own, **Public links**, on the **Guest access** page (`apps/admin/src/components/admin/guest-settings.tsx`), between **Open signup** and **Inactivity cleanup**. It saves with the page through `useUpdateServerSettings`. Both settings answer "who from outside gets in", and one switch does not earn a page.

## Lifecycle

| Event | What happens |
|---|---|
| Choose "Anyone with the link" and save | The value is written, the URL is open |
| Choose anything else and save | Closed with the save. An open visitor tab reloads onto the login page at its next fetch |
| Trash | Closed. Restore opens the same URL again |
| Move | A move stays in its mount and keeps the row, so the URL holds. A path moved out of a public folder is closed |
| Copy | A copy gets a new row with the default `private` |
| Delete for good, owner or team deleted | The row or the Home is gone |

No sweep and no cleanup: a link is one value in one row.

## Later

- **Document export for a visitor.** The export route stays closed to a visitor. A visitor's preview miss and a signed-in link-only reader's export run at background priority, so neither holds up members' jobs.
- **A password or a Reset link** need a stored key, a cookie and an unauthenticated entry route. The `visibility` value stays.
- **A page of its own for a lone file.**

## Where the design bends

1. **Not an option on `auth`, a second macro, and a third under it.** One macro has one resolve type, and `auth: true` must keep handing out `user: User`. `linkAuth` needs `optionalAuth` below it to read the user in its header hook.
2. **A reader who is not live gets the document over HTTP, not the socket.** On the socket every ask for the whole document makes the server encode it on its event loop, so a socket for every reader a link lets in would let each of them ask as often as they like. So the socket is members' again and every other reader loads the stored state from a read route, at the price of no live edits for them ([COLLAB.md](../COLLAB.md#without-a-socket-the-editor-shows-the-state-it-fetched)).
3. **Print for a visitor is the editor's own print**, which only Docs has today ([ROADMAP.md](../ROADMAP.md), P2).

## Risks, and what is accepted

- **The URL is a bearer token, and only choosing another General access closes it.** URLs travel: browser history, chat previews, forwarded mails. Choosing the link again, a restore from the trash, turning the setting off and on, or a backup restore from when it was public all open the same URL.
- **A visitor learns the id of the folder a public item sits in**, from the item's `parentId`, as a signed-in sharee does. It opens nothing while that folder is private. Accepted, for one chain rule on both sides.
- **A move tells a shared folder's readers the id of the folder on the other side.** A file moved between a private folder and a shared one carries the private folder's id in its history line and its live event, as every path carries its `parentId`. Those readers can open that folder once it is public. Accepted.
- **Ids are in logs.** Caddy's access log, the `[slow]` line in `app.ts` and `[collab] open path=` in `routes/collab.ts` hold path ids, which now open a public item.
- **A reader who is not live loses a document's raw databases and its copy**, and is still offered Copy to… ([ACL.md](../ACL.md#a-public-link-opens-a-path-to-anyone-without-a-login)).
- **A guest account reads more than a visitor.** With open guest sign-up anyone can make one and then read the member list and the comment threads of a public item, as `public-read` allows today. Accepted.
- **Any request without a login opens the Home its URL names** on every opt-in route. Only the per-IP limit in `app.ts` stands in front, and it counts each request, so many addresses each open the Home and read a few rows. Accepted for this version. A large public document's builds are in [COLLAB.md](../COLLAB.md#a-reader-who-is-not-live-loads-the-stored-state-over-http).
- **A public SVG in a document's media shows the pictures beside it.** An SVG's preview builds in the images it names only when it sits directly in a collab document's `media/` folder, and only siblings whose stored type is an image ([PREVIEWS.md](../PREVIEWS.md#an-svg-builds-in-only-the-images-beside-it-in-a-documents-media)). A visitor gets that same preview, and a link opens that folder only through its document, which opens those images anyway. A loose SVG anywhere else builds in nothing. Accepted: one preview per file.
- **A visitor's open tab sees new edits up to 30 s late**, and a hidden tab none until it is shown ([COLLAB.md](../COLLAB.md#without-a-socket-the-editor-shows-the-state-it-fetched)). Accepted for a reader who can't edit.
- **A public file can be hotlinked** from another site. The inline routes serve only inert types without the sandbox CSP (`servedFileHeaders`, [PREVIEWS.md](../PREVIEWS.md#a-stored-file-goes-out-inline-without-a-sandbox-only-when-its-type-is-inert)).
- **A closed link reaches an open visitor tab at its next fetch**, which reloads it. Until then it keeps showing what it loaded.
- **The socket's text frames depend on a patch.** Elysia JSON-parses a text frame before the `message` handler runs, and `patches/elysia@1.4.30.patch` removes that step. An Elysia upgrade drops the patch silently, and `collab-ws-text-frames.test.ts` fails when it is missing ([CONTRIBUTING.md](../CONTRIBUTING.md#dependency-patches)).
- **Old copy events keep their source.** A `copied` history row written before this change still holds the original's owner, mount and path id; new rows hold none.
- **Shared by me leaves out an item that is only public.** It lists items with an ACL entry, and a link is none.
- **The read-only access list says "No sign-in needed" while public links are off.** `DriveAccessList`, in the details pane and a viewer's Share dialog, names the stored value and does not read the switch.
- **A child of a public folder says Restricted in its own dialog.** General access shows the path's own value, and the link sits on the folder above.

**What breaks.** No existing data changes. `'link'` is a new stored value. On a rollback to an older build a public path is closed, since that build's check does not know the value, and its share dialog shows the path as signed-in view and can't save it until another General access is chosen.

## The work

Files and folders first, then documents. **The setting is the gate.** Unit 1 adds `sharing.publicLinks` with the default off and no way to save it, so until unit 6 `Drive.updateACLDelta` refuses `'link'` and `LinkDrive` refuses every path: no link exists and no route answers without a login, whatever has merged. The route schema can't be the gate, because `_visibilitySchemaMatchesType` in `routes/drive-sharing.ts` holds it equal to `DriveVisibility`, so it gains `'link'` with the type in unit 1. Tests live in `<workspace>/src/test/`, written red first, and turn the setting on in the store.

| # | Unit | Files | Size | Risk seam | Tests |
|---|---|---|---|---|---|
| 1 | The value, the switch, the rule | `types/drive-access.ts`, `types/settings.ts`, `server-settings.ts`, `acl.ts`, `Drive.updateACLDelta`, the ACL route's schema | S | Yes: an ACL check, a stored value | `test/acl/link-rule.test.ts`: the path, a descendant, a private subfolder, a sibling, the parent, the trash, the switch, the demo, each allowed and refused type, inside a document only `media/`; a signed-in non-member reads and can't write; the refusals of `updateACLDelta`, the default included |
| 2 | Files and folders without a login | `link-drive.ts`, `get-drive.ts`, `routes/auth.ts`, `drive.ts`, `drive-content.ts`, `drive-sharing.ts`, `scripts/check-standards.ts` | M | Yes: an ACL check, routes that serve bytes without a login | `test/acl/link-routes.test.ts`: each of routes 1–12 serves a public path and answers 403 for a sibling and an unknown id; every other route in the route table answers 401; `acl` is null, the head keeps its `parentId`, the breadcrumb is cut, a listing is filtered; `no-store` and `noindex` without a user; a member is served as before |
| 3 | Documents without a login | `routes/collab.ts`, `use-collab-doc.ts` | M | Yes: who reaches the socket | `test/collab/collab-live-reader.test.ts`: an upgrade without a login is a 401; who is live, a guest named as a viewer included; a reader who is not live is closed with 4403 at open and at the tick; step 1 answers and the size cap; the info route without a login. `collab-state-route.test.ts`: the state of a public document with no deleted text, its ETag and 304, one transform per version at the link reader's priority, and the refusals of a private document, an unknown id, a chat, a plain file, a path inside a document and public links off |
| 4 | The guard and Drive's visitor view | `auth-route.tsx`, Drive's `fs` and `shared.$to` routes, `useDriveActionsFor`, `useFileActions` | M | Yes: routes that leave the guard, seams every app shares | Signed out on a private item, on `root` and on `/shared/*` without `pid` lands on login; the lone-file page; a browser check signed in and out |
| 5 | The editors' visitor view | Five editor routes and root routes, `EigenDocEditorRoute`, `useCommentLifecycle`, `FileMenu`, `topbar.tsx` | M | Yes: the same | The same, per app ([verify-in-browser](../../.claude/skills/verify-in-browser/SKILL.md)) |
| 6 | Open it | The default on, the settings save, `/p/config`, the Admin checkbox, `drive-access-list-edit.tsx`, `drive-access-list.tsx`, `drive-share-summary.tsx`, Caddy's `noindex` | M | Yes: the unit that opens it | `drive-access-dialog.test.tsx`: the three choices, the line under the third, the choice hidden while public links are off and on a chat, a stored link while they are off; `guest-settings.test.tsx`: the switch saves and resets; an editor saves `'link'` and `sharingRestricted` refuses it (`link-rule.test.ts`); end to end from Save to file bytes without a login and back (`link-routes.test.ts`) |
| 7 | Docs | ACL.md, COLLAB.md, GUEST-ACCESS.md, SERVER-SETTINGS.md, ARCHITECTURE.md (the "Route → SharedDrive → Drive → Mount" pitfall names the third wrapper), a help-center article, CHANGELOG | S | No | |

Three notes on the units:

- **Unit 1 ends with a named check**, reported before unit 2 starts: does a path id reach someone without read access through search results, stored notification rows, file-history events, the shared-with-me and recent lists after access was removed, or mentions and links inside documents? The id is the secret now, and these were not traced. The check found one leak, closed in its own commit: a copy's `copied` history event stored the original's owner, mount and path id, which any reader of the copy could read. It also found the move case under Risks.
- **Unit 2 changes the `:ownerId` gate** in `scripts/check-standards.ts`: it matches `auth: true` case-sensitively, so a `linkAuth` route would slip past it.
- **Unit 4 starts by walking Drive's detail pane and quick look without a user.** What it finds there are queries that answer 401, never a leak.

The total is L.

## Needs the owner's yes

One new route, no migration, no package. Each of these adds a route or changes what an existing one takes or answers, and is asked right before it is built:

| Route | Change |
|---|---|
| `PUT /drive/:ownerId/:mountId/path/:pathId/acl` | The body's `visibility` takes `'link'` |
| The settings save in `routes/settings.ts` | The body takes `sharing.publicLinks` |
| `GET /settings/server` and the settings save's answer | They gain `sharing.publicLinks`, with the type, in unit 1 |
| `GET /p/config` | The answer gains `publicLinks` |
| The fourteen read routes | They answer without a login, through `linkAuth` |
| `GET /collab/:ownerId/:mountId/:pathId/state` | New: a document's merged, cached state for any reader, with an ETag. Given |
| `GET /collab/:ownerId/:mountId/:pathId/info` | The answer gains `live`. Given |

## Open questions

None. The words of the three choices and the lines under them are settled, as in § The share dialog.
