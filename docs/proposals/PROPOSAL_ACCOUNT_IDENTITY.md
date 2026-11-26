# Identity: how Eigen names people

**Status:** proposal. It needs the owner's yes on the points in [section 8](#8-what-needs-the-owners-yes). It replaces the earlier notes in this file (options A, B and C). Raised in [issue #16](https://github.com/eigen-is/eigen/issues/16). Related: [PROPOSAL_SSO.md](PROPOSAL_SSO.md), [ACL.md](../ACL.md), [STORAGE.md](../STORAGE.md), [CALENDAR.md](../CALENDAR.md), [SERVER-SETTINGS.md](../SERVER-SETTINGS.md).

The document has two parts. **Part A** is the identity change, the work for 0.5.0. **Part B** shows two things that can be built on top later: several addresses per person, and the "assigned to me" list. Part B is not part of the 0.5.0 work.

## In short

- A member is a **permanent id**. The address (anna@acme.com) is only a **property** of that member. It can change.
- Where Eigen stores "this person", it stores the member's id. An outside person (a guest) is stored as a plain email address.
- **Members and guests never mix.** A member's address is always on one of the server's own domains. Every other address is a guest address. A guest never becomes a member.
- An address is translated to an id **once, at the border** (the share dialog, a mention, a calendar save). A new account with an old address gets a new id, so it inherits nothing.
- The product gets **no backward compatibility**. eigen.is is converted once, by a throwaway script. SSO comes after the identity change is done.

# Part A: the identity change (0.5.0)

## 1. The problems today

Today Eigen writes the address on a share, a chat message, a comment and an assignment. To check access it asks: "is this person's address on the list?" That is only right while one address is always one person.

- **Old Anna, new Anna.** Anna leaves Acme and her account is deleted. A year later a new Anna gets anna@acme.com. Eigen cannot tell them apart.
- **Sara.** Sara's address changes from sara.devries@ to sara.bakker@. Everything stored under the old address no longer points to her. (No Eigen screen can do this today. better-auth's `/admin/update-user` can.)
- **SSO makes it common.** With SSO an account is made at the first sign-in, with nobody watching. Companies reuse addresses.

What new Anna gets today:

| Where | What goes wrong today | Harm |
|---|---|---|
| Files, folders and calendars shared with old Anna | She can open them by link (`aclGrants` compares only the address). In some cases Eigen also puts them in her "Shared with me", for example when the owner changes the sharing later. | Real |
| Team chats (she joins the default team on day one) | Old Anna's messages are "hers". She can edit and delete them (`ChatRoom.editMessage`, `deleteMessage`). | Real |
| Whispers (private messages inside a chat) | She reads what old Anna sent and got (`ChatRoom.getMessagesForUser`). | Real |
| Bob clicks "Start chat" with Anna | Eigen opens Bob's old private chat with old Anna (`findChatsByMembers`). | Real |
| Notifications and "Email collaborators" | She gets text from chats where old Anna once posted. | Real |
| Comments and assignments | Old Anna's open assignments show as hers. | Misleading |
| Calendar events where old Anna was a guest | At the organizer's next edit the event lands in her calendar (`propagateInvitation`). | Real |
| Names and photos on old content | Old messages show new Anna's name and photo (`getPublicInfo` looks up by address). | Misleading |
| SSO, when old Anna's account was never deleted | A new person with the same address can be linked to old Anna's whole account. | Real, the biggest |
| Mail to anna@acme.com | Goes to new Anna. | Correct. A mailbox is an address. |

## 2. The idea: a person is an id, an address is a property

This is how Bluesky does it. Slack and Google Workspace do the same.

| | Bluesky | Eigen |
|---|---|---|
| The permanent id | DID (`did:plc:ewvi…`) | the better-auth `user.id`, such as `7OEwianTfhULu6iG8wQz4G2dO5G2w0B4` |
| The changeable name | handle (`@anna.bsky.social`) | address (anna@acme.com) |
| What data stores | the DID | the id |
| Where the name becomes an id | when you type a handle | at the border |
| Does the id contain a domain? | No | No. So a domain move breaks nothing. |

