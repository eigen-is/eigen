// How a peer's batch changes this tab's pending undos. Any batch ends your own structural entries, such as a row op or
// a rename, and with them everything older (dropStructuralEntries). A row or column op then moves what is left, the cell
// and field entries: shiftEntries moves their paths and values as the op moves the live sheets, so an undo lands where
// its cell now is. The Workbook's applyOp runs both, and a RowColMove also moves the open editor along an applied op.

import type { MergeCell, SheetChart } from '@workspace/lib/sheets';
import type { Patch } from 'immer';
import { sheetFinder } from '../../engine/a1-notation';
import { mapChartRefs } from '../../engine/chart-data';
import { functionStrChange } from '../../engine/formula-shift';
import type { DeleteRowColOp, InsertRowColOp } from '../../engine/rowcol';
import {
    shiftCellKeyedForDelete,
    shiftCellKeyedForInsert,
    shiftKeyedMapForDelete,
    shiftKeyedMapForInsert,
    shiftMergeForDelete,
    shiftMergeForInsert,
    shiftRangeForDelete,
    shiftRangeForInsert,
    shiftValidations,
} from '../../engine/rowcol';
import type { CalcChainEntry, Cell, SingleRange } from '../../engine/types';
import type { History, Op, Sheet, SheetValidation } from '../types';
import type { PatchOptions } from '../utils';

// What one row or column op does to the indices on its axis, with the engine's shifter for each kind of map.
type RowColMove = {
    id: string;
    type: 'row' | 'column';
    // Where an index ends up, or null for a row or column the op deletes.
    to: (index: number) => number | null;
    formula: (
        text: string,
        sheetName: string,
        onTargetSheet: boolean,
        findSheet: (name: string) => Sheet | undefined,
    ) => string;
    merge: (merge: Record<string, MergeCell>) => Record<string, MergeCell>;
    keyed: (map: Record<string, number>) => Record<string, number>;
    cellKeyed: <T>(map: Record<string, T>) => Record<string, T>;
    // Where a range ends up, or null for one the op deletes.
    range: (range: SingleRange) => SingleRange | null;
};

export function rowColMove({ insertRowColOp, deleteRowColOp }: PatchOptions = {}): RowColMove | undefined {
    if (insertRowColOp) return insertMove(insertRowColOp);
    if (deleteRowColOp) return deleteMove(deleteRowColOp);
    return undefined;
}

function insertMove(op: InsertRowColOp): RowColMove {
    const { id, type, index, count, direction } = op;
    const at = direction === 'lefttop' ? index : index + 1;
    return {
        id,
        type,
        to: (i) => (i < at ? i : i + count),
        formula: (text, name, onTargetSheet, findSheet) =>
            functionStrChange(text, 'add', axisName(type), direction, index, count, name, onTargetSheet, findSheet),
        merge: (merge) => shiftMergeForInsert({ merge }, type, index, count, direction),
        keyed: (map) => shiftKeyedMapForInsert(map, index, count, direction),
        cellKeyed: (map) => shiftCellKeyedForInsert(map, type, index, count, direction),
        range: (range) => shiftRangeForInsert(range, op),
    };
}

function deleteMove(op: DeleteRowColOp): RowColMove {
    const { id, type, start, end } = op;
    const count = end - start + 1;
    return {
        id,
        type,
        to: (i) => (i < start ? i : i > end ? i - count : null),
        formula: (text, name, onTargetSheet, findSheet) =>
            functionStrChange(text, 'del', axisName(type), null, start, count, name, onTargetSheet, findSheet),
        merge: (merge) => shiftMergeForDelete({ merge }, type, start, count),
        keyed: (map) => shiftKeyedMapForDelete(map, start, end),
        cellKeyed: (map) => shiftCellKeyedForDelete(map, type, start, end),
        range: (range) => shiftRangeForDelete(range, op),
    };
}

// A structural entry records the workbook it found and left, as whole fields and matrices or as a sheet's old name, so
// it can only step on that workbook. Each entry below it fits the workbook as it leaves it, so those go too, on the undo
// and the redo stack alike.
export function dropStructuralEntries(entries: History[]): History[] {
    return entries.slice(entries.findLastIndex(isStructural) + 1);
}

export function isStructural({ options }: History): boolean {
    return Boolean(
        options?.insertRowColOp ||
            options?.deleteRowColOp ||
            options?.addSheetOp ||
            options?.deleteSheetOp ||
            options?.renameSheetOp,
    );
}

