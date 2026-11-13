// Row and column inserts, deletes, hides and unhides on the open workbook. An insert or a delete is its marker op,
// applied through applyBatch as a peer's batch is, so the engine shifts what every reader sees, such as the cells, the
// formulas and the links, and every reader recomputes the same. followView moves what only this tab holds, such as the
// selection, for the author's op, a peer's and an undo alike. It also tells the editors and the arrow keys where the
// hidden rows and columns are.

import { GONE, mapIndex } from '@workspace/formula/text';
import { isRecord } from '@workspace/lib/guards';
import type { DeleteRowColOp, InsertRowColOp } from '../../engine/rowcol';
import { editOf, shiftRange } from '../../engine/rowcol';
import type { CellMatrix } from '../../engine/types';
import { getSheet } from '../api/common';
import type { Context } from '../context';
import { getFlowdata, getSheetConfig } from '../context';
import type { Selection } from '../types';
import { deleteMarker, insertMarker } from '../utils';
import { applyBatch } from './apply-ops';
import { cancelNormalSelected } from './cell';
import type { RowColMove } from './history-shift';

export const ONE_AREA_ONLY = 'Cannot perform this operation on multiple selection areas, please select a single area';

export function insertRowCol(ctx: Context, op: InsertRowColOp, changeSelection = true) {
    if (ctx.allowEdit === false) return;
    applyBatch(ctx, [insertMarker(op)]);
    const data = getFlowdata(ctx, op.id);
    if (changeSelection && data) {
        const first = editOf(op).index;
        const span = [first, first + op.count - 1];
        ctx.selections =
            op.type === 'row'
                ? [{ row: span, column: [0, data[0].length - 1] }]
                : [{ row: [0, data.length - 1], column: span }];
    }
}

export function deleteRowCol(ctx: Context, op: DeleteRowColOp) {
    if (ctx.allowEdit === false) return;
    applyBatch(ctx, [deleteMarker(op)]);
}

// The open cell editor and the selections move with their cells, so a commit lands where the person chose, not in the
// row that slid under it. A delete of the editor's cell closes it without writing and drops the selection.
export function followView(ctx: Context, move: RowColMove, data: CellMatrix) {
    const row = move.type === 'row';
    const last = (row ? data.length : data[0].length) - 1;
    const moved = (selections: Selection[] | undefined) =>
        selections?.map((selection) => movedSelection(selection, move, data, last));
    if (move.id !== ctx.currentSheetId) {
        const left = ctx.sheetViewRecord[move.id];
        if (left) left.selections = moved(left.selections);
        return;
    }
    const [r, c] = ctx.editingCellPosition;
    if (r != null && c != null) {
        const to = mapIndex(move.edit, row ? r : c);
        if (to === GONE) {
            cancelNormalSelected(ctx);
            ctx.selections = undefined;
            return;
        }
        ctx.editingCellPosition = row ? [to, c] : [r, to];
    }
    ctx.selections = moved(ctx.selections);
}

// Hiding moves the selection one step off the rows or columns it hid: up when they end the sheet or a hidden one
// follows them, down otherwise.
export function hideSelectedRowCol(ctx: Context, type: 'row' | 'column') {
    const selection = soleSelection(ctx);
    if (!selection) return;
    const sheet = getSheet(ctx);
    const { data } = sheet;
    if (!data) return;
    const config = (sheet.config ??= {});
    const key = type === 'row' ? 'rowhidden' : 'colhidden';
    // A peer's replace can leave a hidden value that is no map. The hide starts a new map then, as on a sheet that
    // has none, because writing into a number or a string throws.
    const kept = config[key];
    const hidden = isRecord(kept) ? kept : (config[key] = {});
    const span = selection[type];
    const [first, last] = span;
    for (let i = first; i <= last; i += 1) hidden[i] = 0;
    const length = type === 'row' ? data.length : data[0].length;
    const step = last === length - 1 || hidden[last + 1] != null ? -1 : 1;
    span[0] += step;
    span[1] += step;
}

