// The tab's own undo and redo. An edit is recorded as an entry of immer patches, with its sheet named by id, and undo
// and redo are pure: they take the context and an entry and return the next context and the batch to send, never
// changing the entry. An undo or redo that adds or deletes a sheet, rows or columns builds ops and applies exactly
// those, through applyOpBatch, as its peers will. A peer's row or column op shifts the entries (shiftEntries), as it
// shifts the live cells. The Workbook keeps the two stacks and calls these from handleUndo, handleRedo and applyOp.

import type { MergeCell, SheetChart } from '@workspace/lib/sheets';
import { parseCellKey } from '@workspace/lib/sheets';
import { cloneDeep, isEqual } from 'es-toolkit/compat';
import type { Patch } from 'immer';
import { applyPatches, produce } from 'immer';
import { dataToCelldata } from '../../engine/celldata';
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
import type { Cell, CellMatrix } from '../../engine/types';
import type { Context } from '../context';
import type { History, Op, Sheet } from '../types';
import type { PatchOptions } from '../utils';
import { getSheetIndex, inverseRowColOptions, patchToOp } from '../utils';
import { applyOpBatch } from './apply-ops';
import { withoutDeletedFloatingEdits } from './floating';
import { settleCurrentSheet } from './sheet';

type Step = { ctx: Context; ops: Op[] };

// A cell's place in a merge: the merge's corner, with its size on the corner cell itself.
type MergeRef = NonNullable<Cell['mc']>;

// What setContextWithProduce keeps of one edit. It fills in the options the edit's ops need too. A sheet delete keeps
// only the deleted sheet: its undo and redo are ops, and its patches would hold the whole sheet list twice.
export function recordEntry(
    before: Context,
    after: Context,
    patches: Patch[],
    inversePatches: Patch[],
    options: PatchOptions,
): History {
    options.id = before.currentSheetId;
    if (options.deleteSheetOp) {
        const index = before.sheets.findIndex((sheet) => sheet.id === options.deleteSheetOp?.id);
        const { data, ...value } = cloneDeep(before.sheets[index]);
        if (data) value.celldata = dataToCelldata(data);
        value.status = 0;
        options.deletedSheet = { id: options.deleteSheetOp.id, index, value };
        return { patches: [], inversePatches: [], options };
    }
    if (options.addSheetOp) options.addSheet = { id: after.sheets[after.sheets.length - 1].id };
    return {
        patches: bySheetId(patches, after.sheets),
        inversePatches: bySheetId(inversePatches, before.sheets),
        options,
    };
}

export function undoEntry(ctx: Context, entry: History): Step {
    const { options } = entry;
    if (options?.deleteSheetOp && options.deletedSheet?.value)
        return applyBatch(ctx, addSheetOps(ctx, options.deletedSheet.value));
    if (options?.addSheetOp && options.addSheet?.id) return applyBatch(ctx, deleteSheetOps(ctx, options.addSheet.id));
    if (options?.insertRowColOp || options?.deleteRowColOp) {
        return rowColStep(ctx, entry.patches, entry.inversePatches, inverseRowColOptions(options) ?? {}, true);
    }
    return patchStep(ctx, entry.inversePatches, entry.patches);
}

export function redoEntry(ctx: Context, entry: History): Step {
    const { options } = entry;
    if (options?.deleteSheetOp) return applyBatch(ctx, deleteSheetOps(ctx, options.deleteSheetOp.id));
    if (options?.addSheetOp) {
        const added = entry.patches.find((patch) => patch.op === 'add' && patch.path.length === 2);
        return applyBatch(ctx, added ? addSheetOps(ctx, added.value) : []);
    }
    if (options?.insertRowColOp || options?.deleteRowColOp) {
        return rowColStep(ctx, entry.inversePatches, entry.patches, options, false);
    }
    return patchStep(ctx, entry.patches, entry.inversePatches);
}

