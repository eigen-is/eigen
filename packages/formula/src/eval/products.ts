// The products SUMPRODUCT adds: its arguments multiplied place by place, as one array that the walk then adds like
// any other. What is no number counts as 0. Ranges are multiplied straight from the columns' own numbers, and
// anything else is lined up as an operator lines up its arrays. A product too large for a number is #NUM! here,
// where it is made, so the adder is never handed one.

import { CALC, NUM } from '../values/errors';
import type { ArrayValue, Reference, Scalar, Value } from '../values/value';
import { arrayOf, heightOf, isArray, isReference, widthOf } from '../values/value';
import { align } from './bands';
import type { Evaluator } from './evaluator';

// The products of arguments of one size.
export function productsOf(ctx: Evaluator, args: readonly Value[]): Value {
    const made = rangeProducts(ctx, args) ?? lined(ctx, args);
    const numbers = isArray(made) ? made.nums : null;
    for (let i = 0; numbers !== null && i < numbers.length; i += 1) if (numbers[i] - numbers[i] !== 0) return NUM;
    return typeof made === 'number' && made - made !== 0 ? NUM : made;
}

// Read from the columns' own numbers, which are 0 for a cell that holds no number. Null when an argument is no
// range or the block would be too large.
function rangeProducts(ctx: Evaluator, args: readonly Value[]): Scalar | ArrayValue | null {
    const areas = args.filter(isReference);
    if (areas.length < args.length) return null;
    const { sheets } = ctx.workbook;
    const lengthOf = (area: Reference, c: number) =>
        (sheets[area.sheet].columns[area.left + c]?.length ?? 0) - area.top;
    const columns = widthOf(areas[0]);
    // Past the last cell of the shortest argument every product is 0, which adds nothing.
    let rows = heightOf(areas[0]);
    for (const area of areas) {
        let used = 0;
        for (let c = 0; c < columns; c += 1) used = Math.max(used, lengthOf(area, c));
        rows = Math.min(rows, used);
    }
    if (rows <= 0) return 0;
    if (!ctx.recalc.room(rows * columns)) return null;
    const products = new Float64Array(rows * columns);
    for (let c = 0; c < columns; c += 1) {
        let common = rows;
        for (const area of areas) common = Math.min(common, lengthOf(area, c));
        for (let k = 0; k < areas.length && common > 0; k += 1) {
            const { num } = sheets[areas[k].sheet].columns[areas[k].left + c];
            const { top } = areas[k];
            if (k === 0) for (let r = 0; r < common; r += 1) products[r * columns + c] = num[top + r];
            else for (let r = 0; r < common; r += 1) products[r * columns + c] *= num[top + r];
        }
    }
    return arrayOf(rows, columns, products);
}

// As an array that runs wherever one of the arguments does.
function lined(ctx: Evaluator, args: readonly Value[]): Scalar | ArrayValue {
    const factors = args.map((arg) => ctx.read(arg));
    const arrays = factors.filter(isArray);
    if (arrays.length === 0) return factors.reduce((product: number, factor) => product * numberOr0(factor), 1);
    const { rows, columns } = arrays[0];
    const down = align(arrays, rows, true);
    const across = align(arrays, columns, false);
    const width = across.count;
    if (!ctx.recalc.room(down.count * width)) return CALC;
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
