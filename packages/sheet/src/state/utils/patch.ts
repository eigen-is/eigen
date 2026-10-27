// Converts between the editor's immer patches and the ops it sends to peers. patchToOp names each sheet by id and
// swaps the matrices a row or column op rewrote for the op itself, with the sheet's other fields whole. addSheetOps and
// deleteSheetOps build a sheet's add and delete batches; filterPatch keeps what belongs on the wire; opToPatch turns
// a peer's ops back into patches on this client's sheet indices.

import type { MergeCell } from '@workspace/lib/sheets';
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
    // The deleted sheet as it stood, with its cells stored. recordEntry adds it to the options it returns, for the
    // delete's batch and its undo, so a sheet delete's batch is built from the entry's options.
    deletedSheet?: Sheet;
};

// The `mc` stamps of every merge in the batch's whole config. The merge map alone doesn't draw a merge: each of its
// cells points at the corner, and the corner holds the merge's size.
function mergeStampOps(ops: Op[], id: string): Op[] {
    const config = ops.find((op) => op.op === 'replace' && op.path.length === 1 && op.path[0] === 'config');
    const merges: MergeCell[] = Object.values(config?.value?.merge ?? {});
    const stamps: Op[] = [];
    for (const merge of merges) {
        const { r, c, rs, cs } = merge;
        for (let row = r; row < r + rs; row += 1) {
            for (let column = c; column < c + cs; column += 1) {
                stamps.push({ op: 'replace', id, path: ['data', row, column, 'mc'], value: { r, c } });
            }
        }
        stamps.push({ op: 'replace', id, path: ['data', r, c, 'mc'], value: merge });
    }
    return stamps;
}

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

// `Sheet` fields that are per-client UI state and must never reach a peer. Both places that decide what goes on the
// wire, filterPatch and sheetMetadataOps, read this one list, so a new per-client field is a single decision. Typed
// against `keyof Sheet`, so a field that is renamed or deleted fails the build instead of silently no longer matching.
const PER_CLIENT_SHEET_FIELDS: ReadonlySet<unknown> = new Set<keyof Sheet>(['selections']);

// The row and column reducers write each sheet back field by field (writeBackSheets in rowcol.ts), so immer hands us a
// replace per changed field, `data` above all. Shipping those would copy the sheet's whole matrix into every collab
// update, so patchToOp drops them (writesOneFloatingObject) and ships the op itself, which every consumer, the editor
// and the server's replay, runs through the engine. The engine rebuilds `data` and the few config fields it owns, but
// the reducer also shifts the editor-only fields, such as the filter, links and validation, so the rest of the edited
// sheet's fields ship whole. sheetMetadataOps ships every field but `data`, the per-client ones, and `images` and
// `charts`, which ship per object: a whole map would overwrite a peer's insert, delete or move. A row op moves no
// image, and each chart it moves has immer's own patch of its spec, last writer wins, since a receiver's shift can
// differ from the author's write-back. The edit's own op leaves `calcChain` off too: it scales with formula count, and
// every receiver shifts its own.
const PER_OBJECT_SHEET_FIELDS: ReadonlySet<unknown> = new Set<keyof Sheet>(['images', 'charts']);

function sheetMetadataOps(fields: Record<string, unknown>, id: string): Op[] {
    const metaOps: Op[] = [];
    for (const [field, value] of Object.entries(fields)) {
        if (field === 'data' || PER_CLIENT_SHEET_FIELDS.has(field) || PER_OBJECT_SHEET_FIELDS.has(field)) continue;
        metaOps.push({ op: 'replace', id, path: [field], value });
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

// An undo or redo of a row or column op, as history builds it: the edited sheet's fields as the step leaves them, which
// ship whole, its recalc list included, and the cells the marker alone would leave different from what it restores.
export type RowColStep = { fields: Record<string, unknown>; repair: Op[] };

// The op a row or column edit ships in place of the matrices it rewrote.
export function rowColMarker({ insertRowColOp, deleteRowColOp }: PatchOptions): Op | undefined {
    if (insertRowColOp) return { op: 'insertRowCol', id: insertRowColOp.id, path: [], value: insertRowColOp };
    if (deleteRowColOp) return { op: 'deleteRowCol', id: deleteRowColOp.id, path: [], value: deleteRowColOp };
    return undefined;
}

// The batch an edit sends. A row or column op ships its marker instead of the matrices it rewrote; an undo or redo of
// one passes the step history built.
export function patchToOp(ctx: Context, patches: Patch[], options: PatchOptions = {}, step?: RowColStep): Op[] {
    let ops = patches.map((p) => {
        const op: Op = {
            op: p.op,
            value: p.value,
            path: p.path,
        };
        if (p.path[0] === 'sheets' && isNumber(p.path[1])) {
            op.id = ctx.sheets[p.path[1]].id;
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
    const marker = rowColMarker(options);
    if (marker?.id != null) {
        const { id } = marker;
        ops = [...ops.filter(writesOneFloatingObject), marker];
        if (step) ops.push(...sheetMetadataOps(step.fields, id), ...step.repair);
        else {
            const index = getSheetIndex(ctx, id);
            if (index != null) {
                const { calcChain: _calcChain, ...fields } = ctx.sheets[index];
                ops.push(...sheetMetadataOps(fields, id));
            }
            if (options.insertRowColOp) ops.push(...additionalCellOps(ctx, options.insertRowColOp));
        }
        // The engine fills inserted rows with nulls, and a ['data', r, c, 'mc'] patch can't be applied to a cell that
        // doesn't exist yet, so the cells go before the merge stamps.
        ops.push(...mergeStampOps(ops, id));
    } else if (options.addSheetOp) {
        // A copy moves the sheets after it, and the batch carries their orders.
        const [[added], rest] = partition(ops, (op) => op.op === 'add' && op.path.length === 0);
        ops = rest.filter((op) => op.path[0] !== 'order');
        if (added) ops.push(...addSheetOps(added.value, ctx.sheets));
    } else if (options.deletedSheet) {
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
