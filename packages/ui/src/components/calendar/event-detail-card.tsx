// One event as it reads when nobody is editing it, such as a stored occurrence in the calendar's detail dialog or an
// event an .ics file holds in its quick look: its block with its title and time, a meta line the surface may give,
// such as its calendar, then its place, guests and description, each under its caption. It is data alone: the surface
// around it owns answering, editing and deleting, and may add sections of its own, such as the reply to an invitation.

import { formatEventWhen, rruleToText, viewerTimeZone } from '@workspace/lib/calendar';
import { remainingLine } from '@workspace/lib/transfer';
import type { Attendee, CalendarEvent, Organizer } from '@workspace/lib/types/calendar';
import type { ReactNode } from 'react';
import { Badge } from '../badge';
import { DetailItemBlock, DetailMeta, DetailSection } from '../layout/app/detail-item';
import { AttendeeList } from './attendee-list';

// `remainingAttendees` counts the guests a payload capped away.
export type EventDetailCardProps = {
    title: string;
    // Its calendar's color. A file's event has none, and its block is muted.
    color?: string;
    status?: CalendarEvent['status'] | null;
    start: Date;
    end: Date;
    allDay: boolean;
    timezone?: string | null;
    rrule?: string | null;
    location?: string | null;
    description?: string | null;
    organizer?: Organizer | null;
    attendees?: Attendee[];
    remainingAttendees?: number;
    meta?: ReactNode;
    children?: ReactNode;
    className?: string;
};

export function EventDetailCard({
    title,
    color,
    status,
    start,
    end,
    allDay,
    timezone,
    rrule,
    location,
    description,
    organizer,
    attendees = [],
    remainingAttendees = 0,
    meta,
    children,
    className,
}: EventDetailCardProps) {
    const recurrenceText = rruleToText(rrule, timezone);

    return (
        <div className={className}>
            <DetailItemBlock title={title || '(No title)'} color={color}>
                {status === 'cancelled' && (
                    <Badge variant="destructive" className="mb-1">
                        Canceled
                    </Badge>
                )}
                <p className="break-words">{formatEventWhen(start, end, allDay, timezone, viewerTimeZone())}</p>
                {timezone && (
                    <p className="text-xs opacity-70">{timezone.split('/').pop()?.replace(/_/g, ' ')} time zone</p>
                )}
                {recurrenceText && <p className="text-xs opacity-70 break-words">{recurrenceText}</p>}
            </DetailItemBlock>

            {meta && <DetailMeta>{meta}</DetailMeta>}

            {location && (
                <DetailSection label="Location">
                    <p className="break-words">{location}</p>
                </DetailSection>
            )}

            {attendees.length > 0 && (
                <DetailSection label="Guests">
                    <AttendeeList attendees={attendees} organizer={organizer} remaining={remainingAttendees} />
                    {remainingAttendees > 0 && (
                        <p className="mt-1 text-xs text-muted-foreground">
                            {remainingLine(remainingAttendees, 'guest')}
                        </p>
                    )}
                </DetailSection>
            )}

            {description && (
                <DetailSection label="Description">
                    <p className="whitespace-pre-wrap break-words">{description}</p>
                </DetailSection>
            )}

            {children}
        </div>
    );
}
