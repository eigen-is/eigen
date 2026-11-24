// The Calendar app's day, 3-day and week views: a column per day under its weekday and date, which link to that day
// alone, an all-day lane of bars that span their days, and a scrolling day of hours with each timed event as a block
// at its minutes, side by side where events overlap. A line marks the current time across today. A click on an event
// opens its detail dialog, and a click on an empty slot or a mouse or pen drag over a range, or a click in the all-day
// lane, asks the route to open New event at those times; the route also picks the days and fetches the events.

import { Link } from '@tanstack/react-router';
import type { TimedBlock } from '@workspace/lib/calendar';
import {
    allocateLanes,
    inAllDayLane,
    layoutTimedEvents,
    monthWeekLayout,
    slotAt,
    slotRange,
    toLocalDateString,
    weekdayHeader,
} from '@workspace/lib/calendar';
import { DEFAULT_CALENDAR_COLOR } from '@workspace/lib/constants/calendar';
import { formatTime } from '@workspace/lib/date';
import type { CalendarEventOccurrence, CalendarItem, SharedCalendar } from '@workspace/lib/types/calendar';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar';
import { usePointerDrag } from '@workspace/ui/hooks/use-pointer-drag';
import { colorSurface } from '@workspace/ui/lib/color-surface';
import { cn } from '@workspace/ui/lib/utils';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { NewEventTimes } from './create-event-dialog';
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
    onCreateEvent: (times: NewEventTimes) => void;
};

// A range drawn over one day column, in minutes from its midnight.
type Draft = { dayIdx: number; top: number; bottom: number };

const HOUR_HEIGHT = 48;
const MAX_ALL_DAY_LANES = 3;
const SCROLL_TO_HOUR = 7;
// A block's text lines are text-xs at leading-4, inside 2px of padding above and below.
const LINE_HEIGHT = 16;
const BLOCK_PADDING = 4;
// Dark mode draws a 2px color stripe at the left edge, so the text starts further in.
const BLOCK = 'absolute rounded px-1 py-0.5 dark:pl-2';
const GUTTER = 'w-11 shrink-0 md:w-14';
// A drag this close to the scroller's top or bottom edge scrolls it by a step each frame.
const NUDGE_EDGE_PX = 24;
const NUDGE_STEP_PX = 6;
const HOUR_LABELS = Array.from({ length: 24 }, (_, hour) => formatTime(new Date(2026, 0, 1, hour)));

