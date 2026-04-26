import {isNil} from "es-toolkit/compat";
import type {CellFormatStyle, ComputeMap} from "../../engine";
import {evaluateConditionalFormat} from "../../engine";
import type {CellMatrix} from "../../engine/types";
import {Context, getFlowdata} from "../context";
import {getSheetIndex} from "../utils";
import {getCellValue, getRangeByTxt} from "./cell";
import {execfunction, functionCopy} from "./formula-ui";
import {checkProtectionFormatCells} from "./protection";

// Set condition rules
export function setConditionRules(
    ctx: Context,
    protection: any,
    generalDialog: any,
    conditionformat: any,
    rules: any
) {
    if (!checkProtectionFormatCells(ctx)) {
        return;
    }

    // condition name
    const conditionName = rules.rulesType;

    // condition cell
    const conditionRange = [];

    // condition value
    const conditionValue = [];

    if (
        conditionName === "greaterThan" ||
        conditionName === "lessThan" ||
        conditionName === "equal" ||
        conditionName === "textContains"
    ) {
        let v = rules.rulesValue;
        const rangeArr = getRangeByTxt(ctx, v);
        // check whether the condition value is a selection range
        if (rangeArr.length > 1) {
            const r1 = rangeArr[0]?.row[0];
            const r2 = rangeArr[0]?.row[1];
            const c1 = rangeArr[0]?.column[0];
            const c2 = rangeArr[0]?.column[1];
            if (r1 === r2 && c1 === c2) {
                const d = getFlowdata(ctx);
                if (!d || isNil(r1) || isNil(c1)) return;
                v = getCellValue(r1, c1, d);
                conditionRange.push({
                    row: rangeArr?.[0]?.row,
                    column: rangeArr?.[0]?.column,
                });
                conditionValue.push(v);
            } else {
                ctx.warnDialog = conditionformat.onlySingleCell;
            }
        } else if (rangeArr.length === 0) {
            if (Number.isNaN(v) || v === "") {
                ctx.warnDialog = conditionformat.conditionValueCanOnly;
                return;
            }
            conditionValue.push(v);
        }
    } else if (conditionName === "between") {
        let v1 = rules.betweenValue.value1;
        let v2 = rules.betweenValue.value2;

        // convert value to array coordinates
        const rangeArr1 = getRangeByTxt(ctx, v1);
        if (rangeArr1.length > 1) {
            ctx.warnDialog = conditionformat.onlySingleCell;
            return;
        }
        if (rangeArr1.length === 1) {
            const r1 = rangeArr1[0]?.row[0];
            const r2 = rangeArr1[0]?.row[1];
            const c1 = rangeArr1[0]?.column[0];
            const c2 = rangeArr1[0]?.column[1];
            if (r1 === r2 && c1 === c2) {
                const d = getFlowdata(ctx);
                if (!d || isNil(r1) || isNil(c1)) return;
                v1 = getCellValue(r1, c1, d);
                conditionRange.push({
                    row: rangeArr1?.[0]?.row,
                    column: rangeArr1?.[0]?.column,
                });
                conditionValue.push(v1);
            } else {
                ctx.warnDialog = conditionformat.onlySingleCell;
                return;
            }
        } else if (rangeArr1.length === 0) {
            if (Number.isNaN(v1) || v1 === "") {
                ctx.warnDialog = conditionformat.conditionValueCanOnly;
                return;
            }
            conditionValue.push(v1);
        }
        const rangeArr2 = getRangeByTxt(ctx, v2);
        if (rangeArr2.length > 1) {
            ctx.warnDialog = conditionformat.onlySingleCell;
            return;
        }
        if (rangeArr2.length === 1) {
            const r1 = rangeArr2[0]?.row[0];
            const r2 = rangeArr2[0]?.row[1];
            const c1 = rangeArr2[0]?.column[0];
            const c2 = rangeArr2[0]?.column[1];
            if (r1 === r2 && c1 === c2) {
                const d = getFlowdata(ctx);
                if (!d || isNil(r1) || isNil(c1)) return;
                v2 = getCellValue(r1, c1, d);
                conditionRange.push({
                    row: rangeArr2?.[0]?.row,
                    column: rangeArr2?.[0]?.column,
                });
            } else {
                ctx.warnDialog = conditionformat.onlySingleCell;
                return;
            }
        } else if (rangeArr2.length === 0) {
            if (Number.isNaN(v2) || v2 === "") {
                ctx.warnDialog = conditionformat.conditionValueCanOnly;
            } else {
                conditionValue.push(v2);
            }
        }
    } else if (conditionName === "occurrenceDate") {
        const v = rules.dateValue;
        if (!v) {
            ctx.warnDialog = conditionformat.pleaseSelectADate;
            return;
        }
        conditionValue.push(v);
    } else if (conditionName === "duplicateValue") {
        conditionValue.push(rules.repeatValue);
    } else if (
        conditionName === "top10" ||
        conditionName === "top10_percent" ||
        conditionName === "last10" ||
        conditionName === "last10_percent"
    ) {
        const v = rules.projectValue;
        if (
            parseInt(v, 10).toString() !== v ||
            parseInt(v, 10) < 1 ||
            parseInt(v, 10) > 1000
        ) {
            ctx.warnDialog = conditionformat.pleaseEnterInteger;
            return;
        }
        conditionValue.push(v);
    } else {
        conditionValue.push(conditionName);
    }

    // color
    let textColor = null;
    if (rules.textColor.check) {
        textColor = rules.textColor.color;
    }

    let cellColor = null;
    if (rules.cellColor.check) {
        cellColor = rules.cellColor.color;
    }

    // construct the current rule
    const rule = {
        type: "default",
        cellrange: ctx.luckysheet_select_save ?? [],
        format: {
            textColor,
            cellColor,
        },
        conditionName,
        conditionRange,
        conditionValue,
    };
    const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
    const ruleArr =
        ctx.luckysheetfile[index].luckysheet_conditionformat_save ?? [];
    ruleArr.push(rule);

    ctx.luckysheetfile[index].luckysheet_conditionformat_save = ruleArr;
}

