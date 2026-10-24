import type { MergeCell, Sheet, SheetChart } from '@workspace/lib/sheets';
import { cloneSides, parseCellKey, REFERENCE_COLUMN_COUNT, REFERENCE_ROW_COUNT } from '@workspace/lib/sheets';
import type { CellRangeRef } from '@workspace/lib/types/chart';
import { mapChartRefs } from './chart-data';
import { withCfRanges } from './conditional-format';
import { MAX_SHEET_COLUMN_COUNT, MAX_SHEET_ROW_COUNT } from './defaults';
import { functionStrChange } from './formula-shift';
import type { ExtendedSheetConfig, SingleRange } from './types';

export type InsertRowColOp = {
    type: 'row' | 'column';
    index: number;
    count: number;
    direction: 'lefttop' | 'rightbottom';
    id: string;
};

export type DeleteRowColOp = {
    type: 'row' | 'column';
    start: number;
    end: number;
    id: string;
};

export type RowColErrorCode = 'readOnly' | 'maxExceeded';

// Engine signals an aborted row/col op via this typed error rather than a
// bare-string `new Error('readOnly')`. UI callers (ContextMenu/MenuBar) branch
// on `code`; the BE replay path catches and skips. The contract is enforced at
// the type level so the catch sites don't depend on message punctuation.
export class RowColError extends Error {
    public readonly code: RowColErrorCode;

    public constructor(code: RowColErrorCode) {
        super(code);
        this.name = 'RowColError';
        this.code = code;
    }
}

type AxisRange = { row: readonly number[]; column: readonly number[] };

// Excel's rule for a range across an insert: an insert at or before its first row (or column)
// moves it, one inside grows it, one right after leaves it. The same range comes back unmoved.
// CF, alternate formats and chart refs all shift through this pair.
export function shiftRangeForInsert<R extends AxisRange>(
    range: R,
    op: Pick<InsertRowColOp, 'type' | 'index' | 'count' | 'direction'>,
): R {
    const insertAt = op.direction === 'lefttop' ? op.index : op.index + 1;
    const [start, end] = op.type === 'row' ? range.row : range.column;
    if (insertAt > end) return range;
    const span: [number, number] = insertAt <= start ? [start + op.count, end + op.count] : [start, end + op.count];
    return op.type === 'row' ? { ...range, row: span } : { ...range, column: span };
}

// A delete shrinks a range to what survives; null when it deletes all of it.
export function shiftRangeForDelete<R extends AxisRange>(
    range: R,
    op: Pick<DeleteRowColOp, 'type' | 'start' | 'end'>,
): R | null {
    const [start, end] = op.type === 'row' ? range.row : range.column;
    const removed = op.end - op.start + 1;
    if (start >= op.start && end <= op.end) return null;
    if (end < op.start) return range;
    const span: [number, number] = [
        start < op.start ? start : start > op.end ? start - removed : op.start,
        end > op.end ? end - removed : op.start - 1,
    ];
    return op.type === 'row' ? { ...range, row: span } : { ...range, column: span };
}

// A chart's points, a pie's slice colors among them, go by index along its categories, so an insert inside them leaves
// the new points automatic and moves the ones after up. Only a ref that runs along the op's axis has points there.
function pointsForInsert(ref: CellRangeRef, op: InsertRowColOp): ((index: number) => number) | null {
    if (!runsAlong(ref, op.type)) return null;
    const [start, end] = op.type === 'row' ? ref.row : ref.column;
    const at = (op.direction === 'lefttop' ? op.index : op.index + 1) - start;
    if (at <= 0 || at > end - start) return null;
    return (index) => (index >= at ? index + op.count : index);
}

// A delete drops the deleted points, so the points after them keep theirs.
function pointsForDelete(ref: CellRangeRef, op: DeleteRowColOp): ((index: number) => number | null) | null {
    if (!runsAlong(ref, op.type)) return null;
    const [start, end] = op.type === 'row' ? ref.row : ref.column;
    const first = Math.max(op.start, start) - start;
    const last = Math.min(op.end, end) - start;
    if (first > last) return null;
    return (index) => (index < first ? index : index > last ? index - (last - first + 1) : null);
}