export function TimeGrid({ days, events, calendars, sharedCalendars, initialEventId, onCreateEvent }: TimeGridProps) {
    const { handleEventClick, detailDialogProps } = useEventDetailState({
        events,
        calendars,
        sharedCalendars,
        initialEventId,
    });
    const [allDayExpanded, setAllDayExpanded] = useState(false);
    const [now, setNow] = useState(() => new Date());
    const scrollerRef = useRef<HTMLDivElement>(null);
    const startPointerDrag = usePointerDrag();
    const [draft, setDraft] = useState<Draft | null>(null);
    const nudgeFrameRef = useRef(0);
    // The browser sends a click after a drag's release, and after Escape too, since the pointer stays captured.
    const swallowClickRef = useRef(false);

    useEffect(() => {
        const timer = setInterval(() => setNow(new Date()), 60_000);
        return () => clearInterval(timer);
    }, []);
    useEffect(() => () => cancelAnimationFrame(nudgeFrameRef.current), []);

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
    const draftColor = (calendars.find((c) => c.isDefault) ?? calendars[0])?.color ?? DEFAULT_CALENDAR_COLOR;

    const createTimed = (dayIdx: number, top: number, bottom: number) =>
        onCreateEvent({ start: atMinutes(days[dayIdx], top), end: atMinutes(days[dayIdx], bottom), allDay: false });

    // Mouse and pen draw a range; a finger scrolls the grid, and its tap is the column's click.
    const handleColumnPointerDown = (e: React.PointerEvent<HTMLDivElement>, dayIdx: number) => {
        swallowClickRef.current = false;
        if ((e.pointerType !== 'mouse' && e.pointerType !== 'pen') || e.button !== 0 || isOnEvent(e.target)) return;
        const column = e.currentTarget;
        const pressed = minutesAt(column, e.clientY);
        let lastY = e.clientY;
        let range: Draft | null = null;
        const follow = () => {
            range = { dayIdx, ...slotRange(pressed, minutesAt(column, lastY)) };
            setDraft(range);
        };
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
            follow();
            nudgeFrameRef.current = requestAnimationFrame(nudge);
        };
        const stop = () => {
            cancelAnimationFrame(nudgeFrameRef.current);
            nudgeFrameRef.current = 0;
            setDraft(null);
        };
        startPointerDrag(e, {
            move: (me) => {
                lastY = me.clientY;
                follow();
                if (nudgeFrameRef.current === 0) nudge();
            },
            end: () => {
                stop();
                if (!range) return;
                swallowClickRef.current = true;
                createTimed(range.dayIdx, range.top, range.bottom);
            },
            cancel: () => {
                stop();
                swallowClickRef.current = true;
            },
        });
    };

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
                        className="grid min-h-6 flex-1 gap-y-0.5 py-0.5"
                        style={columns}
                        onClick={(e) => {
                            if (isOnEvent(e.target)) return;
                            const { left, width } = e.currentTarget.getBoundingClientRect();
                            const idx = Math.floor(((e.clientX - left) / width) * days.length);
                            const day = days[Math.min(days.length - 1, Math.max(0, idx))];
                            onCreateEvent({ start: day, end: day, allDay: true });
                        }}
                    >
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

                        <div
                            className="relative grid flex-1"
                            style={columns}
                            onClickCapture={(e) => {
                                if (!swallowClickRef.current) return;
                                swallowClickRef.current = false;
                                e.stopPropagation();
                            }}
                        >
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
                                    onPointerDown={(e) => handleColumnPointerDown(e, dayIdx)}
                                    onClick={(e) => {
                                        if (isOnEvent(e.target)) return;
                                        const top = slotAt(minutesAt(e.currentTarget, e.clientY));
                                        createTimed(dayIdx, top, top + 60);
                                    }}
                                >
                                    <div className="absolute inset-y-0 left-0 right-1 md:right-2">
                                        {blocks[dayIdx].map((block) => (
                                            <TimedEventBlock
                                                key={`${block.event.id}-${block.event.occurrenceDate}-${block.top}`}
                                                block={block}
                                                {...surfaceProps}
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
                            ))}
                        </div>
                    </div>
                </div>
            </div>

            <EventDetailDialog {...detailDialogProps} />
        </>
    );
}

// Minutes from the column's midnight under a pointer; the column's box moves with the scroller, so it holds the scroll.
function minutesAt(column: Element, clientY: number): number {
    return ((clientY - column.getBoundingClientRect().top) * 60) / HOUR_HEIGHT;
}

function atMinutes(day: Date, minutes: number): Date {
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes);
}

function isOnEvent(target: EventTarget): boolean {
    return target instanceof Element && target.closest('button') !== null;
}

// The range a drag draws before New event opens, on the default calendar's color, laid out as a block is.
function DraftBlock({ day, top, bottom, color }: { day: Date; top: number; bottom: number; color: string }) {
    const surface = colorSurface(color);
    const height = ((bottom - top) * HOUR_HEIGHT) / 60;
    const range = `${formatTime(atMinutes(day, top))} – ${formatTime(atMinutes(day, bottom))}`;
    return (
        <div
            className={cn(
                'pointer-events-none inset-x-0 overflow-hidden text-xs leading-4 shadow-md',
                BLOCK,
                surface.className,
            )}
            style={{ ...surface.style, top: (top * HOUR_HEIGHT) / 60, height }}
        >
            {height - BLOCK_PADDING < 2 * LINE_HEIGHT ? (
                <span className="block truncate">
                    <span className="font-medium">(No title)</span>, {range}
                </span>
            ) : (
                <>
                    <span className="block truncate font-medium">(No title)</span>
                    <span className="block truncate">{range}</span>
                </>
            )}
        </div>
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
            className={cn(BLOCK, 'ring-1 ring-background')}
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
