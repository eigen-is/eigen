import { describe, expect, test } from 'bun:test';
import { opToPatchOnSheets } from '@workspace/lib/sheets/yjs-ops';
import type { Context } from '../../../state/context';
import { changeSheet } from '../../../state/modules/sheet';
import type { Op, Sheet } from '../../../state/types';
import { opToPatch } from '../../../state/utils/patch';
import { syncablePaths } from '../factories/collab';
import { contextFactory } from '../factories/context';

const SHEETS: Sheet[] = [
    { id: 'sheet-1', name: 'Sheet1', order: 0, celldata: [], config: {} },
    { id: 'sheet-2', name: 'Sheet2', order: 1, celldata: [], config: {} },
];

const getContext = () =>
    contextFactory({
        sheets: SHEETS,
        currentSheetId: 'sheet-1',
    }) as Context;

describe('opToPatch parity with opToPatchOnSheets', () => {
    test('cell-edit op: wrapper rebases path with sheets prefix', () => {
        const ctx = getContext();
        const ops: Op[] = [{ op: 'replace', id: 'sheet-2', path: ['celldata', 0, 'v'], value: 7 }];
        const [pure] = opToPatchOnSheets(ctx.sheets, ops);
        const [wrapped] = opToPatch(ctx, ops);
        expect(wrapped).toEqual(pure.map((p) => ({ ...p, path: ['sheets', ...p.path] })));
    });

    test('orphan op: both pure and wrapper drop it', () => {
        const ctx = getContext();
        const ops: Op[] = [{ op: 'replace', id: 'sheet-missing', path: ['celldata'], value: 1 }];
        const [pure] = opToPatchOnSheets(ctx.sheets, ops);
        const [wrapped] = opToPatch(ctx, ops);
        expect(pure).toEqual([]);
        expect(wrapped).toEqual([]);
    });

    test("no-id wholesale ['sheets'] replace: both drop it", () => {
        // The synthetic patch immer emits when the sheet reducer
        // reassigns ctx.sheets (e.g. row/col mutations). Has no id and
        // a Context-rooted path; the paired insertRowCol / deleteRowCol special
        // op already carries the semantics, so dropping here is correct.
        const ctx = getContext();
        const ops: Op[] = [{ op: 'replace', path: ['sheets'], value: SHEETS }];
        const [pure] = opToPatchOnSheets(ctx.sheets, ops);
        const [wrapped] = opToPatch(ctx, ops);
        expect(pure).toEqual([]);
        expect(wrapped).toEqual([]);
    });
});

// A tab's view lives on the Context, so a switch writes no sheet a peer would get.
test('a sheet switch puts nothing on the wire', () => {
    expect(syncablePaths(getContext(), (ctx: Context) => changeSheet(ctx, 'sheet-2'))).toEqual([]);
});
