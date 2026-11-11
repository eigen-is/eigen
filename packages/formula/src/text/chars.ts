// The characters the text folder looks for, as the codes charCodeAt gives, and the test of a digit. The lexer, the
// parser and the label helpers, such as columnIndex, read them here, so each is written once.

export const BANG = 33;
export const DOUBLE_QUOTE = 34;
export const HASH = 35;
export const DOLLAR = 36;
export const QUOTE = 39;
export const OPEN = 40;
export const PLUS = 43;
export const MINUS = 45;
export const DOT = 46;
export const ZERO = 48;
export const NINE = 57;
export const COLON = 58;
export const LESS = 60;
export const EQUALS = 61;
export const GREATER = 62;
export const UPPER_A = 65;
export const UPPER_C = 67;
export const UPPER_R = 82;
export const BRACKET_OPEN = 91;
export const BRACKET_CLOSE = 93;
export const LOWER_A = 97;
export const LOWER_E = 101;
export const LOWER_Z = 122;

export function isDigit(code: number): boolean {
    return code >= ZERO && code <= NINE;
}
