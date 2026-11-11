// The functions on numbers. ABS and ROUND are the plain case of numbers in and one out, SUM adds what the walk
// over its arguments hands it, SUMPRODUCT multiplies its arguments as an operator on arrays does and adds the
// products the same way, and SUMIF and SUMIFS add what the criteria module matched.

import { lift } from '../eval/call';
import type { Walk } from '../eval/walk';
import { Take } from '../eval/walk';
import type { FormulaError } from '../values/errors';
import { VALUE } from '../values/errors';
import { roundDecimal, snapSum } from '../values/precision';
import type { ArrayValue, Scalar } from '../values/value';
import { isArray, isError, isReference, OMITTED } from '../values/value';
import { tally } from './criteria';
import type { FunctionBody } from './registry';
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
    const sum = walk.add();
    return snapSum(sum, walk.before);
}

// One product per position of the arguments of SUMPRODUCT: what is no number counts as 0.
const PRODUCT = define(
    '',
    [SCALAR],
    (args) => {
        let product = 1;
        for (const arg of args) product *= typeof arg === 'number' ? arg : 0;
        return product;
    },
    0,
    1,
);

// The first error among the values of one argument, row by row.
function errorIn(value: Scalar | ArrayValue): FormulaError | null {
    if (!isArray(value)) return isError(value) ? value : null;
    for (let i = 0; value.nums === null && i < value.items.length; i += 1) {
        const item = value.items[i];
        if (isError(item)) return item;
    }
    return null;
}

// Every argument must have the same size, and an error in an earlier argument wins over one in a later, whatever
// their rows. The products are added in the order SUM adds a range, and no addition snaps.
const sumproduct: FunctionBody = (args, ctx, node, sheet, row, column) => {
    const factors: (Scalar | ArrayValue)[] = [];
    let sized = true;
    for (const arg of args) {
        if (isReference(arg) && arg.next !== null) return VALUE;
        const factor = ctx.read(arg);
        const error = errorIn(factor);
        if (error !== null) return error;
        sized &&=
            heightOf(factor) === heightOf(factors[0] ?? factor) && widthOf(factor) === widthOf(factors[0] ?? factor);
        factors.push(factor);
    }
    if (!sized) return VALUE;
    const [first] = factors;
    const products =
        factors.length === 1 && isArray(first)
            ? first
            : isArray(first)
              ? lift(ctx, PRODUCT, factors, node, sheet, row, column)
              : PRODUCT.run(factors, ctx, node, sheet, row, column);
    const { walk } = ctx;
    walk.start([products], Take.Numbers);
    const sum = walk.add();
    return walk.error ?? sum;
};

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
