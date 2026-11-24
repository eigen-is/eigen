// Where the calendar views draw events and where a drag puts them: day spans, lanes for month rows and the all-day
// lane, overlap columns in the time grid, the 15-minute snap, and the times and recurring choices of a move or resize.
// Pure, so the views stay thin and the layout is tested without a browser. An all-day event places by its UTC date,
// a timed one by the viewer's local day, and positions are wall-clock minutes, so 09:00 stays 09:00 on a DST day.

import type { CalendarEventOccurrence, RecurrenceScope } from '../../types/calendar';
import { dateFormatter } from '../date';
import { normalizeTimezone, occurrenceDateToString, occurrenceScopes, toLocalDateString } from './calendar-utils';

export const SNAP_MINUTES = 15;

const DAY_MINUTES = 1440;
const DAY_MS = 86400_000;

type EventTimes = { startTime: Date; endTime: Date };

export type LaneBar = {
    event: CalendarEventOccurrence;
    lane: number;
    start: number;
    span: number;
    continuesBefore: boolean;
    continuesAfter: boolean;
};

export type TimedBlock = {
    event: CalendarEventOccurrence;
    top: number;
    bottom: number;
    column: number;
    columns: number;
    span: number;
};

type PlacedSegment = Omit<TimedBlock, 'columns' | 'span'>;

// The end is exclusive, so an event ending at midnight does not touch the next day.
export function eventDaySpan(event: CalendarEventOccurrence): { first: string; last: string } {
    const dayKey = event.allDay ? occurrenceDateToString : toLocalDateString;
    return { first: dayKey(event.startTime), last: dayKey(lastInstant(event)) };
}

export function inAllDayLane(event: CalendarEventOccurrence): boolean {
    return event.allDay || event.endTime.getTime() - event.startTime.getTime() >= DAY_MS;
}

export function allocateLanes(items: readonly CalendarEventOccurrence[], days: readonly Date[]): LaneBar[] {
    const keys = days.map(toLocalDateString);
    const bars: Omit<LaneBar, 'lane'>[] = [];
    for (const event of items) {
        const { first, last } = eventDaySpan(event);
        const start = keys.findIndex((key) => key >= first);
        const end = keys.findLastIndex((key) => key <= last);
        if (start === -1 || end < start) continue;
        bars.push({
            event,
            start,
            span: end - start + 1,
            continuesBefore: first < keys[start],
            continuesAfter: last > keys[end],
        });
    }
    bars.sort(
        (a, b) =>
            a.start - b.start ||
            b.span - a.span ||
            a.event.startTime.getTime() - b.event.startTime.getTime() ||
            a.event.title.localeCompare(b.event.title),
    );

    // Sorted by start, the last bar placed in a lane is the one that ends latest there.
    const laneEnds: number[] = [];
    return bars.map((bar) => {
        let lane = laneEnds.findIndex((end) => end < bar.start);
        if (lane === -1) lane = laneEnds.length;
        laneEnds[lane] = bar.start + bar.span - 1;
        return { ...bar, lane };
    });
}

export function monthWeekLayout(
    days: readonly Date[],
    events: readonly CalendarEventOccurrence[],
    maxLanes: number,
): { bars: LaneBar[]; hidden: number[] } {
    const bars: LaneBar[] = [];
    const hidden = days.map(() => 0);
    for (const bar of allocateLanes(events, days)) {
        if (bar.lane < maxLanes) {
            bars.push(bar);
            continue;
        }
        for (let day = bar.start; day < bar.start + bar.span; day++) hidden[day]++;
    }
    return { bars, hidden };
}

