// The functions on numbers. ABS and ROUND are the plain case of numbers in and one out, SUM adds what the walk
// over its arguments hands it, SUMPRODUCT multiplies its arguments as an operator on arrays does and adds the
// products the same way, and SUMIF and SUMIFS add what the criteria module matched.

import { align } from '../eval/bands';
import type { Evaluator } from '../eval/evaluator';
import { Families } from '../eval/families';
import { heightOf, widthOf } from '../eval/search';
import { firstError } from '../eval/views';
import type { FormulaError } from '../values/errors';
import { CALC, VALUE } from '../values/errors';
import { roundDecimal } from '../values/precision';
import type { Value } from '../values/value';
import { arrayOf, isArray, isError, isReference, MOST_ELEMENTS, OMITTED } from '../values/value';
import { tally } from './criteria';
import type { FunctionBody } from './legacy';
import { define, FunctionFlag, optional, RANGE, SCALAR } from './legacy';
import { fn, INTEGER, NUMBER, NUMBERS, rest } from './registry';

// The first error among the values of one argument, row by row, once the formulas in it are computed.
function errorIn(ctx: Evaluator, arg: Value): FormulaError | null {
    if (isReference(arg)) {
        ctx.recalc.settleArea(arg);
        return firstError(ctx, arg);
    }
    if (!isArray(arg)) return isError(arg) ? arg : null;
    for (let i = 0; arg.nums === null && i < arg.items.length; i += 1) {
        const item = arg.items[i];
        if (isError(item)) return item;
    }
    return null;
}

// The products of ranges of one size as an array, read from the columns' own numbers, which are 0 for a cell that
// holds no number. Null when an argument is no range or the block would be too large: the lift then makes them.
function rangeProducts(ctx: Evaluator, args: readonly Value[]): Value | null {
    const areas = args.filter(isReference);
    if (areas.length < args.length) return null;
    const columns = widthOf(areas[0]);
    // Past the last cell of the shortest argument every product is 0, which adds nothing.
    let rows = heightOf(areas[0]);
    for (const area of areas) {
        let used = 0;
        for (let c = 0; c < columns; c += 1) {
            used = Math.max(used, (ctx.workbook.sheets[area.sheet].columns[area.left + c]?.length ?? 0) - area.top);
        }
        rows = Math.min(rows, used);
    }
    if (rows <= 0) return 0;
    if (!ctx.recalc.room(rows * columns, MOST_ELEMENTS)) return null;
    const products = new Float64Array(rows * columns);
    for (let c = 0; c < columns; c += 1) {
        let common = rows;
        for (const area of areas) {
            common = Math.min(common, (ctx.workbook.sheets[area.sheet].columns[area.left + c]?.length ?? 0) - area.top);
        }
        for (let k = 0; k < areas.length && common > 0; k += 1) {
            const { num } = ctx.workbook.sheets[areas[k].sheet].columns[areas[k].left + c];
            const { top } = areas[k];
            if (k === 0) for (let r = 0; r < common; r += 1) products[r * columns + c] = num[top + r];
            else for (let r = 0; r < common; r += 1) products[r * columns + c] *= num[top + r];
        }
    }
    return arrayOf(rows, columns, products);
}

// The products of arguments of one size, as an array that runs wherever one of them does. What is no number
// counts as 0.
function products(ctx: Evaluator, args: readonly Value[]): Value {
    const factors = args.map((arg) => ctx.read(arg));
    const arrays = factors.filter(isArray);
    if (arrays.length === 0) return factors.reduce((product: number, factor) => product * numberOr0(factor), 1);
    const { rows, columns } = arrays[0];
    const down = align(arrays, rows, true);
    const across = align(arrays, columns, false);
    const width = across.count;
    if (!ctx.recalc.room(down.count * width, MOST_ELEMENTS)) return CALC;
    const made = new Float64Array(down.count * width).fill(1);
    for (let k = 0; k < arrays.length; k += 1) {
        const { items } = arrays[k];
        const rowOf = down.from[k];
        const columnOf = across.from[k];
        for (let r = 0; r < down.count; r += 1) {
            const start = (rowOf === null ? r : rowOf[r]) * arrays[k].width;
            for (let c = 0; c < width; c += 1) {
                made[r * width + c] *= numberOr0(items[start + (columnOf === null ? c : columnOf[c])]);
            }
        }
    }
    return arrayOf(rows, columns, made, down.ends, across.ends);
}

function numberOr0(value: Value): number {
    return typeof value === 'number' ? value : 0;
}

// Every argument must have the same size, and an error in an earlier argument wins over one in a later, whatever
// their rows. The products are added in the order SUM adds a range, and no addition snaps.
const sumproduct: FunctionBody = (args, ctx) => {
    let sized = true;
    for (const arg of args) {
        if (isReference(arg) && arg.next !== null) return VALUE;
        const error = errorIn(ctx, arg);
        if (error !== null) return error;
        sized &&= heightOf(arg) === heightOf(args[0]) && widthOf(arg) === widthOf(args[0]);
    }
    if (!sized) return VALUE;
    const { walk } = ctx;
    walk.start([rangeProducts(ctx, args) ?? products(ctx, args)], 0, 1, Families.Numbers);
    const sum = walk.add();
    return walk.error ?? sum;
};

export const MATH = [
    fn('ABS', [NUMBER], Math.abs),
    fn('ROUND', [NUMBER, INTEGER], roundDecimal),
    fn('SUM', [rest(NUMBERS)], (numbers) => numbers.sum()),
    define('SUMPRODUCT', [RANGE], sumproduct, 0, 1),
    define(
        'SUMIF',
        [RANGE, SCALAR, optional(RANGE, OMITTED)],
        (args, ctx) => {
            const total = tally(ctx, args.slice(0, 2), args[2], true);
            return total.error ?? total.sum;
        },
        FunctionFlag.Resizes,
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
