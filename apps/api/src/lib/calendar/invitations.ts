// Invitations as they reach a Home. Every REQUEST, from another Home on this server or from verified mail, takes one
// decision: file a copy, update the copy linked to its organizer, or drop it, as it does a message older than the copy.
// A cancellation follows the same link. rsvp sends the guest's answer back, and the organizer's Home records it through
// receiveAttendeeStatus and receiveRsvpForOccurrence. Callers, such as the home relay and inbound mail, use Calendar.

import { heldAttendees, isInvitationFromOthers, truncateRRule } from '@workspace/lib/calendar/calendar-utils';
import { calendarInviteTag } from '@workspace/lib/notification/tags';
import type { Attendee, CalendarEvent } from '@workspace/lib/types/calendar';
import { externalOwnerId, isExternalOwnerId } from '@workspace/lib/types/owner';
import { SSEventType } from '@workspace/lib/types/sse';
import { and, eq, isNull } from 'drizzle-orm';
import type ICAL from 'ical.js';
import { ApiError } from '../core';
import { isNewerRevision, patchEvent, stampInvitationLink, storedOrganizerAddress, storedRevision } from '../ical';
import type { EventPatch, Revision } from '../ical/ical-component';
import type { ParsedEvent } from '../ical/ical-parse';
import { computeOccurrenceTimes, parseRecurrenceKey, recurrenceKey, utcToLocal } from '../ical/wall-clock';
import { sendMail } from '../mailer/mailer';
import type { User } from '../user';
import { actorDisplayName } from '../user';
import type { Calendar } from './calendar';
import * as events from './events';
import { composeRsvpReply } from './imip';
import { answeredOccurrence, propagateRsvp } from './invite-propagation';
import { toEvent } from './mappers';
import { constrainRRule, expandRecurrence } from './recurrence';
import * as schema from './schema';
import { buildCalendarEvent } from './sse-events';
import type { InvitationLink } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

// What the decision on an inbound REQUEST did. The broadcast and the notice run after the write lock is released.
type InboundRequestOutcome =
    | { kind: 'dropped'; reason: string }
    | { kind: 'created' | 'updated'; event: CalendarEvent };

const REFUSED: InboundRequestOutcome = { kind: 'dropped', reason: 'the store would not keep it' };

// A REQUEST, relayed from another Home or mailed by a verified sender. Each event takes the decision on its own.
export async function receiveRequest(
    calendar: Calendar,
    requested: readonly ParsedEvent[],
    link: InvitationLink,
): Promise<void> {
    // A Home is never its own organizer: adopting such a message would make its own event a linked copy of itself.
    if (link.organizerUserId === calendar.home.user.id) {
        console.info(`calendar: dropped a REQUEST that names this Home, ${link.organizerUserId}, as its organizer`);
        return;
    }
    for (const parsed of requested) {
        const outcome = await unlessRefused(
            parsed.uid,
            () => calendar.writeLock.run(() => decideInboundRequest(calendar, parsed, link)),
            REFUSED,
        );
        if (outcome.kind === 'dropped') {
            console.info(
                `calendar: dropped a REQUEST for ${parsed.uid} from ${link.organizerUserId} — ${outcome.reason}`,
            );
            continue;
        }
        settleInboundRequest(calendar, outcome, parsed, link);
    }
}

// The caller has verified `sender` as the DKIM-aligned From address. Mail links an invitation by that address alone.
export function receiveImipRequest(calendar: Calendar, parsed: ParsedEvent, sender: string): Promise<void> {
    const organizerUserId = externalOwnerId(sender);
    return receiveRequest(calendar, [parsed], {
        organizerEmail: sender,
        organizerEventId: parsed.uid,
        organizerUserId,
        createByUserId: organizerUserId,
    });
}

