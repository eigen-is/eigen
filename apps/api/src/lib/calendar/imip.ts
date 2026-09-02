import { formatEventWhen } from '@workspace/lib/calendar/calendar-utils';
import { escapeHtml } from '@workspace/lib/html';
import type { Attendee, CalendarEvent, EventData, ImipMethod } from '@workspace/lib/types/calendar';
import type { AddressObject, Attachment, CalendarInvite } from '@workspace/lib/types/mail';
import { externalOwnerId } from '@workspace/lib/types/owner';
import { parseIcs } from '../caldav/ical-parse';
import { serializeEventForImip } from '../caldav/ical-serialize';
import { renderEigenEmail } from '../core/mail-template';
import type { OutboundICalEvent, OutboundMail } from '../core/mailer';
import type { Home } from '../home';
import { computeOccurrenceTimes } from './recurrence';
import type { ReceiveInvitationPayload } from './types';

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

function buildEventBodyHtml(event: CalendarEvent): string {
    const sections: string[] = [];
    const when = formatEventWhen(event.startTime, event.endTime, event.allDay, event.timezone);
    sections.push(buildSection('When', escapeHtml(when)));
    if (event.location) sections.push(buildSection('Where', escapeHtml(event.location)));
    if (event.description)
        sections.push(buildSection('Description', escapeHtml(event.description).replace(/\n/g, '<br>')));
    return sections.join('\n');
}

function buildEventHtml(event: CalendarEvent, footerLine: string, banner?: string): string {
    return renderEigenEmail({
        title: event.title,
        bodyHtml: buildEventBodyHtml(event),
        banner,
        footerLine,
    });
}

function withOrganizer(event: CalendarEvent, organizer: Organizer): CalendarEvent {
    return { ...event, data: { ...event.data, organizer } };
}

function icalEvent(event: CalendarEvent, method: 'REQUEST' | 'REPLY' | 'CANCEL'): OutboundICalEvent {
    return { method, content: serializeEventForImip(event, method) };
}

export function composeInviteEmail(event: CalendarEvent, organizer: Organizer, attendees: Attendee[]): OutboundMail {
    const footer = `Invitation from ${organizer.name || organizer.email}`;
    return {
        from: { name: organizer.name ?? '', address: organizer.email },
        to: attendees.map((a) => ({ name: a.name ?? '', address: a.email })),
        subject: `Invitation: ${event.title}`,
        text: buildEventSummary(event),
        html: buildEventHtml(event, footer),
        icalEvent: icalEvent(withOrganizer(event, organizer), 'REQUEST'),
    };
}

export function composeUpdateEmail(event: CalendarEvent, organizer: Organizer, attendees: Attendee[]): OutboundMail {
    const footer = `Invitation from ${organizer.name || organizer.email}`;
    return {
        from: { name: organizer.name ?? '', address: organizer.email },
        to: attendees.map((a) => ({ name: a.name ?? '', address: a.email })),
        subject: `Updated invitation: ${event.title}`,
        text: buildEventSummary(event),
        html: buildEventHtml(event, footer, 'This event has been updated'),
        icalEvent: icalEvent(withOrganizer(event, organizer), 'REQUEST'),
    };
}

