// The sending side of an invitation. When the organizer of an event invites, changes or cancels, this tells each
// guest: a guest on this server gets the change in their own Home, a REQUEST taking the decision a mailed one takes,
// and an external guest gets an email. A guest added to a repeating event also gets its moved and removed
// occurrences, and an account that appears later is sent what it was invited to. The event writes call it once they
// commit, such as a save or a delete, and a guest's answer to an organizer on this server goes back the same way.

import { heldAttendees } from '@workspace/lib/calendar/calendar-utils';
import type { Attendee, CalendarEvent } from '@workspace/lib/types/calendar';
import { isNull } from 'drizzle-orm';
import { getServerSettings } from '../config/server-settings';
import type { Home } from '../home';
import { sendToHome } from '../home/home-relay';
import type { ParsedEvent } from '../ical/ical-parse';
import type { OutboundICalEvent } from '../mailer/mailer';
import { sendMail } from '../mailer/mailer';
import { addRegistryEntry } from '../share';
import type { User } from '../user';
import { getUserByEmail, isGuest } from '../user';
import type { Calendar } from './calendar';
import type { Organizer } from './imip';
import { composeCancelEmail, composeInviteEmail, composeInviteRequest } from './imip';
import { toEvent } from './mappers';
import * as schema from './schema';
import type { InvitationLink, InvitationRequest } from './types';

// `series` set means `event` is one occurrence, and the messages name the series id plus the occurrence key.
// The series' `exceptions` go to every added guest and every external update, or a guest's copy shows them unmoved.
export async function propagateInvitation(
    organizerHome: Home,
    event: CalendarEvent,
    user: User,
    oldAttendees: Attendee[],
    newAttendees: Attendee[],
    series?: CalendarEvent,
    exceptions: readonly CalendarEvent[] = [],
): Promise<void> {
    const organizerEventId = series?.id ?? event.id;
    const recurrenceDate = series ? event.recurrenceDate : null;
    const oldEmails = new Set(oldAttendees.map((a) => a.email.toLowerCase()));
    const newEmails = new Set(newAttendees.map((a) => a.email.toLowerCase()));

    const selves = new Set([user.email.toLowerCase(), organizerHome.user.email.toLowerCase()]);
    const notSelf = (a: Attendee) => !selves.has(a.email.toLowerCase());
    const added = newAttendees.filter((a) => notSelf(a) && !oldEmails.has(a.email.toLowerCase()));
    const removed = oldAttendees.filter((a) => notSelf(a) && !newEmails.has(a.email.toLowerCase()));
    const existing = newAttendees.filter((a) => notSelf(a) && oldEmails.has(a.email.toLowerCase()));

    const organizer = organizerOf(organizerHome, user);
    const link: InvitationLink = {
        organizerEmail: organizer.email.toLowerCase(),
        organizerEventId,
        organizerUserId: organizer.userId,
        createByUserId: user.id,
    };
    const requested = requestedEvent(event, recurrenceDate, organizer, newAttendees);
    let request: OutboundICalEvent | undefined;

    for (const attendee of added) {
        try {
            const targetUser = await getUserByEmail(attendee.email);
            if (!targetUser || isGuest(targetUser)) {
                await addRegistryEntry(organizerHome.user.id, attendee.email);
                request ??= composeInviteRequest(event, organizer, series, exceptions);
                const mail = composeInviteEmail(event, organizer, [attendee], request);
                sendMail(mail).catch((err) => console.error('Failed to send iMIP invite:', err));
                continue;
            }
            await sendToHome(targetUser.id, {
                type: 'calendar:request',
                ...invitationRequest(organizer, user.id, attendee.email, event, series, exceptions),
            });
            if (getServerSettings().notifications.email.userOnCalendarInvite) {
                // A local recipient has the event from sendToHome, so an iMIP attachment would update it twice.
                const mail = composeInviteEmail(event, organizer, [attendee]);
                sendMail(mail).catch((err) => console.error('Failed to send Eigen invite email:', err));
            }
        } catch (error) {
            console.error('Failed to send invitation:', error);
        }
    }

    for (const attendee of removed) {
        try {
            const targetUser = await getUserByEmail(attendee.email);
            if (!targetUser || isGuest(targetUser)) {
                const mail = composeCancelEmail(event, organizer, [attendee], series);
                sendMail(mail).catch((err) => console.error('Failed to send iMIP cancel:', err));
                continue;
            }
            await sendToHome(targetUser.id, {
                type: 'calendar:invitation-removal',
                orgEventId: organizerEventId,
                orgUserId: organizerHome.user.id,
                occurrence: occurrenceRevision(event, recurrenceDate),
            });
        } catch (error) {
            console.error('Failed to cancel invitation:', error);
        }
    }

    for (const attendee of existing) {
        try {
            const targetUser = await getUserByEmail(attendee.email);
            if (!targetUser || isGuest(targetUser)) {
                request ??= composeInviteRequest(event, organizer, series, exceptions);
                const mail = composeInviteEmail(event, organizer, [attendee], request, true);
                sendMail(mail).catch((err) => console.error('Failed to send iMIP update:', err));
                continue;
            }
            // The guest's copy moves its own overrides along with the series, so an update sends the master alone.
            await sendToHome(targetUser.id, { type: 'calendar:request', events: [requested], link });
        } catch (error) {
            console.error('Failed to update invitation:', error);
        }
    }
}

export async function propagateRsvp(
    organizerUserId: string,
    organizerEventId: string,
    attendeeEmail: string,
    newStatus: Attendee['status'],
    recurrenceDate?: string,
): Promise<void> {
    await sendToHome(organizerUserId, {
        type: 'calendar:rsvp',
        eventId: organizerEventId,
        attendeeEmail,
        status: newStatus,
        recurrenceDate,
    });
}

