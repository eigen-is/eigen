// Inserting and deleting rows and columns on plain sheets, without the DOM: the cells, the config with its merges,
// borders and row heights, conditional formats, validation rules, frozen pane, filter and size of the sheet
// the op names, and the formula text and chart ranges on every sheet that point at it. It runs wherever such an op
// applies, for example in the editor's own insert and in the server's replay of the op log. The shifters for one kind
// of map are exported for code that moves the same maps, such as the undo stacks.

import type { CellMatrix, MergeCell, Sheet, SheetChart, SheetValidation } from '@workspace/lib/sheets';
import {
    cloneSides,
    freezesColumns,
    freezesRows,
    parseCellKey,
    REFERENCE_COLUMN_COUNT,
    REFERENCE_ROW_COUNT,
} from '@workspace/lib/sheets';
import type { CellRangeRef } from '@workspace/lib/types/chart';
import { sheetFinder } from './a1-notation';
import { mapChartRefs } from './chart-data';
import { withCfRanges } from './conditional-format';
import { MAX_SHEET_COLUMN_COUNT, MAX_SHEET_ROW_COUNT } from './defaults';
import { functionStrChange, mayShiftOffSheet, rewriteSheetFormulas } from './formula-shift';
import type { ExtendedSheetConfig, FilterEntry, ShiftedSheet, SingleRange } from './types';

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

// An insert past the sheet's size limit throws this, and every reader skips its whole batch.
export class RowColError extends Error {}

type InsertLines = Pick<InsertRowColOp, 'index' | 'count' | 'direction'>;
type DeleteLines = Pick<DeleteRowColOp, 'start' | 'end'>;

// What a row or column op does to the lines on its axis: `at` is the first line it adds or deletes, and `to` says
// where a line goes, null for one it deletes.
export type LineMove = { at: number; to: (line: number) => number | null };

export function lineMove(op: InsertLines): { at: number; to: (line: number) => number };
export function lineMove(op: InsertLines | DeleteLines): LineMove;
export function lineMove(op: InsertLines | DeleteLines): LineMove {
    if ('index' in op) {
        const at = op.direction === 'lefttop' ? op.index : op.index + 1;
        return { at, to: (line) => (line < at ? line : line + op.count) };
    }
    const count = op.end - op.start + 1;
    return { at: op.start, to: (line) => (line < op.start ? line : line > op.end ? line - count : null) };
}

type AxisRange = { row: readonly number[]; column: readonly number[] };

