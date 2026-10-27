// Releasing a freeze-line drag writes the frozen pane: a drag onto the grid freezes up to the
// cell left of or above the line and joins a pane frozen on the other axis, and a drag back
// to the header edge drops this axis, keeping the other one.

import { describe, expect, test } from 'bun:test';
import { produce } from 'immer';
import type { Context } from '../../../state/context';
import type { Sheet } from '../../../state/types';
import { contextFactory } from '../factories/context';
import { mouseUpAt, withGridGeometry } from '../factories/grid-dom';

const freezeContext = (frozen?: Sheet['frozen']) => {
    const ctx = withGridGeometry(contextFactory() as Context);
    ctx.visibledatacolumn = [73, 146, 219, 292];
    ctx.visibledatarow = [19, 38, 57, 76];
    ctx.sheets[0].frozen = frozen;
    return ctx;
};

// Page x 196 is grid x 150, left of the middle of column C, so the pane ends after column B.
const releaseColumn = (frozen: Sheet['frozen'], pageX = 196) =>
    produce(freezeContext(frozen), (ctx: Context) => {
        ctx.colsFreezeDragging = true;
        mouseUpAt(pageX, 0)(ctx);
    }).sheets[0].frozen;
// Page y 65 is grid y 45, above the middle of row 3, so the pane ends after row 2.
const releaseRow = (frozen: Sheet['frozen'], pageY = 65) =>
    produce(freezeContext(frozen), (ctx: Context) => {
        ctx.rowsFreezeDragging = true;
        mouseUpAt(0, pageY)(ctx);
    }).sheets[0].frozen;

describe('a column freeze drag', () => {
    test('freezes the columns left of the line', () => {
        expect(releaseColumn(undefined)).toEqual({ type: 'rangeColumn', range: { column_focus: 1, row_focus: 0 } });
    });

    test('joins frozen rows', () => {
        const frozen = { type: 'rangeRow', range: { row_focus: 3, column_focus: 0 } } as const;
        expect(releaseColumn(frozen)).toEqual({ type: 'rangeBoth', range: { row_focus: 3, column_focus: 1 } });
    });

    test('at the header edge drops the frozen columns and keeps the rows', () => {
        const both = { type: 'rangeBoth', range: { row_focus: 3, column_focus: 1 } } as const;
        expect(releaseColumn(both, 56)?.type).toBe('rangeRow');
        const columns = { type: 'rangeColumn', range: { row_focus: 0, column_focus: 1 } } as const;
        expect(releaseColumn(columns, 56)).toBeUndefined();
    });
});

describe('a row freeze drag', () => {
    test('freezes the rows above the line', () => {
        expect(releaseRow(undefined)).toEqual({ type: 'rangeRow', range: { column_focus: 0, row_focus: 1 } });
    });

    test('joins frozen columns', () => {
        const frozen = { type: 'rangeColumn', range: { row_focus: 0, column_focus: 2 } } as const;
        expect(releaseRow(frozen)).toEqual({ type: 'rangeBoth', range: { row_focus: 1, column_focus: 2 } });
    });

    test('at the header edge drops the frozen rows and keeps the columns', () => {
        const both = { type: 'rangeBoth', range: { row_focus: 1, column_focus: 2 } } as const;
        expect(releaseRow(both, 25)?.type).toBe('rangeColumn');
        const rows = { type: 'rangeRow', range: { row_focus: 1, column_focus: 0 } } as const;
        expect(releaseRow(rows, 25)).toBeUndefined();
    });
});
