// Converts between the editor's immer patches and the ops it sends to peers. patchToOp names each sheet by id and
// swaps the matrices a row or column op rewrote for the op itself, with the sheet's other fields whole; filterPatch
// keeps what belongs on the wire; opToPatch turns a peer's ops back into patches on this client's sheet indices.

import type { MergeCell, SheetConfig } from '@workspace/lib/sheets';
import { opToPatchOnSheets } from '@workspace/lib/sheets/yjs-ops';
import { isEqual, isNumber, partition } from 'es-toolkit/compat';
import type { Patch } from 'immer';
import type { Context } from '../context';
import { getFlowdata } from '../context';
import type { Op, Sheet } from '../types';
import { getSheetIndex } from '.';

export type PatchOptions = {
    insertRowColOp?: {
        type: 'row' | 'column';
        index: number;
        count: number;
        direction: 'lefttop' | 'rightbottom';
        id: string;
    };
    deleteRowColOp?: {
        type: 'row' | 'column';
        start: number;
        end: number;
        id: string;
    };
    addSheetOp?: boolean;
    deleteSheetOp?: {
        id: string;
    };
    // The deleted sheet as it stood, with its cells stored, which recordEntry keeps for the delete's undo.
    deletedSheet?: Sheet;
};

const addtionalMergeOps = (ops: Op[], id: string) => {
    let merge_new: Record<string, MergeCell> = {};
    ops.some((op) => {
        if (op.op !== 'replace' || op.path[0] !== 'config') return false;
        if (op.path.length === 1) {
            // Whole-config op from sheetMetadataOps.
            merge_new = (op.value as SheetConfig | undefined)?.merge ?? {};
            return true;
        }
        if (op.path[1] === 'merge') {
            merge_new = op.value as Record<string, MergeCell>;
            return true;
        }
        return false;
    });

    const new_ops: Op[] = [];
    for (const v of Object.values(merge_new)) {
        const { r, c, rs, cs } = v;
        const headerOp = {
            op: 'replace',
            path: ['data', r, c, 'mc'],
            id,
            value: v,
        } as Op;

        for (let i = r; i < r + rs; i += 1) {
            for (let j = c; j < c + cs; j += 1) {
                new_ops.push({
                    op: 'replace',
                    path: ['data', i, j, 'mc'],
                    id,
                    value: { r, c },
                } as Op);
            }
        }

        new_ops.push(headerOp);
    }
    return new_ops;
};

function additionalCellOps(
    ctx: Context,
    insertRowColOp: {
        id: string;
        index: number;
        direction: string;
        count: number;
        type: string;
    },
) {
    const { id, index, direction, count, type } = insertRowColOp;
    const d = getFlowdata(ctx, id);
    const startIndex = index + (direction === 'rightbottom' ? 1 : 0);
    if (d == null) {
        return [];
    }
    const cellOps: Op[] = [];
    if (type === 'row') {
        for (let i = 0; i < d[startIndex].length; i += 1) {
            const cell = d[startIndex][i];
            if (cell != null) {
                for (let j = 0; j < count; j += 1) {
                    cellOps.push({
                        op: 'replace',
                        id,
                        path: ['data', startIndex + j, i],
                        value: cell,
                    });
                }
            }
        }
    } else {
        for (let i = 0; i < d.length; i += 1) {
            const cell = d[i][startIndex];
            if (cell != null) {
                for (let j = 0; j < count; j += 1) {
                    cellOps.push({
                        op: 'replace',
                        id,
                        path: ['data', i, startIndex + j],
                        value: cell,
                    });
                }
            }
        }
    }
    return cellOps;
}

// `Sheet` fields that are per-client UI state and must never reach a peer. Both places that
// decide what goes on the wire — filterPatch and sheetMetadataOps — read this one list, so a
// new per-client field is a single decision rather than a leak through whichever of the two
// was not updated. Typed against `keyof Sheet` so a field that is renamed or deleted fails
// the build instead of silently no longer matching.
const PER_CLIENT_SHEET_FIELDS: ReadonlySet<unknown> = new Set<keyof Sheet>(['selections']);

