import { forEach, isNil } from 'es-toolkit/compat';
import { genarate } from './format';
import type { CellMatrix, ConditionalFormatRule, SingleRange } from './types';
import { isRealNull } from './validation';

// CF rule shapes (`ConditionalFormatRule`, `DataBarRule`, etc.) are defined in
// `@workspace/lib/sheets` since they live on `Sheet.conditionalFormatRules`
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
// overwriting them — matching canvas-painter behaviour. Null/undefined fields are skipped:
// a later rule that sets only a fill must not erase the text color an earlier rule
// contributed (Excel resolves each style property independently by rule precedence, and
// the xlsx importer relies on this by emitting rules in ascending-precedence order).
function applyCellStyle(map: ComputeMap, r: number, c: number, style: CellFormatStyle) {
    const key = `${r}_${c}`;
    const entry = map[key] ?? (map[key] = {});
    if (style.textColor != null) entry.textColor = style.textColor;
    if (style.cellColor != null) entry.cellColor = style.cellColor;
    if (style.dataBar != null) entry.dataBar = style.dataBar;
}

// Shared scan scaffolding for the CF evaluator: visits EVERY coordinate of
// every range in order (range, then row, then column, ascending). No cell
// filtering — each branch keeps its own guards, and some (duplicateValue,
// formula) rely on visiting missing cells.
function forEachCellInRanges(ranges: SingleRange[], cb: (r: number, c: number) => void) {
    for (const range of ranges) {
        for (let r = range.row[0]; r <= range.row[1]; r += 1) {
            for (let c = range.column[0]; c <= range.column[1]; c += 1) {
                cb(r, c);
            }
        }
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
            let max: number | null = null;
            let min: number | null = null;
            forEachCellInRanges(cellrange, (r, c) => {
                if (isNil(data[r]) || isNil(data[r][c])) {
                    return;
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
            });
            if (!isNil(max) && !isNil(min)) {
                // Narrowed rebinds — the apply callbacks below close over them.
                const maxNum = max;
                const minNum = min;
                if (minNum < 0) {
                    // selection range contains negative numbers
                    const plusLen = Math.round((maxNum / (maxNum - minNum)) * 10) / 10; // proportion of positive numbers
                    const minusLen = Math.round((Math.abs(minNum) / (maxNum - minNum)) * 10) / 10; // proportion of negative numbers

                    forEachCellInRanges(cellrange, (r, c) => {
                        if (isNil(data[r]) || isNil(data[r][c])) {
                            return;
                        }

                        const cell = data[r][c];

                        if (!isNil(cell) && !isNil(cell.ct) && cell.ct.t === 'n' && !isNil(cell.v)) {
                            if (Number(cell.v) < 0) {
                                const valueLen = Math.round((Math.abs(Number(cell.v)) / Math.abs(minNum)) * 100) / 100;
                                applyCellStyle(computeMap, r, c, {
                                    dataBar: { valueType: 'minus', minusLen, valueLen, format },
                                });
                            }

                            if (Number(cell.v) > 0) {
                                const valueLen = Math.round((Number(cell.v) / maxNum) * 100) / 100;
                                applyCellStyle(computeMap, r, c, {
                                    dataBar: { valueType: 'plus', plusLen, minusLen, valueLen, format },
                                });
                            }
                        }
                    });
                } else {
                    const plusLen = 1;

                    forEachCellInRanges(cellrange, (r, c) => {
                        if (isNil(data[r]) || isNil(data[r][c])) {
                            return;
                        }

                        const cell = data[r][c];

                        if (!isNil(cell) && !isNil(cell.ct) && cell.ct.t === 'n' && !isNil(cell.v)) {
                            const valueLen = maxNum === 0 ? 1 : Math.round((Number(cell.v) / maxNum) * 100) / 100;
                            applyCellStyle(computeMap, r, c, {
                                dataBar: { valueType: 'plus', plusLen, minusLen: 0, valueLen, format },
                            });
                        }
                    });
                }
            }
        } else if (rule.type === 'colorGradation') {
            // color scale
            const { cellrange, format } = rule;
            let max: number | null = null;
            let min: number | null = null;
            let sum = 0;
            let count = 0;
            forEachCellInRanges(cellrange, (r, c) => {
                if (isNil(data[r]) || isNil(data[r][c])) {
                    return;
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
            });
            if (!isNil(max) && !isNil(min) && (format.length === 2 || format.length === 3)) {
                // Narrowed rebinds — stopFor and the apply callback close over them.
                const maxNum = max;
                const minNum = min;
                // Per-cell color picker — interpolates between max/min (2-color) or
                // max/avg/min (3-color) stops. Returns null for cells outside the
                // bracketed range, mirroring the original branch behavior.
                const avg = format.length === 3 ? Math.floor(sum / count) : 0;
                const stopFor = (numVal: number): string | null => {
                    if (format.length === 3) {
                        if (numVal === minNum) return format[2];
                        if (numVal < avg) return getColorGradation(format[2], format[1], minNum, avg, numVal);
                        if (numVal === avg) return format[1];
                        if (numVal < maxNum) return getColorGradation(format[1], format[0], avg, maxNum, numVal);
                        if (numVal === maxNum) return format[0];
                        return null;
                    }
                    if (numVal === minNum) return format[1];
                    if (numVal < maxNum) return getColorGradation(format[1], format[0], minNum, maxNum, numVal);
                    if (numVal === maxNum) return format[0];
                    return null;
                };

                forEachCellInRanges(cellrange, (r, c) => {
                    const cell = data[r]?.[c];
                    if (isNil(cell) || isNil(cell.ct) || cell.ct.t !== 'n' || isNil(cell.v)) {
                        return;
                    }
                    const cellColor = stopFor(Number(cell.v));
                    if (cellColor !== null) {
                        applyCellStyle(computeMap, r, c, { cellColor });
                    }
                });
            }
        } else if (rule.type === 'icons') {
            // icon set — not yet implemented
        } else {
            // 'default' — comparison / aggregation / formula rules
            const { cellrange, format, conditionName, conditionValue } = rule;
            const conditionValue0 = conditionValue[0];
            const conditionValue1 = conditionValue[1];
            const { textColor, cellColor } = format;
            // Per-range on purpose: duplicateValue's dmap, top10/average's dArr and
            // the formula anchor are all scoped to a single range.
            for (const range of cellrange) {
                // check condition type
                if (
                    conditionName === 'greaterThan' ||
                    conditionName === 'greaterThanOrEqual' ||
                    conditionName === 'lessThan' ||
                    conditionName === 'lessThanOrEqual' ||
                    conditionName === 'equal' ||
                    conditionName === 'notEqual' ||
                    conditionName === 'textContains'
                ) {
                    // Coerce the threshold once — form input arrives as string. Ordering rules
                    // (greater/less) only match numeric cells; equal/notEqual compare numerically
                    // when both sides are numeric, else fall back to exact string comparison.
                    // Matches Excel/Google, mirroring the `between` branch below.
                    const threshold = Number(conditionValue0);
                    // iterate over apply range and evaluate
                    forEachCellInRanges([range], (r, c) => {
                        if (isNil(data[r]) || isNil(data[r][c])) {
                            return;
                        }
                        // cell value
                        const cell = data[r][c];
                        if (isNil(cell) || isNil(cell.v) || isRealNull(cell.v)) {
                            return;
                        }
                        let matches = false;
                        if (conditionName === 'greaterThan') {
                            matches = typeof cell.v === 'number' && cell.v > threshold;
                        } else if (conditionName === 'greaterThanOrEqual') {
                            matches = typeof cell.v === 'number' && cell.v >= threshold;
                        } else if (conditionName === 'lessThan') {
                            matches = typeof cell.v === 'number' && cell.v < threshold;
                        } else if (conditionName === 'lessThanOrEqual') {
                            matches = typeof cell.v === 'number' && cell.v <= threshold;
                        } else if (conditionName === 'equal') {
                            matches =
                                typeof cell.v === 'number' && !Number.isNaN(threshold)
                                    ? cell.v === threshold
                                    : cell.v.toString() === conditionValue0;
                        } else if (conditionName === 'notEqual') {
                            matches =
                                typeof cell.v === 'number' && !Number.isNaN(threshold)
                                    ? cell.v !== threshold
                                    : cell.v.toString() !== conditionValue0;
                        } else if (conditionName === 'textContains') {
                            matches = cell.v.toString().indexOf(String(conditionValue0)) !== -1;
                        }
                        if (matches) {
                            applyCellStyle(computeMap, r, c, { textColor, cellColor });
                        }
                    });
                } else if (conditionName === 'between' || conditionName === 'notBetween') {
                    // Coerce to number — both variants only compare against numeric cell values
                    // (`typeof cell.v === 'number'` guard below) and form input arrives as string.
                    const v0 = Number(conditionValue0);
                    const v1 = Number(conditionValue1);
                    const vBig = Math.max(v0, v1);
                    const vSmall = Math.min(v0, v1);
                    // iterate over apply range and evaluate
                    forEachCellInRanges([range], (r, c) => {
                        if (isNil(data[r]) || isNil(data[r][c])) {
                            return;
                        }
                        // cell value
                        const cell = data[r][c];
                        if (isNil(cell) || isNil(cell.v) || isRealNull(cell.v) || typeof cell.v !== 'number') {
                            return;
                        }
                        const within = cell.v >= vSmall && cell.v <= vBig;
                        if (conditionName === 'between' ? within : !within) {
                            applyCellStyle(computeMap, r, c, { textColor, cellColor });
                        }
                    });
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
                    forEachCellInRanges([range], (r, c) => {
                        if (isNil(data[r]) || isNil(data[r][c])) {
                            return;
                        }
                        if (!isNil(data[r][c]) && !isNil(data[r][c]!.ct) && data[r][c]!.ct!.t === 'd') {
                            const cellVal = cellValueAt(data, r, c);
                            if (cellVal != null && cellVal >= dSmall && cellVal <= dBig) {
                                applyCellStyle(computeMap, r, c, { textColor, cellColor });
                            }
                        }
                    });
                } else if (conditionName === 'duplicateValue') {
                    // process cells in apply range
                    const dmap: Record<string, { r: number; c: number }[]> = {};
                    forEachCellInRanges([range], (r, c) => {
                        const item = String(cellValueAt(data, r, c));
                        if (!(item in dmap)) {
                            dmap[item] = [];
                        }
                        dmap[item].push({ r, c });
                    });
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
                    forEachCellInRanges([range], (r, c) => {
                        if (isNil(data[r]) || isNil(data[r][c])) {
                            return;
                        }

                        // cell value type is numeric
                        if (!isNil(data[r][c]) && !isNil(data[r][c]!.ct) && data[r][c]!.ct!.t === 'n') {
                            dArr.push(Number(cellValueAt(data, r, c)));
                        }
                    });
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
                        let cArr: number[] = [];
                        if (conditionName === 'top10') {
                            cArr = dArr.slice(0, n); // top n items
                        } else if (conditionName === 'top10_percent') {
                            cArr = dArr.slice(0, Math.floor((n * dArr.length) / 100)); // top n% items
                        } else if (conditionName === 'last10') {
                            cArr = dArr.slice(dArr.length - n, dArr.length); // bottom n items
                        } else if (conditionName === 'last10_percent') {
                            cArr = dArr.slice(dArr.length - Math.floor((n * dArr.length) / 100), dArr.length); // bottom n% items
                        }
                        // Membership set — O(1) per-cell lookup instead of indexOf's O(n) scan.
                        const cSet = new Set(cArr);
                        // iterate over apply range and evaluate
                        forEachCellInRanges([range], (r, c) => {
                            if (isNil(data[r]) || isNil(data[r][c])) {
                                return;
                            }

                            const cellVal = Number(cellValueAt(data, r, c));
                            if (cSet.has(cellVal)) {
                                applyCellStyle(computeMap, r, c, { textColor, cellColor });
                            }
                        });
                    } else if (conditionName === 'aboveAverage' || conditionName === 'belowAverage') {
                        const averageNum = dArr.reduce((acc, n) => acc + n, 0) / dArr.length;
                        const matches = (n: number) =>
                            conditionName === 'aboveAverage' ? n > averageNum : n < averageNum;
                        forEachCellInRanges([range], (r, c) => {
                            if (isNil(data[r]) || isNil(data[r][c])) {
                                return;
                            }
                            if (matches(Number(cellValueAt(data, r, c)))) {
                                applyCellStyle(computeMap, r, c, { textColor, cellColor });
                            }
                        });
                    }
                } else if (conditionName === 'formula' && options?.evaluateFormula) {
                    const { evaluateFormula } = options;
                    // anchor = this range's top-left corner
                    const str = range.row[0];
                    const stc = range.column[0];

                    const formulaSrc = String(conditionValue0);
                    const formulaTxt = formulaSrc.startsWith('=') ? formulaSrc : `=${formulaSrc}`;
                    // Clamp to the last materialized row before iterating. An xlsx sqref routinely
                    // runs far past the used range, and every evaluation costs a ref-shift plus a
                    // full formula parse — on a real workbook two thirds of them landed on rows
                    // that don't exist. Rows only: `data.length` is an exact bound, while a ragged
                    // matrix has no single column extent, and unlike the value-comparing branches
                    // this one intentionally evaluates cells the matrix doesn't hold (a formula
                    // rule may style an empty cell). The anchor stays the original top-left.
                    const bounded = {
                        row: [range.row[0], Math.min(range.row[1], data.length - 1)],
                        column: range.column,
                    };
                    forEachCellInRanges([bounded], (r, c) => {
                        const raw = evaluateFormula(formulaTxt, str, stc, r, c);
                        const v = typeof raw === 'boolean' ? raw : !!Number(raw);
                        if (v) {
                            applyCellStyle(computeMap, r, c, { textColor, cellColor });
                        }
                    });
                }
            }
        }
    }
    return computeMap;
}

