// What ⌘Z and ⌘⇧Z do in this tab. An edit is recorded as an entry of immer patches that names its sheet by id. Undo and
// redo take the context and an entry and return the next context and the batch to send. A cell or field entry skips a
// target a peer changed since and recalculates the formulas it writes back. A sheet, row or column entry leaves the
// stacks at a peer's first batch, so it always finds the grid as it left it, and it applies exactly the ops it sends,
// through applyOpBatch, as its peers will. The Workbook keeps the stacks.

import type { MergeCell } from '@workspace/lib/sheets';
import { parseCellKey } from '@workspace/lib/sheets';
import { get, isEqual } from 'es-toolkit/compat';
import type { Patch } from 'immer';
import { applyPatches, produce, produceWithPatches } from 'immer';
import { createArrayResolver } from '../../engine/cell-resolver';
import { celldataToData } from '../../engine/celldata';
import { isRowColOp } from '../../engine/replay-ops';
import type { Cell, CellMatrix } from '../../engine/types';
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
    renameSheetOps,
    rowColMarker,
    sheetOrder,
    storedCopy,
} from '../utils';
import { applyOpBatch } from './apply-ops';
import { setCellValue } from './cell';
import { withoutDeletedFloatingEdits } from './floating';
import { snapshotContext } from './formula-cache';
import { execFunctionGroup, execfunction, groupValuesRefresh } from './formula-exec';
import { settleCurrentSheet, shiftSheetOrders } from './sheet';

type Step = { ctx: Context; ops: Op[] };

