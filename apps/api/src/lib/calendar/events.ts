// Creating, editing and deleting events for a Calendar. An edit changes the stored iCalendar file and then tells the
// other side: guests hear about an invitation or a cancellation, and the organizer hears about an answer. Calendar
// hands its event changes to it, so the routes and the invitation code share one path.

import { heldAttendees, isInvitationFromOthers } from '@workspace/lib/calendar/calendar-utils';
import type { CalendarEvent, EventData } from '@workspace/lib/types/calendar';
import { isExternalOwnerId } from '@workspace/lib/types/owner';
import { SSEventType } from '@workspace/lib/types/sse';
import { and, eq } from 'drizzle-orm';
import type ICAL from 'ical.js';
import { ApiError } from '../core';
import {
    applyEdits,
    buildResource,
    parseResource,
    patchEvent,
    raisedSequence,
    revisionAfter,
    serializeEventForImip,
    storedRecurrenceIds,
    storedRevisions,
} from '../ical';
import type { EventPatch, EventToBuild, Revision, VEventEdit, WriteContext } from '../ical/ical-component';
import { parseRecurrenceKey } from '../ical/wall-clock';
import { sendMail } from '../mailer/mailer';
import type { User } from '../user';
import type { Calendar } from './calendar';
import * as davStore from './dav-store';
import { eventForResource, validateEventInput } from './event-input';
import { composeRsvpReply } from './imip';
import { answeredOccurrence, propagateCancellation, propagateInvitation, propagateRsvp } from './invite-propagation';
import { toEvent } from './mappers';
import { prepareResource, resourceBytes } from './resource-store';
import * as schema from './schema';
import type { CreateEventArgs } from './types';

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

export async function createEvent(
    calendar: Calendar,
    calendarId: string,
    input: CreateEventArgs,
    user?: User,
): Promise<CalendarEvent> {
    const recurrenceDate = input.recurrenceDate ? parseRecurrenceKey(input.recurrenceDate) : null;
    if (input.recurrenceDate && !recurrenceDate) throw new ApiError(400, 'Invalid occurrence date');
    const args = { ...input, recurrenceDate };

    // The checks that decide which resource is written run inside the lock.
    const { created, replaced } = await calendar.writeLock.run(async () => {
        // A resource under a calendar nobody owns any more would dangle on its foreign key.
        if (!calendar.calendarRow(calendarId)) throw new ApiError(404, 'Calendar not found');
        validateEventInput(args);
        if (args.parentEventId) {
            // Who held the occurrence this write replaces: a cancelled override keeps no guest list of its own.
            const replaced = exceptionOf(calendar, args.parentEventId, recurrenceDate);
            return { created: await writeOverride(calendar, calendarId, args.parentEventId, args), replaced };
        }
        // Eigen mints every name it writes: a UID is its author's string and may carry `/`, `..` or quotes.
        const uri = `${crypto.randomUUID()}.ics`;
        const uid = args.uid || crypto.randomUUID();
        if (uidHolder(calendar, calendarId, uid)) throw new ApiError(409, 'An event with this UID already exists');
        const event = eventForResource({ id: crypto.randomUUID(), calendarId, uid, input: args, now: new Date() });
        const prepared = prepareResource(calendarId, buildResource([event]), null);
        await calendar.writeResource({ calendarId, uri, prepared, creditBytes: 0 });
        return { created: requireEvent(calendar, event.id), replaced: null };
    });

    calendar.announce(SSEventType.CALENDAR_EVENT_CREATED, calendarId);
    if (user) propagateWrite(calendar, created, user, replaced).catch(console.error);
    return created;
}

export async function updateEvent(
    calendar: Calendar,
    calendarId: string,
    id: string,
    input: EventPatch,
    user?: User,
    expectedEtag?: string,
): Promise<CalendarEvent> {
    const { updated, existing } = await calendar.writeLock.run(() =>
        patchStoredEvent(calendar, calendarId, id, input, user, expectedEtag),
    );
    // Judged on the bytes by their hash, as a PUT is: a save that moved nothing tells nobody.
    if (updated.etag === existing.etag) return updated;

    calendar.announce(SSEventType.CALENDAR_EVENT_UPDATED, calendarId);
    if (user) propagateWrite(calendar, updated, user, existing).catch(console.error);
    return updated;
}