**The id we already have is the person id.** It is 32 random letters and digits, made by better-auth (`generateId`). It is already the Home folder name, the `:ownerId` in every route and the key of sessions, teams and app passwords. So there is no rename and no `p_` prefix. A prefix would break `parseOwnerId` and every Home path, for nothing.

**One rule: ids inside, addresses at the border.** The border is every place where an address comes in: the share dialog, the mention picker, the whisper target, the assignee picker, a calendar save, an incoming calendar reply, and mail that gives its recipients access (`grantAccessForReferences`).

## 3. The rules

### 3.1 The reference

A reference is one short string that names who is meant.

| Kind | Form | Example |
|---|---|---|
| email | a valid address, lower case | `jan@other.org` |
| team | `team_` + 32 letters and digits | `team_Qk3…` |
| org | `org_` + 32 letters and digits (only as the owner of a Home) | `org_9fB…` |
| person | 32 letters and digits | `7OEwianTfhULu6iG8wQz4G2dO5G2w0B4` |

The parser lives in `packages/lib/src/types/owner.ts`, next to `parseOwnerId`, so the server and the browser use the same one. It checks in the order of the table: first "contains `@` and is a valid address", then the two prefixes, then the bare id, else invalid. The address check must come first, because `team_lead@other.org` is a valid address. Today `parseOwnerId` answers `user` for both an id and an address. That is split into `person` and `email`. The old form `external_<email>` disappears: the product no longer reads or writes it.

Two functions answer every identity question. `isRef(ref, caller)`: is this caller that reference, or a member of it? `resolveRef(ref)`: which accounts are behind it now? A deleted person gives none. Today these questions are asked in about 55 places in the API and 40 in the browser, in slightly different ways.

Which kind is allowed where:

| Place | person | team | email |
|---|---|---|---|
| Drive share, calendar share | yes | yes | yes |
| Chat author, whisper target, comment author, card or column creator, assignee | yes | no | yes |
| Mention token | yes | later | yes |
| Calendar attendee (the id stamp) | yes | no | no stamp |
| Owner of a Home (`:ownerId`) | yes | yes | never |

### 3.2 Members and guests never overlap

A **member** is a person with a password or an SSO login. A **guest** is an outside person who signs in with a code sent by mail. One rule keeps them apart for good:

**Member domains and guest addresses never overlap.**

- A **member domain** is the server's mail domain (acme.com), plus the domain of each SSO provider.
- **A member's address is always on a member domain.** This is true today in the screens: setup, the Admin app and the waitlist all build `username@mailDomain`. The server will now check it too, in `user.create.before` and `user.update.before`. Creating a member with an outside address is refused.
- **Every other address is a guest address.** A guest can never have an address on a member domain. Eigen already refuses a guest on its own mail domain (`requestOtp` in `guest-auth.ts`, and SERVER-SETTINGS.md). This is extended to the SSO domains.
- **So a guest never becomes a member, and a stored email never turns into an id.** There is nothing to rewrite, ever.

What the border does with an address:

1. **On a member domain:** look up the member. Found: store the id. Not found: refuse, "No account with this address". It is never stored as an email.
2. **Outside:** store the email. A stored email is a guest, always. It never matches a member and never shows a member's name or photo.

Where Eigen cannot refuse (an attendee line that a phone wrote, a mail recipient), an address on a member domain with no member is simply nobody: no stamp, no access.

A guest still has a user row while they are active. It is only a way to sign in, and the cleanup may delete it. A guest's id is never stored as a reference.

### 3.3 Decisions where the research disagreed

| Question | Decision | Why, in one line |
|---|---|---|
| A person without an account: a person row, or a plain email? | **A colleague: refused until the account exists. An outsider: a plain email.** | No "ghost" rows, and no stored email that later has to become an id. |
| A guest who is cleaned up: keep the row asleep, or stay an email? | **A guest stays an email.** The cleanup works as today. | A guest proves the mailbox at every sign-in, so for a guest the address is the identity. |
| Deleted member: keep the row forever? | **No, delete it as today.** | The id is random and never made twice, and a restore brings back the same id. |
| Calendar attendee: store the id instead of `mailto:`? | **No. `mailto:` stays, plus an id stamp.** | The iCalendar bytes are what phones sync. |

