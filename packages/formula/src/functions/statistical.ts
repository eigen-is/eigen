// The functions that count and summarise. AVERAGE, MAX, MIN, COUNT and COUNTA each loop over what the walk over
// their arguments hands them, COUNTBLANK counts the cells that show nothing, and the conditional ones report what
// the criteria module matched.

import { CellKind, KIND_MASK } from '../store/column';
import { DIV0, VALUE } from '../values/errors';
import type { Reference } from '../values/value';
import { isError, isReference, OMITTED } from '../values/value';
import { tally } from './criteria';
import type { FunctionBody } from './legacy';
import { define, FunctionFlag, optional, RANGE, SCALAR } from './legacy';
import { COUNTED, FILLED, fn, NUMBERS, rest } from './registry';

// The cells of a range that are blank or hold empty text. The rows and columns past the last used one are all
// blank, so they are counted and never visited.
const countBlank: FunctionBody = (args, ctx) => {
    const range = args[0];
    if (!isReference(range)) return isError(range) ? range : VALUE;
    let blank = 0;
    for (let area: Reference | null = range; area !== null; area = area.next) {
        ctx.recalc.settleArea(area);
        // Asked once the formulas are computed: the empty text has an id only when a cell holds it.
        const empty = ctx.workbook.strings.find('');
        blank += (area.bottom - area.top + 1) * (area.right - area.left + 1);
        const { columns } = ctx.workbook.sheets[area.sheet];
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
    fn('AVERAGE', [rest(NUMBERS)], (numbers) => (numbers.count() === 0 ? DIV0 : numbers.sum() / numbers.count())),
    fn('MAX', [rest(NUMBERS)], (numbers) => (numbers.count() === 0 ? 0 : numbers.max())),
    fn('MIN', [rest(NUMBERS)], (numbers) => (numbers.count() === 0 ? 0 : numbers.min())),
    fn('COUNT', [rest(COUNTED)], (numbers) => numbers.count()),
    fn('COUNTA', [rest(FILLED)], (values) => values.count()),
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
    define('AVERAGEIF', [RANGE, SCALAR, optional(RANGE, OMITTED)], averageIf, FunctionFlag.Resizes),
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
