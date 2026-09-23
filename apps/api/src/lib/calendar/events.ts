import { randomUUID } from 'node:crypto';
import { isInvitationFromOthers } from '@workspace/lib/calendar/calendar-utils';
import type { Attendee, CalendarEvent, EventData } from '@workspace/lib/types/calendar';
import { isExternalOwnerId } from '@workspace/lib/types/owner';
import { SSEventType } from '@workspace/lib/types/sse';
import { and, eq } from 'drizzle-orm';
import type ICAL from 'ical.js';
import { RRule } from 'rrule';
import { ApiError } from '../core';
import { sendMail } from '../core/mailer';
import { addExclusion, buildResource, parseResource, patchEvent, putOverride, removeExclusion } from '../ical';
import type { EventPatch, WriteContext } from '../ical/ical-component';
import { isOutOfRangeRecurrenceStart, isSubDailyRrule } from '../ical/recurrence-limits';
import { storedRecurrenceKey } from '../ical/wall-clock';
import type { User } from '../user';
import type { Calendar } from './calendar';
import * as davStore from './dav-store';
import { eventForResource, validateEventInput } from './event-input';
import { composeRsvpReply } from './imip';
import { answeredOccurrence, propagateCancellation, propagateDecline, propagateInvitation } from './invite-propagation';
import { toEvent } from './mappers';
import { prepareResource, resourceBytes } from './resource-store';
import * as schema from './schema';
import type { CreateEventArgs } from './types';

// Event mutation over the Calendar facade. See docs/CALENDAR.md § The write path.

// Where an edit writes and what it credits against the quota; the bytes are the one column no caller needs by default.
const STORED_RESOURCE = {
    id: schema.resources.id,
    calendarId: schema.resources.calendarId,
    uri: schema.resources.uri,
    uid: schema.resources.uid,
    etag: schema.resources.etag,
    size: resourceBytes,
};
export type StoredResource = Pick<
    typeof schema.resources.$inferSelect,
    'id' | 'calendarId' | 'uri' | 'uid' | 'etag'
> & {
    size: number;
};

// The stored component of a resource: the bytes are the truth, so every path that parses them reads them itself.
export function storedComponent(calendar: Calendar, resource: Pick<StoredResource, 'id'>): ICAL.Component {
    const row = calendar.db
        .select({ ics: schema.resources.ics })
        .from(schema.resources)
        .where(eq(schema.resources.id, resource.id))
        .get()!;
    return parseResource(new TextDecoder().decode(row.ics));
}

export function eventById(calendar: Calendar, id: string): CalendarEvent | null {
    const row = calendar.joinedEvents().where(eq(schema.events.id, id)).get();
    return row ? toEvent(row) : null;
}

export function resourceOf(calendar: Calendar, eventId: string): StoredResource | null {
    return (
        calendar.db
            .select(STORED_RESOURCE)
            .from(schema.resources)
            .innerJoin(schema.events, eq(schema.events.resourceId, schema.resources.id))
            .where(eq(schema.events.id, eventId))
            .get() ?? null
    );
}

// Caller holds the write lock: the component path onto the facade's one write, re-serializing the resource the caller resolved.
export function writeComponent(calendar: Calendar, resource: StoredResource, component: ICAL.Component): Promise<void> {
    return calendar.writeResource({
        calendarId: resource.calendarId,
        uri: resource.uri,
        prepared: prepareResource(resource.calendarId, component, resource.id),
        creditBytes: resource.size,
    });
}

// Caller holds the write lock: the bytes it mutates are the bytes the commit overwrites.
async function editResource(
    calendar: Calendar,
    resource: StoredResource,
    mutate: (component: ICAL.Component) => void,
): Promise<void> {
    const component = storedComponent(calendar, resource);
    mutate(component);
    await writeComponent(calendar, resource, component);
}

