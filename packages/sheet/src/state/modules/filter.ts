import { cloneDeep, find, flatten, reduce, size } from 'es-toolkit/compat';
import { genarate, update } from '../../engine/format';
import type { Cell, CellMatrix } from '../../engine/types';
import { type Context, getFlowdata, getSheetConfig } from '../context';
import { en } from '../locale/en';
import type { FilterCondition, FilterConditionName, Selection } from '../types';
import { getSheetIndex, isAllowEdit, rgbToHex } from '../utils';
import { normalizedAttr } from './cell';
import { checkCF, getComputeMap } from './condition-format';
import { normalizeSelection } from './selection';
import { sortDataRange } from './sort';
import { isRealNull, isRealNum } from './validation';

// Filter configuration state
export function labelFilterOptionState(
    ctx: Context,
    optionstate: boolean,
    rowhidden: Record<string, number>,
    byCondition: FilterCondition | undefined,
    str: number,
    edr: number,
    cindex: number,
    stc: number,
    edc: number,
    saveData: boolean,
) {
    const param = {
        byCondition,
        rowhidden,
        optionstate,
        str,
        edr,
        cindex,
        stc,
        edc,
    };

    if (optionstate) {
        ctx.filter[cindex - stc] = param;
    } else {
        delete ctx.filter[cindex - stc];
    }

    if (saveData) {
        const sheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
        if (sheetIndex == null) return;
        const file = ctx.sheets[sheetIndex];

        if (file.filter == null) {
            file.filter = {};
        }

        if (optionstate) {
            file.filter[cindex - stc] = param;
        } else {
            delete file.filter[cindex - stc];
        }
    }
}

// Filter sort
export function orderbydatafiler(
    ctx: Context,
    str: number,
    stc: number,
    edr: number,
    edc: number,
    curr: number,
    asc: boolean,
) {
    const d = getFlowdata(ctx);
    if (d == null) {
        return null;
    }
    str += 1;

    let hasMc = false; // Whether the sort selection has merged cells
    const data: CellMatrix = [];

    for (let r = str; r <= edr; r += 1) {
        const data_row: (Cell | null)[] = [];

        for (let c = stc; c <= edc; c += 1) {
            if (d[r][c] != null && d[r][c]?.mc != null) {
                hasMc = true;
                break;
            }

            data_row.push(d[r][c]);
        }

        data.push(data_row);
    }

    if (hasMc) {
        const { filter } = en;
        return filter.mergeError;
    }

    sortDataRange(ctx, d, data, curr - stc, asc, str, edr, stc, edc);

    return null;
}

// The per-column autofilter button: 20×15, right edge on the column's right
// edge, at the top of the filter header row. Drawn on the canvas (freeze-aware
// for free) and hit-tested in the mousedown path from the same
// filterOptions.items geometry plus these constants.
export const FILTER_BUTTON_WIDTH = 20;
export const FILTER_BUTTON_HEIGHT = 15;

// x/y are freeze-corrected sheet coordinates (the space fixPositionOnFrozenCells
// produces in the mouse handlers). Every button sits on the filter header row
// (createFilterOptions gives all items the same top), so a y outside that band
// rejects without scanning the columns.
export function getFilterButtonAtPosition(ctx: Context, x: number, y: number) {
    const options = ctx.filterOptions;
    if (options == null) return undefined;
    if (y < options.top || y >= options.top + FILTER_BUTTON_HEIGHT) return undefined;
    // Last match, not first: a column narrower than the button (the resize floor is 10px, the
    // button is 20) overlaps its neighbour, and the draw loop leaves the later one on top.
    return options.items.findLast((item) => x >= item.left && x < item.left + FILTER_BUTTON_WIDTH);
}

