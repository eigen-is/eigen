// The workbook's sheet list in the editor: adding, renaming, deleting and switching sheets, giving a sheet its cell
// matrix, and the per-sheet view the grid paints. Menus and the sheet tabs call these inside an edit's recipe, and so
// does a peer's batch through applyOpBatch. The Workbook runs deriveView on every context it commits.

import { sheetDefaultColWidth, sheetDefaultRowHeight } from '@workspace/lib/sheets';
import { produce } from 'immer';
import { celldataToData } from '../../engine/celldata';
import { DEFAULT_SHEET_COLUMN_COUNT, DEFAULT_SHEET_ROW_COUNT, gridSize } from '../../engine/defaults';
import { normalizeSheetConfig } from '../../engine/sheet-config';
import type { RenameSheetOp } from '../../engine/sheet-name';
import { applySheetDelete, applySheetRename, sheetNameRefusal } from '../../engine/sheet-name';
import type { Context } from '../context';
import { firstVisibleSheetId, updateContextWithSheetData } from '../context';
import type { Sheet } from '../types';
import { addSheetOps, deleteSheetOps, getSheetIndex, nextSheetName, renameSheetOps, sheetOrder } from '../utils';
import { cancelNormalSelected } from './cell';
import { createFilterOptions } from './filter';
import { snapshotContext } from './formula-cache';
import { recomputeAfterOps } from './formula-exec';
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

// The per-sheet paint data is derived in the recipe that makes the sheet current, so no frame mixes sheets and the
// recipe can read the new geometry, as a jump to a cell on that sheet does. A sheet nobody selected in opens on A1: a
// key needs a cursor.
export function applySheetView(ctx: Context) {
    const index = getSheetIndex(ctx, ctx.currentSheetId);
    if (index == null) return;
    const sheet = ctx.sheets[index];
    ctx.defaultrowlen = sheetDefaultRowHeight(sheet);
    ctx.defaultcollen = sheetDefaultColWidth(sheet);
    ctx.showGridLines = sheet.showGridLines !== 0 && sheet.showGridLines !== false;
    deriveGeometry(ctx, sheet);
    if (!ctx.selections?.length) ctx.selections = normalizeSelection(ctx, [{ row: [0, 0], column: [0, 0] }]);
}

// What the geometry, the selection's box and the filter's rects are worked out from, besides the grid's size. The first
// row counts too: a column's width depends on whether its first cell is set, and its length is the column count.
const GEOMETRY_MAPS = ['rowlen', 'columnlen', 'rowhidden', 'colhidden', 'merge'] as const;

// Immer gives a changed map a new identity, so a cell edit and a drag frame cost a few comparisons here. A write outside
// sheets stays off the wire and out of the undo entry, which are built from the commit's own patches.
export function deriveView(base: Context, next: Context): Context {
    if (next.currentSheetId !== base.currentSheetId) return next;
    const before = base.sheets.find(({ id }) => id === base.currentSheetId);
    const after = next.sheets.find(({ id }) => id === next.currentSheetId);
    if (!after || (before === after && base.allowEdit === next.allowEdit)) return next;
    const changed =
        base.allowEdit !== next.allowEdit ||
        before?.data?.length !== after.data?.length ||
        before?.data?.[0] !== after.data?.[0] ||
        before?.filterRange !== after.filterRange ||
        GEOMETRY_MAPS.some((map) => before?.config?.[map] !== after.config?.[map]);
    return changed ? produce(next, (draft: Context) => deriveGeometry(draft, after)) : next;
}

function deriveGeometry(ctx: Context, { data }: Sheet) {
    if (data) updateContextWithSheetData(ctx, data);
    createFilterOptions(ctx);
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
    // A name that read no sheet may read this one now, and the map holds none of its formulas.
    ctx.formulaCache.formulaCellInfoMap = null;
    if (!newSheetID) changeSheet(ctx, id);
    if (!fromBatch) recomputeAfterOps(ctx, addSheetOps(sheet, ctx.sheets));
}

// A sheet's cells are stored as a sparse list but the editor works on a full matrix, so a sheet gets its matrix
// where it enters the editor. A sheet the replay gave a matrix keeps it.
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

    const rewritten = applySheetDelete(ctx.sheets, id);
    const [deleted] = ctx.sheets.splice(index, 1);
    writeBackSheets(ctx, rewritten);
    // The formula map and its resolved references still read the deleted sheet under its name, which a sheet added
    // later may take.
    ctx.formulaCache.formulaCellInfoMap = null;
    if (fromBatch) return;
    shiftSheetOrders(ctx.sheets, sheetOrder(deleted), -1);
    if (id === ctx.currentSheetId) leaveCurrentSheet(ctx);
    recomputeAfterOps(ctx, deleteSheetOps(deleted, ctx.sheets));
}

// A sheet added at order `at`, or deleted from it, moves the sheets from there on one place. Only the author's edit
// does this, since the batch carries the orders and moving them again for two batches sent at once would double it.
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
    const refusal = sheetNameRefusal(ctx.sheets, id, text);
    if (refusal) {
        editable.innerText = name;
        throw new Error(refusal);
    }
    renameSheet(ctx, { id, name: text });
}

// The walk reads a plain snapshot, since reading each formula through a draft is slow. A name that read no sheet may
// read this one now, so the formula map is built again.
export function renameSheet(ctx: Context, op: RenameSheetOp, fromBatch = false) {
    writeBackSheets(ctx, applySheetRename(snapshotContext(ctx).sheets, op));
    ctx.formulaCache.formulaCellInfoMap = null;
    if (!fromBatch) recomputeAfterOps(ctx, renameSheetOps(op.id, op.name));
}
