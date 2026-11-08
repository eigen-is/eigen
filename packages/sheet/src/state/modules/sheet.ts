// The workbook's sheet list in the editor: adding, renaming, deleting and switching sheets, giving a sheet its cell
// matrix, and the per-sheet view the grid paints. Menus and the sheet tabs call these inside an edit's recipe, and so
// does a peer's batch through applyOpBatch.

import { sheetDefaultColWidth, sheetDefaultRowHeight } from '@workspace/lib/sheets';
import { isNil, times } from 'es-toolkit/compat';
import {
    MAX_SHEET_NAME_LENGTH,
    SHEET_NAME_END_QUOTES,
    SHEET_NAME_FORBIDDEN,
    SHEET_NAME_RULE,
} from '../../engine/a1-notation';
import { celldataToData } from '../../engine/celldata';
import {
    DEFAULT_SHEET_COLUMN_COUNT,
    DEFAULT_SHEET_ROW_COUNT,
    gridSize,
    MAX_SHEET_COLUMN_COUNT,
    MAX_SHEET_ROW_COUNT,
} from '../../engine/defaults';
import { normalizeSheetConfig } from '../../engine/sheet-config';
import type { RenameSheetOp } from '../../engine/sheet-name';
import { applySheetRename, sheetNameTaken } from '../../engine/sheet-name';
import { getSheet } from '../api/common';
import type { Context } from '../context';
import { firstVisibleSheetId, updateContextWithSheetData } from '../context';
import type { Sheet } from '../types';
import { getSheetIndex, nextSheetName, sheetOrder } from '../utils';
import { cancelNormalSelected } from './cell';
import { applySheetFilter } from './filter';
import { snapshotContext } from './formula-cache';
import { writeBackSheets } from './rowcol';

export function storeSheetSelections(ctx: Context) {
    const index = getSheetIndex(ctx, ctx.currentSheetId);
    if (index == null) return;
    const file = ctx.sheets[index];
    file.selections = ctx.selections;
}

export function changeSheet(ctx: Context, id: string) {
    if (id === ctx.currentSheetId) return;

    const idx = getSheetIndex(ctx, id);
    if (idx == null) return;
    const file = ctx.sheets[idx];
    if (file.hide === 1) return;

    storeSheetSelections(ctx);
    ctx.sheetScrollRecord[ctx.currentSheetId] = {
        scrollLeft: ctx.scrollLeft,
        scrollTop: ctx.scrollTop,
        selectionActive: ctx.selectionActive,
    };

    cancelNormalSelected(ctx);
    ctx.validationListOpen = false;
    ctx.activeObject = undefined;
    ctx.currentSheetId = id;
    const record = ctx.sheetScrollRecord[id];
    ctx.scrollRequest = { left: record?.scrollLeft ?? 0, top: record?.scrollTop ?? 0 };
    ctx.selectionActive = record?.selectionActive ?? false;
    ctx.selections = file.selections;
    ctx.formulaRangeSelections = [];
    applySheetView(ctx);
}

// False when no other visible sheet is left to land on.
export function leaveCurrentSheet(ctx: Context, excludeId?: string) {
    const next = firstVisibleSheetId(ctx, excludeId);
    if (next == null) return false;
    changeSheet(ctx, next);
    return true;
}

// Undo and redo can remove or hide the sheet on screen.
export function settleCurrentSheet(ctx: Context) {
    const index = getSheetIndex(ctx, ctx.currentSheetId);
    if (index == null || ctx.sheets[index].hide === 1) leaveCurrentSheet(ctx);
}

// Everything the grid paints per sheet, derived in the recipe that makes the sheet current: the
// first frame after a switch must not draw the new cells on the previous sheet's geometry.
export function applySheetView(ctx: Context) {
    const index = getSheetIndex(ctx, ctx.currentSheetId);
    if (index == null) return;
    const sheet = ctx.sheets[index];
    ctx.defaultrowlen = sheetDefaultRowHeight(sheet);
    ctx.defaultcollen = sheetDefaultColWidth(sheet);
    ctx.showGridLines = sheet.showGridLines !== 0 && sheet.showGridLines !== false;
    // A sheet added this recipe has no data until the Workbook effect initializes it.
    if (sheet.data) updateContextWithSheetData(ctx, sheet.data);
    applySheetFilter(ctx);
}

export function addSheet(
    ctx: Context,
    // A copy or a peer's add names the new sheet's id, and the add then stays on the current sheet.
    newSheetID?: string,
    sheetName?: string,
    sheetData?: Sheet,
    // A batch through applyOpBatch, such as a peer's add, lands for a read-only viewer too, and leaves the other
    // sheets' orders to the order ops its batch carries.
    fromBatch = false,
) {
    if (!fromBatch && ctx.allowEdit === false) return;
    const order = ctx.sheets.length;
    // The add switches to the sheet it adds, so a sheet that comes with an id keeps it.
    const id = newSheetID ?? sheetData?.id ?? crypto.randomUUID();
    if (!isNil(sheetData)) delete sheetData.data;
    const sheetconfig: Sheet = isNil(sheetData)
        ? {
              name: sheetName || nextSheetName(ctx.sheets),
              status: 0,
              order,
              id,
              row: DEFAULT_SHEET_ROW_COUNT,
              column: DEFAULT_SHEET_COLUMN_COUNT,
              config: {},
          }
        : sheetData;
    normalizeSheetConfig(sheetconfig);
    if (sheetName !== undefined) sheetconfig.name = sheetName;
    if (!isNil(sheetData) && !fromBatch) shiftSheetOrders(ctx.sheets, sheetOrder(sheetData), 1);

    ctx.sheets.push(sheetconfig);

    if (!newSheetID) {
        changeSheet(ctx, id);
    }
}

