import type { MergeCell, SheetConfig } from '@workspace/lib/sheets';
import { opToPatchOnSheets } from '@workspace/lib/sheets/yjs-ops';
import { every, isEqual, isNil, isNumber, partition } from 'es-toolkit/compat';
import type { Patch } from 'immer';
import { type Context, getFlowdata } from '../context';
import type { Op, Sheet } from '../types';
import { getSheetIndex } from '.';

export type ChangedSheet = {
    index?: number;
    id?: string;
    value?: Sheet;
    order?: number;
};

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
    restoreDeletedCells?: boolean;
    addSheetOp?: boolean;
    deleteSheetOp?: {
        id: string;
    };
    addSheet?: ChangedSheet;
    deletedSheet?: ChangedSheet;
    id?: string;
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
    Object.entries(merge_new).forEach(([, v]) => {
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
    });
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

// The row/col reducers replace the whole target sheet object, so immer hands us a
// single sheet-sized replace patch instead of granular ones. Shipping that patch
// copies the entire sheet into every collab update — multi-MB on large sheets and
// the dominant cost of inserting a row — so patchToOp drops it. The paired
// insertRowCol/deleteRowCol special op re-derives the structural data shift on
// every consumer (client applyOp and the BE replay both run the engine); these
// compact ops carry the sheet-level fields that pass doesn't reproduce: state-only
// shifts (calcChain, filter, borderInfo/rowReadOnly inside config, alternate
// format rules, row/column counts) and state that isn't derivable at all, like
// the config of rows a delete-undo restores.
function sheetMetadataOps(ctx: Context, id: string): Op[] {
    const index = getSheetIndex(ctx, id);
    if (typeof index !== 'number') return [];
    const sheet = ctx.sheets[index];
    const fields = ['config', 'calcChain', 'alternateFormatRules', 'filter', 'filterRange', 'row', 'column'] as const;
    const metaOps: Op[] = [];
    for (const field of fields) {
        if (sheet[field] === undefined) continue;
        metaOps.push({ op: 'replace', id, path: [field], value: sheet[field] });
    }
    return metaOps;
}

// TODO(sizing-sync): row/column sizing writes to `config` (columnlen/rowlen) on both the sheet
// and the live top-level `ctx.config`. This filter keeps only `sheets[*]` patches, so the change
// doesn't round-trip through undo or Yjs sync — resizing (drag handles + the resize dialog) is
// currently local-only and non-undoable. A proper fix routes config changes through the
// patch → op → undo pipeline.
export function filterPatch(patches: Patch[]) {
    return patches.filter((p) => p.path[0] === 'sheets' && p.path[2] !== 'selections');
}

export function extractFormulaCellOps(ops: Op[]) {
    // ops are ensured to be cell data ops
    const formulaOps: Op[] = [];
    ops.forEach((op) => {
        if (op.op === 'remove') return;
        if (op.path.length === 2 && Array.isArray(op.value)) {
            // entire row op
            for (let i = 0; i < op.value.length; i += 1) {
                if (op.value[i]?.f) {
                    formulaOps.push({
                        op: 'replace',
                        id: op.id,
                        path: [...op.path, i],
                        value: op.value[i],
                    });
                }
            }
        } else if (op.path.length === 3 && op.value?.f) {
            formulaOps.push(op);
        } else if (op.path.length === 4 && op.path[3] === 'f') {
            formulaOps.push(op);
        }
    });
    return formulaOps;
}