// The row/col reducers write each sheet back field by field (writeBackSheets in rowcol.ts), so immer hands us a
// replace per changed field, `data` above all. Shipping those copies the sheet's whole matrix into every collab
// update — multi-MB on large sheets and the dominant cost of inserting a row — so patchToOp drops them
// (writesOneFloatingObject). The paired insertRowCol/deleteRowCol special op lets every consumer (client applyOp and
// the BE replay both run the engine) re-derive the `data` shift instead of receiving it. The engine only rebuilds
// `data` and the few config fields it owns, so we still have to ship the rest of the edited sheet's metadata
// authoritatively: the reducer also shifts calcChain, filter, hyperlink, dataVerification,
// borderInfo/rowReadOnly (inside config) and more, and a delete-undo restores config that isn't derivable at all.
//
// Rather than enumerate the shifted fields here — a list that silently drifts from
// the reducer the moment a field is added — we emit every top-level field except
// the ones that must not be sent: `data` (re-derived by the engine), `selections`
// (per-client cursor, also dropped by filterPatch), `calcChain` (a derived
// cache that scales with formula count — receivers shift their own copy in the
// reducer, the BE replay never reads it, and a fresh mount re-seeds it from
// `cell.f`), and `images` and `charts`, which ship per object: a whole map would
// overwrite a peer's insert, delete or move. A row op moves no image, and each chart
// it moves, on any sheet, has immer's own patch of its spec, last writer wins, since a
// receiver's shift can differ from the author's write-back: an undone delete never
// grows a ref back. Everything else is small, and shipping an unchanged field as an
// authoritative replace is a no-op.
//
// Undoing a delete also ships `calcChain`, which the restoring insert can't re-derive: the
// delete dropped the removed rows' entries from every peer's calcChain, and without the
// authoritative copy formulas in restored rows would stop recalculating on peers.
const PER_OBJECT_SHEET_FIELDS: ReadonlySet<unknown> = new Set<keyof Sheet>(['images', 'charts']);

function sheetMetadataOps(ctx: Context, id: string, restoringDelete: boolean): Op[] {
    const index = getSheetIndex(ctx, id);
    if (typeof index !== 'number') return [];
    const sheet = ctx.sheets[index];
    const metaOps: Op[] = [];
    for (const field of Object.keys(sheet) as (keyof Sheet)[]) {
        if (field === 'data' || PER_CLIENT_SHEET_FIELDS.has(field) || PER_OBJECT_SHEET_FIELDS.has(field)) continue;
        if (field === 'calcChain' && !restoringDelete) continue;
        metaOps.push({ op: 'replace', id, path: [field], value: sheet[field] });
    }
    return metaOps;
}

// Of immer's own writes a row or column batch keeps only those into one image or chart, an explicit set: every other
// sheet field ships whole through sheetMetadataOps or is re-derived by the engine, so a write deeper into one, which a
// peer's concurrent removal of that field would leave unresolved, can never cost a peer or the replay the batch.
function writesOneFloatingObject(op: Op): boolean {
    return op.path.length > 1 && PER_OBJECT_SHEET_FIELDS.has(op.path[0]);
}

// Only `sheets[*]` belongs on the wire — the rest of the Context is per-client UI state
// (scroll position, hover, dialogs) that patchToOp could not give a sheet id anyway.
export function filterPatch(patches: Patch[]) {
    return patches.filter((p) => p.path[0] === 'sheets' && !PER_CLIENT_SHEET_FIELDS.has(p.path[2]));
}

