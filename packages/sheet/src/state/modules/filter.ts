// A sheet's autofilter: one range whose header row has a button on every column. This module
// builds the buttons' rects, which the canvas paints and the mousedown hit test reads, creates and
// clears the filter, and sorts its rows. It also gives the filter menu what it shows, such as a
// column's values, dates and colors and the conditions it offers, and saves the rows a choice hides.

import { numberDisplay } from '@workspace/formula/format';
import { cloneDeep } from 'es-toolkit/compat';
import { cellDisplay, cellValue, parseCellInput } from '../../engine/format';
import { showFilterRows } from '../../engine/rowcol';
import type { Cell } from '../../engine/types';
import { getSheet } from '../api/common';
import type { Context } from '../context';
import { getFlowdata, getSheetConfig } from '../context';
import type { FilterCondition, FilterConditionName, FilterOptions, Selection } from '../types';
import { rgbToHex } from '../utils';
import { normalizedAttr } from './cell';
import { checkCF, getComputeMap } from './condition-format';
import { normalizeSelection } from './selection';
import { sortDataRange } from './sort';
import { isRealNull, isRealNum } from './validation';

// Sorts the rows below the header row by column col. Returns the message to show when a merge blocks it.
export function sortFilterRange(
    ctx: Context,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    col: number,
    asc: boolean,
) {
    const d = getFlowdata(ctx);
    if (d == null) return null;

    for (let r = startRow + 1; r <= endRow; r += 1) {
        for (let c = startCol; c <= endCol; c += 1) {
            if (d[r][c]?.mc != null) {
                return 'There are merged cells in the filter selection, this operation cannot be performed!';
            }
        }
    }

    sortDataRange(ctx, { row: [startRow + 1, endRow], column: [startCol, endCol] }, col - startCol, asc);
    return null;
}

// A column narrower than the button gets one as wide as the column, so it never reaches over its neighbor's.
const FILTER_BUTTON_WIDTH = 20;
const FILTER_BUTTON_HEIGHT = 15;

// x and y are freeze-corrected sheet coordinates, as the mouse handlers produce them.
export function getFilterButtonAtPosition(ctx: Context, x: number, y: number) {
    return ctx.filterOptions?.items.find(
        (item) => x >= item.left && x < item.left + item.width && y >= item.top && y < item.top + item.height,
    );
}

// The current sheet's filter range as border and button rects, in sheet coordinates. Every canvas pass and every
// mouse move reads them, so deriveView builds them once, when the range or the grid geometry changes.
export function createFilterOptions(ctx: Context) {
    delete ctx.filterOptions;
    if (ctx.allowEdit === false) return;
    const sheet = ctx.sheets.find(({ id }) => id === ctx.currentSheetId);
    const filterRange = sheet?.filterRange;
    if (!filterRange) return;

    // An imported range can reach past the grid and is stored as it is; the view is clamped because the scans read flowdata[r].
    const lastRow = (sheet.data?.length ?? 0) - 1;
    const lastCol = ctx.visibledatacolumn.length - 1;
    const r1 = filterRange.row[0];
    const r2 = Math.min(filterRange.row[1], lastRow);
    const c1 = filterRange.column[0];
    const c2 = Math.min(filterRange.column[1], lastCol);
    if (r1 > r2 || c1 > c2) return;

    const bottom = ctx.visibledatarow[r2] ?? 0;
    const top = r1 === 0 ? 0 : (ctx.visibledatarow[r1 - 1] ?? 0);
    const right = ctx.visibledatacolumn[c2] ?? 0;
    const left = c1 === 0 ? 0 : (ctx.visibledatacolumn[c1 - 1] ?? 0);
    const options: FilterOptions = {
        startRow: r1,
        endRow: r2,
        startCol: c1,
        endCol: c2,
        left,
        top,
        width: right - left - 1,
        height: bottom - top - 1,
        items: [],
    };

    const colhidden = sheet.config?.colhidden;
    for (let c = c1; c <= c2; c += 1) {
        // A hidden column is zero-width, so it has no room for a button.
        if (colhidden?.[c] != null) continue;

        const colStart = c === 0 ? 0 : ctx.visibledatacolumn[c - 1];
        const colEnd = ctx.visibledatacolumn[c];
        const buttonLeft = Math.max(colEnd - FILTER_BUTTON_WIDTH, colStart);
        options.items.push({ col: c, left: buttonLeft, top, width: colEnd - buttonLeft, height: FILTER_BUTTON_HEIGHT });
    }

    ctx.filterOptions = options;
}

