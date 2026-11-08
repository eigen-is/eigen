// Drag-moving a selection carries the source cells' borders with them and, like every
// other carry path (paste, fill, format painter), clears the destination's own borders
// where the source has none.

import { describe, expect, test } from 'bun:test';
import type { Context } from '../../../state/context';
import { onCellsMoveEnd } from '../../../state/modules/move-cells';
import type { Cell, GlobalCache } from '../../../state/types';
import { contextFactory } from '../factories/context';
import { gridElements, withGridGeometry } from '../factories/grid-dom';

const SIDE = { style: 1, color: '#000' };

function grid(): (Cell | null)[][] {
    return Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => null));
}

// Drops the single selected cell at (0,0) onto (2,0); the grid factory's header offsets put
// clientX 50 / clientY 70 inside that cell.
function moveTopLeftToRowTwo(
    seed: (data: (Cell | null)[][]) => void,
    config: Context['sheets'][0]['config'],
    hyperlink?: Context['sheets'][0]['hyperlink'],
    column = [0, 0],
) {
    const data = grid();
    seed(data);
    const ctx = withGridGeometry(
        contextFactory({
            sheets: [{ name: 'sheet', id: 'id_1', order: 0, data, config, hyperlink }],
            selections: [{ row: [0, 0], column, row_focus: 0, column_focus: 0 }],
            visibledatarow: [20, 40, 60, 80, 100, 120],
            visibledatacolumn: [74, 148, 222, 296, 370, 444],
        }) as Context,
    );
    ctx.cellSelectMoving = true;
    ctx.cellSelectMoveIndex = [0, 0];
    const { container, scrollEl } = gridElements();
    const event = { clientX: 50, clientY: 70 } as MouseEvent;
    onCellsMoveEnd(ctx, {} as GlobalCache, event, scrollEl, container);
    return ctx;
}

describe('onCellsMoveEnd carries borders', () => {
    test('a bordered source lands its sides on the destination and leaves none behind', () => {
        const ctx = moveTopLeftToRowTwo(
            (data) => {
                data[0][0] = { v: 1, m: '1' };
            },
            { borderInfo: { '0_0': { l: SIDE, t: SIDE } } },
        );
        expect(ctx.sheets[0].data![2][0]).toEqual({ v: 1, m: '1' });
        expect(ctx.sheets[0].config!.borderInfo).toEqual({ '2_0': { l: SIDE, t: SIDE } });
    });

    test('a plain source clears the borders the destination had', () => {
        const ctx = moveTopLeftToRowTwo(
            (data) => {
                data[0][0] = { v: 1, m: '1' };
            },
            { borderInfo: { '2_0': { b: SIDE } } },
        );
        expect(ctx.sheets[0].config!.borderInfo).toEqual({});
    });
});

describe('onCellsMoveEnd carries links', () => {
    test('a linked source moves its link to the destination', () => {
        const link = { linkType: 'webpage', linkAddress: 'https://eigen.is' };
        const ctx = moveTopLeftToRowTwo(
            (data) => {
                data[0][0] = { v: 'site', m: 'site' };
            },
            {},
            { '0_0': link },
        );
        expect(ctx.sheets[0].hyperlink).toEqual({ '2_0': link });
    });
});

describe('a formula a move carries', () => {
    test('a ref to a cell that moved with it follows, and the value stays right', () => {
        const ctx = moveTopLeftToRowTwo(
            (data) => {
                data[0][0] = { v: 5, m: '5', ct: { fa: 'General', t: 'n' } };
                data[0][1] = { v: 10, m: '10', f: '=A1*2', ct: { fa: 'General', t: 'n' } };
            },
            {},
            undefined,
            [0, 1],
        );
        expect(ctx.sheets[0].data?.[2][1]?.f).toBe('=A3*2');
        expect(ctx.sheets[0].data?.[2][1]?.v).toBe(10);
    });
});
