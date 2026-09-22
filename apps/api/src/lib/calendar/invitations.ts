import { isInvitationFromOthers, truncateRRule } from '@workspace/lib/calendar/calendar-utils';
import type { Attendee, CalendarEvent, EventData } from '@workspace/lib/types/calendar';
import { externalOwnerId, isExternalOwnerId } from '@workspace/lib/types/owner';
import { SSEventType } from '@workspace/lib/types/sse';
import { and, eq, isNull } from 'drizzle-orm';
import type ICAL from 'ical.js';
import { ApiError } from '../core';
import { sendMail } from '../core/mailer';
import { isNewerRevision, patchEvent, stampInvitationLink, storedOrganizerAddress, storedRevision } from '../ical';
import type { EventPatch, Revision } from '../ical/ical-component';
import type { ParsedEvent } from '../ical/ical-parse';
import { computeOccurrenceTimes, storedRecurrenceKey, utcToLocal } from '../ical/wall-clock';
import { actorDisplayName, type User } from '../user';
import type { Calendar } from './calendar';
import * as store from './dav-store';
import * as events from './events';
import { composeRsvpReply } from './imip';
import { answeredOccurrence, propagateRsvp } from './invite-propagation';
import { toEvent } from './mappers';
import { constrainRRule } from './recurrence';
import * as schema from './schema';
import { buildCalendarEvent } from './sse-events';
import type {
    CreateEventArgs,
    InvitationExceptionPayload,
    InvitationUpdatePayload,
    ReceiveInvitationPayload,
} from './types';

// Inbound scheduling messages against this Home's copy of somebody else's event, guarded by revision so a replay is ordered out (docs/CALENDAR.md § Invitations).

// What the transport vouches for about an inbound REQUEST — never anything the body spells.
type InvitationLink = {
    organizerEmail: string;
    organizerEventId: string;
    organizerUserId: string;
    createByUserId: string;
};

// What the inbound-REQUEST decision did, so the broadcast and the notification can run after release.
type InboundRequestOutcome =
    | { kind: 'dropped'; reason: string }
    | { kind: 'updated'; event: CalendarEvent; title: string; startTime: Date }
    | { kind: 'created'; event: CalendarEvent; payload: ReceiveInvitationPayload };

// A fire-and-forget receiver has nobody to answer a 413 or a 507 to, so a message the store will not keep is dropped rather than raised.
async function unlessRefused<T>(uid: string, apply: () => Promise<T>, dropped: T): Promise<T> {
    try {
        return await apply();
    } catch (e) {
        if (!(e instanceof ApiError) || (e.status !== 413 && e.status !== 507)) throw e;
        console.info(`calendar: dropped a message for ${uid} — ${e.message}`);
        return dropped;
    }
}

const REFUSED: InboundRequestOutcome = { kind: 'dropped', reason: 'the store would not keep it' };

// One guest's PARTSTAT moved on a list that is otherwise untouched; addresses match case-insensitively.
function withAttendeeStatus(attendees: Attendee[], email: string, status: Attendee['status']): Attendee[] {
    return attendees.map((a) => (a.email.toLowerCase() === email.toLowerCase() ? { ...a, status } : a));
}

// The relay carries the same REQUEST an iMIP mail does, so it takes the same decision over the same shape.
function relayedRequest(payload: ReceiveInvitationPayload): ParsedEvent {
    return {
        uid: payload.uid,
        title: payload.title,
        description: payload.description,
        location: payload.location,
        startTime: payload.startTime,
        endTime: payload.endTime,
        allDay: payload.allDay,
        rrule: payload.rrule,
        timezone: payload.timezone,
        status: payload.status,
        sequence: payload.sequence,
        dtstamp: payload.dtstamp ?? null,
        recurrenceDate: payload.recurrenceDate ?? null,
        // A relayed key is already the series' own wall date, so there is no UTC-Z instant to re-key from.
        recurrenceInstant: null,
        data: payload.data,
    };
}

