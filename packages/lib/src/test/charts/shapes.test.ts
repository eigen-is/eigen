import { describe, expect, test } from 'bun:test';
import { chartColor, chartFontSize } from '../../charts';
import { solidFill } from '../../vector/fill';
import type { SpecPatch } from './layout-fixtures';
import { layout, lines, marked, ofPart, rects, sampleData, slices } from './layout-fixtures';

describe('outlines follow the fill style', () => {
    const legend: SpecPatch = { legend: { position: 'right' } };

    test('a solid fill draws bars, slices and legend swatches with no outline, the bars filling their slots', () => {
        const column = layout('column', legend, { paint: { strokeWidth: 4 } });
        const pie = layout('pie', legend);
        for (const shape of [
            ...rects(column, 'bar'),
            ...rects(column, 'legend'),
            ...slices(pie),
            ...rects(pie, 'legend'),
        ])
            expect([shape.id, shape.strokeColor]).toEqual([shape.id, 'transparent']);
        for (const bar of rects(column, 'bar')) expect(bar.strokeWidth).toBe(0);
    });

    test.each(['hachure', 'cross-hatch', 'zigzag'] as const)('%s outlines each in its own color', (fillStyle) => {
        const colors = [chartColor(0), chartColor(1), chartColor(2)];
        const column = layout('column', legend, { paint: { fillStyle, strokeWidth: 4 } });
        const bars = rects(column, 'bar');
        expect(new Set(bars.map((bar) => bar.strokeColor))).toEqual(new Set(colors));
        for (const bar of bars) {
            expect(bar.fill).toBe(solidFill(bar.strokeColor, fillStyle));
            expect(bar.strokeWidth).toBeGreaterThan(0);
        }
        expect(rects(column, 'legend').map((swatch) => swatch.strokeColor)).toEqual(colors);
        const pie = layout('pie', legend, { paint: { fillStyle } });
        for (const slice of slices(pie)) expect(slice.fill).toBe(solidFill(slice.strokeColor, fillStyle));
        expect(rects(pie, 'legend').map((swatch) => swatch.fill)).toEqual(slices(pie).map((slice) => slice.fill));
    });

    test('the axes and gridlines draw in the paint stroke whatever the fill style', () => {
        for (const fillStyle of ['solid', 'cross-hatch'] as const) {
            const out = layout('column', {}, { paint: { fillStyle, strokeColor: '#336699', strokeWidth: 4 } });
            for (const rule of [...lines(out, 'gridline'), ...lines(out, 'baseline')])
                expect([rule.strokeColor, rule.strokeWidth]).toEqual(['#336699', 4]);
        }
    });
});

describe('a shape starts its text in the chart font', () => {
    test('bars, markers and slices hold no text, in the chart font and size and its label color', () => {
        const font = { chart: { fontFamily: 'Inter' } };
        const text = { html: '', fontFamily: 'Inter', fontSize: chartFontSize(640, 400), color: '#336699' };
        const paint = { paint: { color: '#336699' } };
        const column = layout('column', font, paint);
        const line = layout('line', { ...font, series: marked(sampleData('line')) }, paint);
        const pie = layout('pie', font, paint);
        const shapes = [...rects(column, 'bar'), ...ofPart(line, 'marker'), ...slices(pie)];
        expect(new Set(shapes.map((shape) => shape.type))).toEqual(new Set(['rectangle', 'ellipse', 'pie']));
        for (const shape of shapes) expect([shape.id, shape]).toEqual([shape.id, expect.objectContaining(text)]);
    });
});