// Caller holds the write lock and has already resolved the resource this patch means.
export async function patchResource(
    calendar: Calendar,
    resource: StoredResource,
    recurrenceKey: string | null,
    patch: EventPatch,
    context: WriteContext,
): Promise<void> {
    await editResource(calendar, resource, (component) => {
        patchEvent(component, recurrenceKey, patch, context);
    });
}

export function writeContext(actorIsOrganizer: boolean, dtstamp?: Date | null): WriteContext {
    return { now: new Date(), actorIsOrganizer, dtstamp };
}

// A resource carrying the organizer link is somebody else's: a SEQUENCE bump here would outrank the organizer's next message.
function actorIsOrganizer(event: CalendarEvent): boolean {
    return !event.data?.organizerEventId;
}

export async function createEvent(
    calendar: Calendar,
    calendarId: string,
    input: CreateEventArgs,
    user?: User,
): Promise<CalendarEvent> {
    // Who holds the occurrence this write replaces: a cancelled override keeps no guest list of its own.
    const { created, replaced } = await calendar.writeLock.run(async () => {
        const replaced = input.parentEventId
            ? exceptionOf(calendar, input.parentEventId, input.recurrenceDate ?? null)
            : null;
        return { created: await writeEvent(calendar, calendarId, input), replaced };
    });

    calendar.announce(SSEventType.CALENDAR_EVENT_CREATED, calendarId);
    if (user) propagateWrite(calendar, created, user, replaced?.data?.attendees ?? []).catch(console.error);
    return created;
}

// An override is one occurrence of its series: the series states the guest list, and its id is what every message names.
async function propagateWrite(
    calendar: Calendar,
    event: CalendarEvent,
    user: User,
    oldAttendees: Attendee[],
): Promise<void> {
    const series = event.parentEventId ? eventById(calendar, event.parentEventId) : null;
    // The guests hold the series' list when the override states none of its own, so a name missing from it cancels that instance.
    const held = oldAttendees.length ? oldAttendees : (series?.data?.attendees ?? []);
    // A cancelled occurrence rides as an EXDATE and keeps no guest list, so the ones it drops are the ones who held it.
    const attendees = event.data?.attendees ?? (series ? held : []);
    // A write that names nobody and replaced nobody owes the guests nothing; emptying the list cancels.
    if (!attendees.length && !held.length) return;
    // Only the organizer fans out: a guest's own edit bumping SEQUENCE would outrun the organizer's updates.
    if (isInvitationFromOthers(series ?? event, calendar.home.user.email)) return;
    if (series && event.status === 'cancelled') {
        await propagateCancellation(calendar.home, event, held, series);
        return;
    }
    // A series message restates its exceptions, or a guest's copy renders a moved occurrence at its original slot; an occurrence write is itself one exception and carries none.
    const exceptions = series ? [] : exceptionsOf(calendar, event.id);
    await propagateInvitation(calendar.home, event, user, held, attendees, series ?? undefined, exceptions);
}

// The locked core every writer of a NEW event shares: the checks that decide WHICH resource is written run in it.
export async function writeEvent(
    calendar: Calendar,
    calendarId: string,
    input: CreateEventArgs,
): Promise<CalendarEvent> {
    // A resource under a calendar nobody owns any more would dangle on its foreign key.
    if (!calendar.calendarRow(calendarId)) throw new ApiError(404, 'Calendar not found');
    validateEventInput(input);
    if (input.parentEventId) return writeOverride(calendar, calendarId, input);

    // Eigen mints every name it writes: a UID is its author's string and may carry `/`, `..` or quotes.
    const uri = `${randomUUID()}.ics`;
    const uid = input.uid || randomUUID();
    if (uidHolder(calendar, calendarId, uid)) throw new ApiError(409, 'An event with this UID already exists');
    const event = eventForResource({ id: randomUUID(), calendarId, uid, input, now: new Date() });
    await calendar.writeResource({
        calendarId,
        uri,
        prepared: prepareResource(calendarId, buildResource([event]), null),
        creditBytes: 0,
    });
    return eventById(calendar, event.id)!;
}

