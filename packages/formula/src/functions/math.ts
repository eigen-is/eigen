// The functions on numbers. ABS and ROUND are the plain case of numbers in and one out. SUM adds every number of
// its arguments, SUMPRODUCT the products of its arguments place by place, and SUMIF and SUMIFS the numbers beside
// the cells their criteria accept: each adds what the call wrapper hands it.

import { roundDecimal } from '../values/precision';
import {
    chosen,
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
    fn('SUM', [rest(NUMBERS)], (numbers) => numbers.sum()),
    fn('SUMPRODUCT', [rest(PRODUCTS)], (products) => products.sum()),
    fn('SUMIF', [WHERE, optional(MATCHED)], (_where, numbers) => numbers.sum()),
    fn('SUMIFS', [MATCHED, rest(WHERE)], (numbers) => numbers.sum()),
    chosen(
        'SUBTOTAL',
        SUBTOTALS.flatMap((target, at) => [[at + 1, target, NESTED] as const, [at + 101, target, NESTED] as const]),
    ),
];