### 3.4 What is stored in Homes

A Home is one owner's private data folder. Shares live there.

- Drive shares (`paths.acl` in `metadata.db`) and calendar shares (`calendars.shares` in `calendar.db`): the entry's `id` is a reference. `{ id: "7OEw…", read, write }` for Anna, `{ id: "jan@other.org", … }` for Jan.
- The browser sends the address. The server looks up the id. The browser is never trusted to send an id.
- A share whose person was deleted shows as "Deleted account", with a remove button. No name is kept for it.
- History (`file_events`) does not change. It already has `actorUserId`, and `actorEmail` stays as a snapshot of that moment. A notification stores the actor's reference next to the same kind of snapshot.
- The share registry (`eigen.db`) stays as it is. It is only used, as today, to fill "Shared with me" for a guest and for a team.

### 3.5 What is stored in containers

A container is a file that can travel: a document, a chat.

- Authors, whisper targets, comment creators, resolvers, assignees and mentions are references.
- **The name card.** A small table `people` in the chat `data.db` and in `comments.db`: `id`, `name`, `address when last seen`. The server writes a row when a member is first named there, and refreshes it when they act again. It is used for a deleted person ("Anna Jansen (deleted)") and on another server ("Anna Jansen (not on this server)").
- **Hard rule: the name card is for showing names, never for access.** Anyone can edit a downloaded file.
- **The address is never part of the reference.** A form like `7OEw…#anna@acme.com` would keep a moved file readable too, but the name card already does that, in one row. Inside the reference, an address change makes two strings for one person, the address is copied into every message and token, and it invites matching on the address when the id is unknown. That is old Anna and new Anna again.
- The `creator` on a comment card and on a stickies column lives inside the collaborative document, and the browser writes it. It stores a reference and is only shown. The server decides nothing with it.
- **A member who edits a document gets a name card row too.** The server does not see who made a card or a column, but it knows whose connection an edit comes from. At a member's first edit of a document, the collab server writes their row in the document's `comments.db`. Every collaborative document has one. The name card is not kept inside the collaborative document itself: any browser could write it there, and an erase request would have to blank it in every stored version.
- This reverses the September rule in [STORAGE.md](../STORAGE.md) ("Containers name users by email, never by id"). The name card is what keeps a moved file readable. That section must be rewritten.

**Mentions are tokens.** Today a mention is "any address found in the text" (`extractMentionedEmails`). That is replaced by a token the picker inserts: `<@7OEw…>` for a member, `<@jan@other.org>` for a guest. It is shown with today's name. Copied as plain text it becomes "@Anna Jansen". A built-in emote stores `$key:<reference>` the same way. An address someone just types ("mail me at jan@x.nl") is plain text and notifies nobody.

### 3.6 Calendar

- **Shares:** the same rule as Drive.
- **Attendees:** the line stays `ATTENDEE:mailto:anna@acme.com`. When an address is **added** to an event and a member holds it, the server adds a stamp to that line: the parameter `X-EIGEN-USER=<id>`. A stamp is an `X-EIGEN-*` fact that only the server can write.
- **A stamp is kept, never looked up again.** `restampResource` already strips every Eigen stamp a client sends and copies the stored ones back. So an address that is already on the stored event keeps its stamp. Only a newly added address is resolved. Otherwise Bob's next edit would stamp new Anna.
- This is new work in `restampResource`. Today's stamps (such as `X-EIGEN-ORGANIZER-USER` on a guest's copy of an invitation) are whole lines. A parameter on an `ATTENDEE` line does not exist yet.
- Nothing that leaves the Home carries a stamp, with one exception that exists today: a CalDAV GET to the owner's own devices.
- Matching (RSVP, invitations, decline-on-delete) uses the stamp when there is one, and the address only when there is none (an outsider or a guest).
- Outgoing invitation mail resolves the id to today's address. An incoming reply is translated to an id on arrival.

### 3.7 Contacts

