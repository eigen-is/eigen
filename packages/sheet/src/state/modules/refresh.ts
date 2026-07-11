import type { CellMatrix } from '../../engine/types';
import { type Context, getFlowdata } from '../context';
import type { Selection } from '../types';
import { execFunctionGroup } from './formula-ui';
import { setFormulaCellInfo } from './formulaHelper';

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
    if (data == null) {
        data = getFlowdata(ctx)!;
    }

    if (range == null) {
        range = ctx.selections;
        if (range == null) return;
    }

    // Trigger linked updates when cell data changes
    if (isRunExecFunction) {
        runExecFunction(ctx, range, ctx.currentSheetId, data);
    }
}
