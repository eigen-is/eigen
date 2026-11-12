// What lies between two dates, as the functions that measure it count: DATEDIF in whole years, months or days,
// DAYS360 in a year of twelve months of 30 days, YEARFRAC as a part of a year by one of five conventions. Each
// takes two serials that are dates and reads their days through serialDate, so the calendar is said in one place.

import type { CalendarDay } from './dates';
import { dateSerial, daysInMonth, serialDate } from './dates';
import type { FormulaError } from './errors';
import { NUM } from './errors';

// `unit` is Y, M or D for whole years, months or days, MD for the days past whole months, YM for the months
// past whole years and YD for the days past whole years, in either case.
export function dateDif(start: number, end: number, unit: string): number | FormulaError {
    if (start > end) return NUM;
    const from = serialDate(start);
    const to = serialDate(end);
    const months = (to.year - from.year) * 12 + to.month - from.month - (to.day < from.day ? 1 : 0);
    switch (unit.toUpperCase()) {
        case 'Y':
            return Math.floor(months / 12);
        case 'M':
            return months;
        case 'D':
            return end - start;
        case 'YM':
            return months % 12;
        case 'MD':
            // Counted from the start's day in the month before the end, even when that month has no such day.
            return to.day >= from.day ? to.day - from.day : end - dateSerial(to.year, to.month - 1, from.day);
        case 'YD': {
            // From the start's day in the end's year, or when that is still to come, to the end's day a year on.
            const anniversary = dateSerial(to.year, from.month, from.day);
            return anniversary <= end ? end - anniversary : dateSerial(from.year + 1, to.month, to.day) - start;
        }
        default:
            return NUM;
    }
}

// The American method makes a start on the last day of February a 30th, in Excel's calendar, and an end on a
// 31st a 30th only after a start on a 30th. The European one makes every 31st a 30th.
export function days360(start: number, end: number, european: boolean): number {
    const from = serialDate(start);
    const to = serialDate(end);
    if (european) return thirties(from, to, Math.min(from.day, 30), Math.min(to.day, 30));
    const closes = from.day === 31 || (from.month === 2 && serialDate(start + 1).month === 3);
    const first = closes ? 30 : from.day;
    return thirties(from, to, first, to.day === 31 && first === 30 ? 30 : to.day);
}

// `basis` 0 is 30 days a month the American way, 1 the days of the years themselves, 2 the days over 360, 3 the
// days over 365 and 4 30 days a month the European way. The two dates may come in either order.
export function yearFraction(one: number, other: number, basis: number): number | FormulaError {
    const start = Math.min(one, other);
    const end = Math.max(one, other);
    switch (basis) {
        case 0: {
            // Not DAYS360: the last day of February is by the real calendar, two of them are whole months apart,
            // and an end on a 31st is a 30th only when the start was on a 30th or 31st as written.
            const from = serialDate(start);
            const to = serialDate(end);
            const closes = from.month === 2 && from.day === daysInMonth(from.year, 2);
            const closed = to.month === 2 && to.day === daysInMonth(to.year, 2);
            const last = (to.day === 31 && from.day >= 30) || (closes && closed) ? 30 : to.day;
            return thirties(from, to, closes || from.day === 31 ? 30 : from.day, last) / 360;
        }
        case 1:
            return start === end ? 0 : (end - start) / yearLength(start, end);
        case 2:
            return (end - start) / 360;
        case 3:
            return (end - start) / 365;
        case 4:
            return days360(start, end, true) / 360;
        default:
            return NUM;
    }
}

function thirties(from: CalendarDay, to: CalendarDay, first: number, last: number): number {
    return (to.year - from.year) * 360 + (to.month - from.month) * 30 + last - first;
}

// The days of the year a span is measured against. Up to a year apart that is 366 when the two dates are in one
// leap year or a 29 February lies from the one to the other; further apart it is the mean of the years touched.
function yearLength(start: number, end: number): number {
    const from = serialDate(start);
    const to = serialDate(end);
    const within =
        to.year === from.year ||
        (to.year === from.year + 1 && (to.month < from.month || (to.month === from.month && to.day <= from.day)));
    if (!within) return (dateSerial(to.year + 1, 1, 1) - dateSerial(from.year, 1, 1)) / (to.year - from.year + 1);
    if (to.year === from.year) return dateSerial(from.year + 1, 1, 1) - dateSerial(from.year, 1, 1);
    const leapDay = dateSerial(from.year, 2, 29);
    const nextLeapDay = dateSerial(to.year, 2, 29);
    const reached =
        (serialDate(leapDay).month === 2 && start <= leapDay) ||
        (serialDate(nextLeapDay).month === 2 && end >= nextLeapDay);
    return reached ? 366 : 365;
}
