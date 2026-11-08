// Converts between the editor's immer patches and the ops it sends to peers. patchToOp names each sheet by id and
// swaps the matrices a row or column op or a rename rewrote for the op itself, with the sheet fields no receiver
// derives. addSheetOps and deleteSheetOps build a sheet's add and delete batches, the add with its cells as stored.
// filterPatch keeps what belongs on the wire, and opToPatch turns a peer's ops back into patches on this client's sheet
// indices.

import type { MergeCell } from '@workspace/lib/sheets';
import { opToPatchOnSheets } from '@workspace/lib/sheets/yjs-ops';
import { cloneDeep, isEqual, isNumber, partition } from 'es-toolkit/compat';
import type { Patch } from 'immer';
import { dataToCelldata } from '../../engine/celldata';
import type { DeleteRowColOp, InsertRowColOp } from '../../engine/rowcol';
import type { RenameSheetOp } from '../../engine/sheet-name';
import type { Context } from '../context';
import { getFlowdata } from '../context';
import type { Op, Sheet } from '../types';
import { getSheetIndex, sheetOrder } from '.';

export type PatchOptions = {
    insertRowColOp?: InsertRowColOp;
    deleteRowColOp?: DeleteRowColOp;
    addSheetOp?: boolean;
    deleteSheetOp?: {
        id: string;
    };
    // The deleted sheet as it stood, with its cells stored. recordEntry adds it to the options it returns, for the
    // delete's batch and its undo, so a sheet delete's batch is built from the entry's options.
    deletedSheet?: Sheet;
    // `from` is the name an undo puts back.
    renameSheetOp?: RenameSheetOp & { from: string };
};

// The `mc` stamps of every merge in a row or column step's whole config. The merge map alone doesn't draw a merge:
// each of its cells points at the corner, and the corner holds the merge's size. The op itself ships no config, since
// every receiver's engine moves the merges and stamps them again.
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

