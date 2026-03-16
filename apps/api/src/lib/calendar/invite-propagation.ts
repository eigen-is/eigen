import type {Attendee, CalendarEvent} from '@workspace/lib/types/calendar';
import {SSEventType} from '@workspace/lib/types/sse';
import {getUserByEmail} from '../user/';
import type {Home} from '../home';
import {getHome} from '../home';
import {addRegistryEntry} from '../share';
import {buildCalendarEvent} from './sse-events';

type InviteUser = { id: string; email: string; name?: string | null };

export async function propagateInvitation(
    organizerHome: Home,
    event: CalendarEvent,
    user: InviteUser,
    oldAttendees: Attendee[],
    newAttendees: Attendee[],
): Promise<void> {
    const oldEmails = new Set(oldAttendees.map(a => a.email.toLowerCase()));
    const newEmails = new Set(newAttendees.map(a => a.email.toLowerCase()));

    const added = newAttendees.filter(a => !oldEmails.has(a.email.toLowerCase()));
    const removed = oldAttendees.filter(a => !newEmails.has(a.email.toLowerCase()));
    const existing = newAttendees.filter(a => oldEmails.has(a.email.toLowerCase()));

    const organizerEmail = user.email.toLowerCase();

    for (const attendee of added) {
        if (attendee.email.toLowerCase() === organizerEmail) continue;
        try {
            const targetUser = await getUserByEmail(attendee.email);
            if (!targetUser) {
                await addRegistryEntry(organizerHome.user.id, attendee.email);
                continue;
            }
            const targetHome = await getHome(targetUser.id);
            targetHome.calendar.receiveInvitation({
                uid: event.uid,
                title: event.title,
                description: event.description,
                location: event.location,
                startTime: event.startTime,
                endTime: event.endTime,
                allDay: event.allDay,
                rrule: event.rrule,
                status: event.status,
                sequence: event.sequence,
                data: {
                    organizer: {userId: organizerHome.user.id, email: user.email, name: user.name ?? undefined},
                    organizerEventId: event.id,
                    attendees: newAttendees,
                },
                createByUserId: user.id,
                organizerEventId: event.id,
                organizerUserId: organizerHome.user.id,
            });
            targetHome.notify(buildCalendarEvent(SSEventType.CALENDAR_INVITE_RECEIVED, {
                calendarId: '', eventId: event.id, title: event.title,
            }));
        } catch (error) {
            console.error('Failed to send invitation:', error);
        }
    }

    for (const attendee of removed) {
        if (attendee.email.toLowerCase() === organizerEmail) continue;
        try {
            const targetUser = await getUserByEmail(attendee.email);
            if (!targetUser) continue;
            const targetHome = await getHome(targetUser.id);
            targetHome.calendar.removeInvitation(event.id, organizerHome.user.id);
            targetHome.notify(buildCalendarEvent(SSEventType.CALENDAR_INVITE_CANCELLED, {
                calendarId: '', eventId: event.id, title: event.title,
            }));
        } catch (error) {
            console.error('Failed to cancel invitation:', error);
        }
    }

    for (const attendee of existing) {
        if (attendee.email.toLowerCase() === organizerEmail) continue;
        try {
            const targetUser = await getUserByEmail(attendee.email);
            if (!targetUser) continue;
            const targetHome = await getHome(targetUser.id);
            targetHome.calendar.receiveInvitationUpdate(event.id, organizerHome.user.id, {
                title: event.title,
                description: event.description,
                location: event.location,
                startTime: event.startTime,
                endTime: event.endTime,
                allDay: event.allDay,
                rrule: event.rrule,
                status: event.status,
                sequence: event.sequence,
                attendees: newAttendees,
            });
            targetHome.notify(buildCalendarEvent(SSEventType.CALENDAR_INVITE_UPDATED, {
                calendarId: '', eventId: event.id, title: event.title,
            }));
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
): Promise<void> {
    const organizerHome = await getHome(organizerUserId);
    organizerHome.calendar.updateAttendeeStatus(organizerEventId, attendeeEmail, newStatus);
    organizerHome.notify(buildCalendarEvent(SSEventType.CALENDAR_INVITE_RSVP, {
        calendarId: '', eventId: organizerEventId,
    }));
}

export async function propagateCancellation(
    organizerHome: Home,
    event: CalendarEvent,
): Promise<void> {
    const attendees = event.data?.attendees || [];
    for (const attendee of attendees) {
        try {
            const targetUser = await getUserByEmail(attendee.email);
            if (!targetUser) continue;
            const targetHome = await getHome(targetUser.id);
            targetHome.calendar.removeInvitation(event.id, organizerHome.user.id);
            targetHome.notify(buildCalendarEvent(SSEventType.CALENDAR_INVITE_CANCELLED, {
                calendarId: '', eventId: event.id, title: event.title,
            }));
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
