import { isNil } from 'es-toolkit/compat';
import { parseCellInput } from './format';
import type { FormulaEngine } from './formula-engine';
import { functionCopy } from './formula-shift';
import type { CellMatrix, CellResolver, CompiledFormula, ConditionalFormatRule, SingleRange } from './types';
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

// The evaluator both the canvas and the HTML export use. A rule runs at every cell of its range,
// so each formula parses once and resolves its relative refs at the cell's offset from the anchor.
export function createCfFormulaEvaluator(
    engine: FormulaEngine,
    resolver: CellResolver,
    sheetId: string,
): ConditionalFormatFormulaEvaluator {
    const compiled = new Map<string, CompiledFormula>();
    return (formula, anchorRow, anchorCol, targetRow, targetCol) => {
        let expression = compiled.get(formula);
        if (!expression) {
            expression = engine.compile(formula);
            compiled.set(formula, expression);
        }
        return engine.evaluateCompiled(expression, sheetId, resolver, targetRow - anchorRow, targetCol - anchorCol)
            .value;
    };
}

// Returns the cell's display value at (r, c). Mirrors the "v" attribute path of
// state-side getCellValue, simplified for the conditional-format evaluator.
function cellValueAt(data: CellMatrix, r: number, c: number) {
    return data[r]?.[c]?.v ?? null;
}

// Merge a partial cell style into the map, creating the entry if absent. The CF evaluator
// applies overlapping rules in order, so later rules layer onto earlier entries instead of
// overwriting them — matching canvas-painter behavior. Null/undefined fields are skipped:
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

