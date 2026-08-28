// A handler that rejects its own operation, or that takes a branch writing nothing, must
// leave no trace. Every syncable patch costs twice: setContextWithProduce pushes an undo
// entry for it, so the user's next ⌘Z silently consumes a no-op instead of undoing their
// previous edit, and emitOp ships it to peers.
//
// Deleting the ctx.config mirror made this class reachable. Seeding `config.merge ??= {}`
// used to land on the mirror draft, whose `['config', ...]` patches filterPatch dropped, so
// seeding above a guard clause — or for a branch not taken — was invisible. Now every config
// write lands under `sheets[i]`, which filterPatch keeps.
//
// This is table-driven on purpose: the rule is "a rejected path writes nothing", and a new
// writer has to be added here to be trusted. A comment saying "seed after the guards" is a
// convention; this is a gate.

import { describe, expect, test } from 'bun:test';
import { setCellFormat } from '../../state/api/cell';
import { setColumnWidth, setRowHeight, showRowOrColumn } from '../../state/api/rowcol';
import { initSheetData } from '../../state/api/sheet';
import type { Context } from '../../state/context';
import { clearFilter } from '../../state/modules/filter';
import { showSelected } from '../../state/modules/rowcol';
import { pasteHandlerOfPaintModel } from '../../state/modules/selection';
import { handleClearFormat, handleMerge, updateFormatCell } from '../../state/modules/toolbar';
import { syncablePaths } from './factories/collab';
import { contextFactory } from './factories/context';
import { mouseUpAt, withGridGeometry } from './factories/grid-dom';

// A sheet that has never had a config written — the case where seeding is itself a patch.
function bareSheet(): Context {
    const ctx = withGridGeometry(contextFactory() as Context);
    ctx.sheets[0].config = undefined;
    return ctx;
}

// A sheet as it actually arrives in the editor: initSheetData materializes every config
// collection, so no writer ever has to create one and no `??=` can emit a patch. That is the
// mechanism that closes this class — the ordering of seeds against guards is a second line
// of defence, checked above on a deliberately un-normalized sheet.
function freshSheet(): Context {
    const ctx = withGridGeometry(contextFactory() as Context);
    ctx.sheets[0].config = undefined;
    initSheetData(ctx, 0, ctx.sheets[0]);
    return ctx;
}

// Operations that legitimately write nothing. On a normalized sheet none of them may touch
// config — before the collections were materialized, each one created a map and shipped it.
const NO_OP_ON_A_FRESH_SHEET: [name: string, recipe: (ctx: Context) => void][] = [
    [
        'a toolbar format change that triggers no auto-height',
        (ctx) => updateFormatCell(ctx, ctx.sheets[0].data!, 'bg', '#fff', 0, 0, 0, 0),
    ],
    ['setRowHeight with an empty map', (ctx) => setRowHeight(ctx, {})],
    ['setColumnWidth with an empty map', (ctx) => setColumnWidth(ctx, {})],
    ['clearing formatting on already-plain cells', (ctx) => handleClearFormat(ctx)],
    ['a merge of a single cell', (ctx) => handleMerge(ctx, 'merge-all')],
    ['clearing a filter when nothing is hidden', (ctx) => clearFilter(ctx)],
];

const REJECTED: [name: string, recipe: (ctx: Context) => void][] = [
    [
        'a column click released where it was pressed',
        (ctx) => {
            ctx.colsResizing = true;
            ctx.colsResizeStart = [200, 2];
            mouseUpAt(200, 150)(ctx);
        },
    ],
    [
        'a row click released where it was pressed',
        (ctx) => {
            ctx.rowsResizing = true;
            ctx.rowsResizeStart = [100, 2];
            mouseUpAt(296, 100)(ctx);
        },
    ],
    ['the format painter with no copy state', (ctx) => pasteHandlerOfPaintModel(ctx, undefined)],
    ['unhiding a row via the api when nothing is hidden', (ctx) => showRowOrColumn(ctx, ['1'], 'row')],
    ['unhiding a column via the api when nothing is hidden', (ctx) => showRowOrColumn(ctx, ['1'], 'column')],
    ['unhiding a selected row when nothing is hidden', (ctx) => showSelected(ctx, 'row')],
    ['unhiding a selected column when nothing is hidden', (ctx) => showSelected(ctx, 'column')],
];

describe('a rejected operation writes nothing', () => {
    for (const [name, recipe] of REJECTED) {
        test(`${name} emits no patch, even on a sheet with no config`, () => {
            expect(syncablePaths(bareSheet(), recipe)).toEqual([]);
        });
    }

    test('a real column resize still emits its patch', () => {
        const paths = syncablePaths(bareSheet(), (ctx: Context) => {
            ctx.colsResizing = true;
            ctx.colsResizeStart = [200, 2];
            mouseUpAt(253, 150)(ctx);
        });
        expect(paths.length).toBeGreaterThan(0);
    });
});

describe('an operation that writes nothing leaves config alone', () => {
    for (const [name, recipe] of NO_OP_ON_A_FRESH_SHEET) {
        test(`${name} emits no config patch`, () => {
            const paths = syncablePaths(freshSheet(), recipe);
            expect(paths.filter((path) => path[2] === 'config')).toEqual([]);
        });
    }
});

describe('a write that touches no config leaves config alone', () => {
    test('setting a background colour creates no config object', () => {
        const paths = syncablePaths(bareSheet(), (ctx: Context) => setCellFormat(ctx, 0, 0, 'bg', '#fff'));
        expect(paths.filter((path) => path[2] === 'config')).toEqual([]);
        expect(paths.length).toBeGreaterThan(0);
    });
});
