// handleClearFormat has to drop the cell-type border entries inside the cleared rect from
// the sheet's config — the renderer reads them back from there (border.ts
// getBorderInfoComputeRange), and anything left behind is re-emitted to peers as real data.
// Driving the handler through produceWithPatches is what exposes a write that never lands.

import { describe, expect, test } from 'bun:test';
import { enablePatches, produceWithPatches } from 'immer';
import type { Context } from '../../../state/context';
import { handleClearFormat } from '../../../state/modules/toolbar';
import type { BorderInfo, Cell, SheetConfig } from '../../../state/types';
import { contextFactory } from '../factories/context';

enablePatches();

// The cleared rect: rows 0-1, columns 0-1.
const CLEAR_RECT = { row: [0, 1], column: [0, 1], row_focus: 0, column_focus: 0 };

const insideCell: BorderInfo = {
    rangeType: 'cell',
    value: { row_index: 1, col_index: 1, l: { style: 1, color: '#000' }, r: null, t: null, b: null },
};
const outsideCell: BorderInfo = {
    rangeType: 'cell',
    value: { row_index: 3, col_index: 3, l: { style: 1, color: '#000' }, r: null, t: null, b: null },
};
const spanningRange: BorderInfo = {
    rangeType: 'range',
    borderType: 'border-all',
    color: '#000',
    style: '1',
    range: [{ row: [0, 3], column: [0, 0] }],
};

const styled = (): Cell => ({ v: 1, m: '1', ct: { fa: 'General', t: 'n' }, bg: '#ff0000', bl: 1 });

function clearFormatContext(): Context {
    const config: SheetConfig = { borderInfo: [insideCell, outsideCell, spanningRange] };
    const ctx = contextFactory({ config, selections: [CLEAR_RECT] }) as Context;
    ctx.sheets[0].data = [
        [styled(), styled(), null, null],
        [styled(), styled(), null, null],
        [null, null, null, null],
        [null, null, null, styled()],
    ];
    return ctx;
}

// The cell-type entries a config still carries, as `row_col` keys.
function borderedCells(config: SheetConfig | undefined) {
    return (config?.borderInfo ?? [])
        .filter((entry) => entry.rangeType === 'cell')
        .map((entry) => `${entry.value.row_index}_${entry.value.col_index}`);
}

describe('handleClearFormat clears borders on the sheet config', () => {
    test('drops the cell-type border inside the rect, keeps the one outside it', () => {
        const [cleared] = produceWithPatches(clearFormatContext(), (ctx: Context) => {
            handleClearFormat(ctx);
        });

        expect(borderedCells(cleared.sheets[0].config)).toEqual(['3_3']);
    });
});
