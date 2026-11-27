# Identity: how Eigen names people

**Status:** ruled, not built. The owner ruled on every point on 27 November 2026, and again after two cold reviews attacked the design that day; [section 8](#8-the-owners-rulings) lists the rulings. Raised in [issue #16](https://github.com/eigen-is/eigen/issues/16). Related: [PROPOSAL_SSO.md](PROPOSAL_SSO.md), [ACL.md](../ACL.md), [STORAGE.md](../STORAGE.md), [CALENDAR.md](../CALENDAR.md), [SERVER-SETTINGS.md](../SERVER-SETTINGS.md).

The document has two parts. **Part A** is the identity change, the work for 0.5.0. **Part B** shows what can be built on top later. Part B is not part of the 0.5.0 work.

## In short

- A member is a **permanent id**. The address (anna@acme.com) is only a **property** of that member. It can change.
- Where Eigen stores "this person", it stores one string, the **reference**: the member's id, `team_<id>` for a team, or a plain email address for an outside person (a guest). This is the only way a person is stored, everywhere.
- **Members and guests never mix.** A member's address is always on one of the server's own domains. Every other address is a guest address. A guest never becomes a member.
- **A member's address is never used to say who someone is.** The browser sends references too. An address is translated to an id only where one comes in from outside: typed by hand, or written by a phone or a mail. A new account with an old address gets a new id, so it inherits nothing.
- A deleted member's name is kept in **one list on the server**, the former members. No file keeps its own list of names.
- The product gets **no backward compatibility**. Every managed database restarts its numbering at 100, which means the 0.5.0 layout. eigen.is is converted once, by a throwaway script. SSO comes after the identity change is done.

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
| A share made before her account existed | It waits for whoever gets the address first (`reconcileShares` runs when an account is created). | Real |
| Team chats (she joins the default team on day one) | Old Anna's messages are "hers". She can edit and delete them (`ChatRoom.editMessage`, `deleteMessage`). | Real |
| Whispers (private messages inside a chat) | She reads what old Anna sent and got (`ChatRoom.getMessagesForUser`). | Real |
| Bob clicks "Start chat" with Anna | Eigen opens Bob's old private chat with old Anna (`findChatsByMembers`). | Real |
| Notifications and "Email collaborators" | She gets text from chats where old Anna once posted. | Real |
| Comments and assignments | Old Anna's open assignments show as hers. | Misleading |
| Calendar events where old Anna was a guest | At the organizer's next edit the event lands in her calendar (`propagateInvitation`). | Real |
| Names and photos on old content | Old messages, notifications and history rows show new Anna's name and photo (`getPublicInfo` looks up by address). | Misleading |
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

**One rule: references everywhere, also on the way in.** A picker hands the browser a reference, and the browser sends that. A name or an address is only something a screen shows, through one lookup by reference ([3.9](#39-former-members-and-showing-a-person)).

**The border is where an address comes in from outside.** There an address is translated, once: an address a person types by hand that is in no list (the share dialog, a typed `/whisper` or emote target), a calendar save from a phone, an incoming calendar reply, and mail that gives its recipients access (`grantAccessForReferences`).

## 3. The rules

### 3.1 The reference

A reference is one short string that names who is meant. It is the only way Eigen stores a person: in a share, a message, a comment, an assignment, a mention, a history row and a notification.

| Kind | Form | Example |
|---|---|---|
| email | a valid address, lower case | `jan@other.org` |
| team | `team_` + 32 letters and digits | `team_Qk3…` |
| org | `org_` + 32 letters and digits (only as the owner of a Home) | `org_9fB…` |
| person | 32 letters and digits | `7OEwianTfhULu6iG8wQz4G2dO5G2w0B4` |

The parser lives in `packages/lib/src/types/owner.ts`, next to `parseOwnerId`, so the server and the browser use the same one. It checks in the order of the table: first "contains `@` and is a valid address", then the two prefixes, then the bare id, else invalid. The address check must come first, because `team_lead@other.org` is a valid address. Today `parseOwnerId` answers `user` for both an id and an address. That is split into `person` and `email`. The old form `external_<email>` disappears: the product no longer reads or writes it.

Two functions answer every identity question. `isRef(ref, caller)`: is this caller that reference, or a member of it? `resolveRef(ref)`: which accounts are behind it now? A deleted person gives none. Today these questions are asked in about 55 places in the API and 40 in the browser, in slightly different ways.

A guest also has an account id while their account exists, and it looks like a member's id. **A guest's id is never stored as a reference.** The format cannot enforce that, only the server can, where a reference comes in. So each such place has a test for it. To check in the spec: whether `path_watchers.userId` can hold a guest's id today.

The reference gets a type of its own in `packages/lib`, so code cannot pass a plain address where a reference is expected.

**The server checks every reference it receives.**

- A person id must belong to a member who exists now, never to a guest and never to a former member.
- A reference that points at something that is already there (an entry in a share list, the person who sent an access request) must be the one stored there. So removing a share or changing its rights takes the stored reference, never an address that is looked up again.
- An email on a member domain is never stored as it is ([3.2](#32-members-and-guests-never-overlap)).
- An id from the browser is always checked and never trusted. It grants nothing by itself: a sharer may share with any member anyway.

Which kind is allowed where:

| Place | person | team | email |
|---|---|---|---|
| Drive share, calendar share | yes | yes | yes |
| Chat author, whisper target, comment author, card or column creator, assignee | yes | no | yes |
| The actor of a history row or a notification | yes | no | yes |
| Mention token | yes | later | yes |
| Calendar attendee (the id stamp) | yes | no | no stamp |
| Owner of a Home (`:ownerId`) | yes | yes | never |

### 3.2 Members and guests never overlap

A **member** is a person with a password or an SSO login. A **guest** is an outside person who signs in with a code sent by mail. One rule keeps them apart for good:

**Member domains and guest addresses never overlap.**

- A **member domain** is the server's mail domain (acme.com), the domain of each SSO provider, and any domain a member still has an address on. This is the one definition, and one function answers it. Today `requestOtp` asks only about the mail domain (`isInternalAddress`).
- **A member's address is always on a member domain.** The screens already do this: setup, the Admin app and the waitlist all build `username@mailDomain`. The server now checks it too, in `user.create.before` and `user.update.before`. Creating a member with an outside address is refused. Guest creation does not pass that hook, so every account the hook sees is a member.
- **Every other address is a guest address.** A guest can never have an address on a member domain. Eigen already refuses a guest on its own mail domain (`requestOtp` in `guest-auth.ts`, and SERVER-SETTINGS.md). This is extended to the SSO domains.
- **So a guest never becomes a member, and a stored email never turns into an id.** There is nothing to rewrite, ever.

The code already refuses to turn a guest account into a member (`/admin/set-role` and `/admin/update-user` in `auth.ts`). That alone does not hold, because the guest account is temporary: the cleanup deletes it and the stored address stays. Only the domain rule makes the promise true.

What the server does with an address that comes in:

1. **On a member domain:** look up the member. Found: store the id. Not found: refuse. It is never stored as an email, and nothing waits for a future account. The message tells the user what to do: "No account with this address yet. Ask an admin to create it, or share with a team."
2. **Outside:** store the email. A stored email is a guest, always. It never matches a member and never shows a member's name or photo. So `isRef` matches an email reference only against a guest caller, never by comparing addresses alone.

Where Eigen cannot refuse (an attendee line that a phone wrote, a mail recipient), an address on a member domain with no member is simply nobody: no stamp, no access and no invitation mail.

One exception exists on eigen.is only: the conversion leaves an own-domain address as it is when it cannot say whose it was ([6.2](#62-what-the-script-changes-on-eigenis)). Such an address belongs to nobody. It shows as the plain address and never takes a name from a contact card, or old Anna's messages would show new Anna's name.

A guest still has a user row while they are active. It is only a way to sign in, and the cleanup may delete it.

### 3.3 Decisions where the research disagreed

| Question | Decision | Why, in one line |
|---|---|---|
| A person without an account: a person row, or a plain email? | **A colleague: refused until the account exists. An outsider: a plain email.** | No "ghost" rows, and no stored email that later has to become an id. |
| A guest who is cleaned up: keep the row asleep, or stay an email? | **A guest stays an email.** The cleanup works as today. | A guest proves the mailbox at every sign-in, so for a guest the address is the identity. |
| Deleted member: keep the row forever? | **No, delete it as today. One row in the list of former members keeps the name.** | The id is random and never made twice, and a restore brings back the same id. |
| Where does a deleted member's name live: in each file, or on the server? | **On the server, in one list.** | A deleted member is a fact about the server. One list has one writer and one place to forget a person. |
| Calendar attendee: store the id instead of `mailto:`? | **No. `mailto:` stays, plus an id stamp.** | The iCalendar bytes are what phones sync. |

### 3.4 What is stored in Homes

A Home is one owner's private data folder. Shares, history and notifications live there.

- Drive shares (`paths.acl` in `metadata.db`) and calendar shares (`calendars.shares` in `calendar.db`): the entry names its person by a reference, in `id` for a Drive share and in `targetId` for a calendar share. `{ id: "7OEw…", read, write }` for Anna, `{ id: "jan@other.org", … }` for Jan.
- The browser sends references, and the server checks each one ([3.1](#31-the-reference)). Adding takes a reference. Removing a share and changing its rights take the stored reference, and the server checks it is on that entry. Today the route takes a list of addresses to remove, so removing "Anna Jansen (deleted)" by her old address would hit new Anna's entry.
- A share whose person was deleted shows as "Anna Jansen (deleted)", with a remove button. The name comes from the list of former members ([3.9](#39-former-members-and-showing-a-person)).
- History (`file_events`) and notifications each store one field, `actor`, a reference. Today history has `actorUserId` and `actorEmail`, and a notification has `actorEmail`. Both address fields go, and so does `actorUserId`, which today also holds a guest's account id.
- A history row's details name people too: who was added to or removed from a share (`acl-changed`) and who was assigned (`assigned`). These hold references. The browser decides "you" by comparing references, not addresses (`describeFileEvent`).
- A notification's tag names a person in two cases: the requester of an access request (`accessRequestTag`) and a mention (`chatMentionTag`). Both hold a reference.
- **An access request remembers the requester's reference.** Today its notification remembers the address, and opening it fills the share dialog with that address (`shareEmail=` in `resolve-link.ts`). With an address, an old request from a deleted Anna would hand the file to the new holder of her address. With a reference, the dialog shows "Deleted account" and the share is refused.
- The share registry (`eigen.db`) stays as it is. It is only used, as today, to fill "Shared with me" for a guest and for a team.

### 3.5 What is stored in containers

A container is a file that can travel: a document, a chat.

- Authors, whisper targets, comment creators, resolvers, assignees and mentions are references.
- **No container keeps a list of names.** A member's name is looked up by id. A deleted member's name comes from the server's list of former members ([3.9](#39-former-members-and-showing-a-person)).
- **A card's creator.** A card is a task on a Stickies board and a comment in every other document. Its `creator` lives inside the collaborative document, and the browser writes it. It stores a reference and is only shown. The server decides nothing with it. The same holds for the `creator` on a Stickies column.
- `comments.createdBy` in the document's `comments.db` is dropped. The server writes it when a card's thread is created (`seedCommentRow`), and nothing reads it.
- The board's filters compare references, not addresses (`matchesCommentFilter`).
- This reverses the rule in [STORAGE.md](../STORAGE.md) ("Containers name users by email, never by id"). That section must be rewritten: a container names a member by id, the names come from the server, and an export carries the names with it ([Part B](#b3-noted-during-the-rulings)).

**Mentions are tokens.** Today a mention is "any address found in the text" (`extractMentionedEmails`). That is replaced by a token the picker inserts: `<@7OEw…>` for a member, `<@jan@other.org>` for a guest. It is shown with today's name. Copied as plain text it becomes "@Anna Jansen". A built-in emote stores `$key:<reference>` the same way. An address someone just types ("mail me at jan@x.nl") is plain text and notifies nobody.

- The picker works as today: type `@` and part of a name or an address, and Tab or Enter picks a person from the chat's members.
- **The server checks every token when a message is saved.** The token comes from the browser, so the server confirms that the id is a member who can see the chat, and refuses a guest's id.
- Tokens are read before the text formatting, so `<…>` is not taken for a link or a tag.
- The search index and the preview line of a thread store the name, not the token. Otherwise a search for "Anna" finds no mentions of her.
- **A typed target is a border.** `/whisper anna …` and an emote's target are typed text that the server parses (`parseCommand`). The server resolves the typed target among the chat's members and stores the reference. The pill covers only the picked case.

Every reader of message text learns tokens. Today each of these finds people with the address pattern or cuts raw text:

| Reader | What changes |
|---|---|
| The notification text (`ChatRoom`, the first 100 characters of a message) | It cuts on a token's edge, never through one, and shows the name. |
| `formatChatPreview` and the `commented` preview in a history row | They show the name for a token. |
| `formatEmoteForViewer` | It builds the sentence from the author's reference, with a looked-up name. |
| `searchableMessageText` and the Drive search text of a chat (`searchablePerson`) | They index the name for a token. |
| `comments.recentText` and `comments.title` | Derived text: rebuilt from the converted messages. |

**The message box becomes a rich input with a pill.** Today it is a plain text field (`chat-message-input.tsx`), and a pick puts the raw address in it. A plain text field cannot show a pill, and nobody should see `<@7OEw…>` while typing. So the box moves to the small TipTap editor Eigen already has (`LightEditor`), with three things only: text, line breaks and a mention pill. The pill is one unit: Backspace removes it whole. The same box edits a sent message. The stored message stays plain text with tokens. This is a unit of its own that lands first, still inserting addresses. The token change then only swaps what the pill holds.

### 3.6 Calendar

- **Shares:** the same rule as Drive.
- **Attendees:** the line stays `ATTENDEE:mailto:anna@acme.com`. When an address is **added** to an event and a member holds it, the server adds a stamp to that line: the parameter `X-EIGEN-USER=<id>`. A stamp is an `X-EIGEN-*` fact that only the server can write.
- **A stamp is kept, never looked up again.** `restampResource` already strips every Eigen line and parameter a client sends and copies the stored ones back. So an address that is already on the stored event keeps its stamp. Only a newly added address is resolved. Otherwise Bob's next edit would stamp new Anna.
- **A stamp belongs to the address in the whole event, not to one occurrence.** `restampResource` matches stored stamps per occurrence. When Bob moves one occurrence of a repeating event, that occurrence is a new block with no stored stamps. So an attendee's stamp is inherited by address from any block of the stored event, and only an address the stored event does not have at all is looked up.
- **An own-domain address without a stamp, or with a stamp nobody has any more, is nobody.** It gets no copy and no invitation mail. Today `propagateInvitation` mails an address that no account holds, and that mail would reach the new holder.
- This is new work in `restampResource`, and in `patchAttendees`, which the web form's save uses. Today's stamps (such as `X-EIGEN-ORGANIZER-USER` on a guest's copy of an invitation) are whole lines. A parameter on an `ATTENDEE` line does not exist yet. A server that adds a parameter to an attendee line is normal in the calendar standard (`SCHEDULE-STATUS`).
- Nothing that leaves the Home carries a stamp, with one exception that exists today: a CalDAV GET to the owner's own devices.
- Matching (RSVP, invitations, decline-on-delete) uses the stamp when there is one, and the address only when there is none (an outsider or a guest).
- Outgoing invitation mail resolves the id to today's address. An incoming reply is translated to an id on arrival.
- **The organizer line gets the same stamp.** Today "is this my own event, or someone else's invitation?" is decided by comparing the organizer's address with the calendar owner's address (`isInvitationFromOthers`). The server's guards, delete, RSVP and both dialogs use that one rule. A phone writes the owner's own address as organizer on every event with guests, so the address is all there is to compare. With a stamp on the `ORGANIZER` line the rule compares references: the event is mine when the organizer's stamp is my id, and an organizer without a stamp is an outsider, so the event is an invitation. A team calendar keeps its own rule, Eigen's organizer stamp on the event. The stamp is written and kept like an attendee's.
- For the spec: an attendee's copy of an invitation already carries `X-EIGEN-ORGANIZER-USER`, the organizer's id, as a line of its own. Whether that copy needs both.

### 3.7 Contacts

An address a user puts on a contact card is **never an identity**. That includes extra addresses on your own card. One fix: today `useResolvedUser` matches any address on any card, so if you put boss@acme.com on your own card, the boss shows under your name (in your view only). A card will be matched on the person's server-known address, and only to show a name.

### 3.8 Guests, teams, role addresses

- **Guest (Carol, Jan):** a stored email everywhere. The cleanup may delete the user row. When the guest returns, the same address matches again. Nothing is ever rewritten.
- **Team:** `team_<id>`, as today.
- **Role addresses** (`postmaster`, `abuse`, `noreply`): for mail delivery only. Refused as a share target.

### 3.9 Former members and showing a person

**One list of former members, on the server.** When a member is deleted, the server keeps one small row in `users3.db`: the id, the name, the last address and the date. The delete hook in `auth.ts` runs for every deletion, the guest cleanup included, and writes the row.

- It is not the account. It cannot sign in, and it does not reserve the address, so a new Anna can get anna@acme.com.
- A guest never gets a row. A guest is an address.
- A restore that brings a member back under the same id removes their row. A restore of one Home puts the user row back with a plain insert, past every hook (`restoreAuthRows`). So that function removes the row itself, and runs the member-domain check itself.
- An owner who must forget a person removes the row. Every lookup then answers "Deleted account". This does not reach text that was written with the name in it: a notification's title, the search text, and the `CN=` on a calendar line.
- A member deleted before 0.5.0 has no row. Their name is already gone.

**A member's address is never used to say who someone is.** It is not sent in a request, not stored, and not the question of a lookup. It still travels as something to show, to someone who is signed in: under a name in the share dialog, in the mail app, and in an invitation to an outside calendar program. The browser asks by reference and gets the address back as a property, like the name and the photo.

**Showing a person is one lookup, by reference.** The browser has one hook that takes a reference. Today `useResolvedUser` takes an id and an address side by side.

| The reference is | Shown as |
|---|---|
| the id of a member | today's name and photo |
| the id of a former member | "Anna Jansen (deleted)" |
| an id nobody knows | "Deleted account" |
| an outside email | the address, or the name on the viewer's own contact card for it |
| an own-domain email the conversion left | the plain address |
| a team | the team's name |

**The lookup is two routes.** Today `/p/users` and `/p/avatar/:emailOrId` need no sign-in. They answer for an id and for an address, and return the name and the address. So anyone can ask whether an address has an account, and get the address behind an id.

| Route | Who | Question | Answer |
|---|---|---|---|
| public, as today | anyone, a visitor on a public link included | the id of a current member or a team | the name and the photo |
| new, needs a sign-in | a member or a guest | a reference | a member: name, photo and address. A former member: the name and a "deleted" mark. |

- Neither route takes an address as the question. No route answers "who has this address?" any more. That lookup is what puts new Anna's photo on old content.
- A former member's last address is never sent to a browser. It stays in the list for a later export.
- A visitor sees "Deleted account" for a former member.

## 4. How each problem is solved

- **Old Anna, new Anna.** Bob shared a folder with old Anna: the entry says `id A`. Old Anna is deleted. New Anna gets anna@acme.com and `id B`. She matches nothing, and nothing is delivered to her. In team chats, old messages and whispers say `id A`: she cannot read the whispers or edit the messages. They show "Anna Jansen (deleted)" from the list of former members. If Bob now types anna@acme.com in the share dialog, the border gives `id B`. That entry is right too.
- **Sara.** Her address changes. Her id does not. Shares, messages, assignments and invitations to her still point to her. Her own calendar events stay hers too, because the organizer line carries her id. **Two things still break**, so changing an address stays future work and is refused until then ([section 8](#8-the-owners-rulings)): the mail and calendar apps on her phone sign in with the address, and stored organizer and attendee lines still show the old address.
- **Jan the outsider.** Bob shares with jan@other.org. It is an outside address, so the entry is the address. Jan signs in with a mailed code and gets in. He is a guest, and stays one. If Acme hires Jan, he gets jan@acme.com: a new member with a new id. Nothing moves over from his guest time. Bob shares with him again.
- **Bob wants to share with a colleague who has no account yet.** The share dialog says "No account with this address yet. Ask an admin to create it, or share with a team." An admin creates the account, and from that moment Bob can share. A share with a team reaches every new member the moment they join.
- **Carol the guest.** Carol is cleaned up after months and comes back. Same address, same shares, same authorship.
- **Bob adds people over the years.** His list holds `id A` (2025) and `id C` (2027). No dates are needed, because an id is never reused.
- **Calendar.** Bob's event has old Anna stamped with `id A`. When he edits it, or moves one occurrence, the stamp stays, and nothing goes to new Anna, no mail either.
- **An old access request.** Old Anna asked Bob for access before she left. Bob opens the notification a year later. It names `id A`, the dialog shows "Anna Jansen (deleted)", and nothing can be shared.
- **Bob removes old Anna from a share.** The browser sends the stored `id A`. New Anna's own entry, `id B`, is not touched.

What is **not** solved: mail to a reused address reaches the new holder (correct). A guest's mailbox that changes hands gives the new holder what was shared with it: for a guest the address is the person.

## 5. SSO: how it fits, and the order of work

SSO means: sign in with your company account (authentik, Keycloak). It is built after 0.5.0. The rules below are what that work must follow.

- **The login is bound to the provider and its `sub`**, not to the address. The `sub` is the fixed id the provider gives each person. better-auth already stores it (`accountId` on the `account` row) and looks it up first (`handleOAuthUserInfo`). So: provider + `sub` → person id.
- **A provider's domain becomes a member domain.** The address a provider sends must be on that provider's own domain. Any other address is refused. So an SSO login can never touch a guest.
- **Adding a provider whose domain has guests.** Say Acme adds a provider for partner.com, and three guests have partner.com addresses. The owner is shown these guests and must confirm. Then they are deleted, and the share registry rows for their addresses go too. Their old shares and messages stay under the plain address and belong to nobody. Such an entry looks dead in a share list, with a remove button. The partner.com people sign in with SSO as new members, and what they need is shared again.
- **A domain stays a member domain** as long as a member has an address on it, also after its provider is removed. Known and accepted: once the provider is removed and the last member on that domain is deleted, the domain is a guest domain again, and old stored entries match a returning guest.
- **The fallback.** When the `sub` is unknown, better-auth looks for an account with the same address and links the login to it. Today this is blocked by a default setting, `requireLocalEmailVerified`: Eigen makes every member with `emailVerified: false`.
- **Old password accounts: an admin marks each account "may use SSO".** The default stays. The mark sets `emailVerified`, which members do not use for anything else. One button can mark all current members. An account nobody marked cannot be taken over. When something is forgotten, the result is "cannot sign in", not "wrong person signed in".
- **The provider's domain is proven with a DNS record** (the plugin's `domainVerification`), which the owner sets once. Without it the plugin links nothing, marked or not. It adds one column to the provider table and two owner-only plugin routes.
- **An account that SSO creates is marked at that moment.** Otherwise, after the owner removes a provider and adds it again, those members cannot sign in until an admin marks each one.
- **The guards live in `user.validateUserInfo`.** That hook runs before the user or the login is written, and at every sign-in. It refuses an address that is not on the provider's domain, a second `sub` from the same provider for one account (same address, other `sub`, is a new person), and the owner or an admin.
- **An admin never signs in with SSO, also after a promotion.** The hook runs at every sign-in, so a member who used SSO and is later made an admin is refused at the next one. The Admin app says so at the promotion: "This person signs in with SSO. As an admin they need a password. Set one now."
- **`overrideUserInfo` stays off** in v1. It would copy the provider's address over `user.email` at each sign-in.
- **A provider's issuer cannot be edited.** The bind is to the provider's id. Delete and add again.
- **Eigen's own owner-only route reads the provider's settings page.** It accepts only public addresses and saves them directly, so `trustedOrigins` stays as it is. This is the first place where the server fetches an address a person typed, so the check is complete: every address the name resolves to is checked, the connection goes to the checked address, no redirect is followed, and there is a timeout and a size limit.
- **A setting in the server's environment allows a provider on a private network.** It is off by default. Development and the tests need it, and so does a self-hoster with a login system on a home network.

**The honest limit.** When a guard refuses a link, the new person cannot sign in at all, because the address is taken. An admin must first delete the old account.

**The order: first the identity change, then SSO.**

- SSO's guards build on Part A: a provider's domain becomes a member domain, the second-`sub` refusal, and no link to a guest. Built first, SSO would be built on the email model and have to be redone.
- The identity change moves the code SSO touches (the hooks in `auth.ts`, shares, chats, calendar). Building both at once means conflicts and rebases.
- SSO creates accounts with nobody watching. It should never run on a server whose shares still match by address.
- The identity change lands before 0.5.0. SSO starts after it is done and ships in a 0.5.x, built by Tobias (issue #16) or by us.
- The "deleted address list" from the earlier plan is dropped.

## 6. Migration

**The product has no compatibility code.** 0.5.0 reads and writes only the new format. There is no converter in the release and no upgrade step. It only refuses: data from before 0.5.0 is refused with a clear message.

- **eigen.is** is converted once, by a throwaway script. The script is never part of a release. It is deleted after the run.
- **demo.eigen.is** resets every hour. `apps/api/src/scripts/seed-demo.ts` changes to write references.
- **Everything else from before 0.5.0 is not supported:** other installs, old backups, old versions of a chat, and old downloaded files. They start fresh. One line in the changelog says so.

### 6.1 Every managed database restarts its numbering at 100

Version 100 means "the 0.5.0 layout", for every managed database. Each database gets one migration that creates that layout. The old migration history is deleted.

| Database | Version today |
|---|---|
| Mount `metadata.db` (the Drive tree, history, watchers) | 9 |
| `mail.db` | 7 |
| `contacts.db` | 5 |
| `comments.db` | 5 |
| `shared.db` | 3 |
| `calendar.db` | 2 |
| Chat `data.db` | 2 |
| `notifications.db` | 2 |
| Document `data.db` | 1 |
| Waitlist | 1 |
| Share registry (`eigen.db`) | 1 |

- **Why 100 and not 1.** The number must protect both directions. `runMigrations` in `managed-database.ts` runs every migration above the stored number and refuses only a number above its own. So a 0.4.x release that met a "version 1" database would read it as very old and run its migrations 2 to 9 over the new layout. `./eigen rollback` does exactly that: it goes back to the previous release and keeps the data when that release can open it. With 100, the old release refuses by itself ("newer than this server supports"), and 0.5.0 refuses anything below 100 as "made before 0.5.0". No separate mark is needed.
- **The server checks its data once at start** and refuses to start on data from before 0.5.0, with one clear message. Without that it would start and then fail for each Home separately.
- **Code that reads a database file directly checks the number too.** A stored version of a document is a plain copy of `data.db`, and a restore reads it with SQLite directly (`readYjsStateFromFile`), not through the managed layer. Putting back a safety copy renames a whole old Home into place (`restoreSafetyCopy`). Both refuse a file numbered below 100.
- **The document's `data.db` gets `doc_format`** in this layout: one row with the version of the content layout for that document type ([PROPOSAL_CRDT_MIGRATION.md](PROPOSAL_CRDT_MIGRATION.md#where-the-stamp-lives)). Every document has the row from the start, so that proposal's rule "no row means version 1" is not needed.
- **The reference columns get honest names:** `messages.author`, `comments.lastAuthor`, `comment_mentions.ref`, and `actor` in `file_events` and `notifications`. `comments.createdBy` is dropped.
- **The backup file** is not a managed database and has its own `formatVersion: 1`. It goes to 2, so an old backup is refused clearly too.
- **`users3.db`** has no versions. It gets the table of former members.
- **It is the last format change before 0.5.0.** A layout that is in use cannot be changed afterwards without a migration. The Sheets change that drops old sheets lands before the reset or together with it.
- **It merges late.** eigen.is updates by hand to the current `main`, so `develop` can carry the reset. But after it merges, a 0.4.x fix release can no longer be cut from `develop`.

### 6.2 What the script changes on eigen.is

Every managed database is rebuilt the same way: the script makes a fresh database with the product's own code and copies the rows in. So a converted database has exactly the layout of a new one. On top of that:

| Where | Change |
|---|---|
| Home `metadata.db` | `paths.acl` entries: address → reference. `file_events`: `actorUserId` and `actorEmail` → `actor`, and the people in `details` (`acl-changed`, `assigned`) → references. The size stored on the row of every container database the script rewrites (`paths.size`), which downloads are served from. The search text of a chat is built again. |
| Home `calendar.db` | `calendars.shares`: `targetId` address → reference. Attendee lines and the organizer line get the stamp. `external_<email>` → plain email. |
| Home `notifications.db` | `actorEmail` → `actor`. The person in a `tag` (an access request, a mention) → reference. A `body` cut from a message is cut again from the converted text. |
| Share registry (`eigen.db`) | rows for addresses on a member domain are removed. |
| Chat `data.db`, and its stored versions | `authorEmail`, `whisperTo` → references. Mentions and emotes in `content` → tokens. |
| `comments.db` | `resolvedBy`, `lastAuthorEmail`, `assignee`, `comment_mentions.email` → references. `createdBy` is dropped. `recentText` and `title` are built again from the converted threads. |
| Collaborative document `data.db`, and its stored versions | `creator` on comment cards and stickies columns → reference. The `doc_format` row. |
| `users3.db` | the empty table of former members. |

The other databases are rebuilt and their rows are not changed: `contacts.db`, `mail.db`, `shared.db` and the waitlist. The dry run checks them for stored addresses of people. Not touched at all: the content of a collaborative document (only the `creator` values change) and the attendee addresses themselves.

The table names every field that holds a person, also inside JSON and text. A field that is not on it is a bug in the table: the verify step searches every text column for an own-domain address, not only the reference columns.

The script changes a `creator` as a normal edit on the loaded document. It does not build the document again. So a browser tab that still holds the document merges cleanly after the run.

How the script decides, per address:

- **An outside address** stays a plain email. It is a guest.
- **An address on our own domain, in a share:** it becomes the id of the member who holds it today. No member holds it: it is a leftover of a deleted user, and the entry is removed.
- **A history row** already stores the true id beside the address (`actorUserId`). When its address is on our own domain, the actor becomes that id. This is exact and needs no guess, and a deleted member stays a person of their own. Otherwise the actor is the address, a guest.
- **An address on our own domain, in a message, comment, assignee, mention, notification, or the details of a history row:** it becomes the id of today's holder, but only when that account is older than the message or the row (for an assignee or a mention: older than its comment). Nobody wrote a message before their account existed. This check is kept because it matters in this one run: if an address already changed hands on eigen.is, the new holder does not get the old messages. Otherwise the address stays as it is and belongs to nobody.
- **An address on our own domain, on an attendee line:** the same check, against the date the event was created. Otherwise the line gets no stamp and that attendee is nobody, as [3.6](#36-calendar) says. Without the check, today's holder would be stamped onto old events and get them at the organizer's next edit.
- **The organizer line.** On an attendee's copy of an invitation the organizer's true id is already stored (`X-EIGEN-ORGANIZER-USER`), and the stamp takes that. In a person's own Home, an organizer address that is the owner's own gets the owner's id. Any other own-domain organizer goes through the same date check as an attendee.
- **An address on our own domain, in a `creator`:** the same check, against the date of the card's thread in `comments.db`. Not against the document's date: a copied document has a new date and old cards. A stickies column has no thread, so it is checked against the oldest thread in its document. A column that fails keeps the address, and nothing shows a column's creator.
- **Text:** only an address that passes the same check becomes a token. Every other address stays text.

"Today's holder" is a member. A guest account with an address on a member domain should not exist, and the dry run lists any it finds.

A share has no date. If an address already changed hands before the run, the new holder keeps the old shares, as today. The dry run lists what it will do, so these can be removed by hand.

### 6.3 The runbook

1. **Rehearse.** Restore a Full + S3 backup of eigen.is into a separate folder and bucket, run the script there, and start 0.5.0 on that copy. The script rewrites every database, and `metadata.db` is the file tree on a local mount, so the real run comes only after a clean rehearsal.
2. **Dry run** on the real data, read only. It prints per database: how many values of each field and how many become an id. And these lists: members with an outside address (there must be none), guest accounts with an address on a member domain (there must be none), own-domain addresses with no member, references kept as an address by the date check, and every safety copy with its date and size.
3. **Read the lists.** If a member has an outside address, give that member an own-domain address or delete the account, before the run.
4. **Clear the leftovers.** Delete every safety copy in the Admin app's backup pane, which also removes its files from the bucket. Remove what older releases left as a way back, such as an old `snapshots/` folder. Nothing of this can be read by 0.5.0.
5. **Announce a window.** Take a **Full + S3** backup and copy it off the server. A plain Full backup does **not** hold the container databases of an `s3` mount ([BACKUP.md](../BACKUP.md)).
6. **`./eigen stop`.** A clean stop empties the upload queue, up to a deadline.
7. **Run the script** against the data folder and the bucket. It first refuses to run while a safety copy, a crash leftover of a database (a temp file the server would adopt at the next open) or a queued upload exists. Then it reads `users3.db`, converts every Home, and downloads, converts and uploads every chat, document and comment database.
8. **`./eigen update`** to 0.5.0 and start.
9. **Verify.** No own-domain address left in any text column unless it is on a dry-run list. Row counts equal per table. Every database passes SQLite's integrity check and is numbered 100. Then by hand: open one chat, one document with comments, one stickies board, one shared calendar, the file history of one folder, and sign in as a guest.
10. **Take a new Full + S3 backup.** Then delete every older backup of eigen.is: none can be restored into 0.5.0. Keep the backup from step 5 until 0.5.0 has run well for a while, because it is the only way back.
11. **Delete the script.**

Phones and calendar apps sync the changed events once, because a stamp changes the stored bytes.

**Rollback:** the old release plus the backup from step 5. `./eigen rollback` does this by itself: the old release finds the data numbered 100, cannot open it, and restores the backup the update made. The text rewrite of messages cannot be undone any other way, so that backup is not optional.

### 6.4 What old-format reading stays

None. A database numbered below 100 is refused, and so is a backup with `formatVersion` 1.

## 7. Costs and open questions

**Costs**

- **You cannot share with a colleague before their account exists.** An admin creates the account first, or the share goes to a team. With SSO an account is normally made at the first sign-in, so there too an admin creates and marks it first.
- **An outside person cannot be a member.** A freelancer at jan@other.org is a guest, with what a guest can do: no drive of his own, no mail, contacts or calendar, no teams, no sharing. To be a member, Jan needs an address on a member domain, and then he starts as a new person.
- **It is large.** Changing every reader and writer (about 95 comparison places, the share dialog, chat, comments, calendar, history, notifications) is the biggest change before 0.5.0. The rich message box is a unit of its own. The script now rebuilds every database on eigen.is, and it is rehearsed first.
- **0.5.0 waits for it.** The public announcement moves by that much.
- **Nothing from before 0.5.0 can be read.** Other installs start fresh. An old backup of eigen.is cannot be restored into 0.5.0. This fits 0.5.0, which already drops old sheets.
- **Raw data is no longer readable by eye.** Every name on screen is a lookup, so the browser needs a people cache.
- **Typing an address no longer mentions someone.** You pick the person. The changelog and the help article say so.
- **Adding an SSO provider for a domain with guests deletes those guests.** Their old shares and messages belong to nobody afterwards.
- **A file copied to another server by hand shows ids and no names.** That is not supported today either. An export adds the names ([Part B](#b3-noted-during-the-rulings)).
- **The server keeps a former member's name and last address** until the owner removes the row.

**Open question**

- An admin deletes Sara and creates her again, instead of changing her address. She is a new person and has lost everything. This needs a "merge two people" tool one day.

**Out of scope, one line each**

- **Changing an address in the Admin app:** future; Part B shows the table that makes it one step, plus the two fixes named under Sara in section 4.
- **A domain move:** future; now possible, the same step for everyone.
- **Uploading a file that came from another server:** future; the upload is a border, and the exported file's list of people gives it the address to ask "Anna Jansen (anna@acme.com): which member here?". A person confirms each match.
- **Federation** (Eigen servers sharing with each other): future; the ids are random and global, so it adds a "home server" hint and a proof, and the reference does not change.

## 8. The owner's rulings

The owner ruled on every point on 27 November 2026. Only Part A. Part B has its own list.

Ruled before: follow Bluesky (id permanent, address a property); no backward compatibility in the product; only eigen.is is converted; a guest never becomes a member.

The domain rule:

- [x] Member domains (the mail domain plus the SSO providers' domains) and guest addresses never overlap. The server refuses a member with an outside address. A list of extra member domains that the owner adds by hand comes later.
- [x] You cannot share with a colleague before their account exists. The refusal says what to do: ask an admin to create the account, or share with a team.
- [x] An outside person (a freelancer at jan@other.org) cannot be a member. A tool "this guest is now this member" is a possible later addition.
- [x] Adding an SSO provider for a domain that has guests: the owner sees them, confirms, and they are deleted.

Stored formats:

- [x] The reference is the stored form of a person, everywhere: an id, `team_<id>`, or an email.
- [x] Chats and comments store references. This reverses the rule in STORAGE.md.
- [x] No file keeps a list of names. One list of former members on the server gives a deleted member a name, in every place at once. This replaces the name card of the earlier draft, and its row for every member who edits a document.
- [x] The `creator` stays on a card and on a stickies column, as a reference.
- [x] Mention tokens `<@…>` in message text. The message box becomes a rich input that shows a pill, as a unit of its own that lands first.
- [x] The attendee stamp `X-EIGEN-USER`, as a parameter on the attendee line.
- [x] A guest stays an email. No dormant guest rows.
- [x] History and notifications store one `actor` reference. `actorEmail` and `actorUserId` go.

Layouts:

- [x] Every managed database restarts in the 0.5.0 layout, and anything older is refused. The script converts all of eigen.is.
- [x] `doc_format` is part of the document's `data.db` in that layout.
- [x] One new table in `users3.db` for the former members. (Already yes in #16: the `ssoProvider` table.)

After two cold reviews attacked the design (27 November 2026):

- [x] The new numbering starts at 100, not at 1, and there is no separate mark. An old release then refuses new data by itself, so `./eigen rollback` is safe. The server checks its data once at start.
- [x] The browser sends references, never a member's address. A member's address is never used to say who someone is. The server checks every reference. Only an address that comes in from outside is translated.
- [x] The lookup of a person is two routes. The public one answers a name and a photo for the id of a current member or a team. A new one that needs a sign-in answers the rest, and never gives a former member's address.
- [x] Before the run, every safety copy on eigen.is is deleted. After it, every older backup of eigen.is may be deleted.
- [x] The organizer line of a calendar event gets the id stamp too, and "is this event mine?" compares references. The script stamps it in the same pass as the attendees, so phones sync once.

One new route for Part A: the signed-in lookup of a person. No new package.

SSO choices:

- [x] Old password accounts: an admin marks accounts "may use SSO". The provider's domain is proven with a DNS record, and an account that SSO creates is marked at that moment.
- [x] A member who signs in with SSO and is later made an admin is refused at the next SSO sign-in. The Admin app asks for a password at the promotion.
- [x] The owner route reads the provider's settings page itself, public addresses only. A setting in the server's environment allows a provider on a private network, from the first version.
- [x] 2FA required for the owner and admins: yes, but as its own item in the roadmap's Security pack, after the action that removes 2FA for a person who lost it. Not part of the identity change or of SSO.
- [x] An address change is refused in `user.update.before` until the address-change feature exists, and the admin role loses the `set-email` right until then.
- [x] The order: the identity change first, in 0.5.0. SSO starts after it and ships in a 0.5.x, built by Tobias or by us.

What the plan must respect:

- The rich message box lands first.
- The reset is the last format change before 0.5.0. The Sheets change that drops old sheets lands before it or with it.
- The reset merges when no 0.4.x release is expected any more.
- The script is rehearsed on a restored copy of eigen.is before the real run.

# Part B: built on top, later

**Not part of the 0.5.0 work.** The owner asked two questions. Does the design fit several addresses per person? And how do I get all open comments assigned to me? Both fit. Both can be added after 0.5.0 without changing a stored format from Part A, because they only add tables.

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

**What it makes simple.** An address change is that same step, done by an admin. A domain move is that step for every account at once, after the new domain became a member domain. Nothing else is touched, because nothing else stores a member's address. (The two fixes for Sara in section 4 are still needed, and mail delivery to an alias.)

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

## B3. Noted during the rulings

Four things came up while the owner ruled. None is part of 0.5.0.

- **Extra member domains.** The owner adds a domain by hand, such as acme.nl beside acme.com. The rule of section 3.2 stays as it is, because it already works on a list of member domains. Mail to such a domain only arrives when the server hosts it.
- **"This guest is now this member."** A tool for an admin that moves a guest's shares to a member once, by hand, with a person confirming it. It is the same kind of tool as "merge two people".
- **The names in an exported document.** [PROPOSAL_PORTABLE_DOCUMENTS.md](PROPOSAL_PORTABLE_DOCUMENTS.md) builds an export from its parts and does not copy the bytes on disk. So the export writes one more part, a list of every id the package names with the name and address at that moment, from the user list and the list of former members. On upload the importer reads it. Two things are designed then: an id in an uploaded file proves nothing and gives nobody rights, and the names of people from another server need a place, which is the moment a small list of people inside an imported file earns its place. That proposal still says a container names people by email, and it is updated when the identity change lands.
- **A board's history inside the document.** A plan to keep "Anna moved card X" and "Bob created column Y" in the document. The actors are references, and their names come from the same lookup as everything else. The column `creator` is kept for this.

## Words explained

- **Person id:** the fixed random code of one member (better-auth's `user.id`). It never changes and is never given to someone else.
- **Address:** an email address. A property of a person, not the person.
- **Member:** a person with a password or an SSO login. The address is always on a member domain.
- **Member domain:** a domain that belongs to this server: its mail domain, and the domain of each SSO provider.
- **Guest:** an outside person who signs in with a code sent by mail, without a password. A guest never becomes a member.
- **Guest address:** every address that is not on a member domain.
- **Reference:** the short string that names who is meant: a person id, `team_<id>`, or an email. The only way a person is stored.
- **Border:** the places where an address comes in from outside and is translated: an address typed by hand, a typed whisper or emote target, a calendar save from a phone, an incoming calendar reply, mail that gives access.
- **Home:** one owner's private data folder on the server.
- **Container:** a file that can travel, with its own small database: a document, a chat.
- **Former member:** a member whose account was deleted. The server keeps one row with the id, the name and the last address, only to show the name.
- **Token:** a mention stored in text as `<@id>` instead of a name.
- **Pill:** how a mention looks in the message box and in a message: the person's name as one unit.
- **Stamp:** an `X-EIGEN-*` fact in a stored calendar event that only the server can write.
- **Share registry:** a server-wide list of "this owner shares something with this guest address or team". It fills "Shared with me".
- **Cleanup:** the job that deletes guests who have not come for a long time.
- **Managed database:** a SQLite file the server opens through one layer that knows its layout version.
- **The reset:** every managed database restarts its numbering at 100, which means the 0.5.0 layout. A lower number is refused.
- **Safety copy:** the Home as it was before a restore, kept beside the restored one.
- **The script:** the one-time program that converts eigen.is. It is not part of Eigen and is deleted after use.
- **SSO / OIDC:** signing in with your company account instead of an Eigen password.
- **`sub`:** the fixed id the company's login system gives each person.
- **Link (SSO):** attaching an SSO login to an account that already exists.
- **2FA:** a second step at sign-in, a code from an app or by mail.
- **Primary / alias / recovery address** (Part B): the address you sign in with; an extra address that also means you; a private outside address used only to mail a password-reset link.
- **Fails closed:** when something goes wrong, too few people get in, not too many.
- **DID / handle:** Bluesky's words for the permanent id and the changeable name.
