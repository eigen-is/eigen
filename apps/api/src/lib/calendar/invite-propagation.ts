// The sending side of an invitation. When the organizer of an event invites, changes or cancels, this tells each
// guest: a guest on this server gets the change in their own Home, and an external guest gets an email. A repeating
// event also sends its changed or removed occurrences. A guest's answer to an organizer on this server goes back
// the same way. The event writes call it once they commit, such as a save, a delete or an RSVP.

import { heldAttendees } from '@workspace/lib/calendar/calendar-utils';
import type { Attendee, CalendarEvent } from '@workspace/lib/types/calendar';
import { SSEventType } from '@workspace/lib/types/sse';
import { getServerSettings } from '../config/server-settings';
import type { Home } from '../home';
import { sendToHome } from '../home/home-relay';
import type { OutboundICalEvent } from '../mailer/mailer';
import { sendMail } from '../mailer/mailer';
import { addRegistryEntry } from '../share';
import type { User } from '../user';
import { getUserByEmail, isGuest } from '../user';
import { composeCancelEmail, composeInviteEmail, composeInviteRequest } from './imip';
import { buildCalendarEvent } from './sse-events';

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

    const organizer = { userId: user.id, email: user.email, name: user.name };
    const eventFields = {
        recurrenceDate,
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
        // The organizer's own revision, so the attendee can order this message against the next: the fan-out is unordered.
        dtstamp: event.updatedAt,
    };
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
                type: 'calendar:invitation',
                payload: {
                    ...eventFields,
                    uid: event.uid,
                    data: {
                        organizer: { userId: organizerHome.user.id, email: user.email, name: user.name },
                        organizerEventId,
                        attendees: newAttendees,
                    },
                    createByUserId: user.id,
                    organizerEventId,
                    organizerUserId: organizerHome.user.id,
                },
            });
            await sendSeriesExceptions(targetUser.id, organizerHome, organizerEventId, exceptions, event);
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
            await sendToHome(targetUser.id, {
                type: 'calendar:invitation-update',
                orgEventId: organizerEventId,
                orgUserId: organizerHome.user.id,
                payload: { ...eventFields, attendees: newAttendees },
            });
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
    await sendToHome(organizerUserId, {
        type: 'broadcast',
        event: buildCalendarEvent(SSEventType.CALENDAR_INVITE_RSVP, organizerUserId),
    });
}

// `attendees` is who held the event, because a cancelled occurrence is an EXDATE with no guest list of its own.
export async function propagateCancellation(
    organizerHome: Home,
    event: CalendarEvent,
    attendees: readonly Attendee[],
    series?: CalendarEvent,
): Promise<void> {
    const occurrence = occurrenceRevision(event, series ? event.recurrenceDate : null);
    for (const attendee of attendees) {
        try {
            const targetUser = await getUserByEmail(attendee.email);
            if (!targetUser || isGuest(targetUser)) {
                if (!organizerHome.user.email) {
                    console.warn(`Skipped the iMIP cancel to ${attendee.email}: the organizer has no address`);
                    continue;
                }
                const organizer = {
                    userId: organizerHome.user.id,
                    email: organizerHome.user.email,
                    name: organizerHome.user.name,
                };
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

// Set only for a copy that is one occurrence of a series the guest does not hold. An exception answers through the
// master it hangs on.
export function answeredOccurrence(event: CalendarEvent): string | undefined {
    return event.parentEventId ? undefined : (event.recurrenceDate ?? undefined);
}

// Runs right after the invitation that files the series. Each exception is its own message, so the guest's ordering
// guard judges it against its own occurrence, of which their fresh copy holds no revision.
async function sendSeriesExceptions(
    targetUserId: string,
    organizerHome: Home,
    organizerEventId: string,
    exceptions: readonly CalendarEvent[],
    series: CalendarEvent,
): Promise<void> {
    for (const exception of exceptions) {
        if (!exception.recurrenceDate) continue;
        const occurrence = occurrenceRevision(exception, exception.recurrenceDate);
        if (exception.status === 'cancelled') {
            await sendToHome(targetUserId, {
                type: 'calendar:invitation-removal',
                orgEventId: organizerEventId,
                orgUserId: organizerHome.user.id,
                occurrence,
            });
            continue;
        }
        await sendToHome(targetUserId, {
            type: 'calendar:invitation-update',
            orgEventId: organizerEventId,
            orgUserId: organizerHome.user.id,
            payload: {
                recurrenceDate: exception.recurrenceDate,
                title: exception.title,
                description: exception.description,
                location: exception.location,
                startTime: exception.startTime,
                endTime: exception.endTime,
                allDay: exception.allDay,
                rrule: null,
                timezone: exception.timezone,
                status: exception.status,
                sequence: exception.sequence,
                dtstamp: exception.updatedAt,
                // The organizer's list for that occurrence, so an answer the guest already gave to it stands.
                attendees: heldAttendees(exception, series),
            },
        });
    }
}

// The revision its receiver orders the removal against; undefined for a message about the whole series.
function occurrenceRevision(
    event: CalendarEvent,
    recurrenceDate: string | null,
): { recurrenceDate: string; sequence: number; dtstamp: Date } | undefined {
    return recurrenceDate ? { recurrenceDate, sequence: event.sequence, dtstamp: event.updatedAt } : undefined;
}
