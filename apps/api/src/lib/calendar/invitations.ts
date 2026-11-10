// Invitations as they reach a Home. A REQUEST, from another Home on this server or from verified mail, carries one
// series' events and takes one decision with at most one write: file a copy, update the copy linked to its organizer,
// or drop it, as it does a message older than the copy. A cancellation follows the same link. rsvp sends the guest's
// answer back, and the organizer's Home records it through receiveAttendeeStatus and receiveRsvpForOccurrence.
// Callers, such as the home relay and inbound mail, use Calendar.

import { heldAttendees, isInvitationFromOthers, truncateRRule } from '@workspace/lib/calendar/calendar-utils';
import { calendarInviteTag } from '@workspace/lib/notification/tags';
import type { Attendee, CalendarEvent } from '@workspace/lib/types/calendar';
import { isExternalOwnerId } from '@workspace/lib/types/owner';
import { SSEventType } from '@workspace/lib/types/sse';
import { and, eq, isNull } from 'drizzle-orm';
import type ICAL from 'ical.js';
import { ApiError } from '../core';
import {
    buildResource,
    isNewerRevision,
    patchEvent,
    stampInvitationLink,
    storedOrganizerAddress,
    storedRevision,
} from '../ical';
import type { EventPatch, Revision } from '../ical/ical-component';
import type { ParsedEvent } from '../ical/ical-parse';
import { computeOccurrenceTimes, parseRecurrenceKey, recurrenceKey, utcToLocal } from '../ical/wall-clock';
import { sendMail } from '../mailer/mailer';
import type { User } from '../user';
import { actorDisplayName } from '../user';
import type { Calendar } from './calendar';
import { eventForResource } from './event-input';
import * as events from './events';
import { composeRsvpReply } from './imip';
import { answeredOccurrence, propagateRsvp } from './invite-propagation';
import { toEvent } from './mappers';
import { constrainRRule, expandRecurrence } from './recurrence';
import { prepareResource } from './resource-store';
import * as schema from './schema';
import { buildCalendarEvent } from './sse-events';
import type { InvitationLink } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

// What the decision on an inbound REQUEST did. The announcement and the notice run after the write lock is released.
type InboundRequestOutcome = { kind: 'dropped'; reason: string } | { kind: 'created' | 'updated'; calendarId: string };