function runsAlong(ref: CellRangeRef, type: 'row' | 'column'): boolean {
    return type === 'row' ? ref.column[0] === ref.column[1] : ref.row[0] === ref.row[1];
}

// Generic over S so the state-side state.Sheet[] passes through with its extras
// (filter / frozen / dataVerification / ...) typed end-to-end. The engine only
// reads lib.Sheet-typed fields; shallow copies preserve the wider input shape.
//
// All rebuilds use structural sharing, never a deep clone: rows (and cells, for
// column ops) that an operation doesn't touch are reused by reference. On the FE
// the inputs are immer drafts and the result is assigned back into the draft —
// untouched rows finalize to their unchanged bases, so a row insert no longer
// pays a deep walk over every cell (multi-second on large sheets).
export function applySheetsInsertRowCol<S extends Sheet>(sheets: S[], op: InsertRowColOp): S[] {
    const targetIndex = sheets.findIndex((s) => s.id === op.id);
    if (targetIndex === -1) return sheets;
    return applyInsert(sheets, targetIndex, op);
}

export function applySheetsDeleteRowCol<S extends Sheet>(sheets: S[], op: DeleteRowColOp): S[] {
    const targetIndex = sheets.findIndex((s) => s.id === op.id);
    if (targetIndex === -1) return sheets;
    return applyDelete(sheets, targetIndex, op);
}

function shiftMergeForInsert(
    cfg: ExtendedSheetConfig,
    type: 'row' | 'column',
    index: number,
    count: number,
    direction: 'lefttop' | 'rightbottom',
): Record<string, MergeCell> {
    const merge_new: Record<string, MergeCell> = {};
    for (const mc of Object.values(cfg.merge ?? {})) {
        const { r, c, rs, cs } = mc;
        if (type === 'row') {
            if (index < r) {
                merge_new[`${r + count}_${c}`] = { r: r + count, c, rs, cs };
            } else if (index === r) {
                if (direction === 'lefttop') {
                    merge_new[`${r + count}_${c}`] = { r: r + count, c, rs, cs };
                } else {
                    merge_new[`${r}_${c}`] = { r, c, rs: rs + count, cs };
                }
            } else if (index < r + rs - 1) {
                merge_new[`${r}_${c}`] = { r, c, rs: rs + count, cs };
            } else if (index === r + rs - 1) {
                if (direction === 'lefttop') {
                    merge_new[`${r}_${c}`] = { r, c, rs: rs + count, cs };
                } else {
                    merge_new[`${r}_${c}`] = { r, c, rs, cs };
                }
            } else {
                merge_new[`${r}_${c}`] = { r, c, rs, cs };
            }
        } else {
            if (index < c) {
                merge_new[`${r}_${c + count}`] = { r, c: c + count, rs, cs };
            } else if (index === c) {
                if (direction === 'lefttop') {
                    merge_new[`${r}_${c + count}`] = { r, c: c + count, rs, cs };
                } else {
                    merge_new[`${r}_${c}`] = { r, c, rs, cs: cs + count };
                }
            } else if (index < c + cs - 1) {
                merge_new[`${r}_${c}`] = { r, c, rs, cs: cs + count };
            } else if (index === c + cs - 1) {
                if (direction === 'lefttop') {
                    merge_new[`${r}_${c}`] = { r, c, rs, cs: cs + count };
                } else {
                    merge_new[`${r}_${c}`] = { r, c, rs, cs };
                }
            } else {
                merge_new[`${r}_${c}`] = { r, c, rs, cs };
            }
        }
    }
    return merge_new;
}

