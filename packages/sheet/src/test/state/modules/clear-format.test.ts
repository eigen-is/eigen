// handleClearFormat has to drop the border entries inside the cleared rect from the sheet's
// config — the renderer reads them back from there (border.ts getBorderInfoComputeRange),
// and anything left behind is re-emitted to peers as real data. Driving the handler through
// produceWithPatches is what exposes a write that never lands.

import { describe, expect, test } from 'bun:test';
import { enablePatches, produceWithPatches } from 'immer';
import type { Context } from '../../../state/context';
import { handleClearFormat } from '../../../state/modules/toolbar';
import type { Cell, SheetConfig } from '../../../state/types';
import { contextFactory } from '../factories/context';

enablePatches();

// The cleared rect: rows 0-1, columns 0-1.
const CLEAR_RECT = { row: [0, 1], column: [0, 1], row_focus: 0, column_focus: 0 };

const SIDE = { style: 1, color: '#000' };

const styled = (): Cell => ({ v: 1, m: '1', ct: { fa: 'General', t: 'n' }, bg: '#ff0000', bl: 1 });

function clearFormatContext(): Context {
    const config: SheetConfig = {
        borderInfo: {
            '1_1': { l: SIDE },
            '3_3': { l: SIDE },
            '0_0': { l: SIDE, r: SIDE, t: SIDE, b: SIDE },
            '2_0': { l: SIDE, r: SIDE, t: SIDE, b: SIDE },
        },
    };
    const ctx = contextFactory({ config, selections: [CLEAR_RECT] }) as Context;
    ctx.sheets[0].data = [
        [styled(), styled(), null, null],
        [styled(), styled(), null, null],
        [null, null, null, null],
        [null, null, null, styled()],
    ];
    return ctx;
}

describe('handleClearFormat clears borders on the sheet config', () => {
    test('drops the borders inside the rect, keeps the ones outside it', () => {
        const [cleared] = produceWithPatches(clearFormatContext(), (ctx: Context) => {
            handleClearFormat(ctx);
        });

        expect(Object.keys(cleared.sheets[0].config!.borderInfo!).sort()).toEqual(['2_0', '3_3']);
    });
});
