import { describe, expect, test } from 'bun:test';
import { newSheetChartSpecParts, readChartSpec, sampleChartSpec } from '@workspace/lib/charts';
import type { Sheet as LibSheet } from '@workspace/lib/sheets';
import type { CellRangeRef, ChartSpec } from '@workspace/lib/types/chart';
import { produce } from 'immer';
import { celldataToData, dataToCelldata } from '../../../engine/celldata';
import { getCellValue } from '../../../state/api/cell';
import { calculateFormula, copySheet, getAllSheets } from '../../../state/api/sheet';
import { addSheet } from '../../../state/api/workbook';
import type { Context } from '../../../state/context';
import { deleteSheet } from '../../../state/modules/sheet';
import type { Sheet } from '../../../state/types';
import { author, join, receive } from '../factories/collab';
import { contextFactory, selectionFactory, workbookContextFactory } from '../factories/context';

describe('sheet/core/api/sheet', () => {
    const getContext = () =>
        contextFactory({
            selections: selectionFactory([0, 0], [0, 0], 0, 0),
        }) as Context;
    test('getAllSheets', () => {
        const ctx = getContext();
        expect(getAllSheets(ctx).length).toBe(2);
        expect(getAllSheets(ctx)).toMatchObject([{ id: 'id_1' }, { id: 'id_2' }]);
    });

    test('calculateFormula works before currentSheetId is initialized', () => {
        const ctx = contextFactory({
            currentSheetId: '',
            sheets: [
                {
                    name: 'Sheet1',
                    id: 'id_1',
                    order: 0,
                    data: [
                        [
                            { v: 10, ct: { t: 'n', fa: 'General' } },
                            { f: '=A1+A2', ct: { t: 'n', fa: 'General' } },
                        ],
                        [{ v: 5, ct: { t: 'n', fa: 'General' } }, null],
                    ],
                },
            ],
        }) as Context;

        expect(() => calculateFormula(ctx)).not.toThrow();
        expect(getCellValue(ctx, 0, 1, { id: 'id_1', type: 'v' })).toBe(15);
    });

    test("calculateFormula without id writes each sheet's result to its own sheet", () => {
        const ctx = contextFactory({
            currentSheetId: 'id_1',
            sheets: [
                {
                    name: 'Sheet1',
                    id: 'id_1',
                    order: 0,
                    data: [
                        [
                            { v: 10, ct: { t: 'n', fa: 'General' } },
                            { f: '=A1+A2', ct: { t: 'n', fa: 'General' } },
                        ],
                        [{ v: 5, ct: { t: 'n', fa: 'General' } }, null],
                    ],
                },
                {
                    name: 'Sheet2',
                    id: 'id_2',
                    order: 1,
                    data: [
                        [
                            { v: 20, ct: { t: 'n', fa: 'General' } },
                            { f: '=A1+A2', ct: { t: 'n', fa: 'General' } },
                        ],
                        [{ v: 7, ct: { t: 'n', fa: 'General' } }, null],
                    ],
                },
            ],
        }) as Context;

        calculateFormula(ctx);

        expect(getCellValue(ctx, 0, 1, { id: 'id_1', type: 'v' })).toBe(15);
        expect(getCellValue(ctx, 0, 1, { id: 'id_2', type: 'v' })).toBe(27);
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
            addSheet(draft, 'id_d', false, 'D', { name: 'D', id: 'id_d', order: 1 }),
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

    test('an added sheet keeps its id, and the add switches to it', () => {
        const next = produce(threeSheets(), (draft: Context) =>
            addSheet(draft, undefined, false, 'D', { name: 'D', id: 'id_d', order: 3 }),
        );
        expect(next.sheets[3].id).toBe('id_d');
        expect(next.currentSheetId).toBe('id_d');
    });
});
