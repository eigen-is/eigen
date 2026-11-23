# Proposal: Public links

This proposal lets a user share a file, a folder or a collab document with anyone who has its link. The visitor needs no account and no emailed code: opening the link opens the item, view-only, and a visitor may download what they see. Users ask for this again and again: today the only way to reach someone outside the server is a guest, and a guest needs an email address and a code for every sign-in.

**Status:** not built. [ROADMAP.md](../ROADMAP.md) has its row in P1. Sharing is described in [ACL.md](../ACL.md), guests in [GUEST-ACCESS.md](../GUEST-ACCESS.md), the collab socket in [COLLAB.md](../COLLAB.md). No password, no expiry date, no edit links and no view counter in this version.

> **TLDR:** "Anyone with the link" is a third choice of **General access**, beside **Restricted** and **Anyone signed in**. It is one more value of the path's `visibility`, and nothing else is stored. The link is the item's ordinary URL, the one in the address bar, as with Google. A handful of read routes and the collab socket answer a request that has no login when the path, or a folder above it, has that value. Every other route keeps asking for a signed-in user, so it refuses a visitor without anyone having to remember to. There is no link account, no key, no cookie and no new route. Choosing another General access closes the link at once.

The whole design in one table:

| Concern | The one place | What it does |
|---|---|---|
| The link is on | `visibility: 'link'` on the path | One column, so a path is exactly one of restricted, signed-in or link |
| What it opens | `canReadByLink` in `lib/drive/acl.ts` | The path and what is below it, by an allow-list of types, never a write |
| What a visitor is handed | `LinkDrive` | A read-only wrapper: a few reads, every `acl` emptied |
| Which routes listen | The `linkAuth` macro | Fourteen read routes and the collab socket opt in |
| No presence | `CollabDocument` | A connection without a user is outside awareness |
| The visitor's screen | The item's own route | It renders without a login when the server says "via link" |
| The switch | `sharing.publicLinks` | A boolean in server settings |

## The problem

- **Sharing outside the server needs an email address.** A link on a website, in a newsletter or in a chat group can't name its readers.
- **Every sign-in is a mail round trip.** For "have a look at this PDF" a six-digit code is too much, and a code that lands in spam loses the reader.
- **"Unrestricted" is not public.** The share dialog's **General access** lets "anyone signed in with the link" view. `canFromAncestors` (`apps/api/src/lib/drive/acl.ts`) grants `public-read` and `public-write` to a signed-in user only, and every drive route asks for a session.

## Why not a guest account

The first design made a link a `role: 'guest'` user with a reserved address and a real session. It is dropped. A session opens everything a guest reaches: better-auth's own `/auth/*` routes, every route without `requireNonGuest`, chat notifications, the bell. Keeping a link account out of all of that is a denylist, and a denylist is a place to forget. Here a visitor has no session, so a route has to opt in before it answers one.

## Three candidates, and why one URL wins

| | Key and pass | One URL plus a key | **One URL** |
|---|---|---|---|
| The link | `/<app>/s/…#<key>`, a second URL per item | The ordinary URL plus `#<key>` | The ordinary URL |
| Stored | A `link_<nonce>` ACL entry | The same entry | A `visibility` value |
| Mechanisms on top of the shared ones | Entry kind, key, pass cookie, entry route, a link writer, `/s/` routes | Entry kind, key, pass cookie, entry route | None |
| New routes | 1 without a login, plus the key's way to the dialog | The same | 0 |
| Reset link | Yes | Yes | No |
| Who can open a public item | Whoever was given the link | Whoever was given the link with its key | Whoever knows the item's URL |

The shared ones are the rule, `LinkDrive`, the macro, the opt-in list and the collab change. One URL needs nothing else, and it is what the owner asked for: the link people already share is the public link.

**Is a path id a good enough secret?** Yes for guessing, no for keeping. `Mount` makes every path id with `crypto.randomUUID()` (`apps/api/src/lib/mount/mount.ts`): a version 4 UUID, 122 random bits. The owner id is a 32-character better-auth id or `team_<id>`, and the mount id of a personal drive is the constant `'default'`, so the path id is the secret. Nobody guesses it. But Eigen does not hide ids from people with access nearby: every `DrivePath` carries its `parentId`, and `SharedDrive.ancestorIds` hands a reader the ids of the whole chain. The list below says what that costs.

