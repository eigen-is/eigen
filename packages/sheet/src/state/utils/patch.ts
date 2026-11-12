// Turns the editor's immer patches into the ops it sends to peers. patchToOp names each sheet by id. A sheet, row or
// column op ships its marker alone, since every receiver's engine makes the same writes. addSheetOps and
// deleteSheetOps build a sheet's add and delete batches, the add with the sheet's cells as stored. filterPatch keeps
// what belongs on the wire.

import { cloneDeep, isNumber } from 'es-toolkit/compat';
import type { Patch } from 'immer';
import { dataToCelldata } from '../../engine/celldata';
import type { DeleteRowColOp, InsertRowColOp } from '../../engine/rowcol';
import { editOf } from '../../engine/rowcol';
import type { Context } from '../context';
import type { Op, Sheet } from '../types';

type RowColOptions = {
    insertRowColOp?: InsertRowColOp;
    deleteRowColOp?: DeleteRowColOp;
};

// What an edit says about itself when it writes.
export type PatchOptions = RowColOptions & {
    addSheetOp?: boolean;
    deleteSheetOp?: { id: string };
    renameSheetOp?: { id: string };
};

// What recordEntry keeps of those options, which its batch and its undo and redo are built from: a sheet added or
// deleted as it stood, with its cells stored, and a renamed sheet's two names.
export type EntryOptions = RowColOptions & {
    addedSheet?: Sheet;
    deletedSheet?: Sheet;
    renamedSheet?: { id: string; from: string; to: string };
};

// Only `sheets[*]` belongs on the wire. The rest of the Context is per-client UI state, such as the scroll position,
// the hover and the dialogs, which patchToOp could not give a sheet id anyway.
export function filterPatch(patches: readonly Patch[]) {
    return patches.filter((p) => p.path[0] === 'sheets');
}

// A rename as its one op. Every receiver's engine rewrites the text naming the sheet on the sheets it holds, so a
// workbook's formulas stay off the wire and a peer's row op sent at the same time can't misplace a write.
export function renameSheetOps(id: string, name: string): Op[] {
    return [{ op: 'renameSheet', id, path: [], value: { name } }];
}

// The batch an edit sends. A sheet or row op ships its marker instead of the sheets it rewrote, because every reader
// recomputes, and a value it shipped could land on a cell a peer has since moved or written.
export function patchToOp(base: Context, ctx: Context, patches: readonly Patch[], options: EntryOptions = {}): Op[] {
    if (options.renamedSheet) return renameSheetOps(options.renamedSheet.id, options.renamedSheet.to);
    if (options.deletedSheet) return deleteSheetOps(options.deletedSheet, base.sheets, ctx.sheets);
    if (options.addedSheet) return addSheetOps(options.addedSheet, base.sheets, ctx.sheets);
    const marker = rowColMarker(options);
    if (marker) return [marker];
    return patches.map((p) => {
        const op: Op = { op: p.op, value: p.value, path: p.path };
        if (p.path[0] === 'sheets' && isNumber(p.path[1])) {
            op.id = ctx.sheets[p.path[1]].id;
            op.path = p.path.slice(2);
        }
        return op;
    });
}

// The op a row or column edit ships in place of the sheets it rewrote.
export function rowColMarker({ insertRowColOp, deleteRowColOp }: RowColOptions): Op | undefined {
    if (insertRowColOp) return insertMarker(insertRowColOp);
    return deleteRowColOp && deleteMarker(deleteRowColOp);
}

export function insertMarker(op: InsertRowColOp): Op {
    return { op: 'insertRowCol', id: op.id, path: [], value: op };
}

export function deleteMarker(op: DeleteRowColOp): Op {
    return { op: 'deleteRowCol', id: op.id, path: [], value: op };
}

// A sheet add as a batch: the sheet as stored, then the order of each other sheet the add changed from `before` to
// `after`. A peer and a joiner's replay only add the sheet, so the orders come from the batch.
export function addSheetOps(added: Sheet, before: readonly Sheet[], after: readonly Sheet[]): Op[] {
    return [{ op: 'addSheet', id: added.id, path: [], value: storedCopy(added) }, ...orderOps(before, after)];
}

// A sheet delete as a batch, for the same reason with the orders the delete changed.
export function deleteSheetOps(deleted: Sheet, before: readonly Sheet[], after: readonly Sheet[]): Op[] {
    return [{ op: 'deleteSheet', id: deleted.id, path: [], value: { id: deleted.id } }, ...orderOps(before, after)];
}

// Every order that changed and no other: an unchanged order it sent would undo a peer's move sent at the same time.
function orderOps(before: readonly Sheet[], after: readonly Sheet[]): Op[] {
    const was = new Map(before.map((sheet) => [sheet.id, sheet.order]));
    return after
        .filter((sheet) => was.has(sheet.id) && was.get(sheet.id) !== sheet.order)
        .map((sheet): Op => ({ op: 'replace', id: sheet.id, path: ['order'], value: sheet.order }));
}

// A sheet as an add carries it and a delete's undo keeps it: its cells as the stored list, since the matrix holds a
// null for every empty cell and the op log keeps every add. No tab has it open yet.
export function storedCopy(sheet: Sheet): Sheet {
    const { data, ...value } = cloneDeep(sheet);
    if (data) value.celldata = dataToCelldata(data);
    return value;
}

export function inverseRowColOptions({ insertRowColOp, deleteRowColOp }: RowColOptions): RowColOptions {
    if (insertRowColOp) {
        const { type, id, count } = insertRowColOp;
        const start = editOf(insertRowColOp).index;
        return { deleteRowColOp: { type, id, start, end: start + count - 1 } };
    }
    if (deleteRowColOp) {
        const { type, id, start, end } = deleteRowColOp;
        return { insertRowColOp: { type, id, index: start, count: end - start + 1, direction: 'lefttop' } };
    }
    return {};
}
