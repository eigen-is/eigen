# Proposal: Public links

This proposal lets a user share a file, a folder or a collab document with anyone who has the link. The visitor needs no account and no emailed code: opening the link opens the item. A link is view-only, a visitor may download what they see, and the owner can add a password, turn the link off or reset it. Users ask for this again and again: today the only way to reach someone outside the server is a guest, and a guest needs an email address and a code for every sign-in.

**Status:** not built. [ROADMAP.md](../ROADMAP.md) has its row in P1. Sharing is described in [ACL.md](../ACL.md), guests in [GUEST-ACCESS.md](../GUEST-ACCESS.md), the collab socket in [COLLAB.md](../COLLAB.md). No expiry date, no edit links and no view counter in this phase.

> **TLDR:** A link is one more entry in the path's access list: `link_<id>`, read only. It is not a user. There is no account, no session and no row anywhere else, so there is nothing to clean up. Opening the link's URL trades the key in the URL for a cookie, the pass, which only says "this browser may view this one path". A small set of read routes and the collab socket accept a pass. Every other route keeps asking for a signed-in user, so it refuses a visitor without anyone having to remember to. The server checks the pass against the entry on every request, so removing or changing the entry ends every visitor at once. Nothing stored is secret: the key and the pass are computed from the entry with the server's secret.

The whole design in one table:

| Concern | The one place | What it does |
|---|---|---|
| The link exists | A `link_…` entry in the path's `acl` | On, off, reset and the password are all that one string |
| Who may write it | `Drive.setLink` | The only writer. The ACL route refuses a delta that names a link |
| Key and pass | `lib/drive/link-pass.ts` | Computes both from the entry, reads and sets the cookie |
| What a pass opens | `canReadByLink` in `lib/drive/acl.ts` | The linked path and what is below it, never a write |
| What a visitor is handed | `LinkDrive` | A read-only wrapper: a few reads, every `acl` emptied |
| Which routes listen | The `linkAuth` macro | Thirteen read routes and the collab socket opt in |
| No presence | `CollabDocument` | A connection without a user is outside awareness |
| The visitor's screen | `LinkView` in `packages/ui` | An `/s/` route per app, the editor read-only inside it |

## The problem

- **Sharing outside the server needs an email address.** A link on a website, in a newsletter or in a chat group can't name its readers.
- **Every sign-in is a mail round trip.** For "have a look at this PDF" a six-digit code is too much, and a code that lands in spam loses the reader.
- **"Unrestricted" is not public.** The share dialog's **General access** lets "anyone signed in with the link" view. `canFromAncestors` (`apps/api/src/lib/drive/acl.ts`) grants `public-read` and `public-write` to a signed-in user only, and every drive route asks for a session.

## Why not a guest account

The first design made a link a `role: 'guest'` user with a reserved address and a real session. It is dropped. A session opens everything a guest reaches: better-auth's own `/auth/*` routes, about seventy routes with no `requireNonGuest`, chat notifications, the bell. Keeping a link account out of all of that is a denylist, and a denylist is a place to forget. This design turns it around: a visitor has no session, so a route has to opt in before it answers one.

## The entry

A link is a `DriveACL` entry (`packages/lib/src/types/drive-access.ts`) with an id of its own kind. The type and the `acl` JSON column (`apps/api/src/lib/mount/schema.ts`) keep their shape:

```json
[{ "id": "ann@example.com", "read": true, "write": true }, { "id": "link_5f2c…e1", "read": true, "write": false }]
```

| Link | Entry id |
|---|---|
| Without a password | `link_<nonce>`, the nonce 32 random hex characters |
| With a password | `link_<nonce>.<check>`, the check an HMAC of the nonce and the password |

A path has at most one link entry. A **reset** writes a new nonce. A password that is added, changed or removed writes a new check or drops it. So every change to a link changes the id, and nothing else has to be stored: no revoke value, no hash column.

Three helpers in `drive-access.ts` are the one fact about the kind: the `LINK_ACL_PREFIX` constant, `findLinkEntry(acl)` and `linkHasPassword(entry)`. The API and the share dialog both import them.

