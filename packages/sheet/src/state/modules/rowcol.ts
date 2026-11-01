// Row and column inserts, deletes, hides and unhides on the open workbook. The engine shifts the cells, merges
// and formulas of every sheet (applySheetsInsertRowCol, applySheetsDeleteRowCol); this module writes that result
// back into the editor's draft and shifts what only the editor keeps, such as the filter, read-only rows, the
// calc chain, validation rules, links and the selection. A local edit and a peer's op both come through here.

import { isRecord } from '@workspace/lib/guards';
import { cloneDeep } from 'es-toolkit/compat';
import {
    applySheetsDeleteRowCol,
    applySheetsInsertRowCol,
    shiftCellKeyedForDelete,
    shiftCellKeyedForInsert,
    shiftKeyedMapForDelete,
    shiftKeyedMapForInsert,
    shiftRangeForDelete,
    shiftRangeForInsert,
} from '../../engine/rowcol';
import { getSheet } from '../api/common';
import type { Context } from '../context';
import { getSheetConfig } from '../context';
import type { CalcChainEntry, Sheet } from '../types';
import { getSheetIndex } from '../utils';
import { shiftFilterForDelete, shiftFilterForInsert } from './filter-shift';

export function insertRowCol(
    ctx: Context,
    op: {
        type: 'row' | 'column';
        index: number;
        count: number;
        direction: 'lefttop' | 'rightbottom';
        id: string;
    },
    changeSelection = true,
    // A batch through applyOpBatch, such as a peer's op or an undo, applies for a read-only viewer too, and
    // applyOpBatch moves the selection with the cells. The permission guard blocks a viewer's own insert only.
    fromBatch = false,
) {
    if (!fromBatch && ctx.allowEdit === false) return;
    const id = op.id || ctx.currentSheetId;
    const { type, index, count, direction } = op;

    writeBackSheets(ctx, applySheetsInsertRowCol(ctx.sheets, { ...op, id }));

    const sheetIndex = getSheetIndex(ctx, id);
    if (sheetIndex == null) return;
    const sheet = ctx.sheets[sheetIndex];

    // The engine refuses an op on a read-only row or column but does not move them.
    // They shift here, by the same rule as hidden rows and columns.
    const { config } = sheet;
    if (type === 'row' && config?.rowReadOnly) {
        config.rowReadOnly = shiftKeyedMapForInsert(config.rowReadOnly, index, count, direction);
    }
    if (type === 'column' && config?.colReadOnly) {
        config.colReadOnly = shiftKeyedMapForInsert(config.colReadOnly, index, count, direction);
    }

    sheet.alternateFormatRules = (sheet.alternateFormatRules ?? []).map((rule) => ({
        ...rule,
        cellrange: shiftRangeForInsert(rule.cellrange, op),
    }));

    const insertAt = direction === 'lefttop' ? index : index + 1;
    const shift = (at: number) => (at >= insertAt ? at + count : at);
    // calcChain entries are sheet-local; cross-sheet formula text is rewritten by the engine.
    sheet.calcChain = (sheet.calcChain ?? []).map((entry) =>
        type === 'row' ? { ...entry, r: shift(entry.r) } : { ...entry, c: shift(entry.c) },
    );
    shiftFilterForInsert(sheet, op);
    shiftFrozenFocus(sheet, type, shift);

    // Inserted rows/columns clone the template's validation rules, not its hyperlinks.
    sheet.dataVerification = shiftCellKeyedForInsert(sheet.dataVerification, type, index, count, direction, cloneDeep);
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
    op: {
        type: 'row' | 'column';
        start: number;
        end: number;
        id: string;
    },
    // A batch through applyOpBatch, such as a peer's op or an undo, applies for a read-only viewer too, and
    // applyOpBatch moves the selection with the cells. The permission guard blocks a viewer's own delete only.
    fromBatch = false,
) {
    if (!fromBatch && ctx.allowEdit === false) return;
    const id = op.id || ctx.currentSheetId;
    const { type, start, end } = op;

    writeBackSheets(ctx, applySheetsDeleteRowCol(ctx.sheets, { ...op, id }));

    const sheetIndex = getSheetIndex(ctx, id);
    if (sheetIndex == null) return;
    const sheet = ctx.sheets[sheetIndex];

    // The engine refuses an op on a read-only row or column but does not move them.
    // They shift here, by the same rule as hidden rows and columns.
    const { config } = sheet;
    if (type === 'row' && config?.rowReadOnly) {
        config.rowReadOnly = shiftKeyedMapForDelete(config.rowReadOnly, start, end);
    }
    if (type === 'column' && config?.colReadOnly) {
        config.colReadOnly = shiftKeyedMapForDelete(config.colReadOnly, start, end);
    }

    const alternateFormats = [];
    for (const rule of sheet.alternateFormatRules ?? []) {
        const cellrange = shiftRangeForDelete(rule.cellrange, op);
        if (cellrange) alternateFormats.push({ ...rule, cellrange });
    }
    sheet.alternateFormatRules = alternateFormats;

    // calcChain entries are sheet-local; entries inside the deleted range drop out.
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
    shiftFilterForDelete(sheet, op);
    shiftFrozenFocus(sheet, type, (focus) => (focus >= start ? focus - (Math.min(end, focus) - start + 1) : focus));

    sheet.dataVerification = shiftCellKeyedForDelete(sheet.dataVerification, type, start, end);
    sheet.hyperlink = shiftCellKeyedForDelete(sheet.hyperlink, type, start, end);
    if (!fromBatch) ctx.selections = undefined;

    ctx.formulaCache.formulaCellInfoMap = null;
}

