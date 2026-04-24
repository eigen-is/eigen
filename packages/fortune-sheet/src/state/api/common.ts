import {cloneDeep, maxBy, times} from "es-toolkit/compat";
import {Context} from "../context";
import type {CellMatrix} from "../../engine/types";
import {CellWithRowAndCol, Sheet} from "../types";
import {getSheetIndex} from "../utils";
import {sheetNotFound} from "./errors";

export type CommonOptions = { index?: number; id?: string };

export const dataToCelldata = (data: CellMatrix | undefined) => {
    const celldata: CellWithRowAndCol[] = [];
    if (data == null) {
        return celldata;
    }
    for (let r = 0; r < data.length; r += 1) {
        for (let c = 0; c < data[r].length; c += 1) {
            const v = data[r][c];
            if (v != null) {
                celldata.push({r, c, v});
            }
        }
    }
    return celldata;
};

export const celldataToData = (
    celldata: CellWithRowAndCol[],
    rowCount?: number,
    colCount?: number
) => {
    const lastRow = maxBy<CellWithRowAndCol>(celldata, "r");
    const lastCol = maxBy(celldata, "c");
    let lastRowNum = (lastRow?.r ?? 0) + 1;
    let lastColNum = (lastCol?.c ?? 0) + 1;
    if (rowCount != null && colCount != null && rowCount > 0 && colCount > 0) {
        lastRowNum = Math.max(lastRowNum, rowCount);
        lastColNum = Math.max(lastColNum, colCount);
    }
    if (lastRowNum && lastColNum) {
        const expandedData: Sheet["data"] = times(lastRowNum, () =>
            times(lastColNum, () => null)
        );
        celldata?.forEach((d) => {
            expandedData[d.r][d.c] = d.v;
        });
        return expandedData;
    }
    return null;
};

export function getSheet(ctx: Context, options: CommonOptions = {}) {
    const {index = getSheetIndex(ctx, options.id || ctx.currentSheetId)} =
        options;

    if (index == null) {
        throw sheetNotFound();
    }

    const sheet = ctx.luckysheetfile[index];

    if (sheet == null) {
        throw sheetNotFound();
    }

    return sheet;
}

export function getSheetWithLatestCelldata(
    ctx: Context,
    options: CommonOptions = {}
) {
    const sheet = getSheet(ctx, options);
    return {...cloneDeep(sheet), celldata: dataToCelldata(sheet.data)};
}
