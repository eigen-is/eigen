// Applies one op batch to the editor's context, as replaySheetsOps applies it to a joiner's sheets: the sheet, row and
// column ops first, then the cell and field patches, whole or not at all, then the recompute a sheet, row or column op
// asks for. An op the replay's shape check refuses is skipped. A batch that changes the open workbook outside an edit's
// own recipe comes through here, such as a peer's batch, a log replay or a structural undo, so every tab ends the same.
// It reports the ops that moved rows, which the undo stacks follow, and a batch new to the tab moves its view too.

import { cloneDeep } from 'es-toolkit/compat';
import type { Patch } from 'immer';
import { applyPatches, current, produce } from 'immer';
import { deleteRowColOf, insertRowColOf, isNewSheet, isRowColOp, renameSheetOf } from '../../engine/replay-ops';
import type { Context } from '../context';
import type { Op, Selection, Sheet } from '../types';
import { opToPatch } from '../utils';
import { cancelNormalSelected } from './cell';
import { recomputeAfterOps } from './formula-exec';
import type { RowColMove } from './history-shift';
import { deleteMove, insertMove } from './history-shift';
import { deleteRowCol, insertRowCol, movedSelection } from './rowcol';
import { addSheet, deleteSheet, leaveCurrentSheet, renameSheet } from './sheet';

// A row or column op the batch applied, with the sheets it was applied to.
type AppliedRowCol = { move: RowColMove; sheets: Sheet[] };

// The next context and the row or column ops that moved rows, or null when an op failed and the batch was skipped. A
// replay passes moveView false for a batch the tab applied before, which already moved the view once.
export function applyOpBatch(
    ctx: Context,
    ops: Op[],
    moveView = true,
): { ctx: Context; moved: AppliedRowCol[] } | null {
    let patches: Patch[] = [];
    const moved: AppliedRowCol[] = [];
    let next: Context;
    try {
        next = produce(ctx, (draft: Context) => {
            for (const op of ops) {
                const { id } = op;
                // A row or column op lands for a read-only viewer too, or the grid and the metadata patches part ways.
                // One the shape check or the sheet refuses throws, and the whole batch is skipped.
                if (isRowColOp(op)) {
                    const sheets = current(draft.sheets);
                    let move: RowColMove;
                    if (op.op === 'insertRowCol') {
                        const insert = insertRowColOf(op);
                        insertRowCol(draft, insert, false, true);
                        move = insertMove(insert);
                    } else {
                        const remove = deleteRowColOf(op);
                        deleteRowCol(draft, remove, true);
                        move = deleteMove(remove);
                    }
                    moved.push({ move, sheets });
                    if (moveView) followView(draft, move);
                } else if (op.op === 'addSheet') {
                    if (!isNewSheet(op.value, draft.sheets)) continue;
                    // addSheet keeps the value it is given, so the op itself never ends up in the frozen context.
                    const value = cloneDeep(op.value);
                    addSheet(draft, value.id, undefined, value, true);
                } else if (op.op === 'deleteSheet' && id) {
                    deleteSheet(draft, id, true);
                    if (moveView && id === draft.currentSheetId) leaveCurrentSheet(draft);
                } else if (op.op === 'renameSheet') {
                    renameSheet(draft, renameSheetOf(op), true);
                }
            }
            [patches] = opToPatch(draft, ops);
            const [first] = ops;
            if (moveView && first?.path[0] === 'hide' && first.id === draft.currentSheetId) {
                leaveCurrentSheet(draft, first.id);
            }
            if (patches.length > 0) applyPatches(draft, patches);
            recomputeAfterOps(draft, ops);
        });
    } catch (e) {
        console.warn('[sheet] op batch failed to apply, skipping batch:', e);
        return null;
    }
    // The formula map lives outside immer, so it follows the batch only once the batch applied.
    if (patches.length > 0) next.formulaCache.updateFormulaCache(next, patches);
    return { ctx: next, moved };
}

// The open cell editor and the selections move with their cells, so a commit lands where the person chose, not in the
// row that slid under it. A delete of the editor's cell closes the editor without writing.
function followView(draft: Context, move: RowColMove) {
    if (move.id !== draft.currentSheetId) {
        const left = draft.sheetViewRecord[move.id];
        if (left) left.selections = movedSelections(left.selections, move);
        return;
    }
    const row = move.type === 'row';
    const [r, c] = draft.editingCellPosition;
    if (r != null && c != null) {
        const moved = move.to(row ? r : c);
        if (moved == null) cancelNormalSelected(draft);
        else draft.editingCellPosition = row ? [moved, c] : [r, moved];
    }
    draft.selections = movedSelections(draft.selections, move);
}

// A selected range the op's delete takes whole goes.
function movedSelections(selections: Selection[] | undefined, move: RowColMove): Selection[] | undefined {
    const moved = selections?.flatMap((selection) => movedSelection(selection, move) ?? []);
    return moved?.length ? moved : undefined;
}