**The entry is inert for every signed-in user.** `matchesACL` matches only what `parseOwnerId` calls a user or a team, and `link_…` parses as `invalid`, so no account ever gets access through it. `resolveACLUserIds` skips it the same way, so nothing is pushed or written to the share registry. Two existing lines need a change, both in the first unit:

- `Drive.updateACLDelta` runs `validateACLEntries` on the merged ACL, which would refuse every later change on a path that has a link. It validates the delta's `add` and `remove` ids instead. That is also how a client is refused: a delta that names a `link_…` id is a 400.
- `resolveACLToEmails` (`apps/api/src/lib/drive/acl-propagation.ts`) treats every id that is not a team as an email address. It takes users only, or a link would show as a member and be mailed.

**One method writes it.** `Drive.setLink(mountId, pathId, { enabled, password?, reset? }, actor)` runs in the same `runInOrder('acl:<mount>:<path>')` chain as `updateACLDelta`, so a link change and a people change on one path can't undo each other. It reads the path with `getActivePath`, so a path in the trash is a 404. It refuses the mount root, a path inside a document and a standalone chat, and follows the `sharing.publicLinks` setting. It emits `DRIVE_ACL_UPDATED` and pushes to no home, since a link has no recipient. `SharedDrive.setLink` is its wrapper with the checks `SharedDrive.updateACLDelta` makes: write on the path, then `sharingRestricted`. The route refuses a guest with `requireNonGuest`.

## Key and pass

Both are HMAC-SHA256 values over the server's auth secret, built the way `signInWithScopedPassword` (`apps/api/src/lib/auth/guest-auth.ts`) builds its scoped password: `new Bun.CryptoHasher('sha256', auth.options.secret)`. No new package. One file, `apps/api/src/lib/drive/link-pass.ts`, holds them:

| Value | Computed from | Changes on |
|---|---|---|
| Key, in the URL | owner, mount, path and the nonce | A reset |
| Check, in the entry id | the nonce and the password | A reset or a password change |
| Pass, in the cookie | owner, mount, path and the whole entry id | Any change to the link |

So a password that is added later keeps the URL people already have, and everyone who got in before it is out.

The pass is a cookie named `eigen_link_<pathId>`, `HttpOnly`, `Secure`, `SameSite=Lax`, with a 30-day `Max-Age`. It holds nothing but the HMAC: no payload to parse and no expiry inside. Several links are several cookies, and they sit beside a login's session cookie without touching it. The server never trusts the cookie alone: on every request it recomputes the pass from the entry the path holds now and compares in constant time. An entry that is gone or changed means the cookie matches nothing.

## What a pass opens

`canReadByLink(chain, passes)` sits beside `canFromAncestors` in `acl.ts` and is the whole visitor rule. It takes the path's breadcrumb and the request's pass cookies and answers the index of the link's path in the chain, or nothing:

1. No folder in the chain is in the trash (`isTrashedChain`).
2. Some path in the chain has a link entry, and the cookie named after that path equals its pass. So a folder's link covers everything below it, and a pass for X opens no sibling of X: a sibling's chain doesn't hold X.
3. Inside a collab document the chain may go on only into its `media/` folder. That keeps out `data.db`, `comments.db`, the comment threads in `chat/` and the version snapshots. Inside a chat it goes nowhere.
4. `sharing.publicLinks` is not `'off'`, and under `'password'` the entry has a check.

It never looks at `visibility`, and there is no write variant: a pass can't write because no code asks.

`LinkDrive` (`apps/api/src/lib/drive/link-drive.ts`) wraps the owner's `Drive` the way `SharedDrive` does, by composition, with these methods only: `getPath`, `getFolderContents`, `breadCrumb`, `resolveFile`, `downloadFile`, `readRange`, `getCollabDocument`, `canRead`, `holdHome` and `withHomeHeld`. Each runs the rule first. Every `DrivePath` it returns has `acl: null`, a breadcrumb starts at the link's path, and a folder listing leaves out what rule 3 closes and every chat. That is the one place a visitor's answers are trimmed.

## The principal is no user

A visitor is "no user, plus the request's pass cookies". It is not a `User`. `User` is better-auth's session user (`apps/api/src/lib/user/user.ts`), and `makeSyntheticUser` shows what a stand-in costs: a fake id that flows into `getSharedDrive` (which hands out the raw `Drive` when the owner id equals the user id), `getMemberships`, `recordOpened`, the awareness check and every `actor` argument. A visitor has no Home, so `home-relay.ts` never comes into it: the request opens only the Home its URL names.

