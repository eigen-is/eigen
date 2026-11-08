// The corner indicator triangles a cell can carry — comment (top-right),
// invalid-value and forced-string (top-left). They used to be three inline
// magic sizes (11 / 5 / 6) with the comment block copied verbatim between
// nullCellRender and cellRender; one painter and one constant now settle all
// three, so a warning triangle reads as the same mark as a comment triangle.

import { describe, expect, test } from 'bun:test';
import { CELL_INDICATOR_SIZE, INDICATOR_RED } from '@workspace/lib/constants/comment-indicator';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { Canvas } from '../../../state/canvas';
import type { Context } from '../../../state/context';
import { cellIndicatorRect } from '../../../state/modules/cell-glyph';
import { drawCellIndicator } from '../../../state/render/cells';
import { workbookContextFactory } from '../factories/context';

installHappyDom();

function recordingCanvas() {
    const points: [number, number][] = [];
    let fillStyle = '';
    const renderCtx = {
        beginPath() {},
        closePath() {},
        fill() {},
        moveTo(x: number, y: number) {
            points.push([x, y]);
        },
        lineTo(x: number, y: number) {
            points.push([x, y]);
        },
        get fillStyle() {
            return fillStyle;
        },
        set fillStyle(value: string) {
            fillStyle = value;
        },
    };
    return { renderCtx: renderCtx as unknown as CanvasRenderingContext2D, points, colour: () => fillStyle };
}

Object.assign(globalThis, {
    Path2D: class {
        public moveTo() {}
        public lineTo() {}
        public rect() {}
    },
});

// Every colour the painter fills with, through a 2D context that does nothing else.
function paintedFills(ctx: Context) {
    const fills: unknown[] = [];
    const state: Record<string | symbol, unknown> = {};
    const context = new Proxy(state, {
        get: (target, key) =>
            key in target
                ? target[key]
                : () => {
                      if (key === 'fill') fills.push(target.fillStyle);
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
    return fills;
}

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

describe('drawCellIndicator', () => {
    test('a left-corner mark runs right and down from its anchor', () => {
        const canvas = recordingCanvas();
        drawCellIndicator(canvas.renderCtx, 'left', { x: 10, y: 40, size: CELL_INDICATOR_SIZE }, '#487f1e');
        expect(canvas.points).toEqual([
            [10, 40],
            [10 + CELL_INDICATOR_SIZE, 40],
            [10, 40 + CELL_INDICATOR_SIZE],
        ]);
        expect(canvas.colour()).toBe('#487f1e');
    });

    test('a right-corner mark mirrors it, same legs', () => {
        const canvas = recordingCanvas();
        drawCellIndicator(canvas.renderCtx, 'right', cellIndicatorRect('right', 0, 40, 101), '#FC6666');
        expect(canvas.points).toEqual([
            [100, 40],
            [100 - CELL_INDICATOR_SIZE, 40],
            [100, 40 + CELL_INDICATOR_SIZE],
        ]);
    });

    test('both corners draw legs of exactly one size', () => {
        for (const corner of ['left', 'right'] as const) {
            const canvas = recordingCanvas();
            drawCellIndicator(canvas.renderCtx, corner, { x: 50, y: 0, size: CELL_INDICATOR_SIZE }, '#000000');
            const [origin, along, down] = canvas.points;
            expect(Math.abs(along[0] - origin[0])).toBe(CELL_INDICATOR_SIZE);
            expect(down[1] - origin[1]).toBe(CELL_INDICATOR_SIZE);
        }
    });
});
