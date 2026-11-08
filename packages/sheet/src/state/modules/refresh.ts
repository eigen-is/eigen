// After an edit writes cells, these bring the formula map up to date with them and recompute the formulas that read
// them: the cells the edit names, or every cell of the given or selected ranges.

import type { CellMatrix } from '../../engine/types';
import type { Context } from '../context';
import { getFlowdata } from '../context';
import type { FormulaCell, Selection } from '../types';
import { setFormulaCellInfo } from './formula-cache';
import { execFunctionGroup } from './formula-exec';

export function recomputeCells(ctx: Context, cells: readonly FormulaCell[], data?: CellMatrix | null) {
    const matrix = data ?? getFlowdata(ctx);
    // A sheet without data has nothing to refresh.
    if (!matrix) return;
    for (const cell of cells) setFormulaCellInfo(ctx, cell, matrix);
    execFunctionGroup(ctx, cells);
}

export function jfrefreshgrid(ctx: Context, data: CellMatrix | null, range: Selection[] | undefined) {
    const cells: FormulaCell[] = [];
    for (const { row, column } of range ?? ctx.selections ?? []) {
        for (let r = row[0]; r <= row[1]; r += 1) {
            for (let c = column[0]; c <= column[1]; c += 1) cells.push({ r, c, id: ctx.currentSheetId });
        }
    }
    recomputeCells(ctx, cells, data);
}