export async function deleteEvent(
    calendar: Calendar,
    calendarId: string,
    id: string,
    user?: User,
    expectedEtag?: string,
): Promise<void> {
    const existing = await calendar.writeLock.run(() => eraseStoredEvent(calendar, calendarId, id, expectedEtag));
    if (!existing) return;

    // An override without its own list has its series' guests. A cancelled master answers and cancels nothing: its PUT
    // already fanned out STATUS:CANCELLED.
    const series = existing.parentEventId ? eventById(calendar, existing.parentEventId) : null;
    const invitation = isInvitationFromOthers(series ?? existing, calendar.home.user.email) ? existing.data : null;
    const held = existing.status === 'cancelled' ? [] : heldAttendees(existing, series);
    const declining = user && held.some((a) => a.email.toLowerCase() === user.email.toLowerCase());
    if (declining && invitation?.organizer) {
        const orgUserId = invitation.organizer.userId;
        if (!orgUserId || isExternalOwnerId(orgUserId)) {
            const mail = composeRsvpReply(existing, user.email, user.name ?? user.email, 'declined');
            sendMail(mail).catch(console.error);
        } else if (invitation.organizerEventId) {
            propagateRsvp(
                orgUserId,
                invitation.organizerEventId,
                user.email,
                'declined',
                answeredOccurrence(existing),
            ).catch(console.error);
        }
    } else if (!invitation && held.length) {
        // An event with no foreign organizer makes this user its organizer, and an organizer's delete cancels.
        propagateCancellation(calendar.home, user, existing, held, series ?? undefined).catch(console.error);
    }

    calendar.announce(SSEventType.CALENDAR_EVENT_DELETED, calendarId);
}

