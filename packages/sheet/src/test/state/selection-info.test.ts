import { describe, expect, it } from 'bun:test';
import type { Context } from '../../index';
import { calcSelectionInfo } from '../../state/modules/selection';
import { contextFactory, selectionFactory } from './factories/context';

// Currency/accounting cells store the raw number in `v`; `m` is the formatted
// display string ("€ 1,234.50", "$ (200.00)") that parseFloat cannot read.
function fixture(): Context {
    return contextFactory({
        selections: selectionFactory([0, 0], [0, 4], 0, 0),
        sheets: [
            {
                name: 'sheet',
                id: 'id_1',
                order: 0,
                data: [
                    [
                        { v: 1234.5, m: '€ 1,234.50', ct: { fa: '€ #,##0.00', t: 'n' } },
                        { v: -200, m: '$ (200.00)', ct: { fa: '_($* #,##0.00_);_($* (#,##0.00)', t: 'n' } },
                        { v: 42, m: '42', ct: { fa: 'General', t: 'g' } },
                        { v: 'label', m: 'label', ct: { fa: 'General', t: 'g' } },
                        // formatting an empty cell stores ct.t 'n' with a nil v (setAttr);
                        // it must not enter the numeric aggregates as a phantom 0
                        { v: undefined, m: '', ct: { fa: '€ #,##0.00', t: 'n' } },
                    ],
                ],
            },
        ],
    }) as Context;
}

describe('calcSelectionInfo', () => {
    it('computes stats for currency/accounting cells from the raw v, never the display string', () => {
        expect(calcSelectionInfo(fixture())).toEqual({
            numberC: 3,
            count: 5,
            sum: '1076.50',
            max: '1234.50',
            min: '-200.00',
            average: '358.83',
        });
    });
});
