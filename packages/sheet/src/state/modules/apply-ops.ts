// Applies one op batch to the editor's context. applySheetsBatch, which the replay applies a joiner's batches with,
// runs on the plain sheets outside immer, and one recipe writes what changed into the context. Every sheet, row or
// column change of the open workbook comes through here, such as a peer's batch, an undo step or the author's own row
// op, so every tab ends the same. It reports the ops that moved rows, which the undo stacks follow, and a batch new to
// the tab moves its view too.

import { isRecord } from '@workspace/lib/guards';
import { produce } from 'immer';
import { applySheetsBatch } from '../../engine/replay-ops';
import type { Context } from '../context';
import type { Op, Sheet } from '../types';
import { getSheetIndex } from '../utils';
import { snapshotContext } from './formula-cache';
import type { RowColMove } from './history-shift';
import { deleteMove, insertMove } from './history-shift';
import { followView } from './rowcol';
import { initSheetData, leaveCurrentSheet } from './sheet';

// A row or column op the batch applied, with the sheets it was applied to.
type AppliedRowCol = { move: RowColMove; sheets: Sheet[] };

// The next context and the row or column ops that moved rows, or null when an op failed and the batch was skipped. A
// replay passes moveView false for a batch the tab applied before, which already moved the view once.
export function applyOpBatch(
    ctx: Context,
    ops: Op[],
    moveView = true,
): { ctx: Context; moved: AppliedRowCol[] } | null {
    let moved: AppliedRowCol[] = [];
    try {
        const next = produce(ctx, (draft: Context) => {
            moved = applyBatch(draft, ops, moveView);
        });
        return { ctx: next, moved };
    } catch (e) {
        console.warn('[sheet] op batch failed to apply, skipping batch:', e);
        // The formula graph lives outside immer, so it may have followed part of the batch.
        ctx.formulaCache.forgetGraph();
        return null;
    }
}

// The batch inside a recipe: applied to the sheets the draft holds, then written into it. An op the shape check or the
// sheet refuses throws before anything is written. A row or column op lands for a read-only viewer too, or the grid
// and the metadata patches part ways.
export function applyBatch(ctx: Context, ops: Op[], moveView = true): AppliedRowCol[] {
    const { formulaCache } = ctx;
    const { sheets } = snapshotContext(ctx);
    const applied = applySheetsBatch(sheets, ops, formulaCache.graph, {});
    // A new graph means the sheets' names may read other sheets now, so the references resolved by name go too.
    if (applied.graph !== formulaCache.graph) formulaCache.forgetGraph();
    formulaCache.graph = applied.graph;
    writeSheets(ctx, ops, sheets, applied.sheets);
    const moved = applied.moved.map(({ op, sheets: before }) => ({
        move: 'index' in op ? insertMove(op) : deleteMove(op),
        sheets: before,
    }));
    if (!moveView) return moved;
    // Each op moves the view on the grid it left, which the next op starts from.
    for (const [i, { move }] of moved.entries()) {
        const after = moved[i + 1]?.sheets ?? applied.sheets;
        followView(ctx, move, after.find(({ id }) => id === move.id)?.data);
    }
    const [first] = ops;
    if (getSheetIndex(ctx, ctx.currentSheetId) == null) leaveCurrentSheet(ctx);
    else if (first?.path[0] === 'hide' && first.id === ctx.currentSheetId) leaveCurrentSheet(ctx, first.id);
    return moved;
}

// The sheet fields written entry by entry, with how many levels further down: a chart field by field and each of its
// maps entry by entry, and a validation rule rule by rule. Every other field is written whole.
const WRITTEN_BY_ENTRY = new Map([
    ['charts', 2],
    ['dataValidations', 0],
]);

// Writes what the batch changed into the context field by field, so the undo entry immer records puts back only that
// and leaves a peer's later changes alone. `before` is the plain view of the sheets the batch started from. A sheet
// the batch deleted leaves the list, even when the batch adds its id back, and one it added joins it last, as the
// engine orders them.
function writeSheets(ctx: Context, ops: readonly Op[], before: readonly Sheet[], after: readonly Sheet[]) {
    const deleted = new Set(ops.flatMap(({ op, id }) => (op === 'deleteSheet' && id ? [id] : [])));
    const was = new Map(before.filter(({ id }) => !deleted.has(id)).map((sheet) => [sheet.id, sheet]));
    const now = new Map(after.map((sheet) => [sheet.id, sheet]));
    for (let i = ctx.sheets.length - 1; i >= 0; i -= 1) {
        const target = ctx.sheets[i];
        const old = was.get(target.id);
        const next = now.get(target.id);
        if (old && next) writeChanges(target, old, next, (field) => WRITTEN_BY_ENTRY.get(field));
        else ctx.sheets.splice(i, 1);
    }
    for (const sheet of after) {
        if (was.has(sheet.id)) continue;
        const added = { ...sheet };
        initSheetData(added);
        ctx.sheets.push(added);
    }
}

// Writes into `target` each entry `next` holds other than `was`, the plain value of `target` before the batch, and
// deletes each entry `next` lacks. Comparing with the draft instead would write an unchanged value back, which immer 9
// records as a removal. `levels` says how many levels below an entry it is written entry by entry.
function writeChanges(
    target: Record<string, unknown>,
    was: Readonly<Record<string, unknown>>,
    next: Readonly<Record<string, unknown>>,
    levels: (key: string) => number | undefined,
) {
    for (const [key, value] of Object.entries(next)) {
        const old = was[key];
        if (old === value) continue;
        const below = levels(key);
        const held = target[key];
        if (below != null && isRecord(held) && isRecord(old) && isRecord(value)) {
            writeChanges(held, old, value, () => (below > 0 ? below - 1 : undefined));
        } else {
            target[key] = value;
        }
    }
    for (const key of Object.keys(was)) if (!Object.hasOwn(next, key)) delete target[key];
}
