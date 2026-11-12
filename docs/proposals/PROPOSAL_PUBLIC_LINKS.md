# Proposal: Public links

This proposal lets a user share a file, a folder or a collab document with anyone who has the link. The visitor needs no account, no emailed code and no password: opening the link opens the document. The owner can add a password to a link, but doesn't have to. Users ask for this again and again: today the only way to reach someone outside the server is a guest, and a guest needs an email address and a code for every sign-in.

A public link is view-only. Viewing covers what users ask for: "have a look at this", "download this". Edit links are a possible phase 2, at the end.

**Status:** not built. Sharing is described in [ACL.md](../ACL.md), guests in [GUEST-ACCESS.md](../GUEST-ACCESS.md), the collab socket in [COLLAB.md](../COLLAB.md).

> **TLDR:** A public link is a guest account that stands for the link instead of a person. Turning the link on creates a `role: 'guest'` user with a reserved address, `<linkId>@link.invalid`, and puts that address in the path's ACL with read only. Opening `/s/<linkId>` signs the visitor in as the link account at once. A link with a password asks for it first, and the password is that account's password. Either way it is a real session, minted the way guests and the demo get theirs (`signInWithScopedPassword`). From there everything is the existing guest path: `SharedDrive` checks the ACL, the collab socket refuses every write, a revoke closes open sockets, and a guest can't share, mail or reach mail, contacts and calendar. A visitor sees the item alone, with no top bar and no sidebar, and no names or addresses of the people who work on it. No schema change: the link lives in rows and files that exist already. It needs two public routes, a link field on the ACL route, one guard in the mailer, a visitor view, a section in the share dialog, and a sweep of every place that lists users so link accounts stay out of them. Size M.

## The problem

- **Sharing outside the server needs an email address.** The owner must know who will read the file. A link on a website, in a newsletter or in a chat group can't name its readers.
- **Every sign-in is a mail round trip.** A guest asks for a code, waits for the mail, and types six digits. For "have a look at this PDF" that is too much, and a code that lands in spam loses the reader.
- **"Unrestricted" is not public.** The share dialog's **General access** says "Any authenticated user with the link". Every drive route needs a session, so `public-read` and `public-write` never reach someone without an account ([ACL.md § Visibility](../ACL.md#visibility)).

## What exists today

| Piece | Where | What it gives a link |
|---|---|---|
| Guest accounts | `verifyOtpAndSignIn` in `apps/api/src/lib/auth/guest-auth.ts` | A direct insert of a `role: 'guest'` user, with no org and no team |
| Session mint | `signInWithScopedPassword` in `guest-auth.ts` | A real better-auth session from a server-side password. The demo entry already uses it from a public route |
| Guest home | `GuestHome` in `apps/api/src/lib/home/guest-home.ts` | Drive and notifications only. `shared.db` lists what was shared with it |
| Guest limits | `requireNonGuest()` on the ACL, chat invite, access-check, request-access and email-collaborators routes; `protocol-auth.ts` refuses guests | A visitor can't share onward, ask for access, mail collaborators, or use WebDAV, CalDAV or IMAP |
| ACL check | `canFromAncestors` and `matchesACL` in `apps/api/src/lib/drive/acl.ts` | An email entry on a folder covers everything below it |
| Read-only collab | The collab route checks write on every frame | A reader's edits never land. Comment writes are gated on write too ([COMMENTS.md](../COMMENTS.md)) |
| Revoke | `checkAccess` on each socket's 15 s keepalive | Removing the entry closes the visitor's open collab sockets within 15 s |
| Guest shell | `useIsGuest` in `packages/lib/src/core/auth/hooks/use-is-guest.ts`, read by `topbar.tsx` and `app-sidebar.tsx` | The place where a narrower frontend is already decided |
| Guest sweep | `cleanupInactiveGuests` in `apps/api/src/lib/auth/guest-cleanup.ts` | Deletes inactive guests. It must skip link accounts, see below |
| Share dialog | `DriveAccessListEdit` in `packages/ui/src/components/drive/drive-access-list-edit.tsx` | The **General access** block, where a link section fits |