// Cancels one occurrence only. removeInvitation would delete the guest's whole linked series.
export async function cancelInvitationOccurrence(
    calendar: Calendar,
    organizerEventId: string,
    organizerUserId: string,
    recurrenceDate: string,
    recurrenceInstant: Date | null | undefined,
    revision: Revision,
): Promise<void> {
    // The write returns the occurrence's start, so the notice after the lock names the occurrence that went.
    const cancelled = await unlessRefused(
        organizerEventId,
        () =>
            calendar.writeLock.run(async () => {
                const linked = findLinkedEvent(calendar, organizerEventId, organizerUserId);
                if (!linked) return null;
                const resource = events.resourceOf(calendar, linked.id);
                if (!resource) return null;
                const component = events.storedComponent(calendar, resource);
                const key = recurrenceKeyForSeries(recurrenceDate, recurrenceInstant, linked.timezone);
                // A copy that is itself the cancelled occurrence has no series to remove it from, so the copy goes.
                if (!exceptionKeyOf(linked, key)) {
                    if (!isNewerRevision(revision, storedRevision(component, linked.recurrenceDate))) return null;
                    await calendar.purgeResource(resource);
                    return { linked, startTime: linked.startTime };
                }
                if (!isNewerRevision(revision, storedRevision(component, key))) return null;
                await removeOccurrence(calendar, linked.id, key, revision);
                return { linked, startTime: computeOccurrenceTimes(linked, key).startTime };
            }),
        null,
    );
    if (!cancelled) return;
    calendar.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_INVITE_CANCELLED, organizerUserId));
    calendar.announce(SSEventType.CALENDAR_EVENT_UPDATED, cancelled.linked.calendarId);
    notifyInvitationCancelled(calendar, cancelled.linked, cancelled.startTime, organizerEventId);
}

export async function removeInvitation(
    calendar: Calendar,
    organizerEventId: string,
    organizerUserId: string,
): Promise<void> {
    const linked = await calendar.writeLock.run(async () => {
        const linked = findLinkedEvent(calendar, organizerEventId, organizerUserId);
        const resource = linked && events.resourceOf(calendar, linked.id);
        if (!linked || !resource) return null;
        await calendar.purgeResource(resource);
        return linked;
    });
    if (!linked) return;

    calendar.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_INVITE_CANCELLED, organizerUserId));
    notifyInvitationCancelled(calendar, linked, linked.startTime, organizerEventId);
}

// A refused PARTSTAT is dropped like any other refused message, so the rest of the reply still files.
export function receiveAttendeeStatus(
    calendar: Calendar,
    eventId: string,
    email: string,
    status: Attendee['status'],
): Promise<void> {
    return unlessRefused(eventId, () => updateAttendeeStatus(calendar, eventId, email, status), undefined);
}

export function receiveRsvpForOccurrence(
    calendar: Calendar,
    eventId: string,
    email: string,
    status: Attendee['status'],
    recurrenceDate: string,
    recurrenceInstant: Date | null | undefined,
    restoreCancelled: boolean,
): Promise<void> {
    return unlessRefused(
        eventId,
        () => rsvpForOccurrence(calendar, eventId, email, status, recurrenceDate, recurrenceInstant, restoreCancelled),
        undefined,
    );
}

// The guest answers an invitation. The organizer hears it by mail, or through their Home when they are on this server.
export async function rsvp(
    calendar: Calendar,
    eventId: string,
    user: User,
    input: {
        status: Attendee['status'];
        scope?: 'this' | 'this-and-following' | 'all';
        recurrenceDate?: string;
        remove?: boolean;
    },
): Promise<void> {
    const event = events.eventById(calendar, eventId);
    if (!event) throw new ApiError(404, 'Event not found');
    if (!event.data?.organizer || !isInvitationFromOthers(event, calendar.home.user.email)) {
        throw new ApiError(400, 'Not a linked event');
    }

    const isAttendee = event.data.attendees?.some((a) => a.email.toLowerCase() === user.email.toLowerCase());
    if (!isAttendee) throw new ApiError(403, 'Not an attendee');

    // A copy without a rule has one occurrence, so an answer for this one is an answer for all of it.
    const scope = input.scope === 'this' && !event.rrule ? 'all' : (input.scope ?? 'all');
    const organizerUserId = event.data.organizer.userId;
    const organizerEventId = event.data.organizerEventId;
    const isExternalOrganizer = isExternalOwnerId(organizerUserId);
    // A copy of one occurrence answers for that occurrence. The organizer keeps its guest list on their override.
    const ownOccurrence = answeredOccurrence(event);

    const sendRsvpReply = (status: Attendee['status'], recurrenceDate?: string) => {
        const mail = composeRsvpReply(event, user.email, user.name ?? user.email, status, recurrenceDate);
        sendMail(mail).catch(console.error);
    };
    // An event a CalDAV client stored can name an organizer but link to no event on their Home. Nobody hears it then.
    const relayRsvp = (status: Attendee['status'], recurrenceDate?: string) => {
        if (!organizerEventId) return;
        propagateRsvp(organizerUserId, organizerEventId, user.email, status, recurrenceDate).catch(console.error);
    };

    if (scope === 'this' && input.recurrenceDate) {
        const recurrenceDate = parseRecurrenceKey(input.recurrenceDate);
        if (!recurrenceDate) throw new ApiError(400, 'Invalid recurrenceDate');
        const status = input.remove ? 'declined' : input.status;
        if (input.remove) {
            await calendar.writeLock.run(() => removeOccurrence(calendar, eventId, recurrenceDate));
            calendar.announce(SSEventType.CALENDAR_EVENT_UPDATED, event.calendarId);
        } else {
            await rsvpForOccurrence(calendar, eventId, user.email, input.status, recurrenceDate, null, true);
        }
        if (isExternalOrganizer) sendRsvpReply(status, recurrenceDate);
        else relayRsvp(status, recurrenceDate);
    } else if (scope === 'this-and-following' && input.remove && input.recurrenceDate) {
        const recurrenceDate = parseRecurrenceKey(input.recurrenceDate);
        if (!recurrenceDate) throw new ApiError(400, 'Invalid recurrenceDate');
        await removeThisAndFuture(calendar, eventId, recurrenceDate);
        if (isExternalOrganizer) sendRsvpReply('declined');
        else relayRsvp('declined');
    } else if (input.remove) {
        await events.deleteEvent(calendar, event.calendarId, eventId, user);
    } else {
        await updateAttendeeStatus(calendar, eventId, user.email, input.status);
        if (isExternalOrganizer) sendRsvpReply(input.status);
        else relayRsvp(input.status, ownOccurrence);
    }
}

