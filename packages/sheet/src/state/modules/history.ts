// What ⌘Z and ⌘⇧Z do in this tab. An edit is recorded as an entry of immer patches that names its sheet by id. Undo and
// redo take the context and an entry and return the next context and the batch to send. A cell or field entry skips a
// target a peer changed since. A sheet, row or column entry builds ops and applies exactly those, through
// applyOpBatch, as its peers will. The Workbook keeps the stacks and calls these from, for example, handleUndo.

import type { MergeCell } from '@workspace/lib/sheets';
import { parseCellKey } from '@workspace/lib/sheets';
import { cloneDeep, get, isEqual } from 'es-toolkit/compat';
import type { Patch } from 'immer';
import { applyPatches, produce } from 'immer';
import { dataToCelldata } from '../../engine/celldata';
import { RowColError } from '../../engine/rowcol';
import type { Cell, CellMatrix } from '../../engine/types';
import type { Context } from '../context';
import type { History, Op, Sheet } from '../types';
import type { PatchOptions } from '../utils';
import { addSheetOps, deleteSheetOps, getSheetIndex, inverseRowColOptions, patchToOp } from '../utils';
import { applyOpBatch } from './apply-ops';
import { withoutDeletedFloatingEdits } from './floating';
import { rowColMove } from './history-shift';
import { settleCurrentSheet } from './sheet';

type Step = { ctx: Context; ops: Op[] };

// What setContextWithProduce keeps of one edit. It fills in the options the edit's ops need too. A sheet delete keeps
// only the deleted sheet: its undo and redo are ops, and its patches would hold the whole sheet list twice.
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
        if (sheet) options.deletedSheet = storedCopy(sheet);
        return { patches: [], inversePatches: [], options };
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
        return rowColStep(ctx, entry.patches, entry.inversePatches, inverseRowColOptions(options) ?? {}, true);
    }
    return patchStep(ctx, entry.inversePatches, entry.patches);
}

export function redoEntry(ctx: Context, entry: History): Step {
    const { options } = entry;
    if (options?.deleteSheetOp) {
        const sheet = ctx.sheets.find((s) => s.id === options.deleteSheetOp?.id);
        if (!sheet) return { ctx, ops: [] };
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
        return rowColStep(ctx, entry.inversePatches, entry.patches, options, false);
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
    const next = applyOpBatch(ctx, ops);
    return next ? { ctx: produce(next, settleCurrentSheet), ops } : { ctx, ops: [] };
}

// A sheet comes back, or goes, through applyOpBatch. The batch it sends also carries the tab order the sheet op left
// behind, which the edit's own batch carries too; here those order ops would change nothing.
function sheetStep(ctx: Context, batch: (sheets: Sheet[]) => Op[]): Step {
    const next = applyOpBatch(ctx, batch(ctx.sheets).slice(0, 1));
    return next ? { ctx: produce(next, settleCurrentSheet), ops: batch(next.sheets) } : { ctx, ops: [] };
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
