// A column letter is placed on the sheet's pixels, not the canvas's: when a scroll moves by half a pixel, it
// moves with its column, so a strip of the canvas copied after the scroll and one painted fresh agree.

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { drawColumnHeader } from '../../../state/render/headers';
import { workbookContextFactory } from '../factories/context';

const realGetComputedStyle = globalThis.getComputedStyle;
beforeEach(() => {
    // The painter reads the grid's colors off the canvas element; this test has no page to read them from.
    globalThis.getComputedStyle = (() => ({ getPropertyValue: () => '' })) as unknown as typeof getComputedStyle;
});
afterEach(() => {
    globalThis.getComputedStyle = realGetComputedStyle;
});

function letterPositions(scrollWidth: number, offsetLeft: number) {
    const letters: Record<string, number> = {};
    const renderCtx = {
        canvas: {},
        save() {},
        restore() {},
        scale() {},
        clearRect() {},
        beginPath() {},
        rect() {},
        clip() {},
        fillRect() {},
        moveTo() {},
        lineTo() {},
        stroke() {},
        closePath() {},
        measureText: (text: string) => ({
            width: text.length * 7.3,
            actualBoundingBoxAscent: 8,
            actualBoundingBoxDescent: 2,
        }),
        fillText: (text: string, x: number) => {
            letters[text] = x;
        },
    };
    const ctx = workbookContextFactory({ visibledatacolumn: [100, 200, 300, 400] });
    drawColumnHeader(ctx, renderCtx as unknown as CanvasRenderingContext2D, scrollWidth, 400, offsetLeft);
    return letters;
}

test('a column letter keeps its place on the sheet when the scroll moves by half a pixel', () => {
    const whole = letterPositions(100, 46);
    const half = letterPositions(100.5, 46);
    for (const letter of ['B', 'C', 'D']) {
        expect(half[letter] + 100.5 - 46).toBe(whole[letter] + 100 - 46);
    }
});
