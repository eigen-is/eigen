import { describe, expect, test } from 'bun:test';
import { clearCell, getCellValue, setCellFormat, setCellValue } from '../../../state/api/cell';
import type { Context } from '../../../state/context';
import { updateCell } from '../../../state/modules/cell';
import { groupValuesRefresh, warmFormulaCellInfoMap } from '../../../state/modules/formula-exec';
import type { Cell } from '../../../state/types';
import { contextFactory, selectionFactory } from '../factories/context';

// Mock DOM for tests. globalThis is intentionally widened — Bun's test runtime
// has no DOM by default and these mocks are scoped to this test file.
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
(globalThis as any).document = {
    createElement: (_tag: string) => ({
        innerHTML: '',
        style: {},
        setAttribute: () => {},
        getAttribute: () => null,
    }),
};

describe('sheet/core/api/cell', () => {
    const getContext = () =>
        contextFactory({
            selections: selectionFactory([0, 0], [0, 0], 0, 0),
            sheets: [
                {
                    id: 'id_1',
                    name: 'Sheet1',
                    data: [
                        [null, null],
                        [
                            { m: '5', v: '5', f: '=SUM(A1:B1)' },
                            { m: '5', v: '5', it: 1, fc: '#ff0' },
                        ],
                    ],
                },
                {
                    id: 'id_2',
                    name: 'Sheet2',
                    data: [
                        [null, null],
                        [null, { m: '4', v: '4', bl: 0, bg: '#ff0' }],
                    ],
                },
            ],
        }) as Context;

    test('getCellValue', async () => {
        const ctx = getContext();
        [
            { v: '5' },
            { t: 'v', v: '5' },
            { id: 'id_2', v: '4' },
            { id: 'id_2', t: 'v', v: '4' },
            { id: 'id_1', t: 'it', v: 1 },
            { id: 'id_1', t: 'fc', v: '#ff0' },
            { id: 'id_2', t: 'bl', v: 0 },
            { id: 'id_2', t: 'bg', v: '#ff0' },
        ].forEach((k) => {
            expect(getCellValue(ctx, 1, 1, { id: k.id, type: k.t as keyof Cell })).toBe(k.v);
        });
    });

    test('setCellValue', async () => {
        const ctx = getContext();
        const cellInput = document.createElement('div');
        [
            { v: 6, rs: 6, id: 'id_1' },
            { v: 66, rs: 66, id: 'id_2' },
        ].forEach((item) => {
            setCellValue(ctx, 1, 1, item.v, cellInput, { id: item.id });
            expect(getCellValue(ctx, 1, 1, { id: item.id, type: 'v' })).toBe(item.rs);
        });
    });

    test('setCellValue over a formula replaces it with the typed-entry value', () => {
        const ctx = getContext();
        ctx.sheets[0].data![0][0] = { v: 5, m: '5' };
        ctx.sheets[0].calcChain = [{ r: 1, c: 0, id: 'id_1' }];
        warmFormulaCellInfoMap(ctx);

        setCellValue(ctx, 1, 0, '123', null, { id: 'id_1' });
        expect(ctx.sheets[0].data![1][0]).toMatchObject({ v: 123, m: '123' });
        expect(ctx.sheets[0].data![1][0]?.f).toBeUndefined();

        updateCell(ctx, 0, 0, null, '7');
        groupValuesRefresh(ctx);
        expect(ctx.sheets[0].data![1][0]?.v).toBe(123);
    });

    // B2 = SUM(A1:B1): overwritten, it must not recompute when A1 changes.
    const overFormula = (write: (ctx: Context) => void) => {
        const ctx = getContext();
        ctx.sheets[0].data![0][0] = { v: 5, m: '5' };
        ctx.sheets[0].calcChain = [{ r: 1, c: 0, id: 'id_1' }];
        warmFormulaCellInfoMap(ctx);
        write(ctx);
        updateCell(ctx, 0, 0, null, '7');
        groupValuesRefresh(ctx);
        return ctx.sheets[0].data![1][0];
    };

    test('setCellValue with a cell object over a formula drops it from the map', () => {
        const cell = overFormula((ctx) => setCellValue(ctx, 1, 0, { v: 'x' }, null, { id: 'id_1' }));
        expect(cell?.f).toBeUndefined();
        expect(cell?.v).toBe('x');
    });

    test('setCellValue with null over a formula drops it from the map', () => {
        const cell = overFormula((ctx) => setCellValue(ctx, 1, 0, null, null, { id: 'id_1' }));
        expect(cell?.f).toBeUndefined();
        expect(cell?.v).toBeUndefined();
    });

    test('clearCell over a formula drops it from the map', () => {
        const cell = overFormula((ctx) => clearCell(ctx, 1, 0, { id: 'id_1' }));
        expect(cell?.f).toBeUndefined();
        expect(cell?.v).toBeUndefined();
    });

    test('clearCell', async () => {
        const ctx = getContext();
        clearCell(ctx, 1, 0, { id: 'id_1' });
        expect(ctx.sheets[0]?.data?.[1]?.[0]).toEqual({});
    });

    test('setCellFormat', async () => {
        const ctx = getContext();
        setCellFormat(ctx, 0, 0, 'bl', 1, { id: 'id_1' });
        setCellFormat(ctx, 0, 0, 'bg', '#ff0', { id: 'id_1' });
        setCellFormat(ctx, 0, 0, 'ct', { fa: 'General', t: 'n' }, { id: 'id_1' });
        expect(ctx.sheets[0]?.data?.[0]?.[0]).toEqual({
            bg: '#ff0',
            bl: 1,
            ct: { fa: 'General', t: 'n' },
        });
    });

    test('setCellFormat renders the display the way every cell writer does', () => {
        const ctx = getContext();
        ctx.sheets[0].data![0][0] = { v: 1234.5 };
        ctx.sheets[0].data![0][1] = { v: Infinity };
        setCellFormat(ctx, 0, 0, 'ct', { fa: '#,##0;;;;;', t: 'n' }, { id: 'id_1' });
        setCellFormat(ctx, 0, 1, 'ct', { fa: '0.00', t: 'n' }, { id: 'id_1' });
        expect(ctx.sheets[0].data![0][0]?.m).toBe('1234.5');
        expect(ctx.sheets[0].data![0][1]?.m).toBe('Infinity');
    });
});