export function clearFilter(ctx: Context) {
    if (ctx.allowEdit === false) return;
    const sheet = getSheet(ctx);
    ctx.filterContextMenu = undefined;
    // Delete in place: a fresh object would replace the whole rowhidden map on the wire.
    const rowhidden = sheet.config?.rowhidden;
    if (rowhidden) showFilterRows(rowhidden, Object.values(sheet.filter ?? {}));
    sheet.filter = undefined;
    sheet.filterRange = undefined;
}

// Toggles the filter: clears the one there is, else filters the selection. A single cell widens to the first run of
// filled cells in its row.
export function createFilter(ctx: Context) {
    if (ctx.allowEdit === false) return;
    if ((ctx.selections?.length ?? 0) > 1) return;
    const sheet = getSheet(ctx);
    if (sheet.filterRange) {
        clearFilter(ctx);
        return;
    }

    const last = ctx.selections?.[0];
    const flowdata = getFlowdata(ctx);
    let filterSave: Selection[] | undefined;
    if (last == null || flowdata == null) return;
    if (last.row[0] === last.row[1] && last.column[0] === last.column[1]) {
        let startCol: number | undefined;
        let endCol: number | undefined;
        const curR = last.row[1];

        for (let c = 0; c < flowdata[curR].length; c += 1) {
            if (!isRealNull(cellValue(flowdata[curR][c]))) {
                startCol ??= c;
            } else if (startCol != null) {
                endCol = c - 1;
                break;
            }
        }
        endCol ??= flowdata[curR].length - 1;

        filterSave = normalizeSelection(ctx, [{ row: [curR, curR], column: [startCol ?? 0, endCol] }]);
        ctx.selections = filterSave;

        ctx.shiftAnchor = cloneDeep(last);
    } else if (last.row[1] - last.row[0] < 2) {
        ctx.shiftAnchor = cloneDeep(last);
    }

    sheet.filterRange = cloneDeep(filterSave?.[0] || ctx.selections?.[0]);
}

export type FilterDate = {
    key: string;
    type: string;
    value: string;
    text: string;
    rows: number[];
    dateValues: string[];
    children: FilterDate[];
};

export type FilterValue = {
    key: string;
    value: Cell['v'] | null;
    mask: Cell['v'] | null;
    text: string;
    rows: number[];
};

function getFilterHiddenRows(ctx: Context, col: number, startCol: number) {
    const filter = getSheet(ctx).filter ?? {};
    const otherHiddenRows: Record<string, number> = {};
    for (const entry of Object.values(filter)) {
        if (entry.cindex !== col) Object.assign(otherHiddenRows, entry.rowhidden);
    }
    return { otherHiddenRows, hiddenRows: filter[col - startCol]?.rowhidden ?? {} };
}

// The filter menu's conditions in menu order; arity is the number of operand inputs a condition needs.
export const FILTER_CONDITION_ITEMS: {
    name: FilterConditionName;
    label: string;
    arity: 0 | 1 | 2;
}[] = [
    { name: 'isEmpty', label: 'Is empty', arity: 0 },
    { name: 'isNotEmpty', label: 'Is not empty', arity: 0 },
    { name: 'textContains', label: 'Text contains', arity: 1 },
    { name: 'textNotContains', label: 'Text does not contain', arity: 1 },
    { name: 'textStartsWith', label: 'Text starts with', arity: 1 },
    { name: 'textEndsWith', label: 'Text ends with', arity: 1 },
    { name: 'textEquals', label: 'Text is exactly', arity: 1 },
    { name: 'dateEqual', label: 'Date is', arity: 1 },
    { name: 'dateBefore', label: 'Date is before', arity: 1 },
    { name: 'dateAfter', label: 'Date is after', arity: 1 },
    { name: 'greaterThan', label: 'Greater than', arity: 1 },
    { name: 'greaterThanOrEqual', label: 'Greater than or equal to', arity: 1 },
    { name: 'lessThan', label: 'Less than', arity: 1 },
    { name: 'lessThanOrEqual', label: 'Less than or equal to', arity: 1 },
    { name: 'equal', label: 'Is equal to', arity: 1 },
    { name: 'notEqual', label: 'Is not equal to', arity: 1 },
    { name: 'between', label: 'Is between', arity: 2 },
    { name: 'notBetween', label: 'Is not between', arity: 2 },
];

