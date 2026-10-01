import { describe, expect, test } from 'bun:test';
import { addSheet, setSheetOrder } from '../../../state/api/workbook';
import type { Context } from '../../../state/context';
import { contextFactory, selectionFactory } from '../factories/context';

describe('sheet/core/api/workbook', () => {
    const getContext = () =>
        contextFactory({
            selections: selectionFactory([0, 0], [0, 0], 0, 0),
        }) as Context;

    test('addSheet', () => {
        const ctx = getContext();
        // Settings is Required<…> for the runtime call, but every other field has
        // a default in the addSheet implementation — only the four exercised here
        // matter for this assertion. biome-ignore: Partial<Settings> would require
        // touching the source-of-truth Settings type, out of scope for this test.
        // biome-ignore lint/suspicious/noExplicitAny: test fixture covers happy path
        const settings: any = {
            allowEdit: true,
            row: 60,
            column: 84,
            generateSheetId: () => 'id_3',
        };
        addSheet(ctx, settings);
        expect(ctx.sheets.length).toBe(3);
        expect(ctx.sheets[2].id).toBe('id_3');
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