// A peer's row or column op moves your entries' cells, merges, borders, links, validation and row or column sizes on
// its sheet, and the formula text that points at it on any sheet, so an undo lands where the cell now is. An entry
// the op makes meaningless is dropped: one that writes inside deleted rows or columns, a range or a whole field on
// the op's sheet, a chart's data on that sheet, or your own row or column op there. calcChain is left as it is.
export function shiftEntries(entries: History[], marker: Op, sheets: Sheet[]): History[] {
    const target = sheets.find((sheet) => sheet.id === marker.id);
    if (!target || (marker.op !== 'insertRowCol' && marker.op !== 'deleteRowCol')) return entries;
    const shifter = new Shifter(marker, target, sheets);
    const shifted: History[] = [];
    for (const entry of entries) {
        const next = shifter.entry(entry);
        if (next) shifted.push(next);
    }
    return shifted;
}

// ['sheets', index, …] → ['sheets', id, …] for a cell or field path. Shorter paths, a whole sheet or the sheet list,
// occur only in sheet add, copy and delete entries, which undo and redo replay as ops.
function bySheetId(patches: Patch[], sheets: Sheet[]): Patch[] {
    return patches.map((patch) => {
        const [root, index, ...rest] = patch.path;
        if (root !== 'sheets' || typeof index !== 'number' || rest.length === 0) return patch;
        return { ...patch, path: ['sheets', sheets[index].id as string, ...rest] };
    });
}

// The entry's paths on today's sheet indices; a patch on a sheet that is gone is dropped.
function atSheetIndex(ctx: Context, patches: Patch[]): Patch[] {
    const resolved: Patch[] = [];
    for (const patch of patches) {
        const [root, id, ...rest] = patch.path;
        if (root !== 'sheets' || typeof id !== 'string') {
            resolved.push(patch);
            continue;
        }
        const index = getSheetIndex(ctx, id);
        if (index != null) resolved.push({ ...patch, path: ['sheets', index, ...rest] });
    }
    return resolved;
}

function applyBatch(ctx: Context, ops: Op[]): Step {
    if (ops.length === 0) return { ctx, ops };
    const next = applyOpBatch(ctx, ops);
    return next ? { ctx: produce(next, settleCurrentSheet), ops } : { ctx, ops: [] };
}

// A sheet comes back from its stored value, after the sheets that now sit at or past its place in the tab order.
function addSheetOps(ctx: Context, value: Sheet): Op[] {
    if (getSheetIndex(ctx, value.id as string) != null) return [];
    const ops: Op[] = [{ op: 'addSheet', id: value.id, path: [], value }];
    for (const sheet of ctx.sheets) {
        if ((sheet.order ?? 0) < (value.order ?? 0)) continue;
        ops.push({ op: 'replace', id: sheet.id, path: ['order'], value: (sheet.order ?? 0) + 1 });
    }
    return ops;
}

function deleteSheetOps(ctx: Context, id: string): Op[] {
    const index = getSheetIndex(ctx, id);
    if (index == null) return [];
    const order = ctx.sheets[index].order ?? 0;
    const ops: Op[] = [{ op: 'deleteSheet', id, path: [], value: { id } }];
    for (const sheet of ctx.sheets) {
        if ((sheet.order ?? 0) <= order) continue;
        ops.push({ op: 'replace', id: sheet.id, path: ['order'], value: (sheet.order ?? 0) - 1 });
    }
    return ops;
}

// A cell or field entry: `apply` goes in, and `written`, the entry's other side, says what the targets should hold.
function patchStep(ctx: Context, apply: Patch[], written: Patch[]): Step {
    const patches = stillWritten(
        ctx,
        withoutDeletedFloatingEdits(ctx, atSheetIndex(ctx, apply)),
        atSheetIndex(ctx, written),
    );
    if (patches.length === 0) return { ctx, ops: [] };
    const next = produce(applyPatches(ctx, patches), settleCurrentSheet);
    next.formulaCache.updateFormulaCache(next, { patches, inversePatches: [] }, 'redo');
    return { ctx: next, ops: patchToOp(next, patches) };
}