// Create filter options
export function createFilterOptions(
    ctx: Context,
    filterRange:
        | {
              row: number[];
              column: number[];
          }
        | undefined,
    sheetId: string | undefined,
    saveData?: boolean,
) {
    const allowEdit = isAllowEdit(ctx);
    if (!allowEdit) return;
    if (sheetId != null && sheetId !== ctx.currentSheetId) return;
    const sheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
    if (sheetIndex == null) return;
    if (filterRange == null || size(filterRange) === 0) {
        delete ctx.filterOptions;
        return;
    }

    // Imported xlsx autofilter ranges can extend past the materialized grid.
    // The stored filterRange is kept verbatim (export fidelity); only the view
    // clamps. filterOptions rows must stay inside the data matrix — the menu's
    // value/color scans, sort, and condition apply all iterate them straight
    // into flowdata[r], and a missing row crashes on undefined[col].
    const lastRow = (ctx.sheets[sheetIndex].data?.length ?? 0) - 1;
    const lastCol = ctx.visibledatacolumn.length - 1;
    const r1 = filterRange.row[0];
    const r2 = Math.min(filterRange.row[1], lastRow);
    const c1 = filterRange.column[0];
    const c2 = Math.min(filterRange.column[1], lastCol);
    if (r1 > r2 || c1 > c2) {
        delete ctx.filterOptions;
        return;
    }

    const row = ctx.visibledatarow[r2] ?? 0;
    const row_pre = r1 - 1 === -1 ? 0 : (ctx.visibledatarow[r1 - 1] ?? 0);
    const col = ctx.visibledatacolumn[c2] ?? 0;
    const col_pre = c1 - 1 === -1 ? 0 : (ctx.visibledatacolumn[c1 - 1] ?? 0);
    const options = {
        startRow: r1,
        endRow: r2,
        startCol: c1,
        endCol: c2,
        left: col_pre,
        top: row_pre,
        width: col - col_pre - 1,
        height: row - row_pre - 1,
        items: [] as { col: number; left: number; top: number }[],
    };

    const colhidden = getSheetConfig(ctx)?.colhidden;
    for (let c = c1; c <= c2; c += 1) {
        // A hidden column is zero-width, so its button rect coincides with the previous visible
        // column's — and the last-match hit-test would hand it every click on that shared rect.
        if (colhidden?.[c] != null) {
            continue;
        }

        let left = 0;
        if (ctx.visibledatacolumn[c]) {
            left = ctx.visibledatacolumn[c] - FILTER_BUTTON_WIDTH;
        }
        options.items.push({
            col: c,
            left,
            top: row_pre,
        });
    }

    if (saveData) {
        const file = ctx.sheets[sheetIndex];
        file.filterRange = filterRange;
    }
    ctx.filterOptions = options;
}

export function clearFilter(ctx: Context) {
    const allowEdit = isAllowEdit(ctx);
    if (!allowEdit) return;
    const sheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
    const hiddenRows = reduce(ctx.filter, (pre, curr) => Object.assign(pre, curr?.rowhidden || {}), {});
    ctx.filterRange = undefined;
    ctx.filterOptions = undefined;
    ctx.filterContextMenu = undefined;
    ctx.filter = {};
    if (sheetIndex != null) {
        // Delete in place: `omit` returns a fresh object, so assigning it replaced the whole
        // rowhidden map on the wire even when the filter had hidden nothing.
        const rowhidden = ctx.sheets[sheetIndex].config?.rowhidden;
        if (rowhidden) {
            for (const r of Object.keys(hiddenRows)) delete rowhidden[r];
        }
        ctx.sheets[sheetIndex].filter = undefined;
        ctx.sheets[sheetIndex].filterRange = undefined;
    }
}

export function createFilter(ctx: Context) {
    const allowEdit = isAllowEdit(ctx);
    if (!allowEdit) return;
    if (size(ctx.selections) > 1) {
        return;
    }
    if (size(ctx.filterRange) > 0) {
        clearFilter(ctx);
        return;
    }

    const sheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
    if (sheetIndex == null || ctx.sheets[sheetIndex].isPivotTable) {
        return;
    }

    const last = ctx.selections?.[0];
    const flowdata = getFlowdata(ctx);
    let filterSave: Selection[] | undefined;
    if (last == null || flowdata == null) return;
    if (last.row[0] === last.row[1] && last.column[0] === last.column[1]) {
        let st_c: number | undefined;
        let ed_c: number | undefined;
        const curR = last.row[1];

        for (let c = 0; c < flowdata[curR].length; c += 1) {
            const cell = flowdata[curR][c];

            if (cell != null && !isRealNull(cell.v)) {
                if (st_c == null) {
                    st_c = c;
                }
            } else if (st_c != null) {
                ed_c = c - 1;
                break;
            }
        }

        if (ed_c == null) {
            ed_c = flowdata[curR].length - 1;
        }

        filterSave = normalizeSelection(ctx, [{ row: [curR, curR], column: [st_c ?? 0, ed_c] }]);
        ctx.selections = filterSave;

        ctx.shiftAnchor = cloneDeep(last);
    } else if (last.row[1] - last.row[0] < 2) {
        ctx.shiftAnchor = cloneDeep(last);
    }

    ctx.filterRange = cloneDeep(filterSave?.[0] || ctx.selections?.[0]);

    createFilterOptions(ctx, ctx.filterRange, undefined, true);
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
    mask: Cell['m'] | null;
    text: string;
    rows: number[];
};

