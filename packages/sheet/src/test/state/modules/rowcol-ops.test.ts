// A row or column insert or delete ships its marker alone over collab, and every consumer runs it through the engine.
// These tests pin the op shape and prove the editor and the replay converge, including the undo of a delete, which
// restores what the marker alone can't.

import { describe, expect, test } from 'bun:test';
import type { Sheet as LibSheet, MergeCell } from '@workspace/lib/sheets';
import { REFERENCE_ROW_COUNT } from '@workspace/lib/sheets';
import { enablePatches, produce, produceWithPatches } from 'immer';
import { replaySheetsOps, withMaterializedData } from '../../../engine';
import { normalizeSheetConfig } from '../../../engine/sheet-config';
import type { Cell, ShiftedSheet } from '../../../engine/types';
import type { Context } from '../../../state/context';
import { freezeOf } from '../../../state/modules/freeze';
import { undoEntry } from '../../../state/modules/history';
import { saveHyperlink } from '../../../state/modules/hyperlink';
import { deleteRowCol, insertRowCol } from '../../../state/modules/rowcol';
import type { Op } from '../../../state/types';
import type { PatchOptions } from '../../../state/utils/patch';
import { filterPatch, patchToOp } from '../../../state/utils/patch';
import { author, join, receive, tab, tabEdit, tabReceive, tabRedo, tabUndo } from '../factories/collab';
import { contextFactory } from '../factories/context';
import { cellLinks } from '../factories/links';

enablePatches();

const INSERT_OP = { type: 'row', index: 1, count: 1, direction: 'lefttop', id: 'id_1' } as const;
const DELETE_OP = { type: 'row', start: 1, end: 2, id: 'id_1' } as const;
const SIDE = { style: 1, color: '#000' };
const LINK = { type: 'webpage', address: 'https://eigen.is' };
const PEER_LINK = { type: 'webpage', address: 'https://peer.example' };

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
                    [
                        { ...cell(4), link: LINK },
                        { v: 4, m: '4', f: '=A1+A2', ct: { fa: 'General', t: 'n' } },
                        null,
                        null,
                    ],
                    [null, null, { v: 6, mc: { r: 3, c: 2, rs: 1, cs: 2 } }, { mc: { r: 3, c: 2 } }],
                ],
                config: {
                    rowlen: { 2: 60 },
                    rowhidden: { 3: 0 },
                    merge: { '3_2': { r: 3, c: 2, rs: 1, cs: 2 } },
                    borderInfo: { '1_0': { t: SIDE }, '2_1': { b: SIDE }, '3_3': { l: SIDE } },
                },
                // The validation rules ship nothing, so they prove the replay moves them itself.
                dataValidations: {
                    v: {
                        ranges: [{ row: [1, 2], column: [1, 1] }],
                        rule: { type: 'dropdown', type2: 'true', value1: 'a,b', value2: '' },
                    },
                },
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

function run(ctx: Context, { insertRowColOp, deleteRowColOp }: PatchOptions) {
    if (insertRowColOp) insertRowCol(ctx, insertRowColOp);
    else if (deleteRowColOp) deleteRowCol(ctx, deleteRowColOp);
}

// The sheet on the author's tab, the peer's tab and a joiner, where the log holds the peer's batch first. The author's
// tab then applies the log again in that order.
function race(peer: (ctx: Context) => void, options: PatchOptions, base = richContext()) {
    const op = author(base, (ctx) => run(ctx, options), options);
    const fromPeer = author(base, peer);
    const onAuthor = receive(receive(base, fromPeer.ops), op.ops).sheets[0];
    const onPeer = receive(fromPeer.next, op.ops).sheets[0];
    const [joined] = join(base, [fromPeer.ops, op.ops]).map(withMaterializedData);
    return [onAuthor, onPeer, joined];
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

    const columnInsert = { ...INSERT_OP, type: 'column' } as const;
    const columnDelete = { ...DELETE_OP, type: 'column' } as const;
    test.each([
        ['a row insert', { insertRowColOp: INSERT_OP }, { op: 'insertRowCol', value: INSERT_OP }],
        ['a column insert', { insertRowColOp: columnInsert }, { op: 'insertRowCol', value: columnInsert }],
        ['a row delete', { deleteRowColOp: DELETE_OP }, { op: 'deleteRowCol', value: DELETE_OP }],
        ['a column delete', { deleteRowColOp: columnDelete }, { op: 'deleteRowCol', value: columnDelete }],
    ] as const)('%s ships its marker and nothing else', (_, options, marker) => {
        const [ops] = emittedOps((ctx) => run(ctx, options), options);
        expect(ops).toEqual([{ ...marker, id: 'id_1', path: [] }]);
    });
});

