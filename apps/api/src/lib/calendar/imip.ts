// iMIP, the way calendar invitations travel by email. Calendar saves, such as an organizer inviting guests or a guest
// answering, mail through it: an invitation, a cancellation or an RSVP reply, with the calendar file attached. Mail
// delivery hands it each calendar part that arrives, acted on only when our MTA verified the sender, and only for a
// message's first events.

import {
    formatEventWhen,
    isInvitationFromOthers,
    normalizeTimezone,
    rruleToText,
} from '@workspace/lib/calendar/calendar-utils';
import { escapeHtml } from '@workspace/lib/html';
import type { Attendee, CalendarEvent, ImipMethod, Organizer } from '@workspace/lib/types/calendar';
import type { AddressObject, Attachment, CalendarInvite } from '@workspace/lib/types/mail';
import { isCalendarPart } from '@workspace/lib/types/mail';
import { externalOwnerId } from '@workspace/lib/types/owner';
import type { Home } from '../home';
import { parseIcs, serializeEventForImip } from '../ical';
import type { EventToBuild } from '../ical/ical-component';
import { computeOccurrenceTimes } from '../ical/wall-clock';
import { EMAIL_MUTED, EMAIL_TEXT, renderEigenEmail } from '../mailer/mail-template';
import type { OutboundICalEvent, OutboundMail } from '../mailer/mailer';

// Above this a body is a mailed calendar export, not a scheduling message.
const IMIP_MAX_EVENTS = 50;

// A REPLY's date counts only when the rule yields it, and checking that expands the series from its start to that
// date, so a REPLY answers this many.
const IMIP_MAX_REPLY_DATES = 5;

// A scheduling message is small, far below what a saved event may hold.
const IMIP_MAX_BYTES = 1_048_576;

const STATUS_LABELS: Record<Attendee['status'], string> = {
    accepted: 'Accepted',
    declined: 'Declined',
    tentative: 'Tentatively accepted',
    pending: 'Pending',
};

// The calendar file of one save's invitation mails. Nothing in it differs per guest, and its size is guests ×
// exceptions, so a save builds it once.
export function composeInviteRequest(
    event: CalendarEvent,
    organizer: Organizer,
    series?: CalendarEvent,
    exceptions: readonly CalendarEvent[] = [],
): OutboundICalEvent {
    return icalEvent(
        withOrganizer(event, organizer),
        'REQUEST',
        series,
        exceptions.map((e) => withOrganizer(e, organizer)),
    );
}

export function composeInviteEmail(
    event: CalendarEvent,
    organizer: Organizer,
    attendees: readonly Attendee[],
    request?: OutboundICalEvent,
    updated = false,
): OutboundMail {
    const footer = `Invitation from ${organizer.name || organizer.email}`;
    return {
        from: { name: organizer.name ?? '', address: organizer.email },
        to: attendees.map((a) => ({ name: a.name ?? '', address: a.email })),
        subject: `${updated ? 'Updated invitation' : 'Invitation'}: ${event.title}`,
        text: buildEventSummary(event),
        html: buildEventHtml(event, footer, updated ? 'This event has been updated' : undefined),
        icalEvent: request,
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
        // RFC 5546 § 3.2.5: a CANCEL lists the attendees it cancels, and neither a cancelled occurrence nor a removal
        // holds them.
        icalEvent: icalEvent(
            { ...event, status: 'cancelled', data: { ...event.data, organizer, attendees } },
            'CANCEL',
            series,
        ),
    };
}

