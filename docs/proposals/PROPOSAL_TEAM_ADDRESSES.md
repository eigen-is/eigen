# Proposal: Team mail addresses

This proposal gives a team its own mail address, such as `marketing@example.com`. Mail to it reaches every member, the way a mail group does, and the team calendar uses it as the organizer when it invites someone from outside Eigen. Today a team has no address. So nobody can write to a team, an outside guest of a team event never hears that it was canceled, and the guest's answer never reaches the event.

**Status:** not built. Teams are described in [ORGANISATIONS-AND-TEAMS.md](../ORGANISATIONS-AND-TEAMS.md), mail in [MAIL.md](../MAIL.md), invitations in [CALENDAR.md](../CALENDAR.md). [ROADMAP.md](../ROADMAP.md) tracks the work in P2, and its cheap-wins row "A team calendar has no organizer address for external guests" links this proposal.

> **TLDR:** An org admin gives a team an address on the server's mail domain, stored as a nullable, unique `email` column on the `team` row in `users3.db`. Phase 1 is receive-only. The delivery route resolves the address to the team's current members and appends one copy to each inbox, the way it already sends `postmaster@` to every admin. It runs inbound iMIP once, on the team Home, never on the members'. The team calendar names the address as `ORGANIZER` on every iMIP message to an outside guest, so the CANCEL that is skipped today goes out, and the guest's REPLY comes back to the Home that holds the event. Phase 2 lets members send as the team: Postfix asks the API which addresses a login may use, and the composer gets a From picker. That one list of addresses is also what the deferred alias row waits for. Phase 1 needs no Postfix change, and neither phase needs a new DKIM key. Phase 1 is S–M, phase 2 is M.

## The problem

- **Nobody can write to a team.** An org that wants `sales@` makes a user account and shares its password, or does without. Mail has one mailbox per user and none per team, and a mail client may only send as its own login.
- **An outside guest is never told an event was canceled.** A member invites a customer to an event on the team calendar. The invitation arrives from the member's own address. When the event is deleted, the server has no team address to send the CANCEL from, so it skips it and logs a warning. The customer keeps the event.
- **An outside guest's answer is lost.** The customer accepts, and the reply goes to the member who sent the invitation. That member's own calendar does not hold the event, so the reply matches nothing and is dropped. The team event keeps showing the customer as not answered.
- **The organizer changes under the guest.** An update goes out from whichever member made it. The customer's calendar app sees a second organizer for the same event and may not match it to the first.
- **A team can't be invited.** An outside organizer has no address to invite the team as a whole.

## What exists today

