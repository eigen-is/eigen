// The logical functions. IF, IFERROR and IFNA take their branches lazily, so the branch not taken is never evaluated;
// AND and OR evaluate everything, and an error anywhere in their arguments is their result.

import type { Evaluator } from '../eval/evaluator';
import { firstError } from '../eval/views';
import { CellKind, KIND_MASK } from '../store/column';
import { toBoolean } from '../values/coerce';
import { NA, VALUE } from '../values/errors';
import type { Reference, Value } from '../values/value';
import { isArray, isError, isReference, OMITTED } from '../values/value';
import { define, LAZY, optional, RANGE, SCALAR } from './registry';

// AND when `all`, else OR. A value typed as an argument is coerced; in a reference or an array only numbers and
// booleans count, and with nothing to count the result is #VALUE!.
function junction(args: readonly Value[], ctx: Evaluator, all: boolean): Value {
    let counted = false;
    let result = all;
    for (const arg of args) {
        if (isReference(arg)) {
            for (let area: Reference | null = arg; area !== null; area = area.next) {
                ctx.cells.settleArea(area);
                const error = firstError(ctx, area);
                if (error !== null) return error;
                const { columns } = area.sheet;
                const right = Math.min(area.right, columns.length - 1);
                for (let c = area.left; c <= right; c += 1) {
                    const column = columns[c];
                    const end = Math.min(area.bottom + 1, column.length);
                    for (let row = area.top; row < end; row += 1) {
                        const kind = column.kind[row] & KIND_MASK;
                        if (kind !== CellKind.Number && kind !== CellKind.Boolean) continue;
                        counted = true;
                        if ((kind === CellKind.Number ? column.num[row] !== 0 : column.ref[row] !== 0) !== all)
                            result = !all;
                    }
                }
            }
        } else if (isArray(arg)) {
            for (let i = 0; i < arg.items.length; i += 1) {
                const item = arg.items[i];
                if (isError(item)) return item;
                if (typeof item !== 'number' && typeof item !== 'boolean') continue;
                counted = true;
                if ((item !== 0 && item !== false) !== all) result = !all;
            }
        } else {
            const test = arg === OMITTED ? false : toBoolean(arg);
            if (typeof test !== 'boolean') return test;
            counted = true;
            if (test !== all) result = !all;
        }
    }
    return counted ? result : VALUE;
}

export const LOGICAL = [
    define('AND', [RANGE], (args, ctx) => junction(args, ctx, true), 0, 1),
    define('OR', [RANGE], (args, ctx) => junction(args, ctx, false), 0, 1),
    define('IF', [SCALAR, LAZY, optional(LAZY, false)], (args, ctx, node, sheet, row, column) => {
        const test = toBoolean(args[0]);
        if (typeof test !== 'boolean') return test;
        const branch = test ? 1 : 2;
        return ctx.force(args[branch], node.children[branch], sheet, row, column);
    }),
    define('IFERROR', [SCALAR, LAZY], (args, ctx, node, sheet, row, column) =>
        isError(args[0]) ? ctx.force(args[1], node.children[1], sheet, row, column) : args[0],
    ),
    define('IFNA', [SCALAR, LAZY], (args, ctx, node, sheet, row, column) =>
        args[0] === NA ? ctx.force(args[1], node.children[1], sheet, row, column) : args[0],
    ),
    define('TRUE', [], () => true),
    define('FALSE', [], () => false),
];
