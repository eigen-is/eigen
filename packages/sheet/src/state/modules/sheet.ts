import { cloneDeep, isNil, sortBy, times } from 'es-toolkit/compat';
import { v4 as uuidv4 } from 'uuid';
import type { CellMatrix } from '../../engine/types';
import { initSheetData } from '../api/sheet';
import type { Context } from '../context';
import { en } from '../locale/en';
import type { Settings } from '../settings';
import type { Sheet } from '../types';
import { generateRandomSheetName, getSheetIndex } from '../utils';
import { setFormulaCellInfo } from './formula-cache';

export function storeSheetSelections(ctx: Context) {
    const index = getSheetIndex(ctx, ctx.currentSheetId);
    if (index == null) return;
    const file = ctx.sheets[index];
    file.selections = ctx.selections;
    file.formulaRangeSelections = ctx.formulaRangeSelections;
}

export function changeSheet(ctx: Context, id: string) {
    if (id === ctx.currentSheetId) {
        return;
    }

    const idx = getSheetIndex(ctx, id);
    if (idx == null) return;
    const file = ctx.sheets[idx];

    if (ctx.hooks.beforeActivateSheet?.(id) === false) {
        return;
    }

    storeSheetSelections(ctx);

    ctx.currentSheetId = id;
    ctx.currentSheetIsPivot = !!file.isPivotTable;

    if (ctx.hooks.afterActivateSheet) {
        setTimeout(() => {
            ctx.hooks.afterActivateSheet?.(id);
        });
    }
}

export function addSheet(
    ctx: Context,
    settings?: Required<Settings>,
    newSheetID: string | undefined = undefined, // if action is from websocket, there will be a new sheetID
    isPivotTable = false,
    sheetName: string | undefined = undefined,
    sheetData: Sheet | undefined = undefined,
) {
    if (ctx.allowEdit === false) {
        return;
    }
    const order = ctx.sheets.length;
    const id = newSheetID ?? (settings?.generateSheetId() as string);
    const sheetname = sheetName || generateRandomSheetName(ctx.sheets, isPivotTable);
    if (!isNil(sheetData)) {
        delete sheetData.data;
        for (const sheet of ctx.sheets) {
            sheet.order = (sheet.order as number) < sheetData.order! ? sheet.order : (sheet.order as number) + 1;
        }
    }
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
    if (sheetName !== undefined) sheetconfig.name = sheetName;
    if (sheetconfig.id === undefined) sheetconfig.id = uuidv4();
    if (ctx.hooks.beforeAddSheet?.(sheetconfig) === false) {
        return;
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

export function deleteSheet(ctx: Context, id: string) {
    if (ctx.allowEdit === false) {
        return;
    }

    const arrIndex = getSheetIndex(ctx, id);

    if (arrIndex == null) {
        return;
    }

    if (ctx.hooks.beforeDeleteSheet?.(id) === false) {
        return;
    }

    ctx.sheets = ctx.sheets.map((sheet) => {
        sheet.order =
            (sheet.order as number) < (ctx.sheets[arrIndex].order as number)
                ? sheet.order
                : (sheet.order as number) - 1;
        return sheet;
    });

    ctx.sheets.splice(arrIndex, 1);
    if (id === ctx.currentSheetId) {
        const shownSheets = cloneDeep(ctx.sheets).filter(
            (singleSheet) => singleSheet.hide === undefined || singleSheet.hide !== 1,
        );
        const orderSheets = sortBy(shownSheets, (sheet) => sheet.order);
        ctx.currentSheetId = orderSheets?.[0]?.id as string;
    }

    if (ctx.hooks.afterDeleteSheet) {
        setTimeout(() => {
            ctx.hooks.afterDeleteSheet?.(id);
        });
    }
}

export function updateSheet(ctx: Context, newData: Sheet[]) {
    for (const newDatum of newData) {
        const { data, row, column } = newDatum;
        const index = getSheetIndex(ctx, newDatum.id!) as number;
        if (data != null) {
            // If row and column exist, compare row and column with data. If row and column do not exist, compare data with default.
            let lastRowNum = data.length;
            let lastColNum = data[0].length;
            if (row != null && column != null && row > 0 && column > 0) {
                lastRowNum = Math.max(lastRowNum, row);
                lastColNum = Math.max(lastColNum, column);
            } else {
                lastRowNum = Math.max(lastRowNum, ctx.defaultrowNum);
                lastColNum = Math.max(lastColNum, ctx.defaultcolumnNum);
            }
            const expandedData: Sheet['data'] = times(lastRowNum, () => times(lastColNum, () => null));
            for (let i = 0; i < data.length; i += 1) {
                for (let j = 0; j < data[i].length; j += 1) {
                    expandedData[i][j] = data[i][j];
                    setFormulaCellInfo(ctx, { r: i, c: j, id: newDatum.id! }, data, newDatum.id);
                }
            }
            newDatum.data = expandedData;
            if (ctx.sheets[index] == null) {
                ctx.sheets.push(newDatum);
            } else {
                ctx.sheets[index] = newDatum;
            }
        } else if (newDatum.celldata != null) {
            initSheetData(ctx, index, newDatum);
            const _index = getSheetIndex(ctx, newDatum.id!) as number;
            for (const d of newDatum.celldata) {
                setFormulaCellInfo(ctx, { r: d.r, c: d.c, id: newDatum.id! }, ctx.sheets[_index].data, newDatum.id);
            }
        }
    }
}

export function editSheetName(ctx: Context, editable: HTMLSpanElement) {
    const index = getSheetIndex(ctx, ctx.currentSheetId);
    if (ctx.allowEdit === false) {
        if (index == null) return;
        editable.innerText = ctx.sheets[index].name;
        return;
    }
    const { sheetconfig } = en;
    const oldtxt = editable.dataset.oldText || '';
    const txt = editable.innerText;

    if (ctx.hooks.beforeUpdateSheetName?.(ctx.currentSheetId, oldtxt, txt) === false) {
        return;
    }

    if (txt.length === 0) {
        editable.innerText = oldtxt;
        throw new Error(sheetconfig.sheetNamecannotIsEmptyError);
    }

    if (
        txt.length > 31 ||
        txt.charAt(0) === "'" ||
        txt.charAt(txt.length - 1) === "'" ||
        /[：:\\/？?*[\]]+/.test(txt)
    ) {
        editable.innerText = oldtxt;
        throw new Error(sheetconfig.sheetNameSpecCharError);
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

    if (data.length + rowsToAdd >= 10000) {
        throw new Error('This action would increase the number of rows in the workbook above the limit of 10000.');
    }

    if (data[0].length + columnsToAdd >= 1000) {
        throw new Error('This action would increase the number of columns in the workbook above the limit of 1000.');
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
