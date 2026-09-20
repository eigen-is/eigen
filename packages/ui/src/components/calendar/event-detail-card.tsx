import { formatEventWhen, rruleToText, viewerTimeZone } from '@workspace/lib/calendar';
import type { Attendee, EventData } from '@workspace/lib/types/calendar';
import { AlignLeft, Clock, MapPin, Repeat, UsersRound } from 'lucide-react';
import { cn } from '../../lib/utils';
import { AttendeeList } from './attendee-list';

export type EventDetailCardProps = {
    // Omitted by a caller that already heads its own surface with it (the detail dialog's DialogTitle).
    title?: string;
    // Instants, so a payload that carries its bounds as strings converts once, where they enter.
    start: Date;
    end: Date;
    allDay: boolean;
    timezone?: string | null;
    rrule?: string | null;
    location?: string | null;
    description?: string | null;
    organizer?: EventData['organizer'] | null;
    attendees?: Attendee[];
    className?: string;
};

// One event as it reads when nobody is editing it: a stored occurrence in the calendar app's detail
// dialog, and an event an .ics file holds in its quick look. Data alone — the surface around it owns
// RSVP, edit and delete.
export function EventDetailCard({
    title,
    start,
    end,
    allDay,
    timezone,
    rrule,
    location,
    description,
    organizer,
    attendees = [],
    className,
}: EventDetailCardProps) {
    const recurrenceText = rruleToText(rrule ?? null);

    return (
        <div className={cn('space-y-3', className)}>
            {title && <h3 className="text-lg font-medium">{title}</h3>}

            <div className="flex items-start gap-3 text-sm">
                <Clock className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                <div>
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
                    <span className="capitalize">{recurrenceText}</span>
                </div>
            )}

            {location && (
                <div className="flex items-start gap-3 text-sm">
                    <MapPin className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                    <span>{location}</span>
                </div>
            )}

            {description && (
                <div className="flex items-start gap-3 text-sm">
                    <AlignLeft className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                    <span className="whitespace-pre-wrap">{description}</span>
                </div>
            )}

            {attendees.length > 0 && (
                <div className="flex items-start gap-3 text-sm">
                    <UsersRound className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                    <div className="flex-1">
                        <AttendeeList attendees={attendees} organizer={organizer} />
                    </div>
                </div>
            )}
        </div>
    );
}
