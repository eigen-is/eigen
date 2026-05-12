import { forEach, isNil } from 'es-toolkit/compat';
import { genarate } from './format';
import type { CellMatrix, ConditionalFormatRule, SingleRange } from './types';
import { isRealNull } from './validation';

// CF rule shapes (`ConditionalFormatRule`, `DataBarRule`, etc.) are defined in
// `@workspace/lib/sheets` since they live on `Sheet.luckysheet_conditionformat_save`
// — see engine/types.ts for the re-export.

export type DataBar =
    | { valueType: 'minus'; valueLen: number; format: string[]; minusLen: number }
    | { valueType: 'plus'; valueLen: number; format: string[]; plusLen: number; minusLen: number };

export type CellFormatStyle = {
    textColor?: string | null;
    cellColor?: string | null;
    dataBar?: DataBar;
};

export type ComputeMap = Record<string, CellFormatStyle>;

export type ConditionalFormatFormulaEvaluator = (
    formula: string,
    anchorRow: number,
    anchorCol: number,
    targetRow: number,
    targetCol: number,
) => unknown;

export type EvaluateConditionalFormatOptions = {
    evaluateFormula?: ConditionalFormatFormulaEvaluator;
};

// Returns the cell's display value at (r, c). Mirrors the "v" attribute path of
// state-side getCellValue, simplified for the conditional-format evaluator.
function cellValueAt(data: CellMatrix, r: number, c: number) {
    return data[r]?.[c]?.v ?? null;
}

// Merge a partial cell style into the map, creating the entry if absent. The CF evaluator
// applies overlapping rules in order, so later rules layer onto earlier entries instead of
// overwriting them — matching canvas-painter behaviour.
function applyCellStyle(map: ComputeMap, r: number, c: number, style: CellFormatStyle) {
    const key = `${r}_${c}`;
    if (key in map) {
        Object.assign(map[key], style);
    } else {
        map[key] = { ...style };
    }
}

// Parse "#rrggbb" or "rgb(R, G, B)" into [r, g, b].
function parseColorChannels(color: string): [number, number, number] {
    if (color.startsWith('#')) {
        const hex = color.slice(1);
        return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
    }
    const parts = color.split(',');
    return [parseInt(parts[0].split('(')[1], 10), parseInt(parts[1], 10), parseInt(parts[2].split(')')[0], 10)];
}

export function getColorGradation(color1: string, color2: string, value1: number, value2: number, value: number) {
    const [r1, g1, b1] = parseColorChannels(color1);
    const [r2, g2, b2] = parseColorChannels(color2);

    const v12 = value1 - value2;
    const v10 = value1 - value;

    const r = Math.round(r1 - ((r1 - r2) / v12) * v10);
    const g = Math.round(g1 - ((g1 - g2) / v12) * v10);
    const b = Math.round(b1 - ((b1 - b2) / v12) * v10);

    return `rgb(${r}, ${g}, ${b})`;
}