**What the owner gives up:**

- **No Reset link.** A URL that leaked is closed by choosing another General access, and choosing "Anyone with the link" again brings the same URL back. A fresh URL means a copy of the item. Google has no reset either.
- **A public folder is open to everyone who can already see something in it**, because they know its id. Someone given one file in it can open the rest while the folder is public.
- **A former member keeps a working URL** while the item is public. They had access, and the item is public by the owner's choice.

If one of these is not acceptable, the middle column is the fallback: the same URL shape and a key behind `#`, at the price of the entry kind, the cookie and one unauthenticated route.

## The value

`DriveVisibility` (`packages/lib/src/types/drive-access.ts`) gains `'link'`. It is stored in the `visibility` TEXT column that exists (`apps/api/src/lib/mount/schema.ts`), so there is no migration, and the one-of-three rule needs no code: one column holds one value.

| Choice in the dialog | `visibility` | A signed-in user who is not a member | No login |
|---|---|---|---|
| Restricted | `private` | No access | No access |
| Anyone signed in with the link | `public-read`, `public-write` | Reads or edits, as today | No access |
| Anyone with the link | `link` | The visitor view | The visitor view |

**It travels on the existing ACL route.** `PUT /drive/:ownerId/:mountId/path/:pathId/acl` already takes `visibility`, the dialog already sends it on Save through `useUpdateACL`, and `SharedDrive.updateACLDelta` already checks write and `sharingRestricted`. So an editor may publish a link under the same rule as any sharing change, and no new route or hook is needed. The copy-link icon copies `getDriveShareUrl(path)` as it does today.

**One place refuses it.** `Drive.updateACLDelta` answers 403 for `'link'` when `sharing.publicLinks` is off, and 400 on a chat, on a path inside a document, and on anything that is not a file, a folder or a collab document. The mount root is refused already. It reads the path with `getActivePath`, which checks only the path's own `trashedAt`; the rule below checks the whole chain, so a value saved under a trashed folder opens nothing.

**`'link'` grants a signed-in user nothing.** `grantsPublicRead` stays as it is, so `canFromAncestors` treats `'link'` like `private`. Otherwise anyone with a guest account would read the comment threads and the access list of every public item. The other readers of `visibility`:

| Reader | With `'link'` |
|---|---|
| `checkAccessForEmails` (`lib/drive/sharing.ts`) | Reports no read for a non-member, which is right: they would get the visitor view |
| `findChatsByMembers` (`lib/chat/find-by-members.ts`) | Skips a non-private chat. A chat can't be `'link'` |
| `drive-actions.ts`, **Email collaborators** | Shows the row on a public item with no members, where it mails nobody. Harmless |
| `DriveShareSummary`, `DriveAccessList`, `DriveAccessListEdit` | Name the third state. The dialog unit changes them |

## What a link opens

`canReadByLink(chain, enabled)` sits beside `canFromAncestors` in `acl.ts` and is the whole visitor rule. It is pure: the caller passes the setting in. It takes the path's breadcrumb and answers the index of the public path in the chain, or nothing:

1. `enabled` is true.
2. No path in the chain is in the trash (`isTrashedChain`).
3. Some path in the chain has `visibility: 'link'`. So a folder's link covers what is below it, and nothing beside or above it.
4. The allow-list: from the public path down, every step is a folder, and the last may also be a file or a collab document (`isCollabType`). Past a collab document the chain may only go on into its `media/` folder and a file in it. Anything else is refused: a chat, a document's `data.db`, `comments.db`, comment threads and versions, and any path type added later.

There is no write variant: a visitor can't write because no code asks.

`LinkDrive` (`apps/api/src/lib/drive/link-drive.ts`) wraps the owner's `Drive` by composition, as `SharedDrive` does, with these methods only: `getPath`, `getFolderContents`, `breadCrumb`, `resolveFile`, `downloadFile`, `readRange`, `getCollabDocument`, `canRead`, `canWrite`, `holdHome` and `withHomeHeld`. Each runs the rule first, so `getPath` refuses a chat row too. Every refusal is the same 403, for a path that does not exist and one that is not public. Every `DrivePath` it returns has `acl: null`, a breadcrumb starts at the public path, and a folder listing holds only what the rule admits. `canRead` and `canWrite` take and ignore the user argument, the `_user` convention `shared-drive.ts` documents, and `canWrite` answers false. So the three drives share their signatures and a route needs no `instanceof`.

