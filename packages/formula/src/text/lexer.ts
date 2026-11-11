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

const OPERATORS = new Uint8Array(128);
for (const [char, kind] of [
    [':', Token.Colon],
    [',', Token.Comma],
    ['+', Token.Plus],
    ['-', Token.Minus],
    ['@', Token.At],
    ['%', Token.Percent],
    ['^', Token.Power],
    ['*', Token.Multiply],
    ['/', Token.Divide],
    ['&', Token.Concat],
    ['=', Token.Equal],
    [';', Token.Semicolon],
    ['(', Token.Open],
    [')', Token.Close],
    ['{', Token.BraceOpen],
    ['}', Token.BraceClose],
    ['!', Token.Bang],
] as const) {
    OPERATORS[char.charCodeAt(0)] = kind;
}

// Every character past the no-break space may be part of a name, as a sheet or a defined name can be in any script.
// The no-break space itself is refused, as Excel does: as a name it would be invisible. Past the end is NaN.
function classOf(code: number): number {
    if (code < 128) return CLASS[code];
    return code > 0xa0 ? WORD_START : OTHER;
}

// Whether a word that ends before this character would in fact run on, so what was read is only its start.
export function continuesWord(code: number): boolean {
    return classOf(code) >= DIGIT;
}

export function tokenKind(token: number): number {
    return token & 63;
}

export function tokenEnd(token: number): number {
    return token >>> 6;
}

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
        case 46: // .
            return classOf(text.charCodeAt(end)) === DIGIT
                ? (numberEnd(text, pos) << 6) | Token.Number
                : (end << 6) | Token.Bad;
        case 34: // "
            return quotedEnd(text, pos, '"', Token.String);
        case 39: // '
            return quotedEnd(text, pos, "'", Token.Quote);
        case 91: {
            const close = text.indexOf(']', end);
            return close === -1 ? (length << 6) | Token.Bad : ((close + 1) << 6) | Token.Bracket;
        }
        case 35: // #
            return errorEnd(text, pos);
        case 60: {
            const next = text.charCodeAt(end);
            if (next === 61) return ((end + 1) << 6) | Token.LessEqual;
            if (next === 62) return ((end + 1) << 6) | Token.NotEqual;
            return (end << 6) | Token.Less;
        }
        case 62:
            return text.charCodeAt(end) === 61 ? ((end + 1) << 6) | Token.GreaterEqual : (end << 6) | Token.Greater;
        default:
            return (end << 6) | (code < 128 && OPERATORS[code] !== 0 ? OPERATORS[code] : Token.Bad);
    }
}

function isDigit(code: number): boolean {
    return code >= 48 && code <= 57;
}

// Digits, an optional fraction and an optional exponent. A sign is an operator, never part of the number.
function numberEnd(text: string, pos: number): number {
    let end = pos;
    while (isDigit(text.charCodeAt(end))) end += 1;
    if (text.charCodeAt(end) === 46) {
        end += 1;
        while (isDigit(text.charCodeAt(end))) end += 1;
    }
    if ((text.charCodeAt(end) | 32) === 101) {
        let exponent = end + 1;
        const sign = text.charCodeAt(exponent);
        if (sign === 43 || sign === 45) exponent += 1;
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
        if (text.charCodeAt(end) !== 91) return end;
        let digits = end + 1;
        if (text.charCodeAt(digits) === 45) digits += 1;
        let close = digits;
        while (isDigit(text.charCodeAt(close))) close += 1;
        if (close === digits || text.charCodeAt(close) !== 93) return end;
        end = close + 1;
    }
}

// Text between two quotes, where the quote itself is written twice. One that never closes is a bad token.
function quotedEnd(text: string, pos: number, quote: string, kind: number): number {
    let close = text.indexOf(quote, pos + 1);
    while (close !== -1 && text.charCodeAt(close + 1) === quote.charCodeAt(0)) close = text.indexOf(quote, close + 2);
    return close === -1 ? (text.length << 6) | Token.Bad : ((close + 1) << 6) | kind;
}

// An error literal is one of the two that end in a letter, or a letter and more up to a ! or ?. Any other # is the
// spill operator, so A1#/Sheet2!B1 divides.
function errorEnd(text: string, pos: number): number {
    for (const literal of ['#N/A', '#GETTING_DATA']) {
        const end = pos + literal.length;
        if (text.slice(pos, end).toUpperCase() === literal) return (end << 6) | Token.Error;
    }
    let end = pos + 1;
    for (;;) {
        const code = text.charCodeAt(end);
        const letter = (code | 32) >= 97 && (code | 32) <= 122;
        if (!letter && (end === pos + 1 || (classOf(code) !== DIGIT && code !== 47 && code !== 95))) break;
        end += 1;
    }
    const code = text.charCodeAt(end);
    return end > pos + 1 && (code === 33 || code === 63)
        ? ((end + 1) << 6) | Token.Error
        : ((pos + 1) << 6) | Token.Hash;
}