An address a user puts on a contact card is **never an identity**. That includes extra addresses on your own card. One fix: today `useResolvedUser` matches any address on any card, so if you put boss@acme.com on your own card, the boss shows under your name (in your view only). A card will be matched on the person's server-known address, and only to show a name.

### 3.8 Guests, teams, role addresses

- **Guest (Carol, Jan):** a stored email everywhere. The cleanup may delete the user row. When the guest returns, the same address matches again. Nothing is ever rewritten.
- **Team:** `team_<id>`, as today.
- **Role addresses** (`postmaster`, `abuse`, `noreply`): for mail delivery only. Refused as a share target.

## 4. How each problem is solved

- **Old Anna, new Anna.** Bob shared a folder with old Anna: the entry says `id A`. Old Anna is deleted. New Anna gets anna@acme.com and `id B`. She matches nothing, and nothing is delivered to her. In team chats, old messages and whispers say `id A`: she cannot read the whispers or edit the messages. They show "Anna Jansen (deleted)" from the name card. If Bob now types anna@acme.com in the share dialog, the border gives `id B`. That entry is right too.
- **Sara.** Her address changes. Her id does not. Shares, messages, assignments and invitations to her still point to her. **Three things still break**, so changing an address stays future work: the mail and calendar apps on her phone sign in with the address; her own events name her old address as organizer, and `isInvitationFromOthers` then treats them as someone else's; and stored attendee lines still show the old address.
- **Jan the outsider.** Bob shares with jan@other.org. It is an outside address, so the entry is the address. Jan signs in with a mailed code and gets in. He is a guest, and stays one. If Acme hires Jan, he gets jan@acme.com: a new member with a new id. Nothing moves over from his guest time. Bob shares with him again.
- **Bob wants to share with a colleague who has no account yet.** The share dialog says "No account with this address". Bob shares after the account exists.
- **Carol the guest.** Carol is cleaned up after months and comes back. Same address, same shares, same authorship.
- **Bob adds people over the years.** His list holds `id A` (2025) and `id C` (2027). No dates are needed, because an id is never reused.
- **Calendar.** Bob's event has old Anna stamped with `id A`. When he edits it, the stamp stays, and nothing goes to new Anna.

What is **not** solved: mail to a reused address reaches the new holder (correct). An old password account that was never deleted is still a risk with SSO (section 5).

## 5. SSO: how it fits, and the order of work

SSO means: sign in with your company account (authentik, Keycloak).

- **The login is bound to the provider and its `sub`**, not to the address. The `sub` is the fixed id the provider gives each person. better-auth already stores it (`accountId` on the `account` row) and looks it up first (`handleOAuthUserInfo`). So: provider + `sub` → person id.
- **A provider's domain becomes a member domain.** The address a provider sends must be on that provider's own domain. Any other address is refused. So an SSO login can never touch a guest.
- **Adding a provider whose domain has guests.** Say Acme adds a provider for partner.com, and three guests have partner.com addresses. The owner is shown these guests and must confirm. Then they are deleted. Their old shares and messages stay under the plain address and belong to nobody. The partner.com people sign in with SSO as new members, and what they need is shared again.
- **A domain stays a member domain** as long as a member has an address on it, also after its provider is removed.
- **The fallback.** When the `sub` is unknown, better-auth looks for an account with the same address and links the login to it. Today this is blocked by a default setting, `requireLocalEmailVerified`: Eigen makes every member with `emailVerified: false`.
- **Guard 1, in a new hook `databaseHooks.account.create.before`:** refuse the link when the user already has a login from this provider. Same address, other `sub`, is a new person.
- **Guard 2:** no link to the owner or an admin (already ruled).
- **`overrideUserInfo` stays off** in v1. It would copy the provider's address over `user.email` at each sign-in.
- **A provider's issuer cannot be edited.** The bind is to the provider's id. Delete and add again.

**The honest limit.** Guard 1 only protects accounts that already used SSO. Old Anna has a password account. She left before SSO was turned on and nobody deleted her. If linking by address is allowed, new Anna's first SSO sign-in is linked to old Anna's whole account. And when a guard refuses a link, the new person cannot sign in at all, because the address is taken. An admin must first delete the old account.