// Excel's rule: an insert at or before a range's first line moves it, one inside grows it, one right after leaves it,
// and it stops at the grid's last line. A range left as it was comes back as itself, so its owner writes nothing.
export function shiftRangeForInsert<R extends AxisRange>(
    range: R,
    op: Pick<InsertRowColOp, 'type' | 'index' | 'count' | 'direction'>,
): R {
    const { at: insertAt } = lineMove(op);
    const [start, end] = op.type === 'row' ? range.row : range.column;
    if (insertAt > end) return range;
    const last = (op.type === 'row' ? REFERENCE_ROW_COUNT : REFERENCE_COLUMN_COUNT) - 1;
    const moved = (line: number) => Math.min(line + op.count, last);
    const span: [number, number] = insertAt <= start ? [moved(start), moved(end)] : [start, moved(end)];
    if (span[0] === start && span[1] === end) return range;
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

export function shiftMergeForInsert(
    cfg: ExtendedSheetConfig,
    type: 'row' | 'column',
    index: number,
    count: number,
    direction: 'lefttop' | 'rightbottom',
): Record<string, MergeCell> {
    const shifted: Record<string, MergeCell> = {};
    for (const merge of Object.values(cfg.merge ?? {})) {
        const [first, span] = type === 'row' ? [merge.r, merge.rs] : [merge.c, merge.cs];
        const last = first + span - 1;
        const above = direction === 'lefttop';
        if (index < first || (index === first && above)) placeMerge(shifted, merge, type, first + count, span);
        else if (index === first || index < last || (index === last && above)) {
            placeMerge(shifted, merge, type, first, span + count);
        } else placeMerge(shifted, merge, type, first, span);
    }
    return shifted;
}

export function shiftMergeForDelete(
    cfg: ExtendedSheetConfig,
    type: 'row' | 'column',
    start: number,
    slen: number,
): Record<string, MergeCell> {
    const end = start + slen - 1;
    const shifted: Record<string, MergeCell> = {};
    for (const merge of Object.values(cfg.merge ?? {})) {
        const [first, span] = type === 'row' ? [merge.r, merge.rs] : [merge.c, merge.cs];
        const last = first + span - 1;
        if (first > end) placeMerge(shifted, merge, type, first - slen, span);
        else if (first >= start) {
            if (last > end) placeMerge(shifted, merge, type, start, last - end);
        } else if (last < start) placeMerge(shifted, merge, type, first, span);
        else placeMerge(shifted, merge, type, first, last >= end ? span - slen : start - first);
    }
    return shifted;
}

function placeMerge(
    merges: Record<string, MergeCell>,
    merge: MergeCell,
    type: 'row' | 'column',
    first: number,
    span: number,
) {
    const placed = type === 'row' ? { ...merge, r: first, rs: span } : { ...merge, c: first, cs: span };
    merges[`${placed.r}_${placed.c}`] = placed;
}

// Re-keys an "r_c" map, an entry on a line the op deletes dropped.
export function shiftCellKeyed<T>(
    map: Record<string, T> | undefined,
    axis: 'row' | 'column',
    { to }: LineMove,
): Record<string, T> {
    const shifted: Record<string, T> = {};
    for (const key in map) {
        const [r, c] = parseCellKey(key);
        const line = to(axis === 'row' ? r : c);
        if (line != null) shifted[axis === 'row' ? `${line}_${c}` : `${r}_${line}`] = map[key];
    }
    return shifted;
}

// An op on one sheet moves only the refs that resolve to it: unqualified ones on it and `Sheet!`-qualified ones
// anywhere, a conditional format's formula rule among them.
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
    const findSheet = sheetFinder(sheets);
    const mayShift = mayShiftOffSheet(targetName);
    return sheets.map((sheet, sheetIndex) =>
        rewriteSheetFormulas(sheet, (txt) => {
            if (sheetIndex !== targetIndex && !mayShift(txt)) return txt;
            const shifted = functionStrChange(
                txt,
                op,
                type === 'row' ? 'row' : 'col',
                direction,
                index,
                count,
                targetName,
                sheetIndex === targetIndex,
                findSheet,
            );
            return txt.startsWith('=') ? `=${shifted}` : shifted;
        }),
    );
}

// A chart ref names its sheet by id, so an op moves the refs to its sheet on every sheet's charts. Only a chart whose
// refs moved is rewritten.
function shiftChartsAcrossSheets<S extends Sheet>(
    sheets: S[],
    sheetId: string,
    shift: (ref: CellRangeRef) => CellRangeRef | null,
): S[] {
    const move = (ref: CellRangeRef) => (ref.sheetId === sheetId ? shift(ref) : ref);
    return sheets.map((sheet) => {
        let charts: Record<string, SheetChart> | null = null;
        for (const chart of Object.values(sheet.charts ?? {})) {
            const moved = mapChartRefs(chart, move);
            if (moved === chart) continue;
            charts ??= { ...sheet.charts };
            charts[chart.id] = moved;
        }
        return charts ? { ...sheet, charts } : sheet;
    });
}

// A sheet's config keeps several maps keyed by a row or column index, such as a row's height or whether it is hidden.
// All of them shift the same way when rows or columns move.
export const LINE_MAPS = {
    row: ['rowhidden', 'rowlen', 'customHeight'],
    column: ['colhidden', 'columnlen', 'customWidth'],
} as const;

export function shiftKeyedMap(map: Record<string, number>, { to }: LineMove): Record<string, number> {
    const shifted: Record<string, number> = {};
    for (const [key, v] of Object.entries(map)) {
        const line = to(Number.parseInt(key, 10));
        if (line != null) shifted[line] = v;
    }
    return shifted;
}

