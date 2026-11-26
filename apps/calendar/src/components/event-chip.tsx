// How the calendar views draw one event. EventSurface is the event on its calendar's color with its state over it, such
// as a past event dimmed; the time grid's blocks are one. EventBar spans an event across its days in a row of lanes,
// such as a month week. EventChip is one day's event, a timed one as a dot, its time and its title. LaneGhost is the
// event a drag carries over a lane. A click hands the event to the view, a press may start a drag, and the event the
// detail column shows carries a ring in its calendar's color. The "N more" of a full day shares the classes here too.

import { useAuth } from '@workspace/lib/auth';
import type { LaneBar } from '@workspace/lib/calendar';
import { formatEventTime, inAllDayLane } from '@workspace/lib/calendar';
import { indicatorColor } from '@workspace/lib/constants/colors';
import type { CalendarEventOccurrence, CalendarItem, SharedCalendar } from '@workspace/lib/types/calendar';
import { colorSurface } from '@workspace/ui/lib/color-surface';
import { cn } from '@workspace/ui/lib/utils';
import type { CSSProperties, ReactNode } from 'react';
import { eventState, eventSurfaceClasses, occurrenceKey } from './calendar-utils';

export type EventSurfaceProps = {
    calendars: readonly CalendarItem[];
    sharedCalendars: readonly SharedCalendar[];
    onClick: (event: CalendarEventOccurrence, e: React.MouseEvent) => void;
    onDragStart?: (event: CalendarEventOccurrence, e: React.PointerEvent<HTMLElement>) => void;
    // The occurrenceKey of the event the detail column shows.
    openKey: string | undefined;
};

type PlacedEventProps = EventSurfaceProps & {
    event: CalendarEventOccurrence;
    className?: string;
    style?: CSSProperties;
};

// Dark mode draws a 2px color stripe at the left edge, so the text starts further in.
export const STRIPE_INSET = 'dark:pl-2';

export const MORE_BUTTON =
    'mx-0.5 truncate px-1.5 text-left text-xs font-medium leading-5 text-muted-foreground hover:bg-accent';

const BAR = cn('truncate px-1.5 py-0.5 font-medium', STRIPE_INSET);

// Tailwind draws a ring as a shadow of its own, which adds to the block's, so the open event keeps its shadow.
export function openRing(key: string, openKey: string | undefined): string | false {
    return key === openKey && 'ring-2 ring-(--surface-indicator)';
}

export function EventSurface({
    event,
    calendars,
    sharedCalendars,
    onClick,
    onDragStart,
    openKey,
    className,
    style,
    children,
}: PlacedEventProps & { children: ReactNode }) {
    const { user } = useAuth();
    const state = eventState(event, calendars, sharedCalendars, user?.email);
    const surface = colorSurface(state.color, 'tile');
    const key = occurrenceKey(event);
    return (
        <button
            type="button"
            className={cn(
                'eigen-block overflow-hidden text-left text-xs leading-4',
                surface.className,
                className,
                eventSurfaceClasses('block', state),
                openRing(key, openKey),
            )}
            style={{ ...surface.style, ...style }}
            data-focus-key={key}
            onClick={(e) => onClick(event, e)}
            onPointerDown={onDragStart && ((e) => onDragStart(event, e))}
            title={event.title}
        >
            {children}
        </button>
    );
}

export function EventBar({ bar, ...surfaceProps }: { bar: LaneBar } & EventSurfaceProps) {
    const style = { gridRow: bar.lane + 1, gridColumn: `${bar.start + 1} / span ${bar.span}` };
    if (bar.span === 1 && !bar.continuesBefore && !bar.continuesAfter) {
        return <EventChip event={bar.event} {...surfaceProps} className="mx-0.5" style={style} />;
    }
    return (
        <EventSurface
            event={bar.event}
            {...surfaceProps}
            className={cn('mx-0.5', BAR, bar.continuesBefore && 'ml-0', bar.continuesAfter && 'mr-0')}
            style={style}
        >
            {bar.event.title}
        </EventSurface>
    );
}

// A narrow chip, such as a month day on a phone, drops the time so the title still shows.
export function EventChip({ className, ...props }: PlacedEventProps) {
    const { user } = useAuth();
    const { event, calendars, sharedCalendars, onClick, onDragStart, openKey, style } = props;
    if (inAllDayLane(event)) {
        return (
            <EventSurface {...props} className={cn(BAR, className)}>
                {event.title}
            </EventSurface>
        );
    }
    const state = eventState(event, calendars, sharedCalendars, user?.email);
    const key = occurrenceKey(event);
    return (
        <button
            type="button"
            className={cn(
                '@container flex items-center gap-1 overflow-hidden whitespace-nowrap px-0.5 py-0.5 text-left text-xs leading-4',
                eventSurfaceClasses('dot', state),
                className,
                openRing(key, openKey),
            )}
            style={{ ...style, '--surface-indicator': indicatorColor(state.color) }}
            data-focus-key={key}
            onClick={(e) => onClick(event, e)}
            onPointerDown={onDragStart && ((e) => onDragStart(event, e))}
            title={event.title}
        >
            <EventDot color={state.color} pending={state.inviteStatus === 'pending'} className="h-1.5 w-1.5" />
            <span className="shrink-0 text-muted-foreground tabular-nums @max-[6rem]:hidden">
                {formatEventTime(event)}
            </span>
            <span className="truncate">{event.title}</span>
        </button>
    );
}

// A pending invitation is a ring, not yet a filled dot.
export function EventDot({ color, pending, className }: { color: string; pending: boolean; className: string }) {
    return (
        <span
            className={cn('shrink-0 rounded-full', pending ? 'ring-1 ring-current' : 'bg-current', className)}
            style={{ color: indicatorColor(color) }}
        />
    );
}

// Drawn over the first lane of the days the event would land on, on the page's background so the lane under it can't
// show through a chip.
export function LaneGhost({ bar, ...surfaceProps }: { bar: LaneBar } & EventSurfaceProps) {
    return (
        <div
            className="eigen-block pointer-events-none mx-0.5 bg-background"
            style={{ gridRow: 1, gridColumn: `${bar.start + 1} / span ${bar.span}` }}
        >
            <EventChip event={bar.event} {...surfaceProps} className="w-full" />
        </div>
    );
}
