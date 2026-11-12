// The operators on values that are already read: arithmetic, comparison and joining text, with their coercions and
// their error order, the left operand first. They are total: a value that is no scalar is #VALUE!. Each operator is
// also an entry of the kind a function is, so that an operator on an array is lifted by the code that lifts a call.

import { ANY, fn } from '../functions/registry';
import { Token } from '../text/lexer';
import { toNumber, toText } from '../values/coerce';
import { compareValues } from '../values/compare';
import type { FormulaError } from '../values/errors';
import { DIV0, NUM, VALUE } from '../values/errors';
import { power } from '../values/powers';
import { snapSum } from '../values/precision';
import type { Scalar, Value } from '../values/value';
import { isError, LONGEST_TEXT } from '../values/value';
import type { Entry } from './signature';

const SMALLEST_NORMAL = 2.2250738585072014e-308;

// A number as a cell can hold it: an overflow is #NUM!, and what is too small to be a normal double is 0.
export function real(result: number): number | FormulaError {
    if (result - result !== 0) return NUM;
    return result > -SMALLEST_NORMAL && result < SMALLEST_NORMAL ? 0 : result;
}

export function arithmetic(op: number, x: number, y: number): number | FormulaError {
    switch (op) {
        case Token.Plus:
            return real(x + y);
        case Token.Minus:
            return real(x - y);
        case Token.Multiply:
            return real(x * y);
        case Token.Divide:
            return y === 0 ? DIV0 : real(x / y);
        default: {
            const result = power(x, y);
            return typeof result === 'number' ? real(result) : result;
        }
    }
}

function compare(op: number, a: Value, b: Value): Scalar {
    if (isError(a)) return a;
    if (isError(b)) return b;
    if ((typeof a === 'object' && a !== null) || (typeof b === 'object' && b !== null)) return VALUE;
    const order = compareValues(a, b);
    switch (op) {
        case Token.Equal:
            return order === 0;
        case Token.NotEqual:
            return order !== 0;
        case Token.Less:
            return order < 0;
        case Token.LessEqual:
            return order <= 0;
        case Token.Greater:
            return order > 0;
        default:
            return order >= 0;
    }
}

// One operator on two values. With `snap`, a sum or a difference that is tiny against its left operand is 0, which
// is for the last operation of a formula only.
export function operate(op: number, a: Value, b: Value, snap: boolean): Scalar {
    if (op >= Token.Equal) return compare(op, a, b);
    if (op === Token.Concat) {
        const left = toText(a);
        if (typeof left !== 'string') return left;
        const right = toText(b);
        if (typeof right !== 'string') return right;
        return left.length + right.length > LONGEST_TEXT ? VALUE : left + right;
    }
    const x = toNumber(a);
    if (typeof x !== 'number') return x;
    const y = toNumber(b);
    if (typeof y !== 'number') return y;
    const result = arithmetic(op, x, y);
    return snap && typeof result === 'number' ? snapSum(result, x) : result;
}

export function negate(a: Value): Scalar {
    const x = toNumber(a);
    return typeof x === 'number' ? 0 - x : x;
}

export function percent(a: Value): Scalar {
    const x = toNumber(a);
    return typeof x === 'number' ? real(x / 100) : x;
}

const BINARY = [
    Token.Plus,
    Token.Minus,
    Token.Multiply,
    Token.Divide,
    Token.Power,
    Token.Concat,
    Token.Equal,
    Token.NotEqual,
    Token.Less,
    Token.LessEqual,
    Token.Greater,
    Token.GreaterEqual,
];

// By operator token, for an operand that is an array.
export const LIFTED_BINARY: readonly Entry[] = BINARY.reduce((entries: Entry[], op) => {
    entries[op] = fn('', [ANY, ANY], (a, b) => operate(op, a, b, false));
    return entries;
}, []);
export const LIFTED_PLUS = fn('', [ANY], (a) => a);
export const LIFTED_NEGATE = fn('', [ANY], negate);
export const LIFTED_PERCENT = fn('', [ANY], percent);
