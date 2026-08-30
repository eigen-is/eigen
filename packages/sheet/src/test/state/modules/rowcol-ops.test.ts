// Row/col inserts and deletes must NOT ship the target sheet wholesale over
// collab: patchToOp drops the sheet-sized immer patch and instead emits the
// insertRowCol/deleteRowCol special op (every consumer re-runs the engine)
// plus compact metadata ops for the fields the engine pass doesn't reproduce.
// These tests pin the op shape and prove FE state and BE replay converge,
// including the undo-of-delete path that restores non-derivable config.

import { describe, expect, test } from 'bun:test';
import { applyPatches, enablePatches, produceWithPatches } from 'immer';
import { replaySheetsOps } from '../../../engine';
import { normalizeSheetConfig } from '../../../engine/replay-ops';
import type { Context } from '../../../state/context';
import { deleteRowCol, insertRowCol } from '../../../state/modules/rowcol';
import type { Op, Sheet } from '../../../state/types';
import { filterPatch, inverseRowColOptions, patchToOp } from '../../../state/utils/patch';
import { contextFactory } from '../factories/context';

enablePatches();

const INSERT_OP = { type: 'row', index: 1, count: 1, direction: 'lefttop', id: 'id_1' } as const;
const DELETE_OP = { type: 'row', start: 1, end: 2, id: 'id_1' } as const;
const SIDE = { style: 1, color: '#000' };

function richContext(): Context {
    const cell = (v: number) => ({ v, m: String(v) });
    const ctx = contextFactory({
        sheets: [
            {
                name: 'sheet',
                id: 'id_1',
                data: [
                    [cell(1), cell(2), null, null],
                    [cell(3), null, null, null],
                    [cell(4), { v: 5, f: '=A1+A2' }, null, null],
                    [null, null, { v: 6, mc: { r: 3, c: 2, rs: 1, cs: 2 } }, { mc: { r: 3, c: 2 } }],
                ],
                config: {
                    rowlen: { 2: 60 },
                    rowhidden: { 3: 0 },
                    merge: { '3_2': { r: 3, c: 2, rs: 1, cs: 2 } },
                    borderInfo: { '1_0': { t: SIDE }, '2_1': { b: SIDE }, '3_3': { l: SIDE } },
                },
                calcChain: [{ r: 2, c: 1, id: 'id_1' }],
                // hyperlink + dataVerification are shifted only in the state layer,
                // never re-derived by the engine — they prove the metadata ops carry
                // every field the engine doesn't reproduce.
                hyperlink: { '2_0': { linkType: 'webpage', linkAddress: 'https://eigen.is' } },
                dataVerification: { '2_1': { type: 'dropdown', type2: 'true', value1: 'a,b', value2: '' } },
                order: 0,
                row: 4,
                column: 4,
            },
            {
                name: 'sheet',
                id: 'id_2',
                data: [
                    [null, { v: 7, f: '=A3' }, null, null],
                    [null, null, null, null],
                    [null, null, null, null],
                    [null, null, null, null],
                ],
                order: 1,
            },
        ],
    }) as Context;
    // The editor materializes every config collection when a sheet enters the context
    // (initSheetData → normalizeSheetConfig), and the replay base does the same. A fixture
    // that skips it would compare a normalized replay against an un-normalized editor and
    // report a divergence that cannot happen in the app.
    for (const sheet of ctx.sheets) normalizeSheetConfig(sheet);
    return ctx;
}

function emittedOps(recipe: (ctx: Context) => void, options: Parameters<typeof patchToOp>[2]): [Op[], Context] {
    const base = richContext();
    const [next, patches] = produceWithPatches(base, recipe);
    return [patchToOp(next, filterPatch(patches), options), next];
}