export function showSelectedRowCol(ctx: Context, type: 'row' | 'column') {
    const selection = soleSelection(ctx);
    if (!selection) return;
    // Showing never creates the hidden map. On a sheet with nothing hidden, a new empty map would still ship an op
    // to peers and take an undo entry, for a change that does nothing.
    const config = getSheetConfig(ctx);
    const hidden = type === 'row' ? config?.rowhidden : config?.colhidden;
    if (hidden) {
        const [first, last] = selection[type];
        for (let i = first; i <= last; i += 1) delete hidden[i];
    }
}

// The cell editors refuse to edit a selection that starts on a hidden row or column, a cell nobody can see.
export function isSelectionOnHiddenRowCol(ctx: Context): boolean {
    const selection = ctx.selections?.[0];
    if (!selection) return false;
    const config = getSheetConfig(ctx);
    return config?.colhidden?.[selection.column[0]] != null || config?.rowhidden?.[selection.row[0]] != null;
}

// An arrow key moves the selection past a whole run of hidden rows or columns, so it lands on a visible one.
export function moveCountPastHiddenRowCol(ctx: Context, key: string): number {
    if (!ctx.selections) return 0;
    const vertical = key === 'ArrowUp' || key === 'ArrowDown';
    if (!vertical && key !== 'ArrowLeft' && key !== 'ArrowRight') return 1;
    const step = key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : 1;
    const config = getSheetConfig(ctx);
    const hidden = (vertical ? config?.rowhidden : config?.colhidden) ?? {};
    const [selection] = ctx.selections;
    let at = (vertical ? selection.row[0] : selection.column[0]) + step;
    let count = 1;
    while (hidden[at] != null) {
        count += 1;
        at += step;
    }
    return count;
}

// A selection moves with its cells. One a delete takes whole stays at that position, on what took its place or on the
// grid's new last line, whoever deleted it, as in Google Sheets and Excel.
function movedSelection(selection: Selection, move: RowColMove, data: CellMatrix, last: number): Selection {
    const row = move.type === 'row';
    const line = Math.min(move.edit.index, last);
    const shifted =
        shiftRange(selection, move.type, move.edit) ??
        (row ? { ...selection, row: [line, line] } : { ...selection, column: [line, line] });
    const focus = row ? selection.row_focus : selection.column_focus;
    const to = focus == null ? GONE : mapIndex(move.edit, focus);
    if (to !== GONE) return row ? { ...shifted, row_focus: to } : { ...shifted, column_focus: to };
    const [start] = row ? shifted.row : shifted.column;
    return onMergeHead(row ? { ...shifted, row_focus: start } : { ...shifted, column_focus: start }, data);
}

// A focus a delete moved into a merge takes its head, with the box over the merge, as a click does. It reads the cells'
// `mc`, since mergeBorder reads the geometry as drawn, which the op has just changed or which is another sheet's.
function onMergeHead(selection: Selection, data: CellMatrix): Selection {
    const { row, column } = selection;
    const mc = data[selection.row_focus ?? row[0]]?.[selection.column_focus ?? column[0]]?.mc;
    const head = mc && data[mc.r]?.[mc.c]?.mc;
    if (!head?.rs || !head.cs) return selection;
    return {
        ...selection,
        row: [Math.min(row[0], head.r), Math.max(row[1], head.r + head.rs - 1)],
        column: [Math.min(column[0], head.c), Math.max(column[1], head.c + head.cs - 1)],
        row_focus: head.r,
        column_focus: head.c,
    };
}

// The selection a hide or a show acts on. More than one gets the notice instead.
function soleSelection(ctx: Context) {
    if ((ctx.selections?.length ?? 0) > 1) {
        ctx.warnDialog = ONE_AREA_ONLY;
        return undefined;
    }
    return ctx.selections?.[0];
}
