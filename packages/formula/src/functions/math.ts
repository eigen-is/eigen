// The functions on numbers. ABS and ROUND are the plain case of numbers in and one out, SUM adds what the walk
// over its arguments hands it, SUMPRODUCT loops over the planes of the columns it is given and copies no range, and
// SUMIF and SUMIFS add what the criteria module matched.

import type { Evaluator } from '../eval/evaluator';
import { firstError, storedColumns, storedRows } from '../eval/views';
import type { Walk } from '../eval/walk';
import { Take } from '../eval/walk';
import type { FormulaError } from '../values/errors';
import { VALUE } from '../values/errors';
import { roundDecimal, snapSum } from '../values/precision';
import type { Value } from '../values/value';
import { isArray, isError, isReference, OMITTED } from '../values/value';
import { tally } from './criteria';
import {
    aggregate,
    define,
    FunctionFlag,
    INTEGER,
    NUMBER,
    optional,
    RANGE,
    SCALAR,
    scalar1,
    scalar2,
} from './registry';
import { heightOf, widthOf } from './search';

// The sum of what a walk hands out, in its order. Only the last addition can snap to 0.
export function total(walk: Walk): number {
    let sum = 0;
    let before = 0;
    while (walk.next()) {
        const { num, to, times } = walk;
        for (let i = walk.from; i < to - 1; i += 1) sum += num[i] * times;
        before = sum;
        sum += num[to - 1] * times;
    }
    return snapSum(sum, before);
}

type Factor = { readonly nums: Float64Array; readonly height: number; readonly width: number };

// One argument as numbers, with 0 for everything that is no number, stored as an array is: the last stored row and
// column stand for the rest. A reference to one column is its own plane, uncopied, when the column reaches its end.
function factorOf(ctx: Evaluator, arg: Value): Factor | FormulaError {
    if (isReference(arg)) {
        ctx.cells.settleArea(arg);
        const error = firstError(ctx, arg);
        if (error !== null) return error;
        const { columns } = arg.sheet;
        const { top, left } = arg;
        const whole = arg.right === left && arg.bottom < (columns[left]?.length ?? 0);
        if (whole)
            return { nums: columns[left].num.subarray(top, arg.bottom + 1), height: arg.bottom - top + 1, width: 1 };
        const width = storedColumns(arg);
        const height = storedRows(arg, width);
        ctx.cells.count(height * width);
        const nums = new Float64Array(height * width);
        for (let c = 0; c < width; c += 1) {
            const column = columns[left + c];
            if (column === undefined) continue;
            const held = Math.min(height, column.length - top);
            for (let r = 0; r < held; r += 1) nums[r * width + c] = column.num[top + r];
        }
        return { nums, height, width };
    }
    if (!isArray(arg))
        return isError(arg)
            ? arg
            : { nums: new Float64Array([typeof arg === 'number' ? arg : 0]), height: 1, width: 1 };
    const { items, height, width } = arg;
    if (arg.nums !== null) return { nums: arg.nums, height, width };
    const nums = new Float64Array(items.length);
    for (let i = 0; i < nums.length; i += 1) {
        const item = items[i];
        if (isError(item)) return item;
        if (typeof item === 'number') nums[i] = item;
    }
    return { nums, height, width };
}

// Every argument must have the same size; text, booleans and blanks in them count as 0. The products are added row
// by row over what the arguments store, and a last stored row or column counts for all the rows or columns it
// stands for.
function sumproduct(args: readonly Value[], ctx: Evaluator): Value {
    const factors: Factor[] = [];
    let rows = 0;
    let columns = 0;
    let height = 1;
    let width = 1;
    for (const arg of args) {
        if (isReference(arg) && arg.next !== null) return VALUE;
        if (factors.length > 0 && (heightOf(arg) !== rows || widthOf(arg) !== columns)) return VALUE;
        rows = heightOf(arg);
        columns = widthOf(arg);
        const factor = factorOf(ctx, arg);
        if (!('nums' in factor)) return factor;
        factors.push(factor);
        height = Math.max(height, factor.height);
        width = Math.max(width, factor.width);
    }
    let total = 0;
    // Where every argument stores every row and column, the elements line up and one index reads them all.
    const [first] = factors;
    let flat = true;
    for (const factor of factors) flat &&= factor.height === rows && factor.width === columns;
    for (let i = 0; flat && i < first.nums.length; i += 1) {
        let product = first.nums[i];
        for (let k = 1; k < factors.length; k += 1) product *= factors[k].nums[i];
        total += product;
    }
    for (let r = 0; !flat && r < height; r += 1) {
        const down = r === height - 1 ? rows - height + 1 : 1;
        for (let c = 0; c < width; c += 1) {
            let product = c === width - 1 ? down * (columns - width + 1) : down;
            for (const { nums, height: h, width: w } of factors)
                product *= nums[Math.min(r, h - 1) * w + Math.min(c, w - 1)];
            total += product;
        }
    }
    return total;
}

export const MATH = [
    scalar1('ABS', NUMBER, Math.abs),
    scalar2('ROUND', NUMBER, INTEGER, roundDecimal),
    aggregate('SUM', Take.Numbers, total),
    define('SUMPRODUCT', [RANGE], sumproduct, 0, 1),
    define(
        'SUMIF',
        [RANGE, SCALAR, optional(RANGE, OMITTED)],
        (args, ctx) => {
            const total = tally(ctx, args.slice(0, 2), args[2], true);
            return total.error ?? total.sum;
        },
        FunctionFlag.ReadsUnnamed,
    ),
    define(
        'SUMIFS',
        [RANGE, RANGE, SCALAR],
        (args, ctx) => {
            const total = tally(ctx, args.slice(1), args[0], false);
            return total.error ?? total.sum;
        },
        0,
        2,
    ),
];
