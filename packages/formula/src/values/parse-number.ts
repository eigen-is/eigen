// Text read as a number, the way a person could type one into a cell: a plain or decorated number, a fraction, a
// date or a time, in one fixed notation (a point for decimals, a comma between thousands, the month before the
// day). Whatever coerces text, such as an operator or a criterion, does it through parseNumber, so what coerces is
// what could have been typed, and DATEVALUE and TIMEVALUE read only the dates and times through parseDateTime. It
// reads character codes and never asks the host: no Date and no clock, so the year of a date without one is given.

import { dateSerial, daysInMonth, isDate, SECONDS_IN_DAY } from './dates';
import { POWERS_OF_TEN } from './precision';

const SPACE = 32;
const DOLLAR = 36;
const PERCENT = 37;
const OPEN = 40;
const CLOSE = 41;
const PLUS = 43;
const COMMA = 44;
const MINUS = 45;
const POINT = 46;
const SLASH = 47;
const ZERO = 48;
const NINE = 57;
const COLON = 58;
const LOWER_A = 97;
const LOWER_E = 101;
const LOWER_M = 109;
const LOWER_P = 112;
const LOWER_Z = 122;
const ARABIC_ZERO = 1632;
const EURO = 8364;

// A typed number keeps this many significant digits; the digits after them count as zeros.
const DIGITS_KEPT = 15;

// Excel has no number under the smallest normal one: a typed number under it is 0, as 1E-308 and 1E-309 are, and
// one under the last of those that Excel is known to take is no number, as 1E-320 is none.
const SMALLEST_NORMAL = 2.2250738585072014e-308;
const SMALLEST_TYPED = 1e-309;

// A year under 100 is in the 2000s below this and in the 1900s from it on, however many digits it was written in.
const YEAR_PIVOT = 30;

const MONTHS = [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
];

// The number, or undefined for text that is none, the empty string included. A date without a year is none here.
export function parseNumber(text: string): number | undefined {
    const end = contentEnd(text);
    const start = spacesEnd(text, 0);
    if (start >= end) return undefined;
    return (
        readDecorated(text, start, end) ?? readFraction(text, start, end) ?? readDateTime(text, start, end, undefined)
    );
}

// The serial of a text that is a date, a time or both, and undefined for any other, a plain number included. A
// date without a year is of `year`.
export function parseDateTime(text: string, year: number): number | undefined {
    const end = contentEnd(text);
    const start = spacesEnd(text, 0);
    return start >= end ? undefined : readDateTime(text, start, end, year);
}