// Nothing is deep-cloned or written in place, since in the editor the inputs may be drafts: rows an op doesn't touch
// keep their objects. The values the op leaves stale are recomputeAfter's.
export function applySheetsInsertRowCol<S extends ShiftedSheet>(sheets: S[], op: InsertRowColOp): S[] {
    const targetIndex = sheets.findIndex((s) => s.id === op.id);
    if (targetIndex === -1) return sheets;
    const target = sheets[targetIndex];
    const cfg: ExtendedSheetConfig = target.config ?? {};
    const data = target.data;
    if (!data) return sheets;

    if (op.type === 'row' && data.length + op.count > MAX_SHEET_ROW_COUNT) throw new RowColError();
    if (op.type === 'column' && data[0] && data[0].length + op.count > MAX_SHEET_COLUMN_COUNT) throw new RowColError();

    const { count } = op;
    const newTarget = { ...target };
    const newCfg: ExtendedSheetConfig = { ...target.config };
    const newData = op.type === 'row' ? [...data] : data.map((row) => [...row]);
    newTarget.data = newData;
    const move = lineMove(op);
    const insertAt = move.at;

    newCfg.merge = shiftMergeForInsert(cfg, op.type, op.index, count, op.direction);
    const borderInfo = shiftCellKeyed(cfg.borderInfo, op.type, move);
    // The new lines take the borders of the line they were inserted beside.
    for (const [key, sides] of Object.entries(cfg.borderInfo ?? {})) {
        const [r, c] = parseCellKey(key);
        if ((op.type === 'row' ? r : c) !== op.index) continue;
        for (let line = insertAt; line < insertAt + count; line += 1) {
            borderInfo[op.type === 'row' ? `${line}_${c}` : `${r}_${line}`] = cloneSides(sides);
        }
    }
    newCfg.borderInfo = borderInfo;
    shiftLineMaps(cfg, newCfg, op.type, move);

    if (op.type === 'row') {
        const cols = newData[0]?.length ?? 0;
        const blank = () => new Array<null>(cols).fill(null);
        // One splice for all the new rows, because inserting them one by one would move the rows below each time.
        const blankRows: (typeof newData)[number][] = [];
        for (let i = 0; i < count; i += 1) blankRows.push(blank());
        newData.splice(insertAt, 0, ...blankRows);
    } else {
        const blanks = new Array<null>(count).fill(null);
        for (const row of newData) {
            row.splice(insertAt, 0, ...blanks);
        }
    }

    stampMerges(newData, newCfg.merge, op.type, insertAt);
    newTarget.config = newCfg;
    setSize(newTarget, newData, op.type);

    if (target.conditionalFormatRules != null) {
        newTarget.conditionalFormatRules = target.conditionalFormatRules.map((cf) => ({
            ...cf,
            cellrange: cf.cellrange.map((range) => shiftRangeForInsert(range, op)),
        }));
    }
    if (target.dataValidations != null) {
        newTarget.dataValidations = shiftValidations(target.dataValidations, (range) => shiftRangeForInsert(range, op));
    }
    const frozen = shiftFrozen(target.frozen, op.type, move);
    if (frozen !== target.frozen) newTarget.frozen = frozen;
    shiftFilterForInsert(newTarget, newCfg, op);

    const shifted = shiftFormulasAcrossSheets(
        [...sheets.slice(0, targetIndex), newTarget, ...sheets.slice(targetIndex + 1)],
        targetIndex,
        op.type,
        op.direction,
        op.index,
        count,
        'add',
    );
    return shiftChartsAcrossSheets(shifted, op.id, (ref) => shiftRangeForInsert(ref, op));
}

