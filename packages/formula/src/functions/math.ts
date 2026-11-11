// The functions on numbers. SUM and SUMPRODUCT loop over the planes of the columns they are given and copy no
// range; ABS is the plain case of one number in and one out.

import type { Evaluator } from '../eval/evaluator';
import { columnsOf, firstError, toArray } from '../eval/views';
import { toNumber } from '../values/coerce';
import { VALUE } from '../values/errors';
import { snapSum } from '../values/precision';
import type { Reference, Value } from '../values/value';
import { isArray, isError, isReference, OMITTED } from '../values/value';
import { define, RANGE, scalar1 } from './registry';

// The total is added in argument order, down each column of a reference, and only its last addition can snap to 0.
// In a reference or an array a 0 is no addition, so a column is summed without looking at what its cells are.
function sum(args: readonly Value[], ctx: Evaluator): Value {
    let total = 0;
    let before = 0;
    for (const arg of args) {
        if (isReference(arg)) {
            for (let area: Reference | null = arg; area !== null; area = area.next) {
                ctx.cells.settleArea(area);
                const error = firstError(ctx, area);
                if (error !== null) return error;
                const { columns } = area.sheet;
                const right = Math.min(area.right, columns.length - 1);
                for (let c = area.left; c <= right; c += 1) {
                    const { num, length } = columns[c];
                    let end = Math.min(area.bottom + 1, length);
                    while (end > area.top && num[end - 1] === 0) end -= 1;
                    if (end <= area.top) continue;
                    for (let row = area.top; row < end - 1; row += 1) total += num[row];
                    before = total;
                    total += num[end - 1];
                }
            }
        } else if (isArray(arg)) {
            for (let i = 0; i < arg.items.length; i += 1) {
                const item = arg.items[i];
                if (isError(item)) return item;
                if (typeof item !== 'number' || item === 0) continue;
                before = total;
                total += item;
            }
        } else if (arg !== OMITTED) {
            const number = toNumber(arg);
            if (typeof number !== 'number') return number;
            before = total;
            total += number;
        }
    }
    return snapSum(total, before);
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
    scalar1('ABS', toNumber, Math.abs),
    define('SUM', [RANGE], sum, 0, 1),
    define('SUMPRODUCT', [RANGE], sumproduct, 0, 1),
];
