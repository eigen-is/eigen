import { RRule } from 'rrule';

const SUB_DAILY_FREQUENCIES = new Set<number>([RRule.HOURLY, RRule.MINUTELY, RRule.SECONDLY]);

// rrule.between walks unit by unit from dtstart to the window: a SECONDLY rule a year out stalls the event loop ~74s, and no client emits sub-daily.
export function isSubDailyRrule(rrule: string): boolean {
    let freq: number | undefined;
    try {
        freq = RRule.parseString(rrule).freq;
    } catch {
        return false; // an unparseable rule is rejected separately by the caller's own RRule.parseString
    }
    return freq !== undefined && SUB_DAILY_FREQUENCIES.has(freq);
}

// The same walk from a pathological dtstart stalls even at DAILY, and the span clamp bounds the window, not the walk to it; DAILY across 1900–2200 is ~110k steps.
const MIN_RECURRENCE_START = Date.UTC(1900, 0, 1);
const MAX_RECURRENCE_START = Date.UTC(2200, 0, 1);

// Negated so an Invalid Date (NaN) also counts as out of range.
export function isOutOfRangeRecurrenceStart(startTime: Date): boolean {
    const t = startTime.getTime();
    return !(t >= MIN_RECURRENCE_START && t <= MAX_RECURRENCE_START);
}

// Defense in depth under the sub-daily reject and the window clamp, far above any real calendar view.
export const MAX_OCCURRENCES = 10000;
