// The corner indicator triangles a cell can carry — comment (top-right),
// invalid-value and forced-string (top-left). They used to be three inline
// magic sizes (11 / 5 / 6) with the comment block copied verbatim between
// nullCellRender and cellRender; one painter and one constant now settle all
// three, so a warning triangle reads as the same mark as a comment triangle.

import { describe, expect, test } from 'bun:test';
import { CELL_INDICATOR_SIZE, drawCellIndicator } from '../../../state/render/cells';

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

describe('drawCellIndicator', () => {
    test('a left-corner mark runs right and down from its anchor', () => {
        const canvas = recordingCanvas();
        drawCellIndicator(canvas.renderCtx, 'left', 10, 40, '#487f1e');
        expect(canvas.points).toEqual([
            [10, 40],
            [10 + CELL_INDICATOR_SIZE, 40],
            [10, 40 + CELL_INDICATOR_SIZE],
        ]);
        expect(canvas.colour()).toBe('#487f1e');
    });

    test('a right-corner mark mirrors it, same legs', () => {
        const canvas = recordingCanvas();
        drawCellIndicator(canvas.renderCtx, 'right', 100, 40, '#FC6666');
        expect(canvas.points).toEqual([
            [100, 40],
            [100 - CELL_INDICATOR_SIZE, 40],
            [100, 40 + CELL_INDICATOR_SIZE],
        ]);
    });

    test('both corners draw legs of exactly one size', () => {
        for (const corner of ['left', 'right'] as const) {
            const canvas = recordingCanvas();
            drawCellIndicator(canvas.renderCtx, corner, 50, 0, '#000000');
            const [origin, along, down] = canvas.points;
            expect(Math.abs(along[0] - origin[0])).toBe(CELL_INDICATOR_SIZE);
            expect(down[1] - origin[1]).toBe(CELL_INDICATOR_SIZE);
        }
    });
});
