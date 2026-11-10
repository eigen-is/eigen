// One event as it reads when nobody is editing it, such as a stored occurrence in the calendar's detail dialog or an
// event an .ics file holds in its quick look. It is data alone: the surface around it owns answering, editing and
// deleting.

import { formatEventWhen, rruleToText, viewerTimeZone } from '@workspace/lib/calendar';
import { remainingLine } from '@workspace/lib/transfer';
import type { Attendee, CalendarEvent, Organizer } from '@workspace/lib/types/calendar';
import { AlignLeft, Clock, MapPin, Repeat, UsersRound } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Badge } from '../badge';
import { AttendeeList } from './attendee-list';

// `title` is left out where the surface heads itself with it. `remainingAttendees` counts the guests a payload capped
// away.
export type EventDetailCardProps = {
    title?: string;
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
    className?: string;
};

export function EventDetailCard({
    title,
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
    className,
}: EventDetailCardProps) {
    const recurrence = rruleToText(rrule ?? null);
    // Sentence case here, not CSS `capitalize`, which title-cases every word of "every week on Sunday".
    const recurrenceText = recurrence && recurrence[0].toUpperCase() + recurrence.slice(1);
    const cancelled = status === 'cancelled';

    return (
        <div className={cn('space-y-3', className)}>
            {(title || cancelled) && (
                <div className="flex items-center gap-2">
                    {title && (
                        <h3 className={cn('text-lg font-medium min-w-0 break-words', cancelled && 'line-through')}>
                            {title}
                        </h3>
                    )}
                    {cancelled && <Badge variant="destructive">Canceled</Badge>}
                </div>
            )}

            <div className="flex items-start gap-3 text-sm">
                <Clock className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                <div className="min-w-0 break-words">
                    {formatEventWhen(start, end, allDay, timezone, viewerTimeZone())}
                    {timezone && (
                        <div className="text-xs text-muted-foreground">
                            {timezone.split('/').pop()?.replace(/_/g, ' ')} time zone
                        </div>
                    )}
                </div>
            </div>

            {recurrenceText && (
                <div className="flex items-start gap-3 text-sm">
                    <Repeat className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                    <span className="min-w-0 break-words">{recurrenceText}</span>
                </div>
            )}

            {location && (
                <div className="flex items-start gap-3 text-sm">
                    <MapPin className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                    <span className="min-w-0 break-words">{location}</span>
                </div>
            )}

            {description && (
                <div className="flex items-start gap-3 text-sm">
                    <AlignLeft className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                    <span className="min-w-0 whitespace-pre-wrap break-words">{description}</span>
                </div>
            )}

            {attendees.length > 0 && (
                <div className="flex items-start gap-3 text-sm">
                    <UsersRound className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                        <AttendeeList attendees={attendees} organizer={organizer} remaining={remainingAttendees} />
                        {remainingAttendees > 0 && (
                            <p className="mt-1 text-xs text-muted-foreground">
                                {remainingLine(remainingAttendees, 'guest')}
                            </p>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
