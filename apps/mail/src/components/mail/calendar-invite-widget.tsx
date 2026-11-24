// The card Mail draws under a message that carries a calendar invitation: the event's title, time, place and
// organizer, whether it was canceled or is an answer, and View in Calendar to open it there. The message view draws
// one per calendar attachment, from the summary the server read out of the file.

import { getCalendarAppUrl } from '@workspace/lib/api';
import { calendarEventLink, formatEventWhen, viewerTimeZone } from '@workspace/lib/calendar';
import type { CalendarInvite } from '@workspace/lib/types/mail';
import { Button } from '@workspace/ui/components/button';
import { cn } from '@workspace/ui/lib/utils';
import { Calendar } from 'lucide-react';

type CalendarInviteWidgetProps = {
    // null when the server could not read the file, undefined when the payload has no summary; both draw the error card.
    invite: CalendarInvite | null | undefined;
};

export function CalendarInviteWidget({ invite }: CalendarInviteWidgetProps) {
    if (!invite) {
        return (
            <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                <Calendar className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
                <p className="text-sm text-muted-foreground">This calendar invitation could not be read.</p>
            </div>
        );
    }

    const isCancelled = invite.method === 'CANCEL';
    const isReply = invite.method === 'REPLY';
    const organizer = invite.organizer
        ? invite.organizer.name
            ? `${invite.organizer.name} <${invite.organizer.email}>`
            : invite.organizer.email
        : null;

    return (
        <div
            className={cn(
                'flex items-start gap-3 rounded-lg border p-4',
                isCancelled ? 'border-destructive/30 bg-destructive/5' : 'border-primary/30 bg-primary/5',
            )}
        >
            <Calendar className={cn('mt-0.5 h-5 w-5 shrink-0', isCancelled ? 'text-destructive' : 'text-primary')} />
            <div className="flex-1 min-w-0 space-y-1">
                {isCancelled && <p className="text-sm font-medium text-destructive">This event has been canceled</p>}
                {isReply && <p className="text-sm font-medium text-muted-foreground">Calendar RSVP response</p>}
                {invite.summary && (
                    <p className={cn('text-sm font-medium', isCancelled && 'line-through text-muted-foreground')}>
                        {invite.summary}
                    </p>
                )}
                <p className="text-xs text-muted-foreground">
                    {formatEventWhen(
                        invite.startTime,
                        invite.endTime,
                        invite.allDay,
                        invite.timezone,
                        viewerTimeZone(),
                    )}
                </p>
                {invite.location && <p className="text-xs text-muted-foreground">{invite.location}</p>}
                {organizer && <p className="text-xs text-muted-foreground">Organizer: {organizer}</p>}
            </div>
            <Button variant="outline" size="sm" className="shrink-0" asChild>
                <a
                    href={
                        invite.uid
                            ? calendarEventLink({ date: invite.startTime, eventId: invite.uid })
                            : getCalendarAppUrl()
                    }
                >
                    View in Calendar
                </a>
            </Button>
        </div>
    );
}
