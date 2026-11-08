// Row and column inserts, deletes, hides and unhides on the open workbook. The engine shifts what every reader of the
// workbook sees, such as the cells, the formulas and the links (applySheetsInsertRowCol). This module writes that result
// back into the editor's draft, then shifts what only this tab holds, such as the calc chain and the selection. A local
// edit, a peer's op and an undo all come through here. It also tells the editors and the arrow keys where the hidden
// rows and columns are.

import { isRecord } from '@workspace/lib/guards';
import type { DeleteRowColOp, InsertRowColOp } from '../../engine/rowcol';
import {
    applySheetsDeleteRowCol,
    applySheetsInsertRowCol,
    shiftRangeForDelete,
    shiftRangeForInsert,
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
    // A batch applies for a read-only viewer too, so the permission check stops only a viewer's own insert.
    fromBatch = false,
) {
    if (!fromBatch && ctx.allowEdit === false) return;
    const { id, type, index, count, direction } = op;

    writeBackSheets(ctx, applySheetsInsertRowCol(ctx.sheets, op));

    const sheetIndex = getSheetIndex(ctx, id);
    if (sheetIndex == null) return;
    const sheet = ctx.sheets[sheetIndex];

    sheet.alternateFormatRules = (sheet.alternateFormatRules ?? []).map((rule) => ({
        ...rule,
        cellrange: shiftRangeForInsert(rule.cellrange, op),
    }));

    const insertAt = direction === 'lefttop' ? index : index + 1;
    const shift = (at: number) => (at >= insertAt ? at + count : at);
    // The calc chain is this tab's recalc list and is never stored, so the engine does not move it.
    sheet.calcChain = (sheet.calcChain ?? []).map((entry) =>
        type === 'row' ? { ...entry, r: shift(entry.r) } : { ...entry, c: shift(entry.c) },
    );

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
    // A batch applies for a read-only viewer too and moves the selection itself, so the permission check and the
    // selection reset are for a tab's own delete.
    fromBatch = false,
) {
    if (!fromBatch && ctx.allowEdit === false) return;
    const { id, type, start, end } = op;

    writeBackSheets(ctx, applySheetsDeleteRowCol(ctx.sheets, op));

    const sheetIndex = getSheetIndex(ctx, id);
    if (sheetIndex == null) return;
    const sheet = ctx.sheets[sheetIndex];

    sheet.alternateFormatRules = (sheet.alternateFormatRules ?? []).flatMap((rule) => {
        const cellrange = shiftRangeForDelete(rule.cellrange, op);
        return cellrange ? [{ ...rule, cellrange }] : [];
    });

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

    if (!fromBatch) ctx.selections = undefined;

    ctx.formulaCache.formulaCellInfoMap = null;
}

// Hiding moves the selection one step off the rows or columns it hid: up when they end the sheet or a hidden one
// follows them, down otherwise. More than one selection returns 'noMulti', which the context menu shows as an alert.
export function hideSelectedRowCol(ctx: Context, type: 'row' | 'column') {
    if (!ctx.selections || ctx.selections.length > 1) return 'noMulti';
    const sheet = getSheet(ctx);
    const { data } = sheet;
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
