// The functions on numbers. ABS and ROUND are the plain case of numbers in and one out. SUM adds every number of
// its arguments, SUMPRODUCT the products of its arguments place by place, and SUMIF and SUMIFS the numbers beside
// the cells their criteria accept: each adds what the call wrapper hands it.

import { roundDecimal } from '../values/precision';
import { fn, INTEGER, MATCHED, NUMBER, NUMBERS, optional, PRODUCTS, RANDOM, rest, WHERE } from './registry';

export const MATH = [
    fn('ABS', [NUMBER], Math.abs),
    fn('ROUND', [NUMBER, INTEGER], roundDecimal),
    fn('RAND', [RANDOM], (random) => random),
    fn('SUM', [rest(NUMBERS)], (numbers) => numbers.sum()),
    fn('SUMPRODUCT', [rest(PRODUCTS)], (products) => products.sum()),
    fn('SUMIF', [WHERE, optional(MATCHED)], (_where, numbers) => numbers.sum()),
    fn('SUMIFS', [MATCHED, rest(WHERE)], (numbers) => numbers.sum()),
];