// A row or column entry, `from` what the op left to `to`. Its whole-field patches set up a scratch context, which
// patchToOp reads the marker's metadata from as it does for the op itself; the live context gets only the ops.
function rowColStep(ctx: Context, from: Patch[], to: Patch[], options: PatchOptions, undo: boolean): Step {
    const target = withoutDeletedFloatingEdits(ctx, atSheetIndex(ctx, to));
    const repair = repairOps(ctx, atSheetIndex(ctx, from), target, options);
    return applyBatch(ctx, patchToOp(applyPatches(ctx, target), target, options, undo, repair));
}

// The cells the marker alone leaves different from what the entry restores: rows a delete took, and a formula it made
// #REF! or shrank, on any sheet. A cell a peer changed since the op keeps the peer's value.
function repairOps(ctx: Context, from: Patch[], to: Patch[], options: PatchOptions): Op[] {
    const matrices = (patches: Patch[]) =>
        new Map(
            patches
                .filter(({ path }) => path.length === 3 && path[2] === 'data')
                .map(({ path, value }): [number, CellMatrix] => [path[1] as number, value]),
        );
    const left = matrices(from);
    const wanted = matrices(to);
    const { insertRowColOp: insert, deleteRowColOp: remove } = options;
    const marker = insert ?? remove;
    if (!marker || wanted.size === 0) return [];
    const sheets = ctx.sheets.map((sheet, index) => {
        const data = left.get(index);
        return data ? { ...sheet, data } : sheet;
    });
    let moved: Sheet[];
    try {
        moved = insert ? applySheetsInsertRowCol(sheets, insert) : applySheetsDeleteRowCol(sheets, remove!);
    } catch (e) {
        if (!(e instanceof RowColError)) throw e;
        return [];
    }
    const ops: Op[] = [];
    for (const [index, rows] of wanted) {
        const after = moved[index].data ?? [];
        const was = left.get(index) ?? [];
        const live = ctx.sheets[index].data ?? [];
        const source = ctx.sheets[index].id === marker.id ? sourceOf(options) : (r: number, c: number) => [r, c];
        for (let r = 0; r < rows.length; r += 1) {
            if (rows[r] === after[r]) continue;
            const width = Math.max(rows[r]?.length ?? 0, after[r]?.length ?? 0);
            for (let c = 0; c < width; c += 1) {
                const cell = rows[r]?.[c] ?? null;
                if (isEqual(cell, after[r]?.[c] ?? null)) continue;
                const at = source(r, c);
                if (at && !isEqual(authored(live[at[0]]?.[at[1]]), authored(was[at[0]]?.[at[1]]))) continue;
                ops.push({ op: 'replace', id: ctx.sheets[index].id, path: ['data', r, c], value: cell });
            }
        }
    }
    return ops;
}

// Where a cell the marker leaves at (r, c) was before it; null for a row or column the marker inserted.
function sourceOf({ insertRowColOp: insert, deleteRowColOp: remove }: PatchOptions) {
    let back: (index: number) => number | null;
    if (insert) {
        const at = insert.direction === 'lefttop' ? insert.index : insert.index + 1;
        back = (index) => (index < at ? index : index < at + insert.count ? null : index - insert.count);
    } else {
        const removed = remove!.end - remove!.start + 1;
        back = (index) => (index < remove!.start ? index : index + removed);
    }
    const type = (insert ?? remove)?.type;
    return (r: number, c: number): [number, number] | null => {
        const moved = back(type === 'row' ? r : c);
        if (moved == null) return null;
        return type === 'row' ? [moved, c] : [r, moved];
    };
}

// What a person wrote into a cell: a formula's value, its display text and its value type are the engine's.
function authored(cell: Cell | null | undefined) {
    if (cell?.f == null) return cell ?? null;
    const { v, m, ct, ...rest } = cell;
    return ct ? { ...rest, fa: ct.fa } : rest;
}

