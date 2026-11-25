// The Calendar app's day, 3-day and week views: a column per day under its date, an all-day lane of bars across their
// days, and a scrolling day of hours with each timed event as a block at its minutes, side by side where they overlap.
// A click on an event asks the route to open its detail, and a click or a mouse or pen drag on empty time asks it to
// open New event there. A mouse or pen drags a block to other days and minutes, its bottom edge to another end and a
// bar to other days, and the drop saves it; the route picks the days, the events and the one it has open.

import { Link } from '@tanstack/react-router';
import type { EventTimes } from '@workspace/lib/calendar';
import {
    allocateLanes,
    defaultCalendar,
    eventDaySpan,
    inAllDayLane,
    layoutTimedEvents,
    monthWeekLayout,
    movedTimes,
    resizedTimes,
    slotAt,
    slotRange,
    toLocalDateString,
    weekdayHeader,
} from '@workspace/lib/calendar';
import { DEFAULT_CALENDAR_COLOR, NEW_EVENT_MINUTES } from '@workspace/lib/constants/calendar';
import { formatTime } from '@workspace/lib/date';
import type { CalendarEventOccurrence, CalendarItem, SharedCalendar } from '@workspace/lib/types/calendar';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar';
import { cn } from '@workspace/ui/lib/utils';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cellAt, isDragPointer } from './calendar-utils';
import type { NewEventTimes } from './create-event-dialog';
import type { EventSurfaceProps } from './event-chip';
import { EventBar, LaneGhost, MORE_BUTTON } from './event-chip';
import { EventDropHost } from './event-drop-host';
import { useEventDrop } from './hooks/use-event-drop';
import { useViewDrag } from './hooks/use-view-drag';
import { atMinutes, DraftBlock, HOUR_HEIGHT, minutesToPx, TimedEventBlock } from './time-grid-block';

type TimeGridProps = {
    days: readonly Date[];
    events: readonly CalendarEventOccurrence[];
    calendars: readonly CalendarItem[];
    sharedCalendars: readonly SharedCalendar[];
    onEventClick: EventSurfaceProps['onClick'];
    openKey: string | undefined;
    onCreateEvent: (times: NewEventTimes) => void;
};

// A range drawn over one day column, in minutes from its midnight.
type Draft = { dayIdx: number; top: number; bottom: number };

type DragSteps = { follow: (clientX: number, clientY: number) => void; land: () => void; scrolls: boolean };

const MAX_ALL_DAY_LANES = 3;
const SCROLL_TO_HOUR = 7;
const GUTTER = 'w-11 shrink-0 md:w-14';
// A drag this close to the scroller's top or bottom edge scrolls it by a step each frame.
const NUDGE_EDGE_PX = 24;
const NUDGE_STEP_PX = 6;
const HOUR_LABELS = Array.from({ length: 24 }, (_, hour) => formatTime(new Date(2026, 0, 1, hour)));

