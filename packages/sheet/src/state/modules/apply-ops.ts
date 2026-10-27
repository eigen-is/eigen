// Applies one op batch to the editor's context, the way replaySheetsOps applies it to a joiner's sheets: the sheet and
// row or column ops first, then the cell and field patches, resolved against the sheets those ops left. A batch applies
// whole or not at all. A peer's batch, the batches queued before the grid mounted, and every structural undo or redo
// go through it, so the client that sends a batch, the peers that take it and a joiner all end the same.

import { cloneDeep } from 'es-toolkit/compat';
import type { Patch } from 'immer';
import { applyPatches, produce } from 'immer';
import { RowColError } from '../../engine/rowcol';
import type { Context } from '../context';
import type { Op } from '../types';
import { getSheetIndex, opToPatch } from '../utils';
import { createFilterOptions } from './filter';
import { registerSheetFormulas } from './formula-cache';
import { deleteRowCol, insertRowCol } from './rowcol';
import { addSheet, deleteSheet, initSheetData, leaveCurrentSheet } from './sheet';

// The next context, or null when an op failed and the batch was skipped.
export function applyOpBatch(ctx: Context, ops: Op[]): Context | null {
    let patches: Patch[] = [];
    // The sheets this batch gives a cell matrix, whose formulas the formula map learns once the batch applied.
    const materialized: string[] = [];
    let next: Context;
    try {
        next = produce(ctx, (draft: Context) => {
            // A sheet nobody opened, such as a copy, holds only its stored cells. A cell or row op on it needs the
            // matrix, as the replay builds it for a joiner.
            for (const { op, id, path } of ops) {
                if (id == null || (path[0] !== 'data' && op !== 'insertRowCol' && op !== 'deleteRowCol')) continue;
                const index = getSheetIndex(draft, id);
                if (index == null || draft.sheets[index].data) continue;
                initSheetData(draft, index, draft.sheets[index]);
                materialized.push(id);
            }
            for (const op of ops) {
                // force: a peer's op lands for a read-only viewer too, or the grid and the metadata patches part ways.
                if (op.op === 'insertRowCol') skipRowColError(() => insertRowCol(draft, op.value, false, true));
                else if (op.op === 'deleteRowCol') skipRowColError(() => deleteRowCol(draft, op.value, true));
                else if (op.op === 'addSheet' && op.value?.id) {
                    // addSheet keeps the value it is given, so the op itself never ends up in the frozen context.
                    const value = cloneDeep(op.value);
                    addSheet(draft, undefined, value.id, false, undefined, value, true);
                    const index = getSheetIndex(draft, value.id);
                    if (index == null) continue;
                    initSheetData(draft, index, value);
                    materialized.push(value.id);
                } else if (op.op === 'deleteSheet' && op.id) deleteSheet(draft, op.id, true);
            }
            [patches] = opToPatch(draft, ops);
            if (ops[0]?.path?.[0] === 'filterRange') draft.filterRange = ops[0].value;
            else if (ops[0]?.path?.[0] === 'hide' && ops[0].id === draft.currentSheetId) {
                leaveCurrentSheet(draft, ops[0].id);
            }
            createFilterOptions(draft, draft.filterRange, ops[0]?.id);
            if (patches.length > 0) applyPatches(draft, patches);
        });
    } catch (e) {
        console.warn('[sheet] op batch failed to apply, skipping batch:', e);
        return null;
    }
    // The formula map lives outside immer, so it follows the batch only once the batch applied.
    for (const id of materialized) {
        const data = next.sheets[getSheetIndex(next, id) ?? -1]?.data;
        if (data) registerSheetFormulas(next, id, data);
    }
    if (patches.length > 0) next.formulaCache.updateFormulaCache(next, { patches, inversePatches: [] }, 'redo');
    return next;
}

// The replay skips a row or column op the sheet refuses, such as an insert into a read-only row, and so does a client.
function skipRowColError(apply: () => void) {
    try {
        apply();
    } catch (e) {
        if (!(e instanceof RowColError)) throw e;
        console.warn('[sheet] row or column op skipped:', e.code);
    }
}