// Unknown names (a snapshot written by a newer client) report arity 0.
export function filterConditionArity(name: FilterConditionName): 0 | 1 | 2 {
    return FILTER_CONDITION_ITEMS.find((item) => item.name === name)?.arity ?? 0;
}

// Numeric when both sides parse as numbers, a case-insensitive string compare otherwise.
function compareFilterValues(cellValue: string, input: string): number {
    if (isRealNum(cellValue) && isRealNum(input)) {
        const a = Number(cellValue);
        const b = Number(input);
        return a < b ? -1 : a > b ? 1 : 0;
    }
    const a = cellValue.toLowerCase();
    const b = input.toLowerCase();
    return a < b ? -1 : a > b ? 1 : 0;
}

function toIsoDay(input: string): string | null {
    const [, ct, v] = parseCellInput(input);
    if (ct.t !== 'd') return null;
    return numberDisplay(v, 'YYYY-MM-DD');
}

// A blank cell matches only isEmpty and the negative conditions, as each negative is its positive's complement.
// An incomplete condition, such as a blank operand or an unparseable date, filters nothing.
export function buildFilterConditionMatcher(condition: FilterCondition): (cell: Cell | null | undefined) => boolean {
    const { conditionName, values } = condition;
    const arity = filterConditionArity(conditionName);
    for (let i = 0; i < arity; i += 1) {
        if (isRealNull(values[i])) return () => true;
    }

    const needle = arity > 0 ? values[0].toLowerCase() : '';

    if (conditionName === 'dateEqual' || conditionName === 'dateBefore' || conditionName === 'dateAfter') {
        const day = toIsoDay(values[0]);
        if (day == null) return () => true;
        return (cell) => {
            if (cell == null || cell.ct?.t !== 'd' || isRealNull(cell.v)) return false;
            const cellDay = numberDisplay(cell.v, 'YYYY-MM-DD');
            if (conditionName === 'dateEqual') return cellDay === day;
            if (conditionName === 'dateBefore') return cellDay < day;
            return cellDay > day;
        };
    }

    return (cell) => {
        const value = cellValue(cell);
        const blank = cell == null || isRealNull(value);
        const display = blank ? '' : `${cellDisplay(cell)}`.toLowerCase();
        const raw = blank ? '' : `${value}`;

        switch (conditionName) {
            case 'isEmpty':
                return blank;
            case 'isNotEmpty':
                return !blank;
            case 'textContains':
                return !blank && display.includes(needle);
            case 'textNotContains':
                return blank || !display.includes(needle);
            case 'textStartsWith':
                return !blank && display.startsWith(needle);
            case 'textEndsWith':
                return !blank && display.endsWith(needle);
            case 'textEquals':
                return !blank && display === needle;
            case 'greaterThan':
                return !blank && compareFilterValues(raw, values[0]) > 0;
            case 'greaterThanOrEqual':
                return !blank && compareFilterValues(raw, values[0]) >= 0;
            case 'lessThan':
                return !blank && compareFilterValues(raw, values[0]) < 0;
            case 'lessThanOrEqual':
                return !blank && compareFilterValues(raw, values[0]) <= 0;
            case 'equal':
                return !blank && compareFilterValues(raw, values[0]) === 0;
            case 'notEqual':
                return blank || compareFilterValues(raw, values[0]) !== 0;
            case 'between':
            case 'notBetween': {
                if (blank) return conditionName === 'notBetween';
                // Both orientations, so reversed bounds work without a min and max on mixed numbers and strings.
                const lo = compareFilterValues(raw, values[0]);
                const hi = compareFilterValues(raw, values[1]);
                const within = (lo >= 0 && hi <= 0) || (hi >= 0 && lo <= 0);
                return conditionName === 'between' ? within : !within;
            }
            default:
                // A stored condition this version doesn't know: matching everything beats hiding every row.
                return true;
        }
    };
}

