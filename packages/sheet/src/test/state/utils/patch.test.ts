import { describe, expect, test } from 'bun:test';
import { opToPatchOnSheets } from '@workspace/lib/sheets/yjs-ops';
import type { Context } from '../../../state/context';
import { changeSheet } from '../../../state/modules/sheet';
import type { Op, Sheet } from '../../../state/types';
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

describe('opToPatchOnSheets', () => {
    test('drops an op on a sheet that is gone', () => {
        const ops: Op[] = [{ op: 'replace', id: 'sheet-missing', path: ['celldata'], value: 1 }];
        expect(opToPatchOnSheets(getContext().sheets, ops)[0]).toEqual([]);
    });

    // Immer emits it when a recipe reassigns ctx.sheets, and it names no sheet.
    test("drops a whole ['sheets'] replace with no id", () => {
        const ops: Op[] = [{ op: 'replace', path: ['sheets'], value: SHEETS }];
        expect(opToPatchOnSheets(getContext().sheets, ops)[0]).toEqual([]);
    });
});

// A tab's view lives on the Context, so a switch writes no sheet a peer would get.
test('a sheet switch puts nothing on the wire', () => {
    expect(syncablePaths(getContext(), (ctx: Context) => changeSheet(ctx, 'sheet-2'))).toEqual([]);
});