function getFilterHiddenRows(ctx: Context, col: number, startCol: number) {
    const otherHiddenRows = reduce(
        ctx.filter,
        (pre, curr) => Object.assign(pre, (curr?.cindex !== col && curr?.rowhidden) || {}),
        {},
    );
    const hiddenRows = ctx.filter[col - startCol]?.rowhidden || {};
    return { otherHiddenRows, hiddenRows };
}

// Ordered condition list for the filter menu's Select; arity is the number of
// operand inputs the condition needs.
export const FILTER_CONDITION_ITEMS: {
    name: FilterConditionName;
    localeKey: keyof typeof en.filter;
    arity: 0 | 1 | 2;
}[] = [
    { name: 'isEmpty', localeKey: 'conditionCellIsNull', arity: 0 },
    { name: 'isNotEmpty', localeKey: 'conditionCellNotNull', arity: 0 },
    { name: 'textContains', localeKey: 'conditionCellTextContain', arity: 1 },
    { name: 'textNotContains', localeKey: 'conditionCellTextNotContain', arity: 1 },
    { name: 'textStartsWith', localeKey: 'conditionCellTextStart', arity: 1 },
    { name: 'textEndsWith', localeKey: 'conditionCellTextEnd', arity: 1 },
    { name: 'textEquals', localeKey: 'conditionCellTextEqual', arity: 1 },
    { name: 'dateEqual', localeKey: 'conditionCellDateEqual', arity: 1 },
    { name: 'dateBefore', localeKey: 'conditionCellDateBefore', arity: 1 },
    { name: 'dateAfter', localeKey: 'conditionCellDateAfter', arity: 1 },
    { name: 'greaterThan', localeKey: 'conditionCellGreater', arity: 1 },
    { name: 'greaterThanOrEqual', localeKey: 'conditionCellGreaterEqual', arity: 1 },
    { name: 'lessThan', localeKey: 'conditionCellLess', arity: 1 },
    { name: 'lessThanOrEqual', localeKey: 'conditionCellLessEqual', arity: 1 },
    { name: 'equal', localeKey: 'conditionCellEqual', arity: 1 },
    { name: 'notEqual', localeKey: 'conditionCellNotEqual', arity: 1 },
    { name: 'between', localeKey: 'conditionCellBetween', arity: 2 },
    { name: 'notBetween', localeKey: 'conditionCellNotBetween', arity: 2 },
];

// Unknown names (a snapshot written by a newer client) report arity 0.
export function filterConditionArity(name: FilterConditionName): 0 | 1 | 2 {
    return FILTER_CONDITION_ITEMS.find((item) => item.name === name)?.arity ?? 0;
}

// -1/0/1 ordering: numeric when both sides parse as numbers, case-insensitive
// string compare otherwise.
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

// Condition input → canonical YYYY-MM-DD, or null when it doesn't parse as a date.
function toIsoDay(input: string): string | null {
    const [, ct, v] = genarate(input);
    if (ct.t !== 'd') return null;
    return update('YYYY-MM-DD', v);
}

