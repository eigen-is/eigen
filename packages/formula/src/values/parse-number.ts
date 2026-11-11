// Text read as a number, the way a person could type one into a cell: a plain or decorated number, a fraction, a
// date or a time, in one fixed notation (a point for decimals, a comma between thousands, the month before the
// day). Whatever coerces text, such as an operator or a criterion, does it through parseNumber, so what coerces is
// what could have been typed. It reads character codes and never asks the host: no Number(text), no Date, no clock.

import { dateSerial, daysInMonth, timeSerial } from './dates';
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
const EURO = 8364;

// A typed number keeps this many significant digits; the digits after them count as zeros.
const DIGITS_KEPT = 15;

// A two digit year below this is in the 2000s, from it on in the 1900s.
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

// The number, or undefined for text that is none, the empty string included.
export function parseNumber(text: string): number | undefined {
    let end = text.length;
    while (end > 0 && text.charCodeAt(end - 1) === SPACE) end -= 1;
    let start = 0;
    while (start < end && text.charCodeAt(start) === SPACE) start += 1;
    if (start === end) return undefined;
    return readDecorated(text, start, end) ?? readFraction(text, start, end) ?? readDateTime(text, start, end);
}

// Digits with what may stand around them: a sign in front or a pair of brackets, a currency sign in front
// or behind, commas between groups of three, a decimal point, an exponent and a percent sign.
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
            while (text.charCodeAt(at + 1) === SPACE) at += 1;
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
        } else if (code >= ZERO && code <= NINE) {
            digits += 1;
            if (group >= 0) group += 1;
            if (kept === DIGITS_KEPT) scale += 1;
            else {
                mantissa = mantissa * 10 + code - ZERO;
                if (mantissa > 0) kept += 1;
            }
        } else break;
    }
    if (group >= 0 && group !== 3) return undefined;
    if (text.charCodeAt(at) === POINT) {
        for (at += 1; at < end; at += 1) {
            const code = text.charCodeAt(at);
            if (code < ZERO || code > NINE) break;
            digits += 1;
            if (kept === DIGITS_KEPT) continue;
            mantissa = mantissa * 10 + code - ZERO;
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
    let percentAt = at;
    while (text.charCodeAt(percentAt) === SPACE) percentAt += 1;
    if (percentAt < end && text.charCodeAt(percentAt) === PERCENT) {
        scale -= 2;
        at = percentAt + 1;
    }
    if (!currency && at < end && (text.charCodeAt(at) === DOLLAR || text.charCodeAt(at) === EURO)) at += 1;
    if (bracketed) {
        if (text.charCodeAt(at) !== CLOSE) return undefined;
        at += 1;
    }
    if (at !== end) return undefined;

    const power = POWERS_OF_TEN[Math.abs(scale)];
    const value =
        power === undefined ? Number(`${mantissa}e${scale}`) : scale < 0 ? mantissa / power : mantissa * power;
    if (value === Infinity) return undefined;
    return negative && value !== 0 ? -value : value;
}

// A whole number, spaces and a fraction, as in 1 1/2. A fraction alone is not one: Excel reads 1/2 as a date.
function readFraction(text: string, start: number, end: number): number | undefined {
    const negative = text.charCodeAt(start) === MINUS;
    const wholeAt = negative ? start + 1 : start;
    const wholeEnd = digitsEnd(text, wholeAt, end);
    let topAt = wholeEnd;
    while (text.charCodeAt(topAt) === SPACE) topAt += 1;
    const topEnd = digitsEnd(text, topAt, end);
    const bottomEnd = digitsEnd(text, topEnd + 1, end);
    if (wholeEnd === wholeAt || topEnd === topAt || text.charCodeAt(topEnd) !== SLASH) return undefined;
    if (bottomEnd !== end || bottomEnd === topEnd + 1) return undefined;
    const bottom = toWhole(text, topEnd + 1, bottomEnd);
    if (bottom === 0) return undefined;
    const value = toWhole(text, wholeAt, wholeEnd) + toWhole(text, topAt, topEnd) / bottom;
    return negative && value !== 0 ? -value : value;
}

// A date, a time, or a date, spaces and a time. The time is found from its colon or its AM or PM, the date is
// what stands before it.
function readDateTime(text: string, start: number, end: number): number | undefined {
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
    if (!timed && half === 0) return readDate(text, start, end);

    let timeAt = timed ? colon : timeEnd;
    while (timed && text.charCodeAt(timeAt - 1) === SPACE) timeAt -= 1;
    while (timeAt > start && isDigit(text.charCodeAt(timeAt - 1))) timeAt -= 1;
    const time = readTime(text, timeAt, timeEnd, half);
    if (time === undefined || timeAt === start) return time;
    let dateEnd = timeAt;
    while (text.charCodeAt(dateEnd - 1) === SPACE) dateEnd -= 1;
    const date = readDate(text, start, dateEnd);
    return date === undefined ? undefined : date + time;
}

// Year, month and day with / or - between them, the year first when it has four digits and else the month first;
// or a day, a month by name and a year; or a month by name, a day and a year.
function readDate(text: string, from: number, to: number): number | undefined {
    let year = 0;
    let month = 0;
    let day = 0;
    let yearDigits = 0;
    const firstEnd = digitsEnd(text, from, to);
    if (firstEnd === from) {
        const nameEnd = lettersEnd(text, from, to);
        let dayAt = nameEnd;
        while (text.charCodeAt(dayAt) === SPACE) dayAt += 1;
        const dayEnd = digitsEnd(text, dayAt, to);
        let yearAt = text.charCodeAt(dayEnd) === COMMA ? dayEnd + 1 : dayEnd;
        while (text.charCodeAt(yearAt) === SPACE) yearAt += 1;
        if (dayAt === nameEnd || dayEnd === dayAt || yearAt === dayEnd || digitsEnd(text, yearAt, to) !== to) {
            return undefined;
        }
        month = monthNamed(text, from, nameEnd);
        day = toWhole(text, dayAt, dayEnd);
        year = toWhole(text, yearAt, to);
        yearDigits = to - yearAt === 4 ? 4 : 0;
    } else {
        const between = text.charCodeAt(firstEnd);
        const secondAt = firstEnd + 1;
        const named = !isDigit(text.charCodeAt(secondAt));
        const secondEnd = named ? lettersEnd(text, secondAt, to) : digitsEnd(text, secondAt, to);
        const thirdAt = secondEnd + 1;
        if (between !== SLASH && between !== MINUS && !(named && between === SPACE)) return undefined;
        if (text.charCodeAt(secondEnd) !== between || thirdAt >= to || digitsEnd(text, thirdAt, to) !== to) {
            return undefined;
        }
        const first = toWhole(text, from, firstEnd);
        const third = toWhole(text, thirdAt, to);
        if (named) {
            day = first;
            month = monthNamed(text, secondAt, secondEnd);
            year = third;
            yearDigits = to - thirdAt;
        } else if (firstEnd - from === 4) {
            year = first;
            month = toWhole(text, secondAt, secondEnd);
            day = third;
            yearDigits = 4;
        } else {
            month = first;
            day = toWhole(text, secondAt, secondEnd);
            year = third;
            yearDigits = to - thirdAt;
        }
    }
    if (yearDigits !== 4) {
        if (yearDigits !== 1 && yearDigits !== 2) return undefined;
        year += year < YEAR_PIVOT ? 2000 : 1900;
    }
    if (year < 1900 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined;
    return dateSerial(year, month, day);
}

// Hours, then minutes, seconds and parts of a second if given, as a fraction of a day. `half` is 1 for AM, 2 for PM
// and 0 for a 24 hour time, which may count hours past 24.
function readTime(text: string, from: number, to: number, half: number): number | undefined {
    const hoursEnd = digitsEnd(text, from, to);
    if (hoursEnd === from || hoursEnd - from > 4) return undefined;
    let hours = toWhole(text, from, hoursEnd);
    let minutes = 0;
    let seconds = 0;
    if (hoursEnd < to) {
        // Spaces may stand around the colon after the hours, as in 4 : 35.
        let colon = hoursEnd;
        while (text.charCodeAt(colon) === SPACE) colon += 1;
        let minutesAt = colon + 1;
        while (text.charCodeAt(minutesAt) === SPACE) minutesAt += 1;
        const minutesEnd = digitsEnd(text, minutesAt, to);
        if (text.charCodeAt(colon) !== COLON || minutesEnd === minutesAt) return undefined;
        minutes = toWhole(text, minutesAt, minutesEnd);
        if (minutesEnd < to) {
            const secondsEnd = digitsEnd(text, minutesEnd + 1, to);
            if (text.charCodeAt(minutesEnd) !== COLON || secondsEnd === minutesEnd + 1) return undefined;
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
    if (minutes > 59 || seconds >= 60) return undefined;
    if (half !== 0) {
        if (hours > 12) return undefined;
        hours = (hours % 12) + (half === 2 ? 12 : 0);
    }
    return timeSerial(hours, minutes, seconds);
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
