// What ⌘Z and ⌘⇧Z do in this tab. An edit is recorded as an entry of immer patches that names its sheet by id. Undo and
// redo take the context and an entry and return the next context and the batch to send. A cell or field entry skips a
// target a peer changed since and recalculates the formulas it touches. A sheet, row or column entry builds ops and
// applies exactly those, through applyOpBatch, as its peers will. The Workbook keeps the stacks and calls these from,
// for example, handleUndo.

import { isRecord } from '@workspace/lib/guards';
import type { MergeCell } from '@workspace/lib/sheets';
import { parseCellKey } from '@workspace/lib/sheets';
import { cloneDeep, get, isEqual } from 'es-toolkit/compat';
import type { Patch } from 'immer';
import { applyPatches, produce, produceWithPatches } from 'immer';
import { dataToCelldata } from '../../engine/celldata';
import { RowColError } from '../../engine/rowcol';
import type { CalcChainEntry, Cell, CellMatrix } from '../../engine/types';
import type { Context } from '../context';
import { getFlowdata } from '../context';
import type { FormulaCell, History, Op, Sheet } from '../types';
import type { PatchOptions } from '../utils';
import {
    addSheetOps,
    deleteSheetOps,
    filterPatch,
    getSheetIndex,
    inverseRowColOptions,
    patchToOp,
    rowColMarker,
} from '../utils';
import { applyOpBatch } from './apply-ops';
import { setCellValue } from './cell';
import { withoutDeletedFloatingEdits } from './floating';
import { createContextResolver, snapshotContext } from './formula-cache';
import { execFunctionGroup, execfunction, groupValuesRefresh } from './formula-exec';
import { rowColMove } from './history-shift';
import { settleCurrentSheet } from './sheet';

type Step = { ctx: Context; ops: Op[] };

// What setContextWithProduce keeps of one edit. Its options are the ones the edit's batch is built from: a sheet delete
// adds the deleted sheet, and keeps only that: its undo and redo are ops, and its patches would hold the whole sheet
// list twice.
export function recordEntry(
    before: Context,
    after: Context,
    patches: Patch[],
    inversePatches: Patch[],
    options: PatchOptions,
): History {
    if (options.deleteSheetOp) {
        const { id } = options.deleteSheetOp;
        const sheet = before.sheets.find((s) => s.id === id);
        return {
            patches: [],
            inversePatches: [],
            options: sheet ? { ...options, deletedSheet: storedCopy(sheet) } : options,
        };
    }
    return {
        patches: bySheetId(patches, after.sheets),
        inversePatches: bySheetId(inversePatches, before.sheets),
        options,
    };
}

export function undoEntry(ctx: Context, entry: History): Step {
    const { options } = entry;
    if (options?.deleteSheetOp) {
        const deleted = options.deletedSheet;
        if (!deleted || ctx.sheets.some((sheet) => sheet.id === deleted.id)) return { ctx, ops: [] };
        return sheetStep(ctx, (sheets) => addSheetOps(deleted, sheets));
    }
    if (options?.addSheetOp) {
        const added = addedSheet(entry);
        const sheet = added && ctx.sheets.find((s) => s.id === added.id);
        return sheet ? sheetStep(ctx, (sheets) => deleteSheetOps(sheet, sheets)) : { ctx, ops: [] };
    }
    if (options?.insertRowColOp || options?.deleteRowColOp) {
        return rowColStep(ctx, entry.patches, entry.inversePatches, inverseRowColOptions(options) ?? {});
    }
    return patchStep(ctx, entry.inversePatches, entry.patches);
}

