// Conditional formats as the canvas and the HTML export draw them: a sheet's rules evaluated into each cell's colors
// and data bars. Beside the evaluator sit the rule edits a row op, a move or a paste makes, which keep a formula rule's
// anchor, and the shape check every reader of a stored rule asks first, since a peer can store anything.

import { hexChannels, parseRgb } from '@workspace/lib/constants/colors';
import { isRecord } from '@workspace/lib/guards';
import { isNil } from 'es-toolkit/compat';
import { cellValue, parseCellInput } from './format';
import type { FormulaEngine } from './formula-engine';
import { functionCopy } from './formula-shift';
import { matrixWidth } from './formula-utils';
import type { CellMatrix, CellResolver, CompiledFormula, ConditionalFormatRule, SingleRange } from './types';
import { isRealNull } from './validation';

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

// A rule runs at every cell of its ranges, so each formula parses once and resolves its relative refs at the cell's
// offset from the anchor.
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

function cellValueAt(data: CellMatrix, r: number, c: number) {
    return cellValue(data[r]?.[c]) ?? null;
}

// Excel resolves each style property by rule precedence, so a later rule that sets only a fill keeps the text color an
// earlier rule gave the cell. The xlsx importer emits rules in ascending precedence for this.
function applyCellStyle(map: ComputeMap, r: number, c: number, style: CellFormatStyle) {
    const key = `${r}_${c}`;
    const entry = (map[key] ??= {});
    if (style.textColor != null) entry.textColor = style.textColor;
    if (style.cellColor != null) entry.cellColor = style.cellColor;
    if (style.dataBar != null) entry.dataBar = style.dataBar;
}

type GridEnd = { lastRow: number; lastColumn: number };