// Pure conditional-format evaluator. Returns a map keyed by `${r}_${c}` with the
// computed text/cell colors and data bars per cell. The formula-rule branch is
// gated on options.evaluateFormula — when not provided, formula-based rules are
// skipped entirely (other rule types still evaluate).
export function evaluateConditionalFormat(
    rules: ConditionalFormatRule[] | null | undefined,
    data: CellMatrix,
    options?: EvaluateConditionalFormatOptions,
): ComputeMap {
    const ruleArr = rules ?? [];
    const computeMap: ComputeMap = {};

    for (const rule of ruleArr) {
        // data bar
        if (rule.type === 'dataBar') {
            const { cellrange, format } = rule;
            let max = null;
            let min = null;
            for (let s = 0; s < cellrange.length; s += 1) {
                for (let r = cellrange[s].row[0]; r <= cellrange[s].row[1]; r += 1) {
                    for (let c = cellrange[s].column[0]; c <= cellrange[s].column[1]; c += 1) {
                        if (isNil(data[r]) || isNil(data[r][c])) {
                            continue;
                        }
                        const cell = data[r][c];
                        if (!isNil(cell) && !isNil(cell.ct) && cell.ct.t === 'n' && !isNil(cell.v)) {
                            const numVal = Number(cell.v);
                            if (isNil(max) || numVal > max) {
                                max = numVal;
                            }

                            if (isNil(min) || numVal < min) {
                                min = numVal;
                            }
                        }
                    }
                }
            }
            if (!isNil(max) && !isNil(min)) {
                if (min < 0) {
                    // selection range contains negative numbers
                    const plusLen = Math.round((max / (max - min)) * 10) / 10; // proportion of positive numbers
                    const minusLen = Math.round((Math.abs(min) / (max - min)) * 10) / 10; // proportion of negative numbers

                    for (let s = 0; s < cellrange.length; s += 1) {
                        for (let r = cellrange[s].row[0]; r <= cellrange[s].row[1]; r += 1) {
                            for (let c = cellrange[s].column[0]; c <= cellrange[s].column[1]; c += 1) {
                                if (isNil(data[r]) || isNil(data[r][c])) {
                                    continue;
                                }

                                const cell = data[r][c];

                                if (!isNil(cell) && !isNil(cell.ct) && cell.ct.t === 'n' && !isNil(cell.v)) {
                                    if (Number(cell.v) < 0) {
                                        const valueLen =
                                            Math.round((Math.abs(Number(cell.v)) / Math.abs(min)) * 100) / 100;
                                        applyCellStyle(computeMap, r, c, {
                                            dataBar: { valueType: 'minus', minusLen, valueLen, format },
                                        });
                                    }

                                    if (Number(cell.v) > 0) {
                                        const valueLen = Math.round((Number(cell.v) / max) * 100) / 100;
                                        applyCellStyle(computeMap, r, c, {
                                            dataBar: { valueType: 'plus', plusLen, minusLen, valueLen, format },
                                        });
                                    }
                                }
                            }
                        }
                    }
                } else {
                    const plusLen = 1;

                    for (let s = 0; s < cellrange.length; s += 1) {
                        for (let r = cellrange[s].row[0]; r <= cellrange[s].row[1]; r += 1) {
                            for (let c = cellrange[s].column[0]; c <= cellrange[s].column[1]; c += 1) {
                                if (isNil(data[r]) || isNil(data[r][c])) {
                                    continue;
                                }

                                const cell = data[r][c];

                                if (!isNil(cell) && !isNil(cell.ct) && cell.ct.t === 'n' && !isNil(cell.v)) {
                                    const valueLen = max === 0 ? 1 : Math.round((Number(cell.v) / max) * 100) / 100;
                                    applyCellStyle(computeMap, r, c, {
                                        dataBar: { valueType: 'plus', plusLen, minusLen: 0, valueLen, format },
                                    });
                                }
                            }
                        }
                    }
                }
            }
        } else if (rule.type === 'colorGradation') {
            // color scale
            const { cellrange, format } = rule;
            let max = null;
            let min = null;
            let sum = 0;
            let count = 0;
            for (let s = 0; s < cellrange.length; s += 1) {
                for (let r = cellrange[s].row[0]; r <= cellrange[s].row[1]; r += 1) {
                    for (let c = cellrange[s].column[0]; c <= cellrange[s].column[1]; c += 1) {
                        if (isNil(data[r]) || isNil(data[r][c])) {
                            continue;
                        }

                        const cell = data[r][c];

                        if (!isNil(cell) && !isNil(cell.ct) && cell.ct.t === 'n' && !isNil(cell.v)) {
                            const numVal = Number(cell.v);
                            count += 1;
                            sum += numVal;

                            if (isNil(max) || numVal > max) {
                                max = numVal;
                            }

                            if (isNil(min) || numVal < min) {
                                min = numVal;
                            }
                        }
                    }
                }
            }
            if (!isNil(max) && !isNil(min) && (format.length === 2 || format.length === 3)) {
                // Per-cell color picker — interpolates between max/min (2-color) or
                // max/avg/min (3-color) stops. Returns null for cells outside the
                // bracketed range, mirroring the original branch behavior.
                const avg = format.length === 3 ? Math.floor(sum / count) : 0;
                const stopFor = (numVal: number): string | null => {
                    if (format.length === 3) {
                        if (numVal === min) return format[2];
                        if (numVal < avg) return getColorGradation(format[2], format[1], min, avg, numVal);
                        if (numVal === avg) return format[1];
                        if (numVal < max) return getColorGradation(format[1], format[0], avg, max, numVal);
                        if (numVal === max) return format[0];
                        return null;
                    }
                    if (numVal === min) return format[1];
                    if (numVal < max) return getColorGradation(format[1], format[0], min, max, numVal);
                    if (numVal === max) return format[0];
                    return null;
                };

                for (let s = 0; s < cellrange.length; s += 1) {
                    for (let r = cellrange[s].row[0]; r <= cellrange[s].row[1]; r += 1) {
                        for (let c = cellrange[s].column[0]; c <= cellrange[s].column[1]; c += 1) {
                            const cell = data[r]?.[c];
                            if (isNil(cell) || isNil(cell.ct) || cell.ct.t !== 'n' || isNil(cell.v)) {
                                continue;
                            }
                            const cellColor = stopFor(Number(cell.v));
                            if (cellColor !== null) {
                                applyCellStyle(computeMap, r, c, { cellColor });
                            }
                        }
                    }
                }
            }
        } else if (rule.type === 'icons') {
            // icon set — not yet implemented
        } else {
            // 'default' — comparison / aggregation / formula rules
            const { cellrange, format, conditionName, conditionValue } = rule;
            const conditionValue0 = conditionValue[0];
            const conditionValue1 = conditionValue[1];
            const { textColor, cellColor } = format;
            for (let s = 0; s < cellrange.length; s += 1) {
                // check condition type
                if (
                    conditionName === 'greaterThan' ||
                    conditionName === 'lessThan' ||
                    conditionName === 'equal' ||
                    conditionName === 'textContains'
                ) {
                    // iterate over apply range and evaluate
                    for (let r = cellrange[s].row[0]; r <= cellrange[s].row[1]; r += 1) {
                        for (let c = cellrange[s].column[0]; c <= cellrange[s].column[1]; c += 1) {
                            if (isNil(data[r]) || isNil(data[r][c])) {
                                continue;
                            }
                            // cell value
                            const cell = data[r][c];
                            if (isNil(cell) || isNil(cell.v) || isRealNull(cell.v)) {
                                continue;
                            }
                            let matches = false;
                            if (conditionName === 'greaterThan') {
                                matches = cell.v > conditionValue0;
                            } else if (conditionName === 'lessThan') {
                                matches = cell.v < conditionValue0;
                            } else if (conditionName === 'equal') {
                                matches = cell.v.toString() === conditionValue0;
                            } else if (conditionName === 'textContains') {
                                matches = cell.v.toString().indexOf(String(conditionValue0)) !== -1;
                            }
                            if (matches) {
                                applyCellStyle(computeMap, r, c, { textColor, cellColor });
                            }
                        }
                    }
                } else if (conditionName === 'between') {
                    // Coerce to number — `between` only compares against numeric cell values
                    // (`typeof cell.v === 'number'` guard below) and form input arrives as string.
                    const v0 = Number(conditionValue0);
                    const v1 = Number(conditionValue1);
                    const vBig = Math.max(v0, v1);
                    const vSmall = Math.min(v0, v1);
                    // iterate over apply range and evaluate
                    for (let r = cellrange[s].row[0]; r <= cellrange[s].row[1]; r += 1) {
                        for (let c = cellrange[s].column[0]; c <= cellrange[s].column[1]; c += 1) {
                            if (isNil(data[r]) || isNil(data[r][c])) {
                                continue;
                            }
                            // cell value
                            const cell = data[r][c];
                            if (isNil(cell) || isNil(cell.v) || isRealNull(cell.v)) {
                                continue;
                            }
                            if (typeof cell.v === 'number' && cell.v >= vSmall && cell.v <= vBig) {
                                applyCellStyle(computeMap, r, c, { textColor, cellColor });
                            }
                        }
                    }
                } else if (conditionName === 'occurrenceDate') {
                    let dBig: string;
                    let dSmall: string;
                    if (conditionValue0.toString().indexOf('-') === -1) {
                        dBig = genarate(conditionValue0)[2].toString();
                        dSmall = genarate(conditionValue0)[2].toString();
                    } else {
                        const str = conditionValue0.toString().split('-');
                        dBig = genarate(str[1].trim())[2].toString();
                        dSmall = genarate(str[0].trim())[2].toString();
                    }
                    // iterate over apply range and evaluate
                    for (let r = cellrange[s].row[0]; r <= cellrange[s].row[1]; r += 1) {
                        for (let c = cellrange[s].column[0]; c <= cellrange[s].column[1]; c += 1) {
                            if (isNil(data[r]) || isNil(data[r][c])) {
                                continue;
                            }
                            if (!isNil(data[r][c]) && !isNil(data[r][c]!.ct) && data[r][c]!.ct!.t === 'd') {
                                const cellVal = cellValueAt(data, r, c);
                                if (cellVal != null && cellVal >= dSmall && cellVal <= dBig) {
                                    applyCellStyle(computeMap, r, c, { textColor, cellColor });
                                }
                            }
                        }
                    }
                } else if (conditionName === 'duplicateValue') {
                    // process cells in apply range
                    const dmap: Record<string, { r: number; c: number }[]> = {};
                    for (let r = cellrange[s].row[0]; r <= cellrange[s].row[1]; r += 1) {
                        for (let c = cellrange[s].column[0]; c <= cellrange[s].column[1]; c += 1) {
                            const item = String(cellValueAt(data, r, c));
                            if (!(item in dmap)) {
                                dmap[item] = [];
                            }
                            dmap[item].push({ r, c });
                        }
                    }
                    if (conditionValue0 === '0') {
                        // duplicate values
                        forEach(dmap, (x) => {
                            if (x.length > 1) {
                                for (let j = 0; j < x.length; j += 1) {
                                    applyCellStyle(computeMap, x[j].r, x[j].c, { textColor, cellColor });
                                }
                            }
                        });
                    } else if (conditionValue0 === '1') {
                        // unique values
                        forEach(dmap, (x) => {
                            if (x.length === 1) {
                                applyCellStyle(computeMap, x[0].r, x[0].c, { textColor, cellColor });
                            }
                        });
                    }
                } else if (
                    conditionName === 'top10' ||
                    conditionName === 'top10_percent' ||
                    conditionName === 'last10' ||
                    conditionName === 'last10_percent' ||
                    conditionName === 'aboveAverage' ||
                    conditionName === 'belowAverage'
                ) {
                    // cell values in apply range (numeric type)
                    const dArr: number[] = [];
                    for (let r = cellrange[s].row[0]; r <= cellrange[s].row[1]; r += 1) {
                        for (let c = cellrange[s].column[0]; c <= cellrange[s].column[1]; c += 1) {
                            if (isNil(data[r]) || isNil(data[r][c])) {
                                continue;
                            }

                            // cell value type is numeric
                            if (!isNil(data[r][c]) && !isNil(data[r][c]!.ct) && data[r][c]!.ct!.t === 'n') {
                                dArr.push(Number(cellValueAt(data, r, c)));
                            }
                        }
                    }
                    // process the array
                    if (
                        conditionName === 'top10' ||
                        conditionName === 'top10_percent' ||
                        conditionName === 'last10' ||
                        conditionName === 'last10_percent'
                    ) {
                        // sort from largest to smallest
                        dArr.sort((a, b) => b - a);

                        // form input arrives as string; coerce once for arithmetic / slice
                        const n = Number(conditionValue0);
                        let cArr: number[] | undefined;
                        if (conditionName === 'top10') {
                            cArr = dArr.slice(0, n); // top n items
                        } else if (conditionName === 'top10_percent') {
                            cArr = dArr.slice(0, Math.floor((n * dArr.length) / 100)); // top n% items
                        } else if (conditionName === 'last10') {
                            cArr = dArr.slice(dArr.length - n, dArr.length); // bottom n items
                        } else if (conditionName === 'last10_percent') {
                            cArr = dArr.slice(dArr.length - Math.floor((n * dArr.length) / 100), dArr.length); // bottom n% items
                        }
                        // iterate over apply range and evaluate
                        for (let r = cellrange[s].row[0]; r <= cellrange[s].row[1]; r += 1) {
                            for (let c = cellrange[s].column[0]; c <= cellrange[s].column[1]; c += 1) {
                                if (isNil(data[r]) || isNil(data[r][c])) {
                                    continue;
                                }

                                const cellVal = Number(cellValueAt(data, r, c));
                                if (!isNil(cArr) && cArr.indexOf(cellVal) !== -1) {
                                    applyCellStyle(computeMap, r, c, { textColor, cellColor });
                                }
                            }
                        }
                    } else if (conditionName === 'aboveAverage' || conditionName === 'belowAverage') {
                        const averageNum = dArr.reduce((acc, n) => acc + n, 0) / dArr.length;
                        const matches = (n: number) =>
                            conditionName === 'aboveAverage' ? n > averageNum : n < averageNum;
                        for (let r = cellrange[s].row[0]; r <= cellrange[s].row[1]; r += 1) {
                            for (let c = cellrange[s].column[0]; c <= cellrange[s].column[1]; c += 1) {
                                if (isNil(data[r]) || isNil(data[r][c])) {
                                    continue;
                                }
                                if (matches(Number(cellValueAt(data, r, c)))) {
                                    applyCellStyle(computeMap, r, c, { textColor, cellColor });
                                }
                            }
                        }
                    }
                } else if (conditionName === 'formula' && options?.evaluateFormula) {
                    const str = cellrange[s].row[0];
                    const edr = cellrange[s].row[1];
                    const stc = cellrange[s].column[0];
                    const edc = cellrange[s].column[1];

                    const formulaSrc = String(conditionValue0);
                    const formulaTxt = formulaSrc.startsWith('=') ? formulaSrc : `=${formulaSrc}`;
                    for (let r = str; r <= edr; r += 1) {
                        for (let c = stc; c <= edc; c += 1) {
                            const raw = options.evaluateFormula(formulaTxt, str, stc, r, c);
                            const v = typeof raw === 'boolean' ? raw : !!Number(raw);
                            if (v) {
                                applyCellStyle(computeMap, r, c, { textColor, cellColor });
                            }
                        }
                    }
                }
            }
        }
    }
    return computeMap;
}