| Piece | Where | State |
|---|---|---|
| Mailboxes | `docs/MAIL.md:5` | One per user. No team and no guest has one |
| Team Home | `apps/api/src/lib/home/team-home.ts:38-40` | Builds drive and calendar only, no `Mail` |
| Team Home's user | `getSyntheticTeamUser`, `team-home.ts:15-21`, built at `apps/api/src/lib/home/get-home.ts:111` | Synthetic, with the team name and an empty email |
| Team row | `apps/api/auth-schema.ts:112-121` | Id, name, org, member count. No address. Additive columns are added at boot by `ensureAuthSchemaColumns` (`apps/api/src/lib/auth/auth.ts:58`) |
| Accepted recipients | `docker/postfix/main.cf.template:16-20` | Every local part on the mail domain, with no recipient map. Each recipient is piped alone to `eigen-deliver` (`docker/postfix/master.cf.template:69-70`), whose `D` flag prepends `Delivered-To:` |
| Unknown recipient | `docker/postfix/eigen-deliver:14` | The API's 404 becomes `EX_NOUSER`, a bounce |
| Delivery fan-out | `mailboxDeliver`, `apps/api/src/lib/mail/mail.ts:18-31` | A user gets the bytes. A role address (`postmaster`, `abuse`, `noreply`) goes to every org admin, one `mailboxDeliver` per admin. A throw partway makes Postfix redeliver, which duplicates the message for the admins already done (`mail.ts:25`) |
| iMIP at delivery | `Mail.mailboxDeliver`, `apps/api/src/lib/mail/mail-domain.ts:132-154` | Appends to INBOX, then runs `processInboundImip` on that Home. One call does both |
| Reserved addresses | `isRoleAddress`, `apps/api/src/lib/config/server-config.ts:111`; `ROLE_MAILBOX_LOCAL_PARTS`, `packages/lib/src/validation/username.ts:3` | `rejectRoleAddress` (`auth.ts:99`) refuses them on user create and update (`auth.ts:148`, `:174`) |
| Submission | `docker/postfix/sender_login.regexp:5`, enforced at `master.cf.template:24` and `:38` | An identity map: the login must equal `MAIL FROM`. `MAIL.md:83`: "There are no aliases, so login and sender are one string" |
| Web send | `docs/MAIL.md:69` | The save before a send pins From to the account |
| API outbound | `sendsAsThemselves`, `apps/api/src/lib/core/mailer.ts:73-76`; `buildMailOptions`, `mailer.ts:123-134` | Any address on the mail domain goes out as itself when hosted mail is on. Otherwise mail goes out "via" the system sender |
| DKIM | `docker/postfix/entrypoint.sh:97` and `:103` | One OpenDKIM key signs for the whole mail domain (`Domain ${MAIL_DOMAIN}`), and stamps `Authentication-Results` with the mail domain as authserv-id |
| Outbound organizer | `apps/api/src/lib/calendar/invite-propagation.ts:94`, `:117`, `:144`, `:165` | The acting member, for invite, relay copy, removal and update |
| Outbound CANCEL | `propagateCancellation`, `invite-propagation.ts:228-231` | Takes the Home's user. A team's is empty, so the mail to an outside guest is skipped and logged |
| From of an iMIP mail | `apps/api/src/lib/calendar/imip.ts:83`, `:105` | The organizer's address |
| Inbound verdict | `verifyImipSender`, `apps/api/src/lib/mail/imip-auth.ts:49-67` | An aligned `dkim=pass` under our own authserv-id |
| Inbound REPLY | `processInboundImip`, `imip.ts:257-261` | Looks the UID up in the receiving Home's own calendar, so a REPLY that lands in a member's Home misses a team event |
| Self-check | `imip.ts:221` | A REQUEST or CANCEL from the Home's own address is dropped |
| "Is this someone else's invitation" | `isInvitationFromOthers`, `packages/lib/src/core/calendar/calendar-utils.ts:184-189` | With an owner address, compares `ORGANIZER` to it. Without one, as on a team Home, reads Eigen's organizer stamp |
| Cross-home writes | `scripts/check-home-imports.ts:12` | `lib/mail/mail.ts` is on the `getHome` allowlist, which is how the role fan-out reaches other Homes |
| Team settings in Admin | `apps/admin/src/components/admin/team-settings-section.tsx` | Calendar toggle and member access, avatar |

## Phase 1: a receive-only group address

### The address is a column on the team row

The address goes in a nullable `email` column on `team` in `users3.db`, with a unique index. Delivery looks an address up server-wide on every message, as `getUserByEmail` does for users. A team's `settings.json` lives in its own Home, so finding the team for an address there would mean opening every team Home. `ensureAuthSchemaColumns` adds the column at boot. SQLite cannot add a unique column with `ALTER`, so the unique index is created beside it, as `membership_key` already is. Check whether better-auth's organization plugin accepts the column as an additional team field, so its own team reads and writes keep it; if not, Eigen reads and writes it with its own query.

A local part on the mail domain belongs to one user, one team or one role, never two. So one function answers "who owns this address" (user, team, role or nobody), and every check uses it: setting a team address, `rejectRoleAddress` on user create and update, the username validator, and the delivery route. That keeps the namespace one fact in one place.

### Delivery fans out in the API, not in Postfix

Postfix can expand a group itself with `virtual_alias_maps`. The API can also do it, in the route it already has.

| | Postfix `virtual_alias_maps` | Fan-out in the delivery route |
|---|---|---|
| Where membership comes from | A map Postfix reads, rebuilt or looked up from the API on every change | The `team_member` rows, read per message |
| A member leaves | Stale until the map is rebuilt | Takes effect on the next message |
| Retry | Postfix queues and retries each member alone | One request for all members. A failure partway redelivers to all of them |
| Inbound iMIP | The API sees one delivery per member and can't tell they were one team mail | Runs once, on the team Home |
| `Delivered-To:` | The member's address | The team address, so a member's mail client can filter team mail |
| Change | A map file and a reload, or a lookup service | A team branch in `mailboxDeliver` (`mail.ts:18-31`) |

The recommendation is the delivery route. It is the role-address path with a second kind of recipient, it is the only way to route iMIP to the team Home, and it never delivers to a former member. Postfix needs no change, because it already accepts every local part and pipes it with the address as given. The cost is the retry: a failure partway duplicates the message for the members already done, as the role fan-out does today. A local append rarely fails, so phase 1 accepts it. If it bites, the fix is a Message-ID column in `mail.db`, so a redelivery skips a member who has the message. That is a `mail.db` schema change.