function inboundUpdatePayload(parsed: ParsedEvent): InvitationUpdatePayload {
    return {
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
        attendees: parsed.data?.attendees,
    };
}

function inboundExceptionPayload(parsed: ParsedEvent): InvitationExceptionPayload {
    return {
        recurrenceDate: parsed.recurrenceDate!,
        recurrenceInstant: parsed.recurrenceInstant,
        title: parsed.title,
        description: parsed.description,
        location: parsed.location,
        startTime: parsed.startTime,
        endTime: parsed.endTime,
        allDay: parsed.allDay,
        timezone: parsed.timezone,
        status: parsed.status,
        sequence: parsed.sequence,
        dtstamp: parsed.dtstamp,
        attendees: parsed.data?.attendees,
    };
}

function inboundInvitationPayload(parsed: ParsedEvent, link: InvitationLink): ReceiveInvitationPayload {
    return {
        uid: parsed.uid,
        recurrenceDate: parsed.recurrenceDate,
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
            organizer: parsed.data?.organizer ? { ...parsed.data.organizer, userId: link.organizerUserId } : undefined,
            organizerEventId: link.organizerEventId,
        },
        createByUserId: link.createByUserId,
        organizerEventId: link.organizerEventId,
        organizerUserId: link.organizerUserId,
    };
}

function findLinkedEvent(calendar: Calendar, orgEventId: string, orgUserId: string): CalendarEvent | null {
    const row = calendar
        .joinedEvents()
        .where(
            and(
                eq(schema.events.organizerEventId, orgEventId),
                eq(schema.events.organizerUserId, orgUserId),
                isNull(schema.events.parentEventId),
            ),
        )
        .get();
    return row ? toEvent(row) : null;
}

// The row shape of an invitation payload: only the fields a trusted message stated ever reach it.
function invitationInput(payload: ReceiveInvitationPayload): CreateEventArgs {
    return {
        title: payload.title,
        description: payload.description,
        location: payload.location,
        startTime: payload.startTime,
        endTime: payload.endTime,
        allDay: payload.allDay,
        rrule: payload.rrule,
        timezone: payload.timezone,
        status: payload.status,
        sequence: payload.sequence,
        dtstamp: payload.dtstamp,
        data: {
            ...payload.data,
            organizer: payload.data.organizer
                ? { ...payload.data.organizer, userId: payload.organizerUserId }
                : undefined,
            organizerEventId: payload.organizerEventId,
        },
        createByUserId: payload.createByUserId,
        uid: payload.uid,
        // An invitation to one occurrence of a series this Home does not hold keeps its RECURRENCE-ID: nothing else records which occurrence it answers for.
        recurrenceDate: payload.recurrenceDate,
    };
}

// A REQUEST relayed from the organizer's Home. Null when it was dropped, so the sender can say so.
export async function receiveInvitation(calendar: Calendar, payload: ReceiveInvitationPayload): Promise<string | null> {
    // A Home is never its own organizer: adopting such a message would make its own event a linked copy of itself.
    if (payload.organizerUserId === calendar.home.user.id) {
        console.info(
            `calendar: dropped a relayed invitation for ${payload.uid} — this Home is named as its own organizer`,
        );
        return null;
    }
    const link: InvitationLink = {
        organizerEmail: payload.data.organizer?.email.toLowerCase() ?? '',
        organizerEventId: payload.organizerEventId,
        organizerUserId: payload.organizerUserId,
        createByUserId: payload.createByUserId,
    };
    const outcome = await unlessRefused(
        payload.uid,
        () => calendar.writeLock.run(() => decideInboundRequest(calendar, relayedRequest(payload), link)),
        REFUSED,
    );
    if (outcome.kind === 'dropped') {
        console.info(`calendar: dropped a relayed invitation for ${payload.uid} — ${outcome.reason}`);
        return null;
    }
    return settleInboundRequest(calendar, outcome, link);
}