describe('insert/delete ops stay sheet-sized-payload free', () => {
    test('insertRowCol ships no whole-sheet replace op', () => {
        const [ops] = emittedOps((ctx) => insertRowCol(ctx, INSERT_OP), { insertRowColOp: INSERT_OP });
        expect(ops.filter((op) => op.op === 'replace' && op.path.length === 0)).toEqual([]);
        expect(ops.filter((op) => op.op === 'insertRowCol')).toHaveLength(1);
    });

    test('deleteRowCol ships no whole-sheet replace op', () => {
        const [ops] = emittedOps((ctx) => deleteRowCol(ctx, DELETE_OP), { deleteRowColOp: DELETE_OP });
        expect(ops.filter((op) => op.op === 'replace' && op.path.length === 0)).toEqual([]);
        expect(ops.filter((op) => op.op === 'deleteRowCol')).toHaveLength(1);
    });

    test('insertRowCol carries authoritative metadata ops for the target sheet', () => {
        const [ops, next] = emittedOps((ctx) => insertRowCol(ctx, INSERT_OP), { insertRowColOp: INSERT_OP });
        const metaPaths = ops.filter((op) => op.id === 'id_1' && op.path.length === 1).map((op) => op.path[0]);
        expect(metaPaths).toEqual(expect.arrayContaining(['config', 'hyperlink', 'dataVerification', 'row', 'column']));
        const configOp = ops.find((op) => op.path[0] === 'config');
        expect(configOp?.value).toEqual(next.sheets[0].config);
        // calcChain scales with formula count and every consumer re-derives it,
        // so a plain insert must not ship it.
        expect(metaPaths).not.toContain('calcChain');
    });
});

describe('BE replay converges with FE state from the slim ops alone', () => {
    // calcChain is deliberately absent: it isn't shipped on plain inserts/deletes
    // (the BE replay never reads it, clients re-derive it) — see sheetMetadataOps.
    function expectConverged(replayed: Sheet[], next: Context) {
        for (const [i, sheet] of replayed.entries()) {
            expect(sheet.data).toEqual(next.sheets[i].data);
            expect(sheet.config ?? {}).toEqual(next.sheets[i].config ?? {});
            expect(sheet.hyperlink ?? {}).toEqual(next.sheets[i].hyperlink ?? {});
            expect(sheet.dataVerification ?? {}).toEqual(next.sheets[i].dataVerification ?? {});
        }
    }

    test('insert row', () => {
        const base = richContext();
        const baseSheets = structuredClone(base.sheets);
        const [next, patches] = produceWithPatches(base, (ctx: Context) => insertRowCol(ctx, INSERT_OP));
        const ops = patchToOp(next, filterPatch(patches), { insertRowColOp: INSERT_OP });
        expectConverged(replaySheetsOps(baseSheets, [ops]), next);
    });

    test('insert column shifts formulas and merge on both sides', () => {
        const op = { type: 'column', index: 0, count: 2, direction: 'lefttop', id: 'id_1' } as const;
        const base = richContext();
        const baseSheets = structuredClone(base.sheets);
        const [next, patches] = produceWithPatches(base, (ctx: Context) => insertRowCol(ctx, op));
        const ops = patchToOp(next, filterPatch(patches), { insertRowColOp: op });
        expect(next.sheets[0].data?.[2]?.[3]?.f).toBe('=C1+C2');
        expectConverged(replaySheetsOps(baseSheets, [ops]), next);
    });

    test('delete rows', () => {
        const base = richContext();
        const baseSheets = structuredClone(base.sheets);
        const [next, patches] = produceWithPatches(base, (ctx: Context) => deleteRowCol(ctx, DELETE_OP));
        const ops = patchToOp(next, filterPatch(patches), { deleteRowColOp: DELETE_OP });
        expectConverged(replaySheetsOps(baseSheets, [ops]), next);
    });

    test('undo of a delete restores cells and non-derivable config on the replay side', () => {
        const base = richContext();
        const baseSheets = structuredClone(base.sheets);
        const [afterDelete, patches, inversePatches] = produceWithPatches(base, (ctx: Context) =>
            deleteRowCol(ctx, DELETE_OP),
        );
        const deleteOps = patchToOp(afterDelete, filterPatch(patches), { deleteRowColOp: DELETE_OP });

        // Mirrors Workbook handleUndo: apply inverse patches locally, emit the
        // inverse op with restoreDeletedCells set.
        const afterUndo = applyPatches(afterDelete, inversePatches);
        const undoOptions = inverseRowColOptions({ deleteRowColOp: DELETE_OP })!;
        undoOptions.restoreDeletedCells = true;
        const undoOps = patchToOp(afterUndo, filterPatch(inversePatches), undoOptions, true);

        const replayed: Sheet[] = replaySheetsOps(baseSheets, [deleteOps, undoOps]);
        expect(replayed[0].data).toEqual(base.sheets[0].data);
        // rowlen/rowhidden of the deleted rows aren't derivable from the delete +
        // insert ops alone — the config metadata op must restore them.
        expect(replayed[0].config).toEqual(base.sheets[0].config);
        // Same for calcChain: the delete dropped the removed rows' entries on
        // every peer, so the undo must ship the authoritative copy back.
        expect(replayed[0].calcChain).toEqual(base.sheets[0].calcChain);
    });

    test('insert inside a multi-row merge stamps the new null cells on the replay side', () => {
        // The engine fills the inserted row with nulls; the mc stamps for cells
        // inside the expanded merge must be applied as full-cell ops before the
        // ['data', r, c, 'mc'] merge ops, or the replay walks into a null cell.
        const op = { type: 'row', index: 3, count: 1, direction: 'lefttop', id: 'id_1' } as const;
        const base = richContext();
        base.sheets[0].config!.merge = { '2_2': { r: 2, c: 2, rs: 2, cs: 2 } };
        base.sheets[0].data![2]![2] = { v: 6, mc: { r: 2, c: 2, rs: 2, cs: 2 } };
        base.sheets[0].data![2]![3] = { mc: { r: 2, c: 2 } };
        base.sheets[0].data![3]![2] = { mc: { r: 2, c: 2 } };
        base.sheets[0].data![3]![3] = { mc: { r: 2, c: 2 } };
        const baseSheets = structuredClone(base.sheets);
        const [next, patches] = produceWithPatches(base, (ctx: Context) => insertRowCol(ctx, op));
        const ops = patchToOp(next, filterPatch(patches), { insertRowColOp: op });
        expectConverged(replaySheetsOps(baseSheets, [ops]), next);
    });
});

