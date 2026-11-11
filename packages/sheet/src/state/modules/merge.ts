// Merging and unmerging cells: mergeCells writes or removes the merge records in a sheet's config and the mc marks on
// the cells they cover, for merge all, merge by row or column, and unmerge. A merge keeps its first filled cell, so the
// cells it covers lose their values and formulas, and the formulas that read them recompute.

import { cloneDeep } from 'es-toolkit/compat';
import { cellValue } from '../../engine/format';
import { isRealNull } from '../../engine/validation';
import type { Context } from '../context';
import type { Cell, CellMatrix, MergeCell, Range } from '../types';
import { getSheetIndex } from '../utils';
import { cellsIn, recomputeCells } from './refresh';

export function mergeCells(ctx: Context, sheetId: string, ranges: Range, type: string) {
    const idx = getSheetIndex(ctx, sheetId);
    if (idx == null) return;

    const sheet = ctx.sheets[idx];
    const d = sheet.data;
    // A sheet that is not loaded has no cells to merge.
    if (!d) return;

    const merge = ((sheet.config ??= {}).merge ??= {});
    const unmerge =
        type === 'merge-cancel' || ranges.some((range) => cellsIn(range, sheetId).some(({ r, c }) => d[r][c]?.mc));

    for (const { row, column } of ranges) {
        const [r1, r2] = row;
        const [c1, c2] = column;
        if (r1 === r2 && c1 === c2) continue;

        if (unmerge) {
            unmergeRange(d, merge, r1, r2, c1, c2);
        } else if (type === 'merge-all') {
            mergeBlock(d, merge, r1, r2, c1, c2);
        } else if (type === 'merge-vertical') {
            for (let c = c1; c <= c2; c += 1) mergeBlock(d, merge, r1, r2, c, c);
        } else if (type === 'merge-horizontal') {
            for (let r = r1; r <= r2; r += 1) mergeBlock(d, merge, r, r, c1, c2);
        }
    }

    recomputeCells(
        ctx,
        ranges.flatMap((range) => cellsIn(range, sheetId)),
    );
}

// The cells a merge covered take the format of its first cell and none of its content.
function unmergeRange(d: CellMatrix, merge: Record<string, MergeCell>, r1: number, r2: number, c1: number, c2: number) {
    const firstCells: Record<string, Cell> = {};

    for (let r = r1; r <= r2; r += 1) {
        for (let c = c1; c <= c2; c += 1) {
            const cell = d[r][c];
            if (cell?.mc == null) continue;

            const key = `${cell.mc.r}_${cell.mc.c}`;
            if ('rs' in cell.mc) {
                delete cell.mc;
                delete merge[key];
                firstCells[key] = cloneDeep(cell);
            } else {
                const { v: _v, m: _m, ct: _ct, f: _f, link: _link, ...format } = cloneDeep(firstCells[key]);
                d[r][c] = format;
            }
        }
    }
}

function mergeBlock(d: CellMatrix, merge: Record<string, MergeCell>, r1: number, r2: number, c1: number, c2: number) {
    let kept: Cell | undefined;
    for (let r = r1; r <= r2; r += 1) {
        for (let c = c1; c <= c2; c += 1) {
            const cell = d[r][c];
            if (!kept && cell != null && (!isRealNull(cellValue(cell)) || cell.f != null)) kept = cloneDeep(cell);
            d[r][c] = { mc: { r: r1, c: c1 } };
        }
    }
    const span = { r: r1, c: c1, rs: r2 - r1 + 1, cs: c2 - c1 + 1 };
    d[r1][c1] = { ...kept, mc: span };
    merge[`${r1}_${c1}`] = { ...span };
}
