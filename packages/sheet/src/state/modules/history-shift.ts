// How a peer's row or column op moves this tab's pending undos. The engine moves the cells, merges, links and sizes of
// the sheet the op names, and the formula text that points at it on every sheet; shiftEntries moves an undo entry's
// paths and values the same way, so an undo lands where its cell now is. Callers such as the Workbook's applyOp run it
// for each such op in a peer's batch, and undo's repair reads a RowColMove to find where a cell was before an op.

import type { MergeCell, SheetChart } from '@workspace/lib/sheets';
import type { Patch } from 'immer';
import { mapChartRefs } from '../../engine/chart-data';
import { functionStrChange } from '../../engine/formula-shift';
import type { DeleteRowColOp, InsertRowColOp } from '../../engine/rowcol';
import {
    applySheetsDeleteRowCol,
    applySheetsInsertRowCol,
    RowColError,
    shiftCellKeyedForDelete,
    shiftCellKeyedForInsert,
    shiftKeyedMapForDelete,
    shiftKeyedMapForInsert,
    shiftMergeForDelete,
    shiftMergeForInsert,
} from '../../engine/rowcol';
import type { CalcChainEntry, Cell, CellMatrix } from '../../engine/types';
import type { History, Op, Sheet } from '../types';
import type { PatchOptions } from '../utils';
import { inverseRowColOptions } from '../utils';

// What one row or column op does to the indices on its axis, with the engine's shifter for each kind of map.
type RowColMove = {
    id: string;
    type: 'row' | 'column';
    // Where an index ends up, or null for a row or column the op deletes.
    to: (index: number) => number | null;
    // Where an index the op left was before it, or null for a row or column the op inserts.
    from: (index: number) => number | null;
    formula: (text: string, sheetName: string, onTargetSheet: boolean) => string;
    merge: (merge: Record<string, MergeCell>) => Record<string, MergeCell>;
    keyed: (map: Record<string, number>) => Record<string, number>;
    cellKeyed: <T>(map: Record<string, T>) => Record<string, T>;
    sheets: <S extends Sheet>(sheets: S[]) => S[];
};

// The move of an undo entry's own row or column op.
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
        from: (i) => (i < at ? i : i < at + count ? null : i - count),
        formula: (text, name, onTargetSheet) =>
            functionStrChange(text, 'add', axisName(type), direction, index, count, name, onTargetSheet),
        merge: (merge) => shiftMergeForInsert({ merge }, type, index, count, direction),
        keyed: (map) => shiftKeyedMapForInsert(map, index, count, direction),
        cellKeyed: (map) => shiftCellKeyedForInsert(map, type, index, count, direction),
        sheets: (sheets) => applySheetsInsertRowCol(sheets, op),
    };
}

function deleteMove(op: DeleteRowColOp): RowColMove {
    const { id, type, start, end } = op;
    const count = end - start + 1;
    return {
        id,
        type,
        to: (i) => (i < start ? i : i > end ? i - count : null),
        from: (i) => (i < start ? i : i + count),
        formula: (text, name, onTargetSheet) =>
            functionStrChange(text, 'del', axisName(type), null, start, count, name, onTargetSheet),
        merge: (merge) => shiftMergeForDelete({ merge }, type, start, count),
        keyed: (map) => shiftKeyedMapForDelete(map, start, end),
        cellKeyed: (map) => shiftCellKeyedForDelete(map, type, start, end),
        sheets: (sheets) => applySheetsDeleteRowCol(sheets, op),
    };
}

