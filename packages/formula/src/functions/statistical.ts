// The functions that count and average. Each takes the numbers or the matches the call wrapper found for it:
// every number of its arguments, the cells that meet its criteria, or the numbers beside those.

import { DIV0 } from '../values/errors';
import type { Numbers } from './registry';
import { BLANKS, COUNTED, FILLED, fn, MATCHED, NUMBERS, optional, rest, WHERE } from './registry';

function average(numbers: Numbers) {
    return numbers.count() === 0 ? DIV0 : numbers.sum() / numbers.count();
}

export const STATISTICAL = [
    fn('AVERAGE', [rest(NUMBERS)], average),
    fn('MAX', [rest(NUMBERS)], (numbers) => (numbers.count() === 0 ? 0 : numbers.max())),
    fn('MIN', [rest(NUMBERS)], (numbers) => (numbers.count() === 0 ? 0 : numbers.min())),
    // With no number at all the middle is no number, which is #NUM!.
    fn('MEDIAN', [rest(NUMBERS)], (numbers) => {
        const sorted = numbers.list().sort();
        const half = sorted.length >> 1;
        return sorted.length % 2 === 1 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
    }),
    fn('COUNT', [rest(COUNTED)], (numbers) => numbers.count()),
    fn('COUNTA', [rest(FILLED)], (values) => values.count()),
    fn('COUNTBLANK', [BLANKS], (blanks) => blanks.count),
    fn('COUNTIF', [WHERE], (where) => where.count),
    fn('COUNTIFS', [rest(WHERE)], (where) => where.count),
    fn('AVERAGEIF', [WHERE, optional(MATCHED)], (_where, numbers) => average(numbers)),
    fn('AVERAGEIFS', [MATCHED, rest(WHERE)], average),
    fn('MAXIFS', [MATCHED, rest(WHERE)], (numbers) => (numbers.count() === 0 ? 0 : numbers.max())),
    fn('MINIFS', [MATCHED, rest(WHERE)], (numbers) => (numbers.count() === 0 ? 0 : numbers.min())),
];
