// The workbook's sheet list in the editor: adding, deleting and switching sheets, giving a sheet its cell matrix, and
// the per-sheet view the grid paints. Menus and the sheet tabs call these inside an edit's recipe, and so does a
// peer's batch through applyOpBatch.

import { sheetDefaultColWidth, sheetDefaultRowHeight } from '@workspace/lib/sheets';
import { isNil, times } from 'es-toolkit/compat';
import { v4 as uuidv4 } from 'uuid';
import { MAX_SHEET_NAME_LENGTH } from '../../engine/a1-notation';
import { celldataToData } from '../../engine/celldata';
import { MAX_SHEET_COLUMN_COUNT, MAX_SHEET_ROW_COUNT } from '../../engine/defaults';
import { normalizeSheetConfig } from '../../engine/sheet-config';
import type { CellMatrix } from '../../engine/types';
import type { Context } from '../context';
import { firstVisibleSheetId, updateContextWithSheetData } from '../context';
import type { Settings } from '../settings';
import type { Sheet } from '../types';
import { generateRandomSheetName, getSheetIndex } from '../utils';
import { cancelNormalSelected } from './cell';
import { applySheetFilter } from './filter';

export function storeSheetSelections(ctx: Context) {
    const index = getSheetIndex(ctx, ctx.currentSheetId);
    if (index == null) return;
    const file = ctx.sheets[index];
    file.selections = ctx.selections;
}

export function changeSheet(
    ctx: Context,
    id: string,
    // The current sheet is going away (deleted, hidden, undone): no veto.
    force = false,
) {
    if (id === ctx.currentSheetId) {
        return;
    }

    const idx = getSheetIndex(ctx, id);
    if (idx == null) return;
    const file = ctx.sheets[idx];
    if (file.hide === 1) return;

    if (!force && ctx.hooks.beforeActivateSheet?.(id) === false) {
        return;
    }

    storeSheetSelections(ctx);
    ctx.sheetScrollRecord[ctx.currentSheetId] = {
        scrollLeft: ctx.scrollLeft,
        scrollTop: ctx.scrollTop,
        selectionActive: ctx.selectionActive,
    };

    cancelNormalSelected(ctx);
    ctx.dataVerificationDropDownList = false;
    ctx.activeObject = undefined;
    ctx.currentSheetId = id;
    ctx.currentSheetIsPivot = !!file.isPivotTable;
    const record = ctx.sheetScrollRecord[id];
    ctx.scrollRequest = { left: record?.scrollLeft ?? 0, top: record?.scrollTop ?? 0 };
    ctx.selectionActive = record?.selectionActive ?? false;
    ctx.selections = file.selections;
    ctx.formulaRangeSelections = [];
    applySheetView(ctx);

    if (ctx.hooks.afterActivateSheet) {
        setTimeout(() => {
            ctx.hooks.afterActivateSheet?.(id);
        });
    }
}

// False when no other visible sheet is left to land on.
export function leaveCurrentSheet(ctx: Context, excludeId?: string) {
    const next = firstVisibleSheetId(ctx, excludeId);
    if (next == null) return false;
    changeSheet(ctx, next, true);
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
    settings?: Required<Settings>,
    newSheetID: string | undefined = undefined, // if action is from websocket, there will be a new sheetID
    isPivotTable = false,
    sheetName: string | undefined = undefined,
    sheetData: Sheet | undefined = undefined,
    // Remote mirror (applyOp): a peer's sheet lands for a read-only viewer too.
    force = false,
) {
    if (!force && ctx.allowEdit === false) {
        return;
    }
    const order = ctx.sheets.length;
    const id = newSheetID ?? settings?.generateSheetId() ?? uuidv4();
    const sheetname = sheetName || generateRandomSheetName(ctx.sheets, isPivotTable);
    if (!isNil(sheetData)) delete sheetData.data;
    const sheetconfig: Sheet = isNil(sheetData)
        ? {
              name: sheetName === undefined ? sheetname : sheetName,
              status: 0,
              order,
              id,
              row: ctx.defaultrowNum,
              column: ctx.defaultcolumnNum,
              config: {},
              pivotTable: null,
              isPivotTable: !!isPivotTable,
          }
        : sheetData;
    normalizeSheetConfig(sheetconfig);
    if (sheetName !== undefined) sheetconfig.name = sheetName;
    // A sheet that comes without an id takes the one the add switches to.
    sheetconfig.id ??= id;
    if (ctx.hooks.beforeAddSheet?.(sheetconfig) === false) {
        return;
    }
    // Only an add that goes ahead moves the other sheets along. A sheet without an order sorts as 0, as the tab
    // strip sorts it.
    if (!isNil(sheetData)) {
        const insertAt = sheetData.order ?? 0;
        for (const sheet of ctx.sheets) {
            const order = sheet.order ?? 0;
            sheet.order = order < insertAt ? sheet.order : order + 1;
        }
    }

    ctx.sheets.push(sheetconfig);

    if (!newSheetID) {
        changeSheet(ctx, id);
    }

    if (ctx.hooks.afterAddSheet) {
        setTimeout(() => {
            ctx.hooks.afterAddSheet?.(sheetconfig);
        });
    }
}

