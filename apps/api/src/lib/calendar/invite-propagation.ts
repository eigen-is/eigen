import type { Attendee, CalendarEvent } from '@workspace/lib/types/calendar';
import { SSEventType } from '@workspace/lib/types/sse';
import { getServerSettings } from '../config/server-settings';
import { sendMail } from '../core/mailer';
import type { Home } from '../home';
import { sendToHome } from '../home/home-relay';
import { addRegistryEntry } from '../share';
import type { User } from '../user';
import { getUserByEmail } from '../user/';
import { composeCancelEmail, composeInviteEmail, composeUpdateEmail } from './imip';
import { buildCalendarEvent } from './sse-events';

// The revision its receiver orders the removal against; undefined for a message about the whole series.
function occurrenceRevision(
    event: CalendarEvent,
    recurrenceDate: string | null,
): { recurrenceDate: string; sequence: number; dtstamp: Date } | undefined {
    return recurrenceDate ? { recurrenceDate, sequence: event.sequence, dtstamp: event.updatedAt } : undefined;
}

// `series` set means `event` is one occurrence: the messages name the series id plus the occurrence key, the shape an iMIP REQUEST with a RECURRENCE-ID has (docs/CALENDAR.md § Invitations).
export async function propagateInvitation(
    organizerHome: Home,
    event: CalendarEvent,
    user: User,
    oldAttendees: Attendee[],
    newAttendees: Attendee[],
    series?: CalendarEvent,
): Promise<void> {
    const organizerEventId = series?.id ?? event.id;
    const recurrenceDate = series ? event.recurrenceDate : null;
    const oldEmails = new Set(oldAttendees.map((a) => a.email.toLowerCase()));
    const newEmails = new Set(newAttendees.map((a) => a.email.toLowerCase()));

    const added = newAttendees.filter((a) => !oldEmails.has(a.email.toLowerCase()));
    const removed = oldAttendees.filter((a) => !newEmails.has(a.email.toLowerCase()));
    const existing = newAttendees.filter((a) => oldEmails.has(a.email.toLowerCase()));

    const organizerEmail = user.email.toLowerCase();

    for (const attendee of added) {
        if (attendee.email.toLowerCase() === organizerEmail) continue;
        try {
            const targetUser = await getUserByEmail(attendee.email);
            if (!targetUser || targetUser.role === 'guest') {
                await addRegistryEntry(organizerHome.user.id, attendee.email);
                // Send iMIP invite email to external attendee
                const organizer = { userId: user.id, email: user.email, name: user.name };
                const mail = composeInviteEmail(event, organizer, [attendee], series);
                sendMail(mail).catch((err) => console.error('Failed to send iMIP invite:', err));
                continue;
            }
            await sendToHome(targetUser.id, {
                type: 'calendar:invitation',
                payload: {
                    uid: event.uid,
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
                    // The organizer's own revision, so the attendee can order this message against the next (RFC 5546 § 2.1.5); the fan-out is unordered.
                    dtstamp: event.updatedAt,
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
            if (getServerSettings().notifications.email.userOnCalendarInvite) {
                const organizer = { userId: user.id, email: user.email, name: user.name };
                const mail = composeInviteEmail(event, organizer, [attendee], series);
                // A local recipient already has the event via sendToHome, so the iMIP attachment would fire a second update.
                mail.icalEvent = undefined;
                sendMail(mail).catch((err) => console.error('Failed to send Eigen invite email:', err));
            }
        } catch (error) {
            console.error('Failed to send invitation:', error);
        }
    }

    for (const attendee of removed) {
        if (attendee.email.toLowerCase() === organizerEmail) continue;
        try {
            const targetUser = await getUserByEmail(attendee.email);
            if (!targetUser || targetUser.role === 'guest') {
                const organizer = { userId: user.id, email: user.email, name: user.name };
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
        if (attendee.email.toLowerCase() === organizerEmail) continue;
        try {
            const targetUser = await getUserByEmail(attendee.email);
            if (!targetUser || targetUser.role === 'guest') {
                const organizer = { userId: user.id, email: user.email, name: user.name };
                const mail = composeUpdateEmail(event, organizer, [attendee], series);
                sendMail(mail).catch((err) => console.error('Failed to send iMIP update:', err));
                continue;
            }
            await sendToHome(targetUser.id, {
                type: 'calendar:invitation-update',
                orgEventId: organizerEventId,
                orgUserId: organizerHome.user.id,
                payload: {
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
                    dtstamp: event.updatedAt,
                    attendees: newAttendees,
                },
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

// `attendees` is who held the event: a cancelled occurrence — an EXDATE with no guest list — cannot state it itself.
export async function propagateCancellation(
    organizerHome: Home,
    event: CalendarEvent,
    attendees: Attendee[],
    series?: CalendarEvent,
): Promise<void> {
    const occurrence = occurrenceRevision(event, series ? event.recurrenceDate : null);
    for (const attendee of attendees) {
        try {
            const targetUser = await getUserByEmail(attendee.email);
            if (!targetUser || targetUser.role === 'guest') {
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

export async function propagateDecline(
    organizerUserId: string,
    organizerEventId: string,
    attendeeEmail: string,
    recurrenceDate?: string,
): Promise<void> {
    await propagateRsvp(organizerUserId, organizerEventId, attendeeEmail, 'declined', recurrenceDate);
}

// The occurrence a linked copy answers for: a copy that IS one occurrence of a series the guest does not hold. An exception answers through the master it hangs on.
export function answeredOccurrence(event: CalendarEvent): string | undefined {
    return event.parentEventId ? undefined : (event.recurrenceDate ?? undefined);
}
