// The functions on numbers. Each computes on what the call wrapper hands it: ABS, ROUND and SIN on a number or
// two, SUM and PRODUCT on every number of their arguments, SUMPRODUCT on its arguments multiplied place by place,
// SUMIF on the numbers beside the cells its criteria accept. The rounding functions go by the 15 digits Excel
// shows, and a body answers an error only where Excel's own function has no answer, such as MOD of a quotient too
// large to hold. SUBTOTAL is all data: a code that picks one of the others.

import { cosine, sine, tangent } from '../values/angle';
import { DIV0, NUM } from '../values/errors';
import { cutDecimal, equal15, roundDecimal, snapWhole } from '../values/precision';
import { greatestDivisor, leastMultiple, multinomial } from '../values/wholes';
import {
    chosen,
    ERRORS,
    FACTORS,
    fn,
    INTEGER,
    MATCHED,
    NESTED,
    NUMBER,
    NUMBERS,
    optional,
    PRODUCTS,
    RANDOM,
    rest,
    skippable,
    strict,
    WHERE,
    WHOLES,
} from './registry';

// The largest whole number Excel counts with: a larger exponent of a negative base, or more things to choose
// from, has no answer.
const MOST_COUNTED = 2 ** 31;

// MOD has no answer from this many times the divisor on.
const MOST_DIVIDED = 1125900000000;

// The functions the codes 1 to 11 of SUBTOTAL pick. 101 to 111 pick the same and leave out rows hidden by hand,
// and this build knows of no hidden row.
const SUBTOTALS = [
    'AVERAGE',
    'COUNT',
    'COUNTA',
    'MAX',
    'MIN',
    'PRODUCT',
    'STDEV.S',
    'STDEV.P',
    'SUM',
    'VAR.S',
    'VAR.P',
];

// CEILING.MATH when `up`, else FLOOR.MATH. The sign of the step says nothing, and a mode other than 0 turns the
// direction around for a negative number.
function toStep(n: number, step: number, mode: number, up: boolean) {
    if (step === 0) return 0;
    const size = Math.abs(step);
    const steps = snapWhole(n / size);
    return (up === (n >= 0 || mode === 0) ? Math.ceil(steps) : Math.floor(steps)) * size;
}

// A negative base has a power for a whole exponent and for an odd root, as (-8)^(1/3) is -2. A result too large
// is #DIV/0! when the exponent is negative, as dividing by a power that came out 0.
function power(base: number, exponent: number) {
    if (base === 0) return exponent === 0 ? NUM : exponent < 0 ? DIV0 : 0;
    let result = base ** exponent;
    if (base < 0 && !(Number.isInteger(exponent) && Math.abs(exponent) < MOST_COUNTED)) {
        const root = Math.round(1 / exponent);
        if (Math.abs(root % 2) !== 1 || !equal15(1 / exponent, root)) return NUM;
        result = -((-base) ** exponent);
    }
    return Number.isFinite(result) || exponent > 0 ? result : DIV0;
}

