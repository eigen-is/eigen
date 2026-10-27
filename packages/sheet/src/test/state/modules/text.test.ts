// Excel and Google wrap text only: a number too wide for its column stays on one line and clips.

import { beforeEach, describe, expect, test } from 'bun:test';
import type { Context } from '../../../state/context';
import { setCellValue } from '../../../state/modules/cell';
import { clearMeasureTextCache, defaultFont, getCellTextInfo, getFontSet } from '../../../state/modules/text';
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

    test('a number stored as a string in a numeric cell stays on one line', () => {
        const info = layout({ v: '28254.75', m: '28254.75', ct: { fa: 'General', t: 'n' }, tb: '2' });
        expect(info?.values.map((word) => word.content)).toEqual(['28254.75']);
    });

    test('a wrapped date stays on one line', () => {
        const info = layout({ v: 45000, m: '2023-03-15', ct: { fa: 'yyyy-MM-dd', t: 'd' }, tb: '2' });
        expect(info?.values.map((word) => word.content)).toEqual(['2023-03-15']);
    });
});

// Excel's General alignment: a number without its own alignment, typed or as the xlsx import stores one, draws right.
describe('state/modules/text — getCellTextInfo General alignment', () => {
    beforeEach(() => {
        clearMeasureTextCache();
    });

    function typed(text: string): Cell {
        const data: (Cell | null)[][] = [[null]];
        setCellValue(contextFactory() as Context, 0, 0, data, text);
        return data[0][0] ?? {};
    }

    // The gap left of the text in a 40 px cell: 2 px of padding drawn left, the rest drawn right.
    const leftOf = (cell: Cell) => layout(cell)?.textLeftAll;

    test('a typed number and an imported one draw right, text left', () => {
        const imported = { v: 42, m: '42', ct: { fa: 'General', t: 'n' } };
        expect(leftOf(typed('42'))).toBe(40 - 14 - 2);
        expect(leftOf(imported)).toBe(40 - 14 - 2);
        expect(leftOf(typed('ab'))).toBe(2);
        expect(leftOf({ ...imported, ht: 1 })).toBe(2);
    });
});

// The size box takes Google's half points, so a cell draws the 10.5 it shows.
test('a cell draws at its half-point size', () => {
    expect(getFontSet({ fs: 10.5 }, 10)).toStartWith('normal normal normal 10.5pt ');
});

describe('state/modules/text — font sets', () => {
    test('a cell with no font, and the canvas default, draw in Inter', () => {
        expect(getFontSet({}, 10)).toStartWith('normal normal normal 10pt "Inter",');
        expect(defaultFont(10)).toStartWith('normal normal normal 10pt "Inter",');
    });

    test("a cell's font is its first family, an index the bundled font at it", () => {
        expect(getFontSet({ ff: 2, bl: 1 }, 10)).toStartWith('normal normal bold 10pt "JetBrains Mono",');
        expect(getFontSet({ ff: "'source serif 4', sans-serif", it: 1, fs: 12 }, 10)).toStartWith(
            'italic normal normal 12pt "Source Serif 4",',
        );
    });
});

// A rich cell wraps between words, inside a run too, and the runs on one line share its baseline.
describe('state/modules/text — rich text wrap', () => {
    beforeEach(() => {
        clearMeasureTextCache();
    });

    // Glyphs as wide and as tall as the font set's point size says, so two sizes measure apart.
    function sizedCanvas(): CanvasRenderingContext2D {
        const canvas = {
            font: '10pt Inter',
            textAlign: 'start',
            textBaseline: 'alphabetic',
            measureText: (text: string) => {
                const size = Number.parseFloat(canvas.font.match(/([\d.]+)pt/)?.[1] ?? '10');
                return {
                    width: text.length * size * 0.7,
                    actualBoundingBoxAscent: size,
                    actualBoundingBoxDescent: size * 0.25,
                };
            },
        };
        return canvas as unknown as CanvasRenderingContext2D;
    }

    function lines(runs: { v: string; fs: number }[], cellWidth: number) {
        const cell: Cell = { tb: '2', ct: { fa: 'General', t: 'inlineStr', s: runs } };
        const info = getCellTextInfo(cell, sizedCanvas(), contextFactory() as Context, {
            cellWidth,
            cellHeight: 200,
            r: 0,
            c: 0,
        });
        const byLine = new Map<number, { text: string; tops: Set<number> }>();
        for (const word of info?.values ?? []) {
            const line = byLine.get(word.splitIndex ?? 0) ?? { text: '', tops: new Set<number>() };
            line.text += word.content;
            line.tops.add(word.top);
            byLine.set(word.splitIndex ?? 0, line);
        }
        return [...byLine.values()];
    }

    test('one run too wide for the cell breaks at its spaces', () => {
        expect(lines([{ v: 'aa bb cc dd', fs: 10 }], 50).map((line) => line.text.trim())).toEqual(['aa bb', 'cc dd']);
    });

    test('two sizes on one wrapped line share its baseline', () => {
        const wrapped = lines(
            [
                { v: 'aa bb ', fs: 10 },
                { v: 'CC', fs: 20 },
                { v: ' dd ee ff gg', fs: 10 },
            ],
            100,
        );
        expect(wrapped.map((line) => line.text.trim())).toEqual(['aa bb CC dd', 'ee ff gg']);
        for (const line of wrapped) expect(line.tops.size).toBe(1);
    });
});