// Hide selected rows/columns
export function hideSelectedRowCol(ctx: Context, type: 'row' | 'column') {
    if (!ctx.selections || ctx.selections.length > 1) return 'noMulti';
    const sheet = getSheet(ctx);
    const { data } = sheet;
    // A sheet that is not loaded has nothing to hide.
    if (!data) return '';
    const config = (sheet.config ??= {});
    const hidden = type === 'row' ? (config.rowhidden ??= {}) : (config.colhidden ??= {});
    const span = ctx.selections[0][type];
    const [first, last] = span;
    for (let i = first; i <= last; i += 1) hidden[i] = 0;
    const length = type === 'row' ? data.length : data[0].length;
    const step = last === length - 1 || last + 1 in hidden ? -1 : 1;
    span[0] += step;
    span[1] += step;
    return '';
}

// Show (unhide) selected rows/columns
export function showSelectedRowCol(ctx: Context, type: 'row' | 'column') {
    if (!ctx.selections || ctx.selections.length > 1) return 'noMulti';
    // Unhiding cannot create hidden state, so it must not seed the map: on a sheet with
    // nothing hidden that would ship an op to peers and take an undo entry for a no-op.
    const config = getSheetConfig(ctx);
    const hidden = type === 'row' ? config?.rowhidden : config?.colhidden;
    if (hidden) {
        const [first, last] = ctx.selections[0][type];
        for (let i = first; i <= last; i += 1) delete hidden[i];
    }
    return '';
}

// Check if the current selection is on a hidden row/column
export function isSelectionOnHiddenRowCol(ctx: Context): boolean {
    const selection = ctx.selections?.[0];
    if (!selection) return false;
    const config = getSheetConfig(ctx);
    // If the current selection is on a hidden row/column, it is not editable
    return (
        (config?.colhidden != null && selection.column[0] in config.colhidden) ||
        (config?.rowhidden != null && selection.row[0] in config.rowhidden)
    );
}

// Count hidden rows/columns to skip during keyboard navigation
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
    while (at in hidden) {
        count += 1;
        at += step;
    }
    return count;
}

// Per sheet and per field, never `ctx.sheets = ...` or a whole sheet: a wholesale reassignment makes immer emit one
// replace carrying the whole workbook, shipped over collab on every edit (rowcol-patches.test.ts), and a whole sheet's
// undo would put back its images and charts over a peer's later ones. A moved chart gets only the fields that changed,
// its spec parts, a keyed part an entry at a time, so a peer's move or delete of it, or its edit of another entry, at
// once survives, and the undo puts back only the entries the op moved; an image never moves.
function writeBackSheets(ctx: Context, sheets: Sheet[]) {
    for (const [i, next] of sheets.entries()) {
        const sheet: Record<string, unknown> = ctx.sheets[i];
        for (const [key, value] of Object.entries(next)) {
            if (key !== 'charts' && sheet[key] !== value) sheet[key] = value;
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

// Writes `frozen` whole, never into it: a peer's unfreeze removes it, and a write inside it would resolve on nothing.
function shiftFrozenFocus(sheet: Sheet, type: 'row' | 'column', shift: (focus: number) => number) {
    const { frozen } = sheet;
    if (!frozen?.range) return;
    const ranged = type === 'row' ? frozen.type === 'rangeRow' : frozen.type === 'rangeColumn';
    if (!ranged && frozen.type !== 'rangeBoth') return;
    const axis = type === 'row' ? 'row_focus' : 'column_focus';
    const focus = shift(frozen.range[axis]);
    if (focus !== frozen.range[axis]) sheet.frozen = { ...frozen, range: { ...frozen.range, [axis]: focus } };
}