describe('borders follow their cells through inserts and deletes', () => {
    test('inserting above shifts the template row down and clones its borders onto the new row', () => {
        const [, next] = emittedOps((ctx) => insertRowCol(ctx, INSERT_OP), { insertRowColOp: INSERT_OP });
        expect(next.sheets[0].config?.borderInfo).toEqual({
            '1_0': { t: SIDE },
            '2_0': { t: SIDE },
            '3_1': { b: SIDE },
            '4_3': { l: SIDE },
        });
    });

    test('inserting below keeps the template row and clones onto every inserted row', () => {
        const op = { type: 'row', index: 1, count: 2, direction: 'rightbottom', id: 'id_1' } as const;
        const [, next] = emittedOps((ctx) => insertRowCol(ctx, op), { insertRowColOp: op });
        expect(next.sheets[0].config?.borderInfo).toEqual({
            '1_0': { t: SIDE },
            '2_0': { t: SIDE },
            '3_0': { t: SIDE },
            '4_1': { b: SIDE },
            '5_3': { l: SIDE },
        });
    });

    test('inserting a column clones the template column', () => {
        const op = { type: 'column', index: 1, count: 1, direction: 'lefttop', id: 'id_1' } as const;
        const [, next] = emittedOps((ctx) => insertRowCol(ctx, op), { insertRowColOp: op });
        expect(next.sheets[0].config?.borderInfo).toEqual({
            '1_0': { t: SIDE },
            '2_1': { b: SIDE },
            '2_2': { b: SIDE },
            '3_4': { l: SIDE },
        });
    });

    test('deleting rows drops their borders and shifts the rest up', () => {
        const [, next] = emittedOps((ctx) => deleteRowCol(ctx, DELETE_OP), { deleteRowColOp: DELETE_OP });
        expect(next.sheets[0].config?.borderInfo).toEqual({ '1_3': { l: SIDE } });
    });

    test('deleting a column drops its borders and shifts the rest left', () => {
        const op = { type: 'column', start: 0, end: 0, id: 'id_1' } as const;
        const [, next] = emittedOps((ctx) => deleteRowCol(ctx, op), { deleteRowColOp: op });
        expect(next.sheets[0].config?.borderInfo).toEqual({ '2_0': { b: SIDE }, '3_2': { l: SIDE } });
    });
});

describe('structural sharing through the immer produce', () => {
    test('untouched rows keep their identity and merge cells get stamped', () => {
        const base = richContext();
        const [next] = produceWithPatches(base, (ctx: Context) => insertRowCol(ctx, INSERT_OP));
        // Row 0 is untouched by an insert at index 1: same reference, no copy.
        expect(next.sheets[0].data?.[0]).toBe(base.sheets[0].data?.[0]);
        // The merge moved down one row and its cells are still stamped.
        expect(next.sheets[0].config?.merge).toEqual({ '4_2': { r: 4, c: 2, rs: 1, cs: 2 } });
        expect(next.sheets[0].data?.[4]?.[2]?.mc).toEqual({ r: 4, c: 2, rs: 1, cs: 2 });
        expect(next.sheets[0].data?.[4]?.[3]?.mc).toEqual({ r: 4, c: 2 });
    });
});