export function layoutTimedEvents(events: readonly CalendarEventOccurrence[], days: readonly Date[]): TimedBlock[][] {
    const timedEvents = events.filter((event) => !inAllDayLane(event));
    return days.map((day) => {
        const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
        // The next local midnight, not 24 hours on: a DST day is 23 or 25 hours long.
        const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
        const segments: Omit<PlacedSegment, 'column'>[] = [];
        for (const event of timedEvents) {
            const start = event.startTime.getTime();
            const end = event.endTime.getTime();
            if (start >= dayEnd || (end <= dayStart && start !== dayStart)) continue;
            const top = start <= dayStart ? 0 : wallMinutes(event.startTime);
            const bottom = end >= dayEnd ? DAY_MINUTES : wallMinutes(event.endTime);
            const shownBottom = Math.min(DAY_MINUTES, Math.max(bottom, top + SNAP_MINUTES));
            segments.push({ event, top: Math.min(top, shownBottom - SNAP_MINUTES), bottom: shownBottom });
        }
        segments.sort((a, b) => a.top - b.top || b.bottom - a.bottom || a.event.title.localeCompare(b.event.title));

        const blocks: TimedBlock[] = [];
        let cluster: PlacedSegment[] = [];
        let clusterBottom = 0;
        for (const segment of segments) {
            if (segment.top >= clusterBottom) {
                blocks.push(...packCluster(cluster));
                cluster = [];
            }
            const taken = new Set(cluster.filter((block) => block.bottom > segment.top).map((block) => block.column));
            let column = 0;
            while (taken.has(column)) column++;
            cluster.push({ ...segment, column });
            clusterBottom = Math.max(clusterBottom, segment.bottom);
        }
        blocks.push(...packCluster(cluster));
        return blocks;
    });
}

export function slotAt(minutes: number): number {
    const slot = Math.floor(minutes / SNAP_MINUTES) * SNAP_MINUTES;
    return Math.min(DAY_MINUTES - SNAP_MINUTES, Math.max(0, slot));
}

export function movedTimes(event: CalendarEventOccurrence, deltaDays: number, deltaMinutes: number): EventTimes {
    const length = event.endTime.getTime() - event.startTime.getTime();
    const from = event.startTime;
    const startTime = event.allDay
        ? new Date(from.getTime() + deltaDays * DAY_MS)
        : new Date(
              from.getFullYear(),
              from.getMonth(),
              from.getDate() + deltaDays,
              from.getHours(),
              from.getMinutes() + Math.round(deltaMinutes / SNAP_MINUTES) * SNAP_MINUTES,
              from.getSeconds(),
          );
    return { startTime, endTime: new Date(startTime.getTime() + length) };
}

// The minutes count from the midnight of the event's last day, where the grid draws its bottom edge.
export function resizedTimes(event: CalendarEventOccurrence, newEndMinutes: number): EventTimes {
    const last = lastInstant(event);
    const snapped = Math.round(newEndMinutes / SNAP_MINUTES) * SNAP_MINUTES;
    const end = new Date(last.getFullYear(), last.getMonth(), last.getDate(), 0, snapped);
    const minEnd = event.startTime.getTime() + SNAP_MINUTES * 60_000;
    return { startTime: event.startTime, endTime: new Date(Math.max(end.getTime(), minEnd)) };
}

// Moving the series start to another day would leave its BYDAY on the old weekday, so only this event may move there.
// The day is the series' own, because its rule runs in its zone.
export function rescheduleScopes(event: CalendarEventOccurrence, moved: EventTimes): readonly RecurrenceScope[] {
    const scopes = occurrenceScopes(event);
    if (scopes.length === 0) return scopes;
    const timeZone = event.allDay ? 'UTC' : (normalizeTimezone(event.timezone) ?? 'UTC');
    const day = dateFormatter({ timeZone });
    return day.format(event.startTime) === day.format(moved.startTime) ? scopes : ['this'];
}

function lastInstant(event: CalendarEventOccurrence): Date {
    return new Date(Math.max(event.startTime.getTime(), event.endTime.getTime() - 1));
}

function wallMinutes(date: Date): number {
    return date.getHours() * 60 + date.getMinutes();
}

// Every block widens right over the columns no overlapping block holds.
function packCluster(cluster: readonly PlacedSegment[]): TimedBlock[] {
    const columns = Math.max(0, ...cluster.map((block) => block.column + 1));
    return cluster.map((block) => {
        const blocked = cluster.filter(
            (other) => other.column > block.column && other.top < block.bottom && other.bottom > block.top,
        );
        const next = Math.min(columns, ...blocked.map((other) => other.column));
        return { ...block, columns, span: next - block.column };
    });
}
