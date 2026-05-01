import {cloneDeep} from "es-toolkit/compat";
import {celldataToData, dataToCelldata} from "../../engine/celldata";
import {Context} from "../context";
import {getSheetIndex} from "../utils";
import {sheetNotFound} from "./errors";

// Re-exported from the engine so a single canonical implementation serves
// both fortune-sheet's runtime and replaySheetsOps' BE materialization step.
export {celldataToData, dataToCelldata};

export type CommonOptions = { index?: number; id?: string };

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