// The rows in the filter range a condition on one column hides. A row another column's filter hides already is skipped,
// as the by-values list offers only visible rows.
export function getFilterConditionHiddenRows(
    ctx: Context,
    col: number,
    startRow: number,
    endRow: number,
    startCol: number,
    condition: FilterCondition,
): Record<string, number> {
    const { otherHiddenRows } = getFilterHiddenRows(ctx, col, startCol);
    const rowhidden: Record<string, number> = {};
    const flowdata = getFlowdata(ctx);
    if (flowdata == null) return rowhidden;
    const matches = buildFilterConditionMatcher(condition);
    for (let r = startRow + 1; r <= endRow; r += 1) {
        if (r in otherHiddenRows) continue;
        if (!matches(flowdata[r][col])) rowhidden[r] = 0;
    }
    return rowhidden;
}

export function getFilterColumnValues(ctx: Context, col: number, startRow: number, endRow: number, startCol: number) {
    const { otherHiddenRows, hiddenRows } = getFilterHiddenRows(ctx, col, startCol);
    const visibleRows: number[] = [];
    const flattenValues: string[] = [];
    const dates: FilterDate[] = [];
    const datesUncheck: string[] = [];
    const datesUncheckSet = new Set<string>();
    const dateRowMap: Record<string, number[]> = {};

    const valuesMap: Map<string, FilterValue[]> = new Map();
    const valuesUncheck: string[] = [];
    const valuesUncheckSet = new Set<string>();
    const valueRowMap: Record<string, number[]> = {};

    const flowdata = getFlowdata(ctx);
    if (flowdata == null)
        return {
            dates,
            datesUncheck,
            dateRowMap,
            values: [],
            valuesUncheck,
            valueRowMap,
            visibleRows,
            flattenValues,
        };

    for (let r = startRow + 1; r <= endRow; r += 1) {
        if (r in otherHiddenRows) continue;
        visibleRows.push(r);

        const cell = flowdata[r][col];

        if (cell != null && !isRealNull(cell.v) && cell.ct?.t === 'd') {
            const dateStr: string = numberDisplay(cell.v, 'YYYY-MM-DD');
            const [y, m, d] = dateStr.split('-');

            let yearValue = dates.find((v) => v.value === y);
            if (yearValue == null) {
                yearValue = {
                    key: y,
                    type: 'year',
                    value: y,
                    text: y,
                    children: [],
                    rows: [],
                    dateValues: [],
                };
                dates.push(yearValue);
                flattenValues.push(dateStr);
            }

            let monthValue = yearValue.children.find((v) => v.value === m);
            if (monthValue == null) {
                monthValue = {
                    key: `${y}-${m}`,
                    type: 'month',
                    value: m,
                    // Excel's tree reads 2024 > August > 5.
                    text: numberDisplay(cell.v, 'MMMM'),
                    children: [],
                    rows: [],
                    dateValues: [],
                };
                yearValue.children.push(monthValue);
            }

            let dayValue = monthValue.children.find((v) => v.value === d);
            if (dayValue == null) {
                dayValue = {
                    key: dateStr,
                    type: 'day',
                    value: d,
                    text: String(Number(d)),
                    children: [],
                    rows: [],
                    dateValues: [],
                };
                monthValue.children.push(dayValue);
            }

            yearValue.rows.push(r);
            yearValue.dateValues.push(dateStr);
            monthValue.rows.push(r);
            monthValue.dateValues.push(dateStr);
            dayValue.rows.push(r);
            dayValue.dateValues.push(dateStr);
            (dateRowMap[dateStr] ||= []).push(r);

            if (r in hiddenRows && !datesUncheckSet.has(dateStr)) {
                datesUncheckSet.add(dateStr);
                datesUncheck.push(dateStr);
            }
        } else {
            let v: Cell['v'] | null;
            let m: Cell['v'] | null;
            if (cell == null || isRealNull(cellValue(cell))) {
                v = null;
                m = null;
            } else {
                v = cellValue(cell);
                m = cellDisplay(cell);
            }

            const data = valuesMap.get(`${v}`);
            const text = m == null ? '(Null)' : `${m}`;
            const key = `${v}#$$$#${m}`;
            if (data != null) {
                let maskValue = data.find((value) => value.mask === m);
                if (maskValue == null) {
                    maskValue = {
                        key,
                        value: v,
                        text,
                        mask: m,
                        rows: [],
                    };
                    data.push(maskValue);
                    flattenValues.push(text);
                }
                maskValue.rows.push(r);
            } else {
                valuesMap.set(`${v}`, [{ key, value: v, text, mask: m, rows: [r] }]);
                flattenValues.push(text);
            }

            if (r in hiddenRows && !valuesUncheckSet.has(key)) {
                valuesUncheckSet.add(key);
                valuesUncheck.push(key);
            }
            (valueRowMap[key] ||= []).push(r);
        }
    }
    return {
        dates,
        datesUncheck,
        dateRowMap,
        values: [...valuesMap.values()].flat(),
        valuesUncheck,
        valueRowMap,
        visibleRows,
        flattenValues,
    };
}

