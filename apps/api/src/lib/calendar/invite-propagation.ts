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

export async function propagateInvitation(
    organizerHome: Home,
    event: CalendarEvent,
    user: User,
    oldAttendees: Attendee[],
    newAttendees: Attendee[],
): Promise<void> {
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
                const mail = composeInviteEmail(event, organizer, [attendee]);
                sendMail(mail).catch((err) => console.error('Failed to send iMIP invite:', err));
                continue;
            }
            await sendToHome(targetUser.id, {
                type: 'calendar:invitation',
                payload: {
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
                    data: {
                        organizer: { userId: organizerHome.user.id, email: user.email, name: user.name },
                        organizerEventId: event.id,
                        attendees: newAttendees,
                    },
                    createByUserId: user.id,
                    organizerEventId: event.id,
                    organizerUserId: organizerHome.user.id,
                },
            });
            if (getServerSettings().notifications.email.userOnCalendarInvite) {
                const organizer = { userId: user.id, email: user.email, name: user.name };
                const mail = composeInviteEmail(event, organizer, [attendee]);
                // Local Eigen recipient already has the event in-app via sendToHome above.
                // Drop the iMIP attachment so processInboundImip doesn't fire a second update.
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
                const mail = composeCancelEmail(event, organizer, [attendee]);
                sendMail(mail).catch((err) => console.error('Failed to send iMIP cancel:', err));
                continue;
            }
            await sendToHome(targetUser.id, {
                type: 'calendar:invitation-removal',
                orgEventId: event.id,
                orgUserId: organizerHome.user.id,
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
                const mail = composeUpdateEmail(event, organizer, [attendee]);
                sendMail(mail).catch((err) => console.error('Failed to send iMIP update:', err));
                continue;
            }
            await sendToHome(targetUser.id, {
                type: 'calendar:invitation-update',
                orgEventId: event.id,
                orgUserId: organizerHome.user.id,
                payload: {
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

export async function propagateCancellation(organizerHome: Home, event: CalendarEvent): Promise<void> {
    const attendees = event.data?.attendees || [];
    for (const attendee of attendees) {
        try {
            const targetUser = await getUserByEmail(attendee.email);
            if (!targetUser || targetUser.role === 'guest') {
                const organizer = {
                    userId: organizerHome.user.id,
                    email: organizerHome.user.email,
                    name: organizerHome.user.name,
                };
                const mail = composeCancelEmail(event, organizer, [attendee]);
                sendMail(mail).catch((err) => console.error('Failed to send iMIP cancel:', err));
                continue;
            }
            await sendToHome(targetUser.id, {
                type: 'calendar:invitation-removal',
                orgEventId: event.id,
                orgUserId: organizerHome.user.id,
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
): Promise<void> {
    await propagateRsvp(organizerUserId, organizerEventId, attendeeEmail, 'declined');
}
