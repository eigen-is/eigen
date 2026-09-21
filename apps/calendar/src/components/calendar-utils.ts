import { cn } from '@workspace/ui/lib/utils';

export type EventPillVariant = 'block' | 'dot';

// Shared by the MonthView and WeekView pills so both read a state the same way; their layout classes stay inline.
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

// All-day bounds are midnight UTC with an exclusive end (docs/CALENDAR.md § All-day events, intervals and zone-less rendering).
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