`routes/auth.ts` gets a second macro beside `auth`:

| Macro | Resolves | Without a session |
|---|---|---|
| `auth: true`, unchanged | `user: User`, `session` | 401 |
| `linkAuth: true`, new | `user: User \| null`, `session`, `passes` | 401 unless a pass cookie is there |

A route fails closed in two ways. A route nobody touched still says `auth: true` and never reads a pass. And a `linkAuth` handler holds a `User | null`, which `getSharedDrive` does not take: it must call `getReadDrive(ownerId, mountId, pathId, reader)` in `lib/drive/get-drive.ts`, which returns `Drive | SharedDrive | LinkDrive`. A route can only call what all three have, the trick that already keeps unwrapped `Drive` methods off the routes. The two routes that ask `canRead` and `canWrite`, the info route and the socket, tell a `LinkDrive` apart with `instanceof`.

`getReadDrive` is where a login and a pass meet: a signed-in user who can read the path gets their own drive as today, and anyone else gets a `LinkDrive`. So a pass never narrows what an owner sees in their own editor.

## The routes that opt in

Each resolves its path through `LinkDrive`, so each runs the rule on the path id in its own URL.

| Route | File | Reads through |
|---|---|---|
| `GET /collab/:ownerId/:mountId/:pathId/info` | `routes/collab.ts` | `canRead`, `getPath`, `getFolderContents`; `canWrite` is false |
| `WS /ws/collab/:ownerId/:mountId/:pathId` | `routes/collab.ts` | `canRead`, `getCollabDocument` |
| `GET /drive/:ownerId/:mountId/path/:pathId` | `routes/drive.ts` | `getPath` |
| `GET /drive/:ownerId/:mountId/folder/:pathId` | `routes/drive.ts` | `getFolderContents` |
| `GET /drive/:ownerId/:mountId/path/:pathId/breadcrumb` | `routes/drive.ts` | `breadCrumb` |
| `GET /drive/:ownerId/:mountId/file/:pathId/download` | `routes/drive.ts` | `resolveFile`, with ranges |
| `GET /drive/:ownerId/:mountId/file/:pathId/embed/:fileName` | `routes/drive-content.ts` | `resolveFile`, with ranges |
| `GET …/file/:pathId/preview`, `text-preview`, `vcard-preview`, `eml-preview`, `ics-preview` | `routes/drive-content.ts` | `resolveFile` |
| `GET /drive/:ownerId/:mountId/thumb/:fileName` | `routes/drive-content.ts` | `resolveFile` |
| `GET /drive/:ownerId/:mountId/file/:pathId/export/:format` | `routes/drive-content.ts` | `resolveFile`; Download and Print of a document |

Everything else stays closed to a pass, by saying `auth: true`: effective members, the ACL and the link routes, `GET …/history`, the version list, every chat route with its messages, the comment index (`/collab/…/comments` and `/comments/search`), notifications, SSE, search, recent, shared with me, watches, request access, email collaborators, mounts, the root folder, the inline editor's content and every write. One test walks the app's route table and holds it against the list above, so a new route is closed until someone adds it there.

A document refers to its pictures by name in its own `media/` folder ([MEDIA-REFERENCES.md](../MEDIA-REFERENCES.md)), which the link covers. A file attached by id that lives outside the linked path does not open for a visitor. That is accepted.

## Collab

- **Read-only.** The route passes `canWrite: false` for a `LinkDrive`, and `CollabDocument.handleMessage` already drops a reader's sync step 2 and updates.
- **No awareness, either way.** `CollabDocument.subscribe` takes `User | null`, and a visitor subscribes as `null`. Inbound awareness is dropped by the check that is already there (`if (!user) return`). Two sends learn the same rule: `sendSyncStep1` skips the awareness states, and the awareness `update` handler sends only to connections with a user. A visitor sees no cursors and no names, and nobody sees a visitor.
- **A turn-off closes open sockets within 15 s.** The keepalive's `checkAccess` asks `LinkDrive.canRead` again, which reads the entry as it is now. A reset, a password change, a trash, a move out of the linked folder and the setting all close the socket with 4403 the same way, with no hook of their own. The tab reloads, and the reload enters again or shows that the link is gone.
- **`recordOpened` is skipped.** A visitor has no Recent page.