export function cfSplitRange(
    range1: SingleRange,
    range2: SingleRange,
    range3: SingleRange,
    type: string,
): SingleRange[] {
    let range: SingleRange[] = [];

    const offset_r = range3.row[0] - range2.row[0];
    const offset_c = range3.column[0] - range2.column[0];

    const r1 = range1.row[0];
    const r2 = range1.row[1];
    const c1 = range1.column[0];
    const c2 = range1.column[1];

    if (r1 >= range2.row[0] && r2 <= range2.row[1] && c1 >= range2.column[0] && c2 <= range2.column[1]) {
        // selection fully contains the conditional format apply range

        if (type === 'allPart') {
            // all parts
            range = [
                {
                    row: [r1 + offset_r, r2 + offset_r],
                    column: [c1 + offset_c, c2 + offset_c],
                },
            ];
        } else if (type === 'restPart') {
            // remaining part
            range = [];
        } else if (type === 'operatePart') {
            // operated part
            range = [
                {
                    row: [r1 + offset_r, r2 + offset_r],
                    column: [c1 + offset_c, c2 + offset_c],
                },
            ];
        }
    } else if (r1 >= range2.row[0] && r1 <= range2.row[1] && c1 >= range2.column[0] && c2 <= range2.column[1]) {
        // selection row-spans the conditional format apply range — upper portion

        if (type === 'allPart') {
            // all parts
            range = [
                { row: [range2.row[1] + 1, r2], column: [c1, c2] },
                {
                    row: [r1 + offset_r, range2.row[1] + offset_r],
                    column: [c1 + offset_c, c2 + offset_c],
                },
            ];
        } else if (type === 'restPart') {
            // remaining part
            range = [{ row: [range2.row[1] + 1, r2], column: [c1, c2] }];
        } else if (type === 'operatePart') {
            // operated part
            range = [
                {
                    row: [r1 + offset_r, range2.row[1] + offset_r],
                    column: [c1 + offset_c, c2 + offset_c],
                },
            ];
        }
    } else if (r2 >= range2.row[0] && r2 <= range2.row[1] && c1 >= range2.column[0] && c2 <= range2.column[1]) {
        // selection row-spans the conditional format apply range — lower portion

        if (type === 'allPart') {
            // all parts
            range = [
                { row: [r1, range2.row[0] - 1], column: [c1, c2] },
                {
                    row: [range2.row[0] + offset_r, r2 + offset_r],
                    column: [c1 + offset_c, c2 + offset_c],
                },
            ];
        } else if (type === 'restPart') {
            // remaining part
            range = [{ row: [r1, range2.row[0] - 1], column: [c1, c2] }];
        } else if (type === 'operatePart') {
            // operated part
            range = [
                {
                    row: [range2.row[0] + offset_r, r2 + offset_r],
                    column: [c1 + offset_c, c2 + offset_c],
                },
            ];
        }
    } else if (r1 < range2.row[0] && r2 > range2.row[1] && c1 >= range2.column[0] && c2 <= range2.column[1]) {
        // selection row-spans the conditional format apply range — middle portion

        if (type === 'allPart') {
            // all parts
            range = [
                { row: [r1, range2.row[0] - 1], column: [c1, c2] },
                { row: [range2.row[1] + 1, r2], column: [c1, c2] },
                {
                    row: [range2.row[0] + offset_r, range2.row[1] + offset_r],
                    column: [c1 + offset_c, c2 + offset_c],
                },
            ];
        } else if (type === 'restPart') {
            // remaining part
            range = [
                { row: [r1, range2.row[0] - 1], column: [c1, c2] },
                { row: [range2.row[1] + 1, r2], column: [c1, c2] },
            ];
        } else if (type === 'operatePart') {
            // operated part
            range = [
                {
                    row: [range2.row[0] + offset_r, range2.row[1] + offset_r],
                    column: [c1 + offset_c, c2 + offset_c],
                },
            ];
        }
    } else if (c1 >= range2.column[0] && c1 <= range2.column[1] && r1 >= range2.row[0] && r2 <= range2.row[1]) {
        // selection column-spans the conditional format apply range — left portion

        if (type === 'allPart') {
            // all parts
            range = [
                { row: [r1, r2], column: [range2.column[1] + 1, c2] },
                {
                    row: [r1 + offset_r, r2 + offset_r],
                    column: [c1 + offset_c, range2.column[1] + offset_c],
                },
            ];
        } else if (type === 'restPart') {
            // remaining part
            range = [{ row: [r1, r2], column: [range2.column[1] + 1, c2] }];
        } else if (type === 'operatePart') {
            // operated part
            range = [
                {
                    row: [r1 + offset_r, r2 + offset_r],
                    column: [c1 + offset_c, range2.column[1] + offset_c],
                },
            ];
        }
    } else if (c2 >= range2.column[0] && c2 <= range2.column[1] && r1 >= range2.row[0] && r2 <= range2.row[1]) {
        // selection column-spans the conditional format apply range — right portion

        if (type === 'allPart') {
            // all parts
            range = [
                { row: [r1, r2], column: [c1, range2.column[0] - 1] },
                {
                    row: [r1 + offset_r, r2 + offset_r],
                    column: [range2.column[0] + offset_c, c2 + offset_c],
                },
            ];
        } else if (type === 'restPart') {
            // remaining part
            range = [{ row: [r1, r2], column: [c1, range2.column[0] - 1] }];
        } else if (type === 'operatePart') {
            // operated part
            range = [
                {
                    row: [r1 + offset_r, r2 + offset_r],
                    column: [range2.column[0] + offset_c, c2 + offset_c],
                },
            ];
        }
    } else if (c1 < range2.column[0] && c2 > range2.column[1] && r1 >= range2.row[0] && r2 <= range2.row[1]) {
        // selection column-spans the conditional format apply range — middle portion

        if (type === 'allPart') {
            // all parts
            range = [
                { row: [r1, r2], column: [c1, range2.column[0] - 1] },
                { row: [r1, r2], column: [range2.column[1] + 1, c2] },
                {
                    row: [r1 + offset_r, r2 + offset_r],
                    column: [range2.column[0] + offset_c, range2.column[1] + offset_c],
                },
            ];
        } else if (type === 'restPart') {
            // remaining part
            range = [
                { row: [r1, r2], column: [c1, range2.column[0] - 1] },
                { row: [r1, r2], column: [range2.column[1] + 1, c2] },
            ];
        } else if (type === 'operatePart') {
            // operated part
            range = [
                {
                    row: [r1 + offset_r, r2 + offset_r],
                    column: [range2.column[0] + offset_c, range2.column[1] + offset_c],
                },
            ];
        }
    } else if (r1 >= range2.row[0] && r1 <= range2.row[1] && c1 >= range2.column[0] && c1 <= range2.column[1]) {
        // selection overlaps the conditional format apply range — top-left corner

        if (type === 'allPart') {
            // all parts
            range = [
                { row: [r1, range2.row[1]], column: [range2.column[1] + 1, c2] },
                { row: [range2.row[1] + 1, r2], column: [c1, c2] },
                {
                    row: [r1 + offset_r, range2.row[1] + offset_r],
                    column: [c1 + offset_c, range2.column[1] + offset_c],
                },
            ];
        } else if (type === 'restPart') {
            // remaining part
            range = [
                { row: [r1, range2.row[1]], column: [range2.column[1] + 1, c2] },
                { row: [range2.row[1] + 1, r2], column: [c1, c2] },
            ];
        } else if (type === 'operatePart') {
            // operated part
            range = [
                {
                    row: [r1 + offset_r, range2.row[1] + offset_r],
                    column: [c1 + offset_c, range2.column[1] + offset_c],
                },
            ];
        }
    } else if (r1 >= range2.row[0] && r1 <= range2.row[1] && c2 >= range2.column[0] && c2 <= range2.column[1]) {
        // selection overlaps the conditional format apply range — top-right corner

        if (type === 'allPart') {
            // all parts
            range = [
                { row: [r1, range2.row[1]], column: [c1, range2.column[0] - 1] },
                { row: [range2.row[1] + 1, r2], column: [c1, c2] },
                {
                    row: [r1 + offset_r, range2.row[1] + offset_r],
                    column: [range2.column[0] + offset_c, c2 + offset_c],
                },
            ];
        } else if (type === 'restPart') {
            // remaining part
            range = [
                { row: [r1, range2.row[1]], column: [c1, range2.column[0] - 1] },
                { row: [range2.row[1] + 1, r2], column: [c1, c2] },
            ];
        } else if (type === 'operatePart') {
            // operated part
            range = [
                {
                    row: [r1 + offset_r, range2.row[1] + offset_r],
                    column: [range2.column[0] + offset_c, c2 + offset_c],
                },
            ];
        }
    } else if (r2 >= range2.row[0] && r2 <= range2.row[1] && c1 >= range2.column[0] && c1 <= range2.column[1]) {
        // selection overlaps the conditional format apply range — bottom-left corner

        if (type === 'allPart') {
            // all parts
            range = [
                { row: [r1, range2.row[0] - 1], column: [c1, c2] },
                { row: [range2.row[0], r2], column: [range2.column[1] + 1, c2] },
                {
                    row: [range2.row[0] + offset_r, r2 + offset_r],
                    column: [c1 + offset_c, range2.column[1] + offset_c],
                },
            ];
        } else if (type === 'restPart') {
            // remaining part
            range = [
                { row: [r1, range2.row[0] - 1], column: [c1, c2] },
                { row: [range2.row[0], r2], column: [range2.column[1] + 1, c2] },
            ];
        } else if (type === 'operatePart') {
            // operated part
            range = [
                {
                    row: [range2.row[0] + offset_r, r2 + offset_r],
                    column: [c1 + offset_c, range2.column[1] + offset_c],
                },
            ];
        }
    } else if (r2 >= range2.row[0] && r2 <= range2.row[1] && c2 >= range2.column[0] && c2 <= range2.column[1]) {
        // selection overlaps the conditional format apply range — bottom-right corner

        if (type === 'allPart') {
            // all parts
            range = [
                { row: [r1, range2.row[0] - 1], column: [c1, c2] },
                { row: [range2.row[0], r2], column: [c1, range2.column[0] - 1] },
                {
                    row: [range2.row[0] + offset_r, r2 + offset_r],
                    column: [range2.column[0] + offset_c, c2 + offset_c],
                },
            ];
        } else if (type === 'restPart') {
            // remaining part
            range = [
                { row: [r1, range2.row[0] - 1], column: [c1, c2] },
                { row: [range2.row[0], r2], column: [c1, range2.column[0] - 1] },
            ];
        } else if (type === 'operatePart') {
            // operated part
            range = [
                {
                    row: [range2.row[0] + offset_r, r2 + offset_r],
                    column: [range2.column[0] + offset_c, c2 + offset_c],
                },
            ];
        }
    } else if (r1 < range2.row[0] && r2 > range2.row[1] && c1 >= range2.column[0] && c1 <= range2.column[1]) {
        // selection overlaps the conditional format apply range — left-middle portion

        if (type === 'allPart') {
            // all parts
            range = [
                { row: [r1, range2.row[0] - 1], column: [c1, c2] },
                {
                    row: [range2.row[0], range2.row[1]],
                    column: [range2.column[1] + 1, c2],
                },
                { row: [range2.row[1] + 1, r2], column: [c1, c2] },
                {
                    row: [range2.row[0] + offset_r, range2.row[1] + offset_r],
                    column: [c1 + offset_c, range2.column[1] + offset_c],
                },
            ];
        } else if (type === 'restPart') {
            // remaining part
            range = [
                { row: [r1, range2.row[0] - 1], column: [c1, c2] },
                {
                    row: [range2.row[0], range2.row[1]],
                    column: [range2.column[1] + 1, c2],
                },
                { row: [range2.row[1] + 1, r2], column: [c1, c2] },
            ];
        } else if (type === 'operatePart') {
            // operated part
            range = [
                {
                    row: [range2.row[0] + offset_r, range2.row[1] + offset_r],
                    column: [c1 + offset_c, range2.column[1] + offset_c],
                },
            ];
        }
    } else if (r1 < range2.row[0] && r2 > range2.row[1] && c2 >= range2.column[0] && c2 <= range2.column[1]) {
        // selection overlaps the conditional format apply range — right-middle portion

        if (type === 'allPart') {
            // all parts
            range = [
                { row: [r1, range2.row[0] - 1], column: [c1, c2] },
                {
                    row: [range2.row[0], range2.row[1]],
                    column: [c1, range2.column[0] - 1],
                },
                { row: [range2.row[1] + 1, r2], column: [c1, c2] },
                {
                    row: [range2.row[0] + offset_r, range2.row[1] + offset_r],
                    column: [range2.column[0] + offset_c, c2 + offset_c],
                },
            ];
        } else if (type === 'restPart') {
            // remaining part
            range = [
                { row: [r1, range2.row[0] - 1], column: [c1, c2] },
                {
                    row: [range2.row[0], range2.row[1]],
                    column: [c1, range2.column[0] - 1],
                },
                { row: [range2.row[1] + 1, r2], column: [c1, c2] },
            ];
        } else if (type === 'operatePart') {
            // operated part
            range = [
                {
                    row: [range2.row[0] + offset_r, range2.row[1] + offset_r],
                    column: [range2.column[0] + offset_c, c2 + offset_c],
                },
            ];
        }
    } else if (c1 < range2.column[0] && c2 > range2.column[1] && r1 >= range2.row[0] && r1 <= range2.row[1]) {
        // selection overlaps the conditional format apply range — top-middle portion

        if (type === 'allPart') {
            // all parts
            range = [
                { row: [r1, range2.row[1]], column: [c1, range2.column[0] - 1] },
                { row: [r1, range2.row[1]], column: [range2.column[1] + 1, c2] },
                { row: [range2.row[1] + 1, r2], column: [c1, c2] },
                {
                    row: [r1 + offset_r, range2.row[1] + offset_r],
                    column: [range2.column[0] + offset_c, range2.column[1] + offset_c],
                },
            ];
        } else if (type === 'restPart') {
            // remaining part
            range = [
                { row: [r1, range2.row[1]], column: [c1, range2.column[0] - 1] },
                { row: [r1, range2.row[1]], column: [range2.column[1] + 1, c2] },
                { row: [range2.row[1] + 1, r2], column: [c1, c2] },
            ];
        } else if (type === 'operatePart') {
            // operated part
            range = [
                {
                    row: [r1 + offset_r, range2.row[1] + offset_r],
                    column: [range2.column[0] + offset_c, range2.column[1] + offset_c],
                },
            ];
        }
    } else if (c1 < range2.column[0] && c2 > range2.column[1] && r2 >= range2.row[0] && r2 <= range2.row[1]) {
        // selection overlaps the conditional format apply range — bottom-middle portion

        if (type === 'allPart') {
            // all parts
            range = [
                { row: [r1, range2.row[0] - 1], column: [c1, c2] },
                { row: [range2.row[0], r2], column: [c1, range2.column[0] - 1] },
                { row: [range2.row[0], r2], column: [range2.column[1] + 1, c2] },
                {
                    row: [range2.row[0] + offset_r, r2 + offset_r],
                    column: [range2.column[0] + offset_c, range2.column[1] + offset_c],
                },
            ];
        } else if (type === 'restPart') {
            // remaining part
            range = [
                { row: [r1, range2.row[0] - 1], column: [c1, c2] },
                { row: [range2.row[0], r2], column: [c1, range2.column[0] - 1] },
                { row: [range2.row[0], r2], column: [range2.column[1] + 1, c2] },
            ];
        } else if (type === 'operatePart') {
            // operated part
            range = [
                {
                    row: [range2.row[0] + offset_r, r2 + offset_r],
                    column: [range2.column[0] + offset_c, range2.column[1] + offset_c],
                },
            ];
        }
    } else if (r1 < range2.row[0] && r2 > range2.row[1] && c1 < range2.column[0] && c2 > range2.column[1]) {
        // selection overlaps the conditional format apply range — exact center portion

        if (type === 'allPart') {
            // all parts
            range = [
                { row: [r1, range2.row[0] - 1], column: [c1, c2] },
                {
                    row: [range2.row[0], range2.row[1]],
                    column: [c1, range2.column[0] - 1],
                },
                {
                    row: [range2.row[0], range2.row[1]],
                    column: [range2.column[1] + 1, c2],
                },
                { row: [range2.row[1] + 1, r2], column: [c1, c2] },
                {
                    row: [range2.row[0] + offset_r, range2.row[1] + offset_r],
                    column: [range2.column[0] + offset_c, range2.column[1] + offset_c],
                },
            ];
        } else if (type === 'restPart') {
            // remaining part
            range = [
                { row: [r1, range2.row[0] - 1], column: [c1, c2] },
                {
                    row: [range2.row[0], range2.row[1]],
                    column: [c1, range2.column[0] - 1],
                },
                {
                    row: [range2.row[0], range2.row[1]],
                    column: [range2.column[1] + 1, c2],
                },
                { row: [range2.row[1] + 1, r2], column: [c1, c2] },
            ];
        } else if (type === 'operatePart') {
            // operated part
            range = [
                {
                    row: [range2.row[0] + offset_r, range2.row[1] + offset_r],
                    column: [range2.column[0] + offset_c, range2.column[1] + offset_c],
                },
            ];
        }
    } else {
        // selection is outside the conditional format apply range

        if (type === 'allPart') {
            // all parts
            range = [{ row: [r1, r2], column: [c1, c2] }];
        } else if (type === 'restPart') {
            // remaining part
            range = [{ row: [r1, r2], column: [c1, c2] }];
        } else if (type === 'operatePart') {
            // operated part
            range = [];
        }
    }

    return range;
}
