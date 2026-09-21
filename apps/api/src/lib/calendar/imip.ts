import { formatEventWhen, isInvitationFromOthers } from '@workspace/lib/calendar/calendar-utils';
import { escapeHtml } from '@workspace/lib/html';
import type { Attendee, CalendarEvent, EventData, ImipMethod } from '@workspace/lib/types/calendar';
import { type AddressObject, type Attachment, type CalendarInvite, isCalendarPart } from '@workspace/lib/types/mail';
import { externalOwnerId } from '@workspace/lib/types/owner';
import { getMailDomain } from '../config/server-config';
import { EMAIL_MUTED, EMAIL_TEXT, renderEigenEmail } from '../core/mail-template';
import type { OutboundICalEvent, OutboundMail } from '../core/mailer';
import type { Home } from '../home';
import { parseIcs, serializeEventForImip } from '../ical';
import { normalizeTimezone } from '../ical/timezone';
import { computeOccurrenceTimes } from '../ical/wall-clock';
import { verifyImipSender } from '../mail/imip-auth';

type Organizer = NonNullable<EventData['organizer']>;

// A scheduling message is about one meeting and the occurrences around it; a body carrying more than
// this is a calendar export somebody mailed, and it does not get to write a Home once per VEVENT.
export const IMIP_MAX_EVENTS = 50;

// Invitation mail has no viewer, so a timed event that stored no usable zone (CalDAV/iMIP import,
// API create) cannot borrow the browser's viewer zone or the server's own — either would name a wall
// clock nobody agreed to. It renders in UTC and labels it, so the recipient can convert.
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

// `series` is the master of an event that is one occurrence of it, so the body can name the occurrence
// it replaces (RECURRENCE-ID) instead of reading as a message about the whole series.
function icalEvent(
    event: CalendarEvent,
    method: 'REQUEST' | 'REPLY' | 'CANCEL',
    series?: CalendarEvent,
): OutboundICalEvent {
    return { method, content: serializeEventForImip(event, method, series) };
}

export function composeInviteEmail(
    event: CalendarEvent,
    organizer: Organizer,
    attendees: Attendee[],
    series?: CalendarEvent,
): OutboundMail {
    const footer = `Invitation from ${organizer.name || organizer.email}`;
    return {
        from: { name: organizer.name ?? '', address: organizer.email },
        to: attendees.map((a) => ({ name: a.name ?? '', address: a.email })),
        subject: `Invitation: ${event.title}`,
        text: buildEventSummary(event),
        html: buildEventHtml(event, footer),
        icalEvent: icalEvent(withOrganizer(event, organizer), 'REQUEST', series),
    };
}

export function composeUpdateEmail(
    event: CalendarEvent,
    organizer: Organizer,
    attendees: Attendee[],
    series?: CalendarEvent,
): OutboundMail {
    const footer = `Invitation from ${organizer.name || organizer.email}`;
    return {
        from: { name: organizer.name ?? '', address: organizer.email },
        to: attendees.map((a) => ({ name: a.name ?? '', address: a.email })),
        subject: `Updated invitation: ${event.title}`,
        text: buildEventSummary(event),
        html: buildEventHtml(event, footer, 'This event has been updated'),
        icalEvent: icalEvent(withOrganizer(event, organizer), 'REQUEST', series),
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
        from: { name: organizer.name ?? '', address: organizer.email },
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
    const attachment = mail.attachments.find(isCalendarPart);
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

export async function processInboundImip(
    home: Home,
    mail: { attachments: Attachment[]; from?: AddressObject; authenticationResults?: string[] },
): Promise<void> {
    const calAttachment = extractCalendarAttachment(mail);
    if (!calAttachment) return;

    const { events, method: parsedMethod } = parseIcs(calAttachment.ics);
    const method = parsedMethod ?? calAttachment.method;
    if (!method || events.length === 0) return;

    // Every mutation binds to `From:`, which is only trustworthy once our own MTA recorded an aligned
    // DKIM pass; otherwise fail closed and leave the invite as a plain attachment.
    const sender = mail.from?.value?.[0]?.address?.toLowerCase() ?? null;
    const verdict = verifyImipSender(mail.authenticationResults, getMailDomain(), sender?.split('@')[1] ?? null);
    if (!sender || !verdict.verified) {
        console.info(`iMIP: not acting on ${method} from ${sender ?? 'unknown sender'} — ${verdict.reason}`);
        return;
    }

    // An organizer action this Home's own address signed is the user's own mail coming back — an invitee
    // address that forwards to them, a list they are on. Acting on it would let them seize their own event
    // as somebody else's copy, after which every CalDAV PUT on it is reduced to alarms.
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
        // Untrusted external ICS: clamp a reversed interval to zero-duration rather than reject the whole
        // invite (mirrors the parser degrading a malformed rrule/tzid). iMIP is fire-and-forget email —
        // there's no synchronous 400 to return, so dropping the invitation would be worse for the user than
        // showing a zero-length event. The receive* writes bypass the createEvent/updateEvent guard, so this
        // is where the domain's interval invariant is enforced for the inbound path.
        if (parsed.endTime < parsed.startTime) parsed.endTime = parsed.startTime;

        if (method === 'REQUEST') {
            // Update, adopt or drop — one locked decision, because Postfix delivers concurrently and a
            // lookup outside the gate would let two deliveries file two masters for one UID.
            await calendar.receiveImipRequest(parsed, sender);
        } else if (method === 'CANCEL') {
            // CANCEL is an organizer action too — same sender binding as REQUEST.
            const organizerEmail = parsed.data?.organizer?.email;
            if (!sentBy(organizerEmail)) continue;
            if (parsed.recurrenceDate) {
                // Canceling one occurrence must cancel that instance only — removeInvitation would
                // delete the attendee's entire linked series (audit #B).
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
            // Find the organizer's own MASTER (not a linked copy) by UID. Exceptions share the uid, so a
            // REPLY must never bind to an exception row directly.
            const ownerEvent = (await calendar.getEventsByUid(parsed.uid)).find(
                (e) => !isInvitationFromOthers(e, home.user.email) && !e.parentEventId,
            );
            if (ownerEvent && parsed.data?.attendees) {
                for (const attendee of parsed.data.attendees) {
                    // A REPLY may only set the PARTSTAT of the attendee who actually sent it.
                    if (!sentBy(attendee.email)) continue;
                    if (parsed.recurrenceDate) {
                        // An attendee replying to ONE occurrence: land the PARTSTAT on that instance's
                        // exception — receiveAttendeeStatus would mark them for the whole series.
                        // receiveRsvpForOccurrence self-guards on membership (exception-aware: someone can be
                        // invited to a single occurrence only) and, with restoreCancelled=false, never
                        // resurrects an occurrence the organizer deleted.
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