## The way in

A link is the item's place in its app, like every Eigen URL, with the key after the `#`:

```
https://<host>/<app>/s/<ownerId>/<mountId>/<pathId>#<key>
```

The app is the document's own (docs, sheets, slides, vector, stickies) or Drive for a file or a folder. No lookup table is needed: the URL names the Home, the mount and the path. The part after `#` never reaches a server log or a `Referer` header.

One route lets a visitor in: `POST /p/link/:ownerId/:mountId/:pathId` with `{ key, password? }`, in a new `routes/link.ts` beside the demo's entry route.

| Case | Answer |
|---|---|
| Unknown owner, mount or path, no link, wrong key, in the trash, setting off | 404, one identical body |
| Right key, the link has a password, none sent and no valid pass yet | 401 "password required" |
| Right key, wrong password | 403, and one count on the limiter |
| Right key, and the password if there is one | 204 with the pass cookie |

The password prompt only shows to someone who holds the key. A reload sends the key again, and a browser that already holds a valid pass is not asked for the password twice. A `WindowLimiter` keyed by the path counts wrong passwords only: ten a minute per link, checked before the HMAC. The dialog asks for at least `MIN_PASSWORD_LENGTH` characters. The entry answer and every answer to a reader without a user carry `X-Robots-Tag: noindex`, set in the macro, and Caddy sets it on the `/s/` pages.

The frontend needs no "who am I" route. The page posts the key, then loads the item through the ordinary hooks, and a 401 or 403 there means the link does not work.

The Admin setting `sharing.publicLinks` is a new key in `ServerSettings` (`packages/lib/src/types/settings.ts`, defaults in `apps/api/src/lib/config/server-settings.ts`), edited on the **Guest access** page through `useServerSettings`. `/p/config` gains a `publicLinks` field so the share dialog knows it.

| Value | New links | Existing links |
|---|---|---|
| `'on'`, the default | With or without a password | Work |
| `'password'` | Need a password | Those with a password work, the others answer 404 until they get one |
| `'off'` | Refused, the dialog hides the control | All answer 404. The entries stay, so turning it back on brings them back |

## The frontend

What the apps do today, read from the code:

- `AuthProvider` (`packages/lib/src/core/auth/auth-context.tsx`) reads `authClient.getSession()` once and holds `user: AuthUser | null`.
- Every app's `_auth.tsx` is `createAuthRouteOptions()` (`packages/ui/src/components/layout/pages/auth-route.tsx`): no user means a redirect to `/login`, and child routes get a user that is always there. Every editor route sits under it, such as Docs' `_auth.doc.$ownerId.$mountId.$pathId.tsx`.
- `createEigenAppRouter` and `mountEigenApp` put the router inside `EigenApp`, so a route outside `_auth` still has every provider. Each app's `/login` is such a route.
- The shell already has a signed-out state. `Topbar` draws the logo and a **Log in** button and no app switcher, palette, bell or account menu, and `EigenDocRoot` and Drive's root route give no sidebar without a user.
- `EigenDocEditorRoute` loads `useCollabDocumentInfo` and hands the editor `path`, `canWrite` and the media folder. Editors take `user: AuthUser | null` from `useAuth()`.
- `useIsGuest` narrows the frontend in a few shared seams: `useDriveActionsFor`, `useFileActions`, `FileMenu`, the topbar.

The smallest change is additive. Nothing under `_auth` moves:

- **One route per app, outside `_auth`:** `s.$ownerId.$mountId.$pathId.tsx` in docs, sheets, slides, vector, stickies and drive. Each renders `LinkView` around the component its editor route already renders. Drive's shows a folder through `DriveLayout` with `browseCapabilities(false)`, and a file in the preview.
- **`LinkView`** (`packages/ui/src/components/layout/app/link-view.tsx`) is the visitor shell. It posts the key through `useEnterLink`, shows the password form or "This link doesn't work", and then renders its children with `canWrite` false inside `LinkVisitorProvider`. The frame around it is the signed-out `AppShell` as it is, plus the document's name in the top bar.
- **`useIsLinkVisitor()`** (`packages/lib/src/core/drive/hooks/use-link-visitor.ts`) answers "I am a link visitor". It reads that provider, so it is true on an `/s/` route and nowhere else, whoever is signed in.
- **Five shared seams read it**, each of which has a guest case today or serves every app: `useCommentLifecycle` runs no comment or member query and returns no threads; `useDriveActionsFor` and `useFileActions` keep Open and Download; `FileMenu` keeps Download and Print; `EigenDocEditorRoute` shows "This link doesn't work" in place of `RequestAccessView` and mounts no share dialog. Each document app's root route also counts `/s/` as full screen, as it does its editor route.
- **Links inside a linked folder** go through one `getLinkViewUrl(path)` beside `getDriveItemUrl` in `packages/lib/src/core/api.ts`. They carry no key: the folder's pass already covers the item.

A signed-in user who opens a link sees the same visitor view. If they can read the item themselves the server answers as them, and if not it answers from the pass. Their own editor URL is unchanged.

A visitor gets no event stream, so an open folder does not update by itself. An open document does, through its socket.

## What a visitor sees

Visitors see the item as it is. That includes the owner's name and avatar (`/p/users` and `/p/avatar` are public, and the owner id is in the URL) and the comment markers in a document with their authors' addresses, because a comment card lives in the Y.Doc with `creator` set to an email (`use-create-comment-card.ts`). On a stickies board the cards are the board. Visitors do not see the access list, the comment threads, the history, the versions or who is online. The dialog says so.

## Lifecycle

| Event | What happens | Left to clean up |
|---|---|---|
| Turn on | `setLink` adds the entry | |
| Turn off | The entry goes. Every pass and the URL stop matching, sockets close within 15 s | Nothing |
| Reset | New nonce: a new URL, the old one and every pass are dead | Nothing |
| Add or change the password | New check: the URL stays, every pass is dead | Nothing |
| Remove the password | The check goes: the URL stays, a visitor's tab reloads once and is let in | Nothing |
| Trash | Rule 1 closes it. The `acl` column survives the trash ([SOFT-DELETE.md](../SOFT-DELETE.md)) | Nothing |
| Restore | The same URL works again | Nothing |
| Move | A move stays in its mount and keeps the row, so the URL holds. A path moved out of a linked folder leaves its reach | Nothing |
| Copy | A copy is written with `acl: null`, so it has no link | Nothing |
| Delete for good | The row is gone, the URL answers 404 | Nothing |
| Owner or team deleted | The Home is gone, the URL answers 404 | Nothing |

No sweep and no cleanup: a link is a string in one row. A browser keeps a dead cookie until its 30 days are over, which opens nothing.

## The share dialog

Owners and editors who may share get a public link control in `DriveAccessListEdit`. In words: a way to turn the link on and off, **Copy link**, **Reset link**, and **Require a password** with a password field, off unless the owner turns it on. Under it one sentence: "Anyone with the link can view and download this without signing in. They see the document as it is, with its owner's name and the authors of its comments, but not the comment threads, the history or who has access." The link entry is left out of the people list. The control shows only on a file, a folder or a collab document.

**The placement is OPEN, the owner's choice once there are screenshots:**

- **(a)** A separate **Public link** section with a switch, below **General access**.
- **(b)** Google's way: a third choice **Anyone with the link** in the General access control, with **Require a password** and **Reset link** under it.

Both draw the same entry. (a) maps one to one onto what is stored. (b) needs a rule for what `visibility` becomes when the third choice is picked, since the link and "anyone signed in" are stored apart.

The hooks are `usePublicLink` and `useSetPublicLink` beside `useUpdateACL` in `packages/lib/src/core/drive/hooks/sharing.ts`. The dialog holds no query of its own.

## Where the design bends