// A peer's row or column op moves your entries' cells, merges, borders, links, validation rules and row or column sizes
// on its sheet, and the formula text that points at it on any sheet. An entry the op makes meaningless is dropped: one
// that writes inside deleted rows or columns or cuts a merge, a range or a whole config on the op's sheet, or a chart's
// data on that sheet.
export function shiftEntries(entries: History[], marker: Op, sheets: Sheet[]): History[] {
    const { id } = marker;
    const target = sheets.find((sheet) => sheet.id === id);
    if (id == null || !target) return entries;
    let move: RowColMove;
    if (marker.op === 'insertRowCol') move = insertMove({ ...marker.value, id });
    else if (marker.op === 'deleteRowCol') move = deleteMove({ ...marker.value, id });
    else return entries;
    const shifter = new Shifter(move, target.name, sheets);
    return entries.flatMap((entry) => shifter.entry(entry) ?? []);
}

function axisName(type: 'row' | 'column') {
    return type === 'row' ? 'row' : 'col';
}

// Shifts one entry for a peer's row or column op. Each step hands back what it was given when the op leaves it as it
// is, so an untouched entry stays the same object.
class Shifter {
    private readonly id: string;
    private readonly move: RowColMove;
    private readonly name: string;
    private readonly sheets: Sheet[];
    private readonly findSheet: (name: string) => Sheet | undefined;

    public constructor(move: RowColMove, name: string, sheets: Sheet[]) {
        this.id = move.id;
        this.move = move;
        this.name = name;
        this.sheets = sheets;
        this.findSheet = sheetFinder(sheets);
    }

    public entry(entry: History): History | null {
        const patches = this.patches(entry.patches);
        const inversePatches = this.patches(entry.inversePatches);
        if (!patches || !inversePatches) return null;
        if (patches === entry.patches && inversePatches === entry.inversePatches) return entry;
        return { ...entry, patches, inversePatches };
    }

    private patches(patches: Patch[]): Patch[] | null {
        const shifted: Patch[] = [];
        for (const patch of patches) {
            const next = this.patch(patch);
            if (!next) return null;
            shifted.push(next);
        }
        return shifted.every((patch, i) => patch === patches[i]) ? patches : shifted;
    }

    private patch(patch: Patch): Patch | null {
        const [root, sheet, field, ...rest] = patch.path;
        if (root !== 'sheets' || field == null) return patch;
        if (field === 'charts') return this.chartNamesSheet(patch) ? null : patch;
        if (sheet !== this.id) return field === 'data' ? this.otherSheetData(patch, rest.length) : patch;
        if (field === 'data') return this.dataPatch(patch, rest);
        if (field === 'config') return this.configPatch(patch, rest);
        if (field === 'hyperlink') return this.cellKeyed(patch, rest);
        if (field === 'dataValidations') return this.validations(patch, rest);
        if (field === 'calcChain') return this.calcChain(patch, rest);
        return POSITION_FREE_FIELDS.has(field) ? patch : null;
    }

    // A cell or row on another sheet moves nothing but the formula text that points at the op's sheet.
    private otherSheetData(patch: Patch, depth: number): Patch {
        if (!('value' in patch)) return patch;
        const { value } = patch;
        let next = value;
        if (depth === 1 && Array.isArray(value)) next = this.otherRow(value);
        else if (depth === 2) next = this.otherCell(value);
        else if (depth === 3 && patch.path[5] === 'f' && typeof value === 'string') next = this.formula(value, false);
        return next === value ? patch : { ...patch, value: next };
    }

    private otherRow(row: (Cell | null)[]): (Cell | null)[] {
        const shifted = row.map((cell) => this.otherCell(cell));
        return shifted.every((cell, i) => cell === row[i]) ? row : shifted;
    }

    private otherCell(cell: Cell | null): Cell | null {
        if (!cell?.f) return cell;
        const f = this.formula(cell.f, false);
        return f === cell.f ? cell : { ...cell, f };
    }

    private dataPatch(patch: Patch, [r, c, ...below]: (string | number)[]): Patch | null {
        const { type, to } = this.move;
        const position = type === 'row' ? r : c;
        if (typeof r !== 'number' || typeof position !== 'number') return null;
        const moved = to(position);
        if (moved == null) return null;
        const keys = c == null ? [r] : [r, c, ...below];
        keys[type === 'row' ? 0 : 1] = moved;
        const path = [...patch.path.slice(0, 3), ...keys];
        if (!('value' in patch)) return at(patch, path, undefined);
        const value = this.cellValue(patch.value, below, position);
        return value === undefined ? null : at(patch, path, value);
    }

