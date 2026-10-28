// After an edit writes cells, jfrefreshgrid recomputes the formulas that read them: the cells the edit recorded,
// else every cell of the given or selected ranges, then the formulas that depend on those.

import type { CellMatrix } from '../../engine/types';
import type { Context } from '../context';
import { getFlowdata } from '../context';
import type { Selection } from '../types';
import { setFormulaCellInfo } from './formula-cache';
import { execFunctionGroup } from './formula-exec';

function runExecFunction(ctx: Context, range: Selection[], index: string, data: CellMatrix) {
    // An edit (e.g. delete) may have recorded exactly which cells it changed.
    // Prefer those: recomputing the whole selection rectangle is O(cells) and
    // makes clearing a huge, mostly-empty selection (select-all + delete) slow.
    const pending = ctx.formulaCache.pendingChangedCells;
    ctx.formulaCache.pendingChangedCells = undefined;

    ctx.formulaCache.execFunctionExist = [];
    if (pending != null) {
        for (const cell of pending) {
            setFormulaCellInfo(ctx, cell, data);
            ctx.formulaCache.execFunctionExist.push(cell);
        }
    } else {
        for (let s = 0; s < range.length; s += 1) {
            for (let r = range[s].row[0]; r <= range[s].row[1]; r += 1) {
                for (let c = range[s].column[0]; c <= range[s].column[1]; c += 1) {
                    setFormulaCellInfo(ctx, { r, c, id: index }, data);
                    ctx.formulaCache.execFunctionExist.push({ r, c, id: index });
                }
            }
        }
    }
    ctx.formulaCache.execFunctionExist.reverse();
    execFunctionGroup(ctx, null, null, null, null, data);
    ctx.formulaCache.execFunctionGlobalData = null;
}

export function jfrefreshgrid(
    ctx: Context,
    data: CellMatrix | null,
    range: Selection[] | undefined,
    isRunExecFunction = true,
) {
    // No data given means the current sheet's, and a sheet without data has nothing to refresh.
    const cells = data ?? getFlowdata(ctx);
    if (!cells) return;

    if (range == null) {
        range = ctx.selections;
        if (range == null) return;
    }

    // Trigger linked updates when cell data changes
    if (isRunExecFunction) {
        runExecFunction(ctx, range, ctx.currentSheetId, cells);
    }
}
