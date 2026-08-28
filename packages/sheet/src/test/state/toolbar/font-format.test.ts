// Raising a range's font size auto-grows the rows it no longer fits. The grown height has
// to land on both halves of the config mirror: updateFormatCell wrote
// `sheets[i].config.rowlen` sheet-only and never re-pointed `ctx.config`, so calcRowColSize
// kept measuring the old height AND the next mirror-first writer (setColumnWidth, the
// resize drag) assigned the stale mirror back over the sheet — discarding the grown rows,
// now persisted and broadcast because that path emits a whole-object config replace.
// Driving the handlers through produceWithPatches is what exposes this: outside a recipe
// the two halves are the same object, so any write appears to reach both.

import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { enablePatches, produceWithPatches } from 'immer';
import { setColumnWidth } from '../../../state/api/rowcol';
import type { Context } from '../../../state/context';
import { clearMeasureTextCache } from '../../../state/modules/text';
import { handleTextSize } from '../../../state/modules/toolbar';
import type { SheetConfig } from '../../../state/types';
import { contextFactory } from '../factories/context';

enablePatches();

// getTextSize falls back to a DOM span when a canvas reports no bounding box, so happy-dom
// is installed at module scope the way modules/cell.test.ts does.
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
const win = new Window();
g.window = win;
g.document = win.document;

// Only `font` and `measureText` are read on the auto-height path.
function measuringCanvas(): CanvasRenderingContext2D {
    const canvas = {
        font: '11px Arial',
        textAlign: 'start',
        textBaseline: 'top',
        measureText: (text: string) => ({
            width: text.length * 7,
            actualBoundingBoxAscent: 22,
            actualBoundingBoxDescent: 8,
        }),
    };
    return canvas as unknown as CanvasRenderingContext2D;
}

function sizedContext(): Context {
    const config: SheetConfig = { columnlen: { 0: 73 } };
    const ctx = contextFactory({
        config,
        // Not editing a cell — otherwise updateFormat takes the inline-string branch.
        editingCellPosition: [],
        selections: [{ row: [0, 0], column: [0, 0], row_focus: 0, column_focus: 0 }],
    }) as Context;
    ctx.sheets[0].data = [
        [
            { v: 'a much longer cell text', m: 'a much longer cell text', ct: { fa: 'General', t: 'g' } },
            null,
            null,
            null,
        ],
        [null, null, null, null],
        [null, null, null, null],
        [null, null, null, null],
    ];
    ctx.defaultrowlen = 19;
    ctx.defaultcollen = 73;
    return ctx;
}

function cellInput(): HTMLDivElement {
    return win.document.createElement('div') as unknown as HTMLDivElement;
}

describe('state/modules/toolbar — font-size auto-height', () => {
    test('the grown row height reaches the config mirror the grid measures from', () => {
        clearMeasureTextCache();
        const [grown] = produceWithPatches(sizedContext(), (ctx: Context) => {
            handleTextSize(ctx, cellInput(), 36, measuringCanvas());
        });

        expect(grown.sheets[0].config?.rowlen?.[0]).toBeGreaterThan(19);
        expect(grown.config.rowlen?.[0]).toBe(grown.sheets[0].config?.rowlen?.[0]);
    });

    test('a following column resize does not discard it', () => {
        clearMeasureTextCache();
        const [grown] = produceWithPatches(sizedContext(), (ctx: Context) => {
            handleTextSize(ctx, cellInput(), 36, measuringCanvas());
        });
        const grownHeight = grown.sheets[0].config?.rowlen?.[0];

        const [resized] = produceWithPatches(grown, (ctx: Context) => {
            setColumnWidth(ctx, { 1: 120 });
        });

        expect(resized.sheets[0].config?.rowlen?.[0]).toBe(grownHeight);
        expect(resized.config.rowlen?.[0]).toBe(grownHeight);
    });
});