export function TimeGrid({
    days,
    events,
    calendars,
    sharedCalendars,
    onEventClick,
    openKey,
    onCreateEvent,
}: TimeGridProps) {
    const { shownEvents, canDrag, drop, dropHostProps } = useEventDrop({ events, calendars, sharedCalendars });
    const [allDayExpanded, setAllDayExpanded] = useState(false);
    const [now, setNow] = useState(() => new Date());
    const scrollerRef = useRef<HTMLDivElement>(null);
    const allDayLaneRef = useRef<HTMLDivElement>(null);
    const hoursRef = useRef<HTMLDivElement>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    // The dragged event at the times it would land on.
    const [ghost, setGhost] = useState<CalendarEventOccurrence | null>(null);
    const nudgeFrameRef = useRef(0);
    const { runDrag: runViewDrag, rootProps } = useViewDrag();

    // Ticks on the minute, and at once when the tab shows again, since a hidden tab's timers run late.
    useEffect(() => {
        const tick = () => setNow(new Date());
        const timer = setTimeout(tick, 60_000 - (now.getTime() % 60_000));
        document.addEventListener('visibilitychange', tick);
        return () => {
            clearTimeout(timer);
            document.removeEventListener('visibilitychange', tick);
        };
    }, [now]);
    useEffect(() => () => cancelAnimationFrame(nudgeFrameRef.current), []);

    useLayoutEffect(() => {
        const scroller = scrollerRef.current;
        if (!scroller) return;
        const current = new Date();
        const todayInView = days.some((day) => toLocalDateString(day) === toLocalDateString(current));
        scroller.scrollTop = (todayInView ? current.getHours() - 1 : SCROLL_TO_HOUR) * HOUR_HEIGHT;
    }, [days]);

    const allDayEvents = shownEvents.filter(inAllDayLane);
    const collapsedLanes = monthWeekLayout(days, allDayEvents, MAX_ALL_DAY_LANES);
    const lanesOverflow = collapsedLanes.hidden.some((count) => count > 0);
    const bars = allDayExpanded ? allocateLanes(allDayEvents, days) : collapsedLanes.bars;
    const blocks = layoutTimedEvents(shownEvents, days);
    const ghostBar = ghost && inAllDayLane(ghost) ? allocateLanes([ghost], days)[0] : undefined;
    const ghostBlocks = ghost ? layoutTimedEvents([ghost], days) : undefined;

    const todayKey = toLocalDateString(now);
    const todayIndex = days.findIndex((day) => toLocalDateString(day) === todayKey);
    const nowTop = minutesToPx(now.getHours() * 60 + now.getMinutes());
    const columns = { gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` };
    const surfaceProps = { calendars, sharedCalendars, onClick: onEventClick, openKey };
    const draftColor = defaultCalendar(calendars)?.color ?? DEFAULT_CALENDAR_COLOR;

    const createTimed = (dayIdx: number, top: number, bottom: number) =>
        onCreateEvent({ start: atMinutes(days[dayIdx], top), end: atMinutes(days[dayIdx], bottom), allDay: false });

    // One gesture at a time: `follow` draws it for the pointer's last spot, as it moves and as an edge scrolls the
    // hours under it, and `land` runs on a release after a move.
    const runDrag = (e: React.PointerEvent<HTMLElement>, { follow, land, scrolls }: DragSteps) => {
        let lastX = e.clientX;
        let lastY = e.clientY;
        // Runs a frame at a time for as long as the pointer near an edge still scrolls the grid.
        const nudge = () => {
            nudgeFrameRef.current = 0;
            const scroller = scrollerRef.current;
            if (!scroller) return;
            const { top, bottom } = scroller.getBoundingClientRect();
            const step =
                lastY < top + NUDGE_EDGE_PX ? -NUDGE_STEP_PX : lastY > bottom - NUDGE_EDGE_PX ? NUDGE_STEP_PX : 0;
            const scrollTop = Math.min(
                scroller.scrollHeight - scroller.clientHeight,
                Math.max(0, scroller.scrollTop + step),
            );
            if (scrollTop === scroller.scrollTop) return;
            scroller.scrollTop = scrollTop;
            follow(lastX, lastY);
            nudgeFrameRef.current = requestAnimationFrame(nudge);
        };
        runViewDrag(e, {
            move: (me) => {
                lastX = me.clientX;
                lastY = me.clientY;
                follow(lastX, lastY);
                if (scrolls && nudgeFrameRef.current === 0) nudge();
            },
            land,
            stop: () => {
                cancelAnimationFrame(nudgeFrameRef.current);
                nudgeFrameRef.current = 0;
                setDraft(null);
                setGhost(null);
            },
        });
    };

    const handleColumnPointerDown = (e: React.PointerEvent<HTMLDivElement>, dayIdx: number) => {
        if (!isDragPointer(e) || isOnEvent(e.target)) return;
        const column = e.currentTarget;
        const pressed = minutesAt(column, e.clientY);
        let range: Draft = { dayIdx, top: 0, bottom: 0 };
        runDrag(e, {
            follow: (_x, y) => {
                range = { dayIdx, ...slotRange(pressed, minutesAt(column, y)) };
                setDraft(range);
            },
            land: () => createTimed(range.dayIdx, range.top, range.bottom),
            scrolls: true,
        });
    };

    // A block moves by days and minutes, a bar in the all-day lane by days alone.
    const moveEvent = (event: CalendarEventOccurrence, e: React.PointerEvent<HTMLElement>) => {
        const timed = !inAllDayLane(event);
        const surface = timed ? hoursRef.current : allDayLaneRef.current;
        if (!isDragPointer(e) || !canDrag(event) || !surface) return;
        const pressedDay = dayAt(surface, e.clientX, days.length);
        const pressedMinutes = minutesAt(surface, e.clientY);
        let moved: EventTimes = event;
        runDrag(e, {
            follow: (x, y) => {
                const minutes = timed ? minutesAt(surface, y) - pressedMinutes : 0;
                moved = movedTimes(event, dayAt(surface, x, days.length) - pressedDay, minutes);
                setGhost({ ...event, ...moved });
            },
            land: () => drop(event, moved),
            scrolls: timed,
        });
    };

    const resizeEvent = (event: CalendarEventOccurrence, e: React.PointerEvent<HTMLElement>) => {
        const hours = hoursRef.current;
        if (!isDragPointer(e) || !hours) return;
        let resized: EventTimes = event;
        runDrag(e, {
            follow: (_x, y) => {
                resized = resizedTimes(event, minutesAt(hours, y));
                setGhost({ ...event, ...resized });
            },
            land: () => drop(event, resized),
            scrolls: true,
        });
    };

    return (
        <>
            <div className="flex h-full flex-col" {...rootProps}>
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
                    <div
                        ref={allDayLaneRef}
                        className="grid min-h-6 flex-1 gap-y-0.5 py-0.5"
                        style={columns}
                        onClick={(e) => {
                            if (isOnEvent(e.target)) return;
                            const day = days[dayAt(e.currentTarget, e.clientX, days.length)];
                            onCreateEvent({ start: day, end: day, allDay: true });
                        }}
                    >
                        {bars.map((bar) => (
                            <EventBar
                                key={`${bar.event.id}-${bar.event.occurrenceDate}-${bar.start}`}
                                bar={bar}
                                {...surfaceProps}
                                onDragStart={moveEvent}
                            />
                        ))}
                        {!allDayExpanded &&
                            collapsedLanes.hidden.map(
                                (count, idx) =>
                                    count > 0 && (
                                        <button
                                            key={toLocalDateString(days[idx])}
                                            type="button"
                                            className={MORE_BUTTON}
                                            style={{ gridRow: MAX_ALL_DAY_LANES, gridColumn: idx + 1 }}
                                            onClick={() => setAllDayExpanded(true)}
                                        >
                                            {`${count} more`}
                                        </button>
                                    ),
                            )}
                        {ghostBar && <LaneGhost bar={ghostBar} {...surfaceProps} />}
                    </div>
                </div>

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

                        <div ref={hoursRef} className="relative grid flex-1" style={columns}>
                            {HOUR_LABELS.slice(1).map((label, idx) => (
                                <div
                                    key={label}
                                    className="absolute inset-x-0 border-t"
                                    style={{ top: (idx + 1) * HOUR_HEIGHT }}
                                />
                            ))}
                            {days.map((day, dayIdx) => {
                                const key = toLocalDateString(day);
                                return (
                                    <div
                                        key={key}
                                        className={cn(
                                            'relative border-l',
                                            (day.getDay() === 0 || day.getDay() === 6) && 'bg-muted/30',
                                        )}
                                        onPointerDown={(e) => handleColumnPointerDown(e, dayIdx)}
                                        onClick={(e) => {
                                            if (isOnEvent(e.target)) return;
                                            const top = slotAt(minutesAt(e.currentTarget, e.clientY));
                                            createTimed(dayIdx, top, top + NEW_EVENT_MINUTES);
                                        }}
                                    >
                                        <div className="absolute inset-y-0 left-0 right-1 md:right-2">
                                            {blocks[dayIdx].map((block) => (
                                                <TimedEventBlock
                                                    key={`${block.event.id}-${block.event.occurrenceDate}-${block.top}`}
                                                    block={block}
                                                    {...surfaceProps}
                                                    onDragStart={moveEvent}
                                                    // The edge is the event's end only on the day it ends.
                                                    onResizeStart={
                                                        canDrag(block.event) && eventDaySpan(block.event).last === key
                                                            ? resizeEvent
                                                            : undefined
                                                    }
                                                />
                                            ))}
                                            {ghostBlocks?.[dayIdx].map((block) => (
                                                <TimedEventBlock
                                                    key={block.top}
                                                    block={block}
                                                    {...surfaceProps}
                                                    className="pointer-events-none"
                                                />
                                            ))}
                                            {draft?.dayIdx === dayIdx && (
                                                <DraftBlock
                                                    day={day}
                                                    top={draft.top}
                                                    bottom={draft.bottom}
                                                    color={draftColor}
                                                />
                                            )}
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
                                );
                            })}
                        </div>
                    </div>
                </div>
            </div>

            {dropHostProps && <EventDropHost {...dropHostProps} />}
        </>
    );
}

// Minutes from the column's midnight under a pointer; the column's box moves with the scroller, so it holds the scroll.
function minutesAt(column: Element, clientY: number): number {
    return ((clientY - column.getBoundingClientRect().top) * 60) / HOUR_HEIGHT;
}

// The day under a pointer, of the `count` equal columns an element holds.
function dayAt(element: Element, clientX: number, count: number): number {
    const { left, width } = element.getBoundingClientRect();
    return cellAt(left, width, clientX, count);
}

function isOnEvent(target: EventTarget): boolean {
    return target instanceof Element && target.closest('button') !== null;
}
