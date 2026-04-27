import {forEach, isNil, isNumber, isPlainObject} from "es-toolkit/compat";
import {Context} from "../context";
import {
    delFunctionGroup,
    dropCellCache,
    functionHTMLGenerate,
    getTypeItemHide,
    setCellValue as setCellValueInternal,
    updateCell,
    updateDropCell,
    updateFormatCell,
} from "../modules";
import type {Cell, CellStyle} from "../../engine/types";
import {SingleRange} from "../types";
import {CommonOptions, getSheet} from "./common";
import {sheetNotFound} from "./errors";
import {format} from "numfmt";

// Cell keys handled by `updateFormatCell` (range-aware style writes) rather than
// by direct assignment in setCellValue. Order is documentation-only — the lookup
// is by `.has()`. Comments on the cell shape live on the Cell/CellStyle types.
const FORMAT_KEYS: ReadonlySet<string> = new Set([
    'bg', 'ff', 'fc', 'bl', 'it', 'fs',
    'cl', 'un', 'vt', 'ht', 'mc', 'tb', 'rt', 'qp',
]);

export function getCellValue(
    ctx: Context,
    row: number,
    column: number,
    options: CommonOptions & { type?: keyof Cell } = {}
) {
    if (!isNumber(row) || !isNumber(column)) {
        throw new Error("row or column cannot be null or undefined");
    }
    const sheet = getSheet(ctx, options);
    const {type = "v"} = options;
    const targetSheetData = sheet.data;
    if (!targetSheetData) {
        throw sheetNotFound();
    }
    const cellData = targetSheetData[row][column];
    let ret;

    if (cellData && isPlainObject(cellData)) {
        if (type === "f") {
            ret = cellData.f != null ? functionHTMLGenerate(cellData.f) : cellData.v;
        } else if (cellData.ct && cellData.ct.fa === "yyyy-MM-dd") {
            ret = cellData.m;
        } else if (cellData.ct?.t === "inlineStr") {
            ret = (cellData.ct.s ?? []).reduce((prev, cur) => prev + (cur.v ?? ""), "");
        } else {
            ret = cellData[type];
        }
    }

    if (ret === undefined) {
        ret = null;
    }

    return ret;
}

export function setCellValue(
    ctx: Context,
    row: number,
    column: number,
    value: any,
    cellInput: HTMLDivElement | null,
    options: CommonOptions = {}
) {
    if (!isNumber(row) || !isNumber(column)) {
        throw new Error("row or column cannot be null or undefined");
    }

    const sheet = getSheet(ctx, options);

    const {data} = sheet;

    if (value == null || value.toString().length === 0) {
        delFunctionGroup(ctx, row, column, sheet.id);
        setCellValueInternal(ctx, row, column, data, value);
    } else if (value instanceof Object) {
        const curv: Cell = {};
        if (data?.[row]?.[column] == null) {
            data![row][column] = {};
        }
        const cell = data![row][column]!;
        if (value.f != null && value.v == null) {
            curv.f = value.f;
            if (value.ct != null) {
                curv.ct = value.ct;
            }
            updateCell(ctx, row, column, cellInput, curv); // update formula value
        } else {
            if (value.ct != null) {
                curv.ct = value.ct;
            }
            if (value.f != null) {
                curv.f = value.f;
            }
            if (value.v != null) {
                curv.v = value.v;
            } else {
                curv.v = cell.v;
            }
            if (value.m != null) {
                curv.m = value.m;
            }
            delFunctionGroup(ctx, row, column, sheet.id);
            setCellValueInternal(ctx, row, column, data, curv); // update text value
        }
        forEach(value, (v, attr) => {
            if (FORMAT_KEYS.has(attr)) {
                updateFormatCell(
                    ctx,
                    data!,
                    attr as keyof CellStyle,
                    v,
                    row,
                    row,
                    column,
                    column
                ); // change range format
            } else {
                // @ts-ignore
                cell[attr] = v;
            }
        });
        data![row][column] = cell;
    } else {
        if (
            value.toString().substr(0, 1) === "=" ||
            value.toString().substr(0, 5) === "<span"
        ) {
            updateCell(ctx, row, column, cellInput, value); // update formula value or convert inline string html to object
        } else {
            delFunctionGroup(ctx, row, column, sheet.id);
            setCellValueInternal(ctx, row, column, data, value);
        }
    }
}

export function clearCell(
    ctx: Context,
    row: number,
    column: number,
    options: CommonOptions = {}
) {
    if (!isNumber(row) || !isNumber(column)) {
        throw new Error("row or column cannot be null or undefined");
    }

    const sheet = getSheet(ctx, options);

    const cell = sheet.data?.[row]?.[column];

    if (cell && isPlainObject(cell)) {
        delete cell.m;
        delete cell.v;

        if (cell.f != null) {
            delete cell.f;
            delFunctionGroup(ctx, row, column, sheet.id);
        }
    }
}

export function setCellFormat(
    ctx: Context,
    row: number,
    column: number,
    attr: keyof Cell,
    value: any,
    options: CommonOptions = {}
) {
    if (!isNumber(row) || !isNumber(column)) {
        throw new Error("row or column cannot be null or undefined");
    }

    if (!attr) {
        throw new Error("attr cannot be null or undefined");
    }

    const sheet = getSheet(ctx, options);

    const targetSheetData = sheet.data!;
    // if (targetSheetData.length === 0) {
    //   targetSheetData = sheetmanage.buildGridData(sheet);
    // }

    const cellData = targetSheetData?.[row]?.[column] || {};
    const cfg = sheet.config || {};

    // special format
    if (attr === "ct" && (!value || value.fa == null || value.t == null)) {
        throw new Error(
            "'fa' and 't' should be present in value when attr is 'ct'"
        );
    } else if (attr === "ct" && !isNil(cellData.v)) {
        cellData.m = format(value.fa, cellData.v); // auto generate mask
    }

    // @ts-ignore
    if (attr === "bd") {
        if (cfg.borderInfo == null) {
            cfg.borderInfo = [];
        }

        const borderInfo = {
            rangeType: "range",
            borderType: "border-all",
            color: "#000",
            style: "1",
            range: [
                {
                    column: [column, column],
                    row: [row, row],
                },
            ],
            ...value,
        };

        cfg.borderInfo.push(borderInfo);
    } else {
        cellData[attr] = value;
    }

    targetSheetData[row][column] = cellData;

    sheet.config = cfg;
    ctx.config = cfg;
}

export function autoFillCell(
    ctx: Context,
    copyRange: SingleRange,
    applyRange: SingleRange,
    direction: "up" | "down" | "left" | "right"
) {
    dropCellCache.copyRange = copyRange;
    dropCellCache.applyRange = applyRange;
    dropCellCache.direction = direction;
    const typeItemHide = getTypeItemHide(ctx);
    if (
        !typeItemHide[0] &&
        !typeItemHide[1] &&
        !typeItemHide[2] &&
        !typeItemHide[3] &&
        !typeItemHide[4] &&
        !typeItemHide[5] &&
        !typeItemHide[6]
    ) {
        dropCellCache.applyType = "0";
    } else {
        dropCellCache.applyType = "1";
    }
    updateDropCell(ctx);
}