// The patches whose targets still hold what the entry wrote there: a target a peer changed since keeps the peer's
// value, as Google does. A merge and its cells, and a link and its cell, pass or skip together. calcChain is the
// tab's recalc list, so its patches always apply.
function stillWritten(ctx: Context, apply: Patch[], written: Patch[]): Patch[] {
    const parent = new Map<string, string>();
    const find = (key: string): string => {
        const up = parent.get(key);
        if (up == null || up === key) return key;
        const root = find(up);
        parent.set(key, root);
        return root;
    };
    const join = (a: string, b: string) => parent.set(find(a), find(b));
    const joinUnits = (patch: Patch, key: string) => {
        const [, sheet, field, name, cellKey] = patch.path;
        if (field === 'config' && name === 'merge' && typeof cellKey === 'string' && patch.value) {
            const { r, c, rs, cs } = patch.value as MergeCell;
            for (let row = r; row < r + rs; row += 1) {
                for (let column = c; column < c + cs; column += 1) {
                    join(key, JSON.stringify(['sheets', sheet, 'data', row, column]));
                }
            }
        } else if (field === 'hyperlink' && typeof name === 'string') {
            join(key, JSON.stringify(['sheets', sheet, 'data', ...parseCellKey(name)]));
        }
    };
    for (const patch of apply) joinUnits(patch, JSON.stringify(unitOf(patch.path)));
    const writes = new Map<string, { unit: (string | number)[]; patches: Patch[] }>();
    for (const patch of written) {
        const unit = unitOf(patch.path);
        const key = JSON.stringify(unit);
        joinUnits(patch, key);
        if (patch.path[2] === 'calcChain') continue;
        const write = writes.get(key) ?? { unit, patches: [] };
        write.patches.push(patch);
        writes.set(key, write);
    }
    const changed = new Set<string>();
    for (const [key, { unit, patches }] of writes) if (!holds(ctx, unit, patches)) changed.add(find(key));
    if (changed.size === 0) return apply;
    return apply.filter((patch) => !changed.has(find(JSON.stringify(unitOf(patch.path)))));
}

// A cell, a config map's entry, or one link, rule, image or chart: what a peer's write and yours collide on.
function unitOf(path: (string | number)[]) {
    return path.slice(0, path[2] === 'data' || path[2] === 'config' ? 5 : 4);
}

// The target holds what the entry wrote when writing it again changes nothing.
function holds(ctx: Context, unit: (string | number)[], patches: Patch[]): boolean {
    let current: unknown = ctx;
    for (const key of unit) current = (current as Record<string | number, unknown> | undefined)?.[key];
    let rewritten: unknown;
    try {
        const rebased = patches.map((patch) => ({ ...patch, path: ['value', ...patch.path.slice(unit.length)] }));
        rewritten = applyPatches({ value: current }, rebased).value;
    } catch {
        return false;
    }
    if (unit[2] !== 'data' || unit.length !== 5) return isEqual(rewritten, current);
    return isEqual(authored(rewritten as Cell | null), authored(current as Cell | null));
}

// Shifts one entry's patches for a peer's row or column marker.
class Shifter {
    private readonly id: string;
    private readonly type: 'row' | 'column';
    private readonly insert?: InsertRowColOp;
    private readonly remove?: DeleteRowColOp;
    private readonly name: string;
    private readonly sheets: Sheet[];

    public constructor(marker: Op, target: Sheet, sheets: Sheet[]) {
        this.id = marker.id as string;
        this.type = marker.value.type;
        if (marker.op === 'insertRowCol') this.insert = { ...marker.value, id: this.id };
        else this.remove = { ...marker.value, id: this.id };
        this.name = target.name;
        this.sheets = sheets;
    }

    public entry(entry: History): History | null {
        const own = entry.options?.insertRowColOp ?? entry.options?.deleteRowColOp;
        if (own?.id === this.id) return null;
        const patches = this.patches(entry.patches);
        const inversePatches = this.patches(entry.inversePatches);
        if (!patches || !inversePatches) return null;
        if (patches === entry.patches && inversePatches === entry.inversePatches) return entry;
        return { ...entry, patches, inversePatches };
    }