// A receiver runs fire-and-forget, so nobody can be told about a 413 or a 507. A message the store refuses is
// logged and dropped instead.
async function unlessRefused<T>(uid: string, apply: () => Promise<T>, dropped: T): Promise<T> {
    try {
        return await apply();
    } catch (e) {
        if (!(e instanceof ApiError) || (e.status !== 413 && e.status !== 507)) throw e;
        console.info(`calendar: dropped a message for ${uid} — ${e.message}`);
        return dropped;
    }
}

// The caller holds the write lock, so two deliveries at once never file two masters for one UID.
async function decideInboundRequest(
    calendar: Calendar,
    parsed: ParsedEvent,
    link: InvitationLink,
): Promise<InboundRequestOutcome> {
    const stored = calendar.joinedEvents().where(eq(schema.events.uid, parsed.uid)).all().map(toEvent);
    // Only the master counts, as in findLinkedEvent. An exception inherits the link and would answer for the series.
    const linked = stored.find((e) => !e.parentEventId && e.data?.organizer && e.data?.organizerEventId);

    if (linked) {
        // Only the organizer the copy is linked to may update it, so another guest cannot take over the invitation.
        if (
            linked.data?.organizer?.userId !== link.organizerUserId ||
            linked.data.organizerEventId !== link.organizerEventId
        ) {
            return { kind: 'dropped', reason: 'the sender is not the organizer this copy is linked to' };
        }
        // A copy of one occurrence gives way to the whole series once the organizer invites this Home to all of it.
        if (linked.recurrenceDate && !parsed.recurrenceDate) {
            const resource = events.resourceOf(calendar, linked.id);
            const component = resource ? events.storedComponent(calendar, resource) : null;
            if (component && !isNewerRevision(parsed, storedRevision(component, linked.recurrenceDate))) {
                return { kind: 'dropped', reason: 'nothing newer to apply' };
            }
            return fileNewInvitation(calendar, parsed, link, linked);
        }
        // An edit to one occurrence attaches as an exception. A full update would collapse the series.
        const key = exceptionKeyOf(linked, parsed.recurrenceDate);
        const moved = key
            ? await applyInvitationException(calendar, linked, parsed, key)
            : await applyInvitationUpdate(calendar, linked, parsed);
        return moved ? { kind: 'updated', event: linked } : { kind: 'dropped', reason: 'nothing newer to apply' };
    }

    const master = stored.find((e) => !e.parentEventId);
    if (master) {
        // The organizer may claim an event nobody linked, but only when it names the verified sender.
        const resource = events.resourceOf(calendar, master.id);
        const component = resource ? events.storedComponent(calendar, resource) : null;
        if (!resource || !component || storedOrganizerAddress(component) !== link.organizerEmail) {
            return { kind: 'dropped', reason: 'the stored event names another organizer' };
        }
        if (parsed.recurrenceDate) {
            return { kind: 'dropped', reason: 'an occurrence of a series nobody organizes here yet' };
        }
        await adoptAsInvitation(calendar, master, resource, component, parsed, link);
        return { kind: 'updated', event: master };
    }

    return fileNewInvitation(calendar, parsed, link);
}