## The principal is no user

A visitor is "no user". It is not a `User`: a stand-in like `makeSyntheticUser` would flow into `getSharedDrive` (which hands out the raw `Drive` when the owner id equals the user id), `getMemberships`, `recordOpened`, the awareness check and every `actor` argument. A visitor has no Home, so `home-relay.ts` never comes into it: the request opens only the Home its URL names.

`routes/auth.ts` gets a second macro beside `auth`:

| Macro | Resolves | Without a session |
|---|---|---|
| `auth: true`, unchanged | `user: User`, `session` | 401 |
| `linkAuth: true`, new | `user: User \| null`, `session` or null | Goes on, as a visitor |

A route fails closed in two ways. A route nobody touched still says `auth: true`. And a `linkAuth` handler holds a `User | null`, which `getSharedDrive` does not take: it calls `getReadDrive(ownerId, mountId, pathId, user)` in `lib/drive/get-drive.ts`. That answers the drive and `viaLink`: a user who can read the path themselves gets their own drive as today, and everyone else gets a `LinkDrive`. A handler can call only the methods all three drives have.

## The routes that opt in

Each resolves its path through `getReadDrive`, so each runs the rule on the path id in its own URL.

| Route | File | Reads through |
|---|---|---|
| `GET /drive/:ownerId/:mountId/path/:pathId` | `routes/drive.ts` | `getPath` |
| `GET /drive/:ownerId/:mountId/folder/:pathId` | `routes/drive.ts` | `getFolderContents` |
| `GET /drive/:ownerId/:mountId/path/:pathId/breadcrumb` | `routes/drive.ts` | `breadCrumb` |
| `GET /drive/:ownerId/:mountId/path/:pathId/permissions` | `routes/drive-sharing.ts` | `canRead`, `canWrite`; gains `viaLink` |
| `GET /drive/:ownerId/:mountId/file/:pathId/download` | `routes/drive.ts` | `resolveFile`, with ranges |
| `GET /drive/:ownerId/:mountId/file/:pathId/embed/:fileName` | `routes/drive-content.ts` | `resolveFile`, with ranges |
| `GET …/file/:pathId/preview`, `text-preview`, `vcard-preview`, `eml-preview`, `ics-preview` | `routes/drive-content.ts` | `resolveFile` |
| `GET /drive/:ownerId/:mountId/thumb/:fileName` | `routes/drive-content.ts` | `resolveFile` |
| `GET /collab/:ownerId/:mountId/:pathId/info` | `routes/collab.ts` | `canRead`, `canWrite`, `getPath`, `getFolderContents`; gains `viaLink` |
| `WS /ws/collab/:ownerId/:mountId/:pathId` | `routes/collab.ts` | `canRead`, `getCollabDocument` |
| `GET /drive/:ownerId/:mountId/file/:pathId/export/:format` | `routes/drive-content.ts` | `resolveFile`; Download and Print of a document |

Everything else stays closed, by saying `auth: true`: effective members, the ACL route, `GET …/history`, the version list, every chat route with its messages, the comment index (`/collab/…/comments` and `/comments/search`), notifications, SSE, search, recent, shared with me, watches, request access, email collaborators, mounts, the root folder, the inline editor's content and every write. One test walks the app's route table and holds it against the list above, so a new route is closed until someone adds it there.

Why no cookie and no entry route: a visitor's request needs nothing to carry. An `<img>`, a media request and the socket are plain requests to the item's URL, so there is no credential to thread into them and none to leak through `Referer`. The file routes already answer `Cache-Control: private`. The macro adds `X-Robots-Tag: noindex` for a request without a user, and Caddy sets it on the app pages.

A document refers to its pictures by name in its own `media/` folder ([MEDIA-REFERENCES.md](../MEDIA-REFERENCES.md)), which the link covers. A file attached by id that lives outside the public path does not open for a visitor. That is accepted.

## Collab

