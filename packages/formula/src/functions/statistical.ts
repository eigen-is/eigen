// The statistical functions, such as a count, an average, a rank or the spread of a set. Each takes what the call
// wrapper found for it: every number of its arguments, the cells that meet its criteria, the numbers beside those,
// or two ranges paired place by place. The arithmetic several of them share is the statistics kernel's.

import { DIV0, NA, NUM, VALUE } from '../values/errors';
import { rootOfProduct } from '../values/powers';
import { coDeviations, interpolated, mean, rankAmong, squaredDeviations } from '../values/statistics';
import { isError } from '../values/value';
import type { Numbers, Pairs } from './registry';
import {
    BLANKS,
    COUNTED,
    cells,
    FILLED,
    fn,
    INTEGER,
    MATCHED,
    MODES,
    NUMBER,
    NUMBERS,
    NUMBERS_A,
    optional,
    PAIRS,
    referring,
    rest,
    WHERE,
} from './registry';

// The value met most often, and of several met equally often the one that is written first. With no value met
// twice there is none.
function mode(numbers: Numbers) {
    const list = numbers.list();
    const met = new Map<number, number>();
    let most = 1;
    for (const number of list) {
        const times = (met.get(number) ?? 0) + 1;
        met.set(number, times);
        if (times > most) most = times;
    }
    return most === 1 ? NA : (list.find((number) => met.get(number) === most) ?? NA);
}

function average(numbers: Numbers) {
    return numbers.count() === 0 ? DIV0 : numbers.sum() / numbers.count();
}

function largest(numbers: Numbers) {
    return numbers.count() === 0 ? 0 : numbers.max();
}

function smallest(numbers: Numbers) {
    return numbers.count() === 0 ? 0 : numbers.min();
}

// From the largest down, or with an order that is not 0 from the smallest up. A number the range does not hold has
// no rank.
function rank(value: number, numbers: Numbers, order: number) {
    return rankAmong(numbers.list(), value, order !== 0, false) || NA;
}

// Equal numbers share the mean of their ranks, where RANK gives each the first of them.
function sharedRank(value: number, numbers: Numbers, order: number) {
    return rankAmong(numbers.list(), value, order !== 0, true) || NA;
}

// The quarter is cut to a whole number after its sign is tested: QUARTILE(D1:D8,-0.5) is #NUM!.
function quartile(numbers: Numbers, quarter: number) {
    return quarter < 0 ? NUM : percentile(numbers, Math.trunc(quarter) / 4);
}

// From the smallest number at 0 to the largest at 1.
function percentile(numbers: Numbers, k: number) {
    const sorted = numbers.list().sort();
    return k < 0 || k > 1 || sorted.length === 0 ? NUM : interpolated(sorted, k * (sorted.length - 1));
}

// As if one more number lay on each side: a k that falls before the smallest or past the largest has no answer.
function percentileBetween(numbers: Numbers, k: number) {
    const sorted = numbers.list().sort();
    const place = k * (sorted.length + 1);
    return place < 1 || place > sorted.length ? NUM : interpolated(sorted, place - 1);
}

// `less` is 1 for a sample and 0 for a whole population. Numbers whose squares no number holds are #NUM! as in
// Excel, even one alone and equal ones, which lie at no distance from their mean.
function variance(numbers: Numbers, less: number) {
    const values = numbers.list();
    if (values.reduce((sum, value) => sum + value * value, 0) === Number.POSITIVE_INFINITY) return NUM;
    return values.length <= less ? DIV0 : squaredDeviations(values) / (values.length - less);
}

function deviation(numbers: Numbers, less: number) {
    const spread = variance(numbers, less);
    return isError(spread) ? spread : Math.sqrt(spread);
}

function covariance({ xs, ys }: Pairs, less: number) {
    return xs.length <= less ? DIV0 : coDeviations(xs, ys) / (xs.length - less);
}

// The first argument holds the y values: how much they rise per step of the second.
function slope({ xs, ys }: Pairs) {
    const spread = squaredDeviations(ys);
    return spread === 0 ? DIV0 : coDeviations(xs, ys) / spread;
}

