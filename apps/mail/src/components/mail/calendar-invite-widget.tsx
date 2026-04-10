import { getCalendarAppUrl, getMailAttachmentUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { getMonthRange } from '@workspace/lib/calendar';
import { formatDateTime } from '@workspace/lib/date';
import type { Attachment } from '@workspace/lib/types/mail';
import { Button } from '@workspace/ui/components/button';
import { cn } from '@workspace/ui/lib/utils';
import { Calendar, ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';

type IcsEventSummary = {
    uid: string;
    summary: string;
    dtstart: string;
    dtend: string;
    location: string;
    organizer: string;
};

function parseIcsField(ics: string, field: string): string {
    // Handle both simple fields (SUMMARY:value) and fields with params (ORGANIZER;CN=Name:mailto:...)
    const regex = new RegExp(`^${field}[;:](.*)$`, 'm');
    const match = ics.match(regex);
    if (!match) return '';

    let value = match[1];

    // For fields with params like ORGANIZER;CN=Name:mailto:email, extract meaningful parts
    if (field === 'ORGANIZER') {
        const cnMatch = value.match(/CN=([^;:]+)/);
        const mailtoMatch = value.match(/mailto:(.+)/i);
        if (cnMatch && mailtoMatch) return `${cnMatch[1]} <${mailtoMatch[1]}>`;
        if (mailtoMatch) return mailtoMatch[1];
        if (cnMatch) return cnMatch[1];
    }

    // For DTSTART/DTEND with params like DTSTART;TZID=...:20250101T120000
    if (value.includes(':')) {
        value = value.split(':').pop() || value;
    }

    return value.trim();
}

function formatIcsDate(raw: string): string {
    if (!raw) return '';
    const date = icsDateToDate(raw);
    return date ? formatDateTime(date) : raw;
}

function parseIcs(ics: string): IcsEventSummary {
    return {
        uid: parseIcsField(ics, 'UID'),
        summary: parseIcsField(ics, 'SUMMARY'),
        dtstart: parseIcsField(ics, 'DTSTART'),
        dtend: parseIcsField(ics, 'DTEND'),
        location: parseIcsField(ics, 'LOCATION'),
        organizer: parseIcsField(ics, 'ORGANIZER'),
    };
}

function buildCalendarLink(event: IcsEventSummary): string {
    if (!event.dtstart || !event.uid) return getCalendarAppUrl();

    const date = icsDateToDate(event.dtstart);
    if (!date) return getCalendarAppUrl();

    const { from, to } = getMonthRange(date);
    return getCalendarAppUrl(`view/month/${from}/${to}?eventId=${encodeURIComponent(event.uid)}`);
}

function icsDateToDate(raw: string): Date | null {
    const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
    if (!match) return null;
    const [, y, mo, d, h, mi, s] = match;
    return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${raw.endsWith('Z') ? 'Z' : ''}`);
}

type CalendarInviteWidgetProps = {
    attachment: Attachment;
    emailId: string;
    attachmentIndex: number;
};

export function CalendarInviteWidget({ attachment, emailId, attachmentIndex }: CalendarInviteWidgetProps) {
    const { user } = useAuth();
    const [event, setEvent] = useState<IcsEventSummary | null>(null);

    const method = attachment.calendarMethod ?? 'REQUEST';

    useEffect(() => {
        if (!user) return;
        const url = getMailAttachmentUrl(user.id, emailId, attachmentIndex, attachment.filename || 'invite.ics');
        fetch(url, { credentials: 'include' })
            .then((r) => r.text())
            .then((text) => setEvent(parseIcs(text)))
            .catch(() => {});
    }, [user, emailId, attachmentIndex, attachment.filename]);

    if (!event) return null;

    const isCancelled = method === 'CANCEL';
    const isReply = method === 'REPLY';

    return (
        <div
            className={cn(
                'flex items-start gap-3 rounded-lg border p-4',
                isCancelled ? 'border-destructive/30 bg-destructive/5' : 'border-primary/30 bg-primary/5',
            )}
        >
            <Calendar className={cn('mt-0.5 h-5 w-5 shrink-0', isCancelled ? 'text-destructive' : 'text-primary')} />
            <div className="flex-1 min-w-0 space-y-1">
                {isCancelled && <p className="text-sm font-medium text-destructive">This event has been cancelled</p>}
                {isReply && <p className="text-sm font-medium text-muted-foreground">Calendar RSVP response</p>}
                {event.summary && (
                    <p className={cn('text-sm font-semibold', isCancelled && 'line-through text-muted-foreground')}>
                        {event.summary}
                    </p>
                )}
                {event.dtstart && (
                    <p className="text-xs text-muted-foreground">
                        {formatIcsDate(event.dtstart)}
                        {event.dtend ? ` \u2013 ${formatIcsDate(event.dtend)}` : ''}
                    </p>
                )}
                {event.location && <p className="text-xs text-muted-foreground">{event.location}</p>}
                {event.organizer && <p className="text-xs text-muted-foreground">Organizer: {event.organizer}</p>}
            </div>
            <Button variant="outline" size="sm" className="shrink-0" asChild>
                <a href={buildCalendarLink(event)} target="_blank" rel="noreferrer">
                    View in Calendar
                    <ExternalLink className="ml-1.5 h-3 w-3" />
                </a>
            </Button>
        </div>
    );
}
