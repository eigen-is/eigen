// The Calendar app's day, 3-day and week views: a column per day under its weekday and date, which link to that day
// alone, an all-day lane of bars that span their days, and a scrolling day of hours with each timed event as a block
// at its minutes, side by side where events overlap. A line marks the current time across today. A click on an event
// opens its detail dialog; the route around it picks the days and fetches the events.

import { Link } from '@tanstack/react-router';
import type { TimedBlock } from '@workspace/lib/calendar';
import {
    allocateLanes,
    inAllDayLane,
    layoutTimedEvents,
    monthWeekLayout,
    toLocalDateString,
    weekdayHeader,
} from '@workspace/lib/calendar';
import { formatTime } from '@workspace/lib/date';
import type { CalendarEventOccurrence, CalendarItem, SharedCalendar } from '@workspace/lib/types/calendar';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar';
import { cn } from '@workspace/ui/lib/utils';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { EventSurfaceProps } from './event-chip';
import { EventBar, EventSurface } from './event-chip';
import { EventDetailDialog } from './event-detail-dialog';
import { useEventDetailState } from './hooks/use-event-detail-state';

type TimeGridProps = {
    days: readonly Date[];
    events: readonly CalendarEventOccurrence[];
    calendars: readonly CalendarItem[];
    sharedCalendars?: readonly SharedCalendar[];
    initialEventId?: string;
};

const HOUR_HEIGHT = 48;
const MAX_ALL_DAY_LANES = 3;
const SCROLL_TO_HOUR = 7;
// A block's text lines are text-xs at leading-4, inside 2px of padding above and below.
const LINE_HEIGHT = 16;
const BLOCK_PADDING = 4;
const GUTTER = 'w-11 shrink-0 md:w-14';
const HOUR_LABELS = Array.from({ length: 24 }, (_, hour) => formatTime(new Date(2026, 0, 1, hour)));

