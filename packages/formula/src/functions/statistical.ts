// The functions that count and summarise. AVERAGE, MAX, MIN, COUNT and COUNTA each loop over what the walk over
// their arguments hands them, COUNTBLANK counts the cells that show nothing, and the conditional ones report what
// the criteria module matched.

import type { Walk } from '../eval/walk';
import { Take } from '../eval/walk';
import { CellKind, KIND_MASK } from '../store/column';
import { DIV0, VALUE } from '../values/errors';
import type { Reference } from '../values/value';
import { isError, isReference, OMITTED } from '../values/value';
import { tally } from './criteria';
import type { FunctionBody } from './legacy';
import { aggregate, define, FunctionFlag, optional, RANGE, SCALAR } from './legacy';
import { total } from './math';

function counted(walk: Walk): number {
    while (walk.next());
    return walk.count;
}

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
    aggregate('AVERAGE', Take.Numbers, (walk) => {
        const sum = total(walk);
        return walk.count === 0 ? DIV0 : sum / walk.count;
    }),
    aggregate('MAX', Take.Numbers, (walk) => {
        let most = Number.NEGATIVE_INFINITY;
        while (walk.next()) for (let i = walk.from; i < walk.to; i += 1) if (walk.num[i] > most) most = walk.num[i];
        return walk.count === 0 ? 0 : most;
    }),
    aggregate('MIN', Take.Numbers, (walk) => {
        let least = Number.POSITIVE_INFINITY;
        while (walk.next()) for (let i = walk.from; i < walk.to; i += 1) if (walk.num[i] < least) least = walk.num[i];
        return walk.count === 0 ? 0 : least;
    }),
    aggregate('COUNT', Take.Counted, counted),
    aggregate('COUNTA', Take.Filled, counted),
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
