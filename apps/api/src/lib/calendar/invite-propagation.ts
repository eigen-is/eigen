// The sending side of an invitation. When the organizer of an event invites, changes or cancels, this tells each
// guest: a guest on this server gets the change in their own Home, a REQUEST taking the decision a mailed one takes,
// and an external guest gets an email. Every message about a repeating event carries its moved and removed
// occurrences, and an account that appears later is sent what it was invited to. The event writes call it once they
// commit, such as a save or a delete, and a guest's answer to an organizer on this server goes back the same way.

import { isInvitationFromOthers } from '@workspace/lib/calendar/calendar-utils';
import type { Attendee, CalendarEvent, Organizer } from '@workspace/lib/types/calendar';
import { getServerSettings } from '../config/server-settings';
import type { Home } from '../home';
import { sendToHome } from '../home/home-relay';
import type { ParsedEvent, RecurrenceId } from '../ical/ical-parse';
import { computeOccurrenceTimes } from '../ical/wall-clock';
import type { OutboundICalEvent } from '../mailer/mailer';
import { sendMail } from '../mailer/mailer';
import { addRegistryEntry } from '../share';
import type { User } from '../user';
import { getUserByEmail, isGuest } from '../user';
import type { Calendar } from './calendar';
import { composeCancelEmail, composeInviteEmail, composeInviteRequest } from './imip';
import { toEvent } from './mappers';
import type { InvitationRequest } from './types';

