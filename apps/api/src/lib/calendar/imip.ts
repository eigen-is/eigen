import type { Attendee, CalendarEvent, EventData } from '@workspace/lib/types/calendar';
import { serializeEventForImip } from '../caldav/ical-serialize';
import type { OutboundMail } from '../core/mailer';

type Organizer = NonNullable<EventData['organizer']>;

function formatEventTime(epochSeconds: number, allDay: boolean): string {
    const d = new Date(epochSeconds * 1000);
    if (allDay) return d.toISOString().slice(0, 10);
    return d.toUTCString();
}

function buildEventSummary(event: CalendarEvent): string {
    const lines: string[] = [];
    lines.push(`What: ${event.title}`);
    lines.push(
        `When: ${formatEventTime(event.startTime, event.allDay)} - ${formatEventTime(event.endTime, event.allDay)}`,
    );
    if (event.location) lines.push(`Where: ${event.location}`);
    if (event.description) lines.push(`Description: ${event.description}`);
    return lines.join('\n');
}

export function composeInviteEmail(event: CalendarEvent, organizer: Organizer, attendees: Attendee[]): OutboundMail {
    const ics = serializeEventForImip(event, 'REQUEST');
    return {
        from: { name: organizer.name ?? '', address: organizer.email },
        to: attendees.map((a) => ({ name: a.name ?? '', address: a.email })),
        subject: `Invitation: ${event.title}`,
        text: buildEventSummary(event),
        attachments: [{ filename: 'invite.ics', content: ics, contentType: 'text/calendar; method=REQUEST' }],
    };
}

export function composeUpdateEmail(event: CalendarEvent, organizer: Organizer, attendees: Attendee[]): OutboundMail {
    const ics = serializeEventForImip(event, 'REQUEST');
    return {
        from: { name: organizer.name ?? '', address: organizer.email },
        to: attendees.map((a) => ({ name: a.name ?? '', address: a.email })),
        subject: `Updated invitation: ${event.title}`,
        text: buildEventSummary(event),
        attachments: [{ filename: 'invite.ics', content: ics, contentType: 'text/calendar; method=REQUEST' }],
    };
}

export function composeCancelEmail(event: CalendarEvent, organizer: Organizer, attendees: Attendee[]): OutboundMail {
    const ics = serializeEventForImip(event, 'CANCEL');
    return {
        from: { name: organizer.name ?? '', address: organizer.email },
        to: attendees.map((a) => ({ name: a.name ?? '', address: a.email })),
        subject: `Cancelled: ${event.title}`,
        text: `This event has been cancelled:\n\n${buildEventSummary(event)}`,
        attachments: [{ filename: 'invite.ics', content: ics, contentType: 'text/calendar; method=CANCEL' }],
    };
}

const STATUS_LABELS: Record<Attendee['status'], string> = {
    accepted: 'Accepted',
    declined: 'Declined',
    tentative: 'Tentatively accepted',
    pending: 'Pending',
};

export function composeRsvpReply(
    event: CalendarEvent,
    attendeeEmail: string,
    attendeeName: string,
    status: Attendee['status'],
): OutboundMail {
    const organizerEmail = event.data?.organizer?.email;
    if (!organizerEmail) throw new Error('Event has no organizer');

    const replyEvent: CalendarEvent = {
        ...event,
        data: {
            ...event.data,
            attendees: [{ email: attendeeEmail, name: attendeeName, status, role: 'required' }],
        },
    };
    const ics = serializeEventForImip(replyEvent, 'REPLY');

    return {
        from: { name: attendeeName, address: attendeeEmail },
        to: [{ name: event.data?.organizer?.name ?? '', address: organizerEmail }],
        subject: `${STATUS_LABELS[status]}: ${event.title}`,
        text: `${attendeeName} has ${STATUS_LABELS[status].toLowerCase()} the invitation: ${event.title}`,
        attachments: [{ filename: 'invite.ics', content: ics, contentType: 'text/calendar; method=REPLY' }],
    };
}
