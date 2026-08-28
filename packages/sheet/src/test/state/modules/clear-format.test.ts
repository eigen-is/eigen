// `ctx.config` is a derived mirror of `ctx.sheets[current].config`, and inside an immer
// recipe the two are independent drafts even when the base holds one shared object.
// handleClearFormat trimmed the border entries on the mirror but wrote the filtered array
// to the sheet only, so a cell-type border inside the cleared rect stayed in the mirror —
// the renderer reads the mirror (border.ts getBorderInfoComputeRange), so it kept painting,
// and the next mirror-authoritative flush (storeSheetParamALL after a cut/paste, the format
// painter, clearFilter, changeSheet) wrote it back as real data and emitted it to peers.
// Driving the handler through produceWithPatches is what exposes this: a plain non-draft
// context keeps the alias, so both halves move together no matter what the code writes.

import { describe, expect, test } from 'bun:test';
import { enablePatches, produce, produceWithPatches } from 'immer';
import type { Context } from '../../../state/context';
import { storeSheetParamALL } from '../../../state/modules/sheet';
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

describe('handleClearFormat clears borders on both halves of the config mirror', () => {
    test('drops the cell-type border inside the rect from the mirror as well as the sheet', () => {
        const [cleared] = produceWithPatches(clearFormatContext(), (ctx: Context) => {
            handleClearFormat(ctx);
        });

        expect(borderedCells(cleared.sheets[0].config)).toEqual(['3_3']);
        expect(borderedCells(cleared.config)).toEqual(['3_3']);
        expect(cleared.config.borderInfo).toEqual(cleared.sheets[0].config?.borderInfo ?? []);
    });

    test('a later mirror-authoritative flush does not resurrect the cleared border', () => {
        const [cleared] = produceWithPatches(clearFormatContext(), (ctx: Context) => {
            handleClearFormat(ctx);
        });

        // storeSheetParamALL — reached after a cut/paste, the format painter, clearFilter
        // and every sheet switch — writes the mirror back over the sheet authoritatively.
        const flushed = produce(cleared, (ctx: Context) => {
            storeSheetParamALL(ctx);
        });

        expect(borderedCells(flushed.sheets[0].config)).toEqual(['3_3']);
    });
});