describe('BE replay converges with FE state from the slim ops alone', () => {
    function expectConverged(replayed: LibSheet[], next: Context) {
        for (const [i, sheet] of replayed.entries()) {
            expect(sheet.data).toEqual(next.sheets[i].data);
            expect(sheet.config ?? {}).toEqual(next.sheets[i].config ?? {});
            expect(sheet.dataValidations ?? {}).toEqual(next.sheets[i].dataValidations ?? {});
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
        const deleted = author(base, (ctx: Context) => deleteRowCol(ctx, DELETE_OP), { deleteRowColOp: DELETE_OP });
        const deleteOps = deleted.ops;
        const { ops: undoOps } = undoEntry(deleted.next, deleted.entry);

        const replayed = replaySheetsOps(baseSheets, [deleteOps, undoOps]);
        expect(replayed[0].data).toEqual(base.sheets[0].data);
        // rowlen/rowhidden of the deleted rows aren't derivable from the delete +
        // insert ops alone — the config metadata op must restore them.
        expect(replayed[0].config).toEqual(base.sheets[0].config);
    });

    test('insert inside a multi-row merge stamps the new null cells on the replay side', () => {
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

// The engine inserts blank rows/columns and seeds no styles (engine/rowcol.ts applyInsert);
// the clone rule below comes from shiftCellKeyedForInsert: the row/column at
// `index` is the template in both directions, so insert-above at the top of a bordered
// block repeats that row's top edge on the new row.
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

// A row or column op writes each field of a sheet whole, a chart per object: a write inside a field a peer just
// removed, such as the frozen pane's focus after an unfreeze, would fail on the peer and in the replay, taking the
// whole batch with it, and would throw in the author's own undo. Which frozen pane wins follows the log's order
// (SHEETS-TODO.md), so only the grid is compared.
describe("a row or column op racing a peer's unfreeze", () => {
    const frozenContext = () =>
        produce(richContext(), (ctx: Context) => {
            const [sheet] = ctx.sheets;
            sheet.frozen = { type: 'rangeBoth', range: { row_focus: 2, column_focus: 2 } };
            sheet.filterRange = { row: [0, 3], column: [0, 3] };
            sheet.filter = {
                1: { rowhidden: { 2: 0 }, optionstate: true, str: 0, edr: 3, cindex: 1, stc: 0, edc: 3 },
            };
        });
    const size = (sheets: LibSheet[]) => [sheets[0].data!.length, sheets[0].data![0].length];
    const rows = { type: 'row', index: 0, count: 2, direction: 'lefttop', id: 'id_1' } as const;
    const columns = { ...rows, type: 'column' } as const;
    const deletedRows = { type: 'row', start: 0, end: 0, id: 'id_1' } as const;
    const deletedColumns = { ...deletedRows, type: 'column' } as const;

    const cases = [
        ['inserting rows', (ctx: Context) => insertRowCol(ctx, rows), { insertRowColOp: rows }, [6, 4]],
        ['inserting columns', (ctx: Context) => insertRowCol(ctx, columns), { insertRowColOp: columns }, [4, 6]],
        ['deleting rows', (ctx: Context) => deleteRowCol(ctx, deletedRows), { deleteRowColOp: deletedRows }, [3, 4]],
        [
            'deleting columns',
            (ctx: Context) => deleteRowCol(ctx, deletedColumns),
            { deleteRowColOp: deletedColumns },
            [4, 3],
        ],
    ] as const;

    // The undo entry puts each field back whole. Images, charts and validation rules are written one object at a time.
    test.each(cases)('%s writes every sheet field whole, in the op and in its undo entry', (_, recipe, options) => {
        const op = author(frozenContext(), recipe, options);
        const perObject = new Set(['images', 'charts', 'dataValidations']);
        const into = [...op.patches, ...op.inverse].filter(
            (p) => p.path.length > 3 && !perObject.has(String(p.path[2])),
        );
        expect(into.map((p) => p.path)).toEqual([]);
    });

    test.each(cases)(
        '%s applies its batch on every client and in the replay, and the grid sizes agree',
        (_, recipe, options, after) => {
            const base = frozenContext();
            const op = author(base, recipe, options);
            const unfreeze = author(base, (ctx) => {
                delete ctx.sheets[0].frozen;
            });
            const onA = receive(op.next, unfreeze.ops);
            const onB = receive(unfreeze.next, op.ops);
            for (const sheets of [
                onA.sheets,
                onB.sheets,
                join(base, [op.ops, unfreeze.ops]),
                join(base, [unfreeze.ops, op.ops]),
            ]) {
                expect(size(sheets)).toEqual([...after]);
            }
        },
    );
});

// Every receiver derives a sheet's size from its cells, so two row ops sent at once leave the size in step with the
// cells on both tabs and in the replay. A size written whole in the batch would be the author's, one op short.
describe('two row ops sent at once keep the sheet size in step with its cells', () => {
    const inserted = { type: 'row', index: 0, count: 1, direction: 'lefttop', id: 'id_1' } as const;
    const deleted = { type: 'row', start: 3, end: 3, id: 'id_1' } as const;
    const cases = [
        ['two inserts', { insertRowColOp: inserted }, { insertRowColOp: inserted }],
        ['an insert and a delete', { insertRowColOp: inserted }, { deleteRowColOp: deleted }],
        ['two deletes', { deleteRowColOp: deleted }, { deleteRowColOp: { ...deleted, start: 0, end: 0 } }],
    ] as const;
    const size = (sheet: LibSheet) => [sheet.row, sheet.column];
    const grid = (sheet: LibSheet) => [sheet.data!.length, sheet.data![0].length];

    test.each(cases)('%s', (_, first, second) => {
        const base = produce(contextFactory() as Context, (ctx: Context) => {
            Object.assign(ctx.sheets[0], { row: 4, column: 4 });
        });
        const a = author(base, (ctx) => run(ctx, first), first);
        const b = author(base, (ctx) => run(ctx, second), second);
        const onA = receive(a.next, b.ops).sheets[0];
        const onB = receive(b.next, a.ops).sheets[0];
        const [joined] = join(base, [a.ops, b.ops]).map(withMaterializedData);
        for (const sheet of [onA, onB, joined]) expect(size(sheet)).toEqual(grid(sheet));
    });
});

// A whole-column rule already runs to the grid's last row, so an insert inside it leaves it as it was. The insert
// then writes no rule, so the undo entry holds none, and an undo has none to put back over a peer's edit.
test('a row insert inside a whole-column rule writes no rule', () => {
    const base = produce(richContext(), (ctx: Context) => {
        ctx.sheets[0].dataValidations = {
            column: {
                ranges: [{ row: [0, REFERENCE_ROW_COUNT - 1], column: [0, 0] }],
                rule: { type: 'dropdown', type2: '', value1: 'a,b', value2: '' },
            },
        };
    });
    const op = author(base, (ctx) => insertRowCol(ctx, INSERT_OP), { insertRowColOp: INSERT_OP });
    expect([...op.patches, ...op.inverse].filter(({ path }) => path[2] === 'dataValidations')).toEqual([]);
});

// A peer can send any value in a row op. A peer and a joiner then skip the whole batch alike, so no other op of it lands on rows the op did not move.
describe('a malformed row op skips its whole batch', () => {
    const write: Op = { op: 'replace', id: 'id_1', path: ['data', 0, 0], value: { v: 'x', m: 'x' } };
    const insert = (value: Record<string, unknown>): Op => ({
        op: 'insertRowCol',
        id: 'id_1',
        path: [],
        value: { type: 'row', index: 1, count: 1, direction: 'lefttop', ...value },
    });
    const remove = (value: Record<string, unknown>): Op => ({
        op: 'deleteRowCol',
        id: 'id_1',
        path: [],
        value: { type: 'row', start: 1, end: 1, ...value },
    });
    const cases: [string, Op][] = [
        ['a negative index', insert({ index: -1 })],
        ['a fractional index', insert({ index: 0.5 })],
        ['an index past the grid', insert({ index: 2 ** 31 })],
        ['a count of zero', insert({ count: 0 })],
        ['a NaN count', insert({ count: Number.NaN })],
        ['a fractional count', insert({ count: 1.5 })],
        ['a negative start', remove({ start: -1 })],
        ['a start past its end', remove({ start: 2, end: 1 })],
        ['a fractional end', remove({ end: 1.5 })],
        ['a NaN end', remove({ end: Number.NaN })],
    ];

    test.each(cases)('%s', (_, op) => {
        const base = richContext();
        const [joined] = join(base, [[op, write]]).map(withMaterializedData);
        for (const sheet of [receive(base, [op, write]).sheets[0], joined]) {
            expect(sheet.data?.length).toBe(4);
            expect(sheet.data?.[0]?.[0]?.v).toBe(1);
        }
    });
});

// Every receiver's engine moves the merges and the conditional formats, and stamps the merges' cells again. So two
// row ops sent at once on a sheet with a merge both apply, on both tabs and for a joiner, and the merge and the
// format stay on their cells. The log holds A's batch first.
describe('two row ops sent at once on a sheet with a merge', () => {
    const inserted = { type: 'row', index: 0, count: 1, direction: 'lefttop', id: 'id_1' } as const;
    const deleted = { type: 'row', start: 0, end: 0, id: 'id_1' } as const;
    const cases = [
        ['two inserts', { insertRowColOp: inserted }, 6, 5],
        ['a delete and an insert', { deleteRowColOp: deleted }, 4, 3],
    ] as const;

    test.each(cases)('%s', (_, first, rows, mergeRow) => {
        const base = produce(richContext(), (ctx: Context) => {
            ctx.sheets[0].conditionalFormatRules = [
                {
                    type: 'default',
                    cellrange: [{ row: [3, 3], column: [2, 3] }],
                    format: { cellColor: '#ff0000' },
                    conditionName: 'greaterThan',
                    conditionValue: [0],
                },
            ];
        });
        const a = author(base, (ctx) => run(ctx, first), first);
        const b = author(base, (ctx) => run(ctx, { insertRowColOp: inserted }), { insertRowColOp: inserted });
        const onA = receive(a.next, b.ops).sheets[0];
        const onB = receive(receive(base, a.ops), b.ops).sheets[0];
        const [joined] = join(base, [a.ops, b.ops]).map(withMaterializedData);
        const merge = { r: mergeRow, c: 2, rs: 1, cs: 2 };
        for (const sheet of [onA, onB, joined]) {
            expect(sheet.data?.length).toBe(rows);
            expect(sheet.config?.merge).toEqual({ [`${mergeRow}_2`]: merge });
            expect(sheet.data?.[mergeRow]?.[2]?.mc).toEqual(merge);
            expect(sheet.data?.[mergeRow]?.[3]?.mc).toEqual({ r: mergeRow, c: 2 });
            expect(sheet.conditionalFormatRules?.[0].cellrange).toEqual([
                { row: [mergeRow, mergeRow], column: [2, 3] },
            ]);
        }
    });
});

// Every receiver's engine moves the frozen pane and the filter with the rows, so a row op sent with a peer's freeze,
// filter or unfreeze leaves the same pane and filter on the author, the peer and a joiner. The log holds the peer's
// batch first, and the author's tab then applies the log again in that order.
describe("a row op sent with a peer's freeze or filter", () => {
    const rows = { type: 'row', index: 0, count: 2, direction: 'lefttop', id: 'id_1' } as const;
    const columns = { ...rows, type: 'column' } as const;
    const freezeAndFilter = (ctx: Context) => {
        const [sheet] = ctx.sheets;
        sheet.frozen = { type: 'rangeBoth', range: { row_focus: 1, column_focus: 1 } };
        sheet.filterRange = { row: [1, 3], column: [0, 1] };
        sheet.filter = { 0: { rowhidden: { 2: 0 }, optionstate: true, str: 1, edr: 3, cindex: 0, stc: 0, edc: 1 } };
    };
    const pane = ({ frozen, filterRange, filter }: ShiftedSheet) => ({ frozen, filterRange, filter });

    test('a row insert moves the pane and the filter a peer set', () => {
        for (const sheet of race(freezeAndFilter, { insertRowColOp: rows })) {
            expect(pane(sheet)).toEqual({
                frozen: { type: 'rangeBoth', range: { row_focus: 3, column_focus: 1 } },
                filterRange: { row: [3, 5], column: [0, 1] },
                filter: { 0: { rowhidden: { 4: 0 }, optionstate: true, str: 3, edr: 5, cindex: 0, stc: 0, edc: 1 } },
            });
        }
    });

    test('a column insert moves the pane and the filter a peer set', () => {
        for (const sheet of race(freezeAndFilter, { insertRowColOp: columns })) {
            expect(pane(sheet)).toEqual({
                frozen: { type: 'rangeBoth', range: { row_focus: 1, column_focus: 3 } },
                filterRange: { row: [1, 3], column: [2, 3] },
                filter: { 0: { rowhidden: { 2: 0 }, optionstate: true, str: 1, edr: 3, cindex: 2, stc: 2, edc: 3 } },
            });
        }
    });

    test('a row delete moves the pane and the filter a peer set', () => {
        const deleted = { type: 'row', start: 0, end: 0, id: 'id_1' } as const;
        for (const sheet of race(freezeAndFilter, { deleteRowColOp: deleted })) {
            expect(pane(sheet)).toEqual({
                frozen: { type: 'rangeBoth', range: { row_focus: 0, column_focus: 1 } },
                filterRange: { row: [0, 2], column: [0, 1] },
                filter: { 0: { rowhidden: { 1: 0 }, optionstate: true, str: 0, edr: 2, cindex: 0, stc: 0, edc: 1 } },
            });
        }
    });

    test('a row insert leaves a pane a peer removed removed', () => {
        const frozen = produce(richContext(), freezeAndFilter);
        const unfreeze = (ctx: Context) => {
            delete ctx.sheets[0].frozen;
        };
        for (const sheet of race(unfreeze, { insertRowColOp: rows }, frozen)) expect(sheet.frozen).toBeUndefined();
    });

    test('a row insert moves a pane of a bare type that has a range', () => {
        const base = produce(richContext(), (ctx: Context) => {
            ctx.sheets[0].frozen = { type: 'both', range: { row_focus: 1, column_focus: 1 } };
        });
        for (const sheet of race(() => {}, { insertRowColOp: rows }, base)) {
            expect(sheet.frozen).toEqual({ type: 'both', range: { row_focus: 3, column_focus: 1 } });
        }
    });
});

// A row or column that was never frozen must not stay pinned once the frozen ones are gone, on the author's tab, a
// peer's tab and a joiner alike.
describe('a delete of the whole frozen band', () => {
    const paneOf = (frozen: LibSheet['frozen']) =>
        produce(richContext(), (ctx: Context) => {
            ctx.sheets[0].frozen = frozen;
        });
    const pane = (type: NonNullable<LibSheet['frozen']>['type'], row_focus: number, column_focus: number) => ({
        type,
        range: { row_focus, column_focus },
    });
    const rows = (start: number, end: number) => ({ type: 'row', start, end, id: 'id_1' }) as const;
    const columns = (start: number, end: number) => ({ type: 'column', start, end, id: 'id_1' }) as const;

    test.each([
        ['the rows of a row pane', pane('rangeRow', 1, 0), rows(0, 1), undefined],
        ['the columns of a column pane', pane('rangeColumn', 0, 1), columns(0, 1), undefined],
        ['more rows than the band', pane('rangeRow', 1, 0), rows(0, 2), undefined],
        ['the rows of a pane on both axes', pane('rangeBoth', 1, 1), rows(0, 1), pane('rangeColumn', 0, 1)],
        ['the columns of a pane on both axes', pane('rangeBoth', 1, 1), columns(0, 1), pane('rangeRow', 1, 0)],
        ['the rows of a bare pane on both axes', pane('both', 1, 1), rows(0, 1), pane('rangeColumn', 0, 1)],
        ['the columns of a bare column pane', pane('column', 0, 1), columns(0, 1), undefined],
    ] as const)('%s leaves what is left of the pane on every reader', (_, frozen, deleted, after) => {
        for (const sheet of race(() => {}, { deleteRowColOp: deleted }, paneOf(frozen))) {
            expect(sheet.frozen).toEqual(after);
        }
    });

    test('a delete that leaves part of the band keeps the pane', () => {
        for (const sheet of race(() => {}, { deleteRowColOp: rows(0, 0) }, paneOf(pane('rangeRow', 1, 0)))) {
            expect(sheet.frozen).toEqual(pane('rangeRow', 0, 0));
        }
    });

    test('the second of two deletes unfreezes both tabs, which pin nothing', () => {
        const base = paneOf(pane('rangeRow', 1, 0));
        const [a, b] = [tab(base), tab(base)];
        const remove = () => tabEdit(b, (ctx) => deleteRowCol(ctx, rows(0, 0)), { deleteRowColOp: rows(0, 0) });
        const batches = [remove(), remove()];
        for (const batch of batches) tabReceive(a, batch);
        for (const { ctx } of [a, b]) {
            expect(ctx.sheets[0].frozen).toBeUndefined();
            expect(freezeOf(ctx)).toBeUndefined();
        }
        expect(join(base, batches)[0].frozen).toBeUndefined();
    });

    test.each([
        ['row', pane('rangeRow', 1, 0), rows(0, 1)],
        ['column', pane('rangeColumn', 0, 1), columns(0, 1)],
        ['both', pane('rangeBoth', 1, 1), rows(0, 1)],
    ] as const)('its undo brings a %s pane back on every reader, and its redo takes it again', (_, frozen, deleted) => {
        const base = paneOf(frozen);
        const [writer, peer] = [tab(base), tab(base)];
        const removed = tabEdit(writer, (ctx) => deleteRowCol(ctx, deleted), { deleteRowColOp: deleted });
        tabReceive(peer, removed);
        const left = peer.ctx.sheets[0].frozen;
        const undone = tabUndo(writer);
        tabReceive(peer, undone);
        for (const sheet of [writer.ctx.sheets[0], peer.ctx.sheets[0], join(base, [removed, undone])[0]]) {
            expect(sheet.frozen).toEqual(frozen);
        }
        const redone = tabRedo(writer);
        tabReceive(peer, redone);
        for (const sheet of [writer.ctx.sheets[0], peer.ctx.sheets[0], join(base, [removed, undone, redone])[0]]) {
            expect(sheet.frozen).toEqual(left);
        }
    });
});

// The op ships none of its sheet's other fields, so what the log puts before it stays as the peer left it.
describe("a row or column op after a peer's edit of the sheet", () => {
    const rows = { type: 'row', index: 0, count: 2, direction: 'lefttop', id: 'id_1' } as const;
    const removed = { type: 'row', start: 0, end: 0, id: 'id_1' } as const;
    const ops = [
        ['a row insert', { insertRowColOp: rows }, { '4_0': LINK, '5_1': PEER_LINK }],
        ['a column insert', { insertRowColOp: { ...rows, type: 'column' } }, { '2_2': LINK, '3_3': PEER_LINK }],
        ['a row delete', { deleteRowColOp: removed }, { '1_0': LINK, '2_1': PEER_LINK }],
        ['a column delete', { deleteRowColOp: { ...removed, type: 'column' } }, { '3_0': PEER_LINK }],
    ] as const;

    test.each(ops)("%s keeps the peer's rename", (_, options) => {
        const rename = (ctx: Context) => {
            ctx.sheets[0].name = 'Renamed';
        };
        for (const sheet of race(rename, options)) expect(sheet.name).toBe('Renamed');
    });

    // A sheet with a colour already, so a batch that wrote its fields whole would overwrite the peer's.
    test.each(ops)("%s keeps the peer's tab colour", (_, options) => {
        const base = produce(richContext(), (ctx: Context) => {
            ctx.sheets[0].color = '#00ff00';
        });
        const paint = (ctx: Context) => {
            ctx.sheets[0].color = '#ff0000';
        };
        for (const sheet of race(paint, options, base)) expect(sheet.color).toBe('#ff0000');
    });

    test.each(ops)("%s keeps the peer's hide", (_, options) => {
        const base = produce(richContext(), (ctx: Context) => {
            ctx.sheets[0].hide = 0;
        });
        const hide = (ctx: Context) => {
            ctx.sheets[0].hide = 1;
        };
        for (const sheet of race(hide, options, base)) expect(sheet.hide).toBe(1);
    });

    test.each(ops)("%s moves the peer's new link", (_, options, links) => {
        const link = (ctx: Context) => saveHyperlink(ctx, 3, 1, 'peer', PEER_LINK.type, PEER_LINK.address);
        for (const sheet of race(link, options)) expect(cellLinks(sheet)).toEqual(links);
    });
});

// Every receiver's engine stamps a merge's cells. A batch that also wrote the author's stamps as whole cells would
// leave, under a peer's row or column op, a stamp on a blank row or column at a corner that holds no merge.
describe("an insert that grows a merge, after a peer's row or column op", () => {
    const grid = (merge: MergeCell) => {
        const data: Cell[][] = [];
        for (let r = 0; r < 8; r += 1) {
            data.push([]);
            for (let c = 0; c < 8; c += 1) data[r].push({ v: `${r}_${c}` });
        }
        for (let r = merge.r; r < merge.r + merge.rs; r += 1) {
            for (let c = merge.c; c < merge.c + merge.cs; c += 1) data[r][c] = { mc: { r: merge.r, c: merge.c } };
        }
        data[merge.r][merge.c] = { v: 'corner', mc: merge };
        const ctx = contextFactory({
            sheets: [
                {
                    name: 'sheet',
                    id: 'id_1',
                    order: 0,
                    row: 8,
                    column: 8,
                    data,
                    config: { merge: { [`${merge.r}_${merge.c}`]: merge } },
                },
            ],
        }) as Context;
        for (const sheet of ctx.sheets) normalizeSheetConfig(sheet);
        return ctx;
    };
    const stamps = ({ data }: LibSheet) =>
        (data ?? []).flatMap((row, r) => row.flatMap((cell, c) => (cell?.mc ? [[r, c, cell.mc]] : [])));
    const values = ({ data }: LibSheet) =>
        (data ?? [])
            .flat()
            .flatMap((cell) => (cell?.v == null ? [] : [String(cell.v)]))
            .sort();

    test('a row insert leaves no stamp outside the merge, and every value stays', () => {
        const base = grid({ r: 1, c: 1, rs: 3, cs: 1 });
        const peer = { type: 'row', index: 0, count: 5, direction: 'lefttop', id: 'id_1' } as const;
        const mine = { ...peer, index: 2, count: 1 };
        const merge = { r: 7, c: 1, rs: 3, cs: 1 };
        for (const sheet of race((ctx) => insertRowCol(ctx, peer), { insertRowColOp: mine }, base)) {
            expect(values(sheet)).toEqual(values(base.sheets[0]));
            expect(sheet.config?.merge).toEqual({ '7_1': merge });
            expect(stamps(sheet)).toEqual([
                [7, 1, merge],
                [8, 1, { r: 7, c: 1 }],
                [9, 1, { r: 7, c: 1 }],
            ]);
        }
    });

    test('a column insert leaves no stamp outside the merge, and every value stays', () => {
        const base = grid({ r: 1, c: 1, rs: 1, cs: 3 });
        const peer = { type: 'column', index: 0, count: 5, direction: 'lefttop', id: 'id_1' } as const;
        const mine = { ...peer, index: 2, count: 1 };
        const merge = { r: 1, c: 7, rs: 1, cs: 3 };
        for (const sheet of race((ctx) => insertRowCol(ctx, peer), { insertRowColOp: mine }, base)) {
            expect(values(sheet)).toEqual(values(base.sheets[0]));
            expect(sheet.config?.merge).toEqual({ '1_7': merge });
            expect(stamps(sheet)).toEqual([
                [1, 7, merge],
                [1, 8, { r: 1, c: 7 }],
                [1, 9, { r: 1, c: 7 }],
            ]);
        }
    });

    // The stamp's row is past the grid the peer's delete left, so a batch that wrote it would roll back and lose the
    // insert on every tab that takes the log in this order.
    test("the insert still lands where a peer's delete took the rows its stamps named", () => {
        const base = grid({ r: 1, c: 1, rs: 3, cs: 1 });
        const peerDelete = (ctx: Context) => deleteRowCol(ctx, { type: 'row', start: 1, end: 7, id: 'id_1' });
        const mine = { type: 'row', index: 2, count: 1, direction: 'lefttop', id: 'id_1' } as const;
        for (const sheet of race(peerDelete, { insertRowColOp: mine }, base)) expect(sheet.data?.length).toBe(2);
    });
});

// A workbook can hold two names that differ only in case, such as one stored before a rename refused that. A ref reads
// the sheet of exactly its name first, so a row op on one of the two moves only that sheet's refs, in the editor and
// in the replay alike.
test('a row insert on Data moves =Data!A1 and leaves =data!A1 alone', () => {
    const cell = { v: 0, f: '=Data!A1+data!A1' };
    const base = contextFactory({
        sheets: [
            { name: 'Data', id: 'id_1', order: 0, data: [[null, cell]] },
            { name: 'data', id: 'id_2', order: 1, data: [[null, cell]] },
        ],
    }) as Context;
    const inserted = { type: 'row', index: 0, count: 1, direction: 'lefttop', id: 'id_1' } as const;
    const { next, ops } = author(base, (ctx) => insertRowCol(ctx, inserted), { insertRowColOp: inserted });
    const [onData, ondata] = join(base, [ops]).map(withMaterializedData);
    for (const [data, other] of [next.sheets, [onData, ondata]]) {
        expect(data.data?.[1]?.[1]?.f).toBe('=Data!A2+data!A1');
        expect(other.data?.[0]?.[1]?.f).toBe('=Data!A2+data!A1');
    }
});

// An undo sends the row op a peer would, so it lands the selection by the same rule, on the tab and on its peer.
describe('undo and redo of a row op land the selection', () => {
    const rowOf = ({ ctx }: { ctx: Context }) => ctx.selections?.[0].row;
    const selected = (r: number) =>
        produce(richContext(), (draft: Context) => {
            draft.currentSheetId = 'id_1';
            draft.selections = [{ row: [r, r], column: [1, 1], row_focus: r, column_focus: 1 }];
        });
    const inserted = (index: number, direction: 'lefttop' | 'rightbottom') =>
        ({ type: 'row', index, count: 1, direction, id: 'id_1' }) as const;

    test('the undo of my insert stays on its row, and the redo keeps the cell it found', () => {
        const base = selected(1);
        const [mine, peer] = [tab(base), tab(base)];
        const op = inserted(2, 'lefttop');
        tabReceive(
            peer,
            tabEdit(mine, (ctx) => insertRowCol(ctx, op), { insertRowColOp: op }),
        );
        expect(rowOf(mine)).toEqual([2, 2]);
        tabReceive(peer, tabUndo(mine));
        expect(rowOf(mine)).toEqual([2, 2]);
        expect(mine.ctx.selections?.[0].column).toEqual([0, 3]);
        tabReceive(peer, tabRedo(mine));
        expect(rowOf(mine)).toEqual([3, 3]);
        expect(rowOf(peer)).toEqual([1, 1]);
    });

    test('the undo of my insert below the last row clamps to the grid', () => {
        const mine = tab(selected(3));
        const op = inserted(3, 'rightbottom');
        tabEdit(mine, (ctx) => insertRowCol(ctx, op), { insertRowColOp: op });
        expect(rowOf(mine)).toEqual([4, 4]);
        tabUndo(mine);
        expect(rowOf(mine)).toEqual([3, 3]);
    });

    test('a peer on the row my undo takes lands too', () => {
        const base = selected(0);
        const [mine, peer] = [tab(base), tab(base)];
        const op = inserted(2, 'lefttop');
        tabReceive(
            peer,
            tabEdit(mine, (ctx) => insertRowCol(ctx, op), { insertRowColOp: op }),
        );
        peer.ctx = produce(peer.ctx, (draft: Context) => {
            draft.selections = [{ row: [2, 2], column: [1, 1], row_focus: 2, column_focus: 1 }];
        });
        tabReceive(peer, tabUndo(mine));
        expect(rowOf(peer)).toEqual([2, 2]);
    });

    test('delete, undo, a click on the restored row and redo keep a selection', () => {
        const mine = tab(selected(1));
        const op = { type: 'row', start: 1, end: 1, id: 'id_1' } as const;
        tabEdit(mine, (ctx) => deleteRowCol(ctx, op), { deleteRowColOp: op });
        expect(rowOf(mine)).toEqual([1, 1]);
        tabUndo(mine);
        mine.ctx = produce(mine.ctx, (draft: Context) => {
            draft.selections = [{ row: [1, 1], column: [1, 1], row_focus: 1, column_focus: 1 }];
        });
        tabRedo(mine);
        expect(rowOf(mine)).toEqual([1, 1]);
    });

    test('my own delete with the cell editor open on a row below moves the editor with its cell', () => {
        const base = produce(selected(3), (draft: Context) => {
            draft.editingCellPosition = [3, 1];
        });
        const mine = tab(base);
        const op = { type: 'row', start: 1, end: 1, id: 'id_1' } as const;
        tabEdit(mine, (ctx) => deleteRowCol(ctx, op), { deleteRowColOp: op });
        expect(mine.ctx.editingCellPosition).toEqual([2, 1]);
        expect(rowOf(mine)).toEqual([2, 2]);
    });
});