// `series` set means `event` is one occurrence, and the messages name the series id plus its key. Every message about
// a series carries its `exceptions`, so a guest's copy never shows a moved or deleted date at its old slot.
export async function propagateInvitation(
    organizerHome: Home,
    organizer: HomeOrganizer,
    event: CalendarEvent,
    user: User,
    oldAttendees: readonly Attendee[],
    newAttendees: readonly Attendee[],
    series?: CalendarEvent,
    exceptions: readonly CalendarEvent[] = [],
): Promise<void> {
    const oldEmails = new Set(oldAttendees.map((a) => a.email.toLowerCase()));
    const newEmails = new Set(newAttendees.map((a) => a.email.toLowerCase()));
    const selves = new Set([user.email.toLowerCase(), organizerHome.user.email.toLowerCase()]);
    const notSelf = (a: Attendee) => !selves.has(a.email.toLowerCase());
    let request: OutboundICalEvent | undefined;

    for (const attendee of newAttendees.filter(notSelf)) {
        const updated = oldEmails.has(attendee.email.toLowerCase());
        try {
            const targetUser = await getUserByEmail(attendee.email);
            if (!targetUser || isGuest(targetUser)) {
                if (!updated) await addRegistryEntry(organizerHome.user.id, attendee.email);
                request ??= composeInviteRequest(event, organizer, series, exceptions);
                const mail = composeInviteEmail(event, organizer, [attendee], request, updated);
                sendMail(mail).catch((err) => console.error('Failed to send iMIP invite:', err));
                continue;
            }
            await sendToHome(targetUser.id, {
                type: 'calendar:request',
                ...invitationRequest(organizer, user.id, attendee.email, event, series, exceptions),
            });
            if (!updated && getServerSettings().notifications.email.userOnCalendarInvite) {
                // A local recipient has the event from sendToHome, so an iMIP attachment would update it twice.
                const mail = composeInviteEmail(event, organizer, [attendee]);
                sendMail(mail).catch((err) => console.error('Failed to send Eigen invite email:', err));
            }
        } catch (error) {
            console.error('Failed to send invitation:', error);
        }
    }

    for (const attendee of oldAttendees.filter((a) => notSelf(a) && !newEmails.has(a.email.toLowerCase()))) {
        try {
            const targetUser = await getUserByEmail(attendee.email);
            if (!targetUser || isGuest(targetUser)) {
                const mail = composeCancelEmail(event, organizer, [attendee], series);
                sendMail(mail).catch((err) => console.error('Failed to send iMIP cancel:', err));
                continue;
            }
            await sendToHome(targetUser.id, {
                type: 'calendar:invitation-removal',
                orgEventId: series?.id ?? event.id,
                orgUserId: organizerHome.user.id,
                occurrence: occurrenceRevision(event, series),
            });
        } catch (error) {
            console.error('Failed to cancel invitation:', error);
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
    organizer: Organizer,
    cancelled: CalendarEvent,
    attendees: readonly Attendee[],
    series?: CalendarEvent,
): Promise<void> {
    const occurrence = occurrenceRevision(cancelled, series);
    for (const attendee of attendees) {
        try {
            const targetUser = await getUserByEmail(attendee.email);
            if (!targetUser || isGuest(targetUser)) {
                if (!organizer.email) {
                    console.warn(`Skipped the iMIP cancel to ${attendee.email}: the organizer has no address`);
                    continue;
                }
                const mail = composeCancelEmail(cancelled, organizer, [attendee], series);
                sendMail(mail).catch((err) => console.error('Failed to send iMIP cancel:', err));
                continue;
            }
            await sendToHome(targetUser.id, {
                type: 'calendar:invitation-removal',
                orgEventId: series?.id ?? cancelled.id,
                orgUserId: organizerHome.user.id,
                occurrence,
            });
        } catch (error) {
            console.error('Failed to propagate cancellation:', error);
        }
    }
}

// What a newcomer is owed when their account appears: each live series that lists them, and each live occurrence
// that lists them while its series doesn't. An event somebody else organizes is not this Home's to send, linked or not.
export function pendingInvitations(calendar: Calendar, email: string): InvitationRequest[] {
    const address = email.toLowerCase();
    const lists = (event: CalendarEvent | undefined) =>
        !!event?.data?.attendees?.some((a) => a.email.toLowerCase() === address);
    const all = calendar.joinedEvents().all().map(toEvent);
    const byId = new Map(all.map((event) => [event.id, event]));
    const exceptionsOf = Map.groupBy(all, (event) => event.parentEventId);
    return all.flatMap((event) => {
        const series = event.parentEventId ? byId.get(event.parentEventId) : undefined;
        if (!lists(event) || lists(series)) return [];
        if (event.status === 'cancelled' || series?.status === 'cancelled') return [];
        if (isInvitationFromOthers(series ?? event, calendar.home.user.email)) return [];
        const exceptions = series ? [] : (exceptionsOf.get(event.id) ?? []);
        const organizer = organizerOf(calendar.home, undefined, event.data?.organizer);
        return [invitationRequest(organizer, calendar.home.user.id, email, event, series, exceptions)];
    });
}

// Set only for a copy that is one occurrence of a series the guest does not hold. An exception answers through the
// master it hangs on.
export function answeredOccurrence(event: CalendarEvent): string | undefined {
    return event.parentEventId ? undefined : (event.recurrenceDate ?? undefined);
}

// The organizer as the Home that holds the event names it: its own id, whatever the file stores.
type HomeOrganizer = Organizer & { userId: string };

// A guest answers the ORGANIZER, and only the calendar's own Home holds the event, so every message names the one its
// file stores. A file that stores none is organized by the Home's user, or on a team, which has no address, by `user`.
export function organizerOf(organizerHome: Home, user: User | undefined, stored?: Organizer): HomeOrganizer {
    const named = stored ?? (organizerHome.user.email ? organizerHome.user : user);
    return { userId: organizerHome.user.id, email: named?.email ?? '', name: named?.name };
}

// The REQUEST one guest on this server gets. A series carries its master and every exception, and an occurrence the
// guest isn't on travels as cancelled. One occurrence names its series' id and key, so the guest's series takes it.
function invitationRequest(
    organizer: HomeOrganizer,
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
        // A guest without the series can name the occurrence only as the series does: its original slot, in its zone.
        const key = event.recurrenceDate;
        const recurrenceId =
            key && !series.allDay
                ? { instant: computeOccurrenceTimes(series, key).startTime, timezone: series.timezone }
                : null;
        return { link, events: [requestedEvent(event, key, organizer, recurrenceId)] };
    }
    const address = email.toLowerCase();
    const isOn = (e: CalendarEvent) => !!e.data?.attendees?.some((a) => a.email.toLowerCase() === address);
    const requested = exceptions.map((e) =>
        requestedEvent(isOn(e) ? e : { ...e, status: 'cancelled' }, e.recurrenceDate, organizer),
    );
    return { link, events: [requestedEvent(event, null, organizer), ...requested] };
}

// The REQUEST a guest on this server files, through the same decision as a mailed one. It names no Eigen stamp and no
// reminder, and lists the guests alone, as the organizer's own list has them.
function requestedEvent(
    event: CalendarEvent,
    recurrenceDate: string | null,
    organizer: Organizer,
    recurrenceId: RecurrenceId | null = null,
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
        recurrenceId,
        data: { organizer, attendees: event.data?.attendees },
    };
}

// The revision its receiver orders the removal against; undefined for a message about the whole series.
function occurrenceRevision(
    event: CalendarEvent,
    series: CalendarEvent | undefined,
): { recurrenceDate: string; sequence: number; dtstamp: Date } | undefined {
    const recurrenceDate = series && event.recurrenceDate;
    return recurrenceDate ? { recurrenceDate, sequence: event.sequence, dtstamp: event.updatedAt } : undefined;
}