// One UID's events, relayed from another Home or mailed by a verified sender: a master and its exceptions, or one
// occurrence alone. They take one decision, write the copy at most once and tell the guest once.
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
    // The master goes first, so a series-wide rename reaches the overrides before their own events patch them.
    const ordered = requested.toSorted((a, b) => Number(!!a.recurrenceDate) - Number(!!b.recurrenceDate));
    const lead = ordered[0];
    const outcome = await unlessRefused(
        lead.uid,
        () => calendar.writeLock.run(() => decideInboundRequest(calendar, ordered, link)),
        { kind: 'dropped', reason: 'the store would not keep it' },
    );
    if (outcome.kind === 'dropped') {
        console.info(`calendar: dropped a REQUEST for ${lead.uid} from ${link.organizerUserId} — ${outcome.reason}`);
        return;
    }
    if (outcome.kind === 'created') {
        calendar.announce(SSEventType.CALENDAR_EVENT_CREATED, outcome.calendarId);
        notifyInvitationReceived(calendar, lead, link);
    } else {
        calendar.announce(SSEventType.CALENDAR_EVENT_UPDATED, outcome.calendarId);
        notifyInvitationUpdated(calendar, lead, link);
    }
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
                if (!isNewerRevision(revision, storedRevision(component, key))) return null;
                // A copy that is itself the cancelled occurrence has no series to remove it from, so the copy goes.
                if (key === linked.recurrenceDate) {
                    await calendar.purgeResource(resource);
                    return { linked, startTime: linked.startTime };
                }
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
    requested: readonly ParsedEvent[],
    link: InvitationLink,
): Promise<InboundRequestOutcome> {
    const master = requested.find((e) => !e.recurrenceDate);
    const stored = calendar.joinedEvents().where(eq(schema.events.uid, requested[0].uid)).all().map(toEvent);
    // Only a master counts, as in findLinkedEvent. An exception inherits the link and would answer for the series.
    const series =
        stored.find((e) => !e.parentEventId && e.data?.organizerEventId) ?? stored.find((e) => !e.parentEventId);
    const resource = series && events.resourceOf(calendar, series.id);
    if (!series || !resource) return fileNewInvitation(calendar, requested, link);
    const component = events.storedComponent(calendar, resource);

    const adopting = !series.data?.organizerEventId;
    if (adopting) {
        // The organizer may claim an event nobody linked, but only when it names the verified sender.
        if (storedOrganizerAddress(component) !== link.organizerEmail) {
            return { kind: 'dropped', reason: 'the stored event names another organizer' };
        }
        if (!master) return { kind: 'dropped', reason: 'an occurrence of a series nobody organizes here yet' };
        stampInvitationLink(component, link);
        const organizer = {
            userId: link.organizerUserId,
            email: link.organizerEmail,
            name: master.data?.organizer?.name,
        };
        patchEvent(component, null, { data: { organizer } }, events.writeContext(false, master.dtstamp));
    } else if (
        // Only the organizer the copy is linked to may update it, so another guest cannot take over the invitation.
        series.data?.organizer?.userId !== link.organizerUserId ||
        series.data.organizerEventId !== link.organizerEventId
    ) {
        return { kind: 'dropped', reason: 'the sender is not the organizer this copy is linked to' };
    }

    // A copy of one occurrence gives way to the whole series once the organizer invites this Home to all of it.
    if (series.recurrenceDate && master) {
        return fileNewInvitation(calendar, requested, link, { copy: series, resource, component });
    }
    const exceptions = new Map(stored.filter((e) => e.parentEventId === series.id).map((e) => [e.recurrenceDate, e]));
    let changed = adopting;
    for (const parsed of requested) {
        changed = applyRequestedEvent(calendar, component, series, exceptions, parsed) || changed;
    }
    // A redelivery changes nothing, so it bumps no ctag and sends no second notice.
    if (!changed) return { kind: 'dropped', reason: 'nothing newer to apply' };
    await events.writeComponent(calendar, resource, component);
    return { kind: 'updated', calendarId: series.calendarId };
}

// The caller holds the write lock and writes the component. Answers whether the event changed it: an occurrence the
// copy already holds is patched, and only a new one is added whole.
function applyRequestedEvent(
    calendar: Calendar,
    component: ICAL.Component,
    series: CalendarEvent,
    exceptions: ReadonlyMap<string | null, CalendarEvent>,
    parsed: ParsedEvent,
): boolean {
    const key = parsed.recurrenceDate
        ? recurrenceKeyForSeries(parsed.recurrenceDate, parsed.recurrenceInstant, series.timezone)
        : null;
    // A copy that is one occurrence of a series this Home does not hold is keyed by its RECURRENCE-ID.
    const existing = key === series.recurrenceDate ? series : exceptions.get(key);
    const stored = storedRevision(component, key);
    if (!isNewerRevision(parsed, stored)) return false;

    const held = heldAttendees(existing, series);
    const attendees = keepOwnAnswer(calendar, parsed, existing, held, stored);
    const cancelled = parsed.status === 'cancelled';
    const timezone = key ? (parsed.timezone ?? series.timezone) : parsed.timezone;
    if (existing && (existing.status === 'cancelled') === cancelled) {
        // A cancelled occurrence is an EXDATE, which holds nothing more to patch.
        if (cancelled) return false;
        // Never extend the rule past what the guest has: they may have shortened it on purpose.
        const rrule = existing === series ? constrainRRule(parsed.rrule, series.rrule) : null;
        const patch = invitationPatch(existing, { ...parsed, timezone }, attendees, rrule);
        return patchEvent(component, key, patch, events.writeContext(false, parsed.dtstamp));
    }
    events.putException(component, series, {
        ...parsed,
        timezone,
        parentEventId: series.id,
        recurrenceDate: key,
        data: { ...series.data, attendees: attendees ?? held },
        createByUserId: series.createByUserId,
    });
    return true;
}