export function redoEntry(ctx: Context, entry: History): Step {
    const { options } = entry;
    if (options?.deleteSheetOp) {
        const sheet = ctx.sheets.find((s) => s.id === options.deleteSheetOp?.id);
        if (!sheet) {
            // A peer deleted it first. The next undo must not bring it back as it was when this user deleted it.
            delete options.deletedSheet;
            return { ctx, ops: [] };
        }
        // The undo after this redo brings back the sheet as the redo found it, a peer's edits since the first delete
        // included. Only this state knows it, so the entry keeps it.
        options.deletedSheet = storedCopy(sheet);
        return sheetStep(ctx, (sheets) => deleteSheetOps(sheet, sheets));
    }
    if (options?.addSheetOp) {
        const added = addedSheet(entry);
        if (!added || ctx.sheets.some((sheet) => sheet.id === added.id)) return { ctx, ops: [] };
        return sheetStep(ctx, (sheets) => addSheetOps(added, sheets));
    }
    if (options?.insertRowColOp || options?.deleteRowColOp) {
        return rowColStep(ctx, entry.inversePatches, entry.patches, options);
    }
    return patchStep(ctx, entry.patches, entry.inversePatches);
}

// A sheet about to be deleted, kept with its cells as stored cells so its undo can add it back.
function storedCopy(sheet: Sheet): Sheet {
    const { data, ...value } = cloneDeep(sheet);
    if (data) value.celldata = dataToCelldata(data);
    value.status = 0;
    return value;
}

// The sheet an add or copy entry put in, as its redo adds it back.
function addedSheet(entry: History): Sheet | undefined {
    return entry.patches.find((patch) => patch.op === 'add' && patch.path.length === 2)?.value;
}

