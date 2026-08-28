import { describe, expect, test } from 'bun:test';
import { opToPatchOnSheets } from '@workspace/lib/sheets/yjs-ops';
import type { Context } from '../../../state/context';
import type { Op, Sheet } from '../../../state/types';
import { opToPatch, patchToOp } from '../../../state/utils/patch';
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

    test('images op on currentSheetId: wrapper adds insertedImgs side patch', () => {
        const ctx = getContext();
        const ops: Op[] = [{ op: 'add', id: 'sheet-1', path: ['images', 0], value: { id: 'img-1' } }];
        const [pure] = opToPatchOnSheets(ctx.sheets, ops);
        const [wrapped] = opToPatch(ctx, ops);
        const expected = [
            ...pure.map((p) => ({ ...p, path: ['sheets', ...p.path] })),
            { op: 'add' as const, value: { id: 'img-1' }, path: ['insertedImgs'] },
        ];
        expect(wrapped).toEqual(expected);
    });
});

// Some `Sheet` fields are per-client UI state, stored on the sheet only so a tab switch can
// restore them. `selections` was always dropped; `formulaRangeSelections` — the formula-bar
// range highlight — was not, so switching tabs mid-formula-edit shipped one client's
// highlight rectangles to every peer and took an undo entry. Both are listed in one place now.
describe('per-client sheet state never reaches the wire', () => {
    test('a local cursor is dropped', () => {
        const paths = syncablePaths(getContext(), (ctx: Context) => {
            ctx.sheets[0].selections = [{ row: [1, 1], column: [1, 1] }];
        });
        expect(paths).toEqual([]);
    });

    test('the row-insert metadata sweep drops it too, not just filterPatch', () => {
        const ctx = getContext();
        const ops = patchToOp(ctx, [], {
            insertRowColOp: { type: 'row', index: 0, count: 1, direction: 'lefttop', id: 'sheet-1' },
        });
        expect(ops.map((op) => op.path).filter((path) => path[0] === 'selections')).toEqual([]);
    });
});
