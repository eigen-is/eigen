// The one adder: the sum of what a walk hands out, as adding number by number in written order gives it. A stretch
// of equal elements of an array, such as the million blank rows under a column's cells, is added in a few steps
// that give the answer of a loop of single additions bit for bit: while the sum stays between two powers of two,
// every addition rounds the same way.

import type { Recalc } from '../recalc/recalc';
import { CALC } from '../values/errors';
import type { Walk } from './walk';

// The sum of everything the walk still hands out, with the sum before the last addition left in `walk.before`.
export function add(walk: Walk, recalc: Recalc): number {
    let sum = 0;
    let before = 0;
    while (walk.next()) {
        if (walk.reps !== null || walk.rows !== 1) {
            sum = addRow(walk, recalc, sum);
            before = walk.before;
            continue;
        }
        const { num, to } = walk;
        for (let i = walk.from; i < to - 1; i += 1) sum += num[i];
        before = sum;
        sum += num[to - 1];
    }
    walk.before = before;
    return sum;
}

// `start` and a stored row of an array that stands for more than its own numbers, with the sum before the last
// addition left in `walk.before`. It is apart from the loop above, which must stay small to stay fast.
function addRow(walk: Walk, recalc: Recalc, start: number): number {
    const { num, from, to, reps, rows } = walk;
    let sum = start;
    let cells = 0;
    let equal = true;
    for (let i = from; i < to; i += 1) {
        cells += reps === null ? 1 : reps[i];
        equal &&= num[i] === num[from];
    }
    if (equal) {
        walk.before = repeated(sum, num[from], cells * rows - 1);
        return walk.before + num[from];
    }
    // A row of different numbers that stands for many written rows is added that many times over.
    if (!recalc.spend((rows - 1) * (to - from))) {
        walk.fail(CALC);
        return sum;
    }
    for (let row = 0; row < rows; row += 1) {
        for (let i = from; i < to; i += 1) {
            walk.before = reps === null ? sum : repeated(sum, num[i], reps[i] - 1);
            sum = walk.before + num[i];
        }
    }
    return sum;
}

// `start` after `value` was added to it `times` times, one addition at a time.
export function repeated(start: number, value: number, times: number): number {
    let sum = start;
    let left = times;
    while (left > 0) {
        const once = sum + value;
        if (once === sum) return once;
        const twice = once + value;
        const step = twice - once;
        const size = Math.abs(sum);
        // The power of two at or under the sum: the logarithm can be off by one, which the comparisons mend.
        let low = size === 0 ? 0 : 2 ** Math.floor(Math.log2(size));
        if (low > size) low /= 2;
        else if (low * 2 <= size) low *= 2;
        const reached = Math.abs(twice);
        // Two equal steps that stay between the same powers of two, on the same side of zero, are the step of
        // every addition up to the next power: there the spacing of doubles changes, so that one is made singly.
        if (once - sum === step && reached >= low && reached < 2 * low && twice > 0 === sum > 0) {
            const span = reached > size ? 2 * low - size : size - low;
            const steps = Math.min(left, Math.ceil(span / Math.abs(step)) - 1);
            sum += steps * step;
            left -= steps;
        } else {
            sum = once;
            left -= 1;
        }
    }
    return sum;
}
