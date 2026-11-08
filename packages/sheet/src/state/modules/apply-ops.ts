// Applies one op batch to the editor's context, as replaySheetsOps applies it to a joiner's sheets: the sheet, row and
// column ops first, then the cell and field patches, whole or not at all. An op the replay's shape check refuses is
// skipped. A batch that changes the open workbook outside an edit's own recipe comes through here, such as a peer's
// batch, a log replay or a structural undo, so every tab ends the same. It reports the ops that moved rows, which the
// undo stacks follow, and a batch new to the tab moves the tab's view too, such as the cell editor and the selection.

import { cloneDeep } from 'es-toolkit/compat';
import type { Patch } from 'immer';
import { applyPatches, current, produce } from 'immer';
import { deleteRowColOf, insertRowColOf, isNewSheet, isRowColOp, renameSheetOf } from '../../engine/replay-ops';
import { shiftRangeForDelete, shiftRangeForInsert } from '../../engine/rowcol';
import type { Context } from '../context';
import type { Op, Selection, Sheet } from '../types';
import type { PatchOptions } from '../utils';
import { opToPatch } from '../utils';
import { cancelNormalSelected } from './cell';
import { registerSheetFormulas } from './formula-cache';
import { rowColMove } from './history-shift';
import { deleteRowCol, insertRowCol } from './rowcol';

import { addSheet, deleteSheet, leaveCurrentSheet, renameSheet } from './sheet';

// A row or column op the batch applied, with the sheets it was applied to.
type AppliedRowCol = { op: Op; sheets: Sheet[] };

// The next context and the row or column ops that moved rows, or null when an op failed and the batch was skipped. A
// replay passes moveView false for a batch the tab applied before, which already moved the view once.
export function applyOpBatch(
    ctx: Context,
    ops: Op[],
    moveView = true,
): { ctx: Context; moved: AppliedRowCol[] } | null {
    let patches: Patch[] = [];
    // The sheets this batch adds, whose formulas the formula map learns once the batch applied.
    const added: string[] = [];
    const moved: AppliedRowCol[] = [];
    let next: Context;
    try {
        next = produce(ctx, (draft: Context) => {
            for (const op of ops) {
                const { id } = op;
                // A batch's row or column op lands for a read-only viewer too, or the grid and the metadata patches
                // part ways. The op names its sheet, as the replay reads it, whatever its value carries. One the
                // shape check or the sheet refuses throws, and the whole batch is skipped.
                if (isRowColOp(op)) {
                    const rowCol: PatchOptions =
                        op.op === 'insertRowCol'
                            ? { insertRowColOp: insertRowColOf(op) }
                            : { deleteRowColOp: deleteRowColOf(op) };
                    const sheets = current(draft.sheets);
                    if (rowCol.insertRowColOp) insertRowCol(draft, rowCol.insertRowColOp, false, true);
                    else if (rowCol.deleteRowColOp) deleteRowCol(draft, rowCol.deleteRowColOp, true);
                    moved.push({ op, sheets });
                    if (moveView && id === draft.currentSheetId) followView(draft, rowCol);
                } else if (op.op === 'addSheet') {
                    if (!isNewSheet(op.value, draft.sheets)) continue;
                    // addSheet keeps the value it is given, so the op itself never ends up in the frozen context.
                    const value = cloneDeep(op.value);
                    addSheet(draft, value.id, undefined, value, true);
                    added.push(value.id);
                } else if (op.op === 'deleteSheet' && id) {
                    deleteSheet(draft, id, true);
                    if (moveView && id === draft.currentSheetId) leaveCurrentSheet(draft);
                } else if (op.op === 'renameSheet') {
                    renameSheet(draft, renameSheetOf(op));
                }
            }
            [patches] = opToPatch(draft, ops);
            const [first] = ops;
            if (moveView && first?.path[0] === 'hide' && first.id === draft.currentSheetId) {
                leaveCurrentSheet(draft, first.id);
            }
            if (patches.length > 0) applyPatches(draft, patches);
        });
    } catch (e) {
        console.warn('[sheet] op batch failed to apply, skipping batch:', e);
        return null;
    }
    // The formula map lives outside immer, so it follows the batch only once the batch applied.
    for (const id of added) {
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