1. **Readers do receive the link entry.** The brief was that no reader ever receives the password hash or the revoke value. Here every reader of the path sees `link_<nonce>.<check>` in `DrivePath.acl`, and it is worthless: the key, the pass and a password guess all need the server's secret. Hiding it instead has two honest forms. A column of its own is a migration. A strip in `Mount.toDrivePath` makes every writer of `acl` responsible for putting the hidden entry back. Both add a place to forget, to protect a value that opens nothing.
2. **The password check is a keyed HMAC, not better-auth's scrypt hash.** A scrypt hash can be attacked offline by whoever reads it, so it would have to be hidden (see 1). The HMAC can't without the secret, and whoever has the secret reads the files directly. Guessing is online only, behind the limiter.
3. **Not an option on `auth`, a second macro.** One macro has one resolve type, and `auth: true` must keep handing out `user: User`. The `:ownerId` gate in `scripts/check-standards.ts` looks for `auth: true`, so its pattern learns `linkAuth` in the same unit.
4. **A login and a pass need one fallback.** "A signed-in user who can't read it gets the pass" is a second path in `getReadDrive`. Without it a signed-in user opening someone's public link would get a 403 and be told to use a private window.
5. **Visitor is a route, not a session.** That costs a second URL per item (`/s/`). Serving visitors on the ordinary editor URLs would be nicer, and means moving every editor route out of `_auth` and making each page work without the guard's user: larger, and it touches what works.
6. **The password is about a fifth of this.** Dropping it would remove the check in the id, the 401 and 403 answers, the limiter, the password form, the `'password'` setting value and half the dialog control. A link would be one random string.

## Risks, and what is accepted

- **A link without a password is a bearer token.** Whoever has the URL is in. That is the feature. **Reset link** kills a leaked URL, and a server can force passwords.
- **Every link depends on the server's secret.** A server that comes back with another secret has no working link URL, as it has no working session.
- **The entry route opens the owner's Home for an unauthenticated caller**, as the request-access route does for any signed-in one. An unknown owner is a quick 404, and the app's global rate limit stands in front.
- **An anonymous visitor can queue exports.** The transform queue bounds them ([DOCUMENT-TRANSFORMS.md](../DOCUMENT-TRANSFORMS.md)). A per-IP limit on a visitor's exports is the measure if it is abused. Not built.
- **Wrong passwords from many addresses can fill a link's limiter** and keep new visitors out of that link for a minute at a time. Visitors who hold a pass are not affected.
- **Pass cookies add up.** Each visited link is about 100 bytes in every request for 30 days. Someone who opens hundreds of links on one server can hit the header limit. Accepted.
- **Up to 15 s.** After a turn-off an open document still receives edits until the next keepalive, as after any revoke.
- **Left out:** a history row for link on, off and reset (needs a new event type), an expiry date, a view counter, edit links, "view but no download".

**What breaks.** Nothing stored changes shape, and no existing data is touched. On a rollback to an older build, links stop working, a path that holds a link entry refuses every sharing change with "Invalid ACL entry" until the entry is removed, and the entry shows as a member address in the old access list.

## The work

In build order. No link can be made before unit 6 and no pass before unit 7, so nothing that merges earlier can expose anything. Tests live in `<workspace>/src/test/` and are written red first.