export type FilterColor = {
    color: string;
    checked: boolean;
    rows: number[];
};

// The cell and text colors a column's rows show, conditional formats included. A kind with one color offers none.
export function getFilterColumnColors(ctx: Context, col: number, startRow: number, endRow: number) {
    const bgMap: Map<string, FilterColor> = new Map();
    const fcMap: Map<string, FilterColor> = new Map();

    const cfCompute = getComputeMap(ctx);
    const flowdata = getFlowdata(ctx);
    if (flowdata == null) return { bgColors: [], fcColors: [] };
    const rowhidden = getSheetConfig(ctx)?.rowhidden || {};

    for (let r = startRow + 1; r <= endRow; r += 1) {
        const cell = flowdata[r][col];
        const checksCF = checkCF(r, col, cfCompute);
        const bg = toHexColor(checksCF?.cellColor ?? normalizedAttr(flowdata, r, col, 'bg') ?? '#ffffff');
        const textColor = checksCF?.textColor ?? normalizedAttr(flowdata, r, col, 'fc');
        const fc = textColor == null ? undefined : toHexColor(textColor);

        const isRowHidden = r in rowhidden;
        const bgData = bgMap.get(bg);
        if (bgData != null) {
            bgData.rows.push(r);
            if (isRowHidden) bgData.checked = false;
        } else {
            bgMap.set(bg, { color: bg, checked: !isRowHidden, rows: [r] });
        }
        if (fc != null && !isRealNull(cellValue(cell))) {
            const fcData = fcMap.get(fc);
            if (fcData != null) {
                fcData.rows.push(r);
                if (isRowHidden) fcData.checked = false;
            } else {
                fcMap.set(fc, { color: fc, checked: !isRowHidden, rows: [r] });
            }
        }
    }
    const bgColors = [...bgMap.values()];
    const fcColors = [...fcMap.values()];
    return {
        bgColors: bgColors.length < 2 ? [] : bgColors,
        fcColors: fcColors.length < 2 ? [] : fcColors,
    };
}

// A color as six-digit hex, so one color written as rgb(), #rgb or #rrggbb lists once.
function toHexColor(color: string) {
    const hex = color.includes('rgb') ? rgbToHex(color) : color;
    return hex.length === 4 ? hex[0] + hex[1].repeat(2) + hex[2].repeat(2) + hex[3].repeat(2) : hex;
}

// Applies the menu's choice for one column. The rows this column's filter hid before show again, unless another
// column's filter hides them too, and the rows it hides now are hidden.
export function saveFilter(
    ctx: Context,
    optionState: boolean,
    hiddenRows: Record<string, number>,
    byCondition: FilterCondition | undefined,
    startRow: number,
    endRow: number,
    col: number,
    startCol: number,
    endCol: number,
) {
    const { otherHiddenRows, hiddenRows: hiddenBefore } = getFilterHiddenRows(ctx, col, startCol);
    const sheet = getSheet(ctx);
    sheet.filter ??= {};
    if (optionState) {
        sheet.filter[col - startCol] = {
            byCondition,
            rowhidden: hiddenRows,
            optionstate: optionState,
            str: startRow,
            edr: endRow,
            cindex: col,
            stc: startCol,
            edc: endCol,
        };
    } else {
        delete sheet.filter[col - startCol];
    }

    // Reconcile in place and write only this column's rows. A fresh object or another column's rows on the wire would
    // undo a row a peer hid or showed by hand.
    const rowhidden = ((sheet.config ??= {}).rowhidden ??= {});
    for (const r of Object.keys(hiddenBefore)) {
        if (!(r in otherHiddenRows) && !(r in hiddenRows)) delete rowhidden[r];
    }
    Object.assign(rowhidden, hiddenRows);
}
