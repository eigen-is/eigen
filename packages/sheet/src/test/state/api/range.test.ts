import { describe, expect, test } from 'bun:test';
import { setSelection } from '../../../state/api/range';
import type { Context } from '../../../state/context';
import { getRangetxt } from '../../../state/modules/cell';
import { contextFactory, selectionFactory } from '../factories/context';

describe('sheet/core/api/range', () => {
    const getContext = () =>
        contextFactory({
            selections: selectionFactory([0, 0], [0, 0], 0, 0),
        }) as Context;

    test('setSelection', () => {
        const ctx = getContext();
        setSelection(ctx, [
            { row: [0, 0], column: [0, 1] },
            { row: [2, 3], column: [2, 3] },
        ]);
        expect(ctx.selections?.[0]).toMatchObject({ row: [0, 0], column: [0, 1] });
        expect(ctx.selections?.[1]).toMatchObject({ row: [2, 3], column: [2, 3] });
        expect(ctx.sheets[0].selections).toEqual(ctx.selections);
    });

    test('setSelection backfills a single-element range end (name box reads A1, not A1:NaN)', () => {
        const ctx = getContext();
        // The initial-load seed passes a single-element range `[0]`; the normalizer
        // must backfill the missing end so the range text is "A1", never "A1:NaN".
        setSelection(ctx, [{ row: [0], column: [0] }]);
        const [selection] = ctx.selections ?? [];
        expect(getRangetxt(ctx, ctx.currentSheetId, selection)).toBe('A1');
    });
});
