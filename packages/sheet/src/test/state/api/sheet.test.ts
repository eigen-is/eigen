import { describe, expect, test } from 'bun:test';
import { newSheetChartSpecParts, readChartSpec, sampleChartSpec } from '@workspace/lib/charts';
import type { Sheet as LibSheet } from '@workspace/lib/sheets';
import type { CellRangeRef, ChartSpec } from '@workspace/lib/types/chart';
import { produce, produceWithPatches } from 'immer';
import { celldataToData, dataToCelldata } from '../../../engine/celldata';
import { DEFAULT_SHEET_COLUMN_COUNT, DEFAULT_SHEET_ROW_COUNT } from '../../../engine/defaults';
import { copySheet, setSheetOrder } from '../../../state/api/sheet';
import type { Context } from '../../../state/context';
import { setCellValue } from '../../../state/modules/cell';
import { execFunctionGroup } from '../../../state/modules/formula-exec';
import { addSheet, deleteSheet } from '../../../state/modules/sheet';
import type { Sheet } from '../../../state/types';
import { filterPatch, patchToOp } from '../../../state/utils/patch';
import { author, join, receive } from '../factories/collab';
import { contextFactory, heldGraph, selectionFactory, workbookContextFactory } from '../factories/context';

describe('sheet/core/api/sheet', () => {
    const getContext = () =>
        contextFactory({
            selections: selectionFactory([0, 0], [0, 0], 0, 0),
        }) as Context;
    test('setSheetOrder renumbers every sheet from 0', () => {
        const ctx = getContext();
        setSheetOrder(ctx, { id_1: 2, id_2: 1 });
        expect(ctx.sheets[0].order).toBe(1);
        expect(ctx.sheets[1].order).toBe(0);
        setSheetOrder(ctx, { id_1: 1, id_2: 2 });
        expect(ctx.sheets[0].order).toBe(0);
        expect(ctx.sheets[1].order).toBe(1);
    });

    test("a copied sheet's charts read the copy, under fresh ids", () => {
        const ref = (sheetId: string): CellRangeRef => ({ sheetId, row: [2, 5], column: [1, 1] });
        const spec: ChartSpec = {
            ...sampleChartSpec('column'),
            data: {
                source: 'range',
                categories: ref('id_2'),
                series: [{ id: 's-1', name: ref('id_1'), values: ref('id_1') }],
            },
        };
        const chart = { id: 'c1', index: 'a0', x: 0, y: 0, width: 400, height: 300, ...newSheetChartSpecParts(spec) };
        const ctx = contextFactory({
            sheets: [
                { name: 'S', id: 'id_1', order: 0, charts: { c1: chart } },
                { name: 'T', id: 'id_2', order: 1, charts: {} },
            ],
        }) as Context;
        const next = produce(ctx, (draft: Context) => copySheet(draft, 'id_1'));
        const copy = next.sheets[2];
        const [copied] = Object.values(copy.charts!);
        expect(copied.id).not.toBe('c1');
        expect(Object.keys(copy.charts!)).toEqual([copied.id]);
        const data = readChartSpec(copied).spec?.data;
        expect(data?.source === 'range' && data.series[0].values?.sheetId).toBe(copy.id!);
        expect(data?.source === 'range' && typeof data.series[0].name !== 'string' && data.series[0].name.sheetId).toBe(
            copy.id!,
        );
        expect(data?.source === 'range' && data.categories?.sheetId).toBe('id_2');
        expect(next.sheets[0].charts).toEqual({ c1: chart });
    });

    test("a copied sheet's images take fresh ids too, each under its own key", () => {
        const image = { id: 'i1', index: 'a0', x: 0, y: 0, width: 40, height: 30, mediaName: 'a.png' };
        const ctx = contextFactory({
            sheets: [{ name: 'S', id: 'id_1', order: 0, images: { i1: image } }],
        }) as Context;
        const next = produce(ctx, (draft: Context) => copySheet(draft, 'id_1'));
        const [copied] = Object.values(next.sheets[1].images!);
        expect(copied).toEqual({ ...image, id: copied.id });
        expect(copied.id).not.toBe('i1');
        expect(Object.keys(next.sheets[1].images!)).toEqual([copied.id]);
        expect(next.sheets[0].images).toEqual({ i1: image });
    });

    // A comment stays on the cells it was put on, as a duplicated canvas element starts without its comments.
    test('a copied sheet starts without comment anchors, for the author, a peer and a joiner', () => {
        const commented = { v: 'a', m: 'a', commentCardIds: ['c1'] };
        const base = workbookContextFactory({
            currentSheetId: 'id_1',
            sheets: [
                {
                    name: 'S',
                    id: 'id_1',
                    order: 0,
                    row: 2,
                    column: 2,
                    data: [
                        [commented, null],
                        [null, null],
                    ],
                },
            ],
        });
        const { next, ops } = author(base, (ctx) => copySheet(ctx, 'id_1'), { addSheetOp: true });
        const anchors = (sheets: readonly LibSheet[]) =>
            sheets.map((sheet) =>
                dataToCelldata(sheet.data ?? celldataToData(sheet.celldata ?? [], 0, 0)).flatMap(
                    ({ v }) => v?.commentCardIds ?? [],
                ),
            );
        expect(anchors(next.sheets)).toEqual([['c1'], []]);
        expect(anchors(receive(base, ops).sheets)).toEqual([['c1'], []]);
        expect(anchors(join(base, [ops]))).toEqual([['c1'], []]);
        expect(next.sheets[1].data?.[0]?.[0]?.v).toBe('a');
    });

    // The op log keeps every add, and a matrix holds a null per empty cell, so the add of a large copy would be large.
    test('the add a copy sends carries its stored cells, not its cell matrix', () => {
        const base = workbookContextFactory({
            currentSheetId: 'id_1',
            sheets: [
                {
                    name: 'S',
                    id: 'id_1',
                    order: 0,
                    row: 2,
                    column: 2,
                    data: [
                        [{ v: 'a', m: 'a', commentCardIds: ['c1'] }, null],
                        [null, null],
                    ],
                },
            ],
        });
        const { next, ops } = author(base, (ctx) => copySheet(ctx, 'id_1'), { addSheetOp: true });
        const added = ops.find((op) => op.op === 'addSheet')?.value;
        expect(added?.data).toBeUndefined();
        expect(added?.celldata).toEqual([{ r: 0, c: 0, v: { v: 'a', m: 'a' } }]);
        expect(next.sheets[1].data?.[0]?.[0]).toEqual({ v: 'a', m: 'a' });
        expect(receive(base, ops).sheets[1].data?.[0]?.[0]).toEqual({ v: 'a', m: 'a' });
    });

    // The map may be built before the copy, such as while the browser is idle after a load, and the add must not leave
    // the copy out of it.
    test("a copy's formula follows an edit of the copy's cells once the formula graph is built", () => {
        const base = workbookContextFactory({
            currentSheetId: 'id_1',
            sheets: [
                {
                    name: 'S',
                    id: 'id_1',
                    order: 0,
                    row: 1,
                    column: 2,
                    data: [
                        [
                            { v: 1, m: '1' },
                            { v: 1, m: '1', f: '=A1' },
                        ],
                    ],
                },
            ],
        });
        const copied = produce(base, (draft: Context) => {
            heldGraph(draft);
            copySheet(draft, 'id_1');
        });
        const copyId = copied.sheets[1].id ?? '';
        const edited = produce(copied, (draft: Context) => {
            setCellValue(draft, 0, 0, draft.sheets[1].data, 5);
            execFunctionGroup(draft, [{ r: 0, c: 0, id: copyId }]);
        });
        expect(edited.sheets[1].data?.[0]?.[1]?.v).toBe(5);
        expect(edited.sheets[0].data?.[0]?.[1]?.v).toBe(1);
    });

    // A copy is a sheet like any other on the tab that made it, as on a peer's, so a read of every sheet's cells, such
    // as a search or a copy of the copy, finds its cells.
    test('a copied sheet has its cell matrix, and a copy of it keeps the cells', () => {
        const base = workbookContextFactory({
            currentSheetId: 'id_1',
            sheets: [
                {
                    name: 'S',
                    id: 'id_1',
                    order: 0,
                    row: 2,
                    column: 2,
                    data: [
                        [{ v: 'a', m: 'a' }, null],
                        [null, null],
                    ],
                },
            ],
        });
        const once = produce(base, (draft: Context) => copySheet(draft, 'id_1'));
        expect(once.sheets[1].data?.[0]?.[0]?.v).toBe('a');
        const copyId = once.sheets[1].id ?? '';
        const twice = produce(once, (draft: Context) => copySheet(draft, copyId));
        expect(twice.sheets[2].data?.[0]?.[0]?.v).toBe('a');
    });
});

