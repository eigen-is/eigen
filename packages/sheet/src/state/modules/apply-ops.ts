// Applies one op batch to the editor's context as replaySheetsOps applies it to a joiner's sheets: the sheet and row or
// column ops first, then the cell and field patches, whole or not at all, skipping each op the replay's shape check
// refuses. Every batch that changes the open workbook outside an edit's own recipe goes through it, such as a peer's
// batch, a replay of the log and a structural undo, so every tab and a joiner end the same. It reports the row or
// column ops that moved rows, which the undo stacks follow. A batch new to the tab also moves the tab's view: the open
// cell editor and the selection move with their cells, and a filter or a hidden sheet changes what the tab shows.

import { cloneDeep } from 'es-toolkit/compat';
import type { Patch } from 'immer';
import { applyPatches, current, produce } from 'immer';
import { asDeleteValue, asInsertValue, isNewSheet, isRowColOp } from '../../engine/replay-ops';
import { RowColError, shiftRangeForDelete, shiftRangeForInsert } from '../../engine/rowcol';
import type { Context } from '../context';
import type { Op, Selection, Sheet } from '../types';
import type { PatchOptions } from '../utils';
import { getSheetIndex, opToPatch } from '../utils';
import { cancelNormalSelected } from './cell';
import { createFilterOptions } from './filter';
import { registerSheetFormulas } from './formula-cache';
import { rowColMove } from './history-shift';
import { deleteRowCol, insertRowCol } from './rowcol';
import { addSheet, deleteSheet, initSheetData, leaveCurrentSheet } from './sheet';

// A row or column op the batch applied, with the sheets it was applied to.
export type AppliedRowCol = { op: Op; sheets: Sheet[] };

// The next context and the row or column ops that moved rows, or null when an op failed and the batch was skipped. A
// replay passes moveView false for a batch the tab applied before, which already moved the view once.
export function applyOpBatch(
    ctx: Context,
    ops: Op[],
    moveView = true,
): { ctx: Context; moved: AppliedRowCol[] } | null {
    let patches: Patch[] = [];
    // The sheets this batch gives a cell matrix, whose formulas the formula map learns once the batch applied.
    const materialized: string[] = [];
    const moved: AppliedRowCol[] = [];
    let next: Context;
    try {
        next = produce(ctx, (draft: Context) => {
            // A sheet nobody opened, such as a copy, holds only its stored cells. A cell or row op on it needs the
            // matrix, as the replay builds it for a joiner.
            for (const op of ops) {
                const { id } = op;
                if (id == null || (op.path[0] !== 'data' && !isRowColOp(op))) continue;
                const index = getSheetIndex(draft, id);
                if (index == null || draft.sheets[index].data) continue;
                initSheetData(draft, index, draft.sheets[index]);
                materialized.push(id);
            }
            for (const op of ops) {
                const { id } = op;
                // force: a peer's op lands for a read-only viewer too, or the grid and the metadata patches part ways.
                // The op names its sheet, as the replay reads it, whatever its value carries.
                if (isRowColOp(op) && id) {
                    const insert = op.op === 'insertRowCol' ? asInsertValue(op.value) : null;
                    const remove = op.op === 'deleteRowCol' ? asDeleteValue(op.value) : null;
                    const rowCol: PatchOptions = {
                        insertRowColOp: insert ? { ...insert, id } : undefined,
                        deleteRowColOp: remove ? { ...remove, id } : undefined,
                    };
                    const { insertRowColOp, deleteRowColOp } = rowCol;
                    if (!insertRowColOp && !deleteRowColOp) continue;
                    const sheets = current(draft.sheets);
                    const applied = skipRowColError(() => {
                        if (insertRowColOp) insertRowCol(draft, insertRowColOp, false, true);
                        else if (deleteRowColOp) deleteRowCol(draft, deleteRowColOp, true);
                    });
                    if (!applied) continue;
                    moved.push({ op, sheets });
                    if (moveView && id === draft.currentSheetId) followView(draft, rowCol);
                } else if (op.op === 'addSheet') {
                    if (!isNewSheet(op.value, draft.sheets)) continue;
                    // addSheet keeps the value it is given, so the op itself never ends up in the frozen context.
                    const value = cloneDeep(op.value);
                    // addSheet drops a cell matrix the value carries, but the replay keeps it, so it goes back once
                    // the sheet is in.
                    const { data } = value;
                    addSheet(draft, value.id, false, undefined, value, true);
                    const index = getSheetIndex(draft, value.id);
                    if (index == null) continue;
                    initSheetData(draft, index, value);
                    if (data) draft.sheets[index].data = data;
                    materialized.push(value.id);
                } else if (op.op === 'deleteSheet' && id) deleteSheet(draft, id, true);
            }
            [patches] = opToPatch(draft, ops);
            const [first] = ops;
            if (moveView && first?.path[0] === 'filterRange') draft.filterRange = first.value;
            else if (moveView && first?.path[0] === 'hide' && first.id === draft.currentSheetId) {
                leaveCurrentSheet(draft, first.id);
            }
            createFilterOptions(draft, draft.filterRange, first?.id);
            if (patches.length > 0) applyPatches(draft, patches);
        });
    } catch (e) {
        console.warn('[sheet] op batch failed to apply, skipping batch:', e);
        return null;
    }
    // The formula map lives outside immer, so it follows the batch only once the batch applied.
    for (const id of materialized) {
        const data = next.sheets.find((sheet) => sheet.id === id)?.data;
        if (data) registerSheetFormulas(next, id, data);
    }
    if (patches.length > 0) next.formulaCache.updateFormulaCache(next, { patches, inversePatches: [] }, 'redo');
    return { ctx: next, moved };
}

// The open cell editor and the selection move with their cells, so a commit or the next keystroke lands where the
// person chose, not in the row that slid under it. A delete of the editor's cell closes the editor without writing,
// and a selected range the delete takes whole goes.
function followView(draft: Context, rowCol: PatchOptions) {
    const move = rowColMove(rowCol);
    if (!move) return;
    const row = move.type === 'row';
    const [r, c] = draft.editingCellPosition;
    if (r != null && c != null) {
        const moved = move.to(row ? r : c);
        if (moved == null) cancelNormalSelected(draft);
        else draft.editingCellPosition = row ? [moved, c] : [r, moved];
    }
    if (!draft.selections) return;
    const { insertRowColOp: insert, deleteRowColOp: remove } = rowCol;
    const selections: Selection[] = [];
    for (const selection of draft.selections) {
        const shifted = insert
            ? shiftRangeForInsert(selection, insert)
            : remove && shiftRangeForDelete(selection, remove);
        if (!shifted) continue;
        const [start] = row ? shifted.row : shifted.column;
        const focus = row ? selection.row_focus : selection.column_focus;
        const at = focus == null ? start : (move.to(focus) ?? start);
        selections.push(row ? { ...shifted, row_focus: at } : { ...shifted, column_focus: at });
    }
    draft.selections = selections.length > 0 ? selections : undefined;
}

// The replay skips a row or column op the sheet refuses, such as an insert into a read-only row, and so does a client.
// True when the op applied.
function skipRowColError(apply: () => void): boolean {
    try {
        apply();
        return true;
    } catch (e) {
        if (!(e instanceof RowColError)) throw e;
        console.warn('[sheet] row or column op skipped:', e.code);
        return false;
    }
}
