import { formatEventWhen, isInvitationFromOthers, normalizeTimezone } from '@workspace/lib/calendar/calendar-utils';
import { escapeHtml } from '@workspace/lib/html';
import type { Attendee, CalendarEvent, EventData, ImipMethod } from '@workspace/lib/types/calendar';
import { type AddressObject, type Attachment, type CalendarInvite, isCalendarPart } from '@workspace/lib/types/mail';
import { externalOwnerId } from '@workspace/lib/types/owner';
import { EMAIL_MUTED, EMAIL_TEXT, renderEigenEmail } from '../core/mail-template';
import { type OutboundICalEvent, type OutboundMail, onBehalfOf } from '../core/mailer';
import type { Home } from '../home';
import { parseIcs, serializeEventForImip } from '../ical';
import { computeOccurrenceTimes } from '../ical/wall-clock';

type Organizer = NonNullable<EventData['organizer']>;

// Above this a body is a mailed calendar export, not a scheduling message, and it does not get to write a Home once per VEVENT.
export const IMIP_MAX_EVENTS = 50;

// Invitation mail has no viewer, so an event with no stored zone renders in UTC and says so instead of borrowing the server's.
function buildEventWhen(event: CalendarEvent): string {
    const timezone = normalizeTimezone(event.timezone);
    const when = formatEventWhen(event.startTime, event.endTime, event.allDay, timezone, 'UTC');
    return timezone || event.allDay ? when : `${when} (UTC)`;
}

function buildEventSummary(event: CalendarEvent): string {
    const when = buildEventWhen(event);
    const lines: string[] = [];
    lines.push(`What: ${event.title}`);
    lines.push(`When: ${when}`);
    if (event.location) lines.push(`Where: ${event.location}`);
    if (event.description) lines.push(`Description: ${event.description}`);
    return lines.join('\n');
}

function buildSection(label: string, value: string): string {
    return `<div style="margin-bottom:16px">
      <div style="font-weight:600;font-size:13px;color:${EMAIL_MUTED};margin-bottom:4px">${label}</div>
      <div style="font-size:14px;color:${EMAIL_TEXT}">${value}</div>
    </div>`;
}

