// The workbook's sheet list in the editor: adding, renaming, deleting and switching sheets, giving a sheet its cell
// matrix, and the per-sheet view the grid paints. Menus and the sheet tabs call these inside an edit's recipe, and so
// does a peer's batch through applyOpBatch.

import { sheetDefaultColWidth, sheetDefaultRowHeight } from '@workspace/lib/sheets';
import { isSheetName, SHEET_NAME_RULE } from '../../engine/a1-notation';
import { celldataToData } from '../../engine/celldata';
import { DEFAULT_SHEET_COLUMN_COUNT, DEFAULT_SHEET_ROW_COUNT, gridSize } from '../../engine/defaults';
import { normalizeSheetConfig } from '../../engine/sheet-config';
import type { RenameSheetOp } from '../../engine/sheet-name';
import { applySheetRename, sheetNameTaken } from '../../engine/sheet-name';
import type { Context } from '../context';
import { firstVisibleSheetId, updateContextWithSheetData } from '../context';
import type { Sheet } from '../types';
import { getSheetIndex, nextSheetName, sheetOrder } from '../utils';
import { cancelNormalSelected } from './cell';
import { createFilterOptions } from './filter';
import { snapshotContext } from './formula-cache';
import { writeBackSheets } from './rowcol';
import { normalizeSelection } from './selection';

export function changeSheet(ctx: Context, id: string) {
    if (id === ctx.currentSheetId) return;

    const index = getSheetIndex(ctx, id);
    if (index == null) return;
    const sheet = ctx.sheets[index];
    if (sheet.hide === 1) return;

    ctx.sheetViewRecord[ctx.currentSheetId] = {
        scrollLeft: ctx.scrollLeft,
        scrollTop: ctx.scrollTop,
        selectionActive: ctx.selectionActive,
        selections: ctx.selections,
    };

    cancelNormalSelected(ctx);
    ctx.validationListOpen = false;
    ctx.activeObject = undefined;
    ctx.currentSheetId = id;
    const record = ctx.sheetViewRecord[id];
    ctx.scrollRequest = { left: record?.scrollLeft ?? 0, top: record?.scrollTop ?? 0 };
    ctx.selectionActive = record?.selectionActive ?? false;
    ctx.selections = record?.selections;
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
// first frame after a switch must not draw the new cells on the previous sheet's geometry. A sheet nobody
// selected in yet, at a mount, a first visit or a copy, opens on A1, since a key does nothing without a cursor.
export function applySheetView(ctx: Context) {
    const index = getSheetIndex(ctx, ctx.currentSheetId);
    if (index == null) return;
    const sheet = ctx.sheets[index];
    ctx.defaultrowlen = sheetDefaultRowHeight(sheet);
    ctx.defaultcollen = sheetDefaultColWidth(sheet);
    ctx.showGridLines = sheet.showGridLines !== 0 && sheet.showGridLines !== false;
    if (sheet.data) updateContextWithSheetData(ctx, sheet.data);
    createFilterOptions(ctx);
    if (!ctx.selections?.length) ctx.selections = normalizeSelection(ctx, [{ row: [0, 0], column: [0, 0] }]);
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
    // The add switches to the sheet it adds, so a sheet that comes with an id keeps it.
    const id = newSheetID ?? sheetData?.id ?? crypto.randomUUID();
    const sheet: Sheet = sheetData ?? {
        name: sheetName || nextSheetName(ctx.sheets),
        order: ctx.sheets.length,
        id,
        row: DEFAULT_SHEET_ROW_COUNT,
        column: DEFAULT_SHEET_COLUMN_COUNT,
        config: {},
    };
    if (sheetName !== undefined) sheet.name = sheetName;
    if (sheetData && !fromBatch) shiftSheetOrders(ctx.sheets, sheetOrder(sheetData), 1);
    initSheetData(sheet);
    ctx.sheets.push(sheet);
    if (!newSheetID) changeSheet(ctx, id);
}

// A sheet's cells come stored as a sparse list and the editor works on a full matrix. So a sheet gets its matrix where
// it enters the editor, at the mount or an add, and every sheet the editor holds has one. A sheet the replay gave a
// matrix keeps it.
export function initSheetData(sheet: Sheet) {
    if (!sheet.data) {
        const { row, column } = gridSize(sheet);
        sheet.data = celldataToData(sheet.celldata ?? [], row, column);
    }
    delete sheet.celldata;
    normalizeSheetConfig(sheet);
}

export function deleteSheet(
    ctx: Context,
    id: string,
    // A batch through applyOpBatch, such as a peer's delete, lands for a read-only viewer too. It leaves the other
    // sheets' orders to the order ops its batch carries, and the current sheet to applyOpBatch.
    fromBatch = false,
) {
    if (!fromBatch && ctx.allowEdit === false) return;

    const index = getSheetIndex(ctx, id);
    if (index == null) return;

    const [deleted] = ctx.sheets.splice(index, 1);
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

// Renames a sheet to the text its tab holds. A name it refuses puts the old text back in the tab and throws the reason,
// which the tab shows in a notice.
export function editSheetName(ctx: Context, id: string, editable: HTMLSpanElement) {
    const index = getSheetIndex(ctx, id);
    if (index == null) return;
    const { name } = ctx.sheets[index];
    const text = editable.innerText;
    if (ctx.allowEdit === false || text === name) {
        editable.innerText = name;
        return;
    }
    let refusal: string | undefined;
    if (text.length === 0) refusal = 'Sheet name cannot be empty';
    else if (!isSheetName(text)) refusal = SHEET_NAME_RULE;
    else if (sheetNameTaken(ctx.sheets, id, text)) refusal = 'Another sheet already has this name';
    if (refusal) {
        editable.innerText = name;
        throw new Error(refusal);
    }
    renameSheet(ctx, { id, name: text });
}

// The walk reads a plain snapshot, since reading each formula through a draft is slow. A name that read no sheet may
// read this one now, so the formula map is built again.
export function renameSheet(ctx: Context, op: RenameSheetOp) {
    writeBackSheets(ctx, applySheetRename(snapshotContext(ctx).sheets, op));
    ctx.formulaCache.formulaCellInfoMap = null;
}