// The caller holds the write lock. A new copy is built from the message in the default calendar. A copy of one
// occurrence that the series replaces keeps its file, reminders and color, and its row and answer go to that occurrence.
async function fileNewInvitation(
    calendar: Calendar,
    requested: readonly ParsedEvent[],
    link: InvitationLink,
    replaces?: { copy: CalendarEvent; resource: events.StoredResource; component: ICAL.Component },
): Promise<InboundRequestOutcome> {
    // A new invitation is attributed to its sender, so the body's ORGANIZER must be that address.
    const organizer = requested[0].data?.organizer;
    if (!organizer || organizer.email.toLowerCase() !== link.organizerEmail) {
        return { kind: 'dropped', reason: 'the ICS organizer is not the sender' };
    }
    const calendarId =
        replaces?.resource.calendarId ??
        calendar.db
            .select()
            .from(schema.calendars)
            .all()
            .find((row) => row.isDefault)?.id;
    if (!calendarId) return { kind: 'dropped', reason: 'no default calendar' };

    // The copy answered for one occurrence, which the series states as an exception or, unmoved, as its master.
    const copy = replaces?.copy;
    const answered = copy && (requested.find((e) => e.recurrenceDate === copy.recurrenceDate) ?? requested[0]);
    const answer = replaces ? storedRevision(replaces.component, replaces.copy.recurrenceDate) : null;
    if (answered && !isNewerRevision(answered, answer)) return { kind: 'dropped', reason: 'nothing newer to apply' };

    const now = new Date();
    const rows = requested.map((parsed) => {
        const own = parsed === answered ? copy : undefined;
        return eventForResource({
            id: own?.id ?? crypto.randomUUID(),
            calendarId,
            uid: parsed.uid,
            now,
            input: {
                ...parsed,
                data: {
                    ...parsed.data,
                    organizer: { ...organizer, userId: link.organizerUserId },
                    organizerEventId: link.organizerEventId,
                    attendees: own
                        ? keepOwnAnswer(calendar, parsed, own, own.data?.attendees ?? [], answer)
                        : parsed.data?.attendees,
                    // A linked copy lets the guest keep their own reminders and color.
                    reminders: copy?.data?.reminders ?? parsed.data?.reminders,
                    color: copy?.data?.color ?? parsed.data?.color,
                },
                createByUserId: link.createByUserId,
            },
        });
    });
    await calendar.writeResource({
        calendarId,
        uri: replaces?.resource.uri ?? `${crypto.randomUUID()}.ics`,
        prepared: prepareResource(calendarId, buildResource(rows), replaces?.resource.id ?? null),
        creditBytes: replaces?.resource.size ?? 0,
    });
    return { kind: 'created', calendarId };
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

// The guest's own answer stands until the organizer reschedules, which raises the SEQUENCE. An organizer's list can
// still say NEEDS-ACTION for a reply it hasn't read yet, and a date the guest removed holds no list but a decline.
function keepOwnAnswer(
    calendar: Calendar,
    parsed: ParsedEvent,
    existing: CalendarEvent | undefined,
    held: readonly Attendee[],
    stored: Revision | null,
): Attendee[] | undefined {
    const incoming = parsed.data?.attendees;
    const email = calendar.home.user.email.toLowerCase();
    const own =
        existing?.status === 'cancelled' ? 'declined' : held.find((a) => a.email.toLowerCase() === email)?.status;
    if (!incoming || !own || !stored || parsed.sequence > stored.sequence) return incoming;
    return withAttendeeStatus(incoming, email, own);
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

function notifyInvitationUpdated(calendar: Calendar, parsed: ParsedEvent, link: InvitationLink): void {
    calendar.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_INVITE_UPDATED, link.organizerUserId));
    const organizer = parsed.data?.organizer;
    const actor = actorDisplayName(organizer?.name, organizer?.email);
    calendar.home.notify({
        type: 'calendar-invite-updated',
        actorEmail: organizer?.email,
        title: actor ? `${actor} updated an invitation` : 'Invitation updated',
        body: parsed.title,
        tag: calendarInviteTag(link.organizerEventId, parsed.startTime),
        details: { startTime: parsed.startTime.getTime() },
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
        const patch = { data: { ...event.data, attendees } };
        const changed = await events.patchResource(
            calendar,
            resource,
            event.recurrenceDate,
            patch,
            events.writeContext(false),
        );
        return changed ? event.calendarId : null;
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
            const patch = { data: { ...data, attendees } };
            const changed = await events.patchResource(calendar, resource, key, patch, events.writeContext(false));
            return changed ? parent.calendarId : null;
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