// Clamped to the matrix because Excel writes a whole-column rule as A1:A1048576, and every visit costs a map entry.
function forEachCellInRanges(
    { lastRow, lastColumn }: GridEnd,
    ranges: SingleRange[],
    cb: (r: number, c: number) => void,
) {
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

// A stop's red, green and blue, read from a hex or an rgb(). Its alpha is dropped. isWellFormedCfRule keeps any
// stop that starts with '#', so a stop that is no hex color reads as black.
function parseColorChannels(color: string): [number, number, number] {
    const { red, green, blue } = hexChannels(parseRgb(color)?.hex ?? color, [3, 6, 8]) ?? { red: 0, green: 0, blue: 0 };
    return [red, green, blue];
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

// Each cell's colors and data bar, keyed by `${r}_${c}`. Without options.evaluateFormula a formula rule is skipped.
export function evaluateConditionalFormat(
    rules: ConditionalFormatRule[] | null | undefined,
    data: CellMatrix,
    options?: EvaluateConditionalFormatOptions,
): ComputeMap {
    const ruleArr = rules ?? [];
    const computeMap: ComputeMap = {};
    // Once per evaluation: finding the width walks every row, and a rule can hold thousands of ranges.
    const end = { lastRow: data.length - 1, lastColumn: matrixWidth(data) - 1 };

    for (const rule of ruleArr) {
        if (rule.type === 'dataBar') {
            const { cellrange, format } = rule;
            let max: number | null = null;
            let min: number | null = null;
            forEachCellInRanges(end, cellrange, (r, c) => {
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
                const maxNum = max;
                const minNum = min;
                if (minNum < 0) {
                    const plusLen = Math.round((maxNum / (maxNum - minNum)) * 10) / 10;
                    const minusLen = Math.round((Math.abs(minNum) / (maxNum - minNum)) * 10) / 10;

                    forEachCellInRanges(end, cellrange, (r, c) => {
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

                    forEachCellInRanges(end, cellrange, (r, c) => {
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
            forEachCellInRanges(end, cellrange, (r, c) => {
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
                const maxNum = max;
                const minNum = min;
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

                forEachCellInRanges(end, cellrange, (r, c) => {
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
        } else {
            const { cellrange, format, conditionName, conditionValue } = rule;
            const conditionValue0 = conditionValue[0];
            const conditionValue1 = conditionValue[1];
            const { textColor, cellColor } = format;
            // duplicateValue, top10 and the averages look at one range at a time.
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
                    // A dialog's threshold is a string. As in Excel, greater and less match only numbers, and equal
                    // compares numbers when both sides are numeric, else the exact text.
                    const threshold = Number(conditionValue0);
                    forEachCellInRanges(end, [range], (r, c) => {
                        const v = cellValue(data[r]?.[c]);
                        if (isNil(v) || isRealNull(v)) {
                            return;
                        }
                        let matches = false;
                        if (conditionName === 'greaterThan') {
                            matches = typeof v === 'number' && v > threshold;
                        } else if (conditionName === 'greaterThanOrEqual') {
                            matches = typeof v === 'number' && v >= threshold;
                        } else if (conditionName === 'lessThan') {
                            matches = typeof v === 'number' && v < threshold;
                        } else if (conditionName === 'lessThanOrEqual') {
                            matches = typeof v === 'number' && v <= threshold;
                        } else if (conditionName === 'equal') {
                            matches =
                                typeof v === 'number' && !Number.isNaN(threshold)
                                    ? v === threshold
                                    : v.toString() === conditionValue0;
                        } else if (conditionName === 'notEqual') {
                            matches =
                                typeof v === 'number' && !Number.isNaN(threshold)
                                    ? v !== threshold
                                    : v.toString() !== conditionValue0;
                        } else if (conditionName === 'textContains') {
                            matches = v.toString().toLowerCase().indexOf(String(conditionValue0).toLowerCase()) !== -1;
                        }
                        if (matches) {
                            applyCellStyle(computeMap, r, c, { textColor, cellColor });
                        }
                    });
                } else if (conditionName === 'between' || conditionName === 'notBetween') {
                    const v0 = Number(conditionValue0);
                    const v1 = Number(conditionValue1);
                    const vBig = Math.max(v0, v1);
                    const vSmall = Math.min(v0, v1);
                    forEachCellInRanges(end, [range], (r, c) => {
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
                    // A rule that takes no value stores an empty list.
                    const dates = String(conditionValue0);
                    let dBig: string;
                    let dSmall: string;
                    if (dates.indexOf('-') === -1) {
                        dBig = parseCellInput(dates)[2].toString();
                        dSmall = parseCellInput(dates)[2].toString();
                    } else {
                        const str = dates.split('-');
                        dBig = parseCellInput(str[1].trim())[2].toString();
                        dSmall = parseCellInput(str[0].trim())[2].toString();
                    }
                    forEachCellInRanges(end, [range], (r, c) => {
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
                    forEachCellInRanges(end, [range], (r, c) => {
                        const value = cellValueAt(data, r, c);
                        // Excel never highlights blanks, and these rules usually span a mostly empty column.
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
                    forEachCellInRanges(end, [range], (r, c) => {
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
                        const cSet = new Set(cArr);
                        forEachCellInRanges(end, [range], (r, c) => {
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
                        forEachCellInRanges(end, [range], (r, c) => {
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
                    const anchorRow = cellrange[0].row[0];
                    const anchorCol = cellrange[0].column[0];

                    const formulaSrc = String(conditionValue0);
                    const formulaTxt = formulaSrc.startsWith('=') ? formulaSrc : `=${formulaSrc}`;
                    forEachCellInRanges(end, [range], (r, c) => {
                        const raw = evaluateFormula(formulaTxt, anchorRow, anchorCol, r, c);
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

// Whether a stored rule has the shape the evaluator and withCfRanges read. No reader checks the rules a peer or a file
// stored, so every writer that reads them asks this first. Each range spans whole rows and columns in order. A rule's
// values are strings or numbers, its looks an object, and a scale's stops colors parseColorChannels reads.
export function isWellFormedCfRule(rule: ConditionalFormatRule | null): boolean {
    if (!isRecord(rule) || !Array.isArray(rule.cellrange) || rule.cellrange.length === 0) return false;
    if (!rule.cellrange.every((range) => isRecord(range) && isSpan(range.row) && isSpan(range.column))) return false;
    switch (rule.type) {
        case 'default':
            return (
                isRecord(rule.format) &&
                Array.isArray(rule.conditionValue) &&
                rule.conditionValue.every((value) => typeof value === 'string' || typeof value === 'number')
            );
        case 'dataBar':
            return Array.isArray(rule.format) && rule.format.every((color) => typeof color === 'string');
        case 'colorGradation':
            return (
                Array.isArray(rule.format) &&
                rule.format.every(
                    (color) => typeof color === 'string' && (color.startsWith('#') || parseRgb(color) !== undefined),
                )
            );
        default:
            return false;
    }
}

function isSpan(ends: unknown): boolean {
    return Array.isArray(ends) && ends.length === 2 && ends.every(Number.isInteger) && ends[0] <= ends[1];
}

// A formula rule reads relative to its first range's top-left, as in Excel, so moving that corner re-expresses the
// formula and every cell keeps its meaning. The shift is how far a row or column delete moved the new first range.
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

// What is left of a range once an area is taken out of it: the strips above, left, right and below the overlap.
export function rangeWithout(range: SingleRange, area: SingleRange): SingleRange[] {
    const [r1, r2] = range.row;
    const [c1, c2] = range.column;
    const top = Math.max(r1, area.row[0]);
    const bottom = Math.min(r2, area.row[1]);
    const left = Math.max(c1, area.column[0]);
    const right = Math.min(c2, area.column[1]);
    if (top > bottom || left > right) return [range];

    const rest: SingleRange[] = [];
    if (top > r1) rest.push({ row: [r1, top - 1], column: [c1, c2] });
    if (left > c1) rest.push({ row: [top, bottom], column: [c1, left - 1] });
    if (right < c2) rest.push({ row: [top, bottom], column: [right + 1, c2] });
    if (bottom < r2) rest.push({ row: [bottom + 1, r2], column: [c1, c2] });
    return rest;
}