    // A cell, a row of cells, or a cell's field, as the op leaves it; undefined when a merge it holds is cut.
    private cellValue(value: unknown, below: (string | number)[], position: number): unknown {
        if (below.length === 0) {
            if (Array.isArray(value)) {
                const row = value.map((cell, c) => this.cell(cell, this.move.type === 'row' ? position : c));
                if (row.includes(undefined)) return undefined;
                return row.every((cell, i) => cell === value[i]) ? value : row;
            }
            return isCell(value) ? this.cell(value, position) : value;
        }
        if (below.length === 1 && below[0] === 'f' && typeof value === 'string') return this.formula(value, true);
        if (below.length === 1 && below[0] === 'mc' && isMergeRef(value)) return this.mergeRef(value, position);
        return value;
    }

    private cell(cell: Cell | null, position: number): Cell | null | undefined {
        if (!cell) return cell;
        let next = cell;
        if (cell.f) {
            const f = this.formula(cell.f, true);
            if (f !== cell.f) next = { ...next, f };
        }
        if (cell.mc) {
            const mc = this.mergeRef(cell.mc, position);
            if (!mc) return undefined;
            if (mc !== cell.mc) next = { ...next, mc };
        }
        return next;
    }

    // A merge reference moves with its cell. A cut through the merge drops the entry: the merge itself changed.
    private mergeRef(mc: MergeRef, position: number): MergeRef | undefined {
        const row = this.move.type === 'row';
        const start = row ? mc.r : mc.c;
        const span = row ? mc.rs : mc.cs;
        const ends = [start, position, ...(span ? [start + span - 1] : [])];
        const offsets = new Set(ends.map((end) => this.offset(end)));
        const [offset] = offsets;
        if (offsets.size !== 1 || offset == null) return undefined;
        if (offset === 0) return mc;
        return row ? { ...mc, r: mc.r + offset } : { ...mc, c: mc.c + offset };
    }

    private offset(index: number) {
        const moved = this.move.to(index);
        return moved == null ? null : moved - index;
    }

    private configPatch(patch: Patch, [map, key, ...below]: (string | number)[]): Patch | null {
        if (map == null) return null;
        if (key == null) return this.configMap(patch, String(map));
        const keyed = (next: string | number) => at(patch, [...patch.path.slice(0, 4), next, ...below], patch.value);
        if (map === 'merge') {
            if (below.length > 0 || !patch.value) return this.cellKeyed(patch, [key, ...below]);
            const [entry] = Object.entries(this.move.merge({ [key]: patch.value }));
            if (!entry || !sameSize(entry[1], patch.value)) return null;
            return at(patch, [...patch.path.slice(0, 4), entry[0]], entry[1]);
        }
        if (map === 'borderInfo') return this.cellKeyed(patch, [key, ...below]);
        const axis = this.move.type === 'row' ? ROW_MAPS : COLUMN_MAPS;
        if (axis.has(String(map))) {
            const [moved] = Object.keys(this.move.keyed({ [key]: 0 }));
            return moved == null ? null : keyed(moved);
        }
        return (this.move.type === 'row' ? COLUMN_MAPS : ROW_MAPS).has(String(map)) ? patch : null;
    }

    // A whole map in config, such as the first merge or row height on a sheet. It moves as one; an entry it loses to
    // a delete, or a merge that changes size, drops the entry.
    private configMap(patch: Patch, map: string): Patch | null {
        const { value } = patch;
        if (!('value' in patch) || value == null) return patch;
        let moved: Record<string, unknown>;
        if (map === 'merge') {
            const merge: Record<string, MergeCell> = value;
            const shifted = this.move.merge(merge);
            const sizes = Object.values(shifted);
            if (!Object.values(merge).every((cell, i) => sizes[i] && sameSize(cell, sizes[i]))) return null;
            moved = shifted;
        } else if (map === 'borderInfo') moved = this.move.cellKeyed(value);
        else if ((this.move.type === 'row' ? ROW_MAPS : COLUMN_MAPS).has(map)) moved = this.move.keyed(value);
        else return (this.move.type === 'row' ? COLUMN_MAPS : ROW_MAPS).has(map) ? patch : null;
        return Object.keys(moved).length === Object.keys(value).length ? { ...patch, value: moved } : null;
    }

    // An "r_c" key at the head of `rest`, such as a border or a link, or a whole map of them, such as a sheet's first
    // link.
    private cellKeyed(patch: Patch, [key, ...below]: (string | number)[]): Patch | null {
        if (key == null) {
            if (!('value' in patch) || patch.value == null) return patch;
            const moved = this.move.cellKeyed(patch.value);
            return Object.keys(moved).length === Object.keys(patch.value).length ? { ...patch, value: moved } : null;
        }
        if (typeof key !== 'string') return null;
        const [moved] = Object.keys(this.move.cellKeyed({ [key]: true }));
        if (moved == null) return null;
        const depth = patch.path.length - below.length - 1;
        return at(patch, [...patch.path.slice(0, depth), moved, ...below], patch.value);
    }