// `attendees` is who held the event, because a cancelled occurrence is an EXDATE with no guest list of its own.
export async function propagateCancellation(
    organizerHome: Home,
    user: User | undefined,
    event: CalendarEvent,
    attendees: readonly Attendee[],
    series?: CalendarEvent,
): Promise<void> {
    const occurrence = occurrenceRevision(event, series ? event.recurrenceDate : null);
    const organizer = organizerOf(organizerHome, user);
    for (const attendee of attendees) {
        try {
            const targetUser = await getUserByEmail(attendee.email);
            if (!targetUser || isGuest(targetUser)) {
                if (!organizer.email) {
                    console.warn(`Skipped the iMIP cancel to ${attendee.email}: the organizer has no address`);
                    continue;
                }
                const mail = composeCancelEmail(event, organizer, [attendee], series);
                sendMail(mail).catch((err) => console.error('Failed to send iMIP cancel:', err));
                continue;
            }
            await sendToHome(targetUser.id, {
                type: 'calendar:invitation-removal',
                orgEventId: series?.id ?? event.id,
                orgUserId: organizerHome.user.id,
                occurrence,
            });
        } catch (error) {
            console.error('Failed to propagate cancellation:', error);
        }
    }
}

// What a newcomer to the server is owed when their account appears: each series that lists them, and each occurrence
// that lists them while its series doesn't. A copy of somebody else's invitation is not this Home's to send.
export function pendingInvitations(calendar: Calendar, email: string): InvitationRequest[] {
    const address = email.toLowerCase();
    const lists = (event: CalendarEvent | undefined) =>
        !!event?.data?.attendees?.some((a) => a.email.toLowerCase() === address);
    const own = calendar.joinedEvents().where(isNull(schema.events.organizerEventId)).all().map(toEvent);
    const byId = new Map(own.map((event) => [event.id, event]));
    const exceptionsOf = Map.groupBy(own, (event) => event.parentEventId);
    const organizer = organizerOf(calendar.home, undefined);
    return own.flatMap((event) => {
        const series = event.parentEventId ? byId.get(event.parentEventId) : undefined;
        if (!lists(event) || lists(series)) return [];
        const exceptions = series ? [] : (exceptionsOf.get(event.id) ?? []);
        return [invitationRequest(organizer, calendar.home.user.id, email, event, series, exceptions)];
    });
}

// The REQUEST one guest on this server gets. A series carries its master and every exception, and an occurrence the
// guest isn't on travels as cancelled. One occurrence names its series' id and key, so the guest's series takes it.
function invitationRequest(
    organizer: Organizer,
    createByUserId: string,
    email: string,
    event: CalendarEvent,
    series: CalendarEvent | undefined,
    exceptions: readonly CalendarEvent[],
): InvitationRequest {
    const link = {
        organizerEmail: organizer.email.toLowerCase(),
        organizerEventId: series?.id ?? event.id,
        organizerUserId: organizer.userId,
        createByUserId,
    };
    if (series) {
        return { link, events: [requestedEvent(event, event.recurrenceDate, organizer, heldAttendees(event, series))] };
    }
    const address = email.toLowerCase();
    const isOn = (e: CalendarEvent) => heldAttendees(e, event).some((a) => a.email.toLowerCase() === address);
    const requested = exceptions.map((e) => {
        const sent = isOn(e) ? e : { ...e, status: 'cancelled' as const };
        return requestedEvent(sent, e.recurrenceDate, organizer, heldAttendees(e, event));
    });
    return { link, events: [requestedEvent(event, null, organizer, heldAttendees(event, null)), ...requested] };
}

// The REQUEST a guest on this server files, through the same decision as a mailed one. It names no Eigen stamp and no
// reminder, and lists the guests alone, as the organizer's own list has them.
function requestedEvent(
    event: CalendarEvent,
    recurrenceDate: string | null,
    organizer: Organizer,
    attendees: readonly Attendee[],
): ParsedEvent {
    return {
        uid: event.uid,
        title: event.title,
        description: event.description,
        location: event.location,
        startTime: event.startTime,
        endTime: event.endTime,
        allDay: event.allDay,
        rrule: event.rrule,
        timezone: event.timezone,
        status: event.status,
        sequence: event.sequence,
        // The organizer's own revision, so the guest can order this message against the next: the fan-out is unordered.
        dtstamp: event.updatedAt,
        recurrenceDate,
        // A relayed key is already a date in the series' own zone, so there is no UTC instant to re-key from.
        recurrenceInstant: null,
        data: { organizer, attendees: [...attendees] },
    };
}

// Set only for a copy that is one occurrence of a series the guest does not hold. An exception answers through the
// master it hangs on.
export function answeredOccurrence(event: CalendarEvent): string | undefined {
    return event.parentEventId ? undefined : (event.recurrenceDate ?? undefined);
}

// A guest answers the ORGANIZER, and only the calendar's own Home holds the event, so its user is named whoever saved.
// A team has no address, so a team event names the member who saved it.
function organizerOf(organizerHome: Home, user: User | undefined): Organizer {
    const named = organizerHome.user.email ? organizerHome.user : user;
    return { userId: organizerHome.user.id, email: named?.email ?? '', name: named?.name };
}

// The revision its receiver orders the removal against; undefined for a message about the whole series.
function occurrenceRevision(
    event: CalendarEvent,
    recurrenceDate: string | null,
): { recurrenceDate: string; sequence: number; dtstamp: Date } | undefined {
    return recurrenceDate ? { recurrenceDate, sequence: event.sequence, dtstamp: event.updatedAt } : undefined;
}