So almost everything a public link needs is a guest. The missing parts are a way in without an email, a view without the workspace around it, and a share dialog that shows the link as a link instead of as a person.

## The design

### A link is a guest account with a reserved address

Turning a link on for a path does three things, server-side, in the ACL route's per-path chain:

1. Make a link id: 128 random bits, base32. It is the secret in the URL.
2. Insert a guest user with email `<linkId>@link.invalid` and name "Visitor", the way `verifyOtpAndSignIn` inserts one. `.invalid` is reserved (RFC 2606), so the address can never belong to someone, and it passes `isValidEmail`.
3. Add `{ id: '<linkId>@link.invalid', read: true, write: false }` to the path's ACL through `Drive.updateACLDelta`, with `suppressShareEmail: 'all'`.

Propagation then writes the path into the link account's `shared.db`, like any share. That row is also how the server finds the path behind a link id: the link account's home has exactly one shared path. So there is no new table and no new column. `role` stays `'guest'`, which keeps every guest restriction for free.

The reserved domain is one fact, so it lives in one module: a `LINK_ACCOUNT_DOMAIN` constant and an `isLinkAccount(email)` helper in a React-free `packages/lib` subpath, which the API and the frontend both import.

A path has at most one link. Turning it off removes the ACL entry, which closes open sockets, and then deletes the account with `deleteUserCompletely`, which drops its sessions and its home. The deletion runs after the per-path chain has let go, not inside it, because deleting a user takes locks of its own. A new link after that gets a new id, so an old URL stays dead.

### A link has no password unless the owner adds one

The default link has no password: the URL alone lets the visitor in, the way "Anyone with the link" works in Google Drive. The server writes the scoped password, `HMAC-SHA256('link:' + email, auth secret)`, onto the link account, as guests and the demo do, and `enter` signs in with it without asking the visitor for anything. The 128-bit link id is what keeps the link private: nobody guesses it, so only people who were given the URL can get in.

With a password, the owner's password is hashed onto the link account's credential (`setCredentialPassword`), and the visitor's input goes to `auth.api.signInEmail` as is. better-auth does the hash check.

Adding, changing or removing the password rewrites the credential. Adding or changing it also revokes every session of the link account, so everyone who got in without it, or with the old one, is out. **Reset link** does the same for a link without a password: it turns the link off and on again, so the old URL dies and a new one is made. Those two are the owner's "I sent it to the wrong group" button.

### The way in is two public routes

| Route | Does |
|---|---|
| `GET /p/link/:linkId` | Answers `{ exists, hasPassword }`. Nothing else: no file name, no owner. An unknown id and a deleted one answer the same |
| `POST /p/link/:linkId/enter` | Body `{ password? }`. Checks the rate limit, signs in as the link account, and answers with the session cookie and the path's app URL |

Both live in `routes/public.ts`'s `/p/` surface. `enter` is rate limited per link and per IP before any hash, the way `checkDemoRateLimit` guards the demo entry: 10 tries a minute per IP, and a per-link window so a botnet can't grind one password. The dialog asks for at least `MIN_PASSWORD_LENGTH` characters.

The frontend page is `/s/<linkId>` in the index app. For a link without a password it posts `enter` straight away, so the visitor sees a short spinner and then the item. For a link with one, it asks for the password first. Either way it goes to the URL `enter` returns: the document in its app, the file in Drive's preview, the folder in Drive. The page and the routes send `X-Robots-Tag: noindex`.

### A visitor sees the item, not the workspace

A visitor has no use for the app switcher, the user menu, the bell or **Shared with me**, and each of them is a thing that can show more than the owner meant to. So a link account gets a viewer, not a shell. `useIsLinkVisitor()`, next to `useIsGuest` in `packages/lib/src/core/auth/hooks/`, tells the layout, and `topbar.tsx` and `app-sidebar.tsx` render nothing for it. What is left:

- **A document** opens in its app's read-only view, with a slim bar that holds its name and **Download**. The app's own toolbar keeps only what a reader uses: zoom, find, print.
- **A file** opens in Drive's preview, with the same bar.
- **A folder** opens in Drive with the shared folder as the root. The breadcrumb starts there, and a document opened from it gets a back arrow to the folder.

A visitor can always download what they can view, as every reader in Eigen can. There is no "view, no download": whoever can see a file can save it anyway, so a switch would only promise something it can't keep.

The bar has no **Sign out**. Closing the tab is enough, and a visitor who is signed in through the link has nothing else to leave.

### A visitor sees no people

A guest viewer today sees who else has access, who wrote each comment, and their avatars. That is fine for a guest: the owner chose that person. A public link is read by anyone, so it must not hand out the names and email addresses of the people who work on the item. For a link account:

- **The access list is gone.** The visitor view has no share button, and the server refuses `effective-members` and the path's ACL to a link account, not just the frontend.
- **Comment threads are hidden.** The visitor view mounts no comment layer, and the chat routes refuse a link account for the comment chats under the container. Comments are working notes, not part of what was published.
- **Presence shows no names.** Other people's cursors in an open document carry their names. The visitor view draws no remote cursors, and the owner's side sees each visitor as "Visitor".
- **File history is hidden.** It names every editor.

Each of these is a server check, not only a hidden button, because a visitor holds a real session and can call the routes directly. This list is the one to check most carefully during the build.

### Link accounts stay out of every list

A link account is a row in the user table, and every place that lists users or guests would show it as a person. The known ones: the Admin **Guests** page, user counts, user search and autocomplete, `/p/users` and avatars, the backup's home list, `getEffectiveMembers`, and the people list in the share dialog. Each filters on `isLinkAccount` at its source query, not in its component. The first unit of the build is a full inventory: every query that reads the user table or filters on `GUEST_ROLE`. Without it, the next list someone adds will show "Visitor" as a person.

### The share dialog gets a link section

Below **General access**, owners and unrestricted editors see **Public link**: a switch, **Copy link**, **Reset link**, and **Require a password**, which is off unless the owner turns it on. Turning the switch on is all it takes to publish. A line under the switch says what a visitor gets: "Anyone with the link can view and download. They won't see comments or who has access." The ACL route's delta body gets one optional field for it:

```typescript
{ add?, remove?, visibility?, sharingRestricted?, link?: { enabled: boolean; password?: string | null; reset?: boolean } }
```

`sharingRestricted` gates it like any other ACL change, and `requireNonGuest` already keeps guests out.

The switch is only offered on files, folders and the collab types (`isCollabType`). A standalone chat path gets a 400.

### No mail ever goes to a link account

The share mail is suppressed at step 3, but a link account can still be a target elsewhere: a mention, a watcher, an access-request mail. One guard in `sendMail` drops every recipient on `LINK_ACCOUNT_DOMAIN`, so no caller needs its own case. Bell notifications still land in the link account's home, where nobody reads them, since the visitor view has no bell.

### The guest sweep skips link accounts