function shiftMergeForDelete(
    cfg: ExtendedSheetConfig,
    type: 'row' | 'column',
    start: number,
    slen: number,
): Record<string, MergeCell> {
    const end = start + slen - 1;
    const merge_new: Record<string, MergeCell> = {};
    for (const mc of Object.values(cfg.merge ?? {})) {
        const { r, c, rs, cs } = mc;
        if (type === 'row') {
            if (r < start) {
                if (r + rs - 1 < start) {
                    merge_new[`${r}_${c}`] = { r, c, rs, cs };
                } else if (r + rs - 1 >= start && r + rs - 1 < end) {
                    merge_new[`${r}_${c}`] = { r, c, rs: start - r, cs };
                } else if (r + rs - 1 >= end) {
                    merge_new[`${r}_${c}`] = { r, c, rs: rs - slen, cs };
                }
            } else if (r >= start && r <= end) {
                if (r + rs - 1 > end) {
                    merge_new[`${start}_${c}`] = { r: start, c, rs: r + rs - 1 - end, cs };
                }
            } else if (r > end) {
                merge_new[`${r - slen}_${c}`] = { r: r - slen, c, rs, cs };
            }
        } else {
            if (c < start) {
                if (c + cs - 1 < start) {
                    merge_new[`${r}_${c}`] = { r, c, rs, cs };
                } else if (c + cs - 1 >= start && c + cs - 1 < end) {
                    merge_new[`${r}_${c}`] = { r, c, rs, cs: start - c };
                } else if (c + cs - 1 >= end) {
                    merge_new[`${r}_${c}`] = { r, c, rs, cs: cs - slen };
                }
            } else if (c >= start && c <= end) {
                if (c + cs - 1 > end) {
                    merge_new[`${r}_${start}`] = { r, c: start, rs, cs: c + cs - 1 - end };
                }
            } else if (c > end) {
                merge_new[`${r}_${c - slen}`] = { r, c: c - slen, rs, cs };
            }
        }
    }
    return merge_new;
}

// Re-keys an "r_c" map for an insert: the row/column at `index` is the template, copied by `clone`
// onto every inserted one when given, and shifts along only for a lefttop insert.
export function shiftCellKeyedForInsert<T>(
    map: Record<string, T> | undefined,
    axis: 'row' | 'column',
    index: number,
    count: number,
    direction: 'lefttop' | 'rightbottom',
    clone?: (item: T) => T,
): Record<string, T> {
    const shifted: Record<string, T> = {};
    for (const key in map) {
        const item = map[key];
        let [r, c] = parseCellKey(key);
        const at = axis === 'row' ? r : c;
        if (at === index && clone) {
            for (let n = 0; n < count; n += 1) {
                const to = direction === 'rightbottom' ? index + n + 1 : index + n;
                shifted[axis === 'row' ? `${to}_${c}` : `${r}_${to}`] = clone(item);
            }
        }
        if (direction === 'lefttop' ? at >= index : at > index) {
            if (axis === 'row') r += count;
            else c += count;
        }
        shifted[`${r}_${c}`] = item;
    }
    return shifted;
}

// Re-keys an "r_c" map for a delete: entries in [start, end] drop, the ones past it shift up.
export function shiftCellKeyedForDelete<T>(
    map: Record<string, T> | undefined,
    axis: 'row' | 'column',
    start: number,
    end: number,
): Record<string, T> {
    const shifted: Record<string, T> = {};
    for (const key in map) {
        let [r, c] = parseCellKey(key);
        const at = axis === 'row' ? r : c;
        if (at >= start && at <= end) continue;
        if (at > end) {
            if (axis === 'row') r -= end - start + 1;
            else c -= end - start + 1;
        }
        shifted[`${r}_${c}`] = map[key];
    }
    return shifted;
}

