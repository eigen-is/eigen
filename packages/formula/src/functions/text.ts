// The functions on text. A number or a boolean among their arguments is spelled out first, and a position counts
// characters from 1. A count is refused for its sign before its fraction is cut: LEFT("abc",-0.9) is #VALUE!.
// What a character is, how letters change case and how a number is shown are kernels these rows only call.

import { numberAsText } from '../format/number-display';
import { ansiCharacter, ansiCode } from '../values/ansi';
import { countCharacters, cutCharacters, findCharacters, searchCharacters } from '../values/characters';
import { partBeside } from '../values/delimited';
import { CALC, NA, VALUE } from '../values/errors';
import { lowerCase, properCase, upperCase } from '../values/letter-case';
import { parseNumber } from '../values/parse-number';
import { round15, roundDecimal } from '../values/precision';
import { separatedNumber } from '../values/separated-number';
import { isError, LONGEST_TEXT } from '../values/value';
import { BOOLEAN, fn, INTEGER, LAZY, NUMBER, optional, PLAIN, rest, skippable, strict, TEXT, TEXTS } from './registry';

// Past this a position is no position: MID("abc",2^31,1) is #VALUE!.
const MOST = 2 ** 31;

// The most decimals FIXED and DOLLAR write.
const MOST_DECIMALS = 127;

const LAST_CODE_POINT = 0x10ffff;

// Every control character but 127, which CLEAN keeps.
const UNSEEN = /[^\P{Cc}\x7f]/gu;

// The number rounded as ROUND does, with exactly `decimals` digits after the point.
function fixed(number: number, decimals: number, whole: string) {
    if (decimals > MOST_DECIMALS) return VALUE;
    const format = decimals > 0 ? `${whole}.${'0'.repeat(decimals)}` : whole;
    return numberAsText(roundDecimal(number, decimals), format) ?? VALUE;
}

// TEXTBEFORE and TEXTAFTER. An instance that was written is refused when the text has no room for that many
// delimiters, and one left out never is: of an empty text nothing is found.
function beside<F>(after: boolean) {
    return (
        text: string,
        delimiters: readonly string[],
        instance: number | undefined,
        mode: number,
        toEnd: number,
        fallback: F,
    ) => {
        if (instance === 0 || (mode !== 0 && mode !== 1) || (toEnd !== 0 && toEnd !== 1)) return VALUE;
        let shortest = LONGEST_TEXT;
        for (const delimiter of delimiters) shortest = Math.min(shortest, delimiter.length);
        if (instance !== undefined && Math.abs(instance) > text.length - shortest + 1) return VALUE;
        const part =
            mode === 1
                ? partBeside(text, upperCase(text), delimiters.map(upperCase), instance ?? 1, toEnd === 1, after)
                : partBeside(text, text, delimiters, instance ?? 1, toEnd === 1, after);
        return part ?? fallback;
    };
}

