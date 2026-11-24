// The Calendar app's month grid: every week the month touches as a row of seven days, its events in lanes under the
// dates, a multi-day one as one bar across its days. A row holds as many lanes as its height fits, and a day with more
// events than that shows "N more", which lists the whole day. A date links to that day's view, a click on an event
// opens its detail dialog and a click on an empty part of a day creates an event there. A mouse or pen drags an event
// to other days, and the drop saves it; the route fetches the events.

import { Link } from '@tanstack/react-router';
import type { EventTimes } from '@workspace/lib/calendar';
import {
    allocateLanes,
    getEventsForDay,
    monthWeekLayout,
    movedTimes,
    toLocalDateString,
    viewDays,
    WEEKDAY_HEADERS,
} from '@workspace/lib/calendar';
import { isToday } from '@workspace/lib/date';
import type { CalendarEventOccurrence, CalendarItem, SharedCalendar } from '@workspace/lib/types/calendar';
import { useElementSize } from '@workspace/ui/hooks/use-element-size';
import { usePointerDrag } from '@workspace/ui/hooks/use-pointer-drag';
import { cn } from '@workspace/ui/lib/utils';
import { useMemo, useRef, useState } from 'react';
import { isDragPointer } from './calendar-utils';
import { EventBar, LaneGhost } from './event-chip';
import { EventDetailDialog } from './event-detail-dialog';
import { EventDropHost } from './event-drop-host';
import { useEventDetailState } from './hooks/use-event-detail-state';
import { useEventDrop } from './hooks/use-event-drop';
import { MonthDayPopover } from './month-day-popover';

type MonthViewProps = {
    focus: Date;
    events: readonly CalendarEventOccurrence[];
    calendars: readonly CalendarItem[];
    sharedCalendars?: readonly SharedCalendar[];
    onDayClick?: (date: Date) => void;
    initialEventId?: string;
};

// In pixels: the lanes start under the date row (top-7), each lane is a text-xs line with py-0.5, gap-y-0.5 apart.
const DATE_ROW = 28;
const LANE = 20;
const GAP = 2;

