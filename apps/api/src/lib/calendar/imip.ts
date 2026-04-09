import type { Attendee, CalendarEvent, EventData } from '@workspace/lib/types/calendar';
import { parseIcs } from '../caldav/ical-parse';
import { serializeEventForImip } from '../caldav/ical-serialize';
import type { OutboundMail } from '../core/mailer';
import type { Home } from '../home';
import type { ParsedMail } from '../mail/mail-parser';
import type { ReceiveInvitationPayload } from './calendar';

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

export function extractCalendarAttachment(mail: ParsedMail): { ics: string; method?: string } | null {
    const attachment = mail.attachments.find((a) => a.contentType.startsWith('text/calendar'));
    if (!attachment) return null;

    const content = attachment.content;
    const ics = typeof content === 'string' ? content : Buffer.from(content as Buffer).toString('utf-8');

    // Extract method from Content-Type header parameter (e.g. "text/calendar; method=REQUEST")
    const methodMatch = attachment.contentType.match(/method=(\w+)/i);
    const method = methodMatch ? methodMatch[1].toUpperCase() : undefined;

    return { ics, method };
}

export function processInboundImip(home: Home, mail: ParsedMail): void {
    const calAttachment = extractCalendarAttachment(mail);
    if (!calAttachment) return;

    const { events, method: parsedMethod } = parseIcs(calAttachment.ics);
    const method = parsedMethod ?? calAttachment.method;
    if (!method || events.length === 0) return;

    const calendar = home.calendar;

    for (const parsed of events) {
        if (method === 'REQUEST') {
            const existing = calendar.getEventsByUid(parsed.uid);
            const linked = existing.find((e) => e.data?.organizer);

            if (linked) {
                calendar.receiveInvitationUpdate(linked.data!.organizerEventId!, linked.data!.organizer!.userId, {
                    title: parsed.title,
                    description: parsed.description,
                    location: parsed.location,
                    startTime: parsed.startTime,
                    endTime: parsed.endTime,
                    allDay: parsed.allDay,
                    rrule: parsed.rrule,
                    timezone: parsed.timezone,
                    status: parsed.status,
                    sequence: parsed.sequence,
                    attendees: parsed.data?.attendees,
                });
            } else {
                const organizerEmail = parsed.data?.organizer?.email ?? '';
                const payload: ReceiveInvitationPayload = {
                    uid: parsed.uid,
                    title: parsed.title,
                    description: parsed.description,
                    location: parsed.location,
                    startTime: parsed.startTime,
                    endTime: parsed.endTime,
                    allDay: parsed.allDay,
                    rrule: parsed.rrule,
                    timezone: parsed.timezone,
                    status: parsed.status,
                    sequence: parsed.sequence,
                    data: parsed.data ?? {},
                    createByUserId: `external_${organizerEmail}`,
                    organizerEventId: parsed.uid,
                    organizerUserId: `external_${organizerEmail}`,
                };
                calendar.receiveInvitation(payload);
            }
        } else if (method === 'CANCEL') {
            const organizerEmail = parsed.data?.organizer?.email ?? '';
            calendar.removeInvitation(parsed.uid, `external_${organizerEmail}`);
        } else if (method === 'REPLY') {
            const existing = calendar.getEventsByUid(parsed.uid);
            if (existing.length > 0 && parsed.data?.attendees) {
                for (const attendee of parsed.data.attendees) {
                    calendar.updateAttendeeStatus(existing[0].id, attendee.email, attendee.status);
                }
            }
        }
    }
}