// The y of the line through the pairs at `x`; at 0 it is where the line crosses.
function onLine(x: number, pairs: Pairs) {
    const rise = slope(pairs);
    return isError(rise) ? rise : mean(pairs.xs) - rise * mean(pairs.ys) + rise * x;
}

// The covariance of the two sides over the root of their variances. Each is divided by the count first, the
// order that gives the last digit Excel shows for RSQ.
function correlation({ xs, ys }: Pairs) {
    const spreadX = squaredDeviations(xs);
    const spreadY = squaredDeviations(ys);
    // A side that does not vary, and no pair at all, leave nothing to divide by.
    if (spreadX * spreadY === 0) return DIV0;
    if (!Number.isFinite(spreadX * spreadY)) return NUM;
    const count = xs.length;
    return coDeviations(xs, ys) / count / Math.sqrt((spreadX / count) * (spreadY / count));
}

// The squares of the first side, plus or minus those of the second, added pair by pair.
function squares({ xs, ys }: Pairs, sign: number) {
    let sum = 0;
    for (let i = 0; i < xs.length; i += 1) sum += xs[i] ** 2 + sign * ys[i] ** 2;
    return sum;
}

export const STATISTICAL = [
    fn('AVERAGE', [rest(NUMBERS)], average),
    fn('AVERAGEA', [rest(NUMBERS_A)], average),
    fn('MAX', [rest(NUMBERS)], largest),
    fn('MAXA', [rest(NUMBERS_A)], largest),
    fn('MIN', [rest(NUMBERS)], smallest),
    fn('MINA', [rest(NUMBERS_A)], smallest),
    // With no number at all the middle is no number, which is #NUM!.
    fn('MEDIAN', [rest(referring(NUMBERS, VALUE))], (numbers) => {
        const sorted = numbers.list().sort();
        const half = sorted.length >> 1;
        return sorted.length % 2 === 1 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
    }),
    // LARGE rounds a place that is no whole number up and SMALL cuts it, so 1.5 is the second largest and the
    // smallest.
    fn('LARGE', [referring(NUMBERS, VALUE), NUMBER], (numbers, k) => {
        const sorted = numbers.list().sort();
        return k < 1 || k > sorted.length ? NUM : sorted[sorted.length - Math.ceil(k)];
    }),
    fn('SMALL', [referring(NUMBERS, VALUE), NUMBER], (numbers, k) => {
        const sorted = numbers.list().sort();
        return k < 1 || k > sorted.length ? NUM : sorted[Math.trunc(k) - 1];
    }),
    fn('RANK', [NUMBER, cells(NUMBERS), optional(NUMBER, 0)], rank),
    fn('RANK.EQ', [NUMBER, cells(NUMBERS), optional(NUMBER, 0)], rank),
    fn('RANK.AVG', [NUMBER, cells(NUMBERS), optional(NUMBER, 0)], sharedRank),
    fn('PERCENTILE', [referring(NUMBERS, VALUE), NUMBER], percentile),
    fn('PERCENTILE.INC', [referring(NUMBERS, VALUE), NUMBER], percentile),
    fn('PERCENTILE.EXC', [referring(NUMBERS, VALUE), NUMBER], percentileBetween),
    fn('QUARTILE', [referring(NUMBERS, VALUE), NUMBER], quartile),
    fn('QUARTILE.INC', [referring(NUMBERS, VALUE), NUMBER], quartile),
    fn('QUARTILE.EXC', [referring(NUMBERS, VALUE), INTEGER], (numbers, quarter) =>
        percentileBetween(numbers, quarter / 4),
    ),
    fn('VAR', [rest(NUMBERS)], (numbers) => variance(numbers, 1)),
    fn('VAR.S', [rest(NUMBERS)], (numbers) => variance(numbers, 1)),
    fn('VARA', [rest(NUMBERS_A)], (numbers) => variance(numbers, 1)),
    fn('VARP', [rest(NUMBERS)], (numbers) => variance(numbers, 0)),
    fn('VAR.P', [rest(NUMBERS)], (numbers) => variance(numbers, 0)),
    fn('VARPA', [rest(NUMBERS_A)], (numbers) => variance(numbers, 0)),
    fn('STDEV', [rest(NUMBERS)], (numbers) => deviation(numbers, 1)),
    fn('STDEV.S', [rest(NUMBERS)], (numbers) => deviation(numbers, 1)),
    fn('STDEVA', [rest(NUMBERS_A)], (numbers) => deviation(numbers, 1)),
    fn('STDEVP', [rest(NUMBERS)], (numbers) => deviation(numbers, 0)),
    fn('STDEV.P', [rest(NUMBERS)], (numbers) => deviation(numbers, 0)),
    fn('STDEVPA', [rest(NUMBERS_A)], (numbers) => deviation(numbers, 0)),
    // Of no number at all the mean is no number, which is #NUM!.
    fn('AVEDEV', [rest(NUMBERS)], (numbers) => {
        const values = numbers.list();
        const middle = mean(values);
        return values.reduce((sum, value) => sum + Math.abs(value - middle), 0) / values.length;
    }),
    fn('DEVSQ', [rest(NUMBERS)], (numbers) => (numbers.count() === 0 ? NUM : squaredDeviations(numbers.list()))),
    // Only of numbers above 0.
    fn('GEOMEAN', [rest(NUMBERS)], (numbers) =>
        numbers.count() === 0 || numbers.min() <= 0 ? NUM : rootOfProduct(numbers.list()),
    ),
    fn('HARMEAN', [rest(referring(NUMBERS, VALUE))], (numbers) => {
        if (numbers.count() === 0) return NA;
        return numbers.min() <= 0 ? NUM : numbers.count() / numbers.list().reduce((sum, value) => sum + 1 / value, 0);
    }),
    fn('CORREL', [PAIRS], correlation),
    fn('PEARSON', [PAIRS], correlation),
    fn('RSQ', [PAIRS], (pairs) => {
        const together = correlation(pairs);
        return isError(together) ? together : together * together;
    }),
    fn('COVAR', [PAIRS], (pairs) => covariance(pairs, 0)),
    fn('COVARIANCE.P', [PAIRS], (pairs) => covariance(pairs, 0)),
    fn('COVARIANCE.S', [PAIRS], (pairs) => covariance(pairs, 1)),
    fn('SLOPE', [PAIRS], slope),
    fn('INTERCEPT', [PAIRS], (pairs) => onLine(0, pairs)),
    fn('FORECAST', [NUMBER, PAIRS], onLine),
    fn('FORECAST.LINEAR', [NUMBER, PAIRS], onLine),
    // How far the y values, the first argument, lie from the line through the pairs.
    fn('STEYX', [PAIRS], ({ xs, ys }) => {
        const spread = squaredDeviations(ys);
        if (spread === 0) return DIV0;
        return Math.sqrt((squaredDeviations(xs) - coDeviations(xs, ys) ** 2 / spread) / (xs.length - 2));
    }),
    fn('SUMXMY2', [PAIRS], ({ xs, ys }) => {
        let sum = 0;
        for (let i = 0; i < xs.length; i += 1) sum += (xs[i] - ys[i]) ** 2;
        return sum;
    }),
    fn('SUMX2MY2', [PAIRS], (pairs) => squares(pairs, -1)),
    fn('SUMX2PY2', [PAIRS], (pairs) => squares(pairs, 1)),
    fn('COUNT', [rest(COUNTED)], (numbers) => numbers.count()),
    fn('COUNTA', [rest(FILLED)], (values) => values.count()),
    fn('COUNTBLANK', [BLANKS], (blanks) => blanks.count),
    fn('COUNTIF', [WHERE], (where) => where.count),
    fn('COUNTIFS', [rest(WHERE)], (where) => where.count),
    fn('AVERAGEIF', [WHERE, optional(MATCHED)], (_where, numbers) => average(numbers)),
    fn('AVERAGEIFS', [MATCHED, rest(WHERE)], average),
    fn('MAXIFS', [MATCHED, rest(WHERE)], largest),
    fn('MINIFS', [MATCHED, rest(WHERE)], smallest),
    fn('MODE', [rest(MODES)], mode),
    fn('MODE.SNGL', [rest(MODES)], mode),
];