// Blank cells (no cell / null / empty / whitespace-only value) match only
// isEmpty and the negative conditions — each negative is the exact complement
// of its positive, so notEqual / textNotContains / notBetween keep blank rows
// visible. Text conditions compare the display string (m) case-insensitively;
// date conditions only match ct.t === 'd' cells at day granularity. An
// incomplete condition (blank operand, unparseable date) filters nothing.
export function buildFilterConditionMatcher(condition: FilterCondition): (cell: Cell | null | undefined) => boolean {
    const { conditionName, values } = condition;
    const arity = filterConditionArity(conditionName);
    for (let i = 0; i < arity; i += 1) {
        if (isRealNull(values[i])) return () => true;
    }

    // Operand parsing is hoisted out of the per-row matcher: the needle and the
    // condition date are constant for a whole Confirm pass over the column.
    const needle = arity > 0 ? values[0].toLowerCase() : '';

    if (conditionName === 'dateEqual' || conditionName === 'dateBefore' || conditionName === 'dateAfter') {
        const day = toIsoDay(values[0]);
        if (day == null) return () => true;
        return (cell) => {
            if (cell == null || cell.ct?.t !== 'd' || isRealNull(cell.v)) return false;
            const cellDay = update('YYYY-MM-DD', cell.v);
            if (conditionName === 'dateEqual') return cellDay === day;
            if (conditionName === 'dateBefore') return cellDay < day;
            return cellDay > day;
        };
    }

    return (cell) => {
        const blank = cell == null || isRealNull(cell.v);
        const display = blank ? '' : `${cell.m ?? cell.v}`.toLowerCase();
        const raw = blank ? '' : `${cell.v}`;

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
                // Checking both bound orientations normalizes reversed bounds without
                // needing a min/max on the mixed numeric/string ordering.
                const lo = compareFilterValues(raw, values[0]);
                const hi = compareFilterValues(raw, values[1]);
                const within = (lo >= 0 && hi <= 0) || (hi >= 0 && lo <= 0);
                return conditionName === 'between' ? within : !within;
            }
            default:
                // Date conditions returned their own matcher above; a snapshot
                // written by a newer client can carry a condition this version
                // doesn't know — matching everything beats hiding every row.
                return true;
        }
    };
}

// Hidden-row set for a condition on one column: every visible row in the filter
// range whose cell fails the condition. Rows hidden by other columns' filters
// are skipped, mirroring the by-values flow (getFilterColumnValues only offers
// visible rows). Evaluated on Confirm, not live.
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
        if (!matches(flowdata[r][col])) {
            rowhidden[r] = 0;
        }
    }
    return rowhidden;
}

