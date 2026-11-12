// The formula lexer: lexAt reads the one token that starts at a position and keeps nothing between calls, so two
// formulas can never leak into each other. Both grammars, A1 as typed and the stored shape text, share it: a word is
// cut whole, with any bracketed offsets, and the parser decides what it is. The token kinds double as the operator
// codes of the tree, and tokens() adds the four kinds it tells a word apart by.

import { ERRORS, REF } from '../values/errors';
import {
    BRACKET_CLOSE,
    BRACKET_OPEN,
    DOT,
    DOUBLE_QUOTE,
    EQUALS,
    GREATER,
    HASH,
    isDigit,
    LESS,
    LOWER_A,
    LOWER_E,
    LOWER_Z,
    MINUS,
    PLUS,
    QUOTE,
} from './chars';

export const Token = {
    End: 0,
    // Whitespace, and in a binary node the intersection operator, which is written as whitespace.
    Space: 1,
    Number: 2,
    String: 3,
    Error: 4,
    Word: 5,
    Quote: 6,
    Bracket: 7,
    Colon: 8,
    Comma: 9,
    Plus: 10,
    Minus: 11,
    At: 12,
    Percent: 13,
    Hash: 14,
    Power: 15,
    Multiply: 16,
    Divide: 17,
    Concat: 18,
    Equal: 19,
    NotEqual: 20,
    Less: 21,
    LessEqual: 22,
    Greater: 23,
    GreaterEqual: 24,
    Semicolon: 25,
    Open: 26,
    Close: 27,
    BraceOpen: 28,
    BraceClose: 29,
    Bang: 30,
    Bad: 31,
    Function: 32,
    Boolean: 33,
    Reference: 34,
    Name: 35,
} as const;

export type TokenKind = (typeof Token)[keyof typeof Token];

// The error literals a formula may hold. An error leaf holds the place of its literal here, from 1: first the errors
// the engine computes, by their codes, then the ones only a file brings.
export const ERROR_LITERALS: readonly string[] = [
    ...ERRORS.map((error) => error.text),
    '#GETTING_DATA',
    '#FIELD!',
    '#BLOCKED!',
    '#CONNECT!',
    '#UNKNOWN!',
    '#BUSY!',
    '#PYTHON!',
    '#TIMEOUT!',
    '#EXTERNAL!',
];

// Whether an operator joins two references into one: a range, an intersection or a union.
export function joinsReferences(op: number): boolean {
    return op === Token.Colon || op === Token.Space || op === Token.Comma;
}

// What is left of a reference whose cells or sheet are gone. It stands wherever a reference may.
export const REF_ERROR = REF.code;

const BLANK = 1;
const DIGIT = 2;
const WORD_START = 3;
const WORD_PART = 4;

const CLASS = new Uint8Array(128);
for (const [chars, charClass] of [
    [' \t\n\r', BLANK],
    ['0123456789', DIGIT],
    ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_\\$', WORD_START],
    ['.?', WORD_PART],
] as const) {
    for (let i = 0; i < chars.length; i += 1) CLASS[chars.charCodeAt(i)] = charClass;
}

const LETTER = /^\p{L}$/u;
const LETTER_OR_DIGIT = /^[\p{L}\p{N}]$/u;
const NOT_DRAWN = /^\p{Default_Ignorable_Code_Point}$/u;
const FULL_WIDTH_FIRST = 0xff01;
const FULL_WIDTH_LAST = 0xff5e;

// The one table of operators: the lexer reads a character by it and the printers write a kind by SYMBOLS. An
// intersection has no symbol, as its whitespace is the operator.
const OPERATORS = new Uint8Array(128);
const symbols = new Array<string>(Token.Bang + 1).fill('');
for (const [symbol, kind] of [
    [':', Token.Colon],
    [',', Token.Comma],
    ['+', Token.Plus],
    ['-', Token.Minus],
    ['@', Token.At],
    ['%', Token.Percent],
    ['#', Token.Hash],
    ['^', Token.Power],
    ['*', Token.Multiply],
    ['/', Token.Divide],
    ['&', Token.Concat],
    ['=', Token.Equal],
    ['<>', Token.NotEqual],
    ['<', Token.Less],
    ['<=', Token.LessEqual],
    ['>', Token.Greater],
    ['>=', Token.GreaterEqual],
    [';', Token.Semicolon],
    ['(', Token.Open],
    [')', Token.Close],
    ['{', Token.BraceOpen],
    ['}', Token.BraceClose],
    ['!', Token.Bang],
] as const) {
    symbols[kind] = symbol;
    if (symbol.length === 1) OPERATORS[symbol.charCodeAt(0)] = kind;
}
export const SYMBOLS: readonly string[] = symbols;

