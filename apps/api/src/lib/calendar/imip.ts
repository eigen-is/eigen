import { formatEventWhen } from '@workspace/lib/date';
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
import { getDomain } from '../config/server-config';
import type { OutboundICalEvent, OutboundMail } from '../core/mailer';
import { escapeHtml } from '../export/media';
import type { Home } from '../home';
import type { ReceiveInvitationPayload } from './calendar';

type Organizer = NonNullable<EventData['organizer']>;

function buildEventSummary(event: CalendarEvent): string {
    const when = formatEventWhen(event.startTime, event.endTime, event.allDay, event.timezone);
    const lines: string[] = [];
    lines.push(`What: ${event.title}`);
    lines.push(`When: ${when}`);
    if (event.location) lines.push(`Where: ${event.location}`);
    if (event.description) lines.push(`Description: ${event.description}`);
    return lines.join('\n');
}

function buildSection(label: string, value: string): string {
    return `<div style="margin-bottom:16px">
      <div style="font-weight:600;font-size:13px;color:#5f6368;margin-bottom:4px">${label}</div>
      <div style="font-size:14px;color:#1a1a1a">${value}</div>
    </div>`;
}

function buildEventHtml(event: CalendarEvent, organizer: Organizer, banner?: string): string {
    const domain = getDomain();
    const domainUrl = domain === 'localhost' ? '' : `https://${domain}`;
    const sections: string[] = [];

    const when = formatEventWhen(event.startTime, event.endTime, event.allDay, event.timezone);
    sections.push(buildSection('When', escapeHtml(when)));
    if (event.location) sections.push(buildSection('Where', escapeHtml(event.location)));
    if (event.description)
        sections.push(buildSection('Description', escapeHtml(event.description).replace(/\n/g, '<br>')));

    const bannerHtml = banner
        ? `<div style="background:#fce8e6;color:#c5221f;font-weight:600;font-size:13px;padding:8px 12px;border-radius:4px;margin-bottom:16px">${banner}</div>`
        : '';

    const organizerName = escapeHtml(organizer.name || organizer.email);
    const footerLink = domainUrl
        ? `<a href="${domainUrl}" style="color:#1a73e8;text-decoration:none">Eigen Calendar</a>`
        : 'Eigen Calendar';

    return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:0 16px">
  <div style="border:1px solid #e0e0e0;border-radius:8px;padding:24px;margin:16px 0">
    ${bannerHtml}<h2 style="margin:0 0 20px;font-size:18px;font-weight:600;color:#1a1a1a">${escapeHtml(event.title)}</h2>
    ${sections.join('\n    ')}
  </div>
  <div style="font-size:12px;color:#5f6368;padding:0 4px">Invitation from ${organizerName} · ${footerLink}</div>
</div>`;
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
        html: buildEventHtml(event, organizer),
        icalEvent: icalEvent(withOrganizer(event, organizer), 'REQUEST'),
    };
}

export function composeUpdateEmail(event: CalendarEvent, organizer: Organizer, attendees: Attendee[]): OutboundMail {
    return {
        from: { name: organizer.name ?? '', address: organizer.email },
        to: attendees.map((a) => ({ name: a.name ?? '', address: a.email })),
        subject: `Updated invitation: ${event.title}`,
        text: buildEventSummary(event),
        html: buildEventHtml(event, organizer, 'This event has been updated'),
        icalEvent: icalEvent(withOrganizer(event, organizer), 'REQUEST'),
    };
}

export function composeCancelEmail(event: CalendarEvent, organizer: Organizer, attendees: Attendee[]): OutboundMail {
    return {
        from: { name: organizer.name ?? '', address: organizer.email },
        to: attendees.map((a) => ({ name: a.name ?? '', address: a.email })),
        subject: `Cancelled: ${event.title}`,
        text: `This event has been cancelled:\n\n${buildEventSummary(event)}`,
        html: buildEventHtml(event, organizer, 'This event has been cancelled'),
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
    const organizer = event.data?.organizer;
    if (!organizer) throw new Error('Event has no organizer');

    const replyEvent: CalendarEvent = {
        ...event,
        data: {
            ...event.data,
            attendees: [{ email: attendeeEmail, name: attendeeName, status, role: 'required' }],
        },
    };

    const statusLabel = STATUS_LABELS[status].toLowerCase();
    return {
        from: { name: attendeeName, address: attendeeEmail },
        to: [{ name: organizer.name ?? '', address: organizer.email }],
        subject: `${STATUS_LABELS[status]}: ${event.title}`,
        text: `${attendeeName} has ${statusLabel} the invitation: ${event.title}`,
        html: buildEventHtml(event, organizer, `${escapeHtml(attendeeName)} has ${statusLabel} the invitation`),
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