export const TEXT_FUNCTIONS = [
    // What is past the longest text is cut off, where CONCAT refuses.
    fn('CONCATENATE', [rest(TEXT)], (texts) => texts.join('').slice(0, LONGEST_TEXT)),
    fn('CONCAT', [rest(TEXTS)], (texts) => {
        let joined = '';
        for (const text of texts) {
            if (joined.length + text.length > LONGEST_TEXT) return CALC;
            joined += text;
        }
        return joined;
    }),
    // Between two texts goes the next delimiter, the first again after the last. With `skip`, empty text is left
    // out, but it counts toward the longest text as if it were joined. A text to join must follow.
    fn('TEXTJOIN', [TEXTS, skippable(BOOLEAN, true), optional(rest(TEXTS))], (delimiters, skip, texts) => {
        if (!texts?.length) return VALUE;
        let joined = '';
        let count = 0;
        for (const text of texts) {
            const delimiter = count === 0 ? '' : delimiters[(count - 1) % delimiters.length];
            if (joined.length + delimiter.length + text.length > LONGEST_TEXT) return CALC;
            if (skip && text === '') continue;
            joined += delimiter + text;
            count += 1;
        }
        return joined;
    }),
    fn('LEFT', [TEXT, optional(NUMBER, 1)], (text, count) =>
        count < 0 ? VALUE : cutCharacters(text, 0, Math.trunc(count)),
    ),
    fn('RIGHT', [TEXT, optional(NUMBER, 1)], (text, count) => {
        if (count < 0) return VALUE;
        const length = countCharacters(text);
        return cutCharacters(text, Math.max(length - Math.trunc(count), 0), length);
    }),
    fn('MID', [TEXT, NUMBER, NUMBER], (text, start, count) =>
        start < 1 || count < 0 || start >= MOST || count >= MOST
            ? VALUE
            : cutCharacters(text, Math.trunc(start) - 1, Math.trunc(count)),
    ),
    fn('REPLACE', [TEXT, NUMBER, NUMBER, TEXT], (text, start, count, put) => {
        if (start < 1 || count < 0 || start >= LONGEST_TEXT + 1 || count >= LONGEST_TEXT + 1) return VALUE;
        const kept = Math.trunc(start) - 1;
        return cutCharacters(text, 0, kept) + put + cutCharacters(text, kept + Math.trunc(count), LONGEST_TEXT);
    }),
    // Left out, every `old` is replaced, one after the other. A numbered one is counted among all the places
    // `old` starts at, overlapping ones too: the second aa of aaaa starts at its second a.
    fn('SUBSTITUTE', [TEXT, TEXT, TEXT, optional(strict(NUMBER))], (text, old, put, instance) => {
        if (instance !== undefined && (instance < 1 || instance >= MOST)) return VALUE;
        if (old === '') return text;
        const step = instance === undefined ? old.length : 1;
        let result = '';
        let kept = 0;
        let seen = 0;
        for (let at = text.indexOf(old); at >= 0; at = text.indexOf(old, at + step)) {
            seen += 1;
            if (instance !== undefined && seen < Math.trunc(instance)) continue;
            if (result.length + at - kept + put.length > LONGEST_TEXT) return VALUE;
            result += text.slice(kept, at) + put;
            kept = at + old.length;
            if (instance !== undefined) break;
        }
        return result + text.slice(kept);
    }),
    // An empty text is found at every position up to the one after the last character.
    fn('FIND', [TEXT, TEXT, optional(NUMBER, 1)], (sought, text, start) =>
        start < 1 || Math.trunc(start) > countCharacters(text) + 1
            ? VALUE
            : findCharacters(sought, text, Math.trunc(start)) || VALUE,
    ),
    fn('SEARCH', [TEXT, TEXT, optional(NUMBER, 1)], (sought, text, start) =>
        start < 1 || Math.trunc(start) > countCharacters(text)
            ? VALUE
            : searchCharacters(sought, text, Math.trunc(start)) || VALUE,
    ),
    fn('REPT', [TEXT, NUMBER], (text, count) =>
        count < 0 || text.length * Math.trunc(count) > LONGEST_TEXT ? VALUE : text.repeat(Math.trunc(count)),
    ),
    fn('EXACT', [TEXT, TEXT], (one, other) => one === other),
    fn('LEN', [TEXT], countCharacters),
    fn('LOWER', [TEXT], lowerCase),
    fn('UPPER', [TEXT], upperCase),
    fn('PROPER', [TEXT], properCase),
    // Only the space itself: a tab and a space that does not break stay.
    fn('TRIM', [TEXT], (text) => text.replace(/ {2,}/g, ' ').replace(/^ | $/g, '')),
    fn('CLEAN', [TEXT], (text) => text.replace(UNSEEN, '')),
    fn('CHAR', [INTEGER], (code) => (code < 1 || code > 255 ? VALUE : ansiCharacter(code))),
    fn('CODE', [TEXT], (text) => (text === '' ? VALUE : ansiCode(text.charCodeAt(0)))),
    // Half of a surrogate pair and the last two code points of a plane are no character.
    fn('UNICHAR', [INTEGER], (code) => {
        if (code < 1 || code > LAST_CODE_POINT) return VALUE;
        return (code >= 0xd800 && code <= 0xdfff) || (code & 0xfffe) === 0xfffe ? NA : String.fromCodePoint(code);
    }),
    fn('UNICODE', [TEXT], (text) => text.codePointAt(0) ?? VALUE),
    // An empty text is 0, as it is wherever a number is read.
    fn('VALUE', [TEXT], (text) => (text === '' ? 0 : (parseNumber(text) ?? VALUE))),
    // The first character of each separator counts. Left out, the comma groups unless it is the decimal sign.
    fn('NUMBERVALUE', [TEXT, optional(TEXT, '.'), optional(TEXT)], (text, decimals, groups) => {
        const decimal = decimals.charAt(0);
        const group = groups === undefined ? (decimal === ',' ? '' : ',') : groups.charAt(0);
        if (decimal === '' || groups === '' || group === decimal) return VALUE;
        return separatedNumber(text, decimal, group) ?? VALUE;
    }),
    // A text that reads as a number is shown as that number, and any other text and a boolean as they are.
    fn('TEXT', [PLAIN, TEXT], (value, format) => {
        const number = value === null ? 0 : typeof value === 'string' ? parseNumber(value) : value;
        if (typeof number !== 'number') return value === true ? 'TRUE' : value === false ? 'FALSE' : value;
        if (format === '') return number < 0 ? '-' : '';
        return numberAsText(round15(number), format) ?? VALUE;
    }),
    fn('FIXED', [NUMBER, skippable(INTEGER, 2), optional(BOOLEAN, false)], (number, decimals, plain) =>
        fixed(number, decimals, plain ? '0' : '#,##0'),
    ),
    fn('DOLLAR', [NUMBER, optional(INTEGER, 2)], (number, decimals) => {
        const digits = fixed(Math.abs(number), decimals, '#,##0');
        return isError(digits) ? digits : number < 0 ? `($${digits})` : `$${digits}`;
    }),
    fn(
        'TEXTBEFORE',
        [TEXT, TEXTS, skippable(INTEGER), skippable(INTEGER, 0), skippable(INTEGER, 0), optional(LAZY, NA)],
        beside(false),
    ),
    fn(
        'TEXTAFTER',
        [TEXT, TEXTS, skippable(INTEGER), skippable(INTEGER, 0), skippable(INTEGER, 0), optional(LAZY, NA)],
        beside(true),
    ),
];
