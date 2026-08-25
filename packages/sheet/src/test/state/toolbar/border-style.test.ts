import { describe, expect, test } from 'bun:test';
import type { Context } from '../../../state/context';
import { getBorderInfoCompute } from '../../../state/modules/border';
import { contextFactory } from '../factories/context';

describe('sheet/core/toolbar/border-style', () => {
    // border-slash is a per-range diagonal: each selected range stamps the `s`
    // side on its own focus cell. With multiple ranges every range's focus must
    // be stamped — not range[0]'s repeatedly.
    test('border-slash stamps each selected range focus cell', () => {
        const ctx = contextFactory({
            config: {
                borderInfo: [
                    {
                        rangeType: 'range',
                        borderType: 'border-slash',
                        color: '#000000',
                        style: 1,
                        range: [
                            { row: [0, 0], column: [0, 0], row_focus: 0, column_focus: 0 },
                            { row: [2, 2], column: [2, 2], row_focus: 2, column_focus: 2 },
                        ],
                    },
                ],
            },
        }) as Context;

        const map = getBorderInfoCompute(ctx);

        expect(map['0_0']?.s).toBeDefined();
        expect(map['2_2']?.s).toBeDefined();
    });
});