// The caller holds the write lock. An invitation to one occurrence files as an event of its own, because the
// guest was invited to that occurrence and not to the series.
async function fileNewInvitation(
    calendar: Calendar,
    parsed: ParsedEvent,
    link: InvitationLink,
    replaces?: CalendarEvent,
): Promise<InboundRequestOutcome> {
    // A new invitation is attributed to its sender, so the body's ORGANIZER must be that address.
    const organizer = parsed.data?.organizer;
    if (!organizer || organizer.email.toLowerCase() !== link.organizerEmail) {
        return { kind: 'dropped', reason: 'the ICS organizer is not the sender' };
    }
    const defaultCalendar = calendar.db
        .select()
        .from(schema.calendars)
        .all()
        .find((row) => row.isDefault);
    if (!defaultCalendar) return { kind: 'dropped', reason: 'no default calendar' };
    // Nothing the guest holds is dropped until this message is certain to file.
    const replaced = replaces && events.resourceOf(calendar, replaces.id);
    if (replaced) await calendar.purgeResource(replaced);
    const event = await events.writeEvent(calendar, defaultCalendar.id, {
        title: parsed.title,
        description: parsed.description,
        location: parsed.location,
        startTime: parsed.startTime,
        endTime: parsed.endTime,
        allDay: parsed.allDay,
        rrule: parsed.rrule,
        timezone: parsed.timezone,
        status: parsed.status,
        sequence: parsed.sequence,
        dtstamp: parsed.dtstamp,
        data: {
            ...parsed.data,
            organizer: { ...organizer, userId: link.organizerUserId },
            organizerEventId: link.organizerEventId,
            // A linked copy lets the guest keep their own reminders and color.
            reminders: replaces?.data?.reminders ?? parsed.data?.reminders,
            color: replaces?.data?.color ?? parsed.data?.color,
        },
        createByUserId: link.createByUserId,
        uid: parsed.uid,
        // A copy of one occurrence keeps its RECURRENCE-ID, because nothing else records which occurrence it is.
        recurrenceDate: parsed.recurrenceDate,
    });
    return { kind: 'created', event };
}

// The occurrence a message names, or null when it names the stored copy itself. A stored copy can be one
// occurrence of a series this Home does not hold.
function exceptionKeyOf(linked: CalendarEvent, recurrenceDate: string | null): string | null {
    if (!recurrenceDate || recurrenceDate === linked.recurrenceDate) return null;
    return recurrenceDate;
}

// The caller holds the write lock. Returns false when it changed nothing, such as for a redelivery: an occurrence
// already stored is patched, and only a new one is written whole.
async function applyInvitationException(
    calendar: Calendar,
    linked: CalendarEvent,
    parsed: ParsedEvent,
    key: string,
): Promise<boolean> {
    const recurrenceDate = recurrenceKeyForSeries(key, parsed.recurrenceInstant, linked.timezone);
    const resource = events.resourceOf(calendar, linked.id);
    if (!resource) return false;
    const component = events.storedComponent(calendar, resource);
    const stored = storedRevision(component, recurrenceDate);
    if (!isNewerRevision(parsed, stored)) return false;

    const existing = events.exceptionOf(calendar, linked.id, recurrenceDate);
    const held = heldAttendees(existing, linked);
    const attendees = keepOwnAnswer(calendar, parsed, held, stored);
    const cancelled = parsed.status === 'cancelled';
    const timezone = parsed.timezone ?? linked.timezone;
    if (existing && (existing.status === 'cancelled') === cancelled) {
        // A cancelled occurrence is an EXDATE, which holds nothing more to patch.
        if (cancelled) return false;
        const patch = invitationPatch(existing, { ...parsed, timezone }, attendees, null);
        const changed = patchEvent(component, recurrenceDate, patch, events.writeContext(false, parsed.dtstamp));
        if (changed) await events.writeComponent(calendar, resource, component);
        return changed;
    }
    await events.writeEvent(calendar, linked.calendarId, {
        title: parsed.title,
        description: parsed.description,
        location: parsed.location,
        startTime: parsed.startTime,
        endTime: parsed.endTime,
        allDay: parsed.allDay,
        timezone,
        parentEventId: linked.id,
        recurrenceDate,
        status: parsed.status,
        sequence: parsed.sequence,
        dtstamp: parsed.dtstamp,
        data: { ...linked.data, attendees: attendees ?? held },
        createByUserId: linked.createByUserId,
        uid: linked.uid,
    });
    return true;
}

