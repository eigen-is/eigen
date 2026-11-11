// The functions on numbers. ABS and ROUND are the plain case of numbers in and one out, SUM adds what the walk
// over its arguments hands it, SUMPRODUCT loops over the planes of the columns it is given and copies no range, and
// SUMIF and SUMIFS add what the criteria module matched.

import type { Evaluator } from '../eval/evaluator';
import { columnsOf, firstError, toArray } from '../eval/views';
import type { Walk } from '../eval/walk';
import { Take } from '../eval/walk';
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

// The sum of what a walk hands out, in its order. Only the last addition can snap to 0.
export function total(walk: Walk): number {
    let sum = 0;
    let before = 0;
    while (walk.next()) {
        const { num, to } = walk;
        for (let i = walk.from; i < to - 1; i += 1) sum += num[i];
        before = sum;
        sum += num[to - 1];
    }
    return snapSum(sum, before);
}

// The numbers of one argument, row by row, with 0 for everything that is no number. A reference to one column is
// its own plane, uncopied, and stops where the column does.
function factors(ctx: Evaluator, arg: Value): Float64Array | Value {
    if (isReference(arg) && arg.left === arg.right) {
        ctx.cells.settleArea(arg);
        const error = firstError(ctx, arg);
        if (error !== null) return error;
        const column = arg.sheet.columns[arg.left];
        if (column === undefined) return new Float64Array(0);
        return column.num.subarray(arg.top, Math.min(arg.bottom + 1, column.length));
    }
    const values = isReference(arg) ? toArray(ctx, arg) : arg;
    if (!isArray(values)) return isError(values) ? values : new Float64Array([typeof values === 'number' ? values : 0]);
    if (values.nums !== null) return values.nums;
    const numbers = new Float64Array(values.items.length);
    for (let i = 0; i < numbers.length; i += 1) {
        const item = values.items[i];
        if (isError(item)) return item;
        if (typeof item === 'number') numbers[i] = item;
    }
    return numbers;
}

// Every argument must have the same size; text, booleans and blanks in them count as 0.
function sumproduct(args: readonly Value[], ctx: Evaluator): Value {
    const lists: Float64Array[] = [];
    let rows = 0;
    let columns = 0;
    for (const arg of args) {
        if (isReference(arg) && arg.next !== null) return VALUE;
        const height = isReference(arg) ? arg.bottom - arg.top + 1 : isArray(arg) ? arg.rows : 1;
        const width = isReference(arg) ? columnsOf(arg) : isArray(arg) ? arg.columns : 1;
        if (lists.length > 0 && (height !== rows || width !== columns)) return VALUE;
        rows = height;
        columns = width;
        const list = factors(ctx, arg);
        if (!(list instanceof Float64Array)) return list;
        lists.push(list);
    }
    let count = lists[0].length;
    for (const list of lists) count = Math.min(count, list.length);
    let total = 0;
    for (let i = 0; i < count; i += 1) {
        let product = lists[0][i];
        for (let k = 1; k < lists.length; k += 1) product *= lists[k][i];
        total += product;
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
