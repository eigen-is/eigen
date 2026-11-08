// Row and column inserts, deletes, hides and unhides on the open workbook. The engine shifts what every reader of the
// workbook sees, such as the cells, the formulas and the validation rules (applySheetsInsertRowCol). This module
// writes that result back into the editor's draft, then shifts what the engine leaves alone, such as the links, the
// calc chain and the selection. A local edit, a peer's op and an undo all come through here. It also tells the editors
// and the arrow keys where the hidden rows and columns are.

import { isRecord } from '@workspace/lib/guards';
import type { DeleteRowColOp, InsertRowColOp } from '../../engine/rowcol';
import {
    applySheetsDeleteRowCol,
    applySheetsInsertRowCol,
    shiftCellKeyedForDelete,
    shiftCellKeyedForInsert,
} from '../../engine/rowcol';
import { getSheet } from '../api/common';
import type { Context } from '../context';
import { getSheetConfig } from '../context';
import type { CalcChainEntry, Sheet } from '../types';
import { getSheetIndex } from '../utils';

export function insertRowCol(
    ctx: Context,
    op: InsertRowColOp,
    changeSelection = true,
    // applyOpBatch sets fromBatch for a peer's op or an undo. Such a batch applies for a read-only viewer too, and
    // applyOpBatch moves the selection itself. So the permission check stops only a viewer's own insert.
    fromBatch = false,
) {
    if (!fromBatch && ctx.allowEdit === false) return;
    const id = op.id || ctx.currentSheetId;
    const { type, index, count, direction } = op;

    writeBackSheets(ctx, applySheetsInsertRowCol(ctx.sheets, { ...op, id }));

    const sheetIndex = getSheetIndex(ctx, id);
    if (sheetIndex == null) return;
    const sheet = ctx.sheets[sheetIndex];

    const insertAt = direction === 'lefttop' ? index : index + 1;
    const shift = (at: number) => (at >= insertAt ? at + count : at);
    // The calc chain is this tab's recalc list and is never stored, so the engine does not move it.
    sheet.calcChain = (sheet.calcChain ?? []).map((entry) =>
        type === 'row' ? { ...entry, r: shift(entry.r) } : { ...entry, c: shift(entry.c) },
    );

    sheet.hyperlink = shiftCellKeyedForInsert(sheet.hyperlink, type, index, count, direction);

    const { data } = sheet;
    if (changeSelection && data) {
        const span = [insertAt, insertAt + count - 1];
        const selections =
            type === 'row'
                ? [{ row: span, column: [0, data[0].length - 1] }]
                : [{ row: [0, data.length - 1], column: span }];
        sheet.selections = selections;
        if (id === ctx.currentSheetId) ctx.selections = selections;
    }

    ctx.formulaCache.formulaCellInfoMap = null;
}

export function deleteRowCol(
    ctx: Context,
    op: DeleteRowColOp,
    // applyOpBatch sets fromBatch for a peer's op or an undo. Such a batch applies for a read-only viewer too, and
    // applyOpBatch moves the selection itself. So the permission check stops only a viewer's own delete.
    fromBatch = false,
) {
    if (!fromBatch && ctx.allowEdit === false) return;
    const id = op.id || ctx.currentSheetId;
    const { type, start, end } = op;

    writeBackSheets(ctx, applySheetsDeleteRowCol(ctx.sheets, { ...op, id }));

    const sheetIndex = getSheetIndex(ctx, id);
    if (sheetIndex == null) return;
    const sheet = ctx.sheets[sheetIndex];

    const deletedCount = end - start + 1;
    const calcChain: CalcChainEntry[] = [];
    for (const entry of sheet.calcChain ?? []) {
        const at = type === 'row' ? entry.r : entry.c;
        if (at < start) calcChain.push(entry);
        else if (at > end) {
            calcChain.push(type === 'row' ? { ...entry, r: at - deletedCount } : { ...entry, c: at - deletedCount });
        }
    }
    sheet.calcChain = calcChain;

    sheet.hyperlink = shiftCellKeyedForDelete(sheet.hyperlink, type, start, end);
    if (!fromBatch) ctx.selections = undefined;

    ctx.formulaCache.formulaCellInfoMap = null;
}

// Hiding moves the selection one step off the rows or columns it hid: up when they end the sheet or a hidden one
// follows them, down otherwise. More than one selection returns 'noMulti', which the context menu shows as an alert.
export function hideSelectedRowCol(ctx: Context, type: 'row' | 'column') {
    if (!ctx.selections || ctx.selections.length > 1) return 'noMulti';
    const sheet = getSheet(ctx);
    const { data } = sheet;
    // A sheet that is not loaded has nothing to hide.
    if (!data) return '';
    const config = (sheet.config ??= {});
    const key = type === 'row' ? 'rowhidden' : 'colhidden';
    // A peer's replace can leave a hidden value that is no map. The hide starts a new map then, as on a sheet that
    // has none, because writing into a number or a string throws.
    const kept = config[key];
    const hidden = isRecord(kept) ? kept : (config[key] = {});
    const span = ctx.selections[0][type];
    const [first, last] = span;
    for (let i = first; i <= last; i += 1) hidden[i] = 0;
    const length = type === 'row' ? data.length : data[0].length;
    const step = last === length - 1 || hidden[last + 1] != null ? -1 : 1;
    span[0] += step;
    span[1] += step;
    return '';
}

export function showSelectedRowCol(ctx: Context, type: 'row' | 'column') {
    if (!ctx.selections || ctx.selections.length > 1) return 'noMulti';
    // Showing never creates the hidden map. On a sheet with nothing hidden, a new empty map would still ship an op
    // to peers and take an undo entry, for a change that does nothing.
    const config = getSheetConfig(ctx);
    const hidden = type === 'row' ? config?.rowhidden : config?.colhidden;
    if (hidden) {
        const [first, last] = ctx.selections[0][type];
        for (let i = first; i <= last; i += 1) delete hidden[i];
    }
    return '';
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

// Writes the engine's result back one sheet and one field at a time, never `ctx.sheets = ...` or a whole sheet.
// A whole write makes immer emit one replace that carries the whole workbook, and collab would ship it on every
// edit. Undoing a whole sheet would also put back its images and charts over a peer's later changes. A moved chart
// gets only the fields that changed, and a keyed part of its spec one entry at a time. So a peer's move or delete
// of that chart, or its edit of another entry, survives, and the undo puts back only the entries the op moved. A
// validation rule the op moved or dropped is written whole under its id, so a rule a peer added or deleted meanwhile
// stays as the peer left it.
function writeBackSheets(ctx: Context, sheets: Sheet[]) {
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
