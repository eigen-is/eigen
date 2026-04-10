import {
    type Attendee,
    type CalendarEvent,
    type EventData,
    IMIP_METHODS,
    type ImipMethod,
} from '@workspace/lib/types/calendar';
import type { Attachment } from '@workspace/lib/types/mail';
import { externalOwnerId } from '@workspace/lib/types/owner';
import { parseIcs } from '../caldav/ical-parse';
import { serializeEventForImip } from '../caldav/ical-serialize';
import type { OutboundICalEvent, OutboundMail } from '../core/mailer';
import type { Home } from '../home';
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

function withOrganizer(event: CalendarEvent, organizer: Organizer): CalendarEvent {
    return { ...event, data: { ...event.data, organizer } };
}

function icalEvent(event: CalendarEvent, method: 'REQUEST' | 'REPLY' | 'CANCEL'): OutboundICalEvent {
    return { method, content: serializeEventForImip(event, method) };
}

export function composeInviteEmail(event: CalendarEvent, organizer: Organizer, attendees: Attendee[]): OutboundMail {
    return {
        from: { name: organizer.name ?? '', address: organizer.email },
        to: attendees.map((a) => ({ name: a.name ?? '', address: a.email })),
        subject: `Invitation: ${event.title}`,
        text: buildEventSummary(event),
        icalEvent: icalEvent(withOrganizer(event, organizer), 'REQUEST'),
    };
}

export function composeUpdateEmail(event: CalendarEvent, organizer: Organizer, attendees: Attendee[]): OutboundMail {
    return {
        from: { name: organizer.name ?? '', address: organizer.email },
        to: attendees.map((a) => ({ name: a.name ?? '', address: a.email })),
        subject: `Updated invitation: ${event.title}`,
        text: buildEventSummary(event),
        icalEvent: icalEvent(withOrganizer(event, organizer), 'REQUEST'),
    };
}

export function composeCancelEmail(event: CalendarEvent, organizer: Organizer, attendees: Attendee[]): OutboundMail {
    return {
        from: { name: organizer.name ?? '', address: organizer.email },
        to: attendees.map((a) => ({ name: a.name ?? '', address: a.email })),
        subject: `Cancelled: ${event.title}`,
        text: `This event has been cancelled:\n\n${buildEventSummary(event)}`,
        icalEvent: icalEvent(withOrganizer(event, organizer), 'CANCEL'),
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

    return {
        from: { name: attendeeName, address: attendeeEmail },
        to: [{ name: event.data?.organizer?.name ?? '', address: organizerEmail }],
        subject: `${STATUS_LABELS[status]}: ${event.title}`,
        text: `${attendeeName} has ${STATUS_LABELS[status].toLowerCase()} the invitation: ${event.title}`,
        icalEvent: icalEvent(replyEvent, 'REPLY'),
    };
}

export function extractCalendarAttachment(mail: {
    attachments: Attachment[];
}): { ics: string; method?: ImipMethod } | null {
    const attachment = mail.attachments.find((a) => a.contentType.startsWith('text/calendar'));
    if (!attachment) return null;

    const content = attachment.content;
    const ics =
        typeof content === 'string' ? content : content instanceof Buffer ? content.toString('utf-8') : String(content);

    // Extract method from Content-Type header parameter (e.g. "text/calendar; method=REQUEST")
    const methodMatch = attachment.contentType.match(/method=(\w+)/i);
    const raw = methodMatch ? methodMatch[1].toUpperCase() : undefined;
    const method = raw && IMIP_METHODS.includes(raw as ImipMethod) ? (raw as ImipMethod) : undefined;

    return { ics, method };
}

export function processInboundImip(home: Home, mail: { attachments: Attachment[] }): void {
    const calAttachment = extractCalendarAttachment(mail);
    if (!calAttachment) return;

    const { events, method: parsedMethod } = parseIcs(calAttachment.ics);
    const method = parsedMethod ?? calAttachment.method;
    if (!method || events.length === 0) return;

    const calendar = home.calendar;

    for (const parsed of events) {
        if (method === 'REQUEST') {
            const existing = calendar.getEventsByUid(parsed.uid);
            const linked = existing.find((e) => e.data?.organizer && e.data?.organizerEventId);

            const orgEventId = linked?.data?.organizerEventId;
            const orgUserId = linked?.data?.organizer?.userId;
            if (orgEventId && orgUserId) {
                calendar.receiveInvitationUpdate(orgEventId, orgUserId, {
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
                const organizerEmail = parsed.data?.organizer?.email;
                if (!organizerEmail) continue;
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
                    data: {
                        ...parsed.data,
                        organizer: parsed.data?.organizer
                            ? { ...parsed.data.organizer, userId: externalOwnerId(organizerEmail) }
                            : undefined,
                        organizerEventId: parsed.uid,
                    },
                    createByUserId: externalOwnerId(organizerEmail),
                    organizerEventId: parsed.uid,
                    organizerUserId: externalOwnerId(organizerEmail),
                };
                calendar.receiveInvitation(payload);
            }
        } else if (method === 'CANCEL') {
            const organizerEmail = parsed.data?.organizer?.email;
            if (!organizerEmail) continue;
            calendar.removeInvitation(parsed.uid, externalOwnerId(organizerEmail));
        } else if (method === 'REPLY') {
            // Find the organizer's own event (not a linked copy) by UID
            const ownerEvent = calendar.getEventsByUid(parsed.uid).find((e) => !e.data?.organizer);
            if (ownerEvent && parsed.data?.attendees) {
                for (const attendee of parsed.data.attendees) {
                    calendar.updateAttendeeStatus(ownerEvent.id, attendee.email, attendee.status);
                }
            }
        }
    }
}