// An op on one sheet only moves the refs that resolve to that sheet: unqualified ones in
// formulas on it, and `Sheet!`-qualified ones anywhere. A CF `formula` rule reads its cells
// through its own text, so it shifts by the same rules as a cell formula on its sheet.
function shiftFormulasAcrossSheets<S extends Sheet>(
    sheets: S[],
    targetIndex: number,
    type: 'row' | 'column',
    direction: 'lefttop' | 'rightbottom' | null,
    index: number,
    count: number,
    op: 'add' | 'del',
): S[] {
    const targetName = sheets[targetIndex].name;
    return sheets.map((sheet, sheetIndex) => {
        const shift = (txt: string) =>
            functionStrChange(
                txt,
                op,
                type === 'row' ? 'row' : 'col',
                direction,
                index,
                count,
                targetName,
                sheetIndex === targetIndex,
            );

        let newSheet = sheet;

        if (sheet.data) {
            let newData: typeof sheet.data | null = null;
            for (let r = 0; r < sheet.data.length; r += 1) {
                const row = sheet.data[r];
                if (!row) continue;
                for (let c = 0; c < row.length; c += 1) {
                    const cell = row[c];
                    if (!cell?.f) continue;
                    const newF = `=${shift(cell.f.startsWith('=') ? cell.f.slice(1) : cell.f)}`;
                    if (newF === cell.f) continue;
                    if (!newData) newData = [...sheet.data];
                    if (newData[r] === row) newData[r] = [...row];
                    newData[r][c] = { ...cell, f: newF };
                }
            }
            if (newData) newSheet = { ...newSheet, data: newData };
        }

        const rules = sheet.conditionalFormatRules;
        if (rules) {
            let newRules: typeof rules | null = null;
            for (let i = 0; i < rules.length; i += 1) {
                const cf = rules[i];
                if (cf.type !== 'default' || cf.conditionName !== 'formula') continue;
                const txt = String(cf.conditionValue[0]);
                const shifted = txt.startsWith('=') ? `=${shift(txt.slice(1))}` : shift(txt);
                if (shifted === txt) continue;
                if (!newRules) newRules = [...rules];
                newRules[i] = { ...cf, conditionValue: [shifted] };
            }
            if (newRules) newSheet = { ...newSheet, conditionalFormatRules: newRules };
        }

        return newSheet;
    });
}

// A chart ref names its sheet by id, so an op on one sheet moves the refs to it on every sheet's
// charts, and the points along them. Only a chart whose refs moved is rewritten; a malformed
// spec stays as stored.
function shiftChartsAcrossSheets<S extends Sheet>(
    sheets: S[],
    sheetId: string,
    shift: (ref: CellRangeRef) => CellRangeRef | null,
    shiftPoints: (ref: CellRangeRef) => ((index: number) => number | null) | null,
): S[] {
    const move = (ref: CellRangeRef) => (ref.sheetId === sheetId ? shift(ref) : ref);
    const points = (ref: CellRangeRef) => (ref.sheetId === sheetId ? shiftPoints(ref) : null);
    return sheets.map((sheet) => {
        let charts: Record<string, SheetChart> | null = null;
        for (const chart of Object.values(sheet.charts ?? {})) {
            const moved = mapChartRefs(chart, move, points);
            if (moved === chart) continue;
            charts ??= { ...sheet.charts };
            charts[chart.id] = moved;
        }
        return charts ? { ...sheet, charts } : sheet;
    });
}

// config carries several index-keyed maps (rowlen, rowhidden, customHeight and
// their column twins) that all shift identically when rows/columns move.
function shiftKeyedMapForInsert(
    map: Record<string, number>,
    index: number,
    count: number,
    direction: 'lefttop' | 'rightbottom',
): Record<string, number> {
    const shifted: Record<string, number> = {};
    for (const [key, v] of Object.entries(map)) {
        const i = Number.parseInt(key, 10);
        if (i < index || (i === index && direction === 'rightbottom')) shifted[i] = v;
        else shifted[i + count] = v;
    }
    return shifted;
}

function shiftKeyedMapForDelete(map: Record<string, number>, start: number, end: number): Record<string, number> {
    const shifted: Record<string, number> = {};
    const removeCount = end - start + 1;
    for (const [key, v] of Object.entries(map)) {
        const i = Number.parseInt(key, 10);
        if (i < start) shifted[i] = v;
        else if (i > end) shifted[i - removeCount] = v;
    }
    return shifted;
}

