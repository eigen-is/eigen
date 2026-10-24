import { describe, expect, test } from 'bun:test';
import { parseChartSpec, sampleChartSpec } from '@workspace/lib/charts';
import type { CellRangeRef, ChartSpec } from '@workspace/lib/types/chart';
import { produce } from 'immer';
import { getCellValue } from '../../../state/api/cell';
import { calculateFormula, copySheet, getAllSheets } from '../../../state/api/sheet';
import type { Context } from '../../../state/context';
import { contextFactory, selectionFactory } from '../factories/context';

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
                series: [
                    {
                        id: 's-1',
                        name: ref('id_1'),
                        values: ref('id_1'),
                        color: '#2a78d6',
                        markers: false,
                        smooth: false,
                    },
                ],
            },
        };
        const chart = { id: 'c1', index: 'a0', x: 0, y: 0, width: 400, height: 300, spec: JSON.stringify(spec) };
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
        const data = parseChartSpec(copied.spec)?.data;
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
});