// Digits with what may stand around them: a sign in front or a pair of brackets, a currency sign in front or a
// euro sign behind, commas between groups of three, a decimal point, an exponent and a percent sign, which may
// follow the brackets. The digits may be Arabic-Indic ones.
function readDecorated(text: string, start: number, end: number): number | undefined {
    let at = start;
    const bracketed = text.charCodeAt(at) === OPEN;
    if (bracketed) at += 1;
    let negative = bracketed;
    let signed = bracketed;
    let currency = false;
    for (; at < end; at += 1) {
        const code = text.charCodeAt(at);
        if (!signed && (code === MINUS || code === PLUS)) {
            signed = true;
            negative = code === MINUS;
        } else if (!currency && (code === DOLLAR || code === EURO)) {
            currency = true;
            at = spacesEnd(text, at + 1) - 1;
        } else break;
    }

    let mantissa = 0;
    let kept = 0;
    let scale = 0;
    let digits = 0;
    let group = -1;
    for (; at < end; at += 1) {
        const code = text.charCodeAt(at);
        if (code === COMMA) {
            if (digits === 0 || (group < 0 ? digits > 3 : group !== 3)) return undefined;
            group = 0;
        } else if (digitOf(code) >= 0) {
            digits += 1;
            if (group >= 0) group += 1;
            if (kept === DIGITS_KEPT) scale += 1;
            else {
                mantissa = mantissa * 10 + digitOf(code);
                if (mantissa > 0) kept += 1;
            }
        } else break;
    }
    if (group >= 0 && group !== 3) return undefined;
    if (text.charCodeAt(at) === POINT) {
        for (at += 1; at < end; at += 1) {
            const digit = digitOf(text.charCodeAt(at));
            if (digit < 0) break;
            digits += 1;
            if (kept === DIGITS_KEPT) continue;
            mantissa = mantissa * 10 + digit;
            if (mantissa > 0) kept += 1;
            scale -= 1;
        }
    }
    if (digits === 0) return undefined;

    if ((text.charCodeAt(at) | 32) === LOWER_E) {
        const sign = text.charCodeAt(at + 1);
        const from = sign === MINUS || sign === PLUS ? at + 2 : at + 1;
        const to = digitsEnd(text, from, end);
        if (to === from) return undefined;
        const exponent = Math.min(toWhole(text, from, to), 9999);
        scale += sign === MINUS ? -exponent : exponent;
        at = to;
    }
    const inside = percentEnd(text, at, end);
    let percent = inside > at;
    at = inside;
    if (!currency && at < end && text.charCodeAt(at) === EURO) at += 1;
    if (bracketed) {
        if (text.charCodeAt(at) !== CLOSE) return undefined;
        at += 1;
        if (!percent) {
            const outside = percentEnd(text, at, end);
            percent = outside > at;
            at = outside;
        }
    }
    if (at !== end) return undefined;
    if (percent) scale -= 2;

    const power = POWERS_OF_TEN[Math.abs(scale)];
    const value =
        power === undefined ? Number(`${mantissa}e${scale}`) : scale < 0 ? mantissa / power : mantissa * power;
    if (value === Infinity || (mantissa > 0 && value < SMALLEST_TYPED)) return undefined;
    if (value < SMALLEST_NORMAL) return 0;
    return negative ? -value : value;
}

// A whole number, spaces and a fraction, as in 1 1/2. A fraction alone is not one: Excel reads 1/2 as a date.
// Digits without end add up to no number, and then the text is none.
function readFraction(text: string, start: number, end: number): number | undefined {
    const negative = text.charCodeAt(start) === MINUS;
    const wholeAt = negative ? start + 1 : start;
    const wholeEnd = digitsEnd(text, wholeAt, end);
    const topAt = spacesEnd(text, wholeEnd);
    const topEnd = digitsEnd(text, topAt, end);
    const bottomEnd = digitsEnd(text, topEnd + 1, end);
    if (wholeEnd === wholeAt || topEnd === topAt || text.charCodeAt(topEnd) !== SLASH) return undefined;
    if (bottomEnd !== end || bottomEnd === topEnd + 1) return undefined;
    const bottom = toWhole(text, topEnd + 1, bottomEnd);
    if (bottom === 0) return undefined;
    const value = toWhole(text, wholeAt, wholeEnd) + toWhole(text, topAt, topEnd) / bottom;
    if (!Number.isFinite(value)) return undefined;
    return negative && value !== 0 ? -value : value;
}