function notifyInvitationReceived(calendar: Calendar, payload: ReceiveInvitationPayload): void {
    calendar.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_INVITE_RECEIVED, payload.organizerUserId));
    const organizer = payload.data?.organizer;
    calendar.home.notifications?.persist({
        type: 'calendar-invite',
        actorEmail: organizer?.email,
        title: `${actorDisplayName(organizer?.name, organizer?.email)} invited you`,
        body: payload.title,
        tag: `calendar-invite:${payload.organizerEventId}:${payload.startTime.getTime()}`,
        details: { startTime: payload.startTime.getTime() },
    });
}

export async function receiveInvitationUpdate(
    calendar: Calendar,
    orgEventId: string,
    orgUserId: string,
    payload: InvitationUpdatePayload,
): Promise<void> {
    const linked = await unlessRefused(
        orgEventId,
        () =>
            calendar.writeLock.run(async () => {
                const linked = findLinkedEvent(calendar, orgEventId, orgUserId);
                if (!linked) return null;
                // One occurrence attaches as an exception, as a REQUEST with a RECURRENCE-ID does; a full update would collapse the series.
                const key = exceptionKeyOf(linked, payload.recurrenceDate);
                const applied = key
                    ? await applyInvitationException(calendar, linked, {
                          ...payload,
                          recurrenceDate: key,
                          recurrenceInstant: null,
                          timezone: payload.timezone ?? null,
                      })
                    : await applyInvitationUpdate(calendar, linked, payload);
                return applied ? linked : null;
            }),
        null,
    );
    if (linked) notifyInvitationUpdated(calendar, linked, payload.title, payload.startTime, orgEventId, orgUserId);
}

// Null when the message is about the stored copy itself, which is the case for a copy that IS one occurrence of an unheld series.
function exceptionKeyOf(linked: CalendarEvent, recurrenceDate: string | null | undefined): string | null {
    if (!recurrenceDate || recurrenceDate === linked.recurrenceDate) return null;
    return recurrenceDate;
}

// Caller holds the write lock. False when the message is a replay the stored copy already outranks.
async function applyInvitationUpdate(
    calendar: Calendar,
    linked: CalendarEvent,
    payload: InvitationUpdatePayload,
): Promise<boolean> {
    const resource = events.resourceOf(calendar, linked.id);
    if (!resource) return false;
    const component = events.storedComponent(resource);
    // A copy that is one occurrence of a series this Home does not hold is keyed by its RECURRENCE-ID.
    const key = linked.recurrenceDate;
    if (!isNewerRevision(payload, storedRevision(component, key))) return false;

    // Never extend the rrule past what the attendee has: they may have truncated it deliberately.
    const rrule = constrainRRule(payload.rrule, linked.rrule);
    // A redelivery patches to nothing, so it costs no ctag bump and tells the user nothing twice.
    const changed = patchEvent(
        component,
        key,
        invitationPatch(linked, payload, rrule),
        events.writeContext(false, payload.dtstamp),
    );
    if (!changed) return false;
    await store.writeResource(calendar, resource.calendarId, resource.uri, component, resource);
    return true;
}

// An organizer's client restates the times in every message, so only the bounds that really moved are patched, compared against the row.
function invitationPatch(linked: CalendarEvent, payload: InvitationUpdatePayload, rrule: string | null): EventPatch {
    const moved = payload.startTime.getTime() !== linked.startTime.getTime();
    const ended = payload.endTime.getTime() !== linked.endTime.getTime();
    return {
        title: payload.title,
        description: payload.description,
        location: payload.location,
        startTime: moved ? payload.startTime : undefined,
        endTime: ended ? payload.endTime : undefined,
        allDay: payload.allDay !== linked.allDay ? payload.allDay : undefined,
        rrule: rrule ?? undefined,
        timezone: payload.timezone !== undefined ? payload.timezone : undefined,
        status: payload.status,
        data: payload.attendees ? { ...linked.data, attendees: payload.attendees } : undefined,
        // The attendee's copy carries the organizer's revision, so the next message has a number to beat.
        sequence: payload.sequence,
    };
}

