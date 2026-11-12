// The statistical functions, such as a count, an average or the middle of a set. Each takes what the call wrapper
// found for it: every number of its arguments, the cells that meet its criteria, the numbers beside those, or two
// ranges paired place by place.

import { DIV0 } from '../values/errors';
import type { Numbers } from './registry';
import { BLANKS, COUNTED, FILLED, fn, MATCHED, NUMBERS, optional, PAIRS, rest, WHERE } from './registry';

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
    // How far each side lies from its mean, multiplied pair by pair, over the root of each side's own.
    fn('CORREL', [PAIRS], ({ xs, ys }) => {
        const meanX = xs.reduce((sum, x) => sum + x, 0) / xs.length;
        const meanY = ys.reduce((sum, y) => sum + y, 0) / ys.length;
        let both = 0;
        let squaresX = 0;
        let squaresY = 0;
        for (let i = 0; i < xs.length; i += 1) {
            both += (xs[i] - meanX) * (ys[i] - meanY);
            squaresX += (xs[i] - meanX) ** 2;
            squaresY += (ys[i] - meanY) ** 2;
        }
        return both / Math.sqrt(squaresX * squaresY);
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
