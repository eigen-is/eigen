// The workbook's sheet list in the editor: adding, renaming, deleting and switching sheets, giving a sheet its cell
// matrix, and the per-sheet view the grid paints. Menus and the sheet tabs call these inside an edit's recipe. An add,
// a delete or a rename applies as its op through applyBatch, as a peer's does. The Workbook runs deriveView on every
// context it commits.

import { sheetDefaultColWidth, sheetDefaultRowHeight } from '@workspace/lib/sheets';
import { produce } from 'immer';
import { celldataToData } from '../../engine/celldata';
import { DEFAULT_SHEET_COLUMN_COUNT, DEFAULT_SHEET_ROW_COUNT, gridSize } from '../../engine/defaults';
import { normalizeSheetConfig } from '../../engine/sheet-config';
import type { RenameSheetOp } from '../../engine/sheet-name';
import { sheetNameRefusal } from '../../engine/sheet-name';
import type { Context } from '../context';
import { firstVisibleSheetId, updateContextWithSheetData } from '../context';
import type { Sheet } from '../types';
import { getSheetIndex, nextSheetName, renameSheetOps, sheetOrder } from '../utils';
import { applyBatch } from './apply-ops';
import { cancelNormalSelected } from './cell';
import { createFilterOptions } from './filter';
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

// Immer gives a changed map a new identity, so a cell edit and a drag frame cost a few comparisons here. A write
// outside sheets stays off the wire and out of the undo entry, which are built from the commit's own patches.
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

// The add switches to the sheet it adds, unless it names the new sheet's id, as a copy does. A name the sheet can't
// take, such as a copy's of a name stored before the rule, refuses the add before it moves an order.
export function addSheet(ctx: Context, newSheetId?: string, sheetName?: string, sheetData?: Sheet) {
    if (ctx.allowEdit === false) return;
    const id = newSheetId ?? sheetData?.id ?? crypto.randomUUID();
    const sheet: Sheet = sheetData ?? {
        name: sheetName || nextSheetName(ctx.sheets),
        order: ctx.sheets.length,
        id,
        row: DEFAULT_SHEET_ROW_COUNT,
        column: DEFAULT_SHEET_COLUMN_COUNT,
        config: {},
    };
    if (sheetName !== undefined) sheet.name = sheetName;
    const refusal = sheetNameRefusal(ctx.sheets, id, sheet.name);
    if (refusal) {
        ctx.warnDialog = refusal;
        return;
    }
    if (sheetData) shiftSheetOrders(ctx.sheets, sheetOrder(sheetData), 1);
    applyBatch(ctx, [{ op: 'addSheet', id, path: [], value: sheet }]);
    if (!newSheetId) changeSheet(ctx, id);
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

export function deleteSheet(ctx: Context, id: string) {
    if (ctx.allowEdit === false) return;
    const index = getSheetIndex(ctx, id);
    if (index == null) return;
    const order = sheetOrder(ctx.sheets[index]);
    applyBatch(ctx, [{ op: 'deleteSheet', id, path: [], value: { id } }]);
    shiftSheetOrders(ctx.sheets, order, -1);
}

// A sheet added at order `at` moves the sheets from there on one place, and one deleted from it the sheets past it, so
// a sheet two tabs left on the same order keeps its place. Only the author's edit moves them: the batch carries them.
export function shiftSheetOrders(sheets: Sheet[], at: number, by: 1 | -1) {
    for (const sheet of sheets) {
        const order = sheetOrder(sheet);
        if (order > at || (order === at && by > 0)) sheet.order = order + by;
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

export function renameSheet(ctx: Context, op: RenameSheetOp) {
    applyBatch(ctx, renameSheetOps(op.id, op.name));
}