- **Read-only.** `canWrite` is false, and `CollabDocument.handleMessage` already drops a reader's sync step 2 and updates.
- **No awareness, either way.** `CollabDocument.subscribe` takes `User | null`, and a `viaLink` socket subscribes as `null`, signed in or not. Inbound awareness is dropped by the check that is there (`if (!user) return`). Two sends learn the same rule: `sendSyncStep1` skips the awareness states, and the awareness `update` handler sends only to connections with a user.
- **`recordOpened` is skipped** for a `viaLink` socket.
- **The keepalive.** `checkAccess` in `routes/collab.ts` is built on `ws.data.session.id` and `getSessionUser`. That stays for a socket that opened as a user. A `viaLink` socket has no session to check, so every 15 s it asks only `LinkDrive.canRead` for its path again:

| What happened | The next tick |
|---|---|
| Another General access is saved | No path in the chain is `'link'`: close 4403 |
| `sharing.publicLinks` is turned off | The rule's `enabled` is false: close 4403 |
| The path or a folder above it is trashed | `isTrashedChain`: close 4403. The trash itself closes the document first ([SOFT-DELETE.md](../SOFT-DELETE.md)) |
| The path is moved out of a public folder | Its chain no longer holds the folder: close 4403 |

A socket keeps the kind it opened with. A member who is removed from a public document gets 4403 on their own check, the tab reloads, and the reload opens as a visitor.

## The frontend

What the apps do today, read from the code:

- `AuthProvider` (`packages/lib/src/core/auth/auth-context.tsx`) reads `authClient.getSession()` once and holds `user: AuthUser | null`.
- Every app's `_auth.tsx` is `createAuthRouteOptions()` (`packages/ui/src/components/layout/pages/auth-route.tsx`): no user means a redirect to `/login`, and child routes get a user in their context. `_auth` is a layout without a URL segment.
- The five editor routes (`_auth.doc.…`, `_auth.sheet.…`, `_auth.slide.…`, `_auth.vector.…`, `_auth.board.…`) never read that context user. Each renders `EigenDocEditorRoute`, which loads `useCollabDocumentInfo` and shows `RequestAccessView` when the answer is no read. The editors take `user: AuthUser | null` from `useAuth()`.
- Drive's folder route (`_auth.fs.…`) reads the context user once, and asks `useCanWriteFolder`, which calls the permissions route. A plain file's link today is the Shared with me page with the file selected (`getDriveShareUrl`), on `_auth.shared.$to.tsx`.
- The shell has a signed-out state: `Topbar` draws the logo and a **Log in** button and no app switcher, palette, bell or account menu, and `EigenDocRoot` and Drive's root route give no sidebar without a user.

The smallest change, with no new route and no second URL:

- **Seven route files leave `_auth`**: the five editor routes and Drive's `fs` and `shared.$to`. The URLs stay the same. Each app's root route and the file itself name the new route id, and Drive's two take their user from `useAuth()`.
- **`RequestAccessView` sends a signed-out caller to `/login`** with the way back, which is what the guard did for these routes. So a private item behaves as today.
- **The server says who is a visitor.** The info and permissions answers carry `viaLink`. `EigenDocEditorRoute` and Drive's two routes put it in `LinkVisitorProvider` (`packages/lib/src/core/drive/link-visitor.tsx`, in lib because ui imports lib and never the reverse), and `useIsLinkVisitor()` (`packages/lib/src/core/drive/hooks/use-link-visitor.ts`) reads it.
- **Four shared seams read the hook**, each with a guest case today or shared by every app: `useCommentLifecycle` shows the cards and runs no thread, index or member query; `useDriveActionsFor` and `useFileActions` keep Open and Download; `FileMenu` keeps Download and Print. `EigenDocEditorRoute` mounts no share dialog for a visitor, and the top bar shows the document's name.

Who sees what on the one URL:

| Caller | Sees |
|---|---|
| A member, signed in | The full app, as today |
| Signed in, not a member | The visitor view: the server answers through `LinkDrive` |
| No login, public item | The visitor view |
| No login, private item | The login page, as today |

Against the six `/s/` routes of the key design this is seven renames and one changed view, and it drops the key page, the second URL builder and the entry hook.

A visitor gets no event stream, so an open folder does not update by itself. An open document does, through its socket. A visitor who opens a lone file gets the Shared with me page with an empty list and the file open beside it.

## What a visitor sees

