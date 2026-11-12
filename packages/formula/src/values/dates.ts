// Dates as numbers: a serial is the days since 30 December 1899 in the one real calendar, negative before it,
// which is Google's count and from 1 March 1900 on Excel's too. The time of day is the part above the whole day,
// so -0.25 is 18:00 on the day before. Which serials are dates, and which day a serial is, is said here once:
// FIRST_SERIAL, LAST_SERIAL and isDate, dateSerial and serialDate. Whoever reads a date, such as a date function or
// the reading of a typed one, goes through those, without the host's Date.

import type { FormulaError } from './errors';
import { NUM } from './errors';

// 1 January of the year 1 and 31 December 9999.
export const FIRST_SERIAL = -693593;
export const LAST_SERIAL = 2958465;

export const SECONDS_IN_DAY = 86400;

export type CalendarDay = { readonly year: number; readonly month: number; readonly day: number };

// Days of the year before each month, in a year without a leap day.
const DAYS_BEFORE_MONTH = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];

// A part of TIME and DATE is a 16-bit number to Excel, this the largest: an hour, a minute, a second and a day
// go up to it, and a month stays under it and above the smallest.
const LARGEST_PART = 32767;

// Whether a whole day is a date. A day that is no number is none.
export function isDate(day: number): boolean {
    return day >= FIRST_SERIAL && day <= LAST_SERIAL;
}

// The serial of a year, month and day: a month outside 1 to 12 moves the year, and a day outside the month counts
// on from its first day. The result is below FIRST_SERIAL or past LAST_SERIAL for a date outside the calendar.
export function dateSerial(year: number, month: number, day: number): number {
    const monthIndex = (((month - 1) % 12) + 12) % 12;
    const inYear = year + Math.floor((month - 1) / 12);
    const leapDay = monthIndex > 1 && isLeapYear(inYear) ? 1 : 0;
    return firstSerial(inYear) + DAYS_BEFORE_MONTH[monthIndex] + leapDay + day - 1;
}

// The day a serial is. The year is found by the mean length of one, which names the right year or the one before.
export function serialDate(serial: number): CalendarDay {
    const guess = 1 + Math.floor((serial - FIRST_SERIAL) / 365.2425);
    const year = firstSerial(guess + 1) > serial ? guess : guess + 1;
    const leap = isLeapYear(year);
    const dayOfYear = serial - firstSerial(year);
    let month = 1;
    while (month < 12 && dayOfYear >= DAYS_BEFORE_MONTH[month] + (leap && month > 1 ? 1 : 0)) month += 1;
    return { year, month, day: dayOfYear - DAYS_BEFORE_MONTH[month - 1] - (leap && month > 2 ? 1 : 0) + 1 };
}

export function isLeapYear(year: number): boolean {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

// `month` is 1 to 12.
export function daysInMonth(year: number, month: number): number {
    return month === 2 && isLeapYear(year) ? 29 : DAYS_BEFORE_MONTH[month] - DAYS_BEFORE_MONTH[month - 1];
}

// DATE: each part is cut down to a whole number, and a year under 1000 counts from 1900. A day past the largest
// part counts as the largest, as Excel has it, until it is more days than the calendar has.
export function dateOf(year: number, month: number, day: number): number | FormulaError {
    const whole = Math.floor(year);
    const months = Math.floor(month);
    if (whole < 0 || months >= LARGEST_PART || months < -LARGEST_PART) return NUM;
    if (day > LAST_SERIAL - FIRST_SERIAL + 1) return NUM;
    const serial = dateSerial(whole < 1000 ? whole + 1900 : whole, months, Math.min(Math.floor(day), LARGEST_PART));
    return isDate(serial) ? serial : NUM;
}

// TIME: each part is cut down to a whole number, and what the whole days leave is the time. A part below the
// smallest 16-bit number comes round to the largest, as Excel has it: -32769 minutes are 32767.
export function timeOf(hours: number, minutes: number, seconds: number): number | FormulaError {
    const hour = timePart(hours);
    const minute = timePart(minutes);
    const second = timePart(seconds);
    const days = (hour * 3600 + minute * 60 + second) / SECONDS_IN_DAY;
    if (hour > LARGEST_PART || minute > LARGEST_PART || second > LARGEST_PART || days < 0) return NUM;
    return days - Math.floor(days);
}

// The same day `months` months on, or with `toEnd` the last day of that month. A day past the end of the month
// is its last day.
export function shiftMonths(serial: number, months: number, toEnd: boolean): number | FormulaError {
    const date = serialDate(serial);
    const index = date.month - 1 + months;
    const year = date.year + Math.floor(index / 12);
    const month = (((index % 12) + 12) % 12) + 1;
    const first = dateSerial(year, month, 1);
    const length = daysInMonth(year, month);
    const result = first + (toEnd ? length : Math.min(date.day, length)) - 1;
    return isDate(result) ? result : NUM;
}

// 0 for Monday to 6 for Sunday.
export function weekdayFromMonday(serial: number): number {
    return (((serial + 5) % 7) + 7) % 7;
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

function timePart(part: number): number {
    const whole = Math.floor(part);
    return whole < -LARGEST_PART - 1 ? whole + 2 * (LARGEST_PART + 1) : whole;
}

// The serial of 1 January: 365 days for each year before it, and their leap days.
function firstSerial(year: number): number {
    const before = year - 1;
    return FIRST_SERIAL + 365 * before + Math.floor(before / 4) - Math.floor(before / 100) + Math.floor(before / 400);
}