// Cache for getComputeMap — avoids recomputing the entire CF map on every
// canvas paint / getStyleByCell call. Invalidates when sheet, rules or data change.
let _cfCache: {
    sheetId: string | undefined;
    rules: any[] | undefined;
    data: CellMatrix;
    result: ComputeMap;
} | null = null;

export function invalidateCFCache() {
    _cfCache = null;
}

export function getComputeMap(ctx: Context): ComputeMap | null {
    const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
    const ruleArr = ctx.luckysheetfile[index].luckysheet_conditionformat_save;
    const {data} = ctx.luckysheetfile[index];
    if (isNil(data)) return null;

    // Return cached result if inputs haven't changed (reference equality)
    if (
        _cfCache &&
        _cfCache.sheetId === ctx.currentSheetId &&
        _cfCache.rules === ruleArr &&
        _cfCache.data === data
    ) {
        return _cfCache.result;
    }

    const computeMap = evaluateConditionalFormat(ruleArr, data, {
        evaluateFormula: (formula, anchorRow, anchorCol, targetRow, targetCol) => {
            const offsetRow = targetRow - anchorRow;
            const offsetCol = targetCol - anchorCol;
            let shifted = formula;
            if (offsetRow > 0) {
                shifted = `=${functionCopy(ctx, shifted, "down", offsetRow)}`;
            }
            if (offsetCol > 0) {
                shifted = `=${functionCopy(ctx, shifted, "right", offsetCol)}`;
            }
            return execfunction(ctx, shifted, targetRow, targetCol)[1];
        },
    });
    _cfCache = {
        sheetId: ctx.currentSheetId,
        rules: ruleArr,
        data,
        result: computeMap,
    };
    return computeMap;
}

export function checkCF(
    r: number,
    c: number,
    computeMap: ComputeMap | null
): CellFormatStyle | null {
    if (!isNil(computeMap) && `${r}_${c}` in computeMap) {
        return computeMap[`${r}_${c}`];
    }
    return null;
}

// 12 color-scale + 6 solid-data-bar presets, ported from luckysheet upstream.
// Numbers match the locale keys colorGradation_1..12 / solidColorDataBar_1..6
// in state/locale/en.ts.
export const CF_PRESETS: Record<string, string[]> = {
    // 3-color gradients (max → mid → min)
    colorGradation_1: ["#f8696b", "#ffeb84", "#63be7b"],
    colorGradation_2: ["#63be7b", "#ffeb84", "#f8696b"],
    colorGradation_3: ["#f8696b", "#ffffff", "#63be7b"],
    colorGradation_4: ["#63be7b", "#ffffff", "#f8696b"],
    colorGradation_5: ["#f8696b", "#ffffff", "#5a8ac6"],
    colorGradation_6: ["#5a8ac6", "#ffffff", "#f8696b"],
    // 2-color gradients (max → min)
    colorGradation_7: ["#f8696b", "#ffffff"],
    colorGradation_8: ["#ffffff", "#f8696b"],
    colorGradation_9: ["#ffffff", "#63be7b"],
    colorGradation_10: ["#63be7b", "#ffffff"],
    colorGradation_11: ["#ffeb84", "#63be7b"],
    colorGradation_12: ["#63be7b", "#ffeb84"],
    // Solid data-bar colors (single bar color; negative bars hardcode red)
    solidColorDataBar_1: ["#638ec6"],
    solidColorDataBar_2: ["#63be7b"],
    solidColorDataBar_3: ["#f8696b"],
    solidColorDataBar_4: ["#ffb628"],
    solidColorDataBar_5: ["#a3c8ff"],
    solidColorDataBar_6: ["#a085ff"],
};

export function clearSheetRules(ctx: Context) {
    if (!checkProtectionFormatCells(ctx)) return;
    const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
    ctx.luckysheetfile[index].luckysheet_conditionformat_save = [];
}

export function applyColorScalePreset(ctx: Context, presetKey: string) {
    if (!checkProtectionFormatCells(ctx)) return;
    const format = CF_PRESETS[presetKey];
    if (!format) return;
    appendRule(ctx, "colorGradation", format);
}

export function applyDataBarPreset(ctx: Context, presetKey: string) {
    if (!checkProtectionFormatCells(ctx)) return;
    const format = CF_PRESETS[presetKey];
    if (!format) return;
    appendRule(ctx, "dataBar", format);
}

function appendRule(ctx: Context, type: "colorGradation" | "dataBar", format: string[]) {
    const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
    const rule = {
        type,
        cellrange: ctx.luckysheet_select_save ?? [],
        format,
    };
    const existing = ctx.luckysheetfile[index].luckysheet_conditionformat_save ?? [];
    existing.push(rule);
    ctx.luckysheetfile[index].luckysheet_conditionformat_save = existing;
}