export function getFilterColumnValues(ctx: Context, col: number, startRow: number, endRow: number, startCol: number) {
    const { otherHiddenRows, hiddenRows } = getFilterHiddenRows(ctx, col, startCol);
    const visibleRows: number[] = [];
    const flattenValues: string[] = [];
    // Date values
    const dates: FilterDate[] = [];
    const datesUncheck: string[] = [];
    const datesUncheckSet = new Set<string>();
    const dateRowMap: Record<string, number[]> = {};

    // Non-date values
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

    let cell: Cell | null;
    const { filter } = en;
    for (let r = startRow + 1; r <= endRow; r += 1) {
        if (r in otherHiddenRows) {
            continue;
        }
        visibleRows.push(r);

        cell = flowdata[r][col];

        if (cell != null && !isRealNull(cell.v) && cell.ct != null && cell.ct.t === 'd') {
            // Cell is a date
            const dateStr: string = update('YYYY-MM-DD', cell.v);

            const y = dateStr.split('-')[0];
            const m = dateStr.split('-')[1];
            const d = dateStr.split('-')[2];

            let yearValue = find(dates, (v) => v.value === y);
            if (yearValue == null) {
                yearValue = {
                    key: y,
                    type: 'year',
                    value: y,
                    text: y + filter.filiterYearText,
                    children: [],
                    rows: [],
                    dateValues: [],
                };
                dates.push(yearValue);
                flattenValues.push(dateStr);
            }

            let monthValue = find(yearValue.children, (v) => v.value === m);
            if (monthValue == null) {
                monthValue = {
                    key: `${y}-${m}`,
                    type: 'month',
                    value: m,
                    text: m + filter.filiterMonthText,
                    children: [],
                    rows: [],
                    dateValues: [],
                };
                yearValue.children.push(monthValue);
            }

            let dayValue = find(monthValue.children, (v) => v.value === d);
            if (dayValue == null) {
                dayValue = {
                    key: dateStr,
                    type: 'day',
                    value: d,
                    text: d,
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
            let m: Cell['m'] | null;
            if (cell == null || isRealNull(cell.v)) {
                v = null;
                m = null;
            } else {
                v = cell.v;
                m = cell.m;
            }

            const data = valuesMap.get(`${v}`);
            const text = m == null ? filter.valueBlank : `${m}`;
            const key = `${v}#$$$#${m}`;
            if (data != null) {
                let maskValue = find(data, (value) => value.mask === m);
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
        values: flatten(Array.from(valuesMap.values())),
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

export function getFilterColumnColors(ctx: Context, col: number, startRow: number, endRow: number) {
    const bgMap: Map<string, FilterColor> = new Map(); // Cell background color
    const fcMap: Map<string, FilterColor> = new Map(); // Font color

    const cf_compute = getComputeMap(ctx);
    const flowdata = getFlowdata(ctx);
    if (flowdata == null) return { bgColors: [], fcColors: [] };
    const rowhidden = getSheetConfig(ctx)?.rowhidden || {};

    for (let r = startRow + 1; r <= endRow; r += 1) {
        const cell = flowdata[r][col];

        let bg = normalizedAttr(flowdata, r, col, 'bg');
        if (bg == null) {
            bg = '#ffffff';
        }

        const checksCF = checkCF(r, col, cf_compute);
        if (checksCF != null && checksCF.cellColor != null) {
            bg = checksCF.cellColor;
        }

        if (bg.indexOf('rgb') > -1) {
            bg = rgbToHex(bg);
        }

        if (bg.length === 4) {
            bg = bg.substr(0, 1) + bg.substr(1, 1).repeat(2) + bg.substr(2, 1).repeat(2) + bg.substr(3, 1).repeat(2);
        }

        let fc = normalizedAttr(flowdata, r, col, 'fc');

        if (checksCF != null && checksCF.textColor != null) {
            fc = checksCF.textColor;
        }

        if (fc != null) {
            if (fc.indexOf('rgb') > -1) {
                fc = rgbToHex(fc);
            }

            if (fc.length === 4) {
                fc =
                    fc.substr(0, 1) + fc.substr(1, 1).repeat(2) + fc.substr(2, 1).repeat(2) + fc.substr(3, 1).repeat(2);
            }
        }

        const isRowHidden = r in rowhidden;
        const bgData = bgMap.get(bg);
        if (bgData != null) {
            bgData.rows.push(r);
            if (isRowHidden) bgData.checked = false;
        } else {
            bgMap.set(bg, { color: bg, checked: !isRowHidden, rows: [r] });
        }
        if (fc != null) {
            const fcData = fcMap.get(fc);
            if (fcData != null && cell != null && !isRealNull(cell.v)) {
                fcData.rows.push(r);
                if (isRowHidden) fcData.checked = false;
            } else if (cell != null && !isRealNull(cell.v)) {
                fcMap.set(fc, { color: fc, checked: !isRowHidden, rows: [r] });
            }
        }
    }
    const bgColors = flatten(Array.from(bgMap.values()));
    const fcColors = flatten(Array.from(fcMap.values()));
    return {
        bgColors: bgColors.length < 2 ? [] : bgColors,
        fcColors: fcColors.length < 2 ? [] : fcColors,
    };
}

export function saveFilter(
    ctx: Context,
    optionState: boolean,
    hiddenRows: Record<string, number>,
    byCondition: FilterCondition | undefined,
    st_r: number,
    ed_r: number,
    cindex: number,
    st_c: number,
    ed_c: number,
) {
    const { otherHiddenRows } = getFilterHiddenRows(ctx, cindex, st_c);
    const rowHiddenAll = Object.assign(otherHiddenRows, hiddenRows);

    labelFilterOptionState(ctx, optionState, hiddenRows, byCondition, st_r, ed_r, cindex, st_c, ed_c, true);

    const sheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
    if (sheetIndex == null) {
        return;
    }
    // Reconcile in place rather than assigning `rowHiddenAll`: a fresh object replaces the
    // whole rowhidden map on the wire, so applying a filter would clobber a peer's manual
    // row hide. Same reasoning as clearFilter above.
    const rowhidden = ((ctx.sheets[sheetIndex].config ??= {}).rowhidden ??= {});
    for (const r of Object.keys(rowhidden)) {
        if (!(r in rowHiddenAll)) delete rowhidden[r];
    }
    Object.assign(rowhidden, rowHiddenAll);
}