    private patches(patches: Patch[]): Patch[] | null {
        let changed = false;
        const shifted: Patch[] = [];
        for (const patch of patches) {
            const next = this.patch(patch);
            if (!next) return null;
            // A patch the marker leaves where it was stays the same object, so an untouched entry does too.
            const same = next === patch || isEqual(next, patch);
            changed ||= !same;
            shifted.push(same ? patch : next);
        }
        return changed ? shifted : patches;
    }

    private patch(patch: Patch): Patch | null {
        const [root, sheet, field, ...rest] = patch.path;
        if (root !== 'sheets' || field == null) return patch;
        if (field === 'charts') return this.chartNamesSheet(patch) ? null : patch;
        if (sheet !== this.id) return field === 'data' ? this.withFormulas(patch, false) : patch;
        if (field === 'data') return this.dataPatch(patch, rest);
        if (field === 'config') return this.configPatch(patch, rest);
        if (field === 'hyperlink' || field === 'dataVerification') return this.cellKeyed(patch, [field, ...rest]);
        return POSITION_FREE_FIELDS.has(field) ? patch : null;
    }

    private dataPatch(patch: Patch, [r, c, ...below]: (string | number)[]): Patch | null {
        if (typeof r !== 'number') return null;
        if (c == null && this.type === 'column') return null;
        const row = this.type === 'row' ? this.move(r) : r;
        const column = typeof c === 'number' && this.type === 'column' ? this.move(c) : c;
        if (row == null || column == null) return null;
        const path = c == null ? [row] : [row, column, ...below];
        const moved = { ...patch, path: [...patch.path.slice(0, 3), ...path] };
        if (!('value' in patch)) return moved;
        const position = this.type === 'row' ? r : (c as number);
        const value = this.cellValue(patch.value, below, position);
        return value === undefined ? null : { ...moved, value };
    }

    // A cell, a row of cells, or a cell's field, as the marker leaves it; undefined when a merge it holds is cut.
    private cellValue(value: unknown, below: (string | number)[], position: number): unknown {
        if (below.length === 0) {
            if (Array.isArray(value)) {
                const row = value.map((cell, c) => this.cell(cell, this.type === 'row' ? position : c));
                return row.includes(undefined) ? undefined : row;
            }
            return this.cell(value as Cell | null, position);
        }
        if (below.length === 1 && below[0] === 'f' && typeof value === 'string') return this.formula(value, true);
        if (below.length === 1 && below[0] === 'mc' && value) return this.mergeRef(value as MergeRef, position);
        return value;
    }

    private cell(cell: Cell | null, position: number): Cell | null | undefined {
        if (!cell) return cell;
        let next = cell;
        if (cell.f) next = { ...next, f: this.formula(cell.f, true) };
        if (cell.mc) {
            const mc = this.mergeRef(cell.mc, position);
            if (!mc) return undefined;
            next = { ...next, mc };
        }
        return next;
    }

    // A merge reference moves with its cell. A cut through the merge drops the entry: the merge itself changed.
    private mergeRef(mc: MergeRef, position: number): MergeRef | undefined {
        const start = this.type === 'row' ? mc.r : mc.c;
        const span = this.type === 'row' ? mc.rs : mc.cs;
        const ends = [start, position, ...(span ? [start + span - 1] : [])];
        const offsets = ends.map((end) => {
            const moved = this.move(end);
            return moved == null ? null : moved - end;
        });
        if (offsets.some((offset) => offset == null || offset !== offsets[0])) return undefined;
        const offset = offsets[0] as number;
        return this.type === 'row' ? { ...mc, r: mc.r + offset } : { ...mc, c: mc.c + offset };
    }