// ['sheets', index, …] → ['sheets', id, …] for a cell or field path. Shorter paths, a whole sheet or the sheet list,
// occur only in sheet add, copy and delete entries, which undo and redo replay as ops.
function bySheetId(patches: Patch[], sheets: Sheet[]): Patch[] {
    return patches.map((patch) => {
        const [root, index, ...rest] = patch.path;
        const id = root === 'sheets' && typeof index === 'number' ? sheets[index].id : undefined;
        if (id == null || rest.length === 0) return patch;
        return { ...patch, path: ['sheets', id, ...rest] };
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
    const applied = applyOpBatch(ctx, ops);
    return applied ? { ctx: produce(applied.ctx, settleCurrentSheet), ops } : { ctx, ops: [] };
}

// A sheet comes back, or goes, through applyOpBatch. The batch it sends also carries the tab order the sheet op left
// behind, which the edit's own batch carries too; here those order ops would change nothing.
function sheetStep(ctx: Context, batch: (sheets: Sheet[]) => Op[]): Step {
    const applied = applyOpBatch(ctx, batch(ctx.sheets).slice(0, 1));
    if (!applied) return { ctx, ops: [] };
    return { ctx: produce(applied.ctx, settleCurrentSheet), ops: batch(applied.ctx.sheets) };
}

// A cell or field entry: `apply` goes in, and `written`, the entry's other side, says what the targets should hold.
// The formula values the entry recorded were right for the inputs of their time, so the step recalculates them.
function patchStep(ctx: Context, apply: Patch[], written: Patch[]): Step {
    const kept = stillWritten(
        ctx,
        withoutDeletedFloatingEdits(ctx, atSheetIndex(ctx, apply)),
        atSheetIndex(ctx, written),
    );
    const patches = withoutComputedValues(ctx, kept);
    if (patches.length === 0) return { ctx, ops: [] };
    const restored = produce(applyPatches(ctx, patches), settleCurrentSheet);
    restored.formulaCache.updateFormulaCache(restored, { patches, inversePatches: [] }, 'redo');
    const [next, recalculated] = produceWithPatches(restored, (draft: Context) => recalculate(draft, patches));
    return { ctx: next, ops: patchToOp(next, [...patches, ...filterPatch(recalculated)]) };
}

// The patches without the value and display text the engine computed for a cell that holds a formula once they
// apply. A peer may have changed that formula's inputs, or the formula itself, since.
function withoutComputedValues(ctx: Context, patches: Patch[]): Patch[] {
    const after = applyPatches(ctx, patches);
    return patches.filter(({ path }) => {
        const [, index, field, r, c, key] = path;
        if (field !== 'data' || path.length !== 6 || (key !== 'v' && key !== 'm')) return true;
        if (typeof index !== 'number' || typeof r !== 'number' || typeof c !== 'number') return true;
        return after.sheets[index].data?.[r]?.[c]?.f == null;
    });
}

// Recomputes each formula the patches wrote, then every formula that reads a cell they wrote, as an edit does.
function recalculate(ctx: Context, patches: Patch[]) {
    const cells = new Map<string, FormulaCell>();
    for (const { path } of patches) {
        const [, index, field, r, c] = path;
        if (field !== 'data' || typeof index !== 'number' || typeof r !== 'number' || typeof c !== 'number') continue;
        const { id } = ctx.sheets[index];
        if (id != null) cells.set(`${r}_${c}_${id}`, { r, c, id });
    }
    if (cells.size === 0) return;
    const resolver = createContextResolver(snapshotContext(ctx));
    for (const { r, c, id } of cells.values()) {
        const data = getFlowdata(ctx, id);
        const f = data?.[r]?.[c]?.f;
        if (!data || f == null) continue;
        const [, v] = execfunction(ctx, f, r, c, id, undefined, false, true, resolver);
        setCellValue(ctx, r, c, data, { v, f });
    }
    ctx.formulaCache.execFunctionExist = [...cells.values()];
    execFunctionGroup(ctx, null, null, null);
    groupValuesRefresh(ctx);
    ctx.formulaCache.execFunctionGlobalData = null;
}

// A row or column entry, `from` what the op left to `to`. The batch is the marker, the edited sheet's fields and a
// repair of the cells. The fields are what the marker makes of the live sheet, so a peer's edit since survives, with
// what the entry restores beyond that. The live context gets only the ops.
function rowColStep(ctx: Context, from: Patch[], to: Patch[], options: PatchOptions): Step {
    const marker = rowColMarker(options);
    const index = marker?.id == null ? undefined : getSheetIndex(ctx, marker.id);
    if (!marker || index == null) return { ctx, ops: [] };
    const left = withoutDeletedFloatingEdits(ctx, atSheetIndex(ctx, from));
    const target = withoutDeletedFloatingEdits(ctx, atSheetIndex(ctx, to));
    const restored = applyPatches(ctx, target);
    // What the marker alone makes of the sheet the op left, and of the live sheet.
    const made = applyOpBatch(applyPatches(ctx, left), [marker]);
    const live = applyOpBatch(ctx, [marker]);
    if (!made || !live) return { ctx, ops: [] };
    const fields = restoredFields(index, target, restored, made.ctx, live.ctx);
    const step = { fields, repair: repairOps(ctx, left, target, options) };
    return applyBatch(ctx, patchToOp(restored, target, options, step));
}

// The edited sheet's fields as a row or column step leaves them: each as the marker makes it of the live sheet, but a
// field the entry recorded takes the entry's value wherever the marker alone would not bring that back, such as a
// deleted row's height or link. A map merges key by key, `config` one level deeper, so a key a peer changed since
// keeps the peer's value.
function restoredFields(index: number, recorded: Patch[], restored: Context, made: Context, live: Context) {
    const fields: Record<string, unknown> = { ...live.sheets[index] };
    const wanted: Record<string, unknown> = restored.sheets[index];
    const marked: Record<string, unknown> = made.sheets[index];
    for (const { path } of recorded) {
        const [, sheet, field] = path;
        if (path.length !== 3 || sheet !== index || typeof field !== 'string' || field === 'data') continue;
        if (field === 'calcChain') {
            fields.calcChain = restoredChain(
                restored.sheets[index].calcChain ?? [],
                made.sheets[index].calcChain ?? [],
                live.sheets[index].calcChain ?? [],
            );
            continue;
        }
        const depth = field === 'config' ? 2 : field === 'hyperlink' || field === 'dataVerification' ? 1 : 0;
        fields[field] = restoredValue(wanted[field], marked[field], fields[field], depth);
    }
    return fields;
}

// `wanted` is the entry's value, `made` what the marker makes of the value the op left, and `live` what it makes of
// the live value. Where `made` and `live` differ, a peer changed the value since.
function restoredValue(wanted: unknown, made: unknown, live: unknown, depth: number): unknown {
    if (isEqual(wanted, made)) return live;
    if (depth === 0 || !isRecord(wanted) || !isRecord(made) || !isRecord(live)) {
        return isEqual(live, made) ? wanted : live;
    }
    const merged = { ...live };
    for (const key of new Set([...Object.keys(wanted), ...Object.keys(made)])) {
        const value = restoredValue(wanted[key], made[key], live[key], depth - 1);
        if (value === undefined) delete merged[key];
        else merged[key] = value;
    }
    return merged;
}

// The recalc list is a set of formula cells: the entry's cells the marker would not bring back join the live list.
function restoredChain(wanted: CalcChainEntry[], made: CalcChainEntry[], live: CalcChainEntry[]) {
    const key = ({ r, c, id }: CalcChainEntry) => `${r}_${c}_${id}`;
    const wantedKeys = new Set(wanted.map(key));
    const madeKeys = new Set(made.map(key));
    const chain = live.filter((cell) => wantedKeys.has(key(cell)) || !madeKeys.has(key(cell)));
    const kept = new Set(chain.map(key));
    for (const cell of wanted) if (!madeKeys.has(key(cell)) && !kept.has(key(cell))) chain.push(cell);
    return chain;
}

// The cells the marker alone leaves different from what the entry restores: rows a delete took, and a formula it made
// #REF! or shrank, on any sheet. A cell a peer changed since the op keeps the peer's value.
function repairOps(ctx: Context, from: Patch[], to: Patch[], options: PatchOptions): Op[] {
    const left = matrices(from);
    const wanted = matrices(to);
    const move = rowColMove(options);
    if (!move || wanted.size === 0) return [];
    const sheets = ctx.sheets.map((sheet, index) => {
        const data = left.get(index);
        return data ? { ...sheet, data } : sheet;
    });
    let moved: Sheet[];
    try {
        moved = move.sheets(sheets);
    } catch (e) {
        if (!(e instanceof RowColError)) throw e;
        return [];
    }
    const ops: Op[] = [];
    for (const [index, rows] of wanted) {
        const { id } = ctx.sheets[index];
        const after = moved[index].data ?? [];
        const was = left.get(index) ?? [];
        const live = ctx.sheets[index].data ?? [];
        for (let r = 0; r < rows.length; r += 1) {
            if (rows[r] === after[r]) continue;
            const width = Math.max(rows[r]?.length ?? 0, after[r]?.length ?? 0);
            for (let c = 0; c < width; c += 1) {
                const cell = rows[r]?.[c] ?? null;
                if (isEqual(cell, after[r]?.[c] ?? null)) continue;
                // Where the cell was before the marker; a row or column the marker inserts has nothing to check.
                const row = id === move.id && move.type === 'row' ? move.from(r) : r;
                const column = id === move.id && move.type === 'column' ? move.from(c) : c;
                const changed =
                    row != null &&
                    column != null &&
                    !isEqual(authored(live[row]?.[column]), authored(was[row]?.[column]));
                if (!changed) ops.push({ op: 'replace', id, path: ['data', r, c], value: cell });
            }
        }
    }
    return ops;
}

// The whole matrices a row or column entry records, by sheet index.
function matrices(patches: Patch[]) {
    const found = new Map<number, CellMatrix>();
    for (const { path, value } of patches) {
        const [, index, field] = path;
        if (path.length === 3 && field === 'data' && typeof index === 'number') found.set(index, value);
    }
    return found;
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
            const { r, c, rs, cs }: MergeCell = patch.value;
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
    const current = get(ctx, unit);
    const rebased = patches.map((patch) => ({ ...patch, path: ['value', ...patch.path.slice(unit.length)] }));
    try {
        const { value } = applyPatches({ value: current }, rebased);
        if (unit[2] !== 'data' || unit.length !== 5) return isEqual(value, current);
        return isEqual(authored(value), authored(current));
    } catch {
        return false;
    }
}
