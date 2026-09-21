import { randomUUID } from 'node:crypto';
import { isInvitationFromOthers } from '@workspace/lib/calendar/calendar-utils';
import type { Attendee, CalendarEvent, EventData } from '@workspace/lib/types/calendar';
import { isExternalOwnerId } from '@workspace/lib/types/owner';
import { SSEventType } from '@workspace/lib/types/sse';
import { and, eq } from 'drizzle-orm';
import type ICAL from 'ical.js';
import { RRule } from 'rrule';
import { ApiError, readResourceFile, uriKeyOf } from '../core';
import { sendMail } from '../core/mailer';
import { addExclusion, buildResource, patchEvent, putOverride, removeExclusion } from '../ical';
import type { EventPatch, WriteContext } from '../ical/ical-component';
import { isOutOfRangeRecurrenceStart, isSubDailyRrule } from '../ical/recurrence-limits';
import { storedRecurrenceKey } from '../ical/wall-clock';
import type { User } from '../user';
import type { Calendar } from './calendar';
import * as store from './calendar-store';
import { eventForFile, validateEventInput } from './event-input';
import { composeRsvpReply } from './imip';
import { propagateCancellation, propagateDecline, propagateInvitation } from './invite-propagation';
import { toEvent } from './mappers';
import { gateKey, resourcePath } from './resource-store';
import * as schema from './schema';
import type { CreateEventArgs } from './types';

// Event mutation over the Calendar facade: create, update, delete and move, plus the locked internals
// every other sibling writes an event through. A function named for the gate it takes holds it; one
// documented as locked expects its caller to.

export function eventById(calendar: Calendar, id: string): CalendarEvent | null {
    const row = calendar.joinedEvents().where(eq(schema.events.id, id)).get();
    return row ? toEvent(row) : null;
}

// The stored component of a resource, or null when the file is gone under a row that still names it.
export async function loadResource(
    calendar: Calendar,
    calendarId: string,
    uri: string,
): Promise<ICAL.Component | null> {
    const bytes = await readResourceFile(calendar.storage, resourcePath(calendarId, uri));
    if (!bytes) {
        calendar.gate.markDirty(gateKey(calendarId, uri));
        return null;
    }
    return calendar.parseResourceFile(bytes);
}

export function resourceOf(calendar: Calendar, eventId: string): typeof schema.resources.$inferSelect | null {
    const row = calendar.db
        .select()
        .from(schema.resources)
        .innerJoin(schema.events, eq(schema.events.resourceId, schema.resources.id))
        .where(eq(schema.events.id, eventId))
        .get();
    return row ? row.resources : null;
}

// Caller holds the gate; a throw after the rename leaves the key dirty for the next drain.
async function editResource(
    calendar: Calendar,
    resource: typeof schema.resources.$inferSelect,
    mutate: (component: ICAL.Component) => void,
): Promise<void> {
    const component = await loadResource(calendar, resource.calendarId, resource.uri);
    if (!component) throw new ApiError(404, 'Event not found');
    mutate(component);
    await store.writeResource(calendar, resource.calendarId, resource.uri, component, resource);
}