| # | Unit | Files | Size | Risk seam | Tests |
|---|---|---|---|---|---|
| 1 | The entry kind, inert | `packages/lib/src/types/drive-access.ts`, `Drive.updateACLDelta`, `acl-propagation.ts` | S | ACL check, persisted format | `test/acl/link-entry.test.ts`: a stored link entry gives no user read or write, is no effective member, gets no mail and no registry row; a delta naming a link is a 400; a people delta keeps the entry |
| 2 | The setting | `types/settings.ts`, `server-settings.ts`, `routes/settings.ts`, `/p/config`, `apps/admin` **Guest access** | S | No | The three values save and load; `/p/config` carries it |
| 3 | Pass, rule and `LinkDrive` | `lib/drive/link-pass.ts`, `acl.ts`, `link-drive.ts`, `get-drive.ts` | M | ACL check | `test/acl/link-rule.test.ts`: the path, a descendant, a sibling, the parent, the trash, inside a document only `media/`, a chat, each setting value, a pass of an old id; `LinkDrive` empties every `acl`, cuts the breadcrumb, filters a listing |
| 4 | Collab without awareness | `lib/collab/collab-document.ts` | S | No | `test/collab/collab-link-visitor.test.ts`: a `null` connection gets no awareness at sync or after, its awareness and its updates are dropped, document updates reach it |
| 5 | `linkAuth` and the opt-in routes | `routes/auth.ts`, `collab.ts`, `drive.ts`, `drive-content.ts`, `scripts/check-standards.ts` | M | Routes that serve bytes without a login | `test/acl/link-routes.test.ts`, with an entry written through the mount and a pass from the exported function: each opt-in route serves the path and refuses a sibling; every other route in the route table answers 401; the socket closes within one tick of a changed entry; no Recent row |
| 6 | `setLink` and its routes | `drive.ts`, `shared-drive.ts`, `routes/drive-sharing.ts` | M | ACL write, a lock, persisted format | `test/acl/link-write.test.ts`: reader, guest and restricted editor refused; root, chat, inside a document refused; trash 404; each setting value; a second turn-on changes nothing; reset changes the key; a password change keeps the key and kills the pass; a link change and a people change at once both land |
| 7 | The entry route | `routes/link.ts` | S | A route for an unauthenticated visitor | `test/acl/link-enter.test.ts`: the four answers; unknown, off, trashed and wrong key are byte-identical; only wrong passwords count; `noindex`; end to end from key to file bytes |
| 8 | The visitor view | `packages/lib/src/core/drive/`, `packages/ui/src/components/layout/app/link-view.tsx`, the five seams, an `s.` route in six apps, Caddy | L | No | Hook and component tests in `packages/lib/src/test` and `packages/ui/src/test`; a browser check per app, signed out and signed in ([verify-in-browser](../../.claude/skills/verify-in-browser/SKILL.md)) |
| 9 | The share dialog control | `drive-access-list-edit.tsx`, `drive-access-list.tsx`, `hooks/sharing.ts` | M | No | Dialog tests for on, off, reset, password, each setting value; the entry is not in the people list |
| 10 | Docs | ACL.md (a Public links section), GUEST-ACCESS.md and COLLAB.md (a pointer each), ARCHITECTURE.md, SERVER-SETTINGS.md, a help-center article, CHANGELOG | S | No | |

Unit 8 starts by walking Drive's detail pane and quick look without a user. The document editors' path is read through; that part of Drive is not. What it finds are queries that answer 401, never a leak.

## Needs the owner's yes

Each is asked as its own question right before it is built.

| Route | Why nothing existing serves |
|---|---|
| `POST /p/link/:ownerId/:mountId/:pathId` | The one unauthenticated way in. No existing route may set a pass |
| `PUT /drive/:ownerId/:mountId/path/:pathId/link` | The link has one writer of its own, so the ACL route can refuse every delta that names a link |
| `GET /drive/:ownerId/:mountId/path/:pathId/link` | Answers the key to someone who may share, for **Copy link**. The key is computed on the server and is in no `DrivePath` |

No migration: no new schema version and no new column. No package. Three existing routes gain a field or an option and are not new: `/p/config` (`publicLinks`), the settings save (`sharing`), and the opt-in routes (`linkAuth`).

## Open questions

1. **Dialog placement, (a) or (b)?** Recommended: (a), one switch for one entry. Decide on screenshots.
2. **Default of `sharing.publicLinks`?** Recommended: `'on'`, which is what users ask for.
3. **Does eigen.is force passwords?** Recommended: no, `'on'`. Set `'off'` on the demo server, where anyone can upload.
4. **Pass lifetime?** Recommended: a 30-day cookie and no expiry on the server. A reset or a password change is the revoke.
5. **A cap on links per user?** Recommended: none. A link costs no row, no Home and no sweep.
6. **May readers see the link entry (bend 1)?** Recommended: yes. Say no and the hidden form needs a migration or a strip seam.
7. **Keep the password in phase 1 (bend 6)?** Recommended: yes, it is ruled. Dropping it is the one cut that shrinks the design.
8. **A signed-in user on a link sees the visitor view. Fine?** Recommended: yes. Their own URL still opens the editor.
9. **A history row when a link is turned on, off or reset?** Recommended: later, with its event type.
10. **A ROADMAP row, not this feature: comment cards store their author's email in the document.** Recommended: add it to P2. It is why "a visitor sees no addresses" can't be promised.
