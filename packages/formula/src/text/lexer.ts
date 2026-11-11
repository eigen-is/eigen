// The formula lexer: lexAt reads the one token that starts at a position and keeps nothing between calls, so two
// formulas can never leak into each other. Both grammars, A1 as typed and the stored shape text, share it: a word is
// cut whole, with any bracketed offsets, and the parser decides what it is. The token kinds double as the operator
// codes of the tree, and tokens() adds the four kinds it tells a word apart by.

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

// The characters the lexer and the parser look for, as the codes charCodeAt gives.
export const BANG = 33;
const DOUBLE_QUOTE = 34;
const HASH = 35;
export const DOLLAR = 36;
const QUOTE = 39;
export const OPEN = 40;
const PLUS = 43;
export const MINUS = 45;
export const DOT = 46;
export const ZERO = 48;
const NINE = 57;
export const COLON = 58;
const LESS = 60;
export const EQUALS = 61;
const GREATER = 62;
export const UPPER_C = 67;
export const UPPER_R = 82;
export const BRACKET_OPEN = 91;
export const BRACKET_CLOSE = 93;
export const LOWER_A = 97;
export const LOWER_E = 101;
const LOWER_Z = 122;

// The error literals a formula may hold. An error leaf holds the place of its literal here, from 1, and the first
// ten are the errors the engine computes, in the order of their codes.
export const ERROR_LITERALS = [
    '#NULL!',
    '#DIV/0!',
    '#VALUE!',
    '#REF!',
    '#NAME?',
    '#NUM!',
    '#N/A',
    '#SPILL!',
    '#CALC!',
    '#ERROR!',
    '#GETTING_DATA',
    '#FIELD!',
    '#BLOCKED!',
    '#CONNECT!',
    '#UNKNOWN!',
    '#BUSY!',
    '#PYTHON!',
    '#TIMEOUT!',
    '#EXTERNAL!',
] as const;

const OTHER = 0;
const SPACE = 1;
const DIGIT = 2;
const WORD_START = 3;
const WORD_PART = 4;

const CLASS = new Uint8Array(128);
for (const [chars, charClass] of [
    [' \t\n\r', SPACE],
    ['0123456789', DIGIT],
    ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_\\$', WORD_START],
    ['.?', WORD_PART],
] as const) {
    for (let i = 0; i < chars.length; i += 1) CLASS[chars.charCodeAt(i)] = charClass;
}

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
    switch (classOf(code)) {
        case SPACE:
            while (end < length && classOf(text.charCodeAt(end)) === SPACE) end += 1;
            return (end << 6) | Token.Space;
        case DIGIT:
            return (numberEnd(text, pos) << 6) | Token.Number;
        case WORD_START:
            return (wordEnd(text, end) << 6) | Token.Word;
        default:
    }
    switch (code) {
        case DOT:
            return classOf(text.charCodeAt(end)) === DIGIT
                ? (numberEnd(text, pos) << 6) | Token.Number
                : (end << 6) | Token.Bad;
        case DOUBLE_QUOTE:
            return quotedEnd(text, pos, '"', Token.String);
        case QUOTE:
            return quotedEnd(text, pos, "'", Token.Quote);
        case BRACKET_OPEN: {
            const close = text.indexOf(']', end);
            return close === -1 ? (length << 6) | Token.Bad : ((close + 1) << 6) | Token.Bracket;
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
            return (end << 6) | (code < 128 && OPERATORS[code] !== 0 ? OPERATORS[code] : Token.Bad);
    }
}

export function tokenKind(token: number): number {
    return token & 63;
}

export function tokenEnd(token: number): number {
    return token >>> 6;
}

// Whether a word that ends before this character would in fact run on, so what was read is only its start.
export function continuesWord(code: number): boolean {
    return classOf(code) >= DIGIT;
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

// Every character past the no-break space may be part of a name, as a sheet or a defined name can be in any script.
// The no-break space itself is refused, as Excel does: as a name it would be invisible. Past the end is NaN.
function classOf(code: number): number {
    if (code < 128) return CLASS[code];
    return code > 0xa0 ? WORD_START : OTHER;
}

function isDigit(code: number): boolean {
    return code >= ZERO && code <= NINE;
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
        while (classOf(text.charCodeAt(end)) >= DIGIT) end += 1;
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