export function TimeGrid({ days, events, calendars, sharedCalendars, initialEventId }: TimeGridProps) {
    const { handleEventClick, detailDialogProps } = useEventDetailState({
        events,
        calendars,
        sharedCalendars,
        initialEventId,
    });
    const [allDayExpanded, setAllDayExpanded] = useState(false);
    const [now, setNow] = useState(() => new Date());
    const scrollerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const timer = setInterval(() => setNow(new Date()), 60_000);
        return () => clearInterval(timer);
    }, []);

    useLayoutEffect(() => {
        const scroller = scrollerRef.current;
        if (!scroller) return;
        const current = new Date();
        const todayInView = days.some((day) => toLocalDateString(day) === toLocalDateString(current));
        scroller.scrollTop = (todayInView ? current.getHours() - 1 : SCROLL_TO_HOUR) * HOUR_HEIGHT;
    }, [days]);

    const allDayEvents = events.filter(inAllDayLane);
    const collapsedLanes = monthWeekLayout(days, allDayEvents, MAX_ALL_DAY_LANES);
    const lanesOverflow = collapsedLanes.hidden.some((count) => count > 0);
    const bars = allDayExpanded ? allocateLanes(allDayEvents, days) : collapsedLanes.bars;
    const blocks = layoutTimedEvents(events, days);

    const todayKey = toLocalDateString(now);
    const todayIndex = days.findIndex((day) => toLocalDateString(day) === todayKey);
    const nowTop = ((now.getHours() * 60 + now.getMinutes()) * HOUR_HEIGHT) / 60;
    const columns = { gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` };
    const surfaceProps = { calendars, sharedCalendars, onClick: handleEventClick };

    return (
        <>
            <div className="flex h-full flex-col">
                <div className="flex overflow-hidden border-b [scrollbar-gutter:stable]">
                    <div className={GUTTER} />
                    <div className="grid flex-1" style={columns}>
                        {days.map((day) => {
                            const key = toLocalDateString(day);
                            const today = key === todayKey;
                            return (
                                <Link
                                    key={key}
                                    to="/view/$mode/$date"
                                    params={{ mode: 'day', date: key }}
                                    className="group flex flex-col items-center py-1.5"
                                >
                                    <span
                                        className={cn(
                                            'text-xs font-medium text-muted-foreground',
                                            today && 'text-(--app-current-color)',
                                        )}
                                    >
                                        {weekdayHeader(day)}
                                    </span>
                                    <span
                                        className={cn(
                                            'mt-0.5 flex h-8 w-8 items-center justify-center rounded-full text-lg',
                                            today
                                                ? 'bg-(--app-current-color) text-background'
                                                : 'group-hover:bg-accent',
                                        )}
                                    >
                                        {day.getDate()}
                                    </span>
                                </Link>
                            );
                        })}
                    </div>
                </div>

                {allDayEvents.length > 0 && (
                    <div className="flex overflow-hidden border-b [scrollbar-gutter:stable]">
                        <div className={cn(GUTTER, 'flex justify-center')}>
                            {lanesOverflow && (
                                <TooltipButton
                                    icon={allDayExpanded ? ChevronUp : ChevronDown}
                                    tooltipText={allDayExpanded ? 'Show fewer' : 'Show all'}
                                    onClick={() => setAllDayExpanded(!allDayExpanded)}
                                    className="h-6 w-6"
                                />
                            )}
                        </div>
                        <div className="grid flex-1 gap-y-0.5 py-0.5" style={columns}>
                            {bars.map((bar) => (
                                <EventBar
                                    key={`${bar.event.id}-${bar.event.occurrenceDate}-${bar.start}`}
                                    bar={bar}
                                    {...surfaceProps}
                                />
                            ))}
                            {!allDayExpanded &&
                                collapsedLanes.hidden.map(
                                    (count, idx) =>
                                        count > 0 && (
                                            <button
                                                key={toLocalDateString(days[idx])}
                                                type="button"
                                                className="mx-0.5 truncate rounded px-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-accent"
                                                style={{ gridRow: MAX_ALL_DAY_LANES, gridColumn: idx + 1 }}
                                                onClick={() => setAllDayExpanded(true)}
                                            >
                                                {`${count} more`}
                                            </button>
                                        ),
                                )}
                        </div>
                    </div>
                )}

                <div ref={scrollerRef} className="flex-1 overflow-y-auto [scrollbar-gutter:stable]">
                    <div className="relative flex" style={{ height: 24 * HOUR_HEIGHT }}>
                        <div className={cn(GUTTER, 'relative')}>
                            {HOUR_LABELS.map((label, hour) => (
                                <span
                                    key={label}
                                    className="absolute right-1.5 -translate-y-1/2 text-xs text-muted-foreground tabular-nums first:translate-y-0"
                                    style={{ top: hour * HOUR_HEIGHT }}
                                >
                                    {label}
                                </span>
                            ))}
                            {todayIndex !== -1 && (
                                <span
                                    className="absolute right-0.5 -translate-y-1/2 rounded-full bg-(--app-current-color) px-1 text-xs font-medium text-background tabular-nums"
                                    style={{ top: nowTop }}
                                >
                                    {formatTime(now)}
                                </span>
                            )}
                        </div>

                        <div className="relative grid flex-1" style={columns}>
                            {HOUR_LABELS.slice(1).map((label, idx) => (
                                <div
                                    key={label}
                                    className="absolute inset-x-0 border-t"
                                    style={{ top: (idx + 1) * HOUR_HEIGHT }}
                                />
                            ))}
                            {days.map((day, dayIdx) => (
                                <div
                                    key={toLocalDateString(day)}
                                    className={cn(
                                        'relative border-l',
                                        (day.getDay() === 0 || day.getDay() === 6) && 'bg-muted/30',
                                    )}
                                >
                                    <div className="absolute inset-y-0 left-0 right-1 md:right-2">
                                        {blocks[dayIdx].map((block) => (
                                            <TimedEventBlock
                                                key={`${block.event.id}-${block.event.occurrenceDate}-${block.top}`}
                                                block={block}
                                                {...surfaceProps}
                                            />
                                        ))}
                                    </div>
                                    {dayIdx === todayIndex && (
                                        <div
                                            className="absolute inset-x-0 h-0.5 -translate-y-1/2 bg-(--app-current-color)"
                                            style={{ top: nowTop }}
                                        >
                                            <div className="absolute -left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-(--app-current-color)" />
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>

            <EventDetailDialog {...detailDialogProps} />
        </>
    );
}

// What a block shows follows its height: the title always, then the time, then the place.
function TimedEventBlock({ block, ...surfaceProps }: { block: TimedBlock } & EventSurfaceProps) {
    const { event } = block;
    const height = ((block.bottom - block.top) * HOUR_HEIGHT) / 60;
    const lines = Math.floor((height - BLOCK_PADDING) / LINE_HEIGHT);
    return (
        <EventSurface
            event={event}
            {...surfaceProps}
            className="absolute rounded px-1 py-0.5 ring-1 ring-background"
            style={{
                top: (block.top * HOUR_HEIGHT) / 60,
                height,
                left: `${(block.column / block.columns) * 100}%`,
                width: `${(block.span / block.columns) * 100}%`,
            }}
        >
            {lines < 2 ? (
                <span className="block truncate">
                    <span className="font-medium">{event.title}</span>, {formatTime(event.startTime)}
                </span>
            ) : (
                <>
                    <span className="block truncate font-medium">{event.title}</span>
                    <span className="block truncate">
                        {`${formatTime(event.startTime)} – ${formatTime(event.endTime)}`}
                    </span>
                    {lines > 2 && event.location && <span className="block truncate">{event.location}</span>}
                </>
            )}
        </EventSurface>
    );
}
