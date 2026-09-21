import { cn } from '@workspace/ui/lib/utils';

export type EventPillVariant = 'block' | 'dot';

// Invite-status / free-busy state classes shared by the MonthView and WeekView event pills; each
// pill's base layout classes stay inline. Filled all-day pills ('block') dim and hover as a whole
// and get a dashed border while an invite is pending; timed pills ('dot') hover the row and carry
// the pending ring on their color dot instead, so 'dot' has no container-level pending class.
export function eventPillStateClasses(
    variant: EventPillVariant,
    freeBusy: boolean,
    inviteStatus: 'pending' | 'declined' | null,
): string {
    return cn(
        freeBusy
            ? 'opacity-50 cursor-default'
            : variant === 'block'
              ? 'cursor-pointer hover:opacity-80'
              : 'cursor-pointer hover:bg-accent',
        variant === 'block' &&
            inviteStatus === 'pending' &&
            'border border-dashed border-current bg-transparent !text-foreground',
        inviteStatus === 'declined' && 'opacity-40',
    );
}

// All-day events store midnight-UTC bounds with an exclusive end (day after the last day); timed events keep
// the local wall time. See CALENDAR.md § All-Day Events.
export function buildEventTimes(
    allDay: boolean,
    startDate: string,
    endDate: string,
    startTime: string,
    endTime: string,
): { start: Date; end: Date } {
    if (allDay) {
        const start = new Date(`${startDate}T00:00:00Z`);
        const end = new Date(`${endDate}T00:00:00Z`);
        end.setUTCDate(end.getUTCDate() + 1);
        return { start, end };
    }
    return { start: new Date(`${startDate}T${startTime}`), end: new Date(`${endDate}T${endTime}`) };
}