    private configPatch(patch: Patch, [map, key, ...below]: (string | number)[]): Patch | null {
        if (typeof key !== 'string' && typeof key !== 'number') return null;
        const at = (next: string | number) => ({ ...patch, path: [...patch.path.slice(0, 4), next, ...below] });
        if (map === 'merge') {
            if (below.length > 0 || !patch.value) return this.cellKeyed(patch, [map, key, ...below]);
            const shifted = this.mergeMap({ [key]: patch.value });
            const [entry] = Object.entries(shifted);
            if (!entry || !isEqual({ ...entry[1], r: 0, c: 0 }, { ...patch.value, r: 0, c: 0 })) return null;
            return { ...at(entry[0]), value: entry[1] };
        }
        if (map === 'borderInfo') return this.cellKeyed(patch, [map, key, ...below]);
        const axis = this.type === 'row' ? ROW_MAPS : COLUMN_MAPS;
        if (axis.has(String(map))) {
            const [moved] = Object.keys(this.keyedMap({ [key]: 0 }));
            return moved == null ? null : at(moved);
        }
        return (this.type === 'row' ? COLUMN_MAPS : ROW_MAPS).has(String(map)) ? patch : null;
    }

    // An "r_c" key below `rest`'s first segment, such as a border, a link or a validation rule.
    private cellKeyed(patch: Patch, [, key, ...below]: (string | number)[]): Patch | null {
        if (typeof key !== 'string') return null;
        const [moved] = Object.keys(this.cellKeyedMap({ [key]: true }));
        if (moved == null) return null;
        const depth = patch.path.length - below.length - 1;
        return { ...patch, path: [...patch.path.slice(0, depth), moved, ...below] };
    }

    private withFormulas(patch: Patch, onTargetSheet: boolean): Patch {
        if (!('value' in patch) || patch.path.length < 4) return patch;
        const below = patch.path.slice(5);
        const shift = (cell: Cell | null) => (cell?.f ? { ...cell, f: this.formula(cell.f, onTargetSheet) } : cell);
        let value = patch.value;
        if (below.length === 0) value = Array.isArray(value) ? value.map(shift) : shift(value);
        else if (below.length === 1 && below[0] === 'f' && typeof value === 'string')
            value = this.formula(value, onTargetSheet);
        return isEqual(value, patch.value) ? patch : { ...patch, value };
    }

    private formula(f: string, onTargetSheet: boolean): string {
        const text = f.startsWith('=') ? f.slice(1) : f;
        const rc = this.type === 'row' ? 'row' : 'col';
        const shifted = this.insert
            ? functionStrChange(
                  text,
                  'add',
                  rc,
                  this.insert.direction,
                  this.insert.index,
                  this.insert.count,
                  this.name,
                  onTargetSheet,
              )
            : functionStrChange(text, 'del', rc, null, this.remove!.start, this.removed(), this.name, onTargetSheet);
        return `=${shifted}`;
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

    private move(index: number): number | null {
        if (this.insert) {
            const at = this.insert.direction === 'lefttop' ? this.insert.index : this.insert.index + 1;
            return index < at ? index : index + this.insert.count;
        }
        const { start, end } = this.remove!;
        return index < start ? index : index > end ? index - this.removed() : null;
    }

    private removed() {
        return this.remove!.end - this.remove!.start + 1;
    }

    private mergeMap(merge: Record<string, MergeCell>) {
        return this.insert
            ? shiftMergeForInsert({ merge }, this.type, this.insert.index, this.insert.count, this.insert.direction)
            : shiftMergeForDelete({ merge }, this.type, this.remove!.start, this.removed());
    }

    private keyedMap(map: Record<string, number>) {
        return this.insert
            ? shiftKeyedMapForInsert(map, this.insert.index, this.insert.count, this.insert.direction)
            : shiftKeyedMapForDelete(map, this.remove!.start, this.remove!.end);
    }

    private cellKeyedMap<T>(map: Record<string, T>) {
        return this.insert
            ? shiftCellKeyedForInsert(map, this.type, this.insert.index, this.insert.count, this.insert.direction)
            : shiftCellKeyedForDelete(map, this.type, this.remove!.start, this.remove!.end);
    }
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
    'calcChain',
]);

const ROW_MAPS = new Set(['rowlen', 'rowhidden', 'customHeight', 'rowReadOnly']);
const COLUMN_MAPS = new Set(['columnlen', 'colhidden', 'customWidth', 'colReadOnly']);
