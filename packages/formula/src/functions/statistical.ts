// The functions that count and summarise. COUNT and COUNTA count the cells of what they are given, COUNTBLANK the
// cells that show nothing, and the conditional ones report what the criteria module matched.

import type { Evaluator } from '../eval/evaluator';
import { CellKind, KIND_MASK } from '../store/column';
import { DIV0, VALUE } from '../values/errors';
import { parseNumber } from '../values/parse-number';
import type { Reference, Value } from '../values/value';
import { isArray, isError, isReference, OMITTED } from '../values/value';
import { tally } from './criteria';
import type { FunctionBody } from './registry';
import { define, FunctionFlag, optional, RANGE, SCALAR } from './registry';

// COUNTA when `all`, else COUNT. In a reference or an array only numbers count for COUNT; a value typed as an
// argument also counts when it reads as a number, and an argument left out counts for both.
function count(args: readonly Value[], ctx: Evaluator, all: boolean): number {
    let counted = 0;
    for (const arg of args) {
        if (isReference(arg)) {
            for (let area: Reference | null = arg; area !== null; area = area.next) {
                ctx.cells.settleArea(area);
                const { columns } = area.sheet;
                const right = Math.min(area.right, columns.length - 1);
                for (let c = area.left; c <= right; c += 1) {
                    const { kind, length } = columns[c];
                    const end = Math.min(area.bottom + 1, length);
                    for (let row = area.top; row < end; row += 1) {
                        const held = kind[row] & KIND_MASK;
                        if (all ? held !== CellKind.Empty : held === CellKind.Number) counted += 1;
                    }
                }
            }
        } else if (isArray(arg)) {
            for (let i = 0; i < arg.items.length; i += 1) {
                const item = arg.items[i];
                if (all ? item !== null : typeof item === 'number') counted += 1;
            }
        } else if (all || arg === OMITTED || typeof arg === 'number' || typeof arg === 'boolean') counted += 1;
        else if (typeof arg === 'string' && parseNumber(arg) !== undefined) counted += 1;
    }
    return counted;
}

// The cells of a range that are blank or hold empty text. The rows and columns past the last used one are all
// blank, so they are counted and never visited.
const countBlank: FunctionBody = (args, ctx) => {
    const range = args[0];
    if (!isReference(range)) return isError(range) ? range : VALUE;
    let blank = 0;
    for (let area: Reference | null = range; area !== null; area = area.next) {
        ctx.cells.settleArea(area);
        // Asked once the formulas are computed: the empty text has an id only when a cell holds it.
        const empty = ctx.workbook.strings.find('');
        blank += (area.bottom - area.top + 1) * (area.right - area.left + 1);
        const { columns } = area.sheet;
        const right = Math.min(area.right, columns.length - 1);
        for (let c = area.left; c <= right; c += 1) {
            const { kind, ref, length } = columns[c];
            const end = Math.min(area.bottom + 1, length);
            for (let row = area.top; row < end; row += 1) {
                const held = kind[row] & KIND_MASK;
                if (held !== CellKind.Empty && !(held === CellKind.Text && ref[row] === empty)) blank -= 1;
            }
        }
    }
    return blank;
};

const averageIf: FunctionBody = (args, ctx) => {
    const total = tally(ctx, args.slice(0, 2), args[2], true);
    return total.error ?? (total.numbers === 0 ? DIV0 : total.sum / total.numbers);
};

export const STATISTICAL = [
    define('COUNT', [RANGE], (args, ctx) => count(args, ctx, false), 0, 1),
    define('COUNTA', [RANGE], (args, ctx) => count(args, ctx, true), 0, 1),
    define('COUNTBLANK', [RANGE], countBlank),
    define('COUNTIF', [RANGE, SCALAR], (args, ctx) => {
        const total = tally(ctx, args, null, false);
        return total.error ?? total.matched;
    }),
    define(
        'COUNTIFS',
        [RANGE, SCALAR],
        (args, ctx) => {
            const total = tally(ctx, args, null, false);
            return total.error ?? total.matched;
        },
        0,
        2,
    ),
    define('AVERAGEIF', [RANGE, SCALAR, optional(RANGE, OMITTED)], averageIf, FunctionFlag.ReadsUnnamed),
    define(
        'AVERAGEIFS',
        [RANGE, RANGE, SCALAR],
        (args, ctx) => {
            const total = tally(ctx, args.slice(1), args[0], false);
            return total.error ?? (total.numbers === 0 ? DIV0 : total.sum / total.numbers);
        },
        0,
        2,
    ),
    define(
        'MAXIFS',
        [RANGE, RANGE, SCALAR],
        (args, ctx) => {
            const total = tally(ctx, args.slice(1), args[0], false);
            return total.error ?? (total.numbers === 0 ? 0 : total.max);
        },
        0,
        2,
    ),
    define(
        'MINIFS',
        [RANGE, RANGE, SCALAR],
        (args, ctx) => {
            const total = tally(ctx, args.slice(1), args[0], false);
            return total.error ?? (total.numbers === 0 ? 0 : total.min);
        },
        0,
        2,
    ),
];
