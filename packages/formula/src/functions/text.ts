// The functions on text. A number or a boolean among their arguments is spelled out first, and a position counts
// characters from 1. A count is refused for its sign before its fraction is cut: LEFT("abc",-0.9) is #VALUE!.
// What a character is, how letters change case and how a number is shown are kernels these rows only call.

import { valueAsText } from '../format/number-display';
import { ansiCharacter, ansiCode } from '../values/ansi';
import { countCharacters, cutCharacters, findCharacters, firstCode, searchCharacters } from '../values/characters';
import { partBeside } from '../values/delimited';
import { CALC, NA, VALUE } from '../values/errors';
import { lowerCase, properCase, upperCase } from '../values/letter-case';
import { fixedText } from '../values/number-text';
import { parseDateTime, parseNumber } from '../values/parse-number';
import { roundDecimal } from '../values/precision';
import { separatedNumber } from '../values/separated-number';
import { isError, LONGEST_TEXT } from '../values/value';
import {
    BOOLEAN,
    defaulted,
    fn,
    INTEGER,
    NEARLY,
    NUMBER,
    optional,
    PLAIN,
    rest,
    skippable,
    strict,
    TEXT,
    TEXTS,
} from './registry';

// Past this a position is no position: MID("abc",2^31,1) is #VALUE!.
const POSITION_LIMIT = 2 ** 31;

// The most decimals FIXED and DOLLAR write, and the longest text.
const MOST_DECIMALS = 127;
const LONGEST_FIXED = 255;

const LAST_CODE_POINT = 0x10ffff;

// Every control character but 127, which CLEAN keeps.
const UNSEEN = /[^\P{Cc}\x7f]/gu;

// The number rounded as ROUND does, with exactly `decimals` digits after the point.
function fixed(number: number, decimals: number, grouped: boolean) {
    if (decimals > MOST_DECIMALS) return VALUE;
    const text = fixedText(roundDecimal(number, decimals), decimals, grouped);
    return text.length > LONGEST_FIXED ? VALUE : text;
}

// TEXTBEFORE and TEXTAFTER. An instance that was written is refused when the text has no room for that many
// delimiters, and one left out never is: of an empty text nothing is found.
function beside(after: boolean) {
    return (
        text: string,
        delimiters: readonly string[],
        instance: number | undefined,
        mode: number,
        toEnd: number,
        fallback: string | undefined,
    ) => {
        if (instance === 0 || (mode !== 0 && mode !== 1) || (toEnd !== 0 && toEnd !== 1)) return VALUE;
        let shortest = LONGEST_TEXT;
        for (const delimiter of delimiters) shortest = Math.min(shortest, countCharacters(delimiter));
        if (instance !== undefined && Math.abs(instance) > countCharacters(text) - shortest + 1) return VALUE;
        const part =
            mode === 1
                ? partBeside(text, upperCase(text), delimiters.map(upperCase), instance ?? 1, toEnd === 1, after)
                : partBeside(text, text, delimiters, instance ?? 1, toEnd === 1, after);
        return part ?? fallback ?? NA;
    };
}

const BESIDE = [TEXT, TEXTS, skippable(INTEGER), skippable(INTEGER, 0), skippable(INTEGER, 0), optional(TEXT)] as const;

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
    // out, but it counts toward the longest text as if it were joined.
    fn('TEXTJOIN', [TEXTS, defaulted(BOOLEAN, true), rest(TEXTS)], (delimiters, skip, texts) => {
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
    fn('LEFT', [TEXT, optional(NEARLY, 1)], (text, count) =>
        count < 0 ? VALUE : cutCharacters(text, 0, Math.trunc(count)),
    ),
    fn('RIGHT', [TEXT, optional(NUMBER, 1)], (text, count) => {
        if (count < 0) return VALUE;
        const length = countCharacters(text);
        return cutCharacters(text, Math.max(length - Math.trunc(count), 0), length);
    }),
    fn('MID', [TEXT, NUMBER, NUMBER], (text, start, count) =>
        start < 1 || count < 0 || start >= POSITION_LIMIT || count >= POSITION_LIMIT
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
        if (instance !== undefined && (instance < 1 || instance >= POSITION_LIMIT)) return VALUE;
        if (old === '') return text;
        const width = countCharacters(old);
        const step = instance === undefined ? width : 1;
        let result = '';
        let kept = 0;
        let seen = 0;
        for (let at = findCharacters(old, text, 1); at > 0; at = findCharacters(old, text, at + step)) {
            seen += 1;
            if (instance !== undefined && seen < Math.trunc(instance)) continue;
            const piece = cutCharacters(text, kept, at - 1 - kept) + put;
            // The longest text times itself is more than a string can hold on Node.
            if (result.length + piece.length > LONGEST_TEXT) return VALUE;
            result += piece;
            kept = at - 1 + width;
            if (instance !== undefined) break;
        }
        return result + cutCharacters(text, kept, LONGEST_TEXT);
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
    fn('CODE', [TEXT], (text) => {
        const code = firstCode(text);
        return code === undefined ? VALUE : ansiCode(code);
    }),
    // Half of a surrogate pair is no character, and neither are the code points Unicode sets aside for good: the
    // last two of a plane and the 32 from U+FDD0.
    fn('UNICHAR', [INTEGER], (code) => {
        if (code < 1 || code > LAST_CODE_POINT) return VALUE;
        const none = (code >= 0xd800 && code <= 0xdfff) || (code >= 0xfdd0 && code <= 0xfdef);
        return none || (code & 0xfffe) === 0xfffe ? NA : String.fromCodePoint(code);
    }),
    fn('UNICODE', [TEXT], (text) => firstCode(text) ?? VALUE),
    // An empty text is 0, as it is wherever a number is read.
    fn('VALUE', [TEXT], (text) => (text === '' ? 0 : (parseNumber(text) ?? VALUE))),
    // The first character of each separator counts. Left out, the comma groups unless it is the decimal sign. A
    // date or a time is read too, but only one that says its year: no year is handed over, so the clock is not asked.
    fn('NUMBERVALUE', [TEXT, optional(TEXT, '.'), optional(TEXT)], (text, decimals, groups) => {
        const decimal = cutCharacters(decimals, 0, 1);
        const group = groups === undefined ? (decimal === ',' ? '' : ',') : cutCharacters(groups, 0, 1);
        if (decimal === '' || groups === '' || group === decimal) return VALUE;
        return separatedNumber(text, decimal, group) ?? parseDateTime(text) ?? VALUE;
    }),
    // A text that reads as a number is shown as that number. Any other text goes through the text section of the
    // format and stays as it is under a format that does not parse, and a boolean is its name.
    fn('TEXT', [PLAIN, TEXT], (value, format) => {
        if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
        const number = typeof value === 'string' ? (parseNumber(value) ?? value) : (value ?? 0);
        if (typeof number === 'string') return valueAsText(number, format) ?? number;
        if (format === '') return number < 0 ? '-' : '';
        return valueAsText(number, format) ?? VALUE;
    }),
    fn('FIXED', [NUMBER, skippable(INTEGER, 2), optional(BOOLEAN, false)], (number, decimals, plain) =>
        fixed(number, decimals, !plain),
    ),
    fn('DOLLAR', [NUMBER, optional(INTEGER, 2)], (number, decimals) => {
        const digits = fixed(Math.abs(number), decimals, true);
        return isError(digits) ? digits : number < 0 ? `($${digits})` : `$${digits}`;
    }),
    fn('TEXTBEFORE', BESIDE, beside(false)),
    fn('TEXTAFTER', BESIDE, beside(true)),
];