export function applySheetsDeleteRowCol<S extends ShiftedSheet>(sheets: S[], op: DeleteRowColOp): S[] {
    const targetIndex = sheets.findIndex((s) => s.id === op.id);
    if (targetIndex === -1) return sheets;
    const target = sheets[targetIndex];
    const data = target.data;
    if (!data) return sheets;

    const cfg: ExtendedSheetConfig = target.config ?? {};

    const newTarget = { ...target };
    const newCfg: ExtendedSheetConfig = { ...target.config };
    const newData = op.type === 'row' ? [...data] : data.map((row) => [...row]);
    newTarget.data = newData;
    const removeCount = op.end - op.start + 1;
    const move = lineMove(op);

    newCfg.merge = shiftMergeForDelete(cfg, op.type, op.start, removeCount);
    newCfg.borderInfo = shiftCellKeyed(cfg.borderInfo, op.type, move);
    shiftLineMaps(cfg, newCfg, op.type, move);

    if (op.type === 'row') newData.splice(op.start, removeCount);
    else for (const row of newData) row.splice(op.start, removeCount);

    stampMerges(newData, newCfg.merge, op.type, op.start);
    newTarget.config = newCfg;
    setSize(newTarget, newData, op.type);

    if (target.conditionalFormatRules != null) {
        const rules = [];
        for (const cf of target.conditionalFormatRules) {
            const ranges: SingleRange[] = [];
            for (const range of cf.cellrange) {
                const shifted = shiftRangeForDelete(range, op);
                if (shifted) ranges.push(shifted);
            }
            if (ranges.length > 0) {
                const first = op.type === 'row' ? ranges[0].row[0] : ranges[0].column[0];
                const shift = first >= op.start ? -removeCount : 0;
                rules.push(op.type === 'row' ? withCfRanges(cf, ranges, shift, 0) : withCfRanges(cf, ranges, 0, shift));
            }
        }
        newTarget.conditionalFormatRules = rules;
    }
    if (target.dataValidations != null) {
        newTarget.dataValidations = shiftValidations(target.dataValidations, (range) => shiftRangeForDelete(range, op));
    }
    const frozen = shiftFrozen(target.frozen, op.type, move);
    if (frozen !== target.frozen) newTarget.frozen = frozen;
    shiftFilterForDelete(newTarget, newCfg, op);

    const shifted = shiftFormulasAcrossSheets(
        [...sheets.slice(0, targetIndex), newTarget, ...sheets.slice(targetIndex + 1)],
        targetIndex,
        op.type,
        null,
        op.start,
        removeCount,
        'del',
    );
    return shiftChartsAcrossSheets(shifted, op.id, (ref) => shiftRangeForDelete(ref, op));
}

function shiftLineMaps(cfg: ExtendedSheetConfig, next: ExtendedSheetConfig, type: 'row' | 'column', move: LineMove) {
    for (const key of LINE_MAPS[type]) {
        const map = cfg[key];
        if (map != null) next[key] = shiftKeyedMap(map, move);
    }
}

// Moves every validation rule's ranges, and drops a rule left with none. A rule whose ranges stay where they were is
// kept as the same object, and so is the map when no rule moved.
export function shiftValidations(
    validations: Readonly<Record<string, SheetValidation>>,
    shift: (range: SingleRange) => SingleRange | null,
): Record<string, SheetValidation> {
    let shifted: Record<string, SheetValidation> | null = null;
    for (const [id, entry] of Object.entries(validations)) {
        const ranges = entry.ranges.flatMap((range) => shift(range) ?? []);
        if (ranges.length === entry.ranges.length && ranges.every((range, i) => range === entry.ranges[i])) continue;
        shifted ??= { ...validations };
        if (ranges.length > 0) shifted[id] = { ...entry, ranges };
        else delete shifted[id];
    }
    return shifted ?? validations;
}

// The frozen pane, moved whole, since a peer's unfreeze removes `frozen` and a write into it would not apply. A delete
// of the whole band ends that axis's freeze, and the pane goes with its last axis.
function shiftFrozen(frozen: Sheet['frozen'], type: 'row' | 'column', { at, to }: LineMove): Sheet['frozen'] {
    if (!frozen?.range || !(type === 'row' ? freezesRows(frozen) : freezesColumns(frozen))) return frozen;
    const axis = type === 'row' ? 'row_focus' : 'column_focus';
    const focus = to(frozen.range[axis]) ?? at - 1;
    if (focus === frozen.range[axis]) return frozen;
    if (focus >= 0) return { ...frozen, range: { ...frozen.range, [axis]: focus } };
    if (!(type === 'row' ? freezesColumns(frozen) : freezesRows(frozen))) return undefined;
    return { type: type === 'row' ? 'rangeColumn' : 'rangeRow', range: { ...frozen.range, [axis]: 0 } };
}