export function composeCancelEmail(event: CalendarEvent, organizer: Organizer, attendees: Attendee[]): OutboundMail {
    const footer = `Invitation from ${organizer.name || organizer.email}`;
    return {
        from: { name: organizer.name ?? '', address: organizer.email },
        to: attendees.map((a) => ({ name: a.name ?? '', address: a.email })),
        subject: `Cancelled: ${event.title}`,
        text: `This event has been cancelled:\n\n${buildEventSummary(event)}`,
        html: buildEventHtml(event, footer, 'This event has been cancelled'),
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
    recurrenceDate?: string,
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

    // A scope:'this' RSVP answers ONE occurrence: carry a RECURRENCE-ID for the original instant
    // (RFC 5546) so an external organizer applies the PARTSTAT to that instance, not the whole series.
    // An RSVP never moves the occurrence, so its time comes straight from the master's recurrence via
    // computeOccurrenceTimes; dropping the rrule makes the VEVENT read as a single instance.
    if (recurrenceDate) {
        const { startTime, endTime } = computeOccurrenceTimes(event, recurrenceDate);
        replyEvent.rrule = null;
        replyEvent.recurrenceDate = recurrenceDate;
        replyEvent.startTime = startTime;
        replyEvent.endTime = endTime;
    }

    const statusLabel = STATUS_LABELS[status].toLowerCase();
    return {
        from: { name: attendeeName, address: attendeeEmail },
        to: [{ name: organizer.name ?? '', address: organizer.email }],
        subject: `${STATUS_LABELS[status]}: ${event.title}`,
        text: `${attendeeName} has ${statusLabel} the invitation: ${event.title}`,
        html: buildEventHtml(
            event,
            `Reply from ${attendeeName}`,
            `${escapeHtml(attendeeName)} has ${statusLabel} the invitation`,
        ),
        icalEvent: icalEvent(replyEvent, 'REPLY'),
    };
}

export function extractCalendarAttachment(mail: {
    attachments: Attachment[];
}): { ics: string; method?: ImipMethod } | null {
    const attachment = mail.attachments.find((a) => a.contentType.startsWith('text/calendar'));
    if (!attachment) return null;

    return { ics: Buffer.from(attachment.content).toString(), method: attachment.calendarMethod };
}

// Read-time summary of a single text/calendar attachment for the message-detail payload.
// Returns null for unparseable ICS — the mail widget renders that as an explicit error state.
export function summarizeCalendarInvite(attachment: Attachment): CalendarInvite | null {
    const cal = extractCalendarAttachment({ attachments: [attachment] });
    if (!cal) return null;
    try {
        const { events, method } = parseIcs(cal.ics);
        const event = events[0];
        if (!event) return null;
        const organizer = event.data?.organizer;
        return {
            // ICS METHOD wins, then the parser's Content-Type-derived calendarMethod; a bare
            // event .ics without METHOD anywhere still renders as an invitation card.
            method: method ?? cal.method ?? 'REQUEST',
            uid: event.uid,
            summary: event.title,
            startTime: event.startTime,
            endTime: event.endTime,
            allDay: event.allDay,
            timezone: event.timezone,
            location: event.location,
            organizer: organizer ? { email: organizer.email, name: organizer.name } : null,
        };
    } catch {
        return null;
    }
}

export function processInboundImip(home: Home, mail: { attachments: Attachment[]; from?: AddressObject }): void {
    const calAttachment = extractCalendarAttachment(mail);
    if (!calAttachment) return;

    const { events, method: parsedMethod } = parseIcs(calAttachment.ics);
    const method = parsedMethod ?? calAttachment.method;
    if (!method || events.length === 0) return;

    // The ICS body carries attacker-controlled identities: a forged REPLY (UIDs ship in every invite)
    // could set another attendee's status, and a forged REQUEST/CANCEL could inject or drop events under
    // a spoofed organizer. Bind every mutation to the envelope sender; fail closed if it's unknown.
    const sender = mail.from?.value?.[0]?.address?.toLowerCase() ?? null;
    const sentBy = (email: string | undefined): email is string => !!sender && email?.toLowerCase() === sender;

    const calendar = home.calendar;

    for (const parsed of events) {
        // Untrusted external ICS: clamp a reversed interval to zero-duration rather than reject the whole
        // invite (mirrors the parser degrading a malformed rrule/tzid). iMIP is fire-and-forget email —
        // there's no synchronous 400 to return, so dropping the invitation would be worse for the user than
        // showing a zero-length event. The receive* writes bypass the createEvent/updateEvent guard, so this
        // is where the domain's interval invariant is enforced for the inbound path.
        if (parsed.endTime < parsed.startTime) parsed.endTime = parsed.startTime;

        if (method === 'REQUEST') {
            const existing = calendar.getEventsByUid(parsed.uid);
            const linked = existing.find((e) => e.data?.organizer && e.data?.organizerEventId);

            const orgEventId = linked?.data?.organizerEventId;
            const orgUserId = linked?.data?.organizer?.userId;
            if (orgEventId && orgUserId) {
                // Updates bind to the STORED organizer, not the ICS one, so co-attendees can't hijack the invite.
                if (!sentBy(linked?.data?.organizer?.email)) continue;
                if (parsed.recurrenceDate) {
                    // Single-occurrence move (Google/Outlook "this event" edit): attach an exception to
                    // the linked series. A full-event update here would null the master's rrule and move
                    // its start, collapsing the whole series (audit #A).
                    calendar.receiveInvitationException(orgEventId, orgUserId, {
                        recurrenceDate: parsed.recurrenceDate,
                        recurrenceInstant: parsed.recurrenceInstant,
                        title: parsed.title,
                        description: parsed.description,
                        location: parsed.location,
                        startTime: parsed.startTime,
                        endTime: parsed.endTime,
                        allDay: parsed.allDay,
                        timezone: parsed.timezone,
                        status: parsed.status,
                        sequence: parsed.sequence,
                        attendees: parsed.data?.attendees,
                    });
                } else {
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
                }
            } else {
                // New invites are attributed to the sender, so the ICS organizer must equal the envelope From.
                const organizerEmail = parsed.data?.organizer?.email;
                if (!sentBy(organizerEmail)) continue;
                // A lone exception REQUEST with no known master has nothing to attach to — ignore it
                // rather than materialise a bogus single event under the series UID.
                if (parsed.recurrenceDate) continue;
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
            // CANCEL is an organizer action too — same sender binding as REQUEST.
            const organizerEmail = parsed.data?.organizer?.email;
            if (!sentBy(organizerEmail)) continue;
            if (parsed.recurrenceDate) {
                // Cancelling one occurrence must cancel that instance only — removeInvitation would
                // delete the attendee's entire linked series (audit #B).
                calendar.cancelInvitationOccurrence(
                    parsed.uid,
                    externalOwnerId(organizerEmail),
                    parsed.recurrenceDate,
                    parsed.recurrenceInstant,
                    parsed.sequence,
                );
            } else {
                calendar.removeInvitation(parsed.uid, externalOwnerId(organizerEmail));
            }
        } else if (method === 'REPLY') {
            // Find the organizer's own MASTER (not a linked copy) by UID. Exceptions share the uid and
            // also lack data.organizer, so a REPLY must never bind to an exception row directly.
            const ownerEvent = calendar.getEventsByUid(parsed.uid).find((e) => !e.data?.organizer && !e.parentEventId);
            if (ownerEvent && parsed.data?.attendees) {
                for (const attendee of parsed.data.attendees) {
                    // A REPLY may only set the PARTSTAT of the attendee who actually sent it.
                    if (!sentBy(attendee.email)) continue;
                    if (parsed.recurrenceDate) {
                        // An attendee replying to ONE occurrence: land the PARTSTAT on that instance's
                        // exception — updateAttendeeStatus would mark them for the whole series.
                        // rsvpForOccurrence self-guards on membership (exception-aware: someone can be
                        // invited to a single occurrence only) and, with restoreCancelled=false, never
                        // resurrects an occurrence the organizer deleted.
                        calendar.rsvpForOccurrence(
                            ownerEvent.id,
                            attendee.email,
                            attendee.status,
                            parsed.recurrenceDate,
                            parsed.recurrenceInstant,
                            false,
                        );
                    } else {
                        // Skip uninvited senders so a forged REPLY can't churn rows on the master.
                        const invited = ownerEvent.data?.attendees?.some(
                            (a) => a.email.toLowerCase() === attendee.email.toLowerCase(),
                        );
                        if (!invited) continue;
                        calendar.updateAttendeeStatus(ownerEvent.id, attendee.email, attendee.status);
                    }
                }
            }
        }
    }
}
