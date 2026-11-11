// Dates as Excel counts them: a serial number is the days since the last day of 1899, in a calendar that is the
// real one except that 1900 has a 29 February, serial 60. So serial 0 reads as day 0 of January 1900 and weekdays
// before March 1900 are a day off, as in Excel. The time of day is the serial's fraction. Whoever reads a date,
// such as the reading of a typed one, does its arithmetic here, on whole numbers and without the host's Date.

import type { FormulaError } from './errors';
import { NUM } from './errors';

// 31 December 9999, the last date Excel has.
export const LAST_SERIAL = 2958465;

const SECONDS_IN_DAY = 86400;

// Days of the year before each month, in a year without a leap day.
const DAYS_BEFORE_MONTH = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];

export function isLeapYear(year: number): boolean {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0 || year === 1900);
}

// `month` is 1 to 12.
export function daysInMonth(year: number, month: number): number {
    return month === 2 && isLeapYear(year) ? 29 : DAYS_BEFORE_MONTH[month] - DAYS_BEFORE_MONTH[month - 1];
}

// The serial of a year, month and day as DATE reads them: a month outside 1 to 12 moves the year, and a day outside
// the month counts on from its first day. The result is below 0 or past LAST_SERIAL for a date Excel does not have.
export function dateSerial(year: number, month: number, day: number): number {
    const monthIndex = (((month - 1) % 12) + 12) % 12;
    const inYear = year + Math.floor((month - 1) / 12);
    const leapDay = monthIndex > 1 && isLeapYear(inYear) ? 1 : 0;
    return firstSerial(inYear) + DAYS_BEFORE_MONTH[monthIndex] + leapDay + day - 1;
}

// The date `months` months after a serial, on the last day of that month when the month is shorter, and #NUM!
// for a date Excel does not have.
export function addMonths(serial: number, months: number): number | FormulaError {
    const month = serialMonth(serial) + months;
    const year = serialYear(serial) + Math.floor((month - 1) / 12);
    const inYear = ((((month - 1) % 12) + 12) % 12) + 1;
    const result = dateSerial(year, inYear, Math.min(serialDay(serial), daysInMonth(year, inYear)));
    return year < 1900 || result > LAST_SERIAL ? NUM : result;
}

// The year by the mean length of one, which names the right year or the one after it.
export function serialYear(serial: number): number {
    const year = 1900 + Math.floor(serial / 365.2425);
    return firstSerial(year) > serial ? Math.max(1900, year - 1) : year;
}

// 1 to 12.
export function serialMonth(serial: number): number {
    const year = serialYear(serial);
    const leap = isLeapYear(year);
    const dayOfYear = serial - firstSerial(year);
    let month = 1;
    while (month < 12 && dayOfYear >= DAYS_BEFORE_MONTH[month] + (leap && month > 1 ? 1 : 0)) month += 1;
    return month;
}

// 1 to 31, and 0 for serial 0.
export function serialDay(serial: number): number {
    return serial - dateSerial(serialYear(serial), serialMonth(serial), 1) + 1;
}

// 1 for Sunday to 7 for Saturday.
export function weekday(serial: number): number {
    return ((serial + 6) % 7) + 1;
}

// A fraction of a day, and more than 1 from 24 hours on; each part may be any number.
export function timeSerial(hours: number, minutes: number, seconds: number): number {
    return (hours * 3600 + minutes * 60 + seconds) / SECONDS_IN_DAY;
}

// The time of day of a serial in whole seconds, 0 to 86399, to the nearest second as HOUR, MINUTE and SECOND read
// it: the last half second of a day is midnight.
export function secondOfDay(serial: number): number {
    return Math.round((serial - Math.floor(serial)) * SECONDS_IN_DAY) % SECONDS_IN_DAY;
}

// The serial of 1 January: 365 days a year from 1900, the leap days of the years before it, and Excel's own one.
function firstSerial(year: number): number {
    const before = year - 1;
    const leapDays = Math.floor(before / 4) - Math.floor(before / 100) + Math.floor(before / 400) - 460;
    return 1 + 365 * (year - 1900) + leapDays + (year > 1900 ? 1 : 0);
}