// The batch an edit sends. A row or column op ships its marker instead of the matrices it rewrote; an undo or redo of
// one passes `undo` and the repair cells history computes, which land before the merge stamps that need them.
export function patchToOp(
    ctx: Context,
    patches: Patch[],
    options?: PatchOptions,
    undo: boolean = false,
    repair: Op[] = [],
): Op[] {
    let ops = patches.map((p) => {
        const op: Op = {
            op: p.op,
            value: p.value,
            path: p.path,
        };
        if (p.path[0] === 'sheets' && isNumber(p.path[1])) {
            const id = ctx.sheets[p.path[1]].id!;
            op.id = id;
            op.path = p.path.slice(2);
            if (isEqual(op.path, ['calcChain', 'length'])) {
                op.path = ['calcChain'];
                op.value = ctx.sheets[p.path[1]].calcChain;
            }
        }
        return op;
    });
    // A linked cell written whole ships its link. The link sits under the cell's own key: the cell's `hl` keeps the
    // place the link was made at, which a row or column op does not move.
    for (const op of [...ops]) {
        const [field, r, c] = op.path;
        if (op.op !== 'replace' || op.value?.hl == null || op.path.length !== 3 || field !== 'data') continue;
        const key = `${r}_${c}`;
        const sheet = ctx.sheets.find((s) => s.id === op.id);
        ops.push({ id: op.id, op: 'replace', path: ['hyperlink', key], value: sheet?.hyperlink?.[key] });
    }
    if (options?.insertRowColOp) {
        ops = ops.filter(writesOneFloatingObject);
        ops.push({
            op: 'insertRowCol',
            id: options.insertRowColOp.id,
            path: [],
            value: options.insertRowColOp,
        });
        // An insert that undoes a delete brings back the deleted rows' cells through `repair`.
        ops = [...ops, ...sheetMetadataOps(ctx, options.insertRowColOp.id, undo)];
        if (!undo) ops = [...ops, ...additionalCellOps(ctx, options.insertRowColOp)];
        // The engine fills inserted rows with nulls, and a ['data', r, c, 'mc'] patch can't be applied to a cell that
        // doesn't exist yet, so the cells go before the merge stamps.
        ops = [...ops, ...repair, ...addtionalMergeOps(ops, options.insertRowColOp.id)];
    } else if (options?.deleteRowColOp) {
        ops = ops.filter(writesOneFloatingObject);
        ops.push({
            op: 'deleteRowCol',
            id: options.deleteRowColOp.id,
            path: [],
            value: options.deleteRowColOp,
        });
        ops = [...ops, ...sheetMetadataOps(ctx, options.deleteRowColOp.id, false), ...repair];
        ops = [...ops, ...addtionalMergeOps(ops, options.deleteRowColOp.id)];
    } else if (options?.addSheetOp) {
        // A copy moves the sheets after it, and the batch carries their orders.
        const [[added], rest] = partition(ops, (op) => op.op === 'add' && op.path.length === 0);
        ops = rest.filter((op) => op.path[0] !== 'order');
        if (added) ops.push(...addSheetOps(added.value, ctx.sheets));
    } else if (options?.deletedSheet) {
        ops = deleteSheetOps(options.deletedSheet, ctx.sheets);
    }
    return ops;
}

// A sheet add as a batch: the sheet, then the order of each sheet at or past its place, as `sheets` hold them once it
// was added. A peer's addSheet moves those orders itself, but a joiner's replay only appends the sheet. The edit, its
// undo and its redo all send this batch.
export function addSheetOps(added: Sheet, sheets: Sheet[]): Op[] {
    return [{ op: 'addSheet', id: added.id, path: [], value: added }, ...orderOps(added, sheets)];
}

// A sheet delete as a batch, for the same reason with the orders `sheets` hold once it was deleted.
export function deleteSheetOps(deleted: Sheet, sheets: Sheet[]): Op[] {
    return [{ op: 'deleteSheet', id: deleted.id, path: [], value: { id: deleted.id } }, ...orderOps(deleted, sheets)];
}

function orderOps(changed: Sheet, sheets: Sheet[]): Op[] {
    const from = changed.order ?? 0;
    return sheets
        .filter((sheet) => sheet.id !== changed.id && (sheet.order ?? 0) >= from)
        .map((sheet): Op => ({ op: 'replace', id: sheet.id, path: ['order'], value: sheet.order }));
}

export function opToPatch(ctx: Context, ops: Op[]): [Patch[], Op[]] {
    const [pure, specialOps] = opToPatchOnSheets(ctx.sheets, ops);
    return [pure.map((p) => ({ ...p, path: ['sheets', ...p.path] })), specialOps];
}

export function inverseRowColOptions(options?: PatchOptions): PatchOptions | undefined {
    if (!options) return options;
    if (options.insertRowColOp) {
        let { index } = options.insertRowColOp;
        if (options.insertRowColOp.direction === 'rightbottom') {
            index += 1;
        }
        return {
            deleteRowColOp: {
                type: options.insertRowColOp.type,
                id: options.insertRowColOp.id,
                start: index,
                end: index + options.insertRowColOp.count - 1,
            },
        };
    }
    if (options.deleteRowColOp) {
        return {
            insertRowColOp: {
                type: options.deleteRowColOp.type,
                id: options.deleteRowColOp.id,
                index: options.deleteRowColOp.start,
                count: options.deleteRowColOp.end - options.deleteRowColOp.start + 1,
                direction: 'lefttop',
            },
        };
    }
    return options;
}