// A peer's row or column op moves your entries' cells, merges, borders, links, validation and row or column sizes on
// its sheet, and the formula text that points at it on any sheet, a deleted sheet's included. An entry the op makes
// meaningless is dropped: one that writes inside deleted rows or columns or cuts a merge, a range or a whole config on
// the op's sheet, a chart's data on that sheet, or your own row or column op there.
//
// Each entry fits the grid as the entries above it on its stack leave it: an undo entry was recorded before the row
// ops above it were made, and a redo entry after the row ops above it are redone. So once your own row or column op
// is dropped, the entries below it first take that op's move on an undo stack, or its inverse on a redo stack.
export function shiftEntries(entries: History[], marker: Op, sheets: Sheet[], stack: 'undo' | 'redo'): History[] {
    const { id } = marker;
    const target = sheets.find((sheet) => sheet.id === id);
    if (id == null || !target) return entries;
    let move: RowColMove;
    if (marker.op === 'insertRowCol') move = insertMove({ ...marker.value, id });
    else if (marker.op === 'deleteRowCol') move = deleteMove({ ...marker.value, id });
    else return entries;
    let shifters = [new Shifter(move, target.name, sheets)];
    const shifted: History[] = [];
    for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        const own = entry.options?.insertRowColOp ?? entry.options?.deleteRowColOp;
        if (own?.id === id) {
            const dropped = rowColMove(stack === 'undo' ? entry.options : inverseRowColOptions(entry.options));
            if (dropped) shifters = [new Shifter(dropped, target.name, sheets), ...shifters];
            continue;
        }
        let next: History | null = entry;
        for (const shifter of shifters) next = next && shifter.entry(next);
        if (next) shifted.push(next);
    }
    return shifted.reverse();
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

    public constructor(move: RowColMove, name: string, sheets: Sheet[]) {
        this.id = move.id;
        this.move = move;
        this.name = name;
        this.sheets = sheets;
    }

    public entry(entry: History): History | null {
        const own = entry.options?.insertRowColOp ?? entry.options?.deleteRowColOp;
        if (own?.id === this.id) return null;
        const patches = this.patches(entry.patches);
        const inversePatches = this.patches(entry.inversePatches);
        if (!patches || !inversePatches) return null;
        const options = this.deletedSheet(entry.options);
        if (patches === entry.patches && inversePatches === entry.inversePatches && options === entry.options) {
            return entry;
        }
        return { ...entry, patches, inversePatches, options };
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
        if (root !== 'sheets') return patch;
        if (field == null) return sheet == null ? patch : this.addedSheet(patch);
        if (field === 'charts') return this.chartNamesSheet(patch) ? null : patch;
        if (sheet !== this.id) return field === 'data' ? this.otherSheetData(patch, rest.length) : patch;
        if (field === 'data') return this.dataPatch(patch, rest);
        if (field === 'config') return this.configPatch(patch, rest);
        if (field === 'hyperlink' || field === 'dataVerification') return this.cellKeyed(patch, rest);
        if (field === 'calcChain') return this.calcChain(patch, rest);
        return POSITION_FREE_FIELDS.has(field) ? patch : null;
    }

    // A sheet a redo adds back, such as a copy: its formulas may point at the op's sheet.
    private addedSheet(patch: Patch): Patch {
        if (!('value' in patch) || patch.value == null) return patch;
        const sheet: Sheet = patch.value;
        const next = { ...sheet };
        if (sheet.data) next.data = this.otherMatrix(sheet.data);
        if (sheet.celldata) next.celldata = this.celldata(sheet.celldata);
        return next.data === sheet.data && next.celldata === sheet.celldata ? patch : { ...patch, value: next };
    }

    // A deleted sheet keeps its cells in the entry's options, for its undo; their formulas may point at the op's sheet.
    private deletedSheet(options: PatchOptions | undefined) {
        const deleted = options?.deletedSheet;
        if (!options || !deleted?.celldata) return options;
        const celldata = this.celldata(deleted.celldata);
        return celldata === deleted.celldata ? options : { ...options, deletedSheet: { ...deleted, celldata } };
    }

    private celldata(celldata: NonNullable<Sheet['celldata']>) {
        const shifted = celldata.map((entry) => {
            const v = this.otherCell(entry.v);
            return v === entry.v ? entry : { ...entry, v };
        });
        return shifted.every((entry, i) => entry === celldata[i]) ? celldata : shifted;
    }

    // A cell, row or matrix on another sheet moves nothing but the formula text that points at the op's sheet.
    private otherSheetData(patch: Patch, depth: number): Patch {
        if (!('value' in patch)) return patch;
        const { value } = patch;
        let next = value;
        if (depth === 0 && Array.isArray(value)) next = this.otherMatrix(value);
        else if (depth === 1 && Array.isArray(value)) next = this.otherRow(value);
        else if (depth === 2) next = this.otherCell(value);
        else if (depth === 3 && patch.path[5] === 'f' && typeof value === 'string') next = this.formula(value, false);
        return next === value ? patch : { ...patch, value: next };
    }

    private otherMatrix(matrix: CellMatrix): CellMatrix {
        const shifted = matrix.map((row) => this.otherRow(row));
        return shifted.every((row, i) => row === matrix[i]) ? matrix : shifted;
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
        if (r == null) return this.matrixPatch(patch);
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

    // A whole matrix on the op's sheet, which a row or column op on another sheet records when it rewrites formulas
    // here. It moves as the live matrix does; a merge it cuts drops the entry.
    private matrixPatch(patch: Patch): Patch | null {
        if (!('value' in patch) || !Array.isArray(patch.value)) return null;
        let data: CellMatrix | undefined;
        try {
            [{ data }] = this.move.sheets([{ id: this.id, name: this.name, data: patch.value }]);
        } catch (e) {
            if (!(e instanceof RowColError)) throw e;
            return null;
        }
        if (!data) return null;
        const { type, from } = this.move;
        const merged: CellMatrix = [];
        for (const [r, row] of data.entries()) {
            const cells: CellMatrix[number] = [];
            for (const [c, cell] of row.entries()) {
                const position = from(type === 'row' ? r : c);
                const mc = cell?.mc && position != null ? this.mergeRef(cell.mc, position) : cell?.mc;
                if (cell?.mc && !mc) return null;
                cells.push(cell && mc !== cell.mc ? { ...cell, mc } : cell);
            }
            merged.push(cells.every((cell, i) => cell === row[i]) ? row : cells);
        }
        return { ...patch, value: merged };
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

    // An "r_c" key at the head of `rest`, such as a border, a link or a validation rule, or a whole map of them, such
    // as a sheet's first link.
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
        const shifted = `=${this.move.formula(text, this.name, onTargetSheet)}`;
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

const ROW_MAPS = new Set(['rowlen', 'rowhidden', 'customHeight', 'rowReadOnly']);
const COLUMN_MAPS = new Set(['columnlen', 'colhidden', 'customWidth', 'colReadOnly']);
