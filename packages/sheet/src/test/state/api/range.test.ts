import { describe, expect, test } from 'bun:test';
import {
    getCellsByFlattenRange,
    getCellsByRange,
    getFlattenRange,
    getHtmlByRange,
    getSelection,
    getSelectionCoordinates,
    setCellFormatByRange,
    setCellValuesByRange,
    setSelection,
} from '../../../state/api/range';
import type { Context } from '../../../state/context';
import { contextFactory, selectionFactory } from '../factories/context';

describe('sheet/core/api/range', () => {
    const getContext = () =>
        contextFactory({
            selections: selectionFactory([0, 0], [0, 0], 0, 0),
        }) as Context;

    test('getSelection', async () => {
        const ctx = getContext();
        ctx.selections = [
            {
                row: [0, 0],
                column: [0, 1],
                row_focus: 0,
                column_focus: 0,
            },
            {
                row: [2, 3],
                column: [2, 3],
                row_focus: 2,
                column_focus: 2,
            },
        ];
        expect(getSelection(ctx)).toEqual([
            { row: [0, 0], column: [0, 1] },
            { row: [2, 3], column: [2, 3] },
        ]);
    });

    test('getFlattenRange', async () => {
        const ctx = getContext();
        const result = getFlattenRange(ctx, [
            { row: [0, 0], column: [0, 1] },
            { row: [2, 3], column: [2, 3] },
        ]);
        expect(result.length).toBe(6);
    });

    test('getCellsByFlattenRange', async () => {
        const ctx = getContext();
        if (ctx.sheets[0]?.data) {
            ctx.sheets[0].data = [
                [{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }],
                [{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }],
                [{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }],
                [{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }],
            ];
        }
        const range = getFlattenRange(ctx, [
            { row: [0, 0], column: [0, 1] },
            { row: [2, 3], column: [2, 3] },
        ]);
        const result = getCellsByFlattenRange(ctx, range);
        expect(result).toEqual([{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }, { v: 3 }, { v: 4 }]);
    });

    test('getSelectionCoordinates', async () => {
        const ctx = getContext();
        ctx.selections = [
            { row: [0, 0], column: [0, 1] },
            { row: [2, 3], column: [2, 3] },
        ];
        const result = getSelectionCoordinates(ctx);
        expect(result).toEqual(['A1:B1', 'C3:D4']);
    });

    test('getCellsByRange', async () => {
        const ctx = getContext();
        if (ctx.sheets[0]?.data?.[0]) {
            ctx.sheets[0].data[0][0] = { v: 66 };
        }
        expect(getCellsByRange(ctx, { row: [0, 0], column: [0, 0] })).toEqual([[{ v: 66 }]]);
    });

    test('getHtmlByRange', async () => {
        const ctx = getContext();
        expect(getHtmlByRange(ctx, [{ row: [0, 0], column: [0, 0] }])).toBe(
            '<table data-type="sheet-copy-action-table"><colgroup width="72px"></colgroup><tr><td  style="height:19px;"></td></tr></table>',
        );
    });

    test('setSelection', async () => {
        const ctx = getContext();
        setSelection(
            ctx,
            [
                { row: [0, 0], column: [0, 1] },
                { row: [2, 3], column: [2, 3] },
            ],
            {},
        );
        if (ctx.selections) {
            expect(ctx.selections[0]).toMatchObject({
                row: [0, 0],
                column: [0, 1],
            });
            expect(ctx.selections[1]).toMatchObject({
                row: [2, 3],
                column: [2, 3],
            });
        }
    });

    test('setSelection backfills a single-element range end (name box reads A1, not A1:NaN)', async () => {
        const ctx = getContext();
        // The initial-load seed passes a single-element range `[0]`; the normalizer
        // must backfill the missing end so the range text is "A1", never "A1:NaN".
        setSelection(ctx, [{ row: [0], column: [0] }], {});
        expect(getSelectionCoordinates(ctx)).toEqual(['A1']);
    });

    test('setCellValuesByRange', async () => {
        const ctx = getContext();
        const expectedData = [
            [2, 3],
            [5, 7],
        ];
        setCellValuesByRange(ctx, expectedData, { row: [1, 2], column: [1, 2] }, null, { id: 'id_2' });
        expect(ctx.sheets[1]?.data?.[2]?.[2]?.v).toBe(7);
        expect(ctx.sheets[1]?.data?.[1]?.[2]?.v).toBe(3);
    });

    test('setCellFormatByRange', async () => {
        const ctx = getContext();
        setCellFormatByRange(ctx, 'bg', '#f00', { row: [1, 2], column: [1, 2] }, { id: 'id_2' });
        expect(ctx.sheets[1]?.data?.[2]?.[2]).toEqual({ bg: '#f00' });
        expect(ctx.sheets[1]?.data?.[2]?.[1]).toEqual({ bg: '#f00' });
    });
});