// A lone VEVENT cannot tell the parser the series' timezone. So a UTC RECURRENCE-ID is turned into a date in the
// timezone of the stored series here.
function recurrenceKeyForSeries(
    recurrenceDate: string,
    recurrenceInstant: Date | null | undefined,
    tz: string | null,
): string {
    if (!recurrenceInstant || !tz) return recurrenceDate;
    const { year, month, day } = utcToLocal(recurrenceInstant, tz);
    return recurrenceKey(year, month, day);
}

// The caller holds the write lock. Returns false when it changed nothing, such as for a replay the stored copy
// already outranks.
async function applyInvitationUpdate(calendar: Calendar, linked: CalendarEvent, parsed: ParsedEvent): Promise<boolean> {
    const resource = events.resourceOf(calendar, linked.id);
    if (!resource) return false;
    const component = events.storedComponent(calendar, resource);
    // A copy that is one occurrence of a series this Home does not hold is keyed by its RECURRENCE-ID.
    const stored = storedRevision(component, linked.recurrenceDate);
    if (!isNewerRevision(parsed, stored)) return false;

    // Never extend the rrule past what the guest has: they may have shortened it on purpose.
    const rrule = constrainRRule(parsed.rrule, linked.rrule);
    const attendees = keepOwnAnswer(calendar, parsed, linked.data?.attendees ?? [], stored);
    // A redelivery changes nothing, so it bumps no ctag and sends no second notice.
    const changed = patchEvent(
        component,
        linked.recurrenceDate,
        invitationPatch(linked, parsed, attendees, rrule),
        events.writeContext(false, parsed.dtstamp),
    );
    if (!changed) return false;
    await events.writeComponent(calendar, resource, component);
    return true;
}

// The guest's own answer stands until the organizer reschedules, which raises the SEQUENCE. An organizer's list can
// still say NEEDS-ACTION for a reply it hasn't read yet.
function keepOwnAnswer(
    calendar: Calendar,
    parsed: ParsedEvent,
    held: readonly Attendee[],
    stored: Revision | null,
): Attendee[] | undefined {
    const incoming = parsed.data?.attendees;
    const email = calendar.home.user.email.toLowerCase();
    const own = held.find((a) => a.email.toLowerCase() === email);
    if (!incoming || !own || !stored || parsed.sequence > stored.sequence) return incoming;
    return withAttendeeStatus(incoming, email, own.status);
}

// An organizer's client repeats the times in every message. Only a time that differs from the stored row is patched.
function invitationPatch(
    stored: CalendarEvent,
    parsed: ParsedEvent,
    attendees: Attendee[] | undefined,
    rrule: string | null,
): EventPatch {
    const moved = parsed.startTime.getTime() !== stored.startTime.getTime();
    const ended = parsed.endTime.getTime() !== stored.endTime.getTime();
    return {
        title: parsed.title,
        description: parsed.description,
        location: parsed.location,
        startTime: moved ? parsed.startTime : undefined,
        endTime: ended ? parsed.endTime : undefined,
        allDay: parsed.allDay !== stored.allDay ? parsed.allDay : undefined,
        rrule: rrule ?? undefined,
        timezone: parsed.timezone,
        status: parsed.status,
        data: attendees ? { ...stored.data, attendees } : undefined,
        // The guest's copy keeps the organizer's revision, so the next message has a number to beat.
        sequence: parsed.sequence,
    };
}

// The caller holds the write lock. The event keeps its file and row ids. The link and the guest list come from
// the message.
async function adoptAsInvitation(
    calendar: Calendar,
    master: CalendarEvent,
    resource: events.StoredResource,
    component: ICAL.Component,
    parsed: ParsedEvent,
    link: InvitationLink,
): Promise<void> {
    const organizer = {
        userId: link.organizerUserId,
        email: link.organizerEmail,
        name: parsed.data?.organizer?.name,
    };
    stampInvitationLink(component, link);
    patchEvent(
        component,
        null,
        {
            ...invitationPatch(master, parsed, undefined, parsed.rrule),
            data: { ...master.data, organizer, attendees: parsed.data?.attendees },
        },
        events.writeContext(false, parsed.dtstamp),
    );
    await events.writeComponent(calendar, resource, component);
}

