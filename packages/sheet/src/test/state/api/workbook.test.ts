import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { addSheet, setSheetOrder } from '../../../state/api/workbook';
import type { Context } from '../../../state/context';
import { contextFactory, selectionFactory } from '../factories/context';

const NEW_ID = '00000000-0000-4000-8000-000000000003';

afterEach(() => {
    mock.restore();
});

describe('sheet/core/api/workbook', () => {
    const getContext = () =>
        contextFactory({
            selections: selectionFactory([0, 0], [0, 0], 0, 0),
        }) as Context;

    test('addSheet', () => {
        const ctx = getContext();
        spyOn(crypto, 'randomUUID').mockReturnValue(NEW_ID);
        addSheet(ctx);
        expect(ctx.sheets.length).toBe(3);
        expect(ctx.sheets[2].id).toBe(NEW_ID);
    });

    test('setSheetOrder', () => {
        const ctx = getContext();
        setSheetOrder(ctx, { id_1: 2, id_2: 1 });
        expect(ctx.sheets[0].order).toBe(1);
        expect(ctx.sheets[1].order).toBe(0);
        setSheetOrder(ctx, { id_1: 1, id_2: 2 });
        expect(ctx.sheets[0].order).toBe(0);
        expect(ctx.sheets[1].order).toBe(1);
    });
});