function notifyInvitationUpdated(
    calendar: Calendar,
    linked: CalendarEvent,
    title: string,
    startTime: Date,
    orgEventId: string,
    orgUserId: string,
): void {
    calendar.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_INVITE_UPDATED, orgUserId));
    const organizer = linked.data?.organizer;
    calendar.home.notifications?.persist({
        type: 'calendar-invite-updated',
        actorEmail: organizer?.email,
        title: `${actorDisplayName(organizer?.name, organizer?.email)} updated an invitation`,
        body: title,
        tag: `calendar-invite:${orgEventId}:${startTime.getTime()}`,
        details: { startTime: startTime.getTime() },
    });
}

// Caller holds the write lock.
async function applyInvitationException(
    calendar: Calendar,
    linked: CalendarEvent,
    payload: InvitationExceptionPayload,
): Promise<boolean> {
    const recurrenceDate = recurrenceKeyForSeries(payload.recurrenceDate, payload.recurrenceInstant, linked.timezone);
    const resource = events.resourceOf(calendar, linked.id);
    if (!resource) return false;
    const component = events.storedComponent(resource);
    if (!isNewerRevision(payload, storedRevision(component, recurrenceDate))) return false;

    const existing = events.exceptionOf(calendar, linked.id, recurrenceDate);
    const data: EventData = {
        ...linked.data,
        attendees: payload.attendees ?? existing?.data?.attendees ?? linked.data?.attendees,
    };
    await events.writeEvent(calendar, linked.calendarId, {
        title: payload.title,
        description: payload.description,
        location: payload.location,
        startTime: payload.startTime,
        endTime: payload.endTime,
        allDay: payload.allDay,
        timezone: payload.timezone ?? linked.timezone,
        parentEventId: linked.id,
        recurrenceDate,
        status: payload.status,
        sequence: payload.sequence,
        dtstamp: payload.dtstamp,
        data,
        createByUserId: linked.createByUserId,
        uid: linked.uid,
    });
    return true;
}