function settleInboundRequest(
    calendar: Calendar,
    outcome: Exclude<InboundRequestOutcome, { kind: 'dropped' }>,
    parsed: ParsedEvent,
    link: InvitationLink,
): string {
    if (outcome.kind === 'created') {
        calendar.announce(SSEventType.CALENDAR_EVENT_CREATED, outcome.event.calendarId);
        notifyInvitationReceived(calendar, parsed, link);
    } else {
        calendar.announce(SSEventType.CALENDAR_EVENT_UPDATED, outcome.event.calendarId);
        notifyInvitationUpdated(
            calendar,
            outcome.event,
            parsed.title,
            parsed.startTime,
            link.organizerEventId,
            link.organizerUserId,
        );
    }
    return outcome.event.id;
}

function notifyInvitationReceived(calendar: Calendar, parsed: ParsedEvent, link: InvitationLink): void {
    calendar.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_INVITE_RECEIVED, link.organizerUserId));
    const organizer = parsed.data?.organizer;
    const actor = actorDisplayName(organizer?.name, organizer?.email);
    calendar.home.notify({
        type: 'calendar-invite',
        actorEmail: organizer?.email,
        title: actor ? `${actor} invited you` : 'New invitation',
        body: parsed.title,
        tag: calendarInviteTag(link.organizerEventId, parsed.startTime),
        details: { startTime: parsed.startTime.getTime() },
    });
}

function notifyInvitationUpdated(
    calendar: Calendar,
    linked: CalendarEvent,
    title: string,
    startTime: Date,
    organizerEventId: string,
    organizerUserId: string,
): void {
    calendar.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_INVITE_UPDATED, organizerUserId));
    const organizer = linked.data?.organizer;
    const actor = actorDisplayName(organizer?.name, organizer?.email);
    calendar.home.notify({
        type: 'calendar-invite-updated',
        actorEmail: organizer?.email,
        title: actor ? `${actor} updated an invitation` : 'Invitation updated',
        body: title,
        tag: calendarInviteTag(organizerEventId, startTime),
        details: { startTime: startTime.getTime() },
    });
}

function findLinkedEvent(calendar: Calendar, organizerEventId: string, organizerUserId: string): CalendarEvent | null {
    const row = calendar
        .joinedEvents()
        .where(
            and(
                eq(schema.events.organizerEventId, organizerEventId),
                eq(schema.events.organizerUserId, organizerUserId),
                isNull(schema.events.parentEventId),
            ),
        )
        .get();
    return row ? toEvent(row) : null;
}

// The caller holds the write lock. The CANCEL's revision is stored, so a stale redelivery can be ordered against it.
async function removeOccurrence(
    calendar: Calendar,
    eventId: string,
    recurrenceDate: string,
    revision?: Revision,
): Promise<void> {
    const parent = events.eventById(calendar, eventId);
    if (!parent) throw new ApiError(404, 'Event not found');
    const { startTime, endTime } = computeOccurrenceTimes(parent, recurrenceDate);
    await events.writeEvent(calendar, parent.calendarId, {
        title: parent.title,
        startTime,
        endTime,
        allDay: parent.allDay,
        timezone: parent.timezone,
        parentEventId: eventId,
        recurrenceDate,
        status: 'cancelled',
        sequence: revision?.sequence,
        dtstamp: revision?.dtstamp,
        uid: parent.uid,
    });
}

function notifyInvitationCancelled(
    calendar: Calendar,
    linked: CalendarEvent,
    startTime: Date,
    organizerEventId: string,
): void {
    const organizer = linked.data?.organizer;
    const actor = actorDisplayName(organizer?.name, organizer?.email);
    calendar.home.notify({
        type: 'calendar-invite-cancelled',
        actorEmail: organizer?.email,
        title: actor ? `${actor} canceled an invitation` : 'Invitation canceled',
        body: linked.title,
        tag: calendarInviteTag(organizerEventId, startTime),
    });
}

