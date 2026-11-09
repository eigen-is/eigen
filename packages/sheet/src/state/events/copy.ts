// A copy or a cut of the grid's selection, from ⌘C, ⌘X or a menu. handleCopy refuses a range that cuts through a
// merged cell, several ranges that don't line up or whose conditional formats would not survive the paste, and a cut
// over a row a filter hides. It hands the rest to copy, and ends a format painter that was on.

import type { SingleRange } from '../../engine/types';
import { cancelPaintModel, checkCF, getComputeMap } from '..';
import { getSheet } from '../api/common';
import type { Context } from '../context';
import { movedLines } from '../modules/carry';
import { copy } from '../modules/clipboard';
import { selectIsOverlap } from '../modules/selection';
import { hasPartMC } from '../modules/validation';

export function handleCopy(ctx: Context, { cut = false }: { cut?: boolean } = {}) {
    cancelPaintModel(ctx);

    const ranges = ctx.selections ?? [];
    if (ranges.length === 0) return;
    if (ranges.some(({ row, column }) => hasPartMC(ctx, row[0], row[1], column[0], column[1]))) return;
    if (ranges.length > 1 && (holdsConditionalFormat(ctx, ranges) || !linedUp(ranges) || selectIsOverlap(ctx))) return;
    if (cut && ranges.some((range) => !movedLines(ctx, ctx.currentSheetId, range))) return;

    copy(ctx, { cut });
}

export function handleCut(ctx: Context) {
    handleCopy(ctx, { cut: true });
}

function holdsConditionalFormat(ctx: Context, ranges: readonly SingleRange[]): boolean {
    if (!getSheet(ctx).conditionalFormatRules?.length) return false;
    const computed = getComputeMap(ctx);
    return ranges.some(({ row, column }) => {
        for (let r = row[0]; r <= row[1]; r += 1) {
            for (let c = column[0]; c <= column[1]; c += 1) {
                if (checkCF(r, c, computed) != null) return true;
            }
        }
        return false;
    });
}

// Several ranges paste as one block only when they all span the same rows or the same columns.
function linedUp([first, ...rest]: readonly SingleRange[]): boolean {
    const same = (a: number[], b: number[]) => a[0] === b[0] && a[1] === b[1];
    return rest.every(({ row }) => same(row, first.row)) || rest.every(({ column }) => same(column, first.column));
}
