// Working days, as NETWORKDAYS and WORKDAY count them and their INTL forms with a week of the caller's choosing:
// the days of a span that are neither in the weekend nor a holiday, and the day a number of working days on. Both
// work by whole weeks and a rest of under one, so their cost does not grow with the span.

import { isDate, weekdayFromMonday } from './dates';
import type { FormulaError } from './errors';
import { NUM, VALUE } from './errors';
import type { Plain } from './value';

const SIGNS = '01';

// The working days from `start` to `end`, both counted, and negative when the end comes first.
export function countWorkdays(
    start: number,
    end: number,
    weekend: Plain | null,
    holidays: Float64Array,
): number | FormulaError {
    const off = daysOff(weekend);
    if (typeof off !== 'number') return off;
    if (!flooredToDates(holidays)) return NUM;
    const from = Math.min(start, end);
    const to = Math.max(start, end);
    const weeks = Math.floor((to - from + 1) / 7);
    let count = weeks * workingIn(off);
    for (let day = from + weeks * 7; day <= to; day += 1) if (works(day, off)) count += 1;
    let last = Number.NaN;
    for (const holiday of holidays.sort()) {
        if (holiday !== last && holiday >= from && holiday <= to && works(holiday, off)) count -= 1;
        last = holiday;
    }
    return start > end ? -count : count;
}

// The day `days` working days after `start`, or before it when negative. The start itself need not be one.
export function addWorkdays(
    start: number,
    days: number,
    weekend: Plain | null,
    holidays: Float64Array,
): number | FormulaError {
    const count = Math.floor(days);
    if (count === 0) return start;
    const off = daysOff(weekend);
    if (typeof off !== 'number') return off;
    const perWeek = workingIn(off);
    if (perWeek === 0) return VALUE;
    if (!flooredToDates(holidays)) return NUM;
    const step = count < 0 ? -1 : 1;
    // Whole weeks first, keeping at least one day to walk so that the walk ends on a working day.
    const weeks = Math.trunc((count - step) / perWeek);
    let day = start + weeks * 7;
    if (!isDate(day)) return NUM;
    for (let left = Math.abs(count - weeks * perWeek); left > 0; left -= 1) day = next(day, step, off);
    // Each holiday met on the way pushes the end one working day on, which may meet the next.
    holidays.sort();
    let last = Number.NaN;
    for (let at = 0; at < holidays.length; at += 1) {
        const holiday = holidays[step > 0 ? at : holidays.length - 1 - at];
        if (holiday !== last && (holiday - start) * step > 0 && (day - holiday) * step >= 0 && works(holiday, off)) {
            day = next(day, step, off);
        }
        last = holiday;
    }
    return isDate(day) ? day : NUM;
}

// The days off as seven bits, Monday the lowest. A code 1 to 7 is two days from Saturday and Sunday on, 11 to 17
// one day from Sunday on; a text names each day from Monday with 1 for off.
function daysOff(weekend: Plain | null): number | FormulaError {
    if (typeof weekend === 'string') {
        if (weekend.length !== 7) return VALUE;
        let off = 0;
        for (let day = 0; day < 7; day += 1) {
            const sign = SIGNS.indexOf(weekend[day]);
            if (sign < 0) return VALUE;
            off |= sign << day;
        }
        return off;
    }
    const code = weekend === true ? 1 : typeof weekend === 'number' ? Math.trunc(weekend) : 0;
    if (code >= 1 && code <= 7) return (1 << ((code + 4) % 7)) | (1 << ((code + 5) % 7));
    return code >= 11 && code <= 17 ? 1 << ((code + 2) % 7) : NUM;
}

function workingIn(off: number): number {
    let count = 0;
    for (let day = 0; day < 7; day += 1) count += 1 - ((off >> day) & 1);
    return count;
}

function works(day: number, off: number): boolean {
    return ((off >> weekdayFromMonday(day)) & 1) === 0;
}

function next(day: number, step: number, off: number): number {
    let at = day + step;
    while (!works(at, off)) at += step;
    return at;
}

// Cuts each holiday down to its day, in place, and says whether every one is a date.
function flooredToDates(holidays: Float64Array): boolean {
    for (let at = 0; at < holidays.length; at += 1) {
        holidays[at] = Math.floor(holidays[at]);
        if (!isDate(holidays[at])) return false;
    }
    return true;
}