function applyInsert<S extends Sheet>(sheets: S[], targetIndex: number, op: InsertRowColOp): S[] {
    const target = sheets[targetIndex];
    const cfg: ExtendedSheetConfig = target.config ?? {};
    const data = target.data;
    if (!data) return sheets;

    if (op.type === 'row' && cfg.rowReadOnly?.[op.index]) throw new RowColError('readOnly');
    if (op.type === 'column' && cfg.colReadOnly?.[op.index]) throw new RowColError('readOnly');
    if (op.type === 'row' && data.length + op.count > MAX_SHEET_ROW_COUNT) throw new RowColError('maxExceeded');
    if (op.type === 'column' && data[0] && data[0].length + op.count > MAX_SHEET_COLUMN_COUNT)
        throw new RowColError('maxExceeded');

    const { count } = op;
    const newTarget = { ...target };
    const newCfg: ExtendedSheetConfig = { ...target.config };
    const newData = op.type === 'row' ? [...data] : data.map((row) => [...row]);
    newTarget.data = newData;
    const insertAt = op.direction === 'lefttop' ? op.index : op.index + 1;

    newCfg.merge = shiftMergeForInsert(cfg, op.type, op.index, count, op.direction);
    newCfg.borderInfo = shiftCellKeyedForInsert(cfg.borderInfo, op.type, op.index, count, op.direction, cloneSides);

    if (op.type === 'row') {
        if (cfg.rowhidden != null)
            newCfg.rowhidden = shiftKeyedMapForInsert(cfg.rowhidden, op.index, count, op.direction);
        if (cfg.rowlen != null) newCfg.rowlen = shiftKeyedMapForInsert(cfg.rowlen, op.index, count, op.direction);
        if (cfg.customHeight != null)
            newCfg.customHeight = shiftKeyedMapForInsert(cfg.customHeight, op.index, count, op.direction);

        const cols = newData[0]?.length ?? 0;
        const blank = () => new Array<null>(cols).fill(null);
        // Single splice: one-at-a-time inserts re-shift the tail per row.
        const blankRows: (typeof newData)[number][] = [];
        for (let i = 0; i < count; i += 1) blankRows.push(blank());
        newData.splice(insertAt, 0, ...blankRows);
    } else {
        if (cfg.colhidden != null)
            newCfg.colhidden = shiftKeyedMapForInsert(cfg.colhidden, op.index, count, op.direction);
        if (cfg.columnlen != null)
            newCfg.columnlen = shiftKeyedMapForInsert(cfg.columnlen, op.index, count, op.direction);
        if (cfg.customWidth != null)
            newCfg.customWidth = shiftKeyedMapForInsert(cfg.customWidth, op.index, count, op.direction);

        const blanks = new Array<null>(count).fill(null);
        for (const row of newData) {
            row.splice(insertAt, 0, ...blanks);
        }
    }

    newTarget.config = newCfg;

    if (target.conditionalFormatRules != null) {
        newTarget.conditionalFormatRules = target.conditionalFormatRules.map((cf) => ({
            ...cf,
            cellrange: cf.cellrange.map((range) => shiftRangeForInsert(range, op)),
        }));
    }

    const shifted = shiftFormulasAcrossSheets(
        [...sheets.slice(0, targetIndex), newTarget, ...sheets.slice(targetIndex + 1)],
        targetIndex,
        op.type,
        op.direction,
        op.index,
        count,
        'add',
    );
    // An insert stops a chart ref at the grid's last row or column: parseChartSpec refuses a ref past
    // it, which would leave the chart unreadable for good.
    const lastRow = REFERENCE_ROW_COUNT - 1;
    const lastColumn = REFERENCE_COLUMN_COUNT - 1;
    return shiftChartsAcrossSheets(
        shifted,
        op.id,
        (ref) => {
            const moved = shiftRangeForInsert(ref, op);
            if (moved.row[1] <= lastRow && moved.column[1] <= lastColumn) return moved;
            return {
                ...moved,
                row: [Math.min(moved.row[0], lastRow), Math.min(moved.row[1], lastRow)],
                column: [Math.min(moved.column[0], lastColumn), Math.min(moved.column[1], lastColumn)],
            };
        },
        (ref) => pointsForInsert(ref, op),
    );
}

