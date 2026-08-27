import { describe, expect, it } from 'bun:test';
import type { Context } from '../../../index';
import { getComputeMap } from '../../../state/modules/condition-format';
import { contextFactory } from '../factories/context';

function ctxWithRules(): Context {
    const ctx = contextFactory() as Context;
    for (const sheet of ctx.sheets) {
        sheet.conditionalFormatRules = [
            {
                type: 'default',
                cellrange: [{ row: [0, 3], column: [0, 3] }],
                format: { cellColor: '#ff0000' },
                conditionName: 'greaterThan',
                conditionRange: [],
                conditionValue: ['0'],
            },
        ];
    }
    return ctx;
}

describe('state/condition-format — getComputeMap cache', () => {
    it('keeps a sheet computed across a visit to another sheet', () => {
        // One cache slot made every A→B→A tab switch a guaranteed miss. On a sheet
        // carrying formula rules that recompute costs seconds, which is what made
        // reopening a tab as slow as opening it the first time.
        const ctx = ctxWithRules();

        const first = getComputeMap(ctx);
        ctx.currentSheetId = 'id_2';
        getComputeMap(ctx);
        ctx.currentSheetId = 'id_1';

        expect(getComputeMap(ctx)).toBe(first);
    });

    it('recomputes when the sheet data is replaced', () => {
        // immer replaces `data` by reference on any edit, so reference equality on it
        // is the whole invalidation contract — dropping it from the key serves stale styles.
        const ctx = ctxWithRules();

        const first = getComputeMap(ctx);
        ctx.sheets[0].data = ctx.sheets[0].data!.map((row) => [...row]);

        expect(getComputeMap(ctx)).not.toBe(first);
    });

    it('recomputes when the rules are replaced', () => {
        const ctx = ctxWithRules();

        const first = getComputeMap(ctx);
        ctx.sheets[0].conditionalFormatRules = [...ctx.sheets[0].conditionalFormatRules!];

        expect(getComputeMap(ctx)).not.toBe(first);
    });
});