// A sheet's cells come stored as a sparse list; the editor works on a full matrix, so a sheet gets one before
// anything reads or writes its cells.
export function initSheetData(draftCtx: Context, index: number, newData: Sheet) {
    const { celldata, row, column } = newData;
    const expandedData = celldataToData(
        celldata ?? [],
        row != null && row > 0 ? row : draftCtx.defaultrowNum,
        column != null && column > 0 ? column : draftCtx.defaultcolumnNum,
    );
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
    // Remote mirror (applyOp): a peer's deletion lands for a read-only viewer too.
    force = false,
) {
    if (!force && ctx.allowEdit === false) {
        return;
    }

    const arrIndex = getSheetIndex(ctx, id);

    if (arrIndex == null) {
        return;
    }

    if (ctx.hooks.beforeDeleteSheet?.(id) === false) {
        return;
    }

    const deletedOrder = ctx.sheets[arrIndex].order ?? 0;
    ctx.sheets = ctx.sheets.map((sheet) => {
        const order = sheet.order ?? 0;
        sheet.order = order < deletedOrder ? sheet.order : order - 1;
        return sheet;
    });

    ctx.sheets.splice(arrIndex, 1);
    if (id === ctx.currentSheetId) leaveCurrentSheet(ctx);

    if (ctx.hooks.afterDeleteSheet) {
        setTimeout(() => {
            ctx.hooks.afterDeleteSheet?.(id);
        });
    }
}

export function editSheetName(ctx: Context, editable: HTMLSpanElement) {
    const index = getSheetIndex(ctx, ctx.currentSheetId);
    if (ctx.allowEdit === false) {
        if (index == null) return;
        editable.innerText = ctx.sheets[index].name;
        return;
    }
    const oldtxt = editable.dataset.oldText || '';
    const txt = editable.innerText;

    if (ctx.hooks.beforeUpdateSheetName?.(ctx.currentSheetId, oldtxt, txt) === false) {
        return;
    }

    if (txt.length === 0) {
        editable.innerText = oldtxt;
        throw new Error('Sheet name cannot be empty');
    }

    if (
        txt.length > MAX_SHEET_NAME_LENGTH ||
        txt.charAt(0) === "'" ||
        txt.charAt(txt.length - 1) === "'" ||
        /[：:\\/？?*[\]]+/.test(txt)
    ) {
        editable.innerText = oldtxt;
        throw new Error('The name cannot contain:[ ] :  ? * / \' "');
    }

    if (index == null) return;

    for (let i = 0; i < ctx.sheets.length; i += 1) {
        if (index !== i && ctx.sheets[i].name === txt) {
            editable.innerText = oldtxt;
            return;
        }
    }

    ctx.sheets[index].name = txt;

    if (ctx.hooks.afterUpdateSheetName) {
        setTimeout(() => {
            ctx.hooks.afterUpdateSheetName?.(ctx.currentSheetId, oldtxt, txt);
        });
    }
}

export function expandRowsAndColumns(data: CellMatrix, rowsToAdd: number, columnsToAdd: number) {
    if (rowsToAdd <= 0 && columnsToAdd <= 0) {
        return data;
    }

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
    if (rowsToAdd <= 0) {
        rowsToAdd = 0;
    }

    if (columnsToAdd <= 0) {
        columnsToAdd = 0;
    }

    let currentColLen = 0;
    if (data.length > 0) {
        currentColLen = data[0].length;
    }

    for (let r = 0; r < data.length; r += 1) {
        for (let i = 0; i < columnsToAdd; i += 1) {
            data[r].push(null);
        }
    }

    for (let r = 0; r < rowsToAdd; r += 1) {
        data.push(times(currentColLen + columnsToAdd, () => null));
    }

    return data;
}