// The token at `pos` as one number, its end and its kind, so the parser's inner loop allocates nothing.
export function lexAt(text: string, pos: number): number {
    const { length } = text;
    if (pos >= length) return (length << 6) | Token.End;
    const code = text.charCodeAt(pos);
    let end = pos + 1;
    if (code >= 128) {
        const width = wideWidth(text, pos, LETTER);
        if (width !== 0) return (wordEnd(text, pos + width) << 6) | Token.Word;
        // A character no formula holds is one bad token, both halves of it when it is a pair.
        if ((text.codePointAt(pos) ?? 0) > 0xffff) end += 1;
        return (end << 6) | Token.Bad;
    }
    const charClass = CLASS[code];
    if (charClass === BLANK) {
        while (CLASS[text.charCodeAt(end)] === BLANK) end += 1;
        return (end << 6) | Token.Space;
    }
    if (charClass === DIGIT) return (numberEnd(text, pos) << 6) | Token.Number;
    if (charClass === WORD_START) return (wordEnd(text, end) << 6) | Token.Word;
    switch (code) {
        case DOT:
            return isDigit(text.charCodeAt(end)) ? (numberEnd(text, pos) << 6) | Token.Number : (end << 6) | Token.Bad;
        case DOUBLE_QUOTE:
            return quotedEnd(text, pos, '"', Token.String);
        case QUOTE:
            return quotedEnd(text, pos, "'", Token.Quote);
        case BRACKET_OPEN: {
            // Excel's rule for a table reference: brackets nest, and a ' takes the next character with it.
            let depth = 1;
            for (; depth > 0 && end < length; end += 1) {
                const inner = text.charCodeAt(end);
                if (inner === QUOTE) end += 1;
                else if (inner === BRACKET_OPEN) depth += 1;
                else if (inner === BRACKET_CLOSE) depth -= 1;
            }
            return depth > 0 ? (length << 6) | Token.Bad : (end << 6) | Token.Bracket;
        }
        case HASH: {
            // A # that starts no error literal is the spill operator, so A1#/Sheet2!B1 divides.
            const error = errorCode(text, pos);
            if (error !== 0) end = pos + ERROR_LITERALS[error - 1].length;
            return (end << 6) | (error !== 0 ? Token.Error : Token.Hash);
        }
        case LESS: {
            const next = text.charCodeAt(end);
            if (next === EQUALS) return ((end + 1) << 6) | Token.LessEqual;
            if (next === GREATER) return ((end + 1) << 6) | Token.NotEqual;
            return (end << 6) | Token.Less;
        }
        case GREATER:
            return text.charCodeAt(end) === EQUALS ? ((end + 1) << 6) | Token.GreaterEqual : (end << 6) | Token.Greater;
        default:
            return (end << 6) | (OPERATORS[code] !== 0 ? OPERATORS[code] : Token.Bad);
    }
}

export function tokenKind(token: number): number {
    return token & 63;
}

export function tokenEnd(token: number): number {
    return token >>> 6;
}

// Whether a word that ends at `pos` would in fact run on, so what was read is only its start.
export function continuesWord(text: string, pos: number): boolean {
    return partWidth(text, pos) !== 0;
}

// Whether the text is one word and no more, so it can stand where a name does.
export function isWord(text: string): boolean {
    const token = lexAt(text, 0);
    return tokenKind(token) === Token.Word && tokenEnd(token) === text.length;
}

// The code of the error literal at `pos`, in any letter case, or 0 when the # there starts none.
export function errorCode(text: string, pos: number): number {
    for (let index = 0; index < ERROR_LITERALS.length; index += 1) {
        const literal = ERROR_LITERALS[index];
        let i = 1;
        for (; i < literal.length; i += 1) {
            const code = text.charCodeAt(pos + i);
            if ((code >= LOWER_A && code <= LOWER_Z ? code - 32 : code) !== literal.charCodeAt(i)) break;
        }
        if (i === literal.length) return index + 1;
    }
    return 0;
}

// How many code units the character at `pos` takes when it may continue a word, and 0 when it may not or the text
// ends there.
function partWidth(text: string, pos: number): number {
    const code = text.charCodeAt(pos);
    if (code < 128) return CLASS[code] >= DIGIT ? 1 : 0;
    return wideWidth(text, pos, LETTER_OR_DIGIT);
}

// The same for a character past ASCII, by the class it must be of. A name can be in any script, but holds nothing
// that is not drawn, such as a Hangul filler, and no full-width twin of an ASCII character.
function wideWidth(text: string, pos: number, wanted: RegExp): number {
    const point = text.codePointAt(pos);
    if (point === undefined || (point >= FULL_WIDTH_FIRST && point <= FULL_WIDTH_LAST)) return 0;
    const character = String.fromCodePoint(point);
    return wanted.test(character) && !NOT_DRAWN.test(character) ? character.length : 0;
}

// Digits, an optional fraction and an optional exponent. A sign is an operator, never part of the number.
function numberEnd(text: string, pos: number): number {
    let end = pos;
    while (isDigit(text.charCodeAt(end))) end += 1;
    if (text.charCodeAt(end) === DOT) {
        end += 1;
        while (isDigit(text.charCodeAt(end))) end += 1;
    }
    if ((text.charCodeAt(end) | 32) === LOWER_E) {
        let exponent = end + 1;
        const sign = text.charCodeAt(exponent);
        if (sign === PLUS || sign === MINUS) exponent += 1;
        if (isDigit(text.charCodeAt(exponent))) {
            end = exponent + 1;
            while (isDigit(text.charCodeAt(end))) end += 1;
        }
    }
    return end;
}

// A word runs on through a bracketed offset, so the stored R[-1]C[2] is one token.
function wordEnd(text: string, pos: number): number {
    let end = pos;
    for (;;) {
        for (let width = partWidth(text, end); width !== 0; width = partWidth(text, end)) end += width;
        if (text.charCodeAt(end) !== BRACKET_OPEN) return end;
        let digits = end + 1;
        if (text.charCodeAt(digits) === MINUS) digits += 1;
        let close = digits;
        while (isDigit(text.charCodeAt(close))) close += 1;
        if (close === digits || text.charCodeAt(close) !== BRACKET_CLOSE) return end;
        end = close + 1;
    }
}

// Text between two quotes, where the quote itself is written twice. One that never closes is a bad token.
function quotedEnd(text: string, pos: number, quote: string, kind: number): number {
    let close = text.indexOf(quote, pos + 1);
    while (close !== -1 && text.charCodeAt(close + 1) === quote.charCodeAt(0)) close = text.indexOf(quote, close + 2);
    return close === -1 ? (text.length << 6) | Token.Bad : ((close + 1) << 6) | kind;
}
