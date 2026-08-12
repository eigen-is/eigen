import { getCalendarAppUrl } from '@workspace/lib/api';
import { getMonthRange } from '@workspace/lib/calendar';
import { formatEventWhen } from '@workspace/lib/date';
import type { CalendarInvite } from '@workspace/lib/types/mail';
import { Button } from '@workspace/ui/components/button';
import { cn } from '@workspace/ui/lib/utils';
import { Calendar, ExternalLink } from 'lucide-react';

function buildCalendarLink(invite: CalendarInvite): string {
    if (!invite.uid) return getCalendarAppUrl();
    const { from, to } = getMonthRange(invite.startTime);
    return getCalendarAppUrl(`view/month/${from}/${to}?eventId=${encodeURIComponent(invite.uid)}`);
}

type CalendarInviteWidgetProps = {
    // null/undefined = the server could not parse the attached ICS.
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
                {isCancelled && <p className="text-sm font-medium text-destructive">This event has been cancelled</p>}
                {isReply && <p className="text-sm font-medium text-muted-foreground">Calendar RSVP response</p>}
                {invite.summary && (
                    <p className={cn('text-sm font-medium', isCancelled && 'line-through text-muted-foreground')}>
                        {invite.summary}
                    </p>
                )}
                <p className="text-xs text-muted-foreground">
                    {formatEventWhen(invite.startTime, invite.endTime, invite.allDay, invite.timezone)}
                </p>
                {invite.location && <p className="text-xs text-muted-foreground">{invite.location}</p>}
                {organizer && <p className="text-xs text-muted-foreground">Organizer: {organizer}</p>}
            </div>
            <Button variant="outline" size="sm" className="shrink-0" asChild>
                <a href={buildCalendarLink(invite)} target="_blank" rel="noreferrer">
                    View in Calendar
                    <ExternalLink className="ml-1.5 h-3 w-3" />
                </a>
            </Button>
        </div>
    );
}
