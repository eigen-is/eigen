import { cloneDeep, find, flatten, omit, reduce, size, union } from 'es-toolkit/compat';
import { update } from '../../engine/format';
import type { Cell, CellMatrix } from '../../engine/types';
import { type Context, getFlowdata } from '../context';
import { locale } from '../locale';
import type { Selection } from '../types';
import { getSheetIndex, isAllowEdit, rgbToHex } from '../utils';
import { normalizedAttr } from './cell';
import { checkCF, getComputeMap } from './conditionFormat';
import { normalizeSelection } from './selection';
import { sortDataRange } from './sort';
import { isRealNull } from './validation';

// Filter configuration state
export function labelFilterOptionState(
    ctx: Context,
    optionstate: boolean,
    rowhidden: Record<string, number>,
    caljs: unknown,
    str: number,
    edr: number,
    cindex: number,
    stc: number,
    edc: number,
    saveData: boolean,
) {
    const param = {
        caljs,
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
        const { filter } = locale(ctx);
        return filter.mergeError;
    }

    sortDataRange(ctx, d, data, curr - stc, asc, str, edr, stc, edc);

    return null;
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

    const r1 = filterRange.row[0];
    const r2 = filterRange.row[1];
    const c1 = filterRange.column[0];
    const c2 = filterRange.column[1];

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

    for (let c = c1; c <= c2; c += 1) {
        let left = 0;
        if (ctx.visibledatacolumn[c]) {
            left = ctx.visibledatacolumn[c] - 20;
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
    ctx.config.rowhidden = omit(ctx.config.rowhidden, Object.keys(hiddenRows));
    ctx.filterRange = undefined;
    ctx.filterOptions = undefined;
    ctx.filterContextMenu = undefined;
    ctx.filter = {};
    if (sheetIndex != null) {
        ctx.sheets[sheetIndex].filter = undefined;
        ctx.sheets[sheetIndex].filterRange = undefined;
        ctx.sheets[sheetIndex].config = cloneDeep(ctx.config);
    }
}

export function createFilter(ctx: Context) {
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

export function getFilterColumnValues(ctx: Context, col: number, startRow: number, endRow: number, startCol: number) {
    const { otherHiddenRows, hiddenRows } = getFilterHiddenRows(ctx, col, startCol);
    const visibleRows: number[] = [];
    const flattenValues: string[] = [];
    // Date values
    const dates: FilterDate[] = [];
    let datesUncheck: string[] = [];
    const dateRowMap: Record<string, number[]> = {};

    // Non-date values
    const valuesMap: Map<string, FilterValue[]> = new Map();
    let valuesUncheck: string[] = [];
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
    const { filter } = locale(ctx);
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
            dateRowMap[dateStr] = (dateRowMap[dateStr] || []).concat(r);

            if (r in hiddenRows) {
                datesUncheck = union(datesUncheck, [dateStr]);
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

            if (r in hiddenRows) {
                valuesUncheck = union(valuesUncheck, [key]);
            }
            valueRowMap[key] = (valueRowMap[key] || []).concat(r);
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

        const isRowHidden = r in (ctx.config?.rowhidden || {});
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
    caljs: unknown,
    st_r: number,
    ed_r: number,
    cindex: number,
    st_c: number,
    ed_c: number,
) {
    const { otherHiddenRows } = getFilterHiddenRows(ctx, cindex, st_c);
    const rowHiddenAll = Object.assign(otherHiddenRows, hiddenRows);

    labelFilterOptionState(ctx, optionState, hiddenRows, caljs, st_r, ed_r, cindex, st_c, ed_c, true);

    const cfg = cloneDeep(ctx.config);
    cfg.rowhidden = rowHiddenAll;

    ctx.config = cfg;
    const sheetIndex = getSheetIndex(ctx, ctx.currentSheetId);
    if (sheetIndex == null) {
        return;
    }
    ctx.sheets[sheetIndex].config = cfg;
}