// An exception is one VEVENT inside its master's file; a cancellation rides as an EXDATE plus its stamp.
async function writeOverride(calendar: Calendar, calendarId: string, input: CreateEventArgs): Promise<CalendarEvent> {
    const parent = eventById(calendar, input.parentEventId!);
    if (!parent || parent.calendarId !== calendarId || parent.parentEventId) {
        throw new ApiError(404, 'Event not found');
    }
    const resource = resourceOf(calendar, parent.id);
    if (!resource) throw new ApiError(404, 'Event not found');
    // A RECURRENCE-ID and an EXDATE are both written from this key.
    if (!input.recurrenceDate || !storedRecurrenceKey(input.recurrenceDate)) {
        throw new ApiError(400, 'Invalid occurrence date');
    }

    const override = eventForResource({
        id: randomUUID(),
        calendarId,
        uid: parent.uid,
        input: { ...input, rrule: null },
        now: new Date(),
    });
    await editResource(calendar, resource, (component) => {
        if (override.status === 'cancelled') {
            addExclusion(component, parent, override, writeContext(actorIsOrganizer(parent), input.dtstamp));
        } else {
            putOverride(component, parent, override);
        }
    });
    const stored = exceptionOf(calendar, parent.id, override.recurrenceDate);
    return stored ?? eventById(calendar, parent.id)!;
}

export function exceptionOf(
    calendar: Calendar,
    parentEventId: string,
    recurrenceDate: string | null,
): CalendarEvent | null {
    if (!recurrenceDate) return null;
    const key = storedRecurrenceKey(recurrenceDate);
    if (!key) return null;
    const row = calendar
        .joinedEvents()
        .where(and(eq(schema.events.parentEventId, parentEventId), eq(schema.events.recurrenceDate, key)))
        .get();
    return row ? toEvent(row) : null;
}

// Every exception a master holds, overrides and cancellations alike, in the order the file lists them.
export function exceptionsOf(calendar: Calendar, parentEventId: string): CalendarEvent[] {
    return calendar.joinedEvents().where(eq(schema.events.parentEventId, parentEventId)).all().map(toEvent);
}

function uidHolder(calendar: Calendar, calendarId: string, uid: string): { uri: string } | undefined {
    return calendar.db
        .select({ uri: schema.resources.uri })
        .from(schema.resources)
        .where(and(eq(schema.resources.calendarId, calendarId), eq(schema.resources.uid, uid)))
        .get();
}

export async function updateEvent(
    calendar: Calendar,
    calendarId: string,
    id: string,
    input: EventPatch,
    user?: User,
    expectedEtag?: string,
): Promise<CalendarEvent> {
    const { updated, oldAttendees } = await calendar.writeLock.run(() =>
        patchStoredEvent(calendar, calendarId, id, input, user, expectedEtag),
    );
    calendar.announce(SSEventType.CALENDAR_EVENT_UPDATED, calendarId);

    if (user) propagateWrite(calendar, updated, user, oldAttendees).catch(console.error);
    return updated;
}