`cleanupInactiveGuests` would delete a link nobody opened for `guests.inactivityDays`, and that would break a URL printed on a poster. So the sweep skips link accounts. A link ends when the owner turns it off or resets it, when the path is deleted for good, or when its owner is deleted. Trash already revokes every share ([SOFT-DELETE.md](../SOFT-DELETE.md#trash-revokes-every-share-and-restore-re-shares-without-an-email)), so a trashed path's link stops working and a restore brings it back.

An expiry date is the natural next step, and the sweep is where it would run. It needs somewhere to store the date, so it is left out of this proposal.

### A server setting can turn links off

A hosted org may not want its users to publish files. `sharing.publicLinks` in server settings (`'off' | 'password' | 'on'`, default `'on'`) hides the switch, forces a password, or allows links with and without one. The default allows a link without a password, because that is what users ask for. Turning it off does not delete existing links, it refuses `enter` for them, so turning it back on restores them.

## A visitor who is signed in already

The session cookie is one per server. A signed-in user who opens `/s/<linkId>` and can read the path through their own account goes straight to it, in the full app. One who can't is shown the choice: **Request access** as themselves, or **Open as visitor**, which signs them out first. Silently swapping their session for the link account's would lose their place in every other tab. This is clumsy, but rare: a public link is mostly opened by people without an account.

## Risks

- **A link without a password is a bearer token.** Whoever has the URL is in, and URLs leak through chat previews, browser history and forwarded mails. That is the point of a public link, so the dialog only says so next to the switch, and **Reset link** kills a leaked URL. A server that wants more can force a password.
- **Sessions outlive the URL.** A visitor keeps their session until it expires, the link is turned off or reset, or a password is added or changed. Removing a password revokes nobody.
- **A list that forgets the filter shows a fake person.** The inventory unit is there for this. A test that creates a link and checks every listing route keeps it from coming back.
- **A route that forgets the visitor rules leaks names.** Same answer: the "visitor sees no people" checks are server-side, and a test calls each route as a link account.
- **Brute force.** The per-IP and per-link limits live in the API process, as the OTP limiter's do. Eigen runs one API process, so that holds.

## Work

| Unit | Where | Size |
|---|---|---|
| Inventory of every user and guest listing, with the `isLinkAccount` filter at each source | `apps/api/src/lib/`, `packages/lib` | S |
| Link account create, reset and delete; deletion after the chain | `apps/api/src/lib/drive/`, `guest-auth.ts`, `user/guest.ts` | M |
| `GET /p/link/:linkId`, `POST /p/link/:linkId/enter`, rate limit | `routes/public.ts`, a new `lib/auth/link-auth.ts` | S |
| `link` field on the ACL route | `routes/drive-sharing.ts`, `useUpdateACL` | S |
| Server checks: no members, no comment chats, no file history for a link account | `routes/drive-sharing.ts`, `routes/chat.ts`, `SharedDrive` | S |
| Mailer guard, sweep skip | `mailer.ts`, `guest-cleanup.ts` | S |
| `sharing.publicLinks` setting | server settings, Admin app | S |
| Visitor view: no top bar or sidebar, slim bar, folder as root, no comments or remote cursors | `packages/lib/src/core/auth/hooks/`, `packages/ui/src/components/layout/`, the document apps | M |
| Share dialog section, `/s/` page, signed-in choice | `packages/ui/src/components/drive/`, `apps/index` | M |
| Tests: enter with and without password, no write lands, revoke closes sockets, password change and reset revoke sessions, a reset kills the old URL, no mail to the link domain, every listing route leaves the link out, every visitor-rule route refuses, chat path refused | `apps/api/src/test/acl/` | S |
| Docs: ACL.md, GUEST-ACCESS.md, a help-center article, CHANGELOG | `docs/`, `apps/index/src/data/support/` | S |

New API routes need the owner's explicit yes before they are built: the two `/p/link` routes and the ACL body field. No migration and no new package.

## Phase 2: edit links

Not planned. If users ask for them, the one-account design stops fitting. Every visitor would edit as the same "Visitor", so file history can't tell them apart, and an edit link on a folder lets anyone upload into the owner's quota.

The variant that fits is one guest account per visitor, with the link id in its address, `<visitorId>.<linkId>@link.invalid`, and a new ACL entry kind, `link_<linkId>`, that `matchesACL` matches on that suffix. That needs no migration, but it is a new kind of principal in the ACL check, so it needs its own decision before anyone builds it. The URL and the dialog stay as they are.

## Open questions

1. **Should eigen.is itself force passwords?** The default `'on'` allows links without one, which is what users ask for. A hosted server shared by many orgs might set `'password'` instead.
2. **Comments.** This proposal hides them from visitors. Some owners will want a published document with its discussion. A per-link "show comments" switch could come later; hiding is the safe default.
