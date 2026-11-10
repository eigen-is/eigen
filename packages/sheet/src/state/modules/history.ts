// What ⌘Z and ⌘⇧Z do in this tab. An edit is recorded as an entry of immer patches that names its sheet by id, and
// undo and redo turn an entry into the next context and the batch to send. A cell or field entry skips a target a peer
// changed since and recalculates the formulas it writes back. A structural entry, such as a row op or a rename, leaves
// the stacks at a peer's first batch, so it always finds the workbook as it left it, and its step applies exactly the
// ops it sends, through applyOpBatch, as its peers will. The Workbook keeps the stacks.

import type { MergeCell } from '@workspace/lib/sheets';
import { get, isEqual } from 'es-toolkit/compat';
import type { Patch } from 'immer';
import { applyPatches, produce, produceWithPatches } from 'immer';
import { computedKey, createArrayResolver } from '../../engine/cell-resolver';
import { applyRowColOp } from '../../engine/replay-ops';
import { RowColError } from '../../engine/rowcol';
import type { Cell, CellMatrix } from '../../engine/types';
import { getSheet } from '../api/common';
import type { Context } from '../context';
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
import { withoutDeletedFloatingEdits } from './floating';
import { execFunctionGroup } from './formula-exec';
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
    if (deleteSheetOp) {
        return {
            patches: [],
            inversePatches: rewrittenByDelete(before, after),
            options: { deletedSheet: storedCopy(getSheet(before, { id: deleteSheetOp.id })) },
        };
    }
    // An add puts its sheet last in the list, whatever its order.
    if (addSheetOp) return structural({ addedSheet: storedCopy(after.sheets[after.sheets.length - 1]) });
    const rowCol = { insertRowColOp, deleteRowColOp };
    return {
        patches: rowColMarker(rowCol) ? [] : bySheetId(patches, after.sheets),
        inversePatches: bySheetId(inversePatches, before.sheets),
        options: rowCol,
    };
}

// What a sheet's delete changed on the sheets it left: the texts naming it and what reads them.
function rewrittenByDelete(before: Context, after: Context): Patch[] {
    const recorded: Patch[] = [];
    for (const sheet of after.sheets) {
        const was = getSheet(before, { id: sheet.id });
        for (const field of ['data', 'conditionalFormatRules', 'dataValidations'] as const) {
            if (was[field] === sheet[field]) continue;
            recorded.push({ op: 'replace', path: ['sheets', sheet.id, field], value: was[field] });
        }
    }
    return recorded;
}

// An entry's path names its sheet by id, ['sheets', id, …], where an edit's names it by index.
function bySheetId(patches: Patch[], sheets: Sheet[]): Patch[] {
    return patches.map((patch) => {
        const [, index, ...rest] = patch.path;
        return { ...patch, path: ['sheets', sheets[Number(index)].id, ...rest] };
    });
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
    if (deletedSheet) return sheetStep(ctx, (after) => addSheetOps(deletedSheet, ctx.sheets, after), inversePatches);
    if (addedSheet) return sheetStep(ctx, (after) => deleteSheetOps(addedSheet, ctx.sheets, after));
    if (renamedSheet) return batchStep(ctx, renameSheetOps(renamedSheet.id, renamedSheet.from));
    const marker = rowColMarker(inverseRowColOptions(options));
    if (marker) return undoRowCol(ctx, marker, inversePatches);
    return patchStep(ctx, inversePatches, patches);
}