function additionalCellOps(ctx: Context, insertRowColOp: InsertRowColOp) {
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

// A row or column op's reducer writes each sheet back field by field, so immer hands patchToOp a replace per changed
// field, `data` above all. Shipping those would copy the sheet's whole matrix into every collab update. So the batch
// ships the op itself, which every receiver runs through the engine, and the edited sheet's other fields whole, since
// the reducer also shifts fields the engine leaves alone, such as the links.
//
// The maps below ship per object, never whole: a whole map would overwrite a peer's insert, delete or move of another
// object, or a rule a peer added. Of immer's own writes the batch keeps only those into one object, so a write deeper
// into one, which a peer's removal of that object would leave unresolved, never costs a receiver the batch.
const PER_OBJECT_SHEET_FIELDS: ReadonlySet<unknown> = new Set<keyof Sheet>(['images', 'charts', 'dataValidations']);

// The fields the engine derives on every receiver from the op itself. The size ships least of all: two row ops sent at
// once would each write their author's count, one op short.
const ENGINE_SHEET_FIELDS: ReadonlySet<unknown> = new Set<keyof Sheet>(['data', 'row', 'column']);

// The fields every receiver's engine moves with the op, as it moves the cells, such as the chart refs on every sheet.
// The op itself leaves them off: the author's write would overwrite the receiver's own shift of a peer's edit sent at
// the same time. An undo or redo ships them, since the marker alone would not bring back what the entry restores.
const SHIFTED_SHEET_FIELDS: ReadonlySet<unknown> = new Set<keyof Sheet>([
    'charts',
    'config',
    'conditionalFormatRules',
    'dataValidations',
    'frozen',
    'filterRange',
    'filter',
]);

function sheetMetadataOps(fields: Record<string, unknown>, id: string): Op[] {
    const metaOps: Op[] = [];
    for (const [field, value] of Object.entries(fields)) {
        if (
            ENGINE_SHEET_FIELDS.has(field) ||
            PER_CLIENT_SHEET_FIELDS.has(field) ||
            PER_OBJECT_SHEET_FIELDS.has(field)
        ) {
            continue;
        }
        metaOps.push({ op: 'replace', id, path: [field], value });
    }
    return metaOps;
}

function writesOneObject(op: Op): boolean {
    return op.path.length > 1 && PER_OBJECT_SHEET_FIELDS.has(op.path[0]);
}

// Only `sheets[*]` belongs on the wire. The rest of the Context is per-client UI state, such as the scroll position,
// the hover and the dialogs, which patchToOp could not give a sheet id anyway.
export function filterPatch(patches: readonly Patch[]) {
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

// A rename as its one op. Every receiver's engine rewrites the text naming the sheet on the sheets it holds, so a
// workbook's formulas stay off the wire and a peer's row op sent at the same time can't misplace a write.
export function renameSheetOps(id: string, name: string): Op[] {
    return [{ op: 'renameSheet', id, path: [], value: { name } }];
}

// The batch an edit sends. A row or column op ships its marker instead of the matrices it rewrote; an undo or redo of
// one passes the step history built.
export function patchToOp(ctx: Context, patches: Patch[], options: PatchOptions = {}, step?: RowColStep): Op[] {
    if (options.renameSheetOp) return renameSheetOps(options.renameSheetOp.id, options.renameSheetOp.name);
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
        if (step) {
            ops = [...ops.filter(writesOneObject), marker, ...sheetMetadataOps(step.fields, id), ...step.repair];
            // The engine fills inserted rows with nulls, and a stamp can't land on a cell that doesn't exist yet, so
            // the repaired cells go before the stamps.
            ops.push(...mergeStampOps(ops, id));
        } else {
            ops = [...ops.filter((op) => writesOneObject(op) && !SHIFTED_SHEET_FIELDS.has(op.path[0])), marker];
            const index = getSheetIndex(ctx, id);
            if (index != null) {
                // The recalc list scales with the formula count, and every receiver shifts its own.
                const fields = Object.entries(ctx.sheets[index]).filter(
                    ([field]) => field !== 'calcChain' && !SHIFTED_SHEET_FIELDS.has(field),
                );
                ops.push(...sheetMetadataOps(Object.fromEntries(fields), id));
            }
            if (options.insertRowColOp) ops.push(...additionalCellOps(ctx, options.insertRowColOp));
        }
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

// A sheet add as a batch: the sheet as stored, then the order of each sheet at or past its place, as `sheets` hold
// them once it was added. A peer and a joiner's replay only add the sheet, and the orders come from the batch. The
// edit, its undo and its redo all send this batch.
export function addSheetOps(added: Sheet, sheets: readonly Sheet[]): Op[] {
    return [{ op: 'addSheet', id: added.id, path: [], value: storedCopy(added) }, ...orderOps(added, sheets)];
}

// A sheet delete as a batch, for the same reason with the orders `sheets` hold once it was deleted.
export function deleteSheetOps(deleted: Sheet, sheets: readonly Sheet[]): Op[] {
    return [{ op: 'deleteSheet', id: deleted.id, path: [], value: { id: deleted.id } }, ...orderOps(deleted, sheets)];
}

function orderOps(changed: Sheet, sheets: readonly Sheet[]): Op[] {
    const from = sheetOrder(changed);
    return sheets
        .filter((sheet) => sheet.id !== changed.id && sheetOrder(sheet) >= from)
        .map((sheet): Op => ({ op: 'replace', id: sheet.id, path: ['order'], value: sheet.order }));
}

// A sheet as an add carries it and a delete's undo keeps it: its cells as the stored list, since the matrix holds a
// null for every empty cell and the op log keeps every add. No tab has it open yet.
export function storedCopy(sheet: Sheet): Sheet {
    const { data, ...value } = cloneDeep(sheet);
    if (data) value.celldata = dataToCelldata(data);
    value.status = 0;
    return value;
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