describe('sheet order on a copy, an add and a delete', () => {
    const unordered: Sheet = { name: 'A', id: 'id_a' };
    const threeSheets = (first: Sheet = { ...unordered, order: 0 }) =>
        contextFactory({
            sheets: [first, { name: 'B', id: 'id_b', order: 1 }, { name: 'C', id: 'id_c', order: 2 }],
        }) as Context;
    const orders = (ctx: Context) => ctx.sheets.map((sheet) => [sheet.name, sheet.order]);

    test('a copied sheet lands right after its source', () => {
        const next = produce(threeSheets(), (draft: Context) => copySheet(draft, 'id_a'));
        expect(orders(next)).toEqual([
            ['A', 0],
            ['B', 2],
            ['C', 3],
            ['A(Copy)', 1],
        ]);
    });

    test('a copied sheet without an order lands right after it, as the tab strip sorts it first', () => {
        const next = produce(threeSheets(unordered), (draft: Context) => copySheet(draft, 'id_a'));
        expect(orders(next)).toEqual([
            ['A', 0],
            ['B', 2],
            ['C', 3],
            ['A(Copy)', 1],
        ]);
    });

    test('an add counts a sheet without an order as 0', () => {
        const next = produce(threeSheets(unordered), (draft: Context) =>
            addSheet(draft, 'id_d', 'D', { name: 'D', id: 'id_d', order: 1 }),
        );
        expect(orders(next)).toEqual([
            ['A', undefined],
            ['B', 2],
            ['C', 3],
            ['D', 1],
        ]);
    });

    test('a delete counts a sheet without an order as 0', () => {
        const next = produce(threeSheets(unordered), (draft: Context) => deleteSheet(draft, 'id_b'));
        expect(orders(next)).toEqual([
            ['A', undefined],
            ['C', 1],
        ]);
    });

    test("a blank sheet has its cell matrix inside the add's own recipe, and its add sends none", () => {
        const base = threeSheets();
        const [next, patches] = produceWithPatches(base, (draft: Context) => addSheet(draft));
        const added = next.sheets[3];
        expect(next.currentSheetId).toBe(added.id);
        expect(added.data).toHaveLength(DEFAULT_SHEET_ROW_COUNT);
        expect(added.data?.[0]).toHaveLength(DEFAULT_SHEET_COLUMN_COUNT);
        const [{ value }] = patchToOp(base, next, filterPatch(patches), { addedSheet: added });
        expect(value.data).toBeUndefined();
        expect(value.celldata).toEqual([]);
    });

    test('an added sheet keeps its id, and the add switches to it', () => {
        const next = produce(threeSheets(), (draft: Context) =>
            addSheet(draft, undefined, 'D', { name: 'D', id: 'id_d', order: 3 }),
        );
        expect(next.sheets[3].id).toBe('id_d');
        expect(next.currentSheetId).toBe('id_d');
    });
});