export function redoEntry(ctx: Context, { options, patches, inversePatches }: History): Step {
    const { addedSheet, deletedSheet, renamedSheet } = options;
    if (deletedSheet) return sheetStep(ctx, (after) => deleteSheetOps(deletedSheet, ctx.sheets, after));
    if (addedSheet) return sheetStep(ctx, (after) => addSheetOps(addedSheet, ctx.sheets, after));
    if (renamedSheet) return batchStep(ctx, renameSheetOps(renamedSheet.id, renamedSheet.to));
    const marker = rowColMarker(options);
    if (marker) return batchStep(ctx, [marker]);
    return patchStep(ctx, patches, inversePatches);
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

// A sheet comes back, or goes, through applyOpBatch, as a peer's would, with what its delete rewrote on the other
// sheets. The step is the author here, so it moves the other sheets' orders itself, and the batch it sends carries the
// orders it moved.
function sheetStep(ctx: Context, batch: (after: Sheet[]) => Op[], recorded: Patch[] = []): Step {
    const [sheetOp] = batch(ctx.sheets);
    const restored = restoredOps(ctx.sheets, recorded);
    const applied = applyOpBatch(ctx, [sheetOp, ...restored]);
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
    return { ctx: next, ops: [...batch(next.sheets), ...restored] };
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
    restored.formulaCache.followPatches(restored, patches);
    const [next, recalculated] = produceWithPatches(restored, (draft: Context) => recalculate(draft, patches));
    return { ctx: next, ops: patchToOp(ctx, next, [...patches, ...filterPatch(recalculated)]) };
}

// The patches without the value and display text the engine computes for a cell that holds a formula once they apply.
// A peer may have changed that formula's inputs, or the formula itself, since. A formula the engine can't calculate
// keeps them, as a recompute keeps what it holds.
function withoutComputedValues(ctx: Context, patches: Patch[]): Patch[] {
    const after = applyPatches(ctx, patches);
    const { engine } = ctx.formulaCache;
    const resolver = createArrayResolver(after.sheets);
    return patches.filter(({ path }) => {
        const [, index, field, r, c, key] = path;
        if (field !== 'data' || path.length !== 6 || (key !== 'v' && key !== 'm')) return true;
        if (typeof index !== 'number' || typeof r !== 'number' || typeof c !== 'number') return true;
        const { id, data } = after.sheets[index];
        const f = data?.[r]?.[c]?.f;
        return f == null || engine.cantEvaluate(f, engine.evaluate(f, id, resolver));
    });
}

// Recomputes each formula the patches wrote and every formula that reads a cell they wrote, as an edit does.
function recalculate(ctx: Context, patches: Patch[]) {
    const cells = new Map<string, FormulaCell>();
    for (const { path } of patches) {
        const [, index, field, r, c] = path;
        if (field !== 'data' || typeof index !== 'number' || typeof r !== 'number' || typeof c !== 'number') continue;
        const { id } = ctx.sheets[index];
        cells.set(computedKey(r, c, id), { r, c, id });
    }
    if (cells.size === 0) return;
    const written = [...cells.values()];
    execFunctionGroup(ctx, written, written);
}

// The batch is the marker and what it did not bring back of the recorded fields and cells, read off the engine's own
// result of the marker. Every reader then recomputes after the whole batch, so what the marker disturbed on a sheet the
// entry never recorded comes back through the repairs. A write the marker already made stays off the wire, so a
// receiver keeps its own shift of a batch on its way.
function undoRowCol(ctx: Context, marker: Op, recorded: Patch[]): Step {
    let moved: Sheet[];
    try {
        moved = applyRowColOp(ctx.sheets, marker);
    } catch (e) {
        if (e instanceof RowColError) return { ctx, ops: [] };
        throw e;
    }
    const restored = restoredOps(moved, recorded);
    const ops = [marker, ...restored];
    const applied = applyOpBatch(ctx, ops);
    return applied ? { ctx: produce(applied.ctx, settleCurrentSheet), ops } : { ctx, ops: [] };
}

// The recorded writes `sheets` don't hold yet, the cells one by one.
function restoredOps(sheets: Sheet[], recorded: Patch[]): Op[] {
    const restored: Op[] = [];
    for (const { op, path, value } of recorded) {
        const [, id, ...rest] = path;
        const sheet = sheets.find((s) => s.id === id);
        if (!sheet) continue;
        if (rest.length === 1 && rest[0] === 'data') restored.push(...repairOps(sheet, value));
        else if (!isEqual(get(sheet, rest), value)) restored.push({ op, id: sheet.id, path: rest, value });
    }
    return restored;
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

// The patches whose targets still hold what the entry wrote there: a target a peer changed since keeps the peer's
// value, as Google does. A merge and its cells pass or skip together.
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

// What a person wrote into a cell: a formula's value, its display text and its value type are the engine's.
function authored(cell: Cell | null | undefined) {
    if (cell?.f == null) return cell ?? null;
    const { v, m, ct, ...rest } = cell;
    return ct ? { ...rest, fa: ct.fa } : rest;
}