// The filter moves with the rows: its range, the column each entry sits on and the rows each entry hides. An entry is
// keyed by its column's offset from the filter's first column, so a column op re-keys the entries.
function shiftFilterForInsert(sheet: ShiftedSheet, cfg: ExtendedSheetConfig, op: InsertRowColOp) {
    const { filterRange, filter } = sheet;
    if (!filterRange?.row) return;
    const range = shiftRangeForInsert(filterRange, op);
    const move = lineMove(op);
    const shifted: Record<string, FilterEntry> = {};
    for (const [key, entry] of Object.entries(filter ?? {})) {
        if (op.type === 'row') {
            const rowhidden = shiftKeyedMap(entry.rowhidden ?? {}, move);
            shifted[key] = { ...entry, rowhidden, str: range.row[0], edr: range.row[1] };
        } else {
            const cindex = move.to(entry.cindex);
            shifted[cindex - range.column[0]] = { ...entry, cindex, stc: range.column[0], edc: range.column[1] };
        }
    }
    writeFilter(sheet, cfg, range, filter && shifted);
}

// Deleting the filter's first row, the header that holds its buttons, removes the filter. A column delete keeps the
// filter while any of its columns are left.
function shiftFilterForDelete(sheet: ShiftedSheet, cfg: ExtendedSheetConfig, op: DeleteRowColOp) {
    const { filterRange, filter } = sheet;
    if (!filterRange?.row) return;
    const { type, start, end } = op;
    const move = lineMove(op);
    const deletesHeader = type === 'row' && filterRange.row[0] >= start && filterRange.row[0] <= end;
    const range = deletesHeader ? null : shiftRangeForDelete(filterRange, op);
    if (!range) {
        writeFilter(sheet, cfg, undefined, undefined);
        return;
    }
    const shifted: Record<string, FilterEntry> = {};
    for (const [key, entry] of Object.entries(filter ?? {})) {
        if (type === 'row') {
            const rowhidden = shiftKeyedMap(entry.rowhidden ?? {}, move);
            if (Object.keys(rowhidden).length > 0) {
                shifted[key] = { ...entry, rowhidden, str: range.row[0], edr: range.row[1] };
            }
        } else {
            const cindex = move.to(entry.cindex);
            if (cindex == null) continue;
            shifted[cindex - range.column[0]] = { ...entry, cindex, stc: range.column[0], edc: range.column[1] };
        }
    }
    writeFilter(sheet, cfg, range, Object.keys(shifted).length > 0 ? shifted : undefined);
}

// The rows a filter hides are hidden rows of the sheet too. The sheet and its config are the op's own copies, but
// the hidden-row map may still be the one the sheet had before the op, so it is copied before a write.
function writeFilter(
    sheet: ShiftedSheet,
    cfg: ExtendedSheetConfig,
    range: SingleRange | undefined,
    filter: Record<string, FilterEntry> | undefined,
) {
    sheet.filterRange = range;
    sheet.filter = filter;
    if (!filter) return;
    const hidden = Object.values(filter).flatMap((entry) => Object.keys(entry.rowhidden ?? {}));
    if (cfg.rowhidden && hidden.every((row) => cfg.rowhidden?.[row] != null)) return;
    cfg.rowhidden = { ...cfg.rowhidden };
    for (const row of hidden) cfg.rowhidden[row] = 0;
}

// The op moved the cells from `from` on but not their `mc` stamps, so each merge reaching that far, or ending right
// before it, stamps its cells again within each row. A row the op shares with the sheet before it is copied first.
function stampMerges(data: CellMatrix, merges: Record<string, MergeCell>, type: 'row' | 'column', from: number) {
    const copied = new Set<number>();
    for (const { r, c, rs, cs } of Object.values(merges)) {
        if ((type === 'row' ? r + rs : c + cs) < from) continue;
        for (let i = r; i < r + rs; i += 1) {
            if (!data[i]) continue;
            if (type === 'row' && !copied.has(i)) {
                data[i] = [...data[i]];
                copied.add(i);
            }
            for (let j = c; j < Math.min(c + cs, data[i].length); j += 1) {
                const mc = i === r && j === c ? { r, c, rs, cs } : { r, c };
                data[i][j] = { ...data[i][j], mc };
            }
        }
    }
}

// A stored sheet keeps its size in `row` and `column`, and a reader builds the matrix at that size. A size behind the
// cells would cut the last rows off the next snapshot, so the size follows the cells after every row or column op.
function setSize(sheet: Sheet, data: CellMatrix, type: 'row' | 'column') {
    if (type === 'row') sheet.row = data.length;
    else sheet.column = data[0]?.length;
}
