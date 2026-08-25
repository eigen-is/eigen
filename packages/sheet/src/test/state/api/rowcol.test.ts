import { describe, expect, test } from 'bun:test';
import { range } from 'es-toolkit/compat';
import {
    deleteRowOrColumn,
    freeze,
    getColumnWidth,
    getRowHeight,
    insertRowOrColumn,
    setColumnWidth,
    setRowHeight,
} from '../../../state/api/rowcol';
import type { Context } from '../../../state/context';
import type { Cell } from '../../../state/types';
import { contextFactory, selectionFactory } from '../factories/context';

describe('sheet/core/api/rowcol', () => {
    const getContext = () =>
        contextFactory({
            selections: selectionFactory([0, 0], [0, 0], 0, 0),
        }) as Context;

    test('freeze', () => {
        [
            { t: 'both', rs: 'rangeBoth' },
            { t: 'row', rs: 'rangeRow' },
            { t: 'column', rs: 'rangeColumn' },
        ].forEach((item) => {
            const ctx = getContext();
            freeze(ctx, item.t as 'both' | 'row' | 'column', { row: 2, column: 2 }, { id: 'id_2' });
            expect(ctx.sheets[1]?.frozen?.range).toEqual({
                column_focus: 2,
                row_focus: 2,
            });
            expect(ctx.sheets[1]?.frozen?.type).toBe(item.rs as 'both' | 'row' | 'column');
        });
    });

    test('insertRowOrColumn', () => {
        const cellTmpl = { ct: { fa: 'General', t: 'g' }, v: 0, m: '0' };
        const emptyTmpl = null;
        [
            { t: 'row', i: 1, c: 1, d: 'lefttop' },
            { t: 'row', i: 1, c: 2, d: 'lefttop' },
            { t: 'row', i: 2, c: 3, d: 'rightbottom' },
            { t: 'row', i: 3, c: 3, d: 'rightbottom' },
            { t: 'column', i: 1, c: 1, d: 'lefttop' },
            { t: 'column', i: 2, c: 3, d: 'rightbottom' },
        ].forEach((k) => {
            const ctx = getContext();
            if (k.t === 'row') {
                if (ctx.sheets[0]?.data?.[k.i]) {
                    ctx.sheets[0].data[k.i] = [cellTmpl, null, cellTmpl, null];
                }
            } else {
                if (ctx.sheets[0]?.data?.[0]?.[k.i]) {
                    ctx.sheets[0].data[0][k.i] = cellTmpl;
                }
                if (ctx.sheets[0]?.data?.[2]?.[k.i]) {
                    ctx.sheets[0].data[2][k.i] = cellTmpl;
                }
            }
            ctx.defaultCell = { v: 'inserted' };
            insertRowOrColumn(ctx, k.t as 'row' | 'column', k.i, k.c, k.d as 'lefttop' | 'rightbottom', { id: 'id_1' });
            for (let i = 0; i < k.c; i += 1) {
                for (let j = 0; j < 4; j += 1) {
                    let l = 0;
                    if (k.d === 'rightbottom') {
                        l += 1;
                    }
                    const receivedValue =
                        k.t === 'row'
                            ? ctx.sheets[0]?.data?.[k.i + i + l]?.[j]
                            : ctx.sheets[0]?.data?.[j]?.[k.i + i + l];
                    expect(receivedValue).toEqual([0, 2].includes(j) ? emptyTmpl : null);
                }
            }
        });
    });

    test('deleteRowOrColumn', () => {
        const ctx = getContext();
        const rawDataFirst = () => [
            [{ v: 66 }, { v: 12 }, { v: 18 }, { v: 92 }, { v: 45 }],
            [{ v: 67 }, { v: 13 }, { v: 19 }, { v: 2 }, { v: 45 }],
            [{ v: 68 }, { v: 14 }, { v: 11 }, { v: 9 }, { v: 45 }],
            [{ v: 69 }, { v: 15 }, { v: 12 }, { v: 1 }, { v: 45 }],
            [{ v: 69 }, { v: 15 }, { v: 12 }, { v: 1 }, { v: 45 }],
        ];
        const rawDataSecond = () => [
            [{ v: 66 }, { v: 12 }],
            [{ v: 67 }, { v: 13 }],
            [{ v: 68 }, { v: 14 }],
            [{ v: 69 }, { v: 15 }],
        ];
        [
            { type: 'row', start: 0, end: 0, rawData: rawDataFirst },
            { type: 'row', start: 1, end: 2, rawData: rawDataFirst },
            { type: 'row', start: 0, end: 3, rawData: rawDataFirst },
            { type: 'column', start: 1, end: 3, rawData: rawDataFirst },
            { type: 'column', start: 1, end: 1, rawData: rawDataFirst },
            { type: 'row', start: 1, end: 3, rawData: rawDataSecond },
            { type: 'column', start: 1, end: 1, rawData: rawDataSecond },
        ].forEach((k) => {
            if (ctx.sheets[0]) {
                ctx.sheets[0].data = k.rawData();
            }
            const slen = k.end - k.start + 1;
            deleteRowOrColumn(ctx, k.type as 'row' | 'column', k.start, k.end);
            range(0, k.rawData().length - slen).forEach((i) => {
                range(0, k.rawData()[0].length - slen).forEach((j) => {
                    let expectedValue: () => Cell | null;
                    if (k.type === 'row') {
                        expectedValue = () => {
                            if (i < k.start) return k.rawData()[i][j];
                            if (i >= k.start && i <= k.start + k.rawData().length - 2 - k.end)
                                return k.rawData()[i + k.end - k.start + 1][j];
                            return null;
                        };
                    } else {
                        expectedValue = () => {
                            if (j < k.start) return k.rawData()[i][j];
                            if (j >= k.start && j <= k.start + k.rawData()[0].length - 2 - k.end)
                                return k.rawData()[i][j + k.end - k.start + 1];
                            return null;
                        };
                    }
                    expect(ctx.sheets[0]?.data?.[i]?.[j]).toEqual(expectedValue());
                });
            });
        });
    });

    test('setRowHeight', () => {
        const ctx = getContext();
        setRowHeight(ctx, { 2: 50 });
        setRowHeight(ctx, { 3: 100 }, { id: 'id_1' });
        expect(ctx.config.rowlen).toEqual({ 3: 100, 2: 50 });
    });

    test('setColumnWidth', () => {
        const ctx = getContext();
        setColumnWidth(ctx, { 2: 50 });
        setColumnWidth(ctx, { 3: 100 }, { id: 'id_1' });
        expect(ctx.config.columnlen).toEqual({ 3: 100, 2: 50 });
    });

    test('getRowHeight', () => {
        const ctx = getContext();
        setRowHeight(ctx, { 2: 50 });
        setRowHeight(ctx, { 3: 99 });
        setRowHeight(ctx, { 2: 100 }, { id: 'id_2' });
        setRowHeight(ctx, { 3: 100 }, { id: 'id_2' });
        expect(getRowHeight(ctx, [2, 3])).toEqual({ 3: 99, 2: 50 });
        expect(getRowHeight(ctx, [2, 3], { id: 'id_2' })).toEqual({
            3: 100,
            2: 100,
        });
    });

    test('getColumnWidth', () => {
        const ctx = getContext();
        setColumnWidth(ctx, { 2: 50 });
        setColumnWidth(ctx, { 3: 99 });
        setColumnWidth(ctx, { 2: 100 }, { id: 'id_2' });
        setColumnWidth(ctx, { 3: 100 }, { id: 'id_2' });
        expect(getColumnWidth(ctx, [2, 3])).toEqual({ 3: 99, 2: 50 });
        expect(getColumnWidth(ctx, [2, 3], { id: 'id_2' })).toEqual({
            3: 100,
            2: 100,
        });
    });
});
