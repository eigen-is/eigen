// The painter draws a tick box or a list chevron on every cell a rule covers, a rule stored once over a whole column
// included, deep below the rows that hold data. It looks the rules up once per paint, cut down to the window.

import { describe, expect, test } from 'bun:test';
import { REFERENCE_ROW_COUNT } from '@workspace/lib/sheets';
import { Canvas } from '../../../state/canvas';
import type { Context } from '../../../state/context';
import { CHECKBOX_SIZE, checkboxChange } from '../../../state/modules/data-validation';
import type { Cell, DataValidationRule } from '../../../state/types';
import { contextFactory } from '../factories/context';

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
g.getComputedStyle ??= () => ({ getPropertyValue: () => '' });
g.Path2D ??= class {
    public moveTo() {}
    public lineTo() {}
    public rect() {}
};

const ROWS = 6000;
const ROW_HEIGHT = 20;
const TICK_BOX: DataValidationRule = { type: 'checkbox', type2: '', value1: 'TRUE', value2: 'FALSE' };

// A 2D context that records every call, and a canvas element that hands it out.
function recordingCanvas() {
    const calls: { name: string; args: unknown[] }[] = [];
    const state: Record<string | symbol, unknown> = {};
    const context = new Proxy(state, {
        get: (target, key) =>
            key in target
                ? target[key]
                : (...args: unknown[]) => {
                      calls.push({ name: String(key), args });
                      return key === 'measureText'
                          ? { width: 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }
                          : undefined;
                  },
        set: (target, key, value) => {
            target[key] = value;
            return true;
        },
    });
    const element = { getContext: () => context } as unknown as HTMLCanvasElement;
    return { element, calls };
}

function sheetContext(): Context {
    const data: (Cell | null)[][] = Array.from({ length: ROWS }, () => [null, null, null]);
    data[5000][1] = { v: true, m: 'TRUE', ct: { fa: 'General', t: 'b' } };
    const ctx = contextFactory({
        visibledatarow: Array.from({ length: ROWS }, (_, r) => (r + 1) * ROW_HEIGHT),
        visibledatacolumn: [74, 148, 222],
        devicePixelRatio: 1,
    }) as Context;
    ctx.sheets[0].data = data;
    ctx.sheets[0].dataValidations = {
        ticks: { ranges: [{ row: [0, REFERENCE_ROW_COUNT - 1], column: [1, 1] }], rule: TICK_BOX },
    };
    return ctx;
}

// Rows 4995 to 5004 of the sheet, ten rows of twenty pixels.
function paintAround5000(ctx: Context) {
    const canvas = recordingCanvas();
    new Canvas(canvas.element, ctx).drawMain({
        scrollWidth: 0,
        scrollHeight: 4995 * ROW_HEIGHT,
        drawWidth: 222,
        drawHeight: 10 * ROW_HEIGHT - 1,
        offsetLeft: 0,
        offsetTop: 0,
    });
    return canvas.calls;
}

const tickBoxes = (calls: { name: string; args: unknown[] }[]) =>
    calls.filter(({ name, args }) => name === 'strokeRect' && args[2] === CHECKBOX_SIZE);

describe('the painter and a whole-column tick box', () => {
    test('draws a tick box on every row of the window at row 5000, and ticks the TRUE one', () => {
        const calls = paintAround5000(sheetContext());
        // The window's ten rows, and the one the painter starts below its bottom edge.
        expect(tickBoxes(calls)).toHaveLength(11);
        const ticks = calls.filter(
            ({ name, args }, i) =>
                name === 'strokeRect' && args[2] === CHECKBOX_SIZE && calls[i + 1]?.name === 'beginPath',
        );
        expect(ticks).toHaveLength(1);
    });

    test('draws none where the rule does not reach', () => {
        const ctx = sheetContext();
        ctx.sheets[0].dataValidations = {
            ticks: { ranges: [{ row: [0, 999], column: [1, 1] }], rule: TICK_BOX },
        };
        expect(tickBoxes(paintAround5000(ctx))).toHaveLength(0);
    });

    test('a click on the box at row 5000 toggles it', () => {
        const ctx = sheetContext();
        expect(checkboxChange(ctx, 5000, 1)).toBe(true);
        expect(ctx.sheets[0].data?.[5000][1]?.v).toBe(false);
        expect(checkboxChange(ctx, 5001, 1)).toBe(true);
        expect(ctx.sheets[0].data?.[5001][1]?.v).toBe(true);
        expect(checkboxChange(ctx, 5001, 0)).toBe(false);
    });
});
