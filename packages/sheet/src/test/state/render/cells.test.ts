// The corner triangles a cell can carry: a comment's top right, an invalid value's and a forced string's top left.
// One painter and one size draw all three, so a warning reads as the same mark as a comment. Each case paints a
// sheet through the grid's own draw and reads the triangles off the 2D context.

import { describe, expect, test } from 'bun:test';
import { CELL_INDICATOR_SIZE, INDICATOR_RED } from '@workspace/lib/constants/comment-indicator';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import type { Cell } from '../../../engine/types';
import { Canvas } from '../../../state/canvas';
import type { Context } from '../../../state/context';
import { workbookContextFactory } from '../factories/context';

installHappyDom();

Object.assign(globalThis, {
    Path2D: class {
        public moveTo() {}
        public lineTo() {}
        public rect() {}
    },
});

type Triangle = { colour: unknown; points: [number, number][] };

// Every shape the painter fills, with its colour, through a 2D context that does nothing else.
function paintedTriangles(ctx: Context): Triangle[] {
    const triangles: Triangle[] = [];
    let points: [number, number][] = [];
    const state: Record<string | symbol, unknown> = {
        beginPath: () => {
            points = [];
        },
        moveTo: (x: number, y: number) => points.push([x, y]),
        lineTo: (x: number, y: number) => points.push([x, y]),
    };
    const context = new Proxy(state, {
        get: (target, key) =>
            key in target
                ? target[key]
                : () => {
                      if (key === 'fill') triangles.push({ colour: target.fillStyle, points });
                      return key === 'measureText'
                          ? { width: 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }
                          : undefined;
                  },
        set: (target, key, value) => {
            target[key] = value;
            return true;
        },
    });
    const element = Object.assign(document.createElement('canvas'), { getContext: () => context });
    new Canvas(element, ctx).drawMain({
        scrollWidth: 0,
        scrollHeight: 0,
        drawWidth: 148,
        drawHeight: 39,
        offsetLeft: 0,
        offsetTop: 0,
    });
    return triangles;
}

const paintedFills = (ctx: Context) => paintedTriangles(ctx).map(({ colour }) => colour);

// A1 spans x 0..74 and y 0..20, and a sheet pixel paints one to the left and one up.
const grid = (a1: Cell) => {
    const ctx = workbookContextFactory({ visibledatarow: [20, 40], visibledatacolumn: [74, 148], devicePixelRatio: 1 });
    ctx.sheets[0].data = [
        [a1, null],
        [null, null],
    ];
    return ctx;
};

describe('a comment mark', () => {
    // An empty cell and a filled one reach the painter by different paths.
    const commented = (card: string, value?: string) => {
        const ctx = workbookContextFactory({
            visibledatarow: [20, 40],
            visibledatacolumn: [74, 148],
            devicePixelRatio: 1,
        });
        ctx.sheets[0].data = [
            [{ commentCardIds: [card], ...(value ? { v: value, m: value } : {}) }, null],
            [null, null],
        ];
        return ctx;
    };

    test.each([[undefined], ['x']])('takes the colour of its card, on a cell holding %s', (value) => {
        const ctx = commented('card', value);
        ctx.commentCards = { card: { id: 'card', title: '', description: '', color: '#123456' } };
        expect(paintedFills(ctx)).toEqual(['#123456']);
    });

    test('is red for a card this tab has not read', () => {
        expect(paintedFills(commented('unknown'))).toEqual([INDICATOR_RED]);
    });
});

describe('a corner mark', () => {
    test("a comment's runs left and down from the cell's top-right corner", () => {
        const [{ points }] = paintedTriangles(grid({ commentCardIds: ['card'] }));
        expect(points).toEqual([
            [73, -1],
            [73 - CELL_INDICATOR_SIZE, -1],
            [73, -1 + CELL_INDICATOR_SIZE],
        ]);
    });

    test("a forced string's mirrors it from the top-left corner, same legs", () => {
        const [{ colour, points }] = paintedTriangles(grid({ v: '12', m: '12', qp: 1 }));
        expect(points).toEqual([
            [-1, -1],
            [-1 + CELL_INDICATOR_SIZE, -1],
            [-1, -1 + CELL_INDICATOR_SIZE],
        ]);
        expect(colour).toBe('#487f1e');
    });
});