// A date, a time, or a date, spaces and a time. The time is found from its colon or its AM or PM, the date is
// what stands before it. A time that carries the last date into the next day leaves no date.
function readDateTime(text: string, start: number, end: number, thisYear: number | undefined): number | undefined {
    const markAt = (text.charCodeAt(end - 1) | 32) === LOWER_M ? end - 2 : end - 1;
    const mark = text.charCodeAt(markAt) | 32;
    let half = 0;
    let timeEnd = end;
    if (markAt > start && (mark === LOWER_A || mark === LOWER_P) && text.charCodeAt(markAt - 1) === SPACE) {
        half = mark === LOWER_A ? 1 : 2;
        timeEnd = markAt;
        while (text.charCodeAt(timeEnd - 1) === SPACE) timeEnd -= 1;
    }
    const colon = text.indexOf(':', start);
    const timed = colon >= 0 && colon < timeEnd;
    if (!timed && half === 0) return readDate(text, start, end, thisYear);

    let timeAt = timed ? colon : timeEnd;
    while (timed && text.charCodeAt(timeAt - 1) === SPACE) timeAt -= 1;
    while (timeAt > start && isDigit(text.charCodeAt(timeAt - 1))) timeAt -= 1;
    const time = readTime(text, timeAt, timeEnd, half);
    if (time === undefined || timeAt === start) return time;
    let dateEnd = timeAt;
    while (text.charCodeAt(dateEnd - 1) === SPACE) dateEnd -= 1;
    const date = readDate(text, start, dateEnd, thisYear);
    return date === undefined || !isDate(Math.floor(date + time)) ? undefined : date + time;
}

// Three parts: year, month and day with / or - between them, the year first when it has four digits and else the
// month first; a day, a month by name and a year; a month by name, a day, a comma and a year. Two parts: a month
// by name and a year of four digits, which is its first day, or a month and a day of `thisYear`. A year has up to
// four digits and is the year it says from 100 on.
function readDate(text: string, from: number, to: number, thisYear: number | undefined): number | undefined {
    const named = !isDigit(text.charCodeAt(from));
    const firstEnd = named ? lettersEnd(text, from, to) : digitsEnd(text, from, to);
    const between = text.charCodeAt(firstEnd);
    const secondAt = between === SPACE ? spacesEnd(text, firstEnd) : firstEnd + 1;
    const secondNamed = !isDigit(text.charCodeAt(secondAt));
    const secondEnd = secondNamed ? lettersEnd(text, secondAt, to) : digitsEnd(text, secondAt, to);
    if (firstEnd === from || secondEnd === secondAt || (named && secondNamed)) return undefined;
    if (between !== SLASH && between !== MINUS && !(between === SPACE && (named || secondNamed))) return undefined;
    const first = named ? monthNamed(text, from, firstEnd) : toWhole(text, from, firstEnd);
    const second = secondNamed ? monthNamed(text, secondAt, secondEnd) : toWhole(text, secondAt, secondEnd);
    let year = first;
    let month = second;
    let day = 1;
    if (secondEnd === to) {
        if (named && to - secondAt === 4) {
            year = second;
            month = first;
        } else {
            if (thisYear === undefined) return undefined;
            year = thisYear;
            month = secondNamed ? second : first;
            day = secondNamed ? first : second;
            // A day that month does not have that year is a year of two digits and its first day, as Excel
            // reads 2/29 in a year without a leap day: February 2029.
            if (month >= 1 && month <= 12 && day < 100 && day > daysInMonth(year, month)) {
                year = day;
                day = 1;
            }
        }
    } else {
        const thirdAt = named ? spacesEnd(text, secondEnd + 1) : secondEnd + 1;
        if (text.charCodeAt(secondEnd) !== (named ? COMMA : between)) return undefined;
        if (thirdAt >= to || digitsEnd(text, thirdAt, to) !== to) return undefined;
        day = toWhole(text, thirdAt, to);
        if (secondNamed || firstEnd - from !== 4) {
            if (to - thirdAt > 4 || (named && to - thirdAt !== 4)) return undefined;
            year = day;
            month = secondNamed ? second : first;
            day = secondNamed ? first : second;
        }
    }
    if (year < 100) year += year < YEAR_PIVOT ? 2000 : 1900;
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined;
    const serial = dateSerial(year, month, day);
    return isDate(serial) ? serial : undefined;
}