// A sheet's cells come stored as a sparse list; the editor works on a full matrix, so a sheet gets one before
// anything reads or writes its cells.
export function initSheetData(draftCtx: Context, index: number, newData: Sheet) {
    const { row, column } = gridSize(newData);
    const expandedData = celldataToData(newData.celldata ?? [], row, column);
    if (draftCtx.sheets[index] == null) {
        newData.data = expandedData;
        delete newData.celldata;
        draftCtx.sheets.push(newData);
    } else {
        draftCtx.sheets[index].data = expandedData;
        delete draftCtx.sheets[index].celldata;
        if (newData.config) {
            draftCtx.sheets[index].config = newData.config;
        }
    }
    normalizeSheetConfig(draftCtx.sheets[index]);
}

export function deleteSheet(
    ctx: Context,
    id: string,
    // A batch through applyOpBatch, such as a peer's delete, lands for a read-only viewer too. It leaves the other
    // sheets' orders to the order ops its batch carries, and the current sheet to applyOpBatch.
    fromBatch = false,
) {
    if (!fromBatch && ctx.allowEdit === false) return;

    const arrIndex = getSheetIndex(ctx, id);

    if (arrIndex == null) return;

    const [deleted] = ctx.sheets.splice(arrIndex, 1);
    // The formula map and its resolved references still read the deleted sheet under its name, which a sheet added
    // later may take.
    ctx.formulaCache.formulaCellInfoMap = null;
    if (fromBatch) return;
    shiftSheetOrders(ctx.sheets, sheetOrder(deleted), -1);
    if (id === ctx.currentSheetId) leaveCurrentSheet(ctx);
}

// A sheet added at order `at`, or deleted from it, moves the sheets from there on one place. Only the author's edit
// does this. Its batch carries the orders it left, which a peer and the replay apply as they are, so a peer's batch
// must not move them again: two batches sent at once would each move them.
export function shiftSheetOrders(sheets: Sheet[], at: number, by: 1 | -1) {
    for (const sheet of sheets) {
        const order = sheetOrder(sheet);
        if (order >= at) sheet.order = order + by;
    }
}

// Renames the current sheet to the text its tab holds. A name it refuses puts the old text back in the tab and throws
// the reason, which the tab shows in a notice.
export function editSheetName(ctx: Context, editable: HTMLSpanElement) {
    const index = getSheetIndex(ctx, ctx.currentSheetId);
    if (ctx.allowEdit === false) {
        if (index == null) return;
        editable.innerText = ctx.sheets[index].name;
        return;
    }
    const oldtxt = editable.dataset.oldText || '';
    const txt = editable.innerText;

    if (txt.length === 0) {
        editable.innerText = oldtxt;
        throw new Error('Sheet name cannot be empty');
    }

    // `search` ignores the global pattern's lastIndex, which `test` would carry from one call into the next.
    if (
        txt.length > MAX_SHEET_NAME_LENGTH ||
        txt.search(SHEET_NAME_END_QUOTES) !== -1 ||
        txt.search(SHEET_NAME_FORBIDDEN) !== -1
    ) {
        editable.innerText = oldtxt;
        throw new Error(SHEET_NAME_RULE);
    }

    if (index == null || ctx.sheets[index].name === txt) return;

    const { id } = ctx.sheets[index];
    if (sheetNameTaken(ctx.sheets, id, txt)) {
        editable.innerText = oldtxt;
        throw new Error('Another sheet already has this name');
    }

    renameSheet(ctx, { id, name: txt });
}

// The walk reads a plain snapshot, since reading each formula through a draft is slow. A name that read no sheet may
// read this one now, so the formula map is built again.
export function renameSheet(ctx: Context, op: RenameSheetOp) {
    writeBackSheets(ctx, applySheetRename(snapshotContext(ctx).sheets, op));
    ctx.formulaCache.formulaCellInfoMap = null;
}

// Grows the current grid for a paste that runs past its last row or column. The sheet's size grows with it, because a
// stored snapshot keeps the size and a reader builds the grid at that size.
export function expandRowsAndColumns(ctx: Context, rowsToAdd: number, columnsToAdd: number) {
    const sheet = getSheet(ctx);
    const { data } = sheet;
    if (!data || (rowsToAdd <= 0 && columnsToAdd <= 0)) return;

    if (data.length + rowsToAdd > MAX_SHEET_ROW_COUNT) {
        throw new Error(
            `This action would increase the number of rows in the workbook above the limit of ${MAX_SHEET_ROW_COUNT}.`,
        );
    }

    if (data[0].length + columnsToAdd > MAX_SHEET_COLUMN_COUNT) {
        throw new Error(
            `This action would increase the number of columns in the workbook above the limit of ${MAX_SHEET_COLUMN_COUNT}.`,
        );
    }

    for (const row of data) row.push(...times(Math.max(columnsToAdd, 0), () => null));
    const columns = data[0].length;
    for (let r = 0; r < rowsToAdd; r += 1) data.push(times(columns, () => null));
    sheet.row = data.length;
    sheet.column = columns;
    // A whole column or row in the formula map still ends where the grid ended, as after a row insert.
    ctx.formulaCache.formulaCellInfoMap = null;
}
