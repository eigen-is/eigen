import { describe, expect, it } from 'bun:test';
import type { Context } from '../../index';
import { handleCut } from '../../state/events/copy';
import { contextFactory } from './factories/context';

describe('handleCut', () => {
    it('marks the copy range as cut and populates copy data', () => {
        const ctx = contextFactory({
            sheets: [
                {
                    name: 'sheet',
                    id: 'id_1',
                    data: [
                        [null, { m: 'A', v: 'A' }, null, null],
                        [null, null, null, null],
                        [null, null, null, null],
                        [null, null, null, null],
                    ],
                    order: 0,
                },
            ],
        }) as Context;
        handleCut(ctx);

        expect(ctx.copyState?.cut).toBe(true);
        expect(ctx.formulaRangeSelections).toHaveLength(1);
        expect(ctx.copyState?.dataSheetId).toBe('id_1');
    });

    it('makes no copy when the selection is empty', () => {
        const ctx = contextFactory({
            selections: [],
        }) as Context;
        handleCut(ctx);

        expect(ctx.copyState).toBeUndefined();
    });
});