// Clamped to the matrix because an xlsx sqref runs to row 1048576 (Excel writes a whole-column
// rule as A1:A1048576) and every visit costs a map entry; holes inside the matrix are still visited.
function forEachCellInRanges(data: CellMatrix, ranges: SingleRange[], cb: (r: number, c: number) => void) {
    const lastRow = data.length - 1;
    // The widest row, not row 0: the preview hands over a matrix whose leading rows are holes.
    let lastColumn = -1;
    for (const row of data) {
        if (row && row.length - 1 > lastColumn) lastColumn = row.length - 1;
    }
    for (const range of ranges) {
        const rowEnd = Math.min(range.row[1], lastRow);
        const columnEnd = Math.min(range.column[1], lastColumn);
        for (let r = range.row[0]; r <= rowEnd; r += 1) {
            for (let c = range.column[0]; c <= columnEnd; c += 1) {
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

function getColorGradation(color1: string, color2: string, value1: number, value2: number, value: number) {
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
        if (rule.type === 'dataBar') {
            const { cellrange, format } = rule;
            let max: number | null = null;
            let min: number | null = null;
            forEachCellInRanges(data, cellrange, (r, c) => {
                const cell = data[r]?.[c];
                if (isNil(cell) || isNil(cell.ct) || cell.ct.t !== 'n' || isNil(cell.v)) {
                    return;
                }
                const numVal = Number(cell.v);
                if (isNil(max) || numVal > max) {
                    max = numVal;
                }

                if (isNil(min) || numVal < min) {
                    min = numVal;
                }
            });
            if (!isNil(max) && !isNil(min)) {
                // Narrowed rebinds — the apply callbacks below close over them.
                const maxNum = max;
                const minNum = min;
                if (minNum < 0) {
                    const plusLen = Math.round((maxNum / (maxNum - minNum)) * 10) / 10; // proportion of positive numbers
                    const minusLen = Math.round((Math.abs(minNum) / (maxNum - minNum)) * 10) / 10; // proportion of negative numbers

                    forEachCellInRanges(data, cellrange, (r, c) => {
                        const cell = data[r]?.[c];
                        if (isNil(cell) || isNil(cell.ct) || cell.ct.t !== 'n' || isNil(cell.v)) {
                            return;
                        }

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
                    });
                } else {
                    const plusLen = 1;

                    forEachCellInRanges(data, cellrange, (r, c) => {
                        const cell = data[r]?.[c];
                        if (isNil(cell) || isNil(cell.ct) || cell.ct.t !== 'n' || isNil(cell.v)) {
                            return;
                        }

                        const valueLen = maxNum === 0 ? 1 : Math.round((Number(cell.v) / maxNum) * 100) / 100;
                        applyCellStyle(computeMap, r, c, {
                            dataBar: { valueType: 'plus', plusLen, minusLen: 0, valueLen, format },
                        });
                    });
                }
            }
        } else if (rule.type === 'colorGradation') {
            const { cellrange, format } = rule;
            let max: number | null = null;
            let min: number | null = null;
            let sum = 0;
            let count = 0;
            forEachCellInRanges(data, cellrange, (r, c) => {
                const cell = data[r]?.[c];
                if (isNil(cell) || isNil(cell.ct) || cell.ct.t !== 'n' || isNil(cell.v)) {
                    return;
                }

                const numVal = Number(cell.v);
                count += 1;
                sum += numVal;

                if (isNil(max) || numVal > max) {
                    max = numVal;
                }

                if (isNil(min) || numVal < min) {
                    min = numVal;
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

                forEachCellInRanges(data, cellrange, (r, c) => {
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
            // Per-range on purpose: duplicateValue's dmap and top10/average's dArr are scoped to a single range.
            for (const range of cellrange) {
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
                    forEachCellInRanges(data, [range], (r, c) => {
                        const cell = data[r]?.[c];
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
                            // Excel's "Text that contains" ignores case, and the xlsx importer
                            // maps containsText onto this rule.
                            matches =
                                cell.v.toString().toLowerCase().indexOf(String(conditionValue0).toLowerCase()) !== -1;
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
                    forEachCellInRanges(data, [range], (r, c) => {
                        const cell = data[r]?.[c];
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
                        dBig = parseCellInput(conditionValue0)[2].toString();
                        dSmall = parseCellInput(conditionValue0)[2].toString();
                    } else {
                        const str = conditionValue0.toString().split('-');
                        dBig = parseCellInput(str[1].trim())[2].toString();
                        dSmall = parseCellInput(str[0].trim())[2].toString();
                    }
                    forEachCellInRanges(data, [range], (r, c) => {
                        const cell = data[r]?.[c];
                        if (isNil(cell) || isNil(cell.ct) || cell.ct.t !== 'd') {
                            return;
                        }
                        const cellVal = cellValueAt(data, r, c);
                        if (cellVal != null && cellVal >= dSmall && cellVal <= dBig) {
                            applyCellStyle(computeMap, r, c, { textColor, cellColor });
                        }
                    });
                } else if (conditionName === 'duplicateValue') {
                    const dmap: Record<string, { r: number; c: number }[]> = {};
                    forEachCellInRanges(data, [range], (r, c) => {
                        const value = cellValueAt(data, r, c);
                        // Excel's Duplicate Values never highlights blanks, and these rules are
                        // normally drawn over a whole column of mostly empty cells.
                        if (isRealNull(value)) {
                            return;
                        }
                        const item = String(value);
                        if (!(item in dmap)) {
                            dmap[item] = [];
                        }
                        dmap[item].push({ r, c });
                    });
                    if (conditionValue0 === '0') {
                        for (const cells of Object.values(dmap)) {
                            if (cells.length > 1) {
                                for (const { r, c } of cells) {
                                    applyCellStyle(computeMap, r, c, { textColor, cellColor });
                                }
                            }
                        }
                    } else if (conditionValue0 === '1') {
                        for (const cells of Object.values(dmap)) {
                            if (cells.length === 1) {
                                applyCellStyle(computeMap, cells[0].r, cells[0].c, { textColor, cellColor });
                            }
                        }
                    }
                } else if (
                    conditionName === 'top10' ||
                    conditionName === 'top10_percent' ||
                    conditionName === 'last10' ||
                    conditionName === 'last10_percent' ||
                    conditionName === 'aboveAverage' ||
                    conditionName === 'belowAverage'
                ) {
                    const dArr: number[] = [];
                    forEachCellInRanges(data, [range], (r, c) => {
                        const cell = data[r]?.[c];
                        if (isNil(cell) || isNil(cell.ct) || cell.ct.t !== 'n') {
                            return;
                        }
                        dArr.push(Number(cellValueAt(data, r, c)));
                    });
                    if (
                        conditionName === 'top10' ||
                        conditionName === 'top10_percent' ||
                        conditionName === 'last10' ||
                        conditionName === 'last10_percent'
                    ) {
                        dArr.sort((a, b) => b - a);

                        // form input arrives as string; coerce once for arithmetic / slice
                        const n = Number(conditionValue0);
                        let cArr: number[] = [];
                        if (conditionName === 'top10') {
                            cArr = dArr.slice(0, n);
                        } else if (conditionName === 'top10_percent') {
                            cArr = dArr.slice(0, Math.floor((n * dArr.length) / 100));
                        } else if (conditionName === 'last10') {
                            cArr = dArr.slice(dArr.length - n, dArr.length);
                        } else if (conditionName === 'last10_percent') {
                            cArr = dArr.slice(dArr.length - Math.floor((n * dArr.length) / 100), dArr.length);
                        }
                        // Membership set — O(1) per-cell lookup instead of indexOf's O(n) scan.
                        const cSet = new Set(cArr);
                        forEachCellInRanges(data, [range], (r, c) => {
                            if (isNil(data[r]?.[c])) {
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
                        forEachCellInRanges(data, [range], (r, c) => {
                            if (isNil(data[r]?.[c])) {
                                return;
                            }
                            if (matches(Number(cellValueAt(data, r, c)))) {
                                applyCellStyle(computeMap, r, c, { textColor, cellColor });
                            }
                        });
                    }
                } else if (conditionName === 'formula' && options?.evaluateFormula) {
                    const { evaluateFormula } = options;
                    // Excel's anchor: every range reads relative to the first range's top-left, even where the scan clamps it.
                    const str = cellrange[0].row[0];
                    const stc = cellrange[0].column[0];

                    const formulaSrc = String(conditionValue0);
                    const formulaTxt = formulaSrc.startsWith('=') ? formulaSrc : `=${formulaSrc}`;
                    forEachCellInRanges(data, [range], (r, c) => {
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

// A formula rule reads relative to its first range's top-left, so moving that corner re-expresses the formula and
// every cell keeps its meaning. The shift is how far a row/column delete moved the new first range.
export function withCfRanges(
    rule: ConditionalFormatRule,
    cellrange: SingleRange[],
    rowShift = 0,
    columnShift = 0,
): ConditionalFormatRule {
    if (
        rule.type !== 'default' ||
        rule.conditionName !== 'formula' ||
        rule.cellrange.length === 0 ||
        cellrange.length === 0
    ) {
        return { ...rule, cellrange };
    }
    const rowOffset = cellrange[0].row[0] - rowShift - rule.cellrange[0].row[0];
    const columnOffset = cellrange[0].column[0] - columnShift - rule.cellrange[0].column[0];
    if (rowOffset === 0 && columnOffset === 0) return { ...rule, cellrange };
    return {
        ...rule,
        cellrange,
        conditionValue: [`=${functionCopy(String(rule.conditionValue[0]), rowOffset, columnOffset)}`],
    };
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