// Caller holds the write lock, so the row the patch is computed against is the row the write overwrites.
async function patchStoredEvent(
    calendar: Calendar,
    calendarId: string,
    id: string,
    input: EventPatch,
    user?: User,
    expectedEtag?: string,
): Promise<{ updated: CalendarEvent; oldAttendees: Attendee[] }> {
    const existing = eventById(calendar, id);
    // 404 (not 403) on calendar mismatch so a share on one calendar can't oracle event ids in another.
    if (!existing || existing.calendarId !== calendarId) throw new ApiError(404, 'Event not found');

    // Linked event guard: attendees can only change local fields (reminders, color).
    const linked = isInvitationFromOthers(existing, calendar.home.user.email);
    if (linked) {
        const localData: EventData = { ...existing.data };
        if (input.data) {
            localData.reminders = input.data.reminders ?? localData.reminders;
            localData.color = input.data.color ?? localData.color;
        }
        input = { data: localData };
    }

    const oldAttendees = existing.data?.attendees ?? [];
    const startTime = input.startTime ?? existing.startTime;
    const endTime = input.endTime ?? existing.endTime;
    // Same interval invariant as createEvent, on the resolved (possibly dragged) times.
    if (endTime < startTime) throw new ApiError(400, 'Event end time cannot be before start time');

    const rruleStr = input.rrule !== undefined ? (input.rrule ?? null) : (existing.rrule ?? null);
    if (rruleStr && input.rrule !== undefined) {
        try {
            RRule.parseString(rruleStr);
        } catch {
            throw new ApiError(400, 'Invalid RRULE');
        }
        if (isSubDailyRrule(rruleStr)) throw new ApiError(400, 'Sub-daily recurrence is not supported');
    }
    // Both directions poison a stored row: a new rrule, or a recurring start moved out of range.
    if (
        rruleStr &&
        (input.rrule !== undefined || input.startTime !== undefined) &&
        isOutOfRangeRecurrenceStart(startTime)
    ) {
        throw new ApiError(400, 'Recurring event start time is out of range');
    }

    const resource = resourceOf(calendar, id);
    if (!resource) throw new ApiError(404, 'Event not found');
    if (expectedEtag !== undefined && expectedEtag !== resource.etag) {
        throw new ApiError(412, 'Event was changed elsewhere');
    }

    // A save form restates the times on every edit, so only the bounds that really moved reach the patch.
    const startMoved = input.startTime !== undefined && input.startTime.getTime() !== existing.startTime.getTime();
    const endMoved = input.endTime !== undefined && input.endTime.getTime() !== existing.endTime.getTime();
    const allDayMoved = input.allDay !== undefined && input.allDay !== existing.allDay;

    const key = existing.recurrenceDate ? storedRecurrenceKey(existing.recurrenceDate) : null;
    await patchResource(
        calendar,
        resource,
        key,
        {
            title: input.title?.trim(),
            description: input.description,
            location: input.location,
            startTime: startMoved ? input.startTime : undefined,
            endTime: endMoved ? input.endTime : undefined,
            allDay: allDayMoved ? input.allDay : undefined,
            rrule: input.rrule ?? undefined,
            timezone: input.timezone,
            status: input.status,
            data: input.data ?? undefined,
        },
        writeContext(!!user && !linked),
    );

    return { updated: eventById(calendar, id)!, oldAttendees };
}

export async function deleteEvent(calendar: Calendar, calendarId: string, id: string, user?: User): Promise<void> {
    const existing = await calendar.writeLock.run(() => eraseStoredEvent(calendar, calendarId, id));
    if (!existing) return;

    const invitation = isInvitationFromOthers(existing, calendar.home.user.email) ? existing.data : null;
    // Only an attendee has an RSVP to give: any client can hang an ORGANIZER on an event.
    const declining = user && invitation?.attendees?.some((a) => a.email.toLowerCase() === user.email.toLowerCase());
    if (user && declining && invitation?.organizer) {
        const orgUserId = invitation.organizer.userId;
        // An organizer known by address only has no Eigen id to relay to, so the decline goes as a REPLY.
        if (!orgUserId || isExternalOwnerId(orgUserId)) {
            const mail = composeRsvpReply(existing, user.email, user.name ?? user.email, 'declined');
            sendMail(mail).catch(console.error);
        } else {
            propagateDecline(orgUserId, invitation.organizerEventId!, user.email, answeredOccurrence(existing)).catch(
                console.error,
            );
        }
    } else if (!invitation && existing.data?.attendees?.length) {
        // An event with no foreign organizer makes this user its organizer, and an organizer's delete cancels.
        propagateCancellation(calendar.home, existing, existing.data.attendees).catch(console.error);
    }

    calendar.announce(SSEventType.CALENDAR_EVENT_DELETED, calendarId);
}