export const MATH = [
    fn('ABS', [NUMBER], Math.abs),
    fn('SIGN', [NUMBER], Math.sign),
    fn('ROUND', [NUMBER, INTEGER], roundDecimal),
    fn('ROUNDUP', [NUMBER, INTEGER], (n, digits) => cutDecimal(n, digits, true)),
    fn('ROUNDDOWN', [NUMBER, INTEGER], (n, digits) => cutDecimal(n, digits, false)),
    fn('TRUNC', [NUMBER, optional(INTEGER, 0)], (n, digits) => cutDecimal(n, digits, false)),
    fn('INT', [NUMBER], Math.floor),
    fn('EVEN', [NUMBER], (n) => Math.sign(n) * 2 * Math.ceil(Math.abs(n) / 2)),
    fn('ODD', [NUMBER], (n) => (n < 0 ? -1 : 1) * (2 * Math.ceil((Math.abs(n) - 1) / 2) + 1)),
    // Half a multiple rounds away from zero, and unlike ROUND on the double as it is: MROUND(1.005,0.01) is 1.
    fn('MROUND', [strict(NUMBER), strict(NUMBER)], (n, multiple) => {
        if (Math.sign(n) * Math.sign(multiple) < 0) return NUM;
        return multiple === 0 ? 0 : Math.floor(n / multiple + 0.5) * multiple;
    }),
    fn('CEILING', [NUMBER, NUMBER], (n, step) => {
        if (n > 0 && step < 0) return NUM;
        return step === 0 ? 0 : Math.ceil(snapWhole(n / step)) * step;
    }),
    fn('FLOOR', [NUMBER, NUMBER], (n, step) => {
        if (n === 0) return 0;
        if (step === 0) return DIV0;
        return n > 0 && step < 0 ? NUM : Math.floor(snapWhole(n / step)) * step;
    }),
    fn('CEILING.MATH', [NUMBER, skippable(NUMBER, 1), optional(NUMBER, 0)], (n, step, mode) =>
        toStep(n, step, mode, true),
    ),
    fn('FLOOR.MATH', [NUMBER, skippable(NUMBER, 1), optional(NUMBER, 0)], (n, step, mode) =>
        toStep(n, step, mode, false),
    ),
    // The result has the sign of the divisor.
    fn('MOD', [NUMBER, NUMBER], (n, divisor) => {
        if (divisor === 0) return DIV0;
        const times = Math.floor(n / divisor);
        return Math.abs(times) >= MOST_DIVIDED ? NUM : n - divisor * times;
    }),
    fn('QUOTIENT', [strict(NUMBER), strict(NUMBER)], (n, divisor) => (divisor === 0 ? DIV0 : Math.trunc(n / divisor))),
    fn('POWER', [NUMBER, NUMBER], power),
    fn('SQRT', [NUMBER], Math.sqrt),
    fn('EXP', [NUMBER], Math.exp),
    fn('LN', [NUMBER], Math.log),
    // Base 10 has its own logarithm, so that LOG(1000) is 3 and not a bit under it.
    fn('LOG', [NUMBER, optional(NUMBER, 10)], (n, base) => {
        if (n <= 0 || base <= 0) return NUM;
        if (base === 1) return DIV0;
        return base === 10 ? Math.log10(n) : Math.log(n) / Math.log(base);
    }),
    fn('LOG10', [NUMBER], Math.log10),
    // The sign is tested before the fraction is cut off: FACT(-0.5) is #NUM!.
    fn('FACT', [NUMBER], (n) => {
        if (n < 0 || n >= 171) return NUM;
        let product = 1;
        for (let factor = 2; factor <= n; factor += 1) product *= factor;
        return product;
    }),
    // Multiplied and divided in turn, exactly while the product is a whole number a double holds.
    fn('COMBIN', [NUMBER, NUMBER], (n, k) => {
        const things = Math.trunc(n);
        const picked = Math.trunc(k);
        if (n < 0 || k < 0 || picked > things || things >= MOST_COUNTED) return NUM;
        const fewer = Math.min(picked, things - picked);
        let ways = 1;
        for (let i = 1; i <= fewer && Number.isFinite(ways); i += 1) {
            const top = things - fewer + i;
            ways = ways * top <= Number.MAX_SAFE_INTEGER ? (ways * top) / i : ways * (top / i);
        }
        return ways;
    }),
    fn('PI', [], () => Math.PI),
    fn('RADIANS', [NUMBER], (degrees) => degrees * (Math.PI / 180)),
    fn('DEGREES', [NUMBER], (radians) => radians * (180 / Math.PI)),
    fn('SIN', [NUMBER], sine),
    fn('COS', [NUMBER], cosine),
    fn('TAN', [NUMBER], tangent),
    fn('ASIN', [NUMBER], Math.asin),
    fn('ACOS', [NUMBER], Math.acos),
    fn('ATAN', [NUMBER], Math.atan),
    // Excel divides y by x, so a quotient too large is #NUM! and not a quarter turn; x alone at 0 is one.
    fn('ATAN2', [NUMBER, NUMBER], (x, y) => {
        if (x === 0) return y === 0 ? DIV0 : Math.atan2(y, x);
        return Number.isFinite(y / x) ? Math.atan2(y, x) : NUM;
    }),
    fn('SINH', [NUMBER], Math.sinh),
    fn('COSH', [NUMBER], Math.cosh),
    fn('TANH', [NUMBER], Math.tanh),
    fn('ASINH', [NUMBER], Math.asinh),
    fn('ACOSH', [NUMBER], Math.acosh),
    fn('ATANH', [NUMBER], Math.atanh),
    fn('RAND', [RANDOM], (random) => random),
    // A whole number from the bottom rounded up to the top rounded down, and the bottom when none lies between.
    fn('RANDBETWEEN', [strict(NUMBER), strict(NUMBER), RANDOM], (low, high, random) => {
        if (low > high) return NUM;
        const bottom = Math.ceil(low);
        return bottom + Math.floor(random * (Math.max(bottom, Math.floor(high)) - bottom + 1));
    }),
    fn('SUM', [rest(NUMBERS)], (numbers) => numbers.sum()),
    fn('SUMSQ', [rest(NUMBERS)], (numbers) => {
        const list = numbers.list();
        let squares = 0;
        for (let i = 0; i < list.length; i += 1) squares += (list[i] ?? 0) ** 2;
        return squares;
    }),
    // Of no number at all the product is 0.
    fn('PRODUCT', [rest(FACTORS)], (factors) =>
        factors.count() === 0 ? 0 : factors.list().reduce((product, factor) => product * factor, 1),
    ),
    fn('SUMPRODUCT', [rest(PRODUCTS)], (products) => products.sum()),
    fn('SUMIF', [WHERE, optional(MATCHED)], (_where, numbers) => numbers.sum()),
    fn('SUMIFS', [MATCHED, rest(WHERE)], (numbers) => numbers.sum()),
    chosen(
        'SUBTOTAL',
        SUBTOTALS.flatMap((target, at) => [[at + 1, target, NESTED] as const, [at + 101, target, NESTED] as const]),
    ),
    fn('GCD', [rest(WHOLES)], greatestDivisor),
    fn('LCM', [rest(WHOLES)], leastMultiple),
    fn('MULTINOMIAL', [rest(WHOLES)], multinomial),
    // The codes 1 to 19, and per option 0 to 7 what is passed over: a nested SUBTOTAL or AGGREGATE up to 3,
    // errors for 2, 3, 6 and 7. The options that leave out hidden rows answer as the ones that keep them.
    chosen(
        'AGGREGATE',
        [...SUBTOTALS, 'MEDIAN', 'MODE.SNGL', 'LARGE', 'SMALL', 'PERCENTILE.INC', 'QUARTILE.INC']
            .concat(['PERCENTILE.EXC', 'QUARTILE.EXC'])
            .map((target, at) => [at + 1, target, 0] as const),
        [NESTED, NESTED, NESTED | ERRORS, NESTED | ERRORS, 0, 0, ERRORS, ERRORS],
    ),
];
