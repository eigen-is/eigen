# Calendar Invitations and iMIP

> **TLDR:** An organizer's event with attendees puts a linked copy into each Eigen attendee's default calendar over the home relay, and mails everyone else an iMIP invitation (RFC 6047). Out is `invite-propagation.ts`, in is `invitations.ts`, mail is `imip.ts`, all in `apps/api/src/lib/calendar/`. Not obvious from the code: the link is a server stamp, never the `ORGANIZER` address. Every inbound REQUEST, relayed or mailed, takes one locked decision, ordered by SEQUENCE then DTSTAMP. Inbound mail acts only for a sender our own MTA verified. The store: [CALENDAR.md](CALENDAR.md).

## A linked copy is an ordinary resource with the organizer's stamp

An attendee's copy is a resource in their calendar whose VEVENTs carry `X-EIGEN-ORGANIZER-EVENT` and `X-EIGEN-ORGANIZER-USER`. They project to the indexed `organizerEventId` and `organizerUserId` columns. `findLinkedEvent` looks a copy up by that pair among masters only, because an override inherits the link and would otherwise answer for its series.

Only a trusted transport sets the link: the relay envelope, or a verified iMIP sender. `EventDataSchema` (`routes/calendar.ts`) has no field for the organizer, so a web save keeps the stored one whatever it posts back. An iMIP organizer has no Eigen id, so its `organizerUserId` is `external_<address>`, the way a team is `team_<id>`. `isExternalOwnerId` sends such an organizer's RSVP by mail instead of over the relay.

## An attendee may re-alarm a copy and nothing more

On a linked copy, `updateEvent` keeps changes to reminders and color and drops the rest. The edit dialog disables the same fields (`detailsDisabled`), so a save never drops them silently. The calendar select stays live, because moving the copy to another calendar is allowed.