// Re-key a UTC-Z RECURRENCE-ID against the stored series' tz: a lone VEVENT cannot tell the parser its own.
function recurrenceKeyForSeries(
    recurrenceDate: string,
    recurrenceInstant: Date | null | undefined,
    tz: string | null,
): string {
    if (!recurrenceInstant || !tz) return recurrenceDate;
    const { year, month, day } = utcToLocal(recurrenceInstant, tz);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${year}-${pad(month)}-${pad(day)}`;
}

// `sender` is the DKIM-aligned From address the caller verified; the link is by address alone.
export async function receiveImipRequest(calendar: Calendar, parsed: ParsedEvent, sender: string): Promise<void> {
    const organizerUserId = externalOwnerId(sender);
    const link: InvitationLink = {
        organizerEmail: sender,
        organizerEventId: parsed.uid,
        organizerUserId,
        createByUserId: organizerUserId,
    };
    const outcome = await unlessRefused(
        parsed.uid,
        () => calendar.writeLock.run(() => decideInboundRequest(calendar, parsed, link)),
        REFUSED,
    );
    if (outcome.kind === 'dropped') {
        console.info(`iMIP: dropped a REQUEST for ${parsed.uid} from ${sender} — ${outcome.reason}`);
        return;
    }
    settleInboundRequest(calendar, outcome, link);
}

// The broadcast and the notification an applied REQUEST owes, run after the write lock is released.
function settleInboundRequest(calendar: Calendar, outcome: InboundRequestOutcome, link: InvitationLink): string | null {
    if (outcome.kind === 'dropped') return null;
    if (outcome.kind === 'created') {
        calendar.announce(outcome.event.calendarId, SSEventType.CALENDAR_EVENT_CREATED);
        notifyInvitationReceived(calendar, outcome.payload);
        return outcome.event.id;
    }
    calendar.announce(outcome.event.calendarId, SSEventType.CALENDAR_EVENT_UPDATED);
    notifyInvitationUpdated(
        calendar,
        outcome.event,
        outcome.title,
        outcome.startTime,
        link.organizerEventId,
        link.organizerUserId,
    );
    return outcome.event.id;
}

// Home-wide and inside the write lock, so two concurrent deliveries never file two masters for one UID. Caller holds the write lock.
async function decideInboundRequest(
    calendar: Calendar,
    parsed: ParsedEvent,
    link: InvitationLink,
): Promise<InboundRequestOutcome> {
    const sender = link.organizerEmail;
    const applied = (event: CalendarEvent): InboundRequestOutcome => ({
        kind: 'updated',
        event,
        title: parsed.title,
        startTime: parsed.startTime,
    });
    const stored = calendar.joinedEvents().where(eq(schema.events.uid, parsed.uid)).all().map(toEvent);
    // The master alone, as findLinkedEvent does: an exception inherits the link and would answer for the series.
    const linked = stored.find((e) => !e.parentEventId && e.data?.organizer && e.data?.organizerEventId);

    if (linked) {
        // An update binds to the STORED organizer, so a co-attendee cannot hijack the invitation.
        if (linked.data?.organizer?.email.toLowerCase() !== sender) {
            return { kind: 'dropped', reason: 'the sender is not the organizer this copy is linked to' };
        }
        // A copy that is one occurrence of an unheld series gives way to the series once the organizer invites this Home to all of it.
        if (linked.recurrenceDate && !parsed.recurrenceDate) {
            const resource = events.resourceOf(calendar, linked.id);
            const component = resource ? events.storedComponent(resource) : null;
            if (component && !isNewerRevision(parsed, storedRevision(component, linked.recurrenceDate))) {
                return { kind: 'dropped', reason: 'nothing newer to apply' };
            }
            return fileNewInvitation(calendar, parsed, link, linked);
        }
        // A "this event" edit attaches as an exception: a full update would collapse the series.
        const moved = exceptionKeyOf(linked, parsed.recurrenceDate)
            ? await applyInvitationException(calendar, linked, inboundExceptionPayload(parsed))
            : await applyInvitationUpdate(calendar, linked, inboundUpdatePayload(parsed));
        return moved ? applied(linked) : { kind: 'dropped', reason: 'nothing newer to apply' };
    }

    const master = stored.find((e) => !e.parentEventId);
    if (master) {
        // The organizer may claim an event nobody linked, but only when it names the verified sender.
        const resource = events.resourceOf(calendar, master.id);
        const component = resource ? events.storedComponent(resource) : null;
        if (!resource || !component || storedOrganizerAddress(component) !== sender) {
            return { kind: 'dropped', reason: 'the stored event names another organizer' };
        }
        if (parsed.recurrenceDate) {
            return { kind: 'dropped', reason: 'an occurrence of a series nobody organizes here yet' };
        }
        await adoptAsInvitation(calendar, master, resource, component, parsed, link);
        return applied(master);
    }

    return fileNewInvitation(calendar, parsed, link);
}

// One naming an occurrence files as a standalone event: the guest was invited to that instance, not the series. Caller holds the write lock.
async function fileNewInvitation(
    calendar: Calendar,
    parsed: ParsedEvent,
    link: InvitationLink,
    replaces?: CalendarEvent,
): Promise<InboundRequestOutcome> {
    // A new invitation is attributed to its sender, so the body's ORGANIZER must be that address.
    if (parsed.data?.organizer?.email?.toLowerCase() !== link.organizerEmail) {
        return { kind: 'dropped', reason: 'the ICS organizer is not the sender' };
    }
    const defaultCal = calendar.db
        .select()
        .from(schema.calendars)
        .all()
        .find((row) => row.isDefault);
    if (!defaultCal) return { kind: 'dropped', reason: 'no default calendar' };
    // Nothing the guest holds is dropped until this message is certain to file.
    const replaced = replaces && events.resourceOf(calendar, replaces.id);
    if (replaced) await calendar.purgeResource(replaced);
    const payload = inboundInvitationPayload(parsed, link);
    const input = invitationInput(payload);
    const event = await events.writeEvent(calendar, defaultCal.id, {
        ...input,
        // Reminders and color are the guest's own, the two fields a linked copy lets them keep.
        data: {
            ...input.data,
            reminders: replaces?.data?.reminders ?? input.data?.reminders,
            color: replaces?.data?.color ?? input.data?.color,
        },
    });
    return { kind: 'created', event, payload };
}

// Caller holds the write lock. Same file, same row ids; the link and the guest list come from the message.
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
            ...invitationPatch(master, inboundUpdatePayload(parsed), parsed.rrule),
            data: { ...master.data, organizer, attendees: parsed.data?.attendees },
        },
        events.writeContext(false, parsed.dtstamp),
    );
    await store.writeResource(calendar, resource.calendarId, resource.uri, component, resource);
}

// Just that instance — removeInvitation would delete the attendee's entire linked series.
export async function cancelInvitationOccurrence(
    calendar: Calendar,
    orgEventId: string,
    orgUserId: string,
    recurrenceDate: string,
    recurrenceInstant: Date | null | undefined,
    revision: Revision,
): Promise<void> {
    // The event the write landed on, so the announcement and the notice after the lock name the instance.
    const cancelled = await unlessRefused(
        orgEventId,
        () =>
            calendar.writeLock.run(async () => {
                const linked = findLinkedEvent(calendar, orgEventId, orgUserId);
                if (!linked) return null;
                const resource = events.resourceOf(calendar, linked.id);
                if (!resource) return null;
                const component = events.storedComponent(resource);
                const key = recurrenceKeyForSeries(recurrenceDate, recurrenceInstant, linked.timezone);
                // A copy that IS the cancelled occurrence has no series to exclude it from: it goes.
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
    calendar.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_INVITE_CANCELLED, orgUserId));
    calendar.announce(cancelled.linked.calendarId, SSEventType.CALENDAR_EVENT_UPDATED);
    notifyInvitationCancelled(calendar, cancelled.linked, cancelled.startTime, orgEventId);
}

// One occurrence or the whole series: the guest is told who cancelled what, and which instant it was on.
function notifyInvitationCancelled(
    calendar: Calendar,
    linked: CalendarEvent,
    startTime: Date,
    orgEventId: string,
): void {
    const organizer = linked.data?.organizer;
    calendar.home.notifications?.persist({
        type: 'calendar-invite-cancelled',
        actorEmail: organizer?.email,
        title: `${actorDisplayName(organizer?.name, organizer?.email)} canceled an invitation`,
        body: linked.title,
        tag: `calendar-invite:${orgEventId}:${startTime.getTime()}`,
    });
}

export async function removeInvitation(calendar: Calendar, orgEventId: string, orgUserId: string): Promise<void> {
    const linked = await calendar.writeLock.run(async () => {
        const linked = findLinkedEvent(calendar, orgEventId, orgUserId);
        const resource = linked && events.resourceOf(calendar, linked.id);
        if (!linked || !resource) return null;
        await calendar.purgeResource(resource);
        return linked;
    });
    if (!linked) return;

    calendar.home.broadcast(buildCalendarEvent(SSEventType.CALENDAR_INVITE_CANCELLED, orgUserId));
    notifyInvitationCancelled(calendar, linked, linked.startTime, orgEventId);
}

// Fire-and-forget like every other receiver here, so a refused PARTSTAT drops and the rest of the message still files.
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

async function updateAttendeeStatus(
    calendar: Calendar,
    eventId: string,
    email: string,
    status: Attendee['status'],
): Promise<void> {
    // The guest list is read inside the write lock, so two RSVPs never merge into a list the other replaced.
    await calendar.writeLock.run(async () => {
        const event = events.eventById(calendar, eventId);
        if (!event?.data?.attendees) return;
        const resource = events.resourceOf(calendar, eventId);
        if (!resource) return;

        const attendees = withAttendeeStatus(event.data.attendees, email, status);
        const key = event.recurrenceDate ? storedRecurrenceKey(event.recurrenceDate) : null;
        await events.patchResource(
            calendar,
            resource,
            key,
            { data: { ...event.data, attendees } },
            events.writeContext(false),
        );
    });
}

// `restoreCancelled`: an attendee may un-cancel their own occurrence, but an organizer-side receiver only moves PARTSTAT (RFC 5546).
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
        const parent = events.eventById(calendar, eventId);
        if (!parent) throw new ApiError(404, 'Event not found');

        const key = recurrenceKeyForSeries(recurrenceDate, recurrenceInstant, parent.timezone);
        const existing = events.exceptionOf(calendar, eventId, key);
        // A deleted occurrence is an EXDATE, which carries no attendee list to record a PARTSTAT in.
        if (existing?.status === 'cancelled' && !restoreCancelled) return null;
        const data = existing?.data ?? parent.data ?? {};
        // Only recorded invitees may leave a PARTSTAT; someone can be invited to a single occurrence only.
        const invitees = data.attendees ?? parent.data?.attendees ?? [];
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

        const { startTime, endTime } = computeOccurrenceTimes(parent, key);
        await events.writeEvent(calendar, parent.calendarId, {
            title: existing?.title ?? parent.title,
            description: parent.description,
            location: parent.location,
            startTime: existing?.startTime ?? startTime,
            endTime: existing?.endTime ?? endTime,
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
    if (calendarId) calendar.announce(calendarId, SSEventType.CALENDAR_EVENT_UPDATED);
}

// Caller holds the write lock. `revision` is the CANCEL's, so a stale redelivery can be ordered against it.
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

    const scope = input.scope || 'all';
    const organizerUserId = event.data.organizer.userId;
    const organizerEventId = event.data.organizerEventId!;
    const isExternalOrganizer = isExternalOwnerId(organizerUserId);
    // A copy that IS one occurrence of an unheld series answers for that occurrence, and the organizer keeps its guest list on their override.
    const ownOccurrence = answeredOccurrence(event);

    const sendRsvpReply = (status: Attendee['status'], recurrenceDate?: string) => {
        const mail = composeRsvpReply(event, user.email, user.name ?? user.email, status, recurrenceDate);
        sendMail(mail).catch(console.error);
    };

    if (scope === 'this' && input.recurrenceDate) {
        // A full ISO datetime is an old client naming one occurrence; anything unkeyable names none.
        const recurrenceDate = storedRecurrenceKey(input.recurrenceDate);
        if (!recurrenceDate) throw new ApiError(400, 'Invalid recurrenceDate');
        const status = input.remove ? 'declined' : input.status;
        if (input.remove) {
            await calendar.writeLock.run(() => removeOccurrence(calendar, eventId, recurrenceDate));
            calendar.announce(event.calendarId, SSEventType.CALENDAR_EVENT_UPDATED);
        } else {
            await rsvpForOccurrence(calendar, eventId, user.email, input.status, recurrenceDate, null, true);
        }
        if (isExternalOrganizer) {
            sendRsvpReply(status, recurrenceDate);
        } else {
            propagateRsvp(organizerUserId, organizerEventId, user.email, status, recurrenceDate).catch(console.error);
        }
    } else if (scope === 'this-and-following' && input.remove && input.recurrenceDate) {
        const recurrenceDate = storedRecurrenceKey(input.recurrenceDate);
        if (!recurrenceDate) throw new ApiError(400, 'Invalid recurrenceDate');
        await removeThisAndFuture(calendar, eventId, recurrenceDate);
        if (isExternalOrganizer) sendRsvpReply('declined');
        else propagateRsvp(organizerUserId, organizerEventId, user.email, 'declined').catch(console.error);
    } else if (input.remove) {
        await events.deleteEvent(calendar, event.calendarId, eventId, user);
    } else {
        await updateAttendeeStatus(calendar, eventId, user.email, input.status);
        if (isExternalOrganizer) sendRsvpReply(input.status);
        else {
            propagateRsvp(organizerUserId, organizerEventId, user.email, input.status, ownOccurrence).catch(
                console.error,
            );
        }
    }
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
