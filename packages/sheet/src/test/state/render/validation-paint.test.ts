// The painter draws a tick box or a list chevron on every cell a rule covers, a rule stored once over a whole column
// included, deep below the rows that hold data. It looks the rules up once per paint, cut down to the window.

import { describe, expect, test } from 'bun:test';
import { INDICATOR_RED } from '@workspace/lib/constants/comment-indicator';
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
type Call = { name: string; args: unknown[]; fillStyle: unknown };

const TICK_BOX: DataValidationRule = { type: 'checkbox', type2: '', value1: 'TRUE', value2: 'FALSE' };

// A 2D context that records every call with the fill colour it was made in, and a canvas element that hands it out.
function recordingCanvas() {
    const calls: Call[] = [];
    const state: Record<string | symbol, unknown> = {};
    const context = new Proxy(state, {
        get: (target, key) =>
            key in target
                ? target[key]
                : (...args: unknown[]) => {
                      calls.push({ name: String(key), args, fillStyle: target.fillStyle });
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
        ticks: { ranges: [{ row: [0, REFERENCE_ROW_COUNT - 1], column: [1, 1] }], order: 'a0', rule: TICK_BOX },
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

const tickBoxes = (calls: Call[]) =>
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
            ticks: { ranges: [{ row: [0, 999], column: [1, 1] }], order: 'a0', rule: TICK_BOX },
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

// Column B spans x 74..148 and its text box 74..146, so a centred 10px box starts at 105, a left one at 76 and a right
// one at 134, each stroked half a pixel in. The rows are 20px, and the box sits in the middle of its own.
describe('the painter and a tick box with its own values', () => {
    const YES_NO: DataValidationRule = { type: 'checkbox', type2: '', value1: 'Yes', value2: 'No' };

    function paint(cells: (Cell | null)[]) {
        const ctx = contextFactory({
            visibledatarow: cells.map((_, r) => (r + 1) * ROW_HEIGHT),
            visibledatacolumn: [74, 148, 222],
            devicePixelRatio: 1,
        }) as Context;
        ctx.sheets[0].data = cells.map((cell) => [null, cell, null]);
        ctx.sheets[0].dataValidations = {
            ticks: { ranges: [{ row: [0, cells.length - 1], column: [1, 1] }], order: 'a0', rule: YES_NO },
        };
        const canvas = recordingCanvas();
        new Canvas(canvas.element, ctx).drawMain({
            scrollWidth: 0,
            scrollHeight: 0,
            drawWidth: 222,
            drawHeight: cells.length * ROW_HEIGHT - 1,
            offsetLeft: 0,
            offsetTop: 0,
        });
        return canvas.calls;
    }
    const boxesAt = (calls: Call[]) => tickBoxes(calls).map(({ args }) => [args[0], args[1]]);
    const texts = (calls: Call[]) => calls.filter(({ name }) => name === 'fillText').map(({ args }) => args[0]);
    const redMarks = (calls: Call[]) =>
        calls.filter((call) => call.name === 'fill' && call.fillStyle === INDICATOR_RED);

    test('draws the box alone and centred, ticked, unticked and empty alike', () => {
        const calls = paint([{ v: 'Yes', m: 'Yes' }, { v: 'No', m: 'No' }, null]);
        expect(boxesAt(calls)).toEqual([
            [105.5, 5],
            [105.5, 25],
            [105.5, 45],
        ]);
        expect(texts(calls)).toEqual([]);
        expect(redMarks(calls)).toHaveLength(0);
    });

    test("the cell's own alignment moves the box to that side", () => {
        const calls = paint([
            { v: 'Yes', m: 'Yes', ht: 1 },
            { v: 'No', m: 'No', ht: 2 },
        ]);
        expect(boxesAt(calls).map(([x]) => x)).toEqual([76.5, 134.5]);
        expect(texts(calls)).toEqual([]);
    });

    test('a value the rule does not name paints as text with the invalid mark, and no box', () => {
        const calls = paint([
            { v: 'Maybe', m: 'Maybe' },
            { v: 'Yes', m: 'Yes' },
        ]);
        expect(boxesAt(calls)).toEqual([[105.5, 25]]);
        expect(texts(calls)).toEqual(['Maybe']);
        expect(redMarks(calls)).toHaveLength(1);
    });
});