// Re-home a resource inside this Home: one transaction, so the rows keep their identity and no window shows
// the event in both calendars.
export async function moveEvent(
    calendar: Calendar,
    calendarId: string,
    id: string,
    targetCalendarId: string,
    expectedEtag?: string,
): Promise<CalendarEvent> {
    const moved = await calendar.writeLock.run(async () => {
        const existing = eventById(calendar, id);
        if (!existing || existing.calendarId !== calendarId) throw new ApiError(404, 'Event not found');
        if (existing.parentEventId) throw new ApiError(400, 'Cannot move a single recurrence occurrence');
        if (targetCalendarId === calendarId) return false;
        if (!calendar.calendarRow(targetCalendarId)) throw new ApiError(404, 'Calendar not found');
        const resource = resourceOf(calendar, id);
        if (!resource) throw new ApiError(404, 'Event not found');
        assertEtag(resource, expectedEtag);
        // The target holding this UID would throw on its UNIQUE index.
        if (uidHolder(calendar, targetCalendarId, resource.uid)) {
            throw new ApiError(409, 'The target calendar already holds this event');
        }
        // A name the target already holds becomes a fresh one, or the move would collide on (calendarId, uri).
        const taken = !!davStore.getResourceMeta(calendar, targetCalendarId, resource.uri);
        const targetUri = taken ? `${crypto.randomUUID()}.ics` : resource.uri;

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
    return requireEvent(calendar, id);
}

// Caller holds the write lock and has already resolved the resource this patch means. Answers whether it wrote.
export async function patchResource(
    calendar: Calendar,
    resource: StoredResource,
    recurrenceKey: string | null,
    patch: EventPatch,
    context: WriteContext,
): Promise<boolean> {
    const component = storedComponent(calendar, resource);
    const changed = patchEvent(component, recurrenceKey, patch, context);
    if (changed) await writeComponent(calendar, resource, component);
    return changed;
}

// Caller holds the write lock; the row it answers with is what the decline or cancellation mail is composed from, its
// occurrence named as the bytes it erases named it.
export async function eraseStoredEvent(
    calendar: Calendar,
    calendarId: string,
    id: string,
    expectedEtag?: string,
): Promise<EventToBuild | null> {
    const existing = eventById(calendar, id);
    // A cancelled date is gone already, so deleting its row again changes nothing, as a second delete does.
    if (!existing || (existing.parentEventId && existing.status === 'cancelled')) return null;
    if (existing.calendarId !== calendarId) throw new ApiError(404, 'Event not found');
    const resource = resourceOf(calendar, id);
    if (!resource) throw new ApiError(404, 'Event not found');
    assertEtag(resource, expectedEtag);

    const series = existing.parentEventId ? requireEvent(calendar, existing.parentEventId) : existing;
    const ctx = writeContext(!isInvitationFromOthers(series, calendar.home.user.email));
    const component = storedComponent(calendar, resource);
    if (!existing.recurrenceDate) {
        // The purge leaves no file to hold the revision, so the series' CANCEL or the guest's REPLY takes it here.
        const { sequence } = revisionAfter(ctx, raisedSequence(storedRevisions(component)), existing);
        await calendar.purgeResource(resource);
        return { ...existing, sequence, updatedAt: ctx.now };
    }
    // A copy of single dates has no master: it loses one date at a time, and goes whole with its last.
    const recurrenceId = storedRecurrenceIds(component).get(existing.recurrenceDate);
    applyEdits(component, new Map([[existing.recurrenceDate, { kind: 'exclusion', id: existing.id, ctx }]]));
    if (component.getFirstSubcomponent('vevent')) await writeComponent(calendar, resource, component);
    else await calendar.purgeResource(resource);
    if (!existing.parentEventId) return { ...existing, recurrenceId };
    // The CANCEL names the revision the exclusion was stamped with.
    const { sequence, updatedAt } = requireEvent(calendar, id);
    return { ...existing, recurrenceId, sequence, updatedAt };
}

// The stored component of a resource: the bytes are the truth, so every path that parses them reads them itself.
export function storedComponent(calendar: Calendar, resource: Pick<StoredResource, 'id'>): ICAL.Component {
    const row = calendar.db
        .select({ ics: schema.resources.ics })
        .from(schema.resources)
        .where(eq(schema.resources.id, resource.id))
        .get();
    if (!row) throw new ApiError(404, 'Event not found');
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

// Caller holds the write lock: re-serializes the resource the caller resolved, through the facade's one write.
export function writeComponent(calendar: Calendar, resource: StoredResource, component: ICAL.Component): Promise<void> {
    return calendar.writeResource({
        calendarId: resource.calendarId,
        uri: resource.uri,
        prepared: prepareResource(resource.calendarId, component, resource.id),
        creditBytes: resource.size,
    });
}

// Caller holds the write lock: the bytes it mutates are the bytes the commit overwrites.
export async function editResource(
    calendar: Calendar,
    resource: StoredResource,
    mutate: (component: ICAL.Component) => void,
): Promise<void> {
    const component = storedComponent(calendar, resource);
    mutate(component);
    await writeComponent(calendar, resource, component);
}

// An exception is one VEVENT inside its master's file; a cancellation rides as an EXDATE plus its stamp.
export function exceptionEdit(parent: CalendarEvent, input: CreateEventArgs, ctx: WriteContext): VEventEdit {
    const id = crypto.randomUUID();
    if (input.status === 'cancelled') return { kind: 'exclusion', id, ctx };
    const event = eventForResource({
        id,
        calendarId: parent.calendarId,
        uid: parent.uid,
        input: { ...input, rrule: null },
        now: ctx.now,
    });
    return { kind: 'override', event, ctx };
}

// `revision` is what a message states for the item an edit names; a local write states none.
export function writeContext(actorIsOrganizer: boolean, revision?: Revision): WriteContext {
    return { now: new Date(), actorIsOrganizer, sequence: revision?.sequence, dtstamp: revision?.dtstamp };
}

export function exceptionOf(
    calendar: Calendar,
    parentEventId: string,
    recurrenceDate: string | null,
): CalendarEvent | null {
    if (!recurrenceDate) return null;
    const row = calendar
        .joinedEvents()
        .where(and(eq(schema.events.parentEventId, parentEventId), eq(schema.events.recurrenceDate, recurrenceDate)))
        .get();
    return row ? toEvent(row) : null;
}

// Every exception a master holds, overrides and cancellations alike, in the order the file lists them.
export function exceptionsOf(calendar: Calendar, parentEventId: string): CalendarEvent[] {
    return calendar.joinedEvents().where(eq(schema.events.parentEventId, parentEventId)).all().map(toEvent);
}

// An override is one occurrence of its series, so every message about it names the series' id.
async function propagateWrite(
    calendar: Calendar,
    event: CalendarEvent,
    user: User,
    previous: CalendarEvent | null,
): Promise<void> {
    const series = event.parentEventId ? eventById(calendar, event.parentEventId) : null;
    // A name missing from the list the guests held cancels that instance.
    const held = heldAttendees(previous, series);
    const attendees = heldAttendees(event, series);
    // A write that names nobody and replaced nobody owes the guests nothing; emptying a non-override's list cancels.
    if (!attendees.length && !held.length) return;
    if (isInvitationFromOthers(series ?? event, calendar.home.user.email)) return;
    if (previous && guestView(previous, series) === guestView(event, series)) return;
    if (series && event.status === 'cancelled') {
        await propagateCancellation(calendar.home, user, event, held, series);
        return;
    }
    // An occurrence write is itself one exception and carries none.
    const exceptions = series ? [] : exceptionsOf(calendar, event.id);
    await propagateInvitation(calendar.home, event, user, held, attendees, series ?? undefined, exceptions);
}

// The file a guest would get, minus the revision that changes with every write. An instant reads the same in any zone,
// unless a rule repeats in that zone's wall clock.
function guestView(event: CalendarEvent, series: CalendarEvent | null): string {
    const never = new Date(0);
    const timezone = event.rrule ? event.timezone : null;
    const view = { ...event, timezone, sequence: 0, createdAt: never, updatedAt: never };
    return serializeEventForImip(view, 'REQUEST', series ?? undefined);
}

// Caller holds the write lock, so the row the patch is computed against is the row the write overwrites.
async function patchStoredEvent(
    calendar: Calendar,
    calendarId: string,
    id: string,
    input: EventPatch,
    user?: User,
    expectedEtag?: string,
): Promise<{ updated: CalendarEvent; existing: CalendarEvent }> {
    const existing = eventById(calendar, id);
    // 404 (not 403) on calendar mismatch so a share on one calendar can't oracle event ids in another.
    if (!existing || existing.calendarId !== calendarId) throw new ApiError(404, 'Event not found');

    const series = existing.parentEventId ? requireEvent(calendar, existing.parentEventId) : existing;
    const organizer = !isInvitationFromOthers(series, calendar.home.user.email);
    if (!organizer) {
        const localData: EventData = { ...existing.data };
        if (input.data) {
            localData.reminders = input.data.reminders ?? localData.reminders;
            localData.color = input.data.color ?? localData.color;
        }
        input = { data: localData };
    }

    // The stored rule passed these checks when it was projected, so it is checked again only beside a moved start.
    const rrule = input.rrule || input.startTime ? (input.rrule ?? existing.rrule) : null;
    validateEventInput({
        rrule,
        startTime: input.startTime ?? existing.startTime,
        endTime: input.endTime ?? existing.endTime,
    });

    const resource = resourceOf(calendar, id);
    if (!resource) throw new ApiError(404, 'Event not found');
    assertEtag(resource, expectedEtag);

    if (existing.parentEventId && input.status === 'cancelled') {
        const exclusion: VEventEdit = { kind: 'exclusion', id: existing.id, ctx: writeContext(organizer) };
        await editResource(calendar, resource, (component) => {
            applyEdits(component, new Map([[existing.recurrenceDate, exclusion]]));
        });
        // The EXDATE row sits at the original slot; the guests last saw the occurrence at its moved one.
        const cancelled = requireEvent(calendar, id);
        return { updated: { ...cancelled, startTime: existing.startTime, endTime: existing.endTime }, existing };
    }

    const startMoved = input.startTime !== undefined && input.startTime.getTime() !== existing.startTime.getTime();
    const endMoved = input.endTime !== undefined && input.endTime.getTime() !== existing.endTime.getTime();
    const allDayMoved = input.allDay !== undefined && input.allDay !== existing.allDay;

    await patchResource(
        calendar,
        resource,
        existing.recurrenceDate,
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
        writeContext(!!user && organizer),
    );

    return { updated: requireEvent(calendar, id), existing };
}

async function writeOverride(
    calendar: Calendar,
    calendarId: string,
    parentEventId: string,
    input: CreateEventArgs,
): Promise<CalendarEvent> {
    const parent = eventById(calendar, parentEventId);
    if (!parent || parent.calendarId !== calendarId || parent.parentEventId) {
        throw new ApiError(404, 'Event not found');
    }
    const resource = resourceOf(calendar, parent.id);
    if (!resource) throw new ApiError(404, 'Event not found');
    assertEtag(resource, input.etag);
    // A RECURRENCE-ID and an EXDATE are both written from this key.
    const key = input.recurrenceDate;
    if (!key) throw new ApiError(400, 'Invalid occurrence date');

    const organizer = !isInvitationFromOthers(parent, calendar.home.user.email);
    const edit = exceptionEdit(parent, input, writeContext(organizer));
    await editResource(calendar, resource, (component) => applyEdits(component, new Map([[key, edit]])));
    const stored = exceptionOf(calendar, parent.id, key);
    return stored ?? requireEvent(calendar, parent.id);
}

// An event a write under the lock just stored or read through its series, so only a delete since then misses it.
function requireEvent(calendar: Calendar, id: string): CalendarEvent {
    const event = eventById(calendar, id);
    if (!event) throw new ApiError(404, 'Event not found');
    return event;
}

// Caller holds the write lock, so the etag judged is the one the write replaces. A series and its overrides share one
// resource and so one etag. A caller that loaded none, such as a script, writes unconditionally.
function assertEtag(resource: StoredResource, expectedEtag: string | undefined): void {
    if (expectedEtag !== undefined && expectedEtag !== resource.etag) {
        throw new ApiError(412, 'Event was changed elsewhere');
    }
}

function uidHolder(calendar: Calendar, calendarId: string, uid: string): { uri: string } | undefined {
    return calendar.db
        .select({ uri: schema.resources.uri })
        .from(schema.resources)
        .where(and(eq(schema.resources.calendarId, calendarId), eq(schema.resources.uid, uid)))
        .get();
}
