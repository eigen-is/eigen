import { describe, expect, test } from 'bun:test';
import { setCellFormat } from '../../../state/api/cell';
import type { Context } from '../../../state/context';
import { contextFactory, selectionFactory } from '../factories/context';

describe('sheet/core/api/cell', () => {
    const getContext = () =>
        contextFactory({
            selections: selectionFactory([0, 0], [0, 0], 0, 0),
            sheets: [
                { id: 'id_1', name: 'Sheet1', data: [[null, { v: '5', m: '5' }]] },
                { id: 'id_2', name: 'Sheet2', data: [[null, null]] },
            ],
        }) as Context;

    test('setCellFormat writes the attribute on the sheet the id names, or the current one', () => {
        const ctx = getContext();
        setCellFormat(ctx, 0, 0, 'bl', 1);
        setCellFormat(ctx, 0, 0, 'bg', '#ff0');
        setCellFormat(ctx, 0, 1, 'commentCardIds', ['c1'], { id: 'id_2' });
        expect(ctx.sheets[0].data?.[0]?.[0]).toEqual({ bl: 1, bg: '#ff0' });
        expect(ctx.sheets[1].data?.[0]?.[1]).toEqual({ commentCardIds: ['c1'] });
    });

    test('setCellFormat keeps the rest of the cell', () => {
        const ctx = getContext();
        setCellFormat(ctx, 0, 1, 'bl', 1);
        expect(ctx.sheets[0].data?.[0]?.[1]).toEqual({ v: '5', m: '5', bl: 1 });
    });
});