**The choice** (it is in section 8):

- **(a) Allow linking by address** (`requireLocalEmailVerified` off). Every existing member can use SSO at once. When the owner adds a provider, Eigen shows the list of accounts that can now be linked, so the owner can delete the people who left.
- **(b) Keep the default and let an admin mark each account "may use SSO"** (this sets `emailVerified`, which members do not use for anything else). One button can mark all current members. An account nobody marked cannot be taken over.
- **Recommendation: (b).** When something is forgotten, the result is "cannot sign in", not "wrong person signed in".

**The order: first the identity change, then SSO.**

- SSO's guards build on Part A: a provider's domain becomes a member domain, the second-`sub` refusal, and no link to a guest. Built first, SSO would be built on the email model and have to be redone.
- The identity change moves the code SSO touches (the hooks in `auth.ts`, shares, chats, calendar). Building both at once means conflicts and rebases.
- SSO creates accounts with nobody watching. It should never run on a server whose shares still match by address.
- The identity change lands before 0.5.0. SSO starts after it is done, built by Tobias (issue #16) or by us.
- The "deleted address list" from the earlier plan is dropped.

## 6. Migration

**The product has no compatibility code. None.** 0.5.0 reads and writes only the new format. There is no converter in the release, no upgrade step, and no check for old data.

- **eigen.is** is converted once, by a throwaway script. The script is never part of a release. It is deleted after the run.
- **demo.eigen.is** resets every hour. `apps/api/src/scripts/seed-demo.ts` changes to write ids.
- **Everything else from before 0.5.0 is not supported:** other installs, old backups, old versions of a chat, and old downloaded files. They start fresh. One line in the changelog says so.

### 6.1 What the script changes on eigen.is

| Where | Change |
|---|---|
| Home `metadata.db` | `paths.acl` entries: address → reference. |
| Home `calendar.db` | `calendars.shares`: address → reference. Attendee lines get the stamp. `external_<email>` → plain email. |
| Home `notifications.db` | the actor's reference is filled in. |
| Share registry (`eigen.db`) | rows for addresses on a member domain are removed. |
| Chat `data.db`, and its stored versions | `authorEmail`, `whisperTo` → references. Mentions and emotes in `content` → tokens. Name card. |
| `comments.db` | `createdBy`, `resolvedBy`, `lastAuthorEmail`, `assignee`, `comment_mentions.email` → references. Name card. |
| Collaborative document `data.db`, and its stored versions | `creator` on comment cards and stickies columns → reference. The name card rows go in the document's `comments.db`. |

It also brings each database to the new layout, so 0.5.0 can open it. Not touched: `users3.db`, `contacts.db`, `mail.db`, `file_events`, the content of a collaborative document (only the `creator` values change), and the attendee addresses themselves.

The script changes a `creator` as a normal edit on the loaded document. It does not build the document again. So a browser tab that still holds the document merges cleanly after the run.

How the script decides, per address:

- **An outside address** stays a plain email. It is a guest.
- **An address on our own domain, in a share:** it becomes the id of the member who holds it today. No member holds it: it is a leftover of a deleted user, and the entry is removed.
- **An address on our own domain, in a message, comment, assignee or mention:** it becomes the id of today's holder, but only when that account is older than the message (for an assignee or a mention: older than its comment). Nobody wrote a message before their account existed. This check is kept because it matters in this one run: if an address already changed hands on eigen.is, the new holder does not get the old messages. Otherwise the address stays as it is and belongs to nobody.
- **An address on our own domain, in a `creator`:** the same check, against the card's own date. A stickies column has no date, and a card can lack one. Then the document's date is used: an account older than the document is older than everything in it.
- **Text:** only an address that passes the same check becomes a token. Every other address stays text.

A share has no date. If an address already changed hands before the run, the new holder keeps the old shares, as today. The dry run lists what it will do, so these can be removed by hand.

### 6.2 The runbook

1. **Dry run**, read only. It prints per database: how many values of each field and how many become an id. And three lists: members with an outside address (there must be none), own-domain addresses with no member, and references kept as an address by the date check.
2. **Read the lists.** If a member has an outside address, give that member an own-domain address or delete the account, before the run.
3. **Announce a window.** Take a **Full + S3** backup and copy it off the server. A plain Full backup does **not** hold the container databases of an `s3` mount ([BACKUP.md](../BACKUP.md)).
4. **`./eigen stop`.** A clean stop also empties the upload queue.
5. **Run the script** against the data folder and the bucket. It reads `users3.db`, then converts every Home, then downloads, converts and uploads every chat, document and comment database.
6. **`./eigen update`** to 0.5.0 and start.
7. **Verify.** No own-domain address left in a reference column unless it is on a dry-run list. Row counts equal. Then by hand: open one chat, one document with comments, one stickies board, one shared calendar, and sign in as a guest.
8. **Take a new Full + S3 backup.** Every older backup of eigen.is is now only good for a rollback.
9. **Delete the script.**

Phones and calendar apps sync the changed events once, because a stamp changes the stored bytes.

**Rollback:** the old release plus the backup from step 3. The text rewrite of messages cannot be undone any other way, so that backup is not optional.

### 6.3 What old-format reading stays

None.

## 7. Costs and open questions

**Costs**

- **You cannot share with a colleague before their account exists.** With SSO an account is made at the first sign-in. So a colleague who never signed in cannot be shared with yet.
- **An outside person cannot be a member.** A freelancer at jan@other.org is a guest, with what a guest can do. To be a member, Jan needs an address on a member domain, and then he starts as a new person.
- **It is large.** Changing every reader and writer (about 95 comparison places, the share dialog, chat, comments, calendar) is the biggest change before 0.5.0. The script is a few days on top.
- **Nothing from before 0.5.0 can be read.** Other installs start fresh. An old backup of eigen.is cannot be restored into 0.5.0. This fits 0.5.0, which already drops old sheets.
- **Raw data is no longer readable by eye.** Every name on screen is a lookup, so the browser needs a people cache.
- **Adding an SSO provider for a domain with guests deletes those guests.** Their old shares and messages belong to nobody afterwards.
- **The name card keeps a deleted person's name and address** inside chats and comments. An erase request needs a way to blank it.
- **A file on another server** shows names, but nobody can edit "their own" old messages there. It fails closed.

**Open question**

- An admin deletes Sara and creates her again, instead of changing her address. She is a new person and has lost everything. This needs a "merge two people" tool one day.

**Out of scope, one line each**

- **Changing an address in the Admin app:** future; Part B shows the table that makes it one step, plus the three fixes named under Sara in section 4.
- **A domain move:** future; now possible, the same step for everyone.
- **Uploading a file that came from another server:** future; the upload is a border, and the name card gives it the address to ask "Anna Jansen (anna@acme.com): which member here?". A person confirms each match.
- **Federation** (Eigen servers sharing with each other): future; the ids are random and global, so it adds a "home server" hint on the name card and a proof, and the reference does not change.

## 8. What needs the owner's yes

Only Part A. Part B has its own list.

Already ruled: follow Bluesky (id permanent, address a property); no backward compatibility in the product; only eigen.is is converted; a guest never becomes a member.

The domain rule:

- [ ] Member domains (the mail domain plus the SSO providers' domains) and guest addresses never overlap. The server refuses a member with an outside address.
- [ ] Cost 1: you cannot share with a colleague before their account exists.
- [ ] Cost 2: an outside person (a freelancer at jan@other.org) cannot be a member.
- [ ] Adding an SSO provider for a domain that has guests: the owner sees them, confirms, and they are deleted.

Stored formats:

- [ ] The reference as the stored form of a person (id, `team_<id>`, or email).
- [ ] Chats and comments store ids, with a name card. This reverses the September rule in STORAGE.md.
- [ ] A member who edits a document gets a name card row in its `comments.db`, so a card or column creator still has a name after a delete or a move.
- [ ] Mention tokens `<@…>` in message text.
- [ ] The attendee stamp `X-EIGEN-USER` in the iCalendar bytes.
- [ ] A guest stays an email. No dormant guest rows.

New layouts (each is a new schema version):

- [ ] Chat `data.db` v3 and `comments.db` v6: reference columns and the `people` table.
- [ ] Home `notifications.db` v3: the actor's reference.
- [ ] (`metadata.db` and `calendar.db` keep their layout: the reference goes into the JSON that is there. Already yes in #16: the `ssoProvider` table in `users3.db`. Part A adds nothing else to `users3.db`.)

No new route and no new package.

SSO choices:

- [ ] Old password accounts: **(a)** allow linking by address and show the owner a list, or **(b)** keep the default and let an admin mark accounts "may use SSO". Recommended: (b).
- [ ] A member who signs in with SSO is later made an admin. Remove their SSO login at that moment, or accept it for v1? Recommended: accept for v1.
- [ ] The owner route reads the provider's settings page itself, public addresses only (Tobias's proposal). Recommended: yes.
- [ ] 2FA required for the owner and admins (Tobias's suggestion). A separate change.
- [ ] `/admin/update-user` can change an address today. Refuse that in `user.update.before` until the address-change feature exists? Recommended: yes.
- [ ] The order: the identity change first, before 0.5.0. SSO starts after it, built by Tobias or by us.

# Part B: built on top, later

**Not part of the 0.5.0 work. Nothing here is in the checklist of section 8.** The owner asked two questions. Does the design fit several addresses per person? And how do I get all open comments assigned to me? Both fit. Both can be added after 0.5.0 without changing a stored format from Part A, because they only add tables.

## B1. Several addresses per person

Once a member is an id, an address is just a row that points to it. So a member can have several.

| Kind | Example | Proven by | Sign-in | Means "this person" at the border? |
|---|---|---|---|---|
| primary | anna@acme.com | the server (an admin, setup, or SSO made the account) | yes | **yes** |
| alias | a.jansen@acme.com, or an address the SSO provider sends | the server or the provider | no | **yes** |
| recovery | anna@gmail.com | the person, with a mailed code | no | **never** |

- **The primary stays where it is**: better-auth's `user.email`, which is unique and required. better-auth finds a sign-in by it. It is not copied into a second place, so there is one truth.
- **Extra addresses go in one new table in `users3.db`**, `user_address`: `userId`, `address`, `kind` (`alias` or `recovery`), `verifiedBy` (`admin`, `sso:<providerId>` or `code`), `createdAt`.
- **An alias is on a member domain**, like the primary. It is unique on the server and can never equal any `user.email`. The hooks in `auth.ts` check that in both directions.
- **A recovery address is outside every member domain.**
- **One function, `resolveAddress(address)`, is the border.** It looks at `user.email`, then at the alias rows. It never reads recovery rows. So a recovery address never gives access, and nobody can find out that anna@gmail.com belongs to an Eigen account.

**How SSO fits.** The provider's `sub` binds the login to the id. The address the provider sends is one more address of that person. If the provider later sends a new address for the same `sub`, the new one becomes `user.email` and the old one becomes an alias row with `verifiedBy = sso:<providerId>`.

**What it makes simple.** An address change is that same step, done by an admin. A domain move is that step for every account at once, after the new domain became a member domain. Nothing else is touched, because nothing else stores a member's address. (The three fixes for Sara in section 4 are still needed, and mail delivery to an alias.)

### The recovery address: the first use

Today Eigen has no "forgot password". Only an admin or `./eigen reset-password` can reset (`resetUserPassword`).

1. Anna opens her account settings and types anna@gmail.com. She must type her password again (and her 2FA code if she uses 2FA).
2. Eigen mails a 6-digit code to anna@gmail.com. She types it. The address is stored with kind `recovery`.
3. Later she forgets her password. On the sign-in page she clicks "Forgot password?" and types her Eigen address.
4. Eigen mails a reset link to anna@gmail.com. The page always answers the same: "If this account has a recovery address, we sent a mail."
5. She sets a new password. As with every reset, she is signed out everywhere and her app passwords are revoked.

Security rules:

- **Never an identity.** It is never looked up by address: Eigen only goes from the account to its recovery address. If someone shares with anna@gmail.com, that is a guest. It has nothing to do with Anna's account.
- **Codes and links** work like the guest code (`guest-auth.ts`): stored hashed, single use, short-lived, wrong guesses counted.
- **Rate limits:** a few reset mails per account per hour, and a limit per IP address, like `checkOtpRateLimit`.
- **Tell the primary address** when a recovery address is added, changed or removed, and when a reset is asked for.
- **A waiting time:** a new recovery address works only after a day. A thief with an open session cannot add one and use it at once.
- **2FA stays.** A reset does not switch off 2FA. So a stolen recovery mailbox alone cannot enter an account with 2FA.
- **If the recovery mailbox is stolen and the account has no 2FA, the thief gets the account.** This is the price of the feature.
- **Owner and admins:** a recovery address only when 2FA is on. The owner also always has `./eigen reset-password`.
- **Not for** guests (no password) and SSO-only accounts (the provider resets). A server setting turns it off for everyone.

It would need the owner's yes for: the `user_address` table, and new routes (add, confirm, remove, ask for a reset, do the reset).

## B2. "All open comments assigned to me"

Today there is no such list. The assignee sits inside each document, and only an open document counts its own (`useAssignedCommentCount`).

With ids there is one clear place to put the answer: my own Home.

- A small table in the Home, `assigned_to_me`: `owner`, `item`, `thread`, `open`, `at`, and a snapshot of the document title. (Not named "pointers": `shared.db` once had a table `shared_pointers`.)
- The truth stays in the document (`comments.assignee`). The server already goes to the assignee's Home to send the notification (`propagateAssignment`). It writes the row in the same step.
- The list is then one query in my own Home, newest first.

Honest costs:

- The row must also be updated on resolve, reopen, reassign, delete, trash and when my access is taken away. Each is a relay message.
- The list can show the title and a link without opening the document. To show the comment text it must open it.
- The table can drift. A copy or a restore of a document does not write rows. A rebuild means a scan of everything I can reach.
- A guest's rows are gone with the cleaned-up Home.

It would need the owner's yes for: a new schema version of a Home database, and a list route. Mentions ("where was I mentioned") can use the same table later.

## Words explained

- **Person id:** the fixed random code of one member (better-auth's `user.id`). It never changes and is never given to someone else.
- **Address:** an email address. A property of a person, not the person.
- **Member:** a person with a password or an SSO login. The address is always on a member domain.
- **Member domain:** a domain that belongs to this server: its mail domain, and the domain of each SSO provider.
- **Guest:** an outside person who signs in with a code sent by mail, without a password. A guest never becomes a member.
- **Guest address:** every address that is not on a member domain.
- **Reference:** the short string that names who is meant: a person id, `team_<id>`, or an email.
- **Border:** the places where an address comes in: the share dialog, a mention, a whisper target, an assignee, a calendar save, an incoming calendar reply, mail that gives access.
- **Home:** one owner's private data folder on the server.
- **Container:** a file that can travel, with its own small database: a document, a chat.
- **Name card:** a small table in a chat or comment database: id, name, last known address. For showing names only.
- **Token:** a mention stored in text as `<@id>` instead of a name.
- **Stamp:** an `X-EIGEN-*` fact in a stored calendar event that only the server can write.
- **Share registry:** a server-wide list of "this owner shares something with this guest address or team". It fills "Shared with me".
- **Cleanup:** the job that deletes guests who have not come for a long time.
- **The script:** the one-time program that converts eigen.is. It is not part of Eigen and is deleted after use.
- **SSO / OIDC:** signing in with your company account instead of an Eigen password.
- **`sub`:** the fixed id the company's login system gives each person.
- **Link (SSO):** attaching an SSO login to an account that already exists.
- **2FA:** a second step at sign-in, a code from an app or by mail.
- **Primary / alias / recovery address** (Part B): the address you sign in with; an extra address that also means you; a private outside address used only to mail a password-reset link.
- **Fails closed:** when something goes wrong, too few people get in, not too many.
- **DID / handle:** Bluesky's words for the permanent id and the changeable name.