async function updateAttendeeStatus(
    calendar: Calendar,
    eventId: string,
    email: string,
    status: Attendee['status'],
): Promise<void> {
    // The guest list is read inside the write lock, so one answer never overwrites another.
    const calendarId = await calendar.writeLock.run(async () => {
        const event = events.eventById(calendar, eventId);
        if (!event?.data?.attendees) return null;
        const resource = events.resourceOf(calendar, eventId);
        if (!resource) return null;

        const attendees = withAttendeeStatus(event.data.attendees, email, status);
        await events.patchResource(
            calendar,
            resource,
            event.recurrenceDate,
            { data: { ...event.data, attendees } },
            events.writeContext(false),
        );
        return event.calendarId;
    });
    if (calendarId) calendar.announce(SSEventType.CALENDAR_EVENT_UPDATED, calendarId);
}

function withAttendeeStatus(attendees: Attendee[], email: string, status: Attendee['status']): Attendee[] {
    return attendees.map((a) => (a.email.toLowerCase() === email.toLowerCase() ? { ...a, status } : a));
}

// A guest may restore an occurrence they removed themselves. On the organizer's Home an answer only moves the
// PARTSTAT (RFC 5546), so that receiver passes false for restoreCancelled.
async function rsvpForOccurrence(
    calendar: Calendar,
    eventId: string,
    email: string,
    status: Attendee['status'],
    recurrenceDate: string,
    recurrenceInstant: Date | null | undefined,
    restoreCancelled: boolean,
): Promise<void> {
    const calendarId = await calendar.writeLock.run(async () => {
        // A series deleted while the answer travelled has nothing left to record it on.
        const parent = events.eventById(calendar, eventId);
        if (!parent) return null;

        const key = recurrenceKeyForSeries(recurrenceDate, recurrenceInstant, parent.timezone);
        const existing = events.exceptionOf(calendar, eventId, key);
        // A deleted occurrence is an EXDATE, which carries no attendee list to record a PARTSTAT in.
        if (existing?.status === 'cancelled' && !restoreCancelled) return null;
        const data = existing?.data ?? parent.data ?? {};
        // Only a recorded guest may answer. The occurrence's own list counts, because someone can be invited to
        // one occurrence only.
        const invitees = heldAttendees(existing, parent);
        if (!invitees.some((a) => a.email.toLowerCase() === email.toLowerCase())) return null;
        const attendees = withAttendeeStatus(invitees, email, status);

        if (existing && existing.status !== 'cancelled') {
            const resource = events.resourceOf(calendar, existing.id);
            if (!resource) return null;
            await events.patchResource(
                calendar,
                resource,
                key,
                { data: { ...data, attendees } },
                events.writeContext(false),
            );
            return parent.calendarId;
        }

        // A zone moves an occurrence at most a day off its key's date. A date the rule doesn't yield is no occurrence, and
        // an answer doesn't make it one.
        const day = Date.parse(`${key}T00:00:00Z`);
        const occurrence =
            existing ??
            expandRecurrence(parent, new Date(day - DAY_MS), new Date(day + 2 * DAY_MS)).find(
                (candidate) => candidate.occurrenceDate === key,
            );
        if (!occurrence) return null;
        await events.writeEvent(calendar, parent.calendarId, {
            title: occurrence.title,
            description: parent.description,
            location: parent.location,
            startTime: occurrence.startTime,
            endTime: occurrence.endTime,
            allDay: parent.allDay,
            timezone: parent.timezone,
            parentEventId: eventId,
            recurrenceDate: key,
            status: 'confirmed',
            data: { ...data, attendees },
            createByUserId: parent.createByUserId,
            uid: parent.uid,
        });
        return parent.calendarId;
    });
    if (calendarId) calendar.announce(SSEventType.CALENDAR_EVENT_UPDATED, calendarId);
}

async function removeThisAndFuture(calendar: Calendar, eventId: string, recurrenceDate: string): Promise<void> {
    await calendar.writeLock.run(async () => {
        const event = events.eventById(calendar, eventId);
        if (!event) throw new ApiError(404, 'Event not found');
        if (!event.rrule) throw new ApiError(400, 'Not a recurring event');
        const resource = events.resourceOf(calendar, eventId);
        if (!resource) throw new ApiError(404, 'Event not found');
        const truncated = truncateRRule(event.rrule, new Date(`${recurrenceDate}T00:00:00Z`));
        await events.patchResource(calendar, resource, null, { rrule: truncated }, events.writeContext(false));
    });
}
