// The functions on dates and times. A date is a serial number, so each of them is arithmetic on whole days, done
// by the date kernels, and the ones that ask what day or time it is get that from the pass, never from the
// machine. The functions that came with Excel's add-in refuse a boolean, the older ones read it as 1 or 0.

import { dateDif, days360, yearFraction } from '../values/date-spans';
import {
    dateOf,
    FIRST_SERIAL,
    isoWeek,
    LAST_SERIAL,
    SECONDS_IN_DAY,
    serialDate,
    shiftMonths,
    timeOf,
    weekdayNumber,
    weekNumber,
} from '../values/dates';
import { NUM, VALUE } from '../values/errors';
import { parseDateTime } from '../values/parse-number';
import { addWorkdays, countWorkdays } from '../values/workdays';
import {
    BOOLEAN,
    fn,
    INTEGER,
    NOW,
    NUMBER,
    NUMBERS,
    optional,
    PLAIN,
    SERIAL,
    skippable,
    strict,
    TEXT,
} from './registry';

// What a date with its time is made of, to the nearest second as Excel reads one: the last half second of a day
// is the next day. `part` gets the day and the seconds into it, which count up from midnight before serial 0 too.
function stamped(part: (day: number, second: number) => number) {
    return (serial: number) => {
        const seconds = Math.round(serial * SECONDS_IN_DAY);
        const day = Math.floor(seconds / SECONDS_IN_DAY);
        return day < FIRST_SERIAL || day > LAST_SERIAL ? NUM : part(day, seconds - day * SECONDS_IN_DAY);
    };
}

// A text that is a date or a time, as its serial. A date without a year is of the year of the pass.
function typed(text: string, now: number) {
    return parseDateTime(text, serialDate(Math.floor(now)).year);
}

const STRICT_DATE = strict(SERIAL);
const HOLIDAYS = optional(NUMBERS);
// Saturday and Sunday, as a weekend code of the INTL functions.
const WEEKEND = 1;

export const DATE_TIME = [
    fn('DATE', [NUMBER, NUMBER, NUMBER], dateOf),
    fn('TIME', [NUMBER, NUMBER, NUMBER], timeOf),
    fn('NOW', [NOW], (now) => now),
    fn('TODAY', [NOW], Math.floor),
    fn('DATEVALUE', [TEXT, NOW], (text, now) => {
        const serial = typed(text, now);
        return serial === undefined ? VALUE : Math.floor(serial);
    }),
    fn('TIMEVALUE', [TEXT, NOW], (text, now) => {
        const serial = typed(text, now);
        return serial === undefined ? VALUE : serial - Math.floor(serial);
    }),
    fn(
        'YEAR',
        [NUMBER],
        stamped((day) => serialDate(day).year),
    ),
    fn(
        'MONTH',
        [NUMBER],
        stamped((day) => serialDate(day).month),
    ),
    fn(
        'DAY',
        [NUMBER],
        stamped((day) => serialDate(day).day),
    ),
    fn(
        'HOUR',
        [NUMBER],
        stamped((_day, second) => Math.floor(second / 3600)),
    ),
    fn(
        'MINUTE',
        [NUMBER],
        stamped((_day, second) => Math.floor((second % 3600) / 60)),
    ),
    fn(
        'SECOND',
        [NUMBER],
        stamped((_day, second) => second % 60),
    ),
    fn('WEEKDAY', [SERIAL, optional(INTEGER, 1)], weekdayNumber),
    fn('WEEKNUM', [STRICT_DATE, skippable(strict(INTEGER), 1)], weekNumber),
    fn('ISOWEEKNUM', [SERIAL], isoWeek),
    fn('EDATE', [STRICT_DATE, strict(INTEGER)], (serial, months) => shiftMonths(serial, months, false)),
    fn('EOMONTH', [STRICT_DATE, strict(INTEGER)], (serial, months) => shiftMonths(serial, months, true)),
    fn('DATEDIF', [SERIAL, SERIAL, TEXT], dateDif),
    fn('DAYS', [SERIAL, SERIAL], (end, start) => end - start),
    fn('DAYS360', [SERIAL, SERIAL, optional(BOOLEAN, false)], days360),
    fn('YEARFRAC', [STRICT_DATE, STRICT_DATE, optional(strict(INTEGER), 0)], yearFraction),
    fn('NETWORKDAYS', [STRICT_DATE, STRICT_DATE, HOLIDAYS], (start, end, holidays) =>
        countWorkdays(start, end, WEEKEND, holidays.list()),
    ),
    fn(
        'NETWORKDAYS.INTL',
        [STRICT_DATE, STRICT_DATE, skippable(PLAIN, WEEKEND), HOLIDAYS],
        (start, end, weekend, holidays) => countWorkdays(start, end, weekend, holidays.list()),
    ),
    fn('WORKDAY', [STRICT_DATE, strict(NUMBER), HOLIDAYS], (start, days, holidays) =>
        addWorkdays(start, days, WEEKEND, holidays.list()),
    ),
    fn(
        'WORKDAY.INTL',
        [STRICT_DATE, strict(NUMBER), skippable(PLAIN, WEEKEND), HOLIDAYS],
        (start, days, weekend, holidays) => addWorkdays(start, days, weekend, holidays.list()),
    ),
];
