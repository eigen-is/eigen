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

// The row/col reducers replace the whole target sheet object, so immer hands us a
// single sheet-sized replace patch instead of granular ones. Shipping that patch
// copies the entire sheet (its `data` matrix above all) into every collab update —
// multi-MB on large sheets and the dominant cost of inserting a row — so patchToOp
// drops it. The paired insertRowCol/deleteRowCol special op lets every consumer
// (client applyOp and the BE replay both run the engine) re-derive the `data`
// shift instead of receiving it. The engine only rebuilds `data` and the few
// config fields it owns, so we still have to ship the rest of the sheet's
// metadata authoritatively: the reducer also shifts calcChain, filter, hyperlink,
// dataVerification, borderInfo/rowReadOnly (inside config) and more, and a
// delete-undo restores config that isn't derivable at all.
//
// Rather than enumerate the shifted fields here — a list that silently drifts from
// the reducer the moment a field is added — we emit every top-level field except
// the ones that must not be sent: `data` (re-derived by the engine), `selections`
// (per-client cursor, also dropped by filterPatch), and `calcChain` (a derived
// cache that scales with formula count — receivers shift their own copy in the
// reducer, the BE replay never reads it, and a fresh mount re-seeds it from
// `cell.f`). Everything else is small, and shipping an unchanged field as an
// authoritative replace is a no-op.
//
// The one case where `calcChain` IS shipped: undoing a delete. The delete dropped
// the removed rows' entries from every peer's calcChain, and the restoring insert
// can't re-derive them — without the authoritative copy, formulas in restored
// rows would stop recalculating on peers.
function sheetMetadataOps(ctx: Context, id: string, includeCalcChain: boolean): Op[] {
    const index = getSheetIndex(ctx, id);
    if (typeof index !== 'number') return [];
    const sheet = ctx.sheets[index];
    const metaOps: Op[] = [];
    for (const field of Object.keys(sheet) as (keyof Sheet)[]) {
        if (field === 'data' || PER_CLIENT_SHEET_FIELDS.has(field)) continue;
        if (field === 'calcChain' && !includeCalcChain) continue;
        metaOps.push({ op: 'replace', id, path: [field], value: sheet[field] });
    }
    return metaOps;
}

// Only `sheets[*]` belongs on the wire — the rest of the Context is per-client UI state
// (scroll position, hover, dialogs) that patchToOp could not give a sheet id anyway.
export function filterPatch(patches: Patch[]) {
    return patches.filter((p) => p.path[0] === 'sheets' && !PER_CLIENT_SHEET_FIELDS.has(p.path[2]));
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
        // Drop the whole-sheet replace ops (path []) — see sheetMetadataOps.
        ops = ops.filter((p) => p.path.length > 0 && p.path[0] !== 'data');
        ops.push({
            op: 'insertRowCol',
            id: options.insertRowColOp.id,
            path: [],
            value: options.insertRowColOp,
        });
        ops = [...ops, ...sheetMetadataOps(ctx, options.insertRowColOp.id, !!options.restoreDeletedCells)];

        // The cell-content ops below must precede the merge mc ops at the end of
        // this branch: the engine fills inserted rows with nulls, and a
        // ['data', r, c, 'mc'] patch can't be applied to a cell that doesn't
        // exist yet on the replay side.
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
            ops = [...ops, ...additionalCellOps(ctx, options.insertRowColOp)];
        }
        ops = [...ops, ...addtionalMergeOps(ops, options.insertRowColOp.id)];
    } else if (options?.deleteRowColOp) {
        // Drop the whole-sheet replace ops (path []) — see sheetMetadataOps.
        ops = ops.filter((p) => p.path.length > 0 && p.path[0] !== 'data');
        ops.push({
            op: 'deleteRowCol',
            id: options.deleteRowColOp.id,
            path: [],
            value: options.deleteRowColOp,
        });
        ops = [...ops, ...sheetMetadataOps(ctx, options.deleteRowColOp.id, false)];
        ops = [...ops, ...addtionalMergeOps(ops, options.deleteRowColOp.id)];
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
                for (const sheet of sheetsRight) {
                    ops.push({
                        id: sheet.id,
                        op: 'replace',
                        path: ['order'],
                        value: (sheet?.order as number) - 1,
                    });
                }
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
            for (const sheet of sheetsRight) {
                ops.push({
                    id: sheet.id,
                    op: 'replace',
                    path: ['order'],
                    value: sheet?.order as number,
                });
            }
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
                for (const sheet of sheetsRight) {
                    ops.push({
                        id: sheet.id,
                        op: 'replace',
                        path: ['order'],
                        value: sheet?.order as number,
                    });
                }
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