// Caller holds the write lock; the row it answers with is what the decline or cancellation mail is composed from.
async function eraseStoredEvent(calendar: Calendar, calendarId: string, id: string): Promise<CalendarEvent | null> {
    const existing = eventById(calendar, id);
    // Idempotent, and the event is not evaluated further for a resource that no longer exists.
    if (!existing) return null;
    // 404 (not 403) on calendar mismatch so a share on one calendar can't oracle event ids in another.
    if (existing.calendarId !== calendarId) throw new ApiError(404, 'Event not found');
    const resource = resourceOf(calendar, id);
    if (!resource) throw new ApiError(404, 'Event not found');

    if (existing.parentEventId) {
        // A synthetic exclusion row carries no data of its own, so the link is the master's to state.
        const parent = eventById(calendar, existing.parentEventId)!;
        // Deleting one occurrence writes the master's resource: a cancelled row is the exclusion itself, so deleting it puts the occurrence back.
        await editResource(calendar, resource, (component) => {
            const key = existing.recurrenceDate ? storedRecurrenceKey(existing.recurrenceDate) : null;
            if (!key) return;
            const context = writeContext(actorIsOrganizer(parent));
            if (existing.status === 'cancelled') removeExclusion(component, key, context);
            else addExclusion(component, parent, existing, context);
        });
    } else {
        await calendar.purgeResource(resource);
    }
    return existing;
}

// Re-home a resource inside this Home: one transaction, so the rows keep their identity and no window shows
// the event in both calendars.
export async function moveEvent(
    calendar: Calendar,
    calendarId: string,
    id: string,
    targetCalendarId: string,
): Promise<CalendarEvent> {
    const moved = await calendar.writeLock.run(async () => {
        const existing = eventById(calendar, id);
        if (!existing || existing.calendarId !== calendarId) throw new ApiError(404, 'Event not found');
        if (existing.parentEventId) throw new ApiError(400, 'Cannot move a single recurrence occurrence');
        if (targetCalendarId === calendarId) return false;
        if (!calendar.calendarRow(targetCalendarId)) throw new ApiError(404, 'Calendar not found');
        const resource = resourceOf(calendar, id);
        if (!resource) throw new ApiError(404, 'Event not found');
        // The target holding this UID would throw on its UNIQUE index.
        if (uidHolder(calendar, targetCalendarId, resource.uid)) {
            throw new ApiError(409, 'The target calendar already holds this event');
        }
        // A name the target already holds becomes a fresh one, or the move would collide on (calendarId, uri).
        const taken = !!davStore.getResourceMeta(calendar, targetCalendarId, resource.uri);
        const targetUri = taken ? `${randomUUID()}.ics` : resource.uri;

        calendar.db.transaction((tx) => {
            const sourceCtag = calendar.bumpCtag(tx, calendarId);
            calendar.tombstone(tx, calendarId, resource.uri, sourceCtag);
            const targetCtag = calendar.bumpCtag(tx, targetCalendarId);
            // Moving A→B then B→A must not leave A listing the uri as both a 200 and a 404.
            tx.delete(schema.resourceTombstones)
                .where(
                    and(
                        eq(schema.resourceTombstones.calendarId, targetCalendarId),
                        eq(schema.resourceTombstones.uri, targetUri),
                    ),
                )
                .run();
            tx.update(schema.resources)
                .set({ calendarId: targetCalendarId, uri: targetUri, resourceCtag: targetCtag })
                .where(eq(schema.resources.id, resource.id))
                .run();
            tx.update(schema.events)
                .set({ calendarId: targetCalendarId })
                .where(eq(schema.events.resourceId, resource.id))
                .run();
        });
        return true;
    });

    if (moved) {
        calendar.announce(SSEventType.CALENDAR_EVENT_UPDATED, calendarId);
        calendar.announce(SSEventType.CALENDAR_EVENT_UPDATED, targetCalendarId);
    }
    return eventById(calendar, id)!;
}