// The edit every writer but the two exclusion paths makes: one stored VEVENT patched in place.
// Caller holds the gate and has already resolved the resource it means.
export async function patchResource(
    calendar: Calendar,
    resource: typeof schema.resources.$inferSelect,
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

// A resource carrying the organizer link is somebody else's event, so the local user never writes it as its
// organizer: a SEQUENCE bump here would outrank the organizer's next message at the same revision.
function actorIsOrganizer(event: CalendarEvent): boolean {
    return !event.data?.organizerEventId;
}

export async function createEvent(
    calendar: Calendar,
    calendarId: string,
    input: CreateEventArgs,
    user?: User,
): Promise<CalendarEvent> {
    const created = await calendar.gate.run(() => writeEvent(calendar, calendarId, input));

    calendar.announce(calendarId, SSEventType.CALENDAR_EVENT_CREATED);
    if (user) propagateWrite(calendar, created, user, []).catch(console.error);
    return created;
}

// The fan-out a write owes the guests. An override is ONE occurrence of its series: the series states
// the guest list, and its id is what every message names — a cancelled override then asks the guests to
// drop that occurrence rather than to update it.
async function propagateWrite(
    calendar: Calendar,
    event: CalendarEvent,
    user: User,
    oldAttendees: Attendee[],
): Promise<void> {
    const series = event.parentEventId ? eventById(calendar, event.parentEventId) : null;
    const attendees = event.data?.attendees ?? series?.data?.attendees;
    if (!attendees?.length) return;
    // Only the organizer fans out: a guest's own edit bumping SEQUENCE would outrun the organizer's updates.
    if (isInvitationFromOthers(series ?? event, calendar.home.user.email)) return;
    if (series && event.status === 'cancelled') {
        await propagateCancellation(calendar.home, event, series);
        return;
    }
    // What the guests already hold: the series' list when the override states none of its own, so an
    // occurrence edit reads as an update of that occurrence and a name missing from it cancels that
    // instance for whoever was dropped.
    const held = oldAttendees.length ? oldAttendees : (series?.data?.attendees ?? []);
    await propagateInvitation(calendar.home, event, user, held, attendees, series ?? undefined);
}

// The locked core every writer of a NEW event shares: the checks that decide WHICH file is written run in it.
export async function writeEvent(
    calendar: Calendar,
    calendarId: string,
    input: CreateEventArgs,
): Promise<CalendarEvent> {
    // A write into a directory nobody owns any more would mkdir it back.
    if (!calendar.calendarRow(calendarId)) throw new ApiError(404, 'Calendar not found');
    validateEventInput(input);
    if (input.parentEventId) return writeOverride(calendar, calendarId, input);

    // Eigen mints every name it writes: a UID is its author's string and may carry `/`, `..` or quotes.
    const uri = `${randomUUID()}.ics`;
    const uid = input.uid || randomUUID();
    if (uidHolder(calendar, calendarId, uid)) throw new ApiError(409, 'An event with this UID already exists');
    const event = eventForFile({ id: randomUUID(), calendarId, uid, input, now: new Date() });
    await store.writeResource(calendar, calendarId, uri, buildResource([event]), null);
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

    const override = eventForFile({
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
): Promise<CalendarEvent> {
    const { updated, oldAttendees } = await calendar.gate.run(() =>
        patchStoredEvent(calendar, calendarId, id, input, user),
    );
    calendar.announce(calendarId, SSEventType.CALENDAR_EVENT_UPDATED);

    if (user) propagateWrite(calendar, updated, user, oldAttendees).catch(console.error);
    return updated;
}

// Caller holds the gate, so the row the patch is computed against is the row the write overwrites.
async function patchStoredEvent(
    calendar: Calendar,
    calendarId: string,
    id: string,
    input: EventPatch,
    user?: User,
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

    // A save form restates WHEN the event is on every edit, so the patch carries only the bounds that
    // really moved — against the row, the one reading that knows the end of an event stating a DURATION
    // or no end at all.
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
    const existing = await calendar.gate.run(() => eraseStoredEvent(calendar, calendarId, id));

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
            propagateDecline(orgUserId, invitation.organizerEventId!, user.email).catch(console.error);
        }
    } else if (!invitation && existing.data?.attendees?.length) {
        // An event with no foreign organizer makes this user its organizer, and an organizer's delete cancels.
        propagateCancellation(calendar.home, existing).catch(console.error);
    }

    calendar.announce(calendarId, SSEventType.CALENDAR_EVENT_DELETED);
}

// Caller holds the gate; the row it answers with is what the decline or cancellation mail is composed from.
async function eraseStoredEvent(calendar: Calendar, calendarId: string, id: string): Promise<CalendarEvent> {
    const existing = eventById(calendar, id);
    // 404 (not 403) on calendar mismatch so a share on one calendar can't oracle event ids in another.
    if (!existing || existing.calendarId !== calendarId) throw new ApiError(404, 'Event not found');
    const resource = resourceOf(calendar, id);
    if (!resource) throw new ApiError(404, 'Event not found');

    if (existing.parentEventId) {
        // A synthetic exclusion row carries no data of its own, so the link is the master's to state.
        const parent = eventById(calendar, existing.parentEventId)!;
        // Deleting one occurrence is a write of its master's file, never a delete of the resource.
        await editResource(calendar, resource, (component) => {
            const key = existing.recurrenceDate ? storedRecurrenceKey(existing.recurrenceDate) : null;
            if (key) removeExclusion(component, key, writeContext(actorIsOrganizer(parent)));
        });
    } else {
        await calendar.purgeResource(resource);
    }
    return existing;
}

// Re-home a resource inside this Home: one rename plus one transaction, so the rows keep their identity.
export async function moveEvent(
    calendar: Calendar,
    calendarId: string,
    id: string,
    targetCalendarId: string,
): Promise<CalendarEvent> {
    const moved = await calendar.gate.run(async () => {
        const existing = eventById(calendar, id);
        if (!existing || existing.calendarId !== calendarId) throw new ApiError(404, 'Event not found');
        if (existing.parentEventId) throw new ApiError(400, 'Cannot move a single recurrence occurrence');
        if (targetCalendarId === calendarId) return false;
        if (!calendar.calendarRow(targetCalendarId)) throw new ApiError(404, 'Calendar not found');
        const resource = resourceOf(calendar, id);
        if (!resource) throw new ApiError(404, 'Event not found');
        // The target holding this UID would throw on its UNIQUE index after the rename.
        if (uidHolder(calendar, targetCalendarId, resource.uid)) {
            throw new ApiError(409, 'The target calendar already holds this event');
        }
        // A name the target already uses becomes a fresh one; a client sees a delete plus a create either
        // way. A file no row of the target holds counts as used too, or the rename would destroy it.
        const taken =
            !!store.resourceRowOf(calendar, targetCalendarId, resource.uri) ||
            (await calendar.storage.exists(resourcePath(targetCalendarId, resource.uri)));
        const targetUri = taken ? `${randomUUID()}.ics` : resource.uri;
        await calendar.storage.moveDurable(
            resourcePath(calendarId, resource.uri),
            resourcePath(targetCalendarId, targetUri),
        );
        try {
            calendar.db.transaction((tx) => {
                const sourceCtag = calendar.bumpCtag(tx, calendarId);
                calendar.tombstone(tx, calendarId, resource.uri, resource.uriKey, sourceCtag);
                const targetCtag = calendar.bumpCtag(tx, targetCalendarId);
                // Moving A→B then B→A must not leave A listing the uri as both a 200 and a 404.
                tx.delete(schema.resourceTombstones)
                    .where(
                        and(
                            eq(schema.resourceTombstones.calendarId, targetCalendarId),
                            eq(schema.resourceTombstones.uriKey, uriKeyOf(targetUri)),
                        ),
                    )
                    .run();
                tx.update(schema.resources)
                    .set({
                        calendarId: targetCalendarId,
                        uri: targetUri,
                        uriKey: uriKeyOf(targetUri),
                        resourceCtag: targetCtag,
                    })
                    .where(eq(schema.resources.id, resource.id))
                    .run();
                tx.update(schema.events)
                    .set({ calendarId: targetCalendarId })
                    .where(eq(schema.events.resourceId, resource.id))
                    .run();
            });
        } catch (e) {
            // A live process rolls its own rename back; if even that fails, both keys settle the pair —
            // source first, because the row dropped there frees the event ids the target file carries.
            try {
                await calendar.storage.moveDurable(
                    resourcePath(targetCalendarId, targetUri),
                    resourcePath(calendarId, resource.uri),
                );
            } catch {
                calendar.gate.markDirty(gateKey(calendarId, resource.uri));
                calendar.gate.markDirty(gateKey(targetCalendarId, targetUri));
            }
            throw e;
        }
        return true;
    });

    if (moved) {
        calendar.announce(calendarId, SSEventType.CALENDAR_EVENT_UPDATED);
        calendar.announce(targetCalendarId, SSEventType.CALENDAR_EVENT_UPDATED);
    }
    return eventById(calendar, id)!;
}