Guest-role users are skipped, since a guest has no mailbox. Each member gets the usual new-mail notification, because the copy is an ordinary delivered message.

### Inbound iMIP runs on the team Home only

`Mail.mailboxDeliver` appends and scans in one call. The team branch needs them apart: it appends to each member with the scan off, then runs `processInboundImip` once on the team Home, with the verdict from `verifyImipSender`. A REPLY must reach the Home whose `calendar.db` holds the event, and that is the team's. A REQUEST to the team belongs on the team calendar. Scanning in every member's Home would file one copy per member, and each copy would answer the organizer on its own.

`processInboundImip` takes a `Home` and uses only its calendar and its address, so a `TeamHome` fits. A team calendar that is off throws 404 from the getter (`team-home.ts:45-47`), and the delivery's existing catch logs it, so the mail still lands. The self-check at `imip.ts:221` compares the sender with the team address on a team Home.

### The team calendar organizes as the team

On a team Home with an address, every outbound iMIP message names the team address as organizer and sends from it: invite, update, removal and cancel. The relay copy for an Eigen attendee names it too (`invite-propagation.ts:117`), so the attendee sees the team, not whichever member last saved. The skip at `invite-propagation.ts:228-231` stays only for teams without an address.

Sending needs nothing new. `sendsAsThemselves` lets any address on the mail domain go out as itself when hosted mail is on, and OpenDKIM signs for the whole domain, so the From is DKIM-aligned at the guest. A receiving Eigen verifies it like a user's mail.

The synthetic user's email stays empty, and `TeamHome` carries the address as its own field. `home.user.email` means "the owner's own address" to `isInvitationFromOthers`, the REPLY lookup (`imip.ts:260`) and the web app's hook. A team calendar answers that question with Eigen's organizer stamp, because an event a member writes from a CalDAV client carries the member's address ([CALENDAR.md § An attendee may re-alarm a copy and nothing more](../CALENDAR.md#an-attendee-may-re-alarm-a-copy-and-nothing-more)). Filling `user.email` would switch the team calendar to the address rule, and every such event would lock. That is the alias problem of the deferred row, on a small scale.

A guest invited before the team had an address holds a copy that names the member. The next update names the team, and the guest's calendar app may file it as a second event. Pre-1.0 this is accepted, and nothing on Eigen's side records who sent a past invitation: the organizer is added per message (`withOrganizer`, `imip.ts:59`), never stored on the organizer's copy.

A team address needs hosted mail. Without it, nothing delivers to the address, and outbound mail goes out "via" the system sender, which is the [ROADMAP](../ROADMAP.md) row "Eigen-to-Eigen invitations sent "via" lose their iMIP effect". So the admin field shows only when hosted mail is on, and the calendar falls back to today's behavior without it.

## Phase 2: sending as the team

### Postfix asks the API who may send as an address

`smtpd_sender_login_maps` answers, for an envelope sender, which logins own it, and it may answer with a list. Today it is an identity regexp. Phase 2 puts a lookup in front of it that answers `marketing@example.com` with every member's login, and "not found" for any other address, so the identity regexp still answers for a user's own address. Postfix takes the first map that matches, which is why the order matters.

There are two ways to feed that lookup. The API can answer a Postfix `socketmap:` lookup on the internal network, guarded like `/internal/auth/verify`. Or the API can write a map file to a shared volume that Postfix reads again when its processes restart. The socketmap is live, like the delivery fan-out. The file is stale between a membership change and the next restart, which lets a member who just left keep sending as the team. The recommendation is the socketmap. `docker/test-mail-hardening.sh` gains a member sending as the team, accepted, and a non-member, refused.

### The composer offers the team as From