// Which slice of the split cfSplitRange returns: the parts that stay put, the
// part that moves with the operate range, or both.
export type CfSplitRangeType = 'allPart' | 'restPart' | 'operatePart';

export function cfSplitRange(
    range1: SingleRange,
    range2: SingleRange,
    range3: SingleRange,
    type: CfSplitRangeType,
): SingleRange[] {
    if (type !== 'allPart' && type !== 'restPart' && type !== 'operatePart') {
        // Callers are compile-time narrowed, but state-layer code passes untyped
        // values; a typo must fail loudly rather than silently drop every CF range.
        throw new Error(`cfSplitRange: unknown type "${type}"`);
    }

    const offset_r = range3.row[0] - range2.row[0];
    const offset_c = range3.column[0] - range2.column[0];

    const r1 = range1.row[0];
    const r2 = range1.row[1];
    const c1 = range1.column[0];
    const c2 = range1.column[1];

    // Intersection of range1 (CF apply range) with range2 (operate/selection).
    const ir1 = Math.max(r1, range2.row[0]);
    const ir2 = Math.min(r2, range2.row[1]);
    const ic1 = Math.max(c1, range2.column[0]);
    const ic2 = Math.min(c2, range2.column[1]);

    if (ir1 > ir2 || ic1 > ic2) {
        // No overlap: range1 stays put in full, nothing operates.
        if (type === 'operatePart') return [];
        return [{ row: [r1, r2], column: [c1, c2] }];
    }

    // range1 minus the intersection, emitted as strips in a fixed order — top and
    // bottom span the full width; left and right are clamped to the intersection's
    // row band. Empty strips are skipped. (Reproduces the old 16-branch pyramid.)
    const restPart: SingleRange[] = [];
    if (ir1 > r1) restPart.push({ row: [r1, ir1 - 1], column: [c1, c2] }); // top
    if (ic1 > c1) restPart.push({ row: [ir1, ir2], column: [c1, ic1 - 1] }); // left
    if (ic2 < c2) restPart.push({ row: [ir1, ir2], column: [ic2 + 1, c2] }); // right
    if (ir2 < r2) restPart.push({ row: [ir2 + 1, r2], column: [c1, c2] }); // bottom

    if (type === 'restPart') return restPart;

    // The intersection, shifted with the operate range to its destination.
    const operate: SingleRange = {
        row: [ir1 + offset_r, ir2 + offset_r],
        column: [ic1 + offset_c, ic2 + offset_c],
    };

    if (type === 'operatePart') return [operate];
    return [...restPart, operate];
}