    // A validation rule, or a sheet's whole map of them, which the editor writes whole. Its ranges move as the
    // engine moves the live ones. A rule the op leaves with no range drops the entry, as a write into deleted rows does.
    private validations(patch: Patch, [id, ...below]: (string | number)[]): Patch | null {
        if (!('value' in patch) || patch.value == null) return patch;
        if (below.length > 0) return null;
        const map: Record<string, SheetValidation> = id == null ? patch.value : { [id]: patch.value };
        const moved = shiftValidations(map, this.move.range);
        if (Object.keys(moved).length < Object.keys(map).length) return null;
        return at(patch, patch.path, id == null ? moved : moved[id]);
    }

    // The recalc list names each formula cell by its place, so an entry moves with its cell. A whole list moves as one
    // and loses the cells the op deletes: an edit that overwrites one formula records every formula cell's place, and
    // a deleted row elsewhere must not drop that edit's undo. A write of the list's length moves nothing.
    private calcChain(patch: Patch, [index]: (string | number)[]): Patch | null {
        if (!('value' in patch) || patch.value == null || index === 'length') return patch;
        if (index != null) {
            const moved = this.chainEntry(patch.value);
            return moved && at(patch, patch.path, moved);
        }
        const list: CalcChainEntry[] = patch.value;
        const moved = list.flatMap((entry) => this.chainEntry(entry) ?? []);
        if (moved.length === list.length && moved.every((entry, i) => entry === list[i])) return patch;
        return { ...patch, value: moved };
    }

    private chainEntry(entry: CalcChainEntry): CalcChainEntry | null {
        const row = this.move.type === 'row';
        const position = row ? entry.r : entry.c;
        const moved = this.move.to(position);
        if (moved == null) return null;
        if (moved === position) return entry;
        return row ? { ...entry, r: moved } : { ...entry, c: moved };
    }

    private formula(f: string, onTargetSheet: boolean): string {
        const text = f.startsWith('=') ? f.slice(1) : f;
        const shifted = `=${this.move.formula(text, this.name, onTargetSheet, this.findSheet)}`;
        return shifted === f ? f : shifted;
    }

    // A chart's data and points follow the ranges it reads; a write to its box or look moves with nothing.
    private chartNamesSheet(patch: Patch): boolean {
        const [, sheet, , chartId, part] = patch.path;
        if (part != null && part !== 'specData' && part !== 'specPoints') return false;
        const stored = this.sheets.find((s) => s.id === sheet)?.charts ?? {};
        const charts: (SheetChart | undefined)[] =
            chartId == null
                ? [...Object.values(stored), ...Object.values(patch.value ?? {})]
                : [stored[chartId], part == null ? patch.value : undefined];
        return charts.some((chart) => chart != null && this.names(chart));
    }

    private names(chart: SheetChart): boolean {
        let named = false;
        mapChartRefs(chart, (ref) => {
            named ||= ref.sheetId === this.id;
            return ref;
        });
        return named;
    }
}

// A cell's place in a merge: the merge's corner, with its size on the corner cell itself.
type MergeRef = NonNullable<Cell['mc']>;

function isCell(value: unknown): value is Cell | null {
    return value === null || (typeof value === 'object' && !Array.isArray(value));
}

function isMergeRef(value: unknown): value is MergeRef {
    return typeof value === 'object' && value !== null && 'r' in value && 'c' in value;
}

function sameSize(a: MergeCell, b: MergeCell) {
    return a.rs === b.rs && a.cs === b.cs;
}

// The patch at `path` with `value`, or the patch itself when neither changed.
function at(patch: Patch, path: Patch['path'], value: unknown): Patch {
    const samePath = path.length === patch.path.length && path.every((key, i) => key === patch.path[i]);
    if (samePath && value === patch.value) return patch;
    return 'value' in patch ? { ...patch, path, value } : { ...patch, path };
}

// Sheet fields a row or column op never moves.
const POSITION_FREE_FIELDS = new Set<string | number>([
    'name',
    'color',
    'hide',
    'order',
    'status',
    'showGridLines',
    'zoomRatio',
    'defaultRowHeight',
    'defaultColWidth',
    'images',
]);

const ROW_MAPS = new Set(['rowlen', 'rowhidden', 'customHeight']);
const COLUMN_MAPS = new Set(['columnlen', 'colhidden', 'customWidth']);
