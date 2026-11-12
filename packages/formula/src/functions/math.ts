// The functions on numbers. Each computes on what the call wrapper hands it: ABS and ROUND on a number or two, SUM
// and PRODUCT on every number of their arguments, SUMPRODUCT on its arguments multiplied place by place, SUMIF on
// the numbers beside the cells its criteria accept. SUBTOTAL is all data: a code that picks one of the others.

import { NUM } from '../values/errors';
import { roundDecimal } from '../values/precision';
import { greatestDivisor, leastMultiple, multinomial } from '../values/wholes';
import {
    chosen,
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
    WHERE,
    WHOLES,
} from './registry';

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

export const MATH = [
    fn('ABS', [NUMBER], Math.abs),
    fn('ROUND', [NUMBER, INTEGER], roundDecimal),
    fn('RAND', [RANDOM], (random) => random),
    // A whole number from the bottom rounded up to the top rounded down, and the bottom when none lies between.
    fn('RANDBETWEEN', [NUMBER, NUMBER, RANDOM], (low, high, random) => {
        if (low > high) return NUM;
        const bottom = Math.ceil(low);
        return bottom + Math.floor(random * (Math.max(bottom, Math.floor(high)) - bottom + 1));
    }),
    fn('SUM', [rest(NUMBERS)], (numbers) => numbers.sum()),
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
];
