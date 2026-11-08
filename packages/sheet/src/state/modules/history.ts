// What ⌘Z and ⌘⇧Z do in this tab. An edit is recorded as an entry of immer patches that names its sheet by id. Undo and
// redo take the context and an entry and return the next context and the batch to send. A cell or field entry skips a
// target a peer changed since and recalculates the formulas it writes back. A structural entry, such as a row op, a
// rename or a paste that grew the grid, leaves the stacks at a peer's first batch, so it always finds the workbook as
// it left it. A row or sheet step applies exactly the ops it sends, through applyOpBatch, as its peers will. The
// Workbook keeps the stacks.

import type { MergeCell } from '@workspace/lib/sheets';
import { parseCellKey } from '@workspace/lib/sheets';
import { get, isEqual } from 'es-toolkit/compat';
import type { Patch } from 'immer';
import { applyPatches, produce, produceWithPatches } from 'immer';
import { computedKey, createArrayResolver } from '../../engine/cell-resolver';
import type { Cell, CellMatrix } from '../../engine/types';
import { getSheet } from '../api/common';
import type { Context } from '../context';
import { getFlowdata } from '../context';
import type { FormulaCell, History, Op, Sheet } from '../types';
import type { EntryOptions, PatchOptions } from '../utils';
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
import { computeFormula, execFunctionGroup } from './formula-exec';
import { namesStructuralOp, unitOf } from './history-shift';
import { settleCurrentSheet, shiftSheetOrders } from './sheet';

type Step = { ctx: Context; ops: Op[] };

// What setContextWithProduce keeps of one edit. A sheet add, delete or rename keeps only what its undo needs, because
// undo and redo are ops. A row or column op keeps what its undo brings back, because its redo is its marker again.
export function recordEntry(
    before: Context,
    after: Context,
    patches: Patch[],
    inversePatches: Patch[],
    { insertRowColOp, deleteRowColOp, addSheetOp, deleteSheetOp, renameSheetOp }: PatchOptions,
): History {
    const structural = (options: EntryOptions): History => ({ patches: [], inversePatches: [], options });
    if (renameSheetOp) {
        const { id } = renameSheetOp;
        return structural({
            renamedSheet: { id, from: getSheet(before, { id }).name, to: getSheet(after, { id }).name },
        });
    }
    if (deleteSheetOp) return structural({ deletedSheet: storedCopy(getSheet(before, { id: deleteSheetOp.id })) });
    // An add puts its sheet last in the list, whatever its order.
    if (addSheetOp) return structural({ addedSheet: storedCopy(after.sheets[after.sheets.length - 1]) });
    const rowCol = { insertRowColOp, deleteRowColOp };
    return {
        patches: rowColMarker(rowCol) ? [] : bySheetId(patches, after.sheets),
        inversePatches: bySheetId(inversePatches, before.sheets),
        options: rowCol,
    };
}

// How far back undo reaches. A row, column or sheet entry may hold whole cell matrices, so fewer of those stay.
const MAX_ENTRIES = 200;
const MAX_STRUCTURAL_OP_ENTRIES = 10;

// Puts an edit's entry on the undo stack and drops the oldest entries past those limits. Only the oldest ever go: an
// entry fits the grid as the entries above it leave it, so one dropped from the middle would misplace the rest.
export function pushEntry(stack: History[], entry: History) {
    stack.push(entry);
    let keep = Math.min(stack.length, MAX_ENTRIES);
    let structuralOps = 0;
    for (let i = stack.length - 1; i >= stack.length - keep; i -= 1) {
        if (!namesStructuralOp(stack[i])) continue;
        structuralOps += 1;
        if (structuralOps > MAX_STRUCTURAL_OP_ENTRIES) keep = stack.length - 1 - i;
    }
    stack.splice(0, stack.length - keep);
}

// Runs the newest entry of `from` and moves it onto `to`: an undo takes it from the undo stack to the redo stack, and a
// redo back. An entry that did nothing leaves both, because stepping it back would apply what never was undone.
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
    if (next.ops.length > 0) to.push(entry);
    return next;
}

export function undoEntry(ctx: Context, { options, patches, inversePatches }: History): Step {
    const { addedSheet, deletedSheet, renamedSheet } = options;
    if (deletedSheet) return sheetStep(ctx, (sheets) => addSheetOps(deletedSheet, sheets));
    if (addedSheet) return sheetStep(ctx, (sheets) => deleteSheetOps(addedSheet, sheets));
    if (renamedSheet) return batchStep(ctx, renameSheetOps(renamedSheet.id, renamedSheet.from));
    const marker = rowColMarker(inverseRowColOptions(options));
    if (marker) return undoRowCol(ctx, marker, inversePatches);
    return patchStep(ctx, inversePatches, patches);
}