// Hours, then minutes, seconds and parts of a second if given, as a fraction of a day. `half` is 1 for AM, 2 for PM
// and 0 for a 24 hour time, which may count hours past 24. Minutes and seconds have one or two digits, and past 59
// they are carried into the hour or the minute.
function readTime(text: string, from: number, to: number, half: number): number | undefined {
    const hoursEnd = digitsEnd(text, from, to);
    if (hoursEnd === from || hoursEnd - from > 4) return undefined;
    let hours = toWhole(text, from, hoursEnd);
    let minutes = 0;
    let seconds = 0;
    if (hoursEnd < to) {
        // Spaces may stand around the colon after the hours, as in 4 : 35.
        const colon = spacesEnd(text, hoursEnd);
        const minutesAt = spacesEnd(text, colon + 1);
        const minutesEnd = digitsEnd(text, minutesAt, to);
        if (text.charCodeAt(colon) !== COLON || !isPair(minutesEnd - minutesAt)) return undefined;
        minutes = toWhole(text, minutesAt, minutesEnd);
        if (minutesEnd < to) {
            const secondsEnd = digitsEnd(text, minutesEnd + 1, to);
            if (text.charCodeAt(minutesEnd) !== COLON || !isPair(secondsEnd - minutesEnd - 1)) return undefined;
            seconds = toWhole(text, minutesEnd + 1, secondsEnd);
            if (secondsEnd < to) {
                const parts = POWERS_OF_TEN[to - secondsEnd - 1];
                if (text.charCodeAt(secondsEnd) !== POINT || secondsEnd + 1 === to || parts === undefined)
                    return undefined;
                if (digitsEnd(text, secondsEnd + 1, to) !== to) return undefined;
                seconds += toWhole(text, secondsEnd + 1, to) / parts;
            }
        }
    }
    if (half !== 0) {
        if (hours > 12) return undefined;
        hours = (hours % 12) + (half === 2 ? 12 : 0);
    }
    return (hours * 3600 + minutes * 60 + seconds) / SECONDS_IN_DAY;
}

// 1 to 12 for a month's full name or its first three letters, in any case, and 0 for anything else.
function monthNamed(text: string, from: number, to: number): number {
    let month = 0;
    for (const name of MONTHS) {
        month += 1;
        if (to - from !== 3 && to - from !== name.length) continue;
        let at = from;
        while (at < to && (text.charCodeAt(at) | 32) === name.charCodeAt(at - from)) at += 1;
        if (at === to) return month;
    }
    return 0;
}

// 0 to 9 for a digit, Arabic-Indic ones included, and -1 for anything else.
function digitOf(code: number): number {
    if (code >= ARABIC_ZERO && code <= ARABIC_ZERO + 9) return code - ARABIC_ZERO;
    return isDigit(code) ? code - ZERO : -1;
}

// Past spaces and one percent sign, or `from` when no percent sign follows.
function percentEnd(text: string, from: number, to: number): number {
    const at = spacesEnd(text, from);
    return at < to && text.charCodeAt(at) === PERCENT ? at + 1 : from;
}

function contentEnd(text: string): number {
    let end = text.length;
    while (end > 0 && text.charCodeAt(end - 1) === SPACE) end -= 1;
    return end;
}

function spacesEnd(text: string, from: number): number {
    let at = from;
    while (text.charCodeAt(at) === SPACE) at += 1;
    return at;
}

// Whether a count of digits is one minutes or seconds may be written in.
function isPair(digits: number): boolean {
    return digits === 1 || digits === 2;
}

function isDigit(code: number): boolean {
    return code >= ZERO && code <= NINE;
}

function digitsEnd(text: string, from: number, to: number): number {
    let at = from;
    while (at < to && isDigit(text.charCodeAt(at))) at += 1;
    return at;
}

function lettersEnd(text: string, from: number, to: number): number {
    let at = from;
    while (at < to && (text.charCodeAt(at) | 32) >= LOWER_A && (text.charCodeAt(at) | 32) <= LOWER_Z) at += 1;
    return at;
}

function toWhole(text: string, from: number, to: number): number {
    let value = 0;
    for (let at = from; at < to; at += 1) value = value * 10 + text.charCodeAt(at) - ZERO;
    return value;
}
