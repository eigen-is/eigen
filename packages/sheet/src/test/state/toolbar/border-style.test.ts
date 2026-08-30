import { describe, expect, test } from 'bun:test';
import type { Context } from '../../../state/context';
import { getBorderInfoCompute } from '../../../state/modules/border';
import { handleBorder } from '../../../state/modules/toolbar';
import { contextFactory } from '../factories/context';

describe('sheet/core/toolbar/border-style', () => {
    // border-slash is a per-cell diagonal: every cell of every selected range gets
    // its own `s` side — not range[0]'s cells repeatedly.
    test('border-slash stamps every cell of each selected range', () => {
        const ctx = contextFactory({
            config: { borderInfo: {} },
            selections: [
                { row: [0, 0], column: [0, 1], row_focus: 0, column_focus: 0 },
                { row: [2, 2], column: [2, 2], row_focus: 2, column_focus: 2 },
            ],
        }) as Context;

        handleBorder(ctx, 'border-slash', '#000000', '1');
        const map = getBorderInfoCompute(ctx);

        expect(map['0_0']?.s).toEqual({ style: 1, color: '#000000' });
        expect(map['0_1']?.s).toEqual({ style: 1, color: '#000000' });
        expect(map['2_2']?.s).toEqual({ style: 1, color: '#000000' });
        expect(Object.keys(map)).toHaveLength(3);
    });
});