function applyDelete<S extends Sheet>(sheets: S[], targetIndex: number, op: DeleteRowColOp): S[] {
    const target = sheets[targetIndex];
    const data = target.data;
    if (!data) return sheets;

    const cfg: ExtendedSheetConfig = target.config ?? {};

    if (op.type === 'row' && cfg.rowReadOnly) {
        for (let i = op.start; i <= op.end; i += 1) {
            if (cfg.rowReadOnly[i]) throw new RowColError('readOnly');
        }
    }
    if (op.type === 'column' && cfg.colReadOnly) {
        for (let i = op.start; i <= op.end; i += 1) {
            if (cfg.colReadOnly[i]) throw new RowColError('readOnly');
        }
    }

    const newTarget = { ...target };
    const newCfg: ExtendedSheetConfig = { ...target.config };
    const newData = op.type === 'row' ? [...data] : data.map((row) => [...row]);
    newTarget.data = newData;
    const removeCount = op.end - op.start + 1;

    newCfg.merge = shiftMergeForDelete(cfg, op.type, op.start, removeCount);
    newCfg.borderInfo = shiftCellKeyedForDelete(cfg.borderInfo, op.type, op.start, op.end);

    if (op.type === 'row') {
        if (cfg.rowhidden != null) newCfg.rowhidden = shiftKeyedMapForDelete(cfg.rowhidden, op.start, op.end);
        if (cfg.rowlen != null) newCfg.rowlen = shiftKeyedMapForDelete(cfg.rowlen, op.start, op.end);
        if (cfg.customHeight != null) newCfg.customHeight = shiftKeyedMapForDelete(cfg.customHeight, op.start, op.end);

        newData.splice(op.start, removeCount);
    } else {
        if (cfg.colhidden != null) newCfg.colhidden = shiftKeyedMapForDelete(cfg.colhidden, op.start, op.end);
        if (cfg.columnlen != null) newCfg.columnlen = shiftKeyedMapForDelete(cfg.columnlen, op.start, op.end);
        if (cfg.customWidth != null) newCfg.customWidth = shiftKeyedMapForDelete(cfg.customWidth, op.start, op.end);

        for (const row of newData) row.splice(op.start, removeCount);
    }

    newTarget.config = newCfg;

    if (target.conditionalFormatRules != null) {
        const newCFarr = [];
        for (const cf of target.conditionalFormatRules) {
            const cf_new_range: SingleRange[] = [];
            for (const range of cf.cellrange) {
                const shifted = shiftRangeForDelete(range, op);
                if (shifted) cf_new_range.push(shifted);
            }
            if (cf_new_range.length > 0) {
                const first = op.type === 'row' ? cf_new_range[0].row[0] : cf_new_range[0].column[0];
                const shift = first >= op.start ? -removeCount : 0;
                newCFarr.push(
                    op.type === 'row'
                        ? withCfRanges(cf, cf_new_range, shift, 0)
                        : withCfRanges(cf, cf_new_range, 0, shift),
                );
            }
        }
        newTarget.conditionalFormatRules = newCFarr;
    }

    const shifted = shiftFormulasAcrossSheets(
        [...sheets.slice(0, targetIndex), newTarget, ...sheets.slice(targetIndex + 1)],
        targetIndex,
        op.type,
        null,
        op.start,
        removeCount,
        'del',
    );
    return shiftChartsAcrossSheets(
        shifted,
        op.id,
        (ref) => shiftRangeForDelete(ref, op),
        (ref) => pointsForDelete(ref, op),
    );
}