Whether an event is somebody else's invitation is `isInvitationFromOthers` (`packages/lib/src/core/calendar/calendar-utils.ts`). It compares the stored organizer address with the Home user's, case-insensitively. A stored `ORGANIZER` alone means nothing: Apple Calendar and Thunderbird write the account's own address on every event they create with guests, and that event is the owner's own. The guard, `deleteEvent`, `rsvp()`, the inbound REPLY lookup and both calendar dialogs all use this one rule. A CalDAV PUT uses the stamp instead ([CALDAV.md](CALDAV.md#a-put-is-judged-inside-the-write-lock)).

The address rule has known misses, each in [ROADMAP.md](ROADMAP.md). A team Home's user has no address, so a member-organized event on a team calendar reads as locked. A viewer of a shared calendar passes no address, so every event there reads as locked while the server would accept the write.

## The organizer's writes fan out, and only the organizer's

A create or update with attendees diffs the old list against the new one, then adds, updates or cancels each copy. Only the organizer fans out, because a guest's own SEQUENCE bump would outrank the organizer's next update. An Eigen user gets a copy over the home relay. Anyone else, and any guest-role user, gets an iMIP mail and a share registry entry, so their account reconciles on signup. The acting user's own address is skipped.

When the organizer deletes, every copy is cancelled. When an attendee deletes, it is a decline, but only if their address is in the event's attendees. A file or a CalDAV client can hang any `ORGANIZER` on an event, and a decline would then reach a stranger. An organizer known only by address, as every organizer a PUT or a file names is, gets the decline as an iMIP REPLY.

## An occurrence message names the series

A guest holds one linked series, and an override on it inherits the series' link. So every message about one occurrence names the series' event id plus the occurrence key, never the override's own row id. The receiver attaches it through `applyInvitationException`, the same path an iMIP REQUEST with a `RECURRENCE-ID` takes. The `RECURRENCE-ID` names the original instant, which only the series knows once the override has moved.

An override that states no guests inherits the series' list. A stored VEVENT can't tell a client that didn't restate the list from one that emptied it, and reading it as empty would cancel that occurrence for every guest. A guest added to a series then gets every existing override as an update and every cancelled occurrence as a removal, or their copy would show a moved occurrence at its old slot.

A series-wide edit of the title, description or location reaches each override that still carried the master's old value. Guests run the same rule, so a moved occurrence is renamed everywhere without a message of its own.

## An RSVP names its scope

`PUT .../events/:id/rsvp` takes `{status, scope?, recurrenceDate?, remove?}`:

| Scope | Effect |
|---|---|
| `all` (default) | the attendee's status on the whole copy |
| `this` + `recurrenceDate` | an override with that status; with `remove`, an exclusion and a decline |
| `this-and-following` + `remove` | the copy's rule is truncated and a series-wide decline goes out |
| `remove` alone | the copy is deleted, as a decline |

`constrainRRule` (`recurrence.ts`) keeps an organizer's later update from extending the rule past a guest's truncation, so "delete this and following" survives the next edit. A copy that is one occurrence of a series the guest doesn't hold answers for that occurrence: its RSVP names its own `RECURRENCE-ID`, so it lands on the organizer's override that holds that occurrence's guests.

## Every inbound REQUEST takes one locked decision

A REQUEST relayed from another Home and one mailed over iMIP both go through `decideInboundRequest`. It runs inside the write lock and looks up the UID Home-wide, so two concurrent deliveries can't file two masters for one UID.

1. **Update.** A stored copy linked to an organizer takes the message, but only when the sender is that organizer, so a co-attendee can't hijack it. A REQUEST for one occurrence attaches as an override, since a full update would collapse the series.
2. **Adopt.** A stored master nobody linked is claimed when its own organizer address equals the verified sender. `X-EIGEN-IMPORTED-ORGANIZER` wins over the `ORGANIZER` line here. The resource keeps its row ids and gains the link and the message's guest list.
3. **Create** in the default calendar, only when the body's `ORGANIZER` is the sender. A REQUEST for one occurrence of a series this Home doesn't hold files as a standalone event that keeps its `RECURRENCE-ID`, the only record of which occurrence it answers for.

A relayed message naming this Home as its own organizer is dropped, because adopting it would make an event a linked copy of itself.

**An occurrence copy gives way to the series.** When the organizer later invites the guest to the whole series, the standalone copy is purged and the series written in its place, inside one lock hold. The guest's reminders and color carry over. A CANCEL for that occurrence deletes the copy outright, since there is no series to exclude it from.

## Revisions are ordered, and a redelivery is applied as one

`isNewerRevision` (RFC 5546 § 2.1.5) compares SEQUENCE first, then `DTSTAMP`. The stored side is what the resource holds for that occurrence (`storedRevision`); a cancelled one reads the stamp beside its `EXDATE`. A lower SEQUENCE always loses. At equal SEQUENCE an equal or newer stamp is applied, and so is a message when either side has no stamp. `DTSTAMP` has one-second resolution, so such a message is a redelivery, and a redelivery patches to nothing: no ctag moves and the user is told nothing twice. A stamp more than 24 hours ahead of the receiver's clock is clamped to now, or it would outrank every genuine update at the same SEQUENCE.

Receivers never raise. A message over `EVENT_MAX_BYTES` or the storage budget is logged and dropped, because the mail it rode in on has landed and nobody is waiting for a 413 or a 507.

## iMIP mail carries the projected event, never the stored bytes

`imip.ts` composes REQUEST (with an "updated" banner for an update), CANCEL and REPLY. `serializeEventForImip` builds a fresh VCALENDAR from the rows, so no Eigen stamp can leak, and strips them anyway. A series travels whole: one VCALENDAR with the master, an `EXDATE` per cancelled occurrence and an override per edited one (RFC 5546). A message about one occurrence carries that occurrence alone.

**No `VALARM` ever travels.** The organizer's reminders are their own, and an email reminder would ship as `ACTION:EMAIL` naming the organizer, so every guest's client would mail the organizer at the trigger. The `URL` stays, since guests seeing the link is the point. A REQUEST asks each guest to reply (`RSVP=TRUE`) and lists the organizer as an accepted attendee. An override with no guests of its own goes out with the organizer as its only attendee ([ROADMAP.md](ROADMAP.md)).

## Inbound iMIP acts only on a sender our own MTA verified

`Mail.mailboxDeliver` (`lib/mail/mail-domain.ts`) scans a delivered message for a `text/calendar` part after the INBOX append. It waits for the calendar, so a client reacting to the new-mail event already finds the change. A failure is only logged and never fails the delivery.

Every change binds to the `From:` address, so the delivery seam computes a verdict with `verifyImipSender` (`lib/mail/imip-auth.ts`). A sender is verified when the topmost `Authentication-Results` header stamped with our own authserv-id records a `dkim=pass` for a domain aligned with the `From:` domain. OpenDKIM prepends its result and strips older ones with our id (`docker/postfix/entrypoint.sh`), so a header below it is a stale hop or a forgery. Anything else fails closed and the invite stays a plain attachment. An imported `.eml` never reaches the calendar, and an operator whose MTA writes no such header has automatic iMIP off. A message is acted on for its first `IMIP_MAX_EVENTS` (50) events only, since more is a mailed export, not a scheduling message.

A REQUEST or CANCEL from the recipient's own address is dropped. It is their own mail coming back through a forward or a list, and acting on it would turn their own event into somebody else's copy. A REPLY from one's own address is still processed.

REQUEST takes the decision above with `external_<sender>` as the organizer. CANCEL removes the copy, or one occurrence of it under the ordering rule. REPLY moves PARTSTAT on the organizer's master or on that occurrence's override. It only sets the sender's own status, only for an invited attendee, and never brings back an occurrence the organizer deleted.

## The mail app draws an invite from the server's summary

`Mail.messageGet` summarizes each calendar part through the same parser into `Attachment.calendarInvite`, and `calendar-invite-widget.tsx` (`apps/mail/`) draws it inline instead of in the attachment list. A `null` summary is an unparseable file and draws as an error card.

## See also

- [CALENDAR.md](CALENDAR.md): the store and the write path
- [MAIL.md](MAIL.md): the delivery route that feeds inbound iMIP
- [ACL.md § Share Registry](ACL.md#share-registry): reconciliation on signup
- [SCALABILITY.md](SCALABILITY.md): the home relay
