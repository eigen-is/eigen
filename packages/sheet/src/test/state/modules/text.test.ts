// Wrap text breaks words, never numbers. An imported xlsx with wrap on and a column too narrow for
// "28254.75" painted "28254.7" on one line and "5" on the next; Excel and Google keep a number on
// one line and let the cell clip it. A numeric cell lays out like the unwrapped path does.

import { beforeEach, describe, expect, test } from 'bun:test';
import type { Context } from '../../../state/context';
import { clearMeasureTextCache, getCellTextInfo } from '../../../state/modules/text';
import type { Cell } from '../../../state/types';
import { contextFactory } from '../factories/context';

function measuringCanvas(): CanvasRenderingContext2D {
    const canvas = {
        font: '11px Arial',
        textAlign: 'start',
        textBaseline: 'alphabetic',
        measureText: (text: string) => ({
            width: text.length * 7,
            actualBoundingBoxAscent: 8,
            actualBoundingBoxDescent: 3,
        }),
    };
    return canvas as unknown as CanvasRenderingContext2D;
}

function layout(cell: Cell) {
    const ctx = contextFactory() as Context;
    return getCellTextInfo(cell, measuringCanvas(), ctx, {
        cellWidth: 40,
        cellHeight: 60,
        r: 0,
        c: 0,
    });
}

describe('state/modules/text — getCellTextInfo wrap', () => {
    beforeEach(() => {
        clearMeasureTextCache();
    });

    test('a wrapped number too wide for its column stays on one line', () => {
        const info = layout({ v: 28254.75, m: '28254.75', ct: { fa: 'General', t: 'n' }, tb: '2' });
        expect(info?.values.map((word) => word.content)).toEqual(['28254.75']);
    });

    test('wrapped text in the same column still breaks across lines', () => {
        const info = layout({ v: 'abc defgh ij', m: 'abc defgh ij', ct: { fa: 'General', t: 'g' }, tb: '2' });
        expect(info?.values.length).toBeGreaterThan(1);
    });

    test('a formula typed into a text cell produces a number that stays on one line', () => {
        // ct.t keeps the text cell's 'g'; the value is what decides.
        const info = layout({ v: 28254.75, m: '28254.75', f: '=A2*3', ct: { fa: 'General', t: 'g' }, tb: '2' });
        expect(info?.values.map((word) => word.content)).toEqual(['28254.75']);
    });

    test('a wrapped date stays on one line', () => {
        const info = layout({ v: 45000, m: '2023-03-15', ct: { fa: 'yyyy-MM-dd', t: 'd' }, tb: '2' });
        expect(info?.values.map((word) => word.content)).toEqual(['2023-03-15']);
    });
});
