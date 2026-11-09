// What a repeat rule may ask of an expansion. rrule walks a rule step by step from DTSTART to the window, so the cost
// follows the numbers a rule states, not its size in the file. A rule past these limits stays in the stored bytes and its
// event stays, without its repeats. The iCalendar reader, the REST boundary and the range reads ask here, before anything
// walks.

import type { Options } from 'rrule';
import { RRule } from 'rrule';

const SUB_DAILY_FREQUENCIES = new Set<number>([RRule.HOURLY, RRule.MINUTELY, RRule.SECONDLY]);

// RFC 5545's busiest daily example fires 24 times a day. More is a sub-daily rule in daily words.
const MAX_TIMES_A_DAY = 24;

function isSubDaily(options: Partial<Options>): boolean {
    const listed = (value: number | number[] | null | undefined) => (Array.isArray(value) ? value.length : 1);
    return (
        (options.freq !== undefined && SUB_DAILY_FREQUENCIES.has(options.freq)) ||
        listed(options.byhour) * listed(options.byminute) * listed(options.bysecond) > MAX_TIMES_A_DAY
    );
}

export function isSubDailyRrule(rrule: string): boolean {
    try {
        return isSubDaily(RRule.parseString(rrule));
    } catch {
        return false; // an unparseable rule is rejected separately by the caller's own RRule.parseString
    }
}

// A start far from the window costs the same walk at DAILY, and the window's span doesn't bound it; 1900–2200 is 110k steps.
const MIN_RECURRENCE_START = Date.UTC(1900, 0, 1);
export const MAX_RECURRENCE_START = Date.UTC(2200, 0, 1);

// Negated so an Invalid Date (NaN) also counts as out of range.
export function isOutOfRangeRecurrenceStart(startTime: Date): boolean {
    const t = startTime.getTime();
    return !(t >= MIN_RECURRENCE_START && t <= MAX_RECURRENCE_START);
}

const RRULE_LAST_YEAR = 9999;
// 28 years hold every weekday of every date, leap days included.
const CYCLE_YEARS = 28;

function inYear(date: Date, year: number): Date {
    const moved = new Date(date);
    moved.setUTCFullYear(year);
    return moved;
}

// rrule takes no step limit, and a rule with no next date walks to its last year whatever the window. So the rule is
// tried from a start moved near that year, on DTSTART's weekday and leap phase, where the walk soon ends. A rule rrule
// refuses counts the same.
export function isExpandableRrule(rrule: string, dtstart: Date): boolean {
    if (isOutOfRangeRecurrenceStart(dtstart)) return false;
    try {
        const options = RRule.parseString(rrule);
        if (isSubDaily(options)) return false;
        const stated = dtstart.getUTCFullYear();
        let year = Math.max(stated, RRULE_LAST_YEAR - CYCLE_YEARS * (options.interval ?? 1));
        year -= (year - stated) % 4;
        let start = inYear(dtstart, year);
        while (start.getUTCDay() !== dtstart.getUTCDay()) {
            year -= 4;
            start = inYear(dtstart, year);
        }
        return new RRule({ ...options, dtstart: start, count: null, until: null }, true).after(start, true) !== null;
    } catch {
        return false;
    }
}

// Far above any real calendar view.
export const MAX_OCCURRENCES = 10000;