// `event` names its occurrence by the instant its stored file holds, which a copy of one date can't compute.
export function composeRsvpReply(
    event: EventToBuild,
    attendeeEmail: string,
    attendeeName: string,
    status: Attendee['status'],
    recurrenceDate?: string,
): OutboundMail {
    const organizer = event.data?.organizer;
    if (!organizer) throw new Error('Event has no organizer');

    // A scope:'this' RSVP carries a RECURRENCE-ID (RFC 5546), so the organizer applies the PARTSTAT to that instance
    // alone.
    const replyEvent: EventToBuild = {
        ...event,
        ...(recurrenceDate && { rrule: null, recurrenceDate, ...computeOccurrenceTimes(event, recurrenceDate) }),
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
        text: `${attendeeName} has ${statusLabel} the invitation:\n\n${buildEventSummary(replyEvent)}`,
        html: buildEventHtml(
            replyEvent,
            `Reply from ${attendeeName}`,
            `${escapeHtml(attendeeName)} has ${statusLabel} the invitation`,
        ),
        icalEvent: icalEvent(replyEvent, 'REPLY'),
    };
}

// Null for a part nobody can read, too large or unparseable: the mail widget renders that as an explicit error state.
export function summarizeCalendarInvite(attachment: Attachment): CalendarInvite | null {
    const cal = extractCalendarAttachment({ attachments: [attachment] });
    if (!cal) return null;
    try {
        const { events, method } = parseIcs(cal.ics);
        const event = events[0];
        if (!event) return null;
        const organizer = event.data?.organizer;
        return {
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

// Every mutation below binds to `From:`, trustworthy only where our MTA recorded an aligned DKIM pass.
export async function processInboundImip(
    home: Home,
    mail: { attachments: readonly Attachment[]; from?: AddressObject },
    verdict: { verified: boolean; reason: string },
): Promise<void> {
    const calAttachment = extractCalendarAttachment(mail);
    if (!calAttachment) return;

    const sender = mail.from?.value?.[0]?.address?.toLowerCase() ?? null;
    if (!sender || !verdict.verified) {
        console.info(`iMIP: not acting on mail from ${sender ?? 'unknown sender'} — ${verdict.reason}`);
        return;
    }

    const { events, method: parsedMethod, skipped } = parseIcs(calAttachment.ics);
    if (skipped > 0) console.info(`iMIP: skipped ${skipped} unreadable events from ${sender}`);
    const method = parsedMethod ?? calAttachment.method;
    if (!method || events.length === 0) return;

    // The user's own mail coming back. Acting on it would make their own event somebody else's copy, so every CalDAV
    // PUT could change only its alarms.
    if (method !== 'REPLY' && sender === home.user.email.toLowerCase()) {
        console.info(`iMIP: not acting on a ${method} the recipient sent themselves (${sender})`);
        return;
    }

    const sentBy = (email: string | undefined): email is string => email?.toLowerCase() === sender;

    const calendar = home.calendar;

    if (events.length > IMIP_MAX_EVENTS) {
        console.info(`iMIP: acting on the first ${IMIP_MAX_EVENTS} of ${events.length} events from ${sender}`);
    }
    const acted = events.slice(0, IMIP_MAX_EVENTS);
    for (const parsed of acted) {
        if (parsed.endTime < parsed.startTime) parsed.endTime = parsed.startTime;
    }

    if (method === 'REQUEST') {
        // A mail may carry several series, and each is one REQUEST: its master and occurrences take one decision.
        const organizerUserId = externalOwnerId(sender);
        for (const [uid, requested] of Map.groupBy(acted, (parsed) => parsed.uid)) {
            await calendar.receiveRequest(requested, {
                organizerEmail: sender,
                organizerEventId: uid,
                organizerUserId,
                createByUserId: organizerUserId,
            });
        }
        return;
    }

    // A series' answer is its sender's answer on every date, so the master goes first and a date's own answer after it.
    const ordered =
        method === 'REPLY' ? acted.toSorted((a, b) => Number(!!a.recurrenceDate) - Number(!!b.recurrenceDate)) : acted;
    let replyDates = 0;
    for (const parsed of ordered) {
        const { recurrenceDate } = parsed;
        if (method === 'CANCEL') {
            const organizerEmail = parsed.data?.organizer?.email;
            if (!sentBy(organizerEmail)) continue;
            const organizerUserId = externalOwnerId(organizerEmail);
            if (recurrenceDate) {
                await calendar.cancelInvitationOccurrence(parsed.uid, organizerUserId, { ...parsed, recurrenceDate });
            } else {
                await calendar.removeInvitation(parsed.uid, organizerUserId);
            }
        } else if (method === 'REPLY') {
            if (recurrenceDate && ++replyDates > IMIP_MAX_REPLY_DATES) continue;
            // A sender answers for themselves alone, once: a later listing of the same address says nothing more.
            const attendee = parsed.data?.attendees?.find((a) => sentBy(a.email));
            if (!attendee) continue;
            // Exceptions share the UID, so a REPLY binds to the organizer's own master and never to an exception row.
            const ownerEvent = (await calendar.getEventsByUid(parsed.uid)).find(
                (e) => !isInvitationFromOthers(e, home.user.email) && !e.parentEventId,
            );
            if (!ownerEvent) continue;
            if (recurrenceDate) {
                await calendar.receiveRsvpForOccurrence(ownerEvent.id, attendee.email, attendee.status, {
                    ...parsed,
                    recurrenceDate,
                });
            } else if (ownerEvent.data?.attendees?.some((a) => a.email.toLowerCase() === sender)) {
                await calendar.receiveAttendeeStatus(ownerEvent.id, attendee.email, attendee.status);
            }
        }
    }
}

function withOrganizer(event: CalendarEvent, organizer: Organizer): CalendarEvent {
    return { ...event, data: { ...event.data, organizer } };
}

// `series` makes the body name its occurrence with a RECURRENCE-ID, or it would read as a message about the whole
// series. A master's `exceptions` ride beside it.
function icalEvent(
    event: EventToBuild,
    method: 'REQUEST' | 'REPLY' | 'CANCEL',
    series?: CalendarEvent,
    exceptions?: readonly CalendarEvent[],
): OutboundICalEvent {
    return { method, content: serializeEventForImip(event, method, series, exceptions) };
}

function buildEventSummary(event: CalendarEvent): string {
    const repeats = rruleToText(event.rrule, event.timezone);
    const lines = [`What: ${event.title}`, `When: ${buildEventWhen(event)}`];
    if (repeats) lines.push(`Repeats: ${repeats}`);
    if (event.location) lines.push(`Where: ${event.location}`);
    if (event.description) lines.push(`Description: ${event.description}`);
    return lines.join('\n');
}

// Invitation mail has no viewer, so a timed event names the zone it renders in, UTC when it stores none rather than the
// server's.
function buildEventWhen(event: CalendarEvent): string {
    const timezone = normalizeTimezone(event.timezone) ?? 'UTC';
    const when = formatEventWhen(event.startTime, event.endTime, event.allDay, timezone, 'UTC');
    return event.allDay ? when : `${when} (${timezone})`;
}

function buildEventHtml(event: CalendarEvent, footerLine: string, banner?: string): string {
    const repeats = rruleToText(event.rrule, event.timezone);
    const sections = [buildSection('When', escapeHtml(buildEventWhen(event)))];
    if (repeats) sections.push(buildSection('Repeats', escapeHtml(repeats)));
    if (event.location) sections.push(buildSection('Where', escapeHtml(event.location)));
    if (event.description)
        sections.push(buildSection('Description', escapeHtml(event.description).replace(/\n/g, '<br>')));
    return renderEigenEmail({ title: event.title, bodyHtml: sections.join('\n'), banner, footerLine });
}

function buildSection(label: string, value: string): string {
    return `<div style="margin-bottom:16px">
      <div style="font-weight:600;font-size:13px;color:${EMAIL_MUTED};margin-bottom:4px">${label}</div>
      <div style="font-size:14px;color:${EMAIL_TEXT}">${value}</div>
    </div>`;
}

function extractCalendarAttachment(mail: { attachments: readonly Attachment[] }): {
    ics: string;
    method?: ImipMethod;
} | null {
    const attachment = mail.attachments.find(
        (part) => isCalendarPart(part) && part.content.byteLength <= IMIP_MAX_BYTES,
    );
    if (!attachment) return null;

    return { ics: Buffer.from(attachment.content).toString(), method: attachment.calendarMethod };
}