The save before a send pins From to the account ([MAIL.md § Delivery attempts every copy and retries none](../MAIL.md#delivery-attempts-every-copy-and-retries-none)). Phase 2 lets the composer pick from the user's own address and their teams' addresses, and the server checks the pick against the same list, never trusting the draft's From. The sent copy files in the sender's own Sent. A reply to that mail comes back to the team address and so to every member.

### DKIM needs nothing new

One key signs for the mail domain (`entrypoint.sh:97`), and a team address is on that domain. Mail a member submits as the team is signed the same way as mail they submit as themselves. No new selector and no DNS change.

### The alias question

Once a member may send as `marketing@`, their calendar app may write `ORGANIZER:mailto:marketing@…` on events in their own calendar. `isInvitationFromOthers` compares that with the member's one address, and the event locks: the deferred row "An event organized from an alias address stays locked". That row waits for Mail to have aliases. Phase 2 gives it the list it waits for: the addresses a user may send as, which are their own and their teams'. One function computes it, and it feeds the socketmap answer, the composer's picker, the server's check of the pick, `isInvitationFromOthers` and the inbound self-check. The last two run in the web app too, so the list has to reach the client, for example on the session's user. Personal aliases, if they ever come, are a second source for the same function.

## Open questions

1. **Who picks the address, and what is it?** Recommendation: an org admin picks it per team, on the mail domain, with the team name as a suggested local part. No team gets one by default, because the default team holds every user and would become an all-staff list anyone on the internet can write to. Changing or clearing an address is allowed and takes effect at once. The dialog warns that outside guests' copies of earlier events still name the old address.
2. **What happens when a member leaves?** Recommendation: nothing to clean up. Delivery reads the members per message, so the next message skips them, and in phase 2 the live lookup ends their send-as at once. Mail they already got stays theirs, as with a mailing list. Events they organized stay the team's, organized by the address, which is the point of the change. When the last member leaves, mail to the address goes to the org admins, as role-address mail does, rather than bouncing a customer's message, and the Admin app flags a team that has an address and no members.
3. **Do replies land in each member's inbox or in a shared one?** Recommendation: each member's inbox. It is what a mail group does, and it reuses everything that exists. A shared team inbox needs a Maildir in `TeamHome`, an ACL on Mail routes that are `requireSelf` today ([MAIL.md § Mail is personal and sits behind a swappable store](../MAIL.md#mail-is-personal-and-sits-behind-a-swappable-store)) and a Dovecot shared namespace: its own proposal. One side effect: each outside guest's RSVP mail lands in every member's inbox, as an RSVP lands in a user's inbox today.
4. **Where does the setting live in the UI?** Recommendation: Admin, the team's settings section (`team-settings-section.tsx`), next to the team calendar toggle, since both are org-admin settings of a team and both sit behind `requireTeamAdmin`. Hidden when hosted mail is off. Members see the address where it acts: as the organizer on the team calendar's invitations, and in phase 2 in the From picker. The help center's team and calendar articles change in the same cycle.

## Size and risk

| Phase | Delivers | Size |
|---|---|---|
| **1** | The `team.email` column and its unique index, the one address-owner function and its checks, the Admin field, the team branch in delivery with the scan split out, iMIP on the team Home, the team as organizer in outbound iMIP and relay copies, tests | S–M |
| **2** | The socketmap lookup and Postfix wiring, the composer's From picker and the server check, the sendable-address list in `isInvitationFromOthers` and the self-check, hardening-script cases | M |

The seams where this can go wrong:

- **ACL.** Only an org admin sets an address (`requireTeamAdmin`). Only a member sends as it, and never a guest. The list of sendable addresses is computed on the server from `team_member`, and every use of it, the composer's pick included, is checked there.
- **Cross-home relay.** The fan-out writes into other Homes through `getHome`, which works because `mail.ts` is on the allowlist. With Homes on several processes, each append and the team Home's iMIP become relay pushes ([SCALABILITY.md](../SCALABILITY.md)). Writing the fan-out as one call per Home keeps that a mechanical change. There is no durable outbox today ([PROPOSAL_HOME_RELAY_OUTBOX.md](PROPOSAL_HOME_RELAY_OUTBOX.md)), so a crash partway leans on Postfix's retry.
- **Persisted formats.** One additive column and one index in `users3.db`, added at boot. No Yjs root, no MIME constant and no `calendar.db` change, because the organizer is added per message and never stored on the team's copy. What changes is outside Eigen: guests' calendars keep the member as organizer for events invited before the switch.
- **Spam.** An address that reaches every member multiplies each spam message by the team's size. [PROPOSAL_RSPAMD.md](PROPOSAL_RSPAMD.md) is the filter.

## Testing

- A message to the team address lands in each current member's INBOX once, skips guests and former members, and carries the team in `Delivered-To:`.
- An outside REQUEST to the team address files one event on the team calendar and none in members' calendars. With the team calendar off, the mail still lands.
- An outside guest's REPLY to a team event updates the team event.
- Deleting a team event mails the outside guest a CANCEL whose From and `ORGANIZER` are the team address.
- A team address can't be set to a user's address, a role address or another team's, and a user can't sign up or rename to a team's address.
- Phase 2: a member submits as the team on 587 and 465, a non-member is refused, and a member removed from the team is refused on the next attempt. An event a member's CalDAV client writes with the team as organizer stays editable.
