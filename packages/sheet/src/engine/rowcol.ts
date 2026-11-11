// Inserting and deleting rows and columns on plain sheets, without the DOM: the cells, the config with its merges,
// borders and row heights, conditional formats, validation rules, frozen pane, filter and size of the sheet the op
// names, and the formula text and chart ranges on every sheet that point at it. Every index and range but the formula
// text moves through mapIndex and mapSpan, the formula package's one rule for a line that moved. It runs wherever
// such an op applies, such as the editor's own insert and the server's replay of the op log.

import type { Edit } from '@workspace/formula/text';
import { GONE, mapIndex, mapSpan } from '@workspace/formula/text';
import type { CellMatrix, MergeCell, Sheet, SheetChart } from '@workspace/lib/sheets';
import {
    cloneSides,
    freezesColumns,
    freezesRows,
    MAX_GRID_SLOTS,
    parseCellKey,
    REFERENCE_COLUMN_COUNT,
    REFERENCE_ROW_COUNT,
    sheetFitsGrid,
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

// An insert past a size limit throws this, and every reader skips its whole batch. Its message is the editor's notice.
export class RowColError extends Error {}

type InsertLines = Pick<InsertRowColOp, 'type' | 'index' | 'count' | 'direction'>;
type DeleteLines = Pick<DeleteRowColOp, 'type' | 'start' | 'end'>;

// What a row or column op does to the lines on its axis: `edit` is the op as mapIndex and mapSpan read it, `at` the
// first line it adds or deletes, and `to` says where a line goes, null for one that is gone.
export type LineMove = { edit: Edit; at: number; to: (line: number) => number | null };

export function lineMove(op: InsertLines | DeleteLines): LineMove {
    const lines = op.type === 'row' ? REFERENCE_ROW_COUNT : REFERENCE_COLUMN_COUNT;
    const edit: Edit =
        'index' in op
            ? { insert: true, index: op.direction === 'lefttop' ? op.index : op.index + 1, count: op.count, lines }
            : { insert: false, index: op.start, count: op.end - op.start + 1, lines };
    const to = (line: number) => {
        const moved = mapIndex(edit, line);
        return moved === GONE ? null : moved;
    };
    return { edit, at: edit.index, to };
}

type AxisRange = { row: readonly number[]; column: readonly number[] };

// Excel's rule: an insert at or before a range's first line moves it, one inside grows it, one right after leaves it,
// and a delete shrinks it to what survives, null when it takes all of it. A range left as it was comes back as itself,
// so its owner writes nothing.
function shiftRange<R extends AxisRange>(range: R, type: 'row' | 'column', edit: Edit): R | null {
    const [start, end] = type === 'row' ? range.row : range.column;
    const span = { start, end };
    if (!mapSpan(edit, start, end, span)) {
        if (!edit.insert) return null;
        // A range an insert pushes off the grid stays on the last line, where a chart can still read it.
        span.start = edit.lines - 1;
        span.end = edit.lines - 1;
    }
    if (span.start === start && span.end === end) return range;
    const moved: [number, number] = [span.start, span.end];
    return type === 'row' ? { ...range, row: moved } : { ...range, column: moved };
}

// The undo stacks move one range or one merge map at a time, and name the op by its fields.
export function shiftRangeForInsert<R extends AxisRange>(range: R, op: InsertLines): R | null {
    return shiftRange(range, op.type, lineMove(op).edit);
}

export function shiftRangeForDelete<R extends AxisRange>(range: R, op: DeleteLines): R | null {
    return shiftRange(range, op.type, lineMove(op).edit);
}

export function shiftMergeForInsert(
    cfg: ExtendedSheetConfig,
    type: 'row' | 'column',
    index: number,
    count: number,
    direction: 'lefttop' | 'rightbottom',
): Record<string, MergeCell> {
    return shiftMerges(cfg, type, lineMove({ type, index, count, direction }).edit);
}

export function shiftMergeForDelete(
    cfg: ExtendedSheetConfig,
    type: 'row' | 'column',
    start: number,
    slen: number,
): Record<string, MergeCell> {
    return shiftMerges(cfg, type, lineMove({ type, start, end: start + slen - 1 }).edit);
}

// Merges that overlap, as two tabs merging at once leave them, land and stamp their cells in turn. The turn is the
// keys' order, since two readers may hold the same map written in different orders.
function shiftMerges(
    { merge = {} }: ExtendedSheetConfig,
    type: 'row' | 'column',
    edit: Edit,
): Record<string, MergeCell> {
    const shifted: Record<string, MergeCell> = {};
    const span = { start: 0, end: 0 };
    for (const key of Object.keys(merge).sort()) {
        const { r, c, rs, cs } = merge[key];
        if (!mapSpan(edit, type === 'row' ? r : c, type === 'row' ? r + rs - 1 : c + cs - 1, span)) continue;
        const size = span.end - span.start + 1;
        const placed =
            type === 'row' ? { ...merge[key], r: span.start, rs: size } : { ...merge[key], c: span.start, cs: size };
        shifted[`${placed.r}_${placed.c}`] = placed;
    }
    return shifted;
}

// Re-keys an "r_c" map, an entry on a line the op deletes dropped.
export function shiftCellKeyed<T>(
    map: Record<string, T> | undefined,
    axis: 'row' | 'column',
    { edit }: LineMove,
): Record<string, T> {
    const shifted: Record<string, T> = {};
    for (const key in map) {
        const [r, c] = parseCellKey(key);
        const line = mapIndex(edit, axis === 'row' ? r : c);
        if (line !== GONE) shifted[axis === 'row' ? `${line}_${c}` : `${r}_${line}`] = map[key];
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
    type: 'row' | 'column',
    edit: Edit,
): S[] {
    const move = (ref: CellRangeRef) => (ref.sheetId === sheetId ? shiftRange(ref, type, edit) : ref);
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

export function shiftKeyedMap(map: Record<string, number>, { edit }: LineMove): Record<string, number> {
    const shifted: Record<string, number> = {};
    for (const [key, v] of Object.entries(map)) {
        const line = mapIndex(edit, Number.parseInt(key, 10));
        if (line !== GONE) shifted[line] = v;
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

    const rows = data.length + (op.type === 'row' ? op.count : 0);
    const columns = (data[0]?.length ?? 0) + (op.type === 'column' ? op.count : 0);
    if (op.type === 'row' && rows > MAX_SHEET_ROW_COUNT) {
        throw new RowColError(`${MAX_SHEET_ROW_COUNT} row limit exceeded`);
    }
    if (op.type === 'column' && data[0] && columns > MAX_SHEET_COLUMN_COUNT) {
        throw new RowColError(`${MAX_SHEET_COLUMN_COUNT} column limit exceeded`);
    }
    // An imported sheet may be taller or wider than an insert's limits, so a line on its other axis can pass the
    // bound on the grid a reader may build, and a sheet stored past it fails every later open.
    if (!sheetFitsGrid({ row: rows, column: columns })) {
        throw new RowColError(`${MAX_GRID_SLOTS.toLocaleString('en-US')} cell limit exceeded`);
    }

    const { count } = op;
    const newTarget = { ...target };
    const newCfg: ExtendedSheetConfig = { ...target.config };
    const newData = op.type === 'row' ? [...data] : data.map((row) => [...row]);
    newTarget.data = newData;
    const move = lineMove(op);
    const insertAt = move.at;

    newCfg.merge = shiftMerges(cfg, op.type, move.edit);
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

    const moved = (range: SingleRange) => shiftRange(range, op.type, move.edit);
    if (target.conditionalFormats != null) newTarget.conditionalFormats = shiftRules(target.conditionalFormats, moved);
    if (target.dataValidations != null) newTarget.dataValidations = shiftRules(target.dataValidations, moved);
    const frozen = shiftFrozen(target.frozen, op.type, move.edit);
    if (frozen !== target.frozen) newTarget.frozen = frozen;
    shiftFilter(newTarget, newCfg, op.type, move);

    const shifted = shiftFormulasAcrossSheets(
        [...sheets.slice(0, targetIndex), newTarget, ...sheets.slice(targetIndex + 1)],
        targetIndex,
        op.type,
        op.direction,
        op.index,
        count,
        'add',
    );
    return shiftChartsAcrossSheets(shifted, op.id, op.type, move.edit);
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

    newCfg.merge = shiftMerges(cfg, op.type, move.edit);
    newCfg.borderInfo = shiftCellKeyed(cfg.borderInfo, op.type, move);
    shiftLineMaps(cfg, newCfg, op.type, move);

    if (op.type === 'row') newData.splice(op.start, removeCount);
    else for (const row of newData) row.splice(op.start, removeCount);

    stampMerges(newData, newCfg.merge, op.type, op.start);
    newTarget.config = newCfg;
    setSize(newTarget, newData, op.type);

    const kept = (range: SingleRange) => shiftRange(range, op.type, move.edit);
    if (target.conditionalFormats != null) {
        // A formula rule reads from its first range's corner, which moves up or left when the delete is before it.
        newTarget.conditionalFormats = shiftRules(target.conditionalFormats, kept, (rule, ranges) => {
            const first = op.type === 'row' ? ranges[0].row[0] : ranges[0].column[0];
            const shift = first >= op.start ? -removeCount : 0;
            return op.type === 'row' ? withCfRanges(rule, ranges, shift, 0) : withCfRanges(rule, ranges, 0, shift);
        });
    }
    if (target.dataValidations != null) newTarget.dataValidations = shiftRules(target.dataValidations, kept);
    const frozen = shiftFrozen(target.frozen, op.type, move.edit);
    if (frozen !== target.frozen) newTarget.frozen = frozen;
    shiftFilter(newTarget, newCfg, op.type, move);

    const shifted = shiftFormulasAcrossSheets(
        [...sheets.slice(0, targetIndex), newTarget, ...sheets.slice(targetIndex + 1)],
        targetIndex,
        op.type,
        null,
        op.start,
        removeCount,
        'del',
    );
    return shiftChartsAcrossSheets(shifted, op.id, op.type, move.edit);
}

function shiftLineMaps(cfg: ExtendedSheetConfig, next: ExtendedSheetConfig, type: 'row' | 'column', move: LineMove) {
    for (const key of LINE_MAPS[type]) {
        const map = cfg[key];
        if (map != null) next[key] = shiftKeyedMap(map, move);
    }
}

// Moves the ranges of every rule in a sheet's conditional formats or validation rules, and drops a rule left with
// none. A rule that stays is the same object, and so is the record, so only a rule that moved is written, by its id.
export function shiftRules<R extends { ranges: SingleRange[] }>(
    rules: Readonly<Record<string, R>>,
    shift: (range: SingleRange) => SingleRange | null,
    withRanges: (rule: R, ranges: SingleRange[]) => R = (rule, ranges) => ({ ...rule, ranges }),
): Record<string, R> {
    let shifted: Record<string, R> | null = null;
    for (const [id, rule] of Object.entries(rules)) {
        const ranges = rule.ranges.flatMap((range) => shift(range) ?? []);
        if (ranges.length === rule.ranges.length && ranges.every((range, i) => range === rule.ranges[i])) continue;
        shifted ??= { ...rules };
        if (ranges.length > 0) shifted[id] = withRanges(rule, ranges);
        else delete shifted[id];
    }
    return shifted ?? rules;
}

// The frozen pane, the lines from the first to `row_focus` or `column_focus`, moved whole, since a peer's unfreeze
// removes `frozen` and a write into it would not apply. A delete of the whole band ends that axis's freeze, and the
// pane goes with its last axis.
function shiftFrozen(frozen: Sheet['frozen'], type: 'row' | 'column', edit: Edit): Sheet['frozen'] {
    const axis = type === 'row' ? 'row_focus' : 'column_focus';
    const focus = frozen?.range?.[axis] ?? -1;
    if (!frozen?.range || focus < 0 || !(type === 'row' ? freezesRows(frozen) : freezesColumns(frozen))) return frozen;
    const pane = { start: 0, end: focus };
    if (mapSpan(edit, 0, focus, pane)) {
        return pane.end === focus ? frozen : { ...frozen, range: { ...frozen.range, [axis]: pane.end } };
    }
    if (!(type === 'row' ? freezesColumns(frozen) : freezesRows(frozen))) return undefined;
    return { type: type === 'row' ? 'rangeColumn' : 'rangeRow', range: { ...frozen.range, [axis]: 0 } };
}

// The filter moves with the rows: its range, the column each entry sits on and the rows each entry hides. An entry is
// keyed by its column's offset from the filter's first column, so a column op re-keys the entries. Deleting the
// filter's first row, the header that holds its buttons, removes the filter. A column delete keeps the filter while
// any of its columns are left, and a delete of every row an entry hides takes the entry.
function shiftFilter(sheet: ShiftedSheet, cfg: ExtendedSheetConfig, type: 'row' | 'column', move: LineMove) {
    const { filterRange, filter } = sheet;
    if (!filterRange?.row) return;
    const { edit } = move;
    const deletesHeader = type === 'row' && !edit.insert && mapIndex(edit, filterRange.row[0]) === GONE;
    const range = deletesHeader ? null : shiftRange(filterRange, type, edit);
    if (!range) {
        writeFilter(sheet, cfg, undefined, undefined);
        return;
    }
    const shifted: Record<string, FilterEntry> = {};
    for (const [key, entry] of Object.entries(filter ?? {})) {
        if (type === 'row') {
            const rowhidden = shiftKeyedMap(entry.rowhidden ?? {}, move);
            if (edit.insert || Object.keys(rowhidden).length > 0) {
                shifted[key] = { ...entry, rowhidden, str: range.row[0], edr: range.row[1] };
            }
        } else {
            const cindex = mapIndex(edit, entry.cindex);
            if (cindex === GONE) continue;
            shifted[cindex - range.column[0]] = { ...entry, cindex, stc: range.column[0], edc: range.column[1] };
        }
    }
    const kept = edit.insert ? filter && shifted : Object.keys(shifted).length > 0 ? shifted : undefined;
    writeFilter(sheet, cfg, range, kept);
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
