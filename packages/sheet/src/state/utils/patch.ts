// Converts between the editor's immer patches and the ops it sends to peers. patchToOp names each sheet by id. A sheet,
// row or column op ships its marker alone, since every receiver's engine makes the same writes. addSheetOps and
// deleteSheetOps build a sheet's add and delete batches, the add with the sheet's cells as stored. filterPatch keeps
// what belongs on the wire, and opToPatch turns a peer's ops back into patches on this client's sheet indices.

import { opToPatchOnSheets } from '@workspace/lib/sheets/yjs-ops';
import { cloneDeep, isNumber } from 'es-toolkit/compat';
import type { Patch } from 'immer';
import { dataToCelldata } from '../../engine/celldata';
import type { DeleteRowColOp, InsertRowColOp } from '../../engine/rowcol';
import type { Context } from '../context';
import type { Op, Sheet } from '../types';
import { sheetOrder } from '.';

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
export function patchToOp(ctx: Context, patches: Patch[], options: EntryOptions = {}): Op[] {
    if (options.renamedSheet) return renameSheetOps(options.renamedSheet.id, options.renamedSheet.to);
    if (options.deletedSheet) return deleteSheetOps(options.deletedSheet, ctx.sheets);
    if (options.addedSheet) return addSheetOps(options.addedSheet, ctx.sheets);
    const marker = rowColMarker(options);
    if (marker) return [marker];
    const ops = patches.map((p) => {
        const op: Op = {
            op: p.op,
            value: p.value,
            path: p.path,
        };
        if (p.path[0] === 'sheets' && isNumber(p.path[1])) {
            op.id = ctx.sheets[p.path[1]].id;
            op.path = p.path.slice(2);
        }
        return op;
    });
    // A linked cell written whole ships its link. The link sits under the cell's own key: the cell's `hl` keeps the
    // place the link was made at, which a row or column op does not move.
    for (const op of [...ops]) {
        const [field, r, c] = op.path;
        if (op.op !== 'replace' || op.value?.hl == null || op.path.length !== 3 || field !== 'data') continue;
        const key = `${r}_${c}`;
        const link = ctx.sheets.find((s) => s.id === op.id)?.hyperlink?.[key];
        if (link) ops.push({ id: op.id, op: 'replace', path: ['hyperlink', key], value: link });
    }
    return ops;
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

// A sheet add as a batch: the sheet as stored, then the order of each sheet at or past its place. A peer and a joiner's
// replay only add the sheet, so the orders come from the batch.
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
    return value;
}

export function opToPatch(ctx: Context, ops: Op[]): [Patch[], Op[]] {
    const [pure, specialOps] = opToPatchOnSheets(ctx.sheets, ops);
    return [pure.map((p) => ({ ...p, path: ['sheets', ...p.path] })), specialOps];
}

export function inverseRowColOptions({ insertRowColOp, deleteRowColOp }: RowColOptions): RowColOptions {
    if (insertRowColOp) {
        const { type, id, index, count, direction } = insertRowColOp;
        const start = direction === 'rightbottom' ? index + 1 : index;
        return { deleteRowColOp: { type, id, start, end: start + count - 1 } };
    }
    if (deleteRowColOp) {
        const { type, id, start, end } = deleteRowColOp;
        return { insertRowColOp: { type, id, index: start, count: end - start + 1, direction: 'lefttop' } };
    }
    return {};
}