export function redoEntry(ctx: Context, { options, patches, inversePatches }: History): Step {
    const { addedSheet, deletedSheet, renamedSheet } = options;
    if (deletedSheet) return sheetStep(ctx, (sheets) => deleteSheetOps(deletedSheet, sheets));
    if (addedSheet) return sheetStep(ctx, (sheets) => addSheetOps(addedSheet, sheets));
    if (renamedSheet) return batchStep(ctx, renameSheetOps(renamedSheet.id, renamedSheet.to));
    const marker = rowColMarker(options);
    if (marker) return batchStep(ctx, [marker]);
    return patchStep(ctx, patches, inversePatches);
}

// An entry's path names its sheet by id, ['sheets', id, …], where an edit's names it by index.
function bySheetId(patches: Patch[], sheets: Sheet[]): Patch[] {
    return patches.map((patch) => {
        const [, index, ...rest] = patch.path;
        return { ...patch, path: ['sheets', sheets[Number(index)].id, ...rest] };
    });
}

// The entry's paths on today's sheet indices; a patch on a sheet that is gone is dropped.
function atSheetIndex(ctx: Context, patches: Patch[]): Patch[] {
    return patches.flatMap((patch) => {
        const [, id, ...rest] = patch.path;
        const index = getSheetIndex(ctx, String(id));
        return index == null ? [] : [{ ...patch, path: ['sheets', index, ...rest] }];
    });
}

// A batch that says all it does, such as a rename or a row op's redo, runs here as it does on a peer.
function batchStep(ctx: Context, ops: Op[]): Step {
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
    restored.formulaCache.updateFormulaCache(restored, patches);
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
        cells.set(computedKey(r, c, id), { r, c, id });
    }
    if (cells.size === 0) return;
    const resolver = createArrayResolver(snapshotContext(ctx).sheets);
    for (const { r, c, id } of cells.values()) {
        const data = getFlowdata(ctx, id);
        const f = data?.[r]?.[c]?.f;
        if (!data || f == null) continue;
        const [v] = computeFormula(ctx, f, { id, resolver });
        setCellValue(ctx, r, c, data, { v, f });
    }
    execFunctionGroup(ctx, [...cells.values()]);
}

// The batch is the marker and what it did not bring back of the recorded fields and cells. A write the marker already
// made stays off the wire, so a receiver keeps its own shift of a batch on its way.
function undoRowCol(ctx: Context, marker: Op, recorded: Patch[]): Step {
    const moved = applyOpBatch(ctx, [marker]);
    if (!moved) return { ctx, ops: [] };
    const restored: Op[] = [];
    for (const { op, path, value } of recorded) {
        const [, id, ...rest] = path;
        const sheet = moved.ctx.sheets.find((s) => s.id === id);
        if (!sheet) continue;
        if (rest.length === 1 && rest[0] === 'data') restored.push(...repairOps(sheet, value));
        else if (!isEqual(get(sheet, rest), value)) restored.push({ op, id: sheet.id, path: rest, value });
    }
    const applied = applyOpBatch(moved.ctx, restored, false);
    return applied ? { ctx: produce(applied.ctx, settleCurrentSheet), ops: [marker, ...restored] } : { ctx, ops: [] };
}

// The cells the marker left different from the recorded matrix, such as rows a delete took and a formula it made #REF!.
function repairOps(sheet: Sheet, recorded: CellMatrix): Op[] {
    const ops: Op[] = [];
    const after = sheet.data ?? [];
    for (let r = 0; r < recorded.length; r += 1) {
        if (recorded[r] === after[r]) continue;
        const width = Math.max(recorded[r]?.length ?? 0, after[r]?.length ?? 0);
        for (let c = 0; c < width; c += 1) {
            const cell = recorded[r]?.[c] ?? null;
            if (!isEqual(cell, after[r]?.[c] ?? null)) {
                ops.push({ op: 'replace', id: sheet.id, path: ['data', r, c], value: cell });
            }
        }
    }
    return ops;
}

// What a person wrote into a cell: a formula's value, its display text and its value type are the engine's.
function authored(cell: Cell | null | undefined) {
    if (cell?.f == null) return cell ?? null;
    const { v, m, ct, ...rest } = cell;
    return ct ? { ...rest, fa: ct.fa } : rest;
}

// The patches whose targets still hold what the entry wrote there: a target a peer changed since keeps the peer's
// value, as Google does. A merge and its cells, and a link and its cell, pass or skip together.
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
        const write = writes.get(key) ?? { unit, patches: [] };
        write.patches.push(patch);
        writes.set(key, write);
    }
    const changed = new Set<string>();
    for (const [key, { unit, patches }] of writes) if (!holds(ctx, unit, patches)) changed.add(find(key));
    if (changed.size === 0) return apply;
    return apply.filter((patch) => !changed.has(find(JSON.stringify(unitOf(patch.path)))));
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