export function patchToOp(ctx: Context, patches: Patch[], options?: PatchOptions, undo: boolean = false): Op[] {
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
    every(ops, (p) => {
        if (p.op === 'replace' && !isNil(p.value?.hl) && p.path.length === 3 && p.path![0] === 'data') {
            const index = getSheetIndex(ctx, p.id!) as number;
            ops.push({
                id: p!.id!,
                op: 'replace',
                path: ['hyperlink', `${p.path[1]}_${p.path![2]}`],
                value: ctx.sheets[index].hyperlink![`${p.value!.hl!.r!}_${p.value!.hl.c!}`],
            });
        }
    });
    if (options?.insertRowColOp) {
        const [nonDataOps, dataOps] = partition(ops, (p) => p.path[0] !== 'data');
        // find out formula cells as their formula range may be changed
        const formulaOps = extractFormulaCellOps(dataOps);
        // Drop the whole-sheet replace ops (path []) — see sheetMetadataOps.
        ops = nonDataOps.filter((p) => p.path.length > 0);
        ops.push({
            op: 'insertRowCol',
            id: options.insertRowColOp.id,
            path: [],
            value: options.insertRowColOp,
        });
        ops = [...ops, ...sheetMetadataOps(ctx, options.insertRowColOp.id), ...formulaOps];

        const mergeOps = addtionalMergeOps(ops, options.insertRowColOp.id);
        ops = [...ops, ...mergeOps];

        if (options?.restoreDeletedCells) {
            // undoing deleted row/col, find out cells to restore
            const restoreCellsOps: Op[] = [];
            const flowdata = getFlowdata(ctx);
            if (flowdata) {
                const rowlen = flowdata.length;
                const collen = flowdata[0].length;
                for (let i = 0; i < rowlen; i += 1) {
                    for (let j = 0; j < collen; j += 1) {
                        const cell = flowdata[i][j];
                        if (!cell) continue;
                        if (
                            (options.insertRowColOp.type === 'row' &&
                                i >= options.insertRowColOp.index &&
                                i < options.insertRowColOp.index + options.insertRowColOp.count) ||
                            (options.insertRowColOp.type === 'column' &&
                                j >= options.insertRowColOp.index &&
                                j < options.insertRowColOp.index + options.insertRowColOp.count)
                        ) {
                            restoreCellsOps.push({
                                op: 'replace',
                                path: ['data', i, j],
                                id: ctx.currentSheetId,
                                value: cell,
                            });
                        }
                    }
                }
            }
            ops = [...ops, ...restoreCellsOps];
        } else {
            const cellOps = additionalCellOps(ctx, options.insertRowColOp);
            ops = [...ops, ...cellOps];
        }
    } else if (options?.deleteRowColOp) {
        const [nonDataOps, dataOps] = partition(ops, (p) => p.path[0] !== 'data');
        // find out formula cells as their formula range may be changed
        const formulaOps = extractFormulaCellOps(dataOps);
        // Drop the whole-sheet replace ops (path []) — see sheetMetadataOps.
        ops = nonDataOps.filter((p) => p.path.length > 0);
        ops.push({
            op: 'deleteRowCol',
            id: options.deleteRowColOp.id,
            path: [],
            value: options.deleteRowColOp,
        });
        ops = [...ops, ...sheetMetadataOps(ctx, options.deleteRowColOp.id), ...formulaOps];

        const mergeOps = addtionalMergeOps(ops, options.deleteRowColOp.id);
        ops = [...ops, ...mergeOps];
    } else if (options?.addSheetOp) {
        const [addSheetOps, otherOps] = partition(ops, (op) => op.path.length === 0 && op.op === 'add');
        options.id = options.addSheet!.id as string;
        if (undo) {
            // undo add sheet
            const index = getSheetIndex(ctx, options.addSheet!.id as string) as number;
            const order = options.addSheet?.value?.order;
            ops = otherOps;
            ops.push({
                op: 'deleteSheet',
                id: options.addSheet?.id,
                path: [],
                value: options.addSheet,
            });
            if (index !== ctx.sheets.length) {
                const sheetsRight = ctx.sheets.filter((sheet) => (sheet?.order as number) >= (order as number));
                sheetsRight.forEach((sheet) => {
                    ops.push({
                        id: sheet.id,
                        op: 'replace',
                        path: ['order'],
                        value: (sheet?.order as number) - 1,
                    });
                });
            }
        } else {
            // normal add sheet
            ops = otherOps;
            ops.push({
                op: 'addSheet',
                id: options.addSheet?.id,
                path: [],
                value: addSheetOps[0]?.value,
            });
        }
    } else if (options?.deleteSheetOp) {
        options.id = options.deleteSheetOp!.id as string;
        if (undo) {
            // undo delete sheet
            ops = [
                {
                    op: 'addSheet',
                    id: options.deleteSheetOp.id,
                    path: [],
                    value: options.deletedSheet?.value,
                },
                {
                    id: options.deleteSheetOp.id,
                    op: 'replace',
                    path: ['name'],
                    value: options.deletedSheet?.value?.name,
                },
            ];
            const order = options.deletedSheet?.value?.order as number;
            const sheetsRight = ctx.sheets.filter(
                (sheet) => (sheet?.order as number) >= (order as number) && sheet.id !== options.deleteSheetOp?.id,
            );
            sheetsRight.forEach((sheet) => {
                ops.push({
                    id: sheet.id,
                    op: 'replace',
                    path: ['order'],
                    value: sheet?.order as number,
                });
            });
        } else {
            // normal delete sheet
            ops = [
                {
                    op: 'deleteSheet',
                    id: options.deleteSheetOp.id,
                    path: [],
                    value: options.deletedSheet,
                },
            ];
            const order = options.deletedSheet?.value?.order as number;
            if (options.deletedSheet?.order !== ctx.sheets.length) {
                const sheetsRight = ctx.sheets.filter((sheet) => (sheet?.order as number) >= (order as number));
                sheetsRight.forEach((sheet) => {
                    ops.push({
                        id: sheet.id,
                        op: 'replace',
                        path: ['order'],
                        value: sheet?.order as number,
                    });
                });
            }
        }
    }
    return ops;
}

export function opToPatch(ctx: Context, ops: Op[]): [Patch[], Op[]] {
    const [pure, specialOps] = opToPatchOnSheets(ctx.sheets, ops);
    const patches: Patch[] = pure.map((p) => ({ ...p, path: ['sheets', ...p.path] }));
    for (const op of ops) {
        if (op.id && op.path[0] === 'images' && op.id === ctx.currentSheetId) {
            patches.push({
                op: op.op as 'add' | 'remove' | 'replace',
                value: op.value,
                path: ['insertedImgs'],
            });
        }
    }
    return [patches, specialOps];
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