// What setContextWithProduce keeps of one edit. Its options are the ones the edit's batch is built from. A sheet
// delete adds the deleted sheet to them and keeps nothing else, because its undo and redo are ops and its patches
// would hold the whole sheet list twice. A rename keeps only its options too, since its undo and redo rename again.
export function recordEntry(
    before: Context,
    after: Context,
    patches: Patch[],
    inversePatches: Patch[],
    options: PatchOptions,
): History {
    if (options.renameSheetOp) return { patches: [], inversePatches: [], options };
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

// How far back undo reaches. A row, column or sheet entry holds whole cell matrices, so fewer of those stay.
const MAX_ENTRIES = 200;
const MAX_WHOLE_MATRIX_ENTRIES = 10;

// Puts an edit's entry on the undo stack and drops the oldest entries past those limits. Only the oldest ever go: an
// entry fits the grid as the entries above it leave it, so one dropped from the middle would misplace the rest.
export function pushEntry(stack: History[], entry: History) {
    stack.push(entry);
    let keep = Math.min(stack.length, MAX_ENTRIES);
    let whole = 0;
    for (let i = stack.length - 1; i >= stack.length - keep; i -= 1) {
        if (!holdsWholeMatrices(stack[i])) continue;
        whole += 1;
        if (whole > MAX_WHOLE_MATRIX_ENTRIES) keep = stack.length - 1 - i;
    }
    stack.splice(0, stack.length - keep);
}

function holdsWholeMatrices({ patches, inversePatches, options }: History): boolean {
    const whole = ({ path }: Patch) => path.length === 2 || (path.length === 3 && path[2] === 'data');
    return options?.deletedSheet != null || patches.some(whole) || inversePatches.some(whole);
}

// Runs the newest entry of `from` and moves it onto `to`: an undo takes it from the undo stack to the redo stack, and a
// redo back.
export function stepNewestEntry(
    ctx: Context,
    from: History[],
    to: History[],
    step: (ctx: Context, entry: History) => Step,
): Step | undefined {
    const entry = from.at(-1);
    if (!entry) return undefined;
    const next = step(ctx, entry);
    from.pop();
    to.push(entry);
    return next;
}

export function undoEntry(ctx: Context, entry: History): Step {
    const { options } = entry;
    if (options?.deleteSheetOp) {
        const deleted = options.deletedSheet;
        return deleted ? sheetStep(ctx, (sheets) => addSheetOps(deleted, sheets)) : { ctx, ops: [] };
    }
    if (options?.addSheetOp) {
        const added = addedSheet(entry);
        const sheet = added && ctx.sheets.find((s) => s.id === added.id);
        return sheet ? sheetStep(ctx, (sheets) => deleteSheetOps(sheet, sheets)) : { ctx, ops: [] };
    }
    if (options?.insertRowColOp || options?.deleteRowColOp) {
        return rowColStep(ctx, entry.inversePatches, inverseRowColOptions(options) ?? {});
    }
    if (options?.renameSheetOp) return renameStep(ctx, options.renameSheetOp.id, options.renameSheetOp.from);
    return patchStep(ctx, entry.inversePatches, entry.patches);
}

export function redoEntry(ctx: Context, entry: History): Step {
    const { options } = entry;
    if (options?.deleteSheetOp) {
        const sheet = ctx.sheets.find((s) => s.id === options.deleteSheetOp?.id);
        return sheet ? sheetStep(ctx, (sheets) => deleteSheetOps(sheet, sheets)) : { ctx, ops: [] };
    }
    if (options?.addSheetOp) {
        const added = addedSheet(entry);
        return added ? sheetStep(ctx, (sheets) => addSheetOps(added, sheets)) : { ctx, ops: [] };
    }
    if (options?.insertRowColOp || options?.deleteRowColOp) {
        return rowColStep(ctx, entry.patches, options);
    }
    if (options?.renameSheetOp) return renameStep(ctx, options.renameSheetOp.id, options.renameSheetOp.name);
    return patchStep(ctx, entry.patches, entry.inversePatches);
}

// The sheet an add or copy entry put in, as its redo adds it back.
function addedSheet(entry: History): Sheet | undefined {
    return entry.patches.find((patch) => patch.op === 'add' && patch.path.length === 2)?.value;
}

// Rewrites a cell or field path from ['sheets', index, …] to ['sheets', id, …]. A shorter path, such as a whole sheet
// or the sheet list, occurs only in a sheet add, copy or delete entry, which undo and redo replay as ops.
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

function renameStep(ctx: Context, id: string, name: string): Step {
    const ops = renameSheetOps(id, name);
    const applied = applyOpBatch(ctx, ops);
    return applied ? { ctx: produce(applied.ctx, settleCurrentSheet), ops } : { ctx, ops: [] };
}

// A sheet comes back, or goes, through applyOpBatch, as a peer's would. The step is the author here, so it moves the
// other sheets' orders itself, and the batch it sends carries the orders it left.
function sheetStep(ctx: Context, batch: (sheets: Sheet[]) => Op[]): Step {
    const [sheetOp] = batch(ctx.sheets);
    const applied = applyOpBatch(ctx, [sheetOp]);
    if (!applied) return { ctx, ops: [] };
    const next = produce(applied.ctx, (draft: Context) => {
        if (sheetOp.op === 'addSheet') {
            const others = draft.sheets.filter((sheet) => sheet.id !== sheetOp.id);
            shiftSheetOrders(others, sheetOrder(sheetOp.value), 1);
        } else {
            const deleted = ctx.sheets.find((sheet) => sheet.id === sheetOp.id);
            if (deleted) shiftSheetOrders(draft.sheets, sheetOrder(deleted), -1);
        }
        settleCurrentSheet(draft);
    });
    return { ctx: next, ops: batch(next.sheets) };
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
    const resolver = createArrayResolver(snapshotContext(ctx).sheets);
    for (const { r, c, id } of cells.values()) {
        const data = getFlowdata(ctx, id);
        const f = data?.[r]?.[c]?.f;
        if (!data || f == null) continue;
        const [, v] = execfunction(ctx, f, r, c, { id, notInsertFunc: true, resolver });
        setCellValue(ctx, r, c, data, { v, f });
    }
    ctx.formulaCache.execFunctionExist = [...cells.values()];
    execFunctionGroup(ctx, null, null, null);
    groupValuesRefresh(ctx);
    ctx.formulaCache.execFunctionGlobalData = null;
}

// A row or column entry: the marker moves the grid, and `target`, the entry's side to reach, gives what the marker alone
// would not bring back, which is the fields the op wrote and a repair of the cells. The batch is the marker and those,
// and the live context gets only the ops. The marker's run is the step's own, so the repair is what it leaves undone.
function rowColStep(ctx: Context, target: Patch[], options: PatchOptions): Step {
    const marker = rowColMarker(options);
    const moved = marker && applyOpBatch(ctx, [marker]);
    if (!moved) return { ctx, ops: [] };
    const fields: Record<string, unknown> = {};
    for (const { path, value } of target) {
        const [, id, field] = path;
        if (path.length === 3 && id === marker.id && typeof field === 'string') fields[field] = value;
    }
    // A write the marker already made stays off the wire, so a receiver keeps its own shift of a batch on its way.
    const patches = atSheetIndex(ctx, target).filter(
        ({ path, value }) => path.length === 3 || !isEqual(get(moved.ctx, path), value),
    );
    const ops = patchToOp(ctx, patches, options, { fields, repair: repairOps(moved.ctx, patches) });
    const applied = applyOpBatch(
        moved.ctx,
        ops.filter((op) => !isRowColOp(op)),
        false,
    );
    return applied ? { ctx: produce(applied.ctx, settleCurrentSheet), ops } : { ctx, ops: [] };
}

// The cells the marker left different from the matrices the entry restores, such as rows a delete took and a formula it
// made #REF! or shrank, on any sheet.
function repairOps(moved: Context, patches: Patch[]): Op[] {
    const ops: Op[] = [];
    for (const [index, rows] of matrices(patches)) {
        const sheet = moved.sheets[index];
        const after = sheet.data ?? celldataToData(sheet.celldata ?? [], 0, 0);
        for (let r = 0; r < rows.length; r += 1) {
            if (rows[r] === after[r]) continue;
            const width = Math.max(rows[r]?.length ?? 0, after[r]?.length ?? 0);
            for (let c = 0; c < width; c += 1) {
                const cell = rows[r]?.[c] ?? null;
                if (!isEqual(cell, after[r]?.[c] ?? null)) {
                    ops.push({ op: 'replace', id: sheet.id, path: ['data', r, c], value: cell });
                }
            }
        }
    }
    return ops;
}

// The whole matrices a row or column entry records, by sheet index. A sheet that holds only its stored cells has no
// matrix, so the entry records those.
function matrices(patches: Patch[]) {
    const found = new Map<number, CellMatrix>();
    for (const { path, value } of patches) {
        const [, index, field] = path;
        if (path.length !== 3 || typeof index !== 'number') continue;
        if (field === 'data') found.set(index, value);
        else if (field === 'celldata') found.set(index, celldataToData(value, 0, 0));
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