Visitors see the item as it is stored. In a document that includes its comment cards: title, description, attachments, the author's address and the time, because a card lives in the Y.Doc (`writeCardToDoc`). On a stickies board the cards are the board. They also see the owner's name and avatar, since `/p/users` and `/p/avatar` are public and the owner id is in the URL. Visitors do not see the replies under a comment, the access list, the history, the versions or who is online. [ROADMAP.md](../ROADMAP.md) has a P2 row for the card's author and content in the document.

## The share dialog

**General access** in `DriveAccessListEdit` becomes one control with three choices, Google's way: **Restricted**, **Anyone signed in with the link** (with its **Can view** or **Can edit**), and **Anyone with the link**, which is view only. There is no separate section and no switch. The choice waits for **Save** like every other change in the dialog, and is hidden when `sharing.publicLinks` is off, which `/p/config` tells the dialog. Under the third choice one sentence: "Anyone with the link can view and download this without signing in. They also see its comments and who wrote them, but not the replies, the history or who has access." The choice shows only on a file, a folder or a collab document. The read-only `DriveAccessList` and `DriveShareSummary` name the third state.

The Admin app's **Guest access** page gets one checkbox, **Allow public links**, saved through `useServerSettings`. Off, no new link can be made and every existing one is closed. The values stay stored, so turning it on again opens them.

## Lifecycle

| Event | What happens |
|---|---|
| Choose "Anyone with the link" and save | The value is written, the URL is open |
| Choose anything else and save | Closed with the save. Open sockets close within 15 s |
| Trash | Closed. Restore opens the same URL again |
| Move | A move stays in its mount and keeps the row, so the URL holds. A path moved out of a public folder is closed |
| Copy | A copy gets a new row with the default `private` |
| Delete for good, owner or team deleted | The row or the Home is gone |

No sweep and no cleanup: a link is one value in one row.

## Later

- **A password** does not fit as it stands. A visitor would have to prove they know it on every request, which means the cookie and the entry route this design leaves out, and a stored check beside the value. The `visibility` value stays.
- **Reset link** is the middle candidate: a key behind `#` on the same URL.

## Where the design bends

1. **No Reset link**, though the dialog ruling named one. It needs a stored key, and the key needs the cookie and the entry route.
2. **The secret is the path id, which Eigen does not hide** from people with access at or under the item (`parentId`, `ancestorIds`). The three costs are under "What the owner gives up".
3. **Not an option on `auth`, a second macro.** One macro has one resolve type, and `auth: true` must keep handing out `user: User`.
4. **One fallback in `getReadDrive`:** a signed-in user who can't read the path gets the `LinkDrive`. Without it a signed-in non-member would be refused an item an anonymous browser can open.
5. **A lone plain file has no page of its own.** Its URL today is the Shared with me page, so that is what a visitor gets, with an empty list. A file page is later work.

## Risks, and what is accepted

- **The URL is a bearer token**, and URLs travel: browser history, chat previews, forwarded mails, and Caddy's access log, which holds the path id of every request.
- **Only choosing another General access closes a link, and nothing makes a new one.** Choosing it again, a restore from the trash, turning the setting off and on, or a backup restore from when it was public all bring the same URL back.
- **Any request without a login opens the Home its URL names** on every opt-in route, and a visitor's socket holds a document open. Only the per-IP limit in `app.ts` stands in front. Accepted for this version.
- **An anonymous visitor can queue exports.** The transform queue bounds them ([DOCUMENT-TRANSFORMS.md](../DOCUMENT-TRANSFORMS.md)).
- **A public file can be hotlinked** from another site. The inline routes already sandbox scriptable types (`scriptableInlineHeaders`).
- **Up to 15 s.** After a link is closed an open document still receives edits until the next keepalive, as after any revoke.
- **The demo server** lets anyone upload. Turn the setting off there.

**What breaks.** No existing data changes. `'link'` is a new stored value. On a rollback to an older build a public path is closed, since that build's check does not know the value, and its share dialog shows the path as signed-in view and can't save it until another General access is chosen.

## The work

Files and folders first, then documents. Until unit 6 the ACL route's schema refuses `'link'`, so no client can make a public path and nothing that merges earlier can expose anything; for the same reason no half-built dialog ever shows one. Tests live in `<workspace>/src/test/`, written red first, and before unit 6 they write the value through `Drive.updateACLDelta`.

