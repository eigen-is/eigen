import { RRule } from 'rrule';

// rrule Frequency is ordered coarse→fine (YEARLY=0, MONTHLY, WEEKLY, DAILY=3, HOURLY=4, MINUTELY,
// SECONDLY=6). "Sub-daily" is anything finer than DAILY.
const SUB_DAILY_FREQUENCIES = new Set<number>([RRule.HOURLY, RRule.MINUTELY, RRule.SECONDLY]);

// A sub-daily RRULE makes rrule.between iterate every hour/minute/second from dtstart until it reaches
// the query window, blocking the single event loop for ALL users — a SECONDLY rule one year before its
// window took ~74s in a benchmark. The per-result count cap can't help because the iterator callback
// only fires on in-window matches, never on the pre-window walk. No mainstream calendar client emits
// sub-daily recurrence (Google/Apple/Thunderbird recurrence UIs start at DAILY), so these are pure DoS
// vectors: reject them at the API write boundary and strip them at the untrusted-ICS boundary.
export function isSubDailyRrule(rrule: string): boolean {
    let freq: number | undefined;
    try {
        freq = RRule.parseString(rrule).freq;
    } catch {
        return false; // an unparseable rule is rejected separately by the caller's own RRule.parseString
    }
    return freq !== undefined && SUB_DAILY_FREQUENCIES.has(freq);
}

// The dtstart→window walk is the other half of the iterate-to-window DoS: rrule.between steps
// occurrence-by-occurrence from dtstart until it reaches the query window, so a recurring event
// with a pathological dtstart (epoch 0, year 9999) queried at a distant narrow window still stalls
// the event loop for seconds even at DAILY — the span clamp bounds the window, not the walk to it.
// No real recurring series starts outside 1900–2200, so bound dtstart to that range: reject at the
// API write boundary, strip (degrade to a single event) at the untrusted-ICS boundary, same seams
// as the sub-daily guard. Worst case inside the range is DAILY 1900→2200 ≈ 110k steps — negligible.
const MIN_RECURRENCE_START = Date.UTC(1900, 0, 1);
const MAX_RECURRENCE_START = Date.UTC(2200, 0, 1);

// Negated so an Invalid Date (NaN) also counts as out of range.
export function isOutOfRangeRecurrenceStart(startTime: Date): boolean {
    const t = startTime.getTime();
    return !(t >= MIN_RECURRENCE_START && t <= MAX_RECURRENCE_START);
}

// Hard ceiling on occurrences materialised per expansion — defence in depth beneath the sub-daily
// reject and the window clamp. Far larger than any real calendar view so it never clips a legit series.
export const MAX_OCCURRENCES = 10000;

// Widest window the range reads honour. The calendar FE only ever asks for a month/week and CalDAV
// initial-sync windows are far narrower, so 5 years is generous headroom while bounding rrule's
// iteration and stopping the `event-range/0/253402300799` (year-9999) span from the audit.
const MAX_RANGE_SPAN_MS = 5 * 366 * 24 * 60 * 60 * 1000;

// Clamp a query window's end so its span never exceeds MAX_RANGE_SPAN_MS. Clamp (not reject) so a
// legit-but-wide CalDAV sync still gets bounded data instead of an error.
export function clampRangeEnd(from: Date, to: Date): Date {
    const maxEnd = from.getTime() + MAX_RANGE_SPAN_MS;
    return to.getTime() > maxEnd ? new Date(maxEnd) : to;
}
