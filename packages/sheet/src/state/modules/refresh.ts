// After an edit writes cells, these bring the formula graph up to date with them and recompute the formulas that read
// them: the cells the edit names, or every cell of the given or selected ranges. An edit that moved a formula so it
// reads other cells names it in `formulasAt`, since no cell it reads changed.

import type { Context } from '../context';
import { getFlowdata } from '../context';
import type { FormulaCell, Selection } from '../types';
import { setFormulaCellInfo } from './formula-cache';
import { execFunctionGroup } from './formula-exec';

export function recomputeCells(ctx: Context, cells: readonly FormulaCell[], formulasAt: readonly FormulaCell[] = []) {
    const matrix = getFlowdata(ctx);
    if (!matrix) return;
    for (const cell of cells) setFormulaCellInfo(ctx, cell, matrix);
    execFunctionGroup(ctx, cells, formulasAt);
}

export function jfrefreshgrid(ctx: Context, range: readonly Selection[] = ctx.selections ?? []) {
    recomputeCells(
        ctx,
        range.flatMap((selection) => cellsIn(selection, ctx.currentSheetId)),
    );
}

export function cellsIn({ row, column }: Pick<Selection, 'row' | 'column'>, id: string): FormulaCell[] {
    const cells: FormulaCell[] = [];
    for (let r = row[0]; r <= row[1]; r += 1) {
        for (let c = column[0]; c <= column[1]; c += 1) cells.push({ r, c, id });
    }
    return cells;
}