| # | Unit | Files | Size | Risk seam | Tests |
|---|---|---|---|---|---|
| 1 | The value, the setting, the rule | `types/drive-access.ts`, `types/settings.ts`, `server-settings.ts`, `routes/settings.ts`, `acl.ts`, `Drive.updateACLDelta` | S | ACL check, a stored value | `test/acl/link-rule.test.ts`: the path, a descendant, a sibling, the parent, the trash, the setting, each allowed and refused type, inside a document only `media/`; `'link'` gives a signed-in non-member nothing; the refusals of `updateACLDelta` |
| 2 | Files and folders without a login | `link-drive.ts`, `get-drive.ts`, `routes/auth.ts`, `drive.ts`, `drive-content.ts`, `drive-sharing.ts`, `scripts/check-standards.ts` | M | ACL check, routes that serve bytes without a login | `test/acl/link-routes.test.ts`: each opt-in route serves a public path and answers 403 for a sibling and an unknown id; every other route in the route table answers 401; `LinkDrive` empties every `acl`, cuts the breadcrumb, filters a listing; a member is served as before |
| 3 | Documents without a login | `collab-document.ts`, `routes/collab.ts`, the export route | M | `CollabDocument.subscribe` and its broadcast, bytes without a login | `test/collab/collab-link-visitor.test.ts`: a `null` connection gets no awareness at sync or after, its awareness and updates are dropped, document updates reach it; each row of the keepalive table closes within one tick; no Recent row |
| 4 | Drive's visitor view | `RequestAccessView`, `link-visitor.tsx`, `use-link-visitor.ts`, `useDriveActionsFor`, `useFileActions`, Drive's `fs` and `shared.$to` routes | M | Seams every app shares, a route that leaves the guard | Hook and component tests; signed out on a private item still lands on login; a browser check signed in and out |
| 5 | The editors' visitor view | Five editor routes and root routes, `EigenDocEditorRoute`, `useCommentLifecycle`, `FileMenu`, `topbar.tsx` | M | Seams every app shares, routes that leave the guard | The same, per app ([verify-in-browser](../../.claude/skills/verify-in-browser/SKILL.md)) |
| 6 | The dialog and the Admin checkbox | The ACL route's schema, `/p/config`, `drive-access-list-edit.tsx`, `drive-access-list.tsx`, `drive-share-summary.tsx`, `apps/admin` **Guest access**, Caddy | M | The unit that opens it | Dialog tests for the three choices and the setting; the route accepts `'link'` from an editor and refuses it under `sharingRestricted`; end to end from Save to file bytes without a login |
| 7 | Docs | ACL.md, COLLAB.md, GUEST-ACCESS.md, ARCHITECTURE.md, SERVER-SETTINGS.md, a help-center article, CHANGELOG | S | No | |

Unit 2 changes the `:ownerId` gate in `scripts/check-standards.ts`: it matches `auth: true` case-sensitively, so a `linkAuth` route would slip past it. Unit 4 starts by walking Drive's detail pane and quick look without a user; what it finds there are queries that answer 401, never a leak. The total is L.

## Needs the owner's yes

No new route, no migration, no package. Each of these is a change to what an existing route takes or answers, asked right before it is built:

| Route | Change |
|---|---|
| `PUT /drive/:ownerId/:mountId/path/:pathId/acl` | The body's `visibility` takes `'link'` |
| `GET /collab/:ownerId/:mountId/:pathId/info` | The answer gains `viaLink` |
| `GET /drive/:ownerId/:mountId/path/:pathId/permissions` | The answer gains `viaLink` |
| `GET /p/config` | The answer gains `publicLinks` |
| The settings save in `routes/settings.ts` | The body takes `sharing.publicLinks` |
| The fourteen read routes and the socket | They answer without a login, through `linkAuth` |

## Open questions

1. **No Reset link, and the item's own URL as the secret. Accepted?** Recommended: yes, it is the one-URL wish and the smallest design. If not, the middle candidate.
2. **Default of `sharing.publicLinks`?** Recommended: on, and on for eigen.is. Off on the demo server.
3. **A signed-in non-member, a guest included, gets the visitor view on a public item. Fine?** Recommended: yes.
4. **A lone file opens on the Shared with me page for a visitor. Enough for now?** Recommended: yes, with a file page as a later row.
5. **The words of the three choices.** Recommended: Restricted, Anyone signed in with the link, Anyone with the link. Decide on screenshots.
