// Which axes each frozen-pane type freezes, as the grid reads it: the bare 'row', 'column' and 'both' freeze the same
// axes as their range forms, so the panes the grid builds and the freeze handles the headers place agree for both.

import { describe, expect, test } from 'bun:test';
import type { Context } from '../../../state/context';
import { defaultContext } from '../../../state/context';
import { getFrozenHandleLeft, getFrozenHandleTop, initFreeze } from '../../../state/modules/freeze';
import type { GlobalCache, Sheet } from '../../../state/types';

type FrozenType = NonNullable<Sheet['frozen']>['type'];

const AXES: [FrozenType, { rows: boolean; columns: boolean }][] = [
    ['row', { rows: true, columns: false }],
    ['column', { rows: false, columns: true }],
    ['both', { rows: true, columns: true }],
    ['rangeRow', { rows: true, columns: false }],
    ['rangeColumn', { rows: false, columns: true }],
    ['rangeBoth', { rows: true, columns: true }],
];

function frozenContext(frozen: Sheet['frozen']): { ctx: Context; cache: GlobalCache } {
    const cache: GlobalCache = {
        undoList: [],
        redoList: [],
        scrollLeft: 0,
        scrollTop: 0,
        scrollListeners: new Set(),
        notifyScrollListeners: () => {},
    };
    const ref = <T>(): { current: T | null } => ({ current: null });
    const ctx: Context = {
        ...defaultContext({
            globalCache: cache,
            cellInput: ref(),
            fxInput: ref(),
            canvas: ref(),
            cellArea: ref(),
            workbookContainer: ref(),
        }),
        sheets: [{ id: 's1', name: 'One', order: 0, config: {}, frozen }],
        currentSheetId: 's1',
        visibledatarow: [20, 40, 60, 80],
        visibledatacolumn: [70, 140, 210, 280],
        scrollTop: 5,
        scrollLeft: 7,
    };
    return { ctx, cache };
}

describe('the axes a frozen pane freezes', () => {
    for (const [type, { rows, columns }] of AXES) {
        test(`'${type}' freezes ${rows ? 'rows' : 'no rows'} and ${columns ? 'columns' : 'no columns'}`, () => {
            const { ctx, cache } = frozenContext({ type, range: { row_focus: 1, column_focus: 2 } });
            initFreeze(ctx, cache, 's1');
            expect(cache.freezen?.s1?.horizontal !== undefined).toBe(rows);
            expect(cache.freezen?.s1?.vertical !== undefined).toBe(columns);
            // A handle sits after the last frozen row or column, and at the scroll edge on an axis that isn't frozen.
            expect(getFrozenHandleTop(ctx)).toBe(rows ? 40 + 5 : 5);
            expect(getFrozenHandleLeft(ctx)).toBe(columns ? 210 - 2 + 7 : 7);
        });
    }

    test('a sheet without a frozen pane freezes neither axis', () => {
        const { ctx, cache } = frozenContext(undefined);
        initFreeze(ctx, cache, 's1');
        expect(cache.freezen?.s1).toBeUndefined();
        expect(getFrozenHandleTop(ctx)).toBe(5);
        expect(getFrozenHandleLeft(ctx)).toBe(7);
    });
});
