// Row and column inserts, deletes, hides and unhides on the open workbook. The engine shifts what every reader of the
// workbook sees, such as the cells, the formulas and the links (applySheetsInsertRowCol). This module writes that
// result back into the editor's draft, and followView moves what only this tab holds, such as the selection. A local
// edit, a peer's op and an undo all come through here, and a local edit recomputes what it affected, as a batch does once
// it applied. It also tells the editors and the arrow keys where the hidden rows and columns are.

import { isRecord } from '@workspace/lib/guards';
import type { DeleteRowColOp, InsertRowColOp } from '../../engine/rowcol';
import { applySheetsDeleteRowCol, applySheetsInsertRowCol } from '../../engine/rowcol';
import { getSheet } from '../api/common';
import type { Context } from '../context';
import { getFlowdata, getSheetConfig } from '../context';
import type { Selection, Sheet } from '../types';
import { deleteMarker, insertMarker } from '../utils';
import { cancelNormalSelected } from './cell';
import { recomputeAfterOps } from './formula-exec';
import type { RowColMove } from './history-shift';
import { deleteMove } from './history-shift';

export const ONE_AREA_ONLY = 'Cannot perform this operation on multiple selection areas, please select a single area';

export function insertRowCol(
    ctx: Context,
    op: InsertRowColOp,
    changeSelection = true,
    // A batch applies for a read-only viewer too, so the permission check stops only a viewer's own insert.
    fromBatch = false,
) {
    if (!fromBatch && ctx.allowEdit === false) return;
    const { type, index, count, direction } = op;

    writeBackSheets(ctx, applySheetsInsertRowCol(ctx.sheets, op));

    const data = getFlowdata(ctx, op.id);
    if (changeSelection && data) {
        const insertAt = direction === 'lefttop' ? index : index + 1;
        const span = [insertAt, insertAt + count - 1];
        ctx.selections =
            type === 'row'
                ? [{ row: span, column: [0, data[0].length - 1] }]
                : [{ row: [0, data.length - 1], column: span }];
    }

    ctx.formulaCache.formulaCellInfoMap = null;
    if (!fromBatch) recomputeAfterOps(ctx, [insertMarker(op)]);
}

export function deleteRowCol(
    ctx: Context,
    op: DeleteRowColOp,
    // A batch applies for a read-only viewer too, moves the view only when it is new to the tab, and recomputes once it
    // applied, so these steps are for a tab's own delete.
    fromBatch = false,
) {
    if (!fromBatch && ctx.allowEdit === false) return;
    writeBackSheets(ctx, applySheetsDeleteRowCol(ctx.sheets, op));

    ctx.formulaCache.formulaCellInfoMap = null;
    if (fromBatch) return;
    followView(ctx, deleteMove(op));
    recomputeAfterOps(ctx, [deleteMarker(op)]);
}

// The open cell editor and the selections move with their cells, so a commit lands where the person chose, not in the
// row that slid under it. A delete of the editor's cell closes the editor without writing. Runs after the op, on the
// grid it left.
export function followView(ctx: Context, move: RowColMove) {
    const row = move.type === 'row';
    const data = getFlowdata(ctx, move.id);
    const last = Math.max(((row ? data?.length : data?.[0]?.length) ?? 0) - 1, 0);
    const moved = (selections: Selection[] | undefined) =>
        selections?.map((selection) => movedSelection(selection, move, last));
    if (move.id !== ctx.currentSheetId) {
        const left = ctx.sheetViewRecord[move.id];
        if (left) left.selections = moved(left.selections);
        return;
    }
    const [r, c] = ctx.editingCellPosition;
    if (r != null && c != null) {
        const to = move.to(row ? r : c);
        if (to == null) cancelNormalSelected(ctx);
        else ctx.editingCellPosition = row ? [to, c] : [r, to];
    }
    ctx.selections = moved(ctx.selections);
}

// A selection moves with its cells. One a delete takes whole stays at that position, on what took its place or on the
// grid's new last line, whoever deleted it, as in Google Sheets and Excel.
function movedSelection(selection: Selection, move: RowColMove, last: number): Selection {
    const row = move.type === 'row';
    const line = Math.min(move.at, last);
    const shifted =
        move.range(selection) ?? (row ? { ...selection, row: [line, line] } : { ...selection, column: [line, line] });
    const [start] = row ? shifted.row : shifted.column;
    const focus = row ? selection.row_focus : selection.column_focus;
    const at = focus == null ? start : (move.to(focus) ?? start);
    return row ? { ...shifted, row_focus: at } : { ...shifted, column_focus: at };
}

// The selection a hide or a show acts on. More than one gets the notice instead.
function soleSelection(ctx: Context) {
    if ((ctx.selections?.length ?? 0) > 1) {
        ctx.warnDialog = ONE_AREA_ONLY;
        return undefined;
    }
    return ctx.selections?.[0];
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

// Writes the engine's result back one sheet and one field at a time, a chart and a validation rule one at a time, so
// the undo entry immer records puts back only what the op moved and leaves a peer's later changes alone.
export function writeBackSheets(ctx: Context, sheets: Sheet[]) {
    for (const [i, next] of sheets.entries()) {
        const sheet: Record<string, unknown> = ctx.sheets[i];
        for (const [key, value] of Object.entries(next)) {
            if (key !== 'charts' && key !== 'dataValidations' && sheet[key] !== value) sheet[key] = value;
        }
        const { dataValidations } = ctx.sheets[i];
        const shifted = next.dataValidations ?? {};
        if (dataValidations) {
            for (const [id, entry] of Object.entries(shifted)) {
                if (dataValidations[id] !== entry) dataValidations[id] = entry;
            }
            for (const id of Object.keys(dataValidations)) if (!Object.hasOwn(shifted, id)) delete dataValidations[id];
        }
        const { charts } = ctx.sheets[i];
        for (const chart of Object.values(next.charts ?? {})) {
            const stored: Record<string, unknown> | undefined = charts?.[chart.id];
            if (!stored || stored === chart) continue;
            for (const [field, value] of Object.entries(chart)) {
                const record = stored[field];
                if (record === value) continue;
                if (!isRecord(record) || !isRecord(value)) {
                    stored[field] = value;
                    continue;
                }
                for (const [entry, part] of Object.entries(value)) if (record[entry] !== part) record[entry] = part;
                for (const entry of Object.keys(record)) if (!Object.hasOwn(value, entry)) delete record[entry];
            }
        }
    }
}