export function MonthView({ focus, events, calendars, sharedCalendars, onDayClick, initialEventId }: MonthViewProps) {
    const { handleEventClick, detailDialogProps } = useEventDetailState({
        events,
        calendars,
        sharedCalendars,
        initialEventId,
    });
    const { shownEvents, canDrag, drop, dropHostProps } = useEventDrop({ events, calendars, sharedCalendars });
    // The rows share the height equally, so the first one measures them all.
    const [rowRef, rowSize] = useElementSize<HTMLDivElement>();
    const lanes = Math.max(1, Math.floor((rowSize.height - DATE_ROW) / (LANE + GAP)));
    const weeksRef = useRef<HTMLDivElement>(null);
    const startPointerDrag = usePointerDrag();
    // The dragged event at the days it would land on.
    const [ghost, setGhost] = useState<CalendarEventOccurrence | null>(null);
    // The browser sends a click after a drag's release, and after Escape too, since the pointer stays captured.
    const swallowClickRef = useRef(false);

    const weeks = useMemo(() => {
        const days = viewDays('month', focus);
        return Array.from({ length: days.length / 7 }, (_, i) => days.slice(i * 7, i * 7 + 7));
    }, [focus]);
    const currentMonth = focus.getMonth();
    const surfaceProps = { calendars, sharedCalendars, onClick: handleEventClick };

    const moveEvent = (event: CalendarEventOccurrence, e: React.PointerEvent<HTMLElement>) => {
        const grid = weeksRef.current;
        if (!isDragPointer(e) || !canDrag(event) || !grid) return;
        const pressed = dayAt(grid, weeks.length, e.clientX, e.clientY);
        let moved: EventTimes | null = null;
        startPointerDrag(e, {
            move: (me) => {
                moved = movedTimes(event, dayAt(grid, weeks.length, me.clientX, me.clientY) - pressed, 0);
                setGhost({ ...event, ...moved });
            },
            end: () => {
                setGhost(null);
                if (!moved) return;
                swallowClickRef.current = true;
                drop(event, moved);
            },
            cancel: () => {
                setGhost(null);
                swallowClickRef.current = true;
            },
        });
    };

    return (
        <>
            <div
                className="flex flex-col h-full"
                onPointerDownCapture={() => {
                    swallowClickRef.current = false;
                }}
                onClickCapture={(e) => {
                    if (!swallowClickRef.current) return;
                    swallowClickRef.current = false;
                    e.stopPropagation();
                }}
            >
                <div className="grid grid-cols-7 border-b">
                    {WEEKDAY_HEADERS.map((day) => (
                        <div
                            key={day}
                            className="text-center text-xs font-medium text-muted-foreground py-2 border-r last:border-r-0"
                        >
                            {day}
                        </div>
                    ))}
                </div>

                <div
                    ref={weeksRef}
                    className="flex-1 grid overflow-hidden"
                    style={{ gridTemplateRows: `repeat(${weeks.length}, minmax(0, 1fr))` }}
                >
                    {weeks.map((week, weekIdx) => {
                        const { bars, hidden } = monthWeekLayout(week, shownEvents, lanes);
                        const ghostBar = ghost ? allocateLanes([ghost], week)[0] : undefined;
                        return (
                            <div
                                key={toLocalDateString(week[0])}
                                ref={weekIdx === 0 ? rowRef : undefined}
                                className="relative grid grid-cols-7 overflow-hidden border-b last:border-b-0"
                            >
                                {week.map((day) => {
                                    const isCurrentMonth = day.getMonth() === currentMonth;
                                    const today = isToday(day);
                                    const key = toLocalDateString(day);
                                    return (
                                        <div
                                            key={key}
                                            className={cn(
                                                'border-r last:border-r-0 p-1 cursor-pointer hover:bg-accent/30 transition-colors',
                                                !isCurrentMonth && 'bg-muted/30',
                                            )}
                                            onClick={(e) => e.target === e.currentTarget && onDayClick?.(day)}
                                        >
                                            <Link
                                                to="/view/$mode/$date"
                                                params={{ mode: 'day', date: key }}
                                                className={cn(
                                                    'text-xs font-medium w-6 h-6 flex items-center justify-center rounded-full',
                                                    today
                                                        ? 'bg-(--app-current-color) text-background'
                                                        : 'hover:bg-accent',
                                                    !isCurrentMonth && !today && 'text-muted-foreground',
                                                )}
                                            >
                                                {day.getDate()}
                                            </Link>
                                        </div>
                                    );
                                })}

                                <div
                                    className="pointer-events-none absolute inset-x-0 top-7 grid grid-cols-7 gap-y-0.5 *:pointer-events-auto"
                                    style={{ gridTemplateRows: `repeat(${lanes}, ${LANE}px)` }}
                                >
                                    {bars.map((bar) => (
                                        <EventBar
                                            key={`${bar.event.id}-${bar.event.occurrenceDate}-${bar.start}`}
                                            bar={bar}
                                            {...surfaceProps}
                                            onDragStart={moveEvent}
                                        />
                                    ))}
                                    {hidden.map(
                                        (count, idx) =>
                                            count > 0 && (
                                                <MonthDayPopover
                                                    key={toLocalDateString(week[idx])}
                                                    day={week[idx]}
                                                    events={dayList(shownEvents, week[idx])}
                                                    hiddenCount={count}
                                                    calendars={calendars}
                                                    sharedCalendars={sharedCalendars}
                                                    onEventClick={handleEventClick}
                                                    style={{ gridRow: lanes, gridColumn: idx + 1 }}
                                                />
                                            ),
                                    )}
                                    {ghostBar && <LaneGhost bar={ghostBar} {...surfaceProps} />}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            <EventDetailDialog {...detailDialogProps} />
            {dropHostProps && <EventDropHost {...dropHostProps} />}
        </>
    );
}

// The day under a pointer, counted from the grid's first day: its rows share the height and each holds seven days.
function dayAt(grid: Element, rows: number, clientX: number, clientY: number): number {
    const { left, top, width, height } = grid.getBoundingClientRect();
    const cell = (offset: number, count: number) => Math.min(count - 1, Math.max(0, Math.floor(offset * count)));
    return cell((clientY - top) / height, rows) * 7 + cell((clientX - left) / width, 7);
}

function dayList(events: readonly CalendarEventOccurrence[], day: Date): CalendarEventOccurrence[] {
    const dayEvents = getEventsForDay(events, day);
    const timed = dayEvents.filter((e) => !e.allDay).sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    return [...dayEvents.filter((e) => e.allDay), ...timed];
}
