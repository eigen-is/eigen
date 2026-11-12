// Dates as Excel counts them: a serial number is the days since the last day of 1899, in a calendar that is the
// real one except that 1900 has a 29 February, serial 60. So serial 0 reads as day 0 of January 1900 and weekdays
// before March 1900 are a day off, as in Excel. The time of day is the serial's fraction. Which serials are dates,
// and which day a serial is, is said here once: FIRST_SERIAL, LAST_SERIAL, dateSerial and serialDate. Whoever
// reads a date, such as a date function or the reading of a typed one, goes through those, without the host's Date.

import type { FormulaError } from './errors';
import { NUM } from './errors';

// Day 0 of January 1900, the first date Excel has, and 31 December 9999, the last.
export const FIRST_SERIAL = 0;
export const LAST_SERIAL = 2958465;

export const SECONDS_IN_DAY = 86400;

export type CalendarDay = { readonly year: number; readonly month: number; readonly day: number };

// Days of the year before each month, in a year without a leap day.
const DAYS_BEFORE_MONTH = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];

// The largest hour, minute, second and day TIME and DATE take; a month must stay under it.
const MOST = 32767;

// The serial of a year, month and day: a month outside 1 to 12 moves the year, and a day outside the month counts
// on from its first day. The result is below FIRST_SERIAL or past LAST_SERIAL for a date Excel does not have.
export function dateSerial(year: number, month: number, day: number): number {
    const monthIndex = (((month - 1) % 12) + 12) % 12;
    const inYear = year + Math.floor((month - 1) / 12);
    const leapDay = monthIndex > 1 && hasLeapDay(inYear) ? 1 : 0;
    return firstSerial(inYear) + DAYS_BEFORE_MONTH[monthIndex] + leapDay + day - 1;
}

// The day a serial is. The year is found by the mean length of one, which names the right year or the one after.
export function serialDate(serial: number): CalendarDay {
    const guess = 1900 + Math.floor(serial / 365.2425);
    const year = firstSerial(guess) > serial ? Math.max(1900, guess - 1) : guess;
    const leap = hasLeapDay(year);
    const dayOfYear = serial - firstSerial(year);
    let month = 1;
    while (month < 12 && dayOfYear >= DAYS_BEFORE_MONTH[month] + (leap && month > 1 ? 1 : 0)) month += 1;
    return { year, month, day: dayOfYear - DAYS_BEFORE_MONTH[month - 1] - (leap && month > 2 ? 1 : 0) + 1 };
}

// The days of a month in the real calendar, where February 1900 has 28. `month` is 1 to 12.
export function daysInMonth(year: number, month: number): number {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return month === 2 && leap ? 29 : DAYS_BEFORE_MONTH[month] - DAYS_BEFORE_MONTH[month - 1];
}

// DATE: each part is cut down to a whole number, and a year under 1900 counts from 1900.
export function dateOf(year: number, month: number, day: number): number | FormulaError {
    const whole = Math.floor(year);
    if (whole < 0 || month >= MOST) return NUM;
    const serial = dateSerial(whole < 1900 ? whole + 1900 : whole, Math.floor(month), Math.min(Math.floor(day), MOST));
    return serial < FIRST_SERIAL || serial > LAST_SERIAL ? NUM : serial;
}

// TIME: each part is cut down to a whole number, and what the whole days leave is the time.
export function timeOf(hours: number, minutes: number, seconds: number): number | FormulaError {
    const hour = Math.floor(hours);
    const minute = Math.floor(minutes);
    const second = Math.floor(seconds);
    const days = (hour * 3600 + minute * 60 + second) / SECONDS_IN_DAY;
    return hour > MOST || minute > MOST || second > MOST || days < 0 ? NUM : days - Math.floor(days);
}

// The same day `months` months on, or with `toEnd` the last day of that month. EDATE and EOMONTH go by the real
// calendar: a day past the end of the month is its last day, and that is the 28th in February 1900.
export function shiftMonths(serial: number, months: number, toEnd: boolean): number | FormulaError {
    const date = serialDate(serial);
    const index = date.month - 1 + months;
    const year = date.year + Math.floor(index / 12);
    const month = (((index % 12) + 12) % 12) + 1;
    const first = dateSerial(year, month, 1);
    const length = daysInMonth(year, month);
    const result = first + (toEnd ? length : Math.min(date.day, length)) - 1;
    return first < FIRST_SERIAL || result > LAST_SERIAL ? NUM : result;
}

// 0 for Monday to 6 for Sunday.
export function weekdayFromMonday(serial: number): number {
    return (serial + 5) % 7;
}

// WEEKDAY: the day's number in a week that `type` says how to count; 3 counts from 0 on Monday.
export function weekdayNumber(serial: number, type: number): number | FormulaError {
    const first = type === 3 ? 0 : weekStart(type);
    return first < 0 ? NUM : ((weekdayFromMonday(serial) - first + 7) % 7) + (type === 3 ? 0 : 1);
}

// WEEKNUM: the week of 1 January is week 1 and a week starts on the day `type` names; 21 is the ISO week.
export function weekNumber(serial: number, type: number): number | FormulaError {
    if (type === 21) return isoWeek(serial);
    const first = weekStart(type);
    if (first < 0) return NUM;
    const january = dateSerial(serialDate(serial).year, 1, 1);
    return Math.floor((serial - january + ((weekdayFromMonday(january) - first + 7) % 7)) / 7) + 1;
}

// A week runs from Monday and belongs to the year its Thursday is in.
export function isoWeek(serial: number): number {
    const thursday = serial - weekdayFromMonday(serial) + 3;
    return Math.floor((thursday - dateSerial(serialDate(thursday).year, 1, 1)) / 7) + 1;
}

// The day a week starts on, 0 for Monday, by the type WEEKDAY and WEEKNUM share, or -1 for a type that is none.
function weekStart(type: number): number {
    return type === 1 ? 6 : type === 2 ? 0 : type >= 11 && type <= 17 ? type - 11 : -1;
}

function hasLeapDay(year: number): boolean {
    return year === 1900 || daysInMonth(year, 2) === 29;
}

// The serial of 1 January: 365 days a year from 1900, the leap days of the years before it, and Excel's own one.
function firstSerial(year: number): number {
    const before = year - 1;
    const leapDays = Math.floor(before / 4) - Math.floor(before / 100) + Math.floor(before / 400) - 460;
    return 1 + 365 * (year - 1900) + leapDays + (year > 1900 ? 1 : 0);
}