function buildEventBodyHtml(event: CalendarEvent): string {
    const sections: string[] = [];
    sections.push(buildSection('When', escapeHtml(buildEventWhen(event))));
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

// `series` lets the body name the occurrence it replaces (RECURRENCE-ID) instead of reading as a message about the whole series; a master's `exceptions` ride beside it.
function icalEvent(
    event: CalendarEvent,
    method: 'REQUEST' | 'REPLY' | 'CANCEL',
    series?: CalendarEvent,
    exceptions?: CalendarEvent[],
): OutboundICalEvent {
    return { method, content: serializeEventForImip(event, method, series, exceptions) };
}

export function composeInviteEmail(
    event: CalendarEvent,
    organizer: Organizer,
    attendees: Attendee[],
    series?: CalendarEvent,
    exceptions: CalendarEvent[] = [],
    updated = false,
): OutboundMail {
    const footer = `Invitation from ${organizer.name || organizer.email}`;
    return {
        ...onBehalfOf({ name: organizer.name ?? '', address: organizer.email }),
        to: attendees.map((a) => ({ name: a.name ?? '', address: a.email })),
        subject: `${updated ? 'Updated invitation' : 'Invitation'}: ${event.title}`,
        text: buildEventSummary(event),
        html: buildEventHtml(event, footer, updated ? 'This event has been updated' : undefined),
        icalEvent: icalEvent(
            withOrganizer(event, organizer),
            'REQUEST',
            series,
            exceptions.map((e) => withOrganizer(e, organizer)),
        ),
    };
}

export function composeCancelEmail(
    event: CalendarEvent,
    organizer: Organizer,
    attendees: Attendee[],
    series?: CalendarEvent,
): OutboundMail {
    const footer = `Invitation from ${organizer.name || organizer.email}`;
    return {
        ...onBehalfOf({ name: organizer.name ?? '', address: organizer.email }),
        to: attendees.map((a) => ({ name: a.name ?? '', address: a.email })),
        subject: `Canceled: ${event.title}`,
        text: `This event has been canceled:\n\n${buildEventSummary(event)}`,
        html: buildEventHtml(event, footer, 'This event has been canceled'),
        icalEvent: icalEvent(withOrganizer(event, organizer), 'CANCEL', series),
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

    // A scope:'this' RSVP carries a RECURRENCE-ID (RFC 5546) so the organizer applies the PARTSTAT to that instance alone.
    if (recurrenceDate) {
        const { startTime, endTime } = computeOccurrenceTimes(event, recurrenceDate);
        replyEvent.rrule = null;
        replyEvent.recurrenceDate = recurrenceDate;
        replyEvent.startTime = startTime;
        replyEvent.endTime = endTime;
    }

    const statusLabel = STATUS_LABELS[status].toLowerCase();
    return {
        ...onBehalfOf({ name: attendeeName, address: attendeeEmail }),
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

function extractCalendarAttachment(mail: { attachments: Attachment[] }): { ics: string; method?: ImipMethod } | null {
    const attachment = mail.attachments.find(isCalendarPart);
    if (!attachment) return null;

    return { ics: Buffer.from(attachment.content).toString(), method: attachment.calendarMethod };
}

// Null for unparseable ICS: the mail widget renders that as an explicit error state.
export function summarizeCalendarInvite(attachment: Attachment): CalendarInvite | null {
    const cal = extractCalendarAttachment({ attachments: [attachment] });
    if (!cal) return null;
    try {
        const { events, method } = parseIcs(cal.ics);
        const event = events[0];
        if (!event) return null;
        const organizer = event.data?.organizer;
        return {
            // A bare event .ics with no METHOD anywhere still renders as an invitation card.
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

// Every mutation below binds to `From:`, trustworthy only where our MTA recorded an aligned DKIM pass (mail-domain.ts).
export async function processInboundImip(
    home: Home,
    mail: { attachments: Attachment[]; from?: AddressObject },
    verdict: { verified: boolean; reason: string },
): Promise<void> {
    const calAttachment = extractCalendarAttachment(mail);
    if (!calAttachment) return;

    const { events, method: parsedMethod } = parseIcs(calAttachment.ics);
    const method = parsedMethod ?? calAttachment.method;
    if (!method || events.length === 0) return;

    const sender = mail.from?.value?.[0]?.address?.toLowerCase() ?? null;
    if (!sender || !verdict.verified) {
        console.info(`iMIP: not acting on ${method} from ${sender ?? 'unknown sender'} — ${verdict.reason}`);
        return;
    }

    // The user's own mail coming back: acting on it would seize their own event as somebody else's copy, reducing every CalDAV PUT to alarms.
    if (method !== 'REPLY' && sender === home.user.email.toLowerCase()) {
        console.info(`iMIP: not acting on a ${method} the recipient sent themselves (${sender})`);
        return;
    }

    const sentBy = (email: string | undefined): email is string => !!sender && email?.toLowerCase() === sender;

    const calendar = home.calendar;

    if (events.length > IMIP_MAX_EVENTS) {
        console.info(`iMIP: acting on the first ${IMIP_MAX_EVENTS} of ${events.length} events from ${sender}`);
    }

    for (const parsed of events.slice(0, IMIP_MAX_EVENTS)) {
        // iMIP is fire-and-forget with no 400 to return, so a reversed interval clamps to zero duration rather than dropping the invitation.
        if (parsed.endTime < parsed.startTime) parsed.endTime = parsed.startTime;

        if (method === 'REQUEST') {
            // One locked decision: Postfix delivers concurrently, and two deliveries would otherwise file two masters for one UID.
            await calendar.receiveImipRequest(parsed, sender);
        } else if (method === 'CANCEL') {
            // CANCEL is an organizer action too — same sender binding as REQUEST.
            const organizerEmail = parsed.data?.organizer?.email;
            if (!sentBy(organizerEmail)) continue;
            if (parsed.recurrenceDate) {
                // One instance only: removeInvitation would delete the attendee's whole linked series.
                await calendar.cancelInvitationOccurrence(
                    parsed.uid,
                    externalOwnerId(organizerEmail),
                    parsed.recurrenceDate,
                    parsed.recurrenceInstant,
                    parsed,
                );
            } else {
                await calendar.removeInvitation(parsed.uid, externalOwnerId(organizerEmail));
            }
        } else if (method === 'REPLY') {
            // Exceptions share the UID, so a REPLY binds to the organizer's own master and never to an exception row.
            const ownerEvent = (await calendar.getEventsByUid(parsed.uid)).find(
                (e) => !isInvitationFromOthers(e, home.user.email) && !e.parentEventId,
            );
            if (ownerEvent && parsed.data?.attendees) {
                for (const attendee of parsed.data.attendees) {
                    // A REPLY may only set the PARTSTAT of the attendee who actually sent it.
                    if (!sentBy(attendee.email)) continue;
                    if (parsed.recurrenceDate) {
                        // The PARTSTAT lands on that instance's exception, and restoreCancelled=false keeps it from resurrecting an occurrence the organizer deleted.
                        await calendar.receiveRsvpForOccurrence(
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
                        await calendar.receiveAttendeeStatus(ownerEvent.id, attendee.email, attendee.status);
                    }
                }
            }
        }
    }
}
